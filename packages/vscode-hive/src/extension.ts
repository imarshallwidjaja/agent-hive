import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { HiveWatcher, Launcher } from './services'
import { HiveSidebarProvider, PlanCommentController } from './providers'

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

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceFolder) return

  const workspaceRoot = findHiveRoot(workspaceFolder)
  if (!workspaceRoot) return

  const sidebarProvider = new HiveSidebarProvider(workspaceRoot)
  const launcher = new Launcher(workspaceRoot)
  const commentController = new PlanCommentController(workspaceRoot)

  vscode.window.registerTreeDataProvider('hive.features', sidebarProvider)
  commentController.registerCommands(context)

  context.subscriptions.push(
    vscode.commands.registerCommand('hive.refresh', () => {
      sidebarProvider.refresh()
    }),

    vscode.commands.registerCommand('hive.newFeature', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Feature name',
        placeHolder: 'my-feature'
      })
      if (name) {
        const terminal = vscode.window.createTerminal('OpenCode - Hive')
        terminal.sendText(`opencode --command "/hive ${name}"`)
        terminal.show()
      }
    }),

    vscode.commands.registerCommand('hive.openFeatureInOpenCode', (featureName: string) => {
      launcher.openFeature('opencode', featureName)
    }),

    vscode.commands.registerCommand('hive.openTaskInOpenCode', (item: { featureName?: string; folder?: string }) => {
      if (item?.featureName && item?.folder) {
        launcher.openStep('opencode', item.featureName, item.folder)
      }
    }),

    vscode.commands.registerCommand('hive.openFile', (filePath: string) => {
      if (filePath) {
        vscode.workspace.openTextDocument(filePath)
          .then(doc => vscode.window.showTextDocument(doc))
      }
    }),

    vscode.commands.registerCommand('hive.approvePlan', async (item: { featureName?: string }) => {
      if (item?.featureName) {
        const terminal = vscode.window.createTerminal('OpenCode - Hive')
        terminal.sendText(`opencode --command "hive_plan_approve"`)
        terminal.show()
      }
    }),

    vscode.commands.registerCommand('hive.syncTasks', async (item: { featureName?: string }) => {
      if (item?.featureName) {
        const terminal = vscode.window.createTerminal('OpenCode - Hive')
        terminal.sendText(`opencode --command "hive_tasks_sync"`)
        terminal.show()
      }
    }),

    vscode.commands.registerCommand('hive.startTask', async (item: { featureName?: string; folder?: string }) => {
      if (item?.featureName && item?.folder) {
        const terminal = vscode.window.createTerminal('OpenCode - Hive')
        terminal.sendText(`opencode --command "hive_exec_start task=${item.folder}"`)
        terminal.show()
      }
    }),

    vscode.commands.registerCommand('hive.openSession', async (item: { session?: { sessionId: string } }) => {
      if (item?.session?.sessionId) {
        const terminal = vscode.window.createTerminal('OpenCode - Hive')
        terminal.sendText(`opencode --session "${item.session.sessionId}"`)
        terminal.show()
      }
    }),

    vscode.commands.registerCommand('hive.plan.doneReview', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return

      const filePath = editor.document.uri.fsPath
      const featureMatch = filePath.match(/\.hive\/features\/([^/]+)\/plan\.md$/)
      if (!featureMatch) {
        vscode.window.showErrorMessage('Not a plan.md file')
        return
      }

      const featureName = featureMatch[1]
      const featureJsonPath = path.join(workspaceRoot, '.hive', 'features', featureName, 'feature.json')
      const commentsPath = path.join(workspaceRoot, '.hive', 'features', featureName, 'comments.json')

      let sessionId: string | undefined
      let comments: Array<{ body: string; line?: number }> = []

      try {
        const featureData = JSON.parse(fs.readFileSync(featureJsonPath, 'utf-8'))
        sessionId = featureData.sessionId
      } catch (error) {
        console.warn(`Hive: failed to read sessionId for feature '${featureName}'`, error)
      }

      try {
        const commentsData = JSON.parse(fs.readFileSync(commentsPath, 'utf-8'))
        comments = commentsData.threads || []
      } catch (error) {
        console.warn(`Hive: failed to read comments for feature '${featureName}'`, error)
      }

      const hasComments = comments.length > 0
      const inputPrompt = hasComments 
        ? `${comments.length} comment(s) found. Add feedback or leave empty to submit comments only`
        : 'Enter your review feedback (or leave empty to approve)'
      
      const userInput = await vscode.window.showInputBox({
        prompt: inputPrompt,
        placeHolder: hasComments ? 'Additional feedback (optional)' : 'e.g., "looks good" to approve, or describe changes needed'
      })
      
      if (userInput === undefined) return

      let prompt: string
      if (hasComments) {
        const allComments = comments.map(c => `Line ${c.line}: ${c.body}`).join('\n')
        if (userInput === '') {
          prompt = `User review comments:\n${allComments}`
        } else {
          prompt = `User review comments:\n${allComments}\n\nAdditional feedback: ${userInput}`
        }
      } else {
        if (userInput === '') {
          prompt = 'User reviewed the plan and approved. Run hive_plan_approve and then hive_tasks_sync.'
        } else {
          prompt = `User review feedback: "${userInput}"`
        }
      }

      const shellEscapeSingleQuotes = (value: string): string => {
        return `'${value.replace(/'/g, `'\"'\"'`)}'`
      }

      const terminal = vscode.window.createTerminal('OpenCode - Hive')
      const escapedPrompt = shellEscapeSingleQuotes(prompt)

      if (sessionId) {
        const escapedSessionId = shellEscapeSingleQuotes(sessionId)
        terminal.sendText(`opencode run --session ${escapedSessionId} ${escapedPrompt}`)
      } else {
        terminal.sendText(`opencode run ${escapedPrompt}`)
      }

      terminal.show()
    })
  )

  const watcher = new HiveWatcher(workspaceRoot, () => sidebarProvider.refresh())
  
  context.subscriptions.push(
    { dispose: () => watcher.dispose() }
  )
}

export function deactivate(): void {}
