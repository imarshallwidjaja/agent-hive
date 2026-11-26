import type { CustomAgentBase, ResolvedCustomAgentConfig } from 'hive-core';
import type { RuntimeSubagentConfig } from '../agents/custom-agents.js';
import { HIVE_TOOL_NAMES } from '../utils/plugin-manifest.js';

/**
 * Which Hive tools and delegation targets each role holds. Hosts register these as permissions; presentation
 * (mode, description, hidden state) and model settings stay with the host registration, so a role is identified
 * by its name and never inferred from how it is displayed.
 */

type AgentPermission = NonNullable<RuntimeSubagentConfig['permission']>;

export type BuiltInRole =
  | 'hive-master' | 'architect-planner' | 'swarm-orchestrator' | 'hive-builder'
  | 'scout-researcher' | 'forager-worker' | 'forager-investigator' | 'hive-helper'
  | 'plan-reviewer' | 'code-reviewer' | 'simplicity-reviewer' | 'approach-advisor' | 'vulnerability-reviewer'
  | 'dash-reviewer' | 'vulnerability-review-primary';

export type RolePolicy = {
  /** Hive tools the role may call; every other `hive_*` tool is denied. */
  hiveTools: readonly string[];
  /** Native permissions that follow the Hive grants, including the delegation allowlist. */
  permission: AgentPermission;
};

/** Specialist bases a primary may delegate to; also the bases custom agents can derive from. */
export const ROUTING_BASES = [
  'scout-researcher', 'forager-worker', 'forager-investigator', 'plan-reviewer', 'code-reviewer', 'simplicity-reviewer', 'approach-advisor', 'vulnerability-reviewer',
] as const satisfies readonly CustomAgentBase[];

/** The helper bases Architect routes planning and investigation work to; its routing appendix lists these. */
export const ARCHITECT_PLANNING_BASES = [
  'scout-researcher', 'forager-investigator', 'plan-reviewer', 'approach-advisor',
] as const satisfies readonly CustomAgentBase[];

/**
 * The base roles a council seat may derive from: the read-only specialists. Architect's delegation grant and the
 * council resolver both read this list, so who may sit and who Architect may convene cannot drift apart.
 */
export const COUNCIL_SEAT_BASES = [
  'scout-researcher', 'plan-reviewer', 'code-reviewer', 'simplicity-reviewer', 'approach-advisor', 'vulnerability-reviewer',
] as const satisfies readonly CustomAgentBase[];

/**
 * The roles whose settled child a parent may continue with the host's continuation field: the workers that carry one
 * task or investigation across bounded follow-ups. Every other role (Scout, reviewers, advisors, Helper) is one-shot,
 * so an independent pass never reuses another pass's context. Custom agents follow their base role.
 */
export const RESUMABLE_SUBAGENT_ROLES: ReadonlySet<BuiltInRole> = new Set(['forager-worker', 'forager-investigator', 'architect-planner']);

const READ_TOOLS = ['hive_context_read', 'hive_constraints_read', 'hive_plan_read', 'hive_status', 'hive_repositories_status', 'hive_git_snapshot',
  'hive_worklog_list', 'hive_worklog_read', 'hive_checkouts_list', 'hive_checkout_brief', 'hive_explore_read'];
/** Writes that stamp the calling primary session as the author of shared records. */
const AUTHORED_PRIMARY_WRITES = ['hive_worklog_record', 'hive_explore_update'] as const;
const CONTEXT_WRITES = ['hive_context_write', 'hive_context_append', 'hive_context_edit'];
export const CONSTRAINT_MUTATIONS = ['hive_constraints_add', 'hive_constraints_edit', 'hive_constraints_clear'];
const REVIEW_TOOLS = [...READ_TOOLS, ...CONTEXT_WRITES];
const TASK_TRACE_TOOLS = ['hive_task_trace', 'hive_task_trace_content'];
// Checkout inspection takes the same operation locks as worktree inspection when it reads a cleanup proposal.
const INSPECTION_TOOLS = ['hive_worktree_inspect', 'hive_adhoc_worktree_inspect', 'hive_checkout_inspect'];
/** Retained checkout mutations; only the executing primaries (Hive, Swarm, Hive Builder) hold them. */
const CHECKOUT_MUTATIONS = ['hive_checkout_create', 'hive_checkout_register', 'hive_checkout_readiness', 'hive_checkout_cleanup'];
/** Live inspection and cancellation of the caller's own native children. */
const BACKGROUND_TOOLS = ['hive_background_status', 'hive_background_cancel'];
/** Acknowledges an interrupted worktree operation; every primary that can create or clean up a placement holds it. */
const WORKTREE_RECOVERY = 'hive_worktree_recover';
/** Reads the configured council rosters; a delegated child returns a council request to its parent instead. */
const COUNCIL_ROSTER = 'hive_councils_list';
const REVIEW_PRIMARY_TOOLS = [...REVIEW_TOOLS, ...TASK_TRACE_TOOLS, ...INSPECTION_TOOLS, ...CONSTRAINT_MUTATIONS, ...BACKGROUND_TOOLS, COUNCIL_ROSTER,
  'hive_feature_select', 'hive_adhoc_worktree_create', 'hive_adhoc_worktree_cleanup', WORKTREE_RECOVERY, ...AUTHORED_PRIMARY_WRITES];

/** Operations only a primary session may run; child sessions deny them. */
export const PRIMARY_ONLY_TOOLS = [
  'question', 'hive_feature_complete', 'hive_feature_select',
  'hive_plan_approve', 'hive_tasks_sync', 'hive_task_create',
  'hive_worktree_merge', 'hive_worktree_cleanup',
  'hive_adhoc_worktree_create', 'hive_adhoc_worktree_merge', 'hive_adhoc_worktree_cleanup', WORKTREE_RECOVERY, ...CHECKOUT_MUTATIONS,
  ...CONSTRAINT_MUTATIONS, 'hive_context_archive', ...BACKGROUND_TOOLS, ...AUTHORED_PRIMARY_WRITES, COUNCIL_ROSTER,
];

/**
 * Primary-only operations whose OpenCode v1 executor also checks the role grant and the session's live parent before
 * running, so neither a broad operator allow rule nor a missing `primary_tools` entry can let a child call them.
 * The authored writes stamp the caller as the author of shared records. The council roster is a primary-only read whose
 * role grant a delegated Architect child shares; v1 writes `primary_tools` into a child only when it is created, so a
 * child created before the tool existed and later continued has no stored deny. The check fails closed when the
 * session cannot be read. OpenCode v2 runs the same check for every Hive tool in its registrar guard.
 */
export const LIVE_PARENT_CHECKED_TOOLS: readonly string[] = [...AUTHORED_PRIMARY_WRITES, COUNCIL_ROSTER];

export function mergePrimaryOnlyTools(existing: readonly string[] | undefined): string[] {
  return [...new Set([...(existing ?? []), ...PRIMARY_ONLY_TOOLS])];
}

/** Built-in role grants. Custom agents inherit their base role's entry through the custom-agent builder. */
export function createRolePolicy(customAgents: Record<string, ResolvedCustomAgentConfig>): Record<BuiltInRole, RolePolicy> {
  const taskPermission = (bases: readonly CustomAgentBase[], extra: string[] = []): AgentPermission['task'] => ({
    '*': 'deny',
    ...Object.fromEntries([...bases, ...extra].map((name) => [name, 'allow'])),
    ...Object.fromEntries(Object.entries(customAgents)
      .filter(([, config]) => bases.includes(config.baseAgent))
      .map(([name]) => [name, 'allow'])),
  });
  // Architect convenes council seats and commissions experiments through Investigators; implementation Foragers stay
  // with execution primaries.
  const architectTaskPermission = taskPermission([...new Set([...ARCHITECT_PLANNING_BASES, ...COUNCIL_SEAT_BASES])], ['hive-helper']);
  const primaryTaskPermission = taskPermission(ROUTING_BASES, ['architect-planner', 'hive-helper', 'general', 'explore']);
  // Review primaries run candidates through Investigators for runtime exercises; edit stays denied for the primary.
  const reviewTaskPermission = taskPermission(ROUTING_BASES.filter((base) => base !== 'forager-worker'), ['hive-helper']);
  const primary: RolePolicy = { hiveTools: [...HIVE_TOOL_NAMES], permission: { question: 'allow', task: primaryTaskPermission, skill: 'allow' } };
  const readOnlyChild = (hiveTools: readonly string[]): RolePolicy => ({ hiveTools, permission: { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' } });
  const reviewPrimary: RolePolicy = { hiveTools: REVIEW_PRIMARY_TOOLS, permission: { edit: 'deny', question: 'allow', task: reviewTaskPermission, skill: 'allow' } };

  return {
    'hive-master': primary,
    'architect-planner': {
      hiveTools: [...REVIEW_TOOLS, ...CONSTRAINT_MUTATIONS, ...INSPECTION_TOOLS, ...BACKGROUND_TOOLS, ...TASK_TRACE_TOOLS, COUNCIL_ROSTER,
        'hive_feature_create', 'hive_feature_select', 'hive_plan_write', 'hive_plan_patch', 'hive_plan_approve', 'hive_tasks_sync',
        'hive_repositories_discover', 'hive_repositories_update', 'hive_context_archive', ...AUTHORED_PRIMARY_WRITES,
        // Experiment placement only: Architect never merges, and child sessions deny both as primary-only operations.
        'hive_adhoc_worktree_create', 'hive_adhoc_worktree_cleanup', WORKTREE_RECOVERY],
      permission: { question: 'allow', task: architectTaskPermission, edit: 'deny', skill: 'allow' },
    },
    'swarm-orchestrator': primary,
    'hive-builder': primary,
    'scout-researcher': readOnlyChild([...READ_TOOLS, 'hive_repositories_discover']),
    'forager-worker': {
      hiveTools: [...REVIEW_TOOLS, ...INSPECTION_TOOLS, ...TASK_TRACE_TOOLS, 'hive_task_update', 'hive_worktree_create'],
      permission: { question: 'deny', task: 'deny', skill: 'allow' },
    },
    // Native edit and shell stay available for scratch experiments; their scope is instruction-bound, not sandboxed.
    'forager-investigator': { hiveTools: [...READ_TOOLS, ...INSPECTION_TOOLS], permission: { question: 'deny', task: 'deny', skill: 'allow' } },
    'hive-helper': readOnlyChild([...READ_TOOLS, ...INSPECTION_TOOLS, ...TASK_TRACE_TOOLS]),
    'plan-reviewer': readOnlyChild(REVIEW_TOOLS),
    'code-reviewer': readOnlyChild(REVIEW_TOOLS),
    'simplicity-reviewer': readOnlyChild(REVIEW_TOOLS),
    'approach-advisor': readOnlyChild(REVIEW_TOOLS),
    'vulnerability-reviewer': readOnlyChild(REVIEW_TOOLS),
    'dash-reviewer': reviewPrimary,
    'vulnerability-review-primary': reviewPrimary,
  };
}

/** The ordered permission rules a registered agent carries: deny every Hive tool, allow the role's grants, then its native rules. */
export function agentPermission(policy: RolePolicy): AgentPermission {
  return { 'hive_*': 'deny', ...Object.fromEntries(policy.hiveTools.map((tool) => [tool, 'allow'])), ...policy.permission };
}

/**
 * Who is making a call, as far as Hive authority is concerned. A Hive role comes from the agent's name: a built-in
 * role name, or a configured custom agent's base role. Mode, description or hidden state never identify a role,
 * because the operator can edit them.
 */
export type CallerAuthority =
  | { kind: 'role'; role: BuiltInRole }
  | { kind: 'native-subagent'; name: 'general' | 'explore' }
  | { kind: 'unmanaged' };

export function resolveCallerAuthority(agent: string, policy: Record<BuiltInRole, RolePolicy>, customAgents: Record<string, ResolvedCustomAgentConfig>): CallerAuthority {
  if (Object.prototype.hasOwnProperty.call(policy, agent)) return { kind: 'role', role: agent as BuiltInRole };
  if (agent === 'general' || agent === 'explore') return { kind: 'native-subagent', name: agent };
  const custom = Object.prototype.hasOwnProperty.call(customAgents, agent) ? customAgents[agent] : undefined;
  return custom ? { kind: 'role', role: custom.baseAgent } : { kind: 'unmanaged' };
}

export type CallDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether a caller may run a Hive tool. The host passes whether the calling session has a parent; that, not the
 * agent's configured mode, decides child restrictions. Unmanaged agents keep their native access except for
 * primary-only operations in child sessions.
 */
export function authorizeHiveCall(policy: Record<BuiltInRole, RolePolicy>, input: { tool: string; caller: CallerAuthority; isChild: boolean }): CallDecision {
  const { caller, isChild } = input;
  const tool = canonicalToolName(input.tool);
  if (caller.kind === 'native-subagent') return { allowed: false, reason: `The native ${caller.name} subagent has no Hive tool access; ${tool} is denied.` };
  if (caller.kind === 'role' && !policy[caller.role].hiveTools.includes(tool)) return { allowed: false, reason: `${tool} is not granted to the ${caller.role} role.` };
  if (isChild && PRIMARY_ONLY_TOOLS.includes(tool)) return { allowed: false, reason: `${tool} is a primary-only operation and is denied in child sessions.` };
  return { allowed: true };
}

/**
 * The canonical tool ID for a name the host reports to `execute.before`. OpenCode v2.4.2 reports a Code Mode tool
 * that a model calls at top level by its qualified name (`automation.create`, `hive.worklog_read`) under that dotted
 * name, and then runs the tool without a second hook, so the guards decide on the canonical ID (`automation_create`).
 */
export function canonicalToolName(tool: string): string {
  return tool.replaceAll('.', '_');
}

/**
 * Native OpenCode v2 tools that change worktrees or session placement outside Hive's ownership of `.hive` worktrees,
 * or interrupt another session outside the primary, location and direct-child checks of `hive_background_cancel`.
 * Names are canonical tool IDs; see `canonicalToolName`.
 */
export const NATIVE_LIFECYCLE_BYPASS_TOOLS = ['opencode_worktree_create', 'opencode_worktree_remove', 'opencode_session_move', 'opencode_session_interrupt'] as const;

/** v2.4.2 `opencode.session.interrupt` stops any session except the caller and its ancestors; it is the operator's. */
const NATIVE_SESSION_INTERRUPT_TOOL = 'opencode_session_interrupt';

/**
 * Native OpenCode v2 tools that change project automations, which v2.4.2 registers in the `automation` namespace unless
 * the operator turns automations off. An armed automation later prompts a session or starts a subagent child outside the
 * `subagent` call Hive wraps, without Hive's route binding, delegation limits, managed model and continuation checks,
 * and pausing or deleting one changes the operator's schedule for the whole project. These are the operator's to use;
 * listing automations stays native.
 */
export const NATIVE_AUTOMATION_TOOLS = ['automation_create', 'automation_resume', 'automation_pause', 'automation_delete'] as const;

const isAutomationTool = (tool: string) => (NATIVE_AUTOMATION_TOOLS as readonly string[]).includes(tool);

/** Native tools reserved to a top-level operator session: refused to native subagents and in every child session. */
const OPERATOR_ONLY_NATIVE_TOOLS: readonly string[] = [...NATIVE_AUTOMATION_TOOLS, NATIVE_SESSION_INTERRUPT_TOOL];

/**
 * The native tools an agent may never run because they bypass what Hive owns, as canonical tool IDs. The same list
 * becomes the agent's default permission denies, which hide the tools, and the execution guard's refusal, which a user
 * allow rule does not lift. Hive roles are denied the worktree, session-placement and session-interrupt tools and the
 * automation tools; native `general` and `explore` are denied the automation and session-interrupt tools. An unmanaged
 * agent is denied none: a top-level operator agent keeps its native authority, and automations that already exist are
 * the operator's to manage, which Hive does not inspect or stop. `authorizeNativeCall` still refuses the automation and
 * session-interrupt tools in every child session, whatever its agent.
 */
export function deniedNativeBypassTools(caller: CallerAuthority): readonly string[] {
  if (caller.kind === 'unmanaged') return [];
  if (caller.kind === 'native-subagent') return OPERATOR_ONLY_NATIVE_TOOLS;
  return [...NATIVE_LIFECYCLE_BYPASS_TOOLS, ...NATIVE_AUTOMATION_TOOLS];
}

function nativeBypassReason(tool: string): string {
  if (isAutomationTool(tool)) return `${tool} changes the operator's project automations, which run outside Hive's dispatch checks; leave automations to the operator and use the native subagent call for delegated work.`;
  if (tool === NATIVE_SESSION_INTERRUPT_TOOL) return `${tool} interrupts sessions outside Hive's ownership checks; use hive_background_cancel for a direct child, or leave other sessions to the operator.`;
  return `${tool} bypasses Hive worktree and session ownership; use the Hive worktree tools instead.`;
}

/**
 * The role permission that governs each native OpenCode v2 tool Hive guards, as canonical tool IDs. v2.4.2
 * `machine.copy` writes the target file and `machine.move` also removes the source, so both are edits.
 */
const NATIVE_TOOL_PERMISSION: Record<string, 'edit' | 'question' | 'task'> = {
  edit: 'edit', write: 'edit', patch: 'edit', machine_copy: 'edit', machine_move: 'edit', question: 'question', subagent: 'task',
};

/** Native tools whose decision depends on whether the calling session is a child. */
export function nativeCallNeedsAncestry(tool: string): boolean {
  const id = canonicalToolName(tool);
  return id === 'question' || OPERATOR_ONLY_NATIVE_TOOLS.includes(id);
}

/** Orchestrators that are never valid delegation targets, whichever agent calls and however the operator sets their mode. */
export const PRIMARY_ONLY_AGENTS: readonly string[] = ['hive-master', 'swarm-orchestrator', 'hive-builder'];

/**
 * The native-tool boundaries Hive owns on OpenCode v2, keyed by the host's actual tool names. A Hive role keeps the
 * edit, question and delegation limits of its policy (delegation is checked against the requested `agent`), and no
 * Hive role or native subagent runs the bypass tools `deniedNativeBypassTools` lists. No caller, managed or not, may
 * delegate to a primary-only orchestrator. Native `general`/`explore` cannot delegate or ask, and `explore` cannot edit.
 * No child session may ask the operator or change an automation. Every other native call, and every call by an unmanaged
 * agent outside those limits, is left to native permissions. The guard reads only tool names and the subagent call's
 * `agent`; it does not parse code, so it is a boundary on these tools, not a sandbox.
 */
export function authorizeNativeCall(policy: Record<BuiltInRole, RolePolicy>, input: { tool: string; toolInput: unknown; caller: CallerAuthority; isChild: boolean }): CallDecision {
  const { toolInput, caller, isChild } = input;
  const tool = canonicalToolName(input.tool);
  const key = NATIVE_TOOL_PERMISSION[tool];
  const target = key === 'task' && toolInput && typeof toolInput === 'object' ? (toolInput as { agent?: unknown }).agent : undefined;
  if (typeof target === 'string' && PRIMARY_ONLY_AGENTS.includes(target)) {
    return { allowed: false, reason: `${target} is a primary-only orchestrator and cannot be a delegation target.` };
  }
  const denial = unconditionalNativeDenial(policy, { tool, caller, isChild, target });
  if (denial) return denial;
  if (caller.kind === 'role' && key === 'task') {
    const rule = policy[caller.role].permission[key];
    if (rule !== undefined && typeof rule !== 'string') {
      const effect = typeof target === 'string' && Object.prototype.hasOwnProperty.call(rule, target) ? rule[target] : rule['*'];
      if (effect === 'deny') return { allowed: false, reason: delegationDenialReason(caller.role, target) };
    }
  }
  return { allowed: true };
}

function delegationDenialReason(role: BuiltInRole, target: unknown): string {
  return `The ${role} role cannot delegate to ${typeof target === 'string' ? target : 'that agent'}.`;
}

/** The native-tool refusals that hold for every input, shared by `authorizeNativeCall` and `isToolUnconditionallyDenied`. */
function unconditionalNativeDenial(policy: Record<BuiltInRole, RolePolicy>, input: { tool: string; caller: CallerAuthority; isChild: boolean; target?: unknown }): CallDecision | undefined {
  const { tool, caller, isChild, target } = input;
  if (deniedNativeBypassTools(caller).includes(tool)) return { allowed: false, reason: nativeBypassReason(tool) };
  if (isChild && OPERATOR_ONLY_NATIVE_TOOLS.includes(tool)) {
    return { allowed: false, reason: `${tool} is denied in child sessions: project automations and interrupting other sessions are the operator's. Return the request to the parent instead.` };
  }
  if (caller.kind === 'role') {
    const key = NATIVE_TOOL_PERMISSION[tool];
    const rule = key ? policy[caller.role].permission[key] : undefined;
    if (typeof rule === 'string' || rule === undefined) {
      if (rule === 'deny') {
        return { allowed: false, reason: key === 'task' ? delegationDenialReason(caller.role, target) : `The ${caller.role} role cannot use ${tool}.` };
      }
    } else if (rule['*'] === 'deny' && !Object.values(rule).some((effect) => effect === 'allow' || effect === 'ask')) {
      return { allowed: false, reason: delegationDenialReason(caller.role, target) };
    }
  }
  if (caller.kind === 'native-subagent') {
    const denied = ['subagent', 'question'].includes(tool) || (caller.name === 'explore' && NATIVE_TOOL_PERMISSION[tool] === 'edit');
    if (denied) return { allowed: false, reason: `The native ${caller.name} subagent cannot use ${tool}.` };
  }
  if (isChild && tool === 'question') return { allowed: false, reason: 'The question tool is unavailable in child sessions; return the clarification to the parent instead.' };
  return undefined;
}

/**
 * Whether Hive refuses a tool to this caller for every possible input, so a request can drop the tool's schema without
 * hiding anything the caller could run. It answers with the same rules as `authorizeHiveCall` and `authorizeNativeCall`
 * and never replaces them. A tool refused only for some inputs stays, such as `subagent` for a role that may delegate to
 * some agents. An unmanaged top-level session keeps every tool.
 */
export function isToolUnconditionallyDenied(policy: Record<BuiltInRole, RolePolicy>, input: { tool: string; caller: CallerAuthority; isChild: boolean }): boolean {
  const { caller, isChild } = input;
  const tool = canonicalToolName(input.tool);
  if (tool.startsWith('hive_')) return !authorizeHiveCall(policy, { tool, caller, isChild }).allowed;
  return unconditionalNativeDenial(policy, { tool, caller, isChild }) !== undefined;
}

type V2Rule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' };

/** OpenCode v2 names the v1 `task` and `bash` permissions after its tools. */
const V2_ACTION_NAMES: Record<string, string> = { task: 'subagent', bash: 'shell' };

/** Translates an ordered v1-shaped permission object into the ordered rule list an OpenCode v2 agent carries. */
export function toV2PermissionRules(permission: Record<string, unknown>): V2Rule[] {
  return Object.entries(permission).flatMap(([key, value]): V2Rule[] => {
    const action = V2_ACTION_NAMES[key] ?? key;
    if (typeof value === 'string') return [{ action, resource: '*', effect: value as V2Rule['effect'] }];
    return Object.entries(value as Record<string, V2Rule['effect']>).map(([resource, effect]) => ({ action, resource, effect }));
  });
}

/**
 * Hive owns the permission boundaries of the native `general` and `explore` subagents: no Hive tools, delegation or
 * questions, skills allowed, and `explore` cannot edit. Operator rules for other permissions are preserved.
 */
export function nativeSubagentBoundary(name: 'general' | 'explore', existing: Record<string, unknown> | undefined): { permission: Record<string, unknown>; warning?: string } {
  const droppedKeys: string[] = [];
  const kept = Object.fromEntries(Object.entries(existing ?? {})
    .filter(([key]) => {
      const drop = key.startsWith('hive_') || ['task', 'question', 'skill'].includes(key) || (name === 'explore' && key === 'edit');
      if (drop) droppedKeys.push(key);
      return !drop;
    }));
  return {
    permission: { ...kept, 'hive_*': 'deny', task: 'deny', question: 'deny', skill: 'allow', ...(name === 'explore' ? { edit: 'deny' } : {}) },
    ...(droppedKeys.length > 0
      ? { warning: `[hive:config] Dropping agent.${name}.permission overrides for ${droppedKeys.join(', ')}: Hive owns native subagent boundaries (Hive tools, task and question denied; skill allowed${name === 'explore' ? '; edit denied' : ''}). Other permission rules are preserved.` }
      : {}),
  };
}
