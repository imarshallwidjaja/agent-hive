import type {
  BackgroundJobRecord,
  BackgroundJobRuntimeState,
  BackgroundJobService,
  SessionInfo,
} from 'hive-core';
import { isBackgroundJobArchived } from 'hive-core';
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

export interface BoardObserverOptions {
  projectRoot: string;
  service: BackgroundJobService;
  runtimeId?: string;
  warn: (message: string) => void;
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
 */
export function createBoardObserver(options: BoardObserverOptions) {
  const { warn } = options;
  const observedCompletionNotifications = new Set<string>();

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
    const jobs = findNativeJobs(observation.childId, observation.parentSessionId, observation.callId);
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

  /** The parent session finished a turn, so it has seen the board it was shown. */
  function acknowledgePrompt(parentSessionId: string): void {
    try {
      options.service.markPromptAcknowledgedForSession(parentSessionId);
    } catch (error) {
      warn(`[hive:background] failed to acknowledge parent prompt for ${parentSessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The board a parent session's next model request shows, or undefined when nothing needs showing. Rows from an
   * earlier runtime epoch are classified stale first. Showing the board records the prompt notification.
   */
  function promptBoard(sessionID: string): { text: string; notify: () => void } | undefined {
    classifyRuntimeEpochStaleJobs({
      service: options.service,
      projectRoot: options.projectRoot,
      currentRuntimeId: options.runtimeId,
      isVisible: job => isJobVisibleInPrompt(job, options.projectRoot, sessionID),
    });
    const jobs = options.service
      .listScoped({ projectRoot: options.projectRoot })
      .filter(job => isJobVisibleInPrompt(job, options.projectRoot, sessionID))
      .filter(job => shouldShowJobInPrompt(job, sessionID));
    if (jobs.length === 0) return undefined;
    return { text: formatPromptBoard(jobs), notify: () => { options.service.markPromptNotified(jobs.map(job => job.taskId), sessionID); } };
  }

  return { findNativeJobs, markAmbiguousObservation, observeCompletion, observeSessionLifecycle, acknowledgePrompt, promptBoard };
}

export type BoardObserver = ReturnType<typeof createBoardObserver>;

/** V1 board adapter: decodes v1 tool output, synthetic XML notifications and session events into the shared observer. */
export function createBackgroundJobAdapter(options: BackgroundJobAdapterOptions) {
  const lifecycleContextByCall = new Map<string, TaskLifecycleContext>();
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
          featureLabel: typeof session?.featureName === 'string' ? session.featureName : undefined,
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
          await handleLifecycleEvent(event);
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
    },

    event: async (input: unknown): Promise<void> => {
      if (!options.isEnabled()) {
        return;
      }

      const observation = extractSessionLifecycleObservation(input);
      if (!observation) {
        return;
      }
      if (observation.kind === 'idle') {
        observer.acknowledgePrompt(observation.sessionId);
      }
      observeSessionLifecycle(observation);
    },
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
      featureLabel: staged?.featureLabel,
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

  async function handleLifecycleEvent(event: ParsedTaskLifecycleEvent): Promise<void> {
    if (event.tool === 'task') {
      if (event.args.background !== true) {
        return;
      }

      try {
        options.service.registerLaunch({
          taskId: event.taskId,
          sessionId: event.taskId,
          callId: event.callId,
          agentName: event.args.subagent_type ?? 'unknown',
          description: event.args.description,
          runtimeId: options.runtimeId,
          scope: {
            projectRoot: options.projectRoot,
            parentSessionId: event.parentSessionId,
            primaryAgent: event.agentName,
            feature: event.featureLabel,
          },
        });
      } catch (error) {
        warn(`[hive:background] failed to record background launch ${event.taskId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    const status = event.status;
    if (!status) {
      return;
    }
    const statusJobs = findNativeJobs(event.taskId, event.parentSessionId, status.callId);
    if (statusJobs.length === 0) return;
    if (statusJobs.length > 1) {
      markAmbiguousObservation(statusJobs, event.taskId, 'task_status sample');
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
      warn(`[hive:background] failed to update background task ${event.taskId}: ${error instanceof Error ? error.message : String(error)}`);
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
  if (job.promptNotifiedAt && job.promptNotifiedInSessionId === sessionID && isTerminalRuntimeState(job.runtimeState)) {
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

function formatPromptBoard(jobs: BackgroundJobRecord[]): string {
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

  return `## Background Job Board\n${lines.join('\n')}`;
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
