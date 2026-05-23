import * as vscode from 'vscode'
import * as path from 'path'

export class Launcher {
  constructor(private workspaceRoot: string) {}

  /**
   * Open a file in VS Code
   */
  async openFile(filePath: string): Promise<void> {
    if (!filePath || !this.workspaceRoot) {
      vscode.window.showWarningMessage('Hive: Invalid file path or workspace root')
      return
    }

    try {
      const uri = vscode.Uri.file(filePath)
      await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(uri)
    } catch (error: any) {
      vscode.window.showErrorMessage(`Hive: Could not open file "${filePath}" - ${error}`)
    }
  }
}
