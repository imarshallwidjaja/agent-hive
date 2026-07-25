import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';
import {
  fingerprintReviewWorkspaceSourceScope,
  ReviewWorkspaceService,
  type ReviewWorkspaceCaller,
  type ReviewWorkspaceCreateOptions,
  type ReviewWorkspaceLeaseInput,
} from './reviewWorkspaceService.js';

const tempDirs: string[] = [];
const creatorCaller: ReviewWorkspaceCaller = {
  workflow: 'dash-review',
  role: 'creator',
  agent: '__hive_dash_review_scope',
  sessionId: 'dash-review-scope-session',
  pid: process.pid,
};

function primaryCaller(sessionId = 'dash-review-primary-session', pid = process.pid): ReviewWorkspaceCaller {
  return {
    workflow: 'dash-review',
    role: 'primary',
    agent: '__hive_dash_review_primary',
    sessionId,
    pid,
  };
}

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

function createLease(repositoryIds: readonly string[]): ReviewWorkspaceLeaseInput {
  const selectedRepositoryIds = [...repositoryIds].sort();
  const sourceScope = { repositoryIds: [], snapshot: { paths: [] } };
  return {
    workflow: creatorCaller.workflow,
    creatorAgent: creatorCaller.agent,
    creatorSessionId: creatorCaller.sessionId,
    sourceScope,
    selectedRepositoryIds,
    scopeFingerprint: fingerprintReviewWorkspaceSourceScope(sourceScope),
    sourceFingerprint: '0'.repeat(64),
    materializedFingerprint: '1'.repeat(64),
    materializedEntries: Object.fromEntries(selectedRepositoryIds.map((repositoryId) => [repositoryId, []])),
  };
}

function createWorkspace(
  service: ReviewWorkspaceService,
  options: Omit<ReviewWorkspaceCreateOptions, 'lease'>,
  leaseCreator: ReviewWorkspaceCaller = creatorCaller,
) {
  return service.create({
    ...options,
    lease: {
      ...createLease(options.repositories.map((repository) => repository.id)),
      workflow: leaseCreator.workflow,
      creatorAgent: leaseCreator.agent,
      creatorSessionId: leaseCreator.sessionId,
    },
  });
}

function reviewMetadataPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.hive', '.worktrees', 'review', '.runs', `${runId}.json`);
}

describe('ReviewWorkspaceService', () => {
  it('creates a detached disposable workspace and reports its tracked and generated footprint', async () => {
    const source = await createRepository('single');
    const service = createReviewWorkspaceService(source.path);

    const workspace = await createWorkspace(service, {
      runId: 'review-single',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });

    expect(workspace.workspacePath).toBe(path.join(source.path, '.hive', '.worktrees', 'review', 'review-single'));
    expect(await simpleGit(workspace.workspacePath).raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).toBe('');
    expect((await source.git.branch()).all).not.toContain('hive/review/review-single');

    await fs.writeFile(path.join(workspace.workspacePath, 'tracked.txt'), 'changed\n');
    await fs.writeFile(path.join(workspace.workspacePath, 'generated.log'), 'generated\n');
    await service.claim(workspace.runId, workspace.ownershipToken, primaryCaller());
    const inspection = await service.inspect('review-single', workspace.ownershipToken, primaryCaller());

    expect(inspection.integrity.trackedClean).toBe(false);
    expect(inspection.repositories.root.trackedChanges).toContain('tracked.txt');
    expect(inspection.repositories.root.untrackedChanges).toContain('generated.log');
    expect(await fs.readFile(path.join(source.path, 'tracked.txt'), 'utf8')).toBe('single\n');

    expect(await service.cleanup('review-single', workspace.ownershipToken, primaryCaller())).toMatchObject({ cleaned: true });
    await expect(fs.access(workspace.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates a composite review workspace with a typed manifest', async () => {
    const api = await createRepository('api');
    const web = await createRepository('web');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-review-workspace-composite-'));
    tempDirs.push(root);
    const service = createReviewWorkspaceService(root);

    const workspace = await createWorkspace(service, {
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

    await service.cleanup(workspace.runId, workspace.ownershipToken, creatorCaller);
  });

  it('uses the sealed materialized tree as the inspection baseline', async () => {
    const source = await createRepository('sealed');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await createWorkspace(service, {
      runId: 'review-sealed',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });

    await fs.writeFile(path.join(workspace.workspacePath, 'tracked.txt'), 'materialized baseline\n');
    await service.seal('review-sealed', workspace.ownershipToken, creatorCaller);
    await service.claim(workspace.runId, workspace.ownershipToken, primaryCaller());
    expect((await service.inspect('review-sealed', workspace.ownershipToken, primaryCaller())).integrity.trackedClean).toBe(true);

    await fs.writeFile(path.join(workspace.workspacePath, 'tracked.txt'), 'reviewer drift\n');
    expect((await service.inspect('review-sealed', workspace.ownershipToken, primaryCaller())).integrity.trackedClean).toBe(false);
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

    await expect(createWorkspace(service, {
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

    await expect(createWorkspace(service, {
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
    const workspace = await createWorkspace(service, {
      runId: 'review-token',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });

    await expect(service.inspect('review-token', 'wrong-token', primaryCaller())).rejects.toThrow('ownership token');
    await expect(service.cleanup('review-token', 'wrong-token', creatorCaller)).rejects.toThrow('ownership token');
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
      createWorkspace(service, options),
      createWorkspace(service, options),
    ]);
    const created = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof service.create>>> => attempt.status === 'fulfilled');

    expect(created).toHaveLength(1);
    expect((await fs.stat(created[0]!.value.workspacePath)).isDirectory()).toBe(true);
    await expect(service.cleanup(created[0]!.value.runId, created[0]!.value.ownershipToken, creatorCaller)).resolves.toMatchObject({ cleaned: true });
  });

  it('rejects malformed run and repository IDs before creating a workspace', async () => {
    const source = await createRepository('malformed-id');
    const service = createReviewWorkspaceService(source.path);

    await expect(createWorkspace(service, {
      runId: '../review-escape',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    })).rejects.toThrow('Invalid review runId');
    await expect(createWorkspace(service, {
      runId: 'review..escape',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    })).rejects.toThrow('Invalid review runId');
    await expect(createWorkspace(service, {
      runId: 'review-malformed-repository',
      repositories: [{ id: '../root', sourcePath: source.path, commit: 'HEAD' }],
    })).rejects.toThrow('Invalid review repository id');
    await expect(fs.access(path.join(source.path, '.hive', '.worktrees', 'review', 'review-malformed-repository'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a review workspace is replaced with a symlink', async () => {
    const source = await createRepository('workspace-symlink');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await createWorkspace(service, {
      runId: 'review-workspace-symlink',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-review-symlink-outside-'));
    tempDirs.push(outside);
    await fs.writeFile(path.join(outside, 'sentinel'), 'must survive\n');
    await source.git.raw(['worktree', 'remove', '--force', workspace.workspacePath]);
    await fs.symlink(outside, workspace.workspacePath);

    await expect(service.cleanup(workspace.runId, workspace.ownershipToken, creatorCaller)).rejects.toThrow('not a real directory');
    expect(await fs.readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('must survive\n');
  });

  it('fails closed when metadata has no repository IDs', async () => {
    const source = await createRepository('empty-metadata-repos');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await createWorkspace(service, {
      runId: 'review-empty-metadata-repos',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const metadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-empty-metadata-repos.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    metadata.repositoryIds = [];
    metadata.commits = {};
    metadata.baseline = {};
    await fs.writeFile(metadataPath, JSON.stringify(metadata), 'utf8');

    await expect(service.cleanup(workspace.runId, workspace.ownershipToken, creatorCaller)).rejects.toThrow('Invalid review workspace metadata');
    expect((await fs.stat(workspace.workspacePath)).isDirectory()).toBe(true);
  });

  it('fails closed on corrupt metadata without deleting an external path', async () => {
    const source = await createRepository('corrupt');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await createWorkspace(service, {
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

    await expect(service.cleanup('review-corrupt', workspace.ownershipToken, creatorCaller)).rejects.toThrow('Invalid review workspace metadata');
    expect(await fs.readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('must survive\n');
  });

  it('detects a mutation or deletion of a sealed baseline untracked entry', async () => {
    const source = await createRepository('baseline-untracked');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await createWorkspace(service, {
      runId: 'review-baseline-untracked',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    await fs.writeFile(path.join(workspace.workspacePath, 'baseline.bin'), 'first\n');
    await fs.symlink('baseline.bin', path.join(workspace.workspacePath, 'baseline-link'));
    await service.seal('review-baseline-untracked', workspace.ownershipToken, creatorCaller);
    await service.claim(workspace.runId, workspace.ownershipToken, primaryCaller());
    const metadata = JSON.parse(await fs.readFile(path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-baseline-untracked.json'), 'utf8'));
    expect(metadata.baseline.root.untrackedFingerprint).toMatch(/^[a-f0-9]{64}$/);

    await fs.writeFile(path.join(workspace.workspacePath, 'baseline.bin'), 'second\n');
    await fs.unlink(path.join(workspace.workspacePath, 'baseline-link'));

    expect((await service.inspect('review-baseline-untracked', workspace.ownershipToken, primaryCaller())).integrity.baselineClean).toBe(false);
  });

  it('rejects a symlinked project .hive component without touching its target', async () => {
    const source = await createRepository('symlinked-hive');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-review-root-outside-'));
    tempDirs.push(outside);
    await fs.writeFile(path.join(outside, 'sentinel'), 'must survive\n');
    await fs.symlink(outside, path.join(source.path, '.hive'));
    const service = createReviewWorkspaceService(source.path);

    await expect(createWorkspace(service, {
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
    const workspace = await createWorkspace(service, {
      runId: 'review-sealed-recovery',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });

    await service.cleanupExpired();

    expect((await fs.stat(workspace.workspacePath)).isDirectory()).toBe(true);
    await service.cleanup(workspace.runId, workspace.ownershipToken, creatorCaller);
  });

  it('starts recovery grace before sweeping a sealed workspace whose claimed owner PID is dead', async () => {
    const source = await createRepository('sealed-owner-dead');
    let now = 1_000;
    const service = createReviewWorkspaceService(source.path, {
      now: () => now,
      reviewWorkspaceHandoffMs: 100,
      isProcessAlive: (pid: number) => pid === process.pid,
    });
    const workspace = await createWorkspace(service, {
      runId: 'review-sealed-owner-dead',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    await service.claim(workspace.runId, workspace.ownershipToken, primaryCaller('dead-owner-session', 4242));
    const metadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-sealed-owner-dead.json');

    await service.cleanupExpired();

    expect(JSON.parse(await fs.readFile(metadataPath, 'utf8')).ownerRecoveryExpiresAt).toBe(1_100);
    expect((await fs.stat(workspace.workspacePath)).isDirectory()).toBe(true);
    now += 50;
    await service.cleanupExpired();
    expect(JSON.parse(await fs.readFile(metadataPath, 'utf8')).ownerRecoveryExpiresAt).toBe(1_100);
    expect((await fs.stat(workspace.workspacePath)).isDirectory()).toBe(true);
    now += 51;
    await service.cleanupExpired();
    await expect(fs.access(workspace.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a sealed workspace while its claimed owner PID is alive', async () => {
    const source = await createRepository('sealed-owner-live');
    const service = createReviewWorkspaceService(source.path, {
      isProcessAlive: (pid: number) => pid === 4242,
    });
    const workspace = await createWorkspace(service, {
      runId: 'review-sealed-owner-live',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const owner = primaryCaller('live-owner-session', 4242);
    await service.claim(workspace.runId, workspace.ownershipToken, owner);
    const metadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-sealed-owner-live.json');

    await service.cleanupExpired();

    expect(JSON.parse(await fs.readFile(metadataPath, 'utf8')).ownerPid).toBe(4242);
    expect((await fs.stat(workspace.workspacePath)).isDirectory()).toBe(true);
    await service.cleanup(workspace.runId, workspace.ownershipToken, owner);
  });

  it('sweeps an unclaimed sealed workspace after its creator handoff expires', async () => {
    const source = await createRepository('sealed-handoff-expiry');
    let now = 1_000;
    const service = createReviewWorkspaceService(source.path, {
      now: () => now,
      reviewWorkspaceHandoffMs: 100,
      isProcessAlive: (pid: number) => pid === process.pid,
    });
    const workspace = await createWorkspace(service, {
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
    const workspace = await createWorkspace(service, {
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
    const workspace = await createWorkspace(service, {
      runId: 'review-cleanup-failure',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const metadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-cleanup-failure.json');

    const result = await service.cleanup(workspace.runId, workspace.ownershipToken, creatorCaller);

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
    const workspace = await createWorkspace(service, {
      runId: 'review-cleanup-retry',
      composite: true,
      repositories: [
        { id: 'api', sourcePath: api.path, commit: 'HEAD' },
        { id: 'web', sourcePath: web.path, commit: 'HEAD' },
      ],
    });

    const first = await service.cleanup(workspace.runId, workspace.ownershipToken, creatorCaller);
    expect(first.cleaned).toBe(false);
    await expect(fs.access(path.join(workspace.workspacePath, 'repos', 'api'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(workspace.workspacePath, 'repos', 'web'))).isDirectory()).toBe(true);

    failWeb = false;
    await expect(service.cleanup(workspace.runId, workspace.ownershipToken, creatorCaller)).resolves.toMatchObject({ cleaned: true });
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

    await expect(createWorkspace(service, {
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
      selectedRepositoryIds: ['api', 'web', 'worker'],
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

    await expect(createWorkspace(service, {
      runId: 'review-creating-metadata',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    })).rejects.toThrow('injected first add failure');

    expect(observedMetadata).toMatchObject({ state: 'creating', worktreeRepositoryIds: [] });
  });

  it('reconciles a creating worktree registration after its checkout disappears', async () => {
    const source = await createRepository('missing-checkout-registration');
    const service = createReviewWorkspaceService(source.path, { isProcessAlive: () => false });
    const workspace = await createWorkspace(service, {
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
    const workspace = await createWorkspace(service, {
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
    const recoverable = await createWorkspace(service, {
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
    const later = await createWorkspace(service, {
      runId: 'review-after-missing-metadata',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    await service.cleanup(later.runId, later.ownershipToken, creatorCaller);
  });

  it('returns already-clean success when a repeated cleanup has no metadata or workspace', async () => {
    const source = await createRepository('repeat-cleanup');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await createWorkspace(service, {
      runId: 'review-repeat-cleanup',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });

    await expect(service.cleanup(workspace.runId, workspace.ownershipToken, creatorCaller)).resolves.toMatchObject({ cleaned: true });
    await expect(service.cleanup(workspace.runId, workspace.ownershipToken, creatorCaller)).resolves.toMatchObject({ cleaned: true });
  });

  it('fails closed and preserves a workspace when cleanup finds no metadata', async () => {
    const source = await createRepository('missing-metadata-cleanup');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await createWorkspace(service, {
      runId: 'review-missing-metadata-cleanup',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const metadataPath = path.join(source.path, '.hive', '.worktrees', 'review', '.runs', 'review-missing-metadata-cleanup.json');
    await fs.rm(metadataPath);

    await expect(service.cleanup(workspace.runId, workspace.ownershipToken, creatorCaller)).rejects.toThrow('without valid metadata');
    expect((await fs.stat(workspace.workspacePath)).isDirectory()).toBe(true);
  });

  it('validates the persisted descriptor version and exact shape before returning a lease', async () => {
    const source = await createRepository('descriptor-validation');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await createWorkspace(service, {
      runId: 'review-descriptor-validation',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const metadataPath = reviewMetadataPath(source.path, workspace.runId);
    const original = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    const lease = await service.read(workspace.runId, workspace.ownershipToken, creatorCaller);

    expect(original.schemaVersion).toBe(1);
    expect(original).not.toHaveProperty('workspacePath');
    expect(await fs.readFile(metadataPath, 'utf8')).not.toContain(workspace.ownershipToken);
    expect(lease).not.toHaveProperty('ownershipTokenHash');
    expect(lease).not.toHaveProperty('cleanupIdentities');
    expect(JSON.stringify(lease)).not.toContain(source.path);

    const invalidDescriptors: unknown[] = [
      { ...original, schemaVersion: 2 },
      { ...original, workspacePath: workspace.workspacePath },
      { ...original, scopeFingerprint: 'f'.repeat(64) },
      {
        ...original,
        materializedEntries: {
          root: [{ path: 'tracked.txt', kind: 'regular', content: 'not-compact' }],
        },
      },
    ];
    for (const invalid of invalidDescriptors) {
      await fs.writeFile(metadataPath, JSON.stringify(invalid), 'utf8');
      await expect(service.read(workspace.runId, workspace.ownershipToken, creatorCaller)).rejects.toThrow(
        'Invalid review workspace metadata',
      );
    }

    await fs.writeFile(metadataPath, JSON.stringify(original), 'utf8');
    await service.cleanup(workspace.runId, workspace.ownershipToken, creatorCaller);
  });

  it('atomically replaces metadata while preserving readers of the previous descriptor', async () => {
    const source = await createRepository('atomic-metadata');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await createWorkspace(service, {
      runId: 'review-atomic-metadata',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const metadataPath = reviewMetadataPath(source.path, workspace.runId);
    const previousHandle = await fs.open(metadataPath, 'r');
    const previousInode = (await previousHandle.stat()).ino;

    try {
      await service.claim(workspace.runId, workspace.ownershipToken, primaryCaller('atomic-owner'));
      const previous = JSON.parse(await previousHandle.readFile('utf8'));
      const current = JSON.parse(await fs.readFile(metadataPath, 'utf8'));

      expect(previous).not.toHaveProperty('ownerSessionId');
      expect(current.ownerSessionId).toBe('atomic-owner');
      expect((await fs.stat(metadataPath)).ino).not.toBe(previousInode);
      expect((await fs.readdir(path.dirname(metadataPath))).filter((entry) => entry.startsWith('.metadata-'))).toEqual([]);
    } finally {
      await previousHandle.close();
    }

    await service.cleanup(workspace.runId, workspace.ownershipToken, primaryCaller('atomic-owner'));
  });

  it('reconstructs token-authenticated inspect and cleanup after a service restart', async () => {
    const source = await createRepository('restart');
    const firstService = createReviewWorkspaceService(source.path);
    const workspace = await createWorkspace(firstService, {
      runId: 'review-restart',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const owner = primaryCaller('restart-owner');
    await firstService.claim(workspace.runId, workspace.ownershipToken, owner);

    const restartedService = createReviewWorkspaceService(source.path);
    const inspection = await restartedService.inspect(workspace.runId, workspace.ownershipToken, owner);
    expect(inspection.lease).toMatchObject({
      schemaVersion: 1,
      runId: workspace.runId,
      ownerSessionId: owner.sessionId,
      ownerPid: owner.pid,
    });
    expect(inspection.integrity).toEqual({ trackedClean: true, baselineClean: true, untrackedFiles: false });
    await expect(restartedService.cleanup(workspace.runId, workspace.ownershipToken, owner)).resolves.toMatchObject({ cleaned: true });
    await expect(fs.access(workspace.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adopts a dead owner only for the same session, workflow, agent, and valid token', async () => {
    const source = await createRepository('dead-owner-adoption');
    let now = 1_000;
    const service = createReviewWorkspaceService(source.path, {
      now: () => now,
      reviewWorkspaceHandoffMs: 100,
      isProcessAlive: (pid: number) => pid === process.pid,
    });
    const workspace = await createWorkspace(service, {
      runId: 'review-dead-owner-adoption',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    await service.claim(workspace.runId, workspace.ownershipToken, primaryCaller('adoption-owner', 4242));
    await service.cleanupExpired();
    expect(JSON.parse(await fs.readFile(reviewMetadataPath(source.path, workspace.runId), 'utf8')).ownerRecoveryExpiresAt).toBe(1_100);

    now = 1_050;
    const adoptedOwner = primaryCaller('adoption-owner', process.pid);
    const restartedService = createReviewWorkspaceService(source.path, {
      now: () => now,
      reviewWorkspaceHandoffMs: 100,
      isProcessAlive: (pid: number) => pid === process.pid,
    });
    await restartedService.claim(workspace.runId, workspace.ownershipToken, adoptedOwner);
    expect(await restartedService.read(workspace.runId, workspace.ownershipToken, adoptedOwner)).toMatchObject({
      ownerSessionId: 'adoption-owner',
      ownerPid: process.pid,
    });
    expect(await restartedService.read(workspace.runId, workspace.ownershipToken, adoptedOwner)).not.toHaveProperty('ownerRecoveryExpiresAt');
    await restartedService.cleanup(workspace.runId, workspace.ownershipToken, adoptedOwner);
  });

  it('rejects owner adoption by a live competing PID or mismatched capability', async () => {
    const source = await createRepository('owner-adoption-denied');
    const service = createReviewWorkspaceService(source.path, {
      isProcessAlive: (pid: number) => pid === 4242,
    });
    const workspace = await createWorkspace(service, {
      runId: 'review-owner-adoption-denied',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const owner = primaryCaller('owned-session', 4242);
    await service.claim(workspace.runId, workspace.ownershipToken, owner);

    await expect(service.claim(workspace.runId, 'wrong-token', owner)).rejects.toThrow('ownership token');
    await expect(service.claim(workspace.runId, workspace.ownershipToken, primaryCaller('wrong-session', 4343))).rejects.toThrow('another owner');
    await expect(service.claim(workspace.runId, workspace.ownershipToken, { ...primaryCaller('owned-session', 4343), agent: 'wrong-agent' })).rejects.toThrow('another owner');
    await expect(service.claim(workspace.runId, workspace.ownershipToken, { ...primaryCaller('owned-session', 4343), workflow: 'vulnerability-review' })).rejects.toThrow('workflow claim');
    await expect(service.claim(workspace.runId, workspace.ownershipToken, primaryCaller('owned-session', 4343))).rejects.toThrow('live owner process');
    await service.cleanup(workspace.runId, workspace.ownershipToken, owner);
  });

  it('trusted session cleanup preserves failures and continues to later eligible runs', async () => {
    const source = await createRepository('trusted-session-cleanup');
    const setupService = createReviewWorkspaceService(source.path);
    const targetOwner = primaryCaller('cleanup-session');
    const otherOwner = primaryCaller('other-session');
    const vulnerabilityCreator: ReviewWorkspaceCaller = {
      workflow: 'vulnerability-review',
      role: 'creator',
      agent: '__hive_vulnerability_review_scope',
      sessionId: 'vulnerability-scope-session',
      pid: process.pid,
    };
    const vulnerabilityOwner: ReviewWorkspaceCaller = {
      workflow: 'vulnerability-review',
      role: 'primary',
      agent: '__hive_vulnerability_review_primary',
      sessionId: targetOwner.sessionId,
      pid: process.pid,
    };
    const createClaimed = async (
      runId: string,
      owner: ReviewWorkspaceCaller,
      creator: ReviewWorkspaceCaller = creatorCaller,
    ) => {
      const workspace = await createWorkspace(setupService, {
        runId,
        repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
      }, creator);
      await setupService.claim(runId, workspace.ownershipToken, owner);
      return workspace;
    };

    const corrupt = await createClaimed('a-corrupt', targetOwner);
    const eligible = await createClaimed('b-eligible', targetOwner);
    const invalidIdentity = await createClaimed('c-invalid-identity', targetOwner);
    const missingMetadata = await createClaimed('d-missing-metadata', targetOwner);
    const busy = await createClaimed('e-busy-lock', targetOwner);
    const wrongSession = await createClaimed('f-wrong-session', otherOwner);
    const wrongWorkflow = await createClaimed('g-wrong-workflow', vulnerabilityOwner, vulnerabilityCreator);
    const laterEligible = await createClaimed('z-eligible-after-errors', targetOwner);

    await fs.writeFile(reviewMetadataPath(source.path, corrupt.runId), '{', 'utf8');
    const invalidIdentityMetadataPath = reviewMetadataPath(source.path, invalidIdentity.runId);
    const invalidIdentityMetadata = JSON.parse(await fs.readFile(invalidIdentityMetadataPath, 'utf8'));
    invalidIdentityMetadata.cleanupIdentities.root.commonDir = path.join(source.path, '.git', 'objects');
    await fs.writeFile(invalidIdentityMetadataPath, JSON.stringify(invalidIdentityMetadata), 'utf8');
    await fs.rm(reviewMetadataPath(source.path, missingMetadata.runId));
    await fs.writeFile(
      path.join(source.path, '.hive', '.worktrees', 'review', '.locks', `${busy.runId}.lock`),
      JSON.stringify({ ownerToken: 'busy-owner', ownerPid: 9001 }),
      'utf8',
    );

    const cleanupService = createReviewWorkspaceService(source.path, {
      isProcessAlive: (pid: number) => pid === 9001,
    });
    const results = await cleanupService.cleanupOwnedBySession(targetOwner.sessionId, ['dash-review']);
    const byRunId = Object.fromEntries(results.map((result) => [result.runId, result]));

    expect(byRunId[eligible.runId]).toMatchObject({ cleaned: true, errors: [] });
    expect(byRunId[laterEligible.runId]).toMatchObject({ cleaned: true, errors: [] });
    expect(byRunId[corrupt.runId]).toMatchObject({ cleaned: false, errors: [expect.stringContaining('Invalid review workspace metadata')] });
    expect(byRunId[invalidIdentity.runId]).toMatchObject({ cleaned: false, errors: [expect.stringContaining('identity')] });
    expect(byRunId[missingMetadata.runId]).toMatchObject({ cleaned: false, errors: [expect.stringContaining('without valid metadata')] });
    expect(byRunId[busy.runId]).toMatchObject({ cleaned: false, errors: [expect.stringContaining('busy')] });
    expect(byRunId[wrongSession.runId]).toMatchObject({ cleaned: false, errors: [expect.stringContaining('another session')] });
    expect(byRunId[wrongWorkflow.runId]).toMatchObject({ cleaned: false, errors: [expect.stringContaining('disallowed workflow')] });
    await expect(fs.access(eligible.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(laterEligible.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const preserved of [corrupt, invalidIdentity, missingMetadata, busy, wrongSession, wrongWorkflow]) {
      expect((await fs.stat(preserved.workspacePath)).isDirectory()).toBe(true);
    }
  });

  it('reports a new untracked entry as a workspace delta distinct from source identity', async () => {
    const source = await createRepository('new-untracked-integrity');
    const service = createReviewWorkspaceService(source.path);
    const workspace = await createWorkspace(service, {
      runId: 'review-new-untracked-integrity',
      repositories: [{ id: 'root', sourcePath: source.path, commit: 'HEAD' }],
    });
    const owner = primaryCaller('new-untracked-owner');
    await service.claim(workspace.runId, workspace.ownershipToken, owner);
    const initial = await service.inspect(workspace.runId, workspace.ownershipToken, owner);
    await fs.writeFile(path.join(workspace.workspacePath, 'new-untracked.txt'), 'workspace delta\n');

    const changed = await service.inspect(workspace.runId, workspace.ownershipToken, owner);
    expect(changed.integrity).toEqual({ trackedClean: true, baselineClean: true, untrackedFiles: true });
    expect(changed.integrity.baselineClean && !changed.integrity.untrackedFiles).toBe(false);
    expect(changed.lease.sourceFingerprint).toBe(initial.lease.sourceFingerprint);
    await service.cleanup(workspace.runId, workspace.ownershipToken, owner);
  });
});
