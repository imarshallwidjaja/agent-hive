import { Effect } from 'effect';
import type { Scope } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import type { SessionInfo } from 'hive-core';
import type { HiveInvocation, HiveServices } from '../runtime/hive-services.js';
import { z } from '../runtime/schema.js';
import { ReadAccessError, type ChildSettlement, type ParentActivity, type VerifiedTreeReadAccess } from './client.js';
import type { HiveToolRegistrar } from './tools.js';

/**
 * OpenCode v2 live child inspection and cancellation. The host schedules, runs, interrupts and notifies background
 * subagents, and reports each child's result to its parent; Hive keeps no record of launches. Both tools read the
 * caller's direct children in this location when they are called: the in-process session list says who the children
 * are and Hive's own bindings say which feature, task or run each serves, while the verified read client says whether
 * any work still runs under them. Every answer is a sample at the time of the call.
 */

/** The live reads the tools need; `createVerifiedReadAccess` provides them. */
export type BackgroundReadAccess = Pick<VerifiedTreeReadAccess, 'childSettlement' | 'parentActivity'>;

/** Children read per in-process session list page. */
const CHILD_PAGE = 200;
/** A parent with more children than this many pages is refused rather than read without end. */
const MAX_CHILD_PAGES = 50;

const NOT_STOPPED = 'Interrupting a session stops only its active model execution: shell commands and descendant jobs it already moved to the background keep running and can wake it again when they finish. An error or cancellation report ends only that execution, not those commands and jobs, so confirm that the child\'s tree has settled before you start an overlapping writer.';

type ChildScope = { feature?: string; task?: string; adHocRunId?: string };
type ChildView = { sessionID: string; agent?: string; outcome?: string; scope: ChildScope };

type SessionRecord = { id: string; parentID?: string; agent?: string; outcome?: string; location?: { directory?: string } };

export function registerBackground(input: { context: Plugin.Context; registrar: HiveToolRegistrar; services: Pick<HiveServices, 'sessionService'>; readAccess: BackgroundReadAccess }): Effect.Effect<void, never, Scope.Scope> {
  const { context, registrar, services, readAccess } = input;
  const directory = context.location.directory;

  const caller = (invocation: HiveInvocation): string => {
    if (!invocation.sessionID) throw new Error('This tool reads the calling session\'s children, and the host reported no calling session.');
    return invocation.sessionID;
  };

  const run = <A, E>(effect: Effect.Effect<A, E>, signal: AbortSignal | undefined) => Effect.runPromise(effect, signal ? { signal } : undefined);

  /**
   * The calling session's direct children in this location, each once. Pages run oldest update first and the host
   * always returns a next cursor for a nonempty page, so a child updated while the pages are read reappears on a later
   * page: the latest record of each child is kept, and a short page ends the list.
   */
  const listChildren = async (parentID: string, signal: AbortSignal | undefined): Promise<SessionRecord[]> => {
    const children = new Map<string, SessionRecord>();
    let cursor: unknown;
    for (let page = 0; page < MAX_CHILD_PAGES; page++) {
      const result = await run(context.session.list((cursor === undefined
        ? { parentID, order: 'asc', limit: CHILD_PAGE }
        : { cursor, limit: CHILD_PAGE }) as never), signal) as { data: ReadonlyArray<SessionRecord>; cursor?: { next?: unknown } };
      for (const child of result.data) {
        if (child.parentID === parentID && child.location?.directory === directory) children.set(child.id, child);
      }
      cursor = result.cursor?.next ?? undefined;
      if (cursor === undefined || result.data.length < CHILD_PAGE) return [...children.values()];
    }
    throw new Error(`Session ${parentID} has more than ${MAX_CHILD_PAGES * CHILD_PAGE} children; Hive did not list them all.`);
  };

  /** Hive's binding of each child, or none when the binding index cannot be read (reported once). */
  const bindings = () => {
    let unreadable: string | undefined;
    const read = (sessionID: string): SessionInfo | undefined => {
      if (unreadable !== undefined) return undefined;
      try {
        return services.sessionService.peekGlobal(sessionID);
      } catch (error) {
        unreadable = describe(error);
        return undefined;
      }
    };
    return { read, warning: () => unreadable === undefined ? undefined : `Hive could not read its child bindings (${unreadable}); feature, task and run scope are missing.` };
  };

  const view = (child: SessionRecord, stored: SessionInfo | undefined): ChildView => ({
    sessionID: child.id,
    ...(child.agent === undefined ? {} : { agent: child.agent }),
    ...(child.outcome === undefined ? {} : { outcome: child.outcome }),
    scope: {
      ...(stored?.featureName ? { feature: stored.featureName } : {}),
      ...(stored?.taskFolder ? { task: stored.taskFolder } : {}),
      ...(stored?.adHocRunId ? { adHocRunId: stored.adHocRunId } : {}),
    },
  });

  const matches = (child: ChildView, filter: ChildScope) => (filter.feature === undefined || child.scope.feature === filter.feature)
    && (filter.task === undefined || child.scope.task === filter.task)
    && (filter.adHocRunId === undefined || child.scope.adHocRunId === filter.adHocRunId);

  /** Why a live read failed, for a result that still reports what the in-process reads found. A cancellation is rethrown. */
  const unavailable = (error: unknown, signal: AbortSignal | undefined) => {
    if (signal?.aborted) throw error;
    return { available: false, readAccess: error instanceof ReadAccessError ? error.code : 'read_failed', message: describe(error) };
  };

  /** The child's settlement, or why it could not be read. */
  const settlementOf = async (parentID: string, childID: string, signal: AbortSignal | undefined) => {
    let state: ChildSettlement;
    try {
      state = await readAccess.childSettlement({ parentID, childID }, signal);
    } catch (error) {
      return { settlement: unavailable(error, signal) };
    }
    return { ...('signal' in state ? { settled: false, signal: state.signal, detail: state.detail } : { settled: true }), settlement: { available: true } };
  };

  /** The caller's direct child in this location, read in-process, or a refusal. */
  const directChild = async (callerID: string, sessionID: string, signal: AbortSignal | undefined): Promise<SessionRecord | { success: false; reason: 'not_a_child'; error: string }> => {
    const target = sessionID === callerID ? undefined : await run(context.session.get({ sessionID: sessionID as never }).pipe(
      Effect.map((session) => session as unknown as SessionRecord),
      Effect.orElseSucceed(() => undefined),
    ), signal);
    if (target?.parentID === callerID && target.location?.directory === directory) return target;
    return { success: false, reason: 'not_a_child', error: `Session ${sessionID} is not a direct child of calling session ${callerID} in ${directory}; Hive reads and stops only the caller's own children.` };
  };

  return registrar.register({
    hive_background_status: {
      description: 'Inspect the calling session\'s direct subagent children live. Without sessionID it lists the children that still have work running (a job of the child or its descendants, or an active execution); includeSettled also lists the rest. With sessionID it reads whether that child\'s whole session tree has settled: no job, no queued inbox input and no active execution under it. Feature, task and run filters match the binding Hive wrote when it dispatched the child; with sessionID, a child whose binding does not match them returns reason scope_mismatch. Each answer is a sample at the time of the call; when the live reads are unavailable, the children are still listed and the result says what could not be checked. Call it when a child\'s liveness is uncertain, for example after an interrupted run, a timeout or a restart.',
      args: {
        sessionID: z.string().optional().describe('One direct child to read in full. Omitted, every direct child of the calling session in this location is considered.'),
        feature: z.string().optional().describe('Only children Hive bound to this feature.'),
        task: z.string().optional().describe('Only children Hive bound to this task folder.'),
        adHocRunId: z.string().optional().describe('Only children Hive bound to this ad-hoc run.'),
        includeSettled: z.boolean().optional().describe('Without sessionID, also list the children with no observed work.'),
      },
      output: 'json',
      execute: async (args: { sessionID?: string } & ChildScope & { includeSettled?: boolean }, invocation) => {
        const callerID = caller(invocation);
        const { signal } = invocation;
        const stored = bindings();
        if (args.sessionID !== undefined) {
          const child = await directChild(callerID, args.sessionID, signal);
          if ('success' in child) return child;
          const childView = view(child, stored.read(child.id));
          const warning = stored.warning();
          if (!matches(childView, args)) {
            return { success: false, reason: 'scope_mismatch', error: `Child session ${childView.sessionID} is not bound to the requested feature, task or run (its binding names ${JSON.stringify(childView.scope)}); its settlement was not read.`, ...(warning ? { warning } : {}) };
          }
          return { success: true, ...childView, ...(await settlementOf(callerID, childView.sessionID, signal)), ...(warning ? { warning } : {}) };
        }
        const children = (await listChildren(callerID, signal)).map((child) => view(child, stored.read(child.id))).filter((child) => matches(child, args));
        const warnings = [stored.warning()].filter((text): text is string => text !== undefined);
        let activity: ParentActivity;
        try {
          activity = await readAccess.parentActivity({ parentID: callerID }, signal);
        } catch (error) {
          return {
            success: true,
            observation: unavailable(error, signal),
            children,
            warnings: [...warnings, 'Live jobs, inboxes and executions could not be checked, so these children are listed without knowing whether any of them still works. Do not treat a child as settled from this result.'],
          };
        }
        const live = new Map(activity.children.map((entry) => [entry.sessionID, entry]));
        const working = children.flatMap((child) => {
          const entry = live.get(child.sessionID);
          return entry ? [{ ...child, jobs: entry.jobs, activeExecution: entry.activeExecution }] : [];
        });
        return {
          success: true,
          coverage: 'jobs_and_executions',
          working,
          ...(args.includeSettled === true ? { children: children.filter((child) => !live.has(child.sessionID)) } : {}),
          note: 'Queued inbox input is not read in this list; pass sessionID to read one child\'s whole tree, inboxes included.',
          ...(warnings.length ? { warnings } : {}),
        };
      },
    },
    hive_background_cancel: {
      description: `Interrupt one direct subagent child of the calling session in this location, with resume disabled. ${NOT_STOPPED} When the host had no active execution to interrupt, the result also reads whether the child's tree has settled.`,
      args: {
        sessionID: z.string().min(1).describe('The direct child session to interrupt.'),
        reason: z.string().optional().describe('Why the child is stopped, for the record of this call.'),
      },
      output: 'json',
      execute: async (args: { sessionID: string; reason?: string }, invocation) => {
        const callerID = caller(invocation);
        const { signal } = invocation;
        const child = await directChild(callerID, args.sessionID, signal);
        if ('success' in child) return child;
        const { interrupted } = await run(context.session.interrupt({ sessionID: child.id as never, resume: false }), signal);
        // An idle child may still have background work; whether it settled changes what the caller does next.
        const settlement = interrupted ? {} : await settlementOf(callerID, child.id, signal);
        return {
          success: true,
          sessionID: child.id,
          interrupted,
          ...settlement,
          message: `${interrupted ? 'The host interrupted the child\'s active execution.' : 'The child had no active execution to interrupt.'} ${NOT_STOPPED}`,
        };
      },
    },
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
