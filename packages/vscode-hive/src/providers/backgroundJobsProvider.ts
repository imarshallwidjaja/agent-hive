import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import type { BackgroundJobRecord, BackgroundJobsJson } from 'hive-core'
import { isBackgroundJobArchived } from 'hive-core'

type BackgroundJobsItem = BackgroundJobGroupItem | BackgroundJobItem | BackgroundJobsStateItem
type BackgroundJobGroupLabel = 'Running' | 'Needs Reconciliation' | 'Cancel Requested' | 'Stale / Uncertain' | 'Ignored' | 'Reconciled' | 'Finished'

interface BackgroundJobPresentation {
  groupLabel: BackgroundJobGroupLabel
  statusLabel?: string
  iconId: string
}

class BackgroundJobGroupItem extends vscode.TreeItem {
  constructor(
    public readonly groupName: string,
    public readonly jobs: BackgroundJobRecord[],
    collapsed: boolean = false
  ) {
    super(groupName, collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded)
    this.description = `${jobs.length} job(s)`
    this.contextValue = 'background-job-group'
    this.iconPath = new vscode.ThemeIcon('list-tree')
  }
}

class BackgroundJobItem extends vscode.TreeItem {
  public readonly taskId: string
  public readonly alias: string
  public readonly copyCommand: vscode.Command

  constructor(job: BackgroundJobRecord, workspaceRoot: string, boardPath: string) {
    const presentation = getJobPresentation(job)
    super(job.alias || job.taskId, vscode.TreeItemCollapsibleState.None)
    this.taskId = job.taskId
    this.alias = job.alias
    this.description = [job.agentName, job.runtimeState, presentation.statusLabel || job.objective || job.description]
      .filter(Boolean)
      .join(' · ')
    this.tooltip = getJobTooltip(job)
    this.contextValue = isBackgroundJobArchived(job) ? 'background-job-archived' : 'background-job-archiveable'
    this.iconPath = new vscode.ThemeIcon(presentation.iconId)
    const relatedPath = getRelatedPath(job, workspaceRoot)
    this.command = relatedPath
      ? {
          command: 'hive.openFile',
          title: 'Open Background Job Context',
          arguments: [relatedPath],
        }
      : {
          command: 'hive.openBackgroundJobInBoard',
          title: 'Open Background Job Record',
          arguments: [boardPath, job.taskId],
        }
    this.copyCommand = {
      command: 'hive.copyToClipboard',
      title: 'Copy Background Job ID',
      arguments: [job.taskId],
    }
  }
}

class BackgroundJobsStateItem extends vscode.TreeItem {
  constructor(label: string, description: string, boardPath?: string) {
    super(label, vscode.TreeItemCollapsibleState.None)
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
      return element.jobs.map(job => new BackgroundJobItem(job, this.workspaceRoot, this.boardPath()))
    }

    if (element) {
      return []
    }

    const boardPath = this.boardPath()
    if (!fs.existsSync(boardPath)) {
      return [new BackgroundJobsStateItem('No background jobs', 'Missing .hive/background-jobs.json')]
    }

    let board: BackgroundJobsJson
    try {
      board = JSON.parse(fs.readFileSync(boardPath, 'utf-8'))
    } catch {
      return [new BackgroundJobsStateItem('Unable to read background jobs', 'Invalid .hive/background-jobs.json', boardPath)]
    }

    const jobs = Array.isArray(board.jobs) ? board.jobs : []
    if (jobs.length === 0) {
      return [new BackgroundJobsStateItem('No background jobs', '0 jobs', boardPath)]
    }

    return this.getGroups(jobs)
  }

  private getGroups(jobs: BackgroundJobRecord[]): BackgroundJobGroupItem[] {
    const groups: Array<{ label: BackgroundJobGroupLabel; jobs: BackgroundJobRecord[]; collapsed: boolean }> = [
      { label: 'Running', jobs: [], collapsed: false },
      { label: 'Needs Reconciliation', jobs: [], collapsed: false },
      { label: 'Cancel Requested', jobs: [], collapsed: false },
      { label: 'Stale / Uncertain', jobs: [], collapsed: false },
      { label: 'Ignored', jobs: [], collapsed: true },
      { label: 'Reconciled', jobs: [], collapsed: true },
      { label: 'Finished', jobs: [], collapsed: true },
    ]
    const groupsByLabel = new Map(groups.map(group => [group.label, group]))

    for (const job of jobs) {
      groupsByLabel.get(getJobPresentation(job).groupLabel)?.jobs.push(job)
    }

    return groups
      .filter(group => group.jobs.length > 0)
      .map(group => new BackgroundJobGroupItem(group.label, group.jobs, group.collapsed))
  }

  private boardPath(): string {
    return path.join(this.workspaceRoot, '.hive', 'background-jobs.json')
  }
}

function getRelatedPath(job: BackgroundJobRecord, workspaceRoot: string): string | null {
  const relatedPath = job.ownership?.workerPromptPath ?? job.ownership?.worktreePath
  if (!relatedPath) return null
  return path.isAbsolute(relatedPath) ? relatedPath : path.resolve(workspaceRoot, relatedPath)
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

function getJobTooltip(job: BackgroundJobRecord): string {
  const lines = [
    `Task ID: ${job.taskId}`,
    `Alias: ${job.alias}`,
    `Agent: ${job.agentName}`,
    `Runtime: ${job.runtimeState}`,
    job.objective ? `Objective: ${job.objective}` : undefined,
    job.description ? `Description: ${job.description}` : undefined,
    job.cancelReason ? `Cancel reason: ${job.cancelReason}` : undefined,
    job.resultSummary ? `Result: ${job.resultSummary}` : undefined,
    job.scope?.feature ? `Feature: ${job.scope.feature}` : undefined,
    job.scope?.task ? `Task: ${job.scope.task}` : undefined,
    job.ownership?.worktreePath ? `Worktree: ${job.ownership.worktreePath}` : undefined,
    job.ownership?.workerPromptPath ? `Worker prompt: ${job.ownership.workerPromptPath}` : undefined,
  ]

  return lines.filter(Boolean).join('\n')
}
