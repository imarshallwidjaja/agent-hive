import * as path from 'path';
import * as fs from 'fs';
import type { FeatureDirectoryInfo, FeatureJson, ReviewDocument } from '../types.js';
import {
  describeNativeLockHolder,
  isNativeLockHeld,
  resolveLockAnchor,
  sleepSync,
  tryAcquireNativeLock,
  writeNativeLockDiagnostic,
} from './nativeLock.js';
import type { LockAnchor } from './nativeLock.js';

export { NativeLockUnavailableError } from './nativeLock.js';

const HIVE_DIR = '.hive';
const FEATURES_DIR = 'features';
const TASKS_DIR = 'tasks';
const CONTEXT_DIR = 'context';
const REVIEW_COMMENTS_DIR = 'comments';
const PLAN_FILE = 'plan.md';
const COMMENTS_FILE = 'comments.json';
const OVERVIEW_FILE = 'overview.md';
const FEATURE_FILE = 'feature.json';
const STATUS_FILE = 'status.json';
const REPORT_FILE = 'report.md';
const HANDOFF_FILE = 'handoff.md';
const APPROVED_FILE = 'APPROVED';
const TASK_SYNC_FILE = 'task-sync.json';

export const FEATURE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function assertValidFeatureName(name: string): void {
  if (!FEATURE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid feature name: ${JSON.stringify(name)}`);
  }
}

export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function getHivePath(projectRoot: string): string {
  return path.join(projectRoot, HIVE_DIR);
}

export function getFeaturesPath(projectRoot: string): string {
  return path.join(getHivePath(projectRoot), FEATURES_DIR);
}

export function getGlobalSessionsPath(projectRoot: string): string {
  return path.join(getHivePath(projectRoot), 'sessions.json');
}

export function getProjectContextPath(projectRoot: string): string {
  return path.join(getHivePath(projectRoot), CONTEXT_DIR);
}

function parseIndexedFeatureDirectoryName(directoryName: string): { index: number; logicalName: string } | null {
  const match = directoryName.match(/^(\d+)[_-](.+)$/);
  if (!match) {
    return null;
  }

  return {
    index: Number.parseInt(match[1], 10),
    logicalName: match[2],
  };
}

/** Outcome of reading one feature directory's `feature.json`; `unreadable` is never repaired or overwritten. */
export type FeatureMetadataRead =
  | { state: 'valid'; feature: FeatureJson }
  | { state: 'missing' }
  | { state: 'unreadable'; reason: string };

/**
 * Read a feature directory's metadata without throwing. Valid metadata is a JSON object, read from a regular
 * file, whose `name` matches `FEATURE_NAME_PATTERN`; every other field, including unknown legacy ones, is kept.
 */
export function readFeatureMetadata(featureDirectoryPath: string): FeatureMetadataRead {
  const featureJsonPath = path.join(featureDirectoryPath, FEATURE_FILE);
  let parsed: unknown;
  try {
    if (!fs.lstatSync(featureJsonPath).isFile()) {
      return { state: 'unreadable', reason: `${FEATURE_FILE} is not a regular file` };
    }
    parsed = JSON.parse(fs.readFileSync(featureJsonPath, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', reason: (error as Error).message };
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || typeof (parsed as { name?: unknown }).name !== 'string'
    || !FEATURE_NAME_PATTERN.test((parsed as { name: string }).name)
  ) {
    return { state: 'unreadable', reason: `${FEATURE_FILE} has no valid feature name` };
  }
  return { state: 'valid', feature: parsed as FeatureJson };
}

/**
 * Real directories under `.hive/features`. Dot-prefixed names cannot be features; feature creation stages
 * its directory under one before publishing it.
 */
function readFeatureDirectoryNames(featuresPath: string): string[] {
  try {
    return fs.readdirSync(featuresPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Every feature directory, for enumeration. A directory whose metadata is missing or unreadable is still
 * listed under the name its directory implies, so one corrupt sibling never hides the others; resolve a
 * specific feature with `resolveExistingFeaturePath`, which refuses unreadable metadata.
 */
export function listFeatureDirectories(projectRoot: string): FeatureDirectoryInfo[] {
  const featuresPath = getFeaturesPath(projectRoot);
  return readFeatureDirectoryNames(featuresPath)
    .map((directoryName) => {
      const parsed = parseIndexedFeatureDirectoryName(directoryName);
      const metadata = readFeatureMetadata(path.join(featuresPath, directoryName));

      return {
        directoryName,
        logicalName: metadata.state === 'valid' ? metadata.feature.name : parsed?.logicalName || directoryName,
        index: parsed?.index ?? null,
      };
    })
    .sort((left, right) => {
      if (left.index !== null && right.index !== null) {
        return left.index - right.index;
      }
      if (left.index !== null) {
        return 1;
      }
      if (right.index !== null) {
        return -1;
      }
      return left.logicalName.localeCompare(right.logicalName);
    });
}

/**
 * Directory name the name-keyed path helpers (`getFeaturePath` and the paths built on it) use for `featureName`.
 * Whenever `resolveExistingFeaturePath` resolves the name, this is the directory it returns, so a writer that
 * resolves first and then builds paths from the name reaches that feature, never a metadata-less directory that
 * merely has the name. Only names it refuses fall back to the legacy lookup: an existing directory with that exact
 * name, then a listed directory whose logical name matches, then the name itself.
 */
export function resolveFeatureDirectoryName(projectRoot: string, featureName: string): string {
  assertValidFeatureName(featureName);
  const directPath = path.join(getFeaturesPath(projectRoot), featureName);
  // A metadata-backed directory with the exact name is what resolution returns, or the name is ambiguous. Like the
  // resolution scan, this never follows a link in place of a directory.
  let directIsDirectory = false;
  try {
    directIsDirectory = fs.lstatSync(directPath).isDirectory();
  } catch {
    // Absent or unreadable: resolution below decides.
  }
  if (directIsDirectory && readFeatureMetadata(directPath).state === 'valid') {
    return featureName;
  }
  try {
    return path.basename(resolveExistingFeaturePath(projectRoot, featureName));
  } catch (error) {
    if (!(error instanceof FeatureResolutionError)) throw error;
  }
  if (fs.existsSync(directPath)) {
    return featureName;
  }

  const match = listFeatureDirectories(projectRoot).find((entry) => entry.logicalName === featureName);
  return match?.directoryName || featureName;
}

export type FeatureResolutionFailure = 'not_found' | 'ambiguous' | 'unreadable';

/** Why `resolveExistingFeaturePath` refused a name; `directories` names the feature directories involved. */
export class FeatureResolutionError extends Error {
  constructor(
    readonly reason: FeatureResolutionFailure,
    readonly featureName: string,
    message: string,
    readonly directories: string[] = [],
  ) {
    super(message);
    this.name = 'FeatureResolutionError';
  }
}

/**
 * Directory of the one existing, metadata-backed feature that `featureName` names: by the logical name in its
 * `feature.json`, or by its exact directory name (an indexed alias such as `03_checkout`). Reads only; it creates
 * nothing and takes no lock, so callers resolve before any write or lock side effect.
 *
 * Throws `FeatureResolutionError`:
 * - `unreadable` when a directory that could hold the feature (named `featureName` or `NN_featureName`) has
 *   metadata that exists but cannot be read; unrelated corrupt siblings do not affect the lookup.
 * - `not_found` when no directory with valid metadata matches, including invalid names and directories
 *   without `feature.json`.
 * - `ambiguous` when more than one directory matches, whether by logical name or by directory alias.
 */
export function resolveExistingFeaturePath(projectRoot: string, featureName: string): string {
  const notFound = () => new FeatureResolutionError('not_found', featureName, `Feature '${featureName}' not found`);
  if (!FEATURE_NAME_PATTERN.test(featureName)) throw notFound();

  const featuresPath = getFeaturesPath(projectRoot);
  const matches: string[] = [];
  const unreadable: string[] = [];
  for (const directoryName of readFeatureDirectoryNames(featuresPath)) {
    const metadata = readFeatureMetadata(path.join(featuresPath, directoryName));
    if (metadata.state === 'valid') {
      if (metadata.feature.name === featureName || directoryName === featureName) matches.push(directoryName);
    } else if (
      metadata.state === 'unreadable'
      && (directoryName === featureName || parseIndexedFeatureDirectoryName(directoryName)?.logicalName === featureName)
    ) {
      unreadable.push(directoryName);
    }
  }

  if (unreadable.length > 0) {
    throw new FeatureResolutionError(
      'unreadable',
      featureName,
      `Feature '${featureName}' cannot be resolved: unreadable metadata in ${unreadable.map((name) => `'${name}'`).join(', ')}`,
      unreadable,
    );
  }
  if (matches.length === 0) throw notFound();
  if (matches.length > 1) {
    throw new FeatureResolutionError(
      'ambiguous',
      featureName,
      `Feature namespace contains multiple entries named '${featureName}'`,
      matches,
    );
  }
  return path.join(featuresPath, matches[0]!);
}

export function getNextIndexedFeatureDirectoryName(projectRoot: string, featureName: string): string {
  assertValidFeatureName(featureName);
  const indexedEntries = listFeatureDirectories(projectRoot).filter((entry) => entry.index !== null);
  const nextIndex = indexedEntries.reduce((max, entry) => Math.max(max, entry.index ?? 0), 0) + 1;
  return `${String(nextIndex).padStart(2, '0')}_${featureName}`;
}

export function getFeaturePath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturesPath(projectRoot), resolveFeatureDirectoryName(projectRoot, featureName));
}

export function getPlanPath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturePath(projectRoot, featureName), PLAN_FILE);
}

export function getCommentsPath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturePath(projectRoot, featureName), COMMENTS_FILE);
}

export function getReviewCommentsPath(projectRoot: string, featureName: string, document: ReviewDocument): string {
  return path.join(getFeaturePath(projectRoot, featureName), REVIEW_COMMENTS_DIR, `${document}.json`);
}

export function getFeatureJsonPath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturePath(projectRoot, featureName), FEATURE_FILE);
}

export function getContextPath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturePath(projectRoot, featureName), CONTEXT_DIR);
}

export function getOverviewPath(projectRoot: string, featureName: string): string {
  return path.join(getContextPath(projectRoot, featureName), OVERVIEW_FILE);
}

export function getTasksPath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturePath(projectRoot, featureName), TASKS_DIR);
}

export function getTaskPath(projectRoot: string, featureName: string, taskFolder: string): string {
  return path.join(getTasksPath(projectRoot, featureName), taskFolder);
}

export function getTaskStatusPath(projectRoot: string, featureName: string, taskFolder: string): string {
  return path.join(getTaskPath(projectRoot, featureName, taskFolder), STATUS_FILE);
}

export function getTaskReportPath(projectRoot: string, featureName: string, taskFolder: string): string {
  return path.join(getTaskPath(projectRoot, featureName, taskFolder), REPORT_FILE);
}

/** Latest successor handoff written through task updates. */
export function getTaskHandoffPath(projectRoot: string, featureName: string, taskFolder: string): string {
  return path.join(getTaskPath(projectRoot, featureName, taskFolder), HANDOFF_FILE);
}

export function getTaskSpecPath(projectRoot: string, featureName: string, taskFolder: string): string {
  return path.join(getTaskPath(projectRoot, featureName, taskFolder), 'spec.md');
}

export function getApprovedPath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturePath(projectRoot, featureName), APPROVED_FILE);
}

/** Task sync checkpoint; its `.lock` sibling serializes syncs of one feature. */
export function getTaskSyncPath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturePath(projectRoot, featureName), TASK_SYNC_FILE);
}

const SUBTASKS_DIR = 'subtasks';
const SPEC_FILE = 'spec.md';

export function getSubtasksPath(projectRoot: string, featureName: string, taskFolder: string): string {
  return path.join(getTaskPath(projectRoot, featureName, taskFolder), SUBTASKS_DIR);
}

export function getSubtaskPath(projectRoot: string, featureName: string, taskFolder: string, subtaskFolder: string): string {
  return path.join(getSubtasksPath(projectRoot, featureName, taskFolder), subtaskFolder);
}

export function getSubtaskStatusPath(projectRoot: string, featureName: string, taskFolder: string, subtaskFolder: string): string {
  return path.join(getSubtaskPath(projectRoot, featureName, taskFolder, subtaskFolder), STATUS_FILE);
}

export function getSubtaskSpecPath(projectRoot: string, featureName: string, taskFolder: string, subtaskFolder: string): string {
  return path.join(getSubtaskPath(projectRoot, featureName, taskFolder, subtaskFolder), SPEC_FILE);
}

export function getSubtaskReportPath(projectRoot: string, featureName: string, taskFolder: string, subtaskFolder: string): string {
  return path.join(getSubtaskPath(projectRoot, featureName, taskFolder, subtaskFolder), REPORT_FILE);
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

export function writeJson<T>(filePath: string, data: T): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============================================================================
// Atomic + Locked JSON Write Utilities
// ============================================================================

/** Lock acquisition options */
export interface LockOptions {
  /** Maximum time to wait for lock acquisition (ms). Default: 5000 */
  timeout?: number;
  /** Time between lock acquisition attempts (ms). Default: 50 */
  retryInterval?: number;
  /** Retained for source compatibility and ignored: the operating system releases a dead owner's lock. */
  staleLockTTL?: number | null;
}

/** Default lock options */
const DEFAULT_LOCK_OPTIONS: Required<LockOptions> = {
  timeout: 5000,
  retryInterval: 50,
  staleLockTTL: null,
};

/**
 * Path of the exclusive-create lock file that Hive hosts used before native
 * locking. Current hosts never create it; its presence means a host that
 * predates native locking holds the file or crashed while holding it.
 */
export function getLockPath(filePath: string): string {
  return `${filePath}.lock`;
}

/** Thrown when a lock wait ends because a pre-native exclusive-create lock file is still present. */
export class LegacyLockError extends Error {
  readonly legacyLockPath: string;

  constructor(message: string, legacyLockPath: string) {
    super(message);
    this.name = 'LegacyLockError';
    this.legacyLockPath = legacyLockPath;
  }
}

function describeLegacyLockHolder(lockPath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown; timestamp?: unknown };
    const details = [];
    if (typeof parsed.pid === 'number') details.push(`holder pid ${parsed.pid}`);
    if (typeof parsed.timestamp === 'string') details.push(`acquired ${parsed.timestamp}`);
    return details.length > 0 ? `; ${details.join(', ')}` : '';
  } catch {
    return '';
  }
}

type LockAttempt =
  | { status: 'acquired'; release: () => void }
  | { status: 'busy' }
  | { status: 'legacy' };

/**
 * One attempt under the native lock. A legacy exclusive-create lock file can
 * belong to a live host that predates native locking, so it is never ignored:
 * the native lock is released again and the caller keeps waiting.
 */
function attemptStateLock(anchor: LockAnchor): LockAttempt {
  const ownership = tryAcquireNativeLock(anchor);
  if (!ownership) return { status: 'busy' };
  try {
    if (fs.existsSync(anchor.legacyLockPath)) {
      ownership.release();
      return { status: 'legacy' };
    }
    writeNativeLockDiagnostic(ownership);
  } catch (error) {
    ownership.release();
    throw error;
  }
  return { status: 'acquired', release: () => ownership.release() };
}

function lockTimeoutError(anchor: LockAnchor, timeout: number, legacy: boolean): Error {
  if (legacy) {
    return new LegacyLockError(
      `Failed to acquire lock ${anchor.resourcePath} after ${timeout}ms: legacy lock file ${anchor.legacyLockPath} is present${describeLegacyLockHolder(anchor.legacyLockPath)}. A Hive host that predates native locking may still hold it. Stop every such host, confirm its owner is gone, then remove that file.`,
      anchor.legacyLockPath,
    );
  }
  return new Error(
    `Failed to acquire lock ${anchor.resourcePath} after ${timeout}ms${describeNativeLockHolder(anchor)}. A live process holds it; the operating system releases it when that process exits.`,
  );
}

function prepareStateLock(filePath: string): LockAnchor {
  // Lock acquisition has always created the locked file's directory.
  ensureDir(path.dirname(filePath));
  return resolveLockAnchor(filePath);
}

/**
 * Acquire an exclusive, crash-released lock on a file.
 *
 * The lock is native operating-system ownership of a stable anchor file; see
 * `nativeLock.ts`. It is released by the returned function or, if the process
 * dies first, by the operating system.
 *
 * @param filePath - Path to the file to lock
 * @param options - Lock acquisition options
 * @returns An idempotent release function to call when done
 * @throws Error if the lock cannot be acquired within timeout, LegacyLockError
 *   when a pre-native lock file blocked it, NativeLockUnavailableError when no
 *   native backend can run
 */
export async function acquireLock(
  filePath: string,
  options: LockOptions = {}
): Promise<() => void> {
  const opts = { ...DEFAULT_LOCK_OPTIONS, ...options };
  const anchor = prepareStateLock(filePath);
  const startTime = Date.now();
  for (;;) {
    const attempt = attemptStateLock(anchor);
    if (attempt.status === 'acquired') return attempt.release;
    if (Date.now() - startTime >= opts.timeout) throw lockTimeoutError(anchor, opts.timeout, attempt.status === 'legacy');
    await new Promise(resolve => setTimeout(resolve, opts.retryInterval));
  }
}

/**
 * Synchronous version of acquireLock. It waits by blocking the thread, not by spinning.
 */
export function acquireLockSync(
  filePath: string,
  options: LockOptions = {}
): () => void {
  const opts = { ...DEFAULT_LOCK_OPTIONS, ...options };
  const anchor = prepareStateLock(filePath);
  const startTime = Date.now();
  for (;;) {
    const attempt = attemptStateLock(anchor);
    if (attempt.status === 'acquired') return attempt.release;
    if (Date.now() - startTime >= opts.timeout) throw lockTimeoutError(anchor, opts.timeout, attempt.status === 'legacy');
    sleepSync(opts.retryInterval);
  }
}

/**
 * Report, without waiting, creating, or writing anything, whether a file's lock
 * is held: `held` by a live process, `legacy` when a pre-native lock file is
 * present (its owner cannot be known), or `free`.
 */
export function probeLock(filePath: string): 'free' | 'held' | 'legacy' {
  const anchor = resolveLockAnchor(filePath);
  if (isNativeLockHeld(anchor)) return 'held';
  return fs.existsSync(anchor.legacyLockPath) ? 'legacy' : 'free';
}

/**
 * Write a file atomically using write-to-temp-then-rename pattern.
 * This ensures no partial writes are visible to readers.
 * 
 * @param filePath - Destination file path
 * @param content - Content to write
 */
export function writeAtomic(filePath: string, content: string | NodeJS.ArrayBufferView): void {
  ensureDir(path.dirname(filePath));
  
  // Generate unique temp file in same directory (for same-filesystem rename)
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  
  try {
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

export function syncFile(filePath: string): void {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function syncDirectory(directoryPath: string): void {
  // Node does not expose a portable directory flush on Windows.
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directoryPath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writeAtomicDurable(filePath: string, content: string | NodeJS.ArrayBufferView): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;

  try {
    fs.writeFileSync(tempPath, content);
    syncFile(tempPath);
    fs.renameSync(tempPath, filePath);
    syncDirectory(path.dirname(filePath));
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The rename may already have published the destination.
    }
    throw error;
  }
}

/**
 * Write JSON atomically
 */
export function writeJsonAtomic<T>(filePath: string, data: T): void {
  writeAtomic(filePath, JSON.stringify(data, null, 2));
}

export function writeJsonAtomicDurable<T>(filePath: string, data: T): void {
  writeAtomicDurable(filePath, JSON.stringify(data, null, 2));
}

/**
 * Write JSON with exclusive lock (async version).
 * Ensures only one process writes at a time and writes are atomic.
 * 
 * @param filePath - Path to JSON file
 * @param data - Data to write
 * @param options - Lock options
 */
export async function writeJsonLocked<T>(
  filePath: string,
  data: T,
  options: LockOptions = {}
): Promise<void> {
  const release = await acquireLock(filePath, options);
  try {
    writeJsonAtomic(filePath, data);
  } finally {
    release();
  }
}

/**
 * Synchronous version of writeJsonLocked
 */
export function writeJsonLockedSync<T>(
  filePath: string,
  data: T,
  options: LockOptions = {}
): void {
  const release = acquireLockSync(filePath, options);
  try {
    writeJsonAtomic(filePath, data);
  } finally {
    release();
  }
}

/**
 * Deep merge utility that explicitly handles nested objects.
 * - Arrays are replaced, not merged
 * - Undefined values in patch are ignored (don't delete existing keys)
 * - Null values explicitly set to null
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  patch: Partial<T>
): T {
  const result = { ...target };
  
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const patchValue = patch[key];
    
    // Skip undefined values (don't overwrite)
    if (patchValue === undefined) {
      continue;
    }
    
    // If both are plain objects (not arrays, not null), deep merge
    if (
      patchValue !== null &&
      typeof patchValue === 'object' &&
      !Array.isArray(patchValue) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        patchValue as Record<string, unknown>
      ) as T[keyof T];
    } else {
      // Direct assignment for primitives, arrays, null
      result[key] = patchValue as T[keyof T];
    }
  }
  
  return result;
}

/**
 * Read-modify-write JSON with lock protection.
 * Reads current content, applies patch via deep merge, writes atomically.
 * 
 * @param filePath - Path to JSON file
 * @param patch - Partial update to merge
 * @param options - Lock options
 * @returns The merged result
 */
export async function patchJsonLocked<T extends object>(
  filePath: string,
  patch: Partial<T>,
  options: LockOptions = {}
): Promise<T> {
  const release = await acquireLock(filePath, options);
  try {
    const current = readJson<T>(filePath) || ({} as T);
    const merged = deepMerge(current as Record<string, unknown>, patch as Record<string, unknown>) as T;
    writeJsonAtomic(filePath, merged);
    return merged;
  } finally {
    release();
  }
}

/**
 * Synchronous version of patchJsonLocked
 */
export function patchJsonLockedSync<T extends object>(
  filePath: string,
  patch: Partial<T>,
  options: LockOptions = {}
): T {
  const release = acquireLockSync(filePath, options);
  try {
    const current = readJson<T>(filePath) || ({} as T);
    const merged = deepMerge(current as Record<string, unknown>, patch as Record<string, unknown>) as T;
    writeJsonAtomic(filePath, merged);
    return merged;
  } finally {
    release();
  }
}

export function readText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

export function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}
