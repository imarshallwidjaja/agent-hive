import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { AdhocWorktreeService } from './adhocWorktreeService';
import { CheckoutInspector } from './checkoutInspector';
import { RetainedCheckoutService } from './retainedCheckoutService';
import { readWorktreeTargetIdentity } from './worktreeTarget';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Every path and modification time under `root`, so a read can be shown to have written nothing. */
function snapshot(root: string): string[] {
  const entries: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      entries.push(`${full}\0${fs.lstatSync(full).mtimeMs}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return entries.sort();
}

describe('CheckoutInspector', () => {
  it('projects retained checkouts and workers per repository without writing, keeping broken entries visible', async () => {
    const repoPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-checkout-inspector-')));
    tempDirs.push(repoPath);
    await simpleGit().raw(['init', '-b', 'main', repoPath]);
    const git = simpleGit(repoPath);
    await git.raw(['config', 'user.email', 'test@example.com']);
    await git.raw(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repoPath, '.gitignore'), '.hive/\n');
    await git.add(['.gitignore']);
    await git.commit('chore: base commit\n\nCreate the fixture history.');
    const hiveDir = path.join(repoPath, '.hive');
    const checkouts = new RetainedCheckoutService({ baseDir: repoPath, hiveDir });
    const adhoc = new AdhocWorktreeService({ baseDir: repoPath, hiveDir });

    await checkouts.register({ id: 'root/main' });
    const feature = await checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    await checkouts.setReadiness('root/feature', await readWorktreeTargetIdentity(feature.path), { state: 'ready', waitingFor: 'review' });
    await adhoc.create({ runId: 'bound', target: 'root/feature' });
    await adhoc.create({ runId: 'legacy' });
    fs.writeFileSync(path.join(hiveDir, 'checkouts', 'root', 'broken.json'), '{');
    fs.mkdirSync(path.join(hiveDir, 'checkouts', 'root', 'orphan'));

    const inspector = new CheckoutInspector({ baseDir: repoPath, hiveDir });
    const before = snapshot(repoPath);
    const projection = await inspector.inspectProject();
    expect(snapshot(repoPath)).toEqual(before);

    expect(projection.repositories).toHaveLength(1);
    const [root] = projection.repositories;
    expect(root).toMatchObject({ id: 'root', path: repoPath, implicit: true, head: { path: repoPath, ref: 'refs/heads/main' } });
    expect(root).not.toHaveProperty('headError');
    expect(root!.checkouts.map((checkout) => checkout.id)).toEqual(['root/broken', 'root/feature', 'root/main']);
    const byId = new Map(root!.checkouts.map((checkout) => [checkout.id, checkout]));
    expect(byId.get('root/broken')?.error).toContain('Invalid JSON');
    expect(byId.get('root/feature')).toMatchObject({
      onIntendedRef: true,
      head: { path: feature.path, ref: 'refs/heads/feat/x' },
      readiness: { state: 'ready', waitingFor: 'review', headMoved: false },
    });
    expect(byId.get('root/main')).toMatchObject({ record: { ownership: 'registered' }, onIntendedRef: true });
    expect(projection.errors).toEqual([{ path: path.join(hiveDir, 'checkouts', 'root', 'orphan'), reason: 'placement has no retained checkout record' }]);

    const workers = new Map(root!.workers.map((worker) => [worker.runId, worker]));
    expect(workers.get('bound')).toMatchObject({ kind: 'adhoc', repoId: 'root', branch: 'hive-targeted/adhoc/bound', target: { id: 'root/feature', ref: 'refs/heads/feat/x' } });
    // A root run's start commit is not a target: none is reported.
    expect(workers.get('legacy')).toMatchObject({ kind: 'adhoc', repoId: 'root', branch: 'hive/adhoc/legacy' });
    expect(workers.get('legacy')).not.toHaveProperty('target');

    fs.writeFileSync(path.join(feature.path, 'moved.txt'), 'moved\n');
    await simpleGit(feature.path).add(['moved.txt']);
    await simpleGit(feature.path).commit('feat: move the checkout\n\nAdvance HEAD past the declared readiness.');
    expect((await inspector.inspectCheckout('root/feature')).readiness?.headMoved).toBe(true);

    const branches = await inspector.listLocalBranches('root');
    expect(branches.find((branch) => branch.ref === 'refs/heads/feat/x')?.checkedOutAt).toBe(feature.path);
    expect(branches.find((branch) => branch.ref === 'refs/heads/main')?.checkedOutAt).toBe(repoPath);

    // Worker metadata reached through a symlink is reported on its entry and never read.
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-checkout-inspector-outside-')));
    tempDirs.push(outside);
    fs.writeFileSync(path.join(outside, 'secret.json'), JSON.stringify({ mode: 'adhoc-single', secret: 'do-not-read' }));
    const legacySidecar = path.join(hiveDir, '.worktrees', 'adhoc', 'legacy.json');
    fs.rmSync(legacySidecar, { force: true });
    fs.symlinkSync(path.join(outside, 'secret.json'), legacySidecar);
    const planted = (await inspector.listWorkers()).workers.find((worker) => worker.runId === 'legacy');
    expect(planted?.error).toContain('path contains a symlink');
    expect(JSON.stringify(planted)).not.toContain('do-not-read');

    // A missing checkout keeps its recorded readiness, unconfirmed because HEAD cannot be read.
    fs.rmSync(feature.path, { recursive: true, force: true });
    expect(await inspector.inspectCheckout('root/feature')).toMatchObject({
      head: null,
      error: expect.stringContaining('missing'),
      readiness: { state: 'ready', waitingFor: 'review', headMoved: null },
    });
  });

  it('reads a repository configured at a subdirectory from the root of its Git checkout', async () => {
    const repoPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-checkout-inspector-subdir-')));
    tempDirs.push(repoPath);
    await simpleGit().raw(['init', '-b', 'main', repoPath]);
    const git = simpleGit(repoPath);
    await git.raw(['config', 'user.email', 'test@example.com']);
    await git.raw(['config', 'user.name', 'Test User']);
    fs.mkdirSync(path.join(repoPath, 'pkg'));
    fs.writeFileSync(path.join(repoPath, 'pkg', 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(repoPath, '.gitignore'), '.hive/\n');
    await git.add(['.gitignore', 'pkg/index.ts']);
    await git.commit('chore: base commit\n\nCreate the fixture history.');
    const hiveDir = path.join(repoPath, '.hive');
    const repositoryResolver = () => [{ id: 'app', path: path.join(repoPath, 'pkg'), root: repoPath }];
    await new RetainedCheckoutService({ baseDir: repoPath, hiveDir, repositoryResolver }).register({ id: 'app/main' });

    const [app] = (await new CheckoutInspector({ baseDir: repoPath, hiveDir, repositoryResolver }).inspectProject()).repositories;
    expect(app).toMatchObject({ id: 'app', path: path.join(repoPath, 'pkg'), root: repoPath, head: { path: repoPath, ref: 'refs/heads/main' } });
    expect(app!.checkouts).toEqual([expect.objectContaining({ id: 'app/main', record: expect.objectContaining({ path: repoPath }), onIntendedRef: true })]);
  });

  it('lists a targeted worker whose worktree is gone while its binding and branch remain, and flags a lost binding', async () => {
    const repoPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-checkout-inspector-retained-')));
    tempDirs.push(repoPath);
    await simpleGit().raw(['init', '-b', 'main', repoPath]);
    const git = simpleGit(repoPath);
    await git.raw(['config', 'user.email', 'test@example.com']);
    await git.raw(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repoPath, '.gitignore'), '.hive/\n');
    await git.add(['.gitignore']);
    await git.commit('chore: base commit\n\nCreate the fixture history.');
    const hiveDir = path.join(repoPath, '.hive');
    const adhoc = new AdhocWorktreeService({ baseDir: repoPath, hiveDir });
    await new RetainedCheckoutService({ baseDir: repoPath, hiveDir }).create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });

    const kept = await adhoc.create({ runId: 'kept', target: 'root/feature' });
    fs.writeFileSync(path.join(kept.path, 'work.txt'), 'work\n');
    await simpleGit(kept.path).add(['work.txt']);
    await simpleGit(kept.path).commit('feat: add work\n\nLeave unmerged work on the worker branch.');
    const tip = (await simpleGit(kept.path).revparse(['HEAD'])).trim();
    await adhoc.cleanup('kept', false);
    const lost = await adhoc.create({ runId: 'lost', target: 'root/feature' });
    fs.rmSync(path.join(hiveDir, '.worktrees', 'adhoc', 'lost.json'));
    const legacy = await adhoc.create({ runId: 'legacy' });
    fs.rmSync(path.join(hiveDir, '.worktrees', 'adhoc', 'legacy.json'));

    const inspector = new CheckoutInspector({ baseDir: repoPath, hiveDir });
    const before = snapshot(repoPath);
    const { workers, errors } = await inspector.listWorkers();
    expect(snapshot(repoPath)).toEqual(before);
    expect(errors).toEqual([]);
    const byRun = new Map(workers.map((worker) => [worker.runId, worker]));
    expect(byRun.get('kept')).toEqual({
      kind: 'adhoc',
      runId: 'kept',
      repoId: 'root',
      path: kept.path,
      branch: 'hive-targeted/adhoc/kept',
      head: null,
      baseCommit: kept.baseCommit,
      target: { id: 'root/feature', path: path.join(hiveDir, 'checkouts', 'root', 'feature'), ref: 'refs/heads/feat/x' },
      retained: { branchCommit: tip },
    });
    expect(byRun.get('lost')).toMatchObject({ path: lost.path, branch: 'hive-targeted/adhoc/lost', error: expect.stringContaining('has no binding metadata') });
    expect(byRun.get('legacy')).toMatchObject({ path: legacy.path, branch: 'hive/adhoc/legacy', repoId: 'root' });
    expect(byRun.get('legacy')).not.toHaveProperty('error');
    expect(workers).toHaveLength(3);

    // A configured repository whose checkout cannot be read keeps its node with the reason.
    const missing = path.join(repoPath, 'missing');
    const unreadable = await new CheckoutInspector({ baseDir: repoPath, hiveDir, repositoryResolver: () => [{ id: 'gone', path: missing, root: missing }] }).inspectProject();
    expect(unreadable.repositories).toEqual([expect.objectContaining({ id: 'gone', head: null, headError: expect.any(String) })]);
  });
});
