import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { AdhocWorktreeService } from './adhocWorktreeService';
import {
  repositoryResourceName,
  trustedGitCommonDirectory,
  withWorktreeMutation,
  WorktreeOperationRecoveryService,
  WorktreeRecoveryRefusedError,
} from './worktreeOperation';
import type { PendingWorktreeOperation, WorktreeRecoveryRequest } from './worktreeOperation';
import {
  isMutationOutcomeKnown,
  withFinalizationFailure,
  WorktreeOperationFinalizationError,
  WorktreeOperationRecoveryRequiredError,
} from './worktreeOutcome';
import { readWorktreeTargetIdentity } from './worktreeTarget';

const mergeMessage = 'feat: integrate guarded work\n\nIntegrate the ad-hoc change the guard tests commit.';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync(dir);
}

async function createRepo(prefix = 'hive-operation-guard-'): Promise<{ repoPath: string; git: SimpleGit }> {
  const repoPath = tempDir(prefix);
  await simpleGit().raw(['init', '-b', 'main', repoPath]);
  const git = simpleGit(repoPath);
  await git.raw(['config', 'user.email', 'test@example.com']);
  await git.raw(['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repoPath, '.gitignore'), '.hive/\n');
  fs.writeFileSync(path.join(repoPath, 'tracked.txt'), 'base\n');
  await git.add(['.gitignore', 'tracked.txt']);
  await git.commit('chore: base commit\n\nCreate the fixture history.');
  return { repoPath, git };
}

async function createFixture() {
  const { repoPath, git } = await createRepo();
  const hiveDir = path.join(repoPath, '.hive');
  return {
    repoPath,
    hiveDir,
    git,
    service: new AdhocWorktreeService({ baseDir: repoPath, hiveDir }),
    recovery: new WorktreeOperationRecoveryService({ baseDir: repoPath, hiveDir }),
  };
}

async function commitInRun(service: AdhocWorktreeService, runId: string, file: string): Promise<string> {
  const run = (await service.get(runId))!;
  const git = simpleGit(run.path);
  fs.writeFileSync(path.join(run.path, file), `${file}\n`);
  await git.add([file]);
  await git.commit(`feat: add ${file}\n\nAdd a file the guard tests integrate.`);
  return (await git.revparse(['HEAD'])).trim();
}

function markerFiles(hiveDir: string): string[] {
  const directory = path.join(hiveDir, '.locks', 'operations');
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

function recoveryRequest(entry: PendingWorktreeOperation): WorktreeRecoveryRequest {
  return { operationId: entry.operationId, markerDigest: entry.markerDigest, observedStateDigest: entry.observedStateDigest, mutatorsStopped: true };
}

async function refusal(promise: Promise<unknown>): Promise<WorktreeRecoveryRefusedError> {
  const error = await promise.then(() => null, (failure) => failure);
  expect(error).toBeInstanceOf(WorktreeRecoveryRefusedError);
  return error as WorktreeRecoveryRefusedError;
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}

/** Make every pending-marker unlink fail, as a full or read-only `.hive` would. */
function failMarkerClearing(): () => void {
  const originalUnlink = fs.unlinkSync;
  const spy = spyOn(fs, 'unlinkSync').mockImplementation(((target: fs.PathLike) => {
    if (String(target).includes(`${path.sep}operations${path.sep}`) && String(target).endsWith('.json')) {
      throw Object.assign(new Error('marker unlink failed'), { code: 'EIO' });
    }
    return originalUnlink(target);
  }) as typeof fs.unlinkSync);
  return () => spy.mockRestore();
}

/** Make unlinking the workspace marker fail, so only the repository marker of an operation is removed. */
function failWorkspaceMarkerClearing(): () => void {
  const originalUnlink = fs.unlinkSync;
  const spy = spyOn(fs, 'unlinkSync').mockImplementation(((target: fs.PathLike) => {
    if (String(target).includes(`${path.sep}operations${path.sep}workspace-`) && String(target).endsWith('.json')) {
      throw Object.assign(new Error('marker unlink failed'), { code: 'EIO' });
    }
    return originalUnlink(target);
  }) as typeof fs.unlinkSync);
  return () => spy.mockRestore();
}

/** Make flushing the pending-marker directory fail while `active()` holds, as an fsync error on a failing device would. */
function failMarkerDirectoryFlush(hiveDir: string, active: () => boolean = () => true): () => void {
  const directory = path.join(hiveDir, '.locks', 'operations');
  const originalOpen = fs.openSync;
  const spy = spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
    if (active() && path.resolve(String(target)) === directory) {
      throw Object.assign(new Error('marker directory flush failed'), { code: 'EIO' });
    }
    return (originalOpen as (...values: unknown[]) => number)(target, ...rest);
  }) as typeof fs.openSync);
  return () => spy.mockRestore();
}

/**
 * Make releasing a native lock report failure. The descriptor that carries the
 * lock is the one opened with O_CREAT on an anchor; it is still closed, so the
 * lock is released, and only the reported result fails.
 */
function failLockReleases(): () => void {
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const lockDescriptors = new Set<number>();
  const openSpy = spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
    const descriptor = originalOpen(target, flags, mode);
    if (String(target).includes(`${path.sep}.locks${path.sep}`) && typeof flags === 'number' && (flags & fs.constants.O_CREAT) !== 0) {
      lockDescriptors.add(descriptor);
    }
    return descriptor;
  }) as typeof fs.openSync);
  const closeSpy = spyOn(fs, 'closeSync').mockImplementation(((descriptor: number) => {
    originalClose(descriptor);
    if (lockDescriptors.delete(descriptor)) throw Object.assign(new Error('lock close failed'), { code: 'EIO' });
  }) as typeof fs.closeSync);
  return () => {
    openSpy.mockRestore();
    closeSpy.mockRestore();
  };
}

const servicePath = path.join(import.meta.dir, 'adhocWorktreeService.ts');

describe('worktree operation guard', () => {
  it('publishes no marker for reads, workspace reuse, preflight refusals or a merge with nothing to apply', async () => {
    const fx = await createFixture();
    await fx.service.create({ runId: 'quiet' });
    const originalWrite = fs.writeFileSync;
    const markerWrites: string[] = [];
    const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(target).includes(`${path.sep}operations${path.sep}`)) markerWrites.push(String(target));
      return (originalWrite as (...args: unknown[]) => void)(target, ...rest);
    }) as typeof fs.writeFileSync);
    try {
      await fx.service.create({ runId: 'quiet' });
      expect((await fx.service.inspect('quiet'))?.pendingOperations).toBeUndefined();
      const target = await readWorktreeTargetIdentity(fx.repoPath);
      const nothing = await fx.service.merge('quiet', 'squash', mergeMessage, { historyIntent: 'rewrite-private', expectedTarget: target });
      expect(nothing).toMatchObject({ success: true, merged: false, reasonCode: 'ALREADY_INTEGRATED' });
      await commitInRun(fx.service, 'quiet', 'change.txt');
      const mismatch = await fx.service.merge('quiet', 'squash', mergeMessage, { historyIntent: 'rewrite-private', expectedTarget: { ...target, commit: '0'.repeat(40) } });
      expect(mismatch).toMatchObject({ success: false, reasonCode: 'TARGET_MISMATCH', mutation: 'none' });
    } finally {
      writeSpy.mockRestore();
    }
    expect(markerWrites).toEqual([]);
    expect(markerFiles(fx.hiveDir)).toEqual([]);
  });

  it('leaves nothing to recover when a host dies during a read', async () => {
    const fx = await createFixture();
    await fx.service.create({ runId: 'read-crash' });
    const ready = path.join(tempDir('hive-read-crash-'), 'reading');
    const script = `
      import { spyOn } from 'bun:test';
      import { writeFileSync } from 'fs';
      import { AdhocWorktreeService } from ${JSON.stringify(servicePath)};
      spyOn(AdhocWorktreeService.prototype, 'get').mockImplementation(() => {
        writeFileSync(${JSON.stringify(ready)}, '');
        return new Promise(() => {});
      });
      await new AdhocWorktreeService({ baseDir: ${JSON.stringify(fx.repoPath)}, hiveDir: ${JSON.stringify(fx.hiveDir)} }).inspect('read-crash');
    `;
    const host = Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'pipe' });
    try {
      await waitFor(() => fs.existsSync(ready), 'the read to start');
      host.kill('SIGKILL');
      await host.exited;
    } finally {
      host.kill('SIGKILL');
    }
    expect(markerFiles(fx.hiveDir)).toEqual([]);
    expect(await fx.recovery.list()).toEqual([]);
    const inspected = await fx.service.inspect('read-crash');
    expect(inspected?.pendingOperations).toBeUndefined();
    expect((await fx.service.cleanup('read-crash', true)).cleanup.outcome).toBe('complete');
  });

  it('keeps every later mutation refused while a Git command outlives its killed host, until that exact operation is acknowledged', async () => {
    const fx = await createFixture();
    await fx.service.create({ runId: 'interrupted' });
    const sourceCommit = await commitInRun(fx.service, 'interrupted', 'feature.txt');
    const control = tempDir('hive-hook-control-');
    const started = path.join(control, 'started');
    const release = path.join(control, 'release');
    const hooks = path.join(control, 'hooks');
    fs.mkdirSync(hooks);
    // The hook also ends when the fixture is removed, so a failed run leaves no orphaned Git process behind.
    fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\n: > '${started}'\nwhile [ ! -f '${release}' ] && [ -d '${control}' ]; do sleep 0.05; done\n`, { mode: 0o755 });
    // Repository-local hook path for the fixture only; user and global hook settings are untouched.
    await fx.git.raw(['config', 'core.hooksPath', hooks]);
    const target = await readWorktreeTargetIdentity(fx.repoPath);
    const commitsBefore = Number((await fx.git.raw(['rev-list', '--count', 'HEAD'])).trim());

    const script = `
      import { AdhocWorktreeService } from ${JSON.stringify(servicePath)};
      const service = new AdhocWorktreeService({ baseDir: ${JSON.stringify(fx.repoPath)}, hiveDir: ${JSON.stringify(fx.hiveDir)} });
      await service.merge('interrupted', 'squash', ${JSON.stringify(mergeMessage)}, { historyIntent: 'rewrite-private', expectedTarget: ${JSON.stringify(target)} });
    `;
    const host = Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'ignore' });
    let pending!: PendingWorktreeOperation;
    try {
      await waitFor(() => fs.existsSync(started), 'the commit hook to start');
      host.kill('SIGKILL');
      await host.exited;

      // The host is gone and its native locks with it, so inspection works and reports the operation.
      const inspected = await fx.service.inspect('interrupted');
      expect(inspected?.pendingOperations).toHaveLength(1);
      pending = inspected!.pendingOperations![0]!;
      expect(pending).toMatchObject({
        state: 'interrupted',
        marker: { kind: 'merge', subject: { type: 'adhoc', runId: 'interrupted' }, strategy: 'squash' },
        recovery: { available: true },
      });
      expect(pending.marker!.repositories[0]).toMatchObject({ repositoryPath: fx.repoPath, sourceCommit, expectedTarget: target });
      // The squash is staged and its commit is still running; Git holds no lock while the hook runs, so only state shows it.
      expect(pending.observed.repositories[0]!.activeGitState).toContain('repository:SQUASH_MSG');
      expect(markerFiles(fx.hiveDir)).toHaveLength(2);

      // Replacement mutations are refused before any effect, and never as a retryable failure.
      const refused = await fx.service.merge('interrupted', 'squash', mergeMessage, { historyIntent: 'rewrite-private', expectedTarget: target }).catch((error) => error);
      expect(refused).toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
      expect(refused).toMatchObject({ reasonCode: 'OPERATION_RECOVERY_REQUIRED', mutation: 'none', operationIds: [pending.operationId] });
      await expect(fx.service.cleanup('interrupted', true)).rejects.toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
      expect((await fx.recovery.list())[0]!.markerDigest).toBe(pending.markerDigest);

      expect((await refusal(fx.recovery.recover({ ...recoveryRequest(pending), mutatorsStopped: false }))).reason).toBe('attestation_required');
      expect((await refusal(fx.recovery.recover({ ...recoveryRequest(pending), operationId: 'not-an-operation' }))).reason).toBe('operation_not_found');
      expect((await refusal(fx.recovery.recover({ ...recoveryRequest(pending), markerDigest: '0'.repeat(64) }))).reason).toBe('marker_changed');
      expect((await refusal(fx.recovery.recover(recoveryRequest(pending)))).reason).toBe('git_operation_active');
    } finally {
      fs.writeFileSync(release, '');
      host.kill('SIGKILL');
    }

    // The orphaned commit finishes on its own; the inspected state is now stale.
    const gitState = ['SQUASH_MSG', 'index.lock'].map((name) => path.join(fx.repoPath, '.git', name));
    await waitFor(() => gitState.every((statePath) => !fs.existsSync(statePath)), 'the orphaned commit to finish');
    const committed = Number((await fx.git.raw(['rev-list', '--count', 'HEAD'])).trim());
    expect(committed).toBe(commitsBefore + 1);
    expect((await refusal(fx.recovery.recover(recoveryRequest(pending)))).reason).toBe('observed_state_changed');

    const fresh = (await fx.recovery.list())[0]!;
    expect(fresh.markerDigest).toBe(pending.markerDigest);
    const recovered = await fx.recovery.recover(recoveryRequest(fresh));
    expect(recovered).toEqual({ operationId: fresh.operationId, state: 'interrupted', cleared: fresh.markerPaths, replayed: false });
    expect(markerFiles(fx.hiveDir)).toEqual([]);
    // Acknowledging ran no Git work.
    expect(Number((await fx.git.raw(['rev-list', '--count', 'HEAD'])).trim())).toBe(committed);
    expect((await fx.service.inspect('interrupted'))?.pendingOperations).toBeUndefined();
    expect((await fx.service.cleanup('interrupted', true, { discard: true })).cleanup.outcome).toBe('complete');
  }, 60_000);

  it('retains markers for an unknown outcome and clears them for a known one', async () => {
    const { repoPath } = await createRepo();
    const hiveDir = path.join(repoPath, '.hive');
    const scope = (workspace: string) => ({
      hiveDir,
      workspacePath: path.join(hiveDir, '.worktrees', 'adhoc', workspace),
      select: async () => ({ repositoryPaths: [repoPath] }),
      commonDirectory: (repositoryPath: string) => trustedGitCommonDirectory(repositoryPath),
      trustedRepositoryPaths: () => [repoPath],
      kind: 'merge' as const,
      subject: { type: 'adhoc' as const, runId: workspace },
    });

    const cleared = await withWorktreeMutation(scope('known'), async (_selection, guard) => {
      await guard.begin();
      expect(markerFiles(hiveDir)).toHaveLength(2);
      return { mutation: 'applied' as const };
    }, () => true);
    expect(cleared).toEqual({ mutation: 'applied' });
    await expect(withWorktreeMutation(scope('rolled-back'), async (_selection, guard) => {
      await guard.begin();
      guard.markOutcomeKnown();
      throw new Error('verified rollback');
    })).rejects.toThrow('verified rollback');
    expect(markerFiles(hiveDir)).toEqual([]);

    const unknown = await withWorktreeMutation(scope('unknown-result'), async (_selection, guard) => {
      await guard.begin();
      return { mutation: 'unknown' as const };
    }, (result) => result.mutation !== 'unknown');
    expect(unknown).toEqual({ mutation: 'unknown' });
    const retained = markerFiles(hiveDir);
    expect(retained).toHaveLength(2);

    let ran = false;
    const refused = await withWorktreeMutation(scope('another-workspace'), async () => {
      ran = true;
    }).catch((error) => error);
    expect(refused).toMatchObject({ reasonCode: 'OPERATION_RECOVERY_REQUIRED', mutation: 'none' });
    expect(ran).toBe(false);
    expect(markerFiles(hiveDir)).toEqual(retained);
  });

  it('turns a failure after the first mutation into a non-retryable unknown outcome and never clears another operation', async () => {
    const first = await createRepo();
    const second = await createRepo();
    const hiveDir = path.join(first.repoPath, '.hive');
    const scope = (workspace: string, repoPath: string) => ({
      hiveDir,
      workspacePath: path.join(hiveDir, '.worktrees', 'adhoc', workspace),
      select: async () => ({ repositoryPaths: [repoPath] }),
      commonDirectory: (repositoryPath: string) => trustedGitCommonDirectory(repositoryPath),
      trustedRepositoryPaths: () => [repoPath],
      kind: 'cleanup' as const,
      subject: { type: 'adhoc' as const, runId: workspace },
    });
    for (const [workspace, repoPath] of [['first', first.repoPath], ['second', second.repoPath]] as const) {
      const failure = await withWorktreeMutation(scope(workspace, repoPath), async (_selection, guard) => {
        await guard.begin();
        throw new Error('host lost its Git child');
      }).catch((error) => error);
      expect(failure).toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
      expect(failure).toMatchObject({ mutation: 'unknown', message: expect.stringContaining('host lost its Git child') });
    }
    expect(markerFiles(hiveDir)).toHaveLength(4);

    // Only the project's own repository is trusted, so the second operation cannot be acknowledged here.
    const recovery = new WorktreeOperationRecoveryService({ baseDir: first.repoPath, hiveDir });
    const entries = await recovery.list();
    const own = entries.find((entry) => entry.marker?.workspacePath?.endsWith('first'))!;
    const foreign = entries.find((entry) => entry.marker?.workspacePath?.endsWith('second'))!;
    expect((await refusal(recovery.recover(recoveryRequest(foreign)))).reason).toBe('resource_untrusted');
    await recovery.recover(recoveryRequest(own));
    expect(markerFiles(hiveDir)).toHaveLength(2);
    expect((await recovery.list()).map((entry) => entry.operationId)).toEqual([foreign.operationId]);
  });

  it('withdraws its own markers when publication fails, and runs no mutation', async () => {
    const { repoPath } = await createRepo();
    const hiveDir = path.join(repoPath, '.hive');
    const originalRename = fs.renameSync;
    let renames = 0;
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).includes(`${path.sep}operations${path.sep}`) && ++renames === 2) {
        throw Object.assign(new Error('marker publication failed'), { code: 'EIO' });
      }
      return originalRename(from, to);
    }) as typeof fs.renameSync);
    let mutated = false;
    try {
      await expect(withWorktreeMutation({
        hiveDir,
        workspacePath: path.join(hiveDir, '.worktrees', 'adhoc', 'publish'),
        select: async () => ({ repositoryPaths: [repoPath] }),
        commonDirectory: (repositoryPath) => trustedGitCommonDirectory(repositoryPath),
        trustedRepositoryPaths: () => [repoPath],
        kind: 'create',
        subject: { type: 'adhoc', runId: 'publish' },
      }, async (_selection, guard) => {
        await guard.begin();
        mutated = true;
      })).rejects.toThrow('marker publication failed');
    } finally {
      renameSpy.mockRestore();
    }
    expect(mutated).toBe(false);
    expect(markerFiles(hiveDir)).toEqual([]);
  });

  it('removes nothing when markers cannot be published before cleanup of an already integrated run', async () => {
    const single = await createFixture();
    await single.service.create({ runId: 'contained' });
    const singleRun = (await single.service.get('contained'))!;

    const api = await createRepo();
    const web = await createRepo();
    const baseDir = tempDir('hive-operation-guard-composite-');
    const hiveDir = path.join(baseDir, '.hive');
    const repositories = [
      { id: 'api', path: api.repoPath, root: api.repoPath },
      { id: 'web', path: web.repoPath, root: web.repoPath },
    ];
    const composite = new AdhocWorktreeService({ baseDir, hiveDir, repositoryResolver: () => repositories });
    const compositeRun = await composite.create({ runId: 'contained', repoIds: ['api', 'web'] });

    const originalRename = fs.renameSync;
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).includes(`${path.sep}operations${path.sep}`)) {
        throw Object.assign(new Error('marker publication failed'), { code: 'EIO' });
      }
      return originalRename(from, to);
    }) as typeof fs.renameSync);
    try {
      // A contained source reaches cleanup without any earlier mutation, so cleanup is the first effect the guard must cover.
      await expect(single.service.merge('contained', undefined, undefined, {
        historyIntent: 'preserve-source',
        cleanup: 'worktree+branch',
        expectedTarget: await readWorktreeTargetIdentity(single.repoPath),
      })).rejects.toThrow('marker publication failed');
      await expect(composite.merge('contained', undefined, undefined, {
        historyIntent: 'preserve-source',
        cleanup: 'worktree+branch',
        expectedTargets: {
          api: await readWorktreeTargetIdentity(api.repoPath),
          web: await readWorktreeTargetIdentity(web.repoPath),
        },
      })).rejects.toThrow('marker publication failed');
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.existsSync(singleRun.path)).toBe(true);
    expect((await single.git.branchLocal()).all).toContain(singleRun.branch);
    expect(markerFiles(single.hiveDir)).toEqual([]);
    for (const [repoId, git] of [['api', api.git], ['web', web.git]] as const) {
      const repo = compositeRun.repos![repoId]!;
      expect(fs.existsSync(repo.path)).toBe(true);
      expect((await git.branchLocal()).all).toContain(repo.branch);
    }
    expect(markerFiles(hiveDir)).toEqual([]);

    // With publication restored, the same calls prove containment and clean up.
    expect(await single.service.merge('contained', undefined, undefined, {
      historyIntent: 'preserve-source',
      cleanup: 'worktree+branch',
      expectedTarget: await readWorktreeTargetIdentity(single.repoPath),
    })).toMatchObject({ success: true, reasonCode: 'ALREADY_INTEGRATED', cleanup: { outcome: 'complete' } });
    expect(markerFiles(single.hiveDir)).toEqual([]);
  });

  it('reports legacy lock files and unreadable markers, and recovers only records it can map to a project resource', async () => {
    const fx = await createFixture();
    await fx.service.create({ runId: 'legacy' });
    const repositoryName = repositoryResourceName(await trustedGitCommonDirectory(fx.repoPath));
    const legacyLock = path.join(fx.hiveDir, '.operation-locks', `${repositoryName}.lock`);
    fs.mkdirSync(path.dirname(legacyLock), { recursive: true });
    fs.writeFileSync(legacyLock, JSON.stringify({ pid: 3858212, timestamp: '2026-10-29T00:00:00.000Z' }));

    const inspected = await fx.service.inspect('legacy');
    expect(inspected?.pendingOperations).toEqual([expect.objectContaining({
      operationId: `legacy:${repositoryName}`,
      state: 'legacy_lock',
      record: { path: legacyLock, excerpt: expect.stringContaining('3858212') },
      recovery: { available: true },
    })]);
    await expect(fx.service.cleanup('legacy')).rejects.toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    const legacy = inspected!.pendingOperations![0]!;
    expect(await fx.recovery.recover(recoveryRequest(legacy))).toMatchObject({ state: 'legacy_lock', cleared: [legacyLock], replayed: false });
    expect(fs.existsSync(legacyLock)).toBe(false);

    const operations = path.join(fx.hiveDir, '.locks', 'operations');
    fs.mkdirSync(operations, { recursive: true });
    const unreadable = path.join(operations, `${repositoryName}.json`);
    const unmapped = path.join(operations, `${'f'.repeat(64)}.json`);
    fs.writeFileSync(unreadable, '{"protocol":');
    fs.writeFileSync(unmapped, 'not json');
    await expect(fx.service.cleanup('legacy')).rejects.toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    const listed = await fx.recovery.list();
    const mapped = listed.find((entry) => entry.operationId === `unreadable:${repositoryName}`)!;
    const orphan = listed.find((entry) => entry.operationId === `unreadable:${'f'.repeat(64)}`)!;
    expect(mapped).toMatchObject({ state: 'unreadable_marker', recovery: { available: true } });
    expect(orphan.recovery).toMatchObject({ available: false });
    expect((await refusal(fx.recovery.recover(recoveryRequest(orphan)))).reason).toBe('recovery_unavailable');
    await fx.recovery.recover(recoveryRequest(mapped));
    expect(fs.existsSync(unreadable)).toBe(false);
    expect(fs.readFileSync(unmapped, 'utf8')).toBe('not json');
    // The unmapped record guards no resource of this run, so the run's mutations proceed.
    expect((await fx.service.cleanup('legacy', true)).cleanup.outcome).toBe('complete');
  });

  it('reports a marker that names paths outside the project without reading them, and never clears it', async () => {
    const fx = await createFixture();
    await fx.service.create({ runId: 'trusted' });
    const run = (await fx.service.get('trusted'))!;
    const outside = await createRepo('hive-untrusted-');
    // Git operation state in the outside checkout would appear in any observation of it.
    fs.writeFileSync(path.join(outside.repoPath, '.git', 'MERGE_HEAD'), `${(await outside.git.revparse(['HEAD'])).trim()}\n`);
    const repositoryName = repositoryResourceName(await trustedGitCommonDirectory(fx.repoPath));
    const operations = path.join(fx.hiveDir, '.locks', 'operations');
    fs.mkdirSync(operations, { recursive: true });
    const markerFile = path.join(operations, `${repositoryName}.json`);
    const marker = (overrides: Record<string, unknown>) => JSON.stringify({
      protocol: 'hive-worktree-operation/v1',
      operationId: 'planted',
      kind: 'merge',
      subject: { type: 'adhoc', runId: 'trusted' },
      workspacePath: run.path,
      repositories: [{ repositoryPath: fx.repoPath, commonDirectory: path.join(fx.repoPath, '.git') }],
      startedAt: '2026-10-30T00:00:00.000Z',
      pid: 1,
      ...overrides,
    });

    for (const declared of [
      { workspacePath: outside.repoPath },
      { repositories: [{ repositoryPath: outside.repoPath, commonDirectory: path.join(outside.repoPath, '.git') }] },
      { repositories: [{ repositoryPath: fx.repoPath, commonDirectory: path.join(fx.repoPath, '.git'), sourceWorktreePath: outside.repoPath }] },
      { repositories: [{ repositoryPath: fx.repoPath, commonDirectory: path.join(fx.repoPath, '.git'), sourceBranch: '../../../../MERGE_HEAD' }] },
    ]) {
      fs.writeFileSync(markerFile, marker(declared));
      const inspected = (await fx.service.inspect('trusted'))!.pendingOperations!;
      const listed = await fx.recovery.list();
      for (const entry of [inspected[0]!, listed[0]!]) {
        expect(entry).toMatchObject({ operationId: 'planted', state: 'interrupted', observed: { workspace: null, repositories: [] }, recovery: { available: false } });
      }
      await expect(fx.service.cleanup('trusted')).rejects.toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
      expect((await refusal(fx.recovery.recover(recoveryRequest(listed[0]!)))).reason).toBe('resource_untrusted');
      expect(fs.readFileSync(markerFile, 'utf8')).toBe(marker(declared));
    }
  });

  it('does not observe a checkout that a symlink or a rewritten .git pointer redirects, and never clears its record', async () => {
    const fx = await createFixture();
    await fx.service.create({ runId: 'linked' });
    const run = (await fx.service.get('linked'))!;
    const outside = await createRepo('hive-redirected-');
    fs.writeFileSync(path.join(outside.repoPath, '.git', 'MERGE_HEAD'), `${(await outside.git.revparse(['HEAD'])).trim()}\n`);
    const commonDirectory = await trustedGitCommonDirectory(fx.repoPath);
    const operations = path.join(fx.hiveDir, '.locks', 'operations');
    fs.mkdirSync(operations, { recursive: true });
    const markerFile = path.join(operations, `${repositoryResourceName(commonDirectory)}.json`);
    const marker = (workspacePath: string, sourceWorktreePath?: string) => JSON.stringify({
      protocol: 'hive-worktree-operation/v1',
      operationId: 'redirected',
      kind: 'merge',
      subject: { type: 'adhoc', runId: 'linked' },
      workspacePath,
      repositories: [{ repositoryPath: fx.repoPath, commonDirectory, ...(sourceWorktreePath ? { sourceWorktreePath } : {}) }],
      startedAt: '2026-10-30T00:00:00.000Z',
      pid: 1,
    });
    const pointerPath = path.join(run.path, '.git');
    const pointer = fs.readFileSync(pointerPath, 'utf8');
    const planted = path.join(fx.hiveDir, '.worktrees', 'adhoc', 'planted');

    const layouts = [
      {
        // A composite-shaped source inside the marker's own workspace that is a symlink to another repository.
        redirected: path.join(run.path, 'repos', 'api'),
        record: marker(run.path, path.join(run.path, 'repos', 'api')),
        setup: () => {
          fs.mkdirSync(path.join(run.path, 'repos'));
          fs.symlinkSync(outside.repoPath, path.join(run.path, 'repos', 'api'));
        },
        teardown: () => fs.rmSync(path.join(run.path, 'repos'), { recursive: true, force: true }),
      },
      {
        // A workspace placement whose repos/ child, found only by scanning the workspace, is a symlink.
        redirected: path.join(planted, 'repos', 'evil'),
        record: marker(planted),
        setup: () => {
          fs.mkdirSync(path.join(planted, 'repos'), { recursive: true });
          fs.symlinkSync(outside.repoPath, path.join(planted, 'repos', 'evil'));
        },
        teardown: () => fs.rmSync(planted, { recursive: true, force: true }),
      },
      {
        // The run's own checkout, its .git pointer rewritten to another repository's administration directory.
        redirected: run.path,
        record: marker(run.path, run.path),
        setup: () => fs.writeFileSync(pointerPath, `gitdir: ${path.join(outside.repoPath, '.git')}\n`),
        teardown: () => fs.writeFileSync(pointerPath, pointer),
      },
    ];
    for (const layout of layouts) {
      layout.setup();
      fs.writeFileSync(markerFile, layout.record);
      const gitDirectories: string[] = [];
      const spawn = childProcess.spawn;
      const spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(((command: string, args: string[], options: { cwd?: string }) => {
        gitDirectories.push(path.resolve(String(options?.cwd)));
        return (spawn as (...values: unknown[]) => unknown)(command, args, options);
      }) as unknown as typeof childProcess.spawn);
      let listed: PendingWorktreeOperation[];
      let refused: WorktreeRecoveryRefusedError;
      try {
        listed = await fx.recovery.list();
        refused = await refusal(fx.recovery.recover(recoveryRequest(listed[0]!)));
      } finally {
        spawnSpy.mockRestore();
        layout.teardown();
      }
      expect(listed).toEqual([expect.objectContaining({ operationId: 'redirected', observed: { workspace: null, repositories: [] }, recovery: { available: false, reason: expect.any(String) } })]);
      expect(refused.reason).toBe('resource_untrusted');
      // Git ran in the trusted repository to establish its identity, and never in the redirected checkout or its target.
      expect(gitDirectories).toContain(fx.repoPath);
      expect(gitDirectories.filter((directory) => directory.startsWith(layout.redirected) || directory.startsWith(outside.repoPath))).toEqual([]);
      expect(fs.readFileSync(markerFile, 'utf8')).toBe(layout.record);
    }
    fs.unlinkSync(markerFile);
    expect((await fx.service.cleanup('linked', true)).cleanup.outcome).toBe('complete');
  });

  it('does not observe a declared path whose .. segment the operating system resolves through a symlink, and never clears its record', async () => {
    const fx = await createFixture();
    await fx.service.create({ runId: 'dotted' });
    const run = (await fx.service.get('dotted'))!;
    const outside = await createRepo('hive-dotted-');
    fs.writeFileSync(path.join(outside.repoPath, '.git', 'MERGE_HEAD'), `${(await outside.git.revparse(['HEAD'])).trim()}\n`);
    fs.mkdirSync(path.join(outside.repoPath, 'nested'));
    const commonDirectory = await trustedGitCommonDirectory(fx.repoPath);
    const operations = path.join(fx.hiveDir, '.locks', 'operations');
    fs.mkdirSync(operations, { recursive: true });
    const markerFile = path.join(operations, `${repositoryResourceName(commonDirectory)}.json`);
    // `<checkout>/hop/..` names the checkout lexically, but the operating system follows hop first and lands in the outside repository.
    const dotted = (checkout: string) => [checkout, 'hop', '..'].join(path.sep);
    // fs.realpathSync normalizes `..` before resolving symlinks, so ask a process started there where it runs.
    const physical = (cwd: string) => childProcess.execFileSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd, encoding: 'utf8' });
    const marker = (workspacePath: string, repository: Record<string, string>) => JSON.stringify({
      protocol: 'hive-worktree-operation/v1',
      operationId: 'dotted',
      kind: 'merge',
      subject: { type: 'adhoc', runId: 'dotted' },
      workspacePath,
      repositories: [{ repositoryPath: fx.repoPath, commonDirectory, ...repository }],
      startedAt: '2026-10-30T00:00:00.000Z',
      pid: 1,
    });

    for (const [checkout, record] of [
      [run.path, marker(run.path, { sourceWorktreePath: dotted(run.path) })],
      [run.path, marker(dotted(run.path), {})],
      [fx.repoPath, marker(run.path, { repositoryPath: dotted(fx.repoPath) })],
    ] as const) {
      const hop = path.join(checkout, 'hop');
      fs.symlinkSync(path.join(outside.repoPath, 'nested'), hop);
      expect(physical(dotted(checkout))).toBe(outside.repoPath);
      fs.writeFileSync(markerFile, record);
      const gitDirectories: string[] = [];
      const spawn = childProcess.spawn;
      const spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(((command: string, args: string[], options: { cwd?: string }) => {
        // Where Git actually runs, not the lexical form of its working directory.
        gitDirectories.push(physical(String(options?.cwd)));
        return (spawn as (...values: unknown[]) => unknown)(command, args, options);
      }) as unknown as typeof childProcess.spawn);
      let listed: PendingWorktreeOperation[];
      let refused: WorktreeRecoveryRefusedError;
      try {
        listed = await fx.recovery.list();
        refused = await refusal(fx.recovery.recover(recoveryRequest(listed[0]!)));
        await expect(fx.service.cleanup('dotted')).rejects.toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
      } finally {
        spawnSpy.mockRestore();
        fs.unlinkSync(hop);
      }
      expect(listed).toEqual([expect.objectContaining({ operationId: 'dotted', observed: { workspace: null, repositories: [] }, recovery: { available: false, reason: expect.any(String) } })]);
      expect(refused.reason).toBe('resource_untrusted');
      expect(gitDirectories).toContain(fx.repoPath);
      expect(gitDirectories.filter((directory) => directory.startsWith(outside.repoPath))).toEqual([]);
      expect(fs.readFileSync(markerFile, 'utf8')).toBe(record);
    }
    fs.unlinkSync(markerFile);
    expect((await fx.service.cleanup('dotted', true)).cleanup.outcome).toBe('complete');
  });

  it('refuses recovery when a guarded checkout is replaced by one of another repository while recovery waits', async () => {
    const baseDir = tempDir('hive-recovery-swap-');
    const hiveDir = path.join(baseDir, '.hive');
    const api = await createRepo('hive-recovery-swap-api-');
    const recovery = new WorktreeOperationRecoveryService({ baseDir, hiveDir, repositoryResolver: () => [{ id: 'api', path: api.repoPath, root: api.repoPath }] });
    await withWorktreeMutation({
      hiveDir,
      workspacePath: path.join(hiveDir, '.worktrees', 'adhoc', 'swap'),
      select: async () => ({ repositoryPaths: [api.repoPath] }),
      commonDirectory: (repositoryPath) => trustedGitCommonDirectory(repositoryPath),
      trustedRepositoryPaths: () => [api.repoPath],
      kind: 'merge',
      subject: { type: 'adhoc', runId: 'swap' },
    }, async (_selection, guard) => {
      await guard.begin();
      throw new Error('host stopped');
    }).catch(() => undefined);
    const [pending] = await recovery.list();
    const markersBefore = markerFiles(hiveDir).map((name) => fs.readFileSync(path.join(hiveDir, '.locks', 'operations', name), 'utf8'));

    // The same path, branch and commit, now a linked worktree of a clone with its own Git common directory.
    const clone = path.join(tempDir('hive-recovery-swap-clone-'), 'clone');
    await simpleGit().raw(['clone', '--quiet', api.repoPath, clone]);
    await simpleGit(clone).raw(['checkout', '--quiet', '--detach']);
    const replaceCheckout = async () => {
      fs.renameSync(api.repoPath, path.join(tempDir('hive-recovery-swap-original-'), 'api'));
      await simpleGit(clone).raw(['worktree', 'add', '--quiet', api.repoPath, 'main']);
    };
    const prototype = WorktreeOperationRecoveryService.prototype as unknown as { validatedResources: (...args: unknown[]) => Promise<unknown> };
    const validate = prototype.validatedResources;
    // Replace the checkout after the pre-lock validation, the window in which recovery waits for its locks.
    const spy = spyOn(prototype, 'validatedResources').mockImplementationOnce(async function (this: unknown, ...args: unknown[]) {
      const resources = await validate.apply(this, args);
      await replaceCheckout();
      return resources;
    });
    let refused: WorktreeRecoveryRefusedError;
    try {
      refused = await refusal(recovery.recover(recoveryRequest(pending!)));
    } finally {
      spy.mockRestore();
    }
    expect(await trustedGitCommonDirectory(api.repoPath)).toBe(fs.realpathSync(path.join(clone, '.git')));
    expect(refused.reason).toBe('resource_untrusted');
    // Nothing the operator inspected changed except the repository identity, and the records stay in place.
    expect((await recovery.list())[0]!.observedStateDigest).toBe(pending!.observedStateDigest);
    expect(markerFiles(hiveDir).map((name) => fs.readFileSync(path.join(hiveDir, '.locks', 'operations', name), 'utf8'))).toEqual(markersBefore);
  });
});

describe('worktree operation finalization', () => {
  function scope(repoPath: string, workspace: string) {
    return {
      hiveDir: path.join(repoPath, '.hive'),
      workspacePath: path.join(repoPath, '.hive', '.worktrees', 'adhoc', workspace),
      select: async () => ({ repositoryPaths: [repoPath] }),
      commonDirectory: (repositoryPath: string) => trustedGitCommonDirectory(repositoryPath),
      trustedRepositoryPaths: () => [repoPath],
      kind: 'merge' as const,
      subject: { type: 'adhoc' as const, runId: workspace },
    };
  }

  it('keeps a result and a thrown failure from before any mutation in their own classification when lock release fails', async () => {
    const { repoPath } = await createRepo();
    const refusedBeforeMutation = { success: false, reasonCode: 'TARGET_DIRTY', mutation: 'none' as const, retryable: true };
    const preflightError = new Error('preflight rejected the workspace');
    const restore = failLockReleases();
    let returned: unknown;
    let thrown: unknown;
    try {
      returned = await withWorktreeMutation(scope(repoPath, 'preflight'), async () => refusedBeforeMutation).catch((error) => error);
      thrown = await withWorktreeMutation(scope(repoPath, 'preflight'), async () => { throw preflightError; }).catch((error) => error);
    } finally {
      restore();
    }
    expect(returned).toBeInstanceOf(WorktreeOperationFinalizationError);
    const finalized = returned as WorktreeOperationFinalizationError<typeof refusedBeforeMutation>;
    expect(finalized.result).toBe(refusedBeforeMutation);
    expect(finalized.finalization).toEqual({ markers: 'not_published', lockReleaseError: 'lock close failed', action: 'inspect_state' });
    expect(withFinalizationFailure(finalized.result, finalized.finalization)).toMatchObject({ reasonCode: 'TARGET_DIRTY', mutation: 'none', retryable: true });
    expect(thrown).toBe(preflightError);
    expect(markerFiles(path.join(repoPath, '.hive'))).toEqual([]);
  });

  it('keeps an unknown result, including per-repository unknown, with its retained markers when lock release fails', async () => {
    const { repoPath } = await createRepo();
    const unknown = { success: false, mutation: 'applied' as const, retryable: false, repos: { api: { mutation: 'unknown' as const } } };
    const restore = failLockReleases();
    let failure: unknown;
    try {
      failure = await withWorktreeMutation(scope(repoPath, 'unknown'), async (_selection, guard) => {
        await guard.begin();
        return unknown;
      }, isMutationOutcomeKnown).catch((error) => error);
    } finally {
      restore();
    }
    expect(failure).toBeInstanceOf(WorktreeOperationFinalizationError);
    const finalized = failure as WorktreeOperationFinalizationError<typeof unknown>;
    expect(finalized.result).toBe(unknown);
    const retainedMarkers = markerFiles(path.join(repoPath, '.hive')).map((name) => path.join(repoPath, '.hive', '.locks', 'operations', name));
    expect(retainedMarkers).toHaveLength(2);
    expect(finalized.finalization).toEqual({ operationId: expect.any(String), markers: 'retained', retainedMarkers, lockReleaseError: 'lock close failed', action: 'manual_recovery' });
  });

  it('returns a finished merge and its same-call cleanup when releasing its locks fails', async () => {
    const fx = await createFixture();
    await fx.service.create({ runId: 'release' });
    await commitInRun(fx.service, 'release', 'release.txt');
    const run = (await fx.service.get('release'))!;
    const restore = failLockReleases();
    let result: Awaited<ReturnType<AdhocWorktreeService['merge']>>;
    try {
      result = await fx.service.merge('release', 'squash', mergeMessage, {
        historyIntent: 'rewrite-private',
        cleanup: 'worktree+branch',
        expectedTarget: await readWorktreeTargetIdentity(fx.repoPath),
      });
    } finally {
      restore();
    }
    const head = (await fx.git.revparse(['HEAD'])).trim();
    expect(result).toMatchObject({
      success: true,
      merged: true,
      sha: head,
      mutation: 'applied',
      retryable: false,
      cleanup: { outcome: 'complete', worktreeRemoved: true, branchDeleted: true },
      finalization: { markers: 'cleared', lockReleaseError: 'lock close failed', action: 'inspect_state' },
    });
    expect(result.finalization!.operationId).toBeUndefined();
    expect(fs.existsSync(run.path)).toBe(false);
    expect(markerFiles(fx.hiveDir)).toEqual([]);
    // The descriptors were closed, so the next operation on the repository acquires its locks.
    expect((await fx.service.create({ runId: 'after-release' })).runId).toBe('after-release');
  });

  it('returns a finished merge and its same-call cleanup when its markers cannot be cleared, and keeps later mutations refused', async () => {
    const fx = await createFixture();
    await fx.service.create({ runId: 'markers' });
    await commitInRun(fx.service, 'markers', 'markers.txt');
    const restore = failMarkerClearing();
    let result: Awaited<ReturnType<AdhocWorktreeService['merge']>>;
    try {
      result = await fx.service.merge('markers', 'squash', mergeMessage, {
        historyIntent: 'rewrite-private',
        cleanup: 'worktree+branch',
        expectedTarget: await readWorktreeTargetIdentity(fx.repoPath),
      });
    } finally {
      restore();
    }
    expect(result).toMatchObject({
      success: true,
      merged: true,
      sha: (await fx.git.revparse(['HEAD'])).trim(),
      mutation: 'applied',
      retryable: false,
      cleanup: { outcome: 'complete' },
      finalization: { markers: 'retained', action: 'manual_recovery' },
    });
    expect(result.finalization!.markerError).toContain('marker unlink failed');
    expect(result.finalization!.lockReleaseError).toBeUndefined();
    expect(markerFiles(fx.hiveDir)).toHaveLength(2);

    await expect(fx.service.create({ runId: 'next' })).rejects.toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    const [entry] = await fx.recovery.list();
    expect(entry!.operationId).toBe(result.finalization!.operationId!);
    expect(entry!.recovery).toEqual({ available: true });
    await fx.recovery.recover(recoveryRequest(entry!));
    expect((await fx.service.create({ runId: 'next' })).runId).toBe('next');
  });

  // Windows has no directory flush to fail: syncDirectory returns without opening the directory.
  it.skipIf(process.platform === 'win32')('reports markers it removed but could not flush without naming an operation to acknowledge, and leaves later mutations unguarded', async () => {
    const { repoPath } = await createRepo();
    const hiveDir = path.join(repoPath, '.hive');
    const recovery = new WorktreeOperationRecoveryService({ baseDir: repoPath, hiveDir });
    const rollback = new Error('verified rollback');
    let begun = false;
    const restore = failMarkerDirectoryFlush(hiveDir, () => begun);
    let returned: unknown;
    let thrown: unknown;
    try {
      returned = await withWorktreeMutation(scope(repoPath, 'flush'), async (_selection, guard) => {
        await guard.begin();
        begun = true;
        return { mutation: 'applied' as const };
      }).catch((error) => error);
      begun = false;
      thrown = await withWorktreeMutation(scope(repoPath, 'flush'), async (_selection, guard) => {
        await guard.begin();
        begun = true;
        guard.markOutcomeKnown();
        throw rollback;
      }).catch((error) => error);
    } finally {
      restore();
    }
    expect(returned).toBeInstanceOf(WorktreeOperationFinalizationError);
    const finalized = returned as WorktreeOperationFinalizationError<{ mutation: 'applied' }>;
    expect(finalized.result).toEqual({ mutation: 'applied' });
    expect(finalized.finalization).toEqual({
      operationId: expect.any(String),
      markers: 'cleared_unflushed',
      markerError: expect.stringContaining('marker directory flush failed'),
      action: 'inspect_state',
    });
    expect(finalized.message).not.toMatch(/acknowledg|stay refused/);
    // No guard remains, so a failure thrown after a verified outcome keeps its own classification.
    expect(thrown).toBe(rollback);
    expect(markerFiles(hiveDir)).toEqual([]);
    expect(await recovery.list()).toEqual([]);
    expect(await withWorktreeMutation(scope(repoPath, 'flush'), async (_selection, guard) => {
      await guard.begin();
      return 'next';
    })).toBe('next');
  });

  it('names exactly the markers that remain when only some can be removed, and recovers them', async () => {
    const { repoPath } = await createRepo();
    const hiveDir = path.join(repoPath, '.hive');
    const recovery = new WorktreeOperationRecoveryService({ baseDir: repoPath, hiveDir });
    let restore = failWorkspaceMarkerClearing();
    let returned: unknown;
    try {
      returned = await withWorktreeMutation(scope(repoPath, 'partial'), async (_selection, guard) => {
        await guard.begin();
        return { mutation: 'applied' as const };
      }).catch((error) => error);
    } finally {
      restore();
    }
    expect(returned).toBeInstanceOf(WorktreeOperationFinalizationError);
    const finalized = returned as WorktreeOperationFinalizationError<{ mutation: 'applied' }>;
    const remaining = markerFiles(hiveDir).map((name) => path.join(hiveDir, '.locks', 'operations', name));
    expect(remaining).toEqual([expect.stringContaining(`${path.sep}workspace-`)]);
    expect(finalized.result).toEqual({ mutation: 'applied' });
    expect(finalized.finalization).toEqual({
      operationId: expect.any(String),
      markers: 'retained',
      retainedMarkers: remaining,
      markerError: expect.stringContaining('marker unlink failed'),
      action: 'manual_recovery',
    });
    const operationId = finalized.finalization.operationId!;

    // The remaining workspace marker still guards its workspace; the repository marker is gone.
    let ran = false;
    const refused = await withWorktreeMutation(scope(repoPath, 'partial'), async () => { ran = true; }).catch((error) => error);
    expect(refused).toMatchObject({ reasonCode: 'OPERATION_RECOVERY_REQUIRED', mutation: 'none', operationIds: [operationId] });
    expect(ran).toBe(false);
    const [entry] = await recovery.list();
    expect(entry).toMatchObject({ operationId, markerPaths: remaining, recovery: { available: true } });
    await recovery.recover(recoveryRequest(entry!));
    expect(markerFiles(hiveDir)).toEqual([]);

    // A failure thrown after a verified outcome names the marker it could not remove.
    restore = failWorkspaceMarkerClearing();
    let thrown: unknown;
    try {
      thrown = await withWorktreeMutation(scope(repoPath, 'partial-thrown'), async (_selection, guard) => {
        await guard.begin();
        guard.markOutcomeKnown();
        throw new Error('verified rollback');
      }).catch((error) => error);
    } finally {
      restore();
    }
    const retained = markerFiles(hiveDir).map((name) => path.join(hiveDir, '.locks', 'operations', name));
    expect(retained).toHaveLength(1);
    expect(thrown).toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    expect((thrown as Error).message).toContain(retained[0]!);
  });

  it('withdraws markers whose directory flush fails with the publication failure itself, and names a marker it cannot withdraw', async () => {
    const { repoPath } = await createRepo();
    const hiveDir = path.join(repoPath, '.hive');
    const failSecondRename = () => {
      const originalRename = fs.renameSync;
      let renames = 0;
      const spy = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
        if (String(to).includes(`${path.sep}operations${path.sep}`) && ++renames === 2) {
          throw Object.assign(new Error('marker publication failed'), { code: 'EIO' });
        }
        return originalRename(from, to);
      }) as typeof fs.renameSync);
      return () => spy.mockRestore();
    };
    let mutated = false;
    const publish = (workspace: string) => withWorktreeMutation(scope(repoPath, workspace), async (_selection, guard) => {
      await guard.begin();
      mutated = true;
    }).catch((error) => error);

    const restoreRename = failSecondRename();
    const restoreFlush = failMarkerDirectoryFlush(hiveDir);
    let unflushed: unknown;
    try {
      unflushed = await publish('withdrawn');
    } finally {
      restoreFlush();
      restoreRename();
    }
    // The first marker was withdrawn; only the flush of its removal failed, so no operation needs acknowledging.
    expect(unflushed).not.toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    expect((unflushed as Error).message).toBe('marker publication failed');
    expect(markerFiles(hiveDir)).toEqual([]);

    const restoreSecondRename = failSecondRename();
    const restoreUnlink = failMarkerClearing();
    let stuck: unknown;
    try {
      stuck = await publish('stuck');
    } finally {
      restoreUnlink();
      restoreSecondRename();
    }
    const remaining = markerFiles(hiveDir).map((name) => path.join(hiveDir, '.locks', 'operations', name));
    expect(remaining).toHaveLength(1);
    expect(stuck).toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    expect(stuck).toMatchObject({ mutation: 'none', operationIds: [expect.any(String)] });
    expect((stuck as Error).message).toContain(remaining[0]!);
    expect(mutated).toBe(false);
    const [entry] = await new WorktreeOperationRecoveryService({ baseDir: repoPath, hiveDir }).list();
    expect(entry).toMatchObject({ operationId: (stuck as WorktreeOperationRecoveryRequiredError).operationIds[0], markerPaths: remaining });
  });
});
