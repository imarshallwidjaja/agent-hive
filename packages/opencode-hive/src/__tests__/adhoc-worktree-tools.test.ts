import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { ExecutionAttemptService } from 'hive-core';
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

  it('refuses a second outstanding arm for the same parent', async () => {
    const liveDirectory = path.join(TEST_ROOT, 'live');
    fs.mkdirSync(liveDirectory);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-one-arm');
    await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'first' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, context);

    await expect(hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'second' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, context)).rejects.toThrow(/already has an armed execution/i);
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
