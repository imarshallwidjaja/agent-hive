import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import plugin from '../index.js';
import { HIVE_TOOL_NAMES } from '../utils/plugin-manifest.js';
import { createPluginWithHome } from './plugin-test-home.js';

const roots: string[] = [];

async function fixture() {
  const root = fs.mkdtempSync(`/tmp/hive-plugin-smoke-${process.pid}-`);
  const home = fs.mkdtempSync(`/tmp/hive-plugin-smoke-home-${process.pid}-`);
  roots.push(root, home);
  fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
  const hooks = await createPluginWithHome(home, () => plugin({
    directory: root,
    worktree: root,
    project: { id: 'plugin-smoke', worktree: root },
    client: { session: { get: async ({ path: inputPath }: any) => ({ data: { id: inputPath.id } }), abort: async () => ({ data: true }) } },
  } as any));
  return { root, hooks, context: { sessionID: 'primary', messageID: 'message', agent: 'hive-master', abort: new AbortController().signal } };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('plugin hard-cut surface', () => {
  it('registers the canonical tools and ordinary review commands', async () => {
    const { hooks } = await fixture();
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([...HIVE_TOOL_NAMES].sort());
    expect(hooks.command?.['dash-review']).toBeDefined();
    expect(hooks.command?.['vuln-review']).toBeDefined();
    expect(hooks.command?.['dash-review'].agent).toBe('dash-reviewer');
    expect(hooks.command?.['vuln-review'].agent).toBe('vulnerability-review-primary');
  });

  it('persists task reports without execution finalization', async () => {
    const { hooks, context } = await fixture();
    await hooks.tool!.hive_feature_create.execute({ name: 'reports' }, context);
    const task = await hooks.tool!.hive_task_create.execute({ feature: 'reports', name: 'Report task' }, context);
    const result = JSON.parse(await hooks.tool!.hive_task_update.execute({ feature: 'reports', task, status: 'done', summary: 'Verified', report: '# Report\n\nPassed.' }, context));
    expect(result.status).toBe('done');
    expect(result.reportPath).toMatch(/reports\/1\.md$/);
  });

  it('keeps explicit null selection from falling back to the sole live feature', async () => {
    const { hooks, context } = await fixture();
    await hooks.tool!.hive_feature_create.execute({ name: 'sole' }, context);
    await hooks.tool!.hive_feature_select.execute({ feature: null }, context);
    await expect(hooks.tool!.hive_plan_read.execute({}, context)).rejects.toThrow(/Feature is required/);
  });

  it('uses sourceDirectory on every foreign ad-hoc call and rejects mixed repository selection', async () => {
    const { root, hooks } = await fixture();
    const source = fs.mkdtempSync(`/tmp/hive-plugin-foreign-${process.pid}-`);
    roots.push(source);
    execFileSync('git', ['init'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: source });
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', ['commit', '-m', 'test: base'], { cwd: source });

    const created = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'foreign', sourceDirectory: source }, {}));
    expect(created.path).toContain(path.join(root, '.hive', '.worktrees', 'adhoc', 'foreign'));
    const inspected = JSON.parse(await hooks.tool!.hive_adhoc_worktree_inspect.execute({ runId: 'foreign', sourceDirectory: source }, {}));
    expect(inspected.commit).toBe(created.commit);
    await expect(hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'foreign-mixed', sourceDirectory: source, repoIds: ['root'] }, {})).rejects.toThrow(/cannot be combined/);
    await expect(hooks.tool!.hive_adhoc_worktree_inspect.execute({ runId: 'foreign', sourceDirectory: source, repoIds: ['root'] }, {})).rejects.toThrow(/cannot be combined/);
    fs.writeFileSync(path.join(created.path, 'tracked.txt'), 'changed\n');
    execFileSync('git', ['add', '.'], { cwd: created.path });
    execFileSync('git', ['commit', '-m', 'test: move source', '-m', 'Exercise caller-supplied source pin validation.'], { cwd: created.path });
    await expect(hooks.tool!.hive_adhoc_worktree_merge.execute({ runId: 'foreign', sourceDirectory: source, sourceCommit: created.commit, message: 'test: merge\n\nMerge candidate.' }, {})).rejects.toThrow(/does not match/);
    const cleaned = JSON.parse(await hooks.tool!.hive_adhoc_worktree_cleanup.execute({ runId: 'foreign', sourceDirectory: source, discard: true, deleteBranch: true }, {}));
    expect(cleaned.cleanup.outcome).toBe('complete');
    await expect(hooks.tool!.hive_adhoc_worktree_inspect.execute({ runId: 'foreign', sourceDirectory: '.' }, {})).rejects.toThrow(/must be absolute/);
    await expect(hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'relative-create', sourceDirectory: '.' }, {})).rejects.toThrow(/must be absolute/);
    await expect(hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'missing-create', sourceDirectory: path.join(source, 'missing') }, {})).rejects.toThrow();
  });

  it('creates a native single-root worktree from the repository status selection', async () => {
    const { root, hooks } = await fixture();
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'test: base'], { cwd: root });

    const status = JSON.parse(await hooks.tool!.hive_repositories_status.execute({}, {}));
    const alias = path.join('/tmp', `hive-plugin-root-alias-${process.pid}-${Date.now()}`);
    fs.symlinkSync(root, alias, 'dir');
    roots.push(alias);
    const created = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'status-root',
      repoIds: status.repositories.map(({ id }: { id: string }) => id),
      sourceDirectory: alias,
    }, {}));

    expect(status.mode).toBe('legacy-root');
    expect(created.mode).toBe('adhoc-single');
    expect(created.path).toBe(path.join(root, '.hive', '.worktrees', 'adhoc', 'status-root'));
  });

  it('captures an explicit foreign-directory snapshot without consuming project topology', async () => {
    const { hooks } = await fixture();
    const source = fs.mkdtempSync(`/tmp/hive-plugin-snapshot-${process.pid}-`);
    roots.push(source);
    execFileSync('git', ['init'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: source });
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', ['commit', '-m', 'test: base'], { cwd: source });
    const snapshot = JSON.parse(await hooks.tool!.hive_git_snapshot.execute({ directory: source }, {}));
    expect(snapshot.snapshots[0].snapshot.repository.root).toBe(fs.realpathSync(source));
    const mixed = JSON.parse(await hooks.tool!.hive_git_snapshot.execute({ directory: source, repositoryIds: ['root'] }, {}));
    expect(mixed).toMatchObject({ schema: 'hive-git-snapshot/v1', status: 'failed' });
    const relative = JSON.parse(await hooks.tool!.hive_git_snapshot.execute({ directory: '.' }, {}));
    expect(relative).toMatchObject({ schema: 'hive-git-snapshot/v1', status: 'failed' });
  });

  it('validates manifest repository selections and snapshots all repositories by default', async () => {
    const { root, hooks } = await fixture();
    for (const id of ['api', 'web']) {
      const repository = path.join(root, id);
      fs.mkdirSync(repository);
      execFileSync('git', ['init'], { cwd: repository });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository });
      fs.writeFileSync(path.join(repository, 'tracked.txt'), `${id}\n`);
      execFileSync('git', ['add', '.'], { cwd: repository });
      execFileSync('git', ['commit', '-m', `test: ${id}`], { cwd: repository });
    }
    fs.writeFileSync(path.join(root, '.hive', 'repositories.json'), JSON.stringify({
      schemaVersion: 1,
      repositories: [{ id: 'api', path: 'api' }, { id: 'web', path: 'web' }],
    }));

    const alias = path.join('/tmp', `hive-plugin-manifest-root-alias-${process.pid}-${Date.now()}`);
    fs.symlinkSync(root, alias, 'dir');
    roots.push(alias);
    const created = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'manifest-root',
      repoIds: ['api'],
      sourceDirectory: alias,
    }, {}));
    expect(created.mode).toBe('adhoc-composite');
    expect(created.repos.api).toBeDefined();
    const cleaned = JSON.parse(await hooks.tool!.hive_adhoc_worktree_cleanup.execute({ runId: 'manifest-root', discard: true, deleteBranch: true }, {}));
    expect(cleaned.cleanup.outcome).toBe('complete');
    await expect(hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'manifest-member',
      repoIds: ['api'],
      sourceDirectory: path.join(root, 'api'),
    }, {})).rejects.toThrow(/cannot be combined/);

    const all = JSON.parse(await hooks.tool!.hive_git_snapshot.execute({}, {}));
    expect(all.status).toBe('ready');
    expect(all.snapshots.map((entry: any) => entry.repositoryId).sort()).toEqual(['api', 'web']);
    for (const repositoryIds of [[], ['api', 'api'], ['missing']]) {
      const failed = JSON.parse(await hooks.tool!.hive_git_snapshot.execute({ repositoryIds }, {}));
      expect(failed.status).toBe('failed');
      expect(failed.snapshots).toBeUndefined();
    }
  });
});
