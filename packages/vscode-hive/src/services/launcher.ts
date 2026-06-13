import * as vscode from 'vscode'
import * as fs from 'fs'

export class Launcher {
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

  async openBackgroundJobInBoard(boardPath: string, taskId: string): Promise<void> {
    if (!boardPath || !taskId) {
      vscode.window.showWarningMessage('Hive: Invalid background job reference')
      return
    }

    try {
      const uri = vscode.Uri.file(boardPath)
      const content = fs.readFileSync(boardPath, 'utf-8')
      const lineIndex = content.split(/\r?\n/).findIndex(line => line.includes(`"taskId": "${taskId}"`))
      const document = await vscode.workspace.openTextDocument(uri)
      const selection = lineIndex >= 0
        ? new vscode.Selection(new vscode.Position(lineIndex, 0), new vscode.Position(lineIndex, 0))
        : undefined

      await vscode.window.showTextDocument(document, selection ? { selection } : undefined)
      if (lineIndex < 0) {
        vscode.window.showWarningMessage(`Hive: Background job "${taskId}" was not found in the board file`)
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Hive: Could not open background job "${taskId}" - ${error}`)
    }
  }
}
