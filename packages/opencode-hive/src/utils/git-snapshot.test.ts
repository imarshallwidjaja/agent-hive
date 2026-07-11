import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectGitSnapshot } from './git-snapshot.js';

let repository = '';

function git(args: string[]): string {
  return gitAt(repository, args);
}

function gitAt(directory: string, args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    shell: false,
  }).trim();
}

function addTrackedGitlink(gitlinkPath: string, subRepo: string): void {
  const objectId = gitAt(subRepo, ['rev-parse', 'HEAD']);
  mkdirSync(path.dirname(path.join(repository, gitlinkPath)), { recursive: true });
  execFileSync('git', ['-C', repository, 'update-index', '--add', '--cacheinfo', `160000,${objectId},${gitlinkPath}`], {
    shell: false,
  });
  git(['commit', '-m', `add gitlink ${gitlinkPath}`]);
}

function write(relativePath: string, content: string): void {
  const filePath = path.join(repository, relativePath);
  writeFileSync(filePath, content);
}

beforeEach(() => {
  repository = mkdtempSync(path.join(os.tmpdir(), 'hive-git-snapshot-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'snapshot@example.test']);
  git(['config', 'user.name', 'Snapshot Test']);
  mkdirSync(path.join(repository, 'src'));
  write('src/one.ts', 'export const one = 1;\n');
  write('src/two.ts', 'export const two = 2;\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  write('src/one.ts', 'export const one = 2;\n');
  write('src/two.ts', 'export const two = 3;\n');
  git(['add', '.']);
  git(['commit', '-m', 'change sources']);
});

afterEach(() => {
  rmSync(repository, { recursive: true, force: true });
});

describe('inspectGitSnapshot', () => {
  it('changes its fingerprint for clean, unstaged, staged, and untracked content', async () => {
    const clean = await inspectGitSnapshot(repository, {});

    write('src/one.ts', 'export const one = 4;\n');
    const unstaged = await inspectGitSnapshot(repository, {});
    git(['add', 'src/one.ts']);
    const staged = await inspectGitSnapshot(repository, {});
    write('new-file.txt', 'first version\n');
    const untracked = await inspectGitSnapshot(repository, {});
    write('new-file.txt', 'second version\n');
    const changedUntracked = await inspectGitSnapshot(repository, {});

    expect(unstaged.changedPaths.unstaged).toEqual(['src/one.ts']);
    expect(staged.changedPaths.staged).toEqual(['src/one.ts']);
    expect(untracked.changedPaths.untracked).toEqual(['new-file.txt']);
    expect(new Set([
      clean.fingerprint,
      unstaged.fingerprint,
      staged.fingerprint,
      untracked.fingerprint,
      changedUntracked.fingerprint,
    ])).toHaveLength(5);
  });

  it('uses the same structured range and path scope for revalidation', async () => {
    const base = git(['rev-parse', 'HEAD^']);
    const input = {
      range: `${base}..HEAD`,
      paths: ['src/one.ts'],
    };

    const snapshot = await inspectGitSnapshot(repository, input);
    const revalidation = await inspectGitSnapshot(repository, input);

    expect(snapshot.repository.root).toBe(repository);
    expect(snapshot.scope.range).toBe(`${base}..HEAD`);
    expect(snapshot.repository.currentHead).toBe(git(['rev-parse', 'HEAD']));
    expect(snapshot.changedPaths.comparison).toEqual(['src/one.ts']);
    expect(snapshot.changedPaths.comparison).not.toContain('src/two.ts');
    expect(snapshot.fingerprint).toBe(revalidation.fingerprint);
  });

  it('bounds returned paths and patch material while disclosing omissions', async () => {
    const snapshot = await inspectGitSnapshot(repository, {
      range: 'HEAD^..HEAD',
      maxFiles: 1,
      maxPatchBytes: 24,
    });

    expect(snapshot.changedPaths.comparison).toHaveLength(1);
    expect(snapshot.omissions.changedPaths.comparison).toBe(1);
    expect(Buffer.byteLength(snapshot.patch)).toBeLessThanOrEqual(24);
    expect(snapshot.omissions.patch.truncated).toBe(true);
    expect(snapshot.omissions.patch.omittedBytes).toBeGreaterThan(0);
  });

  it('discloses source preview omissions even when the caller allows a larger patch', async () => {
    write('src/one.ts', `export const payload = '${'x'.repeat(80 * 1024)}';\n`);

    const snapshot = await inspectGitSnapshot(repository, { maxPatchBytes: 128 * 1024 });

    expect(snapshot.omissions.patch.truncated).toBe(true);
    expect(snapshot.omissions.patch.omittedBytes).toBeGreaterThan(0);
  });

  it('rejects escaping paths, malformed refs and raw flag injection', async () => {
    await expect(inspectGitSnapshot(repository, { paths: ['../outside.ts'] })).rejects.toThrow('repository-relative');
    await expect(inspectGitSnapshot(repository, { paths: ['--output=/tmp/unsafe'] })).rejects.toThrow('must not start with "-"');
    await expect(inspectGitSnapshot(repository, { baseRef: '--output=/tmp/unsafe' })).rejects.toThrow('must not start with "-"');
    await expect(inspectGitSnapshot(repository, { range: 'HEAD;git-status' })).rejects.toThrow('range');
    await expect(inspectGitSnapshot(repository, { paths: [':(exclude)src/one.ts'] })).rejects.toThrow('pathspec magic');
  });

  it('uses the empty tree to compare a root commit instead of returning an empty scope', async () => {
    const rootOnly = path.join(repository, 'root-only');
    mkdirSync(rootOnly);
    gitAt(rootOnly, ['init', '-b', 'main']);
    gitAt(rootOnly, ['config', 'user.email', 'snapshot@example.test']);
    gitAt(rootOnly, ['config', 'user.name', 'Snapshot Test']);
    writeFileSync(path.join(rootOnly, 'first.ts'), 'export const first = true;\n');
    gitAt(rootOnly, ['add', '.']);
    gitAt(rootOnly, ['commit', '-m', 'root']);

    const snapshot = await inspectGitSnapshot(rootOnly, {});

    expect(snapshot.changedPaths.comparison).toEqual(['first.ts']);
    expect(snapshot.scope.comparisonBase).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  });

  it('fails closed when compared histories have no merge base', async () => {
    git(['checkout', '--orphan', 'unrelated']);
    git(['rm', '-rf', '.']);
    write('unrelated.ts', 'export const unrelated = true;\n');
    git(['add', '.']);
    git(['commit', '-m', 'unrelated']);

    await expect(inspectGitSnapshot(repository, { range: 'main...unrelated' })).rejects.toThrow('No merge base');
  });

  it('does not execute repository textconv, external diff, or fsmonitor helpers', async () => {
    if (process.platform === 'win32') return;
    const marker = path.join(repository, 'helper-ran');
    const helper = path.join(repository, 'unsafe-helper.sh');
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(helper, 0o755);
    write('.gitattributes', '*.ts diff=unsafe\n');
    git(['add', '.gitattributes']);
    git(['commit', '-m', 'configure attributes']);
    git(['config', 'diff.unsafe.textconv', helper]);
    git(['config', 'diff.external', helper]);
    git(['config', 'core.fsmonitor', helper]);
    write('src/one.ts', 'export const one = 99;\n');

    await inspectGitSnapshot(repository, {});

    expect(existsSync(marker)).toBe(false);
  });

  it('fails closed on resolved filter attributes before a clean or process driver can run', async () => {
    if (process.platform === 'win32') return;
    const marker = path.join(repository, 'filter-ran');
    const helper = path.join(repository, 'unsafe-filter.sh');
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(helper, 0o755);
    write('src/payload.filtered', 'protected\n');
    write('.gitattributes', '[attr]unsafe-filter filter=unsafe\n');
    write('src/.gitattributes', '*.filtered unsafe-filter\n');
    git(['add', '.gitattributes', 'src/.gitattributes', 'src/payload.filtered']);
    git(['commit', '-m', 'configure filtered file']);
    git(['config', 'filter.unsafe.clean', helper]);
    git(['config', 'filter.unsafe.process', helper]);

    await expect(inspectGitSnapshot(repository, {})).rejects.toThrow('Unsupported filter attribute');
    expect(existsSync(marker)).toBe(false);
    await expect(inspectGitSnapshot(repository, { paths: ['src/one.ts'] })).resolves.toBeDefined();
  });

  it('fingerprints untracked type and mode metadata as well as content', async () => {
    if (process.platform === 'win32') return;
    write('untracked-entry', 'src/one.ts');
    chmodSync(path.join(repository, 'untracked-entry'), 0o644);
    const regular = await inspectGitSnapshot(repository, {});
    chmodSync(path.join(repository, 'untracked-entry'), 0o755);
    const executable = await inspectGitSnapshot(repository, {});
    unlinkSync(path.join(repository, 'untracked-entry'));
    symlinkSync('src/one.ts', path.join(repository, 'untracked-entry'));
    const symlink = await inspectGitSnapshot(repository, {});

    expect(executable.fingerprint).not.toBe(regular.fingerprint);
    expect(symlink.fingerprint).not.toBe(executable.fingerprint);
  });

  it('uses descriptor-based no-follow reads for untracked regular files where supported', async () => {
    if (process.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number') return;
    symlinkSync('missing-target', path.join(repository, 'dangling-link'));

    const snapshot = await inspectGitSnapshot(repository, {});
    const source = readFileSync(new URL('./git-snapshot.ts', import.meta.url), 'utf8');

    expect(snapshot.changedPaths.untracked).toContain('dangling-link');
    expect(source).toContain('O_NOFOLLOW');
    expect(source).toContain('fs.open');
  });

  it('reports an explicit output-boundary failure instead of a raw maxBuffer error', async () => {
    write('src/one.ts', `export const payload = '${'x'.repeat(9 * 1024 * 1024)}';\n`);

    await expect(inspectGitSnapshot(repository, {})).rejects.toThrow('Git snapshot output exceeded');
  });

  it('derives the empty tree from a SHA-256 repository when the installed Git supports it', async () => {
    const sha256Repository = path.join(repository, 'sha256-root');
    mkdirSync(sha256Repository);
    try {
      gitAt(sha256Repository, ['init', '--object-format=sha256', '-b', 'main']);
    } catch {
      return;
    }
    gitAt(sha256Repository, ['config', 'user.email', 'snapshot@example.test']);
    gitAt(sha256Repository, ['config', 'user.name', 'Snapshot Test']);
    writeFileSync(path.join(sha256Repository, 'first.ts'), 'export const first = true;\n');
    gitAt(sha256Repository, ['add', '.']);
    gitAt(sha256Repository, ['commit', '-m', 'root']);
    const emptyTree = execFileSync('git', ['-C', sha256Repository, 'hash-object', '-t', 'tree', '--stdin'], {
      encoding: 'utf8',
      input: '',
      shell: false,
    }).trim();

    const snapshot = await inspectGitSnapshot(sha256Repository, {});

    expect(emptyTree).toHaveLength(64);
    expect(snapshot.scope.comparisonBase).toBe(emptyTree);
    expect(snapshot.changedPaths.comparison).toEqual(['first.ts']);
  });

  it('does not traverse dirty submodules or run submodule filters when the gitlink is in scope', async () => {
    if (process.platform === 'win32') return;
    const marker = path.join(repository, 'submodule-filter-ran');
    const subRepo = path.join(repository, 'nested-sub');
    mkdirSync(subRepo);
    gitAt(subRepo, ['init', '-b', 'main']);
    gitAt(subRepo, ['config', 'user.email', 'snapshot@example.test']);
    gitAt(subRepo, ['config', 'user.name', 'Snapshot Test']);
    writeFileSync(path.join(subRepo, 'payload.filtered'), 'inside-sub\n');
    writeFileSync(path.join(subRepo, '.gitattributes'), '[attr]unsafe-filter filter=unsafe\n*.filtered unsafe-filter\n');
    gitAt(subRepo, ['add', '.']);
    gitAt(subRepo, ['commit', '-m', 'sub initial']);
    gitAt(subRepo, ['config', 'filter.unsafe.clean', `#!/bin/sh\ntouch '${marker}'\ncat`]);
    gitAt(subRepo, ['config', 'filter.unsafe.process', `#!/bin/sh\ntouch '${marker}'\ncat`]);
    writeFileSync(path.join(subRepo, 'payload.filtered'), 'dirty inside-sub\n');

    addTrackedGitlink('vendor/lib', subRepo);

    await expect(inspectGitSnapshot(repository, {})).rejects.toThrow(/Unsupported in-scope submodule gitlink/);
    expect(existsSync(marker)).toBe(false);
  });

  it('allows a narrow path scope that excludes an in-repo submodule gitlink', async () => {
    if (process.platform === 'win32') return;
    const marker = path.join(repository, 'submodule-filter-ran-narrow');
    const subRepo = path.join(repository, 'nested-sub-narrow');
    mkdirSync(subRepo);
    gitAt(subRepo, ['init', '-b', 'main']);
    gitAt(subRepo, ['config', 'user.email', 'snapshot@example.test']);
    gitAt(subRepo, ['config', 'user.name', 'Snapshot Test']);
    writeFileSync(path.join(subRepo, 'payload.filtered'), 'inside-sub\n');
    writeFileSync(path.join(subRepo, '.gitattributes'), '[attr]unsafe-filter filter=unsafe\n*.filtered unsafe-filter\n');
    gitAt(subRepo, ['add', '.']);
    gitAt(subRepo, ['commit', '-m', 'sub initial']);
    gitAt(subRepo, ['config', 'filter.unsafe.clean', `#!/bin/sh\ntouch '${marker}'\ncat`]);
    gitAt(subRepo, ['config', 'filter.unsafe.process', `#!/bin/sh\ntouch '${marker}'\ncat`]);
    writeFileSync(path.join(subRepo, 'payload.filtered'), 'dirty inside-sub\n');

    addTrackedGitlink('vendor/narrow', subRepo);

    const snapshot = await inspectGitSnapshot(repository, { paths: ['src/one.ts'] });

    expect(snapshot.changedPaths.comparison).not.toContain('vendor/narrow');
    expect(existsSync(marker)).toBe(false);
  });

  it('fails closed when a staged deletion conceals an in-scope gitlink', async () => {
    const subRepo = path.join(repository, 'staged-delete-sub');
    mkdirSync(subRepo);
    gitAt(subRepo, ['init', '-b', 'main']);
    gitAt(subRepo, ['config', 'user.email', 'snapshot@example.test']);
    gitAt(subRepo, ['config', 'user.name', 'Snapshot Test']);
    writeFileSync(path.join(subRepo, 'README.md'), 'submodule\n');
    gitAt(subRepo, ['add', '.']);
    gitAt(subRepo, ['commit', '-m', 'initial']);
    addTrackedGitlink('vendor/staged-delete', subRepo);
    git(['rm', '--cached', 'vendor/staged-delete']);

    await expect(inspectGitSnapshot(repository, { paths: ['vendor/staged-delete'] })).rejects.toThrow(/gitlink/);
  });

  it('fails closed when either side of a historical range adds or deletes an in-scope gitlink', async () => {
    const subRepo = path.join(repository, 'historical-sub');
    mkdirSync(subRepo);
    gitAt(subRepo, ['init', '-b', 'main']);
    gitAt(subRepo, ['config', 'user.email', 'snapshot@example.test']);
    gitAt(subRepo, ['config', 'user.name', 'Snapshot Test']);
    writeFileSync(path.join(subRepo, 'README.md'), 'submodule\n');
    gitAt(subRepo, ['add', '.']);
    gitAt(subRepo, ['commit', '-m', 'initial']);
    const beforeAdd = git(['rev-parse', 'HEAD']);
    addTrackedGitlink('vendor/historical', subRepo);
    const withGitlink = git(['rev-parse', 'HEAD']);
    git(['rm', '-f', 'vendor/historical']);
    git(['commit', '-m', 'delete gitlink']);

    await expect(inspectGitSnapshot(repository, {
      range: `${beforeAdd}..${withGitlink}`,
      paths: ['vendor/historical'],
    })).rejects.toThrow(/gitlink/);
    await expect(inspectGitSnapshot(repository, {
      range: `${withGitlink}..HEAD`,
      paths: ['vendor/historical'],
    })).rejects.toThrow(/gitlink/);
  });

  it('fails closed when tracked scope paths are marked assume-unchanged or skip-worktree', async () => {
    write('src/one.ts', 'export const one = 99;\n');
    git(['update-index', '--assume-unchanged', 'src/one.ts']);
    await expect(inspectGitSnapshot(repository, { paths: ['src/one.ts'] })).rejects.toThrow(/assume-unchanged|skip-worktree/);
    git(['update-index', '--no-assume-unchanged', 'src/one.ts']);
    git(['checkout', '--', 'src/one.ts']);
    git(['update-index', '--skip-worktree', 'src/one.ts']);
    write('src/one.ts', 'export const one = 100;\n');
    await expect(inspectGitSnapshot(repository, { paths: ['src/one.ts'] })).rejects.toThrow(/assume-unchanged|skip-worktree/);
  });

  it('fails closed when untracked files exceed the bounded count or per-file byte limit', async () => {
    mkdirSync(path.join(repository, 'many'));
    for (let index = 0; index < 101; index += 1) {
      write(`many/${index}.txt`, 'x');
    }
    await expect(inspectGitSnapshot(repository, {})).rejects.toThrow(/untracked file count exceeded/);
    rmSync(path.join(repository, 'many'), { recursive: true, force: true });
    write('oversized-untracked.txt', 'x'.repeat(2 * 1024 * 1024 + 1));
    await expect(inspectGitSnapshot(repository, {})).rejects.toThrow(/untracked file size exceeded/);
    unlinkSync(path.join(repository, 'oversized-untracked.txt'));
    for (let index = 0; index < 5; index += 1) {
      write(`total-${index}.txt`, 'x'.repeat(2 * 1024 * 1024));
    }
    await expect(inspectGitSnapshot(repository, {})).rejects.toThrow(/total untracked byte limit exceeded/);
  });

  it('uses fixed execFile argument arrays instead of a raw shell API', () => {
    const source = readFileSync(new URL('./git-snapshot.ts', import.meta.url), 'utf8');

    expect(source).toContain('execFile');
    expect(source).toContain('--ignore-submodules=all');
    expect(source).toMatch(/shell:\s*false/);
    expect(source).toContain('--no-textconv');
    expect(source).toContain('--literal-pathspecs');
    expect(source).toContain("spawn('git'");
    expect(source).toContain("'hash-object', '-t', 'tree', '--stdin'");
    expect(source).toContain('timeout: GIT_TIMEOUT_MS');
    expect(source).toContain('Git snapshot timed out');
    expect(source).not.toMatch(/\b(?:execSync|execFileSync|spawnSync)\s*\(/);
    expect(source).not.toContain('Bun.$');
  });
});
