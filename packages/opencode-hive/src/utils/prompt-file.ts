/**
 * Prompt file utilities for preventing tool output truncation.
 * 
 * Instead of inlining large prompts in tool outputs, we write them to files
 * and pass file references. This keeps tool output sizes bounded while
 * preserving full prompt content for workers.
 * 
 * Security: All file operations are restricted to workspace/.hive paths.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizePath, resolveFeatureDirectoryName } from 'hive-core';

/**
 * Result of resolving prompt content from a file.
 */
export interface PromptFileResult {
  /** The prompt content if successfully read */
  content?: string;
  /** Error message if reading failed */
  error?: string;
}

/**
 * Find the workspace root by walking up from a start directory.
 *
 * The workspace root is identified as the directory that contains a .hive folder.
 * Returns null if no .hive directory is found.
 */
export function findWorkspaceRoot(startDir: string): string | null {
  try {
    let current = path.resolve(startDir);
    while (true) {
      const hivePath = path.join(current, '.hive');
      if (fs.existsSync(hivePath) && fs.statSync(hivePath).isDirectory()) {
        return current;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  } catch {
    return null;
  }
}

/**
 * Check if a file path is valid for prompt file operations.
 * 
 * Security: Only allows paths within the workspace directory.
 * Rejects path traversal attempts (../).
 * 
 * @param filePath - The path to validate
 * @param workspaceRoot - The workspace root directory
 * @returns true if the path is valid and safe
 */
export function isValidPromptFilePath(filePath: string, workspaceRoot: string): boolean {
  try {
    // Normalize both paths to resolve any .. or . segments
    const normalizedFilePath = path.resolve(filePath);
    const normalizedWorkspace = path.resolve(workspaceRoot);
    let normalizedFilePathForCompare = normalizePath(normalizedFilePath);
    let normalizedWorkspaceForCompare = normalizePath(normalizedWorkspace);

    if (process.platform === 'win32') {
      normalizedFilePathForCompare = normalizedFilePathForCompare.toLowerCase();
      normalizedWorkspaceForCompare = normalizedWorkspaceForCompare.toLowerCase();
    }

    // Check that the file path starts with the workspace root
    // This prevents path traversal attacks
    if (!normalizedFilePathForCompare.startsWith(normalizedWorkspaceForCompare + '/') &&
        normalizedFilePathForCompare !== normalizedWorkspaceForCompare) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve prompt content from a file.
 * 
 * Security: Validates that the file path is within the workspace.
 * 
 * @param promptFilePath - Path to the prompt file
 * @param workspaceRoot - The workspace root directory for security validation
 * @returns The prompt content or an error
 */
export async function resolvePromptFromFile(
  promptFilePath: string,
  workspaceRoot: string
): Promise<PromptFileResult> {
  // Security check: ensure path is within workspace
  if (!isValidPromptFilePath(promptFilePath, workspaceRoot)) {
    return {
      error: `Prompt file path "${promptFilePath}" is outside the workspace. ` +
             `Only files within "${workspaceRoot}" are allowed.`,
    };
  }

  // Check if file exists
  const resolvedPath = path.resolve(promptFilePath);
  if (!fs.existsSync(resolvedPath)) {
    return {
      error: `Prompt file not found: "${resolvedPath}"`,
    };
  }

  // Read file content
  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    return { content };
  } catch (err) {
    return {
      error: `Failed to read prompt file: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

export interface PublishedWorkerAssignment {
  format: 'hive-worker-assignment/v1';
  path: string;
  locator: string;
  contentHash: string;
}

export function publishWorkerAssignment(
  feature: string,
  task: string,
  attempt: number,
  assignment: string,
  hiveDir: string,
  hooks: { beforePublish?: () => void } = {},
): PublishedWorkerAssignment {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Worker assignment attempt must be a positive integer.');
  const projectRoot = path.dirname(hiveDir);
  const featureDir = resolveFeatureDirectoryName(projectRoot, feature);
  const taskDir = path.join(hiveDir, 'features', featureDir, 'tasks', task);
  const assignmentsDir = path.join(taskDir, 'assignments');
  const assignmentPath = path.join(assignmentsDir, `attempt-${attempt}.md`);
  fs.mkdirSync(assignmentsDir, { recursive: true });
  const temporaryPath = path.join(assignmentsDir, `.attempt-${attempt}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    const descriptor = fs.openSync(temporaryPath, 'wx');
    temporaryCreated = true;
    try {
      fs.writeFileSync(descriptor, assignment, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    hooks.beforePublish?.();
    try {
      fs.linkSync(temporaryPath, assignmentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Worker assignment attempt ${attempt} already exists and cannot be overwritten.`);
      }
      throw error;
    }
  } finally {
    if (temporaryCreated) fs.rmSync(temporaryPath, { force: true });
  }

  const locator = normalizePath(path.relative(projectRoot, assignmentPath));
  const navigationPath = path.join(taskDir, 'worker-prompt.md');
  const navigationTemporary = `${navigationPath}.${randomUUID()}.tmp`;
  fs.writeFileSync(navigationTemporary, `Latest immutable assignment: @${locator}\n`, 'utf8');
  fs.renameSync(navigationTemporary, navigationPath);
  return {
    format: 'hive-worker-assignment/v1',
    path: assignmentPath,
    locator,
    contentHash: createHash('sha256').update(Buffer.from(assignment, 'utf8')).digest('hex'),
  };
}
