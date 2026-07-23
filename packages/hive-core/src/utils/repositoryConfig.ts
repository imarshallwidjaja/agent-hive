import * as fs from 'fs';
import * as path from 'path';
import type { RepositoryConfig } from '../types.js';
import { isValidRepositoryId } from './repositoryIds.js';

export function canonicalProjectRoot(projectRoot: string): string {
  return fs.realpathSync(path.resolve(projectRoot));
}

export function projectRootsMatch(left: string, right: string): boolean {
  try {
    return canonicalProjectRoot(left) === canonicalProjectRoot(right);
  } catch {
    return false;
  }
}

export function assertRepositoryManifestContained(projectRoot: string, manifestPath: string): void {
  const canonicalRoot = canonicalProjectRoot(projectRoot);
  const fail = (): never => {
    throw new Error(`Repository manifest path must stay inside project root: ${manifestPath}`);
  };
  const assertContained = (candidate: string): void => {
    if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}${path.sep}`)) fail();
  };
  const parent = path.dirname(manifestPath);

  try {
    fs.lstatSync(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    fail();
  }

  let canonicalParent: string;
  try {
    canonicalParent = fs.realpathSync(parent);
  } catch {
    fail();
  }
  assertContained(canonicalParent);

  try {
    fs.lstatSync(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    fail();
  }

  let canonicalManifest: string;
  try {
    canonicalManifest = fs.realpathSync(manifestPath);
  } catch {
    fail();
  }
  assertContained(canonicalManifest);
}

export function isValidRepositoryConfig(value: unknown): value is RepositoryConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry);
  return keys.length === 2
    && keys.includes('id')
    && keys.includes('path')
    && typeof entry.id === 'string'
    && isValidRepositoryId(entry.id)
    && typeof entry.path === 'string'
    && entry.path.trim().length > 0
    && !path.posix.isAbsolute(entry.path)
    && !path.win32.isAbsolute(entry.path)
    && !entry.path.split(/[\\/]/).includes('..')
    && path.normalize(entry.path) !== '..'
    && !path.normalize(entry.path).startsWith(`..${path.sep}`);
}

export interface ProjectRepositoryManifest {
  schemaVersion: 1;
  repositories: RepositoryConfig[];
}

export function parseProjectRepositoryManifest(value: unknown): ProjectRepositoryManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('manifest must be an object');
  }
  const manifest = value as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  if (keys.length !== 2 || keys[0] !== 'repositories' || keys[1] !== 'schemaVersion') {
    throw new Error('manifest must contain exactly schemaVersion and repositories');
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error('schemaVersion must equal 1');
  }
  if (!Array.isArray(manifest.repositories) || manifest.repositories.length === 0 || !manifest.repositories.every(isValidRepositoryConfig)) {
    throw new Error('repositories must be a non-empty array of repository entries');
  }
  return manifest as unknown as ProjectRepositoryManifest;
}
