import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
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
    root = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'workspace-'));
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
    expect(ui.treeViews.map(view => [view.id, view.description])).toEqual([['hive.worklogs', path.basename(root)]]);

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
