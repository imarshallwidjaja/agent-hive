import { describe, expect, it } from 'bun:test';
import {
  REVIEW_ROLE_POLICIES,
  authorizeReviewTool,
  buildReviewPermission,
  buildReviewToolConfig,
} from './review-tool-policy.js';
import { REVIEW_SOURCE_RESOLUTION_ADAPTERS } from './review-source-resolution.js';
import { HIVE_COMMANDS } from './commands/registry.js';

const approvedMcp = 'ast_grep_find_code';
const privateReviewCommandCoverage = {
  'dash-review': 'dash-review',
  'vuln-review': 'vulnerability-review',
} as const;
const runtimeLanes = [
  { workflow: 'dash-review', role: 'scope', taskTarget: 'dash-scope' },
  { workflow: 'dash-review', role: 'deep', taskTarget: 'dash-deep' },
  { workflow: 'vulnerability-review', role: 'scope-scout', taskTarget: 'vuln-scope' },
  { workflow: 'vulnerability-review', role: 'baseline', taskTarget: 'vuln-baseline' },
  { workflow: 'vulnerability-review', role: 'specialist', taskTarget: 'vuln-specialist' },
  { workflow: 'vulnerability-review', role: 'falsifier', taskTarget: 'vuln-falsifier' },
] as const;

describe('shared fail-closed review tool policy', () => {
  it('covers every private review command role with one static and runtime policy', () => {
    expect(Object.keys(REVIEW_ROLE_POLICIES).sort()).toEqual([
      'dash-review:deep',
      'dash-review:primary',
      'dash-review:scope',
      'vulnerability-review:baseline',
      'vulnerability-review:falsifier',
      'vulnerability-review:primary',
      'vulnerability-review:scope-scout',
      'vulnerability-review:specialist',
    ]);
    for (const policy of Object.values(REVIEW_ROLE_POLICIES)) {
      expect(buildReviewToolConfig(policy, [...policy.tools, 'unknown_tool']).unknown_tool).toBe(false);
      expect(buildReviewPermission(policy)['*']).toBe('deny');
    }
    expect(Object.keys(REVIEW_SOURCE_RESOLUTION_ADAPTERS)).toEqual(['dash-review', 'vulnerability-review']);
    const privateCommands = HIVE_COMMANDS
      .filter((command) => 'agent' in command && command.agent.startsWith('__hive_'))
      .map((command) => command.key);
    expect(privateCommands).toEqual(Object.keys(privateReviewCommandCoverage));
    for (const command of Object.keys(privateReviewCommandCoverage) as Array<keyof typeof privateReviewCommandCoverage>) {
      const workflow = privateReviewCommandCoverage[command];
      expect(privateCommands).toContain(command);
      expect(REVIEW_SOURCE_RESOLUTION_ADAPTERS[workflow]).toBeFunction();
      expect(REVIEW_ROLE_POLICIES[`${workflow}:primary`]).toMatchObject({ workflow, role: 'primary' });
    }
  });

  it('defines exact caller resolvers and allowed task-target roles in policy', () => {
    expect(REVIEW_ROLE_POLICIES['dash-review:primary']).toMatchObject({
      caller: { kind: 'exact-agent', agent: '__hive_dash_review_primary' },
      taskTargetRoles: ['scope', 'deep'],
    });
    expect(REVIEW_ROLE_POLICIES['dash-review:scope']).toMatchObject({
      caller: { kind: 'lane-role', role: 'scope' },
      taskTargetRoles: [],
    });
    expect(REVIEW_ROLE_POLICIES['vulnerability-review:primary']).toMatchObject({
      caller: { kind: 'exact-agent', agent: '__hive_vulnerability_review_primary' },
      taskTargetRoles: ['scope-scout', 'baseline', 'specialist', 'falsifier'],
    });
  });

  it('preserves exact dash role differences without capability unions', () => {
    const primary = REVIEW_ROLE_POLICIES['dash-review:primary'];
    const scope = REVIEW_ROLE_POLICIES['dash-review:scope'];
    const deep = REVIEW_ROLE_POLICIES['dash-review:deep'];

    expect(primary.tools).toEqual([
      'read', 'glob', 'grep', 'bash', 'webfetch', 'task', 'question', 'skill',
      'hive_repositories_status', 'hive_plan_read', 'hive_status',
      'hive_review_workspace_claim', 'hive_review_workspace_inspect', 'hive_review_workspace_cleanup',
    ]);
    expect(scope.tools).toEqual([
      'hive_repositories_status', 'hive_plan_read', 'hive_status',
      'hive_git_snapshot', 'hive_review_workspace_create',
    ]);
    expect(deep.tools).toEqual([
      'read', 'glob', 'grep', 'bash', 'webfetch', 'skill',
      'hive_repositories_status', 'hive_plan_read', 'hive_status',
    ]);
  });

  it('preserves vulnerability role differences including compare and cleanup', () => {
    expect(REVIEW_ROLE_POLICIES['vulnerability-review:scope-scout'].tools).toEqual([
      'hive_repositories_status', 'hive_plan_read', 'hive_status', 'hive_git_snapshot',
      'hive_vulnerability_compare_report_read', 'hive_review_workspace_create',
      'hive_review_workspace_cleanup',
      'ast_grep_dump_syntax_tree', 'ast_grep_find_code', 'ast_grep_find_code_by_rule',
      'ast_grep_test_match_code_rule', 'context7_resolve-library-id', 'context7_query-docs',
      'grep_app_searchGitHub', 'websearch_web_search_exa',
    ]);
    expect(REVIEW_ROLE_POLICIES['vulnerability-review:baseline'].tools).toContain(approvedMcp);
    expect(REVIEW_ROLE_POLICIES['vulnerability-review:baseline'].tools).not.toContain('hive_review_workspace_cleanup');
    expect(REVIEW_ROLE_POLICIES['vulnerability-review:primary'].tools).toEqual([
      'task', 'question', 'hive_review_workspace_claim', 'hive_review_workspace_inspect', 'hive_review_workspace_cleanup',
    ]);
  });

  it.each([
    [{ workflow: 'unknown', role: 'primary', tool: 'read', caller: 'agent' }, 'unknown workflow'],
    [{ workflow: 'dash-review', role: 'unknown', tool: 'read', caller: '__hive_dash_review_primary' }, 'unknown role'],
    [{ workflow: 'dash-review', role: 'deep', tool: 'unknown_tool', caller: 'dash-deep' }, 'unknown tool'],
    [{ workflow: 'dash-review', role: 'deep', tool: 'unknown_user_mcp', caller: 'dash-deep' }, 'unknown tool'],
    [{ workflow: 'dash-review', role: 'primary', tool: 'task', caller: '__hive_dash_review_primary', target: 'forager' }, 'target'],
    [{ workflow: 'dash-review', role: 'primary', tool: 'task', target: 'dash-scope' }, 'caller'],
    [{ workflow: 'dash-review', role: 'scope', tool: 'hive_git_snapshot', caller: 'dash-scope-extra' }, 'caller'],
  ] as const)('denies fail-closed input: %j', (input, reason) => {
    expect(authorizeReviewTool(input as never, runtimeLanes)).toEqual({ allowed: false, reason });
  });

  it('requires an exact authorized task target and known caller', () => {
    expect(authorizeReviewTool({
      workflow: 'dash-review', role: 'primary', tool: 'task', caller: '__hive_dash_review_primary', target: 'dash-scope',
    }, runtimeLanes)).toEqual({ allowed: true });
    expect(authorizeReviewTool({
      workflow: 'vulnerability-review', role: 'primary', tool: 'task', caller: '__hive_vulnerability_review_primary', target: 'vuln-scope-extra',
    }, runtimeLanes)).toEqual({ allowed: false, reason: 'target' });
  });
});
