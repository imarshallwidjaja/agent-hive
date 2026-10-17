import * as vscode from 'vscode';
import type {
  WorklogBriefRead,
  WorklogEntry,
  WorklogFactRow,
  WorklogFactsSummary,
  WorklogRef,
  WorklogReference,
} from 'hive-core';
import { WORKLOG_MAX_RESPONSE_BYTES, WorklogService, getWorklogKey, parseWorklogKey } from 'hive-core';
import {
  WORKLOG_VIEWER_PAGE_SIZE,
  describeAge,
  describeAuthor,
  describeFailure,
  describeLog,
  formatTimestamp,
  isWorklogFailure,
  resolveProjectPath,
  resolveReference,
} from './worklogPresentation.js';
import type { ReferenceTarget } from './worklogPresentation.js';

export type WorklogDocumentView = 'brief' | 'history' | 'facts';

const VIEW_TITLES: Record<WorklogDocumentView, string> = { brief: 'Worklog', history: 'Worklog History', facts: 'Worklog Facts' };
const BRIEF_RECENT = 3;
const UNTRUSTED_NOTE = 'Titles, briefings, checkpoints, and labels are written by agents and shown here as plain text.';

interface RenderedLink {
  line: number;
  start: number;
  end: number;
  target: ReferenceTarget;
}

/** Older pages of one history document. Pages stay below the anchor, so appends never shift what is shown. */
interface HistoryState {
  entries: WorklogEntry[];
  anchor: number;
  nextCursor: string | null;
  notice?: string;
}

/** The editor starts a new line at CRLF, CR, or LF, so link positions count lines the same way. */
const LINE_BREAK = /\r\n|\r|\n/;

class DocumentWriter {
  readonly lines: string[] = [];
  readonly links: RenderedLink[] = [];

  /**
   * Writes one logical line. Recorded text inside it can carry line breaks, so every further physical line is
   * indented under the first and can never pose as a heading or field of this document.
   */
  line(text = ''): void {
    const [first = '', ...rest] = text.split(LINE_BREAK);
    this.lines.push(first);
    const indent = `${/^ */.exec(first)![0]}    `;
    for (const line of rest) this.lines.push(`${indent}${line}`);
  }

  /** Untrusted multi-line text is indented as a block so it can never pose as a heading or field of this document. */
  block(text: string, indent: string): void {
    for (const line of text.split(LINE_BREAK)) this.lines.push(`${indent}${line}`);
  }

  reference(indent: string, index: number, reference: WorklogReference, target: ReferenceTarget): void {
    const prefix = `${indent}[${index}] ${reference.kind}: `;
    const value = reference.kind === 'path' ? reference.path : reference.url;
    const label = reference.label ? ` - ${reference.label}` : '';
    // A link covers one line, so a value that spans lines stays text rather than linking only part of it.
    const blocked = target.kind === 'blocked' ? target.reason : LINE_BREAK.test(value) ? 'contains a line break' : null;
    if (blocked === null) {
      this.links.push({ line: this.lines.length, start: prefix.length, end: prefix.length + value.length, target });
    }
    this.line(`${prefix}${value}${label}${blocked === null ? '' : ` (not linked: ${blocked})`}`);
  }

  text(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

/**
 * Read-only plain-text documents for one worklog each. The URI carries the project root, the full worklog key, and
 * the view, so a document always names the same log; reads never write and never change which log is shown.
 */
export class WorklogDocuments implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider, vscode.Disposable {
  static readonly scheme = 'hive-worklog';
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly open = new Map<string, vscode.Uri>();
  private readonly links = new Map<string, RenderedLink[]>();
  private readonly history = new Map<string, HistoryState>();
  private readonly factPages = new Map<string, number>();
  private readonly service: WorklogService;

  constructor(private readonly projectRoot: string, private readonly now: () => number = Date.now) {
    this.service = new WorklogService(projectRoot);
  }

  uriFor(view: WorklogDocumentView, key: string): vscode.Uri {
    const name = `${VIEW_TITLES[view]} ${key.replace(/[\\/]/g, '_')}`.slice(0, 160);
    const query = new URLSearchParams({ project: this.projectRoot, key, view }).toString();
    return vscode.Uri.from({ scheme: WorklogDocuments.scheme, path: `/${name}`, query });
  }

  /** The worklog key a document shows, or null for a document from another project or scheme. */
  keyFor(uri: vscode.Uri): string | null {
    const target = this.parseUri(uri);
    return 'key' in target && target.project === this.projectRoot ? target.key : null;
  }

  async show(view: WorklogDocumentView, key: string): Promise<void> {
    const uri = this.uriFor(view, key);
    const id = uri.toString();
    // Asking again for history restarts it from the newest checkpoint; asking for facts starts at the first page.
    this.history.delete(id);
    this.factPages.delete(id);
    if (this.open.has(id)) this.changed.fire(uri);
    this.open.set(id, uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  /** Continues the history or facts document; the brief continues in its history document. */
  async loadMore(uri: vscode.Uri): Promise<void> {
    const target = this.parseUri(uri);
    if (!('key' in target)) {
      vscode.window.showInformationMessage('Hive: Open a worklog history or facts document to load more.');
      return;
    }
    // Another project's document is never read here, so it must not open or page this project's log of the same key.
    if (target.project !== this.projectRoot) {
      vscode.window.showInformationMessage(`Hive: This worklog document belongs to project ${target.project}, not ${this.projectRoot}. Nothing was loaded.`);
      return;
    }
    const id = uri.toString();
    if (target.view === 'brief') {
      await this.show('history', target.key);
      return;
    }
    if (target.view === 'facts') {
      this.factPages.set(id, (this.factPages.get(id) ?? 1) + 1);
      this.changed.fire(uri);
      return;
    }
    const state = this.history.get(id);
    if (!state?.nextCursor) {
      vscode.window.showInformationMessage('Hive: No older checkpoints to load.');
      return;
    }
    try {
      const page = this.service.read(target.ref, { view: 'history', cursor: state.nextCursor, limit: WORKLOG_VIEWER_PAGE_SIZE, maxBytes: WORKLOG_MAX_RESPONSE_BYTES });
      state.entries.push(...page.entries);
      state.nextCursor = page.nextCursor;
    } catch (error) {
      const failure = describeFailure(error);
      state.notice = isWorklogFailure(error, 'stale_cursor', 'invalid_cursor')
        ? 'Older checkpoints could not be loaded because the log file was replaced after this history opened. Run Show Worklog History to restart from the newest checkpoint.'
        : `Older checkpoints could not be loaded (${failure.reason}): ${failure.message} ${failure.recovery}`;
    }
    this.changed.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = uri.toString();
    this.open.set(id, uri);
    const writer = new DocumentWriter();
    const target = this.parseUri(uri);
    if (!('key' in target)) {
      writer.line(target.problem);
    } else if (target.project !== this.projectRoot) {
      writer.line(`This worklog document belongs to project ${target.project}.`);
      writer.line(`This window resolved project ${this.projectRoot}, so the document is not read here.`);
      writer.line(`Worklog key: ${target.key}`);
    } else {
      try {
        const header = this.service.read(target.ref, { view: 'brief', limit: target.view === 'brief' ? BRIEF_RECENT : 1, maxBytes: WORKLOG_MAX_RESPONSE_BYTES });
        this.writeHeader(writer, header, target.view);
        if (target.view === 'brief') this.writeBrief(writer, header);
        else if (target.view === 'history') this.writeHistory(writer, id, target.ref, header);
        else this.writeFacts(writer, id, target.ref);
      } catch (error) {
        const failure = describeFailure(error);
        writer.line(`${VIEW_TITLES[target.view]} unavailable`);
        writer.line(`Worklog key: ${target.key}`);
        writer.line(`Project: ${this.projectRoot}`);
        writer.line();
        writer.line(`Could not read this worklog (${failure.reason}).`);
        writer.line(`  ${failure.message}`);
        writer.line(failure.recovery);
        writer.line('This document keeps showing this worklog; it is not replaced by another log.');
      }
    }
    this.links.set(id, writer.links);
    return writer.text();
  }

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    return (this.links.get(document.uri.toString()) ?? []).map((link) => {
      const range = new vscode.Range(new vscode.Position(link.line, link.start), new vscode.Position(link.line, link.end));
      const result = link.target.kind === 'file'
        ? new vscode.DocumentLink(range, vscode.Uri.file(link.target.filePath))
        : new vscode.DocumentLink(range, vscode.Uri.parse((link.target as { url: string }).url, true));
      result.tooltip = link.target.kind === 'file' ? 'Open project file' : 'Open link';
      return result;
    });
  }

  refresh(): void {
    for (const uri of this.open.values()) this.changed.fire(uri);
  }

  /**
   * Releases a document's state once the editor has disposed it. A language change also fires the close event, but
   * the document stays in `workspace.textDocuments` and is not rendered again, so its pages and links are kept.
   */
  close(uri: vscode.Uri): void {
    const id = uri.toString();
    if (vscode.workspace.textDocuments.some((document) => document.uri.toString() === id)) return;
    this.open.delete(id);
    this.links.delete(id);
    this.history.delete(id);
    this.factPages.delete(id);
  }

  dispose(): void {
    this.open.clear();
    this.links.clear();
    this.history.clear();
    this.factPages.clear();
    this.changed.dispose();
  }

  private parseUri(uri: vscode.Uri):
    | { project: string; key: string; ref: WorklogRef; view: WorklogDocumentView }
    | { problem: string } {
    if (uri.scheme !== WorklogDocuments.scheme) return { problem: 'Not a worklog document.' };
    const params = new URLSearchParams(uri.query);
    const project = params.get('project');
    const key = params.get('key');
    const view = params.get('view');
    if (!project || !key || (view !== 'brief' && view !== 'history' && view !== 'facts')) {
      return { problem: 'This worklog document link is incomplete. Open the log again from the Worklogs view.' };
    }
    try {
      const ref = parseWorklogKey(key);
      return { project, key: getWorklogKey(ref), ref, view };
    } catch (error) {
      return { problem: `This worklog key is not valid: ${describeFailure(error).message}` };
    }
  }

  private writeHeader(writer: DocumentWriter, read: WorklogBriefRead, view: WorklogDocumentView): void {
    const now = this.now();
    writer.line(read.exists ? `Worklog: ${read.title ?? '(untitled)'}` : 'No worklog recorded yet');
    writer.line(`Worklog key: ${read.key}`);
    writer.line(`${VIEW_TITLES[view]} · ${describeLog(read.ref)} · project ${this.projectRoot}`);
    if (read.exists && read.updatedAt) {
      writer.line(`Revision ${read.revision} · ${read.entryCount} checkpoint${read.entryCount === 1 ? '' : 's'} · last recorded ${formatTimestamp(read.updatedAt)} (${describeAge(read.updatedAt, now)})`);
    }
    writer.line(`Read from files at ${formatTimestamp(new Date(now).toISOString())}. ${UNTRUSTED_NOTE}`);
    writer.line();
  }

  private writeBrief(writer: DocumentWriter, read: WorklogBriefRead): void {
    if (!read.exists) {
      writer.line('No checkpoints have been recorded in this worklog. A primary agent creates it with its first checkpoint.');
      writer.line();
      this.writeFactsSummary(writer, read.facts, read.ref);
      return;
    }

    writer.line('Briefing');
    if (read.briefing) {
      writer.line(`  Written with checkpoint #${read.briefing.entryId} at ${formatTimestamp(read.briefing.recordedAt)} (${describeAge(read.briefing.recordedAt, this.now())}) by ${describeAuthor(read.briefing.author)}`);
      if (read.checkpointsSinceBriefing > 0) {
        writer.line(`  ${read.checkpointsSinceBriefing} checkpoint${read.checkpointsSinceBriefing === 1 ? '' : 's'} recorded after this briefing.`);
      }
      if (read.changedSinceBriefing === true) {
        writer.line('  Source records changed: recorded task facts differ from those stored with this briefing. The briefing is not regenerated automatically.');
      } else if (read.changedSinceBriefing === false) {
        writer.line('  Recorded task facts match those stored with this briefing.');
      } else if (read.ref.kind === 'feature') {
        writer.line('  Whether recorded task facts changed since this briefing is unknown.');
      }
      writer.line();
      writer.block(read.briefing.text, '    ');
    } else {
      writer.line('  No briefing has been written yet; read the checkpoints below.');
    }
    writer.line();

    this.writeFactsSummary(writer, read.facts, read.ref);

    const shown = read.recent.entries.length;
    writer.line(`Recent checkpoints (newest first, ${shown} of ${read.entryCount})`);
    for (const entry of read.recent.entries) this.writeEntry(writer, entry, false);
    const older = read.entryCount - shown;
    if (older > 0) writer.line(`${older} older checkpoint${older === 1 ? '' : 's'} and full details: run Show Worklog History.`);
  }

  private writeHistory(writer: DocumentWriter, id: string, ref: WorklogRef, header: WorklogBriefRead): void {
    if (!header.exists) {
      writer.line('No checkpoints have been recorded in this worklog.');
      return;
    }
    let state = this.history.get(id);
    if (!state) {
      const page = this.service.read(ref, { view: 'history', limit: WORKLOG_VIEWER_PAGE_SIZE, maxBytes: WORKLOG_MAX_RESPONSE_BYTES });
      state = { entries: [...page.entries], anchor: page.anchorRevision, nextCursor: page.nextCursor };
      this.history.set(id, state);
    }
    writer.line(`Checkpoints recorded up to revision ${state.anchor}, newest first. This history stays anchored at that revision while you page.`);
    if (header.revision > state.anchor) {
      const newer = header.revision - state.anchor;
      writer.line(`${newer} newer checkpoint${newer === 1 ? ' has' : 's have'} been recorded since. Run Show Worklog History to start from the newest.`);
    } else if (header.revision < state.anchor) {
      writer.line('The log now holds fewer checkpoints than when this history opened, so the file may have been replaced. Run Show Worklog History to restart.');
    }
    if (state.notice) writer.line(state.notice);
    writer.line();
    for (const entry of state.entries) this.writeEntry(writer, entry, true);
    const remaining = state.entries.length ? state.entries[state.entries.length - 1]!.id - 1 : 0;
    writer.line(state.nextCursor
      ? `${remaining} older checkpoint${remaining === 1 ? '' : 's'} not loaded. Use Load More Worklog Entries in the editor title bar.`
      : 'End of history.');
  }

  private writeFacts(writer: DocumentWriter, id: string, ref: WorklogRef): void {
    const pages = this.factPages.get(id) ?? 1;
    let summary: WorklogFactsSummary | null = null;
    const rows: WorklogFactRow[] = [];
    let cursor: string | undefined;
    let complete = false;
    let notice: string | undefined;
    for (let page = 0; page < pages; page++) {
      try {
        const read = this.service.read(ref, { view: 'facts', cursor, limit: WORKLOG_VIEWER_PAGE_SIZE, maxBytes: WORKLOG_MAX_RESPONSE_BYTES });
        summary = read.facts;
        rows.push(...read.rows);
        complete = read.complete;
        if (!read.nextCursor) break;
        cursor = read.nextCursor;
      } catch (error) {
        if (!isWorklogFailure(error, 'stale_cursor') || page === 0) throw error;
        notice = 'Recorded facts changed while the rows were loading; the rows below may mix two states. Refresh to read them again.';
        break;
      }
    }
    if (!summary) return;
    this.writeFactsSummary(writer, summary, ref, false);
    if (notice) writer.line(notice);
    if (summary.state === 'not_applicable' || summary.state === 'unavailable') return;
    writer.line(`Task rows (${rows.length} of ${summary.taskCount})`);
    for (const row of rows) {
      writer.line(`  ${row.folder} · ${row.status ?? 'invalid'}${row.planTitle ? ` · plan task: ${row.planTitle}` : ''}${row.runnable ? ' · runnable' : ''}`);
      if (row.dependsOn.length) writer.line(`    Depends on: ${row.dependsOn.join(', ')}`);
      if (row.waitingOn.length) writer.line(`    Waiting on: ${row.waitingOn.join(', ')}`);
      if (row.blocker) writer.block(`Blocker${row.blocker.truncated ? ' (shortened; full blocker in status.json)' : ''}: ${row.blocker.reason}`, '    ');
      if (row.integrity) writer.line(`    Integrity problem: ${row.integrity.reason}${row.integrity.error ? ` - ${row.integrity.error}` : ''}`);
      const sources: Array<[string, string | undefined]> = [['status', row.sources.status], ['report', row.sources.report], ['spec', row.sources.spec]];
      let index = 1;
      for (const [label, source] of sources) {
        if (!source) continue;
        writer.reference('    ', index++, { kind: 'path', path: source, label }, resolveProjectPath(this.projectRoot, source));
      }
    }
    writer.line(complete ? 'All task rows shown.' : 'More task rows exist. Use Load More Worklog Entries in the editor title bar.');
  }

  private writeFactsSummary(writer: DocumentWriter, facts: WorklogFactsSummary, ref: WorklogRef, pointToFacts = true): void {
    writer.line('Recorded facts');
    writer.line(`  ${facts.notice}`);
    if (facts.state === 'not_applicable') {
      writer.line('  Session logs have no task ledger.');
      writer.line();
      return;
    }
    if (facts.state === 'unavailable') {
      writer.line('  Task records could not be listed, so task counts are unknown rather than zero.');
    } else {
      const counts = Object.entries(facts.counts).filter(([, count]) => count > 0).map(([status, count]) => `${status} ${count}`);
      writer.line(`  Feature status ${facts.featureStatus ?? 'unknown'} · ${facts.taskCount} task${facts.taskCount === 1 ? '' : 's'}${counts.length ? ` · ${counts.join(' · ')}` : ''}`);
      writer.line(`  ${facts.runnableCount} runnable · ${facts.dependencyBlockedCount} waiting on unfinished dependencies`);
      if (facts.state === 'partial') writer.line('  Some task records have integrity problems and are counted as invalid.');
    }
    for (const diagnostic of facts.diagnostics) writer.line(`  Diagnostic: ${diagnostic}`);
    writer.line(`  Observed ${formatTimestamp(facts.observedAt)}.${pointToFacts && ref.kind === 'feature' ? ' Run Show Worklog Facts for per-task rows.' : ''}`);
    writer.line();
  }

  private writeEntry(writer: DocumentWriter, entry: WorklogEntry, full: boolean): void {
    writer.line(`  #${entry.id} · ${formatTimestamp(entry.recordedAt)} (${describeAge(entry.recordedAt, this.now())}) · ${describeAuthor(entry.author)}`);
    writer.block(entry.checkpoint.summary, '    ');
    if (full && entry.checkpoint.detail) {
      writer.line();
      writer.block(entry.checkpoint.detail, '      ');
    }
    if (entry.briefing) writer.line('    This checkpoint set a briefing.');
    if (entry.checkpoint.corrects?.length) writer.line(`    Corrects #${entry.checkpoint.corrects.join(', #')}`);
    if (entry.correctedBy?.length) writer.line(`    Corrected by #${entry.correctedBy.join(', #')}`);
    const references = entry.checkpoint.references ?? [];
    if (references.length && full) {
      writer.line('    References:');
      references.forEach((reference, index) => writer.reference('      ', index + 1, reference, resolveReference(this.projectRoot, reference)));
    } else if (references.length) {
      writer.line(`    ${references.length} reference${references.length === 1 ? '' : 's'} (see Show Worklog History)`);
    }
    writer.line();
  }
}
