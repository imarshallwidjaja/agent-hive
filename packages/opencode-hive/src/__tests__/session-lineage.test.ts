import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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

  it('stamps session origin in metadata when hive_constraints_set is called', async () => {
    const hooks = await loadTestHooks(testRoot);
    const sessionID = 'sess_primary_1';

    const result = parseToolJson<{ success?: boolean }>(
      await hooks.tool!.hive_constraints_set.execute(
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

  it('migrates standing constraints and lineage when a root session is duplicated/forked', async () => {
    const hooks = await loadTestHooks(testRoot);
    const origSessionID = 'sess_orig_root';
    const dupSessionID = 'sess_fork_root';

    // 1. Set constraints on original session
    await hooks.tool!.hive_constraints_set.execute(
      { constraints: CONSTRAINTS },
      { sessionID: origSessionID, messageID: 'msg_1', agent: 'test', abort: new AbortController().signal },
    );
    expect(sessionStore[origSessionID]?.metadata?.agentHive?.originSessionId).toBe(origSessionID);

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
      sessions: Array<{ sessionId: string; duplicatedFromSessionId?: string; standingConstraints?: string }>;
    };
    const dupRecord = sessions.sessions.find(s => s.sessionId === dupSessionID);
    expect(dupRecord?.duplicatedFromSessionId).toBe(origSessionID);
    expect(dupRecord?.standingConstraints).toBe(CONSTRAINTS);

    // Verify dupSessionID was re-stamped with its new ID in metadata
    expect(sessionStore[dupSessionID]?.metadata?.agentHive?.originSessionId).toBe(dupSessionID);

    // 3. Verify task() dispatch from dupSessionID carries the migrated standing constraints!
    const output = {
      args: {
        subagent_type: 'forager-worker',
        prompt: 'Implement the task.',
      },
    };
    await hooks['tool.execute.before']?.(
      { tool: 'task', sessionID: dupSessionID, callID: 'call_dup_task' } as any,
      output as any,
    );
    expect(output.args.prompt).toBe(`Implement the task.\n\n${CONSTRAINTS_BLOCK}`);
  });
});
