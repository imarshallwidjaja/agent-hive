import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createManifestRepository(root: string, id: string): string {
  const repository = path.join(root, id);
  fs.mkdirSync(repository);
  git(repository, ['init']);
  git(repository, ['config', 'user.email', 'test@example.com']);
  git(repository, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'base\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'test: base']);
  return repository;
}

function writeRepositoryManifest(root: string, entries: string[]): void {
  fs.writeFileSync(path.join(root, '.hive', 'repositories.json'), JSON.stringify({
    schemaVersion: 1,
    repositories: entries.map((id) => ({ id, path: id })),
  }));
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
    expect(output.args.prompt).toContain('## Standing Constraints');
    expect(output.args.prompt).toContain('Session constraints (revision 1)');
    expect(output.args.prompt).toContain('Feature constraints for "feature-a" (revision 1)');
    expect(output.args.prompt).toContain('Keep session behavior.');
    expect(output.args.prompt).toContain('Keep feature behavior.');
    expect(output.args).not.toHaveProperty('hive_launch_id');

    await loaded.tool!.hive_feature_select.execute({ feature: 'feature-b' }, parent);
    sessions.set('child-a', { id: 'child-a', parentID: 'parent' });
    await loaded.event!({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: 'parent', callID: 'call-a', metadata: { sessionId: 'child-a' }, state: { input: output.args } } } } } as any);
    expect(new SessionService(root).getGlobal('child-a')?.featureName).toBe('feature-a');
    expect(new SessionService(root).getGlobal('parent')?.featureName).toBe('feature-b');
  });

  it('dispatches a stored indexed directory alias with feature constraints', async () => {
    const { root, sessions, hooks } = createRuntime();
    const featureAlias = '03_dagster-product-lifecycle';
    fs.mkdirSync(path.join(root, '.hive', 'features', featureAlias), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.hive', 'features', featureAlias, 'feature.json'),
      JSON.stringify({ name: 'dagster-product-lifecycle', status: 'executing', createdAt: new Date().toISOString() }),
    );
    const loaded = await hooks;
    const parent = context('parent-legacy');
    await loaded.tool!.hive_feature_select.execute({ feature: featureAlias }, parent);
    await loaded.tool!.hive_constraints_add.execute(
      { scope: 'feature', feature: featureAlias, constraints: 'Keep legacy routing.' },
      parent,
    );

    const output = { args: { subagent_type: 'forager-worker', prompt: 'Run.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-legacy', callID: 'call-legacy' } as any, output);

    expect(output.args.prompt).toContain(`Feature constraints for "${featureAlias}"`);
    expect(output.args.prompt).toContain('Keep legacy routing.');
    sessions.set('child-legacy', { id: 'child-legacy', parentID: 'parent-legacy' });
    await loaded.event!({ event: { type: 'message.part.updated', properties: { part: {
      type: 'tool',
      tool: 'task',
      sessionID: 'parent-legacy',
      callID: 'call-legacy',
      metadata: { sessionId: 'child-legacy' },
      state: { input: output.args },
    } } } } as any);

    expect(new SessionService(root).getGlobal('child-legacy')?.featureName).toBe(featureAlias);
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

  it('captures the same sole-live fallback used by feature tools', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    await loaded.tool!.hive_feature_create.execute({ name: 'sole-live' }, context('creator'));
    const output = { args: { subagent_type: 'scout-researcher', prompt: 'Inspect.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'unbound', callID: 'sole-call' } as any, output);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":true,"feature":"sole-live"}');
  });

  it('captures an effective null route when no feature fallback exists', async () => {
    const { root, hooks } = createRuntime();
    const loaded = await hooks;
    const output = { args: { subagent_type: 'scout-researcher', prompt: 'Inspect.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'unbound', callID: 'no-feature' } as any, output);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":true,"feature":null}');
    await loaded['tool.execute.after']!({ tool: 'task', sessionID: 'unbound', callID: 'no-feature', args: output.args } as any, { metadata: { sessionId: 'child-no-feature' } } as any);
    expect(new SessionService(root).getGlobal('child-no-feature')).toMatchObject({ featureName: null });
  });

  it('accepts a matching scalar pin for a persisted singleton ad-hoc composite', async () => {
    const runtime = createRuntime();
    createManifestRepository(runtime.root, 'api');
    writeRepositoryManifest(runtime.root, ['api']);
    const loaded = await runtime.hooks;

    const created = JSON.parse(await loaded.tool!.hive_adhoc_worktree_create.execute({
      runId: 'singleton-adhoc',
      repoIds: ['api'],
    }, {}));
    const sourcePath = created.repos.api.path;
    fs.writeFileSync(path.join(sourcePath, 'tracked.txt'), 'changed\n');
    git(sourcePath, ['add', '.']);
    git(sourcePath, ['commit', '-m', 'test: singleton source']);
    const inspected = JSON.parse(await loaded.tool!.hive_adhoc_worktree_inspect.execute({ runId: 'singleton-adhoc' }, {}));

    const result = JSON.parse(await loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'singleton-adhoc',
      sourceCommit: inspected.repos.api.commit,
      message: 'test: merge singleton source\n\nMerge the persisted singleton candidate.',
      cleanup: 'worktree+branch',
    }, {}));

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(runtime.root, 'api', 'tracked.txt'), 'utf8')).toBe('changed\n');
  });

  it('accepts a matching scalar pin for a persisted singleton feature composite', async () => {
    const runtime = createRuntime();
    createManifestRepository(runtime.root, 'api');
    writeRepositoryManifest(runtime.root, ['api']);
    const loaded = await runtime.hooks;
    const caller = context('singleton-feature');
    await loaded.tool!.hive_feature_create.execute({ name: 'singleton-feature' }, caller);
    const task = await loaded.tool!.hive_task_create.execute({ feature: 'singleton-feature', name: 'Change source', repos: ['api'] }, caller);

    const created = JSON.parse(await loaded.tool!.hive_worktree_create.execute({ feature: 'singleton-feature', task }, caller));
    const sourcePath = created.repos.api.path;
    fs.writeFileSync(path.join(sourcePath, 'tracked.txt'), 'feature changed\n');
    git(sourcePath, ['add', '.']);
    git(sourcePath, ['commit', '-m', 'test: feature singleton source']);
    const inspected = JSON.parse(await loaded.tool!.hive_worktree_inspect.execute({ feature: 'singleton-feature', task }, caller));

    const result = JSON.parse(await loaded.tool!.hive_worktree_merge.execute({
      feature: 'singleton-feature',
      task,
      sourceCommit: inspected.repos.api.commit,
      message: 'test: merge feature singleton source\n\nMerge the persisted singleton feature candidate.',
      cleanup: 'worktree+branch',
    }, caller));

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(runtime.root, 'api', 'tracked.txt'), 'utf8')).toBe('feature changed\n');
  });

  it('accepts singleton maps and rejects stale or ambiguous pins before mutation', async () => {
    const runtime = createRuntime();
    const repository = createManifestRepository(runtime.root, 'api');
    writeRepositoryManifest(runtime.root, ['api']);
    const loaded = await runtime.hooks;
    const created = JSON.parse(await loaded.tool!.hive_adhoc_worktree_create.execute({ runId: 'pin-validation', repoIds: ['api'] }, {}));
    const sourcePath = created.repos.api.path;
    const staleCommit = created.repos.api.commit;
    fs.writeFileSync(path.join(sourcePath, 'tracked.txt'), 'pin changed\n');
    git(sourcePath, ['add', '.']);
    git(sourcePath, ['commit', '-m', 'test: pin validation source']);
    const inspected = JSON.parse(await loaded.tool!.hive_adhoc_worktree_inspect.execute({ runId: 'pin-validation' }, {}));
    const targetBefore = git(repository, ['rev-parse', 'HEAD']);

    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({ runId: 'pin-validation', sourceCommit: staleCommit }, {})).rejects.toThrow(/does not match/);
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(targetBefore);
    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'pin-validation',
      sourceCommit: inspected.repos.api.commit,
      sourceCommits: { api: inspected.repos.api.commit },
    }, {})).rejects.toThrow(/both/);

    const result = JSON.parse(await loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'pin-validation',
      sourceCommits: { api: inspected.repos.api.commit },
      message: 'test: merge singleton map\n\nMerge the exact singleton map.',
      cleanup: 'worktree+branch',
    }, {}));
    expect(result.success).toBe(true);
  });

  it('rejects scalar pins for multi-repository composites', async () => {
    const runtime = createRuntime();
    const api = createManifestRepository(runtime.root, 'api');
    const web = createManifestRepository(runtime.root, 'web');
    writeRepositoryManifest(runtime.root, ['api', 'web']);
    const loaded = await runtime.hooks;
    const created = JSON.parse(await loaded.tool!.hive_adhoc_worktree_create.execute({ runId: 'multi-pin', repoIds: ['api', 'web'] }, {}));
    const targetBefore = { api: git(api, ['rev-parse', 'HEAD']), web: git(web, ['rev-parse', 'HEAD']) };

    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'multi-pin',
      sourceCommit: created.repos.api.commit,
    }, {})).rejects.toThrow(/cannot select a composite candidate/);
    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'multi-pin',
      sourceCommits: { api: created.repos.api.commit },
    }, {})).rejects.toThrow(/exactly match/);
    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'multi-pin',
      sourceCommits: { api: created.repos.api.commit, web: created.repos.web.commit, extra: 'sha' },
    }, {})).rejects.toThrow(/exactly match/);
    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'multi-pin',
      sourceCommits: { api: 'stale', web: created.repos.web.commit },
    }, {})).rejects.toThrow(/exactly match/);
    expect({ api: git(api, ['rev-parse', 'HEAD']), web: git(web, ['rev-parse', 'HEAD']) }).toEqual(targetBefore);
  });

  it('keeps legacy single-root pin validation unchanged', async () => {
    const runtime = createRuntime();
    git(runtime.root, ['init']);
    git(runtime.root, ['config', 'user.email', 'test@example.com']);
    git(runtime.root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(runtime.root, 'tracked.txt'), 'base\n');
    git(runtime.root, ['add', '.']);
    git(runtime.root, ['commit', '-m', 'test: legacy base']);
    const loaded = await runtime.hooks;
    const created = JSON.parse(await loaded.tool!.hive_adhoc_worktree_create.execute({ runId: 'legacy-pin' }, {}));

    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({ runId: 'legacy-pin', sourceCommits: { root: created.commit } }, {})).rejects.toThrow(/require a composite candidate/);
    fs.writeFileSync(path.join(created.path, 'tracked.txt'), 'legacy changed\n');
    git(created.path, ['add', '.']);
    git(created.path, ['commit', '-m', 'test: legacy source']);
    const inspected = JSON.parse(await loaded.tool!.hive_adhoc_worktree_inspect.execute({ runId: 'legacy-pin' }, {}));
    const result = JSON.parse(await loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'legacy-pin',
      sourceCommit: inspected.commit,
      message: 'test: merge legacy source\n\nMerge the exact legacy pin.',
      cleanup: 'worktree+branch',
    }, {}));

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(runtime.root, 'tracked.txt'), 'utf8')).toBe('legacy changed\n');
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
    expect(allowed('architect-planner', 'hive_worktree_create')).toBe(false);
    expect(allowed('architect-planner', 'hive_plan_write')).toBe(true);
    expect(config.subagent_depth).toBe(2);
    expect(config.agent['architect-planner'].permission.task).toMatchObject({
      '*': 'deny',
      'scout-researcher': 'allow',
      'plan-reviewer': 'allow',
      'approach-advisor': 'allow',
    });
    expect(config.agent['architect-planner'].permission.task['architect-planner']).toBeUndefined();
    expect(config.agent['architect-planner'].permission.task['forager-worker']).toBeUndefined();
    expect(config.agent['architect-planner'].permission.task['hive-master']).toBeUndefined();
    expect(allowed('forager-worker', 'hive_task_update')).toBe(true);
    expect(allowed('forager-worker', 'hive_constraints_add')).toBe(false);
    expect(allowed('forager-worker', 'hive_context_archive')).toBe(false);
    expect(config.agent['forager-worker'].permission.task).toBe('deny');
    expect(allowed('scout-researcher', 'hive_git_snapshot')).toBe(true);
    expect(allowed('scout-researcher', 'hive_context_write')).toBe(false);
    expect(config.agent['scout-researcher'].permission.task).toBe('deny');
    expect(config.agent['plan-reviewer'].permission.task).toBe('deny');
    expect(config.agent['approach-advisor'].permission.task).toBe('deny');
    expect(allowed('code-reviewer', 'hive_context_write')).toBe(true);
    expect(allowed('code-reviewer', 'hive_task_update')).toBe(false);
    expect(allowed('dash-reviewer', 'hive_worktree_merge')).toBe(false);
    expect(config.agent['dash-reviewer'].permission.task).toBe('allow');
    expect(allowed('hive-helper', 'hive_worktree_merge')).toBe(true);
    expect(allowed('hive-helper', 'hive_task_create')).toBe(true);
    expect(allowed('hive-helper', 'hive_adhoc_worktree_merge')).toBe(false);
    expect(allowed('hive-helper', 'hive_plan_write')).toBe(false);
  });

  it('allows primary and delegated architects to dispatch planning helpers with the same route snapshot', async () => {
    const { sessions, hooks } = createRuntime();
    const loaded = await hooks;

    await loaded['chat.message']!({ sessionID: 'arch-primary', agent: 'architect-planner' } as any, { message: {}, parts: [] } as any);
    const primaryCall = { args: { subagent_type: 'scout-researcher', description: 'Research', prompt: 'Research the plan.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'arch-primary', callID: 'arch-primary-call' } as any, primaryCall);
    expect(primaryCall.args.prompt).toContain('<!-- hive-route-snapshot:start -->');

    await loaded.event!({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: 'arch-primary', callID: 'arch-primary-call', metadata: { sessionId: 'arch-child-observed' }, state: { input: { subagent_type: 'architect-planner' } } } } } } as any);
    const observedChildCall = { args: { subagent_type: 'scout-researcher', description: 'Research', prompt: 'Nested research.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'arch-child-observed', callID: 'arch-child-observed-call' } as any, observedChildCall);
    expect(observedChildCall.args.prompt.startsWith('Nested research.')).toBe(true);
    expect(observedChildCall.args.prompt).toContain('<!-- hive-route-snapshot:start -->');

    sessions.set('arch-child-native', { id: 'arch-child-native', parentID: 'arch-primary' });
    await loaded['chat.message']!({ sessionID: 'arch-child-native', agent: 'architect-planner' } as any, { message: {}, parts: [] } as any);
    const nativeChildCall = { args: { subagent_type: 'scout-researcher', description: 'Research', prompt: 'Nested research.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'arch-child-native', callID: 'arch-child-native-call' } as any, nativeChildCall);
    expect(nativeChildCall.args.prompt.startsWith('Nested research.')).toBe(true);
    expect(nativeChildCall.args.prompt).toContain('<!-- hive-route-snapshot:start -->');
  });

  it('injects each full agent prompt through exactly one path', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const config: any = {};
    await loaded.config!(config);
    expect(config.agent['hive-master'].prompt).toBeUndefined();
    const hiveOutput = { system: ['provider'] };
    await loaded['experimental.chat.system.transform']!({ sessionID: 'primary', agent: 'hive-master' } as any, hiveOutput);
    expect(hiveOutput.system[0].split('# Hive (Hybrid)').length - 1).toBe(1);
    expect(config.agent['scout-researcher'].prompt).toContain('# Scout');
    const scoutOutput = { system: ['provider'] };
    await loaded['experimental.chat.system.transform']!({ sessionID: 'scout', agent: 'scout-researcher' } as any, scoutOutput);
    expect(scoutOutput.system[0]).toBe('provider');
  });

  it('continues named context reads with opaque snapshot-validated cursors', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('context-reader');
    const content = `---\ndescription: Large test context\nread_when: Read during continuation tests.\nowner: test\nreview_after: 2099-01-01\n---\n\n${'x'.repeat(10_000)}`;
    await loaded.tool!.hive_context_write.execute({ scope: 'project', name: 'large', content }, caller);
    const first = JSON.parse(await loaded.tool!.hive_context_read.execute({ scope: 'project', name: 'large', maxBytes: 4_096 }, caller));
    expect(first.complete).toBe(false);
    expect(first.nextCursor).toBeString();
    const second = JSON.parse(await loaded.tool!.hive_context_read.execute({ scope: 'project', name: 'large', cursor: first.nextCursor, maxBytes: 4_096 }, caller));
    expect(second.range.startByte).toBe(first.range.endByte);

    await loaded.tool!.hive_context_append.execute({ scope: 'project', name: 'large', content: 'changed', expectedRevision: first.revision, expectedContentHash: first.file.contentHash }, caller);
    await expect(loaded.tool!.hive_context_read.execute({ scope: 'project', name: 'large', cursor: first.nextCursor, maxBytes: 4_096 }, caller)).rejects.toThrow(/cursor|changed/i);
  });

  it('requires context task metadata to name an existing task folder', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('context-task');
    await loaded.tool!.hive_feature_create.execute({ name: 'context-feature' }, caller);
    await expect(loaded.tool!.hive_context_write.execute({ name: 'notes', content: 'body', task: 'missing' }, caller)).rejects.toThrow(/does not exist/);
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
