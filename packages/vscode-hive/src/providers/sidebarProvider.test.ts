import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { resetVscodeTestState, vscodeTestDouble, vscodeTestState as ui } from '../test/vscodeTestDouble.js';
const hiveCore = await import('../../../hive-core/src/index.ts');
const { FeatureService, PlanService } = hiveCore;

mock.module('hive-core', () => hiveCore);
mock.module('vscode', () => vscodeTestDouble);

const { HiveSidebarProvider } = await import('./sidebarProvider');

const TEST_ROOT_BASE = `/tmp/vscode-hive-sidebar-test-${process.pid}`;

describe('HiveSidebarProvider', () => {
  let testRoot: string;

  beforeEach(() => {
    resetVscodeTestState();
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'workspace-'));
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
  });

  it('shows status and task progress for all features in stable logical-name order', async () => {
    const featureService = new FeatureService(testRoot);
    const planService = new PlanService(testRoot);

    featureService.create('beta-feature');
    featureService.create('alpha-feature');
    featureService.create('gamma-feature');
    featureService.create('executing-feature');
    featureService.create('completed-feature');

    planService.write('beta-feature', '# Plan\n');
    planService.write('alpha-feature', '# Plan\n');
    planService.write('gamma-feature', '# Plan\n');
    planService.write('executing-feature', '# Plan\n');
    planService.write('completed-feature', '# Plan\n');

    const betaPath = path.join(testRoot, '.hive', 'features', '01_beta-feature');
    const alphaPath = path.join(testRoot, '.hive', 'features', '02_alpha-feature');
    const gammaPath = path.join(testRoot, '.hive', 'features', '03_gamma-feature');
    const executingPath = path.join(testRoot, '.hive', 'features', '04_executing-feature');
    const completedPath = path.join(testRoot, '.hive', 'features', '05_completed-feature');

    setFeatureStatus(gammaPath, 'planning');
    setFeatureStatus(executingPath, 'executing');
    setFeatureStatus(completedPath, 'completed');

    fs.mkdirSync(path.join(betaPath, 'tasks', '01-beta-task'), { recursive: true });
    fs.writeFileSync(
      path.join(betaPath, 'tasks', '01-beta-task', 'status.json'),
      JSON.stringify({ status: 'pending', origin: 'plan' }, null, 2)
    );

    fs.mkdirSync(path.join(alphaPath, 'tasks', '01-alpha-done'), { recursive: true });
    fs.writeFileSync(
      path.join(alphaPath, 'tasks', '01-alpha-done', 'status.json'),
      JSON.stringify({ status: 'done', origin: 'plan' }, null, 2)
    );
    fs.mkdirSync(path.join(alphaPath, 'tasks', '02-alpha-pending'), { recursive: true });
    fs.writeFileSync(
      path.join(alphaPath, 'tasks', '02-alpha-pending', 'status.json'),
      JSON.stringify({ status: 'pending', origin: 'plan' }, null, 2)
    );

    fs.mkdirSync(path.join(gammaPath, 'tasks', '01-gamma-task'), { recursive: true });
    fs.writeFileSync(
      path.join(gammaPath, 'tasks', '01-gamma-task', 'status.json'),
      JSON.stringify({ status: 'pending', origin: 'plan' }, null, 2)
    );

    fs.mkdirSync(path.join(executingPath, 'tasks', '01-executing-task'), { recursive: true });
    fs.writeFileSync(
      path.join(executingPath, 'tasks', '01-executing-task', 'status.json'),
      JSON.stringify({ status: 'in_progress', origin: 'plan' }, null, 2)
    );

    fs.mkdirSync(path.join(completedPath, 'tasks', '01-completed-task'), { recursive: true });
    fs.writeFileSync(
      path.join(completedPath, 'tasks', '01-completed-task', 'status.json'),
      JSON.stringify({ status: 'done', origin: 'plan' }, null, 2)
    );

    const provider = new HiveSidebarProvider(testRoot);
    const groups = await provider.getChildren();
    const statusGroups = groups.filter(item => 'groupName' in item);

    expect(statusGroups).toHaveLength(3);

    const pendingGroup = statusGroups.find(item => item.groupName === 'Pending');
    const inProgressGroup = statusGroups.find(item => item.groupName === 'In Progress');
    const completedGroup = statusGroups.find(item => item.groupName === 'Completed');

    expect(pendingGroup?.features.map(feature => feature.name)).toEqual([
      'alpha-feature',
      'beta-feature',
      'gamma-feature',
    ]);
    expect(pendingGroup?.features.map(feature => feature.description)).toEqual([
      'Planning · 1/2',
      'Planning · 0/1',
      'Planning · 0/1',
    ]);
    expect(pendingGroup?.features.every(feature => feature.resourceUri === undefined)).toBe(true);
    expect(inProgressGroup?.features.map(feature => feature.name)).toEqual(['executing-feature']);
    expect(inProgressGroup?.features[0]?.description).toBe('Executing · 0/1');
    expect(completedGroup?.features.map(feature => feature.name)).toEqual(['completed-feature']);
    expect(completedGroup?.features[0]?.description).toBe('Completed · 1/1');
  });

  it('opens latest handoffs and lazily lists immutable report revisions without writes', async () => {
    new FeatureService(testRoot).create('reports');
    const taskPath = hiveCore.getTaskPath(testRoot, 'reports', '01-worker');
    const reportsPath = path.join(taskPath, 'reports');
    fs.mkdirSync(reportsPath, { recursive: true });
    fs.writeFileSync(path.join(taskPath, 'spec.md'), 'spec');
    fs.writeFileSync(path.join(taskPath, 'report.md'), 'latest');
    for (const filename of ['1.md', '2.md', '0.md', '01.md', '-1.md', '3.txt', 'notes.md', '1.5.md']) {
      fs.writeFileSync(path.join(reportsPath, filename), filename);
    }
    fs.mkdirSync(path.join(reportsPath, '11.md'));
    const provider = new HiveSidebarProvider(testRoot);
    const [group] = await provider.getChildren();
    const [feature] = await provider.getChildren(group);
    const tasks = (await provider.getChildren(feature)).find(item => item.label === 'Tasks')!;
    const readDirectory = spyOn(fs, 'readdirSync');
    const [task] = await provider.getChildren(tasks);
    expect(readDirectory.mock.calls.some(args => String(args[0]) === reportsPath)).toBe(false);
    readDirectory.mockRestore();
    expect(task.label).toBe('worker');
    expect((task as any).featureName).toBe('reports');
    expect((task as any).folder).toBe('01-worker');
    const children = await provider.getChildren(task);
    expect(children.map(item => item.label)).toEqual(['spec.md', 'Latest handoff report', 'Report history']);
    expect(children[1].command?.command).toBe('vscode.open');
    expect(children[1].command?.arguments?.[0].fsPath).toBe(path.join(taskPath, 'report.md'));
    expect(children[0].command?.arguments?.[0].fsPath).toBe(path.join(taskPath, 'spec.md'));
    const history = children[2];
    expect(history.collapsibleState).toBe(1);
    expect(history.command).toBeUndefined();
    fs.writeFileSync(path.join(reportsPath, '10.md'), 'new revision after task expansion');
    const before = fs.readdirSync(reportsPath);
    const write = spyOn(fs, 'writeFileSync');
    try {
      const revisions = await provider.getChildren(history);
      expect(revisions.map(item => item.label)).toEqual(['Revision 10', 'Revision 2', 'Revision 1']);
      expect(revisions.map(item => item.command?.command)).toEqual(['vscode.open', 'vscode.open', 'vscode.open']);
      expect(revisions.map(item => item.command?.arguments?.[0].fsPath)).toEqual(
        ['10.md', '2.md', '1.md'].map(filename => path.join(reportsPath, filename))
      );
      expect(await provider.getChildren(revisions[0])).toEqual([]);
      expect(write).not.toHaveBeenCalled();
      expect(fs.readdirSync(reportsPath)).toEqual(before);
      expect(fs.readFileSync(path.join(taskPath, 'report.md'), 'utf8')).toBe('latest');
    } finally { write.mockRestore(); }
    fs.rmSync(reportsPath, { recursive: true });
    expect(await provider.getChildren(history)).toEqual([]);
  });

  it.each(['missing', 'empty', 'junk'])('keeps latest-only navigation with %s report history', async (history) => {
    new FeatureService(testRoot).create('legacy');
    const taskPath = hiveCore.getTaskPath(testRoot, 'legacy', '01-worker');
    fs.mkdirSync(taskPath, { recursive: true });
    fs.writeFileSync(path.join(taskPath, 'report.md'), 'legacy bytes');
    const reportsPath = path.join(taskPath, 'reports');
    if (history !== 'missing') fs.mkdirSync(reportsPath);
    if (history === 'junk') fs.writeFileSync(path.join(reportsPath, 'notes.md'), 'junk');
    const provider = new HiveSidebarProvider(testRoot);
    const [group] = await provider.getChildren();
    const [feature] = await provider.getChildren(group);
    const tasks = (await provider.getChildren(feature)).find(item => item.label === 'Tasks')!;
    const [task] = await provider.getChildren(tasks);
    const children = await provider.getChildren(task);
    expect(children.map(item => item.label)).toEqual(['Latest handoff report']);
    expect(children[0].command?.arguments?.[0].fsPath).toBe(path.join(taskPath, 'report.md'));
    expect(fs.existsSync(reportsPath)).toBe(history !== 'missing');
    expect(fs.readFileSync(path.join(taskPath, 'report.md'), 'utf8')).toBe('legacy bytes');
  });

  it('keeps overview inside context instead of as a first-class review item', async () => {
    const featureName = 'overview-sidebar-feature';
    const featureService = new FeatureService(testRoot);
    const planService = new PlanService(testRoot);

    featureService.create(featureName);
    planService.write(featureName, '# Plan\n');

    const featurePath = path.join(testRoot, '.hive', 'features', '01_overview-sidebar-feature');
    fs.mkdirSync(path.join(featurePath, 'context'), { recursive: true });
    fs.writeFileSync(path.join(featurePath, 'context', 'overview.md'), '# Overview\n');
    fs.writeFileSync(path.join(featurePath, 'context', 'notes.md'), '# Notes\n');
    fs.mkdirSync(path.join(featurePath, 'comments'), { recursive: true });
    fs.writeFileSync(
      path.join(featurePath, 'comments', 'overview.json'),
      JSON.stringify({
        threads: [
          { id: 'overview-thread', line: 1, body: 'Clarify overview', replies: [] },
        ],
      }, null, 2)
    );

    const provider = new HiveSidebarProvider(testRoot);
    const rootItems = await provider.getChildren();
    const pendingGroup = rootItems.find(item => 'groupName' in item && item.groupName === 'Pending');
    if (!pendingGroup || !('features' in pendingGroup)) {
      throw new Error('Pending group not found');
    }

    const featureItem = pendingGroup.features.find(feature => feature.name === featureName);
    if (!featureItem) {
      throw new Error('Feature item not found');
    }

    const children = await provider.getChildren(featureItem);

    expect(children.map(child => child.label)).toEqual(['Plan', 'Context', 'Tasks']);
    expect(children.find((child) => (child as any).contextValue === 'overview-file')).toBeUndefined();
    expect((children[1] as any).description).toBe('2 documents · 1/8 durable · 8/40000 chars');

    const contextItem = children.find(child => child.label === 'Context');
    const contextChildren = await provider.getChildren(contextItem);
    const overviewItem = contextChildren.find((c: any) => c.label === 'overview.md');
    expect((overviewItem as any)?.description).toBe('Reserved · 11 bytes · 1 comment(s)');
    expect((overviewItem as any)?.command.command).toBe('vscode.open');
    const notesItem = contextChildren.find((c: any) => c.label === 'notes.md');
    expect((notesItem as any)?.description).toBe('Durable · 8 bytes');
  });

  it('filters context metadata and warns only above either durable cap', async () => {
    new FeatureService(testRoot).create('context');
    const service = new hiveCore.ContextService(testRoot);
    service.create('context', 'evidence', 'proof', { kind: 'evidence' });
    service.create('context', 'draft', 'scratch');
    const contextPath = hiveCore.getContextPath(testRoot, 'context');
    fs.writeFileSync(path.join(contextPath, 'notes.md'), 'x'.repeat(40000));
    fs.writeFileSync(path.join(contextPath, 'noise.json'), '{}');
    const provider = new HiveSidebarProvider(testRoot);
    const [group] = await provider.getChildren();
    const [feature] = await provider.getChildren(group);
    const folder = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    expect((folder.iconPath as any).id).toBe('folder');
    const files = await provider.getChildren(folder);
    expect(files.map(file => file.label).sort()).toEqual(['draft.md', 'evidence.md', 'notes.md']);
    expect(files.find(file => file.label === 'evidence.md')?.description).toBe('Evidence · 5 bytes');
    expect(files.find(file => file.label === 'draft.md')?.description).toBe('Scratchpad · 7 bytes');
    expect(files.find(file => file.label === 'evidence.md')?.tooltip).toContain('Automatic execution inclusion: No');
    fs.appendFileSync(path.join(contextPath, 'notes.md'), 'x');
    expect(((await provider.getChildren(feature)).find(item => item.label === 'Context')!.iconPath as any).id).toBe('warning');
    fs.writeFileSync(path.join(contextPath, 'notes.md'), '');
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(contextPath, `note-${i}.md`), '');
    expect(((await provider.getChildren(feature)).find(item => item.label === 'Context')!.iconPath as any).id).toBe('warning');
  });

  it('archives only confirmed names at the captured revision and never retries stale writes', async () => {
    const { archiveContext } = await import('./contextInspection.js');
    new FeatureService(testRoot).create('context');
    const service = new hiveCore.ContextService(testRoot);
    const contextPath = hiveCore.getContextPath(testRoot, 'context');
    fs.mkdirSync(contextPath, { recursive: true });
    fs.writeFileSync(path.join(contextPath, 'notes.md'), 'keep');
    fs.writeFileSync(path.join(contextPath, 'unselected.md'), 'preserve me');
    const initial = service.readSummary('context').revision;
    let refreshes = 0;
    const run = () => archiveContext(testRoot, { featureName: 'context', filename: 'notes.md' }, () => refreshes++);
    await run(); // Picker cancellation.
    ui.picks.push((items: any[]) => items);
    await run(); // Reason cancellation.
    ui.picks.push((items: any[]) => items); ui.inputs.push('obsolete');
    await run(); // Confirmation cancellation.
    ui.picks.push((items: any[]) => items); ui.inputs.push('   ');
    await run(); // Blank reasons cannot mutate even if an input mock bypasses validation.
    expect(service.readSummary('context').revision).toBe(initial);
    ui.picks.push((items: any[]) => items); ui.inputs.push('obsolete');
    ui.confirmations.push(() => {
      const current = service.readContent('context', 'notes')!;
      service.append('context', 'notes', 'changed', current.revision, current.file.contentHash!);
      return 'Archive Context';
    });
    await run();
    expect(ui.errors.join('\n')).toContain('current revision');
    expect(service.read('context', 'notes')).not.toBeNull();
    expect(refreshes).toBe(0);
    ui.picks.push((items: any[]) => items.filter(item => item.name === 'notes')); ui.inputs.push('obsolete'); ui.confirmations.push('Archive Context');
    await run();
    expect(ui.warnings.at(-1)).toContain('notes.md');
    expect(service.read('context', 'notes')).toBeNull();
    expect(service.read('context', 'unselected')).toBe('preserve me');
    expect(ui.warnings.at(-1)).not.toContain('unselected.md');
    expect(refreshes).toBe(1);
  });

  it('inspects explicit authoritative sessions without exposing recovery fields or mutating files', async () => {
    const { SessionConstraintsProvider } = await import('./sessionConstraintsProvider.js');
    const provider = new SessionConstraintsProvider(testRoot);
    await provider.inspect();
    expect(fs.readdirSync(testRoot)).toEqual([]);
    const service = new hiveCore.SessionService(testRoot);
    new FeatureService(testRoot).create('mirror');
    fs.writeFileSync(path.join(hiveCore.getFeaturePath(testRoot, 'mirror'), 'sessions.json'), JSON.stringify({ sessions: [{ sessionId: 'mirror-only', standingConstraints: 'hidden mirror' }] }));
    service.trackGlobal('empty');
    service.trackGlobal('chosen', { agent: 'hive', sessionKind: 'primary', directivePrompt: 'SECRET-DIRECTIVE', workerPromptPath: '/SECRET-PATH', directiveRecoveryState: 'available', standingConstraintEntries: [{ id: 'stable-id', text: 'Keep this scope' }], standingConstraintsRevision: 4 });
    const registryPath = hiveCore.getGlobalSessionsPath(testRoot);
    const before = fs.readFileSync(registryPath, 'utf8');
    await provider.inspect();
    expect(ui.shown).toHaveLength(0);
    expect(fs.readFileSync(registryPath, 'utf8')).toBe(before);
    ui.picks.push((items: any[]) => items[0]);
    await provider.inspect();
    expect(ui.pickItems).toHaveLength(1);
    expect(ui.pickItems[0].detail).toContain('ID: chosen');
    const uri = ui.shown[0].uri;
    const content = provider.provideTextDocumentContent(uri);
    expect(content).toContain('stable-id');
    expect(content).toContain('Revision: 4');
    expect(content).toContain('15/8000');
    expect(content).not.toContain('SECRET');
    expect(content).not.toContain('available');
    expect(content).not.toContain('command:');
    expect(fs.readFileSync(registryPath, 'utf8')).toBe(before);
    fs.rmSync(registryPath);
    expect(provider.provideTextDocumentContent(uri)).toBe('The selected session no longer exists.');
    provider.close(uri);
    expect(provider.provideTextDocumentContent(uri)).toContain('No session selected');
    service.trackGlobal('deleted', { standingConstraints: 'present' });
    ui.picks.push((items: any[]) => { fs.rmSync(registryPath); return items[0]; });
    await provider.inspect();
    expect(ui.messages.at(-1)).toContain('no longer exist');
    expect(ui.shown).toHaveLength(1);
    provider.dispose();
  });

  it('isolates session documents and refreshes only open selections as plain text', async () => {
    const { SessionConstraintsProvider } = await import('./sessionConstraintsProvider.js');
    const provider = new SessionConstraintsProvider(testRoot);
    const service = new hiveCore.SessionService(testRoot);
    const raw = '**literal** [run](command:workbench.action.closeWindow) <script>text</script>';
    service.trackGlobal('first', { standingConstraints: raw });
    service.trackGlobal('second', { standingConstraints: 'second-only' });
    for (const id of ['first', 'second']) {
      ui.picks.push((items: any[]) => items.find(item => item.sessionId === id));
      await provider.inspect();
    }
    const [first, second] = ui.shown.map(document => document.uri);
    expect(first.toString()).not.toBe(second.toString());
    expect(first.toString()).toEndWith('.txt');
    expect(provider.provideTextDocumentContent(first)).toContain(raw);
    expect(provider.provideTextDocumentContent(first)).not.toContain('second-only');
    expect(provider.provideTextDocumentContent(second)).toContain('second-only');
    expect(provider.provideTextDocumentContent(second)).not.toContain(raw);
    expect(provider.provideTextDocumentContent({ toString: () => 'unknown' } as any)).toBe('No session selected. Use Inspect Session Standing Constraints.');
    provider.refresh();
    expect(ui.fired).toEqual([first, second]);
    provider.close(first);
    ui.fired = [];
    provider.refresh();
    expect(ui.fired).toEqual([second]);
    expect(provider.provideTextDocumentContent(first)).not.toContain(raw);
    const disposals = ui.disposed.length;
    provider.dispose();
    expect(ui.disposed.length).toBe(disposals + 1);
    ui.fired = [];
    provider.refresh();
    expect(ui.fired).toEqual([]);
    expect(provider.provideTextDocumentContent(second)).not.toContain('second-only');
  });

  it('expands context without writes and ignores lock events while refreshing committed changes', async () => {
    const { HiveWatcher } = await import('../services/watcher.js');
    new FeatureService(testRoot).create('absent');
    const contextPath = hiveCore.getContextPath(testRoot, 'absent');
    fs.rmSync(contextPath, { recursive: true, force: true });
    const provider = new HiveSidebarProvider(testRoot);
    const watcher = new HiveWatcher(testRoot, () => provider.refresh());
    const [group] = await provider.getChildren();
    const [feature] = await provider.getChildren(group);
    const before = fs.readdirSync(path.dirname(contextPath));
    const folder = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    expect(await provider.getChildren(folder)).toEqual([]);
    expect(fs.existsSync(contextPath)).toBe(false);
    expect(fs.readdirSync(path.dirname(contextPath))).toEqual(before);
    expect(ui.fired).toEqual([]);
    const events = ui.watchers[0];
    for (const kind of ['create', 'change', 'delete']) events[kind]({ fsPath: `${contextPath}/index.json.lock` });
    expect(ui.fired).toEqual([]);
    for (const kind of ['create', 'change', 'delete']) events[kind]({ fsPath: `${contextPath}/index.json` });
    events.change({ fsPath: `${contextPath}/notes.md` });
    expect(ui.fired).toHaveLength(4);
    const service = new hiveCore.ContextService(testRoot);
    const legacyPath = hiveCore.getContextPath(testRoot, 'absent');
    fs.mkdirSync(legacyPath, { recursive: true });
    fs.writeFileSync(path.join(legacyPath, 'notes.md'), 'é😀');
    const populated = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    expect(populated.description).toContain('3/40000 chars');
    expect((await provider.getChildren(populated))[0].description).toBe('Durable · 6 bytes');
    fs.writeFileSync(path.join(contextPath, 'index.json.lock'), 'writer');
    expect((await provider.getChildren(feature)).map(item => item.label)).toContain('Context temporarily unavailable');
    expect((await provider.getChildren(populated))[0].label).toBe('Context temporarily unavailable');
    watcher.dispose();
    expect(events.disposed).toBe(true);
  });

  it.each(['EACCES', 'null index'])('isolates %s context inspection failures without writes or hiding plan and tasks', async (failure) => {
    new FeatureService(testRoot).create('context');
    new PlanService(testRoot).write('context', '# Plan\n');
    new hiveCore.ContextService(testRoot).create(
      'context',
      'notes',
      '---\ndescription: Sidebar fixture\nread_when: Read when testing sidebar context.\n---\n\npreserved',
    );
    const contextPath = hiveCore.getContextPath(testRoot, 'context');
    const indexPath = path.join(contextPath, 'index.json');
    const provider = new HiveSidebarProvider(testRoot);
    const [group] = await provider.getChildren();
    const [feature] = await provider.getChildren(group);
    const folder = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    if (failure === 'null index') fs.writeFileSync(indexPath, 'null');
    const before = fs.readFileSync(indexPath, 'utf8');
    const original = fs.readFileSync;
    const read = spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      if (failure === 'EACCES' && String(file) === indexPath) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return (original as any)(file, ...args);
    }) as any);
    const open = spyOn(fs, 'openSync');
    const write = spyOn(fs, 'writeFileSync');
    try {
      const children = await provider.getChildren(feature);
      expect(children.map(item => item.label)).toEqual(['Plan', 'Context unavailable', 'Tasks']);
      expect(children[0].command).toBeDefined();
      expect(await provider.getChildren(children[2])).toEqual([]);
      const [unavailable] = await provider.getChildren(folder);
      for (const item of [children[1], unavailable]) {
        expect(item.label).toBe('Context unavailable');
        expect(item.description).toContain(failure === 'EACCES' ? 'permission denied' : 'invalid shape');
        expect(item.contextValue).toBeUndefined();
        expect(item.command).toBeUndefined();
        expect('featureName' in item).toBe(false);
        expect(item.collapsibleState).toBe(0);
      }
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally { read.mockRestore(); open.mockRestore(); write.mockRestore(); }
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(contextPath, 'notes.md'), 'utf8')).toBe(
      '---\ndescription: Sidebar fixture\nread_when: Read when testing sidebar context.\n---\n\npreserved',
    );
    expect(fs.existsSync(`${indexPath}.lock`)).toBe(false);
  });

  it('ignores non-.hive workspace artifacts', async () => {
    fs.mkdirSync(path.join(testRoot, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    fs.writeFileSync(path.join(testRoot, 'README.md'), '# noise\n');
    fs.writeFileSync(path.join(testRoot, 'package.json'), '{"name":"noise"}');

    const provider = new HiveSidebarProvider(testRoot);
    const rootItems = await provider.getChildren();

    expect(rootItems.map(item => item.label)).toEqual([]);
  });

  it('shows archived features in a collapsed Archived group and excludes them from pending groups', async () => {
    const featureService = new FeatureService(testRoot);
    const planService = new PlanService(testRoot);

    featureService.create('planning-feature');
    featureService.create('archived-feature');

    planService.write('planning-feature', '# Plan\n');
    planService.write('archived-feature', '# Plan\n');

    const archivedPath = path.join(testRoot, '.hive', 'features', '02_archived-feature');
    setFeatureStatus(archivedPath, 'archived');

    const provider = new HiveSidebarProvider(testRoot);
    const groups = await provider.getChildren();
    const statusGroups = groups.filter(item => 'groupName' in item);

    expect(statusGroups.map(g => g.groupName)).toContain('Archived');

    const archivedGroup = statusGroups.find(g => g.groupName === 'Archived');
    expect(archivedGroup?.features.map(f => f.name)).toEqual(['archived-feature']);
    expect(archivedGroup?.features[0]?.description).toContain('Archived');

    const pendingGroup = statusGroups.find(g => g.groupName === 'Pending');
    expect(pendingGroup?.features.map(f => f.name)).not.toContain('archived-feature');
  });

  it('archived features get context value for archive command', async () => {
    const featureService = new FeatureService(testRoot);
    featureService.create('archiveable-feature');

    const provider = new HiveSidebarProvider(testRoot);
    const groups = await provider.getChildren();
    const pendingGroup = groups.find(item => 'groupName' in item && item.groupName === 'Pending');
    if (pendingGroup && 'features' in pendingGroup) {
      const feature = pendingGroup.features.find(f => f.name === 'archiveable-feature');
      expect(feature).toBeDefined();
      expect((feature as any).contextValue).toBe('feature-planning');
    }
  });
});

function setFeatureStatus(featurePath: string, status: 'planning' | 'executing' | 'completed' | 'archived'): void {
  const featureJsonPath = path.join(featurePath, 'feature.json');
  const feature = JSON.parse(fs.readFileSync(featureJsonPath, 'utf-8')) as { status: string };
  feature.status = status;
  fs.writeFileSync(featureJsonPath, JSON.stringify(feature, null, 2));
}
