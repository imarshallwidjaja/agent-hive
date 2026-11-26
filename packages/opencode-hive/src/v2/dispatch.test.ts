import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Effect, Exit, Fiber, Scope, Stream } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import { FeatureService, PlanService, TaskService, getNativeSessionsPath, type ResolvedCustomAgentConfig } from 'hive-core';
import plugin from '../index.js';
import { createHiveServices, type HiveServices } from '../runtime/hive-services.js';
import { NATIVE_SUBAGENT_TOOL, registerDispatch } from './dispatch.js';
import { createHiveAuthority } from './registration.js';
import { HIVE_SESSION_INSTRUCTION_KEY } from './session-instructions.js';

// Dispatch owns what Hive adds to the host's own subagent tool: the parent's route and constraints, the composed
// prompt, managed-model control, the continuation preflight and the child-binding barrier on the awaited progress
// update. The fake host below stands in for the native tool only: it runs `execute.before`
// hooks on the call's input, creates the child or, for a continuation, switches it to the requested agent, selects the
// model as the host does, awaits progress, then admits the child's prompt with its own prefix, recording what Hive had
// bound at that moment, and returns `running` as the qualified host does for every call. It never binds anything
// itself. Every session it reports lives in the activation's location unless a test moves it. Its `active` set is the server's active-session read that the catalog's verified read access returns, and its
// `catalog` is the host's effective agent catalog. A calling session it has not seen is a primary session.

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type ModelRef = { providerID: string; id: string; variant?: string };
type Session = { id: string; parentID?: string; agent?: string; model?: ModelRef; location?: { directory: string } };
type Admission = { child: string; text: string; boundParent?: string; boundFeature?: string | null; boundConstraints?: string; boundAgent?: string; instructions?: string };

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
 * return `running`: the child runs on in the background. Every agent is configured for `test/model-of-<agent>` unless
 * `catalog.models` says otherwise (`null` is a model-less entry); `catalog.missing` and `catalog.error` fail lookups.
 */
function fakeHost(services: HiveServices, options: { directory?: string; pauseBeforeProgress?: Effect.Effect<void>; reportedParent?: (child: string, parent: string) => string | undefined; promptFails?: boolean; blockForever?: boolean; holdNewChild?: Promise<void>; holdContinuation?: Promise<void>; afterAdmission?: (child: string) => void; skipProgress?: boolean } = {}) {
  const sessions = new Map<string, Session>();
  const admissions: Admission[] = [];
  const nativeInputs: any[] = [];
  const switches: Array<{ child: string; agent?: string; model?: ModelRef }> = [];
  const directory = options.directory ?? '/workspace/project';
  const catalog: { models: Map<string, ModelRef | null>; missing: Set<string>; error?: Error; reads: number } = { models: new Map(), missing: new Set(), reads: 0 };
  const configuredModel = (agent: string) => catalog.models.has(agent) ? catalog.models.get(agent) ?? undefined : ref(`model-of-${agent}`);
  const beforeHooks: Array<(event: any) => Effect.Effect<void, any>> = [];
  // The host's settlement signals for each child, as the catalog's verified read access reads them in order: a running
  // job (the child's own or a descendant's), a queued inbox item, then an active execution of the child or a descendant.
  const jobs = new Set<string>();
  const inbox = new Set<string>();
  const active = new Set<string>();
  const activityState: { reads: number; error?: Error; gate?: Promise<void>; signals: Array<AbortSignal | undefined> } = { reads: 0, signals: [] };
  const activity = {
    childSettlement: async ({ childID }: { parentID: string; childID: string }, abort?: AbortSignal) => {
      activityState.reads += 1;
      activityState.signals.push(abort);
      const signal = jobs.has(childID) ? 'job' as const : inbox.has(childID) ? 'inbox' as const : active.has(childID) ? 'active' as const : undefined;
      if (activityState.gate) await activityState.gate;
      if (activityState.error) throw activityState.error;
      return signal === undefined ? { settled: true as const } : { settled: false as const, signal, detail: `${signal} signal for ${childID}` };
    },
  };
  // The host's session instruction entries, by session then key; `fail` makes every write fail.
  const entries = new Map<string, Map<string, unknown>>();
  const entryState: { fail?: Error } = {};
  let next = 0;
  const transforms: Array<(editor: any) => void> = [];
  const context = {
    location: { directory },
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
        return session ? Effect.succeed({ location: { directory }, ...session, ...(session.model === undefined ? {} : { model: { ...session.model, variant: session.model.variant ?? 'default' } }) }) : Effect.fail(new Error(`unknown session ${sessionID}`));
      }),
      instructions: {
        entry: {
          put: ({ sessionID, key, value }: { sessionID: string; key: string; value: unknown }) => Effect.suspend(() => {
            if (entryState.fail) return Effect.fail(entryState.fail);
            if (!entries.has(sessionID)) entries.set(sessionID, new Map());
            entries.get(sessionID)!.set(key, value);
            return Effect.void;
          }),
          remove: ({ sessionID, key }: { sessionID: string; key: string }) => Effect.sync(() => { entries.get(sessionID)?.delete(key); }),
        },
      },
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
        boundConstraints: boundConstraintText(services, child),
        boundAgent: bound?.agent,
        instructions: entries.get(child)?.get(HIVE_SESSION_INSTRUCTION_KEY) as string | undefined,
      });
      options.afterAdmission?.(child);
      if (options.blockForever) yield* Effect.never;
      if (options.holdNewChild && !input.sessionID) yield* Effect.promise(() => options.holdNewChild!);
      if (options.holdContinuation && input.sessionID) yield* Effect.promise(() => options.holdContinuation!);
      return { output: { sessionID: child, status: 'running', output: 'working in the background' }, metadata: { sessionID: child, status: 'running' } };
    }),
  };

  /** The effective subagent tool after every transform, as the host replays them on its own definition. */
  const subagent = () => {
    const tool = { ...nativeTool };
    for (const cb of transforms) cb({ namespace: () => {}, add: () => {}, update: (id: string, fn: (info: any) => void) => { if (id === NATIVE_SUBAGENT_TOOL) fn(tool); } });
    return tool;
  };
  /** One subagent call: `execute.before` hooks rewrite the input in order, then the effective tool runs on the result. */
  const call = (parent: string, input: Record<string, unknown>, callID = `call-${parent}-${Math.random()}`, caller = 'swarm-orchestrator') => {
    if (!sessions.has(parent)) sessions.set(parent, { id: parent });
    const event = { tool: NATIVE_SUBAGENT_TOOL, sessionID: parent, agent: caller, callID, input: { description: 'Work', ...input } };
    return Effect.runPromiseExit(Effect.gen(function* () {
      for (const hook of beforeHooks) yield* hook(event);
      return yield* subagent().execute(event.input, { sessionID: parent, agent: caller, messageID: 'msg', id: callID, progress: () => Effect.void });
    }));
  };
  return { context, sessions, admissions, nativeInputs, switches, catalog, beforeHooks, jobs, inbox, active, activity, activityState, entries, entryState, call, subagent };
}

async function setup(options: Parameters<typeof fakeHost>[1] & { features?: string[]; customAgents?: Record<string, ResolvedCustomAgentConfig> } = {}) {
  const root = project(options.features);
  const services = createHiveServices({ projectRoot: root, nativeObservationOwner: 'opencode-v2' });
  const host = fakeHost(services, options);
  const authority = createHiveAuthority(host.context, options.customAgents ?? {});
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(registerDispatch({ context: host.context, services, authority, activity: host.activity }).pipe(Scope.provide(scope)));
  return { root, services, host };
}

/** A child the parent dispatched earlier under its current route, now idle in the host. */
async function dispatchedChild(context: Awaited<ReturnType<typeof setup>>, options: { callID?: string } = {}) {
  const exit = await context.host.call('parent', { agent: 'forager-worker', prompt: 'Hive task: 01-build' }, options.callID ?? 'call-first');
  expect(Exit.isSuccess(exit)).toBe(true);
  return context.host.admissions.at(-1)!.child;
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

/** The task or run a child's Hive binding names. */
/** The flattened session constraints a child's stored binding holds, or undefined when it holds none. */
const boundConstraintText = (services: HiveServices, child: string): string | undefined => {
  const stored = services.sessionService.getGlobal(child);
  return stored ? services.sessionService.standingConstraintRegister(stored).constraints || undefined : undefined;
};
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
    // Hive composed the parent's own prompt, without the stale footer, and the brief; the host prefix comes after.
    expect(host.nativeInputs[0].prompt.startsWith('Hive task: 01-build\nBuild it.\n\n<!-- hive-task-brief:start -->\n## Hive task brief\n')).toBe(true);
    expect(admission.text.startsWith('You are a subagent spawned by another session.\nHive task: 01-build')).toBe(true);
    expect(admission.text).not.toContain('\nstale\n');
    expect(admission.text).not.toContain('hive-route-snapshot');
    expect(admission.text).not.toContain('Use blocking calls only.');
    expect(admission.text).toContain('Task: 01-build - Build (pending)');
    // The route, constraints and task reach the child as its instruction entry, written before its prompt.
    expect(admission.instructions).toContain(`Route (JSON): {"projectRoot":"${root}","featureRoute":{"selected":true,"feature":"alpha"}}\nTask: 01-build\n`);
    expect(admission.instructions).toContain('Session constraints (revision 1):\nUse blocking calls only.');
    expect(admission.instructions).toContain('Feature constraints for "alpha" (revision 1):\nPublic APIs only.');
    // The parent gets no entry from a dispatch.
    expect(host.entries.has('parent')).toBe(false);
  });

  it('writes a continued child the parent current constraints and keeps its stored task when the follow-up has no marker', async () => {
    const context = await setup();
    context.services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context);
    context.services.sessionService.addStandingConstraint('parent', 'Added after the first dispatch.');

    const continued = await context.host.call('parent', { agent: 'forager-worker', prompt: 'Continue.', sessionID: child });
    expect(Exit.isSuccess(continued)).toBe(true);
    const instructions = context.host.admissions.at(-1)!.instructions!;
    expect(instructions).toContain('\nTask: 01-build\n');
    expect(instructions).toContain('Session constraints (revision 1):\nAdded after the first dispatch.');
  });

  it('refuses a child whose instruction entry cannot be written, before its prompt', async () => {
    const { services, host } = await setup();
    services.sessionService.setFeatureRoute('parent', null);
    services.sessionService.addStandingConstraint('parent', 'Stay small.');
    host.entryState.fail = new Error('entry store offline');
    const refused = await host.call('parent', { agent: 'forager-worker', prompt: 'Do it.' });
    expect(failureMessage(refused)).toBe("Hive could not write the route instructions of child session child-1 (entry store offline), so the child would run without its parent's route and standing constraints; the child was not prompted.");
    expect(host.admissions).toEqual([]);
    // The entry is written before the binding, so the refused child leaves no binding in `.hive`.
    expect(services.sessionService.peekGlobal('child-1')).toBeUndefined();

    host.entryState.fail = undefined;
    const ran = await host.call('parent', { agent: 'scout-researcher', prompt: 'Look.' });
    expect(Exit.isSuccess(ran)).toBe(true);
    const instructions = host.admissions[0].instructions!;
    expect(instructions).toContain('"featureRoute":{"selected":true,"feature":null}');
    expect(instructions).not.toContain('Task:');
    expect(instructions).toContain('Stay small.');
  });

  it('leaves a continued child binding unchanged when its instruction entry cannot be written for a task it would adopt', async () => {
    const { services, host } = await setup();
    services.sessionService.setFeatureRoute('parent', 'alpha');
    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Go.' }, 'call-first'))).toBe(true);
    const child = host.admissions.at(-1)!.child;
    const before = services.sessionService.peekGlobal(child);
    expect(before?.taskFolder).toBeUndefined();

    host.entryState.fail = new Error('entry store offline');
    const refused = await host.call('parent', { agent: 'forager-worker', prompt: 'Hive task: 01-build', sessionID: child }, 'call-adopt');
    expect(failureMessage(refused)).toContain(`Hive could not write the route instructions of child session ${child} (entry store offline)`);
    expect(host.admissions).toHaveLength(1);
    expect(services.sessionService.peekGlobal(child)).toEqual(before);
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
    expect(byParent['parent-a'].instructions).toContain('"feature":"alpha"');
    expect(byParent['parent-b'].instructions).toContain('"feature":"beta"');
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
    // Investigators carry the generic route but never the Forager task brief.
    for (const admission of [builtInInvestigator, customInvestigator]) {
      expect(admission.instructions).toContain('"featureRoute":{"selected":true,"feature":"alpha"}');
      expect(admission.text).not.toContain('hive-task-brief');
    }
    expect(nullRoute.instructions).toContain('"featureRoute":{"selected":true,"feature":null}');
    expect(nullRoute.text).not.toContain('hive-task-brief');
    expect(nullRoute.boundFeature).toBeNull();
    expect(scout.text).not.toContain('hive-task-brief');
    expect(custom.text).toContain('Task: 01-build - Build (pending)');
  });

  it('refuses a blank, whitespace-holding or bare "ses" or "ses_" sessionID before any host effect, telling each caller what it can do', async () => {
    const { host } = await setup();
    host.sessions.set('sub', { id: 'sub', parentID: 'parent', agent: 'architect-planner' });
    for (const sessionID of ['ses', 'ses_', 'ses\n', '', '  ', 'ses_abc def']) {
      const primary = failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'Continue.', sessionID }));
      expect(primary, JSON.stringify(sessionID)).toBe(`Subagent sessionID ${JSON.stringify(sessionID)} is malformed or truncated (likely the bare "ses" prefix of a session ID), so the host was not asked to continue the child. Read the exact child session IDs with hive_background_status({ includeSettled: true }), or omit sessionID to start a fresh forager-worker subagent call.`);
      const child = failureMessage(await host.call('sub', { agent: 'scout-researcher', prompt: 'Continue.', sessionID }, undefined, 'architect-planner'));
      expect(child, JSON.stringify(sessionID)).toBe(`Subagent sessionID ${JSON.stringify(sessionID)} is malformed or truncated (likely the bare "ses" prefix of a session ID), so the host was not asked to continue the child. Copy the exact child session ID from the subagent result that reported it, or omit sessionID to start a fresh scout-researcher subagent call.`);
    }
    expect(host.nativeInputs).toEqual([]);
    expect(host.activityState.reads).toBe(0);
    expect(host.catalog.reads).toBe(0);
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
    host.sessions.set('child-y', { id: 'child-y', parentID: 'parent', agent: 'forager-worker', model: ref('model-of-forager-worker') });
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const continued = await host.call('parent', { agent: 'forager-worker', prompt: 'Continue.', sessionID: 'child-y' });
    expect(Exit.isSuccess(continued)).toBe(true);
    expect(host.nativeInputs[0].sessionID).toBe('child-y');
    expect(host.admissions[0]).toMatchObject({ child: 'child-y', boundParent: 'parent', boundFeature: 'alpha' });
    expect(host.admissions[0].text.startsWith('Continue.\n\n<!-- hive-task-brief:start -->')).toBe(true);
    // One settlement read at the preflight and one again at the barrier.
    expect(host.activityState.reads).toBe(2);
  });

  for (const binding of ['missing', 'parentless'] as const) {
    it(`qualifies adoption of a child with a ${binding} Hive binding before native effects`, async () => {
      const { services, host } = await setup();
      services.sessionService.setFeatureRoute('parent', 'alpha');
      host.sessions.set('unbound', { id: 'unbound', parentID: 'parent', agent: 'forager-worker', model: ref('model-of-forager-worker') });
      if (binding === 'parentless') services.sessionService.trackGlobal('unbound', { agent: 'forager-worker' });
      const before = services.sessionService.getGlobal('unbound');
      host.active.add('unbound');

      const active = await host.call('parent', { agent: 'forager-worker', prompt: 'Adopt.', sessionID: 'unbound' });
      expect(failureMessage(active) ?? '').toContain('the host was not asked to continue the child');
      expect(host.nativeInputs).toEqual([]);
      expect(host.switches).toEqual([]);
      expect(host.admissions).toEqual([]);
      expect(host.sessions.get('unbound')).toMatchObject({ agent: 'forager-worker', model: ref('model-of-forager-worker') });
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
      expect(host.activityState.reads).toBe(4);
      expect(host.nativeInputs).toHaveLength(1);
      expect(host.switches).toEqual([]);
      expect(host.admissions[0]).toMatchObject({ child: 'unbound', boundParent: 'parent', boundAgent: 'forager-worker', boundFeature: 'alpha' });
    });
  }

  it('binds the helper of a child session to that session, which is its parent', async () => {
    const { host } = await setup();
    host.sessions.set('architect', { id: 'architect', parentID: 'parent', agent: 'architect-planner' });
    const exit = await host.call('architect', { agent: 'scout-researcher', prompt: 'Look around.' }, 'call-helper', 'architect-planner');
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(host.admissions[0]).toMatchObject({ child: 'child-1', boundParent: 'architect' });
  });

  it('associates each child with the task or run its marker names', async () => {
    const { root, services, host } = await setup();
    git(root, 'init', '-b', 'main');
    fs.writeFileSync(path.join(root, '.gitignore'), '.hive/\n');
    git(root, 'add', '.');
    git(root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'test: base');
    await services.adhocService().create({ runId: 'run-1' });
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const calls = [
      { agent: 'forager-worker', prompt: 'Hive task: 01-build' },
      { agent: 'forager-worker', prompt: 'Hive task: 01-build' },
      { agent: 'scout-researcher', prompt: 'Hive run: run-1' },
      { agent: 'scout-researcher', prompt: 'Hive run: run-1' },
      { agent: 'scout-researcher', prompt: 'Hive run: no-such-run' },
    ];
    for (const [index, input] of calls.entries()) expect(Exit.isSuccess(await host.call('parent', input, `call-${index}`))).toBe(true);
    expect([1, 2, 3, 4, 5].map((n) => association(services, `child-${n}`))).toEqual([
      { taskFolder: '01-build', adHocRunId: undefined },
      { taskFolder: '01-build', adHocRunId: undefined },
      { taskFolder: undefined, adHocRunId: 'run-1' },
      { taskFolder: undefined, adHocRunId: 'run-1' },
      { taskFolder: undefined, adHocRunId: undefined },
    ]);
    // Each child's instruction entry names the same association; an unresolved marker names none.
    const bindingLine = (n: number) => host.entries.get(`child-${n}`)!.get(HIVE_SESSION_INSTRUCTION_KEY)!.toString().split('\n')[2];
    expect([1, 3, 5].map(bindingLine)).toEqual(['Task: 01-build', 'Ad-hoc run: run-1', '']);
  });

  it('keeps a continued child on its own project, feature and task or run, and refuses a follow-up for another', async () => {
    const context = await setup({ features: ['alpha', 'beta'] });
    const { services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    services.adhocService = () => ({ get: async (runId: string) => (runId === 'run-1' ? { runId } : null) }) as any;
    // A child dispatched without a marker is bound to the route but to no task or run.
    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Go.' }, 'call-first'))).toBe(true);
    const child = host.admissions.at(-1)!.child;
    const continued = (prompt: string, callID: string, parent = 'parent') => host.call(parent, { agent: 'forager-worker', prompt, sessionID: child }, callID);

    // A follow-up marker may adopt a task when none is bound; settlement is read at the preflight and the barrier.
    expect(Exit.isSuccess(await continued('Hive task: 01-build', 'call-adopt'))).toBe(true);
    expect(association(services, child)).toEqual({ taskFolder: '01-build', adHocRunId: undefined });
    expect(host.activityState.reads).toBe(2);

    // Without a marker the follow-up keeps the bound task, and the Forager still receives that task's brief.
    expect(Exit.isSuccess(await continued('Continue.', 'call-unmarked'))).toBe(true);
    expect(association(services, child)).toEqual({ taskFolder: '01-build', adHocRunId: undefined });
    expect(host.admissions.at(-1)!.text).toContain('Task: 01-build - Build (pending)');
    expect(host.admissions.at(-1)!.text).not.toContain('No Hive task binding');
    expect(Exit.isSuccess(await continued('Hive task: 01-build', 'call-same'))).toBe(true);
    const inputs = host.nativeInputs.length;
    const reads = host.activityState.reads;

    // Another run, a marker Hive cannot resolve, and a marker with no ID are refused before any host read or effect.
    expect(failureMessage(await continued('Hive run: run-1', 'call-other-run'))).toBe(`Child session ${child} is bound to task 01-build, but the follow-up names run run-1; the host was not asked to continue the child. Omit sessionID and start a fresh forager-worker subagent call instead.`);
    for (const prompt of ['Hive task: 09-missing', 'Hive run:  \t\nContinue.']) {
      expect(failureMessage(await continued(prompt, `call-${prompt}`)), prompt).toBe(`The follow-up for child session ${child} opens with a Hive task or run marker that Hive cannot resolve on this call's route; the host was not asked to continue the child. Name the child's own task or run, or omit the marker line.`);
    }
    // Another feature on the parent's route is refused; changed standing constraints are not.
    services.sessionService.setFeatureRoute('parent', 'beta');
    expect(failureMessage(await continued('Continue.', 'call-beta'))).toBe(`Child session ${child} is bound to feature alpha, but this call's route selects feature beta; the host was not asked to continue the child. Omit sessionID and start a fresh forager-worker subagent call instead.`);
    expect(host.nativeInputs).toHaveLength(inputs);
    expect(host.activityState.reads).toBe(reads);
    expect(association(services, child)).toEqual({ taskFolder: '01-build', adHocRunId: undefined });
    services.sessionService.setFeatureRoute('parent', 'alpha');
    services.sessionService.addStandingConstraint('parent', 'New rule.');
    expect(Exit.isSuccess(await continued('Continue.', 'call-constraints'))).toBe(true);
    expect(services.sessionService.getGlobal(child)).toMatchObject({ featureName: 'alpha', taskFolder: '01-build' });
    expect(boundConstraintText(services, child)).toBe('New rule.');

    // A binding for another project is refused.
    services.sessionService.trackGlobal(child, { projectRoot: '/elsewhere' });
    expect(failureMessage(await continued('Continue.', 'call-project'))).toContain(`Child session ${child} is bound to project /elsewhere, not ${context.root}`);
  });

  it('refuses to continue an ad-hoc run child under a feature, and lets a featureless child join a feature created since', async () => {
    const { services, host } = await setup();
    services.adhocService = () => ({ get: async (runId: string) => (runId === 'run-1' ? { runId } : null) }) as any;
    expect(Exit.isSuccess(await host.call('lead', { agent: 'forager-worker', prompt: 'Hive run: run-1' }, 'call-run'))).toBe(true);
    const runChild = host.admissions.at(-1)!.child;
    expect(Exit.isSuccess(await host.call('lead', { agent: 'architect-planner', prompt: 'Plan it.' }, 'call-plan'))).toBe(true);
    const planner = host.admissions.at(-1)!.child;

    // The route now selects a feature, for example one the delegated Architect created.
    services.sessionService.setFeatureRoute('lead', 'alpha');
    expect(failureMessage(await host.call('lead', { agent: 'forager-worker', prompt: 'Continue.', sessionID: runChild }, 'call-run-2'))).toBe(`Child session ${runChild} is bound to ad-hoc run run-1, but this call's route selects feature alpha; the host was not asked to continue the child. Omit sessionID and start a fresh forager-worker subagent call instead.`);
    expect(Exit.isSuccess(await host.call('lead', { agent: 'architect-planner', prompt: 'Continue planning.', sessionID: planner }, 'call-plan-2'))).toBe(true);
    expect(services.sessionService.getGlobal(planner)).toMatchObject({ featureName: 'alpha', agent: 'architect-planner' });
  });

  it('runs a same-route child whose binding rewrite fails, and never prompts a child whose route it cannot write', async () => {
    const context = await setup();
    const { services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const tasked = await dispatchedChild(context);
    const track = services.sessionService.trackGlobal;
    const failing = () => { throw new Error('EACCES: permission denied, open sessions.json'); };
    services.sessionService.trackGlobal = failing;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The child already holds this route, so only the rewrite (activity time, association) is lost.
      const admitted = host.admissions.length;
      expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Continue.', sessionID: tasked }, 'call-continue'))).toBe(true);
      expect(host.admissions.slice(admitted).map((admission) => admission.child)).toEqual([tasked]);
      expect(warn.mock.calls.map(([message]) => String(message))).toEqual([expect.stringContaining(`could not rewrite the binding of child session ${tasked} (EACCES`)]);
      expect(String(warn.mock.calls[0]![0])).toContain('stored binding named task 01-build');

      // New constraints are a route the child does not hold yet, and a new child holds none: both need the write.
      services.sessionService.trackGlobal = track;
      services.sessionService.addStandingConstraint('parent', 'New rule.');
      services.sessionService.trackGlobal = failing;
      const before = host.admissions.length;
      expect(failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'Continue.', sessionID: tasked }, 'call-new-route'))).toContain(`Hive could not bind child session ${tasked} to its dispatch route (EACCES`);
      expect(failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'Hive task: 01-build' }, 'call-new'))).toContain('Hive could not bind child session child-2 to its dispatch route (EACCES');
      expect(host.admissions).toHaveLength(before);
      expect(boundConstraintText(services, tasked)).toBeUndefined();
    } finally {
      warn.mockRestore();
      services.sessionService.trackGlobal = track;
    }
  });

  it('refuses a same-route continuation that would adopt a task when the binding rewrite fails, before its prompt', async () => {
    const { services, host } = await setup();
    services.sessionService.setFeatureRoute('parent', 'alpha');
    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Go.' }, 'call-first'))).toBe(true);
    const child = host.admissions.at(-1)!.child;
    const before = services.sessionService.peekGlobal(child);
    const track = services.sessionService.trackGlobal;
    services.sessionService.trackGlobal = () => { throw new Error('EACCES: permission denied, open sessions.json'); };
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const refused = await host.call('parent', { agent: 'forager-worker', prompt: 'Hive task: 01-build', sessionID: child }, 'call-adopt');
      expect(failureMessage(refused)).toContain(`Hive could not bind child session ${child} to its dispatch route (EACCES`);
      expect(host.admissions).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
      expect(services.sessionService.peekGlobal(child)).toEqual(before);
    } finally {
      warn.mockRestore();
      services.sessionService.trackGlobal = track;
    }
  });

  it('refuses any continuation of a child another call of this activation is still starting, before the host touches the child', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { services, host } = await setup({ features: ['alpha', 'beta'], holdNewChild: hold });
    services.sessionService.setFeatureRoute('parent', 'alpha');
    services.sessionService.addStandingConstraint('parent', 'Only alpha.');
    const first = host.call('parent', { agent: 'forager-worker', prompt: 'Hive task: 01-build' }, 'call-1');
    while (host.admissions.length === 0) await Bun.sleep(1);

    // The same captured route would steer the child the earlier call just started.
    const same = await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: 'child-1' }, 'call-same');
    expect(failureMessage(same)).toBe('Child session child-1 has not settled (another unfinished subagent call in this plugin activation holds it). Hive does not send a follow-up to a child that still runs or has work pending, so it did not overwrite its binding and the host was not asked to continue the child. Wait for its final report before continuing it.');

    // A new constraint set would also rebind the child mid-run for the earlier call. The local call is known to be
    // unfinished, so the refusal needs no host read and comes before the host is invoked.
    services.sessionService.addStandingConstraint('parent', 'Now beta.');
    const conflicting = await host.call('parent', { agent: 'forager-worker', prompt: 'Switch.', sessionID: 'child-1' }, 'call-2');
    expect(failureMessage(conflicting)).toBe(failureMessage(same));
    expect(host.nativeInputs).toHaveLength(1);
    expect(host.admissions).toHaveLength(1);
    expect(host.activityState.reads).toBe(0);
    expect(services.sessionService.getGlobal('child-1')).toMatchObject({ parentSessionId: 'parent', featureName: 'alpha' });
    expect(boundConstraintText(services, 'child-1')).toBe('Only alpha.');

    // Once the earlier call has returned and the host reports the child idle, a continuation takes the new constraints.
    release();
    expect(Exit.isSuccess(await first)).toBe(true);
    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Switch.', sessionID: 'child-1' }, 'call-3'))).toBe(true);
    expect(services.sessionService.getGlobal('child-1')).toMatchObject({ featureName: 'alpha', taskFolder: '01-build' });
    expect(boundConstraintText(services, 'child-1')).toContain('Now beta.');
  });

  it('refuses every continuation of an active child, conflicting or compatible, before the host switches or steers it', async () => {
    const context = await setup({ features: ['alpha'] });
    const { services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context);
    host.active.add(child);

    // New standing constraints would rebind the running child.
    services.sessionService.addStandingConstraint('parent', 'Changed.');
    const conflicting = await host.call('parent', { agent: 'forager-worker', prompt: 'Look instead.', sessionID: child }, 'call-agent');
    expect(failureMessage(conflicting)).toBe(`Child session ${child} has not settled (active signal for ${child}). Hive does not send a follow-up to a child that still runs or has work pending, so it did not overwrite its binding and the host was not asked to continue the child. Wait for its final report before continuing it.`);
    expect(host.nativeInputs).toHaveLength(1);
    expect(host.switches).toEqual([]);
    expect(host.sessions.get(child)).toMatchObject({ agent: 'forager-worker', model: ref('model-of-forager-worker') });
    expect(services.sessionService.getGlobal(child)).toMatchObject({ parentSessionId: 'parent', featureName: 'alpha', agent: 'forager-worker' });

    // A plain follow-up on the same agent would join the running child's current run on this host, which Hive refuses too.
    const compatible = await host.call('parent', { agent: 'forager-worker', prompt: 'Also this.', sessionID: child }, 'call-steer');
    expect(failureMessage(compatible)).toBe(failureMessage(conflicting));
    expect(host.nativeInputs).toHaveLength(1);
    expect(host.admissions).toHaveLength(1);

    // Once the host reports the child idle, the same continuation runs.
    host.active.delete(child);
    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Also this.', sessionID: child }, 'call-idle'))).toBe(true);
    expect(host.switches).toEqual([]);
    expect(host.admissions.at(-1)).toMatchObject({ child, boundAgent: 'forager-worker', boundFeature: 'alpha' });
  });

  it('refuses a continuation of a child that is not active but whose job still runs or whose inbox holds queued work', async () => {
    const context = await setup();
    const { services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context);
    const before = services.sessionService.getGlobal(child);
    for (const signal of ['jobs', 'inbox'] as const) {
      host[signal].add(child);
      const refused = await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: child }, `call-${signal}`);
      expect(failureMessage(refused) ?? '', signal).toContain(`has not settled (${signal === 'jobs' ? 'job' : 'inbox'} signal for ${child})`);
      host[signal].delete(child);
    }
    expect(host.nativeInputs).toHaveLength(1);
    expect(host.switches).toEqual([]);
    expect(host.admissions).toHaveLength(1);
    expect(services.sessionService.getGlobal(child)).toEqual(before);
  });

  it('reads settlement again at the barrier, so a child that started work during the host\'s permission wait is not prompted', async () => {
    const pause: { during?: () => void } = {};
    const context = await setup({ pauseBeforeProgress: Effect.sync(() => pause.during?.()) });
    const { services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context);
    const before = services.sessionService.getGlobal(child);
    // The preflight finds the child settled; another client then queues work for it before the host reports progress.
    pause.during = () => host.inbox.add(child);
    const refused = await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: child }, 'call-late');
    expect(failureMessage(refused)).toBe(`Child session ${child} has not settled (inbox signal for ${child}). Hive does not send a follow-up to a child that still runs or has work pending, so it did not overwrite its binding and the child was not prompted. Wait for its final report before continuing it.`);
    expect(host.activityState.reads).toBe(2);
    expect(host.nativeInputs).toHaveLength(2);
    expect(host.admissions).toHaveLength(1);
    expect(services.sessionService.getGlobal(child)).toEqual(before);
  });

  it('checks the agent, model and binding again at the barrier, so a change during the host\'s permission wait is never prompted', async () => {
    const pause: { during?: () => void } = {};
    const context = await setup({ pauseBeforeProgress: Effect.sync(() => pause.during?.()) });
    const { services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context);
    const before = services.sessionService.getGlobal(child);

    // The preflight finds the configured model; another client then moves the child to another model.
    pause.during = () => { host.sessions.get(child)!.model = ref('drifted'); };
    expect(failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: child }, 'call-model'))).toBe(`Child session ${child} runs on test/drifted, but agent forager-worker is configured for test/model-of-forager-worker; the child was not prompted. Start a new forager-worker subagent call without sessionID to run on the configured model.`);
    host.sessions.get(child)!.model = ref('model-of-forager-worker');

    // Another client rebinds the child to a run during the wait; Hive neither overwrites nor prompts it.
    pause.during = () => { services.sessionService.trackGlobal(child, { adHocRunId: 'run-elsewhere' }); };
    expect(failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: child }, 'call-binding'))).toBe(`The binding of child session ${child} changed while the host awaited the call (it named project ${context.root}, feature alpha, task 01-build, run none at the preflight and names project ${context.root}, feature alpha, task 01-build, run run-elsewhere now); Hive did not overwrite it and the child was not prompted.`);
    expect(host.admissions).toHaveLength(1);
    expect(host.activityState.reads).toBe(2);
    expect(services.sessionService.getGlobal(child)).toMatchObject({ ...before, adHocRunId: 'run-elsewhere', lastActiveAt: expect.any(String) });
  });

  it('refuses a child the host moved to another location, at the preflight and at the barrier, without prompting it', async () => {
    const pause: { during?: () => void } = {};
    const context = await setup({ pauseBeforeProgress: Effect.sync(() => pause.during?.()) });
    const { services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context);
    const before = services.sessionService.getGlobal(child);

    host.sessions.get(child)!.location = { directory: '/workspace/other' };
    expect(failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: child }, 'call-moved'))).toBe(`Child session ${child} is in /workspace/other, not /workspace/project; Hive did not bind it and the host was not asked to continue the child.`);
    expect(host.nativeInputs).toHaveLength(1);

    delete host.sessions.get(child)!.location;
    pause.during = () => { host.sessions.get(child)!.location = { directory: '/workspace/other' }; };
    expect(failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: child }, 'call-moved-late'))).toBe(`Child session ${child} is in /workspace/other, not /workspace/project; Hive did not bind it and the child was not prompted.`);
    expect(host.admissions).toHaveLength(1);
    expect(services.sessionService.getGlobal(child)).toEqual(before);
  });

  it('refuses a continuation when the binding index is unreadable, and leaves the index as found', async () => {
    const context = await setup();
    const { root, services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context);
    const index = getNativeSessionsPath(root, 'opencode-v2');
    fs.writeFileSync(index, '{ not json');

    const refused = await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: child }, 'call-corrupt');
    expect(failureMessage(refused)).toBe(`Hive could not capture the dispatch route of session parent: Session index ${index} is unreadable; it was left unchanged for explicit recovery.`);
    expect(fs.readFileSync(index, 'utf8')).toBe('{ not json');
    expect(fs.readdirSync(path.dirname(index)).filter((name) => name.includes('.corrupt-'))).toEqual([]);
    expect(host.nativeInputs).toHaveLength(1);
    expect(host.admissions).toHaveLength(1);
    expect(host.activityState.reads).toBe(0);
  });

  it('continues a child on the route captured when the call started, even if the parent switches features during its first host read', async () => {
    const context = await setup({ features: ['alpha', 'beta'] });
    const { services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context);
    const session = host.context.session as unknown as { get: (input: { sessionID: string }) => Effect.Effect<unknown, unknown> };
    const read = session.get;
    let switched = false;
    session.get = (input) => Effect.suspend(() => {
      if (!switched) {
        switched = true;
        services.sessionService.setFeatureRoute('parent', 'beta');
      }
      return read(input);
    });

    const exit = await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: child }, 'call-switch');
    expect(failureMessage(exit)).toBeUndefined();
    expect(switched).toBe(true);
    const admission = host.admissions.at(-1)!;
    expect(admission.child).toBe(child);
    expect(admission.boundFeature).toBe('alpha');
    expect(admission.instructions).toContain('"feature":"alpha"');
  });

  it('treats unknown host activity as not idle for every continuation, and needs no activity read for a fresh dispatch', async () => {
    const context = await setup({ features: ['alpha', 'beta'] });
    const { services, host } = context;
    host.activityState.error = new Error('Session history reads need the oc-arkive `server` option');
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context);
    expect(host.activityState.reads).toBe(0);
    const same = await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: child }, 'call-same');
    expect(failureMessage(same)).toBe(`Hive could not confirm that child session ${child} has settled (Session history reads need the oc-arkive \`server\` option). Continuing a child needs a settled child, so Hive did not overwrite its binding and the host was not asked to continue the child.`);

    services.sessionService.addStandingConstraint('parent', 'Changed.');
    const unknown = await host.call('parent', { agent: 'forager-worker', prompt: 'Switch.', sessionID: child }, 'call-switch');
    expect(failureMessage(unknown)).toBe(failureMessage(same));
    expect(host.nativeInputs).toHaveLength(1);
    expect(boundConstraintText(services, child)).toBeUndefined();
  });

  it('reserves an incompatible preflight before an old idle snapshot can be overtaken by a returned background call', async () => {
    let releaseActivity!: () => void;
    const context = await setup();
    const { services, host } = context;
    services.sessionService.setFeatureRoute('parent', 'alpha');
    const child = await dispatchedChild(context);
    const before = services.sessionService.getGlobal(child);
    host.activityState.gate = new Promise<void>((resolve) => { releaseActivity = resolve; });

    services.sessionService.addStandingConstraint('parent', 'Changed.');
    const incompatible = host.call('parent', { agent: 'forager-worker', prompt: 'Switch.', sessionID: child }, 'call-A');
    try {
      for (let wait = 0; wait < 500 && host.activityState.reads === 0; wait += 1) await Bun.sleep(1);
      expect(host.activityState.reads).toBe(1);
      // A has captured idle but has not received the answer. B uses the old bound route, and returns running at once,
      // releasing its admission before A resumes. If B reaches native prompt admission, the host child becomes active.
      const continuation = host.subagent();
      const background = await Effect.runPromiseExit(continuation.execute(
        { agent: 'forager-worker', prompt: 'Background.', sessionID: child },
        { sessionID: 'parent', agent: 'swarm-orchestrator', messageID: 'msg', id: 'call-B', progress: () => Effect.sync(() => { host.active.add(child); }) } as any,
      ));
      expect(failureMessage(background) ?? '').toContain('has not settled');
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
    expect(host.switches).toEqual([]);
    expect(boundConstraintText(services, child)).toBe('Changed.');
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
      { agent: 'forager-worker', prompt: 'Switch.', sessionID: child },
      { sessionID: 'parent', agent: 'swarm-orchestrator', messageID: 'msg', id: 'call-A', progress: () => Effect.void } as any,
    ));
    for (let wait = 0; wait < 500 && host.activityState.reads === 0; wait += 1) await Bun.sleep(1);
    expect(host.activityState.reads).toBe(1);
    // B matches A's route, but A's reservation is not qualified compatibility: B is refused without a read of its own.
    const matching = await host.call('parent', { agent: 'forager-worker', prompt: 'Switch too.', sessionID: child }, 'call-B');
    expect(host.activityState.reads).toBe(1);
    expect(failureMessage(matching) ?? '').toContain('has not settled');
    // The pending settlement read received the call's signal, and interrupting the call aborts it.
    expect(host.activityState.signals[0]?.aborted).toBe(false);
    await Effect.runPromise(Fiber.interrupt(pending));
    expect(host.activityState.signals[0]?.aborted).toBe(true);
    releaseActivity();
    expect(host.nativeInputs).toHaveLength(1);
    expect(host.switches).toEqual([]);
    expect(host.admissions).toHaveLength(1);
    expect(services.sessionService.getGlobal(child)).toEqual(before);
    // The interrupted call released its reservation; once the host reports the child idle, a continuation runs.
    host.active.delete(child);
    expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'Continue.', sessionID: child }))).toBe(true);
  });

  it('fails a call that returns a child it never bound at the progress barrier, without binding it afterwards', async () => {
    const { services, host } = await setup({ skipProgress: true });
    const exit = await host.call('parent', { agent: 'forager-worker', prompt: 'Go.' }, 'call-unbound');
    expect(failureMessage(exit)).toBe('The subagent call returned child session child-1 without the progress update at which Hive binds the child before its prompt. Hive did not bind it after it ran, so the child may have run without its parent\'s route and standing constraints; inspect hive_task_trace({ task_id: "child-1" }) before relying on its result.');
    expect(services.sessionService.getGlobal('child-1')).toBeUndefined();
  });

  describe('managed-model control', () => {
    const teamForager = { baseAgent: 'forager-worker', description: 'Team forager', model: 'hive/team-default', variant: 'low' } as ResolvedCustomAgentConfig;

    it('refuses any model on a built-in or custom managed target, from any caller, before route capture, native effects, binding, launch or reservation', async () => {
      const context = await setup({ customAgents: { 'team-forager': teamForager } });
      const { services, host } = context;
      // A managed target with no configured model is refused the same way: the argument is the violation, not the lookup.
      host.catalog.models.set('scout-researcher', null);
      services.sessionService.setFeatureRoute('parent', 'alpha');
      const child = await dispatchedChild(context);
      const before = services.sessionService.getGlobal(child);
      let captures = 0;
      const capture = services.captureRoute.bind(services);
      services.captureRoute = ((session, options) => { captures += 1; return capture(session, options); }) as typeof services.captureRoute;

      for (const agent of ['forager-worker', 'team-forager', 'scout-researcher']) {
        // A different model, the configured model itself, and the configured model with a reasoning variant.
        for (const model of ['other/elsewhere', `test/model-of-${agent}`, `test/model-of-${agent}#high`]) {
          // A Hive orchestrator and an unmanaged caller that the role guard would otherwise let delegate.
          for (const caller of ['swarm-orchestrator', 'my-own-agent']) {
            const fresh = await host.call('parent', { agent, prompt: 'Hive task: 01-build', model }, `call-fresh-${agent}-${model}-${caller}`, caller);
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

      // Nothing was reserved: the corrected calls run, the settled child's continuation with its two settlement reads and
      // on the child's model.
      expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: child }, 'call-corrected', 'my-own-agent'))).toBe(true);
      expect(Exit.isSuccess(await host.call('parent', { agent: 'team-forager', prompt: 'Hive task: 01-build' }, 'call-corrected-fresh'))).toBe(true);
      expect(host.nativeInputs.slice(1).map((input) => 'model' in input)).toEqual([false, false]);
      expect(host.sessions.get('child-2')?.model).toEqual(ref('model-of-team-forager'));
      expect(host.activityState.reads).toBe(2);
    });

    it('passes a model through unchanged for native general and explore and for unmanaged targets', async () => {
      const { host } = await setup();
      for (const agent of ['general', 'explore', 'someone-elses-agent']) {
        expect(Exit.isSuccess(await host.call('parent', { agent, prompt: 'Look.', model: 'other/chosen#max' }))).toBe(true);
      }
      expect(host.nativeInputs.map((input) => input.model)).toEqual(['other/chosen#max', 'other/chosen#max', 'other/chosen#max']);
      expect([...host.sessions.values()].filter((session) => session.parentID !== undefined).map((session) => session.model)).toEqual([ref('chosen', 'max', 'other'), ref('chosen', 'max', 'other'), ref('chosen', 'max', 'other')]);
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
      // Only the accepted continuation read settlement (preflight and barrier); drift is refused before that read.
      expect(host.activityState.reads).toBe(2);
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
      host.catalog.models.set('forager-investigator', null);
      expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-investigator', prompt: 'Look.' }))).toBe(true);
      expect(host.sessions.get('child-2')?.model).toEqual(ref('parent-model'));
      host.sessions.get('child-2')!.model = ref('earlier-model');
      expect(Exit.isSuccess(await host.call('parent', { agent: 'forager-investigator', prompt: 'More.', sessionID: 'child-2' }))).toBe(true);
      expect(host.sessions.get('child-2')?.model).toEqual(ref('earlier-model'));
      expect(host.switches).toEqual([]);
    });

    it('continues only resumable workers on their own agent, and refuses one-shot roles and agent switches before any host read', async () => {
      const customAgents = {
        'team-scout': { baseAgent: 'scout-researcher', description: 'Team scout' } as ResolvedCustomAgentConfig,
        'team-forager': { baseAgent: 'forager-worker', description: 'Team forager' } as ResolvedCustomAgentConfig,
      };
      const { services, host } = await setup({ customAgents });
      const fresh = async (agent: string) => {
        expect(Exit.isSuccess(await host.call('parent', { agent, prompt: 'Go.' })), agent).toBe(true);
        return host.admissions.at(-1)!.child;
      };
      const oneShot = ['scout-researcher', 'code-reviewer', 'approach-advisor', 'hive-helper', 'team-scout', 'explore'];
      for (const agent of oneShot) {
        const child = await fresh(agent);
        const inputs = host.nativeInputs.length;
        const refused = await host.call('parent', { agent, prompt: 'More.', sessionID: child });
        expect(failureMessage(refused) ?? '', agent).toContain(`Agent ${agent} is one-shot`);
        expect(failureMessage(refused) ?? '', agent).toContain(`Omit sessionID and start a fresh ${agent} subagent call instead.`);
        expect(host.nativeInputs, agent).toHaveLength(inputs);
      }
      expect(host.activityState.reads).toBe(0);
      expect(host.catalog.reads).toBe(0);

      for (const agent of ['forager-worker', 'forager-investigator', 'architect-planner', 'team-forager', 'general']) {
        const child = await fresh(agent);
        expect(Exit.isSuccess(await host.call('parent', { agent, prompt: 'More.', sessionID: child })), agent).toBe(true);
      }

      // A resumable child is continued only on the agent the host reports and its binding names.
      const worker = await fresh('forager-worker');
      const before = services.sessionService.getGlobal(worker);
      const reads = host.activityState.reads;
      expect(failureMessage(await host.call('parent', { agent: 'forager-investigator', prompt: 'Check.', sessionID: worker }))).toBe(`Child session ${worker} runs agent forager-worker, not forager-investigator; Hive continues a child only on its own agent, so the host was not asked to continue the child. Omit sessionID and start a fresh forager-investigator subagent call instead.`);
      services.sessionService.trackGlobal(worker, { agent: 'forager-investigator' });
      expect(failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'More.', sessionID: worker })) ?? '').toContain('runs agent forager-worker (bound as forager-investigator), not forager-worker');
      expect(host.switches).toEqual([]);
      expect(host.activityState.reads).toBe(reads);
      expect(services.sessionService.getGlobal(worker)).toMatchObject({ parentSessionId: 'parent', projectRoot: before?.projectRoot, agent: 'forager-investigator' });
    });
  });

  it('is composed by the production activation, which supplies the barrier and judges the input every execute.before hook produced', async () => {
    const root = project();
    const home = fs.mkdtempSync(`/tmp/hive-v2-dispatch-home-${process.pid}-`);
    cleanup.push(home);
    const services = createHiveServices({ projectRoot: root, nativeObservationOwner: 'opencode-v2' });
    const host = fakeHost(services, { directory: root });
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
    // XDG_STATE_HOME also moves: without a `server` option the reader looks for the managed service registered there.
    const saved = { HOME: process.env.HOME, OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = path.join(home, '.local', 'state');
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
    // The production activation writes the child's route entry at the barrier, so the prompt carries no footer.
    expect(host.admissions[0].instructions).toContain('"featureRoute":{"selected":true,"feature":"alpha"}');
    expect(host.admissions[0].text).not.toContain('hive-route-snapshot');

    // Another plugin's hook, registered after Hive's, injects a model into the call; the wrapper sees the final input.
    expect(host.beforeHooks.length).toBeGreaterThan(0);
    host.beforeHooks.push((event) => Effect.sync(() => { if (event.tool === NATIVE_SUBAGENT_TOOL) event.input = { ...event.input, model: 'other/injected' }; }));
    expect(failureMessage(await host.call('parent', { agent: 'forager-worker', prompt: 'Hive task: 01-build' })) ?? '').toContain('may not set model (it set "other/injected")');
    expect(host.nativeInputs).toHaveLength(1);
  });
});
