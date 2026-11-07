import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectContext, getFeatureData, listFeatures } from './detection';

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

  it('preserves task detection inside a composite repository worktree path', () => {
    const result = detectContext('/repo/.hive/.worktrees/03_indexed-feature/01-task/repos/api');

    expect(result.isWorktree).toBe(true);
    expect(result.feature).toBe('indexed-feature');
    expect(result.task).toBe('01-task');
    expect(result.projectRoot).toBe('/repo');
  });

  it('maps a retained checkout and its subdirectories to the project that holds it, with no feature or task', () => {
    for (const cwd of ['/repo/.hive/checkouts/root/release', '/repo/.hive/checkouts/api/release-2/src/lib', 'C:\\repo\\.hive\\checkouts\\root\\main']) {
      const result = detectContext(cwd);
      const root = cwd.startsWith('C:') ? 'C:/repo' : '/repo';
      expect(result, cwd).toEqual({ projectRoot: root, feature: null, task: null, isWorktree: true, mainProjectRoot: root });
    }
    // The first checkout segment owns the path, even when the checkout's own tracked files repeat the layout.
    expect(detectContext('/repo/.hive/checkouts/root/release/.hive/.worktrees/demo/01-task').projectRoot).toBe('/repo');
    expect(detectContext('/repo/.hive/checkouts/root/release/.hive/checkouts/root/other').projectRoot).toBe('/repo');
  });

  it('leaves non-checkout paths under .hive/checkouts and ordinary project paths as they were', () => {
    for (const cwd of ['/repo/.hive/checkouts/root', '/repo/.hive/checkouts/Root/release', '/repo/.hive/checkouts/root/..', '/repo/src/app']) {
      expect(detectContext(cwd), cwd).toEqual({ projectRoot: cwd, feature: null, task: null, isWorktree: false, mainProjectRoot: null });
    }
    // A task worktree keeps its feature and task; a checkout segment inside it does not move the project root.
    expect(detectContext('/repo/.hive/.worktrees/demo/01-task/.hive/checkouts/root/release')).toMatchObject({ projectRoot: '/repo', feature: 'demo', task: '01-task' });
  });

});
