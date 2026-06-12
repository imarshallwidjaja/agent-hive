import { describe, expect, it } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk';
import plugin from '../index.js';

const OPENCODE_CLIENT = createOpencodeClient({ baseUrl: 'http://localhost:1' }) as unknown as PluginInput['client'];

function createStubShell(): PluginInput['$'] {
  let shell: PluginInput['$'];

  const fn = ((..._args: unknown[]) => {
    throw new Error('shell not available in this test');
  }) as unknown as PluginInput['$'];

  shell = Object.assign(fn, {
    braces(pattern: string) {
      return [pattern];
    },
    escape(input: string) {
      return input;
    },
    env() {
      return shell;
    },
    cwd() {
      return shell;
    },
    nothrow() {
      return shell;
    },
    throws() {
      return shell;
    },
  });

  return shell;
}

describe('background task lifecycle hook support', () => {
  it('exposes a post-tool hook that can receive native task lifecycle context', async () => {
    const hooks = await plugin({
      directory: '/tmp/hive-background-hook-test',
      worktree: '/tmp/hive-background-hook-test',
      serverUrl: new URL('http://localhost:1'),
      project: {
        id: 'test',
        worktree: '/tmp/hive-background-hook-test',
        time: { created: Date.now() },
      },
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    });

    const input = {
      tool: 'task',
      args: { description: 'Run worker', background: true },
      sessionID: 'sess_parent',
      messageID: 'msg_parent',
      agent: 'hive',
      callID: 'call_task_1',
    };
    const output = {
      title: 'task',
      output: 'task_id: task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
    };

    expect(hooks['tool.execute.after']).toBeDefined();
    await hooks['tool.execute.after']?.(input as never, output as never);
    expect(input.tool).toBe('task');
    expect(input.args.background).toBe(true);
    expect(input.sessionID).toBe('sess_parent');
    expect(input.agent).toBe('hive');
    expect(input.callID).toBe('call_task_1');
    expect(output.output).toContain('task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2');

    const statusInput = {
      tool: 'task_status',
      args: { task_id: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2' },
      sessionID: 'sess_parent',
      agent: 'hive',
      callID: 'call_status_1',
    };
    const statusOutput = {
      title: 'task_status',
      output: '{"task_id":"task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2","status":"completed","result":"done"}',
    };

    await hooks['tool.execute.after']?.(statusInput as never, statusOutput as never);
    expect(statusInput.tool).toBe('task_status');
    expect(statusInput.args.task_id).toBe('task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2');
    expect(statusOutput.output).toContain('completed');
  });
});
