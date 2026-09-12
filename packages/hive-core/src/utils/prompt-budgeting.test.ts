import { describe, expect, it } from 'bun:test';
import { applyTaskBudget, DEFAULT_BUDGET } from './prompt-budgeting.js';

describe('applyTaskBudget', () => {
  it('preserves aggregate diff metadata outside the summary budget', () => {
    const aggregateBranchDiff = {
      fileCount: 2,
      insertions: 8,
      deletions: 3,
      areas: ['packages', 'docs'],
      report: '.hive/features/example/tasks/01-task/report.md',
    };
    const result = applyTaskBudget(
      [{ name: '01-task', summary: 'A'.repeat(2500), aggregateBranchDiff }],
      { maxSummaryChars: 2000 },
    );
    expect(result.tasks[0].summary).toHaveLength(2000);
    expect(result.tasks[0].summary).toEndWith('...[truncated]');
    expect(result.tasks[0].aggregateBranchDiff).toEqual(aggregateBranchDiff);
  });

  it('keeps only the latest bounded task summaries and reports dropped tasks', () => {
    const tasks = Array.from({ length: 50 }, (_, index) => ({
      name: `${String(index + 1).padStart(2, '0')}-task`,
      summary: `Task ${index + 1}. `.repeat(300),
    }));
    const result = applyTaskBudget(tasks, { ...DEFAULT_BUDGET, feature: 'example' });
    expect(result.tasks).toHaveLength(DEFAULT_BUDGET.maxTasks);
    expect(result.tasks[0]!.name).toBe('41-task');
    expect(result.tasks.every(task => task.summary.length <= DEFAULT_BUDGET.maxSummaryChars)).toBe(true);
    expect(result.truncationEvents.some(event => event.type === 'tasks_dropped')).toBe(true);
    expect(result.droppedTasksHint).toContain('.hive/features/example/tasks');
  });

  it('leaves short histories unchanged', () => {
    const result = applyTaskBudget([{ name: '01-task', summary: 'Done.' }]);
    expect(result.tasks).toEqual([{
      name: '01-task',
      summary: 'Done.',
      aggregateBranchDiff: undefined,
      truncated: false,
      originalLength: undefined,
    }]);
    expect(result.truncationEvents).toEqual([]);
  });
});
