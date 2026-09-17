import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { FeatureService } from './featureService';
import { FeatureConstraintService } from './featureConstraintService.js';
import { ConstraintRegisterError } from './constraintRegister.js';

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

  it('reports plan-only review state and does not expose overview-specific feature info', () => {
    const featureName = 'test-feature';
    const featurePath = setupFeature(featureName);

    fs.writeFileSync(path.join(featurePath, 'context', 'overview.md'), '# Overview\n');
    fs.mkdirSync(path.join(featurePath, 'comments'), { recursive: true });
    fs.writeFileSync(
      path.join(featurePath, 'comments', 'plan.json'),
      JSON.stringify({
        threads: [
          { id: 'plan-1', line: 1, body: 'Plan thread', replies: [] },
          { id: 'plan-2', line: 2, body: 'Plan thread 2', replies: ['reply'] },
        ],
      })
    );
    fs.writeFileSync(
      path.join(featurePath, 'comments', 'overview.json'),
      JSON.stringify({
        threads: [{ id: 'overview-1', line: 3, body: 'Overview thread', replies: [] }],
      })
    );

    const info = service.getInfo(featureName);

    expect(info).toMatchObject({
      name: featureName,
      hasPlan: true,
      commentCount: 2,
      reviewCounts: {
        plan: 2,
      },
    });
    expect(info).not.toHaveProperty('hasOverview');
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
    expect(() => service.add('constraints', 'B'.repeat(8000))).toThrow();
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
