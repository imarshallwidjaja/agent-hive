import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

mock.module('vscode', () => {
  class TreeItem {
    label: string;
    collapsibleState: number;
    description?: string;
    contextValue?: string;
    iconPath?: unknown;
    command?: unknown;
    tooltip?: unknown;

    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }

  class ThemeIcon {
    constructor(public readonly id: string) {}
  }

  class EventEmitter<T> {
    readonly event = (_listener: (value: T | undefined) => void) => ({ dispose() {} });
    fire(_value: T | undefined): void {}
  }

  return {
    TreeItem,
    ThemeIcon,
    EventEmitter,
    Uri: {
      file(targetPath: string) {
        return { fsPath: targetPath };
      },
      parse(value: string) {
        return { value };
      },
    },
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
  };
});

const { BackgroundJobsProvider } = await import('./backgroundJobsProvider');

const TEST_ROOT_BASE = `/tmp/vscode-hive-background-jobs-test-${process.pid}`;

describe('BackgroundJobsProvider', () => {
  let testRoot: string;

  beforeEach(() => {
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
      jobs: [job({ alias: 'task-07', taskId: 'task-native-1', agentName: 'forager-worker', objective: 'Build viewers' })],
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
      arguments: [path.join(testRoot, '.hive', 'background-jobs.json'), 'task-native-1'],
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
    expect((jobs[0] as any).description).toBe('forager-worker · completed · terminal unreconciled');
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

  it('uses related worker prompt path as safe open command metadata when present', async () => {
    const workerPromptPath = path.join(testRoot, '.hive', 'features', 'feature-a', 'tasks', 'task-a', 'worker-prompt.md');
    writeJobs({
      schemaVersion: 1,
      jobs: [job({ alias: 'task-a', ownership: { workerPromptPath, worktreePath: '/tmp/worktree-a' } })],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();
    const jobs = await provider.getChildren(groups[0]);

    expect((jobs[0] as any).command).toMatchObject({
      command: 'hive.openFile',
      arguments: [workerPromptPath],
    });
    expect((jobs[0] as any).contextValue).toBe('background-job');
  });

  it('resolves relative worker prompt paths against the workspace root', async () => {
    writeJobs({
      schemaVersion: 1,
      jobs: [job({ alias: 'task-a', ownership: { workerPromptPath: '.hive/features/feature-a/tasks/task-a/worker-prompt.md' } })],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();
    const jobs = await provider.getChildren(groups[0]);

    expect((jobs[0] as any).command).toMatchObject({
      command: 'hive.openFile',
      arguments: [path.join(testRoot, '.hive', 'features', 'feature-a', 'tasks', 'task-a', 'worker-prompt.md')],
    });
  });

  it('uses related worktree path when no worker prompt is present', async () => {
    const worktreePath = path.join(testRoot, '.hive', '.worktrees', 'feature-a', 'task-a');
    writeJobs({
      schemaVersion: 1,
      jobs: [job({ alias: 'task-a', ownership: { worktreePath } })],
    });
    const provider = new BackgroundJobsProvider(testRoot);

    const groups = await provider.getChildren();
    const jobs = await provider.getChildren(groups[0]);

    expect((jobs[0] as any).command).toMatchObject({
      command: 'hive.openFile',
      arguments: [worktreePath],
    });
  });

  function writeJobs(data: unknown): void {
    fs.mkdirSync(path.join(testRoot, '.hive'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, '.hive', 'background-jobs.json'), JSON.stringify(data, null, 2));
  }

  function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      taskId: 'task-native-1',
      sessionId: 'session-1',
      agentName: 'forager-worker',
      description: 'Run worker',
      objective: undefined,
      createdAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z',
      runtimeState: 'running',
      alias: 'job-1',
      ...overrides,
    };
  }
});
