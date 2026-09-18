import * as fs from "fs/promises";
import * as path from "path";
import simpleGit, { SimpleGit } from "simple-git";
import type { ResolvedRepository, TaskStatus } from "../types.js";
import { acquireLock, resolveFeatureDirectoryName } from "../utils/paths.js";
import { createHash } from 'crypto';
import type {
  TaskWorkspaceManifest as WorkspaceManifest,
  SingleWorkspaceMetadata,
} from './workspaceManifest.js';
import { readCompositeWorkspaceManifest, readSingleWorkspaceMetadata, writeWorkspaceJsonAtomic } from './workspaceManifest.js';
import {
  buildCleanupOutcome,
  buildNotRequestedCleanupOutcome,
  buildNotRequestedMergeCleanupBlock,
  cleanupFacts,
  cleanupStepDone,
  classifyThrownWorktreeError,
  classifyWorktreeOutcome,
  combineRepoCleanupOutcomes,
  isRetryableWithMutation,
  WorktreeTopologyMismatchError,
  WorktreeLinkageError,
  toMergeCleanupBlock,
} from './worktreeOutcome.js';
import {
  integrateWorktreeRepository,
  integrationFailure,
  mergeSuccessClassification,
  readValidatedCommitMessage,
  resolveGitPath,
  validateSourceCommitMessages,
} from './worktreeIntegration.js';
import type {
  CleanupStepOutcome,
  WorktreeCleanupOutcome,
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
  preserveConflicts?: boolean;
  cleanup?: 'none' | 'worktree' | 'worktree+branch';
  /** Exact source commits to integrate. A moved source is rejected before mutation. */
  sourceCommit?: string;
  sourceCommits?: Record<string, string>;
}

export interface MergeResult {
  success: boolean;
  merged: boolean;
  strategy: 'merge' | 'squash' | 'rebase';
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
  strategy: 'merge' | 'squash' | 'rebase',
  reasonCode: WorktreeReasonCode,
  error: string,
  options: {
    mutation?: WorktreeMutationState;
    conflicts?: string[];
    conflictState?: 'none' | 'aborted' | 'preserved';
    filesChanged?: string[];
    repos?: Record<string, RepoMergeResult>;
    partial?: boolean;
  } = {},
): MergeResult {
  const classification = classifyWorktreeOutcome(reasonCode, options.mutation);
  return {
    success: false,
    merged: false,
    strategy,
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

export class WorktreeService {
  private config: WorktreeConfig;

  constructor(config: WorktreeConfig) {
    this.config = config;
  }

  private getGit(cwd?: string): SimpleGit {
    return simpleGit(cwd || this.config.baseDir);
  }

  private async withRepositoryLocks<T>(repositoryPaths: string[], operation: () => Promise<T>): Promise<T> {
    const commonDirectories = [...new Set(await Promise.all(
      repositoryPaths.map((repositoryPath) => this.trustedGitCommonDirectory(repositoryPath)),
    ))].sort();
    const releases: Array<() => void> = [];
    try {
      for (const commonDirectory of commonDirectories) {
        const key = createHash('sha256').update(commonDirectory).digest('hex');
        releases.push(await acquireLock(path.join(this.config.hiveDir, '.operation-locks', key), {
          staleLockTTL: null,
        }));
      }
      return await operation();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  private async isCompletelyClean(git: SimpleGit): Promise<boolean> {
    return (await git.raw(['status', '--porcelain=v1', '--ignored'])).trim() === '';
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

  private isContained(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private async trustedGitCommonDirectory(repositoryPath: string): Promise<string> {
    const raw = (await this.getGit(repositoryPath).raw(['rev-parse', '--git-common-dir'])).trim();
    if (!raw) throw new WorktreeLinkageError(`Worktree linkage preflight failed: trusted repository has no Git common directory (${repositoryPath})`);
    return fs.realpath(path.isAbsolute(raw) ? raw : path.resolve(repositoryPath, raw));
  }

  private async assertNoSymlinkComponents(root: string, candidate: string, allowMissing = false): Promise<void> {
    const relative = path.relative(root, candidate);
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (allowMissing && error.code === 'ENOENT') return null;
        throw new WorktreeLinkageError(`Worktree linkage preflight failed: cannot inspect path component ${current}: ${error.message}`);
      });
      if (!stat) return;
      if (stat.isSymbolicLink()) {
        throw new WorktreeLinkageError(`Worktree linkage preflight failed: path contains a symlink (${current})`);
      }
    }
  }

  private async validateExactWorktreeRegistration(
    worktreePath: string,
    trustedRepositoryPath: string,
    repositoryId: string,
  ): Promise<void> {
    await this.assertNoSymlinkComponents(path.parse(worktreePath).root, worktreePath);
    const commonDirectory = await this.trustedGitCommonDirectory(trustedRepositoryPath);
    const localGitPath = path.join(worktreePath, '.git');
    const localGitStat = await fs.lstat(localGitPath).catch(() => null);
    if (!localGitStat?.isFile() || localGitStat.isSymbolicLink()) {
      throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repositoryId}: local .git must be a regular pointer file`);
    }
    const pointer = await fs.readFile(localGitPath, 'utf8');
    const match = pointer.match(/^gitdir:\s*(.+?)\s*$/);
    if (!match) throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repositoryId}: invalid local .git pointer`);
    const administrationPath = path.normalize(path.isAbsolute(match[1]!)
      ? match[1]!
      : path.resolve(worktreePath, match[1]!));
    const worktreesDirectory = path.join(commonDirectory, 'worktrees');
    if (!this.isContained(worktreesDirectory, administrationPath) || administrationPath === worktreesDirectory) {
      throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repositoryId}: administration entry is outside the trusted Git common directory`);
    }
    await this.assertNoSymlinkComponents(commonDirectory, administrationPath);
    await this.assertNoSymlinkComponents(administrationPath, path.join(administrationPath, 'commondir'));
    await this.assertNoSymlinkComponents(administrationPath, path.join(administrationPath, 'gitdir'));

    const commondirBytes = await fs.readFile(path.join(administrationPath, 'commondir'), 'utf8');
    const selectedCommonDirectory = path.normalize(path.resolve(administrationPath, commondirBytes.trim()));
    if (selectedCommonDirectory !== path.normalize(commonDirectory)) {
      throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repositoryId}: commondir does not match the trusted repository`);
    }
    const backlinkBytes = await fs.readFile(path.join(administrationPath, 'gitdir'), 'utf8');
    const backlink = path.normalize(path.isAbsolute(backlinkBytes.trim())
      ? backlinkBytes.trim()
      : path.resolve(administrationPath, backlinkBytes.trim()));
    if (backlink !== path.normalize(localGitPath)) {
      throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repositoryId}: administration backlink does not select this exact worktree`);
    }
  }

  private async validateWorktreeBranch(worktreePath: string, branch: string, repositoryId: string): Promise<void> {
    const currentBranch = (await this.getGit(worktreePath).revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (currentBranch !== branch) {
      throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repositoryId}: current branch does not match the registered branch`);
    }
  }

  private trustedRepositoriesForManifest(manifest: WorkspaceManifest): Map<string, ResolvedRepository> {
    const trustedRepositories = this.resolveRepositories();
    if (!trustedRepositories?.length) {
      throw new WorktreeLinkageError('Worktree linkage preflight failed: trusted repository topology is unavailable');
    }
    const trustedById = new Map(trustedRepositories.map(repository => [repository.id, repository]));
    for (const [id, entry] of Object.entries(manifest.repos)) {
      const trusted = trustedById.get(id);
      if (!trusted
        || entry.repoRoot !== trusted.root
        || path.resolve(entry.repoPath) !== path.resolve(trusted.path)
        || entry.path !== path.posix.join('repos', id)) {
        throw new WorktreeTopologyMismatchError(`Worktree linkage preflight failed for repository ${id}: workspace topology does not match the trusted repository manifest`);
      }
    }
    return trustedById;
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
    const targetPath = composite
      ? this.getCompositeRoot(feature, step, attemptSlot)
      : this.getWorktreePath(feature, step, attemptSlot);
    await this.assertNoSymlinkComponents(path.parse(targetPath).root, targetPath, true);
    if (composite && await this.readWorkspaceManifest(feature, step, attemptSlot)) {
      await this.get(feature, step, attemptSlot);
    }
    const repositories = composite ? composite.repos.map((repository) => repository.path) : [this.config.baseDir];
    return this.withRepositoryLocks(repositories, () => composite
      ? this.createComposite(feature, step, composite.repos, composite.repoIds, baseBranch, attemptSlot)
      : this.createLegacy(feature, step, baseBranch, attemptSlot));
  }

  private async createLegacy(feature: string, step: string, baseBranch?: string, attemptSlot?: string): Promise<WorktreeInfo> {
    const worktreePath = this.getWorktreePath(feature, step, attemptSlot);
    await this.assertNoSymlinkComponents(path.parse(worktreePath).root, worktreePath, true);
    const branchName = this.getLegacyBranchName(feature, step, attemptSlot);
    const git = this.getGit();

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });

    const base = baseBranch || (await git.revparse(["HEAD"])).trim();

    const existing = await this.get(feature, step, attemptSlot);
    if (existing) {
      return existing;
    }

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
        await git.raw(['worktree', 'prune']).catch(() => {});
        await this.deleteBranchStep(git, branchName, commit);
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
      for (const created of createdRepos) {
        const removed = await created.git.raw(["worktree", "remove", this.getRepoWorktreePath(feature, step, created.repoId, attemptSlot)])
          .then(() => true).catch(() => false);
        try {
          await created.git.raw(["worktree", "prune"]);
        } catch {}
        if (removed) await this.deleteBranchStep(created.git, created.branchName, created.commit);
      }
      await this.removeEmptyWorkspaceRoot(compositeRoot);
      throw createError;
    }
  }

  private async readWorkspaceManifest(feature: string, step: string, attemptSlot?: string): Promise<WorkspaceManifest | null> {
    const manifestPath = this.getWorkspaceManifestPath(feature, step, attemptSlot);
    await this.assertNoSymlinkComponents(path.parse(manifestPath).root, manifestPath, true);
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
      || path.resolve(metadata.repositoryPath) !== path.resolve(this.config.baseDir)
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
    const manifest = await this.readWorkspaceManifest(feature, step, attemptSlot);
    const repositories = manifest
      ? [...this.trustedRepositoriesForManifest(manifest).values()].map((repository) => repository.path)
      : [this.config.baseDir];
    return this.withRepositoryLocks(repositories, async () => {
      const info = await this.get(feature, step, attemptSlot);
      if (!info) return null;
      if (info.repos) {
        for (const repo of Object.values(info.repos)) repo.clean = await this.isCompletelyClean(this.getGit(repo.path));
        info.clean = Object.values(info.repos).every((repo) => repo.clean === true);
      } else {
        info.clean = await this.isCompletelyClean(this.getGit(info.path));
      }
      return info;
    });
  }

  /** Return every old/default/slotted candidate; callers must select one explicitly. */
  async listCandidates(feature: string, step: string): Promise<WorktreeInfo[]> {
    return (await this.list(feature))
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
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean; cleanup: WorktreeCleanupOutcome }> {
    const manifest = await this.readWorkspaceManifest(feature, step, attemptSlot);
    const repositories = manifest
      ? [...this.trustedRepositoriesForManifest(manifest).values()].map((repository) => repository.path)
      : [this.config.baseDir];
    return this.withRepositoryLocks(repositories, () => this.removeUnlocked(
      feature,
      step,
      deleteBranch,
      options,
      attemptSlot,
    ));
  }

  private async removeUnlocked(
    feature: string,
    step: string,
    deleteBranch = false,
    options: WorktreeRemoveOptions = {},
    attemptSlot?: string,
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean; cleanup: WorktreeCleanupOutcome }> {
    const manifest = await this.readWorkspaceManifest(feature, step, attemptSlot);
    if (manifest) {
      return this.removeComposite(feature, step, manifest, deleteBranch, options, attemptSlot);
    }
    await this.get(feature, step, attemptSlot);
    return this.removeLegacy(feature, step, deleteBranch, options, attemptSlot);
  }

  private async removeLegacy(
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
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return mergeCleanupResult(outcome);
  }

  private async removeComposite(
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

    const perRepo: Array<{ repoId: string; cleanup: WorktreeCleanupOutcome }> = [];
    for (const [repoId, entry] of Object.entries(manifest.repos)) {
      const repositoryPath = reposById.get(repoId)!.path;
      const perRepoResult = await this.removeCompositeRepo(
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

  async list(feature?: string): Promise<WorktreeInfo[]> {
    const worktreesDir = this.getWorktreesDir();
    const results: WorktreeInfo[] = [];

    let features: string[];
    try {
      features = feature ? [feature] : await fs.readdir(worktreesDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return results;
      throw error;
    }

    for (const feat of features) {
      const featurePath = path.join(worktreesDir, feat);
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
        const entryStat = await fs.lstat(entryPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (entryStat?.isSymbolicLink()) throw new WorktreeLinkageError(`Worktree linkage preflight failed: path contains a symlink (${entryPath})`);
        if (!entryStat?.isDirectory()) continue;
        const { step, attemptSlot } = this.parseWorktreeStepDirectory(entry);
        const info = await this.get(feat, step, attemptSlot);
        if (info) {
          results.push(info);
        }
      }
    }

    return results;
  }

  async cleanup(feature?: string): Promise<{ removed: string[]; pruned: boolean }> {
    const repositories = this.resolveRepositories()?.map((repository) => repository.path) ?? [this.config.baseDir];
    return this.withRepositoryLocks(repositories, () => this.cleanupUnlocked(feature));
  }

  private async cleanupUnlocked(feature?: string): Promise<{ removed: string[]; pruned: boolean }> {
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
            const cleanup = await this.removeComposite(feat, step, manifest, false, {}, attemptSlot);
            if (cleanup.worktreeRemoved && await this.isPathAbsent(worktreePath)) removed.push(worktreePath);
          }
          continue;
        }

        await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'legacy');
        try {
          const worktreeGit = this.getGit(worktreePath);
          await worktreeGit.revparse(["HEAD"]);
        } catch {
          const cleanup = await this.removeLegacy(feat, step, false, {}, attemptSlot);
          if (cleanup.worktreeRemoved && await this.isPathAbsent(worktreePath)) removed.push(worktreePath);
        }
      }
    }

    try {
      await this.getGit().raw(["worktree", "prune"]);
    } catch {
      /* intentional */
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

  async merge(
    feature: string,
    step: string,
    strategy: "merge" | "squash" | "rebase" = "squash",
    message?: string,
    options: MergeOptions = {},
    attemptSlot?: string,
  ): Promise<MergeResult> {
    try {
      const manifest = await this.readWorkspaceManifest(feature, step, attemptSlot);
      const repositories = manifest
        ? [...this.trustedRepositoriesForManifest(manifest).values()].map((repository) => repository.path)
        : [this.config.baseDir];
      return await this.withRepositoryLocks(repositories, () => this.mergeUnlocked(
        feature,
        step,
        strategy,
        message,
        options,
        attemptSlot,
      ));
    } catch (error) {
      const reasonCode = classifyThrownWorktreeError(error) ?? 'GIT_OPERATION_FAILED';
      return mergeFailure(strategy, reasonCode, error instanceof Error ? error.message : String(error), { partial: false });
    }
  }

  private async mergeUnlocked(
    feature: string,
    step: string,
    strategy: "merge" | "squash" | "rebase",
    message: string | undefined,
    options: MergeOptions,
    attemptSlot?: string,
  ): Promise<MergeResult> {
    const cleanupMode = options.cleanup ?? 'none';
    const preserveConflicts = options.preserveConflicts ?? false;

    if (strategy === "rebase" && message?.trim()) {
      return mergeFailure(strategy, 'MESSAGE_NOT_ALLOWED_FOR_REBASE', "Custom merge message is not supported for rebase strategy");
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
    const manifest = await this.readWorkspaceManifest(feature, step, attemptSlot);
    if (manifest) {
      return this.mergeComposite(feature, step, manifest, strategy, message, {
        cleanup: cleanupMode,
        preserveConflicts,
        sourceCommits: options.sourceCommits,
      }, attemptSlot);
    }

    const branchName = this.getLegacyBranchName(feature, step, attemptSlot);
    const repoResult = await this.mergeOneRepo({
      git: this.getGit(),
      branchName,
      strategy,
      message,
      preserveConflicts,
      cleanupMode,
      sourceCommit: options.sourceCommit ?? registered.commit,
      sourceWorktreePath: registered.path,
      cleanupFn: async (deleteBranch: boolean) => (await this.removeLegacy(feature, step, deleteBranch, {}, attemptSlot, options.sourceCommit ?? registered.commit)).cleanup,
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
    };
  }

  private async mergeComposite(
    feature: string,
    step: string,
    manifest: WorkspaceManifest,
    strategy: "merge" | "squash" | "rebase",
    message: string | undefined,
    options: {
      cleanup: 'none' | 'worktree' | 'worktree+branch';
      preserveConflicts: boolean;
      sourceCommits?: Record<string, string>;
    },
    attemptSlot?: string,
  ): Promise<MergeResult> {
    const repoIds = Object.keys(manifest.repos).sort();
    const trustedById = this.trustedRepositoriesForManifest(manifest);
    const pinnedSourceCommits: Record<string, string> = {};
    const expectedTargetCommits: Record<string, string> = {};

    const preflightFailure = (repoId: string, reason: string, reasonCode: WorktreeReasonCode): MergeResult =>
      mergeFailure(strategy, reasonCode, `${repoId}: ${reason}`, { partial: false });

    // Preflight all repos before any mutation
    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      const repoRoot = trustedById.get(repoId)!.path;
      const repoGit = this.getGit(repoRoot);
      const repoWtPath = path.join(this.getCompositeRoot(feature, step, attemptSlot), entry.path);
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

      // Source repo target must be clean
      try {
        const status = await repoGit.status();
        const dirty =
          status.modified.length > 0 ||
          status.not_added.length > 0 ||
          status.staged.length > 0 ||
          status.deleted.length > 0 ||
          status.created.length > 0 ||
          status.conflicted.length > 0;
        if (dirty) {
          return preflightFailure(repoId, 'target repo has uncommitted (dirty) changes', 'TARGET_DIRTY');
        }
      } catch (e: unknown) {
        const msg = (e as { message?: string }).message ?? 'unable to read status';
        return preflightFailure(repoId, msg, 'GIT_OPERATION_FAILED');
      }

      // No active merge/rebase/cherry-pick state. Resolve state paths via
      // `git rev-parse --git-path` so linked worktrees (where .git is a file)
      // and per-worktree state directories are handled correctly.
      const stateChecks: Array<{ name: string; label: string }> = [
        { name: 'MERGE_HEAD', label: 'merge' },
        { name: 'REBASE_HEAD', label: 'rebase' },
        { name: 'CHERRY_PICK_HEAD', label: 'cherry-pick' },
        { name: 'rebase-merge', label: 'rebase' },
        { name: 'rebase-apply', label: 'rebase' },
      ];
      for (const { name, label } of stateChecks) {
        const statePath = await resolveGitPath(repoGit, repoRoot, name);
        try {
          await fs.access(statePath);
          return preflightFailure(repoId, `active ${label} state in progress`, 'GIT_OPERATION_IN_PROGRESS');
        } catch {
          // not present -> ok
        }
      }

      const currentBranch = (await repoGit.branch()).current;
      const targetHead = (await repoGit.revparse(['HEAD'])).trim();
      const changedFiles = (await repoGit.diff([targetHead, entry.branch, '--name-only'])).trim();
      if (changedFiles) {
        if (strategy !== 'squash') {
          const sourceError = await validateSourceCommitMessages(repoGit, currentBranch, entry.branch);
          if (sourceError) return preflightFailure(repoId, sourceError, 'INVALID_COMMIT_MESSAGE');
        }
      }
    }

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
        strategy,
        message,
        preserveConflicts: options.preserveConflicts,
        cleanupMode: 'none', // defer cleanup until after all repos succeed
        sourceCommit: pinnedSourceCommits[repoId],
        sourceWorktreePath: path.join(this.getCompositeRoot(feature, step, attemptSlot), entry.path),
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

      expectedTargetCommits[repoId] = (await repoGit.revparse(['HEAD'])).trim();

      if (!repoResult.merged) {
        if (repoResult.reasonCode === 'NO_TRACKED_CHANGES') {
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
      const deleteBranch = options.cleanup === 'worktree+branch';
      const perRepo: Array<{ repoId: string; cleanup: WorktreeCleanupOutcome }> = [];
      let identityFailure: { repoId: string; cause: string } | undefined;
      for (const repoId of repoIds) {
        const repoGit = this.getGit(trustedById.get(repoId)!.path);
        try {
          const source = (await repoGit.revparse([manifest.repos[repoId].branch])).trim();
          const target = (await repoGit.revparse(['HEAD'])).trim();
          if (source !== pinnedSourceCommits[repoId] || target !== expectedTargetCommits[repoId]) {
            identityFailure = { repoId, cause: `source or target moved before cleanup (source ${source}, target ${target})` };
            break;
          }
        } catch (error) {
          identityFailure = { repoId, cause: `source or target could not be read before cleanup: ${(error as Error).message}` };
          break;
        }
      }
      for (const repoId of repoIds) {
        const repoCleanup = identityFailure
          ? buildCleanupOutcome(options.cleanup, {
            worktreeRemoval: { status: 'not_attempted' },
            branchDeletion: deleteBranch ? { status: 'not_attempted' } : { status: 'not_requested' },
            prune: { status: 'not_attempted' },
            failures: [{ step: 'identity-recheck', repoId: identityFailure.repoId, cause: identityFailure.cause }],
          })
          : await this.removeCompositeRepo(
            feature,
            step,
            repoId,
            trustedById.get(repoId)!.path,
            deleteBranch,
            {},
            attemptSlot,
            pinnedSourceCommits[repoId],
          );
        repos[repoId].cleanup = toMergeCleanupBlock(repoCleanup);
        perRepo.push({ repoId, cleanup: repoCleanup });
      }
      // Tear down the composite root after per-repo cleanup.
      const compositeRoot = this.getCompositeRoot(feature, step, attemptSlot);
      let rootFailure: { cause: string } | undefined;
      if (!identityFailure && perRepo.every(({ cleanup }) => cleanup.outcome === 'complete')) {
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
      return {
        success: true,
        merged: false,
        strategy,
        reason: 'nothing_to_merge',
        reasonCode: 'NO_TRACKED_CHANGES',
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
    strategy: 'merge' | 'squash' | 'rebase';
    message: string | undefined;
    preserveConflicts: boolean;
    cleanupMode: 'none' | 'worktree' | 'worktree+branch';
    sourceCommit: string;
    sourceWorktreePath: string;
    cleanupFn: (deleteBranch: boolean) => Promise<WorktreeCleanupOutcome>;
  }): Promise<RepoMergeResult> {
    const result = await integrateWorktreeRepository({
      targetGit: options.git,
      sourceGit: this.getGit(options.sourceWorktreePath),
      sourceBranch: options.branchName,
      sourceCommit: options.sourceCommit,
      sourceDiagnosticPath: options.sourceWorktreePath,
      strategy: options.strategy,
      message: options.message,
      preserveConflicts: options.preserveConflicts,
      cleanupMode: options.cleanupMode,
      cleanup: options.cleanupFn,
      readCommitMessage: this.readValidatedCommitMessage.bind(this),
    });
    return !result.merged && result.reason === 'nothing_to_merge'
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
