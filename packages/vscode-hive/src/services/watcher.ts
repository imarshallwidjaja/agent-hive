import * as path from 'path'
import * as vscode from 'vscode'
import { isExplorationId } from 'hive-core'

export class HiveWatcher {
  private hiveWatcher: vscode.FileSystemWatcher

  /**
   * `onChange` refreshes the views for Hive record changes. `onExploration` receives the ID of an exploration whose
   * stored file appeared, changed or went away; exploration writes never call `onChange`.
   */
  constructor(workspaceRoot: string, onChange: () => void, onExploration: (id: string) => void = () => {}) {
    this.hiveWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '.hive/**/*')
    )

    const hivePath = path.join(workspaceRoot, '.hive')
    const onContentChange = (uri: vscode.Uri) => {
      const change = classifyHivePath(hivePath, uri.fsPath)
      if (change.kind === 'content') onChange()
      else if (change.kind === 'exploration') onExploration(change.id)
    }
    this.hiveWatcher.onDidCreate(onContentChange)
    this.hiveWatcher.onDidChange(onContentChange)
    this.hiveWatcher.onDidDelete(onContentChange)
  }

  dispose(): void {
    this.hiveWatcher.dispose()
  }
}

type HivePathChange = { kind: 'content' } | { kind: 'ignored' } | { kind: 'exploration'; id: string }

/**
 * What a change under `.hive` means for the views:
 * - `.lock` files, and lock anchors and operation markers under `.hive/.locks`, are coordination state and ignored;
 * - under `.hive/explorations`, only a stored `active/<id>.json` or `closed/<id>.json` counts, as a change to that one
 *   exploration. Its temporary write files, its lock anchor and the directories are ignored;
 * - files inside a worker or retained checkout are source edits and Git internals, and ignored. A placement's creation
 *   or removal, its sidecar, and a composite placement's `workspace.json` still count as content.
 * Areas match whole path segments, so a sibling such as `.hive/explorations-notes.json` is content. Windows and macOS
 * volumes are usually case-insensitive, so paths there are compared case-insensitively.
 */
function classifyHivePath(hivePath: string, filePath: string): HivePathChange {
  const fold = process.platform === 'win32' || process.platform === 'darwin'
    ? (value: string) => value.toLowerCase()
    : (value: string) => value
  const file = fold(filePath)
  if (file.endsWith('.lock')) return { kind: 'ignored' }
  const relative = path.relative(fold(hivePath), file)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return { kind: 'content' }
  const [area, ...rest] = relative.split(path.sep)
  if (area === '.locks') return { kind: 'ignored' }
  if (area === 'explorations') {
    const [placement, name] = rest
    const id = rest.length === 2 && name.endsWith('.json') ? name.slice(0, -'.json'.length) : ''
    return (placement === 'active' || placement === 'closed') && isExplorationId(id) ? { kind: 'exploration', id } : { kind: 'ignored' }
  }
  if (area !== '.worktrees' && area !== 'checkouts') return { kind: 'content' }
  const inside = rest.length > 3 || (rest.length === 3 && !(area === '.worktrees' && rest[2] === 'workspace.json'))
  return inside ? { kind: 'ignored' } : { kind: 'content' }
}
