import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { resetVscodeTestState, vscodeTestDouble, vscodeTestState } from '../test/vscodeTestDouble.js';

mock.module('vscode', () => vscodeTestDouble);

const { BackgroundJobsProvider, archiveBackgroundJobItem, readBackgroundJobTarget } = await import('./backgroundJobsProvider');
const { BackgroundJobService } = await import('hive-core');

const TEST_ROOT_BASE = `/tmp/vscode-hive-background-jobs-test-${process.pid}`;

describe('BackgroundJobsProvider', () => {
  let testRoot: string;

  beforeEach(() => {
    resetVscodeTestState();
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'workspace-'));
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
  });

  it('shows a missing background job board state', async () => {
    const provider = new BackgroundJobsProvider(testRoot);

    const children = await provider.getChildren();

    expect(children.map(item => item.label)).toEqual(['No background jobs']);
    expect((children[0] as any).description).toBe('Missing .hive/background-jobs.json');
    expect((children[0] as any).command).toBeUndefined();
  });

  it('shows an empty background job board state', async () => {
    writeJobs({ schemaVersion: 1, jobs: [] });
    const provider = new BackgroundJobsProvider(testRoot);

    const children = await provider.getChildren();

    expect(children.map(item => item.label)).toEqual(['No background jobs']);
    expect((children[0] as any).description).toBe('0 jobs');
  });

  it('groups running jobs and renders job metadata', async () => {
    writeJobs({
      schemaVersion: 1,
      jobs: [job({ alias: 'task-07', taskId: 'task-native-1', agentName: 'forager-worker', description: 'Build viewers' })],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();
    const jobs = await provider.getChildren(groups[0]);

    expect(groups.map(item => item.label)).toEqual(['Running']);
    expect((groups[0] as any).description).toBe('1 job(s)');
    expect(jobs.map(item => item.label)).toEqual(['task-07']);
    expect((jobs[0] as any).description).toBe('forager-worker · running · Build viewers');
    expect((jobs[0] as any).tooltip).toContain('task-native-1');
    expect((jobs[0] as any).command).toMatchObject({
      command: 'hive.openBackgroundJobInBoard',
      arguments: ['opencode-v1', 'task-07'],
    });
  });

  it('groups terminal unreconciled jobs as needing reconciliation', async () => {
    writeJobs({
      schemaVersion: 1,
      jobs: [job({ alias: 'finished-task', runtimeState: 'completed', terminalUnreconciled: true, resultSummary: 'Done' })],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();
    const jobs = await provider.getChildren(groups[0]);

    expect(groups.map(item => item.label)).toEqual(['Needs Reconciliation']);
    expect((jobs[0] as any).description).toBe('forager-worker · completed · needs reconciliation');
  });

  it('groups cancel-requested jobs separately from running jobs', async () => {
    writeJobs({
      schemaVersion: 1,
      jobs: [job({ alias: 'stop-me', cancelRequestedAt: '2026-06-12T00:00:00.000Z', cancelReason: 'operator requested stop' })],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();
    const jobs = await provider.getChildren(groups[0]);

    expect(groups.map(item => item.label)).toEqual(['Cancel Requested']);
    expect((jobs[0] as any).description).toBe('forager-worker · running · cancel requested');
    expect((jobs[0] as any).tooltip).toContain('operator requested stop');
  });

  it('keeps ignored cancelled jobs out of active cancel-requested grouping', async () => {
    writeJobs({
      schemaVersion: 1,
      jobs: [job({
        alias: 'ignored-cancelled',
        runtimeState: 'cancelled',
        cancelRequestedAt: '2026-06-12T00:00:00.000Z',
        cancelReason: 'operator requested stop',
        ignoredAt: '2026-06-12T00:01:00.000Z',
        ignoreReason: 'stale lane ignored',
        archivedAt: '2026-06-12T00:01:00.000Z',
        archiveReason: 'ignored',
      })],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();
    const jobs = await provider.getChildren(groups[0]);

    expect(groups.map(item => item.label)).toEqual(['Ignored']);
    expect((groups[0] as any).collapsibleState).toBe(1);
    expect((jobs[0] as any).description).toBe('forager-worker · cancelled · ignored · cancel requested');
  });

  it('uses granular groups in lifecycle priority order', async () => {
    writeJobs({
      schemaVersion: 1,
      jobs: [
        job({ alias: 'finished', runtimeState: 'completed' }),
        job({ alias: 'ignored', runtimeState: 'cancelled', ignoredAt: '2026-06-12T00:01:00.000Z', archiveReason: 'ignored' }),
        job({ alias: 'reconciled', runtimeState: 'completed', reconciledAt: '2026-06-12T00:01:00.000Z', archiveReason: 'reconciled' }),
        job({ alias: 'stale', staleAt: '2026-06-12T00:00:30.000Z' }),
        job({ alias: 'stop-me', cancelRequestedAt: '2026-06-12T00:00:00.000Z' }),
        job({ alias: 'needs-action', runtimeState: 'completed', terminalUnreconciled: true }),
        job({ alias: 'running' }),
      ],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();

    expect(groups.map(item => item.label)).toEqual([
      'Running',
      'Needs Reconciliation',
      'Cancel Requested',
      'Stale / Uncertain',
      'Ignored',
      'Reconciled',
      'Finished',
    ]);
    expect((groups[4] as any).collapsibleState).toBe(1);
    expect((groups[5] as any).collapsibleState).toBe(1);
    expect((groups[6] as any).collapsibleState).toBe(1);
  });

  it('background job item exposes and copies the exact alias for row actions', async () => {
    writeJobs({
      schemaVersion: 1,
      jobs: [job({ taskId: 'archive-test-task', alias: 'archive-test-alias' })],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();
    const jobs = await provider.getChildren(groups[0]);
    const item = jobs[0] as any;

    expect(item.taskId).toBe('archive-test-task');
    expect(item.alias).toBe('archive-test-alias');
    expect(item.label).toBe('archive-test-alias');
    expect(item.copyCommand.arguments).toEqual(['archive-test-alias']);
  });

  it('opens duplicate native child rows by their distinct aliases', async () => {
    writeJobs({
      schemaVersion: 1,
      jobs: [
        job({ taskId: 'resumed-child', alias: 'parent:job-1' }),
        job({ taskId: 'resumed-child', alias: 'parent:job-2' }),
      ],
    });
    const provider = new BackgroundJobsProvider(testRoot);
    const groups = await provider.getChildren();
    const jobs = await provider.getChildren(groups[0]);

    expect(jobs.map((item: any) => item.command.arguments[1])).toEqual(['parent:job-1', 'parent:job-2']);
  });

  it('uses archiveable context value for non-archived jobs and archived context for archived jobs', async () => {
    writeJobs({
      schemaVersion: 1,
      jobs: [
        job({ alias: 'active-job' }),
        job({ alias: 'archived-job', runtimeState: 'cancelled', ignoredAt: '2026-06-12T00:01:00.000Z', archivedAt: '2026-06-12T00:01:00.000Z', archiveReason: 'ignored' }),
      ],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();
    expect(groups.map((g: any) => g.label)).toEqual(['Running', 'Ignored']);

    const active = await provider.getChildren(groups[0]);
    expect((active[0] as any).contextValue).toBe('background-job-archiveable');

    const archivedItems = await provider.getChildren(groups[1]);
    expect((archivedItems[0] as any).contextValue).toBe('background-job-archived');
  });

  it('opens non-worker background jobs at their board record when no related path exists', async () => {
    writeJobs({
      schemaVersion: 1,
      jobs: [job({ taskId: 'review-task', alias: 'review-job', agentName: 'code-reviewer', runtimeState: 'completed' })],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();
    const jobs = await provider.getChildren(groups[0]);

    expect((jobs[0] as any).command).toMatchObject({
      command: 'hive.openBackgroundJobInBoard',
      arguments: ['opencode-v1', 'review-job'],
    });
  });

  it('puts archived running jobs in Ignored group, not Running', async () => {
    writeJobs({
      schemaVersion: 1,
      jobs: [job({
        alias: 'archived-running',
        runtimeState: 'running',
        ignoredAt: '2026-06-12T00:01:00.000Z',
        ignoreReason: 'operator archived',
        archivedAt: '2026-06-12T00:01:00.000Z',
        archiveReason: 'ignored',
      })],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();
    expect(groups.map(item => item.label)).toEqual(['Ignored']);
  });

  it('puts archivedAt-only running job in Ignored group, not Running, and uses archived context', async () => {
    writeJobs({
      schemaVersion: 1,
      jobs: [job({
        alias: 'archivedAt-only',
        runtimeState: 'running',
        archivedAt: '2026-06-12T00:01:00.000Z',
      })],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();
    expect(groups.map((item: any) => item.label)).not.toContain('Running');
    expect(groups.map((item: any) => item.label)).toContain('Ignored');

    const jobs = await provider.getChildren(groups[0]);
    expect((jobs[0] as any).contextValue).toBe('background-job-archived');
    expect((jobs[0] as any).description).toContain('archived');
  });

  it('puts archived stale jobs in Ignored group, not Stale / Uncertain', async () => {
    writeJobs({
      schemaVersion: 1,
      jobs: [job({
        alias: 'archived-stale',
        runtimeState: 'running',
        staleAt: '2026-06-12T00:00:30.000Z',
        ignoredAt: '2026-06-12T00:01:00.000Z',
        ignoreReason: 'operator archived stale',
        archivedAt: '2026-06-12T00:01:00.000Z',
        archiveReason: 'ignored',
      })],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();
    expect(groups.map(item => item.label)).toEqual(['Ignored']);
  });

  describe('native observation owners', () => {
    it('keeps v1 rows unlabeled in the row but names the host in the tooltip', async () => {
      writeJobs({ schemaVersion: 1, jobs: [job({ alias: 'legacy' })] });
      const provider = new BackgroundJobsProvider(testRoot);

      const jobs = await provider.getChildren((await provider.getChildren())[0]);

      expect((jobs[0] as any).owner).toBe('opencode-v1');
      expect((jobs[0] as any).description).toBe('forager-worker · running · Run worker');
      expect((jobs[0] as any).tooltip).toContain('Host: OpenCode v1');
    });

    it('shows v2 jobs in the same groups with owner text, tooltip and an owner-based open command', async () => {
      writeJobs({ schemaVersion: 1, jobs: [job({ alias: 'native-1', agentName: 'scout-researcher' })] }, 'opencode-v2');
      const provider = new BackgroundJobsProvider(testRoot);

      const groups = await provider.getChildren();
      const jobs = await provider.getChildren(groups[0]);
      const item = jobs[0] as any;

      expect(groups.map(group => group.label)).toEqual(['Running']);
      expect(item.owner).toBe('opencode-v2');
      expect(item.description).toBe('scout-researcher · running · Run worker · OpenCode v2');
      expect(item.tooltip).toContain('Host: OpenCode v2');
      expect(item.command).toMatchObject({ command: 'hive.openBackgroundJobInBoard', arguments: ['opencode-v2', 'native-1'] });
      expect(item.copyCommand.arguments).toEqual(['native-1']);
    });

    it('keeps equal aliases from different owners as separate rows that carry their own owner', async () => {
      writeJobs({ schemaVersion: 1, jobs: [job({ alias: 'parent:job-1', taskId: 'v1-task' })] });
      writeJobs({ schemaVersion: 1, jobs: [job({ alias: 'parent:job-1', taskId: 'v2-task' })] }, 'opencode-v2');
      const provider = new BackgroundJobsProvider(testRoot);

      const groups = await provider.getChildren();
      const jobs = await provider.getChildren(groups[0]) as any[];

      expect(groups.map(group => group.label)).toEqual(['Running']);
      expect((groups[0] as any).description).toBe('2 job(s)');
      expect(jobs.map(item => [item.owner, item.taskId, item.alias])).toEqual([
        ['opencode-v1', 'v1-task', 'parent:job-1'],
        ['opencode-v2', 'v2-task', 'parent:job-1'],
      ]);
    });

    it('reports an unreadable owner board without hiding the healthy one', async () => {
      writeJobs('{ not json', 'opencode-v2');
      writeJobs({ schemaVersion: 1, jobs: [job({ alias: 'healthy' })] });
      const provider = new BackgroundJobsProvider(testRoot);

      const children = await provider.getChildren();

      expect(children.map(item => item.label)).toEqual(['Running', 'Unable to read background jobs']);
      expect((children[1] as any).description).toBe('Invalid .hive/runtime/opencode-v2/background-jobs.json');
      expect((children[1] as any).command.arguments).toEqual([boardFile('opencode-v2')]);
      expect((await provider.getChildren(children[0])).map(item => item.label)).toEqual(['healthy']);
    });

    for (const [damage, rows] of [
      ['a null row', [null]],
      ['a row without an alias', [{ alias: undefined, taskId: 'no-alias' }]],
      ['a non-string alias', [{ alias: 7 }]],
      ['an empty alias', [{ alias: '' }]],
      ['an array row', [['job-1']]],
      ['duplicate aliases', [{ alias: 'twin', taskId: 'a' }, { alias: 'twin', taskId: 'b' }]],
      // Row text and tooltip interpolate these fields; JSON objects with a non-callable toString cannot be turned into text.
      ['unprintable row text', [{ alias: 'poisoned', agentName: { toString: 0 } }]],
      ['an unprintable description', [{ alias: 'poisoned', description: { toString: 0 } }]],
      ['an unprintable runtime state', [{ alias: 'poisoned', runtimeState: { toString: 0 } }]],
      ['an unprintable tooltip task ID', [{ alias: 'poisoned', taskId: { toString: null } }]],
      ['an unprintable cancel reason', [{ alias: 'poisoned', cancelReason: { toString: 0 } }]],
      ['an unprintable result summary', [{ alias: 'poisoned', resultSummary: { toString: 0 } }]],
      ['an unprintable scope feature', [{ alias: 'poisoned', scope: { feature: { toString: 0 } } }]],
      ['an unprintable scope task', [{ alias: 'poisoned', scope: { task: { toString: null } } }]],
      ['a non-object scope', [{ alias: 'poisoned', scope: null }]],
    ] as const) {
      for (const damaged of ['opencode-v1', 'opencode-v2'] as const) {
        it(`reports a ${damaged} board with ${damage} as invalid without hiding or rewriting the healthy board`, async () => {
          const healthy = damaged === 'opencode-v1' ? 'opencode-v2' : 'opencode-v1';
          const damagedBoard = JSON.stringify({ schemaVersion: 1, jobs: rows.map(row => (row && typeof row === 'object' && !Array.isArray(row) ? job(row) : row)) });
          writeJobs(damagedBoard, damaged);
          writeJobs({ schemaVersion: 1, jobs: [job({ alias: 'healthy' })] }, healthy);
          const provider = new BackgroundJobsProvider(testRoot);

          const children = await provider.getChildren();

          expect(children.map(item => item.label)).toEqual(['Running', 'Unable to read background jobs']);
          expect((children[1] as any).description).toBe(`Invalid ${path.relative(testRoot, boardFile(damaged))}`);
          const jobRows = (await Promise.all(children.map(item => provider.getChildren(item)))).flat() as any[];
          expect(jobRows.map(item => [item.owner, item.alias, item.tooltip.split('\n')[0]])).toEqual([[healthy, 'healthy', 'Task ID: task-native-1']]);
          expect(fs.readFileSync(boardFile(damaged), 'utf-8')).toBe(damagedBoard);
        });
      }
    }

    it('gives equal-alias rows distinct ids that survive sibling removal and group moves', async () => {
      writeJobs({ schemaVersion: 1, jobs: [job({ alias: 'parent:job-1', taskId: 'v1-task' })] });
      writeJobs({ schemaVersion: 1, jobs: [job({ alias: 'parent:job-1', taskId: 'v2-task' })] }, 'opencode-v2');
      const provider = new BackgroundJobsProvider(testRoot);
      const rowIds = async () => {
        const ids = new Map<string, string>();
        for (const group of await provider.getChildren()) {
          for (const item of await provider.getChildren(group) as any[]) ids.set(`${item.owner}/${item.taskId}`, item.id);
        }
        return ids;
      };

      const before = await rowIds();
      expect(new Set(before.values()).size).toBe(2);
      const v2Id = before.get('opencode-v2/v2-task');

      writeJobs({ schemaVersion: 1, jobs: [] });
      expect((await rowIds()).get('opencode-v2/v2-task')).toBe(v2Id);

      writeJobs({ schemaVersion: 1, jobs: [job({ alias: 'parent:job-1', taskId: 'v2-task', runtimeState: 'completed' })] }, 'opencode-v2');
      writeJobs({ schemaVersion: 1, jobs: [job({ alias: 'parent:job-1', taskId: 'v1-task' })] });
      const groups = await provider.getChildren();
      expect(groups.map(group => group.label)).toEqual(['Running', 'Finished']);
      const moved = await rowIds();
      expect(moved.get('opencode-v2/v2-task')).toBe(v2Id);
      expect(moved.get('opencode-v1/v1-task')).toBe(before.get('opencode-v1/v1-task'));

      const treeIds = [...groups, ...(await Promise.all(groups.map(group => provider.getChildren(group)))).flat()].map(item => item.id);
      expect(new Set(treeIds).size).toBe(treeIds.length);
    });

    it('gives each owner its own stable state-row id when both boards are invalid', async () => {
      writeJobs('{ not json');
      writeJobs('{ not json', 'opencode-v2');
      const provider = new BackgroundJobsProvider(testRoot);

      const first = await provider.getChildren();
      const second = await provider.getChildren();

      expect(first.map(item => item.label)).toEqual(['Unable to read background jobs', 'Unable to read background jobs']);
      expect(new Set(first.map(item => item.id)).size).toBe(2);
      expect(second.map(item => item.id)).toEqual(first.map(item => item.id));
    });

    it('shows only the invalid state when every readable board is empty or missing', async () => {
      writeJobs('{ not json');
      const provider = new BackgroundJobsProvider(testRoot);

      const children = await provider.getChildren();

      expect(children.map(item => item.label)).toEqual(['Unable to read background jobs']);
      expect((children[0] as any).description).toBe('Invalid .hive/background-jobs.json');
    });

    it('reports an empty v2 board as empty and never mentions a missing v2 board', async () => {
      writeJobs({ schemaVersion: 1, jobs: [] }, 'opencode-v2');
      const provider = new BackgroundJobsProvider(testRoot);

      const children = await provider.getChildren();

      expect(children.map(item => item.label)).toEqual(['No background jobs']);
      expect((children[0] as any).description).toBe('0 jobs');
      expect((children[0] as any).command.arguments).toEqual([boardFile('opencode-v2')]);
    });

    describe('archive command', () => {
      const launch = (owner: 'opencode-v1' | 'opencode-v2', taskId = 'task-1') => {
        const service = new BackgroundJobService(testRoot, owner);
        service.registerLaunch({ taskId, sessionId: `${taskId}-session`, agentName: 'forager-worker', scope: { parentSessionId: 'parent' } });
        return service;
      };
      let refreshes: number;
      const refresh = () => { refreshes += 1; };
      beforeEach(() => { refreshes = 0; });

      it('archives only the selected owner record when aliases are equal', async () => {
        const v1 = launch('opencode-v1');
        const v2 = launch('opencode-v2');
        vscodeTestState.confirmations.push('Archive Job');
        vscodeTestState.inputs.push('stale lane');

        await archiveBackgroundJobItem(testRoot, { owner: 'opencode-v2', alias: 'parent:job-1' }, refresh);

        expect(v2.resolve('parent:job-1')).toMatchObject({ archiveReason: 'ignored', ignoreReason: 'stale lane' });
        expect(v1.resolve('parent:job-1')?.archivedAt).toBeUndefined();
        expect(vscodeTestState.warnings[0]).toContain('"parent:job-1" (OpenCode v2)');
        expect(vscodeTestState.messages).toEqual(['Hive: Background job "parent:job-1" (OpenCode v2) archived.']);
        expect(vscodeTestState.errors).toEqual([]);
        expect(refreshes).toBe(1);
      });

      it('reports a record that disappeared after confirmation and never falls back to another owner', async () => {
        const v1 = launch('opencode-v1');
        const v2 = launch('opencode-v2');
        // The confirmation awaits the operator; the native host rewrites its board meanwhile.
        vscodeTestState.confirmations.push(() => {
          fs.writeFileSync(boardFile('opencode-v2'), JSON.stringify({ schemaVersion: 1, jobs: [] }));
          return 'Archive Job';
        });
        vscodeTestState.inputs.push('');

        await archiveBackgroundJobItem(testRoot, { owner: 'opencode-v2', alias: 'parent:job-1' }, refresh);

        expect(vscodeTestState.errors).toEqual([
          'Hive: Could not archive background job "parent:job-1" (OpenCode v2) - Background job not found: parent:job-1',
        ]);
        expect(vscodeTestState.messages).toEqual([]);
        expect(refreshes).toBe(1);
        expect(v1.resolve('parent:job-1')?.archivedAt).toBeUndefined();
        expect(v2.resolve('parent:job-1')).toBeUndefined();
      });

      it('reports other archive failures without a success notice', async () => {
        launch('opencode-v1');
        // A second record whose task ID equals the alias makes the alias ambiguous on this board.
        launch('opencode-v1', 'parent:job-1');
        vscodeTestState.confirmations.push('Archive Job');
        vscodeTestState.inputs.push('');

        await archiveBackgroundJobItem(testRoot, { owner: 'opencode-v1', alias: 'parent:job-1' }, refresh);

        expect(vscodeTestState.errors).toHaveLength(1);
        expect(vscodeTestState.errors[0]).toStartWith('Hive: Could not archive background job "parent:job-1" (OpenCode v1) - Ambiguous background job identifier');
        expect(vscodeTestState.messages).toEqual([]);
        expect(refreshes).toBe(1);
      });

      it('does nothing when the operator cancels', async () => {
        const v2 = launch('opencode-v2');
        vscodeTestState.confirmations.push(undefined);

        await archiveBackgroundJobItem(testRoot, { owner: 'opencode-v2', alias: 'parent:job-1' }, refresh);

        expect(v2.resolve('parent:job-1')?.archivedAt).toBeUndefined();
        expect([vscodeTestState.messages, vscodeTestState.errors, refreshes]).toEqual([[], [], 0]);
      });

      it('rejects a row without a finite owner and exact alias before asking', async () => {
        await archiveBackgroundJobItem(testRoot, { owner: '../.hive', alias: 'parent:job-1' }, refresh);

        expect(vscodeTestState.errors).toEqual(['Hive: No background job selected']);
        expect(vscodeTestState.warnings).toEqual([]);
      });
    });

    it('accepts only a finite owner with a non-empty alias as a row target', () => {
      expect(readBackgroundJobTarget({ owner: 'opencode-v2', alias: 'a' })).toEqual({ owner: 'opencode-v2', alias: 'a' });
      for (const item of [undefined, null, {}, { alias: 'a' }, { owner: 'opencode-v1' }, { owner: 'opencode-v1', alias: '' },
        { owner: '../.hive', alias: 'a' }, { owner: 'opencode-v3', alias: 'a' }, { owner: 'opencode-v1', alias: 7 }]) {
        expect(readBackgroundJobTarget(item)).toBeUndefined();
      }
    });
  });

  function boardFile(owner: 'opencode-v1' | 'opencode-v2' = 'opencode-v1'): string {
    return owner === 'opencode-v1'
      ? path.join(testRoot, '.hive', 'background-jobs.json')
      : path.join(testRoot, '.hive', 'runtime', 'opencode-v2', 'background-jobs.json');
  }

  function writeJobs(data: unknown, owner: 'opencode-v1' | 'opencode-v2' = 'opencode-v1'): void {
    fs.mkdirSync(path.dirname(boardFile(owner)), { recursive: true });
    fs.writeFileSync(boardFile(owner), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }

  function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      taskId: 'task-native-1',
      sessionId: 'session-1',
      agentName: 'forager-worker',
      description: 'Run worker',
      createdAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z',
      runtimeState: 'running',
      alias: 'job-1',
      ...overrides,
    };
  }
});
