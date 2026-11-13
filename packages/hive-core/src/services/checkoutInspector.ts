/**
 * Read-only projection of a project's checkouts for viewers: per repository,
 * its retained checkouts and the temporary workers placed in it.
 *
 * Nothing here mutates Git, the index or Hive state: it reads records and
 * sidecars and runs only read-only Git (`rev-parse`, `symbolic-ref`,
 * `--no-optional-locks status`, `for-each-ref`, `worktree list`). It never
 * fetches, never compares every pair of branches, and reports a problem with
 * one entry on that entry instead of failing the projection. A worker's target
 * is reported only when the worker was bound to one; a start commit is not a
 * target.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import simpleGit from 'simple-git';
import type { ResolvedRepository } from '../types.js';
import { projectRootsMatch } from '../utils/repositoryConfig.js';
import {
  listRetainedCheckouts,
  observeRetainedCheckout,
  parseRetainedCheckoutId,
  projectRepositories,
  resolveRetainedCheckout,
} from './retainedCheckout.js';
import type { RetainedCheckoutContext, RetainedCheckoutReadiness, RetainedCheckoutRecord } from './retainedCheckout.js';
import {
  adhocGroupEntryOwner,
  describesCompositeWorker,
  describesSingleWorker,
  describesTargetedWorker,
  isMetadataOnlyComposite,
  isRegisteredWorktreePath,
  parseCompositeWorkspaceManifest,
  parseSingleWorkspaceMetadata,
  parseTaskPlacementEntry,
  readSingleWorkspaceMetadata,
  readTargetedWorkspaceMetadata,
} from './workspaceManifest.js';
import type { SingleWorkspaceMetadata, TargetBinding, WorkerOwner } from './workspaceManifest.js';
import { readWorkerSidecars, targetedRunBranch, targetedSidecars, targetedTaskBranch, TARGETED_BRANCH_NAMESPACE } from './targetedPlacement.js';
import { readBranchOid } from './worktreeOutcome.js';
import { assertNoSymlinkComponents, trustedGitCommonDirectory, validateExactWorktreeRegistration } from './worktreeLinkage.js';
import { readWorktreeTargetIdentity } from './worktreeTarget.js';
import type { WorktreeTargetIdentity } from './worktreeTarget.js';

export interface CheckoutInspectorConfig {
  baseDir: string;
  hiveDir: string;
  repositoryResolver?: { resolveRepositories(): ResolvedRepository[] } | (() => ResolvedRepository[]);
}

export interface RetainedCheckoutView {
  id: string;
  repoId: string;
  slug: string;
  /** The record; absent when it could not be read or resolved (see `error`). */
  record?: RetainedCheckoutRecord;
  /** Whether the checkout path exists; absent with `record`, when the record could not be resolved. */
  present?: boolean;
  /** Live checkout identity; null when it could not be read. */
  head: WorktreeTargetIdentity | null;
  /** Whether the checkout is on its intended branch; null when unknown. */
  onIntendedRef: boolean | null;
  /** The declared readiness and whether HEAD has moved past its commit; null when HEAD is unknown. */
  readiness?: RetainedCheckoutReadiness & { headMoved: boolean | null };
  error?: string;
}

export interface CheckoutWorkerView {
  kind: 'task' | 'adhoc';
  feature?: string;
  task?: string;
  candidate?: string;
  runId?: string;
  /** Repository the worker's checkout belongs to; null when it cannot be established. */
  repoId: string | null;
  path: string;
  branch: string | null;
  head: string | null;
  baseCommit?: string;
  /** The retained checkout the worker is bound to; present only for targeted workers. */
  target?: TargetBinding;
  /**
   * Only for a worker whose checkout is gone while its record (targeted or single sidecar, composite manifest) remains:
   * the branch tip, null when the branch is gone too. Without `error` the record is what a worktree-only cleanup keeps
   * beside its branch. With `error` the state is unresolved, such as a partial composite removal, a create that never
   * confirmed its checkout, or a checkout Git still registers; `retained` then grants no readiness or cleanliness.
   */
  retained?: { branchCommit: string | null };
  error?: string;
}

export interface CheckoutRepositoryView {
  id: string;
  /** The configured repository path, which may be a subdirectory of its Git checkout. */
  path: string;
  /** Root of the Git checkout holding the repository: the path a registered retained checkout names. */
  root: string;
  /** The implicit `root` repository of a project without a manifest. */
  implicit: boolean;
  /** Live identity of the Git checkout at `root`; null when it could not be read (see `headError`). */
  head: WorktreeTargetIdentity | null;
  headError?: string;
  checkouts: RetainedCheckoutView[];
  workers: CheckoutWorkerView[];
}

export interface CheckoutProjection {
  repositories: CheckoutRepositoryView[];
  /** Entries whose repository is not configured or could not be established. */
  unassigned: { checkouts: RetainedCheckoutView[]; workers: CheckoutWorkerView[] };
  /** Stray files or directories under `.hive/checkouts`, and worker placements that could not be listed or attributed to an owner. */
  errors: Array<{ path: string; reason: string }>;
  /** Set when configured repositories could not be resolved; checkouts and workers are then unassigned. */
  repositoryError?: string;
}

export interface CheckoutLocalState {
  /**
   * Paths from read-only status, capped per kind. A directory whose content is all untracked or all ignored is
   * one `dir/` entry, so generated trees such as `node_modules/` are summarized rather than walked.
   */
  tracked: string[];
  untracked: string[];
  ignored: string[];
  truncated: boolean;
}

export interface LocalBranchView {
  ref: string;
  commit: string;
  /** Where the branch is checked out, if anywhere. */
  checkedOutAt: string | null;
}

const LOCAL_STATE_LIMIT = 50;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Classify read-only porcelain status into tracked, untracked and ignored paths. */
export async function readCheckoutLocalState(checkoutPath: string): Promise<CheckoutLocalState> {
  const output = await simpleGit(checkoutPath).raw(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--ignored=traditional', '--untracked-files=normal']);
  const state: CheckoutLocalState = { tracked: [], untracked: [], ignored: [], truncated: false };
  const entries = output.split('\0').filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') index += 1;
    const list = code === '??' ? state.untracked : code === '!!' ? state.ignored : state.tracked;
    if (list.length < LOCAL_STATE_LIMIT) list.push(file);
    else state.truncated = true;
  }
  return state;
}

/**
 * A worker whose checkout is gone while its record remains, with its branch tip read from its configured repository.
 * `observeUnresolved` says why the record is not only what a worktree-only cleanup keeps, such as a create that never
 * confirmed its checkout; it is reported in `error` beside the branch tip. An observation that fails is this worker's
 * `error`, not the inventory's.
 */
async function retainedBranch(view: CheckoutWorkerView, repository: ResolvedRepository | null, observeUnresolved: () => Promise<string | null>): Promise<CheckoutWorkerView> {
  try {
    const unresolved = await observeUnresolved();
    if (!repository) throw new Error('its repository is not configured');
    const branchCommit = await readBranchOid(simpleGit(repository.path), view.branch!);
    return { ...view, head: null, retained: { branchCommit }, ...(unresolved !== null ? { error: unresolved } : {}) };
  } catch (error) {
    return { ...view, head: null, error: message(error) };
  }
}

/** Why a kept single-placement record is not only what a worktree-only cleanup keeps, or null when it is. */
async function singleRecordUnresolved(repository: ResolvedRepository | null, placement: string, createUnconfirmed: boolean): Promise<string | null> {
  if (createUnconfirmed) return 'its create never confirmed the checkout (createUnconfirmed), so a checkout attached to its branch may be another Git client\'s';
  if (repository && await isRegisteredWorktreePath(repository.path, placement)) return 'its checkout is gone but still registered with Git';
  return null;
}

/**
 * The owner a worker placement's group and entry name, and the branches a record must name for that owner. A task
 * entry `<task>--<candidate>` uses the branch step `<task>-<candidate>`.
 */
function placementOwner(kind: 'task' | 'adhoc', group: string, entry: string): {
  view: Pick<CheckoutWorkerView, 'kind' | 'feature' | 'task' | 'candidate' | 'runId'>;
  owner: WorkerOwner;
  single: string;
  composite: (repoId: string) => string;
  targeted: string;
} {
  if (kind === 'adhoc') {
    return { view: { kind, runId: entry }, owner: { runId: entry }, single: `hive/adhoc/${entry}`, composite: (repoId) => `hive/adhoc/${repoId}/${entry}`, targeted: targetedRunBranch(entry) };
  }
  const { task, candidate } = parseTaskPlacementEntry(entry);
  const step = candidate === undefined ? task : `${task}-${candidate}`;
  const owner = { feature: group, task, ...(candidate !== undefined ? { candidate } : {}) };
  return { view: { kind, ...owner }, owner, single: `hive/${group}/${step}`, composite: (repoId) => `hive/${repoId}/${group}/${step}`, targeted: targetedTaskBranch(group, step) };
}

const UNDESCRIBED = 'its metadata does not describe this placement';

async function readHead(checkoutPath: string): Promise<{ head: string; branch: string | null }> {
  const git = simpleGit(checkoutPath);
  const head = (await git.revparse(['HEAD'])).trim();
  const ref = (await git.raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
  return { head, branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null };
}

export class CheckoutInspector {
  private readonly config: CheckoutInspectorConfig;

  constructor(config: CheckoutInspectorConfig) {
    this.config = config;
  }

  private resolveConfigured(): ResolvedRepository[] {
    const resolver = this.config.repositoryResolver;
    return resolver ? (typeof resolver === 'function' ? resolver() : resolver.resolveRepositories()) : [];
  }

  private repositories(): ResolvedRepository[] {
    return projectRepositories(this.config.baseDir, this.resolveConfigured());
  }

  private context(repositories: ResolvedRepository[]): RetainedCheckoutContext {
    return { hiveDir: this.config.hiveDir, repositories };
  }

  /** One retained checkout with its live HEAD, branch match and readiness freshness. */
  async inspectCheckout(id: string, repositories = this.repositories()): Promise<RetainedCheckoutView> {
    let repoId = '';
    let slug = '';
    try {
      ({ repoId, slug } = parseRetainedCheckoutId(id));
      const resolved = await resolveRetainedCheckout(this.context(repositories), id);
      const view: RetainedCheckoutView = { id, repoId, slug, record: resolved.record, present: resolved.present, head: null, onIntendedRef: null };
      if (!resolved.present) {
        view.error = `checkout is missing at ${resolved.record.path}`;
      } else {
        try {
          const { identity, onIntendedRef } = await observeRetainedCheckout(resolved);
          view.head = identity;
          view.onIntendedRef = onIntendedRef;
        } catch (error) {
          view.error = message(error);
        }
      }
      if (resolved.record.readiness) {
        view.readiness = { ...resolved.record.readiness, headMoved: view.head ? view.head.commit !== resolved.record.readiness.commit : null };
      }
      return view;
    } catch (error) {
      return { id, repoId, slug, head: null, onIntendedRef: null, error: message(error) };
    }
  }

  /** Read-only local state of a retained checkout, on demand. */
  async inspectCheckoutLocalState(id: string): Promise<CheckoutLocalState> {
    const resolved = await resolveRetainedCheckout(this.context(this.repositories()), id);
    if (!resolved.present) throw new Error(`Retained checkout ${id} is missing at ${resolved.record.path}`);
    return readCheckoutLocalState(resolved.record.path);
  }

  /** Local branches of one repository and where each is checked out, on demand. */
  async listLocalBranches(repoId: string): Promise<LocalBranchView[]> {
    const repository = this.repositories().find((candidate) => candidate.id === repoId);
    if (!repository) throw new Error(`Repository ${repoId} is not configured`);
    const git = simpleGit(repository.path);
    const checkedOut = new Map<string, string>();
    let current: string | null = null;
    for (const line of (await git.raw(['worktree', 'list', '--porcelain'])).split('\n')) {
      if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
      else if (line.startsWith('branch ') && current) checkedOut.set(line.slice('branch '.length), current);
    }
    const refs = await git.raw(['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads']);
    return refs.split('\n').filter(Boolean).map((line) => {
      const [ref, commit] = line.split('\0') as [string, string];
      return { ref, commit, checkedOutAt: checkedOut.get(ref) ?? null };
    });
  }

  /**
   * Every temporary worker placement under `.hive/.worktrees`, with errors kept per entry. A symlinked root, group or
   * placement is reported and never read through. Plain files other than sidecars, such as Hive's own temporary
   * files, are not placements and are skipped.
   */
  async listWorkers(repositories = this.repositories()): Promise<{ workers: CheckoutWorkerView[]; errors: Array<{ path: string; reason: string }> }> {
    const root = path.join(this.config.hiveDir, '.worktrees');
    const workers: CheckoutWorkerView[] = [];
    const errors: Array<{ path: string; reason: string }> = [];
    const entriesOf = async (directory: string) => (await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).sort((left, right) => left.name.localeCompare(right.name));
    let groups: Awaited<ReturnType<typeof entriesOf>>;
    try {
      await assertNoSymlinkComponents(path.dirname(this.config.hiveDir), root, true);
      groups = await entriesOf(root);
    } catch (error) {
      return { workers, errors: [{ path: root, reason: message(error) }] };
    }
    for (const group of groups) {
      const groupPath = path.join(root, group.name);
      if (group.isSymbolicLink()) {
        errors.push({ path: groupPath, reason: 'worker group is a symlink' });
        continue;
      }
      if (!group.isDirectory()) continue;
      let entries: Awaited<ReturnType<typeof entriesOf>>;
      try {
        entries = await entriesOf(groupPath);
      } catch (error) {
        errors.push({ path: groupPath, reason: message(error) });
        continue;
      }
      for (const entry of entries) {
        const placement = path.join(groupPath, entry.name);
        // Sidecars are listed with the records they keep; a directory is a placement whatever its name ends in.
        if (entry.name.endsWith('.json') && !entry.isDirectory()) continue;
        if (entry.isSymbolicLink()) {
          errors.push({ path: placement, reason: 'worker placement is a symlink' });
          continue;
        }
        if (!entry.isDirectory()) continue;
        const owned = group.name === 'adhoc' ? await adhocGroupEntryOwner(this.config.baseDir, this.config.hiveDir, entry.name) : { owner: 'task' as const };
        if (owned.owner === 'unknown') {
          errors.push({ path: placement, reason: owned.reason });
          continue;
        }
        workers.push(...await this.readWorkerPlacement(placement, placementOwner(owned.owner, group.name, entry.name), repositories));
      }
    }
    await this.listRetainedRecords(repositories, workers, errors);
    return { workers, errors };
  }

  /**
   * Workers whose checkout is gone while their sidecar remains, because cleanup kept the branch: targeted and
   * single-root workers. Each sidecar is read once, and the owner is the one its group and entry name. A sidecar or
   * placement that cannot be read, a sidecar declaring no supported mode, a placement that is not a directory, and a
   * sidecar that does not describe its placement are reported, not skipped; a record whose create was never confirmed
   * or whose checkout Git still registers keeps its branch tip with an error. A sidecar beside a placement directory is
   * the placement listing's to report.
   */
  private async listRetainedRecords(repositories: ResolvedRepository[], workers: CheckoutWorkerView[], errors: Array<{ path: string; reason: string }>): Promise<void> {
    const { records, unreadable } = await readWorkerSidecars(this.config.hiveDir);
    const targeted = targetedSidecars(records);
    const report = (entry: { path: string; reason: string }) => {
      if (!errors.some((reported) => reported.path === entry.path)) errors.push(entry);
    };
    // Whether the placement beside a sidecar is gone; anything but a missing placement or a directory is reported.
    const placementMissing = async (sidecarPath: string): Promise<boolean> => {
      const placement = sidecarPath.slice(0, -'.json'.length);
      try {
        const stat = await fs.lstat(placement);
        if (stat.isDirectory()) return false;
        report({ path: placement, reason: stat.isSymbolicLink() ? 'worker placement is a symlink' : 'worker placement is not a directory' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        report({ path: placement, reason: `worker placement cannot be inspected: ${message(error)}` });
      }
      return false;
    };
    for (const source of [...unreadable, ...targeted.unreadable]) {
      if (errors.some((reported) => reported.path === source.path)) continue;
      if (!source.path.endsWith('.json') || await placementMissing(source.path)) errors.push(source);
    }
    // The owner a kept sidecar's group and entry name; in the `adhoc` group, which tasks of a feature named `adhoc` share, its mode says which.
    const ownerOf = (sidecarPath: string, mode: string) => {
      const placement = sidecarPath.slice(0, -'.json'.length);
      const group = path.basename(path.dirname(placement));
      return { placement, ...placementOwner(group === 'adhoc' && mode.startsWith('adhoc-') ? 'adhoc' : 'task', group, path.basename(placement)) };
    };
    for (const { path: sidecarPath, metadata } of targeted.sidecars) {
      if (!(await placementMissing(sidecarPath))) continue;
      const { placement, view: owner, ...expected } = ownerOf(sidecarPath, metadata.mode);
      const view: CheckoutWorkerView = { ...owner, repoId: metadata.repoId, path: placement, branch: metadata.branch, head: null, baseCommit: metadata.baseCommit, target: { ...metadata.target } };
      if (!describesTargetedWorker(metadata, { owner: expected.owner, worktreePath: placement, branch: expected.targeted })) {
        workers.push({ ...view, error: UNDESCRIBED });
        continue;
      }
      const repository = repositories.find((candidate) => candidate.id === metadata.repoId && projectRootsMatch(candidate.path, metadata.repositoryPath)) ?? null;
      workers.push(await retainedBranch(view, repository, () => singleRecordUnresolved(repository, placement, metadata.createUnconfirmed === true)));
    }
    for (const { path: sidecarPath, value } of records) {
      const mode = value && typeof value === 'object' ? (value as { mode?: unknown }).mode : undefined;
      if (mode !== 'single' && mode !== 'adhoc-single') continue;
      if (!(await placementMissing(sidecarPath))) continue;
      let metadata: SingleWorkspaceMetadata;
      try {
        metadata = parseSingleWorkspaceMetadata(value, sidecarPath);
      } catch (error) {
        errors.push({ path: sidecarPath, reason: message(error) });
        continue;
      }
      const { placement, view: owner, ...expected } = ownerOf(sidecarPath, mode);
      const view = this.describedSingle(metadata, placement, owner, expected, repositories);
      const repository = this.singleRepository(metadata, repositories);
      workers.push(view.error !== undefined ? view : await retainedBranch(view, repository, () => singleRecordUnresolved(repository, placement, metadata.createUnconfirmed === true)));
    }
  }

  /** The configured repository a single-root sidecar names, or null when it names none, such as a foreign checkout's. */
  private singleRepository(metadata: SingleWorkspaceMetadata, repositories: ResolvedRepository[]): ResolvedRepository | null {
    return repositories.find((repository) => projectRootsMatch(repository.path, metadata.repositoryPath)) ?? null;
  }

  /**
   * The view of a single-root sidecar's worker, with an error and no Git read when the sidecar does not describe its
   * placement's owner, path and branch, and, for a task, the project root. An ad-hoc run may come from a foreign
   * checkout, so its repository is the configured one its sidecar names, or none.
   */
  private describedSingle(
    metadata: SingleWorkspaceMetadata,
    placement: string,
    owner: Pick<CheckoutWorkerView, 'kind' | 'feature' | 'task' | 'candidate' | 'runId'>,
    expected: { owner: WorkerOwner; single: string },
    repositories: ResolvedRepository[],
  ): CheckoutWorkerView {
    const view: CheckoutWorkerView = { ...owner, path: placement, repoId: this.singleRepository(metadata, repositories)?.id ?? null, branch: metadata.branch, head: null, baseCommit: metadata.baseCommit };
    const described = describesSingleWorker(metadata, {
      owner: expected.owner,
      worktreePath: placement,
      ...(owner.kind === 'task' ? { repositoryPath: this.config.baseDir } : {}),
      branch: expected.single,
    });
    return described ? view : { ...view, error: UNDESCRIBED };
  }

  private async readWorkerPlacement(placement: string, owned: ReturnType<typeof placementOwner>, repositories: ResolvedRepository[]): Promise<CheckoutWorkerView[]> {
    const base = { ...owned.view, path: placement, repoId: null, branch: null, head: null };
    const live = async (view: CheckoutWorkerView, repository: ResolvedRepository | null): Promise<CheckoutWorkerView> => {
      try {
        if (!repository) throw new Error('its repository is not configured');
        await validateExactWorktreeRegistration(view.path, () => trustedGitCommonDirectory(repository.path), repository.id);
        const { head, branch } = await readHead(view.path);
        if (view.branch !== null && branch !== view.branch) return { ...view, head, error: `checkout is on ${branch ?? 'a detached HEAD'}, not ${view.branch}` };
        return { ...view, head, branch: view.branch ?? branch };
      } catch (error) {
        return { ...view, error: message(error) };
      }
    };
    // Metadata is read only after its path is shown to stay inside the placement tree, so a planted symlink cannot
    // make the projection read a file elsewhere.
    const safePath = async (candidate: string) => {
      await assertNoSymlinkComponents(path.parse(candidate).root, candidate, true);
      return candidate;
    };
    try {
      const targeted = await readTargetedWorkspaceMetadata(await safePath(`${placement}.json`));
      if (targeted) {
        const view: CheckoutWorkerView = { ...base, repoId: targeted.repoId, branch: targeted.branch, baseCommit: targeted.baseCommit, target: { ...targeted.target } };
        if (!describesTargetedWorker(targeted, { owner: owned.owner, worktreePath: placement, branch: owned.targeted })) return [{ ...view, error: UNDESCRIBED }];
        return [await live(view, repositories.find((candidate) => candidate.id === targeted.repoId && projectRootsMatch(candidate.path, targeted.repositoryPath)) ?? null)];
      }
      const manifestPath = await safePath(path.join(placement, 'workspace.json'));
      const manifestRaw = await fs.readFile(manifestPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (manifestRaw !== null) {
        const manifest = parseCompositeWorkspaceManifest(JSON.parse(manifestRaw), manifestPath);
        if (!describesCompositeWorker(manifest, { owner: owned.owner, branch: owned.composite })) return [{ ...base, error: UNDESCRIBED }];
        // A repository is trusted only as worktree operations trust it: configured composite topology naming the entry's
        // repository path and root. The implicit project root of a project without a repository manifest is not.
        const configured = this.resolveConfigured();
        const trusted = new Map(Object.entries(manifest.repos).flatMap(([repoId, entry]) => {
          const repository = configured.find((candidate) => candidate.id === repoId
            && path.resolve(candidate.path) === path.resolve(entry.repoPath) && candidate.root === entry.repoRoot);
          return repository ? [[repoId, repository] as const] : [];
        }));
        // Only a whole root that is the record of a worktree-only cleanup makes a missing checkout plainly retained.
        let unresolved: Promise<string | null> | undefined;
        const wholeRoot = () => unresolved ??= isMetadataOnlyComposite(placement, manifest, trusted).then(
          (metadataOnly) => metadataOnly ? null : 'its checkout is missing, but the workspace is not only the record of a worktree-only cleanup: another checkout remains or is still registered with Git, its create was never confirmed, or the root holds other content',
          (error: unknown) => `its checkout is missing, and the workspace cannot be shown to be only the record of a worktree-only cleanup: ${message(error)}`,
        );
        return Promise.all(Object.keys(manifest.repos).sort().map(async (repoId) => {
          const entry = manifest.repos[repoId]!;
          const repository = trusted.get(repoId) ?? null;
          const view: CheckoutWorkerView = { ...base, repoId, path: path.join(placement, entry.path), branch: entry.branch, baseCommit: manifest.baseCommits[repoId] };
          if (!repository) return { ...view, repoId: null, error: 'its repository path and root do not match the configured repository topology' };
          if (await fs.lstat(await safePath(view.path)).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT')) return retainedBranch(view, repository, wholeRoot);
          return live(view, repository);
        }));
      }
      const single = await readSingleWorkspaceMetadata(await safePath(`${placement}.json`));
      if (single) {
        const view = this.describedSingle(single, placement, owned.view, owned, repositories);
        return [view.error !== undefined ? view : await live(view, this.singleRepository(single, repositories))];
      }
      // A worker from before sidecars is the project root's.
      const projectRepository = repositories.find((repository) => projectRootsMatch(repository.path, this.config.baseDir)) ?? null;
      const view = await live({ ...base, repoId: projectRepository?.id ?? null }, projectRepository);
      // Only a targeted worker uses this namespace; on such a branch without a targeted sidecar its binding is lost.
      if (view.branch?.startsWith(`${TARGETED_BRANCH_NAMESPACE}/`)) return [{ ...view, error: 'targeted worker branch has no binding metadata, so its target is unknown' }];
      return [view];
    } catch (error) {
      return [{ ...base, error: message(error) }];
    }
  }

  /** Every configured repository with its retained checkouts and temporary workers. */
  async inspectProject(): Promise<CheckoutProjection> {
    const projection: CheckoutProjection = { repositories: [], unassigned: { checkouts: [], workers: [] }, errors: [] };
    let repositories: ResolvedRepository[] = [];
    let implicit = false;
    try {
      const configured = this.resolveConfigured();
      implicit = configured.length === 0;
      repositories = projectRepositories(this.config.baseDir, configured);
    } catch (error) {
      projection.repositoryError = message(error);
    }
    for (const repository of repositories) {
      const view: CheckoutRepositoryView = { id: repository.id, path: repository.path, root: repository.root, implicit, head: null, checkouts: [], workers: [] };
      try {
        view.head = await readWorktreeTargetIdentity(repository.root);
      } catch (error) {
        view.headError = message(error);
      }
      projection.repositories.push(view);
    }
    const byId = new Map(projection.repositories.map((repository) => [repository.id, repository]));

    try {
      const listing = await listRetainedCheckouts(this.config.hiveDir);
      projection.errors.push(...listing.unrecognized.map(({ path: entryPath, reason }) => ({ path: entryPath, reason })));
      for (const id of listing.ids) {
        const view = await this.inspectCheckout(id, repositories);
        (byId.get(view.repoId)?.checkouts ?? projection.unassigned.checkouts).push(view);
      }
    } catch (error) {
      projection.errors.push({ path: path.join(this.config.hiveDir, 'checkouts'), reason: message(error) });
    }

    const { workers, errors } = await this.listWorkers(repositories);
    projection.errors.push(...errors);
    for (const worker of workers) {
      ((worker.repoId !== null ? byId.get(worker.repoId)?.workers : undefined) ?? projection.unassigned.workers).push(worker);
    }
    return projection;
  }
}
