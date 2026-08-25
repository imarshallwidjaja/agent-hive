import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ReviewEvidenceBundleService,
  type ReviewEvidenceBundleCaller,
  type ReviewEvidenceBundleConfig,
  type ReviewEvidenceBundleItemInput,
} from './reviewEvidenceBundleService.js';

const tempDirs: string[] = [];
const resolutionFingerprint = 'a'.repeat(64);
const creator: ReviewEvidenceBundleCaller = {
  workflow: 'dash-review',
  role: 'creator',
  agent: '__hive_dash_review_scope',
  sessionId: 'dash-review-scope-session',
  pid: process.pid,
};

function primary(
  sessionId = 'dash-review-primary-session',
  pid = process.pid,
): ReviewEvidenceBundleCaller {
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

async function createProject(name: string): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), `hive-review-evidence-${name}-`));
  tempDirs.push(projectRoot);
  return projectRoot;
}

function createService(
  projectRoot: string,
  overrides: Partial<ReviewEvidenceBundleConfig> = {},
): ReviewEvidenceBundleService {
  return new ReviewEvidenceBundleService({ projectRoot, ...overrides });
}

function workspacePath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.hive', '.worktrees', 'review-evidence', runId);
}

function metadataPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.hive', '.worktrees', 'review-evidence', '.runs', `${runId}.json`);
}

function lockPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.hive', '.worktrees', 'review-evidence', '.locks', `${runId}.lock`);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function writeArtifact(projectRoot: string, relativePath: string, bytes: string | Uint8Array): Promise<void> {
  const artifactPath = path.join(projectRoot, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, bytes);
}

async function createAndClaimArtifact(
  service: ReviewEvidenceBundleService,
  runId: string,
  sourcePath: string,
  owner = primary(),
) {
  const bundle = await service.create({
    runId,
    caller: creator,
    resolutionFingerprint,
    items: [{ kind: 'artifact', sourcePath }],
  });
  await service.claim(runId, bundle.ownershipToken, owner);
  return { bundle, owner };
}

describe('ReviewEvidenceBundleService', () => {
  it('materializes inline operator intent without persisting its bytes or ownership token in audit state', async () => {
    const projectRoot = await createProject('inline');
    const service = createService(projectRoot);
    const inlineBytes = Buffer.from('operator-only review instructions\n', 'utf8');
    const bundle = await service.create({
      runId: 'evidence-inline',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: inlineBytes }],
    });

    expect((await fs.readdir(bundle.workspacePath)).sort()).toEqual(['evidence', 'manifest.json']);
    expect(await fs.readdir(path.join(bundle.workspacePath, 'evidence'))).toEqual(['operator-intent.txt']);
    expect(await fs.readFile(path.join(bundle.workspacePath, 'evidence', 'operator-intent.txt'))).toEqual(inlineBytes);

    const manifestText = await fs.readFile(path.join(bundle.workspacePath, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    expect(manifest.kind).toBe('inline');
    expect(manifest.items).toEqual([
      expect.objectContaining({
        kind: 'inline',
        materializedPath: 'evidence/operator-intent.txt',
        byteLength: inlineBytes.byteLength,
      }),
    ]);
    expect(manifest.resolutionFingerprint).toBe(resolutionFingerprint);
    expect(manifestText).not.toContain(projectRoot);
    expect(manifestText).not.toContain(bundle.ownershipToken);

    const metadataText = await fs.readFile(metadataPath(projectRoot, bundle.runId), 'utf8');
    expect(JSON.parse(metadataText).kind).toBe('inline');
    expect(metadataText).not.toContain(inlineBytes.toString('utf8').trim());
    expect(metadataText).not.toContain(bundle.ownershipToken);

    const owner = primary();
    await service.claim(bundle.runId, bundle.ownershipToken, owner);
    await expect(service.inspect(bundle.runId, bundle.ownershipToken, owner)).resolves.toMatchObject({
      runId: bundle.runId,
      workspacePath: bundle.workspacePath,
      integrity: { bundleClean: true, sourcesClean: true },
    });

    await expect(service.cleanupExisting(bundle.runId, bundle.ownershipToken, owner)).resolves.toEqual({
      runId: bundle.runId,
      workspacePath: bundle.workspacePath,
      cleaned: true,
    });
    expect(await pathExists(bundle.workspacePath)).toBe(false);
    expect(await pathExists(metadataPath(projectRoot, bundle.runId))).toBe(false);
    await expect(service.cleanupExisting(bundle.runId, bundle.ownershipToken, owner)).rejects.toThrow('not found');
    await expect(service.cleanup(bundle.runId, bundle.ownershipToken, owner)).resolves.toEqual({
      runId: bundle.runId,
      workspacePath: bundle.workspacePath,
      cleaned: true,
    });
  });

  it('canonically sorts and deduplicates one artifact bundle while preserving safe binary extensions', async () => {
    const projectRoot = await createProject('canonical');
    await writeArtifact(projectRoot, 'reports/result.bin', Buffer.from([0, 255, 1, 128]));
    await writeArtifact(projectRoot, 'notes/review.txt', 'review notes\n');
    const service = createService(projectRoot);
    const binary = { kind: 'artifact' as const, sourcePath: 'reports/result.bin' };
    const notes = { kind: 'artifact' as const, sourcePath: 'notes/review.txt' };

    const first = await service.create({
      runId: 'evidence-canonical-a',
      caller: creator,
      resolutionFingerprint,
      items: [binary, notes, binary],
    });
    const second = await service.create({
      runId: 'evidence-canonical-b',
      caller: creator,
      resolutionFingerprint,
      items: [notes, binary],
    });

    expect(first.scopeFingerprint).toBe(second.scopeFingerprint);
    expect(first.sourceFingerprint).toBe(second.sourceFingerprint);
    expect(first.materializationFingerprint).toBe(second.materializationFingerprint);
    expect(first.items).toHaveLength(2);
    expect(first.items.map((item) => item.kind === 'artifact' ? item.sourcePath : 'operator-intent.txt')).toEqual([
      'notes/review.txt',
      'reports/result.bin',
    ]);
    expect(JSON.parse(await fs.readFile(path.join(first.workspacePath, 'manifest.json'), 'utf8')).kind)
      .toBe('local-artifacts');
    expect(JSON.parse(await fs.readFile(metadataPath(projectRoot, first.runId), 'utf8')).kind)
      .toBe('local-artifacts');
    const binaryItem = first.items.find((item) => item.kind === 'artifact' && item.sourcePath === binary.sourcePath)!;
    expect(binaryItem.materializedPath).toMatch(/^evidence\/artifact-[a-f0-9]+\.bin$/);
    expect(await fs.readFile(path.join(first.workspacePath, binaryItem.materializedPath))).toEqual(Buffer.from([0, 255, 1, 128]));

    await service.cleanupExisting(first.runId, first.ownershipToken, creator);
    await service.cleanupExisting(second.runId, second.ownershipToken, creator);
  });

  it('rejects mixed bundles and multiple inline items at the service boundary', async () => {
    const projectRoot = await createProject('single-kind');
    await writeArtifact(projectRoot, 'report.md', 'report\n');
    const service = createService(projectRoot);

    await expect(service.create({
      runId: 'evidence-mixed-kind',
      caller: creator,
      resolutionFingerprint,
      items: [
        { kind: 'inline', bytes: Buffer.from('intent') },
        { kind: 'artifact', sourcePath: 'report.md' },
      ],
    })).rejects.toThrow('exactly one evidence kind');
    await expect(service.create({
      runId: 'evidence-multiple-inline',
      caller: creator,
      resolutionFingerprint,
      items: [
        { kind: 'inline', bytes: Buffer.from('first') },
        { kind: 'inline', bytes: Buffer.from('second') },
      ],
    })).rejects.toThrow('exactly one inline item');
    expect(await service.ownsRun('evidence-single-kind-not-created')).toBe(false);
  });

  it('captures stable artifact descriptors without materializing or publishing a run', async () => {
    const projectRoot = await createProject('capture');
    await writeArtifact(projectRoot, 'reports/result.bin', Buffer.from([0, 255, 1, 128]));
    await writeArtifact(projectRoot, 'notes/review.txt', 'review notes\n');
    const service = createService(projectRoot);

    const captured = await service.captureArtifacts([
      'reports/result.bin',
      'notes/review.txt',
      'reports/result.bin',
    ]);

    expect(captured).toEqual([
      {
        sourcePath: 'notes/review.txt',
        byteLength: Buffer.byteLength('review notes\n'),
        digest: createHash('sha256').update('review notes\n').digest('hex'),
      },
      {
        sourcePath: 'reports/result.bin',
        byteLength: 4,
        digest: createHash('sha256').update(Buffer.from([0, 255, 1, 128])).digest('hex'),
      },
    ]);
    expect(await pathExists(path.join(projectRoot, '.hive', '.worktrees', 'review-evidence'))).toBe(false);
    expect(await service.ownsRun('evidence-not-created')).toBe(false);
  });

  it('reports persisted run ownership before and after cleanup', async () => {
    const projectRoot = await createProject('ownership');
    const service = createService(projectRoot);
    const bundle = await service.create({
      runId: 'evidence-owned',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('intent\n') }],
    });

    expect(await service.ownsRun(bundle.runId)).toBe(true);
    await service.cleanupExisting(bundle.runId, bundle.ownershipToken, creator);
    expect(await service.ownsRun(bundle.runId)).toBe(false);
  });

  it('cleans only bundles owned or created by the deleted session', async () => {
    const projectRoot = await createProject('session-cleanup');
    const service = createService(projectRoot);
    const claimed = await service.create({
      runId: 'evidence-session-claimed',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('claimed') }],
    });
    const owner = primary('deleted-primary');
    await service.claim(claimed.runId, claimed.ownershipToken, owner);
    const unclaimed = await service.create({
      runId: 'evidence-session-unclaimed',
      caller: { ...creator, sessionId: 'deleted-creator' },
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('unclaimed') }],
    });

    expect(await service.cleanupOwnedBySession('other-session')).toEqual([]);
    expect(await service.cleanupOwnedBySession(owner.sessionId)).toEqual([{
      runId: claimed.runId,
      workspacePath: claimed.workspacePath,
      cleaned: true,
    }]);
    expect(await service.cleanupOwnedBySession('deleted-creator')).toEqual([{
      runId: unclaimed.runId,
      workspacePath: unclaimed.workspacePath,
      cleaned: true,
    }]);
  });

  it('enforces artifact count, per-file byte, and aggregate byte limits', async () => {
    const projectRoot = await createProject('limits');
    const service = createService(projectRoot);
    const tooMany: ReviewEvidenceBundleItemInput[] = [];
    for (let index = 0; index < 33; index += 1) {
      const sourcePath = `many/${String(index).padStart(2, '0')}.txt`;
      await writeArtifact(projectRoot, sourcePath, 'x');
      tooMany.push({ kind: 'artifact', sourcePath });
    }
    await expect(service.create({ runId: 'evidence-too-many', caller: creator, resolutionFingerprint, items: tooMany })).rejects.toThrow('32');

    await writeArtifact(projectRoot, 'large/one.bin', '');
    await fs.truncate(path.join(projectRoot, 'large', 'one.bin'), (16 * 1024 * 1024) + 1);
    await expect(service.create({
      runId: 'evidence-file-too-large',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'artifact', sourcePath: 'large/one.bin' }],
    })).rejects.toThrow('16 MiB');

    const aggregateItems: ReviewEvidenceBundleItemInput[] = [];
    for (const name of ['a.bin', 'b.bin', 'c.bin']) {
      await writeArtifact(projectRoot, `aggregate/${name}`, '');
      await fs.truncate(path.join(projectRoot, 'aggregate', name), 11 * 1024 * 1024);
      aggregateItems.push({ kind: 'artifact', sourcePath: `aggregate/${name}` });
    }
    await expect(service.create({
      runId: 'evidence-total-too-large',
      caller: creator,
      resolutionFingerprint,
      items: aggregateItems,
    })).rejects.toThrow('32 MiB');
    expect(await pathExists(workspacePath(projectRoot, 'evidence-total-too-large'))).toBe(false);
    expect(await pathExists(metadataPath(projectRoot, 'evidence-total-too-large'))).toBe(false);
  });

  it('rejects empty, absolute, traversing, non-canonical, and private runtime artifact selectors', async () => {
    const projectRoot = await createProject('selectors');
    await writeArtifact(projectRoot, 'allowed.txt', 'allowed\n');
    await writeArtifact(projectRoot, '.git/config', 'private git data\n');
    await writeArtifact(projectRoot, '.hive/private.json', 'private hive data\n');
    const service = createService(projectRoot);
    const rejected = [
      '',
      '/etc/passwd',
      '../outside.txt',
      'nested/../../outside.txt',
      './allowed.txt',
      'nested//file.txt',
      '.git/config',
      '.hive/private.json',
    ];

    for (const [index, sourcePath] of rejected.entries()) {
      await expect(service.create({
        runId: `evidence-rejected-path-${index}`,
        caller: creator,
        resolutionFingerprint,
        items: [{ kind: 'artifact', sourcePath }],
      })).rejects.toThrow();
    }
  });

  it('rejects directories and symlinks at the file or parent-component boundary', async () => {
    const projectRoot = await createProject('symlinks');
    await writeArtifact(projectRoot, 'real/file.txt', 'real\n');
    await fs.symlink(path.join(projectRoot, 'real', 'file.txt'), path.join(projectRoot, 'file-link.txt'));
    await fs.symlink(path.join(projectRoot, 'real'), path.join(projectRoot, 'directory-link'));
    const service = createService(projectRoot);

    await expect(service.create({
      runId: 'evidence-directory',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'artifact', sourcePath: 'real' }],
    })).rejects.toThrow('regular file');
    await expect(service.create({
      runId: 'evidence-file-symlink',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'artifact', sourcePath: 'file-link.txt' }],
    })).rejects.toThrow('symbolic link');
    await expect(service.create({
      runId: 'evidence-component-symlink',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'artifact', sourcePath: 'directory-link/file.txt' }],
    })).rejects.toThrow('symbolic link');
  });

  it('rejects a project artifact hard-linked to an outside secret', async () => {
    const projectRoot = await createProject('outside-hardlink');
    const outside = await createProject('outside-hardlink-secret');
    await fs.writeFile(path.join(outside, 'secret.md'), 'outside secret\n');
    await fs.link(path.join(outside, 'secret.md'), path.join(projectRoot, 'secret.md'));
    const service = createService(projectRoot);

    await expect(service.create({
      runId: 'evidence-outside-hardlink',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'artifact', sourcePath: 'secret.md' }],
    })).rejects.toThrow('multiple hard links');
  });

  it('rejects link-count mutation during capture and live-source revalidation', async () => {
    const projectRoot = await createProject('hardlink-mutation');
    const outside = await createProject('hardlink-mutation-outside');
    await writeArtifact(projectRoot, 'moving.bin', Buffer.alloc(256 * 1024, 7));
    let linked = false;
    const mutatingService = createService(projectRoot, {
      onArtifactCopyProgress: async () => {
        if (linked) return;
        linked = true;
        await fs.link(path.join(projectRoot, 'moving.bin'), path.join(outside, 'moving.bin'));
      },
    });

    await expect(mutatingService.create({
      runId: 'evidence-hardlink-during-copy',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'artifact', sourcePath: 'moving.bin' }],
    })).rejects.toThrow('multiple hard links');

    await fs.rm(path.join(outside, 'moving.bin'));
    const stableService = createService(projectRoot);
    const { bundle, owner } = await createAndClaimArtifact(
      stableService,
      'evidence-hardlink-revalidation',
      'moving.bin',
    );
    await fs.link(path.join(projectRoot, 'moving.bin'), path.join(outside, 'moving.bin'));
    await expect(stableService.inspect(bundle.runId, bundle.ownershipToken, owner))
      .rejects.toThrow('multiple hard links');
    await fs.rm(path.join(outside, 'moving.bin'));
    await stableService.cleanupExisting(bundle.runId, bundle.ownershipToken, owner);
  });

  it('fails closed when a private metadata component is replaced by a symlink', async () => {
    const projectRoot = await createProject('private-state-symlink');
    const service = createService(projectRoot);
    const bundle = await service.create({
      runId: 'evidence-private-state-symlink',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('intent') }],
    });
    const privateRoot = path.join(projectRoot, '.hive', '.worktrees', 'review-evidence');
    const redirectedRuns = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-review-evidence-runs-'));
    tempDirs.push(redirectedRuns);
    await fs.rename(path.join(privateRoot, '.runs'), path.join(redirectedRuns, '.runs'));
    await fs.symlink(path.join(redirectedRuns, '.runs'), path.join(privateRoot, '.runs'));

    await expect(service.claim(bundle.runId, bundle.ownershipToken, primary())).rejects.toThrow('private');
  });

  it('fails closed and rolls back when an artifact drifts while its descriptor is being copied', async () => {
    const projectRoot = await createProject('copy-drift');
    await writeArtifact(projectRoot, 'moving.bin', Buffer.alloc(256 * 1024, 7));
    let changed = false;
    const service = createService(projectRoot, {
      onArtifactCopyProgress: async (sourcePath) => {
        if (!changed) {
          changed = true;
          await fs.appendFile(path.join(projectRoot, sourcePath), Buffer.from([9]));
        }
      },
    });

    await expect(service.create({
      runId: 'evidence-copy-drift',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'artifact', sourcePath: 'moving.bin' }],
    })).rejects.toThrow('changed while being captured');
    expect(await pathExists(workspacePath(projectRoot, 'evidence-copy-drift'))).toBe(false);
    expect(await pathExists(metadataPath(projectRoot, 'evidence-copy-drift'))).toBe(false);
  });

  it('rejects live source drift during inspection while inline evidence remains frozen', async () => {
    const projectRoot = await createProject('live-drift');
    await writeArtifact(projectRoot, 'source.txt', 'before\n');
    const service = createService(projectRoot);
    const { bundle, owner } = await createAndClaimArtifact(service, 'evidence-live-drift', 'source.txt');
    await fs.writeFile(path.join(projectRoot, 'source.txt'), 'after\n');

    await expect(service.inspect(bundle.runId, bundle.ownershipToken, owner)).rejects.toThrow('live source drift');
    await service.cleanupExisting(bundle.runId, bundle.ownershipToken, owner);

    const inline = await service.create({
      runId: 'evidence-inline-frozen',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('no live source\n') }],
    });
    await service.claim(inline.runId, inline.ownershipToken, owner);
    await expect(service.inspect(inline.runId, inline.ownershipToken, owner)).resolves.toMatchObject({
      integrity: { sourcesClean: true },
    });
    await service.cleanupExisting(inline.runId, inline.ownershipToken, owner);
  });

  it('rejects modified, extra, and deleted files in the frozen bundle', async () => {
    const projectRoot = await createProject('bundle-drift');
    await writeArtifact(projectRoot, 'source.txt', 'source\n');
    const service = createService(projectRoot);
    const cases = ['modified', 'extra', 'deleted'] as const;

    for (const drift of cases) {
      const { bundle, owner } = await createAndClaimArtifact(service, `evidence-bundle-${drift}`, 'source.txt');
      const artifact = bundle.items.find((item) => item.kind === 'artifact')!;
      const artifactPath = path.join(bundle.workspacePath, artifact.materializedPath);
      if (drift === 'modified') await fs.writeFile(artifactPath, 'mutated\n');
      if (drift === 'extra') await fs.writeFile(path.join(bundle.workspacePath, 'evidence', 'extra.txt'), 'extra\n');
      if (drift === 'deleted') await fs.rm(artifactPath);

      await expect(service.inspect(bundle.runId, bundle.ownershipToken, owner)).rejects.toThrow('bundle integrity');
      await service.cleanupExisting(bundle.runId, bundle.ownershipToken, owner);
    }
  });

  it('rejects persisted bundle metadata whose explicit kind conflicts with its manifest', async () => {
    const projectRoot = await createProject('kind-metadata');
    const service = createService(projectRoot);
    const bundle = await service.create({
      runId: 'evidence-kind-metadata',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('intent') }],
    });
    const persistedPath = metadataPath(projectRoot, bundle.runId);
    const persisted = JSON.parse(await fs.readFile(persistedPath, 'utf8'));
    persisted.kind = 'local-artifacts';
    await fs.writeFile(persistedPath, JSON.stringify(persisted));

    await expect(service.recoverAuthorization(bundle.runId, bundle.ownershipToken, 'dash-review'))
      .rejects.toThrow('Invalid review evidence metadata');
    await expect(service.claim(bundle.runId, bundle.ownershipToken, primary()))
      .rejects.toThrow('Invalid review evidence metadata');

    const inspectable = await service.create({
      runId: 'evidence-kind-inspection',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('intent') }],
    });
    const owner = primary('kind-inspection-owner');
    await service.claim(inspectable.runId, inspectable.ownershipToken, owner);
    const inspectablePath = metadataPath(projectRoot, inspectable.runId);
    const inspectableMetadata = JSON.parse(await fs.readFile(inspectablePath, 'utf8'));
    inspectableMetadata.kind = 'local-artifacts';
    await fs.writeFile(inspectablePath, JSON.stringify(inspectableMetadata));
    await expect(service.inspect(inspectable.runId, inspectable.ownershipToken, owner))
      .rejects.toThrow('Invalid review evidence metadata');
  });

  it('denies wrong tokens, caller capabilities, workflows, and competing owners', async () => {
    const projectRoot = await createProject('authorization');
    const service = createService(projectRoot);
    const bundle = await service.create({
      runId: 'evidence-authorization',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('intent') }],
    });
    const owner = primary('authorized-owner', 4242);

    await expect(service.claim(bundle.runId, 'wrong-token', owner)).rejects.toThrow('ownership token');
    await expect(service.claim(bundle.runId, bundle.ownershipToken, creator)).rejects.toThrow('primary');
    await expect(service.claim(bundle.runId, bundle.ownershipToken, {
      ...owner,
      workflow: 'vulnerability-review' as any,
    })).rejects.toThrow('workflow');
    await service.claim(bundle.runId, bundle.ownershipToken, owner);
    await expect(service.inspect(bundle.runId, bundle.ownershipToken, primary('wrong-session', 4343))).rejects.toThrow('owner capability');
    await expect(service.inspect(bundle.runId, 'wrong-token', owner)).rejects.toThrow('ownership token');
    await expect(service.recoverAuthorization(bundle.runId, bundle.ownershipToken, 'vulnerability-review' as any)).rejects.toThrow('workflow');
    await expect(service.claim(bundle.runId, bundle.ownershipToken, primary('competing-owner', 4343))).rejects.toThrow('another owner');
    await service.cleanupExisting(bundle.runId, bundle.ownershipToken, owner);

    await expect(service.create({
      runId: 'evidence-wrong-workflow-create',
      caller: { ...creator, workflow: 'vulnerability-review' as any },
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('intent') }],
    })).rejects.toThrow('dash-review');
  });

  it('expires unclaimed handoff authority at the exact persisted boundary', async () => {
    const projectRoot = await createProject('expiry');
    let now = 1_000;
    const service = createService(projectRoot, {
      now: () => now,
      handoffMs: 100,
      isProcessAlive: () => true,
    });
    const bundle = await service.create({
      runId: 'evidence-expiry',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('intent') }],
    });

    now = 1_099;
    await expect(service.recoverAuthorization(bundle.runId, bundle.ownershipToken, 'dash-review')).resolves.toMatchObject({
      runId: bundle.runId,
      creatorSessionId: creator.sessionId,
    });
    now = 1_100;
    await expect(service.claim(bundle.runId, bundle.ownershipToken, primary())).rejects.toThrow('handoff lease has expired');
    await service.cleanupExpired();
    expect(await pathExists(bundle.workspacePath)).toBe(false);
    expect(await pathExists(metadataPath(projectRoot, bundle.runId))).toBe(false);
  });

  it('recovers authorization after restart and adopts only the exact dead owner before expiry', async () => {
    const projectRoot = await createProject('owner-recovery');
    let now = 2_000;
    const ownerBeforeRestart = primary('persistent-owner', 4242);
    const service = createService(projectRoot, {
      now: () => now,
      handoffMs: 100,
      isProcessAlive: (pid) => pid === process.pid,
    });
    const bundle = await service.create({
      runId: 'evidence-owner-recovery',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('intent') }],
    });
    await service.claim(bundle.runId, bundle.ownershipToken, ownerBeforeRestart);
    await service.cleanupExpired();
    expect(JSON.parse(await fs.readFile(metadataPath(projectRoot, bundle.runId), 'utf8')).ownerRecoveryExpiresAt).toBe(2_100);

    now = 2_050;
    const restarted = createService(projectRoot, {
      now: () => now,
      handoffMs: 100,
      isProcessAlive: (pid) => pid === process.pid,
    });
    const adoptedOwner = primary('persistent-owner', process.pid);
    await expect(restarted.recoverAuthorization(bundle.runId, bundle.ownershipToken, 'dash-review')).resolves.toMatchObject({
      ownerAgent: adoptedOwner.agent,
      ownerSessionId: adoptedOwner.sessionId,
    });
    await expect(restarted.recoverOwnerAuthorization(bundle.runId, 'wrong-token', adoptedOwner)).rejects.toThrow('ownership token');
    await expect(restarted.recoverOwnerAuthorization(
      bundle.runId,
      bundle.ownershipToken,
      primary('wrong-owner'),
    )).rejects.toThrow('owner capability');
    await expect(restarted.recoverOwnerAuthorization(bundle.runId, bundle.ownershipToken, adoptedOwner)).resolves.toMatchObject({
      runId: bundle.runId,
      ownerPid: process.pid,
    });
    await expect(restarted.inspect(bundle.runId, bundle.ownershipToken, adoptedOwner)).resolves.toMatchObject({
      integrity: { bundleClean: true, sourcesClean: true },
    });
    expect(JSON.parse(await fs.readFile(metadataPath(projectRoot, bundle.runId), 'utf8'))).not.toHaveProperty('ownerRecoveryExpiresAt');
    await restarted.cleanupExisting(bundle.runId, bundle.ownershipToken, adoptedOwner);
  });

  it('rejects dead-owner adoption at the exact recovery expiry boundary', async () => {
    const projectRoot = await createProject('owner-expiry');
    let now = 3_000;
    const owner = primary('expired-owner', 4242);
    const service = createService(projectRoot, {
      now: () => now,
      handoffMs: 100,
      isProcessAlive: () => false,
    });
    const bundle = await service.create({
      runId: 'evidence-owner-expiry',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('intent') }],
    });
    await service.claim(bundle.runId, bundle.ownershipToken, owner);
    await service.cleanupExpired();
    now = 3_100;

    await expect(service.recoverOwnerAuthorization(
      bundle.runId,
      bundle.ownershipToken,
      primary('expired-owner'),
    )).rejects.toThrow('owner recovery lease has expired');
    await service.cleanupExpired();
    expect(await pathExists(bundle.workspacePath)).toBe(false);
  });

  it('uses run locks so only one concurrent create can publish a run', async () => {
    const projectRoot = await createProject('run-lock');
    const service = createService(projectRoot);
    const options = {
      runId: 'evidence-concurrent-create',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline' as const, bytes: Buffer.alloc(512 * 1024, 1) }],
    };
    const outcomes = await Promise.allSettled([service.create(options), service.create(options)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const bundle = (outcomes.find((outcome) => outcome.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof service.create>>>).value;
    await service.cleanupExisting(bundle.runId, bundle.ownershipToken, creator);
  });

  it('recovers an exact lock publication residue after an injected process crash', async () => {
    const projectRoot = await createProject('lock-publication-crash');
    const runId = 'evidence-lock-publication-crash';
    let crash = true;
    let now = 1_000;
    const crashing = createService(projectRoot, {
      now: () => now,
      handoffMs: 100,
      onLockPublication: async (publishedPath) => {
        if (publishedPath === lockPath(projectRoot, runId) && crash) {
          crash = false;
          throw new Error('injected lock publication crash');
        }
      },
    });
    const options = {
      runId,
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline' as const, bytes: Buffer.from('intent') }],
    };

    await expect(crashing.create(options)).rejects.toThrow('injected lock publication crash');
    const publishedStat = await fs.lstat(lockPath(projectRoot, runId));
    expect(publishedStat.nlink).toBe(2);
    if (process.platform !== 'win32') expect(publishedStat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(lockPath(projectRoot, runId), 'utf8'))).toMatchObject({
      ownerPid: process.pid,
      expiresAt: 1_100,
    });

    now = 1_050;
    const restarted = createService(projectRoot, {
      now: () => now,
      handoffMs: 100,
      isProcessAlive: () => false,
    });
    const bundle = await restarted.create(options);
    expect(bundle.runId).toBe(runId);
    await restarted.cleanupExisting(runId, bundle.ownershipToken, creator);
  });

  it('does not recover a publication residue from its active owner at the expiry boundary', async () => {
    const projectRoot = await createProject('active-lock-publication');
    const runId = 'evidence-active-lock-publication';
    let now = 2_000;
    let published!: () => void;
    let release!: () => void;
    const publicationReached = new Promise<void>((resolve) => { published = resolve; });
    const holdPublication = new Promise<void>((resolve) => { release = resolve; });
    const active = createService(projectRoot, {
      now: () => now,
      handoffMs: 100,
      isProcessAlive: (pid) => pid === process.pid,
      onLockPublication: async (publishedPath) => {
        if (publishedPath === lockPath(projectRoot, runId)) {
          published();
          await holdPublication;
        }
      },
    });
    const options = {
      runId,
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline' as const, bytes: Buffer.from('intent') }],
    };
    const activeCreate = active.create(options);
    await publicationReached;
    now = 2_100;

    await expect(createService(projectRoot, {
      now: () => now,
      handoffMs: 100,
      isProcessAlive: (pid) => pid === process.pid,
    }).create(options)).rejects.toThrow('busy');
    release();
    const bundle = await activeCreate;
    await active.cleanupExisting(runId, bundle.ownershipToken, creator);
  });

  it('rejects malicious hard-link and symlink lock publication residue', async () => {
    const projectRoot = await createProject('malicious-lock-residue');
    const initializer = createService(projectRoot);
    const initialized = await initializer.create({
      runId: 'evidence-lock-initializer',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('intent') }],
    });
    await initializer.cleanupExisting(initialized.runId, initialized.ownershipToken, creator);

    const hardlinkRunId = 'evidence-malicious-hardlink-lock';
    const maliciousSource = path.join(path.dirname(lockPath(projectRoot, hardlinkRunId)), 'malicious-owner');
    await fs.writeFile(maliciousSource, JSON.stringify({
      ownerPid: 4242,
      ownerToken: 'malicious-owner',
      expiresAt: Date.now() + 60_000,
    }));
    await fs.link(maliciousSource, lockPath(projectRoot, hardlinkRunId));
    await expect(createService(projectRoot, { isProcessAlive: () => false }).create({
      runId: hardlinkRunId,
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('intent') }],
    })).rejects.toThrow(/publication residue|multiple hard links|invalid/i);
    expect(await pathExists(workspacePath(projectRoot, hardlinkRunId))).toBe(false);

    const symlinkRunId = 'evidence-malicious-symlink-lock';
    await fs.symlink(maliciousSource, lockPath(projectRoot, symlinkRunId));
    await expect(createService(projectRoot, { isProcessAlive: () => false }).create({
      runId: symlinkRunId,
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('intent') }],
    })).rejects.toThrow(/symbolic|regular|invalid/i);
    expect(await pathExists(workspacePath(projectRoot, symlinkRunId))).toBe(false);
  });

  it('recovers orphan bundles independently and bounds automatic startup sweeping', async () => {
    const projectRoot = await createProject('orphan-sweep');
    const root = path.join(projectRoot, '.hive', '.worktrees', 'review-evidence');
    for (const runId of ['00-orphan', '01-orphan']) {
      await fs.mkdir(path.join(root, runId, 'evidence'), { recursive: true });
      await fs.writeFile(path.join(root, runId, 'evidence', 'orphan.txt'), 'orphan\n');
    }
    const service = createService(projectRoot, { startupSweepLimit: 1 });
    const bundle = await service.create({
      runId: 'evidence-after-orphan',
      caller: creator,
      resolutionFingerprint,
      items: [{ kind: 'inline', bytes: Buffer.from('intent') }],
    });

    const remainingAfterStartup = (await Promise.all(['00-orphan', '01-orphan'].map(async (runId) => ({
      runId,
      exists: await pathExists(path.join(root, runId)),
    })))).filter((entry) => entry.exists);
    expect(remainingAfterStartup).toHaveLength(1);
    await service.cleanupExpired();
    expect(await pathExists(path.join(root, remainingAfterStartup[0]!.runId))).toBe(false);
    await service.cleanupExisting(bundle.runId, bundle.ownershipToken, creator);
  });
});
