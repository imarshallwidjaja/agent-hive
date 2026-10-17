import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { HiveWatcher, Launcher } from './services'
import { BackgroundJobsProvider, HiveSidebarProvider, PlanCommentController, TrackedRepositoriesProvider } from './providers'

import { archiveContext, isContextScope } from './providers/contextInspection.js'
import { archiveBackgroundJobItem } from './providers/backgroundJobsProvider.js'
import { SessionConstraintsProvider } from './providers/sessionConstraintsProvider.js'
import { WorklogDocuments } from './providers/worklogDocuments.js'
import type { WorklogDocumentView } from './providers/worklogDocuments.js'
import { WorklogViewerPreferences, WorklogsProvider, pickWorklog } from './providers/worklogsProvider.js'
import { describeFailure } from './providers/worklogPresentation.js'

import { reviewTargetForDocument, findReviewCommentsPath } from './reviewRouting.js'

function findHiveRoot(startPath: string): string | null {
  let current = startPath
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.hive'))) {
      return current
    }
    current = path.dirname(current)
  }
  return null
}

class HiveExtension {
  private sidebarProvider: HiveSidebarProvider | null = null
  private backgroundJobsProvider: BackgroundJobsProvider | null = null
  private trackedRepositoriesProvider: TrackedRepositoriesProvider | null = null
  private sessionConstraintsProvider: SessionConstraintsProvider | null = null
  private worklogsProvider: WorklogsProvider | null = null
  private worklogDocuments: WorklogDocuments | null = null
  private worklogPreferences: WorklogViewerPreferences | null = null
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
    this.workspaceRoot = findHiveRoot(this.workspaceFolder)
    
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
    this.backgroundJobsProvider = new BackgroundJobsProvider(workspaceRoot)
    this.trackedRepositoriesProvider = new TrackedRepositoriesProvider(workspaceRoot)
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
    this.launcher = new Launcher(workspaceRoot)
    this.commentController = new PlanCommentController(workspaceRoot)

    vscode.window.registerTreeDataProvider('hive.features', this.sidebarProvider)
    vscode.window.registerTreeDataProvider('hive.backgroundJobs', this.backgroundJobsProvider)
    vscode.window.registerTreeDataProvider('hive.repositories', this.trackedRepositoriesProvider)
    this.commentController.registerCommands(this.context)
    vscode.commands.executeCommand('setContext', 'hive.hasHiveRoot', true)

    this.hiveWatcher = new HiveWatcher(workspaceRoot, () => {
      this.sidebarProvider?.refresh()
      this.backgroundJobsProvider?.refresh()
      this.trackedRepositoriesProvider?.refresh()
      this.sessionConstraintsProvider?.refresh()
      this.worklogsProvider?.refresh()
      this.worklogDocuments?.refresh()
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
      const newRoot = findHiveRoot(this.workspaceFolder)
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
          const newRoot = findHiveRoot(workspaceFolder)
          if (newRoot) {
            this.workspaceRoot = newRoot
            this.initializeWithHive(newRoot)
          } else {
            vscode.window.showWarningMessage('Hive: No .hive directory found. Open a Hive workspace, then refresh this view.')
            return
          }
        }
        this.sidebarProvider?.refresh()
        this.backgroundJobsProvider?.refresh()
        this.trackedRepositoriesProvider?.refresh()
        this.sessionConstraintsProvider?.refresh()
        this.worklogsProvider?.refresh()
        this.worklogDocuments?.refresh()
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

      vscode.commands.registerCommand('hive.openFile', (filePathOrItem: string | { command?: { command?: string; arguments?: unknown[] } }) => {
        if (typeof filePathOrItem !== 'string' && filePathOrItem?.command?.command === 'hive.openBackgroundJobInBoard') {
          // Any caller can supply these arguments; a non-array reaches the launcher as an invalid reference instead of throwing.
          const args = filePathOrItem.command.arguments
          const [owner, alias] = Array.isArray(args) ? args : []
          this.launcher?.openBackgroundJobInBoard(owner, alias)
          return
        }
        const filePath = typeof filePathOrItem === 'string'
          ? filePathOrItem
          : filePathOrItem?.command?.arguments?.[0]
        if (typeof filePath === 'string' && filePath) {
          this.launcher?.openFile(filePath)
        }
      }),

      vscode.commands.registerCommand('hive.openBackgroundJobInBoard', (owner: unknown, alias: unknown) => {
        this.launcher?.openBackgroundJobInBoard(owner, alias)
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
      }),

      vscode.commands.registerCommand('hive.job.archive', async (jobItem: unknown) => {
        if (!this.workspaceRoot) {
          vscode.window.showErrorMessage('Hive: No .hive directory found')
          return
        }
        await archiveBackgroundJobItem(this.workspaceRoot, jobItem, () => this.backgroundJobsProvider?.refresh())
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
