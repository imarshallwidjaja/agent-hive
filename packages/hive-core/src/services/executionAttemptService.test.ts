import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { ExecutionAttemptService } from './executionAttemptService.js';
import { SessionService } from './sessionService.js';
import { getExecutionAttemptsPath, getGlobalSessionsPath, readJson } from '../utils/paths.js';
import * as paths from '../utils/paths.js';
import type { ExecutionAttemptsJson, NativeTaskLease, TaskStatus } from '../types.js';

const TEST_DIR = '/tmp/hive-core-execution-attempt-test-' + process.pid;

function cleanup(): void {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
}

function setupFeature(featureName: string): void {
  const featurePath = path.join(TEST_DIR, '.hive', 'features', featureName);
  fs.mkdirSync(featurePath, { recursive: true });
  fs.writeFileSync(
    path.join(featurePath, 'feature.json'),
    JSON.stringify({ name: featureName, status: 'executing', createdAt: new Date().toISOString() }),
  );
}

function setupTask(featureName: string, taskFolder: string): void {
  const taskPath = path.join(TEST_DIR, '.hive', 'features', featureName, 'tasks', taskFolder);
  fs.mkdirSync(taskPath, { recursive: true });
  const status: TaskStatus = { status: 'pending', origin: 'plan', planTitle: taskFolder };
  fs.writeFileSync(path.join(taskPath, 'status.json'), JSON.stringify(status, null, 2));
}

function workspace(name: string): string {
  const dir = path.join(TEST_DIR, '.hive', '.worktrees', name, '01-task');
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

function workerAttempts(featureName: string, taskFolder: string): TaskStatus['workerAttempts'] {
  const statusPath = path.join(TEST_DIR, '.hive', 'features', featureName, 'tasks', taskFolder, 'status.json');
  return readJson<TaskStatus>(statusPath)?.workerAttempts;
}

function backdateAttempt(attemptId: string, minutesAgo: number): void {
  const filePath = getExecutionAttemptsPath(TEST_DIR);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ExecutionAttemptsJson;
  const attempt = data.attempts.find(candidate => candidate.id === attemptId);
  if (!attempt) throw new Error(`missing attempt ${attemptId}`);
  attempt.createdAt = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeLeases(leases: NativeTaskLease[]): void {
  const sessionsPath = getGlobalSessionsPath(TEST_DIR);
  fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
  const current = readJson<{ sessions?: unknown[]; executionOwnershipVersion?: number }>(sessionsPath) ?? { sessions: [] };
  fs.writeFileSync(sessionsPath, JSON.stringify({
    ...current,
    sessions: current.sessions ?? [],
    nativeTaskLeases: leases,
  }, null, 2));
}

describe('ExecutionAttemptService', () => {
  let service: ExecutionAttemptService;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setupFeature('feat-a');
    setupTask('feat-a', '01-a');
    setupFeature('feat-b');
    setupTask('feat-b', '01-b');
    service = new ExecutionAttemptService(TEST_DIR);
  });

  afterEach(() => {
    cleanup();
  });

  it('allows two prepares for different workspace identities', () => {
    const first = service.prepare({
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [workspace('a')],
    });
    const second = service.prepare({
      kind: 'task',
      featureName: 'feat-b',
      taskFolder: '01-b',
      originatingPrimarySession: 'primary-b',
      workspaceIdentities: [workspace('b')],
    });
    expect(first.existing).toBe(false);
    expect(second.existing).toBe(false);
    expect(first.attempt.id).not.toBe(second.attempt.id);
    expect(first.attempt.dispatchState).toBe('prepared');
    expect(second.attempt.dispatchState).toBe('prepared');
  });

  it('keeps exactly one active attempt for the same task and returns the existing attempt', () => {
    const input = {
      kind: 'task' as const,
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [workspace('a')],
    };
    const first = service.prepare(input);
    const second = service.prepare({ ...input, originatingPrimarySession: 'primary-other' });
    expect(second.existing).toBe(true);
    expect(second.attempt.id).toBe(first.attempt.id);
    expect(workerAttempts('feat-a', '01-a')).toEqual([
      expect.objectContaining({ attempt: 1, state: 'allocated' }),
    ]);
  });

  it('rejects a second task identity that claims the same workspace identity', () => {
    const shared = workspace('shared');
    service.prepare({
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [shared],
    });
    expect(() => service.prepare({
      kind: 'task',
      featureName: 'feat-b',
      taskFolder: '01-b',
      originatingPrimarySession: 'primary-b',
      workspaceIdentities: [shared],
    })).toThrow(/Workspace identity is claimed/);
    expect(workerAttempts('feat-b', '01-b')).toBeUndefined();
  });

  it('keeps an unobserved attempt claimed while a different workspace can still be prepared', () => {
    const first = service.prepare({
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [workspace('a')],
    });
    service.consumeLaunch(first.attempt.launchId!);
    service.markUnobserved(first.attempt.id);
    expect(() => service.assertWorkspacesIdle([workspace('a')])).toThrow(/claimed/);
    const other = service.prepare({
      kind: 'task',
      featureName: 'feat-b',
      taskFolder: '01-b',
      originatingPrimarySession: 'primary-b',
      workspaceIdentities: [workspace('b')],
    });
    expect(other.existing).toBe(false);
    expect(service.getAttempt(first.attempt.id)?.observation).toBe('unobserved');
    expect(service.getAttempt(first.attempt.id)?.dispatchState).toBe('dispatched');
  });

  it('supersedes onto a fresh workspace while the old workspace stays claimed', () => {
    const oldWorkspace = workspace('old');
    const prepared = service.prepare({
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [oldWorkspace],
    });
    service.consumeLaunch(prepared.attempt.launchId!);
    service.markUnobserved(prepared.attempt.id);
    const replacement = service.supersede(prepared.attempt.id, {
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [workspace('fresh')],
    });
    expect(replacement.existing).toBe(false);
    expect(replacement.attempt.id).not.toBe(prepared.attempt.id);
    expect(replacement.attempt.workspaceIdentities).not.toEqual(prepared.attempt.workspaceIdentities);
    expect(service.getAttempt(prepared.attempt.id)?.dispatchState).toBe('dispatched');
    expect(service.getAttempt(prepared.attempt.id)?.supersededBy).toBe(replacement.attempt.id);
    expect(() => service.assertWorkspacesIdle([oldWorkspace])).toThrow(/claimed/);
    expect(() => service.assertWorkspacesIdle(replacement.attempt.workspaceIdentities)).toThrow(/claimed/);
    expect(service.isCurrentTaskAttempt('feat-a', '01-a', prepared.attempt.id)).toBe(false);
    expect(service.isCurrentTaskAttempt('feat-a', '01-a', replacement.attempt.id)).toBe(true);
    expect(workerAttempts('feat-a', '01-a')).toHaveLength(2);
  });

  it('does not move the current-task pointer when a late record arrives on a superseded attempt', () => {
    const prepared = service.prepare({
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [workspace('old')],
    });
    service.consumeLaunch(prepared.attempt.launchId!);
    const replacement = service.supersede(prepared.attempt.id, {
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [workspace('fresh')],
    });
    const recorded = service.settle(prepared.attempt.id, 'completed', {
      reportLocator: '.hive/features/feat-a/tasks/01-a/report.md',
    });
    expect(recorded.observedOutcome).toBe('completed');
    expect(service.isCurrentTaskAttempt('feat-a', '01-a', prepared.attempt.id)).toBe(false);
    expect(service.isCurrentTaskAttempt('feat-a', '01-a', replacement.attempt.id)).toBe(true);
    const current = service.prepare({
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [workspace('ignored')],
    });
    expect(current.existing).toBe(true);
    expect(current.attempt.id).toBe(replacement.attempt.id);
  });

  it('rejects a placeholder native child and never stores it as a live child id', () => {
    const prepared = service.prepare({
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [workspace('a')],
    });
    expect(() => service.bindNativeChild(prepared.attempt.id, 'forager-child')).toThrow(/Placeholder native child/);
    expect(() => service.bindNativeChild(prepared.attempt.id, '')).toThrow(/Placeholder native child/);
    expect(service.getAttempt(prepared.attempt.id)?.nativeChildSessionId).toBeUndefined();
    const bound = service.bindNativeChild(prepared.attempt.id, 'ses_real-child');
    expect(bound.nativeChildSessionId).toBe('ses_real-child');
    expect(() => service.bindNativeChild(prepared.attempt.id, 'other-child')).toThrow(/Contradictory native child/);
  });

  it('releases a live claim when an observed terminal settles so the workspace can be prepared again', () => {
    const identity = workspace('a');
    const prepared = service.prepare({
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [identity],
    });
    service.consumeLaunch(prepared.attempt.launchId!);
    service.bindNativeChild(prepared.attempt.id, 'ses_worker');
    const settled = service.settle(prepared.attempt.id, 'completed');
    expect(settled.dispatchState).toBe('settled');
    expect(settled.observation).toBe('observed');
    service.assertWorkspacesIdle([identity]);
    const next = service.prepare({
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [identity],
    });
    expect(next.existing).toBe(false);
    expect(next.attempt.id).not.toBe(prepared.attempt.id);
  });

  it('expires a prepared attempt and releases its claim, and does not expire a dispatched attempt', () => {
    const preparedIdentity = workspace('prepared');
    const dispatchedIdentity = workspace('dispatched');
    const prepared = service.prepare({
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [preparedIdentity],
    });
    const dispatched = service.prepare({
      kind: 'task',
      featureName: 'feat-b',
      taskFolder: '01-b',
      originatingPrimarySession: 'primary-b',
      workspaceIdentities: [dispatchedIdentity],
    });
    service.consumeLaunch(dispatched.attempt.launchId!);
    backdateAttempt(prepared.attempt.id, 6);
    backdateAttempt(dispatched.attempt.id, 6);
    expect(service.listAttempts().find(attempt => attempt.id === prepared.attempt.id)?.dispatchState).toBe('settled');
    expect(service.getAttempt(prepared.attempt.id)?.observedOutcome).toBe('expired');
    service.assertWorkspacesIdle([preparedIdentity]);
    expect(service.getAttempt(dispatched.attempt.id)?.dispatchState).toBe('dispatched');
    expect(() => service.assertWorkspacesIdle([dispatchedIdentity])).toThrow(/claimed/);
  });

  it('migrates worktree leases into unobserved claims and keeps project-root and placeholder leases as history only', () => {
    const worktreePath = workspace('migrated');
    const leases: NativeTaskLease[] = [
      {
        parentSessionId: 'primary-1',
        callId: 'call-wt',
        agent: 'forager-worker',
        projectRoot: TEST_DIR,
        resourcePaths: [worktreePath],
        runtimeId: 'runtime',
        foragerLaunchId: 'launch-wt',
        childSessionId: 'ses_real-child',
      },
      {
        parentSessionId: 'primary-1',
        callId: 'call-root',
        agent: 'forager-worker',
        projectRoot: TEST_DIR,
        resourcePaths: [TEST_DIR],
        runtimeId: 'runtime',
        foragerLaunchId: 'launch-root',
      },
      {
        parentSessionId: 'primary-1',
        callId: 'call-helper',
        agent: 'hive-helper',
        projectRoot: TEST_DIR,
        resourcePaths: [worktreePath],
        runtimeId: 'runtime',
        capabilityReason: 'Need helper',
      },
      {
        parentSessionId: 'primary-1',
        callId: 'call-placeholder',
        agent: 'forager-worker',
        projectRoot: TEST_DIR,
        resourcePaths: [worktreePath],
        runtimeId: 'runtime',
        childSessionId: 'forager-child',
      },
      {
        parentSessionId: 'primary-1',
        callId: 'call-general',
        agent: 'general',
        projectRoot: TEST_DIR,
        resourcePaths: [worktreePath],
        runtimeId: 'runtime',
        capabilityReason: 'Specialist capability',
      },
    ];
    writeLeases(leases);
    service.migrate();
    const attempts = service.listAttempts().filter(attempt => attempt.nativeCallId === 'call-wt'
      || attempt.nativeCallId === 'call-root'
      || attempt.nativeCallId === 'call-helper'
      || attempt.nativeCallId === 'call-placeholder'
      || attempt.nativeCallId === 'call-general');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      dispatchState: 'dispatched',
      observation: 'unobserved',
      nativeCallId: 'call-wt',
      nativeChildSessionId: 'ses_real-child',
      launchId: 'launch-wt',
    });
    expect(attempts[0]!.workspaceIdentities).toEqual([worktreePath]);
    const store = readJson<ExecutionAttemptsJson>(getExecutionAttemptsPath(TEST_DIR));
    expect(store?.nativeTaskLeaseHistory).toHaveLength(5);
    const sessions = JSON.parse(fs.readFileSync(getGlobalSessionsPath(TEST_DIR), 'utf8'));
    expect(sessions.nativeTaskLeases).toBeUndefined();
    expect(sessions.executionOwnershipVersion).toBe(2);
    const before = fs.readFileSync(getExecutionAttemptsPath(TEST_DIR), 'utf8');
    service.migrate();
    expect(fs.readFileSync(getExecutionAttemptsPath(TEST_DIR), 'utf8')).toBe(before);
    expect(JSON.parse(fs.readFileSync(getGlobalSessionsPath(TEST_DIR), 'utf8')).nativeTaskLeases).toBeUndefined();
  });

  it('keeps nativeTaskLeases when the destination write fails and retries without duplicate live claims', () => {
    const worktreePath = workspace('crash-dest');
    const lease: NativeTaskLease = {
      parentSessionId: 'primary-crash',
      callId: 'call-crash-dest',
      agent: 'forager-worker',
      projectRoot: TEST_DIR,
      resourcePaths: [worktreePath],
      runtimeId: 'runtime',
      foragerLaunchId: 'launch-crash-dest',
      childSessionId: 'ses_crash-dest',
    };
    writeLeases([lease]);
    const originalWriteJsonAtomic = paths.writeJsonAtomic;
    const destWrite = spyOn(paths, 'writeJsonAtomic').mockImplementation((filePath, data) => {
      if (path.basename(String(filePath)) === 'execution-attempts.json') {
        throw new Error('injected dest write failure');
      }
      return originalWriteJsonAtomic(filePath, data);
    });
    try {
      expect(() => new ExecutionAttemptService(TEST_DIR)).toThrow(/injected dest write failure/);
    } finally {
      destWrite.mockRestore();
    }
    const sessions = JSON.parse(fs.readFileSync(getGlobalSessionsPath(TEST_DIR), 'utf8'));
    expect(sessions.nativeTaskLeases).toEqual([lease]);
    const retried = new ExecutionAttemptService(TEST_DIR);
    const live = retried.listAttempts().filter(attempt =>
      attempt.originatingPrimarySession === 'primary-crash' && attempt.nativeCallId === 'call-crash-dest'
      && attempt.dispatchState !== 'settled');
    expect(live).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(getGlobalSessionsPath(TEST_DIR), 'utf8')).nativeTaskLeases).toBeUndefined();
  });

  it('retries source clear after the destination exists without duplicating live claims', () => {
    const worktreePath = workspace('crash-source');
    const lease: NativeTaskLease = {
      parentSessionId: 'primary-crash',
      callId: 'call-crash-source',
      agent: 'forager-worker',
      projectRoot: TEST_DIR,
      resourcePaths: [worktreePath],
      runtimeId: 'runtime',
      foragerLaunchId: 'launch-crash-source',
      childSessionId: 'ses_crash-source',
    };
    writeLeases([lease]);
    const originalExtract = SessionService.prototype.extractNativeTaskLeases;
    const extract = spyOn(SessionService.prototype, 'extractNativeTaskLeases').mockImplementation(function (this: SessionService) {
      if (fs.existsSync(getExecutionAttemptsPath(TEST_DIR))) {
        throw new Error('injected source clear failure');
      }
      return originalExtract.apply(this);
    });
    try {
      expect(() => new ExecutionAttemptService(TEST_DIR)).toThrow(/injected source clear failure/);
    } finally {
      extract.mockRestore();
    }
    expect(fs.existsSync(getExecutionAttemptsPath(TEST_DIR))).toBe(true);
    expect(JSON.parse(fs.readFileSync(getGlobalSessionsPath(TEST_DIR), 'utf8')).nativeTaskLeases).toEqual([lease]);
    const retried = new ExecutionAttemptService(TEST_DIR);
    retried.migrate();
    const live = retried.listAttempts().filter(attempt =>
      attempt.originatingPrimarySession === 'primary-crash' && attempt.nativeCallId === 'call-crash-source'
      && attempt.dispatchState !== 'settled');
    expect(live).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(getGlobalSessionsPath(TEST_DIR), 'utf8')).nativeTaskLeases).toBeUndefined();
  });

  it('rejects a claimed workspace in assertWorkspacesIdle and allows an unrelated identity', () => {
    const claimed = workspace('claimed');
    service.prepare({
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [claimed],
    });
    expect(() => service.assertWorkspacesIdle([claimed])).toThrow(/claimed/);
    service.assertWorkspacesIdle([workspace('unrelated')]);
  });

  it('returns an existing ad-hoc run while prepared and rejects reuse after it is unobserved', () => {
    const identity = workspace('adhoc');
    const first = service.prepare({
      kind: 'adhoc',
      runId: 'run-1',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [identity],
    });
    const again = service.prepare({
      kind: 'adhoc',
      runId: 'run-1',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [identity],
    });
    expect(again.existing).toBe(true);
    expect(again.attempt.id).toBe(first.attempt.id);
    service.consumeLaunch(first.attempt.launchId!);
    service.markUnobserved(first.attempt.id);
    expect(() => service.prepare({
      kind: 'adhoc',
      runId: 'run-1',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [workspace('adhoc-fresh')],
    })).toThrow(/unobserved and cannot be reused/);
  });

  it('persists attemptSlot and records a published assignment after prepare', () => {
    const identity = workspace('slotted');
    const prepared = service.prepare({
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [identity],
      attemptSlot: 'attempt-2',
    });
    expect(prepared.attempt.attemptSlot).toBe('attempt-2');
    expect(prepared.attempt.assignment?.taskAttempt).toBe(1);
    const recorded = service.recordAssignment(prepared.attempt.id, {
      taskAttempt: 1,
      locator: '.hive/features/feat-a/tasks/01-a/assignments/attempt-1.md',
      contentHash: 'a'.repeat(64),
    });
    expect(recorded.assignment).toEqual({
      taskAttempt: 1,
      locator: '.hive/features/feat-a/tasks/01-a/assignments/attempt-1.md',
      contentHash: 'a'.repeat(64),
    });
    const handoff = service.recordHandoff(prepared.attempt.id, {
      reportLocator: '.hive/features/feat-a/tasks/01-a/report.md',
    });
    expect(handoff.reportLocator).toBe('.hive/features/feat-a/tasks/01-a/report.md');
    expect(handoff.dispatchState).toBe('prepared');
  });

  it('does not create execution-attempts.json on a clean project', () => {
    expect(service.listAttempts()).toEqual([]);
    expect(fs.existsSync(getExecutionAttemptsPath(TEST_DIR))).toBe(false);
    expect(fs.existsSync(getGlobalSessionsPath(TEST_DIR))).toBe(false);
  });

  it('restores observation on a dispatched attempt without changing dispatch state', () => {
    const prepared = service.prepare({
      kind: 'task',
      featureName: 'feat-a',
      taskFolder: '01-a',
      originatingPrimarySession: 'primary-a',
      workspaceIdentities: [workspace('observed')],
    });
    service.consumeLaunch(prepared.attempt.launchId!);
    service.markUnobserved(prepared.attempt.id);
    const restored = service.markObserved(prepared.attempt.id);
    expect(restored.observation).toBe('observed');
    expect(restored.dispatchState).toBe('dispatched');
  });
});
