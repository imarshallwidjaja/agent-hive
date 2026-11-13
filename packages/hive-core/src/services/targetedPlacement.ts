/**
 * Temporary workers bound to one retained checkout.
 *
 * A targeted worker is a single-repository placement whose integration target
 * is frozen at creation: the retained checkout's ID, canonical path and
 * intended branch ref. Inspection reports the live destination beside that
 * binding, and merge refuses when the destination is no longer the checkout on
 * that ref, even when the caller passes a freshly inspected identity. HEAD may
 * advance; path and ref may not change.
 *
 * The sidecar is the binding. It is written before Git creates anything and
 * removed only once both the worktree and the branch are gone, so a placement
 * or branch never outlives its binding. Targeted branches live under
 * `hive-targeted/`, outside the `hive/` names legacy workers use: a branch
 * there without its sidecar is refused as a damaged targeted worker instead
 * of being handled as a sidecarless legacy one, unless the placement holds a
 * legacy worker of the same owner.
 *
 * Task and ad-hoc services own locking and subjects; this module owns what
 * their targeted paths share, including branch names. It reuses
 * `integrateWorktreeRepository` for integration and the services' operation
 * guard for markers.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { projectRootsMatch } from '../utils/repositoryConfig.js';
import type { ResolvedRepository } from '../types.js';
import {
  observeRetainedCheckout,
  resolveRetainedCheckout,
  RetainedCheckoutError,
} from './retainedCheckout.js';
import type { RetainedCheckoutContext } from './retainedCheckout.js';
import {
  assertCreateConfirmed,
  confirmWorkspaceRecord,
  createUnconfirmedRefusal,
  describesTargetedWorker,
  readCompositeWorkspaceManifest,
  readSingleWorkspaceMetadata,
  parseTargetedWorkspaceMetadata,
  readTargetedWorkspaceMetadata,
  restoreWorkspaceRecord,
  unresolvedRecordNote,
  writeWorkspaceJsonAtomicSync,
} from './workspaceManifest.js';
import type { TargetBinding, TargetedWorkspaceMetadata } from './workspaceManifest.js';
import {
  buildCleanupOutcome,
  cleanupStepDone,
  deleteBranchStep,
  pruneWorktreesStep,
  readBranchOid,
  releaseWorkerRecord,
  removeUnconfirmedWorktreeStep,
  rollbackFailedCreate,
  WorktreeLinkageError,
} from './worktreeOutcome.js';
import type { CleanupStepOutcome, WorktreeCleanupOutcome } from './worktreeOutcome.js';
import { assertNoSymlinkComponents, trustedGitCommonDirectory, validateExactWorktreeRegistration } from './worktreeLinkage.js';
import type { WorktreeMutationGuard } from './worktreeOperation.js';
import { worktreeOperationLocalPaths } from './worktreeOperation.js';
import { compareWorktreeTarget, isWorktreeTargetIdentity, readWorktreeTargetIdentity } from './worktreeTarget.js';
import type { WorktreeTargetComparison, WorktreeTargetIdentity } from './worktreeTarget.js';
import { integrateWorktreeRepository, integrationFailure, readValidatedCommitMessage } from './worktreeIntegration.js';
import type { IntegrationPolicy, WorktreeIntegrationResult } from './worktreeIntegration.js';
import type { IntegrationRecorder } from './integrationReceipt.js';
import type { AdhocRunOrigin } from './workspaceManifest.js';

function cleanupToolFor(spec: TargetedPlacementSpec): string {
  return spec.mode === 'targeted' ? 'hive_worktree_cleanup' : 'hive_adhoc_worktree_cleanup';
}

/** Where a service places one targeted worker and who owns it. */
export interface TargetedPlacementSpec {
  mode: TargetedWorkspaceMetadata['mode'];
  worktreePath: string;
  metadataPath: string;
  branch: string;
  owner: { feature: string; task: string; candidate?: string } | { runId: string };
  /** The repository and branch of the single-root untargeted worker the same owner keeps at this placement. */
  untargeted: { repositoryPath: string; branch: string };
}

export interface TargetedPlacement {
  metadata: TargetedWorkspaceMetadata;
  repository: ResolvedRepository;
  /** Whether the worktree exists; a present one was shown to be registered on its branch. */
  present: boolean;
}

/**
 * How the live destination relates to the frozen binding.
 * - ok: the retained checkout record and the checkout still name the bound path and ref.
 * - ref_changed: the checkout is on another branch or detached.
 * - record_changed: the retained checkout record is gone or names another path or ref.
 * - unavailable: the destination could not be read.
 */
export type TargetBindingStatus = 'ok' | 'ref_changed' | 'record_changed' | 'unavailable';

export interface TargetBindingInspection {
  binding: TargetBinding;
  status: TargetBindingStatus;
  detail?: string;
  target: WorktreeTargetIdentity | null;
  comparison: WorktreeTargetComparison;
}

/** Branch namespace of targeted workers, outside the `hive/` names of untargeted ones. */
export const TARGETED_BRANCH_NAMESPACE = 'hive-targeted';

/** Branch of a targeted task worker; `branchStep` is the task's branch step, with any candidate suffix. */
export function targetedTaskBranch(feature: string, branchStep: string): string {
  return `${TARGETED_BRANCH_NAMESPACE}/task/${feature}/${branchStep}`;
}

/** Branch of a targeted ad-hoc run. */
export function targetedRunBranch(runId: string): string {
  return `${TARGETED_BRANCH_NAMESPACE}/adhoc/${runId}`;
}

/**
 * Every worker sidecar under `.hive/.worktrees/<group>/`, each read once as JSON, without Git and through no symlink.
 * A directory is a placement even when its name ends in `.json` (run `x.json` has the sidecar `x.json.json`). A group
 * that cannot be listed, or another `.json` entry that is not a regular file or is not JSON, is returned as unreadable.
 * Callers interpret each record's mode.
 */
export async function readWorkerSidecars(hiveDir: string): Promise<{
  records: Array<{ path: string; value: unknown }>;
  unreadable: Array<{ path: string; reason: string }>;
}> {
  const root = path.join(hiveDir, '.worktrees');
  const records: Array<{ path: string; value: unknown }> = [];
  const unreadable: Array<{ path: string; reason: string }> = [];
  const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
  const list = async (directory: string) => {
    await assertNoSymlinkComponents(path.dirname(hiveDir), directory, true);
    return fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  };
  let groups: Awaited<ReturnType<typeof list>> = [];
  try {
    groups = await list(root);
  } catch (error) {
    unreadable.push({ path: root, reason: reason(error) });
  }
  for (const group of groups) {
    const groupPath = path.join(root, group.name);
    if (!group.isDirectory() && !group.isSymbolicLink()) continue;
    let entries: Awaited<ReturnType<typeof list>>;
    try {
      entries = await list(groupPath);
    } catch (error) {
      unreadable.push({ path: groupPath, reason: reason(error) });
      continue;
    }
    for (const entry of entries.filter((candidate) => candidate.name.endsWith('.json') && !candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const sidecarPath = path.join(groupPath, entry.name);
      try {
        if (!entry.isFile()) throw new Error('worker metadata is not a regular file');
        const raw = await fs.readFile(sidecarPath, 'utf8');
        try {
          records.push({ path: sidecarPath, value: JSON.parse(raw) });
        } catch (error) {
          throw new Error(`Invalid JSON in workspace metadata ${sidecarPath}: ${(error as Error).message}`);
        }
      } catch (error) {
        unreadable.push({ path: sidecarPath, reason: reason(error) });
      }
    }
  }
  return { records, unreadable };
}

/**
 * Every targeted worker sidecar under `.hive/.worktrees/<group>/`. Single-root sidecars are skipped. A sidecar that
 * `readWorkerSidecars` cannot read, a targeted one that does not parse, or one declaring no supported mode is returned
 * as unreadable: it could be a damaged binding.
 */
export async function listTargetedSidecars(hiveDir: string): Promise<{
  sidecars: Array<{ path: string; metadata: TargetedWorkspaceMetadata }>;
  unreadable: Array<{ path: string; reason: string }>;
}> {
  const { records, unreadable } = await readWorkerSidecars(hiveDir);
  const targeted = targetedSidecars(records);
  return { sidecars: targeted.sidecars, unreadable: [...unreadable, ...targeted.unreadable] };
}

/**
 * The targeted sidecars among read worker sidecar records, with the ones that could be a damaged binding: a targeted
 * sidecar that does not parse, and one whose mode is missing or is no single-placement mode.
 */
export function targetedSidecars(records: Array<{ path: string; value: unknown }>): {
  sidecars: Array<{ path: string; metadata: TargetedWorkspaceMetadata }>;
  unreadable: Array<{ path: string; reason: string }>;
} {
  const sidecars: Array<{ path: string; metadata: TargetedWorkspaceMetadata }> = [];
  const unreadable: Array<{ path: string; reason: string }> = [];
  for (const { path: sidecarPath, value } of records) {
    const mode = value && typeof value === 'object' ? (value as { mode?: unknown }).mode : undefined;
    if (mode === 'single' || mode === 'adhoc-single') continue;
    if (mode !== 'targeted' && mode !== 'adhoc-targeted') {
      unreadable.push({ path: sidecarPath, reason: `worker metadata declares no supported mode (${JSON.stringify(mode) ?? 'none'})` });
      continue;
    }
    try {
      sidecars.push({ path: sidecarPath, metadata: parseTargetedWorkspaceMetadata(value, sidecarPath) });
    } catch (error) {
      unreadable.push({ path: sidecarPath, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { sidecars, unreadable };
}

/**
 * Targeted worker branches in one repository that no readable sidecar binds: their binding is lost, so where they
 * would integrate is unknown. One `for-each-ref` over the `hive-targeted/` namespace.
 */
export async function unboundTargetedBranches(repository: ResolvedRepository, sidecars: Array<{ metadata: TargetedWorkspaceMetadata }>): Promise<string[]> {
  const bound = new Set(sidecars.filter(({ metadata }) => metadata.repoId === repository.id).map(({ metadata }) => metadata.branch));
  const refs = await simpleGit(repository.path).raw(['for-each-ref', '--format=%(refname:strip=2)', `refs/heads/${TARGETED_BRANCH_NAMESPACE}/`]);
  return refs.split('\n').filter((branch) => branch !== '' && !bound.has(branch));
}

function placementMismatch(spec: TargetedPlacementSpec, detail: string): WorktreeLinkageError {
  return new WorktreeLinkageError(`Worktree linkage preflight failed: targeted workspace metadata ${spec.metadataPath} ${detail}`);
}

async function branchExists(git: SimpleGit, branch: string): Promise<boolean> {
  return (await readBranchOid(git, branch)) !== null;
}

/**
 * Whether the placement holds an untargeted worker of the same owner: a single sidecar of the owner's kind, a
 * composite manifest naming the owner, or, for a single-root worker from before sidecars, the untargeted repository's
 * registered worktree on the owner's untargeted branch, which no targeted worker uses. Such a worker decides the
 * placement and its reader checks it, so a targeted branch name in some repository is not read as its lost binding.
 */
async function holdsUntargetedWorker(spec: TargetedPlacementSpec): Promise<boolean> {
  const task = spec.mode === 'targeted';
  const single = await readSingleWorkspaceMetadata(spec.metadataPath).catch(() => null);
  if (single?.mode === (task ? 'single' : 'adhoc-single')) return true;
  const manifestPath = path.join(spec.worktreePath, 'workspace.json');
  await assertNoSymlinkComponents(path.parse(manifestPath).root, manifestPath, true);
  const manifest = await readCompositeWorkspaceManifest(spec.worktreePath).catch(() => null);
  if (manifest?.mode === 'adhoc-composite') return 'runId' in spec.owner && manifest.runId === spec.owner.runId;
  if (manifest) return 'feature' in spec.owner && manifest.feature === spec.owner.feature && manifest.task === spec.owner.task;
  if (!(await fs.lstat(spec.worktreePath).then(() => true, () => false))) return false;
  try {
    await validateExactWorktreeRegistration(spec.worktreePath, () => trustedGitCommonDirectory(spec.untargeted.repositoryPath), 'untargeted');
    return (await simpleGit(spec.worktreePath).revparse(['--abbrev-ref', 'HEAD'])).trim() === spec.untargeted.branch;
  } catch {
    return false;
  }
}

/**
 * Read the sidecar. Without one, an untargeted worker of the same owner at the placement decides it; otherwise a
 * targeted branch of this owner left without its sidecar, in any configured repository, is refused.
 */
async function readBinding(context: RetainedCheckoutContext, spec: TargetedPlacementSpec): Promise<TargetedWorkspaceMetadata | null> {
  await assertNoSymlinkComponents(path.parse(spec.metadataPath).root, spec.metadataPath, true);
  const metadata = await readTargetedWorkspaceMetadata(spec.metadataPath);
  if (metadata) return metadata;
  if (await holdsUntargetedWorker(spec)) return null;
  for (const repository of context.repositories) {
    if (await branchExists(simpleGit(repository.path), spec.branch)) {
      throw new WorktreeLinkageError(
        `Worktree linkage preflight failed: targeted worker branch ${spec.branch} exists in repository ${repository.id}, but its metadata ${spec.metadataPath} is missing. `
        + 'Restore the metadata, or inspect and remove the branch by hand; Hive will not treat it as a legacy worker.',
      );
    }
  }
  return null;
}

/**
 * Read and check a targeted worker's sidecar against the expected placement and
 * the configured repositories. Null when there is no targeted sidecar and no
 * targeted branch; a branch without its sidecar is refused.
 */
export async function readTargetedPlacement(context: RetainedCheckoutContext, spec: TargetedPlacementSpec): Promise<TargetedPlacement | null> {
  const metadata = await readBinding(context, spec);
  if (!metadata) return null;
  if (!describesTargetedWorker(metadata, spec)) throw placementMismatch(spec, 'names another owner, worktree path or branch');
  const repository = context.repositories.find((candidate) => candidate.id === metadata.repoId);
  if (!repository || !projectRootsMatch(metadata.repositoryPath, repository.path)) {
    throw placementMismatch(spec, `names repository ${metadata.repoId}, which is not configured at ${metadata.repositoryPath}`);
  }
  await assertNoSymlinkComponents(path.parse(spec.worktreePath).root, spec.worktreePath, true);
  const present = await fs.lstat(spec.worktreePath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (present) {
    await validateExactWorktreeRegistration(spec.worktreePath, () => trustedGitCommonDirectory(repository.path), metadata.repoId);
    const branch = (await simpleGit(spec.worktreePath).revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (branch !== spec.branch) {
      throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${metadata.repoId}: current branch does not match the registered branch`);
    }
  }
  return { metadata, repository, present };
}

/** The repository a targeted sidecar selects, for operation locks; null when there is no targeted sidecar. */
export async function targetedRepositoryPath(context: RetainedCheckoutContext, spec: TargetedPlacementSpec): Promise<string | null> {
  const metadata = await readBinding(context, spec);
  if (!metadata) return null;
  const repository = context.repositories.find((candidate) => candidate.id === metadata.repoId);
  if (!repository) throw placementMismatch(spec, `names repository ${metadata.repoId}, which this project does not configure`);
  return repository.path;
}

/**
 * Resolve the retained checkout a new worker targets and require it on its
 * intended branch. Returns the binding to freeze and the observed identity.
 */
export async function resolveWorkerTarget(context: RetainedCheckoutContext, targetId: string): Promise<{
  repository: ResolvedRepository;
  binding: TargetBinding;
  identity: WorktreeTargetIdentity;
}> {
  const resolved = await resolveRetainedCheckout(context, targetId);
  if (!resolved.present) throw new RetainedCheckoutError('binding_mismatch', `Retained checkout ${targetId} is missing at ${resolved.record.path}`);
  const { identity, onIntendedRef } = await observeRetainedCheckout(resolved);
  if (!onIntendedRef) {
    throw new RetainedCheckoutError('binding_mismatch', `Retained checkout ${targetId} is on ${identity.ref ?? 'a detached HEAD'}, not its intended ${resolved.record.ref}`);
  }
  return { repository: resolved.repository, binding: { id: targetId, path: identity.path, ref: resolved.record.ref }, identity };
}

/** Resolve a caller's starting point once to a commit, refusing option-like input. */
async function resolveStartCommit(git: SimpleGit, baseRef: string): Promise<string> {
  if (!baseRef.trim() || baseRef.startsWith('-')) throw new Error(`Invalid baseRef ${JSON.stringify(baseRef)}`);
  try {
    return (await git.raw(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])).trim();
  } catch (error) {
    throw new Error(`baseRef ${JSON.stringify(baseRef)} does not name a commit: ${(error as Error).message.trim()}`, { cause: error });
  }
}

/**
 * Reusing a worker requires the same starting intent: an omitted baseRef
 * matches only a worker that started at its target's HEAD, and a given one
 * must still resolve to the commit the worker started at.
 */
async function assertSameStart(git: SimpleGit, spec: TargetedPlacementSpec, metadata: TargetedWorkspaceMetadata, baseRef: string | undefined): Promise<void> {
  const existing = metadata.baseRef === undefined
    ? `started at its target's HEAD, ${metadata.baseCommit}`
    : `started at baseRef ${JSON.stringify(metadata.baseRef)}, ${metadata.baseCommit}`;
  if (baseRef === undefined) {
    if (metadata.baseRef !== undefined) throw new Error(`Worker ${spec.worktreePath} already exists and ${existing}; a request without baseRef starts at the target's HEAD`);
    return;
  }
  const requested = await resolveStartCommit(git, baseRef);
  if (requested !== metadata.baseCommit) {
    throw new Error(`Worker ${spec.worktreePath} already exists and ${existing}; baseRef ${JSON.stringify(baseRef)} now resolves to ${requested}`);
  }
}

/**
 * Create a targeted worker, or return the existing one for the same owner,
 * target and starting point. Runs under the caller's operation locks on the
 * target repository. The sidecar is written before Git runs, through `bind`
 * when the owner's record declares the target and must still declare it at
 * that moment; when Git fails after creating anything, the sidecar and the
 * pending marker stay so the worker is recovered and cleaned up through its
 * binding. The sidecar stays unconfirmed until this create's own add is
 * validated, so cleanup never deletes a populated checkout another Git client
 * attached there, and create refuses to reuse it.
 */
export async function createTargetedPlacement(
  guard: WorktreeMutationGuard,
  context: RetainedCheckoutContext,
  spec: TargetedPlacementSpec,
  targetId: string,
  baseRef: string | undefined,
  bind: (publish: () => void) => Promise<void> = async (publish) => publish(),
  origin?: AdhocRunOrigin,
): Promise<TargetedPlacement & { commit: string }> {
  await assertNoSymlinkComponents(path.parse(spec.worktreePath).root, spec.worktreePath, true);
  const existing = await readTargetedPlacement(context, spec);
  if (existing) {
    assertCreateConfirmed(existing.metadata, spec.worktreePath, spec.metadataPath, cleanupToolFor(spec));
    if (existing.metadata.target.id !== targetId) {
      throw new Error(`Worker ${spec.worktreePath} already targets ${existing.metadata.target.id}, not ${targetId}`);
    }
    if (!existing.present) throw new Error(`Worker ${spec.worktreePath} has metadata but no worktree; clean it up before creating it again`);
    await assertSameStart(simpleGit(existing.repository.path), spec, existing.metadata, baseRef);
    return { ...existing, commit: (await simpleGit(spec.worktreePath).revparse(['HEAD'])).trim() };
  }
  const occupied = async (candidate: string) => fs.lstat(candidate).then(() => true, () => false);
  for (const candidate of [spec.worktreePath, spec.metadataPath]) {
    if (await occupied(candidate)) throw new Error(`Worker placement collision: ${candidate} already exists without targeted metadata`);
  }
  const { repository, binding } = await resolveWorkerTarget(context, targetId);
  const repoGit = simpleGit(repository.path);
  const baseCommit = baseRef === undefined
    ? (await readWorktreeTargetIdentity(binding.path)).commit
    : await resolveStartCommit(repoGit, baseRef);
  const metadata: TargetedWorkspaceMetadata = {
    schemaVersion: 1,
    mode: spec.mode,
    repoId: repository.id,
    worktreePath: spec.worktreePath,
    repositoryPath: repository.path,
    branch: spec.branch,
    baseCommit,
    ...(baseRef !== undefined ? { baseRef } : {}),
    target: binding,
    createdAt: new Date().toISOString(),
    ...spec.owner,
    ...(origin !== undefined ? { origin } : {}),
  };

  await guard.begin({ repositories: [{ repositoryPath: repository.path, repoId: repository.id, sourceWorktreePath: spec.worktreePath, sourceBranch: spec.branch, targetPath: binding.path }] });
  await fs.mkdir(path.dirname(spec.worktreePath), { recursive: true });
  try {
    // Unconfirmed until this create's own add is validated: a failed add may leave another client's checkout here.
    await bind(() => writeWorkspaceJsonAtomicSync(spec.metadataPath, { ...metadata, createUnconfirmed: true }));
  } catch (error) {
    if (!(await occupied(spec.metadataPath))) guard.markOutcomeKnown();
    throw error;
  }
  try {
    await repoGit.raw(['worktree', 'add', '-b', spec.branch, '--', spec.worktreePath, baseCommit]);
  } catch (error) {
    const created = await occupied(spec.worktreePath) || await branchExists(repoGit, spec.branch).catch(() => true);
    if (!created && await restoreWorkspaceRecord(spec.metadataPath, null)) guard.markOutcomeKnown();
    throw new Error(
      `Failed to create targeted worktree: ${(error as Error).message}`
      + (created ? `. Git left a worktree or branch, so its metadata ${spec.metadataPath} is kept unconfirmed; recover the operation, then clean the worker up.` : ''),
      { cause: error },
    );
  }
  try {
    await validateExactWorktreeRegistration(spec.worktreePath, () => trustedGitCommonDirectory(repository.path), repository.id);
    const placementGit = simpleGit(spec.worktreePath);
    const current = (await placementGit.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const commit = (await placementGit.revparse(['HEAD'])).trim();
    if (current !== spec.branch || commit !== baseCommit) throw new Error(`worktree ${spec.worktreePath} is on ${current} at ${commit}, not ${spec.branch} at ${baseCommit}`);
    await confirmWorkspaceRecord(spec.metadataPath, metadata);
  } catch (error) {
    // `worktree add -b` succeeded, so the checkout and the branch are this create's; the binding goes only with both.
    const leftovers = await rollbackFailedCreate(repoGit, spec.worktreePath, { name: spec.branch, tip: baseCommit, created: true }, true, repository.id);
    const unbound = leftovers.length === 0 && await restoreWorkspaceRecord(spec.metadataPath, null);
    if (unbound) guard.markOutcomeKnown();
    else leftovers.push(`workspace metadata ${spec.metadataPath}`);
    const message = `Failed to create targeted worktree: ${(error as Error).message}`;
    throw new Error(unbound ? message : `${message}; rollback left ${leftovers.join(', ')}${unresolvedRecordNote(error)}`, { cause: error });
  }
  return { metadata, repository, present: true, commit: baseCommit };
}

/** Compare the live destination with a frozen binding. Never throws. */
export async function inspectTargetBinding(context: RetainedCheckoutContext, binding: TargetBinding, sourceCommit: string): Promise<TargetBindingInspection> {
  let status: TargetBindingStatus = 'ok';
  let detail: string | undefined;
  try {
    const resolved = await resolveRetainedCheckout(context, binding.id);
    if (resolved.record.ref !== binding.ref || path.resolve(resolved.record.path) !== path.resolve(binding.path)) {
      status = 'record_changed';
      detail = `retained checkout ${binding.id} now records ${resolved.record.ref} at ${resolved.record.path}`;
    }
  } catch (error) {
    status = 'record_changed';
    detail = (error as Error).message;
  }
  let target: WorktreeTargetIdentity | null = null;
  try {
    target = await readWorktreeTargetIdentity(binding.path);
  } catch (error) {
    return { binding, status: 'unavailable', detail: (error as Error).message, target: null, comparison: { status: 'error', error: (error as Error).message } };
  }
  if (status === 'ok' && (target.ref !== binding.ref || target.path !== binding.path)) {
    status = 'ref_changed';
    detail = `checkout is on ${target.ref ?? 'a detached HEAD'}, not ${binding.ref}`;
  }
  return {
    binding,
    status,
    ...(detail !== undefined ? { detail } : {}),
    target,
    comparison: await compareWorktreeTarget(target.path, target.commit, sourceCommit),
  };
}

/**
 * Integrate a targeted worker into its bound checkout. The binding, the live
 * checkout and the caller's expectation must agree on path and ref; the
 * expectation must also match the live commit, which
 * `integrateWorktreeRepository` checks again around every mutation.
 */
export async function mergeTargetedPlacement(options: {
  guard: WorktreeMutationGuard;
  context: RetainedCheckoutContext;
  spec: TargetedPlacementSpec;
  placement: TargetedPlacement;
  policy: IntegrationPolicy;
  message: string | undefined;
  preserveConflicts: boolean;
  cleanupMode: 'none' | 'worktree' | 'worktree+branch';
  sourceCommit?: string;
  expectedTarget: unknown;
  recordIntegration: IntegrationRecorder;
}): Promise<WorktreeIntegrationResult> {
  const { guard, context, spec, placement, policy } = options;
  const { metadata, repository } = placement;
  const binding = metadata.target;
  if (!isWorktreeTargetIdentity(options.expectedTarget)) return integrationFailure('INVALID_ARGUMENTS', 'expectedTarget is malformed');
  const expectedTarget = options.expectedTarget;
  if (!placement.present) return integrationFailure('WORKTREE_NOT_REGISTERED', 'Worktree linkage preflight failed: targeted worktree is not registered');
  const unconfirmed = createUnconfirmedRefusal(metadata, spec.worktreePath, spec.metadataPath, cleanupToolFor(spec), 'integrated');
  if (unconfirmed !== null) return integrationFailure('CREATE_UNCONFIRMED', unconfirmed);

  const inspection = await inspectTargetBinding(context, binding, metadata.baseCommit);
  if (inspection.status !== 'ok') {
    return integrationFailure(inspection.status === 'unavailable' ? 'GIT_OPERATION_FAILED' : 'TARGET_MISMATCH',
      `Bound target ${binding.id} (${binding.ref} at ${binding.path}) is no longer the integration destination: ${inspection.detail}`,
      { expectedTarget, observedTarget: inspection.target });
  }
  if (expectedTarget.path !== binding.path || expectedTarget.ref !== binding.ref) {
    return integrationFailure('TARGET_MISMATCH', `expectedTarget must name the bound target ${binding.id} (${binding.ref} at ${binding.path})`, {
      expectedTarget,
      observedTarget: inspection.target,
    });
  }

  const sourceCommit = options.sourceCommit ?? (await simpleGit(spec.worktreePath).revparse(['HEAD'])).trim();
  const marker = { repositoryPath: repository.path, repoId: repository.id, sourceWorktreePath: spec.worktreePath, sourceBranch: spec.branch, sourceCommit, expectedTarget, targetPath: binding.path };
  return integrateWorktreeRepository({
    targetGit: simpleGit(binding.path),
    sourceGit: simpleGit(spec.worktreePath),
    sourceBranch: spec.branch,
    sourceCommit,
    expectedTarget,
    sourceDiagnosticPath: spec.worktreePath,
    excludedLocalPaths: worktreeOperationLocalPaths(context.hiveDir),
    policy,
    message: options.message,
    preserveConflicts: options.preserveConflicts,
    cleanupMode: options.cleanupMode,
    beforeMutation: () => guard.begin({ strategy: policy.strategy, repositories: [marker] }),
    cleanup: async (deleteBranch) => removeTargetedPlacement(guard, spec, placement, deleteBranch, { expectedBranchCommit: sourceCommit }),
    readCommitMessage: readValidatedCommitMessage,
    recordIntegration: options.recordIntegration,
  });
}

async function removeWorktreeStep(git: SimpleGit, worktreePath: string): Promise<CleanupStepOutcome> {
  if (!(await fs.lstat(worktreePath).then(() => true, () => false))) return { status: 'already_absent' };
  try {
    // Git's non-force removal drops ignored-only generated content and refuses modified or untracked data.
    if ((await simpleGit(worktreePath).raw(['status', '--porcelain=v1'])).trim() !== '') {
      return { status: 'failed', error: `Refusing to remove dirty worktree ${worktreePath}` };
    }
    await git.raw(['worktree', 'remove', worktreePath]);
    return { status: 'succeeded' };
  } catch (error) {
    return { status: 'failed', error: (error as Error).message || 'worktree removal failed' };
  }
}

/**
 * The worker branch's commit, when deletion is safe without `discard`: every
 * commit it holds is already in the bound target ref. The comparison is with
 * the binding, never with whatever branch the project root has checked out.
 */
async function prepareBranchDeletion(git: SimpleGit, branch: string, binding: TargetBinding, discard: boolean): Promise<string | undefined> {
  let tip: string;
  try {
    tip = (await git.revparse([`refs/heads/${branch}`])).trim();
  } catch (error) {
    if (/unknown revision|ambiguous argument|Needed a single revision/.test((error as Error).message)) return undefined;
    throw error;
  }
  if (discard) return tip;
  const unmerged = Number((await git.raw(['rev-list', '--count', `${binding.ref}..${tip}`])).trim());
  if (unmerged > 0) {
    throw new Error(`Refusing to delete branch ${branch}: ${unmerged} commits are not in its bound target ${binding.id} (${binding.ref}). Merge first, keep the branch, or use explicit discard.`);
  }
  return tip;
}

/**
 * Remove a targeted worker's worktree and optionally its branch. The sidecar
 * goes last, and only when neither the worktree nor the branch remains, so a
 * retained or undeletable branch keeps its binding for the next cleanup.
 */
export async function removeTargetedPlacement(
  guard: WorktreeMutationGuard,
  spec: TargetedPlacementSpec,
  placement: TargetedPlacement,
  deleteBranch: boolean,
  options: { discard?: boolean; expectedBranchCommit?: string } = {},
): Promise<WorktreeCleanupOutcome> {
  const { metadata, repository } = placement;
  const git = simpleGit(repository.path);
  let branchPreparationError: string | undefined;
  let pinnedBranchCommit = options.expectedBranchCommit;
  if (deleteBranch && !pinnedBranchCommit) {
    try {
      pinnedBranchCommit = await prepareBranchDeletion(git, spec.branch, metadata.target, options.discard === true);
    } catch (error) {
      branchPreparationError = (error as Error).message;
    }
  }
  await guard.begin({ repositories: [{ repositoryPath: repository.path, repoId: repository.id, sourceWorktreePath: spec.worktreePath, sourceBranch: spec.branch, targetPath: metadata.target.path }] });
  const worktreeRemoval = !placement.present
    ? { status: 'already_absent' as const }
    : metadata.createUnconfirmed === true
      ? await removeUnconfirmedWorktreeStep(git, spec.worktreePath, spec.branch)
      : await removeWorktreeStep(git, spec.worktreePath);
  const outcome = buildCleanupOutcome(deleteBranch ? 'worktree+branch' : 'worktree', {
    worktreeRemoval,
    prune: await pruneWorktreesStep(git),
    branchDeletion: !deleteBranch
      ? { status: 'not_requested' }
      : branchPreparationError
        ? { status: 'failed', error: branchPreparationError }
        : cleanupStepDone(worktreeRemoval)
          ? await deleteBranchStep(git, spec.branch, pinnedBranchCommit)
          : { status: 'not_attempted' },
  });
  return releaseWorkerRecord(git, spec.branch, spec.metadataPath, outcome);
}
