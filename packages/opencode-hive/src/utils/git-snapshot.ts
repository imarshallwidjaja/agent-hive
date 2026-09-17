import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { devNull } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { compareUnicodeCodePoints } from './codepoint.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
export const SNAPSHOT_OPERATION_TIMEOUT_MS = 15_000;
const MAX_FILES = 200;
const MAX_PATCH_BYTES = 256 * 1024;
const SOURCE_PREVIEW_BYTES = 64 * 1024;
const MAX_UNTRACKED_FILES = 100;
const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_PREVIEW_BYTES = 128 * 1024;
const UNTRACKED_CAPTURE_TIMEOUT_MS = 5_000;
const UNTRACKED_BOUNDS_HINT = 'narrow paths, excludePaths, or the scoped path set';
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
  /** Internal fixed review-workspace paths excluded from live untracked capture. */
  excludePaths?: string[];
  maxFiles?: number;
  maxPatchBytes?: number;
};

type CapturedContent = {
  byteLength: number;
  digest: string;
  content: Buffer;
  preview: Buffer;
  previewTruncated: boolean;
  fileType?: 'regular' | 'symlink';
  mode?: number;
};

type ChangedPathGroup = 'comparison' | 'staged' | 'unstaged' | 'untracked';

export type GitSnapshotPhase =
  | 'validation'
  | 'ref-resolution'
  | 'preflight'
  | 'capture'
  | 'untracked-capture'
  | 'revalidation'
  | 'serialization';

export type GitSnapshotRetry = 'fresh-capture' | 'narrow-scope' | 'operator-action' | 'not-retryable';

/**
 * Engine error codes. Legacy codes keep their historical kebab-case values;
 * codes introduced by the snapshot-capture-hardening contract use the frozen
 * envelope vocabulary so renderers can branch on them without translation.
 */
export type GitSnapshotErrorCode =
  | 'missing-ref'
  | 'merge-base-unavailable'
  | 'output-truncated'
  | 'timeout'
  | 'INVALID_REQUEST'
  | 'UNSAFE_REPOSITORY_STATE'
  | 'INCOMPLETE_UNTRACKED_CAPTURE'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'OPERATION_TIMEOUT'
  | 'SOURCE_DRIFT'
  | 'INTERNAL_ERROR';

const DEFAULT_PHASE_BY_CODE: Record<GitSnapshotErrorCode, GitSnapshotPhase> = {
  INVALID_REQUEST: 'validation',
  'missing-ref': 'ref-resolution',
  'merge-base-unavailable': 'ref-resolution',
  UNSAFE_REPOSITORY_STATE: 'preflight',
  INCOMPLETE_UNTRACKED_CAPTURE: 'untracked-capture',
  'output-truncated': 'capture',
  OUTPUT_LIMIT_EXCEEDED: 'capture',
  OPERATION_TIMEOUT: 'capture',
  SOURCE_DRIFT: 'revalidation',
  INTERNAL_ERROR: 'capture',
  timeout: 'capture',
};

const DEFAULT_RETRY_BY_CODE: Record<GitSnapshotErrorCode, GitSnapshotRetry> = {
  INVALID_REQUEST: 'not-retryable',
  'missing-ref': 'operator-action',
  'merge-base-unavailable': 'narrow-scope',
  UNSAFE_REPOSITORY_STATE: 'operator-action',
  INCOMPLETE_UNTRACKED_CAPTURE: 'narrow-scope',
  'output-truncated': 'narrow-scope',
  OUTPUT_LIMIT_EXCEEDED: 'narrow-scope',
  OPERATION_TIMEOUT: 'fresh-capture',
  SOURCE_DRIFT: 'fresh-capture',
  INTERNAL_ERROR: 'operator-action',
  timeout: 'fresh-capture',
};

/**
 * The contract freezes these codes in the versioned envelope. The four legacy
 * codes above stay in use because existing renderers and tests branch on them;
 * renderers must handle both vocabularies.
 */

type GitSnapshotErrorDetails = {
  field?: 'baseRef' | 'targetRef';
  ref?: string;
  repositoryId?: string;
};

export type GitSnapshotErrorDetail =
  | { kind: 'range-with-refs' }
  | { kind: 'range-format' }
  | { kind: 'scoped-path-flag' }
  | { kind: 'scoped-path-magic'; value: string }
  | { kind: 'scoped-path-relative'; value: string }
  | { kind: 'ref-flag'; field: 'baseRef' | 'targetRef' }
  | { kind: 'ref-invalid'; field: 'baseRef' | 'targetRef'; value: string }
  | { kind: 'limit-invalid'; field: string }
  | { kind: 'unsupported-gitlink'; entries: string[] }
  | { kind: 'concealed-paths'; entries: string[] }
  | { kind: 'filter-attribute'; path: string; value: string }
  | { kind: 'untracked-file-type'; path: string }
  | { kind: 'untracked-count'; limit: number }
  | { kind: 'untracked-file-bytes'; limit: number; path: string }
  | { kind: 'untracked-total-bytes'; limit: number }
  | { kind: 'untracked-deadline'; limitMs: number };

const MAX_ERROR_DETAIL_ENTRIES = 20;
const MAX_ERROR_DETAIL_CHARS = 200;

function boundedDetailValue(value: string): string {
  return value.length > MAX_ERROR_DETAIL_CHARS ? value.slice(0, MAX_ERROR_DETAIL_CHARS) : value;
}

function boundedDetailEntries(entries: readonly string[]): string {
  return entries.slice(0, MAX_ERROR_DETAIL_ENTRIES).map(boundedDetailValue).join(', ');
}

type GitSnapshotErrorOptions = {
  phase?: GitSnapshotPhase;
  retry?: GitSnapshotRetry;
  elapsedMs?: number;
  limitMs?: number;
  /** Bounded detail parsed from a Git response; never raw stderr. */
  detail?: GitSnapshotErrorDetail;
};

export class GitSnapshotError extends Error {
  readonly phase: GitSnapshotPhase;
  readonly retry: GitSnapshotRetry;
  readonly elapsedMs?: number;
  readonly limitMs?: number;

  constructor(
    readonly code: GitSnapshotErrorCode,
    readonly details: GitSnapshotErrorDetails = {},
    options: GitSnapshotErrorOptions = {},
  ) {
    super(describeGitSnapshotFailure(code, details, options));
    this.name = 'GitSnapshotError';
    this.phase = options.phase ?? DEFAULT_PHASE_BY_CODE[code];
    this.retry = options.retry ?? DEFAULT_RETRY_BY_CODE[code];
    if (options.elapsedMs !== undefined) this.elapsedMs = options.elapsedMs;
    if (options.limitMs !== undefined) this.limitMs = options.limitMs;
  }
}

function describeGitSnapshotFailure(
  code: GitSnapshotErrorCode,
  details: GitSnapshotErrorDetails,
  options: GitSnapshotErrorOptions,
): string {
  switch (code) {
    case 'missing-ref':
      return details.field && details.ref
        ? `Git snapshot could not resolve ${details.field}.`
        : 'Git snapshot could not resolve the requested ref.';
    case 'merge-base-unavailable':
      return 'No merge base for the requested comparison; snapshot scope is incomplete.';
    case 'output-truncated':
      return `Git snapshot output exceeded ${MAX_GIT_OUTPUT_BYTES} bytes.`;
    case 'timeout':
      return `Git snapshot timed out after ${GIT_TIMEOUT_MS}ms.`;
    case 'INVALID_REQUEST':
      switch (options.detail?.kind) {
        case 'range-with-refs':
          return 'range cannot be combined with baseRef or targetRef.';
        case 'range-format':
          return 'range must use base..target or base...target.';
        case 'scoped-path-flag':
          return 'Scoped paths must not start with "-" or be empty.';
        case 'scoped-path-magic':
          return `Scoped path must not use pathspec magic: ${boundedDetailValue(options.detail.value)}`;
        case 'scoped-path-relative':
          return `Scoped path must be repository-relative: ${boundedDetailValue(options.detail.value)}`;
        case 'ref-flag':
          return `${options.detail.field} must not start with "-" or be empty.`;
        case 'ref-invalid':
          return `Invalid Git ref for ${options.detail.field}: ${boundedDetailValue(options.detail.value)}`;
        case 'limit-invalid':
          return `${options.detail.field} must be a positive integer.`;
        default:
          return 'Git snapshot rejected the request before starting capture.';
      }
    case 'UNSAFE_REPOSITORY_STATE':
      switch (options.detail?.kind) {
        case 'unsupported-gitlink':
          return `Unsupported in-scope submodule gitlink: ${boundedDetailEntries(options.detail.entries)}; snapshot scope is incomplete.`;
        case 'concealed-paths':
          return `Concealed tracked paths (${boundedDetailEntries(options.detail.entries)}); snapshot scope is incomplete.`;
        case 'filter-attribute':
          return `Unsupported filter attribute for ${boundedDetailValue(options.detail.path)}: ${boundedDetailValue(options.detail.value)}; snapshot scope is incomplete.`;
        case 'untracked-file-type':
          return `Unsupported untracked file type: ${boundedDetailValue(options.detail.path)}`;
        default:
          return 'Git snapshot refused an unsafe repository state.';
      }
    case 'INCOMPLETE_UNTRACKED_CAPTURE':
      switch (options.detail?.kind) {
        case 'untracked-count':
          return `Untracked snapshot incomplete: untracked file count exceeded ${options.detail.limit}.`;
        case 'untracked-file-bytes':
          return `Untracked snapshot incomplete: untracked file size exceeded ${options.detail.limit} bytes: ${boundedDetailValue(options.detail.path)}`;
        case 'untracked-total-bytes':
          return `Untracked snapshot incomplete: total untracked byte limit exceeded ${options.detail.limit} bytes.`;
        case 'untracked-deadline':
          return `Untracked snapshot incomplete: capture deadline exceeded after ${options.detail.limitMs}ms.`;
        default:
          return `Git snapshot could not complete the untracked inventory within its bounds; ${UNTRACKED_BOUNDS_HINT}.`;
      }
    case 'OUTPUT_LIMIT_EXCEEDED':
      return `Git snapshot output exceeded ${MAX_GIT_OUTPUT_BYTES} bytes.`;
    case 'OPERATION_TIMEOUT':
      return `Git snapshot operation elapsed its ${options.limitMs ?? SNAPSHOT_OPERATION_TIMEOUT_MS}ms deadline.`;
    case 'SOURCE_DRIFT':
      return 'Repository content changed during capture.';
    case 'INTERNAL_ERROR':
      return 'Git snapshot failed while capturing repository state.';
  }
}

/**
 * Steps where the test suite can inject a repository change or advance the
 * capture clock deterministically, without sleeps or timing races.
 */
export type SnapshotCaptureBoundary =
  | 'comparison-diff-captured'
  | 'staged-diff-captured'
  | 'unstaged-diff-captured'
  | 'untracked-listed'
  | 'untracked-capture-started'
  | 'before-revalidation';

export type SnapshotCaptureTestSeams = {
  /** Capture clock override; defaults to the wall clock. */
  now?: () => number;
  /** Runs at each capture boundary, before the next capture step. */
  onBoundary?: (boundary: SnapshotCaptureBoundary) => void | Promise<void>;
};

let captureClock: (() => number) | undefined;
let captureBoundaryHook: SnapshotCaptureTestSeams['onBoundary'];

/**
 * Installs deterministic capture seams. This is a test seam, not a caller
 * option: production code installs neither a clock override nor a hook, and no
 * tool surface exposes it. Call with no arguments to restore defaults.
 */
export function setSnapshotCaptureTestSeams(seams: SnapshotCaptureTestSeams = {}): void {
  captureClock = seams.now;
  captureBoundaryHook = seams.onBoundary;
}

function snapshotNow(): number {
  return captureClock === undefined ? Date.now() : captureClock();
}

async function notifyCaptureBoundary(boundary: SnapshotCaptureBoundary): Promise<void> {
  await captureBoundaryHook?.(boundary);
}

/**
 * Whole-operation deadline shared by every step of one snapshot capture.
 * Git commands, untracked reads, and generation revalidation all observe it.
 */
type SnapshotOperation = {
  startedAt: number;
  deadline: number;
  phase: GitSnapshotPhase;
};

type CaptureDeadline = {
  at: number;
  error: () => GitSnapshotError;
};

function createSnapshotOperation(): SnapshotOperation {
  const startedAt = snapshotNow();
  return { startedAt, deadline: startedAt + SNAPSHOT_OPERATION_TIMEOUT_MS, phase: 'validation' };
}

function operationTimeoutError(operation: SnapshotOperation): GitSnapshotError {
  return new GitSnapshotError('OPERATION_TIMEOUT', {}, {
    phase: operation.phase,
    retry: 'fresh-capture',
    elapsedMs: Math.max(0, snapshotNow() - operation.startedAt),
    limitMs: SNAPSHOT_OPERATION_TIMEOUT_MS,
  });
}

function sourceDriftError(operation: SnapshotOperation): GitSnapshotError {
  return new GitSnapshotError('SOURCE_DRIFT', {}, {
    retry: 'fresh-capture',
    elapsedMs: Math.max(0, snapshotNow() - operation.startedAt),
    limitMs: SNAPSHOT_OPERATION_TIMEOUT_MS,
  });
}

function remainingOperationMs(operation: SnapshotOperation): number {
  const remaining = operation.deadline - snapshotNow();
  if (remaining <= 0) {
    throw operationTimeoutError(operation);
  }
  return remaining;
}

function incompleteUntrackedCaptureError(): GitSnapshotError {
  return new GitSnapshotError('INCOMPLETE_UNTRACKED_CAPTURE', {}, {
    detail: { kind: 'untracked-deadline', limitMs: UNTRACKED_CAPTURE_TIMEOUT_MS },
  });
}

/**
 * Untracked capture keeps its own five-second bound, shortened to whatever
 * remains of the operation deadline. Which bound actually expired decides the
 * code: an elapsed operation deadline reports `OPERATION_TIMEOUT` with the
 * running phase, and the untracked bound reports `INCOMPLETE_UNTRACKED_CAPTURE`
 * rather than a Git command timeout.
 */
function untrackedCaptureDeadline(operation: SnapshotOperation): CaptureDeadline {
  return {
    at: Math.min(operation.deadline, snapshotNow() + UNTRACKED_CAPTURE_TIMEOUT_MS),
    error: () => (snapshotNow() >= operation.deadline
      ? operationTimeoutError(operation)
      : incompleteUntrackedCaptureError()),
  };
}

function standaloneUntrackedCaptureDeadline(): CaptureDeadline {
  return {
    at: snapshotNow() + UNTRACKED_CAPTURE_TIMEOUT_MS,
    error: () => incompleteUntrackedCaptureError(),
  };
}

export interface GitSnapshot {
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
  consistency: 'validated';
  limits: { maxFiles: number; maxPatchBytes: number };
  changedPaths: Record<ChangedPathGroup, string[]>;
  fingerprint: string;
  patch: string;
  omissions: {
    changedPaths: Record<ChangedPathGroup, number>;
    patch: { truncated: boolean; omittedBytes: number };
    sections: OmittedSectionReport[];
  };
}

export type OmittedSectionReport = {
  section: string;
  capturedBytes: number;
  returnedBytes: number;
  omittedBytes: number;
  reason: 'section-preview-limit' | 'aggregate-limit' | null;
};

export interface ReviewMaterializationEntry {
  path: string;
  kind: 'delete' | 'regular' | 'symlink';
  content?: Buffer;
  mode?: number;
}

export interface ReviewMaterialization {
  snapshot: GitSnapshot;
  entries: ReviewMaterializationEntry[];
  fingerprint: string;
}

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
    content,
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

function assertUntrackedDeadline(deadline: CaptureDeadline): void {
  if (snapshotNow() > deadline.at) {
    throw deadline.error();
  }
}

async function captureRegularFile(
  filePath: string,
  expected: Awaited<ReturnType<typeof fs.lstat>>,
  previewLimit: number,
  deadline: CaptureDeadline,
  remainingBytes: number,
): Promise<CapturedContent> {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new GitSnapshotError('INTERNAL_ERROR', {});
  }
  if (expected.size > MAX_UNTRACKED_FILE_BYTES) {
    throw new GitSnapshotError('INCOMPLETE_UNTRACKED_CAPTURE', {}, {
      detail: { kind: 'untracked-file-bytes', limit: MAX_UNTRACKED_FILE_BYTES, path: filePath },
    });
  }
  if (expected.size > remainingBytes) {
    throw new GitSnapshotError('INCOMPLETE_UNTRACKED_CAPTURE', {}, {
      detail: { kind: 'untracked-total-bytes', limit: MAX_UNTRACKED_TOTAL_BYTES },
    });
  }

  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || !sameFileIdentity(expected, opened)) {
      throw new GitSnapshotError('SOURCE_DRIFT', {}, { phase: 'untracked-capture' });
    }

    const hash = createHash('sha256');
    const content: Buffer[] = [];
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
      content.push(Buffer.from(chunk));
      assertUntrackedDeadline(deadline);
      if (byteLength + bytesRead > MAX_UNTRACKED_FILE_BYTES) {
        throw new GitSnapshotError('INCOMPLETE_UNTRACKED_CAPTURE', {}, {
          detail: { kind: 'untracked-file-bytes', limit: MAX_UNTRACKED_FILE_BYTES, path: filePath },
        });
      }
      if (byteLength + bytesRead > remainingBytes) {
        throw new GitSnapshotError('INCOMPLETE_UNTRACKED_CAPTURE', {}, {
          detail: { kind: 'untracked-total-bytes', limit: MAX_UNTRACKED_TOTAL_BYTES },
        });
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
      throw new GitSnapshotError('SOURCE_DRIFT', {}, { phase: 'untracked-capture' });
    }
    return {
      byteLength,
      digest: hash.digest('hex'),
      content: Buffer.concat(content),
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
  deadline: CaptureDeadline,
  remainingBytes: number,
): Promise<CapturedContent> {
  assertUntrackedDeadline(deadline);
  const target = await fs.readlink(filePath);
  const completed = await fs.lstat(filePath);
  if (!completed.isSymbolicLink() || !sameFileIdentity(expected, completed)) {
    throw new GitSnapshotError('SOURCE_DRIFT', {}, { phase: 'untracked-capture' });
  }
  const content = Buffer.from(target);
  if (content.byteLength > MAX_UNTRACKED_FILE_BYTES) {
    throw new GitSnapshotError('INCOMPLETE_UNTRACKED_CAPTURE', {}, {
      detail: { kind: 'untracked-file-bytes', limit: MAX_UNTRACKED_FILE_BYTES, path: filePath },
    });
  }
  if (content.byteLength > remainingBytes) {
    throw new GitSnapshotError('INCOMPLETE_UNTRACKED_CAPTURE', {}, {
      detail: { kind: 'untracked-total-bytes', limit: MAX_UNTRACKED_TOTAL_BYTES },
    });
  }
  return captureBuffer(content, {
    fileType: 'symlink',
    mode: completed.mode & 0o7777,
  }, previewLimit);
}

async function captureFile(filePath: string, previewLimit: number, deadline: CaptureDeadline, remainingBytes: number): Promise<CapturedContent> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    // A path that disappeared between discovery and read is drift, not a crash.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new GitSnapshotError('SOURCE_DRIFT', {}, { phase: 'untracked-capture' });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) return captureSymlink(filePath, stat, previewLimit, deadline, remainingBytes);
  if (stat.isFile()) return captureRegularFile(filePath, stat, previewLimit, deadline, remainingBytes);
  throw new GitSnapshotError('UNSAFE_REPOSITORY_STATE', {}, {
    phase: 'untracked-capture',
    detail: { kind: 'untracked-file-type', path: filePath },
  });
}

async function captureBeforeDeadline<T>(operation: Promise<T>, deadline: CaptureDeadline): Promise<T> {
  const remaining = deadline.at - snapshotNow();
  if (remaining <= 0) {
    throw deadline.error();
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(deadline.error());
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
    LANG: 'C',
    LC_ALL: 'C',
    PAGER: 'cat',
  };
}

function normalizeGitError(error: unknown): never {
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || String(failure.message).includes('maxBuffer')) {
    throw new GitSnapshotError('OUTPUT_LIMIT_EXCEEDED');
  }
  if (failure.killed === true || failure.signal === 'SIGTERM' || failure.code === 'ETIMEDOUT') {
    throw new GitSnapshotError('timeout');
  }
  throw error;
}

/**
 * Effective execution bounds for one Git invocation. The default is the
 * five-second per-command bound; a caller-supplied whole-operation remaining
 * time may only narrow it, never extend it.
 */
function gitCommandBounds(remainingTimeMs?: number): { timeout: number } {
  if (remainingTimeMs === undefined || remainingTimeMs >= GIT_TIMEOUT_MS) {
    return { timeout: GIT_TIMEOUT_MS };
  }
  return { timeout: Math.max(1, remainingTimeMs) };
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

async function runGit(repository: string, args: string[], remainingTimeMs?: number): Promise<Buffer> {
  try {
    const result = await execFileAsync('git', gitArgs(repository, args), {
      encoding: 'buffer',
      env: hardenedGitEnvironment(),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      shell: false,
      ...gitCommandBounds(remainingTimeMs),
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch (error) {
    normalizeGitError(error);
  }
}

async function runGitWithStdin(
  repository: string,
  args: string[],
  input: Buffer,
  remainingTimeMs?: number,
): Promise<Buffer> {
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
    }, gitCommandBounds(remainingTimeMs).timeout);
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
        reject(new GitSnapshotError('OUTPUT_LIMIT_EXCEEDED'));
      } else if (timedOut) {
        reject(new GitSnapshotError('timeout'));
      } else if (code !== 0) {
        reject(new Error(`Git snapshot command failed with exit code ${code}.`));
      } else {
        resolve(Buffer.concat(output));
      }
    });
    child.stdin.end(input);
  });
}

function parseNullSeparatedTokens(content: Buffer): string[] {
  return content.toString('utf8').split('\0').filter(Boolean);
}

function parseNullSeparatedPaths(content: Buffer): string[] {
  return parseNullSeparatedTokens(content).sort(compareUnicodeCodePoints);
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
  operation: SnapshotOperation,
): Promise<void> {
  const [base, target, staged] = await Promise.all([
    runSnapshotGit(repository, ['ls-tree', '-r', '-z', comparisonBase, ...pathArgs], operation),
    runSnapshotGit(repository, ['ls-tree', '-r', '-z', comparisonTarget, ...pathArgs], operation),
    runSnapshotGit(repository, ['ls-files', '-s', '-z', ...pathArgs], operation),
  ]);
  const gitlinks = [
    ...parseLsTree(base).filter(({ mode }) => mode === GITLINK_MODE).map(({ path }) => `comparison base:${path}`),
    ...parseLsTree(target).filter(({ mode }) => mode === GITLINK_MODE).map(({ path }) => `comparison target:${path}`),
    ...parseLsFilesStages(staged).filter(({ mode }) => mode === GITLINK_MODE).map(({ path }) => `index:${path}`),
  ];
  if (gitlinks.length === 0) {
    return;
  }
  throw new GitSnapshotError('UNSAFE_REPOSITORY_STATE', {}, {
    detail: {
      kind: 'unsupported-gitlink',
      entries: [...new Set(gitlinks)].sort(compareUnicodeCodePoints),
    },
  });
}

async function assertNoConcealedIndexPaths(
  repository: string,
  pathArgs: string[],
  operation: SnapshotOperation,
): Promise<void> {
  const entries = parseNullSeparatedPaths(await runSnapshotGit(repository, ['ls-files', '-v', '-z', ...pathArgs], operation));
  const concealed = entries.flatMap((entry) => {
    const match = /^([A-Za-z]) (.+)$/.exec(entry);
    if (!match) {
      throw new GitSnapshotError('INTERNAL_ERROR');
    }
    const [, tag, filePath] = match;
    if (tag === 'S') return [`skip-worktree:${filePath}`];
    if (tag === tag.toLowerCase()) return [`assume-unchanged:${filePath}`];
    return [];
  });
  if (concealed.length > 0) {
    throw new GitSnapshotError('UNSAFE_REPOSITORY_STATE', {}, {
      detail: { kind: 'concealed-paths', entries: concealed.sort(compareUnicodeCodePoints) },
    });
  }
}

async function resolveAuthorizedGitRoot(
  repositoryDirectory: string,
  operation: SnapshotOperation,
): Promise<string> {
  const authorizedRepository = await fs.realpath(repositoryDirectory);
  const reportedRoot = (await runSnapshotGit(authorizedRepository, ['rev-parse', '--show-toplevel'], operation)).toString('utf8').trim();
  const repository = await fs.realpath(reportedRoot);
  if (repository !== authorizedRepository) {
    throw new Error('Git repository root does not match the authorized repository root.');
  }
  return repository;
}

export async function isExactGitTopLevel(repositoryDirectory: string): Promise<boolean> {
  try {
    await resolveAuthorizedGitRoot(repositoryDirectory, createSnapshotOperation());
    return true;
  } catch {
    return false;
  }
}


function parseFilterAttributes(content: Buffer): Array<{ path: string; value: string }> {
  const fields = content.toString('utf8').split('\0').filter(Boolean);
  const attributes: Array<{ path: string; value: string }> = [];
  for (let index = 0; index < fields.length; index += 3) {
    const [filePath, attribute, value] = fields.slice(index, index + 3);
    if (attribute !== 'filter' || value === undefined) {
      throw new GitSnapshotError('INTERNAL_ERROR');
    }
    attributes.push({ path: filePath, value });
  }
  return attributes;
}

async function assertNoFilterAttributes(
  repository: string,
  pathArgs: string[],
  operation: SnapshotOperation,
): Promise<void> {
  const trackedPaths = parseNullSeparatedPaths(await runSnapshotGit(repository, ['ls-files', '-z', ...pathArgs], operation));
  for (let index = 0; index < trackedPaths.length; index += 200) {
    const batch = trackedPaths.slice(index, index + 200);
    const attributes = parseFilterAttributes(await runSnapshotGit(repository, ['check-attr', '-z', 'filter', '--', ...batch], operation));
    const blocked = attributes.find(({ value }) => value !== 'unspecified' && value !== 'unset');
    if (blocked) {
      throw new GitSnapshotError('UNSAFE_REPOSITORY_STATE', {}, {
        detail: { kind: 'filter-attribute', path: blocked.path, value: blocked.value },
      });
    }
  }
}

function assertSafeRef(value: string, field: 'baseRef' | 'targetRef'): string {
  if (!value || value.startsWith('-')) {
    throw new GitSnapshotError('INVALID_REQUEST', {}, { detail: { kind: 'ref-flag', field } });
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
    throw new GitSnapshotError('INVALID_REQUEST', {}, { detail: { kind: 'ref-invalid', field, value } });
  }
  return value;
}

function parseRange(range: string): { baseRef: string; targetRef: string; mergeBase: boolean } {
  const match = /^(.+?)(\.\.\.?)(.+)$/.exec(range);
  if (!match) {
    throw new GitSnapshotError('INVALID_REQUEST', {}, { detail: { kind: 'range-format' } });
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
      throw new GitSnapshotError('INVALID_REQUEST', {}, { detail: { kind: 'scoped-path-flag' } });
    }
    if (value.startsWith(':')) {
      throw new GitSnapshotError('INVALID_REQUEST', {}, { detail: { kind: 'scoped-path-magic', value } });
    }
    if (value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) {
      throw new GitSnapshotError('INVALID_REQUEST', {}, { detail: { kind: 'scoped-path-relative', value } });
    }
    const normalizedPath = path.posix.normalize(value);
    if (normalizedPath === '..' || normalizedPath.startsWith('../')) {
      throw new GitSnapshotError('INVALID_REQUEST', {}, { detail: { kind: 'scoped-path-relative', value } });
    }
    return normalizedPath;
  });
  return [...new Set(normalized)].sort(compareUnicodeCodePoints);
}

function resolveLimit(value: number | undefined, fallback: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GitSnapshotError('INVALID_REQUEST', {}, { detail: { kind: 'limit-invalid', field } });
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

function materialHeader(label: string): Buffer {
  return Buffer.from(`\n=== ${label} ===\n`);
}

function materialSuffix(label: string, content: CapturedContent): Buffer {
  return Buffer.from(content.previewTruncated
    ? `\n[${label} preview truncated; full content remains in the fingerprint]\n`
    : '\n');
}

function materialSection(label: string, content: CapturedContent): Buffer {
  return Buffer.concat([
    materialHeader(label),
    content.preview,
    materialSuffix(label, content),
  ]);
}

type MaterialSection = {
  section: string;
  label: string;
  content: CapturedContent;
};

/**
 * Reports what each patch section contributed after preview caps and the
 * aggregate patch bound. `capturedBytes = returnedBytes + omittedBytes` holds
 * per section; a section clipped by both causes reports the earlier, preview
 * cause and lets `omissions.patch.omittedBytes` carry the aggregate remainder.
 */
function reportSectionOmissions(groups: readonly MaterialSection[], patch: string): OmittedSectionReport[] {
  const patchBytes = Buffer.byteLength(patch);
  let offset = 0;
  return groups.map(({ section, label, content }) => {
    const headerBytes = materialHeader(label).byteLength;
    const previewLength = content.preview.byteLength;
    const returnedBytes = Math.min(previewLength, Math.max(0, patchBytes - offset - headerBytes));
    const report: OmittedSectionReport = {
      section,
      capturedBytes: content.byteLength,
      returnedBytes,
      omittedBytes: content.byteLength - returnedBytes,
      reason: content.previewTruncated
        ? 'section-preview-limit'
        : returnedBytes < previewLength
          ? 'aggregate-limit'
          : null,
    };
    offset += headerBytes + previewLength + materialSuffix(label, content).byteLength;
    return report;
  });
}

function truncateUtf8(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content) <= maxBytes) return content;
  let end = Math.min(content.length, maxBytes);
  while (end > 0 && Buffer.byteLength(content.slice(0, end)) > maxBytes) {
    end -= 1;
  }
  return content.slice(0, end);
}

/**
 * Runs one Git command under the whole-operation deadline. A per-command bound
 * that expires after the operation deadline is a whole-operation failure.
 */
async function runSnapshotGit(
  repository: string,
  args: string[],
  operation: SnapshotOperation,
): Promise<Buffer> {
  const remaining = remainingOperationMs(operation);
  try {
    return await runGit(repository, args, remaining);
  } catch (error) {
    if (error instanceof GitSnapshotError && error.code === 'timeout' && snapshotNow() >= operation.deadline) {
      throw operationTimeoutError(operation);
    }
    throw error;
  }
}

/** Stdin variant of `runSnapshotGit`, with the same timeout reclassification. */
async function runSnapshotGitWithStdin(
  repository: string,
  args: string[],
  input: Buffer,
  operation: SnapshotOperation,
): Promise<Buffer> {
  try {
    return await runGitWithStdin(repository, args, input, remainingOperationMs(operation));
  } catch (error) {
    if (error instanceof GitSnapshotError && error.code === 'timeout' && snapshotNow() >= operation.deadline) {
      throw operationTimeoutError(operation);
    }
    throw error;
  }
}

async function tryRunSnapshotGit(
  repository: string,
  args: string[],
  operation: SnapshotOperation,
): Promise<Buffer | undefined> {
  try {
    return await runSnapshotGit(repository, args, operation);
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === 'number') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Resolves one commit. `missing-ref` classification stays deliberately narrow:
 * it requires the numeric exit code and Git's exact single-revision sentence,
 * so broken ref database entries and corrupt object stores are never reported
 * as a missing ref.
 */
async function resolveCommit(
  repository: string,
  ref: string,
  operation: SnapshotOperation,
  field?: 'baseRef' | 'targetRef',
): Promise<string> {
  try {
    return (await runSnapshotGit(repository, ['rev-parse', '--verify', `${ref}^{commit}`], operation)).toString('utf8').trim();
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown };
    const stderr = Buffer.isBuffer(failure.stderr)
      ? failure.stderr.toString('utf8').trim()
      : typeof failure.stderr === 'string'
        ? failure.stderr.trim()
        : '';
    if (field && typeof failure.code === 'number' && stderr === 'fatal: Needed a single revision') {
      throw new GitSnapshotError('missing-ref', { field, ref });
    }
    throw error;
  }
}

async function firstParent(repository: string, commit: string, operation: SnapshotOperation): Promise<string | undefined> {
  const output = (await runSnapshotGit(repository, ['rev-list', '--parents', '-n', '1', commit], operation)).toString('utf8').trim();
  return output.split(/\s+/)[1];
}

async function resolveMergeBase(
  repository: string,
  base: string,
  target: string,
  operation: SnapshotOperation,
): Promise<string | undefined> {
  const output = await tryRunSnapshotGit(repository, ['merge-base', base, target], operation);
  return output?.toString('utf8').trim() || undefined;
}

async function resolveEmptyTree(repository: string, operation: SnapshotOperation): Promise<string> {
  return (await runSnapshotGitWithStdin(
    repository,
    ['hash-object', '-t', 'tree', '--stdin'],
    Buffer.alloc(0),
    operation,
  )).toString('utf8').trim();
}

function repoPath(repository: string, relativePath: string): string {
  const resolved = path.resolve(repository, relativePath);
  if (resolved !== repository && !resolved.startsWith(`${repository}${path.sep}`)) {
    throw new Error(`Scoped path must be repository-relative: ${relativePath}`);
  }
  return resolved;
}

/**
 * Generation identity for one capture. It covers the resolved commits: HEAD,
 * the comparison endpoints, and every caller-supplied ref re-resolved from its
 * name, because a ref that moves mid-capture would otherwise produce a snapshot
 * whose fingerprint mixes two repository generations.
 *
 * Committed snapshots, meaning `targetRef` or `range` was supplied, use only
 * this identity probe, so unrelated dirty state stays out of scope. Live
 * snapshots additionally compare a working-tree probe (below).
 */
type GenerationIdentity = {
  head: string;
  endpoints: string[];
  refs: string[];
  indexIdentity?: string;
};

async function indexPathIdentity(repository: string, operation: SnapshotOperation): Promise<string> {
  const reported = (await runSnapshotGit(repository, ['rev-parse', '--git-path', 'index'], operation)).toString('utf8').trim();
  const indexFile = path.isAbsolute(reported) ? reported : path.resolve(repository, reported);
  try {
    const stat = await fs.stat(indexFile);
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

type GenerationIdentityInput = {
  repository: string;
  operation: SnapshotOperation;
  comparisonBase: string;
  comparisonTarget: string;
  refs: readonly string[];
  includeIndexIdentity: boolean;
};

async function captureGenerationIdentity(input: GenerationIdentityInput): Promise<GenerationIdentity> {
  const identity: GenerationIdentity = {
    head: await resolveCommit(input.repository, 'HEAD', input.operation),
    endpoints: [`base=${input.comparisonBase}`, `target=${input.comparisonTarget}`],
    refs: [],
  };
  for (const ref of [...input.refs].sort(compareUnicodeCodePoints)) {
    identity.refs.push(`${ref}=${await resolveCommit(input.repository, assertSafeRef(ref, 'baseRef'), input.operation)}`);
  }
  if (input.includeIndexIdentity) {
    identity.indexIdentity = await indexPathIdentity(input.repository, input.operation);
  }
  return identity;
}

function sameGenerationIdentity(left: GenerationIdentity, right: GenerationIdentity): boolean {
  return left.head === right.head
    && left.indexIdentity === right.indexIdentity
    && left.endpoints.length === right.endpoints.length
    && left.endpoints.every((value, index) => value === right.endpoints[index])
    && left.refs.length === right.refs.length
    && left.refs.every((value, index) => value === right.refs[index]);
}

/**
 * Working-tree probe over the paths in scope. It hashes the same streams the
 * fingerprint hashes (the three diff groups and the untracked inventory) plus
 * the changed-path lists, so a captured snapshot and a re-probe that differ
 * describe different repository generations.
 */
type WorkingTreeProbeInput = {
  repository: string;
  operation: SnapshotOperation;
  comparisonBase: string;
  comparisonTarget: string;
  pathArgs: string[];
  isExcludedPath: (relativePath: string) => boolean;
  /** Preview bytes to retain per stream; the digest always covers full content. */
  previewLimit: number;
};

function appendProbeStream(hash: ReturnType<typeof createHash>, label: string, content: Buffer): void {
  hash.update(label);
  hash.update('\0');
  hash.update(createHash('sha256').update(content).digest('hex'));
  hash.update('\0');
  hash.update(String(content.byteLength));
  hash.update('\0');
}

function appendProbePaths(hash: ReturnType<typeof createHash>, label: string, paths: readonly string[]): void {
  hash.update(label);
  hash.update('\0');
  for (const relativePath of paths) {
    hash.update(relativePath);
    hash.update('\0');
  }
}

async function probeWorkingTree(input: WorkingTreeProbeInput): Promise<string> {
  const { repository, operation, pathArgs } = input;
  const comparisonDiff = await runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--binary', input.comparisonBase, input.comparisonTarget, ...pathArgs], operation);
  const stagedDiff = await runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--binary', '--cached', ...pathArgs], operation);
  const unstagedDiff = await runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--binary', ...pathArgs], operation);
  const comparisonPaths = parseNullSeparatedPaths(await runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--name-only', '-z', input.comparisonBase, input.comparisonTarget, ...pathArgs], operation));
  const stagedPaths = parseNullSeparatedPaths(await runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--cached', ...pathArgs], operation));
  const unstagedPaths = parseNullSeparatedPaths(await runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--name-only', '-z', ...pathArgs], operation));
  const untrackedPaths = parseNullSeparatedPaths(await runSnapshotGit(repository, ['ls-files', '--others', '--exclude-standard', '-z', ...pathArgs], operation))
    .filter((relativePath) => !input.isExcludedPath(relativePath));
  if (untrackedPaths.length > MAX_UNTRACKED_FILES) {
    throw new GitSnapshotError('INCOMPLETE_UNTRACKED_CAPTURE', {}, {
      detail: { kind: 'untracked-count', limit: MAX_UNTRACKED_FILES },
    });
  }

  const hash = createHash('sha256');
  appendProbeStream(hash, 'comparison', comparisonDiff);
  appendProbeStream(hash, 'staged', stagedDiff);
  appendProbeStream(hash, 'unstaged', unstagedDiff);
  appendProbePaths(hash, 'comparison-paths', comparisonPaths);
  appendProbePaths(hash, 'staged-paths', stagedPaths);
  appendProbePaths(hash, 'unstaged-paths', unstagedPaths);
  appendProbePaths(hash, 'untracked-paths', untrackedPaths);

  const deadline = untrackedCaptureDeadline(operation);
  let remainingBytes = MAX_UNTRACKED_TOTAL_BYTES;
  for (const relativePath of untrackedPaths) {
    assertUntrackedDeadline(deadline);
    const content = await captureBeforeDeadline(
      captureFile(repoPath(repository, relativePath), input.previewLimit, deadline, remainingBytes),
      deadline,
    );
    appendFingerprint(hash, `untracked:${relativePath}`, content);
    remainingBytes -= content.byteLength;
  }
  return hash.digest('hex');
}

function capturedWorkingTreeProbe(input: {
  comparisonDiff: CapturedContent;
  stagedDiff: CapturedContent;
  unstagedDiff: CapturedContent;
  comparisonPaths: readonly string[];
  stagedPaths: readonly string[];
  unstagedPaths: readonly string[];
  untrackedContent: ReadonlyArray<readonly [string, CapturedContent]>;
}): string {
  const hash = createHash('sha256');
  appendProbeStream(hash, 'comparison', input.comparisonDiff.content);
  appendProbeStream(hash, 'staged', input.stagedDiff.content);
  appendProbeStream(hash, 'unstaged', input.unstagedDiff.content);
  appendProbePaths(hash, 'comparison-paths', input.comparisonPaths);
  appendProbePaths(hash, 'staged-paths', input.stagedPaths);
  appendProbePaths(hash, 'unstaged-paths', input.unstagedPaths);
  appendProbePaths(hash, 'untracked-paths', input.untrackedContent.map(([relativePath]) => relativePath));
  for (const [relativePath, content] of input.untrackedContent) {
    appendFingerprint(hash, `untracked:${relativePath}`, content);
  }
  return hash.digest('hex');
}


type SnapshotCaptureResult = {
  snapshot: GitSnapshot;
  entries?: ReviewMaterializationEntry[];
};

type MaterializationCaptureResult = {
  snapshot: GitSnapshot;
  entries: ReviewMaterializationEntry[];
};

/**
 * One capture pass. Every step runs under one operation deadline, and the
 * snapshot is published only after the generation is revalidated, so a caller
 * can never observe a hybrid assembled across repository generations.
 *
 * `withMaterialization` additionally derives review entries from the same
 * validated generation rather than re-running path discovery afterwards.
 */
async function captureSnapshot(
  repositoryDirectory: string,
  input: GitSnapshotInput,
  withMaterialization: true,
): Promise<MaterializationCaptureResult>;
async function captureSnapshot(
  repositoryDirectory: string,
  input: GitSnapshotInput,
  withMaterialization: false,
): Promise<SnapshotCaptureResult>;
async function captureSnapshot(
  repositoryDirectory: string,
  input: GitSnapshotInput,
  withMaterialization: boolean,
): Promise<SnapshotCaptureResult> {
  const operation = createSnapshotOperation();
  if (input.range && (input.baseRef || input.targetRef)) {
    throw new GitSnapshotError('INVALID_REQUEST', {}, { detail: { kind: 'range-with-refs' } });
  }

  const paths = normalizeScopedPaths(input.paths);
  const excludePaths = normalizeScopedPaths(input.excludePaths);
  const isExcludedPath = (relativePath: string): boolean => excludePaths.some(
    (excludedPath) => relativePath === excludedPath || relativePath.startsWith(`${excludedPath}/`),
  );
  const maxFiles = resolveLimit(input.maxFiles, 100, MAX_FILES, 'maxFiles');
  const maxPatchBytes = resolveLimit(input.maxPatchBytes, 64 * 1024, MAX_PATCH_BYTES, 'maxPatchBytes');

  operation.phase = 'ref-resolution';
  const repository = await resolveAuthorizedGitRoot(repositoryDirectory, operation);
  const currentHead = await resolveCommit(repository, 'HEAD', operation);
  let comparisonBase: string | undefined;
  let comparisonTarget = currentHead;
  let mergeBase: string | undefined;
  let baseRef = input.baseRef;
  let targetRef = input.targetRef;

  if (input.range) {
    const parsed = parseRange(input.range);
    baseRef = parsed.baseRef;
    targetRef = parsed.targetRef;
    const base = await resolveCommit(repository, parsed.baseRef, operation, 'baseRef');
    const target = await resolveCommit(repository, parsed.targetRef, operation, 'targetRef');
    mergeBase = await resolveMergeBase(repository, base, target, operation);
    if (!mergeBase) {
      throw new GitSnapshotError('merge-base-unavailable');
    }
    comparisonBase = parsed.mergeBase ? mergeBase : base;
    comparisonTarget = target;
  } else {
    const target = targetRef
      ? await resolveCommit(repository, assertSafeRef(targetRef, 'targetRef'), operation, 'targetRef')
      : currentHead;
    const base = baseRef
      ? await resolveCommit(repository, assertSafeRef(baseRef, 'baseRef'), operation, 'baseRef')
      : await firstParent(repository, target, operation);
    comparisonBase = base ?? await resolveEmptyTree(repository, operation);
    comparisonTarget = target;
    mergeBase = base ? await resolveMergeBase(repository, base, target, operation) : undefined;
    if (base && !mergeBase) {
      throw new GitSnapshotError('merge-base-unavailable');
    }
  }

  const pathArgs = paths.length > 0 ? ['--', ...paths] : [];
  const untrackedPreviewLimit = Math.min(maxPatchBytes, MAX_UNTRACKED_PREVIEW_BYTES);
  const liveRefs = [baseRef, targetRef].filter((value): value is string => typeof value === 'string');
  const committed = input.targetRef !== undefined || input.range !== undefined;

  operation.phase = 'preflight';
  const identityBefore = await captureGenerationIdentity({
    repository,
    operation,
    comparisonBase,
    comparisonTarget,
    refs: liveRefs,
    includeIndexIdentity: !committed,
  });
  // Safety assertions run before any diff, because a diff reads worktree files
  // through clean filters and can execute a repository-controlled helper.
  await assertNoInScopeSubmoduleGitlinks(repository, comparisonBase, comparisonTarget, pathArgs, operation);
  if (!committed) await assertNoConcealedIndexPaths(repository, pathArgs, operation);
  await assertNoFilterAttributes(repository, pathArgs, operation);
  const workingTreeBefore = committed
    ? undefined
    : await probeWorkingTree({
      repository,
      operation,
      comparisonBase,
      comparisonTarget,
      pathArgs,
      isExcludedPath,
      previewLimit: untrackedPreviewLimit,
    });

  operation.phase = 'capture';
  const comparisonDiff = captureBuffer(await runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--binary', comparisonBase, comparisonTarget, ...pathArgs], operation));
  await notifyCaptureBoundary('comparison-diff-captured');
  const emptyContent = captureBuffer(Buffer.alloc(0));
  const stagedDiff = committed
    ? emptyContent
    : captureBuffer(await runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--binary', '--cached', ...pathArgs], operation));
  await notifyCaptureBoundary('staged-diff-captured');
  const unstagedDiff = committed
    ? emptyContent
    : captureBuffer(await runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--binary', ...pathArgs], operation));
  await notifyCaptureBoundary('unstaged-diff-captured');
  const comparisonPaths = parseNullSeparatedPaths(await runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--name-only', '-z', comparisonBase, comparisonTarget, ...pathArgs], operation));
  const stagedPaths = committed
    ? []
    : parseNullSeparatedPaths(await runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--cached', ...pathArgs], operation));
  const unstagedPaths = committed
    ? []
    : parseNullSeparatedPaths(await runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--name-only', '-z', ...pathArgs], operation));

  operation.phase = 'untracked-capture';
  const untrackedPaths = (committed
    ? []
    : parseNullSeparatedPaths(await runSnapshotGit(repository, ['ls-files', '--others', '--exclude-standard', '-z', ...pathArgs], operation))
  ).filter((relativePath) => !isExcludedPath(relativePath));
  await notifyCaptureBoundary('untracked-listed');
  if (untrackedPaths.length > MAX_UNTRACKED_FILES) {
    throw new GitSnapshotError('INCOMPLETE_UNTRACKED_CAPTURE', {}, {
      detail: { kind: 'untracked-count', limit: MAX_UNTRACKED_FILES },
    });
  }
  const untrackedContent: Array<readonly [string, CapturedContent]> = [];
  const untrackedDeadline = untrackedCaptureDeadline(operation);
  // Fires once the untracked bound is fixed and before the first read, so a
  // test can expire either bound deterministically.
  await notifyCaptureBoundary('untracked-capture-started');
  let remainingUntrackedBytes = MAX_UNTRACKED_TOTAL_BYTES;
  let remainingPreviewBytes = untrackedPreviewLimit;
  for (const relativePath of untrackedPaths) {
    assertUntrackedDeadline(untrackedDeadline);
    const content = await captureBeforeDeadline(
      captureFile(
        repoPath(repository, relativePath),
        Math.min(SOURCE_PREVIEW_BYTES, remainingPreviewBytes),
        untrackedDeadline,
        remainingUntrackedBytes,
      ),
      untrackedDeadline,
    );
    remainingUntrackedBytes -= content.byteLength;
    remainingPreviewBytes -= content.preview.byteLength;
    untrackedContent.push([relativePath, content]);
  }

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

  let entries: ReviewMaterializationEntry[] | undefined;
  if (withMaterialization) {
    if (Object.values(changedPathOmissions).some((count) => count > 0)) {
      throw new Error('Review snapshot has a partial materialization path set.');
    }
    if (committed) {
      entries = [];
    } else {
      // Path discovery and entry reads run inside the capture so the entries,
      // the snapshot, and the fingerprint all describe one generation.
      operation.phase = 'capture';
      const pathGroups = await Promise.all([
        runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--name-status', '-z', comparisonBase, comparisonTarget, ...pathArgs], operation),
        runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--cached', ...pathArgs], operation),
        runSnapshotGit(repository, ['diff', ...IGNORE_SUBMODULES, '--no-ext-diff', '--no-textconv', '--name-status', '-z', ...pathArgs], operation),
        runSnapshotGit(repository, ['ls-files', '--others', '--exclude-standard', '-z', ...pathArgs], operation),
      ]);
      const materializationPaths = new Set([
        ...parseNameStatusPaths(pathGroups[0]!),
        ...parseNameStatusPaths(pathGroups[1]!),
        ...parseNameStatusPaths(pathGroups[2]!),
        ...parseNullSeparatedPaths(pathGroups[3]!),
      ].filter((relativePath) => !isExcludedPath(relativePath)));
      if (materializationPaths.size > MAX_FILES) {
        throw new Error('Review snapshot has a partial materialization path set.');
      }
      operation.phase = 'untracked-capture';
      entries = [];
      const entryDeadline = untrackedCaptureDeadline(operation);
      let entryRemainingBytes = MAX_UNTRACKED_TOTAL_BYTES;
      for (const relativePath of [...materializationPaths].sort(compareUnicodeCodePoints)) {
        const entry = await captureMaterializationEntry(repository, relativePath, entryDeadline, entryRemainingBytes);
        if (entry.content) entryRemainingBytes -= entry.content.byteLength;
        entries.push(entry);
      }
    }
  }

  // Revalidation compares the generation identity and the working-tree probe
  // against the pre-capture values. Any difference means the snapshot and the
  // entries would mix two repository generations.
  operation.phase = 'revalidation';
  await notifyCaptureBoundary('before-revalidation');
  const capturedSections: MaterialSection[] = [
    { section: 'comparison', label: 'comparison diff', content: comparisonDiff },
    { section: 'staged', label: 'staged diff', content: stagedDiff },
    { section: 'unstaged', label: 'unstaged diff', content: unstagedDiff },
    ...untrackedContent.map(([relativePath, content]): MaterialSection => ({
      section: `untracked:${relativePath}`,
      label: `untracked ${relativePath}`,
      content,
    })),
  ];
  const identityAfter = await captureGenerationIdentity({
    repository,
    operation,
    comparisonBase,
    comparisonTarget,
    refs: liveRefs,
    includeIndexIdentity: !committed,
  });
  if (!sameGenerationIdentity(identityBefore, identityAfter)) {
    throw sourceDriftError(operation);
  }
  if (workingTreeBefore !== undefined) {
    const workingTreeAfter = await probeWorkingTree({
      repository,
      operation,
      comparisonBase,
      comparisonTarget,
      pathArgs,
      isExcludedPath,
      previewLimit: untrackedPreviewLimit,
    });
    if (capturedWorkingTreeProbe({
      comparisonDiff,
      stagedDiff,
      unstagedDiff,
      comparisonPaths,
      stagedPaths,
      unstagedPaths,
      untrackedContent,
    }) !== workingTreeBefore || workingTreeBefore !== workingTreeAfter) {
      throw sourceDriftError(operation);
    }
  }

  operation.phase = 'serialization';
  const fingerprintHash = createHash('sha256');
  fingerprintHash.update(JSON.stringify({
    baseRef,
    targetRef,
    range: input.range,
    paths,
    excludePaths,
    currentHead,
    comparisonBase,
    comparisonTarget,
    mergeBase,
  }));
  appendFingerprint(fingerprintHash, 'comparison', comparisonDiff);
  appendFingerprint(fingerprintHash, 'staged', stagedDiff);
  appendFingerprint(fingerprintHash, 'unstaged', unstagedDiff);
  for (const [relativePath, content] of untrackedContent) {
    appendFingerprint(fingerprintHash, `untracked:${relativePath}`, content);
  }

  const sections = capturedSections.map(({ label, content }) => materialSection(label, content));
  const previewOmittedBytes = capturedSections
    .reduce((total, { content }) => total + content.byteLength - content.preview.byteLength, 0);
  const material = Buffer.concat(sections).toString('utf8');
  const patch = truncateUtf8(material, maxPatchBytes);
  const patchOmittedBytes = previewOmittedBytes + Math.max(0, Buffer.byteLength(material) - Buffer.byteLength(patch));

  const snapshot: GitSnapshot = {
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
    consistency: 'validated',
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
      sections: reportSectionOmissions(capturedSections, patch),
    },
  };
  return entries === undefined ? { snapshot } : { snapshot, entries };
}

export async function inspectGitSnapshot(repositoryDirectory: string, input: GitSnapshotInput): Promise<GitSnapshot> {
  return (await captureSnapshot(repositoryDirectory, input, false)).snapshot;
}

export function parseNameStatusPaths(content: Buffer): string[] {
  const tokens = parseNullSeparatedTokens(content);
  const paths: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const before = tokens[index++];
      const after = tokens[index++];
      if (before) paths.push(before);
      if (after) paths.push(after);
      continue;
    }
    const changedPath = tokens[index++];
    if (changedPath) paths.push(changedPath);
  }
  return [...new Set(paths)].sort(compareUnicodeCodePoints);
}

export type ReviewSourceScopeFingerprintInput = {
  manifestRepositoryIds: string[];
  selectedRepositoryIds: string[];
  snapshots: Array<{ repositoryId: string; sourceRoot: string; fingerprint: string }>;
};

export type ReviewMaterializationEntryDescriptor = {
  path: string;
  kind: ReviewMaterializationEntry['kind'];
};

export function serializeReviewSourceScopeFingerprint(input: ReviewSourceScopeFingerprintInput): string {
  return JSON.stringify({
    manifestRepositoryIds: input.manifestRepositoryIds,
    selectedRepositoryIds: input.selectedRepositoryIds,
    snapshots: [...input.snapshots]
      .sort((left, right) => compareUnicodeCodePoints(left.repositoryId, right.repositoryId))
      .map(({ repositoryId, sourceRoot, fingerprint }) => ({ repositoryId, sourceRoot, fingerprint })),
  });
}

export function fingerprintReviewSourceScope(input: ReviewSourceScopeFingerprintInput): string {
  return createHash('sha256').update(serializeReviewSourceScopeFingerprint(input)).digest('hex');
}

export function fingerprintLegacyReviewSourceScope(input: ReviewSourceScopeFingerprintInput): string {
  return createHash('sha256').update(JSON.stringify({
    manifestRepositoryIds: input.manifestRepositoryIds,
    selectedRepositoryIds: input.selectedRepositoryIds,
    snapshots: [...input.snapshots]
      .sort((left, right) => compareUnicodeCodePoints(left.repositoryId, right.repositoryId))
      .map(({ repositoryId, fingerprint }) => ({ repositoryId, fingerprint })),
  })).digest('hex');
}

export function compactMaterializationDescriptors(
  entries: readonly ReviewMaterializationEntry[],
): ReviewMaterializationEntryDescriptor[] {
  return [...entries]
    .sort((left, right) => compareUnicodeCodePoints(left.path, right.path))
    .map(({ path, kind }) => ({ path, kind }));
}

export function fingerprintReviewRepositoryMaterializations(
  captures: Array<{ repositoryId: string; fingerprint: string }>,
): string {
  return createHash('sha256').update(JSON.stringify(
    [...captures].sort((left, right) => compareUnicodeCodePoints(left.repositoryId, right.repositoryId)),
  )).digest('hex');
}

function materializationFingerprint(entries: readonly ReviewMaterializationEntry[]): string {
  const hash = createHash('sha256');
  hash.update('hive-review-materialization-v1\0');
  for (const entry of [...entries].sort((left, right) => compareUnicodeCodePoints(left.path, right.path))) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.kind);
    hash.update('\0');
    hash.update(entry.mode === undefined ? '' : String(entry.mode));
    hash.update('\0');
    if (entry.content) hash.update(entry.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function captureMaterializationEntry(
  repository: string,
  relativePath: string,
  deadline: CaptureDeadline,
  remainingBytes: number,
): Promise<ReviewMaterializationEntry> {
  const target = repoPath(repository, relativePath);
  try {
    await fs.lstat(target);
  } catch (error) {
    // A path that is absent in the final dirty tree is a deletion entry; only
    // absence is tolerated here, so a vanished-then-recreated path still fails.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: relativePath, kind: 'delete' };
    }
    throw error;
  }
  const content = await captureBeforeDeadline(
    captureFile(target, MAX_UNTRACKED_FILE_BYTES, deadline, remainingBytes),
    deadline,
  );
  return {
    path: relativePath,
    kind: content.fileType === 'symlink' ? 'symlink' : 'regular',
    content: content.content,
    mode: content.mode,
  };
}

async function assertWorkspaceParents(root: string, relativePath: string): Promise<void> {
  const segments = path.dirname(relativePath).split(path.sep).filter((segment) => segment && segment !== '.');
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Review materialization path escapes through symlink: ${relativePath}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Review materialization parent is not a directory: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(current);
    }
  }
}

async function captureWorkspaceEntry(
  workspace: string,
  entry: ReviewMaterializationEntryDescriptor,
  deadline: CaptureDeadline,
  remainingBytes: number,
): Promise<ReviewMaterializationEntry> {
  const target = repoPath(workspace, entry.path);
  if (entry.kind === 'delete') {
    try {
      await fs.lstat(target);
      return { path: entry.path, kind: 'regular' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: entry.path, kind: 'delete' };
      throw error;
    }
  }
  const content = await captureBeforeDeadline(captureFile(target, MAX_UNTRACKED_FILE_BYTES, deadline, remainingBytes), deadline);
  return {
    path: entry.path,
    kind: content.fileType === 'symlink' ? 'symlink' : 'regular',
    content: content.content,
    mode: content.mode,
  };
}

export async function captureReviewMaterialization(
  repositoryDirectory: string,
  input: GitSnapshotInput,
): Promise<ReviewMaterialization> {
  const { snapshot, entries } = await captureSnapshot(repositoryDirectory, input, true);
  return { snapshot, entries, fingerprint: materializationFingerprint(entries) };
}

export async function fingerprintReviewWorkspace(
  workspace: string,
  expectedEntries: readonly ReviewMaterializationEntryDescriptor[],
): Promise<string> {
  const deadline = standaloneUntrackedCaptureDeadline();
  let remainingBytes = MAX_UNTRACKED_TOTAL_BYTES;
  const entries: ReviewMaterializationEntry[] = [];
  for (const expected of [...expectedEntries].sort((left, right) => compareUnicodeCodePoints(left.path, right.path))) {
    const entry = await captureWorkspaceEntry(workspace, expected, deadline, remainingBytes);
    if (entry.content) remainingBytes -= entry.content.byteLength;
    entries.push(entry);
  }
  return materializationFingerprint(entries);
}

export async function materializeReviewWorkspace(
  workspace: string,
  materialization: ReviewMaterialization,
): Promise<void> {
  for (const entry of materialization.entries.filter((entry) => entry.kind === 'delete')) {
    const target = repoPath(workspace, entry.path);
    await assertWorkspaceParents(workspace, entry.path);
    await fs.rm(target, { recursive: true, force: true });
  }
  for (const entry of materialization.entries.filter((entry) => entry.kind !== 'delete')) {
    const target = repoPath(workspace, entry.path);
    await assertWorkspaceParents(workspace, entry.path);
    await fs.rm(target, { recursive: true, force: true });
    if (entry.kind === 'symlink') {
      await fs.symlink(entry.content!.toString('utf8'), target);
    } else {
      await fs.writeFile(target, entry.content!);
      if (entry.mode !== undefined) await fs.chmod(target, entry.mode & 0o7777);
    }
  }
  const fingerprint = await fingerprintReviewWorkspace(workspace, materialization.entries);
  if (fingerprint !== materialization.fingerprint) {
    throw new Error('Review workspace materialization fingerprint mismatch.');
  }
}
