import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import {
  ContextService,
  ContextMutationError,
  getContextPath,
  getProjectContextPath,
  getFeaturePath,
  getTaskPath,
  listFeatureDirectories,
} from 'hive-core'
import type {
  ContextManagementCatalog,
  ContextRecoverySummary,
  ContextScope,
  FeatureJson,
  TaskStatus,
} from 'hive-core'
import { contextDescription, contextTooltip } from './contextInspection.js'

const CONTEXT_INDEX_LOCK_NAME = 'index.json.lock'
const CONTEXT_PENDING_MARKER_NAME = '.managed-mutation-pending.json'
const CONTEXT_PAGE_SIZE = 10

type ContextSnapshot =
  | { state: 'ready'; catalog: ContextManagementCatalog }
  | { state: 'busy' }
  | { state: 'reconciliation'; recovery: ContextRecoverySummary | null }
  | { state: 'invalidIndex'; recovery: ContextRecoverySummary | null }
  | { state: 'tooLarge'; message: string }
  | { state: 'failed'; message: string }

type SidebarItem = ContextUnavailableItem | StatusGroupItem | FeatureItem | PlanItem | ContextFolderItem | ContextFileItem | ContextEmptyItem | ContextLoadMoreItem | ContextRecoveryItem | ContextRawFileItem | ContextTooLargeItem | TasksGroupItem | TaskItem | TaskFileItem | ReportHistoryItem

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

function scopeKey(scope: ContextScope): string {
  return scope.type === 'project' ? 'project' : `feature:${scope.featureName}`
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
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

class ContextUnavailableItem extends vscode.TreeItem {
  constructor(error?: unknown) {
    super(error === undefined ? 'Context temporarily unavailable' : 'Context unavailable', vscode.TreeItemCollapsibleState.None)
    this.description = error === undefined ? 'Refresh after context changes finish' : `Context inspection failed: ${error instanceof Error ? error.message : String(error)}`
    if (error !== undefined) this.iconPath = new vscode.ThemeIcon('error')
  }
}

class ContextFolderItem extends vscode.TreeItem {
  constructor(
    public readonly scope: ContextScope,
    label: string,
    public readonly snapshot: ContextSnapshot,
    measuredChars: { chars: number; snapshotId: string } | undefined,
  ) {
    super(label, ContextFolderItem.collapsibleState(snapshot))
    this.contextValue = scope.type === 'project' ? 'project-context-folder' : 'context-folder'
    this.applyReadyState(snapshot, measuredChars)
  }

  private static collapsibleState(snapshot: ContextSnapshot): vscode.TreeItemCollapsibleState {
    if (snapshot.state === 'busy' || snapshot.state === 'failed') {
      return vscode.TreeItemCollapsibleState.None
    }
    return vscode.TreeItemCollapsibleState.Collapsed
  }

  private applyReadyState(snapshot: ContextSnapshot, measuredChars: { chars: number; snapshotId: string } | undefined): void {
    if (snapshot.state !== 'ready') {
      switch (snapshot.state) {
        case 'busy':
          this.description = 'Waiting for context changes to finish'
          this.iconPath = new vscode.ThemeIcon('clock')
          this.tooltip = 'A context writer is active. Refresh after context changes finish.'
          break
        case 'reconciliation':
          this.description = 'Reconciliation required'
          this.iconPath = new vscode.ThemeIcon('error')
          this.tooltip = 'A managed context mutation was interrupted. Expand for the observational recovery inspection; repair happens out of band.'
          break
        case 'invalidIndex':
          this.description = 'Invalid context index'
          this.iconPath = new vscode.ThemeIcon('error')
          this.tooltip = 'The context index failed validation. Discovery and managed mutations are blocked until it is repaired out of band. Expand for the observational recovery inspection.'
          break
        case 'tooLarge':
          this.description = 'Inventory too large'
          this.iconPath = new vscode.ThemeIcon('warning')
          this.tooltip = snapshot.message
          break
        case 'failed':
          this.description = 'Inspection failed'
          this.iconPath = new vscode.ThemeIcon('error')
          this.tooltip = snapshot.message
          break
      }
      return
    }

    const catalog = snapshot.catalog
    const budget = catalog.durable
    const charsText = this.renderChars(catalog, measuredChars)
    this.description = `${catalog.totalFiles} documents · ${budget.fileCount}/${budget.fileCap} durable · ${budget.bytes} B · ${charsText}`
    this.iconPath = new vscode.ThemeIcon(this.readyIcon(catalog, measuredChars) ? 'warning' : 'folder')
    const tooltip = [
      `Revision: ${catalog.revision}`,
      'The durable character guideline counts UTF-16 code units. Reserved and evidence documents do not count toward durable guidelines; every managed document is limited to 1 MiB.',
      ...budget.consolidationHints,
      ...budget.warnings,
    ]
    if (budget.chars === null && !measuredChars) {
      tooltip.push('Exact character totals are unavailable until an explicit character scan runs.')
    } else if (measuredChars && measuredChars.snapshotId !== catalog.snapshot) {
      tooltip.push(`Character totals are stale: ${measuredChars.chars} UTF-16 units were measured before the latest change.`)
    }
    this.tooltip = tooltip.join('\n')
  }

  private renderChars(catalog: ContextManagementCatalog, measuredChars: { chars: number; snapshotId: string } | undefined): string {
    const budget = catalog.durable
    if (budget.chars !== null) return `${budget.chars}/${budget.charCap} chars`
    if (!measuredChars) return 'chars unavailable'
    if (measuredChars.snapshotId === catalog.snapshot) return `${measuredChars.chars}/${budget.charCap} chars`
    return `${measuredChars.chars}/${budget.charCap} chars (stale)`
  }

  private readyIcon(catalog: ContextManagementCatalog, measuredChars: { chars: number; snapshotId: string } | undefined): boolean {
    const budget = catalog.durable
    if (budget.overLimit) return true
    if (budget.governanceIssues > 0) return true
    if (measuredChars && measuredChars.snapshotId === catalog.snapshot && measuredChars.chars > budget.charCap) return true
    return false
  }
}

class ContextFileItem extends vscode.TreeItem {
  constructor(
    public readonly scope: ContextScope,
    public readonly filename: string,
    filePath: string,
    metadata: ContextManagementCatalog['files'][number],
    overdue: boolean,
    commentCount: number = 0
  ) {
    super(filename, vscode.TreeItemCollapsibleState.None)

    this.description = contextDescription(metadata, overdue) + (commentCount > 0 ? ` · ${commentCount} comment(s)` : '')
    this.tooltip = contextTooltip(metadata, scope.type === 'project')
    this.contextValue = 'context-file'
    this.iconPath = new vscode.ThemeIcon(filename.endsWith('.md') ? 'markdown' : 'file')
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [vscode.Uri.file(filePath)]
    }
  }
}

class ContextEmptyItem extends vscode.TreeItem {
  constructor() {
    super('No context documents', vscode.TreeItemCollapsibleState.None)
    this.contextValue = 'context-empty'
    this.iconPath = new vscode.ThemeIcon('info')
    this.tooltip = 'This scope has no context documents yet. Create context with OpenCode context management tools; the sidebar never creates files.'
  }
}

class ContextLoadMoreItem extends vscode.TreeItem {
  constructor(
    public readonly scope: ContextScope,
    shown: number,
    total: number,
  ) {
    super('Load more context documents', vscode.TreeItemCollapsibleState.None)
    this.description = `${shown} of ${total}`
    this.contextValue = 'context-load-more'
    this.iconPath = new vscode.ThemeIcon('chevron-down')
    this.command = {
      command: 'hive.context.loadMore',
      title: 'Load More Context Documents',
      arguments: [scope],
    }
  }
}

class ContextRecoveryItem extends vscode.TreeItem {
  constructor(
    state: 'reconciliation' | 'invalidIndex',
    recovery: ContextRecoverySummary | null,
  ) {
    super('Context recovery inspection', vscode.TreeItemCollapsibleState.None)
    this.description = recovery ? `Observational · revision ${recovery.revision ?? 'unknown'}` : 'Observational · recovery envelope unavailable'
    this.contextValue = 'context-recovery'
    this.iconPath = new vscode.ThemeIcon('search')
    this.tooltip = ContextRecoveryItem.tooltipText(state, recovery)
  }

  private static tooltipText(state: 'reconciliation' | 'invalidIndex', recovery: ContextRecoverySummary | null): string {
    const lines = [state === 'reconciliation'
      ? 'State: pending reconciliation. A managed context mutation was interrupted.'
      : 'State: invalid context index.']
    if (!recovery) {
      lines.push('The bounded recovery envelope is unavailable. Inspect the raw control files out of band.')
      return lines.join('\n')
    }
    lines.push(`Revision: ${recovery.revision ?? 'unknown'}`)
    lines.push(`Context index: ${recovery.control.indexPresent ? 'present' : 'missing'}${recovery.control.indexHash ? ` (${recovery.control.indexHash.slice(0, 16)}…)` : ''}`)
    lines.push(`Pending mutation marker: ${recovery.control.markerPresent ? 'present' : 'missing'}`)
    lines.push(`Archive manifest: ${recovery.control.archiveManifestPresent ? 'present' : 'missing'}`)
    for (const error of recovery.control.indexErrors) lines.push(`Index error: ${error}`)
    for (const error of recovery.control.markerErrors) lines.push(`Marker error: ${error}`)
    if (recovery.pendingMutation) {
      lines.push(`Pending operation: ${recovery.pendingMutation.operation ?? 'unknown'} started ${recovery.pendingMutation.startedAt ?? 'unknown'}`)
      lines.push(`Starting index digest: ${recovery.pendingMutation.startingIndexDigest ?? 'unknown'}`)
      if (recovery.pendingMutation.names.length) lines.push(`Affected names: ${recovery.pendingMutation.names.join(', ')}`)
      if (recovery.pendingMutation.archiveDestinations.length) lines.push(`Archive destinations: ${recovery.pendingMutation.archiveDestinations.join(', ')}`)
    }
    if (recovery.unclassified.length) {
      lines.push(`Unclassified documents (sample): ${recovery.unclassified.map(file => file.name).join(', ')}`)
    }
    lines.push('', ...recovery.recoveryInstructions)
    return lines.join('\n')
  }
}

class ContextRawFileItem extends vscode.TreeItem {
  constructor(label: string, filePath: string) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.contextValue = 'context-raw-file'
    this.iconPath = new vscode.ThemeIcon('file-code')
    this.tooltip = 'Opens the raw control file in the normal editor. This inspection changes nothing; repair happens out of band.'
    this.command = {
      command: 'vscode.open',
      title: 'Open Raw File',
      arguments: [vscode.Uri.file(filePath)]
    }
  }
}

class ContextTooLargeItem extends vscode.TreeItem {
  constructor(message: string) {
    super('Context inventory too large', vscode.TreeItemCollapsibleState.None)
    this.description = 'Bounded listing exceeded its construction limit'
    this.contextValue = 'context-too-large'
    this.iconPath = new vscode.ThemeIcon('warning')
    this.tooltip = [
      message,
      'Automatic discovery, catalog listing, and Archive Context share this inventory construction limit and stay unavailable while the scope stays oversized. Exact named reads through OpenCode context management still bypass the inventory.',
      'Reduce the inventory out of band through trusted local editing while no writer is active, then Refresh.',
    ].join('\n')
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
    public readonly reportPath: string | null,
    public readonly reportsPath: string
  ) {
    const name = folder.replace(/^\d+-/, '')
    const hasFiles = specPath !== null || reportPath !== null || fs.existsSync(reportsPath)
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

class ReportHistoryItem extends vscode.TreeItem {
  constructor(public readonly reportsPath: string) {
    super('Report history', vscode.TreeItemCollapsibleState.Collapsed)
    this.contextValue = 'report-history'
    this.iconPath = new vscode.ThemeIcon('history')
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
  private revealedPages = new Map<string, number>()
  private charMeasurements = new Map<string, { chars: number; snapshotId: string }>()

  constructor(private workspaceRoot: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  loadMore(scope: ContextScope): void {
    const key = scopeKey(scope)
    this.revealedPages.set(key, (this.revealedPages.get(key) ?? 1) + 1)
    this.refresh()
  }

  scanChars(scope: ContextScope): void {
    try {
      const catalog = new ContextService(this.workspaceRoot).readManagementCatalog(scope, { scanChars: true })
      this.charMeasurements.set(scopeKey(scope), { chars: catalog.durable.chars ?? 0, snapshotId: catalog.snapshot })
      this.refresh()
      const scopeLabel = scope.type === 'project' ? 'project' : `"${scope.featureName}"`
      vscode.window.showInformationMessage(`Hive: Scanned ${scopeLabel} context character totals: ${catalog.durable.chars}/${catalog.durable.charCap}.`)
    } catch (error) {
      vscode.window.showErrorMessage(`Hive: Context character scan failed. ${error instanceof Error ? error.message : String(error)} Refresh or reconcile the context, then scan again.`)
    }
  }

  getTreeItem(element: SidebarItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: SidebarItem): Promise<SidebarItem[]> {
    if (!element) {
      const projectContext = this.getProjectContextItem()
      return projectContext ? [projectContext, ...this.getStatusGroups()] : this.getStatusGroups()
    }

    if (element instanceof StatusGroupItem) {
      return element.features
    }

    if (element instanceof FeatureItem) {
      return this.getFeatureChildren(element.name)
    }

    if (element instanceof ContextFolderItem) {
      return this.getContextChildren(element)
    }

    if (element instanceof TasksGroupItem) {
      return this.getTasks(element.featureName, element.tasks)
    }

    if (element instanceof TaskItem) {
      return this.getTaskFiles(element)
    }

    if (element instanceof ReportHistoryItem) {
      return this.getReportFilenames(element.reportsPath)
        .sort((a, b) => {
          const aTime = fs.statSync(path.join(element.reportsPath, a)).mtimeMs
          const bTime = fs.statSync(path.join(element.reportsPath, b)).mtimeMs
          return bTime - aTime || b.localeCompare(a)
        })
        .map(filename => new TaskFileItem(
          filename.startsWith('finalization-') ? `Finalization ${filename.slice('finalization-'.length, -3)}` : `Revision ${filename.slice(0, -3)}`,
          path.join(element.reportsPath, filename),
        ))
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

    items.push(this.buildContextFolder({ type: 'feature', featureName }, 'Context'))

    const tasks = this.getTaskList(featureName)
    items.push(new TasksGroupItem(featureName, tasks))

    return items
  }

  private getProjectContextItem(): ContextFolderItem | null {
    if (!fs.existsSync(path.join(this.workspaceRoot, '.hive'))) return null
    return this.buildContextFolder({ type: 'project' }, 'Project Context')
  }

  private buildContextFolder(scope: ContextScope, label: string): ContextFolderItem {
    const snapshot = this.loadSnapshot(scope)
    return new ContextFolderItem(scope, label, snapshot, this.charMeasurements.get(scopeKey(scope)))
  }

  private loadSnapshot(scope: ContextScope): ContextSnapshot {
    const service = new ContextService(this.workspaceRoot)
    const contextPath = this.contextPathFor(scope)
    const lockPresent = () => fs.existsSync(path.join(contextPath, CONTEXT_INDEX_LOCK_NAME))
    const markerPresent = () => fs.existsSync(path.join(contextPath, CONTEXT_PENDING_MARKER_NAME))
    if (lockPresent()) return { state: 'busy' }
    if (markerPresent()) return { state: 'reconciliation', recovery: this.loadRecovery(service, scope) }
    try {
      return { state: 'ready', catalog: service.readManagementCatalog(scope, { limit: CONTEXT_PAGE_SIZE }) }
    } catch (error) {
      if (error instanceof ContextMutationError) {
        if (error.reason === 'context_reconciliation_required') {
          if (lockPresent() || !markerPresent()) return { state: 'busy' }
          return { state: 'reconciliation', recovery: this.loadRecovery(service, scope) }
        }
        if (error.reason === 'context_index_invalid') {
          return { state: 'invalidIndex', recovery: this.loadRecovery(service, scope) }
        }
        if (error.reason === 'context_inventory_too_large') {
          return { state: 'tooLarge', message: error.message }
        }
        if (error.reason === 'context_changed_during_read') return { state: 'busy' }
      }
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'busy' }
      return { state: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  private loadRecovery(service: ContextService, scope: ContextScope): ContextRecoverySummary | null {
    try {
      return service.readRecoverySummary(scope, { diagnosticMode: 'primary-management' })
    } catch {
      return null
    }
  }

  private contextPathFor(scope: ContextScope): string {
    return scope.type === 'project'
      ? getProjectContextPath(this.workspaceRoot)
      : getContextPath(this.workspaceRoot, scope.featureName)
  }

  private getContextChildren(folder: ContextFolderItem): SidebarItem[] {
    const snapshot = folder.snapshot
    if (snapshot.state === 'busy') return [new ContextUnavailableItem()]
    if (snapshot.state === 'failed') return [new ContextUnavailableItem(new Error(snapshot.message))]
    if (snapshot.state === 'tooLarge') return [new ContextTooLargeItem(snapshot.message)]
    if (snapshot.state === 'reconciliation' || snapshot.state === 'invalidIndex') {
      return this.getRecoveryChildren(folder, snapshot.state, snapshot.recovery)
    }

    const catalog = snapshot.catalog
    if (catalog.totalFiles === 0) return [new ContextEmptyItem()]

    const contextPath = this.contextPathFor(folder.scope)
    const revealed = Math.max(1, this.revealedPages.get(scopeKey(folder.scope)) ?? 1)
    const children: SidebarItem[] = []
    try {
      let cursor: string | undefined
      let shown = 0
      for (let page = 0; page < revealed; page++) {
        const pageResult = this.readManagementPage(folder.scope, cursor)
        for (const file of pageResult.files) {
          children.push(new ContextFileItem(
            folder.scope,
            `${file.name}.md`,
            path.join(contextPath, `${file.name}.md`),
            file,
            this.isOverdue(folder.scope, file),
            this.reviewCommentCountFor(folder.scope, file.name),
          ))
          shown += 1
        }
        cursor = pageResult.nextCursor
        if (!cursor) break
      }
      if (cursor) {
        children.push(new ContextLoadMoreItem(folder.scope, shown, catalog.totalFiles))
      }
    } catch (error) {
      return [new ContextUnavailableItem(error)]
    }
    return children
  }

  private readManagementPage(scope: ContextScope, cursor?: string): ContextManagementCatalog {
    return new ContextService(this.workspaceRoot).readManagementCatalog(scope, { cursor, limit: CONTEXT_PAGE_SIZE })
  }

  private isOverdue(scope: ContextScope, file: { reviewAfter?: string }): boolean {
    if (scope.type !== 'project' || !file.reviewAfter) return false
    return file.reviewAfter <= todayIsoDate()
  }

  private reviewCommentCountFor(scope: ContextScope, name: string): number {
    if (scope.type !== 'feature' || name !== 'overview') return 0
    return this.getReviewCommentCount(scope.featureName, 'overview')
  }

  private getRecoveryChildren(
    folder: ContextFolderItem,
    state: 'reconciliation' | 'invalidIndex',
    recovery: ContextRecoverySummary | null,
  ): SidebarItem[] {
    const contextPath = this.contextPathFor(folder.scope)
    const children: SidebarItem[] = [new ContextRecoveryItem(state, recovery)]

    const indexPath = path.join(contextPath, 'index.json')
    if (fs.existsSync(indexPath)) children.push(new ContextRawFileItem('Open context index (raw)', indexPath))
    if (state === 'reconciliation') {
      const markerPath = path.join(contextPath, CONTEXT_PENDING_MARKER_NAME)
      if (fs.existsSync(markerPath)) children.push(new ContextRawFileItem('Open pending mutation marker (raw)', markerPath))
    }
    if (recovery?.control.archiveManifestPresent) {
      const manifestPath = this.archiveManifestPath(folder.scope)
      if (fs.existsSync(manifestPath)) children.push(new ContextRawFileItem('Open archive manifest (raw)', manifestPath))
    }
    return children
  }

  private archiveManifestPath(scope: ContextScope): string {
    if (scope.type === 'project') {
      return path.join(this.workspaceRoot, '.hive', 'archive', 'context-index.json')
    }
    return path.join(getContextPath(this.workspaceRoot, scope.featureName), '..', 'archive', 'context-index.json')
  }

  private getTasks(featureName: string, tasks: Array<{ folder: string; status: TaskStatus }>): TaskItem[] {
    return tasks.map(t => {
      const taskDir = getTaskPath(this.workspaceRoot, featureName, t.folder)
      const specPath = path.join(taskDir, 'spec.md')
      const reportPath = path.join(taskDir, 'report.md')
      const hasSpec = fs.existsSync(specPath)
      const hasReport = fs.existsSync(reportPath)

      return new TaskItem(featureName, t.folder, t.status, hasSpec ? specPath : null, hasReport ? reportPath : null, path.join(taskDir, 'reports'))
    })
  }

  private getReportFilenames(reportsPath: string): string[] {
    if (!fs.existsSync(reportsPath)) return []
    return fs.readdirSync(reportsPath, { withFileTypes: true })
      .filter(entry => entry.isFile() && (/^[1-9]\d*\.md$/.test(entry.name) || /^finalization-[a-f0-9]+\.md$/.test(entry.name)))
      .map(entry => entry.name)
  }

  private getTaskFiles(taskItem: TaskItem): SidebarItem[] {
    const items: SidebarItem[] = []

    if (taskItem.specPath) {
      items.push(new TaskFileItem('spec.md', taskItem.specPath))
    }
    if (taskItem.reportPath) {
      items.push(new TaskFileItem('Latest handoff report', taskItem.reportPath))
    }
    if (this.getReportFilenames(taskItem.reportsPath).length > 0) {
      items.push(new ReportHistoryItem(taskItem.reportsPath))
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
    const commentsPath = findReviewCommentsPath(this.workspaceRoot, {
      featureName: path.basename(getFeaturePath(this.workspaceRoot, featureName)), document
    })

    if (!commentsPath || !fs.existsSync(commentsPath)) return 0

    try {
      const data = JSON.parse(fs.readFileSync(commentsPath, 'utf-8'))
      return data.threads?.length || 0
    } catch {
      return 0
    }
  }
}
import { findReviewCommentsPath } from '../reviewRouting.js'
