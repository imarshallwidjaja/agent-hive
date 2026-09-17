import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import plugin from './index.js';
import { SessionService } from 'hive-core';
import { HIVE_TOOL_NAMES } from './utils/plugin-manifest.js';

const roots: string[] = [];

function createRuntime() {
  const root = fs.mkdtempSync(`/tmp/hive-runtime-cutover-${process.pid}-`);
  roots.push(root);
  fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
  const sessions = new Map<string, { id: string; parentID?: string }>();
  const client = {
    session: {
      get: async ({ path: inputPath }: { path: { id: string } }) => ({ data: sessions.get(inputPath.id) ?? { id: inputPath.id } }),
      abort: async () => ({ data: true }),
    },
  };
  return {
    root,
    sessions,
    hooks: plugin({ directory: root, worktree: root, project: { id: 'test', worktree: root }, client } as any),
  };
}

function context(sessionID: string, agent = 'hive-master') {
  return { sessionID, messageID: 'message', agent, abort: new AbortController().signal };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('coordinated runtime hard cut', () => {
  it('exposes exactly the canonical public tool inventory', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    expect(Object.keys(loaded.tool ?? {}).sort()).toEqual([...HIVE_TOOL_NAMES].sort());
    expect(Object.keys(loaded.tool ?? {})).not.toContain('hive_execution_prepare');
    expect(Object.keys(loaded.tool ?? {})).not.toContain('hive_review_workspace_create');
  });

  it('snapshots feature routes and constraints at dispatch without requiring preparation', async () => {
    const { root, sessions, hooks } = createRuntime();
    const loaded = await hooks;
    const parent = context('parent');
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-a' }, parent);
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-b' }, parent);
    await loaded.tool!.hive_feature_select.execute({ feature: 'feature-a' }, parent);
    await loaded.tool!.hive_constraints_add.execute({ scope: 'session', constraints: 'Keep session behavior.' }, parent);
    await loaded.tool!.hive_constraints_add.execute({ scope: 'feature', feature: 'feature-a', constraints: 'Keep feature behavior.' }, parent);

    const output = { args: { subagent_type: 'forager-worker', prompt: 'AUTHORED PREFIX', background: false } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent', callID: 'call-a' } as any, output);
    expect(output.args.prompt.startsWith('AUTHORED PREFIX')).toBe(true);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":true,"feature":"feature-a"}');
    expect(output.args.prompt).toContain('Keep session behavior.');
    expect(output.args.prompt).toContain('Keep feature behavior.');

    await loaded.tool!.hive_feature_select.execute({ feature: 'feature-b' }, parent);
    sessions.set('child-a', { id: 'child-a', parentID: 'parent' });
    await loaded.event!({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: 'parent', callID: 'call-a', metadata: { sessionId: 'child-a' }, state: { input: output.args } } } } } as any);
    expect(new SessionService(root).getGlobal('child-a')?.featureName).toBe('feature-a');
    expect(new SessionService(root).getGlobal('parent')?.featureName).toBe('feature-b');
  });

  it('preserves an explicit null route for a dispatched child', async () => {
    const { root, sessions, hooks } = createRuntime();
    const loaded = await hooks;
    const parent = context('parent-null');
    await loaded.tool!.hive_feature_create.execute({ name: 'only-live' }, parent);
    await loaded.tool!.hive_feature_select.execute({ feature: null }, parent);
    const output = { args: { subagent_type: 'scout-researcher', prompt: 'Inspect.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-null', callID: 'call-null' } as any, output);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":true,"feature":null}');
    sessions.set('child-null', { id: 'child-null', parentID: 'parent-null' });
    await loaded.event!({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: 'parent-null', callID: 'call-null', metadata: { sessionId: 'child-null' }, state: { input: output.args } } } } } as any);
    const stored = new SessionService(root).getGlobal('child-null')!;
    expect(Object.prototype.hasOwnProperty.call(stored, 'featureName')).toBe(true);
    expect(stored.featureName).toBeNull();
  });

  it('binds the same complete snapshot when the after hook arrives before the event hook', async () => {
    const { root, hooks } = createRuntime();
    const loaded = await hooks;
    const parent = context('parent-after');
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-after' }, parent);
    await loaded.tool!.hive_constraints_add.execute({ constraints: 'Captured once.' }, parent);
    const output = { args: { subagent_type: 'forager-worker', prompt: 'Run.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-after', callID: 'call-after' } as any, output);
    await loaded['tool.execute.after']!({ tool: 'task', sessionID: 'parent-after', callID: 'call-after', args: output.args } as any, { metadata: { sessionId: 'child-after' } } as any);
    await loaded.tool!.hive_feature_select.execute({ feature: null }, parent);
    await loaded.event!({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: 'parent-after', callID: 'call-after', metadata: { sessionId: 'child-after' }, state: { input: output.args } } } } } as any);

    expect(new SessionService(root).getGlobal('child-after')).toMatchObject({
      parentSessionId: 'parent-after',
      featureName: 'feature-after',
      standingConstraints: 'Captured once.',
      standingConstraintsRevision: 1,
    });
  });

  it('refreshes a resumed child from each invocation snapshot without using the later parent route', async () => {
    const { root, hooks } = createRuntime();
    const loaded = await hooks;
    const parent = context('parent-resume');
    await loaded.tool!.hive_feature_create.execute({ name: 'resume-a' }, parent);
    await loaded.tool!.hive_feature_create.execute({ name: 'resume-b' }, parent);
    await loaded.tool!.hive_feature_select.execute({ feature: 'resume-a' }, parent);
    const first = { args: { subagent_type: 'forager-worker', prompt: 'First.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-resume', callID: 'call-1' } as any, first);
    await loaded['tool.execute.after']!({ tool: 'task', sessionID: 'parent-resume', callID: 'call-1', args: first.args } as any, { metadata: { sessionId: 'same-child' } } as any);
    await loaded.tool!.hive_feature_select.execute({ feature: 'resume-b' }, parent);
    const second = { args: { subagent_type: 'forager-worker', prompt: 'Resume.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-resume', callID: 'call-2' } as any, second);
    await loaded.tool!.hive_feature_select.execute({ feature: null }, parent);
    await loaded['tool.execute.after']!({ tool: 'task', sessionID: 'parent-resume', callID: 'call-2', args: second.args } as any, { metadata: { sessionId: 'same-child' } } as any);
    expect(new SessionService(root).getGlobal('same-child')?.featureName).toBe('resume-b');
  });

  it('rejects invalid feature routes and strict constraint argument combinations', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('constraints');
    await expect(loaded.tool!.hive_feature_create.execute({ name: '../escape' }, caller)).rejects.toThrow('Invalid feature name');
    await expect(loaded.tool!.hive_constraints_read.execute({ scope: 'session', feature: 'x' }, caller)).rejects.toThrow(/not allowed/);
    await expect(loaded.tool!.hive_constraints_read.execute({ scope: 'session' }, context(''))).rejects.toThrow(/Session identity/);
    await loaded.tool!.hive_constraints_add.execute({ constraints: 'Original.' }, caller);
    const read = JSON.parse(await loaded.tool!.hive_constraints_read.execute({}, caller));
    const edit = loaded.tool!.hive_constraints_edit;
    await expect(edit.execute({ id: read.entries[0].id, expectedRevision: read.revision }, caller)).rejects.toThrow(/exactly one/);
    await expect(edit.execute({ id: read.entries[0].id, expectedRevision: read.revision, constraints: 'x', remove: true }, caller)).rejects.toThrow(/exactly one/);
    await expect(edit.execute({ id: read.entries[0].id, expectedRevision: read.revision, constraints: '  ' }, caller)).rejects.toThrow(/nonblank/);
  });

  it('configures role-specific static tool and recursion boundaries', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const config: any = {};
    await loaded.config!(config);
    const allowed = (agent: string, name: string) => config.agent[agent].tools[name] !== false;

    expect(HIVE_TOOL_NAMES).toHaveLength(37);
    expect(allowed('hive-master', 'hive_worktree_merge')).toBe(true);
    expect(allowed('architect-planner', 'hive_worktree_merge')).toBe(false);
    expect(allowed('architect-planner', 'hive_plan_write')).toBe(true);
    expect(allowed('forager-worker', 'hive_task_update')).toBe(true);
    expect(allowed('forager-worker', 'hive_constraints_add')).toBe(false);
    expect(allowed('forager-worker', 'hive_context_archive')).toBe(false);
    expect(config.agent['forager-worker'].permission.task).toBe('deny');
    expect(allowed('scout-researcher', 'hive_git_snapshot')).toBe(true);
    expect(allowed('scout-researcher', 'hive_context_write')).toBe(false);
    expect(config.agent['scout-researcher'].permission.task).toBe('deny');
    expect(allowed('code-reviewer', 'hive_context_write')).toBe(true);
    expect(allowed('code-reviewer', 'hive_task_update')).toBe(false);
    expect(allowed('dash-reviewer', 'hive_worktree_merge')).toBe(false);
    expect(config.agent['dash-reviewer'].permission.task).toBe('allow');
    expect(allowed('hive-helper', 'hive_worktree_merge')).toBe(true);
    expect(allowed('hive-helper', 'hive_plan_write')).toBe(false);
  });

  it('ignores malformed legacy execution-attempt state during startup and status', async () => {
    const runtime = createRuntime();
    fs.writeFileSync(path.join(runtime.root, '.hive', 'execution-attempts.json'), '{ malformed legacy state');
    const loaded = await runtime.hooks;
    const caller = context('parent');
    await loaded.tool!.hive_feature_create.execute({ name: 'legacy-free' }, caller);
    const status = JSON.parse(await loaded.tool!.hive_status.execute({ feature: 'legacy-free' }, caller));
    expect(status.feature.name).toBe('legacy-free');
    expect(fs.readFileSync(path.join(runtime.root, '.hive', 'execution-attempts.json'), 'utf8')).toBe('{ malformed legacy state');
  });
});
