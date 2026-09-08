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
  pickItems: [] as any[],
  warnings: [] as string[],
};

export function resetVscodeTestState(): void {
  for (const key of Object.keys(vscodeTestState) as Array<keyof typeof vscodeTestState>) {
    vscodeTestState[key] = [];
  }
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

class RelativePattern {
  constructor(public base: string, public pattern: string) {}
}

const window = {
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
  async showTextDocument(document: any) {
    vscodeTestState.shown.push(document);
  },
};

const workspace = {
  async openTextDocument(uri: any) {
    return { uri };
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
};

const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};

export const vscodeTestDouble = {
  window,
  workspace,
  RelativePattern,
  TreeItem,
  ThemeIcon,
  MarkdownString,
  EventEmitter,
  TreeItemCollapsibleState,
  Uri,
};
