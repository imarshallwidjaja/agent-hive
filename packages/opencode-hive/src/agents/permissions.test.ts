import { describe, expect, it, spyOn, afterEach, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { ConfigService } from 'hive-core';
import * as path from 'path';
import plugin from '../index';
import { HIVE_TOOL_NAMES } from '../utils/plugin-manifest.js';

const removedHiveSkillTool = ['hive', 'skill'].join('_');

type PluginInput = {
  directory: string;
  worktree: string;
  serverUrl: URL;
  project: { id: string; worktree: string; time: { created: number } };
  client: unknown;
  $: unknown;
};

function createStubShell(): unknown {
  const fn = ((..._args: unknown[]) => {
    throw new Error('shell not available in this test');
  }) as unknown as Record<string, unknown>;

  return Object.assign(fn, {
    braces(pattern: string) {
      return [pattern];
    },
    escape(input: string) {
      return input;
    },
    env() {
      return fn;
    },
    cwd() {
      return fn;
    },
    nothrow() {
      return fn;
    },
    throws() {
      return fn;
    },
  });
}

function createStubClient(): unknown {
  return {
    session: {
      create: async () => ({ data: { id: 'test-session' } }),
      prompt: async () => ({ data: {} }),
      get: async () => ({ data: { status: 'idle' } }),
      messages: async () => ({ data: [] }),
      abort: async () => {},
    },
    app: {
      agents: async () => ({ data: [] }),
      log: async () => {},
    },
    config: {
      get: async () => ({ data: {} }),
    },
  };
}

type AgentConfig = {
  permission?: Record<string, string | Record<string, string>>;
  tools?: Record<string, boolean>;
  prompt?: string;
  model?: string;
  variant?: string;
  description?: string;
};

function resolveTaskPermission(rules: Record<string, string>, target: string): string | undefined {
  let result: string | undefined;
  for (const [pattern, permission] of Object.entries(rules)) {
    if (pattern === '*' || pattern === target) {
      result = permission;
    }
  }
  return result;
}

function resolveToolPermission(rules: Record<string, boolean>, toolName: string): boolean | undefined {
  return rules[toolName] ?? rules['*'];
}

function createGitRepository(repository: string): void {
  mkdirSync(repository, { recursive: true });
  execFileSync('git', ['-C', repository, 'init', '-b', 'main'], { shell: false });
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'snapshot@example.test'], { shell: false });
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'Snapshot Test'], { shell: false });
  writeFileSync(path.join(repository, 'README.md'), 'snapshot fixture\n');
  execFileSync('git', ['-C', repository, 'add', '.'], { shell: false });
  execFileSync('git', ['-C', repository, 'commit', '-m', 'initial'], { shell: false });
}

function gitAt(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    shell: false,
  }).trim();
}

async function createSnapshotPlugin(directory: string): Promise<{
  hooks: Awaited<ReturnType<typeof plugin>>;
  scopeAlias: string;
}> {
  spyOn(ConfigService.prototype, 'get').mockReturnValue({ agentMode: 'unified', agents: {} } as any);
  const hooks = await plugin({
    directory,
    worktree: directory,
    serverUrl: new URL('http://localhost:1'),
    project: { id: 'snapshot', worktree: directory, time: { created: Date.now() } },
    client: createStubClient(),
    $: createStubShell(),
  } as any);
  const config: { agent?: Record<string, AgentConfig> } = {};
  await hooks.config?.(config);
  const scopeAlias = Object.keys(config.agent ?? {}).find((name) => name.startsWith('__hive_dash_review_lane_scope_'));
  if (!scopeAlias) throw new Error('Expected a generated dash scope alias');
  return { hooks, scopeAlias };
}

function snapshotContext(agent: string): Record<string, unknown> {
  return {
    agent,
    sessionID: 'snapshot-session',
    messageID: 'snapshot-message',
    abort: new AbortController().signal,
  };
}

function writeCompositeWorkspaceManifest(workspace: string, repoIds: string[]): void {
  writeFileSync(path.join(workspace, 'workspace.json'), JSON.stringify({
    schemaVersion: 1,
    mode: 'adhoc-composite',
    runId: 'snapshot-run',
    repos: Object.fromEntries(repoIds.map((id) => [id, {
      path: `repos/${id}`,
      repoRoot: `/source/${id}`,
      repoPath: `/source/${id}`,
      branch: `hive/adhoc/${id}/snapshot-run`,
      commit: '0123456789012345678901234567890123456789',
    }])),
    baseCommits: Object.fromEntries(repoIds.map((id) => [id, '0123456789012345678901234567890123456789'])),
    createdAt: '2026-07-11T00:00:00.000Z',
  }));
}

describe('Agent permissions', () => {
  afterEach(() => {
    mock.restore();
  });

  it('registers hive-master, scout, forager, and hygienic in unified mode', async () => {
    // Mock ConfigService to return unified mode
    spyOn(ConfigService.prototype, 'get').mockReturnValue({
      agentMode: 'unified',
      agents: {
        'hive-master': {},
      }
    } as any);

    const repoRoot = path.resolve(import.meta.dir, '..', '..', '..', '..');

    const ctx: PluginInput = {
      directory: repoRoot,
      worktree: repoRoot,
      serverUrl: new URL('http://localhost:1'),
      project: { id: 'test', worktree: repoRoot, time: { created: Date.now() } },
      client: createStubClient(),
      $: createStubShell(),
    };

    const hooks = await plugin(ctx as any);
    
    const opencodeConfig: { 
      agent?: Record<string, AgentConfig>,
      default_agent?: string 
    } = {};
    await hooks.config?.(opencodeConfig);

    expect(opencodeConfig.agent?.['hive-master']).toBeTruthy();
    expect(opencodeConfig.agent?.['swarm-orchestrator']).toBeUndefined();
    expect(opencodeConfig.agent?.['architect-planner']).toBeUndefined();
    expect(opencodeConfig.agent?.['scout-researcher']).toBeTruthy();
    expect(opencodeConfig.agent?.['forager-worker']).toBeTruthy();
    expect(opencodeConfig.agent?.['hive-helper']).toBeTruthy();
    expect(opencodeConfig.agent?.['plan-reviewer']).toBeTruthy();
    expect(opencodeConfig.agent?.['code-reviewer']).toBeTruthy();
    expect(opencodeConfig.agent?.['approach-advisor']).toBeTruthy();
    expect(opencodeConfig.agent?.['hive-builder']).toBeTruthy();
    expect(opencodeConfig.agent?.['__hive_dash_review_primary']).toBeTruthy();
    expect(opencodeConfig.default_agent).toBe('hive-master');

    const hivePerm = opencodeConfig.agent?.['hive-master']?.permission;
    expect(hivePerm).toBeTruthy();
  });

  it('registers dedicated agents in dedicated mode', async () => {
    // Mock ConfigService to return dedicated mode
    spyOn(ConfigService.prototype, 'get').mockReturnValue({
      agentMode: 'dedicated',
      agents: {
        'architect-planner': {},
        'swarm-orchestrator': {},
      }
    } as any);

    const repoRoot = path.resolve(import.meta.dir, '..', '..', '..', '..');

    const ctx: PluginInput = {
      directory: repoRoot,
      worktree: repoRoot,
      serverUrl: new URL('http://localhost:1'),
      project: { id: 'test', worktree: repoRoot, time: { created: Date.now() } },
      client: createStubClient(),
      $: createStubShell(),
    };

    const hooks = await plugin(ctx as any);
    
    const opencodeConfig: { 
      agent?: Record<string, AgentConfig>,
      default_agent?: string 
    } = {};
    await hooks.config?.(opencodeConfig);

    expect(opencodeConfig.agent?.['hive-master']).toBeUndefined();
    expect(opencodeConfig.agent?.['swarm-orchestrator']).toBeTruthy();
    expect(opencodeConfig.agent?.['architect-planner']).toBeTruthy();
    expect(opencodeConfig.agent?.['scout-researcher']).toBeTruthy();
    expect(opencodeConfig.agent?.['forager-worker']).toBeTruthy();
    expect(opencodeConfig.agent?.['hive-helper']).toBeTruthy();
    expect(opencodeConfig.agent?.['plan-reviewer']).toBeTruthy();
    expect(opencodeConfig.agent?.['code-reviewer']).toBeTruthy();
    expect(opencodeConfig.agent?.['approach-advisor']).toBeTruthy();
    expect(opencodeConfig.agent?.['hive-builder']).toBeTruthy();
    expect(opencodeConfig.agent?.['__hive_dash_review_primary']).toBeTruthy();
    expect(opencodeConfig.default_agent).toBe('architect-planner');

    const swarmPerm = opencodeConfig.agent?.['swarm-orchestrator']?.permission;
    const architectPerm = opencodeConfig.agent?.['architect-planner']?.permission;

    expect(swarmPerm).toBeTruthy();
    expect(opencodeConfig.agent?.['swarm-orchestrator']?.prompt).toBeUndefined();
    expect(architectPerm).toBeTruthy();

    expect(architectPerm!.edit).toBe('deny');
    expect(architectPerm!.task).toBe('allow');
  });

  it('explicitly denies delegation tools for subagents', async () => {
    spyOn(ConfigService.prototype, 'get').mockReturnValue({
      agentMode: 'unified',
      agents: {
        'hive-master': {},
      },
    } as any);

    const repoRoot = path.resolve(import.meta.dir, '..', '..', '..', '..');

    const ctx: PluginInput = {
      directory: repoRoot,
      worktree: repoRoot,
      serverUrl: new URL('http://localhost:1'),
      project: { id: 'test', worktree: repoRoot, time: { created: Date.now() } },
      client: createStubClient(),
      $: createStubShell(),
    };

    const hooks = await plugin(ctx as any);
    const opencodeConfig: {
      agent?: Record<string, AgentConfig>;
      default_agent?: string;
    } = {};
    await hooks.config?.(opencodeConfig);

    const subagentNames = ['scout-researcher', 'forager-worker', 'hive-helper', 'plan-reviewer', 'code-reviewer', 'approach-advisor'] as const;
    for (const name of subagentNames) {
      const perm = opencodeConfig.agent?.[name]?.permission;
      expect(perm).toBeTruthy();
      expect(perm!.task).toBe('deny');
      expect(perm!.delegate).toBe('deny');
    }
  });

  it('gives hive-helper the bounded hard-task tool set and no auto-loaded skills appendix', async () => {
    spyOn(ConfigService.prototype, 'get').mockReturnValue({
      agentMode: 'unified',
      agents: {
        'hive-master': {},
        'hive-helper': {},
      },
    } as any);

    const repoRoot = path.resolve(import.meta.dir, '..', '..', '..', '..');
    const ctx: PluginInput = {
      directory: repoRoot,
      worktree: repoRoot,
      serverUrl: new URL('http://localhost:1'),
      project: { id: 'test', worktree: repoRoot, time: { created: Date.now() } },
      client: createStubClient(),
      $: createStubShell(),
    };

    const hooks = await plugin(ctx as any);
    const opencodeConfig: {
      agent?: Record<string, AgentConfig>;
      default_agent?: string;
    } = {};
    await hooks.config?.(opencodeConfig);

    const helper = opencodeConfig.agent?.['hive-helper'];
    expect(helper).toBeTruthy();
    expect(helper?.tools).toBeTruthy();
    expect(helper?.tools?.['hive_merge']).toBeUndefined();
    expect(helper?.tools?.['hive_status']).toBeUndefined();
    expect(helper?.tools?.['hive_context_write']).toBeUndefined();
    expect(helper?.tools?.['hive_task_create']).toBeUndefined();
    expect(helper?.tools?.[removedHiveSkillTool]).toBeUndefined();
    expect(helper?.tools?.['hive_task_update']).toBe(false);
    expect(helper?.tools?.['hive_plan_read']).toBe(false);
    expect(helper?.tools?.['hive_tasks_sync']).toBe(false);
    expect(helper?.tools?.['hive_worktree_start']).toBe(false);
    expect(helper?.tools?.['hive_worktree_create']).toBe(false);
    expect(helper?.tools?.['hive_worktree_commit']).toBe(false);
    expect(helper?.permission?.task).toBe('deny');
    expect(helper?.permission?.delegate).toBe('deny');
    expect(helper?.permission?.skill).toBe('allow');
    expect(helper?.prompt).not.toContain('## Hive Skill:');
  });

  it('inherits subagent safety restrictions for custom forager and reviewer families', async () => {
    spyOn(ConfigService.prototype, 'get').mockReturnValue({
      agentMode: 'unified',
      agents: {
        'hive-master': {},
      },
      customAgents: {
        'forager-ui': {
          baseAgent: 'forager-worker',
          description: 'UI-focused forager',
          variant: 'high',
        },
        'reviewer-security': {
          baseAgent: 'code-reviewer',
          description: 'Security-focused reviewer',
          variant: 'medium',
        },
      },
    } as any);

    const repoRoot = path.resolve(import.meta.dir, '..', '..', '..', '..');

    const ctx: PluginInput = {
      directory: repoRoot,
      worktree: repoRoot,
      serverUrl: new URL('http://localhost:1'),
      project: { id: 'test', worktree: repoRoot, time: { created: Date.now() } },
      client: createStubClient(),
      $: createStubShell(),
    };

    const hooks = await plugin(ctx as any);
    const opencodeConfig: {
      agent?: Record<string, AgentConfig>;
      default_agent?: string;
    } = {};
    await hooks.config?.(opencodeConfig);

    expect(opencodeConfig.agent?.['forager-ui']).toBeTruthy();
    expect(opencodeConfig.agent?.['reviewer-security']).toBeTruthy();

    expect(opencodeConfig.agent?.['forager-ui']?.permission?.task).toBe('deny');
    expect(opencodeConfig.agent?.['forager-ui']?.permission?.delegate).toBe('deny');
    expect(opencodeConfig.agent?.['reviewer-security']?.permission?.edit).toBe('deny');
    expect(opencodeConfig.agent?.['reviewer-security']?.tools).toEqual(
      opencodeConfig.agent?.['code-reviewer']?.tools,
    );
  });
});

describe('Per-agent tool filtering', () => {
  afterEach(() => {
    mock.restore();
  });

  async function buildConfig(agentMode: string, customAgents?: Record<string, unknown>) {
    spyOn(ConfigService.prototype, 'get').mockReturnValue({
      agentMode,
      agents: {},
      ...(customAgents ? { customAgents } : {}),
    } as any);

    const repoRoot = path.resolve(import.meta.dir, '..', '..', '..', '..');
    const ctx: PluginInput = {
      directory: repoRoot,
      worktree: repoRoot,
      serverUrl: new URL('http://localhost:1'),
      project: { id: 'test', worktree: repoRoot, time: { created: Date.now() } },
      client: createStubClient(),
      $: createStubShell(),
    };
    const hooks = await plugin(ctx as any);
    const opencodeConfig: { agent?: Record<string, AgentConfig>; default_agent?: string } = {};
    await hooks.config?.(opencodeConfig);
    return opencodeConfig.agent ?? {};
  }

  it('forager has hive_worktree_commit allowed and hive_merge disabled', async () => {
    const agents = await buildConfig('unified');
    expect(agents['forager-worker']?.prompt).toBeUndefined();
    const foragerTools = agents['forager-worker']?.tools;
    expect(foragerTools).toBeTruthy();
    expect(foragerTools!['hive_worktree_commit']).toBeUndefined();
    expect(foragerTools!['hive_merge']).toBe(false);
    expect(foragerTools!['hive_tasks_sync']).toBe(false);
    expect(foragerTools!['hive_worktree_create']).toBe(false);
    expect(foragerTools!['hive_worktree_start']).toBe(false);
  });

  it('forager tool list keeps only its worktree-read/write hive tools and excludes hive_status', async () => {
    const agents = await buildConfig('unified');
    const foragerTools = agents['forager-worker']?.tools;
    expect(foragerTools).toBeTruthy();
    expect(foragerTools!['hive_status']).toBe(false);
    expect(foragerTools!['hive_plan_read']).toBeUndefined();
    expect(foragerTools!['hive_worktree_commit']).toBeUndefined();
    expect(foragerTools!['hive_context_write']).toBeUndefined();
    expect(foragerTools![removedHiveSkillTool]).toBeUndefined();
  });

  it('hive-helper tool list keeps only merge-recovery hive tools', async () => {
    const agents = await buildConfig('unified');
    const helperTools = agents['hive-helper']?.tools;
    expect(helperTools).toBeTruthy();
    expect(helperTools!['hive_merge']).toBeUndefined();
    expect(helperTools!['hive_status']).toBeUndefined();
    expect(helperTools!['hive_context_write']).toBeUndefined();
    expect(helperTools!['hive_task_create']).toBeUndefined();
    expect(helperTools![removedHiveSkillTool]).toBeUndefined();
    expect(helperTools!['hive_task_update']).toBe(false);
    expect(helperTools!['hive_plan_read']).toBe(false);
    expect(helperTools!['hive_worktree_commit']).toBe(false);
    expect(helperTools!['hive_worktree_start']).toBe(false);
    expect(helperTools!['hive_worktree_create']).toBe(false);
    expect(helperTools!['hive_tasks_sync']).toBe(false);
  });

  it('scout has only read-only hive tools (no worktree_commit, no merge)', async () => {
    const agents = await buildConfig('unified');
    const scoutTools = agents['scout-researcher']?.tools;
    expect(scoutTools).toBeTruthy();
    expect(scoutTools!['hive_worktree_commit']).toBe(false);
    expect(scoutTools!['hive_merge']).toBe(false);
    expect(scoutTools!['hive_plan_read']).toBeUndefined();
    expect(scoutTools!['hive_context_write']).toBeUndefined();
  });

  it('repository manifest tools are available to planners and orchestrators but not workers or read-only agents', async () => {
    const agents = await buildConfig('dedicated');
    const architectTools = agents['architect-planner']?.tools;
    const swarmTools = agents['swarm-orchestrator']?.tools;
    const scoutTools = agents['scout-researcher']?.tools;
    const foragerTools = agents['forager-worker']?.tools;

    expect(architectTools!['hive_repositories_status']).toBeUndefined();
    expect(architectTools!['hive_repositories_discover']).toBeUndefined();
    expect(architectTools!['hive_repositories_update']).toBeUndefined();
    expect(swarmTools!['hive_repositories_status']).toBeUndefined();
    expect(swarmTools!['hive_repositories_discover']).toBeUndefined();
    expect(swarmTools!['hive_repositories_update']).toBeUndefined();
    expect(scoutTools!['hive_repositories_status']).toBe(false);
    expect(scoutTools!['hive_repositories_discover']).toBe(false);
    expect(scoutTools!['hive_repositories_update']).toBe(false);
    expect(foragerTools!['hive_repositories_status']).toBe(false);
    expect(foragerTools!['hive_repositories_discover']).toBe(false);
    expect(foragerTools!['hive_repositories_update']).toBe(false);
  });

  it('background management tools are available only to primary orchestration agents', async () => {
    const agents = await buildConfig('dedicated');
    const architectTools = agents['architect-planner']?.tools;
    const swarmTools = agents['swarm-orchestrator']?.tools;
    const builderTools = agents['hive-builder']?.tools;
    const scoutTools = agents['scout-researcher']?.tools;
    const foragerTools = agents['forager-worker']?.tools;
    const helperTools = agents['hive-helper']?.tools;

    for (const toolName of ['hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel']) {
      expect(architectTools![toolName]).toBeUndefined();
      expect(swarmTools![toolName]).toBeUndefined();
      expect(builderTools![toolName]).toBeUndefined();
      expect(scoutTools![toolName]).toBe(false);
      expect(foragerTools![toolName]).toBe(false);
      expect(helperTools![toolName]).toBe(false);
    }
  });

  it('reviewer agents have same tool set as scout', async () => {
    const agents = await buildConfig('unified');
    const scoutTools = agents['scout-researcher']?.tools;
    expect(scoutTools).toBeTruthy();
    for (const name of ['plan-reviewer', 'code-reviewer', 'approach-advisor'] as const) {
      expect(agents[name]?.tools).toBeTruthy();
      expect(agents[name]?.tools).toEqual(scoutTools);
    }
  });

  it('gives dash-reviewer only generated safe review lanes and preserves configured review identities', async () => {
    const agents = await buildConfig('unified', {
      'scout-audit': {
        baseAgent: 'scout-researcher',
        description: 'Scope and snapshot audit specialist',
        model: 'provider/scout-model',
        variant: 'high',
      },
      'reviewer-security': {
        baseAgent: 'code-reviewer',
        description: 'Security implementation reviewer',
        model: 'provider/security-model',
        variant: 'xhigh',
        autoLoadSkills: ['verification'],
      },
      'reviewer-minimal': {
        baseAgent: 'simplicity-reviewer',
        description: 'Simplicity implementation reviewer',
      },
      'reviewer-*': {
        baseAgent: 'code-reviewer',
        description: 'Glob-shaped reviewer name that must not widen task permissions',
      },
      'reviewer/security': {
        baseAgent: 'code-reviewer',
        description: 'Slash-shaped reviewer name that must not widen task permissions',
      },
      'reviewer\\security': {
        baseAgent: 'code-reviewer',
        description: 'Backslash-shaped reviewer name that must not widen task permissions',
      },
      '42': {
        baseAgent: 'code-reviewer',
        description: 'Numeric reviewer name that must not widen task permissions',
      },
      'forager-ui': {
        baseAgent: 'forager-worker',
        description: 'Mutable implementation worker',
      },
      '__hive_dash_review_lane_scope_1': {
        baseAgent: 'forager-worker',
        description: 'Existing mutable user agent that must not collide with an internal alias',
      },
      'planner-design': {
        baseAgent: 'plan-reviewer',
        description: 'Plan reviewer',
      },
    });
    const reviewer = agents['__hive_dash_review_primary'];
    const tools = reviewer?.tools;
    const taskPermissions = reviewer?.permission?.task as Record<string, string>;
    const safeLanes = Object.entries(agents).filter(([, config]) => {
      return config.description?.startsWith('Dash Review Safe Lane -');
    });

    expect(reviewer).toBeTruthy();
    expect(tools).toBeTruthy();
    expect(tools!['*']).toBe(false);
    expect(tools!.read).toBe(true);
    expect(tools!.glob).toBe(true);
    expect(tools!.grep).toBe(true);
    expect(tools!.task).toBe(true);
    expect(resolveToolPermission(tools!, 'unknown_custom_tool')).toBe(false);
    expect(resolveToolPermission(tools!, 'unknown_mcp_tool')).toBe(false);
    expect(resolveToolPermission(tools!, 'process')).toBe(false);
    for (const toolName of HIVE_TOOL_NAMES) {
      expect(tools![toolName]).toBe(false);
    }
    expect(reviewer?.permission?.edit).toBe('deny');
    expect(reviewer?.permission?.bash).toBe('deny');
    expect(taskPermissions['*']).toBe('deny');
    expect(Object.keys(taskPermissions)[0]).toBe('*');
    expect(safeLanes).toHaveLength(10);
    expect(safeLanes.map(([name]) => name)).not.toContain('__hive_dash_review_lane_scope_1');
    expect(safeLanes.map(([name]) => name)).toContain('__hive_dash_review_lane_scope_2');
    for (const [name] of safeLanes) {
      expect(resolveTaskPermission(taskPermissions, name)).toBe('allow');
    }
    for (const name of [
      'hive-master', 'scout-researcher', 'code-reviewer', 'simplicity-reviewer', 'forager-worker',
      'hive-builder', 'plan-reviewer', 'approach-advisor', 'scout-audit', 'reviewer-security',
       'reviewer-minimal', 'reviewer-*', 'reviewer/security', 'reviewer\\security', '42',
       'forager-ui', 'planner-design',
    ]) {
      expect(resolveTaskPermission(taskPermissions, name)).toBe('deny');
    }
    expect(taskPermissions['reviewer-*']).toBeUndefined();
    expect(taskPermissions['reviewer/security']).toBeUndefined();
    expect(taskPermissions['reviewer\\security']).toBeUndefined();
    expect(taskPermissions['42']).toBeUndefined();
    expect(reviewer?.permission?.delegate).toBe('deny');

    for (const [name, lane] of safeLanes) {
      expect(lane.tools?.['*']).toBe(false);
      expect(lane.tools?.read).toBe(true);
      expect(lane.tools?.glob).toBe(true);
      expect(lane.tools?.grep).toBe(true);
      expect(lane.tools?.task).toBe(false);
      expect(resolveToolPermission(lane.tools!, 'unknown_custom_tool')).toBe(false);
      expect(resolveToolPermission(lane.tools!, 'unknown_mcp_tool')).toBe(false);
      expect(lane.tools?.['hive_context_write']).toBe(false);
      for (const toolName of HIVE_TOOL_NAMES) {
        if (name.includes('_scope_') && (toolName === 'hive_git_snapshot' || toolName === 'hive_repositories_status')) continue;
        expect(lane.tools?.[toolName]).toBe(false);
      }
      expect(lane.permission?.edit).toBe('deny');
      expect(lane.permission?.task).toBe('deny');
      expect(lane.permission?.delegate).toBe('deny');
      expect(lane.permission?.bash).toBe('deny');
      if (name.includes('_scope_')) {
        expect(lane.tools?.['hive_git_snapshot']).toBe(true);
        expect(lane.tools?.['hive_repositories_status']).toBe(true);
      } else {
        expect(lane.tools?.['hive_git_snapshot']).toBe(false);
        expect(lane.tools?.['hive_repositories_status']).toBe(false);
      }
      expect(lane.prompt).toContain('Dash Review Safe Lane');
      expect(lane.prompt).not.toContain('hive_context_write');
    }

    const scopeLane = safeLanes.find(([name]) => name === '__hive_dash_review_lane_scope_2')?.[1];
    const securityLane = safeLanes.find(([, lane]) => lane.model === 'provider/security-model')?.[1];
    expect(scopeLane?.prompt).not.toContain('## Persistence');
    expect(scopeLane?.tools?.['hive_git_snapshot']).toBe(true);
    expect(scopeLane?.prompt).toContain('hive_git_snapshot');
    expect(scopeLane?.prompt).toContain('structured repositoryIds, refs, ranges, paths, and output bounds');
    expect(securityLane?.variant).toBe('xhigh');
    expect(securityLane?.description).toContain('Security implementation reviewer');
    expect(securityLane?.prompt).toContain('Security implementation reviewer');
    expect(securityLane?.permission?.bash).toBe('deny');
    expect(securityLane?.tools?.['hive_git_snapshot']).toBe(false);
    for (const sourceName of ['reviewer-*', 'reviewer/security', 'reviewer\\security', '42']) {
      expect(safeLanes.some(([, lane]) => lane.description?.includes(`- ${sourceName}:`))).toBe(true);
    }
    expect(safeLanes.some(([, lane]) => lane.description?.includes('forager-ui'))).toBe(false);
  });

  it('enforces snapshot callers at runtime after generated scope aliases are registered', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-snapshot-auth-'));
    createGitRepository(repository);
    try {
      spyOn(ConfigService.prototype, 'get').mockReturnValue({ agentMode: 'unified', agents: {} } as any);
      const hooks = await plugin({
        directory: repository,
        worktree: repository,
        serverUrl: new URL('http://localhost:1'),
        project: { id: 'snapshot', worktree: repository, time: { created: Date.now() } },
        client: createStubClient(),
        $: createStubShell(),
      } as any);
      const execute = hooks.tool!.hive_git_snapshot.execute as (input: unknown, context: unknown) => Promise<string>;

      await expect(execute({}, snapshotContext('__hive_dash_review_lane_scope_1'))).rejects.toThrow('not registered');

      const config: { agent?: Record<string, AgentConfig> } = {};
      await hooks.config?.(config);
      const scopeAlias = Object.keys(config.agent ?? {}).find((name) => name.startsWith('__hive_dash_review_lane_scope_'))!;

      await expect(execute({}, snapshotContext('hive-master'))).rejects.toThrow('not authorized');
      await expect(execute({}, snapshotContext('__hive_dash_review_primary'))).rejects.toThrow('not authorized');
      await expect(execute({}, snapshotContext('external-agent'))).rejects.toThrow('not authorized');
      await expect(execute({}, snapshotContext('__hive_dash_review_lane_code_1'))).rejects.toThrow('not authorized');
      expect(JSON.parse(await execute({}, snapshotContext(scopeAlias))).repository.root).toBe(repository);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('enforces dash primary task targets at runtime when task permissions are unavailable', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-dash-task-auth-'));
    createGitRepository(repository);
    try {
      const { hooks } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string; template: string }> } = {};
      await hooks.config?.(config);
      const dashPrimary = config.command?.['dash-review']?.agent!;
      const safeAlias = Object.keys(config.agent ?? {}).find((name) => name.startsWith('__hive_dash_review_lane_scope_'))!;
      const messageHook = hooks['chat.message']!;
      const taskHook = hooks['tool.execute.before']!;
      await messageHook({ sessionID: 'dash-session', agent: dashPrimary }, {
        message: {},
        parts: [],
      } as any);

      await expect(taskHook({ tool: 'task', sessionID: 'dash-session', callID: 'allowed' }, {
        args: { subagent_type: safeAlias },
      })).resolves.toBeUndefined();
      await expect(taskHook({ tool: 'task', sessionID: 'dash-session', callID: 'denied' }, {
        args: { subagent_type: 'forager-worker' },
      })).rejects.toThrow('dash-review task target is not authorized');
      await (hooks as any)['command.execute.before']({
        command: 'dash-review',
        sessionID: 'untracked-dash-session',
        arguments: 'scope',
      }, { parts: [] });
      await expect(taskHook({ tool: 'task', sessionID: 'untracked-dash-session', callID: 'unknown' }, {
        args: { subagent_type: safeAlias },
      })).rejects.toThrow('caller identity is unavailable');
      await messageHook({ sessionID: 'untracked-dash-session', agent: 'hive-master' }, {
        message: {},
        parts: [],
      } as any);
      await expect(taskHook({ tool: 'bash', sessionID: 'untracked-dash-session', callID: 'unexpected-primary' }, {
        args: { command: 'touch should-not-run' },
      })).rejects.toThrow('caller identity is unavailable');
      await messageHook({ sessionID: 'untracked-dash-session', agent: dashPrimary }, {
        message: {},
        parts: [],
      } as any);
      await expect(taskHook({ tool: 'task', sessionID: 'untracked-dash-session', callID: 'confirmed' }, {
        args: { subagent_type: safeAlias },
      })).resolves.toBeUndefined();
      await messageHook({ sessionID: 'untracked-dash-session', agent: 'hive-master' }, {
        message: {},
        parts: [],
      } as any);
      await expect(taskHook({ tool: 'bash', sessionID: 'untracked-dash-session', callID: 'handoff' }, {
        args: { command: 'echo ok' },
      })).resolves.toBeUndefined();
      await hooks.event?.({
        event: { type: 'session.deleted', properties: { sessionID: 'untracked-dash-session' } },
      } as any);
      await expect(taskHook({ tool: 'task', sessionID: 'untracked-dash-session', callID: 'after-delete' }, {
        args: { subagent_type: safeAlias },
      })).resolves.toBeUndefined();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('enforces exact dash runtime tool allowlists despite session-level overrides', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-dash-tool-auth-'));
    createGitRepository(repository);
    try {
      const { hooks } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string; template: string }> } = {};
      await hooks.config?.(config);
      const dashPrimary = config.command?.['dash-review']?.agent!;
      const scopeAlias = Object.keys(config.agent ?? {}).find((name) => name.startsWith('__hive_dash_review_lane_scope_'))!;
      const codeAlias = Object.keys(config.agent ?? {}).find((name) => name.startsWith('__hive_dash_review_lane_code_'))!;
      const messageHook = hooks['chat.message']!;
      const toolHook = hooks['tool.execute.before']!;
      const invoke = (sessionID: string, tool: string, args: Record<string, unknown> = {}) => {
        return toolHook({ tool, sessionID, callID: `${sessionID}-${tool}` }, { args });
      };

      await messageHook({ sessionID: 'dash-primary', agent: dashPrimary }, { message: {}, parts: [] } as any);
      for (const tool of ['read', 'glob', 'grep']) {
        await expect(invoke('dash-primary', tool)).resolves.toBeUndefined();
      }
      await expect(invoke('dash-primary', 'task', { subagent_type: scopeAlias })).resolves.toBeUndefined();
      for (const tool of ['bash', 'edit', 'hive_feature_create', 'hive_git_snapshot', 'mutating_mcp_tool']) {
        await expect(invoke('dash-primary', tool, { command: 'touch should-not-run' })).rejects.toThrow('dash-review tool is not authorized');
      }

      await messageHook({ sessionID: 'dash-scope', agent: scopeAlias }, { message: {}, parts: [] } as any);
      for (const tool of ['read', 'glob', 'grep', 'hive_repositories_status', 'hive_git_snapshot']) {
        await expect(invoke('dash-scope', tool)).resolves.toBeUndefined();
      }
      for (const tool of ['task', 'bash', 'edit', 'hive_feature_create', 'mutating_mcp_tool']) {
        await expect(invoke('dash-scope', tool, { subagent_type: scopeAlias })).rejects.toThrow('dash-review tool is not authorized');
      }

      await messageHook({ sessionID: 'dash-code', agent: codeAlias }, { message: {}, parts: [] } as any);
      for (const tool of ['read', 'glob', 'grep']) {
        await expect(invoke('dash-code', tool)).resolves.toBeUndefined();
      }
      for (const tool of ['task', 'bash', 'edit', 'hive_git_snapshot', 'hive_feature_create', 'mutating_mcp_tool']) {
        await expect(invoke('dash-code', tool, { subagent_type: scopeAlias })).rejects.toThrow('dash-review tool is not authorized');
      }
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('resolves snapshot repository IDs through the real composite workspace manifest and requires an ID outside a single root', async () => {
    const composite = mkdtempSync(path.join(os.tmpdir(), 'hive-snapshot-composite-'));
    const api = path.join(composite, 'repos', 'api');
    const web = path.join(composite, 'repos', 'web');
    createGitRepository(api);
    createGitRepository(web);
    writeCompositeWorkspaceManifest(composite, ['api', 'web']);
    try {
      const { hooks, scopeAlias } = await createSnapshotPlugin(composite);
      const execute = hooks.tool!.hive_git_snapshot.execute as (input: unknown, context: unknown) => Promise<string>;

      const all = JSON.parse(await execute({}, snapshotContext(scopeAlias)));
      expect(all.manifestRepositoryIds).toEqual(['api', 'web']);
      expect(all.selectedRepositoryIds).toEqual(['api', 'web']);
      expect(all.excludedRepositoryIds).toEqual([]);
      expect(all.snapshots.map((entry: { repositoryId: string; snapshot: { repository: { root: string } } }) => entry.repositoryId)).toEqual(['api', 'web']);
      expect(all.snapshots.map((entry: { repositoryId: string; snapshot: { repository: { root: string } } }) => entry.snapshot.repository.root)).toEqual([api, web]);
      const narrowed = JSON.parse(await execute({ repositoryIds: ['api'] }, snapshotContext(scopeAlias)));
      expect(narrowed.selectedRepositoryIds).toEqual(['api']);
      expect(narrowed.excludedRepositoryIds).toEqual(['web']);
      await expect(execute({ repositoryIds: ['missing'] }, snapshotContext(scopeAlias))).rejects.toThrow('Unknown repositoryId');
    } finally {
      rmSync(composite, { recursive: true, force: true });
    }
  });

  it('treats an exact Git workspace root as single-root despite an unrelated workspace.json', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-snapshot-root-manifest-'));
    createGitRepository(repository);
    writeFileSync(path.join(repository, 'workspace.json'), JSON.stringify({ name: 'unrelated monorepo metadata' }));
    try {
      const { hooks, scopeAlias } = await createSnapshotPlugin(repository);
      const execute = hooks.tool!.hive_git_snapshot.execute as (input: unknown, context: unknown) => Promise<string>;

      expect(JSON.parse(await execute({}, snapshotContext(scopeAlias))).repository.root).toBe(repository);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('rejects an exact Git workspace root with a valid Hive composite manifest as ambiguous', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-snapshot-ambiguous-root-'));
    const childRepository = path.join(repository, 'repos', 'api');
    createGitRepository(repository);
    createGitRepository(childRepository);
    writeCompositeWorkspaceManifest(repository, ['api']);
    try {
      const { hooks, scopeAlias } = await createSnapshotPlugin(repository);
      const execute = hooks.tool!.hive_git_snapshot.execute as (input: unknown, context: unknown) => Promise<string>;

      await expect(execute({}, snapshotContext(scopeAlias))).rejects.toThrow(/ambiguous/i);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('rejects traversal-shaped composite repository IDs and malformed entry paths', async () => {
    const composite = mkdtempSync(path.join(os.tmpdir(), 'hive-snapshot-invalid-manifest-'));
    mkdirSync(path.join(composite, 'repos'), { recursive: true });
    writeFileSync(path.join(composite, 'workspace.json'), JSON.stringify({
      schemaVersion: 1,
      mode: 'adhoc-composite',
      runId: 'snapshot-run',
      repos: {
        '../evil': {
          path: 'repos/../evil',
          repoRoot: '/source/evil',
          repoPath: '/source/evil',
          branch: 'hive/adhoc/evil/snapshot-run',
          commit: '0123456789012345678901234567890123456789',
        },
      },
      baseCommits: { '../evil': '0123456789012345678901234567890123456789' },
      createdAt: '2026-07-11T00:00:00.000Z',
    }));
    try {
      const { hooks, scopeAlias } = await createSnapshotPlugin(composite);
      const execute = hooks.tool!.hive_git_snapshot.execute as (input: unknown, context: unknown) => Promise<string>;

      await expect(execute({ repositoryIds: ['../evil'] }, snapshotContext(scopeAlias))).rejects.toThrow('Invalid composite workspace manifest');
    } finally {
      rmSync(composite, { recursive: true, force: true });
    }
  });

  it('rejects a composite repository symlink that escapes the workspace root', async () => {
    if (process.platform === 'win32') return;
    const composite = mkdtempSync(path.join(os.tmpdir(), 'hive-snapshot-symlink-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'hive-snapshot-outside-'));
    createGitRepository(outside);
    mkdirSync(path.join(composite, 'repos'), { recursive: true });
    try {
      symlinkSync(outside, path.join(composite, 'repos', 'api'));
      writeCompositeWorkspaceManifest(composite, ['api']);
      const { hooks, scopeAlias } = await createSnapshotPlugin(composite);
      const execute = hooks.tool!.hive_git_snapshot.execute as (input: unknown, context: unknown) => Promise<string>;

      await expect(execute({ repositoryIds: ['api'] }, snapshotContext(scopeAlias))).rejects.toThrow('symlink');
    } finally {
      rmSync(composite, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a Gitfile/core.worktree redirect outside the authorized composite repository root', async () => {
    const composite = mkdtempSync(path.join(os.tmpdir(), 'hive-snapshot-worktree-'));
    const api = path.join(composite, 'repos', 'api');
    const outside = path.join(composite, 'outside');
    mkdirSync(api, { recursive: true });
    createGitRepository(outside);
    writeFileSync(path.join(api, '.git'), `gitdir: ${path.join(outside, '.git')}\n`);
    gitAt(api, ['config', 'core.worktree', outside]);
    writeCompositeWorkspaceManifest(composite, ['api']);
    try {
      const { hooks, scopeAlias } = await createSnapshotPlugin(composite);
      const execute = hooks.tool!.hive_git_snapshot.execute as (input: unknown, context: unknown) => Promise<string>;

      await expect(execute({ repositoryIds: ['api'] }, snapshotContext(scopeAlias))).rejects.toThrow('does not match the authorized repository root');
    } finally {
      rmSync(composite, { recursive: true, force: true });
    }
  });

  it('uses the Git project root when a snapshot omits repositoryIds in single-root mode', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-snapshot-root-'));
    createGitRepository(repository);
    try {
      const { hooks, scopeAlias } = await createSnapshotPlugin(repository);
      const execute = hooks.tool!.hive_git_snapshot.execute as (input: unknown, context: unknown) => Promise<string>;

      expect(JSON.parse(await execute({}, snapshotContext(scopeAlias))).repository.root).toBe(repository);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('keeps an existing custom dash-reviewer separate from the collision-proof command primary', async () => {
    spyOn(ConfigService.prototype, 'get').mockReturnValue({
      agentMode: 'unified',
      agents: {
        'dash-reviewer': {
          model: 'provider/command-review-model',
        },
      },
      customAgents: {
        'dash-reviewer': {
          baseAgent: 'code-reviewer',
          description: 'Existing custom reviewer',
          model: 'provider/custom-review-model',
          variant: 'high',
        },
      },
    } as any);
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-dash-name-collision-'));
    createGitRepository(repository);
    try {
      const hooks = await plugin({
        directory: repository,
        worktree: repository,
        serverUrl: new URL('http://localhost:1'),
        project: { id: 'collision', worktree: repository, time: { created: Date.now() } },
        client: createStubClient(),
        $: createStubShell(),
      } as any);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string; template: string }> } = {};

      await hooks.config?.(config);

      expect(config.command?.['dash-review']?.agent).toBe('__hive_dash_review_primary');
      expect(config.agent?.['__hive_dash_review_primary']?.model).toBeUndefined();
      expect(config.agent?.['dash-reviewer']?.model).toBe('provider/custom-review-model');
      const output = { message: {}, parts: [] } as any;
      await hooks['chat.message']?.({ sessionID: 'custom-dash-reviewer', agent: 'dash-reviewer' }, output);
      expect(output.message.variant).toBe('high');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('architect has planning tools but no worktree tools', async () => {
    const agents = await buildConfig('dedicated');
    const architectTools = agents['architect-planner']?.tools;
    expect(architectTools).toBeTruthy();
    expect(architectTools!['hive_plan_write']).toBeUndefined();
    expect(architectTools!['hive_plan_patch']).toBeUndefined();
    expect(architectTools!['hive_worktree_create']).toBe(false);
    expect(architectTools!['hive_worktree_start']).toBe(false);
    expect(architectTools!['hive_worktree_commit']).toBe(false);
    expect(architectTools!['hive_merge']).toBe(false);
  });

  it('swarm has orchestration tools but no plan_write or worktree_commit', async () => {
    const agents = await buildConfig('dedicated');
    const swarmTools = agents['swarm-orchestrator']?.tools;
    expect(swarmTools).toBeTruthy();
    expect(swarmTools!['hive_worktree_create']).toBeUndefined();
    expect(swarmTools!['hive_worktree_start']).toBeUndefined();
    expect(swarmTools!['hive_plan_write']).toBe(false);
    expect(swarmTools!['hive_plan_patch']).toBe(false);
    expect(swarmTools!['hive_worktree_commit']).toBe(false);
    expect(swarmTools!['hive_merge']).toBeUndefined();
    expect(swarmTools!['hive_plan_approve']).toBeUndefined();
  });

  it('registers plan patch as a write-scoped planning tool', async () => {
    expect(HIVE_TOOL_NAMES as readonly string[]).toContain('hive_plan_patch');

    const agents = await buildConfig('dedicated');
    expect(agents['architect-planner']?.tools?.['hive_plan_patch']).toBeUndefined();
    expect(agents['swarm-orchestrator']?.tools?.['hive_plan_patch']).toBe(false);
    expect(agents['scout-researcher']?.tools?.['hive_plan_patch']).toBe(false);
    expect(agents['forager-worker']?.tools?.['hive_plan_patch']).toBe(false);
  });

  it('allows todo read/write only for hive, architect, and swarm primary roles', async () => {
    const unifiedAgents = await buildConfig('unified');
    expect(unifiedAgents['hive-master']?.permission?.todoread).toBe('allow');
    expect(unifiedAgents['hive-master']?.permission?.todowrite).toBe('allow');
    expect(unifiedAgents['scout-researcher']?.permission?.todoread).toBeUndefined();
    expect(unifiedAgents['scout-researcher']?.permission?.todowrite).toBeUndefined();
    expect(unifiedAgents['forager-worker']?.permission?.todoread).toBeUndefined();
    expect(unifiedAgents['forager-worker']?.permission?.todowrite).toBeUndefined();
    expect(unifiedAgents['hive-helper']?.permission?.todoread).toBeUndefined();
    expect(unifiedAgents['hive-helper']?.permission?.todowrite).toBeUndefined();
    for (const name of ['plan-reviewer', 'code-reviewer', 'approach-advisor'] as const) {
      expect(unifiedAgents[name]?.permission?.todoread).toBeUndefined();
      expect(unifiedAgents[name]?.permission?.todowrite).toBeUndefined();
    }

    const dedicatedAgents = await buildConfig('dedicated');
    expect(dedicatedAgents['architect-planner']?.permission?.todoread).toBe('allow');
    expect(dedicatedAgents['architect-planner']?.permission?.todowrite).toBe('allow');
    expect(dedicatedAgents['swarm-orchestrator']?.permission?.todoread).toBe('allow');
    expect(dedicatedAgents['swarm-orchestrator']?.permission?.todowrite).toBe('allow');
    expect(dedicatedAgents['scout-researcher']?.permission?.todoread).toBeUndefined();
    expect(dedicatedAgents['scout-researcher']?.permission?.todowrite).toBeUndefined();
    expect(dedicatedAgents['forager-worker']?.permission?.todoread).toBeUndefined();
    expect(dedicatedAgents['forager-worker']?.permission?.todowrite).toBeUndefined();
    expect(dedicatedAgents['hive-helper']?.permission?.todoread).toBeUndefined();
    expect(dedicatedAgents['hive-helper']?.permission?.todowrite).toBeUndefined();
    for (const name of ['plan-reviewer', 'code-reviewer', 'approach-advisor'] as const) {
      expect(dedicatedAgents[name]?.permission?.todoread).toBeUndefined();
      expect(dedicatedAgents[name]?.permission?.todowrite).toBeUndefined();
    }
  });

  it('does not expose the removed historical lookup tool to any agent', async () => {
    const removedNetworkTool = ['hive', 'network', 'query'].join('_');
    const unifiedAgents = await buildConfig('unified');
    for (const agent of Object.values(unifiedAgents)) {
      expect(agent.tools ?? {}).not.toHaveProperty(removedNetworkTool);
    }

    const dedicatedAgents = await buildConfig('dedicated');
    for (const agent of Object.values(dedicatedAgents)) {
      expect(agent.tools ?? {}).not.toHaveProperty(removedNetworkTool);
    }
  });

  it('does not expose the removed AGENTS.md maintenance tool to any agent', async () => {
    const removedAgentsMdTool = ['hive', 'agents', 'md'].join('_');
    const unifiedAgents = await buildConfig('unified');
    for (const agent of Object.values(unifiedAgents)) {
      expect(agent.tools ?? {}).not.toHaveProperty(removedAgentsMdTool);
    }

    const dedicatedAgents = await buildConfig('dedicated');
    for (const agent of Object.values(dedicatedAgents)) {
      expect(agent.tools ?? {}).not.toHaveProperty(removedAgentsMdTool);
    }
  });

  it('hive-master has no tools filter (all tools allowed)', async () => {
    const agents = await buildConfig('unified');
    const hiveTools = agents['hive-master']?.tools;
    expect(hiveTools).toBeUndefined();
    expect(agents['hive-master']?.prompt).toBeUndefined();
  });

  it('hive-builder gets ad-hoc + repo manifest tools and disables task-backed worktree/plan tools by default', async () => {
    const agents = await buildConfig('unified');
    const builder = agents['hive-builder'];
    expect(builder).toBeTruthy();
    expect(builder!.prompt).toBeUndefined();
    const tools = builder!.tools!;
    expect(tools).toBeTruthy();
    // Allowed (entries absent = allowed)
    expect(tools['hive_adhoc_worktree_create']).toBeUndefined();
    expect(tools['hive_adhoc_worktree_commit']).toBeUndefined();
    expect(tools['hive_adhoc_merge']).toBeUndefined();
    expect(tools['hive_adhoc_cleanup']).toBeUndefined();
    expect(tools['hive_repositories_status']).toBeUndefined();
    expect(tools['hive_repositories_discover']).toBeUndefined();
    expect(tools['hive_repositories_update']).toBeUndefined();
    expect(tools['hive_background_status']).toBeUndefined();
    expect(tools['hive_background_reconcile']).toBeUndefined();
    expect(tools['hive_background_reconcile_batch']).toBeUndefined();
    expect(tools['hive_background_cancel']).toBeUndefined();
    expect(tools['hive_context_write']).toBeUndefined();
    // Disabled task-backed/plan/feature tools
    expect(tools['hive_worktree_start']).toBe(false);
    expect(tools['hive_worktree_create']).toBe(false);
    expect(tools['hive_worktree_commit']).toBe(false);
    expect(tools['hive_merge']).toBe(false);
    expect(tools['hive_status']).toBe(false);
    expect(tools['hive_feature_create']).toBe(false);
    expect(tools['hive_plan_write']).toBe(false);
    expect(tools['hive_tasks_sync']).toBe(false);
    // Permissions
    expect(builder!.permission?.task).toBe('allow');
    expect(builder!.permission?.question).toBe('allow');
    expect(builder!.permission?.skill).toBe('allow');
    expect(builder!.permission?.todowrite).toBe('allow');
    expect(builder!.permission?.todoread).toBe('allow');
  });

  it('hive-helper still has ad-hoc tools disabled', async () => {
    const agents = await buildConfig('unified');
    const helperTools = agents['hive-helper']?.tools;
    expect(helperTools).toBeTruthy();
    expect(helperTools!['hive_adhoc_worktree_create']).toBe(false);
    expect(helperTools!['hive_adhoc_worktree_commit']).toBe(false);
    expect(helperTools!['hive_adhoc_merge']).toBe(false);
    expect(helperTools!['hive_adhoc_cleanup']).toBe(false);
  });
});
