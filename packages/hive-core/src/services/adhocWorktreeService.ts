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
  /** Optional repository manifest resolver. Reserved for Task 2 (composite ad-hoc workspaces). */
  repositoryResolver?: RepositoryResolver | (() => ResolvedRepository[]);
}

export interface AdhocCreateOptions {
  /** Explicit run identifier. When omitted, a unique safe id is generated. */
  runId?: string;
  /** Optional slug label folded into the generated runId; ignored when runId is provided. */
  label?: string;
  /** Optional base ref/commit; defaults to current HEAD. */
  baseBranch?: string;
}

export interface AdhocWorktreeInfo {
  runId: string;
  path: string;
  branch: string;
  commit: string;
}

export interface AdhocCommitResult {
  committed: boolean;
  sha: string;
  message?: string;
}

export type AdhocMergeStrategy = 'merge' | 'squash' | 'rebase';

export interface AdhocMergeOptions {
  preserveConflicts?: boolean;
  cleanup?: 'none' | 'worktree' | 'worktree+branch';
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
}

export interface AdhocCleanupResult {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  pruned: boolean;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Single-root ad-hoc worktree service.
 *
 * Creates short-lived worktrees under `.hive/.worktrees/adhoc/<runId>` on
 * branches `hive/adhoc/<runId>` without touching `.hive/features` or any
 * task/status files. Intended for the builder agent workflow where the
 * isolation primitive is needed but the plan/task ceremony is not.
 *
 * Composite (multi-repo) ad-hoc workspaces are not implemented in this core
 * and will be added in Task 2; the `repositoryResolver` constructor option
 * is reserved for that follow-up.
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

  private getBranchName(runId: string): string {
    return `hive/adhoc/${runId}`;
  }

  private async isRegisteredWorktree(worktreePath: string, branchName: string): Promise<boolean> {
    try {
      const output = await this.getGit().raw(['worktree', 'list', '--porcelain']);
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

    const base = options.baseBranch || (await git.revparse(['HEAD'])).trim();

    try {
      await git.raw(['worktree', 'add', '-b', branchName, worktreePath, base]);
    } catch (createError) {
      throw new Error(`Failed to create ad-hoc worktree: ${createError}`);
    }

    const wtGit = this.getGit(worktreePath);
    const commit = (await wtGit.revparse(['HEAD'])).trim();

    return { runId, path: worktreePath, branch: branchName, commit };
  }

  async get(runId: string): Promise<AdhocWorktreeInfo | null> {
    this.assertSafeRunId(runId);
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
      };
    } catch {
      return null;
    }
  }

  async commit(runId: string, message: string): Promise<AdhocCommitResult> {
    this.assertSafeRunId(runId);
    const worktreePath = this.getWorktreePath(runId);

    try {
      await fs.access(worktreePath);
    } catch {
      return { committed: false, sha: '', message: 'Worktree not found' };
    }

    const git = this.getGit(worktreePath);
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
    strategy: AdhocMergeStrategy = 'merge',
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

    const branchName = this.getBranchName(runId);
    const git = this.getGit();
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

      const diffStat = await git.diff([`${currentBranch}...${branchName}`, '--stat']);
      filesChanged = diffStat
        .split('\n')
        .filter(l => l.trim() && l.includes('|'))
        .map(l => l.split('|')[0].trim());

      if (strategy === 'squash') {
        await git.raw(['merge', '--squash', branchName]);
        const squashMessage = message || `hive(adhoc/${runId}): merge (squashed)`;
        const result = await git.commit(squashMessage);
        const cleanup =
          cleanupMode === 'none'
            ? emptyCleanup
            : await this.cleanup(runId, cleanupMode === 'worktree+branch');
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
      } else if (strategy === 'rebase') {
        const commits = await git.log([`${currentBranch}..${branchName}`]);
        const commitsToApply = [...commits.all].reverse();
        for (const commit of commitsToApply) {
          await git.raw(['cherry-pick', commit.hash]);
        }
        const head = (await git.revparse(['HEAD'])).trim();
        const cleanup =
          cleanupMode === 'none'
            ? emptyCleanup
            : await this.cleanup(runId, cleanupMode === 'worktree+branch');
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
        const mergeMessage = message || `hive(adhoc/${runId}): merge`;
        const result = await git.merge([branchName, '--no-ff', '-m', mergeMessage]);
        const head = (await git.revparse(['HEAD'])).trim();
        const cleanup =
          cleanupMode === 'none'
            ? emptyCleanup
            : await this.cleanup(runId, cleanupMode === 'worktree+branch');
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
          strategy,
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
        strategy,
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
