import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { buildCompactionPrompt } from '../utils/compaction-prompt.js';
import { STANDING_CONSTRAINTS_HEADING } from '../utils/worker-prompt.js';
import type { PluginInput } from '@opencode-ai/plugin';
import { ContextService, FeatureService, SessionService, TaskService, getFeaturePath } from 'hive-core';
import type { Message, Part } from '@opencode-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'node:crypto';

describe('buildCompactionPrompt', () => {
  test('includes resume instruction to continue current task', () => {
    const prompt = buildCompactionPrompt();
    expect(prompt).toContain('Next action: resume from where you left off.');
    expect(prompt).toMatch(/worker|assignment|resume/i);
  });

  test('requires runtime assignment recovery, not an inferred prompt path', () => {
    const prompt = buildCompactionPrompt();
    expect(prompt).toMatch(/runtime assignment recovery/i);
    expect(prompt).not.toContain('worker-prompt.md');
  });

  test('does not instruct calling hive_status on resume', () => {
    const prompt = buildCompactionPrompt();
    expect(prompt).not.toMatch(/hive_status/);
  });

  test('does not instruct re-reading entire codebase or full repo', () => {
    const prompt = buildCompactionPrompt();
    expect(prompt).not.toMatch(/read (the |all |entire |full )?(repo|codebase|project)/i);
  });

  test('instructs to avoid status-tool rediscovery', () => {
    const prompt = buildCompactionPrompt();
    expect(prompt).toMatch(/do not|avoid|skip/i);
    expect(prompt).toMatch(/status/i);
  });

  test('is stable across multiple calls (same output)', () => {
    const prompt1 = buildCompactionPrompt();
    const prompt2 = buildCompactionPrompt();
    expect(prompt1).toBe(prompt2);
  });

  test('is concise (under 600 characters)', () => {
    const prompt = buildCompactionPrompt();
    expect(prompt.length).toBeLessThan(600);
  });
});

function createStubShell(): PluginInput['$'] {
  const fn = ((..._args: unknown[]) => {
    throw new Error('shell not available in this test');
  }) as unknown as PluginInput['$'];
  return Object.assign(fn, {
    braces(pattern: string) { return [pattern]; },
    escape(input: string) { return input; },
    env() { return fn; },
    cwd() { return fn; },
    nothrow() { return fn; },
    throws() { return fn; },
  });
}

function buildCompactionTransformOutput(sessionID: string, cwd: string) {
  return {
    messages: [
      {
        info: {
          id: `msg-summary-${sessionID}`,
          sessionID,
          role: 'assistant',
          time: { created: Date.now() },
          system: [],
          modelID: 'm',
          providerID: 'p',
          mode: 'compaction',
          path: { cwd, root: cwd },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          summary: true,
        } as Message,
        parts: [{ id: `prt-summary-${sessionID}`, sessionID, messageID: `msg-summary-${sessionID}`, type: 'text', text: 'Summary text' } as Part],
      },
      {
        info: {
          id: `msg-continue-${sessionID}`,
          sessionID,
          role: 'user',
          time: { created: Date.now() },
        } as Message,
        parts: [{ id: `prt-continue-${sessionID}`, sessionID, messageID: `msg-continue-${sessionID}`, type: 'text', text: 'Continue if you have next steps.', synthetic: true } as Part],
      },
    ],
  };
}

function bindImmutableAssignment(root: string, sessionService: SessionService, sessionID: string, content: string) {
  const featureName = 'my-feature';
  const taskFolder = '01-task';
  const taskDir = path.join(root, '.hive', 'features', featureName, 'tasks', taskFolder);
  const locator = `.hive/features/${featureName}/tasks/${taskFolder}/assignments/attempt-1.md`;
  fs.mkdirSync(path.join(taskDir, 'assignments'), { recursive: true });
  fs.writeFileSync(path.join(root, locator), content);
  const assignment = {
    format: 'hive-worker-assignment/v1' as const,
    projectRoot: root,
    featureName,
    taskFolder,
    attempt: 1,
    locator,
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
  fs.writeFileSync(path.join(taskDir, 'status.json'), JSON.stringify({
    status: 'in_progress',
    origin: 'plan',
    workerAttempt: 1,
    workerAssignment: assignment,
    workerAttempts: [{ attempt: 1, idempotencyKey: 'attempt-1', state: 'associated', assignment, workerSessionId: sessionID }],
    workerSession: { sessionId: sessionID, attempt: 1 },
  }));
  sessionService.trackGlobal(sessionID, { parentSessionId: 'parent', agent: 'forager-worker', sessionKind: 'task-worker' });
  sessionService.bindWorkerAssignment(sessionID, 'parent', assignment);
  return assignment;
}

describe('compaction replay on supported hooks', () => {
  let testRoot: string;
  let originalHome: string | undefined;
  let hooks: any;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-compaction-test-'));
    process.env.HOME = testRoot;

    fs.mkdirSync(path.join(testRoot, '.hive'), { recursive: true });

    const { execSync } = await import('child_process');
    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@example.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    fs.writeFileSync(path.join(testRoot, 'README.md'), 'test');
    execSync('git add README.md', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const { createOpencodeClient: mkClient } = await import('@opencode-ai/sdk');
    const client = mkClient({ baseUrl: 'http://localhost:1' }) as unknown as PluginInput['client'];
    (client.session as any).update = async () => ({ data: {} });
    (client.session as any).get = async ({ path: inputPath }: { path: { id: string } }) => ({
      data: {
        id: inputPath.id,
        parentID: inputPath.id.startsWith('sess-tw-') || ['race-worker', 'sess-replay', 'sess-capture', 'legacy-worker'].includes(inputPath.id)
          ? 'parent'
          : undefined,
      },
    });

    const { default: pluginFactory } = await import('../index.js');
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL('http://localhost:1'),
      project: { id: 'test', worktree: testRoot, time: { created: Date.now() } },
      client,
      $: createStubShell(),
    };
    hooks = await pluginFactory(ctx);
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch (_) {}
  });

  test('does not register experimental.session.compacting', () => {
    expect(hooks['experimental.session.compacting']).toBeUndefined();
  });

  test('session.compacted marks directive replay pending and messages.transform replays stored directive once', async () => {
    const sessionService = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'sess-replay', agent: 'scout-researcher' }, {
      message: { agent: 'scout-researcher' }, parts: [],
    });
    sessionService.trackGlobal('sess-replay', {
      parentSessionId: 'parent',
      agent: 'scout-researcher',
      sessionKind: 'subagent',
      directivePrompt: 'Inspect the LSP errors in trading/pipeline.py and return findings only.',
      replayDirectivePending: false,
    } as any);

    await hooks.event?.({
      event: {
        type: 'session.compacted',
        properties: { sessionID: 'sess-replay' },
      } as any,
    });

    const marked = sessionService.getGlobal('sess-replay');
    expect(marked?.replayDirectivePending).toBe(true);

    const output = buildCompactionTransformOutput('sess-replay', testRoot);
    await hooks['experimental.chat.messages.transform']?.({}, output as any);

    expect(output.messages).toHaveLength(4);
    const replay = output.messages.find(message => message.parts.some(
      part => (part as any).text?.includes('You are still Scout.'),
    ))!;
    expect(replay.info.role).toBe('user');
    expect((replay.parts[0] as any).text).toContain('You are still Scout.');

    const cleared = sessionService.getGlobal('sess-replay');
    expect(cleared?.replayDirectivePending).toBe(false);
  });

  test('directive replay carries the operator standing constraints register', async () => {
    const sessionService = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'sess-replay-constraints', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    });
    sessionService.trackGlobal('sess-replay-constraints', {
      agent: 'hive-master',
      sessionKind: 'primary',
      directivePrompt: 'Finish the parser task and report verification evidence.',
      replayDirectivePending: false,
    } as any);
    const obsolete = sessionService.addStandingConstraint('sess-replay-constraints', 'Use obsolete wording.');
    const withTemporary = sessionService.addStandingConstraint('sess-replay-constraints', 'Remove this temporary constraint.');
    const current = sessionService.editStandingConstraint(
      'sess-replay-constraints',
      obsolete.entries[0]!.id,
      withTemporary.revision,
      'Follow stop-slop. Humanise the writing. Write like Ivan.',
    );
    sessionService.editStandingConstraint(
      'sess-replay-constraints',
      withTemporary.entries[1]!.id,
      current.revision,
      null,
    );
    expect(sessionService.readStandingConstraints('sess-replay-constraints').constraints)
      .toBe('Follow stop-slop. Humanise the writing. Write like Ivan.');
    await hooks.event?.({
      event: { type: 'session.compacted', properties: { sessionID: 'sess-replay-constraints' } } as any,
    });

    const output = buildCompactionTransformOutput('sess-replay-constraints', testRoot);
    await hooks['experimental.chat.messages.transform']?.({}, output as any);

    const replayText = output.messages.flatMap(message => message.parts)
      .map(part => (part as any).text as string)
      .find(text => text?.includes('You are still Hive.'))!;
    expect(replayText).toContain('You are still Hive.');
    expect(replayText).toContain('Finish the parser task and report verification evidence.');
    expect(replayText).toContain(STANDING_CONSTRAINTS_HEADING);
    expect(replayText).toContain('Follow stop-slop. Humanise the writing. Write like Ivan.');
    expect(replayText).not.toContain('Use obsolete wording.');
    expect(replayText).not.toContain('Remove this temporary constraint.');
    expect(replayText.indexOf(STANDING_CONSTRAINTS_HEADING))
      .toBeGreaterThan(replayText.indexOf('Finish the parser task and report verification evidence.'));
  });

  test('directive replay omits the constraints block when no register is set', async () => {
    const sessionService = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'sess-replay-no-constraints', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    });
    sessionService.trackGlobal('sess-replay-no-constraints', {
      agent: 'hive-master',
      sessionKind: 'primary',
      directivePrompt: 'Finish the parser task and report verification evidence.',
      replayDirectivePending: true,
    } as any);

    const output = buildCompactionTransformOutput('sess-replay-no-constraints', testRoot);
    await hooks['experimental.chat.messages.transform']?.({}, output as any);

    const replayText = output.messages.flatMap(message => message.parts)
      .map(part => (part as any).text as string)
      .find(text => text?.includes('You are still Hive.'))!;
    expect(replayText).toContain('You are still Hive.');
    expect(replayText).not.toContain(STANDING_CONSTRAINTS_HEADING);
  });

  test('session.compacted marks replay pending for task-worker sessions with bounded recovery metadata', async () => {
    const sessionService = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'sess-tw-replay', agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    });
    bindImmutableAssignment(testRoot, sessionService, 'sess-tw-replay', '# Worker assignment');
    sessionService.trackGlobal('sess-tw-replay', {
      agent: 'forager-worker',
      sessionKind: 'task-worker',
      featureName: 'my-feature',
      taskFolder: '01-task',
      workerPromptPath: '.hive/features/my-feature/tasks/01-task/worker-prompt.md',
      replayDirectivePending: false,
    } as any);

    await hooks.event?.({
      event: {
        type: 'session.compacted',
        properties: { sessionID: 'sess-tw-replay' },
      } as any,
    });

    const marked = sessionService.getGlobal('sess-tw-replay');
    expect(marked?.replayDirectivePending).toBe(true);
  });

  test('messages.transform appends worker replay after compaction for task-worker sessions', async () => {
    const sessionService = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'sess-tw-bounded', agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    });
    const assignment = bindImmutableAssignment(testRoot, sessionService, 'sess-tw-bounded', '# Immutable assignment\n\nContinue exact task.');
    sessionService.trackGlobal('sess-tw-bounded', { replayDirectivePending: true });

    const output = buildCompactionTransformOutput('sess-tw-bounded', testRoot);
    await hooks['experimental.chat.messages.transform']?.({}, output as any);

    const replayText = output.messages.flatMap(message => message.parts)
      .map(part => (part as any).text as string)
      .find(text => text?.includes('Post-compaction recovery'))!;
    expect(replayText).toContain('Post-compaction recovery');
    expect(replayText).toContain('# Immutable assignment');
    expect(replayText).toContain(`attempt ${assignment.attempt}`);
    expect(replayText).not.toContain('@.hive/features');
    expect(replayText).not.toContain(['checkpoint', '.json'].join(''));
    expect(replayText).not.toContain('status.json');
    expect(replayText).not.toContain('spec.md');

    const cleared = sessionService.getGlobal('sess-tw-bounded');
    expect(cleared?.replayDirectivePending).toBe(false);
  });

  test('worker replay fails explicitly when immutable assignment bytes change', async () => {
    const sessionService = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'sess-tw-tampered', agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    });
    const assignment = bindImmutableAssignment(testRoot, sessionService, 'sess-tw-tampered', '# Original assignment');
    fs.writeFileSync(path.join(testRoot, assignment.locator), '# Tampered assignment');
    sessionService.trackGlobal('sess-tw-tampered', { replayDirectivePending: true });

    const output = buildCompactionTransformOutput('sess-tw-tampered', testRoot);
    await hooks['experimental.chat.messages.transform']?.({}, output as any);

    const replayText = output.messages.flatMap(message => message.parts)
      .map(part => (part as any).text as string)
      .find(text => text?.includes('assignment_recovery_error'))!;
    expect(replayText).toContain('assignment_recovery_error');
    expect(replayText).toContain('hash does not match');
  });

  test('legacy mixed prompts fail reanchor without reading or replaying their bodies', async () => {
    const sessions = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'legacy-worker', agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    });
    const legacy = path.join(testRoot, 'worker-prompt.md');
    fs.writeFileSync(legacy, 'MANDATORY OLD TASK\nSTALE SUPPORTING BODY');
    sessions.trackGlobal('legacy-worker', { agent: 'forager-worker', sessionKind: 'task-worker', parentSessionId: 'parent', workerPromptPath: legacy, replayDirectivePending: true });
    const read = spyOn(fs, 'readFileSync');
    try {
      const output = buildCompactionTransformOutput('legacy-worker', testRoot);
      await hooks['experimental.chat.messages.transform']({}, output);
      const text = output.messages.flatMap(message => message.parts).map(part => (part as any).text).join('\n');
      expect(text).toContain('legacy_assignment_reanchor_required');
      expect(text).not.toContain('STALE SUPPORTING BODY');
      expect(read.mock.calls.some(call => call[0] === legacy)).toBe(false);
    } finally { read.mockRestore(); }
  });

  test('compaction reconstructs live context for a polluted authenticated primary', async () => {
    const sessions = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'polluted-primary', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    });
    sessions.trackGlobal('polluted-primary', {
      taskFolder: '01-stale-task',
      workerPromptPath: '.hive/features/old/tasks/01-stale-task/worker-prompt.md',
    });

    await hooks.event({
      event: { type: 'session.compacted', properties: { sessionID: 'polluted-primary' } },
    });
    const output = buildCompactionTransformOutput('polluted-primary', testRoot);
    await hooks['experimental.chat.messages.transform']({}, output);

    const catalogText = output.messages.flatMap(message => message.parts)
      .map(part => (part as any).text as string)
      .find(text => text?.startsWith('[hive-live-context-catalog/v1]'))!;
    expect(catalogText).toContain('"status":"available"');
    expect(catalogText).not.toContain('legacy_assignment_reanchor_required');
    expect(sessions.getGlobal('polluted-primary')).toMatchObject({
      taskFolder: '01-stale-task',
      workerPromptPath: '.hive/features/old/tasks/01-stale-task/worker-prompt.md',
    });
  });

  test.each([
    ['null worker assignment', { workerAssignment: null }],
    ['empty ad-hoc run', { adHocRunId: '' }],
    ['false assignment source', { assignmentSourceSessionId: false }],
    ['null duplicate source', { duplicatedFromSessionId: null }],
    ['empty stored parent', { parentSessionId: '' }],
  ])('compaction rejects isolated malformed provenance: %s', async (_label, malformed) => {
    const sessionID = 'malformed-primary';
    const sessions = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID, agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    });
    const registry = path.join(testRoot, '.hive/sessions.json');
    const data = JSON.parse(fs.readFileSync(registry, 'utf8'));
    Object.assign(data.sessions.find((session: any) => session.sessionId === sessionID), malformed);
    fs.writeFileSync(registry, JSON.stringify(data));

    await hooks.event({
      event: { type: 'session.compacted', properties: { sessionID } },
    });
    const output = buildCompactionTransformOutput(sessionID, testRoot);
    await hooks['experimental.chat.messages.transform']({}, output);

    const catalogText = output.messages.flatMap(message => message.parts)
      .map(part => (part as any).text as string)
      .find(text => text?.startsWith('[hive-live-context-catalog/v1]'))!;
    expect(catalogText).toContain('assignment_recovery_error');
    expect(catalogText).not.toContain('"status":"available"');
  });

  test('compaction does not recover a polluted stored primary after restart without runtime agent observation', async () => {
    const sessionID = 'unobserved-polluted-primary';
    const sessions = new SessionService(testRoot);
    sessions.trackGlobal(sessionID, {
      agent: 'hive-master',
      baseAgent: 'hive-master',
      sessionKind: 'primary',
      taskFolder: '01-stale-task',
      workerPromptPath: '.hive/features/old/tasks/01-stale-task/worker-prompt.md',
    });

    await hooks.event({
      event: { type: 'session.compacted', properties: { sessionID } },
    });
    const output = buildCompactionTransformOutput(sessionID, testRoot);
    await hooks['experimental.chat.messages.transform']({}, output);

    const catalogText = output.messages.flatMap(message => message.parts)
      .map(part => (part as any).text as string)
      .find(text => text?.startsWith('[hive-live-context-catalog/v1]'))!;
    expect(catalogText).toContain('context_authorization_denied');
    expect(catalogText).toContain('runtime agent identity is unavailable');
    expect(catalogText).not.toContain('"status":"available"');
  });

  test('private review recipients and descendants refresh with zero live storage reads', async () => {
    const sessions = new SessionService(testRoot);
    sessions.trackGlobal('private-review', { agent: '__hive_dash_review_primary', sessionKind: 'primary' });
    sessions.trackGlobal('private-descendant', { agent: 'scout-researcher', sessionKind: 'subagent', parentSessionId: 'private-review' });
    const catalog = spyOn(ContextService.prototype, 'readCatalog');
    const content = spyOn(ContextService.prototype, 'readContent');
    try {
      for (const sessionID of ['private-review', 'private-descendant']) {
        const output = buildCompactionTransformOutput(sessionID, testRoot);
        await hooks['experimental.chat.messages.transform']({}, output);
        expect(output.messages.flatMap(message => message.parts).some(part => (part as any).text?.includes('[hive-live-context-catalog/v1]'))).toBe(false);
      }
      expect(catalog).not.toHaveBeenCalled();
      expect(content).not.toHaveBeenCalled();
    } finally { catalog.mockRestore(); content.mockRestore(); }
  });

  test('denied reconstruction does not capture or replay directives or assignments', async () => {
    const sessions = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'denied-worker', agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    });
    bindImmutableAssignment(testRoot, sessions, 'denied-worker', '# PRIVATE ASSIGNMENT');
    sessions.trackGlobal('denied-worker', { replayDirectivePending: true });
    // Runtime observation can disagree with immutable storage after a rejected transition.
    await expect(hooks['chat.message']({ sessionID: 'denied-worker', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    })).rejects.toThrow();
    const before = sessions.getGlobal('denied-worker');
    const output = buildCompactionTransformOutput('denied-worker', testRoot);
    await hooks['experimental.chat.messages.transform']({}, output);
    expect(sessions.getGlobal('denied-worker')).toEqual(before);
    const text = output.messages.flatMap(message => message.parts).map(part => (part as any).text).join('\n');
    expect(text).toContain('context_authorization_denied');
    expect(text).not.toContain('PRIVATE ASSIGNMENT');

    await hooks['chat.message']({ sessionID: 'denied-primary', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    });
    sessions.trackGlobal('denied-primary', { parentSessionId: 'contradiction', directivePrompt: 'OLD', replayDirectivePending: true });
    const primaryBefore = sessions.getGlobal('denied-primary');
    await hooks.event({ event: { type: 'session.compacted', properties: { sessionID: 'denied-primary' } } });
    const primaryOutput = buildCompactionTransformOutput('denied-primary', testRoot);
    (primaryOutput.messages[1].parts[0] as any).synthetic = false;
    (primaryOutput.messages[1].parts[0] as any).text = 'NEW DIRECTIVE';
    await hooks['experimental.chat.messages.transform']({}, primaryOutput);
    expect(sessions.getGlobal('denied-primary')).toEqual(primaryBefore);
  });

  test('contradictory observed agents leave persisted and runtime identity unchanged', async () => {
    const sessions = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'agent-conflict', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    });
    const before = sessions.getGlobal('agent-conflict');
    await expect(hooks['chat.message']({ sessionID: 'agent-conflict', agent: 'forager-worker' }, {
      message: { agent: 'hive-master' }, parts: [],
    })).rejects.toThrow(/context_authorization_denied/);
    expect(sessions.getGlobal('agent-conflict')).toEqual(before);
    await hooks['tool.execute.before']({ sessionID: 'agent-conflict', tool: 'read' }, { args: {} });
  });

  test.each([
    ['hive-master', 'hive-master'],
    ['hive-master', undefined],
    [undefined, 'hive-master'],
  ])('matching or one-sided agent observation authorizes the primary (%s, %s)', async (inputAgent, messageAgent) => {
    await hooks['chat.message']({ sessionID: 'observed-primary', agent: inputAgent }, {
      message: { agent: messageAgent }, parts: [],
    });
    expect(new SessionService(testRoot).getGlobal('observed-primary')).toMatchObject({
      agent: 'hive-master', baseAgent: 'hive-master', sessionKind: 'primary',
    });
    await hooks['tool.execute.before']({ sessionID: 'observed-primary', tool: 'read' }, { args: {} });
  });

  test('stored feature traversal is denied before feature lookup', async () => {
    const sessions = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'feature-traversal', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    });
    sessions.trackGlobal('feature-traversal', { featureName: '../../outside' });
    const get = spyOn(FeatureService.prototype, 'get');
    try {
      const output = buildCompactionTransformOutput('feature-traversal', testRoot);
      await hooks['experimental.chat.messages.transform']({}, output);
      expect(get).not.toHaveBeenCalled();
      expect(JSON.stringify(output)).toContain('assignment_recovery_error');
    } finally { get.mockRestore(); }
  });

  test('duplicate chains preserve canonical ownership and conflicting events roll back', async () => {
    const sessions = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'original', agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    });
    bindImmutableAssignment(testRoot, sessions, 'original', '# Canonical assignment');
    sessions.trackGlobal('original', { standingConstraints: 'Keep this constraint' });
    const duplicate = async (id: string, source: string) => hooks.event({ event: {
      type: 'session.created', properties: { info: { id, metadata: { agentHive: { originSessionId: source } } } },
    } });
    await duplicate('copy', 'original');
    await duplicate('nested-copy', 'copy');
    expect(sessions.getGlobal('nested-copy')).toMatchObject({
      assignmentSourceSessionId: 'original', duplicatedFromSessionId: 'copy', standingConstraints: 'Keep this constraint',
    });
    await hooks['chat.message']({ sessionID: 'nested-copy', agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    });
    await hooks['tool.execute.before']({ sessionID: 'nested-copy', tool: 'read' }, { args: {} });
    const before = sessions.getGlobal('nested-copy');
    await expect(duplicate('nested-copy', 'original')).rejects.toThrow(/immutable/);
    expect(sessions.getGlobal('nested-copy')).toEqual(before);
  });

  test('delegated helper retains ordinary and merge tools while managed context and dispatch stay denied', async () => {
    const sessionID = 'sess-replay';
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: sessionID, parentID: 'parent' } } } });
    await hooks['chat.message']({ sessionID, agent: 'hive-helper' }, { message: { agent: 'hive-helper' }, parts: [] });
    for (const tool of ['read', 'bash', 'hive_status', 'hive_merge']) {
      await hooks['tool.execute.before']({ sessionID, tool }, { args: {} });
    }
    const result = JSON.parse(await hooks.tool.hive_context_read.execute({ scope: 'project' }, { sessionID, agent: 'hive-helper' }));
    expect(result.reason).toBe('context_authorization_denied');
    await expect(hooks['tool.execute.before']({ sessionID, tool: 'task' }, { args: { subagent_type: 'scout-researcher' } })).rejects.toThrow();
  });

  test('runtime authenticated primary fork retains full primary authority', async () => {
    await hooks['chat.message']({ sessionID: 'primary-source', agent: 'hive-master' }, { message: { agent: 'hive-master' }, parts: [] });
    new SessionService(testRoot).trackGlobal('primary-source', { taskFolder: 'stale', workerPromptPath: '/stale' });
    const sessionID = 'primary-fork';
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: sessionID, metadata: { agentHive: { originSessionId: 'primary-source' } } } } } });
    await hooks['chat.message']({ sessionID, agent: 'hive-master' }, { message: { agent: 'hive-master' }, parts: [] });
    for (const tool of ['read', 'bash', 'glob']) {
      await hooks['tool.execute.before']({ sessionID, tool }, { args: {} });
    }
    for (const tool of ['task', 'hive_merge', 'hive_feature_create', 'hive_constraints_add']) {
      await hooks['tool.execute.before']({ sessionID, tool }, { args: { subagent_type: 'scout-researcher' } });
    }
    const result = JSON.parse(await hooks.tool.hive_context_read.execute({ scope: 'project' }, { sessionID, agent: 'hive-master' }));
    expect(result.reason).not.toBe('context_authorization_denied');
    const features = new FeatureService(testRoot);
    features.create('fork-read');
    const featurePath = getFeaturePath(testRoot, 'fork-read');
    fs.writeFileSync(path.join(featurePath, 'plan.md'), '# Read-only plan');
    const sessions = new SessionService(testRoot);
    sessions.bindFeature('primary-source', 'fork-read');
    for (const tool of ['hive_status', 'hive_plan_read', 'hive_repositories_status', 'hive_repositories_discover']) {
      await hooks['tool.execute.before']({ sessionID, tool }, { args: { feature: 'fork-read' } });
      const value = await hooks.tool[tool].execute({ feature: 'fork-read' }, { sessionID, agent: 'hive-master' });
      expect(value).not.toMatch(/Error:|context_authorization_denied/);
    }
  });

  test('generic duplicate event uses conflict-safe origin copy', async () => {
    const sessions = new SessionService(testRoot);
    sessions.trackGlobal('source', { sessionKind: 'primary', featureName: 'source-feature' });
    sessions.trackGlobal('recipient', { parentSessionId: 'parent' });
    const registry = path.join(testRoot, '.hive/sessions.json');
    const before = fs.readFileSync(registry, 'utf8');
    await expect(hooks.event({ event: { type: 'session.created', properties: { info: { id: 'recipient', metadata: { agentHive: { originSessionId: 'source' } } } } } })).rejects.toThrow(/immutable/);
    expect(fs.readFileSync(registry, 'utf8')).toBe(before);
  });

  test.each([null, false, {}, { format: 'hive-worker-assignment/v1' }, 'malformed'])('malformed assignment continuity warns and continues without recipient state (%j)', async (malformed) => {
    const sessions = new SessionService(testRoot);
    sessions.trackGlobal('source', { sessionKind: 'primary' });
    const registry = path.join(testRoot, '.hive/sessions.json');
    const data = JSON.parse(fs.readFileSync(registry, 'utf8'));
    data.sessions[0].workerAssignment = malformed;
    fs.writeFileSync(registry, JSON.stringify(data));
    const before = fs.readFileSync(registry);
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    const generic = spyOn(SessionService.prototype, 'copySessionOrigin');
    const worker = spyOn(SessionService.prototype, 'copyWorkerAssignment');
    try {
      await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'recipient', metadata: { agentHive: { originSessionId: 'source' } } } } } });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('Optional origin continuity unavailable (invalid_worker_assignment)'));
      expect(worker).toHaveBeenCalledTimes(1);
      expect(generic).not.toHaveBeenCalled();
      expect(sessions.getGlobal('recipient')).toBeUndefined();
      expect(fs.readFileSync(registry)).toEqual(before);
    } finally {
      warning.mockRestore(); generic.mockRestore(); worker.mockRestore();
    }
  });

  test.each(['generic', 'worker'])('unexpected %s copy errors propagate from session creation', async (kind) => {
    const sessions = new SessionService(testRoot);
    if (kind === 'worker') bindImmutableAssignment(testRoot, sessions, 'source', '# Assignment');
    else sessions.trackGlobal('source', { sessionKind: 'primary' });
    const error = new Error('unexpected copy failure');
    const copy = spyOn(SessionService.prototype, kind === 'worker' ? 'copyWorkerAssignment' : 'copySessionOrigin').mockImplementation(() => { throw error; });
    try {
      await expect(hooks.event({ event: { type: 'session.created', properties: { info: { id: 'recipient', metadata: { agentHive: { originSessionId: 'source' } } } } } })).rejects.toThrow(error);
      expect(sessions.getGlobal('recipient')).toBeUndefined();
    } finally { copy.mockRestore(); }
  });

  test.each([
    { agent: 'hive-master', baseAgent: 'hive-master', sessionKind: 'primary' as const },
    { agent: 'forager-worker', baseAgent: 'forager-worker', sessionKind: 'task-worker' as const, parentSessionId: 'old-parent' },
  ])('duplicate event rejects preexisting recipient identity without changing constraints (%j)', async (identity) => {
    const sessions = new SessionService(testRoot);
    bindImmutableAssignment(testRoot, sessions, 'source', '# Assignment');
    sessions.trackGlobal('recipient', identity);
    sessions.addStandingConstraint('recipient', 'Retain this register');
    const before = sessions.getGlobal('recipient');
    await expect(hooks.event({ event: { type: 'session.created', properties: { info: { id: 'recipient', metadata: { agentHive: { originSessionId: 'source' } } } } } })).rejects.toThrow(/immutable/);
    expect(sessions.getGlobal('recipient')).toEqual(before);
  });

  test('no-parent duplicate rejects stored parent provenance before ordinary tool admission', async () => {
    const sessions = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'source', agent: 'forager-worker' }, { message: { agent: 'forager-worker' }, parts: [] });
    bindImmutableAssignment(testRoot, sessions, 'source', '# Assignment');
    sessions.copyWorkerAssignment('hybrid', 'source');
    // Simulate a hybrid record persisted by an older writer.
    const registry = path.join(testRoot, '.hive', 'sessions.json');
    const data = JSON.parse(fs.readFileSync(registry, 'utf8'));
    data.sessions.find((session: any) => session.sessionId === 'hybrid').parentSessionId = 'old-parent';
    fs.writeFileSync(registry, JSON.stringify(data));
    await hooks['chat.message']({ sessionID: 'hybrid', agent: 'forager-worker' }, { message: { agent: 'forager-worker' }, parts: [] });
    await expect(hooks['tool.execute.before']({ sessionID: 'hybrid', tool: 'read' }, { args: {} })).rejects.toThrow(/context_authorization_denied/);
  });

  test('conflicting repeated duplicate events preserve the entire recipient', async () => {
    const sessions = new SessionService(testRoot);
    const assignment = bindImmutableAssignment(testRoot, sessions, 'source-a', '# Assignment');
    sessions.bindWorkerAssignment('source-b', 'parent', { ...assignment, attempt: 2, locator: assignment.locator.replace('attempt-1.md', 'attempt-2.md') }, {
      agent: 'forager-worker', baseAgent: 'forager-worker', sessionKind: 'task-worker', standingConstraints: 'Other constraints',
    });
    const duplicate = (source: string) => hooks.event({ event: {
      type: 'session.created', properties: { info: { id: 'recipient', metadata: { agentHive: { originSessionId: source } } } },
    } });
    await duplicate('source-a');
    const before = sessions.getGlobal('recipient');
    await expect(duplicate('source-b')).rejects.toThrow(/immutable/);
    expect(sessions.getGlobal('recipient')).toEqual(before);
  });

  test('worker replay consumes the same bytes that passed hash validation', async () => {
    const sessions = new SessionService(testRoot);
    await hooks['chat.message']({ sessionID: 'race-worker', agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    });
    const assignment = bindImmutableAssignment(testRoot, sessions, 'race-worker', '# Verified original');
    sessions.trackGlobal('race-worker', { replayDirectivePending: true });
    const artifact = path.join(testRoot, assignment.locator);
    const status = spyOn(TaskService.prototype, 'getRawStatus');
    const read = fs.readFileSync;
    let artifactReads = 0;
    const spy = spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      const bytes = (read as any)(file, ...args);
      if (file === artifact && ++artifactReads === 1) fs.writeFileSync(artifact, '# UNVERIFIED REPLAY');
      return bytes;
    }) as any);
    try {
      const output = buildCompactionTransformOutput('race-worker', testRoot);
      await hooks['experimental.chat.messages.transform']({}, output);
      const text = output.messages.flatMap(message => message.parts).map(part => (part as any).text).join('\n');
      expect(text).not.toContain('UNVERIFIED REPLAY');
      expect(text).toContain('Post-compaction recovery: replaying hash-verified immutable assignment');
      expect(text).toContain('# Verified original');
      expect(artifactReads).toBe(1);
      expect(status).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      status.mockRestore();
    }
  });

  test.each(['user', 'assistant'])('catalog refresh preserves a real %s marker-prefixed message', async (role) => {
    const sessions = new SessionService(testRoot);
    sessions.trackGlobal('marker-user', { agent: 'hive-master', sessionKind: 'primary' });
    const original = {
      info: { id: 'real-message', sessionID: 'marker-user', role, time: { created: Date.now() } },
      parts: [{ id: 'real-part', sessionID: 'marker-user', messageID: 'real-message', type: 'text', text: '[hive-live-context-catalog/v1]\nQuoted by a person.' }],
    };
    const output = { messages: [original] };
    await hooks['experimental.chat.messages.transform']({}, output);
    expect(output.messages).toContainEqual(original);
  });


  test('messages.transform captures initial non-synthetic user directive for later recovery', async () => {
    await hooks['chat.message']({ sessionID: 'sess-capture', agent: 'scout-researcher' }, {
      message: { agent: 'scout-researcher' }, parts: [],
    });
    new SessionService(testRoot).trackGlobal('sess-capture', { parentSessionId: 'parent' });
    const output = {
      messages: [
        {
          info: {
            id: 'msg-user',
            sessionID: 'sess-capture',
            role: 'user',
            time: { created: Date.now() },
          } as Message,
          parts: [
            {
              id: 'prt-user',
              sessionID: 'sess-capture',
              messageID: 'msg-user',
              type: 'text',
              text: 'Investigate why the compacted scout forgot its role and return findings only.',
            } as Part,
          ],
        },
      ],
    };

    await hooks['experimental.chat.messages.transform']?.({}, output as any);

    const sessionService = new SessionService(testRoot);
    const session = sessionService.getGlobal('sess-capture');
    expect(session?.directivePrompt).toBe('Investigate why the compacted scout forgot its role and return findings only.');
  });
});
