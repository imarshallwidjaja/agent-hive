import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';
import type { ReviewWorkspaceManifest, WorkspaceManifestEntry } from './workspaceManifest.js';

export interface ReviewWorkspaceConfig {
  projectRoot: string;
  now?: () => number;
  reviewWorkspaceHandoffMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  onSweepError?: (runId: string, error: Error) => void;
  addWorktree?: (sourcePath: string, targetPath: string, commit: string) => Promise<void>;
  removeWorktree?: (worktreePath: string) => Promise<void>;
}

export interface ReviewWorkspaceRepositoryInput {
  id: string;
  sourcePath: string;
  commit: string;
}

export type ReviewWorkspaceWorkflow = 'dash-review' | 'vulnerability-review';

export interface ReviewWorkspaceCaller {
  workflow: ReviewWorkspaceWorkflow;
  role: 'creator' | 'primary';
  agent: string;
  sessionId: string;
  pid: number;
}

export interface ReviewWorkspaceSourceScope {
  repositoryIds: string[];
  snapshot: {
    baseRef?: string;
    targetRef?: string;
    range?: string;
    paths: string[];
    maxFiles?: number;
    maxPatchBytes?: number;
  };
}

export interface ReviewWorkspaceMaterializedEntryDescriptor {
  path: string;
  kind: 'regular' | 'symlink' | 'delete';
}

export interface ReviewWorkspaceLeaseInput {
  workflow: ReviewWorkspaceWorkflow;
  creatorAgent: string;
  creatorSessionId: string;
  sourceScope: ReviewWorkspaceSourceScope;
  selectedRepositoryIds: string[];
  scopeFingerprint: string;
  sourceFingerprint: string;
  materializedFingerprint: string;
  materializedEntries: Record<string, ReviewWorkspaceMaterializedEntryDescriptor[]>;
}

export interface ReviewWorkspaceCreateOptions {
  runId: string;
  repositories: ReviewWorkspaceRepositoryInput[];
  composite?: boolean;
  lease: ReviewWorkspaceLeaseInput;
}

export interface ReviewWorkspaceRepositoryInfo {
  path: string;
  commit: string;
}

export interface ReviewWorkspaceInfo {
  runId: string;
  workspacePath: string;
  repositories: Record<string, ReviewWorkspaceRepositoryInfo>;
  ownershipToken: string;
}

export interface ReviewWorkspaceRepositoryInspection {
  path: string;
  baselineCommit: string;
  head: string;
  commits: string[];
  trackedChanges: string[];
  untrackedChanges: string[];
  trackedDrift: boolean;
  baselineUntrackedDrift: boolean;
}

export interface ReviewWorkspaceInspection {
  runId: string;
  workspacePath: string;
  lease: ReviewWorkspaceLease;
  repositories: Record<string, ReviewWorkspaceRepositoryInspection>;
  integrity: {
    trackedClean: boolean;
    baselineClean: boolean;
    untrackedFiles: boolean;
  };
}

export interface ReviewWorkspaceCleanupResult {
  runId: string;
  cleaned: boolean;
  workspacePath: string;
  errors: string[];
}

export interface ReviewWorkspaceLease extends ReviewWorkspaceLeaseInput {
  schemaVersion: 1;
  runId: string;
  creatorPid: number;
  ownerAgent?: string;
  ownerSessionId?: string;
  ownerPid?: number;
  ownerRecoveryExpiresAt?: number;
}

interface BaselineEntry {
  path: string;
  fileType: 'regular' | 'symlink';
  mode: number;
  byteLength: number;
  digest: string;
}

interface ReviewWorkspaceBaseline {
  head: string;
  trackedFingerprint: string;
  untracked: BaselineEntry[];
  untrackedFingerprint: string;
}

interface ReviewWorkspaceMetadata {
  schemaVersion: 1;
  state: 'creating' | 'recovery' | 'sealed';
  runId: string;
  workflow: ReviewWorkspaceWorkflow;
  creatorAgent: string;
  creatorSessionId: string;
  sourceScope: ReviewWorkspaceSourceScope;
  selectedRepositoryIds: string[];
  scopeFingerprint: string;
  sourceFingerprint: string;
  materializedFingerprint: string;
  materializedEntries: Record<string, ReviewWorkspaceMaterializedEntryDescriptor[]>;
  composite: boolean;
  commits: Record<string, string>;
  baseline?: Record<string, ReviewWorkspaceBaseline>;
  worktreeRepositoryIds?: string[];
  creatingRepositoryId?: string;
  cleanupIdentities?: Record<string, ReviewWorkspaceCleanupIdentity>;
  ownershipTokenHash: string;
  creatorPid: number;
  handoffExpiresAt?: number;
  removedRepositoryIds?: string[];
  ownerAgent?: string;
  ownerSessionId?: string;
  ownerPid?: number;
  ownerRecoveryExpiresAt?: number;
}

interface ReviewWorkspaceCleanupIdentity {
  sourcePath: string;
  commonDir: string;
}

interface ReviewWorkspaceLock {
  ownerToken: string;
  ownerPid: number;
}

interface HeldReviewWorkspaceLock {
  path: string;
  ownerToken: string;
}

type ResolvedSourceRepository = ReviewWorkspaceRepositoryInput & { sourcePath: string; commonDir: string };

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BASELINE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BASELINE_TOTAL_BYTES = 8 * 1024 * 1024;
const BASELINE_CAPTURE_TIMEOUT_MS = 5_000;
const REVIEW_WORKSPACE_HANDOFF_MS = 5 * 60 * 1000;
const METADATA_DIRECTORY = '.runs';
const LOCK_DIRECTORY = '.locks';
export const REVIEW_WORKSPACE_METADATA_SCHEMA_VERSION = 1;

function isSafeRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId) && !runId.includes('..');
}

function isSafeRepositoryId(repositoryId: string): boolean {
  return REPOSITORY_ID_PATTERN.test(repositoryId)
    && repositoryId !== '.'
    && repositoryId !== '..'
    && !repositoryId.includes('..');
}

function isSafeWorkspaceRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) return false;
  const normalized = path.normalize(relativePath);
  return normalized === relativePath
    && normalized !== '.'
    && normalized !== '..'
    && !normalized.startsWith(`..${path.sep}`);
}

function isSafeSourceScopePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith('-') || relativePath.startsWith(':') || relativePath.includes('\\')) return false;
  if (relativePath.includes('\0') || path.posix.isAbsolute(relativePath)) return false;
  const normalized = path.posix.normalize(relativePath);
  return normalized === relativePath && normalized !== '..' && !normalized.startsWith('../');
}

function isSafeAbsolutePath(value: unknown): value is string {
  return typeof value === 'string'
    && !!value
    && !value.includes('\0')
    && path.isAbsolute(value)
    && path.normalize(value) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint; mode: number | bigint; size: number | bigint; mtimeMs: number | bigint; ctimeMs: number | bigint },
  right: { dev: number | bigint; ino: number | bigint; mode: number | bigint; size: number | bigint; mtimeMs: number | bigint; ctimeMs: number | bigint },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function fingerprintBaselineUntracked(entries: readonly BaselineEntry[]): string {
  const hash = createHash('sha256');
  hash.update('hive-review-baseline-untracked-v1\0');
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.fileType);
    hash.update('\0');
    hash.update(String(entry.mode));
    hash.update('\0');
    hash.update(String(entry.byteLength));
    hash.update('\0');
    hash.update(entry.digest);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function fingerprintReviewWorkspaceSourceScope(sourceScope: ReviewWorkspaceSourceScope): string {
  return createHash('sha256').update(JSON.stringify({
    schema: 'hive-review-workspace-scope/v1',
    repositoryIds: sourceScope.repositoryIds,
    snapshot: sourceScope.snapshot,
  })).digest('hex');
}

export class ReviewWorkspaceService {
  private readonly projectRoot: Promise<string>;

  constructor(private readonly config: ReviewWorkspaceConfig) {
    this.projectRoot = this.resolveProjectRoot();
  }

  private get now(): number {
    return (this.config.now ?? Date.now)();
  }

  private get handoffMs(): number {
    return this.config.reviewWorkspaceHandoffMs ?? REVIEW_WORKSPACE_HANDOFF_MS;
  }

  private async resolveProjectRoot(): Promise<string> {
    const projectRoot = await fs.realpath(this.config.projectRoot);
    const stat = await fs.lstat(projectRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Review workspace project root is not a real directory: ${this.config.projectRoot}`);
    }
    return projectRoot;
  }

  private async reviewRootPath(): Promise<string> {
    return path.join(await this.projectRoot, '.hive', '.worktrees', 'review');
  }

  private getWorkspacePath(reviewRoot: string, runId: string): string {
    this.assertSafeRunId(runId);
    const workspacePath = path.resolve(reviewRoot, runId);
    if (path.dirname(workspacePath) !== reviewRoot) {
      throw new Error(`Review workspace path escapes the review root: ${runId}`);
    }
    return workspacePath;
  }

  private getGit(cwd: string): SimpleGit {
    return simpleGit(cwd);
  }

  private assertSafeRunId(runId: string): void {
    if (!isSafeRunId(runId)) {
      throw new Error(`Invalid review runId: ${JSON.stringify(runId)}`);
    }
  }

  private assertSafeRepositoryId(repositoryId: string): void {
    if (!isSafeRepositoryId(repositoryId)) {
      throw new Error(`Invalid review repository id: ${JSON.stringify(repositoryId)}`);
    }
  }

  private async inspectReviewRoot(required: boolean): Promise<string | null> {
    const projectRoot = await this.projectRoot;
    let current = projectRoot;
    for (const component of ['.hive', '.worktrees', 'review']) {
      const expected = path.join(current, component);
      try {
        const stat = await fs.lstat(expected);
        if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(expected) !== expected) {
          throw new Error(`Review workspace component is not a real directory: ${expected}`);
        }
      } catch (error) {
        if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      current = expected;
    }
    const expectedReviewRoot = await this.reviewRootPath();
    if (current !== expectedReviewRoot || await fs.realpath(current) !== expectedReviewRoot) {
      throw new Error(`Review workspace root resolves outside the canonical project root: ${expectedReviewRoot}`);
    }
    return expectedReviewRoot;
  }

  private async ensureReviewRoot(): Promise<string> {
    const projectRoot = await this.projectRoot;
    let current = projectRoot;
    for (const component of ['.hive', '.worktrees', 'review']) {
      const expected = path.join(current, component);
      try {
        await fs.lstat(expected);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await fs.mkdir(expected);
      }
      const stat = await fs.lstat(expected);
      if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(expected) !== expected) {
        throw new Error(`Review workspace component is not a real directory: ${expected}`);
      }
      current = expected;
    }
    return (await this.inspectReviewRoot(true))!;
  }

  private async ensureContainedDirectory(reviewRoot: string, name: string): Promise<string> {
    const directory = path.join(reviewRoot, name);
    await fs.mkdir(directory, { recursive: true });
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(directory) !== directory) {
      throw new Error(`Review workspace private directory is not contained: ${directory}`);
    }
    return directory;
  }

  private pathInPrivateDirectory(directory: string, runId: string, suffix: string): string {
    this.assertSafeRunId(runId);
    const target = path.resolve(directory, `${runId}${suffix}`);
    if (path.dirname(target) !== directory) {
      throw new Error(`Review workspace metadata path escapes the review root: ${runId}`);
    }
    return target;
  }

  private async getMetadataPath(reviewRoot: string, runId: string, createDirectory = false): Promise<string> {
    const metadataRoot = createDirectory
      ? await this.ensureContainedDirectory(reviewRoot, METADATA_DIRECTORY)
      : path.join(reviewRoot, METADATA_DIRECTORY);
    if (!createDirectory) {
      const stat = await fs.lstat(metadataRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(metadataRoot) !== metadataRoot) {
        throw this.metadataError(runId);
      }
    }
    return this.pathInPrivateDirectory(metadataRoot, runId, '.json');
  }

  private async getLockPath(reviewRoot: string, runId: string, createDirectory = false): Promise<string> {
    const lockRoot = createDirectory
      ? await this.ensureContainedDirectory(reviewRoot, LOCK_DIRECTORY)
      : path.join(reviewRoot, LOCK_DIRECTORY);
    if (!createDirectory) {
      const stat = await fs.lstat(lockRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(lockRoot) !== lockRoot) {
        throw this.metadataError(runId);
      }
    }
    return this.pathInPrivateDirectory(lockRoot, runId, '.lock');
  }

  private async resolveContainedWorkspaceAtRoot(reviewRoot: string, runId: string): Promise<string> {
    const workspacePath = this.getWorkspacePath(reviewRoot, runId);
    const stat = await fs.lstat(workspacePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Review workspace is not a real directory: ${workspacePath}`);
    }
    if (await fs.realpath(workspacePath) !== workspacePath) {
      throw new Error(`Review workspace escapes the review root: ${workspacePath}`);
    }
    return workspacePath;
  }

  private async resolveRepository(input: ReviewWorkspaceRepositoryInput): Promise<ResolvedSourceRepository> {
    this.assertSafeRepositoryId(input.id);
    const sourcePath = await fs.realpath(input.sourcePath);
    const git = this.getGit(sourcePath);
    const [topLevelOutput, commonDirOutput] = await Promise.all([
      git.raw(['rev-parse', '--show-toplevel']),
      git.raw(['rev-parse', '--git-common-dir']),
    ]);
    const topLevel = path.resolve(topLevelOutput.trim());
    if (topLevel !== sourcePath) {
      throw new Error(`Review source must be an exact Git root: ${input.sourcePath}`);
    }
    const commonDir = await fs.realpath(path.resolve(sourcePath, commonDirOutput.trim()));
    const commonStat = await fs.lstat(commonDir);
    if (commonStat.isSymbolicLink() || !commonStat.isDirectory()) {
      throw new Error(`Review source Git common directory is not a real directory: ${input.sourcePath}`);
    }
    const commit = (await git.raw(['rev-parse', '--verify', `${input.commit}^{commit}`])).trim();
    return { id: input.id, sourcePath, commonDir, commit };
  }

  private metadataError(runId: string): Error {
    return new Error(`Invalid review workspace metadata for ${runId}`);
  }

  private validateMetadata(runId: string, metadata: unknown): ReviewWorkspaceMetadata {
    if (!isRecord(metadata)) throw this.metadataError(runId);
    const allowedFields = new Set([
      'schemaVersion', 'state', 'runId', 'workflow', 'creatorAgent', 'creatorSessionId', 'creatorPid',
      'sourceScope', 'selectedRepositoryIds', 'scopeFingerprint', 'sourceFingerprint',
      'materializedFingerprint', 'materializedEntries', 'composite', 'commits', 'baseline',
      'worktreeRepositoryIds', 'creatingRepositoryId', 'cleanupIdentities', 'ownershipTokenHash',
      'handoffExpiresAt', 'removedRepositoryIds', 'ownerAgent', 'ownerSessionId', 'ownerPid',
      'ownerRecoveryExpiresAt',
    ]);
    if (
      metadata.schemaVersion !== REVIEW_WORKSPACE_METADATA_SCHEMA_VERSION
      || (metadata.state !== 'creating' && metadata.state !== 'recovery' && metadata.state !== 'sealed')
      || metadata.runId !== runId
      || (metadata.workflow !== 'dash-review' && metadata.workflow !== 'vulnerability-review')
      || typeof metadata.creatorAgent !== 'string' || !metadata.creatorAgent
      || typeof metadata.creatorSessionId !== 'string' || !metadata.creatorSessionId
      || typeof metadata.composite !== 'boolean'
      || !Array.isArray(metadata.selectedRepositoryIds)
      || !isRecord(metadata.sourceScope)
      || !isRecord(metadata.materializedEntries)
      || !isRecord(metadata.commits)
      || typeof metadata.scopeFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.scopeFingerprint)
      || typeof metadata.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sourceFingerprint)
      || typeof metadata.materializedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.materializedFingerprint)
      || typeof metadata.ownershipTokenHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(metadata.ownershipTokenHash)
      || typeof metadata.creatorPid !== 'number' || !Number.isSafeInteger(metadata.creatorPid) || metadata.creatorPid < 1
      || Object.keys(metadata).some((field) => !allowedFields.has(field))
    ) {
      throw this.metadataError(runId);
    }
    const selectedRepositoryIds = [...metadata.selectedRepositoryIds];
    if (
      selectedRepositoryIds.length === 0
      || new Set(selectedRepositoryIds).size !== selectedRepositoryIds.length
      || selectedRepositoryIds.some((repositoryId) => typeof repositoryId !== 'string' || !isSafeRepositoryId(repositoryId))
      || JSON.stringify([...selectedRepositoryIds].sort()) !== JSON.stringify(selectedRepositoryIds)
      || (!metadata.composite && selectedRepositoryIds.length > 1)
    ) {
      throw this.metadataError(runId);
    }
    const sourceScope = metadata.sourceScope;
    if (
      Object.keys(sourceScope).some((field) => field !== 'repositoryIds' && field !== 'snapshot')
      || !Array.isArray(sourceScope.repositoryIds)
      || !isRecord(sourceScope.snapshot)
      || sourceScope.repositoryIds.some((repositoryId) => typeof repositoryId !== 'string' || !isSafeRepositoryId(repositoryId))
      || new Set(sourceScope.repositoryIds).size !== sourceScope.repositoryIds.length
      || JSON.stringify([...sourceScope.repositoryIds].sort()) !== JSON.stringify(sourceScope.repositoryIds)
    ) {
      throw this.metadataError(runId);
    }
    const snapshot = sourceScope.snapshot;
    const snapshotFields = new Set(['baseRef', 'targetRef', 'range', 'paths', 'maxFiles', 'maxPatchBytes']);
    if (
      Object.keys(snapshot).some((field) => !snapshotFields.has(field))
      || !Array.isArray(snapshot.paths)
      || snapshot.paths.some((entry) => typeof entry !== 'string' || !isSafeSourceScopePath(entry))
      || new Set(snapshot.paths).size !== snapshot.paths.length
      || JSON.stringify([...snapshot.paths].sort()) !== JSON.stringify(snapshot.paths)
      || ['baseRef', 'targetRef', 'range'].some((field) => snapshot[field] !== undefined && (typeof snapshot[field] !== 'string' || !snapshot[field]))
      || ['maxFiles', 'maxPatchBytes'].some((field) => snapshot[field] !== undefined && (typeof snapshot[field] !== 'number' || !Number.isSafeInteger(snapshot[field]) || snapshot[field] < 1))
      || (snapshot.range !== undefined && (snapshot.baseRef !== undefined || snapshot.targetRef !== undefined))
    ) {
      throw this.metadataError(runId);
    }
    const canonicalSourceScope: ReviewWorkspaceSourceScope = {
      repositoryIds: [...sourceScope.repositoryIds] as string[],
      snapshot: {
        ...(typeof snapshot.baseRef === 'string' ? { baseRef: snapshot.baseRef } : {}),
        ...(typeof snapshot.targetRef === 'string' ? { targetRef: snapshot.targetRef } : {}),
        ...(typeof snapshot.range === 'string' ? { range: snapshot.range } : {}),
        paths: [...snapshot.paths] as string[],
        ...(typeof snapshot.maxFiles === 'number' ? { maxFiles: snapshot.maxFiles } : {}),
        ...(typeof snapshot.maxPatchBytes === 'number' ? { maxPatchBytes: snapshot.maxPatchBytes } : {}),
      },
    };
    const expectedScopeFingerprint = fingerprintReviewWorkspaceSourceScope(canonicalSourceScope);
    if (metadata.scopeFingerprint !== expectedScopeFingerprint) throw this.metadataError(runId);
    const materializedEntries: Record<string, ReviewWorkspaceMaterializedEntryDescriptor[]> = {};
    if (JSON.stringify(Object.keys(metadata.materializedEntries).sort()) !== JSON.stringify(selectedRepositoryIds)) {
      throw this.metadataError(runId);
    }
    for (const repositoryId of selectedRepositoryIds) {
      const entries = metadata.materializedEntries[repositoryId];
      if (!Array.isArray(entries)) throw this.metadataError(runId);
      const paths = new Set<string>();
      materializedEntries[repositoryId] = entries.map((entry) => {
        if (
          !isRecord(entry)
          || Object.keys(entry).some((field) => field !== 'path' && field !== 'kind')
          || typeof entry.path !== 'string'
          || !isSafeWorkspaceRelativePath(entry.path)
          || paths.has(entry.path)
          || (entry.kind !== 'regular' && entry.kind !== 'symlink' && entry.kind !== 'delete')
        ) {
          throw this.metadataError(runId);
        }
        paths.add(entry.path);
        return { path: entry.path, kind: entry.kind };
      });
      if (JSON.stringify([...paths].sort()) !== JSON.stringify([...paths])) throw this.metadataError(runId);
    }
    const hasOwnerAgent = metadata.ownerAgent !== undefined;
    const hasOwnerSession = metadata.ownerSessionId !== undefined;
    const hasOwnerPid = metadata.ownerPid !== undefined;
    if (
      hasOwnerAgent !== hasOwnerSession || hasOwnerSession !== hasOwnerPid
      || (hasOwnerAgent && (typeof metadata.ownerAgent !== 'string' || !metadata.ownerAgent))
      || (hasOwnerSession && (typeof metadata.ownerSessionId !== 'string' || !metadata.ownerSessionId))
      || (hasOwnerPid && (typeof metadata.ownerPid !== 'number' || !Number.isSafeInteger(metadata.ownerPid) || metadata.ownerPid < 1))
      || (metadata.ownerRecoveryExpiresAt !== undefined && (!hasOwnerPid || typeof metadata.ownerRecoveryExpiresAt !== 'number' || !Number.isFinite(metadata.ownerRecoveryExpiresAt)))
    ) {
      throw this.metadataError(runId);
    }
    const removedRepositoryIds = metadata.removedRepositoryIds === undefined ? [] : metadata.removedRepositoryIds;
    if (
      !Array.isArray(removedRepositoryIds)
      || new Set(removedRepositoryIds).size !== removedRepositoryIds.length
      || removedRepositoryIds.some((repositoryId) => typeof repositoryId !== 'string' || !selectedRepositoryIds.includes(repositoryId))
    ) {
      throw this.metadataError(runId);
    }
    const commits = metadata.commits;
    if (JSON.stringify(Object.keys(commits).sort()) !== JSON.stringify(selectedRepositoryIds)) {
      throw this.metadataError(runId);
    }
    for (const repositoryId of selectedRepositoryIds) {
      if (typeof commits[repositoryId] !== 'string' || !/^[a-f0-9]{40,64}$/.test(commits[repositoryId] as string)) {
        throw this.metadataError(runId);
      }
    }
    if (!isRecord(metadata.cleanupIdentities)) throw this.metadataError(runId);
    const cleanupIdentities: Record<string, ReviewWorkspaceCleanupIdentity> = {};
    for (const [repositoryId, identity] of Object.entries(metadata.cleanupIdentities)) {
      if (
        !selectedRepositoryIds.includes(repositoryId)
        || !isRecord(identity)
        || Object.keys(identity).some((field) => field !== 'sourcePath' && field !== 'commonDir')
        || !isSafeAbsolutePath(identity.sourcePath)
        || !isSafeAbsolutePath(identity.commonDir)
      ) {
        throw this.metadataError(runId);
      }
      cleanupIdentities[repositoryId] = {
        sourcePath: identity.sourcePath,
        commonDir: identity.commonDir,
      };
    }
    const common = {
      schemaVersion: REVIEW_WORKSPACE_METADATA_SCHEMA_VERSION,
      runId,
      workflow: metadata.workflow,
      creatorAgent: metadata.creatorAgent,
      creatorSessionId: metadata.creatorSessionId,
      creatorPid: metadata.creatorPid,
      sourceScope: canonicalSourceScope,
      selectedRepositoryIds,
      scopeFingerprint: metadata.scopeFingerprint,
      sourceFingerprint: metadata.sourceFingerprint,
      materializedFingerprint: metadata.materializedFingerprint,
      materializedEntries,
      composite: metadata.composite,
      commits: Object.fromEntries(selectedRepositoryIds.map((repositoryId) => [repositoryId, commits[repositoryId] as string])),
      cleanupIdentities,
      ownershipTokenHash: metadata.ownershipTokenHash,
    } satisfies Omit<ReviewWorkspaceMetadata, 'state'>;
    const state = metadata.state;
    if (state === 'creating' || state === 'recovery') {
      if (
        !Array.isArray(metadata.worktreeRepositoryIds)
        || metadata.baseline !== undefined
        || removedRepositoryIds.length > 0
        || hasOwnerSession
        || metadata.ownerRecoveryExpiresAt !== undefined
        || metadata.handoffExpiresAt !== undefined
        || (state === 'recovery' && metadata.creatingRepositoryId !== undefined)
      ) {
        throw this.metadataError(runId);
      }
      if (
        new Set(metadata.worktreeRepositoryIds).size !== metadata.worktreeRepositoryIds.length
        || metadata.worktreeRepositoryIds.some((repositoryId) => typeof repositoryId !== 'string' || !selectedRepositoryIds.includes(repositoryId))
      ) {
        throw this.metadataError(runId);
      }
      if (
        metadata.creatingRepositoryId !== undefined
        && (
          typeof metadata.creatingRepositoryId !== 'string'
          || !selectedRepositoryIds.includes(metadata.creatingRepositoryId)
          || metadata.worktreeRepositoryIds.includes(metadata.creatingRepositoryId)
        )
      ) {
        throw this.metadataError(runId);
      }
      const worktreeRepositoryIds = [...metadata.worktreeRepositoryIds].sort();
      const cleanupRepositoryIds = [...new Set([
        ...worktreeRepositoryIds,
        ...(typeof metadata.creatingRepositoryId === 'string' ? [metadata.creatingRepositoryId] : []),
      ])].sort();
      if (JSON.stringify(Object.keys(cleanupIdentities).sort()) !== JSON.stringify(cleanupRepositoryIds)) {
        throw this.metadataError(runId);
      }
      return {
        ...common,
        state,
        worktreeRepositoryIds,
        ...(typeof metadata.creatingRepositoryId === 'string' ? { creatingRepositoryId: metadata.creatingRepositoryId } : {}),
        cleanupIdentities,
      };
    }
    if (
      !isRecord(metadata.baseline)
      || metadata.worktreeRepositoryIds !== undefined
      || metadata.creatingRepositoryId !== undefined
      || typeof metadata.handoffExpiresAt !== 'number' || !Number.isFinite(metadata.handoffExpiresAt)
    ) {
      throw this.metadataError(runId);
    }
    if (JSON.stringify(Object.keys(cleanupIdentities).sort()) !== JSON.stringify(selectedRepositoryIds)) {
      throw this.metadataError(runId);
    }
    const baselines = metadata.baseline;
    if (JSON.stringify(Object.keys(baselines).sort()) !== JSON.stringify(selectedRepositoryIds)) {
      throw this.metadataError(runId);
    }
    for (const repositoryId of selectedRepositoryIds) {
      const baseline = baselines[repositoryId];
      if (!isRecord(baseline) || typeof baseline.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(baseline.head) || typeof baseline.trackedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(baseline.trackedFingerprint) || typeof baseline.untrackedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(baseline.untrackedFingerprint) || !Array.isArray(baseline.untracked)) {
        throw this.metadataError(runId);
      }
      const untrackedPaths = new Set<string>();
      for (const entry of baseline.untracked) {
        if (
          !isRecord(entry)
          || typeof entry.path !== 'string'
          || !isSafeWorkspaceRelativePath(entry.path)
          || untrackedPaths.has(entry.path)
          || (entry.fileType !== 'regular' && entry.fileType !== 'symlink')
          || typeof entry.mode !== 'number' || !Number.isSafeInteger(entry.mode)
          || typeof entry.byteLength !== 'number' || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0
          || typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest)
        ) {
          throw this.metadataError(runId);
        }
        untrackedPaths.add(entry.path);
      }
      if (fingerprintBaselineUntracked(baseline.untracked as BaselineEntry[]) !== baseline.untrackedFingerprint) {
        throw this.metadataError(runId);
      }
    }
    return {
      ...common,
      state,
      baseline: Object.fromEntries(selectedRepositoryIds.map((repositoryId) => [repositoryId, baselines[repositoryId] as ReviewWorkspaceBaseline])),
      handoffExpiresAt: metadata.handoffExpiresAt,
      ...(removedRepositoryIds.length > 0 ? { removedRepositoryIds: [...removedRepositoryIds].sort() } : {}),
      ...(typeof metadata.ownerSessionId === 'string' ? {
        ownerAgent: metadata.ownerAgent as string,
        ownerSessionId: metadata.ownerSessionId,
        ownerPid: metadata.ownerPid as number,
        ...(typeof metadata.ownerRecoveryExpiresAt === 'number' ? { ownerRecoveryExpiresAt: metadata.ownerRecoveryExpiresAt } : {}),
      } : {}),
    };
  }

  private async readMetadata(runId: string): Promise<ReviewWorkspaceMetadata | null> {
    this.assertSafeRunId(runId);
    try {
      const reviewRoot = await this.inspectReviewRoot(false);
      if (!reviewRoot) return null;
      const metadataPath = await this.getMetadataPath(reviewRoot, runId);
      const stat = await fs.lstat(metadataPath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw this.metadataError(runId);
      const raw = await fs.readFile(metadataPath, 'utf8');
      return this.validateMetadata(runId, JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof SyntaxError || error instanceof TypeError) throw this.metadataError(runId);
      throw error;
    }
  }

  private async writeNewMetadata(reviewRoot: string, metadata: ReviewWorkspaceMetadata): Promise<void> {
    const validated = this.validateMetadata(metadata.runId, metadata);
    const metadataPath = await this.getMetadataPath(reviewRoot, metadata.runId, true);
    const temporaryPath = path.join(path.dirname(metadataPath), `.metadata-${randomUUID()}`);
    await fs.writeFile(temporaryPath, JSON.stringify(validated, null, 2), { encoding: 'utf8', flag: 'wx' });
    try {
      await fs.link(temporaryPath, metadataPath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }

  private async writeMetadata(reviewRoot: string, metadata: ReviewWorkspaceMetadata): Promise<void> {
    const validated = this.validateMetadata(metadata.runId, metadata);
    const metadataPath = await this.getMetadataPath(reviewRoot, metadata.runId);
    const stat = await fs.lstat(metadataPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw this.metadataError(metadata.runId);
    const temporaryPath = path.join(path.dirname(metadataPath), `.metadata-${randomUUID()}`);
    await fs.writeFile(temporaryPath, JSON.stringify(validated, null, 2), { encoding: 'utf8', flag: 'wx' });
    try {
      await fs.rename(temporaryPath, metadataPath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }

  private async readRunLock(lockPath: string): Promise<ReviewWorkspaceLock> {
    const stat = await fs.lstat(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Review workspace lock is invalid: ${lockPath}`);
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')) as unknown;
    if (
      !isRecord(lock)
      || Object.keys(lock).some((field) => field !== 'ownerToken' && field !== 'ownerPid')
      || typeof lock.ownerToken !== 'string' || !lock.ownerToken
      || typeof lock.ownerPid !== 'number' || !Number.isSafeInteger(lock.ownerPid) || lock.ownerPid < 1
    ) {
      throw new Error(`Review workspace lock is invalid: ${lockPath}`);
    }
    return { ownerToken: lock.ownerToken, ownerPid: lock.ownerPid };
  }

  private isProcessAlive(pid: number): boolean {
    if (this.config.isProcessAlive) return this.config.isProcessAlive(pid);
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private async recoverDeadRunLock(lockPath: string, expected: ReviewWorkspaceLock): Promise<void> {
    const tombstonePath = `${lockPath}.dead-${randomUUID()}`;
    try {
      await fs.rename(lockPath, tombstonePath);
    } catch {
      throw new Error('Review workspace is busy.');
    }
    const moved = await this.readRunLock(tombstonePath);
    if (moved.ownerToken !== expected.ownerToken || moved.ownerPid !== expected.ownerPid) {
      await fs.link(tombstonePath, lockPath).catch(() => undefined);
      await fs.rm(tombstonePath, { force: true });
      throw new Error('Review workspace is busy.');
    }
    await fs.rm(tombstonePath);
  }

  private async acquireRunLock(reviewRoot: string, runId: string): Promise<HeldReviewWorkspaceLock> {
    const lockPath = await this.getLockPath(reviewRoot, runId, true);
    const ownerToken = randomUUID();
    const ownerPid = process.pid;
    const lock: ReviewWorkspaceLock = { ownerToken, ownerPid };
    try {
      await fs.writeFile(lockPath, JSON.stringify(lock), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await this.readRunLock(lockPath);
      if (this.isProcessAlive(current.ownerPid)) {
        throw new Error(`Review workspace is busy: ${runId}`);
      }
      await this.recoverDeadRunLock(lockPath, current);
      try {
        await fs.writeFile(lockPath, JSON.stringify(lock), { encoding: 'utf8', flag: 'wx' });
      } catch (recoveryError) {
        if ((recoveryError as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`Review workspace is busy: ${runId}`);
        }
        throw recoveryError;
      }
    }
    return { path: lockPath, ownerToken };
  }

  private async releaseRunLock(lock: HeldReviewWorkspaceLock): Promise<void> {
    try {
      const current = await this.readRunLock(lock.path);
      if (current.ownerToken !== lock.ownerToken) return;
      await fs.rm(lock.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private async withRunLock<T>(runId: string, operation: (reviewRoot: string) => Promise<T>): Promise<T> {
    this.assertSafeRunId(runId);
    const reviewRoot = await this.inspectReviewRoot(true);
    const lock = await this.acquireRunLock(reviewRoot!, runId);
    try {
      return await operation(reviewRoot!);
    } finally {
      await this.releaseRunLock(lock);
    }
  }

  private assertOwnershipToken(metadata: ReviewWorkspaceMetadata, token: string): void {
    const actual = createHash('sha256').update(token).digest();
    const expected = Buffer.from(metadata.ownershipTokenHash, 'hex');
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new Error('Invalid review workspace ownership token.');
    }
  }

  private callerPid(caller: ReviewWorkspaceCaller): number {
    const pid = caller.pid;
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Review workspace caller process is required.');
    return pid;
  }

  private assertCreatorCaller(metadata: ReviewWorkspaceMetadata, caller: ReviewWorkspaceCaller): void {
    if (
      caller.role !== 'creator'
      || metadata.workflow !== caller.workflow
      || metadata.creatorAgent !== caller.agent
      || metadata.creatorSessionId !== caller.sessionId
    ) {
      throw new Error('Review workspace creator capability was denied.');
    }
  }

  private assertOwnerCaller(metadata: ReviewWorkspaceMetadata, caller: ReviewWorkspaceCaller): void {
    if (
      caller.role !== 'primary'
      || metadata.workflow !== caller.workflow
      || metadata.ownerAgent !== caller.agent
      || metadata.ownerSessionId !== caller.sessionId
    ) {
      throw new Error('Review workspace owner capability was denied.');
    }
  }

  private lease(metadata: ReviewWorkspaceMetadata): ReviewWorkspaceLease {
    return {
      schemaVersion: metadata.schemaVersion,
      runId: metadata.runId,
      workflow: metadata.workflow,
      creatorAgent: metadata.creatorAgent,
      creatorSessionId: metadata.creatorSessionId,
      creatorPid: metadata.creatorPid,
      sourceScope: metadata.sourceScope,
      selectedRepositoryIds: metadata.selectedRepositoryIds,
      scopeFingerprint: metadata.scopeFingerprint,
      sourceFingerprint: metadata.sourceFingerprint,
      materializedFingerprint: metadata.materializedFingerprint,
      materializedEntries: metadata.materializedEntries,
      ...(metadata.ownerAgent ? {
        ownerAgent: metadata.ownerAgent,
        ownerSessionId: metadata.ownerSessionId,
        ownerPid: metadata.ownerPid,
        ...(metadata.ownerRecoveryExpiresAt === undefined ? {} : { ownerRecoveryExpiresAt: metadata.ownerRecoveryExpiresAt }),
      } : {}),
    };
  }

  private async resolveRepositories(
    metadata: ReviewWorkspaceMetadata,
    workspacePath: string,
    allowMissing = false,
  ): Promise<Record<string, ReviewWorkspaceRepositoryInfo>> {
    const repositories: Record<string, ReviewWorkspaceRepositoryInfo> = {};
    const reposRoot = path.join(workspacePath, 'repos');
    if (metadata.composite) {
      let reposStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
      try {
        reposStat = await fs.lstat(reposRoot);
      } catch (error) {
        if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw this.metadataError(metadata.runId);
      }
      if (reposStat && (reposStat.isSymbolicLink() || !reposStat.isDirectory() || await fs.realpath(reposRoot) !== reposRoot)) {
        throw this.metadataError(metadata.runId);
      }
    }
    const repositoryIds = metadata.state === 'sealed'
      ? metadata.selectedRepositoryIds.filter((repositoryId) => !metadata.removedRepositoryIds?.includes(repositoryId))
      : [...new Set([...(metadata.worktreeRepositoryIds ?? []), ...(metadata.creatingRepositoryId ? [metadata.creatingRepositoryId] : [])])].sort();
    for (const repositoryId of repositoryIds) {
      const repositoryPath = metadata.composite ? path.join(reposRoot, repositoryId) : workspacePath;
      const expectedPath = metadata.composite ? path.resolve(reposRoot, repositoryId) : workspacePath;
      if (repositoryPath !== expectedPath || (metadata.composite && path.dirname(repositoryPath) !== reposRoot)) {
        throw this.metadataError(metadata.runId);
      }
      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stat = await fs.lstat(repositoryPath);
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          repositories[repositoryId] = { path: repositoryPath, commit: metadata.commits[repositoryId]! };
          continue;
        }
        throw this.metadataError(metadata.runId);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(repositoryPath) !== repositoryPath) {
        throw this.metadataError(metadata.runId);
      }
      repositories[repositoryId] = { path: repositoryPath, commit: metadata.commits[repositoryId]! };
    }
    return repositories;
  }

  private async captureBaselineEntry(
    workspacePath: string,
    relativePath: string,
    deadline: number,
    remainingBytes: number,
  ): Promise<BaselineEntry> {
    const targetPath = path.resolve(workspacePath, relativePath);
    if (targetPath === workspacePath || !targetPath.startsWith(`${workspacePath}${path.sep}`)) {
      throw new Error(`Baseline path escapes review workspace: ${relativePath}`);
    }
    const stat = await fs.lstat(targetPath);
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(targetPath);
      const completed = await fs.lstat(targetPath);
      if (!completed.isSymbolicLink() || !sameFileIdentity(stat, completed)) {
        throw new Error(`Baseline symlink changed during capture: ${relativePath}`);
      }
      const content = Buffer.from(target);
      if (content.byteLength > MAX_BASELINE_FILE_BYTES || content.byteLength > remainingBytes) {
        throw new Error(`Baseline untracked file exceeds review workspace bounds: ${relativePath}`);
      }
      return {
        path: relativePath,
        fileType: 'symlink',
        mode: completed.mode & 0o7777,
        byteLength: content.byteLength,
        digest: createHash('sha256').update(content).digest('hex'),
      };
    }
    if (!stat.isFile() || typeof constants.O_NOFOLLOW !== 'number') {
      throw new Error(`Unsupported baseline untracked file: ${relativePath}`);
    }
    if (stat.size > MAX_BASELINE_FILE_BYTES || stat.size > remainingBytes) {
      throw new Error(`Baseline untracked file exceeds review workspace bounds: ${relativePath}`);
    }
    const file = await fs.open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || !sameFileIdentity(stat, opened)) {
        throw new Error(`Baseline file changed before capture: ${relativePath}`);
      }
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let byteLength = 0;
      let position = 0;
      while (true) {
        if (this.now > deadline) throw new Error('Baseline capture deadline exceeded.');
        const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position);
        if (bytesRead === 0) break;
        byteLength += bytesRead;
        if (byteLength > MAX_BASELINE_FILE_BYTES || byteLength > remainingBytes) {
          throw new Error(`Baseline untracked file exceeds review workspace bounds: ${relativePath}`);
        }
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const completed = await file.stat();
      if (!sameFileIdentity(opened, completed)) {
        throw new Error(`Baseline file changed during capture: ${relativePath}`);
      }
      return {
        path: relativePath,
        fileType: 'regular',
        mode: completed.mode & 0o7777,
        byteLength,
        digest: hash.digest('hex'),
      };
    } finally {
      await file.close();
    }
  }

  private async captureBaseline(
    repositories: Record<string, ReviewWorkspaceRepositoryInfo>,
  ): Promise<Record<string, ReviewWorkspaceBaseline>> {
    const baseline: Record<string, ReviewWorkspaceBaseline> = {};
    for (const [repositoryId, repository] of Object.entries(repositories)) {
      const git = this.getGit(repository.path);
      const [head, unstaged, staged, untracked] = await Promise.all([
        git.raw(['rev-parse', 'HEAD']),
        git.raw(['diff', '--binary', '--no-ext-diff', '--no-textconv']),
        git.raw(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--cached']),
        git.raw(['ls-files', '--others', '--exclude-standard', '-z']),
      ]);
      const deadline = this.now + BASELINE_CAPTURE_TIMEOUT_MS;
      let remainingBytes = MAX_BASELINE_TOTAL_BYTES;
      const entries: BaselineEntry[] = [];
      for (const relativePath of untracked.split('\0').filter(Boolean).sort()) {
        const entry = await this.captureBaselineEntry(repository.path, relativePath, deadline, remainingBytes);
        remainingBytes -= entry.byteLength;
        entries.push(entry);
      }
      baseline[repositoryId] = {
        head: head.trim(),
        trackedFingerprint: createHash('sha256').update(unstaged).update('\0').update(staged).digest('hex'),
        untracked: entries,
        untrackedFingerprint: fingerprintBaselineUntracked(entries),
      };
    }
    return baseline;
  }

  private async hasBaselineUntrackedDrift(
    workspacePath: string,
    baseline: ReviewWorkspaceBaseline,
  ): Promise<boolean> {
    const deadline = this.now + BASELINE_CAPTURE_TIMEOUT_MS;
    let remainingBytes = MAX_BASELINE_TOTAL_BYTES;
    const actualEntries: BaselineEntry[] = [];
    for (const expected of baseline.untracked) {
      try {
        const actual = await this.captureBaselineEntry(workspacePath, expected.path, deadline, remainingBytes);
        remainingBytes -= actual.byteLength;
        actualEntries.push(actual);
      } catch {
        return true;
      }
    }
    return fingerprintBaselineUntracked(actualEntries) !== baseline.untrackedFingerprint;
  }

  private cleanupIdentity(
    metadata: ReviewWorkspaceMetadata,
    repositoryId: string,
  ): ReviewWorkspaceCleanupIdentity {
    const identity = metadata.cleanupIdentities?.[repositoryId];
    if (!identity) throw this.metadataError(metadata.runId);
    return identity;
  }

  private async verifiedCleanupGit(
    runId: string,
    identity: ReviewWorkspaceCleanupIdentity,
  ): Promise<SimpleGit> {
    const sourcePath = await fs.realpath(identity.sourcePath).catch(() => null);
    if (sourcePath !== identity.sourcePath) throw this.metadataError(runId);
    const git = this.getGit(sourcePath);
    const [topLevelOutput, commonDirOutput] = await Promise.all([
      git.raw(['rev-parse', '--show-toplevel']),
      git.raw(['rev-parse', '--git-common-dir']),
    ]).catch(() => {
      throw this.metadataError(runId);
    });
    const topLevel = path.resolve(topLevelOutput.trim());
    const commonDir = await fs.realpath(path.resolve(sourcePath, commonDirOutput.trim())).catch(() => null);
    if (topLevel !== identity.sourcePath || commonDir !== identity.commonDir) throw this.metadataError(runId);
    return git;
  }

  private async isRegisteredWorktree(git: SimpleGit, worktreePath: string): Promise<boolean> {
    const entries = await git.raw(['worktree', 'list', '--porcelain']);
    return entries.split('\n').some((entry) => entry === `worktree ${worktreePath}`);
  }

  private async assertWorktreeDeregistered(
    git: SimpleGit,
    worktreePath: string,
    context: 'recovery' | 'removal',
  ): Promise<void> {
    if (await this.isRegisteredWorktree(git, worktreePath)) {
      throw new Error(`Review worktree remains registered after ${context}: ${worktreePath}`);
    }
  }

  private async removeMissingWorktreeRegistration(
    runId: string,
    worktreePath: string,
    identity: ReviewWorkspaceCleanupIdentity,
  ): Promise<void> {
    const git = await this.verifiedCleanupGit(runId, identity);
    if (!await this.isRegisteredWorktree(git, worktreePath)) return;
    await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(async () => {
      await git.raw(['worktree', 'prune']);
    });
    await this.assertWorktreeDeregistered(git, worktreePath, 'recovery');
  }

  private async removeContainedWorktree(
    runId: string,
    worktreePath: string,
    identity: ReviewWorkspaceCleanupIdentity,
  ): Promise<void> {
    const sourceGit = await this.verifiedCleanupGit(runId, identity);
    const stat = await fs.lstat(worktreePath);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(worktreePath) !== worktreePath) {
      throw new Error(`Review worktree is not a real directory: ${worktreePath}`);
    }
    const git = this.getGit(worktreePath);
    const [topLevel, gitDir, commonDir] = await Promise.all([
      git.raw(['rev-parse', '--show-toplevel']),
      git.raw(['rev-parse', '--git-dir']),
      git.raw(['rev-parse', '--git-common-dir']),
    ]);
    if (path.resolve(topLevel.trim()) !== worktreePath) {
      throw new Error(`Review worktree top-level does not match contained path: ${worktreePath}`);
    }
    const resolvedCommonDir = await fs.realpath(path.resolve(worktreePath, commonDir.trim()));
    const resolvedGitDir = path.resolve(worktreePath, gitDir.trim());
    const worktreesDir = path.join(resolvedCommonDir, 'worktrees');
    if (resolvedCommonDir !== identity.commonDir || !resolvedGitDir.startsWith(`${worktreesDir}${path.sep}`)) {
      throw new Error(`Review worktree Git directory is not linked from its common directory: ${worktreePath}`);
    }
    if (this.config.removeWorktree) {
      await this.config.removeWorktree(worktreePath);
      await this.assertWorktreeDeregistered(sourceGit, worktreePath, 'removal');
      return;
    }
    await sourceGit.raw(['worktree', 'remove', '--force', worktreePath]);
    await sourceGit.raw(['worktree', 'prune']);
    await this.assertWorktreeDeregistered(sourceGit, worktreePath, 'removal');
  }

  private async addDetachedWorktree(sourcePath: string, targetPath: string, commit: string): Promise<void> {
    if (this.config.addWorktree) {
      await this.config.addWorktree(sourcePath, targetPath, commit);
      return;
    }
    await this.getGit(sourcePath).raw(['worktree', 'add', '--detach', targetPath, commit]);
  }

  private createCreatingMetadata(
    runId: string,
    composite: boolean,
    repositories: readonly ResolvedSourceRepository[],
    ownershipToken: string,
    lease: ReviewWorkspaceLeaseInput,
  ): ReviewWorkspaceMetadata {
    return {
      schemaVersion: REVIEW_WORKSPACE_METADATA_SCHEMA_VERSION,
      state: 'creating',
      runId,
      workflow: lease.workflow,
      creatorAgent: lease.creatorAgent,
      creatorSessionId: lease.creatorSessionId,
      creatorPid: process.pid,
      sourceScope: lease.sourceScope,
      selectedRepositoryIds: lease.selectedRepositoryIds,
      scopeFingerprint: lease.scopeFingerprint,
      sourceFingerprint: lease.sourceFingerprint,
      materializedFingerprint: lease.materializedFingerprint,
      materializedEntries: lease.materializedEntries,
      composite,
      commits: Object.fromEntries(repositories.map((repository) => [repository.id, repository.commit])),
      worktreeRepositoryIds: [],
      cleanupIdentities: {},
      ownershipTokenHash: createHash('sha256').update(ownershipToken).digest('hex'),
    };
  }

  private transitionToRecovery(metadata: ReviewWorkspaceMetadata, survivingRepositoryIds: Iterable<string>): void {
    const repositoryIds = [...new Set(survivingRepositoryIds)].sort();
    metadata.state = 'recovery';
    metadata.worktreeRepositoryIds = repositoryIds;
    metadata.cleanupIdentities = Object.fromEntries(repositoryIds.map((repositoryId) => [repositoryId, metadata.cleanupIdentities![repositoryId]!]));
    delete metadata.creatingRepositoryId;
    delete metadata.baseline;
    delete metadata.handoffExpiresAt;
    delete metadata.removedRepositoryIds;
    delete metadata.ownerAgent;
    delete metadata.ownerSessionId;
    delete metadata.ownerPid;
    delete metadata.ownerRecoveryExpiresAt;
  }

  private async worktreePathExists(worktreePath: string): Promise<boolean> {
    try {
      await fs.lstat(worktreePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async create(options: ReviewWorkspaceCreateOptions): Promise<ReviewWorkspaceInfo> {
    this.assertSafeRunId(options.runId);
    if (options.repositories.length === 0) throw new Error('Review workspace requires at least one repository.');
    const repositoryIds = new Set(options.repositories.map((repository) => repository.id));
    if (repositoryIds.size !== options.repositories.length) throw new Error('Review workspace repository IDs must be unique.');
    const composite = options.composite === true;
    if (!composite && options.repositories.length !== 1) throw new Error('A multi-repository review workspace must use composite mode.');
    const lease = options.lease;
    if (!lease) throw new Error('Review workspace lease descriptor is required.');
    const selectedRepositoryIds = [...repositoryIds].sort();
    if (JSON.stringify(selectedRepositoryIds) !== JSON.stringify(lease.selectedRepositoryIds)) {
      throw new Error('Review workspace lease repositories must match materialized repositories.');
    }

    const sourceRepositories = await Promise.all(options.repositories.map((repository) => this.resolveRepository(repository)));
    const ownershipToken = randomUUID();
    const initialMetadata = this.validateMetadata(
      options.runId,
      this.createCreatingMetadata(options.runId, composite, sourceRepositories, ownershipToken, lease),
    );
    const reviewRoot = await this.ensureReviewRoot();
    const lock = await this.acquireRunLock(reviewRoot, options.runId);
    const workspacePath = this.getWorkspacePath(reviewRoot, options.runId);
    const created: Array<{ id: string; path: string }> = [];
    const repositories: Record<string, ReviewWorkspaceRepositoryInfo> = {};
    let workspaceCreated = false;
    let metadata: ReviewWorkspaceMetadata | undefined = initialMetadata;
    try {
      try {
        await fs.lstat(workspacePath);
        throw new Error(`Review workspace already exists at ${workspacePath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (await this.readMetadata(options.runId)) throw new Error(`Review workspace metadata already exists for ${options.runId}`);
      await this.writeNewMetadata(reviewRoot, metadata);

      if (composite) {
        await fs.mkdir(workspacePath);
        workspaceCreated = true;
        await fs.mkdir(path.join(workspacePath, 'repos'));
      }

      for (const repository of [...sourceRepositories].sort((left, right) => left.id.localeCompare(right.id))) {
        const targetPath = composite ? path.join(workspacePath, 'repos', repository.id) : workspacePath;
        const expectedTargetPath = composite
          ? path.resolve(workspacePath, 'repos', repository.id)
          : workspacePath;
        if (targetPath !== expectedTargetPath || (composite && path.dirname(targetPath) !== path.join(workspacePath, 'repos'))) {
          throw new Error(`Review workspace repository path escapes the workspace: ${repository.id}`);
        }
        metadata.creatingRepositoryId = repository.id;
        metadata.cleanupIdentities = {
          ...(metadata.cleanupIdentities ?? {}),
          [repository.id]: {
            sourcePath: repository.sourcePath,
            commonDir: repository.commonDir,
          },
        };
        await this.writeMetadata(reviewRoot, metadata);
        await this.addDetachedWorktree(repository.sourcePath, targetPath, repository.commit);
        created.push({ id: repository.id, path: targetPath });
        workspaceCreated = true;
        repositories[repository.id] = { path: targetPath, commit: repository.commit };
        metadata.worktreeRepositoryIds = [...new Set([...(metadata.worktreeRepositoryIds ?? []), repository.id])].sort();
        delete metadata.creatingRepositoryId;
        await this.writeMetadata(reviewRoot, metadata);
      }
      metadata.baseline = await this.captureBaseline(repositories);
      metadata.state = 'sealed';
      metadata.handoffExpiresAt = this.now + this.handoffMs;
      delete metadata.worktreeRepositoryIds;
      delete metadata.creatingRepositoryId;
      if (composite) {
        const manifest: ReviewWorkspaceManifest = {
          schemaVersion: 1,
          mode: 'review-composite',
          runId: options.runId,
          repos: Object.fromEntries(sourceRepositories.map((repository) => [
            repository.id,
            {
              path: path.posix.join('repos', repository.id),
              repoRoot: repository.sourcePath,
              repoPath: repository.sourcePath,
              branch: '',
              commit: repositories[repository.id]!.commit,
            } satisfies WorkspaceManifestEntry,
          ])),
          baseCommits: metadata.commits,
          createdAt: new Date().toISOString(),
        };
        await fs.writeFile(path.join(workspacePath, 'workspace.json'), JSON.stringify(manifest, null, 2), 'utf8');
      }
      await this.writeMetadata(reviewRoot, metadata);
      return { runId: metadata.runId, workspacePath, repositories, ownershipToken };
    } catch (error) {
      const rollbackErrors: string[] = [];
      const rollbackWorktrees = new Map(created.map((worktree) => [worktree.id, worktree]));
      if (metadata?.creatingRepositoryId) {
        const repository = sourceRepositories.find((candidate) => candidate.id === metadata!.creatingRepositoryId)!;
        rollbackWorktrees.set(repository.id, {
          id: repository.id,
          path: composite ? path.join(workspacePath, 'repos', repository.id) : workspacePath,
        });
      }
      const survivingRepositoryIds = new Set(rollbackWorktrees.keys());
      for (const worktree of [...rollbackWorktrees.values()].reverse()) {
        try {
          const identity = metadata ? this.cleanupIdentity(metadata, worktree.id) : undefined;
          if (!await this.worktreePathExists(worktree.path)) {
            if (identity) await this.removeMissingWorktreeRegistration(options.runId, worktree.path, identity);
            survivingRepositoryIds.delete(worktree.id);
            continue;
          }
          if (!identity) throw this.metadataError(options.runId);
          await this.removeContainedWorktree(options.runId, worktree.path, identity);
          survivingRepositoryIds.delete(worktree.id);
          if (metadata && survivingRepositoryIds.size > 0) {
            this.transitionToRecovery(metadata, survivingRepositoryIds);
            await this.writeMetadata(reviewRoot, metadata);
          }
        } catch (rollbackError) {
          rollbackErrors.push(`Failed to remove review worktree ${worktree.path}: ${(rollbackError as Error).message}`);
        }
      }
      if (metadata && survivingRepositoryIds.size > 0) {
        try {
          this.transitionToRecovery(metadata, survivingRepositoryIds);
          await this.writeMetadata(reviewRoot, metadata);
        } catch (recoveryError) {
          rollbackErrors.push(`Failed to persist review workspace recovery metadata: ${(recoveryError as Error).message}`);
        }
      } else if (workspaceCreated) {
        const containedWorkspace = await this.resolveContainedWorkspaceAtRoot(reviewRoot, options.runId).catch(() => null);
        if (containedWorkspace === workspacePath) {
          await fs.rm(workspacePath, { recursive: true, force: true }).catch((cleanupError) => {
            rollbackErrors.push(`Failed to remove review workspace ${workspacePath}: ${(cleanupError as Error).message}`);
          });
        }
      }
      if (survivingRepositoryIds.size === 0 && rollbackErrors.length === 0) {
        await this.getMetadataPath(reviewRoot, options.runId)
          .then((metadataPath) => fs.rm(metadataPath, { force: true }))
          .catch((cleanupError) => rollbackErrors.push(`Failed to remove review workspace metadata: ${(cleanupError as Error).message}`));
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`${(error as Error).message}; review workspace rollback failed: ${rollbackErrors.join('; ')}`);
      }
      throw error;
    } finally {
      await this.releaseRunLock(lock);
    }
  }

  async claim(
    runId: string,
    ownershipToken: string,
    caller: ReviewWorkspaceCaller,
  ): Promise<void> {
    this.assertSafeRunId(runId);
    if (caller.role !== 'primary') throw new Error('Review workspace claim requires primary capability.');
    const ownerPid = this.callerPid(caller);
    await this.withRunLock(runId, async (reviewRoot) => {
      const metadata = await this.readMetadata(runId);
      if (!metadata) throw new Error(`Review workspace not found: ${runId}`);
      if (metadata.state !== 'sealed') throw this.metadataError(runId);
      this.assertOwnershipToken(metadata, ownershipToken);
      if (metadata.workflow !== caller.workflow) throw new Error('Review workspace workflow claim was denied.');
      if (metadata.ownerSessionId) {
        if (metadata.ownerSessionId !== caller.sessionId || metadata.ownerAgent !== caller.agent) {
          throw new Error('Review workspace is already claimed by another owner.');
        }
        if (metadata.ownerRecoveryExpiresAt !== undefined && this.now >= metadata.ownerRecoveryExpiresAt) {
          throw new Error('Review workspace owner recovery lease has expired.');
        }
        if (metadata.ownerPid !== ownerPid && this.isProcessAlive(metadata.ownerPid!)) {
          throw new Error('Review workspace is already claimed by a live owner process.');
        }
      }
      await this.resolveRepositories(metadata, await this.resolveContainedWorkspaceAtRoot(reviewRoot, runId));
      metadata.ownerAgent = caller.agent;
      metadata.ownerSessionId = caller.sessionId;
      metadata.ownerPid = ownerPid;
      delete metadata.ownerRecoveryExpiresAt;
      await this.writeMetadata(reviewRoot, metadata);
    });
  }

  async releaseClaim(runId: string, ownershipToken: string, caller: ReviewWorkspaceCaller): Promise<void> {
    this.assertSafeRunId(runId);
    await this.withRunLock(runId, async (reviewRoot) => {
      const metadata = await this.readMetadata(runId);
      if (!metadata) throw new Error(`Review workspace not found: ${runId}`);
      if (metadata.state !== 'sealed') throw this.metadataError(runId);
      this.assertOwnershipToken(metadata, ownershipToken);
      this.assertOwnerCaller(metadata, caller);
      delete metadata.ownerAgent;
      delete metadata.ownerSessionId;
      delete metadata.ownerPid;
      delete metadata.ownerRecoveryExpiresAt;
      await this.writeMetadata(reviewRoot, metadata);
    });
  }

  async read(runId: string, ownershipToken: string, caller: ReviewWorkspaceCaller): Promise<ReviewWorkspaceLease> {
    this.assertSafeRunId(runId);
    return this.withRunLock(runId, async (reviewRoot) => {
      const metadata = await this.readMetadata(runId);
      if (!metadata) throw new Error(`Review workspace not found: ${runId}`);
      this.assertOwnershipToken(metadata, ownershipToken);
      if (metadata.ownerSessionId) this.assertOwnerCaller(metadata, caller);
      else this.assertCreatorCaller(metadata, caller);
      await this.resolveRepositories(metadata, await this.resolveContainedWorkspaceAtRoot(reviewRoot, runId));
      return this.lease(metadata);
    });
  }

  async inspect(runId: string, ownershipToken: string, caller: ReviewWorkspaceCaller): Promise<ReviewWorkspaceInspection> {
    this.assertSafeRunId(runId);
    return this.withRunLock(runId, async (reviewRoot) => {
      const metadata = await this.readMetadata(runId);
      if (!metadata) throw new Error(`Review workspace not found: ${runId}`);
      if (metadata.state !== 'sealed' || !metadata.baseline) throw this.metadataError(runId);
      this.assertOwnershipToken(metadata, ownershipToken);
      this.assertOwnerCaller(metadata, caller);
      const workspacePath = await this.resolveContainedWorkspaceAtRoot(reviewRoot, runId);
      const repositories = await this.resolveRepositories(metadata, workspacePath);
      const inspections: Record<string, ReviewWorkspaceRepositoryInspection> = {};
      for (const [repositoryId, repository] of Object.entries(repositories)) {
        const git = this.getGit(repository.path);
        const [status, head, unstaged, staged] = await Promise.all([
          git.raw(['status', '--porcelain=v1', '--untracked-files=all']),
          git.raw(['rev-parse', 'HEAD']),
          git.raw(['diff', '--binary', '--no-ext-diff', '--no-textconv']),
          git.raw(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--cached']),
        ]);
        const trackedChanges: string[] = [];
        const untrackedChanges: string[] = [];
        for (const line of status.split('\n').filter(Boolean)) {
          const file = line.slice(3);
          if (line.startsWith('?? ')) untrackedChanges.push(file);
          else trackedChanges.push(file);
        }
        const baseline = metadata.baseline[repositoryId]!;
        const trackedFingerprint = createHash('sha256').update(unstaged).update('\0').update(staged).digest('hex');
        const trackedDrift = baseline.head !== head.trim() || baseline.trackedFingerprint !== trackedFingerprint;
        const baselineUntrackedDrift = await this.hasBaselineUntrackedDrift(repository.path, baseline);
        inspections[repositoryId] = {
          path: repository.path,
          baselineCommit: repository.commit,
          head: head.trim(),
          commits: (await git.raw(['log', '--format=%H', `${repository.commit}..HEAD`])).split('\n').filter(Boolean),
          trackedChanges,
          untrackedChanges: untrackedChanges.filter((file) => !baseline.untracked.some((entry) => entry.path === file)),
          trackedDrift,
          baselineUntrackedDrift,
        };
      }
      return {
        runId,
        workspacePath,
        lease: this.lease(metadata),
        repositories: inspections,
        integrity: {
          trackedClean: Object.values(inspections).every((repository) => !repository.trackedDrift),
          baselineClean: Object.values(inspections).every((repository) => !repository.trackedDrift && !repository.baselineUntrackedDrift),
          untrackedFiles: Object.values(inspections).some((repository) => repository.untrackedChanges.length > 0),
        },
      };
    });
  }

  async seal(runId: string, ownershipToken: string, caller: ReviewWorkspaceCaller): Promise<void> {
    this.assertSafeRunId(runId);
    await this.withRunLock(runId, async (reviewRoot) => {
      const metadata = await this.readMetadata(runId);
      if (!metadata) throw new Error(`Review workspace not found: ${runId}`);
      if (metadata.state !== 'sealed') throw this.metadataError(runId);
      this.assertOwnershipToken(metadata, ownershipToken);
      this.assertCreatorCaller(metadata, caller);
      if (metadata.ownerSessionId) throw new Error('Claimed review workspace cannot be resealed by its creator.');
      const workspacePath = await this.resolveContainedWorkspaceAtRoot(reviewRoot, runId);
      metadata.baseline = await this.captureBaseline(await this.resolveRepositories(metadata, workspacePath));
      await this.writeMetadata(reviewRoot, metadata);
    });
  }

  private async cleanupValidated(
    reviewRoot: string,
    metadata: ReviewWorkspaceMetadata,
    workspacePath: string,
  ): Promise<ReviewWorkspaceCleanupResult> {
    let repositories: Record<string, ReviewWorkspaceRepositoryInfo>;
    try {
      repositories = await this.resolveRepositories(metadata, workspacePath, true);
    } catch (error) {
      return { runId: metadata.runId, cleaned: false, workspacePath, errors: [(error as Error).message] };
    }
    const errors: string[] = [];
    for (const [repositoryId, repository] of Object.entries(repositories)) {
      try {
        const identity = this.cleanupIdentity(metadata, repositoryId);
        if (await this.worktreePathExists(repository.path)) {
          await this.removeContainedWorktree(metadata.runId, repository.path, identity);
        } else {
          await this.removeMissingWorktreeRegistration(metadata.runId, repository.path, identity);
        }
        if (metadata.state === 'sealed') {
          metadata.removedRepositoryIds = [...new Set([...(metadata.removedRepositoryIds ?? []), repositoryId])].sort();
        } else {
          const remainingRepositoryIds = [
            ...(metadata.worktreeRepositoryIds ?? []),
            ...(metadata.creatingRepositoryId ? [metadata.creatingRepositoryId] : []),
          ].filter((id) => id !== repositoryId);
          this.transitionToRecovery(metadata, remainingRepositoryIds);
        }
        await this.writeMetadata(reviewRoot, metadata);
      } catch (error) {
        errors.push(`Failed to remove review worktree ${repository.path}: ${(error as Error).message}`);
      }
    }
    if (errors.length > 0) {
      return { runId: metadata.runId, cleaned: false, workspacePath, errors };
    }
    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
    } catch (error) {
      errors.push((error as Error).message);
    }
    if (errors.length === 0) {
      await this.getMetadataPath(reviewRoot, metadata.runId)
        .then((metadataPath) => fs.rm(metadataPath, { force: true }))
        .catch((error) => errors.push((error as Error).message));
    }
    return { runId: metadata.runId, cleaned: errors.length === 0, workspacePath, errors };
  }

  private async resolveContainedWorkspaceOrNull(reviewRoot: string, runId: string): Promise<string | null> {
    try {
      return await this.resolveContainedWorkspaceAtRoot(reviewRoot, runId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async listPrivateRunIds(reviewRoot: string, directory: string, suffix: string): Promise<string[]> {
    const directoryPath = path.join(reviewRoot, directory);
    try {
      const stat = await fs.lstat(directoryPath);
      if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(directoryPath) !== directoryPath) {
        throw new Error(`Review workspace private directory is not contained: ${directoryPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.name.endsWith(suffix))
      .map((entry) => entry.name.slice(0, -suffix.length))
      .filter(isSafeRunId);
  }

  private async listWorkspaceRunIds(reviewRoot: string): Promise<string[]> {
    const entries = await fs.readdir(reviewRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.name !== METADATA_DIRECTORY && entry.name !== LOCK_DIRECTORY && isSafeRunId(entry.name))
      .map((entry) => entry.name);
  }

  private async recoverWorkspace(
    reviewRoot: string,
    runId: string,
  ): Promise<void> {
    let lock: HeldReviewWorkspaceLock;
    try {
      lock = await this.acquireRunLock(reviewRoot, runId);
    } catch (error) {
      if ((error as Error).message.includes('busy')) return;
      throw error;
    }
    try {
      const current = await this.readMetadata(runId);
      if (!current) return;
      if (current.state === 'sealed') {
        if (current.ownerPid !== undefined) {
          if (current.ownerRecoveryExpiresAt !== undefined) {
            if (this.now < current.ownerRecoveryExpiresAt) return;
          } else {
            if (this.isProcessAlive(current.ownerPid)) return;
            current.ownerRecoveryExpiresAt = this.now + this.handoffMs;
            await this.writeMetadata(reviewRoot, current);
            return;
          }
        } else if (this.isProcessAlive(current.creatorPid) && this.now < current.handoffExpiresAt!) {
          return;
        }
      }
      const workspacePath = await this.resolveContainedWorkspaceOrNull(reviewRoot, runId) ?? this.getWorkspacePath(reviewRoot, runId);
      const result = await this.cleanupValidated(reviewRoot, current, workspacePath);
      if (!result.cleaned) {
        throw new Error(`Review workspace recovery failed for ${runId}: ${result.errors.join('; ')}`);
      }
    } finally {
      await this.releaseRunLock(lock).catch(() => undefined);
    }
  }

  async cleanup(runId: string, ownershipToken: string, caller: ReviewWorkspaceCaller): Promise<ReviewWorkspaceCleanupResult> {
    this.assertSafeRunId(runId);
    const reviewRoot = await this.inspectReviewRoot(false);
    const workspacePath = reviewRoot
      ? this.getWorkspacePath(reviewRoot, runId)
      : path.join(await this.projectRoot, '.hive', '.worktrees', 'review', runId);
    if (!reviewRoot) return { runId, cleaned: true, workspacePath, errors: [] };

    const initialMetadata = await this.readMetadata(runId);
    const initialWorkspace = await this.resolveContainedWorkspaceOrNull(reviewRoot, runId);
    if (!initialMetadata) {
      if (initialWorkspace) throw new Error(`Review workspace ${runId} exists without valid metadata; preserved.`);
      return { runId, cleaned: true, workspacePath, errors: [] };
    }

    const lock = await this.acquireRunLock(reviewRoot, runId);
    try {
      const metadata = await this.readMetadata(runId);
      const containedWorkspace = await this.resolveContainedWorkspaceOrNull(reviewRoot, runId);
      if (!metadata) {
        if (containedWorkspace) throw new Error(`Review workspace ${runId} exists without valid metadata; preserved.`);
        return { runId, cleaned: true, workspacePath, errors: [] };
      }
      this.assertOwnershipToken(metadata, ownershipToken);
      if (metadata.ownerSessionId) this.assertOwnerCaller(metadata, caller);
      else this.assertCreatorCaller(metadata, caller);
      return this.cleanupValidated(reviewRoot, metadata, containedWorkspace ?? workspacePath);
    } finally {
      await this.releaseRunLock(lock);
    }
  }

  async cleanupOwnedBySession(
    ownerSessionId: string,
    allowedWorkflows: readonly ReviewWorkspaceWorkflow[],
  ): Promise<ReviewWorkspaceCleanupResult[]> {
    if (!ownerSessionId) throw new Error('Review workspace owner session is required.');
    const allowed = new Set<ReviewWorkspaceWorkflow>(allowedWorkflows);
    const reviewRoot = await this.inspectReviewRoot(false);
    if (!reviewRoot) return [];
    const runIds = new Set([
      ...await this.listWorkspaceRunIds(reviewRoot),
      ...await this.listPrivateRunIds(reviewRoot, METADATA_DIRECTORY, '.json'),
      ...await this.listPrivateRunIds(reviewRoot, LOCK_DIRECTORY, '.lock'),
    ]);
    const results: ReviewWorkspaceCleanupResult[] = [];
    for (const runId of [...runIds].sort()) {
      const workspacePath = this.getWorkspacePath(reviewRoot, runId);
      let lock: HeldReviewWorkspaceLock | undefined;
      try {
        lock = await this.acquireRunLock(reviewRoot, runId);
        const metadata = await this.readMetadata(runId);
        if (!metadata) throw new Error(`Review workspace ${runId} exists without valid metadata; preserved.`);
        if (metadata.ownerSessionId !== ownerSessionId) {
          throw new Error(`Review workspace ${runId} belongs to another session; preserved.`);
        }
        if (!allowed.has(metadata.workflow)) {
          throw new Error(`Review workspace ${runId} belongs to a disallowed workflow; preserved.`);
        }
        const containedWorkspace = await this.resolveContainedWorkspaceOrNull(reviewRoot, runId);
        results.push(await this.cleanupValidated(reviewRoot, metadata, containedWorkspace ?? workspacePath));
      } catch (error) {
        results.push({ runId, cleaned: false, workspacePath, errors: [(error as Error).message] });
      } finally {
        if (lock) await this.releaseRunLock(lock).catch(() => undefined);
      }
    }
    return results;
  }

  async cleanupExpired(): Promise<void> {
    const reviewRoot = await this.inspectReviewRoot(false);
    if (!reviewRoot) return;
    const runIds = new Set([
      ...await this.listWorkspaceRunIds(reviewRoot),
      ...await this.listPrivateRunIds(reviewRoot, METADATA_DIRECTORY, '.json'),
      ...await this.listPrivateRunIds(reviewRoot, LOCK_DIRECTORY, '.lock'),
    ]);
    for (const runId of runIds) {
      try {
        const metadata = await this.readMetadata(runId);
        if (!metadata) throw new Error(`Review workspace ${runId} exists without valid metadata; preserved.`);
        await this.recoverWorkspace(reviewRoot, runId);
      } catch (error) {
        this.config.onSweepError?.(runId, error as Error);
      }
    }
  }
}
