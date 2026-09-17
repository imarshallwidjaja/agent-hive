import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { BackgroundJobsJson } from '../types.js';
import { BackgroundJobService } from './backgroundJobService.js';

const TEST_DIR = `/tmp/hive-core-backgroundjobservice-test-${process.pid}`;
const BOARD_PATH = path.join(TEST_DIR, '.hive', 'background-jobs.json');

function cleanup(): void {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

function readBoard(): BackgroundJobsJson {
  return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8')) as BackgroundJobsJson;
}

function registerJob(service: BackgroundJobService, taskId = 'task-1', sessionId = 'session-1') {
  return service.registerLaunch({
    taskId,
    sessionId,
    callId: `call-${taskId}`,
    agentName: 'forager-worker',
    description: 'Implement the worker task',
    runtimeId: 'runtime-a',
    scope: {
      projectRoot: TEST_DIR,
      parentSessionId: 'parent-1',
      primaryAgent: 'hive-master',
      feature: 'feature-a',
      task: '01-task',
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

  afterEach(cleanup);

  it('registers native jobs and generates parent-scoped aliases', () => {
    const first = registerJob(service);
    const second = registerJob(service, 'task-2', 'session-2');
    const otherParent = service.registerLaunch({
      taskId: 'task-3',
      sessionId: 'session-3',
      agentName: 'scout-researcher',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-2' },
    });

    expect(first.alias).toBe('parent-1:job-1');
    expect(second.alias).toBe('parent-1:job-2');
    expect(otherParent.alias).toBe('parent-2:job-1');
    expect(readBoard().jobs[0]).toMatchObject({
      taskId: 'task-1',
      sessionId: 'session-1',
      callId: 'call-task-1',
      runtimeState: 'running',
    });
  });

  it('discards legacy pending launch data without turning it into authority', () => {
    fs.mkdirSync(path.dirname(BOARD_PATH), { recursive: true });
    fs.writeFileSync(BOARD_PATH, JSON.stringify({
      schemaVersion: 1,
      jobs: [],
      pendingLaunches: [{
        launchId: 'legacy-launch',
        parentSessionId: 'parent-1',
        disposition: 'claimed',
        callId: 'legacy-call',
      }],
    }));

    const record = service.registerLaunch({
      taskId: 'native-task',
      sessionId: 'native-session',
      callId: 'legacy-call',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1' },
    });

    expect(record.taskId).toBe('native-task');
    expect(readBoard()).toEqual(expect.objectContaining({ schemaVersion: 1, jobs: [expect.any(Object)] }));
    expect(JSON.stringify(readBoard())).not.toContain('pendingLaunches');
    expect(service.resolve('legacy-launch')).toBeUndefined();
  });

  it('keeps removed persisted projection keys inert', () => {
    fs.mkdirSync(path.dirname(BOARD_PATH), { recursive: true });
    fs.writeFileSync(BOARD_PATH, JSON.stringify({
      schemaVersion: 1,
      jobs: [{
        taskId: 'legacy-task', sessionId: 'legacy-session', agentName: 'forager-worker', alias: 'legacy',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', runtimeState: 'running',
        objective: 'legacy objective', scopeSource: 'retry', retryOf: 'older-task', supersedes: 'newer-task',
        ownership: { workerPromptPath: '/legacy/prompt', worktreePath: '/legacy/worktree' },
      }],
    }));

    expect(service.formatForPrompt()).not.toContain('legacy objective');
    expect(service.formatForPrompt()).not.toContain('/legacy/');
    const next = service.registerLaunch({ taskId: 'new-task', sessionId: 'new-session', agentName: 'forager-worker' });
    expect(next).not.toHaveProperty('objective');
    expect(next).not.toHaveProperty('scopeSource');
    expect(next).not.toHaveProperty('ownership');
  });

  it('correlates one native call idempotently and rejects contradictory identity', () => {
    const input = {
      taskId: 'native-task',
      sessionId: 'native-session',
      callId: 'native-call',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1' },
    };
    const record = service.registerLaunch(input);

    expect(service.registerLaunch(input)).toEqual(record);
    expect(() => service.registerLaunch({ ...input, taskId: 'other-task' })).toThrow('contradictory native identity');
    expect(service.resolve(record.taskId)).toEqual(record);
    expect(service.resolve(record.sessionId)).toEqual(record);
    expect(service.resolve(record.alias)).toEqual(record);
  });

  it('registers resumed launches with a reused child session and requires an exact alias', () => {
    const first = service.registerLaunch({
      taskId: 'resumed-child',
      sessionId: 'resumed-child',
      callId: 'call-1',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1' },
    });
    const resumed = service.registerLaunch({
      taskId: 'resumed-child',
      sessionId: 'resumed-child',
      callId: 'call-2',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1' },
    });

    expect(resumed.alias).not.toBe(first.alias);
    expect(service.resolve(resumed.alias)).toEqual(resumed);
    expect(() => service.resolve('resumed-child')).toThrow(`Use one of these exact aliases: ${first.alias}, ${resumed.alias}`);
  });

  it('keeps the first terminal result and reconciles observational bookkeeping', () => {
    registerJob(service);
    const terminal = service.markTerminal('task-1', 'completed', { resultSummary: 'done' });
    const conflicting = service.markTerminal('task-1', 'error', { lastStatusError: 'late error' });

    expect(conflicting).toMatchObject({
      runtimeState: 'completed',
      resultSummary: 'done',
      terminalUnreconciled: true,
    });
    expect(conflicting.runtimeCompletedAt).toBe(terminal.runtimeCompletedAt);

    const reconciled = service.markReconciled('task-1', {
      reconciledBy: 'parent-1',
      reconciliationSummary: 'Consumed final result.',
    });
    expect(reconciled).toMatchObject({
      runtimeState: 'completed',
      terminalUnreconciled: false,
      archiveReason: 'reconciled',
    });
    expect(service.listScoped()).toEqual([]);
    expect(service.listScoped({}, { includeArchived: true })).toHaveLength(1);
  });

  it('marks prompt notification and acknowledgment without reconciling the result', () => {
    registerJob(service);
    service.markTerminal('task-1', 'completed');

    const notified = service.markPromptNotified(['task-1'], 'parent-1');
    expect(notified[0]).toMatchObject({
      terminalUnreconciled: true,
      promptNotifiedInSessionId: 'parent-1',
      promptBoardInjectionCount: 1,
    });
    const acknowledged = service.markPromptAcknowledgedForSession('parent-1');
    expect(acknowledged[0]).toMatchObject({
      terminalUnreconciled: true,
      promptBoardInjectionCount: 1,
    });
    expect(acknowledged[0].promptAcknowledgedAt).toBeDefined();
  });

  it('keeps prompt metadata scoped to the originating parent for reused child ids', () => {
    registerJob(service);
    service.markTerminal('task-1', 'completed');
    const other = service.registerLaunch({
      taskId: 'task-1',
      sessionId: 'task-1',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-2' },
    });
    service.markTerminal(other.alias, 'completed');

    expect(service.markPromptNotified(['task-1'], 'parent-1').map(job => job.alias)).toEqual(['parent-1:job-1']);
    expect(service.markPromptAcknowledgedForSession('parent-1').map(job => job.alias)).toEqual(['parent-1:job-1']);
    expect(service.resolve(other.alias)).not.toHaveProperty('promptNotifiedAt');
    expect(service.resolve(other.alias)).not.toHaveProperty('promptAcknowledgedAt');
  });

  it('marks active jobs from another runtime stale without changing runtime state', () => {
    registerJob(service);

    const stale = service.markRuntimeEpochStale('task-1', 'runtime-b', 'runtime changed');
    expect(stale).toMatchObject({
      runtimeState: 'running',
      statusUncertain: true,
      lastStatusError: 'runtime changed',
    });
    expect(stale?.staleAt).toBeDefined();
    expect(service.markRuntimeEpochStale('task-1', 'runtime-b', 'again')).toBeUndefined();
  });

  it('formats only native job records for prompts', () => {
    expect(service.formatForPrompt()).toBe('No background jobs are currently visible for this scope.');
    registerJob(service);
    expect(service.formatForPrompt({ parentSessionId: 'parent-1' })).toContain('parent-1:job-1 running forager-worker');
  });

  it('updates last-known runtime state idempotently', () => {
    registerJob(service);

    const first = service.updateRuntimeState('task-1', 'running', {
      statusUncertain: true,
      lastStatusError: 'status timed out',
    });
    const second = service.updateRuntimeState('task-1', 'running', {
      statusUncertain: true,
      lastStatusError: 'status timed out',
    });

    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second).toMatchObject({ runtimeState: 'running', statusUncertain: true });
  });

  it('allows matching terminal updates to fill missing diagnostics', () => {
    registerJob(service);
    const terminal = service.markTerminal('task-1', 'error');
    const enriched = service.markTerminal('task-1', 'error', {
      resultSummary: 'worker failed',
      lastStatusError: 'provider disconnected',
    });

    expect(enriched.runtimeCompletedAt).toBe(terminal.runtimeCompletedAt);
    expect(enriched).toMatchObject({ resultSummary: 'worker failed', lastStatusError: 'provider disconnected' });
  });

  it('clears explicitly replaced terminal diagnostics', () => {
    registerJob(service);
    service.updateRuntimeState('task-1', 'unknown', {
      statusUncertain: true,
      lastStatusError: 'transient status miss',
    });

    const terminal = service.markTerminal('task-1', 'completed', {
      statusUncertain: false,
      lastStatusError: undefined,
    });

    expect(terminal).toMatchObject({ runtimeState: 'completed', statusUncertain: false });
    expect(terminal).not.toHaveProperty('lastStatusError');
  });

  it('does not create a board when prompt acknowledgment has no matching job', () => {
    expect(service.markPromptAcknowledgedForSession('parent-1')).toEqual([]);
    expect(fs.existsSync(BOARD_PATH)).toBe(false);
  });

  it('keeps cancellation requests distinct from confirmed runtime cancellation', () => {
    registerJob(service);
    const requested = service.markCancelRequested('task-1', 'No longer needed');

    expect(requested).toMatchObject({
      runtimeState: 'running',
      cancelReason: 'No longer needed',
    });
    const cancelled = service.markRuntimeCancelled('task-1', { resultSummary: 'Runtime confirmed cancellation' });
    expect(cancelled).toMatchObject({
      runtimeState: 'cancelled',
      terminalUnreconciled: true,
      resultSummary: 'Runtime confirmed cancellation',
    });
  });

  it('filters board visibility by scope', () => {
    registerJob(service);
    service.registerLaunch({
      taskId: 'task-2',
      sessionId: 'session-2',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-2', feature: 'feature-b' },
    });

    expect(service.listScoped({ parentSessionId: 'parent-1' }).map(job => job.taskId)).toEqual(['task-1']);
    expect(service.listScoped({ parentSessionId: 'parent-2' }).map(job => job.taskId)).toEqual(['task-2']);
  });

  it('archives ignored jobs without changing their runtime result', () => {
    registerJob(service);
    service.updateRuntimeState('task-1', 'unknown', { statusUncertain: true });
    const ignored = service.markIgnored('task-1', 'Superseded elsewhere');

    expect(ignored).toMatchObject({
      runtimeState: 'unknown',
      ignoreReason: 'Superseded elsewhere',
      archiveReason: 'ignored',
      terminalUnreconciled: false,
    });
    expect(service.listScoped()).toEqual([]);
    expect(service.listScoped({}, { includeArchived: true })).toHaveLength(1);
    expect(() => service.markIgnored('missing', 'reason')).toThrow('Background job not found');
  });
});
