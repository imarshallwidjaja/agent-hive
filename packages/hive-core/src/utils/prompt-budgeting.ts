/**
 * Deterministic prompt budgeting utilities for Hive.
 *
 * Limits the completed-task history included in prompts to bound growth:
 * - Include only the last N completed tasks
 * - Truncate each task summary to max M chars (with clear truncation marker)
 * - Emit truncation events when a budget drops or truncates a task
 *
 * Dropped tasks stay discoverable through the bounded report-path hint.
 * Shared by OpenCode task execution.
 */
import type { TaskAggregateBranchDiff } from '../types.js';

// ============================================================================
// Types
// ============================================================================

export interface TaskInput {
  name: string;
  summary: string;
  aggregateBranchDiff?: TaskAggregateBranchDiff;
}

export interface BudgetedTask {
  name: string;
  summary: string;
  aggregateBranchDiff?: TaskAggregateBranchDiff;
  truncated: boolean;
  originalLength?: number;
}

export interface TruncationEvent {
  type: 'tasks_dropped' | 'summary_truncated';
  message: string;
  count?: number;
  affected?: string[];
}

export interface BudgetConfig {
  maxTasks?: number;
  maxSummaryChars?: number;
  feature?: string;
}

export interface TaskBudgetResult {
  tasks: BudgetedTask[];
  truncationEvents: TruncationEvent[];
  droppedTasksHint?: string;
}

// ============================================================================
// Default Budget
// ============================================================================

export const DEFAULT_BUDGET: Required<Omit<BudgetConfig, 'feature'>> = {
  maxTasks: 10,
  maxSummaryChars: 2000,
};

// ============================================================================
// Truncation
// ============================================================================

const TRUNCATION_MARKER = '...[truncated]';

function truncateWithMarker(str: string, maxLength: number): { result: string; truncated: boolean } {
  if (str.length <= maxLength) {
    return { result: str, truncated: false };
  }

  const cutoff = maxLength - TRUNCATION_MARKER.length;
  if (cutoff <= 0) {
    return { result: TRUNCATION_MARKER, truncated: true };
  }

  return {
    result: str.slice(0, cutoff) + TRUNCATION_MARKER,
    truncated: true,
  };
}

// ============================================================================
// Task Budgeting
// ============================================================================

export function applyTaskBudget(
  tasks: TaskInput[],
  config: BudgetConfig = {}
): TaskBudgetResult {
  const maxTasks = config.maxTasks ?? DEFAULT_BUDGET.maxTasks;
  const maxSummaryChars = config.maxSummaryChars ?? DEFAULT_BUDGET.maxSummaryChars;
  const feature = config.feature;

  const truncationEvents: TruncationEvent[] = [];
  let droppedTasksHint: string | undefined;

  if (tasks.length === 0) {
    return { tasks: [], truncationEvents: [] };
  }

  let selectedTasks = tasks;
  const droppedTasks: string[] = [];

  if (tasks.length > maxTasks) {
    const dropCount = tasks.length - maxTasks;
    droppedTasks.push(...tasks.slice(0, dropCount).map(t => t.name));
    selectedTasks = tasks.slice(dropCount);

    truncationEvents.push({
      type: 'tasks_dropped',
      message: `Dropped ${dropCount} older task(s) to stay within budget of ${maxTasks}`,
      count: dropCount,
      affected: droppedTasks,
    });

    if (feature) {
      droppedTasksHint = `Dropped tasks: ${droppedTasks.join(', ')}. Full reports available at .hive/features/${feature}/tasks/<task>/report.md`;
    } else {
      droppedTasksHint = `Dropped tasks: ${droppedTasks.join(', ')}. Full reports available in task directories.`;
    }
  }

  const budgetedTasks: BudgetedTask[] = selectedTasks.map(task => {
    const { result, truncated } = truncateWithMarker(task.summary, maxSummaryChars);

    if (truncated) {
      truncationEvents.push({
        type: 'summary_truncated',
        message: `Truncated summary for task "${task.name}" from ${task.summary.length} to ${result.length} chars`,
        affected: [task.name],
      });
    }

    return {
      name: task.name,
      summary: result,
      aggregateBranchDiff: task.aggregateBranchDiff,
      truncated,
      originalLength: truncated ? task.summary.length : undefined,
    };
  });

  return {
    tasks: budgetedTasks,
    truncationEvents,
    droppedTasksHint,
  };
}
