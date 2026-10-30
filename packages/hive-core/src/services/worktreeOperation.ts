/**
 * Lock ownership and interrupted-mutation guards for worktree operations.
 *
 * Every task and ad-hoc worktree operation runs here. It holds a native,
 * crash-released lock on its workspace and on the Git common directory of each
 * repository it selected (workspace first, then common directories sorted), and
 * re-reads its selection under those locks before any effect.
 *
 * A native lock disappears with its owner, but a Git child the owner started can
 * outlive it, and a half-finished mutation stays half-finished. So before its
 * first workspace or Git mutation an operation durably publishes one pending
 * marker per protected resource, and clears them only when every command it ran
 * has finished with a known outcome. A later mutation that finds a marker, or a
 * lock file from a host that predates native locking, is refused before any
 * effect until an operator acknowledges the exact operation through
 * `WorktreeOperationRecoveryService`. Reads never publish markers; they report
 * what they find.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import simpleGit from 'simple-git';
import {
  describeNativeLockHolder,
  getLockAnchorDirectory,
  resolveLockAnchor,
  tryAcquireNativeLock,
  writeNativeLockDiagnostic,
} from '../utils/nativeLock.js';
import type { NativeLockOwnership } from '../utils/nativeLock.js';
import { syncDirectory, syncFile } from '../utils/paths.js';
import type { ResolvedRepository } from '../types.js';
import {
  WorktreeLinkageError,
  WorktreeOperationFinalizationError,
  WorktreeOperationRecoveryRequiredError,
  WorktreeSelectionChangedError,
} from './worktreeOutcome.js';
import type { WorktreeFinalizationFailure } from './worktreeOutcome.js';
import { assertNoSymlinkComponents, validateExactWorktreeRegistration } from './worktreeLinkage.js';
import { readWorktreeTargetIdentity } from './worktreeTarget.js';
import type { WorktreeTargetIdentity } from './worktreeTarget.js';

const WORKTREE_OPERATION_PROTOCOL = 'hive-worktree-operation/v1';
/** Namespace of operation lock resources; pre-native hosts created `<name>.lock` files here. */
const OPERATION_LOCK_NAMESPACE = '.operation-locks';
const OPERATION_MARKER_DIRECTORY = 'operations';
// The same bound the state locks have always used.
const OPERATION_LOCK_TIMEOUT_MS = 5000;
const OPERATION_LOCK_RETRY_MS = 50;
const RECORD_EXCERPT_BYTES = 4096;
/** Git state that shows a Git process may still be running or an operation was left open. */
const WORKTREE_GIT_STATE = ['MERGE_HEAD', 'SQUASH_MSG', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock', 'HEAD.lock'];
const REPOSITORY_GIT_STATE = ['packed-refs.lock'];

export type WorktreeOperationKind = 'create' | 'merge' | 'remove' | 'cleanup';

export type WorktreeOperationSubject =
  | { type: 'task'; feature: string; task: string; candidate?: string }
  | { type: 'adhoc'; runId: string }
  | { type: 'project'; feature?: string };

export interface WorktreeOperationRepositoryRecord {
  repositoryPath: string;
  commonDirectory: string;
  repoId?: string;
  sourceWorktreePath?: string;
  sourceBranch?: string;
  /** Source commit the operation pinned, when known. */
  sourceCommit?: string;
  /** Destination identity the operation was checked against, when known. */
  expectedTarget?: WorktreeTargetIdentity;
}

/** The one current pending record of an operation, written once per protected resource. */
export interface WorktreeOperationMarker {
  protocol: typeof WORKTREE_OPERATION_PROTOCOL;
  operationId: string;
  kind: WorktreeOperationKind;
  subject: WorktreeOperationSubject;
  workspacePath: string | null;
  repositories: WorktreeOperationRepositoryRecord[];
  strategy?: string;
  startedAt: string;
  /** Diagnostic only: the host process that started the operation. */
  pid: number;
}

export interface ObservedRepositoryState {
  repositoryPath: string;
  target: WorktreeTargetIdentity | null;
  targetError?: string;
  source: { worktreePath: string; present: boolean; branch: string | null; commit: string | null } | null;
  activeGitState: string[];
}

export interface ObservedWorkspaceState {
  workspacePath: string;
  present: boolean;
  activeGitState: string[];
}

/** Current state of the resources an interrupted operation guards. Observation, not permission to replay it. */
export interface WorktreeOperationObservation {
  workspace: ObservedWorkspaceState | null;
  repositories: ObservedRepositoryState[];
}

export interface PendingWorktreeOperation {
  /** The marker's operation ID, or `legacy:<name>` / `unreadable:<name>` for a lock file or marker that cannot be parsed. */
  operationId: string;
  state: 'interrupted' | 'legacy_lock' | 'unreadable_marker';
  /** Digest of every record file of this entry; recovery must present it unchanged. */
  markerDigest: string;
  marker?: WorktreeOperationMarker;
  /** Leading bytes of a legacy lock file or unreadable marker, for diagnosis. */
  record?: { path: string; excerpt: string };
  markerPaths: string[];
  observed: WorktreeOperationObservation;
  /** Digest of `observed`; recovery must present it unchanged, so it acts on what was inspected. */
  observedStateDigest: string;
  recovery: { available: true } | { available: false; reason: string };
}

interface RepositoryResource {
  repositoryPath: string;
  commonDirectory: string;
}

interface ResourceRef {
  name: string;
  workspacePath?: string;
  repository?: RepositoryResource;
}

interface OperationResources {
  workspacePath: string | null;
  repositories: RepositoryResource[];
}

export interface WorktreeOperationScope<S> {
  hiveDir: string;
  /** The workspace the operation addresses; null for project-wide cleanup. */
  workspacePath: string | null;
  /** Reads the repositories the operation may touch. Called before and again under the locks. */
  select: () => Promise<S & { repositoryPaths: string[] }>;
  /** Resolves a trusted repository's canonical Git common directory, the identity its lock protects. */
  commonDirectory: (repositoryPath: string) => Promise<string>;
  /**
   * Every repository path the project trusts. A pending record that declares a
   * repository outside this set, a workspace or source checkout outside the
   * project's worktree placements, or a checkout that is not a linked worktree
   * of its trusted repository, is reported without being observed.
   */
  trustedRepositoryPaths: () => string[];
}

export interface WorktreeMutationDetails {
  strategy?: string;
  repositories?: Array<Omit<Partial<WorktreeOperationRepositoryRecord>, 'commonDirectory'> & { repositoryPath: string }>;
}

/** Handed to a mutating operation; it calls `begin` immediately before its first workspace or Git mutation. */
export interface WorktreeMutationGuard {
  /** Durably publish the operation's pending markers. Idempotent: only the first call publishes. */
  begin(details?: WorktreeMutationDetails): Promise<void>;
  /**
   * Declare that a failure about to be thrown left a verified state (for
   * example a completed rollback), so the markers may be cleared.
   */
  markOutcomeKnown(): void;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function workspaceResourceName(workspacePath: string): string {
  return `workspace-${sha256(path.resolve(workspacePath))}`;
}

export function repositoryResourceName(commonDirectory: string): string {
  return sha256(commonDirectory);
}

function legacyLockPath(hiveDir: string, name: string): string {
  return path.join(hiveDir, OPERATION_LOCK_NAMESPACE, `${name}.lock`);
}

function markerDirectory(hiveDir: string): string {
  return path.join(getLockAnchorDirectory(hiveDir), OPERATION_MARKER_DIRECTORY);
}

function markerPath(hiveDir: string, name: string): string {
  return path.join(markerDirectory(hiveDir), `${name}.json`);
}

/** Paths an integration must not count as protected local data in a destination checkout. */
export function worktreeOperationLocalPaths(hiveDir: string): string[] {
  return [path.join(hiveDir, OPERATION_LOCK_NAMESPACE), getLockAnchorDirectory(hiveDir)];
}

export async function trustedGitCommonDirectory(repositoryPath: string, git = simpleGit(repositoryPath)): Promise<string> {
  const raw = (await git.raw(['rev-parse', '--git-common-dir'])).trim();
  if (!raw) throw new WorktreeLinkageError(`Worktree linkage preflight failed: trusted repository has no Git common directory (${repositoryPath})`);
  return fs.promises.realpath(path.isAbsolute(raw) ? raw : path.resolve(repositoryPath, raw));
}

function selectionKey(repositoryPaths: string[]): string[] {
  return [...new Set(repositoryPaths.map((repositoryPath) => path.resolve(repositoryPath)))].sort();
}

function sameEntries(left: string[], right: string[]): boolean {
  return left.join('\n') === right.join('\n');
}

function releaseAll(ownerships: NativeLockOwnership[]): void {
  let failure: unknown;
  for (const ownership of [...ownerships].reverse()) {
    try {
      ownership.release();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

async function acquireResourceLock(hiveDir: string, name: string): Promise<NativeLockOwnership> {
  const anchor = resolveLockAnchor(path.join(hiveDir, OPERATION_LOCK_NAMESPACE, name));
  const startedAt = Date.now();
  for (;;) {
    const ownership = tryAcquireNativeLock(anchor);
    if (ownership) {
      try {
        writeNativeLockDiagnostic(ownership);
      } catch (error) {
        ownership.release();
        throw error;
      }
      return ownership;
    }
    if (Date.now() - startedAt >= OPERATION_LOCK_TIMEOUT_MS) {
      throw new Error(`Failed to acquire lock ${anchor.resourcePath} after ${OPERATION_LOCK_TIMEOUT_MS}ms${describeNativeLockHolder(anchor)}. Another worktree operation is running; the operating system releases its lock when that process exits.`);
    }
    await new Promise((resolve) => setTimeout(resolve, OPERATION_LOCK_RETRY_MS));
  }
}

/** Acquire in the one global order: the workspace, then repository common directories sorted. */
async function acquireResourceLocks(hiveDir: string, resources: OperationResources): Promise<NativeLockOwnership[]> {
  const ownerships: NativeLockOwnership[] = [];
  try {
    for (const { name } of resourceRefs(resources)) ownerships.push(await acquireResourceLock(hiveDir, name));
    return ownerships;
  } catch (error) {
    try {
      releaseAll(ownerships);
    } catch {
      // Preserve the acquisition failure; a release failure leaves the lock to process exit.
    }
    throw error;
  }
}

async function repositoryResources(repositoryPaths: string[], commonDirectory: (repositoryPath: string) => Promise<string>): Promise<RepositoryResource[]> {
  return Promise.all(selectionKey(repositoryPaths).map(async (repositoryPath) => ({
    repositoryPath,
    commonDirectory: await commonDirectory(repositoryPath),
  })));
}

/**
 * Lock the operation's workspace and repositories and return the selection
 * read under those locks. A selection that names other repositories, or whose
 * paths now resolve to other common directories, is refused before any effect
 * instead of extending the lock set.
 */
async function holdOperationLocks<S>(scope: WorktreeOperationScope<S>): Promise<{
  selection: S & { repositoryPaths: string[] };
  resources: OperationResources;
  ownerships: NativeLockOwnership[];
}> {
  const ownerships: NativeLockOwnership[] = [];
  try {
    if (scope.workspacePath !== null) {
      ownerships.push(await acquireResourceLock(scope.hiveDir, workspaceResourceName(scope.workspacePath)));
    }
    const lockedPaths = selectionKey((await scope.select()).repositoryPaths);
    const locked = await repositoryResources(lockedPaths, scope.commonDirectory);
    const lockedDirectories = [...new Set(locked.map((repository) => repository.commonDirectory))].sort();
    for (const commonDirectory of lockedDirectories) {
      ownerships.push(await acquireResourceLock(scope.hiveDir, repositoryResourceName(commonDirectory)));
    }
    const selection = await scope.select();
    const currentPaths = selectionKey(selection.repositoryPaths);
    // Compare paths before running Git in them: a widened selection names repositories this operation does not hold.
    if (!sameEntries(currentPaths, lockedPaths)) {
      throw new WorktreeSelectionChangedError(
        `Worktree repository selection changed while waiting for operation locks (locked ${lockedPaths.join(', ')}; now ${currentPaths.join(', ') || 'none'}). Inspect the workspace again before retrying.`,
      );
    }
    const current = await repositoryResources(currentPaths, scope.commonDirectory);
    const currentDirectories = [...new Set(current.map((repository) => repository.commonDirectory))].sort();
    if (!sameEntries(currentDirectories, lockedDirectories)) {
      throw new WorktreeSelectionChangedError(
        `Worktree repository selection changed while waiting for operation locks (locked Git common directories ${lockedDirectories.join(', ')}; now ${currentDirectories.join(', ')}). Inspect the workspace again before retrying.`,
      );
    }
    return { selection, resources: { workspacePath: scope.workspacePath === null ? null : path.resolve(scope.workspacePath), repositories: current }, ownerships };
  } catch (error) {
    try {
      releaseAll(ownerships);
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

/** One ref per locked resource, in the global lock order: the workspace, then common directories sorted. */
function resourceRefs(resources: OperationResources): ResourceRef[] {
  const refs: ResourceRef[] = [];
  if (resources.workspacePath !== null) {
    refs.push({ name: workspaceResourceName(resources.workspacePath), workspacePath: resources.workspacePath });
  }
  const byDirectory = new Map<string, RepositoryResource>();
  for (const repository of resources.repositories) {
    if (!byDirectory.has(repository.commonDirectory)) byDirectory.set(repository.commonDirectory, repository);
  }
  for (const commonDirectory of [...byDirectory.keys()].sort()) {
    refs.push({ name: repositoryResourceName(commonDirectory), repository: byDirectory.get(commonDirectory)! });
  }
  return refs;
}

/**
 * The project's trust boundary for paths a pending record declares: its trusted
 * repositories and its worktree placements. Checking a record against it runs
 * Git only in trusted repositories.
 */
interface RecordTrust {
  hiveDir: string;
  repositoryPaths: Set<string>;
  /** Current Git common directory of a trusted repository, or null when it cannot be read. Read on first use. */
  commonDirectory: (repositoryPath: string) => Promise<string | null>;
}

function recordTrust(hiveDir: string, repositoryPaths: string[], commonDirectory: (repositoryPath: string) => Promise<string>): RecordTrust {
  const trusted = new Set<string>();
  for (const repositoryPath of repositoryPaths) {
    trusted.add(path.resolve(repositoryPath));
    try {
      trusted.add(fs.realpathSync(repositoryPath));
    } catch {
      // A trusted repository that cannot be resolved still matches by its written path.
    }
  }
  const resolved = new Map<string, Promise<string | null>>();
  return {
    hiveDir,
    repositoryPaths: trusted,
    commonDirectory: (repositoryPath) => {
      const key = path.resolve(repositoryPath);
      if (!resolved.has(key)) resolved.set(key, commonDirectory(key).catch(() => null));
      return resolved.get(key)!;
    },
  };
}

function isWorkspacePlacement(hiveDir: string, workspacePath: string): boolean {
  const relative = path.relative(path.resolve(hiveDir, '.worktrees'), path.resolve(workspacePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && relative.split(path.sep).length === 2;
}

/**
 * The worktree placement a source checkout belongs to: the placement itself for
 * a single-root workspace, or the placement holding it as `repos/<id>` for a
 * composite one. Null for any other path.
 */
function sourcePlacement(hiveDir: string, sourceWorktreePath: string): string | null {
  const source = path.resolve(sourceWorktreePath);
  if (isWorkspacePlacement(hiveDir, source)) return source;
  const parent = path.dirname(source);
  return path.basename(parent) === 'repos' && isWorkspacePlacement(hiveDir, path.dirname(parent)) ? path.dirname(parent) : null;
}

/** A branch name that resolves only inside `refs/heads/`. */
function isSafeBranchName(branch: string): boolean {
  return !/[\\\0]/.test(branch) && branch.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** A declaration a pending record makes that this project cannot trust. */
class UntrustedDeclarationError extends Error {}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  return fs.promises.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw new UntrustedDeclarationError(`path ${target} cannot be inspected: ${error.message}`);
  });
}

/** Run a linkage check, turning its refusal into an untrusted declaration about `subject`. */
async function requireLinkage(subject: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (error) {
    throw new UntrustedDeclarationError(`${subject} failed its linkage check (${(error as Error).message})`);
  }
}

/** Require `checkout` to be a registered worktree of one of the trusted common directories. */
async function requireLinkedToAny(checkout: string, commonDirectories: string[]): Promise<void> {
  let refusal = 'no trusted repository is recorded';
  for (const commonDirectory of commonDirectories) {
    try {
      await validateExactWorktreeRegistration(checkout, async () => commonDirectory, checkout);
      return;
    } catch (error) {
      refusal = (error as Error).message;
    }
  }
  throw new UntrustedDeclarationError(`checkout ${checkout} is not a linked checkout of a trusted repository (${refusal})`);
}

/** Checkouts Git may be run in to observe a record's resources, each already shown to be what the record claims. */
interface ObservationPlan {
  workspace: { workspacePath: string; present: boolean; checkouts: Array<{ label: string; cwd: string }> } | null;
  repositories: Array<{ repositoryPath: string; sourceBranch?: string; source: { worktreePath: string; linked: boolean } | null }>;
}

/**
 * Check a workspace a record names before anything in it is observed: a project
 * worktree placement with no symlinked component, whose checkouts (the
 * placement itself, or each `repos/<id>`) are registered worktrees of one of
 * `commonDirectories`. A symlinked `repos/` entry is refused, not skipped.
 */
async function planWorkspace(workspacePath: string, commonDirectories: string[], trust: RecordTrust): Promise<NonNullable<ObservationPlan['workspace']>> {
  if (!isWorkspacePlacement(trust.hiveDir, workspacePath)) {
    throw new UntrustedDeclarationError(`workspace ${workspacePath} is not a Hive worktree placement of this project`);
  }
  await requireLinkage(`workspace ${workspacePath}`, () => assertNoSymlinkComponents(path.parse(workspacePath).root, workspacePath, true));
  if (!(await lstatOrNull(workspacePath))?.isDirectory()) return { workspacePath, present: false, checkouts: [] };
  if (await lstatOrNull(path.join(workspacePath, '.git'))) {
    await requireLinkedToAny(workspacePath, commonDirectories);
    return { workspacePath, present: true, checkouts: [{ label: '.', cwd: workspacePath }] };
  }
  const reposPath = path.join(workspacePath, 'repos');
  const repos = await lstatOrNull(reposPath);
  if (repos?.isSymbolicLink()) throw new UntrustedDeclarationError(`workspace ${workspacePath} reaches its checkouts through a symlink (${reposPath})`);
  const checkouts: Array<{ label: string; cwd: string }> = [];
  for (const entry of repos?.isDirectory() ? (await fs.promises.readdir(reposPath)).sort() : []) {
    const cwd = path.join(reposPath, entry);
    const stat = await lstatOrNull(cwd);
    if (stat?.isSymbolicLink()) throw new UntrustedDeclarationError(`workspace ${workspacePath} reaches a checkout through a symlink (${cwd})`);
    if (!stat?.isDirectory() || !(await lstatOrNull(path.join(cwd, '.git')))) continue;
    await requireLinkedToAny(cwd, commonDirectories);
    checkouts.push({ label: `repos/${entry}`, cwd });
  }
  return { workspacePath, present: true, checkouts };
}

/**
 * Refuse a declared path the operating system could resolve differently from
 * its lexical form. The checks below compare normalized paths, but a working
 * directory such as `<checkout>/link/..` follows `link` before `..`. Markers
 * are written with resolved paths, so only a rewritten one fails this.
 */
function requireCanonicalPath(label: string, value: unknown): void {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new UntrustedDeclarationError(`${label} ${JSON.stringify(value)} is not a canonical absolute path`);
  }
}

/**
 * Check every path a marker declares before anything it names is read. Each
 * must be canonical and absolute. Its repositories must be trusted. Each source
 * checkout must belong to a project worktree placement (the marker's workspace
 * when it names one; any placement for project-wide cleanup, which names
 * none), have no symlinked component, and, when present, be a registered
 * worktree of its own repository.
 */
async function planMarkerObservation(marker: WorktreeOperationMarker, trust: RecordTrust): Promise<ObservationPlan> {
  if (marker.workspacePath !== null) requireCanonicalPath('workspace', marker.workspacePath);
  for (const repository of marker.repositories) {
    requireCanonicalPath('repository', repository.repositoryPath);
    if (repository.sourceWorktreePath !== undefined) requireCanonicalPath('source checkout', repository.sourceWorktreePath);
  }
  const repositories: ObservationPlan['repositories'] = [];
  for (const repository of marker.repositories) {
    if (!trust.repositoryPaths.has(path.resolve(repository.repositoryPath))) {
      throw new UntrustedDeclarationError(`repository ${repository.repositoryPath} is not a trusted repository of this project`);
    }
    const { sourceWorktreePath, sourceBranch } = repository;
    if (sourceBranch !== undefined && (typeof sourceBranch !== 'string' || !isSafeBranchName(sourceBranch))) {
      throw new UntrustedDeclarationError(`source branch ${JSON.stringify(sourceBranch)} is not a branch name`);
    }
    let source: ObservationPlan['repositories'][number]['source'] = null;
    if (sourceWorktreePath !== undefined) {
      const placement = sourcePlacement(trust.hiveDir, sourceWorktreePath);
      if (placement === null || (marker.workspacePath !== null && placement !== path.resolve(marker.workspacePath))) {
        throw new UntrustedDeclarationError(`source checkout ${String(sourceWorktreePath)} is not a checkout of ${marker.workspacePath === null ? 'a Hive worktree placement of this project' : "the operation's workspace"}`);
      }
      const commonDirectory = await trust.commonDirectory(repository.repositoryPath);
      if (commonDirectory === null) throw new UntrustedDeclarationError(`repository ${repository.repositoryPath} has no readable Git common directory, so source checkout ${sourceWorktreePath} cannot be checked`);
      await requireLinkage(`source checkout ${sourceWorktreePath}`, () => assertNoSymlinkComponents(path.parse(sourceWorktreePath).root, sourceWorktreePath, true));
      const linked = (await lstatOrNull(path.join(sourceWorktreePath, '.git'))) !== null;
      if (linked) {
        await requireLinkage(`source checkout ${sourceWorktreePath}`, () => validateExactWorktreeRegistration(sourceWorktreePath, async () => commonDirectory, repository.repoId ?? repository.repositoryPath));
      }
      source = { worktreePath: sourceWorktreePath, linked };
    }
    repositories.push({ repositoryPath: repository.repositoryPath, ...(sourceBranch !== undefined ? { sourceBranch } : {}), source });
  }
  const commonDirectories = (await Promise.all(marker.repositories.map((repository) => trust.commonDirectory(repository.repositoryPath))))
    .filter((directory): directory is string => directory !== null);
  return {
    workspace: marker.workspacePath === null ? null : await planWorkspace(marker.workspacePath, commonDirectories, trust),
    repositories,
  };
}

/** Plan an observation, or return why the record cannot be trusted. Never throws for an untrusted declaration. */
async function planOrRefusal(plan: () => Promise<ObservationPlan>): Promise<ObservationPlan | { untrusted: string }> {
  try {
    return await plan();
  } catch (error) {
    if (error instanceof UntrustedDeclarationError) return { untrusted: error.message };
    throw error;
  }
}

function readOptional(filePath: string): Buffer | null {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseMarker(bytes: Buffer): WorktreeOperationMarker | null {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as WorktreeOperationMarker;
    if (value?.protocol !== WORKTREE_OPERATION_PROTOCOL || typeof value.operationId !== 'string' || !value.operationId
      || !Array.isArray(value.repositories) || (value.workspacePath !== null && typeof value.workspacePath !== 'string')
      || value.repositories.some((repository) => typeof repository?.repositoryPath !== 'string' || typeof repository.commonDirectory !== 'string')) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

interface MarkerFile {
  name: string;
  path: string;
  bytes: Buffer;
  marker: WorktreeOperationMarker | null;
}

function readMarkerFiles(hiveDir: string): MarkerFile[] {
  const directory = markerDirectory(hiveDir);
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((entry) => entry.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.flatMap((entry) => {
    const filePath = path.join(directory, entry);
    const bytes = readOptional(filePath);
    return bytes === null ? [] : [{ name: entry.slice(0, -'.json'.length), path: filePath, bytes, marker: parseMarker(bytes) }];
  });
}

function recordDigest(files: Array<{ path: string; bytes: Buffer }>): string {
  return sha256([...files].sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${sha256(file.bytes)}`).join('\n'));
}

function excerpt(bytes: Buffer): string {
  return bytes.subarray(0, RECORD_EXCERPT_BYTES).toString('utf8');
}

async function gitStatePresent(cwd: string, names: string[]): Promise<string[]> {
  const output = await simpleGit(cwd).raw(['rev-parse', ...names.flatMap((name) => ['--git-path', name])]);
  const resolved = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const present: string[] = [];
  names.forEach((name, index) => {
    const statePath = resolved[index];
    if (statePath && fs.existsSync(path.isAbsolute(statePath) ? statePath : path.join(cwd, statePath))) present.push(name);
  });
  return present;
}

function isDirectory(target: string): boolean {
  try {
    return fs.lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

async function observeWorkspace(plan: NonNullable<ObservationPlan['workspace']>): Promise<ObservedWorkspaceState> {
  const { workspacePath } = plan;
  if (!plan.present) return { workspacePath, present: false, activeGitState: [] };
  const activeGitState: string[] = [];
  for (const checkout of plan.checkouts) {
    try {
      for (const name of await gitStatePresent(checkout.cwd, WORKTREE_GIT_STATE)) activeGitState.push(`${checkout.label}:${name}`);
    } catch (error) {
      activeGitState.push(`${checkout.label}:unreadable (${(error as Error).message.split('\n')[0]})`);
    }
  }
  return { workspacePath, present: true, activeGitState: activeGitState.sort() };
}

async function observeRepository(record: ObservationPlan['repositories'][number]): Promise<ObservedRepositoryState> {
  const activeGitState: string[] = [];
  let target: WorktreeTargetIdentity | null = null;
  let targetError: string | undefined;
  try {
    target = await readWorktreeTargetIdentity(record.repositoryPath);
  } catch (error) {
    targetError = (error as Error).message;
  }
  try {
    const repositoryState = [...WORKTREE_GIT_STATE, ...REPOSITORY_GIT_STATE, ...(record.sourceBranch ? [`refs/heads/${record.sourceBranch}.lock`] : [])];
    for (const name of await gitStatePresent(record.repositoryPath, repositoryState)) activeGitState.push(`repository:${name}`);
  } catch (error) {
    activeGitState.push(`repository:unreadable (${(error as Error).message.split('\n')[0]})`);
  }
  let source: ObservedRepositoryState['source'] = null;
  if (record.source) {
    const { worktreePath, linked } = record.source;
    let branch: string | null = null;
    let commit: string | null = null;
    if (linked) {
      try {
        const git = simpleGit(worktreePath);
        commit = (await git.revparse(['HEAD'])).trim();
        branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
        for (const name of await gitStatePresent(worktreePath, WORKTREE_GIT_STATE)) activeGitState.push(`source:${name}`);
      } catch (error) {
        activeGitState.push(`source:unreadable (${(error as Error).message.split('\n')[0]})`);
      }
    }
    source = { worktreePath, present: linked, branch, commit };
  }
  return { repositoryPath: record.repositoryPath, target, ...(targetError !== undefined ? { targetError } : {}), source, activeGitState: activeGitState.sort() };
}

/** Observe only what a plan has already checked. */
async function observeResources(plan: ObservationPlan): Promise<WorktreeOperationObservation> {
  const observedRepositories: ObservedRepositoryState[] = [];
  for (const repository of [...plan.repositories].sort((left, right) => left.repositoryPath.localeCompare(right.repositoryPath))) {
    observedRepositories.push(await observeRepository(repository));
  }
  return { workspace: plan.workspace === null ? null : await observeWorkspace(plan.workspace), repositories: observedRepositories };
}

const UNOBSERVED: WorktreeOperationObservation = { workspace: null, repositories: [] };

function observationDigest(observation: WorktreeOperationObservation): string {
  return sha256(JSON.stringify(observation));
}

/**
 * Describe the interrupted operations and legacy lock files guarding the named
 * resources. `resolve` maps a resource name to the resource it locks when the
 * caller can establish it; a record whose resource cannot be established is
 * reported but cannot be recovered. A record that names a path outside
 * `trust`, or a checkout a symlink or `.git` pointer redirects, is reported
 * unobserved and cannot be recovered either: the record is untrusted data, so
 * Git never runs in, and nothing is read through, a path it names until that
 * path is shown to be the project's own.
 */
async function describeGuards(hiveDir: string, names: string[], resolve: Map<string, ResourceRef>, trust: RecordTrust): Promise<PendingWorktreeOperation[]> {
  const wanted = new Set(names);
  const allMarkers = readMarkerFiles(hiveDir);
  const entries: PendingWorktreeOperation[] = [];
  const seenOperations = new Set<string>();

  for (const file of allMarkers.filter((candidate) => wanted.has(candidate.name))) {
    if (file.marker) {
      const operationId = file.marker.operationId;
      if (seenOperations.has(operationId)) continue;
      seenOperations.add(operationId);
      const files = allMarkers.filter((candidate) => candidate.marker?.operationId === operationId);
      const marker = file.marker;
      const plan = await planOrRefusal(() => planMarkerObservation(marker, trust));
      const observed = 'untrusted' in plan ? UNOBSERVED : await observeResources(plan);
      entries.push({
        operationId,
        state: 'interrupted',
        markerDigest: recordDigest(files),
        marker,
        markerPaths: files.map((candidate) => candidate.path),
        observed,
        observedStateDigest: observationDigest(observed),
        recovery: 'untrusted' in plan
          ? { available: false, reason: `The record was not observed and cannot be acknowledged here: its ${plan.untrusted}. It is preserved for manual inspection.` }
          : { available: true },
      });
      continue;
    }
    entries.push(await describeUnownedRecord(`unreadable:${file.name}`, 'unreadable_marker', file.path, file.bytes, resolve.get(file.name), trust));
  }

  for (const name of names) {
    const lockPath = legacyLockPath(hiveDir, name);
    const bytes = readOptional(lockPath);
    if (bytes !== null) entries.push(await describeUnownedRecord(`legacy:${name}`, 'legacy_lock', lockPath, bytes, resolve.get(name), trust));
  }
  return entries;
}

async function describeUnownedRecord(
  operationId: string,
  state: 'legacy_lock' | 'unreadable_marker',
  recordPath: string,
  bytes: Buffer,
  resource: ResourceRef | undefined,
  trust: RecordTrust,
): Promise<PendingWorktreeOperation> {
  // A workspace this record locks may hold checkouts of any trusted repository.
  const plan = resource && await planOrRefusal(async () => ({
    workspace: resource.workspacePath === undefined
      ? null
      : await planWorkspace(resource.workspacePath, (await Promise.all([...trust.repositoryPaths].map(trust.commonDirectory))).filter((directory): directory is string => directory !== null), trust),
    repositories: resource.repository ? [{ repositoryPath: resource.repository.repositoryPath, source: null }] : [],
  }));
  const observed = plan && !('untrusted' in plan) ? await observeResources(plan) : UNOBSERVED;
  let recovery: PendingWorktreeOperation['recovery'] = { available: true };
  if (!plan) recovery = { available: false, reason: 'The workspace or repository this record locks cannot be identified from the current project; it is preserved for manual inspection.' };
  else if ('untrusted' in plan) recovery = { available: false, reason: `The record was not observed and cannot be acknowledged here: its ${plan.untrusted}. It is preserved for manual inspection.` };
  return {
    operationId,
    state,
    markerDigest: recordDigest([{ path: recordPath, bytes }]),
    record: { path: recordPath, excerpt: excerpt(bytes) },
    markerPaths: [recordPath],
    observed,
    observedStateDigest: observationDigest(observed),
    recovery,
  };
}

function refusalMessage(guards: PendingWorktreeOperation[]): string {
  const described = guards.map((guard) => guard.marker
    ? `${guard.operationId} (${guard.marker.kind} started ${guard.marker.startedAt} by pid ${guard.marker.pid})`
    : `${guard.operationId} (${guard.record?.path})`);
  return `Worktree mutation refused before any effect: an interrupted operation or a lock file from a Hive host that predates native locking still guards its resources: ${described.join('; ')}. Its Git work may still be running or half-finished. Inspect the worktree, confirm every process of that operation has stopped, then acknowledge the exact operation through Hive worktree recovery.`;
}

/** Describe the pending records that guard an operation's own resources, judged against the project's trust boundary. */
function describeOperationGuards<S>(scope: WorktreeOperationScope<S>, resources: OperationResources): Promise<PendingWorktreeOperation[]> {
  const refs = resourceRefs(resources);
  return describeGuards(scope.hiveDir, refs.map((ref) => ref.name), new Map(refs.map((ref) => [ref.name, ref])), recordTrust(scope.hiveDir, scope.trustedRepositoryPaths(), scope.commonDirectory));
}

/** Run a read under the operation locks. It publishes nothing and reports any interrupted operation it finds. */
export async function withWorktreeRead<S, T>(
  scope: WorktreeOperationScope<S>,
  read: (selection: S & { repositoryPaths: string[] }, pending: PendingWorktreeOperation[]) => Promise<T>,
): Promise<T> {
  const { selection, resources, ownerships } = await holdOperationLocks(scope);
  let result: T;
  try {
    result = await read(selection, await describeOperationGuards(scope, resources));
  } catch (error) {
    try {
      releaseAll(ownerships);
    } catch {
      // Preserve the read failure.
    }
    throw error;
  }
  releaseAll(ownerships);
  return result;
}

/** What a guarded mutation produced, and what became of its pending markers. */
interface GuardedOutcome<T> {
  outcome: { result: T } | { error: unknown };
  operationId: string;
  markers: WorktreeFinalizationFailure['markers'];
  /** With `retained`: the marker files still present. */
  retainedMarkers?: string[];
  markerError?: string;
}

/**
 * Run a mutation under the operation locks and the pending-marker guard.
 *
 * The mutation calls `guard.begin()` before its first effect. Markers are
 * cleared when it returns a result `outcomeKnown` accepts, or throws after
 * `guard.markOutcomeKnown()`. Otherwise they are retained, and a thrown failure
 * becomes a non-retryable WorktreeOperationRecoveryRequiredError.
 *
 * A thrown failure keeps its own classification even when releasing the locks
 * then fails. When the mutation returned a result but its markers could not all
 * be removed, their removal could not be flushed, or its locks could not be
 * released, the result is not discarded: a WorktreeOperationFinalizationError
 * carries it unchanged with the failure, naming exactly the markers that remain.
 */
export async function withWorktreeMutation<S, T>(
  scope: WorktreeOperationScope<S> & { kind: WorktreeOperationKind; subject: WorktreeOperationSubject },
  mutate: (selection: S & { repositoryPaths: string[] }, guard: WorktreeMutationGuard) => Promise<T>,
  outcomeKnown: (result: T) => boolean = () => true,
): Promise<T> {
  const { selection, resources, ownerships } = await holdOperationLocks(scope);
  let guarded: Pick<GuardedOutcome<T>, 'outcome'> & Partial<GuardedOutcome<T>>;
  try {
    const guards = await describeOperationGuards(scope, resources);
    if (guards.length > 0) {
      throw new WorktreeOperationRecoveryRequiredError(refusalMessage(guards), {
        mutation: 'none',
        operationIds: guards.map((guard) => guard.operationId),
      });
    }
    guarded = await runGuarded(scope, resources, selection, mutate, outcomeKnown);
  } catch (error) {
    guarded = { outcome: { error } };
  }
  let lockReleaseError: unknown;
  try {
    releaseAll(ownerships);
  } catch (releaseError) {
    lockReleaseError = releaseError;
  }
  const { outcome } = guarded;
  if ('error' in outcome) throw outcome.error;
  if (guarded.markerError === undefined && lockReleaseError === undefined) return outcome.result;

  const markers = guarded.markers ?? 'not_published';
  const named = markers === 'retained' || markers === 'cleared_unflushed';
  const finalization: WorktreeFinalizationFailure = {
    ...(named ? { operationId: guarded.operationId } : {}),
    markers,
    ...(markers === 'retained' ? { retainedMarkers: guarded.retainedMarkers ?? [] } : {}),
    ...(guarded.markerError !== undefined ? { markerError: guarded.markerError } : {}),
    ...(lockReleaseError !== undefined ? { lockReleaseError: describeError(lockReleaseError) } : {}),
    action: markers === 'retained' ? 'manual_recovery' : 'inspect_state',
  };
  const failures = [
    ...(markers === 'retained' && finalization.markerError !== undefined ? [`its pending markers ${finalization.retainedMarkers!.join(', ')} could not be removed (${finalization.markerError}), so later mutations of the resources they guard stay refused until the operation is acknowledged through Hive worktree recovery`] : []),
    ...(markers === 'cleared_unflushed' ? [`flushing the removal of its pending markers failed (${finalization.markerError}): no marker guards these resources now, but the removal may not survive a host crash`] : []),
    ...(finalization.lockReleaseError !== undefined ? [`releasing its operation locks failed (${finalization.lockReleaseError}); the operating system releases them when this process exits`] : []),
  ];
  const subject = named ? `Worktree ${scope.kind} operation ${guarded.operationId}` : `Worktree ${scope.kind} operation`;
  throw new WorktreeOperationFinalizationError(
    `${subject} returned its result, but ${failures.join(', and ')}. The result stands and nothing was rolled back.`,
    outcome.result,
    finalization,
    lockReleaseError !== undefined ? { cause: lockReleaseError } : undefined,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runGuarded<S, T>(
  scope: WorktreeOperationScope<S> & { kind: WorktreeOperationKind; subject: WorktreeOperationSubject },
  resources: OperationResources,
  selection: S & { repositoryPaths: string[] },
  mutate: (selection: S & { repositoryPaths: string[] }, guard: WorktreeMutationGuard) => Promise<T>,
  outcomeKnown: (result: T) => boolean,
): Promise<GuardedOutcome<T>> {
  const operationId = randomUUID();
  const paths = resourceRefs(resources).map((ref) => markerPath(scope.hiveDir, ref.name));
  let published = false;
  let declaredKnown = false;
  const guard: WorktreeMutationGuard = {
    async begin(details = {}) {
      if (published) return;
      const marker = buildMarker(operationId, scope, resources, details);
      const written: string[] = [];
      try {
        publishMarkers(paths, marker, written);
      } catch (error) {
        // Only a marker that is still present needs acknowledging; a withdrawal whose flush failed leaves none.
        const rollback = clearMarkers(written);
        if (rollback.remaining.length > 0) {
          throw new WorktreeOperationRecoveryRequiredError(
            `Worktree operation ${operationId} could not publish its pending markers (${(error as Error).message}) and could not withdraw ${rollback.remaining.join(', ')} (${removalError(rollback)}). No mutation ran; acknowledge the operation through Hive worktree recovery after inspection.`,
            { mutation: 'none', operationIds: [operationId], cause: error },
          );
        }
        throw error;
      }
      published = true;
    },
    markOutcomeKnown() {
      declaredKnown = true;
    },
  };

  let outcome: { result: T } | { error: unknown };
  try {
    outcome = { result: await mutate(selection, guard) };
  } catch (error) {
    outcome = { error };
  }
  if (!published) return { outcome, operationId, markers: 'not_published' };

  const known = 'result' in outcome ? outcomeKnown(outcome.result) || declaredKnown : declaredKnown;
  if (!known) {
    const retainedMarkers = [...paths].sort();
    if ('result' in outcome) return { outcome, operationId, markers: 'retained', retainedMarkers };
    const cause = outcome.error;
    return {
      outcome: {
        error: new WorktreeOperationRecoveryRequiredError(
          `Worktree operation ${operationId} (${scope.kind}) failed after it began mutating, so its outcome is unknown and its pending markers were retained: ${describeError(cause)}`,
          { mutation: 'unknown', operationIds: [operationId], cause },
        ),
      },
      operationId,
      markers: 'retained',
      retainedMarkers,
    };
  }
  const removal = clearMarkers(paths);
  if (removal.remaining.length === 0) {
    // Nothing guards the resources now. A returned result reports a flush failure;
    // a thrown failure keeps its own classification, because no operation is left to acknowledge.
    return removal.flushError === undefined
      ? { outcome, operationId, markers: 'cleared' }
      : { outcome, operationId, markers: 'cleared_unflushed', markerError: removal.flushError };
  }
  const markerError = removalError(removal);
  if ('result' in outcome) return { outcome, operationId, markers: 'retained', retainedMarkers: removal.remaining, markerError };
  return {
    outcome: {
      error: new WorktreeOperationRecoveryRequiredError(
        `Worktree operation ${operationId} (${scope.kind}) failed after a verified outcome, but its pending markers ${removal.remaining.join(', ')} could not be removed (${markerError}); later mutations of the resources they guard stay refused. Inspect the worktree, then acknowledge the operation through Hive worktree recovery.`,
        { mutation: 'unknown', operationIds: [operationId], cause: outcome.error },
      ),
    },
    operationId,
    markers: 'retained',
    retainedMarkers: removal.remaining,
    markerError,
  };
}

function buildMarker(
  operationId: string,
  scope: { kind: WorktreeOperationKind; subject: WorktreeOperationSubject },
  resources: OperationResources,
  details: WorktreeMutationDetails,
): WorktreeOperationMarker {
  const detailFor = (repositoryPath: string) => details.repositories?.find((candidate) => path.resolve(candidate.repositoryPath) === repositoryPath);
  return {
    protocol: WORKTREE_OPERATION_PROTOCOL,
    operationId,
    kind: scope.kind,
    subject: scope.subject,
    workspacePath: resources.workspacePath,
    repositories: resources.repositories.map((repository) => {
      const { repositoryPath: _ignored, ...detail } = detailFor(repository.repositoryPath) ?? { repositoryPath: repository.repositoryPath };
      return {
        ...detail,
        // Written resolved, like the workspace and repository paths, so that observation accepts it.
        ...(detail.sourceWorktreePath !== undefined ? { sourceWorktreePath: path.resolve(detail.sourceWorktreePath) } : {}),
        repositoryPath: repository.repositoryPath,
        commonDirectory: repository.commonDirectory,
      };
    }),
    ...(details.strategy !== undefined ? { strategy: details.strategy } : {}),
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
}

/**
 * Publish one marker per resource: every file is flushed before any becomes
 * visible, and the directory is flushed once after all are renamed into place.
 * `written` collects the published paths so a failure can withdraw them.
 */
function publishMarkers(paths: string[], marker: WorktreeOperationMarker, written: string[]): void {
  if (paths.length === 0) return;
  const directory = path.dirname(paths[0]!);
  fs.mkdirSync(directory, { recursive: true });
  const content = JSON.stringify(marker, null, 2);
  const staged = paths.map((filePath, index) => ({ filePath, tempPath: `${filePath}.tmp.${process.pid}.${index}` }));
  try {
    for (const { tempPath } of staged) {
      fs.writeFileSync(tempPath, content);
      syncFile(tempPath);
    }
    for (const { filePath, tempPath } of staged) {
      fs.renameSync(tempPath, filePath);
      written.push(filePath);
    }
    syncDirectory(directory);
  } finally {
    for (const { tempPath } of staged) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Already renamed into place.
      }
    }
  }
}

/**
 * What unlinking marker files established. A file in `remaining` still guards
 * its resource. A `flushError` alone means every file is gone now, but the
 * directory flush that makes their removal survive a host crash failed; it says
 * nothing about whether a file is present.
 */
interface MarkerRemoval {
  /** Files still present after the attempt, sorted. */
  remaining: string[];
  /** Why files could not be unlinked. */
  unlinkError?: string;
  flushError?: string;
}

/** Unlink marker files, then flush their directory once when any was removed. */
function clearMarkers(paths: string[]): MarkerRemoval {
  const remaining: string[] = [];
  const failures: string[] = [];
  for (const filePath of paths) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      failures.push(`${filePath}: ${(error as Error).message}`);
      if (stillPresent(filePath)) remaining.push(filePath);
    }
  }
  const removal: MarkerRemoval = { remaining: remaining.sort(), ...(failures.length > 0 ? { unlinkError: failures.join('; ') } : {}) };
  if (remaining.length < paths.length) {
    const directory = path.dirname(paths[0]!);
    try {
      syncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') removal.flushError = `flush ${directory}: ${(error as Error).message}`;
    }
  }
  return removal;
}

/** Whether a file whose unlink failed is still there. One that cannot be checked counts as present, since it may still guard. */
function stillPresent(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function removalError(removal: MarkerRemoval): string {
  return [removal.unlinkError, removal.flushError].filter((failure) => failure !== undefined).join('; ');
}

export type WorktreeRecoveryRefusalReason =
  | 'attestation_required'
  | 'operation_not_found'
  | 'recovery_unavailable'
  | 'resource_untrusted'
  | 'marker_changed'
  | 'observed_state_changed'
  | 'git_operation_active';

/** A recovery request that was refused before any marker was cleared. */
export class WorktreeRecoveryRefusedError extends Error {
  readonly reason: WorktreeRecoveryRefusalReason;
  readonly current: PendingWorktreeOperation | null;

  constructor(reason: WorktreeRecoveryRefusalReason, message: string, current: PendingWorktreeOperation | null = null) {
    super(message);
    this.name = 'WorktreeRecoveryRefusedError';
    this.reason = reason;
    this.current = current;
  }
}

export interface WorktreeRecoveryRequest {
  operationId: string;
  /** `markerDigest` from the inspection the caller acted on. */
  markerDigest: string;
  /** `observedStateDigest` from the same inspection. */
  observedStateDigest: string;
  /** The caller attests that no process of the interrupted operation is still running. */
  mutatorsStopped: boolean;
  /** Absolute foreign checkout an ad-hoc run used, so its repository is trusted for this request. */
  sourceDirectory?: string;
}

export interface WorktreeRecoveryResult {
  operationId: string;
  state: PendingWorktreeOperation['state'];
  /** Record files removed. Nothing else was changed; the interrupted operation was not run or retried. */
  cleared: string[];
  replayed: false;
}

export interface WorktreeOperationRecoveryConfig {
  baseDir: string;
  hiveDir: string;
  repositoryResolver?: { resolveRepositories(): ResolvedRepository[] } | (() => ResolvedRepository[]);
}

/**
 * Lists interrupted worktree operations and acknowledges one exact operation
 * after the operator confirms its processes stopped. Acknowledging clears that
 * operation's records and nothing else; it never runs or retries Git work.
 */
export class WorktreeOperationRecoveryService {
  private readonly config: WorktreeOperationRecoveryConfig;

  constructor(config: WorktreeOperationRecoveryConfig) {
    this.config = config;
  }

  private trustedRepositoryPaths(sourceDirectory?: string): string[] {
    const resolver = this.config.repositoryResolver;
    const resolved = resolver ? (typeof resolver === 'function' ? resolver() : resolver.resolveRepositories()) : [];
    const paths = [this.config.baseDir, ...resolved.map((repository) => repository.path)];
    if (sourceDirectory !== undefined) {
      if (!path.isAbsolute(sourceDirectory)) throw new Error('sourceDirectory must be absolute');
      paths.push(fs.realpathSync(sourceDirectory));
    }
    return selectionKey(paths);
  }

  private worktreesRoot(): string {
    return path.join(this.config.hiveDir, '.worktrees');
  }

  /** Resources this project can currently identify, keyed by lock resource name. */
  private async candidateResources(trustedRepositoryPaths: string[]): Promise<Map<string, ResourceRef>> {
    const refs = new Map<string, ResourceRef>();
    for (const repositoryPath of trustedRepositoryPaths) {
      try {
        const commonDirectory = await trustedGitCommonDirectory(repositoryPath);
        const name = repositoryResourceName(commonDirectory);
        if (!refs.has(name)) refs.set(name, { name, repository: { repositoryPath, commonDirectory } });
      } catch {
        // A repository that cannot be read cannot be identified; its records stay unrecoverable.
      }
    }
    const root = this.worktreesRoot();
    for (const group of isDirectory(root) ? fs.readdirSync(root) : []) {
      const groupPath = path.join(root, group);
      if (!isDirectory(groupPath)) continue;
      for (const entry of fs.readdirSync(groupPath)) {
        const workspacePath = path.join(groupPath, entry);
        if (!isDirectory(workspacePath)) continue;
        const name = workspaceResourceName(workspacePath);
        refs.set(name, { name, workspacePath: path.resolve(workspacePath) });
      }
    }
    return refs;
  }

  /** One reading of the project's records, judged against one trust boundary and one candidate discovery. */
  private async snapshot(sourceDirectory?: string): Promise<{ entries: PendingWorktreeOperation[]; candidates: Map<string, ResourceRef> }> {
    const trustedPaths = this.trustedRepositoryPaths(sourceDirectory);
    const candidates = await this.candidateResources(trustedPaths);
    const names = new Set(readMarkerFiles(this.config.hiveDir).map((file) => file.name));
    const legacyDirectory = path.join(this.config.hiveDir, OPERATION_LOCK_NAMESPACE);
    for (const entry of isDirectory(legacyDirectory) ? fs.readdirSync(legacyDirectory) : []) {
      if (entry.endsWith('.lock')) names.add(entry.slice(0, -'.lock'.length));
    }
    const entries = await describeGuards(this.config.hiveDir, [...names].sort(), candidates, recordTrust(this.config.hiveDir, trustedPaths, (repositoryPath) => trustedGitCommonDirectory(repositoryPath)));
    return { entries, candidates };
  }

  /** Every interrupted operation, unreadable marker, and legacy operation lock file in the project. */
  async list(options: { sourceDirectory?: string } = {}): Promise<PendingWorktreeOperation[]> {
    return (await this.snapshot(options.sourceDirectory)).entries;
  }

  /**
   * The resources one recoverable entry guards, checked against the current
   * project: each recorded repository still resolves to the recorded Git common
   * directory, and each record file belongs to those resources. A marker that
   * declares an untrusted path was never observed and is refused here.
   */
  private async validatedResources(entry: PendingWorktreeOperation, candidates: Map<string, ResourceRef>): Promise<OperationResources> {
    if ('reason' in entry.recovery) {
      throw new WorktreeRecoveryRefusedError(entry.marker ? 'resource_untrusted' : 'recovery_unavailable', entry.recovery.reason, entry);
    }
    if (entry.marker) {
      const marker = entry.marker;
      for (const repository of marker.repositories) {
        let current: string;
        try {
          current = await trustedGitCommonDirectory(repository.repositoryPath);
        } catch (error) {
          throw new WorktreeRecoveryRefusedError('resource_untrusted', `Repository ${repository.repositoryPath} cannot be read: ${(error as Error).message}`, entry);
        }
        if (current !== repository.commonDirectory) {
          throw new WorktreeRecoveryRefusedError('resource_untrusted', `Repository ${repository.repositoryPath} now resolves to Git common directory ${current}, not ${repository.commonDirectory}.`, entry);
        }
      }
      const resources = { workspacePath: marker.workspacePath, repositories: marker.repositories.map(({ repositoryPath, commonDirectory }) => ({ repositoryPath, commonDirectory })) };
      const derived = new Set(resourceRefs(resources).map((ref) => markerPath(this.config.hiveDir, ref.name)));
      const stray = entry.markerPaths.filter((markerFile) => !derived.has(markerFile));
      if (stray.length > 0) {
        throw new WorktreeRecoveryRefusedError('resource_untrusted', `Marker files ${stray.join(', ')} do not belong to the resources the operation records.`, entry);
      }
      return resources;
    }
    const name = entry.operationId.slice(entry.operationId.indexOf(':') + 1);
    const ref = candidates.get(name);
    if (!ref) throw new WorktreeRecoveryRefusedError('recovery_unavailable', 'The record no longer maps to a current resource.', entry);
    return { workspacePath: ref.workspacePath ?? null, repositories: ref.repository ? [ref.repository] : [] };
  }

  async recover(request: WorktreeRecoveryRequest): Promise<WorktreeRecoveryResult> {
    if (request.mutatorsStopped !== true) {
      throw new WorktreeRecoveryRefusedError('attestation_required', 'Recovery requires mutatorsStopped: true after confirming that no process of the interrupted operation, including a Git child it started, is still running.');
    }
    const find = async (): Promise<{ entry: PendingWorktreeOperation; candidates: Map<string, ResourceRef> }> => {
      const { entries, candidates } = await this.snapshot(request.sourceDirectory);
      const entry = entries.find((candidate) => candidate.operationId === request.operationId);
      if (!entry) throw new WorktreeRecoveryRefusedError('operation_not_found', `No interrupted worktree operation or lock record ${request.operationId} is present.`);
      return { entry, candidates };
    };

    const first = await find();
    const resources = await this.validatedResources(first.entry, first.candidates);
    const ownerships = await acquireResourceLocks(this.config.hiveDir, resources);
    try {
      const { entry, candidates } = await find();
      if (entry.markerDigest !== request.markerDigest) {
        throw new WorktreeRecoveryRefusedError('marker_changed', 'The operation records changed since they were inspected. Inspect again.', entry);
      }
      // A checkout replaced at the same path can keep its observed state and still resolve to another repository.
      const current = await this.validatedResources(entry, candidates);
      if (!sameResources(current, resources)) {
        throw new WorktreeRecoveryRefusedError('resource_untrusted', 'The resources this record guards changed while recovery waited for their locks. Inspect again.', entry);
      }
      const active = [
        ...(entry.observed.workspace?.activeGitState ?? []),
        ...entry.observed.repositories.flatMap((repository) => repository.activeGitState.map((state) => `${repository.repositoryPath} ${state}`)),
      ];
      if (active.length > 0) {
        throw new WorktreeRecoveryRefusedError('git_operation_active', `Git operation or lock state is still present: ${active.join(', ')}. Resolve or abort it with Git first; Hive does not remove Git state.`, entry);
      }
      if (entry.observedStateDigest !== request.observedStateDigest) {
        throw new WorktreeRecoveryRefusedError('observed_state_changed', 'The source or destination state changed since it was inspected. Inspect again.', entry);
      }
      const removal = clearMarkers(entry.markerPaths);
      if (removal.remaining.length > 0) {
        throw new Error(`Recovery of ${entry.operationId} could not remove ${removal.remaining.join(', ')} (${removalError(removal)}); those records still guard their resources. Inspect before retrying.`);
      }
      if (removal.flushError !== undefined) {
        throw new Error(`Recovery of ${entry.operationId} removed every record, but flushing their removal failed (${removal.flushError}), so it may not survive a host crash. List pending operations again before acting on them.`);
      }
      return { operationId: entry.operationId, state: entry.state, cleared: entry.markerPaths, replayed: false };
    } finally {
      releaseAll(ownerships);
    }
  }
}

function sameResources(left: OperationResources, right: OperationResources): boolean {
  const key = (resources: OperationResources) => JSON.stringify(resourceRefs(resources));
  return key(left) === key(right);
}
