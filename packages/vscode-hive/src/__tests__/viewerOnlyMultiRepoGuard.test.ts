import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const packageRoot = path.resolve(import.meta.dir, '../..');
const srcRoot = path.join(packageRoot, 'src');
const packageJsonPath = path.join(packageRoot, 'package.json');
const readmePath = path.join(packageRoot, 'README.md');

function readPkg(): any {
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
}

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

  it('does not reintroduce the forbidden agentic tool files', () => {
    expect(fs.existsSync(path.join(srcRoot, 'tools', 'exec.ts'))).toBe(false);
    expect(fs.existsSync(path.join(srcRoot, 'tools', 'merge.ts'))).toBe(false);
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

  it('does not contribute agentic start, create, commit, or merge commands', () => {
    const pkg = readPkg();
    const commands: string[] = (pkg.contributes?.commands ?? []).map((c: { command: string }) => c.command);
    const forbiddenSuffixes = ['worktree.start', 'worktree.create', 'worktree.commit', 'merge', 'task.start', 'task.merge'];
    const matches = commands.filter((cmd) =>
      forbiddenSuffixes.some((suffix) => cmd.toLowerCase().endsWith(suffix.toLowerCase()))
    );
    expect(matches).toEqual([]);
  });

  it('does not declare any languageModelTools contribution', () => {
    const pkg = readPkg();
    // Use split-key to avoid grep-style matches against this test file itself.
    const lmKey = ['language', 'Model', 'Tools'].join('');
    expect(pkg.contributes?.[lmKey]).toBeUndefined();
  });

  it('README documents the viewer-only stance', () => {
    const readme = fs.readFileSync(readmePath, 'utf8');
    expect(readme.toLowerCase()).toContain('viewer-only');
  });
});
