import * as vscode from 'vscode';
import type { ExplorationBriefView, ExplorationDiscovery } from 'hive-core';
import { ExplorationError, ExplorationService } from 'hive-core';
import { formatTimestamp } from './worklogPresentation.js';

type Placement = 'active' | 'closed';
type ExplorationsTreeItem = ExplorationGroupItem | ExplorationItem | ExplorationNoticeItem;
type Failure = { reason: string; message: string };
type BriefRead = ExplorationBriefView | { failure: Failure };

function failureOf(error: unknown): Failure {
  return error instanceof ExplorationError
    ? { reason: error.reason, message: error.message }
    : { reason: 'unexpected_error', message: error instanceof Error ? error.message : String(error) };
}

/** The hover text for one exploration row, from its brief read or the reason it could not be read. */
function tooltipFor(id: string, read: BriefRead): string {
  if ('failure' in read) return `${id}\nUnreadable: ${read.failure.reason}\n${read.failure.message}\nOpening it shows the reason; the file is left unchanged.`;
  const settled = read.counts.covered + read.counts.blocked + read.counts.dropped;
  return [
    read.goal,
    `ID: ${read.id}`,
    `Status: ${read.status} · revision ${read.revision} · last update ${formatTimestamp(read.updatedAt)}`,
    `${settled} of ${read.counts.frontierTotal} targets settled · ${read.counts.observationsTotal} observations`,
    ...(read.conclusion !== undefined ? [`Conclusion: ${read.conclusion}`] : []),
    ...(read.reason !== undefined ? [`Reason: ${read.reason}`] : []),
    'Recorded by agents; not verified results.',
  ].join('\n');
}

/** A placement group. It keeps the IDs its count came from, so expanding it lists exactly those. */
class ExplorationGroupItem extends vscode.TreeItem {
  constructor(readonly placement: Placement, readonly explorationIds: readonly string[]) {
    super(placement === 'active' ? 'Active' : 'Closed',
      placement === 'active' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `explorations:${placement}`;
    this.description = `${explorationIds.length}`;
    this.contextValue = `exploration-group-${placement}`;
    this.iconPath = new vscode.ThemeIcon(placement === 'active' ? 'pulse' : 'archive');
    this.tooltip = placement === 'active'
      ? 'Explorations that agents can still update. Each row reads its record when this group is shown.'
      : 'Concluded or abandoned explorations. Rows are listed by file name; a record is read when you hover over or open it.';
  }
}

/**
 * One exploration, named by its ID. An active row is built from its brief read, and an unreadable one shows the reason
 * inline. A closed row is listed by name only; its record is read for the tooltip when VS Code resolves the row, so a
 * large archive is not parsed to draw the tree.
 */
class ExplorationItem extends vscode.TreeItem {
  constructor(readonly explorationId: string, placement: Placement, read?: BriefRead) {
    super(explorationId, vscode.TreeItemCollapsibleState.None);
    this.id = `exploration:${explorationId}`;
    this.contextValue = `exploration-${placement}`;
    this.iconPath = new vscode.ThemeIcon('type-hierarchy');
    this.command = { command: 'hive.exploration.open', title: 'Open Exploration', arguments: [explorationId] };
    if (!read) return;
    if ('failure' in read) {
      this.description = `Unreadable: ${read.failure.reason}`;
      this.iconPath = new vscode.ThemeIcon('warning');
    } else {
      this.description = read.goal;
    }
    this.tooltip = tooltipFor(explorationId, read);
  }
}

class ExplorationNoticeItem extends vscode.TreeItem {
  constructor(id: string, label: string, tooltip: string, icon = 'info', description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = id;
    this.description = description;
    this.tooltip = tooltip;
    this.contextValue = 'exploration-notice';
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/** The Explorations view: active and closed explorations discovered from `.hive/explorations`, read-only. */
export class ExplorationsProvider implements vscode.TreeDataProvider<ExplorationsTreeItem> {
  private readonly changed = new vscode.EventEmitter<ExplorationsTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly service: ExplorationService;

  constructor(projectRoot: string) {
    this.service = new ExplorationService(projectRoot);
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: ExplorationsTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ExplorationsTreeItem): ExplorationsTreeItem[] {
    if (!element) return this.roots();
    if (!(element instanceof ExplorationGroupItem)) return [];
    const { placement, explorationIds } = element;
    if (!explorationIds.length) {
      return [placement === 'active'
        ? new ExplorationNoticeItem('explorations:active:empty', 'No active explorations', 'Primary agents create an exploration with hive_explore_update when an investigation needs a frontier.')
        : new ExplorationNoticeItem('explorations:closed:empty', 'No closed explorations', 'An exploration moves here when an agent concludes or abandons it.')];
    }
    return explorationIds.map((id) => new ExplorationItem(id, placement, placement === 'active' ? this.readBrief(id) : undefined));
  }

  /** Fills only a missing tooltip on the item VS Code passes, from the row's record; nothing else on the row changes. */
  resolveTreeItem(item: vscode.TreeItem, element: ExplorationsTreeItem): vscode.TreeItem {
    if (element instanceof ExplorationItem && item.tooltip === undefined) {
      item.tooltip = tooltipFor(element.explorationId, this.readBrief(element.explorationId));
    }
    return item;
  }

  private roots(): ExplorationsTreeItem[] {
    let discovery: ExplorationDiscovery;
    try {
      discovery = this.service.discover();
    } catch (error) {
      const failure = failureOf(error);
      return [new ExplorationNoticeItem('explorations:failure', 'Explorations unavailable', `${failure.message}\nNothing was changed. Inspect .hive/explorations, then refresh.`, 'warning', failure.reason)];
    }
    return [new ExplorationGroupItem('active', discovery.active), new ExplorationGroupItem('closed', discovery.closed)];
  }

  private readBrief(id: string): BriefRead {
    try {
      return this.service.read({ id }) as ExplorationBriefView;
    } catch (error) {
      return { failure: failureOf(error) };
    }
  }
}

/** Lets the operator open any discovered exploration by ID. Returns the chosen ID, or undefined when cancelled. */
export async function pickExploration(projectRoot: string): Promise<string | undefined> {
  let discovery: ExplorationDiscovery;
  try {
    discovery = new ExplorationService(projectRoot).discover();
  } catch (error) {
    const failure = failureOf(error);
    vscode.window.showErrorMessage(`Hive: Could not list explorations (${failure.reason}). ${failure.message}`);
    return undefined;
  }
  const items = [
    ...discovery.active.map((id) => ({ id, label: id, description: 'Active' })),
    ...discovery.closed.map((id) => ({ id, label: id, description: 'Closed' })),
  ];
  if (!items.length) {
    vscode.window.showInformationMessage('Hive: This project has no explorations yet.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, { title: `Open Exploration (${projectRoot})`, placeHolder: 'Search explorations by ID', matchOnDescription: true });
  return picked?.id;
}
