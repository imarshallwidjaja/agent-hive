import type {
  BackgroundJobRecord,
  BackgroundJobRuntimeState,
  BackgroundJobScope,
  BackgroundJobService,
  SessionInfo,
} from 'hive-core';
import { parseTaskLifecycleEvent, type ParsedTaskLifecycleEvent, type TaskLifecycleContext } from './taskOutput.js';

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
  getSession?: (sessionId: string) => SessionInfo | undefined;
  isPrimaryAgent?: (agentName: string | undefined, session: SessionInfo | undefined) => boolean;
  resolvePromptScope?: (input: unknown, session: SessionInfo | undefined) => BackgroundJobScope;
  parseLifecycleEvent?: (input: unknown, output: unknown, context?: TaskLifecycleContext) => ParsedTaskLifecycleEvent | undefined;
  warn?: (message: string) => void;
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
      const jobs = options.service.listScoped(scope).filter(shouldShowJobInPrompt);
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
        options.service.registerLaunch({
          taskId: event.taskId,
          sessionId: `${event.parentSessionId}:${event.taskId}`,
          agentName: event.args.subagent_type ?? pendingLaunch?.agentName ?? 'unknown',
          description: event.args.description,
          scope: pendingLaunch?.scope ?? {
            projectRoot: options.projectRoot,
            parentSessionId: event.parentSessionId,
            primaryAgent: event.agentName,
            feature: parentSession?.featureName,
            task: parentSession?.taskFolder,
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

function findTargetUserMessage(messages: ReplayMessageEntry[]): ReplayMessageEntry | undefined {
  return [...messages].reverse().find(message => message.info.role === 'user' && !!message.info.sessionID)
    ?? messages.find(message => !!message.info.sessionID);
}

function shouldShowJobInPrompt(job: BackgroundJobRecord): boolean {
  return job.runtimeState === 'running'
    || job.terminalUnreconciled === true
    || !!job.cancelRequestedAt
    || !!job.staleAt;
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
