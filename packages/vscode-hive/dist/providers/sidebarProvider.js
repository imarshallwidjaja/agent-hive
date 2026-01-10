"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.HiveSidebarProvider = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const STATUS_ICONS = {
    pending: 'circle-outline',
    in_progress: 'sync~spin',
    done: 'pass',
    cancelled: 'circle-slash',
    planning: 'edit',
    approved: 'check',
    executing: 'run-all',
    completed: 'pass-filled',
};
// Status group for organizing features
class StatusGroupItem extends vscode.TreeItem {
    constructor(groupName, groupStatus, features, collapsed = false) {
        super(groupName, collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
        this.groupName = groupName;
        this.groupStatus = groupStatus;
        this.features = features;
        this.description = `${features.length}`;
        this.contextValue = `status-group-${groupStatus}`;
        const icons = {
            in_progress: 'sync~spin',
            pending: 'circle-outline',
            completed: 'pass-filled',
        };
        this.iconPath = new vscode.ThemeIcon(icons[groupStatus] || 'folder');
    }
}
class FeatureItem extends vscode.TreeItem {
    constructor(name, feature, taskStats, isActive) {
        super(name, vscode.TreeItemCollapsibleState.Expanded);
        this.name = name;
        this.feature = feature;
        this.taskStats = taskStats;
        this.isActive = isActive;
        const statusLabel = feature.status.charAt(0).toUpperCase() + feature.status.slice(1);
        this.description = isActive
            ? `${statusLabel} · ${taskStats.done}/${taskStats.total}`
            : `${taskStats.done}/${taskStats.total}`;
        this.contextValue = `feature-${feature.status}`;
        this.iconPath = new vscode.ThemeIcon(STATUS_ICONS[feature.status] || 'package');
        if (isActive) {
            this.resourceUri = vscode.Uri.parse('hive:active');
        }
    }
}
class PlanItem extends vscode.TreeItem {
    constructor(featureName, planPath, featureStatus, commentCount) {
        super('Plan', vscode.TreeItemCollapsibleState.None);
        this.featureName = featureName;
        this.planPath = planPath;
        this.featureStatus = featureStatus;
        this.commentCount = commentCount;
        this.description = commentCount > 0 ? `${commentCount} comment(s)` : '';
        this.contextValue = featureStatus === 'planning' ? 'plan-draft' : 'plan-approved';
        this.iconPath = new vscode.ThemeIcon('file-text');
        this.command = {
            command: 'vscode.open',
            title: 'Open Plan',
            arguments: [vscode.Uri.file(planPath)]
        };
    }
}
class ContextFolderItem extends vscode.TreeItem {
    constructor(featureName, contextPath, fileCount) {
        super('Context', fileCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.featureName = featureName;
        this.contextPath = contextPath;
        this.fileCount = fileCount;
        this.description = fileCount > 0 ? `${fileCount} file(s)` : '';
        this.contextValue = 'context-folder';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}
class ContextFileItem extends vscode.TreeItem {
    constructor(filename, filePath) {
        super(filename, vscode.TreeItemCollapsibleState.None);
        this.filename = filename;
        this.filePath = filePath;
        this.contextValue = 'context-file';
        this.iconPath = new vscode.ThemeIcon(filename.endsWith('.md') ? 'markdown' : 'file');
        this.command = {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [vscode.Uri.file(filePath)]
        };
    }
}
class TasksGroupItem extends vscode.TreeItem {
    constructor(featureName, tasks) {
        super('Tasks', tasks.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        this.featureName = featureName;
        this.tasks = tasks;
        const done = tasks.filter(t => t.status.status === 'done').length;
        this.description = `${done}/${tasks.length}`;
        this.contextValue = 'tasks-group';
        this.iconPath = new vscode.ThemeIcon('checklist');
    }
}
class TaskItem extends vscode.TreeItem {
    constructor(featureName, folder, status, specPath, reportPath) {
        const name = folder.replace(/^\d+-/, '');
        const hasFiles = specPath !== null || reportPath !== null;
        const hasSubtasks = (status.subtasks?.length || 0) > 0;
        const hasChildren = hasFiles || hasSubtasks;
        super(name, hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.featureName = featureName;
        this.folder = folder;
        this.status = status;
        this.specPath = specPath;
        this.reportPath = reportPath;
        const subtaskCount = status.subtasks?.length || 0;
        const subtasksDone = status.subtasks?.filter(s => s.status === 'done').length || 0;
        const subtaskInfo = subtaskCount > 0 ? ` (${subtasksDone}/${subtaskCount})` : '';
        this.description = (status.summary || '') + subtaskInfo;
        this.contextValue = `task-${status.status}${status.origin === 'manual' ? '-manual' : ''}`;
        const iconName = STATUS_ICONS[status.status] || 'circle-outline';
        this.iconPath = new vscode.ThemeIcon(iconName);
        this.tooltip = new vscode.MarkdownString();
        this.tooltip.appendMarkdown(`**${folder}**\n\n`);
        this.tooltip.appendMarkdown(`Status: ${status.status}\n\n`);
        this.tooltip.appendMarkdown(`Origin: ${status.origin}\n\n`);
        if (status.summary) {
            this.tooltip.appendMarkdown(`Summary: ${status.summary}\n\n`);
        }
        if (subtaskCount > 0) {
            this.tooltip.appendMarkdown(`Subtasks: ${subtasksDone}/${subtaskCount} done`);
        }
    }
}
class TaskFileItem extends vscode.TreeItem {
    constructor(filename, filePath) {
        super(filename, vscode.TreeItemCollapsibleState.None);
        this.filename = filename;
        this.filePath = filePath;
        this.contextValue = 'task-file';
        this.iconPath = new vscode.ThemeIcon('markdown');
        this.command = {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [vscode.Uri.file(filePath)]
        };
    }
}
const SUBTASK_TYPE_ICONS = {
    test: 'beaker',
    implement: 'code',
    review: 'eye',
    verify: 'check-all',
    research: 'search',
    debug: 'debug',
    custom: 'circle-outline',
};
class SubtaskItem extends vscode.TreeItem {
    constructor(featureName, taskFolder, subtask, subtaskPath) {
        super(subtask.name, vscode.TreeItemCollapsibleState.None);
        this.featureName = featureName;
        this.taskFolder = taskFolder;
        this.subtask = subtask;
        this.subtaskPath = subtaskPath;
        const typeTag = subtask.type ? ` [${subtask.type}]` : '';
        const targetFile = subtask.status === 'done' ? 'report' : 'spec';
        this.description = `${subtask.id}${typeTag} → ${targetFile}`;
        this.contextValue = `subtask-${subtask.status}`;
        const statusIcon = STATUS_ICONS[subtask.status] || 'circle-outline';
        this.iconPath = new vscode.ThemeIcon(statusIcon);
        const targetFilePath = path.join(subtaskPath, subtask.status === 'done' ? 'report.md' : 'spec.md');
        if (fs.existsSync(targetFilePath)) {
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [vscode.Uri.file(targetFilePath)]
            };
        }
        this.tooltip = new vscode.MarkdownString();
        this.tooltip.appendMarkdown(`**${subtask.name}**\n\n`);
        this.tooltip.appendMarkdown(`ID: ${subtask.id}\n\n`);
        this.tooltip.appendMarkdown(`Status: ${subtask.status}\n\n`);
        if (subtask.type) {
            this.tooltip.appendMarkdown(`Type: ${subtask.type}\n\n`);
        }
        this.tooltip.appendMarkdown(`Click to open: ${targetFile}.md`);
    }
}
class SessionsGroupItem extends vscode.TreeItem {
    constructor(featureName, sessions, master) {
        super('Sessions', sessions.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.featureName = featureName;
        this.sessions = sessions;
        this.master = master;
        this.description = sessions.length > 0 ? `${sessions.length} active` : '';
        this.contextValue = 'sessions-group';
        this.iconPath = new vscode.ThemeIcon('broadcast');
    }
}
class SessionItem extends vscode.TreeItem {
    constructor(featureName, session, isMaster) {
        const label = session.taskFolder || (isMaster ? 'Master' : `Session ${session.sessionId.slice(4, 12)}`);
        super(label, vscode.TreeItemCollapsibleState.None);
        this.featureName = featureName;
        this.session = session;
        this.isMaster = isMaster;
        const shortId = session.sessionId.slice(0, 8);
        this.description = isMaster ? `★ ${shortId}` : shortId;
        this.contextValue = 'session';
        this.iconPath = new vscode.ThemeIcon(isMaster ? 'star-full' : 'terminal');
        this.tooltip = new vscode.MarkdownString();
        this.tooltip.appendMarkdown(`**Session**: ${session.sessionId}\n\n`);
        if (session.taskFolder) {
            this.tooltip.appendMarkdown(`**Task**: ${session.taskFolder}\n\n`);
        }
        this.tooltip.appendMarkdown(`**Started**: ${session.startedAt}\n\n`);
        this.tooltip.appendMarkdown(`**Last Active**: ${session.lastActiveAt}`);
    }
}
class HiveSidebarProvider {
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() {
        this._onDidChangeTreeData.fire(undefined);
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
        // Group features by status category
        const inProgress = [];
        const pending = [];
        const completed = [];
        for (const feature of features) {
            if (feature.feature.status === 'executing') {
                inProgress.push(feature);
            }
            else if (feature.feature.status === 'planning' || feature.feature.status === 'approved') {
                pending.push(feature);
            }
            else if (feature.feature.status === 'completed') {
                completed.push(feature);
            }
        }
        const groups = [];
        if (inProgress.length > 0) {
            groups.push(new StatusGroupItem('In Progress', 'in_progress', inProgress, false));
        }
        if (pending.length > 0) {
            groups.push(new StatusGroupItem('Pending', 'pending', pending, false));
        }
        if (completed.length > 0) {
            groups.push(new StatusGroupItem('Completed', 'completed', completed, true));
        }
        return groups;
    }
    getAllFeatures() {
        const featuresPath = path.join(this.workspaceRoot, '.hive', 'features');
        if (!fs.existsSync(featuresPath))
            return [];
        const activeFeature = this.getActiveFeature();
        const features = [];
        const dirs = fs.readdirSync(featuresPath, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
        for (const name of dirs) {
            const featureJsonPath = path.join(featuresPath, name, 'feature.json');
            if (!fs.existsSync(featureJsonPath))
                continue;
            const feature = JSON.parse(fs.readFileSync(featureJsonPath, 'utf-8'));
            const taskStats = this.getTaskStats(name);
            const isActive = name === activeFeature;
            features.push(new FeatureItem(name, feature, taskStats, isActive));
        }
        // Sort by active first, then by creation date
        features.sort((a, b) => {
            if (a.isActive)
                return -1;
            if (b.isActive)
                return 1;
            return 0;
        });
        return features;
    }
    getFeatureChildren(featureName) {
        const featurePath = path.join(this.workspaceRoot, '.hive', 'features', featureName);
        const items = [];
        const featureJsonPath = path.join(featurePath, 'feature.json');
        const feature = JSON.parse(fs.readFileSync(featureJsonPath, 'utf-8'));
        const planPath = path.join(featurePath, 'plan.md');
        if (fs.existsSync(planPath)) {
            const commentCount = this.getCommentCount(featureName);
            items.push(new PlanItem(featureName, planPath, feature.status, commentCount));
        }
        const contextPath = path.join(featurePath, 'context');
        const contextFiles = fs.existsSync(contextPath)
            ? fs.readdirSync(contextPath).filter(f => !f.startsWith('.'))
            : [];
        items.push(new ContextFolderItem(featureName, contextPath, contextFiles.length));
        const tasks = this.getTaskList(featureName);
        items.push(new TasksGroupItem(featureName, tasks));
        const sessionsData = this.getSessionsData(featureName);
        items.push(new SessionsGroupItem(featureName, sessionsData.sessions, sessionsData.master));
        return items;
    }
    getContextFiles(featureName, contextPath) {
        if (!fs.existsSync(contextPath))
            return [];
        return fs.readdirSync(contextPath)
            .filter(f => !f.startsWith('.'))
            .map(f => new ContextFileItem(f, path.join(contextPath, f)));
    }
    getTasks(featureName, tasks) {
        const featurePath = path.join(this.workspaceRoot, '.hive', 'features', featureName);
        return tasks.map(t => {
            const taskDir = path.join(featurePath, 'tasks', t.folder);
            const specPath = path.join(taskDir, 'spec.md');
            const reportPath = path.join(taskDir, 'report.md');
            const hasSpec = fs.existsSync(specPath);
            const hasReport = fs.existsSync(reportPath);
            return new TaskItem(featureName, t.folder, t.status, hasSpec ? specPath : null, hasReport ? reportPath : null);
        });
    }
    getTaskFiles(taskItem) {
        const items = [];
        if (taskItem.specPath) {
            items.push(new TaskFileItem('spec.md', taskItem.specPath));
        }
        if (taskItem.reportPath) {
            items.push(new TaskFileItem('report.md', taskItem.reportPath));
        }
        const subtasks = this.getSubtasksFromFolders(taskItem.featureName, taskItem.folder);
        for (const subtask of subtasks) {
            const subtaskPath = path.join(this.workspaceRoot, '.hive', 'features', taskItem.featureName, 'tasks', taskItem.folder, 'subtasks', subtask.folder);
            items.push(new SubtaskItem(taskItem.featureName, taskItem.folder, subtask, subtaskPath));
        }
        return items;
    }
    getSubtasksFromFolders(featureName, taskFolder) {
        const subtasksPath = path.join(this.workspaceRoot, '.hive', 'features', featureName, 'tasks', taskFolder, 'subtasks');
        if (!fs.existsSync(subtasksPath))
            return [];
        const taskOrder = parseInt(taskFolder.split('-')[0], 10);
        const folders = fs.readdirSync(subtasksPath, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort();
        return folders.map(folder => {
            const statusPath = path.join(subtasksPath, folder, 'status.json');
            const subtaskOrder = parseInt(folder.split('-')[0], 10);
            const name = folder.replace(/^\d+-/, '');
            let status = { status: 'pending' };
            if (fs.existsSync(statusPath)) {
                try {
                    status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
                }
                catch { }
            }
            return {
                id: `${taskOrder}.${subtaskOrder}`,
                name,
                folder,
                status: status.status || 'pending',
                type: status.type,
                createdAt: status.createdAt,
                completedAt: status.completedAt,
            };
        });
    }
    getTaskList(featureName) {
        const tasksPath = path.join(this.workspaceRoot, '.hive', 'features', featureName, 'tasks');
        if (!fs.existsSync(tasksPath))
            return [];
        const folders = fs.readdirSync(tasksPath, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort();
        return folders.map(folder => {
            const statusPath = path.join(tasksPath, folder, 'status.json');
            const status = fs.existsSync(statusPath)
                ? JSON.parse(fs.readFileSync(statusPath, 'utf-8'))
                : { status: 'pending', origin: 'plan' };
            return { folder, status };
        });
    }
    getTaskStats(featureName) {
        const tasks = this.getTaskList(featureName);
        return {
            total: tasks.length,
            done: tasks.filter(t => t.status.status === 'done').length
        };
    }
    getActiveFeature() {
        const activePath = path.join(this.workspaceRoot, '.hive', 'active-feature');
        if (!fs.existsSync(activePath))
            return null;
        return fs.readFileSync(activePath, 'utf-8').trim();
    }
    getCommentCount(featureName) {
        const commentsPath = path.join(this.workspaceRoot, '.hive', 'features', featureName, 'comments.json');
        if (!fs.existsSync(commentsPath))
            return 0;
        try {
            const data = JSON.parse(fs.readFileSync(commentsPath, 'utf-8'));
            return data.threads?.length || 0;
        }
        catch {
            return 0;
        }
    }
    getSessionsData(featureName) {
        const sessionsPath = path.join(this.workspaceRoot, '.hive', 'features', featureName, 'sessions.json');
        if (!fs.existsSync(sessionsPath))
            return { sessions: [] };
        try {
            return JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));
        }
        catch {
            return { sessions: [] };
        }
    }
    getSessions(featureName, sessions, master) {
        return sessions.map(s => new SessionItem(featureName, s, s.sessionId === master));
    }
}
exports.HiveSidebarProvider = HiveSidebarProvider;
//# sourceMappingURL=sidebarProvider.js.map