import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import * as path from 'node:path';

export type ReviewEvidenceBundleWorkflow = 'dash-review';
export type ReviewEvidenceBundleKind = 'inline' | 'local-artifacts';

export interface ReviewEvidenceBundleCaller {
  workflow: ReviewEvidenceBundleWorkflow;
  role: 'creator' | 'primary';
  agent: string;
  sessionId: string;
  pid: number;
}

export interface ReviewEvidenceBundleConfig {
  projectRoot: string;
  now?: () => number;
  handoffMs?: number;
  startupSweepLimit?: number;
  isProcessAlive?: (pid: number) => boolean;
  onSweepError?: (runId: string, error: Error) => void;
  onArtifactCopyProgress?: (sourcePath: string, copiedBytes: number) => Promise<void>;
  onLockPublication?: (lockPath: string) => Promise<void>;
}

export type ReviewEvidenceBundleItemInput =
  | { kind: 'inline'; bytes: Uint8Array }
  | { kind: 'artifact'; sourcePath: string };

export interface ReviewEvidenceBundleInlineManifestItem {
  kind: 'inline';
  materializedPath: 'evidence/operator-intent.txt';
  byteLength: number;
  digest: string;
}

export interface ReviewEvidenceBundleArtifactManifestItem {
  kind: 'artifact';
  sourcePath: string;
  materializedPath: string;
  byteLength: number;
  digest: string;
}

export type ReviewEvidenceBundleManifestItem =
  | ReviewEvidenceBundleInlineManifestItem
  | ReviewEvidenceBundleArtifactManifestItem;

export interface ReviewEvidenceBundleManifest {
  schemaVersion: 1;
  runId: string;
  workflow: ReviewEvidenceBundleWorkflow;
  kind: ReviewEvidenceBundleKind;
  resolutionFingerprint: string;
  scopeFingerprint: string;
  sourceFingerprint: string;
  materializationFingerprint: string;
  items: ReviewEvidenceBundleManifestItem[];
}

export interface ReviewEvidenceBundleCreateOptions {
  runId: string;
  caller: ReviewEvidenceBundleCaller;
  resolutionFingerprint: string;
  items: ReviewEvidenceBundleItemInput[];
}

export interface ReviewEvidenceBundleArtifactCapture {
  sourcePath: string;
  byteLength: number;
  digest: string;
}

export interface ReviewEvidenceBundleInfo {
  runId: string;
  workspacePath: string;
  ownershipToken: string;
  kind: ReviewEvidenceBundleKind;
  resolutionFingerprint: string;
  scopeFingerprint: string;
  sourceFingerprint: string;
  materializationFingerprint: string;
  items: ReviewEvidenceBundleManifestItem[];
}

export interface ReviewEvidenceBundleInspection {
  runId: string;
  workspacePath: string;
  manifest: ReviewEvidenceBundleManifest;
  integrity: {
    bundleClean: true;
    sourcesClean: true;
  };
}

export interface ReviewEvidenceBundleAuthorizationRecovery {
  runId: string;
  workspacePath: string;
  workflow: ReviewEvidenceBundleWorkflow;
  resolutionFingerprint: string;
  creatorAgent: string;
  creatorSessionId: string;
  creatorPid: number;
  ownerAgent?: string;
  ownerSessionId?: string;
  ownerPid?: number;
  ownerRecoveryExpiresAt?: number;
}

export interface ReviewEvidenceBundleCleanupResult {
  runId: string;
  workspacePath: string;
  cleaned: true;
}

interface CanonicalInlineInput {
  kind: 'inline';
  bytes: Buffer;
}

interface CanonicalArtifactInput {
  kind: 'artifact';
  sourcePath: string;
}

type CanonicalItemInput = CanonicalInlineInput | CanonicalArtifactInput;

interface CreatingMetadata {
  schemaVersion: 1;
  state: 'creating';
  runId: string;
  workflow: ReviewEvidenceBundleWorkflow;
  kind: ReviewEvidenceBundleKind;
  creatorAgent: string;
  creatorSessionId: string;
  creatorPid: number;
  ownershipTokenHash: string;
  createdAt: number;
  handoffExpiresAt: number;
}

interface SealedMetadata extends Omit<CreatingMetadata, 'state'> {
  state: 'sealed';
  manifest: ReviewEvidenceBundleManifest;
  manifestDigest: string;
  ownerAgent?: string;
  ownerSessionId?: string;
  ownerPid?: number;
  ownerRecoveryExpiresAt?: number;
}

type ReviewEvidenceBundleMetadata = CreatingMetadata | SealedMetadata;

interface PublishedLock {
  ownerToken: string;
  ownerPid: number;
  expiresAt: number;
}

interface HeldLock {
  lockPath: string;
  ownerToken: string;
}

interface CapturedFile {
  byteLength: number;
  digest: string;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_RUNTIME_PROCESS_ID = 0x7fffffff;
const MAX_ARTIFACT_FILES = 32;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_PRIVATE_FILE_BYTES = 1024 * 1024;
const COPY_CHUNK_BYTES = 64 * 1024;
const DEFAULT_HANDOFF_MS = 5 * 60 * 1000;
const DEFAULT_STARTUP_SWEEP_LIMIT = 16;
const MAX_STARTUP_SWEEP_LIMIT = 64;
const METADATA_DIRECTORY = '.runs';
const LOCK_DIRECTORY = '.locks';
const LOCK_SUFFIX = '.lock';
const RECOVERY_SUFFIX = '.recovery';
const ROOT_COMPONENTS = ['.hive', '.worktrees', 'review-evidence'] as const;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

export const REVIEW_EVIDENCE_BUNDLE_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical review evidence values must be finite.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort(compareUnicodeCodePoints)
      .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error('Unsupported canonical review evidence value.');
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fingerprint(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(canonicalSerialize(value))
    .digest('hex');
}

function isSafeRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId) && !runId.includes('..');
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const actual = Object.keys(value).sort(compareUnicodeCodePoints);
  const expected = [...allowed].sort(compareUnicodeCodePoints);
  if (canonicalSerialize(actual) !== canonicalSerialize(expected)) {
    throw new Error(`Invalid ${context}.`);
  }
}

function isSafePid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_RUNTIME_PROCESS_ID;
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameInodeIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function isContainedPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function canonicalArtifactSelector(sourcePath: unknown): string {
  if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\0') || sourcePath.includes('\\')) {
    throw new Error('Review evidence artifact path must be a non-empty canonical project-relative path.');
  }
  if (path.posix.isAbsolute(sourcePath) || path.win32.isAbsolute(sourcePath)) {
    throw new Error('Review evidence artifact path must be project-relative.');
  }
  const normalized = path.posix.normalize(sourcePath);
  if (normalized !== sourcePath || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Review evidence artifact path must not traverse the project root.');
  }
  const components = sourcePath.split('/');
  if (components.some((component) => !component || component === '.' || component === '..')) {
    throw new Error('Review evidence artifact path must be canonical.');
  }
  if (components.some((component) => component.toLowerCase() === '.git' || component.toLowerCase() === '.hive')) {
    throw new Error('Review evidence artifact path exposes private project runtime state.');
  }
  return sourcePath;
}

function safeExtension(sourcePath: string): string {
  const extension = path.posix.extname(sourcePath);
  return /^\.[A-Za-z0-9]{1,16}$/.test(extension) ? extension : '';
}

function artifactMaterializedPath(sourcePath: string): string {
  const opaqueId = fingerprint('hive-review-evidence-artifact-id-v1', sourcePath).slice(0, 32);
  return `evidence/artifact-${opaqueId}${safeExtension(sourcePath)}`;
}

function itemScopeIdentity(item: ReviewEvidenceBundleManifestItem): Record<string, unknown> {
  return item.kind === 'inline'
    ? { kind: item.kind, name: 'operator-intent.txt' }
    : { kind: item.kind, sourcePath: item.sourcePath };
}

function itemSourceIdentity(item: ReviewEvidenceBundleManifestItem): Record<string, unknown> {
  return {
    ...itemScopeIdentity(item),
    byteLength: item.byteLength,
    digest: item.digest,
  };
}

function itemMaterializationIdentity(item: ReviewEvidenceBundleManifestItem): Record<string, unknown> {
  return {
    kind: item.kind,
    materializedPath: item.materializedPath,
    byteLength: item.byteLength,
    digest: item.digest,
  };
}

function bundleFingerprints(items: readonly ReviewEvidenceBundleManifestItem[]): {
  scopeFingerprint: string;
  sourceFingerprint: string;
  materializationFingerprint: string;
} {
  return {
    scopeFingerprint: fingerprint('hive-review-evidence-scope-v1', items.map(itemScopeIdentity)),
    sourceFingerprint: fingerprint('hive-review-evidence-source-v1', items.map(itemSourceIdentity)),
    materializationFingerprint: fingerprint(
      'hive-review-evidence-materialization-v1',
      items.map(itemMaterializationIdentity),
    ),
  };
}

function metadataError(runId: string): Error {
  return new Error(`Invalid review evidence metadata: ${runId}`);
}

export class ReviewEvidenceBundleService {
  private readonly projectRoot: Promise<string>;

  constructor(private readonly config: ReviewEvidenceBundleConfig) {
    this.projectRoot = this.resolveProjectRoot();
  }

  private get now(): number {
    const value = (this.config.now ?? Date.now)();
    if (!isSafeTimestamp(value)) throw new Error('Review evidence clock returned an invalid timestamp.');
    return value;
  }

  private get handoffMs(): number {
    const value = this.config.handoffMs ?? DEFAULT_HANDOFF_MS;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Review evidence handoff TTL must be positive.');
    return value;
  }

  private get startupSweepLimit(): number {
    const value = this.config.startupSweepLimit ?? DEFAULT_STARTUP_SWEEP_LIMIT;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_STARTUP_SWEEP_LIMIT) {
      throw new Error(`Review evidence startup sweep limit must be between 1 and ${MAX_STARTUP_SWEEP_LIMIT}.`);
    }
    return value;
  }

  private async resolveProjectRoot(): Promise<string> {
    const configuredPath = path.resolve(this.config.projectRoot);
    const configuredStat = await fs.lstat(configuredPath);
    if (configuredStat.isSymbolicLink() || !configuredStat.isDirectory()) {
      throw new Error(`Review evidence project root is not a real directory: ${this.config.projectRoot}`);
    }
    return fs.realpath(configuredPath);
  }

  private assertRunId(runId: string): void {
    if (!isSafeRunId(runId)) throw new Error(`Invalid review evidence runId: ${JSON.stringify(runId)}`);
  }

  private callerPid(caller: ReviewEvidenceBundleCaller): number {
    if (!isSafePid(caller.pid)) throw new Error('Review evidence caller process is required.');
    return caller.pid;
  }

  private assertCaller(caller: ReviewEvidenceBundleCaller, role: 'creator' | 'primary'): void {
    if (caller.workflow !== 'dash-review') {
      throw new Error('Review evidence bundles support only the dash-review workflow.');
    }
    if (caller.role !== role) {
      throw new Error(`Review evidence ${role} capability was denied; ${role === 'primary' ? 'primary' : 'creator'} role required.`);
    }
    if (!caller.agent || !caller.sessionId || caller.agent.includes('\0') || caller.sessionId.includes('\0')) {
      throw new Error(`Review evidence ${role} identity is required.`);
    }
    this.callerPid(caller);
  }

  private isProcessAlive(pid: number): boolean {
    if (this.config.isProcessAlive) return this.config.isProcessAlive(pid);
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      throw error;
    }
  }

  private async inspectRuntimeRoot(required: boolean): Promise<string | null> {
    let current = await this.projectRoot;
    for (const component of ROOT_COMPONENTS) {
      const next = path.join(current, component);
      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stat = await fs.lstat(next);
      } catch (error) {
        if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(next) !== next) {
        throw new Error(`Review evidence runtime root has an unsafe component: ${component}`);
      }
      current = next;
    }
    for (const privateDirectory of [METADATA_DIRECTORY, LOCK_DIRECTORY]) {
      const privatePath = path.join(current, privateDirectory);
      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stat = await fs.lstat(privatePath);
      } catch (error) {
        if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error(`Review evidence private directory is unavailable: ${privateDirectory}`);
      }
      if (
        stat.isSymbolicLink()
        || !stat.isDirectory()
        || await fs.realpath(privatePath) !== privatePath
        || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      ) {
        throw new Error(`Review evidence private directory is unsafe: ${privateDirectory}`);
      }
    }
    return current;
  }

  private async ensureDirectory(directoryPath: string, privateDirectory = false): Promise<void> {
    try {
      await fs.mkdir(directoryPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(directoryPath);
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || await fs.realpath(directoryPath) !== directoryPath
      || (privateDirectory && process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error(`Review evidence private path is not a real directory: ${directoryPath}`);
    }
  }

  private async ensureRuntimeRoot(): Promise<string> {
    let current = await this.projectRoot;
    for (const component of ROOT_COMPONENTS) {
      current = path.join(current, component);
      await this.ensureDirectory(current);
    }
    await this.ensureDirectory(path.join(current, METADATA_DIRECTORY), true);
    await this.ensureDirectory(path.join(current, LOCK_DIRECTORY), true);
    return current;
  }

  private workspacePathAt(root: string, runId: string): string {
    this.assertRunId(runId);
    const workspacePath = path.resolve(root, runId);
    if (path.dirname(workspacePath) !== root) throw new Error(`Review evidence workspace path escapes its root: ${runId}`);
    return workspacePath;
  }

  private metadataPathAt(root: string, runId: string): string {
    return path.join(root, METADATA_DIRECTORY, `${runId}.json`);
  }

  private lockPathAt(root: string, runId: string): string {
    return path.join(root, LOCK_DIRECTORY, `${runId}${LOCK_SUFFIX}`);
  }

  private async writeExclusiveFile(filePath: string, bytes: Uint8Array): Promise<void> {
    const handle = await fs.open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
        if (bytesWritten < 1) throw new Error(`Failed to write review evidence file: ${filePath}`);
        offset += bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async readStableFile(filePath: string, maxBytes: number, containmentRoot?: string): Promise<Buffer> {
    const before = await fs.lstat(filePath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Review evidence file is not regular: ${filePath}`);
    if (before.nlink !== 1n) throw new Error(`Review evidence file has multiple hard links: ${filePath}`);
    if (before.size > BigInt(maxBytes)) throw new Error(`Review evidence file exceeds its read bound: ${filePath}`);
    if (containmentRoot) {
      const realPath = await fs.realpath(filePath);
      if (realPath !== filePath || !isContainedPath(containmentRoot, realPath)) {
        throw new Error(`Review evidence file escapes its private root: ${filePath}`);
      }
    }
    const handle = await fs.open(filePath, constants.O_RDONLY | NO_FOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameFileIdentity(before, opened)) throw new Error(`Review evidence file changed before it was read: ${filePath}`);
      const bytes = await handle.readFile();
      const [after, current, currentRealPath] = await Promise.all([
        handle.stat({ bigint: true }),
        fs.lstat(filePath, { bigint: true }),
        containmentRoot ? fs.realpath(filePath) : Promise.resolve(filePath),
      ]);
      if (
        bytes.byteLength > maxBytes
        || !sameFileIdentity(opened, after)
        || !sameFileIdentity(opened, current)
        || BigInt(bytes.byteLength) !== after.size
        || (containmentRoot !== undefined
          && (currentRealPath !== filePath || !isContainedPath(containmentRoot, currentRealPath)))
      ) {
        throw new Error(`Review evidence file changed while it was read: ${filePath}`);
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  private async publishLock(lockPath: string, lock: PublishedLock): Promise<boolean> {
    const temporaryPath = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${randomUUID()}.tmp`);
    let linked = false;
    let publicationCompleted = false;
    try {
      await this.writeExclusiveFile(temporaryPath, Buffer.from(`${canonicalSerialize(lock)}\n`, 'utf8'));
      try {
        await fs.link(temporaryPath, lockPath);
        linked = true;
        await this.config.onLockPublication?.(lockPath);
        publicationCompleted = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    } finally {
      if (!linked || publicationCompleted) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    }
  }

  private async normalizeLockPublicationResidue(lockPath: string): Promise<void> {
    const lockStat = await fs.lstat(lockPath, { bigint: true });
    if (
      lockStat.isSymbolicLink()
      || !lockStat.isFile()
      || (process.platform !== 'win32' && (lockStat.mode & 0o777n) !== 0o600n)
    ) {
      throw new Error(`Invalid review evidence run lock: ${lockPath}`);
    }
    if (lockStat.nlink === 1n) return;
    if (lockStat.nlink !== 2n) {
      throw new Error(`Invalid review evidence lock publication residue: ${lockPath}`);
    }
    const directory = path.dirname(lockPath);
    const escapedBase = path.basename(lockPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const temporaryName = new RegExp(`^\\.${escapedBase}\\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$`, 'i');
    const matching: string[] = [];
    for (const name of await fs.readdir(directory)) {
      if (!temporaryName.test(name)) continue;
      const candidate = path.join(directory, name);
      const candidateStat = await fs.lstat(candidate, { bigint: true });
      if (
        !candidateStat.isSymbolicLink()
        && candidateStat.isFile()
        && candidateStat.dev === lockStat.dev
        && candidateStat.ino === lockStat.ino
      ) matching.push(candidate);
    }
    if (matching.length !== 1) {
      throw new Error(`Invalid review evidence lock publication residue: ${lockPath}`);
    }
    await fs.rm(matching[0]!);
    const recovered = await fs.lstat(lockPath, { bigint: true });
    if (!recovered.isFile() || recovered.isSymbolicLink() || recovered.nlink !== 1n || !sameInodeIdentity(lockStat, recovered)) {
      throw new Error(`Invalid review evidence lock publication residue: ${lockPath}`);
    }
  }

  private async readLock(lockPath: string): Promise<PublishedLock | null> {
    let bytes: Buffer;
    try {
      await this.normalizeLockPublicationResidue(lockPath);
      bytes = await this.readStableFile(lockPath, 1024, path.dirname(lockPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error(`Invalid review evidence run lock: ${lockPath}`);
    }
    if (!isRecord(parsed)) throw new Error(`Invalid review evidence run lock: ${lockPath}`);
    assertExactKeys(parsed, ['expiresAt', 'ownerPid', 'ownerToken'], 'review evidence run lock');
    if (
      typeof parsed.ownerToken !== 'string'
      || !parsed.ownerToken
      || !isSafePid(parsed.ownerPid)
      || !isSafeTimestamp(parsed.expiresAt)
    ) {
      throw new Error(`Invalid review evidence run lock: ${lockPath}`);
    }
    return { ownerToken: parsed.ownerToken, ownerPid: parsed.ownerPid, expiresAt: parsed.expiresAt };
  }

  private async removeLockIfOwned(lockPath: string, ownerToken: string): Promise<void> {
    const current = await this.readLock(lockPath);
    if (current?.ownerToken === ownerToken) await fs.rm(lockPath, { force: true });
  }

  private async acquireRecoveryGuard(guardPath: string): Promise<HeldLock> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ownerToken = randomUUID();
      if (await this.publishLock(guardPath, {
        ownerToken,
        ownerPid: process.pid,
        expiresAt: this.now + this.handoffMs,
      })) {
        return { lockPath: guardPath, ownerToken };
      }
      const existing = await this.readLock(guardPath);
      if (!existing || this.isProcessAlive(existing.ownerPid)) {
        throw new Error(`Review evidence run lock is busy: ${path.basename(guardPath)}`);
      }
      await this.removeLockIfOwned(guardPath, existing.ownerToken);
    }
    throw new Error(`Review evidence run lock is busy: ${path.basename(guardPath)}`);
  }

  private async recoverDeadLock(lockPath: string): Promise<void> {
    const guard = await this.acquireRecoveryGuard(`${lockPath}${RECOVERY_SUFFIX}`);
    try {
      const existing = await this.readLock(lockPath);
      if (!existing) return;
      if (this.isProcessAlive(existing.ownerPid)) {
        throw new Error(`Review evidence run lock is busy: ${path.basename(lockPath)}`);
      }
      await this.removeLockIfOwned(lockPath, existing.ownerToken);
    } finally {
      await this.removeLockIfOwned(guard.lockPath, guard.ownerToken);
    }
  }

  private async acquireRunLock(root: string, runId: string): Promise<HeldLock> {
    await this.ensureDirectory(path.join(root, LOCK_DIRECTORY));
    const lockPath = this.lockPathAt(root, runId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ownerToken = randomUUID();
      if (await this.publishLock(lockPath, {
        ownerToken,
        ownerPid: process.pid,
        expiresAt: this.now + this.handoffMs,
      })) {
        return { lockPath, ownerToken };
      }
      await this.recoverDeadLock(lockPath);
    }
    throw new Error(`Review evidence run lock is busy: ${runId}`);
  }

  private async releaseRunLock(lock: HeldLock): Promise<void> {
    await this.removeLockIfOwned(lock.lockPath, lock.ownerToken);
  }

  private canonicalizeInputs(items: readonly ReviewEvidenceBundleItemInput[]): {
    kind: ReviewEvidenceBundleKind;
    items: CanonicalItemInput[];
  } {
    if (!Array.isArray(items) || items.length === 0) throw new Error('Review evidence bundle requires at least one item.');
    let inline: CanonicalInlineInput | undefined;
    const artifacts = new Map<string, CanonicalArtifactInput>();
    for (const item of items) {
      if (!isRecord(item) || (item.kind !== 'inline' && item.kind !== 'artifact')) {
        throw new Error('Review evidence bundle item is invalid.');
      }
      if (item.kind === 'inline') {
        if (inline) throw new Error('Review evidence bundle requires exactly one inline item.');
        if (!(item.bytes instanceof Uint8Array)) throw new Error('Review evidence inline bytes are required.');
        if (item.bytes.byteLength > MAX_ARTIFACT_BYTES) {
          throw new Error('Review evidence inline item exceeds the 16 MiB per-item limit.');
        }
        inline = { kind: 'inline', bytes: Buffer.from(item.bytes) };
      } else {
        const sourcePath = canonicalArtifactSelector(item.sourcePath);
        artifacts.set(sourcePath, { kind: 'artifact', sourcePath });
      }
    }
    if (artifacts.size > MAX_ARTIFACT_FILES) {
      throw new Error(`Review evidence bundle accepts at most ${MAX_ARTIFACT_FILES} artifact files.`);
    }
    if (inline && artifacts.size > 0) {
      throw new Error('Review evidence bundle requires exactly one evidence kind.');
    }
    const canonical: CanonicalItemInput[] = [];
    if (inline) canonical.push(inline);
    canonical.push(...[...artifacts.values()].sort((left, right) => compareUnicodeCodePoints(left.sourcePath, right.sourcePath)));
    return {
      kind: inline ? 'inline' : 'local-artifacts',
      items: canonical,
    };
  }

  private async openProjectArtifact(sourcePath: string): Promise<{
    absolutePath: string;
    handle: Awaited<ReturnType<typeof fs.open>>;
    openedStat: BigIntStats;
  }> {
    const projectRoot = await this.projectRoot;
    const components = sourcePath.split('/');
    let current = projectRoot;
    let before!: BigIntStats;
    // Node has no openat-style path walk; parent replacement is a residual TOCTOU, bounded by descriptor identity checks.
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]!);
      const stat = await fs.lstat(current, { bigint: true });
      if (stat.isSymbolicLink()) throw new Error(`Review evidence artifact path contains a symbolic link: ${sourcePath}`);
      if (index < components.length - 1 && !stat.isDirectory()) {
        throw new Error(`Review evidence artifact parent is not a directory: ${sourcePath}`);
      }
      if (index === components.length - 1) before = stat;
    }
    if (!before.isFile()) throw new Error(`Review evidence artifact must be a regular file: ${sourcePath}`);
    if (before.nlink !== 1n) throw new Error(`Review evidence artifact has multiple hard links: ${sourcePath}`);
    const beforeRealPath = await fs.realpath(current);
    if (!isContainedPath(projectRoot, beforeRealPath) || beforeRealPath !== current) {
      throw new Error(`Review evidence artifact escapes the project root: ${sourcePath}`);
    }
    const handle = await fs.open(current, constants.O_RDONLY | NO_FOLLOW);
    try {
      const openedStat = await handle.stat({ bigint: true });
      if (openedStat.nlink !== 1n) throw new Error(`Review evidence artifact has multiple hard links: ${sourcePath}`);
      if (!openedStat.isFile() || !sameFileIdentity(before, openedStat)) {
        throw new Error(`Review evidence artifact changed before it was captured: ${sourcePath}`);
      }
      return { absolutePath: current, handle, openedStat };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async verifyOpenedArtifact(
    sourcePath: string,
    absolutePath: string,
    openedStat: BigIntStats,
    handle: Awaited<ReturnType<typeof fs.open>>,
    byteLength: number,
  ): Promise<void> {
    try {
      const [after, current, currentRealPath] = await Promise.all([
        handle.stat({ bigint: true }),
        fs.lstat(absolutePath, { bigint: true }),
        fs.realpath(absolutePath),
      ]);
      if (after.nlink !== 1n || current.nlink !== 1n) {
        throw new Error(`Review evidence artifact has multiple hard links: ${sourcePath}`);
      }
      if (
        !sameFileIdentity(openedStat, after)
        || !sameFileIdentity(openedStat, current)
        || BigInt(byteLength) !== after.size
        || currentRealPath !== absolutePath
        || !isContainedPath(await this.projectRoot, currentRealPath)
      ) {
        throw new Error(`Review evidence artifact changed while being captured: ${sourcePath}`);
      }
    } catch (error) {
      if (
        (error as Error).message.includes('changed while being captured')
        || (error as Error).message.includes('multiple hard links')
      ) throw error;
      throw new Error(`Review evidence artifact changed while being captured: ${sourcePath}`);
    }
  }

  private async captureArtifact(
    sourcePath: string,
    destinationPath: string | null,
    aggregateBytes: number,
  ): Promise<CapturedFile> {
    const source = await this.openProjectArtifact(sourcePath);
    let destination: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      if (source.openedStat.size > BigInt(MAX_ARTIFACT_BYTES)) {
        throw new Error(`Review evidence artifact exceeds the 16 MiB per-file limit: ${sourcePath}`);
      }
      if (BigInt(aggregateBytes) + source.openedStat.size > BigInt(MAX_TOTAL_BYTES)) {
        throw new Error('Review evidence bundle exceeds the 32 MiB aggregate limit.');
      }
      if (destinationPath) {
        destination = await fs.open(
          destinationPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
          0o600,
        );
      }
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let byteLength = 0;
      while (true) {
        const { bytesRead } = await source.handle.read(buffer, 0, buffer.byteLength, byteLength);
        if (bytesRead === 0) break;
        byteLength += bytesRead;
        if (byteLength > MAX_ARTIFACT_BYTES) {
          throw new Error(`Review evidence artifact exceeds the 16 MiB per-file limit: ${sourcePath}`);
        }
        if (aggregateBytes + byteLength > MAX_TOTAL_BYTES) {
          throw new Error('Review evidence bundle exceeds the 32 MiB aggregate limit.');
        }
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (destination) {
          let written = 0;
          while (written < bytesRead) {
            const result = await destination.write(chunk, written, bytesRead - written, byteLength - bytesRead + written);
            if (result.bytesWritten < 1) throw new Error(`Failed to materialize review evidence artifact: ${sourcePath}`);
            written += result.bytesWritten;
          }
          await this.config.onArtifactCopyProgress?.(sourcePath, byteLength);
        }
      }
      if (destination) {
        await destination.sync();
        const destinationStat = await destination.stat({ bigint: true });
        if (!destinationStat.isFile() || destinationStat.nlink !== 1n || destinationStat.size !== BigInt(byteLength)) {
          throw new Error(`Failed to materialize review evidence artifact: ${sourcePath}`);
        }
      }
      await this.verifyOpenedArtifact(sourcePath, source.absolutePath, source.openedStat, source.handle, byteLength);
      return { byteLength, digest: hash.digest('hex') };
    } catch (error) {
      if (destinationPath) await fs.rm(destinationPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      if (destination) await destination.close().catch(() => undefined);
      await source.handle.close().catch(() => undefined);
    }
  }

  private buildManifest(
    runId: string,
    resolutionFingerprint: string,
    kind: ReviewEvidenceBundleKind,
    items: ReviewEvidenceBundleManifestItem[],
  ): ReviewEvidenceBundleManifest {
    const fingerprints = bundleFingerprints(items);
    return {
      schemaVersion: REVIEW_EVIDENCE_BUNDLE_SCHEMA_VERSION,
      runId,
      workflow: 'dash-review',
      kind,
      resolutionFingerprint,
      ...fingerprints,
      items,
    };
  }

  private validateManifest(runId: string, value: unknown): ReviewEvidenceBundleManifest {
    if (!isRecord(value)) throw metadataError(runId);
    assertExactKeys(value, [
      'items',
      'kind',
      'materializationFingerprint',
      'runId',
      'resolutionFingerprint',
      'schemaVersion',
      'scopeFingerprint',
      'sourceFingerprint',
      'workflow',
    ], 'review evidence manifest');
    if (
      value.schemaVersion !== REVIEW_EVIDENCE_BUNDLE_SCHEMA_VERSION
      || value.runId !== runId
      || value.workflow !== 'dash-review'
      || (value.kind !== 'inline' && value.kind !== 'local-artifacts')
      || typeof value.resolutionFingerprint !== 'string'
      || !SHA256_PATTERN.test(value.resolutionFingerprint)
      || !Array.isArray(value.items)
      || typeof value.scopeFingerprint !== 'string'
      || typeof value.sourceFingerprint !== 'string'
      || typeof value.materializationFingerprint !== 'string'
    ) {
      throw metadataError(runId);
    }
    const items: ReviewEvidenceBundleManifestItem[] = [];
    const sourcePaths = new Set<string>();
    const materializedPaths = new Set<string>();
    let inlineSeen = false;
    let artifactCount = 0;
    let totalBytes = 0;
    for (const rawItem of value.items) {
      if (!isRecord(rawItem) || (rawItem.kind !== 'inline' && rawItem.kind !== 'artifact')) throw metadataError(runId);
      if (!Number.isSafeInteger(rawItem.byteLength) || Number(rawItem.byteLength) < 0 || Number(rawItem.byteLength) > MAX_ARTIFACT_BYTES) {
        throw metadataError(runId);
      }
      if (typeof rawItem.digest !== 'string' || !SHA256_PATTERN.test(rawItem.digest)) throw metadataError(runId);
      let item: ReviewEvidenceBundleManifestItem;
      if (rawItem.kind === 'inline') {
        assertExactKeys(rawItem, ['byteLength', 'digest', 'kind', 'materializedPath'], 'review evidence inline manifest item');
        if (inlineSeen || rawItem.materializedPath !== 'evidence/operator-intent.txt') throw metadataError(runId);
        inlineSeen = true;
        item = {
          kind: 'inline',
          materializedPath: 'evidence/operator-intent.txt',
          byteLength: Number(rawItem.byteLength),
          digest: rawItem.digest,
        };
      } else {
        assertExactKeys(rawItem, ['byteLength', 'digest', 'kind', 'materializedPath', 'sourcePath'], 'review evidence artifact manifest item');
        let sourcePath: string;
        try {
          sourcePath = canonicalArtifactSelector(rawItem.sourcePath);
        } catch {
          throw metadataError(runId);
        }
        if (
          sourcePaths.has(sourcePath)
          || rawItem.materializedPath !== artifactMaterializedPath(sourcePath)
        ) {
          throw metadataError(runId);
        }
        sourcePaths.add(sourcePath);
        artifactCount += 1;
        item = {
          kind: 'artifact',
          sourcePath,
          materializedPath: rawItem.materializedPath,
          byteLength: Number(rawItem.byteLength),
          digest: rawItem.digest,
        };
      }
      if (materializedPaths.has(item.materializedPath)) throw metadataError(runId);
      materializedPaths.add(item.materializedPath);
      totalBytes += item.byteLength;
      items.push(item);
    }
    if (
      items.length === 0
      || artifactCount > MAX_ARTIFACT_FILES
      || totalBytes > MAX_TOTAL_BYTES
      || (value.kind === 'inline' && (!inlineSeen || items.length !== 1))
      || (value.kind === 'local-artifacts' && (inlineSeen || artifactCount === 0))
    ) throw metadataError(runId);
    const canonicalItems = [...items].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'inline' ? -1 : 1;
      if (left.kind === 'inline' || right.kind === 'inline') return 0;
      return compareUnicodeCodePoints(left.sourcePath, right.sourcePath);
    });
    if (canonicalSerialize(items) !== canonicalSerialize(canonicalItems)) throw metadataError(runId);
    const fingerprints = bundleFingerprints(items);
    if (
      value.scopeFingerprint !== fingerprints.scopeFingerprint
      || value.sourceFingerprint !== fingerprints.sourceFingerprint
      || value.materializationFingerprint !== fingerprints.materializationFingerprint
    ) {
      throw metadataError(runId);
    }
    return {
      schemaVersion: REVIEW_EVIDENCE_BUNDLE_SCHEMA_VERSION,
      runId,
      workflow: 'dash-review',
      kind: value.kind,
      resolutionFingerprint: value.resolutionFingerprint,
      ...fingerprints,
      items,
    };
  }

  private validateMetadata(runId: string, value: unknown): ReviewEvidenceBundleMetadata {
    try {
      if (!isRecord(value) || (value.state !== 'creating' && value.state !== 'sealed')) throw metadataError(runId);
      const commonKeys = [
        'createdAt',
        'creatorAgent',
        'creatorPid',
        'creatorSessionId',
        'handoffExpiresAt',
        'kind',
        'ownershipTokenHash',
        'runId',
        'schemaVersion',
        'state',
        'workflow',
      ];
      const sealedOptionalKeys = ['ownerAgent', 'ownerPid', 'ownerRecoveryExpiresAt', 'ownerSessionId'];
      if (value.state === 'creating') assertExactKeys(value, commonKeys, 'review evidence metadata');
      else {
        const presentOptional = sealedOptionalKeys.filter((key) => value[key] !== undefined);
        assertExactKeys(value, [...commonKeys, 'manifest', 'manifestDigest', ...presentOptional], 'review evidence metadata');
      }
      if (
        value.schemaVersion !== REVIEW_EVIDENCE_BUNDLE_SCHEMA_VERSION
        || value.runId !== runId
        || value.workflow !== 'dash-review'
        || (value.kind !== 'inline' && value.kind !== 'local-artifacts')
        || typeof value.creatorAgent !== 'string'
        || !value.creatorAgent
        || typeof value.creatorSessionId !== 'string'
        || !value.creatorSessionId
        || !isSafePid(value.creatorPid)
        || typeof value.ownershipTokenHash !== 'string'
        || !SHA256_PATTERN.test(value.ownershipTokenHash)
        || !isSafeTimestamp(value.createdAt)
        || !isSafeTimestamp(value.handoffExpiresAt)
        || value.handoffExpiresAt < value.createdAt
      ) {
        throw metadataError(runId);
      }
      const base: Omit<CreatingMetadata, 'state'> = {
        schemaVersion: REVIEW_EVIDENCE_BUNDLE_SCHEMA_VERSION,
        runId,
        workflow: 'dash-review' as const,
        kind: value.kind,
        creatorAgent: value.creatorAgent,
        creatorSessionId: value.creatorSessionId,
        creatorPid: value.creatorPid,
        ownershipTokenHash: value.ownershipTokenHash,
        createdAt: value.createdAt,
        handoffExpiresAt: value.handoffExpiresAt,
      };
      if (value.state === 'creating') return { ...base, state: 'creating' };

      if (typeof value.manifestDigest !== 'string' || !SHA256_PATTERN.test(value.manifestDigest)) throw metadataError(runId);
      const manifest = this.validateManifest(runId, value.manifest);
      if (manifest.kind !== value.kind) throw metadataError(runId);
      const expectedManifestDigest = digestBytes(Buffer.from(`${canonicalSerialize(manifest)}\n`, 'utf8'));
      if (value.manifestDigest !== expectedManifestDigest) throw metadataError(runId);
      const ownerKeysPresent = [value.ownerAgent, value.ownerSessionId, value.ownerPid].filter((entry) => entry !== undefined).length;
      if (ownerKeysPresent !== 0 && ownerKeysPresent !== 3) throw metadataError(runId);
      if (ownerKeysPresent === 3 && (
        typeof value.ownerAgent !== 'string'
        || !value.ownerAgent
        || typeof value.ownerSessionId !== 'string'
        || !value.ownerSessionId
        || !isSafePid(value.ownerPid)
      )) {
        throw metadataError(runId);
      }
      if (value.ownerRecoveryExpiresAt !== undefined && (
        ownerKeysPresent !== 3
        || !isSafeTimestamp(value.ownerRecoveryExpiresAt)
      )) {
        throw metadataError(runId);
      }
      return {
        ...base,
        state: 'sealed',
        manifest,
        manifestDigest: value.manifestDigest,
        ...(ownerKeysPresent === 3 ? {
          ownerAgent: value.ownerAgent as string,
          ownerSessionId: value.ownerSessionId as string,
          ownerPid: value.ownerPid as number,
          ...(value.ownerRecoveryExpiresAt === undefined
            ? {}
            : { ownerRecoveryExpiresAt: value.ownerRecoveryExpiresAt as number }),
        } : {}),
      };
    } catch (error) {
      if ((error as Error).message.startsWith('Invalid review evidence metadata:')) throw error;
      throw metadataError(runId);
    }
  }

  private async readMetadata(root: string, runId: string): Promise<ReviewEvidenceBundleMetadata | null> {
    await this.ensureDirectory(path.join(root, METADATA_DIRECTORY));
    let bytes: Buffer;
    try {
      bytes = await this.readStableFile(
        this.metadataPathAt(root, runId),
        MAX_PRIVATE_FILE_BYTES,
        path.join(root, METADATA_DIRECTORY),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw metadataError(runId);
    }
    return this.validateMetadata(runId, parsed);
  }

  private async writeNewMetadata(root: string, metadata: CreatingMetadata): Promise<void> {
    await this.ensureDirectory(path.join(root, METADATA_DIRECTORY));
    await this.writeExclusiveFile(
      this.metadataPathAt(root, metadata.runId),
      Buffer.from(`${canonicalSerialize(metadata)}\n`, 'utf8'),
    );
  }

  private async writeMetadata(root: string, metadata: ReviewEvidenceBundleMetadata): Promise<void> {
    await this.ensureDirectory(path.join(root, METADATA_DIRECTORY));
    const metadataPath = this.metadataPathAt(root, metadata.runId);
    const temporaryPath = path.join(path.dirname(metadataPath), `.${metadata.runId}.${randomUUID()}.tmp`);
    try {
      await this.writeExclusiveFile(temporaryPath, Buffer.from(`${canonicalSerialize(metadata)}\n`, 'utf8'));
      await fs.rename(temporaryPath, metadataPath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private assertOwnershipToken(metadata: ReviewEvidenceBundleMetadata, token: string): void {
    const actual = createHash('sha256').update(token).digest();
    const expected = Buffer.from(metadata.ownershipTokenHash, 'hex');
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new Error('Invalid review evidence ownership token.');
    }
  }

  private assertCreatorCaller(metadata: ReviewEvidenceBundleMetadata, caller: ReviewEvidenceBundleCaller): void {
    this.assertCaller(caller, 'creator');
    if (
      metadata.creatorAgent !== caller.agent
      || metadata.creatorSessionId !== caller.sessionId
      || metadata.creatorPid !== caller.pid
    ) {
      throw new Error('Review evidence creator capability was denied.');
    }
  }

  private assertOwnerCaller(
    metadata: SealedMetadata,
    caller: ReviewEvidenceBundleCaller,
    requirePid: boolean,
  ): void {
    this.assertCaller(caller, 'primary');
    if (
      metadata.ownerAgent !== caller.agent
      || metadata.ownerSessionId !== caller.sessionId
      || (requirePid && metadata.ownerPid !== caller.pid)
    ) {
      throw new Error('Review evidence owner capability was denied.');
    }
  }

  private assertActiveAuthorization(metadata: SealedMetadata): void {
    if (metadata.ownerSessionId) {
      if (metadata.ownerRecoveryExpiresAt !== undefined && this.now >= metadata.ownerRecoveryExpiresAt) {
        throw new Error('Review evidence owner recovery lease has expired.');
      }
      return;
    }
    if (this.now >= metadata.handoffExpiresAt) throw new Error('Review evidence handoff lease has expired.');
  }

  private async resolveWorkspace(root: string, runId: string, required: boolean): Promise<string | null> {
    const workspacePath = this.workspacePathAt(root, runId);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(workspacePath);
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(workspacePath) !== workspacePath) {
      throw new Error(`Review evidence workspace is not a contained real directory: ${runId}`);
    }
    return workspacePath;
  }

  private async hashBundleFile(filePath: string, containmentRoot: string): Promise<CapturedFile> {
    const before = await fs.lstat(filePath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) throw new Error('bundle file is not regular');
    if (before.nlink !== 1n) throw new Error('bundle file has multiple hard links');
    if (before.size > BigInt(MAX_ARTIFACT_BYTES)) throw new Error('bundle file exceeds its bound');
    const beforeRealPath = await fs.realpath(filePath);
    if (!isContainedPath(containmentRoot, beforeRealPath) || beforeRealPath !== filePath) {
      throw new Error('bundle file escapes evidence directory');
    }
    const handle = await fs.open(filePath, constants.O_RDONLY | NO_FOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.nlink !== 1n) throw new Error('bundle file has multiple hard links');
      if (!opened.isFile() || !sameFileIdentity(before, opened)) throw new Error('bundle file changed before hashing');
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let byteLength = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, byteLength);
        if (bytesRead === 0) break;
        byteLength += bytesRead;
        if (byteLength > MAX_ARTIFACT_BYTES) throw new Error('bundle file exceeds its bound');
        hash.update(buffer.subarray(0, bytesRead));
      }
      const [after, current, currentRealPath] = await Promise.all([
        handle.stat({ bigint: true }),
        fs.lstat(filePath, { bigint: true }),
        fs.realpath(filePath),
      ]);
      if (after.nlink !== 1n || current.nlink !== 1n) throw new Error('bundle file has multiple hard links');
      if (
        !sameFileIdentity(opened, after)
        || !sameFileIdentity(opened, current)
        || BigInt(byteLength) !== after.size
        || currentRealPath !== filePath
        || !isContainedPath(containmentRoot, currentRealPath)
      ) {
        throw new Error('bundle file changed while hashing');
      }
      return { byteLength, digest: hash.digest('hex') };
    } finally {
      await handle.close();
    }
  }

  private async assertBundleIntegrity(root: string, metadata: SealedMetadata): Promise<string> {
    try {
      const workspacePath = await this.resolveWorkspace(root, metadata.runId, true);
      const workspaceEntries = (await fs.readdir(workspacePath!, { withFileTypes: true }))
        .map((entry) => entry.name)
        .sort(compareUnicodeCodePoints);
      if (canonicalSerialize(workspaceEntries) !== canonicalSerialize(['evidence', 'manifest.json'])) {
        throw new Error('unexpected workspace entries');
      }
      const evidencePath = path.join(workspacePath!, 'evidence');
      const evidenceStat = await fs.lstat(evidencePath);
      if (evidenceStat.isSymbolicLink() || !evidenceStat.isDirectory() || await fs.realpath(evidencePath) !== evidencePath) {
        throw new Error('evidence path is not a real directory');
      }
      const expectedNames = metadata.manifest.items
        .map((item) => path.posix.basename(item.materializedPath))
        .sort(compareUnicodeCodePoints);
      const actualNames = (await fs.readdir(evidencePath, { withFileTypes: true }))
        .map((entry) => entry.name)
        .sort(compareUnicodeCodePoints);
      if (canonicalSerialize(actualNames) !== canonicalSerialize(expectedNames)) {
        throw new Error('unexpected evidence entries');
      }
      const expectedManifestBytes = Buffer.from(`${canonicalSerialize(metadata.manifest)}\n`, 'utf8');
      const actualManifestBytes = await this.readStableFile(
        path.join(workspacePath!, 'manifest.json'),
        MAX_PRIVATE_FILE_BYTES,
        workspacePath!,
      );
      if (
        digestBytes(actualManifestBytes) !== metadata.manifestDigest
        || !actualManifestBytes.equals(expectedManifestBytes)
      ) {
        throw new Error('manifest changed');
      }
      for (const item of metadata.manifest.items) {
        const materializedPath = path.join(workspacePath!, ...item.materializedPath.split('/'));
        const actual = await this.hashBundleFile(materializedPath, evidencePath);
        if (actual.byteLength !== item.byteLength || actual.digest !== item.digest) {
          throw new Error(`materialized evidence changed: ${item.materializedPath}`);
        }
      }
      return workspacePath!;
    } catch (error) {
      throw new Error(`Review evidence bundle integrity check failed for ${metadata.runId}: ${(error as Error).message}`);
    }
  }

  private async assertLiveSources(metadata: SealedMetadata): Promise<void> {
    let aggregateBytes = 0;
    for (const item of metadata.manifest.items) {
      if (item.kind !== 'artifact') continue;
      let current: CapturedFile;
      try {
        current = await this.captureArtifact(item.sourcePath, null, aggregateBytes);
      } catch (error) {
        throw new Error(`Review evidence live source drift detected for ${item.sourcePath}: ${(error as Error).message}`);
      }
      aggregateBytes += current.byteLength;
      if (current.byteLength !== item.byteLength || current.digest !== item.digest) {
        throw new Error(`Review evidence live source drift detected for ${item.sourcePath}.`);
      }
    }
  }

  private authorizationRecovery(metadata: SealedMetadata, workspacePath: string): ReviewEvidenceBundleAuthorizationRecovery {
    return {
      runId: metadata.runId,
      workspacePath,
      workflow: metadata.workflow,
      resolutionFingerprint: metadata.manifest.resolutionFingerprint,
      creatorAgent: metadata.creatorAgent,
      creatorSessionId: metadata.creatorSessionId,
      creatorPid: metadata.creatorPid,
      ...(metadata.ownerAgent ? {
        ownerAgent: metadata.ownerAgent,
        ownerSessionId: metadata.ownerSessionId,
        ownerPid: metadata.ownerPid,
        ...(metadata.ownerRecoveryExpiresAt === undefined
          ? {}
          : { ownerRecoveryExpiresAt: metadata.ownerRecoveryExpiresAt }),
      } : {}),
    };
  }

  async captureArtifacts(sourcePaths: readonly string[]): Promise<ReviewEvidenceBundleArtifactCapture[]> {
    const { items } = this.canonicalizeInputs(sourcePaths.map((sourcePath) => ({ kind: 'artifact', sourcePath })));
    const captures: ReviewEvidenceBundleArtifactCapture[] = [];
    let aggregateBytes = 0;
    for (const item of items) {
      if (item.kind !== 'artifact') throw new Error('Review evidence artifact capture accepts only artifact items.');
      const captured = await this.captureArtifact(item.sourcePath, null, aggregateBytes);
      aggregateBytes += captured.byteLength;
      captures.push({ sourcePath: item.sourcePath, ...captured });
    }
    return captures;
  }

  async ownsRun(runId: string): Promise<boolean> {
    this.assertRunId(runId);
    const root = await this.inspectRuntimeRoot(false);
    if (!root) return false;
    return (await this.readMetadata(root, runId)) !== null
      || (await this.resolveWorkspace(root, runId, false)) !== null;
  }

  async create(options: ReviewEvidenceBundleCreateOptions): Promise<ReviewEvidenceBundleInfo> {
    this.assertRunId(options.runId);
    this.assertCaller(options.caller, 'creator');
    if (!SHA256_PATTERN.test(options.resolutionFingerprint)) {
      throw new Error('Review evidence resolution fingerprint must be a SHA-256 digest.');
    }
    const canonicalBundle = this.canonicalizeInputs(options.items);
    const root = await this.ensureRuntimeRoot();
    await this.cleanupExpiredAtRoot(root, this.startupSweepLimit);
    const lock = await this.acquireRunLock(root, options.runId);
    const workspacePath = this.workspacePathAt(root, options.runId);
    const evidencePath = path.join(workspacePath, 'evidence');
    let metadataWritten = false;
    let workspaceCreated = false;
    try {
      if (await this.readMetadata(root, options.runId)) throw new Error(`Review evidence bundle already exists: ${options.runId}`);
      try {
        await fs.lstat(workspacePath);
        throw new Error(`Review evidence bundle already exists: ${options.runId}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const ownershipToken = randomUUID();
      const createdAt = this.now;
      const creatingMetadata: CreatingMetadata = {
        schemaVersion: REVIEW_EVIDENCE_BUNDLE_SCHEMA_VERSION,
        state: 'creating',
        runId: options.runId,
        workflow: 'dash-review',
        kind: canonicalBundle.kind,
        creatorAgent: options.caller.agent,
        creatorSessionId: options.caller.sessionId,
        creatorPid: options.caller.pid,
        ownershipTokenHash: digestBytes(Buffer.from(ownershipToken, 'utf8')),
        createdAt,
        handoffExpiresAt: createdAt + this.handoffMs,
      };
      await this.writeNewMetadata(root, creatingMetadata);
      metadataWritten = true;
      await fs.mkdir(workspacePath, { mode: 0o700 });
      workspaceCreated = true;
      await fs.mkdir(evidencePath, { mode: 0o700 });

      const manifestItems: ReviewEvidenceBundleManifestItem[] = [];
      let aggregateBytes = 0;
      for (const item of canonicalBundle.items) {
        if (item.kind === 'inline') {
          if (aggregateBytes + item.bytes.byteLength > MAX_TOTAL_BYTES) {
            throw new Error('Review evidence bundle exceeds the 32 MiB aggregate limit.');
          }
          const materializedPath = 'evidence/operator-intent.txt' as const;
          await this.writeExclusiveFile(path.join(workspacePath, ...materializedPath.split('/')), item.bytes);
          aggregateBytes += item.bytes.byteLength;
          manifestItems.push({
            kind: 'inline',
            materializedPath,
            byteLength: item.bytes.byteLength,
            digest: digestBytes(item.bytes),
          });
          continue;
        }
        const materializedPath = artifactMaterializedPath(item.sourcePath);
        const captured = await this.captureArtifact(
          item.sourcePath,
          path.join(workspacePath, ...materializedPath.split('/')),
          aggregateBytes,
        );
        aggregateBytes += captured.byteLength;
        manifestItems.push({
          kind: 'artifact',
          sourcePath: item.sourcePath,
          materializedPath,
          ...captured,
        });
      }
      const manifest = this.buildManifest(
        options.runId,
        options.resolutionFingerprint,
        canonicalBundle.kind,
        manifestItems,
      );
      const manifestBytes = Buffer.from(`${canonicalSerialize(manifest)}\n`, 'utf8');
      await this.writeExclusiveFile(path.join(workspacePath, 'manifest.json'), manifestBytes);
      const sealedMetadata: SealedMetadata = {
        ...creatingMetadata,
        state: 'sealed',
        manifest,
        manifestDigest: digestBytes(manifestBytes),
      };
      await this.writeMetadata(root, sealedMetadata);
      return {
        runId: options.runId,
        workspacePath,
        ownershipToken,
        kind: manifest.kind,
        resolutionFingerprint: manifest.resolutionFingerprint,
        scopeFingerprint: manifest.scopeFingerprint,
        sourceFingerprint: manifest.sourceFingerprint,
        materializationFingerprint: manifest.materializationFingerprint,
        items: manifest.items,
      };
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (workspaceCreated) {
        await fs.rm(workspacePath, { recursive: true, force: true })
          .catch((rollbackError) => rollbackErrors.push(`workspace: ${(rollbackError as Error).message}`));
      }
      if (metadataWritten) {
        await fs.rm(this.metadataPathAt(root, options.runId), { force: true })
          .catch((rollbackError) => rollbackErrors.push(`metadata: ${(rollbackError as Error).message}`));
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`${(error as Error).message}; review evidence rollback failed: ${rollbackErrors.join('; ')}`);
      }
      throw error;
    } finally {
      await this.releaseRunLock(lock);
    }
  }

  async claim(runId: string, ownershipToken: string, caller: ReviewEvidenceBundleCaller): Promise<void> {
    this.assertRunId(runId);
    this.assertCaller(caller, 'primary');
    const root = await this.inspectRuntimeRoot(true);
    const lock = await this.acquireRunLock(root!, runId);
    try {
      const metadata = await this.readMetadata(root!, runId);
      if (!metadata) throw new Error(`Review evidence bundle not found: ${runId}`);
      if (metadata.state !== 'sealed') throw metadataError(runId);
      this.assertOwnershipToken(metadata, ownershipToken);
      if (metadata.workflow !== caller.workflow) throw new Error('Review evidence workflow claim was denied.');
      this.assertActiveAuthorization(metadata);
      if (metadata.ownerSessionId) {
        if (metadata.ownerAgent !== caller.agent || metadata.ownerSessionId !== caller.sessionId) {
          throw new Error('Review evidence bundle is already claimed by another owner.');
        }
        if (metadata.ownerPid !== caller.pid && this.isProcessAlive(metadata.ownerPid!)) {
          throw new Error('Review evidence bundle is already claimed by a live owner process.');
        }
      }
      await this.assertBundleIntegrity(root!, metadata);
      metadata.ownerAgent = caller.agent;
      metadata.ownerSessionId = caller.sessionId;
      metadata.ownerPid = caller.pid;
      delete metadata.ownerRecoveryExpiresAt;
      await this.writeMetadata(root!, metadata);
    } finally {
      await this.releaseRunLock(lock);
    }
  }

  async recoverAuthorization(
    runId: string,
    ownershipToken: string,
    workflow: ReviewEvidenceBundleWorkflow,
  ): Promise<ReviewEvidenceBundleAuthorizationRecovery> {
    this.assertRunId(runId);
    if (workflow !== 'dash-review') throw new Error('Review evidence workflow recovery was denied.');
    const root = await this.inspectRuntimeRoot(true);
    const lock = await this.acquireRunLock(root!, runId);
    try {
      const metadata = await this.readMetadata(root!, runId);
      if (!metadata || metadata.state !== 'sealed') throw metadataError(runId);
      this.assertOwnershipToken(metadata, ownershipToken);
      this.assertActiveAuthorization(metadata);
      const workspacePath = await this.assertBundleIntegrity(root!, metadata);
      return this.authorizationRecovery(metadata, workspacePath);
    } finally {
      await this.releaseRunLock(lock);
    }
  }

  async recoverOwnerAuthorization(
    runId: string,
    ownershipToken: string,
    caller: ReviewEvidenceBundleCaller,
  ): Promise<ReviewEvidenceBundleAuthorizationRecovery> {
    this.assertRunId(runId);
    this.assertCaller(caller, 'primary');
    const root = await this.inspectRuntimeRoot(true);
    const lock = await this.acquireRunLock(root!, runId);
    try {
      const metadata = await this.readMetadata(root!, runId);
      if (!metadata || metadata.state !== 'sealed') throw metadataError(runId);
      this.assertOwnershipToken(metadata, ownershipToken);
      this.assertOwnerCaller(metadata, caller, false);
      this.assertActiveAuthorization(metadata);
      if (metadata.ownerPid !== caller.pid && this.isProcessAlive(metadata.ownerPid!)) {
        throw new Error('Review evidence bundle is already claimed by a live owner process.');
      }
      const workspacePath = await this.assertBundleIntegrity(root!, metadata);
      metadata.ownerPid = caller.pid;
      delete metadata.ownerRecoveryExpiresAt;
      await this.writeMetadata(root!, metadata);
      return this.authorizationRecovery(metadata, workspacePath);
    } finally {
      await this.releaseRunLock(lock);
    }
  }

  async inspect(
    runId: string,
    ownershipToken: string,
    caller: ReviewEvidenceBundleCaller,
  ): Promise<ReviewEvidenceBundleInspection> {
    this.assertRunId(runId);
    const root = await this.inspectRuntimeRoot(true);
    const lock = await this.acquireRunLock(root!, runId);
    try {
      const metadata = await this.readMetadata(root!, runId);
      if (!metadata) throw new Error(`Review evidence bundle not found: ${runId}`);
      if (metadata.state !== 'sealed') throw metadataError(runId);
      this.assertOwnershipToken(metadata, ownershipToken);
      this.assertOwnerCaller(metadata, caller, true);
      this.assertActiveAuthorization(metadata);
      const workspacePath = await this.assertBundleIntegrity(root!, metadata);
      await this.assertLiveSources(metadata);
      return {
        runId,
        workspacePath,
        manifest: metadata.manifest,
        integrity: { bundleClean: true, sourcesClean: true },
      };
    } finally {
      await this.releaseRunLock(lock);
    }
  }

  private async removeRunState(root: string, runId: string): Promise<void> {
    const workspace = await this.resolveWorkspace(root, runId, false);
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(this.metadataPathAt(root, runId), { force: true });
  }

  private async cleanupWithPolicy(
    runId: string,
    ownershipToken: string,
    caller: ReviewEvidenceBundleCaller,
    requireExisting: boolean,
  ): Promise<ReviewEvidenceBundleCleanupResult> {
    this.assertRunId(runId);
    const projectRoot = await this.projectRoot;
    const root = await this.inspectRuntimeRoot(false);
    const expectedWorkspacePath = path.join(projectRoot, ...ROOT_COMPONENTS, runId);
    if (!root) {
      if (requireExisting) throw new Error(`Review evidence bundle not found: ${runId}`);
      return { runId, workspacePath: expectedWorkspacePath, cleaned: true };
    }
    const initialMetadata = await this.readMetadata(root, runId);
    const initialWorkspace = await this.resolveWorkspace(root, runId, false);
    if (!initialMetadata) {
      if (initialWorkspace) throw new Error(`Review evidence bundle ${runId} has no private metadata; preserved.`);
      if (requireExisting) throw new Error(`Review evidence bundle not found: ${runId}`);
      return { runId, workspacePath: expectedWorkspacePath, cleaned: true };
    }
    const lock = await this.acquireRunLock(root, runId);
    try {
      const metadata = await this.readMetadata(root, runId);
      if (!metadata) {
        if (requireExisting) throw new Error(`Review evidence bundle not found: ${runId}`);
        return { runId, workspacePath: expectedWorkspacePath, cleaned: true };
      }
      this.assertOwnershipToken(metadata, ownershipToken);
      if (metadata.state === 'sealed' && metadata.ownerSessionId) this.assertOwnerCaller(metadata, caller, true);
      else this.assertCreatorCaller(metadata, caller);
      await this.removeRunState(root, runId);
      return { runId, workspacePath: expectedWorkspacePath, cleaned: true };
    } finally {
      await this.releaseRunLock(lock);
    }
  }

  async cleanup(
    runId: string,
    ownershipToken: string,
    caller: ReviewEvidenceBundleCaller,
  ): Promise<ReviewEvidenceBundleCleanupResult> {
    return this.cleanupWithPolicy(runId, ownershipToken, caller, false);
  }

  async cleanupExisting(
    runId: string,
    ownershipToken: string,
    caller: ReviewEvidenceBundleCaller,
  ): Promise<ReviewEvidenceBundleCleanupResult> {
    return this.cleanupWithPolicy(runId, ownershipToken, caller, true);
  }

  async cleanupOwnedBySession(sessionId: string): Promise<ReviewEvidenceBundleCleanupResult[]> {
    if (!sessionId) throw new Error('Review evidence session ID is required.');
    const root = await this.inspectRuntimeRoot(false);
    if (!root) return [];
    const results: ReviewEvidenceBundleCleanupResult[] = [];
    for (const runId of await this.listRunIds(root, Number.POSITIVE_INFINITY)) {
      const lock = await this.acquireRunLock(root, runId);
      try {
        const metadata = await this.readMetadata(root, runId);
        if (!metadata) continue;
        const owned = metadata.state === 'sealed' && metadata.ownerSessionId !== undefined
          ? metadata.ownerSessionId === sessionId
          : metadata.creatorSessionId === sessionId;
        if (!owned) continue;
        const workspacePath = this.workspacePathAt(root, runId);
        await this.removeRunState(root, runId);
        results.push({ runId, workspacePath, cleaned: true });
      } finally {
        await this.releaseRunLock(lock);
      }
    }
    return results;
  }

  private async listRunIds(root: string, limit: number): Promise<string[]> {
    const runIds = new Set<string>();
    const scanDirectory = async (
      directoryPath: string,
      select: (name: string) => string | null,
    ): Promise<void> => {
      let directory: Awaited<ReturnType<typeof fs.opendir>>;
      try {
        directory = await fs.opendir(directoryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      let scanned = 0;
      const scanBound = Number.isFinite(limit) ? (limit * 4) + 16 : Number.POSITIVE_INFINITY;
      try {
        for await (const entry of directory) {
          scanned += 1;
          const runId = select(entry.name);
          if (runId && isSafeRunId(runId)) runIds.add(runId);
          if (scanned >= scanBound || runIds.size >= limit) break;
        }
      } finally {
        try {
          await directory.close();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
        }
      }
    };
    await scanDirectory(root, (name) => name.startsWith('.') ? null : name);
    if (runIds.size < limit) {
      await scanDirectory(path.join(root, METADATA_DIRECTORY), (name) => name.endsWith('.json') ? name.slice(0, -5) : null);
    }
    if (runIds.size < limit) {
      await scanDirectory(path.join(root, LOCK_DIRECTORY), (name) => {
        if (!name.endsWith(LOCK_SUFFIX) || name.endsWith(`${LOCK_SUFFIX}${RECOVERY_SUFFIX}`)) return null;
        return name.slice(0, -LOCK_SUFFIX.length);
      });
    }
    return [...runIds].sort(compareUnicodeCodePoints).slice(0, limit);
  }

  private async recoverExpiredRun(root: string, runId: string): Promise<void> {
    let lock: HeldLock;
    try {
      lock = await this.acquireRunLock(root, runId);
    } catch (error) {
      if ((error as Error).message.includes('busy')) return;
      throw error;
    }
    try {
      const metadata = await this.readMetadata(root, runId);
      if (!metadata) {
        const orphanWorkspace = await this.resolveWorkspace(root, runId, false);
        if (orphanWorkspace) await fs.rm(orphanWorkspace, { recursive: true, force: true });
        return;
      }
      if (metadata.state === 'creating') {
        if (this.isProcessAlive(metadata.creatorPid) && this.now < metadata.handoffExpiresAt) return;
        await this.removeRunState(root, runId);
        return;
      }
      if (metadata.ownerPid !== undefined) {
        if (metadata.ownerRecoveryExpiresAt !== undefined) {
          if (this.now < metadata.ownerRecoveryExpiresAt) return;
          await this.removeRunState(root, runId);
          return;
        }
        if (this.isProcessAlive(metadata.ownerPid)) return;
        metadata.ownerRecoveryExpiresAt = this.now + this.handoffMs;
        await this.writeMetadata(root, metadata);
        return;
      }
      if (this.isProcessAlive(metadata.creatorPid) && this.now < metadata.handoffExpiresAt) return;
      await this.removeRunState(root, runId);
    } finally {
      await this.releaseRunLock(lock);
    }
  }

  private async cleanupExpiredAtRoot(root: string, limit: number): Promise<void> {
    await this.ensureDirectory(path.join(root, METADATA_DIRECTORY));
    await this.ensureDirectory(path.join(root, LOCK_DIRECTORY));
    const runIds = await this.listRunIds(root, limit);
    for (const runId of runIds) {
      try {
        await this.recoverExpiredRun(root, runId);
      } catch (error) {
        this.config.onSweepError?.(runId, error as Error);
      }
    }
  }

  async cleanupExpired(): Promise<void> {
    const root = await this.inspectRuntimeRoot(false);
    if (!root) return;
    await this.cleanupExpiredAtRoot(root, Number.POSITIVE_INFINITY);
  }
}
