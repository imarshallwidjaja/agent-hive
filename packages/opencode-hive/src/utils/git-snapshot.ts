import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { devNull } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const MAX_FILES = 200;
const MAX_PATCH_BYTES = 256 * 1024;
const SOURCE_PREVIEW_BYTES = 64 * 1024;
const MAX_UNTRACKED_FILES = 100;
const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_PREVIEW_BYTES = 128 * 1024;
const UNTRACKED_CAPTURE_TIMEOUT_MS = 5_000;
const SAFE_GIT_CONFIG = [
  '-c', 'core.fsmonitor=false',
  '-c', 'diff.external=',
  '-c', 'credential.helper=',
  '-c', 'fetch.ifMissing=false',
  '-c', 'remote.origin.promisor=false',
  '-c', 'core.hooksPath=',
] as const;
const GITLINK_MODE = '160000';
const IGNORE_SUBMODULES = ['--ignore-submodules=all'] as const;

export type GitSnapshotInput = {
  baseRef?: string;
  targetRef?: string;
  range?: string;
  paths?: string[];
  maxFiles?: number;
  maxPatchBytes?: number;
};

type CapturedContent = {
  byteLength: number;
  digest: string;
  preview: Buffer;
  previewTruncated: boolean;
  fileType?: 'regular' | 'symlink';
  mode?: number;
};

type ChangedPathGroup = 'comparison' | 'staged' | 'unstaged' | 'untracked';

type BoundedPaths = {
  values: string[];
  omitted: number;
};

function captureBuffer(
  content: Buffer,
  metadata: Pick<CapturedContent, 'fileType' | 'mode'> = {},
  previewLimit = SOURCE_PREVIEW_BYTES,
): CapturedContent {
  const previewLength = Math.min(content.byteLength, previewLimit);
  return {
    byteLength: content.byteLength,
    digest: createHash('sha256').update(content).digest('hex'),
    preview: content.subarray(0, previewLength),
    previewTruncated: content.byteLength > previewLength,
    ...metadata,
  };
}

type FileIdentity = { dev: number | bigint; ino: number | bigint; mode: number | bigint; size: number | bigint; mtimeMs: number | bigint; ctimeMs: number | bigint };

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertUntrackedDeadline(deadline: number): void {
  if (Date.now() > deadline) {
    throw new Error(`Untracked snapshot incomplete: capture deadline exceeded after ${UNTRACKED_CAPTURE_TIMEOUT_MS}ms.`);
  }
}

async function captureRegularFile(
  filePath: string,
  expected: Awaited<ReturnType<typeof fs.lstat>>,
  previewLimit: number,
  deadline: number,
  remainingBytes: number,
): Promise<CapturedContent> {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error(`O_NOFOLLOW is unavailable; cannot safely inspect untracked file: ${filePath}`);
  }
  if (expected.size > MAX_UNTRACKED_FILE_BYTES) {
    throw new Error(`Untracked snapshot incomplete: untracked file size exceeded ${MAX_UNTRACKED_FILE_BYTES} bytes: ${filePath}`);
  }
  if (expected.size > remainingBytes) {
    throw new Error(`Untracked snapshot incomplete: total untracked byte limit exceeded ${MAX_UNTRACKED_TOTAL_BYTES} bytes.`);
  }

  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || !sameFileIdentity(expected, opened)) {
      throw new Error(`Untracked file changed before safe read: ${filePath}`);
    }

    const hash = createHash('sha256');
    const preview: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let byteLength = 0;
    let previewLength = 0;
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      assertUntrackedDeadline(deadline);
      if (byteLength + bytesRead > MAX_UNTRACKED_FILE_BYTES) {
        throw new Error(`Untracked snapshot incomplete: untracked file size exceeded ${MAX_UNTRACKED_FILE_BYTES} bytes: ${filePath}`);
      }
      if (byteLength + bytesRead > remainingBytes) {
        throw new Error(`Untracked snapshot incomplete: total untracked byte limit exceeded ${MAX_UNTRACKED_TOTAL_BYTES} bytes.`);
      }
      if (previewLength < previewLimit) {
        const part = Buffer.from(chunk.subarray(0, previewLimit - previewLength));
        preview.push(part);
        previewLength += part.byteLength;
      }
      byteLength += bytesRead;
      position += bytesRead;
    }

    const completed = await file.stat();
    if (!sameFileIdentity(opened, completed)) {
      throw new Error(`Untracked file changed during safe read: ${filePath}`);
    }
    return {
      byteLength,
      digest: hash.digest('hex'),
      preview: Buffer.concat(preview),
      previewTruncated: byteLength > previewLength,
      fileType: 'regular',
      mode: completed.mode & 0o7777,
    };
  } finally {
    await file.close();
  }
}

async function captureSymlink(
  filePath: string,
  expected: Awaited<ReturnType<typeof fs.lstat>>,
  previewLimit: number,
  deadline: number,
  remainingBytes: number,
): Promise<CapturedContent> {
  assertUntrackedDeadline(deadline);
  const target = await fs.readlink(filePath);
  const completed = await fs.lstat(filePath);
  if (!completed.isSymbolicLink() || !sameFileIdentity(expected, completed)) {
    throw new Error(`Untracked symlink changed during safe read: ${filePath}`);
  }
  const content = Buffer.from(target);
  if (content.byteLength > MAX_UNTRACKED_FILE_BYTES) {
    throw new Error(`Untracked snapshot incomplete: untracked file size exceeded ${MAX_UNTRACKED_FILE_BYTES} bytes: ${filePath}`);
  }
  if (content.byteLength > remainingBytes) {
    throw new Error(`Untracked snapshot incomplete: total untracked byte limit exceeded ${MAX_UNTRACKED_TOTAL_BYTES} bytes.`);
  }
  return captureBuffer(content, {
    fileType: 'symlink',
    mode: completed.mode & 0o7777,
  }, previewLimit);
}

async function captureFile(filePath: string, previewLimit: number, deadline: number, remainingBytes: number): Promise<CapturedContent> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) return captureSymlink(filePath, stat, previewLimit, deadline, remainingBytes);
  if (stat.isFile()) return captureRegularFile(filePath, stat, previewLimit, deadline, remainingBytes);
  throw new Error(`Unsupported untracked file type: ${filePath}`);
}

async function captureBeforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`Untracked snapshot incomplete: capture deadline exceeded after ${UNTRACKED_CAPTURE_TIMEOUT_MS}ms.`);
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Untracked snapshot incomplete: capture deadline exceeded after ${UNTRACKED_CAPTURE_TIMEOUT_MS}ms.`));
        }, remaining);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function hardenedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_CONFIG_') || key === 'GIT_DIR' || key === 'GIT_WORK_TREE' || key === 'GIT_INDEX_FILE' || key === 'GIT_OBJECT_DIRECTORY' || key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' || key === 'GIT_EXTERNAL_DIFF' || key === 'GIT_DIFF_OPTS') {
      delete environment[key];
    }
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
}

function normalizeGitError(error: unknown): never {
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || String(failure.message).includes('maxBuffer')) {
    throw new Error(`Git snapshot output exceeded ${MAX_GIT_OUTPUT_BYTES} bytes.`);
  }
  if (failure.killed === true || failure.signal === 'SIGTERM' || failure.code === 'ETIMEDOUT') {
    throw new Error(`Git snapshot timed out after ${GIT_TIMEOUT_MS}ms.`);
  }
  throw error;
}

function gitArgs(repository: string, args: string[]): string[] {
  return [
    ...SAFE_GIT_CONFIG,
    '--no-replace-objects',
    '--literal-pathspecs',
    '-C', repository,
    ...args,
  ];
}

async function runGit(repository: string, args: string[]): Promise<Buffer> {
  try {
    const result = await execFileAsync('git', gitArgs(repository, args), {
      encoding: 'buffer',
      env: hardenedGitEnvironment(),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      shell: false,
      timeout: GIT_TIMEOUT_MS,
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch (error) {
    normalizeGitError(error);
  }
}

async function runGitWithStdin(repository: string, args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs(repository, args), {
      env: hardenedGitEnvironment(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let overflowed = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, GIT_TIMEOUT_MS);
    const consume = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        overflowed = true;
        child.kill('SIGTERM');
        return;
      }
      output.push(chunk);
    };

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (overflowed) {
        reject(new Error(`Git snapshot output exceeded ${MAX_GIT_OUTPUT_BYTES} bytes.`));
      } else if (timedOut) {
        reject(new Error(`Git snapshot timed out after ${GIT_TIMEOUT_MS}ms.`));
      } else if (code !== 0) {
        reject(new Error(`Git snapshot command failed with exit code ${code}.`));
      } else {
        resolve(Buffer.concat(output));
      }
    });
    child.stdin.end(input);
  });
}

async function tryRunGit(repository: string, args: string[]): Promise<Buffer | undefined> {
  try {
    return await runGit(repository, args);
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === 'number') {
      return undefined;
    }
    throw error;
  }
}

function parseNullSeparatedPaths(content: Buffer): string[] {
  return content.toString('utf8').split('\0').filter(Boolean).sort();
}

function parseLsFilesStages(content: Buffer): Array<{ mode: string; path: string }> {
  return content.toString('utf8').split('\0').filter(Boolean).map((entry) => {
    const match = /^(\S+)\s+\S+\s+\d+\t(.+)$/.exec(entry);
    if (!match) {
      throw new Error('Malformed Git ls-files response.');
    }
    return { mode: match[1], path: match[2] };
  });
}

function parseLsTree(content: Buffer): Array<{ mode: string; path: string }> {
  return content.toString('utf8').split('\0').filter(Boolean).map((entry) => {
    const match = /^(\S+)\s+\S+\s+\S+\t(.+)$/.exec(entry);
    if (!match) {
      throw new Error('Malformed Git ls-tree response.');
    }
    return { mode: match[1], path: match[2] };
  });
}

async function assertNoInScopeSubmoduleGitlinks(
  repository: string,
  comparisonBase: string,
  comparisonTarget: string,
  pathArgs: string[],
): Promise<void> {
  const [base, target, staged] = await Promise.all([
    runGit(repository, ['ls-tree', '-r', '-z', comparisonBase, ...pathArgs]),
    runGit(repository, ['ls-tree', '-r', '-z', comparisonTarget, ...pathArgs]),
    runGit(repository, ['ls-files', '-s', '-z', ...pathArgs]),
  ]);
  const gitlinks = [
    ...parseLsTree(base).filter(({ mode }) => mode === GITLINK_MODE).map(({ path }) => `comparison base:${path}`),
    ...parseLsTree(target).filter(({ mode }) => mode === GITLINK_MODE).map(({ path }) => `comparison target:${path}`),
    ...parseLsFilesStages(staged).filter(({ mode }) => mode === GITLINK_MODE).map(({ path }) => `index:${path}`),
  ];
  if (gitlinks.length === 0) {
    return;
  }
  throw new Error(
    `Unsupported in-scope submodule gitlink: ${[...new Set(gitlinks)].sort().join(', ')}; snapshot scope is incomplete.`,
  );
}

async function assertNoConcealedIndexPaths(repository: string, pathArgs: string[]): Promise<void> {
  const entries = parseNullSeparatedPaths(await runGit(repository, ['ls-files', '-v', '-z', ...pathArgs]));
  const concealed = entries.flatMap((entry) => {
    const match = /^([A-Za-z]) (.+)$/.exec(entry);
    if (!match) {
      throw new Error('Malformed Git ls-files visibility response.');
    }
    const [, tag, filePath] = match;
    if (tag === 'S') return [`skip-worktree:${filePath}`];
    if (tag === tag.toLowerCase()) return [`assume-unchanged:${filePath}`];
    return [];
  });
  if (concealed.length > 0) {
    throw new Error(`Concealed tracked paths (${concealed.sort().join(', ')}); snapshot scope is incomplete.`);
  }
}

async function resolveAuthorizedGitRoot(repositoryDirectory: string): Promise<string> {
  const authorizedRepository = await fs.realpath(repositoryDirectory);
  const reportedRoot = (await runGit(authorizedRepository, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  const repository = await fs.realpath(reportedRoot);
  if (repository !== authorizedRepository) {
    throw new Error('Git repository root does not match the authorized repository root.');
  }
  return repository;
}

export async function isExactGitTopLevel(repositoryDirectory: string): Promise<boolean> {
  try {
    await resolveAuthorizedGitRoot(repositoryDirectory);
    return true;
  } catch {
    return false;
  }
}

async function resolveEmptyTree(repository: string): Promise<string> {
  return (await runGitWithStdin(repository, ['hash-object', '-t', 'tree', '--stdin'], Buffer.alloc(0))).toString('utf8').trim();
}

function parseFilterAttributes(content: Buffer): Array<{ path: string; value: string }> {
  const fields = content.toString('utf8').split('\0').filter(Boolean);
  const attributes: Array<{ path: string; value: string }> = [];
  for (let index = 0; index < fields.length; index += 3) {
    const [filePath, attribute, value] = fields.slice(index, index + 3);
    if (attribute !== 'filter' || value === undefined) {
      throw new Error('Malformed Git filter attribute response.');
    }
    attributes.push({ path: filePath, value });
  }
  return attributes;
}

async function assertNoFilterAttributes(repository: string, pathArgs: string[]): Promise<void> {
  const trackedPaths = parseNullSeparatedPaths(await runGit(repository, ['ls-files', '-z', ...pathArgs]));
  for (let index = 0; index < trackedPaths.length; index += 200) {
    const batch = trackedPaths.slice(index, index + 200);
    const attributes = parseFilterAttributes(await runGit(repository, ['check-attr', '-z', 'filter', '--', ...batch]));
    const blocked = attributes.find(({ value }) => value !== 'unspecified' && value !== 'unset');
    if (blocked) {
      throw new Error(`Unsupported filter attribute for ${blocked.path}: ${blocked.value}; snapshot scope is incomplete.`);
    }
  }
}

function assertSafeRef(value: string, field: 'baseRef' | 'targetRef'): string {
  if (!value || value.startsWith('-')) {
    throw new Error(`${field} must not start with "-" or be empty.`);
  }
  const revisionMatch = /^(.+?)(?:~\d+|\^\d*)?$/.exec(value);
  const refName = revisionMatch?.[1];
  if (
    !refName
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(refName)
    || refName.includes('..')
    || refName.includes('//')
    || refName.includes('@{')
    || refName.endsWith('.')
    || refName.endsWith('/')
    || refName.includes('/.')
  ) {
    throw new Error(`Invalid Git ref for ${field}: ${value}`);
  }
  return value;
}

function parseRange(range: string): { baseRef: string; targetRef: string; mergeBase: boolean } {
  const match = /^(.+?)(\.\.\.?)(.+)$/.exec(range);
  if (!match) {
    throw new Error('range must use base..target or base...target.');
  }
  return {
    baseRef: assertSafeRef(match[1], 'baseRef'),
    targetRef: assertSafeRef(match[3], 'targetRef'),
    mergeBase: match[2] === '...',
  };
}

function normalizeScopedPaths(paths: string[] | undefined): string[] {
  if (!paths) return [];
  const normalized = paths.map((value) => {
    if (!value || value.startsWith('-')) {
      throw new Error('Scoped paths must not start with "-" or be empty.');
    }
    if (value.startsWith(':')) {
      throw new Error(`Scoped path must not use pathspec magic: ${value}`);
    }
    if (value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) {
      throw new Error(`Scoped path must be repository-relative: ${value}`);
    }
    const normalizedPath = path.posix.normalize(value);
    if (normalizedPath === '..' || normalizedPath.startsWith('../')) {
      throw new Error(`Scoped path must be repository-relative: ${value}`);
    }
    return normalizedPath;
  });
  return [...new Set(normalized)].sort();
}

function resolveLimit(value: number | undefined, fallback: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return Math.min(value, maximum);
}

function boundPaths(paths: string[], maxFiles: number): BoundedPaths {
  return {
    values: paths.slice(0, maxFiles),
    omitted: Math.max(0, paths.length - maxFiles),
  };
}

function appendFingerprint(hash: ReturnType<typeof createHash>, label: string, content: CapturedContent): void {
  hash.update(label);
  hash.update('\0');
  hash.update(content.digest);
  hash.update('\0');
  hash.update(String(content.byteLength));
  hash.update('\0');
  hash.update(content.fileType ?? 'git');
  hash.update('\0');
  hash.update(content.mode === undefined ? '' : String(content.mode));
  hash.update('\0');
}

function materialSection(label: string, content: CapturedContent): Buffer {
  const suffix = content.previewTruncated
    ? `\n[${label} preview truncated; full content remains in the fingerprint]\n`
    : '\n';
  return Buffer.concat([
    Buffer.from(`\n=== ${label} ===\n`),
    content.preview,
    Buffer.from(suffix),
  ]);
}

function truncateUtf8(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content) <= maxBytes) return content;
  let end = Math.min(content.length, maxBytes);
  while (end > 0 && Buffer.byteLength(content.slice(0, end)) > maxBytes) {
    end -= 1;
  }
  return content.slice(0, end);
}

async function resolveCommit(repository: string, ref: string): Promise<string> {
  return (await runGit(repository, ['rev-parse', '--verify', `${ref}^{commit}`])).toString('utf8').trim();
}

async function firstParent(repository: string, commit: string): Promise<string | undefined> {
  const output = (await runGit(repository, ['rev-list', '--parents', '-n', '1', commit])).toString('utf8').trim();
  return output.split(/\s+/)[1];
}

async function resolveMergeBase(repository: string, base: string, target: string): Promise<string | undefined> {
  const output = await tryRunGit(repository, ['merge-base', base, target]);
  return output?.toString('utf8').trim() || undefined;
}

function repoPath(repository: string, relativePath: string): string {
  const resolved = path.resolve(repository, relativePath);
  if (resolved !== repository && !resolved.startsWith(`${repository}${path.sep}`)) {
    throw new Error(`Scoped path must be repository-relative: ${relativePath}`);
  }
  return resolved;
}

export async function inspectGitSnapshot(repositoryDirectory: string, input: GitSnapshotInput): Promise<{
  repository: { root: string; currentHead: string };
  scope: {
    baseRef?: string;
    targetRef?: string;
    range?: string;
    paths: string[];
    comparisonBase?: string;
    comparisonTarget: string;
    mergeBase?: string;
  };
  limits: { maxFiles: number; maxPatchBytes: number };
  changedPaths: Record<ChangedPathGroup, string[]>;
  fingerprint: string;
  patch: string;
  omissions: {
    changedPaths: Record<ChangedPathGroup, number>;
    patch: { truncated: boolean; omittedBytes: number };
  };
}> {
  if (input.range && (input.baseRef || input.targetRef)) {
    throw new Error('range cannot be combined with baseRef or targetRef.');
  }

  const paths = normalizeScopedPaths(input.paths);
  const maxFiles = resolveLimit(input.maxFiles, 100, MAX_FILES, 'maxFiles');
  const maxPatchBytes = resolveLimit(input.maxPatchBytes, 64 * 1024, MAX_PATCH_BYTES, 'maxPatchBytes');
  const repository = await resolveAuthorizedGitRoot(repositoryDirectory);
  const currentHead = await resolveCommit(repository, 'HEAD');
  let comparisonBase: string | undefined;
  let comparisonTarget = currentHead;
  let mergeBase: string | undefined;
  let baseRef = input.baseRef;
  let targetRef = input.targetRef;

  if (input.range) {
    const parsed = parseRange(input.range);
    baseRef = parsed.baseRef;
    targetRef = parsed.targetRef;
    const base = await resolveCommit(repository, parsed.baseRef);
    const target = await resolveCommit(repository, parsed.targetRef);
    mergeBase = await resolveMergeBase(repository, base, target);
    if (!mergeBase) {
      throw new Error(`No merge base for ${parsed.baseRef} and ${parsed.targetRef}; snapshot scope is incomplete.`);
    }
    comparisonBase = parsed.mergeBase ? mergeBase : base;
    comparisonTarget = target;
  } else {
    const target = targetRef
      ? await resolveCommit(repository, assertSafeRef(targetRef, 'targetRef'))
      : currentHead;
    const base = baseRef
      ? await resolveCommit(repository, assertSafeRef(baseRef, 'baseRef'))
      : await firstParent(repository, target);
    comparisonBase = base ?? await resolveEmptyTree(repository);
    comparisonTarget = target;
    mergeBase = base ? await resolveMergeBase(repository, base, target) : undefined;
    if (base && !mergeBase) {
      throw new Error(`No merge base for the requested comparison; snapshot scope is incomplete.`);
    }
  }

  const pathArgs = paths.length > 0 ? ['--', ...paths] : [];
  await assertNoInScopeSubmoduleGitlinks(repository, comparisonBase, comparisonTarget, pathArgs);
  await assertNoConcealedIndexPaths(repository, pathArgs);
  await assertNoFilterAttributes(repository, pathArgs);
  const comparisonDiff = captureBuffer(await runGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--binary', comparisonBase, comparisonTarget, ...pathArgs]));
  const stagedDiff = captureBuffer(await runGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--binary', '--cached', ...pathArgs]));
  const unstagedDiff = captureBuffer(await runGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--binary', ...pathArgs]));
  const comparisonPaths = parseNullSeparatedPaths(await runGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--name-only', '-z', comparisonBase, comparisonTarget, ...pathArgs]));
  const stagedPaths = parseNullSeparatedPaths(await runGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--cached', ...pathArgs]));
  const unstagedPaths = parseNullSeparatedPaths(await runGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--name-only', '-z', ...pathArgs]));
  const untrackedPaths = parseNullSeparatedPaths(await runGit(repository, ['ls-files', '--others', '--exclude-standard', '-z', ...pathArgs]));
  if (untrackedPaths.length > MAX_UNTRACKED_FILES) {
    throw new Error(`Untracked snapshot incomplete: untracked file count exceeded ${MAX_UNTRACKED_FILES}.`);
  }
  const untrackedContent: Array<readonly [string, CapturedContent]> = [];
  const captureDeadline = Date.now() + UNTRACKED_CAPTURE_TIMEOUT_MS;
  let remainingUntrackedBytes = MAX_UNTRACKED_TOTAL_BYTES;
  let remainingPreviewBytes = Math.min(maxPatchBytes, MAX_UNTRACKED_PREVIEW_BYTES);
  for (const relativePath of untrackedPaths) {
    assertUntrackedDeadline(captureDeadline);
    const content = await captureBeforeDeadline(
      captureFile(
        repoPath(repository, relativePath),
        Math.min(SOURCE_PREVIEW_BYTES, remainingPreviewBytes),
        captureDeadline,
        remainingUntrackedBytes,
      ),
      captureDeadline,
    );
    remainingUntrackedBytes -= content.byteLength;
    remainingPreviewBytes -= content.preview.byteLength;
    untrackedContent.push([relativePath, content]);
  }

  const fingerprintHash = createHash('sha256');
  fingerprintHash.update(JSON.stringify({ baseRef, targetRef, range: input.range, paths }));
  appendFingerprint(fingerprintHash, 'comparison', comparisonDiff);
  appendFingerprint(fingerprintHash, 'staged', stagedDiff);
  appendFingerprint(fingerprintHash, 'unstaged', unstagedDiff);
  for (const [relativePath, content] of untrackedContent) {
    appendFingerprint(fingerprintHash, `untracked:${relativePath}`, content);
  }

  const sections = [
    materialSection('comparison diff', comparisonDiff),
    materialSection('staged diff', stagedDiff),
    materialSection('unstaged diff', unstagedDiff),
    ...untrackedContent.map(([relativePath, content]) => materialSection(`untracked ${relativePath}`, content)),
  ];
  const previewOmittedBytes = [
    comparisonDiff,
    stagedDiff,
    unstagedDiff,
    ...untrackedContent.map(([, content]) => content),
  ].reduce((total, content) => total + content.byteLength - content.preview.byteLength, 0);
  const material = Buffer.concat(sections).toString('utf8');
  const patch = truncateUtf8(material, maxPatchBytes);
  const patchOmittedBytes = previewOmittedBytes + Math.max(0, Buffer.byteLength(material) - Buffer.byteLength(patch));
  const changedPathSources: Record<ChangedPathGroup, string[]> = {
    comparison: comparisonPaths,
    staged: stagedPaths,
    unstaged: unstagedPaths,
    untracked: untrackedPaths,
  };
  const changedPaths = Object.fromEntries(
    Object.entries(changedPathSources).map(([kind, sourcePaths]) => [kind, boundPaths(sourcePaths, maxFiles).values]),
  ) as Record<ChangedPathGroup, string[]>;
  const changedPathOmissions = Object.fromEntries(
    Object.entries(changedPathSources).map(([kind, sourcePaths]) => [kind, boundPaths(sourcePaths, maxFiles).omitted]),
  ) as Record<ChangedPathGroup, number>;

  return {
    repository: { root: repository, currentHead },
    scope: {
      ...(baseRef ? { baseRef } : {}),
      ...(targetRef ? { targetRef } : {}),
      ...(input.range ? { range: input.range } : {}),
      paths,
      ...(comparisonBase ? { comparisonBase } : {}),
      comparisonTarget,
      ...(mergeBase ? { mergeBase } : {}),
    },
    limits: { maxFiles, maxPatchBytes },
    changedPaths,
    fingerprint: fingerprintHash.digest('hex'),
    patch,
    omissions: {
      changedPaths: changedPathOmissions,
      patch: {
        truncated: patchOmittedBytes > 0,
        omittedBytes: patchOmittedBytes,
      },
    },
  };
}
