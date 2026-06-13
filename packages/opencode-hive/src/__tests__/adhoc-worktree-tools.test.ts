import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk';
import plugin from '../index';
import { HIVE_TOOL_NAMES } from '../utils/plugin-manifest.js';

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

async function loadHooks(directory: string) {
  const ctx: PluginInput = {
    directory,
    worktree: directory,
    serverUrl: new URL('http://localhost:1'),
    project: createProject(directory),
    client: OPENCODE_CLIENT,
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

  it('registers all four ad-hoc tool names in HIVE_TOOL_NAMES', () => {
    expect(HIVE_TOOL_NAMES).toContain('hive_adhoc_worktree_create');
    expect(HIVE_TOOL_NAMES).toContain('hive_adhoc_worktree_commit');
    expect(HIVE_TOOL_NAMES).toContain('hive_adhoc_merge');
    expect(HIVE_TOOL_NAMES).toContain('hive_adhoc_cleanup');
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
      expect(result.backgroundTaskCall).toEqual({
        background: true,
        subagent_type: 'forager-worker',
        description: `Ad-hoc: ${result.runId}`,
        prompt: `Work in ${result.workspacePath} for ad-hoc run ${result.runId}. Follow the user's current instructions, keep changes scoped to that worktree, and report verification evidence before commit or merge.`,
      });

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
        backgroundScope?: unknown;
        backgroundOwnership?: unknown;
        backgroundTaskCall?: unknown;
        nextAction?: string;
      }>(raw);

      expect(result.success).toBe(true);
      expectWorktreeResponseShape(result);
      expect(fs.existsSync(result.workspacePath!)).toBe(true);
      expect(result.workerLaunch).toBe('suppressed');
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
          backgroundTaskCall?: unknown;
          backgroundScope?: unknown;
          workerLaunch?: string;
        }>(raw);

        expect(result.success).toBe(true);
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
        message: 'feat: adhoc note',
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
        message: 'feat: adhoc note',
      },
      toolContext,
    );

    const mergeRaw = await hooks.tool!.hive_adhoc_merge.execute(
      { runId: created.runId },
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
});
