import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { RepositoryManifestService } from 'hive-core'

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

    const status = new RepositoryManifestService(this.workspaceRoot).getStatus()
    if (status.error) {
      return [new TrackedRepositoriesStateItem('Unable to read tracked repositories', 'Invalid repository manifest', status.configPath)]
    }
    if (status.mode !== 'manifest') {
      return [new TrackedRepositoriesStateItem('Legacy single-root workspace', 'Missing project repository manifest')]
    }
    return status.repositories.map(repo => new TrackedRepositoryItem(repo, this.workspaceRoot))
  }
}
