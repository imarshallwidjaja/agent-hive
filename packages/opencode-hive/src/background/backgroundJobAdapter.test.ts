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
  const warnings: string[] = [];
  const adapter = createBackgroundJobAdapter({
    projectRoot: TEST_DIR,
    service,
    isEnabled: () => true,
    runtimeId: 'runtime',
    getSession: id => sessions.get(id),
    warn: warning => warnings.push(warning),
  });
  return { service, sessions, warnings, adapter };
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

  it('registers a native background task from its native identity', async () => {
    const { adapter, service, sessions } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    expect(service.resolve('task-a')).toMatchObject({
      taskId: 'task-a',
      callId: 'call-a',
      runtimeState: 'running',
      scope: { parentSessionId: 'parent' },
    });
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
  });

  it('updates task_status board state without emitting authenticated stop evidence', async () => {
    const { adapter, service, sessions } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    await adapter['tool.execute.before']({ tool: 'task_status', sessionID: 'parent', callID: 'status-a' }, {
      args: { task_id: 'task-a' },
    });
    await adapter['tool.execute.after']({ tool: 'task_status', sessionID: 'parent', callID: 'status-a' }, {
      output: JSON.stringify({ task_id: 'task-a', status: 'completed', result: 'Sampled complete.' }),
    });
    expect(service.resolve('task-a')?.runtimeState).toBe('completed');
  });

  it('keeps terminal board state when notification follows a terminal task_status sample', async () => {
    const { adapter, service, sessions } = harness();
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
  });

  it('records a correlated structured completion notification on the board', async () => {
    const { adapter, sessions, service } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    const output = messages(
      'parent',
      '<task id="task-a" state="completed"><summary>Done</summary><task_result>Complete.</task_result></task>',
      { synthetic: true },
    );
    await adapter['experimental.chat.messages.transform']({}, output);
    expect(service.resolve('task-a')).toMatchObject({ runtimeState: 'completed', resultSummary: 'Complete.' });
  });

  it('retries a terminal notification after a transient board write failure', async () => {
    const { adapter, sessions, service, warnings } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    const markTerminal = service.markTerminal.bind(service);
    let shouldFail = true;
    service.markTerminal = ((identifier, state, patch) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('transient board write');
      }
      return markTerminal(identifier, state, patch);
    }) as typeof service.markTerminal;
    const output = messages(
      'parent',
      '<task id="task-a" state="completed"><task_result>Complete.</task_result></task>',
      { synthetic: true },
    );

    await adapter['experimental.chat.messages.transform']({}, output);
    expect(service.resolve('task-a')?.runtimeState).toBe('running');
    await adapter['experimental.chat.messages.transform']({}, output);

    expect(service.resolve('task-a')).toMatchObject({ runtimeState: 'completed', statusUncertain: false });
    expect(service.resolve('task-a')).not.toHaveProperty('lastStatusError');
    expect(warnings.some(warning => warning.includes('transient board write'))).toBe(true);
  });

  it('contains and retries an ambiguous notification after a transient board write failure', async () => {
    const { adapter, sessions, service, warnings } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-1', 'resumed-child');
    await register(adapter, 'parent', 'call-2', 'resumed-child');
    const updateRuntimeState = service.updateRuntimeState.bind(service);
    let shouldFail = true;
    service.updateRuntimeState = ((identifier, state, patch) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('transient ambiguity board write');
      }
      return updateRuntimeState(identifier, state, patch);
    }) as typeof service.updateRuntimeState;
    const output = messages(
      'parent',
      '<task id="resumed-child" state="completed"><task_result>Complete.</task_result></task>',
      { synthetic: true },
    );

    await adapter['experimental.chat.messages.transform']({}, output);
    expect(service.resolve('parent:job-1')?.runtimeState).toBe('running');
    await adapter['experimental.chat.messages.transform']({}, output);

    expect(service.resolve('parent:job-1')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(service.resolve('parent:job-2')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(warnings.some(warning => warning.includes('transient ambiguity board write'))).toBe(true);
  });

  it('ignores equivalent completion XML authored by a user or worker', async () => {
    const { adapter, sessions, service } = harness();
    sessions.set('parent', session('parent'));
    const text = '<task id="task-a" state="completed"><summary>Done</summary><task_result>Complete.</task_result></task>';
    await register(adapter, 'parent', 'call-a', 'task-a');
    await adapter['experimental.chat.messages.transform']({}, messages('parent', text));
    await adapter['experimental.chat.messages.transform']({}, messages('parent', text, { role: 'assistant' }));
    expect(service.resolve('task-a')?.runtimeState).toBe('running');
  });

  it('ignores a completion notification from the wrong parent', async () => {
    const { adapter, sessions, service } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    await adapter['experimental.chat.messages.transform']({}, messages(
      'other-parent',
      '<task id="task-a" state="completed"><summary>Done</summary><task_result>Wrong.</task_result></task>',
      { synthetic: true },
    ));
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

  it('keeps jobs visible when the originating parent changes agent or feature', async () => {
    const { adapter, sessions } = harness();
    const parent = session('parent');
    parent.featureName = 'feature-at-dispatch';
    sessions.set('parent', parent);
    await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent', callID: 'call-a' }, {
      args: { subagent_type: 'forager-worker', background: true },
    });
    parent.agent = 'different-agent';
    parent.featureName = 'different-feature';
    await adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent', callID: 'call-a' }, {
      output: 'task_id: task-a',
    });
    const output = messages('parent');
    await adapter['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0]!.parts.map(part => part.text).join('\n')).toContain('task-a');
    expect(output.messages[0]!.parts.map(part => part.text).join('\n')).toContain('feature-at-dispatch');
  });

  it('keeps resumed child launches separate and does not apply ambiguous late completion', async () => {
    const { adapter, sessions, service, warnings } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-1', 'resumed-child');
    const first = service.listScoped({ parentSessionId: 'parent' })[0]!;
    const firstCompletion = messages(
      'parent',
      '<task id="resumed-child" call-id="call-1" state="completed"><task_result>first done</task_result></task>',
      { synthetic: true },
    );
    await adapter['experimental.chat.messages.transform']({}, firstCompletion);
    await register(adapter, 'parent', 'call-2', 'resumed-child');
    const resumed = service.listScoped({ parentSessionId: 'parent' }).find(job => job.callId === 'call-2')!;
    const lateDuplicate = messages(
      'parent',
      '<task id="resumed-child" state="completed"><task_result>late old result</task_result></task>',
      { synthetic: true },
    );
    lateDuplicate.messages[0]!.info.id = 'late-message';
    lateDuplicate.messages[0]!.parts[0]!.id = 'late-part';
    await adapter['experimental.chat.messages.transform']({}, lateDuplicate);

    expect(service.resolve(first.alias)).toMatchObject({ runtimeState: 'completed', resultSummary: 'first done' });
    expect(service.resolve(resumed.alias)).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(service.resolve(resumed.alias)?.lastStatusError).toContain('hive_task_trace');
    expect(warnings.at(-1)).toContain('Ambiguous native completion notification');
    const prompt = lateDuplicate.messages[0]!.parts.map(part => part.text).join('\n');
    expect(prompt).toContain(resumed.alias);
    expect(prompt).toContain('hive_task_trace({ task_id: "resumed-child" })');
  });

  it('uses exact completion call identity for a resumed child', async () => {
    const { adapter, sessions, service } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-1', 'resumed-child');
    await register(adapter, 'parent', 'call-2', 'resumed-child');
    const resumed = service.listScoped({ parentSessionId: 'parent' }).find(job => job.callId === 'call-2')!;
    await adapter['experimental.chat.messages.transform']({}, messages(
      'parent',
      '<task id="resumed-child" call-id="call-2" state="completed"><task_result>resumed done</task_result></task>',
      { synthetic: true },
    ));

    expect(service.resolve(resumed.alias)).toMatchObject({ runtimeState: 'completed', resultSummary: 'resumed done' });
  });

  it('keeps transient task_status uncertainty visible until an authoritative terminal notification resolves it', async () => {
    const { adapter, sessions, service } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    await adapter['tool.execute.before']({ tool: 'task_status', sessionID: 'parent', callID: 'status-a' }, {
      args: { task_id: 'task-a' },
    });
    await adapter['tool.execute.after']({ tool: 'task_status', sessionID: 'parent', callID: 'status-a' }, {
      output: 'Task not found in this process.\ntask_id: task-a',
    });

    expect(service.resolve('task-a')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    const uncertainPrompt = messages('parent');
    await adapter['experimental.chat.messages.transform']({}, uncertainPrompt);
    expect(uncertainPrompt.messages[0]!.parts.map(part => part.text).join('\n')).toContain('hive_task_trace');

    await adapter['experimental.chat.messages.transform']({}, messages(
      'parent',
      '<task id="task-a" state="completed"><task_result>authoritative result</task_result></task>',
      { synthetic: true },
    ));
    expect(service.resolve('task-a')).toMatchObject({ runtimeState: 'completed', statusUncertain: false, resultSummary: 'authoritative result' });
    expect(service.resolve('task-a')).not.toHaveProperty('lastStatusError');
  });

  it('bounds result snippets injected into parent prompts', async () => {
    const { adapter, sessions, service } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    service.markTerminal('task-a', 'completed', { resultSummary: `${'x'.repeat(800)}TAIL` });
    const output = messages('parent');
    await adapter['experimental.chat.messages.transform']({}, output);
    const prompt = output.messages[0]!.parts.map(part => part.text).join('\n');
    expect(prompt).not.toContain('TAIL');
    expect(prompt).toContain('...');
  });
});
