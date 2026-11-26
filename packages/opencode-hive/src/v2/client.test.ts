import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IDENTITY_RPC_ID } from './identity.js';
import { ClientError } from '@opencode/client';
import { ReadAccessError, createVerifiedReadAccess } from './client.js';
import { parseV2Options } from './options.js';
import { CODEMODE_READ_TOOLS } from '../runtime/host-profile.js';

const identity = { nonce: 'held-nonce' };
const directory = '/work/project';
const server = { url: 'http://127.0.0.1:4096', username: 'opencode', passwordEnv: 'HIVE_TEST_SERVER_PASSWORD' };

/**
 * An identity answer, a thrown error, `{ envelope }`: a whole reply sent as is instead of `{ output: answer }`, or
 * `{ throws }`: a value thrown as it is.
 */
type Answer = { nonce?: unknown; directory?: unknown } | Error | { envelope: unknown } | { throws: unknown };
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
          if ('throws' in answer) throw answer.throws;
          return 'envelope' in answer ? answer.envelope : { output: answer };
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

/** An error as the official client raises it for a declared error status: the response body's fields, `_tag` included. */
const declaredError = (tag: string, message: string) => Object.assign(new Error(message), { _tag: tag, name: tag, message });

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
    expect(Object.keys(access).sort()).toEqual(['checkTarget', 'childSettlement', 'messageList', 'parentActivity', 'sessionActive', 'sessionGet', 'sessionSettlement']);
  });

  it('rejects another instance, another location and failed authentication before any read runs', async () => {
    const cases: Array<[Answer, string]> = [
      [{ nonce: 'other-activation', directory }, 'wrong_instance'],
      [{ nonce: 'held-nonce', directory: '/work/other' }, 'wrong_location'],
      // A reply of another shape cannot carry this activation's nonce.
      [{ envelope: null }, 'wrong_instance'],
      [{ envelope: { output: null } }, 'wrong_instance'],
      [Object.assign(new Error('No RPC handler'), { type: 'rpc.unavailable' }), 'wrong_location'],
      // The official client's declared 401 and 404 answers carry their `_tag`; an undeclared 401 is a ClientError status.
      [declaredError('UnauthorizedError', 'Authentication required'), 'unauthorized'],
      [new ClientError('UnexpectedStatus', { cause: { status: 401 }, detail: '401' }), 'unauthorized'],
      [declaredError('LocationNotFoundError', 'Location not found'), 'wrong_location'],
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

  it('formats only text from an identity reply or binding error, keeps the typed refusal and binds again on the next call', async () => {
    // A value whose conversion to text throws: formatting it would replace the typed refusal with that throw.
    const opaque = () => ({ toString() { throw new Error('converted'); } });
    const cases: Array<[Answer, string, string]> = [
      [{ nonce: 'held-nonce', directory: opaque() }, 'wrong_location', 'answered for a value that is not text'],
      [{ nonce: 'held-nonce', directory: 42 }, 'wrong_location', 'answered for a value that is not text'],
      // Plain objects and strings thrown as they are, as a client could throw them.
      [{ throws: Object.assign(opaque(), { _tag: 'LocationNotFoundError', message: opaque() }) }, 'wrong_location', '(a value that is not text)'],
      [{ throws: Object.assign(opaque(), { _tag: 'UnauthorizedError', message: opaque() }) }, 'unauthorized', 'rejected the configured credentials'],
      [{ throws: opaque() }, 'unreachable', 'failed: a value that is not text'],
      // Supported text keeps its detail.
      [{ throws: 'connect ECONNREFUSED' }, 'unreachable', 'failed: connect ECONNREFUSED'],
      [declaredError('LocationNotFoundError', 'Location not found'), 'wrong_location', '(Location not found)'],
    ];
    for (const [answer, code, text] of cases) {
      const host = fakeServer([answer, ok], { s: { id: 's', location: { directory } } });
      const access = createVerifiedReadAccess({ server, identity, directory, env, makeClient: host.makeClient });
      const error = await failure(access.sessionGet('s'));
      expect([error instanceof ReadAccessError, error.code, error.message.includes(text), error.message.includes('[object')]).toEqual([true, code, true, false]);
      expect(host.reads).toEqual([]);
      // The failed binding is forgotten, and the next call binds again without a retry inside the failed call.
      expect(((await access.sessionGet('s')) as any).id).toBe('s');
      expect(host.made).toHaveLength(2);
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

  it('reports a missing password variable or rejected credentials for an explicit server and never reads the managed registration', async () => {
    // A valid registration of this very process: an explicit server must still ignore it, on success and on error.
    const file = registration({ url: 'http://127.0.0.1:5000', pid: process.pid, password: 'managed-secret' });
    const noPasswordHost = fakeServer([]);
    const noPassword = createVerifiedReadAccess({ server, identity, directory, env: {}, makeClient: noPasswordHost.makeClient, registrationFile: file });
    const error = await failure(noPassword.sessionActive());
    expect(error.code).toBe('not_configured');
    expect(error.message).toContain('HIVE_TEST_SERVER_PASSWORD');
    expect(error.message).not.toContain('secret');
    expect(noPasswordHost.made).toEqual([]);
    const rejectedHost = fakeServer([declaredError('UnauthorizedError', 'Authentication required')]);
    const rejected = createVerifiedReadAccess({ server, identity, directory, env, makeClient: rejectedHost.makeClient, registrationFile: file });
    const unauthorized = await failure(rejected.sessionActive());
    expect(unauthorized.code).toBe('unauthorized');
    const wrongHost = fakeServer([new ClientError('Transport', { cause: new Error('connect ECONNREFUSED 127.0.0.1:4096') })]);
    expect((await failure(createVerifiedReadAccess({ server, identity, directory, env, makeClient: wrongHost.makeClient, registrationFile: file }).sessionActive())).code).toBe('unreachable');
    expect([...rejectedHost.made, ...wrongHost.made].map((made) => made.baseUrl)).toEqual(['http://127.0.0.1:4096', 'http://127.0.0.1:4096']);
  });
});

const scratch: string[] = [];
afterAll(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

/** A managed service registration file in a private temporary directory; a string is written verbatim. */
function registration(record: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-managed-'));
  scratch.push(dir);
  const file = path.join(dir, 'service.json');
  fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify({ id: 'svc', version: '2.3.2', ...(record as object) }), { mode: 0o600 });
  return file;
}

describe('managed service read access', () => {
  const ok = { nonce: 'held-nonce', directory };
  const sessions = { s: { id: 's', location: { directory } } };
  const basic = (password: string) => ({ authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` });

  it('reads this process\'s registration on the first read, not at creation, and uses its credentials with redirects refused', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-managed-'));
    scratch.push(dir);
    const file = path.join(dir, 'service.json');
    const host = fakeServer([ok], sessions);
    const access = createVerifiedReadAccess({ server: undefined, identity, directory, env: {}, makeClient: host.makeClient, registrationFile: file });
    // Written after creation: creating the access reads nothing.
    fs.writeFileSync(file, JSON.stringify({ id: 'svc', version: '2.3.2', url: 'http://127.0.0.1:4096', pid: process.pid, password: 'managed-secret' }));
    expect(host.made).toEqual([]);
    expect(((await access.sessionGet('s')) as any).id).toBe('s');
    expect(host.made).toHaveLength(1);
    expect(host.made[0]).toMatchObject({ baseUrl: 'http://127.0.0.1:4096', headers: basic('managed-secret') });
    expect(host.calls).toEqual([
      { rpcID: IDENTITY_RPC_ID, method: 'get', location: { directory }, input: {} },
      { rpcID: IDENTITY_RPC_ID, method: 'get', location: { directory }, input: {} },
    ]);
    // The binding is kept while its checks pass, even if the file changes.
    fs.writeFileSync(file, 'not json');
    await access.sessionActive();
    expect(host.made).toHaveLength(1);
  });

  it('accepts only numeric loopback http(s) origins and sends no credentials for a registration without a password', async () => {
    for (const [url, origin] of [['http://127.0.0.1:4096', 'http://127.0.0.1:4096'], ['http://127.0.0.2:80/', 'http://127.0.0.2'], ['https://[::1]:8443', 'https://[::1]:8443'], ['http://127.1:5', 'http://127.0.0.1:5']] as const) {
      const host = fakeServer([ok], sessions);
      const access = createVerifiedReadAccess({ server: undefined, identity, directory, env: {}, makeClient: host.makeClient, registrationFile: registration({ url, pid: process.pid }) });
      await access.sessionGet('s');
      expect(host.made[0]).toMatchObject({ baseUrl: origin, headers: {} });
    }
  });

  it('refuses a missing, foreign, non-loopback or malformed registration as not_configured before any client or request exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-managed-'));
    scratch.push(dir);
    const valid = { url: 'http://127.0.0.1:4096', pid: process.pid, password: 'managed-secret' };
    const files = [
      path.join(dir, 'absent.json'),
      dir,
      registration({ ...valid, pid: process.pid + 1 }),
      registration({ ...valid, pid: String(process.pid) }),
      registration({ url: valid.url, password: valid.password }),
      ...['http://0.0.0.0:4096', 'http://localhost:4096', 'http://192.168.1.2:4096', 'http://example.com', 'http://opencode:managed-secret@127.0.0.1:4096', 'http://127.0.0.1:4096/?', 'http://127.0.0.1:4096/#x', 'http://127.0.0.1:4096/api', 'ftp://127.0.0.1:21', 'file:///tmp/x', 'not a url', 42]
        .map((url) => registration({ ...valid, url })),
      registration({ ...valid, password: 42 }),
      registration({ ...valid, password: '' }),
      registration('managed-secret is not json'),
      registration('[1,2]'),
      registration('null'),
      registration(JSON.stringify({ ...valid, padding: 'x'.repeat(70 * 1024) })),
    ];
    for (const file of files) {
      const host = fakeServer([ok], sessions);
      const error = await failure(createVerifiedReadAccess({ server: undefined, identity, directory, env: {}, makeClient: host.makeClient, registrationFile: file }).checkTarget({ callerID: 's', targetID: 's' }));
      expect([file, error.code]).toEqual([file, 'not_configured']);
      expect(error.message).toContain('`server` option');
      expect(error.message).not.toContain('managed-secret');
      expect(host.made).toEqual([]);
      expect(host.calls).toEqual([]);
    }
  });

  it('finds a service registered after a refused read, and reads the registration again after its binding fails a check', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-managed-'));
    scratch.push(dir);
    const file = path.join(dir, 'service.json');
    const host = fakeServer([ok, { nonce: 'other-process', directory }, ok], sessions);
    const access = createVerifiedReadAccess({ server: undefined, identity, directory, env: {}, makeClient: host.makeClient, registrationFile: file });
    expect((await failure(access.sessionActive())).code).toBe('not_configured');
    fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:4096', pid: process.pid }));
    // The first read passes its first check and fails the second: the result is discarded and the binding forgotten.
    expect((await failure(access.sessionGet('s'))).code).toBe('wrong_instance');
    fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:4097', pid: process.pid }));
    await access.sessionGet('s');
    expect(host.made.map((made) => made.baseUrl)).toEqual(['http://127.0.0.1:4096', 'http://127.0.0.1:4097']);
  });

  it('refuses a FIFO at the registration path by its type, opening it without waiting for a writer', async () => {
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-managed-'));
    scratch.push(dir);
    const fifo = path.join(dir, 'service.json');
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    // This test holds the FIFO open for writing, so even a blocking open would return instead of hanging the suite.
    const writer = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    const opened = spyOn(fs, 'openSync');
    try {
      const host = fakeServer([ok], sessions);
      const error = await failure(createVerifiedReadAccess({ server: undefined, identity, directory, env: {}, makeClient: host.makeClient, registrationFile: fifo }).sessionActive());
      expect(error.code).toBe('not_configured');
      expect(error.message).toContain('not a regular file');
      expect(host.made).toEqual([]);
      // Without O_NONBLOCK a FIFO with no writer would block this process in the open, before its type is known.
      const flags = opened.mock.calls.find(([file]) => file === fifo)?.[1] as number;
      expect(flags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
      expect(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)).toBe(0);
    } finally {
      opened.mockRestore();
      fs.closeSync(writer);
    }
  });

  it('refuses a malformed identity reply without reading, and binds a corrected registration on the next call', async () => {
    for (const envelope of [null, 'text', { output: null }, { output: ['held-nonce'] }, {}]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-managed-'));
      scratch.push(dir);
      const file = path.join(dir, 'service.json');
      fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:4096', pid: process.pid }));
      const host = fakeServer([{ envelope }, ok], sessions);
      const access = createVerifiedReadAccess({ server: undefined, identity, directory, env: {}, makeClient: host.makeClient, registrationFile: file });
      expect((await failure(access.sessionGet('s'))).code).toBe('wrong_instance');
      // One identity check, no read, and no second attempt in the same call.
      expect([host.calls.length, host.reads]).toEqual([1, []]);
      fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:4097', pid: process.pid }));
      expect(((await access.sessionGet('s')) as any).id).toBe('s');
      expect(host.made.map((made) => made.baseUrl)).toEqual(['http://127.0.0.1:4096', 'http://127.0.0.1:4097']);
    }
  });

  it('keeps endpoint and client text out of every managed failure, with fixed local diagnoses and the same codes', async () => {
    const file = registration({ url: 'http://127.0.0.1:4096', pid: process.pid, password: 'managed-secret' });
    const canary = 'CANARY-ENDPOINT-TEXT';
    const leaks = (error: Error) => [canary, 'managed-secret', Buffer.from('opencode:managed-secret').toString('base64')].filter((text) => error.message.includes(text));
    // Binding failures: each identity answer below carries the canary where the endpoint or client would put text.
    for (const [answer, code] of [
      [declaredError('UnauthorizedError', canary), 'unauthorized'],
      [new ClientError('UnexpectedStatus', { cause: { status: 401, body: canary }, detail: canary }), 'unauthorized'],
      [new ClientError('Transport', { cause: new Error(canary) }), 'unreachable'],
      [declaredError('LocationNotFoundError', canary), 'wrong_location'],
      [Object.assign(new Error(canary), { type: 'rpc.unavailable' }), 'wrong_location'],
      [{ nonce: canary, directory }, 'wrong_instance'],
      [{ nonce: 'held-nonce', directory: canary }, 'wrong_location'],
    ] as const) {
      const error = await failure(createVerifiedReadAccess({ server: undefined, identity, directory, env: {}, makeClient: fakeServer([answer]).makeClient, registrationFile: file }).sessionActive());
      expect([error.code, leaks(error)]).toEqual([code, []]);
    }
    // Failed reads between passing checks: a client error is a plain local failure, and a Hive refusal keeps its code.
    const reading = (sessionsTable: Record<string, Session>, patch: (client: any) => void = () => {}) => createVerifiedReadAccess({
      server: undefined, identity, directory, env: {}, registrationFile: file,
      makeClient: (options) => { const client = fakeServer([ok], sessionsTable).makeClient(options); patch(client); return client; },
    });
    const thrown = await failure(reading(sessions, (client) => { client.session.active = async () => { throw new ClientError('Transport', { cause: new Error(canary) }); }; }).sessionActive());
    expect([thrown instanceof ReadAccessError, leaks(thrown)]).toEqual([false, []]);
    const settlement = await failure(reading(sessions, (client) => { client.experimental = { job: { list: async () => { throw new Error(canary); } } }; }).childSettlement({ parentID: 'parent', childID: 'child' }));
    expect([settlement instanceof ReadAccessError, leaks(settlement)]).toEqual([false, []]);
    const missing = await failure(reading({ caller: { id: 'caller', location: { directory } } }).checkTarget({ callerID: 'caller', targetID: canary }));
    expect([missing.code, leaks(missing)]).toEqual(['target_unavailable', []]);
    const liar = await failure(reading({ s: { id: canary, location: { directory } } }).sessionGet('s'));
    expect([liar.code, leaks(liar)]).toEqual(['inconsistent_lookup', []]);
    const displaced = await failure(reading({ caller: { id: 'caller', location: { directory: canary } } }).checkTarget({ callerID: 'caller', targetID: 'caller' }));
    expect([displaced.code, leaks(displaced)]).toEqual(['caller_displaced', []]);
  });

  it('rejects a cancelled managed read with the caller\'s own reason', async () => {
    const file = registration({ url: 'http://127.0.0.1:4096', pid: process.pid });
    const controller = new AbortController();
    const reason = new Error('caller gone');
    const access = createVerifiedReadAccess({
      server: undefined, identity, directory, env: {}, registrationFile: file,
      makeClient: (options) => {
        const client = fakeServer([ok]).makeClient(options);
        client.session.active = async () => { controller.abort(reason); throw new Error('CANARY-ENDPOINT-TEXT'); };
        return client;
      },
    });
    expect(await failure(access.sessionActive(controller.signal))).toBe(reason as any);
    // Cancelled before it starts: the caller's reason, without reading the registration or making a client.
    const host = fakeServer([ok]);
    const early = new AbortController();
    early.abort(reason);
    const absent = path.join(path.dirname(file), 'absent.json');
    expect(await failure(createVerifiedReadAccess({ server: undefined, identity, directory, env: {}, makeClient: host.makeClient, registrationFile: absent }).sessionActive(early.signal))).toBe(reason as any);
    expect(host.made).toEqual([]);
  });

  it('defaults to the official client\'s registration path, fixed from the environment when the access is created', async () => {
    const saved = process.env.XDG_STATE_HOME;
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-managed-state-'));
    scratch.push(state);
    process.env.XDG_STATE_HOME = state;
    let access;
    try {
      access = createVerifiedReadAccess({ server: undefined, identity, directory, env: {}, makeClient: fakeServer([ok]).makeClient });
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
    }
    const error = await failure(access.sessionActive());
    expect(error.code).toBe('not_configured');
    expect(error.message).toContain(path.join(state, 'opencode', 'service.json'));
    expect(fs.readdirSync(state)).toEqual([]);
  });
});

describe('binding lifecycle', () => {
  it('does not let a late failure of an old binding evict the binding that replaced it', async () => {
    // Binding 1 answers its first identity check only when the test releases it; every other check passes at once.
    let releaseOld: (answer: Answer) => void = () => {};
    const made: number[] = [];
    const makeClient = () => {
      const id = made.push(made.length + 1);
      let checks = 0;
      return {
        rpc: {
          call: () => id === 1 && ++checks === 1
            ? new Promise((resolve) => { releaseOld = (answer) => resolve({ output: answer }); })
            : Promise.resolve({ output: id === 1 ? { nonce: 'other-process', directory } : { nonce: 'held-nonce', directory } }),
        },
        session: { active: async () => ({ client: id }) },
      } as any;
    };
    const access = createVerifiedReadAccess({ server, identity, directory, env, makeClient });
    const late = access.sessionActive();
    // A second read on binding 1 fails its check, so binding 1 is forgotten and the next read makes binding 2.
    expect((await failure(access.sessionActive())).code).toBe('wrong_instance');
    expect(await access.sessionActive()).toEqual({ client: 2 } as any);
    // The deferred check on binding 1 now fails, and binding 2 stays.
    releaseOld({ nonce: 'other-process', directory });
    expect((await failure(late)).code).toBe('wrong_instance');
    expect(await access.sessionActive()).toEqual({ client: 2 } as any);
    expect(made).toEqual([1, 2]);
  });
});

/** A loopback HTTP server answering the official client's routes for one session family, with its own password. */
function realServer(options: { password?: string; redirectTo?: string } = {}) {
  const hits: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const family: Record<string, { id: string; parentID?: string; location: { directory: string } }> = {
    parent: { id: 'parent', location: { directory } },
    child: { id: 'child', parentID: 'parent', location: { directory } },
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      hits.push(`${request.method} ${url.pathname}`);
      if (options.redirectTo) return new Response(null, { status: 307, headers: { location: `${options.redirectTo}${url.pathname}${url.search}` } });
      if (options.password !== undefined && request.headers.get('authorization') !== `Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`) {
        return json({ _tag: 'UnauthorizedError', message: 'Authentication required' }, 401);
      }
      if (request.method === 'POST' && url.pathname === `/api/rpc/${encodeURIComponent(IDENTITY_RPC_ID)}/get`) return json({ output: { nonce: 'held-nonce', directory } });
      const session = /^\/api\/session\/([^/]+)$/.exec(url.pathname);
      if (session && session[1] !== 'active') return family[session[1]!] ? json({ data: family[session[1]!] }) : json({ _tag: 'SessionNotFoundError', message: 'missing' }, 404);
      if (/^\/api\/session\/[^/]+\/message$/.test(url.pathname)) return json({ data: [{ id: 'msg_1', type: 'user', text: 'hi' }], cursor: {} });
      if (url.pathname === '/api/experimental/job') return json({ data: [] });
      if (url.pathname === '/api/session') {
        const parentID = url.searchParams.get('parentID');
        return json({ data: Object.values(family).filter((entry) => entry.parentID === parentID), cursor: {} });
      }
      if (/^\/api\/session\/[^/]+\/inbox$/.test(url.pathname)) return json({ data: [] });
      if (url.pathname === '/api/session/active') return json({ data: {} });
      return json({ message: 'unexpected route' }, 500);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

describe('managed read access over the official client', () => {
  it('authorizes a trace target, reads history and checks continuation settlement through the managed registration', async () => {
    const host = realServer({ password: 'managed-secret' });
    try {
      const access = createVerifiedReadAccess({ server: undefined, identity, directory, registrationFile: registration({ url: host.url, pid: process.pid, password: 'managed-secret' }) });
      expect(await access.checkTarget({ callerID: 'parent', targetID: 'child' })).toEqual({ relationship: 'child', placement: 'this-location', observed: { parentID: 'parent', directory } });
      expect(((await access.messageList({ sessionID: 'child', limit: 1, order: 'asc' } as any)) as any).data).toEqual([{ id: 'msg_1', type: 'user', text: 'hi' }]);
      expect(await access.childSettlement({ parentID: 'parent', childID: 'child' })).toEqual({ settled: true });
      expect(host.hits).toContain('GET /api/session/child/inbox');
    } finally {
      host.stop();
    }
  });

  it('names rejected managed credentials from the declared 401 and never follows a redirect off the registered endpoint', async () => {
    const host = realServer({ password: 'current-secret' });
    const target = realServer();
    const redirecting = realServer({ redirectTo: target.url });
    try {
      const stale = createVerifiedReadAccess({ server: undefined, identity, directory, registrationFile: registration({ url: host.url, pid: process.pid, password: 'stale-secret' }) });
      const unauthorized = await failure(stale.sessionActive());
      expect(unauthorized.code).toBe('unauthorized');
      expect(unauthorized.message).not.toContain('stale-secret');
      const redirected = createVerifiedReadAccess({ server: undefined, identity, directory, registrationFile: registration({ url: redirecting.url, pid: process.pid, password: 'managed-secret' }) });
      expect((await failure(redirected.sessionActive())).code).toBe('unreachable');
      expect(redirecting.hits).toHaveLength(1);
      expect(target.hits).toEqual([]);
    } finally {
      for (const server of [host, target, redirecting]) server.stop();
    }
  });
});

describe('identity replies of an undocumented shape over the official client', () => {
  /** A loopback server whose identity route answers with `status` and `body`. */
  const identityServer = (status: number, body: unknown) => Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  });

  it('refuses a directory or declared error message that is not text with its typed code and no converted value', async () => {
    const cases: Array<[number, unknown, string]> = [
      [200, { output: { nonce: 'held-nonce', directory: { nested: ['value'] } } }, 'wrong_location'],
      [404, { _tag: 'LocationNotFoundError', message: { nested: ['value'] }, location: { directory } }, 'wrong_location'],
      [401, { _tag: 'UnauthorizedError', message: { nested: ['value'] } }, 'unauthorized'],
    ];
    for (const [status, body, code] of cases) {
      const host = identityServer(status, body);
      try {
        const access = createVerifiedReadAccess({ server: { url: `http://127.0.0.1:${host.port}`, username: 'opencode' }, identity, directory });
        const error = await failure(access.sessionActive());
        expect([error instanceof ReadAccessError, error.code, error.message.includes('[object'), error.message.includes('nested')]).toEqual([true, code, false, false]);
      } finally {
        host.stop(true);
      }
    }
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
    // `observed` is the parent and location the answer was computed from, so a caller needs no second read for it.
    expect(await access.checkTarget({ callerID: 'caller', targetID: 'caller' })).toEqual({ relationship: 'self', placement: 'this-location', observed: { directory } });
    expect(await access.checkTarget({ callerID: 'caller', targetID: 'child' })).toEqual({ relationship: 'child', placement: 'this-location', observed: { parentID: 'caller', directory } });
    expect(await access.checkTarget({ callerID: 'caller', targetID: 'grandchild' })).toEqual({ relationship: 'descendant', placement: 'other-location', observed: { parentID: 'child', directory: '/work/elsewhere' } });
    expect(await access.checkTarget({ callerID: 'caller', targetID: 'stranger' })).toEqual({ relationship: 'other', placement: 'this-location', observed: { directory } });
    expect(await access.checkTarget({ callerID: 'child', targetID: 'caller' })).toEqual({ relationship: 'other', placement: 'this-location', observed: { directory } });
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
  type State = { jobs?: Job[]; inbox?: Record<string, unknown[]>; active?: unknown; jobAnswer?: unknown; inboxAnswer?: unknown; listAnswer?: unknown; extra?: Session[]; unlisted?: string[]; getErrors?: Record<string, unknown> };
  /**
   * A server with sessions, jobs, inboxes and active executions. `parent` owns `child` and `sibling`; `child` owns
   * `helper`, which owns `quiet`. Job rows exist only where a test adds them, so `quiet` is a descendant no job names.
   * The session list pages children in ID order through an opaque offset cursor. Every read is logged, so the order is
   * visible.
   */
  function settlementServer(state: State, registrationFile?: string) {
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
      const get = client.session.get;
      client.session.get = async (input: { sessionID: string }, options?: { signal?: AbortSignal }) => {
        if (state.getErrors?.[input.sessionID] === undefined) return get(input, options);
        base.reads.push(`get:${input.sessionID}`);
        throw state.getErrors[input.sessionID];
      };
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
    const where = registrationFile === undefined ? { server } : { server: undefined, registrationFile };
    return { reads: base.reads, access: createVerifiedReadAccess({ ...where, identity, directory, env, makeClient }) };
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
      [{ active: { child: { type: 'running' } } }, 'active', 'session child has an active execution'],
      [{ active: { quiet: { type: 'running' } } }, 'active', 'descendant session quiet of child has an active execution'],
    ];
    for (const [state, signal, detail] of cases) expect(await settle(state).result).toEqual({ settled: false, signal: signal as any, detail });
  });

  it('keeps the signal and replaces every returned field with local text when the managed service reports work', async () => {
    const file = registration({ url: 'http://127.0.0.1:4096', pid: process.pid });
    const canary = 'CANARY-RETURNED-FIELD';
    // Each returned field the explicit detail would repeat carries the canary: job id, kind, session and status, and
    // the IDs of the sessions whose inbox or execution shows work.
    const cases: Array<[State, string]> = [
      [{ jobs: [{ id: canary, kind: 'subagent', sessionID: 'parent', status: canary, childSessionID: 'child' }] }, 'job'],
      [{ jobs: [{ id: canary, kind: canary, sessionID: canary, status: canary }], extra: [{ id: canary, parentID: 'quiet', location: { directory } }] }, 'job'],
      [{ extra: [{ id: canary, parentID: 'quiet', location: { directory } }], inbox: { [canary]: [{ id: canary }] } }, 'inbox'],
      [{ extra: [{ id: canary, parentID: 'quiet', location: { directory } }], unlisted: [canary], active: { [canary]: { type: canary } } }, 'active'],
    ];
    for (const [state, signal] of cases) {
      const managed = await settlementServer(state, file).access.childSettlement({ parentID: 'parent', childID: 'child' });
      expect(managed).toMatchObject({ settled: false, signal });
      expect((managed as { detail: string }).detail).toContain('managed OpenCode service');
      expect(JSON.stringify(managed)).not.toContain(canary);
      // The same answer from an explicit server keeps its detail.
      expect(await settlementServer(state).access.childSettlement({ parentID: 'parent', childID: 'child' })).toMatchObject({ settled: false, signal, detail: expect.stringContaining(canary) });
    }
    expect(await settlementServer({}, file).access.childSettlement({ parentID: 'parent', childID: 'child' })).toEqual({ settled: true });
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
      // The 2.4.1 SessionsResponse always carries `cursor`, and `next` is a cursor string, null or absent, never empty.
      { listAnswer: { data: [] } }, { listAnswer: { data: [], cursor: null } }, { listAnswer: { data: [], cursor: { next: '' } } },
      // A full page always has a next cursor on 2.4.1, so one without it would end the tree read early.
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

  it('settles a root session from its own tree without reading a parent job list', async () => {
    const host = settlementServer({ jobs: [subagentJob('parent', 'child')] });
    // The parent's subagent job for the child is not part of the parent's own tree reads.
    expect(await host.access.sessionSettlement({ sessionID: 'parent' })).toEqual({ settled: false, signal: 'job', detail: 'subagent job child of session parent is running' });
    expect(host.reads[0]).toBe('jobs:parent+');
    const idle = settlementServer({});
    expect(await idle.access.sessionSettlement({ sessionID: 'parent' })).toEqual({ settled: true });
    expect(idle.reads).not.toContain('jobs:parent');
  });

  it('attributes the live jobs and executions under a parent to its direct children in one pass, without job text', async () => {
    const host = settlementServer({
      jobs: [
        subagentJob('parent', 'child'),
        { id: 'sh_quiet', kind: 'shell', sessionID: 'quiet', status: 'running' },
        { id: 'sh_parent', kind: 'shell', sessionID: 'parent', status: 'running' },
        { id: 'odd', kind: 'Shell: rm -rf /tmp/x', sessionID: 'helper', status: 'running' },
      ],
      active: { sibling: { type: 'running' }, stranger: { type: 'running' }, parent: { type: 'running' } },
      extra: [{ id: 'stranger', location: { directory: '/work/other' } }],
    });
    expect(await host.access.parentActivity({ parentID: 'parent' })).toEqual({ children: [
      { sessionID: 'child', activeExecution: false, jobs: [
        { kind: 'subagent', status: 'running', owner: 'parent' },
        { kind: 'shell', status: 'running', owner: 'descendant' },
        { kind: 'other', status: 'running', owner: 'descendant' },
      ] },
      { sessionID: 'sibling', activeExecution: true, jobs: [] },
    ] });
    // One job list filtered to the parent's tree and one active read; parent chains only for sessions with live work.
    expect(host.reads.filter((read) => read.startsWith('jobs:') || read === 'active')).toEqual(['jobs:parent+', 'active']);
    const gets = host.reads.filter((read) => read.startsWith('get:'));
    expect(new Set(gets).size).toBe(gets.length);

    const displaced = settlementServer({ extra: [{ id: 'parent', location: { directory: '/work/other' } }] });
    expect((await failure(displaced.access.parentActivity({ parentID: 'parent' }))).code).toBe('caller_displaced');
  });

  it('skips an active session the server reports gone, and refuses every other failed read of one, so live work is never hidden', async () => {
    const file = registration({ url: 'http://127.0.0.1:4096', pid: process.pid });
    const gone = [
      declaredError('SessionNotFoundError', 'Session not found: ephemeral'),
      new ClientError('UnexpectedStatus', { cause: { status: 404 }, detail: '404' }),
    ];
    const failed = [
      new ClientError('UnexpectedStatus', { cause: { status: 500 }, detail: '500' }),
      new ClientError('Transport', { cause: new Error('socket hang up') }),
      new Error('database is locked'),
    ];
    for (const where of [undefined, file]) {
      for (const error of gone) {
        const host = settlementServer({ active: { ephemeral: { type: 'running' } }, getErrors: { ephemeral: error } }, where);
        expect(await host.access.parentActivity({ parentID: 'parent' })).toEqual({ children: [] });
        expect(await host.access.childSettlement({ parentID: 'parent', childID: 'child' })).toEqual({ settled: true });
        expect(host.reads.filter((read) => read === 'get:ephemeral')).toHaveLength(2);
      }
      for (const error of failed) {
        const host = settlementServer({ active: { ephemeral: { type: 'running' } }, getErrors: { ephemeral: error } }, where);
        expect((await failure(host.access.parentActivity({ parentID: 'parent' }))).code).toBe('target_unavailable');
        expect((await failure(host.access.childSettlement({ parentID: 'parent', childID: 'child' }))).code).toBe('target_unavailable');
      }
    }
  });

  it('refuses an active session whose ancestor the server reports gone, because removing a parent does not stop its children', async () => {
    const file = registration({ url: 'http://127.0.0.1:4096', pid: process.pid });
    const gone = [
      declaredError('SessionNotFoundError', 'Session not found: gone'),
      new ClientError('UnexpectedStatus', { cause: { status: 404 }, detail: '404' }),
    ];
    for (const where of [undefined, file]) {
      for (const error of gone) {
        // `leaf` still runs while the host has already deleted its parent's row.
        const host = settlementServer({ extra: [{ id: 'leaf', parentID: 'gone', location: { directory } }], active: { leaf: { type: 'running' } }, getErrors: { gone: error } }, where);
        expect((await failure(host.access.parentActivity({ parentID: 'parent' }))).code).toBe('target_unavailable');
        expect((await failure(host.access.childSettlement({ parentID: 'parent', childID: 'child' }))).code).toBe('target_unavailable');
        expect(host.reads.filter((read) => read === 'get:gone')).toHaveLength(2);
      }
    }
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
