import { Effect, Stream } from 'effect';
import type { Scope } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import type { BackgroundJobRecord, BackgroundJobService } from 'hive-core';
import { createBoardObserver, isLiveBackgroundJob } from '../background/backgroundJobAdapter.js';
import { createBackgroundOperations, type ObservationHealth, type RuntimeCancelResult } from '../background/operations.js';
import type { HiveToolRegistrar } from './tools.js';

/**
 * OpenCode v2 background observation. The host schedules, runs, interrupts and notifies background subagents; Hive
 * only keeps its observational board in the `opencode-v2` store, scoped by project, parent session and native call.
 *
 * The host's evidence stays distinct, and none of it records a launch's terminal outcome:
 * - acknowledgement: `hive_background_cancel` asked the host to interrupt the child (resume disabled) and the host
 *   accepted. The row keeps its cancel request; nothing is recorded as cancelled.
 * - settlement: the child's execution ended (`session.execution.*`).
 * - notification: the host's completion message to the parent (a synthetic inbox item whose metadata names the child
 *   and its state). It names the child but not the launching call, so with a reused child it cannot say which launch
 *   ended, and arrival order is no substitute for that identity.
 *   A notification therefore marks every live row of that child uncertain with the state the host reported, and
 *   settlement marks those still shown running; rows already terminal or archived are left as they were. The parent
 *   receives the notification itself.
 * - restart: rows from another host process or location are stale on the next board read.
 * - observation gap: Hive does not see a notification while no activation listens (a plugin reload) or after its
 *   event stream stops, and a failed board write loses what was observed. Rows live across a gap are uncertain; after
 *   the stream stops or a write fails, so is every later launch of the activation, and failed writes are retried.
 */

/**
 * The runtime epoch for board rows: this host process and the activation's location, not the plugin activation.
 * Native background jobs outlive a plugin reload in the same process, so a reload must not mark them stale; a new
 * process must. Each location's activation observes its own sessions' events, so the epoch also names the location.
 */
export function hostRuntimeId(location: string): string {
  return `opencode-v2:pid-${process.pid}-${Math.round(performance.timeOrigin).toString(36)}:${location}`;
}

/** One background launch, identified by its native parent, call and child. */
export type BackgroundLaunch = {
  parentSessionID: string;
  callID: string;
  childSessionID: string;
  agent: string;
  description?: string;
  primaryAgent?: string;
  feature?: string;
};

/** How many early completion notifications (seen before their launch row) are held; older ones are dropped. */
const EARLY_NOTIFICATION_LIMIT = 64;

export function createV2BackgroundLifecycle(input: { projectRoot: string; service: BackgroundJobService; runtimeId: string; warn?: (message: string) => void }) {
  const { projectRoot, service, runtimeId } = input;
  const warn = input.warn ?? ((message: string) => console.warn(message));
  const observer = createBoardObserver({ projectRoot, service, runtimeId, warn });
  // A child the user backgrounds from a foreground call can finish before its row exists. Its notification is held
  // by parent and child until that launch is recorded; it is never applied to any other parent or child.
  const early = new Map<string, string>();
  const earlyKey = (parent: string, child: string) => `${parent}\u0000${child}`;
  // Set once Hive can no longer trust that it sees every notification for this activation's launches.
  let degraded: string | undefined;
  // The live rows of this runtime still need marking uncertain for `degraded`; retried until a pass succeeds.
  let sweepPending = false;

  /** Marks live rows uncertain with what was observed. A failed write is an observation gap, never a silent success. */
  function markUncertain(aliases: string[], diagnostic: string): void {
    for (const alias of aliases) {
      try {
        service.updateRuntimeState(alias, 'unknown', { statusUncertain: true, lastStatusError: diagnostic });
      } catch (error) {
        observationLost(`Hive could not record an observation of ${alias} on the board (${describe(error)})`);
      }
    }
  }

  /** The live rows matching `select`, or undefined after the board could not be read, which is an observation gap. */
  function liveRows(select: (job: BackgroundJobRecord) => boolean, observing: string): BackgroundJobRecord[] | undefined {
    try {
      return service.listScoped({ projectRoot }).filter((job) => isLiveBackgroundJob(job) && select(job));
    } catch (error) {
      observationLost(`Hive could not read the board to record ${observing} (${describe(error)})`);
      return undefined;
    }
  }

  /**
   * Hive stopped seeing, or failed to record, host evidence for this activation's launches. Every live row of this
   * runtime is marked uncertain, now and on later board reads until that succeeds, and so is every later launch.
   */
  function observationLost(reason: string): void {
    warn(`[hive:background] ${reason}; live launches of this activation are now uncertain.`);
    degraded ??= reason;
    sweepPending = true;
    sweep();
  }

  function sweep(): void {
    if (!sweepPending || degraded === undefined) return;
    try {
      for (const job of service.listScoped({ projectRoot })) {
        if (job.runtimeId === runtimeId && isLiveBackgroundJob(job) && !job.statusUncertain) {
          service.updateRuntimeState(job.alias, 'unknown', { statusUncertain: true, lastStatusError: gapDiagnostic(degraded) });
        }
      }
      sweepPending = false;
    } catch (error) {
      warn(`[hive:background] could not mark live launches uncertain after an observation gap; retrying on the next board read: ${describe(error)}`);
    }
  }

  /** Retries pending uncertainty writes, then reports whether the board is fully observed. */
  function checkObservation(): ObservationHealth {
    sweep();
    return degraded === undefined ? { healthy: true } : { healthy: false, reason: degraded, uncertaintyPending: sweepPending };
  }

  function recordLaunch(launch: BackgroundLaunch): string | undefined {
    sweep();
    let alias: string;
    try {
      alias = service.registerLaunch({
        taskId: launch.childSessionID,
        sessionId: launch.childSessionID,
        callId: launch.callID,
        agentName: launch.agent,
        description: launch.description,
        runtimeId,
        scope: { projectRoot, parentSessionId: launch.parentSessionID, primaryAgent: launch.primaryAgent, feature: launch.feature },
      }).alias;
    } catch (error) {
      warn(`[hive:background] failed to record background launch ${launch.childSessionID}: ${describe(error)}`);
      return undefined;
    }
    const key = earlyKey(launch.parentSessionID, launch.childSessionID);
    const held = early.get(key);
    early.delete(key);
    if (held !== undefined) markUncertain([alias], held);
    else if (degraded !== undefined) markUncertain([alias], gapDiagnostic(degraded));
    return alias;
  }

  /**
   * A call has bound `child` to `parent` and the host has not prompted the child yet, so a completion held for that
   * pair predates the call. It belongs to an earlier launch whose row was never recorded.
   */
  function launchBound(parentSessionID: string, childSessionID: string): void {
    if (!early.delete(earlyKey(parentSessionID, childSessionID))) return;
    warn(`[hive:background] discarded a completion notification for child ${childSessionID} that predates the launch now bound to ${parentSessionID}; it belongs to an earlier launch with no board row.`);
  }

  /** The row is live but its outcome cannot be known from what was observed (a failed or interrupted launch call). */
  function launchUncertain(alias: string, reason: string): void {
    markUncertain([alias], reason);
  }

  /**
   * A new activation in this host process and location: an earlier activation's live launches may have finished
   * while nothing was listening, and the event stream does not replay their notifications.
   */
  function resumeObservation(): void {
    const rows = liveRows((job) => job.runtimeId === runtimeId && !job.statusUncertain, 'launches from before a plugin reload');
    if (rows) markUncertain(rows.map((job) => job.alias), 'Hive resumed observing host events after a plugin reload; a completion notification delivered while it was not observing is not replayed, so this child\'s outcome is unknown.');
  }

  /** The event stream ended or failed while the activation was live. */
  function observationStopped(reason: string): void {
    observationLost(`Hive stopped observing host events (${reason})`);
  }

  /**
   * The activation was closed (a reload or shutdown). A call it dispatched may still record a launch afterwards; no
   * one is listening for that launch on this activation, so it is uncertain. Existing rows are the next activation's.
   */
  function deactivate(): void {
    degraded ??= 'the plugin activation that recorded this launch had stopped observing host events';
  }

  function handleEvent(event: { type: string; data?: unknown }): void {
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : undefined;
    const sessionID = typeof data?.sessionID === 'string' ? data.sessionID : undefined;
    if (!data || !sessionID) return;
    switch (event.type) {
      case 'session.inbox.enqueued': {
        const completion = completionFrom(sessionID, data);
        if (!completion) return;
        const diagnostic = `The host notified the parent that child ${completion.child} ended (${completion.state}). The notification names the child, not the launching call, so Hive does not record it as this launch's outcome; inspect the child and archive this observation with decision "ignored".`;
        const rows = liveRows((job) => job.scope?.parentSessionId === completion.parent && job.sessionId === completion.child, `the completion notification for ${completion.child}`);
        if (rows === undefined) return;
        if (rows.length > 0) {
          markUncertain(rows.map((job) => job.alias), diagnostic);
          return;
        }
        const key = earlyKey(completion.parent, completion.child);
        early.delete(key);
        early.set(key, diagnostic);
        if (early.size > EARLY_NOTIFICATION_LIMIT) early.delete(early.keys().next().value!);
        return;
      }
      case 'session.execution.succeeded':
        // A parent that finished its turn has seen the board it was shown.
        observer.acknowledgePrompt(sessionID);
        settled(sessionID, 'Native execution settled (succeeded); the completion notification has not been observed yet.');
        return;
      case 'session.execution.failed': {
        const error = data.error && typeof data.error === 'object' ? data.error as { type?: unknown; message?: unknown } : undefined;
        const detail = typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : typeof error?.type === 'string' ? error.type : 'unknown error';
        settled(sessionID, `Native execution failed (${detail}); the completion notification has not been observed yet.`);
        return;
      }
      case 'session.execution.interrupted': {
        const reason = typeof data.reason === 'string' ? data.reason : 'unknown';
        settled(sessionID, reason === 'shutdown'
          ? 'Native execution was interrupted by host shutdown; the host may resume this child after it restarts. Inspect before acting.'
          : `Native execution was interrupted (${reason}) and settled; the completion notification has not been observed yet.`);
        return;
      }
    }
  }

  /**
   * Settlement only marks rows still shown running. After an interrupt the host publishes the notification first, so
   * a row already uncertain keeps the more specific observation it has.
   */
  function settled(child: string, diagnostic: string): void {
    const rows = liveRows((job) => job.sessionId === child && !job.statusUncertain, `the settlement of ${child}`);
    if (rows) markUncertain(rows.map((job) => job.alias), diagnostic);
  }

  return { observer, recordLaunch, launchBound, launchUncertain, resumeObservation, observationStopped, deactivate, checkObservation, handleEvent };
}

export type V2BackgroundLifecycle = ReturnType<typeof createV2BackgroundLifecycle>;

function gapDiagnostic(reason: string): string {
  return `${reason[0]!.toUpperCase()}${reason.slice(1)}; a completion notification for this child may not have been seen, so its outcome is unknown.`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A native subagent completion: a synthetic inbox item for the parent whose metadata the host writes as
 * `{ source: 'subagent', childID, state }`. Identity and state come only from that metadata; the text is never
 * parsed. A user message is never a completion.
 */
function completionFrom(parent: string, data: Record<string, unknown>): { parent: string; child: string; state: string } | undefined {
  const item = data.item && typeof data.item === 'object' ? data.item as { type?: unknown; payload?: unknown } : undefined;
  if (item?.type !== 'synthetic') return undefined;
  const payload = item.payload && typeof item.payload === 'object' ? item.payload as { metadata?: unknown } : undefined;
  const metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata as Record<string, unknown> : undefined;
  if (metadata?.source !== 'subagent' || typeof metadata.childID !== 'string') return undefined;
  const state = metadata.state;
  if (state !== 'completed' && state !== 'error' && state !== 'cancelled') return undefined;
  return { parent, child: metadata.childID, state };
}

/**
 * Registers the four board tools through the catalog's registrar (explicit `codemode: false`, the shared guard),
 * shows the board on the parent's ordinary requests, and observes host events for the activation's scope.
 */
export function registerBackground(input: { context: Plugin.Context; registrar: HiveToolRegistrar; projectRoot: string; service: BackgroundJobService; lifecycle: V2BackgroundLifecycle; runtimeId: string }): Effect.Effect<void, never, Scope.Scope> {
  const { context, registrar, projectRoot, service, lifecycle, runtimeId } = input;
  const cancelRuntimeTask = (sessionId: string): Promise<RuntimeCancelResult> => Effect.runPromise(
    context.session.interrupt({ sessionID: sessionId as never, resume: false }).pipe(
      Effect.map(({ interrupted }): RuntimeCancelResult => interrupted
        ? { cancelled: false, acknowledged: true, message: 'Interrupt acknowledged by the host with resume disabled. This does not prove the worker stopped.' }
        : { cancelled: false, acknowledged: false, message: 'The host interrupted no active execution for this session in this process (it was idle or not owned here); runtime cancellation is not confirmed.' }),
      Effect.catch((error: unknown) => Effect.succeed<RuntimeCancelResult>({ cancelled: false, message: `Interrupt request failed: ${describe(error)}` })),
    ),
  );
  return Effect.gen(function* () {
    yield* registrar.register(createBackgroundOperations({ backgroundJobService: service, projectRoot, isEnabled: () => true, currentRuntimeId: runtimeId, cancelRuntimeTask, checkObservation: lifecycle.checkObservation }));
    yield* Effect.sync(() => lifecycle.resumeObservation());
    yield* Effect.addFinalizer(() => Effect.sync(() => lifecycle.deactivate()));
    // Board bookkeeping never fails a model request or stops observation; a broken board store is reported.
    yield* context.session.hook('context', (event) => Effect.sync(() => {
      try {
        lifecycle.checkObservation();
        const board = lifecycle.observer.promptBoard(event.sessionID);
        if (!board) return;
        event.system.push({ type: 'text', text: board.text });
        board.notify();
      } catch (error) {
        console.warn(`[hive:background] could not show the board for ${event.sessionID}: ${describe(error)}`);
      }
    }));
    // Closing the activation interrupts this fiber, which is not a stop of observation; ending or failing while the
    // activation is live is.
    yield* context.event.subscribe().pipe(
      Stream.runForEach((event) => Effect.sync(() => {
        try {
          lifecycle.handleEvent(event as { type: string; data?: unknown });
        } catch (error) {
          console.warn(`[hive:background] could not observe ${event.type}: ${describe(error)}`);
        }
      })),
      Effect.andThen(Effect.sync(() => lifecycle.observationStopped('the host event stream ended'))),
      Effect.catch((error: unknown) => Effect.sync(() => lifecycle.observationStopped(`the host event stream failed: ${describe(error)}`))),
      Effect.forkScoped,
    );
  });
}
