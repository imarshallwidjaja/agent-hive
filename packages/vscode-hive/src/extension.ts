import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { HiveWatcher, Launcher } from './services'
import { HiveSidebarProvider, PlanCommentController } from './providers'

type ReviewDocument = 'plan' | 'overview'

function getReviewTarget(workspaceRoot: string, filePath: string): { featureName: string; document: ReviewDocument } | null {
  const normalizedWorkspace = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedPath = filePath.replace(/\\/g, '/')
  const compareWorkspace = process.platform === 'win32' ? normalizedWorkspace.toLowerCase() : normalizedWorkspace
  const comparePath = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath

  if (!comparePath.startsWith(`${compareWorkspace}/`)) {
    return null
  }

  const planMatch = normalizedPath.match(/\.hive\/features\/([^/]+)\/plan\.md$/)
  if (planMatch) {
    return { featureName: planMatch[1], document: 'plan' }
  }

  const overviewMatch = normalizedPath.match(/\.hive\/features\/([^/]+)\/context\/overview\.md$/)
  if (overviewMatch) {
    return { featureName: overviewMatch[1], document: 'overview' }
  }

  return null
}

function getReviewCommentsPath(workspaceRoot: string, featureName: string, document: ReviewDocument): string {
  const canonicalPath = path.join(workspaceRoot, '.hive', 'features', featureName, 'comments', `${document}.json`)
  if (fs.existsSync(canonicalPath)) {
    return canonicalPath
  }

  if (document === 'plan') {
    return path.join(workspaceRoot, '.hive', 'features', featureName, 'comments.json')
  }

  return canonicalPath
}

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
    this.launcher = new Launcher()
    this.commentController = new PlanCommentController(workspaceRoot)

    vscode.window.registerTreeDataProvider('hive.features', this.sidebarProvider)
    this.commentController.registerCommands(this.context)
    vscode.commands.executeCommand('setContext', 'hive.hasHiveRoot', true)

    this.hiveWatcher = new HiveWatcher(workspaceRoot, () => {
      this.sidebarProvider?.refresh()
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
      }),

      vscode.commands.registerCommand('hive.openFile', (filePath: string) => {
        if (filePath) {
          this.launcher?.openFile(filePath)
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
        const target = getReviewTarget(this.workspaceRoot, filePath)
        if (!target) {
          vscode.window.showErrorMessage('Not a reviewable plan.md or overview.md file')
          return
        }

        const commentsPath = getReviewCommentsPath(this.workspaceRoot, target.featureName, target.document)

        let comments: Array<{ body: string; line?: number }> = []

        try {
          const commentsData = JSON.parse(fs.readFileSync(commentsPath, 'utf-8'))
          comments = commentsData.threads || []
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
      })
    )
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceFolder) return

  const extension = new HiveExtension(context, workspaceFolder)
  extension.registerCommands()
  extension.initialize()
}

export function deactivate(): void {}
