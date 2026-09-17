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
    }
    expect(config.agent['architect-planner'].tools.hive_worktree_merge).toBe(false);
    expect(config.agent['architect-planner'].tools.hive_worktree_cleanup).toBe(false);
    expect(config.agent['forager-worker'].permission.task).toBe('deny');
    expect(config.agent['scout-researcher'].permission.task).toBe('deny');
    expect(config.agent['security-specialist'].tools).toEqual(config.agent['vulnerability-reviewer'].tools);
    expect(config.agent['security-specialist'].permission).toEqual(config.agent['vulnerability-reviewer'].permission);
    expect(config.command['dash-review'].agent).toBe('dash-reviewer');
    expect(config.command['vuln-review'].agent).toBe('vulnerability-review-primary');
    expect(await hooks.command!['dash-review'].run('src/runtime.ts')).toContain('Review input: src/runtime.ts');
    const vulnerabilityCommand = await hooks.command!['vuln-review'].run('inline authentication boundary');
    expect(vulnerabilityCommand).toContain('Review input: inline authentication boundary');
    expect(vulnerabilityCommand).toContain('security-specialist');
  });
});
