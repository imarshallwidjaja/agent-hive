import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { resetVscodeTestState, vscodeTestDouble, vscodeTestState } from '../test/vscodeTestDouble.js';

mock.module('vscode', () => vscodeTestDouble);

const { Launcher } = await import('./launcher');

const source = fs.readFileSync(new URL('./launcher.ts', import.meta.url), 'utf-8');
const extensionSource = fs.readFileSync(new URL('../extension.ts', import.meta.url), 'utf-8');
const TEST_ROOT_BASE = `/tmp/vscode-hive-launcher-test-${process.pid}`;

describe('Launcher', () => {
  it('provides simple openFile without plan/overview branching', () => {
    expect(source).toContain('async openFile(filePath: string)');
    expect(source).not.toContain('overviewPath');
    expect(source).not.toContain('planPath');
  });

  it('shows warning for invalid file path', () => {
    expect(source).toContain('Invalid file path');
  });

  it('reveals directories instead of opening them as text documents', () => {
    expect(source).toContain('stat.isDirectory()');
    expect(source).toContain("executeCommand('revealFileInOS', uri)");
  });

  it('is built from the workspace root and archives job rows through the owner-safe command flow', () => {
    expect(extensionSource).toContain('new Launcher(workspaceRoot)');
    expect(extensionSource).toContain('archiveBackgroundJobItem(this.workspaceRoot, jobItem,');
  });

  it('forwards job rows opened through hive.openFile to the launcher without assuming their arguments are an array', () => {
    // Command arguments come from any caller; a non-array must reach the launcher's invalid-reference warning, not throw.
    expect(extensionSource).toContain('const [owner, alias] = Array.isArray(args) ? args : []');
    expect(extensionSource).not.toContain('= filePathOrItem.command.arguments ?? []');
  });

  describe('openBackgroundJobInBoard', () => {
    let testRoot: string;
    const v1Board = () => path.join(testRoot, '.hive', 'background-jobs.json');
    const v2Board = () => path.join(testRoot, '.hive', 'runtime', 'opencode-v2', 'background-jobs.json');
    const writeBoard = (file: string, aliases: string[]) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, jobs: aliases.map(alias => ({ alias, taskId: `${alias}-task` })) }, null, 2));
    };
    const lineOf = (file: string, alias: string) =>
      fs.readFileSync(file, 'utf-8').split('\n').findIndex(line => line.includes(`"alias": ${JSON.stringify(alias)}`));

    beforeEach(() => {
      resetVscodeTestState();
      fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
      testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'workspace-'));
      // The shared alias sits on a different line in each board, so the selected line also identifies the board.
      writeBoard(v1Board(), ['parent:job-1']);
      writeBoard(v2Board(), ['other', 'parent:job-1']);
    });

    afterEach(() => {
      fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    });

    it('opens the board chosen by owner at the exact alias line when aliases are equal', async () => {
      const launcher = new Launcher(testRoot);

      await launcher.openBackgroundJobInBoard('opencode-v2', 'parent:job-1');
      await launcher.openBackgroundJobInBoard('opencode-v1', 'parent:job-1');

      expect(vscodeTestState.shown.map(document => document.uri.fsPath)).toEqual([v2Board(), v1Board()]);
      expect(vscodeTestState.shownOptions.map(options => options.selection.active.line)).toEqual([
        lineOf(v2Board(), 'parent:job-1'),
        lineOf(v1Board(), 'parent:job-1'),
      ]);
      expect(lineOf(v2Board(), 'parent:job-1')).not.toBe(lineOf(v1Board(), 'parent:job-1'));
      expect([vscodeTestState.warnings, vscodeTestState.errors]).toEqual([[], []]);
    });

    for (const [name, owner, alias] of [
      ['an unknown owner', 'opencode-v3', 'parent:job-1'],
      ['a path-like owner', '../.hive', 'parent:job-1'],
      ['a missing owner', undefined, 'parent:job-1'],
      ['a non-string alias', 'opencode-v2', 7],
      ['an empty alias', 'opencode-v2', ''],
      ['a missing alias', 'opencode-v2', undefined],
    ] as const) {
      it(`opens nothing for ${name}`, async () => {
        await new Launcher(testRoot).openBackgroundJobInBoard(owner, alias);

        expect(vscodeTestState.shown).toEqual([]);
        expect(vscodeTestState.warnings).toEqual(['Hive: Invalid background job reference']);
      });
    }
  });
});
