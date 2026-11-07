import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveFeatureDirectoryName, writeJsonAtomicDurable } from '../utils/paths.js';
import { assertNoSymlinkComponents } from './worktreeLinkage.js';

export interface WorkspaceManifestEntry {
  path: string;
  repoRoot: string;
  repoPath: string;
  branch: string;
  commit: string;
}

interface WorkspaceManifestBase {
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
}

export type CompositeWorkspaceManifest = TaskWorkspaceManifest | AdhocWorkspaceManifest;

export interface SingleWorkspaceMetadata {
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
export interface TargetedWorkspaceMetadata {
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
}

const SAFE_REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FULL_COMMIT = /^[0-9a-f]{40,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

export async function writeWorkspaceJsonAtomic(filePath: string, value: unknown): Promise<void> {
  try {
    const finalStat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (finalStat?.isSymbolicLink()) {
      throw new Error(`Refusing to replace workspace metadata symlink: ${filePath}`);
    }
    writeJsonAtomicDurable(filePath, value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write workspace metadata at ${filePath}: ${message}`, { cause: error });
  }
}
