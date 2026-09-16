import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import simpleGit from 'simple-git';
import { ExecutionAttemptService } from './executionAttemptService.js';
import { ExecutionFinalizationService, type ExecutionFinalizationCheckpoint } from './executionFinalizationService.js';
import { TaskService } from './taskService.js';
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

async function initializeRepository(directory: string): Promise<void> {
  fs.mkdirSync(directory, { recursive: true });
  const git = simpleGit(directory);
  await git.init();
  await git.addConfig('user.email', 'hive@example.test');
  await git.addConfig('user.name', 'Hive Test');
  fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
  await git.add('-A');
  await git.commit('test: initialize repository\n\nCreate the finalization test baseline.');
}

function finalizationOptions(checkpoint?: (checkpoint: ExecutionFinalizationCheckpoint) => void) {
  return {
    ...(checkpoint ? { checkpoint } : {}),
    resolveWorktreePlacement: async (attempt: NonNullable<ReturnType<ExecutionAttemptService['getAttempt']>>) => {
      if (attempt.placement.kind !== 'worktree') throw new Error('Expected worktree placement');
      return {
        workspacePath: attempt.placement.workspacePath,
        repositories: await Promise.all(attempt.placement.workspaceIdentities.map(async (repositoryPath, index) => ({
          id: attempt.placement.kind === 'worktree' && attempt.placement.workspaceIdentities.length === 1
            ? 'root'
            : path.basename(repositoryPath),
          path: repositoryPath,
          branch: (await simpleGit(repositoryPath).revparse(['--abbrev-ref', 'HEAD'])).trim(),
        }))),
      };
    },
  };
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

  it('reuses a same-scope arm only when its placement matches', () => {
    const first = service.arm({
      kind: 'adhoc',
      runId: 'placement-bound-arm',
      originatingPrimarySession: 'primary-a',
      placement: { kind: 'in_place', directory: TEST_DIR },
    });

    expect(() => service.arm({
      kind: 'adhoc',
      runId: 'placement-bound-arm',
      originatingPrimarySession: 'primary-a',
      placement: {
        kind: 'worktree',
        workspaceIdentities: [worktree('placement-loser')],
        workspacePath: worktree('placement-loser'),
      },
    })).toThrow(/different placement/i);
    expect(service.getAttempt(first.attempt.id)).toMatchObject({
      phase: 'armed',
      placement: { kind: 'in_place', directory: fs.realpathSync(TEST_DIR) },
    });
  });

  it('persists ordered repository path and branch identity with a composite placement', () => {
    const api = worktree('composite-api');
    const web = worktree('composite-web');
    const repositories = [
      { id: 'api', path: api, branch: 'hive/api/task' },
      { id: 'web', path: web, branch: 'hive/web/task' },
    ];
    const attempt = service.arm({
      kind: 'adhoc',
      runId: 'composite-identity',
      originatingPrimarySession: 'primary-a',
      placement: {
        kind: 'worktree',
        workspacePath: TEST_DIR,
        workspaceIdentities: [api, web],
        repositories,
      },
    }).attempt;

    expect(attempt.placement).toMatchObject({ kind: 'worktree', repositories });
    expect(service.getAttempt(attempt.id)?.placement).toMatchObject({ kind: 'worktree', repositories });
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
    service.beginFinalization(attempt.id, {
      operationId: 'operation-quarantined', intentHash: 'intent-quarantined', reportInputHash: 'input-quarantined',
      status: 'completed', summary: 'Complete', repositories: [],
    });
    service.recordFinalizationReport(attempt.id, 'report.md', 'hash');
    service.recordFinalizationDisposition(attempt.id, { applied: true });
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

  it('retains a stopped worktree claim until every finalization receipt is durable', () => {
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

    const receipt = {
      operationId: 'operation-a',
      intentHash: 'intent-a',
      reportInputHash: 'report-input-a',
      status: 'completed' as const,
      summary: 'Complete',
      message: 'feat: complete task\n\nFinish the managed task.',
      repositories: [{ id: 'root', path: identity, branch: 'test-branch' }],
    };
    service.beginFinalization(attempt.id, receipt);
    service.recordRepositoryPreparation(attempt.id, 'root', 'baseline', 'tree');
    service.recordRepositoryResult(attempt.id, 'root', 'committed', 'commit');
    service.recordFinalizationReport(attempt.id, 'report.md', 'hash');
    service.recordFinalizationDisposition(attempt.id, { applied: true });
    expect(service.getAttempt(attempt.id)).toMatchObject({ phase: 'stopped' });
    expect(() => service.assertWorkspacesIdle([identity])).toThrow(/claimed/i);
    service.finalize(attempt.id, 'completed');
    service.assertWorkspacesIdle([identity]);
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

describe('ExecutionFinalizationService crash recovery', () => {
  afterEach(cleanup);

  async function stoppedTask(root: string, repository: string): Promise<{ attempts: ExecutionAttemptService; attemptId: string }> {
    setupTask('feature-a', '01-task');
    await initializeRepository(repository);
    const attempts = new ExecutionAttemptService(root, 'runtime-finalization');
    const attempt = attempts.arm({
      kind: 'task',
      featureName: 'feature-a',
      taskFolder: '01-task',
      originatingPrimarySession: 'primary-a',
      placement: {
        kind: 'worktree',
        workspaceIdentities: [fs.realpathSync(repository)],
        workspacePath: fs.realpathSync(repository),
        branch: (await simpleGit(repository).revparse(['--abbrev-ref', 'HEAD'])).trim(),
      },
    }).attempt;
    attempts.attachNext({
      originatingPrimarySession: 'primary-a',
      nativeCallId: 'call-a',
      selectedAgent: 'forager-worker',
      background: false,
    });
    attempts.observeBlockingStop({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', outputDefined: true });
    return { attempts, attemptId: attempt.id };
  }

  it('resumes idempotently after failure injection at every finalization checkpoint', async () => {
    const checkpoints: ExecutionFinalizationCheckpoint[] = [
      'before_intent',
      'after_intent',
      'after_repository_preparation:root',
      'after_repository_commit:root',
      'after_repository_receipt:root',
      'after_report_write',
      'after_report_receipt',
      'after_task_status',
      'after_disposition',
      'before_release',
    ];
    for (const checkpoint of checkpoints) {
      cleanup();
      fs.mkdirSync(TEST_DIR, { recursive: true });
      const repository = path.join(TEST_DIR, 'repo');
      const { attempts, attemptId } = await stoppedTask(TEST_DIR, repository);
      fs.writeFileSync(path.join(repository, 'change.txt'), `${checkpoint}\n`);
      let injected = false;
      const input = {
        attemptId,
        originatingPrimarySession: 'primary-a',
        status: 'completed' as const,
        summary: 'Implemented crash-safe finalization.',
        message: 'feat: finalize execution\n\nPersist Git and report receipts before releasing the claim.',
      };
      const failing = new ExecutionFinalizationService(TEST_DIR, finalizationOptions(current => {
          if (!injected && current === checkpoint) {
            injected = true;
            throw new Error(`injected:${checkpoint}`);
          }
        }), attempts);
      await expect(failing.finish(input)).rejects.toThrow(`injected:${checkpoint}`);
      expect(attempts.getAttempt(attemptId)?.phase).not.toBe('finalized');

      const recovered = await new ExecutionFinalizationService(
        TEST_DIR,
        finalizationOptions(),
        attempts,
      ).finish(input);
      expect(recovered.attempt).toMatchObject({ phase: 'finalized', observedOutcome: 'completed' });
      expect((await simpleGit(repository).log()).all).toHaveLength(2);
      expect(new TaskService(TEST_DIR).get('feature-a', '01-task')?.status).toBe('done');
    }
  });

  it('rejects active, foreign-primary, and ambiguous-HEAD finalization', async () => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const repository = path.join(TEST_DIR, 'repo');
    setupTask('feature-a', '01-task');
    await initializeRepository(repository);
    const attempts = new ExecutionAttemptService(TEST_DIR, 'runtime-finalization');
    const attempt = attempts.arm({
      kind: 'task', featureName: 'feature-a', taskFolder: '01-task', originatingPrimarySession: 'primary-a',
      placement: {
        kind: 'worktree',
        workspaceIdentities: [fs.realpathSync(repository)],
        workspacePath: fs.realpathSync(repository),
        branch: (await simpleGit(repository).revparse(['--abbrev-ref', 'HEAD'])).trim(),
      },
    }).attempt;
    attempts.attachNext({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', selectedAgent: 'forager-worker', background: false });
    const service = new ExecutionFinalizationService(TEST_DIR, finalizationOptions(), attempts);
    const input = {
      attemptId: attempt.id,
      originatingPrimarySession: 'primary-a',
      status: 'completed' as const,
      summary: 'Complete.',
      message: 'feat: complete task\n\nCreate the intended task commit.',
    };
    await expect(service.finish(input)).rejects.toThrow(/stopped evidence/i);
    attempts.observeBlockingStop({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', outputDefined: true });
    await expect(service.finish({ ...input, originatingPrimarySession: 'primary-b' })).rejects.toThrow(/originating primary/i);
    fs.writeFileSync(path.join(repository, 'change.txt'), 'change\n');
    const failing = new ExecutionFinalizationService(TEST_DIR, finalizationOptions(current => {
        if (current === 'after_repository_preparation:root') throw new Error('stop after preparation');
      }), attempts);
    await expect(failing.finish(input)).rejects.toThrow(/stop after preparation/);
    fs.writeFileSync(path.join(repository, 'other.txt'), 'other\n');
    await simpleGit(repository).add('-A').commit('test: move head\n\nCreate an unrelated conflicting commit.');
    await expect(service.finish(input)).rejects.toThrow(/ambiguously/i);
    expect(attempts.getAttempt(attempt.id)?.phase).toBe('stopped');
  });

  it('rejects index drift after repository preparation without creating a commit', async () => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const repository = path.join(TEST_DIR, 'repo');
    const { attempts, attemptId } = await stoppedTask(TEST_DIR, repository);
    fs.writeFileSync(path.join(repository, 'intended.txt'), 'intended\n');
    const input = {
      attemptId,
      originatingPrimarySession: 'primary-a',
      status: 'completed' as const,
      summary: 'Complete.',
      message: 'feat: immutable tree\n\nCommit only the tree captured by finalization intent.',
    };
    const failing = new ExecutionFinalizationService(TEST_DIR, finalizationOptions(checkpoint => {
      if (checkpoint === 'after_repository_preparation:root') throw new Error('prepared');
    }), attempts);
    await expect(failing.finish(input)).rejects.toThrow('prepared');
    fs.writeFileSync(path.join(repository, 'drift.txt'), 'drift\n');
    await simpleGit(repository).add('-A');

    await expect(new ExecutionFinalizationService(TEST_DIR, finalizationOptions(), attempts).finish(input))
      .rejects.toThrow(/index changed/i);
    expect((await simpleGit(repository).log()).all).toHaveLength(1);
  });

  it('rejects HEAD movement after a no-change preparation receipt', async () => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const repository = path.join(TEST_DIR, 'repo');
    const { attempts, attemptId } = await stoppedTask(TEST_DIR, repository);
    const input = {
      attemptId,
      originatingPrimarySession: 'primary-a',
      status: 'completed' as const,
      summary: 'No tracked changes.',
    };
    const failing = new ExecutionFinalizationService(TEST_DIR, finalizationOptions(checkpoint => {
      if (checkpoint === 'after_repository_preparation:root') throw new Error('prepared');
    }), attempts);
    await expect(failing.finish(input)).rejects.toThrow('prepared');
    fs.writeFileSync(path.join(repository, 'unrelated.txt'), 'unrelated\n');
    await simpleGit(repository).add('-A').commit('test: move no-change head\n\nInject unrelated history after preparation.');

    await expect(new ExecutionFinalizationService(TEST_DIR, finalizationOptions(), attempts).finish(input))
      .rejects.toThrow(/no-change intent/i);
    expect((await simpleGit(repository).log()).all).toHaveLength(2);
  });

  it.each([
    ['committed', 'tracked'],
    ['committed', 'untracked'],
    ['no_changes', 'tracked'],
    ['no_changes', 'untracked'],
  ] as const)(
    'rejects %s receipt retries with unstaged %s drift',
    async (result, drift) => {
      cleanup();
      fs.mkdirSync(TEST_DIR, { recursive: true });
      const repository = path.join(TEST_DIR, 'repo');
      const { attempts, attemptId } = await stoppedTask(TEST_DIR, repository);
      if (result === 'committed') fs.writeFileSync(path.join(repository, 'intended.txt'), 'intended\n');
      const input = {
        attemptId,
        originatingPrimarySession: 'primary-a',
        status: 'completed' as const,
        summary: 'Persist a repository result.',
        ...(result === 'committed'
          ? { message: 'feat: persist result\n\nRevalidate the durable repository receipt on retry.' }
          : {}),
      };
      const failing = new ExecutionFinalizationService(TEST_DIR, finalizationOptions(checkpoint => {
        if (checkpoint === 'after_repository_receipt:root') throw new Error('receipt persisted');
      }), attempts);
      await expect(failing.finish(input)).rejects.toThrow('receipt persisted');
      fs.writeFileSync(
        path.join(repository, drift === 'tracked' ? 'base.txt' : 'drift.txt'),
        'unstaged drift\n',
      );

      await expect(new ExecutionFinalizationService(TEST_DIR, finalizationOptions(), attempts).finish(input))
        .rejects.toThrow(/changed after its .* finalization receipt/i);
      expect(attempts.getAttempt(attemptId)?.phase).toBe('stopped');
      expect(() => attempts.assertWorkspacesIdle([repository])).toThrow(/claimed/i);
      expect((await simpleGit(repository).status()).isClean()).toBe(false);
    },
  );

  it.each([
    ['committed', 'tracked'],
    ['committed', 'untracked'],
    ['no_changes', 'tracked'],
    ['no_changes', 'untracked'],
  ] as const)('rejects composite %s receipt retries with unstaged %s drift before mutating another repository', async (result, drift) => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setupTask('feature-a', '01-task');
    const api = path.join(TEST_DIR, 'repos', 'api');
    const web = path.join(TEST_DIR, 'repos', 'web');
    await initializeRepository(api);
    await initializeRepository(web);
    const attempts = new ExecutionAttemptService(TEST_DIR, 'runtime-finalization');
    const repositories = await Promise.all([api, web].map(async repositoryPath => ({
      id: path.basename(repositoryPath),
      path: fs.realpathSync(repositoryPath),
      branch: (await simpleGit(repositoryPath).revparse(['--abbrev-ref', 'HEAD'])).trim(),
    })));
    const attempt = attempts.arm({
      kind: 'task', featureName: 'feature-a', taskFolder: '01-task', originatingPrimarySession: 'primary-a',
      placement: {
        kind: 'worktree',
        workspaceIdentities: repositories.map(repository => repository.path),
        repositories,
        workspacePath: fs.realpathSync(TEST_DIR),
      },
    }).attempt;
    attempts.attachNext({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', selectedAgent: 'forager-worker', background: false });
    attempts.observeBlockingStop({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', outputDefined: true });
    if (result === 'committed') fs.writeFileSync(path.join(api, 'api.txt'), 'api\n');
    fs.writeFileSync(path.join(web, 'web.txt'), 'web\n');
    const input = {
      attemptId: attempt.id,
      originatingPrimarySession: 'primary-a',
      status: 'completed' as const,
      summary: 'Composite finalization complete.',
      message: 'feat: finalize composite work\n\nReject drift before committing another repository.',
    };
    const failing = new ExecutionFinalizationService(TEST_DIR, finalizationOptions(checkpoint => {
      if (checkpoint === 'after_repository_receipt:api') throw new Error('api receipt persisted');
    }), attempts);
    await expect(failing.finish(input)).rejects.toThrow('api receipt persisted');
    fs.writeFileSync(
      path.join(api, drift === 'tracked' ? 'base.txt' : 'drift.txt'),
      'unstaged drift\n',
    );

    await expect(new ExecutionFinalizationService(TEST_DIR, finalizationOptions(), attempts).finish(input))
      .rejects.toThrow(new RegExp(`api changed after its ${result === 'committed' ? 'committed' : 'no-change'} finalization receipt`, 'i'));
    expect((await simpleGit(web).log()).all).toHaveLength(1);
    expect(attempts.getAttempt(attempt.id)?.phase).toBe('stopped');
    expect(() => attempts.assertWorkspacesIdle([api, web])).toThrow(/claimed/i);
  });

  it('fails closed when a commit hook mutates the immutable commit message', async () => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const repository = path.join(TEST_DIR, 'repo');
    const { attempts, attemptId } = await stoppedTask(TEST_DIR, repository);
    fs.writeFileSync(path.join(repository, 'change.txt'), 'change\n');
    const hookPath = path.join(repository, '.git', 'hooks', 'commit-msg');
    fs.writeFileSync(hookPath, '#!/bin/sh\nprintf "\\nhook mutation\\n" >> "$1"\n');
    fs.chmodSync(hookPath, 0o755);
    const input = {
      attemptId,
      originatingPrimarySession: 'primary-a',
      status: 'completed' as const,
      summary: 'Complete.',
      message: 'feat: validate commit\n\nReject commit-hook mutation before persisting a receipt.',
    };
    const finalizer = new ExecutionFinalizationService(TEST_DIR, finalizationOptions(), attempts);

    await expect(finalizer.finish(input)).rejects.toThrow(/ambiguously/i);
    expect((await simpleGit(repository).log()).all).toHaveLength(2);
    await expect(finalizer.finish(input)).rejects.toThrow(/ambiguously/i);
    expect((await simpleGit(repository).log()).all).toHaveLength(2);
  });

  it('adopts a composite repository commit without rolling back or duplicating it', async () => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setupTask('feature-a', '01-task');
    const api = path.join(TEST_DIR, 'repos', 'api');
    const web = path.join(TEST_DIR, 'repos', 'web');
    await initializeRepository(api);
    await initializeRepository(web);
    const attempts = new ExecutionAttemptService(TEST_DIR, 'runtime-finalization');
    const attempt = attempts.arm({
      kind: 'task', featureName: 'feature-a', taskFolder: '01-task', originatingPrimarySession: 'primary-a',
      placement: {
        kind: 'worktree',
        workspaceIdentities: [fs.realpathSync(api), fs.realpathSync(web)],
        repositories: [
          { id: 'api', path: fs.realpathSync(api), branch: (await simpleGit(api).revparse(['--abbrev-ref', 'HEAD'])).trim() },
          { id: 'web', path: fs.realpathSync(web), branch: (await simpleGit(web).revparse(['--abbrev-ref', 'HEAD'])).trim() },
        ],
        workspacePath: fs.realpathSync(TEST_DIR),
        branch: (await simpleGit(api).revparse(['--abbrev-ref', 'HEAD'])).trim(),
      },
    }).attempt;
    attempts.attachNext({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', selectedAgent: 'forager-worker', background: false });
    attempts.observeBlockingStop({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', outputDefined: true });
    fs.writeFileSync(path.join(api, 'api.txt'), 'api\n');
    fs.writeFileSync(path.join(web, 'web.txt'), 'web\n');
    const input = {
      attemptId: attempt.id,
      originatingPrimarySession: 'primary-a',
      status: 'completed' as const,
      summary: 'Composite finalization complete.',
      message: 'feat: finalize composite work\n\nCommit each repository with durable adoption receipts.',
    };
    const failing = new ExecutionFinalizationService(TEST_DIR, finalizationOptions(checkpoint => {
        if (checkpoint === 'after_repository_commit:api') throw new Error('crash after api commit');
      }), attempts);
    await expect(failing.finish(input)).rejects.toThrow(/crash after api commit/);
    expect((await simpleGit(api).log()).all).toHaveLength(2);
    expect((await simpleGit(web).log()).all).toHaveLength(1);

    await new ExecutionFinalizationService(TEST_DIR, finalizationOptions(), attempts).finish(input);
    expect((await simpleGit(api).log()).all).toHaveLength(2);
    expect((await simpleGit(web).log()).all).toHaveLength(2);
    expect(attempts.getAttempt(attempt.id)?.finalization?.repositories).toEqual([
      expect.objectContaining({ id: 'api', result: 'committed' }),
      expect.objectContaining({ id: 'web', result: 'committed' }),
    ]);
  });

  it('keeps a valid partial composite commit but rejects drift in the remaining repository', async () => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setupTask('feature-a', '01-task');
    const api = path.join(TEST_DIR, 'repos', 'api');
    const web = path.join(TEST_DIR, 'repos', 'web');
    await initializeRepository(api);
    await initializeRepository(web);
    const attempts = new ExecutionAttemptService(TEST_DIR, 'runtime-finalization');
    const attempt = attempts.arm({
      kind: 'task', featureName: 'feature-a', taskFolder: '01-task', originatingPrimarySession: 'primary-a',
      placement: {
        kind: 'worktree',
        workspaceIdentities: [fs.realpathSync(api), fs.realpathSync(web)],
        repositories: [
          { id: 'api', path: fs.realpathSync(api), branch: (await simpleGit(api).revparse(['--abbrev-ref', 'HEAD'])).trim() },
          { id: 'web', path: fs.realpathSync(web), branch: (await simpleGit(web).revparse(['--abbrev-ref', 'HEAD'])).trim() },
        ],
        workspacePath: fs.realpathSync(TEST_DIR),
        branch: (await simpleGit(api).revparse(['--abbrev-ref', 'HEAD'])).trim(),
      },
    }).attempt;
    attempts.attachNext({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', selectedAgent: 'forager-worker', background: false });
    attempts.observeBlockingStop({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', outputDefined: true });
    fs.writeFileSync(path.join(api, 'api.txt'), 'api\n');
    fs.writeFileSync(path.join(web, 'web.txt'), 'web\n');
    const input = {
      attemptId: attempt.id,
      originatingPrimarySession: 'primary-a',
      status: 'completed' as const,
      summary: 'Composite finalization complete.',
      message: 'feat: finalize composite work\n\nRetain valid partial history and reject remaining tree drift.',
    };
    const failing = new ExecutionFinalizationService(TEST_DIR, finalizationOptions(checkpoint => {
      if (checkpoint === 'after_repository_preparation:web') throw new Error('web prepared');
    }), attempts);
    await expect(failing.finish(input)).rejects.toThrow('web prepared');
    fs.writeFileSync(path.join(web, 'drift.txt'), 'drift\n');
    await simpleGit(web).add('-A');

    await expect(new ExecutionFinalizationService(TEST_DIR, finalizationOptions(), attempts).finish(input))
      .rejects.toThrow(/index changed/i);
    expect((await simpleGit(api).log()).all).toHaveLength(2);
    expect((await simpleGit(web).log()).all).toHaveLength(1);
  });

  it('skips Git for in-place and blocked attempts and preserves stale task status', async () => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setupTask('feature-a', '01-task');
    const attempts = new ExecutionAttemptService(TEST_DIR, 'runtime-finalization');
    const stale = attempts.arm({
      kind: 'task', featureName: 'feature-a', taskFolder: '01-task', originatingPrimarySession: 'primary-a',
      placement: { kind: 'in_place', directory: TEST_DIR },
    }).attempt;
    attempts.attachNext({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', selectedAgent: 'forager-worker', background: false });
    attempts.observeBlockingStop({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', outputDefined: true });
    const statusPath = path.join(TEST_DIR, '.hive', 'features', 'feature-a', 'tasks', '01-task', 'status.json');
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    status.workerAttempt += 1;
    status.status = 'in_progress';
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    const finalizer = new ExecutionFinalizationService(TEST_DIR, finalizationOptions(), attempts);
    await expect(finalizer.finish({
      attemptId: stale.id,
      originatingPrimarySession: 'primary-a',
      status: 'blocked',
      summary: 'Need operator input.',
      blocker: { reason: 'Decision required' },
      message: 'fix: forbidden\n\nThis message must be rejected.',
    })).rejects.toThrow(/does not accept/i);
    const result = await finalizer.finish({
      attemptId: stale.id,
      originatingPrimarySession: 'primary-a',
      status: 'blocked',
      summary: 'Need operator input.',
      blocker: { reason: 'Decision required' },
    });
    expect(result.currentTaskUnchanged).toBe(true);
    expect(new TaskService(TEST_DIR).get('feature-a', '01-task')?.status).toBe('in_progress');
    expect(result.attempt.finalization?.repositories).toEqual([]);
    expect(fs.existsSync(path.join(TEST_DIR, '.hive', 'features', 'feature-a', 'tasks', '01-task', 'report.md'))).toBe(false);
  });

  it('does not apply stale task disposition when the pointer changed but generation matches', async () => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setupTask('feature-a', '01-task');
    const attempts = new ExecutionAttemptService(TEST_DIR, 'runtime-finalization');
    const stale = attempts.arm({
      kind: 'task', featureName: 'feature-a', taskFolder: '01-task', originatingPrimarySession: 'primary-a',
      placement: { kind: 'in_place', directory: TEST_DIR },
    }).attempt;
    attempts.attachNext({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', selectedAgent: 'forager-worker', background: false });
    attempts.observeBlockingStop({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', outputDefined: true });
    const storePath = getExecutionAttemptsPath(TEST_DIR);
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    store.currentTaskAttempts['feature-a\u001f01-task'] = 'newer-attempt';
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

    const result = await new ExecutionFinalizationService(TEST_DIR, finalizationOptions(), attempts).finish({
      attemptId: stale.id,
      originatingPrimarySession: 'primary-a',
      status: 'failed',
      summary: 'Historical failure.',
    });
    expect(result.currentTaskUnchanged).toBe(true);
    expect(result.attempt.finalization?.disposition).toEqual({ applied: false });
    expect(new TaskService(TEST_DIR).get('feature-a', '01-task')?.status).toBe('pending');
    expect(fs.existsSync(path.join(TEST_DIR, '.hive', 'features', 'feature-a', 'tasks', '01-task', 'report.md'))).toBe(false);
  });

  it.each(['missing', 'tampered'] as const)('rejects finalized retry when its report is %s', async (damage) => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setupTask('feature-a', '01-task');
    const attempts = new ExecutionAttemptService(TEST_DIR, `runtime-report-${damage}`);
    const attempt = attempts.arm({
      kind: 'task', featureName: 'feature-a', taskFolder: '01-task', originatingPrimarySession: 'primary-a',
      placement: { kind: 'in_place', directory: TEST_DIR },
    }).attempt;
    attempts.attachNext({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', selectedAgent: 'forager-worker', background: false });
    attempts.observeBlockingStop({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', outputDefined: true });
    const input = {
      attemptId: attempt.id,
      originatingPrimarySession: 'primary-a',
      status: 'completed' as const,
      summary: 'Complete.',
    };
    const finalizer = new ExecutionFinalizationService(TEST_DIR, finalizationOptions(), attempts);
    const first = await finalizer.finish(input);
    if (damage === 'missing') fs.rmSync(first.reportPath);
    else fs.writeFileSync(first.reportPath, 'tampered\n');

    await expect(finalizer.finish(input)).rejects.toThrow(/missing or does not match/i);
  });

  it.each(['intact', 'missing', 'tampered'] as const)(
    'validates a finalized worktree retry after cleanup when its report is %s',
    async (reportState) => {
      cleanup();
      fs.mkdirSync(TEST_DIR, { recursive: true });
      const repository = path.join(TEST_DIR, 'repo');
      const { attempts, attemptId } = await stoppedTask(TEST_DIR, repository);
      fs.writeFileSync(path.join(repository, 'change.txt'), 'change\n');
      const input = {
        attemptId,
        originatingPrimarySession: 'primary-a',
        status: 'completed' as const,
        summary: 'Finalize before cleanup.',
        message: 'feat: finalize before cleanup\n\nAllow idempotent receipt verification after retirement.',
      };
      const finalizer = new ExecutionFinalizationService(TEST_DIR, finalizationOptions(), attempts);
      const first = await finalizer.finish(input);
      fs.rmSync(repository, { recursive: true });
      if (reportState === 'missing') fs.rmSync(first.reportPath);
      if (reportState === 'tampered') fs.writeFileSync(first.reportPath, 'tampered\n');

      if (reportState === 'intact') {
        await expect(finalizer.finish(input)).resolves.toMatchObject({ attempt: { phase: 'finalized' } });
      } else {
        await expect(finalizer.finish(input)).rejects.toThrow(/missing or does not match/i);
      }
    },
  );

  it('records blocked, partial, failed, and cancelled task dispositions', async () => {
    for (const disposition of ['blocked', 'partial', 'failed', 'cancelled'] as const) {
      cleanup();
      fs.mkdirSync(TEST_DIR, { recursive: true });
      setupTask('feature-a', '01-task');
      const attempts = new ExecutionAttemptService(TEST_DIR, `runtime-${disposition}`);
      const attempt = attempts.arm({
        kind: 'task', featureName: 'feature-a', taskFolder: '01-task', originatingPrimarySession: 'primary-a',
        placement: { kind: 'in_place', directory: TEST_DIR },
      }).attempt;
      attempts.attachNext({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', selectedAgent: 'forager-worker', background: false });
      attempts.observeBlockingStop({ originatingPrimarySession: 'primary-a', nativeCallId: 'call-a', outputDefined: true });
      const result = await new ExecutionFinalizationService(
        TEST_DIR,
        finalizationOptions(),
        attempts,
      ).finish({
        attemptId: attempt.id,
        originatingPrimarySession: 'primary-a',
        status: disposition,
        summary: `${disposition} disposition.`,
        ...(disposition === 'blocked' ? { blocker: { reason: 'Decision required' } } : {}),
      });
      expect(result.attempt).toMatchObject({ phase: 'finalized', observedOutcome: disposition });
      expect(new TaskService(TEST_DIR).get('feature-a', '01-task')?.status).toBe(disposition);
    }
  });
});
