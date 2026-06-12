import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
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

describe('TrackedRepositoriesProvider', () => {
  let testRoot: string;

  beforeEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'workspace-'));
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
  });

  it('shows a legacy root state when the manifest is missing', async () => {
    const provider = new TrackedRepositoriesProvider(testRoot);

    const children = await provider.getChildren();

    expect(children.map(item => item.label)).toEqual(['Legacy single-root workspace']);
    expect((children[0] as any).description).toBe('Missing .hive/agent-hive.json');
    expect((children[0] as any).command).toBeUndefined();
  });

  it('shows a legacy root state when no repositories are configured', async () => {
    writeManifest({ sandbox: 'none', repositories: [] });
    const provider = new TrackedRepositoriesProvider(testRoot);

    const children = await provider.getChildren();

    expect(children.map(item => item.label)).toEqual(['Legacy single-root workspace']);
    expect((children[0] as any).description).toBe('No tracked repositories configured');
  });

  it('shows configured repositories with resolved paths', async () => {
    fs.mkdirSync(path.join(testRoot, 'packages', 'api'), { recursive: true });
    writeManifest({ repositories: [{ id: 'api', path: './packages/api' }, { id: 'web', path: './packages/web' }] });
    const provider = new TrackedRepositoriesProvider(testRoot);

    const children = await provider.getChildren();

    expect(children.map(item => item.label)).toEqual(['api', 'web']);
    expect((children[0] as any).description).toBe('./packages/api');
    expect((children[0] as any).tooltip).toContain(path.join(testRoot, 'packages', 'api'));
    expect((children[1] as any).tooltip).toContain(path.join(testRoot, 'packages', 'web'));
  });

  it('shows invalid JSON as an error state', async () => {
    fs.mkdirSync(path.join(testRoot, '.hive'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, '.hive', 'agent-hive.json'), '{ invalid json');
    const provider = new TrackedRepositoriesProvider(testRoot);

    const children = await provider.getChildren();
    expect(children.map(item => item.label)).toEqual(['Unable to read tracked repositories']);
    expect((children[0] as any).description).toBe('Invalid .hive/agent-hive.json');
  });

  it('exposes safe repo path and repo ID command metadata', async () => {
    writeManifest({ repositories: [{ id: 'core', path: './packages/hive-core' }] });
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
    fs.mkdirSync(path.join(testRoot, '.hive'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, '.hive', 'agent-hive.json'), JSON.stringify(data, null, 2));
  }
});
