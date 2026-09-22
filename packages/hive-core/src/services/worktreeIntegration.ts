import * as fs from 'fs/promises';
import * as path from 'path';
import type { SimpleGit } from 'simple-git';
import { normalizeCommitMessage } from '../utils/mergeMessage.js';
import {
  buildCleanupOutcome,
  buildNotRequestedCleanupOutcome,
  buildNotRequestedMergeCleanupBlock,
  classifyWorktreeOutcome,
  toMergeCleanupBlock,
} from './worktreeOutcome.js';
import type {
  WorktreeCleanupOutcome,
  WorktreeMutationState,
  WorktreeReasonCode,
  WorktreeRepositoryMergeResult,
} from './worktreeOutcome.js';
import {
  readWorktreeTargetIdentity,
  sameWorktreeTarget,
} from './worktreeTarget.js';
import type { WorktreeTargetIdentity } from './worktreeTarget.js';

type IntegrationStrategy = 'merge' | 'squash' | 'rebase';
type CleanupMode = WorktreeCleanupOutcome['requested'];
export type TargetMergeCandidates = Readonly<{
  targetCommit: string;
  sourceCommit: string;
  strategy: IntegrationStrategy;
  candidateFiles: readonly string[];
  collisionCandidates: readonly string[];
}>;

type TargetMergeEligibility =
  | TargetMergeCandidates
  | { reasonCode: 'TARGET_DIRTY' | 'TARGET_RECONCILIATION_REQUIRED' | 'GIT_OPERATION_IN_PROGRESS'; error: string };

const gitOperationStates = [
  { name: 'MERGE_HEAD', label: 'merge' },
  { name: 'REBASE_HEAD', label: 'rebase' },
  { name: 'CHERRY_PICK_HEAD', label: 'cherry-pick' },
  { name: 'rebase-merge', label: 'rebase' },
  { name: 'rebase-apply', label: 'rebase' },
] as const;

export interface WorktreeIntegrationResult extends WorktreeRepositoryMergeResult {}

export function integrationFailure(
  reasonCode: WorktreeReasonCode,
  error: string,
  options: {
    mutation?: WorktreeMutationState;
    conflicts?: string[];
    conflictState?: 'none' | 'aborted' | 'preserved';
    expectedTarget?: WorktreeTargetIdentity;
    observedTarget?: WorktreeTargetIdentity | null;
  } = {},
): WorktreeIntegrationResult {
  const classification = classifyWorktreeOutcome(reasonCode, options.mutation);
  return {
    success: false,
    merged: false,
    filesChanged: [],
    conflicts: options.conflicts ?? [],
    conflictState: options.conflictState ?? 'none',
    cleanup: buildNotRequestedMergeCleanupBlock(),
    error,
    phase: classification.phase,
    reasonCode,
    mutation: classification.mutation,
    retryable: classification.retryable,
    action: classification.action,
    ...(options.expectedTarget !== undefined ? { expectedTarget: options.expectedTarget } : {}),
    ...(options.observedTarget !== undefined ? { observedTarget: options.observedTarget } : {}),
  };
}

export function mergeSuccessClassification(
  requested: CleanupMode,
  cleanup: WorktreeCleanupOutcome,
  mutation: WorktreeMutationState,
): Pick<WorktreeIntegrationResult, 'phase' | 'reasonCode' | 'mutation' | 'retryable' | 'action'> {
  if (requested !== 'none' && cleanup.outcome !== 'complete') {
    const classification = classifyWorktreeOutcome('CLEANUP_FAILED', mutation);
    return { ...classification, reasonCode: 'CLEANUP_FAILED' };
  }
  return { phase: 'integration', mutation, retryable: false, action: 'none' };
}

async function resolveGitPath(git: SimpleGit, repoRoot: string, name: string): Promise<string> {
  try {
    const output = (await git.raw(['rev-parse', '--git-path', name])).trim();
    if (!output) return path.join(repoRoot, '.git', name);
    return path.isAbsolute(output) ? output : path.join(repoRoot, output);
  } catch {
    return path.join(repoRoot, '.git', name);
  }
}

async function activeGitOperationStates(git: SimpleGit, repoRoot: string): Promise<string[]> {
  const activeStates: string[] = [];
  for (const { name } of gitOperationStates) {
    const statePath = await resolveGitPath(git, repoRoot, name);
    if (await fs.access(statePath).then(() => true).catch(() => false)) activeStates.push(name);
  }
  return activeStates;
}

export async function validateSourceCommitMessages(
  git: SimpleGit,
  currentBranch: string,
  branchName: string,
): Promise<string | null> {
  const output = (await git.raw(['rev-list', '--reverse', `${currentBranch}..${branchName}`])).trim();
  const hashes = output ? output.split('\n').filter(Boolean) : [];
  for (const hash of hashes) {
    const rawMessage = await git.raw(['show', '-s', '--format=%B', hash]);
    try {
      normalizeCommitMessage(rawMessage);
    } catch (error: unknown) {
      const message = (error as { message?: string }).message ?? 'Invalid commit message';
      return `Source commit ${hash.slice(0, 7)} has an invalid commit message. ${message}`;
    }
  }
  return null;
}

export async function readValidatedCommitMessage(git: SimpleGit, hash: string): Promise<string> {
  return normalizeCommitMessage(await git.raw(['show', '-s', '--format=%B', hash]));
}

async function activeConflictFiles(git: SimpleGit): Promise<string[]> {
  const output = (await git.raw(['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim();
  return output ? [...new Set(output.split('\n').filter(Boolean))] : [];
}

async function observedDeltaFiles(git: SimpleGit, startingHead: string, finalHead: string): Promise<string[]> {
  const output = await git.diff([startingHead, finalHead, '--name-only']);
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function parseChangedPaths(output: string): string[] {
  const fields = output.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    if (!status) continue;
    const firstPath = fields[index++];
    if (firstPath) paths.push(firstPath);
    if (status.startsWith('R') || status.startsWith('C')) {
      const secondPath = fields[index++];
      if (secondPath) paths.push(secondPath);
    }
  }
  return [...new Set(paths)];
}

async function changedPaths(git: SimpleGit, from: string, to: string): Promise<string[]> {
  return parseChangedPaths(await git.raw(['diff', '--name-status', '-z', '--find-renames', from, to, '--']));
}

async function commitChangedPaths(git: SimpleGit, commit: string): Promise<string[]> {
  return parseChangedPaths(await git.raw([
    'diff-tree', '--root', '--no-commit-id', '--name-status', '-z', '--find-renames', '-r',
    '--diff-merges=first-parent', commit, '--',
  ]));
}

async function computeTargetMergeCandidates(
  git: SimpleGit,
  targetCommit: string,
  sourceCommit: string,
  strategy: IntegrationStrategy,
): Promise<TargetMergeCandidates> {
  const candidateFiles = Object.freeze(await changedPaths(git, targetCommit, sourceCommit));
  if (candidateFiles.length === 0 || strategy !== 'rebase') {
    return Object.freeze({ targetCommit, sourceCommit, strategy, candidateFiles, collisionCandidates: candidateFiles });
  }

  const commitsOutput = (await git.raw(['rev-list', '--reverse', `${targetCommit}..${sourceCommit}`])).trim();
  const commits = commitsOutput ? commitsOutput.split('\n').filter(Boolean) : [];
  const commitPaths = await Promise.all(commits.map(commit => commitChangedPaths(git, commit)));
  const collisionCandidates = Object.freeze([...new Set([...candidateFiles, ...commitPaths.flat()])]);
  return Object.freeze({ targetCommit, sourceCommit, strategy, candidateFiles, collisionCandidates });
}

async function isAncestor(git: SimpleGit, ancestor: string, descendant: string): Promise<boolean> {
  const mergeBases = await git.raw(['merge-base', '--all', ancestor, descendant]).catch(() => '');
  return mergeBases.split('\n').some(commit => commit.trim() === ancestor);
}

async function isPathBoundedTopology(
  git: SimpleGit,
  targetCommit: string,
  sourceCommit: string,
  strategy: IntegrationStrategy,
): Promise<boolean> {
  if (!(await isAncestor(git, targetCommit, sourceCommit))) return false;
  if (strategy !== 'rebase') return true;
  const mergeCommit = await git.raw(['rev-list', '--merges', '--max-count=1', `${targetCommit}..${sourceCommit}`]);
  return mergeCommit.trim().length === 0;
}

function localDataExclusions(targetRoot: string, excludedLocalPaths: string[]): {
  relatives: string[];
  roots: string[];
} {
  const excludedRelatives: string[] = [];
  for (const excludedPath of excludedLocalPaths) {
    const relative = path.relative(targetRoot, excludedPath).split(path.sep).join('/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) continue;
    excludedRelatives.push(relative);
  }
  const excludedRoots = [...new Set(excludedRelatives.map(relative => relative.split('/')[0]!))];
  return { relatives: excludedRelatives, roots: excludedRoots };
}

async function hasLocalUntrackedOrIgnoredData(
  git: SimpleGit,
  targetRoot: string,
  excludedLocalPaths: string[],
): Promise<string | null> {
  const exclusions = localDataExclusions(targetRoot, excludedLocalPaths);
  for (const flags of [[], ['--ignored']] as const) {
    const collapsed = await git.raw([
      'ls-files', '--others', ...flags, '--exclude-standard', '--directory', '--no-empty-directory', '-z', '--',
    ]);
    const firstPath = collapsed.split('\0').find(pathname =>
      pathname && !exclusions.roots.some(root => pathname === root || pathname === `${root}/`)
    );
    if (firstPath) return firstPath;

    for (const root of exclusions.roots) {
      const output = await git.raw([
        '--literal-pathspecs', 'ls-files', '--others', ...flags, '--exclude-standard', '-z', '--', root,
      ]);
      const firstPath = output.split('\0').find(pathname => {
        if (!pathname) return false;
        const normalized = collisionPath(pathname);
        return !exclusions.relatives.some(relative => normalized === relative || normalized.startsWith(`${relative}/`));
      });
      if (firstPath) return firstPath;
    }
  }
  return null;
}

function collisionAncestorPathspecs(candidateFiles: readonly string[]): string[] {
  const pathspecs = new Set<string>();
  for (const candidate of candidateFiles) {
    let current = path.posix.dirname(candidate);
    while (current && current !== '.') {
      pathspecs.add(current);
      current = path.posix.dirname(current);
    }
  }
  return [...pathspecs];
}

function collides(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function collisionPath(pathname: string): string {
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export async function inspectTargetMergeEligibility(options: {
  targetGit: SimpleGit;
  targetRoot: string;
  targetCommit: string;
  topologyTargetCommit?: string;
  sourceCommit: string;
  strategy: IntegrationStrategy;
  excludedLocalPaths?: string[];
  precomputedCandidates?: TargetMergeCandidates;
}): Promise<TargetMergeEligibility> {
  const {
    targetGit,
    targetRoot,
    targetCommit,
    topologyTargetCommit = targetCommit,
    sourceCommit,
    strategy,
    excludedLocalPaths = [],
    precomputedCandidates,
  } = options;
  for (const { name, label } of gitOperationStates) {
    const statePath = await resolveGitPath(targetGit, targetRoot, name);
    if (await fs.access(statePath).then(() => true).catch(() => false)) {
      return { reasonCode: 'GIT_OPERATION_IN_PROGRESS', error: `active ${label} state in progress` };
    }
  }

  const trackedStatus = await targetGit.raw(['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  if (trackedStatus.length > 0) {
    return {
      reasonCode: 'TARGET_DIRTY',
      error: 'Target repo has dirty tracked/index state: staged, unstaged tracked, or unmerged changes',
    };
  }

  if (precomputedCandidates && (
    precomputedCandidates.targetCommit !== topologyTargetCommit
    || precomputedCandidates.sourceCommit !== sourceCommit
    || precomputedCandidates.strategy !== strategy
  )) {
    throw new Error('Precomputed merge candidates do not match the immutable integration pins');
  }
  const candidates = precomputedCandidates
    ?? await computeTargetMergeCandidates(targetGit, targetCommit, sourceCommit, strategy);
  if (candidates.candidateFiles.length === 0) return candidates;

  const pathBounded = await isPathBoundedTopology(targetGit, topologyTargetCommit, sourceCommit, strategy);
  const localDataPath = pathBounded
    ? null
    : await hasLocalUntrackedOrIgnoredData(targetGit, targetRoot, excludedLocalPaths);
  if (localDataPath) {
    return {
      reasonCode: 'TARGET_RECONCILIATION_REQUIRED',
      error: `Target has protected local data at ${JSON.stringify(localDataPath)}, but the pinned source does not provide a path-bounded integration. Reconcile the pinned target into the source worktree, preserve the local data, and return fresh source and target pins`,
    };
  }

  const { collisionCandidates } = candidates;
  const ancestorPathspecs = collisionAncestorPathspecs(collisionCandidates);
  const scanPaths = (flags: string[], pathspecs: readonly string[]): Promise<string> => pathspecs.length === 0
    ? Promise.resolve('')
    : targetGit.raw(['--literal-pathspecs', 'ls-files', '--others', ...flags, '--exclude-standard', '-z', '--', ...pathspecs]);
  const [untrackedExact, untrackedAncestors, ignoredExact, ignoredAncestors] = await Promise.all([
    scanPaths([], collisionCandidates),
    scanPaths([], ancestorPathspecs),
    scanPaths(['--ignored'], collisionCandidates),
    scanPaths(['--ignored'], ancestorPathspecs),
  ]);
  for (const [kind, outputs] of [
    ['untracked', [untrackedExact, untrackedAncestors]],
    ['ignored', [ignoredExact, ignoredAncestors]],
  ] as const) {
    const existingPaths = [...new Set(outputs.flatMap(output => output.split('\0').filter(Boolean)))];
    const collision = existingPaths.find(existing =>
      collisionCandidates.some(candidate => collides(collisionPath(existing), candidate))
    );
    if (collision) {
      return {
        reasonCode: 'TARGET_DIRTY',
        error: `Target ${kind} path ${JSON.stringify(collision)} collides with the incoming update`,
      };
    }
  }
  return candidates;
}

export async function integrateWorktreeRepository(options: {
  targetGit: SimpleGit;
  sourceGit: SimpleGit;
  sourceBranch: string;
  sourceCommit: string;
  expectedTarget: WorktreeTargetIdentity;
  sourceDiagnosticPath: string;
  excludedLocalPaths?: string[];
  precomputedCandidates?: TargetMergeCandidates;
  strategy: IntegrationStrategy;
  message: string | undefined;
  preserveConflicts: boolean;
  cleanupMode: CleanupMode;
  cleanup: (deleteBranch: boolean) => Promise<WorktreeCleanupOutcome>;
  readCommitMessage: (git: SimpleGit, hash: string) => Promise<string>;
}): Promise<WorktreeIntegrationResult> {
  const {
    targetGit,
    sourceGit,
    sourceBranch,
    sourceCommit,
    expectedTarget,
    sourceDiagnosticPath,
    excludedLocalPaths = [],
    precomputedCandidates,
    strategy,
    message,
    preserveConflicts,
    cleanupMode,
    cleanup,
    readCommitMessage,
  } = options;
  let startingHead: string | undefined;
  let targetRoot: string | undefined;
  let operationTarget: WorktreeTargetIdentity | undefined;
  let cleanupFailureMutation: WorktreeMutationState | undefined;
  let verificationFailure = false;
  const eligibilityExcludedLocalPaths = [
    sourceDiagnosticPath,
    `${sourceDiagnosticPath}.json`,
    ...excludedLocalPaths,
  ];

  const targetIdentityFailure = async (
    expectedIdentity: WorktreeTargetIdentity,
    mismatchCode: WorktreeReasonCode = 'TARGET_MISMATCH',
    unreadableCode: WorktreeReasonCode = 'GIT_OPERATION_FAILED',
    mutation?: WorktreeMutationState,
  ): Promise<WorktreeIntegrationResult | null> => {
    if (!targetRoot) {
      return integrationFailure(unreadableCode, 'Trusted target repository root has not been resolved', {
        mutation,
        expectedTarget,
        observedTarget: null,
      });
    }
    let observedTarget: WorktreeTargetIdentity;
    try {
      observedTarget = await readWorktreeTargetIdentity(targetRoot);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return integrationFailure(unreadableCode, `Unable to read target identity from ${targetRoot}: ${cause}`, {
        mutation,
        expectedTarget,
        observedTarget: null,
      });
    }
    if (sameWorktreeTarget(expectedIdentity, observedTarget)) return null;
    return integrationFailure(mismatchCode, 'Target identity no longer matches the verified operation checkpoint', {
      mutation,
      expectedTarget,
      observedTarget,
    });
  };

  const recordOperationCommit = async (previousTarget: WorktreeTargetIdentity, commit: string): Promise<WorktreeIntegrationResult | null> => {
    const expectedOperationTarget = { ...previousTarget, commit };
    const identityFailure = await targetIdentityFailure(
      expectedOperationTarget,
      'POST_INTEGRATION_VERIFICATION_FAILED',
      'POST_INTEGRATION_VERIFICATION_FAILED',
      'unknown',
    );
    if (identityFailure) return identityFailure;
    let firstParent: string;
    try {
      firstParent = (await targetGit.revparse([`${commit}^1`])).trim();
    } catch (error) {
      return integrationFailure(
        'POST_INTEGRATION_VERIFICATION_FAILED',
        `Unable to verify the integrated commit parent: ${error instanceof Error ? error.message : String(error)}`,
        { mutation: 'unknown', expectedTarget, observedTarget: expectedOperationTarget },
      );
    }
    if (firstParent !== previousTarget.commit) {
      return integrationFailure(
        'POST_INTEGRATION_VERIFICATION_FAILED',
        `Integrated commit ${commit} does not descend from the verified operation checkpoint ${previousTarget.commit}`,
        { mutation: 'unknown', expectedTarget, observedTarget: expectedOperationTarget },
      );
    }
    operationTarget = expectedOperationTarget;
    return null;
  };

  const cleanupWithIdentityRecheck = async (expectedCleanupTarget: WorktreeTargetIdentity): Promise<WorktreeCleanupOutcome> => {
    if (cleanupMode === 'none') return buildNotRequestedCleanupOutcome();
    let identityMatches = false;
    let identityError: string | undefined;
    try {
      if (!targetRoot) throw new Error('Trusted target repository root has not been resolved');
      const currentTarget = await readWorktreeTargetIdentity(targetRoot);
      const currentSource = (await targetGit.revparse([sourceBranch])).trim();
      identityMatches = sameWorktreeTarget(expectedCleanupTarget, currentTarget) && currentSource === sourceCommit;
    } catch (error) {
      identityError = error instanceof Error ? error.message : String(error);
    }
    if (identityMatches) return cleanup(cleanupMode === 'worktree+branch');
    return buildCleanupOutcome(cleanupMode, {
      worktreeRemoval: { status: 'not_attempted' },
      branchDeletion: { status: 'not_attempted' },
      prune: { status: 'not_attempted' },
      failures: [{
        step: 'identity-recheck',
        cause: identityError
          ? `Source or target could not be read after integration; cleanup was skipped: ${identityError}`
          : 'Source or target moved after integration; cleanup was skipped',
      }],
    });
  };

  try {
    targetRoot = await fs.realpath(path.resolve((await targetGit.raw(['rev-parse', '--show-toplevel'])).trim()));
    const branches = await targetGit.branch();
    if (!branches.all.includes(sourceBranch)) {
      return integrationFailure('SOURCE_BRANCH_MISSING', `Branch ${sourceBranch} not found`);
    }

    const currentBranch = branches.current;
    const actualSourceCommit = (await targetGit.revparse([sourceBranch])).trim();
    if (actualSourceCommit !== sourceCommit) {
      return integrationFailure('GIT_OPERATION_FAILED', `Source ${sourceBranch} moved from pinned commit ${sourceCommit} to ${actualSourceCommit}`);
    }
    if (!(await sourceGit.status()).isClean()) {
      return integrationFailure('TARGET_DIRTY', `Source worktree ${sourceDiagnosticPath} has tracked or untracked changes`);
    }

    startingHead = (await targetGit.revparse(['HEAD'])).trim();
    const initialTargetFailure = await targetIdentityFailure(expectedTarget);
    if (initialTargetFailure) return initialTargetFailure;
    operationTarget = { ...expectedTarget, path: targetRoot };
    const eligibility = await inspectTargetMergeEligibility({
      targetGit,
      targetRoot,
      targetCommit: startingHead,
      sourceCommit,
      strategy,
      excludedLocalPaths: eligibilityExcludedLocalPaths,
      precomputedCandidates,
    });
    if ('error' in eligibility) return integrationFailure(eligibility.reasonCode, eligibility.error);
    const { candidateFiles } = eligibility;

    if (candidateFiles.length === 0) {
      cleanupFailureMutation = 'none';
      const cleanupOutcome = await cleanupWithIdentityRecheck(expectedTarget);
      return {
        success: true,
        merged: false,
        reason: 'nothing_to_merge',
        reasonCode: 'NO_TRACKED_CHANGES',
        cleanupEligible: true,
        filesChanged: [],
        conflicts: [],
        conflictState: 'none',
        cleanup: toMergeCleanupBlock(cleanupOutcome),
        ...mergeSuccessClassification(cleanupMode, cleanupOutcome, 'none'),
      };
    }

    let commitMessage: string | undefined;
    if (strategy === 'rebase') {
      if (message?.trim()) {
        return integrationFailure('MESSAGE_NOT_ALLOWED_FOR_REBASE', 'Custom merge message is not supported for rebase strategy');
      }
    } else {
      try {
        commitMessage = normalizeCommitMessage(message);
      } catch (error: unknown) {
        return integrationFailure('INVALID_MERGE_MESSAGE', (error as { message?: string }).message || 'Invalid merge message');
      }
    }
    if (strategy !== 'squash') {
      const sourceError = await validateSourceCommitMessages(targetGit, expectedTarget.commit, sourceCommit);
      if (sourceError) return integrationFailure('INVALID_COMMIT_MESSAGE', sourceError);
    }

    let finalHead: string;
    let conflicts: string[] = [];
    let createdCommitMessage: string | undefined;
    const immediateTargetFailure = await targetIdentityFailure(operationTarget);
    if (immediateTargetFailure) return immediateTargetFailure;
    const immediateEligibility = await inspectTargetMergeEligibility({
      targetGit,
      targetRoot,
      targetCommit: operationTarget.commit,
      topologyTargetCommit: startingHead,
      sourceCommit,
      strategy,
      excludedLocalPaths: eligibilityExcludedLocalPaths,
      precomputedCandidates: eligibility,
    });
    if ('error' in immediateEligibility) {
      return integrationFailure(immediateEligibility.reasonCode, immediateEligibility.error);
    }
    if (strategy === 'squash') {
      await targetGit.raw(['merge', '--squash', '--no-overwrite-ignore', sourceCommit]);
      const stagedTargetFailure = await targetIdentityFailure(
        operationTarget,
        'POST_INTEGRATION_VERIFICATION_FAILED',
        'POST_INTEGRATION_VERIFICATION_FAILED',
        'unknown',
      );
      if (stagedTargetFailure) {
        return integrationFailure(
          'POST_INTEGRATION_VERIFICATION_FAILED',
          `Target identity could not be verified after squash staging; staged operation state was retained for inspection: ${stagedTargetFailure.error}`,
          {
            mutation: 'unknown',
            expectedTarget,
            observedTarget: stagedTargetFailure.observedTarget,
          },
        );
      }
      await targetGit.commit(commitMessage!);
      finalHead = (await targetGit.revparse(['HEAD'])).trim();
      if (finalHead === startingHead) throw new Error('Failed to create squash commit');
      const commitFailure = await recordOperationCommit(operationTarget, finalHead);
      if (commitFailure) return commitFailure;
      try {
        createdCommitMessage = await readCommitMessage(targetGit, finalHead);
      } catch (error) {
        verificationFailure = true;
        throw error;
      }
    } else if (strategy === 'rebase') {
      const output = (await targetGit.raw(['rev-list', '--reverse', `${startingHead}..${sourceCommit}`])).trim();
      for (const hash of output ? output.split('\n').filter(Boolean) : []) {
        const beforePickFailure = await targetIdentityFailure(
          operationTarget,
          'POST_INTEGRATION_VERIFICATION_FAILED',
          'POST_INTEGRATION_VERIFICATION_FAILED',
          'unknown',
        );
        if (beforePickFailure) return beforePickFailure;
        const beforePickEligibility = await inspectTargetMergeEligibility({
          targetGit,
          targetRoot,
          targetCommit: operationTarget.commit,
          topologyTargetCommit: startingHead,
          sourceCommit,
          strategy,
          excludedLocalPaths: eligibilityExcludedLocalPaths,
          precomputedCandidates: eligibility,
        });
        if ('error' in beforePickEligibility) {
          if (operationTarget.commit !== startingHead) {
            const unsafeRollback = await targetIdentityFailure(
              operationTarget,
              'POST_INTEGRATION_VERIFICATION_FAILED',
              'POST_INTEGRATION_VERIFICATION_FAILED',
              'unknown',
            );
            if (unsafeRollback) {
              return integrationFailure(
                'POST_INTEGRATION_VERIFICATION_FAILED',
                `${beforePickEligibility.error}; rollback was skipped because the target no longer matches the last verified operation checkpoint: ${unsafeRollback.error}`,
                {
                  mutation: 'unknown',
                  expectedTarget: operationTarget,
                  observedTarget: unsafeRollback.observedTarget,
                },
              );
            }
            let rollbackError: string | undefined;
            await targetGit.raw(['reset', '--merge', startingHead]).catch((error: unknown) => {
              rollbackError = (error as { message?: string }).message ?? 'reset --merge failed';
            });
            if (!rollbackError && (await targetGit.revparse(['HEAD']).catch(() => '')).trim() !== startingHead) {
              rollbackError = 'Git reset did not restore the original target HEAD';
            }
            if (!rollbackError) {
              const trackedStatus = await targetGit.raw(['status', '--porcelain=v1', '-z', '--untracked-files=no']);
              if (trackedStatus.length > 0) rollbackError = 'Git reset did not restore a clean tracked/index state';
            }
            if (!rollbackError) {
              const activeStates = await activeGitOperationStates(targetGit, targetRoot);
              if (activeStates.length > 0 || (await activeConflictFiles(targetGit)).length > 0) {
                rollbackError = `Git operation remains active after reset${activeStates.length > 0 ? `: ${activeStates.join(', ')}` : ''}`;
              }
            }
            if (rollbackError) {
              return integrationFailure(
                'ROLLBACK_FAILED',
                `${beforePickEligibility.error}; failed to restore target: ${rollbackError}`,
                { mutation: 'unknown' },
              );
            }
          }
          return integrationFailure(beforePickEligibility.reasonCode, beforePickEligibility.error);
        }
        await targetGit.raw(['cherry-pick', hash]);
        const cherryPickHead = (await targetGit.revparse(['HEAD'])).trim();
        const commitFailure = await recordOperationCommit(operationTarget, cherryPickHead);
        if (commitFailure) return commitFailure;
        try {
          await readCommitMessage(targetGit, cherryPickHead);
        } catch (error) {
          verificationFailure = true;
          throw error;
        }
      }
      finalHead = (await targetGit.revparse(['HEAD'])).trim();
    } else {
      const result = await targetGit.merge([sourceCommit, '--no-ff', '-m', commitMessage!]);
      finalHead = (await targetGit.revparse(['HEAD'])).trim();
      if (result.failed || finalHead === startingHead) throw new Error('Failed to create merge commit');
      const commitFailure = await recordOperationCommit(operationTarget, finalHead);
      if (commitFailure) return commitFailure;
      try {
        createdCommitMessage = await readCommitMessage(targetGit, finalHead);
      } catch (error) {
        verificationFailure = true;
        throw error;
      }
      conflicts = result.conflicts?.map((conflict) => conflict.file || String(conflict)) || [];
    }

    const finalTargetFailure = await targetIdentityFailure(
      operationTarget,
      'POST_INTEGRATION_VERIFICATION_FAILED',
      'POST_INTEGRATION_VERIFICATION_FAILED',
      'unknown',
    );
    if (finalTargetFailure) return finalTargetFailure;

    if (finalHead === startingHead) {
      cleanupFailureMutation = 'none';
      const cleanupOutcome = await cleanupWithIdentityRecheck(expectedTarget);
      return {
        success: true,
        merged: false,
        reason: 'nothing_to_merge',
        reasonCode: 'NO_TRACKED_CHANGES',
        cleanupEligible: true,
        filesChanged: [],
        conflicts: [],
        conflictState: 'none',
        cleanup: toMergeCleanupBlock(cleanupOutcome),
        ...mergeSuccessClassification(cleanupMode, cleanupOutcome, 'none'),
      };
    }

    const filesChanged = await observedDeltaFiles(targetGit, startingHead, finalHead);
    cleanupFailureMutation = 'applied';
    const cleanupOutcome = await cleanupWithIdentityRecheck({ ...expectedTarget, commit: finalHead });
    return {
      success: true,
      merged: true,
      sha: finalHead,
      ...(createdCommitMessage !== undefined ? { commitMessage: createdCommitMessage } : {}),
      filesChanged,
      conflicts,
      conflictState: 'none',
      cleanup: toMergeCleanupBlock(cleanupOutcome),
      ...mergeSuccessClassification(cleanupMode, cleanupOutcome, 'applied'),
    };
  } catch (error: unknown) {
    const message = (error as { message?: string }).message;
    if (cleanupFailureMutation !== undefined) {
      return integrationFailure('CLEANUP_FAILED', message || 'Cleanup failed', { mutation: cleanupFailureMutation });
    }

    const conflicts = await activeConflictFiles(targetGit);
    const isConflict = conflicts.length > 0;
    const preserveConflictState = isConflict && preserveConflicts;
    let rollbackError: string | undefined;

    // Repository locks coordinate Hive operations, not arbitrary Git writers.
    // Roll back only while HEAD still matches the last operation-owned checkpoint.
    if (startingHead && operationTarget) {
      const unsafeRollback = await targetIdentityFailure(
        operationTarget,
        'POST_INTEGRATION_VERIFICATION_FAILED',
        'POST_INTEGRATION_VERIFICATION_FAILED',
        'unknown',
      );
      if (unsafeRollback) {
        return integrationFailure(
          'POST_INTEGRATION_VERIFICATION_FAILED',
          `${message || 'Merge failed'}; rollback was skipped because the target no longer matches the last verified operation checkpoint: ${unsafeRollback.error}`,
          {
            mutation: 'unknown',
            conflicts,
            conflictState: isConflict ? 'preserved' : 'none',
            expectedTarget,
            observedTarget: unsafeRollback.observedTarget,
          },
        );
      }
    }

    if (!preserveConflictState && startingHead && isConflict) {
      if (strategy === 'merge') await targetGit.raw(['merge', '--abort']).catch(() => {});
      else if (strategy === 'rebase') await targetGit.raw(['cherry-pick', '--abort']).catch(() => {});
      await targetGit.raw(['reset', '--merge', startingHead]).catch((resetError: unknown) => {
        rollbackError = (resetError as { message?: string }).message ?? 'reset --merge failed';
      });
      if ((await targetGit.revparse(['HEAD']).catch(() => '')).trim() !== startingHead) {
        rollbackError = 'Git abort did not restore the original target HEAD';
      }
    } else if (!preserveConflictState && startingHead) {
      await targetGit.raw(['reset', '--merge', startingHead]).catch((resetError: unknown) => {
        rollbackError = (resetError as { message?: string }).message ?? 'reset --merge failed';
      });
    }

    if (!preserveConflictState && startingHead && !rollbackError) {
      const activeStates = await activeGitOperationStates(targetGit, targetRoot ?? '');
      if (activeStates.length > 0 || (await activeConflictFiles(targetGit)).length > 0) {
        rollbackError = `Git operation remains active after abort/reset${activeStates.length > 0 ? `: ${activeStates.join(', ')}` : ''}`;
      }
    }

    if (rollbackError) {
      return integrationFailure('ROLLBACK_FAILED', `${message || 'Merge failed'}; failed to restore target: ${rollbackError}`, {
        mutation: 'unknown',
        conflicts: isConflict ? conflicts : [],
        conflictState: preserveConflictState ? 'preserved' : 'none',
      });
    }
    if (isConflict) {
      return integrationFailure(
        preserveConflictState ? 'MERGE_CONFLICT_PRESERVED' : 'MERGE_CONFLICT_ABORTED',
        'Merge conflicts detected',
        { conflicts, conflictState: preserveConflictState ? 'preserved' : 'aborted' },
      );
    }
    if (verificationFailure) {
      return integrationFailure('POST_INTEGRATION_VERIFICATION_FAILED', message || 'Merge failed', { mutation: 'unknown' });
    }
    return integrationFailure('GIT_OPERATION_FAILED', message || 'Merge failed');
  }
}
