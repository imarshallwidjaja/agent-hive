import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FeatureService, RetainedCheckoutService, TaskService, getFeaturePath } from 'hive-core';
import { resetVscodeTestState, vscodeTestDouble, vscodeTestState as ui } from '../test/vscodeTestDouble.js';

mock.module('vscode', () => vscodeTestDouble);

const { removeStaleCheckoutRecord } = await import('./staleCheckoutRecord');
const { activate } = await import('../extension');

const TEST_ROOT_BASE = `/tmp/vscode-hive-stale-checkout-${process.pid}`;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A canonical Git project under TEST_ROOT_BASE with one commit and .hive ignored. */
function createProject(prefix: string): string {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(TEST_ROOT_BASE, prefix)));
  git(TEST_ROOT_BASE, 'init', '-b', 'main', project);
  git(project, 'config', 'user.email', 'test@example.com');
  git(project, 'config', 'user.name', 'Test User');
  fs.writeFileSync(path.join(project, '.gitignore'), '.hive/\n');
  git(project, 'add', '.gitignore');
  git(project, 'commit', '-m', 'chore: base\n\nCreate the fixture history.');
  return project;
}

/** Every row of the Repositories & Work tree, depth first. */
async function rows(provider: any, element?: any): Promise<any[]> {
  const found: any[] = [];
  for (const child of await provider.getChildren(element)) {
    found.push(child);
    if (child.collapsibleState !== 0 && !child.id.endsWith('/other-branches')) found.push(...await rows(provider, child));
  }
  return found;
}

describe('Remove Stale Hive Record', () => {
  let root: string;
  let hiveDir: string;
  let checkouts: RetainedCheckoutService;
  let refreshed: number;
  const refresh = () => { refreshed += 1; };

  beforeEach(() => {
    resetVscodeTestState();
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    root = createProject('workspace-');
    hiveDir = path.join(root, '.hive');
    checkouts = new RetainedCheckoutService({ baseDir: root, hiveDir });
    refreshed = 0;
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
  });

  it('removes only the record from the row menu after one confirmation naming the canonical project, checkout and effect', async () => {
    const feature = await checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    const recordPath = `${feature.path}.json`;
    const tip = git(root, 'rev-parse', 'refs/heads/feat/x');
    fs.rmSync(feature.path, { recursive: true, force: true });
    const registrations = git(root, 'worktree', 'list', '--porcelain');
    // The window is opened through an alias; the confirmation still names the canonical project.
    const alias = path.join(TEST_ROOT_BASE, 'alias');
    fs.symlinkSync(root, alias);
    ui.workspaceFolders = [{ uri: { fsPath: alias } }];
    activate({ subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } } as never);
    const provider = ui.treeViews.find(view => view.id === 'hive.repositories').options.treeDataProvider;
    const row = (await rows(provider)).find(candidate => candidate.id === 'checkout:root/feature');
    expect(row.checkoutId).toBe('root/feature');

    ui.confirmations.push(undefined);
    await vscodeTestDouble.commands.executeCommand('hive.repositories.removeStaleRecord', row);
    expect(fs.existsSync(recordPath)).toBe(true);
    expect(ui.messages).toEqual([]);

    ui.confirmations.push('Remove Record');
    await vscodeTestDouble.commands.executeCommand('hive.repositories.removeStaleRecord', row);
    expect(ui.warnings).toEqual(['Remove the stale Hive record for root/feature?', 'Remove the stale Hive record for root/feature?']);
    const [options, button] = ui.warningArgs[1]!;
    expect(button).toBe('Remove Record');
    expect(options).toEqual({
      modal: true,
      detail: [
        `Project: ${root}`,
        'Checkout: root/feature',
        'Intended branch: feat/x',
        `Missing directory: ${feature.path}`,
        `Record file: ${recordPath}`,
        '',
        'Only the record file is deleted. Git is read but not changed: branches and every Git worktree registration stay as they are.',
      ].join('\n'),
    });
    expect(fs.existsSync(recordPath)).toBe(false);
    expect(ui.messages).toEqual(['Hive: Removed the stale record for root/feature. Branch feat/x is unchanged.']);
    expect(git(root, 'rev-parse', 'refs/heads/feat/x')).toBe(tip);
    expect(git(root, 'worktree', 'list', '--porcelain')).toBe(registrations);
    expect((await rows(provider)).some(candidate => candidate.id === 'checkout:root/feature')).toBe(false);
  });

  it('removes the record from the project the row was read from after the window folder alias is pointed at another project', async () => {
    const other = createProject('other-');
    const otherCheckouts = new RetainedCheckoutService({ baseDir: other, hiveDir: path.join(other, '.hive') });
    const feature = await checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    const otherFeature = await otherCheckouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    fs.rmSync(feature.path, { recursive: true, force: true });
    fs.rmSync(otherFeature.path, { recursive: true, force: true });
    const alias = path.join(TEST_ROOT_BASE, 'alias');
    fs.symlinkSync(root, alias);
    ui.workspaceFolders = [{ uri: { fsPath: alias } }];
    activate({ subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } } as never);
    const provider = ui.treeViews.find(view => view.id === 'hive.repositories').options.treeDataProvider;
    const row = (await rows(provider)).find(candidate => candidate.id === 'checkout:root/feature');

    // Same checkout ID in both projects: only the project the row was read from may lose its record.
    fs.unlinkSync(alias);
    fs.symlinkSync(other, alias);
    ui.confirmations.push('Remove Record');
    await vscodeTestDouble.commands.executeCommand('hive.repositories.removeStaleRecord', row);

    expect(ui.warningArgs[0]![0].detail).toStartWith(`Project: ${root}\n`);
    expect(fs.existsSync(`${feature.path}.json`)).toBe(false);
    expect(fs.existsSync(`${otherFeature.path}.json`)).toBe(true);
  });

  it('does not remove or retry when the record changes or disappears after confirmation, or its directory returns', async () => {
    const feature = await checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    const recordPath = `${feature.path}.json`;
    fs.rmSync(feature.path, { recursive: true, force: true });
    const row = { checkoutId: 'root/feature' };

    const changed = { ...JSON.parse(fs.readFileSync(recordPath, 'utf8')), purpose: 'reused by another agent' };
    ui.confirmations.push(() => {
      fs.writeFileSync(recordPath, JSON.stringify(changed));
      return 'Remove Record';
    });
    await removeStaleCheckoutRecord(root, row, refresh);
    expect(ui.warnings).toHaveLength(1);
    expect(ui.errors).toEqual(['Hive: Could not remove the record for root/feature. Retained checkout record root/feature changed since it was inspected; inspect it again']);
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8'))).toEqual(changed);
    expect(refreshed).toBe(1);

    // Another window removes the record while the confirmation is open; the failure claims nothing about the file.
    const original = JSON.stringify({ ...changed, purpose: undefined });
    fs.writeFileSync(recordPath, original);
    ui.confirmations.push(() => {
      fs.rmSync(recordPath);
      return 'Remove Record';
    });
    await removeStaleCheckoutRecord(root, row, refresh);
    expect(ui.errors.at(-1)).toBe('Hive: Could not remove the record for root/feature. Retained checkout root/feature is not recorded');
    expect(fs.existsSync(recordPath)).toBe(false);
    expect(refreshed).toBe(2);
    fs.writeFileSync(recordPath, original);

    git(root, 'worktree', 'add', '-f', feature.path, 'feat/x');
    await removeStaleCheckoutRecord(root, row, refresh);
    expect(ui.warnings).toHaveLength(2);
    expect(ui.messages).toEqual(['Hive: root/feature is no longer a missing managed checkout, so its record was kept.']);
    expect(fs.existsSync(recordPath)).toBe(true);

    await removeStaleCheckoutRecord(root, { location: { path: feature.path } }, refresh);
    expect(ui.errors.at(-1)).toBe('Hive: Select a missing retained checkout in Repositories & Work.');
  });

  it('lists what still names the checkout instead of offering removal, and opens only the regular project file that holds a reference', async () => {
    const feature = await checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    const release = await checkouts.create({ id: 'root/release', branch: 'release', baseRef: 'main' });
    await checkouts.setReadiness('root/release', { path: release.path, ref: release.ref, commit: git(release.path, 'rev-parse', 'HEAD') }, { state: 'ready', nextTarget: 'root/feature' });
    // A targeted run whose worktree was removed while its binding stayed.
    const worker = { path: path.join(hiveDir, '.worktrees', 'adhoc', 'bound') };
    fs.mkdirSync(path.dirname(worker.path), { recursive: true });
    fs.writeFileSync(`${worker.path}.json`, JSON.stringify({
      schemaVersion: 1,
      mode: 'adhoc-targeted',
      runId: 'bound',
      repoId: 'root',
      worktreePath: worker.path,
      repositoryPath: root,
      branch: 'hive-targeted/adhoc/bound',
      baseCommit: git(root, 'rev-parse', 'HEAD'),
      target: { id: 'root/feature', path: feature.path, ref: feature.ref },
      createdAt: '2026-11-12T00:00:00.000Z',
    }));
    new FeatureService(root).create('demo');
    const task = new TaskService(root).create('demo', 'Ship it', undefined, { target: 'root/feature' });
    const legacyStatus = path.join(hiveDir, 'features', 'old', 'execution', '01-legacy', 'status.json');
    fs.mkdirSync(path.dirname(legacyStatus), { recursive: true });
    fs.writeFileSync(legacyStatus, JSON.stringify({ status: 'pending', origin: 'plan', target: 'root/feature' }));
    fs.writeFileSync(path.join(hiveDir, 'checkouts', 'root', 'broken.json'), '{');
    const commonDirectory = fs.realpathSync(path.join(root, '.git'));
    const legacyLock = path.join(hiveDir, '.operation-locks', `${createHash('sha256').update(commonDirectory).digest('hex')}.lock`);
    fs.mkdirSync(path.dirname(legacyLock), { recursive: true });
    fs.writeFileSync(legacyLock, '{}');
    fs.rmSync(feature.path, { recursive: true, force: true });
    const statusPath = path.join(getFeaturePath(root, 'demo'), 'tasks', task, 'status.json');
    const relative = (target: string) => path.relative(root, target);

    const open = async (choose: (items: any[]) => any) => {
      ui.picks.push(choose);
      await removeStaleCheckoutRecord(root, { checkoutId: 'root/feature' }, refresh);
      return ui.executed.filter(entry => entry.id === 'vscode.open').map(entry => entry.args[0].fsPath);
    };
    expect(await open(() => undefined)).toEqual([]);
    expect(ui.pickOptions[0]).toMatchObject({ title: 'Cannot remove the record for root/feature yet' });
    expect(ui.pickItems.map((item: any) => [item.label, item.description, item.detail])).toEqual([
      ['$(tasklist) Task old/01-legacy', 'pending', relative(legacyStatus)],
      ['$(tasklist) Task demo/' + task, 'pending', relative(statusPath)],
      ['$(repo-forked) Worker run bound', 'bound to this checkout', relative(`${worker.path}.json`)],
      ['$(git-branch) Checkout root/release', 'declares this checkout as its next target', relative(`${release.path}.json`)],
      ['$(warning) Unreadable source', '.hive/checkouts/root/broken.json', expect.stringContaining('Invalid JSON')],
      ['$(warning) Interrupted worktree operation', expect.stringMatching(/^legacy:/), 'legacy_lock; once its processes have stopped, ask an agent to inspect this entry with Hive worktree recovery and follow what recovery reports'],
    ]);
    // Unreadable sources and interrupted operations are text; they carry no file to open.
    expect(ui.pickItems.slice(4).every((item: any) => item.file === undefined)).toBe(true);

    for (const [index, file] of [[0, legacyStatus], [1, statusPath], [2, `${worker.path}.json`], [3, `${release.path}.json`]] as const) {
      ui.executed = [];
      expect(await open(items => items[index])).toEqual([file]);
    }
    // Removal was never offered and the record is still there.
    expect(ui.warnings).toEqual([]);
    expect(fs.existsSync(`${feature.path}.json`)).toBe(true);

    // A file replaced by a symlink after the inspection is not opened.
    ui.executed = [];
    expect(await open(items => {
      fs.rmSync(statusPath);
      fs.symlinkSync(legacyStatus, statusPath);
      return items[1];
    })).toEqual([]);
    expect(ui.warnings).toEqual([`Hive: Did not open ${relative(statusPath)}: crosses a symbolic link.`]);
  });

  it('says when Hive worktree recovery cannot acknowledge an interrupted operation, and opens nothing for it', async () => {
    const feature = await checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    fs.rmSync(feature.path, { recursive: true, force: true });
    const reason = 'The workspace or repository this record locks cannot be identified from the current project; it is preserved for manual inspection.';
    const service = {
      inspectCleanup: async (id: string) => {
        const proposal = await checkouts.inspectCleanup(id);
        const operation = { operationId: 'unreadable:marker', state: 'unreadable_marker', markerPaths: [path.join(hiveDir, '.locks', 'operations', 'marker')], recovery: { available: false, reason } };
        return { ...proposal, pendingOperations: [operation], blockers: ['an interrupted worktree operation guards this repository'] } as any;
      },
      removeMissingRecord: async () => { throw new Error('removal must not be offered'); },
    };
    ui.picks.push((items: any[]) => items[0]);
    await removeStaleCheckoutRecord(root, { checkoutId: 'root/feature' }, refresh, service);
    expect(ui.pickItems.map((item: any) => [item.label, item.description, item.detail, item.file])).toEqual([
      ['$(warning) Interrupted worktree operation', 'unreadable:marker', `unreadable_marker; Hive worktree recovery cannot acknowledge it: ${reason}`, undefined],
    ]);
    expect(ui.executed.filter(entry => entry.id === 'vscode.open')).toEqual([]);
    expect(ui.warnings).toEqual([]);
  });

  it('reports a project root that can no longer be resolved instead of inspecting anything', async () => {
    const gone = path.join(TEST_ROOT_BASE, 'removed-project');
    await removeStaleCheckoutRecord(gone, { checkoutId: 'root/feature' }, refresh);
    expect(ui.errors).toEqual([expect.stringMatching(new RegExp(`^Hive: Could not open the Hive project at ${gone}\\. ENOENT`))]);
    expect(ui.warnings).toEqual([]);
    expect(refreshed).toBe(1);
  });

  it('reports a removal whose operation could not finish cleanly as a warning, not a clean success', async () => {
    const feature = await checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main' });
    fs.rmSync(feature.path, { recursive: true, force: true });
    const service = {
      inspectCleanup: (id: string) => checkouts.inspectCleanup(id),
      removeMissingRecord: async (id: string, record: any) => ({
        ...await checkouts.removeMissingRecord(id, record),
        finalization: { markers: 'not_published' as const, lockReleaseError: 'EPERM: lock busy', action: 'inspect_state' as const },
      }),
    };
    ui.confirmations.push('Remove Record');
    await removeStaleCheckoutRecord(root, { checkoutId: 'root/feature' }, refresh, service);
    expect(fs.existsSync(`${feature.path}.json`)).toBe(false);
    expect(ui.messages).toEqual([]);
    expect(ui.warnings.at(-1)).toBe("Hive: Removed the stale record for root/feature, but finishing the operation failed: EPERM: lock busy. The removal stands. An operation lock that could not be released is freed when this window's extension host exits.");
    expect(refreshed).toBe(1);
  });
});
