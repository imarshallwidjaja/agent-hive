import { HIVE_SESSION_POLICY } from './session-policy.js';

export type HiveTaskToolCallPayload = {
  subagent_type: string;
  description: string;
  prompt: string;
};

export type HiveBackgroundTaskCallPayload = HiveTaskToolCallPayload & {
  background: true;
};

export type AdhocLaunchMode = 'blocking_task_call' | 'suppressed';

export function buildAdhocWorkerLaunchPayloads(params: {
  subagent_type: string;
  description: string;
  prompt: string;
  backgroundEnabled: boolean;
  shouldAutoSpawnWorker: boolean;
}): {
  taskToolCall?: HiveTaskToolCallPayload;
  backgroundTaskCall?: HiveBackgroundTaskCallPayload;
  launchMode: AdhocLaunchMode;
  sessionPolicy?: typeof HIVE_SESSION_POLICY;
} {
  if (!params.shouldAutoSpawnWorker) {
    return { launchMode: 'suppressed' };
  }

  const base: HiveTaskToolCallPayload = {
    subagent_type: params.subagent_type,
    description: params.description,
    prompt: params.prompt,
  };

  const taskToolCall = base;
  const backgroundTaskCall = params.backgroundEnabled
    ? { ...base, background: true as const }
    : undefined;

  const launchMode: AdhocLaunchMode = 'blocking_task_call';

  return {
    taskToolCall,
    ...(backgroundTaskCall ? { backgroundTaskCall } : {}),
    launchMode,
    sessionPolicy: HIVE_SESSION_POLICY,
  };
}

export function adhocCreateNextAction(params: {
  shouldAutoSpawnWorker: boolean;
  hasBackgroundTaskCall: boolean;
}): string {
  if (!params.shouldAutoSpawnWorker) {
    return 'Use this worktree for inspection, routing, or setup. Delegate execution lanes explicitly when needed; call hive_adhoc_worktree_commit only after changes are ready to commit.';
  }
  if (params.hasBackgroundTaskCall) {
    return 'Launch `taskToolCall` when the next step depends on the worker; use `backgroundTaskCall` only for independent lanes where useful foreground work can continue. Do not write implementation code in Builder unless an allowed direct-edit escape is stated. After the worker completes, reconcile/inspect/verify, then commit, merge, and cleanup the ad-hoc worktree.';
  }
  return 'launch the returned `taskToolCall` as a normal blocking task; do not work directly in the ad-hoc worktree. After the worker completes, inspect/verify, then commit, merge, and cleanup the ad-hoc worktree.';
}