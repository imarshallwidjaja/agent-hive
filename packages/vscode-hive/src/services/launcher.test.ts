import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
const source = fs.readFileSync(new URL('./launcher.ts', import.meta.url), 'utf-8');
const extensionSource = fs.readFileSync(new URL('../extension.ts', import.meta.url), 'utf-8');

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

  it('can open a background job board at the matching exact alias line', () => {
    expect(source).toContain('async openBackgroundJobInBoard(boardPath: string, alias: string)');
    expect(source).toContain('`"alias": ${JSON.stringify(alias)}`');
    expect(source).toContain('new vscode.Position');
    expect(source).toContain('selection');
  });

  it('archives background job rows by exact alias', () => {
    expect(extensionSource).toContain('const alias = jobItem?.alias');
    expect(extensionSource).toContain("service.markIgnored(alias, reason || 'Operator archived')");
    expect(extensionSource).not.toContain("service.markIgnored(taskId, reason || 'Operator archived')");
  });
});
