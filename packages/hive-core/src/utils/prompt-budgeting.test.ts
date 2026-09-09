import { describe, expect, it } from 'bun:test';
import { applyTaskBudget } from './prompt-budgeting.js';

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
});
