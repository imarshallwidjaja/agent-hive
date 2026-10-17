import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Effect, Exit, Scope, Stream } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import { BackgroundJobService, getNativeBackgroundJobsPath } from 'hive-core';
import { createV2BackgroundLifecycle, hostRuntimeId, registerBackground, type BackgroundLaunch } from './background.js';
import { createHiveAuthority } from './registration.js';
import { createHiveToolRegistrar } from './tools.js';

// The v2 board observes the host's structured identities and events: launch rows from dispatch, completion
// notifications from synthetic inbox metadata, and execution settlement. It never parses notification text and never
// records a cancellation the host did not report. A notification names the child but not the launching call, so it is
// recorded as an uncertain observation of the child's live launches, never as one launch's terminal outcome.

const BOARD_TOOLS = ['hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel'];

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

function lifecycle(root = projectRoot(), runtimeId = 'runtime-a') {
  const service = new BackgroundJobService(root, 'opencode-v2');
  const warnings: string[] = [];
  return { root, service, warnings, background: createV2BackgroundLifecycle({ projectRoot: root, service, runtimeId, warn: (message) => warnings.push(message) }) };
}

const launch = (overrides: Partial<BackgroundLaunch> = {}): BackgroundLaunch => ({
  parentSessionID: 'parent', callID: 'call-1', childSessionID: 'child-1', agent: 'forager-worker', description: 'Work', primaryAgent: 'swarm-orchestrator', ...overrides,
});

/** The host's completion notification: a synthetic inbox item for the parent, as `SubagentCompletion.deliver` admits it. */
const completion = (parent: string, child: string, state: string, inboxID = `inbox-${child}-${state}`) => ({
  type: 'session.inbox.enqueued',
  data: {
    sessionID: parent,
    inboxID,
    item: { type: 'synthetic', delivery: 'steer', payload: { text: `<subagent sessionID="${child}" state="${state}" description="Work">\nresult text\n</subagent>`, description: 'Work', metadata: { source: 'subagent', childID: child, agent: 'forager-worker', state } } },
  },
});

describe('v2 background observation', () => {
  it('records a completion notification for the parent and child as an uncertain observation, never a terminal outcome', () => {
    const { service, background } = lifecycle();
    background.recordLaunch(launch());

    // A user message copying the shape, another parent's notification and a non-subagent synthetic are not evidence.
    background.handleEvent({ type: 'session.inbox.enqueued', data: { ...completion('parent', 'child-1', 'completed').data, item: { type: 'user', payload: { text: 'done' } } } });
    background.handleEvent(completion('other-parent', 'child-1', 'completed'));
    background.handleEvent({ type: 'session.inbox.enqueued', data: { sessionID: 'parent', inboxID: 'x', item: { type: 'synthetic', payload: { text: 'restart', metadata: { notice: 'restart' } } } } });
    expect(service.resolve('child-1')).toMatchObject({ runtimeState: 'running' });

    background.handleEvent(completion('parent', 'child-1', 'completed'));
    const row = service.resolve('child-1')!;
    expect(row).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(row.terminalUnreconciled).toBeUndefined();
    expect(row.lastStatusError).toBe('The host notified the parent that child child-1 ended (completed). The notification names the child, not the launching call, so Hive does not record it as this launch\'s outcome; inspect the child and archive this observation with decision "ignored".');
  });

  it('keeps other projects and other owners out of scope', () => {
    const { root, service, background } = lifecycle();
    const foreignRoot = projectRoot();
    service.registerLaunch({ taskId: 'child-1', sessionId: 'child-1', callId: 'call-f', agentName: 'forager-worker', scope: { projectRoot: foreignRoot, parentSessionId: 'parent' } });
    const v1 = new BackgroundJobService(root, 'opencode-v1');
    v1.registerLaunch({ taskId: 'child-1', sessionId: 'child-1', callId: 'call-v1', agentName: 'forager-worker', scope: { projectRoot: root, parentSessionId: 'parent' } });

    background.handleEvent(completion('parent', 'child-1', 'completed'));
    expect(service.listScoped({ projectRoot: foreignRoot })[0]).toMatchObject({ runtimeState: 'running' });
    expect(v1.resolve('child-1')).toMatchObject({ runtimeState: 'running' });
    expect(fs.existsSync(getNativeBackgroundJobsPath(root, 'opencode-v2'))).toBe(true);
  });

  it('marks every live launch of a reused child uncertain and leaves terminal and archived rows as they were', () => {
    const { service, background } = lifecycle();
    // Rows a host recorded as terminal or archived before (v2 itself never records a notification as terminal).
    background.recordLaunch(launch({ callID: 'call-0' }));
    service.markTerminal('parent:job-1', 'completed', { resultSummary: 'earlier result' });
    background.recordLaunch(launch({ callID: 'call-archived' }));
    service.markIgnored('parent:job-2', 'Archived the observation.');
    background.recordLaunch(launch({ callID: 'call-1' }));
    background.recordLaunch(launch({ callID: 'call-2' }));

    background.handleEvent(completion('parent', 'child-1', 'error', 'one'));
    const rows = service.listScoped({}, { includeArchived: true });
    const row = (callId: string) => rows.find((job) => job.callId === callId)!;
    expect(row('call-0')).toMatchObject({ runtimeState: 'completed', resultSummary: 'earlier result' });
    expect(row('call-0').lastStatusError).toBeUndefined();
    expect(row('call-archived')).toMatchObject({ runtimeState: 'running', archiveReason: 'ignored' });
    expect(row('call-archived').lastStatusError).toBeUndefined();
    for (const callId of ['call-1', 'call-2']) {
      expect(row(callId)).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
      expect(row(callId).lastStatusError).toContain('child child-1 ended (error)');
    }
  });

  it('records settlement and the notification as uncertain observations with what the host reported', () => {
    const { service, background } = lifecycle();
    background.recordLaunch(launch());

    background.handleEvent({ type: 'session.execution.interrupted', data: { sessionID: 'child-1', reason: 'user' } });
    expect(service.resolve('child-1')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true, lastStatusError: 'Native execution was interrupted (user) and settled; the completion notification has not been observed yet.' });

    background.handleEvent(completion('parent', 'child-1', 'cancelled'));
    expect(service.resolve('child-1')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(service.resolve('child-1')?.lastStatusError).toContain('child child-1 ended (cancelled)');

    background.recordLaunch(launch({ childSessionID: 'child-2', callID: 'call-2' }));
    background.handleEvent({ type: 'session.execution.failed', data: { sessionID: 'child-2', error: { type: 'provider', message: 'rate limited' } } });
    expect(service.resolve('child-2')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true, lastStatusError: 'Native execution failed (rate limited); the completion notification has not been observed yet.' });

    background.recordLaunch(launch({ childSessionID: 'child-3', callID: 'call-3' }));
    background.handleEvent({ type: 'session.execution.interrupted', data: { sessionID: 'child-3', reason: 'shutdown' } });
    expect(service.resolve('child-3')?.lastStatusError).toBe('Native execution was interrupted by host shutdown; the host may resume this child after it restarts. Inspect before acting.');

    background.recordLaunch(launch({ childSessionID: 'child-4', callID: 'call-4' }));
    background.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'child-4' } });
    expect(service.resolve('child-4')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });

    // After an interrupt the host publishes the notification before the settlement; settlement adds nothing to an
    // observation that is already uncertain and keeps the notified state.
    background.recordLaunch(launch({ childSessionID: 'child-5', callID: 'call-5' }));
    background.handleEvent(completion('parent', 'child-5', 'cancelled'));
    background.handleEvent({ type: 'session.execution.interrupted', data: { sessionID: 'child-5', reason: 'user' } });
    expect(service.resolve('child-5')?.lastStatusError).toContain('child child-5 ended (cancelled)');
  });

  it('applies a notification seen before its launch row only to that parent and child, once', () => {
    const { service, background } = lifecycle();
    background.handleEvent(completion('parent', 'child-1', 'completed'));
    background.recordLaunch(launch({ parentSessionID: 'other-parent', callID: 'call-other' }));
    expect(service.listScoped({}).find((job) => job.callId === 'call-other')).toMatchObject({ runtimeState: 'running' });

    background.recordLaunch(launch());
    expect(service.listScoped({}).find((job) => job.callId === 'call-1')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    // The held notification was used up by that row.
    background.recordLaunch(launch({ callID: 'call-later' }));
    expect(service.listScoped({}).find((job) => job.callId === 'call-later')).toMatchObject({ runtimeState: 'running' });
  });

  it('keeps a later continuation uncertain, never terminal, when an earlier launch\'s notification arrives after its row', () => {
    // Launch A of child-1 has no row (both registration attempts failed); continuation B recorded the only live row.
    const late = lifecycle();
    late.background.recordLaunch(launch({ callID: 'call-B' }));
    late.background.handleEvent(completion('parent', 'child-1', 'completed', 'inbox-A'));
    expect(late.service.resolve('child-1')).toMatchObject({ callId: 'call-B', runtimeState: 'unknown', statusUncertain: true });
    expect(late.service.resolve('child-1')?.terminalUnreconciled).toBeUndefined();

    // The same after a plugin reload: the new activation has no memory of A, B's row is still the only live one.
    const root = projectRoot();
    const before = lifecycle(root);
    before.background.recordLaunch(launch({ callID: 'call-B' }));
    const after = lifecycle(root);
    after.background.handleEvent(completion('parent', 'child-1', 'completed', 'inbox-A'));
    expect(after.service.resolve('child-1')).toMatchObject({ callId: 'call-B', runtimeState: 'unknown', statusUncertain: true });

    // The same when A's row was archived before its notification arrived.
    const archived = lifecycle();
    archived.background.recordLaunch(launch({ callID: 'call-A' }));
    archived.service.updateRuntimeState('parent:job-1', 'unknown', { statusUncertain: true });
    archived.service.markIgnored('parent:job-1', 'Inspected; archived the observation.');
    archived.background.recordLaunch(launch({ callID: 'call-B' }));
    archived.background.handleEvent(completion('parent', 'child-1', 'completed', 'inbox-A'));
    const rows = archived.service.listScoped({}, { includeArchived: true });
    expect(rows.find((job) => job.callId === 'call-B')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(rows.find((job) => job.callId === 'call-A')).toMatchObject({ runtimeState: 'unknown', archiveReason: 'ignored' });
    expect(rows.find((job) => job.callId === 'call-A')?.lastStatusError).toBeUndefined();
  });

  it('discards a held completion that predates the launch bound for the same child, and keeps one that follows the barrier', () => {
    const { service, warnings, background } = lifecycle();
    // A completion for a launch that has no row (its registration failed) is held, then the child is continued.
    background.handleEvent(completion('parent', 'child-1', 'completed', 'older'));
    background.launchBound('parent', 'child-1');
    background.recordLaunch(launch({ callID: 'call-b' }));
    expect(service.resolve('child-1')).toMatchObject({ callId: 'call-b', runtimeState: 'running' });
    expect(warnings.join('\n')).toContain('predates');

    // A completion that arrives after the barrier may belong to a call the host later moved to the background.
    background.launchBound('parent', 'child-4');
    background.handleEvent(completion('parent', 'child-4', 'completed', 'moved'));
    background.recordLaunch(launch({ childSessionID: 'child-4', callID: 'call-d' }));
    expect(service.resolve('child-4')).toMatchObject({ callId: 'call-d', runtimeState: 'unknown', statusUncertain: true });
  });

  it('uses the host process and the activation location, not the plugin activation, as the runtime epoch', () => {
    expect(hostRuntimeId('/work/proj')).toBe(hostRuntimeId('/work/proj'));
    expect(hostRuntimeId('/work/proj')).toStartWith(`opencode-v2:pid-${process.pid}-`);
    expect(hostRuntimeId('/work/proj')).not.toBe(hostRuntimeId('/work/proj/packages/app'));

    const root = projectRoot();
    const earlier = lifecycle(root, 'runtime-old');
    earlier.background.recordLaunch(launch());
    const current = lifecycle(root, 'runtime-new');
    const board = current.background.observer.promptBoard('parent');
    expect(board?.text).toContain('stale/orphan recovery');
    expect(current.service.resolve('child-1')?.staleAt).toBeDefined();
  });
});

/** A host with the domains the board uses: tool registration, the parent's context hook, interrupt and events. */
function fakeHost(root: string, events: Array<{ type: string; data: unknown }> = [], options: { interrupt?: (input: { sessionID: string; resume?: boolean }) => Effect.Effect<{ interrupted: boolean }, Error>; stream?: Stream.Stream<{ type: string; data: unknown }, Error> } = {}) {
  const tools = new Map<string, any>();
  const contextHooks: Array<(event: any) => Effect.Effect<void>> = [];
  const interrupts: Array<{ sessionID: string; resume?: boolean }> = [];
  const sessions = new Map<string, { id: string; parentID?: string }>([['parent', { id: 'parent' }], ['child-1', { id: 'child-1', parentID: 'parent' }]]);
  const context = {
    location: { directory: root, project: { id: 'project', directory: root, canonical: root } },
    tool: { transform: (cb: any) => Effect.sync(() => { cb({ add: (info: any) => tools.set(info.name, info) }); return { dispose: Effect.void }; }) },
    session: {
      get: ({ sessionID }: { sessionID: string }) => Effect.suspend(() => sessions.has(sessionID) ? Effect.succeed(sessions.get(sessionID)!) : Effect.fail(new Error('unknown'))),
      hook: (name: string, cb: any) => Effect.sync(() => { if (name === 'context') contextHooks.push(cb); return { dispose: Effect.void }; }),
      interrupt: (input: { sessionID: string; resume?: boolean }) => Effect.suspend(() => { interrupts.push(input); return options.interrupt?.(input) ?? Effect.succeed({ interrupted: true }); }),
    },
    // A live host stream stays open; the listed events are delivered first.
    event: { subscribe: () => options.stream ?? Stream.fromIterable(events).pipe(Stream.concat(Stream.never)) },
  } as unknown as Plugin.Context;
  return { context, tools, contextHooks, interrupts };
}

async function registered(transport: 'codemode' | 'direct' = 'codemode', events: Array<{ type: string; data: unknown }> = [], options: Parameters<typeof fakeHost>[2] = {}, before?: (board: { root: string; service: BackgroundJobService }) => void) {
  const { root, service, background, warnings } = lifecycle();
  before?.({ root, service });
  const host = fakeHost(root, events, options);
  const authority = createHiveAuthority(host.context, {});
  const registrar = createHiveToolRegistrar({ context: host.context, readTransport: transport, guard: authority.guardHive });
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(registerBackground({ context: host.context, registrar, projectRoot: root, service, lifecycle: background, runtimeId: 'runtime-a' }).pipe(Scope.provide(scope)));
  const run = (name: string, args: unknown, sessionID = 'parent', agent = 'swarm-orchestrator') =>
    Effect.runPromiseExit(host.tools.get(name).execute(args, { sessionID, agent, messageID: 'msg', id: 'call', progress: () => Effect.void }));
  const status = async () => ((await run('hive_background_status', {})) as Exit.Success<any>).value.output;
  return { root, service, background, warnings, host, run, status, scope };
}

/** An event stream that delivers nothing until `stop` is called, then ends normally or fails. */
function stoppableStream(end: 'normally' | 'with an error') {
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  const stream = end === 'normally'
    ? Stream.fromEffect(Effect.promise(() => stopped)).pipe(Stream.drain) as Stream.Stream<{ type: string; data: unknown }, Error>
    : Stream.fromEffect(Effect.promise(() => stopped).pipe(Effect.andThen(Effect.fail(new Error('event bus closed')))));
  return { stream, stop };
}

const settle = async (done: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !done(); attempt += 1) await Bun.sleep(5);
};

describe('v2 background board tools', () => {
  it('registers the four board tools through the registrar as direct calls under either transport', async () => {
    for (const transport of ['codemode', 'direct'] as const) {
      const { host } = await registered(transport);
      expect([...host.tools.keys()].sort()).toEqual([...BOARD_TOOLS].sort());
      for (const info of host.tools.values()) expect(info.options).toEqual({ codemode: false });
    }
  });

  it('runs the shared guard: primaries see their board, child sessions are denied', async () => {
    const { background, run } = await registered();
    background.recordLaunch(launch());
    const status = await run('hive_background_status', {});
    expect(Exit.isSuccess(status)).toBe(true);
    const output = (status as Exit.Success<any>).value.output;
    // The v2 registrar now reports the calling agent, so the display-only primaryAgent matches v1.
    expect(output.scope).toEqual({ projectRoot: expect.any(String), parentSessionId: 'parent', primaryAgent: 'swarm-orchestrator' });
    expect(output.jobs.map((job: any) => job.taskId)).toEqual(['child-1']);
    expect(output.recommendedNextAction.reasonCode).toBe('native_completion_wait_only');

    const child = await run('hive_background_status', {}, 'child-1', 'swarm-orchestrator');
    expect(Exit.isSuccess(child)).toBe(false);
  });

  it('interrupts with resume disabled and records acknowledgement, not cancellation', async () => {
    const { service, background, run, host } = await registered();
    background.recordLaunch(launch());
    const exit = await run('hive_background_cancel', { identifier: 'child-1', reason: 'Wrong scope' });
    const output = (exit as Exit.Success<any>).value.output;
    expect(host.interrupts).toEqual([{ sessionID: 'child-1', resume: false }]);
    expect(output).toMatchObject({ success: true, runtimeCancelled: false, interruptAcknowledged: true });
    expect(output.scopeMessage).toContain('does not prove the worker stopped');
    expect(service.resolve('child-1')).toMatchObject({ runtimeState: 'running', cancelReason: 'Wrong scope' });
    expect(service.resolve('child-1')?.cancelRequestedAt).toBeDefined();

    // Settlement and the notification are observations of the child, still not a recorded cancellation of this launch.
    background.handleEvent({ type: 'session.execution.interrupted', data: { sessionID: 'child-1', reason: 'user' } });
    background.handleEvent(completion('parent', 'child-1', 'cancelled'));
    expect(service.resolve('child-1')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true, cancelReason: 'Wrong scope' });
    expect(service.resolve('child-1')?.lastStatusError).toContain('ended (cancelled)');
  });

  it('reports an interrupt that reached no active execution, or failed, as unconfirmed', async () => {
    const idle = await registered('codemode', [], { interrupt: () => Effect.succeed({ interrupted: false }) });
    idle.background.recordLaunch(launch());
    const idleOutput = ((await idle.run('hive_background_cancel', { identifier: 'child-1', reason: 'Stop' })) as Exit.Success<any>).value.output;
    expect(idleOutput).toMatchObject({ runtimeCancelled: false, interruptAcknowledged: false });
    expect(idleOutput.runtimeMessage).toContain('runtime cancellation is not confirmed');

    const broken = await registered('codemode', [], { interrupt: () => Effect.fail(new Error('host unavailable')) });
    broken.background.recordLaunch(launch());
    const brokenOutput = ((await broken.run('hive_background_cancel', { identifier: 'child-1', reason: 'Stop' })) as Exit.Success<any>).value.output;
    expect(brokenOutput).toMatchObject({ runtimeCancelled: false, runtimeMessage: 'Interrupt request failed: host unavailable' });
    expect(broken.service.resolve('child-1')).toMatchObject({ runtimeState: 'running' });
  });

  it("shows the board on the parent's requests only and acknowledges it when the parent's turn settles", async () => {
    const { service, background, host } = await registered();
    background.recordLaunch(launch());
    const request = (sessionID: string) => ({ sessionID, system: [] as Array<{ type: string; text: string }> });

    const other = request('someone-else');
    await Effect.runPromise(host.contextHooks[0]!(other));
    expect(other.system).toEqual([]);

    const running = request('parent');
    await Effect.runPromise(host.contextHooks[0]!(running));
    expect(running.system[0]!.text).toStartWith('## Background Job Board\n- parent:job-1 (child-1) forager-worker\n  runtime: running');

    // The notified child stays on the board as an uncertain observation with an inspection hint.
    background.handleEvent(completion('parent', 'child-1', 'completed'));
    const parent = request('parent');
    await Effect.runPromise(host.contextHooks[0]!(parent));
    expect(parent.system[0]!.text).toContain('runtime: unknown; status error: The host notified the parent that child child-1 ended (completed).');
    expect(parent.system[0]!.text).toContain('diagnostic: hive_task_trace({ task_id: "child-1" })');

    // A terminal row (v2 records none itself, so the test sets one) is acknowledged when the parent's turn settles.
    background.recordLaunch(launch({ childSessionID: 'child-2', callID: 'call-2' }));
    service.markTerminal('child-2', 'completed');
    await Effect.runPromise(host.contextHooks[0]!(request('parent')));
    expect(service.resolve('child-2')?.promptNotifiedInSessionId).toBe('parent');
    background.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'parent' } });
    expect(service.resolve('child-2')?.promptAcknowledgedAt).toBeDefined();
  });

  it('starts healthy: a first activation leaves new launches running and reports no observation problem', async () => {
    const { service, background, status } = await registered();
    background.recordLaunch(launch());
    expect(service.resolve('child-1')).toMatchObject({ runtimeState: 'running' });
    expect(service.resolve('child-1')?.statusUncertain).toBeUndefined();
    const output = await status();
    expect(output.observation).toBeUndefined();
    expect(output.recommendedNextAction.reasonCode).toBe('native_completion_wait_only');
  });

  it('marks rows an earlier plugin activation of this host left running as uncertain, since a completion may have been missed in the gap', async () => {
    const { service, background, run } = await registered('codemode', [], {}, ({ root, service }) => {
      const scope = { projectRoot: root, parentSessionId: 'parent' };
      service.registerLaunch({ taskId: 'child-1', sessionId: 'child-1', callId: 'call-1', agentName: 'forager-worker', runtimeId: 'runtime-a', scope });
      service.registerLaunch({ taskId: 'child-2', sessionId: 'child-2', callId: 'call-2', agentName: 'forager-worker', runtimeId: 'runtime-a', scope });
      service.registerLaunch({ taskId: 'child-3', sessionId: 'child-3', callId: 'call-3', agentName: 'forager-worker', runtimeId: 'runtime-a', scope });
      service.registerLaunch({ taskId: 'child-old', sessionId: 'child-old', callId: 'call-old', agentName: 'forager-worker', runtimeId: 'runtime-from-another-process', scope });
      service.markTerminal('child-3', 'completed');
    });

    const gap = service.resolve('child-1');
    expect(gap).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(gap?.lastStatusError).toContain('after a plugin reload');
    expect(service.resolve('child-3')).toMatchObject({ runtimeState: 'completed' });
    // A row from another host process is the epoch classification's to mark; activation leaves it running.
    expect(service.resolve('child-old')).toMatchObject({ runtimeState: 'running' });
    expect(service.resolve('child-old')?.statusUncertain).toBeUndefined();

    // The uncertainty can be archived; a notification that does arrive replaces the reload diagnostic with its own.
    const ignored = await run('hive_background_reconcile', { identifier: 'child-1', decision: 'ignored', summary: 'Checked the child session; archiving the observation.' });
    expect((ignored as Exit.Success<any>).value.output).toMatchObject({ success: true, archived: true, state: 'ignored_archived' });
    background.handleEvent(completion('parent', 'child-2', 'completed'));
    expect(service.resolve('child-2')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(service.resolve('child-2')?.lastStatusError).toContain('ended (completed)');

    // The reload is a transition, not a lasting gap: launches after it stay running.
    background.recordLaunch(launch({ childSessionID: 'child-new', callID: 'call-new' }));
    expect(service.resolve('child-new')).toMatchObject({ runtimeState: 'running' });
    expect(service.resolve('child-new')?.statusUncertain).toBeUndefined();
  });

  it('leaves the live rows of another location in the same project alone when this location activates', async () => {
    const { service, background } = await registered('codemode', [], {}, ({ root, service }) => {
      service.registerLaunch({ taskId: 'child-1', sessionId: 'child-1', callId: 'call-1', agentName: 'forager-worker', runtimeId: hostRuntimeId(path.join(root, 'packages', 'app')), scope: { projectRoot: root, parentSessionId: 'parent' } });
    });
    // This activation's runtime is `runtime-a`; the other location's activation observes its own launches.
    expect(service.resolve('child-1')).toMatchObject({ runtimeState: 'running' });
    expect(service.resolve('child-1')?.statusUncertain).toBeUndefined();
    background.recordLaunch(launch({ childSessionID: 'child-2', callID: 'call-2' }));
    expect(service.resolve('child-2')).toMatchObject({ runtimeState: 'running' });
  });

  for (const end of ['with an error', 'normally'] as const) {
    it(`marks existing and later launches uncertain when the event observation ends ${end}`, async () => {
      const { stream, stop } = stoppableStream(end);
      const { service, background, status } = await registered('codemode', [], { stream });
      background.recordLaunch(launch());
      expect(service.resolve('child-1')).toMatchObject({ runtimeState: 'running' });
      expect((await status()).observation).toBeUndefined();

      stop();
      await settle(() => service.resolve('child-1')?.runtimeState !== 'running');
      expect(service.resolve('child-1')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
      expect(service.resolve('child-1')?.lastStatusError).toContain(end === 'normally' ? 'the host event stream ended' : 'event bus closed');

      // Nothing observes the next launch's notification either.
      background.recordLaunch(launch({ childSessionID: 'child-2', callID: 'call-2' }));
      expect(service.resolve('child-2')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
      const output = await status();
      expect(output.observation).toMatchObject({ healthy: false, uncertaintyPending: false });
      expect(output.observation.reason).toContain(end === 'normally' ? 'the host event stream ended' : 'event bus closed');
      expect(output.recommendedNextAction.reasonCode).toBe('uncertain_background_jobs_visible');
    });
  }

  it('does not report success when an uncertainty write fails: observation degrades and the write is retried', async () => {
    const { service, background, status, warnings } = await registered();
    background.recordLaunch(launch());
    const update = service.updateRuntimeState.bind(service);
    // The notification's write fails, and so does the immediate retry that follows it.
    let failures = 2;
    service.updateRuntimeState = ((...args: Parameters<typeof update>) => {
      if (failures > 0) { failures -= 1; throw new Error('board write failed'); }
      return update(...args);
    }) as typeof service.updateRuntimeState;

    background.handleEvent(completion('parent', 'child-1', 'completed'));
    expect(service.resolve('child-1')).toMatchObject({ runtimeState: 'running' });
    expect(warnings.join('\n')).toContain('board write failed');

    // The next board read retries and reports the degraded observation.
    const output = await status();
    expect(service.resolve('child-1')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(output.observation).toMatchObject({ healthy: false, uncertaintyPending: false });
    expect(output.observation.reason).toContain('board write failed');
    background.recordLaunch(launch({ childSessionID: 'child-2', callID: 'call-2' }));
    expect(service.resolve('child-2')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
  });

  it('marks a launch recorded after its activation stopped observing uncertain', async () => {
    const { service, background, scope } = await registered();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    background.recordLaunch(launch());
    expect(service.resolve('child-1')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
  });

  it('observes host events from the subscription for the activation scope', async () => {
    const root = projectRoot();
    const service = new BackgroundJobService(root, 'opencode-v2');
    service.registerLaunch({ taskId: 'child-1', sessionId: 'child-1', callId: 'call-1', agentName: 'forager-worker', runtimeId: 'runtime-a', scope: { projectRoot: root, parentSessionId: 'parent' } });
    const background = createV2BackgroundLifecycle({ projectRoot: root, service, runtimeId: 'runtime-a', warn: () => {} });
    const host = fakeHost(root, [{ type: 'session.step.started', data: { sessionID: 'child-1' } }, completion('parent', 'child-1', 'completed')]);
    const registrar = createHiveToolRegistrar({ context: host.context, readTransport: 'codemode', guard: () => Effect.void });
    const scope = Effect.runSync(Scope.make());
    await Effect.runPromise(registerBackground({ context: host.context, registrar, projectRoot: root, service, lifecycle: background, runtimeId: 'runtime-a' }).pipe(Scope.provide(scope)));
    // The row predates this activation, so activation marked it uncertain; the delivered notification is recorded on it.
    await settle(() => service.resolve('child-1')?.lastStatusError?.includes('ended (completed)') === true);
    expect(service.resolve('child-1')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(service.resolve('child-1')?.lastStatusError).toContain('ended (completed)');
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
