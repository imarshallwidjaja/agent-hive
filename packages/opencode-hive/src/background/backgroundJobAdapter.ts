import type {
  BackgroundPendingLaunch,
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
  resolveClaimedLaunchId?: (sessionId: string, callId: string) => string | undefined;
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
        const stagedArgs = { ...output.args };
        if (input.tool === 'task' && stagedArgs.background === undefined) stagedArgs.background = false;
        const key = toolCallKey(input.sessionID, input.callID);
        const launchId = input.tool === 'task'
          ? options.resolveClaimedLaunchId?.(input.sessionID, input.callID)
          : undefined;
        let claimedPending: BackgroundPendingLaunch | undefined;
        if (launchId) {
          claimedPending = options.service.claimPendingLaunch({
            launchId,
            parentSessionId: input.sessionID,
            callId: input.callID,
            runtimeId: options.runtimeId,
            background: stagedArgs.background === true,
          });
          if (!claimedPending) {
            throw new Error('launch_binding_error: claimed launch bookkeeping is missing or already consumed');
          }
        }
        toolArgsByCall.set(key, stagedArgs);
      }
    },

    'tool.execute.after': async (input: unknown, output: unknown): Promise<void> => {
      if (!options.isEnabled()) {
        clearLifecycleContext(input);
        return;
      }

      let context: ReturnType<typeof resolveLifecycleContext>;
      try {
        context = resolveLifecycleContext(input);
        const event = parseLifecycleEvent(input, output, context?.lifecycle);
        if (event) {
          await handleLifecycleEvent(event, context?.pendingLaunch);
        } else if (context?.pendingLaunch) {
          options.service.finishClaimedLaunch(context.pendingLaunch.launchId, context.pendingLaunch.parentSessionId, context.pendingLaunch.callId!, context.lifecycle.args?.background === false ? undefined : 'Native identity unavailable: launch output was missing or could not be parsed. Execution may still be running.');
        }
      } catch (error) {
        if (context?.pendingLaunch) {
          try {
            options.service.finishClaimedLaunch(context.pendingLaunch.launchId, context.pendingLaunch.parentSessionId, context.pendingLaunch.callId!, `Native registration failed: ${error instanceof Error ? error.message : String(error)}`);
          } catch (storageError) {
            warn(`[hive:background] claimed launch ${context.pendingLaunch.launchId} remains unresolved; failed to persist registration error: ${String(storageError)}`);
          }
        }
        throw error;
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
      const unresolved = options.service.listPendingLaunches({ projectRoot: options.projectRoot, parentSessionId: sessionID })
        .filter(pending => pending.disposition === 'claimed' && isJobVisibleInPrompt({ scope: pending.scope } as BackgroundJobRecord, scope, sessionID));
      if (jobs.length === 0 && unresolved.length === 0) {
        return;
      }

      const board = [formatPromptBoard(jobs), ...unresolved.map(pending => `- launch ${pending.launchId}, parent ${pending.parentSessionId}, call ${pending.callId}: registration unresolved. Native identity unavailable; execution may still be running. Scope: ${JSON.stringify(pending.scope)}. Ownership: ${JSON.stringify(pending.ownership)}. Inspect native execution or archive bookkeeping with hive_background_reconcile(identifier: launchId, decision: ignored, summary: reason). Archiving does not stop execution or authorize a replacement writer.`)].join('\n');
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

  function resolveLifecycleContext(input: unknown): {
    lifecycle: TaskLifecycleContext;
    pendingLaunch?: BackgroundPendingLaunch;
  } | undefined {
    if (!input || typeof input !== 'object') {
      return undefined;
    }

    const record = input as { tool?: string; sessionID?: string; callID?: string; args?: Record<string, unknown> };
    const key = record.sessionID && record.callID ? toolCallKey(record.sessionID, record.callID) : undefined;
    const args = (key ? toolArgsByCall.get(key) : undefined) ?? record.args;
    const pendingLaunch = record.tool === 'task' && record.sessionID && record.callID
      ? options.service.findClaimedLaunch(record.sessionID, record.callID)
      : undefined;
    if (pendingLaunch && args?.background !== undefined && pendingLaunch.background !== undefined && args.background !== pendingLaunch.background) throw new Error('launch_binding_error: contradictory dispatch mode');

    const session = record.sessionID ? options.getSession?.(record.sessionID) : undefined;
    return {
      lifecycle: {
        args: pendingLaunch ? { subagent_type: pendingLaunch.agentName, ...args, background: pendingLaunch.background } : args,
        agentName: typeof session?.agent === 'string' ? session.agent : undefined,
      },
      pendingLaunch,
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
    toolArgsByCall.delete(key);
  }

  async function handleLifecycleEvent(
    event: ParsedTaskLifecycleEvent,
    pendingLaunch?: BackgroundPendingLaunch,
  ): Promise<void> {
    if (event.tool === 'task') {
      if (pendingLaunch && (pendingLaunch.parentSessionId !== event.parentSessionId || pendingLaunch.callId !== event.callId)) throw new Error('launch_binding_error: lifecycle parent/call contradiction');
      if (event.args.background !== true) {
        if (pendingLaunch && event.args.background === false) options.service.finishClaimedLaunch(pendingLaunch.launchId, pendingLaunch.parentSessionId, pendingLaunch.callId!);
        return;
      }

      const parentSession = options.getSession?.(event.parentSessionId);
      {
        const existingCalls = event.callId ? options.service.listScoped({ projectRoot: options.projectRoot, parentSessionId: event.parentSessionId }, { includeArchived: true }).filter(job => job.callId === event.callId) : [];
        if (existingCalls.length > 1) throw new Error('launch_binding_error: ambiguous native callback');
        const existingCall = existingCalls[0];
        if (existingCall) {
          const activePendingLaunch = pendingLaunch && !pendingLaunch.archivedAt ? pendingLaunch : undefined;
          if (existingCall.taskId !== event.taskId || (activePendingLaunch && existingCall.launchId !== activePendingLaunch.launchId)) throw new Error('launch_binding_error: contradictory native callback');
          return;
        }
        const scopeSource = pendingLaunch ? 'pending-launch' : 'native-fallback';
        options.service.registerLaunch({
          taskId: event.taskId,
          sessionId: event.taskId,
          launchId: pendingLaunch?.launchId,
          callId: event.callId,
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
      }
      return;
    }

    const status = event.status;
    if (!status) {
      return;
    }
    const statusJob = options.service.resolve(event.taskId);
    if (!statusJob || !isNotificationForJob(statusJob, event.parentSessionId)) return;

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
    return false;
  }

  return adapter;
}

function toolCallKey(sessionID: string, callID: string): string {
  return JSON.stringify([sessionID, callID]);
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
  if (jobScope.parentSessionId !== sessionID) {
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
