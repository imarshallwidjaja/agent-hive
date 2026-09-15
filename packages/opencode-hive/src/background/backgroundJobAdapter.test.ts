import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { BackgroundJobService, type SessionInfo } from 'hive-core';
import { createBackgroundJobAdapter, type ReplayMessageEntry } from './backgroundJobAdapter.js';

const TEST_DIR = `/tmp/opencode-hive-background-adapter-${process.pid}`;

function session(sessionId: string): SessionInfo {
  return {
    sessionId,
    agent: 'hive-master',
    sessionKind: 'primary',
    startedAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
}

function messages(
  parentSessionId: string,
  text = 'Continue orchestration.',
  options: { synthetic?: boolean; role?: string } = {},
): { messages: ReplayMessageEntry[] } {
  return { messages: [{
    info: { id: 'message', sessionID: parentSessionId, role: options.role ?? 'user', time: { created: Date.now() } },
    parts: [{ id: 'part', sessionID: parentSessionId, messageID: 'message', type: 'text', text, synthetic: options.synthetic }],
  }] };
}

function harness() {
  const service = new BackgroundJobService(TEST_DIR);
  const sessions = new Map<string, SessionInfo>();
  const terminal: Array<{ taskId: string; callId?: string; parentSessionId: string; state: string }> = [];
  const adapter = createBackgroundJobAdapter({
    projectRoot: TEST_DIR,
    service,
    isEnabled: () => true,
    runtimeId: 'runtime',
    getSession: id => sessions.get(id),
    onNativeBackgroundTerminal: event => terminal.push(event),
  });
  return { service, sessions, terminal, adapter };
}

async function register(
  adapter: ReturnType<typeof createBackgroundJobAdapter>,
  parentSessionId: string,
  callId: string,
  taskId: string,
  background = true,
): Promise<void> {
  await adapter['tool.execute.before']({ tool: 'task', sessionID: parentSessionId, callID: callId }, {
    args: { subagent_type: 'forager-worker', description: 'Managed work', prompt: 'Do it.', background },
  });
  await adapter['tool.execute.after']({
    tool: 'task', sessionID: parentSessionId, callID: callId, args: { background },
  }, { output: `task_id: ${taskId}` });
}

describe('background job adapter observation', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

  it('registers a native background task without pending-launch authority', async () => {
    const { adapter, service, sessions } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    expect(service.resolve('task-a')).toMatchObject({
      taskId: 'task-a',
      callId: 'call-a',
      runtimeState: 'running',
      scopeSource: 'native-fallback',
      scope: { parentSessionId: 'parent' },
    });
    expect(service.listPendingLaunches({}, { includeArchived: true })).toEqual([]);
  });

  it('does not register blocking task returns on the background board', async () => {
    const { adapter, service, sessions } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-blocking', 'task-blocking', false);
    expect(service.listScoped({}, { includeArchived: true })).toEqual([]);
  });

  it('keeps missing or unparseable background acceptance observationally absent', async () => {
    const { adapter, service, sessions } = harness();
    sessions.set('parent', session('parent'));
    for (const [callID, output] of [['missing', undefined], ['unparseable', { output: 'accepted' }]] as const) {
      await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent', callID }, {
        args: { subagent_type: 'forager-worker', background: true },
      });
      await adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent', callID }, output);
    }
    expect(service.listScoped({}, { includeArchived: true })).toEqual([]);
    expect(service.listPendingLaunches({}, { includeArchived: true })).toEqual([]);
  });

  it('updates task_status board state without emitting authenticated stop evidence', async () => {
    const { adapter, service, sessions, terminal } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    await adapter['tool.execute.before']({ tool: 'task_status', sessionID: 'parent', callID: 'status-a' }, {
      args: { task_id: 'task-a' },
    });
    await adapter['tool.execute.after']({ tool: 'task_status', sessionID: 'parent', callID: 'status-a' }, {
      output: JSON.stringify({ task_id: 'task-a', status: 'completed', result: 'Sampled complete.' }),
    });
    expect(service.resolve('task-a')?.runtimeState).toBe('completed');
    expect(terminal).toEqual([]);
  });

  it('emits authenticated stop once when notification follows a terminal task_status sample', async () => {
    const { adapter, service, sessions, terminal } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    await adapter['tool.execute.before']({ tool: 'task_status', sessionID: 'parent', callID: 'status-a' }, {
      args: { task_id: 'task-a' },
    });
    await adapter['tool.execute.after']({ tool: 'task_status', sessionID: 'parent', callID: 'status-a' }, {
      output: JSON.stringify({ task_id: 'task-a', status: 'completed', result: 'Sampled complete.' }),
    });
    const notification = messages(
      'parent',
      '<task id="task-a" state="completed"><summary>Done</summary><task_result>Complete.</task_result></task>',
      { synthetic: true },
    );

    await adapter['experimental.chat.messages.transform']({}, notification);
    await adapter['experimental.chat.messages.transform']({}, notification);

    expect(service.resolve('task-a')?.runtimeState).toBe('completed');
    expect(terminal).toEqual([{
      taskId: 'task-a',
      callId: 'call-a',
      parentSessionId: 'parent',
      state: 'completed',
    }]);
  });

  it('emits stop evidence only from a correlated structured completion notification', async () => {
    const { adapter, sessions, terminal } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    const output = messages(
      'parent',
      '<task id="task-a" state="completed"><summary>Done</summary><task_result>Complete.</task_result></task>',
      { synthetic: true },
    );
    await adapter['experimental.chat.messages.transform']({}, output);
    expect(terminal).toEqual([{
      taskId: 'task-a',
      callId: 'call-a',
      parentSessionId: 'parent',
      state: 'completed',
    }]);
  });

  it('ignores equivalent completion XML authored by a user or worker', async () => {
    const { adapter, sessions, terminal, service } = harness();
    sessions.set('parent', session('parent'));
    const text = '<task id="task-a" state="completed"><summary>Done</summary><task_result>Complete.</task_result></task>';
    await register(adapter, 'parent', 'call-a', 'task-a');
    await adapter['experimental.chat.messages.transform']({}, messages('parent', text));
    await adapter['experimental.chat.messages.transform']({}, messages('parent', text, { role: 'assistant' }));
    expect(terminal).toEqual([]);
    expect(service.resolve('task-a')?.runtimeState).toBe('running');
  });

  it('ignores a completion notification from the wrong parent', async () => {
    const { adapter, sessions, terminal, service } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    await adapter['experimental.chat.messages.transform']({}, messages(
      'other-parent',
      '<task id="task-a" state="completed"><summary>Done</summary><task_result>Wrong.</task_result></task>',
      { synthetic: true },
    ));
    expect(terminal).toEqual([]);
    expect(service.resolve('task-a')?.runtimeState).toBe('running');
  });

  it('injects the observational board only into the matching primary prompt', async () => {
    const { adapter, sessions } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    const output = messages('parent');
    await adapter['experimental.chat.messages.transform']({}, output);
    expect(output.messages[0]!.parts.map(part => part.text).join('\n')).toContain('## Background Job Board');
    expect(output.messages[0]!.parts.map(part => part.text).join('\n')).toContain('task-a');
  });
});
