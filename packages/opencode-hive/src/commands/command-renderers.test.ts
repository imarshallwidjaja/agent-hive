import { describe, expect, it } from 'bun:test';
import { DEFAULT_COUNCIL_CONFIG, type CouncilConfig } from 'hive-core';
import { HIVE_COMMANDS, type HiveCommandKey } from './registry.js';
import { hiveCommandRenderers } from './renderers.js';
import { resolveCouncilMembers } from './council.js';
import type { HiveCommandAgentDescriptor, HiveCommandContext } from './types.js';

const builtInAgents: Record<string, HiveCommandAgentDescriptor> = {
  'hive-master': {
    baseAgent: 'hive-master',
    available: true,
    description: 'Hive hybrid planner and orchestrator',
    readOnlyCouncilEligible: false,
  },
  'architect-planner': {
    baseAgent: 'architect-planner',
    available: true,
    description: 'Planning-only agent',
    readOnlyCouncilEligible: false,
  },
  'swarm-orchestrator': {
    baseAgent: 'swarm-orchestrator',
    available: true,
    description: 'Execution orchestrator',
    readOnlyCouncilEligible: false,
  },
  'scout-researcher': {
    baseAgent: 'scout-researcher',
    available: true,
    description: 'Read-only code and docs researcher',
    readOnlyCouncilEligible: true,
  },
  'plan-reviewer': {
    baseAgent: 'plan-reviewer',
    available: true,
    description: 'Read-only plan reviewer',
    readOnlyCouncilEligible: true,
  },
  'code-reviewer': {
    baseAgent: 'code-reviewer',
    available: true,
    description: 'Read-only code reviewer',
    readOnlyCouncilEligible: true,
  },
  'simplicity-reviewer': {
    baseAgent: 'simplicity-reviewer',
    available: true,
    description: 'Read-only simplicity reviewer',
    readOnlyCouncilEligible: true,
  },
  'approach-advisor': {
    baseAgent: 'approach-advisor',
    available: true,
    description: 'Read-only approach advisor',
    readOnlyCouncilEligible: true,
  },
  'forager-worker': {
    baseAgent: 'forager-worker',
    available: true,
    description: 'Mutable worker',
    readOnlyCouncilEligible: false,
  },
  'hive-helper': {
    baseAgent: 'hive-helper',
    available: true,
    description: 'Mutable helper',
    readOnlyCouncilEligible: false,
  },
  'hive-builder': {
    baseAgent: 'hive-builder',
    available: true,
    description: 'Ad-hoc executor',
    readOnlyCouncilEligible: false,
  },
  'dash-reviewer': {
    baseAgent: 'dash-reviewer',
    available: true,
    description: 'Read-only implementation review orchestrator',
    readOnlyCouncilEligible: false,
  },
};

function createContext(
  overrides: Partial<HiveCommandContext> = {},
): HiveCommandContext {
  return {
    agentMode: 'unified',
    backgroundGuidance: { available: false, reason: 'experiment-disabled' },
    council: DEFAULT_COUNCIL_CONFIG,
    agents: builtInAgents,
    dashReviewLanes: [],
    ...overrides,
  };
}

function render(command: HiveCommandKey, args = '', context: HiveCommandContext = createContext()): string {
  const output = hiveCommandRenderers[command](args, context);
  expect(output).toBeString();
  return output as string;
}

describe('hive command renderers', () => {
  it('returns structured non-empty guidance for every command with empty and non-empty args', () => {
    for (const command of HIVE_COMMANDS) {
      for (const args of ['', 'Investigate the flaky restore path']) {
        const output = render(command.key, args);

        expect(output.trim()).not.toBe('');
        expect(output).toContain('Do:');
        expect(output).toContain('Do not:');
        expect(output).toContain('Output expected:');
      }
    }
  });

  it('keeps gate-closed command text free of background orchestration protocol terms', () => {
    const forbidden = [
      'task({ background: true',
      'background-first',
      'hive_background_',
      'reconcile',
      'native completion',
    ];

    for (const command of HIVE_COMMANDS) {
      const output = render(command.key, 'Draft a route');

      for (const term of forbidden) {
        expect(output).not.toContain(term);
      }
    }
  });

  it('adds short gate-open guidance only where parallel background lanes are useful', () => {
    const context = createContext({
      backgroundGuidance: { available: true },
    });

    for (const command of ['interview', 'hive-plan', 'start-execution', 'council'] as const) {
      const output = render(command, 'Investigate command routing', context);

      expect(output).toContain('Background:');
      expect(output).toMatch(/independent .*background/i);
    }

    for (const command of ['approve-sync-plan', 'compact-summary', 'council-directive', 'dash-review'] as const) {
      const output = render(command, 'Investigate command routing', context);

      expect(output).not.toContain('Background:');
      expect(output).not.toContain('task({ background: true');
      expect(output).not.toContain('hive_background_');
    }
  });

  it('adds interview-specific gate-open timing and guardrail guidance', () => {
    const context = createContext({
      backgroundGuidance: { available: true },
    });

    const output = render('interview', 'shape the release flow', context);

    expect(output).toContain('After 2-3 clarifying questions');
    expect(output).toContain('concrete, self-contained validation questions');
    expect(output).toContain('will not be contradicted by remaining open interview questions');
    expect(output).toContain('Do not report background results mid-interview');
    expect(output).toContain('natural pause');
    expect(output).toContain('Distinguish validated facts from pending assumptions');
  });

  it('does not render dedicated-mode route prose', () => {
    const context = createContext({ agentMode: 'dedicated' });

    for (const command of HIVE_COMMANDS) {
      const output = render(command.key, 'Route this', context);

      expect(output).not.toContain('Mode:');
      expect(output).not.toContain('Route:');
      expect(output).not.toContain('Slash commands do not switch agents automatically');
      expect(output).not.toContain('delegate or reroute to the target agent and stop if that is not possible');
    }
  });

  it('parses council groups deterministically and does not infer a group from the directive text', () => {
    const context = createContext();

    expect(render('council', '--group design choose the API shape', context)).toContain('Group: design');
    expect(render('council', 'design choose the API shape', context)).toContain('Group: decision');
    expect(render('council', 'design choose the API shape', context)).toContain('Directive: design choose the API shape');
    expect(render('council', '--unknown decision support', context)).toContain('Usage: /council [--group <group>] <directive>');
  });

  it('renders council read-only contracts without leaking example-template custom agents from defaults', () => {
    const output = render('council', 'decide the safest option');

    expect(output).toContain('Read-only contract:');
    expect(output).toContain('must not edit files, apply patches, commit, create Hive plans, or create worktrees');
    expect(output).toContain('architect-planner must not call planning write tools during a council run');
    expect(output).not.toContain('Cursor');
    expect(output).not.toContain('example-template');
  });

  it('anchors interview behavior: one question, running summary, implementation-brief handoff', () => {
    const output = render('interview', 'new feature idea');
    expect(output).toContain('Ask exactly one question at a time');
    expect(output).toContain('running summary');
    expect(output).toContain('## Interview Summary');
    expect(output).toContain('/implementation-brief');
    expect(output).toMatch(/highest-ambiguity|highest-risk|highest-value/);
    expect(output).toContain('Prioritize collecting');
    expect(output).toContain('needs validation');
    expect(output).toContain('brainstorming, exploring options');
    expect(output).toContain('2-4 concise options');
    expect(output).toContain('## Context For `/implementation-brief`');
    expect(output).toContain('parity, migration, or compatibility concerns');
  });

  it('anchors implementation-brief: revalidate repo, /hive-plan handoff, and separate body/wrapper contracts', () => {
    const output = render('implementation-brief', 'restore commands');
    const parts = output.split('\n---\n');
    expect(parts.length).toBe(2);
    const wrapperSection = parts[0];
    const bodySection = parts[1];

    expect(wrapperSection).toContain('Revalidate');
    expect(wrapperSection).toContain('/hive-plan');
    expect(wrapperSection).toContain('copy-paste-ready');
    expect(wrapperSection).toContain('during brief generation');
    expect(output).not.toContain('another agent to make the real implementation plan');
    expect(output).not.toContain('final prompt');
    expect(output).toContain('final brief');
    expect(output).toContain('directional goals');
    expect(output).toContain('validate every assumption against the live codebase');
    expect(bodySection).not.toMatch(/Do not call.*hive_plan_write/);
  });

  it('anchors hive-plan: discovery, hive tools, and operator-facing completion sections', () => {
    const output = render('hive-plan', 'spec body');
    expect(output).toContain('active discovery');
    expect(output).toContain('hive_plan_write');
    expect(output).toContain('session strategy');
    expect(output).toContain('documentation updates');
    expect(output).toContain('parallelized cleanly');
    expect(output).toContain('do not send a follow-up prompt to that session');
    expect(output).toContain('narrower scopes');
    expect(output).toContain('pre-trained knowledge only as guidance');
    expect(output).toContain('hive_feature_create');
    expect(output).toContain('hive_plan_read');
    expect(output).toContain('one primary goal');
    expect(output).toContain('fresh subagent session');
    expect(output).toContain('complete constraints and acceptance criteria only for that goal');
  });

  it('anchors approve-sync-plan workflow sections and exact blocker stop', () => {
    const output = render('approve-sync-plan', 'go fast');
    expect(output).toContain('hive_plan_approve');
    expect(output).toContain('hive_tasks_sync');
    expect(output).toContain('## Session Strategy');
    expect(output).toContain('exact blocker');
    expect(output).toContain('context-load risk');
    expect(output).toContain('fewest reasonable execution sessions');
    expect(output).toContain('what done looks like');
    expect(output).toContain('recommended default');
    expect(output).toContain('hive_status');
    expect(output).toContain('avoid generic advice');
  });

  it('anchors start-execution: confirm strategy and worker commit boundary', () => {
    const output = render('start-execution', '');
    expect(output).toMatch(/parallel|sequential/i);
    expect(output).toContain('hive_worktree_commit');
    expect(output).toContain('orchestrator must not call `hive_worktree_commit`');
    expect(output).toContain('Work autonomously through the tasks');
    expect(output).toContain('salvageable');
    expect(output).toContain('hive_worktree_start');
    expect(output).toContain('hive_merge');
    expect(output).toContain('todo list');
    expect(output).toContain('Default to `strategy: "squash"`');
    expect(output).toContain('Preserve one root commit per completed task');
    expect(output).toContain('review and fix iterations into that squash commit');
    expect(output).toContain('subject, a blank line, and a descriptive body');
    expect(output).not.toContain('Prefer `strategy: "rebase"`');
    expect(output).toContain('Do not use `hive`, task numbers, task folder names, run IDs, or "merge task" prose');
    expect(output).toContain('new worker session in the same worktree');
    expect(output).toContain('concise self-contained handoff');
    expect(output).toContain('Compaction may re-anchor a currently running worker; it is not re-delegation');
  });

  it('anchors council-directive: no council run, one question max 4, directive fields', () => {
    const output = render('council-directive', 'rough ask');
    expect(output).toContain('Do not run council');
    expect(output).toContain('one question at a time');
    expect(output).toContain('max 4');
    expect(output).toContain('## Council Directive');
    expect(output).toContain('## Paste Into New Chat');
    expect(output).toContain('smallest directive');
    expect(output).toContain('session mode');
    expect(output).toContain('configured council group');
    expect(output).not.toContain('forager-smart');
    expect(output).not.toContain('approach-advisor-xhigh-reasoning');
  });

  it('anchors council synthesis sections and read-only normalization', () => {
    const output = render('council', 'pick the safer API');
    expect(output).toContain('## Council Result');
    expect(output).toContain('## Disagreement');
    expect(output).toContain('at most 2 clarification questions');
    expect(output).not.toContain('forager-smart');
    expect(output).not.toContain('approach-advisor-xhigh-reasoning');
    expect(output).toContain('read-only council session');
    expect(output).toContain('one-paragraph verdict');
    expect(output).toContain('do not average vague opinions');
    expect(output).toContain('smallest useful set');
    expect(output).toContain('## Agreement');
    expect(output).toContain('## Suggested Next Step');
    expect(output).not.toContain('Council aliases:');
  });

  it('renders dash-review as a frozen disposable-workspace implementation review', () => {
    const output = render('dash-review', 'feature/retry-restore');

    expect(output).toContain('Target: feature/retry-restore');
    expect(output).toContain('frozen-workspace implementation review');
    expect(output).not.toContain('DoorDash');
    expect(output).toContain('scope/lead scout');
    expect(output).toContain('materialize');
    expect(output).toContain('serialized verification');
    expect(output).toContain('unconditional falsifier');
    expect(output).toContain('post-review inspection');
    expect(output).toContain('unconditional cleanup');
    expect(output).toContain('description, base agent, model, and variant');
    expect(output).toContain('parallel blocking `task()` calls only');
    expect(output).toContain('Scope Reviewed');
    expect(output).toContain('REQUEST_CHANGES');
    expect(output).toContain('No implementation files');
    expect(output).toContain('wait for operator instruction');
    expect(output).toContain('Review Execution Integrity');
    expect(output).toContain('self-reported');
    expect(output).toContain('non-attributable');
    expect(output).toContain('generic rollback');
    expect(output).toContain('structured command transcript');
    expect(output).toContain('hive_review_workspace_claim');
    expect(output).toContain('before deep review lanes');
  });

  it('renders dash-review routing from configured reviewer descriptors without hardcoded specialist names', () => {
    const specialistName = ['reviewer', 'security'].join('-');
    const context = createContext({
      dashReviewLanes: [{
        taskTarget: 'review-reviewer-security',
        sourceAgent: specialistName,
        baseAgent: 'code-reviewer',
        description: 'Security and public API risk reviewer',
        model: 'provider/reasoning',
        variant: 'xhigh',
      }],
    });

    const output = render('dash-review', 'api change', context);

    expect(output).toContain(specialistName);
    expect(output).toContain('Security and public API risk reviewer');
    expect(output).toContain('provider/reasoning');
    expect(output).toContain('xhigh');
    expect(output).toContain('review-reviewer-security');
    expect(output).toContain('Task target');
  });

  it('keeps dash-review blocking-only and leaves fixed policy to COMMAND_BEHAVIOR in both gate modes', () => {
    for (const backgroundGuidance of [{ available: false, reason: 'experiment-disabled' } as const, { available: true }]) {
      const output = render('dash-review', 'api change', createContext({ backgroundGuidance }));
      const [wrapper, behavior] = output.split('\n\n---\n\n');

      expect(wrapper).toContain('Target: api change');
      expect(wrapper).toContain('appended canonical review contract');
      expect(wrapper).not.toContain('parallel blocking `task()` calls only');
      expect(wrapper).not.toContain('primary-side Git inspection');
      expect(wrapper).not.toContain('Stage A');
      expect(wrapper).not.toContain('REQUEST_CHANGES');
      expect(behavior).toContain('Stage A');
      expect(behavior).toContain('Stage C');
      expect(output).not.toContain('task({ background: true');
      expect(output).not.toContain('hive_background_');
      expect(output).not.toContain('native completion');
    }
  });

  it('keeps workspace materialization separate from downstream workspace-only review contracts', () => {
    const output = render('dash-review', 'api change');
    const bootstrap = output.slice(
      output.indexOf('Workspace execution contract:'),
      output.indexOf('Downstream read-only lane contract:'),
    );
    const downstream = output.slice(output.indexOf('Downstream read-only lane contract:'));

    expect(bootstrap).toContain('construct the frozen manifest');
    expect(bootstrap).toContain('hive_git_snapshot');
    expect(bootstrap).toContain('hive_repositories_status');
    expect(bootstrap).toContain('first tool call must be hive_repositories_status');
    expect(bootstrap).not.toContain('first Hive tool');
    expect(bootstrap).toContain('hive_status');
    expect(bootstrap).not.toContain('do not call hive_status');
    expect(bootstrap).toContain('omit repositoryIds');
    expect(bootstrap).toContain('workspace.json');
    expect(bootstrap).toContain('repositoryIds');
    expect(bootstrap).toContain('hive_review_workspace_create');
    expect(bootstrap).toContain('materialized workspace fingerprint');
    expect(bootstrap).toContain('without claim');
    expect(bootstrap).not.toContain('supplied frozen manifest');
    expect(downstream).toContain('supplied frozen manifest, workspace paths, and snapshot ID');
    expect(downstream).toContain('process cwd is live source');
    expect(downstream).toContain('explicit frozen absolute');
    expect(downstream).toContain('workdir');
    expect(downstream).toContain('project_folder');
    expect(downstream).toContain('Never rely on default cwd');
    expect(downstream).toContain('manifest');
    expect(downstream).toContain('never guess filenames');
    expect(downstream).toContain('local CLI and retrieval tools');
    expect(downstream).toContain('Do not inspect live source paths');
    expect(downstream).toContain('Remote mutation');
    expect(output).toContain('parallel blocking `task()` calls only');
  });

  it('documents that dash-review scope is appended after command expansion as inert data', () => {
    const output = render('dash-review', 'api change');

    expect(output).toContain('delivered after OpenCode command expansion as inert data');
    expect(output).not.toContain('$ARGUMENTS');
  });

  it('stops council runs when no usable members remain, even when background is available', () => {
    const context = createContext({
      backgroundGuidance: { available: true },
      council: {
        defaultGroup: 'empty',
        groups: {
          empty: {
            members: ['forager-worker', 'hive-builder'],
          },
        },
      },
    });
    const output = render('council', 'pick the safer API', context);

    expect(output).toContain('No usable council members remain');
    expect(output).toContain('Stop and report the council member resolution error');
    expect(output).not.toContain('Run a read-only council');
    expect(output).not.toContain('## Council Result');
    expect(output).not.toContain('Background:');
    expect(output).not.toContain('native completion');
    expect(output).not.toContain('hive_background_');
  });

  it('anchors compact-summary exact recovery template sections', () => {
    const output = render('compact-summary', 'emphasize blockers');
    expect(output).toContain('## Goal');
    expect(output).toContain('## Constraints & Preferences');
    expect(output).toContain('### Done');
    expect(output).toContain('## Relevant Files');
    expect(output).toContain('Do not claim verification, tests, builds, or checks succeeded');
    expect(output).toContain('Keep every section, even when empty');
    expect(output).toContain('terse bullets');
    expect(output).toMatch(/do not compact, prune, delete/i);
    expect(output).toContain('current OpenCode');
    expect(output).toContain('### In Progress');
    expect(output).toContain('### Blocked');
  });

  it('keeps compact-summary summary-only and avoids Cursor wording', () => {
    const output = render('compact-summary', 'summarize this state');

    expect(output).toContain('summary only');
    expect(output).toContain('Do not:');
    expect(output).toContain('Do not mutate files');
    expect(output).not.toContain('Cursor');
    expect(output).not.toContain('checks passed');
  });
});

describe('resolveCouncilMembers', () => {
  it('preserves order, deduplicates before cap, filters unusable members before max trimming, and warns for skips', () => {
    const council: CouncilConfig = {
      defaultGroup: 'review',
      maxMembers: 1,
      excludedAgents: ['plan-reviewer'],
      groups: {
        review: {
          members: [
            'unknown-agent',
            'forager-ui',
            'reviewer-example-template',
            'disabled-reviewer',
            'plan-reviewer',
            'scout-researcher',
            'scout-researcher',
            'approach-advisor',
            'code-reviewer',
          ],
          maxMembers: 2,
        },
      },
    };
    const agents: Record<string, HiveCommandAgentDescriptor> = {
      ...builtInAgents,
      'forager-ui': {
        baseAgent: 'forager-worker',
        available: true,
        description: 'Custom mutable implementation worker',
        readOnlyCouncilEligible: false,
      },
      'reviewer-example-template': {
        baseAgent: 'code-reviewer',
        available: true,
        description: 'Example template only: rename before use.',
        readOnlyCouncilEligible: true,
      },
      'disabled-reviewer': {
        baseAgent: 'code-reviewer',
        available: false,
        description: 'Temporarily unavailable reviewer',
        readOnlyCouncilEligible: true,
      },
    };

    const result = resolveCouncilMembers(council, agents, 'review');

    expect(result.error).toBeUndefined();
    expect(result.groupName).toBe('review');
    expect(result.members.map((member) => member.name)).toEqual(['scout-researcher', 'approach-advisor']);
    expect(result.maxMembers).toBe(2);
    expect(result.warnings).toContain('Skipped unknown-agent: not registered for this agent mode.');
    expect(result.warnings).toContain('Skipped forager-ui: base agent forager-worker is mutable and not council-eligible.');
    expect(result.warnings).toContain('Skipped reviewer-example-template: example-template custom agents are not usable council seats.');
    expect(result.warnings).toContain('Skipped disabled-reviewer: agent is not available in the current command context.');
    expect(result.warnings).toContain('Skipped plan-reviewer: excluded by council configuration.');
    expect(result.warnings).toContain('Skipped duplicate scout-researcher: first occurrence already selected.');
  });

  it('falls back to the default group when the requested group has no usable seats and stops when fallback is empty', () => {
    const fallbackCouncil: CouncilConfig = {
      defaultGroup: 'decision',
      groups: {
        empty: { members: ['forager-worker'] },
        decision: { members: ['code-reviewer'] },
      },
    };

    const fallbackResult = resolveCouncilMembers(fallbackCouncil, builtInAgents, 'empty');

    expect(fallbackResult.error).toBeUndefined();
    expect(fallbackResult.groupName).toBe('decision');
    expect(fallbackResult.fallbackFrom).toBe('empty');
    expect(fallbackResult.members.map((member) => member.name)).toEqual(['code-reviewer']);
    expect(fallbackResult.warnings).toContain('Group empty had no usable council seats; falling back to default group decision.');

    const emptyCouncil: CouncilConfig = {
      defaultGroup: 'decision',
      groups: {
        empty: { members: ['forager-worker'] },
        decision: { members: ['hive-master'] },
      },
    };
    const emptyResult = resolveCouncilMembers(emptyCouncil, builtInAgents, 'empty');

    expect(emptyResult.members).toEqual([]);
    expect(emptyResult.error).toBe('No usable council members remain for requested group empty or fallback group decision.');
  });
});
