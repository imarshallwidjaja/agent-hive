import { describe, expect, it } from 'bun:test';
import { buildAdhocWorkerLaunchPayloads } from './adhoc-launch-payload.js';
import { HIVE_SESSION_POLICY } from './session-policy.js';

describe('buildAdhocWorkerLaunchPayloads', () => {
  const base = {
    subagent_type: 'forager-worker',
    description: 'Ad-hoc: run-1',
    prompt: 'do work',
    launchId: 'launch-1',
  };

  it('returns suppressed when autoSpawnWorker is false', () => {
    const result = buildAdhocWorkerLaunchPayloads({
      ...base,
      backgroundEnabled: true,
      shouldAutoSpawnWorker: false,
    });
    expect(result.launchMode).toBe('suppressed');
    expect(result.taskToolCall).toBeUndefined();
    expect(result.backgroundTaskCall).toBeUndefined();
    expect(result.sessionPolicy).toBeUndefined();
  });

  it('returns blocking taskToolCall only when background is disabled', () => {
    const result = buildAdhocWorkerLaunchPayloads({
      ...base,
      backgroundEnabled: false,
      shouldAutoSpawnWorker: true,
    });
    expect(result.launchMode).toBe('blocking_task_call');
    expect(result.taskToolCall).toEqual({
      subagent_type: base.subagent_type,
      description: base.description,
      prompt: base.prompt,
      hive_launch_id: base.launchId,
    });
    expect(result.backgroundTaskCall).toBeUndefined();
    expect(result.sessionPolicy).toEqual(HIVE_SESSION_POLICY);
    expect(result.taskToolCall).not.toHaveProperty('task_id');
  });

  it('returns matching taskToolCall and backgroundTaskCall when background is enabled', () => {
    const result = buildAdhocWorkerLaunchPayloads({
      ...base,
      backgroundEnabled: true,
      shouldAutoSpawnWorker: true,
    });
    expect(result.launchMode).toBe('blocking_task_call');
    const taskToolCall = {
      subagent_type: base.subagent_type,
      description: base.description,
      prompt: base.prompt,
      hive_launch_id: base.launchId,
    };
    expect(result.taskToolCall).toEqual(taskToolCall);
    expect(result.backgroundTaskCall).toEqual({ ...taskToolCall, background: true });
    expect(result.sessionPolicy).toEqual(HIVE_SESSION_POLICY);
    expect(result.taskToolCall).not.toHaveProperty('task_id');
    expect(result.backgroundTaskCall).not.toHaveProperty('task_id');
  });
});
