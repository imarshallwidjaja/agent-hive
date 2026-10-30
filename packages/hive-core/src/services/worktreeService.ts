import * as fs from "fs/promises";
import * as path from "path";
import simpleGit, { SimpleGit } from "simple-git";
import type { ResolvedRepository, TaskStatus } from "../types.js";
import { readJson, resolveFeatureDirectoryName } from "../utils/paths.js";
import { projectRootsMatch } from '../utils/repositoryConfig.js';
import { validateStoredTaskStatus } from './taskService.js';
import type {
  TaskWorkspaceManifest as WorkspaceManifest,
  SingleWorkspaceMetadata,
} from './workspaceManifest.js';
import { readCompositeWorkspaceManifest, readSingleWorkspaceMetadata, writeWorkspaceJsonAtomic } from './workspaceManifest.js';
import {
  buildCleanupOutcome,
  buildNotRequestedCleanupOutcome,
  buildNotRequestedMergeCleanupBlock,
  buildSkippedCleanupOutcome,
  buildThrownCleanupOutcome,
  CleanupActionError,
  cleanupFacts,
  cleanupStepDone,
  classifyThrownWorktreeError,
  classifyWorktreeOutcome,
  combineRepoCleanupOutcomes,
  isMutationOutcomeKnown,
  isRetryableWithMutation,
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
  proveCleanupEligibility,
  readValidatedCommitMessage,
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

export type WorktreeMode = 'legacy' | 'composite';

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
  target?: WorktreeTargetIdentity | null;
  comparison?: WorktreeTargetComparison;
  /** Interrupted operations or pre-native lock files guarding this workspace or its repositories; inspection only. */
  pendingOperations?: PendingWorktreeOperation[];
  /** Create only: the worktree was created, but clearing its pending markers or releasing its locks then failed. */
  finalization?: WorktreeFinalizationFailure;
}

export interface WorktreeListError {
  path: string;
  reason: string;
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
}

interface CreateRepositorySelection extends RepositorySelection {
  composite: { repos: ResolvedRepository[]; repoIds: string[] } | null;
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
    const manifest = await this.readWorkspaceManifest(feature, step, attemptSlot);
    return {
      manifest,
      repositoryPaths: this.workspaceRepositoryPaths(manifest, this.getWorktreePath(feature, step, attemptSlot)),
    };
  }

  /** Read-only: skips the optional index refresh so inspection takes no index.lock. */
  private async isCompletelyClean(git: SimpleGit): Promise<boolean> {
    return (await git.raw(['--no-optional-locks', 'status', '--porcelain=v1', '--ignored'])).trim() === '';
  }

  private async isGitClean(git: SimpleGit): Promise<boolean> {
    return (await git.raw(['status', '--porcelain=v1'])).trim() === '';
  }

  private async removeEmptyWorkspaceRoot(workspaceRoot: string): Promise<void> {
    const reposPath = path.join(workspaceRoot, 'repos');
    const remaining = await fs.readdir(reposPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (remaining.length > 0) throw new Error(`Composite workspace still contains repositories: ${remaining.join(', ')}`);
    const entries = await fs.readdir(workspaceRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (entries.length === 0) return;
    const unexpected = entries.filter((entry) => entry !== 'repos' && entry !== 'workspace.json');
    if (unexpected.length > 0) throw new Error(`Composite workspace contains unexpected entries: ${unexpected.join(', ')}`);
    await fs.rmdir(reposPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    const manifestPath = path.join(workspaceRoot, 'workspace.json');
    const heldManifestPath = `${workspaceRoot}.workspace.json.cleanup-${process.pid}-${Date.now()}`;
    let manifestHeld = false;
    await fs.rename(manifestPath, heldManifestPath).then(() => {
      manifestHeld = true;
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    try {
      await fs.rmdir(workspaceRoot);
    } catch (error) {
      if (manifestHeld) {
        await fs.rename(heldManifestPath, manifestPath).catch((restoreError: unknown) => {
          throw new Error(`Composite root removal failed and manifest restore failed: ${(error as Error).message}; ${(restoreError as Error).message}`);
        });
      }
      throw error;
    }
    if (manifestHeld) {
      await fs.unlink(heldManifestPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
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
    const featureDir = resolveFeatureDirectoryName(this.config.baseDir, feature);
    const featurePath = path.join(this.config.hiveDir, "features", featureDir);

    const tasksPath = path.join(featurePath, "tasks", step, "status.json");
    try {
      await fs.access(tasksPath);
      return tasksPath;
    } catch {}

    return path.join(featurePath, "execution", step, "status.json");
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
    if (composite && await this.readWorkspaceManifest(feature, step, attemptSlot)) {
      await this.get(feature, step, attemptSlot);
    }
    return this.mutate(
      'create',
      { feature, step, attemptSlot },
      () => this.selectCreateRepositories(feature, step, attemptSlot),
      ({ composite: selected }, guard) => selected
        ? this.createComposite(guard, feature, step, selected.repos, selected.repoIds, baseBranch, attemptSlot)
        : this.createLegacy(guard, feature, step, baseBranch, attemptSlot),
    );
  }

  /** The repositories task worktree creation touches: an existing workspace's persisted selection, else the task's declared repositories. */
  private async selectCreateRepositories(feature: string, step: string, attemptSlot?: string): Promise<CreateRepositorySelection> {
    const composite = await this.isCompositeTask(feature, step);
    if (!composite) return { composite, repositoryPaths: [this.config.baseDir] };
    const manifest = await this.readWorkspaceManifest(feature, step, attemptSlot);
    if (manifest) {
      return { composite, repositoryPaths: this.workspaceRepositoryPaths(manifest, this.getCompositeRoot(feature, step, attemptSlot)) };
    }
    const byId = new Map(composite.repos.map(repository => [repository.id, repository]));
    const missing = composite.repoIds.filter(id => !byId.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Repository manifest is missing required repos for task ${feature}/${step}: ${missing.join(', ')}`,
      );
    }
    return { composite, repositoryPaths: composite.repoIds.map(id => byId.get(id)!.path) };
  }

  private async createLegacy(guard: WorktreeMutationGuard, feature: string, step: string, baseBranch?: string, attemptSlot?: string): Promise<WorktreeInfo> {
    const worktreePath = this.getWorktreePath(feature, step, attemptSlot);
    await assertNoSymlinkComponents(path.parse(worktreePath).root, worktreePath, true);
    const branchName = this.getLegacyBranchName(feature, step, attemptSlot);
    const git = this.getGit();

    const existing = await this.get(feature, step, attemptSlot);
    if (existing) {
      return existing;
    }

    const base = baseBranch || (await git.revparse(["HEAD"])).trim();
    await guard.begin({ repositories: [{ repositoryPath: this.config.baseDir, sourceWorktreePath: worktreePath, sourceBranch: branchName }] });
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });

    try {
      await git.raw(["worktree", "add", "-b", branchName, "--", worktreePath, base]);
    } catch {
      try {
        await git.raw(["worktree", "add", "--", worktreePath, branchName]);
      } catch (retryError) {
        throw new Error(`Failed to create worktree: ${retryError}`);
      }
    }

    const worktreeGit = this.getGit(worktreePath);
    await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'legacy');
    const commit = (await worktreeGit.revparse(["HEAD"])).trim();
    const metadata: SingleWorkspaceMetadata = {
      schemaVersion: 1,
      mode: 'single',
      feature,
      task: step,
      worktreePath,
      repositoryPath: this.config.baseDir,
      branch: branchName,
      baseCommit: commit,
    };
    try {
      await writeWorkspaceJsonAtomic(this.getSingleMetadataPath(feature, step, attemptSlot), metadata);
    } catch (error) {
      const removed = await git.raw(['worktree', 'remove', worktreePath]).then(() => true).catch(() => false);
      if (removed) {
        const pruned = await git.raw(['worktree', 'prune']).then(() => true).catch(() => false);
        if (cleanupStepDone(await this.deleteBranchStep(git, branchName, commit)) && pruned) guard.markOutcomeKnown();
      }
      throw error;
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

  private async createComposite(
    guard: WorktreeMutationGuard,
    feature: string,
    step: string,
    repos: ResolvedRepository[],
    repoIds: string[],
    baseBranch?: string,
    attemptSlot?: string,
  ): Promise<WorktreeInfo> {
    // Existing composite workspace -> return aggregate info
    const existing = await this.readWorkspaceManifest(feature, step, attemptSlot)
      ? await this.get(feature, step, attemptSlot)
      : null;
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

    // Preflight: no existing composite root, and no branch collisions in any target repo
    const compositeRoot = this.getCompositeRoot(feature, step, attemptSlot);
    let compositeRootExists = false;
    try {
      await fs.access(compositeRoot);
      compositeRootExists = true;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code && err.code !== 'ENOENT') {
        throw e;
      }
    }
    if (compositeRootExists) {
      throw new Error(`Composite workspace already exists at ${compositeRoot}`);
    }

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
    }

    await guard.begin({
      repositories: repoIds.map(repoId => ({
        repositoryPath: byId.get(repoId)!.path,
        repoId,
        sourceWorktreePath: this.getRepoWorktreePath(feature, step, repoId, attemptSlot),
        sourceBranch: this.getRepoBranchName(repoId, feature, step, attemptSlot),
      })),
    });
    await fs.mkdir(compositeRoot, { recursive: true });
    await fs.mkdir(path.join(compositeRoot, 'repos'), { recursive: true });

    const createdRepos: Array<{ repoId: string; branchName: string; git: SimpleGit; commit: string }> = [];
    const repoInfos: Record<string, WorktreeRepoInfo> = {};
    const baseCommits: Record<string, string> = {};

    try {
      for (const repoId of repoIds) {
        const repo = byId.get(repoId)!;
        const repoWtPath = this.getRepoWorktreePath(feature, step, repoId, attemptSlot);
        const branchName = this.getRepoBranchName(repoId, feature, step, attemptSlot);
        const repoGit = this.getGit(repo.path);
        const base = baseBranch || (await repoGit.revparse(["HEAD"])).trim();

        await fs.mkdir(path.dirname(repoWtPath), { recursive: true });

        try {
          await repoGit.raw(["worktree", "add", "-b", branchName, "--", repoWtPath, base]);
        } catch (createError) {
          throw new Error(`Failed to create worktree for repo ${repoId}: ${createError}`);
        }
        createdRepos.push({ repoId, branchName, git: repoGit, commit: base });
        await this.validateExactWorktreeRegistration(repoWtPath, repo.path, repoId);
        const wtGit = this.getGit(repoWtPath);
        const commit = (await wtGit.revparse(["HEAD"])).trim();
        repoInfos[repoId] = { path: repoWtPath, branch: branchName, commit };
        baseCommits[repoId] = commit;
      }

      // Write workspace.json manifest
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
              branch: repoInfos[id].branch,
              commit: repoInfos[id].commit,
            }];
          }),
        ),
        baseCommits,
        ...(attemptSlot !== undefined ? { candidate: attemptSlot } : {}),
      };
      await writeWorkspaceJsonAtomic(this.getWorkspaceManifestPath(feature, step, attemptSlot), manifest);

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
      // Rollback created per-repo worktrees and branches
      let rolledBack = true;
      for (const created of createdRepos) {
        const removed = await created.git.raw(["worktree", "remove", this.getRepoWorktreePath(feature, step, created.repoId, attemptSlot)])
          .then(() => true).catch(() => false);
        const pruned = await created.git.raw(["worktree", "prune"]).then(() => true).catch(() => false);
        const branchDeleted = removed && cleanupStepDone(await this.deleteBranchStep(created.git, created.branchName, created.commit));
        if (!pruned || !branchDeleted) rolledBack = false;
      }
      await this.removeEmptyWorkspaceRoot(compositeRoot);
      if (rolledBack) guard.markOutcomeKnown();
      throw createError;
    }
  }

  private async readWorkspaceManifest(feature: string, step: string, attemptSlot?: string): Promise<WorkspaceManifest | null> {
    const manifestPath = this.getWorkspaceManifestPath(feature, step, attemptSlot);
    await assertNoSymlinkComponents(path.parse(manifestPath).root, manifestPath, true);
    const manifest = await readCompositeWorkspaceManifest(this.getCompositeRoot(feature, step, attemptSlot));
    return manifest?.mode === 'composite' ? manifest : null;
  }

  async get(feature: string, step: string, attemptSlot?: string): Promise<WorktreeInfo | null> {
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
    };
  }

  /** Inspect one explicit workspace candidate, including ignored-file dirt. */
  async inspect(feature: string, step: string, attemptSlot?: string): Promise<WorktreeInfo | null> {
    const workspacePath = this.getWorktreePath(feature, step, attemptSlot);
    return this.readWorkspace(workspacePath, () => this.selectWorkspaceRepositories(feature, step, attemptSlot), async ({ manifest }, pending) => {
      const info = await this.get(feature, step, attemptSlot);
      if (!info) return null;
      if (pending.length > 0) info.pendingOperations = pending;
      if (info.repos) {
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
      base = (await readSingleWorkspaceMetadata(this.getSingleMetadataPath(feature, step, attemptSlot)))?.baseCommit;
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
      async ({ manifest }, guard) => {
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
    const worktreeRemoval = await this.removeWorktreeStep(git, worktreePath);
    const outcome = buildCleanupOutcome(requested, {
      worktreeRemoval,
      prune: await this.pruneWorktreesStep(git),
      branchDeletion: deleteBranch
        ? branchPreparationError
          ? { status: 'failed', error: branchPreparationError }
          : cleanupStepDone(worktreeRemoval)
          ? await this.deleteBranchStep(git, branchName, pinnedBranchCommit)
          : { status: 'not_attempted' }
        : { status: 'not_requested' },
    });
    if (cleanupStepDone(outcome.worktreeRemoval)) {
      await fs.unlink(this.getSingleMetadataPath(feature, step, attemptSlot)).catch((error: NodeJS.ErrnoException) => {
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
      try {
        await this.removeEmptyWorkspaceRoot(compositeRoot);
      } catch (error: unknown) {
        const err = error as { message?: string };
        rootFailure = { cause: err.message || 'composite root removal failed' };
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
    const ref = `refs/heads/${branchName}`;
    try {
      const expected = (await git.revparse([ref])).trim();
      if (!allowUnmergedCommits) {
        const currentBranch = (await git.branch()).current;
        if (!currentBranch) {
          throw new Error(`Refusing to delete branch ${branchName}: current branch could not be determined. Merge first, keep the branch, or use explicit discard.`);
        }
        const unmergedCount = Number((await git.raw(['rev-list', '--count', `${currentBranch}..${expected}`])).trim());
        if (unmergedCount > 0) {
          throw new Error(`Refusing to delete branch ${branchName}: ${unmergedCount} unmerged commits would be discarded. Merge first, keep the branch, or use explicit discard.`);
        }
      }
      return expected;
    } catch (error) {
      const message = (error as Error).message;
      if (/unknown revision|ambiguous argument|Needed a single revision/.test(message)) return undefined;
      throw error;
    }
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

  async cleanup(feature?: string): Promise<{ removed: string[]; pruned: boolean; finalization?: WorktreeFinalizationFailure }> {
    // Global cleanup can visit any task workspace and prunes every trusted repository, so it locks them all.
    return this.mutate('cleanup', { project: true, feature }, async () => {
      const resolved = this.resolveRepositories();
      return { repositoryPaths: resolved?.length ? resolved.map(repository => repository.path) : [this.config.baseDir] };
    }, ({ repositoryPaths }, guard) => this.cleanupUnlocked(guard, feature, repositoryPaths));
  }

  private async cleanupUnlocked(guard: WorktreeMutationGuard, feature: string | undefined, repositories: string[]): Promise<{ removed: string[]; pruned: boolean }> {
    const removed: string[] = [];

    const worktreesDir = this.getWorktreesDir();
    const features = feature ? [feature] : await fs.readdir(worktreesDir).catch(() => []);

      for (const feat of features) {
        const featurePath = path.join(worktreesDir, feat);
        const stat = await fs.lstat(featurePath).catch(() => null);

        if (stat?.isSymbolicLink()) throw new WorktreeLinkageError(`Worktree linkage preflight failed: path contains a symlink (${featurePath})`);
        if (!stat?.isDirectory()) continue;

      const steps = await fs.readdir(featurePath).catch(() => []);

      for (const entry of steps) {
        const { step, attemptSlot } = this.parseWorktreeStepDirectory(entry);
        const worktreePath = path.join(featurePath, entry);
        const stepStat = await fs.lstat(worktreePath).catch(() => null);

        if (stepStat?.isSymbolicLink()) throw new WorktreeLinkageError(`Worktree linkage preflight failed: path contains a symlink (${worktreePath})`);
        if (!stepStat?.isDirectory()) continue;

        const manifest = await this.readWorkspaceManifest(feat, step, attemptSlot);
        if (manifest) {
          const trustedById = this.trustedRepositoriesForManifest(manifest);
          // Composite: stale if any per-repo worktree fails revparse
          let stale = false;
          for (const [repoId, entry] of Object.entries(manifest.repos)) {
            const repoWt = path.join(worktreePath, entry.path);
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
          if (stale) {
            const cleanup = await this.removeComposite(guard, feat, step, manifest, false, {}, attemptSlot);
            if (cleanup.worktreeRemoved && await this.isPathAbsent(worktreePath)) removed.push(worktreePath);
          }
          continue;
        }

        this.workspaceRepositoryPaths(null, worktreePath);
        await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'legacy');
        try {
          const worktreeGit = this.getGit(worktreePath);
          await worktreeGit.revparse(["HEAD"]);
        } catch {
          const cleanup = await this.removeLegacy(guard, feat, step, false, {}, attemptSlot);
          if (cleanup.worktreeRemoved && await this.isPathAbsent(worktreePath)) removed.push(worktreePath);
        }
      }
    }

    await guard.begin();
    for (const repositoryPath of repositories) {
      try {
        await this.getGit(repositoryPath).raw(["worktree", "prune"]);
      } catch {
        /* intentional */
      }
    }
    return { removed, pruned: true };
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
    try {
      return await this.mutate(
        'merge',
        { feature, step, attemptSlot },
        () => this.selectWorkspaceRepositories(feature, step, attemptSlot),
        ({ manifest }, guard) => this.mergeUnlocked(guard, feature, step, manifest, policy, message, options, attemptSlot),
        isMutationOutcomeKnown,
      );
    } catch (error) {
      const reasonCode = classifyThrownWorktreeError(error) ?? 'GIT_OPERATION_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      // An operation that began mutating has an unknown outcome; only a refusal before any effect is a preflight result.
      if (error instanceof WorktreeOperationRecoveryRequiredError && error.mutation !== 'none') {
        return mergeFailure(policy.strategy, reasonCode, message, { mutation: error.mutation });
      }
      return mergeFailure(policy.strategy, reasonCode, message, { partial: false });
    }
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
          await this.removeEmptyWorkspaceRoot(compositeRoot);
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
    const worktreeRemoval = await this.removeWorktreeStep(repoGit, repoWtPath);
    return buildCleanupOutcome(deleteBranch ? 'worktree+branch' : 'worktree', {
      worktreeRemoval,
      prune: await this.pruneWorktreesStep(repoGit),
      branchDeletion: deleteBranch
        ? branchPreparationError
          ? { status: 'failed', error: branchPreparationError }
          : cleanupStepDone(worktreeRemoval)
          ? await this.deleteBranchStep(repoGit, branchName, pinnedBranchCommit)
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

  private async pruneWorktreesStep(git: SimpleGit): Promise<CleanupStepOutcome> {
    try {
      await git.raw(['worktree', 'prune']);
      return { status: 'succeeded' };
    } catch (error: unknown) {
      const err = error as { message?: string };
      return { status: 'failed', error: err.message || 'worktree prune failed' };
    }
  }

  /**
   * Delete one branch. Reports already_absent when the branch is already gone
   * so a partially repeated cleanup still describes reality.
   */
  private async deleteBranchStep(git: SimpleGit, branchName: string, expectedOldOid?: string): Promise<CleanupStepOutcome> {
    if (!expectedOldOid) return { status: 'already_absent' };
    try {
      const checkedOut = (await git.raw(['worktree', 'list', '--porcelain']))
        .split('\n')
        .some((line) => line === `branch refs/heads/${branchName}`);
      if (checkedOut) return { status: 'failed', error: `Refusing to delete checked-out branch ${branchName}` };
      await git.raw(['update-ref', '-d', `refs/heads/${branchName}`, expectedOldOid]);
      return { status: 'succeeded' };
    } catch (error: unknown) {
      return { status: 'failed', error: (error as Error).message || 'branch compare-and-delete failed' };
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
