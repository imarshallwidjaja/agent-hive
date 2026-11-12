/**
 * Checkout brief: one read that tells whoever merges a retained checkout into
 * another what the source holds relative to the destination, which Hive
 * integrations produced it, and where their narrative lives.
 *
 * It joins existing owners and adds no state: retained checkout records and live
 * HEADs, read-only Git (`rev-list`, `merge-base`, `diff --name-only`, `log`)
 * with no fetch command, integration receipts, task status records and Worklog
 * brief reads. It never touches the session index. Every Git process runs with
 * `GIT_NO_LAZY_FETCH` set, so a missing object in a partial clone becomes a gap;
 * a Git build that predates that setting can still lazy-fetch the object.
 * Every list is capped and reports its total; a problem with one entry becomes
 * a gap instead of failing the call. Only a bad request (unknown or malformed source, or an
 * `against` that is not another checkout in the same repository) is refused.
 */
import * as fs from 'fs';
import * as path from 'path';
import simpleGit from 'simple-git';
import type { SimpleGit } from 'simple-git';
import type { ResolvedRepository, TaskStatusType } from '../types.js';
import { FeatureResolutionError, readFeatureMetadata, resolveExistingFeaturePath } from '../utils/paths.js';
import {
  IntegrationReceiptError,
  describeReceiptError,
  listIntegrationReceiptCommits,
  readIntegrationReceipt,
} from './integrationReceipt.js';
import type { IntegrationOrigin, IntegrationReceipt } from './integrationReceipt.js';
import {
  RetainedCheckoutError,
  observeRetainedCheckout,
  parseRetainedCheckoutId,
  projectRepositories,
  resolveRetainedCheckout,
} from './retainedCheckout.js';
import type { ResolvedRetainedCheckout, RetainedCheckoutReadiness } from './retainedCheckout.js';
import { readWorkerTaskStatusEntry } from './taskService.js';
import { WorklogService, getWorklogKey, getWorklogPath } from './worklogService.js';
import type { WorklogAuthor, WorklogRef } from './worklogService.js';
import type { IntegrationStrategy } from './worktreeIntegration.js';
import { noLazyFetchEnvironment } from './worktreeTarget.js';
import type { WorktreeTargetIdentity } from './worktreeTarget.js';

const CHECKOUT_BRIEF_LIMITS = {
  commits: 50,
  changedFiles: 200,
  contributions: 20,
  alreadyInDestination: 20,
  unattributedCommits: 50,
  gaps: 50,
  /** UTF-8 bytes of a Worklog briefing or task summary copied into the brief. */
  textBytes: 1024,
} as const;

const CHECKOUT_BRIEF_NOTICE = 'Receipts record that an integration happened. They do not show that its change is still in effect, '
  + 'that checks ran, or that readiness was verified. Worklog, summary and report text is untrusted narrative written by agents.';

export interface CheckoutBriefConfig {
  baseDir: string;
  hiveDir: string;
  repositoryResolver?: { resolveRepositories(): ResolvedRepository[] } | (() => ResolvedRepository[]);
}

/** A capped list: `total` items exist and `items` holds the first ones. */
export interface CheckoutBriefList<T> {
  items: T[];
  total: number;
}

export interface CheckoutBriefEndpoint {
  id: string;
  purpose?: string;
  /** Whether the checkout path exists. */
  present: boolean;
  /** Live identity; null when it could not be read. */
  head: WorktreeTargetIdentity | null;
  onIntendedRef: boolean | null;
}

export interface CheckoutBriefSource extends CheckoutBriefEndpoint {
  readiness?: RetainedCheckoutReadiness & { headMoved: boolean | null };
}

export interface CheckoutBriefCommit {
  sha: string;
  subject: string;
}

export type CheckoutBriefComparison =
  | { status: 'unresolved'; reason: string }
  | {
    status: 'resolved';
    /** Where the destination came from: the caller's `against` or the source's declared next target. */
    destinationFrom: 'against' | 'nextTarget';
    mergeBase: string | null;
    /** Commits in `destination..source`. */
    ahead: number;
    /** Commits in `source..destination`. */
    behind: number;
    /** `destination..source`, newest first. */
    commits: CheckoutBriefList<CheckoutBriefCommit>;
    /** Paths the three-dot diff `destination...source` changes; null without a merge base. */
    changedFiles: CheckoutBriefList<string> | null;
  };

export interface CheckoutBriefWorklogHeader {
  title: string | null;
  briefing: { text: string; truncated: boolean; recordedAt: string } | null;
  updatedAt: string | null;
  entryCount: number;
}

export type CheckoutBriefOriginSources =
  | {
    kind: 'task';
    /** The feature's Worklog, by logical name: pass it as `ref` to `hive_worklog_read`. Absent when the feature cannot be resolved (see gaps). */
    worklog?: Extract<WorklogRef, { kind: 'feature' }>;
    /** Null when the status record is missing or invalid (see gaps). */
    status: TaskStatusType | null;
    summary?: { text: string; truncated: boolean };
    /** Project-relative pointers, present only where the file exists. */
    plan?: string;
    spec?: string;
    latestReport?: string;
    reportHistory?: string;
  }
  | {
    kind: 'adhoc';
    /** Header of the Worklog in `origin.worklog`; null when it could not be read (see gaps). */
    worklogHeader?: CheckoutBriefWorklogHeader | null;
  };

export interface CheckoutBriefContribution {
  /** The receipt's key: the commit the integration produced. */
  commit: string;
  strategy: IntegrationStrategy;
  recordedAt: string;
  origin: IntegrationOrigin;
  integratedBy?: WorklogAuthor;
  /** The receipt whose `replaced` list led here; absent for a receipted commit in `destination..source`. */
  reachedVia?: string;
  sources: CheckoutBriefOriginSources;
}

export interface CheckoutBriefHeld {
  commit: string;
  /** Null when the receipt could not be read (see gaps). */
  origin: IntegrationOrigin | null;
  reachedVia?: string;
}

export type CheckoutBriefGapKind =
  | 'head_unreadable'
  | 'comparison_unresolved'
  | 'git_error'
  | 'receipts_unreadable'
  | 'receipt_missing'
  | 'receipt_corrupt'
  | 'receipt_unreadable'
  | 'replaced_cycle'
  | 'task_missing'
  | 'task_unreadable'
  | 'worklog_missing'
  | 'worklog_unreadable'
  | 'truncated';

export interface CheckoutBriefGap {
  kind: CheckoutBriefGapKind;
  /** The receipt commit the gap concerns, when it concerns one. */
  commit?: string;
  detail: string;
}

export interface CheckoutBrief {
  repoId: string;
  source: CheckoutBriefSource;
  /** Null when no destination was named or declared. */
  destination: CheckoutBriefEndpoint | null;
  comparison: CheckoutBriefComparison;
  /** Hive integrations the source brings that the destination does not hold; null without a resolved comparison. */
  contributions: CheckoutBriefList<CheckoutBriefContribution> | null;
  /** Receipts reached from the source whose work the destination already holds. */
  alreadyInDestination: CheckoutBriefList<CheckoutBriefHeld> | null;
  /** Commits in `destination..source` no receipt covers. */
  unattributedCommits: CheckoutBriefList<CheckoutBriefCommit> | null;
  gaps: CheckoutBriefList<CheckoutBriefGap>;
  notice: string;
}

type ReceiptRead = { receipt: IntegrationReceipt } | { gap: CheckoutBriefGap };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capped<T>(all: T[], limit: number): CheckoutBriefList<T> {
  return { items: all.slice(0, limit), total: all.length };
}

function cappedText(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= CHECKOUT_BRIEF_LIMITS.textBytes) return { text, truncated: false };
  // Decoding a cut that splits a character drops the partial character's replacement mark.
  return { text: bytes.subarray(0, CHECKOUT_BRIEF_LIMITS.textBytes).toString('utf8').replace(/\uFFFD$/, ''), truncated: true };
}

function lines(output: string): string[] {
  return output.split('\n').filter(Boolean);
}

function isSafeFolder(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\\/]/.test(name);
}

/**
 * Read the brief of retained checkout `id`, compared with `against` when given, else with the source's declared
 * readiness `nextTarget`, else with nothing. Refuses (throws `RetainedCheckoutError`) a malformed or unrecorded
 * source and an `against` that is the source, another repository's checkout, or unresolvable.
 */
export async function readCheckoutBrief(config: CheckoutBriefConfig, request: { id: string; against?: string }): Promise<CheckoutBrief> {
  const resolver = config.repositoryResolver;
  const repositories = projectRepositories(config.baseDir, resolver ? (typeof resolver === 'function' ? resolver() : resolver.resolveRepositories()) : []);
  const context = { hiveDir: config.hiveDir, repositories };
  const gaps: CheckoutBriefGap[] = [];
  const gapKeys = new Set<string>();
  const gap = (entry: CheckoutBriefGap) => {
    const key = `${entry.kind}\0${entry.commit ?? ''}\0${entry.detail}`;
    if (gapKeys.has(key)) return;
    gapKeys.add(key);
    gaps.push(entry);
  };

  const { repoId } = parseRetainedCheckoutId(request.id);
  if (request.against !== undefined) {
    const against = parseRetainedCheckoutId(request.against);
    if (request.against === request.id || against.repoId !== repoId) {
      throw new RetainedCheckoutError('invalid_destination', `against must name another retained checkout in repository ${repoId}, not ${JSON.stringify(request.against)}`);
    }
  }
  const gitRead = { noLazyFetch: true };
  const sourceResolved = await resolveRetainedCheckout(context, request.id, gitRead);
  const destinationResolved = request.against !== undefined ? await resolveRetainedCheckout(context, request.against, gitRead) : undefined;

  const observe = async (resolved: ResolvedRetainedCheckout): Promise<CheckoutBriefEndpoint> => {
    const endpoint: CheckoutBriefEndpoint = {
      id: resolved.record.id,
      ...(resolved.record.purpose !== undefined ? { purpose: resolved.record.purpose } : {}),
      present: resolved.present,
      head: null,
      onIntendedRef: null,
    };
    if (!resolved.present) {
      gap({ kind: 'head_unreadable', detail: `${resolved.record.id} is missing at ${resolved.record.path}` });
      return endpoint;
    }
    try {
      const { identity, onIntendedRef } = await observeRetainedCheckout(resolved, gitRead);
      endpoint.head = identity;
      endpoint.onIntendedRef = onIntendedRef;
    } catch (error) {
      gap({ kind: 'head_unreadable', detail: `${resolved.record.id}: ${message(error)}` });
    }
    return endpoint;
  };

  const source: CheckoutBriefSource = await observe(sourceResolved);
  const readiness = sourceResolved.record.readiness;
  if (readiness) {
    source.readiness = { ...readiness, headMoved: source.head ? source.head.commit !== readiness.commit : null };
  }

  // Destination: explicit, else the declared next target, never a guess.
  let destination: CheckoutBriefEndpoint | null = null;
  let destinationFrom: 'against' | 'nextTarget' | null = null;
  let unresolved: string | null = null;
  if (destinationResolved) {
    destination = await observe(destinationResolved);
    destinationFrom = 'against';
  } else if (readiness?.nextTarget !== undefined) {
    try {
      if (readiness.nextTarget === request.id || parseRetainedCheckoutId(readiness.nextTarget).repoId !== repoId) {
        throw new Error('it is not another retained checkout in the same repository');
      }
      destination = await observe(await resolveRetainedCheckout(context, readiness.nextTarget, gitRead));
      destinationFrom = 'nextTarget';
    } catch (error) {
      unresolved = `The declared next target ${readiness.nextTarget} cannot be used: ${message(error)}`;
    }
  } else {
    unresolved = 'No destination: pass against, or declare a nextTarget in the source readiness.';
  }
  if (!unresolved && (!source.head || !destination?.head)) {
    unresolved = `The live HEAD of ${!source.head ? request.id : destination!.id} could not be read.`;
  }

  const brief = (comparison: CheckoutBriefComparison, rest: Pick<CheckoutBrief, 'contributions' | 'alreadyInDestination' | 'unattributedCommits'>): CheckoutBrief => {
    if (comparison.status === 'unresolved') gap({ kind: 'comparison_unresolved', detail: comparison.reason });
    return { repoId, source, destination, comparison, ...rest, gaps: capped(gaps, CHECKOUT_BRIEF_LIMITS.gaps), notice: CHECKOUT_BRIEF_NOTICE };
  };
  const none = { contributions: null, alreadyInDestination: null, unattributedCommits: null };
  if (unresolved || !destinationFrom) return brief({ status: 'unresolved', reason: unresolved ?? 'No destination.' }, none);

  const git = simpleGit(sourceResolved.record.path).env(noLazyFetchEnvironment());
  const sourceCommit = source.head!.commit;
  const destinationCommit = destination!.head!.commit;

  // Comparison facts. A failure here leaves nothing to attribute, so it is the one unresolved outcome after this point.
  let range: string[];
  let comparison: Extract<CheckoutBriefComparison, { status: 'resolved' }>;
  try {
    range = lines(await git.raw(['rev-list', `${destinationCommit}..${sourceCommit}`]));
    const [behind, ahead] = (await git.raw(['rev-list', '--left-right', '--count', `${destinationCommit}...${sourceCommit}`])).trim().split(/\s+/).map(Number);
    // `merge-base` exits 1 with no output when there is no common ancestor; simple-git resolves that as empty output
    // and rejects a failure that writes to stderr.
    let mergeBase: string | null = null;
    try {
      mergeBase = (await git.raw(['merge-base', destinationCommit, sourceCommit])).trim() || null;
      if (!mergeBase) gap({ kind: 'git_error', detail: `Git returned no merge base for ${request.id} and ${destination!.id}, so changed files are not listed: the heads have no common ancestor, or Git ended without reporting an error` });
    } catch (error) {
      gap({ kind: 'git_error', detail: `The merge base of ${request.id} and ${destination!.id} could not be read, so changed files are not listed: ${message(error)}` });
    }
    const changedFiles = mergeBase
      ? (await git.raw(['diff', '--name-only', '-z', `${destinationCommit}...${sourceCommit}`])).split('\0').filter(Boolean)
      : null;
    comparison = {
      status: 'resolved',
      destinationFrom,
      mergeBase,
      ahead: ahead ?? range.length,
      behind: behind ?? 0,
      commits: { ...capped(range, CHECKOUT_BRIEF_LIMITS.commits), items: await subjects(git, range.slice(0, CHECKOUT_BRIEF_LIMITS.commits)) },
      changedFiles: changedFiles ? capped(changedFiles, CHECKOUT_BRIEF_LIMITS.changedFiles) : null,
    };
    for (const [name, list] of [['comparison.commits', comparison.commits], ['comparison.changedFiles', comparison.changedFiles]] as const) {
      if (list && list.total > list.items.length) gap({ kind: 'truncated', detail: `${name} lists ${list.items.length} of ${list.total}` });
    }
  } catch (error) {
    gap({ kind: 'git_error', detail: message(error) });
    return brief({ status: 'unresolved', reason: `Git comparison failed: ${message(error)}` }, none);
  }

  // Receipts: what the destination already holds, then what the source brings.
  let receiptCommits: string[] = [];
  try {
    receiptCommits = await listIntegrationReceiptCommits(config.hiveDir);
  } catch (error) {
    gap({ kind: 'receipts_unreadable', detail: message(error) });
  }
  const receipted = new Set(receiptCommits);
  const reads = new Map<string, ReceiptRead>();
  const readReceipt = async (commit: string): Promise<ReceiptRead> => {
    const known = reads.get(commit);
    if (known) return known;
    let outcome: ReceiptRead;
    try {
      const receipt = await readIntegrationReceipt(config.hiveDir, commit);
      outcome = receipt ? { receipt } : { gap: { kind: 'receipt_missing', commit, detail: 'a replaced link names a commit with no receipt' } };
    } catch (error) {
      const corrupt = error instanceof IntegrationReceiptError;
      outcome = { gap: { kind: corrupt ? 'receipt_corrupt' : 'receipt_unreadable', commit, detail: describeReceiptError(error) } };
    }
    reads.set(commit, outcome);
    return outcome;
  };

  const rangeSet = new Set(range);
  const held = new Set<string>();
  const outside = receiptCommits.filter((commit) => !rangeSet.has(commit));
  if (outside.length > 0) {
    try {
      // Receipts whose commit still exists and is reachable from the destination; a receipted commit in the range never is.
      const existing = lines(await git.raw(['rev-list', '--ignore-missing', '--no-walk', ...outside]));
      const notInDestination = new Set(lines(await git.raw(['rev-list', '--ignore-missing', ...outside, '--not', destinationCommit])));
      const stack = existing.filter((commit) => !notInDestination.has(commit));
      while (stack.length > 0) {
        const commit = stack.pop()!;
        if (held.has(commit)) continue;
        held.add(commit);
        if (!receipted.has(commit)) continue;
        const read = await readReceipt(commit);
        if ('gap' in read) gap(read.gap);
        else stack.push(...(read.receipt.replaced ?? []).filter((replaced) => !held.has(replaced)));
      }
    } catch (error) {
      gap({ kind: 'git_error', detail: `Receipts the destination holds could not be established, so none were subtracted: ${message(error)}` });
    }
  }

  const contributions: Array<{ receipt: IntegrationReceipt; reachedVia?: string }> = [];
  const alreadyInDestination: CheckoutBriefHeld[] = [];
  const visited = new Set<string>();
  const onPath = new Set<string>();
  const rangeReceipts = range.filter((commit) => receipted.has(commit));
  const direct = new Set(rangeReceipts);
  // Each reached receipt is held or contributing; held ones are followed too, since what they replaced may be listed nowhere else.
  const visit = async (commit: string, linkedFrom: string | undefined): Promise<void> => {
    if (onPath.has(commit)) {
      gap({ kind: 'replaced_cycle', commit: linkedFrom, detail: `receipt ${linkedFrom} links back to ${commit} through replaced` });
      return;
    }
    if (visited.has(commit)) return;
    visited.add(commit);
    // A receipt in destination..source is reached directly, whichever link reached it first.
    const reachedVia = direct.has(commit) ? undefined : linkedFrom;
    const read = await readReceipt(commit);
    if (held.has(commit)) {
      alreadyInDestination.push({ commit, origin: 'receipt' in read ? read.receipt.origin : null, ...(reachedVia ? { reachedVia } : {}) });
    }
    if ('gap' in read) {
      gap(read.gap);
      return;
    }
    if (!held.has(commit)) contributions.push({ receipt: read.receipt, ...(reachedVia ? { reachedVia } : {}) });
    onPath.add(commit);
    // A rebase that reproduces its source commit may list itself; that link carries nothing.
    for (const replaced of read.receipt.replaced ?? []) if (replaced !== commit) await visit(replaced, commit);
    onPath.delete(commit);
  };
  for (const commit of rangeReceipts) await visit(commit, undefined);

  // Unattributed: range commits that are neither a receipt nor inside before..after of a receipt in the range.
  const covered = new Set(rangeReceipts);
  for (const commit of rangeReceipts) {
    const read = reads.get(commit);
    if (!read || 'gap' in read) continue;
    try {
      for (const inside of lines(await git.raw(['rev-list', `${read.receipt.before}..${read.receipt.after}`]))) covered.add(inside);
    } catch (error) {
      gap({ kind: 'git_error', commit, detail: `The commits receipt ${commit} integrated could not be listed: ${message(error)}` });
    }
  }
  const unattributed = range.filter((commit) => !covered.has(commit));

  const resolvedContributions = contributions.slice(0, CHECKOUT_BRIEF_LIMITS.contributions)
    .map(({ receipt, reachedVia }) => describeContribution(config.baseDir, receipt, reachedVia, gap));
  const unattributedShown = unattributed.slice(0, CHECKOUT_BRIEF_LIMITS.unattributedCommits);
  const unattributedItems = await subjects(git, unattributedShown).catch((error) => {
    gap({ kind: 'git_error', detail: `Subjects of unattributed commits could not be read: ${message(error)}` });
    return unattributedShown.map((sha) => ({ sha, subject: '' }));
  });
  const lists = {
    contributions: { items: resolvedContributions, total: contributions.length },
    alreadyInDestination: capped(alreadyInDestination, CHECKOUT_BRIEF_LIMITS.alreadyInDestination),
    unattributedCommits: { items: unattributedItems, total: unattributed.length },
  };
  for (const [name, list] of Object.entries(lists)) {
    if (list.total > list.items.length) gap({ kind: 'truncated', detail: `${name} lists ${list.items.length} of ${list.total}` });
  }
  return brief(comparison, lists);
}

async function subjects(git: SimpleGit, commits: string[]): Promise<CheckoutBriefCommit[]> {
  if (commits.length === 0) return [];
  const output = await git.raw(['log', '--no-walk=unsorted', '--format=%H%x00%s', ...commits]);
  const bySha = new Map(lines(output).map((line) => {
    const [sha, subject] = line.split('\0') as [string, string];
    return [sha, subject ?? ''];
  }));
  return commits.map((sha) => ({ sha, subject: bySha.get(sha) ?? '' }));
}

function describeContribution(
  projectRoot: string,
  receipt: IntegrationReceipt,
  reachedVia: string | undefined,
  gap: (entry: CheckoutBriefGap) => void,
): CheckoutBriefContribution {
  const origin = receipt.origin;
  return {
    commit: receipt.after,
    strategy: receipt.strategy,
    recordedAt: receipt.recordedAt,
    origin,
    ...(receipt.integratedBy ? { integratedBy: receipt.integratedBy } : {}),
    ...(reachedVia ? { reachedVia } : {}),
    sources: origin.kind === 'task'
      ? taskSources(projectRoot, receipt.after, origin, gap)
      : adhocSources(projectRoot, receipt.after, origin, gap),
  };
}

function taskSources(
  projectRoot: string,
  commit: string,
  origin: Extract<IntegrationOrigin, { kind: 'task' }>,
  gap: (entry: CheckoutBriefGap) => void,
): CheckoutBriefOriginSources {
  const sources: Extract<CheckoutBriefOriginSources, { kind: 'task' }> = { kind: 'task', status: null };
  const label = `task ${origin.feature}/${origin.task}`;
  let featurePath: string;
  let featureResolved = false;
  try {
    // The receipt may name the feature by an indexed directory alias such as `01_feat`; its Worklog is keyed by the logical name.
    featurePath = resolveExistingFeaturePath(projectRoot, origin.feature);
    const metadata = readFeatureMetadata(featurePath);
    if (metadata.state !== 'valid') throw new Error(`feature metadata is ${metadata.state}`);
    featureResolved = true;
    const worklog: Extract<WorklogRef, { kind: 'feature' }> = { kind: 'feature', featureName: metadata.feature.name };
    try {
      // The Worklog service refuses a feature ref whose name resolves ambiguously or to unreadable metadata.
      getWorklogPath(projectRoot, worklog);
      sources.worklog = worklog;
    } catch (error) {
      gap({ kind: 'worklog_unreadable', commit, detail: `${label}: feature ${metadata.feature.name} cannot be used as a Worklog ref: ${message(error)}` });
    }
    if (!isSafeFolder(origin.task)) throw new Error(`task ${JSON.stringify(origin.task)} is not a task folder name`);
  } catch (error) {
    const missing = error instanceof FeatureResolutionError && error.reason === 'not_found';
    // An unresolved feature also leaves its Worklog unresolved; say so, since no worklog gap explains the absent ref.
    const worklogNote = featureResolved ? '' : '; the feature Worklog could not be resolved either';
    gap({ kind: missing ? 'task_missing' : 'task_unreadable', commit, detail: `${label}: ${message(error)}${worklogNote}` });
    return sources;
  }

  // The status record is read and validated as task listings read it, in the modern or legacy layout; pointers are found independently.
  const { statusPath, entry } = readWorkerTaskStatusEntry(featurePath, origin.task);
  const taskPaths = [path.dirname(statusPath)];
  if ('integrity' in entry) {
    const missing = entry.integrity.reason === 'status_missing';
    gap({ kind: missing ? 'task_missing' : 'task_unreadable', commit, detail: missing ? `${label} has no status record` : `${label}: ${entry.integrity.error ?? 'status record is unreadable'}` });
    // Without a status file the resolver names the modern directory; artifacts may survive in the legacy one,
    // so each pointer falls back to it when the modern directory lacks that artifact.
    if (missing) taskPaths.push(path.join(featurePath, 'execution', origin.task));
  } else {
    sources.status = entry.status;
    if (typeof entry.summary === 'string') sources.summary = cappedText(entry.summary);
  }
  const relative = (file: string) => (fs.existsSync(file) ? path.relative(projectRoot, file) : undefined);
  const inTask = (find: (taskPath: string) => string | undefined) => {
    for (const taskPath of taskPaths) {
      const value = find(taskPath);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const reportHistory = (taskPath: string) => {
    const reportsPath = path.join(taskPath, 'reports');
    return fs.existsSync(reportsPath) && fs.readdirSync(reportsPath).length > 0 ? path.relative(projectRoot, reportsPath) : undefined;
  };
  const pointers: Record<'plan' | 'spec' | 'latestReport' | 'reportHistory', () => string | undefined> = {
    plan: () => relative(path.join(featurePath, 'plan.md')),
    spec: () => inTask((taskPath) => relative(path.join(taskPath, 'spec.md'))),
    latestReport: () => inTask((taskPath) => relative(path.join(taskPath, 'report.md'))),
    reportHistory: () => inTask(reportHistory),
  };
  // A pointer that cannot be discovered is a gap for this contribution; status and the other pointers still return.
  for (const [name, find] of Object.entries(pointers)) {
    try {
      const value = find();
      if (value !== undefined) (sources as Record<string, unknown>)[name] = value;
    } catch (error) {
      gap({ kind: 'task_unreadable', commit, detail: `${label}: ${name} cannot be read: ${message(error)}` });
    }
  }
  return sources;
}

function adhocSources(
  projectRoot: string,
  commit: string,
  origin: Extract<IntegrationOrigin, { kind: 'adhoc' }>,
  gap: (entry: CheckoutBriefGap) => void,
): CheckoutBriefOriginSources {
  if (!origin.worklog) return { kind: 'adhoc' };
  const ref: WorklogRef = origin.worklog;
  const key = getWorklogKey(ref);
  try {
    const read = new WorklogService(projectRoot).read(ref, { view: 'brief' });
    if (!read.exists) {
      gap({ kind: 'worklog_missing', commit, detail: `Worklog ${key} does not exist` });
      return { kind: 'adhoc', worklogHeader: null };
    }
    return {
      kind: 'adhoc',
      worklogHeader: {
        title: read.title,
        briefing: read.briefing ? { ...cappedText(read.briefing.text), recordedAt: read.briefing.recordedAt } : null,
        updatedAt: read.updatedAt,
        entryCount: read.entryCount,
      },
    };
  } catch (error) {
    gap({ kind: 'worklog_unreadable', commit, detail: `Worklog ${key}: ${message(error)}` });
    return { kind: 'adhoc', worklogHeader: null };
  }
}
