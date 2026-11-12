import * as vscode from 'vscode'
import * as path from 'path'
import { RepositoryService, RetainedCheckoutService, retainedCheckoutPaths } from 'hive-core'
import type { RetainedCheckoutCleanupProposal, RetainedCheckoutCleanupResult, RetainedCheckoutReference } from 'hive-core'
import { resolveProjectPath } from './worklogPresentation.js'

/**
 * Remove Stale Hive Record: the one Repositories & Work action that writes. When someone deletes a managed retained
 * checkout's directory outside Hive, its record stays behind; this removes only that record, after a fresh inspection
 * and one confirmation. Git is read but never changed, so the branch and every Git worktree registration stay as they are.
 */

type CheckoutRecordService = Pick<RetainedCheckoutService, 'inspectCleanup' | 'removeMissingRecord'>

interface BlockerItem extends vscode.QuickPickItem {
  /** Project-relative path of the file that holds the reference; only these items open anything. */
  file?: string
}

const REMOVE = 'Remove Record'

/**
 * `projectRoot` is the physical root the Repositories & Work view read its rows from; it is used as given, never
 * resolved again, so the record removed belongs to the project the row showed. `service` replaces the project's own
 * checkout service; tests use it to observe results the filesystem cannot produce.
 */
export async function removeStaleCheckoutRecord(projectRoot: string, item: unknown, refresh: () => void, service?: CheckoutRecordService): Promise<void> {
  const id = (item as { checkoutId?: unknown } | undefined)?.checkoutId
  if (typeof id !== 'string' || id === '') {
    vscode.window.showErrorMessage('Hive: Select a missing retained checkout in Repositories & Work.')
    return
  }
  let checkouts: CheckoutRecordService
  try {
    checkouts = service ?? new RetainedCheckoutService({ baseDir: projectRoot, hiveDir: path.join(projectRoot, '.hive'), repositoryResolver: new RepositoryService(projectRoot) })
  } catch (error) {
    vscode.window.showErrorMessage(`Hive: Could not open the Hive project at ${projectRoot}. ${message(error)}`)
    refresh()
    return
  }
  const hiveDir = path.join(projectRoot, '.hive')

  let proposal: RetainedCheckoutCleanupProposal
  try {
    proposal = await checkouts.inspectCleanup(id)
  } catch (error) {
    vscode.window.showErrorMessage(`Hive: Could not inspect retained checkout ${id}. ${message(error)}`)
    refresh()
    return
  }
  const { record } = proposal
  if (record.ownership !== 'managed' || proposal.present) {
    vscode.window.showInformationMessage(`Hive: ${id} is no longer a missing managed checkout, so its record was kept.`)
    refresh()
    return
  }
  if (proposal.blockers.length > 0) {
    await showBlockers(projectRoot, id, proposal)
    return
  }

  const branch = shortRef(record.ref)
  const choice = await vscode.window.showWarningMessage(`Remove the stale Hive record for ${id}?`, {
    modal: true,
    detail: [
      `Project: ${projectRoot}`,
      `Checkout: ${id}`,
      `Intended branch: ${branch}`,
      `Missing directory: ${record.path}`,
      `Record file: ${retainedCheckoutPaths(hiveDir, id).recordPath}`,
      '',
      'Only the record file is deleted. Git is read but not changed: branches and every Git worktree registration stay as they are.',
    ].join('\n'),
  }, REMOVE)
  if (choice !== REMOVE) return

  let result: RetainedCheckoutCleanupResult
  try {
    result = await checkouts.removeMissingRecord(id, record)
  } catch (error) {
    vscode.window.showErrorMessage(`Hive: Could not remove the record for ${id}. ${message(error)}`)
    refresh()
    return
  }
  const finalization = result.finalization
  if (finalization) {
    const problem = finalization.lockReleaseError ?? finalization.markerError ?? `operation markers ${finalization.markers}`
    vscode.window.showWarningMessage(`Hive: Removed the stale record for ${id}, but finishing the operation failed: ${problem}. The removal stands. An operation lock that could not be released is freed when this window's extension host exits.`)
  } else {
    vscode.window.showInformationMessage(`Hive: Removed the stale record for ${id}. Branch ${branch} is unchanged.`)
  }
  refresh()
}

/** Lists what keeps the record; removal is not offered. Selecting a reference opens the file that holds it. */
async function showBlockers(projectRoot: string, id: string, proposal: RetainedCheckoutCleanupProposal): Promise<void> {
  const items: BlockerItem[] = [
    ...proposal.references.map(reference => referenceItem(projectRoot, reference)),
    ...proposal.unreadableReferences.map(source => ({ label: '$(warning) Unreadable source', description: display(projectRoot, source.path), detail: source.reason })),
    ...proposal.pendingOperations.map(operation => ({
      label: '$(warning) Interrupted worktree operation',
      description: operation.operationId,
      detail: 'reason' in operation.recovery
        ? `${operation.state}; Hive worktree recovery cannot acknowledge it: ${operation.recovery.reason}`
        : `${operation.state}; once its processes have stopped, ask an agent to inspect this entry with Hive worktree recovery and follow what recovery reports`,
    })),
  ]
  const pick = await vscode.window.showQuickPick(items, {
    title: `Cannot remove the record for ${id} yet`,
    placeHolder: 'Resolve these first. Select a task, worker, or checkout to open the file that names it.',
    matchOnDescription: true,
  })
  if (!pick?.file) return
  // Checked again now: the file may have changed or been replaced by a symlink since the inspection.
  const target = resolveProjectPath(projectRoot, pick.file)
  if (target.kind !== 'file') {
    vscode.window.showWarningMessage(`Hive: Did not open ${pick.file}: ${target.reason}.`)
    return
  }
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target.filePath))
}

function referenceItem(projectRoot: string, reference: RetainedCheckoutReference): BlockerItem {
  const source = reference.kind === 'task' ? reference.statusPath : reference.kind === 'worker' ? reference.sidecarPath : reference.recordPath
  const file = projectRelative(projectRoot, source)
  const detail = file ?? source
  if (reference.kind === 'task') return { label: `$(tasklist) Task ${reference.feature}/${reference.task}`, description: reference.status, detail, file }
  if (reference.kind === 'worker') {
    const owner = reference.runId !== undefined ? `run ${reference.runId}` : `${reference.feature}/${reference.task}${reference.candidate ? ` (${reference.candidate})` : ''}`
    return { label: `$(repo-forked) Worker ${owner}`, description: 'bound to this checkout', detail, file }
  }
  return { label: `$(git-branch) Checkout ${reference.from}`, description: 'declares this checkout as its next target', detail, file }
}

/** A normalized `/`-separated path inside the project, or undefined for a path outside it. */
function projectRelative(projectRoot: string, target: string): string | undefined {
  const relative = path.relative(projectRoot, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join('/')
}

function display(projectRoot: string, target: string): string {
  return projectRelative(projectRoot, target) ?? target
}

function shortRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
