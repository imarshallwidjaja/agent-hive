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

export async function resolveGitPath(git: SimpleGit, repoRoot: string, name: string): Promise<string> {
  try {
    const output = (await git.raw(['rev-parse', '--git-path', name])).trim();
    if (!output) return path.join(repoRoot, '.git', name);
    return path.isAbsolute(output) ? output : path.join(repoRoot, output);
  } catch {
    return path.join(repoRoot, '.git', name);
  }
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

export async function integrateWorktreeRepository(options: {
  targetGit: SimpleGit;
  sourceGit: SimpleGit;
  sourceBranch: string;
  sourceCommit: string;
  expectedTarget: WorktreeTargetIdentity;
  sourceDiagnosticPath: string;
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

    const stateChecks = [
      { name: 'MERGE_HEAD', label: 'merge' },
      { name: 'REBASE_HEAD', label: 'rebase' },
      { name: 'CHERRY_PICK_HEAD', label: 'cherry-pick' },
      { name: 'rebase-merge', label: 'rebase' },
      { name: 'rebase-apply', label: 'rebase' },
    ];
    for (const { name, label } of stateChecks) {
      const statePath = await resolveGitPath(targetGit, targetRoot, name);
      try {
        await fs.access(statePath);
        return integrationFailure('GIT_OPERATION_IN_PROGRESS', `active ${label} state in progress`);
      } catch {}
    }

    if (!(await targetGit.status()).isClean()) {
      return integrationFailure('TARGET_DIRTY', 'Target repo has uncommitted (dirty) changes');
    }
    startingHead = (await targetGit.revparse(['HEAD'])).trim();
    const initialTargetFailure = await targetIdentityFailure(expectedTarget);
    if (initialTargetFailure) return initialTargetFailure;
    operationTarget = { ...expectedTarget, path: targetRoot };
    const candidateFiles = (await targetGit.diff([startingHead, sourceCommit, '--name-only']))
      .split('\n').map((line) => line.trim()).filter(Boolean);

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
    if (strategy === 'squash') {
      await targetGit.raw(['merge', '--squash', sourceCommit]);
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
      const activeStates: string[] = [];
      for (const name of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply']) {
        const statePath = await resolveGitPath(targetGit, targetRoot ?? '', name);
        if (await fs.access(statePath).then(() => true).catch(() => false)) activeStates.push(name);
      }
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
