import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { HiveService, HiveWatcher, Launcher } from './services'
import { HiveSidebarProvider, HivePanelProvider } from './providers'

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

  const hiveService = new HiveService(workspaceRoot)
  if (!hiveService.exists()) return

  const launcher = new Launcher(workspaceRoot)

  const sidebarProvider = new HiveSidebarProvider(hiveService)
  vscode.window.registerTreeDataProvider('hive.features', sidebarProvider)

  const panelProvider = new HivePanelProvider(context.extensionUri, hiveService)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(HivePanelProvider.viewType, panelProvider)
  )

  const watcher = new HiveWatcher(workspaceRoot, () => sidebarProvider.refresh())
  context.subscriptions.push({ dispose: () => watcher.dispose() })

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
        terminal.sendText(`opencode --command "/hive new ${name}"`)
        terminal.show()
      }
    }),

    vscode.commands.registerCommand('hive.openStepInOpenCode', (featureName: string, stepName: string, sessionId?: string) => {
      launcher.openStep('opencode', featureName, stepName, sessionId)
    }),

    vscode.commands.registerCommand('hive.createSession', async (item: { featureName?: string; stepFolder?: string }) => {
      if (item?.featureName && item?.stepFolder) {
        await launcher.createSession(item.featureName, item.stepFolder)
        sidebarProvider.refresh()
      }
    }),

    vscode.commands.registerCommand('hive.openFeatureInOpenCode', (featureName: string) => {
      launcher.openFeature('opencode', featureName)
    }),

    vscode.commands.registerCommand('hive.viewReport', (feature: string) => {
      const report = hiveService.getReport(feature)
      if (report) {
        vscode.workspace.openTextDocument({ content: report, language: 'markdown' })
          .then(doc => vscode.window.showTextDocument(doc))
      } else {
        vscode.window.showInformationMessage('No report generated yet')
      }
    }),

    vscode.commands.registerCommand('hive.showFeature', (featureName: string) => {
      panelProvider.showFeature(featureName)
    }),

    vscode.commands.registerCommand('hive.openInOpenCode', (item: { featureName?: string; stepFolder?: string; sessionId?: string }) => {
      if (item?.featureName && item?.stepFolder) {
        launcher.openStep('opencode', item.featureName, item.stepFolder, item.sessionId)
      }
    }),

    vscode.commands.registerCommand('hive.openFile', (filePath: string) => {
      if (filePath) {
        vscode.workspace.openTextDocument(filePath)
          .then(doc => vscode.window.showTextDocument(doc))
      }
    }),

    vscode.commands.registerCommand('hive.viewFeatureDetails', (item: { featureName?: string }) => {
      if (item?.featureName) {
        panelProvider.showFeature(item.featureName)
      }
    })
  )
}

export function deactivate(): void {}
