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

function registerUnscopedJob(
  service: BackgroundJobService,
  input: {
    taskId: string;
    sessionId: string;
    parentSessionId?: string;
    primaryAgent?: string;
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
    },
    ownership: {
      worktreePath: path.join(TEST_DIR, '.hive', '.worktrees', 'unscoped', input.taskId),
      branch: `hive/unscoped/${input.taskId}`,
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
    service.markPromptNotified(['visible-task'], 'parent-1');
    service.markPromptAcknowledgedForSession('parent-1');
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
        coordination: { terminalUnreconciled?: boolean; staleAt?: string; promptAcknowledgedAt?: string; promptBoardInjectionCount?: number };
      }>;
      recommendedNextAction?: { action: string; reasonCode: string; taskId?: string; taskIds?: string[]; requiresHiveStatusRefresh: boolean };
      requiresHiveStatusRefresh?: boolean;
      orchestrationBurden?: { visibleLanes: number; actionableLanes: number; pendingLaunches: number; completionNotificationsPending: number; reconcileItemsRequired: number; recommendedReconcileToolCalls: number };
    }>(rawDefault);

    expect(defaultResult.success).toBe(true);
    expect(defaultResult.jobs?.map(job => job.taskId)).toEqual(['visible-task', 'stale-task']);
    expect(defaultResult.jobs?.[0]).toMatchObject({
      taskId: 'visible-task',
      alias: visible.alias,
      runtime: { state: 'completed', resultSummary: 'worker finished' },
      coordination: { terminalUnreconciled: true },
    });
    expect(defaultResult.jobs?.[0].coordination.promptAcknowledgedAt).toBeDefined();
    expect(defaultResult.jobs?.[0].coordination.promptBoardInjectionCount).toBe(1);
    expect(defaultResult.jobs?.[0].coordination.staleAt).toBeUndefined();
    expect(defaultResult.jobs?.[1].coordination.staleAt).toBeDefined();
    expect(defaultResult.orchestrationBurden).toEqual({
      visibleLanes: 2,
      actionableLanes: 1,
      pendingLaunches: 0,
      completionNotificationsPending: 0,
      reconcileItemsRequired: 1,
      recommendedReconcileToolCalls: 1,
    });
    expect(defaultResult.recommendedNextAction).toMatchObject({
      action: 'recover_stale_background_jobs',
      reasonCode: 'stale_background_jobs_visible',
      taskIds: ['stale-task'],
      requiresHiveStatusRefresh: true,
    });
    expect(defaultResult.requiresHiveStatusRefresh).toBe(true);

  });

  it('hive_background_status recommends batch reconciliation for multiple terminal unreconciled jobs', async () => {
    registerScopedJob(service, { taskId: 'terminal-task-a', sessionId: 'terminal-session-a' });
    service.markTerminal('terminal-task-a', 'completed', { resultSummary: 'done a' });
    registerScopedJob(service, { taskId: 'terminal-task-b', sessionId: 'terminal-session-b' });
    service.markTerminal('terminal-task-b', 'error', { resultSummary: 'done b' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{
      recommendedNextAction?: { action: string; reasonCode: string; taskIds?: string[]; requiresHiveStatusRefresh: boolean };
      requiresHiveStatusRefresh?: boolean;
    }>(await tools.hive_background_status.execute({}, createToolContext()));

    expect(result.recommendedNextAction).toMatchObject({
      action: 'reconcile_terminal_jobs',
      reasonCode: 'terminal_unreconciled_jobs_visible',
      taskIds: ['terminal-task-a', 'terminal-task-b'],
      requiresHiveStatusRefresh: true,
    });
    expect(result.requiresHiveStatusRefresh).toBe(true);
    expect(JSON.stringify(result)).not.toContain('task_status');
  });

  it('hive_background_status prioritizes terminal reconciliation for stale terminal jobs', async () => {
    registerScopedJob(service, { taskId: 'terminal-stale-task', sessionId: 'terminal-stale-session' });
    service.markTerminal('terminal-stale-task', 'completed', { resultSummary: 'worker finished before stale classification' });
    service.markStale('terminal-stale-task');

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{
      jobs?: Array<{ taskId: string; runtime: { state: string }; coordination: { staleAt?: string; terminalUnreconciled?: boolean } }>;
      recommendedNextAction?: { action?: string; reasonCode?: string; taskId?: string };
    }>(await tools.hive_background_status.execute({}, createToolContext()));

    expect(result.jobs?.map(job => job.taskId)).toEqual(['terminal-stale-task']);
    expect(result.jobs?.[0]).toMatchObject({
      runtime: { state: 'completed' },
      coordination: { terminalUnreconciled: true },
    });
    expect(result.jobs?.[0].coordination.staleAt).toBeDefined();
    expect(result.recommendedNextAction).toMatchObject({
      action: 'reconcile_terminal_job',
      reasonCode: 'terminal_unreconciled_job_visible',
      taskId: 'terminal-stale-task',
    });
  });

  it('hive_background_status reports native completion waiting, reconciliation, and burden next actions', async () => {
    registerScopedJob(service, { taskId: 'running-task', sessionId: 'running-session' });
    registerScopedJob(service, { taskId: 'unknown-task', sessionId: 'unknown-session' });
    service.updateRuntimeState('unknown-task', 'unknown', { statusUncertain: true });
    registerScopedJob(service, { taskId: 'terminal-task', sessionId: 'terminal-session' });
    service.markTerminal('terminal-task', 'completed', { resultSummary: 'done' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{
      jobs?: Array<{ taskId: string }>;
      nextActions?: Array<{ reason: string; taskId?: string; precondition?: string; command?: string }>;
      recommendedNextAction?: { action: string; reasonCode: string; taskId?: string; taskIds?: string[]; requiresHiveStatusRefresh: boolean };
      waitingForNativeCompletion?: Array<{ reason: string; taskId?: string; command?: string }>;
      schedulerGuidance?: { reason: string; message: string };
      orchestrationBurden?: { visibleLanes: number; actionableLanes: number; pendingLaunches: number; completionNotificationsPending: number; reconcileItemsRequired: number; recommendedReconcileToolCalls: number };
    }>(await tools.hive_background_status.execute({}, createToolContext()));

    expect(result.jobs?.map(job => job.taskId)).toEqual(['running-task', 'unknown-task', 'terminal-task']);
    expect(result.waitingForNativeCompletion).toContainEqual(expect.objectContaining({
      reason: 'native_completion_pending',
      taskId: 'running-task',
    }));
    expect(result.waitingForNativeCompletion).toContainEqual(expect.objectContaining({
      reason: 'native_completion_pending',
      taskId: 'unknown-task',
    }));
    expect(result.waitingForNativeCompletion?.some(item => !!item.command)).toBe(false);
    expect(result.nextActions).toContainEqual(expect.objectContaining({
      reason: 'reconcile_required',
      taskId: 'terminal-task',
      precondition: 'Consume or intentionally ignore the terminal result before running this command.',
      command: 'hive_background_reconcile({ identifier: "terminal-task", decision: "reconciled", summary: "<what was done with the result>" })',
    }));
    expect(result.recommendedNextAction).toMatchObject({
      action: 'reconcile_terminal_job',
      reasonCode: 'terminal_unreconciled_job_visible',
      taskId: 'terminal-task',
      requiresHiveStatusRefresh: true,
    });
    expect(result.orchestrationBurden).toEqual({
      visibleLanes: 3,
      actionableLanes: 1,
      pendingLaunches: 0,
      completionNotificationsPending: 2,
      reconcileItemsRequired: 1,
      recommendedReconcileToolCalls: 1,
    });
    expect(JSON.stringify(result)).not.toContain('task_status');
  });

  it('hive_background_status tells schedulers to wait instead of refreshing wait-only lanes', async () => {
    registerScopedJob(service, { taskId: 'running-task', sessionId: 'running-session' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{
      nextActions?: Array<{ reason: string }>;
      recommendedNextAction?: { action: string; reasonCode: string; taskId?: string; requiresHiveStatusRefresh: boolean };
      requiresHiveStatusRefresh?: boolean;
      schedulerGuidance?: { reason: string; message: string };
      orchestrationBurden?: { actionableLanes: number; completionNotificationsPending: number; reconcileItemsRequired: number };
    }>(await tools.hive_background_status.execute({}, createToolContext()));

    expect(result.nextActions).toBeUndefined();
    expect(result.recommendedNextAction).toMatchObject({
      action: 'wait_for_native_completion',
      reasonCode: 'native_completion_wait_only',
      taskId: 'running-task',
      requiresHiveStatusRefresh: false,
    });
    expect(result.requiresHiveStatusRefresh).toBe(false);
    expect(result.orchestrationBurden).toMatchObject({
      actionableLanes: 0,
      completionNotificationsPending: 1,
      reconcileItemsRequired: 0,
    });
    expect(result.schedulerGuidance).toEqual({
      reason: 'wait_for_native_completion_notification',
      message: 'Do not call hive_background_status repeatedly while every visible lane is wait-only. Wait for OpenCode native completion notification, continue unrelated foreground work, or cancel only if the lane is stale, wrong, or no longer needed.',
    });
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
      recommendedNextAction?: { action: string; reasonCode: string; requiresHiveStatusRefresh: boolean };
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
    expect(result.recommendedNextAction).toMatchObject({
      action: 'verify_pending_launch',
      reasonCode: 'pending_launch_without_registered_job',
      requiresHiveStatusRefresh: false,
    });
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
    const reconciled = parseToolJson<{ success?: boolean; archive?: { archived: boolean; message: string }; recommendedNextAction?: { action: string; reasonCode: string; requiresHiveStatusRefresh: boolean }; job?: { runtime: { state: string; resultSummary?: string }; coordination: { terminalUnreconciled?: boolean; reconciliationSummary?: string; visibility?: string; actionRequired?: boolean; archivedAt?: string; archiveReason?: string } } }>(reconciledRaw);
    expect(reconciled.success).toBe(true);
    expect(reconciled.archive).toEqual({
      archived: true,
      message: 'The background job is archived and hidden from normal status output. Do not edit .hive/background-jobs.json directly.',
    });
    expect(reconciled.job?.runtime).toMatchObject({ state: 'completed', resultSummary: 'runtime result stays' });
    expect(reconciled.job?.coordination).toMatchObject({
      terminalUnreconciled: false,
      reconciliationSummary: 'Task report was reviewed.',
      visibility: 'archived_after_reconcile',
      actionRequired: false,
      archiveReason: 'reconciled',
    });
    expect(reconciled.recommendedNextAction).toMatchObject({
      action: 'reconcile_terminal_job',
      reasonCode: 'terminal_unreconciled_job_visible',
      taskId: 'errored-task',
      requiresHiveStatusRefresh: true,
    });
    expect(JSON.stringify(reconciled)).not.toContain('task_status');

    const statusAfterReconcile = parseToolJson<{ jobs?: Array<{ taskId: string }> }>(
      await tools.hive_background_status.execute({}, createToolContext()),
    );
    expect(statusAfterReconcile.jobs?.map(job => job.taskId)).toEqual(['errored-task']);

    const ignoredRaw = await tools.hive_background_reconcile.execute(
      { identifier: 'errored-task', decision: 'ignored', summary: 'Known stale failure already handled.' },
      createToolContext(),
    );
    const ignored = parseToolJson<{ success?: boolean; recommendedNextAction?: { action: string; reasonCode: string; requiresHiveStatusRefresh: boolean }; job?: { runtime: { state: string; resultSummary?: string }; coordination: { ignoreReason?: string; visibility?: string; archiveReason?: string } } }>(ignoredRaw);
    expect(ignored.success).toBe(true);
    expect(ignored.job?.runtime).toMatchObject({ state: 'error', resultSummary: 'runtime failed' });
    expect(ignored.job?.coordination).toMatchObject({
      ignoreReason: 'Known stale failure already handled.',
      visibility: 'ignored_archived',
      archiveReason: 'ignored',
    });
    expect(ignored.recommendedNextAction).toMatchObject({
      action: 'inspect_hive_status',
      reasonCode: 'reconciled_job_has_hive_scope',
      requiresHiveStatusRefresh: true,
    });

    const statusAfterIgnore = parseToolJson<{ jobs?: Array<{ taskId: string }>; recommendedNextAction?: { action: string; reasonCode: string; requiresHiveStatusRefresh: boolean }; requiresHiveStatusRefresh?: boolean }>(
      await tools.hive_background_status.execute({}, createToolContext()),
    );
    expect(statusAfterIgnore.jobs?.map(job => job.taskId)).toEqual([]);
    expect(statusAfterIgnore.recommendedNextAction).toMatchObject({
      action: 'idle',
      reasonCode: 'no_background_action_needed',
      requiresHiveStatusRefresh: false,
    });
    expect(statusAfterIgnore.requiresHiveStatusRefresh).toBe(false);
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
      reason: 'native_completion_pending',
    }));
    expect(nonTerminal.nextAction?.command).toBeUndefined();
    expect(service.resolve('running-task')?.runtimeState).toBe('running');
  });

  it('hive_background_reconcile allows stale non-terminal jobs to be ignored without changing runtime state', async () => {
    registerScopedJob(service, { taskId: 'stale-running-task', sessionId: 'stale-running-session' });
    service.markStale('stale-running-task');

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const ignored = parseToolJson<{
      success?: boolean;
      decision?: string;
      job?: { runtime: { state: string }; coordination: { archiveReason?: string; ignoreReason?: string; staleAt?: string; visibility?: string } };
    }>(await tools.hive_background_reconcile.execute(
      { identifier: 'stale-running-task', decision: 'ignored', summary: 'Native runtime died before completion.' },
      createToolContext(),
    ));

    expect(ignored).toMatchObject({ success: true, decision: 'ignored' });
    expect(ignored.job?.runtime.state).toBe('running');
    expect(ignored.job?.coordination).toMatchObject({
      archiveReason: 'ignored',
      ignoreReason: 'Native runtime died before completion.',
      visibility: 'ignored_archived',
    });
    expect(ignored.job?.coordination.staleAt).toBeDefined();
  });

  it('hive_background_reconcile rejects stale non-terminal reconcile with stale recovery guidance', async () => {
    registerScopedJob(service, { taskId: 'stale-reconcile-task', sessionId: 'stale-reconcile-session' });
    service.markStale('stale-reconcile-task');

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{ success?: boolean; reason?: string; nextAction?: { reason?: string; command?: string; message?: string } }>(
      await tools.hive_background_reconcile.execute(
        { identifier: 'stale-reconcile-task', decision: 'reconciled', summary: 'Trying to reconcile stale lane.' },
        createToolContext(),
      ),
    );

    expect(result).toMatchObject({ success: false, reason: 'stale_job_requires_ignore' });
    expect(result.nextAction).toMatchObject({
      reason: 'stale_recovery_pending',
      command: 'hive_background_reconcile({ identifier: "stale-reconcile-task", decision: "ignored", summary: "<why the stale lane was archived>" })',
    });
    expect(result.nextAction?.message).toContain('archive it with decision "ignored"');
    expect(result.nextAction?.message).not.toContain('native completion');
  });

  it('keeps unresolved stale jobs visible in default recommendations after ignoring one stale lane', async () => {
    registerScopedJob(service, { taskId: 'stale-task-a', sessionId: 'stale-session-a' });
    service.markStale('stale-task-a');
    registerScopedJob(service, { taskId: 'stale-task-b', sessionId: 'stale-session-b' });
    service.markStale('stale-task-b');

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const ignored = parseToolJson<{
      success?: boolean;
      recommendedNextAction?: { action?: string; reasonCode?: string; taskIds?: string[] };
    }>(await tools.hive_background_reconcile.execute(
      { identifier: 'stale-task-a', decision: 'ignored', summary: 'Archived stale lane A.' },
      createToolContext(),
    ));

    expect(ignored.success).toBe(true);
    expect(ignored.recommendedNextAction).toMatchObject({
      action: 'recover_stale_background_jobs',
      reasonCode: 'stale_background_jobs_visible',
      taskIds: ['stale-task-b'],
    });

    const status = parseToolJson<{ jobs?: Array<{ taskId: string }>; recommendedNextAction?: { action?: string; reasonCode?: string; taskIds?: string[] } }>(
      await tools.hive_background_status.execute({}, createToolContext()),
    );
    expect(status.jobs?.map(job => job.taskId)).toEqual(['stale-task-b']);
    expect(status.recommendedNextAction).toMatchObject({
      action: 'recover_stale_background_jobs',
      reasonCode: 'stale_background_jobs_visible',
      taskIds: ['stale-task-b'],
    });
  });

  it('includeArchived shows archived stale jobs', async () => {
    registerScopedJob(service, { taskId: 'archived-stale-task', sessionId: 'archived-stale-session' });
    service.markStale('archived-stale-task');
    service.markIgnored('archived-stale-task', 'Archived stale lane.');

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{ jobs?: Array<{ taskId: string; coordination: { archiveReason?: string; staleAt?: string } }> }>(
      await tools.hive_background_status.execute({ includeArchived: true }, createToolContext()),
    );

    expect(result.jobs?.map(job => job.taskId)).toEqual(['archived-stale-task']);
    expect(result.jobs?.[0].coordination).toMatchObject({ archiveReason: 'ignored' });
    expect(result.jobs?.[0].coordination.staleAt).toBeDefined();
  });

  it('hive_background_reconcile_batch reconciles terminal jobs and reports per-item failures', async () => {
    registerScopedJob(service, { taskId: 'completed-task', sessionId: 'completed-session' });
    service.markTerminal('completed-task', 'completed', { resultSummary: 'runtime result stays' });
    registerScopedJob(service, { taskId: 'running-task', sessionId: 'running-session' });
    registerScopedJob(service, { taskId: 'other-parent-task', sessionId: 'other-parent-session', parentSessionId: 'parent-2' });
    service.markTerminal('other-parent-task', 'completed', { resultSummary: 'not visible' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{
      success?: boolean;
      recommendedNextAction?: { action: string; reasonCode: string; requiresHiveStatusRefresh: boolean };
      results?: Array<{ identifier: string; success: boolean; reason?: string; job?: { taskId: string; coordination: { terminalUnreconciled?: boolean; reconciliationSummary?: string } } }>;
    }>(await tools.hive_background_reconcile_batch.execute({
      items: [
        { identifier: 'completed-task', decision: 'reconciled', summary: 'Consumed worker output.' },
        { identifier: 'running-task', decision: 'ignored', summary: 'Too early.' },
        { identifier: 'missing-task', decision: 'ignored', summary: 'Missing task.' },
        { identifier: 'other-parent-task', decision: 'ignored', summary: 'Wrong scope.' },
      ],
    }, createToolContext()));

    expect(result.success).toBe(false);
    expect(result.results).toHaveLength(4);
    expect(result.results?.[0]).toMatchObject({
      identifier: 'completed-task',
      success: true,
      job: {
        taskId: 'completed-task',
        coordination: {
          terminalUnreconciled: false,
          reconciliationSummary: 'Consumed worker output.',
        },
      },
    });
    expect(result.recommendedNextAction).toMatchObject({
      action: 'wait_for_native_completion',
      reasonCode: 'native_completion_wait_only',
      taskId: 'running-task',
      requiresHiveStatusRefresh: true,
    });
    expect(result.results?.[1]).toMatchObject({ identifier: 'running-task', success: false, reason: 'job_not_terminal' });
    expect(result.results?.[2]).toMatchObject({ identifier: 'missing-task', success: false, reason: 'job_not_found' });
    expect(result.results?.[3]).toMatchObject({ identifier: 'other-parent-task', success: false, reason: 'job_not_in_scope' });
    expect(service.resolve('running-task')?.runtimeState).toBe('running');
    expect(service.resolve('other-parent-task')?.terminalUnreconciled).toBe(true);
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

  it('hive_background_reconcile cannot act on archived jobs by direct identifier', async () => {
    registerScopedJob(service, { taskId: 'archived-job', sessionId: 'archived-session' });
    service.markTerminal('archived-job', 'completed', { resultSummary: 'done' });
    service.markReconciled('archived-job', { reconciliationSummary: 'archived' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{ success?: boolean; reason?: string }>(await tools.hive_background_reconcile.execute(
      { identifier: 'archived-job', decision: 'ignored', summary: 'Should not be possible.' },
      createToolContext(),
    ));

    expect(result).toMatchObject({ success: false, reason: 'job_archived' });
    expect(service.resolve('archived-job')?.archiveReason).toBe('reconciled');
  });

  it('hive_background_cancel cannot act on archived jobs by direct identifier', async () => {
    registerScopedJob(service, { taskId: 'archived-cancel', sessionId: 'archived-cancel-session' });
    service.markTerminal('archived-cancel', 'completed', { resultSummary: 'done' });
    service.markIgnored('archived-cancel', 'archived by operator');

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{ success?: boolean; reason?: string }>(await tools.hive_background_cancel.execute(
      { identifier: 'archived-cancel', reason: 'Should not reach cancel.' },
      createToolContext(),
    ));

    expect(result).toMatchObject({ success: false, reason: 'job_archived' });
  });

  it('hive_background_status default output hides operator-archived jobs, includeArchived shows them', async () => {
    registerScopedJob(service, { taskId: 'hidden-job', sessionId: 'hidden-session' });
    service.markTerminal('hidden-job', 'completed', { resultSummary: 'done' });
    service.markReconciled('hidden-job', { reconciliationSummary: 'archived' });
    registerScopedJob(service, { taskId: 'visible-job', sessionId: 'visible-session' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const defaultRaw = await tools.hive_background_status.execute({}, createToolContext());
    const defaultResult = parseToolJson<{ jobs?: Array<{ taskId: string }> }>(defaultRaw);
    expect(defaultResult.jobs?.map(j => j.taskId)).not.toContain('hidden-job');
    expect(defaultResult.jobs?.map(j => j.taskId)).toContain('visible-job');

    const includeArchivedRaw = await tools.hive_background_status.execute({ includeArchived: true }, createToolContext());
    const includeArchivedResult = parseToolJson<{ jobs?: Array<{ taskId: string }> }>(includeArchivedRaw);
    expect(includeArchivedResult.jobs?.map(j => j.taskId)).toContain('hidden-job');
  });

  it('hive_background_reconcile rejects jobs with only ignoredAt (no archivedAt) as archived', async () => {
    registerScopedJob(service, { taskId: 'ignored-no-archive-tool', sessionId: 'ignored-no-archive-tool-session' });
    let board = readBoard();
    const rec = board.jobs.find(j => j.taskId === 'ignored-no-archive-tool')!;
    rec.ignoredAt = new Date().toISOString();
    rec.reconciledAt = new Date().toISOString();
    delete (rec as any).archivedAt;
    fs.writeFileSync(BOARD_PATH, JSON.stringify(board, null, 2));
    board = readBoard();

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{ success?: boolean; reason?: string }>(await tools.hive_background_reconcile.execute(
      { identifier: 'ignored-no-archive-tool', decision: 'reconciled', summary: 'Should reject.' },
      createToolContext(),
    ));

    expect(result).toMatchObject({ success: false, reason: 'job_archived' });
  });

  it('hive_background_reconcile rejects jobs with only reconciledAt (no archivedAt) as archived', async () => {
    registerScopedJob(service, { taskId: 'reconciled-no-archive-tool', sessionId: 'reconciled-no-archive-tool-session' });
    let board = readBoard();
    const rec = board.jobs.find(j => j.taskId === 'reconciled-no-archive-tool')!;
    rec.reconciledAt = new Date().toISOString();
    delete (rec as any).archivedAt;
    fs.writeFileSync(BOARD_PATH, JSON.stringify(board, null, 2));
    board = readBoard();

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{ success?: boolean; reason?: string }>(await tools.hive_background_reconcile.execute(
      { identifier: 'reconciled-no-archive-tool', decision: 'reconciled', summary: 'Should reject.' },
      createToolContext(),
    ));

    expect(result).toMatchObject({ success: false, reason: 'job_archived' });
  });

  it('hive_background_status with includeArchived includes archived running jobs in jobs but excludes from scheduler/action calculations', async () => {
    registerScopedJob(service, { taskId: 'archived-running', sessionId: 'archived-running-session' });
    let board = readBoard();
    let rec = board.jobs.find(j => j.taskId === 'archived-running')!;
    rec.archivedAt = new Date().toISOString();
    rec.archiveReason = 'reconciled';
    rec.reconciledAt = new Date().toISOString();
    rec.terminalUnreconciled = false;
    fs.writeFileSync(BOARD_PATH, JSON.stringify(board, null, 2));
    registerScopedJob(service, { taskId: 'active-running', sessionId: 'active-running-session' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const raw = await tools.hive_background_status.execute({ includeArchived: true }, createToolContext());
    const result = parseToolJson<{
      jobs?: Array<{ taskId: string; coordination: { visibility: string } }>;
      archivedCount?: number;
      nextActions?: unknown[];
      recommendedNextAction?: { action: string; reasonCode: string };
      orchestrationBurden?: { visibleLanes: number; actionableLanes: number; completionNotificationsPending: number; reconcileItemsRequired: number };
      schedulerGuidance?: { reason: string };
    }>(raw);

    expect(result.jobs?.map(j => j.taskId)).toContain('archived-running');
    expect(result.jobs?.map(j => j.taskId)).toContain('active-running');
    expect(result.archivedCount).toBe(1);
    expect(result.nextActions).toBeUndefined();
    expect(result.recommendedNextAction?.action).toBe('wait_for_native_completion');
    expect(result.orchestrationBurden).toMatchObject({
      visibleLanes: 1,
      actionableLanes: 0,
      completionNotificationsPending: 1,
      reconcileItemsRequired: 0,
    });
    expect(result.schedulerGuidance).toBeDefined();
  });

  it('hive_background_status formats ignored-only and reconciled-only records as archived/inert visibility', async () => {
    registerScopedJob(service, { taskId: 'ignored-only-job', sessionId: 'ignored-only-session' });
    let board = readBoard();
    let rec = board.jobs.find(j => j.taskId === 'ignored-only-job')!;
    rec.ignoredAt = new Date().toISOString();
    delete (rec as any).archivedAt;
    fs.writeFileSync(BOARD_PATH, JSON.stringify(board, null, 2));

    registerScopedJob(service, { taskId: 'reconciled-only-job', sessionId: 'reconciled-only-session' });
    board = readBoard();
    rec = board.jobs.find(j => j.taskId === 'reconciled-only-job')!;
    rec.reconciledAt = new Date().toISOString();
    rec.terminalUnreconciled = false;
    delete (rec as any).archivedAt;
    fs.writeFileSync(BOARD_PATH, JSON.stringify(board, null, 2));

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const raw = await tools.hive_background_status.execute({ includeArchived: true }, createToolContext());
    const result = parseToolJson<{
      jobs?: Array<{ taskId: string; coordination: { visibility: string; archivedAt?: string; reconciledAt?: string; ignoredAt?: string } }>;
      archivedCount?: number;
    }>(raw);

    expect(result.archivedCount).toBe(2);
    const ignoredOnly = result.jobs?.find(j => j.taskId === 'ignored-only-job');
    expect(ignoredOnly?.coordination.visibility).toBe('archived_after_reconcile');
    expect(ignoredOnly?.coordination.archivedAt).toBeUndefined();
    expect(ignoredOnly?.coordination.ignoredAt).toBeDefined();
    const reconciledOnly = result.jobs?.find(j => j.taskId === 'reconciled-only-job');
    expect(reconciledOnly?.coordination.visibility).toBe('archived_after_reconcile');
    expect(reconciledOnly?.coordination.archivedAt).toBeUndefined();
    expect(reconciledOnly?.coordination.reconciledAt).toBeDefined();
  });

  it('hive_background_status keeps later-terminal archived jobs inert with includeArchived', async () => {
    registerScopedJob(service, { taskId: 'archived-late-terminal', sessionId: 'archived-late-terminal-session' });
    let board = readBoard();
    const record = board.jobs.find(j => j.taskId === 'archived-late-terminal')!;
    record.archivedAt = new Date().toISOString();
    fs.writeFileSync(BOARD_PATH, JSON.stringify(board, null, 2));
    service.markTerminal('archived-late-terminal', 'completed', { resultSummary: 'late result' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const raw = await tools.hive_background_status.execute({ includeArchived: true }, createToolContext());
    const result = parseToolJson<{
      jobs?: Array<{ taskId: string; coordination: { terminalUnreconciled?: boolean; visibility: string; actionRequired?: boolean } }>;
      recommendedNextAction?: { action: string; reasonCode: string };
      orchestrationBurden?: { visibleLanes: number; actionableLanes: number; reconcileItemsRequired: number };
    }>(raw);

    const archived = result.jobs?.find(j => j.taskId === 'archived-late-terminal');
    expect(archived?.coordination.visibility).toBe('archived_after_reconcile');
    expect(archived?.coordination.terminalUnreconciled).toBeUndefined();
    expect(archived?.coordination.actionRequired).toBe(false);
    expect(result.recommendedNextAction?.action).toBe('idle');
    expect(result.orchestrationBurden).toMatchObject({
      visibleLanes: 0,
      actionableLanes: 0,
      reconcileItemsRequired: 0,
    });
  });

  it('single reconcile does not false-idle with two unscoped terminal jobs', async () => {
    registerUnscopedJob(service, { taskId: 'done-a', sessionId: 'done-a-session' });
    service.markTerminal('done-a', 'completed', { resultSummary: 'done a' });
    registerUnscopedJob(service, { taskId: 'done-b', sessionId: 'done-b-session' });
    service.markTerminal('done-b', 'error', { resultSummary: 'done b' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const reconciledRaw = await tools.hive_background_reconcile.execute(
      { identifier: 'done-a', decision: 'reconciled', summary: 'consumed' },
      createToolContext(),
    );
    const reconciled = parseToolJson<{
      success?: boolean;
      recommendedNextAction?: { action: string; reasonCode: string; taskId?: string; requiresHiveStatusRefresh: boolean };
    }>(reconciledRaw);

    expect(reconciled.success).toBe(true);
    expect(reconciled.recommendedNextAction).toMatchObject({
      action: 'reconcile_terminal_job',
      reasonCode: 'terminal_unreconciled_job_visible',
      taskId: 'done-b',
      requiresHiveStatusRefresh: false,
    });
  });

  it('single reconcile of Hive-scoped job while unscoped terminal job remains', async () => {
    registerScopedJob(service, { taskId: 'scoped-done', sessionId: 'scoped-done-session' });
    service.markTerminal('scoped-done', 'completed', { resultSummary: 'scoped done' });
    registerUnscopedJob(service, { taskId: 'unscoped-done', sessionId: 'unscoped-done-session' });
    service.markTerminal('unscoped-done', 'completed', { resultSummary: 'unscoped done' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const reconciledRaw = await tools.hive_background_reconcile.execute(
      { identifier: 'scoped-done', decision: 'reconciled', summary: 'consumed scoped' },
      createToolContext(),
    );
    const reconciled = parseToolJson<{
      success?: boolean;
      recommendedNextAction?: { action: string; reasonCode: string; taskId?: string; requiresHiveStatusRefresh: boolean };
    }>(reconciledRaw);

    expect(reconciled.success).toBe(true);
    expect(reconciled.recommendedNextAction).toMatchObject({
      action: 'reconcile_terminal_job',
      reasonCode: 'terminal_unreconciled_job_visible',
      taskId: 'unscoped-done',
      requiresHiveStatusRefresh: true,
    });
  });

  it('hive_background_reconcile_batch detects Hive-scoped reconciled job with whitespace-padded identifier', async () => {
    registerScopedJob(service, { taskId: 'padded-job', sessionId: 'padded-session' });
    service.markTerminal('padded-job', 'completed', { resultSummary: 'done' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{
      success?: boolean;
      recommendedNextAction?: { action: string; reasonCode: string; requiresHiveStatusRefresh: boolean };
      results?: Array<{ identifier: string; success: boolean }>;
    }>(await tools.hive_background_reconcile_batch.execute({
      items: [
        { identifier: '  padded-job  ', decision: 'reconciled', summary: 'consumed with padding' },
      ],
    }, createToolContext()));

    expect(result.success).toBe(true);
    expect(result.recommendedNextAction).toMatchObject({
      action: 'inspect_hive_status',
      reasonCode: 'reconciled_job_has_hive_scope',
      requiresHiveStatusRefresh: true,
    });
  });

  it('batch reconcile omits visible terminal job', async () => {
    registerUnscopedJob(service, { taskId: 'done-a', sessionId: 'batch-done-a-session' });
    service.markTerminal('done-a', 'completed', { resultSummary: 'done a' });
    registerUnscopedJob(service, { taskId: 'done-b', sessionId: 'batch-done-b-session' });
    service.markTerminal('done-b', 'completed', { resultSummary: 'done b' });

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
    });

    const result = parseToolJson<{
      success?: boolean;
      recommendedNextAction?: { action: string; reasonCode: string; taskId?: string; requiresHiveStatusRefresh: boolean };
      results?: Array<{ identifier: string; success: boolean }>;
    }>(await tools.hive_background_reconcile_batch.execute({
      items: [
        { identifier: 'done-a', decision: 'reconciled', summary: 'consumed a' },
      ],
    }, createToolContext()));

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results?.[0]).toMatchObject({ identifier: 'done-a', success: true });
    expect(result.recommendedNextAction).toMatchObject({
      action: 'reconcile_terminal_job',
      reasonCode: 'terminal_unreconciled_job_visible',
      taskId: 'done-b',
      requiresHiveStatusRefresh: false,
    });
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

  it('hive_background_status classifies foreign-runtime running jobs as stale and does not count them as native completion pending', async () => {
    const CURRENT_RUNTIME_ID = 'current-runtime-001';

    registerScopedJob(service, { taskId: 'mismatched-runtime-job', sessionId: 'mismatched-session' });
    let board = readBoard();
    const rec = board.jobs.find(j => j.taskId === 'mismatched-runtime-job')!;
    rec.runtimeId = undefined;
    fs.writeFileSync(BOARD_PATH, JSON.stringify(board, null, 2));

    const tools = createBackgroundTools({
      backgroundJobService: service,
      projectRoot: TEST_DIR,
      isEnabled: () => true,
      currentRuntimeId: CURRENT_RUNTIME_ID,
    });

    const raw = await tools.hive_background_status.execute({}, createToolContext());
    const result = parseToolJson<{
      jobs?: Array<{
        taskId: string;
        runtime: { state: string; statusUncertain?: boolean; lastStatusError?: string };
        coordination: { staleAt?: string; visibility?: string };
      }>;
      recommendedNextAction?: { action: string; reasonCode: string; taskId?: string; message?: string };
      schedulerGuidance?: { reason: string; message: string };
      orchestrationBurden?: {
        visibleLanes: number;
        completionNotificationsPending: number;
        reconcileItemsRequired: number;
      };
    }>(raw);

    expect(result.jobs?.map(j => j.taskId)).toContain('mismatched-runtime-job');
    const job = result.jobs?.find(j => j.taskId === 'mismatched-runtime-job')!;
    expect(job.runtime.state).toBe('running');
    expect(job.runtime.statusUncertain).toBe(true);
    expect(job.runtime.lastStatusError).toContain('runtime');
    expect(job.coordination.staleAt).toBeDefined();
    expect(result.orchestrationBurden?.completionNotificationsPending).toBe(0);
    expect(result.schedulerGuidance).toBeUndefined();
    expect(result.recommendedNextAction?.action).not.toBe('wait_for_native_completion');
    expect(result.recommendedNextAction?.message).toContain('stale');
  });
});
