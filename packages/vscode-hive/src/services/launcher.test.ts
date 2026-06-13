import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
const source = fs.readFileSync(new URL('./launcher.ts', import.meta.url), 'utf-8');

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

  it('can open a background job board at the matching taskId line', () => {
    expect(source).toContain('async openBackgroundJobInBoard(boardPath: string, taskId: string)');
    expect(source).toContain('`"taskId": "${taskId}"`');
    expect(source).toContain('new vscode.Position');
    expect(source).toContain('selection');
  });
});
