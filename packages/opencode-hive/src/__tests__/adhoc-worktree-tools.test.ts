import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { AdhocWorktreeService, ExecutionAttemptService } from 'hive-core';
import plugin from '../index.js';

const TEST_ROOT = `/tmp/opencode-hive-execution-prepare-${process.pid}`;
const CLIENT = createOpencodeClient({ baseUrl: 'http://localhost:1' }) as unknown as PluginInput['client'];

function shell(): PluginInput['$'] {
  let value: PluginInput['$'];
  const fn = (() => { throw new Error('shell unavailable'); }) as unknown as PluginInput['$'];
  value = Object.assign(fn, {
    braces: (pattern: string) => [pattern],
    escape: (input: string) => input,
    env: () => value,
    cwd: () => value,
    nothrow: () => value,
    throws: () => value,
  });
  return value;
}

async function hooksFor(root: string, sessionID: string) {
  const client = {
    ...(CLIENT as any),
    session: {
      ...(CLIENT as any).session,
      get: async ({ path: inputPath }: { path: { id: string } }) => ({
        data: { id: inputPath.id, parentID: undefined, time: { created: Date.now(), updated: Date.now() } },
      }),
    },
  } as PluginInput['client'];
  const hooks = await plugin({
    directory: root,
    worktree: root,
    serverUrl: new URL('http://localhost:1'),
    project: { id: 'test', worktree: root, time: { created: Date.now() } },
    client,
    $: shell(),
  });
  await hooks['chat.message']?.({ sessionID, agent: 'hive-master' }, {
    message: { agent: 'hive-master' }, parts: [],
  } as any);
  return {
    hooks,
    context: {
      sessionID,
      messageID: 'message',
      agent: 'hive-master',
      abort: new AbortController().signal,
    },
  };
}

function initGit(root: string): void {
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email test@example.com', { cwd: root });
  execSync('git config user.name Test', { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'test\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.hive/\n');
  execSync('git add README.md .gitignore && git commit -m init', { cwd: root, stdio: 'ignore' });
}

describe('hive_execution_prepare ad-hoc placement', () => {
  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

  it('creates and arms a Git worktree without generating native task arguments', async () => {
    initGit(TEST_ROOT);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-worktree');
    const result = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'run-worktree' },
      placement: { kind: 'worktree' },
    }, context) as string);

    expect(result).toMatchObject({
      success: true,
      scope: { kind: 'adhoc', runId: 'run-worktree' },
      placement: { kind: 'worktree' },
      phase: 'armed',
    });
    expect(result.attemptId).toEqual(expect.any(String));
    expect(result.expiresAt).toEqual(expect.any(String));
    expect(result).not.toHaveProperty('taskToolCall');
    expect(result).not.toHaveProperty('backgroundTaskCall');
    expect(result).not.toHaveProperty('launchId');
  });

  it('arms an explicit live non-Git directory without creating an exclusion claim', async () => {
    const liveDirectory = path.join(TEST_ROOT, 'live');
    fs.mkdirSync(liveDirectory);
    const first = await hooksFor(TEST_ROOT, 'primary-a');
    const second = await hooksFor(TEST_ROOT, 'primary-b');

    const firstResult = JSON.parse(await first.hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'live-a' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, first.context) as string);
    const secondResult = JSON.parse(await second.hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'live-b' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, second.context) as string);

    expect(firstResult.placement).toEqual({ kind: 'in_place', directory: fs.realpathSync(liveDirectory) });
    expect(secondResult.success).toBe(true);
  });

  it('refuses a second outstanding arm before creating its worktree resources', async () => {
    initGit(TEST_ROOT);
    const liveDirectory = path.join(TEST_ROOT, 'live');
    fs.mkdirSync(liveDirectory);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-one-arm');
    await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'first' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, context);

    const branchesBefore = execSync('git branch --format="%(refname:short)"', { cwd: TEST_ROOT, encoding: 'utf8' });
    const worktreesBefore = execSync('git worktree list --porcelain', { cwd: TEST_ROOT, encoding: 'utf8' });

    await expect(hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'second' },
      placement: { kind: 'worktree' },
    }, context)).rejects.toThrow(/already has an armed execution/i);

    const adhocWorktrees = new AdhocWorktreeService({
      baseDir: TEST_ROOT,
      hiveDir: path.join(TEST_ROOT, '.hive'),
      repositoryResolver: { resolveRepositories: () => [] },
    });
    expect(await adhocWorktrees.get('second')).toBeNull();
    expect(execSync('git branch --format="%(refname:short)"', { cwd: TEST_ROOT, encoding: 'utf8' })).toBe(branchesBefore);
    expect(execSync('git worktree list --porcelain', { cwd: TEST_ROOT, encoding: 'utf8' })).toBe(worktreesBefore);
    expect(new ExecutionAttemptService(TEST_ROOT).listAttempts()).toHaveLength(1);
  });

  it('denies another primary access to the same armed scope', async () => {
    const liveDirectory = path.join(TEST_ROOT, 'live');
    fs.mkdirSync(liveDirectory);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-owner');
    await hooks['chat.message']?.({ sessionID: 'primary-other', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    } as any);
    const otherContext = { ...context, sessionID: 'primary-other' };
    const first = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'owned-scope' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, context) as string);
    const repeated = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'owned-scope' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, context) as string);
    expect(repeated).toMatchObject({ success: true, existing: true, attemptId: first.attemptId });

    const denied = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'owned-scope' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, otherContext) as string);
    expect(denied).toMatchObject({
      success: false,
      reason: 'workspace_conflict_denied',
      attemptId: first.attemptId,
      phase: 'armed',
    });
  });

  it('fences armed ad-hoc commits and releases the workspace after finalization', async () => {
    initGit(TEST_ROOT);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-armed');
    const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'armed-fence' },
      placement: { kind: 'worktree' },
    }, context) as string);
    fs.writeFileSync(path.join(prepared.placement.workspacePath, 'armed.txt'), 'armed\n');
    const headBefore = execSync('git rev-parse HEAD', { cwd: prepared.placement.workspacePath, encoding: 'utf8' }).trim();

    const denied = JSON.parse(await hooks.tool!.hive_adhoc_worktree_commit.execute({
      runId: 'armed-fence',
      workspacePath: prepared.placement.workspacePath,
      branch: prepared.placement.branch,
      message: 'test: reject armed mutation\n\nProve that an armed execution retains its writer fence.',
    }, context) as string);
    expect(denied).toMatchObject({ success: false, reason: 'workspace_conflict_denied', mutation: 'none' });
    expect(execSync('git rev-parse HEAD', { cwd: prepared.placement.workspacePath, encoding: 'utf8' }).trim()).toBe(headBefore);

    expect(new ExecutionAttemptService(TEST_ROOT).getAttempt(prepared.attemptId)).toMatchObject({
      phase: 'finalized',
      observedOutcome: 'not_started',
    });
    const committed = JSON.parse(await hooks.tool!.hive_adhoc_worktree_commit.execute({
      runId: 'armed-fence',
      workspacePath: prepared.placement.workspacePath,
      branch: prepared.placement.branch,
      message: 'test: commit after finalized arm\n\nConfirm finalization releases the exact workspace fence.',
    }, context) as string);
    expect(committed.success).toBe(true);
  });

  it('fences stopped ad-hoc commits even for the bound child and releases after finalization', async () => {
    initGit(TEST_ROOT);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-stopped');
    const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'stopped-fence' },
      placement: { kind: 'worktree' },
    }, context) as string);
    const args = { subagent_type: 'forager-worker', description: 'Stop before commit', prompt: 'Do it.', background: false };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: context.sessionID, callID: 'call-stopped' }, { args });
    const attempts = new ExecutionAttemptService(TEST_ROOT);
    attempts.bindNativeChild({
      originatingPrimarySession: context.sessionID,
      nativeCallId: 'call-stopped',
      nativeChildSessionId: 'child-stopped',
    });
    attempts.observeBlockingStop({
      originatingPrimarySession: context.sessionID,
      nativeCallId: 'call-stopped',
      outputDefined: true,
    });
    fs.writeFileSync(path.join(prepared.placement.workspacePath, 'stopped.txt'), 'stopped\n');
    const headBefore = execSync('git rev-parse HEAD', { cwd: prepared.placement.workspacePath, encoding: 'utf8' }).trim();
    const childContext = { ...context, sessionID: 'child-stopped', agent: 'forager-worker' };

    const denied = JSON.parse(await hooks.tool!.hive_adhoc_worktree_commit.execute({
      runId: 'stopped-fence',
      workspacePath: prepared.placement.workspacePath,
      branch: prepared.placement.branch,
      message: 'test: reject stopped mutation\n\nProve that stop evidence alone does not release the workspace fence.',
    }, childContext) as string);
    expect(denied).toMatchObject({ success: false, reason: 'workspace_conflict_denied', mutation: 'none' });
    expect(execSync('git rev-parse HEAD', { cwd: prepared.placement.workspacePath, encoding: 'utf8' }).trim()).toBe(headBefore);

    attempts.finalize(prepared.attemptId, 'completed');
    const committed = JSON.parse(await hooks.tool!.hive_adhoc_worktree_commit.execute({
      runId: 'stopped-fence',
      workspacePath: prepared.placement.workspacePath,
      branch: prepared.placement.branch,
      message: 'test: commit after stopped finalization\n\nConfirm finalization releases the stopped workspace fence.',
    }, childContext) as string);
    expect(committed.success).toBe(true);
  });

  it('allows an attached ad-hoc handoff only from the exact bound child and placement', async () => {
    initGit(TEST_ROOT);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-attached-child');
    const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'attached-child' },
      placement: { kind: 'worktree' },
    }, context) as string);
    const args = { subagent_type: 'forager-worker', description: 'Commit from bound child', prompt: 'Do it.', background: false };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: context.sessionID, callID: 'call-attached-child' }, { args });
    const attempts = new ExecutionAttemptService(TEST_ROOT);
    attempts.bindNativeChild({
      originatingPrimarySession: context.sessionID,
      nativeCallId: 'call-attached-child',
      nativeChildSessionId: 'child-attached',
    });
    fs.writeFileSync(path.join(prepared.placement.workspacePath, 'attached.txt'), 'attached\n');
    const headBefore = execSync('git rev-parse HEAD', { cwd: prepared.placement.workspacePath, encoding: 'utf8' }).trim();
    const handoff = {
      runId: 'attached-child',
      workspacePath: prepared.placement.workspacePath,
      branch: prepared.placement.branch,
      message: 'test: authenticate ad-hoc handoff\n\nCommit only from the exact attached child.',
    };

    const denied = JSON.parse(await hooks.tool!.hive_adhoc_worktree_commit.execute(
      handoff,
      { ...context, sessionID: 'other-child', agent: 'forager-worker' },
    ) as string);
    expect(denied).toMatchObject({ success: false, reason: 'workspace_conflict_denied', mutation: 'none' });
    expect(execSync('git rev-parse HEAD', { cwd: prepared.placement.workspacePath, encoding: 'utf8' }).trim()).toBe(headBefore);

    const committed = JSON.parse(await hooks.tool!.hive_adhoc_worktree_commit.execute(
      handoff,
      { ...context, sessionID: 'child-attached', agent: 'forager-worker' },
    ) as string);
    expect(committed.success).toBe(true);
    expect(attempts.getAttempt(prepared.attemptId)).toMatchObject({ phase: 'attached', handoffOutcome: 'completed' });
  });

  it('attaches the unchanged native shape and appends truthful in-place scope', async () => {
    const liveDirectory = path.join(TEST_ROOT, 'live');
    fs.mkdirSync(liveDirectory);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-attach');
    const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'attach' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, context) as string);
    const args = {
      subagent_type: 'forager-worker',
      description: 'Edit live configuration',
      prompt: 'Make the requested edit.',
      background: false,
    };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: context.sessionID, callID: 'call-attach' }, { args });

    expect(Object.keys(args).sort()).toEqual(['background', 'description', 'prompt', 'subagent_type']);
    expect(args.prompt).toContain('Make the requested edit.');
    expect(args.prompt).toContain('## Hive execution scope');
    expect(args.prompt).toContain('live in-place directory');
    expect(args.prompt).toContain(fs.realpathSync(liveDirectory));
    expect(new ExecutionAttemptService(TEST_ROOT).getAttempt(prepared.attemptId)?.phase).toBe('attached');
  });

  it('does not register the removed preparation APIs or native schema hook', async () => {
    const { hooks } = await hooksFor(TEST_ROOT, 'primary-surface');
    expect(hooks.tool!.hive_worktree_start).toBeUndefined();
    expect(hooks.tool!.hive_worktree_create).toBeUndefined();
    expect(hooks.tool!.hive_adhoc_worktree_create).toBeUndefined();
    expect(hooks.tool!.hive_adhoc_worktree_start).toBeUndefined();
    expect(hooks['tool.definition']).toBeUndefined();
  });
});
