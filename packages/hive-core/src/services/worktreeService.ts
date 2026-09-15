import * as fs from "fs/promises";
import * as path from "path";
import simpleGit, { SimpleGit } from "simple-git";
import type { ResolvedRepository, TaskStatus } from "../types.js";
import { normalizeCommitMessage } from '../utils/mergeMessage.js';
import { resolveFeatureDirectoryName } from "../utils/paths.js";
import type {
  TaskWorkspaceManifest as WorkspaceManifest,
  WorkspaceManifestEntry,
} from './workspaceManifest.js';
import { readCompositeWorkspaceManifest } from './workspaceManifest.js';
import {
  buildCleanupOutcome,
  classifyThrownWorktreeError,
  classifyWorktreeOutcome,
  combineRepoCleanupOutcomes,
  isRetryableWithMutation,
  WorktreeTopologyMismatchError,
  WorktreeLinkageError,
} from './worktreeOutcome.js';
import type {
  CleanupStepOutcome,
  WorktreeCleanupOutcome,
  WorktreeMutationState,
  WorktreeOperationPhase,
  WorktreeReasonCode,
  WorktreeRecoveryAction,
} from './worktreeOutcome.js';

export type WorktreeMode = 'legacy' | 'composite';

export interface WorktreeRepoInfo {
  path: string;
  branch: string;
  commit: string;
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

export interface CommitResult {
  committed: boolean;
  sha: string;
  message?: string;
  /** Per-repo commit results when the workspace is a composite. Omitted for legacy single-root workspaces. */
  repos?: Record<string, RepoCommitResult>;
  /** True when at least one repo committed and at least one repo failed. */
  partial?: boolean;
  /** First per-repo error encountered, if any. */
  error?: string;
  phase: WorktreeOperationPhase;
  reasonCode?: WorktreeReasonCode;
  mutation: WorktreeMutationState;
  retryable: boolean;
  action: WorktreeRecoveryAction;
}

export interface RepoCommitResult {
  committed: boolean;
  sha: string;
  message?: string;
  phase?: WorktreeOperationPhase;
  reasonCode?: WorktreeReasonCode;
  mutation?: WorktreeMutationState;
  retryable?: boolean;
  action?: WorktreeRecoveryAction;
}

export interface MergeOptions {
  preserveConflicts?: boolean;
  cleanup?: 'none' | 'worktree' | 'worktree+branch';
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
export interface MergeCleanupBlock extends WorktreeCleanupOutcome {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  pruned: boolean;
}

export interface RepoMergeResult {
  success: boolean;
  merged: boolean;
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
  phase: WorktreeOperationPhase;
  mutation: WorktreeMutationState;
  retryable: boolean;
  action: WorktreeRecoveryAction;
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

interface RemoveOptions {
  allowUnmergedCommits?: boolean;
}

function cleanupStepDone(step: CleanupStepOutcome): boolean {
  return step.status === 'succeeded' || step.status === 'already_absent';
}

function noCleanupRequested(): WorktreeCleanupOutcome {
  return buildCleanupOutcome('none', {
    worktreeRemoval: { status: 'not_requested' },
    branchDeletion: { status: 'not_requested' },
    prune: { status: 'not_requested' },
  });
}

function toMergeCleanupBlock(outcome: WorktreeCleanupOutcome): MergeCleanupBlock {
  return {
    ...outcome,
    worktreeRemoved: cleanupStepDone(outcome.worktreeRemoval),
    branchDeleted: outcome.requested === 'worktree+branch' && cleanupStepDone(outcome.branchDeletion),
    pruned: outcome.prune.status === 'succeeded',
  };
}

/**
 * Promote a single-repo commit result to the aggregate shape. `retryable` is
 * re-derived so the aggregate can never claim a safe retry after a mutation.
 */
function aggregateFromRepoCommit(repoResult: RepoCommitResult): CommitResult {
  const mutation = repoResult.mutation ?? 'none';
  return {
    committed: repoResult.committed,
    sha: repoResult.sha,
    ...(repoResult.message !== undefined ? { message: repoResult.message } : {}),
    ...(repoResult.reasonCode !== undefined ? { reasonCode: repoResult.reasonCode } : {}),
    phase: repoResult.phase ?? 'integration',
    mutation,
    retryable: repoResult.retryable === true && isRetryableWithMutation(mutation),
    action: repoResult.action ?? 'none',
  };
}

function commitFailure(
  reasonCode: WorktreeReasonCode,
  message: string,
  overrides: { sha?: string; mutation?: WorktreeMutationState } = {},
): RepoCommitResult {
  const classification = classifyWorktreeOutcome(reasonCode, overrides.mutation);
  return {
    committed: false,
    sha: overrides.sha ?? '',
    message,
    phase: classification.phase,
    reasonCode,
    mutation: classification.mutation,
    retryable: classification.retryable,
    action: classification.action,
  };
}

/**
 * Classify the aggregate composite commit result. A repo that committed and a
 * later repo that failed leaves durable partial history, so the aggregate is
 * never reported as retryable.
 */
function aggregateCommitClassification(input: {
  repos: RepoCommitResult[];
  anyCommitted: boolean;
  anyFailed: boolean;
}): Pick<CommitResult, 'phase' | 'reasonCode' | 'mutation' | 'retryable' | 'action'> {
  if (!input.anyFailed) {
    return input.anyCommitted
      ? { phase: 'integration', mutation: 'applied', retryable: false, action: 'none' }
      : { phase: 'integration', mutation: 'none', retryable: false, action: 'none' };
  }
  if (!input.anyCommitted) {
    const failed = input.repos.find((repo) => repo.reasonCode !== undefined);
    if (failed?.reasonCode) {
      const classification = classifyWorktreeOutcome(failed.reasonCode, failed.mutation);
      return {
        phase: classification.phase,
        reasonCode: failed.reasonCode,
        mutation: classification.mutation,
        retryable: classification.retryable,
        action: classification.action,
      };
    }
    return { phase: 'integration', mutation: 'none', retryable: false, action: 'inspect_state' };
  }
  const classification = classifyWorktreeOutcome('COMPOSITE_PARTIAL');
  return {
    phase: classification.phase,
    reasonCode: 'COMPOSITE_PARTIAL',
    mutation: classification.mutation,
    retryable: classification.retryable,
    action: classification.action,
  };
}

function mergeRepoFailure(
  reasonCode: WorktreeReasonCode,
  error: string,
  options: {
    mutation?: WorktreeMutationState;
    conflicts?: string[];
    conflictState?: 'none' | 'aborted' | 'preserved';
  } = {},
): RepoMergeResult {
  const classification = classifyWorktreeOutcome(reasonCode, options.mutation);
  return {
    success: false,
    merged: false,
    filesChanged: [],
    conflicts: options.conflicts ?? [],
    conflictState: options.conflictState ?? 'none',
    cleanup: toMergeCleanupBlock(noCleanupRequested()),
    error,
    phase: classification.phase,
    reasonCode,
    mutation: classification.mutation,
    retryable: classification.retryable,
    action: classification.action,
  };
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
    cleanup: toMergeCleanupBlock(noCleanupRequested()),
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
    worktreeRemoved: cleanupStepDone(outcome.worktreeRemoval),
    branchDeleted: outcome.requested === 'worktree+branch' && cleanupStepDone(outcome.branchDeletion),
    pruned: outcome.prune.status === 'succeeded',
    cleanup: outcome,
  };
}

/** A merge that moved the target but whose requested cleanup did not finish. */
function mergeSuccessClassification(
  requested: 'none' | 'worktree' | 'worktree+branch',
  cleanup: WorktreeCleanupOutcome,
  mutation: WorktreeMutationState,
): Pick<RepoMergeResult, 'phase' | 'reasonCode' | 'mutation' | 'retryable' | 'action'> {
  if (requested !== 'none' && cleanup.outcome !== 'complete') {
    const classification = classifyWorktreeOutcome('CLEANUP_FAILED', mutation);
    return {
      phase: classification.phase,
      reasonCode: 'CLEANUP_FAILED',
      mutation: classification.mutation,
      retryable: classification.retryable,
      action: classification.action,
    };
  }
  return { phase: 'integration', mutation, retryable: false, action: 'none' };
}

export class WorktreeService {
  private config: WorktreeConfig;

  constructor(config: WorktreeConfig) {
    this.config = config;
  }

  private getGit(cwd?: string): SimpleGit {
    return simpleGit(cwd || this.config.baseDir);
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

  /** Legacy single-repo worktree path. */
  getWorktreePath(feature: string, step: string): string {
    return path.join(this.getWorktreesDir(), feature, step);
  }

  /** Composite workspace root for a (feature, task). Shares disk location with legacy path. */
  private getCompositeRoot(feature: string, step: string): string {
    return path.join(this.getWorktreesDir(), feature, step);
  }

  private getRepoWorktreePath(feature: string, step: string, repoId: string): string {
    return path.join(this.getCompositeRoot(feature, step), 'repos', repoId);
  }

  private getWorkspaceManifestPath(feature: string, step: string): string {
    return path.join(this.getCompositeRoot(feature, step), 'workspace.json');
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

  private getLegacyBranchName(feature: string, step: string): string {
    return `hive/${feature}/${step}`;
  }

  private getRepoBranchName(repoId: string, feature: string, step: string): string {
    return `hive/${repoId}/${feature}/${step}`;
  }

  /** Back-compat alias used by tests/consumers expecting the single-branch form. */
  private getBranchName(feature: string, step: string): string {
    return this.getLegacyBranchName(feature, step);
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

  async create(feature: string, step: string, baseBranch?: string): Promise<WorktreeInfo> {
    const composite = await this.isCompositeTask(feature, step);
    if (composite) {
      return this.createComposite(feature, step, composite.repos, composite.repoIds, baseBranch);
    }
    return this.createLegacy(feature, step, baseBranch);
  }

  private async createLegacy(feature: string, step: string, baseBranch?: string): Promise<WorktreeInfo> {
    const worktreePath = this.getWorktreePath(feature, step);
    await this.assertNoSymlinkComponents(path.parse(worktreePath).root, worktreePath, true);
    const branchName = this.getLegacyBranchName(feature, step);
    const git = this.getGit();

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });

    const base = baseBranch || (await git.revparse(["HEAD"])).trim();

    const existing = await this.get(feature, step);
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

    return {
      path: worktreePath,
      branch: branchName,
      commit,
      feature,
      step,
      mode: 'legacy',
    };
  }

  private async createComposite(
    feature: string,
    step: string,
    repos: ResolvedRepository[],
    repoIds: string[],
    baseBranch?: string,
  ): Promise<WorktreeInfo> {
    // Existing composite workspace -> return aggregate info
    const existing = await this.readWorkspaceManifest(feature, step)
      ? await this.get(feature, step)
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
    const compositeRoot = this.getCompositeRoot(feature, step);
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
      const branchName = this.getRepoBranchName(repoId, feature, step);
      const repoGit = this.getGit(repo.path);
      try {
        const branches = await repoGit.branch();
        if (branches.all.includes(branchName)) {
          throw new Error(
            `Branch collision: ${branchName} already exists in repo ${repoId}`,
          );
        }
      } catch (e: unknown) {
        const msg = (e as { message?: string }).message ?? '';
        if (msg.includes('Branch collision')) throw e;
        // ignore: unable to list branches (e.g., empty repo)
      }
    }

    await fs.mkdir(compositeRoot, { recursive: true });
    await fs.mkdir(path.join(compositeRoot, 'repos'), { recursive: true });

    const createdRepos: Array<{ repoId: string; repoPath: string; branchName: string; git: SimpleGit }> = [];
    const repoInfos: Record<string, WorktreeRepoInfo> = {};
    const baseCommits: Record<string, string> = {};

    try {
      for (const repoId of repoIds) {
        const repo = byId.get(repoId)!;
        const repoWtPath = this.getRepoWorktreePath(feature, step, repoId);
        const branchName = this.getRepoBranchName(repoId, feature, step);
        const repoGit = this.getGit(repo.path);
        const base = baseBranch || (await repoGit.revparse(["HEAD"])).trim();

        await fs.mkdir(path.dirname(repoWtPath), { recursive: true });

        try {
          await repoGit.raw(["worktree", "add", "-b", branchName, "--", repoWtPath, base]);
        } catch (createError) {
          throw new Error(`Failed to create worktree for repo ${repoId}: ${createError}`);
        }
        createdRepos.push({ repoId, repoPath: repo.path, branchName, git: repoGit });

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
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(
        this.getWorkspaceManifestPath(feature, step),
        JSON.stringify(manifest, null, 2),
        'utf-8',
      );

      // Persist base commits to task status. Failures here must fail creation
      // and trigger rollback so callers don't proceed without baseCommits.
      await this.persistBaseCommits(feature, step, baseCommits, repoIds[0]);

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
        try {
          await created.git.raw(["worktree", "remove", this.getRepoWorktreePath(feature, step, created.repoId), "--force"]);
        } catch {
          await fs.rm(this.getRepoWorktreePath(feature, step, created.repoId), { recursive: true, force: true }).catch(() => {});
        }
        try {
          await created.git.raw(["worktree", "prune"]);
        } catch {}
        try {
          await created.git.deleteLocalBranch(created.branchName, true);
        } catch {}
      }
      await fs.rm(compositeRoot, { recursive: true, force: true }).catch(() => {});
      throw createError;
    }
  }

  private async persistBaseCommits(
    feature: string,
    step: string,
    baseCommits: Record<string, string>,
    firstRepoId: string,
  ): Promise<void> {
    const statusPath = await this.getStepStatusPath(feature, step);
    let current: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(statusPath, 'utf-8');
      current = JSON.parse(raw);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      // Tolerate only a missing status file; surface any other read/parse error.
      if (!err || err.code !== 'ENOENT') {
        throw new Error(
          `Failed to read task status at ${statusPath} while persisting base commits: ${(e as Error).message}`,
        );
      }
    }
    current.baseCommits = baseCommits;
    current.baseCommit = baseCommits[firstRepoId];
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(statusPath, JSON.stringify(current, null, 2), 'utf-8');
  }

  private async readWorkspaceManifest(feature: string, step: string): Promise<WorkspaceManifest | null> {
    const manifestPath = this.getWorkspaceManifestPath(feature, step);
    await this.assertNoSymlinkComponents(path.parse(manifestPath).root, manifestPath, true);
    const manifest = await readCompositeWorkspaceManifest(this.getCompositeRoot(feature, step));
    return manifest?.mode === 'composite' ? manifest : null;
  }

  async get(feature: string, step: string): Promise<WorktreeInfo | null> {
    const manifest = await this.readWorkspaceManifest(feature, step);
    if (manifest) {
      const compositeRoot = this.getCompositeRoot(feature, step);
      const repos: Record<string, WorktreeRepoInfo> = {};
      const baseCommits: Record<string, string> = { ...manifest.baseCommits };
      const repoIds = Object.keys(manifest.repos);
      const trustedById = this.trustedRepositoriesForManifest(manifest);
      for (const id of repoIds) {
        const entry = manifest.repos[id]!;
        const trusted = trustedById.get(id)!;
        const repoWtPath = path.join(compositeRoot, entry.path);
        await this.validateExactWorktreeRegistration(repoWtPath, trusted.path, id);
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
      };
    }

    // Legacy single-repo worktree
    const worktreePath = this.getWorktreePath(feature, step);
    const branchName = this.getLegacyBranchName(feature, step);
    try {
      await fs.access(worktreePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'legacy');
    const worktreeGit = this.getGit(worktreePath);
    const commit = (await worktreeGit.revparse(["HEAD"])).trim();
    return {
      path: worktreePath,
      branch: branchName,
      commit,
      feature,
      step,
      mode: 'legacy',
    };
  }

  async getDiff(feature: string, step: string, baseCommit?: string): Promise<DiffResult> {
    await this.get(feature, step);
    const manifest = await this.readWorkspaceManifest(feature, step);
    if (manifest) {
      return this.getCompositeDiff(feature, step, manifest);
    }
    return this.getLegacyDiff(feature, step, baseCommit);
  }

  private async getCompositeDiff(
    feature: string,
    step: string,
    manifest: WorkspaceManifest,
  ): Promise<DiffResult> {
    const compositeRoot = this.getCompositeRoot(feature, step);
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

  private async diffOneRepo(repoWtPath: string, baseCommit?: string): Promise<RepoDiffResult> {
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
    const base = baseCommit || 'HEAD~1';

    try {
      await git.raw(['add', '-A']);
      const status = await git.status();
      const hasStaged = status.staged.length > 0;

      let diffContent = '';
      let stat = '';

      if (hasStaged) {
        diffContent = await git.diff(['--cached']);
        stat = diffContent ? await git.diff(['--cached', '--stat']) : '';
      } else {
        diffContent = await git.diff([`${base}..HEAD`]).catch(() => '');
        stat = diffContent ? await git.diff([`${base}..HEAD`, '--stat']) : '';
      }

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
    } catch {
      return empty;
    }
  }

  private async getLegacyDiff(feature: string, step: string, baseCommit?: string): Promise<DiffResult> {
    const statusPath = await this.getStepStatusPath(feature, step);

    let base = baseCommit;
    if (!base) {
      try {
        const status = JSON.parse(await fs.readFile(statusPath, "utf-8"));
        base = status.baseCommit;
      } catch {}
    }

    return this.diffOneRepo(this.getWorktreePath(feature, step), base);
  }

  async exportPatch(feature: string, step: string, baseBranch?: string): Promise<string> {
    await this.get(feature, step);
    const worktreePath = this.getWorktreePath(feature, step);
    const patchPath = path.join(worktreePath, "..", `${step}.patch`);
    const base = baseBranch || "HEAD~1";
    const worktreeGit = this.getGit(worktreePath);

    const diff = await worktreeGit.diff([`${base}...HEAD`]);
    await fs.writeFile(patchPath, diff);

    return patchPath;
  }

  async applyDiff(feature: string, step: string, baseBranch?: string): Promise<ApplyResult> {
    const { hasDiff, diffContent, filesChanged } = await this.getDiff(feature, step, baseBranch);

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
    options: RemoveOptions = {},
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean; cleanup: WorktreeCleanupOutcome }> {
    await this.get(feature, step);
    const manifest = await this.readWorkspaceManifest(feature, step);
    if (manifest) {
      return this.removeComposite(feature, step, manifest, deleteBranch, options);
    }
    return this.removeLegacy(feature, step, deleteBranch, options);
  }

  private async removeLegacy(
    feature: string,
    step: string,
    deleteBranch: boolean,
    options: RemoveOptions = {},
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean; cleanup: WorktreeCleanupOutcome }> {
    const worktreePath = this.getWorktreePath(feature, step);
    const branchName = this.getLegacyBranchName(feature, step);
    const git = this.getGit();

    if (deleteBranch) {
      await this.assertBranchDeletionSafe(git, branchName, options.allowUnmergedCommits === true);
    }

    const requested = deleteBranch ? 'worktree+branch' : 'worktree';
    const outcome = buildCleanupOutcome(requested, {
      worktreeRemoval: await this.removeWorktreeStep(git, worktreePath),
      prune: await this.pruneWorktreesStep(git),
      branchDeletion: deleteBranch
        ? await this.deleteBranchStep(git, branchName)
        : { status: 'not_requested' },
    });
    return mergeCleanupResult(outcome);
  }

  private async removeComposite(
    feature: string,
    step: string,
    manifest: WorkspaceManifest,
    deleteBranch: boolean,
    options: RemoveOptions = {},
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean; cleanup: WorktreeCleanupOutcome }> {
    const compositeRoot = this.getCompositeRoot(feature, step);
    const reposById = this.trustedRepositoriesForManifest(manifest);

    const perRepo: Array<{ repoId: string; cleanup: WorktreeCleanupOutcome }> = [];
    for (const [repoId, entry] of Object.entries(manifest.repos)) {
      const repositoryPath = reposById.get(repoId)!.path;
      const perRepoResult = await this.removeCompositeRepo(
        feature,
        step,
        entry,
        repositoryPath,
        deleteBranch,
        options,
      );
      perRepo.push({ repoId, cleanup: perRepoResult });
    }

    // Clean up the composite root directory itself
    let rootFailure: { cause: string } | undefined;
    try {
      await fs.rm(compositeRoot, { recursive: true, force: true });
    } catch (error: unknown) {
      const err = error as { message?: string };
      rootFailure = { cause: err.message || 'composite root removal failed' };
    }

    const outcome = combineRepoCleanupOutcomes(
      deleteBranch ? 'worktree+branch' : 'worktree',
      perRepo,
      rootFailure,
    );
    return mergeCleanupResult(outcome);
  }

  private async assertBranchDeletionSafe(git: SimpleGit, branchName: string, allowUnmergedCommits: boolean): Promise<void> {
    if (allowUnmergedCommits) {
      return;
    }

    const branches = await git.branch();
    if (!branches.all.includes(branchName)) {
      return;
    }

    const currentBranch = branches.current;
    if (!currentBranch) {
      throw new Error(`Refusing to delete branch ${branchName}: current branch could not be determined. Merge with hive_merge, keep the branch, or use an explicit discard path.`);
    }

    const unmergedCount = Number((await git.raw(['rev-list', '--count', `${currentBranch}..${branchName}`])).trim());
    if (unmergedCount > 0) {
      throw new Error(`Refusing to delete branch ${branchName}: ${unmergedCount} unmerged commits would be discarded. Merge with hive_merge, keep the branch, or use an explicit discard path.`);
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

      for (const step of steps) {
        const info = await this.get(feat, step);
        if (info) {
          results.push(info);
        }
      }
    }

    return results;
  }

  async cleanup(feature?: string): Promise<{ removed: string[]; pruned: boolean }> {
    const removed: string[] = [];

    const worktreesDir = this.getWorktreesDir();
    const features = feature ? [feature] : await fs.readdir(worktreesDir).catch(() => []);

      for (const feat of features) {
        const featurePath = path.join(worktreesDir, feat);
        const stat = await fs.lstat(featurePath).catch(() => null);

        if (stat?.isSymbolicLink()) throw new WorktreeLinkageError(`Worktree linkage preflight failed: path contains a symlink (${featurePath})`);
        if (!stat?.isDirectory()) continue;

      const steps = await fs.readdir(featurePath).catch(() => []);

      for (const step of steps) {
        const worktreePath = path.join(featurePath, step);
        const stepStat = await fs.lstat(worktreePath).catch(() => null);

        if (stepStat?.isSymbolicLink()) throw new WorktreeLinkageError(`Worktree linkage preflight failed: path contains a symlink (${worktreePath})`);
        if (!stepStat?.isDirectory()) continue;

        const manifest = await this.readWorkspaceManifest(feat, step);
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
            await this.removeComposite(feat, step, manifest, false);
            removed.push(worktreePath);
          }
          continue;
        }

        await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'legacy');
        try {
          const worktreeGit = this.getGit(worktreePath);
          await worktreeGit.revparse(["HEAD"]);
        } catch {
          await this.removeLegacy(feat, step, false);
          removed.push(worktreePath);
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

  async commitChanges(feature: string, step: string, message?: string): Promise<CommitResult> {
    await this.get(feature, step);
    const manifest = await this.readWorkspaceManifest(feature, step);
    if (manifest) {
      return this.commitComposite(feature, step, manifest, message);
    }
    return this.commitLegacy(feature, step, message);
  }

  private async commitComposite(
    feature: string,
    step: string,
    manifest: WorkspaceManifest,
    message?: string,
  ): Promise<CommitResult> {
    const compositeRoot = this.getCompositeRoot(feature, step);
    const repoIds = Object.keys(manifest.repos).sort();
    const repos: Record<string, RepoCommitResult> = {};
    let anyCommitted = false;
    let anyFailed = false;
    let firstError: string | undefined;

    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      const repoWtPath = path.join(compositeRoot, entry.path);
      const repoResult = await this.commitOneRepo(repoWtPath, message);
      repos[repoId] = repoResult;

      if (repoResult.committed) {
        anyCommitted = true;
      } else if (repoResult.message && repoResult.message !== 'No changes to commit') {
        anyFailed = true;
        if (!firstError) firstError = `${repoId}: ${repoResult.message}`;
      }
    }

    const partial = anyCommitted && anyFailed;
    const committed = anyCommitted && !anyFailed;
    const firstCommitted = repoIds.map((repoId) => repos[repoId]).find((repoResult) => repoResult.committed);
    const firstFailed = repoIds
      .map((repoId) => repos[repoId])
      .find((repoResult) => !repoResult.committed && repoResult.message !== 'No changes to commit');
    const firstResult = firstCommitted
      ?? (anyFailed && firstFailed ? firstFailed : undefined)
      ?? repos[repoIds[0]];

    const result: CommitResult = {
      committed,
      sha: firstResult.sha,
      message: firstResult.message,
      repos,
      ...aggregateCommitClassification({
        repos: repoIds.map((repoId) => repos[repoId]),
        anyCommitted,
        anyFailed,
      }),
    };
    if (partial) result.partial = true;
    if (firstError) result.error = firstError;
    return result;
  }

  private async commitOneRepo(repoWtPath: string, commitMessage: string | undefined): Promise<RepoCommitResult> {
    try {
      await fs.access(repoWtPath);
    } catch {
      return commitFailure('WORKTREE_NOT_REGISTERED', 'Worktree not found');
    }

    const git = this.getGit(repoWtPath);
    let startingHead: string | undefined;
    let source: 'message' | 'commit' = 'commit';
    try {
      const status = await git.status();
      const hasChanges =
        status.staged.length > 0 ||
        status.modified.length > 0 ||
        status.not_added.length > 0 ||
        status.deleted.length > 0 ||
        status.created.length > 0;

      if (!hasChanges) {
        const currentSha = (await git.revparse(['HEAD']).catch(() => '')).trim();
        return {
          committed: false,
          sha: currentSha,
          message: 'No changes to commit',
          phase: 'integration',
          mutation: 'none',
          retryable: false,
          action: 'none',
        };
      }

      source = 'message';
      const message = normalizeCommitMessage(commitMessage);
      source = 'commit';
      startingHead = (await git.revparse(['HEAD'])).trim();

      await git.add('-A');
      await git.commit(message);
      const head = (await git.revparse(['HEAD'])).trim();
      if (head === startingHead) throw new Error('Commit failed');
      const createdMessage = await this.readValidatedCommitMessage(git, head);
      return {
        committed: true,
        sha: head,
        message: createdMessage,
        phase: 'integration',
        mutation: 'applied',
        retryable: false,
        action: 'none',
      };
    } catch (error: unknown) {
      const err = error as { message?: string };
      if (source === 'message') {
        // Invalid input was rejected before any Git mutation.
        return commitFailure('INVALID_COMMIT_MESSAGE', err.message || 'Invalid commit message');
      }
      const headAtFailure = startingHead
        ? (await git.revparse(['HEAD']).catch(() => startingHead)).trim()
        : undefined;
      const commitExisted = headAtFailure !== undefined && headAtFailure !== startingHead;
      let rollbackError: string | undefined;
      if (startingHead) {
        try {
          await git.raw(['reset', '--mixed', startingHead]);
        } catch (restoreError: unknown) {
          rollbackError = (restoreError as { message?: string }).message ?? 'reset failed';
        }
      }
      const currentSha = (await git.revparse(['HEAD']).catch(() => '')).trim();
      const message = rollbackError
        ? `${err.message || 'Commit failed'}; failed to restore worktree HEAD: ${rollbackError}`
        : err.message || 'Commit failed';
      if (rollbackError) {
        return commitFailure('ROLLBACK_FAILED', message, { sha: currentSha, mutation: 'unknown' });
      }
      if (commitExisted) {
        // The commit existed and verification rejected its message. Report a
        // durable mutation so callers inspect instead of repeating the commit.
        return commitFailure('POST_INTEGRATION_VERIFICATION_FAILED', message, {
          sha: currentSha,
          mutation: 'applied',
        });
      }
      return commitFailure('GIT_OPERATION_FAILED', message, { sha: currentSha });
    }
  }

  private async commitLegacy(feature: string, step: string, message?: string): Promise<CommitResult> {
    return aggregateFromRepoCommit(await this.commitOneRepo(this.getWorktreePath(feature, step), message));
  }

  async merge(
    feature: string,
    step: string,
    strategy: "merge" | "squash" | "rebase" = "squash",
    message?: string,
    options: MergeOptions = {},
  ): Promise<MergeResult> {
    const cleanupMode = options.cleanup ?? 'none';
    const preserveConflicts = options.preserveConflicts ?? false;

    if (strategy === "rebase" && message?.trim()) {
      return mergeFailure(strategy, 'MESSAGE_NOT_ALLOWED_FOR_REBASE', "Custom merge message is not supported for rebase strategy");
    }

    let registered: WorktreeInfo | null;
    try {
      registered = await this.get(feature, step);
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
    const manifest = await this.readWorkspaceManifest(feature, step);
    if (manifest) {
      return this.mergeComposite(feature, step, manifest, strategy, message, {
        cleanup: cleanupMode,
        preserveConflicts,
      });
    }

    const branchName = this.getLegacyBranchName(feature, step);
    const repoResult = await this.mergeOneRepo({
      git: this.getGit(),
      branchName,
      strategy,
      message,
      preserveConflicts,
      cleanupMode,
      cleanupFn: async (deleteBranch: boolean) => this.removeLegacy(feature, step, deleteBranch, { allowUnmergedCommits: true }),
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
    options: { cleanup: 'none' | 'worktree' | 'worktree+branch'; preserveConflicts: boolean },
  ): Promise<MergeResult> {
    const repoIds = Object.keys(manifest.repos).sort();
    const trustedById = this.trustedRepositoriesForManifest(manifest);

    const preflightFailure = (repoId: string, reason: string, reasonCode: WorktreeReasonCode): MergeResult =>
      mergeFailure(strategy, reasonCode, `${repoId}: ${reason}`, { partial: false });

    // Preflight all repos before any mutation
    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      const repoRoot = trustedById.get(repoId)!.path;
      const repoGit = this.getGit(repoRoot);

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
        const statePath = await this.resolveGitPath(repoGit, repoRoot, name);
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
          const sourceError = await this.validateSourceCommitMessages(repoGit, currentBranch, entry.branch);
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
        cleanupFn: async () => mergeCleanupResult(noCleanupRequested()),
      });
      repos[repoId] = repoResult;
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
    let cleanup = noCleanupRequested();
    if (options.cleanup !== 'none') {
      const deleteBranch = options.cleanup === 'worktree+branch';
      const perRepo: Array<{ repoId: string; cleanup: WorktreeCleanupOutcome }> = [];
      for (const repoId of repoIds) {
        const entry = manifest.repos[repoId];
        const repoRoot = trustedById.get(repoId)!.path;
        const repoCleanup = await this.removeCompositeRepo(
          feature,
          step,
          entry,
          repoRoot,
          deleteBranch,
          { allowUnmergedCommits: true },
        );
        repos[repoId].cleanup = toMergeCleanupBlock(repoCleanup);
        perRepo.push({ repoId, cleanup: repoCleanup });
      }
      // Tear down the composite root after per-repo cleanup.
      const compositeRoot = this.getCompositeRoot(feature, step);
      let rootFailure: { cause: string } | undefined;
      try {
        await fs.rm(compositeRoot, { recursive: true, force: true });
      } catch (error: unknown) {
        const err = error as { message?: string };
        rootFailure = { cause: err.message || 'composite root removal failed' };
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

  private async resolveGitPath(git: SimpleGit, repoRoot: string, name: string): Promise<string> {
    try {
      const out = (await git.raw(['rev-parse', '--git-path', name])).trim();
      if (!out) return path.join(repoRoot, '.git', name);
      return path.isAbsolute(out) ? out : path.join(repoRoot, out);
    } catch {
      return path.join(repoRoot, '.git', name);
    }
  }

  private async validateSourceCommitMessages(
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

  private async readValidatedCommitMessage(git: SimpleGit, hash: string): Promise<string> {
    const rawMessage = await git.raw(['show', '-s', '--format=%B', hash]);
    return normalizeCommitMessage(rawMessage);
  }

  private async removeCompositeRepo(
    feature: string,
    step: string,
    entry: WorkspaceManifestEntry,
    repositoryPath: string,
    deleteBranch: boolean,
    options: RemoveOptions = {},
  ): Promise<WorktreeCleanupOutcome> {
    const compositeRoot = this.getCompositeRoot(feature, step);
    const repoWtPath = path.join(compositeRoot, entry.path);
    const repoGit = this.getGit(repositoryPath);

    if (deleteBranch) {
      await this.assertBranchDeletionSafe(repoGit, entry.branch, options.allowUnmergedCommits === true);
    }

    return buildCleanupOutcome(deleteBranch ? 'worktree+branch' : 'worktree', {
      worktreeRemoval: await this.removeWorktreeStep(repoGit, repoWtPath),
      prune: await this.pruneWorktreesStep(repoGit),
      branchDeletion: deleteBranch
        ? await this.deleteBranchStep(repoGit, entry.branch)
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
      await git.raw(['worktree', 'remove', worktreePath, '--force']);
      return { status: 'succeeded' };
    } catch (error: unknown) {
      gitError = (error as { message?: string }).message;
    }
    try {
      await fs.rm(worktreePath, { recursive: true, force: true });
      return { status: 'succeeded' };
    } catch (error: unknown) {
      const err = error as { message?: string };
      const cause = err.message || 'worktree removal failed';
      return { status: 'failed', error: gitError ? `${cause} (git: ${gitError})` : cause };
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
  private async deleteBranchStep(git: SimpleGit, branchName: string): Promise<CleanupStepOutcome> {
    const present = await git.branch()
      .then((branches) => branches.all.includes(branchName))
      .catch(() => true);
    if (!present) return { status: 'already_absent' };
    try {
      await git.deleteLocalBranch(branchName, true);
      return { status: 'succeeded' };
    } catch (error: unknown) {
      const err = error as { message?: string };
      return { status: 'failed', error: err.message || 'branch deletion failed' };
    }
  }

  private async mergeOneRepo(opts: {
    git: SimpleGit;
    branchName: string;
    strategy: 'merge' | 'squash' | 'rebase';
    message: string | undefined;
    preserveConflicts: boolean;
    cleanupMode: 'none' | 'worktree' | 'worktree+branch';
    cleanupFn: (deleteBranch: boolean) => Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean; cleanup: WorktreeCleanupOutcome }>;
  }): Promise<RepoMergeResult> {
    const { git, branchName, strategy, message, preserveConflicts, cleanupMode, cleanupFn } = opts;

    let startingHead: string | undefined;
    // Set immediately before a requested cleanup call in each success path to
    // the mutation that path reports. Once set, the target state is final: a
    // cleanup throw is classified as a cleanup failure over that state and must
    // not be rolled back.
    let cleanupFailureMutation: WorktreeMutationState | undefined;
    let verificationFailure = false;

    try {
      const branches = await git.branch();
      if (!branches.all.includes(branchName)) {
        return mergeRepoFailure('SOURCE_BRANCH_MISSING', `Branch ${branchName} not found`);
      }

      const currentBranch = branches.current;

      const repoRoot = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
      const stateChecks: Array<{ name: string; label: string }> = [
        { name: 'MERGE_HEAD', label: 'merge' },
        { name: 'REBASE_HEAD', label: 'rebase' },
        { name: 'CHERRY_PICK_HEAD', label: 'cherry-pick' },
        { name: 'rebase-merge', label: 'rebase' },
        { name: 'rebase-apply', label: 'rebase' },
      ];
      for (const { name, label } of stateChecks) {
        const statePath = await this.resolveGitPath(git, repoRoot, name);
        try {
          await fs.access(statePath);
          return mergeRepoFailure('GIT_OPERATION_IN_PROGRESS', `active ${label} state in progress`);
        } catch {
          // not present -> ok
        }
      }

      const targetStatus = await git.status();
      if (!targetStatus.isClean()) {
        return mergeRepoFailure('TARGET_DIRTY', 'Target repo has uncommitted (dirty) changes');
      }
      startingHead = (await git.revparse(['HEAD'])).trim();

      // Endpoint comparison only decides whether there is anything to
      // integrate. It is not the reported delta: it can include files that
      // only the target changed after the source branch forked.
      const candidateFiles = (await git.diff([startingHead, branchName, '--name-only']))
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

      if (candidateFiles.length === 0) {
        cleanupFailureMutation = 'none';
        const cleanup = cleanupMode === 'none'
          ? noCleanupRequested()
          : (await cleanupFn(cleanupMode === 'worktree+branch')).cleanup;
        return {
          success: true,
          merged: false,
          reason: 'nothing_to_merge',
          reasonCode: 'NO_TRACKED_CHANGES',
          cleanupEligible: true,
          taskUpdateRecommended: true,
          filesChanged: [],
          conflicts: [],
          conflictState: 'none',
          cleanup: toMergeCleanupBlock(cleanup),
          ...mergeSuccessClassification(cleanupMode, cleanup, 'none'),
        };
      }

      let commitMessage: string | undefined;
      if (strategy === 'rebase') {
        if (message?.trim()) {
          return mergeRepoFailure(
            'MESSAGE_NOT_ALLOWED_FOR_REBASE',
            'Custom merge message is not supported for rebase strategy',
          );
        }
      } else {
        try {
          commitMessage = normalizeCommitMessage(message);
        } catch (error: unknown) {
          const err = error as { message?: string };
          return mergeRepoFailure('INVALID_MERGE_MESSAGE', err.message || 'Invalid merge message');
        }
      }
      if (strategy !== 'squash') {
        const sourceError = await this.validateSourceCommitMessages(git, currentBranch, branchName);
        if (sourceError) return mergeRepoFailure('INVALID_COMMIT_MESSAGE', sourceError);
      }

      let finalHead: string;
      let conflicts: string[] = [];
      let createdCommitMessage: string | undefined;
      if (strategy === 'squash') {
        await git.raw(['merge', '--squash', branchName]);
        await git.commit(commitMessage!);
        finalHead = (await git.revparse(['HEAD'])).trim();
        if (finalHead === startingHead) throw new Error('Failed to create squash commit');
        try {
          createdCommitMessage = await this.readValidatedCommitMessage(git, finalHead);
        } catch (verificationError: unknown) {
          verificationFailure = true;
          throw verificationError;
        }
      } else if (strategy === 'rebase') {
        const sourceHashesOutput = (await git.raw(['rev-list', '--reverse', `${currentBranch}..${branchName}`])).trim();
        const sourceHashes = sourceHashesOutput ? sourceHashesOutput.split('\n').filter(Boolean) : [];
        for (const hash of sourceHashes) {
          await git.raw(['cherry-pick', hash]);
          const cherryPickedHead = (await git.revparse(['HEAD'])).trim();
          try {
            await this.readValidatedCommitMessage(git, cherryPickedHead);
          } catch (verificationError: unknown) {
            verificationFailure = true;
            throw verificationError;
          }
        }
        finalHead = (await git.revparse(['HEAD'])).trim();
      } else {
        const result = await git.merge([branchName, '--no-ff', '-m', commitMessage!]);
        finalHead = (await git.revparse(['HEAD'])).trim();
        if (result.failed || finalHead === startingHead) throw new Error('Failed to create merge commit');
        try {
          createdCommitMessage = await this.readValidatedCommitMessage(git, finalHead);
        } catch (verificationError: unknown) {
          verificationFailure = true;
          throw verificationError;
        }
        conflicts = result.conflicts?.map(c => c.file || String(c)) || [];
      }

      // Integration must move HEAD. A rebase with no applicable source commits
      // leaves the target at its starting commit and is a successful no-op.
      if (finalHead === startingHead) {
        cleanupFailureMutation = 'none';
        const cleanup = cleanupMode === 'none'
          ? noCleanupRequested()
          : (await cleanupFn(cleanupMode === 'worktree+branch')).cleanup;
        return {
          success: true,
          merged: false,
          reason: 'nothing_to_merge',
          reasonCode: 'NO_TRACKED_CHANGES',
          cleanupEligible: true,
          taskUpdateRecommended: true,
          filesChanged: [],
          conflicts: [],
          conflictState: 'none',
          cleanup: toMergeCleanupBlock(cleanup),
          ...mergeSuccessClassification(cleanupMode, cleanup, 'none'),
        };
      }

      const observedFiles = await this.observedDeltaFiles(git, startingHead, finalHead);
      cleanupFailureMutation = 'applied';
      const cleanup = cleanupMode === 'none'
        ? noCleanupRequested()
        : (await cleanupFn(cleanupMode === 'worktree+branch')).cleanup;
      return {
        success: true,
        merged: true,
        sha: finalHead,
        ...(createdCommitMessage !== undefined ? { commitMessage: createdCommitMessage } : {}),
        filesChanged: observedFiles,
        conflicts,
        conflictState: 'none',
        cleanup: toMergeCleanupBlock(cleanup),
        ...mergeSuccessClassification(cleanupMode, cleanup, 'applied'),
      };
    } catch (error: unknown) {
      const err = error as { message?: string };
      if (cleanupFailureMutation !== undefined) {
        // The target state was already final when the requested cleanup threw.
        // Rolling back would discard a completed integration, so report a
        // cleanup failure over the durable state instead.
        return mergeRepoFailure('CLEANUP_FAILED', err.message || 'Cleanup failed', {
          mutation: cleanupFailureMutation,
        });
      }
      const conflicts = await this.getActiveConflictFiles(git);
      const isConflict = conflicts.length > 0;
      const preserveConflictState = isConflict && preserveConflicts;
      let rollbackError: string | undefined;

      if (!preserveConflictState && startingHead) {
        if (strategy === 'merge') {
          await git.raw(['merge', '--abort']).catch(() => {});
        } else if (strategy === 'rebase') {
          await git.raw(['cherry-pick', '--abort']).catch(() => {});
        }
        try {
          await git.raw(['reset', '--hard', startingHead]);
        } catch (restoreError: unknown) {
          rollbackError = (restoreError as { message?: string }).message ?? 'reset failed';
        }
        try {
          await git.raw(['clean', '-fd']);
        } catch (cleanError: unknown) {
          rollbackError ??= (cleanError as { message?: string }).message ?? 'clean failed';
        }
      }

      if (rollbackError) {
        return mergeRepoFailure(
          'ROLLBACK_FAILED',
          `${err.message || "Merge failed"}; failed to restore target: ${rollbackError}`,
          { mutation: 'unknown', conflicts: isConflict ? conflicts : [], conflictState: preserveConflictState ? 'preserved' : 'none' },
        );
      }

      if (isConflict) {
        return mergeRepoFailure(
          preserveConflictState ? 'MERGE_CONFLICT_PRESERVED' : 'MERGE_CONFLICT_ABORTED',
          "Merge conflicts detected",
          {
            conflicts,
            conflictState: preserveConflictState ? 'preserved' : 'aborted',
          },
        );
      }

      if (verificationFailure) {
        // A commit was created and its message was rejected. The target was
        // restored, but the created commit's identity is not confirmed, so
        // callers inspect instead of repeating the integration.
        return mergeRepoFailure('POST_INTEGRATION_VERIFICATION_FAILED', err.message || "Merge failed", {
          mutation: 'unknown',
        });
      }

      return mergeRepoFailure('GIT_OPERATION_FAILED', err.message || "Merge failed");
    }
  }

  /**
   * Reported integration delta: the observed target difference between the
   * pre-merge starting commit and the final commit.
   */
  private async observedDeltaFiles(git: SimpleGit, startingHead: string, finalHead: string): Promise<string[]> {
    const output = await git.diff([startingHead, finalHead, '--name-only']);
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async hasUncommittedChanges(feature: string, step: string): Promise<boolean> {
    await this.get(feature, step);
    const manifest = await this.readWorkspaceManifest(feature, step);
    if (manifest) {
      const compositeRoot = this.getCompositeRoot(feature, step);
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

    const worktreePath = this.getWorktreePath(feature, step);

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

  private async getActiveConflictFiles(git: SimpleGit): Promise<string[]> {
    try {
      const output = (await git.raw(['diff', '--name-only', '--diff-filter=U'])).trim();
      return output ? [...new Set(output.split('\n').filter(Boolean))] : [];
    } catch {
      return [];
    }
  }
}

export function createWorktreeService(projectDir: string): WorktreeService {
  return new WorktreeService({
    baseDir: projectDir,
    hiveDir: path.join(projectDir, ".hive"),
  });
}
