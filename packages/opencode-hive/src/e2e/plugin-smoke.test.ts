import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { ExecutionAttemptService } from 'hive-core';
import plugin from '../index.js';

const TEST_ROOT_BASE = `/tmp/hive-e2e-plugin-${process.pid}`;
const CLIENT = createOpencodeClient({ baseUrl: 'http://localhost:1' }) as unknown as PluginInput['client'];

type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  abort: AbortSignal;
};

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

function initGit(root: string): void {
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email test@example.com', { cwd: root });
  execSync('git config user.name Test', { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'test\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.hive/\n');
  execSync('git add README.md .gitignore && git commit -m init', { cwd: root, stdio: 'ignore' });
}

function plan(title: string): string {
  return `# ${title}

## Discovery

**Q: Is managed execution ready for this fixture?**
A: Yes. The task must use one prepared execution, one unchanged native Forager call, authenticated child scope, and structured stop evidence.

Interview summary: this integration fixture covers the operator-selected armed attachment contract, worktree placement, prompt augmentation, context authorization, and terminal observation without generated native task payloads.

**Research:** the plugin hook owns parent/call attachment while hive-core owns durable execution state and exact worktree claims.

## Tasks

### 1. First Task
Implement it.
`;
}

async function harness(root: string, parentSessionID: string) {
  const parents = new Map<string, string>();
  const baseClient = CLIENT as any;
  const client = {
    ...baseClient,
    session: {
      ...baseClient.session,
      get: async ({ path: inputPath }: { path: { id: string } }) => ({
        data: { id: inputPath.id, parentID: parents.get(inputPath.id), time: { created: Date.now(), updated: Date.now() } },
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
  await hooks['chat.message']?.({ sessionID: parentSessionID, agent: 'hive-master' }, {
    message: { agent: 'hive-master' }, parts: [],
  } as any);
  const context: ToolContext = {
    sessionID: parentSessionID,
    messageID: 'message',
    agent: 'hive-master',
    abort: new AbortController().signal,
  };
  return { hooks, context, parents };
}

async function seedFeature(hooks: Awaited<ReturnType<typeof plugin>>, context: ToolContext, feature: string): Promise<void> {
  await hooks.tool!.hive_feature_create.execute({ name: feature }, context);
  await hooks.tool!.hive_plan_write.execute({ content: plan(feature), feature }, context);
  await hooks.tool!.hive_plan_approve.execute({ feature }, context);
  await hooks.tool!.hive_tasks_sync.execute({ feature }, context);
}

async function prepareTask(
  hooks: Awaited<ReturnType<typeof plugin>>,
  context: ToolContext,
  feature: string,
  placement: Record<string, unknown> = { kind: 'worktree' },
) {
  return JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
    scope: { kind: 'task', feature, task: '01-first-task' },
    placement,
  }, context) as string);
}

async function bindChild(
  hooks: Awaited<ReturnType<typeof plugin>>,
  parents: Map<string, string>,
  parentSessionID: string,
  callID: string,
  childSessionID: string,
  agent = 'forager-worker',
): Promise<void> {
  parents.set(childSessionID, parentSessionID);
  await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: childSessionID, parentID: parentSessionID } } } } as any);
  await hooks.event?.({ event: { type: 'message.part.updated', properties: { part: {
    type: 'tool', tool: 'task', sessionID: parentSessionID, callID,
    state: { input: { subagent_type: agent }, metadata: { sessionId: childSessionID } },
  } } } } as any);
  await hooks['chat.message']?.({ sessionID: childSessionID, agent }, {
    message: { agent }, parts: [],
  } as any);
}

describe('managed execution attachment', () => {
  let root: string;
  let oldBackground: string | undefined;

  beforeEach(() => {
    oldBackground = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    root = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'project-'));
    initGit(root);
  });

  afterEach(() => {
    if (oldBackground === undefined) delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    else process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = oldBackground;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
  });

  it('prepares concise task placement and attaches an unchanged native call', async () => {
    const { hooks, context } = await harness(root, 'primary');
    await seedFeature(hooks, context, 'feature-a');
    const prepared = await prepareTask(hooks, context, 'feature-a');
    expect(prepared).toMatchObject({ success: true, phase: 'armed', scope: { kind: 'task', feature: 'feature-a', task: '01-first-task' } });
    expect(prepared).not.toHaveProperty('taskToolCall');
    expect(prepared).not.toHaveProperty('launchId');

    const args = { subagent_type: 'forager-worker', description: 'Implement task', prompt: 'Use the task spec.', background: false };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-a' }, { args });
    expect(Object.keys(args).sort()).toEqual(['background', 'description', 'prompt', 'subagent_type']);
    expect(args.prompt).toContain('Use the task spec.');
    expect(args.prompt).toContain('Feature: feature-a');
    expect(args.prompt).toContain('Task spec:');
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)?.phase).toBe('attached');
  });

  it('does not consume an arm for a non-Forager call and rejects a second Forager call', async () => {
    const { hooks, context } = await harness(root, 'primary');
    await seedFeature(hooks, context, 'feature-a');
    const prepared = await prepareTask(hooks, context, 'feature-a');
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-scout' }, {
      args: { subagent_type: 'scout-researcher', description: 'Inspect', prompt: 'Read only.' },
    });
    const persisted = JSON.parse(fs.readFileSync(path.join(root, '.hive', 'execution-attempts.json'), 'utf8'));
    expect(persisted.attempts.find((attempt: { id: string }) => attempt.id === prepared.attemptId).phase).toBe('armed');

    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-worker' }, {
      args: { subagent_type: 'forager-worker', description: 'Implement', prompt: 'Do it.' },
    });
    await expect(hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-worker-2' }, {
      args: { subagent_type: 'forager-worker', description: 'Duplicate', prompt: 'Do it again.' },
    })).rejects.toThrow(/no armed execution/i);
  });

  it('binds authenticated child scope for feature context and rejects cross-feature access', async () => {
    const { hooks, context, parents } = await harness(root, 'primary');
    await seedFeature(hooks, context, 'feature-a');
    await hooks.tool!.hive_context_write.execute({
      feature: 'feature-a', name: 'scope', content: '---\ndescription: Scope\nread_when: Test\n---\n\nA',
    }, context);
    await seedFeature(hooks, context, 'feature-b');
    await prepareTask(hooks, context, 'feature-a');
    const args = { subagent_type: 'forager-worker', description: 'Implement', prompt: 'Do it.' };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-context' }, { args });
    await bindChild(hooks, parents, 'primary', 'call-context', 'child-context');
    const childContext = { ...context, sessionID: 'child-context', agent: 'forager-worker' };

    const allowed = JSON.parse(await hooks.tool!.hive_context_read.execute({ name: 'scope' }, childContext) as string);
    expect(allowed.success).toBe(true);
    const denied = JSON.parse(await hooks.tool!.hive_context_read.execute({ feature: 'feature-b', name: 'scope' }, childContext) as string);
    expect(denied.reason).toBe('context_binding_mismatch');
  });

  it('injects current constraints despite caller-supplied headings and only once on repeated hook observation', async () => {
    const { hooks, context } = await harness(root, 'primary');
    await hooks.tool!.hive_constraints_add.execute({ constraints: 'Keep the operator wording verbatim.' }, context);
    const live = path.join(root, 'live');
    fs.mkdirSync(live);
    await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'constraints' }, placement: { kind: 'in_place', directory: live },
    }, context);
    const args = {
      subagent_type: 'forager-worker',
      description: 'Apply constraints',
      prompt: '## Standing Constraints (operator, session-wide)\n\nCaller spoof.',
    };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-constraints' }, { args });
    expect(args.prompt).toContain('Caller spoof.');
    expect(args.prompt).toContain('Keep the operator wording verbatim.');
    expect(args.prompt.match(/<!-- hive-standing-constraints:start -->/g)).toHaveLength(1);
  });

  it('keeps undefined blocking output attached and accepts defined output as stop evidence', async () => {
    const { hooks, context } = await harness(root, 'primary');
    const live = path.join(root, 'live');
    fs.mkdirSync(live);
    const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'blocking' }, placement: { kind: 'in_place', directory: live },
    }, context) as string);
    const args = { subagent_type: 'forager-worker', description: 'Implement', prompt: 'Do it.', background: false };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-blocking' }, { args });
    await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID: 'call-blocking', args } as any, undefined);
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)?.phase).toBe('attached');
    await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID: 'call-blocking', args } as any, { title: '', output: '', metadata: {} });
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)?.phase).toBe('stopped');
  });

  it('stops background execution only from a correlated completion notification', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const { hooks, context, parents } = await harness(root, 'primary');
    const live = path.join(root, 'live');
    fs.mkdirSync(live);
    const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'background' }, placement: { kind: 'in_place', directory: live },
    }, context) as string);
    const args = { subagent_type: 'forager-worker', description: 'Background work', prompt: 'Do it.', background: true };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-background' }, { args });
    await bindChild(hooks, parents, 'primary', 'call-background', 'task-background');
    await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID: 'call-background', args } as any, {
      title: '', output: 'task_id: task-background', metadata: { sessionId: 'task-background' },
    });
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)?.phase).toBe('attached');

    const messages = [{
      info: { id: 'message', sessionID: 'primary', role: 'user', time: { created: Date.now() } },
      parts: [{
        id: 'part', sessionID: 'primary', messageID: 'message', type: 'text',
        text: '<task id="task-background" state="completed"><summary>Done</summary><task_result>Complete.</task_result></task>',
      }],
    }];
    await hooks['experimental.chat.messages.transform']?.({}, { messages } as any);
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)?.phase).toBe('stopped');
  });

  it('closes an unattached arm on plugin restart and preserves an attached quarantine', async () => {
    const first = await harness(root, 'primary-a');
    const liveA = path.join(root, 'live-a');
    fs.mkdirSync(liveA);
    const arm = JSON.parse(await first.hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'unattached' }, placement: { kind: 'in_place', directory: liveA },
    }, first.context) as string);
    await harness(root, 'primary-restart');
    let persisted = JSON.parse(fs.readFileSync(path.join(root, '.hive', 'execution-attempts.json'), 'utf8'));
    expect(persisted.attempts.find((attempt: { id: string }) => attempt.id === arm.attemptId)).toMatchObject({ phase: 'finalized', observedOutcome: 'not_started' });

    const second = await harness(root, 'primary-b');
    const liveB = path.join(root, 'live-b');
    fs.mkdirSync(liveB);
    const attached = JSON.parse(await second.hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'attached' }, placement: { kind: 'in_place', directory: liveB },
    }, second.context) as string);
    await second.hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary-b', callID: 'call-attached' }, {
      args: { subagent_type: 'forager-worker', description: 'Attach', prompt: 'Do it.' },
    });
    await harness(root, 'primary-restart-2');
    persisted = JSON.parse(fs.readFileSync(path.join(root, '.hive', 'execution-attempts.json'), 'utf8'));
    expect(persisted.attempts.find((attempt: { id: string }) => attempt.id === attached.attemptId)?.phase).toBe('attached');
  });
});
