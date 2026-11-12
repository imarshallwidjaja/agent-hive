/**
 * Creates, registers, annotates and removes retained checkouts.
 *
 * Every operation locks the checkout's placement and its repository's Git
 * common directory through the worktree operation guard, so it serializes with
 * worker creation, integration and cleanup in that repository and is refused
 * while an interrupted operation guards them. Git-changing steps publish
 * pending markers first; record-only writes publish none.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import simpleGit, { type SimpleGit } from 'simple-git';
import * as fsSync from 'fs';
import { isDeepStrictEqual } from 'util';
import type { ResolvedRepository } from '../types.js';
import { getFeaturesPath, listFeatureDirectories } from '../utils/paths.js';
import { projectRootsMatch } from '../utils/repositoryConfig.js';
import { readCheckoutLocalState } from './checkoutInspector.js';
import type { CheckoutLocalState } from './checkoutInspector.js';
import {
  listRetainedCheckouts,
  observeRetainedCheckout,
  parseRetainedCheckoutId,
  projectRepositories,
  readRetainedCheckoutRecord,
  resolveRetainedCheckout,
  retainedCheckoutPaths,
  RetainedCheckoutError,
  writeRetainedCheckoutRecord,
} from './retainedCheckout.js';
import type {
  RetainedCheckoutContext,
  RetainedCheckoutErrorReason,
  RetainedCheckoutReadiness,
  RetainedCheckoutRecord,
  ResolvedRetainedCheckout,
} from './retainedCheckout.js';
import { readWorkerTaskStatusEntries } from './taskService.js';
import { listTargetedSidecars, unboundTargetedBranches } from './targetedPlacement.js';
import { isAncestorOrEqual } from './worktreeIntegration.js';
import { cleanupStepDone, deleteBranchStep, withFinalizationFailure, WorktreeOperationFinalizationError } from './worktreeOutcome.js';
import { assertNoSymlinkComponents, trustedGitCommonDirectory, validateExactWorktreeRegistration } from './worktreeLinkage.js';
import { activeCheckoutGitState, withWorktreeMutation, withWorktreeRead } from './worktreeOperation.js';
import type { PendingWorktreeOperation, WorktreeMutationGuard, WorktreeOperationKind } from './worktreeOperation.js';
import { readWorktreeTargetIdentity, sameWorktreeTarget } from './worktreeTarget.js';
import type { WorktreeTargetIdentity } from './worktreeTarget.js';

export interface RetainedCheckoutServiceConfig {
  baseDir: string;
  hiveDir: string;
  repositoryResolver?: { resolveRepositories(): ResolvedRepository[] } | (() => ResolvedRepository[]);
}

export interface CreateRetainedCheckoutInput {
  id: string;
  /** Branch to check out, short (`feat/x`) or full (`refs/heads/feat/x`). An existing branch is attached; a new one needs `baseRef`. */
  branch: string;
  /** Commit-ish a new branch starts from, resolved once to a commit. Not accepted when the branch exists. */
  baseRef?: string;
  /** Descriptive. A repeated request that names a purpose must name the stored one. */
  purpose?: string;
}

export interface RegisterRetainedCheckoutInput {
  id: string;
  /** Descriptive. A repeated request that names a purpose must name the stored one. */
  purpose?: string;
}

export interface RetainedCheckoutReadinessInput {
  state: RetainedCheckoutReadiness['state'];
  nextTarget?: string;
  waitingFor?: string;
}

/** Each reference names the persisted file that holds it, so an operator can open the source. */
export type RetainedCheckoutReference =
  | { kind: 'task'; feature: string; task: string; status: string; statusPath: string }
  /** A targeted worker's binding; `path` is its worktree, which may already be removed while its branch remains. */
  | { kind: 'worker'; path: string; sidecarPath: string; feature?: string; task?: string; candidate?: string; runId?: string }
  | { kind: 'next_target'; from: string; recordPath: string };

/** Persisted state that could name a checkout but could not be read, so whether it does is unknown. */
export interface UnreadableReferenceSource {
  path: string;
  reason: string;
}

export interface RetainedCheckoutReferenceScan {
  references: RetainedCheckoutReference[];
  unreadable: UnreadableReferenceSource[];
}

export interface RetainedCheckoutCleanupProposal {
  record: RetainedCheckoutRecord;
  /** Whether the checkout path exists now. */
  present: boolean;
  /** Live identity to pass back as `expected`; null when the checkout is missing or unreadable. */
  identity: WorktreeTargetIdentity | null;
  onIntendedRef: boolean | null;
  /** Managed checkouts only. Ignored content is removed only with `removeIgnored`. */
  local: CheckoutLocalState | null;
  references: RetainedCheckoutReference[];
  /** Sources that could hold a reference but could not be read; cleanup is refused while any remain. */
  unreadableReferences: UnreadableReferenceSource[];
  pendingOperations: PendingWorktreeOperation[];
  /** Why cleanup would be refused now; empty when only `removeIgnored` decisions remain. */
  blockers: string[];
}

export interface RetainedCheckoutCleanupInput {
  /** The identity from the proposal; null only for a managed checkout whose placement is missing. */
  expected: WorktreeTargetIdentity | null;
  /** Authorize removing ignored content inside a managed checkout. */
  removeIgnored?: boolean;
  /**
   * Delete the managed checkout's branch: only when its tip is contained in the intended branch of the named
   * surviving retained checkout, which must be checked out on that branch, or by explicit discard
   * compare-and-delete at the given commit.
   */
  deleteBranch?: { containedIn: string } | { discard: true; commit: string };
}

export interface RetainedCheckoutCleanupResult {
  id: string;
  ownership: RetainedCheckoutRecord['ownership'];
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  recordRemoved: boolean;
  finalization?: import('./worktreeOutcome.js').WorktreeFinalizationFailure;
}

const UNFINISHED = new Set(['pending', 'in_progress', 'blocked', 'failed', 'partial']);

function normalizeBranchRef(branch: string): string {
  const ref = branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
  if (ref === 'refs/heads/' || branch.startsWith('-')) throw new Error(`Invalid branch ${JSON.stringify(branch)}`);
  return ref;
}

async function resolveCommit(git: SimpleGit, revision: string): Promise<string> {
  if (!revision.trim() || revision.startsWith('-')) throw new Error(`Invalid revision ${JSON.stringify(revision)}`);
  return (await git.raw(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).trim();
}

async function branchCommit(git: SimpleGit, ref: string): Promise<string | null> {
  const output = await git.raw(['show-ref', '--verify', '--hash', ref]).catch(() => '');
  return output.trim() || null;
}

/** Refuse a path below `root` that reaches through a symlink, before anything under it is read. */
function assertNoSymlinkBelow(root: string, target: string): void {
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fsSync.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`path contains a symlink (${current})`);
  }
}

interface RemovalProblem {
  reason: RetainedCheckoutErrorReason;
  message: string;
}

export class RetainedCheckoutService {
  private readonly config: RetainedCheckoutServiceConfig;

  constructor(config: RetainedCheckoutServiceConfig) {
    this.config = config;
  }

  private context(): RetainedCheckoutContext {
    const resolver = this.config.repositoryResolver;
    const resolved = resolver ? (typeof resolver === 'function' ? resolver() : resolver.resolveRepositories()) : undefined;
    return { hiveDir: this.config.hiveDir, repositories: projectRepositories(this.config.baseDir, resolved) };
  }

  private repository(repoId: string): ResolvedRepository {
    const repository = this.context().repositories.find((candidate) => candidate.id === repoId);
    if (!repository) throw new RetainedCheckoutError('repository_unknown', `Repository ${repoId} is not configured in this project`);
    return repository;
  }

  private scope(id: string) {
    const { repoId } = parseRetainedCheckoutId(id);
    const { placementPath } = retainedCheckoutPaths(this.config.hiveDir, id);
    return {
      hiveDir: this.config.hiveDir,
      workspacePath: placementPath,
      select: async () => ({ repositoryPaths: [this.repository(repoId).path] }),
      commonDirectory: (repositoryPath: string) => trustedGitCommonDirectory(repositoryPath),
      trustedRepositoryPaths: () => [this.config.baseDir, ...this.context().repositories.map((repository) => repository.path)],
    };
  }

  private mutate<T extends object>(kind: WorktreeOperationKind, id: string, operation: (guard: WorktreeMutationGuard) => Promise<T>): Promise<T> {
    return withWorktreeMutation({ ...this.scope(id), kind, subject: { type: 'checkout', id } }, (_selection, guard) => operation(guard))
      .catch((error: unknown) => {
        if (error instanceof WorktreeOperationFinalizationError) return withFinalizationFailure(error.result as T, error.finalization);
        throw error;
      });
  }

  /** The record of `id` when one exists; refuses records that cannot be read. */
  private async existingRecord(id: string): Promise<ResolvedRetainedCheckout | null> {
    try {
      return await resolveRetainedCheckout(this.context(), id);
    } catch (error) {
      if (error instanceof RetainedCheckoutError && error.reason === 'not_found') return null;
      throw error;
    }
  }

  /**
   * Create a managed checkout at `.hive/checkouts/<repoId>/<slug>` on a new branch from `baseRef`, or attach an
   * existing branch. Repeating the same request returns the existing checkout while it is still on its branch: the
   * same branch, a baseRef again only when it created the branch and still resolves to the commit it started at,
   * and no conflicting purpose. Anything else already at that ID, path or branch is refused, never overwritten.
   */
  async create(input: CreateRetainedCheckoutInput): Promise<RetainedCheckoutRecord> {
    const { repoId, slug } = parseRetainedCheckoutId(input.id);
    const ref = normalizeBranchRef(input.branch);
    return this.mutate('create', input.id, async (guard) => {
      const existing = await this.existingRecord(input.id);
      if (existing) {
        if (existing.record.ownership !== 'managed' || existing.record.ref !== ref || !existing.present) {
          throw new Error(`Retained checkout ${input.id} already exists (${existing.record.ownership}, ${existing.record.ref}); remove it before creating another`);
        }
        await this.assertSameCreateRequest(existing, input);
        return existing.record;
      }
      const repository = this.repository(repoId);
      const { placementPath } = retainedCheckoutPaths(this.config.hiveDir, input.id);
      await assertNoSymlinkComponents(path.parse(placementPath).root, placementPath, true);
      if (await fs.lstat(placementPath).then(() => true, () => false)) {
        throw new Error(`Retained checkout placement ${placementPath} exists without a record; inspect it and remove it before creating ${input.id}`);
      }
      const git = simpleGit(repository.path);
      await git.raw(['check-ref-format', ref]).catch(() => {
        throw new Error(`Invalid branch ${JSON.stringify(input.branch)}`);
      });
      const existingTip = await branchCommit(git, ref);
      if (existingTip !== null && input.baseRef !== undefined) {
        throw new Error(`Branch ${ref} already exists; omit baseRef to attach it`);
      }
      if (existingTip === null && input.baseRef === undefined) {
        throw new Error(`Branch ${ref} does not exist; name the baseRef it should start from`);
      }
      if (existingTip !== null && (await git.raw(['worktree', 'list', '--porcelain'])).split('\n').includes(`branch ${ref}`)) {
        throw new Error(`Branch ${ref} is already checked out; register that checkout or choose another branch`);
      }
      const start = input.baseRef === undefined ? null : await resolveCommit(git, input.baseRef);
      const branch = ref.slice('refs/heads/'.length);

      await guard.begin({ repositories: [{ repositoryPath: repository.path, repoId, sourceBranch: branch }] });
      await fs.mkdir(path.dirname(placementPath), { recursive: true });
      await git.raw(start === null
        ? ['worktree', 'add', '--', placementPath, branch]
        : ['worktree', 'add', '-b', branch, '--', placementPath, start]);
      await validateExactWorktreeRegistration(placementPath, () => trustedGitCommonDirectory(repository.path), repoId);
      const commit = (await simpleGit(placementPath).revparse(['HEAD'])).trim();
      const record: RetainedCheckoutRecord = {
        schemaVersion: 1,
        id: input.id,
        repoId,
        slug,
        ownership: 'managed',
        path: await fs.realpath(placementPath),
        ref,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        created: {
          at: new Date().toISOString(),
          commit,
          branch: start === null ? 'existing' : 'new',
          ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
        },
      };
      try {
        await writeRetainedCheckoutRecord(this.config.hiveDir, record);
      } catch (error) {
        const removed = await git.raw(['worktree', 'remove', placementPath]).then(() => true, () => false);
        const pruned = removed && await git.raw(['worktree', 'prune']).then(() => true, () => false);
        const branchRestored = start === null || cleanupStepDone(await deleteBranchStep(git, branch, start));
        if (removed && pruned && branchRestored) guard.markOutcomeKnown();
        throw error;
      }
      return record;
    });
  }

  /** A repeated create must ask for what the existing checkout already is. */
  private async assertSameCreateRequest(existing: ResolvedRetainedCheckout, input: CreateRetainedCheckoutInput): Promise<void> {
    const { record } = existing;
    const { identity, onIntendedRef } = await observeRetainedCheckout(existing);
    if (!onIntendedRef) {
      throw new RetainedCheckoutError('binding_mismatch', `Retained checkout ${record.id} exists but is on ${identity.ref ?? 'a detached HEAD'}, not its intended ${record.ref}`);
    }
    if (input.purpose !== undefined && input.purpose !== record.purpose) {
      throw new Error(`Retained checkout ${record.id} already exists with purpose ${JSON.stringify(record.purpose ?? null)}`);
    }
    const created = record.created.branch === 'new'
      ? `created ${record.ref} from baseRef ${JSON.stringify(record.created.baseRef)} at ${record.created.commit}`
      : `attached the existing branch ${record.ref} at ${record.created.commit}`;
    if ((record.created.branch === 'new') !== (input.baseRef !== undefined)) {
      throw new Error(`Retained checkout ${record.id} already exists and ${created}; this request ${input.baseRef === undefined ? 'attaches an existing branch' : `starts a new branch from ${JSON.stringify(input.baseRef)}`}`);
    }
    if (input.baseRef === undefined) return;
    const requested = await resolveCommit(simpleGit(existing.repository.path), input.baseRef);
    if (requested !== record.created.commit) {
      throw new Error(`Retained checkout ${record.id} already exists and ${created}; baseRef ${JSON.stringify(input.baseRef)} now resolves to ${requested}`);
    }
  }

  /**
   * Record a configured checkout (the project root or a manifest repository) as a retained checkout at the branch it
   * has checked out now. The record names the root of the Git checkout holding the repository, the destination
   * integration verifies. Hive never creates, moves or removes a registered checkout.
   */
  async register(input: RegisterRetainedCheckoutInput): Promise<RetainedCheckoutRecord> {
    const { repoId, slug } = parseRetainedCheckoutId(input.id);
    return this.mutate('create', input.id, async () => {
      const repository = this.repository(repoId);
      const identity = await readWorktreeTargetIdentity(repository.root);
      if (identity.ref === null) throw new Error(`Repository ${repoId} has a detached HEAD; check out the branch to register first`);
      const existing = await this.existingRecord(input.id);
      if (existing) {
        if (existing.record.ownership !== 'registered' || existing.record.ref !== identity.ref) {
          throw new Error(`Retained checkout ${input.id} already exists (${existing.record.ownership}, ${existing.record.ref})`);
        }
        if (input.purpose !== undefined && input.purpose !== existing.record.purpose) {
          throw new Error(`Retained checkout ${input.id} already exists with purpose ${JSON.stringify(existing.record.purpose ?? null)}`);
        }
        return existing.record;
      }
      for (const other of (await listRetainedCheckouts(this.config.hiveDir)).ids.filter((candidate) => candidate.startsWith(`${repoId}/`))) {
        // An unreadable record could be this repository's registration, so it refuses rather than being skipped.
        const record = await readRetainedCheckoutRecord(this.config.hiveDir, other);
        if (record?.ownership === 'registered' && projectRootsMatch(record.path, identity.path)) {
          throw new Error(`Repository ${repoId} is already registered as ${other}`);
        }
      }
      const record: RetainedCheckoutRecord = {
        schemaVersion: 1,
        id: input.id,
        repoId,
        slug,
        ownership: 'registered',
        path: identity.path,
        ref: identity.ref,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        created: { at: new Date().toISOString(), commit: identity.commit, branch: 'existing' },
      };
      await writeRetainedCheckoutRecord(this.config.hiveDir, record);
      return record;
    });
  }

  /**
   * Record, replace or (with null) clear a declared readiness. The checkout must still be exactly `expected`, whose
   * commit the declaration pins; a next target must be another retained checkout in the same repository.
   */
  async setReadiness(id: string, expected: WorktreeTargetIdentity, input: RetainedCheckoutReadinessInput | null): Promise<RetainedCheckoutRecord> {
    const { repoId } = parseRetainedCheckoutId(id);
    return this.mutate('create', id, async () => {
      const resolved = await resolveRetainedCheckout(this.context(), id);
      if (!resolved.present) throw new RetainedCheckoutError('binding_mismatch', `Retained checkout ${id} is missing at ${resolved.record.path}`);
      const { identity, onIntendedRef } = await observeRetainedCheckout(resolved);
      if (!onIntendedRef || !sameWorktreeTarget(expected, identity)) {
        throw new RetainedCheckoutError('binding_mismatch', `Retained checkout ${id} is now ${identity.ref ?? 'detached'} at ${identity.commit}, not the expected ${expected.ref ?? 'detached'} at ${expected.commit}; inspect it again`);
      }
      if (input?.nextTarget !== undefined) {
        if (parseRetainedCheckoutId(input.nextTarget).repoId !== repoId || input.nextTarget === id) {
          throw new Error(`nextTarget must be another retained checkout in repository ${repoId}`);
        }
        await resolveRetainedCheckout(this.context(), input.nextTarget);
      }
      const { readiness: _previous, ...rest } = resolved.record;
      const record: RetainedCheckoutRecord = input === null ? rest : {
        ...rest,
        readiness: {
          state: input.state,
          commit: identity.commit,
          recordedAt: new Date().toISOString(),
          ...(input.nextTarget !== undefined ? { nextTarget: input.nextTarget } : {}),
          ...(input.waitingFor !== undefined ? { waitingFor: input.waitingFor } : {}),
        },
      };
      await writeRetainedCheckoutRecord(this.config.hiveDir, record);
      return record;
    });
  }

  /**
   * Tasks, targeted workers and readiness declarations that still name `id`, read from persisted records. A task
   * counts by the status file its worker would read, including the legacy `execution/` layout. A worker counts by its
   * binding sidecar, so one whose worktree was removed while its branch remains still references the checkout.
   * Sources whose answer is unknown are returned as unreadable, never skipped: a record that cannot be read, a
   * symlinked repository directory or record path that is not a regular file, a task without status, a symlinked
   * feature or task entry, and a targeted branch in the checkout's repository that has lost its sidecar, found with
   * one `for-each-ref`.
   */
  async findReferences(id: string): Promise<RetainedCheckoutReferenceScan> {
    const scan: RetainedCheckoutReferenceScan = { references: [], unreadable: [] };
    const unreadable = (source: string, error: unknown) => scan.unreadable.push({ path: source, reason: error instanceof Error ? error.message : String(error) });
    const projectRoot = path.resolve(this.config.baseDir);

    // Feature and task listings skip symlinked entries, so one is reported here instead of read as absent.
    const symlinkedEntries = (directory: string) => {
      try {
        for (const entry of fsSync.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) unreadable(path.join(directory, entry.name), new Error('entry is a symlink'));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable(directory, error);
      }
    };
    const featuresPath = getFeaturesPath(this.config.baseDir);
    let features: ReturnType<typeof listFeatureDirectories> = [];
    try {
      assertNoSymlinkBelow(projectRoot, featuresPath);
      symlinkedEntries(featuresPath);
      features = listFeatureDirectories(this.config.baseDir);
    } catch (error) {
      unreadable(featuresPath, error);
    }
    for (const feature of features) {
      const featurePath = path.join(featuresPath, feature.directoryName);
      let entries: ReturnType<typeof readWorkerTaskStatusEntries>;
      try {
        entries = readWorkerTaskStatusEntries(featurePath, (target) => assertNoSymlinkBelow(projectRoot, target));
      } catch (error) {
        unreadable(featurePath, error);
        continue;
      }
      symlinkedEntries(path.join(featurePath, 'tasks'));
      symlinkedEntries(path.join(featurePath, 'execution'));
      for (const { statusPath, entry } of entries) {
        if ('integrity' in entry) {
          unreadable(statusPath, entry.integrity.reason === 'status_unreadable' ? entry.integrity.error : new Error('task status is missing'));
        } else if (entry.target === id && UNFINISHED.has(entry.status)) {
          scan.references.push({ kind: 'task', feature: feature.logicalName, task: entry.folder, status: entry.status, statusPath });
        }
      }
    }

    const { sidecars, unreadable: unreadableSidecars } = await listTargetedSidecars(this.config.hiveDir);
    scan.unreadable.push(...unreadableSidecars);
    for (const { path: sidecarPath, metadata } of sidecars.filter((sidecar) => sidecar.metadata.target.id === id)) {
      const { feature, task, candidate, runId } = metadata;
      scan.references.push({
        kind: 'worker',
        path: metadata.worktreePath,
        sidecarPath,
        ...(feature !== undefined ? { feature, task } : {}),
        ...(candidate !== undefined ? { candidate } : {}),
        ...(runId !== undefined ? { runId } : {}),
      });
    }
    // A targeted branch whose sidecar is gone could still be work bound to this checkout; only its repository can hold it.
    try {
      const repository = this.repository(parseRetainedCheckoutId(id).repoId);
      for (const branch of await unboundTargetedBranches(repository, sidecars)) {
        unreadable(`${repository.path}:refs/heads/${branch}`, new Error(`targeted worker branch in repository ${repository.id} has no binding metadata, so its target is unknown`));
      }
    } catch (error) {
      unreadable(`repository of ${id}`, error);
    }

    let others: string[] = [];
    try {
      const listing = await listRetainedCheckouts(this.config.hiveDir);
      others = listing.ids;
      // A symlinked repository directory or a record path that is not a regular file could hide a declaration.
      for (const entry of listing.unrecognized.filter((candidate) => candidate.mayHoldRecord)) unreadable(entry.path, new Error(entry.reason));
    } catch (error) {
      unreadable(path.join(this.config.hiveDir, 'checkouts'), error);
    }
    for (const other of others.filter((candidate) => candidate !== id)) {
      const { recordPath } = retainedCheckoutPaths(this.config.hiveDir, other);
      try {
        const record = await readRetainedCheckoutRecord(this.config.hiveDir, other);
        if (record?.readiness?.nextTarget === id) scan.references.push({ kind: 'next_target', from: other, recordPath });
      } catch (error) {
        unreadable(recordPath, error);
      }
    }
    return scan;
  }

  /**
   * Why removing a present managed checkout would lose work, apart from ignored content: a HEAD off its intended
   * branch (detached or switched, so its commits may be on no kept branch), a stopped Git operation, or modified or
   * untracked files.
   */
  private async managedRemovalProblems(resolved: ResolvedRetainedCheckout, identity: WorktreeTargetIdentity): Promise<{ problems: RemovalProblem[]; local: CheckoutLocalState }> {
    const { record } = resolved;
    const problems: RemovalProblem[] = [];
    // A stopped operation comes first: a rebase also detaches HEAD, and the operation is what to resolve.
    const operations = await activeCheckoutGitState(record.path);
    if (operations.length > 0) problems.push({ reason: 'local_data', message: `the checkout has a Git operation in progress or stopped (${operations.join(', ')})` });
    if (identity.ref !== record.ref) {
      problems.push({ reason: 'binding_mismatch', message: `the checkout is on ${identity.ref ?? 'a detached HEAD'} at ${identity.commit}, not its intended ${record.ref}; switch it back or keep its work on a branch first` });
    }
    const local = await readCheckoutLocalState(record.path);
    if (local.tracked.length > 0 || local.untracked.length > 0) {
      problems.push({ reason: 'local_data', message: `the checkout has modified or untracked files: ${[...local.tracked, ...local.untracked].join(', ')}${local.truncated ? ', ...' : ''}` });
    }
    return { problems, local };
  }

  /** What cleanup of `id` would find, without changing anything. Pass its identity back as `expected`. */
  async inspectCleanup(id: string): Promise<RetainedCheckoutCleanupProposal> {
    return withWorktreeRead(this.scope(id), async (_selection, pendingOperations) => {
      const resolved = await resolveRetainedCheckout(this.context(), id);
      let identity: WorktreeTargetIdentity | null = null;
      let onIntendedRef: boolean | null = null;
      if (resolved.present) ({ identity, onIntendedRef } = await observeRetainedCheckout(resolved));
      const removal = resolved.record.ownership === 'managed' && identity !== null ? await this.managedRemovalProblems(resolved, identity) : null;
      const { references, unreadable } = await this.findReferences(id);
      const blockers = [
        ...references.map((reference) => `referenced by ${reference.kind === 'task' ? `task ${reference.feature}/${reference.task} (${reference.status})` : reference.kind === 'worker' ? `worker ${reference.path}` : `the next-target declaration of ${reference.from}`}`),
        ...unreadable.map((source) => `cannot read ${source.path}, which could reference this checkout: ${source.reason}`),
        ...(pendingOperations.length > 0 ? ['an interrupted worktree operation guards this repository'] : []),
        ...(removal?.problems.map((problem) => problem.message) ?? []),
      ];
      return { record: resolved.record, present: resolved.present, identity, onIntendedRef, local: removal?.local ?? null, references, unreadableReferences: unreadable, pendingOperations, blockers };
    });
  }

  /** Refuse while any reference to `id` exists or any source that could hold one cannot be read. */
  private async assertUnreferenced(id: string): Promise<void> {
    const { references, unreadable } = await this.findReferences(id);
    if (references.length > 0) {
      throw new RetainedCheckoutError('referenced', `Retained checkout ${id} is still referenced: ${references.map((reference) => JSON.stringify(reference)).join(', ')}`);
    }
    if (unreadable.length > 0) {
      throw new RetainedCheckoutError('references_unknown', `Retained checkout ${id} cannot be shown to be unreferenced: ${unreadable.map((source) => `${source.path} (${source.reason})`).join(', ')}`);
    }
  }

  /**
   * Remove only the record of a managed checkout whose placement is gone, for example after someone deleted the
   * worktree with Git. The record must still equal `expectedRecord` from the cleanup proposal, and the checkout must
   * be unreferenced with every reference source readable. Git is only read, never changed: the branch and every Git
   * worktree registration, including a prunable one for this placement, stay as they are.
   *
   * The record and placement are checked again after the reference scan, just before the record is deleted.
   * Retained checkout and worktree operations on this repository wait for the operation lock, but task writes (which
   * take TaskService's locks, not this one) and processes outside Hive do not. A reference source can change after the scan
   * has read it, while the scan continues as well as after the last check, and that change goes undetected. Callers
   * that need the checkout to stay unreferenced must stop such writers until the removal finishes.
   */
  async removeMissingRecord(id: string, expectedRecord: RetainedCheckoutRecord): Promise<RetainedCheckoutCleanupResult> {
    return this.mutate('cleanup', id, async () => {
      const assertStillMissing = async () => {
        const resolved = await resolveRetainedCheckout(this.context(), id);
        if (!isDeepStrictEqual(resolved.record, expectedRecord)) {
          throw new RetainedCheckoutError('binding_mismatch', `Retained checkout record ${id} changed since it was inspected; inspect it again`);
        }
        if (resolved.record.ownership !== 'managed') {
          throw new RetainedCheckoutError('user_owned', `Retained checkout ${id} is registered; only a managed checkout's missing placement leaves a stale record`);
        }
        if (resolved.present) {
          throw new RetainedCheckoutError('binding_mismatch', `Retained checkout ${id} exists at ${resolved.record.path}; it is not missing`);
        }
      };
      await assertStillMissing();
      await this.assertUnreferenced(id);
      // The scan is slow and unlocked against writers outside Hive, so what it started from is established again.
      await assertStillMissing();
      await fs.unlink(retainedCheckoutPaths(this.config.hiveDir, id).recordPath);
      return { id, ownership: 'managed', worktreeRemoved: false, branchDeleted: false, recordRemoved: true };
    });
  }

  /**
   * Remove a retained checkout. It must be unreferenced, with every reference source readable. A registered one
   * only loses its record. A managed one must be exactly `expected`, on its intended branch, with no stopped Git
   * operation and no modified or untracked files; ignored content needs `removeIgnored`. Its worktree is removed,
   * its branch is kept unless `deleteBranch` proves containment in a surviving checkout's intended branch or
   * discards at an explicit commit, and its record is removed last.
   */
  async cleanup(id: string, input: RetainedCheckoutCleanupInput): Promise<RetainedCheckoutCleanupResult> {
    return this.mutate('cleanup', id, async (guard) => {
      const resolved = await resolveRetainedCheckout(this.context(), id);
      const { record, repository } = resolved;
      await this.assertUnreferenced(id);
      let identity: WorktreeTargetIdentity | null = null;
      if (resolved.present) {
        ({ identity } = await observeRetainedCheckout(resolved));
        if (!input.expected || !sameWorktreeTarget(input.expected, identity)) {
          throw new RetainedCheckoutError('binding_mismatch', `Retained checkout ${id} is now ${identity.ref ?? 'detached'} at ${identity.commit}; inspect cleanup again`);
        }
      } else if (input.expected !== null) {
        throw new RetainedCheckoutError('binding_mismatch', `Retained checkout ${id} is missing; pass expected: null after inspecting cleanup`);
      }
      const { recordPath, placementPath } = retainedCheckoutPaths(this.config.hiveDir, id);
      const result: RetainedCheckoutCleanupResult = { id, ownership: record.ownership, worktreeRemoved: false, branchDeleted: false, recordRemoved: false };

      if (record.ownership === 'registered') {
        if (input.deleteBranch) throw new RetainedCheckoutError('user_owned', `Registered checkout ${id} belongs to the project configuration; Hive does not delete its branch`);
        await fs.unlink(recordPath);
        return { ...result, recordRemoved: true };
      }

      const git = simpleGit(repository.path);
      if (identity !== null) {
        const { problems, local } = await this.managedRemovalProblems(resolved, identity);
        if (problems.length > 0) throw new RetainedCheckoutError(problems[0]!.reason, `Retained checkout ${id} cannot be removed: ${problems.map((problem) => problem.message).join('; ')}`);
        if (local.ignored.length > 0 && input.removeIgnored !== true) {
          throw new RetainedCheckoutError('local_data', `Retained checkout ${id} holds ignored content that removal would delete: ${local.ignored.join(', ')}${local.truncated ? ', ...' : ''}. Pass removeIgnored after confirming it can go.`);
        }
      }
      const branch = record.ref.slice('refs/heads/'.length);
      let branchPin: string | null = null;
      if (input.deleteBranch) {
        const tip = await branchCommit(git, record.ref);
        if ('discard' in input.deleteBranch) {
          if (tip !== input.deleteBranch.commit) throw new RetainedCheckoutError('binding_mismatch', `Branch ${record.ref} is at ${tip ?? '(missing)'}, not the commit to discard ${input.deleteBranch.commit}`);
        } else {
          const survivor = input.deleteBranch.containedIn;
          if (survivor === id || parseRetainedCheckoutId(survivor).repoId !== record.repoId) {
            throw new Error('containedIn must name another retained checkout in the same repository');
          }
          // The survivor's durable proof is its intended branch, and it must still be checked out on it.
          const surviving = await resolveRetainedCheckout(this.context(), survivor);
          if (!surviving.present) throw new RetainedCheckoutError('not_contained', `Surviving checkout ${survivor} is missing at ${surviving.record.path}`);
          const survivorHead = (await observeRetainedCheckout(surviving)).identity;
          if (survivorHead.ref !== surviving.record.ref) {
            throw new RetainedCheckoutError('binding_mismatch', `Surviving checkout ${survivor} is on ${survivorHead.ref ?? 'a detached HEAD'}, not its intended ${surviving.record.ref}`);
          }
          const survivorTip = await branchCommit(git, surviving.record.ref);
          const contained = tip !== null && survivorTip !== null && await isAncestorOrEqual(git, tip, survivorTip);
          if (!contained) throw new RetainedCheckoutError('not_contained', `Branch ${record.ref} at ${tip ?? '(missing)'} is not contained in ${survivor}'s ${surviving.record.ref} at ${survivorTip ?? '(missing)'}`);
        }
        branchPin = tip;
      }

      await guard.begin({ repositories: [{ repositoryPath: repository.path, repoId: record.repoId, sourceBranch: branch }] });
      if (resolved.present) {
        // Git's non-force removal still refuses modified or untracked files that appeared since the check.
        await git.raw(['worktree', 'remove', placementPath]);
        result.worktreeRemoved = true;
      }
      await git.raw(['worktree', 'prune']);
      if (branchPin !== null) {
        const deletion = await deleteBranchStep(git, branch, branchPin);
        if (deletion.status === 'failed') throw new Error(`Worktree removed, but deleting branch ${record.ref} failed: ${deletion.error}`);
        result.branchDeleted = true;
      }
      await fs.unlink(recordPath);
      return { ...result, recordRemoved: true };
    });
  }
}
