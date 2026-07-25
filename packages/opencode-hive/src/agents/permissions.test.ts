import { describe, expect, it, spyOn, afterEach, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { ConfigService, FeatureService, ReviewWorkspaceService, TaskService } from 'hive-core';
import * as path from 'path';
import plugin from '../index';
import { HIVE_TOOL_NAMES } from '../utils/plugin-manifest.js';

const removedHiveSkillTool = ['hive', 'skill'].join('_');
const expectedVulnerabilityReviewMcpTools = [
  'ast_grep_dump_syntax_tree',
  'ast_grep_find_code',
  'ast_grep_find_code_by_rule',
  'ast_grep_test_match_code_rule',
  'context7_resolve-library-id',
  'context7_query-docs',
  'grep_app_searchGitHub',
  'websearch_web_search_exa',
] as const;

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
  vulnerabilityScopeAlias: string;
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
  const scopeAlias = findDashScopeAlias(config.agent);
  if (!scopeAlias) throw new Error('Expected a generated dash scope alias');
  const vulnerabilityScopeAlias = Object.keys(config.agent ?? {}).find((name) => {
    const agent = config.agent?.[name];
    return name.startsWith('__hive_vulnerability_review_')
      && agent?.tools?.hive_review_workspace_create === true;
  });
  if (!vulnerabilityScopeAlias) throw new Error('Expected a generated vulnerability-review scope alias');
  return { hooks, scopeAlias, vulnerabilityScopeAlias };
}

function findDashReviewLanes(agents: Record<string, AgentConfig> | undefined): Array<[string, AgentConfig]> {
  return Object.entries(agents ?? {}).filter(([, config]) => {
    return config.description?.startsWith('Frozen Workspace Review Lane -');
  });
}

function findDashScopeAlias(agents: Record<string, AgentConfig> | undefined): string | undefined {
  return findDashReviewLanes(agents).find(([, config]) => config.tools?.hive_review_workspace_create === true)?.[0];
}

function findDashCodeAlias(agents: Record<string, AgentConfig> | undefined): string | undefined {
  return findDashReviewLanes(agents).find(([, config]) => {
    return config.tools?.hive_review_workspace_create !== true
      && config.description?.includes('code-reviewer');
  })?.[0];
}

function findVulnerabilityReviewLanes(agents: Record<string, AgentConfig> | undefined): Array<[string, AgentConfig]> {
  return Object.entries(agents ?? {}).filter(([name]) => name.startsWith('__hive_vulnerability_review_')
    && name !== '__hive_vulnerability_review_primary');
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
    expect(helper?.tools?.['hive_plan_read']).toBeUndefined();
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

  it('forager tool list keeps its worktree tools and universal metadata inspection tools', async () => {
    const agents = await buildConfig('unified');
    const foragerTools = agents['forager-worker']?.tools;
    expect(foragerTools).toBeTruthy();
    expect(foragerTools!['hive_status']).toBeUndefined();
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
    expect(helperTools!['hive_plan_read']).toBeUndefined();
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

  it('repository status is universal while repository mutation stays limited to planners and orchestrators', async () => {
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
    expect(scoutTools!['hive_repositories_status']).toBeUndefined();
    expect(scoutTools!['hive_repositories_discover']).toBe(false);
    expect(scoutTools!['hive_repositories_update']).toBe(false);
    expect(foragerTools!['hive_repositories_status']).toBeUndefined();
    expect(foragerTools!['hive_repositories_discover']).toBe(false);
    expect(foragerTools!['hive_repositories_update']).toBe(false);
  });

  it('allows universal metadata inspection for every built-in, custom, and generated agent', async () => {
    const customAgents = {
      'forager-custom': {
        baseAgent: 'forager-worker',
        description: 'Custom worker',
      },
      'reviewer-custom': {
        baseAgent: 'code-reviewer',
        description: 'Custom reviewer',
      },
    };
    const agentSets = [
      await buildConfig('unified', customAgents),
      await buildConfig('dedicated', customAgents),
    ];

    for (const agents of agentSets) {
      for (const [name, agent] of Object.entries(agents)) {
        if (name.startsWith('__hive_vulnerability_review_')) continue;
        for (const tool of ['hive_repositories_status', 'hive_plan_read', 'hive_status']) {
          expect(agent.tools?.[tool], `${name} must not deny ${tool}`).not.toBe(false);
        }
      }
    }
  });

  it('registers exact fail-closed vulnerability review permissions and custom specialist identity', async () => {
    const agents = await buildConfig('unified', {
      'security-supply-chain': {
        baseAgent: 'vulnerability-reviewer',
        description: 'Supply-chain attack paths',
        model: 'provider/supply-chain',
        variant: 'xhigh',
      },
    });
    const primary = agents['__hive_vulnerability_review_primary']!;
    const lanes = findVulnerabilityReviewLanes(agents);
    const taskRules = primary.permission?.task as Record<string, string>;

    expect(primary.tools).toEqual(Object.fromEntries(HIVE_TOOL_NAMES.map((tool) => [
      tool,
      ['hive_review_workspace_claim', 'hive_review_workspace_inspect', 'hive_review_workspace_cleanup'].includes(tool),
    ])));
    expect(taskRules['*']).toBe('deny');
    expect(Object.keys(taskRules)[0]).toBe('*');
    expect(lanes).toHaveLength(8);
    for (const [target, lane] of lanes) {
      expect(resolveTaskPermission(taskRules, target)).toBe('allow');
      expect(lane.permission?.['*']).toBe('deny');
    }
    for (const target of ['scout-researcher', 'vulnerability-reviewer', 'security-supply-chain', '__hive_dash_review_primary']) {
      expect(resolveTaskPermission(taskRules, target)).toBe('deny');
    }
    const custom = lanes.find(([, lane]) => lane.model === 'provider/supply-chain')?.[1];
    expect(custom).toMatchObject({ model: 'provider/supply-chain', variant: 'xhigh' });
    expect(custom?.description).toContain('Supply-chain attack paths');
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

  it('gives dash-reviewer generated review lanes with normal local tools and denied Hive lifecycle mutation', async () => {
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
      'review-scout-researcher': {
        baseAgent: 'forager-worker',
        description: 'Existing mutable user agent that must not collide with a generated review alias',
      },
      'planner-design': {
        baseAgent: 'plan-reviewer',
        description: 'Plan reviewer',
      },
    });
    const reviewer = agents['__hive_dash_review_primary'];
    const tools = reviewer?.tools;
    const taskPermissions = reviewer?.permission?.task as Record<string, string>;
    const reviewLanes = findDashReviewLanes(agents);

    expect(reviewer).toBeTruthy();
    expect(tools).toBeTruthy();
    expect(tools!['*']).toBeUndefined();
    expect(resolveToolPermission(tools!, 'unknown_custom_tool')).toBeUndefined();
    expect(resolveToolPermission(tools!, 'unknown_mcp_tool')).toBeUndefined();
    expect(resolveToolPermission(tools!, 'bash')).toBeUndefined();
    for (const toolName of HIVE_TOOL_NAMES) {
      if (['hive_repositories_status', 'hive_plan_read', 'hive_status'].includes(toolName)) {
        expect(tools![toolName]).toBeUndefined();
      } else {
        expect(tools![toolName]).toBe([
          'hive_review_workspace_claim', 'hive_review_workspace_inspect', 'hive_review_workspace_cleanup',
        ].includes(toolName));
      }
    }
    expect(reviewer?.permission?.edit).toBe('deny');
    expect(reviewer?.permission?.bash).toBeUndefined();
    expect(taskPermissions['*']).toBe('deny');
    expect(Object.keys(taskPermissions)[0]).toBe('*');
    expect(reviewLanes).toHaveLength(10);
    expect(reviewLanes.map(([name]) => name)).not.toContain('review-scout-researcher');
    expect(reviewLanes.map(([name]) => name)).toContain('review-scout-researcher-2');
    expect(reviewLanes.map(([name]) => name)).toContain('review-code-reviewer');
    expect(reviewLanes.every(([name]) => name.startsWith('review-'))).toBe(true);
    expect(reviewLanes.some(([name]) => name.includes('__hive_dash_review_lane_'))).toBe(false);
    for (const [name] of reviewLanes) {
      expect(resolveTaskPermission(taskPermissions, name)).toBe('allow');
    }
    for (const name of [
      'hive-master', 'scout-researcher', 'code-reviewer', 'simplicity-reviewer', 'forager-worker',
      'hive-builder', 'plan-reviewer', 'approach-advisor', 'scout-audit', 'reviewer-security',
       'reviewer-minimal', 'reviewer-*', 'reviewer/security', 'reviewer\\security', '42',
       'forager-ui', 'planner-design', 'review-scout-researcher',
    ]) {
      expect(resolveTaskPermission(taskPermissions, name)).toBe('deny');
    }
    expect(taskPermissions['reviewer-*']).toBeUndefined();
    expect(taskPermissions['reviewer/security']).toBeUndefined();
    expect(taskPermissions['reviewer\\security']).toBeUndefined();
    expect(taskPermissions['42']).toBeUndefined();
    expect(reviewer?.permission?.delegate).toBe('deny');

    for (const [name, lane] of reviewLanes) {
      expect(lane.tools?.['*']).toBeUndefined();
      expect(resolveToolPermission(lane.tools!, 'unknown_custom_tool')).toBeUndefined();
      expect(resolveToolPermission(lane.tools!, 'unknown_mcp_tool')).toBeUndefined();
      expect(lane.tools?.['hive_context_write']).toBe(false);
      for (const toolName of ['hive_repositories_status', 'hive_plan_read', 'hive_status']) {
        expect(lane.tools?.[toolName]).toBe(true);
      }
      const isScopeLane = lane.tools?.hive_review_workspace_create === true;
      for (const toolName of HIVE_TOOL_NAMES) {
        if (['hive_repositories_status', 'hive_plan_read', 'hive_status'].includes(toolName)) continue;
        if (isScopeLane && ['hive_git_snapshot', 'hive_review_workspace_create'].includes(toolName)) continue;
        expect(lane.tools?.[toolName]).toBe(false);
      }
      expect(lane.permission?.edit).toBe('deny');
      expect(lane.permission?.task).toBe('deny');
      expect(lane.permission?.delegate).toBe('deny');
      expect(lane.permission?.bash).toBeUndefined();
      if (isScopeLane) {
        expect(lane.tools?.['hive_git_snapshot']).toBe(true);
        expect(lane.tools?.['hive_repositories_status']).toBe(true);
        expect(lane.tools?.['hive_review_workspace_create']).toBe(true);
      } else {
        expect(lane.tools?.['hive_git_snapshot']).toBe(false);
        expect(lane.tools?.['hive_review_workspace_create']).toBe(false);
      }
      expect(lane.prompt).toContain('Frozen Workspace Review Lane');
      expect(lane.prompt).not.toContain('DoorDash');
      expect(lane.prompt).not.toContain('hive_context_write');
      expect(name.startsWith('review-')).toBe(true);
    }

    const scopeLane = reviewLanes.find(([name]) => name === 'review-scout-researcher-2')?.[1];
    const securityLane = reviewLanes.find(([, lane]) => lane.model === 'provider/security-model')?.[1];
    expect(scopeLane?.prompt).not.toContain('## Persistence');
    expect(scopeLane?.tools?.['hive_git_snapshot']).toBe(true);
    expect(scopeLane?.prompt).toContain('hive_git_snapshot');
    expect(scopeLane?.prompt).toContain('hive_review_workspace_create');
    expect(scopeLane?.prompt).toContain('first tool call must be `hive_repositories_status`');
    expect(scopeLane?.prompt).toContain('`hive_status`');
    expect(scopeLane?.prompt).not.toContain('do not call `hive_status`');
    expect(securityLane?.variant).toBe('xhigh');
    expect(securityLane?.description).toContain('Security implementation reviewer');
    expect(securityLane?.prompt).toContain('Security implementation reviewer');
    expect(securityLane?.permission?.bash).toBeUndefined();
    expect(securityLane?.tools?.['hive_git_snapshot']).toBe(false);
    expect(securityLane?.prompt).toContain('process cwd is live source');
    for (const sourceName of ['reviewer-*', 'reviewer/security', 'reviewer\\security', '42']) {
      expect(reviewLanes.some(([, lane]) => lane.description?.includes(`- ${sourceName}:`))).toBe(true);
    }
    expect(reviewLanes.some(([, lane]) => lane.description?.includes('forager-ui'))).toBe(false);
  });

  it('replaces plugin-owned generated review wrappers idempotently on config reentry', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-dash-review-reentry-'));
    createGitRepository(repository);
    try {
      spyOn(ConfigService.prototype, 'get').mockReturnValue({
        agentMode: 'unified',
        agents: {},
        customAgents: {
          'review-custom-user': {
            baseAgent: 'forager-worker',
            description: 'Unrelated user agent that starts with review-',
          },
        },
      } as any);
      const hooks = await plugin({
        directory: repository,
        worktree: repository,
        serverUrl: new URL('http://localhost:1'),
        project: { id: 'reentry', worktree: repository, time: { created: Date.now() } },
        client: createStubClient(),
        $: createStubShell(),
      } as any);

      const opencodeConfig: { agent?: Record<string, AgentConfig> } = {};
      await hooks.config?.(opencodeConfig);
      const firstLanes = findDashReviewLanes(opencodeConfig.agent);
      const firstTargets = firstLanes.map(([name]) => name).sort();
      const firstScope = findDashScopeAlias(opencodeConfig.agent)!;
      const firstCode = findDashCodeAlias(opencodeConfig.agent)!;
      const firstCount = firstLanes.length;
      expect(firstCount).toBeGreaterThan(0);
      expect(opencodeConfig.agent?.['review-custom-user']).toBeTruthy();
      expect(opencodeConfig.agent?.['review-custom-user']?.description).toBe(
        'Unrelated user agent that starts with review-',
      );

      // Another plugin/config pass may mutate a prior generated target's description.
      // Reentry must still replace exact prior runtime targets without alias churn.
      const mutatedTarget = firstScope;
      const mutatedAgent = opencodeConfig.agent?.[mutatedTarget];
      expect(mutatedAgent).toBeTruthy();
      opencodeConfig.agent![mutatedTarget] = {
        ...mutatedAgent!,
        description: 'Mutated by another plugin pass - no Frozen Workspace prefix',
        model: 'mutated/other-plugin',
      };

      await hooks.config?.(opencodeConfig);
      const secondLanes = findDashReviewLanes(opencodeConfig.agent);
      const secondTargets = secondLanes.map(([name]) => name).sort();
      const secondScope = findDashScopeAlias(opencodeConfig.agent)!;
      const secondCode = findDashCodeAlias(opencodeConfig.agent)!;
      const reviewPrefixed = Object.keys(opencodeConfig.agent ?? {}).filter((name) => name.startsWith('review-'));
      const staleAliases = reviewPrefixed.filter((name) => {
        if (name === 'review-custom-user') return false;
        return !secondTargets.includes(name);
      });

      expect(secondTargets).toEqual(firstTargets);
      expect(secondLanes).toHaveLength(firstCount);
      expect(staleAliases).toEqual([]);
      expect(opencodeConfig.agent?.[mutatedTarget]?.description?.startsWith('Frozen Workspace Review Lane -')).toBe(true);
      expect(opencodeConfig.agent?.['review-custom-user']?.description).toBe(
        'Unrelated user agent that starts with review-',
      );
      expect(secondScope).toBe(firstScope);
      expect(secondCode).toBe(firstCode);

      const execute = hooks.tool!.hive_git_snapshot.execute as (input: unknown, context: unknown) => Promise<string>;
      expect(JSON.parse(await execute({}, snapshotContext(secondScope))).repository.root).toBe(repository);
      await expect(execute({}, snapshotContext(secondCode))).rejects.toThrow('not authorized');
      await expect(execute({}, snapshotContext(`${secondScope}-2`))).rejects.toThrow(/not (registered|authorized)/);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
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

      await expect(execute({}, snapshotContext('review-scout-researcher-unregistered'))).rejects.toThrow('not authorized');

      const config: { agent?: Record<string, AgentConfig> } = {};
      await hooks.config?.(config);
      const scopeAlias = findDashScopeAlias(config.agent)!;
      const codeAlias = findDashCodeAlias(config.agent)!;

      await expect(execute({}, snapshotContext('hive-master'))).rejects.toThrow('not authorized');
      await expect(execute({}, snapshotContext('__hive_dash_review_primary'))).rejects.toThrow('not authorized');
      await expect(execute({}, snapshotContext('external-agent'))).rejects.toThrow('not authorized');
      await expect(execute({}, snapshotContext(codeAlias))).rejects.toThrow('not authorized');
      expect(JSON.parse(await execute({}, snapshotContext(scopeAlias))).repository.root).toBe(repository);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('materializes a disposable review workspace for the scope lane and lets only the primary inspect or clean it', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-review-workspace-tool-'));
    createGitRepository(repository);
    writeFileSync(path.join(repository, 'README.md'), 'dirty source\n');
    try {
      const { hooks, scopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string; template: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['dash-review']?.agent!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (input: unknown, context: unknown) => Promise<string>;
      const claim = hooks.tool!.hive_review_workspace_claim.execute as (input: unknown, context: unknown) => Promise<string>;
      const inspect = hooks.tool!.hive_review_workspace_inspect.execute as (input: unknown, context: unknown) => Promise<string>;
      const cleanup = hooks.tool!.hive_review_workspace_cleanup.execute as (input: unknown, context: unknown) => Promise<string>;
      const primaryContext = { ...snapshotContext(primary), sessionID: 'dash-primary-inspect' };

      await expect(create({}, snapshotContext(primary))).rejects.toThrow('not authorized');
      const created = JSON.parse(await create({}, snapshotContext(scopeAlias)));
      expect(created.state).toBe('READY');
      expect(readFileSync(path.join(created.workspacePath, 'README.md'), 'utf8')).toBe('dirty source\n');
      expect(readFileSync(path.join(repository, 'README.md'), 'utf8')).toBe('dirty source\n');
      await hooks['chat.message']?.({ sessionID: 'dash-primary-inspect', agent: primary }, { message: {}, parts: [] } as any);
      await expect(inspect({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext)).rejects.toThrow('inspection was denied');
      await claim({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext);
      const initialInspection = JSON.parse(await inspect({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext));
      expect(initialInspection.source.stable).toBe(true);
      writeFileSync(path.join(created.workspacePath, 'new-untracked.txt'), 'workspace delta\n');
      const untrackedInspection = JSON.parse(await inspect({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext));
      expect(untrackedInspection.integrity).toMatchObject({ baselineClean: true, untrackedFiles: true });
      expect(untrackedInspection.reviewIntegrity).toBe(false);
      rmSync(path.join(created.workspacePath, 'new-untracked.txt'));
      writeFileSync(path.join(repository, 'README.md'), 'live source drift\n');
      const sourceDriftInspection = JSON.parse(await inspect({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext));
      expect(sourceDriftInspection.integrity).toMatchObject({ baselineClean: true, untrackedFiles: false });
      expect(sourceDriftInspection.materialized.matches).toBe(true);
      expect(sourceDriftInspection.source.stable).toBe(false);
      expect(sourceDriftInspection.reviewIntegrity).toBe(false);
      writeFileSync(path.join(repository, 'README.md'), 'dirty source\n');
      writeFileSync(path.join(created.workspacePath, 'README.md'), 'review workspace drift\n');
      const workspaceDriftInspection = JSON.parse(await inspect({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext));
      expect(workspaceDriftInspection.source.stable).toBe(true);
      expect(workspaceDriftInspection.reviewIntegrity).toBe(false);
      expect(JSON.parse(await cleanup({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext).then((result) => result)).cleaned).toBe(true);
      expect(existsSync(created.workspacePath)).toBe(false);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('rejects every invalid vulnerability scope before review workspace creation', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-scope-membership-'));
    createGitRepository(repository);
    try {
      new FeatureService(repository).create('scope-feature');
      const taskFolder = new TaskService(repository).create('scope-feature', 'scope-task');
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const create = hooks.tool!.hive_review_workspace_create.execute as (input: unknown, context: unknown) => Promise<string>;
      const createWorkspace = spyOn(ReviewWorkspaceService.prototype, 'create');
      const context = snapshotContext(vulnerabilityScopeAlias);
      const featureAlias = '01_scope-feature/../01_scope-feature';
      const physicalFeatureAlias = '01_scope-feature';
      const taskAlias = `${taskFolder}/../${taskFolder}`;

      const invalidScopes: Array<[string, Record<string, unknown>, string]> = [
        ['missing mode', {}, 'requires a valid normalized scopeMode'],
        ['unknown mode', { scopeMode: 'unknown' }, 'requires a valid normalized scopeMode'],
        ['current change with range', { scopeMode: 'current-change', range: 'HEAD...HEAD' }, 'current-change scope cannot include Git comparison refs'],
        ['current change with Hive metadata', { scopeMode: 'current-change', hiveScope: 'feature:scope-feature' }, 'current-change scope cannot include Hive metadata'],
        ['current change with task metadata', { scopeMode: 'current-change', hiveScope: `task:${taskFolder}` }, 'current-change scope cannot include Hive metadata'],
        ['Git comparison without refs', { scopeMode: 'git-comparison' }, 'Git comparison scope requires range or baseRef'],
        ['Git comparison with malformed range', { scopeMode: 'git-comparison', range: 'HEAD..HEAD' }, 'range must use <base>...<target>'],
        ['Git comparison with range and base', { scopeMode: 'git-comparison', range: 'HEAD...HEAD', baseRef: 'HEAD' }, 'range cannot be combined'],
        ['Git comparison with range and target', { scopeMode: 'git-comparison', range: 'HEAD...HEAD', targetRef: 'HEAD' }, 'range cannot be combined'],
        ['Git comparison with target only', { scopeMode: 'git-comparison', targetRef: 'HEAD' }, 'targetRef requires baseRef'],
        ['Git comparison with Hive metadata', { scopeMode: 'git-comparison', baseRef: 'HEAD', hiveScope: 'feature:scope-feature' }, 'git-comparison scope cannot include Hive metadata'],
        ['task without metadata', { scopeMode: 'hive-task' }, 'Hive task scope requires task:<folder> metadata'],
        ['task with feature metadata', { scopeMode: 'hive-task', hiveScope: 'feature:scope-feature' }, 'Hive task scope requires task:<folder> metadata'],
        ['task with Git refs', { scopeMode: 'hive-task', hiveScope: `task:${taskFolder}`, baseRef: 'HEAD' }, 'hive-task scope cannot include Git comparison refs'],
        ['task with traversal alias', { scopeMode: 'hive-task', hiveScope: `task:${taskAlias}` }, `Unresolved Hive task metadata: task:${taskAlias}.`],
        ['task with missing member', { scopeMode: 'hive-task', hiveScope: 'task:99-missing' }, 'Unresolved Hive task metadata: task:99-missing.'],
        ['feature without metadata', { scopeMode: 'hive-feature' }, 'Hive feature scope requires feature:<name> metadata'],
        ['feature with task metadata', { scopeMode: 'hive-feature', hiveScope: `task:${taskFolder}` }, 'Hive feature scope requires feature:<name> metadata'],
        ['feature with Git refs', { scopeMode: 'hive-feature', hiveScope: 'feature:scope-feature', range: 'HEAD...HEAD' }, 'hive-feature scope cannot include Git comparison refs'],
        ['feature with traversal alias', { scopeMode: 'hive-feature', hiveScope: `feature:${featureAlias}` }, `Unresolved Hive feature metadata: feature:${featureAlias}.`],
        ['feature with physical alias', { scopeMode: 'hive-feature', hiveScope: `feature:${physicalFeatureAlias}` }, `Unresolved Hive feature metadata: feature:${physicalFeatureAlias}.`],
        ['whole repository with path', { scopeMode: 'whole-repository', paths: ['src'] }, 'Whole-repository scope cannot include paths or Hive scope'],
        ['whole repository with Hive metadata', { scopeMode: 'whole-repository', hiveScope: 'feature:scope-feature' }, 'Whole-repository scope cannot include paths or Hive scope'],
        ['whole repository with Git refs', { scopeMode: 'whole-repository', baseRef: 'HEAD' }, 'whole-repository scope cannot include Git comparison refs'],
        ['path escape', { scopeMode: 'current-change', paths: ['../outside'] }, 'Path must be repository-relative'],
        ['absolute path', { scopeMode: 'current-change', paths: ['/etc/passwd'] }, 'Path must be repository-relative'],
        ['backslash path', { scopeMode: 'current-change', paths: ['src\\secret'] }, 'Path must be repository-relative'],
        ['NUL path', { scopeMode: 'current-change', paths: ['src\0secret'] }, 'Path must be repository-relative'],
        ['option-shaped path', { scopeMode: 'current-change', paths: ['--secret'] }, 'Path must be repository-relative'],
        ['colon-shaped path', { scopeMode: 'current-change', paths: [':secret'] }, 'Path must be repository-relative'],
      ];

      for (const [name, input, error] of invalidScopes) {
        await expect(create(input, context), name).rejects.toThrow(error);
      }
      expect(createWorkspace).not.toHaveBeenCalled();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('creates every legal runtime scope after exact task and feature resolution', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-valid-scopes-'));
    createGitRepository(repository);
    try {
      new FeatureService(repository).create('scope-feature');
      const taskFolder = new TaskService(repository).create('scope-feature', 'scope-task');
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const create = hooks.tool!.hive_review_workspace_create.execute as (input: unknown, context: unknown) => Promise<string>;
      const createWorkspace = spyOn(ReviewWorkspaceService.prototype, 'create');
      const context = snapshotContext(vulnerabilityScopeAlias);
      const legalScopes: Array<[string, Record<string, unknown>]> = [
        ['current change', { scopeMode: 'current-change', paths: ['README.md'] }],
        ['Git range', { scopeMode: 'git-comparison', range: 'HEAD...HEAD', paths: ['README.md'] }],
        ['Git base and target', { scopeMode: 'git-comparison', baseRef: 'HEAD', targetRef: 'HEAD' }],
        ['Hive task', { scopeMode: 'hive-task', hiveScope: `task:${taskFolder}`, paths: ['README.md'] }],
        ['Hive feature', { scopeMode: 'hive-feature', hiveScope: 'feature:scope-feature' }],
        ['whole repository', { scopeMode: 'whole-repository' }],
      ];

      for (const [name, input] of legalScopes) {
        const created = JSON.parse(await create(input, context));
        expect(created.state, name).toBe('READY');
        expect(created.scopeFingerprint, name).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(createWorkspace).toHaveBeenCalledTimes(legalScopes.length);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('rejects an unknown repository through the workspace creation tool before service create', async () => {
    const composite = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-unknown-repository-'));
    const api = path.join(composite, 'repos', 'api');
    createGitRepository(api);
    writeCompositeWorkspaceManifest(composite, ['api']);
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(composite);
      const create = hooks.tool!.hive_review_workspace_create.execute as (input: unknown, context: unknown) => Promise<string>;
      const createWorkspace = spyOn(ReviewWorkspaceService.prototype, 'create');

      await expect(create({
        scopeMode: 'current-change',
        repositoryIds: ['missing'],
      }, snapshotContext(vulnerabilityScopeAlias))).rejects.toThrow('Unknown repositoryId: missing');
      expect(createWorkspace).not.toHaveBeenCalled();
    } finally {
      rmSync(composite, { recursive: true, force: true });
    }
  });

  it('cleans a review workspace when its primary session is deleted', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-review-workspace-session-'));
    createGitRepository(repository);
    try {
      const { hooks, scopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string; template: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['dash-review']?.agent!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (input: unknown, context: unknown) => Promise<string>;
      const claim = hooks.tool!.hive_review_workspace_claim.execute as (input: unknown, context: unknown) => Promise<string>;

      const created = JSON.parse(await create({}, snapshotContext(scopeAlias)));
      await claim({ runId: created.runId, ownershipToken: created.ownershipToken }, {
        ...snapshotContext(primary),
        sessionID: 'dash-primary-cleanup',
      });
      await hooks.event?.({ event: { type: 'session.deleted', properties: { sessionID: 'dash-primary-cleanup' } } } as any);

      expect(existsSync(created.workspacePath)).toBe(false);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('reports every workspace preserved by session-deletion cleanup', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-review-workspace-session-errors-'));
    createGitRepository(repository);
    try {
      const { hooks, scopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string; template: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['dash-review']?.agent!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (input: unknown, context: unknown) => Promise<string>;
      const claim = hooks.tool!.hive_review_workspace_claim.execute as (input: unknown, context: unknown) => Promise<string>;
      const primaryContext = { ...snapshotContext(primary), sessionID: 'dash-primary-errors' };
      const first = JSON.parse(await create({}, snapshotContext(scopeAlias)));
      const second = JSON.parse(await create({}, snapshotContext(scopeAlias)));
      const third = JSON.parse(await create({}, snapshotContext(scopeAlias)));
      await claim({ runId: first.runId, ownershipToken: first.ownershipToken }, primaryContext);
      await claim({ runId: second.runId, ownershipToken: second.ownershipToken }, primaryContext);
      await claim({ runId: third.runId, ownershipToken: third.ownershipToken }, primaryContext);
      const cleanupOwnedBySession = spyOn(ReviewWorkspaceService.prototype, 'cleanupOwnedBySession').mockResolvedValue([
        { runId: first.runId, cleaned: false, workspacePath: first.workspacePath, errors: ['injected cleanup failure'] },
        { runId: second.runId, cleaned: false, workspacePath: second.workspacePath, errors: ['injected cleanup result'] },
        { runId: third.runId, cleaned: true, workspacePath: third.workspacePath, errors: [] },
      ]);
      const warn = spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(hooks.event?.({ event: { type: 'session.deleted', properties: { sessionID: 'dash-primary-errors' } } } as any)).resolves.toBeUndefined();

      expect(cleanupOwnedBySession).toHaveBeenCalledWith('dash-primary-errors', ['dash-review', 'vulnerability-review']);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${first.runId}: injected cleanup failure`));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${second.runId}: injected cleanup result`));
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('keeps two fresh review runs isolated by primary ownership tokens', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-review-workspace-owners-'));
    createGitRepository(repository);
    try {
      const { hooks, scopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string; template: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['dash-review']?.agent!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (input: unknown, context: unknown) => Promise<string>;
      const claim = hooks.tool!.hive_review_workspace_claim.execute as (input: unknown, context: unknown) => Promise<string>;
      const inspect = hooks.tool!.hive_review_workspace_inspect.execute as (input: unknown, context: unknown) => Promise<string>;
      const cleanup = hooks.tool!.hive_review_workspace_cleanup.execute as (input: unknown, context: unknown) => Promise<string>;
      const first = JSON.parse(await create({}, snapshotContext(scopeAlias)));
      const second = JSON.parse(await create({}, snapshotContext(scopeAlias)));
      const firstContext = { ...snapshotContext(primary), sessionID: 'dash-primary-first' };
      const secondContext = { ...snapshotContext(primary), sessionID: 'dash-primary-second' };
      await hooks['chat.message']?.({ sessionID: 'dash-primary-first', agent: primary }, { message: {}, parts: [] } as any);
      await hooks['chat.message']?.({ sessionID: 'dash-primary-second', agent: primary }, { message: {}, parts: [] } as any);
      await claim({ runId: first.runId, ownershipToken: first.ownershipToken }, firstContext);
      await claim({ runId: second.runId, ownershipToken: second.ownershipToken }, secondContext);

      await expect(inspect({ runId: first.runId, ownershipToken: first.ownershipToken }, secondContext)).rejects.toThrow('inspection was denied');
      await expect(cleanup({ runId: first.runId, ownershipToken: first.ownershipToken }, secondContext)).rejects.toThrow('cleanup was denied');
      await hooks.event?.({ event: { type: 'session.deleted', properties: { sessionID: 'dash-primary-first' } } } as any);
      expect(existsSync(first.workspacePath)).toBe(false);
      expect(existsSync(second.workspacePath)).toBe(true);
      await cleanup({ runId: second.runId, ownershipToken: second.ownershipToken }, secondContext);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('reconstructs vulnerability workspace authorization after plugin restart without crossing workflow identity', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-restart-'));
    createGitRepository(repository);
    try {
      const firstPlugin = await createSnapshotPlugin(repository);
      const firstConfig: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await firstPlugin.hooks.config?.(firstConfig);
      const vulnerabilityPrimary = firstConfig.command?.['vuln-review']?.agent!;
      const dashPrimary = firstConfig.command?.['dash-review']?.agent!;
      const create = firstPlugin.hooks.tool!.hive_review_workspace_create.execute as (input: unknown, context: unknown) => Promise<string>;
      const claim = firstPlugin.hooks.tool!.hive_review_workspace_claim.execute as (input: unknown, context: unknown) => Promise<string>;
      const created = JSON.parse(await create({ scopeMode: 'current-change' }, snapshotContext(firstPlugin.vulnerabilityScopeAlias)));
      const ownerContext = { ...snapshotContext(vulnerabilityPrimary), sessionID: 'vulnerability-restart-session' };
      await firstPlugin.hooks['chat.message']?.({ sessionID: 'vulnerability-restart-session', agent: vulnerabilityPrimary }, { message: {}, parts: [] } as any);
      await claim({ runId: created.runId, ownershipToken: created.ownershipToken }, ownerContext);

      const secondPlugin = await createSnapshotPlugin(repository);
      const secondConfig: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await secondPlugin.hooks.config?.(secondConfig);
      const inspect = secondPlugin.hooks.tool!.hive_review_workspace_inspect.execute as (input: unknown, context: unknown) => Promise<string>;
      const cleanup = secondPlugin.hooks.tool!.hive_review_workspace_cleanup.execute as (input: unknown, context: unknown) => Promise<string>;
      await secondPlugin.hooks['chat.message']?.({ sessionID: 'vulnerability-restart-session', agent: vulnerabilityPrimary }, { message: {}, parts: [] } as any);
      const reconstructed = JSON.parse(await inspect({
        runId: created.runId,
        ownershipToken: created.ownershipToken,
      }, ownerContext));
      expect(reconstructed).toMatchObject({ reviewIntegrity: true, source: { stable: true }, materialized: { matches: true } });
      await expect(inspect({
        runId: created.runId,
        ownershipToken: created.ownershipToken,
      }, { ...ownerContext, agent: dashPrimary })).rejects.toThrow('inspection was denied');
      expect(JSON.parse(await cleanup({
        runId: created.runId,
        ownershipToken: created.ownershipToken,
      }, ownerContext)).cleaned).toBe(true);
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
      const safeAlias = findDashScopeAlias(config.agent)!;
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
      await expect(taskHook({ tool: 'task', sessionID: 'dash-session', callID: 'prefix-denied' }, {
        args: { subagent_type: `${safeAlias}-extra` },
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
      })).resolves.toBeUndefined();
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

  it('enforces vulnerability role allowlists and cross-workflow task isolation at runtime', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-tool-auth-'));
    createGitRepository(repository);
    try {
      const { hooks } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const dashPrimary = config.command?.['dash-review']?.agent!;
      const vulnerabilityLanes = findVulnerabilityReviewLanes(config.agent);
      const scope = vulnerabilityLanes.find(([, lane]) => lane.tools?.hive_review_workspace_create === true)?.[0]!;
      const baseline = vulnerabilityLanes.find(([, lane]) => lane.prompt?.includes('mandatory cross-cutting baseline'))?.[0]!;
      const dashScope = findDashScopeAlias(config.agent)!;
      const message = hooks['chat.message']!;
      const before = hooks['tool.execute.before']!;
      const invoke = (sessionID: string, tool: string, args: Record<string, unknown> = {}) => before(
        { tool, sessionID, callID: `${sessionID}-${tool}` },
        { args },
      );

      await message({ sessionID: 'vuln-primary', agent: primary }, { message: {}, parts: [] } as any);
      await expect(invoke('vuln-primary', 'task', { subagent_type: scope })).resolves.toBeUndefined();
      await expect(invoke('vuln-primary', 'task', { subagent_type: dashScope })).rejects.toThrow('vulnerability-review task target is not authorized');
      await expect(invoke('vuln-primary', 'bash')).rejects.toThrow('vulnerability-review tool is not authorized');

      await message({ sessionID: 'vuln-scope', agent: scope }, { message: {}, parts: [] } as any);
      for (const tool of ['read', 'glob', 'grep', 'hive_repositories_status', 'hive_status', 'hive_plan_read', 'hive_review_workspace_create', ...expectedVulnerabilityReviewMcpTools]) {
        await expect(invoke('vuln-scope', tool)).resolves.toBeUndefined();
      }
      for (const tool of ['task', 'bash', 'write', 'edit', 'webfetch', 'skill', 'todowrite', 'context-mode_ctx_execute', 'gpt_imagegen', 'unknown_user_mcp', 'hive_feature_create']) {
        await expect(invoke('vuln-scope', tool, { subagent_type: scope })).rejects.toThrow('vulnerability-review tool is not authorized');
      }

      await message({ sessionID: 'vuln-baseline', agent: baseline }, { message: {}, parts: [] } as any);
      for (const tool of ['read', 'glob', 'grep', ...expectedVulnerabilityReviewMcpTools]) {
        await expect(invoke('vuln-baseline', tool)).resolves.toBeUndefined();
      }
      await expect(invoke('vuln-baseline', 'hive_repositories_status')).rejects.toThrow('vulnerability-review tool is not authorized');

      await message({ sessionID: 'dash-primary-cross', agent: dashPrimary }, { message: {}, parts: [] } as any);
      await expect(invoke('dash-primary-cross', 'task', { subagent_type: scope })).rejects.toThrow('dash-review task target is not authorized');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('keeps dash task targets and Hive lifecycle tools bounded without blocking local CLI or retrieval tools', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-dash-tool-auth-'));
    createGitRepository(repository);
    try {
      const { hooks } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string; template: string }> } = {};
      await hooks.config?.(config);
      const dashPrimary = config.command?.['dash-review']?.agent!;
      const scopeAlias = findDashScopeAlias(config.agent)!;
      const codeAlias = findDashCodeAlias(config.agent)!;
      const messageHook = hooks['chat.message']!;
      const toolHook = hooks['tool.execute.before']!;
      const invoke = (sessionID: string, tool: string, args: Record<string, unknown> = {}) => {
        return toolHook({ tool, sessionID, callID: `${sessionID}-${tool}` }, { args });
      };

      await messageHook({ sessionID: 'dash-primary', agent: dashPrimary }, { message: {}, parts: [] } as any);
      for (const tool of ['read', 'glob', 'grep', 'bash', 'mutating_mcp_tool']) {
        await expect(invoke('dash-primary', tool)).resolves.toBeUndefined();
      }
      for (const tool of ['hive_repositories_status', 'hive_plan_read', 'hive_status']) {
        await expect(invoke('dash-primary', tool)).resolves.toBeUndefined();
      }
      await expect(invoke('dash-primary', 'task', { subagent_type: scopeAlias })).resolves.toBeUndefined();
      for (const tool of ['hive_feature_create', 'hive_git_snapshot', 'hive_review_workspace_create']) {
        await expect(invoke('dash-primary', tool, { command: 'touch should-not-run' })).rejects.toThrow('dash-review tool is not authorized');
      }
      for (const tool of ['hive_review_workspace_inspect', 'hive_review_workspace_cleanup']) {
        await expect(invoke('dash-primary', tool)).resolves.toBeUndefined();
      }

      await messageHook({ sessionID: 'dash-scope', agent: scopeAlias }, { message: {}, parts: [] } as any);
      for (const tool of ['read', 'glob', 'grep', 'bash', 'mutating_mcp_tool', 'hive_repositories_status', 'hive_plan_read', 'hive_status', 'hive_git_snapshot', 'hive_review_workspace_create']) {
        await expect(invoke('dash-scope', tool)).resolves.toBeUndefined();
      }
      await expect(invoke('dash-scope', 'task', { subagent_type: scopeAlias })).rejects.toThrow('dash-review task target is not authorized');
      for (const tool of ['hive_feature_create', 'hive_review_workspace_cleanup']) {
        await expect(invoke('dash-scope', tool, { subagent_type: scopeAlias })).rejects.toThrow('dash-review tool is not authorized');
      }

      await messageHook({ sessionID: 'dash-code', agent: codeAlias }, { message: {}, parts: [] } as any);
      for (const tool of ['read', 'glob', 'grep', 'bash', 'mutating_mcp_tool', 'hive_repositories_status', 'hive_plan_read', 'hive_status']) {
        await expect(invoke('dash-code', tool)).resolves.toBeUndefined();
      }
      await expect(invoke('dash-code', 'task', { subagent_type: scopeAlias })).rejects.toThrow('dash-review task target is not authorized');
      for (const tool of ['hive_git_snapshot', 'hive_feature_create', 'hive_review_workspace_create']) {
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

  it('hive-master allows all non-dash-review Hive tools and denies dash-review-only tools', async () => {
    const agents = await buildConfig('unified');
    const hiveTools = agents['hive-master']?.tools;
    expect(hiveTools).toBeTruthy();
    expect(agents['hive-master']?.prompt).toBeUndefined();

    expect(hiveTools).toEqual({
      hive_git_snapshot: false,
      hive_review_workspace_create: false,
      hive_review_workspace_claim: false,
      hive_review_workspace_inspect: false,
      hive_review_workspace_cleanup: false,
    });
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
    expect(tools['hive_status']).toBeUndefined();
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
