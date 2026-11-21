import { Cause, Effect, Exit } from 'effect';
import type { Scope } from 'effect';
import { Tool } from '@opencode/plugin/effect';
import type { Model, Plugin } from '@opencode/plugin/effect';
import type { SessionInfo } from 'hive-core';
import type { HiveServices } from '../runtime/hive-services.js';
import { boundChildScope } from '../background/backgroundJobAdapter.js';
import { childAssociation, childRouteRecord, composeDispatchPrompt, provenChildBinding, resolveAssignment, sameChildRoute } from '../task-brief.js';
import type { BackgroundLaunch, V2BackgroundLifecycle } from './background.js';
import type { VerifiedTreeReadAccess } from './client.js';
import type { HiveAuthority } from './registration.js';

/** The host's native subagent tool. */
export const NATIVE_SUBAGENT_TOOL = 'subagent';

/** Whether a child has settled in the host, read through the catalog's verified read access. */
export type NativeActivity = Pick<VerifiedTreeReadAccess, 'childSettlement'>;

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
 * reports the child's result to the parent in a later `<subagent>` message. The wrapper adds what Hive owns at dispatch:
 *
 * - The parent's route and standing constraints, captured when the call starts, and the parent's authored prompt
 *   (before the host adds its subagent prefix) composed with the route footer and, for a Forager on a selected feature
 *   route, the task brief from its `Hive task:` line.
 * - Model selection for Hive-managed targets (built-in roles and custom agents): a call that sets `model` is refused
 *   before anything else runs, whatever the caller and whatever the value, so the target runs on the model and
 *   variant its effective native agent entry configures. Native `general`/`explore` and unmanaged targets keep the
 *   host's behavior. This governs the call's argument only; configuration files and other session APIs are not locked.
 * - For a continued `sessionID`, a preflight before the host runs, because the host switches a continued child's agent
 *   and model before it reports progress. The child must be a native child of the caller and not bound to another
 *   parent. Continuing a managed child on its own agent requires its session model to equal that agent's configured
 *   model, because the host keeps a same-agent child's model; a switch to another agent takes the destination's
 *   configured model from the host. Every continuation needs a settled child, because the host joins a follow-up to a
 *   running child's current run, and Hive does not steer a running worker: a local reservation excludes other calls of
 *   this activation, and the verified reader's settlement read (any job the host still lists for the child or its
 *   descendants, and the inboxes and active executions of every session in the child's tree) must find no work. An unreadable signal is not settled. The read runs
 *   again at the barrier, after any permission prompt the host awaited, so a child that started work in between is not
 *   prompted. Neither read is atomic with the host: by the barrier the host may already have switched the child's agent
 *   and model, and another client can start work after the last read. The `sessionID` itself is passed through
 *   unchanged.
 * - A barrier on the progress update the host awaits before it admits the child's prompt: Hive reads the child from
 *   the host again, requires that its parent is this call's session and that no other parent owns its binding, and
 *   binds the child to the captured route, with its task or run association beside it. If a step fails, the call
 *   fails and the child is never prompted, except that a child already bound to the captured route still runs when
 *   only its new association cannot be recorded; Hive warns, and the launch row names no task or run it cannot prove.
 *   A call that returns successfully for a child it never bound at that barrier fails instead of being bound late.
 * - For a call from a primary session, the board row, recorded at the barrier so a fast child cannot finish before its
 *   row exists, and retried once when the call returns if that write failed. When the call then ends without returning
 *   normally, that row is marked uncertain. A call from a child session (a delegated Architect's helper) records no
 *   row: the board and its tools belong to primaries, and the host reports that helper's result to its own parent. The
 *   board is never read to decide whether a dispatch may run.
 */
export function registerDispatch(input: { context: Plugin.Context; services: HiveServices; authority: HiveAuthority; background: V2BackgroundLifecycle; activity: NativeActivity }): Effect.Effect<void, never, Scope.Scope> {
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
  deps: { context: Plugin.Context; services: HiveServices; authority: HiveAuthority; background: V2BackgroundLifecycle; activity: NativeActivity; admissions: Admissions },
  native: Tool.Info['execute'],
  args: SubagentInput,
  toolContext: Tool.Context,
): Effect.Effect<Tool.Result, Tool.Error> {
  const { context, services, authority, background, activity, admissions } = deps;
  const parent: string = toolContext.sessionID;
  const call: string = toolContext.id;
  const target = authority.resolve(args.agent);
  // Built-in roles and custom agents; native `general`/`explore` and unmanaged agents keep the host's model behavior.
  const managed = target.kind === 'role';
  let admitted: string | undefined;
  let bound: string | undefined;
  let launchAlias: string | undefined;

  const refuse = (message: string) => Effect.fail(new ChildBindingRefused(message));
  const unsettled = (child: string, why: string, outcome: string) => `Child session ${child} has not settled (${why}). Hive does not send a follow-up to a child that still runs or has work pending, so it did not overwrite its binding and ${outcome}. Wait for its terminal <subagent> report before continuing it.`;

  /** The child must be the caller's native child; read from the host each time it is checked. */
  const confirmParent = (child: string, outcome: string) => context.session.get({ sessionID: child as never }).pipe(
    Effect.mapError(() => new ChildBindingRefused(`Hive could not read child session ${child} to confirm its parent; ${outcome}.`)),
    Effect.flatMap((session) => session.parentID === parent ? Effect.succeed(session) : refuse(`Child session ${child} is not a child of ${parent}; Hive did not bind it and ${outcome}.`)),
  );

  /**
   * A same-agent continuation keeps the child's session model, so it must already be the target's configured model.
   * The configured model is the host's effective agent entry for the actual target, where native user configuration
   * wins over Hive's defaults. A target without a configured model inherits natively and is not checked.
   */
  const confirmModel = (child: string, actual: Model.Ref | undefined) => context.agent.get({ agentID: args.agent as never }).pipe(
    Effect.mapError((error) => new ChildBindingRefused(`Hive could not read the configured model of agent ${args.agent} (${describe(error)}), so it cannot confirm that child session ${child} runs on it; ${NOT_CONTINUED}.`)),
    Effect.flatMap(({ data }) => {
      const expected = data.model;
      if (expected === undefined || (actual !== undefined && sameModel(expected, actual))) return Effect.void;
      return refuse(`Child session ${child} runs on ${actual === undefined ? 'no recorded model' : formatModel(actual)}, but agent ${args.agent} is configured for ${formatModel(expected)}; ${NOT_CONTINUED}. Start a new ${args.agent} subagent call without sessionID to run on the configured model.`);
    }),
  );

  /** The child's Hive binding, if it has one; a binding owned by another parent is never overwritten. */
  const ownBinding = (child: string, outcome: string) => Effect.try({
    try: () => services.sessionService.getGlobal(child),
    catch: (error) => new ChildBindingRefused(`Hive could not read the binding of child session ${child} (${describe(error)}); ${outcome}.`),
  }).pipe(Effect.flatMap((stored) => stored?.parentSessionId === undefined
    ? Effect.succeed(undefined)
    : stored.parentSessionId === parent
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

  /** Admits a continued child before the host runs, so a refused continuation leaves its agent and model untouched. */
  const preflight = (child: string) => Effect.gen(function* () {
    const session = yield* confirmParent(child, NOT_CONTINUED);
    yield* ownBinding(child, NOT_CONTINUED);
    // The host's session agent decides whether it switches the child; a binding that claims the target agent is not
    // enough when the host reports another one.
    if (managed && session.agent === args.agent) yield* confirmModel(child, session.model);
    yield* admit(child, NOT_CONTINUED);
    yield* requireSettled(child, NOT_CONTINUED);
  });

  return Effect.gen(function* () {
    if (managed && args.model !== undefined) {
      return yield* Effect.fail(new Tool.Error({ message: `Hive manages the model of agent ${args.agent}, so this subagent call may not set model (it set ${JSON.stringify(args.model)}); the host was not called. Repeat the call without model: the agent runs on its effective configured model and variant, or inherits its parent's model when it has none. The operator changes that model in native agent configuration or agent_hive.json.` }));
    }
    const captured = yield* Effect.try({
      try: () => services.captureRoute(parent),
      catch: (error) => new Tool.Error({ message: `Hive could not capture the dispatch route of session ${parent}: ${describe(error)}` }),
    });
    const snapshot = { ...captured, assignment: yield* Effect.promise(() => resolveAssignment(services, captured, args.prompt)) };
    const prompt = composeDispatchPrompt({
      sources: { projectRoot: services.projectRoot, taskService: services.taskService, contextService: services.contextService },
      snapshot,
      prompt: args.prompt,
      foragerDispatch: target.kind === 'role' && target.role === 'forager-worker',
    });
    const route = childRouteRecord(snapshot, parent, args.agent);
    // The board is the primary's: a call from a child session launches its helper without a row.
    const recordsLaunch = !(yield* authority.isChild(parent));

    if (args.sessionID !== undefined) {
      yield* preflight(args.sessionID).pipe(Effect.mapError((refusal) => new Tool.Error({ message: refusal.message })));
    }

    // The child's binding once bound; the board row takes its feature, task and run from it.
    let binding: SessionInfo | undefined;
    const bind = (child: string) => Effect.gen(function* () {
      yield* confirmParent(child, NOT_PROMPTED);
      const stored = yield* ownBinding(child, NOT_PROMPTED);
      if (admitted === undefined) yield* admit(child, NOT_PROMPTED);
      // A continuation is read again here, after any permission prompt the host awaited since the preflight.
      else yield* requireSettled(child, NOT_PROMPTED);
      // The association is observation written beside the route; it takes no part in admission or the preflight. A
      // child already bound to this route needs no write to run, so failing to record only its new association is
      // reported and does not stop it; its launch row is then scoped by what the binding read before the write proves.
      const association = childAssociation(snapshot);
      const write = () => services.sessionService.trackGlobal(child, { ...route, ...association });
      if (stored === undefined || !sameChildRoute(stored, route)) {
        binding = yield* Effect.try({
          try: write,
          catch: (error) => new ChildBindingRefused(`Hive could not bind child session ${child} to its dispatch route (${describe(error)}); ${NOT_PROMPTED}.`),
        });
      } else if (stored.taskFolder === association.taskFolder && stored.adHocRunId === association.adHocRunId) {
        binding = stored;
      } else {
        try {
          binding = write();
        } catch (error) {
          binding = provenChildBinding(stored, route, association);
          console.warn(`[hive:routing] Hive could not record the task or run association of child session ${child} (${describe(error)}); the child runs on its unchanged route. Before the write its stored binding named ${describeAssociation(stored)}; whether the failed write changed it is unknown, and Hive scopes this call's launch to neither that nor the new task or run.`);
        }
      }
      bound = child;
      background.launchBound(parent, child);
      if (recordsLaunch) launchAlias = background.recordLaunch(launchOf(child));
    });
    const launchOf = (child: string): BackgroundLaunch => ({
      parentSessionID: parent,
      callID: call,
      childSessionID: child,
      agent: args.agent,
      description: args.description,
      primaryAgent: toolContext.agent,
      ...boundChildScope(binding),
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
        if (bound === undefined || reported.sessionID !== bound) {
          const child = reported.sessionID === undefined ? 'no child session' : `child session ${reported.sessionID}`;
          const why = bound === undefined
            ? 'without the progress update at which Hive binds the child before its prompt'
            : `after Hive bound ${bound} at the progress update`;
          return Effect.fail(new Tool.Error({ message: `The subagent call returned ${child} ${why}. Hive did not bind it after it ran, so the child may have run without its parent's route and standing constraints${reported.sessionID === undefined ? '' : `; inspect hive_task_trace({ task_id: ${JSON.stringify(reported.sessionID)} }) before relying on its result`}.` }));
        }
        // The child runs on after the call returns; a launch whose row the barrier could not write is retried once.
        if (recordsLaunch && reported.status === 'running' && launchAlias === undefined) launchAlias = background.recordLaunch(launchOf(bound));
        return Effect.succeed(result);
      }),
      Effect.onExit((exit) => Effect.sync(() => {
        if (launchAlias === undefined || Exit.isSuccess(exit)) return;
        const how = Cause.hasInterruptsOnly(exit.cause) ? 'was interrupted' : 'failed';
        background.launchUncertain(launchAlias, `The background launch call ${how} after the child was bound; whether the child runs is unknown. Inspect hive_task_trace({ task_id: ${JSON.stringify(bound)} }) before acting.`);
      })),
    );
  }).pipe(Effect.ensuring(release));
}

function describeAssociation(binding: SessionInfo): string {
  return binding.taskFolder ? `task ${binding.taskFolder}` : binding.adHocRunId ? `run ${binding.adHocRunId}` : 'no task or run';
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

function reportedChild(result: Tool.Result): { sessionID?: string; status?: string } {
  const source = (result.output && typeof result.output === 'object' ? result.output : result.metadata) as Record<string, unknown> | undefined;
  return {
    sessionID: typeof source?.sessionID === 'string' ? source.sessionID : undefined,
    status: typeof source?.status === 'string' ? source.status : undefined,
  };
}
