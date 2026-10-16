import { createHash } from 'node:crypto';
import {
  describeError,
  mapCardSchema,
  mapContract,
  mapEnvelopeSchema,
  normalizeReply,
  parseReply,
  reduceContract,
  reduceSchema,
  replyDiagnostic,
  schemaDiagnostic,
} from '../task-trace-contract.js';
import type { Diagnostic, SummarizerReply } from '../task-trace-contract.js';
import { z } from '../runtime/schema.js';
import type {
  ModelMetadata,
  RuntimeStatus,
  SourceSnapshot,
  SummarizerHost,
  SummarizerSelection,
  SummarizerStage,
  TargetRelationship,
  TraceCaller,
  TraceSource,
  TraceTarget,
  Unavailable,
} from './types.js';

/**
 * The shared forensic index, guarded content reads and semantic recovery for `hive_task_trace` and
 * `hive_task_trace_content`. Each OpenCode generation supplies a TraceSource (target authorization, complete source
 * history, runtime status) and a SummarizerHost (ephemeral generation steps); the reply formats, cursor and ref
 * encodings, recovery contracts and freshness rules here are identical for both. Recovery output is untrusted context:
 * nothing it returns grants authority to continue, merge, retry or resume work.
 */

const SOFT_TARGET_BYTES = 24 * 1024;
const INDEX_PAGE_BUDGET_BYTES = 24 * 1024;
const CONTENT_CHUNK_BYTES = 8 * 1024;
const INITIAL_TEXT_INLINE_BYTES = 512;
const INITIAL_ERROR_INLINE_BYTES = 256;
const INDEX_EXCERPT_BYTES = 240;
const INDEX_INPUT_EXCERPT_BYTES = 320;
const INDEX_INPUT_KEY_EXCERPT_BYTES = 160;
const CONTEXT_EXCERPT_BYTES = 480;
const NAME_DISPLAY_BYTES = 128;
const TITLE_DISPLAY_BYTES = 240;
const CURSOR_RESERVE_BYTES = 160;
const MAX_TOKEN_LENGTH = 2048;
const ABBREVIATION_MARKER = ' [...] ';
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Canonical decimal after_seq without leading zeros, at most 16 digits (a safe integer is checked after).
const CURSOR_PATTERN = /^trace-cursor:v3:(prefix|source):([1-9][0-9]{0,15}):([A-Za-z0-9_-]{43})$/;
const INVALID_CURSOR_HINT = 'Pass coverage.next_cursor unchanged, or omit cursor to restart from the first page.';
// Native IDs outside visible ASCII or 256 bytes are treated as missing so refs stay bounded.
const NATIVE_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;
// Recorded input keys that identify an action when the whole input is too large to show.
const IDENTIFYING_INPUT_KEYS = ['description', 'command', 'filePath', 'path', 'pattern', 'name', 'url', 'query', 'subagent_type'];
const EVENT_FIELD_NAMES = ['text', 'input', 'output', 'error', 'files'] as const;
const COVERAGE_LIMITATIONS = ['compacted_source', 'compacted_tool_output', 'unsupported_parts', 'positional_identity'] as const;
const MIN_MAP_BATCH_BYTES = 20 * 1024;
const FALLBACK_MAP_BATCH_BYTES = 256 * 1024;
const MAP_INPUT_CONTEXT_RATIO = 0.7;
const ESTIMATED_UTF8_BYTES_PER_TOKEN = 2;
const SUMMARIZER_ATTEMPT_MS = 120_000;
const SEMANTIC_RECOVERY_MS = 300_000;
const REDUCTION_RESERVE_MS = 120_000;
const CLEANUP_ATTEMPT_MS = 10_000;
const MAX_MAP_CONCURRENCY = 4;
const RECOVERY_PREVIEW_BYTES = 256;
const RECOVERY_CARD_ACTION_BYTES = 384;
const RECOVERY_CARD_FINDING_BYTES = 768;
const RECOVERY_CARD_UNRESOLVED_BYTES = 384;
const RECOVERY_PHASE_SUMMARY_BYTES = 384;
const RECOVERY_PHASE_ACTION_BYTES = 512;
const RECOVERY_PHASE_FINDING_BYTES = 768;
const RECOVERY_PHASE_UNRESOLVED_BYTES = 512;
const RECOVERY_ANCHOR_BYTES = 2 * 1024;
const CONTENT_FIELDS = ['text', 'tool.input', 'tool.output', 'tool.error', 'assistant.error', 'retry.error'] as const;

type RecordValue = Record<string, unknown>;
type Actor = 'user' | 'assistant';
type StepState = 'closed' | 'open' | 'malformed';
type ContentField = typeof CONTENT_FIELDS[number];
type ContentLocator = [2, number, number, number, number, string];
type RecoveryBasis = 'observed' | 'reasoning' | 'mixed';
type RecoveryScope = 'closed_turn' | 'evidence_only';
type Lifecycle = {
  state: 'active' | 'uncertain' | 'terminal';
  terminal: boolean;
  reason: string;
  // Status of the target in its own directory's runtime instance; says nothing about OS processes.
  runtime: 'busy' | 'retry' | 'idle' | 'unavailable';
  unresolved_tools?: { latest_message: number; earlier_messages: number };
};
type RecoveryFailureReason =
  | 'empty_trace'
  | 'ephemeral_cleanup_failed'
  | 'invalid_map_output'
  | 'invalid_phase_coverage'
  | 'invalid_reducer_output'
  | 'latest_assistant_open'
  | 'latest_message_not_assistant'
  | 'latest_message_summary_or_compaction'
  | 'no_successful_map_ranges'
  | 'recovery_deadline_exceeded'
  | 'runtime_active'
  | 'status_unavailable'
  | 'summarizer_id_collision'
  | 'summarizer_unavailable'
  | 'summarizer_timeout'
  | 'tool_pending_or_running';

interface RecoveryCard {
  step: number;
  intent: string | null;
  actions: string[];
  findings: string[];
  outcome: string | null;
  unresolved: string[];
  basis: RecoveryBasis;
}

interface RuntimeRecoveryCard extends RecoveryCard {
  provenance: 'summarizer_interpretation' | 'deterministic_extractive_fallback';
  untrusted: true;
  source: 'generated' | 'fallback';
}

interface RecoveryCapabilities {
  hasVisibleObservedEvidence: boolean;
  hasPlaintextReasoning: boolean;
}

interface MapValidation {
  cards: RecoveryCard[];
  invalidSteps: number[];
}

interface SourceValue {
  message: number;
  part: number;
  field: ContentField;
  value: unknown;
  bytes: number;
  digest: string;
}

interface IRText {
  source: SourceValue;
  messageClosed: boolean;
}

interface IRTool {
  name: string;
  status: string;
  unresolved: boolean;
  input?: SourceValue;
  output?: SourceValue;
  error?: SourceValue;
}

interface IRError {
  kind: 'assistant' | 'tool' | 'retry';
  source: SourceValue;
}

interface IRReasoning {
  plaintext?: string;
  tokens?: number;
  opaque: boolean;
}

interface IRStep {
  number: number;
  message: number;
  actor: Actor;
  state: StepState;
  explicit: boolean;
  meaningful: number;
  texts: IRText[];
  tools: IRTool[];
  errors: IRError[];
  files: string[];
  reasoning: IRReasoning[];
  retries: number;
  patches: number;
  unknownParts: number;
}

interface TraceIR {
  steps: IRStep[];
  messageCount: number;
  partCount: number;
  compactionCount: number;
  digest: string;
  latestMessage: { index: number; role?: string; closed: boolean; summary: boolean } | undefined;
}

type EventKind = 'text' | 'tool' | 'retry' | 'assistant_error' | 'patch' | 'compaction' | 'unsupported';
type EventFieldName = typeof EVENT_FIELD_NAMES[number];

const EVENT_FIELDS: Record<EventKind, readonly EventFieldName[]> = {
  text: ['text'],
  tool: ['input', 'output', 'error'],
  retry: ['error'],
  assistant_error: ['error'],
  patch: ['files'],
  compaction: [],
  unsupported: [],
};

// native: unique message and part IDs. positional: no native IDs but content unique in the source.
// ambiguous: no native IDs and byte-identical to another event, so no selector can tell them apart.
type EventIdentity = 'native' | 'positional' | 'ambiguous';

interface TraceEvent {
  seq: number;
  kind: EventKind;
  actor: 'user' | 'assistant' | 'unknown';
  messageIndex: number;
  partIndex: number;
  messageID?: string;
  partID?: string;
  identity: EventIdentity;
  callID?: string;
  tool?: string;
  status?: string;
  title?: string;
  type?: string;
  synthetic?: true;
  summary?: true;
  compacted?: true;
  // Recorded, not yet authorized, child identity of a native task call.
  childSessionID?: string;
  childSessionRecord?: unknown[];
  fields: Partial<Record<EventFieldName, unknown>>;
  guard: string;
  chain: string;
}

interface EventIndex {
  events: TraceEvent[];
  reasoningParts: number;
  structuralParts: number;
  asOf: string;
}

type EventSelector =
  | { native: true; messageID: string; partID: string | null; guard: string }
  | { native: false; seq: number; guard: string; asOf: string };

// prefix: the first seq events are unchanged (native prefixes only). source: the whole eligible source is unchanged.
type IndexCursor = { seq: number; scope: 'prefix' | 'source'; digest: string };

export function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = record(value);
  if (object) return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function fieldText(value: unknown): string {
  return typeof value === 'string' ? value : stableJson(value);
}

function sourceValue(message: number, part: number, field: ContentField, value: unknown): SourceValue {
  const text = fieldText(value);
  return { message, part, field, value, bytes: Buffer.byteLength(text), digest: digest(text) };
}

function normalizeTrace(snapshot: SourceSnapshot): TraceIR {
  const steps: IRStep[] = [];
  let partCount = 0;
  let compactionCount = 0;
  let latestMessage: TraceIR['latestMessage'];

  const openStep = (actor: Actor, explicit: boolean, message: number): IRStep => {
    const step: IRStep = {
      number: steps.length + 1,
      message,
      actor,
      state: 'open',
      explicit,
      meaningful: 0,
      texts: [],
      tools: [],
      errors: [],
      files: [],
      reasoning: [],
      retries: 0,
      patches: 0,
      unknownParts: 0,
    };
    steps.push(step);
    return step;
  };

  snapshot.messages.forEach((message, messageIndex) => {
    const actor: Actor = message.role === 'user' ? 'user' : 'assistant';
    const { closed } = message;
    const summary = message.summary || message.parts.some((part) => part.kind === 'compaction');
    latestMessage = { index: messageIndex, role: message.role, closed, summary };
    partCount += message.parts.length;
    if (message.summary) compactionCount += 1;
    let current: IRStep | undefined;

    if (message.error !== undefined && actor === 'assistant') {
      current = openStep(actor, false, messageIndex);
      current.meaningful += 1;
      current.errors.push({ kind: 'assistant', source: sourceValue(messageIndex, -1, 'assistant.error', message.error) });
    }

    message.parts.forEach((part) => {
      if (part.kind === 'step' && part.boundary === 'start') {
        if (current) current.state = current.explicit ? 'malformed' : 'closed';
        current = openStep(actor, true, messageIndex);
        return;
      }
      if (!current) current = openStep(actor, false, messageIndex);

      if (part.kind === 'step') {
        current.state = !current.explicit && current.meaningful === 0 ? 'malformed' : 'closed';
        current = undefined;
        return;
      }
      current.meaningful += 1;
      if (part.kind === 'text') {
        current.texts.push({ source: sourceValue(messageIndex, part.index, 'text', part.text), messageClosed: closed });
      } else if (part.kind === 'reasoning') {
        current.reasoning.push({
          ...(part.plaintext === undefined ? {} : { plaintext: part.plaintext }),
          ...(part.tokens === undefined ? {} : { tokens: part.tokens }),
          opaque: part.plaintext === undefined,
        });
      } else if (part.kind === 'tool') {
        const tool: IRTool = {
          name: part.name,
          status: part.status,
          unresolved: part.unresolved,
          ...(part.input === undefined ? {} : { input: sourceValue(messageIndex, part.index, 'tool.input', part.input) }),
          ...(part.output === undefined ? {} : { output: sourceValue(messageIndex, part.index, 'tool.output', part.output) }),
          ...(part.error === undefined ? {} : { error: sourceValue(messageIndex, part.index, 'tool.error', part.error) }),
        };
        current.tools.push(tool);
        if (tool.error) current.errors.push({ kind: 'tool', source: tool.error });
      } else if (part.kind === 'retry') {
        current.retries += 1;
        if (part.error !== undefined) current.errors.push({ kind: 'retry', source: sourceValue(messageIndex, part.index, 'retry.error', part.error) });
      } else if (part.kind === 'patch') {
        current.patches += 1;
        if (part.files) current.files.push(...part.files.filter((file): file is string => typeof file === 'string'));
      } else if (part.kind === 'compaction') {
        compactionCount += 1;
      } else {
        current.unknownParts += 1;
      }
    });

    if (current) current.state = !current.explicit && closed ? 'closed' : 'open';
  });

  return {
    steps,
    messageCount: snapshot.messages.length,
    partCount,
    compactionCount,
    digest: snapshot.digest,
    latestMessage,
  };
}

/** A native ID usable in refs: visible ASCII within 256 bytes; anything else counts as missing. */
export function nativeID(value: unknown): string | undefined {
  return typeof value === 'string' && NATIVE_ID_PATTERN.test(value) ? value : undefined;
}

/** The child of a subagent call when every recorded value names the same valid ID; otherwise only the record. */
export function recordedChild(recorded: unknown[]): { id?: string; recorded: unknown[] } {
  const ids = recorded.map(nativeID);
  const id = ids.length > 0 && ids.every((entry) => entry !== undefined && entry === ids[0]) ? ids[0] : undefined;
  return { ...(id === undefined ? {} : { id }), recorded };
}

function withoutUndefined(value: RecordValue): RecordValue {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

// Builds the chronological index of non-reasoning events. Reasoning parts are counted only;
// their text, metadata, and IDs never enter an event, guard, chain, ref, or cursor. Refs and
// cursors carry native IDs or eligible-event seq, never raw part positions that count reasoning.
function indexEvents(snapshot: SourceSnapshot): EventIndex {
  type Draft = Omit<TraceEvent, 'seq' | 'identity' | 'guard' | 'chain'>;
  const drafts: Draft[] = [];
  let reasoningParts = 0;
  let structuralParts = snapshot.structuralRecords ?? 0;

  snapshot.messages.forEach((message, messageIndex) => {
    const actor: TraceEvent['actor'] = message.role === 'user' || message.role === 'assistant' ? message.role : 'unknown';
    const base = {
      actor,
      messageIndex,
      messageID: nativeID(message.id),
      ...(message.summary ? { summary: true as const } : {}),
    };

    for (const part of message.parts) {
      if (part.kind === 'step') {
        structuralParts += 1;
        continue;
      }
      if (part.kind === 'reasoning') {
        reasoningParts += 1;
        continue;
      }
      const at = { ...base, partIndex: part.index, partID: nativeID(part.id) };
      if (part.kind === 'text') {
        drafts.push({ ...at, kind: 'text', fields: { text: part.text }, ...(part.synthetic ? { synthetic: true as const } : {}) });
      } else if (part.kind === 'tool') {
        const fields: TraceEvent['fields'] = {};
        for (const field of EVENT_FIELDS.tool) if (part[field] !== undefined) fields[field] = part[field];
        drafts.push({
          ...at,
          kind: 'tool',
          tool: part.name,
          status: part.status,
          callID: part.callID,
          title: part.title,
          ...(part.compacted ? { compacted: true as const } : {}),
          ...(part.child.id === undefined ? {} : { childSessionID: part.child.id }),
          ...(part.child.recorded.length === 0 ? {} : { childSessionRecord: part.child.recorded }),
          fields,
        });
      } else if (part.kind === 'retry') {
        drafts.push({ ...at, kind: 'retry', fields: part.error === undefined ? {} : { error: part.error } });
      } else if (part.kind === 'patch') {
        drafts.push({ ...at, kind: 'patch', fields: part.files ? { files: part.files } : {} });
      } else if (part.kind === 'compaction') {
        drafts.push({ ...at, kind: 'compaction', fields: {} });
      } else {
        drafts.push({ ...at, kind: 'unsupported', type: part.type, fields: {} });
      }
    }

    if (message.error !== undefined && actor === 'assistant') {
      drafts.push({ ...base, partIndex: -1, kind: 'assistant_error', fields: { error: message.error } });
    }
  });

  const nativeKey = (draft: Draft): string | undefined => (
    draft.messageID && (draft.partIndex === -1 || draft.partID)
      ? JSON.stringify([draft.messageID, draft.partIndex === -1 ? null : draft.partID])
      : undefined
  );
  const keyCounts = new Map<string, number>();
  for (const draft of drafts) {
    const key = nativeKey(draft);
    if (key) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  let chain = '';
  const guardCounts = new Map<string, number>();
  const events = drafts.map((draft, index) => {
    const key = nativeKey(draft);
    const native = key !== undefined && keyCounts.get(key) === 1;
    const guard = digest(stableJson(withoutUndefined({
      kind: draft.kind,
      actor: draft.actor,
      message_id: draft.messageID,
      part_id: draft.partID,
      call_id: draft.callID,
      tool: draft.tool,
      status: draft.status,
      title: draft.title,
      type: draft.type,
      synthetic: draft.synthetic,
      summary: draft.summary,
      compacted: draft.compacted,
      child_session: draft.childSessionRecord,
      fields: draft.fields,
    })));
    chain = digest(`${chain}\n${guard}`);
    guardCounts.set(guard, (guardCounts.get(guard) ?? 0) + 1);
    return { ...draft, seq: index + 1, native, guard, chain };
  }).map(({ native, ...event }): TraceEvent => ({
    ...event,
    identity: native ? 'native' : guardCounts.get(event.guard) === 1 ? 'positional' : 'ambiguous',
  }));

  return { events, reasoningParts, structuralParts, asOf: chain || digest('') };
}

function coverageLimitations(index: EventIndex, ir: TraceIR): string[] {
  const present = new Set<string>();
  if (ir.compactionCount > 0) present.add('compacted_source');
  for (const event of index.events) {
    if (event.compacted) present.add('compacted_tool_output');
    if (event.kind === 'unsupported') present.add('unsupported_parts');
    if (event.identity !== 'native') present.add('positional_identity');
  }
  return COVERAGE_LIMITATIONS.filter((limitation) => present.has(limitation));
}

function jsonStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value)) - 2;
}

// Keeps a head and tail within a serialized-JSON byte budget so values that share a long
// prefix stay distinguishable. Splits only on code point boundaries.
function boundText(value: string, maxBytes: number): { text: string; abbreviated: boolean } {
  if (jsonStringBytes(value) <= maxBytes) return { text: value, abbreviated: false };
  const available = maxBytes - jsonStringBytes(ABBREVIATION_MARKER);
  const headBudget = Math.ceil(available * 0.6);
  const tailBudget = available - headBudget;
  let head = '';
  let headBytes = 0;
  for (const character of value) {
    const bytes = jsonStringBytes(character);
    if (headBytes + bytes > headBudget) break;
    head += character;
    headBytes += bytes;
  }
  let tailStart = value.length;
  let tailBytes = 0;
  while (tailStart > 0) {
    let start = tailStart - 1;
    const code = value.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff && start > 0) {
      const high = value.charCodeAt(start - 1);
      if (high >= 0xd800 && high <= 0xdbff) start -= 1;
    }
    const bytes = jsonStringBytes(value.slice(start, tailStart));
    if (tailBytes + bytes > tailBudget) break;
    tailBytes += bytes;
    tailStart = start;
  }
  return { text: `${head}${ABBREVIATION_MARKER}${value.slice(tailStart)}`, abbreviated: true };
}

function excerptValue(value: unknown, maxBytes: number): { value: unknown; abbreviated: boolean } {
  if (typeof value === 'string') {
    const bounded = boundText(value, maxBytes);
    return { value: bounded.text, abbreviated: bounded.abbreviated };
  }
  const text = stableJson(value);
  if (Buffer.byteLength(text) <= maxBytes) return { value, abbreviated: false };
  return { value: boundText(text, maxBytes).text, abbreviated: true };
}

function excerptInput(value: unknown): { value: unknown; abbreviated: boolean } {
  const complete = excerptValue(value, INDEX_INPUT_EXCERPT_BYTES);
  const input = record(value);
  if (!complete.abbreviated || !input) return complete;
  const identifying: RecordValue = {};
  for (const key of IDENTIFYING_INPUT_KEYS) {
    const entry = input[key];
    if (typeof entry === 'string') identifying[key] = boundText(entry, INDEX_INPUT_KEY_EXCERPT_BYTES).text;
    else if (typeof entry === 'number' || typeof entry === 'boolean') identifying[key] = entry;
  }
  return Object.keys(identifying).length > 0 ? { value: identifying, abbreviated: true } : complete;
}

function encodeToken(value: unknown[]): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeToken(value: unknown): unknown[] | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOKEN_LENGTH) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(parsed) && encodeToken(parsed) === value ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function eventRef(index: EventIndex, event: TraceEvent): string | undefined {
  if (event.identity === 'native') {
    return encodeToken([3, 'n', event.messageID, event.partIndex === -1 ? null : event.partID, event.guard]);
  }
  return event.identity === 'positional' ? encodeToken([3, 'p', event.seq, event.guard, index.asOf]) : undefined;
}

function decodeEventRef(value: unknown): EventSelector | undefined {
  const parsed = decodeToken(value);
  if (!parsed || parsed[0] !== 3) return undefined;
  if (parsed[1] === 'n' && parsed.length === 5) {
    const [, , messageID, partID, guard] = parsed;
    if (
      typeof messageID === 'string' && NATIVE_ID_PATTERN.test(messageID)
      && (partID === null || (typeof partID === 'string' && NATIVE_ID_PATTERN.test(partID)))
      && typeof guard === 'string' && DIGEST_PATTERN.test(guard)
    ) return { native: true, messageID, partID: partID as string | null, guard };
  }
  if (parsed[1] === 'p' && parsed.length === 5) {
    const [, , seq, guard, asOf] = parsed;
    if (
      Number.isSafeInteger(seq) && (seq as number) >= 1
      && typeof guard === 'string' && DIGEST_PATTERN.test(guard)
      && typeof asOf === 'string' && DIGEST_PATTERN.test(asOf)
    ) return { native: false, seq: seq as number, guard, asOf };
  }
  return undefined;
}

// Cursors are one readable string, `trace-cursor:v3:<scope>:<after_seq>:<guard>`, that callers pass
// back unchanged. `prefix` guards the native-identity chain of the first after_seq events (appends
// are accepted); `source` guards the whole eligible source. The guard is the complete digest.
function cursorToken(index: EventIndex, seq: number): string {
  const prefix = index.events.slice(0, seq).every((event) => event.identity === 'native');
  return `trace-cursor:v3:${prefix ? 'prefix' : 'source'}:${seq}:${prefix ? index.events[seq - 1].chain : index.asOf}`;
}

// Cursors issued before the readable form were base64url JSON `[3, 'c' | 's', seq, guard]`; they
// outlive a host restart inside stored model context, so the canonical legacy encoding still decodes.
function decodeCursor(value: unknown): IndexCursor | undefined {
  if (typeof value === 'string' && value.startsWith('trace-cursor:')) {
    const match = CURSOR_PATTERN.exec(value);
    const seq = match ? Number(match[2]) : NaN;
    return match && Number.isSafeInteger(seq)
      ? { seq, scope: match[1] as IndexCursor['scope'], digest: match[3] }
      : undefined;
  }
  const parsed = decodeToken(value);
  if (!parsed || parsed.length !== 4 || parsed[0] !== 3 || (parsed[1] !== 'c' && parsed[1] !== 's')) return undefined;
  const [, scope, seq, guard] = parsed;
  return Number.isSafeInteger(seq) && (seq as number) >= 1 && typeof guard === 'string' && DIGEST_PATTERN.test(guard)
    ? { seq: seq as number, scope: scope === 'c' ? 'prefix' : 'source', digest: guard }
    : undefined;
}

// Native selectors ignore unrelated source movement. Without native IDs, content equality is not
// identity: a positional selector requires the whole eligible source unchanged and the selected
// content to be unique in it, so a deleted, replaced, or duplicated action is never substituted.
function resolveEvent(index: EventIndex, selector: EventSelector): { event: TraceEvent } | { reason: string } {
  if (selector.native === true) {
    const { messageID, partID } = selector;
    const matches = index.events.filter((event) => event.messageID === messageID
      && (partID === null ? event.partIndex === -1 : event.partIndex !== -1 && event.partID === partID));
    if (matches.length === 0) return { reason: 'event_not_found' };
    if (matches.length > 1) return { reason: 'event_ambiguous' };
    return matches[0].identity === 'native' && matches[0].guard === selector.guard ? { event: matches[0] } : { reason: 'event_changed' };
  }
  if (index.asOf !== selector.asOf) return { reason: 'source_changed' };
  const event = index.events[selector.seq - 1];
  if (!event) return { reason: 'event_not_found' };
  if (event.guard !== selector.guard) return { reason: 'event_changed' };
  return event.identity === 'positional' ? { event } : { reason: 'identity_unavailable' };
}

function describeEvent(event: TraceEvent, target: RecordValue, abbreviated: string[]): void {
  const show = (key: string, value: string | undefined, maxBytes: number) => {
    if (value === undefined) return;
    const bounded = boundText(value, maxBytes);
    target[key] = bounded.text;
    if (bounded.abbreviated) abbreviated.push(key);
  };
  show('tool', event.tool, NAME_DISPLAY_BYTES);
  show('status', event.status, NAME_DISPLAY_BYTES);
  show('call_id', event.callID, NAME_DISPLAY_BYTES);
  // Candidate only: disclosedChildren removes it unless the runtime confirms the parent link.
  if (event.childSessionID !== undefined) target.child_session_id = event.childSessionID;
  show('title', event.title, TITLE_DISPLAY_BYTES);
  show('type', event.type, NAME_DISPLAY_BYTES);
  if (event.synthetic) target.synthetic = true;
  if (event.summary) target.summary = true;
  if (event.compacted) target.compacted = true;
}

function indexRow(index: EventIndex, event: TraceEvent): RecordValue {
  const row: RecordValue = { seq: event.seq, kind: event.kind, actor: event.actor };
  if (event.identity !== 'native') row.identity = event.identity;
  const abbreviated: string[] = [];
  describeEvent(event, row, abbreviated);
  const fieldNames = EVENT_FIELDS[event.kind];
  if (fieldNames.length > 0) {
    const bytes: RecordValue = {};
    for (const field of fieldNames) {
      if (!(field in event.fields)) continue;
      const value = event.fields[field];
      bytes[field] = Buffer.byteLength(fieldText(value));
      const excerpt = field === 'input' ? excerptInput(value) : excerptValue(value, INDEX_EXCERPT_BYTES);
      row[field] = excerpt.value;
      if (excerpt.abbreviated) abbreviated.push(field);
    }
    row.bytes = bytes;
  }
  if (abbreviated.length > 0) row.abbreviated = abbreviated;
  const ref = eventRef(index, event);
  if (ref !== undefined) row.ref = ref;
  return row;
}

function contextEntry(index: EventIndex, event: TraceEvent, extra: RecordValue = {}): RecordValue {
  const text = fieldText(event.fields.text);
  const bounded = boundText(text, CONTEXT_EXCERPT_BYTES);
  const ref = eventRef(index, event);
  return {
    seq: event.seq,
    text: bounded.text,
    bytes: Buffer.byteLength(text),
    ...(bounded.abbreviated ? { abbreviated: true } : {}),
    ...extra,
    ...(event.identity === 'native' ? {} : { identity: event.identity }),
    ...(ref === undefined ? {} : { ref }),
  };
}

function indexContext(index: EventIndex, ir: TraceIR, lifecycle: RecordValue): RecordValue {
  const assignment = index.events.find((event) => event.kind === 'text' && event.actor === 'user');
  const terminal = recoveryTerminalText(ir, lifecycle);
  const final = terminal
    ? index.events.find((event) => event.kind === 'text'
      && event.messageIndex === terminal.text.source.message
      && event.partIndex === terminal.text.source.part)
    : undefined;
  return {
    assignment: assignment ? contextEntry(index, assignment) : null,
    final: final ? contextEntry(index, final, { provenance: 'child_self_report', untrusted: true }) : null,
  };
}

function withExactRenderBytes(report: RecordValue): string {
  const render = record(report.render)!;
  let serialized = JSON.stringify(report);
  let bytes = Buffer.byteLength(serialized);
  while (render.bytes !== bytes) {
    render.bytes = bytes;
    serialized = JSON.stringify(report);
    bytes = Buffer.byteLength(serialized);
  }
  return serialized;
}

// Keeps child_session_id only on displayed rows whose candidate the runtime confirms now, checking
// each distinct candidate once. Removing a value only shrinks a row, so page budgets still hold.
async function disclosedChildren(rows: RecordValue[], authorizeChild: (childID: string) => Promise<boolean>): Promise<void> {
  const candidates = [...new Set(rows.flatMap((row) => typeof row.child_session_id === 'string' ? [row.child_session_id] : []))];
  const confirmed = new Set<string>();
  await Promise.all(candidates.map(async (childID) => {
    if (await authorizeChild(childID)) confirmed.add(childID);
  }));
  for (const row of rows) {
    if (typeof row.child_session_id === 'string' && !confirmed.has(row.child_session_id)) delete row.child_session_id;
  }
}

// Fills one page in source order under the byte budget and always includes at least one event.
async function renderIndexPage(
  taskID: string,
  target: RecordValue,
  ir: TraceIR,
  lifecycle: Lifecycle,
  index: EventIndex,
  start: IndexCursor | undefined,
  authorizeChild: (childID: string) => Promise<boolean>,
): Promise<string> {
  if (start && (
    start.seq > index.events.length
    || (start.scope === 'prefix' ? index.events[start.seq - 1].chain : index.asOf) !== start.digest
  )) {
    return JSON.stringify({ ok: false, reason: 'cursor_stale' });
  }
  const from = start?.seq ?? 0;
  const total = index.events.length;
  const reserve = Number.MAX_SAFE_INTEGER;
  const coverage: RecordValue = {
    events: total,
    from_seq: reserve,
    to_seq: reserve,
    complete: false,
    next_cursor: 'x'.repeat(CURSOR_RESERVE_BYTES),
    limitations: coverageLimitations(index, ir),
  };
  const rows: RecordValue[] = [];
  const page: RecordValue = {
    ok: true,
    version: 3,
    task_id: taskID,
    target,
    lifecycle,
    source: {
      messages: ir.messageCount,
      parts: ir.partCount,
      events: total,
      reasoning_parts: index.reasoningParts,
      structural_parts: index.structuralParts,
      fidelity: ir.compactionCount > 0 ? 'compacted_surviving_source' : 'surviving_source',
      compactions: ir.compactionCount,
      as_of: index.asOf,
    },
    coverage,
    context: indexContext(index, ir, lifecycle),
    reasoning: reasoningReport(ir.steps),
    events: rows,
    render: { bytes: reserve, budget_bytes: INDEX_PAGE_BUDGET_BYTES },
  };
  let used = Buffer.byteLength(JSON.stringify(page));
  for (let position = from; position < total; position += 1) {
    const row = indexRow(index, index.events[position]);
    const rowBytes = Buffer.byteLength(JSON.stringify(row)) + (rows.length > 0 ? 1 : 0);
    if (rows.length > 0 && used + rowBytes > INDEX_PAGE_BUDGET_BYTES) break;
    rows.push(row);
    used += rowBytes;
  }
  await disclosedChildren(rows, authorizeChild);
  const last = from + rows.length;
  coverage.from_seq = rows.length > 0 ? from + 1 : null;
  coverage.to_seq = rows.length > 0 ? last : null;
  coverage.next_cursor = last < total ? cursorToken(index, last) : null;
  coverage.complete = coverage.next_cursor === null;
  return withExactRenderBytes(page);
}

function fieldDetail(event: TraceEvent, field: EventFieldName): RecordValue {
  if (!(field in event.fields)) return { state: 'absent' };
  const value = event.fields[field];
  const text = fieldText(value);
  const format = typeof value === 'string' ? 'text' : 'json';
  const bytes = Buffer.byteLength(text);
  if (Buffer.byteLength(JSON.stringify(value) ?? 'null') <= CONTENT_CHUNK_BYTES) return { state: 'value', format, bytes, value };
  const chunk = utf8Chunk(Buffer.from(text), 0)!;
  return { state: 'chunked', format, bytes, sha256: digest(text), content: chunk.content, offset: 0, next_offset: chunk.nextOffset };
}

function eventDetail(event: TraceEvent): RecordValue {
  const detail: RecordValue = {
    seq: event.seq,
    kind: event.kind,
    actor: event.actor,
    identity: event.identity,
  };
  if (event.identity === 'native') {
    detail.message_id = event.messageID;
    if (event.partIndex !== -1) detail.part_id = event.partID;
  }
  const abbreviated: string[] = [];
  describeEvent(event, detail, abbreviated);
  if (abbreviated.length > 0) detail.abbreviated = abbreviated;
  detail.fields = Object.fromEntries(EVENT_FIELDS[event.kind].map((field) => [field, fieldDetail(event, field)]));
  return detail;
}

function utf8Chunk(bytes: Buffer, offset: number): { content: string; nextOffset: number | null } | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) {
    return undefined;
  }
  let end = Math.min(bytes.length, offset + CONTENT_CHUNK_BYTES);
  while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { content: bytes.subarray(offset, end).toString('utf8'), nextOffset: end < bytes.length ? end : null };
}

// Any unresolved tool record or open latest message keeps the lifecycle non-terminal, even when the
// runtime reports idle: a restarted instance forgets work without proving its effects stopped.
// `runtime` and `unresolved_tools` describe what was observed so callers can tell the cases apart.
function deriveLifecycle(ir: TraceIR, status: RuntimeStatus | undefined, placed: boolean): Lifecycle {
  const runtime: Lifecycle['runtime'] = !placed || status === undefined ? 'unavailable' : status;
  const unresolved = { latest_message: 0, earlier_messages: 0 };
  for (const step of ir.steps) {
    const count = step.tools.filter((tool) => tool.unresolved).length;
    if (step.message === ir.latestMessage?.index) unresolved.latest_message += count;
    else unresolved.earlier_messages += count;
  }
  const observed = {
    runtime,
    ...(unresolved.latest_message + unresolved.earlier_messages > 0 ? { unresolved_tools: unresolved } : {}),
  };
  const uncertain = (reason: string): Lifecycle => ({ state: 'uncertain', terminal: false, reason, ...observed });
  if (!placed) return uncertain('placement_unavailable');
  if (runtime === 'unavailable') return uncertain('status_unavailable');
  if (runtime === 'busy' || runtime === 'retry') return { state: 'active', terminal: false, reason: 'runtime_active', ...observed };
  if (observed.unresolved_tools) return uncertain('tool_pending_or_running');
  if (!ir.latestMessage || ir.latestMessage.role !== 'assistant') return uncertain('latest_message_not_assistant');
  if (ir.latestMessage.summary) return uncertain('latest_message_summary_or_compaction');
  if (!ir.latestMessage.closed) return uncertain('latest_assistant_open');
  return { state: 'terminal', terminal: true, reason: 'idle_and_closed', ...observed };
}

// Closed turns get the normal recovery projection. An idle runtime with open tool or message records
// gets an evidence-only snapshot that stays non-terminal and inspect-only; nothing else is eligible.
function recoveryScope(lifecycle: Lifecycle): RecoveryScope | undefined {
  if (lifecycle.terminal) return 'closed_turn';
  return lifecycle.runtime === 'idle' && (lifecycle.reason === 'tool_pending_or_running' || lifecycle.reason === 'latest_assistant_open')
    ? 'evidence_only'
    : undefined;
}

function encodeLocator(source: SourceValue): string {
  const locator: ContentLocator = [
    2,
    source.message,
    source.part,
    CONTENT_FIELDS.indexOf(source.field) + 1,
    source.bytes,
    source.digest,
  ];
  return Buffer.from(JSON.stringify(locator)).toString('base64url');
}

function decodeLocator(contentID: string): ContentLocator | undefined {
  if (!contentID || contentID.length > 1024) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(contentID, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 6) return undefined;
    const [version, message, part, field, bytes, sourceDigest] = parsed;
    if (
      version !== 2
      || !Number.isSafeInteger(message) || message < 0
      || !Number.isSafeInteger(part) || part < -1
      || !Number.isSafeInteger(field) || field < 1 || field > CONTENT_FIELDS.length
      || !Number.isSafeInteger(bytes) || bytes < 0
      || typeof sourceDigest !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sourceDigest)
    ) return undefined;
    const locator = parsed as ContentLocator;
    return Buffer.from(JSON.stringify(locator)).toString('base64url') === contentID ? locator : undefined;
  } catch {
    return undefined;
  }
}

function reasoningReport(steps: IRStep[]): RecordValue {
  const parts = steps.flatMap((step) => step.reasoning);
  const plaintext = parts.filter((part) => part.plaintext !== undefined);
  const opaque = parts.filter((part) => part.opaque);
  const knownTokens = parts.reduce((total, part) => total + (part.tokens ?? 0), 0);
  const unknownTokens = parts.filter((part) => part.tokens === undefined).length;
  return {
    availability: plaintext.length > 0 && opaque.length > 0 ? 'mixed' : plaintext.length > 0 ? 'plaintext' : opaque.length > 0 ? 'opaque' : 'none',
    parts: parts.length,
    plaintext_parts: plaintext.length,
    plaintext_bytes: plaintext.reduce((total, part) => total + Buffer.byteLength(part.plaintext ?? ''), 0),
    opaque_parts: opaque.length,
    tokens: unknownTokens > 0 ? null : knownTokens,
    known_tokens: knownTokens,
    unknown_token_parts: unknownTokens,
  };
}

function latestInstruction(ir: TraceIR) {
  return ir.steps
    .filter((step) => step.actor === 'user')
    .flatMap((step) => step.texts.map((text) => ({ step, text })))
    .at(-1);
}

function recoveryTerminalText(ir: TraceIR, lifecycle: RecordValue) {
  if (lifecycle.terminal !== true || !ir.latestMessage) return undefined;
  const terminalStep = [...ir.steps].reverse().find((step) => (
    step.message === ir.latestMessage!.index && step.actor === 'assistant'
  ));
  const text = terminalStep?.texts.at(-1);
  return terminalStep && text?.messageClosed ? { step: terminalStep, text } : undefined;
}

function splitUtf8(value: string, maxBytes: number): string[] {
  const input = Buffer.from(value);
  if (input.length === 0) return [''];
  const chunks: string[] = [];
  let start = 0;
  while (start < input.length) {
    let end = Math.min(input.length, start + maxBytes);
    while (end > start && end < input.length && (input[end] & 0xc0) === 0x80) end -= 1;
    if (end === start) {
      end = Math.min(input.length, start + maxBytes);
      while (end < input.length && (input[end] & 0xc0) === 0x80) end += 1;
    }
    chunks.push(input.subarray(start, end).toString('utf8'));
    start = end;
  }
  return chunks;
}

function compactRecoveryText(value: string): string {
  if (Buffer.byteLength(value) <= RECOVERY_PREVIEW_BYTES) return value;
  const marker = '... [truncated; inspect recovery:false for source detail]';
  const available = RECOVERY_PREVIEW_BYTES - Buffer.byteLength(marker);
  return `${splitUtf8(value, available)[0]}${marker}`;
}

function boundedRecoveryStrings(values: string[], maxBytes: number, maxItems = 8): string[] {
  const candidates = uniqueStrings(values.map(compactRecoveryText));
  const output: string[] = [];
  let bytes = 0;
  for (const value of candidates) {
    const valueBytes = Buffer.byteLength(value);
    if (output.length >= maxItems || bytes + valueBytes > maxBytes) {
      const marker = 'additional source items omitted; inspect recovery:false for source detail';
      const markerBytes = Buffer.byteLength(marker);
      while (output.length > 0 && bytes + markerBytes > maxBytes) {
        bytes -= Buffer.byteLength(output.pop()!);
      }
      if (markerBytes <= maxBytes) output.push(marker);
      break;
    }
    output.push(value);
    bytes += valueBytes;
  }
  return output;
}

function boundedRecoverySummary(values: string[], maxBytes: number): string | null {
  const bounded = boundedRecoveryStrings(values, maxBytes);
  return bounded.length > 0 ? bounded.join(' ') : null;
}

function recoveryCapabilities(step: IRStep): RecoveryCapabilities {
  const hasVisibleObservedEvidence = step.texts.some((entry) => fieldText(entry.source.value).trim().length > 0)
    || step.tools.length > 0
    || step.errors.length > 0
    || step.retries > 0
    || step.patches > 0
    || step.files.some((file) => file.trim().length > 0);
  const hasPlaintextReasoning = step.reasoning.some((entry) => entry.plaintext?.trim().length);
  return {
    hasVisibleObservedEvidence,
    hasPlaintextReasoning,
  };
}

function recoveryBasis(step: IRStep, capabilities = recoveryCapabilities(step)): RecoveryBasis {
  if (capabilities.hasVisibleObservedEvidence && capabilities.hasPlaintextReasoning) return 'mixed';
  return capabilities.hasPlaintextReasoning ? 'reasoning' : 'observed';
}

function recoveryFragments(steps: IRStep[], capabilities: Map<number, RecoveryCapabilities>): RecordValue[] {
  const fragments: RecordValue[] = [];
  for (const step of steps) {
    const stepCapabilities = capabilities.get(step.number)!;
    const observed = stableJson({
      actor: step.actor,
      state: step.state,
      text: step.texts.map((entry) => entry.source.value),
      tools: step.tools.map((entry) => ({
        name: entry.name,
        status: entry.status,
        ...(entry.input ? { input: entry.input.value } : {}),
        ...(entry.output ? { output: entry.output.value } : {}),
        ...(entry.error ? { error: entry.error.value } : {}),
      })),
      errors: step.errors.map((entry) => ({ kind: entry.kind, error: entry.source.value })),
      files: step.files,
      retries: step.retries,
      patches: step.patches,
      unknown_parts: step.unknownParts,
    });
    const reasoning = step.reasoning.flatMap((entry) => entry.plaintext?.trim().length ? [entry.plaintext] : []).join('\n');
    const opaqueReasoningParts = step.reasoning.filter((entry) => entry.opaque).length;
    fragments.push({
      step: step.number,
      source: {
        ...(stepCapabilities.hasVisibleObservedEvidence ? { observed } : {}),
        ...(stepCapabilities.hasPlaintextReasoning ? { reasoning } : {}),
        ...(opaqueReasoningParts > 0 ? { opaque_reasoning_parts: opaqueReasoningParts } : {}),
        basis: recoveryBasis(step, stepCapabilities),
      },
    });
  }
  return fragments;
}

function buildMapRequest(fragments: RecordValue[], targetChars: number): SummarizerStage & {
  range: number[];
  steps: number[];
} {
  const steps = [...new Set(fragments.map((fragment) => Number(fragment.step)))];
  const range = [steps[0], steps[steps.length - 1]];
  return {
    request: { kind: 'map', range, target_chars: targetChars, fragments },
    system: mapContract(range, steps, targetChars),
    range,
    steps,
  };
}

function stageBytes(stage: SummarizerStage): number {
  return Buffer.byteLength(stableJson(stage.request), 'utf8') + Buffer.byteLength(stage.system, 'utf8');
}

function numberRecoveryFragments(fragments: RecordValue[]): RecordValue[] {
  const totals = new Map<number, number>();
  const ordinals = new Map<number, number>();
  for (const fragment of fragments) {
    const step = Number(fragment.step);
    totals.set(step, (totals.get(step) ?? 0) + 1);
  }
  return fragments.map((fragment) => {
    const step = Number(fragment.step);
    const ordinal = (ordinals.get(step) ?? 0) + 1;
    ordinals.set(step, ordinal);
    return { ...fragment, fragment: ordinal, fragments: totals.get(step) };
  });
}

function splitRecoveryFragment(fragment: RecordValue): RecordValue[] {
  const source = record(fragment.source);
  if (!source) throw new Error('invalid recovery fragment');
  const left: RecordValue = { basis: source.basis };
  const right: RecordValue = { basis: source.basis };
  for (const [key, value] of Object.entries(source)) {
    if (key !== 'basis' && key !== 'observed' && key !== 'reasoning') left[key] = value;
  }
  let split = false;
  for (const channel of ['observed', 'reasoning'] as const) {
    const value = source[channel];
    if (typeof value !== 'string') continue;
    const chunks = splitUtf8(value, Math.ceil(Buffer.byteLength(value) / 2));
    if (chunks.length < 2) {
      left[channel] = value;
      continue;
    }
    left[channel] = chunks[0];
    right[channel] = chunks.slice(1).join('');
    split = true;
  }
  if (!split) throw new Error('map request envelope exceeds byte limit');
  return [
    { step: fragment.step, source: left },
    { step: fragment.step, source: right },
  ];
}

function batchFragments(input: RecordValue[], targetChars: number, mapBatchBytes: number): RecordValue[][] {
  const splitFragments = [...input];
  while (true) {
    const numbered = numberRecoveryFragments(splitFragments);
    const oversized = numbered.findIndex((fragment) => stageBytes(buildMapRequest([fragment], targetChars)) > mapBatchBytes);
    if (oversized < 0) break;
    splitFragments.splice(oversized, 1, ...splitRecoveryFragment(splitFragments[oversized]));
  }

  const fragments = numberRecoveryFragments(splitFragments);
  const batches: RecordValue[][] = [];
  let batch: RecordValue[] = [];
  for (const fragment of fragments) {
    const candidate = [...batch, fragment];
    if (batch.length > 0 && stageBytes(buildMapRequest(candidate, targetChars)) > mapBatchBytes) {
      batches.push(batch);
      batch = [fragment];
    } else {
      batch = candidate;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** `provider/model` split at the first slash; undefined unless both halves are non-empty. */
export function modelRef(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const separator = model.indexOf('/');
  return separator > 0 && separator < model.length - 1
    ? { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
    : undefined;
}

function mapBatchBytesFromModel(selected: ModelMetadata | undefined): number {
  const limit = record(selected?.limit);
  const context = limit?.context;
  const input = limit?.input;
  if (
    typeof context !== 'number'
    || !Number.isFinite(context)
    || context <= 0
    || (input !== undefined && (typeof input !== 'number' || !Number.isFinite(input) || input <= 0))
  ) return FALLBACK_MAP_BATCH_BYTES;
  const usableTokens = Math.min(typeof input === 'number' ? input : context, context);
  return Math.max(
    MIN_MAP_BATCH_BYTES,
    Math.floor(usableTokens * MAP_INPUT_CONTEXT_RATIO * ESTIMATED_UTF8_BYTES_PER_TOKEN),
  );
}

class RecoveryTimeoutError extends Error {
  constructor(readonly reason: 'summarizer_timeout' | 'recovery_deadline_exceeded') {
    super(reason);
  }
}

export function cancellationReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

async function boundedRequest<T>(
  run: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal,
  deadline: number,
  timeoutReason: 'summarizer_timeout' | 'recovery_deadline_exceeded',
): Promise<T> {
  if (callerSignal.aborted) throw cancellationReason(callerSignal);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new RecoveryTimeoutError('recovery_deadline_exceeded');
  const controller = new AbortController();
  let timedOut = false;
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const onAbort = () => {
    const reason = cancellationReason(callerSignal);
    controller.abort(reason);
    rejectCancellation(reason);
  };
  callerSignal.addEventListener('abort', onAbort, { once: true });
  let rejectTimeout!: (reason: unknown) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    const error = new RecoveryTimeoutError(timeoutReason);
    controller.abort(error);
    rejectTimeout(error);
  }, remaining);
  try {
    return await Promise.race([run(controller.signal), cancellation, timeout]);
  } catch (error) {
    if (callerSignal.aborted) throw cancellationReason(callerSignal);
    if (timedOut) throw new RecoveryTimeoutError(timeoutReason);
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal.removeEventListener('abort', onAbort);
  }
}

interface ModelProfile {
  mapBatchBytes: number;
  // True only when provider metadata positively shows the configured variant is not offered by the model.
  // Unknown metadata leaves the variant to the host, and the observed identity reports what ran.
  variantUnavailable: boolean;
}

/**
 * Binds the one selection a recovery uses: the configured summarizer model with its variant (a model alone keeps the
 * model's default variant rather than the caller's), or, with nothing configured, the invoking caller's own native
 * model and variant. Undefined when the caller's selection cannot be read; nothing is guessed in its place.
 */
async function bindSelection(
  host: SummarizerHost,
  callerID: string,
  callerSignal: AbortSignal,
  deadline: number,
): Promise<SummarizerSelection | undefined> {
  const { model, variant } = host.config;
  if (model !== undefined) {
    const ref = modelRef(model);
    if (!ref) throw new Error('The configured summarizer model was not validated as provider/model-id.');
    return Object.freeze({ ...ref, ...(variant !== undefined ? { variant } : {}), source: 'configured' as const });
  }
  if (variant !== undefined) throw new Error('A summarizer variant without a model was not rejected by configuration validation.');
  try {
    const caller = await boundedRequest(
      (signal) => host.callerSelection(callerID, signal),
      callerSignal,
      deadline,
      'recovery_deadline_exceeded',
    );
    return caller
      ? Object.freeze({ providerID: caller.providerID, modelID: caller.modelID, ...(caller.variant !== undefined ? { variant: caller.variant } : {}), source: 'caller' as const })
      : undefined;
  } catch {
    if (callerSignal.aborted) throw cancellationReason(callerSignal);
    return undefined;
  }
}

async function resolveModelProfile(
  host: SummarizerHost,
  selection: SummarizerSelection,
  callerSignal: AbortSignal,
  deadline: number,
): Promise<ModelProfile> {
  const unknown: ModelProfile = { mapBatchBytes: FALLBACK_MAP_BATCH_BYTES, variantUnavailable: false };
  try {
    const selected = await boundedRequest(
      (signal) => host.modelMetadata(selection, signal),
      callerSignal,
      deadline,
      'recovery_deadline_exceeded',
    );
    const variant = selection.variant;
    return {
      mapBatchBytes: mapBatchBytesFromModel(selected),
      variantUnavailable: variant !== undefined && selected !== undefined && !(selected.variants?.includes(variant) ?? false),
    };
  } catch {
    if (callerSignal.aborted) throw cancellationReason(callerSignal);
    return unknown;
  }
}

async function boundedCleanup<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new RecoveryTimeoutError('recovery_deadline_exceeded');
  const timeoutMs = Math.min(CLEANUP_ATTEMPT_MS, remaining);
  const controller = new AbortController();
  let rejectTimeout!: (reason: unknown) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    const error = new RecoveryTimeoutError('recovery_deadline_exceeded');
    controller.abort(error);
    rejectTimeout(error);
  }, timeoutMs);
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface Prompted {
  reply: SummarizerReply;
  reasons: RecoveryFailureReason[];
  // Value-free cause when the host or provider, not the reply content, defeated the request.
  diagnostic?: Diagnostic;
}

async function promptEphemeral(
  host: SummarizerHost,
  selection: SummarizerSelection,
  forbiddenSessionID: string,
  title: string,
  stage: SummarizerStage,
  profile: ModelProfile,
  callerSignal: AbortSignal,
  deadline: number,
): Promise<Prompted> {
  let sessionID: string | undefined;
  let reply = normalizeReply({});
  let diagnostic: Diagnostic | undefined;
  const reasons: RecoveryFailureReason[] = [];
  let cleanupFailed = false;
  let generationInterrupted = false;
  const attemptStarted = Date.now();
  const cleanupReserveMs = 2 * CLEANUP_ATTEMPT_MS;
  if (attemptStarted + cleanupReserveMs >= deadline) {
    if (callerSignal.aborted) throw cancellationReason(callerSignal);
    return { reply, reasons: ['recovery_deadline_exceeded'] };
  }
  if (profile.variantUnavailable) {
    return { reply, reasons: ['summarizer_unavailable'], diagnostic: { code: 'variant_unavailable' } };
  }
  if (stageBytes(stage) > profile.mapBatchBytes) {
    return { reply, reasons: ['summarizer_unavailable'], diagnostic: { code: 'request_too_large', bytes: stageBytes(stage) } };
  }
  const generationCap = attemptStarted + SUMMARIZER_ATTEMPT_MS;
  const generationDeadline = Math.min(deadline - cleanupReserveMs, generationCap);
  const abortDeadline = deadline - CLEANUP_ATTEMPT_MS;
  const attemptTimeoutReason = deadline - cleanupReserveMs <= generationCap
    ? 'recovery_deadline_exceeded' as const
    : 'summarizer_timeout' as const;
  try {
    const allocated = host.allocateSessionID?.();
    if (allocated === forbiddenSessionID) return { reply, reasons: ['summarizer_id_collision'] };
    if (allocated !== undefined) {
      sessionID = allocated;
      host.ephemeralSessionIDs.add(allocated);
    }
    const created = await boundedRequest(
      (signal) => host.create(title, selection, signal, allocated),
      callerSignal,
      generationDeadline,
      attemptTimeoutReason,
    );
    if (created === forbiddenSessionID) return { reply, reasons: ['summarizer_id_collision'] };
    if (allocated !== undefined && created !== allocated) {
      // A session the engine did not name exists; keep it owned and unconfirmed instead of guessing its cleanup.
      host.ephemeralSessionIDs.add(created);
      cleanupFailed = true;
      throw new Error('The host created a session other than the allocated one.');
    }
    const id = created;
    sessionID = id;
    host.ephemeralSessionIDs.add(id);
    try {
      reply = await boundedRequest(
        (signal) => host.generate(id, stage, selection, signal),
        callerSignal,
        generationDeadline,
        attemptTimeoutReason,
      );
    } catch (error) {
      generationInterrupted = error instanceof RecoveryTimeoutError || callerSignal.aborted;
      throw error;
    }
    if (reply.failure) {
      reasons.push('summarizer_unavailable');
      diagnostic = replyDiagnostic(reply, reply.failure.code, { error: reply.failure.error });
    }
  } catch (error) {
    if (!callerSignal.aborted) {
      if (error instanceof RecoveryTimeoutError) {
        reasons.push(error.reason);
      } else {
        reasons.push('summarizer_unavailable');
        diagnostic = { code: 'transport_error', error: describeError(error) };
      }
    }
  } finally {
    if (sessionID) {
      const id = sessionID;
      if (generationInterrupted && host.abort) {
        const abort = host.abort.bind(host);
        try {
          if (!(await boundedCleanup((signal) => abort(id, signal), abortDeadline))) cleanupFailed = true;
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        if (await boundedCleanup((signal) => host.remove(id, signal), deadline)) {
          host.ephemeralSessionIDs.delete(id);
        } else {
          cleanupFailed = true;
        }
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (callerSignal.aborted) throw cancellationReason(callerSignal);
  if (cleanupFailed) reasons.push('ephemeral_cleanup_failed');
  return { reply, reasons, ...(diagnostic ? { diagnostic } : {}) };
}

const MAX_FAILURE_DIAGNOSTICS = 4;

function orderedWithin(value: number[], minimum: number, maximum: number): boolean {
  let previous = minimum - 1;
  for (const entry of value) {
    if (entry < minimum || entry > maximum || entry <= previous) return false;
    previous = entry;
  }
  return true;
}

// Opaque reasoning parts are counted but never interpretable, so they do not make a step substantive.
function isSubstantive(capabilities: RecoveryCapabilities): boolean {
  return capabilities.hasVisibleObservedEvidence || capabilities.hasPlaintextReasoning;
}

function cardRule(card: RecoveryCard, capabilities: RecoveryCapabilities): 'unsupported_basis' | 'empty_card' | undefined {
  const hasContent = card.intent !== null
    || card.actions.length > 0
    || card.findings.length > 0
    || card.outcome !== null
    || card.unresolved.length > 0;
  const { hasVisibleObservedEvidence, hasPlaintextReasoning } = capabilities;
  if (!isSubstantive(capabilities)) {
    // Nothing to interpret: the only truthful card is the explicit empty one.
    return card.basis === 'observed' && !hasContent ? undefined : 'unsupported_basis';
  }
  const basisSupported = card.basis === 'observed'
    ? hasVisibleObservedEvidence
    : card.basis === 'reasoning'
      ? hasPlaintextReasoning
      : hasVisibleObservedEvidence && hasPlaintextReasoning;
  if (!basisSupported) return 'unsupported_basis';
  return hasContent ? undefined : 'empty_card';
}

function validateMapOutput(
  reply: SummarizerReply,
  range: number[],
  steps: number[],
  capabilities: Map<number, RecoveryCapabilities>,
): { validation?: MapValidation; diagnostics: Diagnostic[] } {
  const parsed = parseReply(reply);
  if (!parsed.value) return { diagnostics: [parsed.diagnostic!] };
  const envelope = mapEnvelopeSchema.safeParse(parsed.value);
  if (!envelope.success) return { diagnostics: [schemaDiagnostic(reply, envelope.error.issues)] };
  if (stableJson(envelope.data.range) !== stableJson(range)) return { diagnostics: [replyDiagnostic(reply, 'range_mismatch')] };
  if (envelope.data.cards.length !== steps.length) return { diagnostics: [replyDiagnostic(reply, 'card_count_mismatch')] };
  const cards: RecoveryCard[] = [];
  const invalidSteps: number[] = [];
  const diagnostics: Diagnostic[] = [];
  const invalid = (step: number, diagnostic: Diagnostic) => {
    invalidSteps.push(step);
    if (diagnostics.length < MAX_FAILURE_DIAGNOSTICS) diagnostics.push({ ...diagnostic, step });
  };
  for (const [index, raw] of envelope.data.cards.entries()) {
    const step = steps[index];
    const card = mapCardSchema.safeParse(raw);
    if (!card.success) {
      invalid(step, schemaDiagnostic(undefined, card.error.issues));
    } else if (card.data.step !== step) {
      invalid(step, { code: 'card_step_mismatch' });
    } else {
      // Without strictNullChecks the schema's nullable fields infer as optional.
      const checked = card.data as RecoveryCard;
      const rule = cardRule(checked, capabilities.get(step)!);
      if (rule) invalid(step, { code: rule });
      else cards.push(checked);
    }
  }
  return { validation: { cards, invalidSteps }, diagnostics };
}

type ReducerReason = 'invalid_reducer_output' | 'invalid_phase_coverage';

// A wrong phase count or malformed phase span is a coverage problem; every other shape problem is output shape.
function reductionSchemaReason(issue: { path: ReadonlyArray<PropertyKey>; code: string } | undefined): ReducerReason {
  const [root, field, index, leaf] = issue?.path ?? [];
  if (root !== 'semantic' || field !== 'phases') return 'invalid_reducer_output';
  if (index === undefined) return issue?.code === 'too_small' || issue?.code === 'too_big' ? 'invalid_phase_coverage' : 'invalid_reducer_output';
  return leaf === 'range' || leaf === 'source_steps' ? 'invalid_phase_coverage' : 'invalid_reducer_output';
}

function validateReduction(
  reply: SummarizerReply,
  stepCount: number,
  substantiveSteps: ReadonlySet<number>,
  completionSteps: ReadonlySet<number>,
): {
  semantic?: RecordValue;
  reason?: ReducerReason;
  diagnostic?: Diagnostic;
} {
  const parsed = parseReply(reply);
  if (!parsed.value) return { reason: 'invalid_reducer_output', diagnostic: parsed.diagnostic };
  const output = reduceSchema.safeParse(parsed.value);
  if (!output.success) {
    return {
      reason: reductionSchemaReason(output.error.issues[0]),
      diagnostic: schemaDiagnostic(reply, output.error.issues),
    };
  }
  const { semantic } = output.data;
  const coverage = (): { reason: ReducerReason; diagnostic: Diagnostic } => ({
    reason: 'invalid_phase_coverage',
    diagnostic: replyDiagnostic(reply, 'phase_coverage'),
  });
  if (stepCount > 12 && semantic.phases.length < 6) return coverage();
  let expectedStart = 1;
  for (const phase of semantic.phases) {
    const [start, end] = phase.range;
    if (start !== expectedStart || end < start || end > stepCount || !orderedWithin(phase.source_steps, start, end)) return coverage();
    expectedStart = end + 1;
  }
  if (expectedStart !== stepCount + 1) return coverage();

  const action = semantic.safest_next_action;
  const claimsValid = [
    ...semantic.completed.map((claim) => ({ claim, supporting: completionSteps })),
    ...semantic.unfinished.map((claim) => ({ claim, supporting: substantiveSteps })),
  ].every(({ claim, supporting }) => (
    orderedWithin(claim.source_steps, 1, stepCount) && claim.source_steps.some((step) => supporting.has(step))
  ));
  const actionValid = orderedWithin(action.source_steps, 1, stepCount)
    && (semantic.unfinished.length > 0
      ? action.action === 'launch_fresh_task' && action.context !== null
      : action.action === 'review_completed_work' && action.context === null);
  if (!claimsValid) return { reason: 'invalid_reducer_output', diagnostic: replyDiagnostic(reply, 'claim_rule') };
  if (!actionValid) return { reason: 'invalid_reducer_output', diagnostic: replyDiagnostic(reply, 'action_rule') };
  return { semantic };
}

function fallbackCard(step: IRStep): RecoveryCard {
  const toolCounts = new Map<string, { name: string; status: string; count: number }>();
  for (const tool of step.tools) {
    const key = stableJson([tool.name, tool.status]);
    const known = toolCounts.get(key);
    if (known) known.count += 1;
    else toolCounts.set(key, { name: tool.name, status: tool.status, count: 1 });
  }
  const plaintextReasoning = step.reasoning.filter((entry) => entry.plaintext?.trim().length).length;
  const toolSourceFields = step.tools.reduce((counts, tool) => ({
    input: counts.input + Number(tool.input !== undefined),
    output: counts.output + Number(tool.output !== undefined),
    error: counts.error + Number(tool.error !== undefined),
  }), { input: 0, output: 0, error: 0 });
  const findings = [
    ...(plaintextReasoning > 0
      ? [`plaintext reasoning present (${plaintextReasoning} ${plaintextReasoning === 1 ? 'part' : 'parts'}; source text not published)`]
      : []),
    ...(toolSourceFields.input + toolSourceFields.output + toolSourceFields.error > 0
      ? [`tool source fields present (input=${toolSourceFields.input}, output=${toolSourceFields.output}, error=${toolSourceFields.error}); inspect recovery:false for source detail`]
      : []),
    ...(step.actor === 'assistant' ? step.texts.map((entry) => fieldText(entry.source.value)) : []),
  ];
  return {
    step: step.number,
    intent: null,
    actions: boundedRecoveryStrings(
      [...toolCounts.values()].map((entry) => `${entry.name} [${entry.status}] x${entry.count}`),
      RECOVERY_CARD_ACTION_BYTES,
    ),
    findings: boundedRecoveryStrings(findings, RECOVERY_CARD_FINDING_BYTES),
    outcome: null,
    unresolved: boundedRecoveryStrings(
      step.errors.map((entry) => `${entry.kind} error present: ${fieldText(entry.source.value)}`),
      RECOVERY_CARD_UNRESOLVED_BYTES,
    ),
    basis: recoveryBasis(step),
  };
}

function mergeCards(step: IRStep, cards: Array<{ order: number; card: RecoveryCard }>): RecoveryCard {
  const ordered = [...cards].sort((left, right) => left.order - right.order).map((entry) => entry.card);
  const mergeNullable = (values: Array<string | null>): string | null => {
    const present = values.filter((value): value is string => value !== null);
    return present.length > 0 ? present.join(' ') : null;
  };
  return {
    step: step.number,
    intent: mergeNullable(ordered.map((card) => card.intent)),
    actions: ordered.flatMap((card) => card.actions),
    findings: ordered.flatMap((card) => card.findings),
    outcome: mergeNullable(ordered.map((card) => card.outcome)),
    unresolved: ordered.flatMap((card) => card.unresolved),
    basis: new Set(ordered.map((card) => card.basis)).size === 1 ? ordered[0].basis : 'mixed',
  };
}

function runtimeCard(card: RecoveryCard, source: 'generated' | 'fallback'): RuntimeRecoveryCard {
  return {
    ...card,
    provenance: source === 'generated' ? 'summarizer_interpretation' : 'deterministic_extractive_fallback',
    untrusted: true,
    source,
  };
}

function balancedPhaseRanges(stepCount: number): Array<[number, number]> {
  const phaseCount = stepCount <= 12
    ? stepCount
    : Math.min(12, Math.max(6, Math.ceil(stepCount / 8)));
  const ranges: Array<[number, number]> = [];
  let start = 1;
  for (let index = 0; index < phaseCount; index += 1) {
    const size = Math.ceil((stepCount - start + 1) / (phaseCount - index));
    const end = start + size - 1;
    ranges.push([start, end]);
    start = end + 1;
  }
  return ranges;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function combinedBasis(cards: RuntimeRecoveryCard[]): RecoveryBasis {
  const bases = new Set(cards.map((card) => card.basis));
  return bases.size === 1 ? cards[0].basis : 'mixed';
}

function fallbackReduction(cards: RuntimeRecoveryCard[], completionSteps: ReadonlySet<number>): RecordValue {
  const phases = balancedPhaseRanges(cards.length).map(([start, end], index) => {
    const covered = cards.slice(start - 1, end);
    const intents = uniqueStrings(covered.flatMap((card) => card.intent === null ? [] : [card.intent]));
    const outcomes = uniqueStrings(covered.flatMap((card) => card.outcome === null || !completionSteps.has(card.step) ? [] : [card.outcome]));
    return {
      range: [start, end],
      title: `Source steps ${start}-${end}`,
      intent: boundedRecoverySummary(intents, RECOVERY_PHASE_SUMMARY_BYTES),
      actions: boundedRecoveryStrings(covered.flatMap((card) => card.actions), RECOVERY_PHASE_ACTION_BYTES, 12),
      findings: boundedRecoveryStrings(covered.flatMap((card) => card.findings), RECOVERY_PHASE_FINDING_BYTES, 12),
      outcome: boundedRecoverySummary(outcomes, RECOVERY_PHASE_SUMMARY_BYTES),
      unresolved: boundedRecoveryStrings(covered.flatMap((card) => card.unresolved), RECOVERY_PHASE_UNRESOLVED_BYTES, 12),
      source_steps: Array.from({ length: end - start + 1 }, (_, offset) => start + offset),
    };
  });
  return {
    overview: `Recovered ${cards.length} source steps with deterministic balanced fallback phases. Inspect the source before acting.`,
    phases,
    completed: cards.flatMap((card) => card.outcome === null || !completionSteps.has(card.step) ? [] : [{ claim: card.outcome, source_steps: [card.step] }]),
    unfinished: cards.flatMap((card) => card.unresolved.map((claim) => ({ claim, source_steps: [card.step] }))),
    safest_next_action: {
      action: 'inspect',
      context: null,
      source_steps: cards.map((card) => card.step),
    },
  };
}

function sourceStepUnion(claims: unknown, fallback: number[]): number[] {
  if (!Array.isArray(claims)) return fallback;
  const steps = claims.flatMap((raw) => {
    const claim = record(raw);
    return Array.isArray(claim?.source_steps) ? claim.source_steps.filter((step): step is number => typeof step === 'number') : [];
  });
  const unique = [...new Set(steps)].sort((left, right) => left - right);
  return unique.length > 0 ? unique : fallback;
}

function finalizeSemantic(
  semantic: RecordValue,
  cards: RuntimeRecoveryCard[],
  ir: TraceIR,
  provenance: 'summarizer_interpretation' | 'deterministic_recovery_fallback',
  forceInspect: boolean,
): RecordValue {
  const phases = (semantic.phases as RecordValue[]).map((phase) => {
    const [start, end] = phase.range as [number, number];
    const covered = cards.slice(start - 1, end);
    const errorSteps = ir.steps
      .slice(start - 1, end)
      .filter((step) => step.errors.length > 0)
      .map((step) => step.number);
    return { ...phase, basis: combinedBasis(covered), error_steps: errorSteps };
  });
  const allSteps = cards.map((card) => card.step);
  const unfinished = semantic.unfinished as RecordValue[];
  const generatedAction = record(semantic.safest_next_action)!;
  let safestNextAction: RecordValue;
  if (forceInspect) {
    safestNextAction = { action: 'inspect', context: null, source_steps: allSteps };
  } else if (unfinished.length > 0) {
    safestNextAction = {
      action: 'launch_fresh_task',
      context: generatedAction.context,
      source_steps: sourceStepUnion(unfinished, allSteps),
    };
  } else {
    safestNextAction = {
      action: 'review_completed_work',
      context: null,
      source_steps: sourceStepUnion(semantic.completed, allSteps),
    };
  }
  return {
    provenance,
    untrusted: true,
    overview: semantic.overview,
    phases,
    completed: semantic.completed,
    unfinished,
    safest_next_action: safestNextAction,
  };
}

function boundedRecoveryRecords(values: RecordValue[], label: string): RecordValue[] {
  const output: RecordValue[] = [];
  let bytes = 0;
  for (const [index, value] of values.entries()) {
    const valueBytes = Buffer.byteLength(stableJson(value));
    if (output.length >= 12 || bytes + valueBytes > RECOVERY_ANCHOR_BYTES) {
      const marker = {
        omitted: values.length - index,
        detail: `additional ${label} omitted; inspect recovery:false for source detail`,
      };
      const markerBytes = Buffer.byteLength(stableJson(marker));
      while (output.length > 0 && bytes + markerBytes > RECOVERY_ANCHOR_BYTES) {
        bytes -= Buffer.byteLength(stableJson(output.pop()!));
      }
      output.push(marker);
      break;
    }
    output.push(value);
    bytes += valueBytes;
  }
  return output;
}

function recoveryAnchors(ir: TraceIR): RecordValue {
  const errors = ir.steps.flatMap((step) => step.errors.map((entry) => ({
    step: step.number,
    kind: entry.kind,
    error: compactRecoveryText(fieldText(entry.source.value)),
  })));
  const changedFiles = ir.steps.flatMap((step) => step.files.length > 0 ? [{
    step: step.number,
    files: boundedRecoveryStrings(step.files, RECOVERY_CARD_FINDING_BYTES),
  }] : []);
  return {
    errors: boundedRecoveryRecords(errors, 'errors'),
    changed_files: boundedRecoveryRecords(changedFiles, 'changed-file anchors'),
  };
}

/** The bound selection, or before binding what the configuration asks for: a configured model, or the caller's. */
function requestedRecoveryModel(host: SummarizerHost, selection?: SummarizerSelection): RecordValue {
  if (selection) {
    return {
      model: `${selection.providerID}/${selection.modelID}`,
      ...(selection.variant !== undefined ? { variant: selection.variant } : {}),
      source: selection.source,
    };
  }
  return host.config.model !== undefined
    ? { model: host.config.model, ...(host.config.variant !== undefined ? { variant: host.config.variant } : {}), source: 'configured' }
    : { source: 'caller' };
}

async function recover(
  host: SummarizerHost,
  taskID: string,
  callerID: string,
  ir: TraceIR,
  relationship: TargetRelationship,
  scope: RecoveryScope,
  callerSignal: AbortSignal,
): Promise<{ recovery: RecordValue; semantic: RecordValue | null }> {
  if (callerSignal.aborted) throw cancellationReason(callerSignal);
  const recoveryDeadline = Date.now() + SEMANTIC_RECOVERY_MS;
  const mapDeadline = recoveryDeadline - REDUCTION_RESERVE_MS;
  const targetChars = Math.max(80, Math.min(280, Math.round(14_000 / ir.steps.length)));
  const capabilities = new Map(ir.steps.map((step) => [step.number, recoveryCapabilities(step)]));
  const substantiveSteps = new Set(ir.steps.filter((step) => isSubstantive(capabilities.get(step.number)!)).map((step) => step.number));
  // Only substantive assistant steps are worker output; a user step is context and cannot support a completed claim.
  const completionSteps = new Set(ir.steps.filter((step) => step.actor === 'assistant' && substantiveSteps.has(step.number)).map((step) => step.number));
  const selection = await bindSelection(host, callerID, callerSignal, mapDeadline);
  if (!selection) {
    return {
      recovery: {
        status: 'unavailable',
        scope: null,
        failures: [{ stage: 'model', reasons: ['summarizer_unavailable'], diagnostics: [{ code: 'caller_model_unavailable' }] }],
        model: { requested: requestedRecoveryModel(host) },
        cards_source: null,
        phases_source: null,
      },
      semantic: null,
    };
  }
  const profile = await resolveModelProfile(host, selection, callerSignal, mapDeadline);
  const batches = batchFragments(recoveryFragments(ir.steps, capabilities), targetChars, profile.mapBatchBytes);
  const generatedCards = new Map<number, Array<{ order: number; card: RecoveryCard }>>();
  const failedSteps = new Set<number>();
  const failures: RecordValue[] = [];
  let observed: RecordValue | undefined;
  const outcomes: Array<{
    range: number[];
    steps: number[];
    prompted: Prompted;
  } | undefined> = new Array(batches.length);
  let nextBatch = 0;
  const workers = Array.from({ length: Math.min(MAX_MAP_CONCURRENCY, batches.length) }, async () => {
    while (nextBatch < batches.length) {
      const index = nextBatch;
      nextBatch += 1;
      if (callerSignal.aborted) throw cancellationReason(callerSignal);
      if (Date.now() >= mapDeadline) return;
      const { range, steps, ...stage } = buildMapRequest(batches[index], targetChars);
      const prompted = await promptEphemeral(host, selection, taskID, `Hive task trace map ${index + 1}`, stage, profile, callerSignal, mapDeadline);
      outcomes[index] = { range, steps, prompted };
    }
  });
  await Promise.allSettled(workers);
  if (callerSignal.aborted) throw cancellationReason(callerSignal);

  const collision = outcomes.find((outcome) => outcome?.prompted.reasons.includes('summarizer_id_collision'));
  if (collision) {
    return {
      recovery: {
        status: 'unavailable',
        scope: null,
        failures: [{ stage: 'map', range: collision.range, reasons: ['summarizer_id_collision'] }],
        model: { requested: requestedRecoveryModel(host, selection) },
        cards_source: null,
        phases_source: null,
      },
      semantic: null,
    };
  }

  for (const [index, fragments] of batches.entries()) {
    const outcome = outcomes[index];
    const { range, steps } = outcome ?? buildMapRequest(fragments, targetChars);
    if (!outcome) {
      failures.push({ stage: 'map', range, reasons: ['recovery_deadline_exceeded'] });
      steps.forEach((step) => failedSteps.add(step));
      continue;
    }
    const { prompted } = outcome;
    observed = prompted.reply.observed ?? observed;
    const providerFailed = prompted.reasons.some((reason) => (
      reason === 'summarizer_unavailable'
      || reason === 'summarizer_timeout'
      || reason === 'recovery_deadline_exceeded'
    ));
    const cleanupFailed = prompted.reasons.includes('ephemeral_cleanup_failed');
    const checked = providerFailed ? undefined : validateMapOutput(prompted.reply, range, steps, capabilities);
    const validation = checked?.validation;
    const invalidMap = checked !== undefined && (!validation || validation.invalidSteps.length > 0);
    const reasons: RecoveryFailureReason[] = [
      ...(providerFailed ? prompted.reasons.filter((reason) => reason !== 'ephemeral_cleanup_failed') : invalidMap ? ['invalid_map_output' as const] : []),
      ...(cleanupFailed ? ['ephemeral_cleanup_failed' as const] : []),
    ];
    const diagnostics = providerFailed ? (prompted.diagnostic ? [prompted.diagnostic] : []) : checked?.diagnostics ?? [];
    if (reasons.length > 0) failures.push({ stage: 'map', range, reasons, ...(diagnostics.length > 0 ? { diagnostics } : {}) });
    if (providerFailed || cleanupFailed || !validation) {
      steps.forEach((step) => failedSteps.add(step));
      continue;
    }
    validation.invalidSteps.forEach((step) => failedSteps.add(step));
    for (const card of validation.cards) {
      const cardFragments = fragments.filter((fragment) => Number(fragment.step) === card.step);
      const order = Math.min(...cardFragments.map((fragment) => Number(fragment.fragment)));
      const values = generatedCards.get(card.step) ?? [];
      values.push({ order, card });
      generatedCards.set(card.step, values);
    }
  }

  let generatedCount = 0;
  const cards = ir.steps.map((step) => {
    const generated = generatedCards.get(step.number);
    if (!failedSteps.has(step.number) && generated && generated.length > 0) {
      generatedCount += 1;
      return runtimeCard(mergeCards(step, generated), 'generated');
    }
    return runtimeCard(fallbackCard(step), 'fallback');
  });
  const cardsSource = generatedCount === cards.length ? 'generated' : generatedCount === 0 ? 'fallback' : 'mixed';
  let phasesSource: 'generated' | 'fallback' = 'fallback';
  let semantic: RecordValue | undefined;

  if (generatedCount === 0) {
    failures.push({ stage: 'reduce', reasons: ['no_successful_map_ranges'] });
  } else {
    const stage: SummarizerStage = {
      request: { kind: 'reduce', step_count: ir.steps.length, completion_steps: [...completionSteps], cards, anchors: recoveryAnchors(ir) },
      system: reduceContract(ir.steps.length),
    };
    const prompted = await promptEphemeral(host, selection, taskID, 'Hive task trace semantic reduction', stage, profile, callerSignal, recoveryDeadline);
    if (prompted.reasons.includes('summarizer_id_collision')) {
      return {
        recovery: {
          status: 'unavailable',
          scope: null,
          failures: [{ stage: 'reduce', reasons: ['summarizer_id_collision'] }],
          model: {
            requested: requestedRecoveryModel(host, selection),
            ...(observed ? { observed } : {}),
          },
          cards_source: null,
          phases_source: null,
        },
        semantic: null,
      };
    }
    observed = prompted.reply.observed ?? observed;
    const providerFailed = prompted.reasons.some((reason) => (
      reason === 'summarizer_unavailable'
      || reason === 'summarizer_timeout'
      || reason === 'recovery_deadline_exceeded'
    ));
    const cleanupFailed = prompted.reasons.includes('ephemeral_cleanup_failed');
    const validated: ReturnType<typeof validateReduction> = providerFailed
      ? {}
      : validateReduction(prompted.reply, ir.steps.length, substantiveSteps, completionSteps);
    const reasons: RecoveryFailureReason[] = [
      ...(providerFailed ? prompted.reasons.filter((reason) => reason !== 'ephemeral_cleanup_failed') : validated.semantic ? [] : [validated.reason ?? 'invalid_reducer_output']),
      ...(cleanupFailed ? ['ephemeral_cleanup_failed' as const] : []),
    ];
    const diagnostic = providerFailed ? prompted.diagnostic : validated.diagnostic;
    if (reasons.length > 0) {
      failures.push({ stage: 'reduce', reasons, ...(diagnostic ? { diagnostics: [diagnostic] } : {}) });
    } else {
      semantic = validated.semantic!;
      phasesSource = 'generated';
    }
  }
  semantic ??= fallbackReduction(cards, completionSteps);

  // complete/partial describe summary coverage of the surviving source, not task completion.
  const status = failures.length === 0 ? 'complete' : 'partial';
  const forceInspect = scope === 'evidence_only'
    || status === 'partial'
    || cardsSource !== 'generated'
    || phasesSource !== 'generated'
    || completionSteps.size === 0
    || ir.compactionCount > 0
    || ir.steps.some((step) => step.errors.length > 0)
    || relationship !== 'direct_child';
  return {
    recovery: {
      status,
      scope,
      failures,
      model: {
        requested: requestedRecoveryModel(host, selection),
        ...(observed ? { observed } : {}),
      },
      cards_source: cardsSource,
      phases_source: phasesSource,
    },
    semantic: finalizeSemantic(
      semantic,
      cards,
      ir,
      phasesSource === 'generated' ? 'summarizer_interpretation' : 'deterministic_recovery_fallback',
      forceInspect,
    ),
  };
}

function recoverySourceValue(source: SourceValue, inlineBytes: number): unknown {
  if (source.bytes <= inlineBytes) return source.value;
  return { content_id: encodeLocator(source), bytes: source.bytes, sha256: source.digest };
}

function recoveryProjection(
  taskID: string,
  target: RecordValue,
  ir: TraceIR,
  lifecycle: RecordValue,
  recovery: RecordValue,
  semantic: RecordValue | null,
): RecordValue {
  const instruction = latestInstruction(ir);
  const final = recoveryTerminalText(ir, lifecycle);
  const files: string[] = [];
  const seenFiles = new Set<string>();
  for (const step of ir.steps) {
    for (const file of step.files) {
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      files.push(file);
    }
  }
  return {
    ok: true,
    version: 2,
    task_id: taskID,
    target,
    lifecycle,
    source: {
      steps: ir.steps.length,
      fidelity: ir.compactionCount > 0 ? 'compacted_surviving_source' : 'surviving_source',
      compactions: ir.compactionCount,
      as_of: ir.digest,
    },
    ...(instruction ? {
      task_instruction: {
        step: instruction.step.number,
        text: recoverySourceValue(instruction.text.source, INITIAL_TEXT_INLINE_BYTES),
      },
    } : {}),
    final_response: final
      ? {
        step: final.step.number,
        text: recoverySourceValue(final.text.source, INITIAL_TEXT_INLINE_BYTES),
        provenance: 'child_self_report',
        untrusted: true,
      }
      : null,
    recovery,
    semantic,
    errors: ir.steps.flatMap((step) => step.errors.map((entry) => ({
      kind: entry.kind,
      step: step.number,
      error: recoverySourceValue(entry.source, INITIAL_ERROR_INLINE_BYTES),
    }))),
    changed_files: { files, exhaustive: false },
    render: { actual_bytes: 0, soft_target_bytes: SOFT_TARGET_BYTES },
  };
}

function finalizeRecoveryProjection(report: RecordValue): string {
  const render = record(report.render)!;
  let serialized = JSON.stringify(report);
  let bytes = Buffer.byteLength(serialized);
  while (render.actual_bytes !== bytes) {
    render.actual_bytes = bytes;
    serialized = JSON.stringify(report);
    bytes = Buffer.byteLength(serialized);
  }
  return serialized;
}

function readLocatedValue(snapshot: SourceSnapshot, locator: ContentLocator): unknown {
  const [, messageIndex, partIndex, fieldIndex] = locator;
  const message = snapshot.messages[messageIndex];
  if (!message) return undefined;
  const field = CONTENT_FIELDS[fieldIndex - 1];
  if (field === 'assistant.error') return partIndex === -1 && message.role === 'assistant' ? message.error : undefined;
  const kind = field === 'text' ? 'text' : field === 'retry.error' ? 'retry' : 'tool';
  const part = message.parts.find((entry) => entry.kind === kind && entry.index === partIndex);
  if (part?.kind === 'text') return part.text;
  if (part?.kind === 'retry') return part.error;
  if (part?.kind !== 'tool') return undefined;
  if (field === 'tool.input') return part.input;
  if (field === 'tool.output') return part.output;
  return part.error;
}

/** Tool descriptions and arguments, shared by both hosts so the model sees one contract. */
export const TRACE_TOOL_DEFINITIONS = {
  hive_task_trace: {
    description: 'Inspect any explicitly identified OpenCode session visible to the connected runtime when its result failed, blocked, timed out, was cancelled, is empty, or is unclear. Returns a read-only paged forensic v3 index of surviving non-reasoning events in source order, with lifecycle, assignment and final self-report context, bounded excerpts, event refs, and coverage; for the next page pass the entire coverage.next_cursor string unchanged as cursor, and read one event in detail with hive_task_trace_content, passing its events[n].ref as event. Native task call rows show child_session_id when the runtime confirms that child belongs to the traced session. Optional recovery observes a finished turn and returns an untrusted semantic projection with runtime-safe next actions; for an idle runtime whose records stay open it returns an inspect-only evidence snapshot.',
    args: {
      task_id: z.string().describe('OpenCode session ID visible through the connected runtime.'),
      cursor: z.string().optional().describe('The entire coverage.next_cursor string from the previous index page, passed unchanged (a readable trace-cursor:v3:<prefix|source>:<after_seq>:<guard> value; do not decode, edit, or rebuild it). Omit for the first page; not valid with recovery.'),
      recovery: z.boolean().optional().describe('Request semantic map/reduce recovery: closed_turn scope for an observed idle-and-closed turn, evidence_only scope for an idle runtime with open tool or message records. Defaults to false forensic output; non-direct-child targets and evidence-only snapshots are inspect-only.'),
    },
  },
  hive_task_trace_content: {
    description: 'Read one runtime-visible non-reasoning session trace source by exactly one selector. With event (a ref from the hive_task_trace v3 index), return that guarded event with its tool input, output, and error together; add field and offset to continue an oversized field in UTF-8-safe 8 KiB chunks. With content_id (a v2 content ID from recovery output), re-read that field in chunks. Every read reauthorizes and rechecks the source; a stale event or cursor means re-index.',
    args: {
      task_id: z.string().describe('OpenCode session ID visible through the connected runtime.'),
      event: z.string().optional().describe('Event ref from a hive_task_trace v3 index row or context entry. Not valid with content_id.'),
      field: z.enum(EVENT_FIELD_NAMES).optional().describe('Field of the selected event to read in chunks. Requires event.'),
      content_id: z.string().optional().describe('v2 content ID returned by recovery output. Not valid with event or field.'),
      offset: z.number().optional().describe('UTF-8 byte offset for content_id or event+field reads. Defaults to zero.'),
    },
  },
} as const;

export interface TraceInput {
  task_id: string;
  cursor?: string;
  recovery?: boolean;
}

export interface TraceContentInput {
  task_id: string;
  event?: string;
  field?: EventFieldName;
  content_id?: string;
  offset?: number;
}

function isUnavailable(value: object): value is Unavailable {
  return 'unavailable' in value;
}

/**
 * The two trace operations over one source and summarizer. Each returns the serialized reply text; byte budgets and
 * `render` sizes describe exactly that text, so hosts must pass it through unchanged.
 */
export function createTraceHandlers<Target extends TraceTarget>(source: TraceSource<Target>, summarizer: SummarizerHost) {
  const unavailableRecovery = (reason: string, stage = 'eligibility'): RecordValue => ({
    status: 'unavailable',
    scope: null,
    failures: [{ stage, reasons: [reason] }],
    model: { requested: requestedRecoveryModel(summarizer) },
    cards_source: null,
    phases_source: null,
  });
  const unavailable = (read: Unavailable) => JSON.stringify({ ok: false, reason: 'unavailable_or_unauthorized', ...read.unavailable });
  const reported = (taskID: string, target: Target): RecordValue => ({ id: taskID, relationship: target.relationship, ...target.report });

  // disclosedChildren already checks each distinct candidate once per read.
  const childAuthorizer = (parentID: string, signal?: AbortSignal) => (childID: string): Promise<boolean> => source.isDirectChild(childID, parentID, signal);

  async function trace({ task_id, cursor, recovery = false }: TraceInput, caller: TraceCaller): Promise<string> {
    const signal = caller.abort;
    if (signal?.aborted) throw cancellationReason(signal);
    let start: IndexCursor | undefined;
    if (cursor !== undefined) {
      if (recovery) return JSON.stringify({ ok: false, reason: 'invalid_selector' });
      start = decodeCursor(cursor);
      if (!start) return JSON.stringify({ ok: false, reason: 'invalid_cursor', hint: INVALID_CURSOR_HINT });
    }
    const target = await source.resolveTarget(task_id, caller.sessionID, signal);
    if (isUnavailable(target)) return unavailable(target);
    const snapshot = await source.readSource(task_id, target, signal);
    if (isUnavailable(snapshot)) return unavailable(snapshot);
    const status = await source.readRuntime(task_id, target, signal);
    const ir = normalizeTrace(snapshot);
    const lifecycle = deriveLifecycle(ir, status, target.placed);
    if (!recovery) {
      return renderIndexPage(task_id, reported(task_id, target), ir, lifecycle, indexEvents(snapshot), start, childAuthorizer(task_id, signal));
    }
    if (!signal) throw new Error('Trace recovery needs the caller cancellation signal.');
    const scope = recoveryScope(lifecycle);
    const ineligibleReason = target.relationship === 'self'
      ? 'self_recovery_not_allowed'
      : ir.steps.length === 0 ? 'empty_trace' : scope === undefined ? lifecycle.reason : undefined;
    if (ineligibleReason || scope === undefined) {
      return finalizeRecoveryProjection(recoveryProjection(
        task_id,
        reported(task_id, target),
        ir,
        lifecycle,
        unavailableRecovery(ineligibleReason ?? lifecycle.reason),
        null,
      ));
    }
    const recovered = await recover(summarizer, task_id, caller.sessionID, ir, target.relationship, scope, signal);
    // Everything the summary relied on must still hold: authorization, parent relationship,
    // placement, source, runtime status, and the lifecycle that admitted this scope.
    const resolved = await source.resolveTarget(task_id, caller.sessionID, signal);
    const refreshedTarget = isUnavailable(resolved) ? undefined : resolved;
    const read = refreshedTarget ? await source.readSource(task_id, refreshedTarget, signal) : undefined;
    const refreshedSnapshot = read === undefined || isUnavailable(read) ? undefined : read;
    const refreshedStatus = refreshedTarget ? await source.readRuntime(task_id, refreshedTarget, signal) : undefined;
    const refreshedIR = refreshedSnapshot ? normalizeTrace(refreshedSnapshot) : ir;
    const refreshedLifecycle = deriveLifecycle(refreshedIR, refreshedStatus, refreshedTarget?.placed ?? false);
    const staleReason = !refreshedTarget
      ? 'target_unavailable_after_recovery'
      : refreshedTarget.freshness !== target.freshness
        ? 'target_changed_after_recovery'
        : !refreshedSnapshot
          ? 'source_unavailable_after_recovery'
          : refreshedIR.digest !== ir.digest
            ? 'source_changed_after_recovery'
            : refreshedStatus === undefined
              ? 'status_unavailable_after_recovery'
              : refreshedLifecycle.state === 'active'
                ? 'runtime_active_after_recovery'
                : recoveryScope(refreshedLifecycle) !== scope || refreshedLifecycle.reason !== lifecycle.reason
                  ? 'lifecycle_changed_after_recovery'
                  : undefined;
    if (staleReason) {
      return finalizeRecoveryProjection(recoveryProjection(
        task_id,
        reported(task_id, refreshedTarget ?? target),
        refreshedIR,
        refreshedLifecycle,
        unavailableRecovery(staleReason, 'freshness'),
        null,
      ));
    }
    return finalizeRecoveryProjection(recoveryProjection(
      task_id,
      reported(task_id, target),
      refreshedIR,
      refreshedLifecycle,
      recovered.recovery,
      recovered.semantic,
    ));
  }

  async function content({ task_id, event, field, content_id, offset }: TraceContentInput, caller: TraceCaller): Promise<string> {
    const signal = caller.abort;
    const reply = (value: RecordValue) => JSON.stringify(value);
    if (
      (content_id === undefined) === (event === undefined)
      || (content_id !== undefined && field !== undefined)
      || (event !== undefined && field === undefined && offset !== undefined)
    ) return reply({ ok: false, reason: 'invalid_selector' });

    if (content_id !== undefined) {
      const locator = decodeLocator(content_id);
      if (!locator) return reply({ ok: false, reason: 'invalid_content_id' });
      const target = await source.resolveTarget(task_id, caller.sessionID, signal);
      if (isUnavailable(target)) return unavailable(target);
      try {
        const snapshot = await source.readSource(task_id, target, signal);
        if (isUnavailable(snapshot)) throw new Error('missing');
        const value = readLocatedValue(snapshot, locator);
        if (value === undefined) throw new Error('missing');
        const text = fieldText(value);
        const bytes = Buffer.from(text);
        if (bytes.length !== locator[4] || digest(text) !== locator[5]) throw new Error('stale');
        const chunk = utf8Chunk(bytes, offset ?? 0);
        if (!chunk) return reply({ ok: false, reason: 'invalid_offset' });
        return reply({
          ok: true,
          version: 2,
          task_id,
          content: chunk.content,
          offset: offset ?? 0,
          next_offset: chunk.nextOffset,
          bytes: bytes.length,
          sha256: locator[5],
        });
      } catch {
        if (signal?.aborted) throw cancellationReason(signal);
        return reply({ ok: false, reason: 'stale_or_not_found' });
      }
    }

    const selector = decodeEventRef(event);
    if (!selector) return reply({ ok: false, reason: 'invalid_event' });
    if (field !== undefined && !(EVENT_FIELD_NAMES as readonly string[]).includes(field)) return reply({ ok: false, reason: 'invalid_field' });
    const target = await source.resolveTarget(task_id, caller.sessionID, signal);
    if (isUnavailable(target)) return unavailable(target);
    const snapshot = await source.readSource(task_id, target, signal);
    if (isUnavailable(snapshot)) return unavailable(snapshot);
    const index = indexEvents(snapshot);
    const resolved = resolveEvent(index, selector);
    if ('reason' in resolved) return reply({ ok: false, reason: resolved.reason });
    const selected = resolved.event;
    if (field === undefined) {
      const detail = eventDetail(selected);
      await disclosedChildren([detail], childAuthorizer(task_id, signal));
      return reply({ ok: true, version: 3, task_id, source: { events: index.events.length, as_of: index.asOf }, event: detail });
    }
    if (!EVENT_FIELDS[selected.kind].includes(field)) return reply({ ok: false, reason: 'invalid_field' });
    if (!(field in selected.fields)) return reply({ ok: false, reason: 'field_absent' });
    const value = selected.fields[field];
    const text = fieldText(value);
    const bytes = Buffer.from(text);
    const chunk = utf8Chunk(bytes, offset ?? 0);
    if (!chunk) return reply({ ok: false, reason: 'invalid_offset' });
    return reply({
      ok: true,
      version: 3,
      task_id,
      field,
      format: typeof value === 'string' ? 'text' : 'json',
      content: chunk.content,
      offset: offset ?? 0,
      next_offset: chunk.nextOffset,
      bytes: bytes.length,
      sha256: digest(text),
    });
  }

  return { trace, content };
}
