import type {
  BackgroundJobRecord,
  BackgroundJobRuntimeState,
  BackgroundJobService,
  SessionInfo,
} from 'hive-core';
import { BackgroundBoardReadError, isBackgroundJobArchived } from 'hive-core';
import {
  parseTaskCompletionNotification,
  parseTaskLifecycleEvent,
  type ParsedTaskLifecycleEvent,
  type TaskLifecycleContext,
} from './taskOutput.js';

export interface ReplayTextPart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type: string;
  text?: string;
  synthetic?: boolean;
}

export interface ReplayMessageEntry {
  info: {
    id?: string;
    sessionID?: string;
    role?: string;
    time?: { created?: number };
  };
  parts: ReplayTextPart[];
}

export interface BackgroundJobAdapterOptions {
  projectRoot: string;
  service: BackgroundJobService;
  isEnabled: () => boolean;
  runtimeId?: string;
  getSession?: (sessionId: string) => SessionInfo | undefined;
  /** The child binding the launching call itself confirmed; it names the launch row's feature, task and run. */
  getBoundChild?: (launch: { childSessionId: string; parentSessionId: string; callId?: string }) => SessionInfo | undefined;
  parseLifecycleEvent?: (input: unknown, output: unknown, context?: TaskLifecycleContext) => ParsedTaskLifecycleEvent | undefined;
  warn?: (message: string) => void;
}

/**
 * A v1 child session's lifecycle. `idle` is not stop evidence: it leaves a live row uncertain until the native
 * completion notification arrives. `error` is v1's terminal session error.
 */
export type SessionLifecycleObservation =
  | { kind: 'idle'; sessionId: string }
  | { kind: 'error'; sessionId: string; runtimeState: 'error' | 'cancelled'; diagnostic: string };

/** A v1 native completion notification for one child, decoded from its synthetic message. */
export type NativeCompletionObservation = {
  /** Identifies this notification so a replayed delivery is applied once. */
  key: string;
  parentSessionId: string;
  childId: string;
  callId?: string;
  runtimeState: 'completed' | 'error' | 'cancelled';
  result?: string;
  error?: string;
  timedOut?: boolean;
};

/** A background launch the host accepted whose board write failed, so its row is unconfirmed: absent, or written before the failure. */
export type UnrecordedLaunch = {
  parentSessionId: string;
  callId?: string;
  childSessionId: string;
  agentName: string;
  reason: string;
  failedAt: string;
};

/** An unrecorded launch as its parent's board status reports it: `promptAcknowledged` once a completed turn saw it. */
export type ReportedUnrecordedLaunch = UnrecordedLaunch & { promptAcknowledged: boolean };

export interface BoardObserverOptions {
  projectRoot: string;
  service: BackgroundJobService;
  runtimeId?: string;
  warn: (message: string) => void;
}

/**
 * The feature, task and run a launch row names: those of the child binding its launching call wrote from the route it
 * captured, or, when that write failed, what the stored binding proves (`provenChildBinding`). A child without such a
 * binding names none; the parent's route at some later moment is never used.
 */
export function boundChildScope(child: SessionInfo | undefined): { feature?: string; task?: string; adHocRunId?: string } {
  return {
    ...(typeof child?.featureName === 'string' ? { feature: child.featureName } : {}),
    ...(child?.taskFolder ? { task: child.taskFolder } : {}),
    ...(child?.adHocRunId ? { adHocRunId: child.adHocRunId } : {}),
  };
}

export function classifyRuntimeEpochStaleJobs(input: {
  service: BackgroundJobService;
  projectRoot: string;
  currentRuntimeId?: string;
  isVisible?: (job: BackgroundJobRecord) => boolean;
}): void {
  if (!input.currentRuntimeId) {
    return;
  }

  const candidates = input.service
    .listScoped({ projectRoot: input.projectRoot })
    .filter(job => input.isVisible ? input.isVisible(job) : true);

  for (const job of candidates) {
    const isActive = job.runtimeState === 'running' || job.runtimeState === 'unknown';
    const isForeignRuntime = job.runtimeId !== input.currentRuntimeId;
    if (!isActive || !isForeignRuntime || job.staleAt) {
      continue;
    }

    input.service.markRuntimeEpochStale(
      job.alias,
      input.currentRuntimeId,
      `Background worker runtime identity changed. Job was registered by runtime '${job.runtimeId || '(unknown)'}' but current runtime is '${input.currentRuntimeId}'.`,
    );
  }
}

/**
 * Board observation. Both hosts use the parent's prompt board and its acknowledgement. Completion and session
 * lifecycle matching serve v1, whose notifications can carry the launching call: every match is scoped to this project
 * and the notification's parent, and a child identity with more than one board row (a reused native child) is marked
 * uncertain rather than guessed.
 *
 * A launch whose board write failed may have no row, so the board alone would look complete; a failure such as
 * releasing the lock can also follow a completed write, so the row may exist. The observer keeps each such launch by
 * parent and call until the same call records it, shows it to that parent only, and holds every one for the life of
 * the process: none is dropped to bound memory, because a dropped entry is exactly the silent gap.
 */
export function createBoardObserver(options: BoardObserverOptions) {
  const { warn } = options;
  const observedCompletionNotifications = new Set<string>();
  // `shown` means a prompt carried the entry; `acknowledged` means the parent then finished a turn.
  const unrecorded = new Map<string, { launch: UnrecordedLaunch; prompt: 'pending' | 'shown' | 'acknowledged' }>();
  const launchKey = (parentSessionId: string, callId: string | undefined, childSessionId: string) =>
    JSON.stringify([parentSessionId, callId ?? `child:${childSessionId}`]);

  function launchNotRecorded(launch: Omit<UnrecordedLaunch, 'reason' | 'failedAt'>, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    warn(`[hive:background] could not confirm background launch ${launch.childSessionId} was recorded: ${reason}`);
    unrecorded.set(launchKey(launch.parentSessionId, launch.callId, launch.childSessionId), {
      launch: { ...launch, reason, failedAt: new Date().toISOString() },
      prompt: 'pending',
    });
  }

  function launchRecorded(parentSessionId: string, callId: string | undefined, childSessionId: string): void {
    unrecorded.delete(launchKey(parentSessionId, callId, childSessionId));
  }

  function unrecordedLaunches(parentSessionId: string): ReportedUnrecordedLaunch[] {
    return [...unrecorded.values()]
      .filter(entry => entry.launch.parentSessionId === parentSessionId)
      .map(entry => ({ ...entry.launch, promptAcknowledged: entry.prompt === 'acknowledged' }));
  }

  function findNativeJobs(taskId: string, parentSessionId: string, callId?: string): BackgroundJobRecord[] {
    return options.service
      .listScoped({ projectRoot: options.projectRoot, parentSessionId }, { includeArchived: true })
      .filter(job => job.taskId === taskId || job.sessionId === taskId)
      .filter(job => callId === undefined || job.callId === callId);
  }

  function markAmbiguousObservation(jobs: BackgroundJobRecord[], taskId: string, source: string): boolean {
    const aliases = jobs.map(job => job.alias).join(', ');
    const diagnostic = `Ambiguous ${source} for reused native child '${taskId}'. Preserved prior terminal outcomes; inspect hive_task_trace({ task_id: ${JSON.stringify(taskId)} }) and use an exact board alias (${aliases}).`;
    let succeeded = true;
    for (const job of jobs) {
      if (isLiveBackgroundJob(job)) {
        try {
          options.service.updateRuntimeState(job.alias, 'unknown', {
            statusUncertain: true,
            lastStatusError: diagnostic,
          });
        } catch (error) {
          succeeded = false;
          warn(`[hive:background] failed to mark ambiguous background task ${job.alias}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    warn(`[hive:background] ${diagnostic}`);
    return succeeded;
  }

  /** Applies one v1 completion notification to the single board row it matches, or marks a reused child ambiguous. */
  function observeCompletion(observation: NativeCompletionObservation): void {
    if (observedCompletionNotifications.has(observation.key)) return;
    let jobs: BackgroundJobRecord[];
    try {
      jobs = findNativeJobs(observation.childId, observation.parentSessionId, observation.callId);
    } catch (error) {
      // An unreadable board leaves the notification unconsumed, so a later request applies it once the board reads.
      if (!(error instanceof BackgroundBoardReadError)) throw error;
      warn(`[hive:background] ${error.message}; completion notification for ${observation.childId} is left for a later request.`);
      return;
    }
    if (jobs.length === 0) return;
    if (jobs.length > 1) {
      if (markAmbiguousObservation(jobs, observation.childId, 'native completion notification')) {
        observedCompletionNotifications.add(observation.key);
      }
      return;
    }
    try {
      options.service.markTerminal(jobs[0]!.alias, observation.runtimeState, {
        resultSummary: observation.result,
        lastStatusError: observation.error,
        statusUncertain: observation.timedOut ?? false,
      });
      observedCompletionNotifications.add(observation.key);
    } catch (error) {
      warn(`[hive:background] failed to update background task ${observation.childId} from completion notification: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function observeSessionLifecycle(observation: SessionLifecycleObservation): void {
    try {
      const history = options.service
        .listScoped({ projectRoot: options.projectRoot }, { includeArchived: true })
        .filter(job => job.sessionId === observation.sessionId);
      const currentJobs = history.filter(isLiveBackgroundJob);
      if (currentJobs.length === 0) return;
      if (history.length > 1) {
        markAmbiguousObservation(history, observation.sessionId, `session ${observation.kind} event`);
        return;
      }

      const job = currentJobs[0]!;
      if (observation.kind === 'idle') {
        options.service.updateRuntimeState(job.alias, 'unknown', { statusUncertain: true });
      } else {
        options.service.markTerminal(job.alias, observation.runtimeState, {
          statusUncertain: false,
          lastStatusError: observation.diagnostic,
        });
      }
    } catch (error) {
      warn(`[hive:background] failed to observe session ${observation.kind} for ${observation.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The parent session finished a turn successfully, so it has processed the board it was shown. The host adapter
   * calls this only for a completed turn; a turn that failed after the board was shown leaves it unacknowledged.
   */
  function acknowledgePrompt(parentSessionId: string): void {
    for (const entry of unrecorded.values()) {
      if (entry.launch.parentSessionId === parentSessionId && entry.prompt === 'shown') entry.prompt = 'acknowledged';
    }
    try {
      options.service.markPromptAcknowledgedForSession(parentSessionId);
    } catch (error) {
      warn(`[hive:background] failed to acknowledge parent prompt for ${parentSessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The board a parent session's next model request shows, or undefined when nothing needs showing. Rows from an
   * earlier runtime epoch are classified stale first. Showing the board records the prompt notification; a terminal
   * row or unrecorded launch is shown again until the parent acknowledges it.
   *
   * The parent's unrecorded launches are held in memory, so an unreadable board does not hide them: the board then
   * shows them with the read failure instead of rows. Without such a launch the read failure is thrown as before,
   * since there is nothing of this parent's to show in place of rows that are unknown, not absent.
   */
  function promptBoard(sessionID: string): { text: string; notify: () => void } | undefined {
    const gaps = [...unrecorded.values()].filter(entry => entry.launch.parentSessionId === sessionID && entry.prompt !== 'acknowledged');
    let jobs: BackgroundJobRecord[] = [];
    let boardReadError: string | undefined;
    try {
      classifyRuntimeEpochStaleJobs({
        service: options.service,
        projectRoot: options.projectRoot,
        currentRuntimeId: options.runtimeId,
        isVisible: job => isJobVisibleInPrompt(job, options.projectRoot, sessionID),
      });
      jobs = options.service
        .listScoped({ projectRoot: options.projectRoot })
        .filter(job => isJobVisibleInPrompt(job, options.projectRoot, sessionID))
        .filter(job => shouldShowJobInPrompt(job, sessionID));
    } catch (error) {
      if (!(error instanceof BackgroundBoardReadError) || gaps.length === 0) throw error;
      warn(`[hive:background] ${error.message}; showing ${sessionID} its unrecorded launches without board rows.`);
      boardReadError = error.message;
    }
    if (jobs.length === 0 && gaps.length === 0) return undefined;
    return {
      text: formatPromptBoard(jobs, gaps.map(entry => entry.launch), boardReadError),
      notify: () => {
        for (const entry of gaps) entry.prompt = 'shown';
        options.service.markPromptNotified(jobs.map(job => job.taskId), sessionID);
      },
    };
  }

  return { findNativeJobs, markAmbiguousObservation, observeCompletion, observeSessionLifecycle, acknowledgePrompt, promptBoard, launchNotRecorded, launchRecorded, unrecordedLaunches };
}

export type BoardObserver = ReturnType<typeof createBoardObserver>;

/** V1 board adapter: decodes v1 tool output, synthetic XML notifications and session events into the shared observer. */
export function createBackgroundJobAdapter(options: BackgroundJobAdapterOptions) {
  const lifecycleContextByCall = new Map<string, TaskLifecycleContext>();
  // Sessions whose turn reported an error since the board was last shown to them. v1 publishes `session.error` and
  // then reports idle twice (`session.status` idle, then `session.idle`), so no idle after a failure means the parent
  // processed the board. The failure stands until a new request shows the board again.
  const failedTurns = new Set<string>();
  const parseLifecycleEvent = options.parseLifecycleEvent ?? parseTaskLifecycleEvent;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const observer = createBoardObserver({ projectRoot: options.projectRoot, service: options.service, runtimeId: options.runtimeId, warn });
  const { findNativeJobs, markAmbiguousObservation, observeSessionLifecycle } = observer;

  const adapter = {
    'tool.execute.before': async (input: { tool?: string; sessionID?: string; callID?: string }, output: { args?: Record<string, unknown> }): Promise<void> => {
      if (!options.isEnabled()) {
        return;
      }

      if ((input.tool === 'task' || input.tool === 'task_status') && input.sessionID && input.callID && output.args && typeof output.args === 'object') {
        const stagedArgs = { ...output.args };
        if (input.tool === 'task' && stagedArgs.background === undefined) stagedArgs.background = false;
        const key = toolCallKey(input.sessionID, input.callID);
        const session = options.getSession?.(input.sessionID);
        lifecycleContextByCall.set(key, {
          args: stagedArgs,
          agentName: typeof session?.agent === 'string' ? session.agent : undefined,
        });
      }
    },

    'tool.execute.after': async (input: unknown, output: unknown): Promise<void> => {
      if (!options.isEnabled()) {
        clearLifecycleContext(input);
        return;
      }

      try {
        const event = parseLifecycleEvent(input, output, resolveLifecycleContext(input));
        if (event) {
          await handleLifecycleEvent(event, output);
        }
      } finally {
        clearLifecycleContext(input);
      }
    },

    'experimental.chat.messages.transform': async (input: unknown, output: { messages?: ReplayMessageEntry[] }): Promise<void> => {
      if (!options.isEnabled() || !Array.isArray(output.messages) || output.messages.length === 0) {
        return;
      }

      observeCompletionNotifications(output.messages);

      const targetMessage = findTargetUserMessage(output.messages);
      const sessionID = targetMessage?.info.sessionID;
      if (!targetMessage || !sessionID) {
        return;
      }

      const board = observer.promptBoard(sessionID);
      if (!board) {
        return;
      }
      if (targetMessage.parts.some(part => part.text?.includes('## Background Job Board'))) {
        return;
      }

      const now = Date.now();
      const messageID = targetMessage.info.id ?? `msg_background_board_${sessionID}`;
      targetMessage.parts.push({
        id: `prt_background_board_${sessionID}_${now}`,
        sessionID,
        messageID,
        type: 'text',
        text: `\n\n${board.text}`,
        synthetic: true,
      });
      board.notify();
      // This request carries the board again, so an earlier failure no longer decides the turn's acknowledgement.
      failedTurns.delete(sessionID);
    },

    event: async (input: unknown): Promise<void> => {
      if (!options.isEnabled()) {
        return;
      }

      const observation = extractSessionLifecycleObservation(input);
      if (!observation) {
        return;
      }
      if (observation.kind === 'error') {
        failedTurns.add(observation.sessionId);
      } else if (!failedTurns.has(observation.sessionId)) {
        observer.acknowledgePrompt(observation.sessionId);
      }
      observeSessionLifecycle(observation);
    },

    /** This process's launches of `parentSessionId` that the board could not record. */
    unrecordedLaunches: observer.unrecordedLaunches,
  };

  function resolveLifecycleContext(input: unknown): TaskLifecycleContext | undefined {
    if (!input || typeof input !== 'object') {
      return undefined;
    }

    const record = input as { tool?: string; sessionID?: string; callID?: string; args?: Record<string, unknown> };
    const key = record.sessionID && record.callID ? toolCallKey(record.sessionID, record.callID) : undefined;
    const staged = key ? lifecycleContextByCall.get(key) : undefined;
    return {
      args: staged?.args ?? record.args,
      agentName: staged?.agentName,
    };
  }

  function clearLifecycleContext(input: unknown): void {
    if (!input || typeof input !== 'object') {
      return;
    }

    const record = input as { sessionID?: string; callID?: string };
    if (!record.sessionID || !record.callID) {
      return;
    }

    const key = toolCallKey(record.sessionID, record.callID);
    lifecycleContextByCall.delete(key);
  }

  async function handleLifecycleEvent(event: ParsedTaskLifecycleEvent, output: unknown): Promise<void> {
    if (event.tool === 'task') {
      if (event.args.background !== true) {
        return;
      }

      const agentName = event.args.subagent_type ?? 'unknown';
      try {
        // Only the child binding this call confirmed for this parent names its feature, task or run; nothing is inferred.
        const child = options.getBoundChild?.({ childSessionId: event.taskId, parentSessionId: event.parentSessionId, callId: event.callId });
        options.service.registerLaunch({
          taskId: event.taskId,
          sessionId: event.taskId,
          callId: event.callId,
          agentName,
          description: event.args.description,
          runtimeId: options.runtimeId,
          scope: {
            projectRoot: options.projectRoot,
            parentSessionId: event.parentSessionId,
            primaryAgent: event.agentName,
            ...boundChildScope(child?.parentSessionId === event.parentSessionId ? child : undefined),
          },
        });
        observer.launchRecorded(event.parentSessionId, event.callId, event.taskId);
      } catch (error) {
        observer.launchNotRecorded({ parentSessionId: event.parentSessionId, callId: event.callId, childSessionId: event.taskId, agentName }, error);
      }
      return;
    }

    const status = event.status;
    if (!status) {
      return;
    }
    // The sample stays in the native result; the result says the board did not record it instead of failing the call.
    const sampleNotRecorded = (error: BackgroundBoardReadError) => {
      warn(`[hive:background] ${error.message}; task_status sample for ${event.taskId} was not recorded on the board.`);
      appendToolOutputNotice(output, `[hive background board] This task_status sample was not recorded on the board: ${error.message}. The board shows the row as last recorded until it can be read again.`);
    };
    let statusJobs: BackgroundJobRecord[];
    try {
      statusJobs = findNativeJobs(event.taskId, event.parentSessionId, status.callId);
    } catch (error) {
      if (!(error instanceof BackgroundBoardReadError)) throw error;
      sampleNotRecorded(error);
      return;
    }
    if (statusJobs.length === 0) return;
    if (statusJobs.length > 1) {
      if (!markAmbiguousObservation(statusJobs, event.taskId, 'task_status sample')) {
        // Rows are written one at a time, so earlier rows may already be marked uncertain when a later write fails.
        appendToolOutputNotice(output, `[hive background board] This task_status sample matches more than one board row for reused native child '${event.taskId}' (${statusJobs.map(job => job.alias).join(', ')}), and the board could not mark every matching row uncertain: some rows may show it as ambiguous while others show their state as last recorded. Inspect hive_task_trace({ task_id: ${JSON.stringify(event.taskId)} }) and use an exact board alias.`);
      }
      return;
    }
    const statusJob = statusJobs[0]!;

    const state = normalizeBackgroundRuntimeState(status.runtimeState, status.error?.kind);
    try {
      if (state === 'completed' || state === 'error' || state === 'cancelled') {
        options.service.markTerminal(statusJob.alias, state, {
          resultSummary: status.result,
          lastStatusError: status.error?.message,
          statusUncertain: status.timedOut,
        });
        // A task_status sample updates the observational board but is not native stop evidence.
      } else {
        options.service.updateRuntimeState(statusJob.alias, state, {
          resultSummary: status.result,
          lastStatusError: status.error?.message,
          statusUncertain: status.timedOut ?? status.error?.kind === 'transient',
        });
      }
    } catch (error) {
      // The locked update rereads the board, which can become unreadable after the lookup above.
      if (error instanceof BackgroundBoardReadError) {
        sampleNotRecorded(error);
        return;
      }
      // Other failures, such as releasing the lock, can follow a completed write, so the board may or may not hold the sample.
      const reason = error instanceof Error ? error.message : String(error);
      warn(`[hive:background] could not confirm the task_status sample for background task ${event.taskId} was recorded: ${reason}`);
      appendToolOutputNotice(output, `[hive background board] Hive could not confirm this task_status sample was recorded on the board: ${reason}. The row may show this sample or its state as last recorded; inspect it with hive_background_status before relying on it.`);
    }
  }

  function observeCompletionNotifications(messages: ReplayMessageEntry[]): void {
    for (const message of messages) {
      const parentSessionId = message.info.sessionID;
      for (const part of message.parts) {
        // OpenCode marks runtime-generated completion notifications synthetic.
        // User and worker text is never stop evidence, even when it copies the native XML envelope.
        if (message.info.role !== 'user' || part.synthetic !== true) continue;
        const parsed = part.text ? parseTaskCompletionNotification(part.text) : undefined;
        if (!parsed) {
          continue;
        }

        const notificationParent = part.sessionID ?? parentSessionId;
        if (!notificationParent) continue;
        const state = normalizeBackgroundRuntimeState(parsed.runtimeState, parsed.error?.kind);
        if (state !== 'completed' && state !== 'error' && state !== 'cancelled') continue;
        observer.observeCompletion({
          key: `${message.info.id ?? part.messageID ?? ''}\u0000${part.id ?? ''}\u0000${notificationParent}\u0000${parsed.task_id}`,
          parentSessionId: notificationParent,
          childId: parsed.task_id,
          callId: parsed.callId,
          runtimeState: state,
          result: parsed.result,
          error: parsed.error?.message,
          timedOut: parsed.timedOut,
        });
      }
    }
  }

  return adapter;
}

function appendToolOutputNotice(output: unknown, notice: string): void {
  if (!output || typeof output !== 'object') return;
  const record = output as { output?: unknown };
  const text = typeof record.output === 'string' ? record.output : '';
  record.output = text ? `${text}\n\n${notice}` : notice;
}

function toolCallKey(sessionID: string, callID: string): string {
  return JSON.stringify([sessionID, callID]);
}

function extractSessionLifecycleObservation(input: unknown): SessionLifecycleObservation | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const event = (input as { event?: unknown }).event;
  if (!event || typeof event !== 'object') {
    return undefined;
  }
  const { type, properties } = event as { type?: unknown; properties?: unknown };
  if (!properties || typeof properties !== 'object') {
    return undefined;
  }
  const record = properties as Record<string, unknown>;
  const sessionId = typeof record.sessionID === 'string'
    ? record.sessionID
    : typeof record.sessionId === 'string' ? record.sessionId : undefined;
  if (!sessionId) return undefined;

  if (type === 'session.idle') {
    return { kind: 'idle', sessionId };
  }
  if (type === 'session.status') {
    const status = record.status;
    const statusType = status && typeof status === 'object'
      ? (status as { type?: unknown }).type
      : status;
    return statusType === 'idle' ? { kind: 'idle', sessionId } : undefined;
  }
  if (type !== 'session.error') {
    return undefined;
  }

  const error = record.error;
  if (!error || typeof error !== 'object') return undefined;
  const errorRecord = error as Record<string, unknown>;
  const name = typeof errorRecord.name === 'string' && errorRecord.name.trim()
    ? errorRecord.name.trim()
    : 'SessionError';
  const data = errorRecord.data && typeof errorRecord.data === 'object'
    ? errorRecord.data as Record<string, unknown>
    : undefined;
  const message = typeof data?.message === 'string'
    ? data.message
    : typeof errorRecord.message === 'string' ? errorRecord.message : undefined;
  const diagnostic = message?.trim() ? `${name}: ${singleLine(message)}` : name;

  return {
    kind: 'error',
    sessionId,
    runtimeState: name === 'MessageAbortedError' ? 'cancelled' : 'error',
    diagnostic,
  };
}

function findTargetUserMessage(messages: ReplayMessageEntry[]): ReplayMessageEntry | undefined {
  return [...messages].reverse().find(message => message.info.role === 'user' && !!message.info.sessionID)
    ?? messages.find(message => !!message.info.sessionID);
}

function isJobVisibleInPrompt(job: BackgroundJobRecord, projectRoot: string, sessionID: string): boolean {
  const jobScope = job.scope ?? {};
  if (jobScope.projectRoot && jobScope.projectRoot !== projectRoot) {
    return false;
  }
  if (jobScope.parentSessionId !== sessionID) {
    return false;
  }
  return true;
}

function shouldShowJobInPrompt(job: BackgroundJobRecord, sessionID: string): boolean {
  // A terminal row leaves the prompt once the parent acknowledged it; being shown is not enough, since the request
  // that carried it may have failed before the parent processed it.
  if (job.promptAcknowledgedAt && job.promptNotifiedInSessionId === sessionID && isTerminalRuntimeState(job.runtimeState)) {
    return false;
  }

  return job.runtimeState === 'running'
    || (job.runtimeState === 'unknown' && job.statusUncertain === true)
    || job.terminalUnreconciled === true
    || !!job.cancelRequestedAt
    || !!job.staleAt;
}

/** A row the board still treats as a running or uncertain launch: neither terminal nor archived. */
export function isLiveBackgroundJob(job: BackgroundJobRecord): boolean {
  return !isBackgroundJobArchived(job) && !isTerminalRuntimeState(job.runtimeState);
}

function isTerminalRuntimeState(state: BackgroundJobRecord['runtimeState']): boolean {
  return state === 'completed' || state === 'error' || state === 'cancelled';
}

function formatPromptBoard(jobs: BackgroundJobRecord[], unrecorded: UnrecordedLaunch[], boardReadError?: string): string {
  const readLines = boardReadError === undefined ? [] : [
    `- board unreadable: ${promptSnippet(boardReadError)}\n  coordination: rows for this session's other launches are unknown, not absent; inspect each launched child before relying on the board, and do not launch an overlapping writer`,
  ];
  const gapLines = unrecorded.map(launch =>
    `- unrecorded launch (${launch.childSessionId}) ${launch.agentName}\n  runtime: unconfirmed; Hive could not confirm this launch was recorded on the board (${promptSnippet(launch.reason)}), so the board may have no row for it or a row written before the failure; diagnostic: hive_task_trace({ task_id: ${JSON.stringify(launch.childSessionId)} })\n  coordination: inspect before relying on the board; do not repeat the launch or launch an overlapping writer`);
  const lines = jobs.map((job) => {
    const runtimeParts = [
      job.runtimeState,
      job.resultSummary ? `result: ${promptSnippet(job.resultSummary)}` : undefined,
      job.lastStatusError ? `status error: ${promptSnippet(job.lastStatusError)}` : undefined,
      job.statusUncertain ? 'status uncertain' : undefined,
      job.statusUncertain ? `diagnostic: hive_task_trace({ task_id: ${JSON.stringify(job.sessionId)} })` : undefined,
    ].filter(Boolean).join('; ');
    const coordinationParts = [
      job.terminalUnreconciled ? 'terminal unreconciled' : undefined,
      job.cancelReason ? `cancel requested: ${singleLine(job.cancelReason)}` : undefined,
      job.staleAt ? 'stale/orphan recovery' : undefined,
    ].filter(Boolean).join('; ') || 'none';
    const scope = [job.scope?.feature, job.scope?.task, job.scope?.adHocRunId, job.scope?.workflow].filter(Boolean).join('/');

    return `- ${job.alias} (${job.taskId}) ${job.agentName}${scope ? ` ${scope}` : ''}\n  runtime: ${runtimeParts}\n  coordination: ${coordinationParts}`;
  });

  return `## Background Job Board\n${[...readLines, ...lines, ...gapLines].join('\n')}`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function promptSnippet(value: string): string {
  const line = singleLine(value);
  return line.length > 500 ? `${line.slice(0, 497)}...` : line;
}

function normalizeBackgroundRuntimeState(
  runtimeState: string | undefined,
  errorKind: 'transient' | 'terminal' | undefined,
): BackgroundJobRuntimeState {
  const normalized = runtimeState?.trim().toLowerCase();
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'success') return 'completed';
  if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') return 'error';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  if (normalized === 'running' || normalized === 'pending' || normalized === 'queued') return 'running';
  if (errorKind === 'terminal') return 'error';
  return 'unknown';
}
