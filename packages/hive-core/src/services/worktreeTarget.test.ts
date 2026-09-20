import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import {
  compareWorktreeTarget,
  inspectWorktreeTarget,
  readWorktreeTargetIdentity,
  sameWorktreeTarget,
  validateTargetExpectations,
} from './worktreeTarget.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createRepo(): Promise<{ repoPath: string; base: string }> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-target-test-'));
  tempDirs.push(repoPath);
  const git = simpleGit(repoPath);
  await git.init();
  await git.raw(['branch', '-M', 'main']);
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test User');
  await fs.writeFile(path.join(repoPath, 'tracked.txt'), 'base\n');
  await git.add('tracked.txt');
  await git.commit('test: base');
  return { repoPath, base: (await git.revparse(['HEAD'])).trim() };
}

describe('worktree target identity', () => {
  it('reports equality/containment without mutating the repository', async () => {
    const { repoPath, base } = await createRepo();
    const before = await fs.readFile(path.join(repoPath, 'tracked.txt'), 'utf8');

    const inspected = await inspectWorktreeTarget(repoPath, base);

    expect(inspected).toEqual({
      target: { path: repoPath, ref: 'refs/heads/main', commit: base },
      comparison: { status: 'ok', targetIsAncestorOfSource: true },
    });
    expect(await fs.readFile(path.join(repoPath, 'tracked.txt'), 'utf8')).toBe(before);
    expect((await simpleGit(repoPath).status()).isClean()).toBe(true);
  });

  it('distinguishes divergence from locally absent common ancestry', async () => {
    const { repoPath, base } = await createRepo();
    const git = simpleGit(repoPath);
    await git.checkoutLocalBranch('source');
    await fs.writeFile(path.join(repoPath, 'source.txt'), 'source\n');
    await git.add('source.txt');
    await git.commit('test: source');
    const source = (await git.revparse(['HEAD'])).trim();
    await git.checkout('main');
    await fs.writeFile(path.join(repoPath, 'target.txt'), 'target\n');
    await git.add('target.txt');
    await git.commit('test: target');
    const target = (await git.revparse(['HEAD'])).trim();

    expect(await compareWorktreeTarget(repoPath, target, source)).toEqual({
      status: 'ok',
      targetIsAncestorOfSource: false,
    });

    await git.raw(['checkout', '--orphan', 'unrelated']);
    await git.raw(['rm', '-rf', '.']);
    await fs.writeFile(path.join(repoPath, 'unrelated.txt'), 'unrelated\n');
    await git.add('unrelated.txt');
    await git.commit('test: unrelated');
    const unrelated = (await git.revparse(['HEAD'])).trim();
    expect(await compareWorktreeTarget(repoPath, base, unrelated)).toEqual({ status: 'no-common-ancestor' });
  });

  it('captures detached state and detects a same-commit branch switch', async () => {
    const { repoPath, base } = await createRepo();
    const git = simpleGit(repoPath);
    const main = await readWorktreeTargetIdentity(repoPath);
    await git.raw(['branch', 'other', base]);
    await git.checkout('other');
    const other = await readWorktreeTargetIdentity(repoPath);
    expect(other.commit).toBe(main.commit);
    expect(sameWorktreeTarget(main, other)).toBe(false);

    await git.raw(['checkout', '--detach', base]);
    expect(await readWorktreeTargetIdentity(repoPath)).toEqual({ path: repoPath, ref: null, commit: base });
  });

  it('keeps ancestry errors distinct from negative comparisons', async () => {
    const { repoPath, base } = await createRepo();
    const comparison = await compareWorktreeTarget(repoPath, base, 'f'.repeat(40));
    expect(comparison.status).toBe('error');
  });

  it('returns a null target with an explicit error when destination facts are unreadable', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-target-unreadable-'));
    tempDirs.push(directory);
    expect(await inspectWorktreeTarget(directory, 'a'.repeat(40))).toMatchObject({
      target: null,
      comparison: { status: 'error', error: expect.stringMatching(/Reading target commit failed/) },
    });
  });
});

describe('validateTargetExpectations', () => {
  const identity = { path: '/tmp/repo', ref: 'refs/heads/main', commit: 'a'.repeat(40) };

  it('requires exactly one expectation form and exact composite keys', () => {
    expect(() => validateTargetExpectations(null, undefined, undefined)).toThrow(/required/);
    expect(() => validateTargetExpectations(null, identity, { root: identity })).toThrow(/both/);
    expect(() => validateTargetExpectations(['api', 'web'], identity, undefined)).toThrow(/multi-repository/);
    expect(() => validateTargetExpectations(['api', 'web'], undefined, { api: identity })).toThrow(/exactly match/);
    expect(() => validateTargetExpectations(['api'], undefined, { api: { ...identity, ref: 'main' } })).toThrow(/malformed/);
  });

  it('rejects inherited and extra identity fields', () => {
    const inherited = Object.create(identity) as Record<string, unknown>;
    expect(() => validateTargetExpectations(null, inherited, undefined)).toThrow(/malformed/);
    expect(() => validateTargetExpectations(null, { ...identity, extra: true }, undefined)).toThrow(/malformed/);
  });

  it('normalizes a singleton scalar without changing its identity values', () => {
    expect(validateTargetExpectations(['api'], identity, undefined)).toEqual({ expectedTargets: { api: identity } });
  });
});
