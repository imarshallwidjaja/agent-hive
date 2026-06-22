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
    expect(pkg.engines.vscode).toBe('^1.64.0');
    expect(pkg.devDependencies['@types/vscode']).toBe('1.64.0');
  });

  it('contributes viewer, review, and limited operator archive commands', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const lmKey = ['language', 'Model', 'Tools'].join('');
    expect(pkg.contributes[lmKey]).toBeUndefined();
    const commands = (pkg.contributes.commands ?? []).map((entry: { command: string }) => entry.command).sort();
    expect(commands).toEqual([
      'hive.copyToClipboard',
      'hive.comment.create',
      'hive.comment.delete',
      'hive.comment.reply',
      'hive.comment.resolve',
      'hive.feature.archive',
      'hive.job.archive',
      'hive.openFile',
      'hive.plan.doneReview',
      'hive.refresh',
    ].sort());
    expect(commands).not.toContain('hive.background.cancel');
    expect(commands).not.toContain('hive.background.reconcile');
    expect(commands).not.toContain('hive.background.ignore');
  });

  it('contributes the minimal Hive viewer views', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const views = (pkg.contributes.views?.hive ?? []).map((entry: { id: string }) => entry.id).sort();

    expect(views).toEqual([
      'hive.backgroundJobs',
      'hive.features',
      'hive.repositories',
    ].sort());
  });

  it('documents background and repository views as viewer-first surfaces with limited archive actions', () => {
    const readme = fs.readFileSync(readmePath, 'utf8');

    expect(readme).toContain('Background Jobs');
    expect(readme).toContain('Tracked Repositories');
    expect(readme).toContain('does not start worktrees, commit changes, merge branches, cancel jobs');
    expect(readme).toContain('Archive Background Job');
    expect(readme).toContain('Archive Feature');
  });
});
