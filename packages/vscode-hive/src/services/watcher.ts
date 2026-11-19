import * as path from 'path'
import * as vscode from 'vscode'

export class HiveWatcher {
  private hiveWatcher: vscode.FileSystemWatcher

  constructor(workspaceRoot: string, onChange: () => void) {
    this.hiveWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '.hive/**/*')
    )

    const hivePath = path.join(workspaceRoot, '.hive')
    const onContentChange = (uri: vscode.Uri) => {
      if (!isIgnoredHivePath(hivePath, uri.fsPath)) onChange()
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
 * Paths under `.hive` that are not Hive records any view shows:
 * - `.lock` files, and lock anchors and operation markers under `.hive/.locks`, are coordination state;
 * - exploration frontiers under `.hive/explorations` change on every agent update, and no view shows them;
 * - files inside a worker or retained checkout are source edits and Git internals. A placement's creation or
 *   removal, its sidecar, and a composite placement's `workspace.json` still count as content.
 * Areas match whole path segments, so a sibling such as `.hive/explorations-notes.json` is content. Windows and macOS
 * volumes are usually case-insensitive, so paths there are compared case-insensitively.
 */
function isIgnoredHivePath(hivePath: string, filePath: string): boolean {
  const fold = process.platform === 'win32' || process.platform === 'darwin'
    ? (value: string) => value.toLowerCase()
    : (value: string) => value
  const file = fold(filePath)
  if (file.endsWith('.lock')) return true
  const relative = path.relative(fold(hivePath), file)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false
  const [area, ...rest] = relative.split(path.sep)
  if (area === '.locks' || area === 'explorations') return true
  if (area !== '.worktrees' && area !== 'checkouts') return false
  return rest.length > 3 || (rest.length === 3 && !(area === '.worktrees' && rest[2] === 'workspace.json'))
}
