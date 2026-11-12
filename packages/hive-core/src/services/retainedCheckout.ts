/**
 * Retained checkouts: named, long-lived branch checkouts that temporary workers
 * integrate into.
 *
 * Each instance has a record at `.hive/checkouts/<repoId>/<slug>.json` and a
 * stable ID `<repoId>/<slug>`. A managed instance is a linked Git worktree Hive
 * created at the sibling path `.hive/checkouts/<repoId>/<slug>/`. A registered
 * instance names a checkout the project already configures (the root or a
 * manifest repository) by the root of the Git checkout that holds it, and is
 * never created, moved or removed by Hive.
 *
 * Records hold intent (repository, path, branch ref), minimal creation facts and
 * an optional declared readiness. Live HEAD and dirt are always read fresh.
 * `.hive/repositories.json` is unchanged; a project without one has the
 * implicit repository `root`.
 *
 * This module is the one parser and resolver for records, shared by the
 * mutation service and the read-only inspector. It runs only read-only Git.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ResolvedRepository } from '../types.js';
import { isValidRepositoryId } from '../utils/repositoryIds.js';
import { projectRootsMatch } from '../utils/repositoryConfig.js';
import { assertNoSymlinkComponents, trustedGitCommonDirectory, validateExactWorktreeRegistration } from './worktreeLinkage.js';
import { readWorktreeTargetIdentity } from './worktreeTarget.js';
import type { WorktreeTargetIdentity } from './worktreeTarget.js';
import { writeWorkspaceJsonAtomic } from './workspaceManifest.js';
import { isNativeObservationOwner } from '../native-observations.js';
import type { WorklogAuthor } from './worklogService.js';

export const IMPLICIT_ROOT_REPOSITORY_ID = 'root';
const CHECKOUTS_DIRECTORY = 'checkouts';
const FULL_COMMIT = /^[0-9a-f]{40,64}$/;

export type RetainedCheckoutOwnership = 'managed' | 'registered';

/**
 * A primary's declared disposition of the work at one commit. It is a
 * statement, not evidence Hive checked, and gates nothing. A checkout whose
 * HEAD moved past `commit` shows the declaration as out of date.
 */
export interface RetainedCheckoutReadiness {
  state: 'ready' | 'not_ready';
  commit: string;
  recordedAt: string;
  /** Retained checkout in the same repository this work should integrate into next. */
  nextTarget?: string;
  /** What the work is waiting for, in the primary's words. */
  waitingFor?: string;
  /** Host-supplied session and agent that made the declaration; absent on older records and unknown callers. */
  declaredBy?: WorklogAuthor;
}

export interface RetainedCheckoutRecord {
  schemaVersion: 1;
  id: string;
  repoId: string;
  slug: string;
  ownership: RetainedCheckoutOwnership;
  /** Canonical checkout path. */
  path: string;
  /** Intended local branch, `refs/heads/...`. */
  ref: string;
  purpose?: string;
  created: {
    at: string;
    /** HEAD when the checkout was created or registered. */
    commit: string;
    /** Whether creation made the branch or attached an existing one. Registration always finds one. */
    branch: 'new' | 'existing';
    /** The starting point the caller named for a new branch. */
    baseRef?: string;
  };
  readiness?: RetainedCheckoutReadiness;
}

export type RetainedCheckoutErrorReason =
  | 'invalid_id'
  | 'not_found'
  | 'record_invalid'
  | 'repository_unknown'
  | 'binding_mismatch'
  | 'referenced'
  | 'references_unknown'
  | 'local_data'
  | 'not_contained'
  | 'user_owned';

export class RetainedCheckoutError extends Error {
  readonly reason: RetainedCheckoutErrorReason;

  constructor(reason: RetainedCheckoutErrorReason, message: string) {
    super(message);
    this.name = 'RetainedCheckoutError';
    this.reason = reason;
  }
}

/** A record checked against the current project: its repository is configured and its path is the one it may name. */
export interface ResolvedRetainedCheckout {
  record: RetainedCheckoutRecord;
  repository: ResolvedRepository;
  /** Whether the checkout path exists. A managed checkout that exists was shown to be a linked worktree of its repository. */
  present: boolean;
}

export interface RetainedCheckoutContext {
  hiveDir: string;
  /** Configured repositories, with the implicit root already applied (see `projectRepositories`). */
  repositories: ResolvedRepository[];
}

/** The configured repositories, or the implicit `root` repository for a project without a manifest. */
export function projectRepositories(baseDir: string, resolved: ResolvedRepository[] | undefined): ResolvedRepository[] {
  if (resolved?.length) return resolved;
  const root = path.resolve(baseDir);
  return [{ id: IMPLICIT_ROOT_REPOSITORY_ID, path: root, root }];
}

export function parseRetainedCheckoutId(id: unknown): { repoId: string; slug: string } {
  const parts = typeof id === 'string' ? id.split('/') : [];
  if (parts.length !== 2 || !isValidRepositoryId(parts[0]!) || !isValidRepositoryId(parts[1]!)) {
    throw new RetainedCheckoutError('invalid_id', `Invalid retained checkout ID ${JSON.stringify(id)}: use <repoId>/<slug>, each lowercase letters, digits, '.', '_' or '-'`);
  }
  return { repoId: parts[0]!, slug: parts[1]! };
}

export function getCheckoutsRoot(hiveDir: string): string {
  return path.join(hiveDir, CHECKOUTS_DIRECTORY);
}

export function retainedCheckoutPaths(hiveDir: string, id: string): { recordPath: string; placementPath: string } {
  const { repoId, slug } = parseRetainedCheckoutId(id);
  const placementPath = path.join(getCheckoutsRoot(hiveDir), repoId, slug);
  return { recordPath: `${placementPath}.json`, placementPath };
}

/** Whether `candidate` is a managed checkout placement `.hive/checkouts/<repoId>/<slug>` of this project. */
export function isRetainedCheckoutPlacement(hiveDir: string, candidate: string): boolean {
  const relative = path.relative(getCheckoutsRoot(hiveDir), path.resolve(candidate));
  const parts = relative.split(path.sep);
  return !relative.startsWith('..') && !path.isAbsolute(relative) && parts.length === 2
    && isValidRepositoryId(parts[0]!) && isValidRepositoryId(parts[1]!);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isReadiness(value: unknown): value is RetainedCheckoutReadiness {
  return isRecord(value)
    && (value.state === 'ready' || value.state === 'not_ready')
    && typeof value.commit === 'string' && FULL_COMMIT.test(value.commit)
    && typeof value.recordedAt === 'string'
    && optionalString(value.nextTarget)
    && optionalString(value.waitingFor)
    && (value.declaredBy === undefined || (isRecord(value.declaredBy) && isNativeObservationOwner(value.declaredBy.owner)
      && typeof value.declaredBy.sessionId === 'string' && typeof value.declaredBy.agent === 'string'));
}

export function parseRetainedCheckoutRecord(value: unknown, recordPath: string, expectedId: string): RetainedCheckoutRecord {
  const invalid = (detail: string) => new RetainedCheckoutError('record_invalid', `Invalid retained checkout record ${recordPath}: ${detail}`);
  if (!isRecord(value) || value.schemaVersion !== 1) throw invalid('unsupported schema');
  const record = value as Partial<RetainedCheckoutRecord>;
  const { repoId, slug } = parseRetainedCheckoutId(expectedId);
  if (record.id !== expectedId || record.repoId !== repoId || record.slug !== slug) throw invalid('identity does not match its location');
  if (record.ownership !== 'managed' && record.ownership !== 'registered') throw invalid('unknown ownership');
  if (typeof record.path !== 'string' || !path.isAbsolute(record.path)) throw invalid('path must be absolute');
  if (typeof record.ref !== 'string' || !record.ref.startsWith('refs/heads/') || record.ref === 'refs/heads/') throw invalid('ref must be a local branch ref');
  if (!optionalString(record.purpose)) throw invalid('purpose must be text');
  const created = record.created;
  if (!isRecord(created) || typeof created.at !== 'string' || typeof created.commit !== 'string' || !FULL_COMMIT.test(created.commit)
    || (created.branch !== 'new' && created.branch !== 'existing') || !optionalString(created.baseRef)) {
    throw invalid('creation facts are malformed');
  }
  if (record.readiness !== undefined && !isReadiness(record.readiness)) throw invalid('readiness is malformed');
  return record as RetainedCheckoutRecord;
}

async function readRecordFile(recordPath: string, id: string): Promise<RetainedCheckoutRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(recordPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new RetainedCheckoutError('record_invalid', `Invalid JSON in retained checkout record ${recordPath}: ${(error as Error).message}`);
  }
  return parseRetainedCheckoutRecord(value, recordPath, id);
}

export async function writeRetainedCheckoutRecord(hiveDir: string, record: RetainedCheckoutRecord): Promise<void> {
  const { recordPath } = retainedCheckoutPaths(hiveDir, record.id);
  await assertNoSymlinkComponents(path.parse(recordPath).root, recordPath, true);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await writeWorkspaceJsonAtomic(recordPath, record);
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.lstat(candidate).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

/** Read one record without Git; null when there is none. Refuses a symlinked path and a malformed record. */
export async function readRetainedCheckoutRecord(hiveDir: string, id: string): Promise<RetainedCheckoutRecord | null> {
  const { recordPath } = retainedCheckoutPaths(hiveDir, id);
  await assertNoSymlinkComponents(path.parse(recordPath).root, recordPath, true);
  return readRecordFile(recordPath, id);
}

/**
 * Read one record and check it against the current project. A missing or
 * malformed record, an unconfigured repository, a path the record may not name,
 * or a managed path that is not a linked worktree of its repository is refused.
 */
export async function resolveRetainedCheckout(context: RetainedCheckoutContext, id: string): Promise<ResolvedRetainedCheckout> {
  const { repoId } = parseRetainedCheckoutId(id);
  const { placementPath } = retainedCheckoutPaths(context.hiveDir, id);
  const record = await readRetainedCheckoutRecord(context.hiveDir, id);
  if (!record) throw new RetainedCheckoutError('not_found', `Retained checkout ${id} is not recorded`);
  const repository = context.repositories.find((candidate) => candidate.id === repoId);
  if (!repository) throw new RetainedCheckoutError('repository_unknown', `Retained checkout ${id} names repository ${repoId}, which this project does not configure`);

  if (record.ownership === 'registered') {
    if (!projectRootsMatch(record.path, repository.root)) {
      throw new RetainedCheckoutError('binding_mismatch', `Registered checkout ${id} names ${record.path}, but repository ${repoId} has its checkout root at ${repository.root}`);
    }
    return { record, repository, present: await pathExists(record.path) };
  }

  if (path.resolve(record.path) !== path.resolve(placementPath)) {
    throw new RetainedCheckoutError('binding_mismatch', `Managed checkout ${id} names ${record.path}, not its placement ${placementPath}`);
  }
  await assertNoSymlinkComponents(path.parse(placementPath).root, placementPath, true);
  const present = await pathExists(placementPath);
  if (present) {
    await validateExactWorktreeRegistration(placementPath, () => trustedGitCommonDirectory(repository.path), repoId);
  }
  return { record, repository, present };
}

/** Live identity of a resolved checkout and whether it is still on its intended branch. */
export async function observeRetainedCheckout(resolved: ResolvedRetainedCheckout): Promise<{ identity: WorktreeTargetIdentity; onIntendedRef: boolean }> {
  const identity = await readWorktreeTargetIdentity(resolved.record.path);
  return { identity, onIntendedRef: identity.ref === resolved.record.ref };
}

export interface RetainedCheckoutListing {
  /** IDs of records found, by valid file name. */
  ids: string[];
  /** Entries under `.hive/checkouts` that are not a valid record or a placement with one. */
  unrecognized: Array<{
    path: string;
    reason: string;
    /** Set when the entry could hold records the listing does not read: a symlinked repository directory or a record path that is not a regular file. */
    mayHoldRecord?: true;
  }>;
}

/** List record files and stray entries without reading Git. Refuses a checkouts root reached through a symlink. */
export async function listRetainedCheckouts(hiveDir: string): Promise<RetainedCheckoutListing> {
  const root = getCheckoutsRoot(hiveDir);
  await assertNoSymlinkComponents(path.dirname(hiveDir), root, true);
  const listing: RetainedCheckoutListing = { ids: [], unrecognized: [] };
  const readDir = (directory: string) => fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const repoEntry of (await readDir(root)).sort((left, right) => left.name.localeCompare(right.name))) {
    const repoPath = path.join(root, repoEntry.name);
    if (!repoEntry.isDirectory() || !isValidRepositoryId(repoEntry.name)) {
      const mayHoldRecord = isValidRepositoryId(repoEntry.name) && !repoEntry.isFile();
      listing.unrecognized.push({ path: repoPath, reason: 'not a repository directory', ...(mayHoldRecord ? { mayHoldRecord } : {}) });
      continue;
    }
    const entries = await readDir(repoPath);
    const recorded = new Set<string>();
    for (const entry of entries) {
      const slug = entry.name.endsWith('.json') ? entry.name.slice(0, -'.json'.length) : null;
      if (slug !== null && entry.isFile() && isValidRepositoryId(slug)) {
        recorded.add(slug);
        listing.ids.push(`${repoEntry.name}/${slug}`);
      }
    }
    for (const entry of entries) {
      if (entry.isFile() && recorded.has(entry.name.slice(0, -'.json'.length))) continue;
      if (entry.isDirectory() && recorded.has(entry.name)) continue;
      const slug = entry.name.endsWith('.json') ? entry.name.slice(0, -'.json'.length) : null;
      const mayHoldRecord = slug !== null && isValidRepositoryId(slug);
      listing.unrecognized.push({
        path: path.join(repoPath, entry.name),
        reason: mayHoldRecord ? 'record path is not a regular file' : entry.isDirectory() ? 'placement has no retained checkout record' : 'not a retained checkout record',
        ...(mayHoldRecord ? { mayHoldRecord } : {}),
      });
    }
  }
  listing.ids.sort();
  return listing;
}
