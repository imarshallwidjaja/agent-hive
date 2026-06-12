import { describe, expect, it } from 'bun:test';
import type { ResolvedCustomAgentConfig } from 'hive-core';
import { FORAGER_BEE_PROMPT } from './forager';
import { CODE_REVIEWER_PROMPT } from './code-reviewer';
import { PLAN_REVIEWER_PROMPT } from './plan-reviewer';
import { APPROACH_ADVISOR_PROMPT } from './approach-advisor';
import { SCOUT_BEE_PROMPT } from './scout';
import { buildCustomSubagents } from './custom-agents';
import { CUSTOM_AGENT_RESERVED_NAMES } from 'hive-core';

describe('buildCustomSubagents', () => {
  it('builds derived subagents for scout, forager, and reviewer bases', () => {
    const scoutPermission = {
      edit: 'deny',
      task: 'deny',
      delegate: 'deny',
      skill: 'allow',
      webfetch: 'allow',
    };
    const foragerPermission = {
      task: 'deny',
      delegate: 'deny',
      skill: 'allow',
    };
    const reviewerPermission = {
      edit: 'deny',
      task: 'deny',
      delegate: 'deny',
      skill: 'allow',
    };

    const baseAgents = {
      'scout-researcher': {
        model: 'base/scout-model',
        temperature: 0.5,
        variant: 'low',
        mode: 'subagent' as const,
        description: 'Base Scout',
        prompt: SCOUT_BEE_PROMPT,
        tools: {
          hive_merge: false,
        },
        permission: scoutPermission,
      },
      'forager-worker': {
        model: 'base/forager-model',
        temperature: 0.3,
        variant: 'medium',
        mode: 'subagent' as const,
        description: 'Base Forager',
        prompt: FORAGER_BEE_PROMPT,
        tools: {
          hive_merge: false,
          hive_status: false,
        },
        permission: foragerPermission,
      },
      'plan-reviewer': {
        model: 'base/plan-model',
        temperature: 0.3,
        variant: 'low',
        mode: 'subagent' as const,
        description: 'Base Plan Reviewer',
        prompt: PLAN_REVIEWER_PROMPT,
        tools: {
          hive_merge: false,
          hive_status: false,
        },
        permission: reviewerPermission,
      },
      'code-reviewer': {
        model: 'base/code-model',
        temperature: 0.3,
        variant: 'low',
        mode: 'subagent' as const,
        description: 'Base Code Reviewer',
        prompt: CODE_REVIEWER_PROMPT,
        tools: {
          hive_merge: false,
          hive_status: false,
        },
        permission: reviewerPermission,
      },
      'approach-advisor': {
        model: 'base/advisor-model',
        temperature: 0.3,
        variant: 'low',
        mode: 'subagent' as const,
        description: 'Base Approach Advisor',
        prompt: APPROACH_ADVISOR_PROMPT,
        tools: {
          hive_merge: false,
          hive_status: false,
        },
        permission: reviewerPermission,
      },
    };

    const customAgents: Record<string, ResolvedCustomAgentConfig> = {
      'scout-docs': {
        baseAgent: 'scout-researcher',
        description: 'Use for documentation-heavy research tasks.',
        model: 'custom/scout-model',
        temperature: 0.4,
        variant: 'medium',
        autoLoadSkills: [],
      },
      'forager-ui': {
        baseAgent: 'forager-worker',
        description: 'Use for UI-heavy implementation tasks.',
        model: 'custom/model',
        temperature: 0.2,
        variant: 'high',
        autoLoadSkills: ['test-driven-development'],
      },
      'reviewer-security': {
        baseAgent: 'code-reviewer',
        description: 'Use for security-focused review passes.',
        model: 'base/code-model',
        temperature: 0.3,
        variant: 'low',
        autoLoadSkills: [],
      },
    };

    const derived = buildCustomSubagents({
      customAgents,
      baseAgents,
      autoLoadSkillAppendices: {
        'scout-docs': '\n\n# scout-docs auto-load guidance',
        'forager-ui': '\n\n# forager-ui auto-load guidance',
      },
    });

    expect(derived['scout-docs'].mode).toBe('subagent');
    expect(derived['scout-docs'].prompt).toContain(SCOUT_BEE_PROMPT);
    expect(derived['scout-docs'].prompt).toContain('# scout-docs auto-load guidance');
    expect(derived['scout-docs'].permission).toEqual(baseAgents['scout-researcher'].permission);
    expect(derived['scout-docs'].tools).toEqual(baseAgents['scout-researcher'].tools);
    expect(derived['scout-docs'].description).toBe('Use for documentation-heavy research tasks.');
    expect(derived['scout-docs'].model).toBe('custom/scout-model');
    expect(derived['scout-docs'].temperature).toBe(0.4);
    expect(derived['scout-docs'].variant).toBe('medium');

    expect(derived['forager-ui'].mode).toBe('subagent');
    expect(derived['forager-ui'].prompt).toContain(FORAGER_BEE_PROMPT);
    expect(derived['forager-ui'].prompt).toContain('# forager-ui auto-load guidance');
    expect(derived['forager-ui'].permission).toEqual(baseAgents['forager-worker'].permission);
    expect(derived['forager-ui'].tools).toEqual(baseAgents['forager-worker'].tools);
    expect(derived['forager-ui'].description).toBe('Use for UI-heavy implementation tasks.');
    expect(derived['forager-ui'].model).toBe('custom/model');
    expect(derived['forager-ui'].temperature).toBe(0.2);
    expect(derived['forager-ui'].variant).toBe('high');

    expect(derived['reviewer-security'].mode).toBe('subagent');
    expect(derived['reviewer-security'].prompt).toContain(CODE_REVIEWER_PROMPT);
    expect(derived['reviewer-security'].permission).toEqual(baseAgents['code-reviewer'].permission);
    expect(derived['reviewer-security'].tools).toEqual(baseAgents['code-reviewer'].tools);
    expect(derived['reviewer-security'].description).toBe('Use for security-focused review passes.');
    expect(derived['reviewer-security'].model).toBe('base/code-model');
  });

  it('registers custom forager runtime prompts when the base forager prompt is runtime-only', () => {
    const registeredRuntimePrompts: Record<string, string> = {};
    const baseAgents = {
      'scout-researcher': {
        mode: 'subagent' as const,
        description: 'Base Scout',
        prompt: SCOUT_BEE_PROMPT,
      },
      'forager-worker': {
        mode: 'subagent' as const,
        description: 'Base Forager',
        tools: { hive_merge: false },
        permission: { task: 'deny', delegate: 'deny', skill: 'allow' },
      },
      'plan-reviewer': {
        mode: 'subagent' as const,
        description: 'Base Plan Reviewer',
        prompt: PLAN_REVIEWER_PROMPT,
      },
      'code-reviewer': {
        mode: 'subagent' as const,
        description: 'Base Code Reviewer',
        prompt: CODE_REVIEWER_PROMPT,
      },
      'approach-advisor': {
        mode: 'subagent' as const,
        description: 'Base Approach Advisor',
        prompt: APPROACH_ADVISOR_PROMPT,
      },
    };

    const derived = buildCustomSubagents({
      customAgents: {
        'forager-ui': {
          baseAgent: 'forager-worker',
          description: 'Use for UI-heavy implementation tasks.',
          autoLoadSkills: ['test-driven-development'],
        },
      },
      baseAgents: baseAgents as any,
      baseRuntimePrompts: {
        'forager-worker': `${FORAGER_BEE_PROMPT}\n\n# Base forager skills`,
      },
      autoLoadSkillAppendices: {
        'forager-ui': '\n\n# forager-ui auto-load guidance',
      },
      registerRuntimePrompt: (agentName: string, prompt: string) => {
        registeredRuntimePrompts[agentName] = prompt;
      },
    } as any);

    expect(derived['forager-ui'].prompt).toBeUndefined();
    expect(derived['forager-ui'].description).toBe('Use for UI-heavy implementation tasks.');
    expect(derived['forager-ui'].permission).toEqual(baseAgents['forager-worker'].permission);
    expect(registeredRuntimePrompts['forager-ui']).toContain(FORAGER_BEE_PROMPT);
    expect(registeredRuntimePrompts['forager-ui']).toContain('# Base forager skills');
    expect(registeredRuntimePrompts['forager-ui']).toContain('# forager-ui auto-load guidance');
    expect(registeredRuntimePrompts['forager-ui']).not.toContain('Use for UI-heavy implementation tasks.');
  });
});

describe('CUSTOM_AGENT_RESERVED_NAMES', () => {
  it('includes hive-builder and builder as reserved names', () => {
    expect(CUSTOM_AGENT_RESERVED_NAMES).toContain('hive-builder');
    expect(CUSTOM_AGENT_RESERVED_NAMES).toContain('builder');
  });

  it('hive-builder and builder would be filtered by reserved-name check', () => {
    const reservedSet = new Set<string>(CUSTOM_AGENT_RESERVED_NAMES as readonly string[]);
    expect(reservedSet.has('hive-builder')).toBe(true);
    expect(reservedSet.has('builder')).toBe(true);
  });
});
