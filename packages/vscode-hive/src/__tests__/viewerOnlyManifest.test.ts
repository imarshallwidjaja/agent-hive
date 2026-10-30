import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const packageJsonPath = path.resolve(import.meta.dir, '../../package.json');
const readmePath = path.resolve(import.meta.dir, '../../README.md');

describe('viewer-only VS Code manifest', () => {
  it('uses the forked vscode-arkive extension identity and broad VS Code floor', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    expect(pkg.name).toBe('vscode-arkive');
    expect(pkg.displayName).toBe('Arkive');
    expect(pkg.publisher).toBe('arkive');
    expect(pkg.engines.vscode).toBe('^1.67.0');
    expect(pkg.devDependencies['@types/vscode']).toBe('1.67.0');
  });

  it('contributes viewer, review, and limited operator archive commands', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const lmKey = ['language', 'Model', 'Tools'].join('');
    expect(pkg.contributes[lmKey]).toBeUndefined();
    const commands = (pkg.contributes.commands ?? []).map((entry: { command: string }) => entry.command).sort();
    expect(commands).toEqual([
      'hive.copyToClipboard',
      'hive.context.archive',
      'hive.context.loadMore',
      'hive.context.scanChars',
      'hive.constraints.inspect',
      'hive.comment.create',
      'hive.comment.delete',
      'hive.comment.reply',
      'hive.comment.resolve',
      'hive.feature.archive',
      'hive.job.archive',
      'hive.openFile',
      'hive.plan.doneReview',
      'hive.refresh',
      'hive.worklog.loadMore',
      'hive.worklog.open',
      'hive.worklog.pin',
      'hive.worklog.showFacts',
      'hive.worklog.showHistory',
      'hive.worklog.unpin',
    ].sort());
    expect(commands).not.toContain('hive.background.cancel');
    expect(commands).not.toContain('hive.background.reconcile');
    expect(commands).not.toContain('hive.background.ignore');
  });

  it('keeps selective context archive in the tree and constraints in a read-only text provider', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    expect(pkg.contributes.menus.commandPalette).toContainEqual({ command: 'hive.context.archive', when: 'false' });
    expect(pkg.contributes.menus.commandPalette).toContainEqual({ command: 'hive.context.loadMore', when: 'false' });
    expect(pkg.contributes.menus.commandPalette).toContainEqual({ command: 'hive.context.scanChars', when: 'false' });
    expect(pkg.contributes.menus['view/item/context']).toContainEqual({ command: 'hive.context.archive', when: 'view == hive.features && (viewItem == context-folder || viewItem == project-context-folder || viewItem == context-file)' });
    expect(pkg.contributes.menus['view/item/context']).toContainEqual({ command: 'hive.context.scanChars', when: 'view == hive.features && (viewItem == context-folder || viewItem == project-context-folder)' });
    const source = fs.readFileSync(new URL('../extension.ts', import.meta.url), 'utf8');
    expect(source).toContain('registerTextDocumentContentProvider(SessionConstraintsProvider.scheme');
    expect(source).toContain('onDidCloseTextDocument(document => this.sessionConstraintsProvider?.close(document.uri))');
    expect(source).toContain('this.context.subscriptions.push(\n      this.sessionConstraintsProvider,');
    expect(source).toContain('this.sessionConstraintsProvider?.refresh()');
    expect(source).not.toContain('registerFileSystemProvider');
  });

  it('contributes the minimal Hive viewer views', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const views = (pkg.contributes.views?.hive ?? []).map((entry: { id: string }) => entry.id).sort();

    expect(views).toEqual([
      'hive.backgroundJobs',
      'hive.features',
      'hive.repositories',
      'hive.worklogs',
    ].sort());
  });

  it('reads worklogs through a native tree and a read-only text provider scoped to worklog documents', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    expect(pkg.activationEvents).toContain('onView:hive.worklogs');
    expect(pkg.contributes.menus['view/title']).toContainEqual({ command: 'hive.worklog.open', when: 'view == hive.worklogs', group: 'navigation@1' });
    expect(pkg.contributes.menus['editor/title']).toContainEqual({ command: 'hive.worklog.loadMore', when: 'resourceScheme == hive-worklog', group: 'navigation@3' });
    for (const command of ['hive.worklog.loadMore', 'hive.worklog.pin', 'hive.worklog.showFacts', 'hive.worklog.showHistory', 'hive.worklog.unpin']) {
      expect(pkg.contributes.menus.commandPalette).toContainEqual({ command, when: 'resourceScheme == hive-worklog' });
    }
    const source = fs.readFileSync(new URL('../extension.ts', import.meta.url), 'utf8');
    expect(source).toContain("createTreeView('hive.worklogs'");
    expect(source).toContain('registerTextDocumentContentProvider(WorklogDocuments.scheme, this.worklogDocuments)');
    expect(source).toContain('registerDocumentLinkProvider({ scheme: WorklogDocuments.scheme }, this.worklogDocuments)');
    expect(source).toContain('onDidCloseTextDocument(document => this.worklogDocuments?.close(document.uri))');
    expect(source).toContain('this.worklogsProvider?.refresh()\n      this.worklogDocuments?.refresh()');
    expect(source).toContain('new WorklogViewerPreferences(this.context.workspaceState, workspaceRoot)');
    expect(source).not.toContain('createWebviewPanel');
    expect(source).not.toContain('registerWebviewViewProvider');
  });

  it('documents background and repository views as viewer-first surfaces with limited archive actions', () => {
    const readme = fs.readFileSync(readmePath, 'utf8');

    expect(readme).toContain('Background Jobs');
    expect(readme).toContain('Tracked Repositories');
    expect(readme).toContain('does not start worktrees, commit changes, merge branches, cancel jobs, or reconcile jobs; archiving a background job is its only job mutation');
    expect(readme).toContain('Archive Background Job');
    expect(readme).toContain('Archive Feature');
  });
});
