import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const packageRoot = path.resolve(import.meta.dir, '../..');
const srcRoot = path.join(packageRoot, 'src');
function listAllSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listAllSourceFiles(full, acc);
    } else if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
      acc.push(full);
    }
  }
  return acc;
}

describe('viewer-only VS Code package under multi-repo readiness', () => {
  it('does not ship a src/tools/ directory (no agentic exec.ts or merge.ts surfaces)', () => {
    const toolsDir = path.join(srcRoot, 'tools');
    expect(fs.existsSync(toolsDir)).toBe(false);
  });

  it('does not instantiate or import the hive-core orchestration service', () => {
    // Split the symbol so this guard file itself does not match its own grep.
    const symbol = ['Worktree', 'Service'].join('');
    const offenders: Array<{ file: string; match: string }> = [];
    for (const file of listAllSourceFiles(srcRoot)) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes(symbol)) {
        offenders.push({ file: path.relative(packageRoot, file), match: symbol });
      }
    }
    expect(offenders).toEqual([]);
  });

});
