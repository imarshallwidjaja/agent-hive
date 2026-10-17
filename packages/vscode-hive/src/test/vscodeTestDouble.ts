/**
 * Canonical `vscode` test double for this package.
 *
 * Bun's `mock.module('vscode', ...)` registry is process-global and the module
 * cache is shared across test files, so whichever registration wins binds every
 * module under test for the whole run, and the winner depends on file execution
 * order. While the files registered competing partial doubles, `vscode.window`
 * and `vscode.workspace` could come back undefined under some orderings. Every
 * test file now registers this one complete double, so all registrations return
 * the same object and the winner no longer matters.
 *
 * Recorded interactions live in `vscodeTestState`, which each test file resets
 * in `beforeEach`, keeping per-file expectations isolated.
 */

export const vscodeTestState = {
  fired: [] as any[],
  disposed: [] as any[],
  watchers: [] as any[],
  picks: [] as any[],
  inputs: [] as any[],
  confirmations: [] as any[],
  messages: [] as string[],
  errors: [] as string[],
  shown: [] as any[],
  shownOptions: [] as any[],
  pickItems: [] as any[],
  warnings: [] as string[],
  commands: new Map<string, (...args: any[]) => unknown>(),
  clipboard: [] as string[],
  activeTextEditor: undefined as any,
  workspaceFolders: undefined as any,
  treeViews: [] as any[],
  textDocuments: [] as any[],
  contentProviders: new Map<string, any>(),
  linkProviders: [] as any[],
  openListeners: new Set<(document: any) => void>(),
  closeListeners: new Set<(document: any) => void>(),
};

export function resetVscodeTestState(): void {
  for (const key of Object.keys(vscodeTestState) as Array<keyof typeof vscodeTestState>) {
    vscodeTestState[key] = [] as never;
  }
  vscodeTestState.commands = new Map();
  vscodeTestState.activeTextEditor = undefined;
  vscodeTestState.workspaceFolders = undefined;
  vscodeTestState.contentProviders = new Map();
  vscodeTestState.openListeners = new Set();
  vscodeTestState.closeListeners = new Set();
}

function listen<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void) {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

/**
 * Disposes a provider-backed document the way the extension host does: the document leaves
 * `workspace.textDocuments` before `onDidCloseTextDocument` fires.
 */
export function disposeTextDocument(document: any): void {
  vscodeTestState.textDocuments = vscodeTestState.textDocuments.filter((open) => open !== document);
  for (const listener of [...vscodeTestState.closeListeners]) listener(document);
}

class TreeItem {
  label: string;
  collapsibleState: number;
  description?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;
  resourceUri?: unknown;
  tooltip?: unknown;

  constructor(label: string, collapsibleState: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(public readonly id: string) {}
}

class MarkdownString {
  value = '';

  appendMarkdown(text: string): void {
    this.value += text;
  }
}

class EventEmitter<T> {
  private listeners = new Set<(value: T | undefined) => void>();

  readonly event = (listener: (value: T | undefined) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T | undefined): void {
    vscodeTestState.fired.push(value);
    for (const listener of this.listeners) listener(value);
  }

  dispose(): void {
    vscodeTestState.disposed.push(this);
    this.listeners.clear();
  }
}

class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

class Selection {
  constructor(public readonly anchor: Position, public readonly active: Position) {}
}

class Range {
  constructor(public readonly start: Position, public readonly end: Position) {}
}

class DocumentLink {
  tooltip?: string;
  constructor(public readonly range: Range, public readonly target: unknown) {}
}

class RelativePattern {
  constructor(public base: string, public pattern: string) {}
}

const window = {
  get activeTextEditor() {
    return vscodeTestState.activeTextEditor;
  },
  createTreeView(id: string, options: unknown) {
    const view = { id, options, description: undefined as string | undefined, dispose() {} };
    vscodeTestState.treeViews.push(view);
    return view;
  },
  registerTreeDataProvider() {
    return { dispose() {} };
  },
  async showQuickPick(items: any[]) {
    vscodeTestState.pickItems = items;
    const pick = vscodeTestState.picks.shift();
    return typeof pick === 'function' ? pick(items) : pick;
  },
  async showInputBox() {
    return vscodeTestState.inputs.shift();
  },
  async showWarningMessage(message: string) {
    vscodeTestState.warnings.push(message);
    const confirm = vscodeTestState.confirmations.shift();
    return typeof confirm === 'function' ? confirm() : confirm;
  },
  showInformationMessage(message: string) {
    vscodeTestState.messages.push(message);
  },
  showErrorMessage(message: string) {
    vscodeTestState.errors.push(message);
  },
  async showTextDocument(document: any, options?: unknown) {
    vscodeTestState.shown.push(document);
    vscodeTestState.shownOptions.push(options);
  },
};

const workspace = {
  get workspaceFolders() {
    return vscodeTestState.workspaceFolders;
  },
  /** Like the editor, an open document re-reads its content only when the provider signals a change. */
  registerTextDocumentContentProvider(scheme: string, provider: any) {
    vscodeTestState.contentProviders.set(scheme, provider);
    const subscription = provider.onDidChange?.((uri: any) => {
      const document = vscodeTestState.textDocuments.find((open) => open.uri.toString() === uri.toString());
      if (document) document.text = provider.provideTextDocumentContent(uri);
    });
    return { dispose: () => subscription?.dispose() };
  },
  onDidCloseTextDocument(listener: (document: any) => void) {
    return listen(vscodeTestState.closeListeners, listener);
  },
  onDidOpenTextDocument(listener: (document: any) => void) {
    return listen(vscodeTestState.openListeners, listener);
  },
  onDidSaveTextDocument() {
    return { dispose() {} };
  },
  get textDocuments() {
    return vscodeTestState.textDocuments;
  },
  /** Documents for a scheme with a registered content provider are kept open and reused, as in the editor. */
  async openTextDocument(uri: any) {
    const provider = vscodeTestState.contentProviders.get(uri?.scheme);
    if (!provider) return { uri };
    const existing = vscodeTestState.textDocuments.find((open) => open.uri.toString() === uri.toString());
    if (existing) return existing;
    const document = {
      uri,
      fileName: uri.fsPath,
      languageId: 'plaintext',
      text: provider.provideTextDocumentContent(uri),
      getText() { return this.text; },
    };
    vscodeTestState.textDocuments.push(document);
    for (const listener of [...vscodeTestState.openListeners]) listener(document);
    return document;
  },
  createFileSystemWatcher() {
    const watcher = {
      create: (_uri: any) => {},
      change: (_uri: any) => {},
      delete: (_uri: any) => {},
      disposed: false,
      onDidCreate(fn: any) { this.create = fn; },
      onDidChange(fn: any) { this.change = fn; },
      onDidDelete(fn: any) { this.delete = fn; },
      dispose() { this.disposed = true; },
    };
    vscodeTestState.watchers.push(watcher);
    return watcher;
  },
};

const Uri = {
  file(targetPath: string) {
    return { fsPath: targetPath };
  },
  parse(value: string) {
    return { value, toString: () => value };
  },
  from(components: { scheme: string; path?: string; query?: string }) {
    const uri = { scheme: components.scheme, path: components.path ?? '', fsPath: components.path ?? '', query: components.query ?? '' };
    const value = `${uri.scheme}:${uri.path}${uri.query ? `?${uri.query}` : ''}`;
    return { ...uri, toString: () => value };
  },
};

const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};

const commands = {
  registerCommand(id: string, handler: (...args: any[]) => unknown) {
    vscodeTestState.commands.set(id, handler);
    return { dispose: () => vscodeTestState.commands.delete(id) };
  },
  async executeCommand(id: string, ...args: any[]) {
    return vscodeTestState.commands.get(id)?.(...args);
  },
};

const comments = {
  createCommentController() {
    return { dispose() {} };
  },
};

const languages = {
  registerDocumentLinkProvider(_selector: unknown, provider: any) {
    vscodeTestState.linkProviders.push(provider);
    return { dispose() {} };
  },
  /**
   * The extension host treats a language change as remove + add of the same document: close fires while the
   * document is still in `workspace.textDocuments`, then open fires, and the content provider is not asked again.
   */
  async setTextDocumentLanguage(document: any, languageId: string) {
    for (const listener of [...vscodeTestState.closeListeners]) listener(document);
    document.languageId = languageId;
    for (const listener of [...vscodeTestState.openListeners]) listener(document);
    return document;
  },
};

const env = {
  clipboard: {
    async writeText(value: string) {
      vscodeTestState.clipboard.push(value);
    },
  },
};

export const vscodeTestDouble = {
  commands,
  comments,
  languages,
  env,
  window,
  workspace,
  RelativePattern,
  Position,
  Range,
  DocumentLink,
  Selection,
  TreeItem,
  ThemeIcon,
  MarkdownString,
  EventEmitter,
  TreeItemCollapsibleState,
  Uri,
};
