import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import type { BackgroundJobRecord, BackgroundJobsJson } from 'hive-core'

type BackgroundJobsItem = BackgroundJobGroupItem | BackgroundJobItem | BackgroundJobsStateItem

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
  public readonly copyCommand: vscode.Command

  constructor(job: BackgroundJobRecord, workspaceRoot: string, private readonly boardPath: string) {
    super(job.alias || job.taskId, vscode.TreeItemCollapsibleState.None)
    this.description = [job.agentName, job.runtimeState, getCoordinationStatus(job) || job.objective || job.description]
      .filter(Boolean)
      .join(' · ')
    this.tooltip = getJobTooltip(job)
    this.contextValue = 'background-job'
    this.iconPath = new vscode.ThemeIcon(getJobIcon(job))
    this.command = {
      command: 'hive.openFile',
      title: 'Open Background Job Context',
      arguments: [getRelatedPath(job, workspaceRoot) ?? this.boardPath],
    }
    this.copyCommand = {
      command: 'hive.copyToClipboard',
      title: 'Copy Background Job ID',
      arguments: [job.taskId],
    }
  }
}

class BackgroundJobsStateItem extends vscode.TreeItem {
  constructor(label: string, description: string, boardPath: string) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.description = description
    this.contextValue = 'background-jobs-state'
    this.iconPath = new vscode.ThemeIcon('info')
    this.command = {
      command: 'hive.openFile',
      title: 'Open Background Jobs File',
      arguments: [boardPath],
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
      return [new BackgroundJobsStateItem('No background jobs', 'Missing .hive/background-jobs.json', boardPath)]
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
    const groups: Array<{ label: string; jobs: BackgroundJobRecord[]; collapsed?: boolean }> = [
      { label: 'Running', jobs: [] },
      { label: 'Needs Reconciliation', jobs: [] },
      { label: 'Cancel Requested', jobs: [] },
      { label: 'Stale / Ignored / Completed', jobs: [], collapsed: true },
    ]

    for (const job of jobs) {
      if (job.cancelRequestedAt) {
        groups[2].jobs.push(job)
      } else if (job.terminalUnreconciled) {
        groups[1].jobs.push(job)
      } else if (job.runtimeState === 'running') {
        groups[0].jobs.push(job)
      } else {
        groups[3].jobs.push(job)
      }
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

function getCoordinationStatus(job: BackgroundJobRecord): string | undefined {
  if (job.cancelRequestedAt) return 'cancel requested'
  if (job.terminalUnreconciled) return 'terminal unreconciled'
  if (job.ignoredAt) return 'ignored'
  if (job.staleAt || job.statusUncertain) return 'stale/uncertain'
  if (job.reconciledAt) return 'reconciled'
  return undefined
}

function getJobIcon(job: BackgroundJobRecord): string {
  if (job.cancelRequestedAt) return 'debug-stop'
  if (job.terminalUnreconciled) return 'warning'
  if (job.runtimeState === 'running') return 'sync~spin'
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
