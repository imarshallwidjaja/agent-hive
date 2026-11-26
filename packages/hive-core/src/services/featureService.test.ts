import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { FeatureService, FeatureWriteUncertainError } from './featureService';
import { FeatureResolutionError } from '../utils/paths.js';
import { resolveLockAnchor } from '../utils/nativeLock.js';
import { FeatureConstraintService } from './featureConstraintService.js';
import { CONSTRAINTS_MAX_CHARS, ConstraintRegisterError } from './constraintRegister.js';

const TEST_DIR = `/tmp/hive-core-featureservice-test-${process.pid}`;

function cleanup(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

function setupFeature(featureName: string): string {
  const featurePath = path.join(TEST_DIR, '.hive', 'features', featureName);
  fs.mkdirSync(path.join(featurePath, 'context'), { recursive: true });
  fs.writeFileSync(
    path.join(featurePath, 'feature.json'),
    JSON.stringify({ name: featureName, status: 'planning', createdAt: new Date().toISOString() })
  );
  fs.writeFileSync(path.join(featurePath, 'plan.md'), '# Plan\n');
  return featurePath;
}

function setupIndexedFeature(directoryName: string, logicalName: string): void {
  const featurePath = path.join(TEST_DIR, '.hive', 'features', directoryName);
  fs.mkdirSync(path.join(featurePath, 'context'), { recursive: true });
  fs.writeFileSync(
    path.join(featurePath, 'feature.json'),
    JSON.stringify({ name: logicalName, status: 'planning', createdAt: new Date().toISOString() })
  );
  fs.writeFileSync(path.join(featurePath, 'plan.md'), '# Plan\n');
}

describe('FeatureService', () => {
  let service: FeatureService;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    service = new FeatureService(TEST_DIR);
  });

  afterEach(() => {
    cleanup();
  });

  it('creates new features in the next indexed folder without writing project-global selection state', () => {
    setupFeature('legacy-feature');
    setupIndexedFeature('02_existing-feature', 'existing-feature');

    const feature = service.create('new-feature');
    const indexedPath = path.join(TEST_DIR, '.hive', 'features', '03_new-feature');

    expect(feature.name).toBe('new-feature');
    expect(fs.existsSync(indexedPath)).toBe(true);
    expect(service.get('new-feature')).toMatchObject({ name: 'new-feature' });
    expect(service.list()).toEqual(['existing-feature', 'legacy-feature', 'new-feature']);
    expect(fs.existsSync(path.join(TEST_DIR, '.hive', 'active-feature'))).toBe(false);
  });

  it('rejects duplicate logical feature names across legacy and indexed folders', () => {
    setupFeature('legacy-feature');
    setupIndexedFeature('01_duplicate-feature', 'duplicate-feature');

    expect(() => service.create('legacy-feature')).toThrow("Feature 'legacy-feature' already exists");
    expect(() => service.create('duplicate-feature')).toThrow("Feature 'duplicate-feature' already exists");
    // A directory alias is a resolvable name too, so reusing it as a logical name would make it ambiguous.
    expect(() => service.create('01_duplicate-feature')).toThrow("Feature '01_duplicate-feature' already exists");
  });

  it('publishes nothing when the initial metadata write fails, so the same name can be created again', () => {
    setupIndexedFeature('01_existing', 'existing');
    const featuresPath = path.join(TEST_DIR, '.hive', 'features');
    const originalWrite = fs.writeFileSync;
    const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(target).includes('feature.json')) throw new Error('disk full');
      return (originalWrite as (...args: unknown[]) => void)(target, ...rest);
    }) as typeof fs.writeFileSync);

    try {
      expect(() => service.create('new-feature')).toThrow('disk full');
    } finally {
      writeSpy.mockRestore();
    }

    expect(fs.readdirSync(featuresPath)).toEqual(['01_existing']);
    expect(service.get('new-feature')).toBeNull();
    expect(service.create('new-feature')).toMatchObject({ name: 'new-feature', status: 'planning' });
    expect(fs.readdirSync(featuresPath).sort()).toEqual(['01_existing', '02_new-feature']);
    expect(fs.existsSync(path.join(featuresPath, '02_new-feature', 'tasks'))).toBe(true);
  });

  /** Fail every fsync once a rename onto `published` has run, as a disk that loses its flush after publication would. */
  function failFlushAfterRenameOnto(published: string): () => void {
    const originalRename = fs.renameSync;
    const originalFsync = fs.fsyncSync;
    let renamed = false;
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      originalRename(from, to);
      if (String(to) === published) renamed = true;
    }) as typeof fs.renameSync);
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(((descriptor: number) => {
      if (renamed) throw new Error('EIO: flush failed');
      return originalFsync(descriptor);
    }) as typeof fs.fsyncSync);
    return () => {
      renameSpy.mockRestore();
      fsyncSpy.mockRestore();
    };
  }

  it('reports a create that failed after publishing as uncertain, leaving the feature readable and its name taken', () => {
    const featuresPath = path.join(TEST_DIR, '.hive', 'features');
    const featurePath = path.join(featuresPath, '01_new-feature');
    const restore = failFlushAfterRenameOnto(featurePath);
    let failure: unknown;
    try {
      service.create('new-feature', 'HIVE-7');
    } catch (error) {
      failure = error;
    } finally {
      restore();
    }

    expect(failure).toBeInstanceOf(FeatureWriteUncertainError);
    expect(failure).toMatchObject({
      operation: 'create',
      featureName: 'new-feature',
      featurePath,
      publication: 'applied',
      feature: { name: 'new-feature', ticket: 'HIVE-7' },
      writeFailure: { message: 'EIO: flush failed' },
      cause: { message: 'EIO: flush failed' },
    });
    expect((failure as FeatureWriteUncertainError).releaseFailure).toBeUndefined();
    expect((failure as Error).message).toContain('do not create it again');
    expect(service.get('new-feature')).toMatchObject({ name: 'new-feature', status: 'planning', ticket: 'HIVE-7' });
    expect(fs.readdirSync(featuresPath)).toEqual(['01_new-feature']);
    expect(() => service.create('new-feature')).toThrow("Feature 'new-feature' already exists");
  });

  it('reports every failed durable metadata write as uncertain, before or after its rename, and recovers by reading', () => {
    const featurePath = path.join(TEST_DIR, '.hive', 'features', '04_legacy');
    const metadataPath = path.join(featurePath, 'feature.json');
    fs.mkdirSync(featurePath, { recursive: true });
    const original = JSON.stringify({ name: 'legacy', status: 'planning', legacyField: { kept: true } });
    fs.writeFileSync(metadataPath, original);
    let applied = 0;
    const setTicket = (feature: { ticket?: string }) => {
      applied += 1;
      feature.ticket = 'HIVE-1';
    };

    // Before the rename: the bytes are untouched, but from outside the durable write that is indistinguishable from
    // a published file another writer replaced, so the failure is still uncertain.
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation((() => {
      throw new Error('EXDEV: rename failed');
    }) as typeof fs.renameSync);
    let beforeRename: unknown;
    try {
      service.updateMetadata('legacy', setTicket);
    } catch (error) {
      beforeRename = error;
    } finally {
      renameSpy.mockRestore();
    }
    expect(beforeRename).toBeInstanceOf(FeatureWriteUncertainError);
    expect(beforeRename).toMatchObject({ publication: 'unknown', writeFailure: { message: 'EXDEV: rename failed' } });
    expect(fs.readFileSync(metadataPath, 'utf-8')).toBe(original);

    // After the rename: uncertain, with stored metadata that matches the update.
    const restore = failFlushAfterRenameOnto(metadataPath);
    let failure: unknown;
    try {
      service.updateMetadata('legacy', setTicket);
    } catch (error) {
      failure = error;
    } finally {
      restore();
    }
    expect(failure).toBeInstanceOf(FeatureWriteUncertainError);
    expect(failure).toMatchObject({ operation: 'update', featureName: 'legacy', featurePath, publication: 'matches', feature: { ticket: 'HIVE-1' } });
    expect((failure as Error).message).toContain('Read the feature before retrying');

    // Recovery reads instead of reapplying; a later, different update keeps the published and unknown fields.
    expect(service.get('legacy')).toMatchObject({ ticket: 'HIVE-1', legacyField: { kept: true } });
    service.updateStatus('legacy', 'approved');
    expect(applied).toBe(2);
    expect(JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))).toMatchObject({ status: 'approved', ticket: 'HIVE-1', legacyField: { kept: true } });
  });

  it('reports a failed metadata update whose result cannot be read back as unknown', () => {
    const featurePath = setupFeature('unreadable-after');
    const metadataPath = path.join(featurePath, 'feature.json');
    const originalRead = fs.readFileSync;
    const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation((() => {
      throw new Error('ENOSPC: no space left');
    }) as typeof fs.writeFileSync);
    const readSpy = spyOn(fs, 'readFileSync');
    let failure: unknown;
    try {
      service.updateMetadata('unreadable-after', (feature) => {
        feature.ticket = 'HIVE-3';
        // Reads after the mutation are the read-back.
        readSpy.mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
          if (String(target) === metadataPath) throw new Error('EIO: read failed');
          return (originalRead as (...args: unknown[]) => unknown)(target, ...rest);
        }) as typeof fs.readFileSync);
      });
    } catch (error) {
      failure = error;
    } finally {
      writeSpy.mockRestore();
      readSpy.mockRestore();
    }

    expect(failure).toBeInstanceOf(FeatureWriteUncertainError);
    expect(failure).toMatchObject({ operation: 'update', publication: 'unknown', cause: { message: 'ENOSPC: no space left' } });
    expect((failure as Error).message).toContain('may or may not be in place');
    expect(service.get('unreadable-after')).not.toHaveProperty('ticket');
  });

  it('reports an update that published and then lost its flush to an unlocked writer as unknown, not as a plain error', () => {
    const featurePath = setupFeature('interleaved');
    const metadataPath = path.join(featurePath, 'feature.json');
    // An unlocked writer, as PlanService approval still is, replaces feature.json between this call's rename and
    // its failed directory flush, so the read-back differs although this call did publish.
    const otherWriter = JSON.stringify({ name: 'interleaved', status: 'approved', approvedAt: '2026-01-01T00:00:00.000Z' });
    const originalRename = fs.renameSync;
    const originalWrite = fs.writeFileSync;
    const originalFsync = fs.fsyncSync;
    let published = false;
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      originalRename(from, to);
      if (String(to) === metadataPath) published = true;
    }) as typeof fs.renameSync);
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(((descriptor: number) => {
      if (!published) return originalFsync(descriptor);
      originalWrite(metadataPath, otherWriter);
      throw new Error('EIO: flush failed');
    }) as typeof fs.fsyncSync);
    let failure: unknown;
    try {
      service.updateMetadata('interleaved', (feature) => {
        feature.ticket = 'HIVE-9';
      });
    } catch (error) {
      failure = error;
    } finally {
      renameSpy.mockRestore();
      fsyncSpy.mockRestore();
    }

    expect(published).toBe(true);
    expect(failure).toBeInstanceOf(FeatureWriteUncertainError);
    expect(failure).toMatchObject({
      operation: 'update',
      publication: 'unknown',
      feature: { ticket: 'HIVE-9' },
      writeFailure: { message: 'EIO: flush failed' },
      cause: { message: 'EIO: flush failed' },
    });
    expect((failure as Error).message).toContain('differs from the update, so the update may or may not be in place');
    expect(fs.readFileSync(metadataPath, 'utf-8')).toBe(otherWriter);
  });

  it('classifies a failed flush against the bytes it wrote, without serializing the update a second time', () => {
    const featurePath = setupFeature('serialize-once');
    const metadataPath = path.join(featurePath, 'feature.json');
    const restore = failFlushAfterRenameOnto(metadataPath);
    let serializations = 0;
    let failure: unknown;
    try {
      service.updateMetadata('serialize-once', (feature) => {
        feature.ticket = 'HIVE-11';
        // A value whose serializer works once and throws on any later call.
        (feature as { probe?: unknown }).probe = {
          toJSON() {
            serializations += 1;
            if (serializations > 1) throw new Error('serialized twice');
            return 'once';
          },
        };
      });
    } catch (error) {
      failure = error;
    } finally {
      restore();
    }

    expect(serializations).toBe(1);
    expect(failure).toBeInstanceOf(FeatureWriteUncertainError);
    expect(failure).toMatchObject({ operation: 'update', publication: 'matches', writeFailure: { message: 'EIO: flush failed' } });
    expect(JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))).toMatchObject({ ticket: 'HIVE-11', probe: 'once' });
  });

  it('reports stored metadata that already matched before a failed write as matching, not as written by this call', () => {
    const featurePath = path.join(TEST_DIR, '.hive', 'features', '01_unchanged');
    const metadataPath = path.join(featurePath, 'feature.json');
    fs.mkdirSync(featurePath, { recursive: true });
    const stored = { name: 'unchanged', status: 'planning', ticket: 'HIVE-5' };
    fs.writeFileSync(metadataPath, JSON.stringify(stored, null, 2));
    // The temp-file write fails, so this call never reaches its rename.
    const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation((() => {
      throw new Error('ENOSPC: no space left');
    }) as typeof fs.writeFileSync);
    let failure: unknown;
    try {
      service.updateMetadata('unchanged', (feature) => {
        feature.ticket = 'HIVE-5';
      });
    } catch (error) {
      failure = error;
    } finally {
      writeSpy.mockRestore();
    }

    expect(failure).toMatchObject({ operation: 'update', publication: 'matches', writeFailure: { message: 'ENOSPC: no space left' } });
    expect((failure as Error).message).toContain('this call may not be what wrote it');
    expect(fs.readFileSync(metadataPath, 'utf-8')).toBe(JSON.stringify(stored, null, 2));
  });

  /**
   * Make the next release of the native lock on `resource` fail after its descriptor closes, as a failed close
   * does. The first descriptor opened on the lock anchor is the held lock; the diagnostic record uses a later one.
   */
  function failLockReleaseOn(resource: string): () => void {
    const anchorPath = resolveLockAnchor(resource).anchorPath;
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    let lockDescriptor: number | undefined;
    const openSpy = spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      const descriptor = (originalOpen as (...args: unknown[]) => number)(target, ...rest);
      if (lockDescriptor === undefined && String(target) === anchorPath) lockDescriptor = descriptor;
      return descriptor;
    }) as typeof fs.openSync);
    const closeSpy = spyOn(fs, 'closeSync').mockImplementation(((descriptor: number) => {
      originalClose(descriptor);
      if (descriptor !== lockDescriptor) return;
      lockDescriptor = -1;
      throw Object.assign(new Error('EIO: lock close failed'), { code: 'EIO' });
    }) as typeof fs.closeSync);
    return () => {
      openSpy.mockRestore();
      closeSpy.mockRestore();
    };
  }

  function captureFailure(run: () => unknown, restore: () => void): unknown {
    try {
      run();
    } catch (error) {
      return error;
    } finally {
      restore();
    }
    throw new Error('Expected the call to fail');
  }

  it('reports a create whose lock release failed after publishing as applied, without hiding the created feature', () => {
    const featuresPath = path.join(TEST_DIR, '.hive', 'features');
    const featurePath = path.join(featuresPath, '01_new-feature');
    fs.mkdirSync(featuresPath, { recursive: true });

    const failure = captureFailure(() => service.create('new-feature'), failLockReleaseOn(featuresPath));

    expect(failure).toBeInstanceOf(FeatureWriteUncertainError);
    expect(failure).toMatchObject({
      operation: 'create',
      featurePath,
      publication: 'applied',
      feature: { name: 'new-feature' },
      releaseFailure: { message: 'EIO: lock close failed' },
      cause: { message: 'EIO: lock close failed' },
    });
    expect((failure as FeatureWriteUncertainError).writeFailure).toBeUndefined();
    expect((failure as Error).message).toContain('releasing the feature lock failed');
    expect((failure as Error).message).not.toContain('crash');
    expect(service.get('new-feature')).toMatchObject({ name: 'new-feature', status: 'planning' });
    expect(() => service.create('new-feature')).toThrow("Feature 'new-feature' already exists");
    expect(service.create('second-feature')).toMatchObject({ name: 'second-feature' });
  });

  it('reports an update whose lock release failed after its durable write as applied', () => {
    const featurePath = setupFeature('released-late');
    const metadataPath = path.join(featurePath, 'feature.json');

    const failure = captureFailure(
      () => service.updateMetadata('released-late', (feature) => { feature.ticket = 'HIVE-8'; }),
      failLockReleaseOn(metadataPath),
    );

    expect(failure).toBeInstanceOf(FeatureWriteUncertainError);
    expect(failure).toMatchObject({ operation: 'update', publication: 'applied', feature: { ticket: 'HIVE-8' }, releaseFailure: { message: 'EIO: lock close failed' } });
    expect((failure as Error).message).toContain('This call published the new metadata, but a writer outside the feature lock may have changed it since, so only a fresh read shows the current metadata.');
    expect((failure as Error).message).not.toContain('is in place');
    expect(service.get('released-late')).toMatchObject({ ticket: 'HIVE-8' });
    expect(service.updateStatus('released-late', 'approved')).toMatchObject({ status: 'approved', ticket: 'HIVE-8' });
  });

  it('keeps both the write failure and the release failure when both happen after publication', () => {
    const featuresPath = path.join(TEST_DIR, '.hive', 'features');
    const featurePath = path.join(featuresPath, '01_both-failed');
    fs.mkdirSync(featuresPath, { recursive: true });
    const restoreFlush = failFlushAfterRenameOnto(featurePath);
    const restoreRelease = failLockReleaseOn(featuresPath);
    const createFailure = captureFailure(() => service.create('both-failed'), () => {
      restoreRelease();
      restoreFlush();
    });

    expect(createFailure).toMatchObject({
      operation: 'create',
      publication: 'applied',
      writeFailure: { message: 'EIO: flush failed' },
      releaseFailure: { message: 'EIO: lock close failed' },
      cause: { message: 'EIO: flush failed' },
    });
    expect((createFailure as Error).message).toContain('flushing the features directory failed (EIO: flush failed), and releasing the feature lock failed');
    expect(service.get('both-failed')).toMatchObject({ name: 'both-failed' });

    const metadataPath = path.join(featurePath, 'feature.json');
    const restoreUpdateFlush = failFlushAfterRenameOnto(metadataPath);
    const restoreUpdateRelease = failLockReleaseOn(metadataPath);
    const updateFailure = captureFailure(
      () => service.updateMetadata('both-failed', (feature) => { feature.ticket = 'HIVE-9'; }),
      () => {
        restoreUpdateRelease();
        restoreUpdateFlush();
      },
    );

    expect(updateFailure).toMatchObject({
      operation: 'update',
      publication: 'matches',
      writeFailure: { message: 'EIO: flush failed' },
      releaseFailure: { message: 'EIO: lock close failed' },
    });
    expect(service.get('both-failed')).toMatchObject({ ticket: 'HIVE-9' });
  });

  it('throws the original error unchanged when an update that failed before its write is followed by a failed release', () => {
    const featurePath = setupFeature('unpublished');
    const metadataPath = path.join(featurePath, 'feature.json');
    const original = fs.readFileSync(metadataPath, 'utf-8');
    const restoreRelease = failLockReleaseOn(metadataPath);

    const failure = captureFailure(
      () => service.updateMetadata('unpublished', () => { throw new Error('abort before write'); }),
      restoreRelease,
    );

    expect(failure).not.toBeInstanceOf(FeatureWriteUncertainError);
    expect((failure as Error).message).toBe('abort before write');
    expect(fs.readFileSync(metadataPath, 'utf-8')).toBe(original);
    expect(service.updateMetadata('unpublished', (feature) => { feature.ticket = 'HIVE-10'; })).toMatchObject({ ticket: 'HIVE-10' });
  });

  it('reads and lists healthy features beside a corrupt sibling and refuses the corrupt one unchanged', () => {
    setupIndexedFeature('01_healthy', 'healthy');
    const corruptPath = path.join(TEST_DIR, '.hive', 'features', '02_corrupt');
    fs.mkdirSync(corruptPath, { recursive: true });
    fs.writeFileSync(path.join(corruptPath, 'feature.json'), '{broken');

    expect(service.get('healthy')).toMatchObject({ name: 'healthy' });
    expect(service.list()).toEqual(['corrupt', 'healthy']);
    expect(() => service.get('corrupt')).toThrow(FeatureResolutionError);
    expect(() => service.updateStatus('corrupt', 'approved')).toThrow('unreadable metadata');
    expect(() => service.create('corrupt')).toThrow("Feature 'corrupt' already exists");
    expect(fs.readFileSync(path.join(corruptPath, 'feature.json'), 'utf-8')).toBe('{broken');
  });

  it('refuses metadata updates for an unknown feature before any lock or write', () => {
    setupIndexedFeature('01_existing', 'existing');
    const before = fs.readdirSync(TEST_DIR, { recursive: true });

    expect(service.get('missing')).toBeNull();
    expect(() => service.updateStatus('missing', 'approved')).toThrow("Feature 'missing' not found");
    expect(() => service.updateMetadata('missing', () => {})).toThrow("Feature 'missing' not found");
    expect(() => service.setSession('missing', 'ses_1')).toThrow("Feature 'missing' not found");
    expect(fs.readdirSync(TEST_DIR, { recursive: true })).toEqual(before);
  });

  it('updates metadata through an indexed alias, keeping unknown legacy fields', () => {
    const featurePath = path.join(TEST_DIR, '.hive', 'features', '04_legacy');
    fs.mkdirSync(featurePath, { recursive: true });
    fs.writeFileSync(path.join(featurePath, 'feature.json'), JSON.stringify({
      name: 'legacy', status: 'planning', createdAt: '2026-01-01T00:00:00.000Z', legacyField: { kept: true },
    }));

    service.updateMetadata('04_legacy', (feature) => {
      feature.ticket = 'HIVE-1';
    });
    service.updateStatus('legacy', 'approved');

    expect(JSON.parse(fs.readFileSync(path.join(featurePath, 'feature.json'), 'utf-8'))).toMatchObject({
      name: 'legacy',
      status: 'approved',
      ticket: 'HIVE-1',
      legacyField: { kept: true },
    });
  });

  it('writes nothing when a metadata mutation throws, renames the feature, or reopens a completed feature', () => {
    const featurePath = setupFeature('guarded');
    const metadataPath = path.join(featurePath, 'feature.json');
    const original = fs.readFileSync(metadataPath, 'utf-8');

    expect(() => service.updateMetadata('guarded', (feature) => {
      feature.ticket = 'partial';
      throw new Error('abort');
    })).toThrow('abort');
    expect(() => service.updateMetadata('guarded', (feature) => {
      feature.name = 'other';
    })).toThrow('cannot change its name');
    expect(fs.readFileSync(metadataPath, 'utf-8')).toBe(original);

    service.complete('guarded');
    const completed = fs.readFileSync(metadataPath, 'utf-8');
    expect(() => service.updateMetadata('guarded', (feature) => {
      feature.status = 'approved';
    })).toThrow(/cannot be reopened/i);
    expect(() => service.complete('guarded')).toThrow('already completed');
    expect(fs.readFileSync(metadataPath, 'utf-8')).toBe(completed);
  });

  it('keeps an archived feature archived while its other metadata changes', () => {
    setupFeature('shelved');
    service.archive('shelved', 'paused');

    const updated = service.updateMetadata('shelved', (feature) => {
      feature.ticket = 'HIVE-2';
    });

    expect(updated).toMatchObject({ status: 'archived', archiveReason: 'paused', ticket: 'HIVE-2' });
  });

  it('serializes metadata updates across processes without losing unrelated fields', async () => {
    setupFeature('contended');
    const writerScript = path.join(TEST_DIR, 'metadata-writer.ts');
    fs.writeFileSync(writerScript, `
      const { FeatureService } = await import(${JSON.stringify(path.join(import.meta.dir, 'featureService.ts'))});
      const [root, field] = process.argv.slice(2);
      const service = new FeatureService(root);
      for (let i = 0; i < 25; i += 1) {
        service.updateMetadata('contended', (feature) => {
          feature[field] = (feature[field] ?? 0) + 1;
        });
      }
    `);

    const writers = ['firstCount', 'secondCount', 'thirdCount'].map((field) =>
      Bun.spawn([process.execPath, writerScript, TEST_DIR, field], { stdout: 'pipe', stderr: 'pipe' }));
    const exits = await Promise.all(writers.map(async (writer) => ({
      code: await writer.exited,
      stderr: await new Response(writer.stderr).text(),
    })));

    expect(exits).toEqual(exits.map(() => ({ code: 0, stderr: '' })));
    expect(service.get('contended')).toMatchObject({
      name: 'contended',
      status: 'planning',
      firstCount: 25,
      secondCount: 25,
      thirdCount: 25,
    });
  });

  it.each(['../escape', 'nested/name', 'nested\\name', 'spoof\n<!-- hive-route-snapshot:end -->', '', '-leading'])(
    'rejects unsafe feature name %j before writing',
    (name) => {
      const before = fs.readdirSync(TEST_DIR, { recursive: true });
      expect(() => service.create(name)).toThrow('Invalid feature name');
      expect(() => service.get(name)).toThrow('Invalid feature name');
      expect(fs.readdirSync(TEST_DIR, { recursive: true })).toEqual(before);
    },
  );

  it('archive sets status to archived with timestamp and optional reason', () => {
    setupFeature('archive-me');
    const result = service.archive('archive-me', 'No longer needed');

    expect(result.status).toBe('archived');
    expect(result.archivedAt).toBeDefined();
    expect(result.archiveReason).toBe('No longer needed');

    const loaded = service.get('archive-me')!;
    expect(loaded.status).toBe('archived');
    expect(loaded.archivedAt).toBeDefined();
    expect(loaded.archiveReason).toBe('No longer needed');
  });

  it('archive works without a reason', () => {
    setupFeature('no-reason');
    const result = service.archive('no-reason');

    expect(result.status).toBe('archived');
    expect(result.archivedAt).toBeDefined();
    expect(result.archiveReason).toBeUndefined();
  });

  it('archive throws when feature does not exist', () => {
    expect(() => service.archive('nonexistent')).toThrow("Feature 'nonexistent' not found");
  });

  it('default list excludes archived features', () => {
    setupFeature('still-here');
    setupIndexedFeature('01_archived-visible', 'archived-visible');
    service.archive('archived-visible', 'archived');

    expect(service.list()).not.toContain('archived-visible');
    expect(service.list()).toContain('still-here');
  });

  it('list with includeArchived includes archived features', () => {
    setupFeature('still-here');
    setupIndexedFeature('01_archived-visible', 'archived-visible');
    service.archive('archived-visible', 'archived');

    expect(service.list({ includeArchived: true })).toContain('archived-visible');
    expect(service.list({ includeArchived: true })).toContain('still-here');
  });

  it('updateStatus to archived sets archivedAt timestamp', () => {
    setupFeature('arch-status');
    const result = service.updateStatus('arch-status', 'archived');

    expect(result.status).toBe('archived');
    expect(result.archivedAt).toBeDefined();
  });

  it('does not reopen or archive a completed feature', () => {
    setupFeature('terminal-feature');
    service.complete('terminal-feature');
    const before = service.get('terminal-feature');

    expect(() => service.updateStatus('terminal-feature', 'planning')).toThrow(/cannot be reopened/i);
    expect(() => service.archive('terminal-feature')).toThrow(/cannot be archived/i);
    expect(service.get('terminal-feature')).toEqual(before);
  });
});

describe('FeatureConstraintService', () => {
  let service: FeatureConstraintService;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    service = new FeatureConstraintService(TEST_DIR);
  });

  afterEach(cleanup);

  it('reads an absent register as revision zero without creating a file', () => {
    const featurePath = setupFeature('constraints');

    expect(service.read('constraints')).toEqual({ entries: [], revision: 0, constraints: '', constraintsChars: 0 });
    expect(fs.existsSync(path.join(featurePath, 'constraints.json'))).toBe(false);
  });

  it('preserves stable IDs, exact-add deduplication, revisions, edits, and clears', () => {
    setupIndexedFeature('01_constraints', 'constraints');
    const first = service.add('constraints', 'Keep this verbatim.');
    const duplicate = service.add('constraints', 'Keep this verbatim.');
    expect(duplicate).toEqual(first);

    const edited = service.edit('constraints', first.entries[0]!.id, first.revision, 'Keep this corrected.');
    expect(edited.entries[0]!.id).toBe(first.entries[0]!.id);
    expect(edited).toMatchObject({ revision: 2, constraints: 'Keep this corrected.' });
    expect(() => service.edit('constraints', first.entries[0]!.id, first.revision, 'stale')).toThrow();

    const cleared = service.clear('constraints', edited.revision);
    expect(cleared).toMatchObject({ entries: [], revision: 3, constraints: '' });
    expect(service.read('constraints')).toEqual(cleared);
  });

  it('resolves an indexed directory alias for feature constraints', () => {
    setupIndexedFeature('03_dagster-product-lifecycle', 'dagster-product-lifecycle');

    expect(service.add('03_dagster-product-lifecycle', 'Keep the legacy route.')).toMatchObject({
      entries: [{ text: 'Keep the legacy route.' }],
      revision: 1,
    });
  });

  it('rejects a physical-directory and logical-name namespace collision', () => {
    setupIndexedFeature('01_alpha', 'beta');
    setupIndexedFeature('beta', 'gamma');

    expect(() => service.read('beta')).toThrow('multiple entries');
  });

  it('requires readable feature metadata with a valid logical name', () => {
    fs.mkdirSync(path.join(TEST_DIR, '.hive', 'features', '04_missing-metadata'), { recursive: true });
    expect(() => service.read('04_missing-metadata')).toThrow("Feature '04_missing-metadata' not found");

    setupIndexedFeature('05_invalid-metadata', '../escape');
    expect(() => service.read('../escape')).toThrow("Feature '../escape' not found");
    expect(fs.existsSync(path.join(TEST_DIR, '.hive', 'escape'))).toBe(false);
  });

  it('rejects blank, over-cap, missing-feature, and ambiguous namespace mutations', () => {
    setupFeature('constraints');
    expect(() => service.add('constraints', '  ')).toThrow();
    service.add('constraints', 'A');
    expect(() => service.add('constraints', 'B'.repeat(CONSTRAINTS_MAX_CHARS))).toThrow(/character cap/);
    expect(service.read('constraints')).toMatchObject({ revision: 1, constraints: 'A' });
    expect(() => service.read('missing')).toThrow("Feature 'missing' not found");

    setupIndexedFeature('01_duplicate', 'constraints');
    expect(() => service.read('constraints')).toThrow('multiple entries');
  });

  it.each([
    null,
    {},
    { entries: {}, revision: 0 },
    { entries: [], revision: -1 },
    { entries: [], revision: 1.5 },
    { entries: [{ id: 'legacy' }], revision: 0 },
    { entries: [{ id: 'legacy', text: '' }], revision: 0 },
    { entries: [{ id: 'legacy', text: 1 }], revision: 0 },
    { entries: [{ id: 'bad', text: 'Valid text' }], revision: 0 },
    { entries: [{ id: 'legacy', text: 'A' }, { id: 'legacy', text: 'B' }], revision: 0 },
  ])('rejects a corrupt persisted constraint register without changing it (%j)', (stored) => {
    const featurePath = setupFeature('constraints');
    const constraintsPath = path.join(featurePath, 'constraints.json');
    fs.writeFileSync(constraintsPath, JSON.stringify(stored));
    const before = fs.readFileSync(constraintsPath);

    try {
      service.read('constraints');
      throw new Error('Expected corrupt register to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ConstraintRegisterError);
      expect((error as ConstraintRegisterError).reason).toBe('invalid_register');
    }
    expect(fs.readFileSync(constraintsPath)).toEqual(before);
  });
});
