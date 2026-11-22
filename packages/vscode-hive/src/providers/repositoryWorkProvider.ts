import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import type {
  CheckoutProjection,
  CheckoutRepositoryView,
  CheckoutWorkerView,
  FeatureJson,
  NativeObservationOwner,
  RetainedCheckoutView,
  SessionInfo,
} from 'hive-core'
import {
  CheckoutInspector,
  FEATURE_NAME_PATTERN,
  FeatureResolutionError,
  NATIVE_OBSERVATION_OWNERS,
  RepositoryService,
  canonicalProjectRoot,
  getFeaturesPath,
  getNativeObservationOwnerLabel,
  getNativeSessionsPath,
  getTaskReportPath,
  getTaskSpecPath,
  getWorklogKey,
  listFeatureDirectories,
  readJson,
  resolveExistingFeaturePath,
  resolveFeatureDirectoryName,
} from 'hive-core'
import { describeAge, formatTimestamp } from './worklogPresentation.js'

/**
 * Repositories & Work: per repository, its configured checkout, the retained checkouts Hive keeps, and the
 * temporary workers nested under the checkout each was bound to. Every row reads stored records and read-only Git;
 * nothing here merges, deletes, or writes Hive state. A row whose managed checkout directory is gone carries its
 * checkout ID for the one writing action, Remove Stale Hive Record (`staleCheckoutRecord.ts`).
 *
 * Readiness is the primary's declaration at a commit, not verification, and says nothing about whether Git could
 * merge. Activity is shown only for an exact recorded association (task or ad-hoc run) and is labelled as a
 * recorded session update, never as proof that a worker is running now.
 */

/** Structured values a row hands to its open and copy actions; never shell text. */
interface RowLocation {
  path?: string
  ref?: string
  commit?: string
}

interface OwnedSession { owner: NativeObservationOwner; session: SessionInfo }

interface ActivityStores {
  sessions: OwnedSession[]
  /** Stores that could not be read; their records are unknown, not absent. */
  unreadable: string[]
}

interface Snapshot {
  projection: CheckoutProjection
  activity: ActivityStores
  /** Placements per task or run binding, to tell an exact association from an ambiguous one. */
  placements: Map<string, Set<string>>
  featureOf: FeatureResolver
  observedAt: string
}

/** What a logical or indexed feature name resolves to; null when the name is absent or not a valid feature name. */
type FeatureResolver = (name: string | null | undefined) => FeatureIdentity | null

interface FeatureIdentity {
  /** The feature directory; null when resolution failed. */
  directory: string | null
  /** The logical name in that directory's metadata, which worklog refs use; null when it could not be established. */
  logicalName: string | null
  /** Why resolution or the metadata read failed; such a feature's identity is unknown, not absent. */
  error?: string
}

interface BuildContext {
  projectRoot: string
  snapshot: Snapshot
  /** Branch name of a retained checkout by ID, for naming a declared next destination. */
  branchOf: (checkoutId: string) => string | null
}

type Kind = 'repo' | 'checkout' | 'worker' | 'detail' | 'link' | 'group' | 'branch' | 'problem' | 'activity'

class WorkItem extends vscode.TreeItem {
  children: WorkItem[] = []
  /** Set only on a managed retained checkout whose directory is gone; selects Remove Stale Hive Record. */
  checkoutId?: string

  constructor(
    id: string,
    label: string,
    kind: Kind,
    readonly location: RowLocation = {},
    collapsible = vscode.TreeItemCollapsibleState.None,
  ) {
    super(label, collapsible)
    this.id = id
    // Space-separated flags select menu actions: `open` on a checkout-like row whose directory exists now, then each
    // copyable value.
    const opens = kind === 'repo' || kind === 'checkout' || kind === 'worker' || kind === 'branch'
    const flags = [
      opens && location.path && isDirectory(location.path) ? 'open' : undefined,
      location.path ? 'path' : undefined,
      location.ref ? 'ref' : undefined,
      location.commit ? 'commit' : undefined,
    ]
    this.contextValue = ['repository-work', kind, ...flags].filter(Boolean).join(' ')
  }

  withChildren(children: WorkItem[], expanded = false): this {
    this.children = children
    if (children.length > 0) {
      this.collapsibleState = expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    }
    return this
  }
}

/** Branches of one repository that no Hive record represents; listed only when expanded. */
class OtherBranchesItem extends WorkItem {
  constructor(readonly repoId: string, readonly represented: Set<string>) {
    super(`repo:${repoId}/other-branches`, 'Other local branches', 'group', {}, vscode.TreeItemCollapsibleState.Collapsed)
    this.description = 'Not tracked by Hive'
    this.tooltip = 'Local branches with no retained checkout, worker, or repository checkout in Hive. Listed from local refs when expanded; nothing is fetched.'
    this.iconPath = new vscode.ThemeIcon('git-branch')
  }
}

export class RepositoryWorkProvider implements vscode.TreeDataProvider<WorkItem> {
  private readonly changed = new vscode.EventEmitter<WorkItem | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  /** The physical project root, resolved once when the view opens; every row this view shows was read from it. */
  readonly projectRoot: string
  private readonly inspector: Pick<CheckoutInspector, 'inspectProject' | 'listLocalBranches'>
  private generation = 0
  private pending: Promise<Snapshot> | null = null
  private branches = new Map<string, Promise<WorkItem[]>>()
  private view: vscode.TreeView<WorkItem> | null = null

  /** `inspector` replaces the project's own read-only inspector; tests use it to present fixed projections. */
  constructor(workspaceRoot: string, inspector?: Pick<CheckoutInspector, 'inspectProject' | 'listLocalBranches'>) {
    this.projectRoot = canonicalProjectRoot(workspaceRoot)
    this.inspector = inspector ?? new CheckoutInspector({
      baseDir: this.projectRoot,
      hiveDir: path.join(this.projectRoot, '.hive'),
      repositoryResolver: new RepositoryService(this.projectRoot),
    })
  }

  /** Re-reads Git when the view becomes visible or the window regains focus, and names when Git was last read. */
  attach(view: vscode.TreeView<WorkItem>): vscode.Disposable[] {
    this.view = view
    return [
      view.onDidChangeVisibility(event => { if (event.visible) this.refresh() }),
      vscode.window.onDidChangeWindowState(state => { if (state.focused && view.visible) this.refresh() }),
    ]
  }

  refresh(): void {
    this.generation += 1
    this.pending = null
    this.branches = new Map()
    this.changed.fire(undefined)
  }

  getTreeItem(element: WorkItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: WorkItem): Promise<WorkItem[]> {
    if (element instanceof OtherBranchesItem) return this.otherBranches(element)
    if (element) return element.children
    // A read that a refresh overtook is discarded, so an older snapshot never replaces a newer one.
    for (;;) {
      const generation = this.generation
      // `refresh` drops the pending read, so one read serves every caller until the next refresh.
      const snapshot = await (this.pending ??= this.load())
      if (generation !== this.generation) continue
      if (this.view) this.view.description = `Git read ${new Date(snapshot.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      return buildRoots(this.projectRoot, snapshot)
    }
  }

  private async load(): Promise<Snapshot> {
    const [projection, activity] = await Promise.all([this.inspector.inspectProject(), readActivityStores(this.projectRoot)])
    const featureOf = featureResolver(this.projectRoot)
    const placements = new Map<string, Set<string>>()
    for (const worker of allWorkers(projection)) {
      const key = bindingKey(worker, featureOf) ?? (worker.kind === 'task' && worker.task ? unresolvedTaskKey(worker.task) : null)
      if (key) placements.set(key, (placements.get(key) ?? new Set()).add(placementOf(this.projectRoot, worker)))
    }
    return { projection, activity, placements, featureOf, observedAt: new Date().toISOString() }
  }

  private otherBranches(group: OtherBranchesItem): Promise<WorkItem[]> {
    let rows = this.branches.get(group.repoId)
    if (!rows) {
      rows = this.inspector.listLocalBranches(group.repoId).then(branches => {
        const other = branches.filter(branch => !group.represented.has(branch.ref))
        if (other.length === 0) return [detail(group.id!, 'none', 'No other local branches', '')]
        return other.map(branch => {
          const row = new WorkItem(`${group.id}:${branch.ref}`, shortRef(branch.ref), 'branch', { path: branch.checkedOutAt ?? undefined, ref: branch.ref, commit: branch.commit })
          row.description = [shortSha(branch.commit), branch.checkedOutAt ? `checked out at ${this.display(branch.checkedOutAt)}` : undefined].filter(Boolean).join(' · ')
          row.tooltip = [branch.ref, `Commit: ${branch.commit}`, branch.checkedOutAt ? `Checked out at: ${branch.checkedOutAt}` : 'Not checked out'].join('\n')
          row.iconPath = new vscode.ThemeIcon('git-branch')
          return row
        })
      }, error => {
        const row = detail(group.id!, 'error', 'Could not list local branches', message(error))
        row.iconPath = new vscode.ThemeIcon('warning')
        return [row]
      })
      this.branches.set(group.repoId, rows)
    }
    return rows
  }

  private display(target: string): string {
    return path.relative(this.projectRoot, target) || '.'
  }
}

function buildRoots(projectRoot: string, snapshot: Snapshot): WorkItem[] {
  const { projection } = snapshot
  const checkouts = [...projection.repositories.flatMap(repo => repo.checkouts), ...projection.unassigned.checkouts]
  const branches = new Map(checkouts.filter(checkout => checkout.record).map(checkout => [checkout.id, shortRef(checkout.record!.ref)]))
  const context: BuildContext = { projectRoot, snapshot, branchOf: id => branches.get(id) ?? null }
  const roots: WorkItem[] = []

  if (projection.repositoryError) {
    const row = new WorkItem('repositories-error', 'Repositories unreadable', 'problem')
    row.description = projection.repositoryError
    row.tooltip = `${projection.repositoryError}\n\nRetained checkouts and workers are listed under "Not in a configured repository" until the repository configuration can be read.`
    row.iconPath = new vscode.ThemeIcon('warning')
    roots.push(row)
  }
  roots.push(...projection.repositories.map(repo => repositoryItem(repo, context)))

  const { unassigned } = projection
  if (unassigned.checkouts.length + unassigned.workers.length > 0) {
    const group = new WorkItem('unassigned', 'Not in a configured repository', 'group')
    group.description = countText(unassigned.checkouts.length, unassigned.workers.length)
    group.tooltip = 'Records whose repository is not configured or could not be established. They are kept visible, not dropped.'
    group.iconPath = new vscode.ThemeIcon('warning')
    roots.push(group.withChildren(checkoutGroupChildren('unassigned', unassigned.checkouts, unassigned.workers, undefined, context), true))
  }

  if (projection.errors.length > 0) {
    const group = new WorkItem('problems', 'Unreadable Hive entries', 'group')
    group.description = `${projection.errors.length}`
    group.tooltip = 'Files or directories under .hive that could not be read as a checkout or worker. Inspect or repair them outside this viewer.'
    group.iconPath = new vscode.ThemeIcon('warning')
    roots.push(group.withChildren(projection.errors.map(error => {
      const row = new WorkItem(`problem:${error.path}`, path.relative(projectRoot, error.path) || error.path, 'problem', { path: error.path })
      row.description = error.reason
      row.tooltip = `${error.path}\n${error.reason}`
      row.iconPath = new vscode.ThemeIcon('warning')
      return row
    }), true))
  }
  return roots
}

function repositoryItem(repo: CheckoutRepositoryView, context: BuildContext): WorkItem {
  const id = `repo:${repo.id}`
  const row = new WorkItem(id, repo.id, 'repo', { path: repo.path })
  row.description = [path.relative(context.projectRoot, repo.path) || '.', countText(repo.checkouts.length, repo.workers.length)].filter(Boolean).join(' · ')
  row.tooltip = [`Repository ${repo.id}${repo.implicit ? ' (project root, no manifest)' : ''}`, repo.path, `Git read ${formatTimestamp(context.snapshot.observedAt)}`].join('\n')
  row.iconPath = new vscode.ThemeIcon('repo')

  // The registered record is the repository checkout itself, shown once: resolving it proved it names `repo.root`,
  // so this holds even when HEAD cannot be read. A record that failed to resolve stays its own row.
  const own = repo.checkouts.find(checkout => checkout.record?.ownership === 'registered')
  const represented = new Set<string>()
  for (const ref of [repo.head?.ref, ...repo.checkouts.flatMap(checkout => [checkout.record?.ref, checkout.head?.ref])]) {
    if (ref) represented.add(ref)
  }
  for (const worker of repo.workers) if (worker.branch) represented.add(`refs/heads/${worker.branch}`)

  const children = checkoutGroupChildren(id, repo.checkouts, repo.workers, { repo, own }, context)
  children.push(new OtherBranchesItem(repo.id, represented))
  return row.withChildren(children, true)
}

/**
 * The repository checkout first, then retained checkouts with their workers nested under the checkout each declares
 * as its target, then every worker whose target is undeclared or not found here.
 */
function checkoutGroupChildren(
  parentId: string,
  checkouts: RetainedCheckoutView[],
  workers: CheckoutWorkerView[],
  root: { repo: CheckoutRepositoryView; own?: RetainedCheckoutView } | undefined,
  context: BuildContext,
): WorkItem[] {
  const byTarget = new Map<string, CheckoutWorkerView[]>()
  const unresolved: CheckoutWorkerView[] = []
  const known = new Set(checkouts.map(checkout => checkout.id))
  for (const worker of [...workers].sort(compareWorkers)) {
    if (worker.target && known.has(worker.target.id)) byTarget.set(worker.target.id, [...(byTarget.get(worker.target.id) ?? []), worker])
    else unresolved.push(worker)
  }
  const bound = (checkout: RetainedCheckoutView | undefined) => (checkout ? byTarget.get(checkout.id) ?? [] : [])
  const nested = (checkout: RetainedCheckoutView | undefined) => bound(checkout).map(worker => workerItem(worker, context))

  const children: WorkItem[] = []
  if (root) {
    const row = rootCheckoutItem(root.repo, root.own, bound(root.own).length, context)
    children.push(row.withChildren([...nested(root.own), ...rootCheckoutDetails(root.repo, root.own, context)]))
  }
  for (const checkout of checkouts) {
    if (checkout === root?.own) continue
    const row = checkoutItem(checkout, bound(checkout).length, context)
    children.push(row.withChildren([...nested(checkout), ...checkoutDetails(`checkout:${checkout.id}`, checkout, context)]))
  }
  if (unresolved.length > 0) {
    const group = new WorkItem(`${parentId}/other-workers`, 'Other workers / unresolved', 'group')
    group.description = `${unresolved.length}`
    group.tooltip = 'Temporary workers with no declared target, or whose declared target is not a retained checkout here. Their destination is not guessed.'
    group.iconPath = new vscode.ThemeIcon('question')
    children.push(group.withChildren(unresolved.map(worker => workerItem(worker, context)), true))
  }
  return children
}

/**
 * The repository checkout. With a registered record it is named by the branch the record binds it to, and its state
 * comes from that record; without one it is named by whatever HEAD has checked out now.
 */
function rootCheckoutItem(repo: CheckoutRepositoryView, own: RetainedCheckoutView | undefined, boundWorkers: number, context: BuildContext): WorkItem {
  const head = repo.head
  const label = own?.record ? shortRef(own.record.ref) : head ? (head.ref ? shortRef(head.ref) : 'detached HEAD') : 'Repository checkout'
  const row = new WorkItem(`repo:${repo.id}/checkout`, label, 'checkout', { path: repo.root, ref: own?.record?.ref ?? head?.ref ?? undefined, commit: head?.commit })
  const state = own ? checkoutState(own, context) : undefined
  row.description = [head || own ? 'Repository checkout' : 'HEAD unreadable', state?.text, boundText(boundWorkers)].filter(Boolean).join(' · ')
  row.tooltip = [`Repository checkout of ${repo.id}`, repo.root, head ? `HEAD ${head.commit}` : repo.headError, `Git read ${formatTimestamp(context.snapshot.observedAt)}`].filter(Boolean).join('\n')
  row.iconPath = new vscode.ThemeIcon(state?.icon ?? (head ? 'home' : 'warning'))
  return row
}

function rootCheckoutDetails(repo: CheckoutRepositoryView, own: RetainedCheckoutView | undefined, context: BuildContext): WorkItem[] {
  const id = `repo:${repo.id}/checkout`
  if (own) return checkoutDetails(id, own, context)
  const rows = [detail(id, 'location', 'Location', repo.root, { path: repo.root })]
  if (repo.head) rows.unshift(detail(id, 'head', 'HEAD', `${repo.head.ref ? shortRef(repo.head.ref) : 'detached'} @ ${shortSha(repo.head.commit)}`, { ref: repo.head.ref ?? undefined, commit: repo.head.commit }))
  if (repo.headError) rows.push(problem(id, repo.headError))
  return rows
}

function checkoutItem(checkout: RetainedCheckoutView, boundWorkers: number, context: BuildContext): WorkItem {
  const record = checkout.record
  const row = new WorkItem(`checkout:${checkout.id}`, record ? shortRef(record.ref) : checkout.slug || checkout.id, 'checkout', {
    path: record?.path,
    ref: record?.ref,
    commit: checkout.head?.commit,
  })
  const state = checkoutState(checkout, context)
  // Only a managed checkout Hive confirmed absent leaves a stale record; an unreadable HEAD is not absence.
  const stale = record?.ownership === 'managed' && checkout.present === false
  row.description = [state.text, boundText(boundWorkers), record?.purpose].filter(Boolean).join(' · ')
  row.tooltip = [
    `Retained checkout ${checkout.id}`,
    record?.purpose,
    record?.path,
    checkout.head ? `HEAD ${checkout.head.commit}` : undefined,
    checkout.error,
    stale ? 'Remove Stale Hive Record in the context menu deletes only this record; branches stay unchanged.' : undefined,
    `Git read ${formatTimestamp(context.snapshot.observedAt)}`,
  ].filter(Boolean).join('\n')
  row.iconPath = new vscode.ThemeIcon(state.icon)
  if (stale) {
    row.checkoutId = checkout.id
    row.contextValue = `${row.contextValue} stale`
  }
  return row
}

/** A checkout that cannot be read or is off its branch says so first; its readiness then describes the past. */
function checkoutState(checkout: RetainedCheckoutView, context: BuildContext): { text: string; icon: string } {
  if (!checkout.record) return { text: 'Record unreadable', icon: 'warning' }
  if (checkout.present === false) return { text: 'Missing', icon: 'warning' }
  if (!checkout.head) return { text: 'Unavailable', icon: 'warning' }
  if (!checkout.onIntendedRef) return { text: `Off intended branch: ${checkout.head.ref ? `on ${shortRef(checkout.head.ref)}` : 'detached HEAD'}`, icon: 'warning' }
  const readiness = checkout.readiness
  if (!readiness) return { text: 'Retained', icon: 'git-branch' }
  const destination = readiness.nextTarget ? ` → ${context.branchOf(readiness.nextTarget) ?? readiness.nextTarget}` : ''
  if (readiness.headMoved) return { text: `Changed since readiness${destination}`, icon: 'warning' }
  if (readiness.state === 'ready') return { text: `${readiness.waitingFor ? 'Ready, waiting' : 'Ready'}${destination}`, icon: 'pass' }
  return { text: `${readiness.waitingFor ? 'Waiting' : 'Not ready'}${destination}`, icon: 'watch' }
}

function checkoutDetails(id: string, checkout: RetainedCheckoutView, context: BuildContext): WorkItem[] {
  const record = checkout.record
  // The problem explains an Unavailable or unreadable row, so it leads.
  const rows: WorkItem[] = checkout.error ? [problem(id, checkout.error)] : []
  const readiness = checkout.readiness
  if (readiness?.waitingFor) rows.push(detail(id, 'waiting', 'Waiting for', readiness.waitingFor))
  if (record) {
    if (readiness) {
      const head = checkout.head
      const stale = checkout.present === false ? 'checkout is missing'
        : !head ? 'checkout unavailable'
        : !checkout.onIntendedRef ? 'checkout is off its intended branch'
          : readiness.headMoved ? `HEAD is now ${shortSha(head.commit)}` : undefined
      const declared = `${readiness.state === 'ready' ? 'Ready' : 'Not ready'} at ${shortSha(readiness.commit)} · recorded ${formatTimestamp(readiness.recordedAt)}`
      const row = detail(id, 'readiness', 'Readiness', stale ? `${declared} · not current: ${stale}` : declared, { commit: readiness.commit })
      row.tooltip = 'Declared by the primary at this commit. It is not a verification result and does not say whether Git can merge it.'
      rows.push(row)
      const destination = readiness.nextTarget
      rows.push(detail(id, 'next', 'Integrates into', destination ? `${context.branchOf(destination) ?? 'unknown checkout'} (${destination})` : 'Not declared'))
    } else {
      rows.push(detail(id, 'readiness', 'Readiness', 'Not recorded'))
    }
    if (record.purpose) rows.push(detail(id, 'purpose', 'Purpose', record.purpose))
  }
  if (checkout.head) {
    const intended = checkout.onIntendedRef === false && record ? `, intended ${shortRef(record.ref)}` : ''
    rows.push(detail(id, 'head', 'HEAD', `${checkout.head.ref ? shortRef(checkout.head.ref) : 'detached'} @ ${shortSha(checkout.head.commit)}${intended}`, { ref: checkout.head.ref ?? undefined, commit: checkout.head.commit }))
  }
  if (record) {
    rows.push(detail(id, 'location', 'Location', record.path, { path: record.path }))
    rows.push(detail(id, 'created', 'Created', `${formatTimestamp(record.created.at)} at ${shortSha(record.created.commit)} · ${record.ownership}`, { commit: record.created.commit }))
  }
  const recordFile = path.join(context.projectRoot, '.hive', 'checkouts', checkout.repoId, `${checkout.slug}.json`)
  if (checkout.repoId && checkout.slug && fs.existsSync(recordFile)) rows.push(link(id, 'record', 'Checkout record', fileCommand(recordFile)))
  return rows
}

function workerItem(worker: CheckoutWorkerView, context: BuildContext): WorkItem {
  const id = `worker:${worker.path}`
  const live = worker.retained === undefined
  const commit = worker.head ?? worker.retained?.branchCommit ?? undefined
  const row = new WorkItem(id, workerLabel(worker), 'worker', { path: live ? worker.path : undefined, ref: worker.branch ? `refs/heads/${worker.branch}` : undefined, commit })
  const activity = workerActivity(worker, context)
  const state = worker.error ? 'unreadable'
    : worker.retained ? (worker.retained.branchCommit ? 'worktree removed, branch kept' : 'worktree and branch removed')
      : undefined
  row.description = [state, describeActivity(activity), worker.branch].filter(Boolean).join(' · ')
  row.tooltip = [
    worker.kind === 'task' ? `Task worker ${worker.feature}/${worker.task}${worker.candidate ? ` (candidate ${worker.candidate})` : ''}` : `Ad-hoc run ${worker.runId}`,
    worker.path,
    worker.error,
    `Git read ${formatTimestamp(context.snapshot.observedAt)}`,
  ].filter(Boolean).join('\n')
  row.iconPath = new vscode.ThemeIcon(worker.error ? 'warning' : worker.retained ? 'git-branch' : 'repo-forked')

  const rows: WorkItem[] = []
  if (worker.kind === 'task' && worker.feature) rows.push(detail(id, 'feature', 'Feature', worker.feature))
  rows.push(detail(id, 'branch', 'Branch', worker.branch ? `${worker.branch}${commit ? ` @ ${shortSha(commit)}` : ''}` : 'Unknown', { ref: worker.branch ? `refs/heads/${worker.branch}` : undefined, commit }))
  rows.push(detail(id, 'location', 'Location', live ? worker.path : `${worker.path} (removed)`, live ? { path: worker.path } : {}))
  rows.push(detail(id, 'target', 'Target', worker.target ? `${shortRef(worker.target.ref)} (${worker.target.id})` : 'None declared'))
  if (worker.baseCommit) {
    const start = detail(id, 'start', 'Started from', shortSha(worker.baseCommit), { commit: worker.baseCommit })
    start.tooltip = 'The commit this worker started from. It is not a merge destination.'
    rows.push(start)
  }
  if (worker.error) rows.push(problem(id, worker.error))
  rows.push(...activityRows(id, activity))
  rows.push(...workerLinks(id, worker, context))
  return row.withChildren(rows)
}

function workerLabel(worker: CheckoutWorkerView): string {
  if (worker.kind === 'adhoc') return worker.runId ?? 'Unknown run'
  return `${worker.task ?? 'Unknown task'}${worker.candidate ? ` (${worker.candidate})` : ''}`
}

interface WorkerActivity {
  sessions: OwnedSession[]
  /** Other placements that share, or cannot be ruled out from sharing, this worker's binding; non-empty means records cannot be attributed. */
  ambiguousWith: string[]
  unreadable: string[]
  /** Feature names (this worker's, or those of records naming its task) that could not be resolved, with the cause. */
  unresolved: Map<string, string>
}

function workerActivity(worker: CheckoutWorkerView, context: BuildContext): WorkerActivity {
  const { activity, placements, featureOf } = context.snapshot
  const unresolved = new Map<string, string>()
  const directoryOf = (name: string | null | undefined) => {
    const identity = featureOf(name)
    if (name && identity?.directory === null && identity.error) unresolved.set(name, identity.error)
    return identity?.directory ?? null
  }
  const key = bindingKey(worker, featureOf)
  if (!key) {
    if (worker.kind === 'task') directoryOf(worker.feature)
    return { sessions: [], ambiguousWith: [], unreadable: activity.unreadable, unresolved }
  }
  const own = placementOf(context.projectRoot, worker)
  const unresolvedPeers = worker.kind === 'task' && worker.task ? placements.get(unresolvedTaskKey(worker.task)) ?? [] : []
  const ambiguousWith = [...(placements.get(key) ?? []), ...unresolvedPeers].filter(placement => placement !== own)
  const feature = directoryOf(worker.feature)
  // A record resolves its feature only once its task matches, so a failure affects only workers of that task.
  const sessionMatches = worker.kind === 'task'
    ? ({ session }: OwnedSession) => session.taskFolder === worker.task && directoryOf(session.featureName) === feature
    : ({ session }: OwnedSession) => session.adHocRunId === worker.runId
  return {
    sessions: activity.sessions.filter(sessionMatches).sort((a, b) => b.session.lastActiveAt.localeCompare(a.session.lastActiveAt)),
    ambiguousWith,
    unreadable: activity.unreadable,
    unresolved,
  }
}

function describeActivity(activity: WorkerActivity): string {
  if (activity.ambiguousWith.length > 0) return 'activity ambiguous'
  const latest = activity.sessions[0]
  if (latest) return `last session update ${describeAge(latest.session.lastActiveAt)}`
  return activity.unreadable.length + activity.unresolved.size > 0 ? 'activity unknown' : 'no recorded activity'
}

function activityRows(parentId: string, activity: WorkerActivity): WorkItem[] {
  if (activity.ambiguousWith.length > 0) {
    const row = detail(parentId, 'activity', 'Activity', 'Ambiguous: sessions for this task are not attributed')
    row.tooltip = `Another placement shares this task binding, or names this task under a feature that could not be resolved, and records do not name the placement:\n${activity.ambiguousWith.join('\n')}`
    row.iconPath = new vscode.ThemeIcon('question')
    return [row]
  }
  const rows: WorkItem[] = []
  for (const { owner, session } of activity.sessions) {
    const row = new WorkItem(`${parentId}/session:${owner}:${session.sessionId}`, `Session ${session.sessionId}`, 'activity')
    row.description = [session.agent || session.baseAgent, `last update ${describeAge(session.lastActiveAt)}`, getNativeObservationOwnerLabel(owner)].filter(Boolean).join(' · ')
    row.tooltip = `Session update recorded ${formatTimestamp(session.lastActiveAt)} by ${getNativeObservationOwnerLabel(owner)}. A recorded update does not show that the session is still running.`
    row.iconPath = new vscode.ThemeIcon('comment-discussion')
    rows.push(row)
  }
  if (rows.length === 0) {
    const unknown = [...activity.unreadable, ...[...activity.unresolved.keys()].map(name => `feature "${name}" metadata`)]
    const row = detail(parentId, 'activity', 'Activity', unknown.length > 0 ? `Unknown: ${unknown.join(', ')} unreadable` : 'No recorded session')
    row.tooltip = unknown.length > 0
      ? [
        'A session store, or the feature metadata needed to match records to this task, could not be read, so activity for this worker is unknown.',
        ...[...activity.unresolved].map(([name, error]) => `Feature "${name}": ${error}`),
      ].join('\n')
      : 'No stored session names this task or run.'
    rows.push(row)
  }
  return rows
}

function workerLinks(parentId: string, worker: CheckoutWorkerView, context: BuildContext): WorkItem[] {
  if (worker.kind !== 'task' || !worker.feature || !worker.task) return []
  const rows: WorkItem[] = []
  try {
    const spec = getTaskSpecPath(context.projectRoot, worker.feature, worker.task)
    const report = getTaskReportPath(context.projectRoot, worker.feature, worker.task)
    if (fs.existsSync(spec)) rows.push(link(parentId, 'spec', 'Task spec', fileCommand(spec)))
    if (fs.existsSync(report)) rows.push(link(parentId, 'report', 'Latest report', fileCommand(report)))
  } catch {
    // The feature cannot be resolved (missing or ambiguous directory); the worker row stays without file links.
  }
  // Worklog refs take the logical name from feature metadata, never the directory spelling the worker was placed under.
  const identity = context.snapshot.featureOf(worker.feature)
  if (identity?.logicalName) {
    const key = getWorklogKey({ kind: 'feature', featureName: identity.logicalName })
    rows.push(link(parentId, 'worklog', 'Feature worklog', { command: 'hive.worklog.open', title: 'Open Worklog', arguments: [key] }))
  } else {
    rows.push(detail(parentId, 'worklog', 'Feature worklog', `Unknown: ${identity?.error ?? 'feature metadata has no valid name'}`))
  }
  return rows
}

function detail(parentId: string, key: string, label: string, value: string, location: RowLocation = {}): WorkItem {
  const row = new WorkItem(`${parentId}/${key}`, label, 'detail', location)
  row.description = value
  row.tooltip = value
  return row
}

function problem(parentId: string, reason: string): WorkItem {
  const row = detail(parentId, 'problem', 'Problem', reason)
  row.iconPath = new vscode.ThemeIcon('warning')
  return row
}

function link(parentId: string, key: string, label: string, command: vscode.Command): WorkItem {
  const row = new WorkItem(`${parentId}/${key}`, label, 'link')
  row.command = command
  row.iconPath = new vscode.ThemeIcon(key === 'worklog' ? 'book' : 'go-to-file')
  return row
}

function fileCommand(filePath: string): vscode.Command {
  return { command: 'vscode.open', title: 'Open File', arguments: [vscode.Uri.file(filePath)] }
}

function allWorkers(projection: CheckoutProjection): CheckoutWorkerView[] {
  return [...projection.repositories.flatMap(repo => repo.workers), ...projection.unassigned.workers]
}

/** The task or run a worker serves; session records name only this, never a placement. */
function bindingKey(worker: CheckoutWorkerView, featureOf: FeatureResolver): string | null {
  if (worker.kind === 'adhoc') return worker.runId ? `run:${worker.runId}` : null
  const feature = featureOf(worker.feature)?.directory
  return feature && worker.task ? `task:${feature}/${worker.task}` : null
}

/** Placements of a task whose feature did not resolve; any of them may be the same binding as a resolved one. */
function unresolvedTaskKey(task: string): string {
  return `task?:${task}`
}

/**
 * Workers are placed under the feature name their caller passed, and records may use the other spelling, so every
 * join compares the directory the name resolves to. Names resolve once per read, keeping any failure's cause.
 */
function featureResolver(projectRoot: string): FeatureResolver {
  const resolved = new Map<string, FeatureIdentity | null>()
  return name => {
    if (typeof name !== 'string') return null
    if (!resolved.has(name)) resolved.set(name, resolveFeature(projectRoot, name))
    return resolved.get(name)!
  }
}

/**
 * The directory a name joins on. Unreadable or ambiguous metadata could hide which feature a logical name means, so
 * such a name has no directory and its records stay unattributed. A name that is exactly the directory whose metadata
 * is unreadable identifies that directory only while no other directory claims the name, by readable metadata or by
 * its indexed spelling; the unreadable metadata itself is never consulted. Only a name no metadata-backed feature
 * claims keeps the legacy lookup.
 */
function resolveFeature(projectRoot: string, name: string): FeatureIdentity | null {
  if (!FEATURE_NAME_PATTERN.test(name)) return null
  let directory: string
  try {
    directory = path.basename(resolveExistingFeaturePath(projectRoot, name))
  } catch (error) {
    const exactUnreadable = error instanceof FeatureResolutionError && error.reason === 'unreadable'
      && error.directories.length === 1 && error.directories[0] === name
    if (exactUnreadable) {
      let claimants: string[]
      try {
        claimants = listFeatureDirectories(projectRoot)
          .filter(entry => entry.directoryName !== name && entry.logicalName === name)
          .map(entry => entry.directoryName)
      } catch (scanError) {
        return { directory: null, logicalName: null, error: `${message(error)}; ${message(scanError)}` }
      }
      if (claimants.length === 0) return { directory: name, logicalName: null, error: message(error) }
      return { directory: null, logicalName: null, error: `${message(error)}; '${name}' is also claimed by ${claimants.map(claimant => `'${claimant}'`).join(', ')}` }
    }
    if (!(error instanceof FeatureResolutionError) || error.reason !== 'not_found') {
      return { directory: null, logicalName: null, error: message(error) }
    }
    try {
      directory = resolveFeatureDirectoryName(projectRoot, name)
    } catch (fallbackError) {
      return { directory: null, logicalName: null, error: message(fallbackError) }
    }
  }
  try {
    const logical = readJson<FeatureJson>(path.join(getFeaturesPath(projectRoot), directory, 'feature.json'))?.name
    return { directory, logicalName: typeof logical === 'string' && FEATURE_NAME_PATTERN.test(logical) ? logical : null }
  } catch (error) {
    return { directory, logicalName: null, error: message(error) }
  }
}

/** One placement per worker directory, so the repositories of one composite workspace count once. */
function placementOf(projectRoot: string, worker: CheckoutWorkerView): string {
  const relative = path.relative(path.join(projectRoot, '.hive', '.worktrees'), worker.path).split(path.sep)
  return relative[0] === '..' || relative.length < 2 ? worker.path : relative.slice(0, 2).join('/')
}

function compareWorkers(left: CheckoutWorkerView, right: CheckoutWorkerView): number {
  const key = (worker: CheckoutWorkerView) => [worker.kind, worker.feature ?? '', worker.task ?? '', worker.candidate ?? '', worker.runId ?? '', worker.path].join('\0')
  return key(left).localeCompare(key(right))
}

async function readActivityStores(projectRoot: string): Promise<ActivityStores> {
  const stores: ActivityStores = { sessions: [], unreadable: [] }
  // Read directly rather than through the session service, which resets a corrupt index; a viewer must not write.
  await Promise.all(NATIVE_OBSERVATION_OWNERS.map(async owner => {
    const label = getNativeObservationOwnerLabel(owner)
    const sessions = await readSessionRecords(getNativeSessionsPath(projectRoot, owner))
    if (sessions) stores.sessions.push(...sessions.map(session => ({ owner, session })))
    else stores.unreadable.push(`${label} sessions`)
  }))
  stores.unreadable.sort()
  return stores
}

/** A missing registry has no sessions; an unparsable registry or one with a malformed session is unreadable (null). */
async function readSessionRecords(filePath: string): Promise<SessionInfo[] | null> {
  let raw: string
  try {
    raw = await fs.promises.readFile(filePath, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
  }
  try {
    const sessions = (JSON.parse(raw) as Record<string, unknown>)?.sessions
    return Array.isArray(sessions) && sessions.every(isSession) ? sessions : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Checks only the fields this view joins on or prints; a stored value of another type makes the store unreadable. */
function optionalStrings(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => record[key] === undefined || typeof record[key] === 'string')
}

function isSession(value: unknown): value is SessionInfo {
  return isRecord(value) && typeof value.sessionId === 'string' && typeof value.lastActiveAt === 'string'
    && (value.featureName === null || optionalStrings(value, ['featureName']))
    && optionalStrings(value, ['taskFolder', 'adHocRunId', 'agent', 'baseAgent'])
}

function countText(checkouts: number, workers: number): string {
  return [checkouts ? `${checkouts} retained` : undefined, workers ? `${workers} worker${workers === 1 ? '' : 's'}` : undefined].filter(Boolean).join(' · ')
}

/** Workers whose recorded target is this checkout; a count of bindings, not of running work. */
function boundText(count: number): string | undefined {
  return count ? `${count} bound worker${count === 1 ? '' : 's'}` : undefined
}

function shortRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

function shortSha(commit: string): string {
  return commit.slice(0, 7)
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The structured location a row carries, read from a command argument; anything else selects nothing. */
function locationOf(item: unknown): RowLocation {
  const location = (item as { location?: unknown } | undefined)?.location
  if (!isRecord(location)) return {}
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)
  return { path: text(location.path), ref: text(location.ref), commit: text(location.commit) }
}

/** Opens a row's checkout directory in a new window; the current window and its extension host stay as they are. */
export async function openInNewWindow(item: unknown): Promise<void> {
  const target = locationOf(item).path
  if (!target || !isDirectory(target)) {
    vscode.window.showWarningMessage('Hive: This row has no checkout directory to open.')
    return
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true })
}

/** Starts a terminal whose working directory is the row's checkout; no command text is sent to it. */
export function openTerminal(item: unknown): void {
  const target = locationOf(item).path
  if (!target || !isDirectory(target)) {
    vscode.window.showWarningMessage('Hive: This row has no checkout directory to open a terminal in.')
    return
  }
  vscode.window.createTerminal({ name: `Hive: ${path.basename(target)}`, cwd: target }).show()
}

export async function copyLocation(item: unknown, key: keyof RowLocation): Promise<void> {
  const value = locationOf(item)[key]
  const noun = key === 'ref' ? 'branch' : key === 'commit' ? 'commit SHA' : 'path'
  if (!value) {
    vscode.window.showWarningMessage(`Hive: This row has no ${noun} to copy.`)
    return
  }
  await vscode.env.clipboard.writeText(key === 'ref' ? shortRef(value) : value)
  vscode.window.showInformationMessage(`Hive: copied ${noun}.`)
}
