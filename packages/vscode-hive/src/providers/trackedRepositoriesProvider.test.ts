import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

mock.module('vscode', () => {
  class TreeItem {
    label: string;
    collapsibleState: number;
    description?: string;
    contextValue?: string;
    iconPath?: unknown;
    command?: unknown;
    tooltip?: unknown;

    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }

  class ThemeIcon {
    constructor(public readonly id: string) {}
  }

  class EventEmitter<T> {
    readonly event = (_listener: (value: T | undefined) => void) => ({ dispose() {} });
    fire(_value: T | undefined): void {}
  }

  return {
    TreeItem,
    ThemeIcon,
    EventEmitter,
    Uri: {
      file(targetPath: string) {
        return { fsPath: targetPath };
      },
      parse(value: string) {
        return { value };
      },
    },
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
  };
});

const { TrackedRepositoriesProvider } = await import('./trackedRepositoriesProvider');

const TEST_ROOT_BASE = `/tmp/vscode-hive-repositories-test-${process.pid}`;

const initGitRepo = (root: string): void => {
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
};

describe('TrackedRepositoriesProvider', () => {
  let testRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'workspace-'));
    originalHome = process.env.HOME;
    process.env.HOME = path.join(TEST_ROOT_BASE, 'home');
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  it('shows a legacy root state when the manifest is missing', async () => {
    initGitRepo(testRoot);
    const provider = new TrackedRepositoriesProvider(testRoot);

    const children = await provider.getChildren();

    expect(children.map(item => item.label)).toEqual(['Legacy single-root workspace']);
    expect((children[0] as any).description).toBe('Missing project repository manifest');
    expect((children[0] as any).command).toBeUndefined();
  });

  it('shows an invalid config state when the scoped manifest is empty', async () => {
    writeManifest({ schemaVersion: 1, repositories: [] });
    const provider = new TrackedRepositoriesProvider(testRoot);

    const children = await provider.getChildren();

    expect(children.map(item => item.label)).toEqual(['Unable to read tracked repositories']);
    expect((children[0] as any).description).toBe('Invalid repository manifest');
  });

  it('shows configured repositories with resolved paths', async () => {
    initGitRepo(path.join(testRoot, 'packages', 'api'));
    initGitRepo(path.join(testRoot, 'packages', 'web'));
    writeManifest({ schemaVersion: 1, repositories: [{ id: 'api', path: './packages/api' }, { id: 'web', path: './packages/web' }] });
    const provider = new TrackedRepositoriesProvider(testRoot);

    const children = await provider.getChildren();

    expect(children.map(item => item.label)).toEqual(['api', 'web']);
    expect((children[0] as any).description).toBe('./packages/api');
    expect((children[0] as any).tooltip).toContain(path.join(testRoot, 'packages', 'api'));
    expect((children[1] as any).tooltip).toContain(path.join(testRoot, 'packages', 'web'));
  });

  it('shows repositories when the workspace is a symlink alias of the canonical project root', async () => {
    const workspaceAlias = path.join(TEST_ROOT_BASE, 'workspace-alias');
    initGitRepo(path.join(testRoot, 'packages', 'api'));
    fs.symlinkSync(testRoot, workspaceAlias);
    writeManifest({ schemaVersion: 1, repositories: [{ id: 'api', path: './packages/api' }] });

    const children = await new TrackedRepositoriesProvider(workspaceAlias).getChildren();

    expect(children.map(item => item.label)).toEqual(['api']);
  });

  it('shows invalid JSON as an error state', async () => {
    const configPath = path.join(testRoot, '.hive', 'repositories.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ invalid json');
    const provider = new TrackedRepositoriesProvider(testRoot);

    const children = await provider.getChildren();
    expect(children.map(item => item.label)).toEqual(['Unable to read tracked repositories']);
    expect((children[0] as any).description).toBe('Invalid repository manifest');
  });

  it('shows a whole-file validation error instead of accepting repository data', async () => {
    writeManifest({ schemaVersion: 1, repositories: [{ id: 'api', path: './api' }], extra: true });
    const children = await new TrackedRepositoriesProvider(testRoot).getChildren();

    expect(children.map(item => item.label)).toEqual(['Unable to read tracked repositories']);
    expect((children[0] as any).description).toBe('Invalid repository manifest');
  });

  it('does not expose an open command for a repository symlink outside the workspace', async () => {
    const externalRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'external-'));
    execFileSync('git', ['init'], { cwd: externalRoot, stdio: 'ignore' });
    fs.symlinkSync(externalRoot, path.join(testRoot, 'external'));
    writeManifest({ schemaVersion: 1, repositories: [{ id: 'external', path: './external' }] });

    const children = await new TrackedRepositoriesProvider(testRoot).getChildren();

    expect(children.map(item => item.label)).toEqual(['Unable to read tracked repositories']);
    expect((children[0] as any).command).toMatchObject({ arguments: [expect.stringContaining('repositories.json')] });
  });

  it('exposes safe repo path and repo ID command metadata', async () => {
    initGitRepo(path.join(testRoot, 'packages', 'hive-core'));
    writeManifest({ schemaVersion: 1, repositories: [{ id: 'core', path: './packages/hive-core' }] });
    const provider = new TrackedRepositoriesProvider(testRoot);

    const children = await provider.getChildren();

    expect((children[0] as any).command).toMatchObject({
      command: 'hive.openFile',
      arguments: [path.join(testRoot, 'packages', 'hive-core')],
    });
    expect((children[0] as any).copyCommand).toMatchObject({
      command: 'hive.copyToClipboard',
      arguments: ['core'],
    });
    expect((children[0] as any).contextValue).toBe('tracked-repository');
  });

  function writeManifest(data: unknown): void {
    const configPath = path.join(testRoot, '.hive', 'repositories.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
  }
});
