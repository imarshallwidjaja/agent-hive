import { Cause, Effect, Exit } from 'effect';
import type { Scope } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import { SessionID } from '@opencode/schema/session-id';
import type { SessionGenerate } from '@opencode/plugin/effect/session';
import type { TaskTraceSummarizerConfig } from 'hive-core';
import type { HiveInvocation } from '../runtime/hive-services.js';
import type { HiveOperation } from '../runtime/hive-tools.js';
import { generatedReply } from '../task-trace-contract.js';
import {
  cancellationReason,
  createTraceHandlers,
  digest,
  record,
  recordedChild,
  stableJson,
  TRACE_TOOL_DEFINITIONS,
  type TraceContentInput,
  type TraceInput,
} from '../trace/engine.js';
import {
  TASK_TRACE_SUMMARIZER_AGENT,
  TASK_TRACE_SUMMARIZER_PROMPT,
  type RuntimeStatus,
  type SourceMessage,
  type SourcePart,
  type SourceSnapshot,
  type SummarizerHost,
  type TraceSource,
  type TraceTarget,
} from '../trace/types.js';
import { ReadAccessError, type ReadAccessErrorCode, type VerifiedReadAccess } from './client.js';
import type { V2Catalog } from './registration.js';
import { toModelRef } from './registration.js';

/**
 * OpenCode v2 evidence: `hive_task_trace` and `hive_task_trace_content` over the shared trace engine.
 *
 * History comes from the verified public read client (Task 5's `readAccess`), page by page through the complete
 * `message.list` timeline in ascending order; the active-context view and filtered exports are not used, because
 * they omit or rewrite recorded history. Authorization uses `checkTarget` with the caller's real session ID and reads
 * the target's parent and location for freshness. Summarization runs in-process through the public plugin session
 * API: an ephemeral session for a hidden deny-all agent, one `session.generate` per stage, and `session.remove`.
 * Nothing here writes Hive state; the two tools register through the catalog registrar, which owns their Code Mode
 * flags (trace false, trace_content per transport) and the role/child guard.
 */

type RecordValue = Record<string, unknown>;

const PAGE_LIMIT = 200;
// Bounds a history read at 200 000 messages; a longer or non-terminating timeline reads as unavailable.
const MAX_PAGES = 1_000;
// Messages appended while paging are followed this many times before the read gives up as unstable.
const MAX_TAIL_FOLLOWS = 3;
// Read-access failures that describe this plugin's connection or the caller, never the target, so they are safe to name.
const BINDING_CODES: ReadonlySet<ReadAccessErrorCode> = new Set([
  'not_configured', 'unauthorized', 'unreachable', 'wrong_location', 'wrong_instance', 'caller_unavailable', 'caller_displaced',
]);
const DENY_ALL = [{ action: '*', resource: '*', effect: 'deny' as const }];
// A removal that finds no such session has the outcome cleanup wants: the session is gone.
const SESSION_ABSENT_TAGS: ReadonlySet<unknown> = new Set(['Session.NotFoundError', 'SessionNotFoundError']);

interface V2Target extends TraceTarget {
  report: { placement: 'this-location' | 'other-location' };
}

function unavailableFrom(error: unknown) {
  return { unavailable: error instanceof ReadAccessError && BINDING_CODES.has(error.code) ? { read_access: error.code } : {} };
}

/** A subagent call records its child as `sessionID` in the tool state's metadata. */
function subagentChild(name: string, state: RecordValue) {
  const metadata = record(state.metadata);
  return recordedChild(name === 'subagent' && metadata && 'sessionID' in metadata ? [metadata.sessionID] : []);
}

/**
 * Tool output content without media: text stays text (a single text item is the text itself); a file keeps its
 * MIME type, name and non-inline URI, and an inline `data:` URI is replaced by its byte count.
 */
function toolOutput(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const items = content.map((raw) => {
    const item = record(raw);
    if (item?.type === 'text' && typeof item.text === 'string') return { type: 'text', text: item.text };
    if (item?.type !== 'file') return { type: typeof item?.type === 'string' ? item.type : 'unknown' };
    const uri = typeof item.uri === 'string' ? item.uri : undefined;
    const inline = uri?.startsWith('data:') === true;
    return {
      type: 'file',
      ...(typeof item.mime === 'string' ? { mime: item.mime } : {}),
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(uri !== undefined && !inline ? { uri } : {}),
      ...(inline ? { inline_bytes: Buffer.byteLength(uri!) } : {}),
    };
  });
  return items.length === 1 && items[0].type === 'text' ? items[0].text : items;
}

function contentPart(raw: unknown, index: number): SourcePart {
  const item = record(raw) ?? {};
  if (item.type === 'text' && typeof item.text === 'string') return { kind: 'text', index, text: item.text, synthetic: false };
  // Reasoning text is counted, never shown. Encrypted reasoning arrives as empty text plus provider state: opaque.
  if (item.type === 'reasoning') return { kind: 'reasoning', ...(typeof item.text === 'string' && item.text.length > 0 ? { plaintext: item.text } : {}) };
  if (item.type === 'tool') {
    const state = record(item.state) ?? {};
    const status = typeof state.status === 'string' ? state.status : 'unknown';
    const name = typeof item.name === 'string' ? item.name : 'unknown';
    return {
      kind: 'tool',
      index,
      id: item.id,
      name,
      status,
      unresolved: status === 'streaming' || status === 'running',
      ...(typeof item.id === 'string' ? { callID: item.id } : {}),
      compacted: false,
      input: state.input,
      output: toolOutput(state.content),
      error: state.error,
      child: subagentChild(name, state),
    };
  }
  return { kind: 'unsupported', index, type: typeof item.type === 'string' ? item.type : 'unknown' };
}

/**
 * Maps the v2 message timeline. A v2 message is either one record (user, synthetic, compaction) or an assistant step
 * with content items; values recorded on the message itself carry index -1. Turn markers and agent, model and
 * location switches are structural records. Provider state, reasoning text, attachments and inline media never
 * enter a field; the digest covers every raw record read.
 */
export function v2Snapshot(raw: readonly unknown[]): SourceSnapshot {
  const messages: SourceMessage[] = [];
  let structuralRecords = 0;
  for (const entry of raw) {
    const message = record(entry) ?? {};
    const type = typeof message.type === 'string' ? message.type : 'unknown';
    const time = record(message.time);
    if (type === 'idle' || type === 'agent-switched' || type === 'model-switched' || type === 'location-switched') {
      structuralRecords += 1;
    } else if ((type === 'user' || type === 'synthetic') && typeof message.text === 'string') {
      messages.push({ id: message.id, role: 'user', closed: true, summary: false, parts: [{ kind: 'text', index: -1, text: message.text, synthetic: type === 'synthetic' }] });
    } else if (type === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : [];
      const parts = content.map(contentPart);
      const retry = record(message.retry);
      if (retry) parts.push({ kind: 'retry', index: -1, error: retry.error });
      const files = record(message.snapshot)?.files;
      if (Array.isArray(files) && files.length > 0) parts.push({ kind: 'patch', index: -1, files });
      messages.push({
        id: message.id,
        role: 'assistant',
        closed: time?.completed !== undefined || message.error !== undefined,
        summary: false,
        ...(message.error === undefined ? {} : { error: message.error }),
        parts,
      });
    } else if (type === 'compaction') {
      messages.push({
        id: message.id,
        role: 'assistant',
        closed: message.status !== 'running',
        summary: false,
        ...(message.error === undefined ? {} : { error: message.error }),
        parts: [{ kind: 'compaction', index: -1 }],
      });
    } else {
      messages.push({ id: message.id, closed: true, summary: false, parts: [{ kind: 'unsupported', index: -1, type }] });
    }
  }
  return { messages, digest: digest(stableJson(raw)), structuralRecords };
}

type Page = { data?: unknown; cursor?: { next?: string | null } };

/**
 * Reads the complete timeline: ascending pages until an empty page, then the newest message, which must be the last
 * one read. A newer message (appended while paging) is followed from the last cursor; a newest message already read
 * but not last, a repeated ID, or a timeline longer than the page bound means the read was torn and is unavailable.
 */
async function readTimeline(readAccess: VerifiedReadAccess, sessionID: string, signal?: AbortSignal): Promise<unknown[] | undefined> {
  const messages: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  const accept = (page: Page): boolean => {
    if (!Array.isArray(page.data)) return false;
    for (const message of page.data) {
      const id = record(message)?.id;
      if (typeof id !== 'string' || seen.has(id)) return false;
      seen.add(id);
      messages.push(message);
    }
    return true;
  };
  for (let follows = 0; follows <= MAX_TAIL_FOLLOWS; follows += 1) {
    while (true) {
      if (signal?.aborted) throw cancellationReason(signal);
      if ((pages += 1) > MAX_PAGES) return undefined;
      const page = await readAccess.messageList(cursor === undefined
        ? { sessionID, limit: PAGE_LIMIT, order: 'asc' }
        : { sessionID, limit: PAGE_LIMIT, cursor }, signal) as Page;
      if (!accept(page)) return undefined;
      if ((page.data as unknown[]).length === 0) break;
      const next = page.cursor?.next;
      if (typeof next !== 'string' || next === cursor) return undefined;
      cursor = next;
    }
    const newest = await readAccess.messageList({ sessionID, limit: 1, order: 'desc' }, signal) as Page;
    if (!Array.isArray(newest.data)) return undefined;
    const newestID = record(newest.data[0])?.id;
    if (newest.data.length === 0) return messages.length === 0 ? messages : undefined;
    if (typeof newestID !== 'string') return undefined;
    if (newestID === record(messages.at(-1))?.id) return messages;
    if (seen.has(newestID)) return undefined;
  }
  return undefined;
}

export function createV2TraceSource(readAccess: VerifiedReadAccess): TraceSource<V2Target> {
  return {
    async resolveTarget(taskID, callerID, signal) {
      try {
        const check = await readAccess.checkTarget({ callerID, targetID: taskID }, signal);
        const session = await readAccess.sessionGet(taskID, signal) as { parentID?: string; location?: { directory?: string } };
        return {
          relationship: check.relationship === 'self' ? 'self' : check.relationship === 'child' ? 'direct_child' : 'other_session',
          placed: true,
          // The checked relationship, placement and the exact parent and location must all hold after recovery.
          freshness: JSON.stringify([check.relationship, check.placement, session.parentID ?? null, session.location?.directory ?? null]),
          report: { placement: check.placement },
        };
      } catch (error) {
        if (signal?.aborted) throw cancellationReason(signal);
        return unavailableFrom(error);
      }
    },
    async readSource(taskID, _target, signal) {
      try {
        const timeline = await readTimeline(readAccess, taskID, signal);
        return timeline ? v2Snapshot(timeline) : { unavailable: {} };
      } catch (error) {
        if (signal?.aborted) throw cancellationReason(signal);
        return unavailableFrom(error);
      }
    },
    // The v2 server runs every location's sessions; its active map is the status of the target wherever it is placed.
    async readRuntime(taskID, _target, signal): Promise<RuntimeStatus | undefined> {
      try {
        const active = record(await readAccess.sessionActive(signal));
        if (!active || !Object.values(active).every((entry) => record(entry)?.type === 'running')) return undefined;
        return Object.hasOwn(active, taskID) ? 'busy' : 'idle';
      } catch {
        if (signal?.aborted) throw cancellationReason(signal);
        return undefined;
      }
    },
    async isDirectChild(childID, parentID, signal) {
      try {
        return (await readAccess.sessionGet(childID, signal) as { parentID?: string }).parentID === parentID;
      } catch {
        if (signal?.aborted) throw cancellationReason(signal);
        return false;
      }
    },
  };
}

const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve();
  else signal.addEventListener('abort', () => resolve(), { once: true });
});

type GenerationRequest = { system: string; observed?: { providerID?: unknown; modelID?: unknown; variant?: unknown } };

/**
 * The in-process summarizer. Each generation registers its stage contract for its own ephemeral session; the
 * `generate` hook adds that contract to the request's system prompt, applies the configured temperature and records
 * the model the host prepared the request with. Generation runs in a fiber the request signal interrupts, so there
 * is no separate abort step. The session carries the configured model and variant; a configuration with a variant and
 * no model applies the variant to the host's default model, because a v2 session takes its variant only as part of a
 * model reference. No Hive retry or model fallback is added; host-internal provider retries are not observed.
 */
export function createV2Summarizer(context: Pick<Plugin.Context, 'session' | 'model' | 'location'>, config: TaskTraceSummarizerConfig, ephemeralSessionIDs = new Set<string>()) {
  const pending = new Map<string, GenerationRequest>();
  const inFlightCreates = new Map<string, Promise<unknown>>();
  const run = <A, E>(effect: Effect.Effect<A, E>, signal: AbortSignal) => Effect.runPromiseExit(effect, { signal });
  const location = { directory: context.location.directory };
  const metadataOf = (model: { limit: unknown; variants: ReadonlyArray<{ id: string }> }) => ({ limit: model.limit, variants: model.variants.map((variant) => variant.id) });
  const defaultModel = async (signal: AbortSignal) => {
    const exit = await run(context.model.default({ location }), signal);
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
    return exit.value.data ?? undefined;
  };
  const host: SummarizerHost = {
    config,
    ephemeralSessionIDs,
    async modelMetadata(model, signal) {
      if (!model) {
        const selected = await defaultModel(signal);
        return selected ? metadataOf(selected) : undefined;
      }
      const exit = await run(context.model.list({ location }), signal);
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
      const selected = exit.value.data.find((entry) => entry.providerID === model.providerID && entry.id === model.modelID);
      return selected ? metadataOf(selected) : undefined;
    },
    // The host persists a session before it returns the ID, so an interruption in between would lose it. Naming the
    // session first, through create's public `id` input, lets cleanup address it whatever becomes of the create.
    allocateSessionID: () => SessionID.create(),
    async create(title, signal, id) {
      let model = toModelRef(config.model, config.variant);
      if (!model && config.variant) {
        const selected = await defaultModel(signal);
        if (!selected) throw new Error('The summarizer variant needs a model and the host has no default model.');
        model = { providerID: selected.providerID, id: selected.id, variant: config.variant };
      }
      const creating = run(context.session.create({
        ...(id === undefined ? {} : { id }),
        title,
        agent: TASK_TRACE_SUMMARIZER_AGENT,
        ...(model ? { model } : {}),
        permissions: DENY_ALL,
      } as never), signal);
      if (id !== undefined) {
        inFlightCreates.set(id, creating);
        void creating.finally(() => inFlightCreates.delete(id));
      }
      const exit = await creating;
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
      return exit.value.id;
    },
    async generate(sessionID, stage, signal) {
      const request: GenerationRequest = { system: stage.system };
      pending.set(sessionID, request);
      try {
        const exit = await run(context.session.generate({ sessionID: sessionID as never, prompt: stableJson(stage.request) }), signal);
        if (signal.aborted) throw signal.reason;
        if (Exit.isSuccess(exit)) return generatedReply({ text: exit.value.text, observed: request.observed });
        const failure = exit.cause.reasons.find(Cause.isFailReason);
        if (!failure) throw Cause.squash(exit.cause);
        return generatedReply({ observed: request.observed, error: failure.error });
      } finally {
        pending.delete(sessionID);
      }
    },
    async remove(sessionID, signal) {
      // A create that has not settled may still commit; removing first would miss it.
      const creating = inFlightCreates.get(sessionID);
      if (creating) await Promise.race([creating, aborted(signal)]);
      if (signal.aborted) return false;
      const exit = await run(context.session.remove({ sessionID: sessionID as never }), signal);
      if (Exit.isSuccess(exit)) return true;
      return exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && SESSION_ABSENT_TAGS.has((reason.error as { _tag?: unknown } | null)?._tag));
    },
  };
  const onGenerate = (event: SessionGenerate) => Effect.sync(() => {
    const request = pending.get(event.sessionID);
    if (!request) return;
    event.system.push({ type: 'text', text: request.system } as never);
    event.options.temperature = config.temperature ?? 0;
    request.observed = { providerID: event.model.providerID, modelID: event.model.id, variant: event.model.variant };
  });
  return { host, onGenerate };
}

/**
 * The two trace operations for the registrar. Both return the engine's reply text unchanged (`text` output), because
 * page budgets and `render` sizes describe that exact text. The registrar's invocation carries the signal that aborts
 * when the host interrupts the call; every authorization and history read, and a recovery's generation, stop with it.
 * Session cleanup keeps its own bounded deadlines.
 */
export function createV2TraceOperations(readAccess: VerifiedReadAccess, summarizer: SummarizerHost): Record<'hive_task_trace' | 'hive_task_trace_content', HiveOperation> {
  const handlers = createTraceHandlers(createV2TraceSource(readAccess), summarizer);
  const callerOf = (invocation: HiveInvocation) => {
    if (!invocation.sessionID) throw new Error('Hive trace reads need the calling session.');
    return invocation.sessionID;
  };
  const cancellationOf = (invocation: HiveInvocation) => {
    if (!invocation.signal) throw new Error('Hive trace reads need the caller cancellation signal.');
    return invocation.signal;
  };
  return {
    hive_task_trace: {
      ...TRACE_TOOL_DEFINITIONS.hive_task_trace,
      output: 'text',
      execute: (input: TraceInput, invocation: HiveInvocation) => handlers.trace(input, { sessionID: callerOf(invocation), abort: cancellationOf(invocation) }),
    },
    hive_task_trace_content: {
      ...TRACE_TOOL_DEFINITIONS.hive_task_trace_content,
      output: 'text',
      execute: (input: TraceContentInput, invocation: HiveInvocation) => handlers.content(input, { sessionID: callerOf(invocation), abort: cancellationOf(invocation) }),
    },
  };
}

/** Registers the hidden summarizer agent, its request hook and both trace tools for this activation. */
export function registerEvidence(context: Plugin.Context, catalog: V2Catalog): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const config = catalog.services.configService.get().taskTraceSummarizer ?? { temperature: 0 };
    const summarizer = createV2Summarizer(context, config);
    yield* context.agent.transform((editor) => {
      editor.update(TASK_TRACE_SUMMARIZER_AGENT, (agent) => {
        agent.mode = 'primary';
        agent.hidden = true;
        agent.system = TASK_TRACE_SUMMARIZER_PROMPT;
        agent.permissions.push(...DENY_ALL);
      });
    });
    yield* context.session.hook('generate', summarizer.onGenerate);
    yield* catalog.registrar.register(createV2TraceOperations(catalog.readAccess, summarizer.host));
  });
}
