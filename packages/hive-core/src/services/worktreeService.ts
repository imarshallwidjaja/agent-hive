import * as fs from "fs/promises";
import * as path from "path";
import simpleGit, { SimpleGit } from "simple-git";
import type { ResolvedRepository, TaskStatus } from "../types.js";
import { resolveFeatureDirectoryName } from "../utils/paths.js";

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
}

export interface RepoCommitResult {
  committed: boolean;
  sha: string;
  message?: string;
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
  filesChanged: string[];
  conflicts: string[];
  conflictState: 'none' | 'aborted' | 'preserved';
  cleanup: {
    worktreeRemoved: boolean;
    branchDeleted: boolean;
    pruned: boolean;
  };
  error?: string;
  /** Per-repo merge results when the workspace is a composite. Omitted for legacy single-root workspaces. */
  repos?: Record<string, RepoMergeResult>;
  /**
   * True when at least one repo merged successfully and a later repo failed (conflict or mutation error).
   * Explicit `false` when preflight rejected the merge before any repo was mutated.
   * Undefined for legacy single-root merges and for clean composite success.
   */
  partial?: boolean;
}

export interface RepoMergeResult {
  success: boolean;
  merged: boolean;
  sha?: string;
  filesChanged: string[];
  conflicts: string[];
  conflictState: 'none' | 'aborted' | 'preserved';
  cleanup: {
    worktreeRemoved: boolean;
    branchDeleted: boolean;
    pruned: boolean;
  };
  error?: string;
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

interface WorkspaceManifestEntry {
  /** Worktree-relative path under the composite root (e.g., 'repos/api'). */
  path: string;
  /** Absolute path to the source repository git root (used to invoke git for this repo). */
  repoRoot: string;
  /** Stable absolute source repo path as configured in the repository manifest. */
  repoPath: string;
  branch: string;
  commit: string;
}

interface WorkspaceManifest {
  schemaVersion: 1;
  feature: string;
  task: string;
  mode: 'composite';
  repos: Record<string, WorkspaceManifestEntry>;
  baseCommits: Record<string, string>;
  createdAt: string;
}

export class WorktreeService {
  private config: WorktreeConfig;

  constructor(config: WorktreeConfig) {
    this.config = config;
  }

  private getGit(cwd?: string): SimpleGit {
    return simpleGit(cwd || this.config.baseDir);
  }

  private getWorktreesDir(): string {
    return path.join(this.config.hiveDir, ".worktrees");
  }

  /** Legacy single-repo worktree path. */
  private getWorktreePath(feature: string, step: string): string {
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
    const branchName = this.getLegacyBranchName(feature, step);
    const git = this.getGit();

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });

    const base = baseBranch || (await git.revparse(["HEAD"])).trim();

    const existing = await this.get(feature, step);
    if (existing) {
      return existing;
    }

    try {
      await git.raw(["worktree", "add", "-b", branchName, worktreePath, base]);
    } catch {
      try {
        await git.raw(["worktree", "add", worktreePath, branchName]);
      } catch (retryError) {
        throw new Error(`Failed to create worktree: ${retryError}`);
      }
    }

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

  private async createComposite(
    feature: string,
    step: string,
    repos: ResolvedRepository[],
    repoIds: string[],
    baseBranch?: string,
  ): Promise<WorktreeInfo> {
    // Existing composite workspace -> return aggregate info
    const existing = await this.get(feature, step);
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
          await repoGit.raw(["worktree", "add", "-b", branchName, repoWtPath, base]);
        } catch (createError) {
          throw new Error(`Failed to create worktree for repo ${repoId}: ${createError}`);
        }
        createdRepos.push({ repoId, repoPath: repo.path, branchName, git: repoGit });

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
    try {
      const raw = await fs.readFile(this.getWorkspaceManifestPath(feature, step), 'utf-8');
      return JSON.parse(raw) as WorkspaceManifest;
    } catch {
      return null;
    }
  }

  async get(feature: string, step: string): Promise<WorktreeInfo | null> {
    const manifest = await this.readWorkspaceManifest(feature, step);
    if (manifest) {
      const compositeRoot = this.getCompositeRoot(feature, step);
      const repos: Record<string, WorktreeRepoInfo> = {};
      const baseCommits: Record<string, string> = { ...manifest.baseCommits };
      const repoIds = Object.keys(manifest.repos);
      for (const id of repoIds) {
        const repoWtPath = path.join(compositeRoot, manifest.repos[id].path);
        let commit = manifest.repos[id].commit;
        try {
          commit = (await this.getGit(repoWtPath).revparse(["HEAD"])).trim();
        } catch {}
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
    } catch {
      return null;
    }
  }

  async getDiff(feature: string, step: string, baseCommit?: string): Promise<DiffResult> {
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
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean }> {
    const manifest = await this.readWorkspaceManifest(feature, step);
    if (manifest) {
      return this.removeComposite(feature, step, manifest, deleteBranch);
    }
    return this.removeLegacy(feature, step, deleteBranch);
  }

  private async removeLegacy(
    feature: string,
    step: string,
    deleteBranch: boolean,
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean }> {
    const worktreePath = this.getWorktreePath(feature, step);
    const branchName = this.getLegacyBranchName(feature, step);
    const git = this.getGit();
    let worktreeRemoved = false;
    let branchDeleted = false;
    let pruned = false;

    try {
      await git.raw(["worktree", "remove", worktreePath, "--force"]);
      worktreeRemoved = true;
    } catch {
      await fs.rm(worktreePath, { recursive: true, force: true });
      worktreeRemoved = true;
    }

    try {
      await git.raw(["worktree", "prune"]);
      pruned = true;
    } catch {
      /* intentional */
    }

    if (deleteBranch) {
      try {
        await git.deleteLocalBranch(branchName, true);
        branchDeleted = true;
      } catch {
        /* intentional */
      }
    }

    return { worktreeRemoved, branchDeleted, pruned };
  }

  private async removeComposite(
    feature: string,
    step: string,
    manifest: WorkspaceManifest,
    deleteBranch: boolean,
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean }> {
    const compositeRoot = this.getCompositeRoot(feature, step);
    const resolved = this.resolveRepositories();
    const reposById = new Map((resolved ?? []).map(r => [r.id, r]));

    let allWorktreesRemoved = true;
    let allBranchesDeleted = true;
    let prunedAny = false;
    let branchAttempts = 0;

    for (const [repoId, entry] of Object.entries(manifest.repos)) {
      const repoRoot = entry.repoRoot || reposById.get(repoId)?.path;
      const perRepo = await this.removeCompositeRepo(
        feature,
        step,
        repoId,
        entry,
        repoRoot,
        deleteBranch,
      );
      if (!perRepo.worktreeRemoved) allWorktreesRemoved = false;
      if (perRepo.pruned) prunedAny = true;
      if (deleteBranch) {
        branchAttempts++;
        if (!perRepo.branchDeleted) allBranchesDeleted = false;
      }
    }

    // Clean up the composite root directory itself
    try {
      await fs.rm(compositeRoot, { recursive: true, force: true });
    } catch {
      allWorktreesRemoved = false;
    }

    return {
      worktreeRemoved: allWorktreesRemoved,
      branchDeleted: deleteBranch && branchAttempts > 0 && allBranchesDeleted,
      pruned: prunedAny,
    };
  }

  async list(feature?: string): Promise<WorktreeInfo[]> {
    const worktreesDir = this.getWorktreesDir();
    const results: WorktreeInfo[] = [];

    try {
      const features = feature ? [feature] : await fs.readdir(worktreesDir);

      for (const feat of features) {
        const featurePath = path.join(worktreesDir, feat);
        const stat = await fs.stat(featurePath).catch(() => null);

        if (!stat?.isDirectory()) continue;

        const steps = await fs.readdir(featurePath).catch(() => []);

        for (const step of steps) {
          const info = await this.get(feat, step);
          if (info) {
            results.push(info);
          }
        }
      }
    } catch {
      /* intentional */
    }

    return results;
  }

  async cleanup(feature?: string): Promise<{ removed: string[]; pruned: boolean }> {
    const removed: string[] = [];
    const git = this.getGit();

    try {
      await git.raw(["worktree", "prune"]);
    } catch {
      /* intentional */
    }

    const worktreesDir = this.getWorktreesDir();
    const features = feature ? [feature] : await fs.readdir(worktreesDir).catch(() => []);

    for (const feat of features) {
      const featurePath = path.join(worktreesDir, feat);
      const stat = await fs.stat(featurePath).catch(() => null);

      if (!stat?.isDirectory()) continue;

      const steps = await fs.readdir(featurePath).catch(() => []);

      for (const step of steps) {
        const worktreePath = path.join(featurePath, step);
        const stepStat = await fs.stat(worktreePath).catch(() => null);

        if (!stepStat?.isDirectory()) continue;

        const manifest = await this.readWorkspaceManifest(feat, step);
        if (manifest) {
          // Composite: stale if any per-repo worktree fails revparse
          let stale = false;
          for (const [, entry] of Object.entries(manifest.repos)) {
            const repoWt = path.join(worktreePath, entry.path);
            try {
              await this.getGit(repoWt).revparse(["HEAD"]);
            } catch {
              stale = true;
              break;
            }
          }
          if (stale) {
            await this.remove(feat, step, false);
            removed.push(worktreePath);
          }
          continue;
        }

        try {
          const worktreeGit = this.getGit(worktreePath);
          await worktreeGit.revparse(["HEAD"]);
        } catch {
          await this.remove(feat, step, false);
          removed.push(worktreePath);
        }
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

  async commitChanges(feature: string, step: string, message?: string): Promise<CommitResult> {
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
      const commitMessage = message || `hive(${step}): task changes`;
      const repoResult = await this.commitOneRepo(repoWtPath, commitMessage);
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
    const firstResult = repos[repoIds[0]];

    const result: CommitResult = {
      committed,
      sha: firstResult.sha,
      message: firstResult.message,
      repos,
    };
    if (partial) result.partial = true;
    if (firstError) result.error = firstError;
    return result;
  }

  private async commitOneRepo(repoWtPath: string, commitMessage: string): Promise<RepoCommitResult> {
    try {
      await fs.access(repoWtPath);
    } catch {
      return { committed: false, sha: '', message: 'Worktree not found' };
    }

    const git = this.getGit(repoWtPath);
    try {
      await git.add('-A');
      const status = await git.status();
      const hasChanges =
        status.staged.length > 0 ||
        status.modified.length > 0 ||
        status.not_added.length > 0 ||
        status.deleted.length > 0 ||
        status.created.length > 0;

      if (!hasChanges) {
        const currentSha = (await git.revparse(['HEAD']).catch(() => '')).trim();
        return { committed: false, sha: currentSha, message: 'No changes to commit' };
      }

      const result = await git.commit(commitMessage, ['--allow-empty-message']);
      return { committed: true, sha: result.commit, message: commitMessage };
    } catch (error: unknown) {
      const err = error as { message?: string };
      const currentSha = (await git.revparse(['HEAD']).catch(() => '')).trim();
      return {
        committed: false,
        sha: currentSha,
        message: err.message || 'Commit failed',
      };
    }
  }

  private async commitLegacy(feature: string, step: string, message?: string): Promise<CommitResult> {
    const commitMessage = message || `hive(${step}): task changes`;
    return this.commitOneRepo(this.getWorktreePath(feature, step), commitMessage);
  }

  async merge(
    feature: string,
    step: string,
    strategy: "merge" | "squash" | "rebase" = "merge",
    message?: string,
    options: MergeOptions = {},
  ): Promise<MergeResult> {
    const cleanupMode = options.cleanup ?? 'none';
    const preserveConflicts = options.preserveConflicts ?? false;

    const emptyCleanup = {
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
    };

    if (strategy === "rebase" && message) {
      return {
        success: false,
        merged: false,
        strategy,
        filesChanged: [],
        conflicts: [],
        conflictState: 'none',
        cleanup: emptyCleanup,
        error: "Custom merge message is not supported for rebase strategy",
      };
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
      step,
      preserveConflicts,
      cleanupMode,
      cleanupFn: async (deleteBranch: boolean) => this.removeLegacy(feature, step, deleteBranch),
    });
    return {
      success: repoResult.success,
      merged: repoResult.merged,
      strategy,
      sha: repoResult.sha,
      filesChanged: repoResult.filesChanged,
      conflicts: repoResult.conflicts,
      conflictState: repoResult.conflictState,
      cleanup: repoResult.cleanup,
      ...(repoResult.error !== undefined ? { error: repoResult.error } : {}),
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
    const emptyCleanup = {
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
    };

    const preflightFailure = (repoId: string, reason: string): MergeResult => ({
      success: false,
      merged: false,
      strategy,
      filesChanged: [],
      conflicts: [],
      conflictState: 'none',
      cleanup: emptyCleanup,
      error: `${repoId}: ${reason}`,
      partial: false,
    });

    // Preflight all repos before any mutation
    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      const repoRoot = entry.repoRoot || entry.repoPath;
      if (!repoRoot) {
        return preflightFailure(repoId, 'missing source repo root in workspace manifest');
      }
      const repoGit = this.getGit(repoRoot);

      // Branch must exist in the source repo
      try {
        const branches = await repoGit.branch();
        if (!branches.all.includes(entry.branch)) {
          return preflightFailure(repoId, `branch ${entry.branch} not found`);
        }
      } catch (e: unknown) {
        const msg = (e as { message?: string }).message ?? 'unable to list branches';
        return preflightFailure(repoId, msg);
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
          return preflightFailure(repoId, 'target repo has uncommitted (dirty) changes');
        }
      } catch (e: unknown) {
        const msg = (e as { message?: string }).message ?? 'unable to read status';
        return preflightFailure(repoId, msg);
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
          return preflightFailure(repoId, `active ${label} state in progress`);
        } catch {
          // not present -> ok
        }
      }
    }

    // Execute per-repo merges in stable order
    const repos: Record<string, RepoMergeResult> = {};
    const flattenedFiles: string[] = [];
    const flattenedConflicts: string[] = [];
    let anySuccess = false;
    let stoppedRepoId: string | undefined;
    let firstError: string | undefined;
    let lastConflictState: 'none' | 'aborted' | 'preserved' = 'none';

    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      const repoRoot = entry.repoRoot || entry.repoPath;
      const repoGit = this.getGit(repoRoot);
      const repoResult = await this.mergeOneRepo({
        git: repoGit,
        branchName: entry.branch,
        strategy,
        message,
        step,
        preserveConflicts: options.preserveConflicts,
        cleanupMode: 'none', // defer cleanup until after all repos succeed
        cleanupFn: async () => ({ worktreeRemoved: false, branchDeleted: false, pruned: false }),
      });
      repos[repoId] = repoResult;
      for (const f of repoResult.filesChanged) flattenedFiles.push(`${repoId}:${f}`);
      for (const c of repoResult.conflicts) flattenedConflicts.push(`${repoId}:${c}`);

      // Stop immediately on per-repo failure (success=false) OR a "successful"
      // call that did not actually merge (success=true, merged=false).
      // The latter must not be silently aggregated as a clean composite merge.
      if (!repoResult.success || !repoResult.merged) {
        stoppedRepoId = repoId;
        firstError = `${repoId}: ${repoResult.error ?? (repoResult.success ? 'repo reported merged=false' : 'merge failed')}`;
        lastConflictState = repoResult.conflictState;
        break;
      }
      anySuccess = true;
    }

    if (stoppedRepoId !== undefined) {
      // Stop: do not rollback earlier successful repo merges
      const partial = anySuccess;
      return {
        success: false,
        merged: false,
        strategy,
        filesChanged: flattenedFiles,
        conflicts: flattenedConflicts,
        conflictState: lastConflictState,
        cleanup: emptyCleanup,
        error: firstError,
        repos,
        partial,
      };
    }

    // All repos merged. Apply per-repo cleanup and populate each
    // repos[repoId].cleanup field; aggregate top-level cleanup from per-repo
    // results so the contract holds for both shapes.
    let cleanup = { worktreeRemoved: false, branchDeleted: false, pruned: false };
    if (options.cleanup !== 'none') {
      const deleteBranch = options.cleanup === 'worktree+branch';
      const perRepoCleanups: Array<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean }> = [];
      for (const repoId of repoIds) {
        const entry = manifest.repos[repoId];
        const repoRoot = entry.repoRoot || entry.repoPath;
        const repoCleanup = await this.removeCompositeRepo(
          feature,
          step,
          repoId,
          entry,
          repoRoot,
          deleteBranch,
        );
        repos[repoId].cleanup = repoCleanup;
        perRepoCleanups.push(repoCleanup);
      }
      // Tear down the composite root after per-repo cleanup.
      const compositeRoot = this.getCompositeRoot(feature, step);
      let rootRemoved = true;
      try {
        await fs.rm(compositeRoot, { recursive: true, force: true });
      } catch {
        rootRemoved = false;
      }
      cleanup = {
        worktreeRemoved: rootRemoved && perRepoCleanups.every(c => c.worktreeRemoved),
        branchDeleted: deleteBranch && perRepoCleanups.length > 0 && perRepoCleanups.every(c => c.branchDeleted),
        pruned: perRepoCleanups.some(c => c.pruned),
      };
    }

    // Top-level sha = first repo (stable order) result sha
    const firstSha = repos[repoIds[0]].sha;

    return {
      success: true,
      merged: true,
      strategy,
      sha: firstSha,
      filesChanged: flattenedFiles,
      conflicts: flattenedConflicts,
      conflictState: 'none',
      cleanup,
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

  private async removeCompositeRepo(
    feature: string,
    step: string,
    repoId: string,
    entry: WorkspaceManifestEntry,
    repoRoot: string | undefined,
    deleteBranch: boolean,
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean }> {
    const compositeRoot = this.getCompositeRoot(feature, step);
    const repoWtPath = path.join(compositeRoot, entry.path);
    const repoGit = repoRoot ? this.getGit(repoRoot) : null;
    void repoId;

    let worktreeRemoved = false;
    let pruned = false;
    let branchDeleted = false;

    if (repoGit) {
      try {
        await repoGit.raw(['worktree', 'remove', repoWtPath, '--force']);
        worktreeRemoved = true;
      } catch {
        // fall through to fs.rm fallback
      }
      try {
        await repoGit.raw(['worktree', 'prune']);
        pruned = true;
      } catch {
        /* intentional */
      }
    }
    if (!worktreeRemoved) {
      try {
        await fs.rm(repoWtPath, { recursive: true, force: true });
        worktreeRemoved = true;
      } catch {
        worktreeRemoved = false;
      }
    }

    if (deleteBranch && repoGit) {
      try {
        await repoGit.deleteLocalBranch(entry.branch, true);
        branchDeleted = true;
      } catch {
        branchDeleted = false;
      }
    }

    return { worktreeRemoved, branchDeleted, pruned };
  }

  private async mergeOneRepo(opts: {
    git: SimpleGit;
    branchName: string;
    strategy: 'merge' | 'squash' | 'rebase';
    message: string | undefined;
    step: string;
    preserveConflicts: boolean;
    cleanupMode: 'none' | 'worktree' | 'worktree+branch';
    cleanupFn: (deleteBranch: boolean) => Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean }>;
  }): Promise<RepoMergeResult> {
    const { git, branchName, strategy, message, step, preserveConflicts, cleanupMode, cleanupFn } = opts;
    const emptyCleanup = {
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
    };

    let filesChanged: string[] = [];

    try {
      const branches = await git.branch();
      if (!branches.all.includes(branchName)) {
        return {
          success: false,
          merged: false,
          filesChanged: [],
          conflicts: [],
          conflictState: 'none',
          cleanup: emptyCleanup,
          error: `Branch ${branchName} not found`,
        };
      }

      const currentBranch = branches.current;

      const diffStat = await git.diff([`${currentBranch}...${branchName}`, "--stat"]);
      filesChanged = diffStat
        .split("\n")
        .filter(l => l.trim() && l.includes("|"))
        .map(l => l.split("|")[0].trim());

      if (strategy === "squash") {
        await git.raw(["merge", "--squash", branchName]);
        const squashMessage = message || `hive: merge ${step} (squashed)`;
        const result = await git.commit(squashMessage);
        const cleanup = cleanupMode === 'none' ? emptyCleanup : await cleanupFn(cleanupMode === 'worktree+branch');
        return {
          success: true,
          merged: true,
          sha: result.commit,
          filesChanged,
          conflicts: [],
          conflictState: 'none',
          cleanup,
        };
      } else if (strategy === "rebase") {
        const commits = await git.log([`${currentBranch}..${branchName}`]);
        const commitsToApply = [...commits.all].reverse();
        for (const commit of commitsToApply) {
          await git.raw(["cherry-pick", commit.hash]);
        }
        const head = (await git.revparse(["HEAD"])).trim();
        const cleanup = cleanupMode === 'none' ? emptyCleanup : await cleanupFn(cleanupMode === 'worktree+branch');
        return {
          success: true,
          merged: true,
          sha: head,
          filesChanged,
          conflicts: [],
          conflictState: 'none',
          cleanup,
        };
      } else {
        const mergeMessage = message || `hive: merge ${step}`;
        const result = await git.merge([branchName, "--no-ff", "-m", mergeMessage]);
        const head = (await git.revparse(["HEAD"])).trim();
        const cleanup = cleanupMode === 'none' ? emptyCleanup : await cleanupFn(cleanupMode === 'worktree+branch');
        return {
          success: true,
          merged: !result.failed,
          sha: head,
          filesChanged,
          conflicts: result.conflicts?.map(c => c.file || String(c)) || [],
          conflictState: 'none',
          cleanup,
        };
      }
    } catch (error: unknown) {
      const err = error as { message?: string };

      if (err.message?.includes("CONFLICT") || err.message?.includes("conflict")) {
        const conflicts = await this.getActiveConflictFiles(git, err.message || '');
        const conflictState = preserveConflicts ? 'preserved' : 'aborted';

        if (!preserveConflicts) {
          await git.raw(["merge", "--abort"]).catch(() => {});
          await git.raw(["rebase", "--abort"]).catch(() => {});
          await git.raw(["cherry-pick", "--abort"]).catch(() => {});
        }

        return {
          success: false,
          merged: false,
          filesChanged,
          conflicts,
          conflictState,
          cleanup: emptyCleanup,
          error: "Merge conflicts detected",
        };
      }

      return {
        success: false,
        merged: false,
        filesChanged,
        conflicts: [],
        conflictState: 'none',
        cleanup: emptyCleanup,
        error: err.message || "Merge failed",
      };
    }
  }

  async hasUncommittedChanges(feature: string, step: string): Promise<boolean> {
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

  private parseConflictsFromError(errorMessage: string): string[] {
    const conflicts: string[] = [];
    const lines = errorMessage.split("\n");
    for (const line of lines) {
      if (line.includes("CONFLICT") && line.includes("Merge conflict in")) {
        const match = line.match(/Merge conflict in (.+)/);
        if (match) conflicts.push(match[1]);
      }
    }
    return conflicts;
  }

  private async getActiveConflictFiles(git: SimpleGit, errorMessage: string): Promise<string[]> {
    try {
      const status = await git.status();
      if (status.conflicted.length > 0) {
        return [...new Set(status.conflicted)];
      }
    } catch {
      /* intentional */
    }

    return this.parseConflictsFromError(errorMessage);
  }
}

export function createWorktreeService(projectDir: string): WorktreeService {
  return new WorktreeService({
    baseDir: projectDir,
    hiveDir: path.join(projectDir, ".hive"),
  });
}
