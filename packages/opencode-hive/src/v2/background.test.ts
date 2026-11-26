import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Effect, Exit, Scope } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import { FeatureService, SessionService, getNativeSessionsPath } from 'hive-core';
import { registerBackground, type BackgroundReadAccess } from './background.js';
import { ReadAccessError, type ChildSettlement, type ParentActivity } from './client.js';
import { createHiveAuthority } from './registration.js';
import { createHiveToolRegistrar } from './tools.js';

// The live child tools read the caller's direct children when they are called: who the children are comes from the
// in-process session list, their feature, task and run from Hive's bindings, and whether work still runs under them
// from the verified read client. Nothing is recorded.

const LIVE_TOOLS = ['hive_background_cancel', 'hive_background_status'];

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function projectRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(`/tmp/hive-v2-background-${process.pid}-`));
  cleanup.push(root);
  fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
  return root;
}

type Session = { id: string; parentID?: string; agent?: string; outcome?: string; location: { directory: string } };

/**
 * A host with the domains the tools use. `parent` has children `child-a` (working), `child-b` and `child-c` in this
 * location and `child-away` in another; `child-a` has the grandchild `grand`. `other` is another primary.
 */
function fakeHost(root: string, options: {
  interrupted?: boolean;
  settlement?: (input: { parentID: string; childID: string }) => Promise<ChildSettlement>;
  activity?: (input: { parentID: string }) => Promise<ParentActivity>;
  /** More direct children of `parent` in this location, listed after the others. */
  extraChildren?: number;
  /** Runs after each list page is read, as the host's updates would between pages. */
  afterPage?: (sessions: Map<string, Session>) => void;
} = {}) {
  const here = { directory: root };
  const sessions = new Map<string, Session>([
    ['parent', { id: 'parent', agent: 'swarm-orchestrator', location: here }],
    ['other', { id: 'other', agent: 'hive-builder', location: here }],
    ['child-a', { id: 'child-a', parentID: 'parent', agent: 'forager-worker', location: here }],
    ['child-b', { id: 'child-b', parentID: 'parent', agent: 'scout-researcher', outcome: 'succeeded', location: here }],
    ['child-c', { id: 'child-c', parentID: 'parent', agent: 'forager-worker', outcome: 'failed', location: here }],
    ['child-away', { id: 'child-away', parentID: 'parent', agent: 'forager-worker', location: { directory: `${root}/packages/app` } }],
    ['grand', { id: 'grand', parentID: 'child-a', agent: 'scout-researcher', location: here }],
  ]);
  for (let index = 0; index < (options.extraChildren ?? 0); index++) {
    const id = `child-x${String(index).padStart(3, '0')}`;
    sessions.set(id, { id, parentID: 'parent', agent: 'scout-researcher', outcome: 'succeeded', location: here });
  }
  const tools = new Map<string, any>();
  const interrupts: Array<{ sessionID: string; resume?: boolean }> = [];
  const reads: string[] = [];
  const lists: number[] = [];
  const context = {
    location: { directory: root, project: { id: 'project', directory: root, canonical: root } },
    tool: { transform: (cb: any) => Effect.sync(() => { cb({ add: (info: any) => tools.set(info.name, info) }); return { dispose: Effect.void }; }) },
    session: {
      get: ({ sessionID }: { sessionID: string }) => Effect.suspend(() => sessions.has(sessionID) ? Effect.succeed(sessions.get(sessionID)!) : Effect.fail(new Error('unknown'))),
      // Pages in map order, the order of last update, after the last session of the previous page (a keyset cursor);
      // like the 2.4.1 host, a nonempty page always has a next cursor.
      list: (input: { parentID?: string; cursor?: string; limit: number }) => Effect.sync(() => {
        const parentID = input.cursor === undefined ? input.parentID : JSON.parse(input.cursor).parentID;
        const children = [...sessions.values()].filter((session) => session.parentID === parentID);
        const offset = input.cursor === undefined ? 0 : children.findIndex((session) => session.id === JSON.parse(input.cursor!).after) + 1;
        lists.push(offset);
        const data = children.slice(offset, offset + input.limit);
        options.afterPage?.(sessions);
        return { data, cursor: { previous: null, next: data.length ? JSON.stringify({ parentID, after: data.at(-1)!.id }) : null } };
      }),
      interrupt: (input: { sessionID: string; resume?: boolean }) => Effect.sync(() => { interrupts.push(input); return { interrupted: options.interrupted ?? true }; }),
    },
  } as unknown as Plugin.Context;
  const readAccess: BackgroundReadAccess = {
    childSettlement: async (input) => {
      reads.push(`settlement:${input.childID}`);
      return options.settlement ? options.settlement(input) : { settled: true };
    },
    parentActivity: async (input) => {
      reads.push(`activity:${input.parentID}`);
      return options.activity ? options.activity(input) : { children: [{ sessionID: 'child-a', activeExecution: false, jobs: [{ kind: 'shell', status: 'running', owner: 'child' }] }] };
    },
  };
  return { context, tools, interrupts, reads, lists, readAccess };
}

async function registered(options: Parameters<typeof fakeHost>[1] & { prepare?: (root: string) => void } = {}, transport: 'codemode' | 'direct' = 'codemode') {
  const root = projectRoot();
  new FeatureService(root).create('alpha');
  const sessionService = new SessionService(root, 'opencode-v2');
  sessionService.trackGlobal('child-a', { parentSessionId: 'parent', featureName: 'alpha', taskFolder: '01-build' });
  sessionService.trackGlobal('child-b', { parentSessionId: 'parent', adHocRunId: 'run-1' });
  sessionService.trackGlobal('child-c', { parentSessionId: 'parent', featureName: 'alpha', taskFolder: '02-test' });
  options.prepare?.(root);
  const host = fakeHost(root, options);
  const authority = createHiveAuthority(host.context, {});
  const registrar = createHiveToolRegistrar({ context: host.context, readTransport: transport, guard: authority.guardHive });
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(registerBackground({ context: host.context, registrar, services: { sessionService }, readAccess: host.readAccess }).pipe(Scope.provide(scope)));
  const exit = (name: string, args: unknown, sessionID = 'parent', agent = 'swarm-orchestrator') =>
    Effect.runPromiseExit(host.tools.get(name).execute(args, { sessionID, agent, messageID: 'msg', id: 'call', progress: () => Effect.void }));
  const run = async (name: string, args: unknown, sessionID?: string) => ((await exit(name, args, sessionID)) as Exit.Success<any>).value.output;
  return { root, host, exit, run };
}

describe('v2 live child tools', () => {
  it('registers the two tools through the registrar as direct calls, for primaries only', async () => {
    for (const transport of ['codemode', 'direct'] as const) {
      const { host, exit } = await registered({}, transport);
      expect([...host.tools.keys()].sort()).toEqual(LIVE_TOOLS);
      for (const info of host.tools.values()) expect(info.options).toEqual({ codemode: false });
      // The guard reads the caller's parent: a child session is refused before any read.
      expect(Exit.isSuccess(await exit('hive_background_status', {}, 'child-a', 'swarm-orchestrator'))).toBe(false);
      expect(Exit.isSuccess(await exit('hive_background_cancel', { sessionID: 'grand' }, 'child-a', 'swarm-orchestrator'))).toBe(false);
      expect(host.interrupts).toEqual([]);
    }
  });

  it('lists the working direct children in this location with their bound scope, and the rest only on request', async () => {
    const { host, run } = await registered();
    const output = await run('hive_background_status', {});
    expect(output).toMatchObject({ success: true, coverage: 'jobs_and_executions' });
    expect(output.working).toEqual([{ sessionID: 'child-a', agent: 'forager-worker', scope: { feature: 'alpha', task: '01-build' }, jobs: [{ kind: 'shell', status: 'running', owner: 'child' }], activeExecution: false }]);
    expect(output.children).toBeUndefined();
    expect(host.reads).toEqual(['activity:parent']);

    const all = await run('hive_background_status', { includeSettled: true });
    // The child in another location is not listed; the grandchild is not a direct child.
    expect(all.children).toEqual([
      { sessionID: 'child-b', agent: 'scout-researcher', outcome: 'succeeded', scope: { adHocRunId: 'run-1' } },
      { sessionID: 'child-c', agent: 'forager-worker', outcome: 'failed', scope: { feature: 'alpha', task: '02-test' } },
    ]);

    const filtered = await run('hive_background_status', { includeSettled: true, task: '02-test' });
    expect(filtered.working).toEqual([]);
    expect(filtered.children.map((child: any) => child.sessionID)).toEqual(['child-c']);
    expect((await run('hive_background_status', { includeSettled: true, adHocRunId: 'run-1' })).children.map((child: any) => child.sessionID)).toEqual(['child-b']);
  });

  it('still lists the children, marked unchecked, when the live reads are unavailable', async () => {
    const { run } = await registered({ activity: async () => { throw new ReadAccessError('not_configured', 'set server'); } });
    const output = await run('hive_background_status', { feature: 'alpha' });
    expect(output.observation).toEqual({ available: false, readAccess: 'not_configured', message: 'set server' });
    expect(output.children.map((child: any) => child.sessionID)).toEqual(['child-a', 'child-c']);
    expect(output.working).toBeUndefined();
    expect(output.warnings.join(' ')).toContain('Do not treat a child as settled from this result');
  });

  it('lists each child once across full pages, though a working child updated while paging reappears on a later page', async () => {
    let moved = false;
    const { host, run } = await registered({
      extraChildren: 250,
      // The working child is updated after the first page is read, so the host lists it again at the end.
      afterPage: (sessions) => {
        if (moved) return;
        moved = true;
        const child = sessions.get('child-a')!;
        sessions.delete('child-a');
        sessions.set('child-a', child);
      },
    });
    const output = await run('hive_background_status', { includeSettled: true });
    // A full page then a short one, which ends the list without another request.
    expect(host.lists).toHaveLength(2);
    expect(output.working.map((child: any) => child.sessionID)).toEqual(['child-a']);
    expect(output.children).toHaveLength(252);
    expect(new Set(output.children.map((child: any) => child.sessionID)).size).toBe(252);
    expect(output.children.some((child: any) => child.sessionID === 'child-a')).toBe(false);
  });

  it('still answers with the in-process reads when a live read fails without a typed refusal', async () => {
    const failed = async () => { throw new Error('A read from the managed OpenCode service failed.'); };
    const { run } = await registered({ activity: failed, settlement: failed, interrupted: false });
    const listed = await run('hive_background_status', { feature: 'alpha' });
    expect(listed.observation).toEqual({ available: false, readAccess: 'read_failed', message: 'A read from the managed OpenCode service failed.' });
    expect(listed.children.map((child: any) => child.sessionID)).toEqual(['child-a', 'child-c']);
    expect(await run('hive_background_status', { sessionID: 'child-a' })).toMatchObject({ success: true, sessionID: 'child-a', settlement: { available: false, readAccess: 'read_failed' } });
    expect(await run('hive_background_cancel', { sessionID: 'child-a' })).toMatchObject({ success: true, interrupted: false, settlement: { available: false, readAccess: 'read_failed' } });
  });

  it('lists children without scope when the binding index is unreadable, and leaves the index as found', async () => {
    let index = '';
    const { run } = await registered({
      prepare: (root) => {
        index = getNativeSessionsPath(root, 'opencode-v2');
        fs.writeFileSync(index, '{ not json');
      },
    });
    const output = await run('hive_background_status', { includeSettled: true });
    expect(output.working).toEqual([{ sessionID: 'child-a', agent: 'forager-worker', scope: {}, jobs: [{ kind: 'shell', status: 'running', owner: 'child' }], activeExecution: false }]);
    expect(output.warnings).toEqual([expect.stringContaining('Hive could not read its child bindings')]);
    expect(fs.readFileSync(index, 'utf8')).toBe('{ not json');
  });

  it('refuses one child whose binding does not match the requested scope, without reading its settlement', async () => {
    const { host, run } = await registered();
    expect(await run('hive_background_status', { sessionID: 'child-a', task: '02-test' })).toMatchObject({ success: false, reason: 'scope_mismatch' });
    expect(await run('hive_background_status', { sessionID: 'child-b', feature: 'alpha' })).toMatchObject({ success: false, reason: 'scope_mismatch' });
    expect(host.reads).toEqual([]);
    expect(await run('hive_background_status', { sessionID: 'child-a', feature: 'alpha', task: '01-build' })).toMatchObject({ success: true, sessionID: 'child-a', settled: true });
    expect(host.reads).toEqual(['settlement:child-a']);
  });

  it('reads one direct child\'s whole tree, and refuses any other session without reading it', async () => {
    const working = await registered({ settlement: async () => ({ settled: false, signal: 'job', detail: 'shell job sh_1 of session child-a is running' }) });
    expect(await working.run('hive_background_status', { sessionID: 'child-a' })).toEqual({
      success: true, sessionID: 'child-a', agent: 'forager-worker', scope: { feature: 'alpha', task: '01-build' },
      settled: false, signal: 'job', detail: 'shell job sh_1 of session child-a is running', settlement: { available: true },
    });
    const settled = await registered();
    expect(await settled.run('hive_background_status', { sessionID: 'child-b' })).toMatchObject({ success: true, outcome: 'succeeded', settled: true, settlement: { available: true } });

    const unavailable = await registered({ settlement: async () => { throw new ReadAccessError('wrong_instance', 'replaced server'); } });
    const degraded = await unavailable.run('hive_background_status', { sessionID: 'child-a' });
    expect(degraded).toMatchObject({ success: true, sessionID: 'child-a', settlement: { available: false, readAccess: 'wrong_instance' } });
    expect(degraded.settled).toBeUndefined();

    for (const sessionID of ['parent', 'grand', 'child-away', 'other', 'missing']) {
      expect(await settled.run('hive_background_status', { sessionID })).toMatchObject({ success: false, reason: 'not_a_child' });
    }
    expect(settled.host.reads).toEqual(['settlement:child-b']);
  });
});

describe('v2 hive_background_cancel', () => {
  it('interrupts only the caller\'s own direct child in this location, with resume disabled', async () => {
    const { host, run } = await registered();
    // Self, a grandchild, a child in another location and another primary's session are all refused unread.
    for (const sessionID of ['parent', 'grand', 'child-away', 'other']) {
      expect(await run('hive_background_cancel', { sessionID })).toMatchObject({ success: false, reason: 'not_a_child' });
    }
    expect(await run('hive_background_cancel', { sessionID: 'child-a' }, 'other')).toMatchObject({ success: false, reason: 'not_a_child' });
    expect(host.interrupts).toEqual([]);

    const output = await run('hive_background_cancel', { sessionID: 'child-a', reason: 'Wrong scope' });
    expect(host.interrupts).toEqual([{ sessionID: 'child-a', resume: false }]);
    expect(output).toMatchObject({ success: true, sessionID: 'child-a', interrupted: true });
    expect(output.message).toContain('stops only its active model execution');
    expect(output.message).toContain('keep running');
    expect(output.message).toContain('An error or cancellation report ends only that execution, not those commands and jobs, so confirm that the child\'s tree has settled before you start an overlapping writer.');
    // An interrupted execution needs no settlement read to decide what happened.
    expect(host.reads).toEqual([]);
  });

  it('reads the settlement when the host had no execution to interrupt, because background work may remain', async () => {
    const { host, run } = await registered({ interrupted: false, settlement: async () => ({ settled: false, signal: 'job', detail: 'shell job sh_1 of session child-a is running' }) });
    expect(await run('hive_background_cancel', { sessionID: 'child-a' })).toMatchObject({
      success: true, interrupted: false, settled: false, signal: 'job', settlement: { available: true },
    });
    expect(host.reads).toEqual(['settlement:child-a']);

    const unreadable = await registered({ interrupted: false, settlement: async () => { throw new ReadAccessError('not_configured', 'set server'); } });
    expect(await unreadable.run('hive_background_cancel', { sessionID: 'child-c' })).toMatchObject({ success: true, interrupted: false, settlement: { available: false, readAccess: 'not_configured' } });
  });
});
