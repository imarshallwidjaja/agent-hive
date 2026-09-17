import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import type { BackgroundJobRecord, BackgroundJobService } from 'hive-core';
import { isBackgroundJobArchived } from 'hive-core';
import { classifyRuntimeEpochStaleJobs } from './backgroundJobAdapter.js';

type ToolContext = {
  sessionID?: string;
  agent?: string;
};

export interface RuntimeCancelResult {
  cancelled: boolean;
  message?: string;
}

export interface CreateBackgroundToolsOptions {
  backgroundJobService: BackgroundJobService;
  projectRoot: string;
  isEnabled: () => boolean;
  currentRuntimeId?: string;
  cancelRuntimeTask?: (sessionId: string, context: ToolContext) => Promise<RuntimeCancelResult> | RuntimeCancelResult;
}

type ReconcileDecision = 'reconciled' | 'ignored';
type RecommendedNextAction = Record<string, string | string[] | boolean | undefined>;

interface VisibleBackgroundBoard {
  activeJobs: BackgroundJobRecord[];
}

export function createBackgroundTools(options: CreateBackgroundToolsOptions): Record<string, ToolDefinition> {
  const cancelRuntimeTask = options.cancelRuntimeTask ?? (async () => ({
    cancelled: false,
    message: 'Runtime cancellation is not available through this plugin context.',
  }));

  return {
    hive_background_status: tool({
      description: 'List background jobs visible to the current primary session scope.',
      args: {
        feature: tool.schema.string().optional().describe('Optional feature scope filter.'),
        task: tool.schema.string().optional().describe('Optional task scope filter.'),
        adHocRunId: tool.schema.string().optional().describe('Optional ad-hoc run scope filter.'),
        workflow: tool.schema.string().optional().describe('Optional workflow scope filter.'),
        includeArchived: tool.schema.boolean().optional().describe('Include reconciled or ignored background jobs archived by Hive background tools.'),
      },
      async execute({ feature, task, adHocRunId, workflow, includeArchived }, toolContext) {
        if (!options.isEnabled()) {
          return json(disabledResponse());
        }

        classifyRuntimeEpochStaleJobs({
          service: options.backgroundJobService,
          projectRoot: options.projectRoot,
          currentRuntimeId: options.currentRuntimeId,
          isVisible: job => isJobVisible(job, toolContext as ToolContext),
        });

        const allJobs = options.backgroundJobService
          .listScoped({ projectRoot: options.projectRoot }, { includeArchived: includeArchived === true })
          .filter(job => isJobVisible(job, toolContext as ToolContext))
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

        return json({
          success: true,
          scope: currentScope(options.projectRoot, toolContext as ToolContext),
          jobs: allJobs.map(formatJob),
          archivedCount: archivedJobs.length > 0 ? archivedJobs.length : undefined,
          waitingForNativeCompletion: waitingForNativeCompletion.length > 0 ? waitingForNativeCompletion : undefined,
          nextActions: nextActions.length > 0 ? nextActions : undefined,
          recommendedNextAction,
          requiresHiveStatusRefresh: recommendedNextAction.requiresHiveStatusRefresh === true,
          schedulerGuidance,
          orchestrationBurden,
        });
      },
    }),

    hive_background_reconcile: tool({
      description: 'Archive terminal or stale background jobs. Archiving bookkeeping does not stop execution or authorize a replacement writer.',
      args: {
        identifier: tool.schema.string().describe('Task ID, session ID, or scoped alias to reconcile.'),
        decision: tool.schema.enum(['reconciled', 'ignored']).describe('Whether the terminal job was reconciled into task state or intentionally ignored. Stale non-terminal jobs may only be ignored.'),
        summary: tool.schema.string().describe('Required reconciliation summary or ignore reason.'),
      },
      async execute({ identifier, decision, summary }, toolContext) {
        if (!options.isEnabled()) {
          return json(disabledResponse());
        }

        const result = reconcileVisibleJob(options.backgroundJobService, options.projectRoot, toolContext as ToolContext, { identifier, decision: decision as ReconcileDecision, summary });
        if (!result.success) {
          return json(result);
        }

        const { activeJobs } = buildVisibleBackgroundBoard(options.backgroundJobService, options.projectRoot, toolContext as ToolContext);
        const resultJob = (result as { job?: { alias?: string } }).job;
        const reconciledJob = resultJob?.alias ? options.backgroundJobService.resolve(resultJob.alias) : undefined;
        const reconciledJobs = reconciledJob ? [reconciledJob] : [];

        return json({
          ...result,
          recommendedNextAction: buildRecommendedNextAction(activeJobs, reconciledJobs),
        });
      },
    }),

    hive_background_reconcile_batch: tool({
      description: 'Mark multiple terminal or stale background jobs reconciled or ignored without changing runtime results.',
      args: {
        items: tool.schema.array(tool.schema.object({
          identifier: tool.schema.string().describe('Task ID, session ID, or scoped alias to reconcile.'),
          decision: tool.schema.enum(['reconciled', 'ignored']).describe('Whether the terminal job was reconciled into task state or intentionally ignored. Stale non-terminal jobs may only be ignored.'),
          summary: tool.schema.string().describe('Required reconciliation summary or ignore reason.'),
        })).describe('Terminal or stale background jobs to reconcile or ignore.'),
      },
      async execute({ items }, toolContext) {
        if (!options.isEnabled()) {
          return json(disabledResponse());
        }
        if (!Array.isArray(items) || items.length === 0) {
          return json(failure('items_required', 'At least one background job item is required.'));
        }

        const results = items.map((item: { identifier: string; decision: ReconcileDecision; summary: string }) =>
          reconcileVisibleJob(options.backgroundJobService, options.projectRoot, toolContext as ToolContext, item));

        const reconciledJobs = results
          .filter(r => r.success === true)
          .map(r => {
            const resultJob = (r as Record<string, unknown>).job as Record<string, unknown> | undefined;
            const alias = resultJob && typeof resultJob.alias === 'string' ? resultJob.alias : null;
            if (alias) {
              return options.backgroundJobService.resolve(alias);
            }
            const rawId = (r as Record<string, unknown>).identifier;
            const trimmed = typeof rawId === 'string' ? rawId.trim() : '';
            return trimmed ? options.backgroundJobService.resolve(trimmed) : undefined;
          })
          .filter((j): j is BackgroundJobRecord => j !== undefined);

        const { activeJobs } = buildVisibleBackgroundBoard(options.backgroundJobService, options.projectRoot, toolContext as ToolContext);

        return json({
          success: results.every(result => result.success === true),
          results,
          recommendedNextAction: buildRecommendedNextAction(activeJobs, reconciledJobs),
        });
      },
    }),

    hive_background_cancel: tool({
      description: 'Request cancellation for a visible background job and record runtime cancellation only after confirmation.',
      args: {
        identifier: tool.schema.string().describe('Task ID, session ID, or scoped alias to cancel.'),
        reason: tool.schema.string().describe('Required reason for requesting cancellation.'),
      },
      async execute({ identifier, reason }, toolContext) {
        if (!options.isEnabled()) {
          return json(disabledResponse());
        }

        const trimmedReason = reason.trim();
        if (!trimmedReason) {
          return json(failure('cancel_reason_required', 'A non-empty cancellation reason is required.'));
        }

        const resolved = resolveVisibleJob(options.backgroundJobService, identifier, options.projectRoot, toolContext as ToolContext);
        if (!resolved.success) {
          return json(resolved);
        }
        const liveSessionJobs = options.backgroundJobService
          .listScoped({ projectRoot: options.projectRoot })
          .filter(job => job.sessionId === resolved.job.sessionId)
          .filter(job => !isTerminalRuntimeState(job.runtimeState));
        const affectedJobs = liveSessionJobs
          .filter(job => job.scope?.parentSessionId === resolved.job.scope?.parentSessionId);
        if (affectedJobs.length === 0) {
          return json(failure('job_terminal', `Background job ${resolved.job.alias} is terminal and has no live sibling row in this parent scope to cancel.`));
        }
        const siblingParentJobs = liveSessionJobs
          .filter(job => job.scope?.parentSessionId !== resolved.job.scope?.parentSessionId);
        for (const job of affectedJobs) {
          options.backgroundJobService.markCancelRequested(job.alias, trimmedReason);
        }
        const runtimeResult = await cancelRuntimeTask(resolved.job.sessionId, toolContext as ToolContext);
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
        const updated = options.backgroundJobService.resolve(resolved.job.alias);

        return json({
          success: true,
          runtimeCancelled: runtimeResult.cancelled,
          runtimeMessage: runtimeResult.message,
          affectedAliases: affectedJobs.map(job => job.alias),
          uncertainSiblingAliases: uncertainSiblingJobs.length > 0 ? uncertainSiblingJobs.map(job => job.alias) : undefined,
          scopeMessage: affectedJobs.length > 1 || uncertainSiblingJobs.length > 0
            ? runtimeResult.cancelled
              ? `The native abort targets session ${resolved.job.sessionId}. Confirmed cancellation applies to the listed aliases in this parent scope; live sibling-parent observations are marked uncertain, not cancelled.`
              : `The listed aliases share native session ${resolved.job.sessionId}; runtime cancellation was not confirmed.`
            : undefined,
          job: updated ? formatJob(updated) : undefined,
        });
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
  toolContext: ToolContext,
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
  toolContext: ToolContext,
  item: { identifier: string; decision: ReconcileDecision; summary: string },
): Record<string, unknown> {
  const trimmedSummary = item.summary.trim();
  if (!trimmedSummary) {
    return { identifier: item.identifier, ...failure('summary_required', 'A non-empty summary is required to reconcile or ignore a background job.') };
  }
  const resolved = resolveVisibleJob(backgroundJobService, item.identifier, projectRoot, toolContext);
  if (!resolved.success) {
    return { identifier: item.identifier, ...resolved };
  }

  if (!isTerminalRuntimeState(resolved.job.runtimeState)) {
    if (resolved.job.staleAt || resolved.job.statusUncertain) {
      const stale = !!resolved.job.staleAt;
      if (item.decision !== 'ignored') {
        const reason = stale ? 'stale_job_requires_ignore' : 'uncertain_job_requires_ignore';
        return {
          identifier: item.identifier,
          ...failure(reason, `${stale ? 'Stale' : 'Uncertain'} background job ${resolved.job.alias} is ${resolved.job.runtimeState}, not terminal. Inspect it or archive the observation with decision "ignored".`),
          nextAction: stale ? staleRecoveryPendingAction(resolved.job) : uncertainRecoveryPendingAction(resolved.job),
        };
      }

      const ignored = backgroundJobService.markIgnored(resolved.job.alias, trimmedSummary);
      return {
        identifier: item.identifier,
        success: true,
        decision: item.decision,
        archive: {
          archived: true,
          message: `The ${stale ? 'stale' : 'uncertain'} background observation is archived and hidden from normal status output. Archiving does not claim the worker stopped.`,
        },
        job: formatJob(ignored),
      };
    }

    return {
      identifier: item.identifier,
      ...failure('job_not_terminal', `Background job ${resolved.job.taskId} is ${resolved.job.runtimeState}, not terminal.`),
      nextAction: nativeCompletionPendingWait(resolved.job),
    };
  }

  const reconciled = item.decision === 'reconciled'
    ? backgroundJobService.markReconciled(resolved.job.alias, {
        reconciledBy: toolContext.sessionID,
        reconciliationSummary: trimmedSummary,
      })
    : backgroundJobService.markIgnored(resolved.job.alias, trimmedSummary);

  return {
    identifier: item.identifier,
    success: true,
    decision: item.decision,
    archive: {
      archived: true,
      message: 'The background job is archived and hidden from normal status output. Do not edit .hive/background-jobs.json directly.',
    },
    job: formatJob(reconciled),
  };
}

function isJobVisible(job: BackgroundJobRecord, toolContext: ToolContext): boolean {
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
  reconciledJobs: BackgroundJobRecord[] = [],
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
      requiresHiveStatusRefresh: terminalJobs.some(hasHiveFeatureOrTaskScope) || reconciledJobs.some(hasHiveFeatureOrTaskScope),
    };
  }

  if (terminalJobs.length === 1) {
    const job = terminalJobs[0];
    return {
      action: 'reconcile_terminal_job',
      reasonCode: 'terminal_unreconciled_job_visible',
      taskId: job.taskId,
      message: 'A visible background job is terminal and unreconciled. Reconcile or ignore the board item, then inspect Hive status if it belongs to scoped feature/task work.',
      requiresHiveStatusRefresh: hasHiveFeatureOrTaskScope(job) || reconciledJobs.some(hasHiveFeatureOrTaskScope),
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
      requiresHiveStatusRefresh: reconciledJobs.some(hasHiveFeatureOrTaskScope),
    });
  }

  const hiveScopedReconciled = reconciledJobs.filter(hasHiveFeatureOrTaskScope);
  if (hiveScopedReconciled.length > 0) {
    const taskIds = hiveScopedReconciled.map(job => job.taskId);
    return pruneUndefined({
      action: 'inspect_hive_status',
      reasonCode: 'reconciled_job_has_hive_scope',
      taskId: taskIds.length === 1 ? taskIds[0] : undefined,
      taskIds: taskIds.length > 1 ? taskIds : undefined,
      message: 'One or more background board items were archived for Hive feature/task work. Inspect Hive status to decide the next orchestration step.',
      requiresHiveStatusRefresh: true,
    });
  }

  return idleRecommendedNextAction();
}

function buildVisibleBackgroundBoard(
  backgroundJobService: BackgroundJobService,
  projectRoot: string,
  toolContext: ToolContext,
): VisibleBackgroundBoard {
  const allJobs = backgroundJobService
    .listScoped({ projectRoot })
    .filter(job => isJobVisible(job, toolContext));
  const activeJobs = allJobs.filter(job => !isBackgroundJobArchived(job));
  return { activeJobs };
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

function currentScope(projectRoot: string, toolContext: ToolContext): Record<string, string | undefined> {
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

function json(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}
