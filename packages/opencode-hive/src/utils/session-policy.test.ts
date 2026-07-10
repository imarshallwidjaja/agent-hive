import { describe, expect, it } from 'bun:test';
import { HIVE_SESSION_POLICY, shouldRejectTaskIdReuse } from './session-policy.js';

describe('HIVE_SESSION_POLICY', () => {
  it('exposes version-1 fresh-session observe-only policy fields', () => {
    expect(HIVE_SESSION_POLICY).toEqual({
      version: 1,
      sessionMode: 'fresh',
      taskIdUse: 'observe-only',
      followUpMode: 'new-launch',
      workerLifecycle: 'terminal',
      goalMode: 'one-primary',
    });
  });
});

describe('shouldRejectTaskIdReuse', () => {
  it('rejects task() with task_id from Hive primary orchestrators', () => {
    const decision = shouldRejectTaskIdReuse({
      tool: 'task',
      sessionKind: 'primary',
      args: {
        description: 'Resume worker',
        prompt: 'continue',
        task_id: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
      },
    });
    expect(decision.reject).toBe(true);
    if (decision.reject) {
      expect(decision.message).toMatch(/fresh-session|task_id|new-launch|without task_id/i);
      expect(decision.message).toMatch(/task_status|hive_background/i);
    }
  });

  it('allows task() without task_id from primary orchestrators', () => {
    expect(shouldRejectTaskIdReuse({
      tool: 'task',
      sessionKind: 'primary',
      args: {
        description: 'Hive: 01-first-task',
        prompt: 'Follow instructions in @worker-prompt.md',
        subagent_type: 'forager-worker',
      },
    })).toEqual({ reject: false });
  });

  it('allows task_status with task_id (observe-only)', () => {
    expect(shouldRejectTaskIdReuse({
      tool: 'task_status',
      sessionKind: 'primary',
      args: { task_id: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2' },
    })).toEqual({ reject: false });
  });

  it('allows hive background board tools that pass identifiers', () => {
    for (const tool of [
      'hive_background_status',
      'hive_background_reconcile',
      'hive_background_reconcile_batch',
      'hive_background_cancel',
    ]) {
      expect(shouldRejectTaskIdReuse({
        tool,
        sessionKind: 'primary',
        args: { identifier: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2' },
      })).toEqual({ reject: false });
    }
  });

  it('does not reject non-primary or untracked sessions', () => {
    for (const sessionKind of ['task-worker', 'subagent', 'unknown', undefined] as const) {
      expect(shouldRejectTaskIdReuse({
        tool: 'task',
        sessionKind,
        args: { task_id: 'task_resume_me', description: 'x', prompt: 'y' },
      })).toEqual({ reject: false });
    }
  });

  it('does not reject blank task_id values', () => {
    expect(shouldRejectTaskIdReuse({
      tool: 'task',
      sessionKind: 'primary',
      args: { task_id: '   ', description: 'x', prompt: 'y' },
    })).toEqual({ reject: false });
  });
});
