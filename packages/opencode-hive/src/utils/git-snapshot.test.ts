import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  inspectGitSnapshot,
  GitSnapshotError,
  setSnapshotCaptureTestSeams,
} from './git-snapshot.js';
import type { SnapshotCaptureBoundary, SnapshotCaptureTestSeams } from './git-snapshot.js';

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
  setSnapshotCaptureTestSeams();
  rmSync(repository, { recursive: true, force: true });
});

/**
 * Installs deterministic capture seams for one test. A boundary mutation runs
 * exactly once, at the named awaited capture step, with no sleeps involved.
 */
function injectAtBoundary(
  boundary: SnapshotCaptureBoundary,
  mutate: () => void,
): void {
  let injected = false;
  setSnapshotCaptureTestSeams({
    onBoundary: (current) => {
      if (current !== boundary || injected) return;
      injected = true;
      mutate();
    },
  });
}

/** Returns the outcome of a capture as either a snapshot or a typed error. */
async function captureOutcome(input: Parameters<typeof inspectGitSnapshot>[1]) {
  try {
    return { kind: 'snapshot' as const, snapshot: await inspectGitSnapshot(repository, input) };
  } catch (error) {
    if (!(error instanceof GitSnapshotError)) throw error;
    return { kind: 'error' as const, error };
  }
}

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

  it('excludes unrelated dirty state from a committed target snapshot', async () => {
    const target = git(['rev-parse', 'HEAD']);
    const clean = await inspectGitSnapshot(repository, { targetRef: target });
    write('src/one.ts', 'export const one = 99;\n');
    write('untracked.txt', 'unrelated dirty state\n');

    const committed = await inspectGitSnapshot(repository, { targetRef: target });

    expect(committed.changedPaths.staged).toEqual([]);
    expect(committed.changedPaths.unstaged).toEqual([]);
    expect(committed.changedPaths.untracked).toEqual([]);
    expect(committed.fingerprint).toBe(clean.fingerprint);
  });

  it('changes the fingerprint when a target ref moves to an otherwise identical commit', async () => {
    git(['checkout', '-b', 'moving-ref']);
    git(['commit', '--allow-empty', '-m', 'first empty target']);
    const first = await inspectGitSnapshot(repository, { targetRef: 'moving-ref' });
    git(['commit', '--allow-empty', '-m', 'second empty target']);
    const second = await inspectGitSnapshot(repository, { targetRef: 'moving-ref' });

    expect(first.patch).toBe(second.patch);
    expect(first.fingerprint).not.toBe(second.fingerprint);
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

  it('classifies a valid missing ref structurally without exposing Git stderr', async () => {
    const missing = '9'.repeat(40);
    try {
      await inspectGitSnapshot(repository, { baseRef: missing, targetRef: 'HEAD' });
      throw new Error('expected missing ref failure');
    } catch (error) {
      expect(error).toBeInstanceOf(GitSnapshotError);
      expect(error).toMatchObject({
        code: 'missing-ref',
        details: { field: 'baseRef', ref: missing },
      });
      expect((error as Error).message).not.toContain('fatal:');
    }
  });

  it('does not classify a broken ref database entry as a missing ref', async () => {
    writeFileSync(path.join(repository, '.git', 'refs', 'heads', 'broken-ref'), 'not-an-object-id\n');

    try {
      await inspectGitSnapshot(repository, { baseRef: 'broken-ref', targetRef: 'HEAD' });
      throw new Error('expected broken ref failure');
    } catch (error) {
      expect(error).not.toMatchObject({ code: 'missing-ref' });
    }
  });

  it('does not classify corrupt object storage as a missing ref', async () => {
    const base = git(['rev-parse', 'HEAD^']);
    const objectPath = path.join(repository, '.git', 'objects', base.slice(0, 2), base.slice(2));
    chmodSync(objectPath, 0o644);
    writeFileSync(objectPath, 'corrupt object');

    try {
      await inspectGitSnapshot(repository, { baseRef: base, targetRef: 'HEAD' });
      throw new Error('expected corrupt object failure');
    } catch (error) {
      expect(error).not.toMatchObject({ code: 'missing-ref' });
    }
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

    try {
      await inspectGitSnapshot(repository, {});
      throw new Error('expected output boundary failure');
    } catch (error) {
      expect(error).toBeInstanceOf(GitSnapshotError);
      expect(error).toMatchObject({ code: 'OUTPUT_LIMIT_EXCEEDED', phase: 'capture', retry: 'narrow-scope' });
      expect((error as Error).message).toContain('Git snapshot output exceeded');
    }
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

  it('marks every returned snapshot as a validated generation', async () => {
    const snapshot = await inspectGitSnapshot(repository, {});

    expect(snapshot.consistency).toBe('validated');
  });

  it('reports per-section omissions that satisfy the byte identity', async () => {
    write('src/one.ts', `export const payload = '${'x'.repeat(80 * 1024)}';\n`);
    write('untracked-note.txt', 'untracked body\n');

    const snapshot = await inspectGitSnapshot(repository, { maxPatchBytes: 32 * 1024 });

    expect(snapshot.omissions.sections.map(({ section }) => section)).toEqual([
      'comparison',
      'staged',
      'unstaged',
      'untracked:untracked-note.txt',
    ]);
    for (const section of snapshot.omissions.sections) {
      expect(section.capturedBytes).toBe(section.returnedBytes + section.omittedBytes);
      expect(['section-preview-limit', 'aggregate-limit', null]).toContain(section.reason);
    }
    const unstaged = snapshot.omissions.sections.find(({ section }) => section === 'unstaged')!;
    expect(unstaged.reason).toBe('section-preview-limit');
    expect(unstaged.omittedBytes).toBeGreaterThan(0);
    // The oversized diff consumes the aggregate patch bound before the small
    // untracked section, so that section reports the later aggregate cause.
    const untracked = snapshot.omissions.sections.find(({ section }) => section === 'untracked:untracked-note.txt')!;
    expect(untracked.reason).toBe('aggregate-limit');
    expect(untracked.omittedBytes).toBe(untracked.capturedBytes);
  });

  it('reports no reason for a section the patch returned whole', async () => {
    write('untracked-whole.txt', 'small body\n');

    const snapshot = await inspectGitSnapshot(repository, {});

    const untracked = snapshot.omissions.sections.find(({ section }) => section === 'untracked:untracked-whole.txt')!;
    expect(untracked.reason).toBeNull();
    expect(untracked.omittedBytes).toBe(0);
    expect(untracked.capturedBytes).toBe(untracked.returnedBytes);
  });

  it('reports the earlier preview cause when a section is clipped twice', async () => {
    write('src/one.ts', `export const payload = '${'x'.repeat(80 * 1024)}';\n`);

    const snapshot = await inspectGitSnapshot(repository, { maxPatchBytes: 1024 });

    const unstaged = snapshot.omissions.sections.find(({ section }) => section === 'unstaged')!;
    expect(unstaged.reason).toBe('section-preview-limit');
    expect(snapshot.omissions.patch.truncated).toBe(true);
    expect(snapshot.omissions.patch.omittedBytes).toBeGreaterThan(unstaged.omittedBytes);
  });

  it('classifies caller validation failures before any Git command runs', async () => {
    const outcome = await inspectGitSnapshot(repository, { range: 'HEAD;git-status' }).catch((error) => error);

    expect(outcome).toBeInstanceOf(GitSnapshotError);
    expect(outcome).toMatchObject({
      code: 'INVALID_REQUEST',
      phase: 'validation',
      retry: 'not-retryable',
    });
  });

  it('classifies unsafe repository states with their phases and retries', async () => {
    const subRepo = path.join(repository, 'typed-gitlink-sub');
    mkdirSync(subRepo);
    gitAt(subRepo, ['init', '-b', 'main']);
    gitAt(subRepo, ['config', 'user.email', 'snapshot@example.test']);
    gitAt(subRepo, ['config', 'user.name', 'Snapshot Test']);
    writeFileSync(path.join(subRepo, 'README.md'), 'submodule\n');
    gitAt(subRepo, ['add', '.']);
    gitAt(subRepo, ['commit', '-m', 'initial']);
    addTrackedGitlink('vendor/typed', subRepo);

    const outcome = await inspectGitSnapshot(repository, {}).catch((error) => error);

    expect(outcome).toBeInstanceOf(GitSnapshotError);
    expect(outcome).toMatchObject({
      code: 'UNSAFE_REPOSITORY_STATE',
      phase: 'preflight',
      retry: 'operator-action',
    });
    expect(outcome.message).toContain('vendor/typed');
  });

  it('classifies untracked count and byte bounds as incomplete untracked capture', async () => {
    mkdirSync(path.join(repository, 'bounded'));
    for (let index = 0; index < 101; index += 1) {
      write(`bounded/${index}.txt`, 'x');
    }

    const countOutcome = await inspectGitSnapshot(repository, {}).catch((error) => error);
    expect(countOutcome).toBeInstanceOf(GitSnapshotError);
    expect(countOutcome).toMatchObject({
      code: 'INCOMPLETE_UNTRACKED_CAPTURE',
      phase: 'untracked-capture',
      retry: 'narrow-scope',
    });

    rmSync(path.join(repository, 'bounded'), { recursive: true, force: true });
    write('oversized-typed.txt', 'x'.repeat(2 * 1024 * 1024 + 1));

    const byteOutcome = await inspectGitSnapshot(repository, {}).catch((error) => error);
    expect(byteOutcome).toBeInstanceOf(GitSnapshotError);
    expect(byteOutcome).toMatchObject({
      code: 'INCOMPLETE_UNTRACKED_CAPTURE',
      phase: 'untracked-capture',
      retry: 'narrow-scope',
    });
    expect(byteOutcome.message).toContain('oversized-typed.txt');
  });

  it('reports the operation phase and elapsed bounds when the operation deadline elapses', async () => {
    write('untracked-deadline.txt', 'body\n');
    let now = 1_000;
    setSnapshotCaptureTestSeams({
      now: () => now,
      onBoundary: (boundary) => {
        if (boundary === 'untracked-capture-started') now = 20_000;
      },
    });

    const outcome = await inspectGitSnapshot(repository, {}).catch((error) => error);

    expect(outcome).toBeInstanceOf(GitSnapshotError);
    expect(outcome).toMatchObject({
      code: 'OPERATION_TIMEOUT',
      phase: 'untracked-capture',
      retry: 'fresh-capture',
      elapsedMs: 19_000,
      limitMs: 15_000,
    });
  });

  it('classifies an exhausted untracked deadline as incomplete untracked capture', async () => {
    write('untracked-deadline-two.txt', 'body\n');
    let now = 1_000;
    setSnapshotCaptureTestSeams({
      now: () => now,
      onBoundary: (boundary) => {
        // Past the five-second untracked bound, still inside the 15s operation
        // deadline, so only the untracked bound has expired.
        if (boundary === 'untracked-capture-started') now = 13_000;
      },
    });

    const outcome = await inspectGitSnapshot(repository, {}).catch((error) => error);

    expect(outcome).toBeInstanceOf(GitSnapshotError);
    expect(outcome).toMatchObject({
      code: 'INCOMPLETE_UNTRACKED_CAPTURE',
      phase: 'untracked-capture',
      retry: 'narrow-scope',
    });
    expect(outcome.code).not.toBe('timeout');
  });

  it('never mixes repository generations when tracked content changes mid-capture', async () => {
    write('src/one.ts', 'export const one = 50;\n');
    const before = await inspectGitSnapshot(repository, {});

    injectAtBoundary('comparison-diff-captured', () => write('src/one.ts', 'export const one = 51;\n'));
    const outcome = await captureOutcome({});
    setSnapshotCaptureTestSeams();
    const after = await inspectGitSnapshot(repository, {});

    if (outcome.kind === 'error') {
      expect(outcome.error).toMatchObject({ code: 'SOURCE_DRIFT', phase: 'revalidation', retry: 'fresh-capture' });
    } else {
      expect([before.fingerprint, after.fingerprint]).toContain(outcome.snapshot.fingerprint);
    }
  });

  it('never mixes repository generations when the index changes mid-capture', async () => {
    write('src/staged-late.ts', 'staged late\n');
    const before = await inspectGitSnapshot(repository, {});

    injectAtBoundary('staged-diff-captured', () => git(['add', 'src/staged-late.ts']));
    const outcome = await captureOutcome({});
    setSnapshotCaptureTestSeams();
    const after = await inspectGitSnapshot(repository, {});

    if (outcome.kind === 'error') {
      expect(outcome.error).toMatchObject({ code: 'SOURCE_DRIFT', phase: 'revalidation' });
    } else {
      expect([before.fingerprint, after.fingerprint]).toContain(outcome.snapshot.fingerprint);
      expect(outcome.snapshot.changedPaths.staged).toEqual(after.changedPaths.staged);
    }
  });

  it('never mixes repository generations when HEAD moves mid-capture', async () => {
    // Move HEAD without touching the index or worktree, so this exercises the
    // resolved-commit probe rather than the captured-content probe.
    git(['checkout', '-q', '--detach']);
    git(['commit', '--allow-empty', '-m', 'alternate head']);
    const alternateHead = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', 'main']);
    const originalHead = git(['rev-parse', 'HEAD']);
    const before = await inspectGitSnapshot(repository, {});
    const indexBefore = readFileSync(path.join(repository, '.git', 'index'));

    injectAtBoundary('unstaged-diff-captured', () => git(['update-ref', 'HEAD', alternateHead]));
    const outcome = await captureOutcome({});
    setSnapshotCaptureTestSeams();

    expect(readFileSync(path.join(repository, '.git', 'index'))).toEqual(indexBefore);
    if (outcome.kind === 'error') {
      expect(outcome.error).toMatchObject({ code: 'SOURCE_DRIFT', phase: 'revalidation' });
    } else {
      expect([originalHead, alternateHead]).toContain(outcome.snapshot.repository.currentHead);
      expect(outcome.snapshot.fingerprint).toBe(before.fingerprint);
    }
  });

  it('never mixes repository generations when an untracked file appears mid-capture', async () => {
    const before = await inspectGitSnapshot(repository, {});

    injectAtBoundary('untracked-listed', () => write('untracked-race.txt', 'appeared\n'));
    const outcome = await captureOutcome({});
    setSnapshotCaptureTestSeams();
    const after = await inspectGitSnapshot(repository, {});

    if (outcome.kind === 'error') {
      expect(outcome.error).toMatchObject({ code: 'SOURCE_DRIFT', phase: 'revalidation' });
    } else {
      expect([before.fingerprint, after.fingerprint]).toContain(outcome.snapshot.fingerprint);
      expect(outcome.snapshot.changedPaths.untracked).toEqual(after.changedPaths.untracked);
    }
  });

  it('never mixes repository generations when an untracked file is deleted mid-capture', async () => {
    write('untracked-vanishing.txt', 'present\n');
    const before = await inspectGitSnapshot(repository, {});

    injectAtBoundary('untracked-listed', () => unlinkSync(path.join(repository, 'untracked-vanishing.txt')));
    const outcome = await captureOutcome({});
    setSnapshotCaptureTestSeams();
    const after = await inspectGitSnapshot(repository, {});

    if (outcome.kind === 'error') {
      // A path that vanishes between discovery and read is detected in the
      // untracked-capture phase; a silent mutation is caught at revalidation.
      expect(outcome.error).toMatchObject({ code: 'SOURCE_DRIFT', retry: 'fresh-capture' });
      expect(['untracked-capture', 'revalidation']).toContain(outcome.error.phase);
    } else {
      expect([before.fingerprint, after.fingerprint]).toContain(outcome.snapshot.fingerprint);
      expect(outcome.snapshot.changedPaths.untracked).toEqual(after.changedPaths.untracked);
    }
  });

  it('never mixes repository generations when an untracked file is rewritten mid-capture', async () => {
    write('untracked-rewritten.txt', 'first body\n');
    const before = await inspectGitSnapshot(repository, {});

    injectAtBoundary('before-revalidation', () => write('untracked-rewritten.txt', 'second body\n'));
    const outcome = await captureOutcome({});
    setSnapshotCaptureTestSeams();
    const after = await inspectGitSnapshot(repository, {});

    if (outcome.kind === 'error') {
      expect(outcome.error).toMatchObject({ code: 'SOURCE_DRIFT', phase: 'revalidation' });
    } else {
      expect([before.fingerprint, after.fingerprint]).toContain(outcome.snapshot.fingerprint);
    }
  });

  it('keeps a committed target generation blind to unrelated dirty state during capture', async () => {
    const target = git(['rev-parse', 'HEAD']);
    injectAtBoundary('comparison-diff-captured', () => {
      write('src/one.ts', 'export const one = 77;\n');
      write('untracked-unrelated.txt', 'unrelated\n');
    });

    const snapshot = await inspectGitSnapshot(repository, { targetRef: target });

    expect(snapshot.consistency).toBe('validated');
    expect(snapshot.changedPaths.staged).toEqual([]);
    expect(snapshot.changedPaths.unstaged).toEqual([]);
    expect(snapshot.changedPaths.untracked).toEqual([]);
  });

});
