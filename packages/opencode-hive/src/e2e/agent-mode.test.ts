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

describe('agent tool exposure', () => {
  it('uses exposure policy instead of runtime identity admission', async () => {
    originalHome = process.env.HOME;
    const root = fs.mkdtempSync(`/tmp/hive-agent-exposure-${process.pid}-`);
    roots.push(root);
    process.env.HOME = root;
    fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
    const configPath = path.join(root, '.config', 'opencode', 'agent_hive.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      customAgents: {
        'docs-researcher': {
          baseAgent: 'scout-researcher',
          description: 'Retrieves documentation evidence for plans.',
        },
        'plan-risk-reviewer': {
          baseAgent: 'plan-reviewer',
          description: 'Reviews risky plans.',
        },
        'approach-specialist': {
          baseAgent: 'approach-advisor',
          description: 'Provides named approach advice.',
        },
        'implementation-specialist': {
          baseAgent: 'forager-worker',
          description: 'Implements configured specialist work.',
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
    const hooks = await plugin({
      directory: root,
      worktree: root,
      project: { id: 'agent-exposure', worktree: root },
      client: { session: { get: async ({ path: inputPath }: any) => ({ data: { id: inputPath.id } }), abort: async () => ({ data: true }) } },
    } as any);
    const config: any = {};
    await hooks.config!(config);

    const scout = config.agent['scout-researcher'];
    expect(scout.tools.hive_context_read).toBeUndefined();
    expect(scout.tools.hive_context_write).toBe(false);
    expect(scout.tools.hive_constraints_add).toBe(false);

    for (const name of ['forager-worker', 'plan-reviewer', 'code-reviewer', 'simplicity-reviewer', 'approach-advisor', 'vulnerability-reviewer']) {
      expect(config.agent[name].tools.hive_context_read, name).toBeUndefined();
      expect(config.agent[name].tools.hive_context_write, name).toBeUndefined();
      expect(config.agent[name].tools.hive_context_append, name).toBeUndefined();
      expect(config.agent[name].tools.hive_context_archive, name).toBe(false);
      expect(config.agent[name].tools.hive_constraints_add, name).toBe(false);
    }

    for (const name of ['hive-master', 'architect-planner', 'swarm-orchestrator', 'hive-builder']) {
      expect(config.agent[name].tools.hive_constraints_add, name).toBeUndefined();
      expect(config.agent[name].tools.hive_context_archive, name).toBeUndefined();
    }
    for (const name of ['dash-reviewer', 'vulnerability-review-primary']) {
      expect(config.agent[name].tools.hive_constraints_add, name).toBe(false);
      expect(config.agent[name].tools.hive_context_archive, name).toBe(false);
      expect(config.agent[name].tools.hive_git_snapshot, name).toBeUndefined();
      expect(config.agent[name].tools.hive_worktree_merge, name).toBe(false);
      expect(config.agent[name].hidden, name).toBe(true);
    }
    expect(config.agent['hive-master'].hidden).toBe(true);
    expect(config.agent['architect-planner'].hidden).toBeUndefined();
    expect(config.agent['swarm-orchestrator'].hidden).toBeUndefined();
    expect(config.agent['hive-builder'].hidden).toBeUndefined();
    expect(config.agent['architect-planner'].tools.hive_worktree_merge).toBe(false);
    expect(config.agent['architect-planner'].tools.hive_worktree_cleanup).toBe(false);
    expect(config.agent['architect-planner'].permission.task).toMatchObject({
      '*': 'deny',
      'scout-researcher': 'allow',
      'plan-reviewer': 'allow',
      'approach-advisor': 'allow',
      'docs-researcher': 'allow',
      'plan-risk-reviewer': 'allow',
      'approach-specialist': 'allow',
    });
    expect(config.agent['architect-planner'].permission.task['architect-planner']).toBeUndefined();
    expect(config.agent['architect-planner'].permission.task['forager-worker']).toBeUndefined();
    expect(config.agent['architect-planner'].permission.task['implementation-specialist']).toBeUndefined();
    expect(config.agent['architect-planner'].permission.task['hive-master']).toBeUndefined();
    for (const name of ['architect-*', 'forager-*', 'hive-*', '?']) {
      expect(config.agent['architect-planner'].permission.task[name], name).toBeUndefined();
    }
    expect(config.agent['architect-planner'].permission.task['*']).toBe('deny');
    expect(config.agent['forager-worker'].permission.task).toBe('deny');
    expect(config.agent['implementation-specialist'].permission.task).toBe('deny');
    expect(config.agent['scout-researcher'].permission.task).toBe('deny');
    expect(config.agent['docs-researcher'].permission.task).toBe('deny');
    expect(config.agent['plan-risk-reviewer'].permission.task).toBe('deny');
    expect(config.agent['approach-specialist'].permission.task).toBe('deny');
    expect(config.agent['security-specialist'].tools).toEqual(config.agent['vulnerability-reviewer'].tools);
    expect(config.agent['security-specialist'].permission).toEqual(config.agent['vulnerability-reviewer'].permission);
    expect(config.command['dash-review'].agent).toBe('dash-reviewer');
    expect(config.command['vuln-review'].agent).toBe('vulnerability-review-primary');
    expect(await hooks.command!['dash-review'].run('src/runtime.ts')).toContain('Review input: src/runtime.ts');
    const vulnerabilityCommand = await hooks.command!['vuln-review'].run('inline authentication boundary');
    expect(vulnerabilityCommand).toContain('Review input: inline authentication boundary');
    expect(vulnerabilityCommand).toContain('security-specialist');
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
    const hooks = await plugin({
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
  });
});
