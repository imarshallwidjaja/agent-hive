import * as fs from 'fs';
import {
  getSubtasksPath,
  getSubtaskPath,
  getSubtaskStatusPath,
  getSubtaskSpecPath,
  getSubtaskReportPath,
  getTaskStatusPath,
  acquireLockSync,
  ensureDir,
  readJson,
  writeJson,
  readText,
  writeText,
  fileExists,
  resolveExistingFeaturePath,
} from '../utils/paths.js';
import { Subtask, SubtaskType, SubtaskStatus, TaskStatusType } from '../types.js';

export class SubtaskService {
  constructor(private projectRoot: string) {}

  create(featureName: string, taskFolder: string, name: string, type?: SubtaskType): Subtask {
    return this.createWithFolderSlug(featureName, taskFolder, name, type, this.slugify(name));
  }

  /**
   * Create a subtask whose folder is `<order>-<folderSlug>`, for callers with their own slug rules. The feature and
   * task must exist before anything is written. The order is one past the highest existing numeric prefix, allocated
   * under the task's status lock, so a deleted subtask's number is never reused and concurrent creations differ.
   */
  createWithFolderSlug(featureName: string, taskFolder: string, name: string, type: SubtaskType | undefined, folderSlug: string): Subtask {
    resolveExistingFeaturePath(this.projectRoot, featureName);
    const taskStatusPath = getTaskStatusPath(this.projectRoot, featureName, taskFolder);
    // Checked before the lock, whose acquisition would create the missing task directory.
    if (!fileExists(taskStatusPath)) {
      throw new Error(`Task '${taskFolder}' not found`);
    }
    const release = acquireLockSync(taskStatusPath, { staleLockTTL: Number.POSITIVE_INFINITY });
    try {
      if (!fileExists(taskStatusPath)) {
        throw new Error(`Task '${taskFolder}' not found`);
      }
      ensureDir(getSubtasksPath(this.projectRoot, featureName, taskFolder));

      const taskOrder = parseInt(taskFolder.split('-')[0], 10);
      const nextOrder = this.listFolders(featureName, taskFolder)
        .map((folder) => parseInt(folder, 10))
        .filter((order) => !Number.isNaN(order))
        .reduce((max, order) => Math.max(max, order), 0) + 1;
      const subtaskId = `${taskOrder}.${nextOrder}`;
      const folderName = `${nextOrder}-${folderSlug}`;
      fs.mkdirSync(getSubtaskPath(this.projectRoot, featureName, taskFolder, folderName));

      const subtaskStatus: SubtaskStatus = {
        status: 'pending',
        type,
        createdAt: new Date().toISOString(),
      };
      writeJson(getSubtaskStatusPath(this.projectRoot, featureName, taskFolder, folderName), subtaskStatus);

      const specContent = `# Subtask: ${name}\n\n**Type:** ${type || 'custom'}\n**ID:** ${subtaskId}\n\n## Instructions\n\n_Add detailed instructions here_\n`;
      writeText(getSubtaskSpecPath(this.projectRoot, featureName, taskFolder, folderName), specContent);

      return {
        id: subtaskId,
        name,
        folder: folderName,
        status: 'pending',
        type,
        createdAt: subtaskStatus.createdAt,
      };
    } finally {
      release();
    }
  }

  update(featureName: string, taskFolder: string, subtaskId: string, status: TaskStatusType): Subtask {
    const subtaskFolder = this.findFolderForWrite(featureName, taskFolder, subtaskId);
    if (!subtaskFolder) {
      throw new Error(`Subtask '${subtaskId}' not found in task '${taskFolder}'`);
    }

    const statusPath = getSubtaskStatusPath(this.projectRoot, featureName, taskFolder, subtaskFolder);
    const current = readJson<SubtaskStatus>(statusPath);
    if (!current) {
      throw new Error(`Subtask status not found for '${subtaskId}'`);
    }

    const updated: SubtaskStatus = { ...current, status };
    if (status === 'done' && !current.completedAt) {
      updated.completedAt = new Date().toISOString();
    }

    writeJson(statusPath, updated);

    const name = subtaskFolder.replace(/^\d+-/, '');
    return {
      id: subtaskId,
      name,
      folder: subtaskFolder,
      status,
      type: current.type,
      createdAt: current.createdAt,
      completedAt: updated.completedAt,
    };
  }

  list(featureName: string, taskFolder: string): Subtask[] {
    const folders = this.listFolders(featureName, taskFolder);
    const taskOrder = parseInt(taskFolder.split('-')[0], 10);

    return folders.map((folder, index) => {
      const statusPath = getSubtaskStatusPath(this.projectRoot, featureName, taskFolder, folder);
      const status = readJson<SubtaskStatus>(statusPath);
      const name = folder.replace(/^\d+-/, '');
      const subtaskOrder = parseInt(folder.split('-')[0], 10) || (index + 1);

      return {
        id: `${taskOrder}.${subtaskOrder}`,
        name,
        folder,
        status: status?.status || 'pending',
        type: status?.type,
        createdAt: status?.createdAt,
        completedAt: status?.completedAt,
      };
    });
  }

  get(featureName: string, taskFolder: string, subtaskId: string): Subtask | null {
    const subtaskFolder = this.findFolder(featureName, taskFolder, subtaskId);
    if (!subtaskFolder) return null;

    const statusPath = getSubtaskStatusPath(this.projectRoot, featureName, taskFolder, subtaskFolder);
    const status = readJson<SubtaskStatus>(statusPath);
    if (!status) return null;

    const taskOrder = parseInt(taskFolder.split('-')[0], 10);
    const subtaskOrder = parseInt(subtaskFolder.split('-')[0], 10);
    const name = subtaskFolder.replace(/^\d+-/, '');

    return {
      id: `${taskOrder}.${subtaskOrder}`,
      name,
      folder: subtaskFolder,
      status: status.status,
      type: status.type,
      createdAt: status.createdAt,
      completedAt: status.completedAt,
    };
  }

  writeSpec(featureName: string, taskFolder: string, subtaskId: string, content: string): string {
    const subtaskFolder = this.findFolderForWrite(featureName, taskFolder, subtaskId);
    if (!subtaskFolder) {
      throw new Error(`Subtask '${subtaskId}' not found in task '${taskFolder}'`);
    }

    const specPath = getSubtaskSpecPath(this.projectRoot, featureName, taskFolder, subtaskFolder);
    writeText(specPath, content);
    return specPath;
  }

  writeReport(featureName: string, taskFolder: string, subtaskId: string, content: string): string {
    const subtaskFolder = this.findFolderForWrite(featureName, taskFolder, subtaskId);
    if (!subtaskFolder) {
      throw new Error(`Subtask '${subtaskId}' not found in task '${taskFolder}'`);
    }

    const reportPath = getSubtaskReportPath(this.projectRoot, featureName, taskFolder, subtaskFolder);
    writeText(reportPath, content);
    return reportPath;
  }

  readSpec(featureName: string, taskFolder: string, subtaskId: string): string | null {
    const subtaskFolder = this.findFolder(featureName, taskFolder, subtaskId);
    if (!subtaskFolder) return null;

    const specPath = getSubtaskSpecPath(this.projectRoot, featureName, taskFolder, subtaskFolder);
    return readText(specPath);
  }

  readReport(featureName: string, taskFolder: string, subtaskId: string): string | null {
    const subtaskFolder = this.findFolder(featureName, taskFolder, subtaskId);
    if (!subtaskFolder) return null;

    const reportPath = getSubtaskReportPath(this.projectRoot, featureName, taskFolder, subtaskFolder);
    return readText(reportPath);
  }

  delete(featureName: string, taskFolder: string, subtaskId: string): void {
    const subtaskFolder = this.findFolderForWrite(featureName, taskFolder, subtaskId);
    if (!subtaskFolder) {
      throw new Error(`Subtask '${subtaskId}' not found in task '${taskFolder}'`);
    }

    const subtaskPath = getSubtaskPath(this.projectRoot, featureName, taskFolder, subtaskFolder);
    if (fileExists(subtaskPath)) {
      fs.rmSync(subtaskPath, { recursive: true });
    }
  }

  private listFolders(featureName: string, taskFolder: string): string[] {
    const subtasksPath = getSubtasksPath(this.projectRoot, featureName, taskFolder);
    if (!fileExists(subtasksPath)) return [];

    return fs.readdirSync(subtasksPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  }

  /**
   * The subtask folder a mutation writes, found only after the feature resolves: an unknown, ambiguous or unreadable
   * feature name throws `FeatureResolutionError` before any write, and the folder lies in the resolved feature.
   */
  private findFolderForWrite(featureName: string, taskFolder: string, subtaskId: string): string | null {
    resolveExistingFeaturePath(this.projectRoot, featureName);
    return this.findFolder(featureName, taskFolder, subtaskId);
  }

  private findFolder(featureName: string, taskFolder: string, subtaskId: string): string | null {
    const folders = this.listFolders(featureName, taskFolder);
    const subtaskOrder = subtaskId.split('.')[1];
    return folders.find(f => f.startsWith(`${subtaskOrder}-`)) || null;
  }

  private slugify(name: string): string {
    return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }
}
