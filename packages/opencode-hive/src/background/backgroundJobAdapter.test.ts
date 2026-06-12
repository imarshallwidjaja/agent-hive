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
      scope: {
        projectRoot: TEST_DIR,
        parentSessionId: 'parent-1',
        primaryAgent: 'hive-master',
      },
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
