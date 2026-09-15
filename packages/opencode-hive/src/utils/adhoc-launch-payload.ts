import { HIVE_SESSION_POLICY } from './session-policy.js';

export type HiveTaskToolCallPayload = {
  subagent_type: string;
  description: string;
  prompt: string;
  hive_launch_id: string;
};

export type HiveBackgroundTaskCallPayload = HiveTaskToolCallPayload & {
  background: true;
};

export type AdhocLaunchMode = 'blocking_task_call' | 'suppressed';

export function buildAdhocWorkerLaunchPayloads(params: {
  subagent_type: string;
  description: string;
  prompt: string;
  launchId: string;
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
    hive_launch_id: params.launchId,
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
    return 'Launch task({ ...taskToolCall }) (or backgroundTaskCall for independent lanes) preserving hive_launch_id. Multiple writes in the same worktree must run sequentially. Do not write implementation code in Builder unless an allowed direct-edit escape is stated. After the worker completes, reconcile/inspect/verify, then commit, merge, and cleanup the ad-hoc worktree.';
  }
  return 'Launch task({ ...taskToolCall }) (or task({ ...taskToolCall, subagent_type: specialist }) for an eligible specialist), preserving hive_launch_id. Multiple writes in the same worktree must run sequentially. After the worker completes, inspect/verify, then commit, merge, and cleanup the ad-hoc worktree.';
}
