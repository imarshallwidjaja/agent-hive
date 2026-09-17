import * as fs from 'fs/promises';
import * as path from 'path';
import { writeJsonAtomicDurable } from '../utils/paths.js';

export interface WorkspaceManifestEntry {
  path: string;
  repoRoot: string;
  repoPath: string;
  branch: string;
  commit: string;
}

interface WorkspaceManifestBase {
  schemaVersion: 1;
  repos: Record<string, WorkspaceManifestEntry>;
  baseCommits: Record<string, string>;
  createdAt?: string;
}

export interface TaskWorkspaceManifest extends WorkspaceManifestBase {
  mode: 'composite';
  feature: string;
  task: string;
}

export interface AdhocWorkspaceManifest extends WorkspaceManifestBase {
  mode: 'adhoc-composite';
  runId: string;
}

export interface ReviewWorkspaceManifest extends WorkspaceManifestBase {
  mode: 'review-composite';
  runId: string;
}

export type CompositeWorkspaceManifest = TaskWorkspaceManifest | AdhocWorkspaceManifest | ReviewWorkspaceManifest;

export interface SingleWorkspaceMetadata {
  schemaVersion: 1;
  mode: 'single' | 'adhoc-single';
  worktreePath: string;
  repositoryPath: string;
  branch: string;
  baseCommit: string;
  createdAt?: string;
  feature?: string;
  task?: string;
  runId?: string;
}

const SAFE_REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSafeRepositoryId(id: string): boolean {
  return SAFE_REPOSITORY_ID.test(id)
    && id !== '.'
    && id !== '..'
    && !id.includes('..');
}

function assertValidManifestEntries(manifestPath: string, manifest: Partial<CompositeWorkspaceManifest>): void {
  if (!isRecord(manifest.repos) || !isRecord(manifest.baseCommits)) {
    throw new Error(`Invalid composite workspace manifest: ${manifestPath}`);
  }

  const entries = Object.entries(manifest.repos);
  if (entries.length === 0) {
    throw new Error(`Invalid composite workspace manifest: ${manifestPath}`);
  }

  for (const [id, value] of entries) {
    if (!isSafeRepositoryId(id) || !isRecord(value)) {
      throw new Error(`Invalid composite workspace manifest: ${manifestPath}`);
    }
    const entry = value as Partial<WorkspaceManifestEntry>;
    if (
      entry.path !== path.posix.join('repos', id)
      || typeof entry.repoRoot !== 'string'
      || typeof entry.repoPath !== 'string'
      || typeof entry.branch !== 'string'
      || typeof entry.commit !== 'string'
      || typeof manifest.baseCommits[id] !== 'string'
    ) {
      throw new Error(`Invalid composite workspace manifest: ${manifestPath}`);
    }
  }
}

export function parseCompositeWorkspaceManifest(value: unknown, manifestPath: string): CompositeWorkspaceManifest {
  if (!isRecord(value)) {
    throw new Error(`Invalid composite workspace manifest: ${manifestPath}`);
  }
  const manifest = value as Partial<CompositeWorkspaceManifest>;
  if (
    manifest.schemaVersion !== 1
    || (manifest.mode !== 'composite' && manifest.mode !== 'adhoc-composite' && manifest.mode !== 'review-composite')
  ) {
    throw new Error(`Invalid composite workspace manifest: ${manifestPath}`);
  }
  assertValidManifestEntries(manifestPath, manifest);
  return manifest as CompositeWorkspaceManifest;
}

export async function readCompositeWorkspaceManifest(workspaceRoot: string): Promise<CompositeWorkspaceManifest | null> {
  const manifestPath = path.join(workspaceRoot, 'workspace.json');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    return parseCompositeWorkspaceManifest(JSON.parse(raw), manifestPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in composite workspace manifest ${manifestPath}: ${error.message}`);
    }
    throw error;
  }
}

export async function readSingleWorkspaceMetadata(metadataPath: string): Promise<SingleWorkspaceMetadata | null> {
  let raw: string;
  try {
    raw = await fs.readFile(metadataPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: Partial<SingleWorkspaceMetadata>;
  try {
    value = JSON.parse(raw) as Partial<SingleWorkspaceMetadata>;
  } catch (error) {
    throw new Error(`Invalid JSON in single workspace metadata ${metadataPath}: ${(error as Error).message}`);
  }
  if (
    value.schemaVersion !== 1
    || (value.mode !== 'single' && value.mode !== 'adhoc-single')
    || typeof value.worktreePath !== 'string'
    || typeof value.repositoryPath !== 'string'
    || typeof value.branch !== 'string'
    || typeof value.baseCommit !== 'string'
  ) {
    throw new Error(`Invalid single workspace metadata: ${metadataPath}`);
  }
  return value as SingleWorkspaceMetadata;
}

export async function writeWorkspaceJsonAtomic(filePath: string, value: unknown): Promise<void> {
  try {
    const finalStat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (finalStat?.isSymbolicLink()) {
      throw new Error(`Refusing to replace workspace metadata symlink: ${filePath}`);
    }
    writeJsonAtomicDurable(filePath, value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write workspace metadata at ${filePath}: ${message}`, { cause: error });
  }
}
