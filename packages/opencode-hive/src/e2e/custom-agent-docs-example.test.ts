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
    'forager-worker': { variant: 'medium' },
    'code-reviewer': { model: 'github-copilot/gpt-5.2-codex' },
  },
  customAgents: {
    'scout-docs': {
      baseAgent: 'scout-researcher',
      description: 'Use for documentation-heavy research tasks.',
    },
    'forager-ui': {
      baseAgent: 'forager-worker',
      description: 'Use for UI-heavy implementation tasks.',
      model: 'anthropic/claude-sonnet-4-20250514',
      temperature: 0.2,
      variant: 'high',
    },
    'reviewer-security': {
      baseAgent: 'code-reviewer',
      description: 'Use for security-focused review passes.',
    },
  },
};

function createProject(worktree: string) {
  return {
    id: 'test',
    worktree,
    time: { created: Date.now() },
  };
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

    const scoutDocs = opencodeConfig.agent['scout-docs'];
    const foragerUi = opencodeConfig.agent['forager-ui'];
    const reviewerSecurity = opencodeConfig.agent['reviewer-security'];
    expect(scoutDocs).toBeDefined();
    expect(foragerUi).toBeDefined();
    expect(reviewerSecurity).toBeDefined();

    expect(scoutDocs.model).toBe('zai-coding-plan/glm-4.7');
    expect(scoutDocs.temperature).toBe(0.5);
    expect(scoutDocs.variant).toBe('low');
    expect(scoutDocs.description).toBe('Use for documentation-heavy research tasks.');

    expect(foragerUi.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(foragerUi.temperature).toBe(0.2);
    expect(foragerUi.variant).toBe('high');
    expect(foragerUi.description).toBe('Use for UI-heavy implementation tasks.');

    expect(reviewerSecurity.model).toBe('github-copilot/gpt-5.2-codex');
    expect(reviewerSecurity.temperature).toBe(0.3);
    expect(reviewerSecurity.variant).toBeUndefined();
    expect(reviewerSecurity.description).toBe('Use for security-focused review passes.');

    expect(opencodeConfig.agent['hive-master']?.prompt).toBeUndefined();
    expect(foragerUi.prompt).toBeUndefined();
    const systemTransform = hooks['experimental.chat.system.transform' as keyof typeof hooks] as
      | ((input: { sessionID?: string; agent?: string }, output: { system: string[] }) => Promise<void>)
      | undefined;
    const hiveOutput = { system: ['OpenCode provider base prompt'] };
    await systemTransform?.({ sessionID: 'sess_docs_hive', agent: 'hive-master' }, hiveOutput);
    const hivePrompt = hiveOutput.system[0];
    expect(hivePrompt).toContain('## Configured Custom Subagents');
    expect(hivePrompt).toContain('`scout-docs`');
    expect(hivePrompt).toContain('`forager-ui`');
    expect(hivePrompt).toContain('`reviewer-security`');

    const readmeContent = fs.readFileSync(README_PATH, 'utf-8');
    const sectionMatch = readmeContent.match(/### Custom Derived Subagents[\s\S]*?```json\n([\s\S]*?)\n```/);
    expect(sectionMatch).not.toBeNull();

    const docsJson = sectionMatch![1].trim();
    expect(docsJson).toBe(JSON.stringify(publishedExample, null, 2));
    expect(JSON.parse(docsJson)).toEqual(publishedExample);
  });
});
