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
});
