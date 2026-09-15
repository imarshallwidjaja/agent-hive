import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk';
import plugin from '../index';
import { AdhocWorktreeService, WorktreeLinkageError, WorktreeTopologyMismatchError } from 'hive-core';
import type { WorktreeReasonCode } from 'hive-core';
import { HIVE_TOOL_NAMES } from '../utils/plugin-manifest.js';
import { HIVE_SESSION_POLICY } from '../utils/session-policy.js';

const OPENCODE_CLIENT = createOpencodeClient({ baseUrl: 'http://localhost:1' }) as unknown as PluginInput['client'];

type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  abort: AbortSignal;
};

const TEST_ROOT_BASE = '/tmp/hive-adhoc-plugin-tools';
const TEST_PROCESS_CWD = process.cwd();

function createStubShell(): PluginInput['$'] {
  let shell: PluginInput['$'];

  const fn = ((..._args: unknown[]) => {
    throw new Error('shell not available in this test');
  }) as unknown as PluginInput['$'];

  shell = Object.assign(fn, {
    braces(pattern: string) {
      return [pattern];
    },
    escape(input: string) {
      return input;
    },
    env() {
      return shell;
    },
    cwd() {
      return shell;
    },
    nothrow() {
      return shell;
    },
    throws() {
      return shell;
    },
  });

  return shell;
}

function createToolContext(sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: 'msg_test',
    agent: 'test',
    abort: new AbortController().signal,
  };
}

function createProject(worktree: string): PluginInput['project'] {
  return {
    id: 'test',
    worktree,
    time: { created: Date.now() },
  };
}

function initGitRoot(root: string): void {
  execSync('git init', { cwd: root });
  execSync('git config user.email "test@example.com"', { cwd: root });
  execSync('git config user.name "Test"', { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'adhoc plugin tool test');
  execSync('git add README.md', { cwd: root });
  execSync('git commit -m "init"', { cwd: root });
}

function parseToolJson<T>(raw: unknown): T {
  return JSON.parse(raw as string) as T;
}

function expectWorktreeResponseShape(result: {
  workspacePath?: string;
  branch?: string;
  nextAction?: string;
}): void {
  expect(typeof result.workspacePath).toBe('string');
  expect(typeof result.branch).toBe('string');
  expect(typeof result.nextAction).toBe('string');
}

async function loadHooks(directory: string, terminalSessionIDs?: Set<string>) {
  const client = {
    ...(OPENCODE_CLIENT as any),
    session: {
      ...(OPENCODE_CLIENT as any).session,
      get: async ({ path: inputPath }: { path: { id: string } }) => ({
        data: { id: inputPath.id, parentID: undefined },
      }),
      ...(terminalSessionIDs ? {
        status: async () => ({
          data: Object.fromEntries([...terminalSessionIDs].map(sessionID => [sessionID, { type: 'idle' }])),
        }),
        messages: async ({ path: inputPath }: { path: { id: string } }) => ({
          data: terminalSessionIDs.has(inputPath.id)
            ? [{ info: { role: 'assistant', time: { completed: Date.now() } }, parts: [] }]
            : [],
        }),
      } : {}),
    },
  } as PluginInput['client'];
  const ctx: PluginInput = {
    directory,
    worktree: directory,
    serverUrl: new URL('http://localhost:1'),
    project: createProject(directory),
    client,
    $: createStubShell(),
  };
  return plugin(ctx);
}

describe('ad-hoc worktree plugin tools', () => {
  let testRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    process.chdir(TEST_PROCESS_CWD);
    originalHome = process.env.HOME;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'project-'));
    process.env.HOME = testRoot;
  });

  afterEach(() => {
    process.chdir(TEST_PROCESS_CWD);
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it('registers all five ad-hoc tool names in HIVE_TOOL_NAMES', () => {
    expect(HIVE_TOOL_NAMES).toContain('hive_adhoc_worktree_create');
    expect(HIVE_TOOL_NAMES).toContain('hive_adhoc_worktree_start');
    expect(HIVE_TOOL_NAMES).toContain('hive_adhoc_worktree_commit');
    expect(HIVE_TOOL_NAMES).toContain('hive_adhoc_merge');
    expect(HIVE_TOOL_NAMES).toContain('hive_adhoc_cleanup');
  });

  it('registers existing-workspace preparation separately from ad-hoc lifecycle tools', () => {
    expect(HIVE_TOOL_NAMES).toContain('hive_existing_workspace_start');
  });

  it('does not include opencode-native task_status in HIVE_TOOL_NAMES', () => {
    expect(HIVE_TOOL_NAMES).not.toContain('task_status');
  });

  it('registers Hive background board management tools in HIVE_TOOL_NAMES', () => {
    expect(HIVE_TOOL_NAMES).toContain('hive_background_status');
    expect(HIVE_TOOL_NAMES).toContain('hive_background_reconcile');
    expect(HIVE_TOOL_NAMES).toContain('hive_background_reconcile_batch');
    expect(HIVE_TOOL_NAMES).toContain('hive_background_cancel');
  });

  it('hive_adhoc_worktree_create succeeds without an active feature or task', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_create_no_feature');

    const raw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { label: 'no-feature-run' },
      toolContext,
    );
    const result = parseToolJson<{
      success?: boolean;
      runId?: string;
      workspacePath?: string;
      branch?: string;
      nextAction?: string;
    }>(raw);

    expect(result.success).toBe(true);
    expect(typeof result.runId).toBe('string');
    expect(typeof result.workspacePath).toBe('string');
    expect(typeof result.branch).toBe('string');
    expect(typeof result.nextAction).toBe('string');
    expect(fs.existsSync(result.workspacePath!)).toBe(true);
  });

  it('hive_adhoc_worktree_create returns background scope metadata without an active feature', async () => {
    const previousBackgroundEnv = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';

    try {
      initGitRoot(testRoot);
      const hooks = await loadHooks(testRoot);
      const toolContext = createToolContext('sess_adhoc_background_scope');

      const raw = await hooks.tool!.hive_adhoc_worktree_create.execute(
        { label: 'background-run' },
        toolContext,
      );
      const result = parseToolJson<{
        success?: boolean;
        runId?: string;
        workspacePath?: string;
        branch?: string;
        nextAction?: string;
        backgroundScope?: {
          adHocRunId?: string;
          projectRoot?: string;
          parentSessionId?: string;
        };
        backgroundOwnership?: {
          worktreePath?: string;
          branch?: string;
          repoIds?: string[];
        };
        backgroundTaskCall?: {
          background?: boolean;
          subagent_type?: string;
          description?: string;
          prompt?: string;
        };
        taskToolCall?: {
          subagent_type?: string;
          description?: string;
          prompt?: string;
          background?: boolean;
          task_id?: string;
        };
        launchMode?: string;
        launchId?: string;
        expiresAt?: string;
        sessionPolicy?: typeof HIVE_SESSION_POLICY;
      }>(raw);

      expect(result.success).toBe(true);
      expect(result.backgroundScope).toEqual({
        adHocRunId: result.runId,
        projectRoot: testRoot,
        parentSessionId: 'sess_adhoc_background_scope',
      });
      expect(result.backgroundOwnership).toEqual({
        worktreePath: result.workspacePath,
        branch: result.branch,
        repoIds: [],
      });
      expect(result.launchMode).toBe('blocking_task_call');
      expect(result.launchId).toEqual(expect.any(String));
      expect(result.expiresAt).toEqual(expect.any(String));
      expect(result.sessionPolicy).toEqual(HIVE_SESSION_POLICY);
      expect(result.taskToolCall).toEqual({
        subagent_type: 'forager-worker',
        description: `Ad-hoc: ${result.runId}`,
        prompt: expect.stringContaining(`Workspace: ${result.workspacePath}`),
        hive_launch_id: result.launchId,
      });
      expect(result.taskToolCall?.background).toBeUndefined();
      expect(result.taskToolCall).not.toHaveProperty('task_id');
      expect(result.backgroundTaskCall).toEqual({
        background: true,
        subagent_type: 'forager-worker',
        description: `Ad-hoc: ${result.runId}`,
        prompt: result.taskToolCall?.prompt,
        hive_launch_id: result.launchId,
      });
      expect(result.backgroundTaskCall).not.toHaveProperty('task_id');
      expect(result.backgroundTaskCall?.prompt).toContain(`Run ID: ${result.runId}`);
      expect(result.backgroundTaskCall?.prompt).toContain('report blocked without editing');
      expect(result.nextAction).toContain('taskToolCall');
      expect(result.nextAction).toContain('backgroundTaskCall');
      expect(result.nextAction).not.toContain('Work in the ad-hoc worktree');

      const board = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'background-jobs.json'), 'utf-8')) as {
        pendingLaunches?: Array<{
          parentSessionId?: string;
          expectedDescription?: string;
          expectedPrompt?: string;
          agentName?: string;
          scope?: { adHocRunId?: string; projectRoot?: string; parentSessionId?: string };
          ownership?: { worktreePath?: string; branch?: string; repoIds?: string[] };
        }>;
      };
      expect(board.pendingLaunches).toEqual([expect.objectContaining({
        parentSessionId: 'sess_adhoc_background_scope',
        expectedDescription: result.backgroundTaskCall?.description,
        expectedPrompt: result.backgroundTaskCall?.prompt,
        agentName: result.backgroundTaskCall?.subagent_type,
        scope: result.backgroundScope,
        ownership: result.backgroundOwnership,
      })]);
    } finally {
      if (previousBackgroundEnv === undefined) {
        delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      } else {
        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previousBackgroundEnv;
      }
    }
  });

  it('hive_adhoc_worktree_create returns a blocking taskToolCall when background is disabled', async () => {
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    delete process.env.OPENCODE_EXPERIMENTAL;
    initGitRoot(testRoot);
    const configPath = path.join(testRoot, '.config', 'opencode', 'agent_hive.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        'forager-worker': {
          description: '  Default for ordinary backend implementation.  ',
        },
      },
      customAgents: {
        'forager-backend': {
          baseAgent: 'forager-worker',
          description: 'Use for backend implementation involving persistence or service boundaries.',
        },
      },
    }));
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_gate_closed_worker');

    const raw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { label: 'blocking-run' },
      toolContext,
    );
    const result = parseToolJson<{
      success?: boolean;
      runId?: string;
      workspacePath?: string;
      branch?: string;
      nextAction?: string;
      launchMode?: string;
      defaultAgent?: string;
      eligibleAgents?: Array<{ name: string; baseAgent: string; description: string }>;
      instructions?: string;
      sessionPolicy?: typeof HIVE_SESSION_POLICY;
      taskToolCall?: {
        subagent_type?: string;
        description?: string;
        prompt?: string;
        background?: boolean;
        task_id?: string;
        hive_launch_id?: string;
      };
      backgroundTaskCall?: unknown;
      backgroundScope?: unknown;
    }>(raw);

    expect(result.success).toBe(true);
    expect(result.launchMode).toBe('blocking_task_call');
    expect(result.defaultAgent).toBe('forager-worker');
    expect(result.eligibleAgents).toEqual([
      {
        name: 'forager-worker',
        baseAgent: 'forager-worker',
        description: 'Default for ordinary backend implementation.',
      },
      {
        name: 'forager-backend',
        baseAgent: 'forager-worker',
        description: 'Use for backend implementation involving persistence or service boundaries.',
      },
      {
        name: 'forager-example-template',
        baseAgent: 'forager-worker',
        description: 'Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.',
      },
    ]);
    expect(result.sessionPolicy).toEqual(HIVE_SESSION_POLICY);
      expect(result.taskToolCall).toEqual({
      subagent_type: 'forager-worker',
      description: `Ad-hoc: ${result.runId}`,
      prompt: expect.stringContaining(`Workspace: ${result.workspacePath}`),
      hive_launch_id: expect.any(String),
    });
    expect(result.taskToolCall?.background).toBeUndefined();
    expect(result.taskToolCall).not.toHaveProperty('task_id');
    expect(result.taskToolCall?.prompt).toContain(`Run ID: ${result.runId}`);
    expect(result.backgroundTaskCall).toBeUndefined();
    expect(result.backgroundScope).toBeUndefined();
    expect(result.nextAction).toContain('launch the returned `taskToolCall`');
    expect(result.instructions).toContain('Default to `forager-worker` if no specialist is a better match.');
    expect(result.instructions).toContain("Choose autonomously the agent whose description best matches the task's domain, workflow, artifact type, or concrete review/approach risk; use the built-in base agent when no configured custom subagent is a closer fit.");
    expect(result.instructions).toContain('Candidate-specific conditions in an individual description still apply, including a condition that the candidate may be selected only when the operator explicitly names it.');
    expect(result.instructions).not.toContain('or when the operator explicitly names it');
    expect(result.instructions).toContain('override `taskToolCall.subagent_type` and, when used, `backgroundTaskCall.subagent_type` when a custom overlay in `eligibleAgents` is a closer fit');
    expect(result.nextAction).not.toContain('Work in the ad-hoc worktree');
    expect(fs.existsSync(path.join(testRoot, '.hive', 'background-jobs.json'))).toBe(false);
  });

  it('hive_adhoc_worktree_create uses supplied workerInstructions in backgroundTaskCall prompt', async () => {
    const previousBackgroundEnv = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';

    try {
      initGitRoot(testRoot);
      const hooks = await loadHooks(testRoot);
      const toolContext = createToolContext('sess_adhoc_worker_instructions');

      const raw = await hooks.tool!.hive_adhoc_worktree_create.execute(
        {
          label: 'worker-instructions',
          workerInstructions: 'Objective: update the focused prompt tests and run bun test prompts.test.ts.',
        },
        toolContext,
      );
      const result = parseToolJson<{
        success?: boolean;
        workspacePath?: string;
        backgroundTaskCall?: { prompt?: string };
        nextAction?: string;
      }>(raw);

      expect(result.success).toBe(true);
      expect(result.backgroundTaskCall?.prompt).toContain(`Workspace: ${result.workspacePath}`);
      expect(result.backgroundTaskCall?.prompt).toContain('Objective: update the focused prompt tests and run bun test prompts.test.ts.');
      expect(result.backgroundTaskCall?.prompt).toContain('must not call task-backed Hive commit/merge tools');
      expect(result.backgroundTaskCall?.prompt).toContain('must not commit, merge, or cleanup');
      expect(result.backgroundTaskCall?.prompt).toContain('changed files');
      expect(result.backgroundTaskCall?.prompt).toContain('verification commands and observed results');
      expect(result.nextAction).toContain('backgroundTaskCall');
    } finally {
      if (previousBackgroundEnv === undefined) {
        delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      } else {
        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previousBackgroundEnv;
      }
    }
  });

  it('hive_adhoc_worktree_create exposes only workerInstructions and ignores the removed worker alias', async () => {
    const previousBackgroundEnv = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';

    try {
      initGitRoot(testRoot);
      const hooks = await loadHooks(testRoot);
      const toolContext = createToolContext('sess_adhoc_removed_worker_prompt_alias');
      const createTool = hooks.tool!.hive_adhoc_worktree_create as unknown as {
        args?: Record<string, unknown>;
        execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
      };
      const removedAlias = ['worker', 'Prompt'].join('');

      expect(Object.keys(createTool.args ?? {})).toContain('workerInstructions');
      expect(Object.keys(createTool.args ?? {})).not.toContain(removedAlias);

      const raw = await createTool.execute(
        {
          label: 'removed-worker-prompt-alias',
          [removedAlias]: 'Removed alias text must not reach the spawned worker prompt.',
        },
        toolContext,
      );
      const result = parseToolJson<{
        success?: boolean;
        backgroundTaskCall?: { prompt?: string };
      }>(raw);

      expect(result.success).toBe(true);
      expect(result.backgroundTaskCall?.prompt).not.toContain('Removed alias text must not reach the spawned worker prompt.');
    } finally {
      if (previousBackgroundEnv === undefined) {
        delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      } else {
        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previousBackgroundEnv;
      }
    }
  });

  it('hive_adhoc_worktree_create with gate closed and autoSpawnWorker false omits launch payloads', async () => {
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    delete process.env.OPENCODE_EXPERIMENTAL;
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_gate_closed_suppressed');

    const raw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { label: 'gate-closed-inspection', autoSpawnWorker: false },
      toolContext,
    );
    const result = parseToolJson<{
      success?: boolean;
      launchMode?: string;
      taskToolCall?: unknown;
      backgroundTaskCall?: unknown;
      backgroundScope?: unknown;
      workerLaunch?: string;
    }>(raw);

    expect(result.success).toBe(true);
    expect(result.launchMode).toBe('suppressed');
    expect(result.taskToolCall).toBeUndefined();
    expect(result.backgroundTaskCall).toBeUndefined();
    expect(result.backgroundScope).toBeUndefined();
    expect(result.workerLaunch).toBe('suppressed');
    expect(fs.existsSync(path.join(testRoot, '.hive', 'background-jobs.json'))).toBe(false);
  });

  it('hive_adhoc_worktree_create with autoSpawnWorker false suppresses pending launch and backgroundTaskCall', async () => {
    const previousBackgroundEnv = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';

    try {
      initGitRoot(testRoot);
      const hooks = await loadHooks(testRoot);
      const toolContext = createToolContext('sess_adhoc_inspection_only');

      const raw = await hooks.tool!.hive_adhoc_worktree_create.execute(
        { label: 'inspection-run', autoSpawnWorker: false },
        toolContext,
      );
      const result = parseToolJson<{
        success?: boolean;
        workspacePath?: string;
        branch?: string;
        workerLaunch?: string;
        launchMode?: string;
        taskToolCall?: unknown;
        backgroundScope?: unknown;
        backgroundOwnership?: unknown;
        backgroundTaskCall?: unknown;
        nextAction?: string;
      }>(raw);

      expect(result.success).toBe(true);
      expectWorktreeResponseShape(result);
      expect(fs.existsSync(result.workspacePath!)).toBe(true);
      expect(result.launchMode).toBe('suppressed');
      expect(result.workerLaunch).toBe('suppressed');
      expect(result.taskToolCall).toBeUndefined();
      expect(result.backgroundScope).toBeDefined();
      expect(result.backgroundOwnership).toBeDefined();
      expect(result.backgroundTaskCall).toBeUndefined();

      const boardPath = path.join(testRoot, '.hive', 'background-jobs.json');
      if (fs.existsSync(boardPath)) {
        const board = JSON.parse(fs.readFileSync(boardPath, 'utf-8')) as {
          pendingLaunches?: unknown[];
        };
        expect(board.pendingLaunches ?? []).toHaveLength(0);
      }
    } finally {
      if (previousBackgroundEnv === undefined) {
        delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      } else {
        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previousBackgroundEnv;
      }
    }
  });

  it('starts and retries a setup-only ad-hoc run with fresh canonical launch authority', async () => {
    initGitRoot(testRoot);
    const terminalSessionIDs = new Set<string>();
    const hooks = await loadHooks(testRoot, terminalSessionIDs);
    const parent = 'sess_adhoc_reusable_start';
    const toolContext = createToolContext(parent);
    const setup = parseToolJson<{ runId: string; workspacePath: string }>(
      await hooks.tool!.hive_adhoc_worktree_create.execute(
        { runId: 'reusable-run', autoSpawnWorker: false },
        toolContext,
      ),
    );

    const first = parseToolJson<{
      launchId: string;
      taskToolCall: { subagent_type: string; prompt: string; hive_launch_id: string };
    }>(await hooks.tool!.hive_adhoc_worktree_start.execute({
      runId: setup.runId,
      workerInstructions: 'Implement the first bounded change.',
    }, toolContext));
    expect(first.taskToolCall.prompt).toContain('Implement the first bounded change.');
    expect(first.taskToolCall.hive_launch_id).toBe(first.launchId);

    const dispatch = { args: { ...first.taskToolCall, prompt: 'caller edit' } };
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'reusable-first' }, dispatch);
    expect(dispatch.args.prompt).toContain('Implement the first bounded change.');
    expect(dispatch.args).not.toHaveProperty('hive_launch_id');
    await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: 'reusable-child', parentID: parent } } } } as any);
    await hooks.event?.({ event: { type: 'message.part.updated', properties: { part: {
      type: 'tool', tool: 'task', sessionID: parent, callID: 'reusable-first',
      state: { input: dispatch.args, metadata: { sessionId: 'reusable-child' } },
    } } } } as any);
    await hooks['chat.message']?.({ sessionID: 'reusable-child', agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    terminalSessionIDs.add('reusable-child');
    await hooks.event?.({ event: { type: 'session.status', properties: { sessionID: 'reusable-child', status: { type: 'idle' } } } } as any);

    const retry = parseToolJson<{
      launchId: string;
      workspacePath: string;
      taskToolCall: { prompt: string; hive_launch_id: string };
    }>(await hooks.tool!.hive_adhoc_worktree_start.execute({
      runId: setup.runId,
      workerInstructions: 'Implement the retry with different instructions.',
    }, toolContext));
    expect(retry.workspacePath).toBe(setup.workspacePath);
    expect(retry.launchId).not.toBe(first.launchId);
    expect(retry.taskToolCall.hive_launch_id).toBe(retry.launchId);
    expect(retry.taskToolCall.prompt).toContain('Implement the retry with different instructions.');
  }, 30_000);

  it.each([
    { autoSpawnWorker: undefined as boolean | undefined, label: 'omitted' },
    { autoSpawnWorker: true, label: 'true' },
  ])(
    'hive_adhoc_worktree_create with gate closed and autoSpawnWorker $label does not register pending launch',
    async ({ autoSpawnWorker }) => {
      const previousBackgroundEnv = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      const previousExperimental = process.env.OPENCODE_EXPERIMENTAL;
      delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      delete process.env.OPENCODE_EXPERIMENTAL;

      try {
        initGitRoot(testRoot);
        const hooks = await loadHooks(testRoot);
        const toolContext = createToolContext('sess_adhoc_gate_closed');

        const args: { label: string; autoSpawnWorker?: boolean } = { label: 'gate-closed-run' };
        if (autoSpawnWorker !== undefined) {
          args.autoSpawnWorker = autoSpawnWorker;
        }

        const raw = await hooks.tool!.hive_adhoc_worktree_create.execute(args, toolContext);
        const result = parseToolJson<{
          success?: boolean;
          launchMode?: string;
          taskToolCall?: {
            subagent_type?: string;
            description?: string;
            prompt?: string;
            background?: boolean;
          };
          backgroundTaskCall?: unknown;
          backgroundScope?: unknown;
          workerLaunch?: string;
        }>(raw);

        expect(result.success).toBe(true);
        expect(result.launchMode).toBe('blocking_task_call');
        expect(result.taskToolCall?.subagent_type).toBe('forager-worker');
        expect(result.taskToolCall?.background).toBeUndefined();
        expect(result.backgroundTaskCall).toBeUndefined();
        expect(result.backgroundScope).toBeUndefined();
        expect(result.workerLaunch).toBeUndefined();

        const boardPath = path.join(testRoot, '.hive', 'background-jobs.json');
        expect(fs.existsSync(boardPath)).toBe(false);
      } finally {
        if (previousBackgroundEnv === undefined) {
          delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
        } else {
          process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previousBackgroundEnv;
        }
        if (previousExperimental === undefined) {
          delete process.env.OPENCODE_EXPERIMENTAL;
        } else {
          process.env.OPENCODE_EXPERIMENTAL = previousExperimental;
        }
      }
    },
  );

  it('hive_adhoc_worktree_create treats blank optional fields as omitted', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_create_blank_optional');

    const raw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { runId: '', label: '', baseBranch: '', repoIds: [] },
      toolContext,
    );
    const result = parseToolJson<{
      success?: boolean;
      reason?: string;
      runId?: string;
      workspacePath?: string;
    }>(raw);

    expect(result.success).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(typeof result.runId).toBe('string');
    expect(result.runId).not.toBe('');
    expect(fs.existsSync(result.workspacePath!)).toBe(true);
  });

  it('returns structured repo_manifest_required for non-git root without manifest', async () => {
    // Intentionally do NOT initialize git in testRoot.
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_no_manifest');

    const raw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      {},
      toolContext,
    );
    const result = parseToolJson<{
      success?: boolean;
      reason?: string;
      error?: string;
      nextAction?: string;
    }>(raw);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('repo_manifest_required');
    expect(typeof result.error).toBe('string');
    expect(typeof result.nextAction).toBe('string');
  });

  it('ad-hoc launch preparation classifies trusted-identity denials and keeps retry guidance for unclassified errors', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_create_denial_classification');
    const createTool = hooks.tool!.hive_adhoc_worktree_create as unknown as {
      execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
    };
    const startTool = hooks.tool!.hive_adhoc_worktree_start as unknown as {
      execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
    };

    const typedDenials: Array<{ label: string; reasonCode: WorktreeReasonCode; error: Error }> = [
      {
        label: 'linkage invalid',
        reasonCode: 'WORKTREE_LINKAGE_INVALID',
        error: new WorktreeLinkageError(
          'Worktree linkage preflight failed for repository adhoc: administration backlink does not select this exact worktree',
        ),
      },
      {
        label: 'workspace topology mismatch',
        reasonCode: 'WORKSPACE_TOPOLOGY_MISMATCH',
        error: new WorktreeTopologyMismatchError(
          'Workspace topology mismatch for repository adhoc: recorded topology does not match the trusted repository manifest',
        ),
      },
    ];

    for (const denial of typedDenials) {
      const createSpy = spyOn(AdhocWorktreeService.prototype, 'create').mockImplementation(async () => {
        throw denial.error;
      });

      let raw: unknown;
      try {
        raw = await createTool.execute({ label: 'denial-classification' }, toolContext);
      } catch (error: unknown) {
        throw new Error(`${denial.label} threw instead of returning JSON: ${(error as Error).message}`);
      } finally {
        createSpy.mockRestore();
      }

      const result = parseToolJson<{
        success?: boolean;
        reason?: string;
        reasonCode?: string;
        phase?: string;
        mutation?: string;
        retryable?: boolean;
        action?: string;
        error?: string;
        nextAction?: string;
      }>(raw);

      expect(result.success, denial.label).toBe(false);
      expect(result.reason, denial.label).toBe('adhoc_create_failed');
      expect(result.reasonCode, denial.label).toBe(denial.reasonCode);
      expect(result.phase, denial.label).toBe('preflight');
      expect(result.mutation, denial.label).toBe('none');
      expect(result.retryable, denial.label).toBe(false);
      expect(result.action, denial.label).toBe('start_fresh_run');
      expect(result.error, denial.label).toContain(denial.error.message);
      expect(result.nextAction ?? '', denial.label).not.toMatch(/retry hive_adhoc_worktree_create/i);
      expect(result.nextAction, denial.label).toContain('Preserve the workspace and Git metadata');
      expect(result.nextAction, denial.label).toContain('independently valid workspace');

      const getSpy = spyOn(AdhocWorktreeService.prototype, 'get').mockImplementation(async () => {
        throw denial.error;
      });
      let startRaw: unknown;
      try {
        startRaw = await startTool.execute({
          runId: 'denial-classification',
          workerInstructions: 'Prepare a fresh worker.',
        }, toolContext);
      } finally {
        getSpy.mockRestore();
      }
      const startResult = parseToolJson<{
        success?: boolean;
        reason?: string;
        reasonCode?: string;
        phase?: string;
        mutation?: string;
        retryable?: boolean;
        action?: string;
        error?: string;
        nextAction?: string;
        launchId?: string;
        taskToolCall?: unknown;
        backgroundTaskCall?: unknown;
      }>(startRaw);
      expect(startResult.success, denial.label).toBe(false);
      expect(startResult.reason, denial.label).toBe('adhoc_start_failed');
      expect(startResult.reasonCode, denial.label).toBe(denial.reasonCode);
      expect(startResult.phase, denial.label).toBe('preflight');
      expect(startResult.mutation, denial.label).toBe('none');
      expect(startResult.retryable, denial.label).toBe(false);
      expect(startResult.action, denial.label).toBe('start_fresh_run');
      expect(startResult.error, denial.label).toContain(denial.error.message);
      expect(startResult.nextAction ?? '', denial.label).not.toMatch(/retry hive_adhoc_worktree_start/i);
      expect(startResult.nextAction, denial.label).toContain('Preserve the workspace and Git metadata');
      expect(startResult.nextAction, denial.label).toContain('independently valid workspace');
      expect(startResult.launchId, denial.label).toBeUndefined();
      expect(startResult.taskToolCall, denial.label).toBeUndefined();
      expect(startResult.backgroundTaskCall, denial.label).toBeUndefined();
    }

    const plainErrorSpy = spyOn(AdhocWorktreeService.prototype, 'create').mockImplementation(async () => {
      throw new Error('simulated create collision on the target path');
    });

    let plainRaw: unknown;
    try {
      plainRaw = await createTool.execute({ label: 'unclassified-create-error' }, toolContext);
    } finally {
      plainErrorSpy.mockRestore();
    }

    const plain = parseToolJson<{
      success?: boolean;
      reason?: string;
      reasonCode?: string;
      action?: string;
      error?: string;
      nextAction?: string;
    }>(plainRaw);

    expect(plain.success).toBe(false);
    expect(plain.reason).toBe('adhoc_create_failed');
    expect(plain).not.toHaveProperty('reasonCode');
    expect(plain).not.toHaveProperty('action');
    expect(plain.nextAction).toContain('retry hive_adhoc_worktree_create');

    const plainStartErrorSpy = spyOn(AdhocWorktreeService.prototype, 'get').mockImplementation(async () => {
      throw new Error('simulated unclassified start failure');
    });
    let plainStartRaw: unknown;
    try {
      plainStartRaw = await startTool.execute({
        runId: 'unclassified-start-error',
        workerInstructions: 'Prepare a fresh worker.',
      }, toolContext);
    } finally {
      plainStartErrorSpy.mockRestore();
    }
    const plainStart = parseToolJson<{
      success?: boolean;
      reason?: string;
      reasonCode?: string;
      action?: string;
      nextAction?: string;
    }>(plainStartRaw);
    expect(plainStart.success).toBe(false);
    expect(plainStart.reason).toBe('adhoc_start_failed');
    expect(plainStart).not.toHaveProperty('reasonCode');
    expect(plainStart).not.toHaveProperty('action');
    expect(plainStart.nextAction).toContain('retry hive_adhoc_worktree_start');
  });

  it('hive_worktree_start still returns feature_required without a feature', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_legacy_start_no_feature');

    const raw = await hooks.tool!.hive_worktree_start.execute(
      { task: '01-anything' },
      toolContext,
    );
    const result = parseToolJson<{ reason?: string }>(raw);
    expect(result.reason).toBe('feature_required');
  });

  it('hive_worktree_commit still returns feature_required without a feature', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_legacy_commit_no_feature');

    const raw = await hooks.tool!.hive_worktree_commit.execute(
      { task: '01-anything', summary: 'noop' },
      toolContext,
    );
    const result = parseToolJson<{ reason?: string }>(raw);
    expect(result.reason).toBe('feature_required');
  });

  it('hive_merge still fails without feature/task', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_legacy_merge_no_feature');

    const raw = await hooks.tool!.hive_merge.execute(
      { task: '01-anything' },
      toolContext,
    );
    const result = parseToolJson<{ success?: boolean; error?: string }>(raw);
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('ad-hoc commit response contains workspacePath, branch, and nextAction', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_commit_shape');

    const createRaw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { label: 'commit-shape' },
      toolContext,
    );
    const created = parseToolJson<{
      runId: string;
      workspacePath: string;
      branch: string;
    }>(createRaw);

    // create a file so commit has something to commit
    fs.writeFileSync(path.join(created.workspacePath, 'note.txt'), 'hello');

    const commitRaw = await hooks.tool!.hive_adhoc_worktree_commit.execute(
      {
        runId: created.runId,
        workspacePath: created.workspacePath,
        branch: created.branch,
        message: 'feat: adhoc note\n\nRecord the ad-hoc note in test history.',
      },
      toolContext,
    );
    const commit = parseToolJson<{
      workspacePath?: string;
      branch?: string;
      nextAction?: string;
    }>(commitRaw);
    expectWorktreeResponseShape(commit);
  });

  it('ad-hoc commit rejects mismatched workspacePath or branch', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_commit_mismatch');

    const createRaw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { label: 'commit-mismatch' },
      toolContext,
    );
    const created = parseToolJson<{
      runId: string;
      workspacePath: string;
      branch: string;
    }>(createRaw);

    const commitRaw = await hooks.tool!.hive_adhoc_worktree_commit.execute(
      {
        runId: created.runId,
        workspacePath: path.join(testRoot, 'wrong-workspace'),
        branch: created.branch,
        message: 'feat: should not commit',
      },
      toolContext,
    );
    const commit = parseToolJson<{ success?: boolean; reason?: string }>(commitRaw);

    expect(commit.success).toBe(false);
    expect(commit.reason).toBe('adhoc_run_mismatch');
  });

  it('ad-hoc composite commit: first repo unchanged and later repo failure is rejected via error, not no-change success', async () => {
    initGitRoot(testRoot);
    for (const id of ['api', 'web']) {
      const repoPath = path.join(testRoot, 'repos', id);
      fs.mkdirSync(repoPath, { recursive: true });
      execSync('git init', { cwd: repoPath });
      execSync('git config user.email "test@example.com"', { cwd: repoPath });
      execSync('git config user.name "Test"', { cwd: repoPath });
      fs.writeFileSync(path.join(repoPath, 'README.md'), `${id}\n`);
      execSync('git add README.md', { cwd: repoPath });
      execSync('git commit -m "init"', { cwd: repoPath });
    }
    fs.mkdirSync(path.join(testRoot, '.hive'), { recursive: true });
    fs.writeFileSync(
      path.join(testRoot, '.hive', 'repositories.json'),
      JSON.stringify({
        schemaVersion: 1,
        repositories: [
          { id: 'api', path: './repos/api' },
          { id: 'web', path: './repos/web' },
        ],
      }),
    );

    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_commit_later_fail');
    const createRaw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { runId: 'later-fail', repoIds: ['api', 'web'], autoSpawnWorker: false },
      toolContext,
    );
    const created = parseToolJson<{
      success?: boolean;
      runId: string;
      workspacePath: string;
      branch: string;
      repos?: Record<string, { path: string }>;
    }>(createRaw);
    expect(created.success).toBe(true);
    expect(created.repos).toBeDefined();

    fs.writeFileSync(path.join(created.repos!.web.path, 'web-only.txt'), 'web\n');
    const webHookDir = path.join(testRoot, 'repos', 'web', '.git', 'hooks');
    fs.mkdirSync(webHookDir, { recursive: true });
    const webHookPath = path.join(webHookDir, 'pre-commit');
    fs.writeFileSync(webHookPath, '#!/bin/sh\necho "web hook rejected commit" >&2\nexit 1\n');
    fs.chmodSync(webHookPath, 0o755);
    execSync(`git config core.hooksPath ${JSON.stringify(webHookDir)}`, {
      cwd: path.join(testRoot, 'repos', 'web'),
    });

    const commitRaw = await hooks.tool!.hive_adhoc_worktree_commit.execute(
      {
        runId: created.runId,
        workspacePath: created.workspacePath,
        branch: created.branch,
        message: 'feat: later fail\n\nSurface later-repo failure after earlier no-change.',
      },
      toolContext,
    );
    const commit = parseToolJson<{
      success?: boolean;
      error?: string;
      reason?: string;
      reasonCode?: string;
      retryable?: boolean;
      action?: string;
      commit?: {
        committed?: boolean;
        partial?: boolean;
        error?: string;
        message?: string;
        repos?: Record<string, { committed: boolean; message?: string }>;
      };
      nextAction?: string;
    }>(commitRaw);

    expect(commit.success).toBe(false);
    expect(commit.commit?.committed).toBe(false);
    expect(commit.commit?.partial).toBeFalsy();
    expect(commit.commit?.error).toContain('web');
    expect(commit.commit?.message).not.toBe('No changes to commit');
    expect(commit.commit?.repos!.api.committed).toBe(false);
    expect(commit.commit?.repos!.web.committed).toBe(false);
    // Guidance is derived from the classification, not from a blanket retry:
    // an unclassified Git failure must be inspected before it is repeated.
    expect(commit.reasonCode).toBe('GIT_OPERATION_FAILED');
    expect(commit.retryable).toBe(true);
    expect(commit.action).toBe('inspect_state');
    expect(commit.nextAction).toContain('Inspect the current run, worktree, and Git state before acting');
    expect(commit.nextAction).not.toContain('call hive_adhoc_worktree_commit again');
  });

  it('ad-hoc merge response contains workspacePath, branch, and nextAction', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_merge_shape');

    const createRaw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { label: 'merge-shape' },
      toolContext,
    );
    const created = parseToolJson<{
      runId: string;
      workspacePath: string;
      branch: string;
    }>(createRaw);

    fs.writeFileSync(path.join(created.workspacePath, 'note.txt'), 'hello');
    await hooks.tool!.hive_adhoc_worktree_commit.execute(
      {
        runId: created.runId,
        workspacePath: created.workspacePath,
        branch: created.branch,
        message: 'feat: adhoc note\n\nRecord the ad-hoc note in test history.',
      },
      toolContext,
    );

    const mergeRaw = await hooks.tool!.hive_adhoc_merge.execute(
      { runId: created.runId, message: 'feat: integrate ad-hoc note\n\nIntegrate verified ad-hoc work as one commit.' },
      toolContext,
    );
    const merge = parseToolJson<{
      workspacePath?: string;
      branch?: string;
      strategy?: string;
      nextAction?: string;
    }>(mergeRaw);
    expect(merge.strategy).toBe('squash');
    expectWorktreeResponseShape(merge);
  });

  it('ad-hoc squash merge rejects an omitted aggregate message', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_merge_omitted_message');

    const createRaw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { label: 'omitted-message' },
      toolContext,
    );
    const created = parseToolJson<{
      runId: string;
      workspacePath: string;
      branch: string;
    }>(createRaw);

    fs.writeFileSync(path.join(created.workspacePath, 'note.txt'), 'hello');
    await hooks.tool!.hive_adhoc_worktree_commit.execute(
      {
        runId: created.runId,
        workspacePath: created.workspacePath,
        branch: created.branch,
        message: 'feat: preserve adhoc source narrative\n\nBody from the ad-hoc source commit.',
      },
      toolContext,
    );

    const mergeRaw = await hooks.tool!.hive_adhoc_merge.execute(
      { runId: created.runId },
      toolContext,
    );
    const merge = parseToolJson<{
      success: boolean;
      merged: boolean;
      commitMessage?: string;
    }>(mergeRaw);

    expect(merge.success).toBe(false);
    expect(merge.merged).toBe(false);
    expect(merge.commitMessage).toBeUndefined();
  });

  it('ad-hoc cleanup response contains workspacePath, branch, and nextAction', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_cleanup_shape');

    const createRaw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { label: 'cleanup-shape' },
      toolContext,
    );
    const created = parseToolJson<{
      runId: string;
      workspacePath: string;
      branch: string;
    }>(createRaw);

    const cleanupRaw = await hooks.tool!.hive_adhoc_cleanup.execute(
      { runId: created.runId, deleteBranch: true },
      toolContext,
    );
    const cleanup = parseToolJson<{
      workspacePath?: string;
      branch?: string;
      nextAction?: string;
    }>(cleanupRaw);
    expectWorktreeResponseShape(cleanup);
  });

  it('ad-hoc cleanup returns adhoc_run_not_found for unknown runs', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_cleanup_unknown');

    const cleanupRaw = await hooks.tool!.hive_adhoc_cleanup.execute(
      { runId: 'missing-run', deleteBranch: true },
      toolContext,
    );
    const cleanup = parseToolJson<{
      success?: boolean;
      reason?: string;
      workspacePath?: unknown;
      branch?: unknown;
    }>(cleanupRaw);

    expect(cleanup.success).toBe(false);
    expect(cleanup.reason).toBe('adhoc_run_not_found');
    expect(cleanup.workspacePath).toBeUndefined();
    expect(cleanup.branch).toBeUndefined();
  });

  it('ad-hoc commit rejects missing or blank identity arguments without a Node path error', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_commit_invalid_arguments');

    const createRaw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { runId: 'invalid-arguments-run' },
      toolContext,
    );
    const created = parseToolJson<{ runId: string; workspacePath: string; branch: string }>(createRaw);
    fs.writeFileSync(path.join(created.workspacePath, 'note.txt'), 'hello\n');
    const headBefore = execSync('git rev-parse HEAD', { cwd: created.workspacePath, encoding: 'utf8' }).trim();

    const commitTool = hooks.tool!.hive_adhoc_worktree_commit as unknown as {
      execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
    };
    const baseArgs = {
      runId: created.runId,
      workspacePath: created.workspacePath,
      branch: created.branch,
      message: 'feat: adhoc note\n\nRecord the ad-hoc note in test history.',
    };

    // Direct .execute calls bypass schema validation, which is what leaked
    // `The "paths[0]" property must be of type string, got undefined`.
    const cases: Array<{ label: string; args: Record<string, unknown>; missingField: string }> = [
      { label: 'workspacePath omitted', args: { ...baseArgs, workspacePath: undefined }, missingField: 'workspacePath' },
      { label: 'branch omitted', args: { ...baseArgs, branch: undefined }, missingField: 'branch' },
      { label: 'workspacePath blank', args: { ...baseArgs, workspacePath: '   ' }, missingField: 'workspacePath' },
      { label: 'branch blank', args: { ...baseArgs, branch: '' }, missingField: 'branch' },
      { label: 'message blank', args: { ...baseArgs, message: '   ' }, missingField: 'message' },
      { label: 'runId blank', args: { ...baseArgs, runId: '' }, missingField: 'runId' },
    ];

    for (const testCase of cases) {
      let raw: unknown;
      try {
        raw = await commitTool.execute(testCase.args, toolContext);
      } catch (error: unknown) {
        throw new Error(`${testCase.label} threw instead of returning JSON: ${(error as Error).message}`);
      }
      const result = parseToolJson<{
        success?: boolean;
        runId?: string;
        reason?: string;
        reasonCode?: string;
        phase?: string;
        mutation?: string;
        retryable?: boolean;
        action?: string;
        error?: string;
        nextAction?: string;
      }>(raw);

      expect(result.success, testCase.label).toBe(false);
      expect(result.reasonCode, testCase.label).toBe('INVALID_ARGUMENTS');
      expect(result.phase, testCase.label).toBe('validation');
      expect(result.mutation, testCase.label).toBe('none');
      expect(result.retryable, testCase.label).toBe(false);
      expect(result.action, testCase.label).toBe('correct_arguments');
      expect(result.error, testCase.label).toContain(testCase.missingField);
      expect(JSON.stringify(result), testCase.label).not.toContain('paths[0]');
      expect(result.nextAction, testCase.label).toContain('hive_adhoc_worktree_create');
    }

    expect(execSync('git rev-parse HEAD', { cwd: created.workspacePath, encoding: 'utf8' }).trim()).toBe(headBefore);
    expect(execSync('git log --oneline', { cwd: created.workspacePath, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
  });

  it('ad-hoc cleanup reports non-success with per-step truth when a requested branch deletion fails', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_cleanup_branch_failure');

    const createRaw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { runId: 'cleanup-branch-failure' },
      toolContext,
    );
    const created = parseToolJson<{ runId: string; workspacePath: string; branch: string }>(createRaw);

    const getGit = (AdhocWorktreeService.prototype as any).getGit;
    const gitSpy = spyOn(AdhocWorktreeService.prototype as any, 'getGit').mockImplementation(function (this: any, cwd?: string) {
      const git = getGit.call(this, cwd);
      return new Proxy(git, {
        get(target, key) {
          if (key === 'deleteLocalBranch') {
            return () => Promise.reject(new Error('simulated branch deletion failure'));
          }
          return Reflect.get(target, key);
        },
      });
    });

    let cleanupRaw: unknown;
    try {
      cleanupRaw = await hooks.tool!.hive_adhoc_cleanup.execute(
        { runId: created.runId, deleteBranch: true },
        toolContext,
      );
    } finally {
      gitSpy.mockRestore();
    }

    const cleanup = parseToolJson<{
      success?: boolean;
      cleanup?: {
        requested?: string;
        outcome?: string;
        worktreeRemoval?: { status?: string };
        branchDeletion?: { status?: string; error?: string };
        prune?: { status?: string };
        failures?: Array<{ step?: string }>;
      };
      reasonCode?: string;
      action?: string;
      retryable?: boolean;
      nextAction?: string;
    }>(cleanupRaw);

    expect(cleanup.success).toBe(false);
    expect(cleanup.cleanup?.requested).toBe('worktree+branch');
    expect(cleanup.cleanup?.outcome).toBe('partial');
    expect(cleanup.cleanup?.branchDeletion?.status).toBe('failed');
    expect(cleanup.cleanup?.branchDeletion?.error).toContain('simulated branch deletion failure');
    expect(cleanup.cleanup?.failures).toEqual([expect.objectContaining({ step: 'branch-deletion' })]);
    expect(cleanup.reasonCode).toBe('CLEANUP_FAILED');
    expect(cleanup.action).toBe('cleanup_only');
    expect(cleanup.retryable).toBe(false);
    expect(cleanup.nextAction ?? '').not.toContain('No further action required');
    expect(cleanup.nextAction ?? '').toContain('Repeat only the cleanup step');
  });

  it('ad-hoc merge reports a linkage denial as a non-retryable start_fresh_run without recommending a merge retry', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_merge_linkage_denied');

    const createRaw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { runId: 'linkage-denied-run' },
      toolContext,
    );
    const created = parseToolJson<{ runId: string }>(createRaw);
    expect(created.runId).toBe('linkage-denied-run');

    const getSpy = spyOn(AdhocWorktreeService.prototype, 'get').mockImplementation(async function () {
      throw new WorktreeLinkageError(
        'Worktree linkage preflight failed for repository adhoc: administration backlink does not select this exact worktree',
      );
    });

    let mergeRaw: unknown;
    try {
      mergeRaw = await hooks.tool!.hive_adhoc_merge.execute(
        { runId: created.runId, strategy: 'squash', message: 'feat: integrate\n\nIntegrate the ad-hoc work as one commit.' },
        toolContext,
      );
    } finally {
      getSpy.mockRestore();
    }

    const merge = parseToolJson<{
      success?: boolean;
      reasonCode?: string;
      phase?: string;
      mutation?: string;
      retryable?: boolean;
      action?: string;
      nextAction?: string;
      error?: string;
    }>(mergeRaw);

    expect(merge.success).toBe(false);
    expect(merge.reasonCode).toBe('WORKTREE_LINKAGE_INVALID');
    expect(merge.phase).toBe('preflight');
    expect(merge.mutation).toBe('none');
    expect(merge.retryable).toBe(false);
    expect(merge.action).toBe('start_fresh_run');
    expect(merge.nextAction).toContain('independently valid workspace');
    expect(merge.nextAction).toContain('Do not repair, rewrite, or migrate Git metadata');
    expect(merge.nextAction ?? '').not.toContain('call the same tool again');
    expect(merge.nextAction ?? '').not.toContain('retry hive_adhoc_merge');
  });

  it('ad-hoc create rejects non-string optional arguments instead of passing them to path or Git', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_create_invalid_optional');

    const createTool = hooks.tool!.hive_adhoc_worktree_create as unknown as {
      execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
    };
    const raw = await createTool.execute({ runId: 42, baseBranch: { name: 'main' } }, toolContext);
    const result = parseToolJson<{
      success?: boolean;
      reasonCode?: string;
      action?: string;
      error?: string;
    }>(raw);

    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe('INVALID_ARGUMENTS');
    expect(result.action).toBe('correct_arguments');
    expect(result.error).toContain('runId');
    expect(result.error).toContain('baseBranch');
    expect(JSON.stringify(result)).not.toContain('paths[0]');
  });

  it('ad-hoc create rejects a dash-prefixed baseBranch as invalid arguments', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_create_dash_base_branch');

    const createTool = hooks.tool!.hive_adhoc_worktree_create as unknown as {
      execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
    };
    const raw = await createTool.execute({ baseBranch: '--no-checkout' }, toolContext);
    const result = parseToolJson<{
      success?: boolean;
      reasonCode?: string;
      phase?: string;
      mutation?: string;
      retryable?: boolean;
      action?: string;
      error?: string;
    }>(raw);

    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe('INVALID_ARGUMENTS');
    expect(result.phase).toBe('validation');
    expect(result.mutation).toBe('none');
    expect(result.retryable).toBe(false);
    expect(result.action).toBe('correct_arguments');
    expect(result.error).toContain('baseBranch');
  });

  it('ad-hoc create still accepts a legitimate baseBranch', async () => {
    initGitRoot(testRoot);
    execSync('git branch base-branch', { cwd: testRoot });
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_create_valid_base_branch');

    const raw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { label: 'valid-base-run', baseBranch: 'base-branch', autoSpawnWorker: false },
      toolContext,
    );
    const result = parseToolJson<{
      success?: boolean;
      workspacePath?: string;
      branch?: string;
    }>(raw);

    expect(result.success).toBe(true);
    expect(typeof result.workspacePath).toBe('string');
    expect(typeof result.branch).toBe('string');
    expect(fs.existsSync(result.workspacePath!)).toBe(true);
    expect(fs.existsSync(path.join(result.workspacePath!, 'README.md'))).toBe(true);
  });

  it.each([
    { toolName: 'hive_adhoc_merge' as const, args: { strategy: 'squash', message: 'feat: x\n\nbody' } },
    { toolName: 'hive_adhoc_cleanup' as const, args: { deleteBranch: true } },
  ])('$toolName rejects a missing or blank runId with a classified validation failure', async ({ toolName, args }) => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext(`sess_${toolName}_invalid_run_id`);
    const tool = hooks.tool![toolName] as unknown as {
      execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
    };

    for (const runId of [undefined, '', '   ']) {
      let raw: unknown;
      try {
        raw = await tool.execute({ ...args, runId }, toolContext);
      } catch (error: unknown) {
        throw new Error(`${toolName} with runId=${JSON.stringify(runId)} threw instead of returning JSON: ${(error as Error).message}`);
      }
      const result = parseToolJson<{
        success?: boolean;
        reasonCode?: string;
        phase?: string;
        mutation?: string;
        retryable?: boolean;
        action?: string;
        error?: string;
      }>(raw);

      expect(result.success, `${toolName} runId=${JSON.stringify(runId)}`).toBe(false);
      expect(result.reasonCode).toBe('INVALID_ARGUMENTS');
      expect(result.phase).toBe('validation');
      expect(result.mutation).toBe('none');
      expect(result.retryable).toBe(false);
      expect(result.action).toBe('correct_arguments');
      expect(result.error).toContain('runId');
      expect(JSON.stringify(result)).not.toContain('paths[0]');
    }
  });
});
