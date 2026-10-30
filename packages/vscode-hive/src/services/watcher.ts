import * as path from 'path'
import * as vscode from 'vscode'

export class HiveWatcher {
  private hiveWatcher: vscode.FileSystemWatcher

  constructor(workspaceRoot: string, onChange: () => void) {
    this.hiveWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '.hive/**/*')
    )

    // Lock anchors and worktree operation markers under .hive/.locks are coordination state, not content.
    const locksPath = path.join(workspaceRoot, '.hive', '.locks') + path.sep
    const onContentChange = (uri: vscode.Uri) => {
      if (uri.fsPath.endsWith('.lock') || uri.fsPath.startsWith(locksPath)) return
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
