import * as fs from 'node:fs';
import * as path from 'node:path';
import { tool, type Plugin } from '@opencode-ai/plugin';
import {
  AdhocWorktreeService,
  BackgroundJobService,
  ConfigService,
  ContextMutationError,
  ContextService,
  DEFAULT_COUNCIL_CONFIG,
  DockerSandboxService,
  FeatureConstraintService,
  FeatureService,
  PlanService,
  RepositoryManifestService,
  RepositoryService,
  SessionService,
  TaskService,
  TaskUpdatePersistenceError,
  WorktreeService,
  assertValidFeatureName,
  computeRunnableAndBlocked,
  detectContext,
  readCompositeWorkspaceManifest,
  type ContextScope,
  type CustomAgentBase,
  type ResolvedCustomAgentConfig,
  type StandingConstraintEntry,
} from 'hive-core';
import { QUEEN_BEE_PROMPT } from './agents/hive.js';
import { ARCHITECT_BEE_PROMPT } from './agents/architect.js';
import { SWARM_BEE_PROMPT } from './agents/swarm.js';
import { SCOUT_BEE_PROMPT } from './agents/scout.js';
import { FORAGER_BEE_PROMPT } from './agents/forager.js';
import { HIVE_HELPER_PROMPT } from './agents/hive-helper.js';
import { HIVE_BUILDER_PROMPT } from './agents/hive-builder.js';
import { PLAN_REVIEWER_PROMPT } from './agents/plan-reviewer.js';
import { CODE_REVIEWER_PROMPT } from './agents/code-reviewer.js';
import { SIMPLICITY_REVIEWER_PROMPT } from './agents/simplicity-reviewer.js';
import { APPROACH_ADVISOR_PROMPT } from './agents/approach-advisor.js';
import { VULNERABILITY_REVIEWER_PROMPT } from './agents/vulnerability-reviewer.js';
import { DASH_REVIEWER_PROMPT } from './agents/dash-reviewer.js';
import { VULNERABILITY_REVIEW_PRIMARY_PROMPT } from './agents/vulnerability-review-primary.js';
import { buildCustomSubagents } from './agents/custom-agents.js';
import { createBuiltinMcps } from './mcp/index.js';
import { prepareNativeHiveSkills } from './skills/native-materializer.js';
import { createBackgroundJobAdapter } from './background/backgroundJobAdapter.js';
import { createBackgroundTools } from './background/backgroundTools.js';
import { isBackgroundSubagentsExperimentEnabled, resolveBackgroundDelegationAvailability } from './utils/background-gate.js';
import { GitSnapshotError, inspectGitSnapshot, isExactGitTopLevel } from './utils/git-snapshot.js';
import { HIVE_SYSTEM_PROMPT, SUBAGENT_CLARIFICATION_PROMPT, shouldExecuteHook } from './hooks/system-hook.js';
import { createVariantHook } from './hooks/variant-hook.js';
import { HIVE_TOOL_NAMES } from './utils/plugin-manifest.js';
import { buildHiveCommandMap } from './commands/runtime.js';
import { HIVE_COMMANDS } from './commands/registry.js';
import { hiveCommandRenderers } from './commands/renderers.js';
import { isReadOnlyCouncilEligibleBase } from './commands/council.js';
import type { HiveCommandAgentDescriptor, HiveCommandContext } from './commands/types.js';
import { createTaskTraceTools, injectTaskTraceHint, TASK_TRACE_SUMMARIZER_AGENT } from './task-trace.js';

type ToolContext = { sessionID?: string; agent?: string };
type RouteSnapshot = {
  projectRoot: string;
  hasFeatureRoute: boolean;
  featureName?: string | null;
  sessionConstraints: { entries: StandingConstraintEntry[]; revision: number; constraints: string };
  featureConstraints?: { entries: StandingConstraintEntry[]; revision: number; constraints: string };
};

const NON_FEATURE_NAMESPACES = new Set(['adhoc', 'review']);
const MAX_SNAPSHOT_REPOSITORIES = 32;
const json = (value: unknown): string => JSON.stringify(value, null, 2);

function taskChildBinding(event: unknown): { parent: string; call: string; child: string; agent?: string } | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as Record<string, any>;
  const part = record.type === 'message.part.updated' ? record.properties?.part : undefined;
  if (part?.type !== 'tool' || part.tool !== 'task' || typeof part.sessionID !== 'string' || typeof part.callID !== 'string') return undefined;
  const state = part.state && typeof part.state === 'object' ? part.state : undefined;
  const child = part.metadata?.sessionId ?? state?.metadata?.sessionId;
  if (typeof child !== 'string' || !child.trim()) return undefined;
  return {
    parent: part.sessionID,
    call: part.callID,
    child,
    ...(typeof state?.input?.subagent_type === 'string' ? { agent: state.input.subagent_type } : {}),
  };
}

function routeFooter(snapshot: RouteSnapshot): string {
  const payload = {
    projectRoot: snapshot.projectRoot,
    featureRoute: snapshot.hasFeatureRoute
      ? { selected: true, feature: snapshot.featureName ?? null }
      : { selected: false },
    sessionConstraints: snapshot.sessionConstraints,
    featureConstraints: snapshot.featureConstraints ?? null,
  };
  return [
    '<!-- hive-route-snapshot:start -->',
    '## Hive route snapshot',
    `Route snapshot (JSON): ${JSON.stringify(payload)}`,
    'This is a dispatch-time snapshot. If directives conflict, report the conflict; runtime routing does not decide it.',
    '<!-- hive-route-snapshot:end -->',
  ].join('\n');
}

function snapshotFailure(error: unknown, repositoryId?: string) {
  if (!(error instanceof GitSnapshotError)) {
    return {
      repositoryId,
      code: 'INVALID_REQUEST' as const,
      phase: 'validation' as const,
      retry: 'not-retryable' as const,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const failure = error;
  return {
    repositoryId,
    code: failure.code,
    phase: failure.phase,
    retry: failure.retry,
    message: failure.message,
  };
}

const plugin: Plugin = async (ctx) => {
  const workTarget = ctx.project?.id === 'global' && ctx.worktree === '/' ? ctx.directory : ctx.worktree || ctx.directory;
  const detected = detectContext(workTarget);
  const projectRoot = fs.realpathSync(detected.projectRoot);
  const runtimeId = `pid-${process.pid}-${Date.now().toString(36)}`;

  const featureService = new FeatureService(projectRoot);
  const planService = new PlanService(projectRoot);
  const taskService = new TaskService(projectRoot);
  const sessionService = new SessionService(projectRoot);
  const featureConstraintService = new FeatureConstraintService(projectRoot);
  const contextService = new ContextService(projectRoot);
  const configService = new ConfigService(projectRoot);
  const repositoryManifestService = new RepositoryManifestService(projectRoot);
  const backgroundJobService = new BackgroundJobService(projectRoot);
  const runtimeAgentPrompts = new Map<string, string>();
  const runtimeSessionAgents = new Map<string, string>();
  const runtimeTaskChildren = new Set<string>();
  const dispatchSnapshots = new Map<string, RouteSnapshot>();
  const taskTraceHintIDs = new Set<string>();
  const ephemeralSessionIDs = new Set<string>();
  const taskTraceConfig = configService.get().taskTraceSummarizer ?? { temperature: 0 };
  const taskTraceTools = createTaskTraceTools({
    client: ctx.client as unknown as Parameters<typeof createTaskTraceTools>[0]['client'],
    directory: projectRoot,
    summarizer: taskTraceConfig,
    ephemeralSessionIDs,
  });
  const backgroundAdapter = createBackgroundJobAdapter({
    projectRoot,
    service: backgroundJobService,
    isEnabled: isBackgroundSubagentsExperimentEnabled,
    runtimeId,
    getSession: (sessionId) => sessionService.getGlobal(sessionId),
  });

  const hasManifest = (): boolean => repositoryManifestService.getStatus().mode === 'manifest';
  const repositoryResolver = () => hasManifest() ? repositoryManifestService.resolveRepositories() : [];
  const worktreeService = new WorktreeService({
    baseDir: projectRoot,
    hiveDir: path.join(projectRoot, '.hive'),
    repositoryResolver: { resolveRepositories: repositoryResolver },
    taskRepoResolver: { resolveTaskRepoIds: (feature, task) => taskService.getRawStatus(feature, task)?.repoIds },
  });
  const adhocService = (sourceDirectory?: string, repoIds?: string[]) => {
    if (sourceDirectory && repoIds !== undefined) throw new Error('sourceDirectory cannot be combined with repoIds');
    if (sourceDirectory && !path.isAbsolute(sourceDirectory)) throw new Error('sourceDirectory must be absolute');
    const baseDir = sourceDirectory ? fs.realpathSync(sourceDirectory) : projectRoot;
    return new AdhocWorktreeService({
      baseDir,
      hiveDir: path.join(projectRoot, '.hive'),
      repositoryResolver: { resolveRepositories: sourceDirectory ? () => [] : repositoryResolver },
    });
  };

  const liveFeatures = (): string[] => featureService.list().filter((name) => {
    const status = featureService.get(name)?.status;
    return status === 'planning' || status === 'approved' || status === 'executing';
  });
  const selectFeature = (sessionID: string | undefined, feature: string | null): void => {
    if (feature !== null) assertValidFeatureName(feature);
    if (sessionID) sessionService.setFeatureRoute(sessionID, feature);
  };
  const resolveFeature = (explicit: string | undefined, toolContext?: unknown): string | null => {
    const sessionID = (toolContext as ToolContext | undefined)?.sessionID;
    if (explicit !== undefined) {
      const feature = explicit.trim();
      if (!feature) return null;
      assertValidFeatureName(feature);
      selectFeature(sessionID, feature);
      return feature;
    }
    const stored = sessionID ? sessionService.getGlobal(sessionID) : undefined;
    if (stored && Object.prototype.hasOwnProperty.call(stored, 'featureName')) {
      if (stored.featureName !== null && stored.featureName !== undefined) assertValidFeatureName(stored.featureName);
      return stored.featureName ?? null;
    }
    if (detected.feature && !NON_FEATURE_NAMESPACES.has(detected.feature)) {
      assertValidFeatureName(detected.feature);
      return detected.feature;
    }
    const candidates = liveFeatures();
    return candidates.length === 1 ? candidates[0]! : null;
  };
  const requireFeature = (explicit: string | undefined, context?: unknown): string => {
    const feature = resolveFeature(explicit, context);
    if (!feature) throw new Error('Feature is required. Select one with hive_feature_select or pass feature explicitly.');
    return feature;
  };
  const contextScope = (scope: 'feature' | 'project' | undefined, feature: string | undefined, context?: unknown, task?: string): ContextScope => {
    if (scope === 'project') {
      if (feature !== undefined || task !== undefined) throw new Error('Project context does not accept feature or task selectors');
      return { type: 'project' };
    }
    return { type: 'feature', featureName: requireFeature(feature, context) };
  };
  const captureRoute = (sessionID: string): RouteSnapshot => {
    const session = sessionService.getGlobal(sessionID);
    const hasFeatureRoute = !!session && Object.prototype.hasOwnProperty.call(session, 'featureName');
    const featureName = hasFeatureRoute ? session!.featureName : detected.feature && !NON_FEATURE_NAMESPACES.has(detected.feature) ? detected.feature : undefined;
    if (featureName !== null && featureName !== undefined) assertValidFeatureName(featureName);
    const sessionConstraints = sessionService.readStandingConstraints(sessionID);
    const featureConstraints = typeof featureName === 'string' ? featureConstraintService.read(featureName) : undefined;
    return { projectRoot, hasFeatureRoute: hasFeatureRoute || featureName !== undefined, featureName, sessionConstraints, featureConstraints };
  };
  const constraintTarget = (input: { scope?: 'session' | 'feature'; feature?: string }, context: ToolContext) => {
    if ((input.scope ?? 'session') === 'session') {
      if (input.feature !== undefined) throw new Error('feature is not allowed with session constraint scope');
      if (!context.sessionID) throw new Error('Session identity is required');
      return { scope: 'session' as const, sessionID: context.sessionID };
    }
    return { scope: 'feature' as const, feature: requireFeature(input.feature, context) };
  };
  const readConstraints = (target: ReturnType<typeof constraintTarget>) => target.scope === 'session'
    ? sessionService.readStandingConstraints(target.sessionID)
    : featureConstraintService.read(target.feature);
  const assertTaskRepoIds = (feature: string, task: string, repoIds?: string[]): void => {
    if (repoIds === undefined) return;
    const stored = taskService.getRawStatus(feature, task)?.repoIds ?? [];
    if (JSON.stringify([...new Set(repoIds)].sort()) !== JSON.stringify([...new Set(stored)].sort())) {
      throw new Error(`repoIds must match the task repository selection: ${stored.join(', ') || '(single root)'}`);
    }
  };
  const bindChildSnapshot = (binding: { parent: string; call: string; child: string; agent?: string }): void => {
    runtimeTaskChildren.add(binding.child);
    const key = `${binding.parent}\0${binding.call}`;
    const snapshot = dispatchSnapshots.get(key);
    if (!snapshot) return;
    const existing = sessionService.getGlobal(binding.child);
    if (existing?.parentSessionId !== undefined && existing.parentSessionId !== binding.parent) {
      throw new Error('existing child snapshot parent cannot change');
    }
    sessionService.trackGlobal(binding.child, {
      parentSessionId: binding.parent,
      projectRoot: snapshot.projectRoot,
      featureName: snapshot.hasFeatureRoute ? snapshot.featureName : undefined,
      agent: binding.agent,
      standingConstraintEntries: snapshot.sessionConstraints.entries,
      standingConstraintsRevision: snapshot.sessionConstraints.revision,
      standingConstraints: snapshot.sessionConstraints.constraints || undefined,
    });
    dispatchSnapshots.delete(key);
  };

  const tools: Record<string, any> = {
    ...taskTraceTools,
    ...createBackgroundTools({
      backgroundJobService,
      projectRoot,
      isEnabled: isBackgroundSubagentsExperimentEnabled,
      currentRuntimeId: runtimeId,
      cancelRuntimeTask: async (sessionId) => {
        const result = await ctx.client.session.abort({ path: { id: sessionId }, query: { directory: projectRoot } });
        return { cancelled: result.data === true, message: result.data === true ? 'Runtime task abort requested.' : String(result.error ?? 'Abort not confirmed.') };
      },
    }),
    hive_feature_create: tool({
      description: 'Create a new feature',
      args: { name: tool.schema.string(), ticket: tool.schema.string().optional() },
      execute: async ({ name, ticket }, context) => {
        const result = featureService.create(name, ticket);
        selectFeature((context as ToolContext).sessionID, result.name);
        return json(result);
      },
    }),
    hive_feature_select: tool({
      description: 'Select a feature for this session, or select null for an explicitly featureless route.',
      args: { feature: tool.schema.string().nullable() },
      execute: async ({ feature }, context) => {
        const sessionID = (context as ToolContext).sessionID;
        if (!sessionID) throw new Error('Session identity is required');
        return json(sessionService.setFeatureRoute(sessionID, feature));
      },
    }),
    hive_feature_complete: tool({
      description: 'Mark a feature completed. Incomplete tasks are returned as warnings.',
      args: { name: tool.schema.string().optional() },
      execute: async ({ name }, context) => {
        const feature = requireFeature(name, context);
        const incompleteTasks = taskService.list(feature).filter((task) => task.status !== 'done' && task.status !== 'cancelled');
        const result = featureService.complete(feature);
        return json({ success: true, feature: result, warnings: incompleteTasks.length ? [{ incompleteTasks }] : [] });
      },
    }),
    hive_repositories_status: tool({ description: 'Inspect project repository mode and manifest.', args: {}, execute: async () => json(repositoryManifestService.getStatus()) }),
    hive_repositories_discover: tool({ description: 'Discover repositories.', args: {}, execute: async () => json(repositoryManifestService.discover()) }),
    hive_repositories_update: tool({
      description: 'Add repositories to the project manifest.',
      args: { repositories: tool.schema.array(tool.schema.object({ id: tool.schema.string(), path: tool.schema.string() })) },
      execute: async ({ repositories }) => json(repositoryManifestService.add(repositories)),
    }),
    hive_plan_write: tool({
      description: 'Write plan.md.',
      args: { content: tool.schema.string(), feature: tool.schema.string().optional() },
      execute: async ({ content, feature }, context) => planService.write(requireFeature(feature, context), content),
    }),
    hive_plan_patch: tool({
      description: 'Patch bounded plan sections.',
      args: {
        expectedRevision: tool.schema.string(),
        operations: tool.schema.array(tool.schema.object({ type: tool.schema.enum(['replace_section', 'replace_task', 'insert_after_section']), headingPath: tool.schema.array(tool.schema.string()).optional(), taskNumber: tool.schema.number().optional(), content: tool.schema.string() })),
        feature: tool.schema.string().optional(),
      },
      execute: async ({ expectedRevision, operations, feature }, context) => json(planService.patch(requireFeature(feature, context), expectedRevision, operations as any)),
    }),
    hive_plan_read: tool({
      description: 'Read plan.md.',
      args: { feature: tool.schema.string().optional(), mode: tool.schema.enum(['full', 'outline']).optional() },
      execute: async ({ feature, mode }, context) => {
        const selected = requireFeature(feature, context);
        return json(mode === 'outline' ? planService.read(selected, { mode: 'outline' }) : planService.read(selected, { mode: 'full' }));
      },
    }),
    hive_plan_approve: tool({
      description: 'Approve the plan.',
      args: { feature: tool.schema.string().optional() },
      execute: async ({ feature }, context) => json(planService.approve(requireFeature(feature, context))),
    }),
    hive_tasks_sync: tool({
      description: 'Sync tasks from the approved plan.',
      args: { feature: tool.schema.string().optional(), refreshPending: tool.schema.boolean().optional() },
      execute: async ({ feature, refreshPending }, context) => json(taskService.sync(requireFeature(feature, context), { refreshPending })),
    }),
    hive_task_create: tool({
      description: 'Create an append-only manual task. Dependencies need only reference existing tasks.',
      args: {
        name: tool.schema.string(), order: tool.schema.number().optional(), feature: tool.schema.string().optional(),
        description: tool.schema.string().optional(), goal: tool.schema.string().optional(), acceptanceCriteria: tool.schema.array(tool.schema.string()).optional(),
        references: tool.schema.array(tool.schema.string()).optional(), files: tool.schema.array(tool.schema.string()).optional(), dependsOn: tool.schema.array(tool.schema.string()).optional(),
        reason: tool.schema.string().optional(), source: tool.schema.string().optional(), repos: tool.schema.array(tool.schema.string()).optional(),
      },
      execute: async ({ name, order, feature, repos, ...metadata }, context) => taskService.create(requireFeature(feature, context), name, order, { ...metadata, repoIds: repos } as any),
    }),
    hive_task_update: tool({
      description: 'Update task state and optionally persist an immutable report.',
      args: {
        task: tool.schema.string(),
        status: tool.schema.enum(['pending', 'in_progress', 'done', 'cancelled', 'blocked', 'failed', 'partial']).optional(),
        summary: tool.schema.string().optional(),
        blocker: tool.schema.object({ reason: tool.schema.string(), options: tool.schema.array(tool.schema.string()).optional(), recommendation: tool.schema.string().optional(), context: tool.schema.string().optional() }).nullable().optional(),
        report: tool.schema.string().optional(),
        feature: tool.schema.string().optional(),
      },
      execute: async ({ task, feature, ...updates }, context) => {
        try { return json(taskService.update(requireFeature(feature, context), task, updates)); }
        catch (error) {
          if (!(error instanceof TaskUpdatePersistenceError)) throw error;
          return json({ success: false, reason: 'task_update_persistence_failed', error: error.message, failedStage: error.failedStage, reportPath: error.reportPath, latestReportPath: error.latestReportPath, reportHistoryWritten: error.reportHistoryWritten, latestReportWritten: error.latestReportWritten, failedWritePublished: error.failedWritePublished });
        }
      },
    }),
    hive_worktree_create: tool({
      description: 'Create a task worktree without changing task state.',
      args: { feature: tool.schema.string(), task: tool.schema.string(), baseRef: tool.schema.string().optional(), repoIds: tool.schema.array(tool.schema.string()).optional(), candidate: tool.schema.string().optional() },
      execute: async ({ feature, task, baseRef, repoIds, candidate }, context) => { selectFeature((context as ToolContext).sessionID, feature); assertTaskRepoIds(feature, task, repoIds); return json(await worktreeService.create(feature, task, baseRef, candidate)); },
    }),
    hive_worktree_inspect: tool({
      description: 'Inspect a task worktree.',
      args: { feature: tool.schema.string(), task: tool.schema.string(), repoIds: tool.schema.array(tool.schema.string()).optional(), candidate: tool.schema.string().optional() },
      execute: async ({ feature, task, repoIds, candidate }, context) => { selectFeature((context as ToolContext).sessionID, feature); assertTaskRepoIds(feature, task, repoIds); return json(await worktreeService.inspect(feature, task, candidate)); },
    }),
    hive_worktree_merge: tool({
      description: 'Merge an exact task worktree source into the current target.',
      args: {
        feature: tool.schema.string(), task: tool.schema.string(), repoIds: tool.schema.array(tool.schema.string()).optional(), candidate: tool.schema.string().optional(),
        strategy: tool.schema.enum(['merge', 'squash', 'rebase']).optional(), message: tool.schema.string().optional(), preserveConflicts: tool.schema.boolean().optional(),
        cleanup: tool.schema.enum(['none', 'worktree', 'worktree+branch']).optional(), sourceCommit: tool.schema.string().optional(), sourceCommits: tool.schema.record(tool.schema.string(), tool.schema.string()).optional(),
      },
      execute: async ({ feature, task, repoIds, candidate, strategy = 'squash', message, ...options }, context) => {
        selectFeature((context as ToolContext).sessionID, feature);
        assertTaskRepoIds(feature, task, repoIds);
        const inspected = await worktreeService.inspect(feature, task, candidate);
        if (!inspected) throw new Error('Task worktree not found');
        const actualPins = inspected.repos ? Object.fromEntries(Object.entries(inspected.repos).map(([id, repo]) => [id, repo.commit])) : undefined;
        if (actualPins && options.sourceCommit !== undefined) throw new Error('sourceCommit cannot select a composite candidate');
        if (!actualPins && options.sourceCommits !== undefined) throw new Error('sourceCommits require a composite candidate');
        if (actualPins && options.sourceCommits !== undefined && JSON.stringify(Object.entries(options.sourceCommits).sort()) !== JSON.stringify(Object.entries(actualPins).sort())) throw new Error('sourceCommits must exactly match every inspected candidate repository');
        if (!actualPins && options.sourceCommit !== undefined && options.sourceCommit !== inspected.commit) throw new Error('sourceCommit does not match the inspected candidate');
        const pins = actualPins ? { sourceCommits: options.sourceCommits ?? actualPins } : { sourceCommit: options.sourceCommit ?? inspected.commit };
        return json(await worktreeService.merge(feature, task, strategy, message, { ...options, ...pins }, candidate));
      },
    }),
    hive_worktree_cleanup: tool({
      description: 'Clean up a task worktree. Set discard to explicitly retire unintegrated work.',
      args: { feature: tool.schema.string(), task: tool.schema.string(), repoIds: tool.schema.array(tool.schema.string()).optional(), candidate: tool.schema.string().optional(), deleteBranch: tool.schema.boolean().optional(), discard: tool.schema.boolean().optional() },
      execute: async ({ feature, task, repoIds, candidate, deleteBranch, discard }, context) => { selectFeature((context as ToolContext).sessionID, feature); assertTaskRepoIds(feature, task, repoIds); return json(await worktreeService.remove(feature, task, deleteBranch, { discard }, candidate)); },
    }),
    hive_adhoc_worktree_create: tool({
      description: 'Create an ad-hoc worktree.',
      args: { runId: tool.schema.string().optional(), repoIds: tool.schema.array(tool.schema.string()).optional(), sourceDirectory: tool.schema.string().optional() },
      execute: async ({ sourceDirectory, ...options }) => json(await adhocService(sourceDirectory, options.repoIds).create(options)),
    }),
    hive_adhoc_worktree_inspect: tool({
      description: 'Inspect an ad-hoc worktree.',
      args: { runId: tool.schema.string(), repoIds: tool.schema.array(tool.schema.string()).optional(), sourceDirectory: tool.schema.string().optional() },
      execute: async ({ runId, repoIds, sourceDirectory }) => json(await adhocService(sourceDirectory, repoIds).inspect(runId)),
    }),
    hive_adhoc_worktree_merge: tool({
      description: 'Merge an exact ad-hoc source into the selected target.',
      args: {
        runId: tool.schema.string(), repoIds: tool.schema.array(tool.schema.string()).optional(), sourceDirectory: tool.schema.string().optional(),
        strategy: tool.schema.enum(['merge', 'squash', 'rebase']).optional(), message: tool.schema.string().optional(), preserveConflicts: tool.schema.boolean().optional(), cleanup: tool.schema.enum(['none', 'worktree', 'worktree+branch']).optional(),
        sourceCommit: tool.schema.string().optional(), sourceCommits: tool.schema.record(tool.schema.string(), tool.schema.string()).optional(),
      },
      execute: async ({ runId, repoIds, sourceDirectory, strategy = 'squash', message, ...options }) => {
        const service = adhocService(sourceDirectory, repoIds);
        const inspected = await service.inspect(runId);
        if (!inspected) throw new Error('Ad-hoc worktree not found');
        const actualPins = inspected.repos ? Object.fromEntries(Object.entries(inspected.repos).map(([id, repo]) => [id, repo.commit])) : undefined;
        if (actualPins && options.sourceCommit !== undefined) throw new Error('sourceCommit cannot select a composite candidate');
        if (!actualPins && options.sourceCommits !== undefined) throw new Error('sourceCommits require a composite candidate');
        if (actualPins && options.sourceCommits !== undefined && JSON.stringify(Object.entries(options.sourceCommits).sort()) !== JSON.stringify(Object.entries(actualPins).sort())) throw new Error('sourceCommits must exactly match every inspected candidate repository');
        if (!actualPins && options.sourceCommit !== undefined && options.sourceCommit !== inspected.commit) throw new Error('sourceCommit does not match the inspected candidate');
        const pins = actualPins ? { sourceCommits: options.sourceCommits ?? actualPins } : { sourceCommit: options.sourceCommit ?? inspected.commit };
        return json(await service.merge(runId, strategy, message, { ...options, ...pins }));
      },
    }),
    hive_adhoc_worktree_cleanup: tool({
      description: 'Clean up an ad-hoc worktree. Set discard to explicitly retire unintegrated work.',
      args: { runId: tool.schema.string(), repoIds: tool.schema.array(tool.schema.string()).optional(), sourceDirectory: tool.schema.string().optional(), deleteBranch: tool.schema.boolean().optional(), discard: tool.schema.boolean().optional() },
      execute: async ({ runId, repoIds, sourceDirectory, deleteBranch, discard }) => json(await adhocService(sourceDirectory, repoIds).cleanup(runId, deleteBranch, { discard })),
    }),
    hive_context_read: tool({
      description: 'Read managed project or feature context.',
      args: { name: tool.schema.string().optional(), scope: tool.schema.enum(['feature', 'project']).optional(), feature: tool.schema.string().optional(), view: tool.schema.enum(['summary', 'catalog']).optional(), query: tool.schema.string().optional(), limit: tool.schema.number().optional(), cursor: tool.schema.string().optional(), maxBytes: tool.schema.number().optional(), scanChars: tool.schema.boolean().optional() },
      execute: async ({ name, scope, feature, view, maxBytes, ...options }, context) => {
        const resolved = contextScope(scope, feature, context);
        if (name) return json(contextService.readContent(resolved, name, { maxBytes }));
        return json(view === 'catalog' ? contextService.readCatalog(resolved, options) : contextService.readSummary(resolved, { scanChars: options.scanChars }));
      },
    }),
    hive_context_write: tool({
      description: 'Create or replace managed context.',
      args: { name: tool.schema.string(), content: tool.schema.string(), kind: tool.schema.enum(['durable', 'evidence']).optional(), task: tool.schema.string().optional(), expectedRevision: tool.schema.number().optional(), expectedContentHash: tool.schema.string().optional(), scope: tool.schema.enum(['feature', 'project']).optional(), feature: tool.schema.string().optional() },
      execute: async ({ name, content, kind, task, expectedRevision, expectedContentHash, scope, feature }, context) => {
        const resolved = contextScope(scope, feature, context, task);
        const result = expectedRevision === undefined
          ? contextService.create(resolved, name, content, { kind, task })
          : contextService.replace(resolved, name, content, expectedRevision, expectedContentHash!, { kind, task });
        return json(result);
      },
    }),
    hive_context_append: tool({
      description: 'Append to managed context.',
      args: { name: tool.schema.string(), content: tool.schema.string(), section: tool.schema.string().optional(), task: tool.schema.string().optional(), expectedRevision: tool.schema.number(), expectedContentHash: tool.schema.string(), scope: tool.schema.enum(['feature', 'project']).optional(), feature: tool.schema.string().optional() },
      execute: async ({ name, content, section, task, expectedRevision, expectedContentHash, scope, feature }, context) => json(contextService.append(contextScope(scope, feature, context, task), name, content, expectedRevision, expectedContentHash, { section, task })),
    }),
    hive_context_archive: tool({
      description: 'Archive selected managed context.',
      args: { names: tool.schema.array(tool.schema.string()), reason: tool.schema.string(), expectedRevision: tool.schema.number(), expectedContentHashes: tool.schema.record(tool.schema.string(), tool.schema.string()), scope: tool.schema.enum(['feature', 'project']).optional(), feature: tool.schema.string().optional() },
      execute: async ({ names, reason, expectedRevision, expectedContentHashes, scope, feature }, context) => json(contextService.archiveSelected(contextScope(scope, feature, context), names, reason, expectedRevision, expectedContentHashes)),
    }),
    hive_constraints_read: tool({
      description: 'Read session or feature constraints.',
      args: { scope: tool.schema.enum(['session', 'feature']).optional(), feature: tool.schema.string().optional() },
      execute: async (input, context) => json(readConstraints(constraintTarget(input, context as ToolContext))),
    }),
    hive_constraints_add: tool({
      description: 'Add a session or feature constraint.',
      args: { constraints: tool.schema.string(), scope: tool.schema.enum(['session', 'feature']).optional(), feature: tool.schema.string().optional() },
      execute: async ({ constraints, ...input }, context) => { const target = constraintTarget(input, context as ToolContext); return json(target.scope === 'session' ? sessionService.addStandingConstraint(target.sessionID, constraints) : featureConstraintService.add(target.feature, constraints)); },
    }),
    hive_constraints_edit: tool({
      description: 'Edit or remove a session or feature constraint.',
      args: { id: tool.schema.string(), expectedRevision: tool.schema.number(), constraints: tool.schema.string().optional(), remove: tool.schema.boolean().optional(), scope: tool.schema.enum(['session', 'feature']).optional(), feature: tool.schema.string().optional() },
      execute: async ({ id, expectedRevision, constraints, remove, ...input }, context) => {
        if ((remove === true) === (constraints !== undefined)) throw new Error('Provide exactly one of nonblank constraints or remove: true');
        if (constraints !== undefined && !constraints.trim()) throw new Error('constraints must be nonblank');
        const target = constraintTarget(input, context as ToolContext);
        const replacement = remove === true ? null : constraints!;
        return json(target.scope === 'session' ? sessionService.editStandingConstraint(target.sessionID, id, expectedRevision, replacement) : featureConstraintService.edit(target.feature, id, expectedRevision, replacement));
      },
    }),
    hive_constraints_clear: tool({
      description: 'Clear session or feature constraints.',
      args: { expectedRevision: tool.schema.number(), scope: tool.schema.enum(['session', 'feature']).optional(), feature: tool.schema.string().optional() },
      execute: async ({ expectedRevision, ...input }, context) => { const target = constraintTarget(input, context as ToolContext); return json(target.scope === 'session' ? sessionService.clearStandingConstraints(target.sessionID, expectedRevision) : featureConstraintService.clear(target.feature, expectedRevision)); },
    }),
    hive_status: tool({
      description: 'Get feature status from task, dependency, and worktree state.',
      args: { feature: tool.schema.string().optional() },
      execute: async ({ feature }, context) => {
        const selected = requireFeature(feature, context);
        const tasks = taskService.list(selected);
        const graph = computeRunnableAndBlocked(tasks.map((task) => ({ folder: task.folder, status: task.status, dependsOn: taskService.getRawStatus(selected, task.folder)?.dependsOn ?? [] })));
        const worktrees = await worktreeService.list(selected);
        return json({ feature: featureService.getInfo(selected), tasks, runnable: graph.runnable, blocked: graph.blocked, worktrees });
      },
    }),
    hive_git_snapshot: tool({
      description: 'Capture a validated Git snapshot, optionally from an explicit foreign Git root.',
      args: { directory: tool.schema.string().optional(), repositoryIds: tool.schema.array(tool.schema.string()).optional(), baseRef: tool.schema.string().optional(), targetRef: tool.schema.string().optional(), range: tool.schema.string().optional(), paths: tool.schema.array(tool.schema.string()).optional(), maxFiles: tool.schema.number().optional(), maxPatchBytes: tool.schema.number().optional() },
      execute: async ({ directory: sourceDirectory, repositoryIds, ...snapshot }) => {
        try {
        if (sourceDirectory !== undefined) {
          if (repositoryIds !== undefined) throw new Error('directory cannot be combined with repositoryIds');
          if (!path.isAbsolute(sourceDirectory)) throw new Error('directory must be absolute');
          const root = fs.realpathSync(sourceDirectory);
          if (!(await isExactGitTopLevel(root))) throw new Error('directory must be an exact Git top-level');
          if (await readCompositeWorkspaceManifest(root)) throw new Error('Foreign directory snapshots do not consume a Hive manifest');
          return json({ schema: 'hive-git-snapshot/v1', status: 'ready', consistency: 'validated', snapshots: [{ repositoryId: 'root', snapshot: await inspectGitSnapshot(root, snapshot) }] });
        }
        if (repositoryIds !== undefined && !hasManifest()) throw new Error('repositoryIds require a repository manifest');
        if (repositoryIds !== undefined && repositoryIds.length === 0) throw new Error('repositoryIds must not be empty');
        if (repositoryIds !== undefined && new Set(repositoryIds).size !== repositoryIds.length) throw new Error('repositoryIds must not contain duplicates');
        const available = hasManifest() ? repositoryResolver() : [{ id: 'root', root: projectRoot, path: projectRoot } as any];
        const availableIds = new Set(available.map((repo) => repo.id));
        const unknown = repositoryIds?.filter((id) => !availableIds.has(id)) ?? [];
        if (unknown.length) throw new Error(`Unknown repositoryIds: ${unknown.join(', ')}`);
        const repositories = repositoryIds === undefined ? available : available.filter((repo) => repositoryIds.includes(repo.id));
        if (repositories.length > MAX_SNAPSHOT_REPOSITORIES) throw new Error(`Snapshot repository count exceeds ${MAX_SNAPSHOT_REPOSITORIES}`);
        const outcomes = await Promise.all(repositories.map(async (repo) => {
          try { return { repositoryId: repo.id, snapshot: await inspectGitSnapshot(repo.root ?? repo.path, snapshot) }; }
          catch (error) { return { repositoryId: repo.id, error: snapshotFailure(error, repo.id) }; }
        }));
        const failures = outcomes.filter((outcome): outcome is { repositoryId: string; error: ReturnType<typeof snapshotFailure> } => 'error' in outcome);
        if (failures.length) return json({ schema: 'hive-git-snapshot/v1', status: 'failed', consistency: 'failed', failures: failures.map(({ error }) => error) });
        const snapshots = outcomes;
        return json({ schema: 'hive-git-snapshot/v1', status: 'ready', consistency: 'validated', snapshots });
        } catch (error) {
          return json({ schema: 'hive-git-snapshot/v1', status: 'failed', consistency: 'failed', failures: [snapshotFailure(error)] });
        }
      },
    }),
  };

  let runtimeCommandAgents: Record<string, HiveCommandAgentDescriptor> = {};
  const createCommandContext = (): HiveCommandContext => ({
    agentMode: configService.get().agentMode ?? 'dedicated',
    backgroundGuidance: { available: isBackgroundSubagentsExperimentEnabled(), reason: isBackgroundSubagentsExperimentEnabled() ? undefined : 'experiment-disabled' } as any,
    council: configService.get().council ?? DEFAULT_COUNCIL_CONFIG,
    agents: runtimeCommandAgents,
    dashReviewLanes: Object.entries(runtimeCommandAgents).filter(([, value]) => ['code-reviewer', 'simplicity-reviewer', 'approach-advisor'].includes(value.baseAgent)).map(([name, value]) => ({ taskTarget: name, sourceAgent: name, baseAgent: value.baseAgent as any, description: value.description, model: value.model, variant: value.variant })),
    vulnerabilityReviewLanes: Object.entries(runtimeCommandAgents).filter(([, value]) => value.baseAgent === 'vulnerability-reviewer').map(([name, value]) => ({ taskTarget: name, sourceAgent: name, role: 'specialist' as const, description: value.description, model: value.model, variant: value.variant })),
  });

  return {
    mcp: createBuiltinMcps(configService.getDisabledMcps()),
    tool: tools,
    command: buildHiveCommandMap(hiveCommandRenderers, createCommandContext),
    event: async (input) => {
      const binding = taskChildBinding(input.event);
      if (binding) {
        try { bindChildSnapshot(binding); }
        catch (error) { console.warn(`[hive:routing] child snapshot conflict for ${binding.child}: ${(error as Error).message}`); }
      }
      await backgroundAdapter.event(input);
    },
    'chat.message': (async (input, output) => {
      const agent = (input as { agent?: string }).agent ?? output.message.agent;
      if (agent) {
        runtimeSessionAgents.set(input.sessionID, agent);
        sessionService.trackGlobal(input.sessionID, { agent, projectRoot });
      }
      await createVariantHook(configService)(input, output);
    }) as any,
    'experimental.chat.system.transform': async (input, output) => {
      const agent = (input as { agent?: string }).agent ?? (input.sessionID ? runtimeSessionAgents.get(input.sessionID) : undefined);
      const prompt = agent ? runtimeAgentPrompts.get(agent) : undefined;
      if (!prompt) return;
      const suffix = input.sessionID && runtimeTaskChildren.has(input.sessionID) ? SUBAGENT_CLARIFICATION_PROMPT : '';
      output.system[0] = `${output.system[0] ?? ''}\n\n${prompt}${suffix}`;
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      const sessionID = output.messages?.[0]?.info?.sessionID;
      if (!sessionID) return;
      await backgroundAdapter['experimental.chat.messages.transform'](_input, output);
      await injectTaskTraceHint(output.messages, async (childID, parentID) => {
        const response = await ctx.client.session.get({ path: { id: childID }, query: { directory: projectRoot } }).catch(() => ({ data: undefined }));
        return response.data?.parentID === parentID;
      }, taskTraceHintIDs);
    },
    'tool.execute.before': async (input, output) => {
      if (input.tool === 'task' && input.sessionID && input.callID) {
        const snapshot = captureRoute(input.sessionID);
        dispatchSnapshots.set(`${input.sessionID}\0${input.callID}`, snapshot);
        const prompt = typeof output.args?.prompt === 'string' ? output.args.prompt : '';
        output.args.prompt = `${prompt}${prompt ? '\n\n' : ''}${routeFooter(snapshot)}`;
      }
      await backgroundAdapter['tool.execute.before'](input, output);
      if (!shouldExecuteHook('tool.execute.before', configService, {}, { safetyCritical: true }) || input.tool !== 'bash') return;
      const sandbox = configService.getSandboxConfig();
      const command = output.args?.command?.trim();
      if (sandbox.mode === 'none' || !command) return;
      if (/^HOST:\s*/i.test(command)) { output.args.command = command.replace(/^HOST:\s*/i, ''); return; }
      const workdir = output.args?.workdir;
      if (typeof workdir === 'string' && workdir.startsWith(path.join(projectRoot, '.hive', '.worktrees'))) {
        output.args.command = DockerSandboxService.wrapCommand(workdir, command, sandbox);
        output.args.workdir = undefined;
      }
    },
    'tool.execute.after': async (input, output) => {
      await backgroundAdapter['tool.execute.after'](input, output);
      const child = input.tool === 'task' ? (output?.metadata as any)?.sessionId : undefined;
      if (typeof child === 'string' && input.callID) {
        const binding = { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: input.sessionID, callID: input.callID, metadata: { sessionId: child }, state: { input: input.args } } } };
        const parsed = taskChildBinding(binding);
        if (parsed) {
          try { bindChildSnapshot(parsed); }
          catch (error) { console.warn(`[hive:routing] child snapshot conflict for ${parsed.child}: ${(error as Error).message}`); }
        }
      }
    },
    config: async (opencodeConfig) => {
      const mutableConfig = opencodeConfig as any;
      configService.init();
      const existingSkills = typeof mutableConfig.skills === 'object' && mutableConfig.skills ? mutableConfig.skills : {};
      const prepared = await prepareNativeHiveSkills({ directory: projectRoot, worktree: workTarget, disableSkills: configService.getDisabledSkills(), opencodeConfig: { skills: existingSkills } });
      mutableConfig.skills = { ...existingSkills, paths: prepared.skillPaths };
      mutableConfig.subagent_depth = 2;
      const falseTools = (allowed: string[]) => Object.fromEntries(HIVE_TOOL_NAMES.filter((name) => !allowed.includes(name)).map((name) => [name, false]));
      const contextRW = ['hive_context_read', 'hive_context_write', 'hive_context_append'];
      const primaryTools = [...HIVE_TOOL_NAMES];
      const featureTools = ['hive_feature_create', 'hive_feature_select', 'hive_feature_complete'];
      const planningTools = ['hive_plan_write', 'hive_plan_patch', 'hive_plan_read', 'hive_plan_approve', 'hive_tasks_sync', 'hive_task_create', 'hive_task_update'];
      const constraintTools = ['hive_constraints_read', 'hive_constraints_add', 'hive_constraints_edit', 'hive_constraints_clear'];
      const repositoryTools = ['hive_repositories_status', 'hive_repositories_discover', 'hive_repositories_update'];
      const taskWorktreeTools = ['hive_worktree_create', 'hive_worktree_inspect', 'hive_worktree_merge', 'hive_worktree_cleanup'];
      const adHocWorktreeTools = ['hive_adhoc_worktree_create', 'hive_adhoc_worktree_inspect', 'hive_adhoc_worktree_merge', 'hive_adhoc_worktree_cleanup'];
      const reviewTools = [...contextRW, 'hive_git_snapshot'];
      const custom = configService.getCustomAgentConfigs();
      const mk = (name: string, prompt: string, mode: 'primary' | 'subagent' | 'all', allowed: string[], permission: Record<string, any> = {}) => {
        const settings = configService.getAgentConfig(name);
        const fullPrompt = `${prompt}${HIVE_SYSTEM_PROMPT}`;
        runtimeAgentPrompts.set(name, fullPrompt);
        return { model: settings.model, variant: settings.variant, temperature: settings.temperature, mode, prompt: fullPrompt, tools: falseTools(allowed), permission };
      };
      const agents: Record<string, any> = {
        'hive-master': mk('hive-master', QUEEN_BEE_PROMPT, 'primary', primaryTools, { question: 'allow', task: 'allow', skill: 'allow' }),
        'architect-planner': mk('architect-planner', ARCHITECT_BEE_PROMPT, 'all', [...featureTools, ...planningTools, ...constraintTools, ...repositoryTools, ...contextRW, 'hive_context_archive', 'hive_worktree_create', 'hive_worktree_inspect', 'hive_status', 'hive_git_snapshot'], { question: 'allow', task: 'allow', edit: 'deny', skill: 'allow' }),
        'swarm-orchestrator': mk('swarm-orchestrator', SWARM_BEE_PROMPT, 'primary', primaryTools, { question: 'allow', task: 'allow', skill: 'allow' }),
        'hive-builder': mk('hive-builder', HIVE_BUILDER_PROMPT, 'primary', primaryTools, { question: 'allow', task: 'allow', skill: 'allow' }),
        'scout-researcher': mk('scout-researcher', SCOUT_BEE_PROMPT, 'subagent', ['hive_context_read', 'hive_status', 'hive_git_snapshot', 'hive_repositories_status', 'hive_repositories_discover'], { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'forager-worker': mk('forager-worker', FORAGER_BEE_PROMPT, 'subagent', ['hive_plan_read', ...contextRW, 'hive_task_update', ...taskWorktreeTools, 'hive_status'], { question: 'deny', task: 'deny', skill: 'allow' }),
        'hive-helper': mk('hive-helper', HIVE_HELPER_PROMPT, 'subagent', ['hive_task_update', ...taskWorktreeTools.slice(1), ...adHocWorktreeTools.slice(1), 'hive_status'], { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'plan-reviewer': mk('plan-reviewer', PLAN_REVIEWER_PROMPT, 'subagent', ['hive_plan_read', ...reviewTools, 'hive_status'], { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'code-reviewer': mk('code-reviewer', CODE_REVIEWER_PROMPT, 'subagent', reviewTools, { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'simplicity-reviewer': mk('simplicity-reviewer', SIMPLICITY_REVIEWER_PROMPT, 'subagent', reviewTools, { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'approach-advisor': mk('approach-advisor', APPROACH_ADVISOR_PROMPT, 'subagent', reviewTools, { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'vulnerability-reviewer': mk('vulnerability-reviewer', VULNERABILITY_REVIEWER_PROMPT, 'subagent', reviewTools, { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'dash-reviewer': mk('dash-reviewer', DASH_REVIEWER_PROMPT, 'primary', [...reviewTools, 'hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel'], { edit: 'deny', question: 'allow', task: 'allow', skill: 'allow' }),
        'vulnerability-review-primary': mk('vulnerability-review-primary', VULNERABILITY_REVIEW_PRIMARY_PROMPT, 'primary', [...reviewTools, 'hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel'], { edit: 'deny', question: 'allow', task: 'allow', skill: 'allow' }),
      };
      const customAgents = buildCustomSubagents({ customAgents: custom, baseAgents: agents, baseRuntimePrompts: {}, autoLoadSkillAppendices: {}, registerRuntimePrompt: (name, prompt) => runtimeAgentPrompts.set(name, prompt) });
      Object.assign(agents, customAgents);
      runtimeCommandAgents = Object.fromEntries(Object.entries(agents).map(([name, value]) => [name, { baseAgent: custom[name]?.baseAgent ?? name, available: true, description: custom[name]?.description ?? value.description ?? 'Registered Hive agent', readOnlyCouncilEligible: isReadOnlyCouncilEligibleBase(custom[name]?.baseAgent ?? name), model: value.model, variant: value.variant }]));
      mutableConfig.agent = { ...(mutableConfig.agent ?? {}), ...agents, [TASK_TRACE_SUMMARIZER_AGENT]: { mode: 'primary', hidden: true, tools: { '*': false }, permission: { '*': 'deny' }, prompt: 'Summarize only supplied non-reasoning session evidence as strict JSON.' } };
      const commandConfig = Object.fromEntries(await Promise.all(HIVE_COMMANDS.map(async (command) => [command.key, { description: command.description, ...('agent' in command ? { agent: command.agent } : {}), template: await hiveCommandRenderers[command.key]('$ARGUMENTS', createCommandContext()) }])));
      mutableConfig.command = { ...(mutableConfig.command ?? {}), ...commandConfig };
      mutableConfig.default_agent = configService.get().agentMode === 'unified' ? 'hive-master' : 'architect-planner';
      mutableConfig.mcp = { ...(mutableConfig.mcp ?? {}), ...createBuiltinMcps(configService.getDisabledMcps()) };
      const experimental = typeof mutableConfig.experimental === 'object' && mutableConfig.experimental ? mutableConfig.experimental : {};
      mutableConfig.experimental = { ...experimental, primary_tools: [...new Set([...(experimental.primary_tools ?? []), 'question'])] };
    },
  };
};

export default plugin;
