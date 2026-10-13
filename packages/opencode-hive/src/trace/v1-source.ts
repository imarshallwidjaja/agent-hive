import { isAbsolute } from 'node:path';
import type { TaskTraceSummarizerConfig } from 'hive-core';
import { normalizeReply } from '../task-trace-contract.js';
import { cancellationReason, digest, modelRef, record, recordedChild, stableJson } from './engine.js';
import {
  TASK_TRACE_SUMMARIZER_AGENT,
  type RecordedChild,
  type RuntimeStatus,
  type SourceMessage,
  type SourcePart,
  type SourceSnapshot,
  type SummarizerHost,
  type TraceSource,
  type TraceTarget,
} from './types.js';

/**
 * OpenCode v1 trace access through the v1 SDK client: `{ info, parts }` messages from session.messages, the
 * per-directory status map, and ephemeral summarizer sessions driven through create/prompt/abort/delete.
 */

type RecordValue = Record<string, unknown>;
type Response = Promise<{ data?: unknown; error?: unknown }>;

export interface TaskTraceClient {
  config: {
    providers(input: unknown): Response;
  };
  session: {
    get(input: unknown): Response;
    messages(input: unknown): Response;
    status?: (input: unknown) => Response;
    create(input: unknown): Response;
    prompt(input: unknown): Response;
    abort(input: unknown): Response;
    delete(input: unknown): Response;
  };
}

interface V1Target extends TraceTarget {
  /** Runtime placement from the target's own record; undefined when missing or invalid. */
  directory: string | undefined;
}

interface ResolvedTargetSession {
  relationship: TraceTarget['relationship'];
  // Observed parent; undefined for a root session. Freshness compares it exactly, because two
  // different foreign parents share the other_session relationship.
  parentID: string | undefined;
  directory: string | undefined;
}

async function resolveTargetSession(
  client: Pick<TaskTraceClient, 'session'>,
  directory: string,
  taskID: string,
  callerID: string,
  signal?: AbortSignal,
): Promise<ResolvedTargetSession | undefined> {
  try {
    const response = await client.session.get({ path: { id: taskID }, query: { directory }, ...(signal ? { signal } : {}) });
    const target = response.error === undefined ? record(response.data) : undefined;
    const parentID = typeof target?.parentID === 'string' ? target.parentID : undefined;
    if (target?.id !== taskID || (target.parentID !== undefined && parentID === undefined)) return undefined;
    return {
      relationship: taskID === callerID
        ? 'self'
        : parentID === callerID ? 'direct_child' : 'other_session',
      parentID,
      directory: typeof target.directory === 'string' && isAbsolute(target.directory) ? target.directory : undefined,
    };
  } catch {
    if (signal?.aborted) throw cancellationReason(signal);
    return undefined;
  }
}

// Fresh runtime check that a recorded child is, right now, a direct child of parentID. Lookup
// errors, a mismatched ID, and a malformed parent all fail closed.
export async function isDirectChildSession(
  client: Pick<TaskTraceClient, 'session'>,
  directory: string,
  childID: string,
  parentID: string,
): Promise<boolean> {
  return (await resolveTargetSession(client, directory, childID, parentID))?.relationship === 'direct_child';
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

// A native task call records its child in state.metadata; part.metadata can carry the same key
// beside provider metadata. Every present value must be one valid ID, otherwise none is projected.
export function recordedChildSession(part: RecordValue): RecordedChild {
  if (part.type !== 'tool' || part.tool !== 'task') return { recorded: [] };
  return recordedChild([record(record(part.state)?.metadata), record(part.metadata)]
    .filter((metadata): metadata is RecordValue => metadata !== undefined && 'sessionId' in metadata)
    .map((metadata) => metadata.sessionId));
}

function tokenCount(part: RecordValue): number | undefined {
  if (typeof part.tokens === 'number' && Number.isFinite(part.tokens) && part.tokens >= 0) return part.tokens;
  const tokens = record(part.tokens);
  if (!tokens) return undefined;
  const values = Object.values(tokens).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
}

function sourcePart(part: RecordValue, index: number): SourcePart {
  const type = typeof part.type === 'string' ? part.type : undefined;
  if (type === 'step-start' || type === 'step-finish') return { kind: 'step', boundary: type === 'step-start' ? 'start' : 'finish' };
  if (type === 'reasoning') {
    const tokens = tokenCount(part);
    return {
      kind: 'reasoning',
      ...(typeof part.text === 'string' ? { plaintext: part.text } : {}),
      ...(tokens === undefined ? {} : { tokens }),
    };
  }
  if (type === 'text' && typeof part.text === 'string') return { kind: 'text', index, id: part.id, text: part.text, synthetic: part.synthetic === true };
  if (type === 'tool') {
    const state = record(part.state) ?? {};
    const status = typeof state.status === 'string' ? state.status : 'unknown';
    return {
      kind: 'tool',
      index,
      id: part.id,
      name: typeof part.tool === 'string' ? part.tool : typeof part.name === 'string' ? part.name : 'unknown',
      status,
      unresolved: status === 'pending' || status === 'running',
      callID: typeof part.callID === 'string' ? part.callID : undefined,
      title: typeof state.title === 'string' ? state.title : undefined,
      compacted: typeof record(state.time)?.compacted === 'number',
      input: state.input,
      output: state.output,
      error: state.error,
      child: recordedChildSession(part),
    };
  }
  if (type === 'retry') return { kind: 'retry', index, id: part.id, error: part.error };
  if (type === 'patch') return { kind: 'patch', index, id: part.id, ...(Array.isArray(part.files) ? { files: part.files } : {}) };
  if (type === 'compaction' || type === 'summary') return { kind: 'compaction', index, id: part.id };
  return { kind: 'unsupported', index, id: part.id, type: type ?? 'unknown' };
}

/** Maps v1 `{ info, parts }` records one to one; the digest covers the raw records. */
export function v1Snapshot(messages: unknown[]): SourceSnapshot {
  return {
    messages: messages.map((rawMessage): SourceMessage => {
      const message = record(rawMessage) ?? {};
      const info = record(message.info) ?? {};
      const parts = Array.isArray(message.parts) ? message.parts.map((part) => record(part) ?? {}) : [];
      return {
        id: info.id,
        role: typeof info.role === 'string' ? info.role : undefined,
        closed: record(info.time)?.completed !== undefined || info.error !== undefined,
        summary: info.summary === true,
        ...(info.error === undefined ? {} : { error: info.error }),
        parts: parts.map(sourcePart),
      };
    }),
    digest: digest(stableJson(messages)),
  };
}

export function createV1TraceSource(client: TaskTraceClient, directory: string): TraceSource<V1Target> {
  const toTarget = (resolved: ResolvedTargetSession): V1Target => ({
    relationship: resolved.relationship,
    placed: resolved.directory !== undefined,
    freshness: JSON.stringify([resolved.parentID ?? null, resolved.directory ?? null]),
    directory: resolved.directory,
  });
  return {
    async resolveTarget(taskID, callerID, signal) {
      const resolved = await resolveTargetSession(client, directory, taskID, callerID, signal);
      return resolved ? toTarget(resolved) : { unavailable: {} };
    },
    // Source reads follow the target's placement; a target without one is read where it was resolved.
    async readSource(taskID, target, signal) {
      try {
        const response = await client.session.messages({
          path: { id: taskID },
          query: { directory: target.directory ?? directory },
          ...(signal ? { signal } : {}),
        });
        return response.error === undefined && Array.isArray(response.data) ? v1Snapshot(response.data) : { unavailable: {} };
      } catch {
        if (signal?.aborted) throw cancellationReason(signal);
        return { unavailable: {} };
      }
    },
    // Status is per runtime instance, so it is read only where the target itself is placed.
    async readRuntime(taskID, target, signal): Promise<RuntimeStatus | undefined> {
      if (target.directory === undefined || typeof client.session.status !== 'function') return undefined;
      try {
        const response = await client.session.status({
          query: { directory: target.directory },
          ...(signal ? { signal } : {}),
        });
        const status = response.error === undefined ? parseSessionStatusMap(response.data) : undefined;
        if (status === undefined) return undefined;
        const entry = record(status[taskID]);
        return entry?.type === 'busy' || entry?.type === 'retry' ? entry.type : 'idle';
      } catch {
        if (signal?.aborted) throw cancellationReason(signal);
        return undefined;
      }
    },
    isDirectChild: (childID, parentID) => isDirectChildSession(client, directory, childID, parentID),
  };
}

/** Ephemeral summarizer sessions in the v1 server: a hidden deny-all agent prompted with the stage contract. */
export function createV1Summarizer(input: {
  client: TaskTraceClient;
  directory: string;
  config: TaskTraceSummarizerConfig;
  ephemeralSessionIDs: Set<string>;
}): SummarizerHost {
  const { client, directory, config } = input;
  const query = { directory };
  return {
    config,
    ephemeralSessionIDs: input.ephemeralSessionIDs,
    async modelMetadata(model, signal) {
      // A variant-only configuration is sent with the prompt and the server applies it to whatever model it chooses.
      if (!model) return undefined;
      const response = await client.config.providers({ query, signal });
      const data = record(response.data);
      if (response.error !== undefined || !data || !Array.isArray(data.providers)) return undefined;
      const provider = data.providers.map(record).find((entry) => entry?.id === model.providerID);
      const selected = record(record(provider?.models)?.[model.modelID]);
      if (!selected) return undefined;
      const variants = record(selected.variants);
      return { limit: selected.limit, ...(variants ? { variants: Object.keys(variants) } : {}) };
    },
    async create(title, signal) {
      const created = await client.session.create({ body: { title }, query, signal });
      const session = record(created.data);
      if (!session || typeof session.id !== 'string') throw new Error('create failed');
      return session.id;
    },
    async generate(sessionID, stage, signal) {
      const body: RecordValue = {
        agent: TASK_TRACE_SUMMARIZER_AGENT,
        system: stage.system,
        parts: [{ type: 'text', text: stableJson(stage.request) }],
      };
      const model = modelRef(config.model);
      if (model) body.model = model;
      if (config.variant) body.variant = config.variant;
      return normalizeReply(await client.session.prompt({ path: { id: sessionID }, query, body, signal }));
    },
    async abort(sessionID, signal) {
      return (await client.session.abort({ path: { id: sessionID }, query, signal })).error === undefined;
    },
    async remove(sessionID, signal) {
      const deleted = await client.session.delete({ path: { id: sessionID }, query, signal });
      return deleted.error === undefined && deleted.data === true;
    },
  };
}
