import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import type { BackgroundJobRecord, BackgroundJobService, BackgroundPendingLaunch } from 'hive-core';

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
  cancelRuntimeTask?: (taskId: string, context: ToolContext) => Promise<RuntimeCancelResult> | RuntimeCancelResult;
}

type ReconcileDecision = 'reconciled' | 'ignored';
type RecommendedNextAction = Record<string, string | string[] | boolean | undefined>;

export function createBackgroundTools(options: CreateBackgroundToolsOptions): Record<string, ToolDefinition> {
  const cancelRuntimeTask = options.cancelRuntimeTask ?? (async () => ({
    cancelled: false,
    message: 'Runtime cancellation is not available through this plugin context.',
  }));

  return {
    hive_background_status: tool({
      description: 'List background jobs visible to the current primary session scope.',
      args: {
        includeStale: tool.schema.boolean().optional().describe('Include stale scoped recovery entries.'),
        feature: tool.schema.string().optional().describe('Optional feature scope filter.'),
        task: tool.schema.string().optional().describe('Optional task scope filter.'),
        adHocRunId: tool.schema.string().optional().describe('Optional ad-hoc run scope filter.'),
        workflow: tool.schema.string().optional().describe('Optional workflow scope filter.'),
        includeArchived: tool.schema.boolean().optional().describe('Include reconciled or ignored background jobs archived by Hive background tools.'),
      },
      async execute({ includeStale, feature, task, adHocRunId, workflow, includeArchived }, toolContext) {
        if (!options.isEnabled()) {
          return json(disabledResponse());
        }

        const jobs = options.backgroundJobService
          .listScoped({ projectRoot: options.projectRoot }, { includeArchived: includeArchived === true })
          .filter(job => isJobVisible(job, toolContext as ToolContext))
          .filter(job => includeStale === true || !job.staleAt)
          .filter(job => matchesOptionalScope(job, { feature, task, adHocRunId, workflow }));
        const pendingLaunches = options.backgroundJobService
          .listPendingLaunches({ projectRoot: options.projectRoot })
          .filter(pending => isPendingLaunchVisible(pending, toolContext as ToolContext))
          .filter(pending => matchesOptionalScope(pending, { feature, task, adHocRunId, workflow }));
        const nextActions = buildNextActions(jobs, pendingLaunches);
        const waitingForNativeCompletion = buildNativeCompletionWaits(jobs);
        const orchestrationBurden = buildOrchestrationBurden(jobs, pendingLaunches);
        const recommendedNextAction = buildRecommendedNextAction(jobs, pendingLaunches);
        const schedulerGuidance = orchestrationBurden.completionNotificationsPending > 0
          && orchestrationBurden.reconcileItemsRequired === 0
          && orchestrationBurden.pendingLaunches === 0
          ? {
              reason: 'wait_for_native_completion_notification',
              message: 'Do not call hive_background_status repeatedly while every visible lane is wait-only. Wait for OpenCode native completion notification, continue unrelated foreground work, or cancel only if the lane is stale, wrong, or no longer needed.',
            }
          : undefined;

        return json({
          success: true,
          scope: currentScope(options.projectRoot, toolContext as ToolContext),
          jobs: jobs.map(formatJob),
          pendingLaunches: pendingLaunches.length > 0 ? pendingLaunches.map(formatPendingLaunch) : undefined,
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
      description: 'Mark a terminal background job reconciled or ignored without changing its runtime result.',
      args: {
        identifier: tool.schema.string().describe('Task ID, session ID, or scoped alias to reconcile.'),
        decision: tool.schema.enum(['reconciled', 'ignored']).describe('Whether the terminal job was reconciled into task state or intentionally ignored.'),
        summary: tool.schema.string().describe('Required reconciliation summary or ignore reason.'),
      },
      async execute({ identifier, decision, summary }, toolContext) {
        if (!options.isEnabled()) {
          return json(disabledResponse());
        }

        const result = reconcileVisibleJob(options.backgroundJobService, options.projectRoot, toolContext as ToolContext, { identifier, decision: decision as ReconcileDecision, summary });
        return json(result);
      },
    }),

    hive_background_reconcile_batch: tool({
      description: 'Mark multiple terminal background jobs reconciled or ignored without changing runtime results.',
      args: {
        items: tool.schema.array(tool.schema.object({
          identifier: tool.schema.string().describe('Task ID, session ID, or scoped alias to reconcile.'),
          decision: tool.schema.enum(['reconciled', 'ignored']).describe('Whether the terminal job was reconciled into task state or intentionally ignored.'),
          summary: tool.schema.string().describe('Required reconciliation summary or ignore reason.'),
        })).describe('Terminal background jobs to reconcile or ignore.'),
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

        return json({
          success: results.every(result => result.success === true),
          results,
          recommendedNextAction: buildBatchPostReconcileRecommendedNextAction(results),
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

        options.backgroundJobService.markCancelRequested(resolved.job.taskId, trimmedReason);
        const runtimeResult = await cancelRuntimeTask(resolved.job.taskId, toolContext as ToolContext);
        const updated = runtimeResult.cancelled
          ? options.backgroundJobService.markRuntimeCancelled(resolved.job.taskId, { resultSummary: runtimeResult.message })
          : options.backgroundJobService.resolve(resolved.job.taskId);

        return json({
          success: true,
          runtimeCancelled: runtimeResult.cancelled,
          runtimeMessage: runtimeResult.message,
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

  const job = backgroundJobService.resolve(trimmedIdentifier);
  if (!job) {
    return failure('job_not_found', `Background job not found: ${trimmedIdentifier}`);
  }

  if (job.scope?.projectRoot !== projectRoot || !isJobVisible(job, toolContext)) {
    return failure('job_not_in_scope', `Background job ${trimmedIdentifier} is not visible to this primary session.`);
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
    return {
      identifier: item.identifier,
      ...failure('job_not_terminal', `Background job ${resolved.job.taskId} is ${resolved.job.runtimeState}, not terminal.`),
      nextAction: nativeCompletionPendingWait(resolved.job),
    };
  }

  const reconciled = item.decision === 'reconciled'
    ? backgroundJobService.markReconciled(resolved.job.taskId, {
        reconciledBy: toolContext.sessionID,
        reconciliationSummary: trimmedSummary,
      })
    : backgroundJobService.markIgnored(resolved.job.taskId, trimmedSummary);

  return {
    identifier: item.identifier,
    success: true,
    decision: item.decision,
    archive: {
      archived: true,
      message: 'The background job is archived and hidden from normal status output. Do not edit .hive/background-jobs.json directly.',
    },
    recommendedNextAction: buildPostReconcileRecommendedNextAction(reconciled),
    job: formatJob(reconciled),
  };
}

function isJobVisible(job: BackgroundJobRecord, toolContext: ToolContext): boolean {
  if (toolContext.sessionID && job.scope?.parentSessionId !== toolContext.sessionID) {
    return false;
  }
  if (toolContext.agent && job.scope?.primaryAgent && job.scope.primaryAgent !== toolContext.agent) {
    return false;
  }
  return true;
}

function isPendingLaunchVisible(pending: BackgroundPendingLaunch, toolContext: ToolContext): boolean {
  if (toolContext.sessionID && pending.parentSessionId !== toolContext.sessionID) {
    return false;
  }
  if (toolContext.agent && pending.scope?.primaryAgent && pending.scope.primaryAgent !== toolContext.agent) {
    return false;
  }
  return true;
}

function matchesOptionalScope(
  job: BackgroundJobRecord | BackgroundPendingLaunch,
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

function buildNextActions(jobs: BackgroundJobRecord[], pendingLaunches: BackgroundPendingLaunch[]): Array<Record<string, string | undefined>> {
  const actions: Array<Record<string, string | undefined>> = jobs
    .filter(job => isTerminalRuntimeState(job.runtimeState) && job.terminalUnreconciled === true)
    .map(reconcileRequiredAction);

  if (pendingLaunches.length > 0) {
    actions.push({
      reason: 'pending_launch_without_registered_job',
      command: 'launch or verify the native task({ background: true, ... }) call, then call hive_background_status again',
      message: 'A Hive launch is pending but no matching background job is registered yet. Do not report no jobs or reconcile from this empty board alone.',
    });
  }

  return actions;
}

function buildNativeCompletionWaits(jobs: BackgroundJobRecord[]): Array<Record<string, string>> {
  return jobs
    .filter(job => job.runtimeState === 'running' || job.runtimeState === 'unknown')
    .map(nativeCompletionPendingWait);
}

function buildOrchestrationBurden(jobs: BackgroundJobRecord[], pendingLaunches: BackgroundPendingLaunch[]): Record<string, number> {
  const completionNotificationsPending = jobs.filter(job => job.runtimeState === 'running' || job.runtimeState === 'unknown').length;
  const reconcileItemsRequired = jobs.filter(job => isTerminalRuntimeState(job.runtimeState) && job.terminalUnreconciled === true).length;
  const actionableLanes = reconcileItemsRequired + pendingLaunches.length;

  return {
    visibleLanes: jobs.length,
    actionableLanes,
    pendingLaunches: pendingLaunches.length,
    completionNotificationsPending,
    reconcileItemsRequired,
    recommendedReconcileToolCalls: reconcileItemsRequired > 0 ? 1 : 0,
  };
}

function buildRecommendedNextAction(jobs: BackgroundJobRecord[], pendingLaunches: BackgroundPendingLaunch[]): RecommendedNextAction {
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
    return {
      action: 'reconcile_terminal_job',
      reasonCode: 'terminal_unreconciled_job_visible',
      taskId: terminalJobs[0].taskId,
      message: 'A visible background job is terminal and unreconciled. Reconcile or ignore the board item, then inspect Hive status if it belongs to scoped feature/task work.',
      requiresHiveStatusRefresh: hasHiveFeatureOrTaskScope(terminalJobs[0]),
    };
  }

  if (pendingLaunches.length > 0) {
    return {
      action: 'verify_pending_launch',
      reasonCode: 'pending_launch_without_registered_job',
      message: 'A Hive launch is pending but no matching background job is registered yet. Verify the native background launch before treating the board as idle.',
      requiresHiveStatusRefresh: false,
    };
  }

  const waitingJobs = jobs.filter(job => job.runtimeState === 'running' || job.runtimeState === 'unknown');
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

function buildPostReconcileRecommendedNextAction(job: BackgroundJobRecord): RecommendedNextAction {
  if (!hasHiveFeatureOrTaskScope(job)) {
    return idleRecommendedNextAction();
  }

  return {
    action: 'inspect_hive_status',
    reasonCode: 'reconciled_job_has_hive_scope',
    taskId: job.taskId,
    message: 'The background board item is archived. Inspect Hive feature/task status to decide the next orchestration step.',
    requiresHiveStatusRefresh: true,
  };
}

function buildBatchPostReconcileRecommendedNextAction(results: Array<Record<string, unknown>>): RecommendedNextAction {
  const taskIds = results.flatMap(result => {
    const action = result.recommendedNextAction as Record<string, unknown> | undefined;
    return action?.action === 'inspect_hive_status' && typeof action.taskId === 'string' ? [action.taskId] : [];
  });

  if (taskIds.length === 0) {
    return idleRecommendedNextAction();
  }

  return {
    action: 'inspect_hive_status',
    reasonCode: 'reconciled_job_has_hive_scope',
    taskIds,
    message: 'One or more background board items were archived for Hive feature/task work. Inspect Hive status to decide the next orchestration step.',
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

function reconcileRequiredAction(job: BackgroundJobRecord): Record<string, string> {
  return {
    reason: 'reconcile_required',
    taskId: job.taskId,
    precondition: 'Consume or intentionally ignore the terminal result before running this command.',
    command: `hive_background_reconcile({ identifier: "${job.taskId}", decision: "reconciled", summary: "<what was done with the result>" })`,
    message: 'This background job is terminal but unreconciled. Consume or intentionally ignore the result, then reconcile or ignore it explicitly.',
  };
}

function isTerminalRuntimeState(state: BackgroundJobRecord['runtimeState']): boolean {
  return state === 'completed' || state === 'error' || state === 'cancelled';
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
  const visibility = job.archivedAt
    ? (job.archiveReason === 'ignored' ? 'ignored_archived' : 'archived_after_reconcile')
    : (terminal && job.terminalUnreconciled === true ? 'terminal_unreconciled' : 'active');

  return {
    taskId: job.taskId,
    sessionId: job.sessionId,
    alias: job.alias,
    agentName: job.agentName,
    description: job.description,
    objective: job.objective,
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
      scopeSource: job.scopeSource,
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
      retryOf: job.retryOf,
      supersedes: job.supersedes,
      visibility,
      actionRequired: terminal && job.terminalUnreconciled === true,
    }),
    scope: job.scope,
    ownership: job.ownership,
  };
}

function formatPendingLaunch(pending: BackgroundPendingLaunch): Record<string, unknown> {
  return {
    parentSessionId: pending.parentSessionId,
    expectedDescription: pending.expectedDescription,
    expectedPrompt: pending.expectedPrompt,
    agentName: pending.agentName,
    createdAt: pending.createdAt,
    scope: pending.scope,
    ownership: pending.ownership,
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
