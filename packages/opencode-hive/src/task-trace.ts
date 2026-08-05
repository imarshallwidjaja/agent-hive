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
const MAP_CONCURRENCY = 3;
const SUMMARIZER_ATTEMPT_MS = 120_000;
const SEMANTIC_RECOVERY_MS = 300_000;
const REDUCTION_RESERVE_MS = 120_000;
const CLEANUP_ATTEMPT_MS = 10_000;
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

async function authorizeDirectChild(
  client: TaskTraceClient,
  directory: string,
  taskID: string,
  parentID: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await client.session.get({ path: { id: taskID }, query: { directory }, ...(signal ? { signal } : {}) });
    const child = record(response.data);
    return child?.id === taskID && child.parentID === parentID;
  } catch {
    if (signal?.aborted) throw cancellationReason(signal);
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

function traceTextSelections(ir: TraceIR) {
  const all = ir.steps.flatMap((step) => step.texts.map((text, index) => ({ step, text, index: index + 1 })));
  const instructions = all.filter((entry) => entry.step.actor === 'user');
  const assistant = all.filter((entry) => entry.step.actor === 'assistant');
  const final = [...assistant].reverse().find((entry) => entry.text.messageClosed);
  const progress = [...assistant].reverse().find((entry) => entry !== final);
  return { instruction: instructions.at(-1), final, progress };
}

function recoveryTerminalText(ir: TraceIR, lifecycle: RecordValue) {
  if (lifecycle.terminal !== true || !ir.latestMessage) return undefined;
  const terminalStep = [...ir.steps].reverse().find((step) => (
    step.message === ir.latestMessage!.index && step.actor === 'assistant'
  ));
  const text = terminalStep?.texts.at(-1);
  return terminalStep && text?.messageClosed ? { step: terminalStep, text } : undefined;
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

  const selections = traceTextSelections(ir);
  const latest: RecordValue = {};
  if (selections.final) latest.final = { step: selections.final.step.number, text: selections.final.index };
  if (selections.progress) latest.progress = { step: selections.progress.step.number, text: selections.progress.index };
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
    ...(selections.instruction ? { instruction: { step: selections.instruction.step.number, text: selections.instruction.index } } : {}),
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
  ir: TraceIR,
  callerSignal: AbortSignal,
): Promise<{ recovery: RecordValue; semantic: RecordValue }> {
  if (callerSignal.aborted) throw cancellationReason(callerSignal);
  const recoveryDeadline = Date.now() + SEMANTIC_RECOVERY_MS;
  const mapDeadline = recoveryDeadline - REDUCTION_RESERVE_MS;
  const targetChars = Math.max(80, Math.min(280, Math.round(14_000 / ir.steps.length)));
  const capabilities = new Map(ir.steps.map((step) => [step.number, recoveryCapabilities(step)]));
  const batches = batchFragments(recoveryFragments(ir.steps, capabilities), targetChars);
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
  const mapWorker = async () => {
    while (true) {
      if (callerSignal.aborted) throw cancellationReason(callerSignal);
      if (Date.now() >= mapDeadline || nextBatch >= batches.length) return;
      const index = nextBatch;
      nextBatch += 1;
      const { request, range, steps } = buildMapRequest(batches[index], targetChars);
      const prompted = await promptEphemeral(options, `Hive task trace map ${index + 1}`, request, callerSignal, mapDeadline);
      outcomes[index] = { range, steps, prompted };
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(MAP_CONCURRENCY, batches.length) }, () => mapWorker()));
  if (callerSignal.aborted) throw cancellationReason(callerSignal);

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
    const prompted = await promptEphemeral(options, 'Hive task trace semantic reduction', request, callerSignal, recoveryDeadline);
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
    || ir.steps.some((step) => step.errors.length > 0);
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
  ir: TraceIR,
  lifecycle: RecordValue,
  recovery: RecordValue,
  semantic: RecordValue | null,
): RecordValue {
  const selections = traceTextSelections(ir);
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
    lifecycle,
    source: {
      steps: ir.steps.length,
      fidelity: ir.compactionCount > 0 ? 'compacted_surviving_source' : 'surviving_source',
      compactions: ir.compactionCount,
      as_of: ir.digest,
    },
    ...(selections.instruction ? {
      task_instruction: {
        step: selections.instruction.step.number,
        text: recoverySourceValue(selections.instruction.text.source, INITIAL_TEXT_INLINE_BYTES),
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
      description: 'Return a compact complete situation report for one directly delegated child. Deterministic mode preserves the forensic v2 report; terminal recovery returns only an untrusted semantic projection with coverage-gated phases and runtime-safe next actions.',
      args: {
        task_id: tool.schema.string().describe('Direct child OpenCode session ID returned by native task metadata.'),
        recovery: tool.schema.boolean().optional().describe('Request the terminal-only semantic map/reduce projection. Defaults to false forensic output.'),
      },
      async execute({ task_id, recovery = false }, context) {
        if (recovery && context.abort.aborted) throw cancellationReason(context.abort);
        const unavailable = JSON.stringify({ ok: false, reason: 'unavailable_or_unauthorized' });
        if (!(await authorizeDirectChild(
          options.client,
          options.directory,
          task_id,
          context.sessionID,
          recovery ? context.abort : undefined,
        ))) return unavailable;
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
        let status: RecordValue | undefined;
        if (typeof options.client.session.status === 'function') {
          try {
            const response = await options.client.session.status({
              query: { directory: options.directory },
              ...(recovery ? { signal: context.abort } : {}),
            });
            status = response.error === undefined ? parseSessionStatusMap(response.data) : undefined;
          } catch {
            if (recovery && context.abort.aborted) throw cancellationReason(context.abort);
            status = undefined;
          }
        }
        const ir = normalizeTrace(messages);
        const lifecycle = deriveLifecycle(ir, status, task_id);
        if (recovery) {
          if (ir.steps.length === 0 || lifecycle.terminal !== true) {
            const reason = ir.steps.length === 0 ? 'empty_trace' : String(lifecycle.reason);
            const unavailableRecovery = {
              status: 'unavailable',
              failures: [{ stage: 'eligibility', reasons: [reason] }],
              model: { requested: requestedRecoveryModel(options) },
              cards_source: null,
              phases_source: null,
            };
            return finalizeRecoveryProjection(recoveryProjection(task_id, ir, lifecycle, unavailableRecovery, null));
          }
          const recovered = await recover(options, ir, context.abort);
          return finalizeRecoveryProjection(recoveryProjection(task_id, ir, lifecycle, recovered.recovery, recovered.semantic));
        }
        const projected = projectReport(task_id, ir, lifecycle);
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
