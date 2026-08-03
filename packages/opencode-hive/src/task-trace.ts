import { createHash } from 'node:crypto';
import { tool } from '@opencode-ai/plugin';
import type { TaskTraceSummarizerConfig } from 'hive-core';

export const TASK_TRACE_SUMMARIZER_AGENT = '__hive_task_trace_summarizer';

const INLINE_BYTES = 4096;
const PREVIEW_BYTES = 512;
const MAX_BATCH_STEPS = 8;
const MAX_BATCH_BYTES = 32 * 1024;
const MAX_SUMMARY_BYTES = 2 * 1024;
const MAX_SUMMARIZER_RESPONSE_PARTS = 8;
const MAX_SUMMARIZER_RESPONSE_BYTES = 24 * 1024;
const MAX_RECOVERY_SUMMARY_BYTES = 24 * 1024;
const SNAPSHOT_MESSAGE_LIMIT = 20;
const TRACE_MESSAGE_LIMIT = 128;
const TRACE_PART_LIMIT = 128;
const TASK_TRACE_RESULT_BYTE_LIMIT = 128 * 1024;
const TASK_TRACE_ENVELOPE_BYTE_BUDGET = 8 * 1024;
const RECOVERY_RESULT_BYTE_BUDGET = 32 * 1024;
const TRACE_BYTE_LIMIT = TASK_TRACE_RESULT_BYTE_LIMIT - TASK_TRACE_ENVELOPE_BYTE_BUDGET;
const RECOVERY_TRACE_BYTE_LIMIT = TRACE_BYTE_LIMIT - RECOVERY_RESULT_BYTE_BUDGET;
const MAX_REASONING_METADATA_VALUE_BYTES = 256;
const CONTENT_FIELDS = new Set(['text', 'tool.input', 'tool.output', 'tool.error', 'patch', 'lifecycle.error']);
const SAFE_REASONING_METADATA_KEYS = new Set(['encrypted', 'format', 'itemId', 'model', 'provider', 'providerItemId', 'type']);
const SAFE_REASONING_METADATA_VALUE_KEYS = new Set(['format', 'itemId', 'model', 'provider', 'providerItemId', 'type']);
const SAFE_REASONING_TIME_KEYS = ['created', 'completed', 'start', 'end'];

type RecordValue = Record<string, unknown>;

interface TraceMessage {
  info: RecordValue;
  parts: RecordValue[];
}

interface TraceOrigin {
  messageOrdinal: number;
  partOrdinals: number[];
  totalPartCount: number;
  latestAssistantTextOrdinal?: number;
}

interface ContentLocator {
  v: 1;
  sessionID: string;
  messageID: string;
  partID: string;
  field: string;
  bytes: number;
  sha256: string;
}

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

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = record(value);
  if (object) {
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function bytePreview(value: string): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= PREVIEW_BYTES) return value;
  return buffer.subarray(0, PREVIEW_BYTES).toString('utf8').replace(/\uFFFD$/u, '');
}

function encodeLocator(locator: ContentLocator): string {
  return Buffer.from(JSON.stringify(locator)).toString('base64url');
}

function decodeLocator(contentID: string): ContentLocator | undefined {
  if (contentID.length === 0 || contentID.length > 4096) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(contentID, 'base64url').toString('utf8')) as unknown;
    const value = record(parsed);
    if (!value || Object.keys(value).join(',') !== 'v,sessionID,messageID,partID,field,bytes,sha256') return undefined;
    if (
      value.v !== 1
      || typeof value.sessionID !== 'string'
      || value.sessionID.length === 0
      || typeof value.messageID !== 'string'
      || value.messageID.length === 0
      || typeof value.partID !== 'string'
      || value.partID.length === 0
      || typeof value.field !== 'string'
      || !CONTENT_FIELDS.has(value.field)
      || typeof value.bytes !== 'number'
      || !Number.isSafeInteger(value.bytes)
      || value.bytes <= INLINE_BYTES
      || typeof value.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.sha256)
    ) return undefined;
    const locator = value as unknown as ContentLocator;
    return encodeLocator(locator) === contentID ? locator : undefined;
  } catch {
    return undefined;
  }
}

function fieldText(value: unknown): string {
  return typeof value === 'string' ? value : stableJson(value);
}

function exposeField(
  value: unknown,
  source: { sessionID: string; messageID: string; partID: string; field: string },
): unknown {
  const content = fieldText(value);
  const bytes = Buffer.byteLength(content);
  if (bytes <= INLINE_BYTES) return value;
  const locator: ContentLocator = {
    v: 1,
    sessionID: source.sessionID,
    messageID: source.messageID,
    partID: source.partID,
    field: source.field,
    bytes,
    sha256: sha256(content),
  };
  return { preview: bytePreview(content), content_id: encodeLocator(locator), bytes, sha256: locator.sha256 };
}

function partString(part: RecordValue, key: string): string | undefined {
  const value = part[key];
  return typeof value === 'string' ? value : undefined;
}

function toolState(part: RecordValue): RecordValue {
  return record(part.state) ?? {};
}

function sourceIDs(message: TraceMessage, part: RecordValue, messageOrdinal: number, partOrdinal: number) {
  return {
    message_id: String(message.info.id ?? ''),
    part_id: String(part.id ?? ''),
    message_ordinal: messageOrdinal,
    part_ordinal: partOrdinal,
  };
}

function evidenceForPart(message: TraceMessage, part: RecordValue, messageOrdinal: number, partOrdinal: number, assistantFinalText = false, authoritativeSessionID?: string): RecordValue[] {
  const type = partString(part, 'type') ?? 'unknown';
  const role = partString(message.info, 'role');
  const ids = sourceIDs(message, part, messageOrdinal, partOrdinal);
  const source = {
    sessionID: authoritativeSessionID ?? String(message.info.sessionID ?? ''),
    messageID: ids.message_id,
    partID: ids.part_id,
  };
  if (type === 'reasoning') return [];
  if (type === 'text') {
    const text = partString(part, 'text') ?? '';
    const provenance = role === 'user'
      ? 'delegated_instruction'
      : assistantFinalText
        ? 'assistant_final_response'
        : 'assistant_progress_text';
    return [{ ...ids, type, provenance, text: exposeField(text, { ...source, field: 'text' }) }];
  }
  if (type === 'tool') {
    const state = toolState(part);
    const result: RecordValue[] = [{
      ...ids,
      type,
      provenance: 'lifecycle_event',
      tool: part.tool ?? part.name,
      status: state.status,
    }];
    if (state.input !== undefined) result.push({ ...ids, type, provenance: 'tool_input', tool: part.tool ?? part.name, input: exposeField(state.input, { ...source, field: 'tool.input' }) });
    if (state.output !== undefined) result.push({ ...ids, type, provenance: 'tool_output', tool: part.tool ?? part.name, output: exposeField(state.output, { ...source, field: 'tool.output' }) });
    if (state.error !== undefined) result.push({ ...ids, type, provenance: 'tool_output', tool: part.tool ?? part.name, error: exposeField(state.error, { ...source, field: 'tool.error' }) });
    return result;
  }
  if (type === 'patch') {
    const patch = part.patch ?? part.files ?? part;
    return [{ ...ids, type, provenance: 'patch', patch: exposeField(patch, { ...source, field: 'patch' }) }];
  }
  if (type === 'step-start' || type === 'step-finish' || type === 'compaction' || type === 'summary') {
    return [{ ...ids, type, provenance: 'lifecycle_event' }];
  }
  return [{ ...ids, type, provenance: 'lifecycle_event', malformed: type === 'unknown' }];
}

function tokenCount(part: RecordValue): number | undefined {
  const direct = part.tokens;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct;
  const tokens = record(part.tokens);
  if (!tokens) return undefined;
  const values = Object.values(tokens).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
}

function safeReasoningMetadata(metadata: RecordValue): RecordValue {
  const safe: RecordValue = {};
  for (const key of Object.keys(metadata).filter((entry) => SAFE_REASONING_METADATA_VALUE_KEYS.has(entry)).sort()) {
    const value = metadata[key];
    if (typeof value === 'string' && Buffer.byteLength(value) <= MAX_REASONING_METADATA_VALUE_BYTES) safe[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === 'boolean') safe[key] = value;
  }
  return safe;
}

function safeReasoningTime(value: unknown): RecordValue | undefined {
  const time = record(value);
  if (!time) return undefined;
  const safe: RecordValue = {};
  for (const key of SAFE_REASONING_TIME_KEYS) {
    const entry = time[key];
    if (typeof entry === 'number' && Number.isFinite(entry)) safe[key] = entry;
    else if (typeof entry === 'string' && Buffer.byteLength(entry) <= MAX_REASONING_METADATA_VALUE_BYTES) safe[key] = entry;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export function segmentTaskTrace(input: unknown[], authoritativeSessionID?: string, origins?: TraceOrigin[]): {
  messages: RecordValue[];
  steps: RecordValue[];
  reasoning: RecordValue;
  loss_markers: RecordValue[];
} {
  const messages = input.map((entry) => {
    const value = record(entry) ?? {};
    return { info: record(value.info) ?? {}, parts: Array.isArray(value.parts) ? value.parts.map((part) => record(part) ?? {}) : [] };
  });
  const steps: Array<RecordValue & { evidence: RecordValue[] }> = [];
  const messageReports: RecordValue[] = [];
  const opaqueParts: RecordValue[] = [];
  const lossMarkers: RecordValue[] = [];
  let plaintextCount = 0;
  let plaintextBytes = 0;
  let opaqueCount = 0;
  let knownTokens = 0;
  let unknownTokenParts = 0;

  for (const [messageIndex, message] of messages.entries()) {
    const origin = origins?.[messageIndex];
    const messageOrdinal = origin?.messageOrdinal ?? messageIndex + 1;
    const messageID = String(message.info.id ?? `message-${messageOrdinal}`);
    let stepOrdinal = 0;
    let current: (RecordValue & { evidence: RecordValue[] }) | undefined;
    let messageReasoningParts = 0;
    let messageReasoningTokens: number | null = 0;
    const open = (implicit: boolean): RecordValue & { evidence: RecordValue[] } => {
      stepOrdinal += 1;
      const step: RecordValue & { evidence: RecordValue[] } = {
        step_id: `${messageID}:step:${stepOrdinal}`,
        message_id: messageID,
        step_ordinal: stepOrdinal,
        implicit,
        close_reason: 'open',
        reasoning_part_count: 0,
        reasoning_token_count: 0,
        reasoning_part_ids: [],
        evidence: [],
      };
      steps.push(step);
      return step;
    };

    if (message.info.summary === true) {
      lossMarkers.push({ message_id: messageID, message_ordinal: messageOrdinal, type: 'summary_or_compaction', raw_fidelity: false });
    }
    if (message.info.error !== undefined) {
      current = open(true);
      const errorPartID = '@message-error';
      current.evidence.push({
        message_id: messageID,
        part_id: errorPartID,
        message_ordinal: messageOrdinal,
        part_ordinal: 0,
        provenance: 'lifecycle_event',
        type: 'message-error',
        error: exposeField(message.info.error, {
          sessionID: authoritativeSessionID ?? String(message.info.sessionID ?? ''),
          messageID,
          partID: errorPartID,
          field: 'lifecycle.error',
        }),
      });
    }

    const latestAssistantTextOrdinal = message.info.role === 'assistant' && record(message.info.time)?.completed !== undefined
      ? origin?.latestAssistantTextOrdinal ?? message.parts.map((part) => part.type).lastIndexOf('text') + 1
      : -1;
    for (const [partIndex, part] of message.parts.entries()) {
      const partOrdinal = origin?.partOrdinals[partIndex] ?? partIndex + 1;
      const type = partString(part, 'type') ?? 'unknown';
      if (type === 'step-start') {
        if (current) current.close_reason = current.implicit ? 'implicit-boundary' : 'malformed:nested-start';
        current = open(false);
      } else if (!current) {
        current = open(true);
      }

      if (type === 'reasoning') {
        const text = partString(part, 'text');
        const tokens = tokenCount(part);
        messageReasoningParts += 1;
        current.reasoning_part_count = Number(current.reasoning_part_count) + 1;
        if (tokens === undefined) {
          messageReasoningTokens = null;
          current.reasoning_token_count = null;
          unknownTokenParts += 1;
        } else {
          knownTokens += tokens;
          if (messageReasoningTokens !== null) messageReasoningTokens += tokens;
          if (current.reasoning_token_count !== null) current.reasoning_token_count = Number(current.reasoning_token_count) + tokens;
        }
        (current.reasoning_part_ids as string[]).push(String(part.id ?? ''));
        current.evidence.push({
          ...sourceIDs(message, part, messageOrdinal, partOrdinal),
          type,
          provenance: 'assistant_reasoning',
          representation: text === undefined ? 'opaque' : 'plaintext',
          ...(text === undefined ? {} : { bytes: Buffer.byteLength(text) }),
          ...(tokens === undefined ? {} : { tokens }),
        });
        if (text !== undefined) {
          plaintextCount += 1;
          plaintextBytes += Buffer.byteLength(text);
        } else {
          opaqueCount += 1;
          const metadata = record(part.metadata) ?? {};
          const safeMetadata = safeReasoningMetadata(metadata);
          const time = safeReasoningTime(part.time);
          opaqueParts.push({
            message_id: messageID,
            part_id: String(part.id ?? ''),
            message_ordinal: messageOrdinal,
            part_ordinal: partOrdinal,
            metadata_keys: Object.keys(metadata).filter((key) => SAFE_REASONING_METADATA_KEYS.has(key)).sort(),
            ...(Object.keys(safeMetadata).length > 0 ? { metadata: safeMetadata } : {}),
            metadata_digest: sha256(stableJson(metadata)),
            ...(time ? { time } : {}),
          });
        }
      } else {
        current.evidence.push(...evidenceForPart(message, part, messageOrdinal, partOrdinal, partOrdinal === latestAssistantTextOrdinal, authoritativeSessionID));
        if (type === 'compaction' || type === 'summary') {
          lossMarkers.push({ message_id: messageID, part_id: String(part.id ?? ''), message_ordinal: messageOrdinal, part_ordinal: partOrdinal, type: 'summary_or_compaction', raw_fidelity: false });
        }
      }

      if (type === 'step-finish') {
        if (current.implicit && current.evidence.length === 1) current.close_reason = 'malformed:orphan-finish';
        else current.close_reason = 'step-finish';
        current = undefined;
      } else if (type === 'step-start' && current && current.evidence.length === 0) {
        current.evidence.push(...evidenceForPart(message, part, messageOrdinal, partOrdinal, false, authoritativeSessionID));
      }
    }
    if (current && !current.implicit) current.close_reason = 'open';
    messageReports.push({
      message_id: messageID,
      message_ordinal: messageOrdinal,
      role: message.info.role,
      part_count: origin?.totalPartCount ?? message.parts.length,
      represented_part_count: message.parts.length,
      reasoning_part_count: messageReasoningParts,
      reasoning_token_count: messageReasoningTokens,
      closed: record(message.info.time)?.completed !== undefined || message.info.error !== undefined,
    });
  }

  const availability = plaintextCount > 0 && opaqueCount > 0
    ? 'mixed'
    : plaintextCount > 0
      ? 'plaintext'
      : opaqueCount > 0
        ? 'opaque'
        : 'none';
  return {
    messages: messageReports,
    steps,
    reasoning: {
      availability,
      part_count: plaintextCount + opaqueCount,
      plaintext_part_count: plaintextCount,
      plaintext_bytes: plaintextBytes,
      opaque_part_count: opaqueCount,
      opaque_parts: opaqueParts,
      token_count: unknownTokenParts > 0 ? null : knownTokens,
      known_token_count: knownTokens,
      unknown_token_part_count: unknownTokenParts,
    },
    loss_markers: lossMarkers,
  };
}

function extractMessages(response: { data?: unknown }): unknown[] | undefined {
  return Array.isArray(response.data) ? response.data : undefined;
}

function selectTraceInput(input: unknown[], mode: 'snapshot' | 'audit' | 'recovery', messageLimit: number, partLimit: number): {
  messages: unknown[];
  origins: TraceOrigin[];
  totalPartCount: number;
  representedPartCount: number;
} {
  const normalized = input.map((entry, index) => {
    const value = record(entry) ?? {};
    const info = record(value.info) ?? {};
    const parts = Array.isArray(value.parts) ? value.parts : [];
    const latestTextOrdinal = parts.map((part) => record(part)?.type).lastIndexOf('text') + 1;
    return {
      info,
      parts,
      messageOrdinal: index + 1,
      latestAssistantTextOrdinal: latestTextOrdinal > 0 ? latestTextOrdinal : undefined,
    };
  });
  const ordered = mode === 'snapshot' ? [...normalized].reverse() : normalized;
  const selected: Array<{ message: unknown; origin: TraceOrigin }> = [];
  let representedPartCount = 0;
  for (const entry of ordered) {
    if (selected.length >= messageLimit) break;
    if (entry.parts.length > 0 && representedPartCount >= partLimit) break;
    const take = Math.min(entry.parts.length, partLimit - representedPartCount);
    if (entry.parts.length > 0 && take === 0) break;
    const start = mode === 'snapshot' ? entry.parts.length - take : 0;
    const parts = entry.parts.slice(start, start + take);
    selected.push({
      message: { info: entry.info, parts },
      origin: {
        messageOrdinal: entry.messageOrdinal,
        partOrdinals: Array.from({ length: take }, (_, index) => start + index + 1),
        totalPartCount: entry.parts.length,
        latestAssistantTextOrdinal: entry.latestAssistantTextOrdinal,
      },
    });
    representedPartCount += take;
    if (take < entry.parts.length) break;
  }
  if (mode === 'snapshot') selected.reverse();
  return {
    messages: selected.map((entry) => entry.message),
    origins: selected.map((entry) => entry.origin),
    totalPartCount: normalized.reduce((total, entry) => total + entry.parts.length, 0),
    representedPartCount,
  };
}

function boundedTaskTrace(input: unknown[], mode: 'snapshot' | 'audit' | 'recovery', authoritativeSessionID: string) {
  const configuredMessageLimit = mode === 'snapshot' ? SNAPSHOT_MESSAGE_LIMIT : TRACE_MESSAGE_LIMIT;
  const maxTraceBytes = mode === 'recovery' ? RECOVERY_TRACE_BYTE_LIMIT : TRACE_BYTE_LIMIT;
  let messageLimit = configuredMessageLimit;
  let partLimit = TRACE_PART_LIMIT;
  let selection = selectTraceInput(input, mode, messageLimit, partLimit);
  let trace = segmentTaskTrace(selection.messages, authoritativeSessionID, selection.origins);
  let representedBytes = Buffer.byteLength(stableJson(trace));
  while (representedBytes > maxTraceBytes) {
    if (selection.representedPartCount > 0 && partLimit > 0) {
      partLimit = Math.min(
        partLimit - 1,
        Math.max(0, Math.floor(selection.representedPartCount * maxTraceBytes / representedBytes) - 1),
      );
    } else if (selection.origins.length > 0 && messageLimit > 0) {
      messageLimit = Math.min(
        messageLimit - 1,
        Math.max(0, Math.floor(selection.origins.length * maxTraceBytes / representedBytes) - 1),
      );
    } else {
      break;
    }
    selection = selectTraceInput(input, mode, messageLimit, partLimit);
    trace = segmentTaskTrace(selection.messages, authoritativeSessionID, selection.origins);
    representedBytes = Buffer.byteLength(stableJson(trace));
  }
  const representedParts = selection.origins.flatMap((origin) => origin.partOrdinals.map((partOrdinal) => ({
    message_ordinal: origin.messageOrdinal,
    part_ordinal: partOrdinal,
  })));
  const omittedMessageCount = input.length - selection.origins.length;
  const omittedPartCount = selection.totalPartCount - selection.representedPartCount;
  return {
    trace,
    truncation: {
      truncated: omittedMessageCount > 0 || omittedPartCount > 0,
      omitted_message_count: omittedMessageCount,
      omitted_part_count: omittedPartCount,
      represented_message_count: selection.origins.length,
      represented_part_count: selection.representedPartCount,
      represented_bytes: representedBytes,
      limits: {
        max_messages: configuredMessageLimit,
        max_parts: TRACE_PART_LIMIT,
        max_bytes: TASK_TRACE_RESULT_BYTE_LIMIT,
        max_trace_bytes: maxTraceBytes,
        max_recovery_summary_bytes: MAX_RECOVERY_SUMMARY_BYTES,
      },
      represented_range: selection.origins.length === 0
        ? null
        : {
            first_message_ordinal: selection.origins[0].messageOrdinal,
            last_message_ordinal: selection.origins[selection.origins.length - 1].messageOrdinal,
            first_part: representedParts[0] ?? null,
            last_part: representedParts[representedParts.length - 1] ?? null,
          },
    },
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
  if (entry.type === 'idle' || entry.type === 'busy') {
    return Object.keys(entry).length === 1;
  }
  if (entry.type !== 'retry') return false;
  if (typeof entry.attempt !== 'number' || !Number.isFinite(entry.attempt)) return false;
  if (typeof entry.message !== 'string' || typeof entry.next !== 'number' || !Number.isFinite(entry.next)) return false;
  const keys = Object.keys(entry).sort();
  if (keys.join(',') === 'attempt,message,next,type') return true;
  if (keys.join(',') !== 'action,attempt,message,next,type') return false;
  const action = record(entry.action);
  if (!action) return false;
  if (typeof action.reason !== 'string' || typeof action.provider !== 'string' || typeof action.title !== 'string') return false;
  if (typeof action.message !== 'string' || typeof action.label !== 'string') return false;
  const actionKeys = Object.keys(action).sort();
  if (actionKeys.join(',') === 'label,message,provider,reason,title') return true;
  return actionKeys.join(',') === 'label,link,message,provider,reason,title' && typeof action.link === 'string';
}

function parseSessionStatusMap(value: unknown): RecordValue | undefined {
  const map = record(value);
  if (!map) return undefined;
  for (const entry of Object.values(map)) {
    if (!isSessionStatusValue(entry)) return undefined;
  }
  return map;
}

function lifecycle(messages: unknown[], status: RecordValue | undefined, taskID: string): RecordValue {
  const entries = messages.map((entry) => record(entry) ?? {});
  const latest = entries[entries.length - 1];
  const info = record(latest?.info);
  const latestParts = Array.isArray(latest?.parts) ? latest.parts.map((part) => record(part) ?? {}) : [];
  const pendingTool = entries.flatMap((entry) => Array.isArray(entry.parts) ? entry.parts : []).map((part) => record(part) ?? {}).some((part) => {
    if (part.type !== 'tool') return false;
    return ['pending', 'running'].includes(String(toolState(part).status ?? ''));
  });
  const latestClosed = info !== undefined && (record(info.time)?.completed !== undefined || info.error !== undefined);
  if (status === undefined) return { state: 'uncertain', stable_terminal: false, incomplete: true, reason: 'status_unavailable' };
  const runtimeStatus = record(status[taskID]);
  if (runtimeStatus && (runtimeStatus.type === 'busy' || runtimeStatus.type === 'retry')) {
    return { state: 'active', stable_terminal: false, incomplete: true, reason: 'runtime_active' };
  }
  if (info?.role !== 'assistant') return { state: 'uncertain', stable_terminal: false, incomplete: true, reason: 'latest_message_not_assistant' };
  if (info.summary === true || latestParts.some((part) => part.type === 'summary' || part.type === 'compaction')) {
    return { state: 'uncertain', stable_terminal: false, incomplete: true, reason: 'latest_message_summary_or_compaction' };
  }
  if (!latestClosed) return { state: 'uncertain', stable_terminal: false, incomplete: true, reason: 'latest_assistant_open' };
  if (pendingTool) return { state: 'uncertain', stable_terminal: false, incomplete: true, reason: 'tool_pending_or_running' };
  return { state: 'terminal', stable_terminal: true, incomplete: false, reason: 'idle_and_closed' };
}

function sourceReasoning(messages: unknown[], step: RecordValue): Array<{ part_id: string; text: string }> {
  const messageID = step.message_id;
  const message = messages.map(record).find((entry) => record(entry?.info)?.id === messageID);
  if (!message || !Array.isArray(message.parts)) return [];
  const sourcePartIDs = new Set(Array.isArray(step.reasoning_part_ids) ? step.reasoning_part_ids.filter((id): id is string => typeof id === 'string') : []);
  return message.parts.flatMap((rawPart) => {
    const part = record(rawPart);
    return part?.type === 'reasoning' && typeof part.text === 'string' && sourcePartIDs.has(String(part.id ?? ''))
      ? [{ part_id: String(part.id ?? ''), text: part.text }]
      : [];
  });
}

function summaryResponseText(response: { data?: unknown }): { text?: string; reason?: 'summarizer_response_limit_exceeded' } {
  const data = record(response.data);
  const parts = Array.isArray(data?.parts) ? data.parts : [];
  const textParts: string[] = [];
  let bytes = 0;
  for (const rawPart of parts) {
    const part = record(rawPart);
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    if (textParts.length >= MAX_SUMMARIZER_RESPONSE_PARTS) return { reason: 'summarizer_response_limit_exceeded' };
    const nextBytes = Buffer.byteLength(part.text) + (textParts.length === 0 ? 0 : 1);
    if (bytes + nextBytes > MAX_SUMMARIZER_RESPONSE_BYTES) return { reason: 'summarizer_response_limit_exceeded' };
    bytes += nextBytes;
    textParts.push(part.text);
  }
  return { text: textParts.join('\n') };
}

function validateSummary(
  text: string,
  batchID: string,
  steps: Array<{ step_id: string; reasoning_part_ids: string[] }>,
): RecordValue[] | undefined {
  try {
    const parsed = record(JSON.parse(text));
    if (!parsed || Object.keys(parsed).sort().join(',') !== 'batch_id,steps' || parsed.batch_id !== batchID || !Array.isArray(parsed.steps) || parsed.steps.length !== steps.length) return undefined;
    const seen = new Set<string>();
    const generated = parsed.steps.map((raw, index) => {
      const value = record(raw);
      const expected = steps[index];
      if (!value || Object.keys(value).sort().join(',') !== 'reasoning_part_ids,step_id,summary') throw new Error('invalid keys');
      if (value.step_id !== expected.step_id || seen.has(expected.step_id)) throw new Error('invalid step');
      seen.add(expected.step_id);
      if (typeof value.summary !== 'string' || value.summary.trim().length === 0 || Buffer.byteLength(value.summary) > MAX_SUMMARY_BYTES) throw new Error('invalid summary');
      if (!Array.isArray(value.reasoning_part_ids) || stableJson(value.reasoning_part_ids) !== stableJson(expected.reasoning_part_ids)) throw new Error('invalid reasoning refs');
      return {
        step_id: expected.step_id,
        summary: value.summary,
        provenance: 'summarizer_interpretation',
        reasoning_part_ids: expected.reasoning_part_ids,
        untrusted: true,
      };
    });
    return generated;
  } catch {
    return undefined;
  }
}

function modelRef(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const separator = model.indexOf('/');
  return separator > 0 && separator < model.length - 1
    ? { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
    : undefined;
}

async function summarizeRecovery(
  options: TaskTraceOptions,
  messages: unknown[],
  steps: RecordValue[],
): Promise<RecordValue> {
  const sources = steps.map((step) => {
    const reasoning = sourceReasoning(messages, step);
    return {
      step_id: String(step.step_id),
      reasoning_part_ids: reasoning.map((part) => part.part_id),
      source: { evidence: step.evidence, reasoning },
    };
  });
  if (sources.length === 0) return { available: false, reason: 'empty_trace' };
  const summaries: RecordValue[] = [];
  let batchNumber = 0;
  let cursor = 0;
  while (cursor < sources.length) {
    const batch: typeof sources = [];
    while (cursor < sources.length && batch.length < MAX_BATCH_STEPS) {
      const candidate = [...batch, sources[cursor]];
      if (Buffer.byteLength(stableJson(candidate)) > MAX_BATCH_BYTES) break;
      batch.push(sources[cursor]);
      cursor += 1;
    }
    if (batch.length === 0) return { available: false, reason: 'summary_source_too_large', summaries };
    batchNumber += 1;
    const batchID = `batch-${batchNumber}`;
    let sessionID: string | undefined;
    let generated: RecordValue[] | undefined;
    let providerFailed = false;
    let responseLimitExceeded = false;
    let cleanupFailed = false;
    try {
      const created = await options.client.session.create({ body: { title: `Hive task trace ${batchID}` }, query: { directory: options.directory } });
      const session = record(created.data);
      if (!session || typeof session.id !== 'string') throw new Error('ephemeral_session_create_failed');
      sessionID = session.id;
      options.ephemeralSessionIDs.add(sessionID);
      const body: RecordValue = {
        agent: TASK_TRACE_SUMMARIZER_AGENT,
        parts: [{ type: 'text', text: stableJson({ batch_id: batchID, steps: batch }) }],
      };
      const model = modelRef(options.summarizer.model);
      if (model) body.model = model;
      const prompted = await options.client.session.prompt({ path: { id: sessionID }, query: { directory: options.directory }, body });
      if (prompted.error) throw new Error('summarizer_prompt_failed');
      const responseText = summaryResponseText(prompted);
      responseLimitExceeded = responseText.reason === 'summarizer_response_limit_exceeded';
      generated = responseText.text ? validateSummary(
        responseText.text,
        batchID,
        batch.map(({ step_id, reasoning_part_ids }) => ({ step_id, reasoning_part_ids })),
      ) : undefined;
    } catch {
      providerFailed = true;
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
    if (providerFailed) return { available: false, reason: 'summarizer_unavailable', summaries };
    if (responseLimitExceeded) return { available: false, reason: 'summarizer_response_limit_exceeded', summaries };
    if (!generated) return { available: false, reason: 'invalid_summary_output', summaries: [] };
    const cumulative = [...summaries, ...generated];
    if (Buffer.byteLength(stableJson(cumulative)) > MAX_RECOVERY_SUMMARY_BYTES) {
      return { available: false, reason: 'summary_output_too_large', summaries };
    }
    if (cleanupFailed) return { available: false, reason: 'ephemeral_cleanup_failed', summaries };
    summaries.push(...generated);
  }
  return { available: true, summaries };
}

function readContentField(part: RecordValue, field: string): unknown {
  if (field === 'text' && part.type === 'text') return part.text;
  if (field === 'patch' && part.type === 'patch') return part.patch ?? part.files ?? part;
  if (part.type !== 'tool') return undefined;
  const state = toolState(part);
  if (field === 'tool.input') return state.input;
  if (field === 'tool.output') return state.output;
  if (field === 'tool.error') return state.error;
  return undefined;
}

export function createTaskTraceTools(options: TaskTraceOptions) {
  return {
    hive_task_trace: tool({
      description: 'Inspect one directly delegated child without resuming or mutating it. Snapshot and audit exclude raw reasoning; recovery transiently sends plaintext reasoning to the configured model and returns only untrusted reasoning-derived interpretations.',
      args: {
        task_id: tool.schema.string().describe('Direct child OpenCode session ID returned by native task metadata.'),
        mode: tool.schema.enum(['snapshot', 'audit', 'recovery']).optional().describe('snapshot (default), deterministic audit, or stable-terminal untrusted reasoning-derived recovery interpretation.'),
      },
      async execute({ task_id, mode = 'snapshot' }, context) {
        const unavailable = JSON.stringify({ ok: false, reason: 'unavailable_or_unauthorized' });
        if (!(await authorizeDirectChild(options.client, options.directory, task_id, context.sessionID))) return unavailable;
        let messages: unknown[];
        try {
          const response = await options.client.session.messages({ path: { id: task_id }, query: { directory: options.directory } });
          const extracted = extractMessages(response);
          if (!extracted) return unavailable;
          messages = extracted;
        } catch {
          return unavailable;
        }
        let status: RecordValue | undefined;
        if (typeof options.client.session.status === 'function') {
          try {
            const response = await options.client.session.status!({ query: { directory: options.directory } });
            status = response.error === undefined ? parseSessionStatusMap(response.data) : undefined;
          } catch {
            status = undefined;
          }
        }
        const boundedTrace = boundedTaskTrace(messages, mode, task_id);
        const trace = boundedTrace.trace;
        const state = lifecycle(messages, status, task_id);
        const result: RecordValue = {
          ok: true,
          task_id,
          mode,
          lifecycle: state,
          bounded: true,
          incomplete: state.incomplete === true || boundedTrace.truncation.truncated,
          truncation: boundedTrace.truncation,
          ...trace,
        };
        if (mode === 'recovery') {
          result.recovery = boundedTrace.truncation.truncated
            ? { available: false, reason: 'trace_truncated' }
            : state.stable_terminal === true
              ? await summarizeRecovery(options, messages, trace.steps)
              : { available: false, reason: state.reason };
        }
        const serialized = JSON.stringify(result);
        if (Buffer.byteLength(serialized, 'utf8') <= TASK_TRACE_RESULT_BYTE_LIMIT) return serialized;
        return JSON.stringify({
          ok: false,
          reason: 'result_size_limit',
          mode,
          bounded: true,
          incomplete: true,
          limits: { max_bytes: TASK_TRACE_RESULT_BYTE_LIMIT },
        });
      },
    }),
    hive_task_trace_content: tool({
      description: 'Re-read one authorized source-backed non-reasoning task trace field by content ID; raw reasoning is never addressable.',
      args: { content_id: tool.schema.string().describe('Opaque source locator returned by hive_task_trace.') },
      async execute({ content_id }, context) {
        const locator = decodeLocator(content_id);
        if (!locator) return JSON.stringify({ ok: false, reason: 'invalid_content_id' });
        if (!(await authorizeDirectChild(options.client, options.directory, locator.sessionID, context.sessionID))) {
          return JSON.stringify({ ok: false, reason: 'unavailable_or_unauthorized' });
        }
        try {
          const response = await options.client.session.messages({ path: { id: locator.sessionID }, query: { directory: options.directory } });
          const messages = extractMessages(response);
          const message = messages?.map(record).find((entry) => record(entry?.info)?.id === locator.messageID);
          if (locator.field === 'lifecycle.error' && locator.partID === '@message-error') {
            const value = record(message?.info)?.error;
            if (value === undefined) throw new Error('missing');
            const content = fieldText(value);
            if (Buffer.byteLength(content) !== locator.bytes || sha256(content) !== locator.sha256) throw new Error('stale');
            return JSON.stringify({ ok: true, content: value, bytes: locator.bytes, sha256: locator.sha256 });
          }
          const parts = Array.isArray(message?.parts) ? message.parts : [];
          const part = parts.map(record).find((entry) => entry?.id === locator.partID);
          if (!part) throw new Error('missing');
          const value = readContentField(part, locator.field);
          if (value === undefined) throw new Error('missing');
          const content = fieldText(value);
          if (Buffer.byteLength(content) !== locator.bytes || sha256(content) !== locator.sha256) throw new Error('stale');
          return JSON.stringify({ ok: true, content: value, bytes: locator.bytes, sha256: locator.sha256 });
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
