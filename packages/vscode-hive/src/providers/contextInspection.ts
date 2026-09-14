import * as vscode from 'vscode';
import { ContextService } from 'hive-core';
import type { ContextFile, ContextScope } from 'hive-core';

type ContextFileMeta = Omit<ContextFile, 'content' | 'contentHash'>;

const ARCHIVE_PAGE_LIMIT = 10;
const MANAGED_DRIFT_WARNING = 'Content bytes differ from the last managed write.';

interface ArchivePick {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  name?: string;
  loadMore?: boolean;
}

export function isContextScope(scope: unknown): scope is ContextScope {
  return !!scope && typeof scope === 'object' && ((scope as ContextScope).type === 'project'
    || ((scope as ContextScope).type === 'feature' && typeof (scope as { featureName?: unknown }).featureName === 'string'));
}

export function contextDescription(file: ContextFileMeta, overdue = false): string {
  const classification = file.role === 'scratchpad' ? 'Scratchpad'
    : file.kind === 'evidence' ? 'Evidence' : file.role === 'durable' ? 'Durable' : 'Reserved';
  const base = `${classification} · ${file.bytes ?? 0} bytes`;
  return overdue ? `${base} · review overdue` : base;
}

export function contextTooltip(file: ContextFileMeta, project = false): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  if (file.description) lines.push(`Description: ${file.description}`);
  if (file.readWhen) lines.push(`Read when: ${file.readWhen}`);
  if (file.kind) lines.push(`Kind: ${file.kind}`);
  lines.push(`Task: ${file.task || 'None'}`);
  if (file.owner) lines.push(`Owner: ${file.owner}`);
  if (file.reviewAfter) {
    lines.push(`Review after: ${file.reviewAfter}${project && file.reviewAfter <= today ? ' (overdue)' : ''}`);
  }
  lines.push(`Updated: ${file.updatedAt}`);
  lines.push(`Automatic execution inclusion: ${file.includeInExecution ? 'Yes' : 'No'}`);
  lines.push(`Automatic network inclusion: ${file.includeInNetwork ? 'Yes' : 'No'}`);
  for (const warning of file.warnings ?? []) lines.push(`Warning: ${warning}`);
  lines.push('Exclusion from automatic injection is not a privacy guarantee; explicit reads remain available.');
  return lines.join('\n');
}

export async function archiveContext(
  workspaceRoot: string,
  item: { scope?: unknown; filename?: string } | undefined,
  refresh: () => void,
): Promise<void> {
  const scope = item?.scope;
  if (!isContextScope(scope)) {
    vscode.window.showErrorMessage('Hive: Select a Project Context or feature Context folder or document.');
    return;
  }
  const service = new ContextService(workspaceRoot);
  const title = scope.type === 'project' ? 'Archive Project Context' : 'Archive Context';
  try {
    const candidates: ContextFileMeta[] = [];
    let chosen: ContextFileMeta[] = [];
    let revision = 0;
    let cursor: string | undefined;
    let complete = false;
    const originatingFilename = item?.filename;
    let originatingDeselected = false;

    while (true) {
      const page = service.readManagementCatalog(scope, cursor ? { cursor, limit: ARCHIVE_PAGE_LIMIT } : { limit: ARCHIVE_PAGE_LIMIT });
      candidates.push(...page.files);
      revision = page.revision;
      complete = page.complete;
      cursor = page.nextCursor;
      if (candidates.length === 0) {
        vscode.window.showInformationMessage('Hive: No context documents to archive.');
        return;
      }
      const picks: ArchivePick[] = candidates.map(file => ({
        label: `${file.name}.md`,
        description: contextDescription(file,
          scope.type === 'project' && !!file.reviewAfter && file.reviewAfter <= new Date().toISOString().slice(0, 10)),
        detail: contextTooltip(file, scope.type === 'project'),
        picked: chosen.some(selected => selected.name === file.name)
          || (!originatingDeselected && `${file.name}.md` === originatingFilename),
        name: file.name,
      }));
      if (!complete && cursor) {
        picks.push({ label: 'Load more context documents…', description: `${candidates.length} listed so far`, loadMore: true });
      }
      const picked = await vscode.window.showQuickPick(picks, {
        canPickMany: true,
        title,
        placeHolder: 'Select the exact documents to archive',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked?.length) return;
      if (originatingFilename
        && candidates.some(candidate => `${candidate.name}.md` === originatingFilename)
        && !picked.some(pick => `${pick.name}.md` === originatingFilename)) {
        originatingDeselected = true;
      }
      const resolveChosen = (selection: ArchivePick[]): ContextFileMeta[] =>
        selection.filter(pick => !pick.loadMore)
          .map(pick => candidates.find(candidate => candidate.name === pick.name))
          .filter((candidate): candidate is ContextFileMeta => !!candidate);
      const loadMore = picked.find(pick => pick.loadMore);
      if (loadMore) {
        chosen = resolveChosen(picked);
        if (!cursor) break;
        continue;
      }
      chosen = resolveChosen(picked);
      break;
    }
    if (!chosen.length) return;

    const expectedContentHashes: Record<string, string> = {};
    const driftConflicts: string[] = [];
    for (const file of chosen) {
      const read = service.readContent(scope, file.name);
      if (!read?.file.contentHash || read.revision !== revision) {
        throw new Error(`Context '${file.name}' changed while preparing the archive.`);
      }
      expectedContentHashes[file.name] = read.file.contentHash;
      const listed = candidates.find(candidate => candidate.name === file.name);
      if ((listed && listed.bytes !== undefined && read.file.bytes !== listed.bytes)
        || read.file.warnings?.includes(MANAGED_DRIFT_WARNING)) {
        driftConflicts.push(`${file.name}.md changed outside managed writes since it was listed.`);
      }
    }

    const reason = await vscode.window.showInputBox({
      title,
      prompt: 'Why are these documents being archived?',
      validateInput: value => value.trim() ? undefined : 'Enter a nonblank archive reason.',
    });
    if (!reason?.trim()) return;

    const scopeLabel = scope.type === 'project' ? 'project context' : `context for "${scope.featureName}"`;
    const driftSection = driftConflicts.length ? `\n\nUnmanaged changes detected:\n${driftConflicts.join('\n')}` : '';
    const confirmation = await vscode.window.showWarningMessage(
      `Archive ${scopeLabel}?\n\n${chosen.map(file => `${file.name}.md`).join('\n')}\n\nReason: ${reason.trim()}${driftSection}\n\nThese documents will leave active context and remain in the archive.`,
      { modal: true }, 'Archive Context',
    );
    if (confirmation !== 'Archive Context') return;

    service.archiveSelected(scope, chosen.map(file => file.name), reason.trim(), revision, expectedContentHashes);
    refresh();
    const driftNote = driftConflicts.length
      ? ` Drift reported for ${driftConflicts.length} document(s) changed outside managed writes.`
      : '';
    vscode.window.showInformationMessage(`Hive: Archived ${chosen.length} context document(s).${driftNote}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Hive: Context archive failed. ${error instanceof Error ? error.message : String(error)} Reopen Archive Context to review a fresh snapshot.`);
  }
}
