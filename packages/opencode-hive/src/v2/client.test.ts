import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IDENTITY_RPC_ID } from './identity.js';
import { ReadAccessError, createVerifiedReadAccess } from './client.js';
import { parseV2Options } from './options.js';
import { CODEMODE_READ_TOOLS } from '../runtime/host-profile.js';

const identity = { nonce: 'held-nonce' };
const directory = '/work/project';
const server = { url: 'http://127.0.0.1:4096', username: 'opencode', passwordEnv: 'HIVE_TEST_SERVER_PASSWORD' };

type Answer = { nonce?: unknown; directory?: unknown } | Error;
type Session = { id: string; parentID?: string; location?: { directory: string } };

/**
 * A public-client double whose identity answers can change between calls, as a restarted or replaced server would.
 * `sessions` is the server's session table; `onSessionGet` lets a test change it between two reads.
 */
function fakeServer(answers: Answer[], sessions: Record<string, Session> = {}, onSessionGet?: (id: string) => void) {
  const made: Array<{ baseUrl: string; headers: Record<string, string> }> = [];
  const calls: unknown[] = [];
  const reads: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const makeClient = (options: { baseUrl: string; headers: Record<string, string> }) => {
    made.push(options);
    return {
      rpc: {
        call: async (request: unknown, options?: { signal?: AbortSignal }) => {
          calls.push(request);
          signals.push(options?.signal);
          const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
          if (answer instanceof Error) throw answer;
          return { output: answer };
        },
      },
      session: {
        active: async (options?: { signal?: AbortSignal }) => { reads.push('active'); signals.push(options?.signal); return { ses_1: 'running' }; },
        get: async ({ sessionID }: { sessionID: string }, options?: { signal?: AbortSignal }) => {
          reads.push(`get:${sessionID}`);
          signals.push(options?.signal);
          onSessionGet?.(sessionID);
          const session = sessions[sessionID];
          if (!session) throw new Error(`session ${sessionID} not found`);
          return session;
        },
      },
      message: { list: async (_request: unknown, options?: { signal?: AbortSignal }) => { reads.push('messages'); signals.push(options?.signal); return { data: [{ id: 'msg_1' }], cursor: {} }; } },
    } as any;
  };
  return { made, calls, reads, signals, makeClient };
}

const env = { HIVE_TEST_SERVER_PASSWORD: 'secret' };

async function failure(promise: Promise<unknown>): Promise<ReadAccessError> {
  try { await promise; } catch (error) { return error as ReadAccessError; }
  throw new Error('expected a read access failure');
}

describe('verified v2 read access', () => {
  const ok = { nonce: 'held-nonce', directory };

  it('creates the client lazily with only the configured credentials, and checks identity before and after every read', async () => {
    const host = fakeServer([ok]);
    const access = createVerifiedReadAccess({ server, identity, directory, env, makeClient: host.makeClient });
    expect(host.made).toHaveLength(0);
    expect(await access.sessionActive()).toEqual({ ses_1: 'running' } as any);
    expect(host.made).toEqual([{ baseUrl: 'http://127.0.0.1:4096', headers: { authorization: `Basic ${Buffer.from('opencode:secret').toString('base64')}` } }]);
    // The identity request carries no nonce: the server answers with its own, and only this side compares it.
    expect(host.calls[0]).toEqual({ rpcID: IDENTITY_RPC_ID, method: 'get', location: { directory }, input: {} });
    expect(host.calls).toHaveLength(2);
    await access.messageList({ sessionID: 'ses_1' } as any);
    // A later read is not covered by the earlier check: it is checked on both sides again.
    expect(host.calls).toHaveLength(4);
    expect(host.made).toHaveLength(1);
  });

  it('exposes only read methods and no client or callback to keep', () => {
    const access = createVerifiedReadAccess({ server, identity, directory, env, makeClient: fakeServer([ok]).makeClient });
    expect(Object.keys(access).sort()).toEqual(['checkTarget', 'childSettlement', 'messageList', 'sessionActive', 'sessionGet']);
  });

  it('rejects another instance, another location and failed authentication before any read runs', async () => {
    const cases: Array<[Answer, string]> = [
      [{ nonce: 'other-activation', directory }, 'wrong_instance'],
      [{ nonce: 'held-nonce', directory: '/work/other' }, 'wrong_location'],
      [Object.assign(new Error('No RPC handler'), { type: 'rpc.unavailable' }), 'wrong_location'],
      [Object.assign(new Error('Authentication required'), { status: 401 }), 'unauthorized'],
      [new Error('connect ECONNREFUSED 127.0.0.1:4096'), 'unreachable'],
    ];
    for (const [answer, code] of cases) {
      const host = fakeServer([answer], { s: { id: 's', location: { directory } } });
      const access = createVerifiedReadAccess({ server, identity, directory, env, makeClient: host.makeClient });
      const error = await failure(access.sessionGet('s'));
      expect(error).toBeInstanceOf(ReadAccessError);
      expect(error.code).toBe(code as any);
      expect(host.reads).toEqual([]);
    }
  });

  it('refuses a method kept across a replacement: the check before the read fails, and no read runs', async () => {
    const host = fakeServer([ok, ok, { nonce: 'replacement', directory }], { s: { id: 's', location: { directory } } });
    const access = createVerifiedReadAccess({ server, identity, directory, env, makeClient: host.makeClient });
    const kept = access.sessionGet;
    expect(((await kept('s')) as any).id).toBe('s');
    const error = await failure(kept('s'));
    expect(error.code).toBe('wrong_instance');
    expect(host.reads).toEqual(['get:s']);
  });

  it('discards a result when the identity no longer matches after the read, and creates a client again next time', async () => {
    const host = fakeServer([ok, { nonce: 'restarted', directory }, ok]);
    const access = createVerifiedReadAccess({ server, identity, directory, env, makeClient: host.makeClient });
    const error = await failure(access.sessionActive());
    expect(error.code).toBe('wrong_instance');
    await access.sessionActive();
    expect(host.made).toHaveLength(2);
  });

  it('accepts a session read only when the server answers for the session that was asked for', async () => {
    const host = fakeServer([ok], { s: { id: 's', location: { directory } }, liar: { id: 'someone-else', location: { directory } } });
    const access = createVerifiedReadAccess({ server, identity, directory, env, makeClient: host.makeClient });
    expect(((await access.sessionGet('s')) as any).id).toBe('s');
    expect((await failure(access.sessionGet('liar'))).code).toBe('inconsistent_lookup');
  });

  it('gives the caller signal to every request of a read and keeps a cancelled check from resetting the client', async () => {
    const sessions = { caller: { id: 'caller', location: { directory } }, child: { id: 'child', parentID: 'caller', location: { directory } } };
    const host = fakeServer([ok], sessions);
    const access = createVerifiedReadAccess({ server, identity, directory, env, makeClient: host.makeClient });
    const controller = new AbortController();
    await access.sessionActive(controller.signal);
    await access.messageList({ sessionID: 'child' } as any, controller.signal);
    await access.sessionGet('child', controller.signal);
    await access.checkTarget({ callerID: 'caller', targetID: 'child' }, controller.signal);
    expect(host.signals.length).toBeGreaterThan(12);
    expect(host.signals.every((signal) => signal === controller.signal)).toBe(true);

    host.signals.length = 0;
    await access.sessionActive();
    expect(host.signals.every((signal) => signal === undefined)).toBe(true);

    const cancelled = new AbortController();
    let created = 0;
    let first = true;
    const client = {
      rpc: {
        call: (_request: unknown, options?: { signal?: AbortSignal }) => {
          if (!first) return Promise.resolve({ output: ok });
          first = false;
          return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal!.reason)));
        },
      },
      session: { active: async () => ({}) },
    } as any;
    const replaced = createVerifiedReadAccess({ server, identity, directory, env, makeClient: () => { created += 1; return client; } });
    const waiting = replaced.sessionActive(cancelled.signal);
    cancelled.abort(new Error('caller gone'));
    await expect(waiting).rejects.toThrow('caller gone');
    await replaced.sessionActive();
    expect(created).toBe(1);
  });

  it('reports a missing server option or password variable instead of guessing a server', async () => {
    const unconfigured = createVerifiedReadAccess({ server: undefined, identity, directory, env, makeClient: fakeServer([]).makeClient });
    expect((await failure(unconfigured.sessionActive())).code).toBe('not_configured');
    const noPassword = createVerifiedReadAccess({ server, identity, directory, env: {}, makeClient: fakeServer([]).makeClient });
    const error = await failure(noPassword.sessionActive());
    expect(error.code).toBe('not_configured');
    expect(error.message).toContain('HIVE_TEST_SERVER_PASSWORD');
  });
});

describe('target relationship and placement', () => {
  const table = (): Record<string, Session> => ({
    caller: { id: 'caller', location: { directory } },
    child: { id: 'child', parentID: 'caller', location: { directory } },
    grandchild: { id: 'grandchild', parentID: 'child', location: { directory: '/work/elsewhere' } },
    stranger: { id: 'stranger', location: { directory } },
    // The server answers a lookup of `liar` with another session.
    liar: { id: 'someone-else', location: { directory } },
  });
  const accessFor = (sessions: Record<string, Session>, onSessionGet?: (id: string) => void) =>
    createVerifiedReadAccess({ server, identity, directory, env, makeClient: fakeServer([{ nonce: 'held-nonce', directory }], sessions, onSessionGet).makeClient });

  it('keeps relationship and placement separate', async () => {
    const access = accessFor(table());
    expect(await access.checkTarget({ callerID: 'caller', targetID: 'caller' })).toEqual({ relationship: 'self', placement: 'this-location' });
    expect(await access.checkTarget({ callerID: 'caller', targetID: 'child' })).toEqual({ relationship: 'child', placement: 'this-location' });
    expect(await access.checkTarget({ callerID: 'caller', targetID: 'grandchild' })).toEqual({ relationship: 'descendant', placement: 'other-location' });
    expect(await access.checkTarget({ callerID: 'caller', targetID: 'stranger' })).toEqual({ relationship: 'other', placement: 'this-location' });
    expect(await access.checkTarget({ callerID: 'child', targetID: 'caller' })).toEqual({ relationship: 'other', placement: 'this-location' });
  });

  it('reads the caller from the server instead of trusting its ID', async () => {
    const missing = await failure(accessFor(table()).checkTarget({ callerID: 'nobody', targetID: 'child' }));
    expect(missing.code).toBe('caller_unavailable');
    const sessions = table();
    sessions.caller = { id: 'caller', location: { directory: '/work/elsewhere' } };
    expect((await failure(accessFor(sessions).checkTarget({ callerID: 'caller', targetID: 'child' }))).code).toBe('caller_displaced');
    expect((await failure(accessFor(table()).checkTarget({ callerID: 'liar', targetID: 'child' }))).code).toBe('inconsistent_lookup');
  });

  it('rejects a target that is unavailable or answered by another session, and a parent chain that is not finite', async () => {
    expect((await failure(accessFor(table()).checkTarget({ callerID: 'caller', targetID: 'missing' }))).code).toBe('target_unavailable');
    expect((await failure(accessFor(table()).checkTarget({ callerID: 'caller', targetID: 'liar' }))).code).toBe('inconsistent_lookup');
    const orphan = table();
    orphan.dangling = { id: 'dangling', parentID: 'gone', location: { directory } };
    expect((await failure(accessFor(orphan).checkTarget({ callerID: 'caller', targetID: 'dangling' }))).code).toBe('target_unavailable');
    const cyclic = table();
    cyclic.a = { id: 'a', parentID: 'b', location: { directory } };
    cyclic.b = { id: 'b', parentID: 'a', location: { directory } };
    expect((await failure(accessFor(cyclic).checkTarget({ callerID: 'caller', targetID: 'a' }))).code).toBe('inconsistent_lookup');
  });

  it('does not accept an answer when the caller or target changes between the reads that produced it', async () => {
    const sessions = table();
    let callerReads = 0;
    const displacedAfterFirstRead = accessFor(sessions, (id) => {
      if (id === 'caller' && ++callerReads === 2) sessions.caller = { id: 'caller', location: { directory: '/work/elsewhere' } };
    });
    expect((await failure(displacedAfterFirstRead.checkTarget({ callerID: 'caller', targetID: 'child' }))).code).toBe('caller_displaced');

    const reparented = table();
    let targetReads = 0;
    const reparentedMidCheck = accessFor(reparented, (id) => {
      if (id === 'child' && ++targetReads === 2) reparented.child = { id: 'child', parentID: 'stranger', location: { directory } };
    });
    expect((await failure(reparentedMidCheck.checkTarget({ callerID: 'caller', targetID: 'child' }))).code).toBe('inconsistent_lookup');
  });

  it('discards the answer when the server is replaced while it is being checked', async () => {
    const host = fakeServer([{ nonce: 'held-nonce', directory }, { nonce: 'replacement', directory }], table());
    const access = createVerifiedReadAccess({ server, identity, directory, env, makeClient: host.makeClient });
    expect((await failure(access.checkTarget({ callerID: 'caller', targetID: 'child' }))).code).toBe('wrong_instance');
  });
});

describe('child settlement', () => {
  type Job = { id: string; kind: string; sessionID: string; status: string; childSessionID?: string };
  type State = { jobs?: Job[]; inbox?: Record<string, unknown[]>; active?: unknown; jobAnswer?: unknown; inboxAnswer?: unknown; listAnswer?: unknown; extra?: Session[]; unlisted?: string[] };
  /**
   * A server with sessions, jobs, inboxes and active executions. `parent` owns `child` and `sibling`; `child` owns
   * `helper`, which owns `quiet`. Job rows exist only where a test adds them, so `quiet` is a descendant no job names.
   * The session list pages children in ID order through an opaque offset cursor. Every read is logged, so the order is
   * visible.
   */
  function settlementServer(state: State) {
    const sessions: Record<string, Session> = {
      parent: { id: 'parent', location: { directory } },
      child: { id: 'child', parentID: 'parent', location: { directory } },
      helper: { id: 'helper', parentID: 'child', location: { directory } },
      quiet: { id: 'quiet', parentID: 'helper', location: { directory } },
      sibling: { id: 'sibling', parentID: 'parent', location: { directory } },
    };
    for (const session of state.extra ?? []) sessions[session.id] = session;
    const base = fakeServer([{ nonce: 'held-nonce', directory }], sessions);
    const descends = (id: string, ancestor: string): boolean => id === ancestor || (sessions[id]?.parentID !== undefined && descends(sessions[id]!.parentID!, ancestor));
    const makeClient = (options: { baseUrl: string; headers: Record<string, string> }) => {
      const client = base.makeClient(options);
      client.experimental = { job: { list: async (input: { sessionID: string; kind?: string; status?: string; descendants?: boolean }) => {
        base.reads.push(`jobs:${input.sessionID}${input.descendants ? '+' : ''}`);
        if (state.jobAnswer !== undefined) return state.jobAnswer;
        return (state.jobs ?? []).filter((job) => (input.descendants ? descends(job.sessionID, input.sessionID) : job.sessionID === input.sessionID)
          && (input.kind === undefined || job.kind === input.kind) && (input.status === undefined || job.status === input.status));
      } } };
      client.session.inbox = { list: async ({ sessionID }: { sessionID: string }) => {
        base.reads.push(`inbox:${sessionID}`);
        return state.inboxAnswer !== undefined ? state.inboxAnswer : state.inbox?.[sessionID] ?? [];
      } };
      client.session.active = async () => { base.reads.push('active'); return state.active ?? {}; };
      client.session.list = async (input: { parentID?: string; order?: string; limit: number; cursor?: string }) => {
        const { parentID, offset } = input.cursor === undefined ? { parentID: input.parentID!, offset: 0 } : JSON.parse(input.cursor);
        base.reads.push(`list:${parentID}${offset ? `@${offset}` : ''}`);
        if (state.listAnswer !== undefined) return state.listAnswer;
        expect(input.cursor === undefined ? input.order : 'asc').toBe('asc');
        const children = Object.values(sessions).filter((session) => session.parentID === parentID && !state.unlisted?.includes(session.id)).sort((a, b) => a.id.localeCompare(b.id));
        const data = children.slice(offset, offset + input.limit);
        // The 2.3.2 wire shape: the JSON codec writes the cursors of an empty page as null.
        return { data, cursor: { previous: null, next: data.length ? JSON.stringify({ parentID, offset: offset + data.length }) : null } };
      };
      return client;
    };
    return { reads: base.reads, access: createVerifiedReadAccess({ server, identity, directory, env, makeClient }) };
  }
  const subagentJob = (owner: string, child: string, status = 'running'): Job => ({ id: child, kind: 'subagent', sessionID: owner, status, childSessionID: child });
  const settle = (state: State) => {
    const host = settlementServer(state);
    return { host, result: host.access.childSettlement({ parentID: 'parent', childID: 'child' }) };
  };

  it('finds a settled child only after reading jobs, then the session tree, then every inbox in it, then active executions', async () => {
    const { host, result } = settle({ jobs: [subagentJob('parent', 'sibling')], active: { sibling: { type: 'running' } } });
    expect(await result).toEqual({ settled: true });
    // The sibling's job and execution belong to the parent, not to the child's tree.
    expect(host.reads).toEqual(['jobs:parent', 'jobs:child+', 'list:child', 'list:helper', 'list:quiet', 'inbox:child', 'inbox:helper', 'inbox:quiet', 'active', 'get:sibling', 'get:parent']);
  });

  it('reports the first signal that shows work: a listed job of the child or a descendant, a queued inbox, then an active descendant', async () => {
    const cases: Array<[State, string, string]> = [
      // Absent from the active executions, the child still runs while its own job runs.
      [{ jobs: [subagentJob('parent', 'child')] }, 'job', "the host's subagent job for child session child is running"],
      // A settled row the host still lists is a report not yet admitted to its owner's inbox.
      [{ jobs: [subagentJob('parent', 'child', 'completed')] }, 'job', "the host's subagent job for child session child is completed, and its notice has not been delivered yet"],
      [{ jobs: [subagentJob('child', 'helper')] }, 'job', 'subagent job helper of session child is running'],
      [{ jobs: [subagentJob('child', 'helper', 'cancelled')] }, 'job', 'subagent job helper of session child is cancelled, and its notice has not been delivered yet'],
      [{ jobs: [{ id: 'sh_1', kind: 'shell', sessionID: 'quiet', status: 'error' }] }, 'job', 'shell job sh_1 of session quiet is error, and its notice has not been delivered yet'],
      [{ inbox: { child: [{ id: 'report' }] } }, 'inbox', 'session child has 1 queued inbox item(s)'],
      // Queued input on a descendant that no job names and that is not running is still found through the tree.
      [{ inbox: { quiet: [{ id: 'queued' }] } }, 'inbox', 'session quiet has 1 queued inbox item(s)'],
      [{ active: { child: { type: 'running' } } }, 'active', 'child session child has an active execution'],
      [{ active: { quiet: { type: 'running' } } }, 'active', 'descendant session quiet of child has an active execution'],
    ];
    for (const [state, signal, detail] of cases) expect(await settle(state).result).toEqual({ settled: false, signal: signal as any, detail });
  });

  it('pages through every child of a session in the tree', async () => {
    const extra = Array.from({ length: 205 }, (_, index): Session => ({ id: `w${String(index).padStart(3, '0')}`, parentID: 'child', location: { directory } }));
    const { host, result } = settle({ extra, inbox: { w204: [{ id: 'queued' }] } });
    expect(await result).toEqual({ settled: false, signal: 'inbox', detail: 'session w204 has 1 queued inbox item(s)' });
    expect(host.reads).toContain('list:child@200');
  });

  it('traces an active session the tree read did not list up its parent chain', async () => {
    // `late` is missing from the session list, as a session created after the tree was read would be.
    const { host, result } = settle({ extra: [{ id: 'late', parentID: 'quiet', location: { directory } }], unlisted: ['late'], active: { late: { type: 'running' } } });
    expect(await result).toEqual({ settled: false, signal: 'active', detail: 'descendant session late of child has an active execution' });
    expect(host.reads).not.toContain('inbox:late');
    expect(host.reads.slice(-3)).toEqual(['get:late', 'get:quiet', 'get:helper']);
  });

  it('refuses a malformed or inconsistent answer instead of reading it as no work', async () => {
    const fullPage = Array.from({ length: 200 }, (_, index) => ({ id: `r${index}`, parentID: 'child' }));
    const malformed: State[] = [
      { jobAnswer: { data: [] } }, { jobAnswer: [{ id: 'x', status: 'running' }] }, { inboxAnswer: null }, { active: [] }, { active: 'idle' },
      { listAnswer: [] }, { listAnswer: { data: [{ parentID: 'child' }], cursor: {} } }, { listAnswer: { data: [], cursor: { next: 7 } } },
      // The 2.3.2 SessionsResponse always carries `cursor`, and `next` is a cursor string, null or absent, never empty.
      { listAnswer: { data: [] } }, { listAnswer: { data: [], cursor: null } }, { listAnswer: { data: [], cursor: { next: '' } } },
      // A full page always has a next cursor on 2.3.2, so one without it would end the tree read early.
      { listAnswer: { data: fullPage, cursor: {} } }, { listAnswer: { data: fullPage, cursor: { next: null } } }, { listAnswer: { data: fullPage } },
    ];
    for (const state of malformed) expect((await failure(settle(state).result)).code).toBe('malformed_response');
    const inconsistent: State[] = [
      // A child listed under the wrong parent.
      { listAnswer: { data: [{ id: 'stray', parentID: 'parent' }], cursor: {} } },
      // A server that repeats the same full page forever.
      { listAnswer: { data: Array.from({ length: 200 }, (_, index) => ({ id: `r${index}`, parentID: 'child' })), cursor: { next: JSON.stringify({ parentID: 'child', offset: 0 }) } } },
      // A tree deeper than any parent chain Hive follows.
      { extra: Array.from({ length: 40 }, (_, index): Session => ({ id: `d${index}`, parentID: index === 0 ? 'child' : `d${index - 1}`, location: { directory } })) },
    ];
    for (const state of inconsistent) expect((await failure(settle(state).result)).code).toBe('inconsistent_lookup');
  });

  it('checks the server identity around the settlement reads', async () => {
    const host = fakeServer([{ nonce: 'held-nonce', directory }, { nonce: 'replacement', directory }]);
    const makeClient = (options: { baseUrl: string; headers: Record<string, string> }) => {
      const client = host.makeClient(options);
      client.experimental = { job: { list: async () => [] } };
      client.session.inbox = { list: async () => [] };
      client.session.list = async () => ({ data: [], cursor: {} });
      client.session.active = async () => ({});
      return client;
    };
    const access = createVerifiedReadAccess({ server, identity, directory, env, makeClient });
    expect((await failure(access.childSettlement({ parentID: 'parent', childID: 'child' }))).code).toBe('wrong_instance');
  });
});

describe('v2 plugin options', () => {
  it('defaults to the codemode transport and no server', () => {
    expect(parseV2Options(undefined)).toEqual({ readTransport: 'codemode' });
    expect(parseV2Options({ readTransport: 'direct', server: { url: 'http://127.0.0.1:4096', passwordEnv: 'PW' } })).toEqual({
      readTransport: 'direct',
      server: { url: 'http://127.0.0.1:4096', username: 'opencode', passwordEnv: 'PW' },
    });
  });

  it('rejects unknown keys, inline secrets and credentials in the URL', () => {
    expect(() => parseV2Options({ readTransport: 'auto' })).toThrow('readTransport');
    expect(() => parseV2Options({ server: { url: 'http://127.0.0.1:4096', password: 'secret' } })).toThrow('server');
    expect(() => parseV2Options({ server: { url: 'http://user:secret@127.0.0.1:4096' } })).toThrow('without credentials');
    expect(() => parseV2Options({ server: { url: 'http://127.0.0.1:4096?token=x' } })).toThrow('without credentials');
    expect(() => parseV2Options({ server: { url: 'file:///tmp/socket' } })).toThrow('http(s)');
    expect(() => parseV2Options({ server: { url: 'http://127.0.0.1:4096', passwordEnv: 'not a name' } })).toThrow('passwordEnv');
    expect(() => parseV2Options({ token: 'x' })).toThrow('Invalid oc-arkive options');
  });

  it('matches the published JSON Schema', () => {
    const schema = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '..', '..', 'schema', 'opencode-v2.options.schema.json'), 'utf8'));
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(['readTransport', 'server']);
    expect(schema.properties.readTransport.enum).toEqual(['codemode', 'direct']);
    expect(schema.properties.readTransport.default).toBe('codemode');
    for (const name of CODEMODE_READ_TOOLS) expect(schema.properties.readTransport.description).toContain(name);
    expect(schema.properties.server.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.server.properties).sort()).toEqual(['passwordEnv', 'url', 'username']);
    expect(schema.properties.server.required).toEqual(['url']);
  });
});
