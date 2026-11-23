import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { resetVscodeTestState, vscodeTestDouble, vscodeTestState as ui } from '../test/vscodeTestDouble.js';
const hiveCore = await import('../../../hive-core/src/index.ts');
const { ExplorationService, FeatureService } = hiveCore;

mock.module('hive-core', () => hiveCore);
mock.module('vscode', () => vscodeTestDouble);

const { activate } = await import('../extension');

const TEST_ROOT_BASE = `/tmp/vscode-hive-exploration-viewer-${process.pid}`;
const AGENT = { owner: 'opencode-v2', sessionId: 'ses_fixture', agent: 'hive-builder' } as const;

describe('exploration viewer', () => {
  let root: string;
  let explorations: string;
  let service: InstanceType<typeof ExplorationService>;

  beforeEach(() => {
    resetVscodeTestState();
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    root = fs.realpathSync(fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'workspace-')));
    new FeatureService(root).create('checkout');
    explorations = path.join(root, '.hive', 'explorations');
    service = new ExplorationService(root);
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
  });

  const start = () => {
    ui.workspaceFolders = [{ uri: { fsPath: root } }];
    activate({ subscriptions: [], workspaceState: { get: () => undefined, update: async () => { throw new Error('the viewer writes no workspace state'); } } } as never);
  };
  const run = (id: string, ...args: unknown[]) => vscodeTestDouble.commands.executeCommand(id, ...args);
  const tree = () => ui.treeViews.find((view) => view.id === 'hive.explorations').options.treeDataProvider;
  const watcher = () => ui.watchers.at(-1);
  const stored = (placement: 'active' | 'closed', id: string) => ({ fsPath: path.join(explorations, placement, `${id}.json`) });
  const renders = (panel: any) => panel.webview.posted.filter((message: any) => message.type === 'render');
  const lastModel = (panel: any) => renders(panel).at(-1).model;
  const changedKeys = (model: any) => [...model.targets, ...model.observations].filter((node: any) => node.changed).map((node: any) => node.key);
  const update = (id: string, expectedRevision: number, change: Record<string, unknown>) =>
    service.update({ id, expectedRevision, ...change } as never, AGENT);
  /** Every path under .hive with its content, to prove the viewer wrote nothing. */
  const snapshot = () => fs.readdirSync(path.join(root, '.hive'), { recursive: true, withFileTypes: true })
    .map((entry) => path.join(entry.parentPath, entry.name))
    .map((file) => `${file}:${fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'utf8') : 'dir'}`)
    .sort();

  /** A live debugging exploration with every frontier state and a supersedes chain beside an isolated observation. */
  const seedLogin = () => {
    update('flaky-login', 0, {
      goal: 'Find why login fails intermittently',
      subject: 'root/main (src/auth)',
      frontier: [
        { key: 'session-store', target: 'src/auth/session.ts', state: 'covered', evidence: 'Writes are awaited.' },
        { key: 'retry', target: 'Retry policy', state: 'open', question: 'Does a retry reuse the expired token?' },
        { key: 'idp', target: 'Identity provider logs', state: 'blocked', reason: 'No access to production logs.' },
        { key: 'cache', target: 'CDN cache', state: 'dropped', reason: 'Login responses are not cached.' },
      ],
      observations: [
        { key: 'clock-skew', summary: 'Clock skew expires tokens early', status: 'confirmed', refs: ['src/auth/token.ts:40'] },
        { key: 'race', summary: 'Two refreshes race', status: 'hypothesis' },
      ],
    });
    update('flaky-login', 1, {
      observations: [
        { key: 'skew-limited', summary: 'Skew only matters past 30 seconds', status: 'confirmed', supersedes: 'clock-skew' },
      ],
    });
  };

  it('discovers active and closed explorations at cold start and reads closed records only on demand', async () => {
    seedLogin();
    update('old-audit', 0, { goal: 'Audit the upload surface' });
    update('old-audit', 1, { status: 'concluded', conclusion: 'No exploitable path found.' });
    update('gave-up', 0, { goal: 'Profile the build' });
    update('gave-up', 1, { status: 'abandoned', reason: 'Superseded by the bundler change.' });
    fs.writeFileSync(path.join(explorations, 'closed', 'broken.json'), '{not json');
    fs.writeFileSync(path.join(explorations, 'active', 'torn.json'), '{"schemaVersion":1');
    fs.utimesSync(path.join(explorations, 'active', 'torn.json'), 50, 50);
    fs.utimesSync(path.join(explorations, 'closed', 'old-audit.json'), 100, 100);
    fs.utimesSync(path.join(explorations, 'closed', 'gave-up.json'), 300, 300);
    fs.utimesSync(path.join(explorations, 'closed', 'broken.json'), 200, 200);
    const before = snapshot();
    // Records are opened only to be parsed, so counting opens under .hive/explorations counts record reads.
    const opens = spyOn(fs, 'openSync');
    const reads = { get count() { return opens.mock.calls.filter(([file]) => String(file).startsWith(explorations)).length; } };
    try {
      start();
      expect(ui.treeViews.find((view) => view.id === 'hive.explorations').description).toBe(path.basename(root));
      const groups = tree().getChildren();
      expect(groups.map((group: any) => [group.label, group.description, group.collapsibleState])).toEqual([['Active', '2', 2], ['Closed', '3', 1]]);
      expect(reads.count).toBe(0);

      const [active, torn] = tree().getChildren(groups[0]);
      expect([active.label, active.description]).toEqual(['flaky-login', 'Find why login fails intermittently']);
      expect(active.command).toEqual({ command: 'hive.exploration.open', title: 'Open Exploration', arguments: ['flaky-login'] });
      // An unreadable active record shows its reason inline, and still opens to explain it.
      expect([torn.label, torn.description, torn.iconPath.id]).toEqual(['torn', 'Unreadable: exploration_corrupt', 'warning']);
      expect(torn.command.arguments).toEqual(['torn']);
      expect(reads.count).toBe(2);

      const closed = tree().getChildren(groups[1]);
      expect(closed.map((item: any) => item.label)).toEqual(['gave-up', 'broken', 'old-audit']);
      expect(closed.map((item: any) => item.tooltip)).toEqual([undefined, undefined, undefined]);
      expect(reads.count).toBe(2);

      // VS Code may pass a copy of the row; only that item's missing tooltip is filled, and the row is not restyled.
      const shown = closed.map((element: any) => Object.assign(new vscodeTestDouble.TreeItem(element.label, 0), { description: element.description, iconPath: element.iconPath }));
      shown.forEach((item: any, index: number) => tree().resolveTreeItem(item, closed[index]));
      expect(reads.count).toBe(5);
      expect(shown[0].tooltip).toContain('Reason: Superseded by the bundler change.');
      expect(shown[2].tooltip).toContain('Conclusion: No exploitable path found.');
      // A corrupt closed record says why on hover; the row itself keeps its plain listing.
      expect(shown[1].tooltip).toContain('Unreadable: exploration_corrupt');
      expect(shown.map((item: any) => [item.description, item.iconPath.id])).toEqual([[undefined, 'type-hierarchy'], [undefined, 'type-hierarchy'], [undefined, 'type-hierarchy']]);
      expect(closed.map((element: any) => [element.tooltip, element.description])).toEqual([[undefined, undefined], [undefined, undefined], [undefined, undefined]]);
      // A tooltip that is already there is kept without another read.
      tree().resolveTreeItem(shown[0], closed[0]);
      expect(reads.count).toBe(5);
    } finally {
      opens.mockRestore();
    }
    expect(snapshot()).toEqual(before);
  });

  it('opens one read-only map tab and follows writes in the same tab until the exploration closes', async () => {
    seedLogin();
    start();
    await run('hive.exploration.open', 'flaky-login');
    const [panel] = ui.webviewPanels;
    expect(panel.title).toBe('Exploration flaky-login');
    expect(panel.options).toMatchObject({ enableScripts: true, enableCommandUris: false, localResourceRoots: [], retainContextWhenHidden: false });
    expect(panel.webview.posted).toEqual([]);

    panel.send({ type: 'ready' });
    const first = lastModel(panel);
    expect(first.targets.map((node: any) => [node.key, node.state])).toEqual([['session-store', 'covered'], ['retry', 'open'], ['idp', 'blocked'], ['cache', 'dropped']]);
    expect(first.observations.map((node: any) => [node.key, node.status, node.supersedes, node.supersededBy])).toEqual([
      ['clock-skew', 'confirmed', null, ['skew-limited']],
      ['race', 'hypothesis', null, []],
      ['skew-limited', 'confirmed', 'clock-skew', []],
    ]);
    expect(first.observations[0].refs).toEqual(['src/auth/token.ts:40']);
    expect([first.status, first.revision, first.changedSince, first.priorExplorationId, first.closure]).toEqual(['active', 2, null, null, null]);
    expect(changedKeys(first)).toEqual([]);

    // Write churn reaches no view: temporary files, the lock anchor and the directories.
    const fired = ui.fired.length;
    watcher().change({ fsPath: `${stored('active', 'flaky-login').fsPath}.tmp.1.2` });
    watcher().change({ fsPath: path.join(explorations, 'flaky-login.json.lock') });
    watcher().create({ fsPath: path.join(explorations, 'closed') });
    expect(ui.fired.length).toBe(fired);
    expect(renders(panel)).toHaveLength(1);

    update('flaky-login', 2, {
      frontier: [{ key: 'retry', target: 'Retry policy', state: 'covered', evidence: 'Retries fetch a new token.' }],
      observations: [{ key: 'race', summary: 'Two refreshes race', status: 'refuted' }],
    });
    watcher().change(stored('active', 'flaky-login'));
    // The final file refreshes only the Explorations view and this tab.
    expect(ui.fired.length).toBe(fired + 1);
    const second = renders(panel).at(-1);
    expect(second.announcement).toBe('Revision 3 recorded.');
    expect([second.model.revision, second.model.changedSince]).toEqual([3, 2]);
    expect(changedKeys(second.model)).toEqual(['retry', 'race']);
    // Stored order is kept, so nodes keep their places when their state changes.
    expect(second.model.targets.map((node: any) => node.key)).toEqual(['session-store', 'retry', 'idp', 'cache']);

    update('flaky-login', 3, { status: 'concluded', conclusion: 'Clock skew past 30 seconds.\nFixed by NTP.' });
    watcher().create(stored('closed', 'flaky-login'));
    watcher().delete(stored('active', 'flaky-login'));
    expect(ui.webviewPanels).toHaveLength(1);
    const closing = renders(panel).slice(-2);
    expect(closing.map((message: any) => message.announcement)).toEqual(['Exploration concluded at revision 4.', '']);
    const closed = lastModel(panel);
    expect([closed.status, closed.revision, closed.changedSince]).toEqual(['concluded', 4, 3]);
    expect(closed.closure).toMatchObject({ label: 'Conclusion', text: 'Clock skew past 30 seconds.\nFixed by NTP.' });

    // An out-of-order event for a stale active copy cannot reopen it: reads prefer the closed record.
    const stale = JSON.parse(fs.readFileSync(stored('closed', 'flaky-login').fsPath, 'utf8'));
    Object.assign(stale, { status: 'active', revision: 3 });
    delete stale.conclusion;
    delete stale.closedAt;
    fs.writeFileSync(stored('active', 'flaky-login').fsPath, JSON.stringify(stale));
    watcher().change(stored('active', 'flaky-login'));
    expect([lastModel(panel).status, lastModel(panel).revision]).toEqual(['concluded', 4]);
  });

  it('catches up after missed events when the tab returns, on its Refresh button and on Hive: Refresh', async () => {
    seedLogin();
    start();
    await run('hive.exploration.open', 'flaky-login');
    const [panel] = ui.webviewPanels;
    panel.send({ type: 'ready' });
    expect(lastModel(panel).revision).toBe(2);

    panel.setVisible(false);
    update('flaky-login', 2, { frontier: [{ key: 'idp', target: 'Identity provider logs', state: 'covered', evidence: 'Logs show skew.' }] });
    watcher().change(stored('active', 'flaky-login'));
    // A late ready from the webview being discarded does not mark the tab ready for the webview that replaces it.
    panel.send({ type: 'ready' });
    update('flaky-login', 3, { observations: [{ key: 'race', summary: 'Two refreshes race', status: 'refuted' }] });
    expect(renders(panel)).toHaveLength(1);

    // A hidden webview is discarded; it loads again when shown and asks for the record.
    panel.setVisible(true);
    watcher().change(stored('active', 'flaky-login'));
    expect(renders(panel)).toHaveLength(1);
    panel.send({ type: 'ready' });
    const returned = lastModel(panel);
    expect([returned.revision, returned.changedSince]).toEqual([4, 2]);
    expect(changedKeys(returned)).toEqual(['idp', 'race']);

    update('flaky-login', 4, { goal: 'Find why login fails' });
    panel.send({ type: 'refresh' });
    expect([lastModel(panel).goal, lastModel(panel).changedSince]).toEqual(['Find why login fails', 4]);

    update('flaky-login', 5, { frontier: [{ key: 'cache', target: 'CDN cache', state: 'open' }] });
    await run('hive.refresh');
    expect([lastModel(panel).revision, changedKeys(lastModel(panel))]).toEqual([6, ['cache']]);
    // Opening it again reveals the same tab.
    await run('hive.exploration.open', { explorationId: 'flaky-login' });
    expect(ui.webviewPanels).toHaveLength(1);
    expect(panel.reveals).toBe(1);
  });

  it('accepts only the narrow webview requests and opens a prior exploration only when it exists', async () => {
    update('follow-up', 0, { goal: 'Retest the login fix', priorExplorationId: 'first-pass' });
    update('elsewhere', 0, { goal: 'Unrelated' });
    start();
    await run('hive.exploration.open', 'follow-up');
    const [panel] = ui.webviewPanels;
    panel.send({ type: 'ready' });
    expect(lastModel(panel).priorExplorationId).toBe('first-pass');
    const posted = panel.webview.posted.length;

    for (const message of [
      'refresh',
      null,
      { type: 'refresh', id: 'elsewhere' },
      { type: 'openPrior', id: 'elsewhere' },
      { type: 'command', command: 'workbench.action.terminal.new' },
      { type: 'open', id: 'elsewhere' },
    ]) panel.send(message);
    expect(panel.webview.posted.length).toBe(posted);
    expect(ui.webviewPanels).toHaveLength(1);

    panel.send({ type: 'openPrior' });
    expect(ui.webviewPanels).toHaveLength(1);
    expect(panel.webview.posted.at(-1)).toEqual({
      type: 'notice',
      text: "The prior exploration first-pass is not in this project's .hive/explorations. It may have been removed or recorded in another project.",
    });

    update('first-pass', 0, { goal: 'Find why login fails' });
    update('first-pass', 1, { status: 'concluded', conclusion: 'Clock skew.' });
    panel.send({ type: 'openPrior' });
    expect(ui.webviewPanels.map((open: any) => open.title)).toEqual(['Exploration follow-up', 'Exploration first-pass']);
    ui.webviewPanels[1].send({ type: 'ready' });
    expect(lastModel(ui.webviewPanels[1]).status).toBe('concluded');

    // A palette entry that is not an exploration ID opens nothing.
    await run('hive.exploration.open', '../follow-up');
    expect(ui.errors).toEqual(['Hive: That is not an exploration ID.']);
    expect(ui.webviewPanels).toHaveLength(2);
  });

  it('keeps recorded text out of the HTML and reports unreadable or removed records without changing them', async () => {
    update('hostile', 0, {
      goal: '<img src=x onerror="alert(1)"> <a href="command:workbench.action.terminal.new">run</a>',
      frontier: [{ key: 'k', target: '[open](command:workbench.action.terminal.new)', state: 'open' }],
      observations: [{ key: 'o', summary: '</script><script>alert(2)</script>', status: 'hypothesis', refs: ['javascript:alert(3)'] }],
    });
    start();
    await run('hive.exploration.open', 'hostile');
    const [panel] = ui.webviewPanels;
    const html: string = panel.webview.html;
    const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('unsafe-inline');
    expect(html.match(/<script/g)).toEqual(['<script']);
    for (const text of ['onerror', 'command:', 'alert(', 'hostile']) expect(html).not.toContain(text);
    // The script builds elements from text only; no API that parses markup or code is present.
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\('(href|src|on)/);
    panel.send({ type: 'ready' });
    // The record reaches the webview only as message data, which its script renders as text.
    expect(lastModel(panel).goal).toBe('<img src=x onerror="alert(1)"> <a href="command:workbench.action.terminal.new">run</a>');

    const before = snapshot();
    fs.writeFileSync(stored('active', 'hostile').fsPath, '{"schemaVersion":1');
    const corrupt = snapshot();
    watcher().change(stored('active', 'hostile'));
    expect(panel.webview.posted.at(-1)).toMatchObject({ type: 'unavailable', id: 'hostile', reason: 'exploration_corrupt' });
    expect(snapshot()).toEqual(corrupt);

    fs.unlinkSync(stored('active', 'hostile').fsPath);
    watcher().delete(stored('active', 'hostile'));
    expect(panel.webview.posted.at(-1)).toMatchObject({ type: 'unavailable', id: 'hostile', reason: 'not_found' });
    expect(tree().getChildren(tree().getChildren()[0]).map((item: any) => item.label)).toEqual(['No active explorations']);
    expect(before).not.toEqual(corrupt);
  });
});
