import * as vscode from 'vscode';
import type { NativeObservationOwner, SessionInfo } from 'hive-core';
import {
  DEFAULT_NATIVE_OBSERVATION_OWNER,
  NATIVE_OBSERVATION_OWNERS,
  SessionService,
  STANDING_CONSTRAINTS_MAX_CHARS,
  getNativeObservationOwnerLabel,
} from 'hive-core';

export class SessionConstraintsProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'hive-standing-constraints';
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly selections = new Map<string, { uri: vscode.Uri; owner: NativeObservationOwner; sessionId: string }>();
  private nextDocument = 0;
  private readonly services: ReadonlyMap<NativeObservationOwner, SessionService>;

  constructor(workspaceRoot: string) {
    this.services = new Map(NATIVE_OBSERVATION_OWNERS.map(owner => [owner, new SessionService(workspaceRoot, owner)]));
  }

  async inspect(): Promise<void> {
    try {
      // Each owner's index is read separately so an unreadable one is reported without hiding the others.
      const sessions: Array<{ owner: NativeObservationOwner; session: SessionInfo }> = [];
      const unreadable: string[] = [];
      for (const [owner, service] of this.services) {
        try {
          for (const session of service.listGlobal()) {
            if (service.readStandingConstraints(session.sessionId).entries.length > 0) sessions.push({ owner, session });
          }
        } catch (error) {
          unreadable.push(`${getNativeObservationOwnerLabel(owner)} (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      if (unreadable.length) {
        vscode.window.showWarningMessage(`Hive: Could not read session constraints for ${unreadable.join('; ')}.`);
      }
      if (!sessions.length) {
        if (!unreadable.length) vscode.window.showInformationMessage('Hive: No sessions with standing constraints in this project.');
        return;
      }
      const selected = await vscode.window.showQuickPick(sessions.map(({ owner, session }) => ({
        label: session.agent || session.baseAgent || 'Unknown agent',
        description: [session.featureName || 'Unbound', session.sessionKind || 'unknown', ownerNote(owner)].filter(Boolean).join(' · '),
        detail: `Last active: ${session.lastActiveAt} · ID: ${session.sessionId}`,
        owner,
        sessionId: session.sessionId,
      })), { title: 'Inspect Session Standing Constraints', placeHolder: 'Choose a session explicitly', matchOnDescription: true, matchOnDetail: true });
      if (!selected) return;
      const service = this.services.get(selected.owner);
      if (!service?.getGlobal(selected.sessionId) || !service.readStandingConstraints(selected.sessionId).entries.length) {
        vscode.window.showInformationMessage('Hive: The selected session or its standing constraints no longer exist.');
        return;
      }
      const uri = vscode.Uri.parse(`${SessionConstraintsProvider.scheme}:/session-${++this.nextDocument}.txt`);
      this.selections.set(uri.toString(), { uri, owner: selected.owner, sessionId: selected.sessionId });
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
      const service = this.services.get(selection.owner);
      const session = service?.getGlobal(selection.sessionId);
      if (!service || !session) return 'The selected session no longer exists.';
      const register = service.readStandingConstraints(selection.sessionId);
      return [
        'Session Standing Constraints (read-only)',
        `Session ID: ${session.sessionId}`,
        `Host: ${getNativeObservationOwnerLabel(selection.owner)}`,
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

function ownerNote(owner: NativeObservationOwner): string | undefined {
  return owner === DEFAULT_NATIVE_OBSERVATION_OWNER ? undefined : getNativeObservationOwnerLabel(owner);
}
