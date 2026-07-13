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
    && !path.isAbsolute(entry.path)
    && !entry.path.split(/[\\/]/).includes('..')
    && path.normalize(entry.path) !== '..'
    && !path.normalize(entry.path).startsWith(`..${path.sep}`);
}
