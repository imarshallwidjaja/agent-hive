import { DEFAULT_COUNCIL_CONFIG, type ConfigService, type CustomAgentBase, type ResolvedCustomAgentConfig } from 'hive-core';
import { renderQueenBeePrompt, hiveBeeAgent } from '../agents/hive.js';
import { renderArchitectBeePrompt, architectBeeAgent } from '../agents/architect.js';
import { renderSwarmBeePrompt, swarmBeeAgent } from '../agents/swarm.js';
import { renderScoutBeePrompt } from '../agents/scout.js';
import { FORAGER_BEE_PROMPT } from '../agents/forager.js';
import { INVESTIGATOR_PROMPT } from '../agents/investigator.js';
import { renderHiveHelperPrompt, hiveHelperAgent } from '../agents/hive-helper.js';
import { renderHiveBuilderPrompt, hiveBuilderAgent } from '../agents/hive-builder.js';
import { renderPlanReviewerPrompt } from '../agents/plan-reviewer.js';
import { renderCodeReviewerPrompt } from '../agents/code-reviewer.js';
import { renderSimplicityReviewerPrompt } from '../agents/simplicity-reviewer.js';
import { renderApproachAdvisorPrompt } from '../agents/approach-advisor.js';
import { renderVulnerabilityReviewerPrompt } from '../agents/vulnerability-reviewer.js';
import { renderDashReviewerPrompt } from '../agents/dash-reviewer.js';
import { renderVulnerabilityReviewPrimaryPrompt } from '../agents/vulnerability-review-primary.js';
import { buildCustomSubagents, type RuntimeSubagentConfig } from '../agents/custom-agents.js';
import { isReadOnlyCouncilEligibleBase } from '../commands/council.js';
import type { HiveCommandAgentDescriptor, HiveCommandContext } from '../commands/types.js';
import { renderAutoLoadSkillsAppendix, renderHiveSystemPrompt } from '../hooks/system-hook.js';
import { renderBackgroundFirstOrchestrationAppendix, resolveBackgroundDelegationAvailability } from '../utils/background-gate.js';
import { renderSkillNameLookup, type HostProfile, type NativeSkillIdentity } from './host-profile.js';
import { ROUTING_BASES, agentPermission, createRolePolicy, type BuiltInRole } from './role-policy.js';

const BACKGROUND_DELEGATION_SKILL_ID = 'background-delegation';

/**
 * The one skill every Hive role is asked to load, ahead of its configured names. It is added where guidance is
 * composed, not to the shipped agent defaults, so private review primaries and every custom agent share it and
 * `agents.<name>.autoLoadSkills` keeps meaning "extra names".
 */
export const UNIVERSAL_AUTO_LOAD_SKILL = 'unslop';

/** One registered Hive agent as both hosts describe it before translating to their own configuration shape. */
export type HiveAgentEntry = Omit<RuntimeSubagentConfig, 'mode'> & {
  mode: 'primary' | 'subagent' | 'all';
  hidden?: boolean;
  permission: NonNullable<RuntimeSubagentConfig['permission']>;
};

/**
 * Every Hive agent with its composed instructions, for one host. `prompt` is the agent's own prompt; agents
 * without one carry their instructions in `requestPrompts`, which the host adds at request time on top of its
 * default prompt (v1 parity for the orchestrators and Forager).
 */
export type RoleCatalog = {
  agents: Record<string, HiveAgentEntry>;
  requestPrompts: Map<string, string>;
  commandAgents: Record<string, HiveCommandAgentDescriptor>;
  customAgents: Record<string, ResolvedCustomAgentConfig>;
  defaultAgent: 'hive-master' | 'architect-planner';
  /**
   * The auto-load and background-delegation guidance one agent gets for the skills a host offers. Prompts built
   * without skills omit it, so a host that learns its skill catalog later adds it itself, once per request.
   */
  skillGuidance(agent: string, skills: SkillLookups, warn?: Warn): string;
};

/**
 * The skills a host can offer, by name. A host that discovers skills on the filesystem passes the materializer's
 * result; one that has a live skill catalog passes that catalog, so guidance follows what the agent can load.
 */
export type SkillLookups = {
  nativeSkillsByName: ReadonlyMap<string, NativeSkillIdentity>;
  nativeSkillsById?: ReadonlyMap<string, NativeSkillIdentity>;
  ambiguousNames?: ReadonlyMap<string, readonly string[]>;
  skillsByName: ReadonlyMap<string, NativeSkillIdentity>;
  skipped: ReadonlyArray<{ name: string; reason: string }>;
};

type Warn = (message: string) => void;

/**
 * `implicit` names are requirements Hive adds itself, so they resolve by exact skill name only. A name the operator
 * configured may also be an exact catalog id, because the operator chose that entry.
 */
function buildAutoLoadSkillsPromptAppendix(host: HostProfile, agentName: string, configured: readonly string[], skills: SkillLookups, warn: Warn, implicit: readonly string[] = []): string {
  const skipped = new Map(skills.skipped.map((entry) => [entry.name, entry]));
  const names = [...new Set([...implicit, ...configured])].flatMap((skillId) => {
    const ambiguous = skills.ambiguousNames?.get(skillId);
    const byId = configured.includes(skillId) ? skills.nativeSkillsById?.get(skillId) : undefined;
    const skill = skills.nativeSkillsByName.get(skillId) ?? byId ?? skills.skillsByName.get(skillId);
    if (!ambiguous && skill) return [skill];
    // An operator who disables the universal skill has chosen; repeating that for every role would only be noise.
    if (!ambiguous && skillId === UNIVERSAL_AUTO_LOAD_SKILL && skipped.get(skillId)?.reason === 'disabled') return [];
    const reason = ambiguous ? `multiple user skills share this name (ids: ${ambiguous.join(', ')}); specify an exact catalog id`
      : skipped.get(skillId)?.reason === 'disabled'
      ? 'it is disabled in Hive config'
      : skipped.get(skillId)?.reason === 'url-scan-incomplete'
        ? 'configured skills URLs could not be fully scanned for conflicts during this config-hook run'
        : 'it was not found in OpenCode native skill discovery or eligible Hive bundled skills';
    warn(`[hive] Auto-load skill "${skillId}" was not added to guidance for agent "${agentName}" because ${reason}.`);
    return [];
  });
  return renderAutoLoadSkillsAppendix(host, names);
}

function buildBackgroundDelegationPromptAppendix(host: HostProfile, agentName: string, skills: SkillLookups, warn: Warn): string {
  const skipped = new Map(skills.skipped.map((entry) => [entry.name, entry]));
  const availability = resolveBackgroundDelegationAvailability(skills.nativeSkillsByName, skills.skillsByName, skipped, host);
  if (availability.available) return renderBackgroundFirstOrchestrationAppendix(host);
  if (availability.reason === 'experiment-disabled') return '';
  const reason = availability.reason === 'skill-disabled'
    ? `skill "${BACKGROUND_DELEGATION_SKILL_ID}" is disabled in Hive config`
    : availability.reason === 'url-scan-incomplete'
      ? 'configured skills URLs could not be fully scanned for conflicts during this config-hook run'
      : `skill "${BACKGROUND_DELEGATION_SKILL_ID}" was not found in OpenCode native skill discovery or eligible Hive bundled skills`;
  warn(`[hive] Background delegation guidance was not advertised for agent "${agentName}" because ${reason}.`);
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

/** Agents whose instructions are added at request time instead of replacing the host's default prompt. */
const REQUEST_PROMPT_AGENTS = new Set<BuiltInRole>(['hive-master', 'swarm-orchestrator', 'hive-builder', 'forager-worker', 'forager-investigator']);

/** Whether each built-in role's instructions carry background-delegation guidance; every role carries auto-load guidance. */
const SKILL_GUIDANCE: Record<BuiltInRole, { background: boolean }> = {
  'hive-master': { background: true },
  'architect-planner': { background: true },
  'swarm-orchestrator': { background: true },
  'hive-builder': { background: true },
  'scout-researcher': { background: false },
  'forager-worker': { background: false },
  'forager-investigator': { background: false },
  'hive-helper': { background: false },
  'plan-reviewer': { background: false },
  'code-reviewer': { background: false },
  'simplicity-reviewer': { background: false },
  'approach-advisor': { background: false },
  'vulnerability-reviewer': { background: false },
  'dash-reviewer': { background: false },
  'vulnerability-review-primary': { background: false },
};

/**
 * Composes every Hive role and configured custom agent for one host profile from the global Hive configuration.
 * With `skills`, each prompt carries its skill guidance (v1, which knows its skills when it builds). Without
 * them the prompts omit it and the host adds `skillGuidance` once it can see its skill catalog.
 */
export function buildRoleCatalog(host: HostProfile, configService: ConfigService, skills?: SkillLookups): RoleCatalog {
  const systemPrompt = renderHiveSystemPrompt(host);
  const custom = configService.getCustomAgentConfigs();
  const policy = createRolePolicy(custom);
  const descriptions = Object.fromEntries(ROUTING_BASES.map((name) => [name, configService.getRoutingAgentDescription(name)])) as Record<CustomAgentBase, string>;
  const routingAppendix = (bases: readonly CustomAgentBase[]) => buildSubagentRoutingAppendix(bases, custom, descriptions);
  const skillGuidance = (agent: string, lookups: SkillLookups, warn: Warn = console.warn): string => {
    const base = (custom[agent]?.baseAgent ?? agent) as BuiltInRole;
    if (!Object.prototype.hasOwnProperty.call(SKILL_GUIDANCE, base)) return '';
    const use = SKILL_GUIDANCE[base];
    const configured = [...new Set([...(configService.getAgentConfig(base).autoLoadSkills ?? []), ...(custom[agent]?.autoLoadSkills ?? [])])];
    return renderSkillNameLookup(host, lookups.nativeSkillsByName, lookups.ambiguousNames)
      + buildAutoLoadSkillsPromptAppendix(host, agent, configured, lookups, warn, [UNIVERSAL_AUTO_LOAD_SKILL])
      + (use.background ? buildBackgroundDelegationPromptAppendix(host, agent, lookups, warn) : '');
  };
  const agentMode = configService.get().agentMode ?? 'dedicated';
  const sources: Record<BuiltInRole, { body: string; routing?: string }> = {
    'hive-master': { body: renderQueenBeePrompt(host) + systemPrompt, routing: agentMode === 'unified' ? routingAppendix(ROUTING_BASES) : '' },
    // Architect also runs delegated under unified Hive, so its helper cards do not depend on the mode.
    'architect-planner': { body: renderArchitectBeePrompt(host) + systemPrompt, routing: routingAppendix(['scout-researcher', 'forager-investigator', 'plan-reviewer', 'approach-advisor']) },
    'swarm-orchestrator': { body: renderSwarmBeePrompt(host) + systemPrompt, routing: agentMode === 'dedicated' ? routingAppendix(ROUTING_BASES) : '' },
    'hive-builder': { body: renderHiveBuilderPrompt(host) + systemPrompt, routing: routingAppendix(['scout-researcher', 'forager-worker', 'forager-investigator', 'code-reviewer', 'simplicity-reviewer']) },
    'scout-researcher': { body: renderScoutBeePrompt(host) + systemPrompt },
    'forager-worker': { body: FORAGER_BEE_PROMPT + systemPrompt },
    'forager-investigator': { body: INVESTIGATOR_PROMPT + systemPrompt },
    'hive-helper': { body: renderHiveHelperPrompt(host) + systemPrompt },
    'plan-reviewer': { body: renderPlanReviewerPrompt(host) + systemPrompt },
    'code-reviewer': { body: renderCodeReviewerPrompt(host) + systemPrompt },
    'simplicity-reviewer': { body: renderSimplicityReviewerPrompt(host) + systemPrompt },
    'approach-advisor': { body: renderApproachAdvisorPrompt(host) + systemPrompt },
    'vulnerability-reviewer': { body: renderVulnerabilityReviewerPrompt(host) + systemPrompt },
    // Review primaries choose reviewers from the command roster; the routing cards add the Investigators a runtime exercise can use.
    'dash-reviewer': { body: renderDashReviewerPrompt(host) + systemPrompt, routing: routingAppendix(['forager-investigator']) },
    'vulnerability-review-primary': { body: renderVulnerabilityReviewPrimaryPrompt(host) + systemPrompt, routing: routingAppendix(['forager-investigator']) },
  };
  const prompts = Object.fromEntries(Object.entries(sources).map(([name, { body, routing = '' }]) =>
    [name, body + (skills ? skillGuidance(name, skills) : '') + routing])) as Record<BuiltInRole, string>;
  const requestPrompts = new Map<string, string>();
  const mk = (name: BuiltInRole, mode: HiveAgentEntry['mode'], description: string): HiveAgentEntry => {
    const settings = configService.getAgentConfig(name);
    if (REQUEST_PROMPT_AGENTS.has(name)) requestPrompts.set(name, prompts[name]);
    return { ...(settings.model !== undefined ? { model: settings.model } : {}), ...(settings.variant !== undefined ? { variant: settings.variant } : {}), mode, description, ...(REQUEST_PROMPT_AGENTS.has(name) ? {} : { prompt: prompts[name] }), permission: agentPermission(policy[name]) };
  };
  const agents: Record<string, HiveAgentEntry> = {
    'hive-master': { ...mk('hive-master', 'primary', hiveBeeAgent.description), ...(agentMode !== 'unified' ? { hidden: true } : {}) },
    'architect-planner': mk('architect-planner', 'all', architectBeeAgent.description),
    'swarm-orchestrator': mk('swarm-orchestrator', 'primary', swarmBeeAgent.description),
    'hive-builder': mk('hive-builder', 'primary', hiveBuilderAgent.description),
    'scout-researcher': mk('scout-researcher', 'subagent', descriptions['scout-researcher']),
    'forager-worker': mk('forager-worker', 'subagent', descriptions['forager-worker']),
    'forager-investigator': mk('forager-investigator', 'subagent', descriptions['forager-investigator']),
    'hive-helper': mk('hive-helper', 'subagent', hiveHelperAgent.description),
    'plan-reviewer': mk('plan-reviewer', 'subagent', descriptions['plan-reviewer']),
    'code-reviewer': mk('code-reviewer', 'subagent', descriptions['code-reviewer']),
    'simplicity-reviewer': mk('simplicity-reviewer', 'subagent', descriptions['simplicity-reviewer']),
    'approach-advisor': mk('approach-advisor', 'subagent', descriptions['approach-advisor']),
    'vulnerability-reviewer': mk('vulnerability-reviewer', 'subagent', descriptions['vulnerability-reviewer']),
    'dash-reviewer': { ...mk('dash-reviewer', 'primary', 'Dash Reviewer - Read-only implementation review orchestrator.'), hidden: true },
    'vulnerability-review-primary': { ...mk('vulnerability-review-primary', 'primary', 'Private vulnerability review orchestrator.'), hidden: true },
  };
  // A custom agent's own auto-load names follow its base prompt, which already carries the base role's names and the universal skill.
  const customAutoLoad = skills ? Object.fromEntries(Object.entries(custom).map(([name, config]) => {
    const inherited = configService.getAgentConfig(config.baseAgent).autoLoadSkills ?? [];
    return [name, buildAutoLoadSkillsPromptAppendix(host, name, (config.autoLoadSkills ?? []).filter((skill) => skill !== UNIVERSAL_AUTO_LOAD_SKILL && !inherited.includes(skill)), skills, console.warn)];
  })) : {};
  const customAgents = buildCustomSubagents({
    customAgents: custom,
    baseAgents: agents as Record<string, RuntimeSubagentConfig>,
    baseRuntimePrompts: { 'forager-worker': prompts['forager-worker'], 'forager-investigator': prompts['forager-investigator'] },
    autoLoadSkillAppendices: customAutoLoad,
    registerRuntimePrompt: (name, prompt) => requestPrompts.set(name, prompt),
  });
  Object.assign(agents, customAgents);
  const commandAgents = Object.fromEntries(Object.entries(agents).map(([name, value]) => [name, { baseAgent: custom[name]?.baseAgent ?? name, available: true, description: custom[name]?.description ?? value.description ?? 'Registered Hive agent', readOnlyCouncilEligible: isReadOnlyCouncilEligibleBase(custom[name]?.baseAgent ?? name), model: value.model, variant: value.variant }]));
  return { agents, requestPrompts, commandAgents, customAgents: custom, defaultAgent: agentMode === 'unified' ? 'hive-master' : 'architect-planner', skillGuidance };
}

/**
 * What a command renders against when it is invoked: the host, the current agent descriptors and the Hive
 * configuration read at invocation time, so a command routes to the agents registered now rather than at startup.
 */
export function createCommandContext(input: {
  host: HostProfile;
  configService: ConfigService;
  agents: Record<string, HiveCommandAgentDescriptor>;
  backgroundGuidance: HiveCommandContext['backgroundGuidance'];
}): HiveCommandContext {
  const { host, configService, agents, backgroundGuidance } = input;
  return {
    host,
    agentMode: configService.get().agentMode ?? 'dedicated',
    backgroundGuidance,
    council: configService.get().council ?? DEFAULT_COUNCIL_CONFIG,
    agents,
    dashReviewLanes: Object.entries(agents).filter(([, value]) => value.available && ['code-reviewer', 'simplicity-reviewer', 'approach-advisor'].includes(value.baseAgent)).map(([name, value]) => ({ taskTarget: name, sourceAgent: name, baseAgent: value.baseAgent as any, description: value.description, model: value.model, variant: value.variant })),
    vulnerabilityReviewLanes: Object.entries(agents).filter(([, value]) => value.available && value.baseAgent === 'vulnerability-reviewer').map(([name, value]) => ({ taskTarget: name, sourceAgent: name, role: 'specialist' as const, description: value.description, model: value.model, variant: value.variant })),
  };
}
