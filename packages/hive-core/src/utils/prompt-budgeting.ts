/**
 * Deterministic prompt budgeting utilities for Hive.
 *
 * Limits history/context included in prompts to bound growth:
 * - Include only last N completed tasks
 * - Truncate each task summary to max M chars (with clear truncation marker)
 * - Apply max budget for inlined context (or switch to file references / name-only listing past a cap)
 * - Emit warnings when any budget causes truncation so it's never silent
 *
 * Shared by OpenCode task execution.
 *
 * IMPORTANT: Never removes access to full info - always provides file paths the worker can read.
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

export interface ContextInput {
  name: string;
  content: string;
  freshnessLine?: string;
}

export interface PrioritizedContextInput extends ContextInput {
  updatedAt: string;
  task?: string;
}

export interface BudgetedContext {
  name: string;
  content: string;
  truncated: boolean;
  originalLength?: number;
  pathHint?: string;
}

export interface TruncationEvent {
  type: 'tasks_dropped' | 'summary_truncated' | 'context_truncated' | 'context_names_only';
  message: string;
  count?: number;
  affected?: string[];
}

export interface BudgetConfig {
  maxTasks?: number;
  maxSummaryChars?: number;
  maxContextChars?: number;
  maxTotalContextChars?: number;
  feature?: string;
}

export interface TaskBudgetResult {
  tasks: BudgetedTask[];
  truncationEvents: TruncationEvent[];
  droppedTasksHint?: string;
}

export interface ContextBudgetResult {
  files: BudgetedContext[];
  truncationEvents: TruncationEvent[];
  namesOnlyFiles?: string[];
}

// ============================================================================
// Task-Aware Context Prioritization
// ============================================================================

function compareDeterministicText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseIsoTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [yearNumber, monthNumber, dayNumber, hourNumber, minuteNumber, secondNumber] = parts;
  if (
    monthNumber < 1
    || monthNumber > 12
    || dayNumber < 1
    || dayNumber > new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate()
    || hourNumber > 23
    || minuteNumber > 59
    || secondNumber > 59
  ) {
    return undefined;
  }
  if (zone !== 'Z') {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * Put context owned by the receiving task and its dependency closure first.
 * Relevant task distance wins, followed by the existing newest-first order.
 * Untagged and unrelated context retain the same recency/name ordering.
 */
export function prioritizeContextForTask<T extends PrioritizedContextInput>(
  files: T[],
  task: string,
  dependencies: Map<string, string[]>,
): T[] {
  const distanceByTask = new Map<string, number>([[task, 0]]);
  const queue = [task];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const nextDistance = distanceByTask.get(current)! + 1;
    for (const dependency of dependencies.get(current) ?? []) {
      const knownDistance = distanceByTask.get(dependency);
      if (knownDistance !== undefined && knownDistance <= nextDistance) continue;
      distanceByTask.set(dependency, nextDistance);
      queue.push(dependency);
    }
  }

  const relevance = (file: T): number =>
    file.task === undefined
      ? Number.POSITIVE_INFINITY
      : distanceByTask.get(file.task) ?? Number.POSITIVE_INFINITY;
  return [...files].sort((left, right) => {
    const relevanceDifference = relevance(left) - relevance(right);
    if (relevanceDifference !== 0 && !Number.isNaN(relevanceDifference)) {
      return relevanceDifference;
    }

    const leftTimestamp = parseIsoTimestamp(left.updatedAt);
    const rightTimestamp = parseIsoTimestamp(right.updatedAt);
    if (leftTimestamp !== undefined && rightTimestamp !== undefined) {
      const timeDifference = rightTimestamp - leftTimestamp;
      if (timeDifference !== 0) return timeDifference;
    } else if (leftTimestamp !== undefined) {
      return -1;
    } else if (rightTimestamp !== undefined) {
      return 1;
    }

    return compareDeterministicText(left.name, right.name);
  });
}

// ============================================================================
// Default Budget
// ============================================================================

export const DEFAULT_BUDGET: Required<Omit<BudgetConfig, 'feature'>> = {
  maxTasks: 10,
  maxSummaryChars: 2000,
  maxContextChars: 20000,
  maxTotalContextChars: 60000,
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

// ============================================================================
// Context Budgeting
// ============================================================================

export function applyContextBudget(
  files: ContextInput[],
  config: BudgetConfig = {}
): ContextBudgetResult {
  const maxContextChars = config.maxContextChars ?? DEFAULT_BUDGET.maxContextChars;
  const maxTotalContextChars = config.maxTotalContextChars ?? DEFAULT_BUDGET.maxTotalContextChars;
  const feature = config.feature;

  const truncationEvents: TruncationEvent[] = [];
  const namesOnlyFiles: string[] = [];

  if (files.length === 0) {
    return { files: [], truncationEvents: [] };
  }

  const budgetedFiles: BudgetedContext[] = [];
  let totalChars = 0;
  let switchedToNamesOnly = false;

  for (const file of files) {
    const pathHint = feature
      ? `.hive/features/${feature}/context/${file.name}.md`
      : `context/${file.name}.md`;

    if (totalChars >= maxTotalContextChars && !switchedToNamesOnly) {
      switchedToNamesOnly = true;
      truncationEvents.push({
        type: 'context_names_only',
        message: `Switched to name-only listing after ${totalChars} chars (budget: ${maxTotalContextChars})`,
        affected: files.slice(files.indexOf(file)).map(f => f.name),
      });
    }

    if (switchedToNamesOnly) {
      namesOnlyFiles.push(file.name);
      budgetedFiles.push({
        name: file.name,
        content: [
          file.freshnessLine,
          `[Content available at: ${pathHint}]`,
        ].filter((line): line is string => !!line).join('\n\n'),
        truncated: true,
        originalLength: file.content.length,
        pathHint,
      });
      continue;
    }

    const { result, truncated } = truncateWithMarker(file.content, maxContextChars);

    if (truncated) {
      truncationEvents.push({
        type: 'context_truncated',
        message: `Truncated context file "${file.name}" from ${file.content.length} to ${result.length} chars. Full content at: ${pathHint}`,
        affected: [file.name],
      });
    }

    budgetedFiles.push({
      name: file.name,
      content: result,
      truncated,
      originalLength: truncated ? file.content.length : undefined,
      pathHint: truncated ? pathHint : undefined,
    });

    totalChars += result.length;
  }

  return {
    files: budgetedFiles,
    truncationEvents,
    namesOnlyFiles: namesOnlyFiles.length > 0 ? namesOnlyFiles : undefined,
  };
}
