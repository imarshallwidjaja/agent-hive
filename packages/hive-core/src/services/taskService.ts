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
  getTaskSyncPath,
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
  PlanSyncStatus,
  TaskSyncCheckpoint,
} from '../types.js';
import { getPlanContentHash } from './planService.js';
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
  /** Pending plan tasks still in the plan take their title, dependencies, repositories and spec from it. */
  refreshPending?: boolean;
  /**
   * Unfinished plan tasks (pending, in_progress, blocked, failed, partial) to refresh from the current plan by
   * folder identity. Selecting a task is the caller's attestation that no assignment for it is still running and
   * that its changed scope has been reconciled; sync does not infer either from task status.
   */
  refreshTasks?: string[];
  /** Raw plan.md content hash the caller reviewed and approved; a different plan rejects the sync before any write. */
  expectedContentHash?: string;
  /**
   * Task folders that have a retained worktree, from the caller's inspection, or 'unknown' (the default) when it
   * was not inspected. A selected task whose repositories change is rejected unless it is known to have none.
   */
  retainedWorktreeTasks?: ReadonlySet<string> | 'unknown';
}

export type TaskSyncStage = 'validation' | 'checkpoint' | 'tasks' | 'verification' | 'publication_unconfirmed';

/** Task changes a sync applied before it failed; sync does not roll them back. */
export interface TaskSyncApplied {
  removed: string[];
  created: string[];
  refreshed: string[];
}

export type TaskSyncAction = 'remove' | 'create' | 'refresh';

/**
 * The task action running when a sync failed. It is not in `applied`: a write can fail before or after its rename
 * publishes, so its files may be unchanged, partly written or fully written.
 */
export interface TaskSyncInterrupted {
  action: TaskSyncAction;
  folder: string;
}

/**
 * A failed task sync. `validation` failures wrote nothing and `checkpoint` failures wrote no task file. Later stages
 * may have applied some task changes, listed in `applied`, and may have been cut off inside another action, named in
 * `interrupted`. A `tasks` failure never attempted the reconciled record, so task-sync.json holds `incomplete`. A
 * `verification` failure read task-sync.json back after the reconciled write reported an error and found no
 * reconciliation of this plan content. A `publication_unconfirmed` failure could not read the record back, so whether
 * the write published is unknown: a later read of plan sync status describes the record then, not what this call
 * published, and the caller reads it before replaying sync.
 */
export class TaskSyncError extends Error {
  public readonly applied: TaskSyncApplied;
  public readonly interrupted: TaskSyncInterrupted | null;

  constructor(
    message: string,
    public readonly stage: TaskSyncStage,
    detail: { applied: TaskSyncApplied; interrupted: TaskSyncInterrupted | null; cause?: unknown },
  ) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.name = 'TaskSyncError';
    this.applied = detail.applied;
    this.interrupted = detail.interrupted;
  }
}

const UNFINISHED_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'blocked', 'failed', 'partial']);
/** Statuses whose plan task folder holds started or finished work that a renamed heading must not replace. */
const REPLACEMENT_PROTECTED_STATUSES: ReadonlySet<string> = new Set(['in_progress', 'blocked', 'failed', 'partial', 'done']);

const PLAN_SYNC_CHANGED_HINT =
  'Plan changed since task sync. Check affected tasks and shared contracts; review/approve and resync as needed before dispatch.';

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function listFolders(folders: string[]): string {
  const shown = folders.slice(0, 5).join(', ');
  return folders.length > 5 ? `${shown} (+${folders.length - 5} more)` : shown;
}

const INTERRUPTED_ACTIONS: Record<TaskSyncAction, { verb: string; files: string }> = {
  remove: { verb: 'removing', files: 'its task folder may be partly or fully deleted' },
  create: {
    verb: 'creating',
    files: 'its folder, status.json and spec.md may be missing, partly written or complete; a retry with refreshPending: true rewrites a pending plan task\'s files',
  },
  refresh: { verb: 'refreshing', files: 'spec.md and status.json may each hold the old or the new content' },
};

function describeProgress(applied: TaskSyncApplied, interrupted: TaskSyncInterrupted | null): string {
  const parts = (['removed', 'created', 'refreshed'] as const)
    .filter((key) => applied[key].length > 0)
    .map((key) => `${key} ${applied[key].join(', ')}`);
  const sentences = [
    ...(parts.length > 0 ? [`Applied before the failure and not rolled back: ${parts.join('; ')}.`] : []),
    ...(interrupted
      ? [`Interrupted while ${INTERRUPTED_ACTIONS[interrupted.action].verb} ${interrupted.folder}, which is not counted as applied: ${INTERRUPTED_ACTIONS[interrupted.action].files}. Inspect it before retrying.`]
      : []),
  ];
  return sentences.length === 0 ? 'No task files were changed.' : sentences.join(' ');
}

/** What each failure stage that may have changed task files says about task-sync.json. */
const RECORD_AFTER_FAILURE: Partial<Record<TaskSyncStage, string>> = {
  tasks: 'task-sync.json records incomplete.',
  verification: 'Reading task-sync.json back showed no reconciliation of this plan content, so plan sync status read at that point was not current.',
  publication_unconfirmed:
    'Read plan sync status with hive_status before replaying sync: a later read shows what task-sync.json holds then, not what this call published.',
};

/** What a read of task-sync.json shows about the reconciliation a sync just tried to publish. */
type ReconciliationReadback = { outcome: 'recorded' | 'not_recorded' } | { outcome: 'unavailable'; reason: string };

function isTaskSyncCheckpoint(value: unknown): value is TaskSyncCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return false;
  if (record.state === 'reconciled') return typeof record.lastReconciledContentHash === 'string';
  return record.state === 'incomplete'
    && (record.lastReconciledContentHash === null || typeof record.lastReconciledContentHash === 'string');
}

function assertRefreshTaskList(refreshTasks: unknown): asserts refreshTasks is string[] {
  if (!Array.isArray(refreshTasks) || refreshTasks.length === 0) {
    throw new Error('refreshTasks must be a nonempty list of task folders.');
  }
  const seen = new Set<string>();
  for (const folder of refreshTasks) {
    if (typeof folder !== 'string' || folder.trim().length === 0) throw new Error('refreshTasks entries must be nonblank task folders.');
    if (seen.has(folder)) throw new Error(`refreshTasks names "${folder}" more than once.`);
    seen.add(folder);
  }
}

export type TaskStatusEntry =
  | (TaskInfo & { dependsOn: string[]; blocker?: TaskStatus['blocker'] })
  | { folder: string; name: string; status: null; integrity: { reason: 'status_missing' | 'status_unreadable'; error?: string } };

const TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending', 'in_progress', 'done', 'cancelled', 'blocked', 'failed', 'partial',
]);

/** The first stored field that readers consume and that has the wrong shape; absent fields are valid. */
function storedStatusFieldProblem(status: TaskStatus): string | null {
  if (status.origin !== undefined && status.origin !== 'plan' && status.origin !== 'manual') {
    return 'origin must be "plan" or "manual"';
  }
  if (status.planTitle !== undefined && typeof status.planTitle !== 'string') return 'planTitle must be a string';
  if (status.dependsOn !== undefined
    && (!Array.isArray(status.dependsOn) || status.dependsOn.some((dependency) => typeof dependency !== 'string'))) {
    return 'dependsOn must be an array of task folder names';
  }
  if (status.blocker !== undefined
    && (typeof status.blocker !== 'object' || status.blocker === null || typeof status.blocker.reason !== 'string')) {
    return 'blocker must be an object with a string reason';
  }
  return null;
}

export function validateStoredTaskStatus(status: TaskStatus | null, taskFolder: string): void {
  if (!status || typeof status !== 'object' || !TASK_STATUSES.has(status.status)) {
    throw new Error(`Task '${taskFolder}' has a corrupt status file`);
  }
  const problem = storedStatusFieldProblem(status);
  if (problem) throw new Error(`Task '${taskFolder}' has a corrupt status file: ${problem}.`);
}

function listTaskFolders(tasksPath: string): string[] {
  if (!fileExists(tasksPath)) return [];

  return fs.readdirSync(tasksPath, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

/**
 * Inspects every retained task folder under `tasksPath` without treating missing or corrupt status as
 * pending. `guard` runs before the tasks directory and each status file is touched; a throw from it makes
 * the whole listing fail for the directory and marks the one task unreadable for a status file.
 */
export function readTaskStatusEntries(tasksPath: string, guard: (target: string) => void = () => {}): TaskStatusEntry[] {
  guard(tasksPath);
  return listTaskFolders(tasksPath).map((folder): TaskStatusEntry => {
    const identity = { folder, name: folder.replace(/^\d+-/, '') };
    const statusPath = path.join(tasksPath, folder, 'status.json');
    try {
      guard(statusPath);
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

export class TaskService {
  private readonly subtaskService: SubtaskService;

  constructor(
    private projectRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.subtaskService = new SubtaskService(projectRoot);
  }

  /**
   * Reconcile task records with the current plan. Syncs of one feature are serialized by the task-sync.json lock;
   * every action is derived and the resulting stored graph validated before anything is written. task-sync.json
   * durably records `incomplete` before the first task write, and is replaced by `reconciled` only after the plan is
   * unchanged and every unfinished plan task matches it; a skipped task or a failure before that replacement leaves it
   * `incomplete`, and an error reported by the replacement itself is settled by reading the record back.
   */
  sync(featureName: string, options: SyncOptions = {}): TasksSyncResult {
    const applied: TaskSyncApplied = { removed: [], created: [], refreshed: [] };
    let interrupted: TaskSyncInterrupted | null = null;
    const fail = (stage: TaskSyncStage, message: string, cause?: unknown): never => {
      const record = RECORD_AFTER_FAILURE[stage];
      throw new TaskSyncError(
        stage === 'validation' ? message : `${message} ${describeProgress(applied, interrupted)}${record ? ` ${record}` : ''}`,
        stage,
        { applied, interrupted, cause },
      );
    };
    const validationMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
    try {
      if (options.refreshTasks !== undefined) assertRefreshTaskList(options.refreshTasks);
    } catch (error) {
      fail('validation', `refreshTasks rejected; no task files were changed. ${validationMessage(error)}`);
    }
    const planPath = getPlanPath(this.projectRoot, featureName);
    if (!fileExists(planPath)) fail('validation', `No plan.md found for feature '${featureName}'`);

    const syncPath = getTaskSyncPath(this.projectRoot, featureName);
    const release = acquireLockSync(syncPath, { staleLockTTL: Number.POSITIVE_INFINITY });
    try {
      const rawPlan = readText(planPath);
      if (rawPlan === null) return fail('validation', `No plan.md found for feature '${featureName}'`);
      const contentHash = getPlanContentHash(rawPlan);
      if (options.expectedContentHash !== undefined && options.expectedContentHash !== contentHash) {
        fail('validation',
          'Task sync rejected; no task files were changed. plan.md changed after the content this sync was asked to apply '
          + `(expected content hash ${options.expectedContentHash}, current ${contentHash}). Read and review the current plan before approving and syncing again.`);
      }
      const planContent = rawPlan.replace(/\r\n/g, '\n');

      let derived: ReturnType<TaskService['deriveSync']>;
      try {
        derived = this.deriveSync(featureName, planContent, options);
      } catch (error) {
        return fail('validation', validationMessage(error));
      }
      const { result, planTasks, removals, creates, refreshes } = derived;

      let previousHash: string | null = null;
      try {
        previousHash = this.readTaskSyncCheckpoint(featureName)?.lastReconciledContentHash ?? null;
      } catch {
        // An unreadable record carries no reconciled hash; this sync replaces it.
      }
      try {
        writeJsonAtomicDurable(syncPath, { schemaVersion: 1, state: 'incomplete', lastReconciledContentHash: previousHash } satisfies TaskSyncCheckpoint);
      } catch (error) {
        fail('checkpoint', `Task sync could not record its start in task-sync.json: ${validationMessage(error)}.`, error);
      }

      const skipped: string[] = [];
      // The action is recorded before it runs and cleared only when its helper returns, so a throw names the
      // action whose files may be partly written instead of inferring "nothing changed" from the missing result.
      const act = (action: TaskSyncAction, folder: string, apply: () => boolean, done: string[]) => {
        interrupted = { action, folder };
        if (apply()) done.push(folder);
        else skipped.push(folder);
        interrupted = null;
      };
      try {
        for (const folder of removals) act('remove', folder, () => this.removePendingPlanTask(featureName, folder), applied.removed);
        for (const { task, built } of creates) act('create', task.folder, () => this.createFromPlan(featureName, task, built), applied.created);
        for (const { task, built, selected } of refreshes) {
          act('refresh', task.folder, () => this.refreshPlanTask(featureName, task, built, selected), applied.refreshed);
        }
      } catch (error) {
        fail('tasks', `Task sync failed while writing task files: ${validationMessage(error)}.`, error);
      }

      let reconciled = false;
      try {
        const currentPlan = readText(planPath);
        reconciled = skipped.length === 0
          && currentPlan !== null
          && getPlanContentHash(currentPlan) === contentHash
          && this.findTaskDrift(featureName, planContent, planTasks).length === 0;
      } catch {
        // Unverifiable task state is not reconciled.
      }
      if (reconciled) {
        // Renaming this record over the incomplete one is the sync's last effect, so no step that can fail runs after
        // reconciliation becomes visible. It is deliberately not flushed: a directory flush failing after the rename
        // would report failure for a sync whose reconciliation is already published. A crash can revert the record to
        // incomplete or leave it unreadable, which reads as incomplete or unknown, not as current.
        try {
          writeJsonAtomic(syncPath, { schemaVersion: 1, state: 'reconciled', lastReconciledContentHash: contentHash } satisfies TaskSyncCheckpoint);
        } catch (error) {
          // A failed rename leaves the incomplete record. One that reports an error after taking effect, as a retried
          // request on a network filesystem can, has published reconciliation, so the record read back decides. When
          // it cannot be read back the outcome is unknown, which is neither success nor a confirmed failure.
          const readback = this.readbackReconciliation(featureName, contentHash);
          if (readback.outcome === 'not_recorded') {
            fail('verification', `Task sync applied its task changes but could not record reconciliation in task-sync.json: ${validationMessage(error)}.`, error);
          }
          if (readback.outcome === 'unavailable') {
            fail('publication_unconfirmed',
              `Task sync applied its task changes, but whether task-sync.json records reconciliation is unconfirmed: writing it reported "${validationMessage(error)}" and reading it back failed with "${readback.reason}".`,
              error);
          }
        }
      }

      result.removed = applied.removed;
      result.created = applied.created;
      if (applied.refreshed.length > 0) result.refreshed = applied.refreshed;
      if (skipped.length > 0) result.skipped = skipped;
      const unownedTaskHeadings = listUnownedTaskHeadings(readPlanTaskLayout(planContent));
      if (unownedTaskHeadings.length > 0) result.unownedTaskHeadings = unownedTaskHeadings;
      return result;
    } finally {
      release();
    }
  }

  /**
   * Check a refreshTasks selection against the current plan and task records without writing anything, so a caller
   * can reject it before approval. Sync repeats the same checks under its lock.
   */
  validateRefreshTasks(featureName: string, refreshTasks: string[]): void {
    assertRefreshTaskList(refreshTasks);
    const planContent = this.readNormalizedPlanContent(featureName);
    if (!planContent) throw new Error(`No plan.md found for feature '${featureName}'`);
    const planTasks = this.parseTasksFromPlan(planContent);
    this.assertRefreshSelection(
      refreshTasks,
      new Map(this.readStoredTaskRecords(featureName).map(({ folder, status }) => [folder, status])),
      new Set(planTasks.map((task) => task.folder)),
    );
  }

  /**
   * Whether stored tasks reflect the current plan content, for advisory display. Read-only: it creates no files,
   * directories or locks, and an unreadable record reports `unknown` rather than being repaired.
   */
  getPlanSyncStatus(featureName: string): PlanSyncStatus {
    let checkpoint: TaskSyncCheckpoint | null;
    try {
      checkpoint = this.readTaskSyncCheckpoint(featureName);
    } catch {
      return { state: 'unknown', hint: 'task-sync.json is unreadable, so whether tasks match the plan is unknown. Compare affected tasks with the plan before dispatch; the next task sync rewrites the record.' };
    }
    if (!checkpoint) {
      return { state: 'unknown', hint: 'No task sync is recorded for this feature, so whether tasks match the plan is unknown. Compare affected tasks with the plan, or approve and sync, before dispatch.' };
    }
    const rawPlan = readText(getPlanPath(this.projectRoot, featureName));
    if (rawPlan === null) return { state: 'unknown', hint: 'plan.md is missing, so there is no plan to compare tasks with.' };

    // A content change already decides a reconciled record; comparing every task would be discarded.
    if (checkpoint.state === 'reconciled' && checkpoint.lastReconciledContentHash !== getPlanContentHash(rawPlan)) {
      return { state: 'changed', hint: PLAN_SYNC_CHANGED_HINT };
    }

    let drift: string[] | null = null;
    try {
      const planContent = rawPlan.replace(/\r\n/g, '\n');
      const planTasks = this.parseTasksFromPlan(planContent);
      this.validateDependencyGraph(planTasks, featureName);
      drift = this.findTaskDrift(featureName, planContent, planTasks);
    } catch {
      // An invalid plan or unreadable task record cannot be compared.
    }
    if (checkpoint.state === 'incomplete') {
      return {
        state: 'incomplete',
        hint: `Task sync did not finish reconciling tasks with the plan${drift?.length ? `; tasks that differ from the current plan: ${listFolders(drift)}` : ''}. `
          + 'Check affected tasks and shared contracts; review/approve and resync (refreshTasks for started tasks) before dispatch.',
      };
    }
    if (drift === null) return { state: 'unknown', hint: 'The plan or a task record cannot be read for comparison, so whether tasks match the plan is unknown.' };
    if (drift.length > 0) {
      return {
        state: 'incomplete',
        hint: `Task records differ from the synced plan: ${listFolders(drift)}. Check them and resync (refreshTasks for started tasks) before dispatch.`,
      };
    }
    return { state: 'current' };
  }

  /** Every action a sync would take and the stored graph it would produce; throws, writing nothing, when invalid. */
  private deriveSync(featureName: string, planContent: string, options: SyncOptions) {
    const planTasks = this.parseTasksFromPlan(planContent);
    this.validateDependencyGraph(planTasks, featureName);

    const result: TasksSyncResult = { created: [], removed: [], kept: [], manual: [] };
    const planByFolder = new Map(planTasks.map(task => [task.folder, task]));
    const stored = this.readStoredTaskRecords(featureName);
    const selected = new Set(options.refreshTasks ?? []);
    this.assertRefreshSelection([...selected], new Map(stored.map(({ folder, status }) => [folder, status])), new Set(planByFolder.keys()));
    const retainedWorktrees = options.retainedWorktreeTasks ?? 'unknown';
    const refreshPending = options.refreshPending === true;

    const removals: string[] = [];
    const creates: Array<{ task: ParsedTask; built: PlanTaskBuild }> = [];
    const refreshes: Array<{ task: ParsedTask; built: PlanTaskBuild; selected: boolean }> = [];
    const proposed: GraphNode[] = [];
    const existingFolders = new Set<string>();

    for (const { folder, status } of stored) {
      existingFolders.add(folder);
      const planTask = planByFolder.get(folder);
      if (!status) {
        if (planTask) {
          throw new Error(
            `Task sync rejected; no task files were changed. Task folder "${folder}" has no status file, and sync does not recreate it. ` +
            'Inspect and repair the task record before syncing again.',
          );
        }
        continue;
      }
      let dependsOn = status.dependsOn;
      let fromPlan = false;
      const refresh = (task: ParsedTask, isSelected: boolean) => {
        const built = this.buildPlanTaskSpec(featureName, task, planTasks, planContent);
        if (isSelected && !sameList(status.repoIds, task.repoIds ?? undefined)
          && (retainedWorktrees === 'unknown' || retainedWorktrees.has(folder))) {
          throw new Error(
            `refreshTasks rejected; no task files were changed. "${folder}" would change repositories from ` +
            `${status.repoIds?.join(', ') ?? '(project root)'} to ${task.repoIds?.join(', ') ?? '(project root)'}, and ` +
            (retainedWorktrees === 'unknown' ? 'its worktrees could not be inspected. ' : 'it has a retained worktree whose placement keeps the old repositories. ') +
            'Integrate or clean up that worktree first, or keep the task\'s Repos line unchanged.',
          );
        }
        refreshes.push({ task, built, selected: isSelected });
        dependsOn = built.dependsOn;
        fromPlan = true;
      };

      if (status.origin === 'manual') {
        result.manual.push(folder);
      } else if (status.status !== 'pending') {
        // Execution history and cancelled records are retained with their stored edges unless explicitly selected.
        result.kept.push(folder);
        if (planTask && selected.has(folder)) refresh(planTask, true);
      } else if (!planTask) {
        const history = this.describeExecutionHistory(featureName, folder, status);
        if (history) {
          throw new Error(
            `Task sync rejected; no task files were changed. Pending plan task "${folder}" has no heading in plan.md but retains ${history}; ` +
            'sync does not delete task history. Restore its plan heading, or cancel it with hive_task_update to keep it as a retained record, then sync again.',
          );
        }
        removals.push(folder);
        continue;
      } else {
        result.kept.push(folder);
        if (refreshPending || selected.has(folder)) refresh(planTask, selected.has(folder));
      }
      proposed.push({ folder, status: status.status, origin: status.origin, dependsOn, fromPlan });
    }

    for (const planTask of planTasks) {
      if (existingFolders.has(planTask.folder)) continue;
      const replaced = stored.find(({ folder, status }) => status
        && status.origin !== 'manual'
        && REPLACEMENT_PROTECTED_STATUSES.has(status.status)
        && !planByFolder.has(folder)
        && parseInt(folder, 10) === planTask.order);
      if (replaced) {
        throw new Error(
          `Task sync rejected; no task files were changed. plan.md task ${planTask.order} now produces folder "${planTask.folder}", ` +
          `but "${replaced.folder}" (${replaced.status!.status}) holds that task's retained work. Sync does not rename task folders or ` +
          `create a replacement beside started or finished work: restore the heading title that produces "${replaced.folder}", or give the new task its own number.`,
        );
      }
      const built = this.buildPlanTaskSpec(featureName, planTask, planTasks, planContent);
      creates.push({ task: planTask, built });
      proposed.push({ folder: planTask.folder, status: 'pending', origin: 'plan', dependsOn: built.dependsOn, fromPlan: true });
    }

    const violation = findUnfinishedDependencyViolation(proposed);
    if (violation) {
      throw new Error(
        `Task sync rejected; no task files were changed. ` +
        this.describeDependencyViolation(violation, proposed, planTasks, new Set(removals)),
      );
    }
    return { result, planTasks, removals, creates, refreshes };
  }

  private assertRefreshSelection(
    refreshTasks: string[],
    stored: ReadonlyMap<string, TaskStatus | null>,
    planFolders: ReadonlySet<string>,
  ): void {
    for (const folder of refreshTasks) {
      const reject = (reason: string): never => {
        throw new Error(`refreshTasks rejected; no task files were changed. ${reason}`);
      };
      if (!stored.has(folder)) reject(`"${folder}" is not a task of this feature.`);
      const status = stored.get(folder);
      if (!status) reject(`"${folder}" has no readable status file; inspect and repair it first.`);
      if (status!.origin === 'manual') reject(`"${folder}" is a manual task; refreshTasks applies only to plan tasks.`);
      if (!UNFINISHED_STATUSES.has(status!.status)) {
        reject(`"${folder}" is ${status!.status}; refreshTasks applies only to unfinished plan tasks (pending, in_progress, blocked, failed, partial), and finished or cancelled records keep their history.`);
      }
      if (!planFolders.has(folder)) {
        reject(`plan.md has no task heading that produces "${folder}". Refresh matches tasks by folder, so a retitled heading needs its old title back; create new work as a new task.`);
      }
    }
  }

  /**
   * Folders whose records do not match the current plan: a plan task without a readable record; an unfinished plan
   * task whose title, dependencies, repositories or spec differ; an unfinished plan task the plan no longer lists;
   * any status-less folder; or an unfinished task in an invalid stored dependency graph. Manual, done and cancelled
   * records are history and are not compared.
   */
  private findTaskDrift(featureName: string, planContent: string, planTasks: ParsedTask[]): string[] {
    const records = this.readStoredTaskRecords(featureName);
    const byFolder = new Map(records.map(({ folder, status }) => [folder, status]));
    const planFolders = new Set(planTasks.map(task => task.folder));
    const drift = new Set<string>();

    for (const task of planTasks) {
      const status = byFolder.get(task.folder);
      if (!status) {
        drift.add(task.folder);
        continue;
      }
      if (status.origin === 'manual' || !UNFINISHED_STATUSES.has(status.status)) continue;
      const built = this.buildPlanTaskSpec(featureName, task, planTasks, planContent);
      const matches = status.planTitle === task.name
        && sameList(status.dependsOn ?? [], built.dependsOn)
        && sameList(status.repoIds, task.repoIds ?? undefined)
        && readText(getTaskSpecPath(this.projectRoot, featureName, task.folder)) === built.spec;
      if (!matches) drift.add(task.folder);
    }
    for (const { folder, status } of records) {
      if (!status) drift.add(folder);
      else if (!planFolders.has(folder) && status.origin !== 'manual' && UNFINISHED_STATUSES.has(status.status)) drift.add(folder);
    }

    const violation = findUnfinishedDependencyViolation(records.flatMap(({ folder, status }) => status
      ? [{ folder, status: status.status, dependsOn: status.dependsOn }]
      : []));
    if (violation) drift.add(violation.kind === 'cycle' ? violation.path[0]! : violation.source);
    return [...drift].sort();
  }

  /** What execution history a task folder retains, or null when it has none. */
  private describeExecutionHistory(featureName: string, folder: string, status: TaskStatus): string | null {
    const taskPath = getTaskPath(this.projectRoot, featureName, folder);
    const reportsPath = path.join(taskPath, 'reports');
    const found = [
      ...(status.startedAt || status.completedAt ? ['a recorded start'] : []),
      ...(fileExists(path.join(taskPath, 'report.md')) || (fileExists(reportsPath) && fs.readdirSync(reportsPath).length > 0) ? ['reports'] : []),
      ...(fileExists(getTaskHandoffPath(this.projectRoot, featureName, folder)) ? ['a handoff'] : []),
    ];
    return found.length > 0 ? found.join(', ') : null;
  }

  /** The task sync record, null when none exists; throws when it is unreadable or malformed. */
  private readTaskSyncCheckpoint(featureName: string): TaskSyncCheckpoint | null {
    const checkpoint = readJson<unknown>(getTaskSyncPath(this.projectRoot, featureName));
    if (checkpoint === null) return null;
    if (!isTaskSyncCheckpoint(checkpoint)) throw new Error('task-sync.json has an unexpected shape');
    return checkpoint;
  }

  /**
   * Reads task-sync.json to learn whether it records reconciliation of this plan content. Only a readable record
   * establishes the answer; a missing, unreadable or malformed one is `unavailable`, not proof of nonpublication.
   */
  private readbackReconciliation(featureName: string, contentHash: string): ReconciliationReadback {
    try {
      const checkpoint = this.readTaskSyncCheckpoint(featureName);
      if (checkpoint === null) return { outcome: 'unavailable', reason: 'task-sync.json is missing' };
      const recorded = checkpoint.state === 'reconciled' && checkpoint.lastReconciledContentHash === contentHash;
      return { outcome: recorded ? 'recorded' : 'not_recorded' };
    } catch (error) {
      return { outcome: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
    }
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

  /** Creates a new plan task folder; false, writing nothing, when the folder appeared after sync derived it. */
  private createFromPlan(featureName: string, task: ParsedTask, { dependsOn, spec }: PlanTaskBuild): boolean {
    const taskPath = getTaskPath(this.projectRoot, featureName, task.folder);
    if (fileExists(taskPath)) return false;
    ensureDir(taskPath);

    const status: TaskStatus = {
      status: 'pending',
      origin: 'plan',
      planTitle: task.name,
      dependsOn,
      ...(task.repoIds !== null ? { repoIds: task.repoIds } : {}),
    };
    writeJsonAtomicDurable(getTaskStatusPath(this.projectRoot, featureName, task.folder), status);
    writeAtomicDurable(getTaskSpecPath(this.projectRoot, featureName, task.folder), spec);
    return true;
  }

  /**
   * Rewrites only the plan-owned fields (title, dependencies, repositories) and spec of an existing plan task, under
   * the same status lock as update(). Eligibility is rechecked on the locked record, so a concurrent status change
   * is kept and a task that became finished is not reopened: such a task is skipped and false is returned.
   */
  private refreshPlanTask(featureName: string, task: ParsedTask, { dependsOn, spec }: PlanTaskBuild, selected: boolean): boolean {
    const statusPath = getTaskStatusPath(this.projectRoot, featureName, task.folder);
    if (!fileExists(statusPath)) return false;
    const release = acquireLockSync(statusPath, { staleLockTTL: Number.POSITIVE_INFINITY });
    try {
      const current = this.readValidatedTaskStatus(statusPath, task.folder);
      const eligible = current !== null
        && current.origin !== 'manual'
        && (selected ? UNFINISHED_STATUSES.has(current.status) : current.status === 'pending');
      if (!eligible) return false;
      const updated: TaskStatus = { ...current, planTitle: task.name, dependsOn };
      if (task.repoIds !== null) updated.repoIds = task.repoIds;
      else delete updated.repoIds;
      writeAtomicDurable(getTaskSpecPath(this.projectRoot, featureName, task.folder), spec);
      writeJsonAtomicDurable(statusPath, updated);
      return true;
    } finally {
      release();
    }
  }

  /** Removes a pending plan task without history under its status lock; false when its record changed meanwhile. */
  private removePendingPlanTask(featureName: string, folder: string): boolean {
    const statusPath = getTaskStatusPath(this.projectRoot, featureName, folder);
    if (!fileExists(statusPath)) return false;
    const release = acquireLockSync(statusPath, { staleLockTTL: Number.POSITIVE_INFINITY });
    try {
      const current = this.readValidatedTaskStatus(statusPath, folder);
      if (!current || current.origin === 'manual' || current.status !== 'pending'
        || this.describeExecutionHistory(featureName, folder, current)) {
        return false;
      }
      fs.rmSync(getTaskPath(this.projectRoot, featureName, folder), { recursive: true });
      return true;
    } finally {
      release();
    }
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
    return readTaskStatusEntries(getTasksPath(this.projectRoot, featureName));
  }

  private listFolders(featureName: string): string[] {
    return listTaskFolders(getTasksPath(this.projectRoot, featureName));
  }

  private getNextOrder(existingFolders: string[]): number {
    if (existingFolders.length === 0) return 1;
    
    const orders = existingFolders
      .map(f => parseInt(f.split('-')[0], 10))
      .filter(n => !isNaN(n));
    
    return Math.max(...orders, 0) + 1;
  }

  /** Every task folder with its validated status, null when the folder has no status file; throws on a corrupt one. */
  private readStoredTaskRecords(featureName: string): Array<{ folder: string; status: TaskStatus | null }> {
    return this.listFolders(featureName).map(folder => ({
      folder,
      status: this.readValidatedTaskStatus(getTaskStatusPath(this.projectRoot, featureName, folder), folder),
    }));
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
      } else if (node.origin !== 'manual' && UNFINISHED_STATUSES.has(node.status) && planTasks?.some(task => task.folder === folder)) {
        lines.push(
          `"${folder}" is a started plan task with outdated stored dependencies: amend its "Depends on:" line in ` +
          `plan.md if needed. Once its prior assignment is terminal and its scope reconciled, approve and sync with ` +
          `hive_plan_approve and refreshTasks naming it; hive_tasks_sync cannot select it.`
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
