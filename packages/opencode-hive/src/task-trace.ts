import { createHash } from 'node:crypto';
import { tool } from '@opencode-ai/plugin';
import type { TaskTraceSummarizerConfig } from 'hive-core';

export const TASK_TRACE_SUMMARIZER_AGENT = '__hive_task_trace_summarizer';

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
const MAX_SUMMARIZER_RESPONSE_PARTS = 8;
const MAX_SUMMARIZER_RESPONSE_BYTES = 128 * 1024;
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
type TargetRelationship = 'self' | 'direct_child' | 'other_session';
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

interface TaskTraceClient {
  config: {
    providers(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
  };
  session: {
    get(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
    messages(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
    status?: (input: unknown) => Promise<{ data?: unknown; error?: unknown }>;
    create(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
    prompt(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
    abort(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
    delete(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
  };
}

interface ResolvedTargetSession {
  relationship: TargetRelationship;
}

export interface TaskTraceOptions {
  client: TaskTraceClient;
  directory: string;
  summarizer: TaskTraceSummarizerConfig;
  ephemeralSessionIDs: Set<string>;
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

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = record(value);
  if (object) return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function fieldText(value: unknown): string {
  return typeof value === 'string' ? value : stableJson(value);
}

function sourceValue(message: number, part: number, field: ContentField, value: unknown): SourceValue {
  const text = fieldText(value);
  return { message, part, field, value, bytes: Buffer.byteLength(text), digest: digest(text) };
}

function tokenCount(part: RecordValue): number | undefined {
  if (typeof part.tokens === 'number' && Number.isFinite(part.tokens) && part.tokens >= 0) return part.tokens;
  const tokens = record(part.tokens);
  if (!tokens) return undefined;
  const values = Object.values(tokens).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
}

function normalizeTrace(messages: unknown[]): TraceIR {
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

  messages.forEach((rawMessage, messageIndex) => {
    const message = record(rawMessage) ?? {};
    const info = record(message.info) ?? {};
    const parts = Array.isArray(message.parts) ? message.parts.map((part) => record(part) ?? {}) : [];
    const actor: Actor = info.role === 'user' ? 'user' : 'assistant';
    const closed = record(info.time)?.completed !== undefined || info.error !== undefined;
    const summary = info.summary === true || parts.some((part) => part.type === 'summary' || part.type === 'compaction');
    latestMessage = { index: messageIndex, role: typeof info.role === 'string' ? info.role : undefined, closed, summary };
    partCount += parts.length;
    if (info.summary === true) compactionCount += 1;
    let current: IRStep | undefined;

    if (info.error !== undefined && actor === 'assistant') {
      current = openStep(actor, false, messageIndex);
      current.meaningful += 1;
      current.errors.push({ kind: 'assistant', source: sourceValue(messageIndex, -1, 'assistant.error', info.error) });
    }

    parts.forEach((part, partIndex) => {
      const type = typeof part.type === 'string' ? part.type : 'unknown';
      if (type === 'step-start') {
        if (current) current.state = current.explicit ? 'malformed' : 'closed';
        current = openStep(actor, true, messageIndex);
        return;
      }
      if (!current) current = openStep(actor, false, messageIndex);

      if (type === 'step-finish') {
        current.state = !current.explicit && current.meaningful === 0 ? 'malformed' : 'closed';
        current = undefined;
        return;
      }
      if (type === 'text' && typeof part.text === 'string') {
        current.meaningful += 1;
        current.texts.push({ source: sourceValue(messageIndex, partIndex, 'text', part.text), messageClosed: closed });
        return;
      }
      if (type === 'reasoning') {
        current.meaningful += 1;
        const tokens = tokenCount(part);
        current.reasoning.push({
          ...(typeof part.text === 'string' ? { plaintext: part.text } : {}),
          ...(tokens === undefined ? {} : { tokens }),
          opaque: typeof part.text !== 'string',
        });
        return;
      }
      if (type === 'tool') {
        current.meaningful += 1;
        const state = record(part.state) ?? {};
        const tool: IRTool = {
          name: typeof part.tool === 'string' ? part.tool : typeof part.name === 'string' ? part.name : 'unknown',
          status: typeof state.status === 'string' ? state.status : 'unknown',
          ...(state.input === undefined ? {} : { input: sourceValue(messageIndex, partIndex, 'tool.input', state.input) }),
          ...(state.output === undefined ? {} : { output: sourceValue(messageIndex, partIndex, 'tool.output', state.output) }),
          ...(state.error === undefined ? {} : { error: sourceValue(messageIndex, partIndex, 'tool.error', state.error) }),
        };
        current.tools.push(tool);
        if (tool.error) current.errors.push({ kind: 'tool', source: tool.error });
        return;
      }
      if (type === 'retry') {
        current.meaningful += 1;
        current.retries += 1;
        if (part.error !== undefined) current.errors.push({ kind: 'retry', source: sourceValue(messageIndex, partIndex, 'retry.error', part.error) });
        return;
      }
      if (type === 'patch') {
        current.meaningful += 1;
        current.patches += 1;
        if (Array.isArray(part.files)) {
          current.files.push(...part.files.filter((file): file is string => typeof file === 'string'));
        }
        return;
      }
      if (type === 'compaction' || type === 'summary') {
        current.meaningful += 1;
        compactionCount += 1;
        return;
      }
      current.meaningful += 1;
      current.unknownParts += 1;
    });

    if (current) current.state = !current.explicit && closed ? 'closed' : 'open';
  });

  return {
    steps,
    messageCount: messages.length,
    partCount,
    compactionCount,
    digest: digest(stableJson(messages)),
    latestMessage,
  };
}

function nativeID(value: unknown): string | undefined {
  return typeof value === 'string' && NATIVE_ID_PATTERN.test(value) ? value : undefined;
}

function withoutUndefined(value: RecordValue): RecordValue {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

// Builds the chronological index of non-reasoning events. Reasoning parts are counted only;
// their text, metadata, and IDs never enter an event, guard, chain, ref, or cursor. Refs and
// cursors carry native IDs or eligible-event seq, never raw part positions that count reasoning.
function indexEvents(messages: unknown[]): EventIndex {
  type Draft = Omit<TraceEvent, 'seq' | 'identity' | 'guard' | 'chain'>;
  const drafts: Draft[] = [];
  let reasoningParts = 0;
  let structuralParts = 0;

  messages.forEach((rawMessage, messageIndex) => {
    const message = record(rawMessage) ?? {};
    const info = record(message.info) ?? {};
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const actor: TraceEvent['actor'] = info.role === 'user' || info.role === 'assistant' ? info.role : 'unknown';
    const base = {
      actor,
      messageIndex,
      messageID: nativeID(info.id),
      ...(info.summary === true ? { summary: true as const } : {}),
    };

    parts.forEach((rawPart, partIndex) => {
      const part = record(rawPart) ?? {};
      const type = typeof part.type === 'string' ? part.type : undefined;
      if (type === 'step-start' || type === 'step-finish') {
        structuralParts += 1;
        return;
      }
      if (type === 'reasoning') {
        reasoningParts += 1;
        return;
      }
      const at = { ...base, partIndex, partID: nativeID(part.id) };
      if (type === 'text' && typeof part.text === 'string') {
        drafts.push({ ...at, kind: 'text', fields: { text: part.text }, ...(part.synthetic === true ? { synthetic: true as const } : {}) });
      } else if (type === 'tool') {
        const state = record(part.state) ?? {};
        const fields: TraceEvent['fields'] = {};
        for (const field of EVENT_FIELDS.tool) if (state[field] !== undefined) fields[field] = state[field];
        drafts.push({
          ...at,
          kind: 'tool',
          tool: typeof part.tool === 'string' ? part.tool : typeof part.name === 'string' ? part.name : 'unknown',
          status: typeof state.status === 'string' ? state.status : 'unknown',
          callID: typeof part.callID === 'string' ? part.callID : undefined,
          title: typeof state.title === 'string' ? state.title : undefined,
          ...(typeof record(state.time)?.compacted === 'number' ? { compacted: true as const } : {}),
          fields,
        });
      } else if (type === 'retry') {
        drafts.push({ ...at, kind: 'retry', fields: part.error === undefined ? {} : { error: part.error } });
      } else if (type === 'patch') {
        drafts.push({ ...at, kind: 'patch', fields: Array.isArray(part.files) ? { files: part.files } : {} });
      } else if (type === 'compaction' || type === 'summary') {
        drafts.push({ ...at, kind: 'compaction', fields: {} });
      } else {
        drafts.push({ ...at, kind: 'unsupported', type: type ?? 'unknown', fields: {} });
      }
    });

    if (info.error !== undefined && actor === 'assistant') {
      drafts.push({ ...base, partIndex: -1, kind: 'assistant_error', fields: { error: info.error } });
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

function cursorToken(index: EventIndex, seq: number): string {
  return index.events.slice(0, seq).every((event) => event.identity === 'native')
    ? encodeToken([3, 'c', seq, index.events[seq - 1].chain])
    : encodeToken([3, 's', seq, index.asOf]);
}

function decodeCursor(value: unknown): IndexCursor | undefined {
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

// Fills one page in source order under the byte budget and always includes at least one event.
function renderIndexPage(
  taskID: string,
  relationship: TargetRelationship,
  ir: TraceIR,
  lifecycle: RecordValue,
  index: EventIndex,
  start: IndexCursor | undefined,
): string {
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
    target: { id: taskID, relationship },
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

async function resolveTargetSession(
  client: TaskTraceClient,
  directory: string,
  taskID: string,
  callerID: string,
  signal?: AbortSignal,
): Promise<ResolvedTargetSession | undefined> {
  try {
    const response = await client.session.get({ path: { id: taskID }, query: { directory }, ...(signal ? { signal } : {}) });
    const target = response.error === undefined ? record(response.data) : undefined;
    if (target?.id !== taskID || (target.parentID !== undefined && typeof target.parentID !== 'string')) return undefined;
    return {
      relationship: taskID === callerID
        ? 'self'
        : target.parentID === callerID ? 'direct_child' : 'other_session',
    };
  } catch {
    if (signal?.aborted) throw cancellationReason(signal);
    return undefined;
  }
}

function isSessionStatusValue(value: unknown): boolean {
  const entry = record(value);
  if (!entry || typeof entry.type !== 'string') return false;
  if (entry.type === 'idle' || entry.type === 'busy') return Object.keys(entry).length === 1;
  if (entry.type !== 'retry') return false;
  return typeof entry.attempt === 'number'
    && Number.isFinite(entry.attempt)
    && typeof entry.message === 'string'
    && typeof entry.next === 'number'
    && Number.isFinite(entry.next);
}

function parseSessionStatusMap(value: unknown): RecordValue | undefined {
  const map = record(value);
  return map && Object.values(map).every(isSessionStatusValue) ? map : undefined;
}

function deriveLifecycle(ir: TraceIR, status: RecordValue | undefined, taskID: string): RecordValue {
  if (status === undefined) return { state: 'uncertain', terminal: false, reason: 'status_unavailable' };
  const runtime = record(status[taskID]);
  if (runtime?.type === 'busy' || runtime?.type === 'retry') return { state: 'active', terminal: false, reason: 'runtime_active' };
  if (ir.steps.some((step) => step.tools.some((entry) => entry.status === 'pending' || entry.status === 'running'))) {
    return { state: 'uncertain', terminal: false, reason: 'tool_pending_or_running' };
  }
  if (!ir.latestMessage || ir.latestMessage.role !== 'assistant') return { state: 'uncertain', terminal: false, reason: 'latest_message_not_assistant' };
  if (ir.latestMessage.summary) return { state: 'uncertain', terminal: false, reason: 'latest_message_summary_or_compaction' };
  if (!ir.latestMessage.closed) return { state: 'uncertain', terminal: false, reason: 'latest_assistant_open' };
  return { state: 'terminal', terminal: true, reason: 'idle_and_closed' };
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

function buildMapRequest(fragments: RecordValue[], targetChars: number): {
  request: RecordValue;
  range: number[];
  steps: number[];
} {
  const steps = [...new Set(fragments.map((fragment) => Number(fragment.step)))];
  const range = [steps[0], steps[steps.length - 1]];
  return { request: { kind: 'map', range, target_chars: targetChars, fragments }, range, steps };
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
    const oversized = numbered.findIndex((fragment) => (
      Buffer.byteLength(stableJson(buildMapRequest([fragment], targetChars).request), 'utf8') > mapBatchBytes
    ));
    if (oversized < 0) break;
    splitFragments.splice(oversized, 1, ...splitRecoveryFragment(splitFragments[oversized]));
  }

  const fragments = numberRecoveryFragments(splitFragments);
  const batches: RecordValue[][] = [];
  let batch: RecordValue[] = [];
  for (const fragment of fragments) {
    const candidate = [...batch, fragment];
    if (
      batch.length > 0
      && Buffer.byteLength(stableJson(buildMapRequest(candidate, targetChars).request), 'utf8') > mapBatchBytes
    ) {
      batches.push(batch);
      batch = [fragment];
    } else {
      batch = candidate;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function responseText(response: { data?: unknown }): string | undefined {
  const data = record(response.data);
  if (!data || !Array.isArray(data.parts)) return undefined;
  const textParts: string[] = [];
  let bytes = 0;
  for (const rawPart of data.parts) {
    const part = record(rawPart);
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    if (textParts.length >= MAX_SUMMARIZER_RESPONSE_PARTS) return undefined;
    const nextBytes = Buffer.byteLength(part.text);
    if (bytes + nextBytes > MAX_SUMMARIZER_RESPONSE_BYTES) return undefined;
    bytes += nextBytes;
    textParts.push(part.text);
  }
  return textParts.length > 0 ? textParts.join('') : undefined;
}

function modelRef(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const separator = model.indexOf('/');
  return separator > 0 && separator < model.length - 1
    ? { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
    : undefined;
}

function mapBatchBytesFromProviders(response: { data?: unknown; error?: unknown }, model: string | undefined): number {
  const ref = modelRef(model);
  const data = record(response.data);
  if (response.error !== undefined || !ref || !data || !Array.isArray(data.providers)) return FALLBACK_MAP_BATCH_BYTES;
  const provider = data.providers.map(record).find((entry) => entry?.id === ref.providerID);
  const models = record(provider?.models);
  const selected = record(models?.[ref.modelID]);
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

function cancellationReason(signal: AbortSignal): unknown {
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

async function resolveMapBatchBytes(
  options: TaskTraceOptions,
  callerSignal: AbortSignal,
  deadline: number,
): Promise<number> {
  if (!modelRef(options.summarizer.model)) return FALLBACK_MAP_BATCH_BYTES;
  try {
    const response = await boundedRequest(
      (signal) => options.client.config.providers({ query: { directory: options.directory }, signal }),
      callerSignal,
      deadline,
      'recovery_deadline_exceeded',
    );
    return mapBatchBytesFromProviders(response, options.summarizer.model);
  } catch {
    if (callerSignal.aborted) throw cancellationReason(callerSignal);
    return FALLBACK_MAP_BATCH_BYTES;
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

async function promptEphemeral(
  options: TaskTraceOptions,
  forbiddenSessionID: string,
  title: string,
  request: RecordValue,
  callerSignal: AbortSignal,
  deadline: number,
): Promise<{
  response?: { data?: unknown; error?: unknown };
  reasons: RecoveryFailureReason[];
}> {
  let sessionID: string | undefined;
  let response: { data?: unknown; error?: unknown } | undefined;
  const reasons: RecoveryFailureReason[] = [];
  let cleanupFailed = false;
  let generationInterrupted = false;
  const attemptStarted = Date.now();
  const cleanupReserveMs = 2 * CLEANUP_ATTEMPT_MS;
  if (attemptStarted + cleanupReserveMs >= deadline) {
    if (callerSignal.aborted) throw cancellationReason(callerSignal);
    return { reasons: ['recovery_deadline_exceeded'] };
  }
  const generationCap = attemptStarted + SUMMARIZER_ATTEMPT_MS;
  const generationDeadline = Math.min(deadline - cleanupReserveMs, generationCap);
  const abortDeadline = deadline - CLEANUP_ATTEMPT_MS;
  const attemptTimeoutReason = deadline - cleanupReserveMs <= generationCap
    ? 'recovery_deadline_exceeded' as const
    : 'summarizer_timeout' as const;
  try {
    const created = await boundedRequest(
      (signal) => options.client.session.create({ body: { title }, query: { directory: options.directory }, signal }),
      callerSignal,
      generationDeadline,
      attemptTimeoutReason,
    );
    const session = record(created.data);
    if (!session || typeof session.id !== 'string') throw new Error('create failed');
    if (session.id === forbiddenSessionID) return { reasons: ['summarizer_id_collision'] };
    sessionID = session.id;
    options.ephemeralSessionIDs.add(sessionID);
    const body: RecordValue = {
      agent: TASK_TRACE_SUMMARIZER_AGENT,
      parts: [{ type: 'text', text: stableJson(request) }],
    };
    const model = modelRef(options.summarizer.model);
    if (model) body.model = model;
    try {
      response = await boundedRequest(
        (signal) => options.client.session.prompt({ path: { id: sessionID }, query: { directory: options.directory }, body, signal }),
        callerSignal,
        generationDeadline,
        attemptTimeoutReason,
      );
    } catch (error) {
      generationInterrupted = error instanceof RecoveryTimeoutError || callerSignal.aborted;
      throw error;
    }
    if (response.error !== undefined) reasons.push('summarizer_unavailable');
  } catch (error) {
    if (!callerSignal.aborted) {
      if (error instanceof RecoveryTimeoutError) reasons.push(error.reason);
      else reasons.push('summarizer_unavailable');
    }
  } finally {
    if (sessionID) {
      if (generationInterrupted) {
        try {
          const aborted = await boundedCleanup(
            (signal) => options.client.session.abort({
              path: { id: sessionID }, query: { directory: options.directory }, signal,
            }),
            abortDeadline,
          );
          if (aborted.error !== undefined) cleanupFailed = true;
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        const deleted = await boundedCleanup(
          (signal) => options.client.session.delete({
            path: { id: sessionID }, query: { directory: options.directory }, signal,
          }),
          deadline,
        );
        if (deleted.error === undefined && deleted.data === true) {
          options.ephemeralSessionIDs.delete(sessionID);
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
  return { response, reasons };
}

function parseJsonRecord(text: string | undefined): RecordValue | undefined {
  if (!text) return undefined;
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function hasExactKeys(value: RecordValue, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) return undefined;
  return value as string[];
}

function semanticText(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0);
}

function validateMapOutput(
  value: RecordValue | undefined,
  range: number[],
  steps: number[],
  capabilities: Map<number, RecoveryCapabilities>,
): MapValidation | undefined {
  if (!value || !hasExactKeys(value, ['kind', 'range', 'cards'])) return undefined;
  if (value.kind !== 'map' || stableJson(value.range) !== stableJson(range) || !Array.isArray(value.cards)) return undefined;
  if (value.cards.length !== steps.length) return undefined;
  const cards: RecoveryCard[] = [];
  const invalidSteps: number[] = [];
  for (const [index, raw] of value.cards.entries()) {
    const card = record(raw);
    const step = steps[index];
    if (!card || !hasExactKeys(card, ['step', 'intent', 'actions', 'findings', 'outcome', 'unresolved', 'basis']) || card.step !== step) {
      invalidSteps.push(step);
      continue;
    }
    const actions = stringList(card.actions);
    const findings = stringList(card.findings);
    const unresolved = stringList(card.unresolved);
    if (
      !semanticText(card.intent)
      || !semanticText(card.outcome)
      || actions === undefined
      || findings === undefined
      || unresolved === undefined
      || !['observed', 'reasoning', 'mixed'].includes(String(card.basis))
    ) {
      invalidSteps.push(step);
      continue;
    }
    const stepCapabilities = capabilities.get(step)!;
    const basisSupported = card.basis === 'observed'
      ? stepCapabilities.hasVisibleObservedEvidence
      : card.basis === 'reasoning'
        ? stepCapabilities.hasPlaintextReasoning
        : stepCapabilities.hasVisibleObservedEvidence && stepCapabilities.hasPlaintextReasoning;
    const hasSemanticContent = card.intent !== null
      || actions.length > 0
      || findings.length > 0
      || card.outcome !== null
      || unresolved.length > 0;
    if (!basisSupported || !hasSemanticContent) {
      invalidSteps.push(step);
      continue;
    }
    cards.push({
      step,
      intent: card.intent,
      actions,
      findings,
      outcome: card.outcome,
      unresolved,
      basis: card.basis as RecoveryBasis,
    });
  }
  return { cards, invalidSteps };
}

function validateSourceSteps(value: unknown, minimum: number, maximum: number): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  let previous = minimum - 1;
  const steps: number[] = [];
  for (const entry of value) {
    if (!Number.isSafeInteger(entry) || entry < minimum || entry > maximum || entry <= previous) return undefined;
    previous = entry;
    steps.push(entry);
  }
  return steps;
}

function validateClaims(value: unknown, stepCount: number): RecordValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const claims: RecordValue[] = [];
  for (const raw of value) {
    const claim = record(raw);
    if (!claim || !hasExactKeys(claim, ['claim', 'source_steps'])) return undefined;
    const sourceSteps = validateSourceSteps(claim.source_steps, 1, stepCount);
    if (typeof claim.claim !== 'string' || claim.claim.trim().length === 0 || sourceSteps === undefined) return undefined;
    claims.push({ claim: claim.claim, source_steps: sourceSteps });
  }
  return claims;
}

function validateReduction(value: RecordValue | undefined, stepCount: number): {
  semantic?: RecordValue;
  reason?: 'invalid_reducer_output' | 'invalid_phase_coverage';
} {
  if (!value || !hasExactKeys(value, ['kind', 'semantic']) || value.kind !== 'reduce') {
    return { reason: 'invalid_reducer_output' };
  }
  const semantic = record(value.semantic);
  if (!semantic || !hasExactKeys(semantic, ['overview', 'phases', 'completed', 'unfinished', 'safest_next_action'])) {
    return { reason: 'invalid_reducer_output' };
  }
  if (typeof semantic.overview !== 'string' || semantic.overview.trim().length === 0 || !Array.isArray(semantic.phases)) {
    return { reason: 'invalid_reducer_output' };
  }
  const minimumPhases = stepCount > 12 ? 6 : 1;
  if (semantic.phases.length < minimumPhases || semantic.phases.length > 12) return { reason: 'invalid_phase_coverage' };

  const phases: RecordValue[] = [];
  let expectedStart = 1;
  for (const raw of semantic.phases) {
    const phase = record(raw);
    if (!phase || !hasExactKeys(phase, ['range', 'title', 'intent', 'actions', 'findings', 'outcome', 'unresolved', 'source_steps'])) {
      return { reason: 'invalid_reducer_output' };
    }
    const actions = stringList(phase.actions);
    const findings = stringList(phase.findings);
    const unresolved = stringList(phase.unresolved);
    if (
      typeof phase.title !== 'string'
      || phase.title.trim().length === 0
      || !semanticText(phase.intent)
      || !semanticText(phase.outcome)
      || actions === undefined
      || findings === undefined
      || unresolved === undefined
    ) return { reason: 'invalid_reducer_output' };
    if (!Array.isArray(phase.range) || phase.range.length !== 2) return { reason: 'invalid_phase_coverage' };
    const [start, end] = phase.range;
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start !== expectedStart
      || end < start
      || end > stepCount
    ) return { reason: 'invalid_phase_coverage' };
    const sourceSteps = validateSourceSteps(phase.source_steps, start, end);
    if (sourceSteps === undefined) return { reason: 'invalid_phase_coverage' };
    phases.push({
      range: [start, end],
      title: phase.title,
      intent: phase.intent,
      actions,
      findings,
      outcome: phase.outcome,
      unresolved,
      source_steps: sourceSteps,
    });
    expectedStart = end + 1;
  }
  if (expectedStart !== stepCount + 1) return { reason: 'invalid_phase_coverage' };

  const completed = validateClaims(semantic.completed, stepCount);
  const unfinished = validateClaims(semantic.unfinished, stepCount);
  const action = record(semantic.safest_next_action);
  if (completed === undefined || unfinished === undefined || !action || !hasExactKeys(action, ['action', 'context', 'source_steps'])) {
    return { reason: 'invalid_reducer_output' };
  }
  if (action.context !== null && (typeof action.context !== 'string' || action.context.trim().length === 0)) {
    return { reason: 'invalid_reducer_output' };
  }
  const actionSteps = validateSourceSteps(action.source_steps, 1, stepCount);
  if (actionSteps === undefined) return { reason: 'invalid_reducer_output' };
  if (unfinished.length > 0 && (action.action !== 'launch_fresh_task' || typeof action.context !== 'string')) {
    return { reason: 'invalid_reducer_output' };
  }
  if (unfinished.length === 0 && (action.action !== 'review_completed_work' || action.context !== null)) {
    return { reason: 'invalid_reducer_output' };
  }
  return {
    semantic: {
      overview: semantic.overview,
      phases,
      completed,
      unfinished,
      safest_next_action: { action: action.action, context: action.context, source_steps: actionSteps },
    },
  };
}

function observedModel(response: { data?: unknown } | undefined): RecordValue | undefined {
  const data = record(response?.data);
  const model = record(data?.model);
  const provider = typeof model?.providerID === 'string' ? model.providerID : undefined;
  const id = typeof model?.modelID === 'string' ? model.modelID : undefined;
  const variant = typeof data?.variant === 'string' ? data.variant : undefined;
  if (!provider && !id && !variant) return undefined;
  return {
    ...(provider && id ? { model: `${provider}/${id}` } : {}),
    ...(variant ? { variant } : {}),
  };
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

function fallbackReduction(cards: RuntimeRecoveryCard[]): RecordValue {
  const phases = balancedPhaseRanges(cards.length).map(([start, end], index) => {
    const covered = cards.slice(start - 1, end);
    const intents = uniqueStrings(covered.flatMap((card) => card.intent === null ? [] : [card.intent]));
    const outcomes = uniqueStrings(covered.flatMap((card) => card.outcome === null ? [] : [card.outcome]));
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
    completed: cards.flatMap((card) => card.outcome === null ? [] : [{ claim: card.outcome, source_steps: [card.step] }]),
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

function requestedRecoveryModel(options: TaskTraceOptions): RecordValue {
  return {
    ...(options.summarizer.model ? { model: options.summarizer.model } : {}),
    ...(options.summarizer.variant ? { variant: options.summarizer.variant } : {}),
  };
}

async function recover(
  options: TaskTraceOptions,
  taskID: string,
  ir: TraceIR,
  relationship: TargetRelationship,
  callerSignal: AbortSignal,
): Promise<{ recovery: RecordValue; semantic: RecordValue | null }> {
  if (callerSignal.aborted) throw cancellationReason(callerSignal);
  const recoveryDeadline = Date.now() + SEMANTIC_RECOVERY_MS;
  const mapDeadline = recoveryDeadline - REDUCTION_RESERVE_MS;
  const targetChars = Math.max(80, Math.min(280, Math.round(14_000 / ir.steps.length)));
  const capabilities = new Map(ir.steps.map((step) => [step.number, recoveryCapabilities(step)]));
  const mapBatchBytes = await resolveMapBatchBytes(options, callerSignal, mapDeadline);
  const batches = batchFragments(recoveryFragments(ir.steps, capabilities), targetChars, mapBatchBytes);
  const generatedCards = new Map<number, Array<{ order: number; card: RecoveryCard }>>();
  const failedSteps = new Set<number>();
  const failures: RecordValue[] = [];
  let observed: RecordValue | undefined;
  const outcomes: Array<{
    range: number[];
    steps: number[];
    prompted: Awaited<ReturnType<typeof promptEphemeral>>;
  } | undefined> = new Array(batches.length);
  let nextBatch = 0;
  const workers = Array.from({ length: Math.min(MAX_MAP_CONCURRENCY, batches.length) }, async () => {
    while (nextBatch < batches.length) {
      const index = nextBatch;
      nextBatch += 1;
      if (callerSignal.aborted) throw cancellationReason(callerSignal);
      if (Date.now() >= mapDeadline) return;
      const { request, range, steps } = buildMapRequest(batches[index], targetChars);
      const prompted = await promptEphemeral(options, taskID, `Hive task trace map ${index + 1}`, request, callerSignal, mapDeadline);
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
        failures: [{ stage: 'map', range: collision.range, reasons: ['summarizer_id_collision'] }],
        model: { requested: requestedRecoveryModel(options) },
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
    observed = observedModel(prompted.response) ?? observed;
    const providerFailed = prompted.reasons.some((reason) => (
      reason === 'summarizer_unavailable'
      || reason === 'summarizer_timeout'
      || reason === 'recovery_deadline_exceeded'
    ));
    const cleanupFailed = prompted.reasons.includes('ephemeral_cleanup_failed');
    const validation = providerFailed
      ? undefined
      : validateMapOutput(parseJsonRecord(responseText(prompted.response)), range, steps, capabilities);
    const invalidMap = !providerFailed && (!validation || validation.invalidSteps.length > 0);
    const reasons: RecoveryFailureReason[] = [
      ...(providerFailed ? prompted.reasons.filter((reason) => reason !== 'ephemeral_cleanup_failed') : invalidMap ? ['invalid_map_output' as const] : []),
      ...(cleanupFailed ? ['ephemeral_cleanup_failed' as const] : []),
    ];
    if (reasons.length > 0) failures.push({ stage: 'map', range, reasons });
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
    const request = { kind: 'reduce', step_count: ir.steps.length, cards, anchors: recoveryAnchors(ir) };
    const prompted = await promptEphemeral(options, taskID, 'Hive task trace semantic reduction', request, callerSignal, recoveryDeadline);
    if (prompted.reasons.includes('summarizer_id_collision')) {
      return {
        recovery: {
          status: 'unavailable',
          failures: [{ stage: 'reduce', reasons: ['summarizer_id_collision'] }],
          model: {
            requested: requestedRecoveryModel(options),
            ...(observed ? { observed } : {}),
          },
          cards_source: null,
          phases_source: null,
        },
        semantic: null,
      };
    }
    observed = observedModel(prompted.response) ?? observed;
    const providerFailed = prompted.reasons.some((reason) => (
      reason === 'summarizer_unavailable'
      || reason === 'summarizer_timeout'
      || reason === 'recovery_deadline_exceeded'
    ));
    const cleanupFailed = prompted.reasons.includes('ephemeral_cleanup_failed');
    const validated = providerFailed
      ? { reason: undefined }
      : validateReduction(parseJsonRecord(responseText(prompted.response)), ir.steps.length);
    const reasons: RecoveryFailureReason[] = [
      ...(providerFailed ? prompted.reasons.filter((reason) => reason !== 'ephemeral_cleanup_failed') : validated.semantic ? [] : [validated.reason ?? 'invalid_reducer_output']),
      ...(cleanupFailed ? ['ephemeral_cleanup_failed' as const] : []),
    ];
    if (reasons.length > 0) {
      failures.push({ stage: 'reduce', reasons });
    } else {
      semantic = validated.semantic!;
      phasesSource = 'generated';
    }
  }
  semantic ??= fallbackReduction(cards);

  const status = failures.length === 0 ? 'complete' : 'partial';
  const forceInspect = status === 'partial'
    || cardsSource !== 'generated'
    || phasesSource !== 'generated'
    || ir.compactionCount > 0
    || ir.steps.some((step) => step.errors.length > 0)
    || relationship !== 'direct_child';
  return {
    recovery: {
      status,
      failures,
      model: {
        requested: requestedRecoveryModel(options),
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
  relationship: TargetRelationship,
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
    target: { id: taskID, relationship },
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

function readLocatedValue(messages: unknown[], locator: ContentLocator): unknown {
  const [, messageIndex, partIndex, fieldIndex] = locator;
  const message = record(messages[messageIndex]);
  const info = record(message?.info);
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const part = partIndex >= 0 ? record(parts[partIndex]) : undefined;
  const field = CONTENT_FIELDS[fieldIndex - 1];
  if (field === 'assistant.error' && partIndex === -1 && info?.role === 'assistant') return info.error;
  if (!part) return undefined;
  if (field === 'text' && part.type === 'text') return part.text;
  if (field === 'retry.error' && part.type === 'retry') return part.error;
  if (part.type !== 'tool') return undefined;
  const state = record(part.state) ?? {};
  if (field === 'tool.input') return state.input;
  if (field === 'tool.output') return state.output;
  if (field === 'tool.error') return state.error;
  return undefined;
}

export function createTaskTraceTools(options: TaskTraceOptions) {
  const unavailableRecovery = (reason: string, stage = 'eligibility'): RecordValue => ({
    status: 'unavailable',
    failures: [{ stage, reasons: [reason] }],
    model: { requested: requestedRecoveryModel(options) },
    cards_source: null,
    phases_source: null,
  });

  const readStatus = async (signal?: AbortSignal): Promise<RecordValue | undefined> => {
    if (typeof options.client.session.status !== 'function') return undefined;
    try {
      const response = await options.client.session.status({
        query: { directory: options.directory },
        ...(signal ? { signal } : {}),
      });
      return response.error === undefined ? parseSessionStatusMap(response.data) : undefined;
    } catch {
      if (signal?.aborted) throw cancellationReason(signal);
      return undefined;
    }
  };

  return {
    hive_task_trace: tool({
      description: 'Inspect any explicitly identified OpenCode session visible to the connected runtime when its result failed, blocked, timed out, was cancelled, is empty, or is unclear. Returns a read-only paged forensic v3 index of surviving non-reasoning events in source order, with lifecycle, assignment and final self-report context, bounded excerpts, event refs, and coverage; follow coverage.next_cursor with cursor for the next page. Optional recovery observes a finished turn and returns an untrusted semantic projection with runtime-safe next actions.',
      args: {
        task_id: tool.schema.string().describe('OpenCode session ID visible through the connected runtime.'),
        cursor: tool.schema.string().optional().describe('coverage.next_cursor from the previous index page. Omit for the first page; not valid with recovery.'),
        recovery: tool.schema.boolean().optional().describe('Request semantic map/reduce recovery for an observed idle-and-closed turn. Defaults to false forensic output; non-direct-child targets are inspect-only.'),
      },
      async execute({ task_id, cursor, recovery = false }, context) {
        if (recovery && context.abort.aborted) throw cancellationReason(context.abort);
        let start: IndexCursor | undefined;
        if (cursor !== undefined) {
          if (recovery) return JSON.stringify({ ok: false, reason: 'invalid_selector' });
          start = decodeCursor(cursor);
          if (!start) return JSON.stringify({ ok: false, reason: 'invalid_cursor' });
        }
        const unavailable = JSON.stringify({ ok: false, reason: 'unavailable_or_unauthorized' });
        const target = await resolveTargetSession(
          options.client,
          options.directory,
          task_id,
          context.sessionID,
          recovery ? context.abort : undefined,
        );
        if (!target) return unavailable;
        let messages: unknown[];
        try {
          const response = await options.client.session.messages({
            path: { id: task_id },
            query: { directory: options.directory },
            ...(recovery ? { signal: context.abort } : {}),
          });
          if (response.error !== undefined || !Array.isArray(response.data)) return unavailable;
          messages = response.data;
        } catch {
          if (recovery && context.abort.aborted) throw cancellationReason(context.abort);
          return unavailable;
        }
        const status = await readStatus(recovery ? context.abort : undefined);
        const ir = normalizeTrace(messages);
        const lifecycle = deriveLifecycle(ir, status, task_id);
        if (recovery) {
          const ineligibleReason = target.relationship === 'self'
            ? 'self_recovery_not_allowed'
            : ir.steps.length === 0 ? 'empty_trace' : lifecycle.terminal !== true ? String(lifecycle.reason) : undefined;
          if (ineligibleReason) {
            return finalizeRecoveryProjection(recoveryProjection(
              task_id,
              target.relationship,
              ir,
              lifecycle,
              unavailableRecovery(ineligibleReason),
              null,
            ));
          }
          const recovered = await recover(options, task_id, ir, target.relationship, context.abort);
          let refreshedMessages: unknown[] | undefined;
          try {
            const response = await options.client.session.messages({
              path: { id: task_id },
              query: { directory: options.directory },
              signal: context.abort,
            });
            if (response.error === undefined && Array.isArray(response.data)) refreshedMessages = response.data;
          } catch {
            if (context.abort.aborted) throw cancellationReason(context.abort);
          }
          const refreshedStatus = await readStatus(context.abort);
          const refreshedIR = refreshedMessages ? normalizeTrace(refreshedMessages) : ir;
          const refreshedLifecycle = deriveLifecycle(refreshedIR, refreshedStatus, task_id);
          const staleReason = !refreshedMessages
            ? 'source_unavailable_after_recovery'
            : refreshedIR.digest !== ir.digest
              ? 'source_changed_after_recovery'
              : refreshedStatus === undefined
                ? 'status_unavailable_after_recovery'
                : refreshedLifecycle.state === 'active'
                  ? 'runtime_active_after_recovery'
                  : refreshedLifecycle.terminal !== true ? 'lifecycle_changed_after_recovery' : undefined;
          if (staleReason) {
            return finalizeRecoveryProjection(recoveryProjection(
              task_id,
              target.relationship,
              refreshedIR,
              refreshedLifecycle,
              unavailableRecovery(staleReason, 'freshness'),
              null,
            ));
          }
          return finalizeRecoveryProjection(recoveryProjection(
            task_id,
            target.relationship,
            refreshedIR,
            refreshedLifecycle,
            recovered.recovery,
            recovered.semantic,
          ));
        }
        return renderIndexPage(task_id, target.relationship, ir, lifecycle, indexEvents(messages), start);
      },
    }),
    hive_task_trace_content: tool({
      description: 'Read one runtime-visible non-reasoning session trace source by exactly one selector. With event (a ref from the hive_task_trace v3 index), return that guarded event with its tool input, output, and error together; add field and offset to continue an oversized field in UTF-8-safe 8 KiB chunks. With content_id (a v2 content ID from recovery output), re-read that field in chunks. Every read reauthorizes and rechecks the source; a stale event or cursor means re-index.',
      args: {
        task_id: tool.schema.string().describe('OpenCode session ID visible through the connected runtime.'),
        event: tool.schema.string().optional().describe('Event ref from a hive_task_trace v3 index row or context entry. Not valid with content_id.'),
        field: tool.schema.enum(EVENT_FIELD_NAMES).optional().describe('Field of the selected event to read in chunks. Requires event.'),
        content_id: tool.schema.string().optional().describe('v2 content ID returned by recovery output. Not valid with event or field.'),
        offset: tool.schema.number().optional().describe('UTF-8 byte offset for content_id or event+field reads. Defaults to zero.'),
      },
      async execute({ task_id, event, field, content_id, offset }, context) {
        const reply = (value: RecordValue) => JSON.stringify(value);
        if (
          (content_id === undefined) === (event === undefined)
          || (content_id !== undefined && field !== undefined)
          || (event !== undefined && field === undefined && offset !== undefined)
        ) return reply({ ok: false, reason: 'invalid_selector' });
        const unavailable = reply({ ok: false, reason: 'unavailable_or_unauthorized' });
        const readMessages = async (): Promise<unknown[] | undefined> => {
          const response = await options.client.session.messages({ path: { id: task_id }, query: { directory: options.directory } });
          return response.error === undefined && Array.isArray(response.data) ? response.data : undefined;
        };

        if (content_id !== undefined) {
          const locator = decodeLocator(content_id);
          if (!locator) return reply({ ok: false, reason: 'invalid_content_id' });
          if (!(await resolveTargetSession(options.client, options.directory, task_id, context.sessionID))) return unavailable;
          try {
            const messages = await readMessages();
            if (!messages) throw new Error('missing');
            const value = readLocatedValue(messages, locator);
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
            return reply({ ok: false, reason: 'stale_or_not_found' });
          }
        }

        const selector = decodeEventRef(event);
        if (!selector) return reply({ ok: false, reason: 'invalid_event' });
        if (field !== undefined && !(EVENT_FIELD_NAMES as readonly string[]).includes(field)) return reply({ ok: false, reason: 'invalid_field' });
        if (!(await resolveTargetSession(options.client, options.directory, task_id, context.sessionID))) return unavailable;
        let messages: unknown[] | undefined;
        try {
          messages = await readMessages();
        } catch {
          messages = undefined;
        }
        if (!messages) return unavailable;
        const index = indexEvents(messages);
        const resolved = resolveEvent(index, selector);
        if ('reason' in resolved) return reply({ ok: false, reason: resolved.reason });
        const selected = resolved.event;
        if (field === undefined) {
          return reply({ ok: true, version: 3, task_id, source: { events: index.events.length, as_of: index.asOf }, event: eventDetail(selected) });
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
      },
    }),
  };
}

export function appendTaskTraceHint(input: { tool?: string }, output: { output: string; metadata?: unknown } | undefined): void {
  if (!output || input.tool !== 'task') return;
  const metadata = record(output.metadata);
  const sessionID = typeof metadata?.sessionId === 'string' ? metadata.sessionId.trim() : '';
  if (!sessionID) return;
  const hint = taskTraceContinuationHint(sessionID);
  if ((output.output ?? '').includes(hint)) return;
  output.output = `${output.output ?? ''}${output.output ? '\n\n' : ''}${hint}`;
}

function taskTraceContinuationHint(
  taskID: string,
  leadIn = `[hive task trace] If this child failed, blocked, timed out, was cancelled, returned empty output, or its result is unclear, inspect it with hive_task_trace({ task_id: ${JSON.stringify(taskID)} }).`,
): string {
  return `${leadIn} Read lifecycle, context, and the chronological event index first; follow coverage.next_cursor for more events and use hive_task_trace_content for guarded event detail. Every returned task result is terminal; launch a fresh child session for follow-up and reuse the same Hive task/worktree where appropriate. Pass task_id only when an explicit operator instruction or an explicit runtime-owned interruption-recovery mechanism authorizes continuation; otherwise launch fresh. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer.`;
}

export async function injectTaskTraceHint(
  messages: Array<{ info?: unknown; parts?: unknown[] }>,
  authorize: (childID: string, parentID: string) => Promise<boolean>,
  seen: Set<string> = new Set(),
): Promise<void> {
  for (const message of messages) {
    const info = record(message.info);
    const parentID = typeof info?.sessionID === 'string' ? info.sessionID : undefined;
    if (!parentID || !Array.isArray(message.parts)) continue;
    if (message.parts.some((raw) => record(raw)?.hiveTaskTraceHint === true)) continue;
    for (const rawPart of message.parts) {
      const part = record(rawPart);
      const state = record(part?.state);
      const metadata = record(part?.metadata) ?? record(state?.metadata);
      const childID = typeof metadata?.sessionId === 'string' ? metadata.sessionId.trim() : '';
      const completedEmpty = state?.status === 'completed' && (state.output === '' || state.output === undefined);
      const terminalFailure = ['error', 'failed', 'blocked', 'cancelled', 'timed_out', 'timeout'].includes(String(state?.status));
      if (part?.type !== 'tool' || part.tool !== 'task' || !childID || (!completedEmpty && !terminalFailure)) continue;
      const hintID = `${parentID}\u0000${String(info.id ?? '')}\u0000${String(part.id ?? '')}\u0000${childID}`;
      if (seen.has(hintID)) continue;
      seen.add(hintID);
      if (!(await authorize(childID, parentID))) continue;
      message.parts.push({
        id: `hive-task-trace-hint-${String(part.id ?? childID)}`,
        sessionID: parentID,
        messageID: info.id,
        type: 'text',
        synthetic: true,
        hiveTaskTraceHint: true,
          text: taskTraceContinuationHint(
            childID,
            `[hive task trace] This task result is empty or terminally unsuccessful. Inspect the runtime-visible session with hive_task_trace({ task_id: ${JSON.stringify(childID)} }).`,
          ),
      });
      break;
    }
  }
}
