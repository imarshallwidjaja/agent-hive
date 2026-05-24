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

  it('hive_adhoc_worktree_create succeeds without an active feature or task', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_create_no_feature');

    const raw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { label: 'no-feature-run' },
      toolContext,
    );
    const result = JSON.parse(raw as string) as {
      success?: boolean;
      runId?: string;
      workspacePath?: string;
      branch?: string;
      nextAction?: string;
    };

    expect(result.success).toBe(true);
    expect(typeof result.runId).toBe('string');
    expect(typeof result.workspacePath).toBe('string');
    expect(typeof result.branch).toBe('string');
    expect(typeof result.nextAction).toBe('string');
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
    const result = JSON.parse(raw as string) as {
      success?: boolean;
      reason?: string;
      error?: string;
      nextAction?: string;
    };

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
    const result = JSON.parse(raw as string) as { reason?: string };
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
    const result = JSON.parse(raw as string) as { reason?: string };
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
    const result = JSON.parse(raw as string) as { success?: boolean; error?: string };
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
    const created = JSON.parse(createRaw as string) as {
      runId: string;
      workspacePath: string;
    };

    // create a file so commit has something to commit
    fs.writeFileSync(path.join(created.workspacePath, 'note.txt'), 'hello');

    const commitRaw = await hooks.tool!.hive_adhoc_worktree_commit.execute(
      { runId: created.runId, message: 'feat: adhoc note' },
      toolContext,
    );
    const commit = JSON.parse(commitRaw as string) as {
      workspacePath?: string;
      branch?: string;
      nextAction?: string;
    };
    expect(typeof commit.workspacePath).toBe('string');
    expect(typeof commit.branch).toBe('string');
    expect(typeof commit.nextAction).toBe('string');
  });

  it('ad-hoc merge response contains workspacePath, branch, and nextAction', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_merge_shape');

    const createRaw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { label: 'merge-shape' },
      toolContext,
    );
    const created = JSON.parse(createRaw as string) as {
      runId: string;
      workspacePath: string;
    };

    fs.writeFileSync(path.join(created.workspacePath, 'note.txt'), 'hello');
    await hooks.tool!.hive_adhoc_worktree_commit.execute(
      { runId: created.runId, message: 'feat: adhoc note' },
      toolContext,
    );

    const mergeRaw = await hooks.tool!.hive_adhoc_merge.execute(
      { runId: created.runId },
      toolContext,
    );
    const merge = JSON.parse(mergeRaw as string) as {
      workspacePath?: string;
      branch?: string;
      nextAction?: string;
    };
    expect(typeof merge.workspacePath).toBe('string');
    expect(typeof merge.branch).toBe('string');
    expect(typeof merge.nextAction).toBe('string');
  });

  it('ad-hoc cleanup response contains workspacePath, branch, and nextAction', async () => {
    initGitRoot(testRoot);
    const hooks = await loadHooks(testRoot);
    const toolContext = createToolContext('sess_adhoc_cleanup_shape');

    const createRaw = await hooks.tool!.hive_adhoc_worktree_create.execute(
      { label: 'cleanup-shape' },
      toolContext,
    );
    const created = JSON.parse(createRaw as string) as {
      runId: string;
      workspacePath: string;
      branch: string;
    };

    const cleanupRaw = await hooks.tool!.hive_adhoc_cleanup.execute(
      { runId: created.runId, deleteBranch: true },
      toolContext,
    );
    const cleanup = JSON.parse(cleanupRaw as string) as {
      workspacePath?: string;
      branch?: string;
      nextAction?: string;
    };
    expect(typeof cleanup.workspacePath).toBe('string');
    expect(typeof cleanup.branch).toBe('string');
    expect(typeof cleanup.nextAction).toBe('string');
  });
});
