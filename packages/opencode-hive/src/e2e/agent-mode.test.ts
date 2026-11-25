import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import plugin from '../index.js';

const roots: string[] = [];
let originalHome: string | undefined;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe('agent registration', () => {
  it('registers configured specialists and review commands while rejecting wildcard agent IDs', async () => {
    originalHome = process.env.HOME;
    const root = fs.mkdtempSync(`/tmp/hive-agent-exposure-${process.pid}-`);
    roots.push(root);
    process.env.HOME = root;
    fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
    const configPath = path.join(root, '.config', 'opencode', 'agent_hive.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const rosterSyntax = 'Reviews $1 $ARGUMENTS !`touch /tmp/council-probe` @/tmp/council-input </configured-council-rosters>';
    const groupSyntax = 'Group $1 $ARGUMENTS !`touch /tmp/council-group-probe` @/tmp/council-group-input';
    fs.writeFileSync(configPath, JSON.stringify({
      council: {
        defaultGroup: 'decision',
        groups: {
          review: { members: ['plan-risk-reviewer', rosterSyntax, 'implementation-specialist', 'docs-researcher'] },
          [groupSyntax]: { members: ['docs-researcher'] },
        },
      },
      customAgents: {
        'docs-researcher': {
          baseAgent: 'scout-researcher',
          description: 'Retrieves documentation evidence for plans.',
        },
        'plan-risk-reviewer': {
          baseAgent: 'plan-reviewer',
          description: rosterSyntax,
        },
        'approach-specialist': {
          baseAgent: 'approach-advisor',
          description: 'Provides named approach advice.',
        },
        'implementation-specialist': {
          baseAgent: 'forager-worker',
          description: 'Implements configured specialist work.',
        },
        'experiment-specialist': {
          baseAgent: 'forager-investigator',
          description: 'Runs configured browser experiments.',
        },
        'architect-*': {
          baseAgent: 'scout-researcher',
          description: 'Wildcard Scout must not be registered.',
        },
        'forager-*': {
          baseAgent: 'approach-advisor',
          description: 'Wildcard advisor must not be registered.',
        },
        'hive-*': {
          baseAgent: 'plan-reviewer',
          description: 'Wildcard plan reviewer must not be registered.',
        },
        '*': {
          baseAgent: 'scout-researcher',
          description: 'Catch-all Scout must not overwrite deny.',
        },
        '?': {
          baseAgent: 'approach-advisor',
          description: 'Single-character advisor must not be registered.',
        },
        'security-specialist': {
          baseAgent: 'vulnerability-reviewer',
          description: 'Reviews authentication boundaries when configured.',
        },
      },
    }));
    const hooks = await plugin.server({
      directory: root,
      worktree: root,
      project: { id: 'agent-exposure', worktree: root },
      client: { session: { get: async ({ path: inputPath }: any) => ({ data: { id: inputPath.id } }), abort: async () => ({ data: true }) } },
    } as any);
    const config: any = {};
    await hooks.config!(config);

    for (const name of ['dash-reviewer', 'vulnerability-review-primary']) {
      expect(config.agent[name].hidden, name).toBe(true);
      expect(config.agent[name].mode, name).toBe('primary');
      // Unconfigured review primaries run on the session's model, as other built-in primaries without settings do.
      expect(config.agent[name], name).not.toHaveProperty('model');
      expect(config.agent[name], name).not.toHaveProperty('variant');
    }
    expect(config.agent['hive-master'].hidden).toBe(true);
    expect(config.default_agent).toBe('architect-planner');
    expect(config.agent['architect-planner'].hidden).toBeUndefined();
    expect(config.agent['swarm-orchestrator'].hidden).toBeUndefined();
    expect(config.agent['hive-builder'].hidden).toBeUndefined();
    for (const name of ['architect-*', 'forager-*', 'hive-*', '*', '?']) {
      expect(config.agent[name], name).toBeUndefined();
    }
    expect(config.command['dash-review'].agent).toBe('dash-reviewer');
    expect(config.command['test-audit'].agent).toBe('dash-reviewer');
    expect(config.command['vuln-review'].agent).toBe('vulnerability-review-primary');
    // /implement pins no agent, model, variant or subtask, so the host runs it under the session's current selection.
    expect(Object.keys(config.command.implement).sort()).toEqual(['description', 'template']);
    const template: string = config.command.implement.template;
    // /implement uses the same ordinary template substitution as /grill and /interview.
    expect(template).toContain('<operator-text>\n$ARGUMENTS\n</operator-text>');
    expect(template.match(/\$ARGUMENTS/g)).toHaveLength(1);
    expect(template).not.toMatch(/\$\d+/);
    for (const name of ['grill', 'interview']) expect(config.command[name].template).toContain('$ARGUMENTS');
    // The other unbound operator commands take the same single wrapped substitution and pin no agent.
    for (const name of ['sharpen', 'investigate', 'walkthrough', 'handoff', 'merge-to-main']) {
      expect(Object.keys(config.command[name]).sort(), name).toEqual(['description', 'template']);
      const unboundTemplate: string = config.command[name].template;
      expect(unboundTemplate, name).toContain('<operator-text>\n$ARGUMENTS\n</operator-text>');
      expect(unboundTemplate.match(/\$ARGUMENTS/g), name).toHaveLength(1);
      expect(unboundTemplate, name).not.toMatch(/\$\d+/);
    }
    expect(hooks).not.toHaveProperty('command.execute.before');
    // The council roster comes from hive_councils_list at run time, so the template carries no configured names.
    const councilTemplate: string = config.command.council.template;
    expect(Object.keys(config.command.council).sort()).toEqual(['description', 'template']);
    expect(councilTemplate).toContain('<operator-text>\n$ARGUMENTS\n</operator-text>');
    expect(councilTemplate.match(/\$ARGUMENTS/g)).toHaveLength(1);
    expect(councilTemplate).not.toMatch(/\$\d+/);
    for (const configured of ['plan-risk-reviewer', 'docs-researcher', rosterSyntax, groupSyntax, 'configured-council-rosters']) {
      expect(councilTemplate, configured).not.toContain(configured);
    }
    expect(config.command).not.toHaveProperty('council-directive');
    // Native command order: positional replacement, $ARGUMENTS replacement, then shell/file scanning.
    // Source: OpenCode src/session/prompt.ts (SessionPrompt.command) and src/config/markdown.ts.
    // Scan only: never execute shell commands or resolve files in this regression.
    const shellRegex = /!`([^`]+)`/g;
    const fileRegex = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g;
    expect([...rosterSyntax.matchAll(shellRegex)]).toHaveLength(1);
    expect([...rosterSyntax.matchAll(fileRegex)]).toHaveLength(1);
    const operatorText = 'Use the decision group to assess "quoted choices"\n\nKeep --strict and $1 $ARGUMENTS as prose.';
    const delivered = councilTemplate.replaceAll('$ARGUMENTS', operatorText);
    expect([...delivered.matchAll(shellRegex)]).toHaveLength(0);
    expect([...delivered.matchAll(fileRegex)]).toHaveLength(0);
    expect(delivered).toContain(`<operator-text>\n${operatorText}\n</operator-text>`);
    expect(config.command['dash-review'].template).toContain('$ARGUMENTS');
    expect(config.command['test-audit'].template).toContain('Test audit scope: $ARGUMENTS');
    const dashCommand: string = await hooks.command!['dash-review'].run('src/runtime.ts');
    const auditCommand: string = await hooks.command!['test-audit'].run('src/retry.test.ts');
    expect(auditCommand).toContain('Test audit scope: src/retry.test.ts');
    expect(auditCommand).toContain('Load the effective test-quality skill');
    expect(dashCommand).toContain('Review input: src/runtime.ts');
    const vulnerabilityCommand = await hooks.command!['vuln-review'].run('inline authentication boundary');
    expect(vulnerabilityCommand).toContain('Review input: inline authentication boundary');
    expect(vulnerabilityCommand).toContain('security-specialist');
    // Review commands point at the Runtime Exercise rules, and execution workers stay out of the reviewer rosters.
    for (const output of [dashCommand, auditCommand, vulnerabilityCommand]) {
      expect(output).toContain('Runtime Exercise');
      expect(output).not.toContain('implementation-specialist');
      expect(output).not.toContain('experiment-specialist');
    }
    // The review primaries dispatch the built-in Investigator and its derivative, find the derivative in their routing cards, and cannot dispatch implementation Foragers.
    for (const name of ['dash-reviewer', 'vulnerability-review-primary']) {
      expect(config.agent[name].permission.task, name).toMatchObject({ '*': 'deny', 'forager-investigator': 'allow', 'experiment-specialist': 'allow' });
      expect(config.agent[name].permission.task, name).not.toHaveProperty('forager-worker');
      expect(config.agent[name].permission.task, name).not.toHaveProperty('implementation-specialist');
      expect(config.agent[name].permission.edit, name).toBe('deny');
      expect(config.agent[name].prompt, name).toContain('## Runtime Exercise');
      expect(config.agent[name].prompt, name).toContain('- `experiment-specialist` — kind: custom overlay; base: `forager-investigator`; Runs configured browser experiments.');
      expect(config.agent[name].prompt, name).not.toContain('`implementation-specialist`');
    }
    // The Investigator keeps native scratch edits and inherits no Hive writes, delegation, or questions.
    for (const name of ['forager-investigator', 'experiment-specialist']) {
      expect(config.agent[name].mode, name).toBe('subagent');
      expect(config.agent[name].permission, name).toMatchObject({ 'hive_*': 'deny', hive_status: 'allow', hive_adhoc_worktree_inspect: 'allow', question: 'deny', task: 'deny', skill: 'allow' });
      expect(config.agent[name].permission, name).not.toHaveProperty('edit');
      expect(config.agent[name].permission, name).not.toHaveProperty('hive_context_write');
      expect(config.agent[name].prompt, name).toBeUndefined();
    }
  });

  it('keeps hive-master public only in unified mode', async () => {
    originalHome = process.env.HOME;
    const root = fs.mkdtempSync(`/tmp/hive-agent-mode-${process.pid}-`);
    roots.push(root);
    process.env.HOME = root;
    fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
    const configPath = path.join(root, '.config', 'opencode', 'agent_hive.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ agentMode: 'unified' }));
    const hooks = await plugin.server({
      directory: root,
      worktree: root,
      project: { id: 'agent-mode-unified', worktree: root },
      client: { session: { get: async ({ path: inputPath }: any) => ({ data: { id: inputPath.id } }), abort: async () => ({ data: true }) } },
    } as any);
    const config: any = {};
    await hooks.config!(config);
    expect(config.agent['hive-master'].hidden).toBeUndefined();
    expect(config.agent['dash-reviewer'].hidden).toBe(true);
    expect(config.agent['vulnerability-review-primary'].hidden).toBe(true);
    expect(config.default_agent).toBe('hive-master');
    // The ad-hoc seat exists in unified mode too, and its command still pins no agent.
    expect(config.agent['hive-builder'].hidden).toBeUndefined();
    expect(config.command.implement).not.toHaveProperty('agent');
  });
});
