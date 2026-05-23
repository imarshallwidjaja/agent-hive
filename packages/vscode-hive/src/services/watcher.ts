import * as vscode from 'vscode'

export class HiveWatcher {
  private hiveWatcher: vscode.FileSystemWatcher

  constructor(workspaceRoot: string, onChange: () => void) {
    this.hiveWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '.hive/**/*')
    )

    this.hiveWatcher.onDidCreate(onChange)
    this.hiveWatcher.onDidChange(onChange)
    this.hiveWatcher.onDidDelete(onChange)
  }

  dispose(): void {
    this.hiveWatcher.dispose()
  }
}
