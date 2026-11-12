import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { disposeTextDocument, resetVscodeTestState, vscodeTestDouble, vscodeTestState as ui } from '../test/vscodeTestDouble.js';
const hiveCore = await import('../../../hive-core/src/index.ts');
const { FeatureService, WorklogService } = hiveCore;

mock.module('hive-core', () => hiveCore);
mock.module('vscode', () => vscodeTestDouble);

const { activate } = await import('../extension');

const TEST_ROOT_BASE = `/tmp/vscode-hive-worklog-commands-${process.pid}`;

describe('worklog commands', () => {
  let root: string;
  let state: Map<string, unknown>;

  beforeEach(() => {
    resetVscodeTestState();
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    // Canonical, so expectations hold where the temporary directory is itself reached through a link.
    root = fs.realpathSync(fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'workspace-')));
    new FeatureService(root).create('checkout');
    new WorklogService(root).record(
      { kind: 'feature', featureName: 'checkout' },
      { operationId: 'first', title: 'Checkout rewrite', checkpoint: { summary: 'Plan approved' } },
      { owner: 'opencode-v1', sessionId: 'ses_a', agent: 'hive-master' },
    );
    state = new Map();
    ui.workspaceFolders = [{ uri: { fsPath: root } }];
    activate({
      subscriptions: [],
      workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } },
    } as never);
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
  });

  const run = (id: string, ...args: unknown[]) => vscodeTestDouble.commands.executeCommand(id, ...args);
  const shownQuery = (index: number) => new URLSearchParams(ui.shown[index].uri.query);

  it('opens, selects, pins, and follows editor-title URIs without writing under .hive', async () => {
    const before = fs.readFileSync(path.join(root, '.hive', 'features', '01_checkout', 'worklog.json'), 'utf8');
    expect(ui.treeViews.map(view => [view.id, view.description])).toEqual([['hive.worklogs', path.basename(root)], ['hive.repositories', undefined]]);

    await run('hive.worklog.open', 'feature:checkout');
    expect(shownQuery(0).get('key')).toBe('feature:checkout');
    expect(shownQuery(0).get('view')).toBe('brief');
    expect(shownQuery(0).get('project')).toBe(root);
    expect((state.get('hive.worklogs.viewer') as any).projects[root]).toEqual({ pins: [], selected: 'feature:checkout' });

    // Editor title actions pass the document URI rather than a tree row.
    await run('hive.worklog.showHistory', ui.shown[0].uri);
    expect(shownQuery(1).get('view')).toBe('history');
    expect(shownQuery(1).get('key')).toBe('feature:checkout');

    ui.activeTextEditor = { document: ui.shown[1] };
    await run('hive.worklog.pin');
    await run('hive.worklog.pin', { worklogKey: 'feature:checkout' });
    expect((state.get('hive.worklogs.viewer') as any).projects[root].pins).toEqual(['feature:checkout']);
    expect(ui.messages).toContain('Hive: feature:checkout is already pinned.');

    // Open always asks when it has no explicit key, even while a worklog document is active.
    ui.picks.push(undefined);
    await run('hive.worklog.open');
    expect(ui.pickItems.some((item: any) => item.detail === 'feature:checkout')).toBe(true);
    expect(ui.shown).toHaveLength(2);

    await run('hive.worklog.unpin', { worklogKey: 'feature:checkout' });
    expect((state.get('hive.worklogs.viewer') as any).projects[root].pins).toEqual([]);
    expect(fs.readFileSync(path.join(root, '.hive', 'features', '01_checkout', 'worklog.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(root, '.hive', 'sessions.json'))).toBe(false);
  });

  it('reads the project that placed a worker or retained checkout, not a .hive nested inside the checkout', async () => {
    for (const checkout of [path.join(root, '.hive', '.worktrees', 'adhoc', 'run'), path.join(root, '.hive', 'checkouts', 'root', 'release')]) {
      fs.mkdirSync(path.join(checkout, '.hive'), { recursive: true });
      resetVscodeTestState();
      ui.workspaceFolders = [{ uri: { fsPath: checkout } }];
      activate({ subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } } as never);

      expect(ui.treeViews.find(view => view.id === 'hive.worklogs')?.description, checkout).toBe(path.basename(root));
      await run('hive.worklog.open', 'feature:checkout');
      expect(shownQuery(0).get('project'), checkout).toBe(root);
    }
  });

  it('resolves a window opened through an alias of a placement to the project that holds it, and still recognizes a removed placement by its path', async () => {
    const placement = path.join(root, '.hive', 'checkouts', 'root', 'release');
    fs.mkdirSync(path.join(placement, '.hive'), { recursive: true });
    const alias = path.join(TEST_ROOT_BASE, 'release-alias');
    fs.symlinkSync(placement, alias);
    const removed = path.join(root, '.hive', 'checkouts', 'root', 'removed');
    for (const folder of [alias, removed]) {
      resetVscodeTestState();
      ui.workspaceFolders = [{ uri: { fsPath: folder } }];
      activate({ subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } } as never);

      expect(ui.treeViews.find(view => view.id === 'hive.worklogs')?.description, folder).toBe(path.basename(root));
      await run('hive.worklog.open', 'feature:checkout');
      expect(shownQuery(0).get('project'), folder).toBe(root);
    }
  });

  it('keeps the placement an alias names when the window opens a folder below it that does not exist', async () => {
    const placement = path.join(root, '.hive', 'checkouts', 'root', 'release');
    fs.mkdirSync(path.join(placement, '.hive'), { recursive: true });
    const alias = path.join(TEST_ROOT_BASE, 'release-alias');
    fs.symlinkSync(placement, alias);
    resetVscodeTestState();
    ui.workspaceFolders = [{ uri: { fsPath: path.join(alias, 'missing', 'deeper') } }];
    activate({ subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } } as never);

    await run('hive.worklog.open', 'feature:checkout');
    expect(shownQuery(0).get('project')).toBe(root);
  });

  it('reviews a plan or overview opened through an alias of the project folder the window opened', async () => {
    const alias = path.join(TEST_ROOT_BASE, 'project-alias');
    fs.symlinkSync(root, alias);
    const feature = path.join(alias, '.hive', 'features', '01_checkout');
    const plan = path.join(feature, 'plan.md');
    const overview = path.join(feature, 'context', 'overview.md');
    fs.writeFileSync(plan, '# Plan\n');
    fs.mkdirSync(path.join(feature, 'comments'), { recursive: true });
    fs.writeFileSync(path.join(feature, 'comments', 'plan.json'), JSON.stringify({ threads: [{ id: 't1', line: 0, body: 'Tighten scope', replies: [] }] }));
    resetVscodeTestState();
    ui.workspaceFolders = [{ uri: { fsPath: alias } }];
    activate({ subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } } as never);

    // The editor names documents by the folder the window opened, so the alias spelling must route to the review.
    const [controller] = ui.commentControllers;
    for (const fileName of [plan, overview]) {
      expect(controller.commentingRangeProvider.provideCommentingRanges({ fileName, lineCount: 2 }), fileName).toHaveLength(1);
    }
    for (const fileName of [plan, overview]) {
      ui.activeTextEditor = { document: { uri: { fsPath: fileName } } };
      ui.inputs.push('');
      await run('hive.plan.doneReview');
    }
    expect(ui.errors).toEqual([]);
    expect(ui.clipboard).toEqual(['Plan review comments:\nLine 0: Tighten scope', 'Overview approved']);
  });

  it('opens no project for a folder it cannot resolve to the project that governs it, and says so on refresh', async () => {
    const other = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'other-'));
    new FeatureService(other).create('elsewhere');
    // An alias inside `root` to a removed placement of `other` must never select `root`.
    const dangling = path.join(root, 'removed-alias');
    fs.symlinkSync(path.join(other, '.hive', 'checkouts', 'root', 'removed'), dangling);
    const replacedByFile = path.join(root, '.hive', 'checkouts', 'root', 'replaced');
    fs.mkdirSync(path.dirname(replacedByFile), { recursive: true });
    fs.writeFileSync(replacedByFile, '');
    const cycle = path.join(root, 'cycle');
    fs.symlinkSync(cycle, cycle);
    // A removed placement whose project lost its .hive must not fall back to an outer project either.
    const outer = path.join(root, 'nested-project');
    const unmanaged = path.join(outer, '.hive', 'checkouts', 'root', 'removed');
    fs.mkdirSync(outer, { recursive: true });
    // A .hive that exists but cannot be used as a project stops the search instead of opening `root` above it.
    const fileHive = path.join(root, 'file-hive');
    fs.mkdirSync(fileHive);
    fs.writeFileSync(path.join(fileHive, '.hive'), '');
    const danglingHive = path.join(root, 'dangling-hive');
    fs.mkdirSync(danglingHive);
    fs.symlinkSync(path.join(root, 'gone'), path.join(danglingHive, '.hive'));
    // Simulated rather than chmod, which does not deny a privileged test process.
    const denied = path.join(root, 'denied');
    fs.mkdirSync(path.join(denied, '.hive'), { recursive: true });
    const statSync = fs.statSync;
    const stat = spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, ...rest: never[]) => {
      if (target === path.join(denied, '.hive')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return (statSync as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.statSync);
    // A .hive directory that stat reports but whose entries cannot be listed or searched.
    const unsearchable = path.join(root, 'unsearchable');
    fs.mkdirSync(path.join(unsearchable, '.hive'), { recursive: true });
    const accessSync = fs.accessSync;
    const access = spyOn(fs, 'accessSync').mockImplementation(((target: fs.PathLike, mode?: number) => {
      if (target === path.join(unsearchable, '.hive')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return accessSync(target, mode);
    }) as typeof fs.accessSync);
    // A .hive that stat and access accept but that cannot be listed, as on Windows, where access ignores ACLs.
    const unlistable = path.join(root, 'unlistable');
    fs.mkdirSync(path.join(unlistable, '.hive'), { recursive: true });
    const readdirSync = fs.readdirSync;
    const readdir = spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, ...rest: never[]) => {
      if (target === path.join(unlistable, '.hive')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return (readdirSync as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readdirSync);

    const notDirectory = (project: string) => `Hive: No project opened. ${path.join(project, '.hive')} is not a directory, so the search for a Hive project stopped there. Open the Hive project folder, then refresh this view.`;
    const unresolved = (folder: string) => `Hive: No project opened. ${folder} could not be resolved: a link in its path is broken, part of it is a file, or it cannot be read. Open the Hive project folder, then refresh this view.`;
    const cases: Array<[string, string]> = [
      [dangling, unresolved(dangling)],
      [path.join(dangling, 'sub'), unresolved(path.join(dangling, 'sub'))],
      [replacedByFile, unresolved(replacedByFile)],
      [path.join(replacedByFile, 'sub'), unresolved(path.join(replacedByFile, 'sub'))],
      [cycle, unresolved(cycle)],
      [unmanaged, 'Hive: No .hive directory found. Open a Hive workspace, then refresh this view.'],
      [fileHive, notDirectory(fileHive)],
      [danglingHive, notDirectory(danglingHive)],
      [path.join(denied, 'sub'), `Hive: No project opened. ${path.join(denied, '.hive')} could not be read (EACCES), so the search for a Hive project stopped there. Check its permissions or open the Hive project folder, then refresh this view.`],
      [unsearchable, `Hive: No project opened. ${path.join(unsearchable, '.hive')} could not be read (EACCES), so the search for a Hive project stopped there. Check its permissions or open the Hive project folder, then refresh this view.`],
      [unlistable, `Hive: No project opened. ${path.join(unlistable, '.hive')} could not be read (EACCES), so the search for a Hive project stopped there. Check its permissions or open the Hive project folder, then refresh this view.`],
    ];
    try {
      for (const [folder, warning] of cases) {
        resetVscodeTestState();
        ui.workspaceFolders = [{ uri: { fsPath: folder } }];
        expect(() => activate({ subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } } as never), folder).not.toThrow();
        expect(ui.treeViews, folder).toEqual([]);
        await run('hive.refresh');
        expect(ui.treeViews, folder).toEqual([]);
        expect(ui.warnings, folder).toEqual([warning]);
      }
    } finally {
      stat.mockRestore();
      access.mockRestore();
      readdir.mockRestore();
    }
  });

  it('ignores Load More for a worklog document from another project', async () => {
    await run('hive.worklog.showHistory', 'feature:checkout');
    const local = ui.shown[0];
    const before = local.getText();
    ui.messages = [];
    ui.fired = [];
    for (const view of ['brief', 'history', 'facts']) {
      const query = new URLSearchParams({ project: '/some/other/project', key: 'feature:checkout', view }).toString();
      await run('hive.worklog.loadMore', vscodeTestDouble.Uri.from({ scheme: 'hive-worklog', path: '/Worklog feature:checkout', query }));
    }
    expect(ui.messages).toEqual(Array(3).fill(`Hive: This worklog document belongs to project /some/other/project, not ${root}. Nothing was loaded.`));
    expect(ui.fired).toEqual([]);
    expect(ui.shown).toHaveLength(1);
    expect(ui.textDocuments).toHaveLength(1);
    expect(local.getText()).toBe(before);
    expect((state.get('hive.worklogs.viewer') as any).projects[root].selected).toBe('feature:checkout');
  });

  it('keeps history paging, refresh, and links across a language change and releases them when the document is disposed', async () => {
    fs.writeFileSync(path.join(root, 'notes.md'), 'notes');
    const ref = { kind: 'feature' as const, featureName: 'checkout' };
    const author = { owner: 'opencode-v1' as const, sessionId: 'ses_a', agent: 'hive-master' };
    const service = new WorklogService(root);
    service.record(ref, { operationId: 'cited', checkpoint: { summary: 'Cited notes', references: [{ kind: 'path', path: 'notes.md' }] } }, author);
    for (let index = 3; index <= 12; index++) service.record(ref, { operationId: `op-${index}`, checkpoint: { summary: `Checkpoint ${index}` } }, author);

    await run('hive.worklog.showHistory', 'feature:checkout');
    const document = ui.shown[0];
    const [documents] = ui.linkProviders;
    const links = () => documents.provideDocumentLinks(document).map((link: any) => link.target.fsPath);
    expect(document.getText()).toContain('2 older checkpoints not loaded.');
    await run('hive.worklog.loadMore', document.uri);
    expect(document.getText()).toContain('#1 · ');
    expect(document.getText()).toContain('End of history.');
    expect(links()).toEqual([path.join(root, 'notes.md')]);

    const rendered = document.getText();
    await vscodeTestDouble.languages.setTextDocumentLanguage(document, 'markdown');
    expect(document.getText()).toBe(rendered);
    expect(links()).toEqual([path.join(root, 'notes.md')]);

    service.record(ref, { operationId: 'after-language', checkpoint: { summary: 'Checkpoint 13' } }, author);
    await run('hive.refresh');
    expect(document.getText()).toContain('1 newer checkpoint has been recorded since.');
    expect(document.getText()).toContain('#1 · ');
    expect(document.getText()).not.toContain('Checkpoint 13');
    ui.messages = [];
    await run('hive.worklog.loadMore', document.uri);
    expect(ui.messages).toEqual(['Hive: No older checkpoints to load.']);

    disposeTextDocument(document);
    expect(links()).toEqual([]);
    ui.fired = [];
    await run('hive.refresh');
    expect(ui.fired.some((uri: any) => uri?.toString() === document.uri.toString())).toBe(false);

    const reopened = await vscodeTestDouble.workspace.openTextDocument(document.uri);
    expect(reopened).not.toBe(document);
    expect(reopened.getText()).toContain('Checkpoint 13');
    expect(reopened.getText()).not.toContain('#1 · ');
    expect(reopened.getText()).toContain('older checkpoints not loaded.');
  });

  it('rejects an invalid key without changing the selection', async () => {
    await run('hive.worklog.open', 'feature:checkout');
    await run('hive.worklog.open', 'not-a-key');
    expect(ui.errors.some(message => message.includes('not-a-key is not a worklog key'))).toBe(true);
    expect((state.get('hive.worklogs.viewer') as any).projects[root].selected).toBe('feature:checkout');
    expect(ui.shown).toHaveLength(1);
  });
});
