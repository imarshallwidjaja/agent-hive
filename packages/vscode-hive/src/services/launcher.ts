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
}
