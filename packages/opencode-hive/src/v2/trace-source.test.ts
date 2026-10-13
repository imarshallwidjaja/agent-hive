import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Effect, Exit, Fiber, Scope, Stream } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import type { TaskTraceSummarizerConfig } from 'hive-core';
import { Tool } from '@opencode/schema/tool';
import plugin from '../index.js';
import { TASK_TRACE_SUMMARIZER_AGENT, TASK_TRACE_SUMMARIZER_PROMPT } from '../trace/types.js';
import { ReadAccessError, type TargetCheck, type VerifiedReadAccess } from './client.js';
import { createHiveToolRegistrar } from './tools.js';
import { createV2Summarizer, createV2TraceOperations, createV2TraceSource, registerEvidence } from './trace-source.js';
import type { V2Catalog } from './registration.js';

// The v2 trace source owns its native mapping, complete-history paging, authorization and in-process summarizer.
// The shared engine contracts (cursors, refs, recovery rules) are owned by task-trace.test.ts; these tests drive
// them through the v2 source to show the same contracts hold over v2 records.

type Raw = Record<string, unknown>;
type SessionRecord = { id: string; parentID?: string; location: { directory: string } };

const HERE = '/repo';
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function user(id: string, text: string): Raw {
  return { id, type: 'user', text, files: [], agents: [], skills: [], time: { created: 1 } };
}

function assistant(id: string, content: Raw[], extra: Raw = {}): Raw {
  return { id, type: 'assistant', agent: 'forager-worker', model: { providerID: 'p', id: 'm' }, content, time: { created: 1, completed: 2 }, ...extra };
}

const encodeCursor = (id: string, order: string) => Buffer.from(JSON.stringify({ id, order, direction: 'next' })).toString('base64url');

/**
 * A read access with the server's paging semantics: the first page takes `order`, later pages only an opaque
 * cursor anchored at the last message read; `desc` reads newest first. Timelines may change between reads.
 */
function readAccessFor(input: {
  sessions: Record<string, Omit<SessionRecord, 'location'> & { directory?: string }>;
  timelines: Record<string, Raw[] | ((read: number) => Raw[])>;
  active?: Record<string, unknown>;
  failWith?: ReadAccessError;
}) {
  const calls: Array<{ method: string; input?: any }> = [];
  let listReads = 0;
  const session = (id: string): SessionRecord => {
    const found = input.sessions[id];
    if (!found) throw new ReadAccessError('target_unavailable', `no session ${id}`);
    return { id, ...(found.parentID ? { parentID: found.parentID } : {}), location: { directory: found.directory ?? HERE } };
  };
  const timeline = (id: string) => {
    const value = input.timelines[id] ?? [];
    return typeof value === 'function' ? value(listReads) : value;
  };
  const access: VerifiedReadAccess = {
    sessionActive: async () => {
      calls.push({ method: 'active' });
      if (input.failWith) throw input.failWith;
      return (input.active ?? {}) as never;
    },
    sessionGet: async (sessionID) => {
      calls.push({ method: 'get', input: sessionID });
      if (input.failWith) throw input.failWith;
      return session(sessionID) as never;
    },
    messageList: async (request: any) => {
      calls.push({ method: 'list', input: request });
      if (input.failWith) throw input.failWith;
      if (request.cursor !== undefined && request.order !== undefined) throw new Error('Cursor cannot be combined with order');
      listReads += 1;
      const all = timeline(request.sessionID);
      let order = request.order ?? 'desc';
      let rest = order === 'asc' ? all : [...all].reverse();
      if (request.cursor !== undefined) {
        const decoded = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'));
        order = decoded.order;
        const ordered = order === 'asc' ? all : [...all].reverse();
        const at = ordered.findIndex((message) => message.id === decoded.id);
        rest = at < 0 ? [] : ordered.slice(at + 1);
      }
      const data = rest.slice(0, request.limit ?? 50);
      return { data, cursor: { ...(data.length > 0 ? { next: encodeCursor(String(data.at(-1)!.id), order) } : {}) } } as never;
    },
    checkTarget: async ({ callerID, targetID }): Promise<TargetCheck> => {
      calls.push({ method: 'check', input: { callerID, targetID } });
      if (input.failWith) throw input.failWith;
      const caller = session(callerID);
      const target = session(targetID);
      const placement = target.location.directory === HERE ? 'this-location' : 'other-location';
      if (caller.location.directory !== HERE) throw new ReadAccessError('caller_displaced', 'caller moved');
      if (target.id === caller.id) return { relationship: 'self', placement };
      if (target.parentID === caller.id) return { relationship: 'child', placement };
      for (let parent = target.parentID; parent; parent = input.sessions[parent]?.parentID) {
        if (input.sessions[parent]?.parentID === caller.id) return { relationship: 'descendant', placement };
      }
      return { relationship: 'other', placement };
    },
  };
  return { access, calls };
}

/**
 * A plugin context whose `generate` runs the registered hook, then answers with `reply(request, draft)`. The tool and
 * hook transforms record what a plugin registers so a test can call the registered tool.
 */
function summarizerContext(options: {
  reply?: (request: any, draft: any) => Effect.Effect<{ text: string }, unknown>;
  remove?: (sessionID: string) => Effect.Effect<void, unknown>;
  create?: (input: any, call: number) => Effect.Effect<{ id: string }, unknown>;
  config?: TaskTraceSummarizerConfig;
  /** Models `model.list` returns; the default is one model `p/m` with a `high` variant. */
  models?: () => Effect.Effect<{ data: unknown[] }, unknown>;
  /** The model `model.default` returns, or null for a host without a default model. */
  defaultModel?: unknown;
} = {}) {
  const config = options.config ?? { model: 'p/m', variant: 'high', temperature: 0 };
  const created: any[] = [];
  const removed: string[] = [];
  const drafts: any[] = [];
  const tools = new Map<string, Tool.Info>();
  let hook: ((event: any) => Effect.Effect<void>) | undefined;
  const registration = { dispose: Effect.void };
  const context = {
    location: { directory: HERE },
    model: {
      list: () => options.models?.() ?? Effect.succeed({ location: { directory: HERE }, data: [{ providerID: 'p', id: 'm', limit: { context: 100_000, output: 1_000 }, variants: [{ id: 'high' }] }] }),
      default: () => Effect.succeed({ location: { directory: HERE }, data: options.defaultModel ?? null }),
    },
    agent: { transform: () => Effect.succeed(registration) },
    tool: { transform: (callback: (editor: { add: (info: Tool.Info) => void }) => void) => Effect.sync(() => { callback({ add: (info) => tools.set(info.name, info) }); return registration; }) },
    session: {
      hook: (name: string, callback: (event: any) => Effect.Effect<void>) => Effect.sync(() => { if (name === 'generate') hook = callback; return registration; }),
      create: (input: any) => Effect.suspend(() => {
        created.push(input);
        return options.create?.(input, created.length) ?? Effect.succeed({ id: input.id ?? `ses_summary_${created.length}` });
      }),
      generate: ({ sessionID, prompt }: { sessionID: string; prompt: string }) => Effect.gen(function* () {
        // Like the host, the request runs on the session's own model, else on the host default (no variant).
        const sessionModel = created.find((input) => input.id === sessionID)?.model;
        const hostDefault = options.defaultModel as { providerID: string; id: string } | undefined;
        const model = sessionModel ?? (hostDefault ? { providerID: hostDefault.providerID, id: hostDefault.id } : { providerID: 'p', id: 'm' });
        const draft = { sessionID, agent: TASK_TRACE_SUMMARIZER_AGENT, model, system: [{ type: 'text', text: TASK_TRACE_SUMMARIZER_PROMPT }], messages: [], options: {}, tools: {} };
        yield* hook!(draft);
        drafts.push(draft);
        const request = JSON.parse(prompt);
        return yield* (options.reply ?? semanticReply)(request, draft);
      }),
      remove: ({ sessionID }: { sessionID: string }) => Effect.suspend(() => {
        removed.push(sessionID);
        return options.remove?.(sessionID) ?? Effect.void;
      }),
    },
  } as unknown as Plugin.Context;
  const summarizer = createV2Summarizer(context, config);
  hook = summarizer.onGenerate as never;
  return { context, config, summarizer, tools, created, removed, drafts };
}

function semanticReply(request: any): Effect.Effect<{ text: string }> {
  if (request.kind === 'map') {
    const steps = [...new Set(request.fragments.map((fragment: any) => fragment.step))] as number[];
    return Effect.succeed({
      text: JSON.stringify({
        kind: 'map',
        range: request.range,
        cards: steps.map((step) => {
          const source = request.fragments.find((fragment: any) => fragment.step === step).source;
          const empty = source.observed === undefined && source.reasoning === undefined;
          return { step, intent: empty ? null : 'Do the task.', actions: empty ? [] : ['Worked.'], findings: [], outcome: empty ? null : 'Step done.', unresolved: [], basis: source.basis };
        }),
      }),
    });
  }
  const steps = Array.from({ length: request.step_count }, (_, index) => index + 1);
  return Effect.succeed({
    text: JSON.stringify({
      kind: 'reduce',
      semantic: {
        overview: 'The child completed the work.',
        phases: steps.map((step) => ({ range: [step, step], title: `Step ${step}`, intent: null, actions: [], findings: [], outcome: null, unresolved: [], source_steps: [step] })),
        completed: [{ claim: 'Finished.', source_steps: request.completion_steps }],
        unfinished: [],
        safest_next_action: { action: 'review_completed_work', context: null, source_steps: steps },
      },
    }),
  });
}

const parse = (text: string) => JSON.parse(text);

function operations(access: VerifiedReadAccess, summarizer = summarizerContext().summarizer.host) {
  const ops = createV2TraceOperations(access, summarizer);
  return {
    trace: async (args: Raw, sessionID = 'ses_parent') => parse(await ops.hive_task_trace.execute(args, { sessionID, signal: new AbortController().signal }) as string),
    content: async (args: Raw, sessionID = 'ses_parent') => parse(await ops.hive_task_trace_content.execute(args, { sessionID, signal: new AbortController().signal }) as string),
  };
}

const FAMILY = { ses_parent: {}, ses_child: { parentID: 'ses_parent' } };

/** The trace tool as the production registrar hands it to the host, over the given read access and plugin API. */
async function registered(access: VerifiedReadAccess, setup: ReturnType<typeof summarizerContext>, name: 'hive_task_trace' | 'hive_task_trace_content' = 'hive_task_trace') {
  const catalog = {
    services: { configService: { get: () => ({ taskTraceSummarizer: setup.config }) } },
    readAccess: access,
    registrar: createHiveToolRegistrar({ context: setup.context, readTransport: 'direct', guard: () => Effect.void }),
  } as unknown as V2Catalog;
  await Effect.runPromise(registerEvidence(setup.context, catalog).pipe(Scope.provide(Effect.runSync(Scope.make()))));
  const tool = setup.tools.get(name)!;
  return (args: Raw) => (tool.execute as any)(args, { sessionID: 'ses_parent', agent: 'hive-helper', messageID: 'm', id: 'c', progress: () => Effect.void }) as Effect.Effect<{ content: string }, Tool.Error>;
}

describe('v2 trace source mapping', () => {
  it('indexes v2 records in source order without reasoning, provider state, attachments or inline media', async () => {
    const timeline = [
      { id: 'msg_a0', type: 'agent-switched', agent: 'forager-worker', time: { created: 1 } },
      { ...user('msg_u1', 'Implement the task.'), files: [{ uri: 'data:text/plain;base64,QVRUQUNI', mime: 'text/plain' }] },
      assistant('msg_a1', [
        { type: 'reasoning', text: 'REASONING-SECRET', state: { signature: 'PROVIDER-SECRET' } },
        { type: 'reasoning', text: '', state: { encrypted: 'ENCRYPTED-SECRET' } },
        { type: 'text', text: 'Calling a child.', state: { cache: 'PROVIDER-SECRET' } },
        {
          type: 'tool', id: 'call_1', name: 'subagent', providerState: { opaque: 'PROVIDER-SECRET' },
          state: { status: 'completed', input: { description: 'child work' }, content: [{ type: 'text', text: 'child said done' }], metadata: { sessionID: 'ses_grandchild', status: 'completed' } },
          time: { created: 1, completed: 2 },
        },
        {
          type: 'tool', id: 'call_2', name: 'read',
          state: { status: 'completed', input: { filePath: 'a.png' }, content: [{ type: 'text', text: 'image' }, { type: 'file', uri: 'data:image/png;base64,SU1BR0VTRUNSRVQ=', mime: 'image/png', name: 'a.png' }] },
          time: { created: 1 },
        },
      ], { providerState: { anything: 'PROVIDER-SECRET' }, snapshot: { files: ['src/a.ts'] } }),
      { id: 'msg_s1', type: 'system', text: 'instruction update', time: { created: 1 } },
      { id: 'msg_i1', type: 'idle', outcome: 'succeeded', time: { created: 1 } },
    ];
    const { access } = readAccessFor({ sessions: { ...FAMILY, ses_grandchild: { parentID: 'ses_child' } }, timelines: { ses_child: timeline } });
    const page = await operations(access).trace({ task_id: 'ses_child' });
    const text = JSON.stringify(page);
    for (const secret of ['REASONING-SECRET', 'PROVIDER-SECRET', 'ENCRYPTED-SECRET', 'SU1BR0VTRUNSRVQ', 'QVRUQUNI']) expect(text).not.toContain(secret);

    expect(page.target).toEqual({ id: 'ses_child', relationship: 'direct_child', placement: 'this-location' });
    expect(page.source).toMatchObject({ messages: 3, events: 6, reasoning_parts: 2, structural_parts: 2 });
    expect(page.reasoning).toMatchObject({ availability: 'mixed', plaintext_parts: 1, opaque_parts: 1 });
    expect(page.events.map((event: Raw) => [event.kind, event.actor, event.tool ?? event.type ?? null])).toEqual([
      ['text', 'user', null],
      ['text', 'assistant', null],
      ['tool', 'assistant', 'subagent'],
      ['tool', 'assistant', 'read'],
      ['patch', 'assistant', null],
      ['unsupported', 'unknown', 'system'],
    ]);
    // Message-level and tool-call values carry native identity; content text has no native part ID.
    expect(page.events[0].identity).toBeUndefined();
    expect(page.events[1].identity).toBe('positional');
    expect(page.events[2].identity).toBeUndefined();
    expect(page.events[2].child_session_id).toBe('ses_grandchild');
    expect(page.events[2].output).toBe('child said done');
    expect(page.events[3].output).toEqual([{ type: 'text', text: 'image' }, { type: 'file', mime: 'image/png', name: 'a.png', inline_bytes: 38 }]);
    expect(page.context.assignment.text).toBe('Implement the task.');
    expect(page.lifecycle).toMatchObject({ state: 'uncertain', reason: 'latest_message_not_assistant', runtime: 'idle' });
  });

  it('discloses a recorded child only when the runtime confirms the traced session is its parent', async () => {
    const call = (child: string) => ({ type: 'tool', id: `call_${child}`, name: 'subagent', state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'ok' }], metadata: { sessionID: child } }, time: { created: 1 } });
    const { access } = readAccessFor({
      sessions: { ...FAMILY, ses_grandchild: { parentID: 'ses_child' }, ses_foreign: { parentID: 'ses_other' }, ses_other: {} },
      timelines: { ses_child: [user('msg_u1', 'go'), assistant('msg_a1', [call('ses_grandchild'), call('ses_foreign')])] },
    });
    const page = await operations(access).trace({ task_id: 'ses_child' });
    expect(page.events.filter((event: Raw) => event.kind === 'tool').map((event: Raw) => event.child_session_id ?? null)).toEqual(['ses_grandchild', null]);
  });

  it('classifies relationships and placement from checkTarget and reports binding failures without target detail', async () => {
    const sessions = { ...FAMILY, ses_grandchild: { parentID: 'ses_child' }, ses_away: { parentID: 'ses_parent', directory: '/elsewhere' } };
    const timelines = { ses_parent: [user('msg_p', 'hi')], ses_grandchild: [user('msg_g', 'hi')], ses_away: [user('msg_w', 'hi')] };
    const { access } = readAccessFor({ sessions, timelines });
    const ops = operations(access);
    expect((await ops.trace({ task_id: 'ses_parent' })).target).toEqual({ id: 'ses_parent', relationship: 'self', placement: 'this-location' });
    expect((await ops.trace({ task_id: 'ses_grandchild' })).target).toEqual({ id: 'ses_grandchild', relationship: 'other_session', placement: 'this-location' });
    expect((await ops.trace({ task_id: 'ses_away' })).target).toEqual({ id: 'ses_away', relationship: 'direct_child', placement: 'other-location' });
    expect(await ops.trace({ task_id: 'ses_missing' })).toEqual({ ok: false, reason: 'unavailable_or_unauthorized' });

    const unconfigured = readAccessFor({ sessions, timelines, failWith: new ReadAccessError('not_configured', 'set server') });
    expect(await operations(unconfigured.access).trace({ task_id: 'ses_child' })).toEqual({ ok: false, reason: 'unavailable_or_unauthorized', read_access: 'not_configured' });
    expect(await operations(unconfigured.access).content({ task_id: 'ses_child', event: 'x' })).toEqual({ ok: false, reason: 'invalid_event' });
    const inconsistent = readAccessFor({ sessions, timelines, failWith: new ReadAccessError('inconsistent_lookup', 'secret detail') });
    expect(await operations(inconsistent.access).trace({ task_id: 'ses_child' })).toEqual({ ok: false, reason: 'unavailable_or_unauthorized' });
  });

  it('reports the runtime from the active map and keeps active sessions out of recovery', async () => {
    const timeline = [user('msg_u1', 'go'), assistant('msg_a1', [{ type: 'text', text: 'done' }])];
    const idle = readAccessFor({ sessions: FAMILY, timelines: { ses_child: timeline }, active: { ses_other: { type: 'running' } } });
    expect((await operations(idle.access).trace({ task_id: 'ses_child' })).lifecycle).toEqual({ state: 'terminal', terminal: true, reason: 'idle_and_closed', runtime: 'idle' });
    const busy = readAccessFor({ sessions: FAMILY, timelines: { ses_child: timeline }, active: { ses_child: { type: 'running' } } });
    expect((await operations(busy.access).trace({ task_id: 'ses_child' })).lifecycle).toMatchObject({ state: 'active', runtime: 'busy' });
    expect((await operations(busy.access).trace({ task_id: 'ses_child', recovery: true })).recovery.failures).toEqual([{ stage: 'eligibility', reasons: ['runtime_active'] }]);
    const malformed = readAccessFor({ sessions: FAMILY, timelines: { ses_child: timeline }, active: { ses_child: { type: 'other' } } });
    expect((await operations(malformed.access).trace({ task_id: 'ses_child' })).lifecycle).toMatchObject({ state: 'uncertain', reason: 'status_unavailable', runtime: 'unavailable' });
    const streaming = readAccessFor({ sessions: FAMILY, timelines: { ses_child: [user('msg_u1', 'go'), assistant('msg_a1', [{ type: 'tool', id: 'call_1', name: 'bash', state: { status: 'streaming', input: '{"comm' }, time: { created: 1 } }], { time: { created: 1 } })] } });
    expect((await operations(streaming.access).trace({ task_id: 'ses_child' })).lifecycle).toMatchObject({ state: 'uncertain', reason: 'tool_pending_or_running', unresolved_tools: { latest_message: 1, earlier_messages: 0 } });
  });
});

describe('v2 complete history reads', () => {
  const long = (count: number) => Array.from({ length: count }, (_, index) => user(`msg_${String(index).padStart(4, '0')}`, `message ${index}`));

  it('pages the whole timeline in ascending order, never combining a cursor with order, and confirms the newest message', async () => {
    const { access, calls } = readAccessFor({ sessions: FAMILY, timelines: { ses_child: long(450) } });
    const ops = operations(access);
    let page = await ops.trace({ task_id: 'ses_child' });
    expect(page.source.messages).toBe(450);
    const lists = calls.filter((call) => call.method === 'list').map((call) => call.input);
    expect(lists[0]).toEqual({ sessionID: 'ses_child', limit: 200, order: 'asc' });
    expect(lists.slice(1, 4).every((input) => input.cursor !== undefined && input.order === undefined)).toBe(true);
    expect(lists.at(-1)).toEqual({ sessionID: 'ses_child', limit: 1, order: 'desc' });
    // Every message is an event; pages follow coverage.next_cursor to the end in source order.
    const seen: number[] = [];
    for (let guard = 0; guard < 50; guard += 1) {
      seen.push(...page.events.map((event: Raw) => event.seq));
      if (page.coverage.complete) break;
      expect(page.coverage.next_cursor).toMatch(/^trace-cursor:v3:prefix:\d+:[A-Za-z0-9_-]{43}$/);
      page = await ops.trace({ task_id: 'ses_child', cursor: page.coverage.next_cursor });
    }
    expect(seen).toEqual(Array.from({ length: 450 }, (_, index) => index + 1));
  });

  it('follows messages appended while paging and rejects torn or repeating timelines', async () => {
    const base = long(5);
    const appended = readAccessFor({ sessions: FAMILY, timelines: { ses_child: (read) => read <= 2 ? base : [...base, user('msg_new', 'late')] } });
    expect((await operations(appended.access).trace({ task_id: 'ses_child' })).source.messages).toBe(6);

    const torn = readAccessFor({ sessions: FAMILY, timelines: { ses_child: (read) => read <= 2 ? base : base.slice(0, 3) } });
    expect(await operations(torn.access).trace({ task_id: 'ses_child' })).toEqual({ ok: false, reason: 'unavailable_or_unauthorized' });

    const repeated = readAccessFor({ sessions: FAMILY, timelines: { ses_child: [...base, base[0]] } });
    expect(await operations(repeated.access).trace({ task_id: 'ses_child' })).toEqual({ ok: false, reason: 'unavailable_or_unauthorized' });
  });

  it('keeps positional cursors and refs bound to the unchanged source, and native ones across appends', async () => {
    const turn = [user('msg_u1', 'go'), assistant('msg_a1', Array.from({ length: 80 }, (_, index) => ({ type: 'text', text: `${'x'.repeat(400)} ${index}` })))];
    let current = turn;
    const { access } = readAccessFor({ sessions: FAMILY, timelines: { ses_child: () => current } });
    const ops = operations(access);
    const first = await ops.trace({ task_id: 'ses_child' });
    expect(first.coverage.next_cursor).toMatch(/^trace-cursor:v3:source:/);
    const positional = first.events.find((event: Raw) => event.identity === 'positional');
    const native = first.events.find((event: Raw) => event.kind === 'text' && event.actor === 'user');
    expect((await ops.content({ task_id: 'ses_child', event: positional.ref })).event.fields.text.state).toBe('value');

    current = [...turn, user('msg_u2', 'more')];
    expect(await ops.trace({ task_id: 'ses_child', cursor: first.coverage.next_cursor })).toEqual({ ok: false, reason: 'cursor_stale' });
    expect(await ops.content({ task_id: 'ses_child', event: positional.ref })).toEqual({ ok: false, reason: 'source_changed' });
    const reread = await ops.content({ task_id: 'ses_child', event: native.ref, field: 'text' });
    expect(reread).toMatchObject({ ok: true, version: 3, field: 'text', content: 'go', next_offset: null });
  });
});

describe('v2 in-process summarizer', () => {
  const finished = [user('msg_u1', 'Implement the task.'), assistant('msg_a1', [{ type: 'text', text: 'Implemented and verified.' }])];

  it('summarizes in an ephemeral deny-all session, applies the contract and temperature, reports the observed model and removes the session', async () => {
    const { access } = readAccessFor({ sessions: FAMILY, timelines: { ses_child: finished } });
    const setup = summarizerContext();
    const result = await operations(access, setup.summarizer.host).trace({ task_id: 'ses_child', recovery: true });
    expect(result.recovery).toMatchObject({
      status: 'complete',
      scope: 'closed_turn',
      failures: [],
      model: { requested: { model: 'p/m', variant: 'high' }, observed: { model: 'p/m', variant: 'high' } },
      cards_source: 'generated',
      phases_source: 'generated',
    });
    expect(result.semantic).toMatchObject({ provenance: 'summarizer_interpretation', untrusted: true, safest_next_action: { action: 'review_completed_work' } });
    expect(setup.created).toHaveLength(2);
    for (const input of setup.created) {
      expect(input).toMatchObject({ agent: TASK_TRACE_SUMMARIZER_AGENT, model: { providerID: 'p', id: 'm', variant: 'high' }, permissions: [{ action: '*', resource: '*', effect: 'deny' }] });
    }
    expect(setup.drafts.map((draft) => draft.system.at(-1).text.includes('Stage: map') || draft.system.at(-1).text.includes('Stage: reduce'))).toEqual([true, true]);
    expect(setup.drafts.every((draft) => draft.options.temperature === 0)).toBe(true);
    expect(setup.removed).toEqual(setup.created.map((input) => input.id));
    expect(setup.summarizer.host.ephemeralSessionIDs.size).toBe(0);
  });

  it('keeps provider failures value-free, falls back to inspect, and reports an unconfirmed removal', async () => {
    const { access } = readAccessFor({ sessions: FAMILY, timelines: { ses_child: finished } });
    const setup = summarizerContext({
      reply: () => Effect.fail({ name: 'APIError', message: 'secret provider body', data: { statusCode: 429 } }),
      remove: () => Effect.fail(new Error('remove failed')),
    });
    const result = await operations(access, setup.summarizer.host).trace({ task_id: 'ses_child', recovery: true });
    expect(JSON.stringify(result)).not.toContain('secret provider body');
    expect(result.recovery.status).toBe('partial');
    expect(result.recovery.failures[0]).toEqual({
      stage: 'map',
      range: [1, 2],
      reasons: ['summarizer_unavailable', 'ephemeral_cleanup_failed'],
      diagnostics: [{ code: 'provider_error', error: { name: 'APIError', status: 429 }, text_parts: 0, bytes: 0 }],
    });
    expect(result.recovery.cards_source).toBe('fallback');
    expect(result.semantic.safest_next_action.action).toBe('inspect');
    expect([...setup.summarizer.host.ephemeralSessionIDs]).toEqual([setup.created[0].id]);
  });

  for (const fails of [false, true]) {
    it(`rejects an allocated target collision before a native-like create can ${fails ? 'fail' : 'return the existing target'}`, async () => {
      const target = { id: 'ses_child' };
      const store = new Map([[target.id, target]]);
      const collide = summarizerContext({
        create: (input) => fails ? Effect.fail(new Error('create failed after lookup')) : Effect.succeed(store.get(input.id)!),
        remove: (id) => Effect.sync(() => { store.delete(id); }),
      });
      collide.summarizer.host.allocateSessionID = () => target.id;
      const { access } = readAccessFor({ sessions: FAMILY, timelines: { ses_child: finished } });

      const result = await operations(access, collide.summarizer.host).trace({ task_id: target.id, recovery: true });

      expect(store.get(target.id)).toBe(target);
      expect(collide.created).toEqual([]);
      expect(collide.drafts).toEqual([]);
      expect(collide.removed).toEqual([]);
      expect(collide.summarizer.host.ephemeralSessionIDs.size).toBe(0);
      expect(result.recovery).toMatchObject({ status: 'unavailable', failures: [{ stage: 'map', reasons: ['summarizer_id_collision'] }] });
    });
  }

  it('rejects a returned target collision and keeps self and other sessions inspect-only', async () => {
    const collide = summarizerContext({ create: () => Effect.succeed({ id: 'ses_child' }) });
    const { access } = readAccessFor({ sessions: { ...FAMILY, ses_other: {} }, timelines: { ses_child: finished, ses_parent: finished, ses_other: finished } });
    expect((await operations(access, collide.summarizer.host).trace({ task_id: 'ses_child', recovery: true })).recovery).toMatchObject({ status: 'unavailable', failures: [{ stage: 'map', reasons: ['summarizer_id_collision'] }] });
    // Only the session this plugin named is cleaned up; the colliding target is never touched.
    expect(collide.removed).toEqual([collide.created[0].id]);
    expect(collide.drafts).toEqual([]);
    expect(collide.summarizer.host.ephemeralSessionIDs.size).toBe(0);

    expect((await operations(access).trace({ task_id: 'ses_parent', recovery: true })).recovery.failures).toEqual([{ stage: 'eligibility', reasons: ['self_recovery_not_allowed'] }]);
    const other = await operations(access).trace({ task_id: 'ses_other', recovery: true });
    expect(other.recovery.status).toBe('complete');
    expect(other.semantic.safest_next_action.action).toBe('inspect');
  });

  it('retains an unexpected returned session ID as unconfirmed without generating in or deleting it', async () => {
    const setup = summarizerContext({ create: () => Effect.succeed({ id: 'ses_unexpected' }) });
    const { access } = readAccessFor({ sessions: FAMILY, timelines: { ses_child: finished } });

    const result = await operations(access, setup.summarizer.host).trace({ task_id: 'ses_child', recovery: true });

    expect(setup.created).toHaveLength(1);
    expect(setup.drafts).toEqual([]);
    expect(setup.removed).toEqual([setup.created[0].id]);
    expect([...setup.summarizer.host.ephemeralSessionIDs]).toEqual(['ses_unexpected']);
    expect(result.recovery.failures[0]).toMatchObject({ stage: 'map', reasons: ['summarizer_unavailable', 'ephemeral_cleanup_failed'] });
  });

  it('discards a summary when the source, parent or placement changed during recovery', async () => {
    let sourceChanges = false;
    const changing = readAccessFor({ sessions: FAMILY, timelines: { ses_child: () => sourceChanges ? [...finished, user('msg_u2', 'steer')] : finished } });
    const setup = summarizerContext({ reply: (request, draft) => { sourceChanges = true; return semanticReply(request); } });
    const changed = await operations(changing.access, setup.summarizer.host).trace({ task_id: 'ses_child', recovery: true });
    expect(changed.recovery.failures).toEqual([{ stage: 'freshness', reasons: ['source_changed_after_recovery'] }]);
    expect(changed.semantic).toBeNull();

    const sessions: Record<string, { parentID?: string; directory?: string }> = { ...FAMILY };
    const moving = readAccessFor({ sessions, timelines: { ses_child: finished } });
    const movingSetup = summarizerContext({ reply: (request) => { sessions.ses_child = { parentID: 'ses_parent', directory: '/elsewhere' }; return semanticReply(request); } });
    expect((await operations(moving.access, movingSetup.summarizer.host).trace({ task_id: 'ses_child', recovery: true })).recovery.failures).toEqual([{ stage: 'freshness', reasons: ['target_changed_after_recovery'] }]);
  });

  it('stops a generation by interrupting its fiber when the request signal aborts', async () => {
    let interrupted = false;
    const setup = summarizerContext({ reply: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; }))) });
    const controller = new AbortController();
    const pending = setup.summarizer.host.generate('ses_summary_1', { request: { kind: 'map' }, system: 'contract' }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error('deadline'));
    await expect(pending).rejects.toThrow('deadline');
    expect(interrupted).toBe(true);
  });
});

describe('v2 summarizer model variant', () => {
  const finished = [user('msg_u1', 'Implement the task.'), assistant('msg_a1', [{ type: 'text', text: 'Implemented and verified.' }])];
  const defaultModel = (variants: string[]) => ({ providerID: 'dp', id: 'dm', limit: { context: 100_000, output: 1_000 }, variants: variants.map((id) => ({ id })) });
  const recover = async (setup: ReturnType<typeof summarizerContext>) => {
    const { access } = readAccessFor({ sessions: FAMILY, timelines: { ses_child: finished } });
    return operations(access, setup.summarizer.host).trace({ task_id: 'ses_child', recovery: true });
  };

  it('applies a variant-only configuration to the host default model and reports the model that ran', async () => {
    const setup = summarizerContext({ config: { variant: 'high', temperature: 0 }, defaultModel: defaultModel(['low', 'high']) });
    const result = await recover(setup);
    expect(setup.created.map((input) => input.model)).toEqual([{ providerID: 'dp', id: 'dm', variant: 'high' }, { providerID: 'dp', id: 'dm', variant: 'high' }]);
    expect(setup.drafts.map((draft) => draft.model.variant)).toEqual(['high', 'high']);
    expect(result.recovery).toMatchObject({ status: 'complete', model: { requested: { variant: 'high' }, observed: { model: 'dp/dm', variant: 'high' } } });
  });

  it('does not create a summarizer session when the default model does not offer the variant', async () => {
    const setup = summarizerContext({ config: { variant: 'high', temperature: 0 }, defaultModel: defaultModel(['low']) });
    const result = await recover(setup);
    expect(setup.created).toEqual([]);
    expect(result.recovery).toMatchObject({ status: 'partial', cards_source: 'fallback', phases_source: 'fallback' });
    expect(result.recovery.failures[0]).toMatchObject({ reasons: ['summarizer_unavailable'], diagnostics: [{ code: 'variant_unavailable' }] });
    expect(result.recovery.model.observed).toBeUndefined();
  });

  it('fails the stage rather than dropping the variant when the host has no default model', async () => {
    const setup = summarizerContext({ config: { variant: 'high', temperature: 0 } });
    const result = await recover(setup);
    expect(setup.created).toEqual([]);
    expect(result.recovery.failures[0]).toMatchObject({ reasons: ['summarizer_unavailable'], diagnostics: [{ code: 'transport_error' }] });
  });
});

describe('v2 caller cancellation', () => {
  const finished = [user('msg_u1', 'Implement the task.'), assistant('msg_a1', [{ type: 'text', text: 'Implemented and verified.' }])];
  const until = async (condition: () => boolean, label: string) => {
    for (let waited = 0; !condition(); waited += 5) {
      if (waited > 2_000) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  it('interrupts an active generation, starts no later stage and removes the session when the tool call is interrupted', async () => {
    const { access, calls } = readAccessFor({ sessions: FAMILY, timelines: { ses_child: finished } });
    let interrupted = false;
    const setup = summarizerContext({ reply: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; }))) });
    const call = await registered(access, setup);
    const fiber = Effect.runFork(call({ task_id: 'ses_child', recovery: true }));
    await until(() => setup.drafts.length === 1, 'the generation to start');
    const readsAtCancel = calls.length;

    await Effect.runPromise(Fiber.interrupt(fiber));
    await until(() => interrupted, 'the generation fiber to be interrupted');
    await until(() => setup.removed.length === 1, 'the session to be removed');
    await settle();
    expect(setup.removed).toEqual([setup.created[0].id]);
    expect(setup.created).toHaveLength(1);
    expect(calls.length).toBe(readsAtCancel);
  });

  it('abandons blocked model metadata with the caller before creating any session', async () => {
    const { access, calls } = readAccessFor({ sessions: FAMILY, timelines: { ses_child: finished } });
    let interrupted = false;
    const setup = summarizerContext({ models: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; }))) });
    const call = await registered(access, setup);
    const fiber = Effect.runFork(call({ task_id: 'ses_child', recovery: true }));
    await until(() => calls.some((entry) => entry.method === 'active'), 'the source and status reads to finish');
    await settle();
    const readsAtCancel = calls.length;

    await Effect.runPromise(Fiber.interrupt(fiber));
    await until(() => interrupted, 'the metadata request to be interrupted');
    await settle();
    expect(setup.created).toEqual([]);
    expect(setup.removed).toEqual([]);
    expect(calls.length).toBe(readsAtCancel);
  });

  it('gives the caller signal to the history reads of a recovery', async () => {
    const base = readAccessFor({ sessions: FAMILY, timelines: { ses_child: finished } });
    const signals: Array<AbortSignal | undefined> = [];
    const access: VerifiedReadAccess = {
      ...base.access,
      messageList: (request, signal) => {
        signals.push(signal);
        return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
      },
    };
    const setup = summarizerContext();
    const call = await registered(access, setup);
    const fiber = Effect.runFork(call({ task_id: 'ses_child', recovery: true }));
    await until(() => signals.length === 1, 'the history read to start');
    expect(signals[0]?.aborted).toBe(false);

    await Effect.runPromise(Fiber.interrupt(fiber));
    await until(() => signals[0]?.aborted === true, 'the history read signal to abort');
    await settle();
    expect(base.calls.some((entry) => entry.method === 'active')).toBe(false);
    expect(setup.created).toEqual([]);
  });

  /** Read access whose first history page stays open (ignoring the signal, as a client may) until released. */
  function holdingHistory(base: ReturnType<typeof readAccessFor>) {
    const signals: Array<AbortSignal | undefined> = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const access: VerifiedReadAccess = {
      ...base.access,
      messageList: async (request, signal) => {
        if (held) return base.access.messageList(request, signal);
        held = true;
        signals.push(signal);
        await released;
        return base.access.messageList(request, signal);
      },
    };
    return { access, signals, release, isHeld: () => held };
  }

  const longTimeline = Array.from({ length: 450 }, (_, index) => user(`msg_${String(index).padStart(4, '0')}`, `message ${index}`));

  it('stops an ordinary trace read with the caller instead of paging on', async () => {
    const base = readAccessFor({ sessions: FAMILY, timelines: { ses_child: longTimeline } });
    const held = holdingHistory(base);
    const call = await registered(held.access, summarizerContext());
    const fiber = Effect.runFork(call({ task_id: 'ses_child' }));
    await until(() => held.isHeld(), 'the history read to start');
    expect(held.signals[0]).toBeInstanceOf(AbortSignal);
    const requestsAtCancel = base.calls.length;

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(held.signals[0]?.aborted).toBe(true);
    held.release();
    await settle();
    // Only the held page itself completes; no further page, status or child read follows.
    expect(base.calls.slice(requestsAtCancel).map((entry) => entry.method)).toEqual(['list']);
  });

  it('stops a content read with the caller instead of paging on', async () => {
    const base = readAccessFor({ sessions: FAMILY, timelines: { ses_child: longTimeline } });
    const first = await operations(base.access).trace({ task_id: 'ses_child' });
    const event = first.events.find((entry: Raw) => entry.kind === 'text').ref;
    const heldBase = readAccessFor({ sessions: FAMILY, timelines: { ses_child: longTimeline } });
    const held = holdingHistory(heldBase);
    const call = await registered(held.access, summarizerContext(), 'hive_task_trace_content');
    const fiber = Effect.runFork(call({ task_id: 'ses_child', event }));
    await until(() => held.isHeld(), 'the history read to start');
    expect(held.signals[0]).toBeInstanceOf(AbortSignal);
    const requestsAtCancel = heldBase.calls.length;

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(held.signals[0]?.aborted).toBe(true);
    held.release();
    await settle();
    expect(heldBase.calls.slice(requestsAtCancel).map((entry) => entry.method)).toEqual(['list']);
  });

  it('gives the caller signal to every authorization and history read of a trace and a content read', async () => {
    const child = { type: 'tool', id: 'call_c', name: 'subagent', state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'ok' }], metadata: { sessionID: 'ses_grandchild' } }, time: { created: 1 } };
    const timeline = [user('msg_u1', 'go'), assistant('msg_a1', [child])];
    const base = readAccessFor({ sessions: { ...FAMILY, ses_grandchild: { parentID: 'ses_child' } }, timelines: { ses_child: timeline } });
    const seen: Array<[string, AbortSignal | undefined]> = [];
    const spy = (method: 'sessionActive' | 'sessionGet' | 'messageList' | 'checkTarget') => (async (...args: unknown[]) => {
      seen.push([method, args.at(-1) instanceof AbortSignal ? args.at(-1) as AbortSignal : undefined]);
      return (base.access[method] as (...input: unknown[]) => Promise<unknown>)(...args);
    });
    const access = { ...base.access, sessionActive: spy('sessionActive'), sessionGet: spy('sessionGet'), messageList: spy('messageList'), checkTarget: spy('checkTarget') } as unknown as VerifiedReadAccess;
    const trace = await registered(access, summarizerContext());
    const content = await registered(access, summarizerContext(), 'hive_task_trace_content');

    const page = JSON.parse((await Effect.runPromise(trace({ task_id: 'ses_child' }))).content);
    const event = page.events.find((entry: Raw) => entry.child_session_id === 'ses_grandchild').ref;
    await Effect.runPromise(content({ task_id: 'ses_child', event }));

    expect(new Set(seen.map(([method]) => method))).toEqual(new Set(['checkTarget', 'sessionGet', 'messageList', 'sessionActive']));
    expect(seen.filter(([, signal]) => signal === undefined)).toEqual([]);
  });

  it('refuses a trace or content call that has no caller signal', () => {
    const { access } = readAccessFor({ sessions: FAMILY, timelines: {} });
    const ops = createV2TraceOperations(access, summarizerContext().summarizer.host);
    expect(() => ops.hive_task_trace.execute({ task_id: 'ses_child' }, { sessionID: 'ses_parent' })).toThrow('Hive trace reads need the caller cancellation signal.');
    expect(() => ops.hive_task_trace_content.execute({ task_id: 'ses_child', event: 'x' }, { sessionID: 'ses_parent' })).toThrow('Hive trace reads need the caller cancellation signal.');
  });
});

describe('v2 summarizer session acquisition', () => {
  const finished = [user('msg_u1', 'Implement the task.'), assistant('msg_a1', [{ type: 'text', text: 'Implemented and verified.' }])];
  const until = async (condition: () => boolean, label: string) => {
    for (let waited = 0; !condition(); waited += 5) {
      if (waited > 2_000) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  /**
   * Native session creation as the pinned host performs it: the session is committed first and its ID is returned
   * afterwards, so a create held (or interrupted) in between has already persisted the session.
   */
  function nativeCreate(options: { uninterruptible?: boolean; commitAfterHold?: boolean } = {}) {
    const store = new Set<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let committed = 0;
    const hold = Effect.promise(() => gate);
    return {
      store,
      release,
      committedCount: () => committed,
      create: (input: any, call: number) => Effect.gen(function* () {
        const id: string = input.id ?? `ses_native_${call}`;
        const commit = () => { store.add(id); committed += 1; };
        if (!options.commitAfterHold) commit();
        const wait = options.commitAfterHold ? Effect.andThen(hold, Effect.sync(commit)) : hold;
        yield* options.uninterruptible ? Effect.uninterruptible(wait) : wait;
        return { id };
      }),
      remove: (sessionID: string) => store.delete(sessionID) ? Effect.void : Effect.fail({ _tag: 'Session.NotFoundError', sessionID }),
    };
  }

  const cases = [
    { name: 'during the create', uninterruptible: false, commitAfterHold: false },
    { name: 'and the create finishes late', uninterruptible: true, commitAfterHold: false },
    { name: 'and the create commits only after the caller left', uninterruptible: true, commitAfterHold: true },
  ];
  for (const { name, uninterruptible, commitAfterHold } of cases) {
    it(`removes a session committed before its ID was returned when the caller is interrupted ${name}`, async () => {
      const { access } = readAccessFor({ sessions: FAMILY, timelines: { ses_child: finished } });
      const native = nativeCreate({ uninterruptible, commitAfterHold });
      const setup = summarizerContext({ create: native.create, remove: native.remove });
      const call = await registered(access, setup);
      const fiber = Effect.runFork(call({ task_id: 'ses_child', recovery: true }));
      await until(() => commitAfterHold ? setup.created.length === 1 : native.committedCount() === 1, 'the create to start');

      await Effect.runPromise(Fiber.interrupt(fiber));
      // A create that cannot be interrupted settles only when released; cleanup must wait for it, not race ahead.
      if (uninterruptible) {
        await settle();
        native.release();
      }
      await until(() => native.store.size === 0, 'the committed session to be removed');
      native.release();
      await settle();
      expect(native.committedCount()).toBe(1);
      expect(native.store.size).toBe(0);
      expect(setup.created).toHaveLength(1);
      expect(setup.drafts).toEqual([]);
    });
  }

  it('treats a create that failed before committing as nothing to clean up', async () => {
    const { access } = readAccessFor({ sessions: FAMILY, timelines: { ses_child: finished } });
    const native = nativeCreate();
    const setup = summarizerContext({ create: () => Effect.fail(new Error('create refused')), remove: native.remove });
    const result = await operations(access, setup.summarizer.host).trace({ task_id: 'ses_child', recovery: true });
    expect(result.recovery.failures[0]).toMatchObject({ stage: 'map', reasons: ['summarizer_unavailable'], diagnostics: [{ code: 'transport_error' }] });
    expect(setup.removed).toEqual([setup.created[0].id]);
    expect(setup.summarizer.host.ephemeralSessionIDs.size).toBe(0);
  });

  it('keeps ownership of a committed session whose create never settles, and reports the unconfirmed cleanup', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers: Array<{ callback: () => void; active: boolean }> = [];
    globalThis.setTimeout = ((callback: () => void) => {
      const timer = { callback, active: true };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: { active?: boolean }) => { if (timer) timer.active = false; }) as typeof clearTimeout;
    try {
      const { access } = readAccessFor({ sessions: FAMILY, timelines: { ses_child: finished } });
      const native = nativeCreate({ uninterruptible: true });
      const setup = summarizerContext({ create: native.create, remove: native.remove });
      let settled = false;
      const execution = operations(access, setup.summarizer.host).trace({ task_id: 'ses_child', recovery: true }).finally(() => { settled = true; });
      // Every attempt and cleanup deadline fires in order; the create never returns, as a deadline or late success would.
      for (let turns = 0; !settled && turns < 500; turns += 1) {
        for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
        const next = timers.find((timer) => timer.active);
        if (next) { next.active = false; next.callback(); }
      }
      const result = await execution;

      const owned = [...setup.summarizer.host.ephemeralSessionIDs];
      expect(owned.length).toBeGreaterThan(0);
      // Nothing persisted is unowned: every committed session is retained for reporting, none is claimed removed.
      expect([...native.store].every((id) => owned.includes(id))).toBe(true);
      expect(result.recovery.failures.length).toBeGreaterThan(0);
      expect(result.recovery.failures).toContainEqual(expect.objectContaining({ stage: 'map', reasons: expect.arrayContaining(['ephemeral_cleanup_failed']) }));
      native.release();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});

// --- Registration through the catalog registrar ---

function createProject() {
  const root = fs.realpathSync(fs.mkdtempSync(`/tmp/hive-v2-trace-${process.pid}-`));
  const home = fs.mkdtempSync(`/tmp/hive-v2-trace-home-${process.pid}-`);
  cleanup.push(root, home);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return { root, home };
}

/** Activates the real plugin against a minimal host that records transforms and hooks. */
async function activate(options: Record<string, unknown>) {
  const { root, home } = createProject();
  const transforms: Record<'agent' | 'skill' | 'command' | 'tool', Array<(editor: any) => void>> = { agent: [], skill: [], command: [], tool: [] };
  const hooks: Record<string, Array<(event: any) => Effect.Effect<void, any>>> = {};
  const registration = { dispose: Effect.void };
  const sessions = new Map<string, { id: string; parentID?: string }>([['primary', { id: 'primary' }], ['child', { id: 'child', parentID: 'primary' }]]);
  const transform = (kind: keyof typeof transforms) => (cb: any) => Effect.sync(() => { transforms[kind].push(cb); return registration; });
  const hook = (name: string, cb: any) => Effect.sync(() => { (hooks[name] ??= []).push(cb); return registration; });
  const context = {
    location: { directory: root, project: { id: 'project', directory: root, canonical: root } },
    options,
    rpc: { register: () => Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } }) },
    event: { subscribe: () => Stream.empty },
    agent: { transform: transform('agent'), list: () => Effect.succeed({ data: [] }) },
    skill: { transform: transform('skill'), list: () => Effect.succeed({ data: [] }) },
    command: { transform: transform('command') },
    tool: { transform: transform('tool'), hook },
    session: {
      hook,
      get: ({ sessionID }: { sessionID: string }) => Effect.suspend(() => {
        const session = sessions.get(sessionID);
        return session ? Effect.succeed(session) : Effect.fail(new Error(`unknown session ${sessionID}`));
      }),
    },
  } as unknown as Plugin.Context;
  const saved = { HOME: process.env.HOME, OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.OPENCODE_CONFIG_DIR = path.join(home, '.config', 'opencode');
  delete process.env.XDG_CONFIG_HOME;
  try {
    await Effect.runPromise(plugin.effect(context).pipe(Scope.provide(Effect.runSync(Scope.make()))));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const tools = new Map<string, any>();
  for (const cb of transforms.tool) cb({
    add: (info: any) => tools.set(info.name, info),
    update: (id: string, fn: (info: any) => void) => { if (tools.has(id)) fn(tools.get(id)); },
  });
  const agents = new Map<string, any>();
  for (const cb of transforms.agent) cb({ update: (id: string, fn: (agent: any) => void) => { const agent = agents.get(id) ?? { id, permissions: [] }; agents.set(id, agent); fn(agent); }, default: () => {} });
  const execute = (name: string, args: unknown, caller: { sessionID: string; agent: string }) =>
    Effect.runPromiseExit(tools.get(name).execute(args, { ...caller, messageID: 'm', id: 'c', progress: () => Effect.void }));
  return { root, tools, agents, hooks, execute };
}

function tree(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.parentPath.includes(`${path.sep}.git`) && entry.name !== '.git')
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return `${path.relative(root, file)}:${entry.isFile() ? fs.statSync(file).mtimeMs : 'dir'}`;
    })
    .sort();
}

describe('v2 evidence registration', () => {
  it('registers both trace tools through the registrar: mixed trace direct, content per transport, guarded and store-pure', async () => {
    for (const transport of ['codemode', 'direct'] as const) {
      const host = await activate({ readTransport: transport });
      expect(host.tools.get('hive_task_trace').options).toEqual({ codemode: false });
      expect(host.tools.get('hive_task_trace_content').options).toEqual({ codemode: transport === 'codemode' });
      expect(host.agents.get(TASK_TRACE_SUMMARIZER_AGENT)).toMatchObject({ mode: 'primary', hidden: true, system: TASK_TRACE_SUMMARIZER_PROMPT });
      expect(host.agents.get(TASK_TRACE_SUMMARIZER_AGENT).permissions.at(-1)).toEqual({ action: '*', resource: '*', effect: 'deny' });
      expect(host.hooks.generate?.length).toBeGreaterThanOrEqual(2);

      // Without a configured server the read reports the missing binding and writes nothing, guard included.
      const before = tree(host.root);
      for (const [name, args] of [['hive_task_trace_content', { task_id: 'child', event: 'trace-ref' }], ['hive_task_trace', { task_id: 'child' }]] as const) {
        const exit = await host.execute(name, args, { sessionID: 'primary', agent: 'hive-helper' });
        expect(Exit.isSuccess(exit)).toBe(true);
      }
      const read = await host.execute('hive_task_trace', { task_id: 'child' }, { sessionID: 'primary', agent: 'hive-helper' });
      expect(JSON.parse((read as Exit.Success<{ content: string }>).value.content)).toEqual({ ok: false, reason: 'unavailable_or_unauthorized', read_access: 'not_configured' });
      expect(tree(host.root)).toEqual(before);

      // Native general has no Hive tools, whatever the native permission view shows.
      const denied = await host.execute('hive_task_trace_content', { task_id: 'child', event: 'trace-ref' }, { sessionID: 'child', agent: 'general' });
      expect(Exit.isFailure(denied)).toBe(true);
      expect(Exit.isFailure(denied) && denied.cause.reasons.some((reason: any) => reason._tag === 'Fail' && reason.error instanceof Tool.Error)).toBe(true);
    }
  });
});
