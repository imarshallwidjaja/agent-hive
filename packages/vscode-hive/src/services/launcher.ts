import * as vscode from 'vscode'
import * as fs from 'fs'
import { getNativeBackgroundJobsPath, isNativeObservationOwner } from 'hive-core'

export class Launcher {
  constructor(private readonly workspaceRoot: string) {}

  /**
   * Open a file in VS Code
   */
  async openFile(filePath: string): Promise<void> {
    if (!filePath) {
      vscode.window.showWarningMessage('Hive: Invalid file path')
      return
    }

    try {
      const uri = vscode.Uri.file(filePath)
      const stat = fs.statSync(filePath)
      if (stat.isDirectory()) {
        await vscode.commands.executeCommand('revealFileInOS', uri)
        return
      }

      await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(uri)
    } catch (error: any) {
      vscode.window.showErrorMessage(`Hive: Could not open file "${filePath}" - ${error}`)
    }
  }

  /** Opens the board of one native owner at a job's exact alias line; the owner selects the file, never a caller-supplied path. */
  async openBackgroundJobInBoard(owner: unknown, alias: unknown): Promise<void> {
    if (!isNativeObservationOwner(owner) || typeof alias !== 'string' || alias === '') {
      vscode.window.showWarningMessage('Hive: Invalid background job reference')
      return
    }

    try {
      const boardPath = getNativeBackgroundJobsPath(this.workspaceRoot, owner)
      const uri = vscode.Uri.file(boardPath)
      const content = fs.readFileSync(boardPath, 'utf-8')
      const lineIndex = content.split(/\r?\n/).findIndex(line => line.includes(`"alias": ${JSON.stringify(alias)}`))
      const document = await vscode.workspace.openTextDocument(uri)
      const selection = lineIndex >= 0
        ? new vscode.Selection(new vscode.Position(lineIndex, 0), new vscode.Position(lineIndex, 0))
        : undefined

      await vscode.window.showTextDocument(document, selection ? { selection } : undefined)
      if (lineIndex < 0) {
        vscode.window.showWarningMessage(`Hive: Background job "${alias}" was not found in the board file`)
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Hive: Could not open background job "${alias}" - ${error}`)
    }
  }
}
