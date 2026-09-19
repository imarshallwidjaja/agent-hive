import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk';
import plugin from '../index.js';
import type { BackgroundJobsJson } from 'hive-core';
import { createPluginWithHome } from '../e2e/plugin-test-home.js';

const OPENCODE_CLIENT = createOpencodeClient({ baseUrl: 'http://localhost:1' }) as unknown as PluginInput['client'];
(OPENCODE_CLIENT.session as any).update = async () => ({ data: {} });
(OPENCODE_CLIENT.session as unknown as { get: (input: { path: { id: string } }) => Promise<unknown> }).get = async (input) => ({
  data: {
    id: input.path.id,
    projectID: 'test',
    directory: '/tmp',
    title: 'Primary test session',
    version: '1',
    time: { created: 1, updated: 1 },
  },
});

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
  it('captures task args before execution and persists post-tool lifecycle events', async () => {
    const testRoot = `/tmp/hive-background-hook-test-${process.pid}`;
    const home = fs.mkdtempSync(`/tmp/hive-background-hook-home-${process.pid}-`);
    const originalBackgroundEnv = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';

    try {
      const hooks = await createPluginWithHome(home, () => plugin({
        directory: testRoot,
        worktree: testRoot,
        serverUrl: new URL('http://localhost:1'),
        project: {
          id: 'test',
          worktree: testRoot,
          time: { created: Date.now() },
        },
        client: OPENCODE_CLIENT,
        $: createStubShell(),
      }));

      expect(hooks['tool.execute.after']).toBeDefined();

      await hooks['chat.message']?.(
        { sessionID: 'sess_parent', agent: 'hive-master' } as never,
        { message: {}, parts: [] } as never,
      );
      await hooks['tool.execute.before']?.(
        { tool: 'task', sessionID: 'sess_parent', callID: 'call_task_1' } as never,
        { args: { description: 'Run worker', background: true, subagent_type: 'scout-researcher' } } as never,
      );
      await hooks['tool.execute.after']?.(
        { tool: 'task', sessionID: 'sess_parent', callID: 'call_task_1' } as never,
        { title: 'task', output: 'task_id: task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2', metadata: {} } as never,
      );

      let board = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'background-jobs.json'), 'utf-8')) as BackgroundJobsJson;
      expect(board.jobs[0]).toMatchObject({
        taskId: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
        agentName: 'scout-researcher',
        description: 'Run worker',
        runtimeState: 'running',
        scope: {
          projectRoot: testRoot,
          parentSessionId: 'sess_parent',
          primaryAgent: 'hive-master',
        },
      });

      await hooks['tool.execute.before']?.(
        { tool: 'task_status', sessionID: 'sess_parent', callID: 'call_status_1' } as never,
        { args: { task_id: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2' } } as never,
      );
      await hooks['tool.execute.after']?.(
        { tool: 'task_status', sessionID: 'sess_parent', callID: 'call_status_1' } as never,
        { title: 'task_status', output: '{"task_id":"task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2","status":"completed","result":"done"}', metadata: {} } as never,
      );

      board = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'background-jobs.json'), 'utf-8')) as BackgroundJobsJson;
      expect(board.jobs[0]).toMatchObject({
        taskId: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
        runtimeState: 'completed',
        resultSummary: 'done',
        terminalUnreconciled: true,
      });

      await hooks['tool.execute.before']?.(
        { tool: 'task', sessionID: 'sess_parent', callID: 'call_foreground' } as never,
        { args: { description: 'Run foreground research', background: false, subagent_type: 'scout-researcher' } } as never,
      );
      await hooks['tool.execute.after']?.(
        { tool: 'task', sessionID: 'sess_parent', callID: 'call_foreground' } as never,
        { title: 'task', output: 'task_id: task_foreground', metadata: {} } as never,
      );

      board = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'background-jobs.json'), 'utf-8')) as BackgroundJobsJson;
      expect(board.jobs.map((job) => job.taskId)).not.toContain('task_foreground');

      const abortCalls: unknown[] = [];
      const cancelHooks = await createPluginWithHome(home, () => plugin({
        directory: testRoot,
        worktree: testRoot,
        serverUrl: new URL('http://localhost:1'),
        project: {
          id: 'test',
          worktree: testRoot,
          time: { created: Date.now() },
        },
        client: {
          session: {
            abort: async (options: unknown) => {
              abortCalls.push(options);
              return { data: true, error: undefined };
            },
          },
        } as unknown as PluginInput['client'],
        $: createStubShell(),
      }));

      const cancelRaw = await cancelHooks.tool!.hive_background_cancel.execute(
        { identifier: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2', reason: 'No longer needed' },
        { sessionID: 'sess_parent', messageID: 'msg_cancel', agent: 'hive-master', abort: new AbortController().signal },
      );
      const cancelResult = JSON.parse(cancelRaw as string) as { success: boolean; reason: string };
      expect(cancelResult).toMatchObject({ success: false, reason: 'job_terminal' });
      expect(abortCalls).toEqual([]);
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
      if (originalBackgroundEnv === undefined) {
        delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      } else {
        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = originalBackgroundEnv;
      }
    }
  });

  it('passes through task_id as a native capability for explicit interruption recovery', async () => {
    const testRoot = `/tmp/hive-task-id-recovery-${process.pid}`;
    const home = fs.mkdtempSync(`/tmp/hive-task-id-recovery-home-${process.pid}-`);
    const originalBackgroundEnv = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';

    try {
      const hooks = await createPluginWithHome(home, () => plugin({
        directory: testRoot,
        worktree: testRoot,
        serverUrl: new URL('http://localhost:1'),
        project: {
          id: 'test',
          worktree: testRoot,
          time: { created: Date.now() },
        },
        client: OPENCODE_CLIENT,
        $: createStubShell(),
      }));

      const opencodeConfig: Record<string, unknown> = {};
      await hooks.config?.(opencodeConfig as never);
      const defaultAgent = opencodeConfig.default_agent;
      expect(typeof defaultAgent).toBe('string');
      if (typeof defaultAgent !== 'string') throw new Error('default_agent was not configured');
      expect(['hive-master', 'architect-planner']).toContain(defaultAgent);

      await hooks['chat.message']?.(
        { sessionID: 'sess_primary_fresh' } as never,
        { message: { agent: defaultAgent }, parts: [] } as never,
      );

      const recovery = {
        args: {
          description: 'Recover interrupted worker',
          prompt: 'Operator explicitly authorized interruption recovery',
          subagent_type: 'forager-worker',
          task_id: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2',
          background: true,
        },
      };
      await hooks['tool.execute.before']?.(
        { tool: 'task', sessionID: 'sess_primary_fresh', callID: 'call_recovery' } as never,
        recovery as never,
      );
      expect(recovery.args.task_id).toBe('task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2');
      expect(recovery.args.prompt).toContain('Operator explicitly authorized interruption recovery');
      expect(recovery.args.prompt).toContain('Hive route snapshot');
      expect(recovery.args.prompt.match(/## Hive route snapshot/g)).toHaveLength(1);

      expect(fs.existsSync(path.join(testRoot, '.hive', 'background-jobs.json'))).toBe(false);

      await hooks['tool.execute.before']?.(
        { tool: 'task_status', sessionID: 'sess_primary_fresh', callID: 'call_status_ok' } as never,
        { args: { task_id: 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2' } } as never,
      );

      const fresh = {
        args: {
          description: 'Hive: 01-first-task',
          prompt: 'Follow instructions in @worker-prompt.md',
          subagent_type: 'forager-worker',
        },
      };
      await hooks['tool.execute.before']?.(
        { tool: 'task', sessionID: 'sess_primary_fresh', callID: 'call_fresh' } as never,
        fresh as never,
      );
      expect(fresh.args.prompt).toContain('Follow instructions in @worker-prompt.md');
      expect(fresh.args.prompt).toContain('Hive route snapshot');
      expect(fresh.args.prompt.match(/## Hive route snapshot/g)).toHaveLength(1);
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
      if (originalBackgroundEnv === undefined) {
        delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      } else {
        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = originalBackgroundEnv;
      }
    }
  });
});
