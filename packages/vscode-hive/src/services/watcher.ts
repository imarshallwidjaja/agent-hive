import * as vscode from 'vscode'

export class HiveWatcher {
  private hiveWatcher: vscode.FileSystemWatcher

  constructor(workspaceRoot: string, onChange: () => void) {
    this.hiveWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '.hive/**/*')
    )

    const onContentChange = (uri: vscode.Uri) => {
      if (uri.fsPath.endsWith('.lock')) return
      onChange()
    }
    this.hiveWatcher.onDidCreate(onContentChange)
    this.hiveWatcher.onDidChange(onContentChange)
    this.hiveWatcher.onDidDelete(onContentChange)
  }

  dispose(): void {
    this.hiveWatcher.dispose()
  }
}
