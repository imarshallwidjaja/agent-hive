import type { TaskStatusType } from '../types.js';

/**
 * Minimal task info needed for dependency graph computation.
 */
export interface TaskWithDeps {
  folder: string;
  status: TaskStatusType;
  /** Stored dependency folders; undefined (legacy status files) means none. */
  dependsOn?: string[];
}

/**
 * Result of computing runnable and blocked tasks.
 */
export interface RunnableBlockedResult {
  /** Task folders that are pending and have all dependencies satisfied (done) */
  runnable: string[];
  /** Map of task folder -> array of unsatisfied dependency folders */
  blocked: Record<string, string[]>;
}

/**
 * Compute which pending tasks are runnable (all deps done) and which are blocked.
 * 
 * A task is runnable if:
 * - Its status is 'pending'
 * - All its dependencies have status 'done'
 * 
 * A task is blocked if:
 * - Its status is 'pending'
 * - At least one dependency does NOT have status 'done'
 * 
 * Only 'done' satisfies a dependency. Other statuses (in_progress, cancelled,
 * failed, blocked, partial) do NOT satisfy dependencies.
 * 
 * @param tasks - Array of tasks with their status and dependencies
 * @returns Object with runnable task folders and blocked tasks with their missing deps
 */
export function computeRunnableAndBlocked(tasks: TaskWithDeps[]): RunnableBlockedResult {
  const statusByFolder = new Map<string, TaskStatusType>();
  for (const task of tasks) {
    statusByFolder.set(task.folder, task.status);
  }

  const runnable: string[] = [];
  const blocked: Record<string, string[]> = {};

  const effectiveDepsByFolder = buildEffectiveDependencies(tasks);

  for (const task of tasks) {
    if (task.status !== 'pending') {
      continue;
    }

    const deps = effectiveDepsByFolder.get(task.folder) ?? [];

    const unmetDeps = deps.filter(dep => {
      const depStatus = statusByFolder.get(dep);
      return depStatus !== 'done';
    });

    if (unmetDeps.length === 0) {
      runnable.push(task.folder);
    } else {
      blocked[task.folder] = unmetDeps;
    }
  }

  return { runnable, blocked };
}

/**
 * Compute each task's stored dependency folders. A missing dependsOn field
 * (legacy status files) means no dependencies; folder numbering never implies
 * an edge. Plan "Depends on" shorthand is resolved when the plan is compiled,
 * not here.
 */
export function buildEffectiveDependencies(tasks: TaskWithDeps[]): Map<string, string[]> {
  return new Map(tasks.map(task => [task.folder, task.dependsOn ?? []]));
}

/** Statuses whose outgoing dependencies are active constraints. */
const UNFINISHED_STATUSES: ReadonlySet<TaskStatusType> = new Set([
  'pending', 'in_progress', 'blocked', 'failed', 'partial',
]);

export type DependencyGraphViolation =
  | { kind: 'missing'; source: string; target: string }
  | { kind: 'self'; source: string }
  | { kind: 'cycle'; path: string[] };

/**
 * Find the first violation among unfinished tasks' outgoing dependencies:
 * a missing target, a self-reference, or a cycle through unfinished tasks.
 * Outgoing edges of done/cancelled tasks are history and are not checked;
 * a done/cancelled target must exist but ends cycle traversal.
 */
export function findUnfinishedDependencyViolation(tasks: TaskWithDeps[]): DependencyGraphViolation | null {
  const dependencies = buildEffectiveDependencies(tasks);
  const unfinished = new Set(tasks.filter(task => UNFINISHED_STATUSES.has(task.status)).map(task => task.folder));

  for (const source of unfinished) {
    for (const target of dependencies.get(source)!) {
      if (target === source) return { kind: 'self', source };
      if (!dependencies.has(target)) return { kind: 'missing', source, target };
    }
  }

  const done = new Set<string>();
  const path: string[] = [];
  const visit = (folder: string): string[] | null => {
    const index = path.indexOf(folder);
    if (index !== -1) return [...path.slice(index), folder];
    if (done.has(folder) || !unfinished.has(folder)) return null;
    path.push(folder);
    for (const target of dependencies.get(folder)!) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    path.pop();
    done.add(folder);
    return null;
  };
  for (const folder of unfinished) {
    const cycle = visit(folder);
    if (cycle) return { kind: 'cycle', path: cycle };
  }
  return null;
}
