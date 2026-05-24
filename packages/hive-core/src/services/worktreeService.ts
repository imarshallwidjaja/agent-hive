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
    const worktreePath = this.getWorktreePath(feature, step);
    const statusPath = await this.getStepStatusPath(feature, step);

    let base = baseCommit;
    if (!base) {
      try {
        const status = JSON.parse(await fs.readFile(statusPath, "utf-8"));
        base = status.baseCommit;
      } catch {}
    }

    if (!base) {
      base = "HEAD~1";
    }

    const worktreeGit = this.getGit(worktreePath);

    try {
      await worktreeGit.raw(["add", "-A"]);

      const status = await worktreeGit.status();
      const hasStaged = status.staged.length > 0;

      let diffContent = "";
      let stat = "";

      if (hasStaged) {
        diffContent = await worktreeGit.diff(["--cached"]);
        stat = diffContent ? await worktreeGit.diff(["--cached", "--stat"]) : "";
      } else {
        diffContent = await worktreeGit.diff([`${base}..HEAD`]).catch(() => "");
        stat = diffContent ? await worktreeGit.diff([`${base}..HEAD`, "--stat"]) : "";
      }

      const statLines = stat.split("\n").filter((l) => l.trim());

      const filesChanged = statLines
        .slice(0, -1)
        .map((line) => line.split("|")[0].trim())
        .filter(Boolean);

      const summaryLine = statLines[statLines.length - 1] || "";
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
      return {
        hasDiff: false,
        diffContent: "",
        filesChanged: [],
        insertions: 0,
        deletions: 0,
      };
    }
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
      const repoWtPath = path.join(compositeRoot, entry.path);
      // Prefer manifest-persisted source repo root; fall back to resolver if absent.
      const repoRoot = entry.repoRoot || reposById.get(repoId)?.path;
      const repoGit = repoRoot ? this.getGit(repoRoot) : null;

      let removedHere = false;
      if (repoGit) {
        try {
          await repoGit.raw(["worktree", "remove", repoWtPath, "--force"]);
          removedHere = true;
        } catch {}
        try {
          await repoGit.raw(["worktree", "prune"]);
          prunedAny = true;
        } catch {}
      }
      if (!removedHere) {
        try {
          await fs.rm(repoWtPath, { recursive: true, force: true });
          removedHere = true;
        } catch {
          allWorktreesRemoved = false;
        }
      }

      if (deleteBranch) {
        branchAttempts++;
        if (repoGit) {
          try {
            await repoGit.deleteLocalBranch(entry.branch, true);
          } catch {
            allBranchesDeleted = false;
          }
        } else {
          allBranchesDeleted = false;
        }
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
    const worktreePath = this.getWorktreePath(feature, step);

    try {
      await fs.access(worktreePath);
    } catch {
      return { committed: false, sha: "", message: "Worktree not found" };
    }

    const worktreeGit = this.getGit(worktreePath);

    try {
      await worktreeGit.add("-A");

      const status = await worktreeGit.status();
      const hasChanges = status.staged.length > 0 || status.modified.length > 0 || status.not_added.length > 0;

      if (!hasChanges) {
        const currentSha = (await worktreeGit.revparse(["HEAD"])).trim();
        return { committed: false, sha: currentSha, message: "No changes to commit" };
      }

      const commitMessage = message || `hive(${step}): task changes`;
      const result = await worktreeGit.commit(commitMessage, ["--allow-empty-message"]);

      return {
        committed: true,
        sha: result.commit,
        message: commitMessage,
      };
    } catch (error: unknown) {
      const err = error as { message?: string };
      const currentSha = (await worktreeGit.revparse(["HEAD"]).catch(() => "")).trim();
      return {
        committed: false,
        sha: currentSha,
        message: err.message || "Commit failed",
      };
    }
  }

  async merge(
    feature: string,
    step: string,
    strategy: "merge" | "squash" | "rebase" = "merge",
    message?: string,
    options: MergeOptions = {},
  ): Promise<MergeResult> {
    const branchName = this.getBranchName(feature, step);
    const git = this.getGit();
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

    let filesChanged: string[] = [];

    try {
      const branches = await git.branch();
      if (!branches.all.includes(branchName)) {
        return {
          success: false,
          merged: false,
          strategy,
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
        const cleanup = cleanupMode === 'none'
          ? emptyCleanup
          : await this.remove(feature, step, cleanupMode === 'worktree+branch');
        return {
          success: true,
          merged: true,
          strategy,
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
        const cleanup = cleanupMode === 'none'
          ? emptyCleanup
          : await this.remove(feature, step, cleanupMode === 'worktree+branch');
        return {
          success: true,
          merged: true,
          strategy,
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
        const cleanup = cleanupMode === 'none'
          ? emptyCleanup
          : await this.remove(feature, step, cleanupMode === 'worktree+branch');
        return {
          success: true,
          merged: !result.failed,
          strategy,
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
          strategy,
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
        strategy,
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
