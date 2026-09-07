import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { ContextService, getFeaturePath, listFeatureDirectories } from 'hive-core'
import type { ContextReadSummary, FeatureJson, TaskStatus } from 'hive-core'
import { contextDescription, contextTooltip } from './contextInspection.js'

class ContextUnavailableItem extends vscode.TreeItem {
  constructor(error?: unknown) {
    super(error === undefined ? 'Context temporarily unavailable' : 'Context unavailable', vscode.TreeItemCollapsibleState.None)
    this.description = error === undefined ? 'Refresh after context changes finish' : `Context inspection failed: ${error instanceof Error ? error.message : String(error)}`
    if (error !== undefined) this.iconPath = new vscode.ThemeIcon('error')
  }
}

type SidebarItem = ContextUnavailableItem | StatusGroupItem | FeatureItem | PlanItem | ContextFolderItem | ContextFileItem | TasksGroupItem | TaskItem | TaskFileItem

const STATUS_ICONS: Record<string, string> = {
  pending: 'circle-outline',
  in_progress: 'sync~spin',
  done: 'pass',
  cancelled: 'circle-slash',
  planning: 'edit',
  approved: 'check',
  executing: 'run-all',
  completed: 'pass-filled',
  archived: 'archive',
}

// Status group for organizing features
class StatusGroupItem extends vscode.TreeItem {
  constructor(
    public readonly groupName: string,
    public readonly groupStatus: 'in_progress' | 'pending' | 'completed' | 'archived',
    public readonly features: FeatureItem[],
    collapsed: boolean = false
  ) {
    super(groupName, collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded)
    
    this.description = `${features.length}`
    this.contextValue = `status-group-${groupStatus}`
    
    const icons: Record<string, string> = {
      in_progress: 'sync~spin',
      pending: 'circle-outline',
      completed: 'pass-filled',
      archived: 'archive',
    }
    this.iconPath = new vscode.ThemeIcon(icons[groupStatus] || 'folder')
  }
}

class FeatureItem extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly feature: FeatureJson,
    public readonly taskStats: { total: number; done: number }
  ) {
    super(name, vscode.TreeItemCollapsibleState.Collapsed)
    
    const statusLabel = feature.status.charAt(0).toUpperCase() + feature.status.slice(1)
    this.description = `${statusLabel} · ${taskStats.done}/${taskStats.total}`
    
    this.contextValue = `feature-${feature.status}`
    this.iconPath = new vscode.ThemeIcon(STATUS_ICONS[feature.status] || 'package')
  }
}

class PlanItem extends vscode.TreeItem {
  constructor(
    public readonly featureName: string,
    public readonly planPath: string,
    public readonly featureStatus: string,
    public readonly commentCount: number
  ) {
    super('Plan', vscode.TreeItemCollapsibleState.None)
    
    this.description = commentCount > 0 ? `${commentCount} comment(s)` : ''
    this.contextValue = featureStatus === 'planning' ? 'plan-draft' : 'plan-approved'
    this.iconPath = new vscode.ThemeIcon('file-text')
    this.command = {
      command: 'vscode.open',
      title: 'Open Plan',
      arguments: [vscode.Uri.file(planPath)]
    }
  }
}

class ContextFolderItem extends vscode.TreeItem {
  constructor(
    public readonly featureName: string,
    public readonly contextPath: string,
    public readonly summary: ContextReadSummary
  ) {
    super('Context', summary.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)

    const budget = summary.durable
    this.description = `${summary.files.length} documents · ${budget.fileCount}/${budget.fileCap} durable · ${budget.chars}/${budget.charCap} chars`
    this.contextValue = 'context-folder'
    this.iconPath = new vscode.ThemeIcon(budget.overLimit ? 'warning' : 'folder')
    this.tooltip = [`Revision: ${summary.revision}`, 'Durable budget uses UTF-16 code units. Reserved and evidence documents are uncapped.', ...budget.consolidationHints].join('\n')
  }
}

class ContextFileItem extends vscode.TreeItem {
  constructor(
    public readonly filename: string,
    public readonly filePath: string,
    public readonly featureName: string,
    metadata: ContextReadSummary['files'][number],
    public readonly commentCount: number = 0
  ) {
    super(filename, vscode.TreeItemCollapsibleState.None)

    this.description = contextDescription(metadata, filePath) + (commentCount > 0 ? ` · ${commentCount} comment(s)` : '')
    this.tooltip = contextTooltip(metadata)
    this.contextValue = 'context-file'
    this.iconPath = new vscode.ThemeIcon(filename.endsWith('.md') ? 'markdown' : 'file')
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [vscode.Uri.file(filePath)]
    }
  }
}

class TasksGroupItem extends vscode.TreeItem {
  constructor(
    public readonly featureName: string,
    public readonly tasks: Array<{ folder: string; status: TaskStatus }>
  ) {
    super('Tasks', tasks.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
    
    const done = tasks.filter(t => t.status.status === 'done').length
    this.description = `${done}/${tasks.length}`
    this.contextValue = 'tasks-group'
    this.iconPath = new vscode.ThemeIcon('checklist')
  }
}

class TaskItem extends vscode.TreeItem {
  constructor(
    public readonly featureName: string,
    public readonly folder: string,
    public readonly status: TaskStatus,
    public readonly specPath: string | null,
    public readonly reportPath: string | null
  ) {
    const name = folder.replace(/^\d+-/, '')
    const hasFiles = specPath !== null || reportPath !== null
    super(name, hasFiles ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
    this.description = status.summary || ''
    this.contextValue = `task-${status.status}${status.origin === 'manual' ? '-manual' : ''}`
    
    const iconName = STATUS_ICONS[status.status] || 'circle-outline'
    this.iconPath = new vscode.ThemeIcon(iconName)
    
    this.tooltip = new vscode.MarkdownString()
    this.tooltip.appendMarkdown(`**${folder}**\n\n`)
    this.tooltip.appendMarkdown(`Status: ${status.status}\n\n`)
    this.tooltip.appendMarkdown(`Origin: ${status.origin}\n\n`)
    if (status.summary) {
      this.tooltip.appendMarkdown(`Summary: ${status.summary}`)
    }
  }
}

class TaskFileItem extends vscode.TreeItem {
  constructor(
    public readonly filename: string,
    public readonly filePath: string
  ) {
    super(filename, vscode.TreeItemCollapsibleState.None)
    
    this.contextValue = 'task-file'
    this.iconPath = new vscode.ThemeIcon('markdown')
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [vscode.Uri.file(filePath)]
    }
  }
}



export class HiveSidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SidebarItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private workspaceRoot: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(element: SidebarItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: SidebarItem): Promise<SidebarItem[]> {
    if (!element) {
      const statusGroups = await this.getStatusGroups()
      return statusGroups
    }

    if (element instanceof StatusGroupItem) {
      return element.features
    }

    if (element instanceof FeatureItem) {
      return this.getFeatureChildren(element.name)
    }

    if (element instanceof ContextFolderItem) {
      return this.getContextFiles(element.featureName, element.contextPath)
    }

    if (element instanceof TasksGroupItem) {
      return this.getTasks(element.featureName, element.tasks)
    }

    if (element instanceof TaskItem) {
      return this.getTaskFiles(element)
    }

    return []
  }

  private getStatusGroups(): StatusGroupItem[] {
    const features = this.getAllFeatures()
    
    const inProgress: FeatureItem[] = []
    const pending: FeatureItem[] = []
    const completed: FeatureItem[] = []
    const archived: FeatureItem[] = []
    
    for (const feature of features) {
      if (feature.feature.status === 'archived') {
        archived.push(feature)
      } else if (feature.feature.status === 'executing') {
        inProgress.push(feature)
      } else if (feature.feature.status === 'planning' || feature.feature.status === 'approved') {
        pending.push(feature)
      } else if (feature.feature.status === 'completed') {
        completed.push(feature)
      }
    }
    
    const groups: StatusGroupItem[] = []
    
    if (inProgress.length > 0) {
      groups.push(new StatusGroupItem('In Progress', 'in_progress', inProgress, false))
    }
    if (pending.length > 0) {
      groups.push(new StatusGroupItem('Pending', 'pending', pending, false))
    }
    if (completed.length > 0) {
      groups.push(new StatusGroupItem('Completed', 'completed', completed, true))
    }
    if (archived.length > 0) {
      groups.push(new StatusGroupItem('Archived', 'archived', archived, true))
    }
    
    return groups
  }

  private getAllFeatures(): FeatureItem[] {
    const features: FeatureItem[] = []

    const dirs = listFeatureDirectories(this.workspaceRoot)

    for (const dir of dirs) {
      const featureJsonPath = path.join(getFeaturePath(this.workspaceRoot, dir.logicalName), 'feature.json')
      if (!fs.existsSync(featureJsonPath)) continue

      const feature: FeatureJson = JSON.parse(fs.readFileSync(featureJsonPath, 'utf-8'))
      const taskStats = this.getTaskStats(dir.logicalName)

      features.push(new FeatureItem(dir.logicalName, feature, taskStats))
    }

    features.sort((a, b) => a.name.localeCompare(b.name))

    return features
  }

  private getFeatureChildren(featureName: string): SidebarItem[] {
    const featurePath = getFeaturePath(this.workspaceRoot, featureName)
    const items: SidebarItem[] = []

    const featureJsonPath = path.join(featurePath, 'feature.json')
    const feature: FeatureJson = JSON.parse(fs.readFileSync(featureJsonPath, 'utf-8'))

    const planPath = path.join(featurePath, 'plan.md')
    if (fs.existsSync(planPath)) {
      const commentCount = this.getReviewCommentCount(featureName, 'plan')
      items.push(new PlanItem(featureName, planPath, feature.status, commentCount))
    }

    const contextPath = path.join(featurePath, 'context')
    try {
      const snapshot = new ContextService(this.workspaceRoot).inspectSummary(featureName)
      items.push(snapshot.status === 'ready' ? new ContextFolderItem(featureName, contextPath, snapshot.summary) : new ContextUnavailableItem())
    } catch (error) {
      items.push(new ContextUnavailableItem(error))
    }

    const tasks = this.getTaskList(featureName)
    items.push(new TasksGroupItem(featureName, tasks))

    return items
  }

  private getContextFiles(featureName: string, contextPath: string): SidebarItem[] {
    let snapshot: ReturnType<ContextService['inspectSummary']>
    try {
      snapshot = new ContextService(this.workspaceRoot).inspectSummary(featureName)
    } catch (error) {
      return [new ContextUnavailableItem(error)]
    }
    if (snapshot.status === 'busy') return [new ContextUnavailableItem()]
    return snapshot.summary.files.map(file => {
      const filename = `${file.name}.md`
      const commentCount = filename === 'overview.md' ? this.getReviewCommentCount(featureName, 'overview') : 0
      return new ContextFileItem(filename, path.join(contextPath, filename), featureName, file, commentCount)
    })
  }

  private getTasks(featureName: string, tasks: Array<{ folder: string; status: TaskStatus }>): TaskItem[] {
    const featurePath = getFeaturePath(this.workspaceRoot, featureName)
    
    return tasks.map(t => {
      const taskDir = path.join(featurePath, 'tasks', t.folder)
      const specPath = path.join(taskDir, 'spec.md')
      const reportPath = path.join(taskDir, 'report.md')
      const hasSpec = fs.existsSync(specPath)
      const hasReport = fs.existsSync(reportPath)
      
      return new TaskItem(featureName, t.folder, t.status, hasSpec ? specPath : null, hasReport ? reportPath : null)
    })
  }

  private getTaskFiles(taskItem: TaskItem): TaskFileItem[] {
    const items: TaskFileItem[] = []
    
    if (taskItem.specPath) {
      items.push(new TaskFileItem('spec.md', taskItem.specPath))
    }
    if (taskItem.reportPath) {
      items.push(new TaskFileItem('report.md', taskItem.reportPath))
    }
    
    return items
  }

  private getTaskList(featureName: string): Array<{ folder: string; status: TaskStatus }> {
    const tasksPath = path.join(getFeaturePath(this.workspaceRoot, featureName), 'tasks')
    if (!fs.existsSync(tasksPath)) return []

    const folders = fs.readdirSync(tasksPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()

    return folders.map(folder => {
      const statusPath = path.join(tasksPath, folder, 'status.json')
      const status: TaskStatus = fs.existsSync(statusPath)
        ? JSON.parse(fs.readFileSync(statusPath, 'utf-8'))
        : { status: 'pending', origin: 'plan' }
      return { folder, status }
    })
  }

  private getTaskStats(featureName: string): { total: number; done: number } {
    const tasks = this.getTaskList(featureName)
    return {
      total: tasks.length,
      done: tasks.filter(t => t.status.status === 'done').length
    }
  }

  private getReviewCommentCount(featureName: string, document: 'plan' | 'overview'): number {
    const featurePath = getFeaturePath(this.workspaceRoot, featureName)
    const canonicalPath = path.join(featurePath, 'comments', `${document}.json`)
    const legacyPlanPath = path.join(featurePath, 'comments.json')
    const commentsPath = fs.existsSync(canonicalPath)
      ? canonicalPath
      : document === 'plan' ? legacyPlanPath : null

    if (!commentsPath || !fs.existsSync(commentsPath)) return 0

    try {
      const data = JSON.parse(fs.readFileSync(commentsPath, 'utf-8'))
      return data.threads?.length || 0
    } catch {
      return 0
    }
  }
}
