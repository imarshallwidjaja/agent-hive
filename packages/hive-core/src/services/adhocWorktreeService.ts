import * as fs from 'fs/promises';
import * as path from 'path';
import simpleGit, { type SimpleGit } from 'simple-git';
import type { ResolvedRepository } from '../types.js';

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
  /** Optional slug label folded into the generated runId; ignored when runId is provided. */
  label?: string;
  /** Optional base ref/commit; defaults to current HEAD. */
  baseBranch?: string;
  /** Explicit repo IDs for composite ad-hoc workspaces. When omitted, single-root mode is used. */
  repoIds?: string[];
}

export interface AdhocWorktreeRepoInfo {
  path: string;
  branch: string;
  commit: string;
}

export type AdhocWorktreeMode = 'adhoc-single' | 'adhoc-composite';

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
}

export interface AdhocRepoCommitResult {
  committed: boolean;
  sha: string;
  message?: string;
}

export interface AdhocCommitResult {
  committed: boolean;
  sha: string;
  message?: string;
  /** Per-repo commit results when the workspace is a composite. Omitted for single-root. */
  repos?: Record<string, AdhocRepoCommitResult>;
  /** True when at least one repo committed and at least one repo failed. */
  partial?: boolean;
  /** First per-repo error encountered, if any. */
  error?: string;
}

export type AdhocMergeStrategy = 'merge' | 'squash' | 'rebase';

export interface AdhocMergeOptions {
  preserveConflicts?: boolean;
  cleanup?: 'none' | 'worktree' | 'worktree+branch';
}

export interface AdhocRepoMergeResult {
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

export interface AdhocMergeResult {
  success: boolean;
  merged: boolean;
  strategy: AdhocMergeStrategy;
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
  /** Per-repo merge results when the workspace is a composite. */
  repos?: Record<string, AdhocRepoMergeResult>;
  /** True when at least one repo merged successfully and a later repo failed. */
  partial?: boolean;
}

export interface AdhocCleanupResult {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  pruned: boolean;
}

interface AdhocCompositeManifestEntry {
  /** Workspace-relative path under the composite root (e.g., 'repos/api'). */
  path: string;
  /** Absolute path to the source repository git root. */
  repoRoot: string;
  /** Stable absolute source repo path as configured in the manifest. */
  repoPath: string;
  branch: string;
  commit: string;
}

interface AdhocCompositeManifest {
  schemaVersion: 1;
  mode: 'adhoc-composite';
  runId: string;
  repos: Record<string, AdhocCompositeManifestEntry>;
  baseCommits: Record<string, string>;
  createdAt: string;
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

  private async readCompositeManifest(runId: string): Promise<AdhocCompositeManifest | null> {
    try {
      const raw = await fs.readFile(this.getWorkspaceManifestPath(runId), 'utf-8');
      return JSON.parse(raw) as AdhocCompositeManifest;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return null;
      throw error;
    }
  }

  private async isRegisteredCompositeRepo(
    runId: string,
    entry: AdhocCompositeManifestEntry,
  ): Promise<boolean> {
    const repoRoot = entry.repoRoot || entry.repoPath;
    if (!repoRoot) return false;
    const repoWtPath = path.join(this.getCompositeRoot(runId), entry.path);
    return this.isRegisteredWorktree(repoWtPath, entry.branch, repoRoot);
  }

  private async validateCompositeManifest(manifest: AdhocCompositeManifest): Promise<boolean> {
    for (const entry of Object.values(manifest.repos)) {
      if (!(await this.isRegisteredCompositeRepo(manifest.runId, entry))) {
        return false;
      }
    }
    return true;
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
    };
  }

  private async refreshCompositeInfo(manifest: AdhocCompositeManifest): Promise<AdhocWorktreeInfo | null> {
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

  private slugify(label: string): string {
    return label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
  }

  private generateRunId(label?: string): string {
    const ts = new Date()
      .toISOString()
      .replace(/[-:.]/g, '')
      .replace('T', '-')
      .replace('Z', '');
    const rand = Math.random().toString(36).slice(2, 8);
    const slug = label ? this.slugify(label) : '';
    const id = slug ? `${ts}-${slug}-${rand}` : `${ts}-${rand}`;
    return id;
  }

  async create(options: AdhocCreateOptions = {}): Promise<AdhocWorktreeInfo> {
    const explicit = options.runId !== undefined;
    let runId: string;
    if (explicit) {
      runId = options.runId as string;
      this.assertSafeRunId(runId);
    } else {
      runId = this.generateRunId(options.label);
      // Defensive: generated ids must satisfy the same shape.
      this.assertSafeRunId(runId);
    }

    if (options.repoIds && options.repoIds.length > 0) {
      return this.createComposite(runId, options.repoIds, explicit, options.baseBranch);
    }

    return this.createSingle(runId, explicit, options.baseBranch);
  }

  private async createSingle(
    runId: string,
    explicit: boolean,
    baseBranch?: string,
  ): Promise<AdhocWorktreeInfo> {
    const worktreePath = this.getWorktreePath(runId);
    const branchName = this.getBranchName(runId);
    const git = this.getGit();

    const pathExists = await fs
      .access(worktreePath)
      .then(() => true)
      .catch(() => false);
    const branches = await git.branch().catch(() => null);
    const branchPresent = branches?.all.includes(branchName) ?? false;

    if (pathExists && branchPresent) {
      const existing = await this.get(runId);
      if (explicit && existing) return existing;
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

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });

    const base = baseBranch || (await git.revparse(['HEAD'])).trim();

    try {
      await git.raw(['worktree', 'add', '-b', branchName, worktreePath, base]);
    } catch (createError) {
      throw new Error(`Failed to create ad-hoc worktree: ${createError}`);
    }

    const wtGit = this.getGit(worktreePath);
    const commit = (await wtGit.revparse(['HEAD'])).trim();

    return { runId, path: worktreePath, branch: branchName, commit, mode: 'adhoc-single' };
  }

  private async createComposite(
    runId: string,
    repoIds: string[],
    explicit: boolean,
    baseBranch?: string,
  ): Promise<AdhocWorktreeInfo> {
    // Validate inputs
    for (const repoId of repoIds) this.assertSafeRepoId(repoId);
    const stableRepoIds = [...repoIds].sort();

    const resolved = this.resolveRepositories();
    if (!resolved) {
      throw new Error(
        'Composite ad-hoc workspace requested but no repositoryResolver is configured',
      );
    }
    const byId = new Map(resolved.map((r) => [r.id, r]));
    const missing = repoIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Repository manifest is missing required repos for ad-hoc run ${runId}: ${missing.join(', ')}`,
      );
    }

    const compositeRoot = this.getCompositeRoot(runId);

    // Preflight: workspace root must not already exist
    let rootExists = false;
    try {
      await fs.access(compositeRoot);
      rootExists = true;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code && err.code !== 'ENOENT') throw e;
    }
    if (rootExists) {
      const manifest = explicit ? await this.readCompositeManifest(runId) : null;
      const existing = manifest ? await this.refreshCompositeInfo(manifest) : null;
      if (existing) return existing;
      throw new Error(`Composite ad-hoc workspace already exists at ${compositeRoot}`);
    }

    // Preflight: no branch collisions in any target source repo
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
        const msg = (e as { message?: string }).message ?? '';
        if (msg.includes('Branch collision')) throw e;
        // ignore: unable to list branches
      }
    }

    await fs.mkdir(compositeRoot, { recursive: true });
    await fs.mkdir(path.join(compositeRoot, 'repos'), { recursive: true });

    const createdRepos: Array<{
      repoId: string;
      branchName: string;
      git: SimpleGit;
    }> = [];
    const repoInfos: Record<string, AdhocWorktreeRepoInfo> = {};
    const baseCommits: Record<string, string> = {};

    try {
      for (const repoId of stableRepoIds) {
        const repo = byId.get(repoId)!;
        const repoWtPath = this.getCompositeRepoPath(runId, repoId);
        const branchName = this.getCompositeBranchName(repoId, runId);
        const repoGit = this.getGit(repo.path);
        const base = baseBranch || (await repoGit.revparse(['HEAD'])).trim();

        await fs.mkdir(path.dirname(repoWtPath), { recursive: true });

        try {
          await repoGit.raw(['worktree', 'add', '-b', branchName, repoWtPath, base]);
        } catch (createError) {
          throw new Error(`Failed to create ad-hoc worktree for repo ${repoId}: ${createError}`);
        }
        createdRepos.push({ repoId, branchName, git: repoGit });

        const wtGit = this.getGit(repoWtPath);
        const commit = (await wtGit.revparse(['HEAD'])).trim();
        repoInfos[repoId] = { path: repoWtPath, branch: branchName, commit };
        baseCommits[repoId] = commit;
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
                branch: repoInfos[id].branch,
                commit: repoInfos[id].commit,
              },
            ];
          }),
        ),
        baseCommits,
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(
        this.getWorkspaceManifestPath(runId),
        JSON.stringify(manifest, null, 2),
        'utf-8',
      );

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
      // Rollback: remove created per-repo worktrees, prune, delete ad-hoc branches, remove workspace root
      for (const created of createdRepos) {
        const repoWtPath = this.getCompositeRepoPath(runId, created.repoId);
        try {
          await created.git.raw(['worktree', 'remove', repoWtPath, '--force']);
        } catch {
          await fs.rm(repoWtPath, { recursive: true, force: true }).catch(() => {});
        }
        try {
          await created.git.raw(['worktree', 'prune']);
        } catch {
          /* intentional */
        }
        try {
          await created.git.deleteLocalBranch(created.branchName, true);
        } catch {
          /* intentional */
        }
      }
      await fs.rm(compositeRoot, { recursive: true, force: true }).catch(() => {});
      throw createError;
    }
  }

  async get(runId: string): Promise<AdhocWorktreeInfo | null> {
    this.assertSafeRunId(runId);

    const manifest = await this.readCompositeManifest(runId);
    if (manifest) return this.refreshCompositeInfo(manifest);

    const worktreePath = this.getWorktreePath(runId);
    const branchName = this.getBranchName(runId);
    try {
      if (!(await this.isRegisteredWorktree(worktreePath, branchName))) return null;
      const git = this.getGit(worktreePath);
      const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      if (currentBranch !== branchName) return null;
      const commit = (await git.revparse(['HEAD'])).trim();
      return {
        runId,
        path: worktreePath,
        branch: branchName,
        commit,
        mode: 'adhoc-single',
      };
    } catch {
      return null;
    }
  }

  async commit(runId: string, message: string): Promise<AdhocCommitResult> {
    this.assertSafeRunId(runId);

    const manifest = await this.readCompositeManifest(runId);
    if (manifest) {
      return this.commitComposite(runId, manifest, message);
    }
    return this.commitSingle(runId, message);
  }

  private async commitSingle(runId: string, message: string): Promise<AdhocCommitResult> {
    const worktreePath = this.getWorktreePath(runId);

    try {
      await fs.access(worktreePath);
    } catch {
      return { committed: false, sha: '', message: 'Worktree not found' };
    }

    return this.commitOneRepo(worktreePath, message);
  }

  private async commitComposite(
    runId: string,
    manifest: AdhocCompositeManifest,
    message: string,
  ): Promise<AdhocCommitResult> {
    const compositeRoot = this.getCompositeRoot(runId);
    const repoIds = Object.keys(manifest.repos).sort();
    const repos: Record<string, AdhocRepoCommitResult> = {};
    let anyCommitted = false;
    let anyFailed = false;
    let firstError: string | undefined;

    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      if (!(await this.isRegisteredCompositeRepo(runId, entry))) {
        repos[repoId] = { committed: false, sha: '', message: 'Worktree not found' };
        anyFailed = true;
        if (!firstError) firstError = `${repoId}: Worktree not found`;
        continue;
      }
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
    const firstResult = repos[repoIds[0]];

    const result: AdhocCommitResult = {
      committed,
      sha: firstResult.sha,
      message: firstResult.message,
      repos,
    };
    if (partial) result.partial = true;
    if (firstError) result.error = firstError;
    return result;
  }

  private async commitOneRepo(repoWtPath: string, message: string): Promise<AdhocRepoCommitResult> {
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

      const result = await git.commit(message, ['--allow-empty-message']);
      return { committed: true, sha: result.commit, message };
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

  async merge(
    runId: string,
    strategy: AdhocMergeStrategy = 'squash',
    message?: string,
    options: AdhocMergeOptions = {},
  ): Promise<AdhocMergeResult> {
    this.assertSafeRunId(runId);

    const cleanupMode = options.cleanup ?? 'none';
    const preserveConflicts = options.preserveConflicts ?? false;

    const emptyCleanup = {
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
    };

    if (strategy === 'rebase' && message) {
      return {
        success: false,
        merged: false,
        strategy,
        filesChanged: [],
        conflicts: [],
        conflictState: 'none',
        cleanup: emptyCleanup,
        error: 'Custom merge message is not supported for rebase strategy',
      };
    }

    const manifest = await this.readCompositeManifest(runId);
    if (manifest) {
      return this.mergeComposite(runId, manifest, strategy, message, {
        cleanup: cleanupMode,
        preserveConflicts,
      });
    }

    return this.mergeSingle(runId, strategy, message, { cleanup: cleanupMode, preserveConflicts });
  }

  private async mergeSingle(
    runId: string,
    strategy: AdhocMergeStrategy,
    message: string | undefined,
    options: { cleanup: 'none' | 'worktree' | 'worktree+branch'; preserveConflicts: boolean },
  ): Promise<AdhocMergeResult> {
    const emptyCleanup = {
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
    };

    const branchName = this.getBranchName(runId);
    const git = this.getGit();
    const repoResult = await this.mergeOneRepo({
      git,
      branchName,
      strategy,
      message,
      defaultMessage: `hive(adhoc/${runId}): merge`,
      defaultSquashMessage: `hive(adhoc/${runId}): merge (squashed)`,
      preserveConflicts: options.preserveConflicts,
      cleanupMode: options.cleanup,
      cleanupFn: async (deleteBranch: boolean) => this.cleanup(runId, deleteBranch),
    });

    return {
      success: repoResult.success,
      merged: repoResult.merged,
      strategy,
      sha: repoResult.sha,
      filesChanged: repoResult.filesChanged,
      conflicts: repoResult.conflicts,
      conflictState: repoResult.conflictState,
      cleanup: repoResult.cleanup ?? emptyCleanup,
      ...(repoResult.error !== undefined ? { error: repoResult.error } : {}),
    };
  }

  private async mergeComposite(
    runId: string,
    manifest: AdhocCompositeManifest,
    strategy: AdhocMergeStrategy,
    message: string | undefined,
    options: { cleanup: 'none' | 'worktree' | 'worktree+branch'; preserveConflicts: boolean },
  ): Promise<AdhocMergeResult> {
    const repoIds = Object.keys(manifest.repos).sort();
    const emptyCleanup = {
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
    };

    const preflightFailure = (repoId: string, reason: string): AdhocMergeResult => ({
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

    // Preflight: every source repo must have the branch, be clean, and have no active merge state
    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      if (!(await this.isRegisteredCompositeRepo(runId, entry))) {
        return preflightFailure(repoId, 'registered worktree not found');
      }
      const repoRoot = entry.repoRoot || entry.repoPath;
      if (!repoRoot) {
        return preflightFailure(repoId, 'missing source repo root in workspace manifest');
      }
      const repoGit = this.getGit(repoRoot);

      try {
        const branches = await repoGit.branch();
        if (!branches.all.includes(entry.branch)) {
          return preflightFailure(repoId, `branch ${entry.branch} not found`);
        }
      } catch (e: unknown) {
        const msg = (e as { message?: string }).message ?? 'unable to list branches';
        return preflightFailure(repoId, msg);
      }

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
          /* not present -> ok */
        }
      }
    }

    // Execute per-repo merges in stable id order
    const repos: Record<string, AdhocRepoMergeResult> = {};
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
        defaultMessage: `hive(adhoc/${runId}/${repoId}): merge`,
        defaultSquashMessage: `hive(adhoc/${runId}/${repoId}): merge (squashed)`,
        preserveConflicts: options.preserveConflicts,
        cleanupMode: 'none',
        cleanupFn: async () => ({ worktreeRemoved: false, branchDeleted: false, pruned: false }),
      });
      repos[repoId] = repoResult;
      for (const f of repoResult.filesChanged) flattenedFiles.push(`${repoId}:${f}`);
      for (const c of repoResult.conflicts) flattenedConflicts.push(`${repoId}:${c}`);

      if (!repoResult.success || !repoResult.merged) {
        stoppedRepoId = repoId;
        firstError = `${repoId}: ${repoResult.error ?? (repoResult.success ? 'repo reported merged=false' : 'merge failed')}`;
        lastConflictState = repoResult.conflictState;
        break;
      }
      anySuccess = true;
    }

    if (stoppedRepoId !== undefined) {
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

    // All repos merged -> apply cleanup
    let cleanup = { worktreeRemoved: false, branchDeleted: false, pruned: false };
    if (options.cleanup !== 'none') {
      const deleteBranch = options.cleanup === 'worktree+branch';
      const perRepoCleanups: Array<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean }> = [];
      for (const repoId of repoIds) {
        const entry = manifest.repos[repoId];
        if (!(await this.isRegisteredCompositeRepo(runId, entry))) {
          perRepoCleanups.push({ worktreeRemoved: false, branchDeleted: false, pruned: false });
          continue;
        }
        const repoRoot = entry.repoRoot || entry.repoPath;
        const repoCleanup = await this.removeCompositeRepo(runId, entry, repoRoot, deleteBranch);
        repos[repoId].cleanup = repoCleanup;
        perRepoCleanups.push(repoCleanup);
      }
      const compositeRoot = this.getCompositeRoot(runId);
      let rootRemoved = true;
      try {
        await fs.rm(compositeRoot, { recursive: true, force: true });
      } catch {
        rootRemoved = false;
      }
      cleanup = {
        worktreeRemoved: rootRemoved && perRepoCleanups.every((c) => c.worktreeRemoved),
        branchDeleted:
          deleteBranch && perRepoCleanups.length > 0 && perRepoCleanups.every((c) => c.branchDeleted),
        pruned: perRepoCleanups.some((c) => c.pruned),
      };
    }

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
    runId: string,
    entry: AdhocCompositeManifestEntry,
    repoRoot: string | undefined,
    deleteBranch: boolean,
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean }> {
    const compositeRoot = this.getCompositeRoot(runId);
    const repoWtPath = path.join(compositeRoot, entry.path);
    const repoGit = repoRoot ? this.getGit(repoRoot) : null;

    let worktreeRemoved = false;
    let pruned = false;
    let branchDeleted = false;

    if (repoGit) {
      try {
        await repoGit.raw(['worktree', 'remove', repoWtPath, '--force']);
        worktreeRemoved = true;
      } catch {
        /* fall through */
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
    strategy: AdhocMergeStrategy;
    message: string | undefined;
    defaultMessage: string;
    defaultSquashMessage: string;
    preserveConflicts: boolean;
    cleanupMode: 'none' | 'worktree' | 'worktree+branch';
    cleanupFn: (deleteBranch: boolean) => Promise<{
      worktreeRemoved: boolean;
      branchDeleted: boolean;
      pruned: boolean;
    }>;
  }): Promise<AdhocRepoMergeResult> {
    const {
      git,
      branchName,
      strategy,
      message,
      defaultMessage,
      defaultSquashMessage,
      preserveConflicts,
      cleanupMode,
      cleanupFn,
    } = opts;
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

      const diffStat = await git.diff([`${currentBranch}...${branchName}`, '--stat']);
      filesChanged = diffStat
        .split('\n')
        .filter((l) => l.trim() && l.includes('|'))
        .map((l) => l.split('|')[0].trim());

      if (strategy === 'squash') {
        await git.raw(['merge', '--squash', branchName]);
        const squashMessage = message || defaultSquashMessage;
        const result = await git.commit(squashMessage);
        const cleanup =
          cleanupMode === 'none' ? emptyCleanup : await cleanupFn(cleanupMode === 'worktree+branch');
        return {
          success: true,
          merged: true,
          sha: result.commit,
          filesChanged,
          conflicts: [],
          conflictState: 'none',
          cleanup,
        };
      } else if (strategy === 'rebase') {
        const commits = await git.log([`${currentBranch}..${branchName}`]);
        const commitsToApply = [...commits.all].reverse();
        for (const commit of commitsToApply) {
          await git.raw(['cherry-pick', commit.hash]);
        }
        const head = (await git.revparse(['HEAD'])).trim();
        const cleanup =
          cleanupMode === 'none' ? emptyCleanup : await cleanupFn(cleanupMode === 'worktree+branch');
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
        const mergeMessage = message || defaultMessage;
        const result = await git.merge([branchName, '--no-ff', '-m', mergeMessage]);
        const head = (await git.revparse(['HEAD'])).trim();
        const cleanup =
          cleanupMode === 'none' ? emptyCleanup : await cleanupFn(cleanupMode === 'worktree+branch');
        return {
          success: true,
          merged: !result.failed,
          sha: head,
          filesChanged,
          conflicts: result.conflicts?.map((c) => c.file || String(c)) || [],
          conflictState: 'none',
          cleanup,
        };
      }
    } catch (error: unknown) {
      const err = error as { message?: string };

      if (err.message?.includes('CONFLICT') || err.message?.includes('conflict')) {
        const conflicts = await this.getActiveConflictFiles(git, err.message || '');
        const conflictState = preserveConflicts ? 'preserved' : 'aborted';

        if (!preserveConflicts) {
          await git.raw(['merge', '--abort']).catch(() => {});
          await git.raw(['rebase', '--abort']).catch(() => {});
          await git.raw(['cherry-pick', '--abort']).catch(() => {});
        }

        return {
          success: false,
          merged: false,
          filesChanged,
          conflicts,
          conflictState,
          cleanup: emptyCleanup,
          error: 'Merge conflicts detected',
        };
      }

      return {
        success: false,
        merged: false,
        filesChanged,
        conflicts: [],
        conflictState: 'none',
        cleanup: emptyCleanup,
        error: err.message || 'Merge failed',
      };
    }
  }

  async cleanup(runId: string, deleteBranch = false): Promise<AdhocCleanupResult> {
    this.assertSafeRunId(runId);

    const manifest = await this.readCompositeManifest(runId);
    if (manifest) {
      const repoIds = Object.keys(manifest.repos).sort();
      const perRepoCleanups: Array<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean }> = [];
      for (const repoId of repoIds) {
        const entry = manifest.repos[repoId];
        if (!(await this.isRegisteredCompositeRepo(runId, entry))) {
          perRepoCleanups.push({ worktreeRemoved: false, branchDeleted: false, pruned: false });
          continue;
        }
        const repoRoot = entry.repoRoot || entry.repoPath;
        const perRepo = await this.removeCompositeRepo(runId, entry, repoRoot, deleteBranch);
        perRepoCleanups.push(perRepo);
      }
      const compositeRoot = this.getCompositeRoot(runId);
      let rootRemoved = true;
      try {
        await fs.rm(compositeRoot, { recursive: true, force: true });
      } catch {
        rootRemoved = false;
      }
      return {
        worktreeRemoved: rootRemoved && perRepoCleanups.every((c) => c.worktreeRemoved),
        branchDeleted:
          deleteBranch && perRepoCleanups.length > 0 && perRepoCleanups.every((c) => c.branchDeleted),
        pruned: perRepoCleanups.some((c) => c.pruned),
      };
    }

    const worktreePath = this.getWorktreePath(runId);
    const branchName = this.getBranchName(runId);
    const git = this.getGit();
    let worktreeRemoved = false;
    let branchDeleted = false;
    let pruned = false;

    try {
      await git.raw(['worktree', 'remove', worktreePath, '--force']);
      worktreeRemoved = true;
    } catch {
      try {
        await fs.rm(worktreePath, { recursive: true, force: true });
        worktreeRemoved = true;
      } catch {
        worktreeRemoved = false;
      }
    }

    try {
      await git.raw(['worktree', 'prune']);
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

  private async getActiveConflictFiles(git: SimpleGit, errorMessage: string): Promise<string[]> {
    try {
      const status = await git.status();
      if (status.conflicted.length > 0) {
        return [...new Set(status.conflicted)];
      }
    } catch {
      /* intentional */
    }
    const conflicts: string[] = [];
    for (const line of errorMessage.split('\n')) {
      if (line.includes('CONFLICT') && line.includes('Merge conflict in')) {
        const m = line.match(/Merge conflict in (.+)/);
        if (m) conflicts.push(m[1]);
      }
    }
    return conflicts;
  }
}
