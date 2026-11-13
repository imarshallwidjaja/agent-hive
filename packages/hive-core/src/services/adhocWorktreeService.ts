import * as fs from 'fs/promises';
import * as path from 'path';
import simpleGit, { type SimpleGit } from 'simple-git';
import type { ResolvedRepository } from '../types.js';
import { projectRootsMatch } from '../utils/repositoryConfig.js';
import type {
  AdhocRunOrigin,
  AdhocWorkspaceManifest as AdhocCompositeManifest,
  SingleWorkspaceMetadata,
} from './workspaceManifest.js';
import { aggregateIntegrationProvenance, integrationRecorder, storedAdhocWorklog } from './integrationReceipt.js';
import type { IntegrationProvenanceOutcome, IntegrationRecorder } from './integrationReceipt.js';
import type { WorklogAuthor } from './worklogService.js';
import {
  adhocGroupEntryOwner,
  assertCreateConfirmed,
  assertNoSingleWorkerRecord,
  confirmWorkspaceRecord,
  createUnconfirmedRefusal,
  assertBranchUnclaimedInGroup,
  describesCompositeWorker,
  describesSingleWorker,
  finishCompositeWorkspace,
  isMetadataOnlyComposite,
  readCompositeWorkspaceManifest,
  readSingleWorkspaceMetadata,
  readWorkspaceRecordBytes,
  removeEmptyCompositeWorkspaceRoot,
  restoreWorkspaceRecord,
  retainedCompositeRefusal,
  unresolvedRecordNote,
  writeWorkspaceJsonAtomic,
} from './workspaceManifest.js';
import {
  buildCleanupOutcome,
  buildNotRequestedCleanupOutcome,
  buildNotRequestedMergeCleanupBlock,
  buildSkippedCleanupOutcome,
  buildThrownCleanupOutcome,
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
  releaseWorkerRecord,
  removeUnconfirmedWorktreeStep,
  rollbackFailedCreate,
  withFinalizationFailure,
  WorktreeOperationFinalizationError,
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
import { parseRetainedCheckoutId, projectRepositories } from './retainedCheckout.js';
import type { RetainedCheckoutContext } from './retainedCheckout.js';
import {
  createTargetedPlacement,
  inspectTargetBinding,
  mergeTargetedPlacement,
  readTargetedPlacement,
  removeTargetedPlacement,
  targetedRepositoryPath,
  targetedRunBranch,
} from './targetedPlacement.js';
import type { TargetBindingStatus, TargetedPlacement, TargetedPlacementSpec } from './targetedPlacement.js';
import type { TargetBinding } from './workspaceManifest.js';
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

export interface RepositoryResolver {
  resolveRepositories(): ResolvedRepository[];
}

export interface AdhocWorktreeConfig {
  baseDir: string;
  hiveDir: string;
  /** Optional repository manifest resolver. Required for composite (multi-repo) ad-hoc workspaces. */
  repositoryResolver?: RepositoryResolver | (() => ResolvedRepository[]);
}

export interface AdhocCreateOptions {
  /** Explicit run identifier. When omitted, a unique safe id is generated. */
  runId?: string;
  /** Required in manifest mode to select composite repositories; omit for a single-root project. */
  repoIds?: string[];
  /**
   * Retained checkout `<repoId>/<slug>` the run integrates into. The run is one
   * worktree in that repository, bound to the checkout's path and branch. With
   * `repoIds`, they must be exactly that repository.
   */
  target?: string;
  /** Targeted runs only: commit-ish to start from instead of the target's HEAD, resolved once to a commit. */
  baseRef?: string;
  /**
   * Host-supplied Worklog of the creating session, stamped into the run's record and later copied into its
   * integration receipts. A reused run keeps the origin of its first create. Never a tool argument.
   */
  origin?: AdhocRunOrigin;
}

export interface AdhocCreateTarget {
  runId: string;
  workspacePath: string;
}

export interface AdhocWorktreeRepoInfo {
  path: string;
  branch: string;
  commit: string;
  clean?: boolean;
  target?: WorktreeTargetIdentity | null;
  comparison?: WorktreeTargetComparison;
}

export type AdhocWorktreeMode = 'adhoc-single' | 'adhoc-composite' | 'adhoc-targeted';

export interface AdhocWorktreeInfo {
  runId: string;
  /** Single-root: per-worktree path. Composite: alias for workspacePath. */
  path: string;
  /** Single-root: per-worktree branch. Composite: branch of first repo (stable id order). */
  branch: string;
  /** Single-root: HEAD of the worktree. Composite: HEAD of first repo (stable id order). */
  commit: string;
  mode?: AdhocWorktreeMode;
  workspacePath?: string;
  repos?: Record<string, AdhocWorktreeRepoInfo>;
  baseCommits?: Record<string, string>;
  baseCommit?: string;
  clean?: boolean;
  /** Targeted runs: the repository the run's single worktree belongs to. */
  repoId?: string;
  /** Targeted runs: the retained checkout frozen as the integration target; inspection adds how the live checkout relates to it. */
  targetBinding?: TargetBinding & { status?: TargetBindingStatus; detail?: string };
  target?: WorktreeTargetIdentity | null;
  comparison?: WorktreeTargetComparison;
  /** Interrupted operations or pre-native lock files guarding this run or its repositories; inspection only. */
  pendingOperations?: PendingWorktreeOperation[];
  /**
   * The run's record still holds `createUnconfirmed`: the create that wrote it never confirmed the checkout as Hive's,
   * so it may be another Git client's. Merge refuses it (`CREATE_UNCONFIRMED`); cleanup still applies.
   */
  createUnconfirmed?: true;
  /** Create only: the run was created, but clearing its pending markers or releasing its locks then failed. */
  finalization?: WorktreeFinalizationFailure;
}

export type AdhocMergeStrategy = IntegrationStrategy;

export interface AdhocMergeOptions {
  /** Required declaration of source history handling; there is no default. */
  historyIntent: HistoryIntent;
  preserveConflicts?: boolean;
  cleanup?: 'none' | 'worktree' | 'worktree+branch';
  /** Exact source commits to integrate. A moved source is rejected before mutation. */
  sourceCommit?: string;
  sourceCommits?: Record<string, string>;
  expectedTarget?: WorktreeTargetIdentity;
  expectedTargets?: Record<string, WorktreeTargetIdentity>;
  /** Host-supplied session and agent of the caller, stamped on the integration receipt. Never a tool argument. */
  integratedBy?: WorklogAuthor;
}

export interface AdhocCleanupOptions {
  /** Explicitly discard an unintegrated branch. Never implied by normal cleanup. */
  discard?: boolean;
}

/** Merge-result cleanup block: per-step truth plus the legacy factual booleans. */
export interface AdhocMergeCleanupBlock extends WorktreeMergeCleanupBlock {}

export interface AdhocRepoMergeResult extends WorktreeRepositoryMergeResult {
  operationStatus?: 'success' | 'failed' | 'not_attempted';
}

export interface AdhocMergeResult {
  success: boolean;
  merged: boolean;
  /** The resolved strategy; omitted when intent/strategy validation failed before one was resolved. */
  strategy?: AdhocMergeStrategy;
  sha?: string;
  commitMessage?: string;
  reason?: string;
  reasonCode?: WorktreeReasonCode;
  cleanupEligible?: boolean;
  filesChanged: string[];
  conflicts: string[];
  conflictState: 'none' | 'aborted' | 'preserved';
  cleanup: AdhocMergeCleanupBlock;
  error?: string;
  /** Per-repo merge results when the workspace is a composite. */
  repos?: Record<string, AdhocRepoMergeResult>;
  /** True when at least one repo merged successfully and a later repo failed. */
  partial?: boolean;
  phase: WorktreeOperationPhase;
  mutation: WorktreeMutationState;
  retryable: boolean;
  action: WorktreeRecoveryAction;
  expectedTarget?: WorktreeTargetIdentity;
  observedTarget?: WorktreeTargetIdentity | null;
  /**
   * The integration receipt outcome when a commit was applied; composites aggregate their repositories. A failed
   * receipt keeps the Git result, skips cleanup and sets action inspect_state.
   */
  provenance?: IntegrationProvenanceOutcome;
  /** Present when the merge returned this result but clearing its pending markers or releasing its locks then failed. */
  finalization?: WorktreeFinalizationFailure;
}

export interface AdhocCleanupResult {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  pruned: boolean;
  /** Step-level cleanup truth; the three booleans above remain factual projections. */
  cleanup: WorktreeCleanupOutcome;
  phase: WorktreeOperationPhase;
  reasonCode?: WorktreeReasonCode;
  mutation: WorktreeMutationState;
  retryable: boolean;
  action: WorktreeRecoveryAction;
  /** Present when cleanup returned this result but clearing its pending markers or releasing its locks then failed. */
  finalization?: WorktreeFinalizationFailure;
}

function cleanupResultFromOutcome(
  outcome: WorktreeCleanupOutcome,
  reasonCode?: WorktreeReasonCode,
): AdhocCleanupResult {
  const classification = reasonCode
    ? classifyWorktreeOutcome(reasonCode, 'none')
    : {
      phase: 'cleanup' as WorktreeOperationPhase,
      reasonCode: undefined,
      mutation: 'none' as WorktreeMutationState,
      retryable: false,
      action: 'none' as WorktreeRecoveryAction,
    };
  return {
    ...cleanupFacts(outcome),
    cleanup: outcome,
    phase: classification.phase,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    mutation: classification.mutation,
    retryable: classification.retryable,
    action: classification.action,
  };
}

function mergeFailure(
  strategy: AdhocMergeStrategy | undefined,
  reasonCode: WorktreeReasonCode,
  error: string,
  options: {
    mutation?: WorktreeMutationState;
    conflicts?: string[];
    conflictState?: 'none' | 'aborted' | 'preserved';
    filesChanged?: string[];
    repos?: Record<string, AdhocRepoMergeResult>;
    partial?: boolean;
    expectedTarget?: WorktreeTargetIdentity;
    observedTarget?: WorktreeTargetIdentity | null;
  } = {},
): AdhocMergeResult {
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

interface RepositorySelection {
  /** Trusted repository paths the operation may touch; their common directories are locked. */
  repositoryPaths: string[];
}

interface RunRepositorySelection extends RepositorySelection {
  manifest: AdhocCompositeManifest | null;
  /** Whether the run is a targeted worker; its placement is reread by the operation. */
  targeted: boolean;
}

interface CreateRepositorySelection extends RepositorySelection {
  /** The requested repositories as resolved under the locks; null for a single-root run. */
  repositories: ResolvedRepository[] | null;
  /** The run's existing composite manifest, already checked against the requested repositories. */
  manifest: AdhocCompositeManifest | null;
}

function sameEntries(left: string[], right: string[]): boolean {
  return left.join('\n') === right.join('\n');
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Ad-hoc worktree service.
 *
 * Single-root mode: creates short-lived worktrees under
 * `.hive/.worktrees/adhoc/<runId>` on branch `hive/adhoc/<runId>`.
 *
 * Composite mode (when `repoIds` is provided): creates per-repo worktrees
 * under `.hive/.worktrees/adhoc/<runId>/repos/<repoId>` on branches
 * `hive/adhoc/<repoId>/<runId>` and writes a `workspace.json` manifest at
 * the workspace root only. No `.hive/features` writes in either mode.
 */
export class AdhocWorktreeService {
  private readonly config: AdhocWorktreeConfig;

  constructor(config: AdhocWorktreeConfig) {
    this.config = config;
  }

  private getGit(cwd?: string): SimpleGit {
    return simpleGit(cwd || this.config.baseDir);
  }

  /**
   * Lock order and selection rechecks are owned by `worktreeOperation.ts`: the
   * run's workspace lock first, then each selected repository's Git common
   * directory, sorted. Global task-worktree cleanup takes no workspace lock and
   * holds every repository lock, so the order never inverts.
   */
  private readRun<S extends RepositorySelection, T>(
    runId: string,
    select: () => Promise<S>,
    read: (selection: S, pending: PendingWorktreeOperation[]) => Promise<T>,
  ): Promise<T> {
    this.assertSafeRunId(runId);
    return withWorktreeRead({ hiveDir: this.config.hiveDir, workspacePath: this.getWorktreePath(runId), select, commonDirectory: (repositoryPath) => this.trustedGitCommonDirectory(repositoryPath), trustedRepositoryPaths: () => this.trustedRepositoryPaths() }, read);
  }

  /** The checkout this service works from and every manifest repository: the paths a pending operation record may name. */
  private trustedRepositoryPaths(): string[] {
    return [this.config.baseDir, ...(this.resolveRepositories() ?? []).map((repository) => repository.path)];
  }

  /**
   * Run a mutation under the operation guard. A result whose marker clearing
   * or lock release failed afterwards is returned with `finalization` rather
   * than lost to that failure.
   */
  private mutateRun<S extends RepositorySelection, T extends object>(
    kind: WorktreeOperationKind,
    runId: string,
    select: () => Promise<S>,
    operation: (selection: S, guard: WorktreeMutationGuard) => Promise<T>,
    outcomeKnown?: (result: T) => boolean,
  ): Promise<T> {
    this.assertSafeRunId(runId);
    return withWorktreeMutation({
      hiveDir: this.config.hiveDir,
      workspacePath: this.getWorktreePath(runId),
      select,
      commonDirectory: (repositoryPath) => this.trustedGitCommonDirectory(repositoryPath),
      trustedRepositoryPaths: () => this.trustedRepositoryPaths(),
      kind,
      subject: { type: 'adhoc', runId },
    }, operation, outcomeKnown).catch((error: unknown) => {
      if (error instanceof WorktreeOperationFinalizationError) return withFinalizationFailure(error.result as T, error.finalization);
      throw error;
    });
  }

  /** The repositories an operation on this run touches: its target's repository, its persisted composite selection, or the single root. */
  private async selectRunRepositories(runId: string): Promise<RunRepositorySelection> {
    const targetedPath = await targetedRepositoryPath(this.checkoutContext(), this.targetedSpec(runId));
    if (targetedPath !== null) return { manifest: null, targeted: true, repositoryPaths: [targetedPath] };
    const manifest = await this.readCompositeManifest(runId);
    return { manifest, targeted: false, repositoryPaths: this.workspaceRepositoryPaths(manifest, this.getWorktreePath(runId)) };
  }

  private checkoutContext(): RetainedCheckoutContext {
    return { hiveDir: this.config.hiveDir, repositories: projectRepositories(this.config.baseDir, this.resolveRepositories()) };
  }

  private targetedSpec(runId: string): TargetedPlacementSpec {
    return {
      mode: 'adhoc-targeted',
      worktreePath: this.getWorktreePath(runId),
      metadataPath: this.getSingleMetadataPath(runId),
      branch: targetedRunBranch(runId),
      owner: { runId },
      untargeted: { repositoryPath: this.config.baseDir, branch: this.getBranchName(runId) },
    };
  }

  private targetedInfo(runId: string, placement: TargetedPlacement, commit: string): AdhocWorktreeInfo {
    const { metadata } = placement;
    return {
      runId,
      path: metadata.worktreePath,
      branch: metadata.branch,
      commit,
      baseCommit: metadata.baseCommit,
      mode: 'adhoc-targeted',
      repoId: metadata.repoId,
      targetBinding: { ...metadata.target },
      ...(metadata.createUnconfirmed === true ? { createUnconfirmed: true as const } : {}),
    };
  }

  private async readTargetedRun(runId: string): Promise<{ placement: TargetedPlacement; info: AdhocWorktreeInfo | null } | null> {
    const placement = await readTargetedPlacement(this.checkoutContext(), this.targetedSpec(runId));
    if (!placement) return null;
    if (!placement.present) return { placement, info: null };
    const commit = (await this.getGit(placement.metadata.worktreePath).revparse(['HEAD'])).trim();
    return { placement, info: this.targetedInfo(runId, placement, commit) };
  }

  /** Read-only: skips the optional index refresh so inspection takes no index.lock. */
  private async isCompletelyClean(git: SimpleGit): Promise<boolean> {
    return (await git.raw(['--no-optional-locks', 'status', '--porcelain=v1', '--ignored'])).trim() === '';
  }

  private async isGitClean(git: SimpleGit): Promise<boolean> {
    return (await git.raw(['status', '--porcelain=v1'])).trim() === '';
  }

  private getAdhocRoot(): string {
    return path.join(this.config.hiveDir, '.worktrees', 'adhoc');
  }

  private getWorktreePath(runId: string): string {
    return path.join(this.getAdhocRoot(), runId);
  }

  private getCompositeRoot(runId: string): string {
    return path.join(this.getAdhocRoot(), runId);
  }

  private getCompositeRepoPath(runId: string, repoId: string): string {
    return path.join(this.getCompositeRoot(runId), 'repos', repoId);
  }

  private getWorkspaceManifestPath(runId: string): string {
    return path.join(this.getCompositeRoot(runId), 'workspace.json');
  }

  private getSingleMetadataPath(runId: string): string {
    return `${this.getWorktreePath(runId)}.json`;
  }

  private getBranchName(runId: string): string {
    return `hive/adhoc/${runId}`;
  }

  private getCompositeBranchName(repoId: string, runId: string): string {
    return `hive/adhoc/${repoId}/${runId}`;
  }

  private resolveRepositories(): ResolvedRepository[] | undefined {
    const resolver = this.config.repositoryResolver;
    if (!resolver) return undefined;
    return typeof resolver === 'function' ? resolver() : resolver.resolveRepositories();
  }

  private async trustedGitCommonDirectory(repositoryPath: string): Promise<string> {
    return trustedGitCommonDirectory(repositoryPath, this.getGit(repositoryPath));
  }

  private async lstatOrNull(candidate: string) {
    return fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new WorktreeLinkageError(`Worktree linkage preflight failed: cannot inspect path ${candidate}: ${error.message}`);
    });
  }

  private async validateExactWorktreeRegistration(
    worktreePath: string,
    trustedRepositoryPath: string,
    repositoryId: string,
  ): Promise<void> {
    await validateExactWorktreeRegistration(worktreePath, () => this.trustedGitCommonDirectory(trustedRepositoryPath), repositoryId);
  }

  /** The trusted repositories a run manifest selects, keyed by repository ID; only validated manifest entries. */
  private trustedRepositoriesForManifest(manifest: AdhocCompositeManifest): Map<string, ResolvedRepository> {
    const trustedRepositories = this.resolveRepositories();
    if (!trustedRepositories?.length) {
      throw new WorktreeLinkageError('Worktree linkage preflight failed: trusted repository topology is unavailable');
    }
    const trustedById = new Map(trustedRepositories.map((repository) => [repository.id, repository]));
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

  private workspaceRepositoryPaths(manifest: AdhocCompositeManifest | null, workspacePath: string): string[] {
    if (manifest) return [...this.trustedRepositoriesForManifest(manifest).values()].map((repository) => repository.path);
    const repositories = this.resolveRepositories();
    if (repositories?.length && !repositories.some(repository => projectRootsMatch(repository.path, this.config.baseDir))) {
      throw new WorktreeLinkageError(`Composite workspace manifest not found at ${path.join(workspacePath, 'workspace.json')}. Select an existing runId; manifest-backed workspaces require persisted repository placement.`);
    }
    return [this.config.baseDir];
  }

  private async readCompositeManifest(runId: string): Promise<AdhocCompositeManifest | null> {
    const compositeRoot = this.getCompositeRoot(runId);
    await assertNoSymlinkComponents(path.parse(compositeRoot).root, path.join(compositeRoot, 'workspace.json'), true);
    const manifest = await readCompositeWorkspaceManifest(compositeRoot);
    if (manifest === null) return null;
    if (!('runId' in manifest) || manifest.runId !== runId) {
      throw new WorktreeLinkageError(
        `Worktree linkage preflight failed: workspace manifest run identity does not match the requested ad-hoc run (${runId})`,
      );
    }
    return manifest.mode === 'adhoc-composite' ? manifest : null;
  }

  private async inspectSingleWorktree(runId: string): Promise<{ path: string; exists: boolean }> {
    const worktreePath = this.getWorktreePath(runId);
    await assertNoSymlinkComponents(path.parse(worktreePath).root, worktreePath, true);
    const stat = await this.lstatOrNull(worktreePath);
    if (!stat) return { path: worktreePath, exists: false };
    this.workspaceRepositoryPaths(null, worktreePath);
    await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'adhoc');
    return { path: worktreePath, exists: true };
  }

  /** The single-root sidecar of this run, or null when there is none; a sidecar naming another owner, path, repository or branch is refused. */
  private async readOwnSingleMetadata(runId: string): Promise<SingleWorkspaceMetadata | null> {
    const metadata = await readSingleWorkspaceMetadata(this.getSingleMetadataPath(runId));
    if (metadata && !describesSingleWorker(metadata, {
      owner: { runId },
      worktreePath: this.getWorktreePath(runId),
      repositoryPath: this.config.baseDir,
      branch: this.getBranchName(runId),
    })) {
      throw new WorktreeLinkageError('Worktree linkage preflight failed: single workspace metadata does not match the requested ad-hoc worktree');
    }
    return metadata;
  }

  /**
   * Refuse a removal of a single-root placement this run does not own, before anything changes, whether or not its
   * checkout is still there: a sidecar must name this run, and a placement without one must not be a task worker of
   * the feature named `adhoc`, which shares this directory. A sidecarless placement whose owner no record settles stays
   * removable by a call naming the run, as before sidecars. Returns the run's sidecar.
   */
  private async assertOwnSinglePlacement(runId: string): Promise<SingleWorkspaceMetadata | null> {
    const metadata = await this.readOwnSingleMetadata(runId);
    if (metadata) return metadata;
    // Task records live under the Hive root's features, also for a run made from a foreign checkout.
    const owner = await adhocGroupEntryOwner(path.dirname(this.config.hiveDir), this.config.hiveDir, runId);
    if (owner.owner === 'task') {
      throw new WorktreeLinkageError(`Worktree linkage preflight failed: ${this.getWorktreePath(runId)} is the worktree of task adhoc/${runId}, not an ad-hoc run`);
    }
    return null;
  }

  private async validateCompositeRepoRegistration(
    manifest: AdhocCompositeManifest,
    repoId: string,
    trustedRepositoryPath: string,
  ): Promise<boolean> {
    const entry = manifest.repos[repoId];
    const repoWtPath = path.join(this.getCompositeRoot(manifest.runId), entry.path);
    const stat = await this.lstatOrNull(repoWtPath);
    if (!stat) return false;
    await this.validateExactWorktreeRegistration(repoWtPath, trustedRepositoryPath, repoId);
    return this.isRegisteredWorktree(repoWtPath, entry.branch, trustedRepositoryPath);
  }

  private async preflightComposite(manifest: AdhocCompositeManifest): Promise<{
    trustedById: Map<string, ResolvedRepository>;
    registered: Record<string, boolean>;
  }> {
    const trustedById = this.trustedRepositoriesForManifest(manifest);
    const registered: Record<string, boolean> = {};
    for (const repoId of Object.keys(manifest.repos).sort()) {
      registered[repoId] = await this.validateCompositeRepoRegistration(
        manifest,
        repoId,
        trustedById.get(repoId)!.path,
      );
    }
    return { trustedById, registered };
  }

  private async inspectOneRepo(repoWtPath: string): Promise<{ sha: string; hasChanges: boolean }> {
    const git = this.getGit(repoWtPath);
    const status = await git.status();
    const sha = (await git.revparse(['HEAD'])).trim();
    return {
      sha,
      hasChanges:
        status.staged.length > 0 ||
        status.modified.length > 0 ||
        status.not_added.length > 0 ||
        status.deleted.length > 0 ||
        status.created.length > 0,
    };
  }

  private async validateCompositeManifest(manifest: AdhocCompositeManifest): Promise<boolean> {
    const { registered } = await this.preflightComposite(manifest);
    return Object.values(registered).every(Boolean);
  }

  private compositeInfoFromManifest(manifest: AdhocCompositeManifest): AdhocWorktreeInfo {
    const compositeRoot = this.getCompositeRoot(manifest.runId);
    const repos: Record<string, AdhocWorktreeRepoInfo> = {};
    const repoIds = Object.keys(manifest.repos).sort();
    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      repos[repoId] = {
        path: path.join(compositeRoot, entry.path),
        branch: entry.branch,
        commit: entry.commit,
      };
    }

    const first = repos[repoIds[0]];
    return {
      runId: manifest.runId,
      path: compositeRoot,
      branch: first.branch,
      commit: first.commit,
      mode: 'adhoc-composite',
      workspacePath: compositeRoot,
      repos,
      baseCommits: { ...manifest.baseCommits },
      ...(manifest.createUnconfirmed === true ? { createUnconfirmed: true as const } : {}),
    };
  }

  /** Refuse a manifest that does not name this run and its canonical branches, before any Git read for it. */
  private assertOwnComposite(manifest: AdhocCompositeManifest): void {
    if (!describesCompositeWorker(manifest, { owner: { runId: manifest.runId }, branch: (repoId) => this.getCompositeBranchName(repoId, manifest.runId) })) {
      throw new WorktreeLinkageError(`Worktree linkage preflight failed: workspace manifest ${this.getWorkspaceManifestPath(manifest.runId)} does not name the canonical branches of ad-hoc run ${manifest.runId}`);
    }
  }

  private async refreshCompositeInfo(manifest: AdhocCompositeManifest): Promise<AdhocWorktreeInfo | null> {
    this.assertOwnComposite(manifest);
    if (!(await this.validateCompositeManifest(manifest))) {
      return null;
    }

    const info = this.compositeInfoFromManifest(manifest);
    const repoIds = Object.keys(info.repos ?? {}).sort();
    for (const repoId of repoIds) {
      const repo = info.repos![repoId];
      repo.commit = (await this.getGit(repo.path).revparse(['HEAD'])).trim();
    }
    const first = info.repos![repoIds[0]];
    info.branch = first.branch;
    info.commit = first.commit;
    return info;
  }

  private async isRegisteredWorktree(worktreePath: string, branchName: string, gitCwd?: string): Promise<boolean> {
    try {
      const output = await this.getGit(gitCwd).raw(['worktree', 'list', '--porcelain']);
      const entries = output
        .split(/\n(?=worktree )/)
        .map((entry) => entry.trim())
        .filter(Boolean);

      return entries.some((entry) => {
        const lines = entry.split('\n');
        const listedPath = lines
          .find((line) => line.startsWith('worktree '))
          ?.slice('worktree '.length);
        const listedBranch = lines
          .find((line) => line.startsWith('branch '))
          ?.slice('branch refs/heads/'.length);

        return (
          listedPath !== undefined &&
          path.resolve(listedPath) === path.resolve(worktreePath) &&
          listedBranch === branchName
        );
      });
    } catch {
      return false;
    }
  }

  private assertSafeRunId(runId: string): void {
    if (!runId || !RUN_ID_PATTERN.test(runId)) {
      throw new Error(
        `Invalid runId: ${JSON.stringify(runId)}. Must match ${RUN_ID_PATTERN.source}`,
      );
    }
  }

  private assertSafeRepoId(repoId: string): void {
    if (!repoId || !REPO_ID_PATTERN.test(repoId)) {
      throw new Error(
        `Invalid repoId: ${JSON.stringify(repoId)}. Must match ${REPO_ID_PATTERN.source}`,
      );
    }
  }

  private generateRunId(): string {
    const ts = new Date()
      .toISOString()
      .replace(/[-:.]/g, '')
      .replace('T', '-')
      .replace('Z', '');
    const rand = Math.random().toString(36).slice(2, 8);
    return `${ts}-${rand}`;
  }

  resolveCreateTarget(options: Pick<AdhocCreateOptions, 'runId'> = {}): AdhocCreateTarget {
    const runId = options.runId ?? this.generateRunId();
    this.assertSafeRunId(runId);
    return { runId, workspacePath: this.getWorktreePath(runId) };
  }

  async create(options: AdhocCreateOptions = {}): Promise<AdhocWorktreeInfo> {
    const explicit = options.runId !== undefined;
    let runId: string;
    if (explicit) {
      runId = options.runId as string;
      this.assertSafeRunId(runId);
    } else {
      runId = this.generateRunId();
      // Defensive: generated ids must satisfy the same shape.
      this.assertSafeRunId(runId);
    }

    const repoIds = options.repoIds?.length ? options.repoIds : undefined;
    if (options.target !== undefined) return this.createTargeted(runId, options.target, repoIds, options.baseRef, options.origin);
    if (options.baseRef !== undefined) throw new Error('baseRef applies only to a targeted run; pass target as well');
    const selectRepositories = async (): Promise<CreateRepositorySelection> => {
      const resolved = this.resolveRepositories();
      // A run's binding outlives its worktree while its branch remains; that run stays targeted.
      const context = { hiveDir: this.config.hiveDir, repositories: projectRepositories(this.config.baseDir, resolved) };
      const bound = await readTargetedPlacement(context, this.targetedSpec(runId));
      if (bound) {
        throw new WorktreeTopologyMismatchError(
          `Ad-hoc run ${runId} is bound to retained checkout ${bound.metadata.target.id}; pass that target to reuse it, or clean the run up before creating another with this ID.`,
        );
      }
      const manifest = explicit && repoIds ? await this.readCompositeManifest(runId) : null;
      if (resolved?.length && !repoIds) {
        throw new WorktreeTopologyMismatchError('Ad-hoc worktree creation in a manifest-backed project requires repoIds; select the declared repositories for this run.');
      }
      if (!repoIds) return { repositoryPaths: [this.config.baseDir], repositories: null, manifest: null };
      const missing = repoIds.filter((repoId) => !resolved?.some((repository) => repository.id === repoId));
      if (missing.length > 0) {
        throw new Error(`Repository manifest is missing required repos for ad-hoc run ${runId}: ${missing.join(', ')}`);
      }
      if (manifest) {
        // Reusing a run must not widen or narrow the repositories it owns.
        const owned = Object.keys(manifest.repos).sort();
        const requested = [...new Set(repoIds)].sort();
        if (!sameEntries(owned, requested)) {
          throw new WorktreeTopologyMismatchError(
            `Ad-hoc run ${runId} owns repositories ${owned.join(', ')}; requested ${requested.join(', ')}. Pass the selection used at creation or start a new run.`,
          );
        }
      }
      const repositories = repoIds.map((repoId) => resolved!.find((repository) => repository.id === repoId)!);
      return {
        repositoryPaths: manifest
          ? this.workspaceRepositoryPaths(manifest, this.getCompositeRoot(runId))
          : repositories.map((repository) => repository.path),
        repositories,
        manifest,
      };
    };
    // Every effect uses the selection read under the locks, never a later resolver answer.
    return this.mutateRun('create', runId, selectRepositories, ({ repositories, manifest }, guard) => repositories
      ? this.createComposite(guard, runId, repositories, manifest, options.origin)
      : this.createSingle(guard, runId, explicit, options.origin));
  }

  private async createTargeted(runId: string, targetId: string, repoIds: string[] | undefined, baseRef: string | undefined, origin: AdhocRunOrigin | undefined): Promise<AdhocWorktreeInfo> {
    const { repoId } = parseRetainedCheckoutId(targetId);
    if (repoIds && (repoIds.length !== 1 || repoIds[0] !== repoId)) {
      throw new WorktreeTopologyMismatchError(`A run targeting ${targetId} works in repository ${repoId} only; repoIds must be omitted or exactly [${repoId}]`);
    }
    const select = async (): Promise<RepositorySelection> => {
      const repository = this.checkoutContext().repositories.find((candidate) => candidate.id === repoId);
      if (!repository) throw new WorktreeTopologyMismatchError(`Target ${targetId} names repository ${repoId}, which this project does not configure`);
      return { repositoryPaths: [repository.path] };
    };
    return this.mutateRun('create', runId, select, async (_selection, guard) => {
      const created = await createTargetedPlacement(guard, this.checkoutContext(), this.targetedSpec(runId), targetId, baseRef, undefined, origin);
      return this.targetedInfo(runId, created, created.commit);
    });
  }

  private async createSingle(
    guard: WorktreeMutationGuard,
    runId: string,
    explicit: boolean,
    origin: AdhocRunOrigin | undefined,
  ): Promise<AdhocWorktreeInfo> {
    const worktreePath = this.getWorktreePath(runId);
    const branchName = this.getBranchName(runId);
    const git = this.getGit();
    await assertNoSymlinkComponents(path.parse(worktreePath).root, worktreePath, true);

    const pathExists = await fs
      .access(worktreePath)
      .then(() => true)
      .catch(() => false);
    const branchPresent = (await readBranchOid(git, branchName)) !== null;

    const metadataPath = this.getSingleMetadataPath(runId);
    if (pathExists && branchPresent) {
      const record = await readSingleWorkspaceMetadata(metadataPath);
      assertCreateConfirmed(record, worktreePath, metadataPath, 'hive_adhoc_worktree_cleanup');
      let existing: AdhocWorktreeInfo | null = null;
      try {
        existing = await this.get(runId);
      } catch {
        existing = null;
      }
      if (explicit && existing) {
        // get() refuses a record that is not the run's own. A checkout without one, which another Git client may have
        // attached, is the run's only while no other record of the group names its branch.
        if (record === null) await assertBranchUnclaimedInGroup(worktreePath, branchName);
        return existing;
      }
      throw new Error(
        `Ad-hoc run collision: ${worktreePath} and ${branchName} already exist but do not match the requested ad-hoc worktree`,
      );
    }

    if (pathExists && !branchPresent) {
      throw new Error(
        `Ad-hoc worktree path already exists at ${worktreePath} without matching branch ${branchName}`,
      );
    }
    if (branchPresent && !pathExists) {
      throw new Error(
        `Branch collision: ${branchName} already exists but no worktree at ${worktreePath}`,
      );
    }

    // A record left at the placement may be another run's, a task's, one from another source repository, unreadable or
    // unconfirmed; none is replaced.
    const ownRecord = await this.readOwnSingleMetadata(runId);
    assertCreateConfirmed(ownRecord, worktreePath, metadataPath, 'hive_adhoc_worktree_cleanup');
    // Without a record of its own, the branch it would make may be one another record of the group still names.
    if (ownRecord === null) await assertBranchUnclaimedInGroup(worktreePath, branchName);
    const base = (await git.revparse(['HEAD'])).trim();
    await guard.begin({ repositories: [{ repositoryPath: this.config.baseDir, sourceWorktreePath: worktreePath, sourceBranch: branchName }] });
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    const metadata: SingleWorkspaceMetadata = {
      schemaVersion: 1,
      mode: 'adhoc-single',
      runId,
      worktreePath,
      repositoryPath: this.config.baseDir,
      branch: branchName,
      baseCommit: base,
      ...(origin !== undefined ? { origin } : {}),
    };
    // Published unconfirmed before `worktree add`, which can fail after another Git client attached a checkout of this
    // branch at the placement; confirmed only once this create's own add is validated.
    const priorMetadata = await readWorkspaceRecordBytes(metadataPath);
    try {
      await writeWorkspaceJsonAtomic(metadataPath, { ...metadata, createUnconfirmed: true });
    } catch (error) {
      if (await restoreWorkspaceRecord(metadataPath, priorMetadata)) guard.markOutcomeKnown();
      throw error;
    }

    try {
      await git.raw(['worktree', 'add', '-b', branchName, '--', worktreePath, base]);
    } catch (createError) {
      // A failed add leaves nothing only when neither the placement nor the branch exists; anything else may be another client's.
      const left = (await this.lstatOrNull(worktreePath).catch(() => true)) !== null
        || (await readBranchOid(git, branchName).catch(() => 'unreadable')) !== null;
      if (!left && await restoreWorkspaceRecord(metadataPath, priorMetadata)) guard.markOutcomeKnown();
      throw new Error(
        `Failed to create ad-hoc worktree: ${(createError as Error).message}`
        + (left ? `. A worktree or branch exists at the placement, so its metadata ${metadataPath} is kept unconfirmed; recover the operation, then clean the run up.` : ''),
        { cause: createError },
      );
    }

    try {
      await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'adhoc');
      const wtGit = this.getGit(worktreePath);
      const current = (await wtGit.revparse(['--abbrev-ref', 'HEAD'])).trim();
      const commit = (await wtGit.revparse(['HEAD'])).trim();
      if (current !== branchName || commit !== base) throw new Error(`Ad-hoc worktree ${worktreePath} is on ${current} at ${commit}, not ${branchName} at ${base}`);
      await confirmWorkspaceRecord(metadataPath, metadata);
    } catch (error) {
      // `worktree add -b` succeeded, so both the checkout and the branch are this create's.
      const leftovers = await rollbackFailedCreate(git, worktreePath, { name: branchName, tip: base, created: true }, true);
      if (leftovers.length === 0 && !(await restoreWorkspaceRecord(metadataPath, priorMetadata))) leftovers.push(`workspace metadata ${metadataPath}`);
      if (leftovers.length === 0) {
        guard.markOutcomeKnown();
        throw error;
      }
      throw new Error(`${(error as Error).message}; rollback left ${leftovers.join(', ')}${unresolvedRecordNote(error)}`, { cause: error });
    }

    return { runId, path: worktreePath, branch: branchName, commit: base, baseCommit: base, mode: 'adhoc-single' };
  }

  /**
   * Create a composite run in the repositories selected under the operation
   * locks. An existing manifest is the run's own, already checked against the
   * requested repositories; it is reused instead of creating anything.
   */
  private async createComposite(
    guard: WorktreeMutationGuard,
    runId: string,
    repositories: ResolvedRepository[],
    existingManifest: AdhocCompositeManifest | null,
    origin: AdhocRunOrigin | undefined,
  ): Promise<AdhocWorktreeInfo> {
    // Validate inputs
    for (const repository of repositories) this.assertSafeRepoId(repository.id);
    const stableRepoIds = repositories.map((repository) => repository.id).sort();
    const byId = new Map(repositories.map((repository) => [repository.id, repository]));

    const compositeRoot = this.getCompositeRoot(runId);
    await assertNoSymlinkComponents(path.parse(compositeRoot).root, compositeRoot, true);
    const manifestPath = this.getWorkspaceManifestPath(runId);
    assertCreateConfirmed(existingManifest, compositeRoot, manifestPath, 'hive_adhoc_worktree_cleanup');

    // Preflight: the workspace root must not hold content. An empty root is what
    // an interrupted create or root removal leaves; it holds nothing to preserve.
    const rootEntries = await fs.readdir(compositeRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (rootEntries && rootEntries.length > 0) {
      const existing = existingManifest ? await this.refreshCompositeInfo(existingManifest) : null;
      if (existing) return existing;
      if (existingManifest && await isMetadataOnlyComposite(compositeRoot, existingManifest, this.trustedRepositoriesForManifest(existingManifest))) {
        throw new Error(retainedCompositeRefusal(compositeRoot, 'hive_adhoc_worktree_cleanup'));
      }
      throw new Error(`Composite ad-hoc workspace already exists at ${compositeRoot}`);
    }
    await assertNoSingleWorkerRecord(compositeRoot, 'hive_adhoc_worktree_cleanup');

    // Preflight: no branch collisions in any target source repo
    const baseCommits: Record<string, string> = {};
    for (const repoId of stableRepoIds) {
      const repo = byId.get(repoId)!;
      const branchName = this.getCompositeBranchName(repoId, runId);
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
      baseCommits[repoId] = (await repoGit.revparse(['--verify', 'HEAD^{commit}'])).trim();
    }
    const manifest: AdhocCompositeManifest = {
      schemaVersion: 1,
      mode: 'adhoc-composite',
      runId,
      repos: Object.fromEntries(
        stableRepoIds.map((id) => {
          const repo = byId.get(id)!;
          return [
            id,
            {
              path: `repos/${id}`,
              repoRoot: repo.root,
              repoPath: repo.path,
              branch: this.getCompositeBranchName(id, runId),
              commit: baseCommits[id],
            },
          ];
        }),
      ),
      baseCommits,
      ...(origin !== undefined ? { origin } : {}),
    };

    await guard.begin({
      repositories: stableRepoIds.map((repoId) => ({
        repositoryPath: byId.get(repoId)!.path,
        repoId,
        sourceWorktreePath: this.getCompositeRepoPath(runId, repoId),
        sourceBranch: this.getCompositeBranchName(repoId, runId),
      })),
    });

    const createdRepos: Array<{
      repoId: string;
      branchName: string;
      git: SimpleGit;
      commit: string;
      attached: boolean;
    }> = [];
    const keptBranches: string[] = [];
    const repoInfos: Record<string, AdhocWorktreeRepoInfo> = {};

    try {
      await fs.mkdir(compositeRoot, { recursive: true });
      // Written unconfirmed before the first branch or worktree add, so an
      // interrupted create is a manifest-backed run the ad-hoc cleanup tool can
      // remove without deleting a populated checkout this create cannot show
      // it attached. Confirmed once every add is validated.
      await writeWorkspaceJsonAtomic(manifestPath, { ...manifest, createUnconfirmed: true });
      await fs.mkdir(path.join(compositeRoot, 'repos'), { recursive: true });
      for (const repoId of stableRepoIds) {
        const repo = byId.get(repoId)!;
        const repoWtPath = this.getCompositeRepoPath(runId, repoId);
        const branchName = this.getCompositeBranchName(repoId, runId);
        const repoGit = this.getGit(repo.path);

        await assertNoSymlinkComponents(path.parse(repoWtPath).root, repoWtPath, true);
        await fs.mkdir(path.dirname(repoWtPath), { recursive: true });

        // Only a branch this create made is rolled back; the preflight's absent branch can reappear from another Git client.
        const refusal = await createBranchExclusively(repoGit, branchName, baseCommits[repoId], repoId);
        if (refusal) {
          if (refusal.kept !== null) keptBranches.push(refusal.kept);
          throw new Error(`Failed to create ad-hoc worktree for repo ${repoId}: ${refusal.error}`);
        }
        const created = { repoId, branchName, git: repoGit, commit: baseCommits[repoId], attached: false };
        createdRepos.push(created);
        try {
          await repoGit.raw(['worktree', 'add', '--', repoWtPath, branchName]);
          created.attached = true;
        } catch (createError) {
          throw new Error(`Failed to create ad-hoc worktree for repo ${repoId}: ${createError}`);
        }
        const wtGit = this.getGit(repoWtPath);
        await this.validateExactWorktreeRegistration(repoWtPath, repo.path, repoId);
        const current = (await wtGit.revparse(['--abbrev-ref', 'HEAD'])).trim();
        const commit = (await wtGit.revparse(['HEAD'])).trim();
        if (current !== branchName || commit !== baseCommits[repoId]) {
          throw new Error(`Failed to create ad-hoc worktree for repo ${repoId}: ${repoWtPath} is on ${current} at ${commit}, not ${branchName} at ${baseCommits[repoId]}`);
        }
        repoInfos[repoId] = { path: repoWtPath, branch: branchName, commit };
      }
      await confirmWorkspaceRecord(manifestPath, manifest);

      const first = repoInfos[stableRepoIds[0]];
      return {
        runId,
        path: compositeRoot,
        branch: first.branch,
        commit: first.commit,
        mode: 'adhoc-composite',
        workspacePath: compositeRoot,
        repos: repoInfos,
        baseCommits,
      };
    } catch (createError) {
      const leftovers = [...keptBranches];
      for (const created of createdRepos) {
        leftovers.push(...await rollbackFailedCreate(
          created.git,
          this.getCompositeRepoPath(runId, created.repoId),
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
        || '. The workspace manifest was kept unconfirmed: after the operation is acknowledged, hive_adhoc_worktree_cleanup removes what is gone or empty and keeps a populated checkout';
      throw new Error(`${(createError as Error).message}; rollback left ${leftovers.join(', ')}${kept}.`, { cause: createError });
    }
  }

  async get(runId: string): Promise<AdhocWorktreeInfo | null> {
    this.assertSafeRunId(runId);

    const targeted = await this.readTargetedRun(runId);
    if (targeted) return targeted.info;
    const manifest = await this.readCompositeManifest(runId);
    if (manifest) return this.refreshCompositeInfo(manifest);

    const branchName = this.getBranchName(runId);
    const { path: worktreePath, exists } = await this.inspectSingleWorktree(runId);
    if (!exists) return null;
    if (!(await this.isRegisteredWorktree(worktreePath, branchName, this.config.baseDir))) return null;
    const git = this.getGit(worktreePath);
    const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (currentBranch !== branchName) return null;
    const commit = (await git.revparse(['HEAD'])).trim();
    const metadata = await this.readOwnSingleMetadata(runId);
    return {
      runId,
      path: worktreePath,
      branch: branchName,
      commit,
      ...(metadata ? { baseCommit: metadata.baseCommit } : {}),
      mode: 'adhoc-single',
      ...(metadata?.createUnconfirmed === true ? { createUnconfirmed: true as const } : {}),
    };
  }

  /** Inspect registration, branch, HEAD, and tracked/untracked/ignored dirt. */
  async inspect(runId: string): Promise<AdhocWorktreeInfo | null> {
    return this.readRun(runId, () => this.selectRunRepositories(runId), async ({ manifest }, pending) => {
      const info = await this.get(runId);
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

  /**
   * Integrate an ad-hoc worktree. `options.historyIntent` is required and
   * selects the permitted strategy; an omitted strategy resolves from the
   * intent (preserve-source: merge, rewrite-private: squash). Missing, unknown
   * or incompatible intent is rejected before any lock, Git read or mutation.
   */
  async merge(
    runId: string,
    strategy: AdhocMergeStrategy | undefined,
    message: string | undefined,
    options: AdhocMergeOptions,
  ): Promise<AdhocMergeResult> {
    const resolved = resolveIntegrationPolicy(options?.historyIntent, strategy);
    if ('error' in resolved) return mergeFailure(undefined, 'INVALID_ARGUMENTS', resolved.error);
    const optionFailure = rebasePreserveConflictsFailure(resolved.policy, options.preserveConflicts);
    if (optionFailure) return mergeFailure(resolved.policy.strategy, 'INVALID_ARGUMENTS', optionFailure);
    return this.mutateRun(
      'merge',
      runId,
      () => this.selectRunRepositories(runId),
      ({ manifest, targeted }, guard) => targeted
        ? this.mergeTargeted(guard, runId, resolved.policy, message, options)
        : this.mergeUnlocked(guard, runId, manifest, resolved.policy, message, options),
      isMutationOutcomeKnown,
    );
  }

  private async mergeTargeted(
    guard: WorktreeMutationGuard,
    runId: string,
    policy: IntegrationPolicy,
    message: string | undefined,
    options: AdhocMergeOptions,
  ): Promise<AdhocMergeResult> {
    const { strategy } = policy;
    if (strategy === 'rebase' && message?.trim()) {
      return mergeFailure(strategy, 'MESSAGE_NOT_ALLOWED_FOR_REBASE', 'Custom merge message is not supported for rebase strategy');
    }
    if (options.expectedTargets !== undefined || options.sourceCommits !== undefined) {
      return mergeFailure(strategy, 'INVALID_ARGUMENTS', 'A targeted run takes expectedTarget and sourceCommit, not per-repository maps');
    }
    if (options.expectedTarget === undefined) return mergeFailure(strategy, 'INVALID_ARGUMENTS', 'expectedTarget or expectedTargets is required');
    let placement: TargetedPlacement | null;
    try {
      placement = await readTargetedPlacement(this.checkoutContext(), this.targetedSpec(runId));
    } catch (error) {
      return mergeFailure(strategy, classifyThrownWorktreeError(error) ?? 'WORKTREE_LOOKUP_FAILED', error instanceof Error ? error.message : String(error));
    }
    if (!placement) return mergeFailure(strategy, 'WORKSPACE_TOPOLOGY_MISMATCH', `Ad-hoc run ${runId} is no longer a targeted run`);
    const result = await mergeTargetedPlacement({
      guard,
      context: this.checkoutContext(),
      spec: this.targetedSpec(runId),
      placement,
      policy,
      message,
      preserveConflicts: options.preserveConflicts ?? false,
      cleanupMode: options.cleanup ?? 'none',
      ...(options.sourceCommit !== undefined ? { sourceCommit: options.sourceCommit } : {}),
      expectedTarget: options.expectedTarget,
      recordIntegration: this.runRecorder(runId, placement.metadata.origin, options.integratedBy),
    });
    return { ...result, strategy };
  }

  /** Receipts name the run and the Worklog stamped at create; a missing or malformed stored origin leaves the bare run ID. */
  private runRecorder(runId: string, storedOrigin: unknown, integratedBy: WorklogAuthor | undefined): IntegrationRecorder {
    const worklog = storedAdhocWorklog(storedOrigin);
    return integrationRecorder(
      this.config.hiveDir,
      { kind: 'adhoc', runId, ...(worklog !== undefined ? { worklog } : {}) },
      integratedBy,
    );
  }

  private async mergeUnlocked(
    guard: WorktreeMutationGuard,
    runId: string,
    manifest: AdhocCompositeManifest | null,
    policy: IntegrationPolicy,
    message: string | undefined,
    options: AdhocMergeOptions,
  ): Promise<AdhocMergeResult> {
    const { strategy } = policy;
    const cleanupMode = options.cleanup ?? 'none';
    const preserveConflicts = options.preserveConflicts ?? false;

    if (strategy === 'rebase' && message?.trim()) {
      return mergeFailure(strategy, 'MESSAGE_NOT_ALLOWED_FOR_REBASE', 'Custom merge message is not supported for rebase strategy');
    }

    let targets: ReturnType<typeof validateTargetExpectations>;
    try {
      targets = validateTargetExpectations(manifest ? Object.keys(manifest.repos) : null, options.expectedTarget, options.expectedTargets);
    } catch (error) {
      return mergeFailure(strategy, 'INVALID_ARGUMENTS', error instanceof Error ? error.message : String(error));
    }
    if (manifest) {
      const unconfirmed = createUnconfirmedRefusal(manifest, this.getCompositeRoot(runId), this.getWorkspaceManifestPath(runId), 'hive_adhoc_worktree_cleanup', 'integrated');
      if (unconfirmed !== null) return mergeFailure(strategy, 'CREATE_UNCONFIRMED', unconfirmed, { partial: false });
      return this.mergeComposite(guard, runId, manifest, policy, message, {
        cleanup: cleanupMode,
        preserveConflicts,
        sourceCommits: options.sourceCommits,
        expectedTargets: targets.expectedTargets!,
        recordIntegration: this.runRecorder(runId, manifest.origin, options.integratedBy),
      });
    }

    return this.mergeSingle(guard, runId, policy, message, {
      cleanup: cleanupMode,
      preserveConflicts,
      sourceCommit: options.sourceCommit,
      expectedTarget: targets.expectedTarget!,
      integratedBy: options.integratedBy,
    });
  }

  private async mergeSingle(
    guard: WorktreeMutationGuard,
    runId: string,
    policy: IntegrationPolicy,
    message: string | undefined,
    options: {
      cleanup: 'none' | 'worktree' | 'worktree+branch';
      preserveConflicts: boolean;
      sourceCommit?: string;
      expectedTarget: WorktreeTargetIdentity;
      integratedBy?: WorklogAuthor;
    },
  ): Promise<AdhocMergeResult> {
    const { strategy } = policy;
    const branchName = this.getBranchName(runId);

    let registered: AdhocWorktreeInfo | null;
    try {
      registered = await this.get(runId);
    } catch (error) {
      // Only typed identity denials map to a fresh run. An untyped lookup
      // failure (transient filesystem or Git error) is inspectable state, not
      // evidence that the worktree identity is invalid.
      const reasonCode: WorktreeReasonCode = classifyThrownWorktreeError(error) ?? 'WORKTREE_LOOKUP_FAILED';
      return mergeFailure(
        strategy,
        reasonCode,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!registered) {
      return mergeFailure(
        strategy,
        'WORKTREE_NOT_REGISTERED',
        'Worktree linkage preflight failed: ad-hoc worktree is not registered',
      );
    }
    const unconfirmed = createUnconfirmedRefusal(registered, registered.path, this.getSingleMetadataPath(runId), 'hive_adhoc_worktree_cleanup', 'integrated');
    if (unconfirmed !== null) return mergeFailure(strategy, 'CREATE_UNCONFIRMED', unconfirmed);

    // A run without a record of its own may sit on a branch another record of the group names; it is refused here,
    // before any effect, since same-call cleanup after the integration would delete that branch under the wrong owner.
    let ownRecord: SingleWorkspaceMetadata | null;
    try {
      ownRecord = await this.readOwnSingleMetadata(runId);
      if (ownRecord === null) await assertBranchUnclaimedInGroup(registered.path, branchName);
    } catch (error) {
      return mergeFailure(strategy, 'WORKTREE_LINKAGE_INVALID', error instanceof Error ? error.message : String(error));
    }

    const git = this.getGit();
    const sourceCommit = options.sourceCommit ?? registered.commit;
    // The record's origin is untrusted; the recorder accepts only a well-formed one.
    const storedOrigin = ownRecord?.origin;
    const repoResult = await this.mergeOneRepo({
      git,
      branchName,
      policy,
      message,
      preserveConflicts: options.preserveConflicts,
      cleanupMode: options.cleanup,
      sourceCommit,
      expectedTarget: options.expectedTarget,
      sourceWorktreePath: registered.path,
      beforeMutation: () => guard.begin({
        strategy,
        repositories: [{ repositoryPath: this.config.baseDir, sourceWorktreePath: registered.path, sourceBranch: branchName, sourceCommit, expectedTarget: options.expectedTarget }],
      }),
      cleanupFn: async (deleteBranch: boolean) => (await this.cleanupSingle(guard, runId, deleteBranch, {}, sourceCommit)).cleanup,
      recordIntegration: this.runRecorder(runId, storedOrigin, options.integratedBy),
    });

    return { ...repoResult, strategy };
  }

  private async mergeComposite(
    guard: WorktreeMutationGuard,
    runId: string,
    manifest: AdhocCompositeManifest,
    policy: IntegrationPolicy,
    message: string | undefined,
    options: {
      cleanup: 'none' | 'worktree' | 'worktree+branch';
      preserveConflicts: boolean;
      sourceCommits?: Record<string, string>;
      expectedTargets: Record<string, WorktreeTargetIdentity>;
      recordIntegration: IntegrationRecorder;
    },
  ): Promise<AdhocMergeResult> {
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
    ): AdhocMergeResult => mergeFailure(strategy, reasonCode, `${repoId}: ${reason}`, {
      partial: false,
      ...(reasonCode === 'TARGET_MISMATCH' ? { expectedTarget: options.expectedTargets[repoId], observedTarget: observedTarget ?? null } : {}),
    });

    // Preflight: every selected repository validates against the trusted current
    // topology before any source repo is mutated.
    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      const trusted = trustedById.get(repoId)!;
      const expectedBranch = this.getCompositeBranchName(repoId, runId);
      if (entry.branch !== expectedBranch) {
        return preflightFailure(repoId, 'manifest branch does not match the canonical ad-hoc branch', 'WORKSPACE_TOPOLOGY_MISMATCH');
      }
      if (!(await this.validateCompositeRepoRegistration(manifest, repoId, trusted.path))) {
        return preflightFailure(repoId, 'registered worktree not found', 'WORKTREE_NOT_REGISTERED');
      }
      const repoRoot = trusted.path;
      const repoGit = this.getGit(repoRoot);
      const repoWtPath = path.join(this.getCompositeRoot(runId), entry.path);
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
      repositories: repoIds.map((repoId) => ({
        repositoryPath: trustedById.get(repoId)!.path,
        repoId,
        sourceWorktreePath: path.join(this.getCompositeRoot(runId), manifest.repos[repoId].path),
        sourceBranch: manifest.repos[repoId].branch,
        sourceCommit: pinnedSourceCommits[repoId],
        expectedTarget: options.expectedTargets[repoId],
      })),
    });

    // Execute per-repo merges in stable id order
    const repos: Record<string, AdhocRepoMergeResult> = {};
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
      const repoGit = this.getGit(trustedById.get(repoId)!.path);
      const repoResult = await this.mergeOneRepo({
        git: repoGit,
        branchName: entry.branch,
        policy,
        message,
        preserveConflicts: options.preserveConflicts,
        cleanupMode: 'none',
        sourceCommit: pinnedSourceCommits[repoId],
        expectedTarget: options.expectedTargets[repoId],
        sourceWorktreePath: path.join(this.getCompositeRoot(runId), entry.path),
        precomputedCandidates: precomputedCandidates[repoId],
        beforeMutation: beginMerge,
        cleanupFn: async () => buildNotRequestedCleanupOutcome(),
        recordIntegration: options.recordIntegration,
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
      const partial = anyActualMerge;
      const stopped = repos[stoppedRepoId];
      const reasonCode: WorktreeReasonCode = partial
        ? 'COMPOSITE_PARTIAL'
        : (stopped.reasonCode ?? 'GIT_OPERATION_FAILED');
      const failure = mergeFailure(strategy, reasonCode, firstError ?? 'merge failed', {
        mutation: partial ? 'partial' : stopped.mutation,
        filesChanged: flattenedFiles,
        conflicts: flattenedConflicts,
        conflictState: lastConflictState,
        repos,
        partial,
      });
      // Receipts of repositories integrated before the stop stay visible beside the Git failure.
      const { provenance: partialProvenance } = aggregateIntegrationProvenance(repoIds, repos);
      return partialProvenance !== undefined ? { ...failure, provenance: partialProvenance } : failure;
    }

    // All repos merged -> apply cleanup (all repos passed preflight above)
    const { provenance, cleanupFailure: provenanceCleanupFailure } = aggregateIntegrationProvenance(repoIds, repos);
    let cleanup = buildNotRequestedCleanupOutcome();
    if (options.cleanup !== 'none') {
      const cleanupMode = options.cleanup;
      const deleteBranch = cleanupMode === 'worktree+branch';
      const perRepo: Array<{ repoId: string; cleanup: AdhocCleanupResult }> = [];
      // A failed receipt in any repository keeps the whole workspace; earlier receipts stay.
      let proofFailure: { repoId: string; step: string; cause: string } | undefined = provenanceCleanupFailure;
      // Every repository proves its completed work before any repository is cleaned up.
      for (const repoId of proofFailure ? [] : repoIds) {
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
        let repoCleanup: AdhocCleanupResult;
        if (proofFailure) {
          repoCleanup = cleanupResultFromOutcome(buildSkippedCleanupOutcome(cleanupMode, proofFailure), 'CLEANUP_FAILED');
        } else {
          try {
            repoCleanup = await this.removeCompositeRepo(
              guard,
              runId,
              repoId,
              trustedById.get(repoId)!.path,
              deleteBranch,
              {},
              pinnedSourceCommits[repoId],
            );
          } catch (error) {
            repoCleanup = cleanupResultFromOutcome(buildThrownCleanupOutcome(cleanupMode, error, repoId), 'CLEANUP_FAILED');
          }
        }
        // The repository merged with its cleanup deferred, so its classification is recomputed with the cleanup it got.
        // A failed receipt anywhere holds every repository for inspection, as the aggregate result reports.
        Object.assign(repos[repoId], {
          cleanup: toMergeCleanupBlock(repoCleanup.cleanup),
          ...mergeSuccessClassification(cleanupMode, repoCleanup.cleanup, repos[repoId].mutation, provenanceCleanupFailure ? provenance : repos[repoId].provenance),
        });
        perRepo.push({ repoId, cleanup: repoCleanup });
      }
      let rootFailure: { cause: string } | undefined;
      if (!proofFailure && perRepo.every(({ cleanup }) => cleanup.cleanup.outcome === 'complete')) {
        rootFailure = await finishCompositeWorkspace(this.getCompositeRoot(runId), manifest, this.compositeBranches(manifest, trustedById), deleteBranch, 'hive_adhoc_worktree_cleanup');
      }
      cleanup = combineRepoCleanupOutcomes(
        options.cleanup,
        perRepo.map((entry) => ({ repoId: entry.repoId, cleanup: entry.cleanup.cleanup })),
        rootFailure,
      );
    }

    if (!anyActualMerge) {
      // `reason` keeps what each repository's integration found; a cleanup failure replaces only its reasonCode.
      const allContained = repoIds.every((repoId) => repos[repoId].reason === 'already_integrated');
      return {
        success: true,
        merged: false,
        strategy,
        ...(allContained
          ? { reason: 'already_integrated', reasonCode: 'ALREADY_INTEGRATED' as const }
          : { reason: 'nothing_to_merge', reasonCode: 'NO_TRACKED_CHANGES' as const }),
        cleanupEligible: true,
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
      ...(provenance !== undefined ? { provenance } : {}),
      ...mergeSuccessClassification(options.cleanup, cleanup, 'applied', provenance),
      repos,
    };
  }

  /** The worker branch of each repository a composite run owns, for deciding whether its manifest may go. */
  private compositeBranches(manifest: AdhocCompositeManifest, trustedById: Map<string, ResolvedRepository>): Array<{ repoId: string; git: SimpleGit; name: string }> {
    return Object.keys(manifest.repos).sort().map((repoId) => ({
      repoId,
      git: this.getGit(trustedById.get(repoId)!.path),
      name: this.getCompositeBranchName(repoId, manifest.runId),
    }));
  }

  private async removeCompositeRepo(
    guard: WorktreeMutationGuard,
    runId: string,
    repoId: string,
    trustedRepositoryPath: string,
    deleteBranch: boolean,
    options: AdhocCleanupOptions = {},
    expectedBranchCommit?: string,
  ): Promise<AdhocCleanupResult> {
    const repoWtPath = this.getCompositeRepoPath(runId, repoId);
    const repoGit = this.getGit(trustedRepositoryPath);
    const branchName = this.getCompositeBranchName(repoId, runId);
    const unconfirmed = (await this.readCompositeManifest(runId))?.createUnconfirmed === true;

    let branchPreparationError: string | undefined;
    let pinnedBranchCommit = expectedBranchCommit;
    if (deleteBranch && !pinnedBranchCommit) {
      try {
        pinnedBranchCommit = await this.prepareBranchDeletion(repoGit, branchName, options.discard === true);
      } catch (error) {
        branchPreparationError = (error as Error).message;
      }
    }
    await guard.begin({ repositories: [{ repositoryPath: trustedRepositoryPath, repoId, sourceWorktreePath: repoWtPath, sourceBranch: branchName }] });
    const worktreeRemoval = unconfirmed
      ? await removeUnconfirmedWorktreeStep(repoGit, repoWtPath, branchName)
      : await this.removeWorktreeStep(repoGit, repoWtPath);
    const outcome = buildCleanupOutcome(deleteBranch ? 'worktree+branch' : 'worktree', {
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
    return cleanupResultFromOutcome(outcome);
  }

  /**
   * Remove one registered worktree. Reports already_absent when the path is
   * gone, and captures the underlying cause when removal fails.
   */
  private async removeWorktreeStep(git: SimpleGit, worktreePath: string): Promise<CleanupStepOutcome> {
    const stat = await this.lstatOrNull(worktreePath);
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

  /**
   * Delete one branch. Reports already_absent when the branch is already gone
   * so a partially repeated cleanup still describes reality.
   */
  private async prepareBranchDeletion(git: SimpleGit, branchName: string, discard: boolean): Promise<string | undefined> {
    return prepareBranchDeletion(git, branchName, discard, '');
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
    recordIntegration: IntegrationRecorder;
  }): Promise<AdhocRepoMergeResult> {
    return integrateWorktreeRepository({
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
      recordIntegration: options.recordIntegration,
    });
  }

  private async readValidatedCommitMessage(git: SimpleGit, hash: string): Promise<string> {
    return readValidatedCommitMessage(git, hash);
  }

  private async cleanupComposite(
    guard: WorktreeMutationGuard,
    manifest: AdhocCompositeManifest,
    deleteBranch: boolean,
    options: AdhocCleanupOptions = {},
  ): Promise<AdhocCleanupResult> {
    this.assertOwnComposite(manifest);
    const trustedById = this.trustedRepositoriesForManifest(manifest);
    const repoIds = Object.keys(manifest.repos).sort();
    for (const repoId of repoIds) {
      const repositoryPath = trustedById.get(repoId)!.path;
      const branchName = this.getCompositeBranchName(repoId, manifest.runId);
      const repoWtPath = this.getCompositeRepoPath(manifest.runId, repoId);
      const stat = await this.lstatOrNull(repoWtPath);
      if (!stat) continue;
      await this.validateExactWorktreeRegistration(repoWtPath, repositoryPath, repoId);
      if (!(await this.isRegisteredWorktree(repoWtPath, branchName, repositoryPath))) {
        const outcome = buildCleanupOutcome(deleteBranch ? 'worktree+branch' : 'worktree', {
          worktreeRemoval: { status: 'not_attempted' },
          branchDeletion: { status: 'not_attempted' },
          prune: { status: 'not_attempted' },
          failures: [{
            step: 'preflight',
            repoId,
            cause: `registered worktree branch does not match for repository ${repoId}`,
          }],
        });
        return cleanupResultFromOutcome(outcome, 'CLEANUP_FAILED');
      }
    }

    const perRepo: Array<{ repoId: string; cleanup: AdhocCleanupResult }> = [];
    for (const repoId of repoIds) {
      const perRepoResult = await this.removeCompositeRepo(
        guard,
        manifest.runId,
        repoId,
        trustedById.get(repoId)!.path,
        deleteBranch,
        options,
      );
      perRepo.push({ repoId, cleanup: perRepoResult });
    }
    const compositeRoot = this.getCompositeRoot(manifest.runId);
    let rootFailure: { cause: string } | undefined;
    if (perRepo.every(({ cleanup }) => cleanup.cleanup.outcome === 'complete')) {
      rootFailure = await finishCompositeWorkspace(compositeRoot, manifest, this.compositeBranches(manifest, trustedById), deleteBranch, 'hive_adhoc_worktree_cleanup');
    }
    const requested = deleteBranch ? 'worktree+branch' : 'worktree';
    const outcome = combineRepoCleanupOutcomes(
      requested,
      perRepo.map((entry) => ({ repoId: entry.repoId, cleanup: entry.cleanup.cleanup })),
      rootFailure,
    );
    return cleanupResultFromOutcome(outcome, outcome.outcome === 'complete' ? undefined : 'CLEANUP_FAILED');
  }

  async cleanup(runId: string, deleteBranch = false, options: AdhocCleanupOptions = {}): Promise<AdhocCleanupResult> {
    return this.mutateRun(
      'cleanup',
      runId,
      () => this.selectRunRepositories(runId),
      async ({ manifest, targeted }, guard) => {
        if (targeted) {
          const placement = await readTargetedPlacement(this.checkoutContext(), this.targetedSpec(runId));
          if (!placement) throw new WorktreeTopologyMismatchError(`Ad-hoc run ${runId} is no longer a targeted run`);
          const outcome = await removeTargetedPlacement(guard, this.targetedSpec(runId), placement, deleteBranch, { discard: options.discard === true });
          return cleanupResultFromOutcome(outcome, outcome.outcome === 'complete' ? undefined : 'CLEANUP_FAILED');
        }
        return manifest
          ? this.cleanupComposite(guard, manifest, deleteBranch, options)
          : this.cleanupSingle(guard, runId, deleteBranch, options);
      },
    );
  }

  private async cleanupSingle(
    guard: WorktreeMutationGuard,
    runId: string,
    deleteBranch: boolean,
    options: AdhocCleanupOptions,
    expectedBranchCommit?: string,
  ): Promise<AdhocCleanupResult> {
    const worktreePath = this.getWorktreePath(runId);
    const branchName = this.getBranchName(runId);
    await assertNoSymlinkComponents(path.parse(worktreePath).root, worktreePath, true);
    const ownRecord = await this.assertOwnSinglePlacement(runId);
    const unconfirmed = ownRecord?.createUnconfirmed === true;
    const stat = await this.lstatOrNull(worktreePath);
    const requested = deleteBranch ? 'worktree+branch' : 'worktree';
    if (stat) {
      await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'adhoc');
      // A confirmed checkout switched to another branch may hold work on that branch; an unconfirmed one keeps the
      // stricter removal of a checkout this run cannot show it attached.
      if (!unconfirmed && !(await this.isRegisteredWorktree(worktreePath, branchName, this.config.baseDir))) {
        const current = (await this.getGit(worktreePath).raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim() || 'a detached HEAD';
        return cleanupResultFromOutcome(buildCleanupOutcome(requested, {
          worktreeRemoval: { status: 'not_attempted' },
          branchDeletion: { status: 'not_attempted' },
          prune: { status: 'not_attempted' },
          failures: [{ step: 'preflight', cause: `${worktreePath} is on ${current}, not ${branchName}; switch it back or keep its work on a branch, then clean up again` }],
        }), 'CLEANUP_FAILED');
      }
    }
    const git = this.getGit();
    let branchPreparationError: string | undefined;
    let pinnedBranchCommit = expectedBranchCommit;
    if (deleteBranch && !pinnedBranchCommit) {
      // Without a record of its own, the branch may be the one another record of the group names.
      if (ownRecord === null) await assertBranchUnclaimedInGroup(worktreePath, branchName);
      try {
        pinnedBranchCommit = await this.prepareBranchDeletion(git, branchName, options.discard === true);
      } catch (error) {
        branchPreparationError = (error as Error).message;
      }
    }
    await guard.begin({ repositories: [{ repositoryPath: this.config.baseDir, sourceWorktreePath: worktreePath, sourceBranch: branchName }] });
    const worktreeRemoval = !stat
      ? { status: 'already_absent' as const }
      : unconfirmed
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
    // The record stays with a remaining branch, so the branch keeps a known owner for inventory and a later cleanup.
    // An unconfirmed one also keeps a checkout another client later attaches to that branch reading as unconfirmed.
    const released = await releaseWorkerRecord(git, branchName, this.getSingleMetadataPath(runId), outcome);
    return cleanupResultFromOutcome(released, released.outcome === 'complete' ? undefined : 'CLEANUP_FAILED');
  }

}
