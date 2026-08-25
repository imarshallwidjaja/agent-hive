import { describe, expect, it } from 'bun:test';
import { buildDashReviewLanes } from './dash-review-lanes.js';

describe('buildDashReviewLanes', () => {
  it('generates advisory-only lanes for inline and artifact evidence', () => {
    const { agents, lanes } = buildDashReviewLanes({
      sources: [{
        name: 'approach-advisor',
        baseAgent: 'approach-advisor',
        description: 'Process and concept advisor',
        prompt: 'Advise on the approach.',
      }],
      existingNames: [],
      hiveTools: ['read', 'glob', 'grep', 'ast_grep_find_code', 'hive_review_workspace_create'],
    });

    expect(lanes).toEqual([expect.objectContaining({
      taskTarget: 'review-approach-advisor',
      baseAgent: 'approach-advisor',
    })]);
    expect(agents['review-approach-advisor']?.prompt).toContain('advisory methodology');
    expect(agents['review-approach-advisor']?.prompt).toContain('inline or artifact evidence');
    expect(agents['review-approach-advisor']?.prompt).toContain('Do not apply implementation code-review semantics');
    expect(agents['review-approach-advisor']?.tools?.ast_grep_find_code).toBe(true);
    expect(agents['review-approach-advisor']?.tools?.hive_review_workspace_create).toBe(false);
  });

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
      hiveTools: ['hive_feature_create', 'hive_context_write', 'hive_git_snapshot', 'hive_review_evidence_resolve', 'hive_review_workspace_create', 'hive_repositories_status', 'hive_plan_read', 'hive_status', 'ast_grep_find_code', 'ast_grep_find_code_by_rule'],
    });

    const scope = agents['review-scout-researcher-2'];
    const code = agents['review-code-reviewer'];

    expect(lanes[0]?.taskTarget).toBe('review-scout-researcher-2');
    expect(lanes[1]?.taskTarget).toBe('review-code-reviewer');
    expect(scope?.tools).not.toHaveProperty('*');
    expect(scope?.tools?.hive_repositories_status).toBe(true);
    expect(scope?.tools?.hive_plan_read).toBe(true);
    expect(scope?.tools?.hive_status).toBe(true);
    expect(scope?.tools?.hive_git_snapshot).toBe(false);
    expect(scope?.tools?.hive_review_evidence_resolve).toBe(true);
    expect(scope?.tools?.hive_review_workspace_create).toBe(true);
    expect(scope?.tools?.hive_feature_create).toBe(false);
    expect(scope?.permission?.['*']).toBe('deny');
    expect(scope?.permission?.bash).toBeUndefined();
    expect(scope?.permission?.edit).toBe('deny');
    expect(scope?.permission?.task).toBe('deny');
    expect(scope?.permission?.delegate).toBe('deny');
    expect(code?.tools?.hive_git_snapshot).toBe(false);
    expect(code?.tools?.ast_grep_find_code).toBe(true);
    expect(code?.tools?.hive_review_workspace_create).toBe(false);
    expect(code?.tools?.hive_repositories_status).toBe(true);
    expect(code?.tools?.hive_plan_read).toBe(true);
    expect(code?.tools?.hive_status).toBe(true);
    expect(code?.permission?.['*']).toBe('deny');
    expect(code?.permission?.bash).toBeUndefined();
    expect(code?.prompt).toContain('enabled dash deep-lane tools');
    expect(code?.prompt).toContain('ast_grep_find_code');
    expect(code?.prompt).toContain('ast_grep_find_code_by_rule');
    expect(code?.prompt).toContain('MCP, Railway, Vercel, and other remote-service tools are not authorized');
    expect(code?.prompt).toContain('Shell');
    expect(code?.prompt).toContain('non-attributable');
    expect(code?.prompt).toContain('generic rollback');
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
      hiveTools: ['hive_repositories_status', 'hive_review_evidence_resolve', 'hive_review_workspace_create', 'hive_status'],
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
    expect(scope.prompt).toContain('universal metadata tools');
    expect(scope.prompt).toContain('`hive_status`');
    expect(scope.prompt).not.toContain('do not call `hive_status`');
    expect(scope.prompt).toContain('omit `repositoryIds`');
    expect(scope.prompt).toContain('exactly three scope states');
    const stateDeclarationStart = scope.prompt.indexOf('For Git evidence use exactly three scope states:');
    const stateDeclaration = scope.prompt.slice(
      stateDeclarationStart,
      scope.prompt.indexOf('.', stateDeclarationStart),
    );
    expect([...stateDeclaration.matchAll(/`(verified PR commits|local snapshot scope|unverified local checkout)`/g)]
      .map((match) => match[1])).toEqual([
        'verified PR commits',
        'local snapshot scope',
        'unverified local checkout',
      ]);
    expect(scope.prompt).toContain('runtime-produced resolution');
    expect(scope.prompt).toContain('runtime owns provider candidate OIDs');
    expect(scope.prompt).toContain('Never retry, authorize fallback, change candidate refs, reconstruct provenance');
    expect(scope.prompt).toContain('missing OID fails when isolated acquisition is unavailable');
    expect(scope.prompt).toContain('dirty-aware change groups');
    expect(scope.prompt).toContain('canonical provenance fingerprint');
    expect(scope.prompt).toContain('Never synthesize provider refs');
    expect(scope.prompt).toContain('Explicit local refs remain strict');
    expect(scope.prompt).toContain('Do not use provider CLI or network lookup');
    expect(scope.prompt).toContain('must not run direct CLI Git object checks');
    expect(scope.prompt).toContain('Never fetch, checkout');
    expect(scope.prompt).toContain('FETCH_HEAD, the index, worktree, or Git configuration');
    expect(scope.prompt).toContain('hive_review_evidence_resolve is the sole evidence-acquisition exception');
    expect(scope.prompt).not.toContain('invoke local Git object checks');
    expect(scope.prompt).not.toContain('You may use normal local CLI');
    expect(scope.prompt).toContain('without claim');
    expect(scope.prompt).toContain('inspect');
    expect(scope.prompt).toContain('cleanup');

    expect(code.description).toContain('Frozen Workspace Review Lane');
    expect(code.prompt).toContain('Frozen Workspace Review Lane');
    expect(code.prompt).toContain('process cwd is live source');
    expect(code.prompt).toContain('explicit frozen absolute');
    expect(code.prompt).toContain('Shell and other tools that can escape');
    expect(code.prompt).toContain('manifest');
    expect(code.prompt).toContain('never guess filenames');
    expect(code.prompt).toContain('ast_grep_find_code');
    expect(code.prompt).toContain('ast_grep_find_code_by_rule');
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
