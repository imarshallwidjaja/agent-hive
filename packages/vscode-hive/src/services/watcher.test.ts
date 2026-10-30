import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { getNativeBackgroundJobsPath, getNativeSessionsPath, NATIVE_OBSERVATION_OWNERS } from 'hive-core';
import { resetVscodeTestState, vscodeTestDouble, vscodeTestState as ui } from '../test/vscodeTestDouble.js';

mock.module('vscode', () => vscodeTestDouble);

const { HiveWatcher } = await import('./watcher.js');
const source = fs.readFileSync(new URL('./watcher.ts', import.meta.url), 'utf8');
const WATCHED_GLOB = '.hive/**/*';

describe('HiveWatcher', () => {
  beforeEach(resetVscodeTestState);

  it('watches only the .hive tree', () => {
    expect(source).toContain(`'${WATCHED_GLOB}'`);
    expect(source).not.toContain("'.github/**/*'");
    expect(source).not.toContain("'plugin.json'");
  });

  it('covers every native owner store and refreshes on their changes but not their locks', () => {
    const root = '/workspace';
    const glob = new Bun.Glob(WATCHED_GLOB);
    const stores = NATIVE_OBSERVATION_OWNERS.flatMap(owner => [
      getNativeSessionsPath(root, owner),
      getNativeBackgroundJobsPath(root, owner),
    ]);
    const featureProjection = path.join(root, '.hive', 'features', '01_feature', 'runtime', 'opencode-v2', 'sessions.json');
    const changes: string[] = [];
    new HiveWatcher(root, () => changes.push('refresh'));

    for (const file of [...stores, featureProjection]) {
      expect(glob.match(path.relative(root, file).split(path.sep).join('/'))).toBe(true);
      ui.watchers[0].change({ fsPath: file });
      ui.watchers[0].change({ fsPath: `${file}.lock` });
    }

    expect(changes).toHaveLength(stores.length + 1);
  });

  it('ignores lock anchors and worktree operation markers under .hive/.locks', () => {
    const root = '/workspace';
    const changes: string[] = [];
    new HiveWatcher(root, () => changes.push('refresh'));
    ui.watchers[0].change({ fsPath: path.join(root, '.hive', '.locks', `${'a'.repeat(64)}.lock`) });
    ui.watchers[0].create({ fsPath: path.join(root, '.hive', '.locks', 'operations', `${'b'.repeat(64)}.json`) });
    expect(changes).toEqual([]);
    ui.watchers[0].change({ fsPath: path.join(root, '.hive', 'features', '01_feature', 'plan.md') });
    expect(changes).toEqual(['refresh']);
  });
});
