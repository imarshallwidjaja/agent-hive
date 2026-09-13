import * as fs from 'fs/promises';
import * as path from 'path';
import simpleGit, { type SimpleGit } from 'simple-git';
import type { ResolvedRepository } from '../types.js';
import { normalizeCommitMessage } from '../utils/mergeMessage.js';
import type {
  AdhocWorkspaceManifest as AdhocCompositeManifest,
  WorkspaceManifestEntry as AdhocCompositeManifestEntry,
} from './workspaceManifest.js';
import { readCompositeWorkspaceManifest } from './workspaceManifest.js';

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
  commitMessage?: string;
  reason?: string;
  reasonCode?: 'NO_TRACKED_CHANGES';
  cleanupEligible?: boolean;
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
  commitMessage?: string;
  reason?: string;
  reasonCode?: 'NO_TRACKED_CHANGES';
  cleanupEligible?: boolean;
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

  private isContained(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private async trustedGitCommonDirectory(repositoryPath: string): Promise<string> {
    const raw = (await this.getGit(repositoryPath).raw(['rev-parse', '--git-common-dir'])).trim();
    if (!raw) throw new Error(`Worktree linkage preflight failed: trusted repository has no Git common directory (${repositoryPath})`);
    return fs.realpath(path.isAbsolute(raw) ? raw : path.resolve(repositoryPath, raw));
  }

  private async assertNoSymlinkComponents(root: string, candidate: string, allowMissing = false): Promise<void> {
    const relative = path.relative(root, candidate);
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (allowMissing && error.code === 'ENOENT') return null;
        throw new Error(`Worktree linkage preflight failed: cannot inspect path component ${current}: ${error.message}`);
      });
      if (!stat) return;
      if (stat.isSymbolicLink()) {
        throw new Error(`Worktree linkage preflight failed: path contains a symlink (${current})`);
      }
    }
  }

  private async lstatOrNull(candidate: string) {
    return fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new Error(`Worktree linkage preflight failed: cannot inspect path ${candidate}: ${error.message}`);
    });
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
      throw new Error(`Worktree linkage preflight failed for repository ${repositoryId}: local .git must be a regular pointer file`);
    }
    const pointer = await fs.readFile(localGitPath, 'utf8');
    const match = pointer.match(/^gitdir:\s*(.+?)\s*$/);
    if (!match) throw new Error(`Worktree linkage preflight failed for repository ${repositoryId}: invalid local .git pointer`);
    const administrationPath = path.normalize(path.isAbsolute(match[1]!)
      ? match[1]!
      : path.resolve(worktreePath, match[1]!));
    const worktreesDirectory = path.join(commonDirectory, 'worktrees');
    if (!this.isContained(worktreesDirectory, administrationPath) || administrationPath === worktreesDirectory) {
      throw new Error(`Worktree linkage preflight failed for repository ${repositoryId}: administration entry is outside the trusted Git common directory`);
    }
    await this.assertNoSymlinkComponents(commonDirectory, administrationPath);
    await this.assertNoSymlinkComponents(administrationPath, path.join(administrationPath, 'commondir'));
    await this.assertNoSymlinkComponents(administrationPath, path.join(administrationPath, 'gitdir'));

    const commondirBytes = await fs.readFile(path.join(administrationPath, 'commondir'), 'utf8');
    const selectedCommonDirectory = path.normalize(path.resolve(administrationPath, commondirBytes.trim()));
    if (selectedCommonDirectory !== path.normalize(commonDirectory)) {
      throw new Error(`Worktree linkage preflight failed for repository ${repositoryId}: commondir does not match the trusted repository`);
    }
    const backlinkBytes = await fs.readFile(path.join(administrationPath, 'gitdir'), 'utf8');
    const backlink = path.normalize(path.isAbsolute(backlinkBytes.trim())
      ? backlinkBytes.trim()
      : path.resolve(administrationPath, backlinkBytes.trim()));
    if (backlink !== path.normalize(localGitPath)) {
      throw new Error(`Worktree linkage preflight failed for repository ${repositoryId}: administration backlink does not select this exact worktree`);
    }
  }

  private trustedRepositoriesForManifest(manifest: AdhocCompositeManifest): Map<string, ResolvedRepository> {
    const trustedRepositories = this.resolveRepositories();
    if (!trustedRepositories?.length) {
      throw new Error('Worktree linkage preflight failed: trusted repository topology is unavailable');
    }
    const trustedById = new Map(trustedRepositories.map((repository) => [repository.id, repository]));
    for (const [id, entry] of Object.entries(manifest.repos)) {
      const trusted = trustedById.get(id);
      if (!trusted
        || entry.repoRoot !== trusted.root
        || path.resolve(entry.repoPath) !== path.resolve(trusted.path)
        || entry.path !== path.posix.join('repos', id)) {
        throw new Error(`Worktree linkage preflight failed for repository ${id}: workspace topology does not match the trusted repository manifest`);
      }
    }
    return trustedById;
  }

  private async readCompositeManifest(runId: string): Promise<AdhocCompositeManifest | null> {
    const compositeRoot = this.getCompositeRoot(runId);
    await this.assertNoSymlinkComponents(path.parse(compositeRoot).root, path.join(compositeRoot, 'workspace.json'), true);
    const manifest = await readCompositeWorkspaceManifest(compositeRoot);
    if (manifest === null) return null;
    if (!('runId' in manifest) || manifest.runId !== runId) {
      throw new Error(
        `Worktree linkage preflight failed: workspace manifest run identity does not match the requested ad-hoc run (${runId})`,
      );
    }
    return manifest.mode === 'adhoc-composite' ? manifest : null;
  }

  private async inspectSingleWorktree(runId: string): Promise<{ path: string; exists: boolean }> {
    const worktreePath = this.getWorktreePath(runId);
    await this.assertNoSymlinkComponents(path.parse(worktreePath).root, worktreePath, true);
    const stat = await this.lstatOrNull(worktreePath);
    if (!stat) return { path: worktreePath, exists: false };
    await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'adhoc');
    return { path: worktreePath, exists: true };
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
    await this.assertNoSymlinkComponents(path.parse(worktreePath).root, worktreePath, true);

    const pathExists = await fs
      .access(worktreePath)
      .then(() => true)
      .catch(() => false);
    const branches = await git.branch().catch(() => null);
    const branchPresent = branches?.all.includes(branchName) ?? false;

    if (pathExists && branchPresent) {
      let existing: AdhocWorktreeInfo | null = null;
      try {
        existing = await this.get(runId);
      } catch {
        existing = null;
      }
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
    await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'adhoc');
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
    await this.assertNoSymlinkComponents(path.parse(compositeRoot).root, compositeRoot, true);

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

        await this.assertNoSymlinkComponents(path.parse(repoWtPath).root, repoWtPath, true);
        await fs.mkdir(path.dirname(repoWtPath), { recursive: true });

        try {
          await repoGit.raw(['worktree', 'add', '-b', branchName, repoWtPath, base]);
        } catch (createError) {
          throw new Error(`Failed to create ad-hoc worktree for repo ${repoId}: ${createError}`);
        }
        createdRepos.push({ repoId, branchName, git: repoGit });

        const wtGit = this.getGit(repoWtPath);
        await this.validateExactWorktreeRegistration(repoWtPath, repo.path, repoId);
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

    const branchName = this.getBranchName(runId);
    const { path: worktreePath, exists } = await this.inspectSingleWorktree(runId);
    if (!exists) return null;
    if (!(await this.isRegisteredWorktree(worktreePath, branchName, this.config.baseDir))) return null;
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
    const { path: worktreePath, exists } = await this.inspectSingleWorktree(runId);
    if (!exists) return { committed: false, sha: '', message: 'Worktree not found' };
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

    // Every selected repository is validated before any commit mutation so a
    // stale or copied workspace cannot partially commit an earlier repo.
    const { registered } = await this.preflightComposite(manifest);
    const preflightFailed = repoIds.some((repoId) => !registered[repoId]);
    if (preflightFailed) {
      const firstMissing = repoIds.find((repoId) => !registered[repoId]);
      if (firstMissing) firstError = `${firstMissing}: Worktree not found`;
    }

    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      const repoWtPath = path.join(compositeRoot, entry.path);
      let repoResult: AdhocRepoCommitResult;
      if (preflightFailed) {
        if (!registered[repoId]) {
          repoResult = { committed: false, sha: '', message: 'Worktree not found' };
        } else {
          const inspected = await this.inspectOneRepo(repoWtPath);
          repoResult = {
            committed: false,
            sha: inspected.sha,
            message: inspected.hasChanges
              ? 'Commit skipped: workspace preflight failed'
              : 'No changes to commit',
          };
        }
      } else {
        repoResult = await this.commitOneRepo(repoWtPath, message);
      }
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
    let startingHead: string | undefined;
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
        return { committed: false, sha: currentSha, message: 'No changes to commit' };
      }

      const commitMessage = normalizeCommitMessage(message);
      startingHead = (await git.revparse(['HEAD'])).trim();

      await git.add('-A');
      await git.commit(commitMessage);
      const head = (await git.revparse(['HEAD'])).trim();
      if (head === startingHead) throw new Error('Commit failed');
      const createdMessage = await this.readValidatedCommitMessage(git, head);
      return { committed: true, sha: head, message: createdMessage };
    } catch (error: unknown) {
      const err = error as { message?: string };
      let rollbackError: string | undefined;
      if (startingHead) {
        try {
          await git.raw(['reset', '--mixed', startingHead]);
        } catch (restoreError: unknown) {
          rollbackError = (restoreError as { message?: string }).message ?? 'reset failed';
        }
      }
      const currentSha = (await git.revparse(['HEAD']).catch(() => '')).trim();
      return {
        committed: false,
        sha: currentSha,
        message: rollbackError
          ? `${err.message || 'Commit failed'}; failed to restore worktree HEAD: ${rollbackError}`
          : err.message || 'Commit failed',
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

    if (strategy === 'rebase' && message?.trim()) {
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

    let registered: AdhocWorktreeInfo | null;
    try {
      registered = await this.get(runId);
    } catch (error) {
      return {
        success: false,
        merged: false,
        strategy,
        filesChanged: [],
        conflicts: [],
        conflictState: 'none',
        cleanup: emptyCleanup,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!registered) {
      return {
        success: false,
        merged: false,
        strategy,
        filesChanged: [],
        conflicts: [],
        conflictState: 'none',
        cleanup: emptyCleanup,
        error: 'Worktree linkage preflight failed: ad-hoc worktree is not registered',
      };
    }

    const git = this.getGit();
    const repoResult = await this.mergeOneRepo({
      git,
      branchName,
      strategy,
      message,
      preserveConflicts: options.preserveConflicts,
      cleanupMode: options.cleanup,
      cleanupFn: async (deleteBranch: boolean) => this.cleanup(runId, deleteBranch),
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
    const trustedById = this.trustedRepositoriesForManifest(manifest);
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

    // Preflight: every selected repository validates against the trusted current
    // topology before any source repo is mutated.
    for (const repoId of repoIds) {
      const entry = manifest.repos[repoId];
      const trusted = trustedById.get(repoId)!;
      if (!(await this.validateCompositeRepoRegistration(manifest, repoId, trusted.path))) {
        return preflightFailure(repoId, 'registered worktree not found');
      }
      const repoRoot = trusted.path;
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

      const currentBranch = (await repoGit.branch()).current;
      const targetHead = (await repoGit.revparse(['HEAD'])).trim();
      const changedFiles = (await repoGit.diff([targetHead, entry.branch, '--name-only'])).trim();
      if (changedFiles) {
        if (strategy !== 'squash') {
          const sourceError = await this.validateSourceCommitMessages(repoGit, currentBranch, entry.branch);
          if (sourceError) return preflightFailure(repoId, sourceError);
        }
      }
    }

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
        strategy,
        message,
        preserveConflicts: options.preserveConflicts,
        cleanupMode: 'none',
        cleanupFn: async () => ({ worktreeRemoved: false, branchDeleted: false, pruned: false }),
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
      const partial = anyActualMerge;
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

    // All repos merged -> apply cleanup (all repos passed preflight above)
    let cleanup = { worktreeRemoved: false, branchDeleted: false, pruned: false };
    if (options.cleanup !== 'none') {
      const deleteBranch = options.cleanup === 'worktree+branch';
      const perRepoCleanups: Array<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean }> = [];
      for (const repoId of repoIds) {
        const entry = manifest.repos[repoId];
        const repoCleanup = await this.removeCompositeRepo(
          runId,
          entry,
          trustedById.get(repoId)!.path,
          deleteBranch,
        );
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

    if (!anyActualMerge) {
      return {
        success: true,
        merged: false,
        strategy,
        reason: 'nothing_to_merge',
        reasonCode: 'NO_TRACKED_CHANGES',
        cleanupEligible: true,
        filesChanged: [],
        conflicts: [],
        conflictState: 'none',
        cleanup,
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
    runId: string,
    entry: AdhocCompositeManifestEntry,
    trustedRepositoryPath: string,
    deleteBranch: boolean,
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean }> {
    const compositeRoot = this.getCompositeRoot(runId);
    const repoWtPath = path.join(compositeRoot, entry.path);
    const repoGit = this.getGit(trustedRepositoryPath);

    let worktreeRemoved = false;
    let pruned = false;
    let branchDeleted = false;

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
    if (!worktreeRemoved) {
      try {
        await fs.rm(repoWtPath, { recursive: true, force: true });
        worktreeRemoved = true;
      } catch {
        worktreeRemoved = false;
      }
    }

    if (deleteBranch) {
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
    let startingHead: string | undefined;

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
          return {
            success: false,
            merged: false,
            filesChanged: [],
            conflicts: [],
            conflictState: 'none',
            cleanup: emptyCleanup,
            error: `active ${label} state in progress`,
          };
        } catch {
          /* not present -> ok */
        }
      }

      const targetStatus = await git.status();
      if (!targetStatus.isClean()) {
        return {
          success: false,
          merged: false,
          filesChanged: [],
          conflicts: [],
          conflictState: 'none',
          cleanup: emptyCleanup,
          error: 'Target repo has uncommitted (dirty) changes',
        };
      }
      startingHead = (await git.revparse(['HEAD'])).trim();

      const diffNames = await git.diff([startingHead, branchName, '--name-only']);
      filesChanged = diffNames
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      if (filesChanged.length === 0) {
        const cleanup =
          cleanupMode === 'none' ? emptyCleanup : await cleanupFn(cleanupMode === 'worktree+branch');
        return {
          success: true,
          merged: false,
          reason: 'nothing_to_merge',
          reasonCode: 'NO_TRACKED_CHANGES',
          cleanupEligible: true,
          filesChanged: [],
          conflicts: [],
          conflictState: 'none',
          cleanup,
        };
      }

      const commitMessage = strategy === 'rebase' ? undefined : normalizeCommitMessage(message);
      if (strategy !== 'squash') {
        const sourceError = await this.validateSourceCommitMessages(git, currentBranch, branchName);
        if (sourceError) throw new Error(sourceError);
      }

      if (strategy === 'squash') {
        await git.raw(['merge', '--squash', branchName]);
        await git.commit(commitMessage!);
        const head = (await git.revparse(['HEAD'])).trim();
        if (head === startingHead) throw new Error('Failed to create squash commit');
        const createdCommitMessage = await this.readValidatedCommitMessage(git, head);
        const cleanup =
          cleanupMode === 'none' ? emptyCleanup : await cleanupFn(cleanupMode === 'worktree+branch');
        return {
          success: true,
          merged: true,
          sha: head,
          commitMessage: createdCommitMessage,
          filesChanged,
          conflicts: [],
          conflictState: 'none',
          cleanup,
        };
      } else if (strategy === 'rebase') {
        const sourceHashesOutput = (await git.raw(['rev-list', '--reverse', `${currentBranch}..${branchName}`])).trim();
        const sourceHashes = sourceHashesOutput ? sourceHashesOutput.split('\n').filter(Boolean) : [];
        for (const hash of sourceHashes) {
          await git.raw(['cherry-pick', hash]);
          const cherryPickedHead = (await git.revparse(['HEAD'])).trim();
          await this.readValidatedCommitMessage(git, cherryPickedHead);
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
        const result = await git.merge([branchName, '--no-ff', '-m', commitMessage!]);
        const head = (await git.revparse(['HEAD'])).trim();
        if (result.failed || head === startingHead) throw new Error('Failed to create merge commit');
        const createdCommitMessage = await this.readValidatedCommitMessage(git, head);
        const cleanup =
          cleanupMode === 'none' ? emptyCleanup : await cleanupFn(cleanupMode === 'worktree+branch');
        return {
          success: true,
          merged: true,
          sha: head,
          commitMessage: createdCommitMessage,
          filesChanged,
          conflicts: result.conflicts?.map((c) => c.file || String(c)) || [],
          conflictState: 'none',
          cleanup,
        };
      }
    } catch (error: unknown) {
      const err = error as { message?: string };
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

      if (isConflict) {
        return {
          success: false,
          merged: false,
          filesChanged,
          conflicts,
          conflictState: preserveConflictState ? 'preserved' : 'aborted',
          cleanup: emptyCleanup,
          error: rollbackError ? `Merge conflicts detected; failed to restore target: ${rollbackError}` : 'Merge conflicts detected',
        };
      }

      return {
        success: false,
        merged: false,
        filesChanged,
        conflicts: [],
        conflictState: 'none',
        cleanup: emptyCleanup,
        error: rollbackError
          ? `${err.message || 'Merge failed'}; failed to restore target: ${rollbackError}`
          : err.message || 'Merge failed',
      };
    }
  }

  private async cleanupComposite(
    manifest: AdhocCompositeManifest,
    deleteBranch: boolean,
  ): Promise<AdhocCleanupResult> {
    const { trustedById, registered } = await this.preflightComposite(manifest);
    const repoIds = Object.keys(manifest.repos).sort();
    if (repoIds.some((repoId) => !registered[repoId])) {
      return { worktreeRemoved: false, branchDeleted: false, pruned: false };
    }

    const perRepoCleanups: AdhocCleanupResult[] = [];
    for (const repoId of repoIds) {
      const perRepo = await this.removeCompositeRepo(
        manifest.runId,
        manifest.repos[repoId],
        trustedById.get(repoId)!.path,
        deleteBranch,
      );
      perRepoCleanups.push(perRepo);
    }
    const compositeRoot = this.getCompositeRoot(manifest.runId);
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

  async cleanup(runId: string, deleteBranch = false): Promise<AdhocCleanupResult> {
    this.assertSafeRunId(runId);

    const manifest = await this.readCompositeManifest(runId);
    if (manifest) {
      return this.cleanupComposite(manifest, deleteBranch);
    }

    const worktreePath = this.getWorktreePath(runId);
    const branchName = this.getBranchName(runId);
    await this.assertNoSymlinkComponents(path.parse(worktreePath).root, worktreePath, true);
    const stat = await this.lstatOrNull(worktreePath);
    if (stat) {
      await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'adhoc');
    }
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

  private async getActiveConflictFiles(git: SimpleGit): Promise<string[]> {
    try {
      const output = (await git.raw(['diff', '--name-only', '--diff-filter=U'])).trim();
      return output ? [...new Set(output.split('\n').filter(Boolean))] : [];
    } catch {
      return [];
    }
  }
}
