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
  | 'scout-researcher' | 'forager-worker' | 'hive-helper'
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
  'scout-researcher', 'forager-worker', 'plan-reviewer', 'code-reviewer', 'simplicity-reviewer', 'approach-advisor', 'vulnerability-reviewer',
] as const satisfies readonly CustomAgentBase[];

const READ_TOOLS = ['hive_context_read', 'hive_constraints_read', 'hive_plan_read', 'hive_status', 'hive_repositories_status', 'hive_git_snapshot',
  'hive_worklog_list', 'hive_worklog_read'];
const WORKLOG_RECORD = 'hive_worklog_record';
const CONTEXT_WRITES = ['hive_context_write', 'hive_context_append', 'hive_context_edit'];
const CONSTRAINT_MUTATIONS = ['hive_constraints_add', 'hive_constraints_edit', 'hive_constraints_clear'];
const REVIEW_TOOLS = [...READ_TOOLS, ...CONTEXT_WRITES];
const TASK_TRACE_TOOLS = ['hive_task_trace', 'hive_task_trace_content'];
const INSPECTION_TOOLS = ['hive_worktree_inspect', 'hive_adhoc_worktree_inspect'];
const BACKGROUND_TOOLS = ['hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel'];
const REVIEW_PRIMARY_TOOLS = [...REVIEW_TOOLS, ...TASK_TRACE_TOOLS, ...INSPECTION_TOOLS, ...CONSTRAINT_MUTATIONS, ...BACKGROUND_TOOLS,
  'hive_feature_select', 'hive_adhoc_worktree_create', 'hive_adhoc_worktree_cleanup', WORKLOG_RECORD];

/** Operations only a primary session may run; child sessions deny them. */
export const PRIMARY_ONLY_TOOLS = [
  'question', 'hive_feature_complete', 'hive_feature_select',
  'hive_plan_approve', 'hive_tasks_sync', 'hive_task_create',
  'hive_worktree_merge', 'hive_worktree_cleanup',
  'hive_adhoc_worktree_create', 'hive_adhoc_worktree_merge', 'hive_adhoc_worktree_cleanup',
  ...CONSTRAINT_MUTATIONS, 'hive_context_archive', ...BACKGROUND_TOOLS, WORKLOG_RECORD,
];

/**
 * Primary-only operations whose OpenCode v1 executor also checks the role grant and the session's live parent before
 * running, so neither a broad operator allow rule nor a missing `primary_tools` entry can let a child call them.
 * They stamp the caller as the author of shared records. The check fails closed when the session cannot be read.
 * OpenCode v2 runs the same check for every Hive tool in its registrar guard.
 */
export const LIVE_PARENT_CHECKED_TOOLS: readonly string[] = [WORKLOG_RECORD];

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
  const architectTaskPermission = taskPermission(['scout-researcher', 'plan-reviewer', 'approach-advisor'], ['hive-helper']);
  const primaryTaskPermission = taskPermission(ROUTING_BASES, ['architect-planner', 'hive-helper', 'general', 'explore']);
  const reviewTaskPermission = taskPermission(ROUTING_BASES.filter((base) => base !== 'forager-worker'), ['hive-helper']);
  const primary: RolePolicy = { hiveTools: [...HIVE_TOOL_NAMES], permission: { question: 'allow', task: primaryTaskPermission, skill: 'allow' } };
  const readOnlyChild = (hiveTools: readonly string[]): RolePolicy => ({ hiveTools, permission: { edit: 'deny', question: 'deny', task: 'deny', skill: 'allow' } });
  const reviewPrimary: RolePolicy = { hiveTools: REVIEW_PRIMARY_TOOLS, permission: { edit: 'deny', question: 'allow', task: reviewTaskPermission, skill: 'allow' } };

  return {
    'hive-master': primary,
    'architect-planner': {
      hiveTools: [...REVIEW_TOOLS, ...CONSTRAINT_MUTATIONS, ...INSPECTION_TOOLS, ...BACKGROUND_TOOLS, ...TASK_TRACE_TOOLS,
        'hive_feature_create', 'hive_feature_select', 'hive_plan_write', 'hive_plan_patch', 'hive_plan_approve', 'hive_tasks_sync',
        'hive_repositories_discover', 'hive_repositories_update', 'hive_context_archive', WORKLOG_RECORD],
      permission: { question: 'allow', task: architectTaskPermission, edit: 'deny', skill: 'allow' },
    },
    'swarm-orchestrator': primary,
    'hive-builder': primary,
    'scout-researcher': readOnlyChild([...READ_TOOLS, 'hive_repositories_discover']),
    'forager-worker': {
      hiveTools: [...REVIEW_TOOLS, ...INSPECTION_TOOLS, ...TASK_TRACE_TOOLS, 'hive_task_update', 'hive_worktree_create'],
      permission: { question: 'deny', task: 'deny', skill: 'allow' },
    },
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
  const { tool, caller, isChild } = input;
  if (caller.kind === 'native-subagent') return { allowed: false, reason: `The native ${caller.name} subagent has no Hive tool access; ${tool} is denied.` };
  if (caller.kind === 'role' && !policy[caller.role].hiveTools.includes(tool)) return { allowed: false, reason: `${tool} is not granted to the ${caller.role} role.` };
  if (isChild && PRIMARY_ONLY_TOOLS.includes(tool)) return { allowed: false, reason: `${tool} is a primary-only operation and is denied in child sessions.` };
  return { allowed: true };
}

/**
 * Native OpenCode v2 tools that change worktrees or session placement outside Hive's ownership of `.hive` worktrees.
 * Names are the effective tool ids the host reports to `execute.before`, including Code Mode inner calls.
 */
export const NATIVE_LIFECYCLE_BYPASS_TOOLS = ['opencode_worktree_create', 'opencode_worktree_remove', 'opencode_session_move'] as const;

/** The role permission that governs each native OpenCode v2 tool Hive guards, keyed by the host's tool name. */
const NATIVE_TOOL_PERMISSION: Record<string, 'edit' | 'question' | 'task'> = {
  edit: 'edit', write: 'edit', patch: 'edit', question: 'question', subagent: 'task',
};

/** Native tools whose decision depends on whether the calling session is a child. */
export function nativeCallNeedsAncestry(tool: string): boolean {
  return tool === 'question';
}

/** Orchestrators that are never valid delegation targets, whichever agent calls and however the operator sets their mode. */
export const PRIMARY_ONLY_AGENTS: readonly string[] = ['hive-master', 'swarm-orchestrator', 'hive-builder'];

/**
 * The native-tool boundaries Hive owns on OpenCode v2, keyed by the host's actual tool names. A Hive role keeps the
 * edit, question and delegation limits of its policy (delegation is checked against the requested `agent`) and
 * cannot use native lifecycle tools that bypass Hive worktrees. No caller, managed or not, may delegate to a
 * primary-only orchestrator. Native `general`/`explore` cannot delegate or ask, and `explore` cannot edit. No child
 * session may ask the operator. Every other native call, and every call by an unmanaged agent outside those limits,
 * is left to native permissions.
 */
export function authorizeNativeCall(policy: Record<BuiltInRole, RolePolicy>, input: { tool: string; toolInput: unknown; caller: CallerAuthority; isChild: boolean }): CallDecision {
  const { tool, toolInput, caller, isChild } = input;
  if (NATIVE_TOOL_PERMISSION[tool] === 'task') {
    const requested = toolInput && typeof toolInput === 'object' ? (toolInput as { agent?: unknown }).agent : undefined;
    if (typeof requested === 'string' && PRIMARY_ONLY_AGENTS.includes(requested)) {
      return { allowed: false, reason: `${requested} is a primary-only orchestrator and cannot be a delegation target.` };
    }
  }
  if (caller.kind === 'role') {
    if ((NATIVE_LIFECYCLE_BYPASS_TOOLS as readonly string[]).includes(tool)) {
      return { allowed: false, reason: `${tool} bypasses Hive worktree and session ownership; use the Hive worktree tools instead.` };
    }
    const key = NATIVE_TOOL_PERMISSION[tool];
    const rule = key ? policy[caller.role].permission[key] : undefined;
    const target = key === 'task' && toolInput && typeof toolInput === 'object' ? (toolInput as { agent?: unknown }).agent : undefined;
    const effect = typeof rule === 'string' || rule === undefined
      ? rule
      : (typeof target === 'string' && Object.prototype.hasOwnProperty.call(rule, target) ? rule[target] : rule['*']);
    if (effect === 'deny') {
      return { allowed: false, reason: key === 'task'
        ? `The ${caller.role} role cannot delegate to ${typeof target === 'string' ? target : 'that agent'}.`
        : `The ${caller.role} role cannot use ${tool}.` };
    }
  }
  if (caller.kind === 'native-subagent') {
    const denied = ['subagent', 'question', ...(caller.name === 'explore' ? ['edit', 'write', 'patch'] : [])];
    if (denied.includes(tool)) return { allowed: false, reason: `The native ${caller.name} subagent cannot use ${tool}.` };
  }
  if (isChild && tool === 'question') return { allowed: false, reason: 'The question tool is unavailable in child sessions; return the clarification to the parent instead.' };
  return { allowed: true };
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
