import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Effect, Exit, Fiber, Scope, Stream } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import { FeatureService, PlanService, TaskService, getNativeBackgroundJobsPath, type ResolvedCustomAgentConfig } from 'hive-core';
import plugin from '../index.js';
import { createHiveServices, type HiveServices } from '../runtime/hive-services.js';
import { createBackgroundOperations } from '../background/operations.js';
import { createV2BackgroundLifecycle } from './background.js';
import { NATIVE_SUBAGENT_TOOL, registerDispatch } from './dispatch.js';
import { createHiveAuthority } from './registration.js';

// Dispatch owns what Hive adds to the host's own subagent tool: the parent's route and constraints, the composed
// prompt, managed-model control, the continuation preflight, the child-binding barrier on the awaited progress update,
// and the background launch row. The fake host below stands in for the native tool only: it runs `execute.before`
// hooks on the call's input, creates the child or, for a continuation, switches it to the requested agent, selects the
// model as the host does, awaits progress, then admits the child's prompt with its own prefix, recording what Hive had
// bound at that moment. It never binds anything itself. Its `active` set is the server's active-session read that the
// catalog's verified read access returns, and its `catalog` is the host's effective agent catalog.

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type ModelRef = { providerID: string; id: string; variant?: string };
type Session = { id: string; parentID?: string; agent?: string; model?: ModelRef };
type Admission = { child: string; text: string; boundParent?: string; boundFeature?: string | null; boundConstraints?: string; boundAgent?: string };

/** A model reference as the host stores it; `test/<id>` unless written out. */
const ref = (id: string, variant?: string, providerID = 'test'): ModelRef => ({ providerID, id, ...(variant === undefined ? {} : { variant }) });
/** The host's parse of a `providerID/modelID#variant` argument. */
const parseRef = (value: string): ModelRef => {
  const [model, variant] = value.split('#');
  const [providerID, ...id] = model!.split('/');
  return ref(id.join('/'), variant, providerID);
};

const PLAN = '# Plan\n\n## Tasks\n\n### 1. Build\n\nBuild it.\n';

function project(features: string[] = ['alpha']) {
  const root = fs.realpathSync(fs.mkdtempSync(`/tmp/hive-v2-dispatch-${process.pid}-`));
  cleanup.push(root);
  fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
  for (const feature of features) {
    new FeatureService(root).create(feature);
    new PlanService(root).write(feature, PLAN);
    new TaskService(root).sync(feature);
  }
  return root;
}

/**
 * The host's subagent tool, reduced to the steps whose order matters: run `execute.before` hooks, create the child on
 * `model ?? agent.model ?? parent.model`, or check a continued one, switch it to the requested agent and set
 * `model ?? (switched ? agent.model : unchanged)`, await progress, admit the prompt (prefixing new children), then
 * return `running` for background calls or `completed`. Every agent is configured for `test/model-of-<agent>` unless
 * `catalog.models` says otherwise (`null` is a model-less entry); `catalog.missing` and `catalog.error` fail lookups.
 */
function fakeHost(services: HiveServices, options: { pauseBeforeProgress?: Effect.Effect<void>; reportedParent?: (child: string, parent: string) => string | undefined; promptFails?: boolean; blockForever?: boolean; backgrounded?: boolean; holdNewChild?: Promise<void>; holdContinuation?: Promise<void>; afterAdmission?: (child: string) => void; skipProgress?: boolean } = {}) {
  const sessions = new Map<string, Session>();
  const admissions: Admission[] = [];
  const nativeInputs: any[] = [];
  const switches: Array<{ child: string; agent?: string; model?: ModelRef }> = [];
  const catalog: { models: Map<string, ModelRef | null>; missing: Set<string>; error?: Error; reads: number } = { models: new Map(), missing: new Set(), reads: 0 };
  const configuredModel = (agent: string) => catalog.models.has(agent) ? catalog.models.get(agent) ?? undefined : ref(`model-of-${agent}`);
  const beforeHooks: Array<(event: any) => Effect.Effect<void, any>> = [];
  // The server's active sessions, as the catalog's verified read access reports them.
  const active = new Set<string>();
  const activityState: { reads: number; error?: Error; gate?: Promise<void> } = { reads: 0 };
  const activity = {
    sessionActive: async () => {
      activityState.reads += 1;
      const snapshot = Object.fromEntries([...active].map((id) => [id, { type: 'running' as const }]));
      if (activityState.gate) await activityState.gate;
      if (activityState.error) throw activityState.error;
      return snapshot;
    },
  };
  let next = 0;
  const transforms: Array<(editor: any) => void> = [];
  const context = {
    tool: {
      transform: (cb: any) => Effect.sync(() => { transforms.push(cb); return { dispose: Effect.void }; }),
      hook: (name: string, fn: any) => Effect.sync(() => { if (name === 'execute.before') beforeHooks.push(fn); return { dispose: Effect.void }; }),
    },
    agent: {
      get: ({ agentID }: { agentID: string }) => Effect.suspend(() => {
        catalog.reads += 1;
        if (catalog.error) return Effect.fail(catalog.error);
        if (catalog.missing.has(agentID)) return Effect.fail(new Error(`Agent not found: ${agentID}`));
        return Effect.succeed({ data: { id: agentID, model: configuredModel(agentID) } });
      }),
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) => Effect.suspend(() => {
        const session = sessions.get(sessionID);
        // Like the host's `Session.fromRow`, a stored model reports `default` when it has no variant.
        return session ? Effect.succeed({ ...session, ...(session.model === undefined ? {} : { model: { ...session.model, variant: session.model.variant ?? 'default' } }) }) : Effect.fail(new Error(`unknown session ${sessionID}`));
      }),
    },
  } as unknown as Plugin.Context;

  const nativeTool = {
    name: NATIVE_SUBAGENT_TOOL,
    description: 'native',
    input: {},
    options: { codemode: false },
    execute: (input: any, ctx: any) => Effect.gen(function* () {
      nativeInputs.push(input);
      let child: string;
      if (input.sessionID) {
        const existing = sessions.get(input.sessionID);
        if (!existing) return yield* Effect.fail(new Error(`Subagent session not found: ${input.sessionID}`));
        if (existing.parentID !== ctx.sessionID) return yield* Effect.fail(new Error(`Session ${existing.id} is not a child of the current session`));
        // Like the host, a continuation with another agent switches the child's agent and model before progress; an
        // explicit model wins, and a same-agent continuation otherwise keeps the child's model.
        const switched = existing.agent !== input.agent;
        const model = input.model !== undefined ? parseRef(input.model) : switched ? configuredModel(input.agent) : undefined;
        if (switched) existing.agent = input.agent;
        if (model !== undefined) existing.model = model;
        if (switched || model !== undefined) switches.push({ child: existing.id, agent: existing.agent, model: existing.model });
        child = existing.id;
      } else {
        child = `child-${++next}`;
        const model = input.model !== undefined ? parseRef(input.model) : configuredModel(input.agent) ?? sessions.get(ctx.sessionID)?.model;
        sessions.set(child, { id: child, parentID: options.reportedParent?.(child, ctx.sessionID) ?? ctx.sessionID, agent: input.agent, ...(model === undefined ? {} : { model }) });
      }
      if (options.pauseBeforeProgress) yield* options.pauseBeforeProgress;
      // A host that skips the awaited progress update (the qualified host never does) prompts an unbound child.
      if (!options.skipProgress) yield* ctx.progress({ sessionID: child, status: 'running' });
      if (options.promptFails) return yield* Effect.fail(new Error(`Failed to prompt subagent: ${child}`));
      const bound = services.sessionService.getGlobal(child);
      admissions.push({
        child,
        text: input.sessionID ? input.prompt : ['You are a subagent spawned by another session.', input.prompt].join('\n'),
        boundParent: bound?.parentSessionId,
        boundFeature: bound?.featureName,
        boundConstraints: bound?.standingConstraints,
        boundAgent: bound?.agent,
      });
      options.afterAdmission?.(child);
      if (options.blockForever) yield* Effect.never;
      if (options.holdNewChild && !input.sessionID) yield* Effect.promise(() => options.holdNewChild!);
      if (options.holdContinuation && input.sessionID) yield* Effect.promise(() => options.holdContinuation!);
      const status = input.background === true || options.backgrounded ? 'running' : 'completed';
      return { output: { sessionID: child, status, output: 'done' }, metadata: { sessionID: child, status } };
    }),
  };

  /** The effective subagent tool after every transform, as the host replays them on its own definition. */
  const subagent = () => {
    const tool = { ...nativeTool };
    for (const cb of transforms) cb({ add: () => {}, update: (id: string, fn: (info: any) => void) => { if (id === NATIVE_SUBAGENT_TOOL) fn(tool); } });
    return tool;
  };
  /** One subagent call: `execute.before` hooks rewrite the input in order, then the effective tool runs on the result. */
  const call = (parent: string, input: Record<string, unknown>, callID = `call-${parent}-${Math.random()}`, caller = 'swarm-orchestrator') => {
    const event = { tool: NATIVE_SUBAGENT_TOOL, sessionID: parent, agent: caller, callID, input: { description: 'Work', ...input } };
    return Effect.runPromiseExit(Effect.gen(function* () {
      for (const hook of beforeHooks) yield* hook(event);
      return yield* subagent().execute(event.input, { sessionID: parent, agent: caller, messageID: 'msg', id: callID, progress: () => Effect.void });
    }));
  };
  return { context, sessions, admissions, nativeInputs, switches, catalog, beforeHooks, active, activity, activityState, call, subagent };
}

async function setup(options: Parameters<typeof fakeHost>[1] & { features?: string[]; customAgents?: Record<string, ResolvedCustomAgentConfig> } = {}) {
  const root = project(options.features);
  const services = createHiveServices({ projectRoot: root, nativeObservationOwner: 'opencode-v2' });
  const host = fakeHost(services, options);
  const authority = createHiveAuthority(host.context, options.customAgents ?? {});
  const background = createV2BackgroundLifecycle({ projectRoot: root, service: services.backgroundJobService, runtimeId: 'runtime-a', warn: () => {} });
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(registerDispatch({ context: host.context, services, authority, background, activity: host.activity }).pipe(Scope.provide(scope)));
  return { root, services, host, background };
}

/** A child the parent dispatched earlier under its current route, now idle in the host. */
async function dispatchedChild(context: Awaited<ReturnType<typeof setup>>, options: { background?: boolean; callID?: string } = {}) {
  const exit = await context.host.call('parent', { agent: 'forager-worker', prompt: 'Hive task: 01-build', background: options.background }, options.callID ?? 'call-first');
  expect(Exit.isSuccess(exit)).toBe(true);
  return context.host.admissions.at(-1)!.child;
}

/** The host's completion notification for a background child, as the parent receives it. */
const completion = (parent: string, child: string, state = 'completed', inboxID = `inbox-${child}-${state}`) => ({
  type: 'session.inbox.enqueued',
  data: { sessionID: parent, inboxID, item: { type: 'synthetic', delivery: 'steer', payload: { text: `<subagent sessionID="${child}" state="${state}">\nresult\n</subagent>`, metadata: { source: 'subagent', childID: child, agent: 'forager-worker', state } } } },
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

/** The task or run a child's Hive binding names. */
const association = (services: HiveServices, child: string) => {
  const bound = services.sessionService.getGlobal(child);
  return { taskFolder: bound?.taskFolder, adHocRunId: bound?.adHocRunId };
};

const failureMessage = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return undefined;
  const reason = exit.cause.reasons.find((entry: any) => entry._tag === 'Fail') as any;
  return reason?.error?.message as string | undefined;
};

describe('v2 native dispatch', () => {
  it("composes the parent's authored prompt and binds the child to the parent's route before its prompt is admitted", async () => {
    const { root, services, host } = await setup();
    services.sessionService.setFeatureRoute('parent', 'alpha');
    services.sessionService.addStandingConstraint('parent', 'Use blocking calls only.');
    services.featureConstraintService.add('alpha', 'Public APIs only.');

    const authored = 'Hive task: 01-build\nBuild it.\n\n<!-- hive-route-snapshot:start -->\n## Hive route snapshot\nstale\n<!-- hive-route-snapshot:end -->';
    const exit = await host.call('parent', { agent: 'forager-worker', prompt: authored });
    expect(Exit.isSuccess(exit)).toBe(true);

    const [admission] = host.admissions;
    expect(admission.boundParent).toBe('parent');
    expect(admission.boundFeature).toBe('alpha');
    expect(admission.boundConstraints).toContain('Use blocking calls only.');
    // Hive composed the parent's own prompt; the host prefix comes after, on top of it.
    expect(host.nativeInputs[0].prompt.startsWith('Hive task: 01-build\nBuild it.\n\n<!-- hive-route-snapshot:start -->')).toBe(true);
    expect(admission.text.startsWith('You are a subagent spawned by another session.\nHive task: 01-build')).toBe(true);
    expect(admission.text).not.toContain('\nstale\n');
    expect(admission.text).toContain(`Route snapshot (JSON): {"projectRoot":"${root}","featureRoute":{"selected":true,"feature":"alpha"}}`);
    expect(admission.text).toContain('Feature constraints for "alpha" (revision 1):\nPublic APIs only.');
    expect(admission.text).toContain('<!-- hive-task-brief:start -->\n## Hive task brief\n');
    expect(admission.text).toContain('Task: 01-build - Build (pending)');
  });

  it('keeps parallel dispatches from different parents on their own captured snapshots', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { services, host } = await setup({ features: ['alpha', 'beta'], pauseBeforeProgress: Effect.promise(() => gate) });
    services.sessionService.setFeatureRoute('parent-a', 'alpha');
    services.sessionService.setFeatureRoute('parent-b', 'beta');
    services.sessionService.addStandingConstraint('parent-b', 'Only beta.');

    const first = host.call('parent-a', { agent: 'forager-worker', prompt: 'Hive task: 01-build' });
    const second = host.call('parent-b', { agent: 'forager-worker', prompt: 'Hive task: 01-build' });
    // Both calls captured their routes; changing a parent's route now must not leak into its in-flight dispatch.
    services.sessionService.setFeatureRoute('parent-a', 'beta');
    release();
    const exits = await Promise.all([first, second]);
    expect(exits.every(Exit.isSuccess)).toBe(true);

    const byParent = Object.fromEntries(host.admissions.map((admission) => [admission.boundParent, admission]));
    expect(byParent['parent-a'].boundFeature).toBe('alpha');
    expect(byParent['parent-a'].text).toContain('"feature":"alpha"');
    expect(byParent['parent-a'].boundConstraints).toBeUndefined();
    expect(byParent['parent-b'].boundFeature).toBe('beta');
    expect(byParent['parent-b'].boundConstraints).toContain('Only beta.');
  });

  it('keeps explicit-null routes featureless and attaches briefs only to Forager-based targets', async () => {
    const forager: ResolvedCustomAgentConfig = { baseAgent: 'forager-worker', description: 'Team forager' } as ResolvedCustomAgentConfig;
    const investigator: ResolvedCustomAgentConfig = { baseAgent: 'forager-investigator', description: 'Team investigator' } as ResolvedCustomAgentConfig;
    const { services, host } = await setup({ customAgents: { 'team-forager': forager, 'team-investigator': investigator } });
    services.sessionService.setFeatureRoute('null-parent', null);
    services.sessionService.setFeatureRoute('feature-parent', 'alpha');

    await host.call('null-parent', { agent: 'forager-worker', prompt: 'Hive task: 01-build' });
    await host.call('feature-parent', { agent: 'scout-researcher', prompt: 'Look around.' });
    await host.call('feature-parent', { agent: 'team-forager', prompt: 'Hive task: 01-build' });
    await host.call('feature-parent', { agent: 'forager-investigator', prompt: 'Hive task: 01-build' });
    await host.call('feature-parent', { agent: 'team-investigator', prompt: 'Hive task: 01-build' });

    const [nullRoute, scout, custom, builtInInvestigator, customInvestigator] = host.admissions;
    // Investigators carry the generic route snapshot but never the Forager task brief.
    for (const admission of [builtInInvestigator, customInvestigator]) {
      expect(admission.text).toContain('"featureRoute":{"selected":true,"feature":"alpha"}');
      expect(admission.text).not.toContain('hive-task-brief');
    }
    expect(nullRoute.text).toContain('"featureRoute":{"selected":true,"feature":null}');
    expect(nullRoute.text).not.toContain('hive-task-brief');
    expect(nullRoute.boundFeature).toBeNull();
    expect(scout.text).not.toContain('hive-task-brief');
    expect(custom.text).toContain('Task: 01-build - Build (pending)');
  });

  it('refuses a child the host does not report as a child of the calling session; it is never prompted', async () => {
    const { services, host } = await setup({ reportedParent: () => 'someone-else' });
    const exit = await host.call('parent', { agent: 'forager-worker', prompt: 'Do it.' });
    expect(failureMessage(exit)).toBe('Child session child-1 is not a child of parent; Hive did not bind it and the child was not prompted.');
    expect(host.admissions).toEqual([]);
    expect(services.sessionService.getGlobal('child-1')).toBeUndefined();
  });

  it('passes a continued session through unchanged and refuses a child of another parent before the host continues it', async () => {
    const { services, host } = await setup();
    host.sessions.set('child-x', { id: 'child-x', parentID: 'parent', agent: 'scout-researcher' });
    services.sessionService.trackGlobal('child-x', { parentSessionId: 'other-parent', featureName: 'alpha' });

    const refused = await host.call('parent', { agent: 'forager-worker', prompt: 'Continue.', sessionID: 'child-x' });
    expect(failureMessage(refused)).toBe('Child session child-x is already bound to parent other-parent; Hive did not overwrite it and the host was not asked to continue the child.');
    expect(host.nativeInputs).toEqual([]);
    expect(host.sessions.get('child-x')?.agent).toBe('scout-researcher');
    expect(services.sessionService.getGlobal('child-x')?.parentSessionId).toBe('other-parent');

    host.sessions.set('child-z', { id: 'child-z', parentID: 'someone-else' });
    const foreign = await host.call('parent', { agent: 'forager-worker', prompt: 'Continue.', sessionID: 'child-z' });
    expect(failureMessage(foreign)).toBe('Child session child-z is not a child of parent; Hive did not bind it and the host was not asked to continue the child.');
    expect(host.nativeInputs).toEqual([]);

    // Native idle qualifies adoption of a child with no Hive binding.
    host.sessions.set('child-y', { id: 'child-y', parentID: 'parent' });
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const continued = await host.call('parent', { agent: 'forager-worker', prompt: 'Continue.', sessionID: 'child-y' });
    expect(Exit.isSuccess(continued)).toBe(true);
    expect(host.nativeInputs[0].sessionID).toBe('child-y');
    expect(host.admissions[0]).toMatchObject({ child: 'child-y', boundParent: 'parent', boundFeature: 'alpha' });
    expect(host.admissions[0].text.startsWith('Continue.\n\n<!-- hive-route-snapshot:start -->')).toBe(true);
    expect(host.activityState.reads).toBe(1);
  });

  for (const binding of ['missing', 'parentless'] as const) {
    it(`qualifies adoption of a child with a ${binding} Hive binding before native effects`, async () => {
      const { services, host } = await setup();
      services.sessionService.setFeatureRoute('parent', 'alpha');
      host.sessions.set('unbound', { id: 'unbound', parentID: 'parent', agent: 'scout-researcher', model: ref('model-of-scout-researcher') });
      if (binding === 'parentless') services.sessionService.trackGlobal('unbound', { agent: 'scout-researcher' });
      const before = services.sessionService.getGlobal('unbound');
      host.active.add('unbound');

      const active = await host.call('parent', { agent: 'forager-worker', prompt: 'Adopt.', sessionID: 'unbound' });
      expect(failureMessage(active) ?? '').toContain('the host was not asked to continue the child');
      expect(host.nativeInputs).toEqual([]);
      expect(host.switches).toEqual([]);
      expect(host.admissions).toEqual([]);
      expect(host.sessions.get('unbound')).toMatchObject({ agent: 'scout-researcher', model: ref('model-of-scout-researcher') });
      expect(services.sessionService.getGlobal('unbound')).toEqual(before);

      host.active.delete('unbound');
      host.activityState.error = new Error('reader unavailable');
      const unknown = await host.call('parent', { agent: 'forager-worker', prompt: 'Adopt.', sessionID: 'unbound' });
      expect(failureMessage(unknown) ?? '').toContain('could not confirm');
      expect(host.nativeInputs).toEqual([]);
      expect(host.switches).toEqual([]);
      expect(host.admissions).toEqual([]);
      expect(services.sessionService.getGlobal('unbound')).toEqual(before);

      host.activityState.error = undefined;
      const idle = await host.call('parent', { agent: 'forager-worker', prompt: 'Adopt.', sessionID: 'unbound' });
      expect(Exit.isSuccess(idle)).toBe(true);
      expect(host.activityState.reads).toBe(3);
      expect(host.nativeInputs).toHaveLength(1);
      expect(host.switches).toEqual([{ child: 'unbound', agent: 'forager-worker', model: ref('model-of-forager-worker') }]);
      expect(host.admissions[0]).toMatchObject({ child: 'unbound', boundParent: 'parent', boundAgent: 'forager-worker', boundFeature: 'alpha' });
    });
  }

  it('records a background launch at the barrier in the v2 store, scoped by project, parent and call', async () => {
    const { root, services, host } = await setup();
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const exit = await host.call('parent', { agent: 'forager-worker', prompt: 'Hive task: 01-build', background: true }, 'call-bg');
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(services.backgroundJobService.resolve('child-1')).toMatchObject({
      taskId: 'child-1', sessionId: 'child-1', callId: 'call-bg', agentName: 'forager-worker', runtimeState: 'running', runtimeId: 'runtime-a',
      scope: { projectRoot: root, parentSessionId: 'parent', primaryAgent: 'swarm-orchestrator', feature: 'alpha' },
    });
    expect(fs.existsSync(getNativeBackgroundJobsPath(root, 'opencode-v2'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.hive', 'background-jobs.json'))).toBe(false);

    await host.call('parent', { agent: 'forager-worker', prompt: 'Foreground.' }, 'call-fg');
    expect(services.backgroundJobService.listScoped({ projectRoot: root })).toHaveLength(1);
  });

  it('associates a foreground or background child with the task or run its marker names, and scopes the launch row to that binding', async () => {
    const { root, services, host } = await setup();
    git(root, 'init', '-b', 'main');
    fs.writeFileSync(path.join(root, '.gitignore'), '.hive/\n');
    git(root, 'add', '.');
    git(root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'test: base');
    await services.adhocService().create({ runId: 'run-1' });
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const calls = [
      { agent: 'forager-worker', prompt: 'Hive task: 01-build' },
      { agent: 'forager-worker', prompt: 'Hive task: 01-build', background: true },
      { agent: 'scout-researcher', prompt: 'Hive run: run-1' },
      { agent: 'scout-researcher', prompt: 'Hive run: run-1', background: true },
      { agent: 'scout-researcher', prompt: 'Hive run: no-such-run', background: true },
    ];
    for (const [index, input] of calls.entries()) expect(Exit.isSuccess(await host.call('parent', input, `call-${index}`))).toBe(true);
    expect([1, 2, 3, 4, 5].map((n) => association(services, `child-${n}`))).toEqual([
      { taskFolder: '01-build', adHocRunId: undefined },
      { taskFolder: '01-build', adHocRunId: undefined },
      { taskFolder: undefined, adHocRunId: 'run-1' },
      { taskFolder: undefined, adHocRunId: 'run-1' },
      { taskFolder: undefined, adHocRunId: undefined },
    ]);
    const scope = { projectRoot: root, parentSessionId: 'parent', primaryAgent: 'swarm-orchestrator', feature: 'alpha' };
    expect(services.backgroundJobService.resolve('child-2')?.scope).toEqual({ ...scope, task: '01-build' });
    expect(services.backgroundJobService.resolve('child-4')?.scope).toEqual({ ...scope, adHocRunId: 'run-1' });
    expect(services.backgroundJobService.resolve('child-5')?.scope).toEqual(scope);
  });

  it('writes the association of a continued child without changing what its continuation needs', async () => {
    const context = await setup({ features: ['alpha', 'beta'] });
    const { services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    // A child bound before associations existed: the same route and agent, but no task or run.
    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Go.' }, 'call-first'))).toBe(true);
    const child = host.admissions.at(-1)!.child;
    services.adhocService = () => ({ get: async (runId: string) => (runId === 'run-1' ? { runId } : null) }) as any;
    const continued = (prompt: string, callID: string, background?: boolean) => host.call('parent', { agent: 'forager-worker', prompt, sessionID: child, background }, callID);

    // With no activity reader, a same-route continuation still runs: adding, replacing and clearing an association
    // reads nothing from the server.
    host.activityState.error = new Error('no server configured');
    expect(Exit.isSuccess(await continued('Hive task: 01-build', 'call-task'))).toBe(true);
    expect(association(services, child)).toEqual({ taskFolder: '01-build', adHocRunId: undefined });
    expect(Exit.isSuccess(await continued('Hive run: run-1', 'call-run', true))).toBe(true);
    expect(association(services, child)).toEqual({ taskFolder: undefined, adHocRunId: 'run-1' });
    expect(services.backgroundJobService.resolve(child)?.scope).toMatchObject({ feature: 'alpha', adHocRunId: 'run-1' });
    expect(Exit.isSuccess(await continued('Hive task: 09-missing', 'call-invalid'))).toBe(true);
    expect(association(services, child)).toEqual({ taskFolder: undefined, adHocRunId: undefined });
    expect(Exit.isSuccess(await continued('Hive task: 01-build', 'call-again'))).toBe(true);
    // A marker without an ID is invalid and clears the association, like one Hive cannot resolve.
    expect(Exit.isSuccess(await continued('Hive run:  \t\nContinue.', 'call-blank'))).toBe(true);
    expect(association(services, child)).toEqual({ taskFolder: undefined, adHocRunId: undefined });
    expect(Exit.isSuccess(await continued('Hive task: 01-build', 'call-restore'))).toBe(true);
    // Without a marker a continuation clears the association, even on the same route.
    expect(Exit.isSuccess(await continued('Continue.', 'call-same-route'))).toBe(true);
    expect(association(services, child)).toEqual({ taskFolder: undefined, adHocRunId: undefined });
    expect(Exit.isSuccess(await continued('Hive task: 01-build', 'call-restore-again'))).toBe(true);
    expect(host.activityState.reads).toBe(0);

    // A route change still needs the host to report the child idle, as before; it then writes the cleared association.
    services.sessionService.setFeatureRoute('parent', 'beta');
    expect(failureMessage(await continued('Continue.', 'call-unknown'))).toContain('could not confirm that child session');
    expect(association(services, child)).toEqual({ taskFolder: '01-build', adHocRunId: undefined });
    host.activityState.error = undefined;
    expect(Exit.isSuccess(await continued('Continue.', 'call-route-change'))).toBe(true);
    expect(services.sessionService.getGlobal(child)?.featureName).toBe('beta');
    expect(association(services, child)).toEqual({ taskFolder: undefined, adHocRunId: undefined });
  });

  it('runs a same-route child whose new association cannot be written, recording its launch with no task or run; a route the child does not hold yet still needs its binding written', async () => {
    const context = await setup({ features: ['alpha', 'beta'] });
    const { root, services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    services.adhocService = () => ({ get: async (runId: string) => (runId === 'run-1' ? { runId } : null) }) as any;
    const tasked = await dispatchedChild(context);
    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Go.' }, 'call-plain'))).toBe(true);
    const plain = host.admissions.at(-1)!.child;
    const track = services.sessionService.trackGlobal;
    services.sessionService.trackGlobal = () => { throw new Error('EACCES: permission denied, open sessions.json'); };
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    // No server activity reader: none of these continuations may need one.
    host.activityState.error = new Error('no server configured');
    const continued = (child: string, prompt: string, callID: string) => host.call('parent', { agent: 'forager-worker', prompt, sessionID: child, background: true }, callID);
    const row = (callID: string) => services.backgroundJobService.listScoped({ projectRoot: root }).find((job) => job.callId === callID);
    const scope = { projectRoot: root, parentSessionId: 'parent', primaryAgent: 'swarm-orchestrator', feature: 'alpha' };
    try {
      for (const [child, prompt, callID, stored] of [
        [plain, 'Hive task: 01-build', 'call-add', { taskFolder: undefined, adHocRunId: undefined }],
        [tasked, 'Hive run: run-1', 'call-replace', { taskFolder: '01-build', adHocRunId: undefined }],
        [tasked, 'Hive task: 09-missing', 'call-clear', { taskFolder: '01-build', adHocRunId: undefined }],
        [tasked, 'Hive task: ', 'call-blank', { taskFolder: '01-build', adHocRunId: undefined }],
        // After the failed write of run-1, an unmarked continuation carries no association either, so its launch does
        // not name the task the store still holds from the dispatch before.
        [tasked, 'Continue.', 'call-continue', { taskFolder: '01-build', adHocRunId: undefined }],
      ] as const) {
        const admitted = host.admissions.length;
        expect(Exit.isSuccess(await continued(child, prompt, callID)), prompt).toBe(true);
        expect(host.admissions.slice(admitted).map((admission) => admission.child), prompt).toEqual([child]);
        // The store keeps what an earlier dispatch wrote; this launch is recorded with no task or run.
        expect(association(services, child), prompt).toEqual(stored);
        expect(row(callID)?.scope, prompt).toEqual(scope);
      }
      expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
        expect.stringContaining(`could not record the task or run association of child session ${plain}`),
        expect.stringContaining(`stored binding named task 01-build`),
        expect.stringContaining(`stored binding named task 01-build`),
        expect.stringContaining(`stored binding named task 01-build`),
        expect.stringContaining(`stored binding named task 01-build`),
      ]);
      expect(warn.mock.calls.every(([message]) => String(message).includes('EACCES'))).toBe(true);
      expect(host.activityState.reads).toBe(0);

      // A write that publishes and then fails (for example while releasing its lock) leaves the store changed, so
      // neither the warning nor the launch may treat the binding read before the write as current.
      services.sessionService.trackGlobal = (...args) => {
        track.apply(services.sessionService, args);
        throw new Error('EIO: i/o error, close sessions.json.lock');
      };
      warn.mockClear();
      const admittedBeforePublished = host.admissions.length;
      expect(Exit.isSuccess(await continued(tasked, 'Hive run: run-1', 'call-published'))).toBe(true);
      expect(host.admissions.slice(admittedBeforePublished).map((admission) => admission.child)).toEqual([tasked]);
      expect(association(services, tasked)).toEqual({ taskFolder: undefined, adHocRunId: 'run-1' });
      expect(row('call-published')?.scope).toEqual(scope);
      expect(warn).toHaveBeenCalledTimes(1);
      const [published] = warn.mock.calls.map(([message]) => String(message));
      expect(published).toContain('EIO');
      expect(published).not.toContain('still names');
      services.sessionService.trackGlobal = () => { throw new Error('EACCES: permission denied, open sessions.json'); };

      // A route change and a new child still fail when their binding cannot be written, and are never prompted.
      host.activityState.error = undefined;
      services.sessionService.setFeatureRoute('parent', 'beta');
      const admitted = host.admissions.length;
      expect(failureMessage(await continued(tasked, 'Continue.', 'call-route-change'))).toContain(`Hive could not bind child session ${tasked} to its dispatch route (EACCES`);
      expect(failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'Hive task: 01-build' }, 'call-new'))).toContain('Hive could not bind child session child-3 to its dispatch route (EACCES');
      expect(host.admissions).toHaveLength(admitted);
      expect(services.sessionService.getGlobal(tasked)?.featureName).toBe('alpha');
    } finally {
      warn.mockRestore();
      services.sessionService.trackGlobal = track;
    }
  });

  it('marks a recorded launch uncertain when the call fails or is interrupted after binding', async () => {
    const failing = await setup({ promptFails: true });
    expect(Exit.isSuccess(await failing.host.call('parent', { agent: 'forager-worker', prompt: 'Go.', background: true }))).toBe(false);
    expect(failing.services.backgroundJobService.resolve('child-1')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(failing.services.backgroundJobService.resolve('child-1')?.lastStatusError).toContain('The background launch call failed after the child was bound');

    const blocked = await setup({ blockForever: true });
    const fiber = Effect.runFork(blocked.host.subagent().execute({ agent: 'forager-worker', description: 'Work', prompt: 'Go.', background: true }, { sessionID: 'parent', agent: 'swarm-orchestrator', messageID: 'msg', id: 'call-i', progress: () => Effect.void } as any));
    while (blocked.host.admissions.length === 0) await Bun.sleep(1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(blocked.services.backgroundJobService.resolve('child-1')?.lastStatusError).toContain('The background launch call was interrupted after the child was bound');
  });

  it('records a foreground call the host moved to the background when it returns running', async () => {
    const { services, host } = await setup({ backgrounded: true });
    await host.call('parent', { agent: 'forager-worker', prompt: 'Go.' }, 'call-moved');
    expect(services.backgroundJobService.resolve('child-1')).toMatchObject({ callId: 'call-moved', runtimeState: 'running' });
  });

  it('keeps a child that another call of this activation is running on that call\'s route; a different snapshot is refused before the host touches the child, an identical one is not', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { services, host } = await setup({ features: ['alpha', 'beta'], holdNewChild: hold });
    services.sessionService.setFeatureRoute('parent', 'alpha');
    services.sessionService.addStandingConstraint('parent', 'Only alpha.');
    const first = host.call('parent', { agent: 'forager-worker', prompt: 'Hive task: 01-build' }, 'call-1');
    while (host.admissions.length === 0) await Bun.sleep(1);

    // The same captured route is a harmless continuation of the running child.
    const same = await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: 'child-1' }, 'call-same');
    expect(Exit.isSuccess(same)).toBe(true);
    expect(host.admissions).toHaveLength(2);

    // A different route or constraint set would rebind the child mid-run for the earlier call. The local call is
    // known to be running, so the refusal needs no host read and comes before the host is invoked.
    services.sessionService.setFeatureRoute('parent', 'beta');
    services.sessionService.addStandingConstraint('parent', 'Now beta.');
    const conflicting = await host.call('parent', { agent: 'forager-worker', prompt: 'Switch.', sessionID: 'child-1' }, 'call-2');
    expect(failureMessage(conflicting)).toBe('Child session child-1 is running under another dispatch, and this continuation would change its route, constraints or agent; Hive did not overwrite its binding and the host was not asked to continue the child.');
    expect(host.nativeInputs).toHaveLength(2);
    expect(host.admissions).toHaveLength(2);
    expect(host.activityState.reads).toBe(0);
    expect(services.sessionService.getGlobal('child-1')).toMatchObject({ parentSessionId: 'parent', featureName: 'alpha' });
    expect(services.sessionService.getGlobal('child-1')?.standingConstraints).toBe('Only alpha.');

    // Once the earlier call has returned and the host reports the child idle, an authorized continuation takes the new route.
    release();
    expect(Exit.isSuccess(await first)).toBe(true);
    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Switch.', sessionID: 'child-1' }, 'call-3'))).toBe(true);
    expect(services.sessionService.getGlobal('child-1')).toMatchObject({ featureName: 'beta' });
    expect(services.sessionService.getGlobal('child-1')?.standingConstraints).toContain('Now beta.');
  });

  it('refuses a conflicting continuation of an active child before the host switches its agent and model; a compatible one still runs', async () => {
    const context = await setup({ features: ['alpha'] });
    const { services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context, { background: true });
    host.active.add(child);

    const conflicting = await host.call('parent', { agent: 'scout-researcher', prompt: 'Look instead.', sessionID: child }, 'call-agent');
    expect(failureMessage(conflicting)).toBe(`Child session ${child} is running under another dispatch, and this continuation would change its route, constraints or agent; Hive did not overwrite its binding and the host was not asked to continue the child.`);
    expect(host.nativeInputs).toHaveLength(1);
    expect(host.switches).toEqual([]);
    expect(host.sessions.get(child)).toMatchObject({ agent: 'forager-worker', model: ref('model-of-forager-worker') });
    expect(services.sessionService.getGlobal(child)).toMatchObject({ parentSessionId: 'parent', featureName: 'alpha', agent: 'forager-worker' });

    // The same agent and route steers the running child; nothing about its binding changes.
    const compatible = await host.call('parent', { agent: 'forager-worker', prompt: 'Also this.', sessionID: child }, 'call-steer');
    expect(Exit.isSuccess(compatible)).toBe(true);
    expect(host.nativeInputs).toHaveLength(2);
    expect(host.switches).toEqual([]);
    expect(host.admissions.at(-1)).toMatchObject({ child, boundAgent: 'forager-worker', boundFeature: 'alpha' });
  });

  it('decides an incompatible continuation from the host\'s activity, never from the board', async () => {
    // An active child whose launch the board never recorded, because every board write failed.
    const unrecorded = await setup({ features: ['alpha', 'beta'] });
    const board = unrecorded.services.backgroundJobService;
    board.registerLaunch = (() => { throw new Error('board unwritable'); }) as typeof board.registerLaunch;
    unrecorded.services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(unrecorded, { background: true });
    unrecorded.host.active.add(child);
    unrecorded.services.sessionService.setFeatureRoute('parent', 'beta');
    const refused = await unrecorded.host.call('parent', { agent: 'forager-worker', prompt: 'Switch.', sessionID: child }, 'call-2');
    expect(failureMessage(refused) ?? '').toContain('is running under another dispatch');
    expect(unrecorded.host.nativeInputs).toHaveLength(1);
    expect(unrecorded.services.sessionService.getGlobal(child)).toMatchObject({ featureName: 'alpha' });

    // An active child whose board row was archived as ignored.
    const ignored = await setup({ features: ['alpha', 'beta'] });
    ignored.services.sessionService.setFeatureRoute('parent', 'alpha');
    const ignoredChild = await dispatchedChild(ignored, { background: true });
    ignored.services.backgroundJobService.updateRuntimeState(ignoredChild, 'unknown', { statusUncertain: true });
    ignored.services.backgroundJobService.markIgnored(ignoredChild, 'Archived the observation.');
    ignored.host.active.add(ignoredChild);
    ignored.services.sessionService.setFeatureRoute('parent', 'beta');
    expect(failureMessage(await ignored.host.call('parent', { agent: 'forager-worker', prompt: 'Switch.', sessionID: ignoredChild }, 'call-2')) ?? '').toContain('is running under another dispatch');
    expect(ignored.services.sessionService.getGlobal(ignoredChild)).toMatchObject({ featureName: 'alpha' });

    // An idle child whose board still shows a live row, with the board file unreadable: the host says idle.
    const unreadable = await setup({ features: ['alpha', 'beta'] });
    unreadable.services.sessionService.setFeatureRoute('parent', 'alpha');
    const idleChild = await dispatchedChild(unreadable, { background: true });
    fs.writeFileSync(getNativeBackgroundJobsPath(unreadable.root, 'opencode-v2'), '{ not json');
    unreadable.services.sessionService.setFeatureRoute('parent', 'beta');
    const allowed = await unreadable.host.call('parent', { agent: 'forager-worker', prompt: 'Switch.', sessionID: idleChild }, 'call-2');
    expect(Exit.isSuccess(allowed)).toBe(true);
    expect(unreadable.host.admissions.at(-1)).toMatchObject({ child: idleChild, boundFeature: 'beta' });
  });

  it('treats unknown host activity as not idle, and needs no activity read for a fresh dispatch or a compatible continuation', async () => {
    const context = await setup({ features: ['alpha', 'beta'] });
    const { services, host } = context;
    host.activityState.error = new Error('Session history reads need the oc-arkive `server` option');
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context);
    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: child }, 'call-same'))).toBe(true);
    expect(host.activityState.reads).toBe(0);

    services.sessionService.setFeatureRoute('parent', 'beta');
    const unknown = await host.call('parent', { agent: 'forager-worker', prompt: 'Switch.', sessionID: child }, 'call-switch');
    expect(failureMessage(unknown)).toBe(`Hive could not confirm that child session ${child} is idle (Session history reads need the oc-arkive \`server\` option). Adopting an unbound child or changing its route, constraints or agent needs an idle child, so Hive did not overwrite its binding and the host was not asked to continue the child.`);
    expect(host.nativeInputs).toHaveLength(2);
    expect(services.sessionService.getGlobal(child)).toMatchObject({ featureName: 'alpha' });
  });

  it('reserves an incompatible preflight before an old idle snapshot can be overtaken by a returned background call', async () => {
    let releaseActivity!: () => void;
    const context = await setup();
    const { services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context);
    const before = services.sessionService.getGlobal(child);
    host.activityState.gate = new Promise<void>((resolve) => { releaseActivity = resolve; });

    const incompatible = host.call('parent', { agent: 'scout-researcher', prompt: 'Switch.', sessionID: child }, 'call-A');
    try {
      for (let wait = 0; wait < 500 && host.activityState.reads === 0; wait += 1) await Bun.sleep(1);
      expect(host.activityState.reads).toBe(1);
      // A has captured idle but has not received the answer. B uses the old bound route, and can return running,
      // releasing its admission before A resumes. If B reaches native prompt admission, the host child becomes active.
      const continuation = host.subagent();
      const background = await Effect.runPromiseExit(continuation.execute(
        { agent: 'forager-worker', prompt: 'Background.', sessionID: child, background: true },
        { sessionID: 'parent', agent: 'swarm-orchestrator', messageID: 'msg', id: 'call-B', progress: () => Effect.sync(() => { host.active.add(child); }) } as any,
      ));
      expect(failureMessage(background) ?? '').toContain('is running under another dispatch');
      expect(host.nativeInputs).toHaveLength(1);
      expect(host.switches).toEqual([]);
      expect(host.admissions).toHaveLength(1);
      expect(services.sessionService.getGlobal(child)).toEqual(before);
      expect(host.active.has(child)).toBe(false);
    } finally {
      releaseActivity();
      await incompatible;
    }

    expect(Exit.isSuccess(await incompatible)).toBe(true);
    expect(host.nativeInputs).toHaveLength(2);
    expect(host.switches).toEqual([{ child, agent: 'scout-researcher', model: ref('model-of-scout-researcher') }]);
    expect(services.sessionService.getGlobal(child)).toMatchObject({ agent: 'scout-researcher' });
  });

  it('does not treat a matching pending reservation as qualified compatibility and releases it after interruption', async () => {
    let releaseActivity!: () => void;
    const context = await setup();
    const { services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context);
    const before = services.sessionService.getGlobal(child);
    host.active.add(child);
    host.activityState.gate = new Promise<void>((resolve) => { releaseActivity = resolve; });
    const pending = Effect.runFork(host.subagent().execute(
      { agent: 'scout-researcher', prompt: 'Switch.', sessionID: child },
      { sessionID: 'parent', agent: 'swarm-orchestrator', messageID: 'msg', id: 'call-A', progress: () => Effect.void } as any,
    ));
    for (let wait = 0; wait < 500 && host.activityState.reads === 0; wait += 1) await Bun.sleep(1);
    expect(host.activityState.reads).toBe(1);
    const matching = host.call('parent', { agent: 'scout-researcher', prompt: 'Switch too.', sessionID: child }, 'call-B');
    for (let wait = 0; wait < 500 && host.activityState.reads < 2; wait += 1) await Bun.sleep(1);
    expect(host.activityState.reads).toBe(2);
    await Effect.runPromise(Fiber.interrupt(pending));
    releaseActivity();
    expect(failureMessage(await matching) ?? '').toContain('is running under another dispatch');
    expect(host.nativeInputs).toHaveLength(1);
    expect(host.switches).toEqual([]);
    expect(host.admissions).toHaveLength(1);
    expect(services.sessionService.getGlobal(child)).toEqual(before);
    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Continue.', sessionID: child }))).toBe(true);
  });

  it('reports a launch whose row could not be written to its parent until the same call records it', async () => {
    const { root, services, host, background } = await setup();
    const board = services.backgroundJobService;
    const register = board.registerLaunch.bind(board);
    let failures = 2;
    // The barrier write and the retry when the call returns `running` both fail; reads of the board still work.
    board.registerLaunch = ((input) => { if (failures > 0) { failures -= 1; throw new Error('disk full'); } return register(input); }) as typeof board.registerLaunch;
    const status = createBackgroundOperations({ backgroundJobService: board, projectRoot: root, isEnabled: () => true, currentRuntimeId: 'runtime-a', unrecordedLaunches: background.observer.unrecordedLaunches }).hive_background_status!;

    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Go.', background: true }, 'call-A'))).toBe(true);
    expect(board.listScoped({ projectRoot: root }, { includeArchived: true })).toHaveLength(0);
    const gap = await status.execute({}, { sessionID: 'parent' }) as any;
    expect(gap.jobs).toEqual([]);
    expect(gap.unrecordedLaunches).toEqual([expect.objectContaining({ childSessionId: 'child-1', callId: 'call-A', agentName: 'forager-worker', reason: 'disk full' })]);
    expect(gap.recommendedNextAction).toMatchObject({ action: 'inspect_unrecorded_background_launches', childSessionIds: ['child-1'] });
    expect(gap.schedulerGuidance).toBeUndefined();
    // Another parent's board never shows it, and its prompt board does not either.
    const other = await status.execute({}, { sessionID: 'other-parent' }) as any;
    expect(other.unrecordedLaunches).toBeUndefined();
    expect(other.recommendedNextAction.action).toBe('idle');
    expect(background.observer.promptBoard('other-parent')).toBeUndefined();
    expect(background.observer.promptBoard('parent')?.text).toContain('unrecorded launch (child-1) forager-worker');

    // The same call writing its row on the retry clears the gap; another call's failure does not hide behind it.
    failures = 1;
    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Again.', background: true }, 'call-B'))).toBe(true);
    const recovered = await status.execute({}, { sessionID: 'parent' }) as any;
    expect(recovered.unrecordedLaunches).toEqual([expect.objectContaining({ childSessionId: 'child-1', callId: 'call-A' })]);
    expect(board.listScoped({ projectRoot: root }).map((job) => job.callId)).toEqual(['call-B']);
    expect(board.resolve('child-2')?.statusUncertain).toBeUndefined();
  });

  it('fails a call that returns a child it never bound at the progress barrier, without binding it afterwards', async () => {
    const { services, host } = await setup({ skipProgress: true });
    const exit = await host.call('parent', { agent: 'forager-worker', prompt: 'Go.' }, 'call-unbound');
    expect(failureMessage(exit)).toBe('The subagent call returned child session child-1 without the progress update at which Hive binds the child before its prompt. Hive did not bind it after it ran, so the child may have run without its parent\'s route and standing constraints; inspect hive_task_trace({ task_id: "child-1" }) before relying on its result.');
    expect(services.sessionService.getGlobal('child-1')).toBeUndefined();
    expect(services.backgroundJobService.listScoped({}, { includeArchived: true })).toEqual([]);
  });

  it('does not hand a completion for a launch Hive could not record to a later continuation of the same child', async () => {
    const { root, services, host, background } = await setup();
    const board = services.backgroundJobService;
    const register = board.registerLaunch.bind(board);
    // The store rejects every attempt to record the first launch, at the barrier and again when the call returns.
    board.registerLaunch = ((input) => { if (input.callId === 'call-A') throw new Error('disk full'); return register(input); }) as typeof board.registerLaunch;

    await host.call('parent', { agent: 'forager-worker', prompt: 'Go.', background: true }, 'call-A');
    expect(board.listScoped({ projectRoot: root }, { includeArchived: true })).toHaveLength(0);
    background.handleEvent(completion('parent', 'child-1', 'completed', 'inbox-A'));

    await host.call('parent', { agent: 'forager-worker', prompt: 'Again.', background: true, sessionID: 'child-1' }, 'call-B');
    expect(board.resolve('child-1')).toMatchObject({ callId: 'call-B', runtimeState: 'running' });
    expect(board.resolve('child-1')?.statusUncertain).toBeUndefined();

    // The continuation's own notification names the child, not the call: it is recorded as an uncertain observation.
    background.handleEvent(completion('parent', 'child-1', 'completed', 'inbox-B'));
    expect(board.resolve('child-1')).toMatchObject({ callId: 'call-B', runtimeState: 'unknown', statusUncertain: true });
  });

  it('never settles a later continuation with the late notification of an earlier launch that has no row', async () => {
    const { root, services, host, background } = await setup();
    const board = services.backgroundJobService;
    const register = board.registerLaunch.bind(board);
    board.registerLaunch = ((input) => { if (input.callId === 'call-A') throw new Error('disk full'); return register(input); }) as typeof board.registerLaunch;

    await host.call('parent', { agent: 'forager-worker', prompt: 'Go.', background: true }, 'call-A');
    await host.call('parent', { agent: 'forager-worker', prompt: 'Again.', background: true, sessionID: 'child-1' }, 'call-B');
    expect(board.listScoped({ projectRoot: root })).toHaveLength(1);

    // A's notification arrives after B's row exists and is B's row only by timing.
    background.handleEvent(completion('parent', 'child-1', 'completed', 'inbox-A'));
    const row = board.resolve('child-1')!;
    expect(row).toMatchObject({ callId: 'call-B', runtimeState: 'unknown', statusUncertain: true });
    expect(row.terminalUnreconciled).toBeUndefined();
    expect(row.lastStatusError).toContain('names the child, not the launching call');
  });

  it('applies a completion that arrives after the barrier, as uncertainty, to the foreground call the host then moves to the background', async () => {
    const ref: { background?: ReturnType<typeof createV2BackgroundLifecycle> } = {};
    const { services, host, background } = await setup({ backgrounded: true, afterAdmission: (child) => ref.background!.handleEvent(completion('parent', child)) });
    ref.background = background;
    await host.call('parent', { agent: 'forager-worker', prompt: 'Go.' }, 'call-moved');
    expect(services.backgroundJobService.resolve('child-1')).toMatchObject({ callId: 'call-moved', runtimeState: 'unknown', statusUncertain: true });
  });

  describe('managed-model control', () => {
    const teamForager = { baseAgent: 'forager-worker', description: 'Team forager', model: 'hive/team-default', variant: 'low' } as ResolvedCustomAgentConfig;

    it('refuses any model on a built-in or custom managed target, from any caller, before route capture, native effects, binding, launch or reservation', async () => {
      const context = await setup({ customAgents: { 'team-forager': teamForager } });
      const { root, services, host } = context;
      // A managed target with no configured model is refused the same way: the argument is the violation, not the lookup.
      host.catalog.models.set('scout-researcher', null);
      services.sessionService.setFeatureRoute('parent', 'alpha');
      const child = await dispatchedChild(context);
      const before = services.sessionService.getGlobal(child);
      let captures = 0;
      const capture = services.captureRoute.bind(services);
      services.captureRoute = ((session: string) => { captures += 1; return capture(session); }) as typeof services.captureRoute;

      for (const agent of ['forager-worker', 'team-forager', 'scout-researcher']) {
        // A different model, the configured model itself, and the configured model with a reasoning variant.
        for (const model of ['other/elsewhere', `test/model-of-${agent}`, `test/model-of-${agent}#high`]) {
          // A Hive orchestrator and an unmanaged caller that the role guard would otherwise let delegate.
          for (const caller of ['swarm-orchestrator', 'my-own-agent']) {
            const fresh = await host.call('parent', { agent, prompt: 'Hive task: 01-build', model, background: true }, `call-fresh-${agent}-${model}-${caller}`, caller);
            expect(failureMessage(fresh)).toBe(`Hive manages the model of agent ${agent}, so this subagent call may not set model (it set ${JSON.stringify(model)}); the host was not called. Repeat the call without model: the agent runs on its effective configured model and variant, or inherits its parent's model when it has none. The operator changes that model in native agent configuration or agent_hive.json.`);
            const continued = await host.call('parent', { agent, prompt: 'More.', model, sessionID: child }, `call-cont-${agent}-${model}-${caller}`, caller);
            expect(failureMessage(continued) ?? '').toContain('may not set model');
          }
        }
      }
      expect(captures).toBe(0);
      expect(host.nativeInputs).toHaveLength(1);
      expect(host.switches).toEqual([]);
      expect(host.admissions).toHaveLength(1);
      expect(host.activityState.reads).toBe(0);
      expect(host.catalog.reads).toBe(0);
      expect(host.sessions.get(child)).toMatchObject({ agent: 'forager-worker', model: ref('model-of-forager-worker') });
      expect(services.sessionService.getGlobal(child)).toEqual(before);
      expect(services.backgroundJobService.listScoped({ projectRoot: root }, { includeArchived: true })).toEqual([]);

      // Nothing was reserved: the corrected calls run, the continuation with no activity read and on the child's model.
      host.active.add(child);
      expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: child }, 'call-corrected', 'my-own-agent'))).toBe(true);
      expect(Exit.isSuccess(await host.call('parent', { agent: 'team-forager', prompt: 'Hive task: 01-build', background: true }, 'call-corrected-fresh'))).toBe(true);
      expect(host.nativeInputs.slice(1).map((input) => 'model' in input)).toEqual([false, false]);
      expect(host.sessions.get('child-2')?.model).toEqual(ref('model-of-team-forager'));
      expect(host.activityState.reads).toBe(0);
    });

    it('passes a model through unchanged for native general and explore and for unmanaged targets', async () => {
      const { host } = await setup();
      for (const agent of ['general', 'explore', 'someone-elses-agent']) {
        expect(Exit.isSuccess(await host.call('parent', { agent, prompt: 'Look.', model: 'other/chosen#max' }))).toBe(true);
      }
      expect(host.nativeInputs.map((input) => input.model)).toEqual(['other/chosen#max', 'other/chosen#max', 'other/chosen#max']);
      expect([...host.sessions.values()].map((session) => session.model)).toEqual([ref('chosen', 'max', 'other'), ref('chosen', 'max', 'other'), ref('chosen', 'max', 'other')]);
      // A same-agent continuation of an unmanaged target is not model-checked.
      host.sessions.get('child-3')!.model = ref('drifted');
      expect(Exit.isSuccess(await host.call('parent', { agent: 'someone-elses-agent', prompt: 'More.', sessionID: 'child-3' }))).toBe(true);
      expect(host.catalog.reads).toBe(0);
    });

    it('continues a same-agent managed child only on the model its effective host entry configures, which native configuration owns', async () => {
      const context = await setup({ customAgents: { 'team-forager': teamForager } });
      const { services, host } = context;
      // Native user configuration replaced the Hive default (`hive/team-default#low`) for this custom agent.
      host.catalog.models.set('team-forager', ref('user-choice', 'high', 'user'));
      expect(Exit.isSuccess(await host.call('parent', { agent: 'team-forager', prompt: 'Go.' }, 'call-first'))).toBe(true);
      expect(host.sessions.get('child-1')?.model).toEqual(ref('user-choice', 'high', 'user'));
      expect(Exit.isSuccess(await host.call('parent', { agent: 'team-forager', prompt: 'More.', sessionID: 'child-1' }))).toBe(true);
      const before = services.sessionService.getGlobal('child-1');

      const drifted: Array<[ModelRef | undefined, string]> = [
        [ref('team-default', 'low', 'hive'), 'hive/team-default#low'],
        [ref('user-choice', 'high', 'other'), 'other/user-choice#high'],
        [ref('another', 'high', 'user'), 'user/another#high'],
        [ref('user-choice', 'low', 'user'), 'user/user-choice#low'],
        [ref('user-choice', undefined, 'user'), 'user/user-choice'],
        [undefined, 'no recorded model'],
      ];
      for (const [model, shown] of drifted) {
        host.sessions.get('child-1')!.model = model;
        const refused = await host.call('parent', { agent: 'team-forager', prompt: 'More.', sessionID: 'child-1' });
        expect(failureMessage(refused)).toBe(`Child session child-1 runs on ${shown}, but agent team-forager is configured for user/user-choice#high; the host was not asked to continue the child. Start a new team-forager subagent call without sessionID to run on the configured model.`);
      }
      expect(host.nativeInputs).toHaveLength(2);
      expect(host.switches).toEqual([]);
      expect(host.activityState.reads).toBe(0);
      expect(services.sessionService.getGlobal('child-1')).toEqual(before);
    });

    it('treats an omitted variant and the default variant as one model, and still refuses a named variant on either side', async () => {
      const { host } = await setup();
      // The host reports a variantless session model as `default`, while the agent entry omits the variant. Every agent
      // here is configured without a variant, so a fresh child continues on its own agent.
      expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Go.' }))).toBe(true);
      expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: 'child-1' }))).toBe(true);

      // A configured `default` variant and an omitted one are the same model.
      host.catalog.models.set('forager-worker', ref('model-of-forager-worker', 'default'));
      expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: 'child-1' }))).toBe(true);
      host.catalog.models.delete('forager-worker');

      // A named variant on the session against a variantless configuration is drift, shown with its variant.
      host.sessions.get('child-1')!.model = ref('model-of-forager-worker', 'high');
      expect(failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: 'child-1' }))).toBe('Child session child-1 runs on test/model-of-forager-worker#high, but agent forager-worker is configured for test/model-of-forager-worker; the host was not asked to continue the child. Start a new forager-worker subagent call without sessionID to run on the configured model.');
      expect(host.nativeInputs).toHaveLength(3);
    });

    it('fails closed when the configured model cannot be read, and leaves a found model-less target to native inheritance', async () => {
      const { host } = await setup();
      host.sessions.set('parent', { id: 'parent', model: ref('parent-model') });
      expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Go.' }))).toBe(true);

      host.catalog.error = new Error('catalog offline');
      expect(failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: 'child-1' }))).toBe('Hive could not read the configured model of agent forager-worker (catalog offline), so it cannot confirm that child session child-1 runs on it; the host was not asked to continue the child.');
      host.catalog.error = undefined;
      host.catalog.missing.add('forager-worker');
      expect(failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: 'child-1' })) ?? '').toContain('Hive could not read the configured model of agent forager-worker (Agent not found: forager-worker)');
      expect(host.nativeInputs).toHaveLength(1);

      // Model-less: a fresh child inherits the parent's model, and a resumed child keeps whatever model it had.
      host.catalog.models.set('scout-researcher', null);
      expect(Exit.isSuccess(await host.call('parent', { agent: 'scout-researcher', prompt: 'Look.' }))).toBe(true);
      expect(host.sessions.get('child-2')?.model).toEqual(ref('parent-model'));
      host.sessions.get('child-2')!.model = ref('earlier-model');
      expect(Exit.isSuccess(await host.call('parent', { agent: 'scout-researcher', prompt: 'More.', sessionID: 'child-2' }))).toBe(true);
      expect(host.sessions.get('child-2')?.model).toEqual(ref('earlier-model'));
      expect(host.switches).toEqual([]);
    });

    it('lets an idle child switch to another managed agent on that agent\'s configured model, judging the switch by the host\'s session agent', async () => {
      const context = await setup();
      const { services, host } = context;
      services.sessionService.setFeatureRoute('parent', 'alpha');
      const child = await dispatchedChild(context);
      // A stale binding claims the child already runs as the scout, so the captured route matches it exactly; the host
      // still reports the Forager, and the continuation would switch it.
      services.sessionService.trackGlobal(child, { agent: 'scout-researcher' });
      const before = services.sessionService.getGlobal(child);

      host.active.add(child);
      expect(failureMessage(await host.call('parent', { agent: 'scout-researcher', prompt: 'Look.', sessionID: child })) ?? '').toContain('is running under another dispatch');
      host.active.delete(child);
      host.activityState.error = new Error('reader unavailable');
      expect(failureMessage(await host.call('parent', { agent: 'scout-researcher', prompt: 'Look.', sessionID: child })) ?? '').toContain('could not confirm');
      expect(host.nativeInputs).toHaveLength(1);
      expect(host.switches).toEqual([]);
      expect(host.catalog.reads).toBe(0);
      expect(services.sessionService.getGlobal(child)).toEqual(before);

      // Idle: the host switches the child onto the destination's configured model, which differs from the old one.
      host.activityState.error = undefined;
      expect(Exit.isSuccess(await host.call('parent', { agent: 'scout-researcher', prompt: 'Look.', sessionID: child }))).toBe(true);
      expect(host.activityState.reads).toBe(3);
      expect(host.switches).toEqual([{ child, agent: 'scout-researcher', model: ref('model-of-scout-researcher') }]);
      expect(host.admissions.at(-1)).toMatchObject({ child, boundAgent: 'scout-researcher', boundFeature: 'alpha' });
    });
  });

  it('is composed by the production activation, which supplies the barrier and judges the input every execute.before hook produced', async () => {
    const root = project();
    const home = fs.mkdtempSync(`/tmp/hive-v2-dispatch-home-${process.pid}-`);
    cleanup.push(home);
    const services = createHiveServices({ projectRoot: root, nativeObservationOwner: 'opencode-v2' });
    const host = fakeHost(services);
    const accept = () => Effect.succeed({ dispose: Effect.void });
    const context = {
      ...host.context,
      location: { directory: root, project: { id: 'project', directory: root, canonical: root } },
      options: {},
      agent: { ...host.context.agent, transform: accept },
      skill: { transform: accept, list: () => Effect.succeed({ data: [] }) },
      command: { transform: accept },
      tool: host.context.tool,
      session: { ...host.context.session, hook: accept },
      event: { subscribe: () => Stream.empty },
      rpc: { register: () => Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } }) },
    } as unknown as Plugin.Context;
    const saved = { HOME: process.env.HOME, OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR };
    process.env.HOME = home;
    process.env.OPENCODE_CONFIG_DIR = path.join(home, '.config', 'opencode');
    try {
      await Effect.runPromise(plugin.effect(context).pipe(Scope.provide(Effect.runSync(Scope.make()))));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    services.sessionService.setFeatureRoute('parent', 'alpha');
    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Hive task: 01-build' }))).toBe(true);
    expect(host.admissions[0]).toMatchObject({ boundParent: 'parent', boundFeature: 'alpha' });
    expect(host.admissions[0].text).toContain('<!-- hive-route-snapshot:start -->');

    // Another plugin's hook, registered after Hive's, injects a model into the call; the wrapper sees the final input.
    expect(host.beforeHooks.length).toBeGreaterThan(0);
    host.beforeHooks.push((event) => Effect.sync(() => { if (event.tool === NATIVE_SUBAGENT_TOOL) event.input = { ...event.input, model: 'other/injected' }; }));
    expect(failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'Hive task: 01-build' })) ?? '').toContain('may not set model (it set "other/injected")');
    expect(host.nativeInputs).toHaveLength(1);
  });
});
