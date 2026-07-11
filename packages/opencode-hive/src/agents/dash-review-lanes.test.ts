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
      existingNames: ['review-scout-researcher'],
      hiveTools: ['hive_feature_create', 'hive_context_write', 'hive_git_snapshot', 'hive_review_workspace_create', 'hive_repositories_status', 'hive_status'],
    });

    const scope = agents['review-scout-researcher-2'];
    const code = agents['review-code-reviewer'];

    expect(lanes[0]?.taskTarget).toBe('review-scout-researcher-2');
    expect(lanes[1]?.taskTarget).toBe('review-code-reviewer');
    expect(scope?.tools).not.toHaveProperty('*');
    expect(scope?.tools?.hive_repositories_status).toBe(true);
    expect(scope?.tools?.hive_git_snapshot).toBe(true);
    expect(scope?.tools?.hive_review_workspace_create).toBe(true);
    expect(scope?.tools?.hive_feature_create).toBe(false);
    expect(scope?.tools?.hive_status).toBe(false);
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

  it('generates human-readable review aliases from source identity with deterministic collision suffixes', () => {
    const { agents, lanes } = buildDashReviewLanes({
      sources: [{
        name: 'reviewer/security',
        baseAgent: 'code-reviewer',
        description: 'Security lens',
      }, {
        name: 'Reviewer-Security',
        baseAgent: 'code-reviewer',
        description: 'Case collision lens',
      }, {
        name: '42',
        baseAgent: 'code-reviewer',
        description: 'Numeric lens',
      }, {
        name: 'scout-researcher',
        baseAgent: 'scout-researcher',
        description: 'Scope lead',
      }],
      existingNames: ['Review-Scout-Researcher', 'code-reviewer'],
      hiveTools: ['hive_git_snapshot', 'hive_review_workspace_create', 'hive_repositories_status'],
    });

    // Lanes preserve source input order; aliases are assigned by deterministic source-name sort.
    expect(lanes.map((lane) => [lane.sourceAgent, lane.taskTarget])).toEqual([
      ['reviewer/security', 'review-reviewer-security-2'],
      ['Reviewer-Security', 'review-reviewer-security'],
      ['42', 'review-42'],
      ['scout-researcher', 'review-scout-researcher-2'],
    ]);
    expect(Object.keys(agents).sort()).toEqual([
      'review-42',
      'review-reviewer-security',
      'review-reviewer-security-2',
      'review-scout-researcher-2',
    ]);
    expect(agents['review-reviewer-security']?.description).toContain('Reviewer-Security');
    expect(agents['review-reviewer-security-2']?.description).toContain('reviewer/security');
    expect(Object.keys(agents).some((name) => name.includes('__hive_dash_review_lane_'))).toBe(false);
  });

  it('keeps collision suffixes stable across source input order', () => {
    const sourcesA = [{
      name: 'Reviewer-Security',
      baseAgent: 'code-reviewer' as const,
      description: 'B',
    }, {
      name: 'reviewer/security',
      baseAgent: 'code-reviewer' as const,
      description: 'A',
    }];
    const sourcesB = [...sourcesA].reverse();
    const left = buildDashReviewLanes({
      sources: sourcesA,
      existingNames: [],
      hiveTools: [],
    });
    const right = buildDashReviewLanes({
      sources: sourcesB,
      existingNames: [],
      hiveTools: [],
    });

    const leftBySource = Object.fromEntries(left.lanes.map((lane) => [lane.sourceAgent, lane.taskTarget]));
    const rightBySource = Object.fromEntries(right.lanes.map((lane) => [lane.sourceAgent, lane.taskTarget]));
    expect(leftBySource).toEqual(rightBySource);
    expect(leftBySource['Reviewer-Security']).toBe('review-reviewer-security');
    expect(leftBySource['reviewer/security']).toBe('review-reviewer-security-2');
  });

  it('documents frozen-workspace scope and downstream cwd contracts in wrapper prompts', () => {
    const { agents } = buildDashReviewLanes({
      sources: [{
        name: 'scout-researcher',
        baseAgent: 'scout-researcher',
        description: 'Scope lead',
        prompt: '## Persistence\nwrite hive_context_write notes\n## Tools\nresearch',
      }, {
        name: 'code-reviewer',
        baseAgent: 'code-reviewer',
        description: 'Baseline reviewer',
        prompt: 'Review code carefully',
      }],
      existingNames: [],
      hiveTools: ['hive_repositories_status', 'hive_git_snapshot', 'hive_review_workspace_create', 'hive_status'],
    });

    const scope = agents['review-scout-researcher']!;
    const code = agents['review-code-reviewer']!;

    expect(scope.description).toContain('Frozen Workspace Review Lane');
    expect(scope.prompt).toContain('Frozen Workspace Review Lane');
    expect(scope.prompt).not.toContain('DoorDash');
    expect(scope.prompt).not.toContain('## Persistence');
    expect(scope.prompt).not.toContain('hive_context_write');
    expect(scope.prompt).toContain('hive_repositories_status');
    expect(scope.prompt).toContain('first tool call must be `hive_repositories_status`');
    expect(scope.prompt).not.toContain('first Hive tool');
    expect(scope.prompt).toContain('do not call `hive_status`');
    expect(scope.prompt).toContain('omit `repositoryIds`');
    expect(scope.prompt).toContain('without claim');
    expect(scope.prompt).toContain('inspect');
    expect(scope.prompt).toContain('cleanup');

    expect(code.description).toContain('Frozen Workspace Review Lane');
    expect(code.prompt).toContain('Frozen Workspace Review Lane');
    expect(code.prompt).toContain('process cwd is live source');
    expect(code.prompt).toContain('explicit frozen absolute');
    expect(code.prompt).toContain('workdir');
    expect(code.prompt).toContain('project_folder');
    expect(code.prompt).toContain('Never rely on default cwd');
    expect(code.prompt).toContain('manifest');
    expect(code.prompt).toContain('never guess filenames');
  });

  it('keeps final collision aliases within MAX_ALIAS_LENGTH for 4+ digit suffixes', () => {
    const source = 'a'.repeat(80);
    const token = 'a'.repeat(80);
    const existingNames = [
      `review-${token.slice(0, 64 - 'review-'.length)}`,
      ...Array.from({ length: 998 }, (_, index) => {
        const ordinal = index + 2;
        const suffix = `-${ordinal}`;
        const maxTokenLength = 64 - 'review-'.length - suffix.length;
        return `review-${token.slice(0, maxTokenLength)}${suffix}`;
      }),
    ];

    const { lanes } = buildDashReviewLanes({
      sources: [{
        name: source,
        baseAgent: 'code-reviewer',
        description: 'Long alias source',
      }],
      existingNames,
      hiveTools: [],
    });

    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.taskTarget.length).toBeLessThanOrEqual(64);
    expect(lanes[0]!.taskTarget.startsWith('review-')).toBe(true);
    expect(lanes[0]!.taskTarget).toMatch(/-\d{4,}$/);
  });
});
