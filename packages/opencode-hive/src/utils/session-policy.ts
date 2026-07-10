export const HIVE_SESSION_POLICY = {
  version: 1,
  sessionMode: 'fresh',
  taskIdUse: 'observe-only',
  followUpMode: 'new-launch',
  workerLifecycle: 'terminal',
  goalMode: 'one-primary',
} as const;

export function shouldRejectTaskIdReuse(params: {
  tool: string | undefined;
  sessionKind: string | undefined;
  args: Record<string, unknown> | undefined;
}): { reject: true; message: string } | { reject: false } {
  if (params.tool !== 'task') {
    return { reject: false };
  }

  if (params.sessionKind !== 'primary') {
    return { reject: false };
  }

  let taskId: string | undefined;
  if (params.args && typeof params.args === 'object') {
    const raw = params.args.task_id;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      taskId = trimmed.length > 0 ? trimmed : undefined;
    }
  }

  if (!taskId) {
    return { reject: false };
  }

  return {
    reject: true,
    message: [
      'Hive fresh-session policy forbids task({ task_id }) from primary orchestrators.',
      'Launch a new task() without task_id (sessionMode=fresh, followUpMode=new-launch).',
      'Use task_status or hive_background_status/reconcile/cancel with identifiers for observe-only follow-up;',
      'do not resume workers via task_id.',
    ].join(' '),
  };
}
