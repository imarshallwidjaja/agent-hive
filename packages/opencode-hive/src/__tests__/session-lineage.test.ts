import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk';
import plugin from '../index';
import { buildStandingConstraintsBlock } from '../utils/worker-prompt.js';

const TEST_ROOT_BASE = '/tmp/hive-session-lineage';
const TEST_PROCESS_CWD = process.cwd();
const CONSTRAINTS = 'Be concise. No markdown fluff.';
const CONSTRAINTS_BLOCK = buildStandingConstraintsBlock(CONSTRAINTS)!;

function createStubShell(): PluginInput['$'] {
  let shell: PluginInput['$'];
  const fn = ((..._args: unknown[]) => {
    throw new Error('shell not available in this test');
  }) as unknown as PluginInput['$'];

  shell = Object.assign(fn, {
    braces(pattern: string) { return [pattern]; },
    escape(input: string) { return input; },
    env() { return shell; },
    cwd() { return shell; },
    nothrow() { return shell; },
    throws() { return shell; },
  });
  return shell;
}

function parseToolJson<T>(raw: unknown): T {
  return JSON.parse(raw as string) as T;
}

describe('session origin stamp and lineage tracking', () => {
  let testRoot: string;
  let sessionStore: Record<string, { id: string; parentID?: string; title?: string; metadata?: Record<string, any> }>;
  let opencodeClient: PluginInput['client'];

  beforeEach(() => {
    process.chdir(TEST_PROCESS_CWD);
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'project-'));

    sessionStore = {};
    const client = createOpencodeClient({ baseUrl: 'http://localhost:1' }) as unknown as PluginInput['client'];
    (client.session as any).get = async (input: { path: { id: string } }) => {
      const existing = sessionStore[input.path.id] ?? {
        id: input.path.id,
        projectID: 'test',
        directory: testRoot,
        title: 'Session ' + input.path.id,
        version: '1',
        time: { created: 1, updated: 1 },
      };
      return { data: existing };
    };
    (client.session as any).update = async (input: { path: { id: string }; body: any }) => {
      const session = sessionStore[input.path.id] ?? {
        id: input.path.id,
        projectID: 'test',
        directory: testRoot,
        title: 'Session ' + input.path.id,
        version: '1',
        time: { created: 1, updated: 1 },
      };
      if (input.body?.title) session.title = input.body.title;
      if (input.body?.metadata) session.metadata = input.body.metadata;
      sessionStore[input.path.id] = session;
      return { data: session };
    };

    opencodeClient = client;
  });

  afterEach(() => {
    process.chdir(TEST_PROCESS_CWD);
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
  });

  async function loadTestHooks(directory: string) {
    return plugin({
      directory,
      worktree: directory,
      serverUrl: new URL('http://localhost:1'),
      project: { id: 'test', worktree: directory, time: { created: Date.now() } },
      client: opencodeClient,
      $: createStubShell(),
    });
  }

  it('stamps unconstrained primary observation before a metadata-cloned backup is created', async () => {
    const hooks = await loadTestHooks(testRoot);
    await hooks['chat.message']!({ sessionID: 'origin', agent: 'hive-master' } as any, { message: { agent: 'hive-master' }, parts: [] } as any);
    expect(sessionStore.origin?.metadata?.agentHive?.originSessionId).toBe('origin');
    const metadata = structuredClone(sessionStore.origin.metadata);
    await hooks['chat.message']!({ sessionID: 'origin', agent: 'hive-master' } as any, { message: { agent: 'hive-master' }, parts: [] } as any);
    expect(sessionStore.origin.metadata).toEqual(metadata);
    sessionStore.backup = { id: 'backup', metadata };
    await hooks.event!({ event: { type: 'session.created', properties: { info: sessionStore.backup } } } as any);
    await hooks['chat.message']!({ sessionID: 'backup', agent: 'hive-master' } as any, { message: { agent: 'hive-master' }, parts: [] } as any);
    await hooks['tool.execute.before']!({ sessionID: 'backup', tool: 'read' } as any, { args: {} });
    for (const tool of ['task', 'hive_feature_create']) {
      await hooks['tool.execute.before']!({ sessionID: 'backup', tool } as any, { args: {} });
    }
    sessionStore.child = { id: 'child', parentID: 'origin' };
    await hooks['chat.message']!({ sessionID: 'child', agent: 'architect-planner' } as any, { message: { agent: 'architect-planner' }, parts: [] } as any);
    expect(sessionStore.child.metadata).toBeUndefined();
  });

  it('warns on missing optional origin continuity without rejecting session creation or creating partial Hive state', async () => {
    const hooks = await loadTestHooks(testRoot);
    sessionStore.backup = { id: 'backup', metadata: { agentHive: { originSessionId: 'missing' } } };
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await hooks.event!({ event: { type: 'session.created', properties: { info: sessionStore.backup } } } as any);
      const registryPath = path.join(testRoot, '.hive', 'sessions.json');
      expect(fs.existsSync(registryPath)).toBe(false);
      expect(warning.mock.calls.some(args => String(args[0]).includes('[hive:session] Optional origin continuity unavailable'))).toBe(true);
      expect(sessionStore.backup.metadata?.agentHive?.originSessionId).toBe('backup');
      await hooks['chat.message']!({ sessionID: 'backup', agent: 'hive-master' } as any, { message: { agent: 'hive-master' }, parts: [] } as any);
      await hooks['tool.execute.before']!({ sessionID: 'backup', tool: 'read' } as any, { args: {} });
    } finally {
      warning.mockRestore();
    }
  });

  it('keeps non-Hive child tools without granting Hive authority or injecting catalogs', async () => {
    const hooks = await loadTestHooks(testRoot);
    sessionStore.child = { id: 'child', parentID: 'parent' };
    await hooks['chat.message']!({ sessionID: 'child', agent: 'general' } as any, { message: { agent: 'general' }, parts: [] } as any);
    await hooks['tool.execute.before']!({ sessionID: 'child', tool: 'read' } as any, { args: {} });
    const output = { system: [] as string[] };
    await hooks['experimental.chat.system.transform']!({ sessionID: 'child' } as any, output);
    expect(output.system.join('')).not.toContain('hive-live-context-catalog');
    await expect(hooks['tool.execute.before']!({ sessionID: 'child', tool: 'hive_feature_create' } as any, { args: { name: 'unauthorized' } })).rejects.toThrow(/context_authorization_denied/);
  });

  it('retains primary tools after origin stamping fails and a backup is promoted', async () => {
    (opencodeClient.session as any).update = async () => { throw new Error('metadata unsupported'); };
    const hooks = await loadTestHooks(testRoot);
    for (const sessionID of ['origin', 'backup']) {
      await hooks.event!({ event: { type: 'session.created', properties: { info: { id: sessionID } } } } as any);
      await hooks['chat.message']!({ sessionID, agent: 'hive-master' } as any, { message: { agent: 'hive-master' }, parts: [] } as any);
      for (const tool of ['read', 'task', 'hive_feature_create']) {
        await hooks['tool.execute.before']!({ sessionID, tool } as any, { args: {} });
      }
    }
  });

  it('denies plan-read revalidation without changing session or ownership bytes', async () => {
    const hooks = await loadTestHooks(testRoot);
    const sessionID = 'primary';
    await hooks['chat.message']!({ sessionID, agent: 'hive-master' } as any, { message: { agent: 'hive-master' }, parts: [] } as any);
    const { FeatureService, SessionService, getFeaturePath } = await import('hive-core');
    new FeatureService(testRoot).create('plan-read');
    new SessionService(testRoot).bindFeature('owner', 'plan-read');
    const featurePath = getFeaturePath(testRoot, 'plan-read');
    fs.writeFileSync(path.join(featurePath, 'plan.md'), '# Plan');
    const paths = [path.join(testRoot, '.hive/sessions.json'), path.join(featurePath, 'sessions.json'), path.join(featurePath, 'feature.json')];
    const before = paths.map(file => fs.readFileSync(file, 'utf8'));
    const get = opencodeClient.session.get;
    let calls = 0;
    (opencodeClient.session as any).get = async (...args: any[]) => {
      if (++calls === 2) throw new Error('runtime unavailable');
      return (get as any)(...args);
    };
    await hooks['tool.execute.before']!({ sessionID, tool: 'hive_plan_read' } as any, { args: { feature: 'plan-read' } });
    const result = JSON.parse(await hooks.tool!.hive_plan_read.execute({ feature: 'plan-read' }, { sessionID, agent: 'hive-master' } as any) as string);
    expect(result.reason).toBe('context_authorization_denied');
    expect(paths.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
  });

  it('stamps session origin in metadata when hive_constraints_add is called', async () => {
    const hooks = await loadTestHooks(testRoot);
    const sessionID = 'sess_primary_1';

    const result = parseToolJson<{ success?: boolean }>(
      await hooks.tool!.hive_constraints_add.execute(
        { constraints: CONSTRAINTS },
        { sessionID, messageID: 'msg_1', agent: 'test', abort: new AbortController().signal },
      ),
    );
    expect(result.success).toBe(true);

    // Verify sessionStore has originSessionId in metadata
    expect(sessionStore[sessionID]?.metadata?.agentHive?.originSessionId).toBe(sessionID);
  });

  it('records parentSessionId when session.created has parentID', async () => {
    const hooks = await loadTestHooks(testRoot);
    const childID = 'sess_child_1';
    const parentID = 'sess_parent_1';

    await hooks.event?.({
      event: {
        type: 'session.created',
        properties: {
          info: {
            id: childID,
            parentID,
          },
        },
      } as any,
    });

    const sessions = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'sessions.json'), 'utf-8')) as {
      sessions: Array<{ sessionId: string; parentSessionId?: string }>;
    };
    const childRecord = sessions.sessions.find(s => s.sessionId === childID);
    expect(childRecord?.parentSessionId).toBe(parentID);
  });

  it('updates parentSessionId when session.updated has parentID', async () => {
    const hooks = await loadTestHooks(testRoot);
    const childID = 'sess_child_upd';
    const parentID = 'sess_parent_upd';

    await hooks.event?.({
      event: {
        type: 'session.updated',
        properties: {
          info: {
            id: childID,
            parentID,
          },
        },
      } as any,
    });

    const sessions = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'sessions.json'), 'utf-8')) as {
      sessions: Array<{ sessionId: string; parentSessionId?: string }>;
    };
    const childRecord = sessions.sessions.find(s => s.sessionId === childID);
    expect(childRecord?.parentSessionId).toBe(parentID);
  });

  it('preserves legacy standing constraints and lineage when a root session is duplicated/forked', async () => {
    const hooks = await loadTestHooks(testRoot);
    const origSessionID = 'sess_orig_root';
    const dupSessionID = 'sess_fork_root';
    const structuredDupSessionID = 'sess_fork_structured';
    const toolContext = (sessionID: string, messageID: string) => ({
      sessionID,
      messageID,
      agent: 'test',
      abort: new AbortController().signal,
    });

    // 1. Seed the string-only shape written by earlier plugin versions.
    fs.mkdirSync(path.join(testRoot, '.hive'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, '.hive', 'sessions.json'), JSON.stringify({
      sessions: [{
        sessionId: origSessionID,
        standingConstraints: CONSTRAINTS,
        startedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      }],
    }, null, 2));

    // 2. Simulate native session duplication / clone:
    // OpenCode forks clone the metadata so dupSessionID inherits originSessionId: origSessionID
    await hooks.event?.({
      event: {
        type: 'session.created',
        properties: {
          info: {
            id: dupSessionID,
            metadata: {
              agentHive: {
                originSessionId: origSessionID,
              },
            },
          },
        },
      } as any,
    });

    // Verify .hive/sessions.json records duplicatedFromSessionId and migrated constraints
    const sessions = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'sessions.json'), 'utf-8')) as {
      sessions: Array<{
        sessionId: string;
        duplicatedFromSessionId?: string;
        standingConstraints?: string;
        standingConstraintEntries?: Array<{ id: string; text: string }>;
        standingConstraintsRevision?: number;
      }>;
    };
    const dupRecord = sessions.sessions.find(s => s.sessionId === dupSessionID);
    expect(dupRecord?.duplicatedFromSessionId).toBe(origSessionID);
    expect(dupRecord?.standingConstraints).toBe(CONSTRAINTS);
    expect(dupRecord?.standingConstraintEntries).toBeUndefined();
    expect(dupRecord?.standingConstraintsRevision).toBeUndefined();

    const register = parseToolJson<{ revision: number; entries: Array<{ id: string; text: string }> }>(
      await hooks.tool!.hive_constraints_read.execute(
        {},
        { sessionID: dupSessionID, messageID: 'msg_read', agent: 'test', abort: new AbortController().signal },
      ),
    );
    expect(register.revision).toBe(0);
    expect(register.entries).toEqual([{ id: 'legacy', text: CONSTRAINTS }]);

    const originRegister = parseToolJson<{
      revision: number;
      entries: Array<{ id: string; text: string }>;
    }>(await hooks.tool!.hive_constraints_add.execute(
      { constraints: 'Keep changes scoped to the requested files.' },
      toolContext(origSessionID, 'msg_add_structured'),
    ));
    expect(originRegister.revision).toBe(1);
    expect(originRegister.entries[0]).toEqual({ id: 'legacy', text: CONSTRAINTS });

    await hooks.event?.({
      event: {
        type: 'session.created',
        properties: {
          info: {
            id: structuredDupSessionID,
            metadata: {
              agentHive: {
                originSessionId: origSessionID,
              },
            },
          },
        },
      } as any,
    });

    const structuredSessions = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'sessions.json'), 'utf-8')) as {
      sessions: Array<{
        sessionId: string;
        duplicatedFromSessionId?: string;
        standingConstraintEntries?: Array<{ id: string; text: string }>;
        standingConstraintsRevision?: number;
      }>;
    };
    const structuredDupRecord = structuredSessions.sessions.find(s => s.sessionId === structuredDupSessionID);
    expect(structuredDupRecord?.duplicatedFromSessionId).toBe(origSessionID);
    expect(structuredDupRecord?.standingConstraintEntries).toEqual(originRegister.entries);
    expect(structuredDupRecord?.standingConstraintsRevision).toBe(originRegister.revision);

    const editedFork = parseToolJson<{
      revision: number;
      entries: Array<{ id: string; text: string }>;
      constraints: string;
    }>(await hooks.tool!.hive_constraints_edit.execute(
      {
        id: originRegister.entries[0]!.id,
        expectedRevision: originRegister.revision,
        constraints: 'Fork-specific constraint.',
      },
      toolContext(structuredDupSessionID, 'msg_edit_fork'),
    ));
    const unchangedOrigin = parseToolJson<{
      revision: number;
      entries: Array<{ id: string; text: string }>;
    }>(await hooks.tool!.hive_constraints_read.execute(
      {},
      toolContext(origSessionID, 'msg_read_origin'),
    ));
    expect(editedFork.entries[0]?.id).toBe(originRegister.entries[0]?.id);
    expect(editedFork.constraints).toBe('Fork-specific constraint.\n\nKeep changes scoped to the requested files.');
    expect(unchangedOrigin).toMatchObject(originRegister);

    // Verify dupSessionID was re-stamped with its new ID in metadata
    expect(sessionStore[dupSessionID]?.metadata?.agentHive?.originSessionId).toBe(dupSessionID);
    expect(sessionStore[structuredDupSessionID]?.metadata?.agentHive?.originSessionId).toBe(structuredDupSessionID);

    // Constraint inheritance does not authenticate a duplicated root for dispatch.
    const output = {
      args: {
        subagent_type: 'forager-worker',
        prompt: 'Implement the task.',
      },
    };
    await expect(hooks['tool.execute.before']?.(
      { tool: 'task', sessionID: dupSessionID, callID: 'call_dup_task' } as any,
      output as any,
    )).rejects.toThrow('context_authorization_denied');
    expect(output.args.prompt).toBe('Implement the task.');
  });
});
