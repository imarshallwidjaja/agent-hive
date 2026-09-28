import { describe, expect, it } from 'bun:test';
import {
  buildEffectiveDependencies,
  computeRunnableAndBlocked,
  findUnfinishedDependencyViolation,
  TaskWithDeps,
} from './taskDependencyGraph.js';

describe('computeRunnableAndBlocked', () => {
  it('returns all pending tasks with no deps as runnable', () => {
    const tasks: TaskWithDeps[] = [
      { folder: '01-task-a', status: 'pending', dependsOn: [] },
      { folder: '02-task-b', status: 'pending', dependsOn: [] },
    ];

    const result = computeRunnableAndBlocked(tasks);

    expect(result.runnable).toEqual(['01-task-a', '02-task-b']);
    expect(result.blocked).toEqual({});
  });

  it('marks tasks with unmet deps as blocked', () => {
    const tasks: TaskWithDeps[] = [
      { folder: '01-task-a', status: 'pending', dependsOn: [] },
      { folder: '02-task-b', status: 'pending', dependsOn: ['01-task-a'] },
    ];

    const result = computeRunnableAndBlocked(tasks);

    expect(result.runnable).toEqual(['01-task-a']);
    expect(result.blocked).toEqual({
      '02-task-b': ['01-task-a'],
    });
  });

  it('marks tasks as runnable when all deps are done', () => {
    const tasks: TaskWithDeps[] = [
      { folder: '01-task-a', status: 'done', dependsOn: [] },
      { folder: '02-task-b', status: 'pending', dependsOn: ['01-task-a'] },
    ];

    const result = computeRunnableAndBlocked(tasks);

    expect(result.runnable).toEqual(['02-task-b']);
    expect(result.blocked).toEqual({});
  });

  it('excludes in_progress and done tasks from runnable list', () => {
    const tasks: TaskWithDeps[] = [
      { folder: '01-task-a', status: 'done', dependsOn: [] },
      { folder: '02-task-b', status: 'in_progress', dependsOn: [] },
      { folder: '03-task-c', status: 'pending', dependsOn: [] },
    ];

    const result = computeRunnableAndBlocked(tasks);

    // Only pending tasks can be runnable
    expect(result.runnable).toEqual(['03-task-c']);
    expect(result.blocked).toEqual({});
  });

  it('handles multiple dependencies correctly', () => {
    const tasks: TaskWithDeps[] = [
      { folder: '01-task-a', status: 'done', dependsOn: [] },
      { folder: '02-task-b', status: 'pending', dependsOn: [] },
      { folder: '03-task-c', status: 'pending', dependsOn: ['01-task-a', '02-task-b'] },
    ];

    const result = computeRunnableAndBlocked(tasks);

    // Task C is blocked because task B is not done yet
    expect(result.runnable).toEqual(['02-task-b']);
    expect(result.blocked).toEqual({
      '03-task-c': ['02-task-b'],
    });
  });

  it('reports only unmet dependencies in blocked list', () => {
    const tasks: TaskWithDeps[] = [
      { folder: '01-task-a', status: 'done', dependsOn: [] },
      { folder: '02-task-b', status: 'in_progress', dependsOn: [] },
      { folder: '03-task-c', status: 'pending', dependsOn: ['01-task-a', '02-task-b'] },
    ];

    const result = computeRunnableAndBlocked(tasks);

    // Only 02-task-b is unmet (in_progress is not done)
    expect(result.blocked).toEqual({
      '03-task-c': ['02-task-b'],
    });
  });

  it('handles diamond dependency pattern', () => {
    const tasks: TaskWithDeps[] = [
      { folder: '01-base', status: 'done', dependsOn: [] },
      { folder: '02-left', status: 'pending', dependsOn: ['01-base'] },
      { folder: '03-right', status: 'pending', dependsOn: ['01-base'] },
      { folder: '04-merge', status: 'pending', dependsOn: ['02-left', '03-right'] },
    ];

    const result = computeRunnableAndBlocked(tasks);

    // Tasks 2 and 3 are runnable (base is done)
    expect(result.runnable).toContain('02-left');
    expect(result.runnable).toContain('03-right');
    expect(result.runnable).toHaveLength(2);
    
    // Task 4 is blocked on both 2 and 3
    expect(result.blocked).toEqual({
      '04-merge': ['02-left', '03-right'],
    });
  });

  it('treats an omitted dependsOn like an explicit empty list, never inferring edges from folder numbers', () => {
    const omitted: TaskWithDeps[] = [
      { folder: '01-task-a', status: 'pending', dependsOn: undefined },
      { folder: '02-task-b', status: 'pending', dependsOn: undefined },
    ];
    const explicit: TaskWithDeps[] = omitted.map(task => ({ ...task, dependsOn: [] }));

    expect(buildEffectiveDependencies(omitted)).toEqual(new Map([['01-task-a', []], ['02-task-b', []]]));
    expect(computeRunnableAndBlocked(omitted)).toEqual({ runnable: ['01-task-a', '02-task-b'], blocked: {} });
    expect(computeRunnableAndBlocked(omitted)).toEqual(computeRunnableAndBlocked(explicit));
  });

  it('excludes cancelled/failed/blocked/partial from satisfying deps', () => {
    // These statuses do NOT satisfy dependencies
    const tasks: TaskWithDeps[] = [
      { folder: '01-cancelled', status: 'cancelled', dependsOn: [] },
      { folder: '02-failed', status: 'failed', dependsOn: [] },
      { folder: '03-blocked', status: 'blocked', dependsOn: [] },
      { folder: '04-partial', status: 'partial', dependsOn: [] },
      { folder: '05-dependent', status: 'pending', dependsOn: ['01-cancelled', '02-failed', '03-blocked', '04-partial'] },
    ];

    const result = computeRunnableAndBlocked(tasks);

    // Task 5 is blocked on all of them (none are 'done')
    expect(result.runnable).toEqual([]);
    expect(result.blocked['05-dependent']).toContain('01-cancelled');
    expect(result.blocked['05-dependent']).toContain('02-failed');
    expect(result.blocked['05-dependent']).toContain('03-blocked');
    expect(result.blocked['05-dependent']).toContain('04-partial');
  });

  it('returns empty arrays for no tasks', () => {
    const result = computeRunnableAndBlocked([]);

    expect(result.runnable).toEqual([]);
    expect(result.blocked).toEqual({});
  });

  it('manual task with explicit dependsOn blocks until deps are done', () => {
    const tasks: TaskWithDeps[] = [
      { folder: '01-task-a', status: 'pending', dependsOn: [] },
      { folder: '05-manual-fix', status: 'pending', dependsOn: ['01-task-a'] },
    ];

    const result = computeRunnableAndBlocked(tasks);

    expect(result.runnable).toEqual(['01-task-a']);
    expect(result.blocked).toEqual({
      '05-manual-fix': ['01-task-a'],
    });
  });

  it('manual task with explicit dependsOn becomes runnable when deps done', () => {
    const tasks: TaskWithDeps[] = [
      { folder: '01-task-a', status: 'done', dependsOn: [] },
      { folder: '05-manual-fix', status: 'pending', dependsOn: ['01-task-a'] },
    ];

    const result = computeRunnableAndBlocked(tasks);

    expect(result.runnable).toEqual(['05-manual-fix']);
    expect(result.blocked).toEqual({});
  });

});

describe('findUnfinishedDependencyViolation', () => {
  const UNFINISHED = ['pending', 'in_progress', 'blocked', 'failed', 'partial'] as const;
  const TERMINAL = ['done', 'cancelled'] as const;

  it('rejects missing, self, and cyclic outgoing edges of every unfinished status', () => {
    for (const status of UNFINISHED) {
      expect(findUnfinishedDependencyViolation([
        { folder: '01-source', status, dependsOn: ['09-missing'] },
      ])).toEqual({ kind: 'missing', source: '01-source', target: '09-missing' });

      expect(findUnfinishedDependencyViolation([
        { folder: '01-source', status, dependsOn: ['01-source'] },
      ])).toEqual({ kind: 'self', source: '01-source' });

      expect(findUnfinishedDependencyViolation([
        { folder: '01-source', status, dependsOn: ['02-peer'] },
        { folder: '02-peer', status: 'pending', dependsOn: ['01-source'] },
      ])).toEqual({ kind: 'cycle', path: ['01-source', '02-peer', '01-source'] });
    }
  });

  it('treats outgoing edges of done and cancelled tasks as history', () => {
    for (const status of TERMINAL) {
      expect(findUnfinishedDependencyViolation([
        { folder: '01-history', status, dependsOn: ['09-missing', '01-history', '02-consumer'] },
        { folder: '02-consumer', status: 'pending', dependsOn: ['01-history'] },
      ])).toBeNull();
    }
  });

  it('requires done and cancelled targets to exist while ending cycle traversal at them', () => {
    for (const status of TERMINAL) {
      expect(findUnfinishedDependencyViolation([
        { folder: '01-target', status, dependsOn: ['02-source'] },
        { folder: '02-source', status: 'pending', dependsOn: ['01-target'] },
      ])).toBeNull();
    }
    expect(findUnfinishedDependencyViolation([
      { folder: '02-source', status: 'pending', dependsOn: ['01-target'] },
    ])).toEqual({ kind: 'missing', source: '02-source', target: '01-target' });
  });

  it('checks an omitted dependsOn as no dependencies', () => {
    expect(findUnfinishedDependencyViolation([
      { folder: '01-task-a', status: 'pending', dependsOn: ['02-task-b'] },
      { folder: '02-task-b', status: 'pending', dependsOn: undefined },
    ])).toBeNull();
  });
});
