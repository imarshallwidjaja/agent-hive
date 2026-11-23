import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'node:util';
import { acquireLockSync, getHivePath, syncDirectory, writeAtomicDurable } from '../utils/paths.js';
import { isNativeObservationOwner } from '../native-observations.js';
import type { WorklogAuthor } from './worklogService.js';

// ============================================================================
// Public contract
// ============================================================================

export const EXPLORATION_SCHEMA_VERSION = 1;

const MAX_DOC_BYTES = 48 * 1024;
/**
 * Room kept free below `maxDocBytes` while an exploration is active, so a close that adds nothing but its status,
 * conclusion or reason, `closedAt`, a new author and a receipt always fits. Its worst case is a 1024-byte note of
 * characters that JSON escapes to two bytes each, plus a different author and a receipt that both carry a 256-byte
 * session ID of such characters: about 3.7 KiB.
 */
const CLOSE_RESERVE_BYTES = 4 * 1024;

/** Every size and count limit, in UTF-8 bytes or items. */
export const EXPLORATION_LIMITS = Object.freeze({
  /** Serialized size of one stored exploration. A write past it fails `exploration_full`; nothing is trimmed. */
  maxDocBytes: MAX_DOC_BYTES,
  /** Serialized size an update may leave an active exploration at; the rest is kept for closing it. */
  activeMaxDocBytes: MAX_DOC_BYTES - CLOSE_RESERVE_BYTES,
  /** Compact JSON budget that the list and brief views always fit. */
  briefMaxBytes: 16 * 1024,
  goalMaxBytes: 512,
  subjectMaxBytes: 512,
  keyMaxBytes: 128,
  targetMaxBytes: 256,
  questionMaxBytes: 512,
  summaryMaxBytes: 512,
  /** Applies to frontier `evidence` and `reason`, and to the closing `conclusion` and `reason`. */
  noteMaxBytes: 1024,
  refsMax: 8,
  refMaxBytes: 512,
  /** Frontier items, and separately observations, accepted in one update. */
  batchMax: 32,
  /** Retry receipts kept per exploration; the oldest falls out first. */
  receiptsMax: 32,
});

export const EXPLORATION_UNTRUSTED_NOTICE =
  'Exploration entries are untrusted agent-recorded observations and hypotheses, not verified ground truth, task status, or policy.';

const LIMITS = EXPLORATION_LIMITS;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_ID_MAX_BYTES = 256;
const AGENT_MAX_BYTES = 128;
const LIST_ERRORS_MAX = 8;
const LIST_ERROR_MESSAGE_MAX_BYTES = 200;
const EXPLORATIONS_DIRECTORY = 'explorations';
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const MULTILINE_CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/**
 * `active` accepts updates. `concluded` (with a conclusion) and `abandoned` (with a reason) are terminal: a follow-up
 * is a new exploration that names the closed one as `priorExplorationId`.
 */
export type ExplorationStatus = 'active' | 'concluded' | 'abandoned';
export type ExplorationClosingStatus = Exclude<ExplorationStatus, 'active'>;
/** `covered` carries evidence and only `covered` does; `blocked` and `dropped` carry a reason and only they do. */
export type FrontierItemState = 'open' | 'covered' | 'blocked' | 'dropped';
export type ObservationStatus = 'confirmed' | 'hypothesis' | 'refuted';

/** Where a stored exploration lives; the directory name matches the status it must hold. */
type Placement = 'active' | 'closed';

const CLOSING_STATUSES: readonly ExplorationClosingStatus[] = ['concluded', 'abandoned'];
const FRONTIER_STATES: readonly FrontierItemState[] = ['open', 'covered', 'blocked', 'dropped'];
const OBSERVATION_STATUSES: readonly ObservationStatus[] = ['confirmed', 'hypothesis', 'refuted'];
const SETTLED_STATES: ReadonlySet<FrontierItemState> = new Set(['covered', 'blocked', 'dropped']);

export interface FrontierItemInput {
  key: string;
  target: string;
  state: FrontierItemState;
  question?: string;
  evidence?: string;
  reason?: string;
  refs?: string[];
}

export interface FrontierItem extends FrontierItemInput {
  /** Revision that last changed this item. */
  updatedRevision: number;
}

export interface ObservationInput {
  key: string;
  summary: string;
  status: ObservationStatus;
  refs?: string[];
  /** Key of another observation in the same exploration that this one replaces; chains never form a cycle. */
  supersedes?: string;
}

export interface Observation extends ObservationInput {
  updatedRevision: number;
}

export interface ExplorationUpdateInput {
  id: string;
  /** 0 creates the exploration; otherwise the revision the caller read. */
  expectedRevision: number;
  /** Retry key: an identical retry from the same session replays the committed result. */
  operationId?: string;
  /** Required on creation; may be revised later. */
  goal?: string;
  /** Set only on creation. */
  subject?: string;
  /** Set only on creation. */
  priorExplorationId?: string;
  status?: ExplorationClosingStatus;
  /** Required with status `concluded`. */
  conclusion?: string;
  /** Required with status `abandoned`. */
  reason?: string;
  /** Upserted by key. */
  frontier?: FrontierItemInput[];
  /** Upserted by key. */
  observations?: ObservationInput[];
}

export interface ExplorationCounts {
  frontierTotal: number;
  open: number;
  covered: number;
  blocked: number;
  dropped: number;
  observationsTotal: number;
  confirmed: number;
  hypothesis: number;
  refuted: number;
}

/** Metadata every view returns. `scopeMapped`, `counts` and `stagnantRevisions` are computed at read time. */
export interface ExplorationHeader {
  id: string;
  goal: string;
  subject?: string;
  priorExplorationId?: string;
  status: ExplorationStatus;
  conclusion?: string;
  reason?: string;
  revision: number;
  lastProgressRevision: number;
  stagnantRevisions: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  createdBy: WorklogAuthor;
  updatedBy: WorklogAuthor;
  scopeMapped: boolean;
  counts: ExplorationCounts;
}

/** An open or blocked frontier item in the brief view; evidence and refs stay in the full view. */
export interface ExplorationGapSummary extends Pick<FrontierItem, 'key' | 'target' | 'question' | 'reason' | 'updatedRevision'> {
  state: 'open' | 'blocked';
}
/** An observation in the brief view; refs stay in the full view. */
export type ExplorationObservationSummary = Pick<Observation, 'key' | 'summary' | 'status' | 'supersedes' | 'updatedRevision'>;

export interface ExplorationBriefView extends ExplorationHeader {
  view: 'brief';
  /** Open and blocked frontier items, open first, newest first within each; `items` is a prefix of `total`. */
  gaps: { items: ExplorationGapSummary[]; total: number };
  /** Confirmed, then hypotheses, then refuted, newest first within each; `items` is a prefix of `total`. */
  observations: { items: ExplorationObservationSummary[]; total: number };
  untrustedNotice: string;
}

export interface ExplorationFullView extends ExplorationHeader {
  view: 'full';
  frontier: FrontierItem[];
  observations: Observation[];
  untrustedNotice: string;
}

export interface ExplorationListEntry {
  id: string;
  goal: string;
  subject?: string;
  revision: number;
  updatedAt: string;
  updatedBy: WorklogAuthor;
  scopeMapped: boolean;
  stagnantRevisions: number;
  counts: ExplorationCounts;
}

export interface ExplorationListError {
  file: string;
  reason: ExplorationErrorReason;
  message: string;
}

export interface ExplorationListView {
  view: 'list';
  /** Active explorations, newest update first. */
  explorations: ExplorationListEntry[];
  totalActive: number;
  /** True when `explorations` or `errors` omits entries to fit the budget. */
  truncated: boolean;
  errors: ExplorationListError[];
  untrustedNotice: string;
}

export type ExplorationReadResult = ExplorationListView | ExplorationBriefView | ExplorationFullView;

/**
 * Exploration IDs found by file name alone, without opening any file. Each list is ordered by file modification time,
 * newest first, then by ID. An ID with a file in `closed/` is listed only as closed, as a named read prefers that copy.
 */
export interface ExplorationDiscovery {
  active: string[];
  closed: string[];
}

export interface ExplorationUpdateResult extends ExplorationBriefView {
  /** True when an identical earlier request with this operationId had already committed. */
  replayed: boolean;
  /** Revision the request committed. */
  committedRevision: number;
  /** Revision of the exploration now. */
  currentRevision: number;
}

export type ExplorationErrorReason =
  | 'invalid_argument'
  | 'input_too_large'
  | 'immutable_field'
  | 'unsafe_path'
  | 'not_found'
  | 'already_exists'
  | 'already_closed'
  | 'stale_revision'
  | 'operation_conflict'
  | 'exploration_full'
  | 'exploration_corrupt'
  | 'unsupported_schema'
  | 'exploration_locked'
  | 'io_error';

export class ExplorationError extends Error {
  constructor(
    readonly reason: ExplorationErrorReason,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ExplorationError';
  }
}

type IoStage = 'path' | 'lock' | 'read' | 'write' | 'cleanup' | 'discover';

/**
 * A filesystem failure. A `write` failure may have happened after the rename published the file, and a `cleanup`
 * failure left a stale active copy beside the published closed file; both are resolved by resending the identical
 * request with the same operationId.
 */
function ioError(stage: IoStage, error: unknown): ExplorationError {
  const code = errorCode(error);
  const cause = error instanceof Error ? error.message : String(error);
  const hint = stage === 'write'
    ? ' The update may or may not have been published; resend the identical request with the same operationId.'
    : stage === 'cleanup'
      ? ' The closed exploration was published, but its active copy could not be removed; reads treat it as closed.'
      : '';
  return new ExplorationError('io_error', `Exploration ${stage} failed: ${cause}.${hint}`, {
    stage,
    ...(code !== undefined ? { code } : {}),
    ...(stage === 'write' ? { publication: 'uncertain' } : {}),
    ...(stage === 'cleanup' ? { publication: 'committed' } : {}),
  });
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Only a missing entry is absent; `ENOTDIR` means a component exists with the wrong type and is an error. */
function isAbsent(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

// ============================================================================
// Stored shape
// ============================================================================

interface OperationReceipt {
  operationId: string;
  owner: WorklogAuthor['owner'];
  sessionId: string;
  requestHash: string;
  committedRevision: number;
}

interface ExplorationDocument {
  schemaVersion: typeof EXPLORATION_SCHEMA_VERSION;
  id: string;
  goal: string;
  subject?: string;
  priorExplorationId?: string;
  status: ExplorationStatus;
  conclusion?: string;
  reason?: string;
  revision: number;
  /** Last revision that recorded an observation change or settled a frontier item. */
  lastProgressRevision: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  createdBy: WorklogAuthor;
  updatedBy: WorklogAuthor;
  frontier: FrontierItem[];
  observations: Observation[];
  receipts: OperationReceipt[];
}

// ============================================================================
// Validation
// ============================================================================

/**
 * One validation channel. Caller input reports shape errors as `invalid_argument` and oversized values as
 * `input_too_large`; a stored document reports both as `exploration_corrupt`. The same parsers serve both, so a
 * document can only hold what an update could have written.
 */
interface Validator {
  invalid(message: string, details?: Record<string, unknown>): ExplorationError;
  tooLarge(message: string, details: Record<string, unknown>): ExplorationError;
}

const INPUT_VALIDATOR: Validator = {
  invalid: (message, details) => new ExplorationError('invalid_argument', message, details),
  tooLarge: (message, details) => new ExplorationError('input_too_large', message, details),
};

const STORED_VALIDATOR: Validator = {
  invalid: (message, details) => new ExplorationError('exploration_corrupt', `Stored exploration is invalid: ${message}`, details),
  tooLarge: (message, details) => new ExplorationError('exploration_corrupt', `Stored exploration is invalid: ${message}`, details),
};

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isWellFormed(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** Nonblank, well-formed text within its byte cap; single-line unless `multiline`. */
function text(value: unknown, field: string, maxBytes: number, v: Validator, multiline = false): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw v.invalid(`${field} must be a non-blank string.`, { field });
  if (!isWellFormed(value)) throw v.invalid(`${field} contains an unpaired UTF-16 surrogate.`, { field });
  if ((multiline ? MULTILINE_CONTROL_PATTERN : CONTROL_PATTERN).test(value)) throw v.invalid(`${field} contains control characters.`, { field });
  const bytes = utf8Bytes(value);
  if (bytes > maxBytes) throw v.tooLarge(`${field} is ${bytes} UTF-8 bytes; the limit is ${maxBytes}.`, { field, bytes, maxBytes });
  return value;
}

function optionalText(value: unknown, field: string, maxBytes: number, v: Validator, multiline = false): string | undefined {
  return value === undefined ? undefined : text(value, field, maxBytes, v, multiline);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, v: Validator): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw v.invalid(`${field} must be one of ${allowed.join(', ')}.`, { field, allowed: [...allowed] });
  }
  return value as T;
}

function key(value: unknown, field: string, v: Validator): string {
  const normalized = text(value, field, LIMITS.keyMaxBytes, v);
  if (normalized !== normalized.trim()) throw v.invalid(`${field} must not have leading or trailing whitespace.`, { field });
  return normalized;
}

function refs(value: unknown, field: string, v: Validator): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw v.invalid(`${field} must be an array of strings.`, { field });
  if (value.length > LIMITS.refsMax) {
    throw v.tooLarge(`${field} has ${value.length} entries; the limit is ${LIMITS.refsMax}.`, { field, maxItems: LIMITS.refsMax });
  }
  return value.map((entry, index) => text(entry, `${field}[${index}]`, LIMITS.refMaxBytes, v));
}

/** Whether `value` is a valid exploration ID, which is also the stored file's name without `.json`. */
export function isExplorationId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function explorationId(value: unknown, field: string, v: Validator): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw v.invalid(`${field} must be 1 to 64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.`, { field });
  }
  return value;
}

function revisionNumber(value: unknown, field: string, v: Validator, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw v.invalid(`${field} must be an integer of at least ${min}.`, { field });
  return value;
}

function parseAuthor(value: unknown, field: string, v: Validator): WorklogAuthor {
  if (!isPlainRecord(value) || !isNativeObservationOwner(value.owner)) {
    throw v.invalid(`${field} needs a known native owner, a session ID, and an agent name.`, { field });
  }
  return {
    owner: value.owner,
    sessionId: text(value.sessionId, `${field}.sessionId`, SESSION_ID_MAX_BYTES, v),
    agent: text(value.agent, `${field}.agent`, AGENT_MAX_BYTES, v),
  };
}

/**
 * A frontier item with its state invariant in both directions: evidence exactly when `covered`, a reason exactly
 * when `blocked` or `dropped`.
 */
function frontierItem(value: unknown, field: string, v: Validator): FrontierItemInput {
  if (!isPlainRecord(value)) throw v.invalid(`${field} must be an object.`, { field });
  const item: FrontierItemInput = {
    key: key(value.key, `${field}.key`, v),
    target: text(value.target, `${field}.target`, LIMITS.targetMaxBytes, v),
    state: oneOf(value.state, FRONTIER_STATES, `${field}.state`, v),
  };
  const question = optionalText(value.question, `${field}.question`, LIMITS.questionMaxBytes, v);
  const evidence = optionalText(value.evidence, `${field}.evidence`, LIMITS.noteMaxBytes, v, true);
  const reason = optionalText(value.reason, `${field}.reason`, LIMITS.noteMaxBytes, v, true);
  const itemRefs = refs(value.refs, `${field}.refs`, v);
  if (question !== undefined) item.question = question;
  if (evidence !== undefined) item.evidence = evidence;
  if (reason !== undefined) item.reason = reason;
  if (itemRefs !== undefined) item.refs = itemRefs;
  const details = { field, key: item.key, state: item.state };
  const covered = item.state === 'covered';
  const needsReason = item.state === 'blocked' || item.state === 'dropped';
  if (covered && evidence === undefined) throw v.invalid(`${field}: a covered item needs evidence.`, details);
  if (!covered && evidence !== undefined) throw v.invalid(`${field}: only a covered item carries evidence, not a ${item.state} one.`, details);
  if (needsReason && reason === undefined) throw v.invalid(`${field}: a ${item.state} item needs a reason.`, details);
  if (!needsReason && reason !== undefined) throw v.invalid(`${field}: only a blocked or dropped item carries a reason, not a ${item.state} one.`, details);
  return item;
}

function observation(value: unknown, field: string, v: Validator): ObservationInput {
  if (!isPlainRecord(value)) throw v.invalid(`${field} must be an object.`, { field });
  const item: ObservationInput = {
    key: key(value.key, `${field}.key`, v),
    summary: text(value.summary, `${field}.summary`, LIMITS.summaryMaxBytes, v),
    status: oneOf(value.status, OBSERVATION_STATUSES, `${field}.status`, v),
  };
  const itemRefs = refs(value.refs, `${field}.refs`, v);
  if (itemRefs !== undefined) item.refs = itemRefs;
  if (value.supersedes !== undefined) {
    item.supersedes = key(value.supersedes, `${field}.supersedes`, v);
    if (item.supersedes === item.key) throw v.invalid(`${field}.supersedes cannot name the observation itself.`, { field, key: item.key });
  }
  return item;
}

/** Every `supersedes` names an observation of the same exploration, and following them never returns to a start. */
function assertSupersedesChains(observations: readonly ObservationInput[], v: Validator): void {
  const keys = new Set(observations.map((item) => item.key));
  for (const item of observations) {
    if (item.supersedes !== undefined && !keys.has(item.supersedes)) {
      throw v.invalid(`Observation '${item.key}' supersedes '${item.supersedes}', which this exploration does not have.`, { key: item.key, supersedes: item.supersedes });
    }
  }
  assertNoSupersedesCycle(observations, v);
}

/**
 * Following `supersedes` among `observations` never returns to a start. A link to a key outside the set ends the
 * chain, so a partial set (one update's batch) is checked for the cycles it closes on its own.
 */
function assertNoSupersedesCycle(observations: readonly ObservationInput[], v: Validator): void {
  const next = new Map(observations.map((item) => [item.key, item.supersedes]));
  for (const start of observations) {
    let current = start.supersedes;
    for (let steps = 0; current !== undefined && steps < observations.length; steps++) {
      if (current === start.key) {
        throw v.invalid(`Observation '${start.key}' is part of a supersedes cycle.`, { key: start.key });
      }
      current = next.get(current);
    }
  }
}

function batch<T extends { key: string }>(value: unknown, field: string, parse: (entry: unknown, at: string) => T): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw INPUT_VALIDATOR.invalid(`${field} must be an array.`, { field });
  if (value.length > LIMITS.batchMax) {
    throw INPUT_VALIDATOR.tooLarge(`${field} has ${value.length} items; one update accepts at most ${LIMITS.batchMax}.`, { field, maxItems: LIMITS.batchMax });
  }
  const items = value.map((entry, index) => parse(entry, `${field}[${index}]`));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) throw INPUT_VALIDATOR.invalid(`${field} repeats key '${item.key}' in one update.`, { field, key: item.key });
    seen.add(item.key);
  }
  return items;
}

/** Validates every argument before any lock or directory exists, so a rejected call writes nothing. */
function normalizeUpdate(value: unknown): ExplorationUpdateInput {
  const v = INPUT_VALIDATOR;
  if (!isPlainRecord(value)) throw v.invalid('Update input must be an object.');
  const input: ExplorationUpdateInput = {
    id: explorationId(value.id, 'id', v),
    expectedRevision: revisionNumber(value.expectedRevision, 'expectedRevision', v, 0),
  };
  if (value.operationId !== undefined) {
    if (typeof value.operationId !== 'string' || !OPERATION_ID_PATTERN.test(value.operationId)) {
      throw v.invalid("operationId must be 1 to 128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit.", { field: 'operationId' });
    }
    input.operationId = value.operationId;
  }
  const goal = optionalText(value.goal, 'goal', LIMITS.goalMaxBytes, v);
  const subject = optionalText(value.subject, 'subject', LIMITS.subjectMaxBytes, v);
  if (goal !== undefined) input.goal = goal;
  if (subject !== undefined) input.subject = subject;
  if (value.priorExplorationId !== undefined) {
    input.priorExplorationId = explorationId(value.priorExplorationId, 'priorExplorationId', v);
    if (input.priorExplorationId === input.id) throw v.invalid('priorExplorationId cannot name the exploration itself.', { field: 'priorExplorationId' });
  }
  if (value.status !== undefined) input.status = oneOf(value.status, CLOSING_STATUSES, 'status', v);
  const conclusion = optionalText(value.conclusion, 'conclusion', LIMITS.noteMaxBytes, v, true);
  const reason = optionalText(value.reason, 'reason', LIMITS.noteMaxBytes, v, true);
  if (conclusion !== undefined) input.conclusion = conclusion;
  if (reason !== undefined) input.reason = reason;
  if (input.status === 'concluded' && conclusion === undefined) throw v.invalid("status 'concluded' needs a conclusion.", { field: 'conclusion' });
  if (input.status === 'abandoned' && reason === undefined) throw v.invalid("status 'abandoned' needs a reason.", { field: 'reason' });
  if (conclusion !== undefined && input.status !== 'concluded') throw v.invalid("conclusion is accepted only with status 'concluded'.", { field: 'conclusion' });
  if (reason !== undefined && input.status !== 'abandoned') throw v.invalid("reason is accepted only with status 'abandoned'.", { field: 'reason' });
  const frontier = batch(value.frontier, 'frontier', (entry, at) => frontierItem(entry, at, v));
  const observations = batch(value.observations, 'observations', (entry, at) => observation(entry, at, v));
  if (frontier !== undefined) input.frontier = frontier;
  if (observations !== undefined) input.observations = observations;

  if (input.expectedRevision === 0) {
    if (input.goal === undefined) throw v.invalid('Creating an exploration (expectedRevision 0) needs a goal.', { field: 'goal' });
    // A new exploration holds only this batch, so its whole supersedes graph is known before any lock.
    if (observations !== undefined) assertSupersedesChains(observations, v);
  } else {
    if (!changesContent(input) && input.subject === undefined && input.priorExplorationId === undefined) throw noChange();
    // Links into stored observations are checked against the merged graph under the lock.
    if (observations !== undefined) assertNoSupersedesCycle(observations, v);
  }
  return input;
}

/** True when an update to an existing exploration carries a goal, a status or at least one item. */
function changesContent(input: ExplorationUpdateInput): boolean {
  return input.goal !== undefined || input.status !== undefined || (input.frontier?.length ?? 0) > 0 || (input.observations?.length ?? 0) > 0;
}

function noChange(): ExplorationError {
  return INPUT_VALIDATOR.invalid('The update changes nothing: supply goal, status, or at least one frontier item or observation.');
}

function requestHash(input: ExplorationUpdateInput): string {
  const { operationId: _operationId, ...request } = input;
  return crypto.createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
}

// ============================================================================
// Persisted-file parsing
// ============================================================================

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function storedRevisionTag(value: unknown, field: string, revision: number): number {
  const tag = revisionNumber(value, field, STORED_VALIDATOR, 0);
  if (tag > revision) throw STORED_VALIDATOR.invalid(`${field} is past the document revision.`);
  return tag;
}

/** Parses a stored keyed collection with its revision tags; keys are unique. */
function parseStoredKeyedItems<T extends { key: string }>(
  raw: unknown[],
  field: string,
  revision: number,
  parse: (entry: unknown, at: string, v: Validator) => T,
): Array<T & { updatedRevision: number }> {
  const keys = new Set<string>();
  return raw.map((entry, index) => {
    const at = `${field}[${index}]`;
    const item = parse(entry, at, STORED_VALIDATOR);
    if (keys.has(item.key)) throw STORED_VALIDATOR.invalid(`${at} repeats key '${item.key}'.`);
    keys.add(item.key);
    return { ...item, updatedRevision: storedRevisionTag((entry as Record<string, unknown>).updatedRevision, `${at}.updatedRevision`, revision) };
  });
}

function parseDocument(raw: unknown, expectedId: string, placement: Placement): ExplorationDocument {
  const v = STORED_VALIDATOR;
  if (!isPlainRecord(raw)) throw v.invalid('the document is not an object.');
  if (raw.schemaVersion !== EXPLORATION_SCHEMA_VERSION) {
    throw new ExplorationError('unsupported_schema', `Unsupported exploration schemaVersion: ${JSON.stringify(raw.schemaVersion)}.`, { schemaVersion: raw.schemaVersion });
  }
  const id = explorationId(raw.id, 'id', v);
  if (id !== expectedId) throw v.invalid(`id '${id}' does not match its file name.`);
  const revision = revisionNumber(raw.revision, 'revision', v, 1);
  const status = oneOf(raw.status, ['active', ...CLOSING_STATUSES] as const, 'status', v);
  if ((status === 'active') !== (placement === 'active')) throw v.invalid(`a ${status} exploration is stored in ${placement}/.`, { status, placement });
  if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) throw v.invalid('createdAt and updatedAt must be ISO timestamps.');
  const doc: ExplorationDocument = {
    schemaVersion: EXPLORATION_SCHEMA_VERSION,
    id,
    goal: text(raw.goal, 'goal', LIMITS.goalMaxBytes, v),
    status,
    revision,
    lastProgressRevision: storedRevisionTag(raw.lastProgressRevision, 'lastProgressRevision', revision),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    createdBy: parseAuthor(raw.createdBy, 'createdBy', v),
    updatedBy: parseAuthor(raw.updatedBy, 'updatedBy', v),
    frontier: [],
    observations: [],
    receipts: [],
  };
  const subject = optionalText(raw.subject, 'subject', LIMITS.subjectMaxBytes, v);
  if (subject !== undefined) doc.subject = subject;
  if (raw.priorExplorationId !== undefined) {
    doc.priorExplorationId = explorationId(raw.priorExplorationId, 'priorExplorationId', v);
    if (doc.priorExplorationId === id) throw v.invalid('priorExplorationId names the exploration itself.');
  }
  const conclusion = optionalText(raw.conclusion, 'conclusion', LIMITS.noteMaxBytes, v, true);
  const reason = optionalText(raw.reason, 'reason', LIMITS.noteMaxBytes, v, true);
  if (conclusion !== undefined) doc.conclusion = conclusion;
  if (reason !== undefined) doc.reason = reason;
  if ((status === 'concluded') !== (conclusion !== undefined) || (status === 'abandoned') !== (reason !== undefined)) {
    throw v.invalid(`status '${status}' does not match its conclusion or reason.`);
  }
  if (status === 'active') {
    if (raw.closedAt !== undefined) throw v.invalid('an active exploration has closedAt.');
  } else {
    if (!isTimestamp(raw.closedAt)) throw v.invalid('a closed exploration needs closedAt.');
    doc.closedAt = raw.closedAt;
  }
  if (!Array.isArray(raw.frontier) || !Array.isArray(raw.observations) || !Array.isArray(raw.receipts)) {
    throw v.invalid('frontier, observations and receipts must be arrays.');
  }
  doc.frontier = parseStoredKeyedItems(raw.frontier, 'frontier', revision, frontierItem);
  doc.observations = parseStoredKeyedItems(raw.observations, 'observations', revision, observation);
  assertSupersedesChains(doc.observations, v);
  if (raw.receipts.length > LIMITS.receiptsMax) throw v.invalid('too many receipts.');
  doc.receipts = raw.receipts.map((entry, index) => {
    const at = `receipts[${index}]`;
    if (!isPlainRecord(entry) || typeof entry.operationId !== 'string' || !OPERATION_ID_PATTERN.test(entry.operationId)
      || !isNativeObservationOwner(entry.owner) || typeof entry.requestHash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.requestHash)) {
      throw v.invalid(`${at} is not a valid receipt.`);
    }
    return {
      operationId: entry.operationId,
      owner: entry.owner,
      sessionId: text(entry.sessionId, `${at}.sessionId`, SESSION_ID_MAX_BYTES, v),
      requestHash: entry.requestHash,
      committedRevision: storedRevisionTag(entry.committedRevision, `${at}.committedRevision`, revision),
    };
  });
  return doc;
}

// ============================================================================
// Paths and file access
// ============================================================================

function toProjectRelative(projectRoot: string, target: string): string {
  return path.relative(path.resolve(projectRoot), target).split(path.sep).join('/');
}

/**
 * Refuses any target outside the project, or with a symbolic link at an existing component below the project root.
 * An existing component that must be a directory (every ancestor, and the target itself when `targetsAreDirectories`)
 * but is not fails as an `ENOTDIR` path error rather than reading as absent. Shared components are checked once.
 */
function assertSafeTree(projectRoot: string, targets: readonly string[], targetsAreDirectories: boolean): void {
  const root = path.resolve(projectRoot);
  const checked = new Set<string>();
  for (const target of targets) {
    const relative = path.relative(root, path.resolve(target));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ExplorationError('unsafe_path', 'Exploration path escapes the project root.', { path: target });
    }
    const parts = relative.split(path.sep);
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      if (checked.has(current)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (isAbsent(error)) break;
        throw ioError('path', error);
      }
      const at = toProjectRelative(projectRoot, current);
      if (stat.isSymbolicLink()) {
        throw new ExplorationError('unsafe_path', `Exploration path contains a symbolic link: ${at}`, { path: at });
      }
      if ((index < parts.length - 1 || targetsAreDirectories) && !stat.isDirectory()) {
        throw ioError('path', Object.assign(new Error(`ENOTDIR: not a directory, ${at}`), { code: 'ENOTDIR' }));
      }
      checked.add(current);
    }
  }
}

/**
 * Reads one stored exploration from its placement, or null when the file is absent, including when it vanishes
 * between the metadata check and the open. A symbolic link, a non-file, an oversized file, an invalid document or
 * one whose status does not match its placement is refused instead of being trusted. The file is opened without
 * following a final symbolic link, and type and size are checked on the opened descriptor, so a link swapped in after
 * the metadata check is refused rather than read; `lstat` covers platforms without `O_NOFOLLOW`.
 */
function readDocument(filePath: string, id: string, placement: Placement): ExplorationDocument | null {
  const at = `${placement}/${path.basename(filePath)}`;
  const notRegular = () => new ExplorationError('exploration_corrupt', `Exploration file is not a regular file: ${at}`);
  const tooBig = (bytes: number) => new ExplorationError('exploration_corrupt', `Exploration file is ${bytes} bytes, past the ${LIMITS.maxDocBytes}-byte limit.`, { bytes });
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (isAbsent(error)) return null;
    throw ioError('read', error);
  }
  if (stat.isSymbolicLink()) throw new ExplorationError('unsafe_path', `Exploration file is a symbolic link: ${at}`);
  // Checked before opening so a FIFO or device is never opened.
  if (!stat.isFile()) throw notRegular();
  let fd: number;
  try {
    // O_NONBLOCK keeps a FIFO swapped in after the lstat from blocking the open; it has no effect on regular files.
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ELOOP' || code === 'EMLINK') throw new ExplorationError('unsafe_path', `Exploration file is a symbolic link: ${at}`);
    if (isAbsent(error)) return null;
    throw ioError('read', error);
  }
  let content: string;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw notRegular();
    if (opened.size > LIMITS.maxDocBytes) throw tooBig(opened.size);
    // The file can grow between fstat and read, so read at most one byte past the limit instead of to end of file.
    const buffer = Buffer.allocUnsafe(LIMITS.maxDocBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > LIMITS.maxDocBytes) throw tooBig(total);
    content = buffer.toString('utf8', 0, total);
  } catch (error) {
    if (error instanceof ExplorationError) throw error;
    throw ioError('read', error);
  } finally {
    fs.closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new ExplorationError('exploration_corrupt', `Exploration file is not valid JSON: ${at}`);
  }
  return parseDocument(raw, id, placement);
}

/**
 * IDs named by `<id>.json` entries of one placement directory, newest modification first, then by ID; other names,
 * such as temporary files, are skipped. An absent directory lists nothing, and an entry removed between the listing
 * and its `lstat` is dropped. Nothing is opened, so a linked or invalid entry is reported only when it is read.
 */
function discoverPlacement(directory: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (isAbsent(error)) return [];
    throw ioError('discover', error);
  }
  const entries: Array<{ id: string; modifiedMs: number }> = [];
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
    if (!ID_PATTERN.test(id)) continue;
    try {
      entries.push({ id, modifiedMs: fs.lstatSync(path.join(directory, name)).mtimeMs });
    } catch (error) {
      if (isAbsent(error)) continue;
      throw ioError('discover', error);
    }
  }
  return entries
    .sort((a, b) => b.modifiedMs - a.modifiedMs || a.id.localeCompare(b.id))
    .map((entry) => entry.id);
}

// ============================================================================
// Projections
// ============================================================================

function countsOf(doc: ExplorationDocument): ExplorationCounts {
  const counts: ExplorationCounts = {
    frontierTotal: doc.frontier.length, open: 0, covered: 0, blocked: 0, dropped: 0,
    observationsTotal: doc.observations.length, confirmed: 0, hypothesis: 0, refuted: 0,
  };
  for (const item of doc.frontier) counts[item.state] += 1;
  for (const item of doc.observations) counts[item.status] += 1;
  return counts;
}

function headerOf(doc: ExplorationDocument): ExplorationHeader {
  return {
    id: doc.id,
    goal: doc.goal,
    ...(doc.subject !== undefined ? { subject: doc.subject } : {}),
    ...(doc.priorExplorationId !== undefined ? { priorExplorationId: doc.priorExplorationId } : {}),
    status: doc.status,
    ...(doc.conclusion !== undefined ? { conclusion: doc.conclusion } : {}),
    ...(doc.reason !== undefined ? { reason: doc.reason } : {}),
    revision: doc.revision,
    lastProgressRevision: doc.lastProgressRevision,
    stagnantRevisions: doc.revision - doc.lastProgressRevision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...(doc.closedAt !== undefined ? { closedAt: doc.closedAt } : {}),
    createdBy: doc.createdBy,
    updatedBy: doc.updatedBy,
    scopeMapped: doc.frontier.length > 0,
    counts: countsOf(doc),
  };
}

function compactBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

const OBSERVATION_ORDER: Record<ObservationStatus, number> = { confirmed: 0, hypothesis: 1, refuted: 2 };

function isGap(item: FrontierItem): item is FrontierItem & { state: ExplorationGapSummary['state'] } {
  return item.state === 'open' || item.state === 'blocked';
}

/**
 * The brief view, packed so its compact JSON never exceeds `briefMaxBytes`. Gaps and observations are taken in turn,
 * each list in priority order, and each list stops at its first item that would not fit, so `items` is always a
 * prefix of the ordered list. Stored caps keep the header far below the budget.
 */
function briefOf(doc: ExplorationDocument): ExplorationBriefView {
  const gaps: ExplorationGapSummary[] = doc.frontier
    .filter(isGap)
    .sort((a, b) => Number(a.state === 'blocked') - Number(b.state === 'blocked') || b.updatedRevision - a.updatedRevision || a.key.localeCompare(b.key))
    .map((item) => ({
      key: item.key, target: item.target, state: item.state,
      ...(item.question !== undefined ? { question: item.question } : {}),
      ...(item.reason !== undefined ? { reason: item.reason } : {}),
      updatedRevision: item.updatedRevision,
    }));
  const observations: ExplorationObservationSummary[] = [...doc.observations]
    .sort((a, b) => OBSERVATION_ORDER[a.status] - OBSERVATION_ORDER[b.status] || b.updatedRevision - a.updatedRevision || a.key.localeCompare(b.key))
    .map((item) => ({
      key: item.key, summary: item.summary, status: item.status,
      ...(item.supersedes !== undefined ? { supersedes: item.supersedes } : {}),
      updatedRevision: item.updatedRevision,
    }));
  const view: ExplorationBriefView = {
    view: 'brief',
    ...headerOf(doc),
    gaps: { items: [], total: gaps.length },
    observations: { items: [], total: observations.length },
    untrustedNotice: EXPLORATION_UNTRUSTED_NOTICE,
  };
  let used = compactBytes(view);
  // A comma separates each item after the first in its array.
  const take = <T>(source: T[], target: T[]): boolean => {
    if (target.length >= source.length) return false;
    const cost = compactBytes(source[target.length]) + (target.length > 0 ? 1 : 0);
    if (used + cost > LIMITS.briefMaxBytes) return false;
    target.push(source[target.length]!);
    used += cost;
    return true;
  };
  let gapsOpen = true;
  let observationsOpen = true;
  while (gapsOpen || observationsOpen) {
    if (gapsOpen) gapsOpen = take(gaps, view.gaps.items);
    if (observationsOpen) observationsOpen = take(observations, view.observations.items);
  }
  return view;
}

function fullOf(doc: ExplorationDocument): ExplorationFullView {
  return {
    view: 'full',
    ...headerOf(doc),
    frontier: doc.frontier,
    observations: doc.observations,
    untrustedNotice: EXPLORATION_UNTRUSTED_NOTICE,
  };
}

function listEntryOf(doc: ExplorationDocument): ExplorationListEntry {
  const header = headerOf(doc);
  return {
    id: doc.id,
    goal: doc.goal,
    ...(doc.subject !== undefined ? { subject: doc.subject } : {}),
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
    scopeMapped: header.scopeMapped,
    stagnantRevisions: header.stagnantRevisions,
    counts: header.counts,
  };
}

/** Cuts `value` to at most `maxBytes` UTF-8 bytes, ending with '...', without splitting a character. */
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes - 3;
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}...`;
}

/**
 * Upserts keyed items. An input deep-equal to its stored item (ignoring the revision tag) is left untouched with its
 * old tag; any other input replaces or appends with the new revision. `isProgress` decides, per changed item,
 * whether the change counts as progress.
 */
function upsertKeyedItems<T extends { key: string }>(
  stored: ReadonlyArray<T & { updatedRevision: number }>,
  inputs: readonly T[] | undefined,
  revision: number,
  isProgress: (prior: T | undefined, input: T) => boolean,
): { items: Array<T & { updatedRevision: number }>; progressed: boolean } {
  const items = [...stored];
  let progressed = false;
  for (const input of inputs ?? []) {
    const index = items.findIndex((item) => item.key === input.key);
    let prior: T | undefined;
    if (index >= 0) {
      const { updatedRevision: _updatedRevision, ...rest } = items[index]!;
      prior = rest as unknown as T;
      if (isDeepStrictEqual(prior, input)) continue;
    }
    if (isProgress(prior, input)) progressed = true;
    const item = { ...input, updatedRevision: revision };
    if (index >= 0) items[index] = item;
    else items.push(item);
  }
  return { items, progressed };
}

// ============================================================================
// Service
// ============================================================================

export interface ExplorationServiceOptions {
  now?: () => Date;
}

/**
 * Exploration frontiers: a goal, the keyed frontier of targets an investigation must settle, and keyed observations
 * recorded along the way, for any domain (debugging, auditing, research). One JSON file per exploration under
 * `.hive/explorations/active/` until it closes, then under `closed/`. Updates are revision-guarded, locked per
 * exploration and idempotent by operationId; authorship is supplied by the host. Everything stored is untrusted
 * narrative; counts, gaps and stagnation are computed at read time.
 */
export class ExplorationService {
  private readonly now: () => Date;

  constructor(private readonly projectRoot: string, options: ExplorationServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private get directory(): string {
    return path.join(getHivePath(this.projectRoot), EXPLORATIONS_DIRECTORY);
  }

  private placementDirectory(placement: Placement): string {
    return path.join(this.directory, placement);
  }

  private paths(id: string): { lock: string; active: string; closed: string } {
    return {
      lock: path.join(this.directory, `${id}.json`),
      active: path.join(this.placementDirectory('active'), `${id}.json`),
      closed: path.join(this.placementDirectory('closed'), `${id}.json`),
    };
  }

  /** Checks file targets: every existing ancestor must be a real directory. */
  private assertSafe(...files: string[]): void {
    assertSafeTree(this.projectRoot, files, false);
  }

  /**
   * Flushes the directory entries that make a just-renamed file reachable: its placement directory, the explorations
   * directory and `.hive/`, any of which the write may have created, and the project root that holds a new `.hive/`
   * entry. POSIX only; `syncDirectory` is a no-op on Windows.
   */
  private syncPublished(filePath: string): void {
    syncDirectory(path.dirname(filePath));
    syncDirectory(this.directory);
    syncDirectory(path.dirname(this.directory));
    syncDirectory(this.projectRoot);
  }

  /**
   * Without `id`, lists active explorations within the brief budget; `view` is then rejected. With `id`, returns the
   * `brief` view (default) or the `full` view. A closed exploration is read from `closed/`, which wins over a stale
   * active copy left by an interrupted close. Reads never create files or directories.
   */
  read(options: { id?: string; view?: 'brief' | 'full' } = {}): ExplorationReadResult {
    const v = INPUT_VALIDATOR;
    if (!isPlainRecord(options)) throw v.invalid('Read options must be an object.');
    if (options.id === undefined) {
      if (options.view !== undefined) throw v.invalid('view needs an id; omit both to list active explorations.', { field: 'view' });
      return this.list();
    }
    const id = explorationId(options.id, 'id', v);
    const view = options.view === undefined ? 'brief' : oneOf(options.view, ['brief', 'full'] as const, 'view', v);
    const files = this.paths(id);
    this.assertSafe(files.active, files.closed);
    // Reads take no lock, so a close can move the file between the two checks: when the active copy is gone, the
    // closed copy it was moved to is checked once more.
    const doc = readDocument(files.closed, id, 'closed')
      ?? readDocument(files.active, id, 'active')
      ?? this.recheckClosed(files.closed, id);
    if (!doc) throw new ExplorationError('not_found', `No exploration '${id}'.`, { id });
    return view === 'full' ? fullOf(doc) : briefOf(doc);
  }

  /**
   * Lists the IDs stored in `active/` and `closed/` from directory entries and their metadata only, so a large archive
   * of closed explorations is never parsed. Read each one by ID for its content, which validates it. Like the list, a
   * linked or non-directory placement fails instead of reading as empty. Reads never create files or directories.
   */
  discover(): ExplorationDiscovery {
    const activeDirectory = this.placementDirectory('active');
    const closedDirectory = this.placementDirectory('closed');
    assertSafeTree(this.projectRoot, [activeDirectory, closedDirectory], true);
    // A close publishes the closed copy before it removes the active one, so scanning active/ first means a close
    // landing between the scans still lists the exploration, as closed, instead of dropping it from both lists.
    const active = discoverPlacement(activeDirectory);
    assertSafeTree(this.projectRoot, [closedDirectory], true);
    const closed = discoverPlacement(closedDirectory);
    const closedIds = new Set(closed);
    return { active: active.filter((id) => !closedIds.has(id)), closed };
  }

  /** The last read of a racing close: `closed/` may have been created or replaced since the first check. */
  private recheckClosed(closedPath: string, id: string): ExplorationDocument | null {
    this.assertSafe(closedPath);
    return readDocument(closedPath, id, 'closed');
  }

  /**
   * Creates (expectedRevision 0) or updates one exploration, as `author`, which the host supplies from the calling
   * session. Frontier items and observations are upserted by key. Status `concluded` or `abandoned` closes it for
   * good. An identical retry with the same operationId from the same session replays the committed result, even
   * after closure; the replay check runs before the closed and revision checks.
   */
  update(input: ExplorationUpdateInput, author: WorklogAuthor): ExplorationUpdateResult {
    const request = normalizeUpdate(input);
    const stamp = parseAuthor(author, 'author', INPUT_VALIDATOR);
    const hash = requestHash(request);
    const { id } = request;
    const files = this.paths(id);
    this.assertSafe(files.lock, files.active, files.closed);

    let release: () => void;
    try {
      release = acquireLockSync(files.lock);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Failed to acquire lock')) {
        throw new ExplorationError('exploration_locked', `${error.message} Nothing was written; retry with the same operationId.`, { id });
      }
      throw ioError('lock', error);
    }
    try {
      // Acquiring the lock creates its directory; check the path again before trusting it.
      this.assertSafe(files.lock, files.active, files.closed);
      const closed = readDocument(files.closed, id, 'closed');
      const current = closed ?? readDocument(files.active, id, 'active');

      if (current && request.operationId !== undefined) {
        const receipt = current.receipts.find((entry) => entry.operationId === request.operationId
          && entry.owner === stamp.owner && entry.sessionId === stamp.sessionId);
        if (receipt) {
          if (receipt.requestHash !== hash) {
            throw new ExplorationError('operation_conflict', `operationId '${request.operationId}' was already used for a different request on this exploration.`, {
              id, operationId: request.operationId, committedRevision: receipt.committedRevision,
            });
          }
          // The earlier call may have failed after its rename but before its flushes; acknowledge only once the
          // stored copy is durably reachable, and fail as an uncertain write otherwise so the caller retries.
          try {
            this.syncPublished(closed ? files.closed : files.active);
          } catch (error) {
            throw ioError('write', error);
          }
          if (closed) this.removeStaleActive(files.active);
          return { ...briefOf(current), replayed: true, committedRevision: receipt.committedRevision, currentRevision: current.revision };
        }
      }
      if (request.expectedRevision === 0) {
        if (current) throw new ExplorationError('already_exists', `Exploration '${id}' already exists at revision ${current.revision}.`, { id, currentRevision: current.revision, status: current.status });
      } else {
        if (!current) throw new ExplorationError('not_found', `No exploration '${id}'.`, { id });
        if (closed) {
          this.removeStaleActive(files.active);
          throw new ExplorationError('already_closed', `Exploration '${id}' is ${closed.status}; start a new exploration with priorExplorationId '${id}' to continue.`, {
            id, status: closed.status, currentRevision: closed.revision,
          });
        }
        if (current.revision !== request.expectedRevision) {
          throw new ExplorationError('stale_revision', `Exploration '${id}' is at revision ${current.revision}, not ${request.expectedRevision}. Read it again and reconcile.`, {
            id, expectedRevision: request.expectedRevision, currentRevision: current.revision,
          });
        }
      }

      const next = this.apply(current, request, stamp, hash);
      const serialized = JSON.stringify(next, null, 2);
      const bytes = utf8Bytes(serialized);
      const maxBytes = next.status === 'active' ? LIMITS.activeMaxDocBytes : LIMITS.maxDocBytes;
      if (bytes > maxBytes) {
        throw new ExplorationError('exploration_full', `The update would grow exploration '${id}' to ${bytes} bytes, past the ${maxBytes}-byte limit for ${next.status === 'active' ? 'an active' : 'a closed'} exploration. Nothing was written; drop or condense entries, or conclude it and continue in a new exploration.`, {
          id, bytes, maxBytes,
        });
      }
      const destination = next.status === 'active' ? files.active : files.closed;
      try {
        writeAtomicDurable(destination, serialized);
        this.syncPublished(destination);
      } catch (error) {
        throw ioError('write', error);
      }
      if (next.status !== 'active' && current) this.removeStaleActive(files.active, true);
      return { ...briefOf(next), replayed: false, committedRevision: next.revision, currentRevision: next.revision };
    } finally {
      release();
    }
  }

  /** The next document: upserts, progress tracking, closing fields, and the bounded receipt ring. */
  private apply(current: ExplorationDocument | null, request: ExplorationUpdateInput, author: WorklogAuthor, hash: string): ExplorationDocument {
    const timestamp = this.now().toISOString();
    const revision = (current?.revision ?? 0) + 1;
    if (current) {
      if (request.subject !== undefined && request.subject !== current.subject) {
        throw new ExplorationError('immutable_field', 'subject is set when the exploration is created and cannot change.', { field: 'subject', id: current.id });
      }
      if (request.priorExplorationId !== undefined && request.priorExplorationId !== current.priorExplorationId) {
        throw new ExplorationError('immutable_field', 'priorExplorationId is set when the exploration is created and cannot change.', { field: 'priorExplorationId', id: current.id });
      }
      // Repeating the stored subject or prior ID is accepted only beside a real change.
      if (!changesContent(request)) throw noChange();
    }

    // Settling a frontier item is progress; widening the frontier or rewording an item is not.
    const frontier = upsertKeyedItems(current?.frontier ?? [], request.frontier, revision,
      (prior, input) => SETTLED_STATES.has(input.state) && prior?.state !== input.state);
    // Every observation change, including what it supersedes, is progress.
    const observations = upsertKeyedItems(current?.observations ?? [], request.observations, revision, () => true);
    assertSupersedesChains(observations.items, INPUT_VALIDATOR);

    const receipts = current?.receipts ?? [];
    const subject = current ? current.subject : request.subject;
    const priorExplorationId = current ? current.priorExplorationId : request.priorExplorationId;
    const status = request.status ?? 'active';
    return {
      schemaVersion: EXPLORATION_SCHEMA_VERSION,
      id: request.id,
      goal: request.goal ?? current!.goal,
      ...(subject !== undefined ? { subject } : {}),
      ...(priorExplorationId !== undefined ? { priorExplorationId } : {}),
      status,
      ...(request.conclusion !== undefined ? { conclusion: request.conclusion } : {}),
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
      revision,
      lastProgressRevision: frontier.progressed || observations.progressed ? revision : (current?.lastProgressRevision ?? 0),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(status !== 'active' ? { closedAt: timestamp } : {}),
      createdBy: current?.createdBy ?? author,
      updatedBy: author,
      frontier: frontier.items,
      observations: observations.items,
      receipts: request.operationId === undefined
        ? receipts
        : [...receipts, { operationId: request.operationId, owner: author.owner, sessionId: author.sessionId, requestHash: hash, committedRevision: revision }]
          .slice(-LIMITS.receiptsMax),
    };
  }

  /**
   * Removes the active copy once the closed file is published. The closed copy's directory entries are flushed first
   * (`closed/`, the explorations directory and `.hive/`), so a crash can never leave neither copy durable. This is
   * cleanup, not publication: a failure is reported as a committed `cleanup` error only when `strict`; otherwise the
   * active copy stays, and reads already prefer the closed file.
   */
  private removeStaleActive(activePath: string, strict = false): void {
    try {
      this.syncPublished(path.join(this.placementDirectory('closed'), path.basename(activePath)));
      fs.unlinkSync(activePath);
      syncDirectory(path.dirname(activePath));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      if (strict) throw ioError('cleanup', error);
    }
  }

  private list(): ExplorationListView {
    const activeDirectory = this.placementDirectory('active');
    const closedDirectory = this.placementDirectory('closed');
    // Both placements are checked once, as directories: a linked or non-directory closed/ fails the list instead of
    // being consulted per entry, where it could hide active explorations.
    assertSafeTree(this.projectRoot, [activeDirectory, closedDirectory], true);
    const view: ExplorationListView = {
      view: 'list', explorations: [], totalActive: 0, truncated: false, errors: [], untrustedNotice: EXPLORATION_UNTRUSTED_NOTICE,
    };
    let names: string[];
    try {
      names = fs.readdirSync(activeDirectory);
    } catch (error) {
      if (isAbsent(error)) return view;
      throw ioError('discover', error);
    }
    const docs: ExplorationDocument[] = [];
    const errors: ExplorationListError[] = [];
    const ids = names
      .filter((name) => name.endsWith('.json') && ID_PATTERN.test(name.slice(0, -'.json'.length)))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
    for (const id of ids) {
      const name = `${id}.json`;
      // closed/ is rechecked before each closed-copy read, outside the per-entry catch, so a closed/ swapped for a link
      // mid-scan fails the list rather than being followed or reported as one entry's error.
      assertSafeTree(this.projectRoot, [closedDirectory], true);
      try {
        // A valid closed copy means an interrupted close: the exploration is no longer active. A closed copy that is
        // a link, unreadable or misplaced is reported rather than trusted or ignored.
        if (readDocument(path.join(closedDirectory, name), id, 'closed')) continue;
        const doc = readDocument(path.join(activeDirectory, name), id, 'active');
        if (doc) docs.push(doc);
      } catch (error) {
        if (!(error instanceof ExplorationError)) throw error;
        errors.push({ file: name, reason: error.reason, message: truncateUtf8(error.message, LIST_ERROR_MESSAGE_MAX_BYTES) });
      }
    }
    docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    view.totalActive = docs.length;
    view.errors = errors.slice(0, LIST_ERRORS_MAX);
    view.truncated = errors.length > LIST_ERRORS_MAX;
    let used = compactBytes(view);
    for (const doc of docs) {
      const entry = listEntryOf(doc);
      const cost = compactBytes(entry) + (view.explorations.length > 0 ? 1 : 0);
      // Turning `truncated` true only shortens the text ("true" against "false").
      if (used + cost > LIMITS.briefMaxBytes) {
        view.truncated = true;
        break;
      }
      view.explorations.push(entry);
      used += cost;
    }
    return view;
  }
}
