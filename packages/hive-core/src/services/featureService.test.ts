import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { FeatureService } from './featureService';

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

function setupIndexedFeature(directoryName: string, logicalName: string): string {
  const featurePath = path.join(TEST_DIR, '.hive', 'features', directoryName);
  fs.mkdirSync(path.join(featurePath, 'context'), { recursive: true });
  fs.writeFileSync(
    path.join(featurePath, 'feature.json'),
    JSON.stringify({ name: logicalName, status: 'planning', createdAt: new Date().toISOString() })
  );
  fs.writeFileSync(path.join(featurePath, 'plan.md'), '# Plan\n');
  return featurePath;
}

function writeActiveFeature(name: string): void {
  fs.mkdirSync(path.join(TEST_DIR, '.hive'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, '.hive', 'active-feature'), name);
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

  it('creates new features in the next indexed folder while keeping the logical name', () => {
    setupFeature('legacy-feature');
    setupIndexedFeature('02_existing-feature', 'existing-feature');

    const feature = service.create('new-feature');
    const indexedPath = path.join(TEST_DIR, '.hive', 'features', '03_new-feature');

    expect(feature.name).toBe('new-feature');
    expect(fs.existsSync(indexedPath)).toBe(true);
    expect(service.get('new-feature')).toMatchObject({ name: 'new-feature' });
    expect(service.list()).toEqual(['existing-feature', 'legacy-feature', 'new-feature']);
    expect(fs.readFileSync(path.join(TEST_DIR, '.hive', 'active-feature'), 'utf-8')).toBe('new-feature');
  });

  it('rejects duplicate logical feature names across legacy and indexed folders', () => {
    setupFeature('legacy-feature');
    setupIndexedFeature('01_duplicate-feature', 'duplicate-feature');

    expect(() => service.create('legacy-feature')).toThrow("Feature 'legacy-feature' already exists");
    expect(() => service.create('duplicate-feature')).toThrow("Feature 'duplicate-feature' already exists");
  });

  it('getActive prefers the active-feature pointer when it references a non-completed feature', () => {
    setupFeature('beta-feature');
    setupIndexedFeature('01_alpha-feature', 'alpha-feature');
    writeActiveFeature('beta-feature');

    expect(service.list()).toEqual(['alpha-feature', 'beta-feature']);
    expect(service.getActive()).toMatchObject({ name: 'beta-feature' });
  });

  it('getActive ignores stale and completed pointers and falls back deterministically', () => {
    setupFeature('zeta-feature');
    setupIndexedFeature('01_alpha-feature', 'alpha-feature');
    setupIndexedFeature('02_done-feature', 'done-feature');
    service.updateStatus('done-feature', 'completed');

    writeActiveFeature('missing-feature');
    expect(service.getActive()).toMatchObject({ name: 'alpha-feature' });

    writeActiveFeature('done-feature');
    expect(service.getActive()).toMatchObject({ name: 'alpha-feature' });
  });

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

  it('getActive excludes archived features', () => {
    setupFeature('active-feature');
    setupIndexedFeature('01_archived-feature', 'archived-feature');
    service.archive('archived-feature', 'Done with this');

    expect(service.getActive()).toMatchObject({ name: 'active-feature' });
  });

  it('getActive skips archived when it is the active-feature pointer', () => {
    setupFeature('archived-alpha');
    writeActiveFeature('archived-alpha');
    service.archive('archived-alpha', 'Not worth it');

    expect(service.getActive()).toBeNull();
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
});
