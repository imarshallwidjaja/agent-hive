import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { ConfigService, projectRootsMatch, RepositoryService } from 'hive-core'

interface RepositoryConfig {
  id: string
  path: string
}

type TrackedRepositoriesItem = TrackedRepositoryItem | TrackedRepositoriesStateItem

class TrackedRepositoryItem extends vscode.TreeItem {
  public readonly copyCommand: vscode.Command

  constructor(repo: RepositoryConfig, workspaceRoot: string) {
    const resolvedPath = path.resolve(workspaceRoot, repo.path)
    super(repo.id, vscode.TreeItemCollapsibleState.None)
    this.description = repo.path
    this.tooltip = `Configured path: ${repo.path}\nResolved path: ${resolvedPath}`
    this.contextValue = 'tracked-repository'
    this.iconPath = new vscode.ThemeIcon(fs.existsSync(resolvedPath) ? 'repo' : 'warning')
    this.command = {
      command: 'hive.openFile',
      title: 'Open Repository Path',
      arguments: [resolvedPath],
    }
    this.copyCommand = {
      command: 'hive.copyToClipboard',
      title: 'Copy Repository ID',
      arguments: [repo.id],
    }
  }
}

class TrackedRepositoriesStateItem extends vscode.TreeItem {
  constructor(label: string, description: string, manifestPath?: string) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.description = description
    this.contextValue = 'tracked-repositories-state'
    this.iconPath = new vscode.ThemeIcon('info')
    if (manifestPath) {
      this.command = {
        command: 'hive.openFile',
        title: 'Open Repository Manifest',
        arguments: [manifestPath],
      }
    }
  }
}

export class TrackedRepositoriesProvider implements vscode.TreeDataProvider<TrackedRepositoriesItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TrackedRepositoriesItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private workspaceRoot: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(element: TrackedRepositoriesItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: TrackedRepositoriesItem): Promise<TrackedRepositoriesItem[]> {
    if (element) {
      return []
    }

    const configService = new ConfigService(this.workspaceRoot)
    const manifestPath = configService.getPath()
    if (!fs.existsSync(manifestPath)) {
      return [new TrackedRepositoriesStateItem('Legacy single-root workspace', 'Missing global Agent Hive config')]
    }

    let manifest: { repositoryRoot?: string; repositories?: RepositoryConfig[] }
    try {
      manifest = configService.readStored()
    } catch {
      return [new TrackedRepositoriesStateItem('Unable to read tracked repositories', 'Invalid global Agent Hive config', manifestPath)]
    }

    if (manifest.repositoryRoot === undefined || !projectRootsMatch(manifest.repositoryRoot, this.workspaceRoot)) {
      return [new TrackedRepositoriesStateItem('Legacy single-root workspace', 'No manifest scoped to this workspace', manifestPath)]
    }

    const repositories = manifest.repositories!

    try {
      new RepositoryService(this.workspaceRoot).resolveManifest(repositories)
      return repositories.map(repo => new TrackedRepositoryItem(repo, this.workspaceRoot))
    } catch {
      return [new TrackedRepositoriesStateItem('Unable to read tracked repositories', 'Invalid repository manifest', manifestPath)]
    }
  }
}
