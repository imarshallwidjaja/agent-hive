import {
  DASH_REVIEW_PRIMARY_AGENT,
  REVIEW_UNIVERSAL_METADATA_TOOLS,
  VULNERABILITY_REVIEW_PRIMARY_AGENT,
} from './review-runtime-kernel.js';

export type ReviewWorkflow = 'dash-review' | 'vulnerability-review';
export type ReviewRole =
  | 'primary'
  | 'scope'
  | 'deep'
  | 'scope-scout'
  | 'baseline'
  | 'specialist'
  | 'falsifier';

type ReviewCallerResolver =
  | { kind: 'exact-agent'; agent: string }
  | { kind: 'lane-role'; role: ReviewRole };

export type ReviewRolePolicy = {
  workflow: ReviewWorkflow;
  role: ReviewRole;
  caller: ReviewCallerResolver;
  tools: readonly string[];
  taskTargetRoles: readonly ReviewRole[];
};

export type ReviewRuntimeLane = {
  workflow: ReviewWorkflow;
  role: ReviewRole;
  taskTarget: string;
};

export const VULNERABILITY_REVIEW_APPROVED_MCP_TOOLS = [
  'ast_grep_dump_syntax_tree',
  'ast_grep_find_code',
  'ast_grep_find_code_by_rule',
  'ast_grep_test_match_code_rule',
  'context7_resolve-library-id',
  'context7_query-docs',
  'grep_app_searchGitHub',
  'websearch_web_search_exa',
] as const;

const VULNERABILITY_DEEP = ['read', 'glob', 'grep', ...VULNERABILITY_REVIEW_APPROVED_MCP_TOOLS] as const;
const DASH_DEEP_LOCAL_TOOLS = ['read', 'glob', 'grep', 'ast_grep_find_code', 'ast_grep_find_code_by_rule'] as const;
const DASH_DEEP_NON_GIT_TOOLS = new Set<string>([...DASH_DEEP_LOCAL_TOOLS, 'skill']);

export const REVIEW_ROLE_POLICIES = {
  'dash-review:primary': {
    workflow: 'dash-review',
    role: 'primary',
    caller: { kind: 'exact-agent', agent: DASH_REVIEW_PRIMARY_AGENT },
    tools: [
      'task', 'question',
      ...REVIEW_UNIVERSAL_METADATA_TOOLS,
      'hive_review_workspace_claim', 'hive_review_workspace_inspect', 'hive_review_workspace_cleanup',
    ],
    taskTargetRoles: ['scope', 'deep'],
  },
  'dash-review:scope': {
    workflow: 'dash-review',
    role: 'scope',
    caller: { kind: 'lane-role', role: 'scope' },
    tools: [...REVIEW_UNIVERSAL_METADATA_TOOLS, 'hive_review_evidence_resolve', 'hive_review_workspace_create'],
    taskTargetRoles: [],
  },
  'dash-review:deep': {
    workflow: 'dash-review',
    role: 'deep',
    caller: { kind: 'lane-role', role: 'deep' },
    tools: [...DASH_DEEP_LOCAL_TOOLS, 'webfetch', 'skill', ...REVIEW_UNIVERSAL_METADATA_TOOLS],
    taskTargetRoles: [],
  },
  'vulnerability-review:primary': {
    workflow: 'vulnerability-review',
    role: 'primary',
    caller: { kind: 'exact-agent', agent: VULNERABILITY_REVIEW_PRIMARY_AGENT },
    tools: ['task', 'question', 'hive_review_workspace_claim', 'hive_review_workspace_inspect', 'hive_review_workspace_cleanup'],
    taskTargetRoles: ['scope-scout', 'baseline', 'specialist', 'falsifier'],
  },
  'vulnerability-review:scope-scout': {
    workflow: 'vulnerability-review',
    role: 'scope-scout',
    caller: { kind: 'lane-role', role: 'scope-scout' },
    tools: [
      ...REVIEW_UNIVERSAL_METADATA_TOOLS,
      'hive_review_evidence_resolve',
      'hive_vulnerability_compare_report_read',
      'hive_review_workspace_create',
      'hive_review_workspace_cleanup',
      ...VULNERABILITY_REVIEW_APPROVED_MCP_TOOLS,
    ],
    taskTargetRoles: [],
  },
  'vulnerability-review:baseline': {
    workflow: 'vulnerability-review',
    role: 'baseline',
    caller: { kind: 'lane-role', role: 'baseline' },
    tools: VULNERABILITY_DEEP,
    taskTargetRoles: [],
  },
  'vulnerability-review:specialist': {
    workflow: 'vulnerability-review',
    role: 'specialist',
    caller: { kind: 'lane-role', role: 'specialist' },
    tools: VULNERABILITY_DEEP,
    taskTargetRoles: [],
  },
  'vulnerability-review:falsifier': {
    workflow: 'vulnerability-review',
    role: 'falsifier',
    caller: { kind: 'lane-role', role: 'falsifier' },
    tools: VULNERABILITY_DEEP,
    taskTargetRoles: [],
  },
} as const satisfies Record<string, ReviewRolePolicy>;

export function reviewRolePolicy(workflow: string, role: string): ReviewRolePolicy | undefined {
  return REVIEW_ROLE_POLICIES[`${workflow}:${role}` as keyof typeof REVIEW_ROLE_POLICIES];
}

export function buildReviewToolConfig(
  policy: ReviewRolePolicy,
  toolInventory: readonly string[],
): Record<string, boolean> {
  const allowed = new Set(policy.tools);
  return Object.fromEntries(toolInventory.map((tool) => [tool, allowed.has(tool)]));
}

export function reviewTaskTargets(
  policy: ReviewRolePolicy,
  runtimeLanes: readonly ReviewRuntimeLane[],
): string[] {
  const roles = new Set<ReviewRole>(policy.taskTargetRoles);
  return runtimeLanes
    .filter((lane) => lane.workflow === policy.workflow && roles.has(lane.role))
    .map((lane) => lane.taskTarget);
}

export function buildReviewPermission(
  policy: ReviewRolePolicy,
  runtimeLanes: readonly ReviewRuntimeLane[] = [],
): Record<string, string | Record<string, string>> {
  const permission: Record<string, string | Record<string, string>> = { '*': 'deny' };
  for (const tool of policy.tools) permission[tool] = 'allow';
  if (policy.tools.includes('task')) {
    permission.task = Object.fromEntries([
      ['*', 'deny'],
      ...reviewTaskTargets(policy, runtimeLanes).map((target) => [target, 'allow']),
    ]);
  }
  return permission;
}

function callerMatchesPolicy(
  policy: ReviewRolePolicy,
  caller: string,
  runtimeLanes: readonly ReviewRuntimeLane[],
): boolean {
  if (policy.caller.kind === 'exact-agent') return caller === policy.caller.agent;
  const role = policy.caller.role;
  return runtimeLanes.some((lane) => lane.workflow === policy.workflow
    && lane.role === role
    && lane.taskTarget === caller);
}

export function resolveReviewCallerPolicy(
  caller: string | undefined,
  runtimeLanes: readonly ReviewRuntimeLane[],
): ReviewRolePolicy | undefined {
  if (!caller) return undefined;
  return Object.values(REVIEW_ROLE_POLICIES).find((policy) => callerMatchesPolicy(policy, caller, runtimeLanes));
}

export function authorizeReviewTool(
  input: {
    workflow: string;
    role: string;
    tool: string;
    caller?: string;
    target?: string;
    evidenceKind?: 'git' | 'inline' | 'local-artifacts';
  },
  runtimeLanes: readonly ReviewRuntimeLane[] = [],
): { allowed: true } | { allowed: false; reason: string } {
  if (input.workflow !== 'dash-review' && input.workflow !== 'vulnerability-review') {
    return { allowed: false, reason: 'unknown workflow' };
  }
  const policy = reviewRolePolicy(input.workflow, input.role);
  if (!policy) return { allowed: false, reason: 'unknown role' };
  if (!input.caller || !callerMatchesPolicy(policy, input.caller, runtimeLanes)) {
    return { allowed: false, reason: 'caller' };
  }
  if (!policy.tools.includes(input.tool)) return { allowed: false, reason: 'unknown tool' };
  if (policy.workflow === 'dash-review' && policy.role === 'deep') {
    if (!input.evidenceKind) return { allowed: false, reason: 'evidence kind' };
    if (input.evidenceKind !== 'git' && !DASH_DEEP_NON_GIT_TOOLS.has(input.tool)) {
      return { allowed: false, reason: 'evidence kind' };
    }
  }
  if (input.tool === 'task') {
    const targets = reviewTaskTargets(policy, runtimeLanes);
    if (!input.target || !targets.includes(input.target)) return { allowed: false, reason: 'target' };
  }
  return { allowed: true };
}
