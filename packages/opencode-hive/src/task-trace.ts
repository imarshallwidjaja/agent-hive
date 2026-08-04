import { createHash } from 'node:crypto';
import { tool } from '@opencode-ai/plugin';
import type { TaskTraceSummarizerConfig } from 'hive-core';

export const TASK_TRACE_SUMMARIZER_AGENT = '__hive_task_trace_summarizer';

const SOFT_TARGET_BYTES = 24 * 1024;
const CONTENT_CHUNK_BYTES = 8 * 1024;
const INITIAL_TEXT_INLINE_BYTES = 512;
const INITIAL_TOOL_INLINE_BYTES = 160;
const INITIAL_ERROR_INLINE_BYTES = 256;
const MAP_BATCH_BYTES = 20 * 1024;
const MAX_SUMMARIZER_RESPONSE_PARTS = 8;
const MAX_SUMMARIZER_RESPONSE_BYTES = 128 * 1024;
const CONTENT_FIELDS = ['text', 'tool.input', 'tool.output', 'tool.error', 'assistant.error', 'retry.error'] as const;

type RecordValue = Record<string, unknown>;
type Actor = 'user' | 'assistant';
type StepState = 'closed' | 'open' | 'malformed';
type ContentField = typeof CONTENT_FIELDS[number];
type ContentLocator = [2, number, number, number, number, string];
type RecoveryFailureReason =
  | 'empty_trace'
  | 'ephemeral_cleanup_failed'
  | 'invalid_map_output'
  | 'invalid_reducer_output'
  | 'latest_assistant_open'
  | 'latest_message_not_assistant'
  | 'latest_message_summary_or_compaction'
  | 'no_successful_map_ranges'
  | 'runtime_active'
  | 'status_unavailable'
  | 'summarizer_unavailable'
  | 'tool_pending_or_running';

interface TaskTraceClient {
  session: {
    get(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
    messages(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
    status?: (input: unknown) => Promise<{ data?: unknown; error?: unknown }>;
    create(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
    prompt(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
    delete(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
  };
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
  actor: Actor;
  state: StepState;
  explicit: boolean;
  meaningful: number;
  texts: IRText[];
  tools: IRTool[];
  errors: IRError[];
  files: string[];
  reasoning: IRReasoning[];
  unknownParts: number;
}

interface TraceIR {
  steps: IRStep[];
  messageCount: number;
  partCount: number;
  compactionCount: number;
  digest: string;
  latestMessage: { role?: string; closed: boolean; summary: boolean } | undefined;
}

interface ExternalizationCandidate {
  container: RecordValue | unknown[];
  key: string | number;
  source: SourceValue;
}

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

  const openStep = (actor: Actor, explicit: boolean): IRStep => {
    const step: IRStep = {
      number: steps.length + 1,
      actor,
      state: 'open',
      explicit,
      meaningful: 0,
      texts: [],
      tools: [],
      errors: [],
      files: [],
      reasoning: [],
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
    latestMessage = { role: typeof info.role === 'string' ? info.role : undefined, closed, summary };
    partCount += parts.length;
    if (info.summary === true) compactionCount += 1;
    let current: IRStep | undefined;

    if (info.error !== undefined && actor === 'assistant') {
      current = openStep(actor, false);
      current.meaningful += 1;
      current.errors.push({ kind: 'assistant', source: sourceValue(messageIndex, -1, 'assistant.error', info.error) });
    }

    parts.forEach((part, partIndex) => {
      const type = typeof part.type === 'string' ? part.type : 'unknown';
      if (type === 'step-start') {
        if (current) current.state = current.explicit ? 'malformed' : 'closed';
        current = openStep(actor, true);
        return;
      }
      if (!current) current = openStep(actor, false);

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
        if (part.error !== undefined) current.errors.push({ kind: 'retry', source: sourceValue(messageIndex, partIndex, 'retry.error', part.error) });
        return;
      }
      if (type === 'patch') {
        current.meaningful += 1;
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

async function authorizeDirectChild(client: TaskTraceClient, directory: string, taskID: string, parentID: string): Promise<boolean> {
  try {
    const response = await client.session.get({ path: { id: taskID }, query: { directory } });
    const child = record(response.data);
    return child?.id === taskID && child.parentID === parentID;
  } catch {
    return false;
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

function assignValue(
  container: RecordValue | unknown[],
  key: string | number,
  source: SourceValue,
  inlineBytes: number,
  candidates: ExternalizationCandidate[],
  contentDictionary: string[],
): void {
  if (source.bytes > inlineBytes) {
    const index = contentDictionary.push(encodeLocator(source));
    container[key as never] = { r: index } as never;
    return;
  }
  container[key as never] = source.value as never;
  candidates.push({ container, key, source });
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

function stepReasoningReport(step: IRStep): RecordValue | undefined {
  if (step.reasoning.length === 0) return undefined;
  const plaintext = step.reasoning.some((part) => part.plaintext !== undefined);
  const opaque = step.reasoning.some((part) => part.opaque);
  const unknown = step.reasoning.some((part) => part.tokens === undefined);
  return {
    presence: plaintext && opaque ? 'mixed' : plaintext ? 'plaintext' : 'opaque',
    parts: step.reasoning.length,
    tokens: unknown ? null : step.reasoning.reduce((total, part) => total + (part.tokens ?? 0), 0),
  };
}

function projectReport(taskID: string, ir: TraceIR, lifecycle: RecordValue): {
  report: RecordValue;
  candidates: ExternalizationCandidate[];
} {
  const candidates: ExternalizationCandidate[] = [];
  const contentDictionary: string[] = [];
  const toolDictionary: string[] = [];
  const toolIndexes = new Map<string, number>();
  const toolStatuses = new Map<number, Record<string, number>>();
  const errors: RecordValue[] = [];
  const files: string[] = [];
  const fileIndexes = new Map<string, number>();
  const openTools: RecordValue[] = [];
  const timeline: RecordValue[] = [];
  let latestTool: RecordValue | undefined;
  let latestError: RecordValue | undefined;

  const toolIndex = (name: string): number => {
    const known = toolIndexes.get(name);
    if (known) return known;
    toolDictionary.push(name);
    const index = toolDictionary.length;
    toolIndexes.set(name, index);
    return index;
  };

  for (const step of ir.steps) {
    const projected: RecordValue = { step: step.number, actor: step.actor, state: step.state };
    if (step.texts.length > 0) {
      const text: unknown[] = [];
      step.texts.forEach((entry, index) => assignValue(text, index, entry.source, INITIAL_TEXT_INLINE_BYTES, candidates, contentDictionary));
      projected.text = text;
    }
    if (step.tools.length > 0) {
      const calls: RecordValue[] = [];
      step.tools.forEach((entry, callIndex) => {
        const index = toolIndex(entry.name);
        const call: RecordValue = { tool: index, status: entry.status };
        if (entry.input) assignValue(call, 'input', entry.input, INITIAL_TOOL_INLINE_BYTES, candidates, contentDictionary);
        if (entry.output) assignValue(call, 'output', entry.output, INITIAL_TOOL_INLINE_BYTES, candidates, contentDictionary);
        calls.push(call);
        const statuses = toolStatuses.get(index) ?? {};
        statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
        toolStatuses.set(index, statuses);
        latestTool = { step: step.number, call: callIndex + 1 };
        if (entry.status === 'pending' || entry.status === 'running') {
          openTools.push({ step: step.number, call: callIndex + 1, tool: index, status: entry.status });
        }
      });
      projected.tool_calls = calls;
    }
    if (step.errors.length > 0) {
      const indexes: number[] = [];
      step.errors.forEach((entry) => {
        const error: RecordValue = { kind: entry.kind, step: step.number };
        assignValue(error, 'error', entry.source, INITIAL_ERROR_INLINE_BYTES, candidates, contentDictionary);
        errors.push(error);
        indexes.push(errors.length);
        latestError = { step: step.number, error: errors.length };
      });
      projected.errors = indexes;
    }
    if (step.files.length > 0) {
      const indexes = step.files.map((file) => {
        const known = fileIndexes.get(file);
        if (known) return known;
        files.push(file);
        const index = files.length;
        fileIndexes.set(file, index);
        return index;
      });
      projected.files = [...new Set(indexes)];
    }
    const reasoning = stepReasoningReport(step);
    if (reasoning) projected.reasoning = reasoning;
    if (step.unknownParts > 0) projected.unknown_parts = step.unknownParts;
    timeline.push(projected);
  }

  const allTexts = ir.steps.flatMap((step) => step.texts.map((text, index) => ({ step, text, index: index + 1 })));
  const instructions = allTexts.filter((entry) => entry.step.actor === 'user');
  const assistantTexts = allTexts.filter((entry) => entry.step.actor === 'assistant');
  const final = [...assistantTexts].reverse().find((entry) => entry.text.messageClosed);
  const progress = [...assistantTexts].reverse().find((entry) => entry !== final);
  const latest: RecordValue = {};
  if (final) latest.final = { step: final.step.number, text: final.index };
  if (progress) latest.progress = { step: progress.step.number, text: progress.index };
  if (latestTool) latest.tool = latestTool;
  if (latestError) latest.error = latestError;

  const report: RecordValue = {
    ok: true,
    version: 2,
    task_id: taskID,
    lifecycle,
    source: {
      messages: ir.messageCount,
      parts: ir.partCount,
      steps: ir.steps.length,
      fidelity: ir.compactionCount > 0 ? 'compacted_surviving_source' : 'surviving_source',
      compactions: ir.compactionCount,
      as_of: ir.digest,
    },
    ...(instructions.length > 0 ? { instruction: { step: instructions[instructions.length - 1].step.number, text: instructions[instructions.length - 1].index } } : {}),
    latest,
    reasoning: reasoningReport(ir.steps),
    content_dictionary: contentDictionary,
    tool_dictionary: toolDictionary,
    tool_rollup: [...toolStatuses.entries()].map(([tool, statuses]) => ({ tool, statuses })),
    changed_files: { files, exhaustive: false },
    errors,
    open_tools: openTools,
    timeline,
    render: { actual_bytes: 0, soft_target_bytes: SOFT_TARGET_BYTES, externalized_count: 0 },
  };
  return { report, candidates };
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

function recoveryBasis(step: IRStep): 'observed' | 'reasoning' | 'mixed' {
  const hasReasoning = step.reasoning.length > 0;
  const hasObserved = step.texts.length > 0 || step.tools.length > 0 || step.errors.length > 0 || step.files.length > 0 || step.unknownParts > 0;
  return hasReasoning && hasObserved ? 'mixed' : hasReasoning ? 'reasoning' : 'observed';
}

function recoveryFragments(steps: IRStep[]): RecordValue[] {
  const fragments: RecordValue[] = [];
  for (const step of steps) {
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
      unknown_parts: step.unknownParts,
    });
    const reasoning = step.reasoning.map((entry) => entry.plaintext ?? '[opaque reasoning part]').join('\n');
    fragments.push({
      step: step.number,
      source: {
        observed,
        ...(reasoning ? { reasoning } : {}),
        basis: recoveryBasis(step),
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

function batchFragments(input: RecordValue[], targetChars: number): RecordValue[][] {
  const splitFragments = [...input];
  while (true) {
    const numbered = numberRecoveryFragments(splitFragments);
    const oversized = numbered.findIndex((fragment) => (
      Buffer.byteLength(stableJson(buildMapRequest([fragment], targetChars).request), 'utf8') > MAP_BATCH_BYTES
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
      && Buffer.byteLength(stableJson(buildMapRequest(candidate, targetChars).request), 'utf8') > MAP_BATCH_BYTES
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

async function promptEphemeral(options: TaskTraceOptions, title: string, request: RecordValue): Promise<{
  response?: { data?: unknown; error?: unknown };
  reasons: RecoveryFailureReason[];
}> {
  let sessionID: string | undefined;
  let response: { data?: unknown; error?: unknown } | undefined;
  const reasons: RecoveryFailureReason[] = [];
  let cleanupFailed = false;
  try {
    const created = await options.client.session.create({ body: { title }, query: { directory: options.directory } });
    const session = record(created.data);
    if (!session || typeof session.id !== 'string') throw new Error('create failed');
    sessionID = session.id;
    options.ephemeralSessionIDs.add(sessionID);
    const body: RecordValue = {
      agent: TASK_TRACE_SUMMARIZER_AGENT,
      parts: [{ type: 'text', text: stableJson(request) }],
    };
    const model = modelRef(options.summarizer.model);
    if (model) body.model = model;
    response = await options.client.session.prompt({ path: { id: sessionID }, query: { directory: options.directory }, body });
    if (response.error !== undefined) reasons.push('summarizer_unavailable');
  } catch {
    reasons.push('summarizer_unavailable');
  } finally {
    if (sessionID) {
      try {
        const deleted = await options.client.session.delete({ path: { id: sessionID }, query: { directory: options.directory } });
        cleanupFailed = deleted.error !== undefined || deleted.data !== true;
      } catch {
        cleanupFailed = true;
      }
      if (!cleanupFailed) options.ephemeralSessionIDs.delete(sessionID);
    }
  }
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

function validateMapOutput(value: RecordValue | undefined, range: number[], steps: number[], basis: Map<number, string>): RecordValue[] | undefined {
  if (!value || Object.keys(value).sort().join(',') !== 'interpretations,kind,range') return undefined;
  if (value.kind !== 'map' || stableJson(value.range) !== stableJson(range) || !Array.isArray(value.interpretations)) return undefined;
  if (value.interpretations.length !== steps.length) return undefined;
  const output: RecordValue[] = [];
  for (const [index, raw] of value.interpretations.entries()) {
    const entry = record(raw);
    const step = steps[index];
    if (!entry || Object.keys(entry).sort().join(',') !== 'basis,step,summary') return undefined;
    if (entry.step !== step || entry.basis !== basis.get(step) || typeof entry.summary !== 'string' || entry.summary.trim().length === 0) return undefined;
    output.push({ step, summary: entry.summary, basis: entry.basis });
  }
  return output;
}

function validateSynthesis(value: RecordValue | undefined): RecordValue | undefined {
  if (!value || Object.keys(value).sort().join(',') !== 'attempted,completed,overview,risks,safest_next_action,unfinished') return undefined;
  if (typeof value.overview !== 'string' || typeof value.safest_next_action !== 'string') return undefined;
  for (const key of ['attempted', 'completed', 'unfinished', 'risks']) {
    if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every((entry) => typeof entry === 'string')) return undefined;
  }
  return value;
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

async function recover(options: TaskTraceOptions, ir: TraceIR, timeline: RecordValue[]): Promise<RecordValue> {
  if (ir.steps.length === 0) return { available: false, reasons: ['empty_trace'] };
  const targetChars = Math.max(80, Math.min(280, Math.round(14_000 / ir.steps.length)));
  const basis = new Map(ir.steps.map((step) => [step.number, recoveryBasis(step)]));
  const batches = batchFragments(recoveryFragments(ir.steps), targetChars);
  const summaries = new Map<number, string[]>();
  const failedSteps = new Set<number>();
  const failedRanges: RecordValue[] = [];
  let observed: RecordValue | undefined;

  for (const [index, fragments] of batches.entries()) {
    const { request, range, steps } = buildMapRequest(fragments, targetChars);
    const prompted = await promptEphemeral(options, `Hive task trace map ${index + 1}`, request);
    observed = observedModel(prompted.response) ?? observed;
    const providerFailed = prompted.reasons.includes('summarizer_unavailable');
    const cleanupFailed = prompted.reasons.includes('ephemeral_cleanup_failed');
    const generated = providerFailed
      ? undefined
      : validateMapOutput(parseJsonRecord(responseText(prompted.response)), range, steps, basis);
    const reasons: RecoveryFailureReason[] = [
      ...(providerFailed ? ['summarizer_unavailable' as const] : generated ? [] : ['invalid_map_output' as const]),
      ...(cleanupFailed ? ['ephemeral_cleanup_failed' as const] : []),
    ];
    if (reasons.length > 0) {
      failedRanges.push({ range, reasons });
      steps.forEach((step) => failedSteps.add(step));
      continue;
    }
    for (const entry of generated ?? []) {
      const step = Number(entry.step);
      const values = summaries.get(step) ?? [];
      values.push(String(entry.summary));
      summaries.set(step, values);
    }
  }

  const interpretations = ir.steps.flatMap((step) => {
    const values = summaries.get(step.number);
    if (!values || failedSteps.has(step.number)) return [];
    const interpretation = {
      summary: values.join(' '),
      basis: basis.get(step.number),
      provenance: 'summarizer_interpretation',
      untrusted: true,
    };
    timeline[step.number - 1].interpretation = interpretation;
    return [{ step: step.number, ...interpretation }];
  });

  let synthesis: RecordValue = { available: false, reasons: ['no_successful_map_ranges'] };
  if (interpretations.length > 0) {
    const prompted = await promptEphemeral(options, 'Hive task trace synthesis', { kind: 'reduce', interpretations });
    observed = observedModel(prompted.response) ?? observed;
    const providerFailed = prompted.reasons.includes('summarizer_unavailable');
    const cleanupFailed = prompted.reasons.includes('ephemeral_cleanup_failed');
    let generated: RecordValue | undefined;
    if (!providerFailed) {
      const parsed = parseJsonRecord(responseText(prompted.response));
      generated = parsed
        && Object.keys(parsed).sort().join(',') === 'kind,synthesis'
        && parsed.kind === 'reduce'
        ? validateSynthesis(record(parsed.synthesis))
        : undefined;
    }
    const reasons: RecoveryFailureReason[] = [
      ...(providerFailed ? ['summarizer_unavailable' as const] : generated ? [] : ['invalid_reducer_output' as const]),
      ...(cleanupFailed ? ['ephemeral_cleanup_failed' as const] : []),
    ];
    synthesis = reasons.length > 0 ? { available: false, reasons } : generated!;
  }

  const synthesisAvailable = synthesis.available !== false;
  return {
    available: failedRanges.length === 0 && synthesisAvailable,
    failed_ranges: failedRanges,
    synthesis,
    model: {
      requested: {
        ...(options.summarizer.model ? { model: options.summarizer.model } : {}),
        ...(options.summarizer.variant ? { variant: options.summarizer.variant } : {}),
      },
      ...(observed ? { observed } : {}),
    },
  };
}

function finalizeReport(report: RecordValue, candidates: ExternalizationCandidate[]): string {
  const render = record(report.render)!;
  const contentDictionary = report.content_dictionary as string[];
  const remaining = [...candidates].sort((left, right) => right.source.bytes - left.source.bytes);

  const renderFixedPoint = (): string => {
    render.externalized_count = contentDictionary.length;
    let serialized = JSON.stringify(report);
    let bytes = Buffer.byteLength(serialized);
    while (render.actual_bytes !== bytes) {
      render.actual_bytes = bytes;
      serialized = JSON.stringify(report);
      bytes = Buffer.byteLength(serialized);
    }
    return serialized;
  };

  let serialized = renderFixedPoint();
  for (const candidate of remaining) {
    if (Number(render.actual_bytes) <= SOFT_TARGET_BYTES) break;
    const before = Number(render.actual_bytes);
    const prior = candidate.container[candidate.key as never];
    const index = contentDictionary.push(encodeLocator(candidate.source));
    candidate.container[candidate.key as never] = { r: index } as never;
    serialized = renderFixedPoint();
    if (Number(render.actual_bytes) >= before) {
      candidate.container[candidate.key as never] = prior as never;
      contentDictionary.pop();
      serialized = renderFixedPoint();
    }
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
  return {
    hive_task_trace: tool({
      description: 'Return a compact complete situation report for one directly delegated child. Compare exact render bytes with the soft target; recovery failures use ordered cause arrays. Optional terminal recovery adds untrusted generated interpretations without exposing raw reasoning.',
      args: {
        task_id: tool.schema.string().describe('Direct child OpenCode session ID returned by native task metadata.'),
        recovery: tool.schema.boolean().optional().describe('Request terminal-only internal map/reduce recovery. Defaults to false.'),
      },
      async execute({ task_id, recovery = false }, context) {
        const unavailable = JSON.stringify({ ok: false, reason: 'unavailable_or_unauthorized' });
        if (!(await authorizeDirectChild(options.client, options.directory, task_id, context.sessionID))) return unavailable;
        let messages: unknown[];
        try {
          const response = await options.client.session.messages({ path: { id: task_id }, query: { directory: options.directory } });
          if (response.error !== undefined || !Array.isArray(response.data)) return unavailable;
          messages = response.data;
        } catch {
          return unavailable;
        }
        let status: RecordValue | undefined;
        if (typeof options.client.session.status === 'function') {
          try {
            const response = await options.client.session.status({ query: { directory: options.directory } });
            status = response.error === undefined ? parseSessionStatusMap(response.data) : undefined;
          } catch {
            status = undefined;
          }
        }
        const ir = normalizeTrace(messages);
        const lifecycle = deriveLifecycle(ir, status, task_id);
        const projected = projectReport(task_id, ir, lifecycle);
        if (recovery) {
          projected.report.recovery = lifecycle.terminal === true
            ? await recover(options, ir, projected.report.timeline as RecordValue[])
            : { available: false, reasons: [lifecycle.reason] };
        }
        return finalizeReport(projected.report, projected.candidates);
      },
    }),
    hive_task_trace_content: tool({
      description: 'Re-read one authorized source-backed non-reasoning task trace field by v2 content ID using UTF-8-safe byte chunks.',
      args: {
        task_id: tool.schema.string().describe('Direct child OpenCode session ID returned by native task metadata.'),
        content_id: tool.schema.string().describe('Opaque v2 source locator returned by hive_task_trace.'),
        offset: tool.schema.number().optional().describe('UTF-8 byte offset. Defaults to zero.'),
      },
      async execute({ task_id, content_id, offset = 0 }, context) {
        const locator = decodeLocator(content_id);
        if (!locator) return JSON.stringify({ ok: false, reason: 'invalid_content_id' });
        if (!(await authorizeDirectChild(options.client, options.directory, task_id, context.sessionID))) {
          return JSON.stringify({ ok: false, reason: 'unavailable_or_unauthorized' });
        }
        try {
          const response = await options.client.session.messages({ path: { id: task_id }, query: { directory: options.directory } });
          if (response.error !== undefined || !Array.isArray(response.data)) throw new Error('missing');
          const value = readLocatedValue(response.data, locator);
          if (value === undefined) throw new Error('missing');
          const text = fieldText(value);
          const bytes = Buffer.from(text);
          if (bytes.length !== locator[4] || digest(text) !== locator[5]) throw new Error('stale');
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) {
            return JSON.stringify({ ok: false, reason: 'invalid_offset' });
          }
          let end = Math.min(bytes.length, offset + CONTENT_CHUNK_BYTES);
          while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
          const content = bytes.subarray(offset, end).toString('utf8');
          return JSON.stringify({
            ok: true,
            version: 2,
            task_id,
            content,
            offset,
            next_offset: end < bytes.length ? end : null,
            bytes: bytes.length,
            sha256: locator[5],
          });
        } catch {
          return JSON.stringify({ ok: false, reason: 'stale_or_not_found' });
        }
      },
    }),
  };
}

export function appendTaskTraceHint(input: { tool?: string }, output: { output: string; metadata?: unknown } | undefined): void {
  if (!output || input.tool !== 'task') return;
  const metadata = record(output.metadata);
  const sessionID = typeof metadata?.sessionId === 'string' ? metadata.sessionId.trim() : '';
  if (!sessionID) return;
  const hint = `[hive task trace] Native task child ${JSON.stringify(sessionID)} is available for read-only inspection with hive_task_trace({ task_id: ${JSON.stringify(sessionID)} }).`;
  if ((output.output ?? '').includes(hint)) return;
  output.output = `${output.output ?? ''}${output.output ? '\n\n' : ''}${hint}`;
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
      const failed = state?.status === 'error';
      if (part?.type !== 'tool' || part.tool !== 'task' || !childID || (!completedEmpty && !failed)) continue;
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
        text: `[hive task trace] Native task metadata identifies child ${JSON.stringify(childID)}. Use hive_task_trace with that task_id for read-only inspection; recovery context belongs in a NEW task without task_id.`,
      });
      break;
    }
  }
}
