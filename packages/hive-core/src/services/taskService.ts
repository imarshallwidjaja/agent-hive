import * as fs from 'fs';
import * as path from 'path';
import {
  getTasksPath,
  getTaskPath,
  getTaskStatusPath,
  getTaskSpecPath,
  getTaskHandoffPath,
  getSubtasksPath,
  getSubtaskPath,
  getSubtaskStatusPath,
  getSubtaskSpecPath,
  getPlanPath,
  ensureDir,
  readJson,
  writeJson,
  writeJsonAtomic,
  writeJsonAtomicDurable,
  writeAtomicDurable,
  syncDirectory,
  acquireLockSync,
  readText,
  writeText,
  fileExists,
  LockOptions,
} from '../utils/paths.js';
import {
  TaskStatus,
  TaskStatusType,
  TaskOrigin,
  TasksSyncResult,
  TaskInfo,
  Subtask,
  SubtaskType,
  SubtaskStatus,
  ManualTaskMetadata,
} from '../types.js';
import { RepositoryService } from './repositoryService.js';
import { SubtaskService } from './subtaskService.js';
import {
  findUnfinishedDependencyViolation,
  type DependencyGraphViolation,
  type TaskWithDeps,
} from './taskDependencyGraph.js';
import {
  extractTasksSectionContent,
  getFenceTransition,
  listUnownedHeadingsAfterTask,
  listUnownedTaskHeadings,
  readPlanTaskLayout,
  type FenceState,
  type PlanTaskLayout,
} from '../utils/planTaskSections.js';

/** Current schema version for TaskStatus */
export const TASK_STATUS_SCHEMA_VERSION = 1;

/** Upper bound for a successor handoff, in UTF-8 bytes. */
export const TASK_HANDOFF_MAX_BYTES = 2048;

export interface TaskUpdateInput extends Partial<Pick<TaskStatus, 'status' | 'summary' | 'aggregateBranchDiff' | 'baseCommit'>> {
  blocker?: TaskStatus['blocker'] | null;
  report?: string;
  /** Bounded note for the next worker; replaces handoff.md. */
  handoff?: string;
}

export type TaskUpdateResult = TaskStatus & {
  reportPath?: string;
  handoffPath?: string;
};

export type TaskUpdatePersistenceStage = 'report_history' | 'latest_report' | 'handoff' | 'status';

/**
 * Why a task's spec is or is not stale. Checked in this order:
 * manual_task, plan_missing, plan_invalid, task_not_in_plan, spec_missing,
 * unowned_heading_after_task_section, then matches_plan / differs_from_plan.
 *
 * `differs_from_plan` means the stored spec text differs from what the current plan would generate,
 * whether from plan edits, output of an older generator, or manual spec edits; plan changes outside
 * the task's section do not affect freshness.
 */
export type TaskSpecFreshnessReason =
  | 'matches_plan'
  | 'differs_from_plan'
  | 'unowned_heading_after_task_section'
  | 'plan_missing'
  | 'plan_invalid'
  | 'spec_missing'
  | 'task_not_in_plan'
  | 'manual_task';

export interface TaskSpecFreshness {
  folder: string;
  /** true or false only when the stored spec was compared with a regenerated one. */
  specStale: boolean | null;
  specStaleReason: TaskSpecFreshnessReason;
  /**
   * 1-based inclusive plan.md lines of the task's section per the layout, when the task resolves in
   * the plan. The spec's extracted section text comes from these same lines.
   */
  planSection?: { startLine: number; endLine: number };
  /** Lines of unowned headings following the task section, for unowned_heading_after_task_section. */
  unownedHeadingLines?: number[];
}

export class TaskUpdatePersistenceError extends Error {
  constructor(
    message: string,
    public readonly failedStage: TaskUpdatePersistenceStage,
    public readonly reportPath: string | undefined,
    public readonly latestReportPath: string | undefined,
    public readonly reportHistoryWritten: boolean,
    public readonly latestReportWritten: boolean,
    public readonly failedWritePublished: boolean,
    public readonly handoffPath: string | undefined,
    public readonly handoffWritten: boolean,
    options: { cause: unknown },
  ) {
    super(message, options);
    this.name = 'TaskUpdatePersistenceError';
  }
}

interface TaskUpdateWrites {
  reportPath?: string;
  latestReportPath?: string;
  reportHistoryWritten: boolean;
  latestReportWritten: boolean;
  handoffPath?: string;
  handoffWritten: boolean;
}

interface ParsedTask {
  folder: string;
  order: number;
  name: string;
  description: string;
  /** Raw dependency numbers parsed from plan. null = not specified (use implicit), [] = explicit none */
  dependsOnNumbers: number[] | null;
  repoIds: string[] | null;
}

/** Stored dependencies and spec text compiled from the plan for one task. */
interface PlanTaskBuild {
  dependsOn: string[];
  spec: string;
}

/** A task in the stored graph that a sync or manual creation would produce. */
interface GraphNode extends TaskWithDeps {
  origin?: TaskOrigin;
  /** Its dependencies were compiled from the current plan by this operation. */
  fromPlan: boolean;
}

export interface SyncOptions {
  refreshPending?: boolean;
}

export type TaskStatusEntry =
  | (TaskInfo & { dependsOn: string[]; blocker?: TaskStatus['blocker'] })
  | { folder: string; name: string; status: null; integrity: { reason: 'status_missing' | 'status_unreadable'; error?: string } };

const TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending', 'in_progress', 'done', 'cancelled', 'blocked', 'failed', 'partial',
]);

export function validateStoredTaskStatus(status: TaskStatus | null, taskFolder: string): void {
  if (!status || typeof status !== 'object' || !TASK_STATUSES.has(status.status)) {
    throw new Error(`Task '${taskFolder}' has a corrupt status file`);
  }
}

export class TaskService {
  private readonly subtaskService: SubtaskService;

  constructor(
    private projectRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.subtaskService = new SubtaskService(projectRoot);
  }

  sync(featureName: string, options?: SyncOptions): TasksSyncResult {
    const planContent = this.readNormalizedPlanContent(featureName);

    if (!planContent) {
      throw new Error(`No plan.md found for feature '${featureName}'`);
    }

    const planTasks = this.parseTasksFromPlan(planContent);
    
    this.validateDependencyGraph(planTasks, featureName);

    // Derive every action and the resulting stored graph first; nothing is written unless
    // that graph is valid, and the writes below apply exactly these actions.
    const result: TasksSyncResult = {
      created: [],
      removed: [],
      kept: [],
      manual: [],
    };
    const planByFolder = new Map(planTasks.map(task => [task.folder, task]));
    const refreshPending = options?.refreshPending === true;
    const writes: Array<{ task: ParsedTask; built: PlanTaskBuild; refresh: boolean }> = [];
    const proposed: GraphNode[] = [];
    const existingFolders = new Set<string>();

    for (const { folder, status } of this.readStoredTasks(featureName)) {
      existingFolders.add(folder);
      const planTask = planByFolder.get(folder);
      let dependsOn = status.dependsOn;
      let fromPlan = false;

      if (status.origin === 'manual') {
        result.manual.push(folder);
      } else if (status.status !== 'pending') {
        // Execution history and cancelled records are retained with their stored edges.
        result.kept.push(folder);
      } else if (!planTask) {
        result.removed.push(folder);
        continue;
      } else {
        result.kept.push(folder);
        if (refreshPending) {
          const built = this.buildPlanTaskSpec(featureName, planTask, planTasks, planContent);
          writes.push({ task: planTask, built, refresh: true });
          dependsOn = built.dependsOn;
          fromPlan = true;
        }
      }
      proposed.push({ folder, status: status.status, origin: status.origin, dependsOn, fromPlan });
    }

    for (const planTask of planTasks) {
      if (existingFolders.has(planTask.folder)) continue;
      const built = this.buildPlanTaskSpec(featureName, planTask, planTasks, planContent);
      writes.push({ task: planTask, built, refresh: false });
      proposed.push({ folder: planTask.folder, status: 'pending', origin: 'plan', dependsOn: built.dependsOn, fromPlan: true });
      result.created.push(planTask.folder);
    }

    const violation = findUnfinishedDependencyViolation(proposed);
    if (violation) {
      throw new Error(
        `Task sync rejected; no task files were changed. ` +
        this.describeDependencyViolation(violation, proposed, planTasks, new Set(result.removed)),
      );
    }

    for (const folder of result.removed) {
      this.deleteTask(featureName, folder);
    }
    for (const { task, built, refresh } of writes) {
      if (refresh) {
        this.refreshPendingTask(featureName, task, built);
      } else {
        this.createFromPlan(featureName, task, built);
      }
    }

    const unownedTaskHeadings = listUnownedTaskHeadings(readPlanTaskLayout(planContent));
    if (unownedTaskHeadings.length > 0) {
      result.unownedTaskHeadings = unownedTaskHeadings;
    }

    return result;
  }

  /**
   * Create a manual task with auto-incrementing index.
   * Folder format: "01-task-name", "02-task-name", etc.
   * Index ensures alphabetical sort = chronological order.
   */
  create(featureName: string, name: string, order?: number, metadata?: ManualTaskMetadata): string {
    const existingFolders = this.listFolders(featureName);
    const nextOrder = this.getNextOrder(existingFolders);

    if (order !== undefined && order !== nextOrder) {
      throw new Error(
        `Manual tasks are append-only: requested order ${order} does not match the next available order ${nextOrder}. ` +
        `Intermediate insertion requires plan amendment.`
      );
    }
    
    if (metadata?.source === 'review' && metadata.dependsOn && metadata.dependsOn.length > 0) {
      throw new Error(
        `Review-sourced manual tasks cannot have explicit dependsOn. ` +
        `Cross-task dependencies require a plan amendment. ` +
        `Either remove the dependsOn field or amend the plan to express the dependency.`
      );
    }

    const resolvedOrder = order ?? nextOrder;
    const taskSlug = this.slugify(name);
    if (!taskSlug) {
      throw new Error(`Manual task name "${name}" cannot produce a safe task folder slug.`);
    }
    const folder = `${String(resolvedOrder).padStart(2, '0')}-${taskSlug}`;

    const dependsOn = metadata?.dependsOn ?? [];
    const repoIds = metadata?.repoIds;
    this.validateManualTaskDependsOn(featureName, folder, dependsOn);
    this.validateRepoIds(repoIds, 'manual task metadata');

    const collision = existingFolders.find(f => {
      const match = f.match(/^(\d+)-/);
      return match && parseInt(match[1], 10) === resolvedOrder;
    });
    if (collision) {
      throw new Error(
        `Task folder collision: order ${resolvedOrder} already exists as "${collision}". ` +
        `Choose a different order number or omit to auto-increment.`
      );
    }

    const taskPath = getTaskPath(this.projectRoot, featureName, folder);
    ensureDir(taskPath);

    const status: TaskStatus = {
      status: 'pending',
      origin: 'manual',
      planTitle: name,
      dependsOn,
      ...(repoIds !== undefined ? { repoIds } : {}),
      ...(metadata ? { metadata: { ...metadata, dependsOn: undefined, repoIds: undefined } } : {}),
    };
    writeJson(getTaskStatusPath(this.projectRoot, featureName, folder), status);

    const specContent = this.buildManualTaskSpec(featureName, folder, name, dependsOn, metadata);
    writeText(getTaskSpecPath(this.projectRoot, featureName, folder), specContent);

    return folder;
  }

  private createFromPlan(featureName: string, task: ParsedTask, { dependsOn, spec }: PlanTaskBuild): void {
    const taskPath = getTaskPath(this.projectRoot, featureName, task.folder);
    ensureDir(taskPath);

    const status: TaskStatus = {
      status: 'pending',
      origin: 'plan',
      planTitle: task.name,
      dependsOn,
      ...(task.repoIds !== null ? { repoIds: task.repoIds } : {}),
    };
    writeJson(getTaskStatusPath(this.projectRoot, featureName, task.folder), status);
    writeText(getTaskSpecPath(this.projectRoot, featureName, task.folder), spec);
  }

  private refreshPendingTask(featureName: string, task: ParsedTask, { dependsOn, spec }: PlanTaskBuild): void {
    const statusPath = getTaskStatusPath(this.projectRoot, featureName, task.folder);
    const current = readJson<TaskStatus>(statusPath);
    if (current) {
      const updated: TaskStatus = {
        ...current,
        planTitle: task.name,
        dependsOn,
        repoIds: task.repoIds ?? undefined,
      };
      writeJson(statusPath, updated);
    }

    writeText(getTaskSpecPath(this.projectRoot, featureName, task.folder), spec);
  }

  /** Spec input construction shared by sync create, sync refresh, and spec freshness. */
  private buildPlanTaskSpec(featureName: string, task: ParsedTask, allTasks: ParsedTask[], planContent: string): PlanTaskBuild {
    const dependsOn = this.resolveDependencies(task, allTasks);
    const spec = this.buildSpecContent({
      featureName,
      task,
      dependsOn,
      repoIds: task.repoIds ?? undefined,
      allTasks,
      planContent,
    });
    return { dependsOn, spec };
  }

  /**
   * Compare each task's stored spec.md with the spec sync would generate from the current plan.
   * This is a generated-text comparison: plan edits outside a task's own spec inputs (such as the
   * plan preamble) do not make it stale.
   */
  getSpecFreshness(featureName: string): TaskSpecFreshness[] {
    const planContent = this.readNormalizedPlanContent(featureName);
    let plan: { tasks: ParsedTask[]; layout: PlanTaskLayout } | null = null;
    if (planContent) {
      try {
        const tasks = this.parseTasksFromPlan(planContent);
        this.validateDependencyGraph(tasks, featureName);
        plan = { tasks, layout: readPlanTaskLayout(planContent) };
      } catch {
        // Sync reports the parse error; freshness only records that the plan cannot be compared.
      }
    }

    return this.listFolders(featureName).map((folder): TaskSpecFreshness => {
      let status: TaskStatus | null = null;
      try {
        status = readJson<TaskStatus>(getTaskStatusPath(this.projectRoot, featureName, folder));
      } catch {
        // Integrity entries can still be compared with the plan by folder identity.
      }
      if (status?.origin === 'manual') return { folder, specStale: null, specStaleReason: 'manual_task' };
      if (!planContent) return { folder, specStale: null, specStaleReason: 'plan_missing' };
      if (!plan) return { folder, specStale: null, specStaleReason: 'plan_invalid' };

      // Resolve by folder identity only; a renamed task never rebinds by number.
      const planTask = plan.tasks.find(candidate => candidate.folder === folder);
      if (!planTask) return { folder, specStale: null, specStaleReason: 'task_not_in_plan' };

      const section = plan.layout.tasks.find(candidate => candidate.taskNumber === planTask.order);
      const located = section ? { planSection: { startLine: section.startLine, endLine: section.endLine } } : {};

      const storedSpec = readText(getTaskSpecPath(this.projectRoot, featureName, folder));
      if (storedSpec === null) return { folder, specStale: null, specStaleReason: 'spec_missing', ...located };

      const unowned = section ? listUnownedHeadingsAfterTask(plan.layout, section) : [];
      if (unowned.length > 0) {
        return {
          folder,
          specStale: null,
          specStaleReason: 'unowned_heading_after_task_section',
          ...located,
          unownedHeadingLines: unowned.map(heading => heading.line),
        };
      }

      const { spec } = this.buildPlanTaskSpec(featureName, planTask, plan.tasks, planContent);
      return spec === storedSpec
        ? { folder, specStale: false, specStaleReason: 'matches_plan', ...located }
        : { folder, specStale: true, specStaleReason: 'differs_from_plan', ...located };
    });
  }

  buildSpecContent(params: {
    featureName: string;
    task: { folder: string; name: string; order: number; description?: string };
    dependsOn: string[];
    repoIds?: string[];
    allTasks: Array<{ folder: string; name: string; order: number }>;
    planContent?: string | null;
  }): string {
    const { featureName, task, dependsOn, repoIds, allTasks, planContent } = params;

    const getTaskType = (planSection: string | null, taskName: string): string | null => {
      if (!planSection) {
        return null;
      }

      const fileTypeMatches = Array.from(planSection.matchAll(/-\s*(Create|Modify|Test):/gi)).map(
        match => match[1].toLowerCase()
      );
      const fileTypes = new Set(fileTypeMatches);

      if (fileTypes.size === 0) {
        return taskName.toLowerCase().includes('test') ? 'testing' : null;
      }

      if (fileTypes.size === 1) {
        const onlyType = Array.from(fileTypes)[0];
        if (onlyType === 'create') return 'greenfield';
        if (onlyType === 'test') return 'testing';
      }

      if (fileTypes.has('modify')) {
        return 'modification';
      }

      return null;
    };

    const specLines: string[] = [
      `# Task: ${task.folder}`,
      '',
      `## Feature: ${featureName}`,
      '',
      '## Dependencies',
      '',
    ];

    if (dependsOn.length > 0) {
      for (const dep of dependsOn) {
        const depTask = allTasks.find(t => t.folder === dep);
        if (depTask) {
          specLines.push(`- **${depTask.order}. ${depTask.name}** (${dep})`);
        } else {
          specLines.push(`- ${dep}`);
        }
      }
    } else {
      specLines.push('_None_');
    }

    if (repoIds !== undefined) {
      specLines.push('', '## Repositories', '');
      for (const repoId of repoIds) {
        specLines.push(`- ${repoId}`);
      }
    }

    specLines.push('', '## Plan Section', '');

    const planSection = this.extractPlanSection(planContent ?? null, task);
    if (planSection) {
      specLines.push(planSection.trim());
    } else {
      specLines.push('_No plan section available._');
    }

    specLines.push('');

    const taskType = getTaskType(planSection, task.name);
    if (taskType) {
      specLines.push('## Task Type', '', taskType, '');
    }

    return specLines.join('\n');
  }

  private extractPlanSection(planContent: string | null, task: { name: string; order: number; folder: string }): string | null {
    if (!planContent || task.order <= 0) return null;

    const section = readPlanTaskLayout(planContent).tasks.find(candidate => candidate.taskNumber === task.order);
    if (!section) return null;

    return planContent.split('\n').slice(section.startLine - 1, section.endLine).join('\n').trim();
  }

  /**
   * Resolve dependency numbers to folder names.
   * - If dependsOnNumbers is null (not specified), apply implicit sequential default (N-1 for N > 1).
   * - If dependsOnNumbers is [] (explicit "none"), return empty array.
   * - Otherwise, map numbers to corresponding task folders.
   */
  private resolveDependencies(task: ParsedTask, allTasks: ParsedTask[]): string[] {
    // Explicit "none" - no dependencies
    if (task.dependsOnNumbers !== null && task.dependsOnNumbers.length === 0) {
      return [];
    }

    // Explicit dependency numbers provided
    if (task.dependsOnNumbers !== null) {
      return task.dependsOnNumbers
        .map(num => allTasks.find(t => t.order === num)?.folder)
        .filter((folder): folder is string => folder !== undefined);
    }

    // Implicit sequential default: depend on previous task (N-1)
    if (task.order === 1) {
      return [];
    }

    const previousTask = allTasks.find(t => t.order === task.order - 1);
    return previousTask ? [previousTask.folder] : [];
  }

  /**
   * Validate the dependency graph for errors before creating tasks.
   * Throws descriptive errors pointing the operator to fix plan.md.
   * 
   * Checks for:
   * - Duplicate task numbers (checked first, so references are unambiguous)
   * - Unknown task numbers in dependencies
   * - Self-dependencies
   * - Cycles (using DFS topological sort)
   */
  private validateDependencyGraph(tasks: ParsedTask[], featureName: string): void {
    const taskByNumber = new Map<number, ParsedTask>();
    for (const task of tasks) {
      const prior = taskByNumber.get(task.order);
      if (prior) {
        throw new Error(
          `Invalid plan.md: task number ${task.order} is used by both "${prior.name}" and "${task.name}". ` +
          `Give each "### N. Title" heading a unique number and update the "Depends on:" lines that refer to it.`
        );
      }
      taskByNumber.set(task.order, task);
    }
    const taskNumbers = new Set(taskByNumber.keys());
    
    // Validate each task's dependencies
    for (const task of tasks) {
      if (task.dependsOnNumbers === null) {
        // Implicit dependencies - no validation needed
        continue;
      }
      
      for (const depNum of task.dependsOnNumbers) {
        // Check for self-dependency
        if (depNum === task.order) {
          throw new Error(
            `Invalid dependency graph in plan.md: Self-dependency detected for task ${task.order} ("${task.name}"). ` +
            `A task cannot depend on itself. Please fix the "Depends on:" line in plan.md.`
          );
        }
        
        // Check for unknown task number
        if (!taskNumbers.has(depNum)) {
          throw new Error(
            `Invalid dependency graph in plan.md: Unknown task number ${depNum} referenced in dependencies for task ${task.order} ("${task.name}"). ` +
            `Available task numbers are: ${Array.from(taskNumbers).sort((a, b) => a - b).join(', ')}. ` +
            `Please fix the "Depends on:" line in plan.md.`
          );
        }
      }
    }
    
    // Check for cycles using DFS
    this.detectCycles(tasks);
  }

  /**
   * Detect cycles in the dependency graph using DFS.
   * Throws a descriptive error if a cycle is found.
   */
  private detectCycles(tasks: ParsedTask[]): void {
    // Build adjacency list: task order -> [dependency orders]
    const taskByOrder = new Map(tasks.map(t => [t.order, t]));
    
    // Build dependency graph with resolved implicit dependencies
    const getDependencies = (task: ParsedTask): number[] => {
      if (task.dependsOnNumbers !== null) {
        return task.dependsOnNumbers;
      }
      // Implicit sequential dependency
      if (task.order === 1) {
        return [];
      }
      return [task.order - 1];
    };
    
    // Track visited state: 0 = unvisited, 1 = in current path, 2 = fully processed
    const visited = new Map<number, number>();
    const path: number[] = [];
    
    const dfs = (taskOrder: number): void => {
      const state = visited.get(taskOrder);
      
      if (state === 2) {
        // Already fully processed, no cycle through here
        return;
      }
      
      if (state === 1) {
        // Found a cycle! Build the cycle path for the error message
        const cycleStart = path.indexOf(taskOrder);
        const cyclePath = [...path.slice(cycleStart), taskOrder];
        const cycleDesc = cyclePath.join(' -> ');
        
        throw new Error(
          `Invalid dependency graph in plan.md: Cycle detected in task dependencies: ${cycleDesc}. ` +
          `Tasks cannot have circular dependencies. Please fix the "Depends on:" lines in plan.md.`
        );
      }
      
      // Mark as in current path
      visited.set(taskOrder, 1);
      path.push(taskOrder);
      
      const task = taskByOrder.get(taskOrder);
      if (task) {
        const deps = getDependencies(task);
        for (const depOrder of deps) {
          dfs(depOrder);
        }
      }
      
      // Mark as fully processed
      path.pop();
      visited.set(taskOrder, 2);
    };
    
    // Run DFS from each node
    for (const task of tasks) {
      if (!visited.has(task.order)) {
        dfs(task.order);
      }
    }
  }

  writeSpec(featureName: string, taskFolder: string, content: string): string {
    const specPath = getTaskSpecPath(this.projectRoot, featureName, taskFolder);
    writeText(specPath, content);
    return specPath;
  }

  readSpec(featureName: string, taskFolder: string): string | null {
    const specPath = getTaskSpecPath(this.projectRoot, featureName, taskFolder);
    return readText(specPath);
  }

  /**
   * Update task status with locked atomic write.
   * Uses file locking to prevent race conditions between concurrent updates.
   * 
   * @param featureName - Feature name
   * @param taskFolder - Task folder name
   * @param updates - Status fields to patch and optional report content to publish
   * @param lockOptions - Optional lock configuration
   * @returns Updated TaskStatus
   */
  update(
    featureName: string,
    taskFolder: string,
    updates: TaskUpdateInput,
    lockOptions?: LockOptions
  ): TaskUpdateResult {
    this.validateUpdate(updates);
    const statusPath = getTaskStatusPath(this.projectRoot, featureName, taskFolder);

    // Guard before lock acquisition to avoid creating missing task folders
    // via lock-file parent directory creation on error paths.
    if (!fileExists(statusPath)) {
      throw new Error(`Task '${taskFolder}' not found`);
    }

    const release = acquireLockSync(statusPath, {
      ...lockOptions,
      staleLockTTL: Number.POSITIVE_INFINITY,
    });

    try {
      const current = this.readValidatedTaskStatus(statusPath, taskFolder);
      if (!current) {
        throw new Error(`Task '${taskFolder}' status file disappeared during update`);
      }
      if (updates.blocker && (updates.status ?? current.status) !== 'blocked') {
        throw new Error('Task blocker can only be supplied for a blocked task');
      }

      const updated: TaskStatus = {
        ...current,
        schemaVersion: TASK_STATUS_SCHEMA_VERSION,
      };

      if (updates.status !== undefined) updated.status = updates.status;
      if (updates.summary !== undefined) updated.summary = updates.summary;
      if (updates.aggregateBranchDiff !== undefined) updated.aggregateBranchDiff = updates.aggregateBranchDiff;
      if (updates.baseCommit !== undefined) updated.baseCommit = updates.baseCommit;
      if (updates.blocker === null) delete updated.blocker;
      else if (updates.blocker !== undefined) updated.blocker = updates.blocker;

      if (updates.status === 'in_progress' && !current.startedAt) {
        updated.startedAt = this.now().toISOString();
      }
      if (updates.status === 'done' && current.status !== 'done') {
        updated.completedAt = this.now().toISOString();
      }
      if (updates.status !== undefined && updates.status !== 'blocked') {
        delete updated.blocker;
      }

      const taskPath = getTaskPath(this.projectRoot, featureName, taskFolder);
      const reportsPath = path.join(taskPath, 'reports');
      const written: TaskUpdateWrites = {
        reportHistoryWritten: false,
        latestReportWritten: false,
        handoffWritten: false,
      };

      if (updates.report !== undefined) {
        written.latestReportPath = path.join(taskPath, 'report.md');
        try {
          ensureDir(reportsPath);
          syncDirectory(taskPath);
          const nextReport = fs.readdirSync(reportsPath)
            .map(name => name.match(/^(\d+)\.md$/)?.[1])
            .filter((value): value is string => value !== undefined)
            .reduce((max, value) => Math.max(max, Number(value)), 0) + 1;
          written.reportPath = path.join(reportsPath, `${nextReport}.md`);
        } catch (error) {
          throw this.persistenceError('report_history', error, written, updates.report);
        }

        try {
          writeAtomicDurable(written.reportPath, updates.report);
          written.reportHistoryWritten = true;
        } catch (error) {
          throw this.persistenceError('report_history', error, written, updates.report);
        }

        try {
          writeAtomicDurable(written.latestReportPath, updates.report);
          written.latestReportWritten = true;
        } catch (error) {
          throw this.persistenceError('latest_report', error, written, updates.report);
        }
      }

      if (updates.handoff !== undefined) {
        written.handoffPath = getTaskHandoffPath(this.projectRoot, featureName, taskFolder);
        try {
          writeAtomicDurable(written.handoffPath, updates.handoff);
          written.handoffWritten = true;
        } catch (error) {
          throw this.persistenceError('handoff', error, written, updates.handoff);
        }
      }

      try {
        writeJsonAtomicDurable(statusPath, updated);
      } catch (error) {
        throw this.persistenceError('status', error, written, JSON.stringify(updated, null, 2), statusPath);
      }

      return {
        ...updated,
        ...(written.reportPath ? { reportPath: written.reportPath } : {}),
        ...(written.handoffPath ? { handoffPath: written.handoffPath } : {}),
      };
    } finally {
      release();
    }
  }

  private validateUpdate(updates: TaskUpdateInput): void {
    if (updates.status !== undefined && !TASK_STATUSES.has(updates.status)) {
      throw new Error(`Invalid task status '${String(updates.status)}'`);
    }
    if (updates.summary !== undefined && (typeof updates.summary !== 'string' || updates.summary.trim().length === 0)) {
      throw new Error('Task summary cannot be blank');
    }
    if (updates.report !== undefined && (typeof updates.report !== 'string' || updates.report.trim().length === 0)) {
      throw new Error('Task report cannot be blank');
    }
    if (updates.handoff !== undefined) {
      if (typeof updates.handoff !== 'string' || updates.handoff.trim().length === 0) {
        throw new Error('Task handoff cannot be blank');
      }
      const handoffBytes = Buffer.byteLength(updates.handoff, 'utf8');
      if (handoffBytes > TASK_HANDOFF_MAX_BYTES) {
        throw new Error(`Task handoff is ${handoffBytes} UTF-8 bytes; the limit is ${TASK_HANDOFF_MAX_BYTES}. Shorten it; handoffs are not truncated.`);
      }
    }
    if (updates.blocker !== undefined && updates.blocker !== null) {
      if (typeof updates.blocker !== 'object'
        || typeof updates.blocker.reason !== 'string'
        || updates.blocker.reason.trim().length === 0) {
        throw new Error('Task blocker reason cannot be blank');
      }
      if (updates.status !== undefined && updates.status !== 'blocked') {
        throw new Error('Task blocker can only be supplied with blocked status');
      }
    }
  }

  private readValidatedTaskStatus(statusPath: string, taskFolder: string): TaskStatus | null {
    let status: TaskStatus | null;
    try {
      status = readJson<TaskStatus>(statusPath);
    } catch (cause) {
      throw new Error(`Task '${taskFolder}' has a corrupt status file at '${statusPath}'`, { cause });
    }
    if (status) validateStoredTaskStatus(status, taskFolder);
    return status;
  }

  private persistenceError(
    stage: TaskUpdatePersistenceStage,
    cause: unknown,
    written: TaskUpdateWrites,
    expectedContent: string,
    failedPath = stage === 'report_history' ? written.reportPath
      : stage === 'handoff' ? written.handoffPath
        : written.latestReportPath,
  ): TaskUpdatePersistenceError {
    let failedWritePublished = false;
    if (failedPath) {
      try {
        failedWritePublished = fs.readFileSync(failedPath, 'utf8') === expectedContent;
      } catch {
        // The failed write was not published.
      }
    }
    const detail = failedWritePublished
      ? 'The destination was published, but durability is uncertain.'
      : 'The destination was not published.';
    return new TaskUpdatePersistenceError(
      `Task update failed while writing ${stage}. ${detail}`,
      stage,
      written.reportPath,
      written.latestReportPath,
      written.reportHistoryWritten,
      written.latestReportWritten,
      failedWritePublished,
      written.handoffPath,
      written.handoffWritten,
      { cause },
    );
  }

  /**
   * Get raw TaskStatus including all fields (for internal use or debugging).
   */
  getRawStatus(featureName: string, taskFolder: string): TaskStatus | null {
    const statusPath = getTaskStatusPath(this.projectRoot, featureName, taskFolder);
    return readJson<TaskStatus>(statusPath);
  }

  get(featureName: string, taskFolder: string): TaskInfo | null {
    const statusPath = getTaskStatusPath(this.projectRoot, featureName, taskFolder);
    const status = readJson<TaskStatus>(statusPath);
    
    if (!status) return null;

    return {
      folder: taskFolder,
      name: taskFolder.replace(/^\d+-/, ''),
      status: status.status,
      origin: status.origin,
      planTitle: status.planTitle,
      summary: status.summary,
      repoIds: status.repoIds,
    };
  }

  list(featureName: string): TaskInfo[] {
    const folders = this.listFolders(featureName);
    return folders
      .map(folder => this.get(featureName, folder))
      .filter((t): t is TaskInfo => t !== null);
  }

  /** Inspect every retained folder without treating missing or corrupt status as pending. */
  listStatusEntries(featureName: string): TaskStatusEntry[] {
    return this.listFolders(featureName).map((folder): TaskStatusEntry => {
      const identity = { folder, name: folder.replace(/^\d+-/, '') };
      const statusPath = getTaskStatusPath(this.projectRoot, featureName, folder);
      try {
        const status = readJson<TaskStatus>(statusPath);
        if (!status) {
          if (!fileExists(statusPath)) return { ...identity, status: null, integrity: { reason: 'status_missing' } };
          throw new Error(`Task '${folder}' has a corrupt status file`);
        }
        validateStoredTaskStatus(status, folder);
        return {
          ...identity,
          status: status.status,
          origin: status.origin,
          planTitle: status.planTitle,
          summary: status.summary,
          repoIds: status.repoIds,
          dependsOn: status.dependsOn ?? [],
          ...(status.blocker ? { blocker: status.blocker } : {}),
        };
      } catch (error) {
        return { ...identity, status: null, integrity: { reason: 'status_unreadable', error: error instanceof Error ? error.message : String(error) } };
      }
    });
  }

  private listFolders(featureName: string): string[] {
    const tasksPath = getTasksPath(this.projectRoot, featureName);
    if (!fileExists(tasksPath)) return [];

    return fs.readdirSync(tasksPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  }

  private deleteTask(featureName: string, taskFolder: string): void {
    const taskPath = getTaskPath(this.projectRoot, featureName, taskFolder);
    if (fileExists(taskPath)) {
      fs.rmSync(taskPath, { recursive: true });
    }
  }

  private getNextOrder(existingFolders: string[]): number {
    if (existingFolders.length === 0) return 1;
    
    const orders = existingFolders
      .map(f => parseInt(f.split('-')[0], 10))
      .filter(n => !isNaN(n));
    
    return Math.max(...orders, 0) + 1;
  }

  /** Status files of existing task folders; folders without one are skipped. */
  private readStoredTasks(featureName: string): Array<{ folder: string; status: TaskStatus }> {
    return this.listFolders(featureName).flatMap(folder => {
      const status = this.readValidatedTaskStatus(getTaskStatusPath(this.projectRoot, featureName, folder), folder);
      return status ? [{ folder, status }] : [];
    });
  }

  private validateManualTaskDependsOn(featureName: string, taskFolder: string, dependsOn: string[]): void {
    // The proposed task goes first so its own dependency errors are reported before older ones.
    const tasks: GraphNode[] = [{ folder: taskFolder, status: 'pending', origin: 'manual', dependsOn, fromPlan: false }];
    for (const folder of this.listFolders(featureName)) {
      const status = this.readValidatedTaskStatus(getTaskStatusPath(this.projectRoot, featureName, folder), folder);
      if (!status) throw new Error(`Task '${folder}' has no status file`);
      tasks.push({ folder, status: status.status, origin: status.origin, dependsOn: status.dependsOn, fromPlan: false });
    }

    const violation = findUnfinishedDependencyViolation(tasks);
    if (!violation) return;
    if (violation.kind === 'missing' && violation.source === taskFolder) {
      throw new Error(`Manual task dependency "${violation.target}" referenced by "${taskFolder}" does not exist. Depend only on existing task folders.`);
    }
    if (violation.kind === 'self' && violation.source === taskFolder) {
      throw new Error(`Manual task dependency graph contains self-dependency for "${taskFolder}".`);
    }
    if (violation.kind === 'cycle' && violation.path.includes(taskFolder)) {
      throw new Error(
        `Manual task dependency graph contains a cycle: ${violation.path.join(' -> ')}. ` +
        `Choose dependencies that do not lead back to "${taskFolder}".`
      );
    }
    throw new Error(
      `Manual task creation rejected; no task files were changed. ` +
      this.describeDependencyViolation(violation, tasks, this.readValidPlanTasks(featureName)),
    );
  }

  /** Current plan tasks when plan.md exists and is structurally valid; null otherwise. */
  private readValidPlanTasks(featureName: string): ParsedTask[] | null {
    const planContent = this.readNormalizedPlanContent(featureName);
    if (!planContent) return null;
    try {
      const tasks = this.parseTasksFromPlan(planContent);
      this.validateDependencyGraph(tasks, featureName);
      return tasks;
    } catch {
      return null;
    }
  }

  /**
   * Explain an unfinished-graph violation and the repair routes that apply to each involved task.
   * `planTasks` is the current plan, or null when it is unavailable; `removed` holds folders the
   * rejected sync would have deleted.
   */
  private describeDependencyViolation(
    violation: DependencyGraphViolation,
    nodes: GraphNode[],
    planTasks: ParsedTask[] | null,
    removed: ReadonlySet<string> = new Set(),
  ): string {
    const byFolder = new Map(nodes.map(node => [node.folder, node]));
    const label = (folder: string) => `"${folder}" (${byFolder.get(folder)!.status})`;
    const lines: string[] = [];
    let sources: string[];

    if (violation.kind === 'missing') {
      const { source, target } = violation;
      const reason = removed.has(target)
        ? 'this sync would remove because plan.md no longer has its task heading'
        : 'does not exist';
      lines.push(`Unfinished task ${label(source)} depends on "${target}", which ${reason}.`);
      const restoreNumber = this.planRestorationNumber(target, planTasks);
      if (restoreNumber !== null) {
        lines.push(
          `To restore "${target}" itself, add a "### ${restoreNumber}. <title>" task to plan.md whose title produces ` +
          `that folder name, then run hive_tasks_sync again.`
        );
      }
      sources = [source];
    } else if (violation.kind === 'self') {
      lines.push(`Unfinished task ${label(violation.source)} depends on itself.`);
      sources = [violation.source];
    } else {
      lines.push(`Unfinished tasks form a dependency cycle: ${violation.path.join(' -> ')}.`);
      sources = [...new Set(violation.path)];
    }

    for (const folder of sources) {
      const node = byFolder.get(folder)!;
      if (node.fromPlan) {
        lines.push(`"${folder}" takes its dependencies from plan.md: amend its "Depends on:" line.`);
      } else if (node.status === 'pending' && node.origin !== 'manual' && planTasks?.some(task => task.folder === folder)) {
        lines.push(
          `"${folder}" is a pending plan task with outdated stored dependencies: amend its "Depends on:" line in ` +
          `plan.md if needed, then run hive_tasks_sync with refreshPending: true.`
        );
      } else {
        lines.push(
          `"${folder}" keeps its stored dependencies; no tool edits them, and changing its status does not change them. ` +
          `If it is obsolete, get operator approval to cancel it with hive_task_update. Cancelling releases its outgoing ` +
          `dependencies but does not stop a running worker or rewire tasks that depend on it; create a replacement ` +
          `with hive_task_create if the work is still needed.`
        );
      }
    }
    return lines.join(' ');
  }

  /** The plan task number that would recreate exactly this folder, when the current plan leaves it free. */
  private planRestorationNumber(folder: string, planTasks: ParsedTask[] | null): number | null {
    const match = folder.match(/^(\d+)-[a-z0-9-]+$/);
    if (!planTasks || !match) return null;
    const order = parseInt(match[1], 10);
    if (String(order).padStart(2, '0') !== match[1]) return null;
    return planTasks.some(task => task.order === order) ? null : order;
  }

  private validateRepoIds(repoIds: string[] | undefined, context: string): void {
    if (repoIds === undefined) {
      return;
    }

    if (repoIds.length === 0) {
      throw new Error(`Invalid repository ID in ${context}: repository list is empty.`);
    }

    for (const repoId of repoIds) {
      if (!RepositoryService.isValidRepositoryId(repoId)) {
        throw new Error(`Invalid repository ID "${repoId}" in ${context}. Repository IDs must use the Task 1 repository ID grammar.`);
      }
    }
  }

  /**
   * Read plan.md for parsing with CRLF normalized to LF, so line-oriented matching, section
   * extraction, and generated specs treat CRLF plans like LF ones. Lone CR characters are
   * content, not line endings: keeping them leaves line numbers aligned with the saved file.
   */
  private readNormalizedPlanContent(featureName: string): string | null {
    const content = readText(getPlanPath(this.projectRoot, featureName));
    return content === null ? null : content.replace(/\r\n/g, '\n');
  }

  private parseTasksFromPlan(content: string): ParsedTask[] {
    const tasksSection = extractTasksSectionContent(content);
    if (tasksSection === null) {
      return [];
    }

    const tasks: ParsedTask[] = [];
    const lines = tasksSection.split('\n');
    
    let currentTask: ParsedTask | null = null;
    let descriptionLines: string[] = [];
    
    // Regex to match "Depends on:" or "**Depends on**:" with optional markdown
    // Strips markdown formatting (**, *, etc.) and captures the value
    const dependsOnRegex = /^\s*\*{0,2}Depends\s+on\*{0,2}\s*:\s*(.+)$/i;
    const reposRegex = /^\s*\*{0,2}Repos\*{0,2}\s*:\s*(.*)$/i;
    let fence: FenceState | null = null;
    const nestedFences: FenceState[] = [];
    
    for (const line of lines) {
      const transition = getFenceTransition(line.trimEnd(), fence, nestedFences);
      if (transition) {
        if (!fence && transition.opened) {
          fence = transition.opened;
        } else if (transition.closedOuter) {
          fence = null;
        }
        if (currentTask) descriptionLines.push(line);
        continue;
      }

      if (fence) {
        if (currentTask) descriptionLines.push(line);
        continue;
      }

      // Check for task header: ### N. Task Name
      const taskMatch = line.match(/^ {0,3}###\s+(\d+)\.\s+(.+)$/);
      
      if (taskMatch) {
        // Save previous task if exists
        if (currentTask) {
          currentTask.description = descriptionLines.join('\n').trim();
          tasks.push(currentTask);
        }
        
        const order = parseInt(taskMatch[1], 10);
        const rawName = taskMatch[2].trim();
        const folderName = rawName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        const folder = `${String(order).padStart(2, '0')}-${folderName}`;
        
        currentTask = {
          folder,
          order,
          name: rawName,
          description: '',
          dependsOnNumbers: null,  // null = not specified, use implicit
          repoIds: null,
        };
        descriptionLines = [];
      } else if (currentTask) {
        // Check for end of task section (next task-level heading without a number)
        if (line.match(/^ {0,3}###\s+[^0-9]/)) {
          currentTask.description = descriptionLines.join('\n').trim();
          tasks.push(currentTask);
          currentTask = null;
          descriptionLines = [];
        } else {
          // Check for Depends on: annotation within task section
          const dependsMatch = line.match(dependsOnRegex);
          if (dependsMatch) {
            const value = dependsMatch[1].trim().toLowerCase();
            if (value === 'none') {
              currentTask.dependsOnNumbers = [];
            } else {
              // Parse comma-separated numbers
              const numbers = value
                .split(/[,\s]+/)
                .map(s => parseInt(s.trim(), 10))
                .filter(n => !isNaN(n));
              currentTask.dependsOnNumbers = numbers;
            }
          }
          const reposMatch = line.match(reposRegex);
          if (reposMatch) {
            const repoIds = reposMatch[1]
              .split(',')
              .map(repoId => repoId.trim())
              .filter(repoId => repoId.length > 0);
            this.validateRepoIds(repoIds, `plan.md task ${currentTask.order} ("${currentTask.name}")`);
            currentTask.repoIds = repoIds;
          }
          descriptionLines.push(line);
        }
      }
    }
    
    // Don't forget the last task
    if (currentTask) {
      currentTask.description = descriptionLines.join('\n').trim();
      tasks.push(currentTask);
    }

    return tasks;
  }

  createSubtask(featureName: string, taskFolder: string, name: string, type?: SubtaskType): Subtask {
    const subtasksPath = getSubtasksPath(this.projectRoot, featureName, taskFolder);
    ensureDir(subtasksPath);

    const existingFolders = this.listSubtaskFolders(featureName, taskFolder);
    const taskOrder = parseInt(taskFolder.split('-')[0], 10);
    const nextOrder = existingFolders.length + 1;
    const subtaskId = `${taskOrder}.${nextOrder}`;
    const folderName = `${nextOrder}-${this.slugify(name)}`;
    const subtaskPath = getSubtaskPath(this.projectRoot, featureName, taskFolder, folderName);

    ensureDir(subtaskPath);

    const subtaskStatus: SubtaskStatus = {
      status: 'pending',
      type,
      createdAt: new Date().toISOString(),
    };
    writeJson(getSubtaskStatusPath(this.projectRoot, featureName, taskFolder, folderName), subtaskStatus);

    const specContent = `# Subtask: ${name}\n\n**Type:** ${type || 'custom'}\n**ID:** ${subtaskId}\n\n## Instructions\n\n_Add detailed instructions here_\n`;
    writeText(getSubtaskSpecPath(this.projectRoot, featureName, taskFolder, folderName), specContent);

    return {
      id: subtaskId,
      name,
      folder: folderName,
      status: 'pending',
      type,
      createdAt: subtaskStatus.createdAt,
    };
  }

  updateSubtask(featureName: string, taskFolder: string, subtaskId: string, status: TaskStatusType): Subtask {
    return this.subtaskService.update(featureName, taskFolder, subtaskId, status);
  }

  listSubtasks(featureName: string, taskFolder: string): Subtask[] {
    return this.subtaskService.list(featureName, taskFolder);
  }

  deleteSubtask(featureName: string, taskFolder: string, subtaskId: string): void {
    this.subtaskService.delete(featureName, taskFolder, subtaskId);
  }

  getSubtask(featureName: string, taskFolder: string, subtaskId: string): Subtask | null {
    return this.subtaskService.get(featureName, taskFolder, subtaskId);
  }

  writeSubtaskSpec(featureName: string, taskFolder: string, subtaskId: string, content: string): string {
    return this.subtaskService.writeSpec(featureName, taskFolder, subtaskId, content);
  }

  writeSubtaskReport(featureName: string, taskFolder: string, subtaskId: string, content: string): string {
    return this.subtaskService.writeReport(featureName, taskFolder, subtaskId, content);
  }

  readSubtaskSpec(featureName: string, taskFolder: string, subtaskId: string): string | null {
    return this.subtaskService.readSpec(featureName, taskFolder, subtaskId);
  }

  readSubtaskReport(featureName: string, taskFolder: string, subtaskId: string): string | null {
    return this.subtaskService.readReport(featureName, taskFolder, subtaskId);
  }

  private listSubtaskFolders(featureName: string, taskFolder: string): string[] {
    const subtasksPath = getSubtasksPath(this.projectRoot, featureName, taskFolder);
    if (!fileExists(subtasksPath)) return [];

    return fs.readdirSync(subtasksPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  }

  private buildManualTaskSpec(
    featureName: string,
    folder: string,
    name: string,
    dependsOn: string[],
    metadata?: ManualTaskMetadata,
  ): string {
    const lines: string[] = [
      `# Task: ${folder}`,
      '',
      `## Feature: ${featureName}`,
      '',
      '## Dependencies',
      '',
    ];

    if (dependsOn.length > 0) {
      for (const dep of dependsOn) {
        lines.push(`- ${dep}`);
      }
    } else {
      lines.push('_None_');
    }

    lines.push('');

    if (metadata?.repoIds !== undefined) {
      lines.push('## Repositories', '');
      for (const repoId of metadata.repoIds) {
        lines.push(`- ${repoId}`);
      }
      lines.push('');
    }

    if (metadata?.goal) {
      lines.push('## Goal', '', metadata.goal, '');
    }

    if (metadata?.description) {
      lines.push('## Description', '', metadata.description, '');
    }

    if (metadata?.acceptanceCriteria && metadata.acceptanceCriteria.length > 0) {
      lines.push('## Acceptance Criteria', '');
      for (const criterion of metadata.acceptanceCriteria) {
        lines.push(`- ${criterion}`);
      }
      lines.push('');
    }

    if (metadata?.files && metadata.files.length > 0) {
      lines.push('## Files', '');
      for (const file of metadata.files) {
        lines.push(`- ${file}`);
      }
      lines.push('');
    }

    if (metadata?.references && metadata.references.length > 0) {
      lines.push('## References', '');
      for (const ref of metadata.references) {
        lines.push(`- ${ref}`);
      }
      lines.push('');
    }

    if (metadata?.source || metadata?.reason) {
      lines.push('## Origin', '');
      if (metadata?.source) {
        lines.push(`**Source:** ${metadata.source}`);
      }
      if (metadata?.reason) {
        lines.push(`**Reason:** ${metadata.reason}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private slugify(name: string): string {
    return name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
  }
}
