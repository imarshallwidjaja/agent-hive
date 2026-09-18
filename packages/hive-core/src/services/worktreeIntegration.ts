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
    sourceDiagnosticPath,
    strategy,
    message,
    preserveConflicts,
    cleanupMode,
    cleanup,
    readCommitMessage,
  } = options;
  let startingHead: string | undefined;
  let cleanupFailureMutation: WorktreeMutationState | undefined;
  let verificationFailure = false;

  const cleanupWithIdentityRecheck = async (expectedTarget: string): Promise<WorktreeCleanupOutcome> => {
    if (cleanupMode === 'none') return buildNotRequestedCleanupOutcome();
    let identityMatches = false;
    try {
      const currentTarget = (await targetGit.revparse(['HEAD'])).trim();
      const currentSource = (await targetGit.revparse([sourceBranch])).trim();
      identityMatches = currentTarget === expectedTarget && currentSource === sourceCommit;
    } catch {}
    if (identityMatches) return cleanup(cleanupMode === 'worktree+branch');
    return buildCleanupOutcome(cleanupMode, {
      worktreeRemoval: { status: 'not_attempted' },
      branchDeletion: { status: 'not_attempted' },
      prune: { status: 'not_attempted' },
      failures: [{ step: 'identity-recheck', cause: 'Source or target moved or could not be read after integration; cleanup was skipped' }],
    });
  };

  try {
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

    const repoRoot = (await targetGit.raw(['rev-parse', '--show-toplevel'])).trim();
    const stateChecks = [
      { name: 'MERGE_HEAD', label: 'merge' },
      { name: 'REBASE_HEAD', label: 'rebase' },
      { name: 'CHERRY_PICK_HEAD', label: 'cherry-pick' },
      { name: 'rebase-merge', label: 'rebase' },
      { name: 'rebase-apply', label: 'rebase' },
    ];
    for (const { name, label } of stateChecks) {
      const statePath = await resolveGitPath(targetGit, repoRoot, name);
      try {
        await fs.access(statePath);
        return integrationFailure('GIT_OPERATION_IN_PROGRESS', `active ${label} state in progress`);
      } catch {}
    }

    if (!(await targetGit.status()).isClean()) {
      return integrationFailure('TARGET_DIRTY', 'Target repo has uncommitted (dirty) changes');
    }
    startingHead = (await targetGit.revparse(['HEAD'])).trim();
    const candidateFiles = (await targetGit.diff([startingHead, sourceCommit, '--name-only']))
      .split('\n').map((line) => line.trim()).filter(Boolean);

    if (candidateFiles.length === 0) {
      cleanupFailureMutation = 'none';
      const cleanupOutcome = await cleanupWithIdentityRecheck(startingHead);
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
      const sourceError = await validateSourceCommitMessages(targetGit, currentBranch, sourceCommit);
      if (sourceError) return integrationFailure('INVALID_COMMIT_MESSAGE', sourceError);
    }

    let finalHead: string;
    let conflicts: string[] = [];
    let createdCommitMessage: string | undefined;
    if (strategy === 'squash') {
      await targetGit.raw(['merge', '--squash', sourceCommit]);
      await targetGit.commit(commitMessage!);
      finalHead = (await targetGit.revparse(['HEAD'])).trim();
      if (finalHead === startingHead) throw new Error('Failed to create squash commit');
      try {
        createdCommitMessage = await readCommitMessage(targetGit, finalHead);
      } catch (error) {
        verificationFailure = true;
        throw error;
      }
    } else if (strategy === 'rebase') {
      const output = (await targetGit.raw(['rev-list', '--reverse', `${currentBranch}..${sourceCommit}`])).trim();
      for (const hash of output ? output.split('\n').filter(Boolean) : []) {
        await targetGit.raw(['cherry-pick', hash]);
        try {
          await readCommitMessage(targetGit, (await targetGit.revparse(['HEAD'])).trim());
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
      try {
        createdCommitMessage = await readCommitMessage(targetGit, finalHead);
      } catch (error) {
        verificationFailure = true;
        throw error;
      }
      conflicts = result.conflicts?.map((conflict) => conflict.file || String(conflict)) || [];
    }

    if (finalHead === startingHead) {
      cleanupFailureMutation = 'none';
      const cleanupOutcome = await cleanupWithIdentityRecheck(startingHead);
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
    const cleanupOutcome = await cleanupWithIdentityRecheck(finalHead);
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
      const repoRoot = (await targetGit.raw(['rev-parse', '--show-toplevel']).catch(() => '')).trim();
      const activeStates: string[] = [];
      for (const name of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply']) {
        const statePath = await resolveGitPath(targetGit, repoRoot, name);
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
