import * as path from 'node:path';
import { Effect } from 'effect';
import type { Scope } from 'effect';
import { Tool } from '@opencode/schema/tool';
import type { Agent, Plugin } from '@opencode/plugin/effect';
import type { SessionContext } from '@opencode/plugin/effect/session';
import { canonicalProjectRoot, detectContext, type ConfigService, type ResolvedCustomAgentConfig } from 'hive-core';
import { HIVE_COMMANDS } from '../commands/registry.js';
import { hiveCommandRenderers } from '../commands/renderers.js';
import { SUBAGENT_CLARIFICATION_PROMPT } from '../hooks/system-hook.js';
import type { HiveCommandAgentDescriptor } from '../commands/types.js';
import { prepareNativeHiveSkills, type PreparedNativeHiveSkills } from '../skills/native-materializer.js';
import { resolveBackgroundDelegationAvailability } from '../utils/background-gate.js';
import { createHiveServices, type HiveServices } from '../runtime/hive-services.js';
import { createHiveOperations } from '../runtime/hive-tools.js';
import { CODEMODE_READ_TOOLS, createHostProfile, type HostProfile } from '../runtime/host-profile.js';
import { buildRoleCatalog, createCommandContext, type RoleCatalog, type SkillLookups } from '../runtime/role-catalog.js';
import {
  NATIVE_LIFECYCLE_BYPASS_TOOLS,
  PRIMARY_ONLY_TOOLS,
  authorizeHiveCall,
  authorizeNativeCall,
  createRolePolicy,
  nativeCallNeedsAncestry,
  nativeSubagentBoundary,
  resolveCallerAuthority,
  toV2PermissionRules,
  type BuiltInRole,
  type CallDecision,
  type CallerAuthority,
  type RolePolicy,
} from '../runtime/role-policy.js';
import { createVerifiedReadAccess, type VerifiedReadAccess } from './client.js';
import type { Identity } from './identity.js';
import type { V2Options } from './options.js';
import { createHiveToolRegistrar, type HiveCaller, type HiveToolRegistrar } from './tools.js';

/**
 * The OpenCode v2 catalog: Hive services for the real project root, one host profile, the role catalog and its
 * guards, and the agent, skill, command, tool and request-time registrations built from them.
 *
 * Native configuration owns what the host lets users set (default agent, presentation, model and variant, limits and
 * permission visibility); Hive registers defaults for those and does not try to win them back. What Hive does own is
 * enforced at request and execution time, where user configuration cannot replace it: each Hive role's canonical
 * instructions, and which Hive operations and native effects a caller may run, judged from the caller's role and the
 * session's actual parent, never from the agent's editable mode or description.
 */
export interface V2Catalog {
  readonly services: HiveServices;
  readonly host: HostProfile;
  readonly roles: RoleCatalog;
  readonly authority: HiveAuthority;
  /** Tasks 6 and 7 register their tools here so flags and guards stay identical. */
  readonly registrar: HiveToolRegistrar;
  /** Verified, read-only access to session history on this server. */
  readonly readAccess: VerifiedReadAccess;
}

export interface HiveAuthority {
  readonly policy: Record<BuiltInRole, RolePolicy>;
  readonly customAgents: Record<string, ResolvedCustomAgentConfig>;
  resolve(agent: string): CallerAuthority;
  /** Whether the session has a native parent, read from the host. Fails when the session cannot be read. */
  isChild(sessionID: string): Effect.Effect<boolean, Tool.Error>;
  /** Guards a Hive tool call; used by every Hive executor and by the `execute.before` hook. */
  guardHive(tool: string, caller: HiveCaller): Effect.Effect<void, Tool.Error>;
  /** Guards a native tool call, including Code Mode inner calls, by the host's tool name. */
  guardNative(tool: string, toolInput: unknown, caller: HiveCaller): Effect.Effect<void, Tool.Error>;
}

export function registerCatalog(input: { context: Plugin.Context; identity: Identity; options: V2Options }): Effect.Effect<V2Catalog, never, Scope.Scope> {
  const { context, identity, options } = input;
  return Effect.gen(function* () {
    // The session's exact directory is the activation identity. Hive's state belongs to the project checkout the
    // host resolved for it, so a session opened in a subdirectory shares the checkout's `.hive`, manifest and
    // constraints instead of starting its own, and a Hive task worktree maps back to its feature.
    const workTarget = context.location.project.directory;
    const detected = detectContext(workTarget);
    const projectRoot = canonicalProjectRoot(detected.projectRoot);
    const services = createHiveServices({ projectRoot, detectedFeature: detected.feature, nativeObservationOwner: 'opencode-v2' });
    const { configService } = services;
    if (services.configFallbackWarning) console.warn(`[hive:config] ${services.configFallbackWarning}`);
    const host = createHostProfile('opencode-v2', { readTransport: options.readTransport });
    const prepared = yield* Effect.promise(() => prepareNativeHiveSkills({ host, directory: projectRoot, worktree: workTarget, disableSkills: configService.getDisabledSkills() }));
    const roles = buildRoleCatalog(host, configService);
    const authority = createHiveAuthority(context, roles.customAgents);
    const registrar = createHiveToolRegistrar({ context, readTransport: host.readTransport, guard: authority.guardHive });
    const skills = effectiveSkills(context, prepared);

    yield* registerAgents(context, roles);
    yield* context.skill.transform((editor) => {
      for (const skill of prepared.skillsByName.values()) {
        editor.add({ id: hiveSkillId(skill), name: skill.name, description: skill.description, path: path.join(skill.materializedDir, 'SKILL.md'), content: skill.content } as never);
      }
    });
    yield* registerCommands(context, { host, configService, roles, skills });
    yield* registrar.register(createHiveOperations(services));
    yield* context.tool.hook('execute.before', (event) => event.tool.startsWith('hive_')
      ? authority.guardHive(event.tool, { sessionID: event.sessionID, agent: event.agent })
      : authority.guardNative(event.tool, event.input, { sessionID: event.sessionID, agent: event.agent }));
    yield* registerRequestPolicy(context, { host, roles, authority, skills });

    const readAccess = createVerifiedReadAccess({ server: options.server, identity, directory: context.location.directory });
    return { services, host, roles, authority, registrar, readAccess };
  });
}

export function createHiveAuthority(context: Pick<Plugin.Context, 'session'>, customAgents: Record<string, ResolvedCustomAgentConfig>): HiveAuthority {
  const policy = createRolePolicy(customAgents);
  const resolve = (agent: string) => resolveCallerAuthority(agent, policy, customAgents);
  const isChild = (sessionID: string) => context.session.get({ sessionID: sessionID as never }).pipe(
    Effect.map((session) => session.parentID !== undefined),
    Effect.mapError(() => new Tool.Error({ message: `Hive could not read session ${sessionID} to check its parent; the call is denied.` })),
  );
  const enforce = (decision: CallDecision) => 'reason' in decision ? Effect.fail(new Tool.Error({ message: decision.reason })) : Effect.void;
  return {
    policy,
    customAgents,
    resolve,
    isChild,
    guardHive: (tool, caller) => {
      const authorityOf = resolve(caller.agent);
      const ancestry = PRIMARY_ONLY_TOOLS.includes(tool) && authorityOf.kind !== 'native-subagent' ? isChild(caller.sessionID) : Effect.succeed(false);
      return ancestry.pipe(Effect.flatMap((child) => enforce(authorizeHiveCall(policy, { tool, caller: authorityOf, isChild: child }))));
    },
    guardNative: (tool, toolInput, caller) => {
      const authorityOf = resolve(caller.agent);
      const ancestry = nativeCallNeedsAncestry(tool) ? isChild(caller.sessionID) : Effect.succeed(false);
      return ancestry.pipe(Effect.flatMap((child) => enforce(authorizeNativeCall(policy, { tool, toolInput, caller: authorityOf, isChild: child }))));
    },
  };
}

/** `provider/model` from the Hive configuration, as the v2 model reference the agent registry carries. */
export function toModelRef(model: string | undefined, variant: string | undefined) {
  const slash = model?.indexOf('/') ?? -1;
  if (!model || slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1), ...(variant ? { variant } : {}) };
}

/**
 * Registers every Hive agent as a native default. This runs before the host applies the user's agent configuration,
 * so the user's settings for an agent win. Permission rules deny every Hive tool, allow the role's grants, then add
 * the role's native rules and deny native lifecycle tools that bypass Hive worktrees; user rules come after and can
 * widen what is visible, but the execution guards still decide what runs.
 */
function registerAgents(context: Plugin.Context, roles: RoleCatalog) {
  const lifecycleDeny = NATIVE_LIFECYCLE_BYPASS_TOOLS.map((action) => ({ action, resource: '*', effect: 'deny' as const }));
  return context.agent.transform((editor) => {
    for (const [id, entry] of Object.entries(roles.agents)) {
      editor.update(id, (agent) => {
        agent.mode = entry.mode;
        agent.hidden = entry.hidden ?? false;
        if (entry.description !== undefined) agent.description = entry.description;
        if (entry.prompt !== undefined) agent.system = entry.prompt;
        const model = toModelRef(entry.model, entry.variant);
        if (model) agent.model = model as never;
        agent.permissions.push(...toV2PermissionRules(entry.permission), ...lifecycleDeny);
      });
    }
    for (const name of ['general', 'explore'] as const) {
      editor.update(name, (agent) => {
        agent.permissions.push(...toV2PermissionRules(nativeSubagentBoundary(name, undefined).permission));
      });
    }
    editor.default(roles.defaultAgent);
  }).pipe(Effect.asVoid);
}

/** The catalog id Hive registers a bundled skill under: its folder name in the materialized directory. */
const hiveSkillId = (skill: { materializedDir: string }) => path.basename(skill.materializedDir);

/**
 * The skills an agent can load right now, read from the host's effective skill catalog, so skills from the user's
 * configured sources count. A unique user entry wins over Hive's bundled entry for a name-based requirement;
 * multiple user entries stay ambiguous. Explicit ids retain their exact entry. The public local catalog is infallible.
 */
function effectiveSkills(context: Plugin.Context, prepared: PreparedNativeHiveSkills): Effect.Effect<SkillLookups> {
  const bundledPaths = new Set([...prepared.skillsByName.values()].map((skill) => path.join(skill.materializedDir, 'SKILL.md')));
  return Effect.suspend(() => context.skill.list()).pipe(
    Effect.map(({ data }): SkillLookups => {
      const byName = new Map<string, typeof data[number]>();
      const ambiguousNames = new Map<string, readonly string[]>();
      for (const name of new Set(data.map((skill) => skill.name))) {
        const candidates = data.filter((skill) => skill.name === name);
        const user = candidates.filter((skill) => !bundledPaths.has(skill.path));
        const preferred = user.length ? user : candidates;
        if (preferred.length === 1) byName.set(name, preferred[0]!);
        else ambiguousNames.set(name, preferred.map((skill) => skill.id));
      }
      return { nativeSkillsByName: byName, nativeSkillsById: new Map(data.map((skill) => [skill.id, skill])), ambiguousNames, skillsByName: new Map(), skipped: prepared.skipped };
    }),
    Effect.orDie,
  );
}

/** The roster commands render against, from the agents the host has now (disabled or overridden agents included). */
function effectiveCommandAgents(roles: RoleCatalog, installed: ReadonlyArray<Agent.Info>): Record<string, HiveCommandAgentDescriptor> {
  const byId = new Map(installed.map((agent) => [agent.id as string, agent]));
  return Object.fromEntries(Object.entries(roles.commandAgents).map(([name, canonical]) => {
    const agent = byId.get(name);
    if (!agent) return [name, { ...canonical, available: false }];
    // A role Hive registers as a subagent cannot be called as one after the operator makes it a primary.
    const callable = roles.agents[name]?.mode === 'primary' || agent.mode !== 'primary';
    return [name, {
      ...canonical,
      available: callable,
      description: agent.description ?? canonical.description,
      model: agent.model ? `${agent.model.providerID}/${agent.model.id}` : undefined,
      variant: agent.model?.variant,
    }];
  }));
}

/**
 * Commands render when invoked, against the agents and skills current at that moment. A command bound to an agent
 * follows native configured commands: it switches the session to the agent, then to the agent's effective model and
 * variant, before prompting.
 */
function registerCommands(context: Plugin.Context, input: { host: HostProfile; configService: ConfigService; roles: RoleCatalog; skills: Effect.Effect<SkillLookups> }) {
  const { host, configService, roles, skills } = input;
  return context.command.transform((editor) => {
    for (const command of HIVE_COMMANDS) {
      const agentID = 'agent' in command ? command.agent : undefined;
      editor.add({
        name: command.key,
        description: command.description,
        execute: (invocation) => Effect.gen(function* () {
          const installed = (yield* context.agent.list()).data;
          const lookups = yield* skills;
          const backgroundGuidance = resolveBackgroundDelegationAvailability(lookups.nativeSkillsByName, lookups.skillsByName, new Map(lookups.skipped.map((entry) => [entry.name, entry])), host);
          const agents = effectiveCommandAgents(roles, installed);
          const text = yield* Effect.promise(async () => hiveCommandRenderers[command.key](invocation.prompt.text, createCommandContext({ host, configService, agents, backgroundGuidance })));
          if (agentID !== undefined) {
            const target = installed.find((agent) => agent.id === agentID);
            if (!target) return yield* Effect.fail(new Error(`The /${command.key} command needs the ${agentID} agent, which is not available in this configuration.`));
            const session = yield* context.session.get({ sessionID: invocation.sessionID });
            if (session.agent !== agentID) yield* context.session.switchAgent({ sessionID: invocation.sessionID, agent: target.id });
            if (target.model) yield* context.session.switchModel({ sessionID: invocation.sessionID, model: target.model });
          }
          yield* context.session.prompt({ ...invocation.prompt, sessionID: invocation.sessionID, text, delivery: invocation.delivery } as never);
        }),
      });
    }
  }).pipe(Effect.asVoid);
}

/**
 * Keeps each Hive role's canonical instructions, and its configured temperature, in every model request it makes:
 * ordinary turns (`context`) and the public auxiliary requests that carry the agent (`compaction`, `generate`). An
 * agent the user gave its own system prompt keeps it, and the Hive instructions follow it; nothing the user wrote is
 * replaced. Skill guidance (auto-load names, background delegation) is resolved against the live skill catalog on
 * each request. Ordinary turns also get what only a turn with tools needs: the subagent clarification rule in child
 * sessions and, under the `codemode` read transport, a plain notice for an agent whose permissions deny `execute`,
 * whose Code Mode reads are unavailable. The title request names no agent and is left alone.
 */
function registerRequestPolicy(context: Plugin.Context, input: { host: HostProfile; roles: RoleCatalog; authority: HiveAuthority; skills: Effect.Effect<SkillLookups> }) {
  const { host, roles, authority, skills } = input;
  const canonical = new Map(Object.entries(roles.agents).flatMap(([id, entry]) => {
    const text = roles.requestPrompts.get(id) ?? entry.prompt;
    return text ? [[id, text] as const] : [];
  }));
  // v2 agent registrations carry no temperature the runner applies, so a configured Hive temperature is a request
  // option, set only when nothing earlier in the request chose one.
  const temperatures = new Map(Object.entries(roles.agents).flatMap(([id, entry]) => entry.temperature === undefined ? [] : [[id, entry.temperature] as const]));
  const warned = new Set<string>();
  const warnOnce = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    console.warn(message);
  };
  const apply = (event: SessionContext, ordinary: boolean) => Effect.gen(function* () {
    const agent: string = event.agent;
    const caller = authority.resolve(agent);
    const temperature = temperatures.get(agent);
    if (temperature !== undefined && event.options.temperature === undefined) event.options.temperature = temperature;
    const parts: string[] = [];
    const instructions = canonical.get(agent);
    if (instructions && !event.system.some((part) => 'text' in part && part.text.includes(instructions))) parts.push(instructions);
    const guidance = roles.skillGuidance(agent, yield* skills, warnOnce).trim();
    if (guidance && !event.system.some((part) => 'text' in part && part.text.includes(guidance))) parts.push(guidance);
    if (ordinary) {
      if (caller.kind === 'role' && host.readTransport === 'codemode' && !('execute' in event.tools)
        && authority.policy[caller.role].hiveTools.some((tool) => (CODEMODE_READ_TOOLS as readonly string[]).includes(tool))) {
        parts.push(codemodeDiagnostic(caller.role));
        warnOnce(`[hive:config] Agent "${agent}" cannot reach Hive Code Mode reads: its permissions deny execute. Set the oc-arkive option readTransport to "direct" or allow execute for this agent.`);
      }
      if (yield* authority.isChild(event.sessionID).pipe(Effect.orElseSucceed(() => false))) parts.push(SUBAGENT_CLARIFICATION_PROMPT.trim());
    }
    for (const text of parts) event.system.push({ type: 'text', text });
  });
  return Effect.all([
    context.session.hook('context', (event) => apply(event, true)),
    context.session.hook('compaction', (event) => apply(event, false)),
    context.session.hook('generate', (event) => apply(event, false)),
  ]).pipe(Effect.asVoid);
}

function codemodeDiagnostic(role: BuiltInRole): string {
  const reads = CODEMODE_READ_TOOLS.map((name) => `\`${name}\``).join(', ');
  return `## Hive Read Transport Setup\n\nThis ${role} agent's permissions deny the host's \`execute\` tool, and oc-arkive runs ${reads} inside Code Mode, so those reads are unavailable here. When a task needs them, report this missing capability and what it blocks. The operator can set the oc-arkive option \`readTransport\` to \`direct\` to make them direct tool calls, or allow \`execute\` for this agent.`;
}
