import * as vscode from 'vscode'
import { HiveService } from '../services/hiveService'
import { Feature, Step } from '../types'

type HiveItem = FeatureItem | FolderItem | FileItem | ExecutionItem | StepItem | SpecFileItem

class FeatureItem extends vscode.TreeItem {
  public readonly featureName: string

  constructor(public readonly feature: Feature) {
    super(feature.name, vscode.TreeItemCollapsibleState.Expanded)
    this.featureName = feature.name
    this.description = `${feature.progress}%`
    this.contextValue = 'feature'
    this.iconPath = new vscode.ThemeIcon('package')
    this.command = {
      command: 'hive.showFeature',
      title: 'Show Feature Details',
      arguments: [feature.name]
    }
  }
}

class FolderItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly featureName: string,
    public readonly folder: 'problem' | 'context',
    icon: string,
    hasChildren: boolean
  ) {
    super(label, hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
    this.contextValue = 'folder'
    this.iconPath = new vscode.ThemeIcon(icon)
  }
}

class FileItem extends vscode.TreeItem {
  constructor(
    public readonly filename: string,
    public readonly featureName: string,
    public readonly folder: 'problem' | 'context',
    public readonly filePath: string
  ) {
    super(filename, vscode.TreeItemCollapsibleState.None)
    this.contextValue = 'file'
    this.iconPath = new vscode.ThemeIcon(filename.endsWith('.md') ? 'markdown' : 'file')
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [vscode.Uri.file(filePath)]
    }
    this.resourceUri = vscode.Uri.file(filePath)
  }
}

class ExecutionItem extends vscode.TreeItem {
  constructor(public readonly feature: Feature) {
    super('Execution', vscode.TreeItemCollapsibleState.Expanded)
    this.contextValue = 'execution'
    this.iconPath = new vscode.ThemeIcon('run-all')
  }
}

class StepItem extends vscode.TreeItem {
  private static statusIcons: Record<string, string> = {
    done: 'pass',
    in_progress: 'sync~spin',
    pending: 'circle-outline',
    blocked: 'error'
  }

  public readonly stepName: string
  public readonly stepFolder: string
  public readonly sessionId?: string

  constructor(
    public readonly featureName: string,
    public readonly step: Step,
    hasSpecFiles: boolean
  ) {
    super(
      `${String(step.order).padStart(2, '0')}-${step.name}`,
      hasSpecFiles ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    )
    this.stepName = step.name
    this.stepFolder = step.folderPath
    this.sessionId = step.sessionId
    this.contextValue = step.sessionId ? 'step' : 'stepNoSession'
    this.iconPath = new vscode.ThemeIcon(StepItem.statusIcons[step.status] || 'circle-outline')
    
    if (step.summary) {
      this.description = step.summary
    }

    if (step.sessionId) {
      this.tooltip = `Session: ${step.sessionId}`
    }
  }
}

class SpecFileItem extends vscode.TreeItem {
  constructor(
    public readonly filename: string,
    public readonly featureName: string,
    public readonly stepFolder: string,
    public readonly filePath: string
  ) {
    super(filename, vscode.TreeItemCollapsibleState.None)
    this.contextValue = 'specFile'
    this.iconPath = new vscode.ThemeIcon('markdown')
    this.command = {
      command: 'vscode.open',
      title: 'Open Spec',
      arguments: [vscode.Uri.file(filePath)]
    }
    this.resourceUri = vscode.Uri.file(filePath)
  }
}

export class HiveSidebarProvider implements vscode.TreeDataProvider<HiveItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<HiveItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private hiveService: HiveService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(element: HiveItem): vscode.TreeItem {
    return element
  }

  getChildren(element?: HiveItem): HiveItem[] {
    if (!element) {
      return this.hiveService.getFeatures().map(f => new FeatureItem(f))
    }

    if (element instanceof FeatureItem) {
      const problemFiles = this.hiveService.getFilesInFolder(element.feature.name, 'problem')
      const contextFiles = this.hiveService.getFilesInFolder(element.feature.name, 'context')
      return [
        new FolderItem('Problem', element.feature.name, 'problem', 'question', problemFiles.length > 0),
        new FolderItem('Context', element.feature.name, 'context', 'lightbulb', contextFiles.length > 0),
        new ExecutionItem(element.feature)
      ]
    }

    if (element instanceof FolderItem) {
      const files = this.hiveService.getFilesInFolder(element.featureName, element.folder)
      return files.map(f => new FileItem(
        f,
        element.featureName,
        element.folder,
        this.hiveService.getFilePath(element.featureName, element.folder, f)
      ))
    }

    if (element instanceof ExecutionItem) {
      return element.feature.steps.map(s => new StepItem(
        element.feature.name, 
        s, 
        s.specFiles.length > 0
      ))
    }

    if (element instanceof StepItem) {
      const step = this.hiveService.getFeature(element.featureName).steps.find(s => s.folderPath === element.stepFolder)
      if (!step) return []
      return step.specFiles.map(f => new SpecFileItem(
        f,
        element.featureName,
        element.stepFolder,
        this.hiveService.getStepFilePath(element.featureName, element.stepFolder, f)
      ))
    }

    return []
  }
}
