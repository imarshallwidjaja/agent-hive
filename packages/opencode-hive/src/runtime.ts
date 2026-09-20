import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
  type AdhocMergeOptions,
  type MergeOptions,
  type ResolvedCustomAgentConfig,
  type StandingConstraintEntry,
} from 'hive-core';
import { QUEEN_BEE_PROMPT, hiveBeeAgent } from './agents/hive.js';
import { ARCHITECT_BEE_PROMPT, architectBeeAgent } from './agents/architect.js';
import { SWARM_BEE_PROMPT, swarmBeeAgent } from './agents/swarm.js';
import { SCOUT_BEE_PROMPT } from './agents/scout.js';
import { FORAGER_BEE_PROMPT } from './agents/forager.js';
import { HIVE_HELPER_PROMPT, hiveHelperAgent } from './agents/hive-helper.js';
import { HIVE_BUILDER_PROMPT, hiveBuilderAgent } from './agents/hive-builder.js';
import { PLAN_REVIEWER_PROMPT } from './agents/plan-reviewer.js';
import { CODE_REVIEWER_PROMPT } from './agents/code-reviewer.js';
import { SIMPLICITY_REVIEWER_PROMPT } from './agents/simplicity-reviewer.js';
import { APPROACH_ADVISOR_PROMPT } from './agents/approach-advisor.js';
import { VULNERABILITY_REVIEWER_PROMPT } from './agents/vulnerability-reviewer.js';
import { DASH_REVIEWER_PROMPT } from './agents/dash-reviewer.js';
import { VULNERABILITY_REVIEW_PRIMARY_PROMPT } from './agents/vulnerability-review-primary.js';
import { buildCustomSubagents } from './agents/custom-agents.js';
import {
  prepareNativeHiveSkills,
  type PreparedHiveSkill,
  type PreparedNativeHiveSkills,
  type PreparedNativeSkill,
} from './skills/native-materializer.js';
import { createBackgroundJobAdapter } from './background/backgroundJobAdapter.js';
import { createBackgroundTools } from './background/backgroundTools.js';
import { isBackgroundSubagentsExperimentEnabled, resolveBackgroundDelegationAvailability } from './utils/background-gate.js';
import { GitSnapshotError, inspectGitSnapshot, isExactGitTopLevel } from './utils/git-snapshot.js';
import { HIVE_SYSTEM_PROMPT, SUBAGENT_CLARIFICATION_PROMPT } from './hooks/system-hook.js';
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
const BACKGROUND_DELEGATION_SKILL_ID = 'background-delegation';
const targetIdentitySchema = tool.schema.object({
  path: tool.schema.string(),
  ref: tool.schema.string().nullable(),
  commit: tool.schema.string(),
});

function normalizeMergePins(
  inspected: { commit: string; repos?: Record<string, { commit: string }> },
  sourceCommit: string | undefined,
  sourceCommits: Record<string, string> | undefined,
): { sourceCommit?: string; sourceCommits?: Record<string, string> } {
  if (sourceCommit !== undefined && sourceCommits !== undefined) throw new Error('sourceCommit and sourceCommits cannot both be supplied');

  if (!inspected.repos) {
    if (sourceCommits !== undefined) throw new Error('sourceCommits require a composite candidate');
    if (sourceCommit !== undefined && sourceCommit !== inspected.commit) throw new Error('sourceCommit does not match the inspected candidate');
    return { sourceCommit: sourceCommit ?? inspected.commit };
  }

  const actualPins = Object.fromEntries(Object.entries(inspected.repos).map(([id, repo]) => [id, repo.commit]));
  const samePins = sourceCommits === undefined
    || JSON.stringify(Object.entries(sourceCommits).sort()) === JSON.stringify(Object.entries(actualPins).sort());
  if (sourceCommit !== undefined) {
    const repoIds = Object.keys(actualPins);
    if (repoIds.length !== 1) throw new Error('sourceCommit cannot select a composite candidate');
    const repoId = repoIds[0]!;
    if (sourceCommit !== actualPins[repoId]) throw new Error('sourceCommit does not match the inspected candidate');
    return { sourceCommits: { [repoId]: sourceCommit } };
  }
  if (!samePins) throw new Error('sourceCommits must exactly match every inspected candidate repository');
  return { sourceCommits: sourceCommits ?? actualPins };
}

function buildAutoLoadSkillsPromptAppendix(
  agentName: string,
  configService: ConfigService,
  nativeSkillsByName: Map<string, PreparedNativeSkill>,
  eligibleHiveSkills: Map<string, PreparedHiveSkill>,
  skippedHiveSkills: Map<string, PreparedNativeHiveSkills['skipped'][number]>,
  override?: string[],
): string {
  const skills = override ?? configService.getAgentConfig(agentName).autoLoadSkills ?? [];
  const names = skills.flatMap((skillId) => {
    const skill = nativeSkillsByName.get(skillId) ?? eligibleHiveSkills.get(skillId);
    if (skill) return [skill.name];
    const skipped = skippedHiveSkills.get(skillId);
    const reason = skipped?.reason === 'disabled'
      ? 'it is disabled in Hive config'
      : skipped?.reason === 'url-scan-incomplete'
        ? 'configured skills URLs could not be fully scanned for conflicts during this config-hook run'
        : 'it was not found in OpenCode native skill discovery or eligible Hive bundled skills';
    console.warn(`[hive] Auto-load skill "${skillId}" was not added to guidance for agent "${agentName}" because ${reason}.`);
    return [];
  });
  if (!names.length) return '';
  return `\n\n## Configured Auto-Load Skills\nHigh-priority instruction: load these OpenCode native skills with the \`skill\` tool before work covered by them.\n${names.map((name) => `- \`skill({ name: ${JSON.stringify(name)} })\``).join('\n')}\nFollow the loaded skill output. Skill bodies are not preloaded.`;
}

function buildBackgroundDelegationPromptAppendix(
  agentName: string,
  nativeSkillsByName: Map<string, PreparedNativeSkill>,
  eligibleHiveSkills: Map<string, PreparedHiveSkill>,
  skippedHiveSkills: Map<string, PreparedNativeHiveSkills['skipped'][number]>,
): string {
  const availability = resolveBackgroundDelegationAvailability(nativeSkillsByName, eligibleHiveSkills, skippedHiveSkills);
  if (availability.available) {
    return '\n\n## Background-First Orchestration\nOpenCode background subagents are enabled for this session. Delegation-first orchestration is the baseline; this appendix only opens background wait mode and the Hive board protocol. When this heading is present, background-delegation governs scheduling and wait mode; other loaded skills govern domain workflow and safety. Before launching or managing background lanes, load/use skill({ name: "background-delegation" }). Background mode is available only when useful unrelated foreground work can continue; otherwise use blocking. Detailed safety overrides and board protocol live in that skill. Gate-closed sessions keep normal blocking task() wait mode and must launch returned blocking task calls rather than working directly in delegated worktrees.';
  }
  if (availability.reason === 'experiment-disabled') return '';
  const reason = availability.reason === 'skill-disabled'
    ? `skill "${BACKGROUND_DELEGATION_SKILL_ID}" is disabled in Hive config`
    : availability.reason === 'url-scan-incomplete'
      ? 'configured skills URLs could not be fully scanned for conflicts during this config-hook run'
      : `skill "${BACKGROUND_DELEGATION_SKILL_ID}" was not found in OpenCode native skill discovery or eligible Hive bundled skills`;
  console.warn(`[hive] Background delegation guidance was not advertised for agent "${agentName}" because ${reason}.`);
  return '';
}

function buildSubagentRoutingAppendix(
  bases: readonly CustomAgentBase[],
  customAgents: Record<string, ResolvedCustomAgentConfig>,
  descriptions: Record<CustomAgentBase, string>,
): string {
  const custom = Object.entries(customAgents);
  if (!custom.some(([, config]) => bases.includes(config.baseAgent))) return '';
  const cards = bases.flatMap((base) => [
    `- \`${base}\` — kind: default; base: \`${base}\`; ${descriptions[base]}`,
    ...custom.filter(([, config]) => config.baseAgent === base).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, config]) => `- \`${name}\` — kind: custom overlay; base: \`${base}\`; ${config.description}`),
  ]);
  return `\n\n## Configured Custom Subagents and Built-In Defaults
Custom subagents are scoped specialists, not automatic model upgrades.
Descriptions specialize routing within the inherited base role; they do not expand that role or override its prompt boundaries.
For Scout research, decompose broad work and verify each slice fits one context window before choosing a custom Scout; capability is not a width upgrade and does not replace fan-out.
Choose autonomously the agent whose description best matches the task's domain, workflow, artifact type, or concrete review/approach risk; use the built-in base agent when no configured custom subagent is a closer fit.
Candidate-specific conditions in an individual description still apply, including a condition that the candidate may be selected only when the operator explicitly names it.
Do not choose a custom subagent only because the task is important, large, complex, or quality-sensitive.
${cards.join('\n')}`;
}

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

const ROUTE_SNAPSHOT_BLOCK = /(?:\n\n)?<!-- hive-route-snapshot:start -->(?:(?!<!-- hive-route-snapshot:(?:start|end) -->)[\s\S])*?<!-- hive-route-snapshot:end -->/g;

function escapeRouteSnapshotMarkers(text: string): string {
  return text
    .replaceAll('<!-- hive-route-snapshot:start -->', '&lt;!-- hive-route-snapshot:start -->')
    .replaceAll('<!-- hive-route-snapshot:end -->', '&lt;!-- hive-route-snapshot:end -->');
}

function routeFooter(snapshot: RouteSnapshot, separated: boolean): string {
  const payload = {
    projectRoot: snapshot.projectRoot,
    featureRoute: snapshot.hasFeatureRoute
      ? { selected: true, feature: snapshot.featureName ?? null }
      : { selected: false },
  };
  const constraints = [
    `Session constraints (revision ${snapshot.sessionConstraints.revision}):\n${escapeRouteSnapshotMarkers(snapshot.sessionConstraints.constraints || '(none)')}`,
    snapshot.featureConstraints
      ? `Feature constraints for ${JSON.stringify(snapshot.featureName)} (revision ${snapshot.featureConstraints.revision}):\n${escapeRouteSnapshotMarkers(snapshot.featureConstraints.constraints || '(none)')}`
      : 'Feature constraints: (none)',
  ].join('\n\n');
  return [
    `${separated ? '\n\n' : ''}<!-- hive-route-snapshot:start -->`,
    '## Hive route snapshot',
    `Route snapshot (JSON): ${JSON.stringify(payload)}`,
    '',
    '## Standing Constraints',
    constraints,
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
  const namedCursorSecret = randomBytes(32);
  const ephemeralSessionIDs = new Set<string>();
  const taskTraceConfig = configService.get().taskTraceSummarizer ?? { temperature: 0 };
  const configFallbackWarning = configService.getLastFallbackWarning()?.message;
  if (configFallbackWarning) {
    const message = `[hive:config] ${configFallbackWarning}`;
    const client = ctx.client as unknown as { notify?: (payload: { type: string; level: string; title: string; message: string }) => unknown; notification?: { create?: (payload: { type: string; level: string; title: string; message: string }) => unknown } };
    const notified = client.notify?.({ type: 'warning', level: 'warning', title: 'Agent Hive Config Warning', message })
      || client.notification?.create?.({ type: 'warning', level: 'warning', title: 'Agent Hive Config Warning', message });
    if (!notified) console.warn(message);
  }
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
    if (sourceDirectory && repoIds !== undefined) throw new Error('sourceDirectory cannot be combined with repoIds for a foreign checkout; omit sourceDirectory for the active project root');
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
    const featureName = requireFeature(feature, context);
    if (task !== undefined && !taskService.getRawStatus(featureName, task)) throw new Error(`Task '${task}' does not exist in feature '${featureName}'`);
    return { type: 'feature', featureName };
  };
  const captureRoute = (sessionID: string): RouteSnapshot => {
    const session = sessionService.getGlobal(sessionID);
    const hasFeatureRoute = !!session && Object.prototype.hasOwnProperty.call(session, 'featureName');
    const resolvedFeature = resolveFeature(undefined, { sessionID });
    const featureName = hasFeatureRoute ? session!.featureName : resolvedFeature;
    if (featureName !== null && featureName !== undefined) assertValidFeatureName(featureName);
    const sessionConstraints = sessionService.readStandingConstraints(sessionID);
    const featureConstraints = typeof featureName === 'string' ? featureConstraintService.read(featureName) : undefined;
    return { projectRoot, hasFeatureRoute: true, featureName, sessionConstraints, featureConstraints };
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
      execute: async ({ feature }, context) => {
        const selected = requireFeature(feature, context);
        planService.approve(selected);
        return json({ success: true, feature: selected });
      },
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
      args: { feature: tool.schema.string().optional(), task: tool.schema.string(), baseRef: tool.schema.string().optional(), repoIds: tool.schema.array(tool.schema.string()).optional(), candidate: tool.schema.string().optional() },
      execute: async ({ feature, task, baseRef, repoIds, candidate }, context) => { const selected = requireFeature(feature, context); selectFeature((context as ToolContext).sessionID, selected); assertTaskRepoIds(selected, task, repoIds); return json(await worktreeService.create(selected, task, baseRef, candidate)); },
    }),
    hive_worktree_inspect: tool({
      description: 'Inspect a task worktree.',
      args: { feature: tool.schema.string().optional(), task: tool.schema.string(), repoIds: tool.schema.array(tool.schema.string()).optional(), candidate: tool.schema.string().optional() },
      execute: async ({ feature, task, repoIds, candidate }, context) => { const selected = requireFeature(feature, context); selectFeature((context as ToolContext).sessionID, selected); assertTaskRepoIds(selected, task, repoIds); return json(await worktreeService.inspect(selected, task, candidate)); },
    }),
    hive_worktree_merge: tool({
      description: 'Merge an exact task worktree source into the current target.',
      args: {
        feature: tool.schema.string().optional(), task: tool.schema.string(), repoIds: tool.schema.array(tool.schema.string()).optional(), candidate: tool.schema.string().optional(),
        strategy: tool.schema.enum(['merge', 'squash', 'rebase']).optional(), message: tool.schema.string().optional(), preserveConflicts: tool.schema.boolean().optional(),
        cleanup: tool.schema.enum(['none', 'worktree', 'worktree+branch']).optional(), sourceCommit: tool.schema.string().optional(), sourceCommits: tool.schema.record(tool.schema.string(), tool.schema.string()).optional(),
        expectedTarget: targetIdentitySchema.optional(), expectedTargets: tool.schema.record(tool.schema.string(), targetIdentitySchema).optional(),
      },
      execute: async ({ feature, task, repoIds, candidate, strategy = 'squash', message, ...options }, context) => {
        const selected = requireFeature(feature, context);
        selectFeature((context as ToolContext).sessionID, selected);
        assertTaskRepoIds(selected, task, repoIds);
        const inspected = await worktreeService.inspect(selected, task, candidate);
        if (!inspected) throw new Error('Task worktree not found');
        const { sourceCommit, sourceCommits, ...mergeOptions } = options;
        const pins = normalizeMergePins(inspected, sourceCommit, sourceCommits);
        return json(await worktreeService.merge(selected, task, strategy, message, { ...mergeOptions, ...pins } as MergeOptions, candidate));
      },
    }),
    hive_worktree_cleanup: tool({
      description: 'Clean up a task worktree. Set discard to explicitly retire unintegrated work.',
      args: { feature: tool.schema.string().optional(), task: tool.schema.string(), repoIds: tool.schema.array(tool.schema.string()).optional(), candidate: tool.schema.string().optional(), deleteBranch: tool.schema.boolean().optional(), discard: tool.schema.boolean().optional() },
      execute: async ({ feature, task, repoIds, candidate, deleteBranch, discard }, context) => { const selected = requireFeature(feature, context); selectFeature((context as ToolContext).sessionID, selected); assertTaskRepoIds(selected, task, repoIds); return json(await worktreeService.remove(selected, task, deleteBranch, { discard }, candidate)); },
    }),
    hive_adhoc_worktree_create: tool({
      description: 'Create the matching ad-hoc Hive worktree for tracked Git writes after repository scope is resolved. An absolute sourceDirectory resolving to the active project root is treated as omitted; foreign sourceDirectory cannot be combined with repoIds.',
      args: { runId: tool.schema.string().optional(), repoIds: tool.schema.array(tool.schema.string()).optional(), sourceDirectory: tool.schema.string().optional() },
      execute: async ({ sourceDirectory, ...options }) => {
        let normalizedSourceDirectory = sourceDirectory;
        if (sourceDirectory !== undefined) {
          if (!path.isAbsolute(sourceDirectory)) throw new Error('sourceDirectory must be absolute');
          const resolvedSourceDirectory = fs.realpathSync(sourceDirectory);
          normalizedSourceDirectory = resolvedSourceDirectory === projectRoot ? undefined : resolvedSourceDirectory;
        }
        let repoIds = options.repoIds;
        if (!normalizedSourceDirectory && repoIds?.length === 1) {
          const status = repositoryManifestService.getStatus();
          if (status.mode === 'legacy-root' && repoIds[0] === status.repositories[0]?.id) repoIds = undefined;
        }
        return json(await adhocService(normalizedSourceDirectory, repoIds).create({ ...options, repoIds }));
      },
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
        expectedTarget: targetIdentitySchema.optional(), expectedTargets: tool.schema.record(tool.schema.string(), targetIdentitySchema).optional(),
      },
      execute: async ({ runId, repoIds, sourceDirectory, strategy = 'squash', message, ...options }) => {
        const service = adhocService(sourceDirectory, repoIds);
        const inspected = await service.inspect(runId);
        if (!inspected) throw new Error('Ad-hoc worktree not found');
        const { sourceCommit, sourceCommits, ...mergeOptions } = options;
        const pins = normalizeMergePins(inspected, sourceCommit, sourceCommits);
        return json(await service.merge(runId, strategy, message, { ...mergeOptions, ...pins } as AdhocMergeOptions));
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
      execute: async ({ name, scope, feature, view, query, limit, cursor, maxBytes, scanChars }, context) => {
        const resolved = contextScope(scope, feature, context);
        if (name) {
          if ([view, query, limit, scanChars].some((value) => value !== undefined)) throw new Error('Named context reads cannot be combined with list options');
          const scopeKey = resolved.type === 'project' ? 'project' : `feature:${resolved.featureName}`;
          let continuation: { v: 1; n: string; k: string; r: number; s: string; h: string; o: number } | undefined;
          if (cursor) {
            try {
              if (Buffer.byteLength(cursor, 'utf8') > 4_096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('encoding');
              const envelope = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { payload?: unknown; mac?: unknown };
              if (typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string') throw new Error('shape');
              const expected = createHmac('sha256', namedCursorSecret).update(envelope.payload).digest();
              const actual = Buffer.from(envelope.mac, 'hex');
              if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('integrity');
              continuation = JSON.parse(envelope.payload);
              if (continuation?.v !== 1 || continuation.n !== name || continuation.k !== scopeKey
                || !Number.isInteger(continuation.r) || !Number.isSafeInteger(continuation.o) || continuation.o <= 0
                || typeof continuation.s !== 'string' || typeof continuation.h !== 'string') throw new Error('shape');
            } catch {
              throw new ContextMutationError('stale_context_cursor', 'The named-read cursor is invalid, expired, or belongs to another document.');
            }
          }
          const budget = maxBytes ?? 16 * 1024;
          if (!Number.isInteger(budget) || budget < 256 || budget > 64 * 1024) throw new ContextMutationError('context_input_too_large', 'maxBytes must be between 256 and 65536.');
          let chunkBudget = budget - 256;
          for (;;) {
            let result;
            try {
              result = contextService.readContent(resolved, name, { offset: continuation?.o, maxBytes: Math.max(256, chunkBudget) });
            } catch (error) {
              if (continuation && (error as { reason?: string }).reason === 'invalid_argument') {
                throw new ContextMutationError('stale_context_cursor', 'The named-read cursor byte boundary is no longer valid.');
              }
              throw error;
            }
            if (continuation && (!result || result.revision !== continuation.r || result.snapshot !== continuation.s || result.file.contentHash !== continuation.h)) {
              throw new ContextMutationError('stale_context_cursor', 'Context changed between named-read chunks.');
            }
            if (!result) return json(null);
            const nextOffset = result.complete ? undefined : result.range.endByte;
            const payload = nextOffset === undefined ? undefined : JSON.stringify({ v: 1, n: name, k: scopeKey, r: result.revision, s: result.snapshot, h: result.file.contentHash, o: nextOffset });
            const nextCursor = payload === undefined ? undefined : Buffer.from(JSON.stringify({ payload, mac: createHmac('sha256', namedCursorSecret).update(payload).digest('hex') })).toString('base64url');
            const output = json({ ...result, ...(nextCursor ? { nextCursor } : {}) });
            const excess = Buffer.byteLength(output, 'utf8') - budget;
            if (excess <= 0) return output;
            chunkBudget -= excess;
            if (chunkBudget < 256) throw new ContextMutationError('context_response_too_large', 'The named-read response envelope exceeds maxBytes.');
          }
        }
        if (maxBytes !== undefined) throw new Error('maxBytes is valid only for named context reads');
        if ((view ?? 'summary') === 'summary') {
          if ([query, limit, cursor].some((value) => value !== undefined)) throw new Error('Summary view cannot be combined with catalog options');
          return json(contextService.readSummary(resolved, { scanChars }));
        }
        if (scanChars !== undefined) throw new Error('scanChars is valid only for summary view');
        return json(contextService.readCatalog(resolved, { query, limit, cursor }));
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
        return json({ feature: featureService.getInfo(selected), tasks, runnable: graph.runnable, blocked: graph.blocked, worktrees, ...(configFallbackWarning ? { warning: configFallbackWarning } : {}) });
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
      const suffix = input.sessionID && runtimeTaskChildren.has(input.sessionID) ? SUBAGENT_CLARIFICATION_PROMPT : '';
      if (!prompt && !suffix) return;
      output.system[0] = `${output.system[0] ?? ''}\n\n${prompt ?? ''}${suffix}`;
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
        const prompt = typeof output.args?.prompt === 'string'
          ? output.args.prompt.replace(ROUTE_SNAPSHOT_BLOCK, '')
          : '';
        output.args.prompt = `${prompt}${routeFooter(snapshot, prompt.length > 0)}`;
      }
      await backgroundAdapter['tool.execute.before'](input, output);
      // Retain the safety-critical cadence warning even though generic cadence gating is gone.
      configService.getHookCadence('tool.execute.before', { safetyCritical: true });
      if (input.tool !== 'bash') return;
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
      try {
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
      } finally {
        if (input.tool === 'task' && input.callID) dispatchSnapshots.delete(`${input.sessionID}\0${input.callID}`);
      }
    },
    config: async (opencodeConfig) => {
      const mutableConfig = opencodeConfig as any;
      configService.init();
      const existingSkills = typeof mutableConfig.skills === 'object' && mutableConfig.skills ? mutableConfig.skills : {};
      const prepared = await prepareNativeHiveSkills({ directory: projectRoot, worktree: workTarget, disableSkills: configService.getDisabledSkills(), opencodeConfig: { skills: existingSkills } });
      mutableConfig.skills = { ...existingSkills, paths: prepared.skillPaths };
      mutableConfig.subagent_depth = 2;
      runtimeAgentPrompts.clear();
      const falseTools = (allowed: string[]) => Object.fromEntries(HIVE_TOOL_NAMES.filter((name) => !allowed.includes(name)).map((name) => [name, false]));
      const contextRW = ['hive_context_read', 'hive_context_write', 'hive_context_append'];
      const primaryTools = [...HIVE_TOOL_NAMES];
      const constraintTools = ['hive_constraints_read', 'hive_constraints_add', 'hive_constraints_edit', 'hive_constraints_clear'];
      const repositoryTools = ['hive_repositories_status', 'hive_repositories_discover', 'hive_repositories_update'];
      const reviewTools = [...contextRW, 'hive_git_snapshot'];
      const custom = configService.getCustomAgentConfigs();
      const skipped = new Map(prepared.skipped.map((entry) => [entry.name, entry]));
      const routingBases = ['scout-researcher', 'forager-worker', 'plan-reviewer', 'code-reviewer', 'simplicity-reviewer', 'approach-advisor', 'vulnerability-reviewer'] as const;
      const descriptions = Object.fromEntries(routingBases.map((name) => [name, configService.getRoutingAgentDescription(name)])) as Record<CustomAgentBase, string>;
      const routingAppendix = (bases: readonly CustomAgentBase[]) => buildSubagentRoutingAppendix(bases, custom, descriptions);
      const autoLoadAppendix = (name: string, override?: string[]) => buildAutoLoadSkillsPromptAppendix(name, configService, prepared.nativeSkillsByName, prepared.skillsByName, skipped, override);
      const backgroundAppendix = (name: string) => buildBackgroundDelegationPromptAppendix(name, prepared.nativeSkillsByName, prepared.skillsByName, skipped);
      const architectTaskPermission = {
        '*': 'deny',
        'scout-researcher': 'allow',
        'plan-reviewer': 'allow',
        'approach-advisor': 'allow',
        ...Object.fromEntries(Object.entries(custom)
          .filter(([, config]) => ['scout-researcher', 'plan-reviewer', 'approach-advisor'].includes(config.baseAgent))
          .map(([name]) => [name, 'allow'])),
      };
      const agentMode = configService.get().agentMode ?? 'dedicated';
      const prompts: Record<string, string> = {
        'hive-master': QUEEN_BEE_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('hive-master') + backgroundAppendix('hive-master') + (agentMode === 'unified' ? routingAppendix(routingBases) : ''),
        'architect-planner': ARCHITECT_BEE_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('architect-planner') + backgroundAppendix('architect-planner') + (agentMode === 'dedicated' ? routingAppendix(['scout-researcher', 'plan-reviewer', 'approach-advisor']) : ''),
        'swarm-orchestrator': SWARM_BEE_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('swarm-orchestrator') + backgroundAppendix('swarm-orchestrator') + (agentMode === 'dedicated' ? routingAppendix(routingBases) : ''),
        'hive-builder': HIVE_BUILDER_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('hive-builder') + backgroundAppendix('hive-builder') + routingAppendix(['scout-researcher', 'forager-worker', 'code-reviewer', 'simplicity-reviewer']),
        'scout-researcher': SCOUT_BEE_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('scout-researcher'),
        'forager-worker': FORAGER_BEE_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('forager-worker'),
        'hive-helper': HIVE_HELPER_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('hive-helper'),
        'plan-reviewer': PLAN_REVIEWER_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('plan-reviewer'),
        'code-reviewer': CODE_REVIEWER_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('code-reviewer'),
        'simplicity-reviewer': SIMPLICITY_REVIEWER_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('simplicity-reviewer'),
        'approach-advisor': APPROACH_ADVISOR_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('approach-advisor'),
        'vulnerability-reviewer': VULNERABILITY_REVIEWER_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('vulnerability-reviewer'),
        'dash-reviewer': DASH_REVIEWER_PROMPT + HIVE_SYSTEM_PROMPT,
        'vulnerability-review-primary': VULNERABILITY_REVIEW_PRIMARY_PROMPT + HIVE_SYSTEM_PROMPT,
      };
      const runtimePromptAgents = new Set(['hive-master', 'swarm-orchestrator', 'hive-builder', 'forager-worker']);
      const mk = (name: string, mode: 'primary' | 'subagent' | 'all', allowed: string[], description: string, permission: Record<string, any> = {}) => {
        const settings = configService.getAgentConfig(name);
        if (runtimePromptAgents.has(name)) runtimeAgentPrompts.set(name, prompts[name]!);
        return { model: settings.model, variant: settings.variant, temperature: settings.temperature, mode, description, ...(runtimePromptAgents.has(name) ? {} : { prompt: prompts[name] }), tools: falseTools(allowed), permission };
      };
      const agents: Record<string, any> = {
        'hive-master': mk('hive-master', 'primary', primaryTools, hiveBeeAgent.description, { question: 'allow', task: 'allow', skill: 'allow' }),
        'architect-planner': mk('architect-planner', 'all', ['hive_feature_create', 'hive_feature_select', 'hive_plan_write', 'hive_plan_patch', 'hive_plan_read', ...constraintTools, ...repositoryTools, ...contextRW, 'hive_context_archive', 'hive_worktree_inspect', 'hive_status', 'hive_git_snapshot'], architectBeeAgent.description, { question: 'allow', task: architectTaskPermission, edit: 'deny', skill: 'allow' }),
        'swarm-orchestrator': mk('swarm-orchestrator', 'primary', primaryTools, swarmBeeAgent.description, { question: 'allow', task: 'allow', skill: 'allow' }),
        'hive-builder': mk('hive-builder', 'primary', primaryTools, hiveBuilderAgent.description, { question: 'allow', task: 'allow', skill: 'allow' }),
        'scout-researcher': mk('scout-researcher', 'subagent', ['hive_context_read', 'hive_status', 'hive_git_snapshot', 'hive_repositories_status', 'hive_repositories_discover'], descriptions['scout-researcher'], { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'forager-worker': mk('forager-worker', 'subagent', [...contextRW, 'hive_task_update', 'hive_worktree_create', 'hive_worktree_inspect', 'hive_status'], descriptions['forager-worker'], { question: 'deny', task: 'deny', skill: 'allow' }),
        'hive-helper': mk('hive-helper', 'subagent', ['hive_task_create', 'hive_task_update', 'hive_worktree_inspect', 'hive_worktree_merge', 'hive_worktree_cleanup', 'hive_status'], hiveHelperAgent.description, { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'plan-reviewer': mk('plan-reviewer', 'subagent', ['hive_plan_read', ...reviewTools, 'hive_status'], descriptions['plan-reviewer'], { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'code-reviewer': mk('code-reviewer', 'subagent', reviewTools, descriptions['code-reviewer'], { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'simplicity-reviewer': mk('simplicity-reviewer', 'subagent', reviewTools, descriptions['simplicity-reviewer'], { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'approach-advisor': mk('approach-advisor', 'subagent', reviewTools, descriptions['approach-advisor'], { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'vulnerability-reviewer': mk('vulnerability-reviewer', 'subagent', reviewTools, descriptions['vulnerability-reviewer'], { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' }),
        'dash-reviewer': mk('dash-reviewer', 'primary', [...reviewTools, 'hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel'], 'Dash Reviewer - Read-only implementation review orchestrator.', { edit: 'deny', question: 'allow', task: 'allow', skill: 'allow' }),
        'vulnerability-review-primary': mk('vulnerability-review-primary', 'primary', [...reviewTools, 'hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel'], 'Private vulnerability review orchestrator.', { edit: 'deny', question: 'allow', task: 'allow', skill: 'allow' }),
      };
      agents['dash-reviewer'].hidden = true;
      agents['vulnerability-review-primary'].hidden = true;
      if (agentMode !== 'unified') agents['hive-master'].hidden = true;
      const customAutoLoad = Object.fromEntries(Object.entries(custom).map(([name, config]) => {
        const inherited = configService.getAgentConfig(config.baseAgent).autoLoadSkills ?? [];
        return [name, autoLoadAppendix(name, (config.autoLoadSkills ?? []).filter((skill) => !inherited.includes(skill)))];
      }));
      const customAgents = buildCustomSubagents({
        customAgents: custom,
        baseAgents: agents,
        baseRuntimePrompts: { 'forager-worker': prompts['forager-worker'] },
        autoLoadSkillAppendices: customAutoLoad,
        registerRuntimePrompt: (name, prompt) => runtimeAgentPrompts.set(name, prompt),
      });
      Object.assign(agents, customAgents);
      runtimeCommandAgents = Object.fromEntries(Object.entries(agents).map(([name, value]) => [name, { baseAgent: custom[name]?.baseAgent ?? name, available: true, description: custom[name]?.description ?? value.description ?? 'Registered Hive agent', readOnlyCouncilEligible: isReadOnlyCouncilEligibleBase(custom[name]?.baseAgent ?? name), model: value.model, variant: value.variant }]));
      mutableConfig.agent = { ...(mutableConfig.agent ?? {}), ...agents, [TASK_TRACE_SUMMARIZER_AGENT]: { mode: 'primary', hidden: true, tools: { '*': false }, permission: { '*': 'deny' }, prompt: 'Summarize only supplied non-reasoning session evidence as strict JSON.' } };
      const commandConfig = Object.fromEntries(await Promise.all(HIVE_COMMANDS.map(async (command) => [command.key, { description: command.description, ...('agent' in command ? { agent: command.agent } : {}), template: await hiveCommandRenderers[command.key]('$ARGUMENTS', createCommandContext()) }])));
      mutableConfig.command = { ...(mutableConfig.command ?? {}), ...commandConfig };
      mutableConfig.default_agent = configService.get().agentMode === 'unified' ? 'hive-master' : 'architect-planner';
      const experimental = typeof mutableConfig.experimental === 'object' && mutableConfig.experimental ? mutableConfig.experimental : {};
      mutableConfig.experimental = { ...experimental, primary_tools: [...new Set([...(experimental.primary_tools ?? []), 'question'])] };
    },
  };
};

export default plugin;
