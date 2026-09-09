/**
 * Tests for deterministic prompt budgeting utilities.
 *
 * These utilities limit history/context included in prompts to bound growth:
 * - Include only last N completed tasks
 * - Truncate each task summary to max M chars
 * - Apply max budget for inlined context
 * - Emit warnings when budgets cause truncation
 */

import { describe, it, expect } from 'bun:test';
import {
  applyTaskBudget,
  applyContextBudget,
  prioritizeContextForTask,
  DEFAULT_BUDGET,
  type BudgetConfig,
  type BudgetedTask,
  type BudgetedContext,
  type TruncationEvent,
} from './prompt-budgeting.js';

describe('prioritizeContextForTask', () => {
  it('orders current-task and nearer dependency context before recency', () => {
    const dependencies = new Map([
      ['04-current', ['03-near']],
      ['03-near', ['01-far']],
      ['01-far', []],
    ]);
    const files = [
      { name: 'untagged-newest', content: 'u', updatedAt: '2026-09-09T05:00:00.000Z' },
      { name: 'far-newer', content: 'f', updatedAt: '2026-09-09T04:00:00.000Z', task: '01-far' },
      { name: 'near-older', content: 'n', updatedAt: '2026-09-09T01:00:00.000Z', task: '03-near' },
      { name: 'current-oldest', content: 'c', updatedAt: '2026-09-08T01:00:00.000Z', task: '04-current' },
    ];

    expect(prioritizeContextForTask(files, '04-current', dependencies).map(file => file.name)).toEqual([
      'current-oldest',
      'near-older',
      'far-newer',
      'untagged-newest',
    ]);
  });

  it('preserves deterministic recency and name ordering for untagged and unrelated context', () => {
    const files = [
      { name: 'zeta', content: 'z', updatedAt: '2026-09-09T01:00:00.000Z' },
      { name: 'unrelated', content: 'x', updatedAt: '2026-09-09T02:00:00.000Z', task: '99-other' },
      { name: 'alpha', content: 'a', updatedAt: '2026-09-09T01:00:00.000Z' },
    ];

    expect(prioritizeContextForTask(files, '04-current', new Map()).map(file => file.name)).toEqual([
      'unrelated',
      'alpha',
      'zeta',
    ]);
  });

  it('sorts valid timestamps by recency and keeps invalid timestamps behind them', () => {
    const files = [
      { name: 'invalid-zeta', content: 'z', updatedAt: 'not-a-timestamp' },
      { name: 'valid-older', content: 'o', updatedAt: '2026-09-08T01:00:00.000Z' },
      { name: 'invalid-alpha', content: 'a', updatedAt: '2026-99-99T99:99:99Z' },
      { name: 'valid-newer', content: 'n', updatedAt: '2026-09-09T01:00:00.000Z' },
    ];

    expect(prioritizeContextForTask(files, '04-current', new Map()).map(file => file.name)).toEqual([
      'valid-newer',
      'valid-older',
      'invalid-alpha',
      'invalid-zeta',
    ]);
  });

  it('terminates and ranks each task once when dependencies contain a cycle', () => {
    const dependencies = new Map([
      ['03-current', ['02-middle']],
      ['02-middle', ['01-foundation']],
      ['01-foundation', ['02-middle']],
    ]);
    const files = [
      { name: 'foundation', content: 'f', updatedAt: '2026-09-09T03:00:00.000Z', task: '01-foundation' },
      { name: 'middle', content: 'm', updatedAt: '2026-09-09T02:00:00.000Z', task: '02-middle' },
      { name: 'current', content: 'c', updatedAt: '2026-09-09T01:00:00.000Z', task: '03-current' },
    ];

    expect(prioritizeContextForTask(files, '03-current', dependencies).map(file => file.name)).toEqual([
      'current',
      'middle',
      'foundation',
    ]);
  });
});

// ============================================================================
// Task Budgeting Tests
// ============================================================================

describe('applyTaskBudget', () => {
  it('limits to last N completed tasks', () => {
    const tasks = [
      { name: '01-task', summary: 'First task' },
      { name: '02-task', summary: 'Second task' },
      { name: '03-task', summary: 'Third task' },
      { name: '04-task', summary: 'Fourth task' },
      { name: '05-task', summary: 'Fifth task' },
    ];

    const result = applyTaskBudget(tasks, { maxTasks: 3 });

    expect(result.tasks.length).toBe(3);
    // Should keep the LAST 3 tasks (most recent)
    expect(result.tasks.map(t => t.name)).toEqual(['03-task', '04-task', '05-task']);
  });

  it('truncates task summaries exceeding max chars', () => {
    const longSummary = 'A'.repeat(500);
    const tasks = [{ name: '01-task', summary: longSummary }];

    const result = applyTaskBudget(tasks, { maxSummaryChars: 100 });

    expect(result.tasks[0].summary.length).toBeLessThanOrEqual(100 + 20); // Allow for truncation marker
    expect(result.tasks[0].summary).toContain('...[truncated]');
    expect(result.tasks[0].truncated).toBe(true);
  });

  it('retains structured aggregate diff metadata outside the summary budget', () => {
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

  it('preserves short summaries unchanged', () => {
    const tasks = [{ name: '01-task', summary: 'Short summary' }];

    const result = applyTaskBudget(tasks, { maxSummaryChars: 100 });

    expect(result.tasks[0].summary).toBe('Short summary');
    expect(result.tasks[0].truncated).toBe(false);
  });

  it('emits truncation events when tasks are dropped', () => {
    const tasks = [
      { name: '01-task', summary: 'First' },
      { name: '02-task', summary: 'Second' },
      { name: '03-task', summary: 'Third' },
    ];

    const result = applyTaskBudget(tasks, { maxTasks: 2 });

    expect(result.truncationEvents.length).toBeGreaterThan(0);
    expect(result.truncationEvents.some(e => e.type === 'tasks_dropped')).toBe(true);
    const dropEvent = result.truncationEvents.find(e => e.type === 'tasks_dropped');
    expect(dropEvent?.count).toBe(1); // 1 task dropped
  });

  it('emits truncation events when summaries are truncated', () => {
    const longSummary = 'A'.repeat(500);
    const tasks = [{ name: '01-task', summary: longSummary }];

    const result = applyTaskBudget(tasks, { maxSummaryChars: 100 });

    expect(result.truncationEvents.some(e => e.type === 'summary_truncated')).toBe(true);
  });

  it('returns all tasks when under limit', () => {
    const tasks = [
      { name: '01-task', summary: 'First' },
      { name: '02-task', summary: 'Second' },
    ];

    const result = applyTaskBudget(tasks, { maxTasks: 10 });

    expect(result.tasks.length).toBe(2);
    expect(result.truncationEvents.length).toBe(0);
  });

  it('handles empty task list', () => {
    const result = applyTaskBudget([], { maxTasks: 5 });

    expect(result.tasks.length).toBe(0);
    expect(result.truncationEvents.length).toBe(0);
  });

  it('includes file path hint for dropped tasks', () => {
    const tasks = [
      { name: '01-task', summary: 'First' },
      { name: '02-task', summary: 'Second' },
      { name: '03-task', summary: 'Third' },
    ];

    const result = applyTaskBudget(tasks, { maxTasks: 2, feature: 'test-feature' });

    expect(result.droppedTasksHint).toContain('01-task');
    expect(result.droppedTasksHint).toContain('.hive/features/test-feature/tasks');
  });
});

// ============================================================================
// Context Budgeting Tests
// ============================================================================

describe('applyContextBudget', () => {
  it('truncates context files exceeding max chars', () => {
    const longContent = 'B'.repeat(10000);
    const files = [{ name: 'decisions', content: longContent }];

    const result = applyContextBudget(files, { maxContextChars: 1000 });

    expect(result.files[0].content.length).toBeLessThanOrEqual(1000 + 50); // Allow for marker
    expect(result.files[0].content).toContain('...[truncated]');
    expect(result.files[0].truncated).toBe(true);
  });

  it('switches to name-only listing when total exceeds budget', () => {
    const files = [
      { name: 'file1', content: 'A'.repeat(5000) },
      { name: 'file2', content: 'B'.repeat(5000) },
      { name: 'file3', content: 'C'.repeat(5000) },
    ];

    const result = applyContextBudget(files, { maxTotalContextChars: 5000 });

    // Should include some files in full/truncated form, then switch to name-only
    expect(result.truncationEvents.some(e => e.type === 'context_names_only')).toBe(true);
  });

  it('keeps freshness visible when a context file becomes name-only', () => {
    const freshnessLine = '*Freshness: Updated: 2026-09-09T01:00:00.000Z*';
    const files = [
      { name: 'full', content: 'A'.repeat(10) },
      { name: 'name-only', content: 'B'.repeat(10), freshnessLine },
    ];

    const result = applyContextBudget(files, { maxTotalContextChars: 10, feature: 'freshness' });

    expect(result.files[1].content).toContain(freshnessLine);
    expect(result.files[1].content).toContain('.hive/features/freshness/context/name-only.md');
  });

  it('preserves small context files unchanged', () => {
    const files = [{ name: 'small', content: 'Short content' }];

    const result = applyContextBudget(files, { maxContextChars: 10000 });

    expect(result.files[0].content).toBe('Short content');
    expect(result.files[0].truncated).toBe(false);
  });

  it('emits truncation events when context is truncated', () => {
    const longContent = 'X'.repeat(10000);
    const files = [{ name: 'large', content: longContent }];

    const result = applyContextBudget(files, { maxContextChars: 500 });

    expect(result.truncationEvents.some(e => e.type === 'context_truncated')).toBe(true);
  });

  it('handles empty context list', () => {
    const result = applyContextBudget([], { maxContextChars: 10000 });

    expect(result.files.length).toBe(0);
    expect(result.truncationEvents.length).toBe(0);
  });

  it('includes file path hints for truncated context', () => {
    const longContent = 'Y'.repeat(10000);
    const files = [{ name: 'decisions', content: longContent }];

    const result = applyContextBudget(files, { maxContextChars: 500, feature: 'my-feature' });

    expect(result.files[0].pathHint).toContain('.hive/features/my-feature/context/decisions.md');
  });
});

// ============================================================================
// Default Budget Tests
// ============================================================================

describe('DEFAULT_BUDGET', () => {
  it('has reasonable default values', () => {
    expect(DEFAULT_BUDGET.maxTasks).toBeGreaterThan(0);
    expect(DEFAULT_BUDGET.maxSummaryChars).toBeGreaterThan(0);
    expect(DEFAULT_BUDGET.maxContextChars).toBeGreaterThan(0);
    expect(DEFAULT_BUDGET.maxTotalContextChars).toBeGreaterThan(0);
  });

  it('has maxTasks that allows meaningful history', () => {
    // Should allow at least 5 tasks for context
    expect(DEFAULT_BUDGET.maxTasks).toBeGreaterThanOrEqual(5);
  });

  it('has summary limit that allows useful summaries', () => {
    // Should allow at least 200 chars for a useful summary
    expect(DEFAULT_BUDGET.maxSummaryChars).toBeGreaterThanOrEqual(200);
  });
});

// ============================================================================
// Integration: Bound Prompt Growth
// ============================================================================

describe('prompt budgeting bounds growth', () => {
  it('keeps total previous tasks content under threshold with many tasks', () => {
    // Simulate a feature with many completed tasks
    const tasks = Array.from({ length: 50 }, (_, i) => ({
      name: `${String(i + 1).padStart(2, '0')}-task-${i}`,
      summary: `This is task ${i + 1} summary. `.repeat(20), // ~500 chars each
    }));

    const result = applyTaskBudget(tasks, DEFAULT_BUDGET);

    // Calculate total chars in result
    const totalChars = result.tasks.reduce((sum, t) => sum + t.summary.length, 0);

    // Should be bounded by maxTasks * maxSummaryChars
    const maxExpected = DEFAULT_BUDGET.maxTasks * (DEFAULT_BUDGET.maxSummaryChars + 50);
    expect(totalChars).toBeLessThanOrEqual(maxExpected);
  });

  it('keeps total context content under threshold with large context files', () => {
    // Simulate large context files
    const files = Array.from({ length: 10 }, (_, i) => ({
      name: `context-${i}`,
      content: `Context file ${i} content. `.repeat(1000), // ~20KB each
    }));

    const result = applyContextBudget(files, DEFAULT_BUDGET);

    // Calculate total chars in result
    const totalChars = result.files.reduce((sum, f) => sum + f.content.length, 0);

    // Should be bounded
    expect(totalChars).toBeLessThanOrEqual(DEFAULT_BUDGET.maxTotalContextChars + 500);
  });
});
