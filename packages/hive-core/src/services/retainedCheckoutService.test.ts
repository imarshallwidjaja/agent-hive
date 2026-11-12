import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { AdhocWorktreeService } from './adhocWorktreeService';
import { FeatureService } from './featureService';
import { RetainedCheckoutError } from './retainedCheckout';
import { RetainedCheckoutService } from './retainedCheckoutService';
import { RepositoryService } from './repositoryService';
import { getFeaturePath } from '../utils/paths';
import { TaskService } from './taskService';
import { WorktreeService } from './worktreeService';
import { trustedGitCommonDirectory } from './worktreeLinkage';
import { repositoryResourceName } from './worktreeOperation';
import { WorktreeOperationRecoveryRequiredError } from './worktreeOutcome';
import { readWorktreeTargetIdentity } from './worktreeTarget';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function commitFile(git: SimpleGit, cwd: string, file: string, content = `${file}\n`): Promise<string> {
  fs.writeFileSync(path.join(cwd, file), content);
  await git.add([file]);
  await git.commit(`feat: add ${file}\n\nAdd a fixture file for retained checkout tests.`);
  return (await git.revparse(['HEAD'])).trim();
}

async function createFixture() {
  const repoPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-retained-checkout-')));
  tempDirs.push(repoPath);
  await simpleGit().raw(['init', '-b', 'main', repoPath]);
  const git = simpleGit(repoPath);
  await git.raw(['config', 'user.email', 'test@example.com']);
  await git.raw(['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repoPath, '.gitignore'), '.hive/\nbuild/\n');
  await git.add(['.gitignore']);
  const base = await commitFile(git, repoPath, 'tracked.txt', 'base\n');
  const hiveDir = path.join(repoPath, '.hive');
  return {
    repoPath,
    hiveDir,
    git,
    base,
    checkouts: new RetainedCheckoutService({ baseDir: repoPath, hiveDir }),
    adhoc: new AdhocWorktreeService({ baseDir: repoPath, hiveDir }),
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe('RetainedCheckoutService', () => {
  it('creates managed checkouts from an explicit base or an existing branch and registers the configured root', async () => {
    const fx = await createFixture();
    await fx.git.raw(['branch', 'existing']);

    const created = await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main', purpose: 'long-lived feature' });
    const placement = path.join(fx.hiveDir, 'checkouts', 'root', 'feature');
    expect(created).toMatchObject({
      id: 'root/feature',
      ownership: 'managed',
      path: placement,
      ref: 'refs/heads/feat/x',
      purpose: 'long-lived feature',
      created: { commit: fx.base, branch: 'new', baseRef: 'main' },
    });
    expect(JSON.parse(fs.readFileSync(`${placement}.json`, 'utf8'))).toEqual(created);
    expect(await readWorktreeTargetIdentity(placement)).toEqual({ path: placement, ref: 'refs/heads/feat/x', commit: fx.base });
    // Repeating the request converges; a different intent at the same ID is refused, not overwritten.
    expect(await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' })).toEqual(created);
    expect((await rejection(fx.checkouts.create({ id: 'root/feature', branch: 'other', baseRef: 'main' }))).message).toContain('already exists');

    expect(await fx.checkouts.create({ id: 'root/attached', branch: 'refs/heads/existing' })).toMatchObject({ created: { branch: 'existing' } });
    expect((await rejection(fx.checkouts.create({ id: 'root/new', branch: 'missing' }))).message).toContain('name the baseRef');
    expect((await rejection(fx.checkouts.create({ id: 'root/clash', branch: 'existing', baseRef: 'main' }))).message).toContain('omit baseRef');
    expect((await rejection(fx.checkouts.create({ id: 'root/busy', branch: 'main' }))).message).toContain('already checked out');
    expect((await rejection(fx.checkouts.create({ id: 'other/x', branch: 'y', baseRef: 'main' }))).message).toContain('not configured');

    const registered = await fx.checkouts.register({ id: 'root/main' });
    expect(registered).toMatchObject({ ownership: 'registered', path: fx.repoPath, ref: 'refs/heads/main', created: { commit: fx.base, branch: 'existing' } });
    expect((await rejection(fx.checkouts.register({ id: 'root/again' }))).message).toContain('already registered as root/main');
    // Registration records the configured checkout in place: nothing is created beside the record.
    expect(fs.existsSync(path.join(fx.hiveDir, 'checkouts', 'root', 'main'))).toBe(false);
  });

  it('pins declared readiness to the inspected commit and refuses a stale expectation or a foreign next target', async () => {
    const fx = await createFixture();
    await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    await fx.checkouts.create({ id: 'root/release', branch: 'release', baseRef: 'main' });
    const placement = path.join(fx.hiveDir, 'checkouts', 'root', 'feature');
    const expected = await readWorktreeTargetIdentity(placement);

    const ready = await fx.checkouts.setReadiness('root/feature', expected, { state: 'ready', nextTarget: 'root/release', waitingFor: 'release window' });
    expect(ready.readiness).toMatchObject({ state: 'ready', commit: fx.base, nextTarget: 'root/release', waitingFor: 'release window' });

    await commitFile(simpleGit(placement), placement, 'feature.txt');
    expect((await rejection(fx.checkouts.setReadiness('root/feature', expected, { state: 'not_ready' }))).message).toContain('inspect it again');
    const fresh = await readWorktreeTargetIdentity(placement);
    expect((await rejection(fx.checkouts.setReadiness('root/feature', fresh, { state: 'ready', nextTarget: 'root/feature' }))).message).toContain('another retained checkout');
    expect((await rejection(fx.checkouts.setReadiness('root/feature', fresh, { state: 'ready', nextTarget: 'api/main' }))).message).toContain('another retained checkout');
    expect(await fx.checkouts.setReadiness('root/feature', fresh, null)).not.toHaveProperty('readiness');
  });

  it('refuses cleanup while tasks, workers or declarations reference the checkout, and while it holds local work', async () => {
    const fx = await createFixture();
    await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    await fx.checkouts.create({ id: 'root/release', branch: 'release', baseRef: 'main' });
    const placement = path.join(fx.hiveDir, 'checkouts', 'root', 'feature');

    new FeatureService(fx.repoPath).create('demo');
    const task = new TaskService(fx.repoPath).create('demo', 'Ship it', undefined, { target: 'root/feature' });
    const bound = await fx.adhoc.create({ runId: 'bound', target: 'root/feature' });
    await fx.checkouts.setReadiness('root/release', await readWorktreeTargetIdentity(path.join(fx.hiveDir, 'checkouts', 'root', 'release')), { state: 'ready', nextTarget: 'root/feature' });

    const proposal = await fx.checkouts.inspectCleanup('root/feature');
    // Each reference names the file that holds it.
    expect(proposal.references.sort((left, right) => left.kind.localeCompare(right.kind))).toEqual([
      { kind: 'next_target', from: 'root/release', recordPath: path.join(fx.hiveDir, 'checkouts', 'root', 'release.json') },
      { kind: 'task', feature: 'demo', task, status: 'pending', statusPath: path.join(getFeaturePath(fx.repoPath, 'demo'), 'tasks', task, 'status.json') },
      { kind: 'worker', path: bound.path, sidecarPath: `${bound.path}.json`, runId: 'bound' },
    ]);
    expect(proposal.present).toBe(true);
    expect(proposal.blockers).toHaveLength(3);
    const referenced = await rejection(fx.checkouts.cleanup('root/feature', { expected: proposal.identity }));
    expect(referenced).toBeInstanceOf(RetainedCheckoutError);
    expect((referenced as RetainedCheckoutError).reason).toBe('referenced');

    fs.rmSync(path.join(fx.repoPath, '.hive', 'features'), { recursive: true, force: true });
    await fx.adhoc.cleanup('bound', true);
    const releaseIdentity = await readWorktreeTargetIdentity(path.join(fx.hiveDir, 'checkouts', 'root', 'release'));
    await fx.checkouts.setReadiness('root/release', releaseIdentity, null);

    fs.writeFileSync(path.join(placement, 'scratch.txt'), 'untracked\n');
    const untracked = await fx.checkouts.inspectCleanup('root/feature');
    expect(untracked.blockers).toEqual(['the checkout has modified or untracked files: scratch.txt']);
    expect(((await rejection(fx.checkouts.cleanup('root/feature', { expected: untracked.identity }))) as RetainedCheckoutError).reason).toBe('local_data');
    fs.rmSync(path.join(placement, 'scratch.txt'));

    fs.mkdirSync(path.join(placement, 'build', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(placement, 'build', 'out.bin'), 'generated\n');
    fs.writeFileSync(path.join(placement, 'build', 'deep', 'more.bin'), 'generated\n');
    const ignored = await fx.checkouts.inspectCleanup('root/feature');
    // A wholly ignored tree is one entry, not every file under it.
    expect(ignored.local?.ignored).toEqual(['build/']);
    expect(ignored.blockers).toEqual([]);
    expect((await rejection(fx.checkouts.cleanup('root/feature', { expected: ignored.identity }))).message).toContain('ignored content');
    expect(fs.existsSync(path.join(placement, 'build', 'out.bin'))).toBe(true);

    // A stale expectation is refused before anything is removed.
    const stale = { ...ignored.identity!, commit: '0'.repeat(40) };
    expect(((await rejection(fx.checkouts.cleanup('root/feature', { expected: stale, removeIgnored: true }))) as RetainedCheckoutError).reason).toBe('binding_mismatch');

    // Worktree-only removal keeps the branch.
    const removed = await fx.checkouts.cleanup('root/feature', { expected: ignored.identity, removeIgnored: true });
    expect(removed).toMatchObject({ worktreeRemoved: true, branchDeleted: false, recordRemoved: true });
    expect(fs.existsSync(placement) || fs.existsSync(`${placement}.json`)).toBe(false);
    expect((await fx.git.raw(['show-ref', '--verify', '--hash', 'refs/heads/feat/x'])).trim()).toBe(fx.base);
  });

  it("deletes a managed branch only when a surviving checkout's intended branch, checked out there, contains it or an explicit discard pins it, and never touches a registered checkout", async () => {
    const fx = await createFixture();
    await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    await fx.checkouts.create({ id: 'root/release', branch: 'release', baseRef: 'main' });
    await fx.checkouts.create({ id: 'root/spike', branch: 'spike', baseRef: 'main' });
    await fx.checkouts.register({ id: 'root/main' });
    const featurePath = path.join(fx.hiveDir, 'checkouts', 'root', 'feature');
    const releasePath = path.join(fx.hiveDir, 'checkouts', 'root', 'release');
    const spikePath = path.join(fx.hiveDir, 'checkouts', 'root', 'spike');
    const featureTip = await commitFile(simpleGit(featurePath), featurePath, 'feature.txt');
    const spikeTip = await commitFile(simpleGit(spikePath), spikePath, 'spike.txt');

    const notContained = await fx.checkouts.inspectCleanup('root/feature');
    expect(((await rejection(fx.checkouts.cleanup('root/feature', { expected: notContained.identity, deleteBranch: { containedIn: 'root/release' } }))) as RetainedCheckoutError).reason).toBe('not_contained');
    expect(fs.existsSync(featurePath)).toBe(true);
    // The survivor's HEAD contains the tip, but its branch does not.
    const releaseGit = simpleGit(releasePath);
    await releaseGit.raw(['switch', '--detach', featureTip]);
    const detached = await rejection(fx.checkouts.cleanup('root/feature', { expected: notContained.identity, deleteBranch: { containedIn: 'root/release' } }));
    expect((detached as RetainedCheckoutError).reason).toBe('binding_mismatch');
    expect(detached.message).toContain('Surviving checkout root/release is on a detached HEAD');
    await releaseGit.raw(['switch', 'release']);

    await releaseGit.raw(['merge', '--ff-only', featureTip]);
    const contained = await fx.checkouts.cleanup('root/feature', { expected: notContained.identity, deleteBranch: { containedIn: 'root/release' } });
    expect(contained).toMatchObject({ worktreeRemoved: true, branchDeleted: true, recordRemoved: true });
    expect(await fx.git.raw(['branch', '--list', 'feat/x'])).toBe('');

    const spike = await fx.checkouts.inspectCleanup('root/spike');
    expect(((await rejection(fx.checkouts.cleanup('root/spike', { expected: spike.identity, deleteBranch: { discard: true, commit: fx.base } }))) as RetainedCheckoutError).reason).toBe('binding_mismatch');
    expect(await fx.checkouts.cleanup('root/spike', { expected: spike.identity, deleteBranch: { discard: true, commit: spikeTip } })).toMatchObject({ branchDeleted: true });

    const root = await fx.checkouts.inspectCleanup('root/main');
    expect(root.local).toBeNull();
    expect(((await rejection(fx.checkouts.cleanup('root/main', { expected: root.identity, deleteBranch: { discard: true, commit: fx.base } }))) as RetainedCheckoutError).reason).toBe('user_owned');
    expect(await fx.checkouts.cleanup('root/main', { expected: root.identity })).toMatchObject({ ownership: 'registered', worktreeRemoved: false, branchDeleted: false, recordRemoved: true });
    expect(await readWorktreeTargetIdentity(fx.repoPath)).toEqual({ path: fx.repoPath, ref: 'refs/heads/main', commit: fx.base });
  });

  it('refuses records that name another checkout, an unconfigured repository or a redirected worktree', async () => {
    const fx = await createFixture();
    const created = await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    const recordPath = path.join(fx.hiveDir, 'checkouts', 'root', 'feature.json');
    const identity = await readWorktreeTargetIdentity(created.path);

    fs.writeFileSync(recordPath, JSON.stringify({ ...created, path: fx.repoPath }));
    expect(((await rejection(fx.checkouts.setReadiness('root/feature', identity, { state: 'ready' }))) as RetainedCheckoutError).reason).toBe('binding_mismatch');
    expect(((await rejection(fx.adhoc.create({ runId: 'spoofed', target: 'root/feature' }))) as RetainedCheckoutError).reason).toBe('binding_mismatch');

    fs.writeFileSync(recordPath, JSON.stringify({ ...created, id: 'root/other' }));
    expect(((await rejection(fx.checkouts.inspectCleanup('root/feature'))) as RetainedCheckoutError).reason).toBe('record_invalid');
    fs.writeFileSync(recordPath, '{');
    expect(((await rejection(fx.checkouts.inspectCleanup('root/feature'))) as RetainedCheckoutError).reason).toBe('record_invalid');

    fs.writeFileSync(recordPath, JSON.stringify(created));
    const foreign = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-retained-foreign-')));
    tempDirs.push(foreign);
    await simpleGit().raw(['init', '-b', 'main', foreign]);
    fs.writeFileSync(path.join(created.path, '.git'), `gitdir: ${path.join(foreign, '.git')}\n`);
    expect((await rejection(fx.adhoc.create({ runId: 'redirected', target: 'root/feature' }))).message).toContain('linkage preflight failed');

    const unknownRepo = { ...created, id: 'api/feature', repoId: 'api', path: path.join(fx.hiveDir, 'checkouts', 'api', 'feature') };
    fs.mkdirSync(path.join(fx.hiveDir, 'checkouts', 'api'));
    fs.writeFileSync(path.join(fx.hiveDir, 'checkouts', 'api', 'feature.json'), JSON.stringify(unknownRepo));
    expect(((await rejection(fx.adhoc.create({ runId: 'unknown', target: 'api/feature' }))) as Error).message).toContain('does not configure');
  });

  it('returns an existing checkout only for the same starting intent, branch and purpose', async () => {
    const fx = await createFixture();
    const created = await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main', purpose: 'feature' });
    expect(await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: fx.base })).toEqual(created);

    const refusals = async (input: Parameters<typeof fx.checkouts.create>[0]) => (await rejection(fx.checkouts.create(input))).message;
    expect(await refusals({ id: 'root/feature', branch: 'feat/x' })).toContain(`created refs/heads/feat/x from baseRef "main" at ${fx.base}; this request attaches an existing branch`);
    expect(await refusals({ id: 'root/feature', branch: 'feat/x', baseRef: 'main', purpose: 'other' })).toContain('already exists with purpose "feature"');
    // The base branch moved: the same words now ask for another starting point.
    const moved = await commitFile(fx.git, fx.repoPath, 'moved.txt');
    expect(await refusals({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' })).toContain(`baseRef "main" now resolves to ${moved}`);
    expect(await refusals({ id: 'root/feature', branch: 'feat/x', baseRef: moved })).toContain(`at ${fx.base}; baseRef "${moved}" now resolves to ${moved}`);

    await fx.git.raw(['branch', 'existing']);
    await fx.checkouts.create({ id: 'root/attached', branch: 'existing' });
    expect(await refusals({ id: 'root/attached', branch: 'existing', baseRef: 'main' })).toContain('attached the existing branch refs/heads/existing');
    // A checkout switched away from its branch is not the checkout the request describes.
    await simpleGit(created.path).raw(['switch', '-c', 'elsewhere']);
    expect(await refusals({ id: 'root/feature', branch: 'feat/x', baseRef: fx.base })).toContain('is on refs/heads/elsewhere, not its intended refs/heads/feat/x');
  });

  it('refuses to remove a managed checkout off its branch or inside a stopped Git operation, even with discard', async () => {
    const fx = await createFixture();
    const created = await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    const git = simpleGit(created.path);
    const refuse = async (deleteBranch?: { discard: true; commit: string }) => {
      const proposal = await fx.checkouts.inspectCleanup('root/feature');
      const error = await rejection(fx.checkouts.cleanup('root/feature', { expected: proposal.identity, ...(deleteBranch ? { deleteBranch } : {}) }));
      expect(fs.existsSync(created.path)).toBe(true);
      return { proposal, error: error as RetainedCheckoutError };
    };

    await git.raw(['switch', '--detach']);
    const unique = await commitFile(git, created.path, 'detached.txt');
    const detached = await refuse({ discard: true, commit: fx.base });
    expect(detached.error.reason).toBe('binding_mismatch');
    expect(detached.proposal.onIntendedRef).toBe(false);
    expect(detached.proposal.blockers).toEqual([`the checkout is on a detached HEAD at ${unique}, not its intended refs/heads/feat/x; switch it back or keep its work on a branch first`]);

    await git.raw(['switch', '-c', 'switched']);
    expect((await refuse()).error.message).toContain('is on refs/heads/switched');

    // A rebase stopped by a failing exec leaves a clean tree but an operation in progress.
    await git.raw(['switch', 'feat/x']);
    await commitFile(git, created.path, 'replayed.txt');
    await git.raw(['rebase', '--exec', 'false', 'main']).catch(() => undefined);
    const rebasing = await refuse();
    expect(rebasing.error.reason).toBe('local_data');
    expect(rebasing.proposal.blockers.some((blocker) => /Git operation in progress or stopped \(.*rebase-merge/.test(blocker))).toBe(true);
    await git.raw(['rebase', '--abort']);
    const clean = await fx.checkouts.inspectCleanup('root/feature');
    expect(clean.blockers).toEqual([]);
  });

  it('removes only the record of a managed checkout deleted outside Hive, and refuses when the record, placement or references are not as inspected', async () => {
    const fx = await createFixture();
    const feature = await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    const kept = await fx.checkouts.create({ id: 'root/kept', branch: 'kept', baseRef: 'main' });
    await fx.checkouts.register({ id: 'root/main' });
    const recordPath = `${feature.path}.json`;
    const recordBytes = fs.readFileSync(recordPath, 'utf8');
    // An unrelated worktree deleted without Git leaves a prunable registration that must survive too.
    const unrelated = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-retained-unrelated-'))), 'wt');
    tempDirs.push(path.dirname(unrelated));
    await fx.git.raw(['worktree', 'add', '-b', 'unrelated', unrelated]);
    fs.rmSync(unrelated, { recursive: true, force: true });
    // The operator deletes one checkout's directory, and removes the other through Git along with its branch.
    fs.rmSync(feature.path, { recursive: true, force: true });
    await fx.git.raw(['worktree', 'remove', kept.path]);
    await fx.git.raw(['branch', '-D', 'kept']);
    expect(await fx.git.raw(['worktree', 'list', '--porcelain'])).toContain(`worktree ${feature.path}\nHEAD ${fx.base}\nbranch refs/heads/feat/x\nprunable`);

    const proposal = await fx.checkouts.inspectCleanup('root/feature');
    expect(proposal).toMatchObject({ present: false, identity: null, references: [], unreadableReferences: [], pendingOperations: [], blockers: [] });
    const refusal = async () => {
      const before = fs.readFileSync(recordPath, 'utf8');
      const error = await rejection(fx.checkouts.removeMissingRecord('root/feature', proposal.record));
      expect(fs.readFileSync(recordPath, 'utf8')).toBe(before);
      return error;
    };

    // The record changed after inspection, in its purpose or its readiness.
    for (const changed of [{ ...proposal.record, purpose: 'reused' }, { ...proposal.record, readiness: { state: 'ready', commit: fx.base, recordedAt: '2026-11-12T00:00:00.000Z' } }]) {
      fs.writeFileSync(recordPath, JSON.stringify(changed));
      expect(((await refusal()) as RetainedCheckoutError).reason).toBe('binding_mismatch');
      expect(JSON.parse(fs.readFileSync(recordPath, 'utf8'))).toEqual(changed);
    }
    fs.writeFileSync(recordPath, recordBytes);
    // Key order is not part of the record's identity.
    const reordered = Object.fromEntries(Object.entries(proposal.record).reverse()) as typeof proposal.record;

    // Something exists at the placement again: the worktree recreated by Git, a plain directory, or a symlink.
    await fx.git.raw(['worktree', 'add', '-f', feature.path, 'feat/x']);
    expect((await refusal()).message).toContain('it is not missing');
    fs.rmSync(feature.path, { recursive: true, force: true });
    fs.mkdirSync(feature.path);
    await refusal();
    fs.rmdirSync(feature.path);
    fs.symlinkSync(fx.repoPath, feature.path);
    expect((await refusal()).message).toContain('symlink');
    fs.rmSync(feature.path);

    // The record itself is reached through a symlink.
    const copy = path.join(path.dirname(unrelated), 'feature.json');
    fs.writeFileSync(copy, recordBytes);
    fs.rmSync(recordPath);
    fs.symlinkSync(copy, recordPath);
    expect((await refusal()).message).toContain('symlink');
    fs.rmSync(recordPath);
    fs.writeFileSync(recordPath, recordBytes);

    // A registered record is never a stale managed record.
    const main = (await fx.checkouts.inspectCleanup('root/main')).record;
    expect(((await rejection(fx.checkouts.removeMissingRecord('root/main', main))) as RetainedCheckoutError).reason).toBe('user_owned');

    // A reference, or a source that could hold one, appeared after inspection.
    new FeatureService(fx.repoPath).create('demo');
    new TaskService(fx.repoPath).create('demo', 'Ship it', undefined, { target: 'root/feature' });
    expect(((await refusal()) as RetainedCheckoutError).reason).toBe('referenced');
    fs.rmSync(path.join(fx.hiveDir, 'features'), { recursive: true, force: true });
    fs.writeFileSync(path.join(fx.hiveDir, 'checkouts', 'root', 'broken.json'), '{');
    expect(((await refusal()) as RetainedCheckoutError).reason).toBe('references_unknown');
    fs.rmSync(path.join(fx.hiveDir, 'checkouts', 'root', 'broken.json'));

    // An interrupted operation guards the repository.
    const legacyLock = path.join(fx.hiveDir, '.operation-locks', `${repositoryResourceName(await trustedGitCommonDirectory(fx.repoPath))}.lock`);
    fs.mkdirSync(path.dirname(legacyLock), { recursive: true });
    fs.writeFileSync(legacyLock, '{}');
    expect(await refusal()).toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    fs.rmSync(legacyLock);

    const registrations = await fx.git.raw(['worktree', 'list', '--porcelain']);
    expect(await fx.checkouts.removeMissingRecord('root/feature', reordered)).toEqual({ id: 'root/feature', ownership: 'managed', worktreeRemoved: false, branchDeleted: false, recordRemoved: true });
    expect(fs.existsSync(recordPath)).toBe(false);
    expect((await fx.git.raw(['show-ref', '--verify', '--hash', 'refs/heads/feat/x'])).trim()).toBe(fx.base);
    const keptProposal = await fx.checkouts.inspectCleanup('root/kept');
    expect(keptProposal).toMatchObject({ present: false, blockers: [] });
    expect(await fx.checkouts.removeMissingRecord('root/kept', keptProposal.record)).toMatchObject({ recordRemoved: true, branchDeleted: false });
    // Git was only read and no pending marker was written: every registration, prunable or not, is unchanged.
    expect(await fx.git.raw(['worktree', 'list', '--porcelain'])).toBe(registrations);
    const markers = path.join(fx.hiveDir, '.locks', 'operations');
    expect(fs.existsSync(markers) ? fs.readdirSync(markers) : []).toEqual([]);
    expect(((await rejection(fx.checkouts.removeMissingRecord('root/feature', proposal.record))) as RetainedCheckoutError).reason).toBe('not_found');
  });

  it('keeps a missing checkout record while a sibling record or repository directory that could name it is not a readable entry', async () => {
    const fx = await createFixture();
    const feature = await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    fs.rmSync(feature.path, { recursive: true, force: true });
    const checkoutsRoot = path.join(fx.hiveDir, 'checkouts');
    const recordPath = `${feature.path}.json`;
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-retained-hidden-')));
    tempDirs.push(outside);
    const naming = (id: string) => JSON.stringify({
      schemaVersion: 1, id, repoId: id.split('/')[0], slug: id.split('/')[1], ownership: 'managed', path: path.join(checkoutsRoot, id), ref: 'refs/heads/peer',
      created: { at: '2026-11-12T00:00:00.000Z', commit: fx.base, branch: 'existing' },
      readiness: { state: 'ready', commit: fx.base, recordedAt: '2026-11-12T00:00:00.000Z', nextTarget: 'root/feature' },
    });
    fs.writeFileSync(path.join(outside, 'peer.json'), naming('root/peer'));
    fs.mkdirSync(path.join(outside, 'other'));
    fs.writeFileSync(path.join(outside, 'other', 'peer.json'), naming('other/peer'));
    // Unrecorded placements and scratch files cannot hold a record, so they never block.
    fs.mkdirSync(path.join(checkoutsRoot, 'root', 'scratch'));
    fs.writeFileSync(path.join(checkoutsRoot, 'root', 'notes.txt'), 'scratch\n');
    fs.writeFileSync(path.join(checkoutsRoot, 'README.md'), 'scratch\n');
    const proposal = await fx.checkouts.inspectCleanup('root/feature');
    expect(proposal.blockers).toEqual([]);

    const refused = async (hidden: string) => {
      const scan = await fx.checkouts.findReferences('root/feature');
      expect(scan.unreadable.map((source) => source.path)).toEqual([hidden]);
      const error = await rejection(fx.checkouts.removeMissingRecord('root/feature', proposal.record));
      expect((error as RetainedCheckoutError).reason).toBe('references_unknown');
      expect(fs.existsSync(recordPath)).toBe(true);
    };
    // A sibling record reached through a symlink, or one that is not a regular file.
    const sibling = path.join(checkoutsRoot, 'root', 'peer.json');
    fs.symlinkSync(path.join(outside, 'peer.json'), sibling);
    await refused(sibling);
    fs.rmSync(sibling);
    fs.mkdirSync(sibling);
    await refused(sibling);
    fs.rmdirSync(sibling);
    // A repository directory reached through a symlink.
    const repository = path.join(checkoutsRoot, 'other');
    fs.symlinkSync(path.join(outside, 'other'), repository);
    await refused(repository);
    fs.rmSync(repository);
    // The checkouts root itself reached through a symlink is never listed.
    const moved = path.join(outside, 'checkouts');
    fs.renameSync(checkoutsRoot, moved);
    fs.symlinkSync(moved, checkoutsRoot);
    expect((await fx.checkouts.findReferences('root/feature')).unreadable.map((source) => source.path)).toContain(checkoutsRoot);
    fs.rmSync(checkoutsRoot);
    fs.renameSync(moved, checkoutsRoot);

    expect(await fx.checkouts.removeMissingRecord('root/feature', proposal.record)).toMatchObject({ recordRemoved: true });
  });

  it('checks the record and placement again after the reference scan, so a change made during the scan is refused', async () => {
    const fx = await createFixture();
    const feature = await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    fs.rmSync(feature.path, { recursive: true, force: true });
    const recordPath = `${feature.path}.json`;
    const proposal = await fx.checkouts.inspectCleanup('root/feature');
    const scan = fx.checkouts.findReferences.bind(fx.checkouts);
    // Another writer acts while the scan runs, after the first record and placement checks passed.
    const duringScan = async (change: () => Promise<void> | void) => {
      fx.checkouts.findReferences = async (id: string) => {
        const result = await scan(id);
        await change();
        return result;
      };
      try {
        return await rejection(fx.checkouts.removeMissingRecord('root/feature', proposal.record));
      } finally {
        fx.checkouts.findReferences = scan;
      }
    };

    const changed = { ...proposal.record, purpose: 'reused' };
    const replaced = await duringScan(() => fs.writeFileSync(recordPath, JSON.stringify(changed)));
    expect((replaced as RetainedCheckoutError).reason).toBe('binding_mismatch');
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8'))).toEqual(changed);
    fs.writeFileSync(recordPath, JSON.stringify(proposal.record));

    const recreated = await duringScan(async () => {
      await fx.git.raw(['worktree', 'add', '-f', feature.path, 'feat/x']);
    });
    expect(recreated.message).toContain('it is not missing');
    expect(fs.existsSync(recordPath)).toBe(true);
  });

  it('counts persisted references and refuses cleanup while any reference source is unreadable or unknown', async () => {
    const fx = await createFixture();
    await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    const run = await fx.adhoc.create({ runId: 'kept-branch', target: 'root/feature' });
    await commitFile(simpleGit(run.path), run.path, 'unmerged.txt');
    // Worktree-only cleanup keeps the unmerged branch, so the binding and its reference stay.
    expect((await fx.adhoc.cleanup('kept-branch', false)).cleanup).toMatchObject({ outcome: 'complete', worktreeRemoval: { status: 'succeeded' } });
    expect(fs.existsSync(run.path)).toBe(false);
    expect((await fx.checkouts.findReferences('root/feature')).references).toEqual([{ kind: 'worker', path: run.path, sidecarPath: `${run.path}.json`, runId: 'kept-branch' }]);
    expect(await fx.adhoc.cleanup('kept-branch', true, { discard: true })).toMatchObject({ cleanup: { outcome: 'complete' } });
    expect(await fx.checkouts.findReferences('root/feature')).toEqual({ references: [], unreadable: [] });

    const statusPath = path.join(fx.hiveDir, 'features', 'demo', 'tasks', '01-ship', 'status.json');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, '{');
    const foreign = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-retained-outside-'))), 'secret.json');
    tempDirs.push(path.dirname(foreign));
    fs.writeFileSync(foreign, JSON.stringify({ mode: 'adhoc-targeted', target: { id: 'root/feature' } }));
    fs.mkdirSync(path.join(fx.hiveDir, '.worktrees', 'adhoc'), { recursive: true });
    fs.symlinkSync(foreign, path.join(fx.hiveDir, '.worktrees', 'adhoc', 'planted.json'));
    fs.writeFileSync(path.join(fx.hiveDir, 'checkouts', 'root', 'broken.json'), '{');
    // A task without status, and feature or task entries the listings would skip as symlinks.
    fs.mkdirSync(path.join(fx.hiveDir, 'features', 'demo', 'tasks', '02-unrecorded'));
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-retained-linked-')));
    tempDirs.push(elsewhere);
    fs.symlinkSync(elsewhere, path.join(fx.hiveDir, 'features', 'linked'));
    fs.symlinkSync(elsewhere, path.join(fx.hiveDir, 'features', 'demo', 'tasks', '03-linked'));
    // Targeted work whose sidecar is gone still names a target nobody can read.
    const lost = await fx.adhoc.create({ runId: 'lost', target: 'root/feature' });
    fs.rmSync(path.join(fx.hiveDir, '.worktrees', 'adhoc', 'lost.json'));
    // A stray file that is no worker record is not a reference source.
    fs.writeFileSync(path.join(fx.hiveDir, '.worktrees', 'adhoc', 'notes.txt'), 'scratch\n');

    const proposal = await fx.checkouts.inspectCleanup('root/feature');
    expect(proposal.references).toEqual([]);
    expect(proposal.unreadableReferences.map((source) => source.path.replace(`${fx.hiveDir}${path.sep}`, '')).sort()).toEqual([
      path.join('.worktrees', 'adhoc', 'planted.json'),
      path.join('checkouts', 'root', 'broken.json'),
      path.join('features', 'demo', 'tasks', '01-ship', 'status.json'),
      path.join('features', 'demo', 'tasks', '02-unrecorded', 'status.json'),
      path.join('features', 'demo', 'tasks', '03-linked'),
      path.join('features', 'linked'),
      `${fx.repoPath}:refs/heads/hive-targeted/adhoc/lost`,
    ].sort());
    expect(proposal.unreadableReferences.find((source) => source.path.endsWith('adhoc/lost'))?.reason).toContain('in repository root has no binding metadata');
    expect(proposal.blockers).toHaveLength(7);
    expect(fs.existsSync(lost.path)).toBe(true);
    const refused = await rejection(fx.checkouts.cleanup('root/feature', { expected: proposal.identity }));
    expect((refused as RetainedCheckoutError).reason).toBe('references_unknown');
    expect(fs.existsSync(path.join(fx.hiveDir, 'checkouts', 'root', 'feature'))).toBe(true);
    // Registration cannot prove the root is unregistered past an unreadable record either.
    expect((await rejection(fx.checkouts.register({ id: 'root/main' }))).message).toContain('Invalid JSON in retained checkout record');
  });

  it('reads each task status from the file a task worker reads, including the legacy execution layout', async () => {
    const fx = await createFixture();
    await fx.checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    const featurePath = path.join(fx.hiveDir, 'features', 'old');
    const writeStatus = (layout: 'tasks' | 'execution', folder: string, status: unknown) => {
      fs.mkdirSync(path.join(featurePath, layout, folder), { recursive: true });
      fs.writeFileSync(path.join(featurePath, layout, folder, 'status.json'), typeof status === 'string' ? status : JSON.stringify(status));
    };
    const pending = { status: 'pending', origin: 'plan', target: 'root/feature' };
    // Only the legacy layout records this task, and no worker exists for it yet.
    writeStatus('execution', '01-legacy', pending);
    // A modern status wins over a legacy one in either direction, and its task is counted once.
    writeStatus('tasks', '02-both', pending);
    writeStatus('execution', '02-both', pending);
    writeStatus('tasks', '03-finished', { ...pending, status: 'done' });
    writeStatus('execution', '03-finished', pending);
    // A modern folder without a status file falls back to the legacy one.
    fs.mkdirSync(path.join(featurePath, 'tasks', '04-fallback'), { recursive: true });
    writeStatus('execution', '04-fallback', pending);

    const task = (layout: 'tasks' | 'execution', folder: string) => ({ kind: 'task' as const, feature: 'old', task: folder, status: 'pending', statusPath: path.join(featurePath, layout, folder, 'status.json') });
    expect(await fx.checkouts.findReferences('root/feature')).toEqual({ references: [task('execution', '01-legacy'), task('tasks', '02-both'), task('execution', '04-fallback')], unreadable: [] });
    const proposal = await fx.checkouts.inspectCleanup('root/feature');
    expect(((await rejection(fx.checkouts.cleanup('root/feature', { expected: proposal.identity }))) as RetainedCheckoutError).reason).toBe('referenced');
    // The worker reads the same file: it binds the target the fallback status declares.
    expect(await new WorktreeService({ baseDir: fx.repoPath, hiveDir: fx.hiveDir }).create('old', '04-fallback')).toMatchObject({ targetBinding: { id: 'root/feature' } });

    // A legacy status that cannot be read could name the checkout too.
    writeStatus('execution', '05-broken', '{');
    expect((await fx.checkouts.findReferences('root/feature')).unreadable.map((source) => source.path)).toEqual([path.join(featurePath, 'execution', '05-broken', 'status.json')]);
  });

  it('registers a manifest repository configured as a subdirectory by its checkout root and integrates a worker into it', async () => {
    const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-retained-subdir-')));
    tempDirs.push(projectRoot);
    const repoRoot = path.join(projectRoot, 'app-repo');
    await simpleGit().raw(['init', '-b', 'main', repoRoot]);
    const git = simpleGit(repoRoot);
    await git.raw(['config', 'user.email', 'test@example.com']);
    await git.raw(['config', 'user.name', 'Test User']);
    fs.mkdirSync(path.join(repoRoot, 'pkg'));
    await commitFile(git, repoRoot, 'pkg/index.txt');
    const repositories = new RepositoryService(projectRoot).resolveManifest([{ id: 'app', path: 'app-repo/pkg' }]);
    expect(repositories).toEqual([{ id: 'app', path: path.join(repoRoot, 'pkg'), root: repoRoot }]);
    const hiveDir = path.join(projectRoot, '.hive');
    const checkouts = new RetainedCheckoutService({ baseDir: projectRoot, hiveDir, repositoryResolver: () => repositories });
    const adhoc = new AdhocWorktreeService({ baseDir: projectRoot, hiveDir, repositoryResolver: () => repositories });

    expect(await checkouts.register({ id: 'app/main' })).toMatchObject({ ownership: 'registered', path: repoRoot, ref: 'refs/heads/main' });
    const run = await adhoc.create({ runId: 'sub', target: 'app/main' });
    const sourceCommit = await commitFile(simpleGit(run.path), run.path, 'pkg/worker.txt');
    const inspected = (await adhoc.inspect('sub'))!;
    expect(inspected).toMatchObject({ targetBinding: { id: 'app/main', path: repoRoot, status: 'ok' }, target: { path: repoRoot } });
    const merged = await adhoc.merge('sub', 'merge', 'feat: integrate the worker\n\nMerge the worker into the registered checkout.', { historyIntent: 'preserve-source', sourceCommit, expectedTarget: inspected.target!, cleanup: 'worktree+branch' });
    expect(merged).toMatchObject({ success: true, merged: true, cleanup: { outcome: 'complete' } });
    expect(fs.readFileSync(path.join(repoRoot, 'pkg', 'worker.txt'), 'utf8')).toBe('pkg/worker.txt\n');
  });
});
