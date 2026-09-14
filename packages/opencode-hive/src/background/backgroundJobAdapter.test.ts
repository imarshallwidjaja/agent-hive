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
  const claims = new Map<string, string>();
  const service = new BackgroundJobService(TEST_DIR);
  const adapter = createBackgroundJobAdapter({
    projectRoot: TEST_DIR,
    service,
    isEnabled: () => enabled,
    runtimeId: 'current-runtime',
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
    resolveClaimedLaunchId: (sessionID, callID) => claims.get(`${sessionID}\0${callID}`),
  });

  return { adapter, service, sessions, claims };
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
      sessionId: 'task-launch',
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
    expect(JSON.stringify(board.jobs[0])).not.toContain('hive_task_trace');
  });

  it('marks foreign-runtime jobs stale before injecting the prompt board', async () => {
    const { adapter, service, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1'));
    service.registerLaunch({
      taskId: 'foreign-runtime-task',
      sessionId: 'foreign-runtime-session',
      agentName: 'forager-worker',
      runtimeId: 'old-runtime',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', primaryAgent: 'hive-master' },
    });

    const output = messagesFor('parent-1');
    await adapter['experimental.chat.messages.transform']({}, output);

    const text = injectedText(output);
    const job = service.resolve('foreign-runtime-task');
    expect(job?.runtimeState).toBe('running');
    expect(job?.staleAt).toBeDefined();
    expect(job?.statusUncertain).toBe(true);
    expect(text).toContain('foreign-runtime-task');
    expect(text).toContain('runtime: running; status error: Background worker runtime identity changed');
    expect(text).toContain('coordination: stale/orphan recovery');
    expect(text).not.toContain('coordination: none');
  });

  it('preserves claimed pending launch metadata when prose, wait mode, and specialist selection drift', async () => {
    const { adapter, service, sessions, claims } = createHarness();
    sessions.set('parent-1', session('parent-1', 'swarm-orchestrator'));
    service.registerPendingLaunch({
      launchId: 'launch-drift',
      parentSessionId: 'parent-1',
      expectedDescription: 'Hive: 01-add-root-smoke-documentation-file',
      expectedPrompt: 'Follow instructions in @.hive/features/17_background-smoke-test/tasks/01-add-root-smoke-documentation-file/worker-prompt.md',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', primaryAgent: 'swarm-orchestrator', feature: 'background-smoke-test', task: '01-add-root-smoke-documentation-file' },
      ownership: { worktreePath: path.join(TEST_DIR, '.hive', '.worktrees', 'background-smoke-test', '01-add-root-smoke-documentation-file'), branch: 'hive/background-smoke-test/01-add-root-smoke-documentation-file' },
    });
    claims.set('parent-1\0call-drift', 'launch-drift');

    await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID: 'call-drift' }, {
      args: {
        background: true,
        description: 'Hive: smoke docs',
        prompt: 'Caller-mutated prompt text',
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
      launchId: 'launch-drift',
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

  it('registers claimed launches with unresolved provenance when native output is missing or unparseable', async () => {
    const { adapter, service, sessions, claims } = createHarness();
    sessions.set('parent-1', session('parent-1', 'swarm-orchestrator'));

    for (const [suffix, output] of [
      ['missing', {}],
      ['unparseable', { output: 'Background launch accepted without a task identifier.' }],
    ] as const) {
      const launchId = `launch-${suffix}`;
      const callID = `call-${suffix}`;
      service.registerPendingLaunch({
        launchId,
        parentSessionId: 'parent-1',
        agentName: 'forager-worker',
        scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', primaryAgent: 'swarm-orchestrator', feature: 'feature-a', task: `task-${suffix}` },
        ownership: { branch: `hive/feature-a/task-${suffix}` },
      });
      claims.set(`parent-1\0${callID}`, launchId);

      await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID }, {
        args: { background: true, description: `Claimed ${suffix}`, subagent_type: 'forager-worker' },
      });
      await adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID }, output);
    }

    const board = readBoard();
    expect(board.jobs).toHaveLength(0);
    expect(board.pendingLaunches).toEqual([
      expect.objectContaining({
        launchId: 'launch-missing',
        agentName: 'forager-worker',
        disposition: 'claimed',
        callId: 'call-missing',
        scope: expect.objectContaining({ feature: 'feature-a', task: 'task-missing' }),
        ownership: expect.objectContaining({ branch: 'hive/feature-a/task-missing' }),
      }),
      expect.objectContaining({
        launchId: 'launch-unparseable',
        disposition: 'claimed',
        callId: 'call-unparseable',
      }),
    ]);
    expect(board.jobs.some(job => job.scopeSource === 'native-fallback')).toBe(false);
    const prompt = messagesFor('parent-1');
    await adapter['experimental.chat.messages.transform']({}, prompt);
    expect(injectedText(prompt)).toContain('launch-missing');
    expect(injectedText(prompt)).toContain('Native identity unavailable; execution may still be running');
    expect(injectedText(prompt)).toContain('does not stop execution or authorize a replacement writer');
    const foreignPrompt = messagesFor('parent-2');
    sessions.set('parent-2', session('parent-2'));
    await adapter['experimental.chat.messages.transform']({}, foreignPrompt);
    expect(injectedText(foreignPrompt)).not.toContain('launch-missing');

    // A repeated SDK callback can carry real identity after the original output failed.
    const callback = { tool: 'task', sessionID: 'parent-1', callID: 'call-missing', args: { background: true } };
    const restarted = createBackgroundJobAdapter({ projectRoot: TEST_DIR, service, isEnabled: () => true });
    await restarted['tool.execute.after'](callback, { output: 'task_id: ses-real' });
    await restarted['tool.execute.after'](callback, { output: 'task_id: ses-real' });
    expect(service.listScoped()).toHaveLength(1);
    expect(service.resolve('launch-missing')).toMatchObject({ taskId: 'ses-real', sessionId: 'ses-real', scopeSource: 'pending-launch', ownership: { branch: 'hive/feature-a/task-missing' } });
    await expect(restarted['tool.execute.after'](callback, { output: 'task_id: ses-contradiction' })).rejects.toThrow('contradictory');
    expect(service.listScoped()).toHaveLength(1);
  });

  it('registers the active claim through the after hook when archived call history exists', async () => {
    const { adapter, service, sessions, claims } = createHarness();
    sessions.set('parent-1', session('parent-1', 'swarm-orchestrator'));
    const scope = { projectRoot: TEST_DIR, parentSessionId: 'parent-1', feature: 'feature-a' };
    service.registerPendingLaunch({ launchId: 'archived-launch', parentSessionId: 'parent-1', agentName: 'forager-worker', scope });
    service.claimPendingLaunch({ launchId: 'archived-launch', parentSessionId: 'parent-1', callId: 'reused-call', background: true });
    service.archiveClaimedLaunch('archived-launch', 'parent-1', 'ignored', 'Previous native launch was ignored');
    service.registerPendingLaunch({ launchId: 'active-launch', parentSessionId: 'parent-1', agentName: 'forager-worker', scope });
    claims.set('parent-1\0reused-call', 'active-launch');

    await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID: 'reused-call' }, {
      args: { background: true, description: 'Replacement launch', subagent_type: 'forager-worker' },
    });
    await adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'reused-call' }, {
      output: 'task_id: ses-active',
    });
    await adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'reused-call' }, {
      output: 'task_id: ses-active',
    });

    const history = service.listPendingLaunches({}, { includeArchived: true });
    expect(service.resolve('active-launch')).toMatchObject({ taskId: 'ses-active', launchId: 'active-launch', scopeSource: 'pending-launch' });
    expect(service.listScoped({}, { includeArchived: true })).toHaveLength(1);
    expect(history).toEqual([
      expect.objectContaining({ launchId: 'archived-launch', archiveReason: 'ignored' }),
    ]);
    expect(history[0].registrationError).toBeUndefined();

    await expect(adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'reused-call' }, {
      output: 'task_id: ses-other',
    })).rejects.toThrow('contradictory');
    expect(service.listScoped({}, { includeArchived: true })).toHaveLength(1);
  });

  it('registers a sole archived claim from a late callback without losing the archive decision', async () => {
    const { service } = createHarness();
    const scope = { projectRoot: TEST_DIR, parentSessionId: 'parent-1', feature: 'feature-a' };
    service.registerPendingLaunch({ launchId: 'late-launch', parentSessionId: 'parent-1', agentName: 'forager-worker', scope });
    service.claimPendingLaunch({ launchId: 'late-launch', parentSessionId: 'parent-1', callId: 'late-call', background: true });
    service.archiveClaimedLaunch('late-launch', 'parent-1', 'reconciled', 'Native execution was confirmed externally');
    const restarted = createBackgroundJobAdapter({ projectRoot: TEST_DIR, service, isEnabled: () => true });

    await restarted['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'late-call', args: { background: true } }, {
      output: 'task_id: ses-late',
    });

    expect(service.resolve('late-launch')).toMatchObject({
      taskId: 'ses-late',
      archiveReason: 'reconciled',
      reconciliationSummary: 'Native execution was confirmed externally',
    });
    expect(service.listScoped()).toEqual([]);
  });

  it('retains conflicting claims and clears staged arguments when claimed lookup fails', async () => {
    const { adapter, service } = createHarness();
    await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID: 'ambiguous-call' }, {
      args: { background: true, description: 'Staged background launch', subagent_type: 'forager-worker' },
    });
    for (const launchId of ['archived-1', 'archived-2']) {
      service.registerPendingLaunch({ launchId, parentSessionId: 'parent-1', agentName: 'forager-worker' });
      service.claimPendingLaunch({ launchId, parentSessionId: 'parent-1', callId: 'ambiguous-call', background: true });
      service.archiveClaimedLaunch(launchId, 'parent-1', 'ignored', `Retain ${launchId}`);
    }

    await expect(adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'ambiguous-call' }, {
      output: 'task_id: ses-ambiguous',
    })).rejects.toThrow('ambiguous claimed call');
    expect(service.listPendingLaunches({}, { includeArchived: true })).toHaveLength(2);

    service.finishClaimedLaunch('archived-1', 'parent-1', 'ambiguous-call');
    service.finishClaimedLaunch('archived-2', 'parent-1', 'ambiguous-call');
    await adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'ambiguous-call', args: { background: false } }, {
      output: 'task_id: ses-foreground',
    });
    expect(service.listScoped()).toEqual([]);
  });

  it('stages arguments before consuming pending metadata and preserves the launch for retry on failure', async () => {
    const { adapter, service, sessions, claims } = createHarness();
    sessions.set('parent-1', session('parent-1', 'swarm-orchestrator'));
    service.registerPendingLaunch({
      launchId: 'launch-private-rollback',
      parentSessionId: 'parent-1',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', feature: 'feature-a', task: '01-task' },
    });
    const pending = readBoard().pendingLaunches;
    claims.set('parent-1\0call-private-rollback', 'launch-private-rollback');
    const args = new Proxy({ background: true }, {
      ownKeys: () => { throw new Error('injected staging failure'); },
    });

    await expect(adapter['tool.execute.before']({
      tool: 'task', sessionID: 'parent-1', callID: 'call-private-rollback',
    }, { args })).rejects.toThrow('injected staging failure');
    expect(readBoard().pendingLaunches).toEqual(pending);

    await adapter['tool.execute.before']({
      tool: 'task', sessionID: 'parent-1', callID: 'call-private-rollback',
    }, { args: { background: true } });
    expect(readBoard().pendingLaunches?.[0]).toMatchObject({ disposition: 'claimed', callId: 'call-private-rollback' });
  });

  it('keeps staged task arguments isolated by parent and call', async () => {
    const { adapter, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1'));

    await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID: 'background-call' }, {
      args: { background: true, description: 'Background A', subagent_type: 'scout-researcher' },
    });
    await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID: 'blocking-call' }, {
      args: { background: false, description: 'Blocking B', subagent_type: 'code-reviewer' },
    });
    await adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'blocking-call' }, { output: 'task_id: blocking-task' });
    await adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'background-call' }, { output: 'task_id: background-task' });

    expect(readBoard().jobs).toEqual([
      expect.objectContaining({ taskId: 'background-task', description: 'Background A', agentName: 'scout-researcher' }),
    ]);
  });

  it('preserves claimed provenance when parsing or registration fails after dispatch', async () => {
    const { service, claims } = createHarness();
    for (const failure of ['parse', 'register']) {
      service.registerPendingLaunch({ launchId: failure, parentSessionId: 'parent-1', agentName: 'forager-worker', scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1' } });
      claims.set(`parent-1\0${failure}`, failure);
      const adapter = createBackgroundJobAdapter({ projectRoot: TEST_DIR, service, isEnabled: () => true, resolveClaimedLaunchId: (_parent, call) => claims.get(`parent-1\0${call}`), ...(failure === 'parse' ? { parseLifecycleEvent: () => { throw new Error('parse failure'); } } : {}) });
      await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID: failure }, { args: { background: true } });
      const original = service.registerLaunch;
      if (failure === 'register') service.registerLaunch = () => { throw new Error('register failure'); };
      try {
        await expect(adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: failure }, { output: 'task_id: ses-native' })).rejects.toThrow(`${failure} failure`);
      } finally { service.registerLaunch = original; }
      expect(new BackgroundJobService(TEST_DIR).findClaimedLaunch('parent-1', failure)).toMatchObject({ launchId: failure, disposition: 'claimed', registrationError: `Native registration failed: ${failure} failure` });
      expect(service.sweepExpiredPendingLaunches(0)).toEqual([]);
      expect(service.listScoped()).toHaveLength(0);
    }
  });

  it('reports storage failure while retaining the durable claim instead of restoring preparation', async () => {
    const { service } = createHarness();
    service.registerPendingLaunch({ launchId: 'storage', parentSessionId: 'parent-1', agentName: 'forager-worker', scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1' }, ownership: { branch: 'owned-branch' } });
    const warnings: string[] = [];
    const adapter = createBackgroundJobAdapter({ projectRoot: TEST_DIR, service, isEnabled: () => true, resolveClaimedLaunchId: () => 'storage', warn: message => warnings.push(message) });
    await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID: 'storage-call' }, { args: { background: true } });
    const writer = service as unknown as { writeBoard: (board: BackgroundJobsJson) => void };
    const original = writer.writeBoard;
    writer.writeBoard = () => { throw new Error('disk failure'); };
    try {
      await expect(adapter['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'storage-call' }, { output: 'task_id: ses-storage' })).rejects.toThrow('disk failure');
    } finally { writer.writeBoard = original; }
    expect(warnings.join('\n')).toContain('failed to persist registration error');
    const persisted = new BackgroundJobService(TEST_DIR);
    expect(persisted.findClaimedLaunch('parent-1', 'storage-call')).toMatchObject({ disposition: 'claimed', ownership: { branch: 'owned-branch' } });
    expect(persisted.listScoped()).toEqual([]);
    const restarted = createBackgroundJobAdapter({ projectRoot: TEST_DIR, service: persisted, isEnabled: () => true });
    await restarted['tool.execute.after']({ tool: 'task', sessionID: 'parent-1', callID: 'storage-call' }, { output: 'task_id: ses-storage' });
    expect(persisted.resolve('storage')?.taskId).toBe('ses-storage');
  });

  it('clears pending bookkeeping without registration when a prepared payload is dispatched in blocking mode', async () => {
    const { adapter, service, sessions, claims } = createHarness();
    sessions.set('parent-1', session('parent-1'));
    service.registerPendingLaunch({
      launchId: 'launch-foreground',
      parentSessionId: 'parent-1',
      expectedDescription: 'Hive: 01-task',
      expectedPrompt: 'Follow instructions in @worker-prompt.md',
      agentName: 'forager-worker',
      scope: { projectRoot: TEST_DIR, parentSessionId: 'parent-1', feature: 'feature-a', task: '01-task' },
    });
    claims.set('parent-1\0call-foreground', 'launch-foreground');

    await adapter['tool.execute.before']({ tool: 'task', sessionID: 'parent-1', callID: 'call-foreground' }, {
      args: {
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
    const { adapter, service, sessions, claims } = createHarness();
    sessions.set('parent-1', session('parent-1', 'hive-builder'));
    const expectedPrompt = 'Work in /tmp/adhoc-1 for ad-hoc run adhoc-1.';
    service.registerPendingLaunch({
      launchId: 'launch-adhoc',
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

    claims.set('parent-1\0call-background-adhoc', 'launch-adhoc');
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
    const { adapter, service, sessions } = createHarness();
    sessions.set('parent-1', session('parent-1'));
    await launchTask(adapter, 'parent-1', 'task-status');

    for (const launchId of ['status-history-1', 'status-history-2']) {
      service.registerPendingLaunch({ launchId, parentSessionId: 'parent-1', agentName: 'forager-worker' });
      service.claimPendingLaunch({ launchId, parentSessionId: 'parent-1', callId: 'status-1' });
      service.archiveClaimedLaunch(launchId, 'parent-1', 'ignored', `Historical ${launchId}`);
    }

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
    expect(service.listPendingLaunches({}, { includeArchived: true })).toHaveLength(2);
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
