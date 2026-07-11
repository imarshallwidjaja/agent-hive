import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { ReviewWorkspaceService } from './reviewWorkspaceService.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function createRepository(name: string): Promise<{ path: string; git: SimpleGit }> {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), `hive-review-workspace-${name}-`));
  tempDirs.push(repository);
  const git = simpleGit(repository);
  await git.init(['-b', 'main']);
  await git.addConfig('user.email', 'review@example.test');
  await git.addConfig('user.name', 'Review Test');
  await fs.writeFile(path.join(repository, 'tracked.txt'), `${name}\n`);
  await git.add('tracked.txt');
  await git.commit('initial');
  return { path: repository, git };
}

function createReviewWorkspaceService(projectRoot: string, overrides: Record<string, unknown> = {}): ReviewWorkspaceService {
  return new ReviewWorkspaceService({
    projectRoot,
    ...overrides,
  } as any);
}

describe('ReviewWorkspaceService', () => {
  it('creates a detached disposable workspace and reports its tracked and generated footprint', async () => {
    const source = await createRepository('single');
    const service = createReviewWorkspaceService(source.path);

    const workspace = await service.create({
      runId: 'review-single',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });

    expect(workspace.workspacePath).toBe(path.join(source.path, '.hive', '.worktrees', 'review', 'review-single'));
    expect(await simpleGit(workspace.workspacePath).raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).toBe('');
    expect((await source.git.branch()).all).not.toContain('hive/review/review-single');

    await fs.writeFile(path.join(workspace.workspacePath, 'tracked.txt'), 'changed\n');
    await fs.writeFile(path.join(workspace.workspacePath, 'generated.log'), 'generated\n');
    const inspection = await service.inspect('review-single', workspace.ownershipToken);

    expect(inspection.integrity.trackedClean).toBe(false);
    expect(inspection.repositories.root.trackedChanges).toContain('tracked.txt');
    expect(inspection.repositories.root.untrackedChanges).toContain('generated.log');
    expect(await fs.readFile(path.join(source.path, 'tracked.txt'), 'utf8')).toBe('single\n');

    expect(await service.cleanup('review-single', workspace.ownershipToken)).toMatchObject({ cleaned: true });
    await expect(fs.access(workspace.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates a composite review workspace with a typed manifest', async () => {
    const api = await createRepository('api');
    const web = await createRepository('web');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-review-workspace-composite-'));
    tempDirs.push(root);
    const service = createReviewWorkspaceService(root);

    const workspace = await service.create({
      runId: 'review-composite',
      composite: true,
      repositories: [
        { id: 'api', sourcePath: api.path, commit: 'HEAD' },
        { id: 'web', sourcePath: web.path, commit: 'HEAD' },
      ],
    });

    expect(workspace.repositories.api.path).toBe(path.join(workspace.workspacePath, 'repos', 'api'));
    const manifest = JSON.parse(await fs.readFile(path.join(workspace.workspacePath, 'workspace.json'), 'utf8'));
    expect(manifest.mode).toBe('review-composite');
    expect(manifest.runId).toBe('review-composite');

    await service.cleanup(workspace.runId, workspace.ownershipToken);
  });

  it('uses the sealed materialized tree as the inspection baseline', async () => {
    const source = await createRepository('sealed');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await service.create({
      runId: 'review-sealed',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });

    await fs.writeFile(path.join(workspace.workspacePath, 'tracked.txt'), 'materialized baseline\n');
    await service.seal('review-sealed', workspace.ownershipToken);
    expect((await service.inspect('review-sealed', workspace.ownershipToken)).integrity.trackedClean).toBe(true);

    await fs.writeFile(path.join(workspace.workspacePath, 'tracked.txt'), 'reviewer drift\n');
    expect((await service.inspect('review-sealed', workspace.ownershipToken)).integrity.trackedClean).toBe(false);
  });

  it('rolls back registered worktree when add removes checkout then throws', async () => {
    const source = await createRepository('add-checkout-removed');
    const runId = 'review-add-checkout-removed';
    const targetPath = path.join(source.path, '.hive', '.worktrees', 'review', runId);
    const service = createReviewWorkspaceService(source.path, {
      addWorktree: async (sourcePath, checkoutPath, commit) => {
        await simpleGit(sourcePath).raw(['worktree', 'add', '--detach', checkoutPath, commit]);
        await fs.rm(checkoutPath, { recursive: true, force: true });
        throw new Error('injected post-add failure');
      },
    });

    await expect(service.create({
      runId,
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    })).rejects.toThrow('injected post-add failure');

    expect((await source.git.raw(['worktree', 'list', '--porcelain']))).not.toContain(`worktree ${targetPath}`);
    await expect(fs.access(path.join(source.path, '.hive', '.worktrees', 'review', '.runs', `${runId}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes already-created detached worktrees when a later repository cannot be created', async () => {
    const source = await createRepository('rollback');
    const sourceHead = (await source.git.revparse(['HEAD'])).trim();
    const missing = path.join(source.path, 'missing-repository');
    const service = createReviewWorkspaceService(source.path);

    await expect(service.create({
      runId: 'review-rollback',
      composite: true,
      repositories: [
        { id: 'good', sourcePath: source.path, commit: sourceHead },
        { id: 'missing', sourcePath: missing, commit: sourceHead },
      ],
    })).rejects.toThrow();

    await expect(fs.access(path.join(source.path, '.hive', '.worktrees', 'review', 'review-rollback'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await source.git.raw(['worktree', 'list', '--porcelain']))).not.toContain('review-rollback');
  });

  it('rejects an invalid ownership token without removing a workspace', async () => {
    const source = await createRepository('token');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await service.create({
      runId: 'review-token',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });

    await expect(service.inspect('review-token', 'wrong-token')).rejects.toThrow('ownership token');
    await expect(service.cleanup('review-token', 'wrong-token')).rejects.toThrow('ownership token');
    expect((await fs.stat(workspace.workspacePath)).isDirectory()).toBe(true);
  });

  it('keeps the winning same-run create intact when a concurrent create loses', async () => {
    const source = await createRepository('concurrent-create');
    const service = createReviewWorkspaceService(source.path);
    const options = {
      runId: 'review-concurrent-create',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    };

    const attempts = await Promise.allSettled([
      service.create(options),
      service.create(options),
    ]);
    const created = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof service.create>>> => attempt.status === 'fulfilled');

    expect(created).toHaveLength(1);
    expect((await fs.stat(created[0]!.value.workspacePath)).isDirectory()).toBe(true);
    await expect(service.cleanup(created[0]!.value.runId, created[0]!.value.ownershipToken)).resolves.toMatchObject({ cleaned: true });
  });

  it('rejects malformed run and repository IDs before creating a workspace', async () => {
    const source = await createRepository('malformed-id');
    const service = createReviewWorkspaceService(source.path);

    await expect(service.create({
      runId: '../review-escape',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    })).rejects.toThrow('Invalid review runId');
    await expect(service.create({
      runId: 'review..escape',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    })).rejects.toThrow('Invalid review runId');
    await expect(service.create({
      runId: 'review-malformed-repository',
      repositories: [{ id: '../root', sourcePath: source.path, commit: 'HEAD' }],
    })).rejects.toThrow('Invalid review repository id');
    await expect(fs.access(path.join(source.path, '.hive', '.worktrees', 'review', 'review-malformed-repository'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a review workspace is replaced with a symlink', async () => {
    const source = await createRepository('workspace-symlink');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await service.create({
      runId: 'review-workspace-symlink',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-review-symlink-outside-'));
    tempDirs.push(outside);
    await fs.writeFile(path.join(outside, 'sentinel'), 'must survive\n');
    await source.git.raw(['worktree', 'remove', '--force', workspace.workspacePath]);
    await fs.symlink(outside, workspace.workspacePath);

    await expect(service.cleanup(workspace.runId, workspace.ownershipToken)).rejects.toThrow('not a real directory');
    expect(await fs.readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('must survive\n');
  });

  it('fails closed when metadata has no repository IDs', async () => {
    const source = await createRepository('empty-metadata-repos');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await service.create({
      runId: 'review-empty-metadata-repos',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const metadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-empty-metadata-repos.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    metadata.repositoryIds = [];
    metadata.commits = {};
    metadata.baseline = {};
    await fs.writeFile(metadataPath, JSON.stringify(metadata), 'utf8');

    await expect(service.cleanup(workspace.runId, workspace.ownershipToken)).rejects.toThrow('Invalid review workspace metadata');
    expect((await fs.stat(workspace.workspacePath)).isDirectory()).toBe(true);
  });

  it('fails closed on corrupt metadata without deleting an external path', async () => {
    const source = await createRepository('corrupt');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await service.create({
      runId: 'review-corrupt',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-review-outside-'));
    tempDirs.push(outside);
    await fs.writeFile(path.join(outside, 'sentinel'), 'must survive\n');
    const metadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-corrupt.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    metadata.workspacePath = outside;
    await fs.writeFile(metadataPath, JSON.stringify(metadata), 'utf8');

    await expect(service.cleanup('review-corrupt', workspace.ownershipToken)).rejects.toThrow('Invalid review workspace metadata');
    expect(await fs.readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('must survive\n');
  });

  it('detects a mutation or deletion of a sealed baseline untracked entry', async () => {
    const source = await createRepository('baseline-untracked');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await service.create({
      runId: 'review-baseline-untracked',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    await fs.writeFile(path.join(workspace.workspacePath, 'baseline.bin'), 'first\n');
    await fs.symlink('baseline.bin', path.join(workspace.workspacePath, 'baseline-link'));
    await service.seal('review-baseline-untracked', workspace.ownershipToken);
    const metadata = JSON.parse(await fs.readFile(path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-baseline-untracked.json'), 'utf8'));
    expect(metadata.baseline.root.untrackedFingerprint).toMatch(/^[a-f0-9]{64}$/);

    await fs.writeFile(path.join(workspace.workspacePath, 'baseline.bin'), 'second\n');
    await fs.unlink(path.join(workspace.workspacePath, 'baseline-link'));

    expect((await service.inspect('review-baseline-untracked', workspace.ownershipToken)).integrity.baselineClean).toBe(false);
  });

  it('rejects a symlinked project .hive component without touching its target', async () => {
    const source = await createRepository('symlinked-hive');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-review-root-outside-'));
    tempDirs.push(outside);
    await fs.writeFile(path.join(outside, 'sentinel'), 'must survive\n');
    await fs.symlink(outside, path.join(source.path, '.hive'));
    const service = createReviewWorkspaceService(source.path);

    await expect(service.create({
      runId: 'review-symlinked-hive',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    })).rejects.toThrow(/Review workspace/);
    expect(await fs.readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('must survive\n');
  });

  it('rejects an expired sweep through a symlinked project .hive component', async () => {
    const source = await createRepository('symlinked-hive-sweep');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-review-sweep-outside-'));
    tempDirs.push(outside);
    await fs.writeFile(path.join(outside, 'sentinel'), 'must survive\n');
    await fs.symlink(outside, path.join(source.path, '.hive'));
    const service = createReviewWorkspaceService(source.path);

    await expect(service.cleanupExpired()).rejects.toThrow(/Review workspace/);
    expect(await fs.readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('must survive\n');
  });

  it('preserves a sealed workspace during incomplete-workspace recovery', async () => {
    const source = await createRepository('sealed-recovery');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await service.create({
      runId: 'review-sealed-recovery',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });

    await service.cleanupExpired();

    expect((await fs.stat(workspace.workspacePath)).isDirectory()).toBe(true);
    await service.cleanup(workspace.runId, workspace.ownershipToken);
  });

  it('sweeps a sealed workspace when its claimed owner PID is dead', async () => {
    const source = await createRepository('sealed-owner-dead');
    const service = createReviewWorkspaceService(source.path, {
      isProcessAlive: (pid: number) => pid === process.pid,
    });
    const workspace = await service.create({
      runId: 'review-sealed-owner-dead',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    await service.claim(workspace.runId, workspace.ownershipToken, 'dead-owner-session', 4242);

    await service.cleanupExpired();

    await expect(fs.access(workspace.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a sealed workspace while its claimed owner PID is alive', async () => {
    const source = await createRepository('sealed-owner-live');
    const service = createReviewWorkspaceService(source.path, {
      isProcessAlive: (pid: number) => pid === 4242,
    });
    const workspace = await service.create({
      runId: 'review-sealed-owner-live',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    await service.claim(workspace.runId, workspace.ownershipToken, 'live-owner-session', 4242);
    const metadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-sealed-owner-live.json');

    await service.cleanupExpired();

    expect(JSON.parse(await fs.readFile(metadataPath, 'utf8')).ownerPid).toBe(4242);
    expect((await fs.stat(workspace.workspacePath)).isDirectory()).toBe(true);
    await service.cleanup(workspace.runId, workspace.ownershipToken);
  });

  it('sweeps an unclaimed sealed workspace after its creator handoff expires', async () => {
    const source = await createRepository('sealed-handoff-expiry');
    let now = 1_000;
    const service = createReviewWorkspaceService(source.path, {
      now: () => now,
      reviewWorkspaceHandoffMs: 100,
      isProcessAlive: (pid: number) => pid === process.pid,
    });
    const workspace = await service.create({
      runId: 'review-sealed-handoff-expiry',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });

    now += 101;
    await service.cleanupExpired();

    await expect(fs.access(workspace.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sweeps an unclaimed sealed workspace when its creator PID is dead', async () => {
    const source = await createRepository('sealed-creator-dead');
    const service = createReviewWorkspaceService(source.path, { isProcessAlive: () => false });
    const workspace = await service.create({
      runId: 'review-sealed-creator-dead',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });

    await service.cleanupExpired();

    await expect(fs.access(workspace.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a long-running lock while its owner PID is alive', async () => {
    const source = await createRepository('lock-owner');
    let now = 1_000;
    const service = createReviewWorkspaceService(source.path, {
      now: () => now,
      isProcessAlive: () => true,
    });
    const internal = service as any;
    const reviewRoot = await internal.ensureReviewRoot();
    const firstLock = await internal.acquireRunLock(reviewRoot, 'review-lock-owner');

    now += 24 * 60 * 60 * 1000;
    await expect(internal.acquireRunLock(reviewRoot, 'review-lock-owner')).rejects.toThrow('busy');
    await internal.releaseRunLock(firstLock);
  });

  it('recovers a dead-owner lock without letting its old token release the replacement', async () => {
    const source = await createRepository('dead-lock-owner');
    const service = createReviewWorkspaceService(source.path, {
      isProcessAlive: (pid: number) => pid === process.pid,
    });
    const internal = service as any;
    const reviewRoot = await internal.ensureReviewRoot();
    const lockPath = await internal.getLockPath(reviewRoot, 'review-dead-lock-owner', true);
    await fs.writeFile(lockPath, JSON.stringify({ ownerToken: 'dead-owner-token', ownerPid: 4242 }), 'utf8');

    const replacement = await internal.acquireRunLock(reviewRoot, 'review-dead-lock-owner');
    await internal.releaseRunLock({ path: lockPath, ownerToken: 'dead-owner-token', ownerPid: 4242 });

    await expect(internal.acquireRunLock(reviewRoot, 'review-dead-lock-owner')).rejects.toThrow('busy');
    await internal.releaseRunLock(replacement);
  });

  it('keeps workspace checkout and metadata when worktree deregistration fails', async () => {
    const source = await createRepository('cleanup-failure');
    const service = createReviewWorkspaceService(source.path, {
      removeWorktree: async (_workspacePath: string) => {
        throw new Error('injected deregistration failure');
      },
    });
    const workspace = await service.create({
      runId: 'review-cleanup-failure',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const metadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-cleanup-failure.json');

    const result = await service.cleanup(workspace.runId, workspace.ownershipToken);

    expect(result.cleaned).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining(workspace.workspacePath)]);
    expect((await fs.stat(workspace.workspacePath)).isDirectory()).toBe(true);
    await fs.access(metadataPath);
  });

  it('records successful composite deregistration so cleanup can retry a later failed repository', async () => {
    const api = await createRepository('cleanup-retry-api');
    const web = await createRepository('cleanup-retry-web');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-review-workspace-cleanup-retry-'));
    tempDirs.push(root);
    let failWeb = true;
    const service = createReviewWorkspaceService(root, {
      removeWorktree: async (workspacePath: string) => {
        if (workspacePath.endsWith(`${path.sep}web`) && failWeb) {
          throw new Error('injected web deregistration failure');
        }
        const git = simpleGit(workspacePath);
        const commonDir = (await git.raw(['rev-parse', '--git-common-dir'])).trim();
        await simpleGit(path.dirname(path.resolve(workspacePath, commonDir))).raw(['worktree', 'remove', '--force', workspacePath]);
      },
    });
    const workspace = await service.create({
      runId: 'review-cleanup-retry',
      composite: true,
      repositories: [
        { id: 'api', sourcePath: api.path, commit: 'HEAD' },
        { id: 'web', sourcePath: web.path, commit: 'HEAD' },
      ],
    });

    const first = await service.cleanup(workspace.runId, workspace.ownershipToken);
    expect(first.cleaned).toBe(false);
    await expect(fs.access(path.join(workspace.workspacePath, 'repos', 'api'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(workspace.workspacePath, 'repos', 'web'))).isDirectory()).toBe(true);

    failWeb = false;
    await expect(service.cleanup(workspace.runId, workspace.ownershipToken)).resolves.toMatchObject({ cleaned: true });
  });

  it('keeps only rollback survivors in recovery metadata and removes them on a later retry', async () => {
    const api = await createRepository('rollback-failure-api');
    const web = await createRepository('rollback-failure-web');
    const worker = await createRepository('rollback-failure-worker');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-review-workspace-rollback-failure-'));
    tempDirs.push(root);
    let addCount = 0;
    let failWebRemoval = true;
    const service = createReviewWorkspaceService(root, {
      addWorktree: async (sourcePath: string, targetPath: string, commit: string) => {
        addCount += 1;
        if (addCount === 3) throw new Error('injected later repository failure');
        await simpleGit(sourcePath).raw(['worktree', 'add', '--detach', targetPath, commit]);
      },
      removeWorktree: async (workspacePath: string) => {
        if (workspacePath.endsWith(`${path.sep}web`) && failWebRemoval) {
          throw new Error('injected rollback deregistration failure');
        }
        const git = simpleGit(workspacePath);
        const commonDir = (await git.raw(['rev-parse', '--git-common-dir'])).trim();
        await simpleGit(path.dirname(path.resolve(workspacePath, commonDir))).raw(['worktree', 'remove', '--force', workspacePath]);
      },
    });
    const workspacePath = path.join(root, '.hive', '.worktrees', 'review', 'review-rollback-failure');
    const metadataPath = path.join(root, '.hive', '.worktrees', 'review', '.runs', 'review-rollback-failure.json');

    await expect(service.create({
      runId: 'review-rollback-failure',
      composite: true,
      repositories: [
        { id: 'api', sourcePath: api.path, commit: 'HEAD' },
        { id: 'web', sourcePath: web.path, commit: 'HEAD' },
        { id: 'worker', sourcePath: worker.path, commit: 'HEAD' },
      ],
    })).rejects.toThrow('injected later repository failure');

    await expect(fs.access(path.join(workspacePath, 'repos', 'api'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(workspacePath, 'repos', 'web'))).isDirectory()).toBe(true);
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    expect(metadata).toMatchObject({
      state: 'recovery',
      repositoryIds: ['web'],
      commits: { web: expect.any(String) },
      worktreeRepositoryIds: ['web'],
    });

    failWebRemoval = false;
    await service.cleanupExpired();
    await expect(fs.access(workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(metadataPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists creating metadata before the first worktree add', async () => {
    const source = await createRepository('creating-metadata');
    let observedMetadata: unknown;
    const service = createReviewWorkspaceService(source.path, {
      addWorktree: async () => {
        const metadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-creating-metadata.json');
        observedMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        throw new Error('injected first add failure');
      },
    });

    await expect(service.create({
      runId: 'review-creating-metadata',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    })).rejects.toThrow('injected first add failure');

    expect(observedMetadata).toMatchObject({ state: 'creating', worktreeRepositoryIds: [] });
  });

  it('reconciles a creating worktree registration after its checkout disappears', async () => {
    const source = await createRepository('missing-checkout-registration');
    const service = createReviewWorkspaceService(source.path, { isProcessAlive: () => false });
    const workspace = await service.create({
      runId: 'review-missing-checkout-registration',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const metadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-missing-checkout-registration.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    metadata.state = 'creating';
    metadata.worktreeRepositoryIds = ['root'];
    delete metadata.baseline;
    delete metadata.handoffExpiresAt;
    await fs.writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
    await fs.rm(workspace.workspacePath, { recursive: true, force: true });
    expect(await source.git.raw(['worktree', 'list', '--porcelain'])).toContain(`worktree ${workspace.workspacePath}`);

    await service.cleanupExpired();

    expect(await source.git.raw(['worktree', 'list', '--porcelain'])).not.toContain(`worktree ${workspace.workspacePath}`);
    await expect(fs.access(metadataPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves tampered cleanup identity and its registered worktree', async () => {
    const source = await createRepository('tampered-cleanup-identity');
    const errors: string[] = [];
    const service = createReviewWorkspaceService(source.path, {
      isProcessAlive: () => false,
      onSweepError: (_runId: string, error: Error) => errors.push(error.message),
    });
    const workspace = await service.create({
      runId: 'review-tampered-cleanup-identity',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const metadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-tampered-cleanup-identity.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    metadata.state = 'creating';
    metadata.worktreeRepositoryIds = ['root'];
    metadata.cleanupIdentities = {
      root: {
        sourcePath: path.join(source.path, 'tampered-source'),
        commonDir: await fs.realpath(path.resolve(source.path, (await source.git.raw(['rev-parse', '--git-common-dir'])).trim())),
        worktreePath: workspace.workspacePath,
      },
    };
    delete metadata.baseline;
    delete metadata.handoffExpiresAt;
    await fs.writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
    await fs.rm(workspace.workspacePath, { recursive: true, force: true });

    await expect(service.cleanupExpired()).resolves.toBeUndefined();

    expect(errors).toEqual([expect.stringContaining('Invalid review workspace metadata')]);
    expect(await source.git.raw(['worktree', 'list', '--porcelain'])).toContain(`worktree ${workspace.workspacePath}`);
    await fs.access(metadataPath);
  });

  it('reports metadata-less state without blocking independent recovery or a later create', async () => {
    const source = await createRepository('missing-metadata');
    const errors: string[] = [];
    const service = createReviewWorkspaceService(source.path, {
      isProcessAlive: () => false,
      onSweepError: (runId: string, error: Error) => errors.push(`${runId}: ${error.message}`),
    });
    const internal = service as any;
    const reviewRoot = await internal.ensureReviewRoot();
    const workspacePath = path.join(reviewRoot, 'review-missing-metadata');
    await fs.mkdir(workspacePath);
    const lockPath = await internal.getLockPath(reviewRoot, 'review-missing-metadata', true);
    await fs.writeFile(lockPath, JSON.stringify({ ownerToken: 'dead-owner', ownerPid: 4242 }), 'utf8');
    const recoverable = await service.create({
      runId: 'review-independent-recovery',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const recoverableMetadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-independent-recovery.json');
    const recoverableMetadata = JSON.parse(await fs.readFile(recoverableMetadataPath, 'utf8'));
    recoverableMetadata.state = 'creating';
    recoverableMetadata.worktreeRepositoryIds = ['root'];
    delete recoverableMetadata.baseline;
    delete recoverableMetadata.handoffExpiresAt;
    await fs.writeFile(recoverableMetadataPath, JSON.stringify(recoverableMetadata), 'utf8');

    await expect(service.cleanupExpired()).resolves.toBeUndefined();
    expect(errors).toEqual([expect.stringContaining('review-missing-metadata:')]);
    expect((await fs.stat(workspacePath)).isDirectory()).toBe(true);
    await expect(fs.access(recoverable.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const later = await service.create({
      runId: 'review-after-missing-metadata',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    await service.cleanup(later.runId, later.ownershipToken);
  });

  it('returns already-clean success when a repeated cleanup has no metadata or workspace', async () => {
    const source = await createRepository('repeat-cleanup');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await service.create({
      runId: 'review-repeat-cleanup',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });

    await expect(service.cleanup(workspace.runId, workspace.ownershipToken)).resolves.toMatchObject({ cleaned: true });
    await expect(service.cleanup(workspace.runId, workspace.ownershipToken)).resolves.toMatchObject({ cleaned: true });
  });

  it('fails closed and preserves a workspace when cleanup finds no metadata', async () => {
    const source = await createRepository('missing-metadata-cleanup');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await service.create({
      runId: 'review-missing-metadata-cleanup',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const metadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-missing-metadata-cleanup.json');
    await fs.rm(metadataPath);

    await expect(service.cleanup(workspace.runId, workspace.ownershipToken)).rejects.toThrow('without valid metadata');
    expect((await fs.stat(workspace.workspacePath)).isDirectory()).toBe(true);
  });
});
