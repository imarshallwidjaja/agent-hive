import { describe, expect, it } from 'bun:test';
import {
  parseTaskLaunchOutput,
  parseTaskStatusOutput,
} from './taskOutput.js';

describe('background task output parsing', () => {
  it('extracts the task id from native background task launch output', () => {
    const parsed = parseTaskLaunchOutput(`Task started in background.

task_id: task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2

Use task_status with this task_id to check progress.`);

    expect(parsed).toEqual({
      task_id: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
    });
  });

  it('returns undefined for unknown launch output without throwing', () => {
    expect(parseTaskLaunchOutput('worker launched successfully')).toBeUndefined();
    expect(parseTaskLaunchOutput('{not json')).toBeUndefined();
  });

  it('extracts task status state, timeout, result, and terminal errors from native status output', () => {
    const parsed = parseTaskStatusOutput(JSON.stringify({
      task_id: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
      status: 'completed',
      timed_out: false,
      result: 'Implemented the parser.',
      error: 'Worker reported failed status.',
    }));

    expect(parsed).toEqual({
      task_id: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
      runtimeState: 'completed',
      timedOut: false,
      result: 'Implemented the parser.',
      error: {
        kind: 'terminal',
        message: 'Worker reported failed status.',
      },
    });
  });

  it('classifies process-local task_status misses as transient errors', () => {
    const parsed = parseTaskStatusOutput(`Task not found in this process.

task_id: task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2`);

    expect(parsed).toEqual({
      task_id: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
      error: {
        kind: 'transient',
        message: 'Task not found in this process.',
      },
    });
  });

  it('returns undefined for malformed status output without throwing', () => {
    expect(parseTaskStatusOutput('status unavailable')).toBeUndefined();
    expect(parseTaskStatusOutput('{"task_id":')).toBeUndefined();
  });
});
