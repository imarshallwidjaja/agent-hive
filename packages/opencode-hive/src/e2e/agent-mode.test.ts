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

    for (const name of ['dash-reviewer', 'vulnerability-review-primary']) {
      expect(config.agent[name].hidden, name).toBe(true);
    }
    expect(config.agent['hive-master'].hidden).toBe(true);
    expect(config.agent['architect-planner'].hidden).toBeUndefined();
    expect(config.agent['swarm-orchestrator'].hidden).toBeUndefined();
    expect(config.agent['hive-builder'].hidden).toBeUndefined();
    for (const name of ['architect-*', 'forager-*', 'hive-*', '*', '?']) {
      expect(config.agent[name], name).toBeUndefined();
    }
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
