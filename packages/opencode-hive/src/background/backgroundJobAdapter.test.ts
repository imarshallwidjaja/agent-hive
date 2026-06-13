import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { BackgroundJobService, type SessionInfo } from 'hive-core';
import type { BackgroundJobsJson, BackgroundJobScope } from 'hive-core';
import { createBackgroundJobAdapter, type ReplayMessageEntry } from './backgroundJobAdapter.js';

const TEST_DIR = '/tmp/opencode-hive-backgroundjobadapter-test-' + process.pid;
const BOARD_PATH = path.join(TEST_DIR, '.hive', 'background-jobs.json');

function cleanup(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

function readBoard(): BackgroundJobsJson {
  return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf-8')) as BackgroundJobsJson;
}

function createHarness(enabled = true) {
  const sessions = new Map<string, SessionInfo>();
  const service = new BackgroundJobService(TEST_DIR);
  const adapter = createBackgroundJobAdapter({
    projectRoot: TEST_DIR,
    service,
    isEnabled: () => enabled,
    getSession: (sessionId) => sessions.get(sessionId),
    isPrimaryAgent: (agentName, session) => session?.sessionKind === 'primary' || agentName === 'hive-master',
    resolvePromptScope: (_input, session): BackgroundJobScope => ({
      projectRoot: TEST_DIR,
      parentSessionId: session?.sessionId,
      primaryAgent: session?.agent,
      feature: session?.featureName,
      task: session?.taskFolder,
      workflow: session && 'workflow' in session ? (session as SessionInfo & { workflow?: string }).workflow : undefined,
    }),
  });

  return { adapter, service, sessions };
}

function session(sessionId: string, agent = 'hive-master', sessionKind: SessionInfo['sessionKind'] = 'primary'): SessionInfo {
  return {
    sessionId,
    agent,
    sessionKind,
    startedAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
}

async function launchTask(adapter: ReturnType<typeof createBackgroundJobAdapter>, sessionID: string, taskId: string, args: Record<string, unknown> = {}): Promise<void> {
  await adapter['tool.execute.before']({ tool: 'task', sessionID, callID: `call-${taskId}` }, {
    args: { background: true, description: 'Explore implementation', subagent_type: 'scout-researcher', ...args },
  });
  await adapter['tool.execute.after']({ tool: 'task', sessionID, callID: `call-${taskId}` }, {
    output: `task_id: ${taskId}`,
  });
}

function messagesFor(sessionID: string): { messages: ReplayMessageEntry[] } {
  return {
    messages: [{
      info: {
        id: `msg-${sessionID}`,
        sessionID,
        role: 'user',
        time: { created: Date.now() },
      },
      parts: [{
        id: `prt-${sessionID}`,
        sessionID,
        messageID: `msg-${sessionID}`,
        type: 'text',
        text: 'Continue orchestration.',
      }],
    }],
  };
}

function injectedText(output: { messages: ReplayMessageEntry[] }): string {
  return output.messages.flatMap(message => message.parts).map(part => part.text ?? '').join('\n');
}

describe('createBackgroundJobAdapter', () => {
  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('is inert when the background experiment env gate is off', async () => {
    const { adapter, sessions } = createHarness(false);
    sessions.set('parent-1', session('parent-1'));

    await launchTask(adapter, 'parent-1', 'task-off');
    const output = messagesFor('parent-1');
    await adapter['experimental.chat.messages.transform']({}, output);

    expect(fs.existsSync(BOARD_PATH)).toBe(false);
    expect(output.messages).toHaveLength(1);
    expect(injectedText(output)).not.toContain('Background Job Board');
  });

  it('registers native background task launches as running jobs', async () => {
    const { adapter, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1'));

    await launchTask(adapter, 'parent-1', 'task-launch');

    const board = readBoard();
    expect(board.jobs).toHaveLength(1);
    expect(board.jobs[0]).toMatchObject({
      taskId: 'task-launch',
      runtimeState: 'running',
      agentName: 'scout-researcher',
      description: 'Explore implementation',
      scopeSource: 'native-fallback',
      scope: {
        projectRoot: TEST_DIR,
        parentSessionId: 'parent-1',
        primaryAgent: 'hive-master',
      },
    });
  });

  it('preserves pending launch metadata when task description and specialist selection drift', async () => {
    const { adapter, service, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1', 'swarm-orchestrator'));
    service.registerPendingLaunch({
      parentSessionId: 'parent-1',
      expectedDescription: 'Hive: 01-add-root-smoke-documentation-file',
      expectedPrompt: 'Follow instructions in @.hive/features/17_background-smoke-test/tasks/01-add-root-smoke-documentation-file/worker-prompt.md',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', primaryAgent: 'swarm-orchestrator', feature: 'background-smoke-test', task: '01-add-root-smoke-documentation-file' },
      ownership: { worktreePath: path.join(TEST_DIR, '.hive', '.worktrees', 'background-smoke-test', '01-add-root-smoke-documentation-file'), branch: 'hive/background-smoke-test/01-add-root-smoke-documentation-file' },
    });

    await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID: 'call-drift' }, {
      args: {
        background: true,
        description: 'Hive: smoke docs',
        prompt: 'Follow instructions in @.hive/features/17_background-smoke-test/tasks/01-add-root-smoke-documentation-file/worker-prompt.md',
        subagent_type: 'forager-documents',
      },
    });
    await adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'call-drift' }, {
      output: '<task id="ses_141cefb43ffeGAlDdBIqeETGNH" state="running"><summary>Background task started</summary></task>',
    });

    const board = readBoard();
    expect(board.pendingLaunches).toBeUndefined();
    expect(board.jobs).toHaveLength(1);
    expect(board.jobs[0]).toMatchObject({
      taskId: 'ses_141cefb43ffeGAlDdBIqeETGNH',
      agentName: 'forager-documents',
      description: 'Hive: smoke docs',
      scopeSource: 'pending-launch',
      scope: {
        projectRoot: TEST_DIR,
        parentSessionId: 'parent-1',
        primaryAgent: 'swarm-orchestrator',
        feature: 'background-smoke-test',
        task: '01-add-root-smoke-documentation-file',
      },
      ownership: {
        branch: 'hive/background-smoke-test/01-add-root-smoke-documentation-file',
      },
    });
  });

  it('discards matching pending launch metadata when a foreground task escape is used', async () => {
    const { adapter, service, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1'));
    service.registerPendingLaunch({
      parentSessionId: 'parent-1',
      expectedDescription: 'Hive: 01-task',
      expectedPrompt: 'Follow instructions in @worker-prompt.md',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', feature: 'feature-a', task: '01-task' },
    });

    await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID: 'call-foreground' }, {
      args: {
        background: false,
        description: 'Hive: 01-task',
        prompt: 'Follow instructions in @worker-prompt.md',
        subagent_type: 'forager-worker',
      },
    });
    await adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'call-foreground' }, {
      output: 'task_id: task-foreground',
    });

    const board = readBoard();
    expect(board.jobs).toHaveLength(0);
    expect(board.pendingLaunches).toBeUndefined();
  });

  it('keeps ad-hoc pending metadata across unrelated task calls until the stable prompt launches', async () => {
    const { adapter, service, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1', 'hive-builder'));
    const expectedPrompt = 'Work in /tmp/adhoc-1 for ad-hoc run adhoc-1.';
    service.registerPendingLaunch({
      parentSessionId: 'parent-1',
      expectedPrompt,
      agentName: 'unknown',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', primaryAgent: 'hive-builder', adHocRunId: 'adhoc-1' },
      ownership: { worktreePath: path.join(TEST_DIR, '.hive', '.worktrees', 'adhoc', 'adhoc-1'), branch: 'hive/adhoc/adhoc-1' },
    });

    await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID: 'call-foreground-unrelated' }, {
      args: { background: false, description: 'Foreground sanity check', prompt: 'Check unrelated state', subagent_type: 'scout-researcher' },
    });
    await adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'call-foreground-unrelated' }, {
      output: 'task_id: foreground-unrelated',
    });
    expect(readBoard().pendingLaunches).toHaveLength(1);

    await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID: 'call-background-unrelated' }, {
      args: { background: true, description: 'Background unrelated', prompt: 'Inspect unrelated files', subagent_type: 'scout-researcher' },
    });
    await adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'call-background-unrelated' }, {
      output: '<task id="background-unrelated" state="running"><summary>Background task started</summary></task>',
    });
    expect(readBoard().pendingLaunches).toHaveLength(1);

    await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID: 'call-background-adhoc' }, {
      args: { background: true, description: 'Run ad-hoc implementation', prompt: expectedPrompt, subagent_type: 'forager-fast' },
    });
    await adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'call-background-adhoc' }, {
      output: '<task id="adhoc-worker-session" state="running"><summary>Background task started</summary></task>',
    });

    const board = readBoard();
    expect(board.pendingLaunches).toBeUndefined();
    expect(board.jobs).toHaveLength(2);
    expect(board.jobs[1]).toMatchObject({
      taskId: 'adhoc-worker-session',
      scope: { adHocRunId: 'adhoc-1' },
      ownership: { branch: 'hive/adhoc/adhoc-1' },
    });
  });

  it('updates last-known runtime state and terminal metadata from native task_status', async () => {
    const { adapter, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1'));
    await launchTask(adapter, 'parent-1', 'task-status');

    await adapter['tool.execute.before']({ tool: 'task_status', sessionID: 'parent-1', callID: 'status-1' }, {
      args: { task_id: 'task-status' },
    });
    await adapter['tool.execute.after']({ tool: 'task_status', sessionID: 'parent-1', callID: 'status-1' }, {
      output: JSON.stringify({ task_id: 'task-status', status: 'completed', result: 'Worker finished.' }),
    });

    expect(readBoard().jobs[0]).toMatchObject({
      taskId: 'task-status',
      runtimeState: 'completed',
      resultSummary: 'Worker finished.',
      terminalUnreconciled: true,
    });
  });

  it('terminalizes registered non-worker jobs from native completion notifications without task_status', async () => {
    const { adapter, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1', 'hive-master'));

    await launchTask(adapter, 'parent-1', 'review-task', {
      description: 'Review the implementation',
      prompt: 'Review the current diff for correctness.',
      subagent_type: 'code-reviewer',
    });

    const output = messagesFor('parent-1');
    output.messages[0].parts.push({
      id: 'prt-completion',
      sessionID: 'parent-1',
      messageID: 'msg-parent-1',
      type: 'text',
      text: `<task id="review-task" state="completed">
<summary>Background task completed: Review the implementation</summary>
<task_result>
No correctness findings.
</task_result>
</task>`,
    });

    await adapter['experimental.chat.messages.transform']({}, output);

    expect(readBoard().jobs[0]).toMatchObject({
      taskId: 'review-task',
      agentName: 'code-reviewer',
      runtimeState: 'completed',
      resultSummary: 'No correctness findings.',
      terminalUnreconciled: true,
    });
    expect(readBoard().jobs[0].ownership?.workerPromptPath).toBeUndefined();
  });

  it('does not inherit task scope for native fallback reviewer launches from task-bound parents', async () => {
    const { adapter, sessions } = createHarness();
    sessions.set('parent-1', { ...session('parent-1', 'swarm-orchestrator'), featureName: 'feature-a', taskFolder: '02-worker-task' });

    await launchTask(adapter, 'parent-1', 'review-task', {
      description: 'Review smoke setup',
      prompt: 'Review the completed worker output.',
      subagent_type: 'code-reviewer',
    });

    expect(readBoard().jobs[0]).toMatchObject({
      taskId: 'review-task',
      agentName: 'code-reviewer',
      scopeSource: 'native-fallback',
      scope: {
        projectRoot: TEST_DIR,
        parentSessionId: 'parent-1',
        primaryAgent: 'swarm-orchestrator',
        feature: 'feature-a',
      },
    });
    expect(readBoard().jobs[0].scope?.task).toBeUndefined();
  });

  it('ignores completion notifications without a known registered task id', async () => {
    const { adapter, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1'));
    await launchTask(adapter, 'parent-1', 'known-task');

    const output = messagesFor('parent-1');
    output.messages[0].parts.push({
      id: 'prt-unknown-completion',
      sessionID: 'parent-1',
      messageID: 'msg-parent-1',
      type: 'text',
      text: '<task id="other-task" state="completed"><summary>Done</summary><task_result>wrong scope</task_result></task>',
    });

    await adapter['experimental.chat.messages.transform']({}, output);

    expect(readBoard().jobs[0]).toMatchObject({
      taskId: 'known-task',
      runtimeState: 'running',
    });
  });

  it('does not let completion notifications overwrite explicit terminal task_status results', async () => {
    const { adapter, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1'));
    await launchTask(adapter, 'parent-1', 'task-status-first');

    await adapter['tool.execute.before']({ tool: 'task_status', sessionID: 'parent-1', callID: 'status-first' }, {
      args: { task_id: 'task-status-first' },
    });
    await adapter['tool.execute.after']({ tool: 'task_status', sessionID: 'parent-1', callID: 'status-first' }, {
      output: JSON.stringify({ task_id: 'task-status-first', status: 'completed', result: 'Explicit task_status result.' }),
    });

    const output = messagesFor('parent-1');
    output.messages[0].parts.push({
      id: 'prt-late-notification',
      sessionID: 'parent-1',
      messageID: 'msg-parent-1',
      type: 'text',
      text: '<task id="task-status-first" state="completed"><summary>Done</summary><task_result>Late notification result.</task_result></task>',
    });

    await adapter['experimental.chat.messages.transform']({}, output);

    expect(readBoard().jobs[0]).toMatchObject({
      taskId: 'task-status-first',
      runtimeState: 'completed',
      resultSummary: 'Explicit task_status result.',
      terminalUnreconciled: true,
    });
  });

  it('ignores scoped completion notifications from a different or missing parent session', async () => {
    const { adapter, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1'));
    await launchTask(adapter, 'parent-1', 'scoped-task');

    const wrongParent = messagesFor('parent-2');
    wrongParent.messages[0].parts.push({
      id: 'prt-wrong-parent',
      sessionID: 'parent-2',
      messageID: 'msg-parent-2',
      type: 'text',
      text: '<task id="scoped-task" state="completed"><summary>Done</summary><task_result>Wrong parent.</task_result></task>',
    });
    await adapter['experimental.chat.messages.transform']({}, wrongParent);

    const missingParent: { messages: ReplayMessageEntry[] } = {
      messages: [{
        info: { id: 'msg-no-parent', role: 'assistant', time: { created: Date.now() } },
        parts: [{ id: 'prt-no-parent', type: 'text', text: '<task id="scoped-task" state="completed"><summary>Done</summary><task_result>No parent.</task_result></task>' }],
      }],
    };
    await adapter['experimental.chat.messages.transform']({}, missingParent);

    expect(readBoard().jobs[0]).toMatchObject({
      taskId: 'scoped-task',
      runtimeState: 'running',
    });
  });

  it('injects compact board entries only for the matching primary-agent parent session', async () => {
    const { adapter, service, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1'));
    sessions.set('parent-2', session('parent-2'));
    await launchTask(adapter, 'parent-1', 'task-visible');
    await launchTask(adapter, 'parent-2', 'task-hidden');
    service.markCancelRequested('task-visible', 'operator requested stop');

    const output = messagesFor('parent-1');
    await adapter['experimental.chat.messages.transform']({}, output);

    const text = injectedText(output);
    expect(text).toContain('## Background Job Board');
    expect(text).toContain('task-visible');
    expect(text).toContain('runtime: running');
    expect(text).toContain('coordination: cancel requested: operator requested stop');
    expect(text).not.toContain('task-hidden');
  });

  it('shows feature-scoped fallback jobs in task-bound parent prompts', async () => {
    const { adapter, service, sessions } = createHarness();
    sessions.set('parent-1', { ...session('parent-1', 'swarm-orchestrator'), featureName: 'feature-a', taskFolder: '02-worker-task' });
    service.registerLaunch({
      taskId: 'feature-review',
      sessionId: 'feature-review-session',
      agentName: 'code-reviewer',
      scopeSource: 'native-fallback',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', primaryAgent: 'swarm-orchestrator', feature: 'feature-a' },
    });

    const output = messagesFor('parent-1');
    await adapter['experimental.chat.messages.transform']({}, output);

    const text = injectedText(output);
    expect(text).toContain('feature-review');
    expect(text).toContain('feature-a');
  });

  it('prompt-acknowledges injected terminal jobs on parent idle without reconciling them', async () => {
    const { adapter, service, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1'));
    await launchTask(adapter, 'parent-1', 'terminal-task');
    service.markTerminal('terminal-task', 'completed', { resultSummary: 'Worker complete.' });

    const firstOutput = messagesFor('parent-1');
    await adapter['experimental.chat.messages.transform']({}, firstOutput);
    expect(injectedText(firstOutput)).toContain('terminal-task');
    expect(readBoard().jobs[0].promptNotifiedInSessionId).toBe('parent-1');
    expect(readBoard().jobs[0].promptBoardInjectionCount).toBe(1);

    const repeatedBeforeIdle = messagesFor('parent-1');
    await adapter['experimental.chat.messages.transform']({}, repeatedBeforeIdle);
    expect(injectedText(repeatedBeforeIdle)).not.toContain('terminal-task');
    expect(readBoard().jobs[0].promptAcknowledgedAt).toBeUndefined();
    expect(readBoard().jobs[0].promptBoardInjectionCount).toBe(1);

    await (adapter as any).event({ event: { type: 'session.idle', properties: { sessionID: 'parent-1' } } });
    const acknowledged = readBoard().jobs[0];
    expect(acknowledged.promptAcknowledgedAt).toBeDefined();
    expect(acknowledged.terminalUnreconciled).toBe(true);
    expect(acknowledged.reconciledAt).toBeUndefined();
    expect(acknowledged.promptBoardInjectionCount).toBe(1);

    const secondOutput = messagesFor('parent-1');
    await adapter['experimental.chat.messages.transform']({}, secondOutput);
    expect(injectedText(secondOutput)).not.toContain('terminal-task');
    expect(readBoard().jobs[0].promptBoardInjectionCount).toBe(1);
  });

  it('does not inject board text into subagent or reviewer sessions', async () => {
    const { adapter, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1'));
    sessions.set('scout-1', session('scout-1', 'scout-researcher', 'subagent'));
    sessions.set('reviewer-1', session('reviewer-1', 'code-reviewer', 'subagent'));
    await launchTask(adapter, 'parent-1', 'task-visible');

    const scoutOutput = messagesFor('scout-1');
    const reviewerOutput = messagesFor('reviewer-1');
    await adapter['experimental.chat.messages.transform']({}, scoutOutput);
    await adapter['experimental.chat.messages.transform']({}, reviewerOutput);

    expect(injectedText(scoutOutput)).not.toContain('Background Job Board');
    expect(injectedText(reviewerOutput)).not.toContain('Background Job Board');
  });

  it('shows stale scoped recovery entries only in the matching project and workflow scope', async () => {
    const { adapter, service, sessions } = createHarness();
    sessions.set('parent-1', { ...session('parent-1'), workflow: 'workflow-a' } as SessionInfo & { workflow: string });
    sessions.set('parent-2', { ...session('parent-2'), workflow: 'workflow-b' } as SessionInfo & { workflow: string });
    service.registerLaunch({
      taskId: 'stale-visible',
      sessionId: 'stale-session-1',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', primaryAgent: 'hive-master', workflow: 'workflow-a' },
    });
    service.markStale('stale-visible');
    service.registerLaunch({
      taskId: 'stale-hidden',
      sessionId: 'stale-session-2',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-2', primaryAgent: 'hive-master', workflow: 'workflow-b' },
    });
    service.markStale('stale-hidden');

    const output = messagesFor('parent-1');
    await adapter['experimental.chat.messages.transform']({}, output);

    const text = injectedText(output);
    expect(text).toContain('stale-visible');
    expect(text).toContain('coordination: stale/orphan recovery');
    expect(text).not.toContain('stale-hidden');
  });
});
