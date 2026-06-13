import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createOpencodeClient } from '@opencode-ai/sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import plugin from '../index';
import { BUILTIN_SKILLS } from '../skills/registry.generated.js';

function createFileSkill(
  skillDir: string,
  skillId: string,
  description: string,
  body: string,
): void {
  const skillPath = path.join(skillDir, skillId, 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  const content = `---
name: ${skillId}
description: ${description}
---
${body}`;
  fs.writeFileSync(skillPath, content, 'utf8');
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  return haystack.split(needle).length - 1;
}

function skillToolCall(skillName: string): string {
  return `skill({ name: ${JSON.stringify(skillName)} })`;
}

function getAutoLoadSkillsGuidance(prompt: string): string {
  const heading = '## Configured Auto-Load Skills';
  const start = prompt.indexOf(heading);
  if (start === -1) {
    return '';
  }

  const nextHeading = prompt.indexOf('\n\n## ', start + heading.length);
  return nextHeading === -1 ? prompt.slice(start) : prompt.slice(start, nextHeading);
}

function createProject(worktree: string) {
  return {
    id: 'test',
    worktree,
    time: { created: Date.now() },
  };
}

function writeHiveConfig(testRoot: string, config: Record<string, unknown>): void {
  const configPath = path.join(testRoot, '.config', 'opencode', 'agent_hive.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
}

function createCtx(testRoot: string): any {
  return {
    directory: testRoot,
    worktree: testRoot,
    serverUrl: new URL('http://localhost:1'),
    project: createProject(testRoot),
    client: OPENCODE_CLIENT,
  };
}

async function applyConfigHook(
  testRoot: string,
  opencodeConfig: Record<string, unknown> = { agent: {} },
): Promise<Record<string, unknown>> {
  const hooks = await plugin(createCtx(testRoot));
  await hooks.config!(opencodeConfig);
  return opencodeConfig;
}

async function renderRuntimeSystemPrompt(
  testRoot: string,
  agentName: string,
  options: { trackMessage?: boolean; opencodeConfig?: Record<string, unknown> } = {},
): Promise<string> {
  const hooks = await plugin(createCtx(testRoot));
  await hooks.config!(options.opencodeConfig ?? { agent: {} });

  const sessionID = `sess_${agentName.replace(/[^a-z0-9]/gi, '_')}`;
  if (options.trackMessage ?? true) {
    await hooks['chat.message']?.(
      { sessionID, agent: agentName },
      { message: {}, parts: [] } as any,
    );
  }

  const output = { system: ['OpenCode provider base prompt'] };
  const systemTransform = hooks['experimental.chat.system.transform' as keyof typeof hooks] as
    | ((input: { sessionID?: string; agent?: string }, output: { system: string[] }) => Promise<void>)
    | undefined;
  await systemTransform?.({ sessionID, agent: agentName }, output);

  return output.system[0] ?? '';
}

async function captureWarnings<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const originalWarn = console.warn;

  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  try {
    return {
      result: await run(),
      warnings,
    };
  } finally {
    console.warn = originalWarn;
  }
}

function requireBuiltinSkill(name: string): { name: string; template: string } {
  const skill = BUILTIN_SKILLS.find((entry) => entry.name === name);
  expect(skill).toBeDefined();
  return skill!;
}

function getAgentPrompt(opencodeConfig: Record<string, unknown>, agentName: string): string {
  const agentConfig = (opencodeConfig.agent as Record<string, { prompt?: string }> | undefined)?.[agentName];
  expect(agentConfig?.prompt).toBeDefined();
  return agentConfig!.prompt!;
}

function getSkillPaths(opencodeConfig: Record<string, unknown>): string[] {
  const skills = opencodeConfig.skills as { paths?: string[] } | undefined;
  return skills?.paths ?? [];
}

function getSkillUrls(opencodeConfig: Record<string, unknown>): string[] {
  const skills = opencodeConfig.skills as { urls?: string[] } | undefined;
  return skills?.urls ?? [];
}

function getHiveManagedPaths(skillPaths: string[]): string[] {
  return skillPaths.filter((skillPath) => skillPath.includes(HIVE_GENERATED_SEGMENT));
}

function getCurrentHiveManagedPath(opencodeConfig: Record<string, unknown>): string | undefined {
  return getHiveManagedPaths(getSkillPaths(opencodeConfig))[0];
}

const OPENCODE_CLIENT = createOpencodeClient({ baseUrl: 'http://localhost:1' });
const TEST_ROOT_BASE = '/tmp/hive-config-autoload-skills-test';
const HIVE_GENERATED_SEGMENT = path.join('.hive', 'generated', 'opencode-skills');
const PACKAGED_SKILLS_DIR = fileURLToPath(new URL('../../skills', import.meta.url));

describe('config hook autoLoadSkills guidance', () => {
  let testRoot: string;
  let originalHome: string | undefined;
  let originalExperimentalBackgroundSubagents: string | undefined;
  let originalExperimental: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalExperimentalBackgroundSubagents = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    originalExperimental = process.env.OPENCODE_EXPERIMENTAL;
    originalFetch = globalThis.fetch;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'project-'));
    process.env.HOME = testRoot;
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    delete process.env.OPENCODE_EXPERIMENTAL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalExperimentalBackgroundSubagents === undefined) {
      delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    } else {
      process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = originalExperimentalBackgroundSubagents;
    }
    if (originalExperimental === undefined) {
      delete process.env.OPENCODE_EXPERIMENTAL;
    } else {
      process.env.OPENCODE_EXPERIMENTAL = originalExperimental;
    }
  });

  it('does not advertise background delegation guidance when the experiment env is off in unified mode', async () => {
    writeHiveConfig(testRoot, { agentMode: 'unified' });

    const opencodeConfig = await applyConfigHook(testRoot);
    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false });
    const backgroundSkill = requireBuiltinSkill('background-delegation');
    const generatedPath = getCurrentHiveManagedPath(opencodeConfig);

    expect((opencodeConfig.agent as Record<string, { prompt?: string }>)['hive-master']?.prompt).toBeUndefined();
    expect(hiveMasterPrompt).toStartWith('OpenCode provider base prompt\n\n# Hive (Hybrid)');
    expect(hiveMasterPrompt).not.toContain('## Background-First Orchestration');
    expect(hiveMasterPrompt).not.toContain(backgroundSkill.template);
    expect(hiveMasterPrompt).not.toContain('skill({ name: "background-delegation" })');
    expect(generatedPath).toBeDefined();
    expect(fs.existsSync(path.join(generatedPath!, 'background-delegation', 'SKILL.md'))).toBe(true);
  });

  it('advertises background-first scheduler guidance only to hive-master when the specific env is enabled in unified mode', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    writeHiveConfig(testRoot, {
      agentMode: 'unified',
      customAgents: {
        'forager-background': {
          baseAgent: 'forager-worker',
          description: 'Custom worker must not inherit primary background guidance.',
        },
      },
    });

    const opencodeConfig = await applyConfigHook(testRoot);
    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false });
    const builderPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-builder');
    const scoutPrompt = getAgentPrompt(opencodeConfig, 'scout-researcher');
    const foragerPrompt = await renderRuntimeSystemPrompt(testRoot, 'forager-worker', { trackMessage: false });
    const hiveHelperPrompt = getAgentPrompt(opencodeConfig, 'hive-helper');
    const codeReviewerPrompt = getAgentPrompt(opencodeConfig, 'code-reviewer');
    const customPrompt = await renderRuntimeSystemPrompt(testRoot, 'forager-background', { trackMessage: false });
    const backgroundSkill = requireBuiltinSkill('background-delegation');

    expect(hiveMasterPrompt).toContain('## Background-First Orchestration');
    expect(hiveMasterPrompt).not.toContain(backgroundSkill.template);
    expect(hiveMasterPrompt).toContain('skill({ name: "background-delegation" })');
    expect(hiveMasterPrompt).toContain('look for independent background lanes');
    expect(hiveMasterPrompt).toContain('Allowed foreground/blocking escape reasons: dependency, risk, simplicity, user interaction, or ownership conflict.');
    expect(hiveMasterPrompt).toContain('hive_background_status');
    expect(hiveMasterPrompt).toContain('hive_background_reconcile');
    expect(hiveMasterPrompt).toContain('hive_background_reconcile_batch');
    expect(hiveMasterPrompt).toContain('hive_background_cancel');
    expect(hiveMasterPrompt).toContain('task({ background: true');
    expect(hiveMasterPrompt).toContain('native completion notification');
    expect(hiveMasterPrompt).not.toContain('task_status');
    expect(builderPrompt).toContain('## Background-First Orchestration');
    expect(builderPrompt).not.toContain(backgroundSkill.template);
    expect(builderPrompt).toContain('skill({ name: "background-delegation" })');
    expect(builderPrompt).toContain('look for independent background lanes');
    expect(builderPrompt).toContain('Allowed foreground/blocking escape reasons: dependency, risk, simplicity, user interaction, or ownership conflict.');
    expect(builderPrompt).toContain('hive_background_status');
    expect(builderPrompt).toContain('hive_background_reconcile');
    expect(builderPrompt).toContain('hive_background_reconcile_batch');
    expect(builderPrompt).toContain('hive_background_cancel');
    expect(builderPrompt).toContain('task({ background: true');
    expect(builderPrompt).toContain('native completion notification');
    expect(builderPrompt).not.toContain('task_status');
    for (const prompt of [scoutPrompt, foragerPrompt, hiveHelperPrompt, codeReviewerPrompt, customPrompt]) {
      expect(prompt).not.toContain('skill({ name: "background-delegation" })');
      expect(prompt).not.toContain('task({ background: true');
      expect(prompt).not.toContain(backgroundSkill.template);
    }
  });

  it('advertises background-first scheduler guidance only to primary dedicated-mode agents when the umbrella env is enabled', async () => {
    process.env.OPENCODE_EXPERIMENTAL = 'true';
    writeHiveConfig(testRoot, { agentMode: 'dedicated' });

    const opencodeConfig = await applyConfigHook(testRoot);
    const architectPrompt = getAgentPrompt(opencodeConfig, 'architect-planner');
    const swarmPrompt = await renderRuntimeSystemPrompt(testRoot, 'swarm-orchestrator', { trackMessage: false });
    const builderPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-builder');
    const scoutPrompt = getAgentPrompt(opencodeConfig, 'scout-researcher');
    const foragerPrompt = await renderRuntimeSystemPrompt(testRoot, 'forager-worker', { trackMessage: false });
    const hiveHelperPrompt = getAgentPrompt(opencodeConfig, 'hive-helper');
    const codeReviewerPrompt = getAgentPrompt(opencodeConfig, 'code-reviewer');
    const backgroundSkill = requireBuiltinSkill('background-delegation');

    for (const prompt of [architectPrompt, swarmPrompt, builderPrompt]) {
      expect(prompt).toContain('## Background-First Orchestration');
      expect(prompt).toContain('skill({ name: "background-delegation" })');
      expect(prompt).toContain('look for independent background lanes');
      expect(prompt).toContain('Allowed foreground/blocking escape reasons: dependency, risk, simplicity, user interaction, or ownership conflict.');
      expect(prompt).toContain('hive_background_status');
      expect(prompt).toContain('hive_background_reconcile');
      expect(prompt).toContain('hive_background_reconcile_batch');
      expect(prompt).toContain('hive_background_cancel');
      expect(prompt).toContain('task({ background: true');
      expect(prompt).toContain('native completion notification');
      expect(prompt).not.toContain('task_status');
      expect(prompt).not.toContain(backgroundSkill.template);
    }
    for (const prompt of [scoutPrompt, foragerPrompt, hiveHelperPrompt, codeReviewerPrompt]) {
      expect(prompt).not.toContain('skill({ name: "background-delegation" })');
      expect(prompt).not.toContain('task({ background: true');
      expect(prompt).not.toContain(backgroundSkill.template);
    }
  });

  it.each(['', '0', 'false', 'no'])('does not advertise background delegation guidance for falsey env value %p', async (envValue) => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = envValue;
    writeHiveConfig(testRoot, { agentMode: 'unified' });

    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false });
    const builderPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-builder');

    expect(hiveMasterPrompt).not.toContain('## Background-First Orchestration');
    expect(hiveMasterPrompt).not.toContain('skill({ name: "background-delegation" })');
    expect(hiveMasterPrompt).not.toContain('task({ background: true');
    expect(builderPrompt).not.toContain('## Background-First Orchestration');
    expect(builderPrompt).not.toContain('skill({ name: "background-delegation" })');
  });

  it('does not advertise background delegation guidance when env is enabled but the Hive bundle is disabled', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    writeHiveConfig(testRoot, {
      agentMode: 'unified',
      disableSkills: ['background-delegation'],
    });

    const { result: opencodeConfig, warnings } = await captureWarnings(async () => applyConfigHook(testRoot));
    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false });
    const builderPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-builder');
    const generatedPath = getCurrentHiveManagedPath(opencodeConfig);

    expect(hiveMasterPrompt).not.toContain('## Background-First Orchestration');
    expect(hiveMasterPrompt).not.toContain('skill({ name: "background-delegation" })');
    expect(builderPrompt).not.toContain('## Background-First Orchestration');
    expect(builderPrompt).not.toContain('skill({ name: "background-delegation" })');
    expect(generatedPath).toBeDefined();
    expect(fs.existsSync(path.join(generatedPath!, 'background-delegation'))).toBe(false);
    expect(warnings).toContainEqual(
      expect.stringContaining('Background delegation guidance was not advertised'),
    );
    expect(warnings).toContainEqual(
      expect.stringContaining('skill "background-delegation" is disabled'),
    );
  });

  it('advertises background delegation guidance from a native skill even when the Hive bundle with the same name is disabled', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    createFileSkill(
      path.join(testRoot, '.opencode', 'skills'),
      'background-delegation',
      'Native background delegation guidance',
      '# Native Background Delegation\n\nNative guidance should not be injected into the primary prompt.',
    );
    writeHiveConfig(testRoot, {
      agentMode: 'unified',
      disableSkills: ['background-delegation'],
    });

    const { result: opencodeConfig, warnings } = await captureWarnings(async () => applyConfigHook(testRoot));
    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false });
    const generatedPath = getCurrentHiveManagedPath(opencodeConfig);

    expect(hiveMasterPrompt).toContain('## Background-First Orchestration');
    expect(hiveMasterPrompt).toContain('skill({ name: "background-delegation" })');
    expect(hiveMasterPrompt).not.toContain('# Native Background Delegation');
    expect(hiveMasterPrompt).not.toContain(requireBuiltinSkill('background-delegation').template);
    expect(generatedPath).toBeDefined();
    expect(fs.existsSync(path.join(generatedPath!, 'background-delegation'))).toBe(false);
    expect(warnings.some((message) => message.includes('background-delegation'))).toBe(false);
  });

  it('adds default autoLoadSkills guidance and materializes Hive bundled skills in unified mode', async () => {
    writeHiveConfig(testRoot, { agentMode: 'unified' });

    const opencodeConfig = await applyConfigHook(testRoot);
    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false });
    const scoutPrompt = getAgentPrompt(opencodeConfig, 'scout-researcher');
    const foragerPrompt = await renderRuntimeSystemPrompt(testRoot, 'forager-worker', { trackMessage: false });
    const hiveMasterGuidance = getAutoLoadSkillsGuidance(hiveMasterPrompt);
    const scoutGuidance = getAutoLoadSkillsGuidance(scoutPrompt);
    const foragerGuidance = getAutoLoadSkillsGuidance(foragerPrompt);
    const parallelExplorationSkill = requireBuiltinSkill('parallel-exploration');
    const tddSkill = requireBuiltinSkill('test-driven-development');
    const verificationSkill = requireBuiltinSkill('verification');

    expect(hiveMasterPrompt).toContain('## Configured Auto-Load Skills');
    expect(hiveMasterGuidance).toContain(skillToolCall('parallel-exploration'));
    expect(hiveMasterPrompt).not.toContain(parallelExplorationSkill.template);
    expect(scoutGuidance).not.toContain(skillToolCall('parallel-exploration'));
    expect(scoutPrompt).not.toContain(parallelExplorationSkill.template);
    expect(foragerGuidance).toContain(skillToolCall('test-driven-development'));
    expect(foragerGuidance).toContain(skillToolCall('verification'));
    expect(foragerPrompt).not.toContain(tddSkill.template);
    expect(foragerPrompt).not.toContain(verificationSkill.template);
    expect(foragerGuidance).not.toContain(skillToolCall('parallel-exploration'));
    expect(foragerPrompt).not.toContain(parallelExplorationSkill.template);

    const skillPaths = getSkillPaths(opencodeConfig);
    expect(skillPaths).toHaveLength(1);
    expect(skillPaths[0]).toContain(HIVE_GENERATED_SEGMENT);
    expect(fs.existsSync(skillPaths[0])).toBe(true);
    expect(fs.existsSync(path.join(skillPaths[0], 'parallel-exploration', 'SKILL.md'))).toBe(true);
    expect(skillPaths).not.toContain(PACKAGED_SKILLS_DIR);
  });

  it('registers custom subagents and adds only eligible delta autoload guidance without duplicating inherited base skills', async () => {
    createFileSkill(
      path.join(testRoot, '.opencode', 'skills'),
      'native-file-skill',
      'A native project skill that Hive should not inject into custom subagents',
      '# Native File Skill\n\nThis must stay out of the prompt.',
    );

    writeHiveConfig(testRoot, {
      agentMode: 'unified',
      agents: {
        'forager-worker': {
          autoLoadSkills: ['brainstorming'],
        },
      },
      customAgents: {
        'scout-docs': {
          baseAgent: 'scout-researcher',
          description: 'Use for documentation-heavy research tasks.',
          autoLoadSkills: [],
        },
        'forager-ui': {
          baseAgent: 'forager-worker',
          description: 'Use for UI-heavy implementation tasks.',
          autoLoadSkills: ['brainstorming', 'parallel-exploration', 'native-file-skill'],
        },
        'reviewer-security': {
          baseAgent: 'code-reviewer',
          description: 'Use for security-focused review passes.',
          autoLoadSkills: [],
        },
      },
    });

    const { result: opencodeConfig, warnings } = await captureWarnings(async () => applyConfigHook(testRoot));
    const hivePrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false });
    const scoutDocsPrompt = getAgentPrompt(opencodeConfig, 'scout-docs');
    const foragerUiPrompt = await renderRuntimeSystemPrompt(testRoot, 'forager-ui', { trackMessage: false });
    const scoutDocsGuidance = getAutoLoadSkillsGuidance(scoutDocsPrompt);
    const brainstormingSkill = requireBuiltinSkill('brainstorming');
    const parallelExplorationSkill = requireBuiltinSkill('parallel-exploration');
    const tddSkill = requireBuiltinSkill('test-driven-development');

    expect((opencodeConfig.agent as Record<string, unknown>)['forager-ui']).toBeDefined();
    expect((opencodeConfig.agent as Record<string, unknown>)['scout-docs']).toBeDefined();
    expect((opencodeConfig.agent as Record<string, unknown>)['reviewer-security']).toBeDefined();
    expect(hivePrompt).toContain('## Configured Custom Subagents');
    expect(hivePrompt).toContain('scout-docs');
    expect(hivePrompt).toContain('forager-ui');
    expect(hivePrompt).toContain('reviewer-security');
    expect(scoutDocsGuidance).not.toContain(skillToolCall('parallel-exploration'));
    expect(scoutDocsPrompt).not.toContain(parallelExplorationSkill.template);
    expect(countOccurrences(foragerUiPrompt, skillToolCall('brainstorming'))).toBe(1);
    expect(countOccurrences(foragerUiPrompt, skillToolCall('parallel-exploration'))).toBe(1);
    expect(countOccurrences(foragerUiPrompt, skillToolCall('test-driven-development'))).toBe(1);
    expect(countOccurrences(foragerUiPrompt, skillToolCall('native-file-skill'))).toBe(1);
    expect(foragerUiPrompt).not.toContain(brainstormingSkill.template);
    expect(foragerUiPrompt).not.toContain(parallelExplorationSkill.template);
    expect(foragerUiPrompt).not.toContain(tddSkill.template);
    expect(foragerUiPrompt).not.toContain('# Native File Skill');
    expect(warnings.some((message) => message.includes('native-file-skill'))).toBe(false);
  });

  it('adds user-configured bundled autoLoadSkills guidance on top of defaults', async () => {
    writeHiveConfig(testRoot, {
      agentMode: 'unified',
      agents: {
        'forager-worker': {
          autoLoadSkills: ['brainstorming'],
        },
      },
    });

    const foragerPrompt = await renderRuntimeSystemPrompt(testRoot, 'forager-worker', { trackMessage: false });
    const foragerGuidance = getAutoLoadSkillsGuidance(foragerPrompt);
    const brainstormingSkill = requireBuiltinSkill('brainstorming');
    const tddSkill = requireBuiltinSkill('test-driven-development');
    const verificationSkill = requireBuiltinSkill('verification');

    expect(foragerGuidance).toContain(skillToolCall('brainstorming'));
    expect(foragerGuidance).toContain(skillToolCall('test-driven-development'));
    expect(foragerGuidance).toContain(skillToolCall('verification'));
    expect(foragerPrompt).not.toContain(brainstormingSkill.template);
    expect(foragerPrompt).not.toContain(tddSkill.template);
    expect(foragerPrompt).not.toContain(verificationSkill.template);
  });

  it('respects disableSkills for prompt guidance and generated skill directories', async () => {
    writeHiveConfig(testRoot, {
      agentMode: 'unified',
      disableSkills: ['parallel-exploration'],
    });

    const { result: opencodeConfig, warnings } = await captureWarnings(async () => applyConfigHook(testRoot));
    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false });
    const hiveMasterGuidance = getAutoLoadSkillsGuidance(hiveMasterPrompt);
    const parallelExplorationSkill = requireBuiltinSkill('parallel-exploration');
    const generatedPath = getSkillPaths(opencodeConfig)[0];

    expect(hiveMasterGuidance).not.toContain(skillToolCall('parallel-exploration'));
    expect(hiveMasterPrompt).not.toContain(parallelExplorationSkill.template);
    expect(fs.existsSync(path.join(generatedPath, 'parallel-exploration'))).toBe(false);
    expect(warnings).toContainEqual(
      expect.stringContaining('Auto-load skill "parallel-exploration" was not added to guidance'),
    );
  });

  it('autoloads native project skills without copying them into Hive generated paths', async () => {
    createFileSkill(
      path.join(testRoot, '.opencode', 'skills'),
      'my-custom-skill',
      'A native project skill that Hive should autoload',
      '# Native Skill\n\nThis must stay out of the prompt.',
    );
    writeHiveConfig(testRoot, {
      agentMode: 'unified',
      agents: {
        'hive-master': {
          autoLoadSkills: ['my-custom-skill'],
        },
      },
    });

    const { result: opencodeConfig, warnings } = await captureWarnings(async () => applyConfigHook(testRoot));
    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false });
    const hiveMasterGuidance = getAutoLoadSkillsGuidance(hiveMasterPrompt);
    const generatedPath = getCurrentHiveManagedPath(opencodeConfig);

    expect((opencodeConfig.agent as Record<string, unknown>)['hive-master']).toBeDefined();
    expect(generatedPath).toBeDefined();
    expect(fs.existsSync(path.join(generatedPath!, 'my-custom-skill'))).toBe(false);
    expect(hiveMasterGuidance).toContain(skillToolCall('my-custom-skill'));
    expect(hiveMasterPrompt).not.toContain('# Native Skill');
    expect(warnings.some((message) => message.includes('my-custom-skill'))).toBe(false);
  });

  it('adds autoLoadSkills guidance for dedicated-mode agents', async () => {
    writeHiveConfig(testRoot, { agentMode: 'dedicated' });

    const opencodeConfig = await applyConfigHook(testRoot);
    const architectPrompt = getAgentPrompt(opencodeConfig, 'architect-planner');
    const swarmPrompt = await renderRuntimeSystemPrompt(testRoot, 'swarm-orchestrator', { trackMessage: false });
    const architectGuidance = getAutoLoadSkillsGuidance(architectPrompt);
    const swarmGuidance = getAutoLoadSkillsGuidance(swarmPrompt);
    const parallelExplorationSkill = requireBuiltinSkill('parallel-exploration');

    expect(architectGuidance).toContain(skillToolCall('parallel-exploration'));
    expect(architectPrompt).not.toContain(parallelExplorationSkill.template);
    expect(swarmGuidance).not.toContain(skillToolCall('parallel-exploration'));
    expect(swarmPrompt).not.toContain(parallelExplorationSkill.template);
  });

  it('adds bundled skill load guidance without injecting skill bodies into runtime prompts', async () => {
    writeHiveConfig(testRoot, {
      agentMode: 'unified',
      agents: {
        'hive-master': {
          autoLoadSkills: ['brainstorming'],
        },
      },
    });

    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false });
    const hiveMasterGuidance = getAutoLoadSkillsGuidance(hiveMasterPrompt);
    const brainstormingSkill = requireBuiltinSkill('brainstorming');
    const parallelExplorationSkill = requireBuiltinSkill('parallel-exploration');

    expect(hiveMasterGuidance).toContain(skillToolCall('brainstorming'));
    expect(hiveMasterGuidance).toContain(skillToolCall('parallel-exploration'));
    expect(hiveMasterPrompt).not.toContain(brainstormingSkill.template);
    expect(hiveMasterPrompt).not.toContain(parallelExplorationSkill.template);
  });

  it('keeps hive-master autoload skill guidance in the runtime prompt', async () => {
    writeHiveConfig(testRoot, {
      agentMode: 'unified',
      agents: {
        'hive-master': {
          autoLoadSkills: ['brainstorming', 'parallel-exploration'],
        },
      },
    });

    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false });
    const hiveMasterGuidance = getAutoLoadSkillsGuidance(hiveMasterPrompt);

    expect(hiveMasterPrompt).toContain('## Hive — Active Session');
    expect(hiveMasterGuidance).toContain(skillToolCall('brainstorming'));
    expect(hiveMasterGuidance).toContain(skillToolCall('parallel-exploration'));
    expect(hiveMasterPrompt).not.toContain(requireBuiltinSkill('brainstorming').template);
    expect(hiveMasterPrompt).not.toContain(requireBuiltinSkill('parallel-exploration').template);
  });
});

describe('config hook native skill registration', () => {
  let testRoot: string;
  let originalHome: string | undefined;
  let originalExperimentalBackgroundSubagents: string | undefined;
  let originalExperimental: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalExperimentalBackgroundSubagents = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    originalExperimental = process.env.OPENCODE_EXPERIMENTAL;
    originalFetch = globalThis.fetch;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'project-'));
    process.env.HOME = testRoot;
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    delete process.env.OPENCODE_EXPERIMENTAL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalExperimentalBackgroundSubagents === undefined) {
      delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    } else {
      process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = originalExperimentalBackgroundSubagents;
    }
    if (originalExperimental === undefined) {
      delete process.env.OPENCODE_EXPERIMENTAL;
    } else {
      process.env.OPENCODE_EXPERIMENTAL = originalExperimental;
    }
  });

  it('preserves user skill paths after the Hive generated path when URL scans complete and preserves skills.urls exactly', async () => {
    writeHiveConfig(testRoot, { agentMode: 'unified' });
    const userPathOne = path.join(testRoot, 'user-path-one');
    const userPathTwo = path.join(testRoot, 'user-path-two');
    const staleHivePath = path.join(testRoot, '.hive', 'generated', 'opencode-skills', 'old-hash');
    fs.mkdirSync(userPathOne, { recursive: true });
    fs.mkdirSync(userPathTwo, { recursive: true });
    fs.mkdirSync(staleHivePath, { recursive: true });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://example.test/skills/index.json') {
        return new Response(JSON.stringify({ skills: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const opencodeConfig = await applyConfigHook(testRoot, {
      agent: {},
      skills: {
        paths: [staleHivePath, userPathOne, userPathTwo],
        urls: ['https://example.test/skills'],
      },
    });

    const skillPaths = getSkillPaths(opencodeConfig);
    const hiveManagedPaths = getHiveManagedPaths(skillPaths);

    expect(hiveManagedPaths).toHaveLength(1);
    expect(skillPaths).toEqual([hiveManagedPaths[0], userPathOne, userPathTwo]);
    expect(skillPaths).not.toContain(staleHivePath);
    expect(getSkillUrls(opencodeConfig)).toEqual(['https://example.test/skills']);
  });

  it('skips conflicting Hive bundled skills when a native project skill already exists and warns with the native source path', async () => {
    createFileSkill(
      path.join(testRoot, '.opencode', 'skills'),
      'parallel-exploration',
      'Project-native parallel exploration',
      '# Native Parallel Exploration\n\nThis native copy should win.',
    );
    writeHiveConfig(testRoot, { agentMode: 'unified' });

    const { result: opencodeConfig, warnings } = await captureWarnings(async () => applyConfigHook(testRoot));
    const generatedPath = getCurrentHiveManagedPath(opencodeConfig);
    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false });
    const hiveMasterGuidance = getAutoLoadSkillsGuidance(hiveMasterPrompt);
    const parallelExplorationSkill = requireBuiltinSkill('parallel-exploration');

    expect(generatedPath).toBeDefined();
    expect(fs.existsSync(path.join(generatedPath!, 'parallel-exploration'))).toBe(false);
    expect(hiveMasterGuidance).toContain(skillToolCall('parallel-exploration'));
    expect(hiveMasterPrompt).not.toContain(parallelExplorationSkill.template);
    expect(hiveMasterPrompt).not.toContain('# Native Parallel Exploration');
    expect(warnings.some((message) => message.includes('parallel-exploration'))).toBe(false);
  });

  it('adds guidance for a native skill even when disableSkills disables a Hive bundle with the same name', async () => {
    createFileSkill(
      path.join(testRoot, '.opencode', 'skills'),
      'parallel-exploration',
      'Project-native parallel exploration',
      '# Native Parallel Exploration\n\nThis native copy should still autoload.',
    );
    writeHiveConfig(testRoot, {
      agentMode: 'unified',
      disableSkills: ['parallel-exploration'],
    });

    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false });
    const hiveMasterGuidance = getAutoLoadSkillsGuidance(hiveMasterPrompt);

    expect(hiveMasterGuidance).toContain(skillToolCall('parallel-exploration'));
    expect(hiveMasterPrompt).not.toContain('# Native Parallel Exploration');
    expect(hiveMasterPrompt).not.toContain(requireBuiltinSkill('parallel-exploration').template);
  });

  it('adds guidance for native skills from configured skills.paths', async () => {
    const configuredSkillRoot = path.join(testRoot, 'configured-skills');
    createFileSkill(
      configuredSkillRoot,
      'my-custom-skill',
      'A native configured-path skill',
      '# My Custom Skill\n\nNative configured-path content.',
    );
    writeHiveConfig(testRoot, {
      agentMode: 'unified',
      agents: {
        'hive-master': {
          autoLoadSkills: ['my-custom-skill'],
        },
      },
    });

    const opencodeConfigInput = {
      agent: {},
      skills: {
        paths: [configuredSkillRoot],
      },
    };
    const { result: opencodeConfig, warnings } = await captureWarnings(async () => applyConfigHook(testRoot, opencodeConfigInput));
    const generatedPath = getCurrentHiveManagedPath(opencodeConfig);
    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false, opencodeConfig: opencodeConfigInput });
    const hiveMasterGuidance = getAutoLoadSkillsGuidance(hiveMasterPrompt);

    expect(generatedPath).toBeDefined();
    expect(fs.existsSync(path.join(generatedPath!, 'my-custom-skill'))).toBe(false);
    expect(hiveMasterGuidance).toContain(skillToolCall('my-custom-skill'));
    expect(hiveMasterPrompt).not.toContain('# My Custom Skill');
    expect(hiveMasterPrompt).not.toContain('description: A native configured-path skill');
    expect(warnings.some((message) => message.includes('my-custom-skill'))).toBe(false);
  });

  it('uses the parsed SKILL.md frontmatter name for URL conflicts even when index.json uses a different directory name', async () => {
    writeHiveConfig(testRoot, { agentMode: 'unified' });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);

      if (url === 'https://example.test/skills/index.json') {
        return new Response(
          JSON.stringify({
            skills: [{ name: 'index-name-only', files: ['SKILL.md'] }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url === 'https://example.test/skills/index-name-only/SKILL.md') {
        return new Response(
          `---
name: parallel-exploration
description: URL conflict
---
# URL conflict
`,
          { status: 200 },
        );
      }

      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const opencodeConfigInput = {
      agent: {},
      skills: {
        urls: ['https://example.test/skills'],
      },
    };
    const { result: opencodeConfig, warnings } = await captureWarnings(async () => applyConfigHook(testRoot, opencodeConfigInput));
    const generatedPath = getCurrentHiveManagedPath(opencodeConfig);
    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false, opencodeConfig: opencodeConfigInput });
    const hiveMasterGuidance = getAutoLoadSkillsGuidance(hiveMasterPrompt);
    const parallelExplorationSkill = requireBuiltinSkill('parallel-exploration');

    expect(generatedPath).toBeDefined();
    expect(fs.existsSync(path.join(generatedPath!, 'parallel-exploration'))).toBe(false);
    expect(hiveMasterGuidance).toContain(skillToolCall('parallel-exploration'));
    expect(hiveMasterPrompt).not.toContain(parallelExplorationSkill.template);
    expect(hiveMasterPrompt).not.toContain('# URL conflict');
    expect(warnings.some((message) => message.includes('parallel-exploration'))).toBe(false);
  });

  it('preserves user paths and urls but skips Hive materialization when URL conflict scanning is incomplete', async () => {
    writeHiveConfig(testRoot, { agentMode: 'unified' });
    const userPath = path.join(testRoot, 'user-skill-path');
    const staleHivePath = path.join(testRoot, '.hive', 'generated', 'opencode-skills', 'stale-hash');
    fs.mkdirSync(userPath, { recursive: true });
    createFileSkill(
      userPath,
      'local-native-skill',
      'A local native skill that can still autoload on URL failure',
      '# Local Native Skill\n\nURL failure should not suppress this.',
    );
    fs.mkdirSync(staleHivePath, { recursive: true });
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const opencodeConfigInput = {
      agent: {},
      skills: {
        paths: [staleHivePath, userPath],
        urls: ['https://example.test/skills'],
      },
    };
    const { result: opencodeConfig, warnings } = await captureWarnings(async () => applyConfigHook(testRoot, opencodeConfigInput));
    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false, opencodeConfig: opencodeConfigInput });
    const hiveMasterGuidance = getAutoLoadSkillsGuidance(hiveMasterPrompt);

    expect(getHiveManagedPaths(getSkillPaths(opencodeConfig))).toHaveLength(0);
    expect(getSkillPaths(opencodeConfig)).toEqual([userPath]);
    expect(getSkillUrls(opencodeConfig)).toEqual(['https://example.test/skills']);
    expect(hiveMasterGuidance).not.toContain(skillToolCall('parallel-exploration'));
    expect(hiveMasterPrompt).not.toContain(requireBuiltinSkill('parallel-exploration').template);
    expect(hiveMasterPrompt).not.toContain('# Local Native Skill');
    expect(warnings).toContainEqual(
      expect.stringContaining(
        '[hive] Skipping Hive bundled native skill materialization because configured skills URL could not be scanned for conflicts:',
      ),
    );
  });

  it('adds guidance for local native skills while URL scan failure suppresses Hive bundled autoload', async () => {
    writeHiveConfig(testRoot, {
      agentMode: 'unified',
      agents: {
        'hive-master': {
          autoLoadSkills: ['parallel-exploration', 'local-native-skill'],
        },
      },
    });
    createFileSkill(
      path.join(testRoot, '.opencode', 'skills'),
      'local-native-skill',
      'A local native skill that can still autoload on URL failure',
      '# Local Native Skill\n\nURL failure should not suppress this.',
    );
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const opencodeConfigInput = {
      agent: {},
      skills: {
        urls: ['https://example.test/skills'],
      },
    };
    const { result: opencodeConfig, warnings } = await captureWarnings(async () => applyConfigHook(testRoot, opencodeConfigInput));
    const hiveMasterPrompt = await renderRuntimeSystemPrompt(testRoot, 'hive-master', { trackMessage: false, opencodeConfig: opencodeConfigInput });
    const hiveMasterGuidance = getAutoLoadSkillsGuidance(hiveMasterPrompt);

    expect(getHiveManagedPaths(getSkillPaths(opencodeConfig))).toHaveLength(0);
    expect(hiveMasterGuidance).not.toContain(skillToolCall('parallel-exploration'));
    expect(hiveMasterPrompt).not.toContain(requireBuiltinSkill('parallel-exploration').template);
    expect(hiveMasterGuidance).toContain(skillToolCall('local-native-skill'));
    expect(hiveMasterPrompt).not.toContain('# Local Native Skill');
    expect(warnings).toContainEqual(
      expect.stringContaining(
        '[hive] Skipping Hive bundled native skill materialization because configured skills URL could not be scanned for conflicts:',
      ),
    );
  });
});
