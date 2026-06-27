import type {
  BackgroundJobRecord,
  BackgroundJobRuntimeState,
  BackgroundJobScope,
  BackgroundJobService,
  SessionInfo,
} from 'hive-core';
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
  isPrimaryAgent?: (agentName: string | undefined, session: SessionInfo | undefined) => boolean;
  resolvePromptScope?: (input: unknown, session: SessionInfo | undefined) => BackgroundJobScope;
  parseLifecycleEvent?: (input: unknown, output: unknown, context?: TaskLifecycleContext) => ParsedTaskLifecycleEvent | undefined;
  warn?: (message: string) => void;
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
      job.taskId,
      input.currentRuntimeId,
      `Background worker runtime identity changed. Job was registered by runtime '${job.runtimeId || '(unknown)'}' but current runtime is '${input.currentRuntimeId}'.`,
    );
  }
}

export function createBackgroundJobAdapter(options: BackgroundJobAdapterOptions) {
  const toolArgsByCall = new Map<string, Record<string, unknown>>();
  const parseLifecycleEvent = options.parseLifecycleEvent ?? parseTaskLifecycleEvent;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const adapter = {
    'tool.execute.before': async (input: { tool?: string; sessionID?: string; callID?: string }, output: { args?: Record<string, unknown> }): Promise<void> => {
      if (!options.isEnabled()) {
        return;
      }

      if ((input.tool === 'task' || input.tool === 'task_status') && input.sessionID && input.callID && output.args && typeof output.args === 'object') {
        toolArgsByCall.set(toolCallKey(input.sessionID, input.callID), { ...output.args });
      }
    },

    'tool.execute.after': async (input: unknown, output: unknown): Promise<void> => {
      if (!options.isEnabled()) {
        return;
      }

      const context = resolveLifecycleContext(input);
      const event = parseLifecycleEvent(input, output, context);
      if (event) {
        await handleLifecycleEvent(event);
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

      const session = options.getSession?.(sessionID);
      const agentName = session?.agent;
      const isPrimaryAgent = options.isPrimaryAgent ?? defaultIsPrimaryAgent;
      if (!isPrimaryAgent(agentName, session)) {
        return;
      }

      const scope = options.resolvePromptScope?.(input, session) ?? defaultPromptScope(options.projectRoot, session);
      classifyRuntimeEpochStaleJobs({
        service: options.service,
        projectRoot: options.projectRoot,
        currentRuntimeId: options.runtimeId,
        isVisible: job => isJobVisibleInPrompt(job, scope, sessionID),
      });
      const jobs = options.service
        .listScoped({ projectRoot: options.projectRoot })
        .filter(job => isJobVisibleInPrompt(job, scope, sessionID))
        .filter(job => shouldShowJobInPrompt(job, sessionID));
      if (jobs.length === 0) {
        return;
      }

      const board = formatPromptBoard(jobs);
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
        text: `\n\n${board}`,
        synthetic: true,
      });
      options.service.markPromptNotified(jobs.map(job => job.taskId), sessionID);
    },

    event: async (input: unknown): Promise<void> => {
      if (!options.isEnabled()) {
        return;
      }

      const sessionID = extractIdleSessionId(input);
      if (sessionID) {
        options.service.markPromptAcknowledgedForSession(sessionID);
      }
    },
  };

  function resolveLifecycleContext(input: unknown): TaskLifecycleContext | undefined {
    if (!input || typeof input !== 'object') {
      return undefined;
    }

    const record = input as { sessionID?: string; callID?: string };
    const key = record.sessionID && record.callID ? toolCallKey(record.sessionID, record.callID) : undefined;
    const args = key ? toolArgsByCall.get(key) : undefined;
    if (key) {
      toolArgsByCall.delete(key);
    }

    const session = record.sessionID ? options.getSession?.(record.sessionID) : undefined;
    return {
      args,
      agentName: typeof session?.agent === 'string' ? session.agent : undefined,
    };
  }

  async function handleLifecycleEvent(event: ParsedTaskLifecycleEvent): Promise<void> {
    if (event.tool === 'task') {
      if (event.args.background !== true) {
        options.service.consumePendingLaunch({
          parentSessionId: event.parentSessionId,
          expectedDescription: event.args.description,
          expectedPrompt: event.args.prompt,
        });
        return;
      }

      const parentSession = options.getSession?.(event.parentSessionId);
      const pendingLaunch = options.service.consumePendingLaunch({
        parentSessionId: event.parentSessionId,
        expectedDescription: event.args.description,
        expectedPrompt: event.args.prompt,
      });
      try {
        const scopeSource = pendingLaunch ? 'pending-launch' : 'native-fallback';
        options.service.registerLaunch({
          taskId: event.taskId,
          sessionId: `${event.parentSessionId}:${event.taskId}`,
          agentName: event.args.subagent_type ?? pendingLaunch?.agentName ?? 'unknown',
          description: event.args.description,
          runtimeId: options.runtimeId,
          scopeSource,
          scope: pendingLaunch?.scope ?? {
            projectRoot: options.projectRoot,
            parentSessionId: event.parentSessionId,
            primaryAgent: event.agentName,
            feature: parentSession?.featureName,
          },
          ownership: pendingLaunch?.ownership,
        });
      } catch (error) {
        if (!(error instanceof Error) || !/already registered/.test(error.message)) {
          warn(`[hive:background] failed to register background task ${event.taskId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return;
    }

    const status = event.status;
    if (!status) {
      return;
    }

    const state = normalizeBackgroundRuntimeState(status.runtimeState, status.error?.kind);
    try {
      if (state === 'completed' || state === 'error' || state === 'cancelled') {
        options.service.markTerminal(event.taskId, state, {
          resultSummary: status.result,
          lastStatusError: status.error?.message,
          statusUncertain: status.timedOut,
        });
      } else {
        options.service.updateRuntimeState(event.taskId, state, {
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
        const parsed = part.text ? parseTaskCompletionNotification(part.text) : undefined;
        if (!parsed) {
          continue;
        }

        const job = options.service.resolve(parsed.task_id);
        if (!job || isTerminalRuntimeState(job.runtimeState) || !isNotificationForJob(job, part.sessionID ?? parentSessionId)) {
          continue;
        }

        const state = normalizeBackgroundRuntimeState(parsed.runtimeState, parsed.error?.kind);
        if (state !== 'completed' && state !== 'error' && state !== 'cancelled') {
          continue;
        }

        try {
          options.service.markTerminal(parsed.task_id, state, {
            resultSummary: parsed.result,
            lastStatusError: parsed.error?.message,
            statusUncertain: parsed.timedOut,
          });
        } catch (error) {
          warn(`[hive:background] failed to update background task ${parsed.task_id} from completion notification: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  function isNotificationForJob(job: BackgroundJobRecord, parentSessionId: string | undefined): boolean {
    if (job.scope?.projectRoot && job.scope.projectRoot !== options.projectRoot) {
      return false;
    }
    if (job.scope?.parentSessionId) {
      return job.scope.parentSessionId === parentSessionId;
    }
    return true;
  }

  return adapter;
}

function toolCallKey(sessionID: string, callID: string): string {
  return `${sessionID}:${callID}`;
}

function defaultIsPrimaryAgent(_agentName: string | undefined, session: SessionInfo | undefined): boolean {
  return session?.sessionKind === 'primary';
}

function defaultPromptScope(projectRoot: string, session: SessionInfo | undefined): BackgroundJobScope {
  return {
    projectRoot,
    parentSessionId: session?.sessionId,
    primaryAgent: session?.agent,
    feature: session?.featureName,
    task: session?.taskFolder,
  };
}

function extractIdleSessionId(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const event = (input as { event?: { type?: string; properties?: { sessionID?: string; sessionId?: string } } }).event;
  if (event?.type !== 'session.idle' && event?.type !== 'session.status') {
    return undefined;
  }
  if (event.type === 'session.status' && (event.properties as { status?: string } | undefined)?.status !== 'idle') {
    return undefined;
  }

  return event.properties?.sessionID ?? event.properties?.sessionId;
}

function findTargetUserMessage(messages: ReplayMessageEntry[]): ReplayMessageEntry | undefined {
  return [...messages].reverse().find(message => message.info.role === 'user' && !!message.info.sessionID)
    ?? messages.find(message => !!message.info.sessionID);
}

function isJobVisibleInPrompt(job: BackgroundJobRecord, scope: BackgroundJobScope, sessionID: string): boolean {
  const jobScope = job.scope ?? {};
  if (jobScope.projectRoot && jobScope.projectRoot !== scope.projectRoot) {
    return false;
  }
  if (jobScope.parentSessionId && jobScope.parentSessionId !== sessionID) {
    return false;
  }
  if (scope.primaryAgent && jobScope.primaryAgent && jobScope.primaryAgent !== scope.primaryAgent) {
    return false;
  }
  if (scope.feature && jobScope.feature && jobScope.feature !== scope.feature) {
    return false;
  }
  if (scope.task && jobScope.task && jobScope.task !== scope.task) {
    return false;
  }
  if (scope.adHocRunId && jobScope.adHocRunId && jobScope.adHocRunId !== scope.adHocRunId) {
    return false;
  }
  if (scope.workflow && jobScope.workflow && jobScope.workflow !== scope.workflow) {
    return false;
  }
  return true;
}

function shouldShowJobInPrompt(job: BackgroundJobRecord, sessionID: string): boolean {
  if (job.promptNotifiedAt && job.promptNotifiedInSessionId === sessionID && isTerminalRuntimeState(job.runtimeState)) {
    return false;
  }

  return job.runtimeState === 'running'
    || job.terminalUnreconciled === true
    || !!job.cancelRequestedAt
    || !!job.staleAt;
}

function isTerminalRuntimeState(state: BackgroundJobRecord['runtimeState']): boolean {
  return state === 'completed' || state === 'error' || state === 'cancelled';
}

function formatPromptBoard(jobs: BackgroundJobRecord[]): string {
  const lines = jobs.map((job) => {
    const runtimeParts = [
      job.runtimeState,
      job.resultSummary ? `result: ${singleLine(job.resultSummary)}` : undefined,
      job.lastStatusError ? `status error: ${singleLine(job.lastStatusError)}` : undefined,
      job.statusUncertain ? 'status uncertain' : undefined,
    ].filter(Boolean).join('; ');
    const coordinationParts = [
      job.terminalUnreconciled ? 'terminal unreconciled' : undefined,
      job.cancelReason ? `cancel requested: ${singleLine(job.cancelReason)}` : undefined,
      job.staleAt ? 'stale/orphan recovery' : undefined,
      job.retryOf ? `retry of ${job.retryOf}` : undefined,
    ].filter(Boolean).join('; ') || 'none';
    const scope = [job.scope?.feature, job.scope?.task, job.scope?.adHocRunId, job.scope?.workflow].filter(Boolean).join('/');

    return `- ${job.alias} (${job.taskId}) ${job.agentName}${scope ? ` ${scope}` : ''}\n  runtime: ${runtimeParts}\n  coordination: ${coordinationParts}`;
  });

  return `## Background Job Board\n${lines.join('\n')}`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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
