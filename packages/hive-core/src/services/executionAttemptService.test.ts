import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { ExecutionAttemptService } from './executionAttemptService.js';
import { getExecutionAttemptsPath, getGlobalSessionsPath } from '../utils/paths.js';
import type { NativeTaskLease, TaskStatus } from '../types.js';

const TEST_DIR = `/tmp/hive-core-execution-attempt-test-${process.pid}`;

function cleanup(): void {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
}

function setupTask(featureName: string, taskFolder: string): void {
  const featurePath = path.join(TEST_DIR, '.hive', 'features', featureName);
  const taskPath = path.join(featurePath, 'tasks', taskFolder);
  fs.mkdirSync(taskPath, { recursive: true });
  fs.writeFileSync(
    path.join(featurePath, 'feature.json'),
    JSON.stringify({ name: featureName, status: 'executing', createdAt: new Date().toISOString() }),
  );
  const status: TaskStatus = { status: 'pending', origin: 'plan', planTitle: taskFolder };
  fs.writeFileSync(path.join(taskPath, 'status.json'), JSON.stringify(status, null, 2));
}

function worktree(name: string): string {
  const directory = path.join(TEST_DIR, '.hive', '.worktrees', name, '01-task');
  fs.mkdirSync(directory, { recursive: true });
  return fs.realpathSync(directory);
}

describe('ExecutionAttemptService armed native attachment', () => {
  let service: ExecutionAttemptService;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setupTask('feature-a', '01-task');
    setupTask('feature-b', '01-task');
    service = new ExecutionAttemptService(TEST_DIR, 'runtime-a');
  });

  afterEach(cleanup);

  it('arms one next dispatch per authenticated parent and attaches it exactly once', () => {
    const armed = service.arm({
      kind: 'task',
      featureName: 'feature-a',
      taskFolder: '01-task',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'worktree', workspaceIdentities: [worktree('feature-a')], workspacePath: worktree('feature-a') },
    }).attempt;

    expect(armed.phase).toBe('armed');
    expect(() => service.arm({
      kind: 'adhoc',
      runId: 'other',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'in_place', directory: TEST_DIR },
    })).toThrow(/already has an armed execution/i);

    const attached = service.attachNext({
      originatingPrimarySession: 'primary-a',
      nativeCallId: 'call-a',
      selectedAgent: 'forager-worker',
      background: false,
    });
    expect(attached).toMatchObject({
      id: armed.id,
      phase: 'attached',
      native: {
        parentSessionId: 'primary-a',
        callId: 'call-a',
        selectedAgent: 'forager-worker',
        background: false,
      },
    });
    expect(() => service.attachNext({
      originatingPrimarySession: 'primary-a',
      nativeCallId: 'call-b',
      selectedAgent: 'forager-worker',
      background: false,
    })).toThrow(/no armed execution/i);
  });

  it('does not treat in-place placement as an exclusive filesystem claim', () => {
    service.arm({
      kind: 'adhoc',
      runId: 'run-a',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'in_place', directory: TEST_DIR },
    });
    const second = service.arm({
      kind: 'adhoc',
      runId: 'run-b',
      originatingPrimarySession: 'primary-b',
      placement: { kind: 'in_place', directory: TEST_DIR },
    });
    expect(second.attempt.placement).toEqual({ kind: 'in_place', directory: fs.realpathSync(TEST_DIR) });
    service.assertWorkspacesIdle([TEST_DIR]);
  });

  it('serializes parent arms across service instances and rejects intersecting worktree claims', () => {
    const shared = worktree('shared');
    service.arm({
      kind: 'adhoc',
      runId: 'first',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'worktree', workspaceIdentities: [shared], workspacePath: shared },
    });
    const concurrent = new ExecutionAttemptService(TEST_DIR, 'runtime-a');
    expect(() => concurrent.arm({
      kind: 'adhoc',
      runId: 'second',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'in_place', directory: TEST_DIR },
    })).toThrow(/already has an armed execution/i);
    expect(() => concurrent.arm({
      kind: 'adhoc',
      runId: 'third',
      originatingPrimarySession: 'primary-b',
      placement: { kind: 'worktree', workspaceIdentities: [shared], workspacePath: shared },
    })).toThrow(/claimed/i);
  });

  it('reuses a same-scope arm only for its originating primary', () => {
    const identity = worktree('owned-arm');
    const first = service.arm({
      kind: 'adhoc',
      runId: 'owned-arm',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'worktree', workspaceIdentities: [identity], workspacePath: identity },
    });
    const repeated = service.arm({
      kind: 'adhoc',
      runId: 'owned-arm',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'worktree', workspaceIdentities: [identity], workspacePath: identity },
    });

    expect(repeated).toMatchObject({ existing: true, attempt: { id: first.attempt.id, phase: 'armed' } });
    expect(() => service.arm({
      kind: 'adhoc',
      runId: 'owned-arm',
      originatingPrimarySession: 'primary-b',
      placement: { kind: 'worktree', workspaceIdentities: [identity], workspacePath: identity },
    })).toThrow(/another primary/i);
    expect(service.getAttempt(first.attempt.id)).toMatchObject({
      phase: 'armed',
      originatingPrimarySession: 'primary-a',
    });
  });

  it('preflights same-scope ownership without creating another attempt', () => {
    const first = service.arm({
      kind: 'adhoc',
      runId: 'owned-preflight',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'in_place', directory: TEST_DIR },
    }).attempt;
    const before = fs.readFileSync(getExecutionAttemptsPath(TEST_DIR), 'utf8');

    expect(service.preflightArm({
      kind: 'adhoc',
      runId: 'owned-preflight',
      originatingPrimarySession: 'primary-a',
    })).toMatchObject({ id: first.id, phase: 'armed' });
    expect(() => service.preflightArm({
      kind: 'adhoc',
      runId: 'owned-preflight',
      originatingPrimarySession: 'primary-b',
    })).toThrow(/another primary/i);
    expect(fs.readFileSync(getExecutionAttemptsPath(TEST_DIR), 'utf8')).toBe(before);
  });

  it('serializes cleanup reservation with execution admission', () => {
    const identity = worktree('cleanup-reservation');
    const reservation = service.reserveWorkspaceCleanup([identity]);
    expect(reservation.reserved).toBe(true);
    if (!reservation.reserved) throw new Error('Expected cleanup reservation');

    const concurrent = new ExecutionAttemptService(TEST_DIR, 'runtime-a');
    expect(() => concurrent.arm({
      kind: 'adhoc',
      runId: 'blocked-by-cleanup',
      originatingPrimarySession: 'primary-b',
      placement: { kind: 'worktree', workspaceIdentities: [identity], workspacePath: identity },
    })).toThrow(/reserved for cleanup/i);

    service.releaseWorkspaceCleanup(reservation.reservation.id);
    expect(concurrent.arm({
      kind: 'adhoc',
      runId: 'accepted-after-cleanup',
      originatingPrimarySession: 'primary-b',
      placement: { kind: 'worktree', workspaceIdentities: [identity], workspacePath: identity },
    }).attempt.phase).toBe('armed');
  });

  it('ignores unrelated finalized attempt history when reserving cleanup', () => {
    const identity = worktree('finalized-history');
    const history = service.arm({
      kind: 'adhoc',
      runId: 'finalized-history',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'worktree', workspaceIdentities: [identity], workspacePath: identity },
    }).attempt;
    service.closeArmNotStarted(history.id);

    const reservation = service.reserveWorkspaceCleanup([identity]);
    expect(reservation.reserved).toBe(true);
    if (reservation.reserved) service.releaseWorkspaceCleanup(reservation.reservation.id);
  });

  it('protects the exact captured winner when it finalizes before cleanup reservation', () => {
    const identity = worktree('finalized-winner');
    const winner = service.arm({
      kind: 'adhoc',
      runId: 'finalized-winner',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'worktree', workspaceIdentities: [identity], workspacePath: identity },
    }).attempt;
    service.closeArmNotStarted(winner.id);

    expect(service.reserveWorkspaceCleanup([identity], winner.id)).toEqual({
      reserved: false,
      claimedAttempt: expect.objectContaining({ id: winner.id, phase: 'finalized' }),
    });
  });

  it('keeps attached worktrees quarantined until finalization', () => {
    const identity = worktree('quarantined');
    const attempt = service.arm({
      kind: 'task',
      featureName: 'feature-a',
      taskFolder: '01-task',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'worktree', workspaceIdentities: [identity], workspacePath: identity },
    }).attempt;
    service.attachNext({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', selectedAgent: 'forager-worker', background: false });
    expect(() => service.assertWorkspacesIdle([identity])).toThrow(/claimed/);
    service.observeBlockingStop({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', outputDefined: true });
    expect(service.getAttempt(attempt.id)?.phase).toBe('stopped');
    expect(() => service.assertWorkspacesIdle([identity])).toThrow(/claimed/);
    service.finalize(attempt.id, 'completed');
    service.assertWorkspacesIdle([identity]);
  });

  it('closes foreign-runtime arms as not started but preserves attached attempts across restart', () => {
    const unstarted = service.arm({
      kind: 'task',
      featureName: 'feature-a',
      taskFolder: '01-task',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'worktree', workspaceIdentities: [worktree('unstarted')], workspacePath: worktree('unstarted') },
    }).attempt;
    const attached = service.arm({
      kind: 'task',
      featureName: 'feature-b',
      taskFolder: '01-task',
      originatingPrimarySession: 'primary-b',
      placement: { kind: 'worktree', workspaceIdentities: [worktree('attached')], workspacePath: worktree('attached') },
    }).attempt;
    service.attachNext({ originatingPrimarySession: 'primary-b', nativeCallId: 'call-b', selectedAgent: 'forager-worker', background: true });

    const restarted = new ExecutionAttemptService(TEST_DIR, 'runtime-b');
    expect(restarted.getAttempt(unstarted.id)).toMatchObject({ phase: 'finalized', observedOutcome: 'not_started' });
    expect(restarted.getAttempt(attached.id)?.phase).toBe('attached');
  });

  it('expires only armed attempts and records not-started closure', () => {
    const armed = service.arm({
      kind: 'adhoc',
      runId: 'expiring',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'worktree', workspaceIdentities: [worktree('expiring')], workspacePath: worktree('expiring') },
    }).attempt;
    const storePath = getExecutionAttemptsPath(TEST_DIR);
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    store.attempts[0].expiresAt = new Date(Date.now() - 1).toISOString();
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

    expect(service.getAttempt(armed.id)).toMatchObject({ phase: 'finalized', observedOutcome: 'not_started' });
  });

  it('rejects stale task generations at attachment without consuming the arm', () => {
    const armed = service.arm({
      kind: 'task',
      featureName: 'feature-a',
      taskFolder: '01-task',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'worktree', workspaceIdentities: [worktree('stale')], workspacePath: worktree('stale') },
    }).attempt;
    const statusPath = path.join(TEST_DIR, '.hive', 'features', 'feature-a', 'tasks', '01-task', 'status.json');
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    status.workerAttempt += 1;
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));

    expect(() => service.attachNext({
      originatingPrimarySession: 'primary-a',
      nativeCallId: 'call-stale',
      selectedAgent: 'forager-worker',
      background: false,
    })).toThrow(/superseded/i);
    expect(service.getAttempt(armed.id)?.phase).toBe('armed');
  });

  it('enriches the exact attached call with one child identity', () => {
    const attempt = service.arm({
      kind: 'adhoc',
      runId: 'child',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'in_place', directory: TEST_DIR },
    }).attempt;
    service.attachNext({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', selectedAgent: 'forager-worker', background: false });
    const enriched = service.bindNativeChild({
      originatingPrimarySession: 'primary-a',
      nativeCallId: 'call-a',
      nativeChildSessionId: 'ses-child',
    });
    expect(enriched.native?.childSessionId).toBe('ses-child');
    expect(service.getAttempt(attempt.id)?.native?.childSessionId).toBe('ses-child');
    expect(() => service.bindNativeChild({
      originatingPrimarySession: 'primary-a',
      nativeCallId: 'call-a',
      nativeChildSessionId: 'ses-other',
    })).toThrow(/contradictory/i);
  });

  it('accepts defined blocking output but not undefined output as stop evidence', () => {
    const attempt = service.arm({
      kind: 'adhoc',
      runId: 'blocking',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'in_place', directory: TEST_DIR },
    }).attempt;
    service.attachNext({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', selectedAgent: 'forager-worker', background: false });
    expect(service.observeBlockingStop({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', outputDefined: false })).toBeUndefined();
    expect(service.getAttempt(attempt.id)?.phase).toBe('attached');
    expect(service.observeBlockingStop({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', outputDefined: true })?.phase).toBe('stopped');
  });

  it('persists blocked, failed, and partial bridge dispositions through finalization', () => {
    for (const outcome of ['blocked', 'failed', 'partial'] as const) {
      const attempt = service.arm({
        kind: 'adhoc',
        runId: `handoff-${outcome}`,
        originatingPrimarySession: `primary-${outcome}`,
        placement: { kind: 'in_place', directory: TEST_DIR },
      }).attempt;
      service.attachNext({
        originatingPrimarySession: `primary-${outcome}`,
        nativeCallId: `call-${outcome}`,
        selectedAgent: 'forager-worker',
        background: false,
      });
      service.recordHandoff(attempt.id, { outcome });
      const stopped = service.observeBlockingStop({
        originatingPrimarySession: `primary-${outcome}`,
        nativeCallId: `call-${outcome}`,
        outputDefined: true,
      })!;
      service.finalize(stopped.id, stopped.handoffOutcome!);
      expect(service.getAttempt(attempt.id)).toMatchObject({
        phase: 'finalized',
        handoffOutcome: outcome,
        observedOutcome: outcome,
      });
    }
  });

  it('rejects handoff mutation after native stop while retaining the worktree claim', () => {
    const identity = worktree('stopped-handoff');
    const attempt = service.arm({
      kind: 'task',
      featureName: 'feature-a',
      taskFolder: '01-task',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'worktree', workspaceIdentities: [identity], workspacePath: identity },
    }).attempt;
    service.attachNext({
      originatingPrimarySession: 'primary-a',
      nativeCallId: 'call-a',
      selectedAgent: 'forager-worker',
      background: false,
    });
    service.bindNativeChild({
      originatingPrimarySession: 'primary-a',
      nativeCallId: 'call-a',
      nativeChildSessionId: 'child-a',
    });
    service.observeBlockingStop({
      originatingPrimarySession: 'primary-a',
      nativeCallId: 'call-a',
      outputDefined: true,
    });

    expect(() => service.recordHandoff(attempt.id, { outcome: 'completed' })).toThrow(/not attached/i);
    expect(service.getAttempt(attempt.id)).toMatchObject({ phase: 'stopped' });
    expect(() => service.assertWorkspacesIdle([identity])).toThrow(/claimed/i);
  });

  it('requires exact structured background identity', () => {
    const attempt = service.arm({
      kind: 'adhoc',
      runId: 'background',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'in_place', directory: TEST_DIR },
    }).attempt;
    service.attachNext({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', selectedAgent: 'forager-worker', background: true });
    service.bindNativeChild({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', nativeChildSessionId: 'task-a' });
    expect(service.getAttempt(attempt.id)?.phase).toBe('attached');
    expect(() => service.observeBackgroundStop({
      originatingPrimarySession: 'primary-other',
      nativeCallId: 'call-a',
      nativeTaskId: 'task-a',
      state: 'completed',
    })).toThrow(/exact attached execution/i);
    expect(service.observeBackgroundStop({
      originatingPrimarySession: 'primary-a',
      nativeCallId: 'call-a',
      nativeTaskId: 'task-a',
      state: 'completed',
    }).phase).toBe('stopped');
  });

  it('migrates legacy prepared attempts closed and dispatched attempts quarantined', () => {
    cleanup();
    fs.mkdirSync(path.dirname(getExecutionAttemptsPath(TEST_DIR)), { recursive: true });
    const preparedPath = worktree('legacy-prepared');
    const attachedPath = worktree('legacy-dispatched');
    fs.writeFileSync(getExecutionAttemptsPath(TEST_DIR), JSON.stringify({
      schemaVersion: 1,
      attempts: [
        {
          id: 'legacy-prepared', kind: 'adhoc', runId: 'prepared', originatingPrimarySession: 'primary-a',
          workspaceIdentities: [preparedPath], launchId: 'old-launch', dispatchState: 'prepared',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
        {
          id: 'legacy-dispatched', kind: 'adhoc', runId: 'dispatched', originatingPrimarySession: 'primary-b',
          workspaceIdentities: [attachedPath], launchId: 'old-launch-2', dispatchState: 'dispatched',
          nativeCallId: 'call-b', nativeChildSessionId: 'child-b',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
      ],
    }, null, 2));

    const migrated = new ExecutionAttemptService(TEST_DIR, 'runtime-new');
    expect(migrated.getAttempt('legacy-prepared')).toMatchObject({ phase: 'finalized', observedOutcome: 'not_started' });
    expect(migrated.getAttempt('legacy-dispatched')).toMatchObject({
      phase: 'attached',
      placement: { kind: 'worktree', workspaceIdentities: [attachedPath] },
      native: { parentSessionId: 'primary-b', callId: 'call-b', childSessionId: 'child-b' },
    });
    const persisted = JSON.parse(fs.readFileSync(getExecutionAttemptsPath(TEST_DIR), 'utf8'));
    expect(persisted.schemaVersion).toBe(2);
    expect(JSON.stringify(persisted)).not.toContain('old-launch');
  });

  it('extracts legacy native leases once and preserves exact live worktree quarantine', () => {
    const identity = worktree('lease-migration');
    const lease: NativeTaskLease = {
      parentSessionId: 'legacy-parent',
      callId: 'legacy-call',
      agent: 'forager-worker',
      projectRoot: TEST_DIR,
      resourcePaths: [identity],
      runtimeId: 'legacy-runtime',
      childSessionId: 'legacy-child',
    };
    fs.mkdirSync(path.dirname(getGlobalSessionsPath(TEST_DIR)), { recursive: true });
    fs.writeFileSync(getGlobalSessionsPath(TEST_DIR), JSON.stringify({ sessions: [], nativeTaskLeases: [lease] }, null, 2));

    const migrated = new ExecutionAttemptService(TEST_DIR, 'runtime-new');
    expect(migrated.listAttempts().find(attempt => attempt.native?.callId === 'legacy-call')).toMatchObject({
      phase: 'attached',
      placement: { kind: 'worktree', workspaceIdentities: [identity] },
      native: { parentSessionId: 'legacy-parent', childSessionId: 'legacy-child' },
    });
    expect(JSON.parse(fs.readFileSync(getGlobalSessionsPath(TEST_DIR), 'utf8')).nativeTaskLeases).toBeUndefined();
    const before = fs.readFileSync(getExecutionAttemptsPath(TEST_DIR), 'utf8');
    migrated.migrate();
    expect(fs.readFileSync(getExecutionAttemptsPath(TEST_DIR), 'utf8')).toBe(before);
  });

  it('enriches a migrated composite attempt from its matching custom Forager lease', () => {
    cleanup();
    fs.mkdirSync(path.dirname(getExecutionAttemptsPath(TEST_DIR)), { recursive: true });
    const workspaceRoot = path.join(TEST_DIR, '.hive', '.worktrees', 'feature-a', '01-task');
    const api = path.join(workspaceRoot, 'repos', 'api');
    const web = path.join(workspaceRoot, 'repos', 'web');
    fs.mkdirSync(api, { recursive: true });
    fs.mkdirSync(web, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(getExecutionAttemptsPath(TEST_DIR), JSON.stringify({
      schemaVersion: 1,
      attempts: [{
        id: 'legacy-composite', kind: 'task', featureName: 'feature-a', taskFolder: '01-task',
        originatingPrimarySession: 'legacy-parent', workspaceIdentities: [api, web],
        dispatchState: 'dispatched', nativeCallId: 'legacy-call', createdAt: now, updatedAt: now,
      }],
    }, null, 2));
    const lease: NativeTaskLease = {
      parentSessionId: 'legacy-parent', callId: 'legacy-call', agent: 'custom-forager',
      projectRoot: TEST_DIR, resourcePaths: [api, web], runtimeId: 'legacy-runtime', childSessionId: 'legacy-child',
    };
    fs.writeFileSync(getGlobalSessionsPath(TEST_DIR), JSON.stringify({ sessions: [], nativeTaskLeases: [lease] }, null, 2));

    const migrated = new ExecutionAttemptService(TEST_DIR, 'runtime-new').getAttempt('legacy-composite');
    expect(migrated).toMatchObject({
      phase: 'attached',
      placement: {
        kind: 'worktree',
        workspaceIdentities: [fs.realpathSync(api), fs.realpathSync(web)],
        workspacePath: fs.realpathSync(workspaceRoot),
      },
      native: { selectedAgent: 'custom-forager', childSessionId: 'legacy-child' },
    });
  });
});
