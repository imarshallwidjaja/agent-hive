import * as vscode from 'vscode'

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
      await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(uri)
    } catch (error: any) {
      vscode.window.showErrorMessage(`Hive: Could not open file "${filePath}" - ${error}`)
    }
  }
}
