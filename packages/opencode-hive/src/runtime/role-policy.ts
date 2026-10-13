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

const READ_TOOLS = ['hive_context_read', 'hive_constraints_read', 'hive_plan_read', 'hive_status', 'hive_repositories_status', 'hive_git_snapshot'];
const CONTEXT_WRITES = ['hive_context_write', 'hive_context_append'];
const CONSTRAINT_MUTATIONS = ['hive_constraints_add', 'hive_constraints_edit', 'hive_constraints_clear'];
const REVIEW_TOOLS = [...READ_TOOLS, ...CONTEXT_WRITES];
const TASK_TRACE_TOOLS = ['hive_task_trace', 'hive_task_trace_content'];
const INSPECTION_TOOLS = ['hive_worktree_inspect', 'hive_adhoc_worktree_inspect'];
const BACKGROUND_TOOLS = ['hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel'];
const REVIEW_PRIMARY_TOOLS = [...REVIEW_TOOLS, ...TASK_TRACE_TOOLS, ...INSPECTION_TOOLS, ...CONSTRAINT_MUTATIONS, ...BACKGROUND_TOOLS,
  'hive_feature_select', 'hive_adhoc_worktree_create', 'hive_adhoc_worktree_cleanup'];

/** Operations only a primary session may run; child sessions deny them. */
export const PRIMARY_ONLY_TOOLS = [
  'question', 'hive_feature_complete', 'hive_feature_select',
  'hive_plan_approve', 'hive_tasks_sync', 'hive_task_create',
  'hive_worktree_merge', 'hive_worktree_cleanup',
  'hive_adhoc_worktree_create', 'hive_adhoc_worktree_merge', 'hive_adhoc_worktree_cleanup',
  ...CONSTRAINT_MUTATIONS, 'hive_context_archive', ...BACKGROUND_TOOLS,
];

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
        'hive_repositories_discover', 'hive_repositories_update', 'hive_context_archive'],
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
