import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import type { BackgroundJobRecord, BackgroundJobService } from 'hive-core';

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
      },
      async execute({ includeStale, feature, task, adHocRunId, workflow }, toolContext) {
        if (!options.isEnabled()) {
          return json(disabledResponse());
        }

        const jobs = options.backgroundJobService
          .listScoped({ projectRoot: options.projectRoot })
          .filter(job => isJobVisible(job, toolContext as ToolContext))
          .filter(job => includeStale === true || !job.staleAt)
          .filter(job => matchesOptionalScope(job, { feature, task, adHocRunId, workflow }));

        return json({
          success: true,
          scope: currentScope(options.projectRoot, toolContext as ToolContext),
          jobs: jobs.map(formatJob),
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

        const trimmedSummary = summary.trim();
        if (!trimmedSummary) {
          return json(failure('summary_required', 'A non-empty summary is required to reconcile or ignore a background job.'));
        }

        const resolved = resolveVisibleJob(options.backgroundJobService, identifier, options.projectRoot, toolContext as ToolContext);
        if (!resolved.success) {
          return json(resolved);
        }

        if (!isTerminalRuntimeState(resolved.job.runtimeState)) {
          return json(failure('job_not_terminal', `Background job ${resolved.job.taskId} is ${resolved.job.runtimeState}, not terminal.`));
        }

        const reconciled = decision === 'reconciled'
          ? options.backgroundJobService.markReconciled(resolved.job.taskId, {
              reconciledBy: (toolContext as ToolContext).sessionID,
              reconciliationSummary: trimmedSummary,
            })
          : options.backgroundJobService.markIgnored(resolved.job.taskId, trimmedSummary);

        return json({
          success: true,
          decision: decision as ReconcileDecision,
          job: formatJob(reconciled),
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

function isJobVisible(job: BackgroundJobRecord, toolContext: ToolContext): boolean {
  if (toolContext.sessionID && job.scope?.parentSessionId !== toolContext.sessionID) {
    return false;
  }
  if (toolContext.agent && job.scope?.primaryAgent && job.scope.primaryAgent !== toolContext.agent) {
    return false;
  }
  return true;
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
      cancelRequestedAt: job.cancelRequestedAt,
      cancelReason: job.cancelReason,
      reconciledAt: job.reconciledAt,
      reconciledBy: job.reconciledBy,
      reconciliationSummary: job.reconciliationSummary,
      ignoredAt: job.ignoredAt,
      ignoreReason: job.ignoreReason,
      staleAt: job.staleAt,
      retryOf: job.retryOf,
      supersedes: job.supersedes,
    }),
    scope: job.scope,
    ownership: job.ownership,
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
