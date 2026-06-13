import { describe, expect, it } from 'bun:test';
import {
  createTaskLifecycleHook,
  parseTaskLifecycleEvent,
  parseTaskLaunchOutput,
  parseTaskStatusOutput,
  type ParsedTaskLifecycleEvent,
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

  it('extracts the task id from OpenCode task XML output', () => {
    const parsed = parseTaskLaunchOutput(`<task id="ses_141cedfabffengXkzcL0HvknGn" state="running">
<summary>Background task started</summary>
<task_result>
The task is working in the background.
</task_result>
</task>`);

    expect(parsed).toEqual({
      task_id: 'ses_141cedfabffengXkzcL0HvknGn',
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

  it('extracts lifecycle context from post-tool task payloads', () => {
    const parsed = parseTaskLifecycleEvent({
      tool: 'task',
      args: { description: 'Run worker', background: true, subagent_type: 'scout-researcher' },
      sessionID: 'sess_parent',
      messageID: 'msg_parent',
      agent: 'hive',
      callID: 'call_task_1',
    }, {
      title: 'task',
      output: 'task_id: task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
    });

    expect(parsed).toEqual({
      tool: 'task',
      taskId: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
      args: {
        background: true,
        description: 'Run worker',
        subagent_type: 'scout-researcher',
      },
      parentSessionId: 'sess_parent',
      messageId: 'msg_parent',
      agentName: 'hive',
      callId: 'call_task_1',
    });
  });

  it('extracts lifecycle context from post-tool task_status payloads', () => {
    const parsed = parseTaskLifecycleEvent({
      tool: 'task_status',
      args: { task_id: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2' },
      sessionID: 'sess_parent',
      agent: 'hive',
      callID: 'call_status_1',
    }, {
      title: 'task_status',
      output: '{"task_id":"task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2","status":"completed","result":"done"}',
    });

    expect(parsed).toEqual({
      tool: 'task_status',
      taskId: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
      args: {
        task_id: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
      },
      parentSessionId: 'sess_parent',
      agentName: 'hive',
      callId: 'call_status_1',
      status: {
        task_id: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
        runtimeState: 'completed',
        result: 'done',
      },
    });
  });

  it('routes parsed lifecycle events to a hook handler with captured args', async () => {
    const observed: ParsedTaskLifecycleEvent[] = [];
    const capturedArgs = new Map<string, Record<string, unknown>>();
    const hook = createTaskLifecycleHook((event) => {
      observed.push(event);
    }, (input) => {
      const record = input as { sessionID: string; callID: string };
      return {
        args: capturedArgs.get(`${record.sessionID}:${record.callID}`),
        agentName: 'hive',
      };
    });

    capturedArgs.set('sess_parent:call_task_1', { description: 'Run worker', background: true, subagent_type: 'scout-researcher' });
    await hook({
      tool: 'task',
      sessionID: 'sess_parent',
      callID: 'call_task_1',
    }, {
      output: 'task_id: task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      tool: 'task',
      taskId: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
      args: {
        background: true,
        description: 'Run worker',
        subagent_type: 'scout-researcher',
      },
      parentSessionId: 'sess_parent',
      agentName: 'hive',
      callId: 'call_task_1',
    });
  });
});
