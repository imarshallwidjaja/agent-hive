import { tool, type Plugin } from '@opencode-ai/plugin';
import {
  DEFAULT_COUNCIL_CONFIG,
  canonicalProjectRoot,
  detectContext,
  getNativeSessionsPath,
  type ConfigService,
  type CustomAgentBase,
  type ResolvedCustomAgentConfig,
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
import { HIVE_SYSTEM_PROMPT, SUBAGENT_CLARIFICATION_PROMPT } from './hooks/system-hook.js';
import { classifySession, createVariantHook } from './hooks/variant-hook.js';
import { buildHiveCommandMap } from './commands/runtime.js';
import { HIVE_COMMANDS } from './commands/registry.js';
import { hiveCommandRenderers } from './commands/renderers.js';
import { isReadOnlyCouncilEligibleBase } from './commands/council.js';
import type { HiveCommandAgentDescriptor, HiveCommandContext } from './commands/types.js';
import { createTaskTraceTools, injectTaskTraceHint, isDirectChildSession, TASK_TRACE_SUMMARIZER_AGENT, TASK_TRACE_SUMMARIZER_PROMPT } from './task-trace.js';
import { composeTaskBrief, TASK_BRIEF_BLOCK } from './task-brief.js';
import { createHiveServices, type RouteSnapshot } from './runtime/hive-services.js';
import { createHiveOperations, presentHiveResult } from './runtime/hive-tools.js';
import { ROUTING_BASES, agentPermission, createRolePolicy, mergePrimaryOnlyTools, nativeSubagentBoundary, type BuiltInRole } from './runtime/role-policy.js';

const BACKGROUND_DELEGATION_SKILL_ID = 'background-delegation';

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
    return '\n\n## Background-First Orchestration\nThis appendix applies only when running as a primary. When Architect is task-spawned, use blocking calls for its permitted terminal planning-helper layer, including hive-helper. Child-role rules take precedence over this appendix: child sessions cannot use background board tools, so return board/control requests to the parent without loading the primary-only background-delegation skill. OpenCode background subagents are enabled for primary sessions. Delegation-first orchestration is the baseline; this appendix only opens background wait mode and the Hive board protocol. When this heading is present in a primary session, background-delegation governs scheduling and wait mode; other loaded skills govern domain workflow and safety. Before launching or managing background lanes, load/use skill({ name: "background-delegation" }). Background mode is available only when useful unrelated foreground work can continue; otherwise use blocking. Detailed safety overrides and board protocol live in that skill. Gate-closed sessions keep normal blocking task() wait mode and must launch returned blocking task calls rather than working directly in delegated worktrees.';
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

/**
 * Matches a generated route snapshot block and its separator. The start marker must open the
 * generated heading line, so an authored prompt that quotes the marker pair inline is preserved.
 */
const ROUTE_SNAPSHOT_BLOCK = /(?:\n\n)?<!-- hive-route-snapshot:start -->\n## Hive route snapshot\n(?:(?!<!-- hive-route-snapshot:(?:start|end) -->)[\s\S])*?<!-- hive-route-snapshot:end -->/g;

function escapeRouteSnapshotMarkers(text: string): string {
  return text
    .replaceAll('<!-- hive-route-snapshot:start -->', '&lt;!-- hive-route-snapshot:start -->')
    .replaceAll('<!-- hive-route-snapshot:end -->', '&lt;!-- hive-route-snapshot:end -->');
}

function routeFooter(snapshot: RouteSnapshot, separated: boolean): string {
  const payload = {
    projectRoot: snapshot.projectRoot,
    featureRoute: { selected: snapshot.hasFeatureRoute, feature: snapshot.featureName ?? null },
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

const plugin: Plugin = async (ctx) => {
  const workTarget = ctx.project?.id === 'global' && ctx.worktree === '/' ? ctx.directory : ctx.worktree || ctx.directory;
  const detected = detectContext(workTarget);
  const projectRoot = canonicalProjectRoot(detected.projectRoot);
  const runtimeId = `pid-${process.pid}-${Date.now().toString(36)}`;

  const services = createHiveServices({ projectRoot, detectedFeature: detected.feature, nativeObservationOwner: 'opencode-v1' });
  const { sessionService, contextService, taskService, configService, backgroundJobService } = services;
  const runtimeAgentPrompts = new Map<string, string>();
  const runtimeSessionAgents = new Map<string, string>();
  const runtimeTaskChildren = new Set<string>();
  const dispatchSnapshots = new Map<string, RouteSnapshot>();
  const ephemeralSessionIDs = new Set<string>();
  const taskTraceConfig = configService.get().taskTraceSummarizer ?? { temperature: 0 };
  const configFallbackWarning = services.configFallbackWarning;
  if (configFallbackWarning) {
    const message = `[hive:config] ${configFallbackWarning}`;
    const client = ctx.client as unknown as { notify?: (payload: { type: string; level: string; title: string; message: string }) => unknown; notification?: { create?: (payload: { type: string; level: string; title: string; message: string }) => unknown } };
    const notified = client.notify?.({ type: 'warning', level: 'warning', title: 'Agent Hive Config Warning', message })
      || client.notification?.create?.({ type: 'warning', level: 'warning', title: 'Agent Hive Config Warning', message });
    if (!notified) console.warn(message);
  }
  const taskTraceClient = ctx.client as unknown as Parameters<typeof createTaskTraceTools>[0]['client'];
  const taskTraceTools = createTaskTraceTools({
    client: taskTraceClient,
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

  // V1 registration: each shared operation becomes a plugin tool whose result is the operation's JSON presentation.
  const hiveTools = Object.fromEntries(Object.entries(createHiveOperations(services)).map(([name, operation]) => [name, tool({
    description: operation.description,
    args: operation.args,
    execute: async (input, context) => presentHiveResult(operation, await operation.execute(input, { sessionID: context?.sessionID })),
  })]));
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
    ...hiveTools,
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
        try {
          sessionService.trackGlobal(input.sessionID, { agent, projectRoot });
        } catch (error) {
          const reason = error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : 'unknown error';
          console.warn(`[hive:sessions] Could not track session ${input.sessionID} in ${getNativeSessionsPath(projectRoot, services.nativeObservationOwner)} (${reason}); continuing reply.`);
        }
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
      await injectTaskTraceHint(output.messages, (childID, parentID) => (
        isDirectChildSession(taskTraceClient, projectRoot, childID, parentID)
      ));
    },
    'tool.execute.before': async (input, output) => {
      if (input.tool === 'task' && input.sessionID && input.callID) {
        const snapshot = services.captureRoute(input.sessionID);
        dispatchSnapshots.set(`${input.sessionID}\0${input.callID}`, snapshot);
        const prompt = typeof output.args?.prompt === 'string'
          ? output.args.prompt.replace(ROUTE_SNAPSHOT_BLOCK, '').replace(TASK_BRIEF_BLOCK, '')
          : '';
        const agent = output.args?.subagent_type;
        const foragerDispatch = typeof agent === 'string'
          && classifySession(agent, configService.getCustomAgentConfigs()).baseAgent === 'forager-worker';
        const brief = foragerDispatch && snapshot.hasFeatureRoute && typeof snapshot.featureName === 'string'
          ? `\n\n${composeTaskBrief({ projectRoot, taskService, contextService }, snapshot.featureName, prompt)}`
          : '';
        output.args.prompt = `${prompt}${routeFooter(snapshot, prompt.length > 0)}${brief}`;
      }
      await backgroundAdapter['tool.execute.before'](input, output);
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
      const custom = configService.getCustomAgentConfigs();
      const policy = createRolePolicy(custom);
      const skipped = new Map(prepared.skipped.map((entry) => [entry.name, entry]));
      const descriptions = Object.fromEntries(ROUTING_BASES.map((name) => [name, configService.getRoutingAgentDescription(name)])) as Record<CustomAgentBase, string>;
      const routingAppendix = (bases: readonly CustomAgentBase[]) => buildSubagentRoutingAppendix(bases, custom, descriptions);
      const autoLoadAppendix = (name: string, override?: string[]) => buildAutoLoadSkillsPromptAppendix(name, configService, prepared.nativeSkillsByName, prepared.skillsByName, skipped, override);
      const backgroundAppendix = (name: string) => buildBackgroundDelegationPromptAppendix(name, prepared.nativeSkillsByName, prepared.skillsByName, skipped);
      const agentMode = configService.get().agentMode ?? 'dedicated';
      const prompts: Record<string, string> = {
        'hive-master': QUEEN_BEE_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('hive-master') + backgroundAppendix('hive-master') + (agentMode === 'unified' ? routingAppendix(ROUTING_BASES) : ''),
        'architect-planner': ARCHITECT_BEE_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('architect-planner') + backgroundAppendix('architect-planner') + (agentMode === 'dedicated' ? routingAppendix(['scout-researcher', 'plan-reviewer', 'approach-advisor']) : ''),
        'swarm-orchestrator': SWARM_BEE_PROMPT + HIVE_SYSTEM_PROMPT + autoLoadAppendix('swarm-orchestrator') + backgroundAppendix('swarm-orchestrator') + (agentMode === 'dedicated' ? routingAppendix(ROUTING_BASES) : ''),
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
      const mk = (name: BuiltInRole, mode: 'primary' | 'subagent' | 'all', description: string) => {
        const settings = configService.getAgentConfig(name);
        if (runtimePromptAgents.has(name)) runtimeAgentPrompts.set(name, prompts[name]!);
        // Config hooks run after OpenCode's deprecated tools normalization. Ordered permissions are enforced at agent construction.
        return { model: settings.model, variant: settings.variant, temperature: settings.temperature, mode, description, ...(runtimePromptAgents.has(name) ? {} : { prompt: prompts[name] }), permission: agentPermission(policy[name]) };
      };
      const agents: Record<string, any> = {
        'hive-master': mk('hive-master', 'primary', hiveBeeAgent.description),
        'architect-planner': mk('architect-planner', 'all', architectBeeAgent.description),
        'swarm-orchestrator': mk('swarm-orchestrator', 'primary', swarmBeeAgent.description),
        'hive-builder': mk('hive-builder', 'primary', hiveBuilderAgent.description),
        'scout-researcher': mk('scout-researcher', 'subagent', descriptions['scout-researcher']),
        'forager-worker': mk('forager-worker', 'subagent', descriptions['forager-worker']),
        'hive-helper': mk('hive-helper', 'subagent', hiveHelperAgent.description),
        'plan-reviewer': mk('plan-reviewer', 'subagent', descriptions['plan-reviewer']),
        'code-reviewer': mk('code-reviewer', 'subagent', descriptions['code-reviewer']),
        'simplicity-reviewer': mk('simplicity-reviewer', 'subagent', descriptions['simplicity-reviewer']),
        'approach-advisor': mk('approach-advisor', 'subagent', descriptions['approach-advisor']),
        'vulnerability-reviewer': mk('vulnerability-reviewer', 'subagent', descriptions['vulnerability-reviewer']),
        'dash-reviewer': mk('dash-reviewer', 'primary', 'Dash Reviewer - Read-only implementation review orchestrator.'),
        'vulnerability-review-primary': mk('vulnerability-review-primary', 'primary', 'Private vulnerability review orchestrator.'),
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
      const nativeAgents = Object.fromEntries((['general', 'explore'] as const).map((name) => {
        const existing = mutableConfig.agent?.[name] ?? {};
        const boundary = nativeSubagentBoundary(name, existing.permission);
        if (boundary.warning) console.warn(boundary.warning);
        return [name, { ...existing, permission: boundary.permission }];
      }));
      mutableConfig.agent = { ...(mutableConfig.agent ?? {}), ...nativeAgents, ...agents, [TASK_TRACE_SUMMARIZER_AGENT]: { mode: 'primary', hidden: true, temperature: taskTraceConfig.temperature ?? 0, permission: { '*': 'deny' }, prompt: TASK_TRACE_SUMMARIZER_PROMPT } };
      const commandConfig = Object.fromEntries(await Promise.all(HIVE_COMMANDS.map(async (command) => [command.key, { description: command.description, ...('agent' in command ? { agent: command.agent } : {}), template: await hiveCommandRenderers[command.key]('$ARGUMENTS', createCommandContext()) }])));
      mutableConfig.command = { ...(mutableConfig.command ?? {}), ...commandConfig };
      mutableConfig.default_agent = configService.get().agentMode === 'unified' ? 'hive-master' : 'architect-planner';
      const experimental = typeof mutableConfig.experimental === 'object' && mutableConfig.experimental ? mutableConfig.experimental : {};
      mutableConfig.experimental = { ...experimental, primary_tools: mergePrimaryOnlyTools(experimental.primary_tools) };
    },
  };
};

export default plugin;
