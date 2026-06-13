import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { BackgroundJobService } from './backgroundJobService.js';
import type { BackgroundJobsJson } from '../types.js';

const TEST_DIR = '/tmp/hive-core-backgroundjobservice-test-' + process.pid;
const BOARD_PATH = path.join(TEST_DIR, '.hive', 'background-jobs.json');

function cleanup(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

function readBoard(): BackgroundJobsJson {
  return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf-8')) as BackgroundJobsJson;
}

function registerJob(service: BackgroundJobService, taskId = 'task-1', sessionId = 'sess-1') {
  return service.registerLaunch({
    taskId,
    sessionId,
    agentName: 'forager-worker',
    scopeSource: 'pending-launch',
    description: 'Implement the worker task',
    objective: 'Add the service contract',
    scope: {
      projectRoot: TEST_DIR,
      parentSessionId: 'parent-1',
      primaryAgent: 'hive-master',
      feature: 'feature-a',
      task: '01-task',
    },
    ownership: {
      worktreePath: path.join(TEST_DIR, '.hive', '.worktrees', 'feature-a', '01-task'),
      branch: 'hive/feature-a/01-task',
      workerPromptPath: '.hive/features/feature-a/tasks/01-task/worker-prompt.md',
      files: ['packages/hive-core/src/services/backgroundJobService.ts'],
      repoIds: ['root'],
    },
  });
}

describe('BackgroundJobService', () => {
  let service: BackgroundJobService;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    service = new BackgroundJobService(TEST_DIR);
  });

  afterEach(() => {
    cleanup();
  });

  it('creates .hive/background-jobs.json on first launch registration', () => {
    const record = registerJob(service);

    expect(fs.existsSync(BOARD_PATH)).toBe(true);
    const board = readBoard();
    expect(board.schemaVersion).toBe(1);
    expect(board.jobs).toHaveLength(1);
    expect(board.jobs[0]).toMatchObject({
      taskId: record.taskId,
      sessionId: 'sess-1',
      agentName: 'forager-worker',
      runtimeState: 'running',
      scopeSource: 'pending-launch',
      scope: {
        projectRoot: TEST_DIR,
        parentSessionId: 'parent-1',
        primaryAgent: 'hive-master',
        feature: 'feature-a',
        task: '01-task',
      },
    });
  });

  it('generates aliases scoped to the parent session without collisions', () => {
    const first = registerJob(service, 'task-1', 'sess-1');
    const second = registerJob(service, 'task-2', 'sess-2');
    const otherParent = service.registerLaunch({
      taskId: 'task-3',
      sessionId: 'sess-3',
      agentName: 'scout-researcher',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-2', primaryAgent: 'hive-master' },
    });

    expect(first.alias).toBe('parent-1:job-1');
    expect(second.alias).toBe('parent-1:job-2');
    expect(otherParent.alias).toBe('parent-2:job-1');
    expect(new Set([first.alias, second.alias, otherParent.alias]).size).toBe(3);
  });

  it('consumes pending launches by prompt while leaving no-prompt launches untouched', () => {
    service.registerPendingLaunch({
      parentSessionId: 'parent-1',
      agentName: 'unknown',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', adHocRunId: 'adhoc-1' },
    });
    const exact = service.registerPendingLaunch({
      parentSessionId: 'parent-1',
      expectedDescription: 'Hive: 01-task',
      expectedPrompt: 'Follow instructions in @worker-prompt.md',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', feature: 'feature-a', task: '01-task' },
    });

    const consumed = service.consumePendingLaunch({
      parentSessionId: 'parent-1',
      expectedDescription: 'Hive: 01-task',
      expectedPrompt: 'Follow instructions in @worker-prompt.md',
    });

    expect(consumed).toMatchObject({
      parentSessionId: exact.parentSessionId,
      expectedDescription: exact.expectedDescription,
      expectedPrompt: exact.expectedPrompt,
      agentName: exact.agentName,
      scope: exact.scope,
    });
    expect(readBoard().pendingLaunches).toHaveLength(1);
    expect(readBoard().pendingLaunches?.[0].scope?.adHocRunId).toBe('adhoc-1');
  });

  it('consumes pending launches by prompt when model-facing descriptions drift', () => {
    const pending = service.registerPendingLaunch({
      parentSessionId: 'parent-1',
      expectedDescription: 'Hive: 01-task',
      expectedPrompt: 'Follow instructions in @worker-prompt.md',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', feature: 'feature-a', task: '01-task' },
      ownership: { worktreePath: path.join(TEST_DIR, '.hive', '.worktrees', 'feature-a', '01-task') },
    });

    const consumed = service.consumePendingLaunch({
      parentSessionId: 'parent-1',
      expectedDescription: 'Hive: smoke docs',
      expectedPrompt: 'Follow instructions in @worker-prompt.md',
    });

    expect(consumed).toEqual(pending);
    expect(readBoard().pendingLaunches).toBeUndefined();
  });

  it('does not consume pending launches with matching descriptions and different prompts', () => {
    service.registerPendingLaunch({
      parentSessionId: 'parent-1',
      expectedDescription: 'Hive: 01-task',
      expectedPrompt: 'Follow instructions in @worker-prompt-a.md',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', feature: 'feature-a', task: '01-task' },
    });

    const consumed = service.consumePendingLaunch({
      parentSessionId: 'parent-1',
      expectedDescription: 'Hive: 01-task',
      expectedPrompt: 'Follow instructions in @worker-prompt-b.md',
    });

    expect(consumed).toBeUndefined();
    expect(readBoard().pendingLaunches).toHaveLength(1);
  });

  it('consumes ad-hoc pending launches by stable prompt without feature or task metadata', () => {
    const expectedPrompt = 'Work in /tmp/adhoc-1 for ad-hoc run adhoc-1.';
    const pending = service.registerPendingLaunch({
      parentSessionId: 'parent-1',
      expectedPrompt,
      agentName: 'unknown',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', adHocRunId: 'adhoc-1' },
      ownership: { worktreePath: path.join(TEST_DIR, '.hive', '.worktrees', 'adhoc', 'adhoc-1') },
    });

    service.registerPendingLaunch({
      parentSessionId: 'parent-2',
      agentName: 'unknown',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-2', adHocRunId: 'adhoc-2' },
    });

    const consumed = service.consumePendingLaunch({
      parentSessionId: 'parent-1',
      expectedDescription: 'Investigate the failure',
      expectedPrompt,
    });

    expect(consumed).toEqual(pending);
    expect(readBoard().pendingLaunches).toHaveLength(1);
    expect(readBoard().pendingLaunches?.[0].parentSessionId).toBe('parent-2');
  });

  it('updates last-known runtime state idempotently', () => {
    registerJob(service);

    const first = service.updateRuntimeState('task-1', 'running', { statusUncertain: true, lastStatusError: 'task_status timed out' });
    const second = service.updateRuntimeState('task-1', 'running', { statusUncertain: true, lastStatusError: 'task_status timed out' });

    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.runtimeState).toBe('running');
    expect(second.statusUncertain).toBe(true);
    expect(readBoard().jobs).toHaveLength(1);
  });

  it('marks terminal runtime states unreconciled without changing the terminal runtime result during reconciliation', () => {
    registerJob(service);

    const terminal = service.markTerminal('task-1', 'completed', { resultSummary: 'worker finished cleanly' });
    expect(terminal.runtimeState).toBe('completed');
    expect(terminal.terminalUnreconciled).toBe(true);
    expect(terminal.resultSummary).toBe('worker finished cleanly');

    const reconciled = service.markReconciled('task-1', {
      reconciledBy: 'parent-1',
      reconciliationSummary: 'Task report and status were updated.',
    });
    expect(reconciled.runtimeState).toBe('completed');
    expect(reconciled.resultSummary).toBe('worker finished cleanly');
    expect(reconciled.terminalUnreconciled).toBe(false);
    expect(reconciled.reconciledAt).toBeDefined();
    expect(reconciled.reconciledBy).toBe('parent-1');
    expect(reconciled.reconciliationSummary).toBe('Task report and status were updated.');

    const lateStatus = service.markTerminal('task-1', 'completed', { resultSummary: 'worker finished cleanly' });
    expect(lateStatus.terminalUnreconciled).toBe(false);
    expect(lateStatus.reconciledAt).toBe(reconciled.reconciledAt);
  });

  it('marks prompt notification and acknowledgment separately from reconciliation', () => {
    registerJob(service, 'task-terminal', 'sess-terminal');
    registerJob(service, 'task-running', 'sess-running');
    service.markTerminal('task-terminal', 'completed', { resultSummary: 'done' });

    const notified = service.markPromptNotified(['task-terminal', 'task-running'], 'parent-1');
    expect(notified.map(job => job.taskId)).toEqual(['task-terminal']);
    expect(notified[0].promptNotifiedAt).toBeDefined();
    expect(notified[0].promptNotifiedInSessionId).toBe('parent-1');
    expect(notified[0].terminalUnreconciled).toBe(true);
    expect(service.resolve('task-running')?.promptNotifiedAt).toBeUndefined();
    const notifiedUpdatedAt = notified[0].updatedAt;
    expect(service.markPromptNotified(['task-terminal'], 'parent-1')).toEqual([]);
    expect(service.resolve('task-terminal')?.updatedAt).toBe(notifiedUpdatedAt);

    const acknowledged = service.markPromptAcknowledgedForSession('parent-1');
    expect(acknowledged.map(job => job.taskId)).toEqual(['task-terminal']);
    expect(acknowledged[0].promptAcknowledgedAt).toBeDefined();
    expect(acknowledged[0].terminalUnreconciled).toBe(true);
    expect(acknowledged[0].reconciledAt).toBeUndefined();
    const acknowledgedUpdatedAt = acknowledged[0].updatedAt;
    expect(service.markPromptAcknowledgedForSession('parent-1')).toEqual([]);
    expect(service.resolve('task-terminal')?.updatedAt).toBe(acknowledgedUpdatedAt);
  });

  it('does not create or rewrite the board when prompt acknowledgment has no matching terminal job', () => {
    const acknowledged = service.markPromptAcknowledgedForSession('parent-1');

    expect(acknowledged).toEqual([]);
    expect(fs.existsSync(BOARD_PATH)).toBe(false);
  });

  it('ignores stale terminal jobs without pretending they completed successfully', () => {
    registerJob(service);
    service.markTerminal('task-1', 'error', { resultSummary: 'worker failed' });
    service.markStale('task-1');

    const ignored = service.markIgnored('task-1', 'orphaned worker already surfaced elsewhere');

    expect(ignored.runtimeState).toBe('error');
    expect(ignored.resultSummary).toBe('worker failed');
    expect(ignored.terminalUnreconciled).toBe(false);
    expect(ignored.ignoredAt).toBeDefined();
    expect(ignored.ignoreReason).toBe('orphaned worker already surfaced elsewhere');
    expect(ignored.staleAt).toBeDefined();
  });

  it('keeps cancellation requests distinct from runtime cancellation and preserves ownership metadata', () => {
    registerJob(service);

    const requested = service.markCancelRequested('task-1', 'operator requested stop');
    expect(requested.runtimeState).toBe('running');
    expect(requested.cancelRequestedAt).toBeDefined();
    expect(requested.cancelReason).toBe('operator requested stop');
    expect(requested.ownership?.worktreePath).toContain('.hive/.worktrees/feature-a/01-task');

    const cancelled = service.markRuntimeCancelled('task-1', { resultSummary: 'runtime acknowledged cancellation' });
    expect(cancelled.runtimeState).toBe('cancelled');
    expect(cancelled.terminalUnreconciled).toBe(true);
    expect(cancelled.cancelRequestedAt).toBe(requested.cancelRequestedAt);
    expect(cancelled.cancelReason).toBe('operator requested stop');
    expect(cancelled.ownership).toEqual(requested.ownership);
  });

  it('scopes stale/orphan detection and board visibility instead of filtering globally', () => {
    registerJob(service, 'feature-task', 'sess-feature');
    service.registerLaunch({
      taskId: 'adhoc-task',
      sessionId: 'sess-adhoc',
      agentName: 'hive-builder',
      scope: {
        projectRoot: TEST_DIR,
        parentSessionId: 'parent-1',
        primaryAgent: 'hive-builder',
        adHocRunId: 'adhoc-1',
      },
    });
    service.markStale('adhoc-task');

    expect(service.listScoped({ projectRoot: TEST_DIR, feature: 'feature-a' }).map(job => job.taskId)).toEqual(['feature-task']);
    expect(service.listScoped({ projectRoot: TEST_DIR, adHocRunId: 'adhoc-1' }).map(job => job.taskId)).toEqual(['adhoc-task']);
    expect(service.listScoped({ projectRoot: '/different/root' })).toEqual([]);
    expect(service.listScoped({ projectRoot: TEST_DIR, parentSessionId: 'parent-1', primaryAgent: 'hive-master' }).map(job => job.taskId)).toEqual(['feature-task']);
  });

  it('creates retry records that supersede originals without reusing the session as resume', () => {
    registerJob(service);
    service.markTerminal('task-1', 'error', { resultSummary: 'first worker failed' });

    const retry = service.recordRetry('task-1', {
      taskId: 'task-1-retry',
      sessionId: 'sess-retry',
      agentName: 'forager-worker',
      description: 'Retry failed worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', primaryAgent: 'hive-master', feature: 'feature-a', task: '01-task' },
    });
    const original = service.resolve('task-1');

    expect(retry.retryOf).toBe('task-1');
    expect(retry.sessionId).toBe('sess-retry');
    expect(retry.runtimeState).toBe('running');
    expect(original?.supersedes).toBe('task-1-retry');
    expect(original?.sessionId).toBe('sess-1');
  });

  it('resolves records by task id, session id, or alias and formats scoped board entries for prompts', () => {
    const job = registerJob(service);
    service.markCancelRequested('task-1', 'need to stop');

    expect(service.resolve('task-1')?.taskId).toBe('task-1');
    expect(service.resolve('sess-1')?.taskId).toBe('task-1');
    expect(service.resolve(job.alias)?.taskId).toBe('task-1');

    const prompt = service.formatForPrompt({ projectRoot: TEST_DIR, parentSessionId: 'parent-1', feature: 'feature-a' });
    expect(prompt).toContain('parent-1:job-1');
    expect(prompt).toContain('running');
    expect(prompt).toContain('cancel requested: need to stop');
    expect(prompt).toContain('feature-a');
  });
});
