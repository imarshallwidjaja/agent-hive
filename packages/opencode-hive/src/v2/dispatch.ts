import { Cause, Effect, Exit } from 'effect';
import type { Scope } from 'effect';
import { Tool } from '@opencode/schema/tool';
import type { Plugin } from '@opencode/plugin/effect';
import type { SessionInfo } from 'hive-core';
import type { HiveServices } from '../runtime/hive-services.js';
import { childRouteRecord, composeDispatchPrompt } from '../task-brief.js';
import type { BackgroundLaunch, V2BackgroundLifecycle } from './background.js';
import type { VerifiedReadAccess } from './client.js';
import type { HiveAuthority } from './registration.js';

/** The host's native subagent tool. */
export const NATIVE_SUBAGENT_TOOL = 'subagent';

/** The server's active sessions, read through the catalog's verified read access. */
export type NativeActivity = Pick<VerifiedReadAccess, 'sessionActive'>;

/** A refusal raised before the host continues a child, or inside the awaited progress barrier before it prompts one. */
class ChildBindingRefused {
  constructor(readonly message: string) {}
}

type SubagentInput = { agent: string; description?: string; prompt: string; sessionID?: string; background?: boolean };
type ChildRoute = ReturnType<typeof childRouteRecord>;

/**
 * Children reserved by an unfinished call of this activation, with the route that call binds. A continuation reserves
 * before any awaited activity read; a new child, which the host creates after the call starts, at its barrier. Admission
 * ends when the call returns. It keeps two local calls from binding one child to different routes; it does not queue
 * or schedule anything, and the host still decides when the child runs.
 */
type Admissions = Map<string, { route: ChildRoute; calls: Set<string> }>;

/**
 * Wraps the host's own subagent tool; the host still validates, schedules, runs, interrupts and notifies. The wrapper
 * adds what Hive owns at dispatch:
 *
 * - The parent's route and standing constraints, captured when the call starts, and the parent's authored prompt
 *   (before the host adds its subagent prefix) composed with the route footer and, for a Forager on a selected feature
 *   route, the task brief from its `Hive task:` line.
 * - For a continued `sessionID`, a preflight before the host runs, because the host switches a continued child's agent
 *   and model before it reports progress. The child must be a native child of the caller and not bound to another
 *   parent. Adopting an unbound child or changing its bound route, constraints or agent needs an idle child: a local
 *   reservation excludes conflicting calls while the host's active-session read qualifies idle. An unreadable answer
 *   is not idle. A continuation on the same proven binding needs no read.
 *   The `sessionID` itself is passed through unchanged.
 * - A barrier on the progress update the host awaits before it admits the child's prompt: Hive reads the child from
 *   the host again, requires that its parent is this call's session and that no other parent owns its binding, and
 *   binds the child to the captured route. If a step fails, the call fails and the child is never prompted.
 * - For a background launch, the board row, recorded at the barrier so a fast child cannot finish before its row
 *   exists. When the call then ends without returning normally, that row is marked uncertain. The board is never read
 *   to decide whether a dispatch may run.
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
  let admitted: string | undefined;
  let bound: string | undefined;
  let launchAlias: string | undefined;

  const refuse = (message: string) => Effect.fail(new ChildBindingRefused(message));
  const running = (child: string) => `Child session ${child} is running under another dispatch, and this continuation would change its route, constraints or agent; Hive did not overwrite its binding and ${NOT_CONTINUED}.`;

  /** The child must be the caller's native child; read from the host each time it is checked. */
  const confirmParent = (child: string, outcome: string) => context.session.get({ sessionID: child as never }).pipe(
    Effect.mapError(() => new ChildBindingRefused(`Hive could not read child session ${child} to confirm its parent; ${outcome}.`)),
    Effect.flatMap((session) => session.parentID === parent ? Effect.void : refuse(`Child session ${child} is not a child of ${parent}; Hive did not bind it and ${outcome}.`)),
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

  /** Another unfinished local call holds the child on a different route. */
  const heldElsewhere = (child: string, route: ChildRoute) => {
    const held = admissions.get(child);
    return held !== undefined && !sameRoute(held.route, route);
  };

  const admit = (child: string, route: ChildRoute) => {
    const held = admissions.get(child);
    if (held) held.calls.add(call);
    else admissions.set(child, { route, calls: new Set([call]) });
    admitted = child;
  };

  const release = Effect.sync(() => {
    if (admitted === undefined) return;
    const held = admissions.get(admitted);
    held?.calls.delete(call);
    if (held?.calls.size === 0) admissions.delete(admitted);
  });

  /** Whether the host reports the child idle. Any failure to read that is reported as unknown, never as idle. */
  const hostActivity = (child: string) => Effect.tryPromise({ try: () => activity.sessionActive(), catch: (error) => error }).pipe(
    Effect.map((active): { idle: boolean; unknown?: string } => ({ idle: !Object.hasOwn(active, child) })),
    Effect.catch((error: unknown) => Effect.succeed({ idle: false, unknown: describe(error) })),
  );

  /** Admits a continued child before the host runs, so a refused continuation leaves its agent and model untouched. */
  const preflight = (child: string, route: ChildRoute) => Effect.gen(function* () {
    yield* confirmParent(child, NOT_CONTINUED);
    const stored = yield* ownBinding(child, NOT_CONTINUED);
    if (heldElsewhere(child, route)) return yield* refuse(running(child));
    admit(child, route);
    if (stored === undefined || !sameRoute(stored, route)) {
      const state = yield* hostActivity(child);
      if (state.unknown !== undefined) {
        return yield* refuse(`Hive could not confirm that child session ${child} is idle (${state.unknown}). Adopting an unbound child or changing its route, constraints or agent needs an idle child, so Hive did not overwrite its binding and ${NOT_CONTINUED}.`);
      }
      if (!state.idle) return yield* refuse(running(child));
    }
  });

  return Effect.gen(function* () {
    const snapshot = yield* Effect.try({
      try: () => services.captureRoute(parent),
      catch: (error) => new Tool.Error({ message: `Hive could not capture the dispatch route of session ${parent}: ${describe(error)}` }),
    });
    const target = authority.resolve(args.agent);
    const prompt = composeDispatchPrompt({
      sources: { projectRoot: services.projectRoot, taskService: services.taskService, contextService: services.contextService },
      snapshot,
      prompt: args.prompt,
      foragerDispatch: target.kind === 'role' && target.role === 'forager-worker',
    });
    const feature = snapshot.hasFeatureRoute && typeof snapshot.featureName === 'string' ? snapshot.featureName : undefined;
    const route = childRouteRecord(snapshot, parent, args.agent);

    if (args.sessionID !== undefined) {
      yield* preflight(args.sessionID, route).pipe(Effect.mapError((refusal) => new Tool.Error({ message: refusal.message })));
    }

    const bind = (child: string) => Effect.gen(function* () {
      yield* confirmParent(child, NOT_PROMPTED);
      const stored = yield* ownBinding(child, NOT_PROMPTED);
      if (admitted === undefined) {
        if (heldElsewhere(child, route)) return yield* refuse(`Child session ${child} is already admitted to another dispatch with a different route; Hive did not bind it and ${NOT_PROMPTED}.`);
        admit(child, route);
      }
      if (stored === undefined || !sameRoute(stored, route)) {
        yield* Effect.try({
          try: () => services.sessionService.trackGlobal(child, route),
          catch: (error) => new ChildBindingRefused(`Hive could not bind child session ${child} to its dispatch route (${describe(error)}); ${NOT_PROMPTED}.`),
        });
      }
      bound = child;
      background.launchBound(parent, child);
      if (args.background === true) launchAlias = background.recordLaunch(launchOf(child));
    });
    const launchOf = (child: string): BackgroundLaunch => ({
      parentSessionID: parent,
      callID: call,
      childSessionID: child,
      agent: args.agent,
      description: args.description,
      primaryAgent: toolContext.agent,
      feature,
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
      Effect.tap((result) => Effect.sync(() => {
        const reported = reportedChild(result);
        // A foreground call the user moved to the background returns `running` without a background launch.
        if (reported.status === 'running' && launchAlias === undefined && reported.sessionID !== undefined && reported.sessionID === bound) {
          launchAlias = background.recordLaunch(launchOf(bound));
        }
      })),
      Effect.onExit((exit) => Effect.sync(() => {
        if (launchAlias === undefined || Exit.isSuccess(exit)) return;
        const how = Cause.hasInterruptsOnly(exit.cause) ? 'was interrupted' : 'failed';
        background.launchUncertain(launchAlias, `The background launch call ${how} after the child was bound; whether the child runs is unknown. Inspect hive_task_trace({ task_id: ${JSON.stringify(bound)} }) before acting.`);
      })),
    );
  }).pipe(Effect.ensuring(release));
}

/** Whether the stored child binding already carries every field of the route a new call captured. */
function sameRoute(stored: SessionInfo | ChildRoute, route: ChildRoute): boolean {
  return (Object.keys(route) as Array<keyof ChildRoute>).every((key) => JSON.stringify(stored[key]) === JSON.stringify(route[key]));
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
