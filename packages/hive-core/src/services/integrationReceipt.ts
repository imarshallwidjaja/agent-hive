/**
 * Integration receipts: immutable links from a commit a Hive worktree merge
 * produced to the feature task or ad-hoc run (and its Worklog) that produced
 * the integrated work.
 *
 * One receipt per applied integration lives at
 * `.hive/provenance/integrations/<afterCommit>.json`, keyed by the final
 * resulting commit. A receipt is written once and never rewritten: an existing
 * receipt with the same content (ignoring `recordedAt`) counts as recorded and a
 * different one is a failure. `origin` names only the integrating worker.
 * Squash and rebase rewrite source history, so their receipts list in
 * `replaced` the rewritten commits that have receipts of their own; a reader
 * follows those links. A normal merge keeps the source commits reachable and
 * writes no `replaced`. Receipts are advisory: a missing receipt never blocks an
 * integration, and a receipt that fails to record makes the merge skip the
 * requested same-call cleanup so the source placement is retained. They are not
 * a run ledger.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import type { SimpleGit } from 'simple-git';
import { isNativeObservationOwner } from '../native-observations.js';
import { writeAtomicDurableExclusive } from '../utils/paths.js';
import { getWorklogKey } from './worklogService.js';
import type { WorklogAuthor, WorklogRef } from './worklogService.js';
import { assertNoSymlinkComponents } from './worktreeLinkage.js';
import type { IntegrationStrategy } from './worktreeIntegration.js';

const FULL_COMMIT = /^[0-9a-f]{40,64}$/;
const RECEIPT_FILE = /^([0-9a-f]{40,64})\.json$/;

/** The worker whose work an integration carried. */
export type IntegrationOrigin =
  | { kind: 'task'; feature: string; task: string; candidate?: string }
  | { kind: 'adhoc'; runId: string; worklog?: WorklogRef };

export interface IntegrationReceipt {
  schemaVersion: 1;
  /** The final commit the integration produced; the receipt's key. */
  after: string;
  /** The destination HEAD before the integration. */
  before: string;
  /** The pinned source commit that was integrated. */
  source: string;
  targetRef: string | null;
  strategy: IntegrationStrategy;
  /** The integrating worker's origin. */
  origin: IntegrationOrigin;
  /**
   * Squash and rebase only: commits in `before..source` that had a receipt when
   * this one was written, in rev-list order, possibly empty, excluding this
   * integration's own resulting commit (`after`). Their receipts describe work
   * this commit replaced. Absent for a normal merge.
   */
  replaced?: string[];
  integratedBy?: WorklogAuthor;
  recordedAt: string;
}

export type IntegrationProvenanceOutcome =
  | { status: 'recorded'; path: string }
  | { status: 'failed'; error: string };

/** What an applied integration hands its recorder. */
export interface AppliedIntegration {
  git: SimpleGit;
  before: string;
  after: string;
  source: string;
  targetRef: string | null;
  strategy: IntegrationStrategy;
}

export type IntegrationRecorder = (applied: AppliedIntegration) => Promise<IntegrationProvenanceOutcome>;

export type IntegrationReceiptErrorReason = 'invalid_commit' | 'corrupt';

/** A receipt that cannot be named or parsed. I/O and unsafe-path errors propagate as thrown by the file system or linkage check. */
export class IntegrationReceiptError extends Error {
  readonly reason: IntegrationReceiptErrorReason;

  constructor(reason: IntegrationReceiptErrorReason, message: string) {
    super(message);
    this.name = 'IntegrationReceiptError';
    this.reason = reason;
  }
}

export function integrationReceiptsDirectory(hiveDir: string): string {
  return path.join(hiveDir, 'provenance', 'integrations');
}

export function integrationReceiptPath(hiveDir: string, commit: string): string {
  if (typeof commit !== 'string' || !FULL_COMMIT.test(commit)) {
    throw new IntegrationReceiptError('invalid_commit', `Integration receipts are keyed by a full commit ID, not ${JSON.stringify(commit)}`);
  }
  return path.join(integrationReceiptsDirectory(hiveDir), `${commit}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The Worklog an ad-hoc run's stored `origin` names, or undefined when it is
 * missing or malformed. Stored origins are read tolerantly: a bad one never
 * makes a worker unreadable, it only leaves the receipt with a bare run ID.
 */
export function storedAdhocWorklog(origin: unknown): WorklogRef | undefined {
  const worklog = isRecord(origin) ? origin.worklog : undefined;
  if (!isRecord(worklog)) return undefined;
  try {
    getWorklogKey(worklog as WorklogRef);
  } catch {
    return undefined;
  }
  return worklog.kind === 'feature'
    ? { kind: 'feature', featureName: worklog.featureName as string }
    : { kind: 'session', owner: worklog.owner as Extract<WorklogRef, { kind: 'session' }>['owner'], sessionId: worklog.sessionId as string };
}

function isOrigin(value: unknown): value is IntegrationOrigin {
  if (!isRecord(value)) return false;
  if (value.kind === 'task') {
    return typeof value.feature === 'string' && typeof value.task === 'string'
      && (value.candidate === undefined || typeof value.candidate === 'string');
  }
  if (value.kind === 'adhoc') {
    return typeof value.runId === 'string' && (value.worklog === undefined || storedAdhocWorklog({ worklog: value.worklog }) !== undefined);
  }
  return false;
}

function isAuthor(value: unknown): value is WorklogAuthor {
  return isRecord(value) && isNativeObservationOwner(value.owner)
    && typeof value.sessionId === 'string' && typeof value.agent === 'string';
}

function parseReceipt(value: unknown, filePath: string, commit: string): IntegrationReceipt {
  const corrupt = (detail: string) => new IntegrationReceiptError('corrupt', `Invalid integration receipt ${filePath}: ${detail}`);
  if (!isRecord(value) || value.schemaVersion !== 1) throw corrupt('unsupported schema');
  if (value.after !== commit) throw corrupt('its commit does not match its file name');
  for (const field of ['before', 'source'] as const) {
    if (typeof value[field] !== 'string' || !FULL_COMMIT.test(value[field] as string)) throw corrupt(`${field} is not a full commit ID`);
  }
  if (value.targetRef !== null && typeof value.targetRef !== 'string') throw corrupt('targetRef is malformed');
  if (value.strategy !== 'merge' && value.strategy !== 'squash' && value.strategy !== 'rebase') throw corrupt('unknown strategy');
  if (!isOrigin(value.origin)) throw corrupt('origin is malformed');
  if (value.replaced !== undefined && (!Array.isArray(value.replaced) || !value.replaced.every((commit) => typeof commit === 'string' && FULL_COMMIT.test(commit)))) {
    throw corrupt('replaced is malformed');
  }
  if (value.integratedBy !== undefined && !isAuthor(value.integratedBy)) throw corrupt('integratedBy is malformed');
  if (typeof value.recordedAt !== 'string') throw corrupt('recordedAt is malformed');
  return value as unknown as IntegrationReceipt;
}

/**
 * Read the receipt of one commit. Undefined when there is none; an invalid
 * commit ID or a malformed receipt throws `IntegrationReceiptError`, and an
 * unreadable file or symlinked path component throws its own error.
 */
export async function readIntegrationReceipt(hiveDir: string, commit: string): Promise<IntegrationReceipt | undefined> {
  const filePath = integrationReceiptPath(hiveDir, commit);
  await assertNoSymlinkComponents(path.parse(filePath).root, filePath, true);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new IntegrationReceiptError('corrupt', `Invalid JSON in integration receipt ${filePath}: ${(error as Error).message}`);
  }
  return parseReceipt(value, filePath, commit);
}

/**
 * Full commit IDs that have a receipt file, from one listing of the receipt
 * directory, sorted. Empty when the directory does not exist. File names are
 * matched only; the receipts are not opened, so a corrupt one is still listed.
 * A symlinked path component throws.
 */
export async function listIntegrationReceiptCommits(hiveDir: string): Promise<string[]> {
  const directory = integrationReceiptsDirectory(hiveDir);
  await assertNoSymlinkComponents(path.parse(directory).root, directory, true);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.flatMap((name) => RECEIPT_FILE.exec(name)?.[1] ?? []).sort();
}

/**
 * Commits in `before..source` that have a receipt, in rev-list order: the
 * receipted work a squash or rebase rewrote into this integration's commit.
 * The integration's own commit is never listed: a rebase that reproduces the
 * source commit would otherwise link the receipt to itself.
 */
async function replacedReceiptCommits(hiveDir: string, applied: AppliedIntegration): Promise<string[]> {
  const recorded = new Set(await listIntegrationReceiptCommits(hiveDir));
  if (recorded.size === 0) return [];
  const range = (await applied.git.raw(['rev-list', `${applied.before}..${applied.source}`])).split('\n').filter(Boolean);
  return range.filter((commit) => commit !== applied.after && recorded.has(commit));
}

/** Receipt content as stored JSON, without `recordedAt`, for the write-once comparison. */
function receiptIdentity(receipt: IntegrationReceipt): unknown {
  const { recordedAt: _recordedAt, ...rest } = receipt;
  return JSON.parse(JSON.stringify(rest));
}

/** Message text for any thrown value; never throws itself. */
export function describeReceiptError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unprintable error value';
  }
}

/**
 * Write the receipt of one applied integration. Never throws: every failure,
 * including a different receipt already at the same commit, is a `failed`
 * outcome, and nothing partial is written. The file is published without
 * replacing an existing one; when one exists, identical content (ignoring
 * `recordedAt`) counts as recorded and the existing file is kept either way.
 */
export async function recordIntegrationReceipt(
  hiveDir: string,
  applied: AppliedIntegration,
  origin: IntegrationOrigin,
  integratedBy?: WorklogAuthor,
): Promise<IntegrationProvenanceOutcome> {
  try {
    const filePath = integrationReceiptPath(hiveDir, applied.after);
    for (const field of ['before', 'source'] as const) {
      if (!FULL_COMMIT.test(applied[field])) throw new IntegrationReceiptError('invalid_commit', `${field} ${JSON.stringify(applied[field])} is not a full commit ID`);
    }
    await assertNoSymlinkComponents(path.parse(filePath).root, filePath, true);
    const receipt: IntegrationReceipt = {
      schemaVersion: 1,
      after: applied.after,
      before: applied.before,
      source: applied.source,
      targetRef: applied.targetRef,
      strategy: applied.strategy,
      origin,
      ...(applied.strategy !== 'merge' ? { replaced: await replacedReceiptCommits(hiveDir, applied) } : {}),
      ...(integratedBy !== undefined ? { integratedBy } : {}),
      recordedAt: new Date().toISOString(),
    };
    if (writeAtomicDurableExclusive(filePath, JSON.stringify(receipt, null, 2))) return { status: 'recorded', path: filePath };
    const existing = await readIntegrationReceipt(hiveDir, applied.after);
    if (!existing) throw new Error(`Integration receipt ${filePath} existed when it was published but not when it was read`);
    if (isDeepStrictEqual(receiptIdentity(existing), receiptIdentity(receipt))) return { status: 'recorded', path: filePath };
    return { status: 'failed', error: `A different integration receipt already exists at ${filePath}; it was kept unchanged` };
  } catch (error) {
    return { status: 'failed', error: describeReceiptError(error) };
  }
}

export function integrationRecorder(hiveDir: string, origin: IntegrationOrigin, integratedBy?: WorklogAuthor): IntegrationRecorder {
  return (applied) => recordIntegrationReceipt(hiveDir, applied, origin, integratedBy);
}

/** The cleanup a composite integration skips because a repository's receipt failed. */
export interface ProvenanceCleanupFailure {
  repoId: string;
  step: string;
  cause: string;
}

/**
 * Composite provenance, in `repoIds` order. `provenance` is failed when any
 * repository's receipt failed, naming each; otherwise the first applied
 * repository's recorded outcome, as `sha` names the first applied repository's
 * commit; undefined when no repository applied an integration.
 * `cleanupFailure` names the first repository whose receipt failed, as the
 * skipped-cleanup cause that keeps the whole workspace.
 */
export function aggregateIntegrationProvenance(
  repoIds: readonly string[],
  repos: Record<string, { provenance?: IntegrationProvenanceOutcome }>,
): { provenance?: IntegrationProvenanceOutcome; cleanupFailure?: ProvenanceCleanupFailure } {
  const failed = repoIds.flatMap((repoId) => {
    const provenance = repos[repoId]?.provenance;
    return provenance?.status === 'failed' ? [{ repoId, error: provenance.error }] : [];
  });
  if (failed.length > 0) {
    const first = failed[0]!;
    return {
      provenance: { status: 'failed', error: failed.map(({ repoId, error }) => `${repoId}: ${error}`).join('; ') },
      cleanupFailure: { repoId: first.repoId, ...provenanceCleanupSkip(first.error) },
    };
  }
  const provenance = repoIds.map((repoId) => repos[repoId]?.provenance).find((outcome) => outcome !== undefined);
  return provenance !== undefined ? { provenance } : {};
}

/** The skipped-cleanup cause when a repository's receipt failed. */
export function provenanceCleanupSkip(error: string): { step: string; cause: string } {
  return {
    step: 'provenance',
    cause: `The integration receipt was not recorded, so cleanup was skipped to keep the source for association: ${error}`,
  };
}
