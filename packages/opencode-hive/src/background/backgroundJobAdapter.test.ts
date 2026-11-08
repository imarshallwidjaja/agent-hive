import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { BackgroundJobService, type SessionInfo } from 'hive-core';
import { createBackgroundJobAdapter, type ReplayMessageEntry } from './backgroundJobAdapter.js';
import { createBackgroundOperations } from './operations.js';

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
    getBoundChild: ({ childSessionId }) => sessions.get(childSessionId),
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

  it('scopes a launch to the feature, task or run that the child binding for this parent names, and to nothing otherwise', async () => {
    const { adapter, service, sessions } = harness();
    // The parent's route moved on after dispatch; the child's binding keeps the route the dispatch captured.
    sessions.set('parent', { ...session('parent'), featureName: 'beta' });
    sessions.set('task-a', { ...session('task-a'), parentSessionId: 'parent', featureName: 'alpha', taskFolder: '01-build' });
    sessions.set('task-b', { ...session('task-b'), parentSessionId: 'parent', featureName: null, adHocRunId: 'run-1' });
    sessions.set('task-c', { ...session('task-c'), parentSessionId: 'other-parent', featureName: 'alpha', taskFolder: '01-build' });
    for (const task of ['task-a', 'task-b', 'task-c', 'task-d']) await register(adapter, 'parent', `call-${task}`, task);
    expect(service.resolve('task-a')?.scope).toEqual({ projectRoot: TEST_DIR, parentSessionId: 'parent', primaryAgent: 'hive-master', feature: 'alpha', task: '01-build' });
    expect(service.resolve('task-b')?.scope).toEqual({ projectRoot: TEST_DIR, parentSessionId: 'parent', primaryAgent: 'hive-master', adHocRunId: 'run-1' });
    for (const task of ['task-c', 'task-d']) {
      expect(service.resolve(task)?.scope, task).toEqual({ projectRoot: TEST_DIR, parentSessionId: 'parent', primaryAgent: 'hive-master' });
    }
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
    // The dispatch bound the child to the route it captured.
    sessions.set('task-a', { ...session('task-a'), parentSessionId: 'parent', featureName: 'feature-at-dispatch' });
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

  it('shows a terminal row and an unrecorded launch again until a parent turn that saw them completes, through both v1 idle events of a failed turn', async () => {
    const { adapter, sessions, service } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    service.markTerminal('task-a', 'completed', { resultSummary: 'done' });
    const registerLaunch = service.registerLaunch.bind(service);
    service.registerLaunch = (() => { throw new Error('disk full'); }) as typeof service.registerLaunch;
    await register(adapter, 'parent', 'call-b', 'task-b');
    service.registerLaunch = registerLaunch;
    const boardText = async () => {
      const output = messages('parent');
      await adapter['experimental.chat.messages.transform']({}, output);
      return output.messages[0]!.parts.map(part => part.text).join('\n');
    };
    const acknowledged = () => ({
      row: service.resolve('task-a')?.promptAcknowledgedAt !== undefined,
      gap: adapter.unrecordedLaunches('parent')[0]?.promptAcknowledged,
    });
    // v1 ends a failed turn with session.error, then session.status idle, then session.idle.
    const failedTurn = async () => {
      await adapter.event(sessionEvent('session.error', { sessionID: 'parent', error: { name: 'APIError', data: { message: 'overloaded' } } }));
      await adapter.event(sessionEvent('session.status', { sessionID: 'parent', status: { type: 'idle' } }));
      await adapter.event(sessionEvent('session.idle', { sessionID: 'parent' }));
    };
    const completedTurn = async () => {
      await adapter.event(sessionEvent('session.status', { sessionID: 'parent', status: { type: 'idle' } }));
      await adapter.event(sessionEvent('session.idle', { sessionID: 'parent' }));
    };

    const first = await boardText();
    expect(first).toContain('parent:job-1 (task-a)');
    expect(first).toContain('unrecorded launch (task-b)');
    expect(service.resolve('task-a')?.promptNotifiedAt).toBeDefined();
    await failedTurn();
    expect(acknowledged()).toEqual({ row: false, gap: false });
    // Further idles without a new request still belong to the failed turn.
    await adapter.event(sessionEvent('session.idle', { sessionID: 'parent' }));
    expect(acknowledged()).toEqual({ row: false, gap: false });

    // The retried request shows both again; its completed turn acknowledges them, and they stop repeating.
    const retried = await boardText();
    expect(retried).toContain('parent:job-1 (task-a)');
    expect(retried).toContain('unrecorded launch (task-b)');
    await completedTurn();
    expect(acknowledged()).toEqual({ row: true, gap: true });
    expect(await boardText()).not.toContain('## Background Job Board');
    expect(service.resolve('task-a')).toMatchObject({ terminalUnreconciled: true, promptBoardInjectionCount: 1 });
  });

  it('shows a terminal row again after acknowledgement when new conflicting terminal evidence arrives, once per conflict', async () => {
    const { adapter, sessions, service } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-a', 'task-a');
    service.markTerminal('task-a', 'completed', { resultSummary: 'done' });
    const boardText = async () => {
      const output = messages('parent');
      await adapter['experimental.chat.messages.transform']({}, output);
      return output.messages[0]!.parts.map(part => part.text).join('\n');
    };
    const completedTurn = () => adapter.event(sessionEvent('session.idle', { sessionID: 'parent' }));

    expect(await boardText()).toContain('parent:job-1 (task-a)');
    await completedTurn();
    expect(await boardText()).not.toContain('## Background Job Board');

    service.markTerminal('task-a', 'error', { lastStatusError: 'provider failed late' });
    // A turn that ends before the parent is shown the conflict does not acknowledge it.
    await completedTurn();
    const conflict = await boardText();
    expect(conflict).toContain('Conflicting terminal evidence');
    expect(conflict).toContain('status uncertain');
    await completedTurn();
    expect(await boardText()).not.toContain('## Background Job Board');

    service.markTerminal('task-a', 'error', { lastStatusError: 'provider failed late' });
    expect(await boardText()).not.toContain('## Background Job Board');
    expect(service.resolve('task-a')).toMatchObject({ runtimeState: 'completed', promptBoardInjectionCount: 2 });
  });

  it('shows its own unrecorded launches with the read failure when the board is unreadable, and nothing to another parent', async () => {
    const { adapter, sessions, service, warnings } = harness();
    sessions.set('parent', session('parent'));
    service.registerLaunch = (() => { throw new Error('disk full'); }) as typeof service.registerLaunch;
    await register(adapter, 'parent', 'call-a', 'task-a');
    fs.mkdirSync(`${TEST_DIR}/.hive`, { recursive: true });
    fs.writeFileSync(`${TEST_DIR}/.hive/background-jobs.json`, '{"jobs": [');

    const shown = messages('parent');
    await adapter['experimental.chat.messages.transform']({}, shown);
    const text = shown.messages[0]!.parts.map(part => part.text).join('\n');
    expect(text).toContain('- board unreadable: Hive could not read the background board');
    expect(text).toContain('unknown, not absent');
    expect(text).toContain('unrecorded launch (task-a) forager-worker');
    expect(warnings.at(-1)).toContain('showing parent its unrecorded launches without board rows');

    // Another parent has no gap to show, so the read failure stays the caller's, and the gap is not disclosed.
    const other = messages('other-parent');
    await expect(adapter['experimental.chat.messages.transform']({}, other)).rejects.toThrow('could not read the background board');
    expect(other.messages[0]!.parts).toHaveLength(1);

    // The completed turn acknowledges the gap even though the board acknowledgement cannot be written.
    await adapter.event(sessionEvent('session.idle', { sessionID: 'parent' }));
    expect(adapter.unrecordedLaunches('parent')).toEqual([expect.objectContaining({ childSessionId: 'task-a', promptAcknowledged: true })]);
    expect(warnings.join('\n')).toContain('failed to acknowledge parent prompt for parent: Hive could not read the background board');
  });

  it('reports a launch onto an existing non-board file as unrecorded and leaves the file as found', async () => {
    const { adapter, sessions } = harness();
    sessions.set('parent', session('parent'));
    const boardPath = `${TEST_DIR}/.hive/background-jobs.json`;
    fs.mkdirSync(`${TEST_DIR}/.hive`, { recursive: true });
    for (const [content, id] of [['null', 'null-board'], ['{}', 'no-jobs-board']] as const) {
      fs.writeFileSync(boardPath, content);
      await register(adapter, 'parent', `call-${id}`, `task-${id}`);
      expect(fs.readFileSync(boardPath, 'utf8')).toBe(content);
      expect(adapter.unrecordedLaunches('parent').at(-1)).toMatchObject({ childSessionId: `task-${id}`, reason: expect.stringContaining('does not hold a board with a jobs list') });
    }
    expect(adapter.unrecordedLaunches('other-parent')).toEqual([]);
  });

  it('leaves a completion notification unconsumed while the board is unreadable and still shows its own unrecorded launch', async () => {
    const { adapter, sessions, service, warnings } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-b', 'task-b');
    const registerLaunch = service.registerLaunch;
    service.registerLaunch = (() => { throw new Error('disk full'); }) as typeof service.registerLaunch;
    await register(adapter, 'parent', 'call-a', 'task-a');
    service.registerLaunch = registerLaunch;
    const boardPath = `${TEST_DIR}/.hive/background-jobs.json`;
    const board = fs.readFileSync(boardPath, 'utf8');
    fs.writeFileSync(boardPath, '{"jobs": [');
    const completion = (parent: string) => messages(
      parent,
      '<task id="task-b" state="completed"><task_result>Complete.</task_result></task>',
      { synthetic: true },
    );

    const shown = completion('parent');
    await adapter['experimental.chat.messages.transform']({}, shown);
    const text = shown.messages[0]!.parts.map(part => part.text).join('\n');
    expect(text).toContain('- board unreadable: Hive could not read the background board');
    expect(text).toContain('unrecorded launch (task-a) forager-worker');
    expect(warnings.join('\n')).toContain('completion notification for task-b is left for a later request');

    // Another parent has no gap to show: the board read failure is the caller's and this parent's gap stays private.
    const other = completion('other-parent');
    await expect(adapter['experimental.chat.messages.transform']({}, other)).rejects.toThrow('could not read the background board');
    expect(other.messages[0]!.parts).toHaveLength(1);

    // Once the board reads again, the same notification applies.
    fs.writeFileSync(boardPath, board);
    await adapter['experimental.chat.messages.transform']({}, completion('parent'));
    expect(service.resolve('task-b')).toMatchObject({ runtimeState: 'completed', resultSummary: 'Complete.' });
  });

  it('keeps a task_status sample in the result and says the board did not record it while the board is unreadable', async () => {
    const { adapter, sessions, service, warnings } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-b', 'task-b');
    const registerLaunch = service.registerLaunch;
    service.registerLaunch = (() => { throw new Error('disk full'); }) as typeof service.registerLaunch;
    await register(adapter, 'parent', 'call-a', 'task-a');
    service.registerLaunch = registerLaunch;
    const boardPath = `${TEST_DIR}/.hive/background-jobs.json`;
    const board = fs.readFileSync(boardPath, 'utf8');
    fs.writeFileSync(boardPath, '{"jobs": [');

    const sample = JSON.stringify({ task_id: 'task-b', status: 'completed', result: 'Sampled complete.' });
    const output = { output: sample };
    await adapter['tool.execute.before']({ tool: 'task_status', sessionID: 'parent', callID: 'status-b' }, { args: { task_id: 'task-b' } });
    await adapter['tool.execute.after']({ tool: 'task_status', sessionID: 'parent', callID: 'status-b' }, output);
    expect(output.output.startsWith(sample)).toBe(true);
    expect(output.output).toContain('This task_status sample was not recorded on the board: Hive could not read the background board');
    expect(warnings.join('\n')).toContain('task_status sample for task-b was not recorded on the board');
    expect(fs.readFileSync(boardPath, 'utf8')).toBe('{"jobs": [');

    // The parent's own unrecorded launch is still shown with the read failure.
    const shown = messages('parent');
    await adapter['experimental.chat.messages.transform']({}, shown);
    expect(shown.messages[0]!.parts.map(part => part.text).join('\n')).toContain('unrecorded launch (task-a) forager-worker');

    // A failure other than an unreadable board still fails the call.
    fs.writeFileSync(boardPath, board);
    service.listScoped = (() => { throw new Error('unexpected'); }) as typeof service.listScoped;
    await adapter['tool.execute.before']({ tool: 'task_status', sessionID: 'parent', callID: 'status-c' }, { args: { task_id: 'task-b' } });
    await expect(adapter['tool.execute.after']({ tool: 'task_status', sessionID: 'parent', callID: 'status-c' }, { output: sample })).rejects.toThrow('unexpected');
  });

  it('says a task_status sample was not recorded when the board becomes unreadable between lookup and locked update', async () => {
    const { adapter, sessions, service, warnings } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-b', 'task-b');
    const registerLaunch = service.registerLaunch;
    service.registerLaunch = (() => { throw new Error('disk full'); }) as typeof service.registerLaunch;
    await register(adapter, 'parent', 'call-a', 'task-a');
    service.registerLaunch = registerLaunch;
    const boardPath = `${TEST_DIR}/.hive/background-jobs.json`;
    const markTerminal = service.markTerminal.bind(service);
    // The lookup reads a valid board; the board is corrupted before the locked update rereads it.
    service.markTerminal = ((...args: Parameters<typeof service.markTerminal>) => {
      fs.writeFileSync(boardPath, '{"jobs": [');
      return markTerminal(...args);
    }) as typeof service.markTerminal;

    const sample = JSON.stringify({ task_id: 'task-b', status: 'completed', result: 'Sampled complete.' });
    const output = { output: sample };
    await adapter['tool.execute.before']({ tool: 'task_status', sessionID: 'parent', callID: 'status-b' }, { args: { task_id: 'task-b' } });
    await adapter['tool.execute.after']({ tool: 'task_status', sessionID: 'parent', callID: 'status-b' }, output);
    expect(output.output.startsWith(sample)).toBe(true);
    expect(output.output).toContain('This task_status sample was not recorded on the board: Hive could not read the background board');
    expect(warnings.join('\n')).toContain('task_status sample for task-b was not recorded on the board');
    expect(warnings.join('\n')).not.toContain('failed to update background task task-b');
    expect(fs.readFileSync(boardPath, 'utf8')).toBe('{"jobs": [');
    expect(adapter.unrecordedLaunches('parent')).toEqual([expect.objectContaining({ childSessionId: 'task-a' })]);
  });

  it('says a task_status sample could not be confirmed when its single row update fails for another reason', async () => {
    const { adapter, sessions, service, warnings } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-b', 'task-b');
    // A lock-release failure surfaces after the board write completed.
    const markTerminal = service.markTerminal.bind(service);
    service.markTerminal = ((identifier, state, patch) => {
      markTerminal(identifier, state, patch);
      throw new Error('lock release failed');
    }) as typeof service.markTerminal;

    const sample = JSON.stringify({ task_id: 'task-b', status: 'completed', result: 'Sampled complete.' });
    const output = { output: sample };
    await adapter['tool.execute.before']({ tool: 'task_status', sessionID: 'parent', callID: 'status-b' }, { args: { task_id: 'task-b' } });
    await adapter['tool.execute.after']({ tool: 'task_status', sessionID: 'parent', callID: 'status-b' }, output);
    expect(output.output.startsWith(sample)).toBe(true);
    expect(output.output).toContain('Hive could not confirm this task_status sample was recorded on the board: lock release failed. The row may show this sample or its state as last recorded; inspect it with hive_background_status before relying on it.');
    expect(output.output).not.toContain('was not recorded');
    expect(warnings.join('\n')).toContain('could not confirm the task_status sample for background task task-b was recorded: lock release failed');
    expect(service.resolve('task-b')).toMatchObject({ runtimeState: 'completed' });
  });

  it('says an ambiguous task_status sample was only partly recorded when a later row write fails', async () => {
    const { adapter, sessions, service } = harness();
    sessions.set('parent', session('parent'));
    await register(adapter, 'parent', 'call-1', 'resumed-child');
    await register(adapter, 'parent', 'call-2', 'resumed-child');
    const sample = JSON.stringify({ task_id: 'resumed-child', status: 'completed', result: 'Sampled complete.' });
    const sampleStatus = async (callID: string) => {
      const output = { output: sample };
      await adapter['tool.execute.before']({ tool: 'task_status', sessionID: 'parent', callID }, { args: { task_id: 'resumed-child' } });
      await adapter['tool.execute.after']({ tool: 'task_status', sessionID: 'parent', callID }, output);
      return output.output;
    };

    const updateRuntimeState = service.updateRuntimeState.bind(service);
    const written: string[] = [];
    service.updateRuntimeState = ((identifier, state, patch) => {
      if (written.length > 0) throw new Error('disk full');
      written.push(identifier);
      return updateRuntimeState(identifier, state, patch);
    }) as typeof service.updateRuntimeState;

    const partial = await sampleStatus('status-1');
    expect(partial.startsWith(sample)).toBe(true);
    expect(partial).toContain("matches more than one board row for reused native child 'resumed-child' (parent:job-1, parent:job-2)");
    expect(partial).toContain('some rows may show it as ambiguous while others show their state as last recorded');
    expect(partial).toContain('hive_task_trace({ task_id: "resumed-child" })');
    const [markedAlias] = written;
    const unmarkedAlias = ['parent:job-1', 'parent:job-2'].find(alias => alias !== markedAlias)!;
    expect(service.resolve(markedAlias!)).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
    expect(service.resolve(unmarkedAlias)).toMatchObject({ runtimeState: 'running' });
    expect(service.resolve(unmarkedAlias)).not.toHaveProperty('lastStatusError');

    // Once every matching row is marked, the sample is recorded as ambiguous and carries no notice.
    service.updateRuntimeState = updateRuntimeState;
    expect(await sampleStatus('status-2')).toBe(sample);
    expect(service.resolve(unmarkedAlias)).toMatchObject({ runtimeState: 'unknown', statusUncertain: true });
  });

  it('reports a launch the board could not record to its own parent, in the prompt until that parent acknowledges it', async () => {
    const { adapter, sessions, service, warnings } = harness();
    sessions.set('parent', session('parent'));
    service.registerLaunch = (() => { throw new Error('disk full'); }) as typeof service.registerLaunch;
    await register(adapter, 'parent', 'call-a', 'task-a');

    expect(service.listScoped({}, { includeArchived: true })).toEqual([]);
    expect(warnings.at(-1)).toContain('could not confirm background launch task-a was recorded: disk full');
    expect(adapter.unrecordedLaunches('parent')).toEqual([expect.objectContaining({ parentSessionId: 'parent', callId: 'call-a', childSessionId: 'task-a', agentName: 'forager-worker', reason: 'disk full' })]);
    expect(adapter.unrecordedLaunches('other-parent')).toEqual([]);

    const other = messages('other-parent');
    await adapter['experimental.chat.messages.transform']({}, other);
    expect(other.messages[0]!.parts).toHaveLength(1);
    const shown = messages('parent');
    await adapter['experimental.chat.messages.transform']({}, shown);
    expect(shown.messages[0]!.parts.map(part => part.text).join('\n')).toContain('unrecorded launch (task-a) forager-worker');

    await adapter.event(sessionEvent('session.idle', { sessionID: 'parent' }));
    const after = messages('parent');
    await adapter['experimental.chat.messages.transform']({}, after);
    expect(after.messages[0]!.parts).toHaveLength(1);
    // Acknowledged in the prompt, the gap stays in the parent's board status.
    expect(adapter.unrecordedLaunches('parent')).toHaveLength(1);
  });

  it('reports a launch whose board write failed after the row was written as unconfirmed, never as absent, and keeps the row', async () => {
    const { adapter, sessions, service, warnings } = harness();
    sessions.set('parent', session('parent'));
    // A lock-release failure surfaces after the board write completed.
    const registerLaunch = service.registerLaunch.bind(service);
    service.registerLaunch = ((input) => {
      registerLaunch(input);
      throw new Error('lock release failed');
    }) as typeof service.registerLaunch;
    await register(adapter, 'parent', 'call-a', 'task-a');

    expect(service.listScoped({}, { includeArchived: true })).toEqual([expect.objectContaining({ taskId: 'task-a', callId: 'call-a', runtimeState: 'running' })]);
    expect(warnings.at(-1)).toContain('could not confirm background launch task-a was recorded: lock release failed');
    expect(adapter.unrecordedLaunches('parent')).toEqual([expect.objectContaining({ childSessionId: 'task-a', reason: 'lock release failed' })]);

    const shown = messages('parent');
    await adapter['experimental.chat.messages.transform']({}, shown);
    const prompt = shown.messages[0]!.parts.map(part => part.text).join('\n');
    expect(prompt).toContain('Hive could not confirm this launch was recorded on the board (lock release failed), so the board may have no row for it or a row written before the failure');
    expect(prompt).toContain('do not repeat the launch');
    expect(prompt).not.toContain('not on the board');
    expect(prompt).not.toContain('will not appear');

    const status = createBackgroundOperations({ backgroundJobService: service, projectRoot: TEST_DIR, isEnabled: () => true, currentRuntimeId: 'runtime', unrecordedLaunches: adapter.unrecordedLaunches }).hive_background_status!;
    const result = await status.execute({}, { sessionID: 'parent' }) as { recommendedNextAction?: { action?: string; message?: string } };
    expect(result.recommendedNextAction?.action).toBe('inspect_unrecorded_background_launches');
    expect(result.recommendedNextAction?.message).toContain('each may have no row, or a row written before the failure');
    expect(result.recommendedNextAction?.message).not.toContain('do not appear');
    expect(service.resolve('task-a')).toMatchObject({ callId: 'call-a', runtimeState: 'running' });
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
