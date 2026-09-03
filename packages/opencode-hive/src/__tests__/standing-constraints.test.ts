/**
 * Runtime tests for operator standing constraints.
 *
 * These assert generated output: the exact `task()` prompt the runtime hands to
 * OpenCode, the generated worker prompt file, and the background pending-launch
 * correlation. They do not assert agent prompt wording.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk';
import plugin from '../index';
import { STANDING_CONSTRAINTS_HEADING, buildStandingConstraintsBlock } from '../utils/worker-prompt.js';

/** Task-created child sessions keyed by child id; every other session is a root. */
const SESSION_PARENTS: Record<string, string> = {
  sess_architect_child: 'sess_architect_primary',
};

const OPENCODE_CLIENT = createOpencodeClient({ baseUrl: 'http://localhost:1' }) as unknown as PluginInput['client'];
(OPENCODE_CLIENT.session as unknown as { get: (input: { path: { id: string } }) => Promise<unknown> }).get = async (input) => ({
  data: {
    id: input.path.id,
    parentID: SESSION_PARENTS[input.path.id],
    projectID: 'test',
    directory: '/tmp',
    title: 'Primary test session',
    version: '1',
    time: { created: 1, updated: 1 },
  },
});

const TEST_ROOT_BASE = '/tmp/hive-standing-constraints';
const TEST_PROCESS_CWD = process.cwd();
const CONSTRAINTS = 'Follow stop-slop. Humanise the writing. Write like Ivan.';
const CONSTRAINTS_BLOCK = buildStandingConstraintsBlock(CONSTRAINTS)!;

type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  abort: AbortSignal;
};

type LaneTargets = {
  dash: string;
  vulnerability: string;
};

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

function initGitRoot(root: string): void {
  execSync('git init', { cwd: root });
  execSync('git config user.email "test@example.com"', { cwd: root });
  execSync('git config user.name "Test"', { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'standing constraints test');
  fs.writeFileSync(path.join(root, '.gitignore'), '.hive/\n');
  execSync('git add README.md .gitignore', { cwd: root });
  execSync('git commit -m "init"', { cwd: root });
}

async function loadHooks(directory: string) {
  return plugin({
    directory,
    worktree: directory,
    serverUrl: new URL('http://localhost:1'),
    project: { id: 'test', worktree: directory, time: { created: Date.now() } },
    client: OPENCODE_CLIENT,
    $: createStubShell(),
  });
}

/**
 * Review lane task targets only exist after the config hook builds them, so the
 * hook's lane skip cannot be exercised without running config first.
 */
async function resolveLaneTargets(hooks: Awaited<ReturnType<typeof loadHooks>>): Promise<LaneTargets> {
  const opencodeConfig: { agent?: Record<string, { description?: string }> } = {};
  await hooks.config?.(opencodeConfig as never);
  const entries = Object.entries(opencodeConfig.agent ?? {});
  const dash = entries.find(([, config]) => config.description?.startsWith('Frozen Workspace Review Lane - '))?.[0];
  const vulnerability = entries.find(([, config]) => config.description?.startsWith('Private Vulnerability Review Lane - '))?.[0];

  if (!dash || !vulnerability) {
    throw new Error('Review lane targets were not configured');
  }
  return { dash, vulnerability };
}

let callSequence = 0;
async function runTaskHook(
  hooks: Awaited<ReturnType<typeof loadHooks>>,
  sessionID: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  callSequence += 1;
  const output = { args };
  await hooks['tool.execute.before']?.(
    { tool: 'task', sessionID, callID: `call_constraints_${callSequence}` } as never,
    output as never,
  );
  return output.args;
}

function parseToolJson<T>(raw: unknown): T {
  return JSON.parse(raw as string) as T;
}

describe('operator standing constraints', () => {
  let testRoot: string;
  let originalHome: string | undefined;
  let originalBackgroundEnv: string | undefined;
  let originalExperimental: string | undefined;

  beforeEach(() => {
    process.chdir(TEST_PROCESS_CWD);
    originalHome = process.env.HOME;
    originalBackgroundEnv = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    originalExperimental = process.env.OPENCODE_EXPERIMENTAL;
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    delete process.env.OPENCODE_EXPERIMENTAL;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'project-'));
    process.env.HOME = testRoot;
  });

  afterEach(() => {
    process.chdir(TEST_PROCESS_CWD);
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalBackgroundEnv === undefined) delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    else process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = originalBackgroundEnv;
    if (originalExperimental === undefined) delete process.env.OPENCODE_EXPERIMENTAL;
    else process.env.OPENCODE_EXPERIMENTAL = originalExperimental;
  });

  describe('hive_constraints_set', () => {
    it('registers verbatim constraints on the calling session', async () => {
      const hooks = await loadHooks(testRoot);

      const result = parseToolJson<{
        success?: boolean;
        constraintsChars?: number;
      }>(await hooks.tool!.hive_constraints_set.execute(
        { constraints: CONSTRAINTS },
        createToolContext('sess_set'),
      ));

      expect(result.success).toBe(true);
      expect(result.constraintsChars).toBe(CONSTRAINTS.length);

      const sessions = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'sessions.json'), 'utf-8')) as {
        sessions: Array<{ sessionId: string; standingConstraints?: string }>;
      };
      expect(sessions.sessions.find((session) => session.sessionId === 'sess_set')?.standingConstraints).toBe(CONSTRAINTS);
    });

    it('refuses over the cap and reports the actual length without truncating', async () => {
      const hooks = await loadHooks(testRoot);
      const oversized = 'C'.repeat(8001);

      const result = parseToolJson<{
        success?: boolean;
        reason?: string;
        error?: string;
        constraintsChars?: number;
        cap?: number;
      }>(await hooks.tool!.hive_constraints_set.execute(
        { constraints: oversized },
        createToolContext('sess_cap'),
      ));

      expect(result.success).toBe(false);
      expect(result.terminal).toBe(false);
      expect(result.reason).toBe('constraints_too_long');
      expect(result.constraintsChars).toBe(8001);
      expect(result.cap).toBe(8000);
      expect(result.error).toContain('8001');
      expect(result.error).toContain('8000');

      const args = await runTaskHook(hooks, 'sess_cap', {
        subagent_type: 'forager-worker',
        prompt: 'Do the work.',
      });
      expect(args.prompt).toBe('Do the work.');
    });

    it('accepts constraints exactly at the cap', async () => {
      const hooks = await loadHooks(testRoot);
      const atCap = 'C'.repeat(8000);

      const result = parseToolJson<{ success?: boolean; constraintsChars?: number }>(
        await hooks.tool!.hive_constraints_set.execute({ constraints: atCap }, createToolContext('sess_at_cap')),
      );

      expect(result.success).toBe(true);
      expect(result.constraintsChars).toBe(8000);
    });

    it('clears the register on an empty or whitespace string so later launches are unaffected', async () => {
      const hooks = await loadHooks(testRoot);
      const toolContext = createToolContext('sess_clear');

      await hooks.tool!.hive_constraints_set.execute({ constraints: CONSTRAINTS }, toolContext);
      const before = await runTaskHook(hooks, 'sess_clear', {
        subagent_type: 'forager-worker',
        prompt: 'Do the work.',
      });
      expect(before.prompt).toContain(STANDING_CONSTRAINTS_HEADING);

      const cleared = parseToolJson<{ success?: boolean; cleared?: boolean }>(
        await hooks.tool!.hive_constraints_set.execute({ constraints: '' }, toolContext),
      );
      expect(cleared).toEqual({ success: true, cleared: true });

      const afterEmpty = await runTaskHook(hooks, 'sess_clear', {
        subagent_type: 'forager-worker',
        prompt: 'Do the work.',
      });
      expect(afterEmpty.prompt).toBe('Do the work.');

      await hooks.tool!.hive_constraints_set.execute({ constraints: CONSTRAINTS }, toolContext);
      const clearedWs = parseToolJson<{ success?: boolean; cleared?: boolean }>(
        await hooks.tool!.hive_constraints_set.execute({ constraints: '   \n\t ' }, toolContext),
      );
      expect(clearedWs).toEqual({ success: true, cleared: true });

      const afterWs = await runTaskHook(hooks, 'sess_clear', {
        subagent_type: 'forager-worker',
        prompt: 'Do the work.',
      });
      expect(afterWs.prompt).toBe('Do the work.');
    });
  });

  describe('task dispatch hook', () => {
    it('leaves the task prompt byte-identical when no register is set', async () => {
      const hooks = await loadHooks(testRoot);
      const prompt = 'Implement the parser and report verification evidence.';

      const args = await runTaskHook(hooks, 'sess_empty_state', {
        subagent_type: 'forager-worker',
        description: 'Hive: parser',
        prompt,
      });

      expect(args.prompt).toBe(prompt);
      expect(args.prompt).not.toContain(STANDING_CONSTRAINTS_HEADING);
    });

    it('appends the block for ordinary worker and reviewer targets', async () => {
      const hooks = await loadHooks(testRoot);
      await hooks.tool!.hive_constraints_set.execute({ constraints: CONSTRAINTS }, createToolContext('sess_ordinary'));

      for (const target of ['forager-worker', 'code-reviewer', 'simplicity-reviewer', 'scout-researcher']) {
        const args = await runTaskHook(hooks, 'sess_ordinary', {
          subagent_type: target,
          prompt: 'Do the work.',
        });
        expect(args.prompt, target).toBe(`Do the work.\n\n${CONSTRAINTS_BLOCK}`);
      }
    });

    it('appends the block when the launch has no prior prompt text', async () => {
      const hooks = await loadHooks(testRoot);
      await hooks.tool!.hive_constraints_set.execute({ constraints: CONSTRAINTS }, createToolContext('sess_no_prompt'));

      const args = await runTaskHook(hooks, 'sess_no_prompt', { subagent_type: 'forager-worker' });

      expect(args.prompt).toBe(CONSTRAINTS_BLOCK);
    });

    it('does not append for dash review or vulnerability review lane targets', async () => {
      const hooks = await loadHooks(testRoot);
      const lanes = await resolveLaneTargets(hooks);
      await hooks.tool!.hive_constraints_set.execute({ constraints: CONSTRAINTS }, createToolContext('sess_lanes'));

      for (const target of [lanes.dash, lanes.vulnerability]) {
        const args = await runTaskHook(hooks, 'sess_lanes', {
          subagent_type: target,
          prompt: 'Review the frozen workspace.',
        });
        expect(args.prompt, target).toBe('Review the frozen workspace.');
      }
    });

    it('does not append twice to a prompt that already carries the sentinel', async () => {
      const hooks = await loadHooks(testRoot);
      await hooks.tool!.hive_constraints_set.execute({ constraints: CONSTRAINTS }, createToolContext('sess_idempotent'));

      const first = await runTaskHook(hooks, 'sess_idempotent', {
        subagent_type: 'forager-worker',
        prompt: 'Do the work.',
      });
      const second = await runTaskHook(hooks, 'sess_idempotent', {
        subagent_type: 'forager-worker',
        prompt: first.prompt,
      });

      expect(second.prompt).toBe(first.prompt);
      expect((second.prompt as string).split(STANDING_CONSTRAINTS_HEADING)).toHaveLength(2);
    });

    it('does not append to a Hive worker-prompt file reference', async () => {
      const hooks = await loadHooks(testRoot);
      await hooks.tool!.hive_constraints_set.execute({ constraints: CONSTRAINTS }, createToolContext('sess_worker_ref'));
      const prompt = 'Follow instructions in @.hive/features/01_demo/tasks/01-first-task/worker-prompt.md';

      const args = await runTaskHook(hooks, 'sess_worker_ref', {
        subagent_type: 'forager-worker',
        prompt,
      });

      expect(args.prompt).toBe(prompt);
    });

    it('keeps the register scoped to the session that set it', async () => {
      const hooks = await loadHooks(testRoot);
      await hooks.tool!.hive_constraints_set.execute({ constraints: CONSTRAINTS }, createToolContext('sess_owner'));

      const args = await runTaskHook(hooks, 'sess_other', {
        subagent_type: 'forager-worker',
        prompt: 'Do the work.',
      });

      expect(args.prompt).toBe('Do the work.');
    });

    it('falls back to the parent register for a task-created architect child launching a planning helper', async () => {
      const hooks = await loadHooks(testRoot);
      // Architect task targets are only populated once the config hook runs.
      await hooks.config?.({} as never);
      await hooks.tool!.hive_constraints_set.execute({ constraints: CONSTRAINTS }, createToolContext('sess_architect_primary'));
      await hooks['chat.message']?.(
        { sessionID: 'sess_architect_child', agent: 'architect-planner' } as never,
        { message: { agent: 'architect-planner' }, parts: [] } as never,
      );

      const args = await runTaskHook(hooks, 'sess_architect_child', {
        subagent_type: 'scout-researcher',
        prompt: 'Research the parser conventions.',
      });

      expect(args.prompt).toBe(`Research the parser conventions.\n\n${CONSTRAINTS_BLOCK}`);
    });
  });

  describe('worker prompt file', () => {
    it('carries the register into the generated worker prompt and leaves it out when unset', async () => {
      initGitRoot(testRoot);
      const hooks = await loadHooks(testRoot);
      const toolContext = createToolContext('sess_worktree_start');

      const startWorkerPrompt = async (feature: string): Promise<{ launchPrompt: string; workerPrompt: string }> => {
        const plan = `# ${feature}

## Discovery

**Q: Is this a test?**
A: Yes, this integration test checks that operator standing constraints reach the generated worker prompt file.

## Tasks

### 1. First Task
Do it
`;
        await hooks.tool!.hive_feature_create.execute({ name: feature }, toolContext);
        await hooks.tool!.hive_plan_write.execute({ content: plan, feature }, toolContext);
        await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
        await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);

        const started = parseToolJson<{ taskToolCall?: { prompt?: string } }>(
          await hooks.tool!.hive_worktree_start.execute({ feature, task: '01-first-task' }, toolContext),
        );
        const launchPrompt = started.taskToolCall!.prompt!;
        const workerPromptPath = path.join(testRoot, launchPrompt.replace('Follow instructions in @', ''));
        return { launchPrompt, workerPrompt: fs.readFileSync(workerPromptPath, 'utf-8') };
      };

      const unset = await startWorkerPrompt('constraint-unset-feature');
      expect(unset.workerPrompt).not.toContain(STANDING_CONSTRAINTS_HEADING);

      await hooks.tool!.hive_constraints_set.execute({ constraints: CONSTRAINTS }, toolContext);
      const set = await startWorkerPrompt('constraint-set-feature');

      expect(set.workerPrompt).toContain(CONSTRAINTS_BLOCK);

      // The launch prompt is a file reference, so the hook must not duplicate the block.
      const args = await runTaskHook(hooks, 'sess_worktree_start', {
        subagent_type: 'forager-worker',
        prompt: set.launchPrompt,
      });
      expect(args.prompt).toBe(set.launchPrompt);
    });
  });

  describe('background correlation', () => {
    it('matches the pending launch against the pre-injection prompt snapshot', async () => {
      process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
      initGitRoot(testRoot);
      const hooks = await loadHooks(testRoot);
      const sessionID = 'sess_background_correlation';
      const toolContext = createToolContext(sessionID);

      await hooks['chat.message']?.(
        { sessionID, agent: 'hive-builder' } as never,
        { message: {}, parts: [] } as never,
      );
      await hooks.tool!.hive_constraints_set.execute({ constraints: CONSTRAINTS }, toolContext);

      const created = parseToolJson<{
        runId?: string;
        backgroundTaskCall?: { description?: string; prompt?: string; subagent_type?: string };
      }>(await hooks.tool!.hive_adhoc_worktree_create.execute(
        { label: 'constraint-run', autoSpawnWorker: true },
        toolContext,
      ));

      const expectedPrompt = created.backgroundTaskCall!.prompt!;
      const boardPath = path.join(testRoot, '.hive', 'background-jobs.json');
      const pendingBoard = JSON.parse(fs.readFileSync(boardPath, 'utf-8')) as {
        pendingLaunches?: Array<{ expectedPrompt?: string }>;
      };
      expect(pendingBoard.pendingLaunches?.[0]?.expectedPrompt).toBe(expectedPrompt);

      const launchArgs: Record<string, unknown> = {
        background: true,
        subagent_type: created.backgroundTaskCall!.subagent_type,
        description: created.backgroundTaskCall!.description,
        prompt: expectedPrompt,
      };
      const output = { args: launchArgs };
      await hooks['tool.execute.before']?.(
        { tool: 'task', sessionID, callID: 'call_background_launch' } as never,
        output as never,
      );

      // The register is injected for the model, after the adapter snapshot.
      expect(output.args.prompt).toBe(`${expectedPrompt}\n\n${CONSTRAINTS_BLOCK}`);

      await hooks['tool.execute.after']?.(
        { tool: 'task', sessionID, callID: 'call_background_launch' } as never,
        { title: 'task', output: 'task_id: task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2', metadata: {} } as never,
      );

      const board = JSON.parse(fs.readFileSync(boardPath, 'utf-8')) as {
        jobs: Array<{ taskId: string; scopeSource?: string; scope?: { adHocRunId?: string } }>;
        pendingLaunches?: unknown[];
      };
      const job = board.jobs.find((entry) => entry.taskId === 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2');
      expect(job?.scopeSource).toBe('pending-launch');
      expect(job?.scope?.adHocRunId).toBe(created.runId);
      expect(board.pendingLaunches ?? []).toHaveLength(0);
    });
  });
});
