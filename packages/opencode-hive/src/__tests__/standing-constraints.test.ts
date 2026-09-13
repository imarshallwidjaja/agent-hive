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
import { SessionService } from 'hive-core';
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
(OPENCODE_CLIENT.session as unknown as { update: (input: any) => Promise<unknown> }).update = async (input) => ({
  data: {
    id: input.path.id,
    parentID: SESSION_PARENTS[input.path.id],
    projectID: 'test',
    directory: '/tmp',
    title: input.body?.title ?? 'Primary test session',
    metadata: input.body?.metadata,
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

  describe('constraint register tools', () => {
    it('does not expose the removed whole-register replacement tool', async () => {
      const hooks = await loadHooks(testRoot);
      expect(hooks.tool!.hive_constraints_set).toBeUndefined();
    });

    it('adds verbatim constraints without replacing entries and makes identical adds idempotent', async () => {
      const hooks = await loadHooks(testRoot);
      const toolContext = createToolContext('sess_add');

      const result = parseToolJson<{
        success?: boolean;
        revision?: number;
        constraints?: string;
        constraintsChars?: number;
        entries?: Array<{ id: string; text: string }>;
      }>(await hooks.tool!.hive_constraints_add.execute(
        { constraints: CONSTRAINTS },
        toolContext,
      ));

      expect(result.success).toBe(true);
      expect(result.revision).toBe(1);
      expect(result.constraints).toBe(CONSTRAINTS);
      expect(result.constraintsChars).toBe(CONSTRAINTS.length);
      expect(result.entries).toHaveLength(1);

      const second = parseToolJson<{ revision: number; constraints: string; entries: Array<{ id: string; text: string }> }>(
        await hooks.tool!.hive_constraints_add.execute({ constraints: 'Use Australian English.' }, toolContext),
      );
      expect(second.revision).toBe(2);
      expect(second.constraints).toBe(`${CONSTRAINTS}\n\nUse Australian English.`);
      expect(second.entries.map((entry) => entry.text)).toEqual([CONSTRAINTS, 'Use Australian English.']);

      const duplicate = parseToolJson<{ revision: number; entries: Array<{ id: string; text: string }> }>(
        await hooks.tool!.hive_constraints_add.execute({ constraints: CONSTRAINTS }, toolContext),
      );
      expect(duplicate.revision).toBe(2);
      expect(duplicate.entries).toEqual(second.entries);

      const sessions = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'sessions.json'), 'utf-8')) as {
        sessions: Array<{ sessionId: string; standingConstraints?: string; standingConstraintsRevision?: number }>;
      };
      const stored = sessions.sessions.find((session) => session.sessionId === 'sess_add');
      expect(stored?.standingConstraints).toBe(`${CONSTRAINTS}\n\nUse Australian English.`);
      expect(stored?.standingConstraintsRevision).toBe(2);
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
      }>(await hooks.tool!.hive_constraints_add.execute(
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
        subagent_type: 'scout-researcher',
        prompt: 'Do the work.',
      });
      expect(args.prompt).toBe('Do the work.');
    });

    it('accepts constraints exactly at the cap', async () => {
      const hooks = await loadHooks(testRoot);
      const atCap = 'C'.repeat(8000);

      const result = parseToolJson<{ success?: boolean; constraintsChars?: number }>(
        await hooks.tool!.hive_constraints_add.execute({ constraints: atCap }, createToolContext('sess_at_cap')),
      );

      expect(result.success).toBe(true);
      expect(result.constraintsChars).toBe(8000);
    });

    it('rejects blank additions and edits, removes explicitly, and clears only with a current revision', async () => {
      const hooks = await loadHooks(testRoot);
      const toolContext = createToolContext('sess_clear');

      const blankAdd = parseToolJson<{ success: boolean; reason: string }>(
        await hooks.tool!.hive_constraints_add.execute({ constraints: '  \n ' }, toolContext),
      );
      expect(blankAdd.success).toBe(false);
      expect(blankAdd.reason).toBe('blank_constraint');

      const added = parseToolJson<{ revision: number; entries: Array<{ id: string; text: string }> }>(
        await hooks.tool!.hive_constraints_add.execute({ constraints: CONSTRAINTS }, toolContext),
      );
      const before = await runTaskHook(hooks, 'sess_clear', {
        subagent_type: 'scout-researcher',
        prompt: 'Do the work.',
      });
      expect(before.prompt).toContain(STANDING_CONSTRAINTS_HEADING);

      const blankEdit = parseToolJson<{ success: boolean; reason: string }>(
        await hooks.tool!.hive_constraints_edit.execute({ id: added.entries[0]!.id, expectedRevision: added.revision, constraints: '' }, toolContext),
      );
      expect(blankEdit.success).toBe(false);
      expect(blankEdit.reason).toBe('blank_constraint');

      const removed = parseToolJson<{ success: boolean; revision: number; entries: unknown[] }>(
        await hooks.tool!.hive_constraints_edit.execute({ id: added.entries[0]!.id, expectedRevision: added.revision, remove: true }, toolContext),
      );
      expect(removed.success).toBe(true);
      expect(removed.revision).toBe(2);
      expect(removed.entries).toEqual([]);

      const afterEmpty = await runTaskHook(hooks, 'sess_clear', {
        subagent_type: 'scout-researcher',
        prompt: 'Do the work.',
      });
      expect(afterEmpty.prompt).toBe('Do the work.');

      const readded = parseToolJson<{ revision: number }>(
        await hooks.tool!.hive_constraints_add.execute({ constraints: CONSTRAINTS }, toolContext),
      );
      const stale = parseToolJson<{ success: boolean; reason: string; revision: number }>(
        await hooks.tool!.hive_constraints_clear.execute({ expectedRevision: removed.revision }, toolContext),
      );
      expect(stale.success).toBe(false);
      expect(stale.reason).toBe('stale_revision');
      expect(stale.revision).toBe(readded.revision);

      const cleared = parseToolJson<{ success: boolean; revision: number; entries: unknown[] }>(
        await hooks.tool!.hive_constraints_clear.execute({ expectedRevision: readded.revision }, toolContext),
      );
      expect(cleared.success).toBe(true);
      expect(cleared.entries).toEqual([]);

      const afterWs = await runTaskHook(hooks, 'sess_clear', {
        subagent_type: 'scout-researcher',
        prompt: 'Do the work.',
      });
      expect(afterWs.prompt).toBe('Do the work.');
    });

    it('edits only the targeted entry and rejects stale revisions and missing IDs without changing state', async () => {
      const hooks = await loadHooks(testRoot);
      const toolContext = createToolContext('sess_edit');
      await hooks.tool!.hive_constraints_add.execute({ constraints: 'A' }, toolContext);
      const before = parseToolJson<{ revision: number; entries: Array<{ id: string; text: string }> }>(
        await hooks.tool!.hive_constraints_add.execute({ constraints: 'B' }, toolContext),
      );

      const edited = parseToolJson<{ revision: number; constraints: string; entries: Array<{ id: string; text: string }> }>(
        await hooks.tool!.hive_constraints_edit.execute({ id: before.entries[1]!.id, expectedRevision: before.revision, constraints: 'B corrected' }, toolContext),
      );
      expect(edited.constraints).toBe('A\n\nB corrected');
      expect(edited.entries[0]).toEqual(before.entries[0]);

      const stale = parseToolJson<{ success: boolean; reason: string }>(
        await hooks.tool!.hive_constraints_edit.execute({ id: before.entries[0]!.id, expectedRevision: before.revision, constraints: 'A stale' }, toolContext),
      );
      expect(stale.reason).toBe('stale_revision');
      const missing = parseToolJson<{ success: boolean; reason: string }>(
        await hooks.tool!.hive_constraints_edit.execute({ id: 'missing', expectedRevision: edited.revision, remove: true }, toolContext),
      );
      expect(missing.reason).toBe('constraint_not_found');

      const after = parseToolJson<{ revision: number; constraints: string }>(
        await hooks.tool!.hive_constraints_read.execute({}, toolContext),
      );
      expect(after).toMatchObject({ revision: edited.revision, constraints: 'A\n\nB corrected' });
    });
  });

  describe('task dispatch hook', () => {
    it('leaves the task prompt byte-identical when no register is set', async () => {
      const hooks = await loadHooks(testRoot);
      const prompt = 'Implement the parser and report verification evidence.';

      const args = await runTaskHook(hooks, 'sess_empty_state', {
        subagent_type: 'scout-researcher',
        description: 'Hive: parser',
        prompt,
      });

      expect(args.prompt).toBe(prompt);
      expect(args.prompt).not.toContain(STANDING_CONSTRAINTS_HEADING);
    });

    it('appends the block for ordinary research and reviewer targets', async () => {
      const hooks = await loadHooks(testRoot);
      await hooks.tool!.hive_constraints_add.execute({ constraints: CONSTRAINTS }, createToolContext('sess_ordinary'));

      for (const target of ['code-reviewer', 'simplicity-reviewer', 'scout-researcher']) {
        const args = await runTaskHook(hooks, 'sess_ordinary', {
          subagent_type: target,
          prompt: 'Do the work.',
        });
        expect(args.prompt, target).toBe(`Do the work.\n\n${CONSTRAINTS_BLOCK}`);
      }
    });

    it('appends the block when the launch has no prior prompt text', async () => {
      const hooks = await loadHooks(testRoot);
      await hooks.tool!.hive_constraints_add.execute({ constraints: CONSTRAINTS }, createToolContext('sess_no_prompt'));

      const args = await runTaskHook(hooks, 'sess_no_prompt', { subagent_type: 'scout-researcher' });

      expect(args.prompt).toBe(CONSTRAINTS_BLOCK);
    });

    it('does not append for dash review or vulnerability review lane targets', async () => {
      const hooks = await loadHooks(testRoot);
      const lanes = await resolveLaneTargets(hooks);
      await hooks.tool!.hive_constraints_add.execute({ constraints: CONSTRAINTS }, createToolContext('sess_lanes'));

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
      await hooks.tool!.hive_constraints_add.execute({ constraints: CONSTRAINTS }, createToolContext('sess_idempotent'));

      const first = await runTaskHook(hooks, 'sess_idempotent', {
        subagent_type: 'scout-researcher',
        prompt: 'Do the work.',
      });
      const second = await runTaskHook(hooks, 'sess_idempotent', {
        subagent_type: 'scout-researcher',
        prompt: first.prompt,
      });

      expect(second.prompt).toBe(first.prompt);
      expect((second.prompt as string).split(STANDING_CONSTRAINTS_HEADING)).toHaveLength(2);
    });

    it('does not append to a Hive worker-prompt file reference', async () => {
      const hooks = await loadHooks(testRoot);
      await hooks.tool!.hive_constraints_add.execute({ constraints: CONSTRAINTS }, createToolContext('sess_worker_ref'));
      const prompt = 'Follow instructions in @.hive/features/01_demo/tasks/01-first-task/worker-prompt.md';

      const args = await runTaskHook(hooks, 'sess_worker_ref', {
        subagent_type: 'scout-researcher',
        prompt,
      });

      expect(args.prompt).toBe(prompt);
    });

    it('keeps the register scoped to the session that set it', async () => {
      const hooks = await loadHooks(testRoot);
      await hooks.tool!.hive_constraints_add.execute({ constraints: CONSTRAINTS }, createToolContext('sess_owner'));

      const args = await runTaskHook(hooks, 'sess_other', {
        subagent_type: 'scout-researcher',
        prompt: 'Do the work.',
      });

      expect(args.prompt).toBe('Do the work.');
    });

    it('falls back to the parent register for a task-created architect child launching a planning helper', async () => {
      const hooks = await loadHooks(testRoot);
      // Architect task targets are only populated once the config hook runs.
      await hooks.config?.({} as never);
      await hooks.tool!.hive_constraints_add.execute({ constraints: CONSTRAINTS }, createToolContext('sess_architect_primary'));
      await hooks.event?.({ event: { type: 'session.created', properties: {
        info: { id: 'sess_architect_child', parentID: 'sess_architect_primary' },
      } } } as any);
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
      await hooks['chat.message']?.(
        { sessionID: 'sess_worktree_start', agent: 'hive-master' } as never,
        { message: {}, parts: [] } as never,
      );

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

      await hooks.tool!.hive_constraints_add.execute({ constraints: CONSTRAINTS }, toolContext);
      const set = await startWorkerPrompt('constraint-set-feature');

      expect(set.workerPrompt).toContain(CONSTRAINTS_BLOCK);

      expect(set.launchPrompt).toContain('/assignments/attempt-1.md');
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
      await hooks.tool!.hive_constraints_add.execute({ constraints: CONSTRAINTS }, toolContext);

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

      await hooks.event?.({ event: {
        type: 'session.created',
        properties: { info: { id: 'adhoc-child', parentID: sessionID } },
      } } as never);
      await hooks.event?.({ event: { type: 'message.part.updated', properties: { part: {
        type: 'tool',
        tool: 'task',
        sessionID,
        callID: 'call_background_launch',
        state: { input: output.args, metadata: { sessionId: 'adhoc-child' } },
      } } } } as never);
      await hooks['chat.message']?.(
        { sessionID: 'adhoc-child', agent: created.backgroundTaskCall!.subagent_type } as never,
        { message: { agent: created.backgroundTaskCall!.subagent_type }, parts: [] } as never,
      );

      await hooks['tool.execute.after']?.(
        { tool: 'task', sessionID, callID: 'call_background_launch' } as never,
        { title: 'task', output: 'task_id: task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2', metadata: { sessionId: 'adhoc-child' } } as never,
      );

      const board = JSON.parse(fs.readFileSync(boardPath, 'utf-8')) as {
        jobs: Array<{ taskId: string; scopeSource?: string; scope?: { adHocRunId?: string } }>;
        pendingLaunches?: unknown[];
      };
      const job = board.jobs.find((entry) => entry.taskId === 'task_01JZ8WQY8M7ZTV5MS9Y4Y8Q6A2');
      expect(job?.scopeSource).toBe('pending-launch');
      expect(job?.scope?.adHocRunId).toBe(created.runId);
      expect(board.pendingLaunches ?? []).toHaveLength(0);
      expect(new SessionService(testRoot).getGlobal('adhoc-child')).toMatchObject({
        parentSessionId: sessionID,
        projectRoot: testRoot,
        adHocRunId: created.runId,
        sessionKind: 'task-worker',
      });
    });
  });
});
