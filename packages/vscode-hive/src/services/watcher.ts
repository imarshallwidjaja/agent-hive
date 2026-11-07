import * as path from 'path'
import * as vscode from 'vscode'

export class HiveWatcher {
  private hiveWatcher: vscode.FileSystemWatcher

  constructor(workspaceRoot: string, onChange: () => void) {
    this.hiveWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '.hive/**/*')
    )

    // Lock anchors and worktree operation markers under .hive/.locks are coordination state, not content.
    const hivePath = path.join(workspaceRoot, '.hive')
    const locksPath = path.join(hivePath, '.locks') + path.sep
    const onContentChange = (uri: vscode.Uri) => {
      if (uri.fsPath.endsWith('.lock') || uri.fsPath.startsWith(locksPath) || isCheckoutContent(hivePath, uri.fsPath)) return
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

/**
 * Files inside a worker or retained checkout are source edits and Git internals, not Hive records. A placement's
 * creation or removal, its sidecar, and a composite placement's `workspace.json` still refresh the views.
 */
function isCheckoutContent(hivePath: string, filePath: string): boolean {
  const [area, ...rest] = path.relative(hivePath, filePath).split(path.sep)
  if (area !== '.worktrees' && area !== 'checkouts') return false
  return rest.length > 3 || (rest.length === 3 && !(area === '.worktrees' && rest[2] === 'workspace.json'))
}
