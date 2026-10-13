import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import type { BackgroundJobRecord, BackgroundJobsJson, NativeObservationOwner } from 'hive-core'
import {
  BackgroundJobService,
  DEFAULT_NATIVE_OBSERVATION_OWNER,
  NATIVE_OBSERVATION_OWNERS,
  getNativeBackgroundJobsPath,
  getNativeObservationOwnerLabel,
  isBackgroundJobArchived,
  isNativeObservationOwner,
} from 'hive-core'

type BackgroundJobsItem = BackgroundJobGroupItem | BackgroundJobItem | BackgroundJobsStateItem
type BackgroundJobGroupLabel = 'Running' | 'Needs Reconciliation' | 'Cancel Requested' | 'Stale / Uncertain' | 'Ignored' | 'Reconciled' | 'Finished'

/** A job together with the native host whose board holds it; equal aliases from different owners stay distinct records. */
interface OwnedBackgroundJob {
  owner: NativeObservationOwner
  job: BackgroundJobRecord
}

type BoardRead =
  | { owner: NativeObservationOwner; boardPath: string; state: 'missing' }
  | { owner: NativeObservationOwner; boardPath: string; state: 'invalid' }
  | { owner: NativeObservationOwner; boardPath: string; state: 'ok'; jobs: BackgroundJobRecord[] }

interface BackgroundJobPresentation {
  groupLabel: BackgroundJobGroupLabel
  statusLabel?: string
  iconId: string
}

class BackgroundJobGroupItem extends vscode.TreeItem {
  constructor(
    public readonly groupName: string,
    public readonly jobs: OwnedBackgroundJob[],
    collapsed: boolean = false
  ) {
    super(groupName, collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded)
    this.id = `background-job-group:${groupName}`
    this.description = `${jobs.length} job(s)`
    this.contextValue = 'background-job-group'
    this.iconPath = new vscode.ThemeIcon('list-tree')
  }
}

class BackgroundJobItem extends vscode.TreeItem {
  public readonly taskId: string
  public readonly alias: string
  public readonly owner: NativeObservationOwner
  public readonly copyCommand: vscode.Command

  constructor({ job, owner }: OwnedBackgroundJob) {
    const presentation = getJobPresentation(job)
    super(job.alias, vscode.TreeItemCollapsibleState.None)
    // Tree-wide identity keeps selection and focus on the same record across refreshes and group moves.
    // Owners never contain ':', so owner plus exact alias cannot collide with another row or with group/state ids.
    this.id = `background-job:${owner}:${job.alias}`
    this.taskId = job.taskId
    this.alias = job.alias
    this.owner = owner
    // Jobs from the long-standing board keep their familiar row text; other owners name their host inline.
    this.description = [job.agentName, job.runtimeState, presentation.statusLabel || job.description, ownerNote(owner)]
      .filter(Boolean)
      .join(' · ')
    this.tooltip = getJobTooltip(job, owner)
    this.contextValue = isBackgroundJobArchived(job) ? 'background-job-archived' : 'background-job-archiveable'
    this.iconPath = new vscode.ThemeIcon(presentation.iconId)
    this.command = {
      command: 'hive.openBackgroundJobInBoard',
      title: 'Open Background Job Record',
      arguments: [owner, job.alias],
    }
    this.copyCommand = {
      command: 'hive.copyToClipboard',
      title: 'Copy Background Job Alias',
      arguments: [job.alias],
    }
  }
}

class BackgroundJobsStateItem extends vscode.TreeItem {
  constructor(id: string, label: string, description: string, boardPath?: string) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.id = `background-jobs-state:${id}`
    this.description = description
    this.contextValue = 'background-jobs-state'
    this.iconPath = new vscode.ThemeIcon('info')
    if (boardPath) {
      this.command = {
        command: 'hive.openFile',
        title: 'Open Background Jobs File',
        arguments: [boardPath],
      }
    }
  }
}

export class BackgroundJobsProvider implements vscode.TreeDataProvider<BackgroundJobsItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BackgroundJobsItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private workspaceRoot: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(element: BackgroundJobsItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: BackgroundJobsItem): Promise<BackgroundJobsItem[]> {
    if (element instanceof BackgroundJobGroupItem) {
      return element.jobs.map(owned => new BackgroundJobItem(owned))
    }

    if (element) {
      return []
    }

    // Each owner's board is read on its own so an unreadable one is reported without hiding the others.
    const boards = NATIVE_OBSERVATION_OWNERS.map(owner => this.readBoard(owner))
    const jobs: OwnedBackgroundJob[] = boards.flatMap(board =>
      board.state === 'ok' ? board.jobs.map(job => ({ owner: board.owner, job })) : []
    )
    const unreadable = boards
      .filter(board => board.state === 'invalid')
      .map(board => new BackgroundJobsStateItem(`invalid:${board.owner}`, 'Unable to read background jobs', `Invalid ${this.displayPath(board.boardPath)}`, board.boardPath))

    if (jobs.length > 0) {
      return [...this.getGroups(jobs), ...unreadable]
    }
    if (unreadable.length > 0) {
      return unreadable
    }

    const emptyBoard = boards.find(board => board.state === 'ok')
    if (emptyBoard) {
      return [new BackgroundJobsStateItem(`empty:${emptyBoard.owner}`, 'No background jobs', '0 jobs', emptyBoard.boardPath)]
    }
    return [new BackgroundJobsStateItem('missing', 'No background jobs', `Missing ${this.displayPath(this.boardPath(DEFAULT_NATIVE_OBSERVATION_OWNER))}`)]
  }

  private readBoard(owner: NativeObservationOwner): BoardRead {
    const boardPath = this.boardPath(owner)
    if (!fs.existsSync(boardPath)) {
      return { owner, boardPath, state: 'missing' }
    }
    try {
      const board: BackgroundJobsJson = JSON.parse(fs.readFileSync(boardPath, 'utf-8'))
      const jobs: unknown[] = Array.isArray(board.jobs) ? board.jobs : []
      return hasRenderableJobs(jobs) ? { owner, boardPath, state: 'ok', jobs } : { owner, boardPath, state: 'invalid' }
    } catch {
      return { owner, boardPath, state: 'invalid' }
    }
  }

  private getGroups(jobs: OwnedBackgroundJob[]): BackgroundJobGroupItem[] {
    const groups: Array<{ label: BackgroundJobGroupLabel; jobs: OwnedBackgroundJob[]; collapsed: boolean }> = [
      { label: 'Running', jobs: [], collapsed: false },
      { label: 'Needs Reconciliation', jobs: [], collapsed: false },
      { label: 'Cancel Requested', jobs: [], collapsed: false },
      { label: 'Stale / Uncertain', jobs: [], collapsed: false },
      { label: 'Ignored', jobs: [], collapsed: true },
      { label: 'Reconciled', jobs: [], collapsed: true },
      { label: 'Finished', jobs: [], collapsed: true },
    ]
    const groupsByLabel = new Map(groups.map(group => [group.label, group]))

    for (const owned of jobs) {
      groupsByLabel.get(getJobPresentation(owned.job).groupLabel)?.jobs.push(owned)
    }

    return groups
      .filter(group => group.jobs.length > 0)
      .map(group => new BackgroundJobGroupItem(group.label, group.jobs, group.collapsed))
  }

  private boardPath(owner: NativeObservationOwner): string {
    return getNativeBackgroundJobsPath(this.workspaceRoot, owner)
  }

  private displayPath(filePath: string): string {
    return path.relative(this.workspaceRoot, filePath).split(path.sep).join('/')
  }
}

/** The job a row action targets: the native owner and the exact alias within that owner's board. */
export interface BackgroundJobTarget {
  owner: NativeObservationOwner
  alias: string
}

/** Reads the owner and alias a background job row carries; anything else cannot select a board. */
export function readBackgroundJobTarget(item: unknown): BackgroundJobTarget | undefined {
  const { owner, alias } = (item ?? {}) as { owner?: unknown; alias?: unknown }
  return isNativeObservationOwner(owner) && typeof alias === 'string' && alias !== '' ? { owner, alias } : undefined
}

/**
 * Archives one job row on its own owner's board after operator confirmation. The target is read before any prompt,
 * so a record that changes or disappears meanwhile is reported as a failure and never retried on another owner.
 */
export async function archiveBackgroundJobItem(workspaceRoot: string, item: unknown, refresh: () => void): Promise<void> {
  const target = readBackgroundJobTarget(item)
  if (!target) {
    vscode.window.showErrorMessage('Hive: No background job selected')
    return
  }

  const label = `"${target.alias}" (${getNativeObservationOwnerLabel(target.owner)})`
  const confirmResult = await vscode.window.showWarningMessage(
    `Archive background job ${label}? This moves it to the collapsed Ignored group and hides it from normal agent tooling. It does not cancel or kill any running process.`,
    { modal: true },
    'Archive Job'
  )
  if (confirmResult !== 'Archive Job') return

  const reason = await vscode.window.showInputBox({
    prompt: 'Reason for archiving (optional)',
    placeHolder: 'e.g., Operator archived stale lane'
  })
  if (reason === undefined) return

  try {
    new BackgroundJobService(workspaceRoot, target.owner).markIgnored(target.alias, reason || 'Operator archived')
    vscode.window.showInformationMessage(`Hive: Background job ${label} archived.`)
  } catch (error) {
    vscode.window.showErrorMessage(`Hive: Could not archive background job ${label} - ${error instanceof Error ? error.message : String(error)}`)
  }
  refresh()
}

/**
 * Every row is addressed by its alias: the alias forms the row id and selects the record for open and archive.
 * The row description and tooltip interpolate the other fields checked here, and interpolating a JSON object such as
 * `{ "toString": 0 }` throws while the tree renders. A board whose rows are not objects with distinct non-empty aliases
 * and string text in those fields is damaged and shown as unreadable.
 */
function hasRenderableJobs(jobs: unknown[]): jobs is BackgroundJobRecord[] {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string'
  const aliases = new Set<string>()
  for (const job of jobs) {
    if (!isObject(job)) return false
    const { alias, taskId, agentName, runtimeState, description, cancelReason, resultSummary, scope } = job
    if (typeof alias !== 'string' || alias === '' || aliases.has(alias)) return false
    if (typeof taskId !== 'string' || typeof agentName !== 'string' || typeof runtimeState !== 'string') return false
    if (!isOptionalString(description) || !isOptionalString(cancelReason) || !isOptionalString(resultSummary)) return false
    if (scope !== undefined && !(isObject(scope) && isOptionalString(scope.feature) && isOptionalString(scope.task))) return false
    aliases.add(alias)
  }
  return true
}

function ownerNote(owner: NativeObservationOwner): string | undefined {
  return owner === DEFAULT_NATIVE_OBSERVATION_OWNER ? undefined : getNativeObservationOwnerLabel(owner)
}

function getJobPresentation(job: BackgroundJobRecord): BackgroundJobPresentation {
  const cancellationHistory = job.cancelRequestedAt ? 'cancel requested' : undefined

  if (job.ignoredAt || job.archiveReason === 'ignored') {
    return {
      groupLabel: 'Ignored',
      statusLabel: ['ignored', cancellationHistory].filter(Boolean).join(' · '),
      iconId: 'circle-slash',
    }
  }

  if (job.reconciledAt || job.archiveReason === 'reconciled') {
    return {
      groupLabel: 'Reconciled',
      statusLabel: ['reconciled', cancellationHistory].filter(Boolean).join(' · '),
      iconId: 'check',
    }
  }

  if (isBackgroundJobArchived(job)) {
    return {
      groupLabel: 'Ignored',
      statusLabel: 'archived',
      iconId: 'circle-slash',
    }
  }

  if (job.terminalUnreconciled) {
    return {
      groupLabel: 'Needs Reconciliation',
      statusLabel: 'needs reconciliation',
      iconId: 'warning',
    }
  }

  if (job.cancelRequestedAt && !isTerminalRuntimeState(job.runtimeState)) {
    return {
      groupLabel: 'Cancel Requested',
      statusLabel: 'cancel requested',
      iconId: 'debug-stop',
    }
  }

  if (job.staleAt || job.statusUncertain) {
    return {
      groupLabel: 'Stale / Uncertain',
      statusLabel: ['stale/uncertain', cancellationHistory].filter(Boolean).join(' · '),
      iconId: 'question',
    }
  }

  if (job.runtimeState === 'running') {
    return {
      groupLabel: 'Running',
      iconId: 'sync~spin',
    }
  }

  return {
    groupLabel: 'Finished',
    statusLabel: cancellationHistory,
    iconId: getTerminalIcon(job),
  }
}

function isTerminalRuntimeState(state: BackgroundJobRecord['runtimeState']): boolean {
  return state === 'completed' || state === 'error' || state === 'cancelled'
}

function getTerminalIcon(job: BackgroundJobRecord): string {
  if (job.runtimeState === 'error') return 'error'
  if (job.runtimeState === 'cancelled') return 'circle-slash'
  if (job.runtimeState === 'unknown') return 'question'
  return 'check'
}

function getJobTooltip(job: BackgroundJobRecord, owner: NativeObservationOwner): string {
  const lines = [
    `Task ID: ${job.taskId}`,
    `Alias: ${job.alias}`,
    `Host: ${getNativeObservationOwnerLabel(owner)}`,
    `Agent: ${job.agentName}`,
    `Runtime: ${job.runtimeState}`,
    job.description ? `Description: ${job.description}` : undefined,
    job.cancelReason ? `Cancel reason: ${job.cancelReason}` : undefined,
    job.resultSummary ? `Result: ${job.resultSummary}` : undefined,
    job.scope?.feature ? `Feature: ${job.scope.feature}` : undefined,
    job.scope?.task ? `Task: ${job.scope.task}` : undefined,
  ]

  return lines.filter(Boolean).join('\n')
}
