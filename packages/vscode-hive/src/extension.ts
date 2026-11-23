import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { detectContext, isExplorationId } from 'hive-core'
import { HiveWatcher, Launcher } from './services'
import { HiveSidebarProvider, PlanCommentController, RepositoryWorkProvider } from './providers'

import { archiveContext, isContextScope } from './providers/contextInspection.js'
import { copyLocation, openInNewWindow, openTerminal } from './providers/repositoryWorkProvider.js'
import { removeStaleCheckoutRecord } from './providers/staleCheckoutRecord.js'
import { SessionConstraintsProvider } from './providers/sessionConstraintsProvider.js'
import { WorklogDocuments } from './providers/worklogDocuments.js'
import type { WorklogDocumentView } from './providers/worklogDocuments.js'
import { WorklogViewerPreferences, WorklogsProvider, pickWorklog } from './providers/worklogsProvider.js'
import { describeFailure } from './providers/worklogPresentation.js'
import { ExplorationsProvider, pickExploration } from './providers/explorationsProvider.js'
import { ExplorationViewer } from './providers/explorationViewer.js'

import { reviewTargetForDocument, findReviewCommentsPath } from './reviewRouting.js'

/**
 * The real path of a workspace folder, keeping the trailing components that do not exist so a removed placement is
 * still recognized by its location. Null when the folder cannot be resolved: a broken or cyclic link, a component that
 * is a file, or a path that cannot be read. Guessing a root from such a path could select an unrelated project.
 */
function resolveWorkspacePath(startPath: string): string | null {
  const missing: string[] = []
  let current = path.resolve(startPath)
  for (;;) {
    try {
      const real = fs.realpathSync(current)
      // Also after climbing: Windows reports a path below a file as missing rather than as not a directory.
      if (!fs.statSync(real).isDirectory()) return null
      return path.join(real, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    try {
      fs.lstatSync(current)
      return null // The entry exists but cannot be followed: a link whose target is gone.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    const parent = path.dirname(current)
    if (parent === current) return null
    missing.push(path.basename(current))
    current = parent
  }
}

const NO_HIVE_DIRECTORY = 'Hive: No .hive directory found. Open a Hive workspace, then refresh this view.'

/**
 * Whether `directory` holds a .hive directory, or the warning to show when that cannot be told. A .hive that exists
 * but cannot be read or searched, is a file, or is a broken link stops the search: looking further up could open an
 * unrelated project.
 */
function hiveDirectoryIn(directory: string): boolean | string {
  const hive = path.join(directory, '.hive')
  const stopped = (problem: string, advice: string) =>
    `Hive: No project opened. ${hive} ${problem}, so the search for a Hive project stopped there. ${advice}, then refresh this view.`
  const unreadable = (error: unknown) =>
    stopped(`could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`, 'Check its permissions or open the Hive project folder')
  let stats: fs.Stats
  try {
    stats = fs.statSync(hive)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unreadable(error)
    // A link whose target is gone reports ENOENT too, but it is an entry, not an absent .hive.
    try {
      stats = fs.lstatSync(hive)
    } catch (linkError) {
      return (linkError as NodeJS.ErrnoException).code === 'ENOENT' ? false : unreadable(linkError)
    }
  }
  if (!stats.isDirectory()) return stopped('is not a directory', 'Open the Hive project folder')
  // stat needs only the parent's permissions; listing and opening entries inside .hive needs its own. Windows access
  // ignores ACLs, so the listing itself is tried too.
  try {
    fs.accessSync(hive, fs.constants.R_OK | fs.constants.X_OK)
    fs.readdirSync(hive)
  } catch (error) {
    return unreadable(error)
  }
  return true
}

/** The project a workspace folder opens, or the warning that explains why it opens none. */
function findHiveRoot(startPath: string): { root: string } | { root: null; warning: string } {
  // Placement detection reads the path, so an alias is resolved first.
  const resolved = resolveWorkspacePath(startPath)
  if (!resolved) {
    return { root: null, warning: `Hive: No project opened. ${startPath} could not be resolved: a link in its path is broken, part of it is a file, or it cannot be read. Open the Hive project folder, then refresh this view.` }
  }
  // A worker or retained checkout that Hive placed may hold a .hive of its own; the project that holds the placement
  // governs. When that project's .hive is gone there is no project to read.
  const detected = detectContext(resolved)
  if (detected.isWorktree) {
    const hive = hiveDirectoryIn(detected.projectRoot)
    return hive === true ? { root: detected.projectRoot } : { root: null, warning: hive || NO_HIVE_DIRECTORY }
  }
  let root = resolved
  for (;;) {
    if (root === path.dirname(root)) return { root: null, warning: NO_HIVE_DIRECTORY }
    const hive = hiveDirectoryIn(root)
    if (typeof hive === 'string') return { root: null, warning: hive }
    if (hive) break
    root = path.dirname(root)
  }
  // Plan review matches document paths to the root by their spelling, and the editor spells documents through the
  // folder the window opened. When that folder or one of its ancestors names this project, keep its spelling.
  for (let spelled = path.resolve(startPath); spelled !== path.dirname(spelled); spelled = path.dirname(spelled)) {
    try {
      if (fs.realpathSync(spelled) === root) return { root: spelled }
    } catch {
      // A component that does not resolve, such as a missing folder below the project; its ancestors may still name it.
    }
  }
  return { root }
}

class HiveExtension {
  private sidebarProvider: HiveSidebarProvider | null = null
  private repositoryWorkProvider: RepositoryWorkProvider | null = null
  private sessionConstraintsProvider: SessionConstraintsProvider | null = null
  private worklogsProvider: WorklogsProvider | null = null
  private worklogDocuments: WorklogDocuments | null = null
  private worklogPreferences: WorklogViewerPreferences | null = null
  private explorationsProvider: ExplorationsProvider | null = null
  private explorationViewer: ExplorationViewer | null = null
  private launcher: Launcher | null = null
  private commentController: PlanCommentController | null = null
  private hiveWatcher: HiveWatcher | null = null
  private creationWatcher: vscode.FileSystemWatcher | null = null
  private workspaceRoot: string | null = null
  private initialized = false

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceFolder: string
  ) {}

  initialize(): void {
    this.workspaceRoot = findHiveRoot(this.workspaceFolder).root
    
    if (this.workspaceRoot) {
      this.initializeWithHive(this.workspaceRoot)
    } else {
      this.initializeWithoutHive()
    }
  }

  private initializeWithHive(workspaceRoot: string): void {
    if (this.initialized) return
    this.initialized = true

    this.sidebarProvider = new HiveSidebarProvider(workspaceRoot)
    this.repositoryWorkProvider = new RepositoryWorkProvider(workspaceRoot)
    this.sessionConstraintsProvider = new SessionConstraintsProvider(workspaceRoot)
    this.context.subscriptions.push(
      this.sessionConstraintsProvider,
      vscode.workspace.registerTextDocumentContentProvider(SessionConstraintsProvider.scheme, this.sessionConstraintsProvider),
      vscode.workspace.onDidCloseTextDocument(document => this.sessionConstraintsProvider?.close(document.uri)),
    )
    this.worklogPreferences = new WorklogViewerPreferences(this.context.workspaceState, workspaceRoot)
    this.worklogsProvider = new WorklogsProvider(workspaceRoot, this.worklogPreferences)
    this.worklogDocuments = new WorklogDocuments(workspaceRoot)
    const worklogsView = vscode.window.createTreeView('hive.worklogs', { treeDataProvider: this.worklogsProvider })
    // Only the first workspace folder's project is read; the view names it so a multi-root window is not misread.
    worklogsView.description = path.basename(workspaceRoot)
    this.context.subscriptions.push(
      worklogsView,
      this.worklogDocuments,
      vscode.workspace.registerTextDocumentContentProvider(WorklogDocuments.scheme, this.worklogDocuments),
      vscode.languages.registerDocumentLinkProvider({ scheme: WorklogDocuments.scheme }, this.worklogDocuments),
      vscode.workspace.onDidCloseTextDocument(document => this.worklogDocuments?.close(document.uri)),
    )
    this.explorationsProvider = new ExplorationsProvider(workspaceRoot)
    this.explorationViewer = new ExplorationViewer(workspaceRoot)
    const explorationsView = vscode.window.createTreeView('hive.explorations', { treeDataProvider: this.explorationsProvider })
    explorationsView.description = path.basename(workspaceRoot)
    this.context.subscriptions.push(explorationsView, this.explorationViewer)
    this.launcher = new Launcher()
    this.commentController = new PlanCommentController(workspaceRoot)

    vscode.window.registerTreeDataProvider('hive.features', this.sidebarProvider)
    const repositoriesView = vscode.window.createTreeView('hive.repositories', { treeDataProvider: this.repositoryWorkProvider })
    this.context.subscriptions.push(repositoriesView, ...this.repositoryWorkProvider.attach(repositoriesView))
    this.commentController.registerCommands(this.context)
    vscode.commands.executeCommand('setContext', 'hive.hasHiveRoot', true)

    this.hiveWatcher = new HiveWatcher(workspaceRoot, () => {
      this.sidebarProvider?.refresh()
      this.repositoryWorkProvider?.refresh()
      this.sessionConstraintsProvider?.refresh()
      this.worklogsProvider?.refresh()
      this.worklogDocuments?.refresh()
    }, (explorationId) => {
      // Only the Explorations view and that exploration's tab read exploration records.
      this.explorationsProvider?.refresh()
      this.explorationViewer?.recordChanged(explorationId)
    })
    this.context.subscriptions.push({ dispose: () => this.hiveWatcher?.dispose() })

    if (this.creationWatcher) {
      this.creationWatcher.dispose()
      this.creationWatcher = null
    }
  }

  private initializeWithoutHive(): void {
    vscode.commands.executeCommand('setContext', 'hive.hasHiveRoot', false)
    
    this.creationWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceFolder, '.hive/**')
    )

    const onHiveCreated = () => {
      const newRoot = findHiveRoot(this.workspaceFolder).root
      if (newRoot && !this.initialized) {
        this.workspaceRoot = newRoot
        this.initializeWithHive(newRoot)
      }
    }

    this.creationWatcher.onDidCreate(onHiveCreated)
    this.context.subscriptions.push(this.creationWatcher)
  }

  registerCommands(): void {
    const workspaceFolder = this.workspaceFolder

    this.context.subscriptions.push(
      vscode.commands.registerCommand('hive.refresh', () => {
        if (!this.initialized) {
          const found = findHiveRoot(workspaceFolder)
          if ('warning' in found) {
            vscode.window.showWarningMessage(found.warning)
            return
          }
          this.workspaceRoot = found.root
          this.initializeWithHive(found.root)
        }
        this.sidebarProvider?.refresh()
        this.repositoryWorkProvider?.refresh()
        this.sessionConstraintsProvider?.refresh()
        this.worklogsProvider?.refresh()
        this.worklogDocuments?.refresh()
        this.explorationsProvider?.refresh()
        this.explorationViewer?.refreshAll()
      }),

      vscode.commands.registerCommand('hive.exploration.open', async (target?: unknown) => {
        if (!this.workspaceRoot || !this.explorationViewer) {
          vscode.window.showInformationMessage('Hive: Open a workspace containing .hive to read explorations.')
          return
        }
        const fromItem = (target as { explorationId?: unknown } | undefined)?.explorationId
        const given = typeof target === 'string' ? target : fromItem
        const id = given === undefined ? await pickExploration(this.workspaceRoot) : given
        if (id === undefined) return
        if (!isExplorationId(id)) {
          vscode.window.showErrorMessage('Hive: That is not an exploration ID.')
          return
        }
        this.explorationViewer.open(id)
      }),

      vscode.commands.registerCommand('hive.worklog.open', async (target?: unknown) => {
        if (!this.workspaceRoot || !this.worklogDocuments) {
          vscode.window.showInformationMessage('Hive: Open a workspace containing .hive to read worklogs.')
          return
        }
        // Open never reuses the active document: without an explicit key or row it always asks.
        const key = (target === undefined ? null : this.worklogKeyFrom(target)) ?? await pickWorklog(this.workspaceRoot)
        if (key) await this.showWorklog('brief', key)
      }),

      vscode.commands.registerCommand('hive.worklog.showHistory', (target?: unknown) => this.showWorklogTarget('history', target)),
      vscode.commands.registerCommand('hive.worklog.showFacts', (target?: unknown) => this.showWorklogTarget('facts', target)),

      vscode.commands.registerCommand('hive.worklog.pin', async (target?: unknown) => {
        const key = this.worklogKeyFrom(target)
        if (!key || !this.worklogPreferences) {
          vscode.window.showInformationMessage('Hive: Choose a worklog to pin.')
          return
        }
        try {
          if (!await this.worklogPreferences.pin(key)) vscode.window.showInformationMessage(`Hive: ${key} is already pinned.`)
        } catch (error) {
          vscode.window.showErrorMessage(`Hive: Could not pin ${key}. ${describeFailure(error).message}`)
        }
        this.worklogsProvider?.refresh()
      }),

      vscode.commands.registerCommand('hive.worklog.unpin', async (target?: unknown) => {
        const key = this.worklogKeyFrom(target)
        if (!key || !this.worklogPreferences) {
          vscode.window.showInformationMessage('Hive: Choose a pinned worklog to unpin.')
          return
        }
        await this.worklogPreferences.unpin(key)
        this.worklogsProvider?.refresh()
      }),

      vscode.commands.registerCommand('hive.worklog.loadMore', async (target?: unknown) => {
        if ((target as { loadMore?: unknown } | undefined)?.loadMore === 'recent') {
          this.worklogsProvider?.loadMoreRecent()
          return
        }
        const uri = isWorklogUri(target) ? target : vscode.window.activeTextEditor?.document.uri
        if (!uri || uri.scheme !== WorklogDocuments.scheme || !this.worklogDocuments) {
          vscode.window.showInformationMessage('Hive: Open a worklog history or facts document to load more.')
          return
        }
        await this.worklogDocuments.loadMore(uri)
      }),

      vscode.commands.registerCommand('hive.context.archive', async (item) => {
        if (!this.workspaceRoot) {
          vscode.window.showErrorMessage('Hive: No .hive directory found')
          return
        }
        await archiveContext(this.workspaceRoot, item, () => this.sidebarProvider?.refresh())
      }),

      vscode.commands.registerCommand('hive.context.loadMore', (scope: unknown) => {
        if (!isContextScope(scope)) {
          vscode.window.showErrorMessage('Hive: Context scope binding unavailable for load more.')
          return
        }
        this.sidebarProvider?.loadMore(scope)
      }),

      vscode.commands.registerCommand('hive.context.scanChars', (item) => {
        if (!this.workspaceRoot) {
          vscode.window.showErrorMessage('Hive: No .hive directory found')
          return
        }
        const scope = (item as { scope?: unknown } | undefined)?.scope
        if (!isContextScope(scope)) {
          vscode.window.showErrorMessage('Hive: Select a Project Context or feature Context folder to scan character totals.')
          return
        }
        this.sidebarProvider?.scanChars(scope)
      }),

      vscode.commands.registerCommand('hive.constraints.inspect', async () => {
        if (!this.sessionConstraintsProvider) {
          vscode.window.showInformationMessage('Hive: Open a workspace containing .hive to inspect session constraints.')
          return
        }
        await this.sessionConstraintsProvider.inspect()
      }),

      vscode.commands.registerCommand('hive.openFile', (filePathOrItem: string | { command?: { arguments?: unknown[] } }) => {
        const filePath = typeof filePathOrItem === 'string'
          ? filePathOrItem
          : filePathOrItem?.command?.arguments?.[0]
        if (typeof filePath === 'string' && filePath) {
          this.launcher?.openFile(filePath)
        }
      }),

      vscode.commands.registerCommand('hive.repositories.openInNewWindow', openInNewWindow),
      vscode.commands.registerCommand('hive.repositories.openTerminal', openTerminal),
      vscode.commands.registerCommand('hive.repositories.copyPath', (item: unknown) => copyLocation(item, 'path')),
      vscode.commands.registerCommand('hive.repositories.copyBranch', (item: unknown) => copyLocation(item, 'ref')),
      vscode.commands.registerCommand('hive.repositories.copyCommit', (item: unknown) => copyLocation(item, 'commit')),
      vscode.commands.registerCommand('hive.repositories.removeStaleRecord', async (item: unknown) => {
        // The project the row was read from, not the window folder: an alias may point elsewhere by now.
        const provider = this.repositoryWorkProvider
        if (!provider) {
          vscode.window.showErrorMessage('Hive: No .hive directory found')
          return
        }
        await removeStaleCheckoutRecord(provider.projectRoot, item, () => provider.refresh())
      }),

      vscode.commands.registerCommand('hive.copyToClipboard', async (valueOrItem: string | { copyCommand?: { arguments?: string[] } }) => {
        const value = typeof valueOrItem === 'string'
          ? valueOrItem
          : valueOrItem?.copyCommand?.arguments?.[0]
        if (value) {
          await vscode.env.clipboard.writeText(value)
          vscode.window.showInformationMessage('Hive: copied to clipboard.')
        }
      }),

      vscode.commands.registerCommand('hive.plan.doneReview', async () => {
        const editor = vscode.window.activeTextEditor
        if (!editor) return

        if (!this.workspaceRoot) {
          vscode.window.showErrorMessage('Hive: No .hive directory found')
          return
        }

        const filePath = editor.document.uri.fsPath
        const target = reviewTargetForDocument(this.workspaceRoot, filePath)
        if (!target) {
          vscode.window.showErrorMessage('Not a reviewable plan.md or overview.md file')
          return
        }

        const commentsPath = findReviewCommentsPath(this.workspaceRoot, target)

        let comments: Array<{ body: string; line?: number }> = []

        try {
          if (commentsPath) {
            const commentsData = JSON.parse(fs.readFileSync(commentsPath, 'utf-8'))
            comments = commentsData.threads || []
          }
        } catch (error) {
          // No comments file is fine
        }

        const docLabel = target.document === 'overview' ? 'Overview' : 'Plan'
        const hasComments = comments.length > 0
        const inputPrompt = hasComments 
          ? `${docLabel}: ${comments.length} comment(s) found. Add feedback or leave empty to submit comments only`
          : `Enter your ${docLabel.toLowerCase()} review feedback (or leave empty to approve)`
        
        const userInput = await vscode.window.showInputBox({
          prompt: inputPrompt,
          placeHolder: hasComments ? 'Additional feedback (optional)' : 'e.g., "looks good" to approve, or describe changes needed'
        })
        
        if (userInput === undefined) return
        
        let feedback: string
        if (hasComments) {
          const allComments = comments.map(c => `Line ${c.line}: ${c.body}`).join('\n')
          feedback = userInput === '' 
            ? `${docLabel} review comments:\n${allComments}`
            : `${docLabel} review comments:\n${allComments}\n\nAdditional feedback: ${userInput}`
        } else {
          feedback = userInput === ''
            ? `${docLabel} approved`
            : `${docLabel} review feedback: ${userInput}`
        }

        vscode.window.showInformationMessage(
          `Hive: ${hasComments ? 'Comments submitted' : 'Review submitted'}. The review summary has been copied to your clipboard.`
        )
        
        await vscode.env.clipboard.writeText(feedback)
        vscode.window.showInformationMessage('Hive: Feedback copied to clipboard for your next planning step.')
      }),

      vscode.commands.registerCommand('hive.feature.archive', async (featureItem: any) => {
        if (!this.workspaceRoot) {
          vscode.window.showErrorMessage('Hive: No .hive directory found')
          return
        }

        const featureName = featureItem?.name || featureItem?.label
        if (!featureName) {
          vscode.window.showErrorMessage('Hive: No feature selected')
          return
        }

        const confirmResult = await vscode.window.showWarningMessage(
          `Archive feature "${featureName}"? This excludes it from implicit sole-live resolution and normal agent status, but keeps its .hive files for audit or manual recovery. It does not delete worktrees, branches, tasks, or commits.`,
          { modal: true },
          'Archive Feature'
        )
        if (confirmResult !== 'Archive Feature') return

        const reason = await vscode.window.showInputBox({
          prompt: 'Reason for archiving (optional)',
          placeHolder: 'e.g., No longer needed'
        })
        if (reason === undefined) return

        const { FeatureService } = await import('hive-core')
        const service = new FeatureService(this.workspaceRoot)
        service.archive(featureName, reason || undefined)

        vscode.window.showInformationMessage(`Hive: Feature "${featureName}" archived.`)
        this.sidebarProvider?.refresh()
      })
    )
  }

  /**
   * A worklog key from a command argument: a key string, a tree row, or a worklog document URI (editor title
   * actions pass the resource). Without an argument, the active worklog document supplies it.
   */
  private worklogKeyFrom(target: unknown): string | null {
    if (typeof target === 'string' && target) return target
    const fromItem = (target as { worklogKey?: unknown } | undefined)?.worklogKey
    if (typeof fromItem === 'string' && fromItem) return fromItem
    const uri = target === undefined ? vscode.window.activeTextEditor?.document.uri : target
    return isWorklogUri(uri) && this.worklogDocuments ? this.worklogDocuments.keyFor(uri) : null
  }

  private async showWorklogTarget(view: WorklogDocumentView, target: unknown): Promise<void> {
    const key = this.worklogKeyFrom(target)
    if (!key) {
      vscode.window.showInformationMessage('Hive: Choose a worklog first, from the Worklogs view or Open Worklog.')
      return
    }
    await this.showWorklog(view, key)
  }

  /** Opening is the only way the selection changes; reading writes nothing under .hive. */
  private async showWorklog(view: WorklogDocumentView, key: string): Promise<void> {
    if (!this.worklogDocuments || !this.worklogPreferences) return
    try {
      await this.worklogPreferences.select(key)
    } catch (error) {
      vscode.window.showErrorMessage(`Hive: ${key} is not a worklog key. ${describeFailure(error).message}`)
      return
    }
    this.worklogsProvider?.refresh()
    await this.worklogDocuments.show(view, key)
  }
}

function isWorklogUri(value: unknown): value is vscode.Uri {
  return (value as vscode.Uri | undefined)?.scheme === WorklogDocuments.scheme
}

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceFolder) return

  const extension = new HiveExtension(context, workspaceFolder)
  extension.registerCommands()
  extension.initialize()
}

export function deactivate(): void {}
