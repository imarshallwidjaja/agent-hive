import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { AdhocWorktreeService, ConfigService, ExecutionAttemptService, SessionService } from 'hive-core';
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

function configureForagerDerivative() {
  return spyOn(ConfigService.prototype, 'get').mockReturnValue({
    agents: {},
    customAgents: {
      'configured-forager': {
        baseAgent: 'forager-worker',
        description: 'Configured implementation worker',
      },
    },
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

  it('denies another primary before creating Git resources for the same feature task', async () => {
    const owner = await harness(root, 'primary-owner');
    await seedFeature(owner.hooks, owner.context, 'feature-a');
    const live = path.join(root, 'live-owner');
    fs.mkdirSync(live);
    const prepared = await prepareTask(owner.hooks, owner.context, 'feature-a', { kind: 'in_place', directory: live });
    const branchesBefore = execSync('git branch --format="%(refname:short)"', { cwd: root, encoding: 'utf8' });
    const worktreesBefore = execSync('git worktree list --porcelain', { cwd: root, encoding: 'utf8' });
    const attemptsPath = path.join(root, '.hive', 'execution-attempts.json');
    const attemptsBefore = fs.readFileSync(attemptsPath, 'utf8');
    const taskWorktreePath = path.join(root, '.hive', '.worktrees', 'feature-a', '01-first-task');
    await owner.hooks['chat.message']?.({ sessionID: 'primary-other', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    } as any);

    const denied = await prepareTask(owner.hooks, { ...owner.context, sessionID: 'primary-other' }, 'feature-a');

    expect(denied).toMatchObject({
      success: false,
      reason: 'workspace_conflict_denied',
      mutation: 'none',
      attemptId: prepared.attemptId,
      phase: 'armed',
    });
    expect(execSync('git branch --format="%(refname:short)"', { cwd: root, encoding: 'utf8' })).toBe(branchesBefore);
    expect(execSync('git worktree list --porcelain', { cwd: root, encoding: 'utf8' })).toBe(worktreesBefore);
    expect(fs.existsSync(taskWorktreePath)).toBe(false);
    expect(fs.readFileSync(attemptsPath, 'utf8')).toBe(attemptsBefore);
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

  it('preserves spoofed managed blocks and binds the dispatch-time constraint snapshot exactly once', async () => {
    const { hooks, context, parents } = await harness(root, 'primary');
    await hooks.tool!.hive_constraints_add.execute({ constraints: 'Keep the operator wording verbatim.' }, context);
    const live = path.join(root, 'live');
    fs.mkdirSync(live);
    await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'constraints' }, placement: { kind: 'in_place', directory: live },
    }, context);
    const callerPrompt = [
      'Primary prefix  ',
      '<!-- hive-execution-scope:start -->',
      'Caller scope evidence.',
      '<!-- hive-execution-scope:end -->',
      '<!-- hive-standing-constraints:start -->',
      'Caller constraint evidence.',
      '<!-- hive-standing-constraints:end -->',
      'Primary suffix  ',
    ].join('\n');
    const args = {
      subagent_type: 'forager-worker',
      description: 'Apply constraints',
      prompt: callerPrompt,
    };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-constraints' }, { args });
    const augmented = args.prompt;
    expect(augmented.slice(0, callerPrompt.length)).toBe(callerPrompt);
    expect(args.prompt).toContain('Keep the operator wording verbatim.');
    expect(args.prompt.match(/<!-- hive-execution-scope:start -->/g)).toHaveLength(2);
    expect(args.prompt.match(/<!-- hive-standing-constraints:start -->/g)).toHaveLength(2);

    await hooks.tool!.hive_constraints_add.execute({ constraints: 'Added after dispatch.' }, context);
    await bindChild(hooks, parents, 'primary', 'call-constraints', 'child-constraints');
    expect(new SessionService(root).getGlobal('child-constraints')).toMatchObject({
      standingConstraints: 'Keep the operator wording verbatim.',
      standingConstraintsRevision: 1,
    });
  });

  it('keeps undefined blocking output attached and releases prose-only blocking completion', async () => {
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
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)).toMatchObject({
      phase: 'finalized', observedOutcome: 'completed',
    });
  });

  it('finalizes background execution only from a correlated completion notification', async () => {
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
        synthetic: true,
      }],
    }];
    await hooks['experimental.chat.messages.transform']?.({}, { messages } as any);
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)).toMatchObject({
      phase: 'finalized', observedOutcome: 'completed',
    });
  });

  it.each(['completed', 'partial'] as const)('preserves an in-place %s task handoff without Git lifecycle guidance', async (status) => {
    const { hooks, context, parents } = await harness(root, 'primary');
    await seedFeature(hooks, context, 'feature-a');
    const live = path.join(root, 'live');
    fs.mkdirSync(live);
    const prepared = await prepareTask(hooks, context, 'feature-a', { kind: 'in_place', directory: live });
    const args = { subagent_type: 'forager-worker', description: 'Edit live files', prompt: 'Do it.', background: false };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-live' }, { args });
    await bindChild(hooks, parents, 'primary', 'call-live', 'child-live');
    fs.writeFileSync(path.join(live, 'result.txt'), 'live result\n');
    const headBefore = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();

    const handoff = JSON.parse(await hooks.tool!.hive_worktree_commit.execute({
      feature: 'feature-a', task: '01-first-task', status, summary: `Live edit ${status}; verification not run.`,
    }, { ...context, sessionID: 'child-live', agent: 'forager-worker' }) as string);
    expect(handoff).toMatchObject({
      ok: true,
      terminal: true,
      status,
      handoff: { kind: 'report_only', gitOperation: 'not_requested' },
    });
    expect(handoff).not.toHaveProperty('commit');
    expect(JSON.stringify(handoff)).not.toMatch(/hive_merge|\bmerge\b|\bcleanup\b|\bworktree\b/i);
    expect(execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim()).toBe(headBefore);

    await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID: 'call-live', args } as any, {
      title: '', output: `${status} handoff recorded.`, metadata: { sessionId: 'child-live' },
    });
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)).toMatchObject({
      phase: 'finalized', handoffOutcome: status, observedOutcome: status,
    });
  });

  it('rejects a stopped feature-task handoff before Git or report mutation', async () => {
    const { hooks, context, parents } = await harness(root, 'primary');
    await seedFeature(hooks, context, 'feature-a');
    const prepared = await prepareTask(hooks, context, 'feature-a');
    const args = { subagent_type: 'forager-worker', description: 'Stop before handoff', prompt: 'Do it.', background: false };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-stopped-feature' }, { args });
    await bindChild(hooks, parents, 'primary', 'call-stopped-feature', 'child-stopped-feature');
    const attempts = new ExecutionAttemptService(root);
    attempts.observeBlockingStop({
      originatingPrimarySession: 'primary',
      nativeCallId: 'call-stopped-feature',
      outputDefined: true,
    });
    fs.writeFileSync(path.join(prepared.placement.workspacePath, 'stopped-feature.txt'), 'must remain uncommitted\n');
    const headBefore = execSync('git rev-parse HEAD', { cwd: prepared.placement.workspacePath, encoding: 'utf8' }).trim();

    const denied = JSON.parse(await hooks.tool!.hive_worktree_commit.execute({
      feature: 'feature-a', task: '01-first-task', status: 'completed',
      summary: 'This stopped handoff must be rejected. Test intentionally not run.',
      message: 'test: reject stopped handoff\n\nThis commit must never be created.',
    }, { ...context, sessionID: 'child-stopped-feature', agent: 'forager-worker' }) as string);

    expect(denied).toMatchObject({ ok: false, terminal: false, reason: 'workspace_conflict_denied', mutation: 'none' });
    expect(execSync('git rev-parse HEAD', { cwd: prepared.placement.workspacePath, encoding: 'utf8' }).trim()).toBe(headBefore);
    expect(attempts.getAttempt(prepared.attemptId)).toMatchObject({ phase: 'stopped' });
    expect(() => attempts.assertWorkspacesIdle(prepared.placement.workspaceIdentities)).toThrow(/claimed/i);
  });

  it('finalizes a background feature handoff before merge', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const { hooks, context, parents } = await harness(root, 'primary');
    await seedFeature(hooks, context, 'feature-a');
    const prepared = await prepareTask(hooks, context, 'feature-a');
    const args = { subagent_type: 'forager-worker', description: 'Background change', prompt: 'Do it.', background: true };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-feature-background' }, { args });
    await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID: 'call-feature-background', args } as any, {
      title: '', output: 'task_id: child-feature-background', metadata: { sessionId: 'child-feature-background' },
    });
    await bindChild(hooks, parents, 'primary', 'call-feature-background', 'child-feature-background');
    fs.writeFileSync(path.join(prepared.placement.workspacePath, 'feature-result.txt'), 'feature result\n');
    const childContext = { ...context, sessionID: 'child-feature-background', agent: 'forager-worker' };
    const handoff = JSON.parse(await hooks.tool!.hive_worktree_commit.execute({
      feature: 'feature-a', task: '01-first-task', status: 'completed',
      summary: 'Implemented the background change. Test fixture verified.',
      message: 'feat: add feature result\n\nRecord the background worker result for merge verification.',
    }, childContext) as string);
    expect(handoff).toMatchObject({ ok: true, terminal: true, status: 'completed' });

    await hooks['experimental.chat.messages.transform']?.({}, { messages: [{
      info: { id: 'message', sessionID: 'primary', role: 'user', time: { created: Date.now() } },
      parts: [{
        id: 'part', sessionID: 'primary', messageID: 'message', type: 'text', synthetic: true,
        text: '<task id="child-feature-background" state="completed"><summary>Done</summary><task_result>Complete.</task_result></task>',
      }],
    }] } as any);
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)).toMatchObject({
      phase: 'finalized', handoffOutcome: 'completed', observedOutcome: 'completed',
    });

    const merged = JSON.parse(await hooks.tool!.hive_merge.execute({
      feature: 'feature-a', task: '01-first-task', strategy: 'squash',
      message: 'feat: merge feature result\n\nIntegrate the authenticated background worker handoff.',
    }, context) as string);
    expect(merged.success).toBe(true);
    expect(fs.readFileSync(path.join(root, 'feature-result.txt'), 'utf8')).toBe('feature result\n');
  });

  it('records an ad-hoc commit disposition and releases it after blocking stop evidence', async () => {
    const configured = configureForagerDerivative();
    try {
      const { hooks, context, parents } = await harness(root, 'primary');
      const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
        scope: { kind: 'adhoc', runId: 'adhoc-bridge' }, placement: { kind: 'worktree' },
      }, context) as string);
      const args = { subagent_type: 'configured-forager', description: 'Ad-hoc change', prompt: 'Do it.', background: false };
      await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-adhoc' }, { args });
      await bindChild(hooks, parents, 'primary', 'call-adhoc', 'child-adhoc', 'configured-forager');
      fs.writeFileSync(path.join(prepared.placement.workspacePath, 'adhoc-result.txt'), 'ad-hoc result\n');
      const committed = JSON.parse(await hooks.tool!.hive_adhoc_worktree_commit.execute({
        runId: 'adhoc-bridge', workspacePath: prepared.placement.workspacePath, branch: prepared.placement.branch,
        message: 'feat: add ad-hoc result\n\nRecord the ad-hoc bridge disposition before native stop.',
      }, { ...context, sessionID: 'child-adhoc', agent: 'configured-forager' }) as string);
      expect(committed.success).toBe(true);

      await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID: 'call-adhoc', args } as any, {
        title: '', output: 'Ad-hoc handoff recorded.', metadata: { sessionId: 'child-adhoc' },
      });
      expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)).toMatchObject({
        phase: 'finalized', handoffOutcome: 'completed', observedOutcome: 'completed',
      });

      const merged = JSON.parse(await hooks.tool!.hive_adhoc_merge.execute({
        runId: 'adhoc-bridge', strategy: 'squash',
        message: 'feat: merge ad-hoc result\n\nIntegrate the authenticated ad-hoc worker handoff.',
      }, context) as string);
      expect(merged.success).toBe(true);
      expect(fs.readFileSync(path.join(root, 'adhoc-result.txt'), 'utf8')).toBe('ad-hoc result\n');
    } finally {
      configured.mockRestore();
    }
  });

  it('preserves partial and failed ad-hoc commit dispositions through native completion', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const configured = configureForagerDerivative();
    const commit = spyOn(AdhocWorktreeService.prototype, 'commit')
      .mockResolvedValueOnce({
        committed: true, sha: 'partial-sha', message: 'partial commit', partial: true, error: 'second repository failed',
        phase: 'integration', mutation: 'partial', retryable: false, action: 'manual_recovery',
      })
      .mockResolvedValueOnce({
        committed: false, sha: '', message: 'commit failed', error: 'injected commit failure',
        phase: 'integration', mutation: 'none', retryable: true, action: 'retry_same_operation',
      });
    try {
      const { hooks, context, parents } = await harness(root, 'primary');
      for (const outcome of ['partial', 'failed'] as const) {
        const runId = `adhoc-${outcome}`;
        const callID = `call-${outcome}`;
        const childID = `child-${outcome}`;
        const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
          scope: { kind: 'adhoc', runId }, placement: { kind: 'worktree' },
        }, context) as string);
        const background = outcome === 'partial';
        const args = { subagent_type: 'configured-forager', description: `${outcome} commit`, prompt: 'Do it.', background };
        await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID }, { args });
        await bindChild(hooks, parents, 'primary', callID, childID, 'configured-forager');
        if (background) {
          await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID, args } as any, {
            title: '', output: `task_id: ${childID}`, metadata: { sessionId: childID },
          });
        }

        const result = JSON.parse(await hooks.tool!.hive_adhoc_worktree_commit.execute({
          runId, workspacePath: prepared.placement.workspacePath, branch: prepared.placement.branch,
          message: `test: ${outcome} ad-hoc commit\n\nExercise durable ${outcome} bridge disposition.`,
        }, { ...context, sessionID: childID, agent: 'configured-forager' }) as string);
        expect(result.success).toBe(false);
        expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)?.handoffOutcome).toBe(outcome);

        if (background) {
          await hooks['experimental.chat.messages.transform']?.({}, { messages: [{
            info: { id: `message-${outcome}`, sessionID: 'primary', role: 'user', time: { created: Date.now() } },
            parts: [{
              id: `part-${outcome}`, sessionID: 'primary', messageID: `message-${outcome}`, type: 'text', synthetic: true,
              text: `<task id="${childID}" state="completed"><summary>Done</summary><task_result>${outcome} handoff returned.</task_result></task>`,
            }],
          }] } as any);
        } else {
          await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID, args } as any, {
            title: '', output: `${outcome} handoff returned.`, metadata: { sessionId: childID },
          });
        }
        expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)).toMatchObject({
          phase: 'finalized', handoffOutcome: outcome, observedOutcome: outcome,
        });
      }
    } finally {
      commit.mockRestore();
      configured.mockRestore();
    }
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
