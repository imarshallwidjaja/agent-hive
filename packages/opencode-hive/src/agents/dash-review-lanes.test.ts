import { describe, expect, it } from 'bun:test';
import { buildDashReviewSafeLanes } from './dash-review-lanes.js';

describe('buildDashReviewSafeLanes', () => {
  it('reserves case-insensitive configured mutable agent names when generating aliases', () => {
    const { agents, lanes } = buildDashReviewSafeLanes({
      sources: [{
        name: 'scout-researcher',
        baseAgent: 'scout-researcher',
        description: 'Scope lead',
      }],
      existingNames: ['__HIVE_DASH_REVIEW_LANE_SCOPE_1'],
      tools: { '*': false, read: true, glob: true, grep: true, task: false, hive_git_snapshot: false },
      scopeTools: { '*': false, read: true, glob: true, grep: true, task: false, hive_git_snapshot: true, hive_repositories_status: true },
    });

    expect(lanes[0]?.taskTarget).toBe('__hive_dash_review_lane_scope_2');
    expect(agents['__hive_dash_review_lane_scope_1']).toBeUndefined();
    expect(agents['__hive_dash_review_lane_scope_2']?.prompt).toContain('hive_repositories_status');
    expect(agents['__hive_dash_review_lane_scope_2']?.prompt).toContain('workspace.json');
    expect(agents['__hive_dash_review_lane_scope_2']?.prompt).toContain('one atomic snapshot set');
    expect(agents['__hive_dash_review_lane_scope_2']?.tools).toEqual({
      '*': false,
      read: true,
      glob: true,
      grep: true,
      task: false,
      hive_git_snapshot: true,
      hive_repositories_status: true,
    });
  });
});
