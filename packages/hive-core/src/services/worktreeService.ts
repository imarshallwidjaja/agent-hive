import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import simpleGit, { SimpleGit } from "simple-git";
import type { ResolvedRepository, TaskStatus } from "../types.js";
import { acquireLockSync, getFeatureTaskSyncPath, readJson, resolveFeatureDirectoryName } from "../utils/paths.js";
import { projectRootsMatch } from '../utils/repositoryConfig.js';
import { validateStoredTaskStatus } from './taskService.js';
import type {
  TaskWorkspaceManifest as WorkspaceManifest,
  SingleWorkspaceMetadata,
} from './workspaceManifest.js';
import {
  adhocGroupEntryOwner,
  assertCreateConfirmed,
  confirmWorkspaceRecord,
  createUnconfirmedRefusal,
  readCompositeWorkspaceManifest,
  readSingleWorkspaceMetadata,
  readTargetedWorkspaceMetadata,
  readWorkspaceRecordBytes,
  removeEmptyCompositeWorkspaceRoot,
  resolveWorkerTaskStatusPath,
  restoreWorkspaceRecord,
  unresolvedRecordNote,
  writeWorkspaceJsonAtomicSync,
} from './workspaceManifest.js';
import type { AdhocGroupEntryOwner, TargetBinding } from './workspaceManifest.js';
import { parseRetainedCheckoutId, projectRepositories } from './retainedCheckout.js';
import type { RetainedCheckoutContext } from './retainedCheckout.js';
import {
  createTargetedPlacement,
  inspectTargetBinding,
  mergeTargetedPlacement,
  readTargetedPlacement,
  removeTargetedPlacement,
  targetedRepositoryPath,
  targetedTaskBranch,
} from './targetedPlacement.js';
import type { TargetBindingStatus, TargetedPlacement, TargetedPlacementSpec } from './targetedPlacement.js';
import {
  buildCleanupOutcome,
  buildNotRequestedCleanupOutcome,
  buildNotRequestedMergeCleanupBlock,
  buildSkippedCleanupOutcome,
  buildThrownCleanupOutcome,
  CleanupActionError,
  cleanupFacts,
  cleanupStepDone,
  createBranchExclusively,
  deleteBranchStep,
  classifyThrownWorktreeError,
  classifyWorktreeOutcome,
  combineRepoCleanupOutcomes,
  isMutationOutcomeKnown,
  isRetryableWithMutation,
  pruneWorktreesStep,
  readBranchOid,
  removeUnconfirmedWorktreeStep,
  unconfirmedCompositeRetention,
  retainedMarkerFinalization,
  rollbackFailedCreate,
  withFinalizationFailure,
  WorktreeOperationFinalizationError,
  WorktreeOperationRecoveryRequiredError,
  WorktreeTopologyMismatchError,
  WorktreeLinkageError,
  toMergeCleanupBlock,
} from './worktreeOutcome.js';
import {
  trustedGitCommonDirectory,
  withWorktreeMutation,
  withWorktreeRead,
  worktreeOperationLocalPaths,
} from './worktreeOperation.js';
import type { PendingWorktreeOperation, WorktreeMutationGuard, WorktreeOperationKind } from './worktreeOperation.js';
import { assertNoSymlinkComponents, validateExactWorktreeRegistration } from './worktreeLinkage.js';
import {
  inspectWorktreeTarget,
  readWorktreeTargetIdentity,
  sameWorktreeTarget,
  validateTargetExpectations,
} from './worktreeTarget.js';
import type { WorktreeTargetComparison, WorktreeTargetIdentity } from './worktreeTarget.js';
import {
  completedIntegration,
  integrateWorktreeRepository,
  inspectTargetMergeEligibility,
  integrationFailure,
  integrationMessageFailure,
  mergeSuccessClassification,
  prepareBranchDeletion,
  proveCleanupEligibility,
  readValidatedCommitMessage,
  rebasePreserveConflictsFailure,
  resolveIntegrationPolicy,
} from './worktreeIntegration.js';
import type {
  HistoryIntent,
  IntegrationPolicy,
  IntegrationStrategy,
  TargetMergeCandidates,
} from './worktreeIntegration.js';
import type {
  CleanupStepOutcome,
  WorktreeCleanupOutcome,
  WorktreeFinalizationFailure,
  WorktreeMutationState,
  WorktreeOperationPhase,
  WorktreeReasonCode,
  WorktreeRecoveryAction,
  WorktreeMergeCleanupBlock,
  WorktreeRepositoryMergeResult,
} from './worktreeOutcome.js';

export type WorktreeMode = 'legacy' | 'composite' | 'targeted';

export interface WorktreeRepoInfo {
  path: string;
  branch: string;
  commit: string;
  clean?: boolean;
  target?: WorktreeTargetIdentity | null;
  comparison?: WorktreeTargetComparison;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  feature: string;
  step: string;
  mode?: WorktreeMode;
  workspacePath?: string;
  repos?: Record<string, WorktreeRepoInfo>;
  baseCommits?: Record<string, string>;
  baseCommit?: string;
  clean?: boolean;
  candidate?: string;
  /** Targeted tasks: the repository the single worktree belongs to. */
  repoId?: string;
  /** Targeted tasks: the retained checkout frozen as the integration target; inspection adds how the live checkout relates to it. */
  targetBinding?: TargetBinding & { status?: TargetBindingStatus; detail?: string };
  target?: WorktreeTargetIdentity | null;
  comparison?: WorktreeTargetComparison;
  /** Interrupted operations or pre-native lock files guarding this workspace or its repositories; inspection only. */
  pendingOperations?: PendingWorktreeOperation[];
  /**
   * The workspace record still holds `createUnconfirmed`: the create that wrote it never confirmed the checkout as
   * Hive's, so it may be another Git client's. Merge refuses it (`CREATE_UNCONFIRMED`); cleanup still applies.
   */
  createUnconfirmed?: true;
  /** Create only: the worktree was created, but clearing its pending markers or releasing its locks then failed. */
  finalization?: WorktreeFinalizationFailure;
}

export interface WorktreeListError {
  path: string;
  reason: string;
}

/** Added to an error that ended a bulk task cleanup after it had removed some workspaces. */
export interface BulkCleanupFailure {
  removedBeforeFailure: string[];
}

export interface WorktreeListResult {
  worktrees: WorktreeInfo[];
  errors: WorktreeListError[];
}

export interface DiffResult {
  hasDiff: boolean;
  diffContent: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  /** Per-repo diff details when the workspace is a composite. Omitted for legacy single-root workspaces. */
  repos?: Record<string, RepoDiffResult>;
}

export interface RepoDiffResult {
  hasDiff: boolean;
  diffContent: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

export interface ApplyResult {
  success: boolean;
  error?: string;
  filesAffected: string[];
}

export interface MergeOptions {
  /** Required declaration of source history handling; there is no default. */
  historyIntent: HistoryIntent;
  preserveConflicts?: boolean;
  cleanup?: 'none' | 'worktree' | 'worktree+branch';
  /** Exact source commits to integrate. A moved source is rejected before mutation. */
  sourceCommit?: string;
  sourceCommits?: Record<string, string>;
  expectedTarget?: WorktreeTargetIdentity;
  expectedTargets?: Record<string, WorktreeTargetIdentity>;
}

export interface MergeResult {
  success: boolean;
  merged: boolean;
  /** The resolved strategy; omitted when intent/strategy validation failed before one was resolved. */
  strategy?: IntegrationStrategy;
  sha?: string;
  commitMessage?: string;
  reason?: string;
  reasonCode?: WorktreeReasonCode;
  cleanupEligible?: boolean;
  taskUpdateRecommended?: boolean;
  filesChanged: string[];
  conflicts: string[];
  conflictState: 'none' | 'aborted' | 'preserved';
  cleanup: MergeCleanupBlock;
  error?: string;
  /** Per-repo merge results when the workspace is a composite. Omitted for legacy single-root workspaces. */
  repos?: Record<string, RepoMergeResult>;
  /**
   * True when at least one repo merged successfully and a later repo failed (conflict or mutation error).
   * Explicit `false` when preflight rejected the merge before any repo was mutated.
   * Undefined for legacy single-root merges and for clean composite success.
   */
  partial?: boolean;
  phase: WorktreeOperationPhase;
  mutation: WorktreeMutationState;
  retryable: boolean;
  action: WorktreeRecoveryAction;
  expectedTarget?: WorktreeTargetIdentity;
  observedTarget?: WorktreeTargetIdentity | null;
  /** Present when the merge returned this result but clearing its pending markers or releasing its locks then failed. */
  finalization?: WorktreeFinalizationFailure;
}

/** Merge-result cleanup block: per-step truth plus the legacy factual booleans. */
export interface MergeCleanupBlock extends WorktreeMergeCleanupBlock {}

export interface RepoMergeResult extends WorktreeRepositoryMergeResult {
  taskUpdateRecommended?: boolean;
  operationStatus?: 'success' | 'failed' | 'not_attempted';
}

export interface RepositoryResolver {
  resolveRepositories(): ResolvedRepository[];
}

export interface TaskRepoResolver {
  resolveTaskRepoIds(feature: string, step: string): string[] | undefined;
}

export interface WorktreeConfig {
  baseDir: string;
  hiveDir: string;
  /** Optional repository manifest resolver. When provided together with a task that has repoIds, composite workspaces are created. */
  repositoryResolver?: RepositoryResolver | (() => ResolvedRepository[]);
  /** Optional task-to-repoIds resolver. Defaults to reading from .hive/features/.../status.json when omitted. */
  taskRepoResolver?: TaskRepoResolver | ((feature: string, step: string) => string[] | undefined);
}

export interface WorktreeRemoveOptions {
  /** Explicitly discard an unintegrated branch. Never implied by normal cleanup. */
  discard?: boolean;
}

function mergeFailure(
  strategy: IntegrationStrategy | undefined,
  reasonCode: WorktreeReasonCode,
  error: string,
  options: {
    mutation?: WorktreeMutationState;
    conflicts?: string[];
    conflictState?: 'none' | 'aborted' | 'preserved';
    filesChanged?: string[];
    repos?: Record<string, RepoMergeResult>;
    partial?: boolean;
    expectedTarget?: WorktreeTargetIdentity;
    observedTarget?: WorktreeTargetIdentity | null;
  } = {},
): MergeResult {
  const classification = classifyWorktreeOutcome(reasonCode, options.mutation);
  return {
    success: false,
    merged: false,
    ...(strategy !== undefined ? { strategy } : {}),
    filesChanged: options.filesChanged ?? [],
    conflicts: options.conflicts ?? [],
    conflictState: options.conflictState ?? 'none',
    cleanup: buildNotRequestedMergeCleanupBlock(),
    error,
    ...(options.repos !== undefined ? { repos: options.repos } : {}),
    ...(options.partial !== undefined ? { partial: options.partial } : {}),
    phase: classification.phase,
    reasonCode,
    mutation: classification.mutation,
    retryable: classification.retryable,
    action: classification.action,
    ...(options.expectedTarget !== undefined ? { expectedTarget: options.expectedTarget } : {}),
    ...(options.observedTarget !== undefined ? { observedTarget: options.observedTarget } : {}),
  };
}

/** Project a cleanup outcome onto the legacy factual booleans. */
function mergeCleanupResult(outcome: WorktreeCleanupOutcome): {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  pruned: boolean;
  cleanup: WorktreeCleanupOutcome;
} {
  return {
    ...cleanupFacts(outcome),
    cleanup: outcome,
  };
}

interface RepositorySelection {
  /** Trusted repository paths the operation may touch; their common directories are locked. */
  repositoryPaths: string[];
}

interface WorkspaceRepositorySelection extends RepositorySelection {
  manifest: WorkspaceManifest | null;
  /** Whether the workspace is a targeted worker; its placement is reread by the operation. */
  targeted: boolean;
}

interface CreateRepositorySelection extends RepositorySelection {
  composite: { repos: ResolvedRepository[]; repoIds: string[] } | null;
  /** The task record the selection was made from, which the placement claim must still find; null only for an injected resolver's task. */
  record: TaskStatus | null;
  /** The status file that record was read from; the placement claim locks and rereads this file, never another layout's. */
  statusPath: string;
}

/** Whether two reads of a task record agree on what chooses its worker's placement: existence, repositories and target. */
function samePlacementRecord(a: TaskStatus | null, b: TaskStatus | null): boolean {
  if (a === null || b === null) return a === b;
  return a.target === b.target && JSON.stringify(a.repoIds ?? null) === JSON.stringify(b.repoIds ?? null);
}

export class WorktreeService {
  private config: WorktreeConfig;

  constructor(config: WorktreeConfig) {
    this.config = config;
  }

  private getGit(cwd?: string): SimpleGit {
    return simpleGit(cwd || this.config.baseDir);
  }

  /**
   * Lock order and selection rechecks are owned by `worktreeOperation.ts`: the
   * workspace lock first when the operation addresses one workspace, then each
   * selected repository's Git common directory, sorted. Global cleanup passes no
   * workspace and holds every repository lock.
   */
  private readWorkspace<S extends RepositorySelection, T>(
    workspacePath: string,
    select: () => Promise<S>,
    read: (selection: S, pending: PendingWorktreeOperation[]) => Promise<T>,
  ): Promise<T> {
    return withWorktreeRead({ hiveDir: this.config.hiveDir, workspacePath, select, commonDirectory: (repositoryPath) => this.trustedGitCommonDirectory(repositoryPath), trustedRepositoryPaths: () => this.trustedRepositoryPaths() }, read);
  }

  /** The project root and every manifest repository: the paths a pending operation record may name. */
  private trustedRepositoryPaths(): string[] {
    return [this.config.baseDir, ...(this.resolveRepositories() ?? []).map((repository) => repository.path)];
  }

  /**
   * Run a mutation under the operation guard. A result whose marker clearing
   * or lock release failed afterwards is returned with `finalization` rather
   * than lost to that failure.
   */
  private mutate<S extends RepositorySelection, T extends object>(
    kind: WorktreeOperationKind,
    workspace: { feature: string; step: string; attemptSlot?: string } | { project: true; feature?: string },
    select: () => Promise<S>,
    operation: (selection: S, guard: WorktreeMutationGuard) => Promise<T>,
    outcomeKnown?: (result: T) => boolean,
  ): Promise<T> {
    const isProject = 'project' in workspace;
    return withWorktreeMutation({
      hiveDir: this.config.hiveDir,
      workspacePath: isProject ? null : this.getWorktreePath(workspace.feature, workspace.step, workspace.attemptSlot),
      select,
      commonDirectory: (repositoryPath) => this.trustedGitCommonDirectory(repositoryPath),
      trustedRepositoryPaths: () => this.trustedRepositoryPaths(),
      kind,
      subject: isProject
        ? { type: 'project', ...(workspace.feature !== undefined ? { feature: workspace.feature } : {}) }
        : { type: 'task', feature: workspace.feature, task: workspace.step, ...(workspace.attemptSlot !== undefined ? { candidate: workspace.attemptSlot } : {}) },
    }, operation, outcomeKnown).catch((error: unknown) => {
      if (error instanceof WorktreeOperationFinalizationError) return withFinalizationFailure(error.result as T, error.finalization);
      throw error;
    });
  }

  /** The repositories an operation on this task workspace touches: its persisted composite selection, or the single root. */
  private async selectWorkspaceRepositories(feature: string, step: string, attemptSlot?: string): Promise<WorkspaceRepositorySelection> {
    const targetedPath = await targetedRepositoryPath(this.checkoutContext(), this.targetedSpec(feature, step, attemptSlot));
    if (targetedPath !== null) return { manifest: null, targeted: true, repositoryPaths: [targetedPath] };
    const manifest = await this.readWorkspaceManifest(feature, step, attemptSlot);
    return {
      manifest,
      targeted: false,
      repositoryPaths: this.workspaceRepositoryPaths(manifest, this.getWorktreePath(feature, step, attemptSlot)),
    };
  }

  private checkoutContext(): RetainedCheckoutContext {
    return { hiveDir: this.config.hiveDir, repositories: projectRepositories(this.config.baseDir, this.resolveRepositories()) };
  }

  private targetedSpec(feature: string, step: string, attemptSlot?: string): TargetedPlacementSpec {
    return {
      mode: 'targeted',
      worktreePath: this.getWorktreePath(feature, step, attemptSlot),
      metadataPath: this.getSingleMetadataPath(feature, step, attemptSlot),
      branch: targetedTaskBranch(feature, this.worktreeBranchStep(step, attemptSlot)),
      owner: { feature, task: step, ...(attemptSlot !== undefined ? { candidate: attemptSlot } : {}) },
      untargeted: { repositoryPath: this.config.baseDir, branch: this.getLegacyBranchName(feature, step, attemptSlot) },
    };
  }

  private targetedInfo(feature: string, step: string, placement: TargetedPlacement, commit: string, attemptSlot?: string): WorktreeInfo {
    const { metadata } = placement;
    return {
      path: metadata.worktreePath,
      branch: metadata.branch,
      commit,
      feature,
      step,
      mode: 'targeted',
      baseCommit: metadata.baseCommit,
      repoId: metadata.repoId,
      targetBinding: { ...metadata.target },
      ...(attemptSlot !== undefined ? { candidate: attemptSlot } : {}),
      ...(metadata.createUnconfirmed === true ? { createUnconfirmed: true as const } : {}),
    };
  }

  private async readTargetedTask(feature: string, step: string, attemptSlot?: string): Promise<{ placement: TargetedPlacement; info: WorktreeInfo | null } | null> {
    const placement = await readTargetedPlacement(this.checkoutContext(), this.targetedSpec(feature, step, attemptSlot));
    if (!placement) return null;
    if (!placement.present) return { placement, info: null };
    const commit = (await this.getGit(placement.metadata.worktreePath).revparse(['HEAD'])).trim();
    return { placement, info: this.targetedInfo(feature, step, placement, commit, attemptSlot) };
  }

  /**
   * The retained checkout a task's status declares as its integration target; null when the status is missing or
   * names none. A status that exists but cannot be read, or names a malformed target, is refused: it may be the
   * record of a targeted task, so no untargeted path may stand in for it.
   */
  private async readTaskTarget(feature: string, step: string): Promise<{ target: string; repoIds?: string[]; statusPath: string } | null> {
    const statusPath = await this.getStepStatusPath(feature, step);
    const status = this.readTaskRecord(feature, step, statusPath);
    return status?.target !== undefined ? { target: status.target, ...(status.repoIds ? { repoIds: status.repoIds } : {}), statusPath } : null;
  }

  /** A task's validated status, null when it has none; a status that cannot be read or names a malformed target is refused. */
  private readTaskRecord(feature: string, step: string, statusPath: string): TaskStatus | null {
    try {
      const status = readJson<TaskStatus>(statusPath);
      if (status === null) return null;
      validateStoredTaskStatus(status, step);
      if (status.target !== undefined) parseRetainedCheckoutId(status.target);
      return status;
    } catch (error) {
      throw new Error(`Task ${feature}/${step} has no readable task status at ${statusPath}: ${(error as Error).message}`);
    }
  }

  /**
   * Publish a task worker's first placement record (its sidecar or composite workspace root) under the feature's
   * task-sync lock and then the task's status lock, the order task sync takes them. Task sync and manual task creation
   * hold the task-sync lock while they create, remove or retarget task folders in either layout's place, and sync
   * refuses each of those while a placement for the task exists. `admit` receives the task record read under both
   * locks and throws when it no longer selects the placement this create chose; `publish` then writes the record,
   * which sync's placement check finds. The whole claim is synchronous, so neither lock is held across an await, and
   * no Git runs under them. Worker creation reads the task record but never writes it.
   *
   * `statusPath` is the status file the selection read. The claim locks and rereads that file and refuses when the
   * task's status now resolves to another file: with both a modern and a legacy record present, removing the modern
   * one must not let the legacy record stand in for the task the selection saw, and a modern record created beside a
   * legacy one must not hide the record a worker was placed from.
   *
   * A feature without a directory takes no lock, because locking would create it as a ghost feature; no sync or task
   * creation runs for a feature that does not resolve. A task without a folder takes no status lock, because locking a
   * status creates its directory and would leave a removed task's folder behind as an empty record; while the
   * task-sync lock is held no sync can create that folder. When the claim refuses a record removed by hand after that
   * check, the empty folder the status lock recreated is removed again.
   */
  private async publishTaskPlacement(feature: string, step: string, statusPath: string, admit: (record: TaskStatus | null) => void, publish: () => void): Promise<void> {
    const admitAt = (record: TaskStatus | null) => {
      const current = this.stepStatusPath(feature, step);
      if (current !== statusPath) {
        throw new WorktreeTopologyMismatchError(`Task ${feature}/${step} status now resolves to ${current}, not ${statusPath} that its worker's placement was selected from; inspect the task and create its worker again`);
      }
      admit(record);
    };
    const featureDirectory = this.featureDirectory(feature);
    if (!fsSync.existsSync(featureDirectory)) {
      admitAt(null);
      publish();
      return;
    }
    const releaseTaskSync = acquireLockSync(getFeatureTaskSyncPath(featureDirectory), { staleLockTTL: Number.POSITIVE_INFINITY });
    try {
      const taskDirectory = path.dirname(statusPath);
      if (!fsSync.existsSync(taskDirectory)) {
        admitAt(null);
        publish();
        return;
      }
      const release = acquireLockSync(statusPath, { staleLockTTL: Number.POSITIVE_INFINITY });
      try {
        const record = this.readTaskRecord(feature, step, statusPath);
        try {
          admitAt(record);
        } catch (error) {
          if (record === null) {
            try {
              fsSync.rmdirSync(taskDirectory);
            } catch {
              // Not empty or already gone: it is not the folder the lock recreated.
            }
          }
          throw error;
        }
        publish();
      } finally {
        release();
      }
    } finally {
      releaseTaskSync();
    }
  }

  /** Publish an untargeted worker's placement record while its task record still matches the one its repositories were selected from. */
  private publishUntargetedPlacement(feature: string, step: string, selected: TaskStatus | null, statusPath: string, publish: () => void): Promise<void> {
    return this.publishTaskPlacement(feature, step, statusPath, (record) => {
      if (samePlacementRecord(selected, record)) return;
      const change = record === null
        ? 'no longer has a task record'
        : selected === null
          ? 'now has a task record'
          : `now declares ${record.target !== undefined ? `target ${record.target}` : `repositories ${record.repoIds?.join(', ') ?? '(project root)'}`}`;
      throw new WorktreeTopologyMismatchError(`Task ${feature}/${step} ${change}, so the worker placement selected before is not published; inspect the task and create its worker again`);
    }, publish);
  }

  /** Refuse a targeted worker whose task status no longer names the retained checkout it is bound to. */
  private async assertTaskTargetMatches(feature: string, step: string, placement: TargetedPlacement | null): Promise<void> {
    const declared = (await this.readTaskTarget(feature, step))?.target ?? null;
    const bound = placement?.metadata.target.id ?? null;
    if (declared !== bound) {
      throw new WorktreeTopologyMismatchError(
        `Task ${feature}/${step} declares target ${declared ?? '(none)'}, but its worker ${bound === null ? 'has no targeted metadata' : `is bound to ${bound}`}`,
      );
    }
  }

  private async createTargeted(feature: string, step: string, target: { target: string; repoIds?: string[]; statusPath: string }, baseRef: string | undefined, attemptSlot?: string): Promise<WorktreeInfo> {
    const { repoId } = parseRetainedCheckoutId(target.target);
    if (target.repoIds && (target.repoIds.length !== 1 || target.repoIds[0] !== repoId)) {
      throw new WorktreeTopologyMismatchError(`Task ${step} targets ${target.target}, so its Repos must be omitted or exactly ${repoId}`);
    }
    const select = async (): Promise<RepositorySelection> => {
      const repository = this.checkoutContext().repositories.find((candidate) => candidate.id === repoId);
      if (!repository) throw new WorktreeTopologyMismatchError(`Task ${step} targets ${target.target}, whose repository ${repoId} this project does not configure`);
      return { repositoryPaths: [repository.path] };
    };
    // The binding is published under the task's status lock once the status still declares the target read before.
    const bind = (publish: () => void) => this.publishTaskPlacement(feature, step, target.statusPath, (record) => {
      const declared = record?.target ?? null;
      if (declared !== target.target) {
        throw new WorktreeTopologyMismatchError(`Task ${feature}/${step} now declares target ${declared ?? '(none)'}, not ${target.target}; inspect the task and create its worker again`);
      }
    }, publish);
    return this.mutate('create', { feature, step, attemptSlot }, select, async (_selection, guard) => {
      const created = await createTargetedPlacement(guard, this.checkoutContext(), this.targetedSpec(feature, step, attemptSlot), target.target, baseRef, bind);
      return this.targetedInfo(feature, step, created, created.commit, attemptSlot);
    });
  }

  /** Read-only: skips the optional index refresh so inspection takes no index.lock. */
  private async isCompletelyClean(git: SimpleGit): Promise<boolean> {
    return (await git.raw(['--no-optional-locks', 'status', '--porcelain=v1', '--ignored'])).trim() === '';
  }

  private async isGitClean(git: SimpleGit): Promise<boolean> {
    return (await git.raw(['status', '--porcelain=v1'])).trim() === '';
  }

  private async trustedGitCommonDirectory(repositoryPath: string): Promise<string> {
    return trustedGitCommonDirectory(repositoryPath, this.getGit(repositoryPath));
  }

  private async validateExactWorktreeRegistration(
    worktreePath: string,
    trustedRepositoryPath: string,
    repositoryId: string,
  ): Promise<void> {
    await validateExactWorktreeRegistration(worktreePath, () => this.trustedGitCommonDirectory(trustedRepositoryPath), repositoryId);
  }

  private async validateWorktreeBranch(worktreePath: string, branch: string, repositoryId: string): Promise<void> {
    const currentBranch = (await this.getGit(worktreePath).revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (currentBranch !== branch) {
      throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repositoryId}: current branch does not match the registered branch`);
    }
  }

  /** The trusted repositories a workspace manifest selects, keyed by repository ID; only validated manifest entries. */
  private trustedRepositoriesForManifest(manifest: WorkspaceManifest): Map<string, ResolvedRepository> {
    const trustedRepositories = this.resolveRepositories();
    if (!trustedRepositories?.length) {
      throw new WorktreeLinkageError('Worktree linkage preflight failed: trusted repository topology is unavailable');
    }
    const trustedById = new Map(trustedRepositories.map(repository => [repository.id, repository]));
    const selected = new Map<string, ResolvedRepository>();
    for (const [id, entry] of Object.entries(manifest.repos)) {
      const trusted = trustedById.get(id);
      if (!trusted
        || entry.repoRoot !== trusted.root
        || path.resolve(entry.repoPath) !== path.resolve(trusted.path)
        || entry.path !== path.posix.join('repos', id)) {
        throw new WorktreeTopologyMismatchError(`Worktree linkage preflight failed for repository ${id}: workspace topology does not match the trusted repository manifest`);
      }
      selected.set(id, trusted);
    }
    return selected;
  }

  private workspaceRepositoryPaths(manifest: WorkspaceManifest | null, workspacePath: string): string[] {
    if (manifest) return [...this.trustedRepositoriesForManifest(manifest).values()].map(repository => repository.path);
    const repositories = this.resolveRepositories();
    if (repositories?.length && !repositories.some(repository => projectRootsMatch(repository.path, this.config.baseDir))) {
      throw new WorktreeLinkageError(`Composite workspace manifest not found at ${path.join(workspacePath, 'workspace.json')}. Select an existing task and candidate; manifest-backed workspaces require persisted repository placement.`);
    }
    return [this.config.baseDir];
  }

  private getWorktreesDir(): string {
    return path.join(this.config.hiveDir, ".worktrees");
  }

  /**
   * Who owns an entry of `.hive/.worktrees/<feature>/`. Only the `adhoc` group is shared, with ad-hoc runs; task listing
   * and cleanup act on an entry there only when `adhocGroupEntryOwner` shows it is a task's.
   */
  private async groupEntryOwner(feature: string, entry: string): Promise<AdhocGroupEntryOwner> {
    return feature === 'adhoc' ? adhocGroupEntryOwner(this.config.baseDir, this.config.hiveDir, entry) : { owner: 'task' };
  }

  private normalizeAttemptSlot(attemptSlot?: string): string | undefined {
    if (attemptSlot === undefined) return undefined;
    if (!attemptSlot.trim() || attemptSlot !== attemptSlot.trim()
      || attemptSlot.includes('--') || attemptSlot.includes('/') || attemptSlot.includes('\\')
      || attemptSlot.includes('\0') || attemptSlot.includes('..')
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(attemptSlot)) {
      throw new Error(`Invalid worktree candidate: ${JSON.stringify(attemptSlot)}`);
    }
    return attemptSlot;
  }

  private worktreeDirectoryName(step: string, attemptSlot?: string): string {
    const slot = this.normalizeAttemptSlot(attemptSlot);
    return slot ? `${step}--${slot}` : step;
  }

  private worktreeBranchStep(step: string, attemptSlot?: string): string {
    const slot = this.normalizeAttemptSlot(attemptSlot);
    return slot ? `${step}-${slot}` : step;
  }

  private parseWorktreeStepDirectory(directoryName: string): { step: string; attemptSlot?: string } {
    const separator = directoryName.lastIndexOf('--');
    if (separator <= 0 || separator + 2 >= directoryName.length) return { step: directoryName };
    return {
      step: directoryName.slice(0, separator),
      attemptSlot: directoryName.slice(separator + 2),
    };
  }

  /** Legacy single-repo worktree path. Optional attemptSlot uses `{step}--{slot}`. */
  getWorktreePath(feature: string, step: string, attemptSlot?: string): string {
    return path.join(this.getWorktreesDir(), feature, this.worktreeDirectoryName(step, attemptSlot));
  }

  /** Composite workspace root for a (feature, task). Shares disk location with legacy path. */
  private getCompositeRoot(feature: string, step: string, attemptSlot?: string): string {
    return path.join(this.getWorktreesDir(), feature, this.worktreeDirectoryName(step, attemptSlot));
  }

  private getRepoWorktreePath(feature: string, step: string, repoId: string, attemptSlot?: string): string {
    return path.join(this.getCompositeRoot(feature, step, attemptSlot), 'repos', repoId);
  }

  private getWorkspaceManifestPath(feature: string, step: string, attemptSlot?: string): string {
    return path.join(this.getCompositeRoot(feature, step, attemptSlot), 'workspace.json');
  }

  private getSingleMetadataPath(feature: string, step: string, attemptSlot?: string): string {
    return `${this.getWorktreePath(feature, step, attemptSlot)}.json`;
  }

  private async getStepStatusPath(feature: string, step: string): Promise<string> {
    return this.stepStatusPath(feature, step);
  }

  /** The status file a task's record resolves to now: the modern record, else an existing legacy one. */
  private stepStatusPath(feature: string, step: string): string {
    return resolveWorkerTaskStatusPath(this.featureDirectory(feature), step);
  }

  private featureDirectory(feature: string): string {
    return path.join(this.config.hiveDir, "features", resolveFeatureDirectoryName(this.config.baseDir, feature));
  }

  private getLegacyBranchName(feature: string, step: string, attemptSlot?: string): string {
    return `hive/${feature}/${this.worktreeBranchStep(step, attemptSlot)}`;
  }

  private getRepoBranchName(repoId: string, feature: string, step: string, attemptSlot?: string): string {
    return `hive/${repoId}/${feature}/${this.worktreeBranchStep(step, attemptSlot)}`;
  }

  /** Back-compat alias used by tests/consumers expecting the single-branch form. */
  private getBranchName(feature: string, step: string, attemptSlot?: string): string {
    return this.getLegacyBranchName(feature, step, attemptSlot);
  }

  private resolveRepositories(): ResolvedRepository[] | undefined {
    const r = this.config.repositoryResolver;
    if (!r) return undefined;
    if (typeof r === 'function') return r();
    return r.resolveRepositories();
  }

  private async resolveTaskRepoIds(feature: string, step: string): Promise<string[] | undefined> {
    const r = this.config.taskRepoResolver;
    if (r) {
      if (typeof r === 'function') return r(feature, step);
      return r.resolveTaskRepoIds(feature, step);
    }
    // Default: async read from task status.json if available
    return this.readTaskRepoIdsFromStatus(feature, step);
  }

  private async readTaskRepoIdsFromStatus(feature: string, step: string): Promise<string[] | undefined> {
    const featureDir = resolveFeatureDirectoryName(this.config.baseDir, feature);
    const featurePath = path.join(this.config.hiveDir, "features", featureDir);
    const candidates = [
      path.join(featurePath, "tasks", step, "status.json"),
      path.join(featurePath, "execution", step, "status.json"),
    ];
    for (const p of candidates) {
      let raw: string;
      try {
        raw = await fs.readFile(p, 'utf-8');
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err && err.code === 'ENOENT') continue;
        throw new Error(`Failed to read task status at ${p}: ${(e as Error).message}`);
      }
      const parsed = JSON.parse(raw) as TaskStatus;
      return parsed.repoIds;
    }
    return undefined;
  }

  /** Resolve composite task inputs when a repository manifest is active. */
  private async isCompositeTask(feature: string, step: string): Promise<{ repos: ResolvedRepository[]; repoIds: string[] } | null> {
    const repos = this.resolveRepositories();
    if (!repos || repos.length === 0) return null;
    const repoIds = await this.resolveTaskRepoIds(feature, step);
    if (!repoIds || repoIds.length === 0) {
      throw new Error(`Task ${step} must declare Repos before creating a manifest-backed worktree`);
    }
    return { repos, repoIds };
  }

  async create(feature: string, step: string, baseBranch?: string, attemptSlot?: string): Promise<WorktreeInfo> {
    const target = await this.readTaskTarget(feature, step);
    if (target) return this.createTargeted(feature, step, target, baseBranch, attemptSlot);
    const bound = await readTargetedPlacement(this.checkoutContext(), this.targetedSpec(feature, step, attemptSlot));
    if (bound) await this.assertTaskTargetMatches(feature, step, bound);
    const composite = await this.isCompositeTask(feature, step);
    if (!composite) {
      const statusPath = await this.getStepStatusPath(feature, step);
      try {
        validateStoredTaskStatus(readJson<TaskStatus>(statusPath), step);
      } catch (error) {
        throw new Error(`Task ${feature}/${step} has no readable task status at ${statusPath}: ${(error as Error).message}`);
      }
    }
    const targetPath = composite
      ? this.getCompositeRoot(feature, step, attemptSlot)
      : this.getWorktreePath(feature, step, attemptSlot);
    await assertNoSymlinkComponents(path.parse(targetPath).root, targetPath, true);
    const existingManifest = composite ? await this.readWorkspaceManifest(feature, step, attemptSlot) : null;
    if (existingManifest) {
      assertCreateConfirmed(existingManifest, targetPath, this.getWorkspaceManifestPath(feature, step, attemptSlot), 'hive_worktree_cleanup');
      await this.get(feature, step, attemptSlot);
    }
    return this.mutate(
      'create',
      { feature, step, attemptSlot },
      () => this.selectCreateRepositories(feature, step, attemptSlot),
      ({ composite: selected, record, statusPath }, guard) => selected
        ? this.createComposite(guard, feature, step, selected.repos, selected.repoIds, record, statusPath, baseBranch, attemptSlot)
        : this.createLegacy(guard, feature, step, record!, statusPath, baseBranch, attemptSlot),
    );
  }

  /**
   * The repositories task worktree creation touches: an existing workspace's persisted selection, else the task's
   * declared repositories, with the task record they were chosen from. The record is read on both sides of the
   * repository resolution, so the one returned is the one the resolver saw. Only a composite task whose repositories an
   * injected `taskRepoResolver` supplies may have no record; the plugin's resolver reads the record.
   */
  private async selectCreateRepositories(feature: string, step: string, attemptSlot?: string): Promise<CreateRepositorySelection> {
    const statusPath = await this.getStepStatusPath(feature, step);
    const record = this.readTaskRecord(feature, step, statusPath);
    const composite = await this.isCompositeTask(feature, step);
    // The resolver resolves the status path itself; it must have seen the same file, in the same state, as the reads around it.
    if (this.stepStatusPath(feature, step) !== statusPath || !samePlacementRecord(record, this.readTaskRecord(feature, step, statusPath))) {
      throw new WorktreeTopologyMismatchError(`Task ${feature}/${step} changed while its worker's repositories were selected; inspect the task and create its worker again`);
    }
    if (record?.target !== undefined) {
      throw new WorktreeTopologyMismatchError(`Task ${feature}/${step} now declares target ${record.target}; inspect the task and create its worker again`);
    }
    if (!composite) {
      if (record === null) throw new Error(`Task ${feature}/${step} has no readable task status at ${statusPath}: the file does not exist`);
      return { composite, record, statusPath, repositoryPaths: [this.config.baseDir] };
    }
    const manifest = await this.readWorkspaceManifest(feature, step, attemptSlot);
    if (manifest) {
      return { composite, record, statusPath, repositoryPaths: this.workspaceRepositoryPaths(manifest, this.getCompositeRoot(feature, step, attemptSlot)) };
    }
    const byId = new Map(composite.repos.map(repository => [repository.id, repository]));
    const missing = composite.repoIds.filter(id => !byId.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Repository manifest is missing required repos for task ${feature}/${step}: ${missing.join(', ')}`,
      );
    }
    return { composite, record, statusPath, repositoryPaths: composite.repoIds.map(id => byId.get(id)!.path) };
  }

  private async createLegacy(guard: WorktreeMutationGuard, feature: string, step: string, record: TaskStatus, statusPath: string, baseBranch?: string, attemptSlot?: string): Promise<WorktreeInfo> {
    const worktreePath = this.getWorktreePath(feature, step, attemptSlot);
    await assertNoSymlinkComponents(path.parse(worktreePath).root, worktreePath, true);
    const branchName = this.getLegacyBranchName(feature, step, attemptSlot);
    const git = this.getGit();

    const metadataPath = this.getSingleMetadataPath(feature, step, attemptSlot);
    const existing = await this.get(feature, step, attemptSlot);
    if (existing) {
      assertCreateConfirmed(await readSingleWorkspaceMetadata(metadataPath), worktreePath, metadataPath, 'hive_worktree_cleanup');
      return existing;
    }

    const base = baseBranch || (await git.revparse(["HEAD"])).trim();
    // An existing task branch is reattached, never recreated or deleted here: it may hold unmerged work.
    const retainedTip = await readBranchOid(git, branchName);
    const baseCommit = retainedTip === null
      ? null
      : await this.retainedBranchBaseline(git, metadataPath, { feature, step, worktreePath, branchName, retainedTip, base });
    const branch = retainedTip === null
      ? { name: branchName, created: true, tip: (await git.revparse(['--verify', `${base}^{commit}`])).trim() }
      : { name: branchName, created: false, tip: retainedTip };
    await guard.begin({ repositories: [{ repositoryPath: this.config.baseDir, sourceWorktreePath: worktreePath, sourceBranch: branchName }] });
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    const metadata: SingleWorkspaceMetadata = {
      schemaVersion: 1,
      mode: 'single',
      feature,
      task: step,
      worktreePath,
      repositoryPath: this.config.baseDir,
      branch: branchName,
      baseCommit: baseCommit ?? branch.tip,
    };
    // The record is published unconfirmed before any Git effect and confirmed only once this create's own add is
    // validated, so a checkout it cannot show it attached stays unconfirmed after its markers are acknowledged. A
    // complete rollback puts back the record the create found, such as a retained branch's baseline.
    const priorMetadata = await readWorkspaceRecordBytes(metadataPath);
    // Rollback removes only what this create made; anything it cannot undo keeps the operation's markers.
    let attached = false;
    const rollBack = async (cause: unknown): Promise<Error> => {
      const leftovers = await rollbackFailedCreate(git, worktreePath, branch, attached);
      if (leftovers.length === 0 && !(await restoreWorkspaceRecord(metadataPath, priorMetadata))) leftovers.push(`workspace metadata ${metadataPath}`);
      if (leftovers.length === 0) guard.markOutcomeKnown();
      const message = `Failed to create worktree: ${(cause as Error).message}`;
      return new Error(leftovers.length === 0 ? message : `${message}; rollback left ${leftovers.join(', ')}${unresolvedRecordNote(cause)}`, { cause });
    };

    try {
      await this.publishUntargetedPlacement(feature, step, record, statusPath, () => writeWorkspaceJsonAtomicSync(metadataPath, { ...metadata, createUnconfirmed: true }));
    } catch (error) {
      if (await restoreWorkspaceRecord(metadataPath, priorMetadata)) guard.markOutcomeKnown();
      if (error instanceof WorktreeTopologyMismatchError) throw error;
      throw new Error(`Failed to create worktree: ${(error as Error).message}`, { cause: error });
    }
    if (branch.created) {
      const refusal = await createBranchExclusively(git, branchName, branch.tip);
      if (refusal) {
        // No placement exists yet, so the record goes back even when the branch stays.
        const restored = await restoreWorkspaceRecord(metadataPath, priorMetadata);
        if (refusal.kept === null && restored) guard.markOutcomeKnown();
        const kept = [refusal.kept, restored ? null : `rollback left workspace metadata ${metadataPath}`].filter((entry): entry is string => entry !== null);
        throw new Error(`Failed to create worktree: ${refusal.error}${kept.map((entry) => `; ${entry}`).join('')}`);
      }
    }
    try {
      await git.raw(["worktree", "add", "--", worktreePath, branchName]);
      attached = true;
    } catch (addError) {
      throw await rollBack(addError);
    }

    let commit: string;
    try {
      await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'legacy');
      await this.validateWorktreeBranch(worktreePath, branchName, 'legacy');
      commit = (await this.getGit(worktreePath).revparse(["HEAD"])).trim();
      if (commit !== branch.tip) throw new Error(`worktree ${worktreePath} is at ${commit}, not the attached commit ${branch.tip}`);
      await confirmWorkspaceRecord(metadataPath, metadata);
    } catch (error) {
      throw await rollBack(error);
    }

    return {
      path: worktreePath,
      branch: branchName,
      commit,
      feature,
      step,
      mode: 'legacy',
      ...(attemptSlot !== undefined ? { candidate: attemptSlot } : {}),
    };
  }

  /**
   * The diff baseline for reattaching a retained task branch. The metadata a
   * worktree-only removal keeps is reused when it still describes this branch
   * and its baseline is an ancestor of the retained tip. Without that record,
   * the fork point with the creation base names exactly the branch commits the
   * destination lacks. A record that exists but cannot be trusted refuses the
   * reattachment before any mutation instead of resetting the baseline, and so
   * does one still holding `createUnconfirmed`: the branch it kept may carry
   * another Git client's commits, and reattaching it would confirm them as the
   * task's.
   */
  private async retainedBranchBaseline(
    git: SimpleGit,
    metadataPath: string,
    branch: { feature: string; step: string; worktreePath: string; branchName: string; retainedTip: string; base: string },
  ): Promise<string> {
    const { feature, step, worktreePath, branchName, retainedTip, base } = branch;
    const refuse = (reason: string, cause?: unknown): Error => new Error(
      `Cannot reattach retained task branch ${branchName}: ${reason}. Repair or remove ${metadataPath} to fall back to the fork point with ${base}.`,
      cause === undefined ? undefined : { cause },
    );
    const stat = await fs.lstat(metadataPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw refuse(`its workspace metadata cannot be inspected (${error.message})`, error);
    });
    if (stat && !stat.isFile()) throw refuse('its workspace metadata path is not a regular file');
    let prior: SingleWorkspaceMetadata | null = null;
    if (stat) {
      try {
        prior = await readSingleWorkspaceMetadata(metadataPath);
      } catch (error) {
        throw refuse(`its workspace metadata is unreadable (${(error as Error).message})`, error);
      }
    }
    if (prior?.createUnconfirmed === true) {
      throw new Error(
        `Cannot reattach retained task branch ${branchName}: its workspace metadata ${metadataPath} was left by a create that never confirmed it (createUnconfirmed), `
        + 'so the branch may hold another Git client\'s commits and is not reattached as the task\'s worker. '
        + 'Inspect the branch, then delete it with hive_worktree_cleanup and branch deletion, or remove it yourself, before creating again.',
      );
    }
    if (prior) {
      if (prior.mode !== 'single'
        || prior.feature !== feature
        || prior.task !== step
        || path.resolve(prior.worktreePath) !== path.resolve(worktreePath)
        || !projectRootsMatch(prior.repositoryPath, this.config.baseDir)
        || prior.branch !== branchName) {
        throw refuse('its workspace metadata describes a different workspace');
      }
      let recorded: string;
      try {
        recorded = (await git.revparse(['--verify', `${prior.baseCommit}^{commit}`])).trim();
      } catch (error) {
        throw refuse(`its recorded baseline ${prior.baseCommit} is not a commit`, error);
      }
      const unreachable = (await git.raw(['rev-list', '--count', `${retainedTip}..${recorded}`])).trim();
      if (unreachable !== '0') throw refuse(`its recorded baseline ${recorded} is not an ancestor of the branch tip ${retainedTip}`);
      return recorded;
    }
    const forkPoint = (await git.raw(['merge-base', base, retainedTip]).catch(() => '')).trim();
    if (!forkPoint) throw refuse(`it shares no history with ${base}`);
    return forkPoint;
  }

  private async createComposite(
    guard: WorktreeMutationGuard,
    feature: string,
    step: string,
    repos: ResolvedRepository[],
    repoIds: string[],
    record: TaskStatus | null,
    statusPath: string,
    baseBranch?: string,
    attemptSlot?: string,
  ): Promise<WorktreeInfo> {
    // Existing composite workspace -> return aggregate info
    const manifestPath = this.getWorkspaceManifestPath(feature, step, attemptSlot);
    const existingManifest = await this.readWorkspaceManifest(feature, step, attemptSlot);
    assertCreateConfirmed(existingManifest, this.getCompositeRoot(feature, step, attemptSlot), manifestPath, 'hive_worktree_cleanup');
    const existing = existingManifest ? await this.get(feature, step, attemptSlot) : null;
    if (existing) {
      return existing;
    }

    // Preflight: ensure every required repoId is present in the manifest
    const byId = new Map(repos.map(r => [r.id, r]));
    const missing = repoIds.filter(id => !byId.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Repository manifest is missing required repos for task ${feature}/${step}: ${missing.join(', ')}`,
      );
    }

    // Preflight: no composite root with content, and no branch collisions in any target repo.
    // An empty root is what an interrupted create or root removal leaves; it holds nothing to preserve.
    const compositeRoot = this.getCompositeRoot(feature, step, attemptSlot);
    const rootEntries = await fs.readdir(compositeRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (rootEntries && rootEntries.length > 0) {
      throw new Error(`Composite workspace already exists at ${compositeRoot}`);
    }

    const baseCommits: Record<string, string> = {};
    for (const repoId of repoIds) {
      const repo = byId.get(repoId)!;
      const branchName = this.getRepoBranchName(repoId, feature, step, attemptSlot);
      const repoGit = this.getGit(repo.path);
      try {
        const branches = await repoGit.branch();
        if (branches.all.includes(branchName)) {
          throw new Error(
            `Branch collision: ${branchName} already exists in repo ${repoId}`,
          );
        }
      } catch (e: unknown) {
        if ((e as Error).message.startsWith('Branch collision:')) throw e;
        throw new Error(`Failed to inspect branch ${branchName} in repo ${repoId}: ${(e as Error).message}`, { cause: e });
      }
      baseCommits[repoId] = (await repoGit.revparse(['--verify', `${baseBranch || 'HEAD'}^{commit}`])).trim();
    }
    const manifest: WorkspaceManifest = {
      schemaVersion: 1,
      feature,
      task: step,
      mode: 'composite',
      repos: Object.fromEntries(
        repoIds.map(id => {
          const repo = byId.get(id)!;
          return [id, {
            path: `repos/${id}`,
            repoRoot: repo.root,
            repoPath: repo.path,
            branch: this.getRepoBranchName(id, feature, step, attemptSlot),
            commit: baseCommits[id],
          }];
        }),
      ),
      baseCommits,
      ...(attemptSlot !== undefined ? { candidate: attemptSlot } : {}),
    };

    await guard.begin({
      repositories: repoIds.map(repoId => ({
        repositoryPath: byId.get(repoId)!.path,
        repoId,
        sourceWorktreePath: this.getRepoWorktreePath(feature, step, repoId, attemptSlot),
        sourceBranch: this.getRepoBranchName(repoId, feature, step, attemptSlot),
      })),
    });

    const createdRepos: Array<{ repoId: string; branchName: string; git: SimpleGit; commit: string; attached: boolean }> = [];
    const keptBranches: string[] = [];
    const repoInfos: Record<string, WorktreeRepoInfo> = {};

    try {
      // Written unconfirmed before the first branch or worktree add, so an
      // interrupted create is a manifest-backed workspace the task cleanup tool
      // can remove without deleting a populated checkout this create cannot
      // show it attached. Confirmed once every add is validated.
      await this.publishUntargetedPlacement(feature, step, record, statusPath, () => {
        fsSync.mkdirSync(compositeRoot, { recursive: true });
        writeWorkspaceJsonAtomicSync(manifestPath, { ...manifest, createUnconfirmed: true });
      });
      await fs.mkdir(path.join(compositeRoot, 'repos'), { recursive: true });
      for (const repoId of repoIds) {
        const repo = byId.get(repoId)!;
        const repoWtPath = this.getRepoWorktreePath(feature, step, repoId, attemptSlot);
        const branchName = this.getRepoBranchName(repoId, feature, step, attemptSlot);
        const repoGit = this.getGit(repo.path);

        await fs.mkdir(path.dirname(repoWtPath), { recursive: true });

        // Only a branch this create made is rolled back; the preflight's absent branch can reappear from another Git client.
        const refusal = await createBranchExclusively(repoGit, branchName, baseCommits[repoId], repoId);
        if (refusal) {
          if (refusal.kept !== null) keptBranches.push(refusal.kept);
          throw new Error(`Failed to create worktree for repo ${repoId}: ${refusal.error}`);
        }
        const created = { repoId, branchName, git: repoGit, commit: baseCommits[repoId], attached: false };
        createdRepos.push(created);
        try {
          await repoGit.raw(["worktree", "add", "--", repoWtPath, branchName]);
          created.attached = true;
        } catch (createError) {
          throw new Error(`Failed to create worktree for repo ${repoId}: ${createError}`);
        }
        await this.validateExactWorktreeRegistration(repoWtPath, repo.path, repoId);
        await this.validateWorktreeBranch(repoWtPath, branchName, repoId);
        const commit = (await this.getGit(repoWtPath).revparse(["HEAD"])).trim();
        if (commit !== baseCommits[repoId]) throw new Error(`Failed to create worktree for repo ${repoId}: ${repoWtPath} is at ${commit}, not ${baseCommits[repoId]}`);
        repoInfos[repoId] = { path: repoWtPath, branch: branchName, commit };
      }
      await confirmWorkspaceRecord(manifestPath, manifest);

      const first = repoInfos[repoIds[0]];
      return {
        path: compositeRoot,
        branch: first.branch,
        commit: first.commit,
        feature,
        step,
        mode: 'composite',
        workspacePath: compositeRoot,
        repos: repoInfos,
        baseCommits,
      };
    } catch (createError) {
      const leftovers = [...keptBranches];
      for (const created of createdRepos) {
        leftovers.push(...await rollbackFailedCreate(
          created.git,
          this.getRepoWorktreePath(feature, step, created.repoId, attemptSlot),
          { name: created.branchName, tip: created.commit, created: true },
          created.attached,
          created.repoId,
        ));
      }
      if (leftovers.length === 0) {
        try {
          await removeEmptyCompositeWorkspaceRoot(compositeRoot);
        } catch (rootError) {
          leftovers.push(`workspace root ${compositeRoot} (${(rootError as Error).message})`);
        }
      }
      if (leftovers.length === 0) {
        guard.markOutcomeKnown();
        throw createError;
      }
      const kept = unresolvedRecordNote(createError)
        || '. The workspace manifest was kept unconfirmed: after the operation is acknowledged, hive_worktree_cleanup removes what is gone or empty and keeps a populated checkout';
      throw new Error(`${(createError as Error).message}; rollback left ${leftovers.join(', ')}${kept}.`, { cause: createError });
    }
  }

  private async readWorkspaceManifest(feature: string, step: string, attemptSlot?: string): Promise<WorkspaceManifest | null> {
    const manifestPath = this.getWorkspaceManifestPath(feature, step, attemptSlot);
    await assertNoSymlinkComponents(path.parse(manifestPath).root, manifestPath, true);
    const manifest = await readCompositeWorkspaceManifest(this.getCompositeRoot(feature, step, attemptSlot));
    return manifest?.mode === 'composite' ? manifest : null;
  }

  async get(feature: string, step: string, attemptSlot?: string): Promise<WorktreeInfo | null> {
    const targeted = await this.readTargetedTask(feature, step, attemptSlot);
    if (targeted) return targeted.info;
    const manifest = await this.readWorkspaceManifest(feature, step, attemptSlot);
    if (manifest) {
      const compositeRoot = this.getCompositeRoot(feature, step, attemptSlot);
      const repos: Record<string, WorktreeRepoInfo> = {};
      const baseCommits: Record<string, string> = { ...manifest.baseCommits };
      const repoIds = Object.keys(manifest.repos);
      const trustedById = this.trustedRepositoriesForManifest(manifest);
      for (const id of repoIds) {
        const entry = manifest.repos[id]!;
        const trusted = trustedById.get(id)!;
        const repoWtPath = path.join(compositeRoot, entry.path);
        await this.validateExactWorktreeRegistration(repoWtPath, trusted.path, id);
        await this.validateWorktreeBranch(repoWtPath, entry.branch, id);
        let commit = manifest.repos[id].commit;
        commit = (await this.getGit(repoWtPath).revparse(["HEAD"])).trim();
        repos[id] = { path: repoWtPath, branch: manifest.repos[id].branch, commit };
      }
      const firstId = repoIds[0];
      return {
        path: compositeRoot,
        branch: repos[firstId].branch,
        commit: repos[firstId].commit,
        feature,
        step,
        mode: 'composite',
        workspacePath: compositeRoot,
        repos,
        baseCommits,
        ...(attemptSlot !== undefined ? { candidate: attemptSlot } : {}),
        ...(manifest.createUnconfirmed === true ? { createUnconfirmed: true as const } : {}),
      };
    }

    // Legacy single-repo worktree
    const worktreePath = this.getWorktreePath(feature, step, attemptSlot);
    const branchName = this.getLegacyBranchName(feature, step, attemptSlot);
    try {
      await fs.access(worktreePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    // A caller naming this task keeps the earlier legacy behavior: a sidecarless run and task of the adhoc feature leave
    // the same path and branch, so only metadata that names a run refuses the placement.
    const owner = await this.groupEntryOwner(feature, this.worktreeDirectoryName(step, attemptSlot));
    if (owner.owner === 'adhoc' && owner.declared) {
      throw new WorktreeLinkageError(`Worktree linkage preflight failed: ${worktreePath} is an ad-hoc run, not a worktree of task ${feature}/${step}`);
    }
    this.workspaceRepositoryPaths(null, worktreePath);
    await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'legacy');
    await this.validateWorktreeBranch(worktreePath, branchName, 'legacy');
    const worktreeGit = this.getGit(worktreePath);
    const commit = (await worktreeGit.revparse(["HEAD"])).trim();
    const metadata = await readSingleWorkspaceMetadata(this.getSingleMetadataPath(feature, step, attemptSlot));
    if (metadata && (
      metadata.mode !== 'single'
      || metadata.feature !== feature
      || metadata.task !== step
      || path.resolve(metadata.worktreePath) !== path.resolve(worktreePath)
      || !projectRootsMatch(metadata.repositoryPath, this.config.baseDir)
      || metadata.branch !== branchName
    )) {
      throw new WorktreeLinkageError('Worktree linkage preflight failed: single workspace metadata does not match the requested task worktree');
    }
    return {
      path: worktreePath,
      branch: branchName,
      commit,
      feature,
      step,
      mode: 'legacy',
      ...(metadata ? { baseCommit: metadata.baseCommit } : {}),
      ...(attemptSlot !== undefined ? { candidate: attemptSlot } : {}),
      ...(metadata?.createUnconfirmed === true ? { createUnconfirmed: true as const } : {}),
    };
  }

  /** Inspect one explicit workspace candidate, including ignored-file dirt. */
  async inspect(feature: string, step: string, attemptSlot?: string): Promise<WorktreeInfo | null> {
    const workspacePath = this.getWorktreePath(feature, step, attemptSlot);
    return this.readWorkspace(workspacePath, () => this.selectWorkspaceRepositories(feature, step, attemptSlot), async ({ manifest }, pending) => {
      const info = await this.get(feature, step, attemptSlot);
      if (!info) return null;
      if (pending.length > 0) info.pendingOperations = pending;
      if (info.targetBinding) {
        info.clean = await this.isCompletelyClean(this.getGit(info.path));
        const { binding, status, detail, target, comparison } = await inspectTargetBinding(this.checkoutContext(), info.targetBinding, info.commit);
        info.targetBinding = { ...binding, status, ...(detail !== undefined ? { detail } : {}) };
        Object.assign(info, { target, comparison });
      } else if (info.repos) {
        const trustedById = this.trustedRepositoriesForManifest(manifest!);
        for (const [repoId, repo] of Object.entries(info.repos)) {
          repo.clean = await this.isCompletelyClean(this.getGit(repo.path));
          Object.assign(repo, await inspectWorktreeTarget(trustedById.get(repoId)!.path, repo.commit));
        }
        info.clean = Object.values(info.repos).every((repo) => repo.clean === true);
      } else {
        info.clean = await this.isCompletelyClean(this.getGit(info.path));
        Object.assign(info, await inspectWorktreeTarget(this.config.baseDir, info.commit));
      }
      return info;
    });
  }

  /** Return every old/default/slotted candidate; callers must select one explicitly. */
  async listCandidates(feature: string, step: string): Promise<WorktreeInfo[]> {
    const { worktrees, errors } = await this.list(feature);
    if (errors.length) throw new WorktreeLinkageError(errors.map(error => `${error.path}: ${error.reason}`).join('\n'));
    return worktrees
      .filter((candidate) => candidate.step === step)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async getDiff(feature: string, step: string, baseCommit?: string, attemptSlot?: string): Promise<DiffResult> {
    await this.get(feature, step, attemptSlot);
    const manifest = await this.readWorkspaceManifest(feature, step, attemptSlot);
    if (manifest) {
      return this.getCompositeDiff(feature, step, manifest, attemptSlot);
    }
    return this.getLegacyDiff(feature, step, baseCommit, attemptSlot);
  }

  private async getCompositeDiff(
    feature: string,
    step: string,
    manifest: WorkspaceManifest,
    attemptSlot?: string,
  ): Promise<DiffResult> {
    const compositeRoot = this.getCompositeRoot(feature, step, attemptSlot);
    const repoIds = Object.keys(manifest.repos).sort();
    const repos: Record<string, RepoDiffResult> = {};
    const aggregatedFiles: string[] = [];
    const diffContentParts: string[] = [];
    let totalInsertions = 0;
    let totalDeletions = 0;
    let anyDiff = false;

    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      const repoWtPath = path.join(compositeRoot, entry.path);
      const base = manifest.baseCommits[repoId];
      const repoDiff = await this.diffOneRepo(repoWtPath, base);
      repos[repoId] = repoDiff;
      if (repoDiff.hasDiff) {
        anyDiff = true;
        totalInsertions += repoDiff.insertions;
        totalDeletions += repoDiff.deletions;
        for (const f of repoDiff.filesChanged) {
          aggregatedFiles.push(`${repoId}:${f}`);
        }
        if (repoDiff.diffContent) {
          diffContentParts.push(`# repo: ${repoId}\n${repoDiff.diffContent}`);
        }
      }
    }

    return {
      hasDiff: anyDiff,
      diffContent: diffContentParts.join('\n'),
      filesChanged: aggregatedFiles,
      insertions: totalInsertions,
      deletions: totalDeletions,
      repos,
    };
  }

  private async diffOneRepo(repoWtPath: string, baseCommit: string): Promise<RepoDiffResult> {
    const empty: RepoDiffResult = {
      hasDiff: false,
      diffContent: '',
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    };

    try {
      await fs.access(repoWtPath);
    } catch {
      return empty;
    }

    const git = this.getGit(repoWtPath);
    try {
      const base = (await git.revparse(['--verify', `${baseCommit}^{commit}`])).trim();
      await git.raw(['merge-base', '--is-ancestor', base, 'HEAD']).catch(() => {
        throw new Error(`Workspace baseline ${baseCommit} is not an ancestor of HEAD in ${repoWtPath}`);
      });
      await git.raw(['add', '-A']);
      const diffContent = await git.diff(['--cached', base]);
      const stat = diffContent ? await git.diff(['--cached', base, '--stat']) : '';

      const statLines = stat.split('\n').filter(l => l.trim());
      const filesChanged = statLines
        .slice(0, -1)
        .map(line => line.split('|')[0].trim())
        .filter(Boolean);
      const summaryLine = statLines[statLines.length - 1] || '';
      const insertMatch = summaryLine.match(/(\d+) insertion/);
      const deleteMatch = summaryLine.match(/(\d+) deletion/);

      return {
        hasDiff: diffContent.length > 0,
        diffContent,
        filesChanged,
        insertions: insertMatch ? parseInt(insertMatch[1], 10) : 0,
        deletions: deleteMatch ? parseInt(deleteMatch[1], 10) : 0,
      };
    } catch (error) {
      throw new Error(`Failed to diff workspace ${repoWtPath} from baseline ${baseCommit}: ${(error as Error).message}`, { cause: error });
    }
  }

  private async getLegacyDiff(feature: string, step: string, baseCommit?: string, attemptSlot?: string): Promise<DiffResult> {
    const statusPath = await this.getStepStatusPath(feature, step);

    let base = baseCommit;
    if (!base) {
      const metadataPath = this.getSingleMetadataPath(feature, step, attemptSlot);
      base = (await readTargetedWorkspaceMetadata(metadataPath))?.baseCommit
        ?? (await readSingleWorkspaceMetadata(metadataPath))?.baseCommit;
    }
    if (!base) {
      try {
        const status = JSON.parse(await fs.readFile(statusPath, "utf-8"));
        base = status.baseCommit;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`Failed to read legacy workspace baseline from ${statusPath}: ${(error as Error).message}`, { cause: error });
        }
      }
    }

    if (!base) throw new Error(`Workspace baseline is unavailable for ${feature}/${step}`);

    return this.diffOneRepo(this.getWorktreePath(feature, step, attemptSlot), base);
  }

  async exportPatch(feature: string, step: string, baseBranch?: string, attemptSlot?: string): Promise<string> {
    await this.get(feature, step, attemptSlot);
    const worktreePath = this.getWorktreePath(feature, step, attemptSlot);
    const patchPath = path.join(worktreePath, "..", `${step}.patch`);
    const base = baseBranch || "HEAD~1";
    const worktreeGit = this.getGit(worktreePath);

    const diff = await worktreeGit.diff([`${base}...HEAD`]);
    await fs.writeFile(patchPath, diff);

    return patchPath;
  }

  async applyDiff(feature: string, step: string, baseBranch?: string, attemptSlot?: string): Promise<ApplyResult> {
    const { hasDiff, diffContent, filesChanged } = await this.getDiff(feature, step, baseBranch, attemptSlot);

    if (!hasDiff) {
      return { success: true, filesAffected: [] };
    }

    const patchPath = path.join(this.config.hiveDir, ".worktrees", feature, `${step}.patch`);

    try {
      await fs.writeFile(patchPath, diffContent);
      const git = this.getGit();
      await git.applyPatch(patchPath);
      await fs.unlink(patchPath).catch(() => {});
      return { success: true, filesAffected: filesChanged };
    } catch (error: unknown) {
      await fs.unlink(patchPath).catch(() => {});
      const err = error as { message?: string };
      return {
        success: false,
        error: err.message || "Failed to apply patch",
        filesAffected: [],
      };
    }
  }

  async revertDiff(feature: string, step: string, baseBranch?: string): Promise<ApplyResult> {
    const { hasDiff, diffContent, filesChanged } = await this.getDiff(feature, step, baseBranch);

    if (!hasDiff) {
      return { success: true, filesAffected: [] };
    }

    const patchPath = path.join(this.config.hiveDir, ".worktrees", feature, `${step}.patch`);

    try {
      await fs.writeFile(patchPath, diffContent);
      const git = this.getGit();
      await git.applyPatch(patchPath, ["-R"]);
      await fs.unlink(patchPath).catch(() => {});
      return { success: true, filesAffected: filesChanged };
    } catch (error: unknown) {
      await fs.unlink(patchPath).catch(() => {});
      const err = error as { message?: string };
      return {
        success: false,
        error: err.message || "Failed to revert patch",
        filesAffected: [],
      };
    }
  }

  private parseFilesFromDiff(diffContent: string): string[] {
    const files: string[] = [];
    const regex = /^diff --git a\/(.+?) b\//gm;
    let match;
    while ((match = regex.exec(diffContent)) !== null) {
      files.push(match[1]);
    }
    return [...new Set(files)];
  }

  async revertFromSavedDiff(diffPath: string): Promise<ApplyResult> {
    const diffContent = await fs.readFile(diffPath, "utf-8");
    if (!diffContent.trim()) {
      return { success: true, filesAffected: [] };
    }

    const filesChanged = this.parseFilesFromDiff(diffContent);

    try {
      const git = this.getGit();
      await git.applyPatch(diffContent, ["-R"]);
      return { success: true, filesAffected: filesChanged };
    } catch (error: unknown) {
      const err = error as { message?: string };
      return {
        success: false,
        error: err.message || "Failed to revert patch",
        filesAffected: [],
      };
    }
  }

  async remove(
    feature: string,
    step: string,
    deleteBranch = false,
    options: WorktreeRemoveOptions = {},
    attemptSlot?: string,
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean; cleanup: WorktreeCleanupOutcome; finalization?: WorktreeFinalizationFailure }> {
    return this.mutate(
      'remove',
      { feature, step, attemptSlot },
      () => this.selectWorkspaceRepositories(feature, step, attemptSlot),
      async ({ manifest, targeted }, guard) => {
        if (targeted) {
          const placement = await readTargetedPlacement(this.checkoutContext(), this.targetedSpec(feature, step, attemptSlot));
          if (!placement) throw new WorktreeTopologyMismatchError(`Task ${step} is no longer a targeted worker`);
          return mergeCleanupResult(await removeTargetedPlacement(guard, this.targetedSpec(feature, step, attemptSlot), placement, deleteBranch, { discard: options.discard === true }));
        }
        if (manifest) {
          return this.removeComposite(guard, feature, step, manifest, deleteBranch, options, attemptSlot);
        }
        await this.get(feature, step, attemptSlot);
        return this.removeLegacy(guard, feature, step, deleteBranch, options, attemptSlot);
      },
    );
  }

  private async removeLegacy(
    guard: WorktreeMutationGuard,
    feature: string,
    step: string,
    deleteBranch: boolean,
    options: WorktreeRemoveOptions = {},
    attemptSlot?: string,
    expectedBranchCommit?: string,
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean; cleanup: WorktreeCleanupOutcome }> {
    const worktreePath = this.getWorktreePath(feature, step, attemptSlot);
    const branchName = this.getLegacyBranchName(feature, step, attemptSlot);
    const git = this.getGit();
    const metadataPath = this.getSingleMetadataPath(feature, step, attemptSlot);
    const unconfirmed = (await readSingleWorkspaceMetadata(metadataPath))?.createUnconfirmed === true;

    let branchPreparationError: string | undefined;
    let pinnedBranchCommit = expectedBranchCommit;
    if (deleteBranch && !pinnedBranchCommit) {
      try {
        pinnedBranchCommit = await this.prepareBranchDeletion(git, branchName, options.discard === true);
      } catch (error) {
        branchPreparationError = (error as Error).message;
      }
    }

    const requested = deleteBranch ? 'worktree+branch' : 'worktree';
    await guard.begin({ repositories: [{ repositoryPath: this.config.baseDir, sourceWorktreePath: worktreePath, sourceBranch: branchName }] });
    const worktreeRemoval = unconfirmed
      ? await removeUnconfirmedWorktreeStep(git, worktreePath, branchName)
      : await this.removeWorktreeStep(git, worktreePath);
    const outcome = buildCleanupOutcome(requested, {
      worktreeRemoval,
      prune: await pruneWorktreesStep(git),
      branchDeletion: deleteBranch
        ? branchPreparationError
          ? { status: 'failed', error: branchPreparationError }
          : cleanupStepDone(worktreeRemoval)
          ? await deleteBranchStep(git, branchName, pinnedBranchCommit)
          : { status: 'not_attempted' }
        : { status: 'not_requested' },
    });
    // The metadata keeps a retained branch's diff baseline for a later reattaching create, so it goes with the branch.
    const branchGone = deleteBranch
      ? cleanupStepDone(outcome.branchDeletion)
      : await readBranchOid(git, branchName).then((tip) => tip === null, () => false);
    if (cleanupStepDone(outcome.worktreeRemoval) && branchGone) {
      await fs.unlink(metadataPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw new CleanupActionError(outcome, 'metadata-removal', error);
      });
    }
    return mergeCleanupResult(outcome);
  }

  private async removeComposite(
    guard: WorktreeMutationGuard,
    feature: string,
    step: string,
    manifest: WorkspaceManifest,
    deleteBranch: boolean,
    options: WorktreeRemoveOptions = {},
    attemptSlot?: string,
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean; cleanup: WorktreeCleanupOutcome }> {
    const compositeRoot = this.getCompositeRoot(feature, step, attemptSlot);
    const reposById = this.trustedRepositoriesForManifest(manifest);

    // A retry may find a repo worktree already removed. Validate every remaining
    // link before mutating any repository, but do not require the link to exist.
    for (const [repoId, entry] of Object.entries(manifest.repos)) {
      const repositoryPath = reposById.get(repoId)!.path;
      const branchName = this.getRepoBranchName(repoId, feature, step, attemptSlot);
      if (entry.branch !== branchName) {
        throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repoId}: manifest branch does not match the canonical task branch`);
      }
      const repoWtPath = this.getRepoWorktreePath(feature, step, repoId, attemptSlot);
      if (await this.isPathAbsent(repoWtPath)) continue;
      await this.validateExactWorktreeRegistration(repoWtPath, repositoryPath, repoId);
      await this.validateWorktreeBranch(repoWtPath, branchName, repoId);
    }

    await guard.begin({
      repositories: Object.keys(manifest.repos).map(repoId => ({
        repositoryPath: reposById.get(repoId)!.path,
        repoId,
        sourceWorktreePath: this.getRepoWorktreePath(feature, step, repoId, attemptSlot),
        sourceBranch: this.getRepoBranchName(repoId, feature, step, attemptSlot),
      })),
    });
    const perRepo: Array<{ repoId: string; cleanup: WorktreeCleanupOutcome }> = [];
    for (const [repoId, entry] of Object.entries(manifest.repos)) {
      const repositoryPath = reposById.get(repoId)!.path;
      const perRepoResult = await this.removeCompositeRepo(
        guard,
        feature,
        step,
        repoId,
        repositoryPath,
        deleteBranch,
        options,
        attemptSlot,
      );
      perRepo.push({ repoId, cleanup: perRepoResult });
    }

    // Clean up the composite root directory itself
    let rootFailure: { cause: string } | undefined;
    if (perRepo.every(({ cleanup }) => cleanup.outcome === 'complete')) {
      const retained = manifest.createUnconfirmed === true
        ? await unconfirmedCompositeRetention(
          compositeRoot,
          this.getWorkspaceManifestPath(feature, step, attemptSlot),
          Object.keys(manifest.repos).map((repoId) => ({
            repoId,
            git: this.getGit(reposById.get(repoId)!.path),
            name: this.getRepoBranchName(repoId, feature, step, attemptSlot),
          })),
          'hive_worktree_cleanup',
        )
        : null;
      if (retained !== null) {
        rootFailure = { cause: retained };
      } else {
        try {
          await removeEmptyCompositeWorkspaceRoot(compositeRoot);
        } catch (error: unknown) {
          const err = error as { message?: string };
          rootFailure = { cause: err.message || 'composite root removal failed' };
        }
      }
    }

    const outcome = combineRepoCleanupOutcomes(
      deleteBranch ? 'worktree+branch' : 'worktree',
      perRepo,
      rootFailure,
    );
    return mergeCleanupResult(outcome);
  }

  private async prepareBranchDeletion(git: SimpleGit, branchName: string, allowUnmergedCommits: boolean): Promise<string | undefined> {
    return prepareBranchDeletion(git, branchName, allowUnmergedCommits, ' Merge first, keep the branch, or use explicit discard.');
  }

  async list(feature?: string): Promise<WorktreeListResult> {
    const worktreesDir = this.getWorktreesDir();
    const results: WorktreeListResult = { worktrees: [], errors: [] };

    let features: string[];
    try {
      features = feature ? [feature] : await fs.readdir(worktreesDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return results;
      throw error;
    }

    for (const feat of features) {
      const featurePath = path.join(worktreesDir, feat);
      try {
        const stat = await fs.lstat(featurePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });

        if (stat?.isSymbolicLink()) throw new WorktreeLinkageError(`Worktree linkage preflight failed: path contains a symlink (${featurePath})`);
        if (!stat?.isDirectory()) continue;

        const steps = await fs.readdir(featurePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });

        for (const entry of steps) {
          const entryPath = path.join(featurePath, entry);
          // Sidecar files sit beside their placements and are no placement to attribute.
          if ((await fs.lstat(entryPath).catch(() => null))?.isFile()) continue;
          const owner = await this.groupEntryOwner(feat, entry);
          if (owner.owner === 'adhoc') continue;
          if (owner.owner === 'unknown') {
            results.errors.push({ path: entryPath, reason: owner.reason });
            continue;
          }
          try {
            const entryStat = await fs.lstat(entryPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            });
            if (entryStat?.isSymbolicLink()) throw new WorktreeLinkageError(`Worktree linkage preflight failed: path contains a symlink (${entryPath})`);
            if (!entryStat?.isDirectory()) continue;
            const { step, attemptSlot } = this.parseWorktreeStepDirectory(entry);
            const info = await this.get(feat, step, attemptSlot);
            if (info) results.worktrees.push(info);
          } catch (error) {
            results.errors.push({ path: entryPath, reason: error instanceof Error ? error.message : String(error) });
          }
        }
      } catch (error) {
        results.errors.push({ path: featurePath, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    return results;
  }

  /**
   * Remove every stale task workspace, one whose checkouts Git can no longer
   * read, then prune the trusted repositories. Each workspace is rechecked and
   * removed as its own guarded operation, under that workspace's lock and with
   * markers naming its checkouts, as a single remove would be; the prune runs
   * last under the repository locks. The first operation whose bookkeeping
   * fails ends the cleanup: its finalization is reported with `pruned: false`,
   * and the workspaces after it are left for a later cleanup. An error that
   * ends the cleanup keeps its own type and lists, in `removedBeforeFailure`,
   * the workspaces already removed; nothing is rolled back.
   */
  async cleanup(feature?: string): Promise<{ removed: string[]; pruned: boolean; finalization?: WorktreeFinalizationFailure }> {
    const removed: string[] = [];
    try {
      for (const placement of await this.taskPlacements(feature)) {
        const result: { removed: boolean; finalization?: WorktreeFinalizationFailure } = await this.mutate(
          'cleanup',
          placement,
          () => this.selectWorkspaceRepositories(placement.feature, placement.step, placement.attemptSlot),
          async (selection, guard) => ({ removed: await this.removeIfStale(guard, selection, placement) }),
        );
        if (result.removed) removed.push(this.getWorktreePath(placement.feature, placement.step, placement.attemptSlot));
        if (result.finalization) return { removed, pruned: false, finalization: result.finalization };
      }
      const pruned = await this.mutate('cleanup', { project: true, feature }, async () => {
        const resolved = this.resolveRepositories();
        return { repositoryPaths: resolved?.length ? resolved.map(repository => repository.path) : [this.config.baseDir] };
      }, async ({ repositoryPaths }, guard) => {
        await guard.begin();
        for (const repositoryPath of repositoryPaths) {
          try {
            await this.getGit(repositoryPath).raw(["worktree", "prune"]);
          } catch {
            /* intentional */
          }
        }
        return { pruned: true };
      });
      return { removed, ...pruned };
    } catch (error) {
      if (removed.length > 0 && error instanceof Error) {
        error.message = `${error.message}; this cleanup had already removed ${removed.join(', ')}`;
        Object.assign(error, { removedBeforeFailure: [...removed] } satisfies BulkCleanupFailure);
      }
      throw error;
    }
  }

  /** The task workspace directories under the feature groups global cleanup visits; read without locks, rechecked by each removal. */
  private async taskPlacements(feature: string | undefined): Promise<Array<{ feature: string; step: string; attemptSlot?: string; entry: string }>> {
    const worktreesDir = this.getWorktreesDir();
    const features = feature ? [feature] : await fs.readdir(worktreesDir).catch(() => []);
    const placements: Array<{ feature: string; step: string; attemptSlot?: string; entry: string }> = [];
    for (const feat of features) {
      const featurePath = path.join(worktreesDir, feat);
      const stat = await fs.lstat(featurePath).catch(() => null);
      if (stat?.isSymbolicLink()) throw new WorktreeLinkageError(`Worktree linkage preflight failed: path contains a symlink (${featurePath})`);
      if (!stat?.isDirectory()) continue;
      for (const entry of await fs.readdir(featurePath).catch(() => [])) {
        if ((await this.groupEntryOwner(feat, entry)).owner !== 'task') continue;
        const worktreePath = path.join(featurePath, entry);
        const stepStat = await fs.lstat(worktreePath).catch(() => null);
        if (stepStat?.isSymbolicLink()) throw new WorktreeLinkageError(`Worktree linkage preflight failed: path contains a symlink (${worktreePath})`);
        if (!stepStat?.isDirectory()) continue;
        placements.push({ feature: feat, entry, ...this.parseWorktreeStepDirectory(entry) });
      }
    }
    return placements;
  }

  /**
   * Under the workspace's locks, remove it when it is still a task workspace and
   * stale: a targeted worker whose worktree is gone or unreadable, a composite
   * with a missing or unreadable repository checkout, or a single-root
   * checkout whose HEAD Git cannot read. Returns whether its placement is gone.
   */
  private async removeIfStale(
    guard: WorktreeMutationGuard,
    selection: WorkspaceRepositorySelection,
    placement: { feature: string; step: string; attemptSlot?: string; entry: string },
  ): Promise<boolean> {
    const { feature, step, attemptSlot, entry } = placement;
    const worktreePath = this.getWorktreePath(feature, step, attemptSlot);
    if ((await this.groupEntryOwner(feature, entry)).owner !== 'task') return false;
    const stepStat = await fs.lstat(worktreePath).catch(() => null);
    if (stepStat?.isSymbolicLink()) throw new WorktreeLinkageError(`Worktree linkage preflight failed: path contains a symlink (${worktreePath})`);
    if (!stepStat?.isDirectory()) return false;

    if (selection.targeted) {
      const targeted = await readTargetedPlacement(this.checkoutContext(), this.targetedSpec(feature, step, attemptSlot));
      if (!targeted) throw new WorktreeTopologyMismatchError(`Task ${step} is no longer a targeted worker`);
      const stale = !targeted.present || !(await this.getGit(worktreePath).revparse(['HEAD']).then(() => true, () => false));
      if (!stale) return false;
      const outcome = await removeTargetedPlacement(guard, this.targetedSpec(feature, step, attemptSlot), targeted, false);
      return cleanupStepDone(outcome.worktreeRemoval) && await this.isPathAbsent(worktreePath);
    }

    const { manifest } = selection;
    if (manifest) {
      const trustedById = this.trustedRepositoriesForManifest(manifest);
      let stale = false;
      for (const [repoId, repoEntry] of Object.entries(manifest.repos)) {
        const repoWt = path.join(worktreePath, repoEntry.path);
        const repoStat = await fs.lstat(repoWt).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!repoStat) {
          stale = true;
          continue;
        }
        await this.validateExactWorktreeRegistration(repoWt, trustedById.get(repoId)!.path, repoId);
        try {
          await this.getGit(repoWt).revparse(["HEAD"]);
        } catch {
          stale = true;
          break;
        }
      }
      if (!stale) return false;
      const cleanup = await this.removeComposite(guard, feature, step, manifest, false, {}, attemptSlot);
      return cleanup.worktreeRemoved && await this.isPathAbsent(worktreePath);
    }

    await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'legacy');
    try {
      await this.getGit(worktreePath).revparse(["HEAD"]);
      return false;
    } catch {
      const cleanup = await this.removeLegacy(guard, feature, step, false, {}, attemptSlot);
      return cleanup.worktreeRemoved && await this.isPathAbsent(worktreePath);
    }
  }

  async checkConflicts(feature: string, step: string, baseBranch?: string): Promise<string[]> {
    const { hasDiff, diffContent } = await this.getDiff(feature, step, baseBranch);

    if (!hasDiff) {
      return [];
    }

    const patchPath = path.join(this.config.hiveDir, ".worktrees", feature, `${step}-check.patch`);

    try {
      await fs.writeFile(patchPath, diffContent);
      const git = this.getGit();
      await git.applyPatch(patchPath, ["--check"]);
      await fs.unlink(patchPath).catch(() => {});
      return [];
    } catch (error: unknown) {
      await fs.unlink(patchPath).catch(() => {});
      const err = error as { message?: string };
      const stderr = err.message || "";

      const conflicts = stderr
        .split("\n")
        .filter((line) => line.includes("error: patch failed:"))
        .map((line) => {
          const match = line.match(/error: patch failed: (.+):/);
          return match ? match[1] : null;
        })
        .filter((f): f is string => f !== null);

      return conflicts;
    }
  }

  async checkConflictsFromSavedDiff(diffPath: string, reverse = false): Promise<string[]> {
    try {
      await fs.access(diffPath);
    } catch {
      return [];
    }

    try {
      const git = this.getGit();
      const options = reverse ? ["--check", "-R"] : ["--check"];
      await git.applyPatch(diffPath, options);
      return [];
    } catch (error: unknown) {
      const err = error as { message?: string };
      const stderr = err.message || "";

      const conflicts = stderr
        .split("\n")
        .filter((line) => line.includes("error: patch failed:"))
        .map((line) => {
          const match = line.match(/error: patch failed: (.+):/);
          return match ? match[1] : null;
        })
        .filter((f): f is string => f !== null);

      return conflicts;
    }
  }

  /**
   * Integrate a task worktree. `options.historyIntent` is required and selects
   * the permitted strategy; an omitted strategy resolves from the intent
   * (preserve-source: merge, rewrite-private: squash). Missing, unknown or
   * incompatible intent is rejected before any lock, Git read or mutation.
   */
  async merge(
    feature: string,
    step: string,
    strategy: IntegrationStrategy | undefined,
    message: string | undefined,
    options: MergeOptions,
    attemptSlot?: string,
  ): Promise<MergeResult> {
    const resolved = resolveIntegrationPolicy(options?.historyIntent, strategy);
    if ('error' in resolved) return mergeFailure(undefined, 'INVALID_ARGUMENTS', resolved.error, { partial: false });
    const { policy } = resolved;
    const optionFailure = rebasePreserveConflictsFailure(policy, options.preserveConflicts);
    if (optionFailure) return mergeFailure(policy.strategy, 'INVALID_ARGUMENTS', optionFailure, { partial: false });
    try {
      return await this.mutate(
        'merge',
        { feature, step, attemptSlot },
        () => this.selectWorkspaceRepositories(feature, step, attemptSlot),
        async ({ manifest, targeted }, guard) => {
          if (targeted) return this.mergeTargeted(guard, feature, step, policy, message, options, attemptSlot);
          // An unreadable status keeps the untargeted merge it always had; a declared target never falls back to it.
          if (await this.readTaskTarget(feature, step).catch(() => null)) await this.assertTaskTargetMatches(feature, step, null);
          return this.mergeUnlocked(guard, feature, step, manifest, policy, message, options, attemptSlot);
        },
        isMutationOutcomeKnown,
      );
    } catch (error) {
      const reasonCode = classifyThrownWorktreeError(error) ?? 'GIT_OPERATION_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      // An operation that began mutating has an unknown outcome; only a refusal before any effect is a preflight result.
      if (error instanceof WorktreeOperationRecoveryRequiredError && error.mutation !== 'none') {
        const failure = mergeFailure(policy.strategy, reasonCode, message, { mutation: error.mutation });
        const finalization = retainedMarkerFinalization(error);
        return finalization ? { ...failure, finalization } : failure;
      }
      return mergeFailure(policy.strategy, reasonCode, message, { partial: false });
    }
  }

  private async mergeTargeted(
    guard: WorktreeMutationGuard,
    feature: string,
    step: string,
    policy: IntegrationPolicy,
    message: string | undefined,
    options: MergeOptions,
    attemptSlot?: string,
  ): Promise<MergeResult> {
    const { strategy } = policy;
    if (strategy === 'rebase' && message?.trim()) {
      return mergeFailure(strategy, 'MESSAGE_NOT_ALLOWED_FOR_REBASE', 'Custom merge message is not supported for rebase strategy');
    }
    if (options.expectedTargets !== undefined || options.sourceCommits !== undefined) {
      return mergeFailure(strategy, 'INVALID_ARGUMENTS', 'A targeted task takes expectedTarget and sourceCommit, not per-repository maps', { partial: false });
    }
    if (options.expectedTarget === undefined) return mergeFailure(strategy, 'INVALID_ARGUMENTS', 'expectedTarget or expectedTargets is required', { partial: false });
    const spec = this.targetedSpec(feature, step, attemptSlot);
    let placement: TargetedPlacement | null;
    try {
      placement = await readTargetedPlacement(this.checkoutContext(), spec);
      if (placement) await this.assertTaskTargetMatches(feature, step, placement);
    } catch (error) {
      return mergeFailure(strategy, classifyThrownWorktreeError(error) ?? 'WORKTREE_LOOKUP_FAILED', error instanceof Error ? error.message : String(error), { partial: false });
    }
    if (!placement) return mergeFailure(strategy, 'WORKSPACE_TOPOLOGY_MISMATCH', `Task ${step} is no longer a targeted worker`, { partial: false });
    const result = await mergeTargetedPlacement({
      guard,
      context: this.checkoutContext(),
      spec,
      placement,
      policy,
      message,
      preserveConflicts: options.preserveConflicts ?? false,
      cleanupMode: options.cleanup ?? 'none',
      ...(options.sourceCommit !== undefined ? { sourceCommit: options.sourceCommit } : {}),
      expectedTarget: options.expectedTarget,
    });
    return { ...result, strategy };
  }

  private async mergeUnlocked(
    guard: WorktreeMutationGuard,
    feature: string,
    step: string,
    manifest: WorkspaceManifest | null,
    policy: IntegrationPolicy,
    message: string | undefined,
    options: MergeOptions,
    attemptSlot?: string,
  ): Promise<MergeResult> {
    const { strategy } = policy;
    const cleanupMode = options.cleanup ?? 'none';
    const preserveConflicts = options.preserveConflicts ?? false;

    if (strategy === "rebase" && message?.trim()) {
      return mergeFailure(strategy, 'MESSAGE_NOT_ALLOWED_FOR_REBASE', "Custom merge message is not supported for rebase strategy");
    }

    let targets: ReturnType<typeof validateTargetExpectations>;
    try {
      targets = validateTargetExpectations(manifest ? Object.keys(manifest.repos) : null, options.expectedTarget, options.expectedTargets);
    } catch (error) {
      return mergeFailure(strategy, 'INVALID_ARGUMENTS', error instanceof Error ? error.message : String(error), { partial: false });
    }

    let registered: WorktreeInfo | null;
    try {
      registered = await this.get(feature, step, attemptSlot);
    } catch (error) {
      // Only typed identity denials map to a fresh run. An untyped lookup
      // failure (transient filesystem or Git error) is inspectable state, not
      // evidence that the worktree identity is invalid.
      const reasonCode: WorktreeReasonCode = classifyThrownWorktreeError(error) ?? 'WORKTREE_LOOKUP_FAILED';
      return mergeFailure(
        strategy,
        reasonCode,
        error instanceof Error ? error.message : String(error),
        { partial: false },
      );
    }
    if (!registered) {
      return mergeFailure(
        strategy,
        'WORKTREE_NOT_REGISTERED',
        'Worktree linkage preflight failed: task worktree is not registered',
        { partial: false },
      );
    }
    const recordPath = manifest ? this.getWorkspaceManifestPath(feature, step, attemptSlot) : this.getSingleMetadataPath(feature, step, attemptSlot);
    const unconfirmed = createUnconfirmedRefusal(registered, registered.path, recordPath, 'hive_worktree_cleanup', 'integrated');
    if (unconfirmed !== null) return mergeFailure(strategy, 'CREATE_UNCONFIRMED', unconfirmed, { partial: false });
    if (manifest) {
      return this.mergeComposite(guard, feature, step, manifest, policy, message, {
        cleanup: cleanupMode,
        preserveConflicts,
        sourceCommits: options.sourceCommits,
        expectedTargets: targets.expectedTargets!,
      }, attemptSlot);
    }

    const branchName = this.getLegacyBranchName(feature, step, attemptSlot);
    const sourceCommit = options.sourceCommit ?? registered.commit;
    const repoResult = await this.mergeOneRepo({
      git: this.getGit(),
      branchName,
      policy,
      message,
      preserveConflicts,
      cleanupMode,
      sourceCommit,
      expectedTarget: targets.expectedTarget!,
      sourceWorktreePath: registered.path,
      beforeMutation: () => guard.begin({
        strategy,
        repositories: [{ repositoryPath: this.config.baseDir, sourceWorktreePath: registered.path, sourceBranch: branchName, sourceCommit, expectedTarget: targets.expectedTarget! }],
      }),
      cleanupFn: async (deleteBranch: boolean) => (await this.removeLegacy(guard, feature, step, deleteBranch, {}, attemptSlot, sourceCommit)).cleanup,
    });
    return {
      success: repoResult.success,
      merged: repoResult.merged,
      strategy,
      ...(repoResult.sha !== undefined ? { sha: repoResult.sha } : {}),
      ...(repoResult.commitMessage !== undefined ? { commitMessage: repoResult.commitMessage } : {}),
      ...(repoResult.reason !== undefined ? { reason: repoResult.reason } : {}),
      ...(repoResult.reasonCode !== undefined ? { reasonCode: repoResult.reasonCode } : {}),
      ...(repoResult.cleanupEligible !== undefined ? { cleanupEligible: repoResult.cleanupEligible } : {}),
      ...(repoResult.taskUpdateRecommended !== undefined ? { taskUpdateRecommended: repoResult.taskUpdateRecommended } : {}),
      filesChanged: repoResult.filesChanged,
      conflicts: repoResult.conflicts,
      conflictState: repoResult.conflictState,
      cleanup: repoResult.cleanup,
      ...(repoResult.error !== undefined ? { error: repoResult.error } : {}),
      phase: repoResult.phase,
      mutation: repoResult.mutation,
      retryable: repoResult.retryable,
      action: repoResult.action,
      ...(repoResult.expectedTarget !== undefined ? { expectedTarget: repoResult.expectedTarget } : {}),
      ...(repoResult.observedTarget !== undefined ? { observedTarget: repoResult.observedTarget } : {}),
    };
  }

  private async mergeComposite(
    guard: WorktreeMutationGuard,
    feature: string,
    step: string,
    manifest: WorkspaceManifest,
    policy: IntegrationPolicy,
    message: string | undefined,
    options: {
      cleanup: 'none' | 'worktree' | 'worktree+branch';
      preserveConflicts: boolean;
      sourceCommits?: Record<string, string>;
      expectedTargets: Record<string, WorktreeTargetIdentity>;
    },
    attemptSlot?: string,
  ): Promise<MergeResult> {
    const { strategy } = policy;
    const repoIds = Object.keys(manifest.repos).sort();
    const trustedById = this.trustedRepositoriesForManifest(manifest);
    const pinnedSourceCommits: Record<string, string> = {};
    const precomputedCandidates: Record<string, TargetMergeCandidates> = {};

    const preflightFailure = (
      repoId: string,
      reason: string,
      reasonCode: WorktreeReasonCode,
      observedTarget?: WorktreeTargetIdentity | null,
    ): MergeResult => mergeFailure(strategy, reasonCode, `${repoId}: ${reason}`, {
      partial: false,
      ...(reasonCode === 'TARGET_MISMATCH' ? { expectedTarget: options.expectedTargets[repoId], observedTarget: observedTarget ?? null } : {}),
    });

    // Preflight all repos before any mutation
    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      const repoRoot = trustedById.get(repoId)!.path;
      const repoGit = this.getGit(repoRoot);
      const repoWtPath = path.join(this.getCompositeRoot(feature, step, attemptSlot), entry.path);
      let observedTarget: WorktreeTargetIdentity | null = null;
      try {
        observedTarget = await readWorktreeTargetIdentity(repoRoot);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        return preflightFailure(repoId, `unable to read target identity: ${cause}`, 'GIT_OPERATION_FAILED');
      }
      if (!sameWorktreeTarget(options.expectedTargets[repoId], observedTarget)) {
        return preflightFailure(repoId, 'target identity no longer matches the caller expectation', 'TARGET_MISMATCH', observedTarget);
      }
      const expectedBranch = this.getRepoBranchName(repoId, feature, step, attemptSlot);
      if (entry.branch !== expectedBranch) {
        return preflightFailure(repoId, 'manifest branch does not match the canonical task branch', 'WORKSPACE_TOPOLOGY_MISMATCH');
      }

      // Branch must exist in the source repo
      try {
        const branches = await repoGit.branch();
        if (!branches.all.includes(entry.branch)) {
          return preflightFailure(repoId, `branch ${entry.branch} not found`, 'SOURCE_BRANCH_MISSING');
        }
      } catch (e: unknown) {
        const msg = (e as { message?: string }).message ?? 'unable to list branches';
        return preflightFailure(repoId, msg, 'GIT_OPERATION_FAILED');
      }

      pinnedSourceCommits[repoId] = options.sourceCommits?.[repoId]
        ?? (await this.getGit(repoWtPath).revparse(['HEAD'])).trim();
      const sourceBranchHead = (await repoGit.revparse([entry.branch])).trim();
      if (sourceBranchHead !== pinnedSourceCommits[repoId]) {
        return preflightFailure(repoId, `source branch moved from pinned commit ${pinnedSourceCommits[repoId]} to ${sourceBranchHead}`, 'GIT_OPERATION_FAILED');
      }
      if (!(await this.isGitClean(this.getGit(repoWtPath)))) {
        return preflightFailure(repoId, 'source worktree has tracked or untracked changes', 'TARGET_DIRTY');
      }

      try {
        const eligibility = await inspectTargetMergeEligibility({
          targetGit: repoGit,
          targetRoot: repoRoot,
          targetCommit: options.expectedTargets[repoId].commit,
          sourceCommit: pinnedSourceCommits[repoId],
          policy,
          excludedLocalPaths: [repoWtPath, ...worktreeOperationLocalPaths(this.config.hiveDir)],
        });
        if ('error' in eligibility) return preflightFailure(repoId, eligibility.error, eligibility.reasonCode);
        precomputedCandidates[repoId] = eligibility;
        const messageFailure = await integrationMessageFailure(repoGit, eligibility, message);
        if (messageFailure) return preflightFailure(repoId, messageFailure.error, messageFailure.reasonCode);
      } catch (e: unknown) {
        const msg = (e as { message?: string }).message ?? 'unable to read status';
        return preflightFailure(repoId, msg, 'GIT_OPERATION_FAILED');
      }
    }

    const beginMerge = () => guard.begin({
      strategy,
      repositories: repoIds.map(repoId => ({
        repositoryPath: trustedById.get(repoId)!.path,
        repoId,
        sourceWorktreePath: path.join(this.getCompositeRoot(feature, step, attemptSlot), manifest.repos[repoId].path),
        sourceBranch: manifest.repos[repoId].branch,
        sourceCommit: pinnedSourceCommits[repoId],
        expectedTarget: options.expectedTargets[repoId],
      })),
    });

    // Execute per-repo merges in stable order
    const repos: Record<string, RepoMergeResult> = {};
    const flattenedFiles: string[] = [];
    const flattenedConflicts: string[] = [];
    let anyActualMerge = false;
    let firstActualSha: string | undefined;
    let firstActualCommitMessage: string | undefined;
    let stoppedRepoId: string | undefined;
    let firstError: string | undefined;
    let lastConflictState: 'none' | 'aborted' | 'preserved' = 'none';

    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      const repoRoot = trustedById.get(repoId)!.path;
      const repoGit = this.getGit(repoRoot);
      const repoResult = await this.mergeOneRepo({
        git: repoGit,
        branchName: entry.branch,
        policy,
        message,
        preserveConflicts: options.preserveConflicts,
        cleanupMode: 'none', // defer cleanup until after all repos succeed
        sourceCommit: pinnedSourceCommits[repoId],
        expectedTarget: options.expectedTargets[repoId],
        sourceWorktreePath: path.join(this.getCompositeRoot(feature, step, attemptSlot), entry.path),
        precomputedCandidates: precomputedCandidates[repoId],
        beforeMutation: beginMerge,
        cleanupFn: async () => buildNotRequestedCleanupOutcome(),
      });
      repos[repoId] = {
        ...repoResult,
        operationStatus: repoResult.success ? 'success' : 'failed',
      };
      if (repoResult.merged) {
        for (const f of repoResult.filesChanged) flattenedFiles.push(`${repoId}:${f}`);
      }
      for (const c of repoResult.conflicts) flattenedConflicts.push(`${repoId}:${c}`);

      if (!repoResult.success) {
        stoppedRepoId = repoId;
        firstError = `${repoId}: ${repoResult.error ?? 'merge failed'}`;
        lastConflictState = repoResult.conflictState;
        break;
      }

      if (!repoResult.merged) {
        if (repoResult.reasonCode === 'NO_TRACKED_CHANGES' || repoResult.reasonCode === 'ALREADY_INTEGRATED') {
          continue;
        }
        stoppedRepoId = repoId;
        firstError = `${repoId}: ${repoResult.error ?? 'repo reported merged=false'}`;
        lastConflictState = repoResult.conflictState;
        break;
      }

      anyActualMerge = true;
      firstActualSha ??= repoResult.sha;
      firstActualCommitMessage ??= repoResult.commitMessage;
    }

    if (stoppedRepoId !== undefined) {
      for (const repoId of repoIds.slice(repoIds.indexOf(stoppedRepoId) + 1)) {
        repos[repoId] = {
          ...integrationFailure('GIT_OPERATION_FAILED', `Not attempted after repository ${stoppedRepoId} failed`),
          operationStatus: 'not_attempted',
        };
      }
      // Stop: do not rollback earlier successful repo merges
      const partial = anyActualMerge;
      const stopped = repos[stoppedRepoId];
      const reasonCode: WorktreeReasonCode = partial
        ? 'COMPOSITE_PARTIAL'
        : (stopped.reasonCode ?? 'GIT_OPERATION_FAILED');
      return mergeFailure(strategy, reasonCode, firstError ?? 'merge failed', {
        mutation: partial ? 'partial' : stopped.mutation,
        filesChanged: flattenedFiles,
        conflicts: flattenedConflicts,
        conflictState: lastConflictState,
        repos,
        partial,
      });
    }

    // All repos merged. Apply per-repo cleanup and populate each
    // repos[repoId].cleanup field; aggregate top-level cleanup from per-repo
    // results so the contract holds for both shapes.
    let cleanup = buildNotRequestedCleanupOutcome();
    if (options.cleanup !== 'none') {
      const cleanupMode = options.cleanup;
      const deleteBranch = cleanupMode === 'worktree+branch';
      const perRepo: Array<{ repoId: string; cleanup: WorktreeCleanupOutcome }> = [];
      // Every repository proves its completed work before any repository is cleaned up.
      let proofFailure: { repoId: string; step: string; cause: string } | undefined;
      for (const repoId of repoIds) {
        const failure = await proveCleanupEligibility({
          targetGit: this.getGit(trustedById.get(repoId)!.path),
          targetRoot: trustedById.get(repoId)!.path,
          sourceBranch: manifest.repos[repoId].branch,
          sourceCommit: pinnedSourceCommits[repoId],
          expectedTarget: {
            ...options.expectedTargets[repoId],
            commit: repos[repoId].sha ?? options.expectedTargets[repoId].commit,
          },
          completion: completedIntegration(policy, repos[repoId]),
        });
        if (failure) {
          proofFailure = { repoId, ...failure };
          break;
        }
      }
      // Publish the pending markers before the first removal, outside the
      // per-repository catch: a refused or failed publication is not a cleanup outcome.
      if (!proofFailure) await beginMerge();
      for (const repoId of repoIds) {
        let repoCleanup: WorktreeCleanupOutcome;
        if (proofFailure) {
          repoCleanup = buildSkippedCleanupOutcome(cleanupMode, proofFailure);
        } else {
          try {
            repoCleanup = await this.removeCompositeRepo(
              guard,
              feature,
              step,
              repoId,
              trustedById.get(repoId)!.path,
              deleteBranch,
              {},
              attemptSlot,
              pinnedSourceCommits[repoId],
            );
          } catch (error) {
            repoCleanup = buildThrownCleanupOutcome(cleanupMode, error, repoId);
          }
        }
        repos[repoId].cleanup = toMergeCleanupBlock(repoCleanup);
        perRepo.push({ repoId, cleanup: repoCleanup });
      }
      // Tear down the composite root after per-repo cleanup.
      const compositeRoot = this.getCompositeRoot(feature, step, attemptSlot);
      let rootFailure: { cause: string } | undefined;
      if (!proofFailure && perRepo.every(({ cleanup }) => cleanup.outcome === 'complete')) {
        try {
          await removeEmptyCompositeWorkspaceRoot(compositeRoot);
        } catch (error: unknown) {
          const err = error as { message?: string };
          rootFailure = { cause: err.message || 'composite root removal failed' };
        }
      }
      cleanup = combineRepoCleanupOutcomes(options.cleanup, perRepo, rootFailure);
    }

    if (!anyActualMerge) {
      const allContained = repoIds.every((repoId) => repos[repoId].reasonCode === 'ALREADY_INTEGRATED');
      return {
        success: true,
        merged: false,
        strategy,
        ...(allContained
          ? { reason: 'already_integrated', reasonCode: 'ALREADY_INTEGRATED' as const }
          : { reason: 'nothing_to_merge', reasonCode: 'NO_TRACKED_CHANGES' as const }),
        cleanupEligible: true,
        taskUpdateRecommended: true,
        filesChanged: [],
        conflicts: [],
        conflictState: 'none',
        cleanup: toMergeCleanupBlock(cleanup),
        ...mergeSuccessClassification(options.cleanup, cleanup, 'none'),
        repos,
      };
    }

    return {
      success: true,
      merged: true,
      strategy,
      ...(firstActualSha !== undefined ? { sha: firstActualSha } : {}),
      ...(firstActualCommitMessage !== undefined ? { commitMessage: firstActualCommitMessage } : {}),
      filesChanged: flattenedFiles,
      conflicts: flattenedConflicts,
      conflictState: 'none',
      cleanup: toMergeCleanupBlock(cleanup),
      ...mergeSuccessClassification(options.cleanup, cleanup, 'applied'),
      repos,
    };
  }

  private async removeCompositeRepo(
    guard: WorktreeMutationGuard,
    feature: string,
    step: string,
    repoId: string,
    repositoryPath: string,
    deleteBranch: boolean,
    options: WorktreeRemoveOptions = {},
    attemptSlot?: string,
    expectedBranchCommit?: string,
  ): Promise<WorktreeCleanupOutcome> {
    const repoWtPath = this.getRepoWorktreePath(feature, step, repoId, attemptSlot);
    const repoGit = this.getGit(repositoryPath);
    const branchName = this.getRepoBranchName(repoId, feature, step, attemptSlot);
    const unconfirmed = (await this.readWorkspaceManifest(feature, step, attemptSlot))?.createUnconfirmed === true;

    let branchPreparationError: string | undefined;
    let pinnedBranchCommit = expectedBranchCommit;
    if (deleteBranch && !pinnedBranchCommit) {
      try {
        pinnedBranchCommit = await this.prepareBranchDeletion(repoGit, branchName, options.discard === true);
      } catch (error) {
        branchPreparationError = (error as Error).message;
      }
    }
    await guard.begin({ repositories: [{ repositoryPath, repoId, sourceWorktreePath: repoWtPath, sourceBranch: branchName }] });
    const worktreeRemoval = unconfirmed
      ? await removeUnconfirmedWorktreeStep(repoGit, repoWtPath, branchName)
      : await this.removeWorktreeStep(repoGit, repoWtPath);
    return buildCleanupOutcome(deleteBranch ? 'worktree+branch' : 'worktree', {
      worktreeRemoval,
      prune: await pruneWorktreesStep(repoGit),
      branchDeletion: deleteBranch
        ? branchPreparationError
          ? { status: 'failed', error: branchPreparationError }
          : cleanupStepDone(worktreeRemoval)
          ? await deleteBranchStep(repoGit, branchName, pinnedBranchCommit)
          : { status: 'not_attempted' }
        : { status: 'not_requested' },
    });
  }

  /**
   * Remove one registered worktree. Reports already_absent when the path is
   * gone, and captures the underlying cause when removal fails.
   */
  private async removeWorktreeStep(git: SimpleGit, worktreePath: string): Promise<CleanupStepOutcome> {
    const stat = await fs.lstat(worktreePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return { status: 'already_absent' };

    let gitError: string | undefined;
    try {
      // Git's normal non-force removal ignores ignored-only generated content,
      // while still refusing modified or untracked user data.
      if (!(await this.isGitClean(this.getGit(worktreePath)))) {
        return { status: 'failed', error: `Refusing to remove dirty worktree ${worktreePath}` };
      }
      await git.raw(['worktree', 'remove', worktreePath]);
      return { status: 'succeeded' };
    } catch (error: unknown) {
      const err = error as { message?: string };
      gitError = err.message || 'worktree removal failed';
      return { status: 'failed', error: gitError };
    }
  }

  private async isPathAbsent(targetPath: string): Promise<boolean> {
    try {
      await fs.lstat(targetPath);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }

  private async mergeOneRepo(options: {
    git: SimpleGit;
    branchName: string;
    policy: IntegrationPolicy;
    message: string | undefined;
    preserveConflicts: boolean;
    cleanupMode: 'none' | 'worktree' | 'worktree+branch';
    sourceCommit: string;
    expectedTarget: WorktreeTargetIdentity;
    sourceWorktreePath: string;
    precomputedCandidates?: TargetMergeCandidates;
    beforeMutation: () => Promise<void>;
    cleanupFn: (deleteBranch: boolean) => Promise<WorktreeCleanupOutcome>;
  }): Promise<RepoMergeResult> {
    const result = await integrateWorktreeRepository({
      targetGit: options.git,
      sourceGit: this.getGit(options.sourceWorktreePath),
      sourceBranch: options.branchName,
      sourceCommit: options.sourceCommit,
      expectedTarget: options.expectedTarget,
      sourceDiagnosticPath: options.sourceWorktreePath,
      excludedLocalPaths: worktreeOperationLocalPaths(this.config.hiveDir),
      precomputedCandidates: options.precomputedCandidates,
      beforeMutation: options.beforeMutation,
      policy: options.policy,
      message: options.message,
      preserveConflicts: options.preserveConflicts,
      cleanupMode: options.cleanupMode,
      cleanup: options.cleanupFn,
      readCommitMessage: this.readValidatedCommitMessage.bind(this),
    });
    return !result.merged && (result.reason === 'nothing_to_merge' || result.reason === 'already_integrated')
      ? { ...result, taskUpdateRecommended: true }
      : result;
  }

  private async readValidatedCommitMessage(git: SimpleGit, hash: string): Promise<string> {
    return readValidatedCommitMessage(git, hash);
  }

  async hasUncommittedChanges(feature: string, step: string, attemptSlot?: string): Promise<boolean> {
    await this.get(feature, step, attemptSlot);
    const manifest = await this.readWorkspaceManifest(feature, step, attemptSlot);
    if (manifest) {
      const compositeRoot = this.getCompositeRoot(feature, step, attemptSlot);
      for (const [, entry] of Object.entries(manifest.repos)) {
        const repoWt = path.join(compositeRoot, entry.path);
        try {
          const status = await this.getGit(repoWt).status();
          if (
            status.modified.length > 0 ||
            status.not_added.length > 0 ||
            status.staged.length > 0 ||
            status.deleted.length > 0 ||
            status.created.length > 0
          ) {
            return true;
          }
        } catch {
          // skip unreadable per-repo worktree
        }
      }
      return false;
    }

    const worktreePath = this.getWorktreePath(feature, step, attemptSlot);

    try {
      const worktreeGit = this.getGit(worktreePath);
      const status = await worktreeGit.status();
      return status.modified.length > 0 ||
             status.not_added.length > 0 ||
             status.staged.length > 0 ||
             status.deleted.length > 0 ||
             status.created.length > 0;
    } catch {
      return false;
    }
  }

}

export function createWorktreeService(projectDir: string): WorktreeService {
  return new WorktreeService({
    baseDir: projectDir,
    hiveDir: path.join(projectDir, ".hive"),
  });
}
