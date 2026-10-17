import * as vscode from 'vscode';
import type { WorklogListError, WorklogRef, WorklogSummary } from 'hive-core';
import { WORKLOG_MAX_RESPONSE_BYTES, WorklogService, getWorklogKey, parseWorklogKey } from 'hive-core';
import {
  WORKLOG_VIEWER_PAGE_SIZE,
  describeAge,
  describeFailure,
  describeLog,
  formatTimestamp,
  isWorklogFailure,
  resolveProjectPath,
} from './worklogPresentation.js';

const PICKER_PAGE_SIZE = 50;

export interface WorklogMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

interface ProjectPreferences {
  pins: string[];
  selected: string | null;
}

interface StoredPreferences {
  version: 1;
  projects: Record<string, ProjectPreferences>;
}

/**
 * Viewer-only preferences kept in VS Code workspace state, never in `.hive`: pinned worklog keys and the log the
 * operator last opened, per resolved project root. Pins hold full keys, so equal session IDs from two hosts stay apart.
 */
export class WorklogViewerPreferences {
  static readonly storageKey = 'hive.worklogs.viewer';

  constructor(private readonly memento: WorklogMemento, private readonly projectRoot: string) {}

  pins(): string[] {
    return [...this.current().pins];
  }

  selected(): string | null {
    return this.current().selected;
  }

  /** Pins the canonical form of a key. Returns false when it was already pinned; throws for an invalid key. */
  async pin(key: string): Promise<boolean> {
    const canonical = getWorklogKey(parseWorklogKey(key));
    const current = this.current();
    if (current.pins.includes(canonical)) return false;
    await this.save({ ...current, pins: [...current.pins, canonical] });
    return true;
  }

  /** Removes a pin by its stored text, so an invalid stored pin can still be removed. */
  async unpin(key: string): Promise<boolean> {
    const current = this.current();
    const pins = current.pins.filter((pin) => pin !== key);
    if (pins.length === current.pins.length) return false;
    await this.save({ ...current, pins });
    return true;
  }

  async select(key: string): Promise<void> {
    await this.save({ ...this.current(), selected: getWorklogKey(parseWorklogKey(key)) });
  }

  private current(): ProjectPreferences {
    const stored = this.memento.get<StoredPreferences>(WorklogViewerPreferences.storageKey);
    const project = stored?.version === 1 ? stored.projects?.[this.projectRoot] : undefined;
    return {
      pins: Array.isArray(project?.pins) ? project!.pins.filter((pin): pin is string => typeof pin === 'string') : [],
      selected: typeof project?.selected === 'string' ? project.selected : null,
    };
  }

  private async save(preferences: ProjectPreferences): Promise<void> {
    const stored = this.memento.get<StoredPreferences>(WorklogViewerPreferences.storageKey);
    const projects = stored?.version === 1 && stored.projects ? stored.projects : {};
    await this.memento.update(WorklogViewerPreferences.storageKey, { version: 1, projects: { ...projects, [this.projectRoot]: preferences } });
  }
}

type WorklogsGroup = 'selected' | 'pinned' | 'recent';
type WorklogsTreeItem = WorklogGroupItem | WorklogLogItem | WorklogProblemItem | WorklogListErrorItem | WorklogNoticeItem | WorklogLoadMoreItem;

class WorklogGroupItem extends vscode.TreeItem {
  constructor(public readonly group: WorklogsGroup, label: string, description: string | undefined, icon: string, tooltip: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `group:${group}`;
    this.description = description;
    this.contextValue = `worklog-group-${group}`;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = tooltip;
  }
}

interface LogFields {
  ref: WorklogRef;
  key: string;
  title: string;
  updatedAt: string | null;
  revision: number;
  location?: string;
}

class WorklogLogItem extends vscode.TreeItem {
  readonly worklogKey: string;
  readonly copyCommand: { arguments: string[] };

  constructor(group: WorklogsGroup, fields: LogFields, pinned: boolean, now: number) {
    super(fields.title, vscode.TreeItemCollapsibleState.None);
    this.worklogKey = fields.key;
    this.copyCommand = { arguments: [fields.key] };
    this.id = `${group}:${fields.key}`;
    this.description = fields.updatedAt
      ? `${describeLog(fields.ref)} · ${describeAge(fields.updatedAt, now)}`
      : `${describeLog(fields.ref)} · no checkpoints yet`;
    this.tooltip = [
      fields.title,
      `Key: ${fields.key}`,
      fields.updatedAt ? `Last recorded: ${formatTimestamp(fields.updatedAt)} · revision ${fields.revision}` : 'No checkpoints recorded yet.',
      ...(fields.location ? [`Stored at: ${fields.location}`] : []),
      'Recorded narrative and facts; not evidence that a worker is running.',
    ].join('\n');
    this.contextValue = pinned ? 'worklog-log-pinned' : 'worklog-log';
    this.iconPath = new vscode.ThemeIcon(fields.ref.kind === 'feature' ? 'book' : 'note');
    this.command = { command: 'hive.worklog.open', title: 'Open Worklog', arguments: [fields.key] };
  }
}

/** A pinned or selected key that cannot be read right now. It stays visible so it can be inspected or unpinned. */
class WorklogProblemItem extends vscode.TreeItem {
  readonly worklogKey: string;
  readonly copyCommand: { arguments: string[] };

  constructor(group: WorklogsGroup, key: string, pinned: boolean, error: unknown) {
    super(key, vscode.TreeItemCollapsibleState.None);
    const failure = describeFailure(error);
    this.worklogKey = key;
    this.copyCommand = { arguments: [key] };
    this.id = `${group}:${key}`;
    this.description = `Unavailable: ${failure.reason}`;
    this.tooltip = [`Key: ${key}`, failure.message, failure.recovery].join('\n');
    this.contextValue = pinned ? 'worklog-problem-pinned' : 'worklog-problem';
    this.iconPath = new vscode.ThemeIcon(failure.reason === 'feature_not_found' ? 'circle-slash' : 'error');
    if (failure.reason !== 'invalid_ref') {
      this.command = { command: 'hive.worklog.open', title: 'Open Worklog', arguments: [key] };
    }
  }
}

class WorklogListErrorItem extends vscode.TreeItem {
  constructor(projectRoot: string, error: WorklogListError) {
    super(error.location, vscode.TreeItemCollapsibleState.None);
    this.id = `recent-error:${error.location}`;
    this.description = `Unreadable: ${error.reason}`;
    this.contextValue = 'worklog-list-error';
    this.iconPath = new vscode.ThemeIcon('warning');
    const target = resolveProjectPath(projectRoot, error.location);
    if (target.kind === 'file') {
      this.command = { command: 'vscode.open', title: 'Open Raw Worklog File', arguments: [vscode.Uri.file(target.filePath)] };
    }
    this.tooltip = [
      error.message,
      target.kind === 'file'
        ? 'The file is left unchanged. Selecting this row opens the raw stored file in the editor.'
        : `The file is left unchanged and is not opened here (${target.reason}).`,
    ].join('\n');
  }
}

class WorklogNoticeItem extends vscode.TreeItem {
  constructor(id: string, label: string, tooltip: string, icon = 'info', description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = id;
    this.description = description;
    this.tooltip = tooltip;
    this.contextValue = 'worklog-notice';
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

class WorklogLoadMoreItem extends vscode.TreeItem {
  readonly loadMore = 'recent';

  constructor(shown: number) {
    super('Load more worklogs', vscode.TreeItemCollapsibleState.None);
    this.id = 'recent:load-more';
    this.description = `${shown} shown`;
    this.contextValue = 'worklog-load-more';
    this.iconPath = new vscode.ThemeIcon('chevron-down');
    this.command = { command: 'hive.worklog.loadMore', title: 'Load More Worklogs', arguments: [{ loadMore: 'recent' }] };
  }
}

/**
 * The Worklogs view: the explicitly selected log, pinned logs, and recent logs by last change. Items carry stable IDs
 * derived from full keys, so refreshes keep the native tree selection; nothing here follows a live session.
 */
export class WorklogsProvider implements vscode.TreeDataProvider<WorklogsTreeItem> {
  private readonly changed = new vscode.EventEmitter<WorklogsTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private recentPages = 1;
  private readonly service: WorklogService;

  constructor(
    private readonly projectRoot: string,
    private readonly preferences: WorklogViewerPreferences,
    private readonly now: () => number = Date.now,
  ) {
    this.service = new WorklogService(projectRoot);
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  loadMoreRecent(): void {
    this.recentPages += 1;
    this.refresh();
  }

  getTreeItem(element: WorklogsTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WorklogsTreeItem): Promise<WorklogsTreeItem[]> {
    if (!element) return this.roots();
    if (!(element instanceof WorklogGroupItem)) return [];
    if (element.group === 'selected') {
      const selected = this.preferences.selected();
      return selected ? [this.readItem('selected', selected)] : [];
    }
    if (element.group === 'pinned') {
      const pins = this.preferences.pins();
      if (!pins.length) {
        return [new WorklogNoticeItem('pinned:empty', 'No pinned worklogs', 'Pin a worklog from Recent or the Open Worklog picker to keep it here.')];
      }
      return pins.map((pin) => this.readItem('pinned', pin));
    }
    return this.recentChildren();
  }

  private roots(): WorklogsTreeItem[] {
    const roots: WorklogsTreeItem[] = [];
    if (this.preferences.selected()) {
      roots.push(new WorklogGroupItem('selected', 'Selected', undefined, 'eye', 'The worklog you last opened. It stays here until you open another one.'));
    }
    const pinCount = this.preferences.pins().length;
    roots.push(new WorklogGroupItem('pinned', 'Pinned', pinCount ? `${pinCount}` : undefined, 'pinned', 'Pinned worklogs are kept in this VS Code workspace only.'));
    roots.push(new WorklogGroupItem('recent', 'Recent', undefined, 'history', `Worklogs in ${this.projectRoot}, most recently changed first, including completed and archived features.`));
    return roots;
  }

  /** Reads one known key through the brief view so the row shows the stored title even without a live host. */
  private readItem(group: WorklogsGroup, key: string): WorklogsTreeItem {
    const pinned = this.isPinned(key);
    let ref: WorklogRef;
    try {
      ref = parseWorklogKey(key);
    } catch (error) {
      return new WorklogProblemItem(group, key, pinned, error);
    }
    try {
      const read = this.service.read(ref, { view: 'brief', limit: 1, maxBytes: WORKLOG_MAX_RESPONSE_BYTES });
      return new WorklogLogItem(group, {
        ref: read.ref,
        key: read.key,
        title: read.title ?? `${read.key} (no checkpoints yet)`,
        updatedAt: read.updatedAt,
        revision: read.revision,
      }, pinned, this.now());
    } catch (error) {
      return new WorklogProblemItem(group, getWorklogKey(ref), pinned, error);
    }
  }

  private recentChildren(): WorklogsTreeItem[] {
    const items: WorklogsTreeItem[] = [];
    let cursor: string | undefined;
    let shown = 0;
    try {
      for (let page = 0; page < this.recentPages; page++) {
        const result = this.service.list({ cursor, limit: WORKLOG_VIEWER_PAGE_SIZE, maxBytes: WORKLOG_MAX_RESPONSE_BYTES });
        for (const summary of result.worklogs) items.push(this.summaryItem(summary));
        for (const error of result.errors) items.push(new WorklogListErrorItem(this.projectRoot, error));
        shown += result.worklogs.length + result.errors.length;
        cursor = result.nextCursor ?? undefined;
        if (!cursor) break;
      }
    } catch (error) {
      const failure = describeFailure(error);
      const label = isWorklogFailure(error, 'stale_cursor') ? 'Worklogs changed while loading' : 'Worklog list unavailable';
      items.push(new WorklogNoticeItem('recent:failure', label, `${failure.message}\n${isWorklogFailure(error, 'stale_cursor') ? 'Refresh to list them again.' : failure.recovery}`, 'warning', failure.reason));
      return items;
    }
    if (!shown) {
      items.push(new WorklogNoticeItem('recent:empty', 'No worklogs recorded', 'Primary agents create worklogs when they record their first checkpoint.'));
    }
    if (cursor) items.push(new WorklogLoadMoreItem(shown));
    return items;
  }

  private summaryItem(summary: WorklogSummary): WorklogLogItem {
    return new WorklogLogItem('recent', {
      ref: summary.ref,
      key: summary.key,
      title: summary.title,
      updatedAt: summary.updatedAt,
      revision: summary.revision,
      location: summary.location,
    }, this.isPinned(summary.key), this.now());
  }

  private isPinned(key: string): boolean {
    return this.preferences.pins().includes(key);
  }
}

type PickerItem = vscode.QuickPickItem & (
  | { action: 'open'; key: string }
  | { action: 'more' }
  | { action: 'key' }
  | { action: 'unreadable'; error: WorklogListError }
);

/**
 * Lets the operator find any worklog, including older, completed-feature, and archived-feature logs, by paging the
 * list explicitly or by entering a full key. Returns the chosen canonical key, or undefined when cancelled.
 */
export async function pickWorklog(projectRoot: string, now: () => number = Date.now): Promise<string | undefined> {
  const service = new WorklogService(projectRoot);
  const summaries: WorklogSummary[] = [];
  const errors: WorklogListError[] = [];
  let cursor: string | null | undefined;
  let load = true;
  for (;;) {
    if (load && cursor !== null) {
      try {
        const page = service.list({ cursor, limit: PICKER_PAGE_SIZE, maxBytes: WORKLOG_MAX_RESPONSE_BYTES });
        summaries.push(...page.worklogs);
        errors.push(...page.errors);
        cursor = page.nextCursor;
      } catch (error) {
        if (isWorklogFailure(error, 'stale_cursor')) {
          summaries.length = 0;
          errors.length = 0;
          cursor = undefined;
          vscode.window.showWarningMessage('Hive: Worklogs changed while loading more. The list restarted from the most recent.');
          continue;
        }
        const failure = describeFailure(error);
        vscode.window.showErrorMessage(`Hive: Could not list worklogs (${failure.reason}). ${failure.message} You can still open a worklog by key.`);
        cursor = null;
      }
    }
    load = false;
    const items: PickerItem[] = [
      ...summaries.map((summary): PickerItem => ({
        action: 'open',
        key: summary.key,
        label: summary.title,
        description: `${describeLog(summary.ref)} · ${describeAge(summary.updatedAt, now())}`,
        detail: summary.key,
      })),
      ...errors.map((error): PickerItem => ({
        action: 'unreadable',
        error,
        label: `Unreadable worklog: ${error.location}`,
        description: error.reason,
      })),
      ...(cursor ? [{ action: 'more' as const, label: 'Load more worklogs', description: `${summaries.length + errors.length} loaded`, alwaysShow: true }] : []),
      { action: 'key', label: 'Open by key...', description: 'feature:<name> or session:<host>:<session ID>', alwaysShow: true },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `Open Worklog (${projectRoot})`,
      placeHolder: 'Search loaded worklogs by title or key',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return undefined;
    if (picked.action === 'open') return picked.key;
    if (picked.action === 'more') {
      load = true;
      continue;
    }
    if (picked.action === 'unreadable') {
      vscode.window.showWarningMessage(`Hive: ${picked.error.location} cannot be read (${picked.error.reason}). ${picked.error.message}`);
      continue;
    }
    const entered = await vscode.window.showInputBox({
      prompt: 'Worklog key, for example feature:checkout or session:opencode-v2:ses_abc123',
      validateInput: (value: string) => {
        try {
          parseWorklogKey(value.trim());
          return undefined;
        } catch (error) {
          return describeFailure(error).message;
        }
      },
    });
    if (entered === undefined) continue;
    try {
      return getWorklogKey(parseWorklogKey(entered.trim()));
    } catch (error) {
      vscode.window.showErrorMessage(`Hive: ${describeFailure(error).message}`);
    }
  }
}
