"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode5 = __toESM(require("vscode"));
var fs3 = __toESM(require("fs"));
var path3 = __toESM(require("path"));

// src/services/watcher.ts
var vscode = __toESM(require("vscode"));
var HiveWatcher = class {
  constructor(workspaceRoot, onChange) {
    const pattern = new vscode.RelativePattern(
      workspaceRoot,
      ".hive/**/*"
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidCreate(onChange);
    this.watcher.onDidChange(onChange);
    this.watcher.onDidDelete(onChange);
  }
  dispose() {
    this.watcher.dispose();
  }
};

// src/services/launcher.ts
var vscode2 = __toESM(require("vscode"));
var Launcher = class {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
  }
  async openStep(client, feature, task, sessionId) {
    const terminalName = `OpenCode: ${feature}/${task}`;
    if (sessionId) {
      const terminal2 = vscode2.window.createTerminal({
        name: terminalName,
        cwd: this.workspaceRoot
      });
      terminal2.sendText(`opencode -s ${sessionId}`);
      terminal2.show();
      return;
    }
    const terminal = vscode2.window.createTerminal({
      name: terminalName,
      cwd: this.workspaceRoot
    });
    terminal.sendText("opencode");
    terminal.show();
  }
  async openFeature(client, feature) {
    const terminal = vscode2.window.createTerminal({
      name: `OpenCode: ${feature}`,
      cwd: this.workspaceRoot
    });
    terminal.sendText("opencode");
    terminal.show();
  }
  openSession(sessionId) {
    const terminal = vscode2.window.createTerminal({
      name: `OpenCode - ${sessionId.slice(0, 8)}`,
      cwd: this.workspaceRoot
    });
    terminal.sendText(`opencode -s ${sessionId}`);
    terminal.show();
  }
};

// src/providers/sidebarProvider.ts
var vscode3 = __toESM(require("vscode"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var STATUS_ICONS = {
  pending: "circle-outline",
  in_progress: "sync~spin",
  done: "pass",
  cancelled: "circle-slash",
  planning: "edit",
  approved: "check",
  executing: "run-all",
  completed: "pass-filled"
};
var StatusGroupItem = class extends vscode3.TreeItem {
  constructor(groupName, groupStatus, features, collapsed = false) {
    super(groupName, collapsed ? vscode3.TreeItemCollapsibleState.Collapsed : vscode3.TreeItemCollapsibleState.Expanded);
    this.groupName = groupName;
    this.groupStatus = groupStatus;
    this.features = features;
    this.description = `${features.length}`;
    this.contextValue = `status-group-${groupStatus}`;
    const icons = {
      in_progress: "sync~spin",
      pending: "circle-outline",
      completed: "pass-filled"
    };
    this.iconPath = new vscode3.ThemeIcon(icons[groupStatus] || "folder");
  }
};
var FeatureItem = class extends vscode3.TreeItem {
  constructor(name, feature, taskStats, isActive) {
    super(name, vscode3.TreeItemCollapsibleState.Collapsed);
    this.name = name;
    this.feature = feature;
    this.taskStats = taskStats;
    this.isActive = isActive;
    const statusLabel = feature.status.charAt(0).toUpperCase() + feature.status.slice(1);
    this.description = isActive ? `${statusLabel} \xB7 ${taskStats.done}/${taskStats.total}` : `${taskStats.done}/${taskStats.total}`;
    this.contextValue = `feature-${feature.status}`;
    this.iconPath = new vscode3.ThemeIcon(STATUS_ICONS[feature.status] || "package");
    if (isActive) {
      this.resourceUri = vscode3.Uri.parse("hive:active");
    }
  }
};
var PlanItem = class extends vscode3.TreeItem {
  constructor(featureName, planPath, featureStatus, commentCount) {
    super("Plan", vscode3.TreeItemCollapsibleState.None);
    this.featureName = featureName;
    this.planPath = planPath;
    this.featureStatus = featureStatus;
    this.commentCount = commentCount;
    this.description = commentCount > 0 ? `${commentCount} comment(s)` : "";
    this.contextValue = featureStatus === "planning" ? "plan-draft" : "plan-approved";
    this.iconPath = new vscode3.ThemeIcon("file-text");
    this.command = {
      command: "vscode.open",
      title: "Open Plan",
      arguments: [vscode3.Uri.file(planPath)]
    };
  }
};
var ContextFolderItem = class extends vscode3.TreeItem {
  constructor(featureName, contextPath, fileCount) {
    super("Context", fileCount > 0 ? vscode3.TreeItemCollapsibleState.Collapsed : vscode3.TreeItemCollapsibleState.None);
    this.featureName = featureName;
    this.contextPath = contextPath;
    this.fileCount = fileCount;
    this.description = fileCount > 0 ? `${fileCount} file(s)` : "";
    this.contextValue = "context-folder";
    this.iconPath = new vscode3.ThemeIcon("folder");
  }
};
var ContextFileItem = class extends vscode3.TreeItem {
  constructor(filename, filePath) {
    super(filename, vscode3.TreeItemCollapsibleState.None);
    this.filename = filename;
    this.filePath = filePath;
    this.contextValue = "context-file";
    this.iconPath = new vscode3.ThemeIcon(filename.endsWith(".md") ? "markdown" : "file");
    this.command = {
      command: "vscode.open",
      title: "Open File",
      arguments: [vscode3.Uri.file(filePath)]
    };
  }
};
var TasksGroupItem = class extends vscode3.TreeItem {
  constructor(featureName, tasks) {
    super("Tasks", tasks.length > 0 ? vscode3.TreeItemCollapsibleState.Collapsed : vscode3.TreeItemCollapsibleState.None);
    this.featureName = featureName;
    this.tasks = tasks;
    const done = tasks.filter((t) => t.status.status === "done").length;
    this.description = `${done}/${tasks.length}`;
    this.contextValue = "tasks-group";
    this.iconPath = new vscode3.ThemeIcon("checklist");
  }
};
var TaskItem = class extends vscode3.TreeItem {
  constructor(featureName, folder, status, specPath, reportPath, subtaskCount = 0, subtasksDone = 0) {
    const name = folder.replace(/^\d+-/, "");
    const hasFiles = specPath !== null || reportPath !== null;
    const hasSubtasks = subtaskCount > 0;
    const hasChildren = hasFiles || hasSubtasks;
    super(name, hasChildren ? vscode3.TreeItemCollapsibleState.Collapsed : vscode3.TreeItemCollapsibleState.None);
    this.featureName = featureName;
    this.folder = folder;
    this.status = status;
    this.specPath = specPath;
    this.reportPath = reportPath;
    this.subtaskCount = subtaskCount;
    this.subtasksDone = subtasksDone;
    const subtaskInfo = subtaskCount > 0 ? ` (${subtasksDone}/${subtaskCount})` : "";
    this.description = (status.summary || "") + subtaskInfo;
    this.contextValue = `task-${status.status}${status.origin === "manual" ? "-manual" : ""}`;
    const iconName = STATUS_ICONS[status.status] || "circle-outline";
    this.iconPath = new vscode3.ThemeIcon(iconName);
    this.tooltip = new vscode3.MarkdownString();
    this.tooltip.appendMarkdown(`**${folder}**

`);
    this.tooltip.appendMarkdown(`Status: ${status.status}

`);
    this.tooltip.appendMarkdown(`Origin: ${status.origin}

`);
    if (status.summary) {
      this.tooltip.appendMarkdown(`Summary: ${status.summary}

`);
    }
    if (subtaskCount > 0) {
      this.tooltip.appendMarkdown(`Subtasks: ${subtasksDone}/${subtaskCount} done`);
    }
  }
};
var TaskFileItem = class extends vscode3.TreeItem {
  constructor(filename, filePath) {
    super(filename, vscode3.TreeItemCollapsibleState.None);
    this.filename = filename;
    this.filePath = filePath;
    this.contextValue = "task-file";
    this.iconPath = new vscode3.ThemeIcon("markdown");
    this.command = {
      command: "vscode.open",
      title: "Open File",
      arguments: [vscode3.Uri.file(filePath)]
    };
  }
};
var SubtaskItem = class extends vscode3.TreeItem {
  constructor(featureName, taskFolder, subtask, subtaskPath) {
    super(subtask.name, vscode3.TreeItemCollapsibleState.None);
    this.featureName = featureName;
    this.taskFolder = taskFolder;
    this.subtask = subtask;
    this.subtaskPath = subtaskPath;
    const typeTag = subtask.type ? ` [${subtask.type}]` : "";
    const targetFile = subtask.status === "done" ? "report" : "spec";
    this.description = `${subtask.id}${typeTag} \u2192 ${targetFile}`;
    this.contextValue = `subtask-${subtask.status}`;
    const statusIcon = STATUS_ICONS[subtask.status] || "circle-outline";
    this.iconPath = new vscode3.ThemeIcon(statusIcon);
    const targetFilePath = path.join(subtaskPath, subtask.status === "done" ? "report.md" : "spec.md");
    if (fs.existsSync(targetFilePath)) {
      this.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [vscode3.Uri.file(targetFilePath)]
      };
    }
    this.tooltip = new vscode3.MarkdownString();
    this.tooltip.appendMarkdown(`**${subtask.name}**

`);
    this.tooltip.appendMarkdown(`ID: ${subtask.id}

`);
    this.tooltip.appendMarkdown(`Status: ${subtask.status}

`);
    if (subtask.type) {
      this.tooltip.appendMarkdown(`Type: ${subtask.type}

`);
    }
    this.tooltip.appendMarkdown(`Click to open: ${targetFile}.md`);
  }
};
var SessionsGroupItem = class extends vscode3.TreeItem {
  constructor(featureName, sessions, master) {
    super("Sessions", sessions.length > 0 ? vscode3.TreeItemCollapsibleState.Collapsed : vscode3.TreeItemCollapsibleState.None);
    this.featureName = featureName;
    this.sessions = sessions;
    this.master = master;
    this.description = sessions.length > 0 ? `${sessions.length} active` : "";
    this.contextValue = "sessions-group";
    this.iconPath = new vscode3.ThemeIcon("broadcast");
  }
};
var SessionItem = class extends vscode3.TreeItem {
  constructor(featureName, session, isMaster) {
    const label = session.taskFolder || (isMaster ? "Master" : `Session ${session.sessionId.slice(4, 12)}`);
    super(label, vscode3.TreeItemCollapsibleState.None);
    this.featureName = featureName;
    this.session = session;
    this.isMaster = isMaster;
    const shortId = session.sessionId.slice(0, 8);
    this.description = isMaster ? `\u2605 ${shortId}` : shortId;
    this.contextValue = "session";
    this.iconPath = new vscode3.ThemeIcon(isMaster ? "star-full" : "terminal");
    this.tooltip = new vscode3.MarkdownString();
    this.tooltip.appendMarkdown(`**Session**: ${session.sessionId}

`);
    if (session.taskFolder) {
      this.tooltip.appendMarkdown(`**Task**: ${session.taskFolder}

`);
    }
    this.tooltip.appendMarkdown(`**Started**: ${session.startedAt}

`);
    this.tooltip.appendMarkdown(`**Last Active**: ${session.lastActiveAt}`);
  }
};
var HiveSidebarProvider = class {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this._onDidChangeTreeData = new vscode3.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() {
    this._onDidChangeTreeData.fire(void 0);
  }
  getTreeItem(element) {
    return element;
  }
  async getChildren(element) {
    if (!element) {
      return this.getStatusGroups();
    }
    if (element instanceof StatusGroupItem) {
      return element.features;
    }
    if (element instanceof FeatureItem) {
      return this.getFeatureChildren(element.name);
    }
    if (element instanceof ContextFolderItem) {
      return this.getContextFiles(element.featureName, element.contextPath);
    }
    if (element instanceof TasksGroupItem) {
      return this.getTasks(element.featureName, element.tasks);
    }
    if (element instanceof TaskItem) {
      return this.getTaskFiles(element);
    }
    if (element instanceof SessionsGroupItem) {
      return this.getSessions(element.featureName, element.sessions, element.master);
    }
    return [];
  }
  getStatusGroups() {
    const features = this.getAllFeatures();
    const inProgress = [];
    const pending = [];
    const completed = [];
    for (const feature of features) {
      if (feature.feature.status === "executing") {
        inProgress.push(feature);
      } else if (feature.feature.status === "planning" || feature.feature.status === "approved") {
        pending.push(feature);
      } else if (feature.feature.status === "completed") {
        completed.push(feature);
      }
    }
    const groups = [];
    if (inProgress.length > 0) {
      groups.push(new StatusGroupItem("In Progress", "in_progress", inProgress, false));
    }
    if (pending.length > 0) {
      groups.push(new StatusGroupItem("Pending", "pending", pending, false));
    }
    if (completed.length > 0) {
      groups.push(new StatusGroupItem("Completed", "completed", completed, true));
    }
    return groups;
  }
  getAllFeatures() {
    const featuresPath = path.join(this.workspaceRoot, ".hive", "features");
    if (!fs.existsSync(featuresPath)) return [];
    const activeFeature = this.getActiveFeature();
    const features = [];
    const dirs = fs.readdirSync(featuresPath, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const name of dirs) {
      const featureJsonPath = path.join(featuresPath, name, "feature.json");
      if (!fs.existsSync(featureJsonPath)) continue;
      const feature = JSON.parse(fs.readFileSync(featureJsonPath, "utf-8"));
      const taskStats = this.getTaskStats(name);
      const isActive = name === activeFeature;
      features.push(new FeatureItem(name, feature, taskStats, isActive));
    }
    features.sort((a, b) => {
      if (a.isActive) return -1;
      if (b.isActive) return 1;
      return 0;
    });
    return features;
  }
  getFeatureChildren(featureName) {
    const featurePath = path.join(this.workspaceRoot, ".hive", "features", featureName);
    const items = [];
    const featureJsonPath = path.join(featurePath, "feature.json");
    const feature = JSON.parse(fs.readFileSync(featureJsonPath, "utf-8"));
    const planPath = path.join(featurePath, "plan.md");
    if (fs.existsSync(planPath)) {
      const commentCount = this.getCommentCount(featureName);
      items.push(new PlanItem(featureName, planPath, feature.status, commentCount));
    }
    const contextPath = path.join(featurePath, "context");
    const contextFiles = fs.existsSync(contextPath) ? fs.readdirSync(contextPath).filter((f) => !f.startsWith(".")) : [];
    items.push(new ContextFolderItem(featureName, contextPath, contextFiles.length));
    const tasks = this.getTaskList(featureName);
    items.push(new TasksGroupItem(featureName, tasks));
    const sessionsData = this.getSessionsData(featureName);
    items.push(new SessionsGroupItem(featureName, sessionsData.sessions, sessionsData.master));
    return items;
  }
  getContextFiles(featureName, contextPath) {
    if (!fs.existsSync(contextPath)) return [];
    return fs.readdirSync(contextPath).filter((f) => !f.startsWith(".")).map((f) => new ContextFileItem(f, path.join(contextPath, f)));
  }
  getTasks(featureName, tasks) {
    const featurePath = path.join(this.workspaceRoot, ".hive", "features", featureName);
    return tasks.map((t) => {
      const taskDir = path.join(featurePath, "tasks", t.folder);
      const specPath = path.join(taskDir, "spec.md");
      const reportPath = path.join(taskDir, "report.md");
      const hasSpec = fs.existsSync(specPath);
      const hasReport = fs.existsSync(reportPath);
      const subtasks = this.getSubtasksFromFolders(featureName, t.folder);
      const subtaskCount = subtasks.length;
      const subtasksDone = subtasks.filter((s) => s.status === "done").length;
      return new TaskItem(featureName, t.folder, t.status, hasSpec ? specPath : null, hasReport ? reportPath : null, subtaskCount, subtasksDone);
    });
  }
  getTaskFiles(taskItem) {
    const items = [];
    if (taskItem.specPath) {
      items.push(new TaskFileItem("spec.md", taskItem.specPath));
    }
    if (taskItem.reportPath) {
      items.push(new TaskFileItem("report.md", taskItem.reportPath));
    }
    const subtasks = this.getSubtasksFromFolders(taskItem.featureName, taskItem.folder);
    for (const subtask of subtasks) {
      const subtaskPath = path.join(
        this.workspaceRoot,
        ".hive",
        "features",
        taskItem.featureName,
        "tasks",
        taskItem.folder,
        "subtasks",
        subtask.folder
      );
      items.push(new SubtaskItem(taskItem.featureName, taskItem.folder, subtask, subtaskPath));
    }
    return items;
  }
  getSubtasksFromFolders(featureName, taskFolder) {
    const subtasksPath = path.join(
      this.workspaceRoot,
      ".hive",
      "features",
      featureName,
      "tasks",
      taskFolder,
      "subtasks"
    );
    if (!fs.existsSync(subtasksPath)) return [];
    const taskOrder = parseInt(taskFolder.split("-")[0], 10);
    const folders = fs.readdirSync(subtasksPath, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    return folders.map((folder) => {
      const statusPath = path.join(subtasksPath, folder, "status.json");
      const subtaskOrder = parseInt(folder.split("-")[0], 10);
      const name = folder.replace(/^\d+-/, "");
      let status = { status: "pending" };
      if (fs.existsSync(statusPath)) {
        try {
          status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
        } catch {
        }
      }
      return {
        id: `${taskOrder}.${subtaskOrder}`,
        name,
        folder,
        status: status.status || "pending",
        type: status.type,
        createdAt: status.createdAt,
        completedAt: status.completedAt
      };
    });
  }
  getTaskList(featureName) {
    const tasksPath = path.join(this.workspaceRoot, ".hive", "features", featureName, "tasks");
    if (!fs.existsSync(tasksPath)) return [];
    const folders = fs.readdirSync(tasksPath, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    return folders.map((folder) => {
      const statusPath = path.join(tasksPath, folder, "status.json");
      const status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, "utf-8")) : { status: "pending", origin: "plan" };
      return { folder, status };
    });
  }
  getTaskStats(featureName) {
    const tasks = this.getTaskList(featureName);
    return {
      total: tasks.length,
      done: tasks.filter((t) => t.status.status === "done").length
    };
  }
  getActiveFeature() {
    const activePath = path.join(this.workspaceRoot, ".hive", "active-feature");
    if (!fs.existsSync(activePath)) return null;
    return fs.readFileSync(activePath, "utf-8").trim();
  }
  getCommentCount(featureName) {
    const commentsPath = path.join(this.workspaceRoot, ".hive", "features", featureName, "comments.json");
    if (!fs.existsSync(commentsPath)) return 0;
    try {
      const data = JSON.parse(fs.readFileSync(commentsPath, "utf-8"));
      return data.threads?.length || 0;
    } catch {
      return 0;
    }
  }
  getSessionsData(featureName) {
    const sessionsPath = path.join(this.workspaceRoot, ".hive", "features", featureName, "sessions.json");
    if (!fs.existsSync(sessionsPath)) return { sessions: [] };
    try {
      return JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
    } catch {
      return { sessions: [] };
    }
  }
  getSessions(featureName, sessions, master) {
    return sessions.map((s) => new SessionItem(featureName, s, s.sessionId === master));
  }
};

// src/providers/planCommentController.ts
var vscode4 = __toESM(require("vscode"));
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));
var PlanCommentController = class {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.threads = /* @__PURE__ */ new Map();
    this.controller = vscode4.comments.createCommentController(
      "hive-plan-review",
      "Plan Review"
    );
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (!document.fileName.endsWith("plan.md")) return [];
        return [new vscode4.Range(0, 0, document.lineCount - 1, 0)];
      }
    };
    const pattern = new vscode4.RelativePattern(
      workspaceRoot,
      ".hive/features/*/comments.json"
    );
    this.commentsWatcher = vscode4.workspace.createFileSystemWatcher(pattern);
    this.commentsWatcher.onDidChange((uri) => this.onCommentsFileChanged(uri));
    this.commentsWatcher.onDidDelete((uri) => this.onCommentsFileChanged(uri));
  }
  onCommentsFileChanged(commentsUri) {
    const featureDir = path2.dirname(commentsUri.fsPath);
    const planPath = path2.join(featureDir, "plan.md");
    const planUri = vscode4.Uri.file(planPath);
    this.loadComments(planUri);
  }
  registerCommands(context) {
    context.subscriptions.push(
      this.controller,
      vscode4.commands.registerCommand("hive.comment.create", (reply) => {
        this.createComment(reply);
      }),
      vscode4.commands.registerCommand("hive.comment.reply", (reply) => {
        this.replyToComment(reply);
      }),
      vscode4.commands.registerCommand("hive.comment.resolve", (thread) => {
        thread.dispose();
        this.saveComments(thread.uri);
      }),
      vscode4.commands.registerCommand("hive.comment.delete", (comment) => {
        for (const [id, thread] of this.threads) {
          const commentIndex = thread.comments.findIndex((c) => c === comment);
          if (commentIndex !== -1) {
            thread.comments = thread.comments.filter((c) => c !== comment);
            if (thread.comments.length === 0) {
              thread.dispose();
              this.threads.delete(id);
            }
            this.saveComments(thread.uri);
            break;
          }
        }
      }),
      vscode4.workspace.onDidOpenTextDocument((doc) => {
        if (doc.fileName.endsWith("plan.md")) {
          this.loadComments(doc.uri);
        }
      }),
      vscode4.workspace.onDidSaveTextDocument((doc) => {
        if (doc.fileName.endsWith("plan.md")) {
          this.saveComments(doc.uri);
        }
      })
    );
    vscode4.workspace.textDocuments.forEach((doc) => {
      if (doc.fileName.endsWith("plan.md")) {
        this.loadComments(doc.uri);
      }
    });
  }
  createComment(reply) {
    const range = reply.thread.range ?? new vscode4.Range(0, 0, 0, 0);
    const thread = this.controller.createCommentThread(
      reply.thread.uri,
      range,
      [{
        body: new vscode4.MarkdownString(reply.text),
        author: { name: "You" },
        mode: vscode4.CommentMode.Preview
      }]
    );
    thread.canReply = true;
    thread.collapsibleState = vscode4.CommentThreadCollapsibleState.Expanded;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.threads.set(id, thread);
    this.saveComments(reply.thread.uri);
    reply.thread.dispose();
  }
  replyToComment(reply) {
    const newComment = {
      body: new vscode4.MarkdownString(reply.text),
      author: { name: "You" },
      mode: vscode4.CommentMode.Preview
    };
    reply.thread.comments = [...reply.thread.comments, newComment];
    this.saveComments(reply.thread.uri);
  }
  getCommentsPath(uri) {
    const match = uri.fsPath.match(/\.hive\/features\/([^/]+)\/plan\.md$/);
    if (!match) return null;
    return path2.join(this.workspaceRoot, ".hive", "features", match[1], "comments.json");
  }
  loadComments(uri) {
    const commentsPath = this.getCommentsPath(uri);
    if (!commentsPath || !fs2.existsSync(commentsPath)) return;
    try {
      const data = JSON.parse(fs2.readFileSync(commentsPath, "utf-8"));
      this.threads.forEach((thread, id) => {
        if (thread.uri.fsPath === uri.fsPath) {
          thread.dispose();
          this.threads.delete(id);
        }
      });
      for (const stored of data.threads) {
        const comments2 = [
          {
            body: new vscode4.MarkdownString(stored.body),
            author: { name: "You" },
            mode: vscode4.CommentMode.Preview
          },
          ...stored.replies.map((r) => ({
            body: new vscode4.MarkdownString(r),
            author: { name: "You" },
            mode: vscode4.CommentMode.Preview
          }))
        ];
        const thread = this.controller.createCommentThread(
          uri,
          new vscode4.Range(stored.line, 0, stored.line, 0),
          comments2
        );
        thread.canReply = true;
        thread.collapsibleState = vscode4.CommentThreadCollapsibleState.Expanded;
        this.threads.set(stored.id, thread);
      }
    } catch (error) {
      console.error("Failed to load comments:", error);
    }
  }
  saveComments(uri) {
    const commentsPath = this.getCommentsPath(uri);
    if (!commentsPath) return;
    const threads = [];
    this.threads.forEach((thread, id) => {
      if (thread.uri.fsPath !== uri.fsPath) return;
      if (thread.comments.length === 0) return;
      const [first, ...rest] = thread.comments;
      const line = thread.range?.start.line ?? 0;
      const getBodyText = (body) => typeof body === "string" ? body : body.value;
      threads.push({
        id,
        line,
        body: getBodyText(first.body),
        replies: rest.map((c) => getBodyText(c.body))
      });
    });
    const data = { threads };
    try {
      fs2.mkdirSync(path2.dirname(commentsPath), { recursive: true });
      fs2.writeFileSync(commentsPath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error("Failed to save comments:", error);
    }
  }
  dispose() {
    this.commentsWatcher?.dispose();
    this.controller.dispose();
  }
};

// src/extension.ts
function findHiveRoot(startPath) {
  let current = startPath;
  while (current !== path3.dirname(current)) {
    if (fs3.existsSync(path3.join(current, ".hive"))) {
      return current;
    }
    current = path3.dirname(current);
  }
  return null;
}
var HiveExtension = class {
  constructor(context, workspaceFolder) {
    this.context = context;
    this.workspaceFolder = workspaceFolder;
    this.sidebarProvider = null;
    this.launcher = null;
    this.commentController = null;
    this.hiveWatcher = null;
    this.creationWatcher = null;
    this.workspaceRoot = null;
    this.initialized = false;
  }
  initialize() {
    this.workspaceRoot = findHiveRoot(this.workspaceFolder);
    if (this.workspaceRoot) {
      this.initializeWithHive(this.workspaceRoot);
    } else {
      this.initializeWithoutHive();
    }
  }
  initializeWithHive(workspaceRoot) {
    if (this.initialized) return;
    this.initialized = true;
    this.sidebarProvider = new HiveSidebarProvider(workspaceRoot);
    this.launcher = new Launcher(workspaceRoot);
    this.commentController = new PlanCommentController(workspaceRoot);
    vscode5.window.registerTreeDataProvider("hive.features", this.sidebarProvider);
    this.commentController.registerCommands(this.context);
    this.hiveWatcher = new HiveWatcher(workspaceRoot, () => this.sidebarProvider?.refresh());
    this.context.subscriptions.push({ dispose: () => this.hiveWatcher?.dispose() });
    if (this.creationWatcher) {
      this.creationWatcher.dispose();
      this.creationWatcher = null;
    }
  }
  initializeWithoutHive() {
    this.creationWatcher = vscode5.workspace.createFileSystemWatcher(
      new vscode5.RelativePattern(this.workspaceFolder, ".hive/**")
    );
    const onHiveCreated = () => {
      const newRoot = findHiveRoot(this.workspaceFolder);
      if (newRoot && !this.initialized) {
        this.workspaceRoot = newRoot;
        this.initializeWithHive(newRoot);
        vscode5.window.showInformationMessage("Hive: .hive directory detected, extension activated");
      }
    };
    this.creationWatcher.onDidCreate(onHiveCreated);
    this.context.subscriptions.push(this.creationWatcher);
  }
  registerCommands() {
    const workspaceFolder = this.workspaceFolder;
    this.context.subscriptions.push(
      vscode5.commands.registerCommand("hive.refresh", () => {
        if (!this.initialized) {
          const newRoot = findHiveRoot(workspaceFolder);
          if (newRoot) {
            this.workspaceRoot = newRoot;
            this.initializeWithHive(newRoot);
          } else {
            vscode5.window.showWarningMessage("Hive: No .hive directory found. Create a feature with OpenCode first.");
            return;
          }
        }
        this.sidebarProvider?.refresh();
      }),
      vscode5.commands.registerCommand("hive.newFeature", async () => {
        const name = await vscode5.window.showInputBox({
          prompt: "Feature name",
          placeHolder: "my-feature"
        });
        if (name) {
          const terminal = vscode5.window.createTerminal("OpenCode - Hive");
          terminal.sendText(`opencode --command "/hive ${name}"`);
          terminal.show();
        }
      }),
      vscode5.commands.registerCommand("hive.openFeatureInOpenCode", (featureName) => {
        this.launcher?.openFeature("opencode", featureName);
      }),
      vscode5.commands.registerCommand("hive.openTaskInOpenCode", (item) => {
        if (item?.featureName && item?.folder) {
          this.launcher?.openStep("opencode", item.featureName, item.folder);
        }
      }),
      vscode5.commands.registerCommand("hive.openFile", (filePath) => {
        if (filePath) {
          vscode5.workspace.openTextDocument(filePath).then((doc) => vscode5.window.showTextDocument(doc));
        }
      }),
      vscode5.commands.registerCommand("hive.approvePlan", async (item) => {
        if (item?.featureName) {
          const terminal = vscode5.window.createTerminal("OpenCode - Hive");
          terminal.sendText(`opencode --command "hive_plan_approve"`);
          terminal.show();
        }
      }),
      vscode5.commands.registerCommand("hive.syncTasks", async (item) => {
        if (item?.featureName) {
          const terminal = vscode5.window.createTerminal("OpenCode - Hive");
          terminal.sendText(`opencode --command "hive_tasks_sync"`);
          terminal.show();
        }
      }),
      vscode5.commands.registerCommand("hive.startTask", async (item) => {
        if (item?.featureName && item?.folder) {
          const terminal = vscode5.window.createTerminal("OpenCode - Hive");
          terminal.sendText(`opencode --command "hive_exec_start task=${item.folder}"`);
          terminal.show();
        }
      }),
      vscode5.commands.registerCommand("hive.openSession", async (item) => {
        if (item?.session?.sessionId) {
          const terminal = vscode5.window.createTerminal("OpenCode - Hive");
          terminal.sendText(`opencode --session "${item.session.sessionId}"`);
          terminal.show();
        }
      }),
      vscode5.commands.registerCommand("hive.plan.doneReview", async () => {
        const editor = vscode5.window.activeTextEditor;
        if (!editor) return;
        if (!this.workspaceRoot) {
          vscode5.window.showErrorMessage("Hive: No .hive directory found");
          return;
        }
        const filePath = editor.document.uri.fsPath;
        const featureMatch = filePath.match(/\.hive\/features\/([^/]+)\/plan\.md$/);
        if (!featureMatch) {
          vscode5.window.showErrorMessage("Not a plan.md file");
          return;
        }
        const featureName = featureMatch[1];
        const featureJsonPath = path3.join(this.workspaceRoot, ".hive", "features", featureName, "feature.json");
        const commentsPath = path3.join(this.workspaceRoot, ".hive", "features", featureName, "comments.json");
        let sessionId;
        let comments2 = [];
        try {
          const featureData = JSON.parse(fs3.readFileSync(featureJsonPath, "utf-8"));
          sessionId = featureData.sessionId;
        } catch (error) {
          console.warn(`Hive: failed to read sessionId for feature '${featureName}'`, error);
        }
        try {
          const commentsData = JSON.parse(fs3.readFileSync(commentsPath, "utf-8"));
          comments2 = commentsData.threads || [];
        } catch (error) {
          console.warn(`Hive: failed to read comments for feature '${featureName}'`, error);
        }
        const hasComments = comments2.length > 0;
        const inputPrompt = hasComments ? `${comments2.length} comment(s) found. Add feedback or leave empty to submit comments only` : "Enter your review feedback (or leave empty to approve)";
        const userInput = await vscode5.window.showInputBox({
          prompt: inputPrompt,
          placeHolder: hasComments ? "Additional feedback (optional)" : 'e.g., "looks good" to approve, or describe changes needed'
        });
        if (userInput === void 0) return;
        let prompt;
        if (hasComments) {
          const allComments = comments2.map((c) => `Line ${c.line}: ${c.body}`).join("\n");
          if (userInput === "") {
            prompt = `User review comments:
${allComments}`;
          } else {
            prompt = `User review comments:
${allComments}

Additional feedback: ${userInput}`;
          }
        } else {
          if (userInput === "") {
            prompt = "User reviewed the plan and approved. Run hive_plan_approve and then hive_tasks_sync.";
          } else {
            prompt = `User review feedback: "${userInput}"`;
          }
        }
        const shellEscapeSingleQuotes = (value) => {
          return `'${value.replace(/'/g, `'"'"'`)}'`;
        };
        const terminal = vscode5.window.createTerminal("OpenCode - Hive");
        const escapedPrompt = shellEscapeSingleQuotes(prompt);
        if (sessionId) {
          const escapedSessionId = shellEscapeSingleQuotes(sessionId);
          terminal.sendText(`opencode run --session ${escapedSessionId} ${escapedPrompt}`);
        } else {
          terminal.sendText(`opencode run ${escapedPrompt}`);
        }
        terminal.show();
      })
    );
  }
};
function activate(context) {
  const workspaceFolder = vscode5.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) return;
  const extension = new HiveExtension(context, workspaceFolder);
  extension.registerCommands();
  extension.initialize();
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
