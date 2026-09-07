import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ContextService, getContextPath } from 'hive-core';
import type { ContextReadSummary } from 'hive-core';

type ContextMetadata = ContextReadSummary['files'][number] & { bytes?: number };

export function contextDescription(file: ContextMetadata, filePath: string): string {
  const classification = file.role === 'scratchpad' ? 'Scratchpad'
    : file.kind === 'evidence' ? 'Evidence' : file.role === 'durable' ? 'Durable' : 'Reserved';
  return `${classification} · ${file.bytes ?? fs.statSync(filePath).size} bytes`;
}

export function contextTooltip(file: ContextMetadata): string {
  return [
    `Updated: ${file.updatedAt}`,
    `Task: ${file.task || 'None'}`,
    `Automatic execution inclusion: ${file.includeInExecution ? 'Yes' : 'No'}`,
    `Automatic network inclusion: ${file.includeInNetwork ? 'Yes' : 'No'}`,
    'Exclusion from automatic injection is not a privacy guarantee; explicit reads remain available.',
  ].join('\n');
}

export async function archiveContext(workspaceRoot: string, item: { featureName?: string; filename?: string } | undefined, refresh: () => void): Promise<void> {
  if (!item?.featureName) {
    vscode.window.showErrorMessage('Hive: Select a Context folder or document.');
    return;
  }
  try {
    const service = new ContextService(workspaceRoot);
    const snapshot = service.readSummary(item.featureName);
    if (!snapshot.files.length) {
      vscode.window.showInformationMessage('Hive: No context documents to archive.');
      return;
    }
    const selected = await vscode.window.showQuickPick(snapshot.files.map(file => ({
      label: `${file.name}.md`,
      description: contextDescription(file, path.join(getContextPath(workspaceRoot, item.featureName!), `${file.name}.md`)),
      detail: contextTooltip(file),
      picked: item.filename === `${file.name}.md`,
      name: file.name,
    })), { canPickMany: true, title: 'Archive Context', placeHolder: 'Select the exact documents to archive', matchOnDescription: true, matchOnDetail: true });
    if (!selected?.length) return;
    const reason = await vscode.window.showInputBox({
      title: 'Archive Context', prompt: 'Why are these documents being archived?',
      validateInput: value => value.trim() ? undefined : 'Enter a nonblank archive reason.',
    });
    if (!reason?.trim()) return;
    const confirmation = await vscode.window.showWarningMessage(
      `Archive context for "${item.featureName}"?\n\n${selected.map(file => file.label).join('\n')}\n\nReason: ${reason.trim()}\n\nThese documents will leave active context and remain in the archive.`,
      { modal: true }, 'Archive Context',
    );
    if (confirmation !== 'Archive Context') return;
    service.archiveSelected(item.featureName, selected.map(file => file.name), reason.trim(), snapshot.revision);
    refresh();
    vscode.window.showInformationMessage(`Hive: Archived ${selected.length} context document(s).`);
  } catch (error) {
    vscode.window.showErrorMessage(`Hive: Context archive failed. ${error instanceof Error ? error.message : String(error)} Reopen Archive Context to review a fresh snapshot.`);
  }
}
