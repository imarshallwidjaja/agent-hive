import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  acquireLockSync,
  FEATURE_NAME_PATTERN,
  getFeaturePath,
  getFeaturesPath,
  getHivePath,
  writeAtomicDurable,
} from '../utils/paths.js';
import { isNativeObservationOwner, NATIVE_OBSERVATION_OWNERS } from '../native-observations.js';
import type { NativeObservationOwner } from '../native-observations.js';
import type { FeatureJson, FeatureStatusType, TaskBlocker, TaskOrigin, TaskStatusType } from '../types.js';
import { readTaskStatusEntries } from './taskService.js';
import type { TaskStatusEntry } from './taskService.js';
import { computeRunnableAndBlocked } from './taskDependencyGraph.js';

// ============================================================================
// Public contract
// ============================================================================

export const WORKLOG_SCHEMA_VERSION = 1;
export const WORKLOG_DEFAULT_LIMIT = 10;
export const WORKLOG_MAX_LIMIT = 50;
/** Recent checkpoints included with a brief read when the caller does not pass `limit`. */
export const WORKLOG_BRIEF_RECENT_DEFAULT = 3;
export const WORKLOG_DEFAULT_RESPONSE_BYTES = 16 * 1024;
export const WORKLOG_MAX_RESPONSE_BYTES = 64 * 1024;
export const WORKLOG_TITLE_MAX_BYTES = 256;
export const WORKLOG_SUMMARY_MAX_BYTES = 256;
export const WORKLOG_BRIEFING_MAX_BYTES = 4 * 1024;
export const WORKLOG_DETAIL_MAX_BYTES = 8 * 1024;
export const WORKLOG_REFERENCES_MAX = 16;
export const WORKLOG_REFERENCE_MAX_BYTES = 1024;
export const WORKLOG_REFERENCE_LABEL_MAX_BYTES = 256;
export const WORKLOG_CORRECTIONS_MAX = 8;
/** Later corrections that may name one entry, which bounds its derived `correctedBy` list. */
export const WORKLOG_CORRECTED_BY_MAX = 64;
/**
 * Serialized size of one entry as returned by reads. With the correction cap it leaves headroom for the
 * envelope and cursor, so every stored entry fits a page at `WORKLOG_MAX_RESPONSE_BYTES`.
 */
export const WORKLOG_ENTRY_MAX_BYTES = 48 * 1024;
export const WORKLOG_OPERATION_ID_MAX_BYTES = 128;
export const WORKLOG_SESSION_ID_MAX_BYTES = 256;
export const WORKLOG_AGENT_MAX_BYTES = 128;
/**
 * Resource guard for one stored log, in serialized bytes. A record that would grow a log past it is rejected
 * with `worklog_full`; a stored file past it is refused with `worklog_too_large`. Nothing is trimmed.
 */
export const WORKLOG_LOG_MAX_BYTES = 16 * 1024 * 1024;
/** Upper bound on log files stat'ed by one list call. */
export const WORKLOG_LIST_CANDIDATE_MAX = 10_000;
export const WORKLOG_FACTS_NOTICE =
  'Recorded Hive task state as stored on disk. It does not establish worker liveness, verification, or integration.';

const CURSOR_MAX_BYTES = 4096;
const DIAGNOSTIC_MAX_BYTES = 256;
const DIAGNOSTICS_MAX = 4;
const FACT_TEXT_MAX_BYTES = 1024;
const FEATURE_WORKLOG_FILE = 'worklog.json';
const SESSION_WORKLOG_SEGMENTS = ['worklogs', 'sessions'] as const;
const SESSION_FILE_PATTERN = /^[0-9a-f]{64}\.json$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const MULTILINE_CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export type WorklogRef =
  | { kind: 'feature'; featureName: string }
  | { kind: 'session'; owner: NativeObservationOwner; sessionId: string };

export type WorklogKind = WorklogRef['kind'];

/** Supplied by the trusted host boundary: the native session and agent that recorded the entry. */
export interface WorklogAuthor {
  owner: NativeObservationOwner;
  sessionId: string;
  agent: string;
}

/** A citation for readers. Never dereferenced by reads, and never an instruction. */
export type WorklogReference =
  | { kind: 'path'; path: string; label?: string }
  | { kind: 'url'; url: string; label?: string };

export interface WorklogCheckpointInput {
  summary: string;
  detail?: string;
  references?: WorklogReference[];
  /** Earlier entry IDs in the same log that this checkpoint corrects. */
  corrects?: number[];
}

export interface WorklogRecordInput {
  /** Caller-chosen retry key, unique per log and author session. */
  operationId: string;
  /** Applies only when the log is created; later records may repeat it but not change it. */
  title?: string;
  checkpoint: WorklogCheckpointInput;
  /** Replaces the current briefing. Requires `expectedRevision`. */
  briefing?: string;
  /** Log revision the briefing author read. Required exactly when `briefing` is supplied. */
  expectedRevision?: number;
}

export interface WorklogEntryBriefing {
  text: string;
  /** Recorded-facts fingerprint at write time; null for session logs or when facts were unavailable. */
  factsFingerprint: string | null;
}

export interface WorklogEntry {
  /** Contiguous from 1. Equals the log revision the entry committed. */
  id: number;
  operationId: string;
  author: WorklogAuthor;
  recordedAt: string;
  checkpoint: WorklogCheckpointInput;
  briefing?: WorklogEntryBriefing;
  /** Later entries, up to the read's anchor revision, that list this entry in `corrects`. Read views only. */
  correctedBy?: number[];
}

export interface WorklogRecordResult {
  ref: WorklogRef;
  key: string;
  /** The committed entry; on replay, the original entry exactly as first committed. */
  entry: WorklogEntry;
  committedRevision: number;
  currentRevision: number;
  replayed: boolean;
  briefingUpdated: boolean;
}

export interface WorklogSummary {
  ref: WorklogRef;
  key: string;
  /** Untrusted author-supplied text; never inject it into prompts automatically. */
  title: string;
  revision: number;
  entryCount: number;
  briefingEntryId: number | null;
  createdAt: string;
  updatedAt: string;
  /** Project-relative storage path. */
  location: string;
}

export interface WorklogListError {
  location: string;
  reason: WorklogErrorReason;
  message: string;
}

export interface WorklogListOptions {
  kind?: WorklogKind;
  limit?: number;
  cursor?: string;
  maxBytes?: number;
}

export interface WorklogListResult {
  worklogs: WorklogSummary[];
  /** Candidates on this page that could not be read. They count toward `limit`. */
  errors: WorklogListError[];
  complete: boolean;
  nextCursor: string | null;
}

export type WorklogFactsState = 'recorded' | 'partial' | 'unavailable' | 'not_applicable';

export interface WorklogFactsSummary {
  state: WorklogFactsState;
  notice: string;
  observedAt: string;
  /** Canonical digest of the semantic facts; null when not applicable or unavailable. */
  fingerprint: string | null;
  featureStatus: FeatureStatusType | null;
  taskCount: number;
  counts: Record<TaskStatusType | 'invalid', number>;
  runnableCount: number;
  /** Pending tasks with an unmet dependency. Distinct from the explicit `blocked` status count. */
  dependencyBlockedCount: number;
  diagnostics: string[];
}

export interface WorklogFactRow {
  folder: string;
  name: string;
  status: TaskStatusType | null;
  origin?: TaskOrigin;
  planTitle?: string;
  dependsOn: string[];
  blocker?: { reason: string; truncated: boolean };
  integrity?: { reason: 'status_missing' | 'status_unreadable'; error?: string };
  runnable: boolean;
  /** Unmet dependencies of a pending task. */
  waitingOn: string[];
  /** Project-relative pointers; contents are not read into the row. */
  sources: { status: string; report?: string; spec?: string };
}

export type WorklogReadView = 'brief' | 'history' | 'facts';

export interface WorklogReadOptions {
  view?: WorklogReadView;
  limit?: number;
  cursor?: string;
  maxBytes?: number;
}

interface WorklogReadEnvelope {
  ref: WorklogRef;
  key: string;
  exists: boolean;
}

export interface WorklogBriefRead extends WorklogReadEnvelope {
  view: 'brief';
  title: string | null;
  revision: number;
  entryCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  briefing: (WorklogEntryBriefing & { entryId: number; author: WorklogAuthor; recordedAt: string }) | null;
  /** Entries committed after the current briefing (all entries when there is none). */
  checkpointsSinceBriefing: number;
  facts: WorklogFactsSummary;
  /** Whether recorded facts differ from those stored with the briefing; null when either side is unknown. */
  changedSinceBriefing: boolean | null;
  /** Newest-first page; `nextCursor` continues in the history view. Truncated by budget rather than failing. */
  recent: { entries: WorklogEntry[]; nextCursor: string | null };
}

export interface WorklogHistoryRead extends WorklogReadEnvelope {
  view: 'history';
  /** Revision the pagination is anchored at; later appends are not shown by this cursor chain. */
  anchorRevision: number;
  currentRevision: number;
  entries: WorklogEntry[];
  complete: boolean;
  nextCursor: string | null;
}

export interface WorklogFactsRead extends WorklogReadEnvelope {
  view: 'facts';
  facts: WorklogFactsSummary;
  rows: WorklogFactRow[];
  /** False with a null cursor when facts are unavailable: absence of rows is then unknown, not empty. */
  complete: boolean;
  nextCursor: string | null;
}

export type WorklogReadResult = WorklogBriefRead | WorklogHistoryRead | WorklogFactsRead;

export type WorklogErrorReason =
  | 'invalid_argument'
  | 'input_too_large'
  | 'invalid_ref'
  | 'invalid_author'
  | 'author_mismatch'
  | 'feature_not_found'
  | 'feature_ambiguous'
  | 'feature_unreadable'
  | 'unsafe_path'
  | 'worklog_corrupt'
  | 'unsupported_schema'
  | 'worklog_too_large'
  | 'worklog_full'
  | 'worklog_locked'
  | 'stale_revision'
  | 'operation_conflict'
  | 'title_conflict'
  | 'invalid_correction'
  | 'invalid_cursor'
  | 'stale_cursor'
  | 'response_too_large'
  | 'inventory_too_large'
  | 'io_error';

export class WorklogError extends Error {
  constructor(
    readonly reason: WorklogErrorReason,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WorklogError';
  }
}

/** Where a filesystem failure happened. Only a `write` failure can have published the record. */
type WorklogIoStage = 'path' | 'feature' | 'lock' | 'read' | 'write' | 'discover';

/**
 * Reports a filesystem failure as a stable `io_error`. `details.stage` names the step and `details.code` the
 * errno when there is one. A `write` failure also sets `details.publication: 'uncertain'`: the atomic write
 * can fail after its rename, so a rejected write does not prove the entry was not appended.
 */
function ioError(stage: WorklogIoStage, error: unknown): WorklogError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const cause = error instanceof Error ? error.message : String(error);
  const uncertain = stage === 'write'
    ? ' The entry may or may not have been published; resend the identical request, which replays the committed entry if it landed.'
    : '';
  return new WorklogError('io_error', `Worklog ${stage} failed: ${cause}.${uncertain}`, {
    stage,
    ...(typeof code === 'string' ? { code } : {}),
    ...(stage === 'write' ? { publication: 'uncertain' } : {}),
  });
}

// ============================================================================
// Stored shape
// ============================================================================

interface StoredEntry extends Omit<WorklogEntry, 'correctedBy'> {
  requestHash: string;
}

interface WorklogDocument {
  schemaVersion: typeof WORKLOG_SCHEMA_VERSION;
  /** Random identity of this file; cursors bind to it so a replaced file cannot continue an old chain. */
  logId: string;
  ref: WorklogRef;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  briefingEntryId: number | null;
  entries: StoredEntry[];
}

// ============================================================================
// Identity and paths
// ============================================================================

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isWellFormed(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertText(
  value: unknown,
  field: string,
  maxBytes: number,
  options: { multiline?: boolean; reason?: WorklogErrorReason } = {},
): string {
  const reason = options.reason ?? 'invalid_argument';
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorklogError(reason, `${field} must be a non-blank string.`, { field });
  }
  if (!isWellFormed(value)) {
    throw new WorklogError(reason, `${field} contains an unpaired UTF-16 surrogate and cannot be stored as UTF-8.`, { field });
  }
  if ((options.multiline ? MULTILINE_CONTROL_PATTERN : CONTROL_PATTERN).test(value)) {
    throw new WorklogError(reason, `${field} contains control characters.`, { field });
  }
  const bytes = utf8Bytes(value);
  if (bytes > maxBytes) {
    throw new WorklogError(options.reason ?? 'input_too_large', `${field} is ${bytes} UTF-8 bytes; the limit is ${maxBytes}.`, { field, bytes, maxBytes });
  }
  return value;
}

function normalizeRef(value: unknown, reason: WorklogErrorReason = 'invalid_ref'): WorklogRef {
  if (!isPlainRecord(value)) throw new WorklogError(reason, 'Worklog ref must be an object.');
  if (value.kind === 'feature') {
    if (typeof value.featureName !== 'string' || !FEATURE_NAME_PATTERN.test(value.featureName)) {
      throw new WorklogError(reason, `Invalid feature name: ${JSON.stringify(value.featureName)}`);
    }
    return { kind: 'feature', featureName: value.featureName };
  }
  if (value.kind === 'session') {
    if (!isNativeObservationOwner(value.owner)) {
      throw new WorklogError(reason, `Unknown native owner: ${JSON.stringify(value.owner)}`, { owners: [...NATIVE_OBSERVATION_OWNERS] });
    }
    const sessionId = assertText(value.sessionId, 'sessionId', WORKLOG_SESSION_ID_MAX_BYTES, { reason });
    return { kind: 'session', owner: value.owner, sessionId };
  }
  throw new WorklogError(reason, `Unknown worklog kind: ${JSON.stringify(value.kind)}`);
}

function normalizeAuthor(value: unknown, reason: WorklogErrorReason = 'invalid_author'): WorklogAuthor {
  if (!isPlainRecord(value) || !isNativeObservationOwner(value.owner)) {
    throw new WorklogError(reason, 'Worklog author needs a known native owner, a session ID, and an agent name.');
  }
  return {
    owner: value.owner,
    sessionId: assertText(value.sessionId, 'author.sessionId', WORKLOG_SESSION_ID_MAX_BYTES, { reason }),
    agent: assertText(value.agent, 'author.agent', WORKLOG_AGENT_MAX_BYTES, { reason }),
  };
}

/**
 * Stable, human-copyable full identity: `feature:<featureName>` or `session:<owner>:<sessionId>`.
 * Use it for pins and display; route with the structured ref or `parseWorklogKey`.
 */
export function getWorklogKey(ref: WorklogRef): string {
  const normalized = normalizeRef(ref);
  return normalized.kind === 'feature'
    ? `feature:${normalized.featureName}`
    : `session:${normalized.owner}:${normalized.sessionId}`;
}

export function parseWorklogKey(key: string): WorklogRef {
  if (typeof key !== 'string') throw new WorklogError('invalid_ref', 'Worklog key must be a string.');
  if (key.startsWith('feature:')) return normalizeRef({ kind: 'feature', featureName: key.slice('feature:'.length) });
  if (key.startsWith('session:')) {
    const rest = key.slice('session:'.length);
    const separator = rest.indexOf(':');
    if (separator > 0) return normalizeRef({ kind: 'session', owner: rest.slice(0, separator), sessionId: rest.slice(separator + 1) });
  }
  throw new WorklogError('invalid_ref', `Unrecognized worklog key: ${JSON.stringify(key)}`);
}

function sameRef(left: WorklogRef, right: WorklogRef): boolean {
  return getWorklogKey(left) === getWorklogKey(right);
}

function toProjectRelative(projectRoot: string, target: string): string {
  return path.relative(path.resolve(projectRoot), target).split(path.sep).join('/');
}

/** Refuses a target outside the project or with a symlink at any existing component below the project root. */
function assertSafePath(projectRoot: string, target: string): void {
  const root = path.resolve(projectRoot);
  const relative = path.relative(root, path.resolve(target));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new WorklogError('unsafe_path', 'Worklog path escapes the project root.', { path: target });
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw ioError('path', error);
    }
    if (stat.isSymbolicLink()) {
      throw new WorklogError('unsafe_path', `Worklog path contains a symbolic link: ${toProjectRelative(projectRoot, current)}`, {
        path: toProjectRelative(projectRoot, current),
      });
    }
  }
}

/** `lstat` so it never follows a link. Absent is ENOENT or ENOTDIR; any other failure is an I/O failure. */
function lstatOrNull(target: string, stage: WorklogIoStage): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw ioError(stage, error);
  }
}

function pathExists(target: string): boolean {
  return lstatOrNull(target, 'read') !== null;
}

function readFeatureJson(featureJsonPath: string): FeatureJson {
  const stat = fs.lstatSync(featureJsonPath);
  if (!stat.isFile()) throw new Error('feature.json is not a regular file');
  const parsed = JSON.parse(fs.readFileSync(featureJsonPath, 'utf8')) as unknown;
  if (!isPlainRecord(parsed) || typeof parsed.name !== 'string' || !FEATURE_NAME_PATTERN.test(parsed.name)) {
    throw new Error('feature.json has no valid name');
  }
  return parsed as unknown as FeatureJson;
}

interface ResolvedFeature {
  directoryPath: string;
  feature: FeatureJson;
}

/**
 * Requires exactly one feature directory whose metadata names `featureName`, and that the canonical
 * `getFeaturePath` resolver lands on it. A directory alias, a phantom name, or a corrupt candidate never
 * resolves, so no worklog is created beside a feature that does not exist.
 */
function resolveFeature(projectRoot: string, featureName: string): ResolvedFeature {
  const featuresPath = getFeaturesPath(projectRoot);
  assertSafePath(projectRoot, featuresPath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(featuresPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorklogError('feature_not_found', `Feature '${featureName}' not found.`, { featureName });
    }
    throw ioError('feature', error);
  }

  // The directory scan skips a link, and `getFeaturePath` would follow one, so an alias named after the feature
  // is refused whatever it points at. Nothing below probes the alias until this has ruled out a link.
  const alias = path.join(featuresPath, featureName);
  const aliasStat = lstatOrNull(alias, 'feature');
  if (aliasStat?.isSymbolicLink()) {
    throw new WorklogError('unsafe_path', `Worklog path contains a symbolic link: ${toProjectRelative(projectRoot, alias)}`, {
      path: toProjectRelative(projectRoot, alias),
    });
  }

  const matches: ResolvedFeature[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directoryPath = path.join(featuresPath, entry.name);
    try {
      const feature = readFeatureJson(path.join(directoryPath, 'feature.json'));
      if (feature.name === featureName) matches.push({ directoryPath, feature });
    } catch {
      const indexed = entry.name.match(/^\d+[_-](.+)$/);
      if (entry.name === featureName || indexed?.[1] === featureName) unreadable.push(entry.name);
    }
  }

  if (unreadable.length > 0) {
    throw new WorklogError('feature_unreadable', `Feature '${featureName}' cannot be resolved: a candidate directory has unreadable metadata.`, {
      featureName,
      directories: unreadable,
    });
  }
  if (matches.length === 0) throw new WorklogError('feature_not_found', `Feature '${featureName}' not found.`, { featureName });
  if (matches.length > 1) {
    throw new WorklogError('feature_ambiguous', `Feature namespace contains multiple entries named '${featureName}'.`, {
      featureName,
      directories: matches.map((match) => path.basename(match.directoryPath)),
    });
  }

  // `getFeaturePath` returns an existing `features/<name>` as it is. Otherwise it scans every sibling's
  // feature.json through unguarded reads, and that scan can only land on the unique match found above. Ask the
  // canonical resolver only when it can land elsewhere, so a sibling's metadata is never read through it.
  if (aliasStat) {
    const canonical = getFeaturePath(projectRoot, featureName);
    if (path.resolve(canonical) !== path.resolve(matches[0]!.directoryPath)) {
      throw new WorklogError('feature_ambiguous', `Feature '${featureName}' resolves to a different directory than its metadata.`, {
        featureName,
        directories: [path.basename(canonical), path.basename(matches[0]!.directoryPath)],
      });
    }
  }
  return matches[0]!;
}

function sessionWorklogDirectory(projectRoot: string, owner: NativeObservationOwner): string {
  return path.join(getHivePath(projectRoot), ...SESSION_WORKLOG_SEGMENTS, owner);
}

function sessionWorklogPath(projectRoot: string, ref: Extract<WorklogRef, { kind: 'session' }>): string {
  return path.join(sessionWorklogDirectory(projectRoot, ref.owner), `${sha256(ref.sessionId)}.json`);
}

/**
 * Storage path for a log. Feature logs live in the resolved feature directory and require a real, uniquely
 * resolved feature; session logs live under `.hive/worklogs/sessions/<owner>/<sha256(sessionId)>.json`.
 * Throws `unsafe_path` when an existing component is a symbolic link.
 */
export function getWorklogPath(projectRoot: string, ref: WorklogRef): string {
  const normalized = normalizeRef(ref);
  const target = normalized.kind === 'feature'
    ? path.join(resolveFeature(projectRoot, normalized.featureName).directoryPath, FEATURE_WORKLOG_FILE)
    : sessionWorklogPath(projectRoot, normalized);
  assertSafePath(projectRoot, target);
  return target;
}

// ============================================================================
// Input validation
// ============================================================================

function normalizeReference(value: unknown, field: string, reason?: WorklogErrorReason): WorklogReference {
  const fail = (message: string): never => {
    throw new WorklogError(reason ?? 'invalid_argument', `${field}: ${message}`, { field });
  };
  if (!isPlainRecord(value)) return fail('reference must be an object.');
  const label = value.label === undefined
    ? undefined
    : assertText(value.label, `${field}.label`, WORKLOG_REFERENCE_LABEL_MAX_BYTES, { reason });
  if (value.kind === 'path') {
    const target = assertText(value.path, `${field}.path`, WORKLOG_REFERENCE_MAX_BYTES, { reason });
    const posix = path.posix.normalize(target);
    if (
      target.includes('\\')
      || path.posix.isAbsolute(target)
      || /^[A-Za-z]:/.test(target)
      || posix !== target
      || posix === '..'
      || posix.startsWith('../')
      || posix === '.'
    ) {
      fail('path must be a normalized project-relative path without traversal.');
    }
    return label === undefined ? { kind: 'path', path: target } : { kind: 'path', path: target, label };
  }
  if (value.kind === 'url') {
    const url = assertText(value.url, `${field}.url`, WORKLOG_REFERENCE_MAX_BYTES, { reason });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail('url is not a valid absolute URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('url must use http or https.');
    if (parsed.username || parsed.password) fail('url must not embed credentials.');
    return label === undefined ? { kind: 'url', url } : { kind: 'url', url, label };
  }
  return fail(`unknown reference kind ${JSON.stringify(value.kind)}.`);
}

function normalizeCheckpoint(value: unknown, reason?: WorklogErrorReason): WorklogCheckpointInput {
  if (!isPlainRecord(value)) throw new WorklogError(reason ?? 'invalid_argument', 'checkpoint must be an object.');
  const checkpoint: WorklogCheckpointInput = {
    summary: assertText(value.summary, 'checkpoint.summary', WORKLOG_SUMMARY_MAX_BYTES, { reason }),
  };
  if (value.detail !== undefined) {
    checkpoint.detail = assertText(value.detail, 'checkpoint.detail', WORKLOG_DETAIL_MAX_BYTES, { multiline: true, reason });
  }
  if (value.references !== undefined) {
    if (!Array.isArray(value.references)) throw new WorklogError(reason ?? 'invalid_argument', 'checkpoint.references must be an array.');
    if (value.references.length > WORKLOG_REFERENCES_MAX) {
      throw new WorklogError(reason ?? 'input_too_large', `checkpoint.references has ${value.references.length} items; the limit is ${WORKLOG_REFERENCES_MAX}.`);
    }
    checkpoint.references = value.references.map((reference, index) => normalizeReference(reference, `checkpoint.references[${index}]`, reason));
  }
  if (value.corrects !== undefined) {
    if (!Array.isArray(value.corrects) || value.corrects.some((id) => !Number.isSafeInteger(id) || (id as number) < 1)) {
      throw new WorklogError(reason ?? 'invalid_argument', 'checkpoint.corrects must be an array of positive entry IDs.');
    }
    if (value.corrects.length > WORKLOG_CORRECTIONS_MAX) {
      throw new WorklogError(reason ?? 'input_too_large', `checkpoint.corrects has ${value.corrects.length} items; the limit is ${WORKLOG_CORRECTIONS_MAX}.`);
    }
    if (new Set(value.corrects).size !== value.corrects.length) {
      throw new WorklogError(reason ?? 'invalid_argument', 'checkpoint.corrects must not repeat an entry ID.');
    }
    checkpoint.corrects = [...value.corrects] as number[];
  }
  return checkpoint;
}

/** The one operation ID rule: record-time input and every stored entry are held to it. */
function normalizeOperationId(value: unknown, reason?: WorklogErrorReason): string {
  const operationId = assertText(value, 'operationId', WORKLOG_OPERATION_ID_MAX_BYTES, { reason });
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new WorklogError(reason ?? 'invalid_argument', 'operationId may contain only letters, digits, ".", "_", ":", and "-", starting with a letter or digit.', { field: 'operationId' });
  }
  return operationId;
}

function normalizeRecordInput(value: unknown): WorklogRecordInput {
  if (!isPlainRecord(value)) throw new WorklogError('invalid_argument', 'Record input must be an object.');
  const operationId = normalizeOperationId(value.operationId);
  const input: WorklogRecordInput = { operationId, checkpoint: normalizeCheckpoint(value.checkpoint) };
  if (value.title !== undefined) input.title = assertText(value.title, 'title', WORKLOG_TITLE_MAX_BYTES);
  if (value.briefing !== undefined) {
    input.briefing = assertText(value.briefing, 'briefing', WORKLOG_BRIEFING_MAX_BYTES, { multiline: true });
  }
  if (value.expectedRevision !== undefined) {
    if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
      throw new WorklogError('invalid_argument', 'expectedRevision must be a non-negative integer.');
    }
    input.expectedRevision = value.expectedRevision as number;
  }
  if ((input.briefing === undefined) !== (input.expectedRevision === undefined)) {
    throw new WorklogError('invalid_argument', 'expectedRevision is required exactly when briefing is supplied.', {
      briefingSupplied: input.briefing !== undefined,
      expectedRevisionSupplied: input.expectedRevision !== undefined,
    });
  }
  return input;
}

/** Authored payload only: runtime facts, timestamps, and the agent name are excluded. */
function computeRequestHash(input: WorklogRecordInput): string {
  return sha256(canonicalJson({
    version: 1,
    titleSupplied: input.title !== undefined,
    title: input.title,
    checkpoint: input.checkpoint,
    briefing: input.briefing,
    expectedRevision: input.expectedRevision,
  }));
}

function boundedInteger(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new WorklogError('invalid_argument', `${field} must be an integer from 1 to ${max}.`, { field, max });
  }
  return value as number;
}

/** Shortens projected diagnostics (never stored worklog content) at a UTF-8 character boundary. */
function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

// ============================================================================
// Document parsing
// ============================================================================

function corrupt(message: string, details: Record<string, unknown> = {}): WorklogError {
  return new WorklogError('worklog_corrupt', message, details);
}

const FACTS_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** Canonical ISO form, the only shape this service writes. */
function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Stored entries obey the limits record enforces, so a log that reads cleanly can always be paged and rewritten. */
function parseStoredEntry(value: unknown, index: number): StoredEntry {
  const where = `entries[${index}]`;
  if (!isPlainRecord(value)) throw corrupt(`${where} is not an object.`);
  if (value.id !== index + 1) throw corrupt(`${where} has id ${JSON.stringify(value.id)}; IDs must be contiguous from 1.`);
  if (typeof value.requestHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.requestHash)) throw corrupt(`${where} has an invalid requestHash.`);
  if (!isCanonicalTimestamp(value.recordedAt)) throw corrupt(`${where} has no canonical recordedAt timestamp.`);
  let operationId: string;
  let author: WorklogAuthor;
  let checkpoint: WorklogCheckpointInput;
  let briefing: WorklogEntryBriefing | undefined;
  try {
    operationId = normalizeOperationId(value.operationId, 'worklog_corrupt');
    author = normalizeAuthor(value.author, 'worklog_corrupt');
    checkpoint = normalizeCheckpoint(value.checkpoint, 'worklog_corrupt');
    if (value.briefing !== undefined) {
      const stored = value.briefing;
      if (!isPlainRecord(stored)
        || !(stored.factsFingerprint === null
          || (typeof stored.factsFingerprint === 'string' && FACTS_FINGERPRINT_PATTERN.test(stored.factsFingerprint)))) {
        throw new Error('briefing needs text and a facts fingerprint that is null or a SHA-256 digest.');
      }
      briefing = {
        text: assertText(stored.text, 'briefing.text', WORKLOG_BRIEFING_MAX_BYTES, { multiline: true, reason: 'worklog_corrupt' }),
        factsFingerprint: stored.factsFingerprint as string | null,
      };
    }
  } catch (error) {
    throw corrupt(`${where}: ${(error as Error).message}`);
  }
  if (checkpoint.corrects?.some((id) => id > index)) throw corrupt(`${where} corrects an entry that is not earlier.`);
  const entry: StoredEntry = {
    id: index + 1,
    operationId,
    requestHash: value.requestHash,
    author,
    recordedAt: value.recordedAt,
    checkpoint,
  };
  if (briefing) entry.briefing = briefing;
  const bytes = serializedBytes(publicEntry(entry));
  if (bytes > WORKLOG_ENTRY_MAX_BYTES) {
    throw corrupt(`${where} serializes to ${bytes} bytes; the entry limit is ${WORKLOG_ENTRY_MAX_BYTES}.`, { bytes, maxBytes: WORKLOG_ENTRY_MAX_BYTES });
  }
  return entry;
}

/** Cross-entry rules: unique retry identities, session ownership, and the per-entry correction cap. */
function checkEntryRelations(ref: WorklogRef, entries: StoredEntry[]): void {
  const identities = new Set<string>();
  const corrections = new Map<number, number>();
  for (const entry of entries) {
    const where = `entries[${entry.id - 1}]`;
    const identity = JSON.stringify([entry.author.owner, entry.author.sessionId, entry.operationId]);
    if (identities.has(identity)) throw corrupt(`${where} repeats the operationId '${entry.operationId}' of its author session.`);
    identities.add(identity);
    if (ref.kind === 'session' && (entry.author.owner !== ref.owner || entry.author.sessionId !== ref.sessionId)) {
      throw corrupt(`${where} was written by a different session than this session worklog.`);
    }
    for (const id of entry.checkpoint.corrects ?? []) {
      const count = (corrections.get(id) ?? 0) + 1;
      if (count > WORKLOG_CORRECTED_BY_MAX) throw corrupt(`Entry ${id} is corrected more than ${WORKLOG_CORRECTED_BY_MAX} times.`);
      corrections.set(id, count);
    }
  }
}

/** `expected` is the ref implied by the storage location; null only for discovery, which checks location separately. */
function parseDocument(raw: unknown, expected: WorklogRef | null): WorklogDocument {
  if (!isPlainRecord(raw)) throw corrupt('Worklog document is not an object.');
  if (raw.schemaVersion !== WORKLOG_SCHEMA_VERSION) {
    if (typeof raw.schemaVersion === 'number') {
      throw new WorklogError('unsupported_schema', `Worklog schema version ${raw.schemaVersion} is not supported by this version of Hive.`, {
        schemaVersion: raw.schemaVersion,
        supported: WORKLOG_SCHEMA_VERSION,
      });
    }
    throw corrupt('Worklog document has no schema version.');
  }
  if (typeof raw.logId !== 'string' || !/^[0-9a-f]{32}$/.test(raw.logId)) throw corrupt('Worklog document has an invalid logId.');
  let ref: WorklogRef;
  try {
    ref = normalizeRef(raw.ref, 'worklog_corrupt');
  } catch (error) {
    throw corrupt(`Worklog ref is invalid: ${(error as Error).message}`);
  }
  if (expected && !sameRef(ref, expected)) {
    throw corrupt('Worklog document belongs to a different ref than its storage location.', {
      storedKey: getWorklogKey(ref),
      expectedKey: getWorklogKey(expected),
    });
  }
  let title: string;
  try {
    title = assertText(raw.title, 'title', WORKLOG_TITLE_MAX_BYTES, { reason: 'worklog_corrupt' });
  } catch (error) {
    throw corrupt(`Worklog ${(error as Error).message}`);
  }
  if (!isCanonicalTimestamp(raw.createdAt) || !isCanonicalTimestamp(raw.updatedAt)) {
    throw corrupt('Worklog document needs canonical createdAt and updatedAt timestamps.');
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0 || raw.revision !== raw.entries.length) {
    throw corrupt('Worklog revision must equal its non-zero entry count.');
  }
  const entries = raw.entries.map(parseStoredEntry);
  checkEntryRelations(ref, entries);
  const latestBriefing = [...entries].reverse().find((entry) => entry.briefing !== undefined);
  if ((raw.briefingEntryId ?? null) !== (latestBriefing?.id ?? null) || raw.briefingEntryId === undefined) {
    throw corrupt('Worklog briefingEntryId must name the latest entry carrying a briefing.');
  }
  return {
    schemaVersion: WORKLOG_SCHEMA_VERSION,
    logId: raw.logId,
    ref,
    title,
    revision: raw.revision as number,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    briefingEntryId: latestBriefing?.id ?? null,
    entries,
  };
}

/** Reads and validates a stored log. Missing returns null; corruption and unsupported versions throw. */
function readDocument(filePath: string, expected: WorklogRef | null): WorklogDocument | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw ioError('read', error);
  }
  if (stat.isSymbolicLink()) throw new WorklogError('unsafe_path', 'Worklog file is a symbolic link.');
  if (!stat.isFile()) throw corrupt('Worklog path is not a regular file.');
  if (stat.size > WORKLOG_LOG_MAX_BYTES) {
    throw new WorklogError('worklog_too_large', `Worklog file is ${stat.size} bytes; the supported limit is ${WORKLOG_LOG_MAX_BYTES}.`, {
      bytes: stat.size,
      maxBytes: WORKLOG_LOG_MAX_BYTES,
    });
  }
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    throw ioError('read', error);
  }
  if (buffer.length > WORKLOG_LOG_MAX_BYTES) {
    throw new WorklogError('worklog_too_large', `Worklog file is ${buffer.length} bytes; the supported limit is ${WORKLOG_LOG_MAX_BYTES}.`, {
      bytes: buffer.length,
      maxBytes: WORKLOG_LOG_MAX_BYTES,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch (error) {
    throw corrupt(`Worklog file is not valid UTF-8 JSON: ${(error as Error).message}`);
  }
  return parseDocument(raw, expected);
}

function publicEntry(entry: StoredEntry, correctedBy?: number[]): WorklogEntry {
  const { requestHash: _requestHash, ...rest } = entry;
  return correctedBy && correctedBy.length > 0 ? { ...rest, correctedBy } : { ...rest };
}

// ============================================================================
// Cursors and paging
// ============================================================================

type CursorPayload =
  | { v: 1; view: 'history'; key: string; logId: string; anchor: number; next: number }
  | { v: 1; view: 'facts'; key: string; fingerprint: string; position: number }
  | { v: 1; view: 'list'; kind: WorklogKind | null; inventory: string; position: number };

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor<V extends CursorPayload['view']>(cursor: unknown, view: V): Extract<CursorPayload, { view: V }> {
  if (typeof cursor !== 'string' || cursor.length === 0 || utf8Bytes(cursor) > CURSOR_MAX_BYTES) {
    throw new WorklogError('invalid_cursor', 'Cursor is empty, oversized, or not a string.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new WorklogError('invalid_cursor', 'Cursor is malformed.');
  }
  const valid = isPlainRecord(parsed) && parsed.v === 1 && parsed.view === view && (
    view === 'history'
      ? typeof parsed.key === 'string' && typeof parsed.logId === 'string'
        && Number.isSafeInteger(parsed.anchor) && Number.isSafeInteger(parsed.next)
        && (parsed.next as number) >= 1 && (parsed.next as number) <= (parsed.anchor as number)
      : view === 'facts'
        ? typeof parsed.key === 'string' && typeof parsed.fingerprint === 'string'
          && Number.isSafeInteger(parsed.position) && (parsed.position as number) >= 1
        : (parsed.kind === null || parsed.kind === 'feature' || parsed.kind === 'session')
          && typeof parsed.inventory === 'string'
          && Number.isSafeInteger(parsed.position) && (parsed.position as number) >= 1
  );
  if (!valid) throw new WorklogError('invalid_cursor', `Cursor is not a valid ${view} cursor.`);
  return parsed as Extract<CursorPayload, { view: V }>;
}

function serializedBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

/**
 * Adds items while the whole serialized response stays within `maxBytes`. When the first item alone does not
 * fit, a strict page fails with `response_too_large` instead of returning an empty page that cannot progress.
 */
function fillPage<T, R>(
  count: number,
  item: (index: number) => T,
  build: (items: T[], taken: number) => R,
  maxBytes: number,
  strict: boolean,
): R {
  const items: T[] = [];
  let result = build(items, 0);
  const envelopeBytes = serializedBytes(result);
  if (envelopeBytes > maxBytes) {
    throw new WorklogError('response_too_large', `The response envelope needs ${envelopeBytes} bytes; maxBytes is ${maxBytes}.`, {
      requiredBytes: envelopeBytes,
      maxBytes,
    });
  }
  for (let index = 0; index < count; index++) {
    const candidateItems = [...items, item(index)];
    const candidate = build(candidateItems, index + 1);
    const bytes = serializedBytes(candidate);
    if (bytes > maxBytes) {
      if (items.length === 0 && strict) {
        throw new WorklogError('response_too_large', `The next item needs a ${bytes}-byte response; maxBytes is ${maxBytes}.`, {
          requiredBytes: bytes,
          maxBytes,
          maxAllowedBytes: WORKLOG_MAX_RESPONSE_BYTES,
        });
      }
      break;
    }
    items.push(candidateItems[candidateItems.length - 1]!);
    result = candidate;
  }
  return result;
}

// ============================================================================
// Recorded facts
// ============================================================================

const TASK_STATUS_KEYS: ReadonlyArray<TaskStatusType | 'invalid'> = [
  'pending', 'in_progress', 'done', 'cancelled', 'blocked', 'failed', 'partial', 'invalid',
];

function emptyCounts(): Record<TaskStatusType | 'invalid', number> {
  return Object.fromEntries(TASK_STATUS_KEYS.map((key) => [key, 0])) as Record<TaskStatusType | 'invalid', number>;
}

interface FactsProjection {
  summary: WorklogFactsSummary;
  rows: WorklogFactRow[];
}

function diagnostic(message: string): string {
  return truncateUtf8(message, DIAGNOSTIC_MAX_BYTES).text;
}

// ============================================================================
// Service
// ============================================================================

export interface WorklogServiceOptions {
  now?: () => Date;
}

/**
 * Human-readable progress logs: one shared log per feature and one per native-owner primary session. Each log
 * holds append-only checkpoints and a current briefing that dereferences the entry that last set it.
 * Recorded task facts are projected separately at read time and never stored as narrative.
 */
export class WorklogService {
  private readonly now: () => Date;

  constructor(private readonly projectRoot: string, options: WorklogServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  record(ref: WorklogRef, input: WorklogRecordInput, author: WorklogAuthor): WorklogRecordResult {
    const normalizedRef = normalizeRef(ref);
    const normalizedAuthor = normalizeAuthor(author);
    if (normalizedRef.kind === 'session'
      && (normalizedAuthor.owner !== normalizedRef.owner || normalizedAuthor.sessionId !== normalizedRef.sessionId)) {
      throw new WorklogError('author_mismatch', 'A session worklog can be recorded only by its own native session.', {
        key: getWorklogKey(normalizedRef),
      });
    }
    const normalizedInput = normalizeRecordInput(input);
    const requestHash = computeRequestHash(normalizedInput);
    const key = getWorklogKey(normalizedRef);
    const resolvedFeature = normalizedRef.kind === 'feature' ? resolveFeature(this.projectRoot, normalizedRef.featureName) : null;
    const filePath = resolvedFeature
      ? path.join(resolvedFeature.directoryPath, FEATURE_WORKLOG_FILE)
      : sessionWorklogPath(this.projectRoot, normalizedRef as Extract<WorklogRef, { kind: 'session' }>);
    assertSafePath(this.projectRoot, filePath);

    let release: () => void;
    try {
      release = acquireLockSync(filePath);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Failed to acquire lock')) {
        throw new WorklogError('worklog_locked', `${error.message} Nothing was recorded; retry with the same operationId.`, { key });
      }
      throw ioError('lock', error);
    }
    try {
      // The lock may have created missing parent directories; re-check them before trusting the path.
      assertSafePath(this.projectRoot, filePath);
      const current = readDocument(filePath, normalizedRef);

      const prior = current?.entries.find((entry) => entry.operationId === normalizedInput.operationId
        && entry.author.owner === normalizedAuthor.owner
        && entry.author.sessionId === normalizedAuthor.sessionId);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new WorklogError('operation_conflict', `operationId '${normalizedInput.operationId}' was already used for a different request in this worklog.`, {
            key,
            operationId: normalizedInput.operationId,
            entryId: prior.id,
          });
        }
        return {
          ref: normalizedRef,
          key,
          entry: publicEntry(prior),
          committedRevision: prior.id,
          currentRevision: current!.revision,
          replayed: true,
          briefingUpdated: prior.briefing !== undefined,
        };
      }

      const currentRevision = current?.revision ?? 0;
      if (current && normalizedInput.title !== undefined && normalizedInput.title !== current.title) {
        throw new WorklogError('title_conflict', 'The worklog title is set when the log is created and cannot be changed.', {
          key,
          title: current.title,
        });
      }
      if (normalizedInput.briefing !== undefined && normalizedInput.expectedRevision !== currentRevision) {
        throw new WorklogError('stale_revision', `The worklog is at revision ${currentRevision}, not ${normalizedInput.expectedRevision}. Read it again and reconcile the briefing.`, {
          key,
          expectedRevision: normalizedInput.expectedRevision,
          currentRevision,
        });
      }
      const invalidCorrection = normalizedInput.checkpoint.corrects?.find((id) => id > currentRevision);
      if (invalidCorrection !== undefined) {
        throw new WorklogError('invalid_correction', `Entry ${invalidCorrection} does not exist in this worklog.`, {
          key,
          entryId: invalidCorrection,
          currentRevision,
        });
      }
      if (current && normalizedInput.checkpoint.corrects) {
        const correctedBy = this.correctionsUpTo(current, currentRevision);
        const saturated = normalizedInput.checkpoint.corrects.find((id) => (correctedBy.get(id)?.length ?? 0) >= WORKLOG_CORRECTED_BY_MAX);
        if (saturated !== undefined) {
          throw new WorklogError('invalid_correction', `Entry ${saturated} already has ${WORKLOG_CORRECTED_BY_MAX} corrections; correct the latest correction instead.`, {
            key,
            entryId: saturated,
            maxCorrections: WORKLOG_CORRECTED_BY_MAX,
          });
        }
      }

      const recordedAt = this.now().toISOString();
      const entry: StoredEntry = {
        id: currentRevision + 1,
        operationId: normalizedInput.operationId,
        requestHash,
        author: normalizedAuthor,
        recordedAt,
        checkpoint: normalizedInput.checkpoint,
      };
      if (normalizedInput.briefing !== undefined) {
        entry.briefing = {
          text: normalizedInput.briefing,
          factsFingerprint: this.projectFacts(normalizedRef, resolvedFeature).summary.fingerprint,
        };
      }
      const entryBytes = serializedBytes(publicEntry(entry));
      if (entryBytes > WORKLOG_ENTRY_MAX_BYTES) {
        throw new WorklogError('input_too_large', `The entry serializes to ${entryBytes} bytes; the limit is ${WORKLOG_ENTRY_MAX_BYTES}.`, {
          key,
          bytes: entryBytes,
          maxBytes: WORKLOG_ENTRY_MAX_BYTES,
        });
      }
      const next: WorklogDocument = current
        ? {
          ...current,
          revision: entry.id,
          updatedAt: recordedAt,
          briefingEntryId: entry.briefing ? entry.id : current.briefingEntryId,
          entries: [...current.entries, entry],
        }
        : {
          schemaVersion: WORKLOG_SCHEMA_VERSION,
          logId: crypto.randomBytes(16).toString('hex'),
          ref: normalizedRef,
          title: normalizedInput.title ?? normalizedInput.checkpoint.summary,
          revision: entry.id,
          createdAt: recordedAt,
          updatedAt: recordedAt,
          briefingEntryId: entry.briefing ? entry.id : null,
          entries: [entry],
        };
      const serialized = JSON.stringify(next, null, 2);
      const bytes = utf8Bytes(serialized);
      if (bytes > WORKLOG_LOG_MAX_BYTES) {
        throw new WorklogError('worklog_full', `Recording would grow this worklog to ${bytes} bytes, past the ${WORKLOG_LOG_MAX_BYTES}-byte limit. Nothing was recorded.`, {
          key,
          bytes,
          maxBytes: WORKLOG_LOG_MAX_BYTES,
        });
      }
      try {
        writeAtomicDurable(filePath, serialized);
      } catch (error) {
        throw ioError('write', error);
      }
      return {
        ref: normalizedRef,
        key,
        entry: publicEntry(entry),
        committedRevision: entry.id,
        currentRevision: entry.id,
        replayed: false,
        briefingUpdated: entry.briefing !== undefined,
      };
    } finally {
      release();
    }
  }

  read(ref: WorklogRef, options?: WorklogReadOptions & { view?: 'brief' }): WorklogBriefRead;
  read(ref: WorklogRef, options: WorklogReadOptions & { view: 'history' }): WorklogHistoryRead;
  read(ref: WorklogRef, options: WorklogReadOptions & { view: 'facts' }): WorklogFactsRead;
  read(ref: WorklogRef, options?: WorklogReadOptions): WorklogReadResult;
  read(ref: WorklogRef, options: WorklogReadOptions = {}): WorklogReadResult {
    const normalizedRef = normalizeRef(ref);
    const view = options.view ?? 'brief';
    if (view !== 'brief' && view !== 'history' && view !== 'facts') {
      throw new WorklogError('invalid_argument', `Unknown worklog view: ${JSON.stringify(view)}`);
    }
    const maxBytes = boundedInteger(options.maxBytes, 'maxBytes', WORKLOG_DEFAULT_RESPONSE_BYTES, WORKLOG_MAX_RESPONSE_BYTES);
    const key = getWorklogKey(normalizedRef);
    const resolvedFeature = normalizedRef.kind === 'feature' ? resolveFeature(this.projectRoot, normalizedRef.featureName) : null;
    const filePath = resolvedFeature
      ? path.join(resolvedFeature.directoryPath, FEATURE_WORKLOG_FILE)
      : sessionWorklogPath(this.projectRoot, normalizedRef as Extract<WorklogRef, { kind: 'session' }>);
    assertSafePath(this.projectRoot, filePath);

    if (view === 'facts') {
      const limit = boundedInteger(options.limit, 'limit', WORKLOG_DEFAULT_LIMIT, WORKLOG_MAX_LIMIT);
      return this.readFacts(normalizedRef, key, resolvedFeature, pathExists(filePath), limit, maxBytes, options.cursor);
    }
    const doc = readDocument(filePath, normalizedRef);

    if (view === 'history') {
      const limit = boundedInteger(options.limit, 'limit', WORKLOG_DEFAULT_LIMIT, WORKLOG_MAX_LIMIT);
      return this.readHistory(normalizedRef, key, doc, limit, maxBytes, options.cursor);
    }
    if (options.cursor !== undefined) {
      throw new WorklogError('invalid_argument', 'The brief view takes no cursor; continue its recent page with the history view.');
    }
    const limit = boundedInteger(options.limit, 'limit', WORKLOG_BRIEF_RECENT_DEFAULT, WORKLOG_MAX_LIMIT);
    return this.readBrief(normalizedRef, key, resolvedFeature, doc, limit, maxBytes);
  }

  list(options: WorklogListOptions = {}): WorklogListResult {
    const kind = options.kind ?? null;
    if (kind !== null && kind !== 'feature' && kind !== 'session') {
      throw new WorklogError('invalid_argument', `Unknown worklog kind: ${JSON.stringify(kind)}`);
    }
    const limit = boundedInteger(options.limit, 'limit', WORKLOG_DEFAULT_LIMIT, WORKLOG_MAX_LIMIT);
    const maxBytes = boundedInteger(options.maxBytes, 'maxBytes', WORKLOG_DEFAULT_RESPONSE_BYTES, WORKLOG_MAX_RESPONSE_BYTES);
    const candidates = this.discover(kind);
    const inventory = sha256(canonicalJson(candidates.map((candidate) => [candidate.location, candidate.fingerprint])));

    let position = 0;
    if (options.cursor !== undefined) {
      const cursor = decodeCursor(options.cursor, 'list');
      if (cursor.kind !== kind) throw new WorklogError('invalid_cursor', 'Cursor was issued for a different kind filter.');
      if (cursor.inventory !== inventory || cursor.position >= candidates.length) {
        throw new WorklogError('stale_cursor', 'The worklog inventory changed after this cursor was issued. Restart the list.');
      }
      position = cursor.position;
    }

    const remaining = candidates.slice(position, position + limit);
    return fillPage(
      remaining.length,
      (index) => this.summarizeCandidate(remaining[index]!),
      (items, taken): WorklogListResult => {
        const nextPosition = position + taken;
        const nextCursor = nextPosition < candidates.length ? encodeCursor({ v: 1, view: 'list', kind, inventory, position: nextPosition }) : null;
        return {
          worklogs: items.flatMap((item) => (item.summary ? [item.summary] : [])),
          errors: items.flatMap((item) => (item.error ? [item.error] : [])),
          complete: nextCursor === null,
          nextCursor,
        };
      },
      maxBytes,
      true,
    );
  }

  // --------------------------------------------------------------------------
  // Views
  // --------------------------------------------------------------------------

  private readBrief(
    ref: WorklogRef,
    key: string,
    resolvedFeature: ResolvedFeature | null,
    doc: WorklogDocument | null,
    limit: number,
    maxBytes: number,
  ): WorklogBriefRead {
    const facts = this.projectFacts(ref, resolvedFeature).summary;
    const briefingEntry = doc?.briefingEntryId ? doc.entries[doc.briefingEntryId - 1]! : null;
    const briefing = briefingEntry?.briefing
      ? { ...briefingEntry.briefing, entryId: briefingEntry.id, author: briefingEntry.author, recordedAt: briefingEntry.recordedAt }
      : null;
    const changedSinceBriefing = briefing && briefing.factsFingerprint !== null && facts.fingerprint !== null
      ? briefing.factsFingerprint !== facts.fingerprint
      : null;
    const revision = doc?.revision ?? 0;
    const correctedBy = doc ? this.correctionsUpTo(doc, revision) : new Map<number, number[]>();
    return fillPage(
      Math.min(limit, revision),
      (index) => publicEntry(doc!.entries[revision - 1 - index]!, correctedBy.get(revision - index)),
      (entries, taken): WorklogBriefRead => ({
        view: 'brief',
        ref,
        key,
        exists: doc !== null,
        title: doc?.title ?? null,
        revision,
        entryCount: revision,
        createdAt: doc?.createdAt ?? null,
        updatedAt: doc?.updatedAt ?? null,
        briefing,
        checkpointsSinceBriefing: revision - (doc?.briefingEntryId ?? 0),
        facts,
        changedSinceBriefing,
        recent: {
          entries,
          nextCursor: doc && revision - taken >= 1
            ? encodeCursor({ v: 1, view: 'history', key, logId: doc.logId, anchor: revision, next: revision - taken })
            : null,
        },
      }),
      maxBytes,
      false,
    );
  }

  private readHistory(
    ref: WorklogRef,
    key: string,
    doc: WorklogDocument | null,
    limit: number,
    maxBytes: number,
    cursorValue: string | undefined,
  ): WorklogHistoryRead {
    let anchor = doc?.revision ?? 0;
    let next = anchor;
    if (cursorValue !== undefined) {
      const cursor = decodeCursor(cursorValue, 'history');
      if (cursor.key !== key) throw new WorklogError('invalid_cursor', 'Cursor was issued for a different worklog.');
      if (!doc || cursor.logId !== doc.logId || cursor.anchor > doc.revision) {
        throw new WorklogError('stale_cursor', 'The worklog file was replaced after this cursor was issued. Restart the history read.');
      }
      anchor = cursor.anchor;
      next = cursor.next;
    }
    const correctedBy = doc ? this.correctionsUpTo(doc, anchor) : new Map<number, number[]>();
    return fillPage(
      Math.min(limit, next),
      (index) => publicEntry(doc!.entries[next - 1 - index]!, correctedBy.get(next - index)),
      (entries, taken): WorklogHistoryRead => {
        const nextCursor = doc && next - taken >= 1
          ? encodeCursor({ v: 1, view: 'history', key, logId: doc.logId, anchor, next: next - taken })
          : null;
        return {
          view: 'history',
          ref,
          key,
          exists: doc !== null,
          anchorRevision: anchor,
          currentRevision: doc?.revision ?? 0,
          entries,
          complete: nextCursor === null,
          nextCursor,
        };
      },
      maxBytes,
      true,
    );
  }

  private readFacts(
    ref: WorklogRef,
    key: string,
    resolvedFeature: ResolvedFeature | null,
    exists: boolean,
    limit: number,
    maxBytes: number,
    cursorValue: string | undefined,
  ): WorklogFactsRead {
    const projection = this.projectFacts(ref, resolvedFeature);
    const fingerprint = projection.summary.fingerprint;
    let position = 0;
    if (cursorValue !== undefined) {
      const cursor = decodeCursor(cursorValue, 'facts');
      if (cursor.key !== key) throw new WorklogError('invalid_cursor', 'Cursor was issued for a different worklog.');
      if (fingerprint === null || cursor.fingerprint !== fingerprint || cursor.position >= projection.rows.length) {
        throw new WorklogError('stale_cursor', 'Recorded facts changed after this cursor was issued. Restart the facts read.');
      }
      position = cursor.position;
    }
    const remaining = projection.rows.slice(position, position + limit);
    const unavailable = projection.summary.state === 'unavailable';
    return fillPage(
      remaining.length,
      (index) => remaining[index]!,
      (rows, taken): WorklogFactsRead => {
        const nextPosition = position + taken;
        const nextCursor = fingerprint !== null && nextPosition < projection.rows.length
          ? encodeCursor({ v: 1, view: 'facts', key, fingerprint, position: nextPosition })
          : null;
        return {
          view: 'facts',
          ref,
          key,
          exists,
          facts: projection.summary,
          rows,
          complete: !unavailable && nextCursor === null,
          nextCursor,
        };
      },
      maxBytes,
      true,
    );
  }

  private correctionsUpTo(doc: WorklogDocument, anchor: number): Map<number, number[]> {
    const correctedBy = new Map<number, number[]>();
    for (const entry of doc.entries.slice(0, anchor)) {
      for (const id of entry.checkpoint.corrects ?? []) {
        correctedBy.set(id, [...(correctedBy.get(id) ?? []), entry.id]);
      }
    }
    return correctedBy;
  }

  // --------------------------------------------------------------------------
  // Facts
  // --------------------------------------------------------------------------

  private projectFacts(ref: WorklogRef, resolvedFeature: ResolvedFeature | null): FactsProjection {
    const summary: WorklogFactsSummary = {
      state: 'not_applicable',
      notice: WORKLOG_FACTS_NOTICE,
      observedAt: this.now().toISOString(),
      fingerprint: null,
      featureStatus: null,
      taskCount: 0,
      counts: emptyCounts(),
      runnableCount: 0,
      dependencyBlockedCount: 0,
      diagnostics: [],
    };
    if (ref.kind === 'session' || !resolvedFeature) return { summary, rows: [] };

    summary.featureStatus = resolvedFeature.feature.status ?? null;
    const tasksDir = path.join(resolvedFeature.directoryPath, 'tasks');
    let entries: TaskStatusEntry[];
    try {
      // The resolved directory is passed in, and every path is checked before it is read, so a linked tasks
      // directory or status file never contributes facts and no sibling feature's metadata is scanned.
      entries = readTaskStatusEntries(tasksDir, (target) => assertSafePath(this.projectRoot, target));
    } catch (error) {
      summary.state = 'unavailable';
      summary.diagnostics.push(diagnostic(`Task records could not be listed: ${error instanceof Error ? error.message : String(error)}`));
      return { summary, rows: [] };
    }

    const graph = computeRunnableAndBlocked(entries.flatMap((entry) => ('integrity' in entry ? [] : [{
      folder: entry.folder,
      status: entry.status,
      dependsOn: entry.dependsOn,
    }])));
    const runnable = new Set(graph.runnable);
    const fingerprintRows: unknown[] = [];
    const rows = entries.map((entry): WorklogFactRow => {
      const taskDir = path.join(tasksDir, entry.folder);
      const sources: WorklogFactRow['sources'] = { status: toProjectRelative(this.projectRoot, path.join(taskDir, 'status.json')) };
      if ('integrity' in entry) {
        summary.counts.invalid += 1;
        if (summary.diagnostics.length < DIAGNOSTICS_MAX) summary.diagnostics.push(diagnostic(`Task '${entry.folder}': ${entry.integrity.reason}`));
        fingerprintRows.push({ folder: entry.folder, integrity: entry.integrity.reason });
        return {
          folder: entry.folder,
          name: entry.name,
          status: null,
          dependsOn: [],
          integrity: entry.integrity.error === undefined
            ? { reason: entry.integrity.reason }
            : { reason: entry.integrity.reason, error: diagnostic(entry.integrity.error) },
          runnable: false,
          waitingOn: [],
          sources,
        };
      }
      // Source links are optional pointers, so a task directory that cannot be probed costs this row its links
      // and leaves a diagnostic; it never costs the read its facts. A task with an integrity problem is not probed.
      for (const [field, file] of [['report', 'report.md'], ['spec', 'spec.md']] as const) {
        try {
          if (pathExists(path.join(taskDir, file))) sources[field] = toProjectRelative(this.projectRoot, path.join(taskDir, file));
        } catch (error) {
          if (summary.diagnostics.length < DIAGNOSTICS_MAX) {
            summary.diagnostics.push(diagnostic(`Task '${entry.folder}': source links were not checked: ${(error as Error).message}`));
          }
          break;
        }
      }
      summary.counts[entry.status] += 1;
      fingerprintRows.push({
        folder: entry.folder,
        status: entry.status,
        origin: entry.origin,
        planTitle: entry.planTitle,
        dependsOn: entry.dependsOn,
        blocker: entry.blocker as TaskBlocker | undefined,
      });
      const row: WorklogFactRow = {
        folder: entry.folder,
        name: entry.name,
        status: entry.status,
        dependsOn: [...entry.dependsOn],
        runnable: runnable.has(entry.folder),
        waitingOn: graph.blocked[entry.folder] ?? [],
        sources,
      };
      if (entry.origin) row.origin = entry.origin;
      if (entry.planTitle) row.planTitle = truncateUtf8(entry.planTitle, FACT_TEXT_MAX_BYTES).text;
      if (entry.blocker) {
        const reason = truncateUtf8(String(entry.blocker.reason ?? ''), FACT_TEXT_MAX_BYTES);
        row.blocker = { reason: reason.text, truncated: reason.truncated || Object.keys(entry.blocker).some((field) => field !== 'reason') };
      }
      return row;
    });

    summary.taskCount = entries.length;
    summary.runnableCount = graph.runnable.length;
    summary.dependencyBlockedCount = Object.keys(graph.blocked).length;
    summary.state = summary.counts.invalid > 0 ? 'partial' : 'recorded';
    summary.fingerprint = sha256(canonicalJson({ featureStatus: summary.featureStatus, tasks: fingerprintRows }));
    return { summary, rows };
  }

  // --------------------------------------------------------------------------
  // Discovery
  // --------------------------------------------------------------------------

  private discover(kind: WorklogKind | null): Array<{ kind: WorklogKind; filePath: string; location: string; fingerprint: string; mtimeMs: number; unsafe?: string }> {
    const found: Array<{ kind: WorklogKind; filePath: string; location: string; fingerprint: string; mtimeMs: number; unsafe?: string }> = [];
    const add = (candidateKind: WorklogKind, filePath: string): void => {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw ioError('discover', error);
      }
      if (found.length >= WORKLOG_LIST_CANDIDATE_MAX) {
        throw new WorklogError('inventory_too_large', `More than ${WORKLOG_LIST_CANDIDATE_MAX} worklog files were found.`, { maxCandidates: WORKLOG_LIST_CANDIDATE_MAX });
      }
      found.push({
        kind: candidateKind,
        filePath,
        location: toProjectRelative(this.projectRoot, filePath),
        fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
        mtimeMs: stat.mtimeMs,
        unsafe: stat.isSymbolicLink() ? 'Worklog file is a symbolic link.' : stat.isFile() ? undefined : 'Worklog path is not a regular file.',
      });
    };
    const directoryEntries = (directory: string): fs.Dirent[] => {
      assertSafePath(this.projectRoot, directory);
      try {
        return fs.readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw ioError('discover', error);
      }
    };

    if (kind !== 'session') {
      const featuresPath = getFeaturesPath(this.projectRoot);
      for (const entry of directoryEntries(featuresPath)) {
        if (entry.isDirectory()) add('feature', path.join(featuresPath, entry.name, FEATURE_WORKLOG_FILE));
      }
    }
    if (kind !== 'feature') {
      for (const owner of NATIVE_OBSERVATION_OWNERS) {
        const directory = sessionWorklogDirectory(this.projectRoot, owner);
        for (const entry of directoryEntries(directory)) {
          if (SESSION_FILE_PATTERN.test(entry.name)) add('session', path.join(directory, entry.name));
        }
      }
    }
    return found.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.location < right.location ? -1 : left.location > right.location ? 1 : 0));
  }

  private summarizeCandidate(candidate: ReturnType<WorklogService['discover']>[number]): { summary?: WorklogSummary; error?: WorklogListError } {
    const fail = (reason: WorklogErrorReason, message: string) => ({ error: { location: candidate.location, reason, message: diagnostic(message) } });
    if (candidate.unsafe) return fail('unsafe_path', candidate.unsafe);
    try {
      const doc = readDocument(candidate.filePath, null);
      if (!doc) return fail('worklog_corrupt', 'Worklog file disappeared during listing.');
      if (doc.ref.kind !== candidate.kind) return fail('worklog_corrupt', 'Worklog ref kind does not match its storage location.');
      if (doc.ref.kind === 'feature') {
        let feature: FeatureJson;
        try {
          feature = readFeatureJson(path.join(path.dirname(candidate.filePath), 'feature.json'));
        } catch (error) {
          return fail('feature_unreadable', `The feature metadata beside this worklog is unreadable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (feature.name !== doc.ref.featureName) return fail('worklog_corrupt', 'Worklog ref does not match the feature metadata beside it.');
      } else {
        const expected = sessionWorklogPath(this.projectRoot, doc.ref);
        if (path.resolve(expected) !== path.resolve(candidate.filePath)) return fail('worklog_corrupt', 'Worklog ref does not match its storage location.');
      }
      return {
        summary: {
          ref: doc.ref,
          key: getWorklogKey(doc.ref),
          title: doc.title,
          revision: doc.revision,
          entryCount: doc.entries.length,
          briefingEntryId: doc.briefingEntryId,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
          location: candidate.location,
        },
      };
    } catch (error) {
      if (error instanceof WorklogError) return fail(error.reason, error.message);
      throw error;
    }
  }
}
