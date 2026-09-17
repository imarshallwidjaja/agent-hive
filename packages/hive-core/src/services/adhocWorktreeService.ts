import * as fs from 'fs/promises';
import * as path from 'path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { createHash } from 'crypto';
import type { ResolvedRepository } from '../types.js';
import { acquireLock } from '../utils/paths.js';
import { normalizeCommitMessage } from '../utils/mergeMessage.js';
import type {
  AdhocWorkspaceManifest as AdhocCompositeManifest,
  SingleWorkspaceMetadata,
} from './workspaceManifest.js';
import { readCompositeWorkspaceManifest, readSingleWorkspaceMetadata, writeWorkspaceJsonAtomic } from './workspaceManifest.js';
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
  /** Explicit repo IDs for composite ad-hoc workspaces. When omitted, single-root mode is used. */
  repoIds?: string[];
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
  baseCommit?: string;
  clean?: boolean;
}

export type AdhocMergeStrategy = 'merge' | 'squash' | 'rebase';

export interface AdhocMergeOptions {
  preserveConflicts?: boolean;
  cleanup?: 'none' | 'worktree' | 'worktree+branch';
  /** Exact source commits to integrate. A moved source is rejected before mutation. */
  sourceCommit?: string;
  sourceCommits?: Record<string, string>;
}

export interface AdhocCleanupOptions {
  /** Explicitly discard an unintegrated branch. Never implied by normal cleanup. */
  discard?: boolean;
}

/** Merge-result cleanup block: per-step truth plus the legacy factual booleans. */
export interface AdhocMergeCleanupBlock extends WorktreeCleanupOutcome {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  pruned: boolean;
}

export interface AdhocRepoMergeResult {
  success: boolean;
  merged: boolean;
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
  phase: WorktreeOperationPhase;
  mutation: WorktreeMutationState;
  retryable: boolean;
  action: WorktreeRecoveryAction;
  operationStatus?: 'success' | 'failed' | 'not_attempted';
}

export interface AdhocMergeResult {
  success: boolean;
  merged: boolean;
  strategy: AdhocMergeStrategy;
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
    worktreeRemoved: cleanupStepDone(outcome.worktreeRemoval),
    branchDeleted: outcome.requested === 'worktree+branch' && cleanupStepDone(outcome.branchDeletion),
    pruned: outcome.prune.status === 'succeeded',
    cleanup: outcome,
    phase: classification.phase,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    mutation: classification.mutation,
    retryable: classification.retryable,
    action: classification.action,
  };
}

function noCleanupResult(): AdhocCleanupResult {
  return cleanupResultFromOutcome(noCleanupRequested());
}

function toMergeCleanupBlock(outcome: WorktreeCleanupOutcome): AdhocMergeCleanupBlock {
  return {
    ...outcome,
    worktreeRemoved: cleanupStepDone(outcome.worktreeRemoval),
    branchDeleted: outcome.requested === 'worktree+branch' && cleanupStepDone(outcome.branchDeletion),
    pruned: outcome.prune.status === 'succeeded',
  };
}

function mergeFailure(
  strategy: AdhocMergeStrategy,
  reasonCode: WorktreeReasonCode,
  error: string,
  options: {
    mutation?: WorktreeMutationState;
    conflicts?: string[];
    conflictState?: 'none' | 'aborted' | 'preserved';
    filesChanged?: string[];
    repos?: Record<string, AdhocRepoMergeResult>;
    partial?: boolean;
  } = {},
): AdhocMergeResult {
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

function mergeRepoFailure(
  reasonCode: WorktreeReasonCode,
  error: string,
  options: {
    mutation?: WorktreeMutationState;
    conflicts?: string[];
    conflictState?: 'none' | 'aborted' | 'preserved';
  } = {},
): AdhocRepoMergeResult {
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

/** A merge that moved the target but whose requested cleanup did not finish. */
function mergeSuccessClassification(
  requested: 'none' | 'worktree' | 'worktree+branch',
  cleanup: WorktreeCleanupOutcome,
  mutation: WorktreeMutationState,
): Pick<AdhocRepoMergeResult, 'phase' | 'reasonCode' | 'mutation' | 'retryable' | 'action'> {
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

  private trustedRepositoriesForManifest(manifest: AdhocCompositeManifest): Map<string, ResolvedRepository> {
    const trustedRepositories = this.resolveRepositories();
    if (!trustedRepositories?.length) {
      throw new WorktreeLinkageError('Worktree linkage preflight failed: trusted repository topology is unavailable');
    }
    const trustedById = new Map(trustedRepositories.map((repository) => [repository.id, repository]));
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

  private async readCompositeManifest(runId: string): Promise<AdhocCompositeManifest | null> {
    const compositeRoot = this.getCompositeRoot(runId);
    await this.assertNoSymlinkComponents(path.parse(compositeRoot).root, path.join(compositeRoot, 'workspace.json'), true);
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

    if (explicit && options.repoIds?.length) {
      await this.readCompositeManifest(runId);
    }

    const resolved = options.repoIds?.length ? this.resolveRepositories() : undefined;
    const missing = options.repoIds?.filter((repoId) => !resolved?.some((repository) => repository.id === repoId)) ?? [];
    if (missing.length > 0) {
      throw new Error(`Repository manifest is missing required repos for ad-hoc run ${runId}: ${missing.join(', ')}`);
    }
    const repositories = options.repoIds?.length
      ? options.repoIds.map((repoId) => resolved?.find((repository) => repository.id === repoId)?.path ?? this.config.baseDir)
      : [this.config.baseDir];
    return this.withRepositoryLocks(repositories, () => options.repoIds?.length
      ? this.createComposite(runId, options.repoIds, explicit)
      : this.createSingle(runId, explicit));
  }

  private async createSingle(
    runId: string,
    explicit: boolean,
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

    const base = (await git.revparse(['HEAD'])).trim();

    try {
      await git.raw(['worktree', 'add', '-b', branchName, '--', worktreePath, base]);
    } catch (createError) {
      throw new Error(`Failed to create ad-hoc worktree: ${(createError as Error).message}`, { cause: createError });
    }

    const wtGit = this.getGit(worktreePath);
    await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'adhoc');
    const commit = (await wtGit.revparse(['HEAD'])).trim();
    const metadata: SingleWorkspaceMetadata = {
      schemaVersion: 1,
      mode: 'adhoc-single',
      runId,
      worktreePath,
      repositoryPath: this.config.baseDir,
      branch: branchName,
      baseCommit: commit,
    };
    try {
      await writeWorkspaceJsonAtomic(this.getSingleMetadataPath(runId), metadata);
    } catch (error) {
      const removed = await git.raw(['worktree', 'remove', worktreePath]).then(() => true).catch(() => false);
      if (removed) {
        await git.raw(['worktree', 'prune']).catch(() => {});
        await this.deleteBranchStep(git, branchName, commit);
      }
      throw error;
    }

    return { runId, path: worktreePath, branch: branchName, commit, baseCommit: commit, mode: 'adhoc-single' };
  }

  private async createComposite(
    runId: string,
    repoIds: string[],
    explicit: boolean,
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
        if ((e as Error).message.startsWith('Branch collision:')) throw e;
        throw new Error(`Failed to inspect branch ${branchName} in repo ${repoId}: ${(e as Error).message}`, { cause: e });
      }
    }

    await fs.mkdir(compositeRoot, { recursive: true });
    await fs.mkdir(path.join(compositeRoot, 'repos'), { recursive: true });

    const createdRepos: Array<{
      repoId: string;
      branchName: string;
      git: SimpleGit;
      commit: string;
    }> = [];
    const repoInfos: Record<string, AdhocWorktreeRepoInfo> = {};
    const baseCommits: Record<string, string> = {};

    try {
      for (const repoId of stableRepoIds) {
        const repo = byId.get(repoId)!;
        const repoWtPath = this.getCompositeRepoPath(runId, repoId);
        const branchName = this.getCompositeBranchName(repoId, runId);
        const repoGit = this.getGit(repo.path);
        const base = (await repoGit.revparse(['HEAD'])).trim();

        await this.assertNoSymlinkComponents(path.parse(repoWtPath).root, repoWtPath, true);
        await fs.mkdir(path.dirname(repoWtPath), { recursive: true });

        try {
          await repoGit.raw(['worktree', 'add', '-b', branchName, '--', repoWtPath, base]);
        } catch (createError) {
          throw new Error(`Failed to create ad-hoc worktree for repo ${repoId}: ${createError}`);
        }
        createdRepos.push({ repoId, branchName, git: repoGit, commit: base });
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
      };
      await writeWorkspaceJsonAtomic(this.getWorkspaceManifestPath(runId), manifest);

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
        const removed = await created.git.raw(['worktree', 'remove', repoWtPath]).then(() => true).catch(() => false);
        try {
          await created.git.raw(['worktree', 'prune']);
        } catch {
          /* intentional */
        }
        if (removed) await this.deleteBranchStep(created.git, created.branchName, created.commit);
      }
      await this.removeEmptyWorkspaceRoot(compositeRoot);
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
    const metadata = await readSingleWorkspaceMetadata(this.getSingleMetadataPath(runId));
    if (metadata && (
      metadata.mode !== 'adhoc-single'
      || metadata.runId !== runId
      || path.resolve(metadata.worktreePath) !== path.resolve(worktreePath)
      || path.resolve(metadata.repositoryPath) !== path.resolve(this.config.baseDir)
      || metadata.branch !== branchName
    )) {
      throw new WorktreeLinkageError('Worktree linkage preflight failed: single workspace metadata does not match the requested ad-hoc worktree');
    }
    return {
      runId,
      path: worktreePath,
      branch: branchName,
      commit,
      ...(metadata ? { baseCommit: metadata.baseCommit } : {}),
      mode: 'adhoc-single',
    };
  }

  /** Inspect registration, branch, HEAD, and tracked/untracked/ignored dirt. */
  async inspect(runId: string): Promise<AdhocWorktreeInfo | null> {
    const manifest = await this.readCompositeManifest(runId);
    const repositories = manifest
      ? [...this.trustedRepositoriesForManifest(manifest).values()].map((repository) => repository.path)
      : [this.config.baseDir];
    return this.withRepositoryLocks(repositories, async () => {
      const info = await this.get(runId);
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

  async merge(
    runId: string,
    strategy: AdhocMergeStrategy = 'squash',
    message?: string,
    options: AdhocMergeOptions = {},
  ): Promise<AdhocMergeResult> {
    const manifest = await this.readCompositeManifest(runId);
    const repositories = manifest
      ? [...this.trustedRepositoriesForManifest(manifest).values()].map((repository) => repository.path)
      : [this.config.baseDir];
    return this.withRepositoryLocks(repositories, () => this.mergeUnlocked(runId, strategy, message, options));
  }

  private async mergeUnlocked(
    runId: string,
    strategy: AdhocMergeStrategy,
    message: string | undefined,
    options: AdhocMergeOptions,
  ): Promise<AdhocMergeResult> {
    this.assertSafeRunId(runId);

    const cleanupMode = options.cleanup ?? 'none';
    const preserveConflicts = options.preserveConflicts ?? false;

    if (strategy === 'rebase' && message?.trim()) {
      return mergeFailure(strategy, 'MESSAGE_NOT_ALLOWED_FOR_REBASE', 'Custom merge message is not supported for rebase strategy');
    }

    const manifest = await this.readCompositeManifest(runId);
    if (manifest) {
      return this.mergeComposite(runId, manifest, strategy, message, {
        cleanup: cleanupMode,
        preserveConflicts,
        sourceCommits: options.sourceCommits,
      });
    }

    return this.mergeSingle(runId, strategy, message, {
      cleanup: cleanupMode,
      preserveConflicts,
      sourceCommit: options.sourceCommit,
    });
  }

  private async mergeSingle(
    runId: string,
    strategy: AdhocMergeStrategy,
    message: string | undefined,
    options: {
      cleanup: 'none' | 'worktree' | 'worktree+branch';
      preserveConflicts: boolean;
      sourceCommit?: string;
    },
  ): Promise<AdhocMergeResult> {
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

    const git = this.getGit();
    const repoResult = await this.mergeOneRepo({
      git,
      branchName,
      strategy,
      message,
      preserveConflicts: options.preserveConflicts,
      cleanupMode: options.cleanup,
      sourceCommit: options.sourceCommit ?? registered.commit,
      sourceWorktreePath: registered.path,
      cleanupFn: async (deleteBranch: boolean) => this.cleanupSingle(runId, deleteBranch, {}, options.sourceCommit ?? registered.commit),
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
      cleanup: repoResult.cleanup,
      ...(repoResult.error !== undefined ? { error: repoResult.error } : {}),
      phase: repoResult.phase,
      mutation: repoResult.mutation,
      retryable: repoResult.retryable,
      action: repoResult.action,
    };
  }

  private async mergeComposite(
    runId: string,
    manifest: AdhocCompositeManifest,
    strategy: AdhocMergeStrategy,
    message: string | undefined,
    options: {
      cleanup: 'none' | 'worktree' | 'worktree+branch';
      preserveConflicts: boolean;
      sourceCommits?: Record<string, string>;
    },
  ): Promise<AdhocMergeResult> {
    const repoIds = Object.keys(manifest.repos).sort();
    const trustedById = this.trustedRepositoriesForManifest(manifest);
    const pinnedSourceCommits: Record<string, string> = {};
    const expectedTargetCommits: Record<string, string> = {};

    const preflightFailure = (repoId: string, reason: string, reasonCode: WorktreeReasonCode): AdhocMergeResult =>
      mergeFailure(strategy, reasonCode, `${repoId}: ${reason}`, { partial: false });

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
          /* not present -> ok */
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
        sourceCommit: pinnedSourceCommits[repoId],
        sourceWorktreePath: path.join(this.getCompositeRoot(runId), entry.path),
        cleanupFn: async () => noCleanupResult(),
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
          ...mergeRepoFailure('GIT_OPERATION_FAILED', `Not attempted after repository ${stoppedRepoId} failed`),
          operationStatus: 'not_attempted',
        };
      }
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

    // All repos merged -> apply cleanup (all repos passed preflight above)
    let cleanup = noCleanupRequested();
    if (options.cleanup !== 'none') {
      const deleteBranch = options.cleanup === 'worktree+branch';
      const perRepo: Array<{ repoId: string; cleanup: AdhocCleanupResult }> = [];
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
          ? cleanupResultFromOutcome(buildCleanupOutcome(options.cleanup, {
            worktreeRemoval: { status: 'not_attempted' },
            branchDeletion: deleteBranch ? { status: 'not_attempted' } : { status: 'not_requested' },
            prune: { status: 'not_attempted' },
            failures: [{ step: 'identity-recheck', repoId: identityFailure.repoId, cause: identityFailure.cause }],
          }), 'CLEANUP_FAILED')
          : await this.removeCompositeRepo(
            runId,
            repoId,
            trustedById.get(repoId)!.path,
            deleteBranch,
            {},
            pinnedSourceCommits[repoId],
          );
        repos[repoId].cleanup = toMergeCleanupBlock(repoCleanup.cleanup);
        perRepo.push({ repoId, cleanup: repoCleanup });
      }
      const compositeRoot = this.getCompositeRoot(runId);
      let rootFailure: { cause: string } | undefined;
      if (!identityFailure && perRepo.every(({ cleanup }) => cleanup.cleanup.outcome === 'complete')) {
        try {
          await this.removeEmptyWorkspaceRoot(compositeRoot);
        } catch (error: unknown) {
          const err = error as { message?: string };
          rootFailure = { cause: err.message || 'composite root removal failed' };
        }
      }
      cleanup = combineRepoCleanupOutcomes(
        options.cleanup,
        perRepo.map((entry) => ({ repoId: entry.repoId, cleanup: entry.cleanup.cleanup })),
        rootFailure,
      );
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
    const outcome = buildCleanupOutcome(deleteBranch ? 'worktree+branch' : 'worktree', {
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
  private async prepareBranchDeletion(git: SimpleGit, branchName: string, discard: boolean): Promise<string | undefined> {
    const ref = `refs/heads/${branchName}`;
    try {
      const expected = (await git.revparse([ref])).trim();
      if (!discard) {
        const currentBranch = (await git.branch()).current;
        if (!currentBranch) throw new Error(`Refusing to delete branch ${branchName}: target branch could not be determined`);
        const unmergedCount = Number((await git.raw(['rev-list', '--count', `${currentBranch}..${expected}`])).trim());
        if (unmergedCount > 0) throw new Error(`Refusing to delete branch ${branchName}: ${unmergedCount} unmerged commits would be discarded`);
      }
      return expected;
    } catch (error: unknown) {
      const message = (error as Error).message;
      if (/unknown revision|ambiguous argument|Needed a single revision/.test(message)) return undefined;
      throw error;
    }
  }

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

  private async mergeOneRepo(opts: {
    git: SimpleGit;
    branchName: string;
    strategy: AdhocMergeStrategy;
    message: string | undefined;
    preserveConflicts: boolean;
    cleanupMode: 'none' | 'worktree' | 'worktree+branch';
    sourceCommit: string;
    sourceWorktreePath: string;
    cleanupFn: (deleteBranch: boolean) => Promise<AdhocCleanupResult>;
  }): Promise<AdhocRepoMergeResult> {
    const {
      git,
      branchName,
      strategy,
      message,
      preserveConflicts,
      cleanupMode,
      cleanupFn,
      sourceCommit,
      sourceWorktreePath,
    } = opts;

    let startingHead: string | undefined;
    // Set immediately before a requested cleanup call in each success path to
    // the mutation that path reports. Once set, the target state is final: a
    // cleanup throw is classified as a cleanup failure over that state and must
    // not be rolled back.
    let cleanupFailureMutation: WorktreeMutationState | undefined;
    let verificationFailure = false;
    const cleanupWithIdentityRecheck = async (expectedTarget: string): Promise<WorktreeCleanupOutcome> => {
      if (cleanupMode === 'none') return noCleanupRequested();
      let identityMatches = false;
      try {
        const currentTarget = (await git.revparse(['HEAD'])).trim();
        const currentSource = (await git.revparse([branchName])).trim();
        identityMatches = currentTarget === expectedTarget && currentSource === sourceCommit;
      } catch {}
      if (identityMatches) return (await cleanupFn(cleanupMode === 'worktree+branch')).cleanup;
      return buildCleanupOutcome(cleanupMode, {
        worktreeRemoval: { status: 'not_attempted' },
        branchDeletion: { status: 'not_attempted' },
        prune: { status: 'not_attempted' },
        failures: [{ step: 'identity-recheck', cause: 'Source or target moved or could not be read after integration; cleanup was skipped' }],
      });
    };

    try {
      const branches = await git.branch();
      if (!branches.all.includes(branchName)) {
        return mergeRepoFailure('SOURCE_BRANCH_MISSING', `Branch ${branchName} not found`);
      }

      const currentBranch = branches.current;
      const actualSourceCommit = (await git.revparse([branchName])).trim();
      if (actualSourceCommit !== sourceCommit) {
        return mergeRepoFailure('GIT_OPERATION_FAILED', `Source ${branchName} moved from pinned commit ${sourceCommit} to ${actualSourceCommit}`);
      }
      if (!(await this.isGitClean(this.getGit(sourceWorktreePath)))) {
        return mergeRepoFailure('TARGET_DIRTY', `Source worktree ${sourceWorktreePath} has tracked or untracked changes`);
      }

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
          /* not present -> ok */
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
      const candidateFiles = (await git.diff([startingHead, sourceCommit, '--name-only']))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      if (candidateFiles.length === 0) {
        cleanupFailureMutation = 'none';
        const cleanup = await cleanupWithIdentityRecheck(startingHead);
        return {
          success: true,
          merged: false,
          reason: 'nothing_to_merge',
          reasonCode: 'NO_TRACKED_CHANGES',
          cleanupEligible: true,
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
        const sourceError = await this.validateSourceCommitMessages(git, currentBranch, sourceCommit);
        if (sourceError) return mergeRepoFailure('INVALID_COMMIT_MESSAGE', sourceError);
      }

      let finalHead: string;
      let conflicts: string[] = [];
      let createdCommitMessage: string | undefined;
      if (strategy === 'squash') {
        await git.raw(['merge', '--squash', sourceCommit]);
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
        const sourceHashesOutput = (await git.raw(['rev-list', '--reverse', `${currentBranch}..${sourceCommit}`])).trim();
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
        const result = await git.merge([sourceCommit, '--no-ff', '-m', commitMessage!]);
        finalHead = (await git.revparse(['HEAD'])).trim();
        if (result.failed || finalHead === startingHead) throw new Error('Failed to create merge commit');
        try {
          createdCommitMessage = await this.readValidatedCommitMessage(git, finalHead);
        } catch (verificationError: unknown) {
          verificationFailure = true;
          throw verificationError;
        }
        conflicts = result.conflicts?.map((c) => c.file || String(c)) || [];
      }

      // Integration must move HEAD. A rebase with no applicable source commits
      // leaves the target at its starting commit and is a successful no-op.
      // Preflight already required a clean target, so it is still clean here.
      if (finalHead === startingHead) {
        cleanupFailureMutation = 'none';
        const cleanup = await cleanupWithIdentityRecheck(startingHead);
        return {
          success: true,
          merged: false,
          reason: 'nothing_to_merge',
          reasonCode: 'NO_TRACKED_CHANGES',
          cleanupEligible: true,
          filesChanged: [],
          conflicts: [],
          conflictState: 'none',
          cleanup: toMergeCleanupBlock(cleanup),
          ...mergeSuccessClassification(cleanupMode, cleanup, 'none'),
        };
      }

      const observedFiles = await this.observedDeltaFiles(git, startingHead, finalHead);
      cleanupFailureMutation = 'applied';
      const cleanup = await cleanupWithIdentityRecheck(finalHead);
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

      if (!preserveConflictState && startingHead && isConflict) {
        if (strategy === 'merge') {
          await git.raw(['merge', '--abort']).catch(() => {});
        } else if (strategy === 'rebase') {
          await git.raw(['cherry-pick', '--abort']).catch(() => {});
        }
        await git.raw(['reset', '--merge', startingHead]).catch((error: unknown) => {
          rollbackError = (error as { message?: string }).message ?? 'reset --merge failed';
        });
        const restoredHead = (await git.revparse(['HEAD']).catch(() => '')).trim();
        if (restoredHead !== startingHead) rollbackError = 'Git abort did not restore the original target HEAD';
      } else if (!preserveConflictState && startingHead) {
        await git.raw(['reset', '--merge', startingHead]).catch((error: unknown) => {
          rollbackError = (error as { message?: string }).message ?? 'reset --merge failed';
        });
      }

      if (!preserveConflictState && startingHead && !rollbackError) {
        const repoRoot = (await git.raw(['rev-parse', '--show-toplevel']).catch(() => '')).trim();
        const activeStates: string[] = [];
        for (const name of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply']) {
          const statePath = await this.resolveGitPath(git, repoRoot, name);
          if (await fs.access(statePath).then(() => true).catch(() => false)) activeStates.push(name);
        }
        const remainingConflicts = await this.getActiveConflictFiles(git);
        if (activeStates.length > 0 || remainingConflicts.length > 0) {
          rollbackError = `Git operation remains active after abort/reset${activeStates.length > 0 ? `: ${activeStates.join(', ')}` : ''}`;
        }
      }

      if (rollbackError) {
        return mergeRepoFailure(
          'ROLLBACK_FAILED',
          `${err.message || 'Merge failed'}; failed to restore target: ${rollbackError}`,
          { mutation: 'unknown', conflicts: isConflict ? conflicts : [], conflictState: preserveConflictState ? 'preserved' : 'none' },
        );
      }

      if (isConflict) {
        return mergeRepoFailure(
          preserveConflictState ? 'MERGE_CONFLICT_PRESERVED' : 'MERGE_CONFLICT_ABORTED',
          'Merge conflicts detected',
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
        return mergeRepoFailure('POST_INTEGRATION_VERIFICATION_FAILED', err.message || 'Merge failed', {
          mutation: 'unknown',
        });
      }

      return mergeRepoFailure('GIT_OPERATION_FAILED', err.message || 'Merge failed');
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

  private async cleanupComposite(
    manifest: AdhocCompositeManifest,
    deleteBranch: boolean,
    options: AdhocCleanupOptions = {},
  ): Promise<AdhocCleanupResult> {
    const trustedById = this.trustedRepositoriesForManifest(manifest);
    const repoIds = Object.keys(manifest.repos).sort();
    for (const repoId of repoIds) {
      const repositoryPath = trustedById.get(repoId)!.path;
      const branchName = this.getCompositeBranchName(repoId, manifest.runId);
      if (manifest.repos[repoId].branch !== branchName) {
        throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repoId}: manifest branch does not match the canonical ad-hoc branch`);
      }
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
      try {
        await this.removeEmptyWorkspaceRoot(compositeRoot);
      } catch (error: unknown) {
        const err = error as { message?: string };
        rootFailure = { cause: err.message || 'composite root removal failed' };
      }
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
    const manifest = await this.readCompositeManifest(runId);
    const repositories = manifest
      ? [...this.trustedRepositoriesForManifest(manifest).values()].map((repository) => repository.path)
      : [this.config.baseDir];
    return this.withRepositoryLocks(repositories, () => this.cleanupUnlocked(runId, deleteBranch, options));
  }

  private async cleanupUnlocked(runId: string, deleteBranch = false, options: AdhocCleanupOptions = {}): Promise<AdhocCleanupResult> {
    this.assertSafeRunId(runId);

    const manifest = await this.readCompositeManifest(runId);
    if (manifest) {
      return this.cleanupComposite(manifest, deleteBranch, options);
    }

    return this.cleanupSingle(runId, deleteBranch, options);
  }

  private async cleanupSingle(
    runId: string,
    deleteBranch: boolean,
    options: AdhocCleanupOptions,
    expectedBranchCommit?: string,
  ): Promise<AdhocCleanupResult> {
    const worktreePath = this.getWorktreePath(runId);
    const branchName = this.getBranchName(runId);
    await this.assertNoSymlinkComponents(path.parse(worktreePath).root, worktreePath, true);
    const stat = await this.lstatOrNull(worktreePath);
    if (stat) {
      await this.validateExactWorktreeRegistration(worktreePath, this.config.baseDir, 'adhoc');
    }
    const git = this.getGit();
    const requested = deleteBranch ? 'worktree+branch' : 'worktree';
    let branchPreparationError: string | undefined;
    let pinnedBranchCommit = expectedBranchCommit;
    if (deleteBranch && !pinnedBranchCommit) {
      try {
        pinnedBranchCommit = await this.prepareBranchDeletion(git, branchName, options.discard === true);
      } catch (error) {
        branchPreparationError = (error as Error).message;
      }
    }
    const worktreeRemoval = stat
      ? await this.removeWorktreeStep(git, worktreePath)
      : { status: 'already_absent' as const };
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
      await fs.unlink(this.getSingleMetadataPath(runId)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return cleanupResultFromOutcome(outcome, outcome.outcome === 'complete' ? undefined : 'CLEANUP_FAILED');
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
