import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IDENTITY_RPC_ID } from './identity.js';
import { ReadAccessError, createVerifiedReadAccess } from './client.js';
import { parseV2Options } from './options.js';

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
    expect(Object.keys(access).sort()).toEqual(['checkTarget', 'messageList', 'sessionActive', 'sessionGet']);
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
    expect(schema.properties.server.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.server.properties).sort()).toEqual(['passwordEnv', 'url', 'username']);
    expect(schema.properties.server.required).toEqual(['url']);
  });
});
