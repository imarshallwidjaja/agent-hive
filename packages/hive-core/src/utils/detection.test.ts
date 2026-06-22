import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectContext, getActiveFeatureName, getFeatureData, listFeatures, resolveActiveFeatureName } from './detection';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-core-detection-test-'));
  tempDirs.push(projectRoot);
  fs.mkdirSync(path.join(projectRoot, '.hive', 'features'), { recursive: true });
  return projectRoot;
}

function writeFeature(projectRoot: string, folderName: string, logicalName: string): void {
  const featurePath = path.join(projectRoot, '.hive', 'features', folderName);
  fs.mkdirSync(featurePath, { recursive: true });
  fs.writeFileSync(
    path.join(featurePath, 'feature.json'),
    JSON.stringify({ name: logicalName, status: 'planning', createdAt: new Date().toISOString() })
  );
}

describe('detection', () => {
  it('returns logical feature names for mixed legacy and indexed feature folders', () => {
    const projectRoot = createProject();
    writeFeature(projectRoot, 'legacy-feature', 'legacy-feature');
    writeFeature(projectRoot, '02_indexed-feature', 'indexed-feature');

    expect(listFeatures(projectRoot)).toEqual(['indexed-feature', 'legacy-feature']);
    expect(getFeatureData(projectRoot, 'indexed-feature')).toMatchObject({ name: 'indexed-feature' });
  });

  it('detects indexed worktree folders using the logical feature name', () => {
    const result = detectContext('/repo/.hive/.worktrees/03_indexed-feature/01-task');

    expect(result.isWorktree).toBe(true);
    expect(result.feature).toBe('indexed-feature');
    expect(result.task).toBe('01-task');
    expect(result.projectRoot).toBe('/repo');
  });

  it('getActiveFeatureName returns null for archived active-pointer feature', () => {
    const projectRoot = createProject();
    writeFeature(projectRoot, '01_archived-pointer', 'archived-pointer');
    const featurePath = path.join(projectRoot, '.hive', 'features', '01_archived-pointer', 'feature.json');
    const feature = JSON.parse(fs.readFileSync(featurePath, 'utf-8'));
    feature.status = 'archived';
    fs.writeFileSync(featurePath, JSON.stringify(feature));
    fs.writeFileSync(path.join(projectRoot, '.hive', 'active-feature'), 'archived-pointer\n');

    expect(getActiveFeatureName(projectRoot)).toBeNull();
  });

  it('resolveActiveFeatureName returns null when only archived features exist', () => {
    const projectRoot = createProject();
    writeFeature(projectRoot, '01_archived-only', 'archived-only');
    const featurePath = path.join(projectRoot, '.hive', 'features', '01_archived-only', 'feature.json');
    const feature = JSON.parse(fs.readFileSync(featurePath, 'utf-8'));
    feature.status = 'archived';
    fs.writeFileSync(featurePath, JSON.stringify(feature));

    expect(resolveActiveFeatureName(projectRoot)).toBeNull();
  });
});
