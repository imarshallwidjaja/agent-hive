import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { BackgroundJobsJson } from '../types.js';
import { BackgroundBoardReadError, BackgroundJobArchiveError, BackgroundJobService } from './backgroundJobService.js';

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

  it('keeps the first terminal result, records a conflicting later one as uncertainty, and reconciles observational bookkeeping', () => {
    registerJob(service);
    const terminal = service.markTerminal('task-1', 'completed', { resultSummary: 'done' });
    const conflicting = service.markTerminal('task-1', 'error', { lastStatusError: 'late error' });

    expect(conflicting).toMatchObject({
      runtimeState: 'completed',
      resultSummary: 'done',
      terminalUnreconciled: true,
      statusUncertain: true,
      lastStatusError: 'Conflicting terminal evidence: the board recorded completed, then a later observation reported error (late error). Hive kept the first state; inspect the native session before relying on either.',
    });
    expect(conflicting.runtimeCompletedAt).toBe(terminal.runtimeCompletedAt);
    // The same conflicting observation again adds nothing, and a later agreeing observation does not clear the conflict.
    expect(service.markTerminal('task-1', 'error', { lastStatusError: 'late error' }).lastStatusError).toBe(conflicting.lastStatusError);
    expect(service.markTerminal('task-1', 'completed', { statusUncertain: false, lastStatusError: undefined })).toMatchObject({
      statusUncertain: true,
      lastStatusError: conflicting.lastStatusError,
    });

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

  it('keeps an earlier diagnostic beside conflicting terminal evidence', () => {
    registerJob(service);
    service.markTerminal('task-1', 'error', { lastStatusError: 'provider disconnected' });
    expect(service.markTerminal('task-1', 'cancelled')).toMatchObject({
      runtimeState: 'error',
      statusUncertain: true,
      lastStatusError: 'provider disconnected | Conflicting terminal evidence: the board recorded error, then a later observation reported cancelled. Hive kept the first state; inspect the native session before relying on either.',
    });
  });

  it('refuses under the lock to archive a record another writer already archived', () => {
    registerJob(service);
    registerJob(service, 'task-2', 'session-2');
    service.markTerminal('task-1', 'completed');
    // A second service instance stands in for another process that read the same record before the first archive.
    const other = new BackgroundJobService(TEST_DIR);
    service.markIgnored('task-1', 'Ignored first.');

    expect(() => other.markReconciled('task-1', { reconciliationSummary: 'Reconciled second.' })).toThrow(BackgroundJobArchiveError);
    expect(() => other.markIgnored('task-1', 'Ignored again.')).toThrow('already archived');
    expect(service.resolve('task-1')).toMatchObject({ archiveReason: 'ignored', ignoreReason: 'Ignored first.' });
    expect(service.resolve('task-1')).not.toHaveProperty('reconciledAt');

    try {
      service.markReconciled('task-2');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(BackgroundJobArchiveError);
      expect((error as BackgroundJobArchiveError).reason).toBe('job_not_terminal');
    }
    expect(service.resolve('task-2')).not.toHaveProperty('archivedAt');
  });

  it('judges archive state under the lock: a live row that lost its uncertainty refuses a guarded ignore', () => {
    const refusal = (archive: () => unknown) => {
      try {
        archive();
      } catch (error) {
        expect(error).toBeInstanceOf(BackgroundJobArchiveError);
        return (error as BackgroundJobArchiveError).reason;
      }
      throw new Error('expected a refusal');
    };
    registerJob(service);
    registerJob(service, 'task-2', 'session-2');
    service.updateRuntimeState('task-1', 'unknown', { statusUncertain: true });
    service.markStale('task-2');

    // A non-terminal stale or uncertain row needs an ignore, never a reconcile.
    expect(refusal(() => service.markReconciled('task-1'))).toBe('uncertain_job_requires_ignore');
    expect(refusal(() => service.markReconciled('task-2'))).toBe('stale_job_requires_ignore');

    // A later sample settles task-1 back to ordinary running, after a caller read it as uncertain.
    service.updateRuntimeState('task-1', 'running', { statusUncertain: false });
    expect(refusal(() => service.markIgnored('task-1', 'Read as uncertain.', { refuseAwaitingCompletion: true }))).toBe('job_not_terminal');
    expect(service.resolve('task-1')).not.toHaveProperty('archivedAt');

    expect(service.markIgnored('task-2', 'Stale lane.', { refuseAwaitingCompletion: true })).toMatchObject({ archiveReason: 'ignored' });
    // An operator archive does not check state.
    expect(service.markIgnored('task-1', 'Operator archived')).toMatchObject({ archiveReason: 'ignored' });
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

  it('withdraws a prompt acknowledgement for a newly noted terminal conflict only, and needs a new notification to acknowledge again', () => {
    registerJob(service);
    service.markTerminal('task-1', 'completed', { resultSummary: 'done' });
    service.markPromptNotified(['task-1'], 'parent-1');
    service.markPromptAcknowledgedForSession('parent-1');

    const conflicted = service.markTerminal('task-1', 'error', { lastStatusError: 'late error' });
    expect(conflicted).toMatchObject({ runtimeState: 'completed', resultSummary: 'done', statusUncertain: true, promptBoardInjectionCount: 1 });
    expect(conflicted.lastStatusError).toContain('Conflicting terminal evidence');
    expect(conflicted.promptNotifiedAt).toBeDefined();
    expect(conflicted).not.toHaveProperty('promptAcknowledgedAt');
    expect(conflicted).not.toHaveProperty('promptNotifiedInSessionId');
    // A parent turn that ends before the conflict is shown does not acknowledge it.
    expect(service.markPromptAcknowledgedForSession('parent-1')).toEqual([]);

    expect(service.markPromptNotified(['task-1'], 'parent-1')[0]).toMatchObject({ promptNotifiedInSessionId: 'parent-1', promptBoardInjectionCount: 2 });
    expect(service.markPromptAcknowledgedForSession('parent-1')).toHaveLength(1);

    // The same conflict again is already noted: the acknowledgement stands and nothing is notified again.
    const repeated = service.markTerminal('task-1', 'error', { lastStatusError: 'late error' });
    expect(repeated.promptAcknowledgedAt).toBeDefined();
    expect(repeated.lastStatusError).toBe(conflicted.lastStatusError);
    expect(service.markPromptNotified(['task-1'], 'parent-1')).toEqual([]);
    expect(service.resolve('task-1')?.promptBoardInjectionCount).toBe(2);

    // An archived record's conflict is noted without reopening its prompt bookkeeping.
    service.markReconciled('task-1');
    const archived = service.markTerminal('task-1', 'cancelled');
    expect(archived.lastStatusError).toContain('later observation reported cancelled');
    expect(archived.promptAcknowledgedAt).toBeDefined();
  });

  it('classifies an unreadable or malformed board as a read failure and leaves the file as found', () => {
    fs.mkdirSync(path.dirname(BOARD_PATH), { recursive: true });
    for (const content of ['{"schemaVersion":1,"jobs":[', '[]', '{"jobs":{}}', 'null', '{}', '{"schemaVersion":1}']) {
      fs.writeFileSync(BOARD_PATH, content);
      expect(() => service.listScoped()).toThrow(BackgroundBoardReadError);
      expect(() => registerJob(service)).toThrow(BackgroundBoardReadError);
      expect(fs.readFileSync(BOARD_PATH, 'utf8')).toBe(content);
    }
    fs.rmSync(BOARD_PATH);
    fs.mkdirSync(BOARD_PATH);
    expect(() => service.listScoped()).toThrow(BackgroundBoardReadError);

    // Only an absent file is an empty board.
    fs.rmdirSync(BOARD_PATH);
    expect(service.listScoped()).toEqual([]);
    registerJob(service);
    expect(service.listScoped()).toHaveLength(1);
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

  it('replaces a preterminal diagnostic with the first terminal error', () => {
    registerJob(service);
    service.updateRuntimeState('task-1', 'unknown', {
      statusUncertain: true,
      lastStatusError: 'transient status miss',
    });

    const terminal = service.markTerminal('task-1', 'error', {
      statusUncertain: false,
      lastStatusError: 'provider disconnected',
    });

    expect(terminal).toMatchObject({
      runtimeState: 'error',
      statusUncertain: false,
      lastStatusError: 'provider disconnected',
    });
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

  describe('native observation owners', () => {
    const V2_BOARD_PATH = path.join(TEST_DIR, '.hive', 'runtime', 'opencode-v2', 'background-jobs.json');
    let v2: BackgroundJobService;

    beforeEach(() => {
      v2 = new BackgroundJobService(TEST_DIR, 'opencode-v2');
    });

    it('defaults to the v1 owner and rejects unknown owners at construction', () => {
      expect(service.owner).toBe('opencode-v1');
      expect(v2.owner).toBe('opencode-v2');
      expect(() => new BackgroundJobService(TEST_DIR, '../escape' as never)).toThrow('Unknown native observation owner');
    });

    it('writes the v2 board under its own runtime directory', () => {
      const record = v2.registerLaunch({
        taskId: 'task-v2',
        sessionId: 'session-v2',
        agentName: 'forager-worker',
        scope: { parentSessionId: 'parent-1' },
      });

      expect(record.alias).toBe('parent-1:job-1');
      expect(JSON.parse(fs.readFileSync(V2_BOARD_PATH, 'utf8')).jobs).toHaveLength(1);
      expect(fs.existsSync(BOARD_PATH)).toBe(false);
      expect(fs.readdirSync(path.dirname(V2_BOARD_PATH)).filter((name) => name.endsWith('.lock'))).toEqual([]);
    });

    it('never imports legacy v1 jobs into a missing v2 board and reads without creating it', () => {
      registerJob(service);
      const before = fs.readFileSync(BOARD_PATH, 'utf8');

      expect(v2.listScoped({}, { includeArchived: true })).toEqual([]);
      expect(v2.resolve('parent-1:job-1')).toBeUndefined();
      expect(fs.existsSync(path.join(TEST_DIR, '.hive', 'runtime'))).toBe(false);

      expect(() => v2.markIgnored('parent-1:job-1', 'wrong store')).toThrow('Background job not found');
      expect(fs.existsSync(V2_BOARD_PATH)).toBe(false);
      expect(fs.readFileSync(BOARD_PATH, 'utf8')).toBe(before);
    });

    it('keeps equal aliases and task IDs isolated between owners', () => {
      registerJob(service);
      registerJob(v2);

      v2.markIgnored('parent-1:job-1', 'v2 only');

      expect(v2.resolve('parent-1:job-1')?.archiveReason).toBe('ignored');
      expect(service.resolve('parent-1:job-1')?.archivedAt).toBeUndefined();
      expect(service.listScoped()).toHaveLength(1);
      expect(v2.listScoped()).toHaveLength(0);
    });
  });
});
