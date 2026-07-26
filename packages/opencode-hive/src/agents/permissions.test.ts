import { describe, expect, it, spyOn, afterEach, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { ConfigService, ReviewWorkspaceService } from 'hive-core';
import * as path from 'path';
import plugin from '../index';
import { fingerprintReviewSourceScope } from '../utils/git-snapshot.js';
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
  const sessionCreatedAt = new Map<string, number>();
  return {
    session: {
      create: async () => ({ data: { id: 'test-session' } }),
      prompt: async () => ({ data: {} }),
      get: async ({ path: inputPath }: { path: { id: string } }) => ({
        data: {
          id: inputPath.id,
          projectID: 'snapshot',
          directory: '/test',
          parentID: 'vuln-primary',
          title: 'Test session',
          version: '1',
          time: {
            created: sessionCreatedAt.get(inputPath.id) ?? (() => {
              const created = Date.now() + 1_000;
              sessionCreatedAt.set(inputPath.id, created);
              return created;
            })(),
            updated: Date.now() + 1_000,
          },
        },
      }),
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

async function createSnapshotPlugin(directory: string, client: unknown = createStubClient()): Promise<{
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
    client,
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

function currentChangeProposal(): Record<string, unknown> {
  return {
    schema: 'hive-vuln-review-stage1/v2',
    normalizedIntent: 'review the current change',
    fixedOverrides: {},
    inferredScope: {
      mode: 'current-change',
      repositoryIds: ['root'],
      paths: [],
      hiveScope: null,
      evidence: [{ source: 'conversation', summary: 'Review the current change.' }],
    },
    merge: {
      provenance: {
        mode: 'inferred',
        repositories: 'resolved',
        paths: 'resolved',
        gitSelector: 'none',
        hiveScope: 'none',
      },
      conflicts: [],
    },
    normalizedScope: {
      mode: 'current-change',
      repositoryIds: ['root'],
      paths: [],
      comparisonBase: null,
      hiveScope: null,
    },
    expectedScopeDescriptor: {
      schema: 'hive-vuln-review-scope/v1',
      mode: 'current-change',
      repositories: ['root'],
      paths: [],
      comparisonBase: null,
      hiveScope: null,
    },
    createInput: { repositoryIds: ['root'], scopeMode: 'current-change' },
    preview: {
      sourceFingerprint: 'a'.repeat(64),
      repositories: [{ repositoryId: 'root', snapshotFingerprint: 'b'.repeat(64) }],
    },
    compare: { requested: false, status: 'not-requested', priorRootCauseKeys: [] },
    threatContext: {
      assets: ['source integrity'],
      attackerCapabilities: ['submit input'],
      entryPoints: ['reviewed change'],
      trustBoundaries: ['request boundary'],
      existingControls: ['review'],
      suspectedFailureModes: ['authorization bypass'],
    },
    selectedLenses: [],
    scopeEcho: 'Review current-change in root under all paths without prior comparison.',
  };
}

async function grantCurrentChangeMaterialization(input: {
  hooks: Awaited<ReturnType<typeof plugin>>;
  primary: string;
  scope: string;
  repositoryIds?: string[];
  idSuffix?: string;
}): Promise<{
  childContext: Record<string, unknown>;
  candidate: Record<string, unknown>;
  materializeCallID: string;
}> {
  const repositoryIds = input.repositoryIds ?? ['root'];
  const command = input.hooks['command.execute.before']!;
  const message = input.hooks['chat.message']!;
  const before = input.hooks['tool.execute.before']!;
  const after = input.hooks['tool.execute.after']!;
  const snapshot = input.hooks.tool!.hive_git_snapshot.execute as (value: unknown, context: unknown) => Promise<string>;
  const fixedOverrides = repositoryIds.length === 1 && repositoryIds[0] === 'root'
    ? {}
    : { repositoryIds };
  const commandArguments = 'repositoryIds' in fixedOverrides
    ? repositoryIds.map((repositoryId) => `--repo ${repositoryId}`).join(' ')
    : '';
  const id = (value: string): string => input.idSuffix ? `${value}-${input.idSuffix}` : value;
  await command({ command: 'vuln-review', sessionID: 'vuln-primary', arguments: commandArguments }, { parts: [] });
  await message({ sessionID: 'vuln-primary', agent: input.primary }, { message: { agent: input.primary }, parts: [] } as any);
  const resolvePacket = {
    schema: 'hive-vuln-review-stage1/v2',
    stage: 'resolve',
    attempt: 1,
    intent: '',
    conversationSummary: 'Review the current change.',
    fixedOverrides,
    clarification: null,
  };
  await before({ tool: 'task', sessionID: 'vuln-primary', callID: id('resolve-call') }, {
    args: { prompt: JSON.stringify(resolvePacket), subagent_type: input.scope, background: false },
  });
  await message({ sessionID: id('resolve-child'), agent: input.scope }, { message: { agent: input.scope }, parts: [] } as any);
  const preview = JSON.parse(await snapshot({ repositoryIds }, {
    ...snapshotContext(input.scope),
    sessionID: id('resolve-child'),
  }));
  const repositoryFingerprints = preview.composite
    ? preview.snapshots.map((entry: { repositoryId: string; snapshot: { fingerprint: string } }) => ({
        repositoryId: entry.repositoryId,
        snapshotFingerprint: entry.snapshot.fingerprint,
      }))
    : [{ repositoryId: 'root', snapshotFingerprint: preview.fingerprint }];
  const sourceFingerprint = preview.composite
    ? preview.fingerprint
    : fingerprintReviewSourceScope({
        manifestRepositoryIds: [],
        selectedRepositoryIds: [],
        snapshots: [{ repositoryId: 'root', fingerprint: preview.fingerprint }],
      });
  const candidate = {
    schema: 'hive-vuln-review-stage1/v2',
    normalizedIntent: 'review the current change',
    fixedOverrides,
    inferredScope: {
      mode: 'current-change',
      repositoryIds,
      paths: [],
      hiveScope: null,
      evidence: [{ source: 'conversation', summary: 'Review the current change.' }],
    },
    merge: {
      provenance: {
        mode: 'inferred',
        repositories: 'repositoryIds' in fixedOverrides ? 'fixed' : 'resolved',
        paths: 'resolved',
        gitSelector: 'none',
        hiveScope: 'none',
      },
      conflicts: [],
      approvedExpansions: [],
    },
    clarification: null,
    normalizedScope: {
      mode: 'current-change',
      repositoryIds,
      paths: [],
      comparisonBase: null,
      hiveScope: null,
    },
    expectedScopeDescriptor: {
      schema: 'hive-vuln-review-scope/v1',
      mode: 'current-change',
      repositories: repositoryIds,
      paths: [],
      comparisonBase: null,
      hiveScope: null,
    },
    createInput: { repositoryIds, scopeMode: 'current-change' },
    preview: {
      sourceFingerprint,
      repositories: repositoryFingerprints,
    },
    compare: { requested: false, status: 'not-requested', priorRootCauseKeys: [] },
    threatContext: {
      assets: ['source integrity'],
      attackerCapabilities: ['submit input'],
      entryPoints: ['reviewed change'],
      trustBoundaries: ['request boundary'],
      existingControls: ['review'],
      suspectedFailureModes: ['authorization bypass'],
    },
    selectedLenses: [],
    scopeEcho: `Review current-change in ${repositoryIds.join(', ')} under all paths without prior comparison.`,
  };
  await after({ tool: 'task', sessionID: 'vuln-primary', callID: id('resolve-call'), args: {} }, {
    title: 'task',
    output: JSON.stringify({ schema: 'hive-vuln-review-stage1/v2', state: 'BOUNDED', candidate }),
    metadata: {},
  });
  const materializePacket = {
    schema: 'hive-vuln-review-stage1/v2',
    stage: 'materialize',
    acceptedState: 'BOUNDED',
    scopeEcho: candidate.scopeEcho,
    candidate,
  };
  const materializeCallID = id('materialize-call');
  await before({ tool: 'task', sessionID: 'vuln-primary', callID: materializeCallID }, {
    args: { prompt: JSON.stringify(materializePacket), subagent_type: input.scope, background: false },
  });
  await message({ sessionID: id('materialize-child'), agent: input.scope }, { message: { agent: input.scope }, parts: [] } as any);
  return {
    childContext: { ...snapshotContext(input.scope), sessionID: id('materialize-child') },
    candidate,
    materializeCallID,
  };
}

async function createCurrentChangeMaterializedWorkspace(repository: string): Promise<{
  hooks: Awaited<ReturnType<typeof plugin>>;
  primary: string;
  grant: Awaited<ReturnType<typeof grantCurrentChangeMaterialization>>;
  created: Record<string, any>;
}> {
  const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
  const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
  await hooks.config?.(config);
  const primary = config.command?.['vuln-review']?.agent!;
  const grant = await grantCurrentChangeMaterialization({ hooks, primary, scope: vulnerabilityScopeAlias });
  const create = hooks.tool!.hive_review_workspace_create.execute as (value: unknown, context: unknown) => Promise<string>;
  const created = JSON.parse(await create(
    { repositoryIds: ['root'], scopeMode: 'current-change' },
    grant.childContext,
  ));
  return { hooks, primary, grant, created };
}

function readyMaterializeResult(candidate: Record<string, any>, created: Record<string, any>): Record<string, unknown> {
  return {
    schema: 'hive-vuln-review-stage1/v2',
    state: 'READY',
    scopeEcho: candidate.scopeEcho,
    runId: created.runId,
    ownershipToken: created.ownershipToken,
    workspacePath: created.workspacePath,
    repositories: created.repositories,
    scopeDescriptor: created.scopeDescriptor,
    scopeFingerprint: created.scopeFingerprint,
    sourceFingerprint: created.sourceFingerprint,
    materializedFingerprint: created.materializedFingerprint,
    repositoryFingerprints: created.repositoryFingerprints,
    excludedRepositoryIds: created.excludedRepositoryIds,
    truncated: created.truncated,
    threatContext: candidate.threatContext,
    selectedLenses: candidate.selectedLenses,
    compare: candidate.compare,
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
    writeFileSync(path.join(repository, '.gitignore'), '*.ignored\n');
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
      writeFileSync(path.join(created.workspacePath, 'new.ignored'), 'ignored workspace delta\n');
      const ignoredInspection = JSON.parse(await inspect({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext));
      expect(ignoredInspection.repositories.root.ignoredChanges).toEqual(['new.ignored']);
      expect(ignoredInspection.integrity).toMatchObject({ baselineClean: true, ignoredFiles: true });
      expect(ignoredInspection.reviewIntegrity).toBe(false);
      rmSync(path.join(created.workspacePath, 'new.ignored'));
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

  it('rejects direct vulnerability workspace creation before scope validation or service creation', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-scope-membership-'));
    createGitRepository(repository);
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const create = hooks.tool!.hive_review_workspace_create.execute as (input: unknown, context: unknown) => Promise<string>;
      const createWorkspace = spyOn(ReviewWorkspaceService.prototype, 'create');
      const context = snapshotContext(vulnerabilityScopeAlias);
      await expect(create({ scopeMode: 'unknown', paths: ['../outside'] }, context)).rejects.toThrow('no exact materialize grant');
      expect(createWorkspace).not.toHaveBeenCalled();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('denies workspace creation when materialize child lineage changes after binding', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-create-lineage-'));
    createGitRepository(repository);
    const client = createStubClient() as any;
    const getSession = client.session.get;
    let substituteParent = false;
    client.session.get = async (input: { path: { id: string } }) => {
      const response = await getSession(input);
      if (substituteParent && input.path.id === 'materialize-child') {
        response.data.parentID = 'substituted-primary';
      }
      return response;
    };
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository, client);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (input: unknown, context: unknown) => Promise<string>;
      const createWorkspace = spyOn(ReviewWorkspaceService.prototype, 'create');
      const grant = await grantCurrentChangeMaterialization({ hooks, primary, scope: vulnerabilityScopeAlias });

      substituteParent = true;
      await expect(create({ repositoryIds: ['root'], scopeMode: 'current-change' }, grant.childContext)).rejects.toThrow('no exact materialize grant');
      expect(createWorkspace).not.toHaveBeenCalled();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('consumes and revokes workspace creation authority before a failed lineage lookup can be retried', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-create-lineage-failure-'));
    createGitRepository(repository);
    const client = createStubClient() as any;
    const getSession = client.session.get;
    let failLookup = false;
    client.session.get = async (input: { path: { id: string } }) => {
      if (failLookup && input.path.id === 'materialize-child') throw new Error('injected lineage lookup failure');
      return getSession(input);
    };
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository, client);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (input: unknown, context: unknown) => Promise<string>;
      const createWorkspace = spyOn(ReviewWorkspaceService.prototype, 'create');
      const grant = await grantCurrentChangeMaterialization({ hooks, primary, scope: vulnerabilityScopeAlias });

      failLookup = true;
      await expect(create({ repositoryIds: ['root'], scopeMode: 'current-change' }, grant.childContext)).rejects.toThrow('injected lineage lookup failure');
      failLookup = false;
      await expect(create({ repositoryIds: ['root'], scopeMode: 'current-change' }, grant.childContext)).rejects.toThrow('no exact materialize grant');
      expect(createWorkspace).not.toHaveBeenCalled();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('creates only after an exact BOUNDED candidate is transferred to a fresh materialize child', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-valid-scopes-'));
    createGitRepository(repository);
    mkdirSync(path.join(repository, '.hive'), { recursive: true });
    writeFileSync(path.join(repository, '.hive', 'private-state.json'), '{}\n');
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (input: unknown, context: unknown) => Promise<string>;
      const claim = hooks.tool!.hive_review_workspace_claim.execute as (input: unknown, context: unknown) => Promise<string>;
      const cleanup = hooks.tool!.hive_review_workspace_cleanup.execute as (input: unknown, context: unknown) => Promise<string>;
      const before = hooks['tool.execute.before']!;
      const createWorkspace = spyOn(ReviewWorkspaceService.prototype, 'create');
      await expect(create({ repositoryIds: ['root'], scopeMode: 'current-change' }, snapshotContext(vulnerabilityScopeAlias))).rejects.toThrow('no exact materialize grant');
      const grant = await grantCurrentChangeMaterialization({ hooks, primary, scope: vulnerabilityScopeAlias });
      const created = JSON.parse(await create({ repositoryIds: ['root'], scopeMode: 'current-change' }, grant.childContext));
      expect(created.state).toBe('READY');
      expect(created.scopeDescriptor).toEqual(grant.candidate.expectedScopeDescriptor);
      expect(created.sourceFingerprint).toBe((grant.candidate.preview as { sourceFingerprint: string }).sourceFingerprint);
      expect(created.snapshots.map((entry: { repositoryId: string; snapshot: { fingerprint: string } }) => ({
        repositoryId: entry.repositoryId,
        snapshotFingerprint: entry.snapshot.fingerprint,
      }))).toEqual((grant.candidate.preview as { repositories: unknown }).repositories);
      expect(createWorkspace).toHaveBeenCalledTimes(1);
      await expect(cleanup({
        runId: created.runId,
        ownershipToken: created.ownershipToken,
      }, grant.childContext)).rejects.toThrow('cleanup was denied');
      await expect(claim({
        runId: created.runId,
        ownershipToken: created.ownershipToken,
      }, { ...snapshotContext(primary), sessionID: 'vuln-primary' })).rejects.toThrow('READY');
      const materializeResult = {
        schema: 'hive-vuln-review-stage1/v2',
        state: 'READY',
        scopeEcho: grant.candidate.scopeEcho,
        runId: created.runId,
        ownershipToken: created.ownershipToken,
        workspacePath: created.workspacePath,
        repositories: created.repositories,
        scopeDescriptor: created.scopeDescriptor,
        scopeFingerprint: created.scopeFingerprint,
        sourceFingerprint: created.sourceFingerprint,
        materializedFingerprint: created.materializedFingerprint,
        repositoryFingerprints: created.repositoryFingerprints,
        excludedRepositoryIds: created.excludedRepositoryIds,
        truncated: created.truncated,
        threatContext: grant.candidate.threatContext,
        selectedLenses: grant.candidate.selectedLenses,
        compare: grant.candidate.compare,
      };
      const afterOutput = { title: 'task', output: JSON.stringify(materializeResult), metadata: {} };
      await hooks['tool.execute.after']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: 'materialize-call',
        args: {},
      }, afterOutput);
      expect(JSON.parse(afterOutput.output)).toEqual(materializeResult);
      const primaryContext = { ...snapshotContext(primary), sessionID: 'vuln-primary' };
      const baseline = findVulnerabilityReviewLanes(config.agent).find(([, lane]) => lane.prompt?.includes('mandatory cross-cutting baseline'))?.[0]!;
      await claim({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext);
      await expect(before({ tool: 'task', sessionID: 'vuln-primary', callID: 'deep-after-ready' }, {
        args: { subagent_type: baseline },
      })).resolves.toBeUndefined();
      expect(JSON.parse(await cleanup({
        runId: created.runId,
        ownershipToken: created.ownershipToken,
      }, primaryContext)).cleaned).toBe(true);
      await expect(before({ tool: 'task', sessionID: 'vuln-primary', callID: 'deep-after-cleanup' }, {
        args: { subagent_type: baseline },
      })).rejects.toThrow('READY');
      await expect(claim({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext)).rejects.toThrow('READY');
      await expect(create({ repositoryIds: ['root'], scopeMode: 'current-change' }, grant.childContext)).rejects.toThrow('no exact materialize grant');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('revokes claimed READY authority before primary cleanup and keeps it revoked when cleanup fails', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-claim-cleanup-'));
    createGitRepository(repository);
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const baseline = findVulnerabilityReviewLanes(config.agent).find(([, lane]) => lane.prompt?.includes('mandatory cross-cutting baseline'))?.[0]!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (value: unknown, context: unknown) => Promise<string>;
      const claim = hooks.tool!.hive_review_workspace_claim.execute as (value: unknown, context: unknown) => Promise<string>;
      const cleanup = hooks.tool!.hive_review_workspace_cleanup.execute as (value: unknown, context: unknown) => Promise<string>;
      const before = hooks['tool.execute.before']!;
      const grant = await grantCurrentChangeMaterialization({ hooks, primary, scope: vulnerabilityScopeAlias });
      const created = JSON.parse(await create({ repositoryIds: ['root'], scopeMode: 'current-change' }, grant.childContext));
      const materializeResult = {
        schema: 'hive-vuln-review-stage1/v2',
        state: 'READY',
        scopeEcho: grant.candidate.scopeEcho,
        runId: created.runId,
        ownershipToken: created.ownershipToken,
        workspacePath: created.workspacePath,
        repositories: created.repositories,
        scopeDescriptor: created.scopeDescriptor,
        scopeFingerprint: created.scopeFingerprint,
        sourceFingerprint: created.sourceFingerprint,
        materializedFingerprint: created.materializedFingerprint,
        repositoryFingerprints: created.repositoryFingerprints,
        excludedRepositoryIds: created.excludedRepositoryIds,
        truncated: created.truncated,
        threatContext: grant.candidate.threatContext,
        selectedLenses: grant.candidate.selectedLenses,
        compare: grant.candidate.compare,
      };
      await hooks['tool.execute.after']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: 'materialize-call',
        args: {},
      }, { title: 'task', output: JSON.stringify(materializeResult), metadata: {} });
      const primaryContext = { ...snapshotContext(primary), sessionID: 'vuln-primary' };
      await claim({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext);
      await expect(before({ tool: 'task', sessionID: 'vuln-primary', callID: 'deep-before-cleanup' }, {
        args: { subagent_type: baseline },
      })).resolves.toBeUndefined();

      const cleanupService = spyOn(ReviewWorkspaceService.prototype, 'cleanup').mockRejectedValueOnce(
        new Error('injected primary cleanup failure'),
      );
      await expect(cleanup({
        runId: created.runId,
        ownershipToken: created.ownershipToken,
      }, primaryContext)).rejects.toThrow('cleanup was denied');
      expect(cleanupService).toHaveBeenCalled();
      await expect(before({ tool: 'task', sessionID: 'vuln-primary', callID: 'deep-after-cleanup-failure' }, {
        args: { subagent_type: baseline },
      })).rejects.toThrow('READY');
      await expect(claim({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext)).rejects.toThrow('READY');
      expect(existsSync(created.workspacePath)).toBe(true);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('cleans the exact creator workspace and returns STOP when materialize output drifts', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-materialize-drift-'));
    createGitRepository(repository);
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (value: unknown, context: unknown) => Promise<string>;
      const grant = await grantCurrentChangeMaterialization({ hooks, primary, scope: vulnerabilityScopeAlias });
      const created = JSON.parse(await create({ repositoryIds: ['root'], scopeMode: 'current-change' }, grant.childContext));
      const afterOutput = {
        title: 'task',
        output: JSON.stringify({
          schema: 'hive-vuln-review-stage1/v2',
          state: 'READY',
          scopeEcho: grant.candidate.scopeEcho,
          runId: created.runId,
          ownershipToken: created.ownershipToken,
          workspacePath: created.workspacePath,
          repositories: created.repositories,
          scopeDescriptor: created.scopeDescriptor,
          scopeFingerprint: created.scopeFingerprint,
          sourceFingerprint: 'f'.repeat(64),
          materializedFingerprint: created.materializedFingerprint,
          repositoryFingerprints: created.repositoryFingerprints,
          excludedRepositoryIds: created.excludedRepositoryIds,
          truncated: created.truncated,
          threatContext: grant.candidate.threatContext,
          selectedLenses: grant.candidate.selectedLenses,
          compare: grant.candidate.compare,
        }),
        metadata: {},
      };
      await hooks['tool.execute.after']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: 'materialize-call',
        args: {},
      }, afterOutput);

      expect(JSON.parse(afterOutput.output)).toMatchObject({
        state: 'STOP',
        reason: 'candidate-mismatch',
        cleanup: { attempted: true, cleaned: true },
      });
      expect(existsSync(created.workspacePath)).toBe(false);
      const claim = hooks.tool!.hive_review_workspace_claim.execute as (value: unknown, context: unknown) => Promise<string>;
      const before = hooks['tool.execute.before']!;
      await expect(claim({ runId: created.runId, ownershipToken: created.ownershipToken }, {
        ...snapshotContext(primary),
        sessionID: 'vuln-primary',
      })).rejects.toThrow('READY');
      await expect(before({ tool: 'task', sessionID: 'vuln-primary', callID: 'deep-after-stop' }, {
        args: { subagent_type: findVulnerabilityReviewLanes(config.agent).find(([, lane]) => lane.prompt?.includes('mandatory cross-cutting baseline'))?.[0] },
      })).rejects.toThrow('READY');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('rejects raw oversized materialize output before parsing and revokes workspace authority', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-materialize-raw-limit-'));
    createGitRepository(repository);
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (value: unknown, context: unknown) => Promise<string>;
      const grant = await grantCurrentChangeMaterialization({ hooks, primary, scope: vulnerabilityScopeAlias });
      const created = JSON.parse(await create({ repositoryIds: ['root'], scopeMode: 'current-change' }, grant.childContext));
      const output = {
        title: 'task',
        output: `${JSON.stringify({
          schema: 'hive-vuln-review-stage1/v2',
          state: 'READY',
          scopeEcho: grant.candidate.scopeEcho,
          runId: created.runId,
          ownershipToken: created.ownershipToken,
          workspacePath: created.workspacePath,
          repositories: created.repositories,
          scopeDescriptor: created.scopeDescriptor,
          scopeFingerprint: created.scopeFingerprint,
          sourceFingerprint: created.sourceFingerprint,
          materializedFingerprint: created.materializedFingerprint,
          repositoryFingerprints: created.repositoryFingerprints,
          excludedRepositoryIds: created.excludedRepositoryIds,
          truncated: created.truncated,
          threatContext: grant.candidate.threatContext,
          selectedLenses: grant.candidate.selectedLenses,
          compare: grant.candidate.compare,
        })}${' '.repeat((1024 * 1024) + 1)}`,
        metadata: {},
      };

      await hooks['tool.execute.after']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: 'materialize-call',
        args: {},
      }, output);

      expect(JSON.parse(output.output)).toMatchObject({
        state: 'STOP',
        reason: 'candidate-mismatch',
        cleanup: { attempted: true, cleaned: true },
      });
      expect(existsSync(created.workspacePath)).toBe(false);
      await expect(hooks.tool!.hive_review_workspace_claim.execute({
        runId: created.runId,
        ownershipToken: created.ownershipToken,
      }, { ...snapshotContext(primary), sessionID: 'vuln-primary' })).rejects.toThrow('READY');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('keeps malformed materialize output and cleanup uncertainty terminally stopped', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-materialize-malformed-'));
    createGitRepository(repository);
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const baseline = findVulnerabilityReviewLanes(config.agent).find(([, lane]) => lane.prompt?.includes('mandatory cross-cutting baseline'))?.[0]!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (value: unknown, context: unknown) => Promise<string>;
      const claim = hooks.tool!.hive_review_workspace_claim.execute as (value: unknown, context: unknown) => Promise<string>;
      const grant = await grantCurrentChangeMaterialization({ hooks, primary, scope: vulnerabilityScopeAlias });
      const created = JSON.parse(await create({ repositoryIds: ['root'], scopeMode: 'current-change' }, grant.childContext));
      spyOn(ReviewWorkspaceService.prototype, 'cleanup').mockRejectedValue(new Error('injected cleanup uncertainty'));
      const afterOutput = { title: 'task', output: '{malformed', metadata: {} };

      await hooks['tool.execute.after']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: 'materialize-call',
        args: {},
      }, afterOutput);

      expect(JSON.parse(afterOutput.output)).toMatchObject({
        state: 'STOP',
        cleanup: { attempted: true, cleaned: null },
      });
      const primaryContext = { ...snapshotContext(primary), sessionID: 'vuln-primary' };
      await expect(claim({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext)).rejects.toThrow('READY');
      await expect(hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: 'deep-after-cleanup-uncertainty',
      }, { args: { subagent_type: baseline } })).rejects.toThrow('READY');
      expect(existsSync(created.workspacePath)).toBe(true);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('cleans the exact recorded workspace for undefined and stale materialize parent output', async () => {
    for (const parentOutput of ['undefined', 'stale'] as const) {
      const repository = mkdtempSync(path.join(os.tmpdir(), `hive-vulnerability-materialize-${parentOutput}-`));
      createGitRepository(repository);
      try {
        const { hooks, created } = await createCurrentChangeMaterializedWorkspace(repository);
        if (parentOutput === 'stale') {
          await hooks.event?.({ event: { type: 'session.error', properties: { sessionID: 'vuln-primary' } } } as any);
        }
        const output = parentOutput === 'undefined'
          ? undefined
          : { title: 'task', output: 'stale parent output', metadata: {} };

        await hooks['tool.execute.after']?.({
          tool: 'task',
          sessionID: 'vuln-primary',
          callID: 'materialize-call',
          args: {},
        }, output as any);

        expect(existsSync(created.workspacePath)).toBe(false);
        if (output) {
          expect(JSON.parse(output.output)).toMatchObject({
            state: 'STOP',
            cleanup: { attempted: true, cleaned: true },
          });
        }
      } finally {
        rmSync(repository, { recursive: true, force: true });
      }
    }
  });

  it('keeps undefined and stale materialize parent output terminal when exact cleanup is uncertain', async () => {
    for (const parentOutput of ['undefined', 'stale'] as const) {
      const repository = mkdtempSync(path.join(os.tmpdir(), `hive-vulnerability-materialize-${parentOutput}-uncertain-`));
      createGitRepository(repository);
      let cleanupWorkspace: ReturnType<typeof spyOn> | undefined;
      try {
        const { hooks, primary, created } = await createCurrentChangeMaterializedWorkspace(repository);
        if (parentOutput === 'stale') {
          await hooks.event?.({ event: { type: 'session.error', properties: { sessionID: 'vuln-primary' } } } as any);
        }
        cleanupWorkspace = spyOn(ReviewWorkspaceService.prototype, 'cleanup').mockRejectedValueOnce(
          new Error('injected exact cleanup uncertainty'),
        );
        const output = parentOutput === 'undefined'
          ? undefined
          : { title: 'task', output: 'stale parent output', metadata: {} };

        await hooks['tool.execute.after']?.({
          tool: 'task',
          sessionID: 'vuln-primary',
          callID: 'materialize-call',
          args: {},
        }, output as any);

        expect(cleanupWorkspace).toHaveBeenCalledWith(
          created.runId,
          created.ownershipToken,
          expect.objectContaining({
            workflow: 'vulnerability-review',
            role: 'creator',
            sessionId: 'materialize-child',
          }),
        );
        expect(existsSync(created.workspacePath)).toBe(true);
        if (output) {
          expect(JSON.parse(output.output)).toMatchObject({
            state: 'STOP',
            cleanup: { attempted: true, cleaned: null },
          });
        }
        await expect(hooks.tool!.hive_review_workspace_claim.execute({
          runId: created.runId,
          ownershipToken: created.ownershipToken,
        }, { ...snapshotContext(primary), sessionID: 'vuln-primary' })).rejects.toThrow('READY');
      } finally {
        cleanupWorkspace?.mockRestore();
        rmSync(repository, { recursive: true, force: true });
      }
    }
  });

  it.each(['undefined', 'stale'] as const)(
    'keeps a fresh replacement generation armed after an old materialize %s callback',
    async (callbackKind) => {
      const repository = mkdtempSync(path.join(os.tmpdir(), `hive-vulnerability-materialize-generation-${callbackKind}-`));
      createGitRepository(repository);
      try {
        const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
        const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
        await hooks.config?.(config);
        const primary = config.command?.['vuln-review']?.agent!;
        const oldGrant = await grantCurrentChangeMaterialization({
          hooks,
          primary,
          scope: vulnerabilityScopeAlias,
          idSuffix: 'old',
        });
        const create = hooks.tool!.hive_review_workspace_create.execute as (value: unknown, context: unknown) => Promise<string>;
        const oldWorkspace = JSON.parse(await create(
          { repositoryIds: ['root'], scopeMode: 'current-change' },
          oldGrant.childContext,
        ));

        await hooks['command.execute.before']?.({
          command: 'vuln-review',
          sessionID: 'vuln-primary',
          arguments: '',
        }, { parts: [] });
        await hooks['chat.message']?.({ sessionID: 'vuln-primary', agent: primary }, {
          message: { agent: primary },
          parts: [],
        } as any);
        const oldOutput = callbackKind === 'undefined'
          ? undefined
          : { title: 'task', output: 'stale materialize output', metadata: {} };
        await hooks['tool.execute.after']?.({
          tool: 'task',
          sessionID: 'vuln-primary',
          callID: oldGrant.materializeCallID,
          args: {},
        }, oldOutput as any);

        expect(existsSync(oldWorkspace.workspacePath)).toBe(false);
        if (oldOutput) {
          expect(JSON.parse(oldOutput.output)).toMatchObject({
            state: 'STOP',
            cleanup: { attempted: true, cleaned: true },
          });
        }
        await expect(hooks['tool.execute.before']?.({
          tool: 'task',
          sessionID: 'vuln-primary',
          callID: `replacement-resolve-${callbackKind}`,
        }, {
          args: {
            prompt: JSON.stringify({
              schema: 'hive-vuln-review-stage1/v2',
              stage: 'resolve',
              attempt: 1,
              intent: '',
              conversationSummary: 'Review the replacement generation.',
              fixedOverrides: {},
              clarification: null,
            }),
            subagent_type: vulnerabilityScopeAlias,
            background: false,
          },
        })).resolves.toBeUndefined();
      } finally {
        rmSync(repository, { recursive: true, force: true });
      }
    },
  );

  it.each(['undefined', 'stale'] as const)(
    'keeps claimed replacement authority across uncertain cleanup and duplicate old %s callbacks',
    async (callbackKind) => {
      const repository = mkdtempSync(path.join(os.tmpdir(), `hive-vulnerability-materialize-claimed-generation-${callbackKind}-`));
      createGitRepository(repository);
      let cleanupWorkspace: ReturnType<typeof spyOn> | undefined;
      try {
        const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
        const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
        await hooks.config?.(config);
        const primary = config.command?.['vuln-review']?.agent!;
        const create = hooks.tool!.hive_review_workspace_create.execute as (value: unknown, context: unknown) => Promise<string>;
        const claim = hooks.tool!.hive_review_workspace_claim.execute as (value: unknown, context: unknown) => Promise<string>;
        const oldGrant = await grantCurrentChangeMaterialization({
          hooks,
          primary,
          scope: vulnerabilityScopeAlias,
          idSuffix: 'old-claimed',
        });
        const oldWorkspace = JSON.parse(await create(
          { repositoryIds: ['root'], scopeMode: 'current-change' },
          oldGrant.childContext,
        ));
        const currentGrant = await grantCurrentChangeMaterialization({
          hooks,
          primary,
          scope: vulnerabilityScopeAlias,
          idSuffix: 'current-claimed',
        });
        const currentWorkspace = JSON.parse(await create(
          { repositoryIds: ['root'], scopeMode: 'current-change' },
          currentGrant.childContext,
        ));
        await hooks['tool.execute.after']?.({
          tool: 'task',
          sessionID: 'vuln-primary',
          callID: currentGrant.materializeCallID,
          args: {},
        }, {
          title: 'task',
          output: JSON.stringify(readyMaterializeResult(currentGrant.candidate, currentWorkspace)),
          metadata: {},
        });
        const primaryContext = { ...snapshotContext(primary), sessionID: 'vuln-primary' };
        await claim({ runId: currentWorkspace.runId, ownershipToken: currentWorkspace.ownershipToken }, primaryContext);

        cleanupWorkspace = spyOn(ReviewWorkspaceService.prototype, 'cleanup').mockRejectedValueOnce(
          new Error('injected old cleanup uncertainty'),
        );
        const oldCallback = {
          tool: 'task',
          sessionID: 'vuln-primary',
          callID: oldGrant.materializeCallID,
          args: {},
        };
        const oldOutput = callbackKind === 'undefined'
          ? undefined
          : { title: 'task', output: 'stale materialize output', metadata: {} };
        await hooks['tool.execute.after']?.(oldCallback, oldOutput as any);
        await hooks['tool.execute.after']?.(oldCallback, oldOutput as any);

        expect(cleanupWorkspace).toHaveBeenCalledTimes(1);
        expect(cleanupWorkspace).toHaveBeenCalledWith(
          oldWorkspace.runId,
          oldWorkspace.ownershipToken,
          expect.objectContaining({ sessionId: 'materialize-child-old-claimed' }),
        );
        expect(existsSync(oldWorkspace.workspacePath)).toBe(true);
        expect(existsSync(currentWorkspace.workspacePath)).toBe(true);
        const baseline = findVulnerabilityReviewLanes(config.agent)
          .find(([, lane]) => lane.prompt?.includes('mandatory cross-cutting baseline'))?.[0]!;
        await expect(hooks['tool.execute.before']?.({
          tool: 'task',
          sessionID: 'vuln-primary',
          callID: 'deep-after-old-duplicate',
        }, { args: { subagent_type: baseline } })).resolves.toBeUndefined();
      } finally {
        cleanupWorkspace?.mockRestore();
        rmSync(repository, { recursive: true, force: true });
      }
    },
  );

  it('does not let materialize lineage completion mutate an N+1 generation', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-materialize-lineage-generation-'));
    createGitRepository(repository);
    let releaseRead!: () => void;
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted!: () => void;
    const readEntered = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let readWorkspace: ReturnType<typeof spyOn> | undefined;
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (value: unknown, context: unknown) => Promise<string>;
      const grant = await grantCurrentChangeMaterialization({
        hooks,
        primary,
        scope: vulnerabilityScopeAlias,
        idSuffix: 'lineage-old',
      });
      const workspace = JSON.parse(await create(
        { repositoryIds: ['root'], scopeMode: 'current-change' },
        grant.childContext,
      ));
      const originalRead = ReviewWorkspaceService.prototype.read;
      readWorkspace = spyOn(ReviewWorkspaceService.prototype, 'read').mockImplementation(async function (...args) {
        readStarted();
        await readBlocked;
        return originalRead.apply(this, args as Parameters<typeof originalRead>);
      });
      const output = {
        title: 'task',
        output: JSON.stringify(readyMaterializeResult(grant.candidate, workspace)),
        metadata: {},
      };
      const delayedCallback = hooks['tool.execute.after']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: grant.materializeCallID,
        args: {},
      }, output);
      await readEntered;

      await hooks['command.execute.before']?.({
        command: 'vuln-review',
        sessionID: 'vuln-primary',
        arguments: '',
      }, { parts: [] });
      await hooks['chat.message']?.({ sessionID: 'vuln-primary', agent: primary }, {
        message: { agent: primary },
        parts: [],
      } as any);
      releaseRead();
      await delayedCallback;

      expect(JSON.parse(output.output)).toMatchObject({
        state: 'STOP',
        cleanup: { attempted: true, cleaned: true },
      });
      await expect(hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: 'lineage-new-resolve',
      }, {
        args: {
          prompt: JSON.stringify({
            schema: 'hive-vuln-review-stage1/v2',
            stage: 'resolve',
            attempt: 1,
            intent: '',
            conversationSummary: 'Review the replacement generation.',
            fixedOverrides: {},
            clarification: null,
          }),
          subagent_type: vulnerabilityScopeAlias,
          background: false,
        },
      })).resolves.toBeUndefined();
    } finally {
      releaseRead();
      readWorkspace?.mockRestore();
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('keeps the Stage 1 gate when an old materialize call is replaced within one generation', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-materialize-call-replacement-'));
    createGitRepository(repository);
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const grant = await grantCurrentChangeMaterialization({
        hooks,
        primary,
        scope: vulnerabilityScopeAlias,
        idSuffix: 'first',
      });
      const packet = {
        schema: 'hive-vuln-review-stage1/v2',
        stage: 'materialize',
        acceptedState: 'BOUNDED',
        scopeEcho: grant.candidate.scopeEcho,
        candidate: grant.candidate,
      };
      await hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: 'materialize-replacement',
      }, { args: { prompt: JSON.stringify(packet), subagent_type: vulnerabilityScopeAlias, background: false } });

      await hooks['tool.execute.after']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: grant.materializeCallID,
        args: {},
      }, undefined);

      await expect(hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: 'materialize-current',
      }, { args: { prompt: JSON.stringify(packet), subagent_type: vulnerabilityScopeAlias, background: false } })).resolves.toBeUndefined();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it.each(
    (['before-current', 'after-current'] as const).flatMap((callbackOrder) =>
      (['undefined', 'stale'] as const).flatMap((parentOutput) =>
        (['fresh', 'READY', 'claimed'] as const).map((currentState) =>
          [callbackOrder, parentOutput, currentState] as const))),
  )(
    'rejects same-ID materialize reuse with an old %s %s callback against %s N+1',
    async (callbackOrder, parentOutput, currentState) => {
      const suffix = `${callbackOrder}-${parentOutput}-${currentState}`;
      const repository = mkdtempSync(path.join(os.tmpdir(), `hive-vulnerability-materialize-call-collision-${suffix}-`));
      createGitRepository(repository);
      let cleanupWorkspace: ReturnType<typeof spyOn> | undefined;
      try {
        const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
        const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
        await hooks.config?.(config);
        const primary = config.command?.['vuln-review']?.agent!;
        const baseline = findVulnerabilityReviewLanes(config.agent)
          .find(([, lane]) => lane.prompt?.includes('mandatory cross-cutting baseline'))?.[0]!;
        const command = hooks['command.execute.before']!;
        const message = hooks['chat.message']!;
        const before = hooks['tool.execute.before']!;
        const after = hooks['tool.execute.after']!;
        const create = hooks.tool!.hive_review_workspace_create.execute as (value: unknown, context: unknown) => Promise<string>;
        const claim = hooks.tool!.hive_review_workspace_claim.execute as (value: unknown, context: unknown) => Promise<string>;
        const oldGrant = await grantCurrentChangeMaterialization({
          hooks,
          primary,
          scope: vulnerabilityScopeAlias,
          idSuffix: `collision-old-${suffix}`,
        });
        const oldWorkspace = JSON.parse(await create(
          { repositoryIds: ['root'], scopeMode: 'current-change' },
          oldGrant.childContext,
        ));
        const oldCallback = {
          tool: 'task',
          sessionID: 'vuln-primary',
          callID: oldGrant.materializeCallID,
          args: {},
        };
        const oldOutput = parentOutput === 'undefined'
          ? undefined
          : { title: 'task', output: 'stale materialize output', metadata: {} };
        const cleanupUncertain = currentState === 'claimed';
        if (cleanupUncertain) {
          cleanupWorkspace = spyOn(ReviewWorkspaceService.prototype, 'cleanup').mockRejectedValueOnce(
            new Error('injected same-ID cleanup uncertainty'),
          );
        }
        if (callbackOrder === 'before-current') {
          await after(oldCallback, oldOutput as any);
        }

        if (currentState === 'fresh') {
          await command({ command: 'vuln-review', sessionID: 'vuln-primary', arguments: '' }, { parts: [] });
          await message({ sessionID: 'vuln-primary', agent: primary }, {
            message: { agent: primary },
            parts: [],
          } as any);
          await expect(before({
            tool: 'task',
            sessionID: 'vuln-primary',
            callID: oldGrant.materializeCallID,
          }, {
            args: {
              prompt: JSON.stringify({
                schema: 'hive-vuln-review-stage1/v2',
                stage: 'materialize',
                acceptedState: 'BOUNDED',
                scopeEcho: oldGrant.candidate.scopeEcho,
                candidate: oldGrant.candidate,
              }),
              subagent_type: vulnerabilityScopeAlias,
              background: false,
            },
          })).rejects.toThrow('reused session/tool callID');

          const resolveCallID = `collision-current-resolve-${suffix}`;
          await before({ tool: 'task', sessionID: 'vuln-primary', callID: resolveCallID }, {
            args: {
              prompt: JSON.stringify({
                schema: 'hive-vuln-review-stage1/v2',
                stage: 'resolve',
                attempt: 1,
                intent: '',
                conversationSummary: 'Review the replacement generation.',
                fixedOverrides: {},
                clarification: null,
              }),
              subagent_type: vulnerabilityScopeAlias,
              background: false,
            },
          });
          if (callbackOrder === 'after-current') {
            await after(oldCallback, oldOutput as any);
          }
          await after(oldCallback, oldOutput as any);
          const currentProposal = currentChangeProposal();
          const currentCandidate = {
            ...currentProposal,
            merge: {
              ...(currentProposal.merge as Record<string, unknown>),
              approvedExpansions: [],
            },
            clarification: null,
          };
          await after({ tool: 'task', sessionID: 'vuln-primary', callID: resolveCallID, args: {} }, {
            title: 'task',
            output: JSON.stringify({
              schema: 'hive-vuln-review-stage1/v2',
              state: 'BOUNDED',
              candidate: currentCandidate,
            }),
            metadata: {},
          });
          await expect(before({
            tool: 'task',
            sessionID: 'vuln-primary',
            callID: `collision-current-materialize-${suffix}`,
          }, {
            args: {
              prompt: JSON.stringify({
                schema: 'hive-vuln-review-stage1/v2',
                stage: 'materialize',
                acceptedState: 'BOUNDED',
                scopeEcho: currentCandidate.scopeEcho,
                candidate: currentCandidate,
              }),
              subagent_type: vulnerabilityScopeAlias,
              background: false,
            },
          })).resolves.toBeUndefined();
        } else {
          const currentGrant = await grantCurrentChangeMaterialization({
            hooks,
            primary,
            scope: vulnerabilityScopeAlias,
            idSuffix: `collision-current-${suffix}`,
          });
          const currentWorkspace = JSON.parse(await create(
            { repositoryIds: ['root'], scopeMode: 'current-change' },
            currentGrant.childContext,
          ));
          await after({
            tool: 'task',
            sessionID: 'vuln-primary',
            callID: currentGrant.materializeCallID,
            args: {},
          }, {
            title: 'task',
            output: JSON.stringify(readyMaterializeResult(currentGrant.candidate, currentWorkspace)),
            metadata: {},
          });
          if (currentState === 'claimed') {
            await claim({
              runId: currentWorkspace.runId,
              ownershipToken: currentWorkspace.ownershipToken,
            }, { ...snapshotContext(primary), sessionID: 'vuln-primary' });
          }
          await expect(before({
            tool: 'task',
            sessionID: 'vuln-primary',
            callID: oldGrant.materializeCallID,
          }, { args: { subagent_type: baseline } })).rejects.toThrow('reused session/tool callID');
          if (callbackOrder === 'after-current') {
            await after(oldCallback, oldOutput as any);
          }
          await after(oldCallback, oldOutput as any);
          expect(existsSync(currentWorkspace.workspacePath)).toBe(true);
          if (currentState === 'READY') {
            await expect(claim({
              runId: currentWorkspace.runId,
              ownershipToken: currentWorkspace.ownershipToken,
            }, { ...snapshotContext(primary), sessionID: 'vuln-primary' })).resolves.toBeDefined();
          } else {
            await expect(before({
              tool: 'task',
              sessionID: 'vuln-primary',
              callID: `deep-after-collision-${suffix}`,
            }, { args: { subagent_type: baseline } })).resolves.toBeUndefined();
          }
        }

        if (cleanupUncertain) {
          expect(cleanupWorkspace).toHaveBeenCalledTimes(1);
          expect(cleanupWorkspace).toHaveBeenCalledWith(
            oldWorkspace.runId,
            oldWorkspace.ownershipToken,
            expect.objectContaining({ sessionId: `materialize-child-collision-old-${suffix}` }),
          );
          expect(existsSync(oldWorkspace.workspacePath)).toBe(true);
        } else {
          expect(existsSync(oldWorkspace.workspacePath)).toBe(false);
        }
      } finally {
        cleanupWorkspace?.mockRestore();
        rmSync(repository, { recursive: true, force: true });
      }
    },
  );

  it('cannot authorize cached READY output after the materialize child deletes its workspace', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-materialize-deleted-'));
    createGitRepository(repository);
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const baseline = findVulnerabilityReviewLanes(config.agent).find(([, lane]) => lane.prompt?.includes('mandatory cross-cutting baseline'))?.[0]!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (value: unknown, context: unknown) => Promise<string>;
      const claim = hooks.tool!.hive_review_workspace_claim.execute as (value: unknown, context: unknown) => Promise<string>;
      const grant = await grantCurrentChangeMaterialization({ hooks, primary, scope: vulnerabilityScopeAlias });
      const created = JSON.parse(await create({ repositoryIds: ['root'], scopeMode: 'current-change' }, grant.childContext));
      const cleanupService = new ReviewWorkspaceService({ projectRoot: repository });
      await cleanupService.cleanup(created.runId, created.ownershipToken, {
        workflow: 'vulnerability-review',
        role: 'creator',
        agent: vulnerabilityScopeAlias,
        sessionId: 'materialize-child',
        pid: process.pid,
      });
      expect(existsSync(created.workspacePath)).toBe(false);
      const afterOutput = {
        title: 'task',
        output: JSON.stringify({
          schema: 'hive-vuln-review-stage1/v2',
          state: 'READY',
          scopeEcho: grant.candidate.scopeEcho,
          runId: created.runId,
          ownershipToken: created.ownershipToken,
          workspacePath: created.workspacePath,
          repositories: created.repositories,
          scopeDescriptor: created.scopeDescriptor,
          scopeFingerprint: created.scopeFingerprint,
          sourceFingerprint: created.sourceFingerprint,
          materializedFingerprint: created.materializedFingerprint,
          repositoryFingerprints: created.repositoryFingerprints,
          excludedRepositoryIds: created.excludedRepositoryIds,
          truncated: created.truncated,
          threatContext: grant.candidate.threatContext,
          selectedLenses: grant.candidate.selectedLenses,
          compare: grant.candidate.compare,
        }),
        metadata: {},
      };
      await hooks['tool.execute.after']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: 'materialize-call',
        args: {},
      }, afterOutput);

      expect(JSON.parse(afterOutput.output).state).toBe('STOP');
      const primaryContext = { ...snapshotContext(primary), sessionID: 'vuln-primary' };
      await expect(claim({ runId: created.runId, ownershipToken: created.ownershipToken }, primaryContext)).rejects.toThrow('READY');
      await expect(hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: 'deep-after-child-delete',
      }, { args: { subagent_type: baseline } })).rejects.toThrow('READY');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('preserves composite preview and create aggregate and ordered repository fingerprints', async () => {
    const composite = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-composite-parity-'));
    const api = path.join(composite, 'repos', 'api');
    const web = path.join(composite, 'repos', 'web');
    createGitRepository(api);
    createGitRepository(web);
    writeCompositeWorkspaceManifest(composite, ['api', 'web']);
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(composite);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const create = hooks.tool!.hive_review_workspace_create.execute as (value: unknown, context: unknown) => Promise<string>;
      const grant = await grantCurrentChangeMaterialization({
        hooks,
        primary,
        scope: vulnerabilityScopeAlias,
        repositoryIds: ['api', 'web'],
      });
      const created = JSON.parse(await create({
        repositoryIds: ['api', 'web'],
        scopeMode: 'current-change',
      }, grant.childContext));

      expect(created.sourceFingerprint).toBe((grant.candidate.preview as { sourceFingerprint: string }).sourceFingerprint);
      expect(created.snapshots.map((entry: { repositoryId: string; snapshot: { fingerprint: string } }) => ({
        repositoryId: entry.repositoryId,
        snapshotFingerprint: entry.snapshot.fingerprint,
      }))).toEqual((grant.candidate.preview as { repositories: unknown }).repositories);
    } finally {
      rmSync(composite, { recursive: true, force: true });
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
      }, snapshotContext(vulnerabilityScopeAlias))).rejects.toThrow('no exact materialize grant');
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
      await hooks.event?.({
        event: { type: 'session.deleted', properties: { info: { id: 'dash-primary-cleanup' } } },
      } as any);

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

      await expect(hooks.event?.({
        event: { type: 'session.deleted', properties: { info: { id: 'dash-primary-errors' } } },
      } as any)).resolves.toBeUndefined();

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
      await hooks.event?.({
        event: { type: 'session.deleted', properties: { info: { id: 'dash-primary-first' } } },
      } as any);
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
      const grant = await grantCurrentChangeMaterialization({
        hooks: firstPlugin.hooks,
        primary: vulnerabilityPrimary,
        scope: firstPlugin.vulnerabilityScopeAlias,
      });
      const created = JSON.parse(await create({ repositoryIds: ['root'], scopeMode: 'current-change' }, grant.childContext));
      expect(created.scopeDescriptor).toEqual({
        schema: 'hive-vuln-review-scope/v1',
        mode: 'current-change',
        repositories: ['root'],
        paths: [],
        comparisonBase: null,
        hiveScope: null,
      });
      expect(new Set([
        created.scopeFingerprint,
        created.sourceFingerprint,
        created.materializedFingerprint,
      ]).size).toBe(3);
      const ownerContext = { ...snapshotContext(vulnerabilityPrimary), sessionID: 'vuln-primary' };
      await firstPlugin.hooks['chat.message']?.({ sessionID: 'vuln-primary', agent: vulnerabilityPrimary }, { message: {}, parts: [] } as any);
      await firstPlugin.hooks['tool.execute.after']?.({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: 'materialize-call',
        args: {},
      }, {
        title: 'task',
        output: JSON.stringify({
          schema: 'hive-vuln-review-stage1/v2',
          state: 'READY',
          scopeEcho: grant.candidate.scopeEcho,
          runId: created.runId,
          ownershipToken: created.ownershipToken,
          workspacePath: created.workspacePath,
          repositories: created.repositories,
          scopeDescriptor: created.scopeDescriptor,
          scopeFingerprint: created.scopeFingerprint,
          sourceFingerprint: created.sourceFingerprint,
          materializedFingerprint: created.materializedFingerprint,
          repositoryFingerprints: created.repositoryFingerprints,
          excludedRepositoryIds: created.excludedRepositoryIds,
          truncated: created.truncated,
          threatContext: grant.candidate.threatContext,
          selectedLenses: grant.candidate.selectedLenses,
          compare: grant.candidate.compare,
        }),
        metadata: {},
      });
      await claim({
        runId: created.runId,
        ownershipToken: created.ownershipToken,
      }, ownerContext);

      const secondPlugin = await createSnapshotPlugin(repository);
      const secondConfig: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await secondPlugin.hooks.config?.(secondConfig);
      const inspect = secondPlugin.hooks.tool!.hive_review_workspace_inspect.execute as (input: unknown, context: unknown) => Promise<string>;
      const cleanup = secondPlugin.hooks.tool!.hive_review_workspace_cleanup.execute as (input: unknown, context: unknown) => Promise<string>;
      await secondPlugin.hooks['chat.message']?.({ sessionID: 'vuln-primary', agent: vulnerabilityPrimary }, { message: {}, parts: [] } as any);
      const reconstructed = JSON.parse(await inspect({
        runId: created.runId,
        ownershipToken: created.ownershipToken,
      }, ownerContext));
      expect(reconstructed).toMatchObject({ reviewIntegrity: true, source: { stable: true }, materialized: { matches: true } });
      expect(reconstructed.scopeDescriptor).toEqual(created.scopeDescriptor);
      expect(reconstructed.scopeFingerprint).toBe(created.scopeFingerprint);
      expect(reconstructed.sourceFingerprint).toBe(created.sourceFingerprint);
      expect(reconstructed.materializedFingerprint).toBe(created.materializedFingerprint);
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
        event: { type: 'session.deleted', properties: { info: { id: 'untracked-dash-session' } } },
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

      await (hooks as any)['command.execute.before']({
        command: 'vuln-review',
        sessionID: 'vuln-primary',
        arguments: '',
      }, { parts: [] });
      await message({ sessionID: 'vuln-primary', agent: primary }, { message: { agent: primary }, parts: [] } as any);
      await expect(invoke('vuln-primary', 'task', { subagent_type: scope })).rejects.toThrow('Stage 1');
      await expect(invoke('vuln-primary', 'task', { subagent_type: dashScope })).rejects.toThrow('Stage 1');
      await expect(invoke('vuln-primary', 'bash')).rejects.toThrow('vulnerability-review tool is not authorized');

      await message({ sessionID: 'vuln-scope', agent: scope }, { message: { agent: scope }, parts: [] } as any);
      for (const tool of ['hive_repositories_status', 'hive_status', 'hive_plan_read', 'hive_git_snapshot', 'hive_vulnerability_compare_report_read', 'hive_review_workspace_create', 'hive_review_workspace_cleanup', ...expectedVulnerabilityReviewMcpTools]) {
        await expect(invoke('vuln-scope', tool)).resolves.toBeUndefined();
      }
      for (const tool of ['read', 'glob', 'grep', 'task', 'bash', 'write', 'edit', 'webfetch', 'skill', 'todowrite', 'context-mode_ctx_execute', 'gpt_imagegen', 'unknown_user_mcp', 'hive_feature_create']) {
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

  it('exposes a zero-argument comparison reader only to the bound resolve child and consumes it once', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-compare-reader-'));
    createGitRepository(repository);
    mkdirSync(path.join(repository, 'reports'));
    writeFileSync(path.join(repository, 'reports', 'prior.md'), '# Prior report\n');
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const command = hooks['command.execute.before']!;
      const message = hooks['chat.message']!;
      const before = hooks['tool.execute.before']!;
      const readCompare = hooks.tool!.hive_vulnerability_compare_report_read.execute as (value: unknown, context: unknown) => Promise<string>;
      await command({
        command: 'vuln-review',
        sessionID: 'vuln-primary',
        arguments: '--compare reports/prior.md',
      }, { parts: [] });
      await message({ sessionID: 'vuln-primary', agent: primary }, { message: { agent: primary }, parts: [] } as any);
      await before({ tool: 'task', sessionID: 'vuln-primary', callID: 'compare-resolve' }, {
        args: {
          prompt: JSON.stringify({
            schema: 'hive-vuln-review-stage1/v2',
            stage: 'resolve',
            attempt: 1,
            intent: '',
            conversationSummary: 'Compare the current change.',
            fixedOverrides: { comparePath: 'reports/prior.md' },
            clarification: null,
          }),
          subagent_type: vulnerabilityScopeAlias,
          background: false,
        },
      });
      await message({ sessionID: 'compare-child', agent: vulnerabilityScopeAlias }, {
        message: { agent: vulnerabilityScopeAlias },
        parts: [],
      } as any);
      const context = { ...snapshotContext(vulnerabilityScopeAlias), sessionID: 'compare-child' };

      expect(JSON.parse(await readCompare({}, context))).toEqual({
        path: 'reports/prior.md',
        content: '# Prior report\n',
      });
      await expect(readCompare({}, context)).rejects.toThrow('no invocation-bound report');
      await expect(readCompare({ path: 'reports/prior.md' }, context)).rejects.toThrow('accepts no arguments');
      await expect(readCompare({}, { ...context, agent: primary })).rejects.toThrow('not authorized');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('revokes the comparison capability when refreshed child lineage differs from the bound session', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-compare-lineage-'));
    createGitRepository(repository);
    mkdirSync(path.join(repository, 'reports'));
    writeFileSync(path.join(repository, 'reports', 'prior.md'), '# Prior report\n');
    const client = createStubClient() as any;
    const getSession = client.session.get;
    let substituteParent = false;
    client.session.get = async (input: { path: { id: string } }) => {
      const response = await getSession(input);
      if (substituteParent && input.path.id === 'compare-child') {
        response.data.parentID = 'substituted-primary';
      }
      return response;
    };
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository, client);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      await hooks['command.execute.before']?.({
        command: 'vuln-review',
        sessionID: 'vuln-primary',
        arguments: '--compare reports/prior.md',
      }, { parts: [] });
      await hooks['chat.message']?.({ sessionID: 'vuln-primary', agent: primary }, { message: { agent: primary }, parts: [] } as any);
      await hooks['tool.execute.before']?.({ tool: 'task', sessionID: 'vuln-primary', callID: 'compare-lineage' }, {
        args: {
          prompt: JSON.stringify({
            schema: 'hive-vuln-review-stage1/v2',
            stage: 'resolve',
            attempt: 1,
            intent: '',
            conversationSummary: 'Compare the current change.',
            fixedOverrides: { comparePath: 'reports/prior.md' },
            clarification: null,
          }),
          subagent_type: vulnerabilityScopeAlias,
          background: false,
        },
      });
      await hooks['chat.message']?.({ sessionID: 'compare-child', agent: vulnerabilityScopeAlias }, {
        message: { agent: vulnerabilityScopeAlias },
        parts: [],
      } as any);
      const reader = hooks.tool!.hive_vulnerability_compare_report_read.execute as (value: unknown, context: unknown) => Promise<string>;
      const context = { ...snapshotContext(vulnerabilityScopeAlias), sessionID: 'compare-child' };

      substituteParent = true;
      await expect(reader({}, context)).rejects.toThrow('no invocation-bound report');
      substituteParent = false;
      await expect(reader({}, context)).rejects.toThrow('no invocation-bound report');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('consumes and revokes comparison authority before a failed lineage lookup can be retried', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-compare-lineage-failure-'));
    createGitRepository(repository);
    mkdirSync(path.join(repository, 'reports'));
    writeFileSync(path.join(repository, 'reports', 'prior.md'), '# Prior report\n');
    const client = createStubClient() as any;
    const getSession = client.session.get;
    let failLookup = false;
    client.session.get = async (input: { path: { id: string } }) => {
      if (failLookup && input.path.id === 'compare-child') throw new Error('injected lineage lookup failure');
      return getSession(input);
    };
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository, client);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      await hooks['command.execute.before']?.({
        command: 'vuln-review',
        sessionID: 'vuln-primary',
        arguments: '--compare reports/prior.md',
      }, { parts: [] });
      await hooks['chat.message']?.({ sessionID: 'vuln-primary', agent: primary }, { message: { agent: primary }, parts: [] } as any);
      await hooks['tool.execute.before']?.({ tool: 'task', sessionID: 'vuln-primary', callID: 'compare-lineage-failure' }, {
        args: {
          prompt: JSON.stringify({
            schema: 'hive-vuln-review-stage1/v2',
            stage: 'resolve',
            attempt: 1,
            intent: '',
            conversationSummary: 'Compare the current change.',
            fixedOverrides: { comparePath: 'reports/prior.md' },
            clarification: null,
          }),
          subagent_type: vulnerabilityScopeAlias,
          background: false,
        },
      });
      await hooks['chat.message']?.({ sessionID: 'compare-child', agent: vulnerabilityScopeAlias }, {
        message: { agent: vulnerabilityScopeAlias },
        parts: [],
      } as any);
      const reader = hooks.tool!.hive_vulnerability_compare_report_read.execute as (value: unknown, context: unknown) => Promise<string>;
      const context = { ...snapshotContext(vulnerabilityScopeAlias), sessionID: 'compare-child' };

      failLookup = true;
      await expect(reader({}, context)).rejects.toThrow('injected lineage lookup failure');
      failLookup = false;
      await expect(reader({}, context)).rejects.toThrow('no invocation-bound report');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('makes initial child lookup, missing data, and commit failure terminal for same-child retries', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-initial-binding-failure-'));
    createGitRepository(repository);
    mkdirSync(path.join(repository, 'reports'));
    writeFileSync(path.join(repository, 'reports', 'prior.md'), '# Prior report\n');
    const client = createStubClient() as any;
    const getSession = client.session.get;
    let bindingFailure: 'lookup' | 'missing' | 'commit' | undefined;
    client.session.get = async (input: { path: { id: string } }) => {
      if (bindingFailure === 'lookup') throw new Error('injected initial binding lookup failure');
      if (bindingFailure === 'missing') return { data: undefined };
      const response = await getSession(input);
      if (bindingFailure === 'commit') response.data.parentID = 'substituted-primary';
      return response;
    };
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository, client);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const command = hooks['command.execute.before']!;
      const message = hooks['chat.message']!;
      const before = hooks['tool.execute.before']!;
      const reader = hooks.tool!.hive_vulnerability_compare_report_read.execute as (value: unknown, context: unknown) => Promise<string>;

      for (const failure of ['lookup', 'missing', 'commit'] as const) {
        const child = `${failure}-same-child`;
        await command({
          command: 'vuln-review',
          sessionID: 'vuln-primary',
          arguments: '--compare reports/prior.md',
        }, { parts: [] });
        await message({ sessionID: 'vuln-primary', agent: primary }, { message: { agent: primary }, parts: [] } as any);
        await before({ tool: 'task', sessionID: 'vuln-primary', callID: `${failure}-binding` }, {
          args: {
            prompt: JSON.stringify({
              schema: 'hive-vuln-review-stage1/v2',
              stage: 'resolve',
              attempt: 1,
              intent: '',
              conversationSummary: 'Compare the current change.',
              fixedOverrides: { comparePath: 'reports/prior.md' },
              clarification: null,
            }),
            subagent_type: vulnerabilityScopeAlias,
            background: false,
          },
        });

        bindingFailure = failure;
        await message({ sessionID: child, agent: vulnerabilityScopeAlias }, {
          message: { agent: vulnerabilityScopeAlias },
          parts: [],
        } as any);
        bindingFailure = undefined;
        await message({ sessionID: child, agent: vulnerabilityScopeAlias }, {
          message: { agent: vulnerabilityScopeAlias },
          parts: [],
        } as any);

        await expect(reader({}, {
          ...snapshotContext(vulnerabilityScopeAlias),
          sessionID: child,
        })).rejects.toThrow('no invocation-bound report');
      }
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('revokes Stage 1 authority in pinned pre-execution and executor failure order', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-failure-order-'));
    createGitRepository(repository);
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const baseline = findVulnerabilityReviewLanes(config.agent).find(([, lane]) => lane.prompt?.includes('mandatory cross-cutting baseline'))?.[0]!;
      const command = hooks['command.execute.before']!;
      const message = hooks['chat.message']!;
      const before = hooks['tool.execute.before']!;
      const after = hooks['tool.execute.after']! as unknown as (input: unknown, output: unknown) => Promise<void>;
      const create = hooks.tool!.hive_review_workspace_create.execute as (value: unknown, context: unknown) => Promise<string>;
      const createWorkspace = spyOn(ReviewWorkspaceService.prototype, 'create');
      const resolveArgs = {
        prompt: JSON.stringify({
          schema: 'hive-vuln-review-stage1/v2',
          stage: 'resolve',
          attempt: 1,
          intent: '',
          conversationSummary: 'Review the current change.',
          fixedOverrides: {},
          clarification: null,
        }),
        subagent_type: vulnerabilityScopeAlias,
        background: false,
      };
      const arm = async (callID: string): Promise<void> => {
        await command({ command: 'vuln-review', sessionID: 'vuln-primary', arguments: '' }, { parts: [] });
        await message({ sessionID: 'vuln-primary', agent: primary }, { message: { agent: primary }, parts: [] } as any);
        await before({ tool: 'task', sessionID: 'vuln-primary', callID }, { args: resolveArgs });
      };

      let afterCalls = 0;
      const tracedAfter = async (input: unknown, output: unknown): Promise<void> => {
        afterCalls += 1;
        await after(input, output);
      };
      const preExecutionTrace: string[] = [];
      try {
        await arm('pre-execution');
        preExecutionTrace.push('before-hook');
        await hooks.event?.({ event: { type: 'session.error', properties: { sessionID: 'vuln-primary' } } } as any);
        preExecutionTrace.push('session.error');
        throw new Error('pinned pre-execution failure');
      } catch {
        preExecutionTrace.push('throw');
      }
      expect(preExecutionTrace).toEqual(['before-hook', 'session.error', 'throw']);
      expect(afterCalls).toBe(0);
      await expect(create({ repositoryIds: ['root'], scopeMode: 'current-change' }, {
        ...snapshotContext(vulnerabilityScopeAlias),
        sessionID: 'pre-execution-child',
      })).rejects.toThrow('no exact materialize grant');
      await expect(before({ tool: 'task', sessionID: 'vuln-primary', callID: 'deep-after-pre-execution' }, {
        args: { subagent_type: baseline },
      })).rejects.toThrow('READY');
      await expect(hooks.tool!.hive_review_workspace_claim.execute({
        runId: 'missing-run',
        ownershipToken: 'missing-token',
      }, {
        ...snapshotContext(primary),
        sessionID: 'vuln-primary',
      })).rejects.toThrow('READY');
      await expect(before({
        tool: 'task',
        sessionID: 'vuln-primary',
        callID: 'scope-after-pre-execution',
      }, {
        args: {
          prompt: JSON.stringify({
            schema: 'hive-vuln-review-stage1/v2',
            stage: 'resolve',
            attempt: 1,
            intent: '',
            conversationSummary: 'Review the current change.',
            fixedOverrides: {},
            clarification: null,
          }),
          subagent_type: vulnerabilityScopeAlias,
          background: false,
        },
      })).rejects.toThrow('active Stage 1 reservation');

      const executorTrace: string[] = [];
      await arm('executor-failure');
      executorTrace.push('before-hook');
      let executorOutput: undefined;
      try {
        throw new Error('pinned executor failure');
      } catch {
        executorOutput = undefined;
        executorTrace.push('caught-undefined-result');
      }
      await tracedAfter({ tool: 'task', sessionID: 'vuln-primary', callID: 'executor-failure', args: resolveArgs }, executorOutput);
      executorTrace.push('after-hook(undefined)-revocation');
      executorTrace.push('task-error-state');
      expect(executorTrace).toEqual([
        'before-hook',
        'caught-undefined-result',
        'after-hook(undefined)-revocation',
        'task-error-state',
      ]);
      expect(afterCalls).toBe(1);
      await expect(create({ repositoryIds: ['root'], scopeMode: 'current-change' }, {
        ...snapshotContext(vulnerabilityScopeAlias),
        sessionID: 'failed-child',
      })).rejects.toThrow('no exact materialize grant');
      await expect(before({ tool: 'task', sessionID: 'vuln-primary', callID: 'deep-after-executor-failure' }, {
        args: { subagent_type: baseline },
      })).rejects.toThrow('READY');
      expect(createWorkspace).not.toHaveBeenCalled();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('cannot commit a delayed child binding across command generation replacement', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-binding-race-'));
    createGitRepository(repository);
    mkdirSync(path.join(repository, 'reports'));
    writeFileSync(path.join(repository, 'reports', 'prior.md'), '# Prior report\n');
    let releaseFirst!: () => void;
    const firstGet = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let getCount = 0;
    const sessionCreatedAt = new Map<string, number>();
    const client = createStubClient() as any;
    client.session.get = async ({ path: inputPath }: { path: { id: string } }) => {
      getCount += 1;
      if (getCount === 1) await firstGet;
      const created = sessionCreatedAt.get(inputPath.id) ?? Date.now() + 1_000;
      sessionCreatedAt.set(inputPath.id, created);
      return {
        data: {
          id: inputPath.id,
          projectID: 'snapshot',
          directory: repository,
          parentID: 'vuln-primary',
          title: 'Scope child',
          version: '1',
          time: { created, updated: Date.now() + 1_000 },
        },
      };
    };
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository, client);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const command = hooks['command.execute.before']!;
      const message = hooks['chat.message']!;
      const before = hooks['tool.execute.before']!;
      const reader = hooks.tool!.hive_vulnerability_compare_report_read.execute as (value: unknown, context: unknown) => Promise<string>;
      const args = {
        prompt: JSON.stringify({
          schema: 'hive-vuln-review-stage1/v2',
          stage: 'resolve',
          attempt: 1,
          intent: '',
          conversationSummary: 'Compare the current change.',
          fixedOverrides: { comparePath: 'reports/prior.md' },
          clarification: null,
        }),
        subagent_type: vulnerabilityScopeAlias,
        background: false,
      };
      const arm = async (callID: string): Promise<void> => {
        await command({
          command: 'vuln-review',
          sessionID: 'vuln-primary',
          arguments: '--compare reports/prior.md',
        }, { parts: [] });
        await message({ sessionID: 'vuln-primary', agent: primary }, { message: { agent: primary }, parts: [] } as any);
        await before({ tool: 'task', sessionID: 'vuln-primary', callID }, { args });
      };

      await arm('old-call');
      const delayedBinding = message({ sessionID: 'old-child', agent: vulnerabilityScopeAlias }, {
        message: { agent: vulnerabilityScopeAlias },
        parts: [],
      } as any);
      await Promise.resolve();
      await arm('new-call');
      releaseFirst();
      await delayedBinding;
      await expect(reader({}, {
        ...snapshotContext(vulnerabilityScopeAlias),
        sessionID: 'old-child',
      })).rejects.toThrow('no invocation-bound report');

      await message({ sessionID: 'new-child', agent: vulnerabilityScopeAlias }, {
        message: { agent: vulnerabilityScopeAlias },
        parts: [],
      } as any);
      expect(JSON.parse(await reader({}, {
        ...snapshotContext(vulnerabilityScopeAlias),
        sessionID: 'new-child',
      })).path).toBe('reports/prior.md');
    } finally {
      releaseFirst();
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it.each(['before-replacement', 'after-replacement'] as const)(
    'rejects same-ID resolve reuse when the old callback completes %s',
    async (callbackOrder) => {
      const repository = mkdtempSync(path.join(os.tmpdir(), `hive-vulnerability-resolve-call-collision-${callbackOrder}-`));
      createGitRepository(repository);
      try {
        const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
        const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
        await hooks.config?.(config);
        const primary = config.command?.['vuln-review']?.agent!;
        const command = hooks['command.execute.before']!;
        const message = hooks['chat.message']!;
        const before = hooks['tool.execute.before']!;
        const after = hooks['tool.execute.after']!;
        const sharedCallID = `resolve-shared-${callbackOrder}`;
        const packet = {
          schema: 'hive-vuln-review-stage1/v2',
          stage: 'resolve',
          attempt: 1,
          intent: '',
          conversationSummary: 'Review the current change.',
          fixedOverrides: {},
          clarification: null,
        };
        const oldCallback = {
          tool: 'task',
          sessionID: 'vuln-primary',
          callID: sharedCallID,
          args: {},
        };
        const oldOutput = {
          title: 'task',
          output: JSON.stringify({
            schema: 'hive-vuln-review-stage1/v2',
            state: 'BOUNDED',
            candidate: currentChangeProposal(),
          }),
          metadata: {},
        };

        await command({ command: 'vuln-review', sessionID: 'vuln-primary', arguments: '' }, { parts: [] });
        await message({ sessionID: 'vuln-primary', agent: primary }, { message: { agent: primary }, parts: [] } as any);
        await before({ tool: 'task', sessionID: 'vuln-primary', callID: sharedCallID }, {
          args: { prompt: JSON.stringify(packet), subagent_type: vulnerabilityScopeAlias, background: false },
        });
        if (callbackOrder === 'before-replacement') {
          await after(oldCallback, oldOutput);
        }

        await command({ command: 'vuln-review', sessionID: 'vuln-primary', arguments: '' }, { parts: [] });
        await message({ sessionID: 'vuln-primary', agent: primary }, { message: { agent: primary }, parts: [] } as any);
        await expect(before({ tool: 'task', sessionID: 'vuln-primary', callID: sharedCallID }, {
          args: { prompt: JSON.stringify(packet), subagent_type: vulnerabilityScopeAlias, background: false },
        })).rejects.toThrow('reused session/tool callID');

        if (callbackOrder === 'after-replacement') {
          await after(oldCallback, oldOutput);
        }
        await after(oldCallback, oldOutput);

        await expect(before({
          tool: 'task',
          sessionID: 'vuln-primary',
          callID: `resolve-fresh-${callbackOrder}`,
        }, {
          args: { prompt: JSON.stringify(packet), subagent_type: vulnerabilityScopeAlias, background: false },
        })).resolves.toBeUndefined();
      } finally {
        rmSync(repository, { recursive: true, force: true });
      }
    },
  );

  it('permits one exact question answer transition when distinct tools share a callID', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-clarification-'));
    createGitRepository(repository);
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const command = hooks['command.execute.before']!;
      const message = hooks['chat.message']!;
      const before = hooks['tool.execute.before']!;
      const after = hooks['tool.execute.after']!;
      const question = 'Which repository boundary should be reviewed?';
      await command({ command: 'vuln-review', sessionID: 'vuln-primary', arguments: '' }, { parts: [] });
      await message({ sessionID: 'vuln-primary', agent: primary }, { message: { agent: primary }, parts: [] } as any);
      const firstPacket = {
        schema: 'hive-vuln-review-stage1/v2',
        stage: 'resolve',
        attempt: 1,
        intent: '',
        conversationSummary: 'The repository boundary is ambiguous.',
        fixedOverrides: {},
        clarification: null,
      };
      await before({ tool: 'task', sessionID: 'vuln-primary', callID: 'resolve-one' }, {
        args: { prompt: JSON.stringify(firstPacket), subagent_type: vulnerabilityScopeAlias, background: false },
      });
      await after({ tool: 'task', sessionID: 'vuln-primary', callID: 'resolve-one', args: {} }, {
        title: 'task',
        output: JSON.stringify({
          schema: 'hive-vuln-review-stage1/v2',
          state: 'NEEDS_CLARIFICATION',
          question,
          reason: 'ambiguous-target',
          unresolvedDimensions: ['repositories'],
          proposal: currentChangeProposal(),
        }),
        metadata: {},
      });
      const questionArgs = {
        questions: [{
          header: 'Scope',
          question,
          options: [
            { label: 'Yes', description: 'Accept the proposal' },
            { label: 'No', description: 'Deny the proposal' },
          ],
        }],
      };
      await expect(before({ tool: 'question', sessionID: 'vuln-primary', callID: 'question-invalid' }, {
        args: { questions: [{ header: 'Scope', question, options: [{ label: 'root', description: 'Review root' }] }] },
      })).rejects.toThrow('one exact clarification');
      await before({ tool: 'question', sessionID: 'vuln-primary', callID: 'resolve-one' }, { args: questionArgs });
      await expect(before({ tool: 'question', sessionID: 'vuln-primary', callID: 'question-two' }, { args: questionArgs })).rejects.toThrow('one exact clarification');
      await after({ tool: 'question', sessionID: 'vuln-primary', callID: 'resolve-one', args: questionArgs }, {
        title: 'Questions answered',
        output: 'Yes',
        metadata: { answers: [['Yes']] },
      });
      await expect(before({ tool: 'task', sessionID: 'vuln-primary', callID: 'resolve-two' }, {
        args: {
          prompt: JSON.stringify({
            ...firstPacket,
            attempt: 2,
            clarification: { question, answer: 'Yes' },
          }),
          subagent_type: vulnerabilityScopeAlias,
          background: false,
        },
      })).resolves.toBeUndefined();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it.each(
    (['before-replacement', 'after-replacement'] as const).flatMap((callbackOrder) =>
      (['undefined', 'No', 'invalid', 'Yes'] as const).map((oldAnswer) => [callbackOrder, oldAnswer] as const)),
  )(
    'rejects same-ID clarification reuse with an old %s callback answered %s',
    async (callbackOrder, oldAnswer) => {
      const repository = mkdtempSync(path.join(os.tmpdir(), `hive-vulnerability-clarification-generation-${oldAnswer}-`));
      createGitRepository(repository);
      try {
        const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
        const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
        await hooks.config?.(config);
        const primary = config.command?.['vuln-review']?.agent!;
        const command = hooks['command.execute.before']!;
        const message = hooks['chat.message']!;
        const before = hooks['tool.execute.before']!;
        const after = hooks['tool.execute.after']!;
        const question = 'Use the exact proposed repository boundary?';
        const questionArgs = {
          questions: [{
            header: 'Scope',
            question,
            options: [
              { label: 'Yes', description: 'Accept the proposal' },
              { label: 'No', description: 'Deny the proposal' },
            ],
          }],
        };
        const packet = {
          schema: 'hive-vuln-review-stage1/v2',
          stage: 'resolve',
          attempt: 1,
          intent: '',
          conversationSummary: 'The repository boundary is ambiguous.',
          fixedOverrides: {},
          clarification: null,
        };
        const armQuestion = async (suffix: string, callID: string): Promise<void> => {
          await command({ command: 'vuln-review', sessionID: 'vuln-primary', arguments: '' }, { parts: [] });
          await message({ sessionID: 'vuln-primary', agent: primary }, {
            message: { agent: primary },
            parts: [],
          } as any);
          await before({ tool: 'task', sessionID: 'vuln-primary', callID: `resolve-${suffix}` }, {
            args: { prompt: JSON.stringify(packet), subagent_type: vulnerabilityScopeAlias, background: false },
          });
          await after({ tool: 'task', sessionID: 'vuln-primary', callID: `resolve-${suffix}`, args: {} }, {
            title: 'task',
            output: JSON.stringify({
              schema: 'hive-vuln-review-stage1/v2',
              state: 'NEEDS_CLARIFICATION',
              question,
              reason: 'ambiguous-target',
              unresolvedDimensions: ['repositories'],
              proposal: currentChangeProposal(),
            }),
            metadata: {},
          });
          await before({ tool: 'question', sessionID: 'vuln-primary', callID }, { args: questionArgs });
        };

        const sharedCallID = `question-shared-${callbackOrder}-${oldAnswer}`;
        await armQuestion('old', sharedCallID);
        const oldOutput = oldAnswer === 'undefined'
          ? undefined
          : {
              title: 'Questions answered',
              output: oldAnswer,
              metadata: { answers: [[oldAnswer === 'invalid' ? 'yes' : oldAnswer]] },
            };
        const oldCallback = {
          tool: 'question',
          sessionID: 'vuln-primary',
          callID: sharedCallID,
          args: questionArgs,
        };
        if (callbackOrder === 'before-replacement') {
          await after(oldCallback, oldOutput as any);
        }

        await command({ command: 'vuln-review', sessionID: 'vuln-primary', arguments: '' }, { parts: [] });
        await message({ sessionID: 'vuln-primary', agent: primary }, {
          message: { agent: primary },
          parts: [],
        } as any);
        await before({ tool: 'task', sessionID: 'vuln-primary', callID: `resolve-current-${callbackOrder}-${oldAnswer}` }, {
          args: { prompt: JSON.stringify(packet), subagent_type: vulnerabilityScopeAlias, background: false },
        });
        await after({
          tool: 'task',
          sessionID: 'vuln-primary',
          callID: `resolve-current-${callbackOrder}-${oldAnswer}`,
          args: {},
        }, {
          title: 'task',
          output: JSON.stringify({
            schema: 'hive-vuln-review-stage1/v2',
            state: 'NEEDS_CLARIFICATION',
            question,
            reason: 'ambiguous-target',
            unresolvedDimensions: ['repositories'],
            proposal: currentChangeProposal(),
          }),
          metadata: {},
        });
        await expect(before({
          tool: 'question',
          sessionID: 'vuln-primary',
          callID: sharedCallID,
        }, { args: questionArgs })).rejects.toThrow('reused session/tool callID');

        if (callbackOrder === 'after-replacement') {
          await after(oldCallback, oldOutput as any);
        }
        await after(oldCallback, oldOutput as any);

        const currentCallID = `question-current-${callbackOrder}-${oldAnswer}`;
        await before({ tool: 'question', sessionID: 'vuln-primary', callID: currentCallID }, { args: questionArgs });
        await after({
          tool: 'question',
          sessionID: 'vuln-primary',
          callID: currentCallID,
          args: questionArgs,
        }, {
          title: 'Questions answered',
          output: 'Yes',
          metadata: { answers: [['Yes']] },
        });
        await expect(before({ tool: 'task', sessionID: 'vuln-primary', callID: `resolve-two-${callbackOrder}-${oldAnswer}` }, {
          args: {
            prompt: JSON.stringify({
              ...packet,
              attempt: 2,
              clarification: { question, answer: 'Yes' },
            }),
            subagent_type: vulnerabilityScopeAlias,
            background: false,
          },
        })).resolves.toBeUndefined();
      } finally {
        rmSync(repository, { recursive: true, force: true });
      }
    },
  );

  it('makes a malformed attempt-two task terminal across retry, materialize, and create', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-attempt-two-terminal-'));
    createGitRepository(repository);
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const command = hooks['command.execute.before']!;
      const message = hooks['chat.message']!;
      const before = hooks['tool.execute.before']!;
      const after = hooks['tool.execute.after']!;
      const question = 'Use the proposed repository boundary?';
      const firstPacket = {
        schema: 'hive-vuln-review-stage1/v2',
        stage: 'resolve',
        attempt: 1,
        intent: '',
        conversationSummary: 'The repository boundary is ambiguous.',
        fixedOverrides: {},
        clarification: null,
      };
      await command({ command: 'vuln-review', sessionID: 'vuln-primary', arguments: '' }, { parts: [] });
      await message({ sessionID: 'vuln-primary', agent: primary }, { message: { agent: primary }, parts: [] } as any);
      await before({ tool: 'task', sessionID: 'vuln-primary', callID: 'terminal-first' }, {
        args: { prompt: JSON.stringify(firstPacket), subagent_type: vulnerabilityScopeAlias, background: false },
      });
      await after({ tool: 'task', sessionID: 'vuln-primary', callID: 'terminal-first', args: {} }, {
        title: 'task',
        output: JSON.stringify({
          schema: 'hive-vuln-review-stage1/v2',
          state: 'NEEDS_CLARIFICATION',
          question,
          reason: 'ambiguous-target',
          unresolvedDimensions: ['repositories'],
          proposal: currentChangeProposal(),
        }),
        metadata: {},
      });
      const questionArgs = {
        questions: [{
          header: 'Scope',
          question,
          options: [
            { label: 'Yes', description: 'Accept the proposal' },
            { label: 'No', description: 'Deny the proposal' },
          ],
        }],
      };
      await before({ tool: 'question', sessionID: 'vuln-primary', callID: 'terminal-question' }, { args: questionArgs });
      await after({ tool: 'question', sessionID: 'vuln-primary', callID: 'terminal-question', args: questionArgs }, {
        title: 'Questions answered',
        output: 'Yes',
        metadata: { answers: [['Yes']] },
      });
      const exactSecondArgs = {
        prompt: JSON.stringify({
          ...firstPacket,
          attempt: 2,
          clarification: { question, answer: 'Yes' },
        }),
        subagent_type: vulnerabilityScopeAlias,
        background: false,
      };

      await expect(before({ tool: 'task', sessionID: 'vuln-primary', callID: 'terminal-invalid' }, {
        args: { ...exactSecondArgs, prompt: '{malformed' },
      })).rejects.toThrow('JSON-only packet');
      await expect(before({ tool: 'task', sessionID: 'vuln-primary', callID: 'terminal-retry' }, {
        args: exactSecondArgs,
      })).rejects.toThrow('active Stage 1 reservation');
      await expect(before({ tool: 'task', sessionID: 'vuln-primary', callID: 'terminal-materialize' }, {
        args: {
          prompt: JSON.stringify({ schema: 'hive-vuln-review-stage1/v2', stage: 'materialize' }),
          subagent_type: vulnerabilityScopeAlias,
          background: false,
        },
      })).rejects.toThrow('active Stage 1 reservation');
      await expect(hooks.tool!.hive_review_workspace_create.execute(
        { repositoryIds: ['root'], scopeMode: 'current-change' },
        snapshotContext(vulnerabilityScopeAlias),
      )).rejects.toThrow('no exact materialize grant');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('uses idle session.status and deprecated session.idle as idempotent revocation fallbacks', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-vulnerability-idle-events-'));
    createGitRepository(repository);
    mkdirSync(path.join(repository, 'reports'));
    writeFileSync(path.join(repository, 'reports', 'prior.md'), '# Prior report\n');
    try {
      const { hooks, vulnerabilityScopeAlias } = await createSnapshotPlugin(repository);
      const config: { agent?: Record<string, AgentConfig>; command?: Record<string, { agent?: string }> } = {};
      await hooks.config?.(config);
      const primary = config.command?.['vuln-review']?.agent!;
      const command = hooks['command.execute.before']!;
      const message = hooks['chat.message']!;
      const before = hooks['tool.execute.before']!;
      const reader = hooks.tool!.hive_vulnerability_compare_report_read.execute as (value: unknown, context: unknown) => Promise<string>;
      const arm = async (child: string, callID: string): Promise<Record<string, unknown>> => {
        await command({
          command: 'vuln-review',
          sessionID: 'vuln-primary',
          arguments: '--compare reports/prior.md',
        }, { parts: [] });
        await message({ sessionID: 'vuln-primary', agent: primary }, { message: { agent: primary }, parts: [] } as any);
        await before({ tool: 'task', sessionID: 'vuln-primary', callID }, {
          args: {
            prompt: JSON.stringify({
              schema: 'hive-vuln-review-stage1/v2',
              stage: 'resolve',
              attempt: 1,
              intent: '',
              conversationSummary: 'Compare the current change.',
              fixedOverrides: { comparePath: 'reports/prior.md' },
              clarification: null,
            }),
            subagent_type: vulnerabilityScopeAlias,
            background: false,
          },
        });
        await message({ sessionID: child, agent: vulnerabilityScopeAlias }, {
          message: { agent: vulnerabilityScopeAlias },
          parts: [],
        } as any);
        return { ...snapshotContext(vulnerabilityScopeAlias), sessionID: child };
      };

      const statusContext = await arm('status-child', 'status-call');
      await hooks.event?.({
        event: { type: 'session.status', properties: { sessionID: 'status-child', status: { type: 'idle' } } },
      } as any);
      await hooks.event?.({
        event: { type: 'session.status', properties: { sessionID: 'status-child', status: { type: 'idle' } } },
      } as any);
      await expect(reader({}, statusContext)).rejects.toThrow('no invocation-bound report');

      const deprecatedContext = await arm('deprecated-child', 'deprecated-call');
      await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'deprecated-child' } } } as any);
      await expect(reader({}, deprecatedContext)).rejects.toThrow('no invocation-bound report');
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
      hive_vulnerability_compare_report_read: false,
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
