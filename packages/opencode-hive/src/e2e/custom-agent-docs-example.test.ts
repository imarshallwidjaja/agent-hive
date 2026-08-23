import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { createOpencodeClient } from '@opencode-ai/sdk';
import plugin from '../index';

const OPENCODE_CLIENT = createOpencodeClient({ baseUrl: 'http://localhost:1' });
const TEST_ROOT_BASE = '/tmp/hive-custom-agent-docs-example-test';
const README_PATH = path.resolve(import.meta.dir, '..', '..', 'README.md');

const publishedExample = {
  agents: {
    'scout-researcher': { variant: 'low' },
    'forager-worker': {
      description: 'Default for ordinary backend implementation.',
      variant: 'medium',
    },
    'code-reviewer': { model: 'github-copilot/gpt-5.2-codex' },
  },
  customAgents: {
    'scout-docs': {
      baseAgent: 'scout-researcher',
      description: 'Use for research centered on documentation, release notes, READMEs, or external docs synthesis.',
    },
    'forager-ui': {
      baseAgent: 'forager-worker',
      description: 'Use for UI implementation tasks touching React/Next components, styling, accessibility, or browser-visible behavior.',
      model: 'anthropic/claude-sonnet-4-20250514',
      temperature: 0.2,
      variant: 'high',
    },
    'reviewer-security': {
      baseAgent: 'code-reviewer',
      description: 'Use for review passes focused on auth, permissions, secret handling, injection risk, or other security-sensitive changes.',
    },
  },
};

const builtInBaseDescriptions = {
  'scout-researcher': 'Default for bounded routine research, local code lookup, codebase exploration, and external docs or data retrieval.',
  'forager-worker': 'Default for ordinary implementation, bug fixes, and refactoring in an isolated worktree.',
  'plan-reviewer': 'Default for ordinary plan review covering worker readiness, references, dependencies, and executable verification.',
  'code-reviewer': 'Default for ordinary implementation review covering correctness, tests, risk, scope creep, YAGNI, and dead code.',
  'simplicity-reviewer': 'Default for ordinary post-implementation simplicity review covering unnecessary abstractions, duplication, dead code, and safe deletion.',
  'approach-advisor': 'Default for ordinary read-only approach advice on technical direction, architecture, debugging, and tradeoffs.',
  'vulnerability-reviewer': 'Default for application-security review focused on evidenced attacker-to-impact paths and root-cause triage.',
};

const resolvedBaseDescriptions = {
  ...builtInBaseDescriptions,
  'forager-worker': 'Default for ordinary backend implementation.',
};

function routingCards(prompt: string): string[] {
  const appendix = prompt.split('## Configured Custom Subagents and Built-In Defaults')[1] ?? '';
  return appendix.match(/^- `.*$/gm) ?? [];
}

function defaultCard(name: keyof typeof resolvedBaseDescriptions): string {
  return `- \`${name}\` — kind: default; base: \`${name}\`; ${resolvedBaseDescriptions[name]}`;
}

const scoutDocsCard = '- `scout-docs` — kind: custom overlay; base: `scout-researcher`; Use for research centered on documentation, release notes, READMEs, or external docs synthesis.';
const foragerUiCard = '- `forager-ui` — kind: custom overlay; base: `forager-worker`; Use for UI implementation tasks touching React/Next components, styling, accessibility, or browser-visible behavior.';
const reviewerSecurityCard = '- `reviewer-security` — kind: custom overlay; base: `code-reviewer`; Use for review passes focused on auth, permissions, secret handling, injection risk, or other security-sensitive changes.';
const scoutTemplateCard = '- `scout-example-template` — kind: custom overlay; base: `scout-researcher`; Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.';
const foragerTemplateCard = '- `forager-example-template` — kind: custom overlay; base: `forager-worker`; Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.';
const reviewerTemplateCard = '- `reviewer-example-template` — kind: custom overlay; base: `code-reviewer`; Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.';
const autonomousRoutingGuidance = "Choose autonomously the agent whose description best matches the task's domain, workflow, artifact type, or concrete review/approach risk; use the built-in base agent when no configured custom subagent is a closer fit.";
const routingGuard = 'Candidate-specific conditions in an individual description still apply, including a condition that the candidate may be selected only when the operator explicitly names it.';
const broadExplicitNameRoute = 'or when the operator explicitly names it';

const allRoutingCards = [
  defaultCard('scout-researcher'),
  scoutDocsCard,
  scoutTemplateCard,
  defaultCard('forager-worker'),
  foragerTemplateCard,
  foragerUiCard,
  defaultCard('plan-reviewer'),
  defaultCard('code-reviewer'),
  reviewerTemplateCard,
  reviewerSecurityCard,
  defaultCard('simplicity-reviewer'),
  defaultCard('approach-advisor'),
  defaultCard('vulnerability-reviewer'),
];

function createProject(worktree: string) {
  return {
    id: 'test',
    worktree,
    time: { created: Date.now() },
  };
}

function expectCandidateSpecificRouting(prompt: string): void {
  expect(prompt).toContain(autonomousRoutingGuidance);
  expect(prompt).toContain(routingGuard);
  expect(prompt).not.toContain(broadExplicitNameRoute);
}

describe('e2e: published custom-agent docs example', () => {
  let testRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'project-'));
    process.env.HOME = testRoot;
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it('keeps docs example in sync with runtime behavior', async () => {
    const configPath = path.join(testRoot, '.config', 'opencode', 'agent_hive.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(publishedExample, null, 2));

    const ctx: any = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL('http://localhost:1'),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
    };

    const hooks = await plugin(ctx);
    const opencodeConfig: any = { agent: {} };
    await hooks.config!(opencodeConfig);

    expect(opencodeConfig.agent['forager-worker']?.variant).toBe('medium');
    expect(opencodeConfig.agent['scout-researcher']?.variant).toBe('low');
    expect(opencodeConfig.agent['code-reviewer']?.model).toBe('github-copilot/gpt-5.2-codex');
    for (const [name, description] of Object.entries(resolvedBaseDescriptions)) {
      expect(opencodeConfig.agent[name]?.description).toBe(description);
    }

    const scoutDocs = opencodeConfig.agent['scout-docs'];
    const foragerUi = opencodeConfig.agent['forager-ui'];
    const reviewerSecurity = opencodeConfig.agent['reviewer-security'];
    expect(scoutDocs).toBeDefined();
    expect(foragerUi).toBeDefined();
    expect(reviewerSecurity).toBeDefined();

    expect(scoutDocs.model).toBe('zai-coding-plan/glm-4.7');
    expect(scoutDocs.temperature).toBe(0.5);
    expect(scoutDocs.variant).toBe('low');
    expect(scoutDocs.description).toBe('Use for research centered on documentation, release notes, READMEs, or external docs synthesis.');

    expect(foragerUi.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(foragerUi.temperature).toBe(0.2);
    expect(foragerUi.variant).toBe('high');
    expect(foragerUi.description).toBe('Use for UI implementation tasks touching React/Next components, styling, accessibility, or browser-visible behavior.');

    expect(reviewerSecurity.model).toBe('github-copilot/gpt-5.2-codex');
    expect(reviewerSecurity.temperature).toBe(0.3);
    expect(reviewerSecurity.variant).toBeUndefined();
    expect(reviewerSecurity.description).toBe('Use for review passes focused on auth, permissions, secret handling, injection risk, or other security-sensitive changes.');

    expect(opencodeConfig.agent['hive-master']).toBeUndefined();
    expect(foragerUi.prompt).toBeUndefined();
    const architectPrompt = opencodeConfig.agent['architect-planner']?.prompt as string;
    expect(architectPrompt).toContain('## Configured Custom Subagents and Built-In Defaults');
    expect(architectPrompt).toContain('Custom subagents are scoped specialists, not automatic model upgrades.');
    expect(architectPrompt).toContain(
      'For Scout research, decompose broad work and verify each slice fits one context window before choosing a custom Scout; capability is not a width upgrade and does not replace fan-out.'
    );
    expect(architectPrompt).toContain(autonomousRoutingGuidance);
    expect(architectPrompt).not.toContain('Require explicit operator naming');
    expectCandidateSpecificRouting(architectPrompt);
    expect(architectPrompt).toContain('Do not choose a custom subagent only because the task is important, large, complex, or quality-sensitive.');
    expect(architectPrompt).not.toContain('exception routes, not capability upgrades');
    expect(routingCards(architectPrompt)).toEqual([
      defaultCard('scout-researcher'),
      scoutDocsCard,
      scoutTemplateCard,
      defaultCard('plan-reviewer'),
      defaultCard('approach-advisor'),
    ]);
    expect(architectPrompt).not.toContain('`forager-worker` — kind: default');
    expect(architectPrompt).not.toContain('`forager-ui` — kind: custom overlay');
    expect(architectPrompt).not.toContain('`code-reviewer` — kind: default');
    expect(architectPrompt).not.toContain('`reviewer-security` — kind: custom overlay');
    expect(architectPrompt).not.toContain('`simplicity-reviewer` — kind: default');
    expect(architectPrompt).not.toContain('`vulnerability-reviewer` — kind: default');
    expect(architectPrompt).not.toContain('derived from');

    const systemTransform = hooks['experimental.chat.system.transform' as keyof typeof hooks] as
      | ((input: { sessionID?: string; agent?: string }, output: { system: string[] }) => Promise<void>)
      | undefined;
    const swarmOutput = { system: ['OpenCode provider base prompt'] };
    await systemTransform?.({ sessionID: 'sess_docs_swarm', agent: 'swarm-orchestrator' }, swarmOutput);
    const swarmPrompt = swarmOutput.system[0];
    expect(swarmPrompt).toContain('## Configured Custom Subagents and Built-In Defaults');
    expect(swarmPrompt).toContain('Custom subagents are scoped specialists, not automatic model upgrades.');
    expect(swarmPrompt).not.toContain('Require explicit operator naming');
    expectCandidateSpecificRouting(swarmPrompt);
    expect(swarmPrompt).toContain(autonomousRoutingGuidance);
    expect(swarmPrompt).toContain('Do not choose a custom subagent only because the task is important, large, complex, or quality-sensitive.');
    expect(swarmPrompt).not.toContain('exception routes, not capability upgrades');
    expect(routingCards(swarmPrompt)).toEqual(allRoutingCards);

    const builderOutput = { system: ['OpenCode provider base prompt'] };
    await systemTransform?.({ sessionID: 'sess_docs_builder', agent: 'hive-builder' }, builderOutput);
    const builderPrompt = builderOutput.system[0];
    expectCandidateSpecificRouting(builderPrompt);
    expect(routingCards(builderPrompt)).toEqual([
      defaultCard('scout-researcher'),
      scoutDocsCard,
      scoutTemplateCard,
      defaultCard('forager-worker'),
      foragerTemplateCard,
      foragerUiCard,
      defaultCard('code-reviewer'),
      reviewerTemplateCard,
      reviewerSecurityCard,
      defaultCard('simplicity-reviewer'),
    ]);
    expect(builderPrompt).not.toContain('`plan-reviewer` — kind: default');
    expect(builderPrompt).not.toContain('`approach-advisor` — kind: default');
    expect(builderPrompt).not.toContain('`vulnerability-reviewer` — kind: default');

    fs.writeFileSync(configPath, JSON.stringify({ ...publishedExample, agentMode: 'unified' }, null, 2));
    const unifiedHooks = await plugin(ctx);
    const unifiedConfig: any = { agent: {} };
    await unifiedHooks.config!(unifiedConfig);
    const hiveOutput = { system: ['OpenCode provider base prompt'] };
    const unifiedSystemTransform = unifiedHooks['experimental.chat.system.transform' as keyof typeof unifiedHooks] as
      | ((input: { sessionID?: string; agent?: string }, output: { system: string[] }) => Promise<void>)
      | undefined;
    await unifiedSystemTransform?.({ sessionID: 'sess_docs_hive', agent: 'hive-master' }, hiveOutput);
    expectCandidateSpecificRouting(hiveOutput.system[0]);
    expect(routingCards(hiveOutput.system[0])).toEqual(allRoutingCards);

    const readmeContent = fs.readFileSync(README_PATH, 'utf-8');
    expect(readmeContent).toContain(routingGuard);
    expect(readmeContent).not.toContain(broadExplicitNameRoute);
    expect(readmeContent).toContain(
      'Putting `description` on a non-customizable built-in invalidates the stored global config. At runtime, Agent Hive rejects the entire stored config and falls back to defaults, so unrelated stored settings are ignored until the config is corrected.',
    );
    expect(readmeContent).toContain(
      'At runtime, custom agent entries with reserved names, non-object declarations, unsupported `baseAgent` values, or missing, blank, or whitespace-only `description` values are skipped with warnings.',
    );
    const sectionMatch = readmeContent.match(/### Custom Derived Subagents[\s\S]*?```json\n([\s\S]*?)\n```/);
    expect(sectionMatch).not.toBeNull();

    const docsJson = sectionMatch![1].trim();
    expect(docsJson).toBe(JSON.stringify(publishedExample, null, 2));
    expect(JSON.parse(docsJson)).toEqual(publishedExample);
  });
});
