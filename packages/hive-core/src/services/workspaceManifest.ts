import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FeatureResolutionError, resolveExistingFeaturePath, resolveFeatureDirectoryName, writeAtomicDurable, writeJsonAtomicDurable } from '../utils/paths.js';
import { assertNoSymlinkComponents } from './worktreeLinkage.js';
import type { WorklogRef } from './worklogService.js';

export interface WorkspaceManifestEntry {
  path: string;
  repoRoot: string;
  repoPath: string;
  branch: string;
  commit: string;
}

/**
 * `createUnconfirmed: true` marks a workspace record a create published before
 * its Git work and has not yet confirmed: until its own `worktree add` succeeded
 * and was validated, a checkout at the placement may be another Git client's.
 * Cleanup then removes only an empty checkout and create refuses to reuse one.
 * Absent means confirmed, as in records from before the field; any other value
 * is refused.
 */
export interface CreateConfirmation {
  createUnconfirmed?: true;
}

/**
 * Why a placement whose record a create published and never confirmed cannot
 * be used as `use` says (`reused`, `integrated`), or null for a confirmed
 * record: its checkout may be another Git client's, so treating it as this
 * owner's worker would hand that checkout, or its commits, to the caller.
 */
export function createUnconfirmedRefusal(record: CreateConfirmation | null, placement: string, recordPath: string, cleanupTool: string, use: 'reused' | 'integrated'): string | null {
  if (record?.createUnconfirmed !== true) return null;
  return `${placement} was left by a create that never confirmed it (createUnconfirmed in ${recordPath}), so its checkout may belong to another Git client and is not ${use}. `
    + `Acknowledge any pending operation with hive_worktree_recover, then run ${cleanupTool}: it removes checkouts that are gone or empty and keeps a populated one, which you inspect and remove or keep yourself, `
    + 'and it keeps this record until the worker branches are deleted too. Create again once the record is gone.';
}

/** Refuse to reuse a placement a create never confirmed; see `createUnconfirmedRefusal`. */
export function assertCreateConfirmed(record: CreateConfirmation | null, placement: string, recordPath: string, cleanupTool: string): void {
  const refusal = createUnconfirmedRefusal(record, placement, recordPath, cleanupTool, 'reused');
  if (refusal !== null) throw new Error(refusal);
}

/**
 * The confirming write of a create failed. The create's own `worktree add` was
 * validated, so ownership was shown; what failed is publication, and the
 * atomic rename may already have made the confirmed bytes visible before the
 * directory flush failed. `recordUnresolved` is false once the unconfirmed
 * record was written back durably; true when that write failed too, so the
 * record may read as confirmed.
 */
export class WorkspaceRecordConfirmationError extends Error {
  readonly recordPath: string;
  readonly recordUnresolved: boolean;

  constructor(recordPath: string, cause: unknown, restoreError: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(restoreError === undefined
      ? message
      : `${message}; putting createUnconfirmed back in ${recordPath} also failed (${restoreError instanceof Error ? restoreError.message : String(restoreError)})`, { cause });
    this.name = 'WorkspaceRecordConfirmationError';
    this.recordPath = recordPath;
    this.recordUnresolved = restoreError !== undefined;
  }
}

/**
 * Publish a create's confirmed record, `record` without `createUnconfirmed`.
 * On failure the unconfirmed record is written back before the error is
 * thrown, so a rollback that keeps a checkout leaves a record that still
 * protects it. Throws `WorkspaceRecordConfirmationError`.
 */
export async function confirmWorkspaceRecord(filePath: string, record: object): Promise<void> {
  try {
    await writeWorkspaceJsonAtomic(filePath, record);
  } catch (error) {
    let restoreError: unknown;
    try {
      await writeWorkspaceJsonAtomic(filePath, { ...record, createUnconfirmed: true });
    } catch (writeError) {
      restoreError = writeError;
    }
    throw new WorkspaceRecordConfirmationError(filePath, error, restoreError);
  }
}

/**
 * What a create that keeps leftovers reports about a record its failed
 * confirmation could not put back: the record may read as confirmed, and
 * acknowledging the operation would then let cleanup treat a kept checkout as
 * Hive's. No Hive tool repairs a workspace record, so the note asks the agent
 * to keep the state and hand it to the operator. Empty for any other failure.
 */
export function unresolvedRecordNote(error: unknown): string {
  if (!(error instanceof WorkspaceRecordConfirmationError) || !error.recordUnresolved) return '';
  return `. The workspace record ${error.recordPath} is unresolved: it may read as confirmed, and recovery does not read workspace records. `
    + 'Do not acknowledge the operation: keep the record and the kept checkout as they are and report both to the operator, '
    + 'whose separately authorized repair (setting createUnconfirmed: true in the record, or removing the checkout) must come first';
}

/** A workspace record's exact bytes, or null when it does not exist, so a failed create can put it back. */
export async function readWorkspaceRecordBytes(filePath: string): Promise<Buffer | null> {
  return fs.readFile(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

/**
 * Put a workspace record back as a create found it: its prior bytes, or no
 * file. Returns whether the record now is as it was; a record that already is,
 * as after a write that failed before it published, needs no write.
 */
export async function restoreWorkspaceRecord(filePath: string, prior: Buffer | null): Promise<boolean> {
  try {
    const current = await readWorkspaceRecordBytes(filePath);
    if (prior === null ? current === null : current !== null && current.equals(prior)) return true;
    if (prior === null) await fs.unlink(filePath);
    else writeAtomicDurable(filePath, prior);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Worklog an ad-hoc run's creating session recorded into, stamped once at
 * create and copied into the run's integration receipts. Read tolerantly: a
 * missing or malformed value leaves receipts with the bare run ID.
 */
export interface AdhocRunOrigin {
  worklog: WorklogRef;
}

interface WorkspaceManifestBase extends CreateConfirmation {
  schemaVersion: 1;
  repos: Record<string, WorkspaceManifestEntry>;
  baseCommits: Record<string, string>;
  createdAt?: string;
}

export interface TaskWorkspaceManifest extends WorkspaceManifestBase {
  mode: 'composite';
  feature: string;
  task: string;
}

export interface AdhocWorkspaceManifest extends WorkspaceManifestBase {
  mode: 'adhoc-composite';
  runId: string;
  origin?: AdhocRunOrigin;
}

export type CompositeWorkspaceManifest = TaskWorkspaceManifest | AdhocWorkspaceManifest;

export interface SingleWorkspaceMetadata extends CreateConfirmation {
  schemaVersion: 1;
  mode: 'single' | 'adhoc-single';
  worktreePath: string;
  repositoryPath: string;
  branch: string;
  baseCommit: string;
  createdAt?: string;
  feature?: string;
  task?: string;
  runId?: string;
  origin?: AdhocRunOrigin;
}

/**
 * The retained checkout a targeted worker integrates into, frozen when the
 * worker was created. Inspection and merge compare live state against it and
 * refuse rather than follow a checkout that switched branch or moved.
 */
export interface TargetBinding {
  /** Retained checkout ID, `<repoId>/<slug>`. */
  id: string;
  /** Canonical checkout path. */
  path: string;
  /** Full local branch ref, `refs/heads/...`. */
  ref: string;
}

/**
 * Sidecar of a single-repository worker bound to one retained checkout. Its
 * modes are unknown to hosts that predate targeted workers, whose metadata
 * readers therefore refuse the placement instead of misreading it.
 */
export interface TargetedWorkspaceMetadata extends CreateConfirmation {
  schemaVersion: 1;
  mode: 'targeted' | 'adhoc-targeted';
  repoId: string;
  worktreePath: string;
  repositoryPath: string;
  branch: string;
  /** Commit the worker branch started at. Not the target. */
  baseCommit: string;
  /** The starting point the caller named, when it was not the target's HEAD. */
  baseRef?: string;
  target: TargetBinding;
  createdAt: string;
  feature?: string;
  task?: string;
  candidate?: string;
  runId?: string;
  origin?: AdhocRunOrigin;
}

const SAFE_REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FULL_COMMIT = /^[0-9a-f]{40,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidCreateConfirmation(record: CreateConfirmation): boolean {
  return record.createUnconfirmed === undefined || record.createUnconfirmed === true;
}

function isSafeRepositoryId(id: string): boolean {
  return SAFE_REPOSITORY_ID.test(id)
    && id !== '.'
    && id !== '..'
    && !id.includes('..');
}

function assertValidManifestEntries(manifestPath: string, manifest: Partial<CompositeWorkspaceManifest>): void {
  if (!isRecord(manifest.repos) || !isRecord(manifest.baseCommits)) {
    throw new Error(`Invalid composite workspace manifest: ${manifestPath}`);
  }

  const entries = Object.entries(manifest.repos);
  if (entries.length === 0) {
    throw new Error(`Invalid composite workspace manifest: ${manifestPath}`);
  }

  for (const [id, value] of entries) {
    if (!isSafeRepositoryId(id) || !isRecord(value)) {
      throw new Error(`Invalid composite workspace manifest: ${manifestPath}`);
    }
    const entry = value as Partial<WorkspaceManifestEntry>;
    if (
      entry.path !== path.posix.join('repos', id)
      || typeof entry.repoRoot !== 'string'
      || typeof entry.repoPath !== 'string'
      || typeof entry.branch !== 'string'
      || typeof entry.commit !== 'string'
      || typeof manifest.baseCommits[id] !== 'string'
    ) {
      throw new Error(`Invalid composite workspace manifest: ${manifestPath}`);
    }
  }
}

export function parseCompositeWorkspaceManifest(value: unknown, manifestPath: string): CompositeWorkspaceManifest {
  if (!isRecord(value)) {
    throw new Error(`Invalid composite workspace manifest: ${manifestPath}`);
  }
  const manifest = value as Partial<CompositeWorkspaceManifest>;
  if (
    manifest.schemaVersion !== 1
    || (manifest.mode !== 'composite' && manifest.mode !== 'adhoc-composite')
    || !isValidCreateConfirmation(manifest)
  ) {
    throw new Error(`Invalid composite workspace manifest: ${manifestPath}`);
  }
  assertValidManifestEntries(manifestPath, manifest);
  return manifest as CompositeWorkspaceManifest;
}

export async function readCompositeWorkspaceManifest(workspaceRoot: string): Promise<CompositeWorkspaceManifest | null> {
  const manifestPath = path.join(workspaceRoot, 'workspace.json');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    return parseCompositeWorkspaceManifest(JSON.parse(raw), manifestPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in composite workspace manifest ${manifestPath}: ${error.message}`);
    }
    throw error;
  }
}

export async function readSingleWorkspaceMetadata(metadataPath: string): Promise<SingleWorkspaceMetadata | null> {
  let raw: string;
  try {
    raw = await fs.readFile(metadataPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: Partial<SingleWorkspaceMetadata>;
  try {
    value = JSON.parse(raw) as Partial<SingleWorkspaceMetadata>;
  } catch (error) {
    throw new Error(`Invalid JSON in single workspace metadata ${metadataPath}: ${(error as Error).message}`);
  }
  if (
    value.schemaVersion !== 1
    || (value.mode !== 'single' && value.mode !== 'adhoc-single')
    || typeof value.worktreePath !== 'string'
    || typeof value.repositoryPath !== 'string'
    || typeof value.branch !== 'string'
    || typeof value.baseCommit !== 'string'
    || !isValidCreateConfirmation(value)
  ) {
    throw new Error(`Invalid single workspace metadata: ${metadataPath}`);
  }
  return value as SingleWorkspaceMetadata;
}

function isTargetBinding(value: unknown): value is TargetBinding {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.path === 'string'
    && path.isAbsolute(value.path)
    && typeof value.ref === 'string'
    && value.ref.startsWith('refs/heads/');
}

export function parseTargetedWorkspaceMetadata(value: unknown, metadataPath: string): TargetedWorkspaceMetadata {
  const invalid = () => new Error(`Invalid targeted workspace metadata: ${metadataPath}`);
  if (!isRecord(value)) throw invalid();
  const metadata = value as Partial<TargetedWorkspaceMetadata>;
  const optionalString = (field: unknown) => field === undefined || typeof field === 'string';
  if (
    metadata.schemaVersion !== 1
    || (metadata.mode !== 'targeted' && metadata.mode !== 'adhoc-targeted')
    || typeof metadata.repoId !== 'string'
    || !isSafeRepositoryId(metadata.repoId)
    || typeof metadata.worktreePath !== 'string'
    || typeof metadata.repositoryPath !== 'string'
    || typeof metadata.branch !== 'string'
    || typeof metadata.baseCommit !== 'string'
    || !FULL_COMMIT.test(metadata.baseCommit)
    || !optionalString(metadata.baseRef)
    || !isTargetBinding(metadata.target)
    || !metadata.target.id.startsWith(`${metadata.repoId}/`)
    || typeof metadata.createdAt !== 'string'
    || !isValidCreateConfirmation(metadata)
    || (metadata.mode === 'targeted'
      ? typeof metadata.feature !== 'string' || typeof metadata.task !== 'string' || !optionalString(metadata.candidate)
      : typeof metadata.runId !== 'string')
  ) {
    throw invalid();
  }
  return metadata as TargetedWorkspaceMetadata;
}

/**
 * Read a single-placement sidecar when it describes a targeted worker. Null
 * when the file is missing or holds another mode, which
 * `readSingleWorkspaceMetadata` owns and reports. A file that is not JSON is
 * refused: it could be a damaged targeted sidecar.
 */
export async function readTargetedWorkspaceMetadata(metadataPath: string): Promise<TargetedWorkspaceMetadata | null> {
  let raw: string;
  try {
    raw = await fs.readFile(metadataPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in workspace metadata ${metadataPath}: ${(error as Error).message}`);
  }
  const mode = isRecord(value) ? value.mode : undefined;
  if (mode !== 'targeted' && mode !== 'adhoc-targeted') return null;
  return parseTargetedWorkspaceMetadata(value, metadataPath);
}

/** Split a task placement directory `<step>--<candidate>` the way task workers name it. */
export function parseTaskPlacementEntry(entry: string): { task: string; candidate?: string } {
  const separator = entry.lastIndexOf('--');
  if (separator <= 0 || separator + 2 >= entry.length) return { task: entry };
  return { task: entry.slice(0, separator), candidate: entry.slice(separator + 2) };
}

/**
 * The status file a task worker reads for one task folder of a feature directory: `tasks/<folder>/status.json`, or the
 * legacy `execution/<folder>/status.json` when only that one exists.
 */
export function resolveWorkerTaskStatusPath(featurePath: string, taskFolder: string): string {
  const modern = path.join(featurePath, 'tasks', taskFolder, 'status.json');
  const legacy = path.join(featurePath, 'execution', taskFolder, 'status.json');
  return !fsSync.existsSync(modern) && fsSync.existsSync(legacy) ? legacy : modern;
}

/** A regular file's JSON; unreadable when it is not a regular file, cannot be read, or is not JSON. */
async function readRecordFile(filePath: string): Promise<{ state: 'missing' | 'unreadable' } | { state: 'read'; value: unknown }> {
  const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : undefined));
  if (stat === null) return { state: 'missing' };
  if (!stat?.isFile()) return { state: 'unreadable' };
  try {
    return { state: 'read', value: JSON.parse(await fs.readFile(filePath, 'utf8')) };
  } catch {
    return { state: 'unreadable' };
  }
}

export type AdhocGroupEntryOwner =
  | { owner: 'task' }
  /** `declared` when a sidecar or manifest names the run; otherwise only the absence of a task of that name does. */
  | { owner: 'adhoc'; declared: boolean }
  | { owner: 'unknown'; reason: string };

/**
 * Who owns an entry of `.hive/.worktrees/adhoc/`, which ad-hoc runs share with the task worktrees of a feature whose
 * logical name is `adhoc`. A sidecar or composite manifest declares its owner. Otherwise a run and a task of that name
 * have the same path and branch, so only the task record can settle it: no task of that name leaves the entry to the
 * run, and a task status that records a worker's base commit, which releases before sidecars wrote when they created
 * the task's worktree, makes its default entry the task's. Anything else, including a candidate-shaped entry without
 * metadata, metadata or a record that cannot be read, is unknown: listings report it and leave it alone. Reads no Git
 * and no task record through a symlink.
 */
export async function adhocGroupEntryOwner(projectRoot: string, hiveDir: string, entry: string): Promise<AdhocGroupEntryOwner> {
  const placement = path.join(hiveDir, '.worktrees', 'adhoc', entry);
  const { task, candidate } = parseTaskPlacementEntry(entry);
  const unknown = (detail: string): AdhocGroupEntryOwner => ({
    owner: 'unknown',
    reason: `${placement} could be ad-hoc run ${entry} or the worktree of task adhoc/${task}${candidate ? ` (candidate ${candidate})` : ''}: ${detail}`,
  });
  let metadata = await readRecordFile(`${placement}.json`);
  if (metadata.state === 'missing' && (await fs.lstat(placement).catch(() => null))?.isDirectory()) {
    metadata = await readRecordFile(path.join(placement, 'workspace.json'));
  }
  const mode = metadata.state === 'read' && isRecord(metadata.value) ? metadata.value.mode : undefined;
  if (mode === 'single' || mode === 'composite' || mode === 'targeted') return { owner: 'task' };
  if (mode === 'adhoc-single' || mode === 'adhoc-composite' || mode === 'adhoc-targeted') return { owner: 'adhoc', declared: true };
  let featurePath: string;
  try {
    // Unreadable or ambiguous metadata could hide the adhoc feature's task records, so only an absent feature falls through.
    try {
      resolveExistingFeaturePath(projectRoot, 'adhoc');
    } catch (error) {
      if (!(error instanceof FeatureResolutionError) || error.reason !== 'not_found') throw error;
    }
    featurePath = path.join(hiveDir, 'features', resolveFeatureDirectoryName(projectRoot, 'adhoc'));
  } catch (error) {
    return unknown(`feature adhoc cannot be resolved (${(error as Error).message})`);
  }
  const folders = ['tasks', 'execution'].map((layout) => path.join(featurePath, layout, task));
  const statusPath = resolveWorkerTaskStatusPath(featurePath, task);
  try {
    for (const candidatePath of [...folders, statusPath]) await assertNoSymlinkComponents(hiveDir, candidatePath, true);
  } catch (error) {
    return unknown((error as Error).message);
  }
  const recorded = await Promise.all(folders.map((folder) => fs.lstat(folder).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT')));
  if (!recorded.includes(true)) return { owner: 'adhoc', declared: false };
  if (metadata.state !== 'missing') return unknown('its workspace metadata cannot be read');
  const status = await readRecordFile(statusPath);
  if (status.state !== 'read') return unknown(`its task status is ${status.state}`);
  // A status base commit speaks for the task's default worktree only. A candidate's branch differs from a run's of this
  // name, so the status cannot attribute a candidate-shaped entry.
  if (candidate) return unknown('neither has workspace metadata, and a task base commit does not record a candidate');
  const baseCommit = isRecord(status.value) ? status.value.baseCommit : undefined;
  if (typeof baseCommit === 'string' && FULL_COMMIT.test(baseCommit)) return { owner: 'task' };
  return unknown('neither has workspace metadata, and the task status records no worker base commit');
}

/**
 * Remove a composite workspace root once its repository checkouts are gone: an
 * empty root, or one holding only an empty `repos/` and `workspace.json`. Any
 * other entry refuses. The manifest is set aside while the directory is
 * removed and restored when that removal fails, so a root that stays keeps it.
 */
export async function removeEmptyCompositeWorkspaceRoot(workspaceRoot: string): Promise<void> {
  const reposPath = path.join(workspaceRoot, 'repos');
  const remaining = await fs.readdir(reposPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (remaining.length > 0) throw new Error(`Composite workspace still contains repositories: ${remaining.join(', ')}`);
  const entries = await fs.readdir(workspaceRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entries === null) return;
  if (entries.length === 0) {
    await fs.rmdir(workspaceRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
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

export async function writeWorkspaceJsonAtomic(filePath: string, value: unknown): Promise<void> {
  writeWorkspaceJsonAtomicSync(filePath, value);
}

/** `writeWorkspaceJsonAtomic` without an await, for a record published under a lock that is never held across one. */
export function writeWorkspaceJsonAtomicSync(filePath: string, value: unknown): void {
  try {
    let finalStat: fsSync.Stats | null;
    try {
      finalStat = fsSync.lstatSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      finalStat = null;
    }
    if (finalStat?.isSymbolicLink()) {
      throw new Error(`Refusing to replace workspace metadata symlink: ${filePath}`);
    }
    writeJsonAtomicDurable(filePath, value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write workspace metadata at ${filePath}: ${message}`, { cause: error });
  }
}
