import * as fs from 'fs/promises';
import * as path from 'path';

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
  createdAt: string;
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

  return parseCompositeWorkspaceManifest(JSON.parse(raw), manifestPath);
}
