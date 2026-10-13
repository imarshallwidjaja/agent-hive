import type { BackgroundJobRecord, BackgroundJobService } from 'hive-core';
import { isBackgroundJobArchived } from 'hive-core';
import type { HiveOperation } from '../runtime/hive-tools.js';
import { z } from '../runtime/schema.js';
import { classifyRuntimeEpochStaleJobs } from './backgroundJobAdapter.js';

/**
 * The four background board operations, shared by both hosts. Each host registers them its own way (v1 as plugin
 * tools with a JSON text result, v2 through the Hive registrar with a structured result); the board semantics, scope
 * checks and results are the same. The board is observational bookkeeping: archiving a row never stops a worker or
 * authorizes a replacement writer.
 */

/** The caller of one board operation. The agent is display-only (`scope.primaryAgent`); a host may not supply it. */
export type BoardInvocation = {
  sessionID?: string;
  agent?: string;
};

/**
 * What the host's native interruption reported. `cancelled` means the host confirmed the worker was cancelled (v1's
 * abort result). `acknowledged` means the host accepted an interruption of active work without confirming that the
 * worker stopped (v2); the board then keeps the cancel request and waits for settlement and the native completion
 * notification instead of recording a cancellation.
 */
export interface RuntimeCancelResult {
  cancelled: boolean;
  acknowledged?: boolean;
  message?: string;
}

/**
 * Whether the host adapter is still observing everything the board needs. When it is not, every live row it launched
 * is uncertain; `uncertaintyPending` means some of those rows could not be marked yet and the board may still show
 * them running.
 */
export type ObservationHealth = { healthy: true } | { healthy: false; reason: string; uncertaintyPending: boolean };

export interface CreateBackgroundOperationsOptions {
  backgroundJobService: BackgroundJobService;
  projectRoot: string;
  isEnabled: () => boolean;
  currentRuntimeId?: string;
  cancelRuntimeTask?: (sessionId: string, context: BoardInvocation) => Promise<RuntimeCancelResult> | RuntimeCancelResult;
  /** Checked before each status read; it may retry pending uncertainty writes first. A host without it reports none. */
  checkObservation?: () => ObservationHealth;
}

type ReconcileDecision = 'reconciled' | 'ignored';
type RecommendedNextAction = Record<string, string | string[] | boolean | undefined>;

type ReconcileResult = { identifier: string; decision: ReconcileDecision } & (
  | { success: true; archived: true; state: 'archived_after_reconcile' | 'ignored_archived'; requiresHiveStatusRefresh: boolean }
  | { success: false; reason: string; error: string; hint: string }
);

const reconcileItem = {
  identifier: z.string().describe('Task ID, session ID, or scoped alias to reconcile.'),
  decision: z.enum(['reconciled', 'ignored']).describe('Whether the terminal job was reconciled into task state or intentionally ignored. Stale non-terminal jobs may only be ignored.'),
  summary: z.string().describe('Required reconciliation summary or ignore reason.'),
};

const boardOperation = (definition: Omit<HiveOperation, 'output'>): HiveOperation => ({ ...definition, output: 'json' });

export function createBackgroundOperations(options: CreateBackgroundOperationsOptions): Record<string, HiveOperation> {
  const cancelRuntimeTask: NonNullable<CreateBackgroundOperationsOptions['cancelRuntimeTask']> = options.cancelRuntimeTask ?? (async () => ({
    cancelled: false,
    message: 'Runtime cancellation is not available through this plugin context.',
  }));

  return {
    hive_background_status: boardOperation({
      description: 'List background jobs visible to the current primary session scope.',
      args: {
        feature: z.string().optional().describe('Optional feature scope filter.'),
        task: z.string().optional().describe('Optional task scope filter.'),
        adHocRunId: z.string().optional().describe('Optional ad-hoc run scope filter.'),
        workflow: z.string().optional().describe('Optional workflow scope filter.'),
        includeArchived: z.boolean().optional().describe('Include reconciled or ignored background jobs archived by Hive background tools.'),
      },
      execute: ({ feature, task, adHocRunId, workflow, includeArchived }, toolContext: BoardInvocation) => {
        if (!options.isEnabled()) {
          return disabledResponse();
        }

        const observation = options.checkObservation?.();
        classifyRuntimeEpochStaleJobs({
          service: options.backgroundJobService,
          projectRoot: options.projectRoot,
          currentRuntimeId: options.currentRuntimeId,
          isVisible: job => isJobVisible(job, toolContext),
        });

        const allJobs = options.backgroundJobService
          .listScoped({ projectRoot: options.projectRoot }, { includeArchived: includeArchived === true })
          .filter(job => isJobVisible(job, toolContext))
          .filter(job => matchesOptionalScope(job, { feature, task, adHocRunId, workflow }));
        const archivedJobs = allJobs.filter(job => isBackgroundJobArchived(job));
        const activeJobs = allJobs.filter(job => !isBackgroundJobArchived(job));
        const staleActiveJobs = activeJobs.filter(isNonTerminalStaleJob);
        const nextActions = buildNextActions(activeJobs);
        const waitingForNativeCompletion = buildNativeCompletionWaits(activeJobs);
        const orchestrationBurden = buildOrchestrationBurden(activeJobs);
        const recommendedNextAction = buildRecommendedNextAction(activeJobs);
        const schedulerGuidance = staleActiveJobs.length === 0
          && recommendedNextAction.reasonCode === 'native_completion_wait_only'
          ? {
              reason: 'wait_for_native_completion_notification',
              message: 'Do not call hive_background_status repeatedly while every visible lane is wait-only. Wait for OpenCode native completion notification, continue unrelated foreground work, or cancel only if the lane is stale, wrong, or no longer needed.',
            }
          : undefined;

        return {
          success: true,
          scope: currentScope(options.projectRoot, toolContext),
          observation: observation?.healthy === false ? observation : undefined,
          jobs: allJobs.map(formatJob),
          archivedCount: archivedJobs.length > 0 ? archivedJobs.length : undefined,
          waitingForNativeCompletion: waitingForNativeCompletion.length > 0 ? waitingForNativeCompletion : undefined,
          nextActions: nextActions.length > 0 ? nextActions : undefined,
          recommendedNextAction,
          requiresHiveStatusRefresh: recommendedNextAction.requiresHiveStatusRefresh === true,
          schedulerGuidance,
          orchestrationBurden,
        };
      },
    }),

    hive_background_reconcile: boardOperation({
      description: 'Archive terminal or stale background jobs. Archiving bookkeeping does not stop execution or authorize a replacement writer.',
      args: reconcileItem,
      execute: ({ identifier, decision, summary }, toolContext: BoardInvocation) => {
        if (!options.isEnabled()) {
          return disabledResponse();
        }

        return reconcileVisibleJob(options.backgroundJobService, options.projectRoot, toolContext, { identifier, decision, summary });
      },
    }),

    hive_background_reconcile_batch: boardOperation({
      description: 'Mark multiple terminal or stale background jobs reconciled or ignored without changing runtime results.',
      args: {
        items: z.array(z.object(reconcileItem)).describe('Terminal or stale background jobs to reconcile or ignore.'),
      },
      execute: ({ items }, toolContext: BoardInvocation) => {
        if (!options.isEnabled()) {
          return disabledResponse();
        }
        if (!Array.isArray(items) || items.length === 0) {
          return failure('items_required', 'At least one background job item is required.');
        }

        const results = items.map((item: { identifier: string; decision: ReconcileDecision; summary: string }) =>
          reconcileVisibleJob(options.backgroundJobService, options.projectRoot, toolContext, item));

        return {
          success: results.every(result => result.success === true),
          results,
          requiresHiveStatusRefresh: results.some(result => result.success && result.requiresHiveStatusRefresh),
        };
      },
    }),

    hive_background_cancel: boardOperation({
      description: 'Request cancellation for a visible background job and record runtime cancellation only after confirmation.',
      args: {
        identifier: z.string().describe('Task ID, session ID, or scoped alias to cancel.'),
        reason: z.string().describe('Required reason for requesting cancellation.'),
      },
      execute: async ({ identifier, reason }, toolContext: BoardInvocation) => {
        if (!options.isEnabled()) {
          return disabledResponse();
        }

        const trimmedReason = reason.trim();
        if (!trimmedReason) {
          return failure('cancel_reason_required', 'A non-empty cancellation reason is required.');
        }

        const resolved = resolveVisibleJob(options.backgroundJobService, identifier, options.projectRoot, toolContext);
        if (!resolved.success) {
          return resolved;
        }
        const liveSessionJobs = options.backgroundJobService
          .listScoped({ projectRoot: options.projectRoot })
          .filter(job => job.sessionId === resolved.job.sessionId)
          .filter(job => !isTerminalRuntimeState(job.runtimeState));
        const affectedJobs = liveSessionJobs
          .filter(job => job.scope?.parentSessionId === resolved.job.scope?.parentSessionId);
        if (affectedJobs.length === 0) {
          return failure('job_terminal', `Background job ${resolved.job.alias} is terminal and has no live sibling row in this parent scope to cancel.`);
        }
        const siblingParentJobs = liveSessionJobs
          .filter(job => job.scope?.parentSessionId !== resolved.job.scope?.parentSessionId);
        for (const job of affectedJobs) {
          options.backgroundJobService.markCancelRequested(job.alias, trimmedReason);
        }
        const runtimeResult = await cancelRuntimeTask(resolved.job.sessionId, toolContext);
        const uncertainSiblingJobs = runtimeResult.cancelled ? siblingParentJobs : [];
        if (runtimeResult.cancelled) {
          for (const job of affectedJobs) {
            options.backgroundJobService.markRuntimeCancelled(job.alias, {
              resultSummary: runtimeResult.message,
              statusUncertain: false,
              lastStatusError: undefined,
            });
          }
          for (const job of siblingParentJobs) {
            options.backgroundJobService.updateRuntimeState(job.alias, 'unknown', {
              statusUncertain: true,
              lastStatusError: `A confirmed abort targeted shared native session '${resolved.job.sessionId}' from parent '${resolved.job.scope?.parentSessionId}'. This sibling-parent observation was not marked cancelled; inspect hive_task_trace({ task_id: ${JSON.stringify(resolved.job.sessionId)} }).`,
            });
          }
        }
        const acknowledgedOnly = !runtimeResult.cancelled && runtimeResult.acknowledged === true;
        const updated = options.backgroundJobService.resolve(resolved.job.alias);

        return {
          success: true,
          runtimeCancelled: runtimeResult.cancelled,
          interruptAcknowledged: runtimeResult.acknowledged,
          runtimeMessage: runtimeResult.message,
          affectedAliases: affectedJobs.map(job => job.alias),
          uncertainSiblingAliases: uncertainSiblingJobs.length > 0 ? uncertainSiblingJobs.map(job => job.alias) : undefined,
          scopeMessage: acknowledgedOnly
            ? `The host accepted an interruption of native session ${resolved.job.sessionId}; that acknowledgement does not prove the worker stopped. The listed aliases keep their cancel request until the board observes the execution settle and the native completion notification. Do not launch an overlapping writer before then.`
            : affectedJobs.length > 1 || uncertainSiblingJobs.length > 0
              ? runtimeResult.cancelled
                ? `The native abort targets session ${resolved.job.sessionId}. Confirmed cancellation applies to the listed aliases in this parent scope; live sibling-parent observations are marked uncertain, not cancelled.`
                : `The listed aliases share native session ${resolved.job.sessionId}; runtime cancellation was not confirmed.`
              : undefined,
          job: updated ? formatJob(updated) : undefined,
        };
      },
    }),
  };
}

function disabledResponse(): Record<string, unknown> {
  return {
    success: false,
    reason: 'background_tools_disabled',
    error: 'Background management tools are disabled because the OpenCode background subagent experiment is not enabled.',
  };
}

function resolveVisibleJob(
  backgroundJobService: BackgroundJobService,
  identifier: string,
  projectRoot: string,
  toolContext: BoardInvocation,
): { success: true; job: BackgroundJobRecord } | { success: false; reason: string; error: string } {
  const trimmedIdentifier = identifier.trim();
  if (!trimmedIdentifier) {
    return failure('identifier_required', 'A task ID, session ID, or alias is required.');
  }

  let job: BackgroundJobRecord | undefined;
  try {
    job = backgroundJobService.resolve(trimmedIdentifier);
  } catch (error) {
    return failure('job_identifier_ambiguous', error instanceof Error ? error.message : String(error));
  }
  if (!job) {
    return failure('job_not_found', `Background job not found: ${trimmedIdentifier}`);
  }

  if (job.scope?.projectRoot !== projectRoot || !isJobVisible(job, toolContext)) {
    return failure('job_not_in_scope', `Background job ${trimmedIdentifier} is not visible to its originating parent session.`);
  }

  if (isBackgroundJobArchived(job)) {
    return failure('job_archived', `Background job ${trimmedIdentifier} is archived and cannot be acted on through management tools.`);
  }

  return { success: true, job };
}

function reconcileVisibleJob(
  backgroundJobService: BackgroundJobService,
  projectRoot: string,
  toolContext: BoardInvocation,
  item: { identifier: string; decision: ReconcileDecision; summary: string },
): ReconcileResult {
  const acknowledgement = { identifier: item.identifier, decision: item.decision };
  try {
    const trimmedSummary = item.summary.trim();
    if (!trimmedSummary) {
      return { ...acknowledgement, ...failure('summary_required', 'A non-empty summary is required to reconcile or ignore a background job.'), hint: 'Supply a non-empty summary of what was done with the result or why it is ignored.' };
    }
    const resolved = resolveVisibleJob(backgroundJobService, item.identifier, projectRoot, toolContext);
    if (resolved.success === false) {
      const hints: Record<string, string> = {
        identifier_required: 'Supply a task ID, session ID, or canonical scoped alias from hive_background_status.',
        job_identifier_ambiguous: 'Use the exact canonical scoped alias from the error or hive_background_status.',
        job_not_found: 'Inspect hive_background_status for the correct identifier before retrying.',
        job_not_in_scope: 'Use the originating parent session to inspect and reconcile this observation.',
        job_archived: 'Inspect hive_background_status({ includeArchived: true }); this observation is already archived.',
      };
      return { ...acknowledgement, ...resolved, hint: hints[resolved.reason] ?? 'Inspect hive_background_status and the reported error before retrying with the correct identifier.' };
    }

    if (!isTerminalRuntimeState(resolved.job.runtimeState)) {
      if (resolved.job.staleAt || resolved.job.statusUncertain) {
        const stale = !!resolved.job.staleAt;
        if (item.decision !== 'ignored') {
          const reason = stale ? 'stale_job_requires_ignore' : 'uncertain_job_requires_ignore';
          return {
            ...acknowledgement,
            ...failure(reason, `${stale ? 'Stale' : 'Uncertain'} background job ${resolved.job.alias} is ${resolved.job.runtimeState}, not terminal. Inspect it or archive the observation with decision "ignored".`),
            hint: (stale ? staleRecoveryPendingAction(resolved.job) : uncertainRecoveryPendingAction(resolved.job)).command,
          };
        }

        backgroundJobService.markIgnored(resolved.job.alias, trimmedSummary);
        return { ...acknowledgement, success: true, archived: true, state: 'ignored_archived', requiresHiveStatusRefresh: hasHiveFeatureOrTaskScope(resolved.job) };
      }
      return {
        ...acknowledgement,
        ...failure('job_not_terminal', `Background job ${resolved.job.taskId} is ${resolved.job.runtimeState}, not terminal.`),
        hint: nativeCompletionPendingWait(resolved.job).message,
      };
    }

    if (item.decision === 'reconciled') {
      backgroundJobService.markReconciled(resolved.job.alias, {
        reconciledBy: toolContext.sessionID,
        reconciliationSummary: trimmedSummary,
      });
    } else {
      backgroundJobService.markIgnored(resolved.job.alias, trimmedSummary);
    }

    return {
      ...acknowledgement,
      success: true,
      archived: true,
      state: item.decision === 'reconciled' ? 'archived_after_reconcile' : 'ignored_archived',
      requiresHiveStatusRefresh: hasHiveFeatureOrTaskScope(resolved.job),
    };
  } catch (error) {
    return { ...acknowledgement, ...failure('reconciliation_failed', error instanceof Error ? error.message : String(error)), hint: 'Inspect hive_background_status({ includeArchived: true }) before retrying; a failed persistence write may have published.' };
  }
}

function isJobVisible(job: BackgroundJobRecord, toolContext: BoardInvocation): boolean {
  return !!toolContext.sessionID && job.scope?.parentSessionId === toolContext.sessionID;
}

function matchesOptionalScope(
  job: BackgroundJobRecord,
  filter: { feature?: string; task?: string; adHocRunId?: string; workflow?: string },
): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return true;
    }
    return job.scope?.[key as keyof typeof filter] === trimmed;
  });
}

function buildNextActions(jobs: BackgroundJobRecord[]): Array<Record<string, string | undefined>> {
  return jobs
    .filter(job => isTerminalRuntimeState(job.runtimeState) && job.terminalUnreconciled === true)
    .map(reconcileRequiredAction);
}

function buildNativeCompletionWaits(jobs: BackgroundJobRecord[]): Array<Record<string, string>> {
  return jobs
    .filter(job => (job.runtimeState === 'running' || job.runtimeState === 'unknown') && !job.staleAt && !job.statusUncertain)
    .map(nativeCompletionPendingWait);
}

function buildOrchestrationBurden(jobs: BackgroundJobRecord[]): Record<string, number> {
  const completionNotificationsPending = jobs.filter(job => (job.runtimeState === 'running' || job.runtimeState === 'unknown') && !job.staleAt && !job.statusUncertain).length;
  const reconcileItemsRequired = jobs.filter(job => isTerminalRuntimeState(job.runtimeState) && job.terminalUnreconciled === true).length;

  return {
    visibleLanes: jobs.length,
    actionableLanes: reconcileItemsRequired,
    completionNotificationsPending,
    reconcileItemsRequired,
    recommendedReconcileToolCalls: reconcileItemsRequired > 0 ? 1 : 0,
  };
}

function buildRecommendedNextAction(
  jobs: BackgroundJobRecord[],
): RecommendedNextAction {
  const staleJobs = jobs.filter(isNonTerminalStaleJob);
  if (staleJobs.length > 0) {
    return buildStaleRecoveryAction(staleJobs);
  }

  const terminalJobs = jobs.filter(job => isTerminalRuntimeState(job.runtimeState) && job.terminalUnreconciled === true);

  if (terminalJobs.length > 1) {
    return {
      action: 'reconcile_terminal_jobs',
      reasonCode: 'terminal_unreconciled_jobs_visible',
      taskIds: terminalJobs.map(job => job.taskId),
      message: 'Multiple visible background jobs are terminal and unreconciled. Reconcile or ignore each board item, then inspect Hive status for scoped feature/task work.',
      requiresHiveStatusRefresh: terminalJobs.some(hasHiveFeatureOrTaskScope),
    };
  }

  if (terminalJobs.length === 1) {
    const job = terminalJobs[0];
    return {
      action: 'reconcile_terminal_job',
      reasonCode: 'terminal_unreconciled_job_visible',
      taskId: job.taskId,
      message: 'A visible background job is terminal and unreconciled. Reconcile or ignore the board item, then inspect Hive status if it belongs to scoped feature/task work.',
      requiresHiveStatusRefresh: hasHiveFeatureOrTaskScope(job),
    };
  }

  const uncertainJobs = jobs.filter(job => !isTerminalRuntimeState(job.runtimeState) && !job.staleAt && job.statusUncertain);
  if (uncertainJobs.length > 0) {
    return {
      action: 'inspect_uncertain_background_jobs',
      reasonCode: 'uncertain_background_jobs_visible',
      aliases: uncertainJobs.map(job => job.alias),
      message: 'One or more live background observations are uncertain. Inspect their native sessions with hive_task_trace; wait for an authoritative terminal notification or ignore/archive only the observation.',
      requiresHiveStatusRefresh: false,
    };
  }

  const waitingJobs = jobs.filter(job => (job.runtimeState === 'running' || job.runtimeState === 'unknown') && !job.staleAt && !job.statusUncertain);
  if (waitingJobs.length > 0 && waitingJobs.length === jobs.length) {
    const taskIds = waitingJobs.map(job => job.taskId);
    return pruneUndefined({
      action: 'wait_for_native_completion',
      reasonCode: 'native_completion_wait_only',
      taskId: taskIds.length === 1 ? taskIds[0] : undefined,
      taskIds: taskIds.length > 1 ? taskIds : undefined,
      message: 'Every visible background lane is still waiting on the native OpenCode completion notification. Do not refresh the board repeatedly.',
      requiresHiveStatusRefresh: false,
    });
  }

  return idleRecommendedNextAction();
}

function buildStaleRecoveryAction(staleJobs: BackgroundJobRecord[]): RecommendedNextAction {
  const taskIds = staleJobs.map(job => job.taskId);
  return {
    action: 'recover_stale_background_jobs',
    reasonCode: 'stale_background_jobs_visible',
    taskIds,
    message: 'One or more background jobs from a previous runtime epoch are stale. Inspect associated worktrees and Hive status before retrying, then ignore/archive stale board lanes with hive_background_reconcile({ decision: "ignored" }). These lanes are not counted as native completion pending.',
    requiresHiveStatusRefresh: true,
  };
}

function idleRecommendedNextAction(): RecommendedNextAction {
  return {
    action: 'idle',
    reasonCode: 'no_background_action_needed',
    message: 'No background board action is needed from the visible local board state.',
    requiresHiveStatusRefresh: false,
  };
}

function hasHiveFeatureOrTaskScope(job: BackgroundJobRecord): boolean {
  return !!job.scope?.feature || !!job.scope?.task;
}

function nativeCompletionPendingWait(job: BackgroundJobRecord): Record<string, string> {
  return {
    reason: 'native_completion_pending',
    taskId: job.taskId,
    message: 'Wait until OpenCode injects the native background completion notification for this task. Do not refresh the board repeatedly, reconcile, cancel, or duplicate this lane while it is still running.',
  };
}

function staleRecoveryPendingAction(job: BackgroundJobRecord): Record<string, string> {
  return {
    reason: 'stale_recovery_pending',
    taskId: job.taskId,
    alias: job.alias,
    command: `hive_background_reconcile({ identifier: ${JSON.stringify(job.alias)}, decision: "ignored", summary: "<why the stale lane was archived>" })`,
    message: 'This stale background job is not running normally. Inspect its associated worktree and Hive status before retrying, or archive it with decision "ignored".',
  };
}

function uncertainRecoveryPendingAction(job: BackgroundJobRecord): Record<string, string> {
  return {
    reason: 'uncertain_observation_pending',
    taskId: job.taskId,
    alias: job.alias,
    diagnostic: `hive_task_trace({ task_id: ${JSON.stringify(job.sessionId)} })`,
    command: `hive_background_reconcile({ identifier: ${JSON.stringify(job.alias)}, decision: "ignored", summary: "<why the uncertain observation was archived>" })`,
    message: 'This live background observation is uncertain. Inspect its native session, wait for authoritative terminal evidence, or archive only the observation with decision "ignored".',
  };
}

function reconcileRequiredAction(job: BackgroundJobRecord): Record<string, string> {
  return {
    reason: 'reconcile_required',
    taskId: job.taskId,
    alias: job.alias,
    precondition: 'Consume or intentionally ignore the terminal result before running this command.',
    command: `hive_background_reconcile({ identifier: ${JSON.stringify(job.alias)}, decision: "reconciled", summary: "<what was done with the result>" })`,
    message: 'This background job is terminal but unreconciled. Consume or intentionally ignore the result, then reconcile or ignore it explicitly.',
  };
}

function isTerminalRuntimeState(state: BackgroundJobRecord['runtimeState']): boolean {
  return state === 'completed' || state === 'error' || state === 'cancelled';
}

function isNonTerminalStaleJob(job: BackgroundJobRecord): boolean {
  return !!job.staleAt && !isTerminalRuntimeState(job.runtimeState);
}

function currentScope(projectRoot: string, toolContext: BoardInvocation): Record<string, string | undefined> {
  return {
    projectRoot,
    parentSessionId: toolContext.sessionID,
    primaryAgent: toolContext.agent,
  };
}

function formatJob(job: BackgroundJobRecord): Record<string, unknown> {
  const terminal = isTerminalRuntimeState(job.runtimeState);
  const archived = isBackgroundJobArchived(job);
  const actionRequired = !archived && terminal && job.terminalUnreconciled === true;
  const visibility = archived
    ? (job.archiveReason === 'ignored' ? 'ignored_archived' : 'archived_after_reconcile')
    : (actionRequired ? 'terminal_unreconciled' : 'active');

  return {
    taskId: job.taskId,
    sessionId: job.sessionId,
    callId: job.callId,
    alias: job.alias,
    agentName: job.agentName,
    description: job.description,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    runtime: pruneUndefined({
      state: job.runtimeState,
      statusUncertain: job.statusUncertain,
      resultSummary: job.resultSummary,
      lastStatusError: job.lastStatusError,
      completedAt: job.runtimeCompletedAt,
    }),
    coordination: pruneUndefined({
      terminalUnreconciled: job.terminalUnreconciled,
      promptNotifiedAt: job.promptNotifiedAt,
      promptNotifiedInSessionId: job.promptNotifiedInSessionId,
      promptAcknowledgedAt: job.promptAcknowledgedAt,
      promptBoardInjectionCount: job.promptBoardInjectionCount,
      cancelRequestedAt: job.cancelRequestedAt,
      cancelReason: job.cancelReason,
      reconciledAt: job.reconciledAt,
      reconciledBy: job.reconciledBy,
      reconciliationSummary: job.reconciliationSummary,
      ignoredAt: job.ignoredAt,
      ignoreReason: job.ignoreReason,
      archivedAt: job.archivedAt,
      archiveReason: job.archiveReason,
      staleAt: job.staleAt,
      visibility,
      actionRequired,
    }),
    scope: job.scope,
  };
}

function failure(reason: string, error: string): { success: false; reason: string; error: string } {
  return { success: false, reason, error };
}

function pruneUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}
