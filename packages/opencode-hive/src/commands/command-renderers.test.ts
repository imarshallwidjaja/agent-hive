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
};

function createContext(
  overrides: Partial<HiveCommandContext> = {},
): HiveCommandContext {
  return {
    agentMode: 'unified',
    backgroundGuidance: { available: false, reason: 'experiment-disabled' },
    council: DEFAULT_COUNCIL_CONFIG,
    agents: builtInAgents,
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
        expect(output).toContain('Mode:');
        expect(output).toContain('Route:');
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

    for (const command of ['approve-sync-plan', 'compact-summary', 'council-directive'] as const) {
      const output = render(command, 'Investigate command routing', context);

      expect(output).not.toContain('Background:');
      expect(output).not.toContain('task({ background: true');
      expect(output).not.toContain('hive_background_');
    }
  });

  it('uses dedicated-mode route targets and warns that slash commands do not switch agents automatically', () => {
    const context = createContext({ agentMode: 'dedicated' });
    const expectations: Record<HiveCommandKey, string> = {
      interview: 'architect-planner',
      'implementation-brief': 'architect-planner',
      'hive-plan': 'architect-planner',
      'approve-sync-plan': 'swarm-orchestrator',
      'start-execution': 'swarm-orchestrator',
      'council-directive': 'architect-planner',
      council: 'architect-planner',
      'compact-summary': 'scout-researcher',
    };

    for (const command of HIVE_COMMANDS) {
      const output = render(command.key, 'Route this', context);

      expect(output).toContain(`Route: ${expectations[command.key]}`);
      expect(output).toContain('Slash commands do not switch agents automatically');
      expect(output).toContain('delegate or reroute to the target agent and stop if that is not possible');
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
