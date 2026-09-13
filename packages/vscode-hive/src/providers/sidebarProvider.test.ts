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

  function statusGroup(items: any[], name: string): any {
    const group = items.find(item => 'groupName' in item && item.groupName === name);
    if (!group) throw new Error(`Status group ${name} not found`);
    return group;
  }

  async function firstFeature(provider: InstanceType<typeof HiveSidebarProvider>, name: string): Promise<any> {
    const roots = await provider.getChildren();
    const group = roots.find(item => 'groupName' in item)!;
    const features = await provider.getChildren(group);
    return features.find(feature => feature.name === name)!;
  }

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
    const roots = await provider.getChildren();
    const statusGroups = roots.filter(item => 'groupName' in item);

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
    const feature = await firstFeature(provider, 'reports');
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
    const feature = await firstFeature(provider, 'legacy');
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
    const roots = await provider.getChildren();
    const pendingGroup = roots.find(item => 'groupName' in item && item.groupName === 'Pending');
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
    expect((children[1] as any).description).toBe('2 documents · 1/8 durable · 8 B · chars unavailable');
    expect(((children[1] as any).iconPath as any).id).toBe('folder');

    const contextItem = children.find(child => child.label === 'Context');
    const contextChildren = await provider.getChildren(contextItem);
    const overviewItem = contextChildren.find((c: any) => c.label === 'overview.md');
    expect((overviewItem as any)?.description).toBe('Reserved · 11 bytes · 1 comment(s)');
    expect((overviewItem as any)?.command.command).toBe('vscode.open');
    expect((overviewItem as any)?.scope).toEqual({ type: 'feature', featureName });
    const notesItem = contextChildren.find((c: any) => c.label === 'notes.md');
    expect((notesItem as any)?.description).toBe('Durable · 8 bytes');
  });

  it('lists a project context root with project governance and keeps the ninth note unwarned', async () => {
    const service = new hiveCore.ContextService(testRoot);
    const project = { type: 'project' } as const;
    const content = (index: number) =>
      `---\ndescription: Project note ${index}\nread_when: Read before changing shared project knowledge.\nowner: platform-team\nreview_after: 2999-12-31\n---\n\nbody ${index}`;
    for (let index = 0; index < 9; index++) {
      service.create(project, `project-note-${index}`, content(index));
    }
    const provider = new HiveSidebarProvider(testRoot);
    const roots = await provider.getChildren();
    expect(roots[0].label).toBe('Project Context');
    const projectItem = roots[0];
    expect((projectItem as any).scope).toEqual({ type: 'project' });
    expect((projectItem as any).contextValue).toBe('project-context-folder');
    const bytes = [0, 1, 2, 3, 4, 5, 6, 7, 8]
      .map(index => fs.statSync(path.join(testRoot, '.hive', 'context', `project-note-${index}.md`)).size)
      .reduce((sum, size) => sum + size, 0);
    expect((projectItem as any).description).toBe(`9 documents · 9/32 durable · ${bytes} B · chars unavailable`);
    expect(((projectItem as any).iconPath as any).id).toBe('folder');

    const files = await provider.getChildren(projectItem);
    expect(files).toHaveLength(9);
    const first = files.find(file => file.label === 'project-note-0.md')!;
    expect(first.description).toBe(`Durable · ${fs.statSync(path.join(testRoot, '.hive', 'context', 'project-note-0.md')).size} bytes`);
    expect(first.tooltip).toContain('Description: Project note 0');
    expect(first.tooltip).toContain('Read when: Read before changing shared project knowledge.');
    expect(first.tooltip).toContain('Kind: durable');
    expect(first.tooltip).toContain('Owner: platform-team');
    expect(first.tooltip).toContain('Review after: 2999-12-31');
    expect(first.tooltip).not.toContain('overdue');
    expect(first.command?.arguments?.[0].fsPath).toBe(path.join(testRoot, '.hive', 'context', 'project-note-0.md'));
  });

  it('warns on overdue project reviews through descriptions and the folder icon', async () => {
    const service = new hiveCore.ContextService(testRoot);
    const project = { type: 'project' } as const;
    service.create(project, 'overdue-note',
      '---\ndescription: Overdue project note\nread_when: Read during project reviews.\nowner: platform-team\nreview_after: 2020-01-01\n---\n\nstale body');
    const provider = new HiveSidebarProvider(testRoot);
    const projectItem = (await provider.getChildren())[0];
    expect(((projectItem as any).iconPath as any).id).toBe('warning');
    expect((projectItem as any).description).toBe(`1 documents · 1/32 durable · ${fs.statSync(path.join(testRoot, '.hive', 'context', 'overdue-note.md')).size} B · chars unavailable`);
    const [file] = await provider.getChildren(projectItem);
    expect(file.description).toBe(`Durable · ${fs.statSync(path.join(testRoot, '.hive', 'context', 'overdue-note.md')).size} bytes · review overdue`);
    expect(file.tooltip).toContain('Review after: 2020-01-01 (overdue)');
  });

  it('filters context metadata and warns only above either durable cap', async () => {
    new FeatureService(testRoot).create('context');
    const provider = new HiveSidebarProvider(testRoot);
    const feature = await firstFeature(provider, 'context');
    const contextPath = hiveCore.getContextPath(testRoot, 'context');
    const service = new hiveCore.ContextService(testRoot);
    service.create('context', 'evidence', 'proof', { kind: 'evidence' });
    service.create('context', 'draft', 'scratch');
    fs.writeFileSync(path.join(contextPath, 'notes.md'), 'x'.repeat(40000));
    fs.writeFileSync(path.join(contextPath, 'noise.json'), '{}');
    let folder = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    expect((folder.iconPath as any).id).toBe('folder');
    let files = await provider.getChildren(folder);
    expect(files.map(file => file.label).sort()).toEqual(['draft.md', 'evidence.md', 'notes.md']);
    expect(files.find(file => file.label === 'evidence.md')?.description).toBe('Evidence · 5 bytes');
    expect(files.find(file => file.label === 'draft.md')?.description).toBe('Scratchpad · 7 bytes');
    expect(files.find(file => file.label === 'evidence.md')?.tooltip).toContain('Automatic execution inclusion: No');

    // Exact character totals exist only after the explicit management scan.
    fs.appendFileSync(path.join(contextPath, 'notes.md'), 'x');
    folder = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    expect((folder.iconPath as any).id).toBe('folder');
    expect(folder.description).toContain('chars unavailable');
    provider.scanChars({ type: 'feature', featureName: 'context' });
    folder = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    expect((folder.iconPath as any).id).toBe('warning');
    expect(folder.description).toContain('40001/40000 chars');

    fs.writeFileSync(path.join(contextPath, 'notes.md'), '');
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(contextPath, `note-${i}.md`), '');
    folder = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    expect((folder.iconPath as any).id).toBe('warning');
    expect(folder.description).toContain('9/8 durable');
  });

  it('pages context documents behind an explicit load-more node and opens later-page files', async () => {
    new FeatureService(testRoot).create('paging');
    const contextPath = hiveCore.getContextPath(testRoot, 'paging');
    fs.mkdirSync(contextPath, { recursive: true });
    for (let index = 0; index < 12; index++) {
      fs.writeFileSync(path.join(contextPath, `note-${String(index).padStart(2, '0')}.md`), `note ${String(index).padStart(2, '0')}`);
    }
    const provider = new HiveSidebarProvider(testRoot);
    const feature = await firstFeature(provider, 'paging');
    const folder = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    expect(folder.description).toBe('12 documents · 12/8 durable · 84 B · chars unavailable');
    const children = await provider.getChildren(folder);
    expect(children).toHaveLength(11);
    expect(children.map(file => file.label).slice(0, 10)).toEqual(
      Array.from({ length: 10 }, (_, index) => `note-${String(index).padStart(2, '0')}.md`)
    );
    const loadMore = children[10];
    expect(loadMore.label).toBe('Load more context documents');
    expect(loadMore.description).toBe('10 of 12');
    expect((loadMore as any).contextValue).toBe('context-load-more');
    expect(loadMore.command?.command).toBe('hive.context.loadMore');
    expect(loadMore.command?.arguments?.[0]).toEqual({ type: 'feature', featureName: 'paging' });

    provider.loadMore({ type: 'feature', featureName: 'paging' });
    const expanded = await provider.getChildren(folder);
    expect(expanded).toHaveLength(12);
    expect(expanded.some(item => item.label === 'Load more context documents')).toBe(false);
    const later = expanded.find(item => item.label === 'note-11.md')!;
    expect(later.command?.command).toBe('vscode.open');
    expect(later.command?.arguments?.[0].fsPath).toBe(path.join(contextPath, 'note-11.md'));
  });

  it('pages every classification across multiple load-more expansions without oversized aggregate reads', async () => {
    new FeatureService(testRoot).create('paging-all');
    const contextPath = hiveCore.getContextPath(testRoot, 'paging-all');
    fs.mkdirSync(contextPath, { recursive: true });
    const service = new hiveCore.ContextService(testRoot);
    for (let index = 0; index < 25; index++) {
      fs.writeFileSync(path.join(contextPath, `note-${String(index).padStart(2, '0')}.md`), `note ${index}`);
    }
    service.create('paging-all', 'proof', 'proof', { kind: 'evidence' });
    fs.writeFileSync(path.join(contextPath, 'overview.md'), '# Overview\n');
    const provider = new HiveSidebarProvider(testRoot);
    const feature = await firstFeature(provider, 'paging-all');
    const folder = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    expect(folder.description).toContain('27 documents · 25/8 durable');

    const seen: string[] = [];
    for (let expansion = 0; expansion < 3; expansion++) {
      const children = await provider.getChildren(folder);
      const loadMore = children.find(item => item.label === 'Load more context documents');
      if (!loadMore) break;
      expect(loadMore.command?.command).toBe('hive.context.loadMore');
      expect(loadMore.description).toBe(`${children.length - 1} of 27`);
      provider.loadMore({ type: 'feature', featureName: 'paging-all' });
    }
    const finalChildren = await provider.getChildren(folder);
    expect(finalChildren.some(item => item.label === 'Load more context documents')).toBe(false);
    seen.push(...finalChildren.map(item => item.label));
    expect(seen).toHaveLength(27);
    expect(seen.filter(label => label.endsWith('.md'))).toHaveLength(27);
    const proof = finalChildren.find(item => item.label === 'proof.md')!;
    expect(proof.description).toBe('Evidence · 5 bytes');
    const overview = finalChildren.find(item => item.label === 'overview.md')!;
    expect(overview.description).toContain('Reserved');
    expect(finalChildren.filter(item => item.label === 'note-24.md')).toHaveLength(1);
  });

  it('renders exact, stale, and unavailable character totals without body scans on refresh', async () => {
    new FeatureService(testRoot).create('chars');
    const contextPath = hiveCore.getContextPath(testRoot, 'chars');
    fs.mkdirSync(contextPath, { recursive: true });
    fs.writeFileSync(path.join(contextPath, 'notes.md'), 'hello');
    const service = new hiveCore.ContextService(testRoot);
    const provider = new HiveSidebarProvider(testRoot);
    const feature = await firstFeature(provider, 'chars');
    const folderOf = async () => (await provider.getChildren(feature)).find(item => item.label === 'Context')!;

    let folder = await folderOf();
    expect(folder.description).toBe('1 documents · 1/8 durable · 5 B · chars unavailable');
    expect(folder.tooltip).toContain('Exact character totals are unavailable until an explicit character scan runs.');

    provider.scanChars({ type: 'feature', featureName: 'chars' });
    expect(ui.messages.at(-1)).toContain('5/40000');
    folder = await folderOf();
    expect(folder.description).toBe('1 documents · 1/8 durable · 5 B · 5/40000 chars');
    expect(folder.tooltip).not.toContain('unavailable until');

    const current = service.readContent('chars', 'notes')!;
    service.append('chars', 'notes', 'more', current.revision, current.file.contentHash!);
    folder = await folderOf();
    expect(folder.description).toContain('1 documents · 1/8 durable · ');
    expect(folder.description!.endsWith('5/40000 chars (stale)')).toBe(true);
    expect(folder.tooltip).toContain('Character totals are stale: 5 UTF-16 units were measured before the latest change.');
    expect(((folder.iconPath as any).id)).toBe('folder');
  });

  it('archives project scope through load-more selection at the captured revision', async () => {
    const { archiveContext } = await import('./contextInspection.js');
    const service = new hiveCore.ContextService(testRoot);
    const project = { type: 'project' } as const;
    for (let index = 0; index < 12; index++) {
      service.create(project, `shared-note-${String(index).padStart(2, '0')}`,
        `---\ndescription: Shared note ${index}\nread_when: Read during project reviews.\nowner: platform-team\nreview_after: 2999-12-31\n---\n\nshared ${index}`);
    }
    const archivePath = path.join(testRoot, '.hive', 'archive', 'context');
    let refreshes = 0;
    const run = () => archiveContext(testRoot, { scope: project }, () => refreshes++);

    await run(); // Picker cancellation on the first page.
    ui.picks.push((items: any[]) => items); // Load more instead of submitting.
    await run();
    expect(fs.existsSync(archivePath)).toBe(false);
    ui.picks.push((items: any[]) => items.filter((item: any) => item.name === 'shared-note-00'));
    ui.inputs.push('rotate shared knowledge');
    ui.confirmations.push('Archive Context');
    await run();
    expect(ui.errors).toEqual([]);
    expect(service.read(project, 'shared-note-00')).toBeNull();
    expect(service.read(project, 'shared-note-11')).not.toBeNull();
    expect(fs.readdirSync(archivePath).some(name => name.includes('shared-note-00'))).toBe(true);
    expect(refreshes).toBe(1);
    expect(ui.messages.at(-1)).toContain('Archived 1 context document(s)');
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
    const run = () => archiveContext(testRoot, { scope: { type: 'feature', featureName: 'context' }, filename: 'notes.md' }, () => refreshes++);
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

  it('archives evidence and reserved documents selected from a later page', async () => {
    const { archiveContext } = await import('./contextInspection.js');
    new FeatureService(testRoot).create('classify');
    const service = new hiveCore.ContextService(testRoot);
    const contextPath = hiveCore.getContextPath(testRoot, 'classify');
    fs.mkdirSync(contextPath, { recursive: true });
    for (let index = 0; index < 12; index++) {
      fs.writeFileSync(path.join(contextPath, `note-${String(index).padStart(2, '0')}.md`), `note ${index}`);
    }
    service.create('classify', 'proof', 'proof', { kind: 'evidence' });
    fs.writeFileSync(path.join(contextPath, 'overview.md'), '# Overview\n');
    const archivePath = path.join(hiveCore.getContextPath(testRoot, 'classify'), '..', 'archive', 'context');
    let refreshes = 0;
    const run = () => archiveContext(testRoot, { scope: { type: 'feature', featureName: 'classify' } }, () => refreshes++);

    ui.picks.push((items: any[]) => items); // Load more to reach the later page.
    ui.picks.push((items: any[]) => items.filter((item: any) => item.name === 'proof' || item.name === 'overview'));
    ui.inputs.push('retire superseded proof and overview');
    ui.confirmations.push('Archive Context');
    await run();
    expect(ui.errors).toEqual([]);
    expect(service.read('classify', 'proof')).toBeNull();
    expect(service.read('classify', 'overview')).toBeNull();
    expect(service.read('classify', 'note-00')).not.toBeNull();
    const archived = fs.readdirSync(archivePath);
    expect(archived.some(name => name.includes('proof'))).toBe(true);
    expect(archived.some(name => name.includes('overview'))).toBe(true);
    expect(refreshes).toBe(1);
    expect(ui.messages.at(-1)).toContain('Archived 2 context document(s)');
  });

  it('keeps an explicitly deselected originating document deselected across load more and confirmation', async () => {
    const { archiveContext } = await import('./contextInspection.js');
    new FeatureService(testRoot).create('deselect');
    const service = new hiveCore.ContextService(testRoot);
    const contextPath = hiveCore.getContextPath(testRoot, 'deselect');
    fs.mkdirSync(contextPath, { recursive: true });
    for (let index = 0; index < 12; index++) {
      fs.writeFileSync(path.join(contextPath, `note-${String(index).padStart(2, '0')}.md`), `note ${index}`);
    }
    const archivePath = path.join(contextPath, '..', 'archive', 'context');
    let refreshes = 0;
    const pages: any[][] = [];
    const run = () => archiveContext(testRoot, { scope: { type: 'feature', featureName: 'deselect' }, filename: 'note-00.md' }, () => refreshes++);

    ui.picks.push((items: any[]) => { pages.push(items); return items.filter((item: any) => item.loadMore); });
    ui.picks.push((items: any[]) => { pages.push(items); return items.filter((item: any) => item.name === 'note-11'); });
    ui.inputs.push('rotate without the preselected note');
    ui.confirmations.push('Archive Context');
    await run();
    expect(ui.errors).toEqual([]);
    expect(pages).toHaveLength(2);
    expect(pages[0].find((item: any) => item.name === 'note-00')?.picked).toBe(true);
    expect(pages[1].find((item: any) => item.name === 'note-00')?.picked).toBe(false);
    expect(service.read('deselect', 'note-00')).not.toBeNull();
    expect(service.read('deselect', 'note-11')).toBeNull();
    expect(fs.readdirSync(archivePath).some(name => name.includes('note-11'))).toBe(true);
    expect(refreshes).toBe(1);
    expect(ui.messages.at(-1)).toContain('Archived 1 context document(s)');
  });

  it('keeps the originating document preselected when load more reveals it on a later page', async () => {
    const { archiveContext } = await import('./contextInspection.js');
    new FeatureService(testRoot).create('laterorigin');
    const service = new hiveCore.ContextService(testRoot);
    const contextPath = hiveCore.getContextPath(testRoot, 'laterorigin');
    fs.mkdirSync(contextPath, { recursive: true });
    for (let index = 0; index < 12; index++) {
      fs.writeFileSync(path.join(contextPath, `note-${String(index).padStart(2, '0')}.md`), `note ${index}`);
    }
    const archivePath = path.join(contextPath, '..', 'archive', 'context');
    let refreshes = 0;
    const pages: any[][] = [];
    const run = () => archiveContext(testRoot, { scope: { type: 'feature', featureName: 'laterorigin' }, filename: 'note-11.md' }, () => refreshes++);

    ui.picks.push((items: any[]) => { pages.push(items); return items.filter((item: any) => item.loadMore); });
    ui.picks.push((items: any[]) => { pages.push(items); return items.filter((item: any) => item.name === 'note-11'); });
    ui.inputs.push('rotate the opened later-page note');
    ui.confirmations.push('Archive Context');
    await run();
    expect(ui.errors).toEqual([]);
    expect(pages).toHaveLength(2);
    expect(pages[0].find((item: any) => item.name === 'note-11')).toBeUndefined();
    expect(pages[1].find((item: any) => item.name === 'note-11')?.picked).toBe(true);
    expect(service.read('laterorigin', 'note-11')).toBeNull();
    expect(service.read('laterorigin', 'note-00')).not.toBeNull();
    expect(fs.readdirSync(archivePath).some(name => name.includes('note-11'))).toBe(true);
    expect(refreshes).toBe(1);
    expect(ui.messages.at(-1)).toContain('Archived 1 context document(s)');
  });

  it('reports drift conflicts between the captured list and managed writes before confirming', async () => {
    const { archiveContext } = await import('./contextInspection.js');
    new FeatureService(testRoot).create('drift');
    const service = new hiveCore.ContextService(testRoot);
    service.create('drift', 'notes', '---\ndescription: Drift note\nread_when: Read when checking drift.\n---\nbody');
    const notesPath = path.join(hiveCore.getContextPath(testRoot, 'drift'), 'notes.md');
    fs.writeFileSync(notesPath, fs.readFileSync(notesPath, 'utf8').replace('body', 'bodY'));
    ui.picks.push((items: any[]) => items.filter(item => item.name === 'notes'));
    ui.inputs.push('archive drifted note');
    ui.confirmations.push('Archive Context');
    let refreshes = 0;
    await archiveContext(testRoot, { scope: { type: 'feature', featureName: 'drift' } }, () => refreshes++);
    expect(ui.warnings.at(-1)).toContain('Unmanaged changes detected');
    expect(ui.warnings.at(-1)).toContain('notes.md changed outside managed writes');
    expect(service.read('drift', 'notes')).toBeNull();
    expect(refreshes).toBe(1);
    expect(ui.messages.at(-1)).toContain('Drift reported for 1 document(s)');
  });

  it('archives nothing when the caller has no scope binding', async () => {
    const { archiveContext } = await import('./contextInspection.js');
    new FeatureService(testRoot).create('context');
    fs.mkdirSync(path.join(hiveCore.getContextPath(testRoot, 'context')), { recursive: true });
    fs.writeFileSync(path.join(hiveCore.getContextPath(testRoot, 'context'), 'notes.md'), 'keep');
    await archiveContext(testRoot, undefined, () => {});
    await archiveContext(testRoot, { filename: 'notes.md' }, () => {});
    await archiveContext(testRoot, { scope: { type: 'workspace' } } as any, () => {});
    expect(ui.errors.filter(message => message.includes('Select a Project Context or feature Context folder or document'))).toHaveLength(3);
    expect(ui.errors.join('\n')).not.toContain('archive failed');
    expect(new hiveCore.ContextService(testRoot).read('context', 'notes')).toBe('keep');
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

  it('expands context without writes, shows the empty state, and ignores lock events while refreshing committed changes', async () => {
    const { HiveWatcher } = await import('../services/watcher.js');
    new FeatureService(testRoot).create('absent');
    const contextPath = hiveCore.getContextPath(testRoot, 'absent');
    fs.rmSync(contextPath, { recursive: true, force: true });
    const provider = new HiveSidebarProvider(testRoot);
    const watcher = new HiveWatcher(testRoot, () => provider.refresh());
    const feature = await firstFeature(provider, 'absent');
    const before = fs.readdirSync(path.dirname(contextPath));
    const folder = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    expect(folder.collapsibleState).toBe(1);
    const emptyChildren = await provider.getChildren(folder);
    expect(emptyChildren).toHaveLength(1);
    expect(emptyChildren[0].label).toBe('No context documents');
    expect(emptyChildren[0].command).toBeUndefined();
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
    expect(populated.description).toBe('1 documents · 1/8 durable · 6 B · chars unavailable');
    expect((await provider.getChildren(populated))[0].description).toBe('Durable · 6 bytes');
    fs.writeFileSync(path.join(contextPath, 'index.json.lock'), 'writer');
    const busyFolder = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    expect(busyFolder.description).toBe('Waiting for context changes to finish');
    expect(((busyFolder.iconPath as any).id)).toBe('clock');
    const busyChildren = await provider.getChildren(busyFolder);
    expect(busyChildren.map(item => item.label)).toEqual(['Context temporarily unavailable']);
    expect(busyChildren[0].command).toBeUndefined();
    watcher.dispose();
    expect(events.disposed).toBe(true);
  });

  it.each(['EACCES', 'null index'])('isolates %s context inspection failures into explicit states without writes or hidden files', async (failure) => {
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
    const feature = await firstFeature(provider, 'context');
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
      expect(children.map(item => item.label)).toEqual(['Plan', 'Context', 'Tasks']);
      expect(children[0].command).toBeDefined();
      expect(await provider.getChildren(children[2])).toEqual([]);
      const failedFolder = children.find(item => item.label === 'Context')!;
      const inner = await provider.getChildren(failedFolder);
      if (failure === 'EACCES') {
        expect(failedFolder.description).toBe('Inspection failed');
        const [unavailable] = inner;
        expect(unavailable.label).toBe('Context unavailable');
        expect(unavailable.description).toContain('permission denied');
        expect(unavailable.contextValue).toBeUndefined();
        expect(unavailable.command).toBeUndefined();
        expect(unavailable.collapsibleState).toBe(0);
      } else {
        expect(failedFolder.description).toBe('Invalid context index');
        const [recovery] = inner;
        expect(recovery.label).toBe('Context recovery inspection');
        expect(recovery.description).toContain('Observational');
        expect(recovery.description).toContain('revision unknown');
        expect(recovery.tooltip).toContain('invalid context index');
        expect(recovery.tooltip).toContain('invalid shape');
        expect(recovery.tooltip).toContain('Quiesce all writers');
        expect(recovery.tooltip).toContain('Never delete an invalid index');
        expect(recovery.command).toBeUndefined();
        const opens = inner.filter(item => item.command?.command === 'vscode.open');
        expect(opens.map(item => item.label)).toEqual(['Open context index (raw)']);
        expect(opens[0].command.arguments[0].fsPath).toBe(indexPath);
        expect(recovery.tooltip).toContain('Context index: present');
      }
      expect(inner.every(item => item.contextValue !== 'context-file')).toBe(true);
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally { read.mockRestore(); open.mockRestore(); write.mockRestore(); }
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(contextPath, 'notes.md'), 'utf8')).toBe(
      '---\ndescription: Sidebar fixture\nread_when: Read when testing sidebar context.\n---\n\npreserved',
    );
    expect(fs.existsSync(`${indexPath}.lock`)).toBe(false);
  });

  it('represents pending reconciliation with observational recovery guidance and raw file inspection', async () => {
    new FeatureService(testRoot).create('pending');
    const service = new hiveCore.ContextService(testRoot);
    service.create('pending', 'notes', '---\ndescription: Pending note\nread_when: Read when reconciling.\n---\npending body');
    const contextPath = hiveCore.getContextPath(testRoot, 'pending');
    const markerPath = path.join(contextPath, '.managed-mutation-pending.json');
    fs.writeFileSync(markerPath, JSON.stringify({
      schemaVersion: 1,
      operation: 'replace',
      names: ['notes.md'],
      archiveDestinations: [],
      startedAt: '2026-01-01T00:00:00.000Z',
      startingRevision: 1,
      startingIndexDigest: 'abc',
    }));
    const markerBefore = fs.readFileSync(markerPath, 'utf8');
    const provider = new HiveSidebarProvider(testRoot);
    const feature = await firstFeature(provider, 'pending');
    const folder = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    expect(folder.description).toBe('Reconciliation required');
    expect(((folder.iconPath as any).id)).toBe('error');
    const children = await provider.getChildren(folder);
    expect(children.some(item => item.contextValue === 'context-file')).toBe(false);
    const [recovery] = children;
    expect(recovery.label).toBe('Context recovery inspection');
    expect(recovery.tooltip).toContain('pending reconciliation');
    expect(recovery.tooltip).toContain('Pending operation: replace started 2026-01-01T00:00:00.000Z');
    expect(recovery.tooltip).toContain('Affected names: notes.md');
    expect(recovery.tooltip).toContain('Starting index digest: abc');
    expect(recovery.tooltip).toContain('Never delete an invalid index');
    const opens = children.filter(item => item.command?.command === 'vscode.open');
    expect(opens.map(item => item.label).sort()).toEqual([
      'Open context index (raw)',
      'Open pending mutation marker (raw)',
    ]);
    const markerOpen = opens.find(item => item.label.includes('marker'))!;
    expect(markerOpen.command.arguments[0].fsPath).toBe(markerPath);
    expect(fs.readFileSync(markerPath, 'utf8')).toBe(markerBefore);
    expect(fs.existsSync(path.join(contextPath, 'index.json.lock'))).toBe(false);
  });

  it('shows busy while a writer lock coexists with the pending marker and reconciliation only for marker-only state', async () => {
    new FeatureService(testRoot).create('lockmark');
    const service = new hiveCore.ContextService(testRoot);
    service.create('lockmark', 'notes', '---\ndescription: Lock note\nread_when: Read when checking lock precedence.\n---\nlock body');
    const contextPath = hiveCore.getContextPath(testRoot, 'lockmark');
    const markerPath = path.join(contextPath, '.managed-mutation-pending.json');
    fs.writeFileSync(markerPath, JSON.stringify({
      schemaVersion: 1,
      operation: 'replace',
      names: ['notes.md'],
      archiveDestinations: [],
      startedAt: '2026-01-01T00:00:00.000Z',
      startingRevision: 1,
      startingIndexDigest: 'abc',
    }));
    fs.writeFileSync(path.join(contextPath, 'index.json.lock'), 'writer');
    const provider = new HiveSidebarProvider(testRoot);
    const feature = await firstFeature(provider, 'lockmark');
    const folderOf = async () => (await provider.getChildren(feature)).find(item => item.label === 'Context')!;

    const busyFolder = await folderOf();
    expect(busyFolder.description).toBe('Waiting for context changes to finish');
    expect(((busyFolder.iconPath as any).id)).toBe('clock');
    expect((await provider.getChildren(busyFolder)).map(item => item.label)).toEqual(['Context temporarily unavailable']);

    fs.rmSync(path.join(contextPath, 'index.json.lock'));
    const reconciling = await folderOf();
    expect(reconciling.description).toBe('Reconciliation required');
    expect(((reconciling.iconPath as any).id)).toBe('error');
    expect((await provider.getChildren(reconciling))[0].label).toBe('Context recovery inspection');
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it('reaches oversized-inventory guidance through an expandable folder without claiming catalog or archive recovery', async () => {
    new FeatureService(testRoot).create('oversize');
    const contextPath = hiveCore.getContextPath(testRoot, 'oversize');
    fs.mkdirSync(contextPath, { recursive: true });
    for (let index = 0; index < 10001; index++) {
      fs.writeFileSync(path.join(contextPath, `note-${String(index).padStart(4, '0')}.md`), '');
    }
    const provider = new HiveSidebarProvider(testRoot);
    const feature = await firstFeature(provider, 'oversize');
    const folder = (await provider.getChildren(feature)).find(item => item.label === 'Context')!;
    expect(folder.description).toBe('Inventory too large');
    expect(folder.collapsibleState).toBe(1);
    expect(((folder.iconPath as any).id)).toBe('warning');
    const [tooLarge] = await provider.getChildren(folder);
    expect(tooLarge.label).toBe('Context inventory too large');
    expect(tooLarge.tooltip).toContain('exceeds 10000 Markdown candidates');
    expect(tooLarge.tooltip).toContain('catalog listing, and Archive Context share this inventory construction limit');
    expect(tooLarge.tooltip).not.toContain('still lists the paginated catalog');
    expect(tooLarge.tooltip).not.toContain('bounded catalog view');
    expect(tooLarge.tooltip).toContain('trusted local editing');
    expect(tooLarge.tooltip).toContain('Refresh');
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
