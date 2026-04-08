import type { SessionKind } from 'hive-core';

export type TaskLaunchKind = 'task-worker' | 'subagent';

export interface TaskToolLaunchState {
  parentSessionId: string;
  delegatedAgent: string;
  kind: TaskLaunchKind;
  featureName?: string;
  taskFolder?: string;
  workerPromptPath?: string;
  source: 'opencode-task-tool';
}

export type PendingTaskToolLaunches = Record<string, TaskToolLaunchState>;

interface ClassifyTaskToolLaunchInput {
  sessionID: string;
  tool?: string;
  args?: {
    subagent_type?: string;
    description?: string;
    prompt?: string;
  };
}

interface RecordTaskToolLaunchInput extends ClassifyTaskToolLaunchInput {
  pending: PendingTaskToolLaunches;
  callID?: string;
}

interface ConsumeTaskToolLaunchInput {
  pending: PendingTaskToolLaunches;
  sessionID: string;
  callID?: string;
  tool?: string;
}

const WORKER_PROMPT_PATTERN = /@((?:\.hive\/)?features\/([^/]+)\/tasks\/([^/]+)\/worker-prompt\.md)/;

function normalizePromptPath(rawPath: string): string {
  return rawPath.startsWith('.hive/') ? rawPath : `./${rawPath}`;
}

function toSessionKind(kind: TaskLaunchKind): SessionKind {
  return kind === 'task-worker' ? 'task-worker' : 'subagent';
}

export function classifyTaskToolLaunch(input: ClassifyTaskToolLaunchInput): TaskToolLaunchState | undefined {
  if (input.tool && input.tool !== 'task') {
    return undefined;
  }

  const delegatedAgent = input.args?.subagent_type?.trim();
  if (!delegatedAgent) {
    return undefined;
  }

  const prompt = input.args?.prompt?.trim() ?? '';
  const workerPromptMatch = prompt.match(WORKER_PROMPT_PATTERN);

  if (workerPromptMatch) {
    const [, matchedPath, featureName, taskFolder] = workerPromptMatch;
    return {
      parentSessionId: input.sessionID,
      delegatedAgent,
      kind: 'task-worker',
      featureName,
      taskFolder,
      workerPromptPath: normalizePromptPath(matchedPath),
      source: 'opencode-task-tool',
    };
  }

  return {
    parentSessionId: input.sessionID,
    delegatedAgent,
    kind: 'subagent',
    source: 'opencode-task-tool',
  };
}

function toPendingTaskToolLaunchKey(sessionID: string, callID: string): string {
  return `${sessionID}:${callID}`;
}

export function recordTaskToolLaunch(input: RecordTaskToolLaunchInput): PendingTaskToolLaunches {
  const launch = classifyTaskToolLaunch(input);
  if (!launch) {
    return input.pending;
  }

  const callID = input.callID?.trim();
  if (!callID) {
    return input.pending;
  }

  return {
    ...input.pending,
    [toPendingTaskToolLaunchKey(input.sessionID, callID)]: launch,
  };
}

export function consumeTaskToolLaunch(input: ConsumeTaskToolLaunchInput): {
  launch?: TaskToolLaunchState;
  pending: PendingTaskToolLaunches;
} {
  if (input.tool && input.tool !== 'task') {
    return { pending: input.pending };
  }

  const callID = input.callID?.trim();
  if (!callID) {
    return { pending: input.pending };
  }

  const key = toPendingTaskToolLaunchKey(input.sessionID, callID);
  const { [key]: launch, ...rest } = input.pending;
  return { launch, pending: rest };
}

export function normalizeHiveFeatureName(featureName: string): string {
  return featureName.replace(/^\d+[_-]/, '');
}

export function extractTaskToolChildSessionId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const metadata = (result as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }

  const sessionId = (metadata as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.trim().length > 0
    ? sessionId
    : undefined;
}

export function toChildSessionPatch(state: TaskToolLaunchState, childSessionId: string) {
  return {
    sessionId: childSessionId,
    featureName: state.featureName ? normalizeHiveFeatureName(state.featureName) : undefined,
    taskFolder: state.taskFolder,
    parentSessionId: state.parentSessionId,
    delegatedAgent: state.delegatedAgent,
    childSessionSource: state.source,
    childSessionKind: toSessionKind(state.kind),
    sessionKind: toSessionKind(state.kind),
    agent: state.delegatedAgent,
    workerPromptPath: state.workerPromptPath,
  };
}
