import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { BackgroundJobService } from 'hive-core';
import type { BackgroundJobsJson } from 'hive-core';
import { createBackgroundTools } from './backgroundTools.js';

const TEST_DIR = '/tmp/hive-opencode-background-tools-test-' + process.pid;
const BOARD_PATH = path.join(TEST_DIR, '.hive', 'background-jobs.json');

type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  abort: AbortSignal;
};

function cleanup(): void {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

function readBoard(): BackgroundJobsJson {
  return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf-8')) as BackgroundJobsJson;
}

function parseToolJson<T>(raw: unknown): T {
  return JSON.parse(raw as string) as T;
}

function createToolContext(sessionID = 'parent-1', agent = 'hive-master'): ToolContext {
  return {
    sessionID,
    messageID: 'msg_test',
    agent,
    abort: new AbortController().signal,
  };
}

function registerScopedJob(
  service: BackgroundJobService,
  input: {
    taskId: string;
    sessionId: string;
    parentSessionId?: string;
    primaryAgent?: string;
    feature?: string;
    task?: string;
  },
) {
  return service.registerLaunch({
    taskId: input.taskId,
    sessionId: input.sessionId,
    agentName: 'forager-worker',
    description: `Background job ${input.taskId}`,
    scope: {
      projectRoot: TEST_DIR,
      parentSessionId: input.parentSessionId ?? 'parent-1',
      primaryAgent: input.primaryAgent ?? 'hive-master',
      feature: input.feature ?? 'feature-a',
      task: input.task ?? '01-task',
    },
    ownership: {
      worktreePath: path.join(TEST_DIR, '.hive', '.worktrees', 'feature-a', '01-task'),
      branch: 'hive/feature-a/01-task',
      workerPromptPath: '.hive/features/feature-a/tasks/01-task/worker-prompt.md',
      files: ['packages/opencode-hive/src/background/backgroundTools.ts'],
      repoIds: ['root'],
    },
  });
}

describe('background management tools', () => {
  let service: BackgroundJobService;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    service = new BackgroundJobService(TEST_DIR);
  });

  afterEach(() => {
    cleanup();
  });

  it('hive_background_status returns scoped jobs with runtime state separate from coordination metadata', async () => {
    const visible = registerScopedJob(service, { taskId: 'visible-task', sessionId: 'visible-session' });
    service.markTerminal('visible-task', 'completed', { resultSummary: 'worker finished' });
    registerScopedJob(service, { taskId: 'other-parent-task', sessionId: 'other-parent-session', parentSessionId: 'parent-2' });
    registerScopedJob(service, { taskId: 'stale-task', sessionId: 'stale-session' });
    service.markStale('stale-task');

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const rawDefault = await tools.hive_background_status.execute({}, createToolContext());
    const defaultResult = parseToolJson<{
      success?: boolean;
      jobs?: Array<{
        taskId: string;
        alias: string;
        runtime: { state: string; resultSummary?: string };
        coordination: { terminalUnreconciled?: boolean; staleAt?: string };
      }>;
    }>(rawDefault);

    expect(defaultResult.success).toBe(true);
    expect(defaultResult.jobs?.map(job => job.taskId)).toEqual(['visible-task']);
    expect(defaultResult.jobs?.[0]).toMatchObject({
      taskId: 'visible-task',
      alias: visible.alias,
      runtime: { state: 'completed', resultSummary: 'worker finished' },
      coordination: { terminalUnreconciled: true },
    });
    expect(defaultResult.jobs?.[0].coordination.staleAt).toBeUndefined();

    const rawWithStale = await tools.hive_background_status.execute({ includeStale: true }, createToolContext());
    const staleResult = parseToolJson<{ jobs?: Array<{ taskId: string }> }>(rawWithStale);
    expect(staleResult.jobs?.map(job => job.taskId)).toEqual(['visible-task', 'stale-task']);
  });

  it('hive_background_status nudges agents to poll native task_status for running jobs', async () => {
    registerScopedJob(service, { taskId: 'running-task', sessionId: 'running-session' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{
      jobs?: Array<{ taskId: string }>;
      nextActions?: Array<{ reason: string; taskId?: string; command?: string }>;
    }>(await tools.hive_background_status.execute({}, createToolContext()));

    expect(result.jobs?.map(job => job.taskId)).toEqual(['running-task']);
    expect(result.nextActions).toContainEqual(expect.objectContaining({
      reason: 'runtime_status_required',
      taskId: 'running-task',
      command: 'task_status({ task_id: "running-task" })',
    }));
  });

  it('hive_background_status surfaces pending launches instead of silently returning an empty board', async () => {
    service.registerPendingLaunch({
      parentSessionId: 'parent-1',
      expectedPrompt: 'Work in @/tmp/worktree',
      agentName: 'unknown',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', primaryAgent: 'hive-master', adHocRunId: 'adhoc-1' },
      ownership: { worktreePath: path.join(TEST_DIR, '.hive', '.worktrees', 'adhoc', 'adhoc-1'), branch: 'hive/adhoc/adhoc-1' },
    });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{
      jobs?: unknown[];
      pendingLaunches?: Array<{ expectedPrompt?: string; scope?: { adHocRunId?: string }; ownership?: { branch?: string } }>;
      nextActions?: Array<{ reason: string; command?: string; message?: string }>;
    }>(await tools.hive_background_status.execute({}, createToolContext()));

    expect(result.jobs).toEqual([]);
    expect(result.pendingLaunches).toEqual([expect.objectContaining({
      expectedPrompt: 'Work in @/tmp/worktree',
      scope: expect.objectContaining({ adHocRunId: 'adhoc-1' }),
      ownership: expect.objectContaining({ branch: 'hive/adhoc/adhoc-1' }),
    })]);
    expect(result.nextActions).toContainEqual(expect.objectContaining({
      reason: 'pending_launch_without_registered_job',
      command: 'launch or verify the native task({ background: true, ... }) call, then call hive_background_status again',
    }));
  });

  it('hive_background_reconcile reconciles or ignores terminal jobs without changing runtime result', async () => {
    registerScopedJob(service, { taskId: 'completed-task', sessionId: 'completed-session' });
    service.markTerminal('completed-task', 'completed', { resultSummary: 'runtime result stays' });
    registerScopedJob(service, { taskId: 'errored-task', sessionId: 'errored-session' });
    service.markTerminal('errored-task', 'error', { resultSummary: 'runtime failed' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const reconciledRaw = await tools.hive_background_reconcile.execute(
      { identifier: 'completed-task', decision: 'reconciled', summary: 'Task report was reviewed.' },
      createToolContext(),
    );
    const reconciled = parseToolJson<{ success?: boolean; job?: { runtime: { state: string; resultSummary?: string }; coordination: { terminalUnreconciled?: boolean; reconciliationSummary?: string } } }>(reconciledRaw);
    expect(reconciled.success).toBe(true);
    expect(reconciled.job?.runtime).toMatchObject({ state: 'completed', resultSummary: 'runtime result stays' });
    expect(reconciled.job?.coordination).toMatchObject({
      terminalUnreconciled: false,
      reconciliationSummary: 'Task report was reviewed.',
    });

    const ignoredRaw = await tools.hive_background_reconcile.execute(
      { identifier: 'errored-task', decision: 'ignored', summary: 'Known stale failure already handled.' },
      createToolContext(),
    );
    const ignored = parseToolJson<{ success?: boolean; job?: { runtime: { state: string; resultSummary?: string }; coordination: { ignoreReason?: string } } }>(ignoredRaw);
    expect(ignored.success).toBe(true);
    expect(ignored.job?.runtime).toMatchObject({ state: 'error', resultSummary: 'runtime failed' });
    expect(ignored.job?.coordination.ignoreReason).toBe('Known stale failure already handled.');
  });

  it('hive_background_reconcile rejects non-terminal and incomplete reconciliation requests', async () => {
    registerScopedJob(service, { taskId: 'running-task', sessionId: 'running-session' });
    registerScopedJob(service, { taskId: 'other-parent-task', sessionId: 'other-parent-session', parentSessionId: 'parent-2' });
    service.markTerminal('other-parent-task', 'completed', { resultSummary: 'not visible' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const missingSummary = parseToolJson<{ success?: boolean; reason?: string }>(await tools.hive_background_reconcile.execute(
      { identifier: 'running-task', decision: 'reconciled', summary: '' },
      createToolContext(),
    ));
    expect(missingSummary).toMatchObject({ success: false, reason: 'summary_required' });

    const nonTerminal = parseToolJson<{ success?: boolean; reason?: string; nextAction?: { reason?: string; command?: string } }>(await tools.hive_background_reconcile.execute(
      { identifier: 'running-task', decision: 'ignored', summary: 'Not done yet.' },
      createToolContext(),
    ));
    expect(nonTerminal).toMatchObject({ success: false, reason: 'job_not_terminal' });
    expect(nonTerminal.nextAction).toEqual(expect.objectContaining({
      reason: 'runtime_status_required',
      command: 'task_status({ task_id: "running-task" })',
    }));
    expect(service.resolve('running-task')?.runtimeState).toBe('running');
  });

  it('hive_background_cancel validates scope before runtime cancellation and records runtime cancelled only after confirmation', async () => {
    const scoped = registerScopedJob(service, { taskId: 'cancel-task', sessionId: 'cancel-session' });
    registerScopedJob(service, { taskId: 'other-parent-task', sessionId: 'other-parent-session', parentSessionId: 'parent-2' });
    const cancelAttempts: string[] = [];
    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
      cancelRuntimeTask: async (taskId: string) => {
        cancelAttempts.push(taskId);
        return { cancelled: taskId === 'cancel-task', message: 'runtime acknowledged cancellation' };
      },
    });

    const rejected = parseToolJson<{ success?: boolean; reason?: string }>(await tools.hive_background_cancel.execute(
      { identifier: 'other-parent-task', reason: 'wrong scope' },
      createToolContext(),
    ));
    expect(rejected).toMatchObject({ success: false, reason: 'job_not_in_scope' });
    expect(cancelAttempts).toEqual([]);
    expect(service.resolve('other-parent-task')?.cancelRequestedAt).toBeUndefined();

    const accepted = parseToolJson<{ success?: boolean; runtimeCancelled?: boolean; job?: { taskId: string; runtime: { state: string; resultSummary?: string }; coordination: { cancelReason?: string; cancelRequestedAt?: string } } }>(await tools.hive_background_cancel.execute(
      { identifier: scoped.alias, reason: 'operator stopped stale work' },
      createToolContext(),
    ));
    expect(accepted.success).toBe(true);
    expect(accepted.runtimeCancelled).toBe(true);
    expect(cancelAttempts).toEqual(['cancel-task']);
    expect(accepted.job).toMatchObject({
      taskId: 'cancel-task',
      runtime: { state: 'cancelled', resultSummary: 'runtime acknowledged cancellation' },
      coordination: { cancelReason: 'operator stopped stale work' },
    });
    expect(accepted.job?.coordination.cancelRequestedAt).toBeDefined();
    expect(service.resolve('cancel-task')?.ownership?.worktreePath).toContain('.hive/.worktrees/feature-a/01-task');
  });

  it('hive_background_cancel keeps runtime running when cancellation is not confirmed', async () => {
    registerScopedJob(service, { taskId: 'slow-task', sessionId: 'slow-session' });
    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
      cancelRuntimeTask: async () => ({ cancelled: false, message: 'runtime still running' }),
    });

    const result = parseToolJson<{ success?: boolean; runtimeCancelled?: boolean; runtimeMessage?: string; job?: { runtime: { state: string }; coordination: { cancelReason?: string } } }>(await tools.hive_background_cancel.execute(
      { identifier: 'slow-task', reason: 'cancel requested' },
      createToolContext(),
    ));

    expect(result.success).toBe(true);
    expect(result.runtimeCancelled).toBe(false);
    expect(result.runtimeMessage).toBe('runtime still running');
    expect(result.job?.runtime.state).toBe('running');
    expect(result.job?.coordination.cancelReason).toBe('cancel requested');
  });

  it('background tools are inert and do not mutate the board when the experiment is disabled', async () => {
    registerScopedJob(service, { taskId: 'disabled-task', sessionId: 'disabled-session' });
    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => false,
      cancelRuntimeTask: async () => {
        throw new Error('must not cancel when disabled');
      },
    });

    const result = parseToolJson<{ success?: boolean; reason?: string }>(await tools.hive_background_cancel.execute(
      { identifier: 'disabled-task', reason: 'disabled cancel' },
      createToolContext(),
    ));

    expect(result).toMatchObject({ success: false, reason: 'background_tools_disabled' });
    expect(readBoard().jobs[0]).toMatchObject({
      taskId: 'disabled-task',
      runtimeState: 'running',
    });
    expect(readBoard().jobs[0].cancelRequestedAt).toBeUndefined();
  });
});
