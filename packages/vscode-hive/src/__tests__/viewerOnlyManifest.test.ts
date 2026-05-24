import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const packageJsonPath = path.resolve(import.meta.dir, '../../package.json');

describe('viewer-only VS Code manifest', () => {
  it('uses the forked vscode-arkive extension identity and broad VS Code floor', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    expect(pkg.name).toBe('vscode-arkive');
    expect(pkg.displayName).toBe('Arkive');
    expect(pkg.publisher).toBe('arkive');
    expect(pkg.engines.vscode).toBe('^1.64.0');
    expect(pkg.devDependencies['@types/vscode']).toBe('1.64.0');
  });

  it('contributes only viewer and review commands', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const lmKey = ['language', 'Model', 'Tools'].join('');
    expect(pkg.contributes[lmKey]).toBeUndefined();
    const commands = (pkg.contributes.commands ?? []).map((entry: { command: string }) => entry.command).sort();
    expect(commands).toEqual([
      'hive.comment.create',
      'hive.comment.delete',
      'hive.comment.reply',
      'hive.comment.resolve',
      'hive.openFile',
      'hive.plan.doneReview',
      'hive.refresh',
    ].sort());
  });
});
