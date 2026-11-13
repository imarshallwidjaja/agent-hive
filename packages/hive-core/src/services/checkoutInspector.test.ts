import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { AdhocWorktreeService } from './adhocWorktreeService';
import { CheckoutInspector } from './checkoutInspector';
import { RetainedCheckoutService } from './retainedCheckoutService';
import { listTargetedSidecars } from './targetedPlacement';
import { WorktreeService } from './worktreeService';
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

    expect(byId.get('root/feature')?.present).toBe(true);
    expect(byId.get('root/broken')).not.toHaveProperty('present');

    // A HEAD that cannot be read is not a missing checkout.
    const adminHead = path.join(repoPath, '.git', 'worktrees', 'feature', 'HEAD');
    const headBytes = fs.readFileSync(adminHead, 'utf8');
    fs.writeFileSync(adminHead, 'not a ref\n');
    expect(await inspector.inspectCheckout('root/feature')).toMatchObject({ present: true, head: null, error: expect.any(String) });
    fs.writeFileSync(adminHead, headBytes);

    // A missing checkout keeps its recorded readiness, unconfirmed because HEAD cannot be read.
    fs.rmSync(feature.path, { recursive: true, force: true });
    expect(await inspector.inspectCheckout('root/feature')).toMatchObject({
      present: false,
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

  it('lists single-root and composite workers whose checkouts a worktree-only cleanup removed while their branches remain', async () => {
    const repoPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-checkout-inspector-branch-only-')));
    tempDirs.push(repoPath);
    await simpleGit().raw(['init', '-b', 'main', repoPath]);
    const git = simpleGit(repoPath);
    await git.raw(['config', 'user.email', 'test@example.com']);
    await git.raw(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repoPath, '.gitignore'), '.hive/\n');
    await git.add(['.gitignore']);
    await git.commit('chore: base commit\n\nCreate the fixture history.');
    const hiveDir = path.join(repoPath, '.hive');
    const repositoryResolver = () => [{ id: 'root', path: repoPath, root: repoPath }];
    const commitIn = async (checkout: string): Promise<string> => {
      fs.writeFileSync(path.join(checkout, 'work.txt'), 'work\n');
      await simpleGit(checkout).add(['work.txt']);
      await simpleGit(checkout).commit('feat: add work\n\nLeave unmerged work on the worker branch.');
      return (await simpleGit(checkout).revparse(['HEAD'])).trim();
    };

    const adhoc = new AdhocWorktreeService({ baseDir: repoPath, hiveDir });
    const run = await adhoc.create({ runId: 'kept-run' });
    const runTip = await commitIn(run.path);
    expect((await adhoc.cleanup('kept-run')).cleanup.outcome).toBe('complete');
    const taskStatus = path.join(hiveDir, 'features', 'feat-a', 'tasks', '01-task');
    fs.mkdirSync(taskStatus, { recursive: true });
    fs.writeFileSync(path.join(taskStatus, 'status.json'), JSON.stringify({ status: 'pending', origin: 'plan' }));
    const tasks = new WorktreeService({ baseDir: repoPath, hiveDir });
    const task = await tasks.create('feat-a', '01-task');
    const taskTip = await commitIn(task.path);
    expect((await tasks.remove('feat-a', '01-task')).cleanup.outcome).toBe('complete');
    const composite = await new AdhocWorktreeService({ baseDir: repoPath, hiveDir, repositoryResolver }).create({ runId: 'kept-composite', repoIds: ['root'] });
    const compositeTip = await commitIn(composite.repos!.root.path);
    expect((await new AdhocWorktreeService({ baseDir: repoPath, hiveDir, repositoryResolver }).cleanup('kept-composite')).cleanup.outcome).toBe('complete');
    // Task candidates of each family: a single-root worker, a composite and a worker bound to a retained checkout.
    const candidate = await tasks.create('feat-a', '01-task', undefined, 'c');
    const candidateTip = await commitIn(candidate.path);
    expect((await tasks.remove('feat-a', '01-task', false, {}, 'c')).cleanup.outcome).toBe('complete');
    const compositeTasks = new WorktreeService({ baseDir: repoPath, hiveDir, repositoryResolver, taskRepoResolver: () => ['root'] });
    const compositeTask = await compositeTasks.create('feat-a', '01-task', undefined, 'm');
    const compositeTaskTip = await commitIn(compositeTask.repos!.root.path);
    expect((await compositeTasks.remove('feat-a', '01-task', false, {}, 'm')).cleanup.outcome).toBe('complete');
    await new RetainedCheckoutService({ baseDir: repoPath, hiveDir }).create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    const targetedStatus = path.join(hiveDir, 'features', 'feat-a', 'tasks', '02-bound', 'status.json');
    fs.mkdirSync(path.dirname(targetedStatus), { recursive: true });
    fs.writeFileSync(targetedStatus, JSON.stringify({ status: 'pending', origin: 'plan', target: 'root/feature' }));
    const targetedTask = await tasks.create('feat-a', '02-bound', undefined, 't');
    const targetedTip = await commitIn(targetedTask.path);
    expect((await tasks.remove('feat-a', '02-bound', false, {}, 't')).cleanup.outcome).toBe('complete');

    const inspector = new CheckoutInspector({ baseDir: repoPath, hiveDir, repositoryResolver });
    const before = snapshot(repoPath);
    const { workers, errors } = await inspector.listWorkers();
    expect(snapshot(repoPath)).toEqual(before);
    expect(errors).toEqual([]);
    expect(workers.sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      { kind: 'adhoc', runId: 'kept-composite', repoId: 'root', path: composite.repos!.root.path, branch: 'hive/adhoc/root/kept-composite', head: null, baseCommit: composite.baseCommits!.root, retained: { branchCommit: compositeTip } },
      { kind: 'adhoc', runId: 'kept-run', repoId: 'root', path: run.path, branch: 'hive/adhoc/kept-run', head: null, baseCommit: run.baseCommit, retained: { branchCommit: runTip } },
      { kind: 'task', feature: 'feat-a', task: '01-task', repoId: 'root', path: task.path, branch: 'hive/feat-a/01-task', head: null, baseCommit: expect.any(String), retained: { branchCommit: taskTip } },
      { kind: 'task', feature: 'feat-a', task: '01-task', candidate: 'c', repoId: 'root', path: candidate.path, branch: 'hive/feat-a/01-task-c', head: null, baseCommit: expect.any(String), retained: { branchCommit: candidateTip } },
      { kind: 'task', feature: 'feat-a', task: '01-task', candidate: 'm', repoId: 'root', path: compositeTask.repos!.root.path, branch: 'hive/root/feat-a/01-task-m', head: null, baseCommit: compositeTask.baseCommits!.root, retained: { branchCommit: compositeTaskTip } },
      { kind: 'task', feature: 'feat-a', task: '02-bound', candidate: 't', repoId: 'root', path: targetedTask.path, branch: 'hive-targeted/task/feat-a/02-bound-t', head: null, baseCommit: expect.any(String), target: expect.objectContaining({ id: 'root/feature' }), retained: { branchCommit: targetedTip } },
    ]);
  });

  it('reports a kept single-root worker record it cannot match to its placement or branch instead of dropping or misreading it', async () => {
    const repoPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-checkout-inspector-kept-records-')));
    tempDirs.push(repoPath);
    await simpleGit().raw(['init', '-b', 'main', repoPath]);
    const git = simpleGit(repoPath);
    await git.raw(['config', 'user.email', 'test@example.com']);
    await git.raw(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repoPath, '.gitignore'), '.hive/\n');
    await git.add(['.gitignore']);
    await git.commit('chore: base commit\n\nCreate the fixture history.');
    const hiveDir = path.join(repoPath, '.hive');
    const tasks = new WorktreeService({ baseDir: repoPath, hiveDir });
    const keep = async (task: string) => {
      const statusPath = path.join(hiveDir, 'features', 'feat-a', 'tasks', task, 'status.json');
      fs.mkdirSync(path.dirname(statusPath), { recursive: true });
      fs.writeFileSync(statusPath, JSON.stringify({ status: 'pending', origin: 'plan' }));
      const created = await tasks.create('feat-a', task);
      fs.writeFileSync(path.join(created.path, 'work.txt'), `${task}\n`);
      await simpleGit(created.path).add(['work.txt']);
      await simpleGit(created.path).commit('feat: add work\n\nLeave unmerged work on the worker branch.');
      expect((await tasks.remove('feat-a', task)).cleanup.outcome).toBe('complete');
      return created;
    };
    const gone = await keep('01-gone');
    const file = await keep('02-file');
    const link = await keep('03-link');
    const renamed = await keep('04-renamed');

    // The branch is gone, and only a branch below its name exists.
    await git.raw(['branch', '-D', gone.branch]);
    await git.raw(['branch', `${gone.branch}/descendant`, 'main']);
    // Something other than a directory sits at a placement.
    fs.writeFileSync(file.path, 'not a checkout\n');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-checkout-inspector-elsewhere-'));
    tempDirs.push(elsewhere);
    fs.symlinkSync(elsewhere, link.path);
    // A sidecar naming another branch than its placement's.
    const renamedSidecar = `${renamed.path}.json`;
    fs.writeFileSync(renamedSidecar, JSON.stringify({ ...JSON.parse(fs.readFileSync(renamedSidecar, 'utf8')), branch: 'hive/feat-a/other' }));

    const before = snapshot(repoPath);
    const { workers, errors } = await new CheckoutInspector({ baseDir: repoPath, hiveDir }).listWorkers();
    expect(snapshot(repoPath)).toEqual(before);
    expect(errors).toEqual(expect.arrayContaining([
      { path: file.path, reason: 'worker placement is not a directory' },
      { path: link.path, reason: 'worker placement is a symlink' },
    ]));
    expect(workers.find((worker) => worker.path === gone.path)).toMatchObject({ branch: gone.branch, retained: { branchCommit: null } });
    expect(workers.find((worker) => worker.path === renamed.path)).toMatchObject({ error: 'its metadata does not describe this placement' });
    expect(workers.find((worker) => worker.path === renamed.path)).not.toHaveProperty('retained');
    expect(workers.filter((worker) => worker.path === file.path || worker.path === link.path)).toEqual([]);
  });

  /** A Git repository with one commit, removed after the test. */
  async function repository(prefix: string): Promise<string> {
    const repoPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    tempDirs.push(repoPath);
    await simpleGit().raw(['init', '-b', 'main', repoPath]);
    const git = simpleGit(repoPath);
    await git.raw(['config', 'user.email', 'test@example.com']);
    await git.raw(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repoPath, '.gitignore'), '.hive/\n');
    await git.add(['.gitignore']);
    await git.commit('chore: base commit\n\nCreate the fixture history.');
    return repoPath;
  }

  /** Commit one file in a checkout and return the new tip. */
  async function commitIn(checkout: string): Promise<string> {
    fs.writeFileSync(path.join(checkout, 'work.txt'), 'work\n');
    await simpleGit(checkout).add(['work.txt']);
    await simpleGit(checkout).commit('feat: add work\n\nLeave unmerged work on the worker branch.');
    return (await simpleGit(checkout).revparse(['HEAD'])).trim();
  }

  it('keeps the branch tip of a missing checkout with an error when its record is not only what a worktree-only cleanup keeps', async () => {
    const repoPath = await repository('hive-checkout-inspector-unresolved-');
    const apiPath = await repository('hive-checkout-inspector-unresolved-api-');
    const hiveDir = path.join(repoPath, '.hive');
    const repositoryResolver = () => [{ id: 'root', path: repoPath, root: repoPath }, { id: 'api', path: apiPath, root: apiPath }];
    const composite = new AdhocWorktreeService({ baseDir: repoPath, hiveDir, repositoryResolver });
    const single = new AdhocWorktreeService({ baseDir: repoPath, hiveDir });

    // A partial removal: one checkout gone, the other live.
    const partial = await composite.create({ runId: 'partial', repoIds: ['root', 'api'] });
    await simpleGit(apiPath).raw(['worktree', 'remove', partial.repos!.api.path]);
    // A composite kept by a worktree-only cleanup whose manifest then says its create was never confirmed.
    const unconfirmed = await composite.create({ runId: 'unconfirmed', repoIds: ['root', 'api'] });
    expect((await composite.cleanup('unconfirmed')).cleanup.outcome).toBe('complete');
    const manifestPath = path.join(unconfirmed.path, 'workspace.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')), createUnconfirmed: true }));
    // A clean worktree-only cleanup stays plainly retained.
    const clean = await composite.create({ runId: 'clean', repoIds: ['root', 'api'] });
    expect((await composite.cleanup('clean')).cleanup.outcome).toBe('complete');
    // Single-root records: one never confirmed, one whose checkout was deleted without Git.
    const unconfirmedRun = await single.create({ runId: 'unconfirmed-run' });
    expect((await single.cleanup('unconfirmed-run')).cleanup.outcome).toBe('complete');
    const sidecarPath = `${unconfirmedRun.path}.json`;
    fs.writeFileSync(sidecarPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(sidecarPath, 'utf8')), createUnconfirmed: true }));
    const registered = await single.create({ runId: 'registered' });
    fs.rmSync(registered.path, { recursive: true, force: true });

    const inspector = new CheckoutInspector({ baseDir: repoPath, hiveDir, repositoryResolver });
    const before = snapshot(repoPath);
    const { workers, errors } = await inspector.listWorkers();
    expect(snapshot(repoPath)).toEqual(before);
    expect(errors).toEqual([]);
    const at = (checkout: string) => workers.find((worker) => worker.path === checkout);
    expect(at(partial.repos!.root.path)).toMatchObject({ head: partial.repos!.root.commit });
    expect(at(partial.repos!.root.path)).not.toHaveProperty('error');
    for (const checkout of [partial.repos!.api.path, unconfirmed.repos!.root.path, unconfirmed.repos!.api.path]) {
      expect(at(checkout)).toMatchObject({ retained: { branchCommit: expect.any(String) }, error: expect.stringContaining('the workspace is not only the record of a worktree-only cleanup') });
    }
    for (const checkout of [clean.repos!.root.path, clean.repos!.api.path]) {
      expect(at(checkout)).toMatchObject({ retained: { branchCommit: expect.any(String) } });
      expect(at(checkout)).not.toHaveProperty('error');
    }
    expect(at(unconfirmedRun.path)).toMatchObject({ retained: { branchCommit: unconfirmedRun.commit }, error: expect.stringContaining('never confirmed the checkout (createUnconfirmed)') });
    expect(at(registered.path)).toMatchObject({ retained: { branchCommit: registered.commit }, error: 'its checkout is gone but still registered with Git' });
  });

  it('reports worker records that do not describe their placement, a foreign run\'s untrusted repository, unsupported modes and symlinked entries without reading them', async () => {
    const repoPath = await repository('hive-checkout-inspector-identity-');
    const foreignPath = await repository('hive-checkout-inspector-foreign-');
    const hiveDir = path.join(repoPath, '.hive');
    const adhocGroup = path.join(hiveDir, '.worktrees', 'adhoc');
    const repositoryResolver = () => [{ id: 'root', path: repoPath, root: repoPath }];
    const adhoc = new AdhocWorktreeService({ baseDir: repoPath, hiveDir });
    await new RetainedCheckoutService({ baseDir: repoPath, hiveDir }).create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    const rewrite = (file: string, change: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...change }));

    // Records naming another owner than their placement: a kept targeted sidecar, a live sidecar and a live manifest.
    const kept = await adhoc.create({ runId: 'kept', target: 'root/feature' });
    expect((await adhoc.cleanup('kept')).cleanup.outcome).toBe('complete');
    rewrite(`${kept.path}.json`, { runId: 'someone-else' });
    const live = await adhoc.create({ runId: 'live' });
    rewrite(`${live.path}.json`, { runId: 'someone-else' });
    const manifested = await new AdhocWorktreeService({ baseDir: repoPath, hiveDir, repositoryResolver }).create({ runId: 'manifested', repoIds: ['root'] });
    rewrite(path.join(manifested.path, 'workspace.json'), { runId: 'someone-else' });
    // A run made from a foreign checkout, kept by a worktree-only cleanup.
    const fromForeign = new AdhocWorktreeService({ baseDir: foreignPath, hiveDir });
    const away = await fromForeign.create({ runId: 'away' });
    const awayTip = await commitIn(away.path);
    expect((await fromForeign.cleanup('away')).cleanup.outcome).toBe('complete');
    // A sidecar whose mode is damaged or missing, Hive's own temporary files, and a sidecarless symlinked placement.
    fs.writeFileSync(path.join(adhocGroup, 'damaged.json'), JSON.stringify({ schemaVersion: 1, mode: 'adhoc-singel' }));
    fs.writeFileSync(path.join(adhocGroup, 'modeless.json'), JSON.stringify({ schemaVersion: 1 }));
    fs.writeFileSync(path.join(adhocGroup, 'live.json.tmp.1.2'), '{');
    fs.writeFileSync(path.join(adhocGroup, 'gone.workspace.json.cleanup-1-2'), '{}');
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-checkout-inspector-outside-')));
    tempDirs.push(outside);
    fs.writeFileSync(path.join(outside, 'workspace.json'), JSON.stringify({ secret: 'do-not-read' }));
    fs.symlinkSync(outside, path.join(adhocGroup, 'linked'));

    const inspector = new CheckoutInspector({ baseDir: repoPath, hiveDir, repositoryResolver });
    const { workers, errors } = await inspector.listWorkers();
    const at = (checkout: string) => workers.filter((worker) => worker.path === checkout);
    for (const checkout of [kept.path, live.path, manifested.path]) {
      expect(at(checkout)).toEqual([expect.objectContaining({ runId: path.basename(checkout), error: 'its metadata does not describe this placement' })]);
      expect(at(checkout)[0]).not.toHaveProperty('retained');
      expect(at(checkout)[0]).toMatchObject({ head: null });
    }
    expect(at(away.path)).toEqual([expect.objectContaining({ repoId: null, branch: 'hive/adhoc/away', error: 'its repository is not configured' })]);
    expect(errors.sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      { path: path.join(adhocGroup, 'damaged.json'), reason: 'worker metadata declares no supported mode ("adhoc-singel")' },
      { path: path.join(adhocGroup, 'linked'), reason: 'worker placement is a symlink' },
      { path: path.join(adhocGroup, 'modeless.json'), reason: 'worker metadata declares no supported mode (none)' },
    ]);
    expect(JSON.stringify({ workers, errors })).not.toContain('do-not-read');
    expect((await listTargetedSidecars(hiveDir)).unreadable.map((source) => source.path).sort()).toEqual([path.join(adhocGroup, 'damaged.json'), path.join(adhocGroup, 'modeless.json')]);

    // Once its repository is configured, the foreign run's branch is read there.
    const trusted = new CheckoutInspector({ baseDir: repoPath, hiveDir, repositoryResolver: () => [...repositoryResolver(), { id: 'foreign', path: foreignPath, root: foreignPath }] });
    expect((await trusted.listWorkers()).workers.find((worker) => worker.path === away.path)).toMatchObject({ repoId: 'foreign', retained: { branchCommit: awayTip } });
    expect((await trusted.listWorkers()).workers.find((worker) => worker.path === away.path)).not.toHaveProperty('error');

    // A symlinked worktree root is reported and not read through.
    fs.renameSync(path.join(hiveDir, '.worktrees'), path.join(hiveDir, 'worktrees-moved'));
    fs.symlinkSync(path.join(hiveDir, 'worktrees-moved'), path.join(hiveDir, '.worktrees'));
    expect(await inspector.listWorkers()).toEqual({ workers: [], errors: [{ path: path.join(hiveDir, '.worktrees'), reason: expect.stringContaining('symlink') }] });
  });

  it('reports a kept composite whose repositories the configured topology does not trust, without reading their branches', async () => {
    const repoPath = await repository('hive-checkout-inspector-composite-trust-');
    const hiveDir = path.join(repoPath, '.hive');
    const repositoryResolver = () => [{ id: 'root', path: repoPath, root: repoPath }];
    const composite = new AdhocWorktreeService({ baseDir: repoPath, hiveDir, repositoryResolver });
    const kept = await composite.create({ runId: 'kept', repoIds: ['root'] });
    expect((await composite.cleanup('kept')).cleanup.outcome).toBe('complete');
    const moved = await composite.create({ runId: 'moved', repoIds: ['root'] });
    expect((await composite.cleanup('moved')).cleanup.outcome).toBe('complete');
    const movedManifest = path.join(moved.path, 'workspace.json');
    const manifest = JSON.parse(fs.readFileSync(movedManifest, 'utf8'));
    manifest.repos.root.repoRoot = path.join(repoPath, 'elsewhere');
    fs.writeFileSync(movedManifest, JSON.stringify(manifest));

    const untrusted = 'its repository path and root do not match the configured repository topology';
    const at = (workers: Awaited<ReturnType<CheckoutInspector['listWorkers']>>['workers'], checkout: string) => workers.find((worker) => worker.path === checkout);
    // Without a repository manifest, the implicit project root trusts no composite record.
    const implicit = await new CheckoutInspector({ baseDir: repoPath, hiveDir }).listWorkers();
    for (const checkout of [kept.repos!.root.path, moved.repos!.root.path]) {
      expect(at(implicit.workers, checkout)).toMatchObject({ repoId: null, branch: expect.stringMatching(/^hive\/adhoc\/root\//), head: null, error: untrusted });
      expect(at(implicit.workers, checkout)).not.toHaveProperty('retained');
    }
    // With it, a record whose repository root changed is still untrusted, and the matching one stays retained.
    const configured = await new CheckoutInspector({ baseDir: repoPath, hiveDir, repositoryResolver }).listWorkers();
    expect(at(configured.workers, moved.repos!.root.path)).toMatchObject({ repoId: null, error: untrusted });
    expect(at(configured.workers, moved.repos!.root.path)).not.toHaveProperty('retained');
    expect(at(configured.workers, kept.repos!.root.path)).toMatchObject({ repoId: 'root', retained: { branchCommit: kept.repos!.root.commit } });
    expect(at(configured.workers, kept.repos!.root.path)).not.toHaveProperty('error');
  });

  it('reads a placement directory whose name ends in .json as a placement, not a sidecar', async () => {
    const repoPath = await repository('hive-checkout-inspector-json-name-');
    const hiveDir = path.join(repoPath, '.hive');
    const checkouts = new RetainedCheckoutService({ baseDir: repoPath, hiveDir });
    await checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    // Run ID build.json is valid: its placement is the directory build.json and its sidecar build.json.json.
    const run = await new AdhocWorktreeService({ baseDir: repoPath, hiveDir }).create({ runId: 'build.json' });

    const { workers, errors } = await new CheckoutInspector({ baseDir: repoPath, hiveDir }).listWorkers();
    expect(errors).toEqual([]);
    expect(workers).toEqual([expect.objectContaining({ kind: 'adhoc', runId: 'build.json', path: run.path, branch: 'hive/adhoc/build.json', head: run.commit })]);
    expect(workers[0]).not.toHaveProperty('error');
    expect(await checkouts.findReferences('root/feature')).toEqual({ references: [], unreadable: [] });
  });

  it('reports a kept worker whose registration cannot be read on that worker and still lists the others', async () => {
    const repoPath = await repository('hive-checkout-inspector-registration-');
    const foreignPath = await repository('hive-checkout-inspector-registration-foreign-');
    const hiveDir = path.join(repoPath, '.hive');
    const repositoryResolver = () => [{ id: 'root', path: repoPath, root: repoPath }, { id: 'foreign', path: foreignPath, root: foreignPath }];
    const local = new AdhocWorktreeService({ baseDir: repoPath, hiveDir });
    const fromForeign = new AdhocWorktreeService({ baseDir: foreignPath, hiveDir });
    const healthy = await local.create({ runId: 'healthy' });
    const healthyTip = await commitIn(healthy.path);
    expect((await local.cleanup('healthy')).cleanup.outcome).toBe('complete');
    const away = await fromForeign.create({ runId: 'away' });
    expect((await fromForeign.cleanup('away')).cleanup.outcome).toBe('complete');
    // The foreign repository stops being a Git repository, so reading its worktree registrations fails.
    fs.renameSync(path.join(foreignPath, '.git'), path.join(foreignPath, 'git-moved'));

    const inspector = new CheckoutInspector({ baseDir: repoPath, hiveDir, repositoryResolver });
    const { workers, errors } = await inspector.listWorkers();
    expect(errors).toEqual([]);
    expect(workers.find((worker) => worker.path === away.path)).toMatchObject({ repoId: 'foreign', head: null, error: expect.stringContaining('not a git repository') });
    expect(workers.find((worker) => worker.path === healthy.path)).toMatchObject({ repoId: 'root', retained: { branchCommit: healthyTip } });
    expect(workers.find((worker) => worker.path === healthy.path)).not.toHaveProperty('error');
    expect((await inspector.inspectProject()).repositories.find((repository) => repository.id === 'root')?.workers.map((worker) => worker.path)).toEqual([healthy.path]);
  });
});
