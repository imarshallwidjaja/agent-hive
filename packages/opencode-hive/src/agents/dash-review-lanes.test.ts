import { describe, expect, it } from 'bun:test';
import { buildDashReviewLanes } from './dash-review-lanes.js';

describe('buildDashReviewLanes', () => {
  it('preserves normal local tools while denying task recursion and Hive lifecycle mutation', () => {
    const { agents, lanes } = buildDashReviewLanes({
      sources: [{
        name: 'scout-researcher',
        baseAgent: 'scout-researcher',
        description: 'Scope lead',
      }, {
        name: 'code-reviewer',
        baseAgent: 'code-reviewer',
        description: 'Verification reviewer',
      }],
      existingNames: ['__HIVE_DASH_REVIEW_LANE_SCOPE_1'],
      hiveTools: ['hive_feature_create', 'hive_context_write', 'hive_git_snapshot', 'hive_review_workspace_create'],
    });

    const scope = agents['__hive_dash_review_lane_scope_2'];
    const code = agents['__hive_dash_review_lane_code_1'];

    expect(lanes[0]?.taskTarget).toBe('__hive_dash_review_lane_scope_2');
    expect(scope?.tools).not.toHaveProperty('*');
    expect(scope?.tools?.hive_git_snapshot).toBe(true);
    expect(scope?.tools?.hive_review_workspace_create).toBe(true);
    expect(scope?.tools?.hive_feature_create).toBe(false);
    expect(scope?.permission?.bash).toBeUndefined();
    expect(scope?.permission?.edit).toBe('deny');
    expect(scope?.permission?.task).toBe('deny');
    expect(scope?.permission?.delegate).toBe('deny');
    expect(code?.tools?.hive_git_snapshot).toBe(false);
    expect(code?.tools?.hive_review_workspace_create).toBe(false);
    expect(code?.permission?.bash).toBeUndefined();
    expect(code?.prompt).toContain('local CLI and retrieval tools');
    expect(code?.prompt).toContain('Remote mutation');
    expect(code?.prompt).toContain('self-reported');
    expect(code?.prompt).toContain('non-attributable');
    expect(code?.prompt).toContain('generic rollback');
    expect(code?.prompt).toContain('structured command transcript');
  });
});
