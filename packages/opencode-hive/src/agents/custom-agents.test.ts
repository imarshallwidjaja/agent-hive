import { describe, expect, it } from 'bun:test';
import type { ResolvedCustomAgentConfig } from 'hive-core';
import { FORAGER_BEE_PROMPT } from './forager';
import { CODE_REVIEWER_PROMPT } from './code-reviewer';
import { PLAN_REVIEWER_PROMPT, renderPlanReviewerPrompt } from './plan-reviewer';
import { SIMPLICITY_REVIEWER_PROMPT } from './simplicity-reviewer';
import { APPROACH_ADVISOR_PROMPT } from './approach-advisor';
import { VULNERABILITY_REVIEWER_PROMPT } from './vulnerability-reviewer';
import { SCOUT_BEE_PROMPT, renderScoutBeePrompt } from './scout';
import { createHostProfile } from '../runtime/host-profile';
import { renderAutoLoadSkillsAppendix, renderHiveSystemPrompt } from '../hooks/system-hook';
import { buildCustomSubagents } from './custom-agents';
import type { RuntimeSubagentConfig } from './custom-agents';
import { CUSTOM_AGENT_RESERVED_NAMES } from 'hive-core';
import { ENGINEERING_JUDGMENT_PROMPT } from './engineering-judgment';

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

describe('buildCustomSubagents', () => {
  it('derives custom subagents from the prompt rendered for the selected host', () => {
    const permission: RuntimeSubagentConfig['permission'] = { edit: 'deny' };
    for (const host of [createHostProfile('opencode-v1'), createHostProfile('opencode-v2')]) {
      const basePrompt = renderScoutBeePrompt(host) + '\n## host system\n';
      const derived = buildCustomSubagents({
        customAgents: { 'scout-docs': { baseAgent: 'scout-researcher', description: 'Docs research.', autoLoadSkills: [] } },
        baseAgents: { 'scout-researcher': { mode: 'subagent', description: 'Base Scout', prompt: basePrompt, permission } },
        autoLoadSkillAppendices: { 'scout-docs': '\n\n## Configured Auto-Load Skills\n' },
      });
      expect(derived['scout-docs']?.prompt).toBe(`${basePrompt}\n\n## Configured Auto-Load Skills\n`);
      expect(derived['scout-docs']?.prompt).toContain(`\`${host.shell.tool}\` writes`);
      expect(derived['scout-docs']?.permission).toBe(permission);
    }
  });

  it('keeps a custom reviewer on the skill call of the host its base was rendered for', () => {
    const permission: RuntimeSubagentConfig['permission'] = { edit: 'deny' };
    for (const host of [createHostProfile('opencode-v1'), createHostProfile('opencode-v2')]) {
      const basePrompt = renderPlanReviewerPrompt(host) + renderHiveSystemPrompt(host) + renderAutoLoadSkillsAppendix(host, ['verification']);
      const derived = buildCustomSubagents({
        customAgents: { 'plan-reviewer-docs': { baseAgent: 'plan-reviewer', description: 'Docs plans.', autoLoadSkills: ['context-engineering'] } },
        baseAgents: { 'plan-reviewer': { mode: 'subagent', description: 'Base reviewer', prompt: basePrompt, permission } },
        autoLoadSkillAppendices: { 'plan-reviewer-docs': renderAutoLoadSkillsAppendix(host, ['context-engineering']) },
      });
      const prompt = derived['plan-reviewer-docs']!.prompt!;
      expect(prompt.startsWith(basePrompt)).toBe(true);
      if (host.host === 'opencode-v1') {
        expect(prompt).toContain('- `skill({ name: "context-engineering" })`');
        expect(prompt).not.toContain('skill({ id');
      } else {
        expect(prompt).toContain('- `skill({ id })` for the catalog entry named "context-engineering"');
        expect(prompt).not.toContain('skill({ name');
      }
    }
  });

  it('builds derived subagents for scout, forager, and reviewer bases', () => {
    const scoutPermission: RuntimeSubagentConfig['permission'] = {
      'hive_*': 'deny',
      hive_context_read: 'allow',
      edit: 'deny',
      task: 'deny',
      delegate: 'deny',
      skill: 'allow',
      webfetch: 'allow',
      bash: { '*': 'ask', 'git status*': 'allow' },
    };
    const foragerPermission: RuntimeSubagentConfig['permission'] = {
      task: 'deny',
      delegate: 'deny',
      skill: 'allow',
    };
    const reviewerPermission: RuntimeSubagentConfig['permission'] = {
      edit: 'deny',
      task: 'deny',
      delegate: 'deny',
      skill: 'allow',
    };

    const baseAgents = {
      'scout-researcher': {
        model: 'base/scout-model',
        variant: 'low',
        mode: 'subagent' as const,
        description: 'Base Scout',
        prompt: SCOUT_BEE_PROMPT,
        permission: scoutPermission,
      },
      'forager-worker': {
        model: 'base/forager-model',
        variant: 'medium',
        mode: 'subagent' as const,
        description: 'Base Forager',
        prompt: FORAGER_BEE_PROMPT,
        permission: foragerPermission,
      },
      'plan-reviewer': {
        model: 'base/plan-model',
        variant: 'low',
        mode: 'subagent' as const,
        description: 'Base Plan Reviewer',
        prompt: PLAN_REVIEWER_PROMPT,
        permission: reviewerPermission,
      },
      'code-reviewer': {
        model: 'base/code-model',
        variant: 'low',
        mode: 'subagent' as const,
        description: 'Base Code Reviewer',
        prompt: CODE_REVIEWER_PROMPT,
        permission: reviewerPermission,
      },
      'simplicity-reviewer': {
        model: 'base/simplicity-model',
        variant: 'low',
        mode: 'subagent' as const,
        description: 'Base Simplicity Reviewer',
        prompt: SIMPLICITY_REVIEWER_PROMPT,
        permission: reviewerPermission,
      },
      'approach-advisor': {
        model: 'base/advisor-model',
        variant: 'low',
        mode: 'subagent' as const,
        description: 'Base Approach Advisor',
        prompt: APPROACH_ADVISOR_PROMPT,
        permission: reviewerPermission,
      },
      'vulnerability-reviewer': {
        model: 'base/security-model',
        variant: 'high',
        mode: 'subagent' as const,
        description: 'Base Vulnerability Reviewer',
        prompt: VULNERABILITY_REVIEWER_PROMPT,
        permission: reviewerPermission,
      },
    };

    const customAgents: Record<string, ResolvedCustomAgentConfig> = {
      'scout-docs': {
        baseAgent: 'scout-researcher',
        description: 'Use for documentation-heavy research tasks.',
        model: 'custom/scout-model',
        variant: 'medium',
        autoLoadSkills: [],
      },
      'forager-ui': {
        baseAgent: 'forager-worker',
        description: 'Use for UI-heavy implementation tasks.',
        model: 'custom/model',
        variant: 'high',
        autoLoadSkills: ['test-driven-development'],
      },
      'reviewer-security': {
        baseAgent: 'code-reviewer',
        description: 'Use for security-focused review passes.',
        model: 'base/code-model',
        variant: 'low',
        autoLoadSkills: [],
      },
      'reviewer-minimalist': {
        baseAgent: 'simplicity-reviewer',
        description: 'Use for adversarial deletion-biased cleanup passes.',
        autoLoadSkills: ['adversarial-review'],
      },
      'security-supply-chain': {
        baseAgent: 'vulnerability-reviewer',
        description: 'Use for dependency and build-chain attack paths.',
        model: 'custom/security-model',
        variant: 'xhigh',
        autoLoadSkills: [],
      },
    };

    const derived = buildCustomSubagents({
      customAgents,
      baseAgents,
      autoLoadSkillAppendices: {
        'scout-docs': '\n\n# scout-docs auto-load guidance',
        'forager-ui': '\n\n# forager-ui auto-load guidance',
        'reviewer-minimalist': '\n\n# reviewer-minimalist auto-load guidance',
      },
    });

    expect(derived['scout-docs'].mode).toBe('subagent');
    expect(derived['scout-docs'].prompt).toContain(SCOUT_BEE_PROMPT);
    expect(derived['scout-docs'].prompt).toContain('Do not diagnose the cause of an observed failure');
    expect(derived['scout-docs'].prompt).not.toContain('Use for documentation-heavy research tasks.');
    expect(derived['scout-docs'].prompt).toContain('# scout-docs auto-load guidance');
    expect(derived['scout-docs'].permission).toEqual(baseAgents['scout-researcher'].permission);
    expect(Object.keys(derived['scout-docs'].permission!)).toEqual(Object.keys(scoutPermission));
    expect(derived['scout-docs'].permission!.bash).toEqual({ '*': 'ask', 'git status*': 'allow' });
    expect(derived['scout-docs'].description).toBe('Use for documentation-heavy research tasks.');
    expect(derived['scout-docs'].model).toBe('custom/scout-model');
    expect(derived['scout-docs'].variant).toBe('medium');

    expect(derived['forager-ui'].mode).toBe('subagent');
    expect(derived['forager-ui'].prompt).toContain(FORAGER_BEE_PROMPT);
    expect(derived['forager-ui'].prompt).toContain('# forager-ui auto-load guidance');
    expect(derived['forager-ui'].permission).toEqual(baseAgents['forager-worker'].permission);
    expect(derived['forager-ui'].description).toBe('Use for UI-heavy implementation tasks.');
    expect(derived['forager-ui'].model).toBe('custom/model');
    expect(derived['forager-ui'].variant).toBe('high');
    expect(countOccurrences(derived['forager-ui'].prompt!, ENGINEERING_JUDGMENT_PROMPT)).toBe(1);

    expect(derived['reviewer-security'].mode).toBe('subagent');
    expect(derived['reviewer-security'].prompt).toContain(CODE_REVIEWER_PROMPT);
    expect(derived['reviewer-security'].permission).toEqual(baseAgents['code-reviewer'].permission);
    expect(derived['reviewer-security'].description).toBe('Use for security-focused review passes.');
    expect(derived['reviewer-security'].model).toBe('base/code-model');
    expect(countOccurrences(derived['reviewer-security'].prompt!, ENGINEERING_JUDGMENT_PROMPT)).toBe(1);

    expect(derived['reviewer-minimalist'].mode).toBe('subagent');
    expect(derived['reviewer-minimalist'].prompt).toContain(SIMPLICITY_REVIEWER_PROMPT);
    expect(derived['reviewer-minimalist'].prompt).toContain('# reviewer-minimalist auto-load guidance');
    expect(derived['reviewer-minimalist'].permission).toEqual(baseAgents['simplicity-reviewer'].permission);
    expect(derived['reviewer-minimalist'].description).toBe('Use for adversarial deletion-biased cleanup passes.');
    // A custom agent without a resolved Hive model registers none and inherits the native model.
    expect(derived['reviewer-minimalist']).not.toHaveProperty('model');
    expect(derived['reviewer-minimalist']).not.toHaveProperty('variant');
    expect(derived['security-supply-chain']).toMatchObject({
      mode: 'subagent',
      description: 'Use for dependency and build-chain attack paths.',
      model: 'custom/security-model',
      variant: 'xhigh',
      permission: baseAgents['vulnerability-reviewer'].permission,
    });
    expect(derived['security-supply-chain'].prompt).toContain(VULNERABILITY_REVIEWER_PROMPT);
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
      'simplicity-reviewer': {
        mode: 'subagent' as const,
        description: 'Base Simplicity Reviewer',
        prompt: SIMPLICITY_REVIEWER_PROMPT,
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
    expect(countOccurrences(registeredRuntimePrompts['forager-ui'], ENGINEERING_JUDGMENT_PROMPT)).toBe(1);
  });
});

describe('CUSTOM_AGENT_RESERVED_NAMES', () => {
  it('includes hive-builder and builder as reserved names', () => {
    expect(CUSTOM_AGENT_RESERVED_NAMES).toContain('hive-builder');
    expect(CUSTOM_AGENT_RESERVED_NAMES).toContain('builder');
  });
});
