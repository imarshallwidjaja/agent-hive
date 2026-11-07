import * as path from 'path';
import * as fs from 'fs';
import { getFeaturesPath, getFeaturePath, listFeatureDirectories, readJson, normalizePath } from './paths.js';
import type { FeatureJson } from '../types.js';
import { isValidRepositoryId } from './repositoryIds.js';

function toLogicalFeatureName(featureName: string): string {
  const match = featureName.match(/^\d+[_-](.+)$/);
  return match ? match[1] : featureName;
}

export interface DetectionResult {
  projectRoot: string;
  feature: string | null;
  task: string | null;
  isWorktree: boolean;
  mainProjectRoot: string | null;
}

export function detectContext(cwd: string): DetectionResult {
  const result: DetectionResult = {
    projectRoot: cwd,
    feature: null,
    task: null,
    isWorktree: false,
    mainProjectRoot: null,
  };

  const normalizedCwd = normalizePath(cwd);
  // A retained checkout `.hive/checkouts/<repoId>/<slug>` belongs to the project that holds it; it names no feature
  // or task. The first such segment wins, so tracked content inside a checkout cannot move the project root.
  const checkoutMatch = normalizedCwd.match(/^(.+?)\/\.hive\/checkouts\/([^/]+)\/([^/]+)(?:\/|$)/);
  const worktreeIndex = normalizedCwd.indexOf('/.hive/.worktrees/');
  if (checkoutMatch && isValidRepositoryId(checkoutMatch[2]) && isValidRepositoryId(checkoutMatch[3])
    && (worktreeIndex === -1 || checkoutMatch[1].length < worktreeIndex)) {
    result.mainProjectRoot = checkoutMatch[1];
    result.isWorktree = true;
    result.projectRoot = checkoutMatch[1];
    return result;
  }

  const worktreeMatch = normalizedCwd.match(/(.+)\/\.hive\/\.worktrees\/([^/]+)\/([^/]+)/);
  if (worktreeMatch) {
    result.mainProjectRoot = worktreeMatch[1];
    result.feature = toLogicalFeatureName(worktreeMatch[2]);
    result.task = worktreeMatch[3];
    result.isWorktree = true;
    result.projectRoot = worktreeMatch[1];
    return result;
  }

  const gitPath = path.join(cwd, '.git');
  if (fs.existsSync(gitPath)) {
    const stat = fs.statSync(gitPath);
    if (stat.isFile()) {
      const gitContent = fs.readFileSync(gitPath, 'utf-8').trim();
      const gitdirMatch = gitContent.match(/gitdir:\s*(.+)/);
      if (gitdirMatch) {
        const gitdir = gitdirMatch[1];
        const normalizedGitdir = normalizePath(gitdir);
        const worktreePathMatch = normalizedGitdir.match(/(.+)\/\.git\/worktrees\/(.+)/);
        if (worktreePathMatch) {
          const mainRepo = worktreePathMatch[1];
          const cwdWorktreeMatch = normalizedCwd.match(/\.hive\/\.worktrees\/([^/]+)\/([^/]+)/);
          if (cwdWorktreeMatch) {
            result.mainProjectRoot = mainRepo;
            result.feature = toLogicalFeatureName(cwdWorktreeMatch[1]);
            result.task = cwdWorktreeMatch[2];
            result.isWorktree = true;
            result.projectRoot = mainRepo;
            return result;
          }
        }
      }
    }
  }

  return result;
}

export function listFeatures(projectRoot: string): string[] {
  const featuresPath = getFeaturesPath(projectRoot);
  if (!fs.existsSync(featuresPath)) return [];

  return listFeatureDirectories(projectRoot)
    .map((feature) => feature.logicalName)
    .sort((left, right) => left.localeCompare(right));
}

export function getFeatureData(projectRoot: string, featureName: string): FeatureJson | null {
  const featurePath = getFeaturePath(projectRoot, featureName);
  const featureJsonPath = path.join(featurePath, 'feature.json');
  return readJson<FeatureJson>(featureJsonPath);
}

export function findProjectRoot(startDir: string): string | null {
  let current = startDir;
  const root = path.parse(current).root;

  while (current !== root) {
    if (fs.existsSync(path.join(current, '.hive'))) {
      return current;
    }
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    current = path.dirname(current);
  }

  return null;
}
