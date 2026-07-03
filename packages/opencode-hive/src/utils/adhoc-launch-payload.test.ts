import { describe, expect, it } from 'bun:test';
import { buildAdhocWorkerLaunchPayloads } from './adhoc-launch-payload.js';

describe('buildAdhocWorkerLaunchPayloads', () => {
  const base = {
    subagent_type: 'forager-worker',
    description: 'Ad-hoc: run-1',
    prompt: 'do work',
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
  });

  it('returns blocking taskToolCall only when background is disabled', () => {
    const result = buildAdhocWorkerLaunchPayloads({
      ...base,
      backgroundEnabled: false,
      shouldAutoSpawnWorker: true,
    });
    expect(result.launchMode).toBe('blocking_task_call');
    expect(result.taskToolCall).toEqual(base);
    expect(result.backgroundTaskCall).toBeUndefined();
  });

  it('returns matching taskToolCall and backgroundTaskCall when background is enabled', () => {
    const result = buildAdhocWorkerLaunchPayloads({
      ...base,
      backgroundEnabled: true,
      shouldAutoSpawnWorker: true,
    });
    expect(result.launchMode).toBe('blocking_task_call');
    expect(result.taskToolCall).toEqual(base);
    expect(result.backgroundTaskCall).toEqual({ ...base, background: true });
  });
});