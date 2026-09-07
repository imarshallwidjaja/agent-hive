import * as vscode from 'vscode';
import { SessionService, STANDING_CONSTRAINTS_MAX_CHARS } from 'hive-core';

export class SessionConstraintsProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'hive-standing-constraints';
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly selections = new Map<string, { uri: vscode.Uri; sessionId: string }>();
  private nextDocument = 0;
  private readonly service: SessionService;

  constructor(workspaceRoot: string) {
    this.service = new SessionService(workspaceRoot);
  }

  async inspect(): Promise<void> {
    try {
      const sessions = this.service.listGlobal().filter(session =>
        this.service.readStandingConstraints(session.sessionId).entries.length > 0);
      if (!sessions.length) {
        vscode.window.showInformationMessage('Hive: No sessions with standing constraints in this project.');
        return;
      }
      const selected = await vscode.window.showQuickPick(sessions.map(session => ({
        label: session.agent || session.baseAgent || 'Unknown agent',
        description: `${session.featureName || 'Unbound'} · ${session.sessionKind || 'unknown'}`,
        detail: `Last active: ${session.lastActiveAt} · ID: ${session.sessionId}`,
        sessionId: session.sessionId,
      })), { title: 'Inspect Session Standing Constraints', placeHolder: 'Choose a session explicitly', matchOnDescription: true, matchOnDetail: true });
      if (!selected) return;
      if (!this.service.getGlobal(selected.sessionId) || !this.service.readStandingConstraints(selected.sessionId).entries.length) {
        vscode.window.showInformationMessage('Hive: The selected session or its standing constraints no longer exist.');
        return;
      }
      const uri = vscode.Uri.parse(`${SessionConstraintsProvider.scheme}:/session-${++this.nextDocument}.txt`);
      this.selections.set(uri.toString(), { uri, sessionId: selected.sessionId });
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      vscode.window.showErrorMessage(`Hive: Could not inspect standing constraints. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const selection = this.selections.get(uri.toString());
    if (!selection) return 'No session selected. Use Inspect Session Standing Constraints.';
    try {
      const session = this.service.getGlobal(selection.sessionId);
      if (!session) return 'The selected session no longer exists.';
      const register = this.service.readStandingConstraints(selection.sessionId);
      return [
        'Session Standing Constraints (read-only)',
        `Session ID: ${session.sessionId}`,
        `Agent: ${session.agent || session.baseAgent || 'Unknown'}`,
        `Kind: ${session.sessionKind || 'unknown'}`,
        `Feature: ${session.featureName || 'Unbound'}`,
        'Scope: Operator directives for this session; this inspector does not select an active session.',
        `Revision: ${register.revision}`,
        `Usage: ${register.constraintsChars}/${STANDING_CONSTRAINTS_MAX_CHARS} characters (UTF-16 code units)`,
        '',
        ...(register.entries.length ? register.entries.map(entry => `ID: ${entry.id}\n${entry.text}`) : ['No standing constraints remain.']),
      ].join('\n\n');
    } catch {
      return 'Standing constraints could not be read. Refresh or reopen the inspector.';
    }
  }

  refresh(): void {
    for (const { uri } of this.selections.values()) this.changed.fire(uri);
  }

  close(uri: vscode.Uri): void {
    this.selections.delete(uri.toString());
  }

  dispose(): void {
    this.selections.clear();
    this.changed.dispose();
  }
}
