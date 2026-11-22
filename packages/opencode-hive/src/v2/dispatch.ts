import { Effect } from 'effect';
import type { Scope } from 'effect';
import { Tool } from '@opencode/plugin/effect';
import type { Model, Plugin } from '@opencode/plugin/effect';
import type { AssignmentMarker, HiveServices } from '../runtime/hive-services.js';
import type { SessionInfo } from 'hive-core';
import { RESUMABLE_SUBAGENT_ROLES } from '../runtime/role-policy.js';
import { childAssociation, childRouteRecord, composeDispatchPrompt, resolveAssignment, sameChildRoute, type ChildRoute } from '../task-brief.js';
import type { VerifiedTreeReadAccess } from './client.js';
import type { HiveAuthority } from './registration.js';

/** The host's native subagent tool. */
export const NATIVE_SUBAGENT_TOOL = 'subagent';

/** Whether a child has settled in the host, read through the catalog's verified read access. */
type NativeActivity = Pick<VerifiedTreeReadAccess, 'childSettlement'>;

/** A refusal raised before the host continues a child, or inside the awaited progress barrier before it prompts one. */
class ChildBindingRefused {
  constructor(readonly message: string) {}
}

/** The qualified host's subagent input. It has no `background` field: every call runs the child in the background. */
type SubagentInput = { agent: string; description?: string; prompt: string; model?: string; sessionID?: string };

/**
 * The one unfinished call of this activation that holds each child, by call ID. A continuation reserves its child before
 * any awaited host read; a new child, which the host creates after the call starts, at its barrier. A second call for a
 * held child is refused whatever its route, and the reservation ends when the holding call returns. It does not queue
 * or schedule anything, and the host still decides when the child runs.
 */
type Admissions = Map<string, string>;

/**
 * Wraps the host's own subagent tool; the host still validates, schedules, runs, interrupts and notifies. On the
 * qualified host every call starts or continues the child in the background and returns `running` at once; the host
 * reports the child's result to the parent in a later subagent report message. The wrapper adds what Hive owns at
 * dispatch:
 *
 * - The parent's route and standing constraints, captured when the call starts, and the parent's authored prompt
 *   (before the host adds its subagent prefix) composed with the route footer and, for a Forager on a selected feature
 *   route, the task brief from its `Hive task:` line, or from the task a continued child is bound to when the
 *   follow-up has no marker.
 * - Model selection for Hive-managed targets (built-in roles and custom agents): a call that sets `model` is refused
 *   before anything else runs, whatever the caller and whatever the value, so the target runs on the model and
 *   variant its effective native agent entry configures. Native `general`/`explore` and unmanaged targets keep the
 *   host's behavior. This governs the call's argument only; configuration files and other session APIs are not locked.
 * - For a continued `sessionID`, a preflight before the prompt is composed and the host runs, because the host
 *   switches a continued child's agent and model before it reports progress. Only a resumable role (or a custom agent
 *   derived from one), native `general`, or an unmanaged agent may be continued, and only on the agent it already
 *   runs. A local reservation and the route capture both come before any awaited read: the reservation excludes other
 *   calls of this activation, and the captured route is the one the parent held when the call started. The child
 *   must be a native child of the caller in this location, not bound to another parent, and still on the project,
 *   feature and task or run its binding names; a follow-up marker may name the bound task or run, or adopt one when
 *   none is bound, and an unresolvable marker is refused. The parent's route and the binding
 *   are read without the index's reset-on-corruption path, so an unreadable index refuses the continuation and is
 *   left as found.
 *   Continuing a managed child requires its session model to equal the agent's configured model, because the host
 *   keeps a same-agent child's model. Every continuation needs a settled child, because the host joins a follow-up to
 *   a running child's current run, and Hive does not steer a running worker: the verified reader's settlement read
 *   (any job the host still lists for the child or its descendants, and the inboxes and active executions of every
 *   session in the child's tree) must find no work. An unreadable signal is not settled. Neither read is atomic with
 *   the host, and another client can start work after the last read. Standing constraints are not compared: the
 *   binding takes the parent's current ones. The `sessionID` is passed through unchanged.
 * - A barrier on the progress update the host awaits before it admits the child's prompt: Hive reads the child from
 *   the host again, requires that its parent is this call's session, that it is in this location and that no other
 *   parent owns its binding, and writes the child's binding: the captured route with its task or run association, or
 *   with the stored association when a continuation names none. For a continuation, the barrier runs after any
 *   permission prompt the host awaited, so it checks again that the child runs the target agent (and, when managed,
 *   its configured model), that its binding's project, feature, task and run are those the preflight read, and that
 *   it has settled. If a step fails, the call fails and the child is never prompted, except that a child already
 *   bound to the captured route still runs when only the rewrite fails; Hive warns. A call that returns successfully
 *   for a child it never bound at that barrier fails instead of being bound late.
 */
export function registerDispatch(input: { context: Plugin.Context; services: HiveServices; authority: HiveAuthority; activity: NativeActivity }): Effect.Effect<void, never, Scope.Scope> {
  const { context } = input;
  const admissions: Admissions = new Map();
  return context.tool.transform((editor) => {
    editor.update(NATIVE_SUBAGENT_TOOL, (tool) => {
      const native = tool.execute;
      tool.execute = (args, toolContext) => dispatchSubagent({ ...input, admissions }, native, args as SubagentInput, toolContext);
    });
  }).pipe(Effect.asVoid);
}

const NOT_CONTINUED = 'the host was not asked to continue the child';
/** The variant the host reports for a stored session model that has none. */
const DEFAULT_VARIANT = 'default';
const NOT_PROMPTED = 'the child was not prompted';

function dispatchSubagent(
  deps: { context: Plugin.Context; services: HiveServices; authority: HiveAuthority; activity: NativeActivity; admissions: Admissions },
  native: Tool.Info['execute'],
  args: SubagentInput,
  toolContext: Tool.Context,
): Effect.Effect<Tool.Result, Tool.Error> {
  const { context, services, authority, activity, admissions } = deps;
  const parent: string = toolContext.sessionID;
  const call: string = toolContext.id;
  const target = authority.resolve(args.agent);
  // Built-in roles and custom agents; native `general`/`explore` and unmanaged agents keep the host's model behavior.
  const managed = target.kind === 'role';
  let admitted: string | undefined;
  let bound: string | undefined;

  const refuse = (message: string) => Effect.fail(new ChildBindingRefused(message));
  const fresh = `Omit sessionID and start a fresh ${args.agent} subagent call instead.`;
  const unsettled = (child: string, why: string, outcome: string) => `Child session ${child} has not settled (${why}). Hive does not send a follow-up to a child that still runs or has work pending, so it did not overwrite its binding and ${outcome}. Wait for its final report before continuing it.`;

  /** The child must be the caller's native child in this location; read from the host each time it is checked. */
  const confirmParent = (child: string, outcome: string) => context.session.get({ sessionID: child as never }).pipe(
    Effect.mapError(() => new ChildBindingRefused(`Hive could not read child session ${child} to confirm its parent; ${outcome}.`)),
    Effect.flatMap((session) => {
      if (session.parentID !== parent) return refuse(`Child session ${child} is not a child of ${parent}; Hive did not bind it and ${outcome}.`);
      const directory = session.location?.directory;
      if (directory !== context.location.directory) return refuse(`Child session ${child} is in ${String(directory)}, not ${context.location.directory}; Hive did not bind it and ${outcome}.`);
      return Effect.succeed(session);
    }),
  );

  /**
   * A continuation keeps the child's session model, so it must already be the target's configured model. The
   * configured model is the host's effective agent entry for the actual target, where native user configuration wins
   * over Hive's defaults. A target without a configured model inherits natively and is not checked.
   */
  const confirmModel = (child: string, actual: Model.Ref | undefined, outcome: string) => context.agent.get({ agentID: args.agent as never }).pipe(
    Effect.mapError((error) => new ChildBindingRefused(`Hive could not read the configured model of agent ${args.agent} (${describe(error)}), so it cannot confirm that child session ${child} runs on it; ${outcome}.`)),
    Effect.flatMap(({ data }) => {
      const expected = data.model;
      if (expected === undefined || (actual !== undefined && sameModel(expected, actual))) return Effect.void;
      return refuse(`Child session ${child} runs on ${actual === undefined ? 'no recorded model' : formatModel(actual)}, but agent ${args.agent} is configured for ${formatModel(expected)}; ${outcome}. Start a new ${args.agent} subagent call without sessionID to run on the configured model.`);
    }),
  );

  /**
   * The host's session agent decides whether it switches the child; a binding that names the target agent is not
   * enough when the host reports another one, and a binding that names another agent is not overwritten.
   */
  const confirmAgent = (child: string, agent: unknown, stored: SessionInfo | undefined, outcome: string) => agent === args.agent && (stored?.agent === undefined || stored.agent === args.agent)
    ? Effect.void
    : refuse(`Child session ${child} runs agent ${String(agent)}${stored?.agent !== undefined && stored.agent !== agent ? ` (bound as ${stored.agent})` : ''}, not ${args.agent}; Hive continues a child only on its own agent, so ${outcome}. ${fresh}`);

  /**
   * The child's Hive binding, if it has one; a binding owned by another parent is never overwritten. The index is read
   * without its reset-on-corruption path, so an unreadable index refuses the call and stays as found.
   */
  const ownBinding = (child: string, outcome: string) => Effect.try({
    try: () => services.sessionService.peekGlobal(child),
    catch: (error) => new ChildBindingRefused(`Hive could not read the binding of child session ${child} (${describe(error)}); ${outcome}.`),
  }).pipe(Effect.flatMap((stored) => stored?.parentSessionId === undefined || stored.parentSessionId === parent
    ? Effect.succeed(stored)
    : refuse(`Child session ${child} is already bound to parent ${stored.parentSessionId}; Hive did not overwrite it and ${outcome}.`)));

  /** Takes the child for this call; a child another unfinished call of this activation holds is refused. */
  const admit = (child: string, outcome: string) => {
    if (admissions.has(child)) return refuse(unsettled(child, 'another unfinished subagent call in this plugin activation holds it', outcome));
    admissions.set(child, call);
    admitted = child;
    return Effect.void;
  };

  const release = Effect.sync(() => {
    if (admitted !== undefined && admissions.get(admitted) === call) admissions.delete(admitted);
  });

  /**
   * Requires the host to report the child settled. A signal Hive cannot read is reported as unknown, never as settled.
   * Interrupting the call aborts the reads through the signal the effect provides.
   */
  const requireSettled = (child: string, outcome: string) => Effect.tryPromise({ try: (signal) => activity.childSettlement({ parentID: parent, childID: child }, signal), catch: (error) => error }).pipe(
    Effect.catch((error: unknown) => refuse(`Hive could not confirm that child session ${child} has settled (${describe(error)}). Continuing a child needs a settled child, so Hive did not overwrite its binding and ${outcome}.`)),
    Effect.flatMap((state) => 'detail' in state ? refuse(unsettled(child, state.detail, outcome)) : Effect.void),
  );

  /** Whether the target agent may be continued at all; decided before any host read. */
  const resumable = (child: string) => {
    if (target.kind === 'role' && !RESUMABLE_SUBAGENT_ROLES.has(target.role)) {
      return refuse(`Agent ${args.agent} is one-shot: Hive continues only resumable workers (${[...RESUMABLE_SUBAGENT_ROLES].join(', ')}, or custom agents derived from them), so child session ${child} was not continued and ${NOT_CONTINUED}. ${fresh}`);
    }
    if (target.kind === 'native-subagent' && target.name === 'explore') {
      return refuse(`Agent explore is one-shot, so child session ${child} was not continued and ${NOT_CONTINUED}. ${fresh}`);
    }
    return Effect.void;
  };

  /**
   * Checks a continued child against the host before the prompt is composed and the host runs, so a refused
   * continuation leaves its agent, model and binding untouched. Returns the child's stored binding.
   */
  const preflight = (child: string) => Effect.gen(function* () {
    const session = yield* confirmParent(child, NOT_CONTINUED);
    const stored = yield* ownBinding(child, NOT_CONTINUED);
    yield* confirmAgent(child, session.agent, stored, NOT_CONTINUED);
    if (managed) yield* confirmModel(child, session.model, NOT_CONTINUED);
    return stored;
  });

  /** Requires the continued child's binding to fit the captured route and marker, then a settled child. */
  const qualifyRoute = (child: string, stored: SessionInfo | undefined, route: ChildRoute, marker: AssignmentMarker) => Effect.gen(function* () {
    if (stored?.projectRoot !== undefined && stored.projectRoot !== route.projectRoot) {
      return yield* refuse(`Child session ${child} is bound to project ${stored.projectRoot}, not ${route.projectRoot}; ${NOT_CONTINUED}. ${fresh}`);
    }
    // A child bound to no feature may continue under one (a delegated Architect can create it), unless it is bound
    // to an ad-hoc run, which belongs to no feature.
    const boundFeature = stored?.featureName ?? undefined;
    const routeFeature = route.featureName ?? undefined;
    if (boundFeature !== undefined ? boundFeature !== routeFeature : routeFeature !== undefined && stored?.adHocRunId !== undefined) {
      return yield* refuse(`Child session ${child} is bound to ${boundFeature !== undefined ? `feature ${boundFeature}` : `ad-hoc run ${stored?.adHocRunId}`}, but this call's route selects ${routeFeature === undefined ? 'no feature' : `feature ${routeFeature}`}; ${NOT_CONTINUED}. ${fresh}`);
    }
    if (marker.state === 'invalid') {
      return yield* refuse(`The follow-up for child session ${child} opens with a Hive task or run marker that Hive cannot resolve on this call's route; ${NOT_CONTINUED}. Name the child's own task or run, or omit the marker line.`);
    }
    if (marker.state === 'resolved' && stored !== undefined && (stored.taskFolder !== undefined || stored.adHocRunId !== undefined)) {
      const named = childAssociation(marker);
      if (stored.taskFolder !== named.taskFolder || stored.adHocRunId !== named.adHocRunId) {
        return yield* refuse(`Child session ${child} is bound to ${describeAssociation(stored)}, but the follow-up names ${describeAssociation(named)}; ${NOT_CONTINUED}. ${fresh}`);
      }
    }
    yield* requireSettled(child, NOT_CONTINUED);
  });

  const refused = (refusal: ChildBindingRefused) => new Tool.Error({ message: refusal.message });

  return Effect.gen(function* () {
    if (managed && args.model !== undefined) {
      return yield* Effect.fail(new Tool.Error({ message: `Hive manages the model of agent ${args.agent}, so this subagent call may not set model (it set ${JSON.stringify(args.model)}); the host was not called. Repeat the call without model: the agent runs on its effective configured model and variant, or inherits its parent's model when it has none. The operator changes that model in native agent configuration or agent_hive.json.` }));
    }
    // A continuation takes its reservation before any awaited read, so two calls of this activation never interleave
    // their reads of one child.
    if (args.sessionID !== undefined) {
      yield* resumable(args.sessionID).pipe(Effect.mapError(refused));
      yield* admit(args.sessionID, NOT_CONTINUED).pipe(Effect.mapError(refused));
    }
    // The route is captured before the first host read, so a parent that switches routes while the host answers does
    // not move this call. A continuation reads the index without its reset-on-corruption path and leaves an unreadable
    // index as found.
    const snapshot = yield* Effect.try({
      try: () => services.captureRoute(parent, { strict: args.sessionID !== undefined }),
      catch: (error) => new Tool.Error({ message: `Hive could not capture the dispatch route of session ${parent}: ${describe(error)}` }),
    });
    const stored = args.sessionID === undefined ? undefined : yield* preflight(args.sessionID).pipe(Effect.mapError(refused));
    const marker = yield* Effect.promise(() => resolveAssignment(services, snapshot, args.prompt));
    const route = childRouteRecord(snapshot, parent, args.agent);
    if (args.sessionID !== undefined) yield* qualifyRoute(args.sessionID, stored, route, marker).pipe(Effect.mapError(refused));

    const prompt = composeDispatchPrompt({
      sources: { projectRoot: services.projectRoot, taskService: services.taskService, contextService: services.contextService },
      snapshot,
      prompt: args.prompt,
      foragerDispatch: target.kind === 'role' && target.role === 'forager-worker',
      fallbackTaskFolder: marker.state === 'none' ? stored?.taskFolder : undefined,
    });

    const bind = (child: string) => Effect.gen(function* () {
      const session = yield* confirmParent(child, NOT_PROMPTED);
      const current = yield* ownBinding(child, NOT_PROMPTED);
      if (admitted === undefined) yield* admit(child, NOT_PROMPTED);
      else {
        // A continuation is checked again here, after any permission prompt the host awaited since the preflight: the
        // agent and model the host will run, the binding the preflight qualified, and settlement.
        yield* confirmAgent(child, session.agent, current, NOT_PROMPTED);
        if (managed) yield* confirmModel(child, session.model, NOT_PROMPTED);
        if (!sameBindingIdentity(stored, current)) {
          return yield* refuse(`The binding of child session ${child} changed while the host awaited the call (it named ${describeBinding(stored)} at the preflight and names ${describeBinding(current)} now); Hive did not overwrite it and ${NOT_PROMPTED}.`);
        }
        yield* requireSettled(child, NOT_PROMPTED);
      }
      // Every bind rewrites the binding, so it carries the parent's current constraints and activity time. A
      // continuation without a marker writes no association, so the stored task or run stays.
      try {
        services.sessionService.trackGlobal(child, { ...route, ...childAssociation(marker) });
      } catch (error) {
        // A child already bound to this route runs on it; only the rewrite is lost.
        if (current === undefined || !sameChildRoute(current, route)) {
          return yield* refuse(`Hive could not bind child session ${child} to its dispatch route (${describe(error)}); ${NOT_PROMPTED}.`);
        }
        console.warn(`[hive:routing] Hive could not rewrite the binding of child session ${child} (${describe(error)}); the child runs on its unchanged route. Before the write its stored binding named ${describeAssociation(current)}; whether the failed write changed it is unknown.`);
      }
      bound = child;
    });

    // The progress update carrying the child's session is the last step before the host prompts the child.
    const progress: Tool.Context['progress'] = (update) => {
      const child = typeof update.sessionID === 'string' ? update.sessionID : undefined;
      const barrier = child === undefined || child === bound
        ? Effect.void
        : bound !== undefined
          ? Effect.die(new ChildBindingRefused(`The subagent call reported a second child session ${child} after ${bound}; Hive did not bind it.`))
          : admitted !== undefined && child !== admitted
            ? Effect.die(new ChildBindingRefused(`The subagent call continued ${admitted} but reported child session ${child}; Hive did not bind it.`))
            : bind(child).pipe(Effect.orDie);
      return barrier.pipe(Effect.andThen(toolContext.progress(update)));
    };

    return yield* native({ ...args, prompt }, { ...toolContext, progress }).pipe(
      Effect.catchDefect((defect) => defect instanceof ChildBindingRefused ? Effect.fail(new Tool.Error({ message: defect.message })) : Effect.die(defect)),
      // The qualified host reports the child's progress, which Hive binds, before it prompts the child. A success for a
      // child Hive did not bind there means the child ran without its route; it is reported, never bound afterwards.
      Effect.flatMap((result) => {
        const reported = reportedChild(result);
        if (bound !== undefined && reported === bound) return Effect.succeed(result);
        const child = reported === undefined ? 'no child session' : `child session ${reported}`;
        const why = bound === undefined
          ? 'without the progress update at which Hive binds the child before its prompt'
          : `after Hive bound ${bound} at the progress update`;
        return Effect.fail(new Tool.Error({ message: `The subagent call returned ${child} ${why}. Hive did not bind it after it ran, so the child may have run without its parent's route and standing constraints${reported === undefined ? '' : `; inspect hive_task_trace({ task_id: ${JSON.stringify(reported)} }) before relying on its result`}.` }));
      }),
    );
  }).pipe(Effect.ensuring(release));
}

function describeAssociation(binding: { taskFolder?: string; adHocRunId?: string }): string {
  return binding.taskFolder ? `task ${binding.taskFolder}` : binding.adHocRunId ? `run ${binding.adHocRunId}` : 'no task or run';
}

/** The binding fields a continuation's preflight qualifies against the captured route, with their labels. */
const BINDING_IDENTITY = { projectRoot: 'project', featureName: 'feature', taskFolder: 'task', adHocRunId: 'run' } as const;

function sameBindingIdentity(before: SessionInfo | undefined, after: SessionInfo | undefined): boolean {
  return (Object.keys(BINDING_IDENTITY) as Array<keyof typeof BINDING_IDENTITY>).every((field) => before?.[field] === after?.[field]);
}

function describeBinding(binding: SessionInfo | undefined): string {
  if (binding === undefined) return 'no binding';
  return Object.entries(BINDING_IDENTITY).map(([field, label]) => `${label} ${binding[field as keyof typeof BINDING_IDENTITY] ?? 'none'}`).join(', ');
}

/**
 * Model references are equal when provider, model and variant match. A missing variant is the model's default: the
 * agent entry omits it, while the host reports a stored session model with `default` in its place.
 */
function sameModel(expected: Model.Ref, actual: Model.Ref): boolean {
  return expected.providerID === actual.providerID && expected.id === actual.id && (expected.variant ?? DEFAULT_VARIANT) === (actual.variant ?? DEFAULT_VARIANT);
}

/** Shows the default variant as the omitted variant, as the user writes `provider/model`. */
function formatModel(ref: Model.Ref): string {
  return `${ref.providerID}/${ref.id}${ref.variant === undefined || ref.variant === DEFAULT_VARIANT ? '' : `#${ref.variant}`}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportedChild(result: Tool.Result): string | undefined {
  const source = (result.output && typeof result.output === 'object' ? result.output : result.metadata) as Record<string, unknown> | undefined;
  return typeof source?.sessionID === 'string' ? source.sessionID : undefined;
}
