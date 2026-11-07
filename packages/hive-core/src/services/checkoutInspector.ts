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
  parseCompositeWorkspaceManifest,
  parseTaskPlacementEntry,
  readSingleWorkspaceMetadata,
  readTargetedWorkspaceMetadata,
} from './workspaceManifest.js';
import type { TargetBinding } from './workspaceManifest.js';
import { listTargetedSidecars, TARGETED_BRANCH_NAMESPACE } from './targetedPlacement.js';
import { assertNoSymlinkComponents, trustedGitCommonDirectory, validateExactWorktreeRegistration } from './worktreeLinkage.js';
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
  /** Only for a targeted worker whose worktree is gone while its binding remains: its branch tip, null when the branch is gone too. */
  retained?: { branchCommit: string | null };
  error?: string;
}

export interface CheckoutRepositoryView {
  id: string;
  path: string;
  /** The implicit `root` repository of a project without a manifest. */
  implicit: boolean;
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
      const view: RetainedCheckoutView = { id, repoId, slug, record: resolved.record, head: null, onIntendedRef: null };
      if (!resolved.present) return { ...view, error: `checkout is missing at ${resolved.record.path}` };
      try {
        const { identity, onIntendedRef } = await observeRetainedCheckout(resolved);
        view.head = identity;
        view.onIntendedRef = onIntendedRef;
      } catch (error) {
        view.error = message(error);
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

  /** Every temporary worker placement under `.hive/.worktrees`, with errors kept per entry. */
  async listWorkers(repositories = this.repositories()): Promise<{ workers: CheckoutWorkerView[]; errors: Array<{ path: string; reason: string }> }> {
    const root = path.join(this.config.hiveDir, '.worktrees');
    const workers: CheckoutWorkerView[] = [];
    const errors: Array<{ path: string; reason: string }> = [];
    const directories = async (directory: string) => (await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    let groups: string[];
    try {
      groups = await directories(root);
    } catch (error) {
      return { workers, errors: [{ path: root, reason: message(error) }] };
    }
    for (const group of groups) {
      let entries: string[];
      try {
        entries = await directories(path.join(root, group));
      } catch (error) {
        errors.push({ path: path.join(root, group), reason: message(error) });
        continue;
      }
      for (const entry of entries) {
        const owned = group === 'adhoc' ? await adhocGroupEntryOwner(this.config.baseDir, this.config.hiveDir, entry) : { owner: 'task' as const };
        if (owned.owner === 'unknown') {
          errors.push({ path: path.join(root, group, entry), reason: owned.reason });
          continue;
        }
        const owner = owned.owner === 'adhoc' ? { kind: 'adhoc' as const, runId: entry } : { kind: 'task' as const, feature: group, ...parseTaskPlacementEntry(entry) };
        workers.push(...await this.readWorkerPlacement(path.join(root, group, entry), owner, repositories));
      }
    }
    await this.listRetainedBindings(repositories, workers, errors);
    return { workers, errors };
  }

  /**
   * Targeted workers whose worktree is gone while their sidecar remains, because cleanup kept the branch. A sidecar
   * that cannot be read is an error only here, where no placement entry reports it.
   */
  private async listRetainedBindings(repositories: ResolvedRepository[], workers: CheckoutWorkerView[], errors: Array<{ path: string; reason: string }>): Promise<void> {
    const placementMissing = async (sidecarPath: string) => (await fs.lstat(sidecarPath.slice(0, -'.json'.length)).catch(() => null)) === null;
    const { sidecars, unreadable } = await listTargetedSidecars(this.config.hiveDir);
    for (const source of unreadable) {
      if (errors.some((reported) => reported.path === source.path)) continue;
      if (!source.path.endsWith('.json') || await placementMissing(source.path)) errors.push(source);
    }
    for (const { path: sidecarPath, metadata } of sidecars) {
      if (!(await placementMissing(sidecarPath))) continue;
      const view: CheckoutWorkerView = {
        ...(metadata.mode === 'targeted'
          ? { kind: 'task' as const, feature: metadata.feature, task: metadata.task, ...(metadata.candidate !== undefined ? { candidate: metadata.candidate } : {}) }
          : { kind: 'adhoc' as const, runId: metadata.runId }),
        repoId: metadata.repoId,
        path: sidecarPath.slice(0, -'.json'.length),
        branch: metadata.branch,
        head: null,
        baseCommit: metadata.baseCommit,
        target: { ...metadata.target },
      };
      try {
        if (path.resolve(metadata.worktreePath) !== view.path) throw new Error(`metadata names another worktree path, ${metadata.worktreePath}`);
        const repository = repositories.find((candidate) => candidate.id === metadata.repoId);
        if (!repository) throw new Error('its repository is not configured');
        const tip = (await simpleGit(repository.path).raw(['for-each-ref', '--format=%(objectname)', `refs/heads/${metadata.branch}`])).trim();
        workers.push({ ...view, retained: { branchCommit: tip || null } });
      } catch (error) {
        workers.push({ ...view, error: message(error) });
      }
    }
  }

  private async readWorkerPlacement(
    placement: string,
    owner: Pick<CheckoutWorkerView, 'kind' | 'feature' | 'task' | 'candidate' | 'runId'>,
    repositories: ResolvedRepository[],
  ): Promise<CheckoutWorkerView[]> {
    const base = { ...owner, path: placement, repoId: null, branch: null, head: null };
    const byPath = (repositoryPath: string) => repositories.find((repository) => projectRootsMatch(repository.path, repositoryPath)) ?? null;
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
        const repository = repositories.find((candidate) => candidate.id === targeted.repoId) ?? null;
        return [await live({ ...base, repoId: targeted.repoId, branch: targeted.branch, baseCommit: targeted.baseCommit, target: { ...targeted.target } }, repository)];
      }
      const manifestRaw = await fs.readFile(await safePath(path.join(placement, 'workspace.json')), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (manifestRaw !== null) {
        const manifest = parseCompositeWorkspaceManifest(JSON.parse(manifestRaw), path.join(placement, 'workspace.json'));
        return Promise.all(Object.keys(manifest.repos).sort().map((repoId) => {
          const entry = manifest.repos[repoId]!;
          const repository = repositories.find((candidate) => candidate.id === repoId && projectRootsMatch(candidate.path, entry.repoPath)) ?? null;
          return live({ ...base, repoId, path: path.join(placement, entry.path), branch: entry.branch, baseCommit: manifest.baseCommits[repoId] }, repository);
        }));
      }
      const single = await readSingleWorkspaceMetadata(await safePath(`${placement}.json`));
      const repository = byPath(single?.repositoryPath ?? this.config.baseDir);
      const view = await live({ ...base, repoId: repository?.id ?? null, branch: single?.branch ?? null, ...(single ? { baseCommit: single.baseCommit } : {}) }, repository);
      // Only a targeted worker uses this namespace; on such a branch without a targeted sidecar its binding is lost.
      if (!single && view.branch?.startsWith(`${TARGETED_BRANCH_NAMESPACE}/`)) return [{ ...view, error: 'targeted worker branch has no binding metadata, so its target is unknown' }];
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
      projection.repositories.push({ id: repository.id, path: repository.path, implicit, checkouts: [], workers: [] });
    }
    const byId = new Map(projection.repositories.map((repository) => [repository.id, repository]));

    try {
      const listing = await listRetainedCheckouts(this.config.hiveDir);
      projection.errors.push(...listing.unrecognized);
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
