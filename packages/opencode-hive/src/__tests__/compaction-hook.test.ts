import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { SessionService } from 'hive-core';
import plugin from '../index.js';

const TEST_ROOT = `/tmp/hive-compaction-test-${process.pid}`;
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

async function harness(parents: Map<string, string>) {
  const base = CLIENT as any;
  const client = {
    ...base,
    session: {
      ...base.session,
      get: async ({ path: inputPath }: { path: { id: string } }) => ({
        data: { id: inputPath.id, parentID: parents.get(inputPath.id), time: { created: Date.now(), updated: Date.now() } },
      }),
      update: async () => ({ data: {} }),
    },
  } as PluginInput['client'];
  return plugin({
    directory: TEST_ROOT,
    worktree: TEST_ROOT,
    serverUrl: new URL('http://localhost:1'),
    project: { id: 'test', worktree: TEST_ROOT, time: { created: Date.now() } },
    client,
    $: shell(),
  });
}

function context(sessionID: string, agent: string) {
  return { sessionID, messageID: 'message', agent, abort: new AbortController().signal };
}

function messages(sessionID: string) {
  const now = Date.now();
  return { messages: [
    {
      info: { id: 'summary', sessionID, role: 'assistant', time: { created: now }, summary: true },
      parts: [{ id: 'summary-part', sessionID, messageID: 'summary', type: 'text', text: 'Compacted summary.' }],
    },
    {
      info: { id: 'continue', sessionID, role: 'user', time: { created: now } },
      parts: [{ id: 'continue-part', sessionID, messageID: 'continue', type: 'text', text: 'Continue if you have next steps.', synthetic: true }],
    },
  ] };
}

async function seedFeature(hooks: Awaited<ReturnType<typeof plugin>>, parentContext: ReturnType<typeof context>, feature: string): Promise<void> {
  const plan = `# ${feature}

## Discovery

**Q: Is compaction recovery ready?**
A: Yes. The worker retains authenticated execution scope and receives a fresh live context catalog without replaying generated assignment prose.

Interview summary: this fixture exercises feature-scoped context authorization and compaction in one attached worker session.

## Tasks

### 1. First Task
Implement it.
`;
  await hooks.tool!.hive_feature_create.execute({ name: feature }, parentContext);
  await hooks.tool!.hive_plan_write.execute({ feature, content: plan }, parentContext);
  await hooks.tool!.hive_plan_approve.execute({ feature }, parentContext);
  await hooks.tool!.hive_tasks_sync.execute({ feature }, parentContext);
  await hooks.tool!.hive_context_write.execute({
    feature,
    name: 'compaction-scope',
    content: '---\ndescription: Compaction scope\nread_when: Test compaction\n---\n\nScoped content.',
  }, parentContext);
}

async function attachWorker(
  hooks: Awaited<ReturnType<typeof plugin>>,
  parents: Map<string, string>,
  parent = 'parent',
  child = 'child',
): Promise<void> {
  const live = path.join(TEST_ROOT, 'live');
  fs.mkdirSync(live, { recursive: true });
  await hooks.tool!.hive_execution_prepare.execute({
    scope: { kind: 'task', feature: 'feature-a', task: '01-first-task' },
    placement: { kind: 'in_place', directory: live },
  }, context(parent, 'hive-master'));
  const args = { subagent_type: 'forager-worker', description: 'Implement', prompt: 'Use the scoped context.' };
  await hooks['tool.execute.before']!({ tool: 'task', sessionID: parent, callID: 'call-worker' }, { args });
  parents.set(child, parent);
  await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: child, parentID: parent } } } } as any);
  await hooks.event?.({ event: { type: 'message.part.updated', properties: { part: {
    type: 'tool', tool: 'task', sessionID: parent, callID: 'call-worker',
    state: { input: args, metadata: { sessionId: child } },
  } } } } as any);
  await hooks['chat.message']?.({ sessionID: child, agent: 'forager-worker' }, {
    message: { agent: 'forager-worker' }, parts: [],
  } as any);
}

describe('compaction with authenticated execution scope', () => {
  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    execSync('git init', { cwd: TEST_ROOT, stdio: 'ignore' });
    execSync('git config user.email test@example.com', { cwd: TEST_ROOT });
    execSync('git config user.name Test', { cwd: TEST_ROOT });
    fs.writeFileSync(path.join(TEST_ROOT, 'README.md'), 'test\n');
    execSync('git add README.md && git commit -m init', { cwd: TEST_ROOT, stdio: 'ignore' });
  });

  afterEach(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

  it('does not register the unsupported experimental compaction hook', async () => {
    const hooks = await harness(new Map());
    expect(hooks['experimental.session.compacting']).toBeUndefined();
  });

  it('preserves primary directive replay independently of worker assignment replay', async () => {
    const hooks = await harness(new Map());
    await hooks['chat.message']?.({ sessionID: 'primary', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [{ type: 'text', text: 'Finish the task.' }],
    } as any);
    new SessionService(TEST_ROOT).trackGlobal('primary', {
      directivePrompt: 'Finish the task.',
      directiveRecoveryState: 'available',
      replayDirectivePending: false,
    });
    await hooks.event?.({ event: { type: 'session.compacted', properties: { sessionID: 'primary' } } } as any);
    const output = messages('primary');
    await hooks['experimental.chat.messages.transform']?.({}, output as any);
    const text = output.messages.flatMap(message => message.parts).map(part => part.text).join('\n');
    expect(text).toContain('Finish the task.');
    expect(text).not.toContain('immutable assignment');
  });

  it('refreshes the live feature catalog after compaction without replaying generated assignments', async () => {
    const parents = new Map<string, string>();
    const hooks = await harness(parents);
    await hooks['chat.message']?.({ sessionID: 'parent', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    } as any);
    await seedFeature(hooks, context('parent', 'hive-master'), 'feature-a');
    await attachWorker(hooks, parents);
    await hooks.event?.({ event: { type: 'session.compacted', properties: { sessionID: 'child' } } } as any);
    const output = messages('child');
    await hooks['experimental.chat.messages.transform']?.({}, output as any);
    const text = output.messages.flatMap(message => message.parts).map(part => part.text).join('\n');
    expect(text).toContain('[hive-live-context-catalog/v1]');
    expect(text).toContain('compaction-scope');
    expect(text).not.toContain('Post-compaction recovery: replaying');
  });

  it('retains execution-scoped context authorization across plugin restart and compaction', async () => {
    const parents = new Map<string, string>();
    const first = await harness(parents);
    await first['chat.message']?.({ sessionID: 'parent', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    } as any);
    await seedFeature(first, context('parent', 'hive-master'), 'feature-a');
    await attachWorker(first, parents);

    const restarted = await harness(parents);
    await restarted.event?.({ event: { type: 'session.updated', properties: { info: { id: 'child', parentID: 'parent' } } } } as any);
    await restarted['chat.message']?.({ sessionID: 'child', agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    await restarted.event?.({ event: { type: 'session.compacted', properties: { sessionID: 'child' } } } as any);
    const allowed = JSON.parse(await restarted.tool!.hive_context_read.execute(
      { name: 'compaction-scope' },
      context('child', 'forager-worker'),
    ) as string);
    expect(allowed.success).toBe(true);
    const denied = JSON.parse(await restarted.tool!.hive_context_read.execute(
      { feature: 'other-feature', name: 'compaction-scope' },
      context('child', 'forager-worker'),
    ) as string);
    expect(denied.reason).toBe('context_binding_mismatch');
  });
});
