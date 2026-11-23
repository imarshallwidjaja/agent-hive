import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { ExplorationFullView } from 'hive-core';
import { ExplorationError, ExplorationService } from 'hive-core';
import { buildExplorationModel } from './explorationModel.js';
import { renderExplorationHtml } from './explorationWebview.js';

/** The only requests the exploration tab can make. None carries data: the host decides what each one reads. */
export type ExplorationWebviewRequest = 'ready' | 'refresh' | 'openPrior';

const REQUESTS: readonly ExplorationWebviewRequest[] = ['ready', 'refresh', 'openPrior'];

/** Accepts exactly `{ type }` with a known request; anything else from the webview is ignored. */
export function parseExplorationRequest(value: unknown): ExplorationWebviewRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const type = (value as { type?: unknown }).type;
  return keys.length === 1 && keys[0] === 'type' && REQUESTS.includes(type as ExplorationWebviewRequest)
    ? type as ExplorationWebviewRequest
    : null;
}

interface ExplorationTab {
  readonly id: string;
  readonly panel: vscode.WebviewPanel;
  /** The webview has loaded and can receive a render. A hidden tab's webview is discarded and loads again on return. */
  ready: boolean;
  /** Revision last sent to the webview, which later changes are compared against. */
  shownRevision: number | null;
  shownStatus: string | null;
  changedSince: number | null;
  priorExplorationId: string | null;
}

/**
 * Read-only exploration tabs, one per exploration ID. A tab reads the stored record when it loads, when the watcher
 * reports that record's file, and on Refresh; a hidden tab catches up when it is shown again. It never writes to
 * `.hive` or to workspace state, and the webview can only ask for a refresh or for the recorded prior exploration.
 */
export class ExplorationViewer implements vscode.Disposable {
  static readonly viewType = 'hive.exploration';
  private readonly tabs = new Map<string, ExplorationTab>();
  private readonly service: ExplorationService;

  constructor(projectRoot: string) {
    this.service = new ExplorationService(projectRoot);
  }

  open(id: string): void {
    const existing = this.tabs.get(id);
    if (existing) {
      existing.panel.reveal();
      this.render(existing);
      return;
    }
    const panel = vscode.window.createWebviewPanel(ExplorationViewer.viewType, `Exploration ${id}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      enableCommandUris: false,
      enableFindWidget: true,
      localResourceRoots: [],
      retainContextWhenHidden: false,
    });
    const tab: ExplorationTab = { id, panel, ready: false, shownRevision: null, shownStatus: null, changedSince: null, priorExplorationId: null };
    this.tabs.set(id, tab);
    panel.webview.onDidReceiveMessage((message: unknown) => this.receive(tab, message));
    panel.onDidChangeViewState(() => {
      if (!panel.visible) tab.ready = false;
    });
    panel.onDidDispose(() => this.tabs.delete(id));
    panel.webview.html = renderExplorationHtml(crypto.randomBytes(16).toString('base64'));
  }

  /** The watcher saw this exploration's stored file appear, change or go away. */
  recordChanged(id: string): void {
    const tab = this.tabs.get(id);
    if (tab) this.render(tab);
  }

  refreshAll(): void {
    for (const tab of this.tabs.values()) this.render(tab);
  }

  dispose(): void {
    for (const tab of [...this.tabs.values()]) tab.panel.dispose();
    this.tabs.clear();
  }

  private receive(tab: ExplorationTab, message: unknown): void {
    const request = parseExplorationRequest(message);
    if (request === 'ready') {
      // A ready that arrives after the tab was hidden comes from a webview that is being discarded; the webview loaded
      // when the tab is shown again sends its own.
      if (!tab.panel.visible) return;
      tab.ready = true;
      this.render(tab);
    } else if (request === 'refresh') {
      this.render(tab);
    } else if (request === 'openPrior') {
      this.openPrior(tab);
    }
  }

  private openPrior(tab: ExplorationTab): void {
    const prior = tab.priorExplorationId;
    if (!prior) return;
    try {
      this.service.read({ id: prior });
    } catch (error) {
      if (error instanceof ExplorationError && error.reason === 'not_found') {
        void tab.panel.webview.postMessage({
          type: 'notice',
          text: `The prior exploration ${prior} is not in this project's .hive/explorations. It may have been removed or recorded in another project.`,
        });
        return;
      }
      // Any other failure opens the prior tab, which shows the reason.
    }
    this.open(prior);
  }

  /** Reads the record and sends it, unless the webview cannot receive it yet; it asks again when it loads. */
  private render(tab: ExplorationTab): void {
    if (!tab.ready || !tab.panel.visible) return;
    let view: ExplorationFullView;
    try {
      view = this.service.read({ id: tab.id, view: 'full' }) as ExplorationFullView;
    } catch (error) {
      tab.priorExplorationId = null;
      void tab.panel.webview.postMessage({
        type: 'unavailable',
        id: tab.id,
        reason: error instanceof ExplorationError ? error.reason : 'unexpected_error',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const previous = tab.shownRevision;
    if (previous === null || view.revision < previous) tab.changedSince = null;
    else if (view.revision > previous) tab.changedSince = previous;
    const announcement = previous === null || view.revision === previous
      ? ''
      : view.status !== 'active' && tab.shownStatus === 'active'
        ? `Exploration ${view.status} at revision ${view.revision}.`
        : `Revision ${view.revision} recorded.`;
    tab.shownRevision = view.revision;
    tab.shownStatus = view.status;
    tab.priorExplorationId = view.priorExplorationId ?? null;
    void tab.panel.webview.postMessage({ type: 'render', model: buildExplorationModel(view, tab.changedSince), announcement });
  }
}
