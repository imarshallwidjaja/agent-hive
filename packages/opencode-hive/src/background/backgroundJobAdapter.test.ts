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

function harness(enabled = true) {
  const service = new BackgroundJobService(TEST_DIR);
  const sessions = new Map<string, SessionInfo>();
  const warnings: string[] = [];
  const adapter = createBackgroundJobAdapter({
    projectRoot: TEST_DIR,
    service,
    isEnabled: () => enabled,
    runtimeId: 'runtime',
    getSession: id => sessions.get(id),
    warn: warning => warnings.push(warning),
  });
  return { service, sessions, warnings, adapter };
}

function sessionEvent(type: string, properties: Record<string, unknown>): { event: { type: string; properties: Record<string, unknown> } } {
  return { event: { type, properties } };
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

  it('treats object-shaped status idle and separate idle events as uncertain child state', async () => {
    const { adapter, service, sessions } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    await register(adapter, 'parent', 'call-b', 'task-b');

    await adapter.event(sessionEvent('session.status', { sessionID: 'task-a', status: { type: 'idle' } }));
    await adapter.event(sessionEvent('session.idle', { sessionID: 'task-b' }));
    const firstIdle = service.resolve('task-b')!;
    await adapter.event(sessionEvent('session.idle', { sessionID: 'task-b' }));

    for (const taskId of ['task-a', 'task-b']) {
      expect(service.resolve(taskId)).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
      expect(service.resolve(taskId)).not.toHaveProperty('resultSummary');
      expect(service.resolve(taskId)).not.toHaveProperty('lastStatusError');
    }
    expect(service.resolve('task-b')).toEqual(firstIdle);
  });

  it('preserves parent prompt acknowledgment for object-shaped status idle events', async () => {
    const { adapter, service, sessions } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    service.markTerminal('task-a', 'completed');
    service.markPromptNotified(['task-a'], 'parent');

    await adapter.event(sessionEvent('session.status', { sessionID: 'parent', status: { type: 'idle' } }));

    expect(service.resolve('task-a')?.promptAcknowledgedAt).toBeDefined();
  });

  it('lets exact completion resolve idle-derived uncertainty', async () => {
    const { adapter, service, sessions } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    await adapter.event(sessionEvent('session.idle', { sessionID: 'task-a' }));

    await adapter['experimental.chat.messages.transform']({}, messages(
      'parent',
      '<task id="task-a" state="completed"><task_result>authoritative result</task_result></task>',
      { synthetic: true },
    ));

    expect(service.resolve('task-a')).toMatchObject({
      runtimeState: 'completed',
      statusUncertain: false,
      resultSummary: 'authoritative result',
    });
  });

  it('classifies session errors and keeps terminal state absorbing across event orderings', async () => {
    const { adapter, service, sessions } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-abort', 'task-abort');
    await register(adapter, 'parent', 'call-error', 'task-error');

    await adapter.event(sessionEvent('session.idle', { sessionID: 'task-abort' }));
    await adapter.event(sessionEvent('session.error', {
      sessionID: 'task-abort',
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
    }));
    await adapter.event(sessionEvent('session.error', {
      sessionID: 'task-error',
      error: { name: 'APIError', data: { message: 'Provider disconnected' } },
    }));
    await adapter.event(sessionEvent('session.idle', { sessionID: 'task-error' }));

    expect(service.resolve('task-abort')).toMatchObject({
      runtimeState: 'cancelled',
      statusUncertain: false,
      lastStatusError: 'MessageAbortedError: Aborted',
    });
    expect(service.resolve('task-error')).toMatchObject({
      runtimeState: 'error',
      statusUncertain: false,
      lastStatusError: 'APIError: Provider disconnected',
    });
  });

  it('ignores missing child identities and handles duplicate lifecycle events idempotently', async () => {
    const { adapter, service, sessions } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    await adapter.event(sessionEvent('session.idle', {}));
    await adapter.event(sessionEvent('session.error', { error: { name: 'APIError', data: { message: 'No identity' } } }));
    expect(service.resolve('task-a')?.runtimeState).toBe('running');

    const errorEvent = sessionEvent('session.error', {
      sessionID: 'task-a',
      error: { name: 'APIError', data: { message: 'Provider disconnected' } },
    });
    await adapter.event(errorEvent);
    const first = service.resolve('task-a')!;
    await adapter.event(errorEvent);

    expect(service.resolve('task-a')).toEqual(first);
  });

  it('marks reused nonterminal child sessions ambiguous without terminalizing them', async () => {
    const { adapter, service, sessions, warnings } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-1', 'shared-child');
    await register(adapter, 'parent', 'call-2', 'shared-child');

    await adapter.event(sessionEvent('session.error', {
      sessionID: 'shared-child',
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
    }));

    for (const job of service.listScoped({ parentSessionId: 'parent' })) {
      expect(job).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
      expect(job.lastStatusError).toContain('Ambiguous session error event');
    }
    expect(warnings.at(-1)).toContain('Ambiguous session error event');
  });

  it('leaves archived nonterminal jobs unchanged after lifecycle events', async () => {
    const { adapter, service, sessions } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-idle', 'archived-idle');
    await register(adapter, 'parent', 'call-error', 'archived-error');
    const archivedIdle = service.markIgnored('archived-idle', 'Operator archived');
    const archivedError = service.markIgnored('archived-error', 'Operator archived');

    await adapter.event(sessionEvent('session.idle', { sessionID: 'archived-idle' }));
    await adapter.event(sessionEvent('session.error', {
      sessionID: 'archived-error',
      error: { name: 'APIError', data: { message: 'late error' } },
    }));

    expect(service.resolve(archivedIdle.alias)).toEqual(archivedIdle);
    expect(service.resolve(archivedError.alias)).toEqual(archivedError);
  });

  it('treats terminal history plus a resumed active generation as ambiguous', async () => {
    const { adapter, service, sessions, warnings } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-1', 'resumed-child');
    const first = service.listScoped({ parentSessionId: 'parent' })[0]!;
    service.markTerminal(first.alias, 'completed', { resultSummary: 'first done' });
    await register(adapter, 'parent', 'call-2', 'resumed-child');
    const resumed = service.listScoped({ parentSessionId: 'parent' }).find(job => job.callId === 'call-2')!;

    await adapter.event(sessionEvent('session.error', {
      sessionID: 'resumed-child',
      error: { name: 'APIError', data: { message: 'late old error' } },
    }));

    expect(service.resolve(first.alias)).toMatchObject({ runtimeState: 'completed', resultSummary: 'first done' });
    expect(service.resolve(resumed.alias)).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(service.resolve(resumed.alias)?.lastStatusError).toContain('Ambiguous session error event');
    expect(warnings.at(-1)).toContain('Ambiguous session error event');
  });

  it('treats archived history plus a resumed active generation as ambiguous without changing history', async () => {
    const { adapter, service, sessions } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-1', 'resumed-child');
    const first = service.listScoped({ parentSessionId: 'parent' })[0]!;
    const archived = service.markIgnored(first.alias, 'Operator archived');
    await register(adapter, 'parent', 'call-2', 'resumed-child');
    const resumed = service.listScoped({ parentSessionId: 'parent' }).find(job => job.callId === 'call-2')!;

    await adapter.event(sessionEvent('session.idle', { sessionID: 'resumed-child' }));

    expect(service.resolve(archived.alias)).toEqual(archived);
    expect(service.resolve(resumed.alias)).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(service.resolve(resumed.alias)?.lastStatusError).toContain('Ambiguous session idle event');
  });

  it('contains parent prompt acknowledgment failure and still observes child idle state', async () => {
    const { adapter, service, sessions, warnings } = harness();
    sessions.set('shared-session', session('shared-session'));
    await register(adapter, 'shared-session', 'call-1', 'shared-session');
    service.markPromptAcknowledgedForSession = (() => {
      throw new Error('prompt acknowledgment write failed');
    }) as typeof service.markPromptAcknowledgedForSession;

    await adapter.event(sessionEvent('session.idle', { sessionID: 'shared-session' }));

    expect(service.resolve('shared-session')).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(warnings.some(warning => warning.includes('prompt acknowledgment write failed'))).toBe(true);
  });

  it('does not regress explicit cancellation or terminal errors on later lifecycle events', async () => {
    const { adapter, service, sessions } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-cancelled', 'task-cancelled');
    await register(adapter, 'parent', 'call-error', 'task-error');
    service.markRuntimeCancelled('task-cancelled', { resultSummary: 'Explicit runtime cancellation' });
    service.markTerminal('task-error', 'error', { lastStatusError: 'first error' });

    await adapter.event(sessionEvent('session.error', {
      sessionID: 'task-cancelled',
      error: { name: 'APIError', data: { message: 'late error' } },
    }));
    await adapter.event(sessionEvent('session.idle', { sessionID: 'task-cancelled' }));
    await adapter.event(sessionEvent('session.idle', { sessionID: 'task-error' }));

    expect(service.resolve('task-cancelled')).toMatchObject({
      runtimeState: 'cancelled',
      resultSummary: 'Explicit runtime cancellation',
    });
    expect(service.resolve('task-error')).toMatchObject({ runtimeState: 'error', lastStatusError: 'first error' });
  });

  it('does not observe lifecycle events when the experiment is disabled', async () => {
    const { adapter, service } = harness(false);
    service.registerLaunch({
      taskId: 'task-a',
      sessionId: 'task-a',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent' },
    });

    await adapter.event(sessionEvent('session.error', {
      sessionID: 'task-a',
      error: { name: 'APIError', data: { message: 'Provider disconnected' } },
    }));

    expect(service.resolve('task-a')?.runtimeState).toBe('running');
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
