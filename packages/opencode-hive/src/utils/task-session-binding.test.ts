import { describe, expect, it } from 'bun:test';
import {
  classifyTaskToolLaunch,
  consumeTaskToolLaunch,
  extractTaskToolChildSessionId,
  recordTaskToolLaunch,
  normalizeHiveFeatureName,
  type TaskToolLaunchState,
} from './task-session-binding.js';

describe('task session binding helpers', () => {
  it('classifies worker-prompt launches as Hive task-worker handoffs', () => {
    const state = classifyTaskToolLaunch({
      sessionID: 'sess-parent',
      args: {
        subagent_type: 'forager-worker',
        description: 'Hive: 01-task',
        prompt: 'Follow instructions in @.hive/features/demo/tasks/01-task/worker-prompt.md',
      },
    });

    expect(state).toBeDefined();
    expect(state!).toMatchObject({
      kind: 'task-worker',
      parentSessionId: 'sess-parent',
      taskFolder: '01-task',
      delegatedAgent: 'forager-worker',
      workerPromptPath: '.hive/features/demo/tasks/01-task/worker-prompt.md',
    });
  });

  it('classifies other Hive task() launches as general subagent launches', () => {
    const state = classifyTaskToolLaunch({
      sessionID: 'sess-parent',
      args: {
        subagent_type: 'scout-researcher',
        description: 'Research runtime mismatch',
        prompt: 'Inspect the runtime mismatch and report back.',
      },
    });

    expect(state).toBeDefined();
    expect(state!).toMatchObject({
      kind: 'subagent',
      parentSessionId: 'sess-parent',
      delegatedAgent: 'scout-researcher',
    });
    expect(state!.taskFolder).toBeUndefined();
    expect(state!.workerPromptPath).toBeUndefined();
  });

  it('extracts child session id from structured task metadata only', () => {
    expect(extractTaskToolChildSessionId({ metadata: { sessionId: 'ses-child-123' } })).toBe('ses-child-123');
    expect(extractTaskToolChildSessionId({ output: '<task_metadata>session_id: ses-free-text</task_metadata>' })).toBeUndefined();
  });

  it('keeps unrelated pending launches when a non-task tool call interleaves', () => {
    const prior: Record<string, TaskToolLaunchState> = {
      'sess-parent:call-1': {
        parentSessionId: 'sess-parent',
        delegatedAgent: 'forager-worker',
        kind: 'task-worker',
        featureName: 'demo-feature',
        taskFolder: '01-task',
        workerPromptPath: '.hive/features/demo-feature/tasks/01-task/worker-prompt.md',
        source: 'opencode-task-tool',
      },
    };

    const next = recordTaskToolLaunch({
      pending: prior,
      sessionID: 'sess-parent',
      callID: 'call-bash',
      tool: 'bash',
      args: { command: 'pwd' } as any,
    });

    expect(next).toEqual(prior);
  });

  it('stores and consumes concurrent launches by sessionID and callID', () => {
    const pending0: Record<string, TaskToolLaunchState> = {};
    const pending1 = recordTaskToolLaunch({
      pending: pending0,
      sessionID: 'sess-parent-a',
      callID: 'call-1',
      tool: 'task',
      args: {
        subagent_type: 'forager-worker',
        description: 'Hive: 01-task',
        prompt: 'Follow instructions in @.hive/features/demo-a/tasks/01-task/worker-prompt.md',
      },
    });
    const pending2 = recordTaskToolLaunch({
      pending: pending1,
      sessionID: 'sess-parent-b',
      callID: 'call-2',
      tool: 'task',
      args: {
        subagent_type: 'scout-researcher',
        description: 'Research runtime mismatch',
        prompt: 'Inspect the runtime mismatch and report back.',
      },
    });

    expect(Object.keys(pending2).sort()).toEqual(['sess-parent-a:call-1', 'sess-parent-b:call-2']);

    const consumedA = consumeTaskToolLaunch({
      pending: pending2,
      sessionID: 'sess-parent-a',
      callID: 'call-1',
      tool: 'task',
    });
    expect(consumedA.launch?.parentSessionId).toBe('sess-parent-a');
    expect(consumedA.launch?.kind).toBe('task-worker');
    expect(Object.keys(consumedA.pending)).toEqual(['sess-parent-b:call-2']);

    const consumedB = consumeTaskToolLaunch({
      pending: consumedA.pending,
      sessionID: 'sess-parent-b',
      callID: 'call-2',
      tool: 'task',
    });
    expect(consumedB.launch?.parentSessionId).toBe('sess-parent-b');
    expect(consumedB.launch?.kind).toBe('subagent');
    expect(consumedB.pending).toEqual({});
  });

  it('returns undefined when consuming a different task call than the one recorded', () => {
    const prior: TaskToolLaunchState = {
      parentSessionId: 'sess-parent',
      delegatedAgent: 'forager-worker',
      kind: 'task-worker',
      featureName: 'demo-feature',
      taskFolder: '01-task',
      workerPromptPath: '.hive/features/demo-feature/tasks/01-task/worker-prompt.md',
      source: 'opencode-task-tool',
    };

    const consumed = consumeTaskToolLaunch({
      pending: { 'sess-parent:call-1': prior },
      sessionID: 'sess-parent',
      callID: 'call-2',
      tool: 'task',
    });

    expect(consumed.launch).toBeUndefined();
    expect(consumed.pending).toEqual({ 'sess-parent:call-1': prior });
  });

  it('normalizes indexed feature directory names back to logical feature names', () => {
    expect(normalizeHiveFeatureName('01-demo-feature')).toBe('demo-feature');
    expect(normalizeHiveFeatureName('demo-feature')).toBe('demo-feature');
  });
});
