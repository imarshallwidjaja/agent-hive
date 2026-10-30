import * as fs from 'fs/promises';
import * as path from 'path';
import type { SimpleGit } from 'simple-git';
import { normalizeCommitMessage } from '../utils/mergeMessage.js';
import {
  buildNotRequestedCleanupOutcome,
  buildNotRequestedMergeCleanupBlock,
  buildSkippedCleanupOutcome,
  buildThrownCleanupOutcome,
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

/**
 * What the caller declares about the source-only history being integrated.
 * - preserve-source: source ancestry must survive in the destination.
 * - rewrite-private: every source-only commit in every selected repository is
 *   private and authorized for rewriting. The declaration is an attestation;
 *   Hive does not prove privacy.
 */
export type HistoryIntent = 'preserve-source' | 'rewrite-private';
export type IntegrationStrategy = 'merge' | 'squash' | 'rebase';
export type PreserveSourcePolicy = Readonly<{ historyIntent: 'preserve-source'; strategy: 'merge' }>;
export type RewritePrivatePolicy = Readonly<{ historyIntent: 'rewrite-private'; strategy: 'squash' | 'rebase' }>;
/** The one integration operation a validated intent and strategy permit. */
export type IntegrationPolicy = PreserveSourcePolicy | RewritePrivatePolicy;

/**
 * Validate a caller's history intent and optional strategy at runtime, so
 * untyped callers cannot fall back to a default intent. preserve-source
 * permits only merge; rewrite-private permits squash (its default) or rebase.
 */
export function resolveIntegrationPolicy(
  historyIntent: unknown,
  strategy: unknown,
): { policy: IntegrationPolicy } | { error: string } {
  if (historyIntent === undefined) {
    return { error: "historyIntent is required: declare 'preserve-source' or 'rewrite-private'" };
  }
  if (historyIntent !== 'preserve-source' && historyIntent !== 'rewrite-private') {
    return { error: `Unknown historyIntent ${JSON.stringify(historyIntent)}: use 'preserve-source' or 'rewrite-private'` };
  }
  if (strategy !== undefined && strategy !== 'merge' && strategy !== 'squash' && strategy !== 'rebase') {
    return { error: `Unknown strategy ${JSON.stringify(strategy)}: use 'merge', 'squash' or 'rebase'` };
  }
  if (historyIntent === 'preserve-source') {
    if (strategy === undefined || strategy === 'merge') {
      return { policy: Object.freeze({ historyIntent, strategy: 'merge' as const }) };
    }
    return { error: `historyIntent 'preserve-source' permits only strategy 'merge'; '${strategy}' rewrites source history` };
  }
  if (strategy === 'merge') {
    return { error: "historyIntent 'rewrite-private' permits strategy 'squash' or 'rebase'; declare 'preserve-source' for a normal merge" };
  }
  return { policy: Object.freeze({ historyIntent, strategy: strategy === 'rebase' ? 'rebase' as const : 'squash' as const }) };
}

/**
 * The integration work the pinned source requires, classified once and shared
 * by composite preflight and execution:
 * - contained: the source is already an ancestor of (or equal to) the target.
 * - preservation: preserve-source must join the source history, even when the
 *   endpoint trees are equal.
 * - private-content-noop: rewrite-private with no net tracked difference.
 * - private-integration: rewrite-private with content to squash or replay.
 */
export type IntegrationWorkKind = 'contained' | 'preservation' | 'private-content-noop' | 'private-integration';

type CleanupMode = WorktreeCleanupOutcome['requested'];
export type TargetMergeCandidates = Readonly<{
  targetCommit: string;
  sourceCommit: string;
  policy: IntegrationPolicy;
  workKind: IntegrationWorkKind;
  candidateFiles: readonly string[];
  collisionCandidates: readonly string[];
}>;

/**
 * What a completed integration must prove before destructive same-call
 * cleanup. Preserved and contained work prove source containment in the
 * target. Rewritten work proves completion and fresh identities and carries
 * the caller's private attestation instead of original-source containment.
 */
export type CompletedIntegration =
  | { kind: 'contained' }
  | { kind: 'preserved' }
  | { kind: 'rewritten'; attestation: RewritePrivatePolicy };

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

/** Carries a failure of the pre-mutation hook past the rollback path: nothing ran, so nothing is rolled back. */
class BeforeMutationFailure {
  constructor(readonly cause: unknown) {}
}

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
  targetCommit: string,
  sourceCommit: string,
): Promise<string | null> {
  const output = (await git.raw(['rev-list', '--reverse', `${targetCommit}..${sourceCommit}`])).trim();
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

/**
 * Whether `ancestor` is reachable from or equal to `descendant`. Git errors
 * propagate: an unreadable relationship is not a negative one.
 */
async function isAncestorOrEqual(git: SimpleGit, ancestor: string, descendant: string): Promise<boolean> {
  const output = (await git.raw(['rev-list', '--count', `${descendant}..${ancestor}`])).trim();
  if (!/^\d+$/.test(output)) {
    throw new Error(`Unable to read whether ${ancestor} is contained in ${descendant}: unexpected rev-list output ${JSON.stringify(output)}`);
  }
  return output === '0';
}

async function classifyIntegrationWork(
  git: SimpleGit,
  targetCommit: string,
  sourceCommit: string,
  policy: IntegrationPolicy,
): Promise<TargetMergeCandidates> {
  const pins = { targetCommit, sourceCommit, policy };
  if (await isAncestorOrEqual(git, sourceCommit, targetCommit)) {
    const none = Object.freeze([] as string[]);
    return Object.freeze({ ...pins, workKind: 'contained', candidateFiles: none, collisionCandidates: none });
  }
  const candidateFiles = Object.freeze(await changedPaths(git, targetCommit, sourceCommit));
  if (policy.historyIntent === 'preserve-source') {
    return Object.freeze({ ...pins, workKind: 'preservation', candidateFiles, collisionCandidates: candidateFiles });
  }
  if (candidateFiles.length === 0) {
    return Object.freeze({ ...pins, workKind: 'private-content-noop', candidateFiles, collisionCandidates: candidateFiles });
  }
  if (policy.strategy !== 'rebase') {
    return Object.freeze({ ...pins, workKind: 'private-integration', candidateFiles, collisionCandidates: candidateFiles });
  }

  const commitsOutput = (await git.raw(['rev-list', '--reverse', `${targetCommit}..${sourceCommit}`])).trim();
  const commits = commitsOutput ? commitsOutput.split('\n').filter(Boolean) : [];
  const commitPaths = await Promise.all(commits.map(commit => commitChangedPaths(git, commit)));
  const collisionCandidates = Object.freeze([...new Set([...candidateFiles, ...commitPaths.flat()])]);
  return Object.freeze({ ...pins, workKind: 'private-integration', candidateFiles, collisionCandidates });
}

/**
 * Message requirements of the classified work, checked before any mutation.
 * Contained and private content no-op work creates no commit. Preservation and
 * squash create one aggregate commit; private replay keeps and validates each
 * source message and rejects a custom message. Preservation never validates
 * existing source messages: they are kept verbatim.
 */
export async function integrationMessageFailure(
  git: SimpleGit,
  candidates: TargetMergeCandidates,
  message: string | undefined,
): Promise<{ reasonCode: WorktreeReasonCode; error: string } | null> {
  if (candidates.workKind === 'contained' || candidates.workKind === 'private-content-noop') return null;
  if (candidates.policy.strategy === 'rebase') {
    if (message?.trim()) {
      return { reasonCode: 'MESSAGE_NOT_ALLOWED_FOR_REBASE', error: 'Custom merge message is not supported for rebase strategy' };
    }
    const sourceError = await validateSourceCommitMessages(git, candidates.targetCommit, candidates.sourceCommit);
    return sourceError ? { reasonCode: 'INVALID_COMMIT_MESSAGE', error: sourceError } : null;
  }
  try {
    normalizeCommitMessage(message);
    return null;
  } catch (error: unknown) {
    return { reasonCode: 'INVALID_MERGE_MESSAGE', error: (error as { message?: string }).message || 'Invalid merge message' };
  }
}

export function completedIntegration(
  policy: IntegrationPolicy,
  result: Pick<WorktreeIntegrationResult, 'reasonCode'>,
): CompletedIntegration {
  if (result.reasonCode === 'ALREADY_INTEGRATED') return { kind: 'contained' };
  return policy.historyIntent === 'preserve-source'
    ? { kind: 'preserved' }
    : { kind: 'rewritten', attestation: policy };
}

/**
 * The single proof gate before destructive same-call cleanup on every route.
 * It rereads source and target identities, then requires source containment
 * for preserved or contained work; rewritten work relies on its completed
 * operation and the caller's private attestation. Returns the failure that
 * retains the source placement, or null when cleanup may proceed.
 */
export async function proveCleanupEligibility(options: {
  targetGit: SimpleGit;
  targetRoot: string;
  sourceBranch: string;
  sourceCommit: string;
  expectedTarget: WorktreeTargetIdentity;
  completion: CompletedIntegration;
}): Promise<{ step: string; cause: string } | null> {
  const { targetGit, targetRoot, sourceBranch, sourceCommit, expectedTarget, completion } = options;
  let currentTarget: WorktreeTargetIdentity;
  let currentSource: string;
  try {
    currentTarget = await readWorktreeTargetIdentity(targetRoot);
    currentSource = (await targetGit.revparse([sourceBranch])).trim();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return { step: 'identity-recheck', cause: `Source or target could not be read after integration; cleanup was skipped: ${cause}` };
  }
  if (!sameWorktreeTarget(expectedTarget, currentTarget) || currentSource !== sourceCommit) {
    return { step: 'identity-recheck', cause: 'Source or target moved after integration; cleanup was skipped' };
  }
  if (completion.kind === 'rewritten') {
    if (completion.attestation.historyIntent === 'rewrite-private') return null;
    return { step: 'ancestry-proof', cause: 'Rewritten history lacks a private attestation; cleanup was skipped' };
  }
  try {
    if (await isAncestorOrEqual(targetGit, sourceCommit, currentTarget.commit)) return null;
    return {
      step: 'ancestry-proof',
      cause: `Source ${sourceCommit} is not contained in target ${currentTarget.commit}; cleanup was skipped to retain the source history`,
    };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return { step: 'ancestry-proof', cause: `Source ancestry in the target could not be read; cleanup was skipped: ${cause}` };
  }
}

async function isPathBoundedTopology(
  git: SimpleGit,
  targetCommit: string,
  sourceCommit: string,
  strategy: IntegrationStrategy,
): Promise<boolean> {
  if (!(await isAncestorOrEqual(git, targetCommit, sourceCommit))) return false;
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
  policy: IntegrationPolicy;
  excludedLocalPaths?: string[];
  precomputedCandidates?: TargetMergeCandidates;
}): Promise<TargetMergeEligibility> {
  const {
    targetGit,
    targetRoot,
    targetCommit,
    topologyTargetCommit = targetCommit,
    sourceCommit,
    policy,
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
    || precomputedCandidates.policy.historyIntent !== policy.historyIntent
    || precomputedCandidates.policy.strategy !== policy.strategy
  )) {
    throw new Error('Precomputed merge candidates do not match the immutable integration pins and history policy');
  }
  // Containment is classified before topology and local-data eligibility: an
  // already integrated source needs no target change, whatever the trees.
  const candidates = precomputedCandidates
    ?? await classifyIntegrationWork(targetGit, targetCommit, sourceCommit, policy);
  if (candidates.workKind === 'contained' || candidates.workKind === 'private-content-noop') return candidates;

  const pathBounded = await isPathBoundedTopology(targetGit, topologyTargetCommit, sourceCommit, policy.strategy);
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
  policy: IntegrationPolicy;
  message: string | undefined;
  preserveConflicts: boolean;
  cleanupMode: CleanupMode;
  cleanup: (deleteBranch: boolean) => Promise<WorktreeCleanupOutcome>;
  readCommitMessage: (git: SimpleGit, hash: string) => Promise<string>;
  /** Called immediately before the first command that changes the destination or removes the source. */
  beforeMutation: () => Promise<void>;
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
    policy,
    message,
    preserveConflicts,
    cleanupMode,
    cleanup,
    readCommitMessage,
  } = options;
  const { strategy } = policy;
  const beginMutation = async (): Promise<void> => {
    try {
      await options.beforeMutation();
    } catch (error) {
      throw new BeforeMutationFailure(error);
    }
  };
  let startingHead: string | undefined;
  let targetRoot: string | undefined;
  let operationTarget: WorktreeTargetIdentity | undefined;
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

  // Same-call cleanup runs only after the completed work's proof. An exception
  // from cleanup is a cleanup outcome: the completed integration result stands.
  const cleanupAfterProof = async (
    postTarget: WorktreeTargetIdentity,
    completion: CompletedIntegration,
  ): Promise<WorktreeCleanupOutcome> => {
    if (cleanupMode === 'none') return buildNotRequestedCleanupOutcome();
    const proofFailure = await proveCleanupEligibility({
      targetGit,
      targetRoot: targetRoot!,
      sourceBranch,
      sourceCommit,
      expectedTarget: postTarget,
      completion,
    });
    if (proofFailure) return buildSkippedCleanupOutcome(cleanupMode, proofFailure);
    // A failed pre-mutation hook is not a cleanup outcome: nothing was removed.
    await beginMutation();
    try {
      return await cleanup(cleanupMode === 'worktree+branch');
    } catch (error) {
      return buildThrownCleanupOutcome(cleanupMode, error);
    }
  };

  const noOpResult = (
    completion: CompletedIntegration,
    cleanupOutcome: WorktreeCleanupOutcome,
  ): WorktreeIntegrationResult => ({
    success: true,
    merged: false,
    ...(completion.kind === 'contained'
      ? { reason: 'already_integrated', reasonCode: 'ALREADY_INTEGRATED' as const }
      : { reason: 'nothing_to_merge', reasonCode: 'NO_TRACKED_CHANGES' as const }),
    cleanupEligible: true,
    filesChanged: [],
    conflicts: [],
    conflictState: 'none',
    cleanup: toMergeCleanupBlock(cleanupOutcome),
    ...mergeSuccessClassification(cleanupMode, cleanupOutcome, 'none'),
  });

  // The created preservation commit is retained: a negative or unreadable
  // ancestry check is reported without rollback or cleanup.
  const sourcePreservationFailure = async (finalCommit: string): Promise<WorktreeIntegrationResult | null> => {
    let cause: string;
    try {
      if (await isAncestorOrEqual(targetGit, sourceCommit, finalCommit)) return null;
      cause = `Integrated commit ${finalCommit} does not contain source ${sourceCommit}`;
    } catch (error) {
      cause = `Unable to verify that integrated commit ${finalCommit} contains source ${sourceCommit}: ${error instanceof Error ? error.message : String(error)}`;
    }
    return integrationFailure('POST_INTEGRATION_VERIFICATION_FAILED', `${cause}; the integration commit and source placement were retained`, {
      mutation: 'applied',
      expectedTarget,
      observedTarget: operationTarget,
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
      policy,
      excludedLocalPaths: eligibilityExcludedLocalPaths,
      precomputedCandidates,
    });
    if ('error' in eligibility) return integrationFailure(eligibility.reasonCode, eligibility.error);
    const operationCompletion: CompletedIntegration = policy.historyIntent === 'preserve-source'
      ? { kind: 'preserved' }
      : { kind: 'rewritten', attestation: policy };

    if (eligibility.workKind === 'contained') {
      const completion: CompletedIntegration = { kind: 'contained' };
      return noOpResult(completion, await cleanupAfterProof(expectedTarget, completion));
    }
    if (eligibility.workKind === 'private-content-noop') {
      return noOpResult(operationCompletion, await cleanupAfterProof(expectedTarget, operationCompletion));
    }

    const messageFailure = await integrationMessageFailure(targetGit, eligibility, message);
    if (messageFailure) return integrationFailure(messageFailure.reasonCode, messageFailure.error);
    const commitMessage = strategy === 'rebase' ? undefined : normalizeCommitMessage(message);

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
      policy,
      excludedLocalPaths: eligibilityExcludedLocalPaths,
      precomputedCandidates: eligibility,
    });
    if ('error' in immediateEligibility) {
      return integrationFailure(immediateEligibility.reasonCode, immediateEligibility.error);
    }
    await beginMutation();
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
          policy,
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
      const preservationFailure = await sourcePreservationFailure(finalHead);
      if (preservationFailure) return preservationFailure;
    }

    const finalTargetFailure = await targetIdentityFailure(
      operationTarget,
      'POST_INTEGRATION_VERIFICATION_FAILED',
      'POST_INTEGRATION_VERIFICATION_FAILED',
      'unknown',
    );
    if (finalTargetFailure) return finalTargetFailure;

    if (finalHead === startingHead) {
      return noOpResult(operationCompletion, await cleanupAfterProof(expectedTarget, operationCompletion));
    }

    const filesChanged = await observedDeltaFiles(targetGit, startingHead, finalHead);
    const cleanupOutcome = await cleanupAfterProof({ ...expectedTarget, commit: finalHead }, operationCompletion);
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
    if (error instanceof BeforeMutationFailure) throw error.cause;
    const message = (error as { message?: string }).message;
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
