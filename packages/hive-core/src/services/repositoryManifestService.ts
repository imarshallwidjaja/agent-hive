import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { RepositoryConfig } from '../types.js';
import { writeAtomic } from '../utils/paths.js';
import { isValidRepositoryId } from '../utils/repositoryIds.js';

export type RepositoryManifestMode = 'manifest' | 'legacy-root' | 'missing-manifest';

export interface RepositoryManifestEntry extends RepositoryConfig {
  root?: string;
}

export interface RepositoryManifestStatus {
  mode: RepositoryManifestMode;
  configPath: string;
  repositories: RepositoryManifestEntry[];
  error?: string;
}

export interface RepositoryDiscoveryCandidate extends RepositoryConfig {
  root: string;
}

export interface RepositoryDiscoveryResult {
  projectRoot: string;
  maxDepth: number;
  maxCandidates: number;
  truncated: boolean;
  candidates: RepositoryDiscoveryCandidate[];
}

export interface RepositoryManifestUpdateResult {
  configPath: string;
  added: string[];
  skipped: string[];
  repositories: RepositoryManifestEntry[];
}

const DISCOVERY_MAX_DEPTH = 4;
const DISCOVERY_MAX_CANDIDATES = 50;
const EXCLUDED_DIRS = new Set([
  '.git',
  '.hive',
  '.opencode',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'tmp',
  'temp',
]);

export class RepositoryManifestService {
  private readonly configPath: string;

  constructor(private readonly projectRoot: string) {
    this.configPath = path.join(projectRoot, '.hive', 'agent-hive.json');
  }

  getStatus(): RepositoryManifestStatus {
    const stored = this.readProjectConfig();
    if (Array.isArray(stored.config.repositories)) {
      try {
        return {
          mode: 'manifest',
          configPath: stored.path,
          repositories: this.resolveManifestEntries(stored.config.repositories),
        };
      } catch (error) {
        return {
          mode: 'manifest',
          configPath: stored.path,
          repositories: stored.config.repositories.map((repository) => ({ ...repository })),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const gitRoot = this.readGitRoot(this.projectRoot);
    if (gitRoot === path.resolve(this.projectRoot)) {
      return {
        mode: 'legacy-root',
        configPath: this.configPath,
        repositories: [{ id: 'root', path: '.', root: gitRoot }],
      };
    }

    return {
      mode: 'missing-manifest',
      configPath: this.configPath,
      repositories: [],
      error: `Repository manifest is required because project root is not a git repository: ${path.resolve(this.projectRoot)}`,
    };
  }

  discover(): RepositoryDiscoveryResult {
    const candidates: RepositoryDiscoveryCandidate[] = [];
    const usedIds = new Set<string>();
    let truncated = false;

    const visit = (dir: string, depth: number): void => {
      if (truncated || depth > DISCOVERY_MAX_DEPTH) {
        return;
      }

      const gitRoot = this.readGitRoot(dir);
      if (gitRoot === path.resolve(dir)) {
        const relativePath = this.toProjectRelativePath(dir);
        candidates.push({
          id: this.suggestRepositoryId(dir, usedIds),
          path: relativePath,
          root: gitRoot,
        });
        if (candidates.length >= DISCOVERY_MAX_CANDIDATES) {
          truncated = true;
          return;
        }
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (truncated || !entry.isDirectory() || entry.isSymbolicLink() || EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }
        visit(path.join(dir, entry.name), depth + 1);
      }
    };

    visit(path.resolve(this.projectRoot), 0);

    return {
      projectRoot: path.resolve(this.projectRoot),
      maxDepth: DISCOVERY_MAX_DEPTH,
      maxCandidates: DISCOVERY_MAX_CANDIDATES,
      truncated,
      candidates: candidates.sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  add(repositories: RepositoryConfig[]): RepositoryManifestUpdateResult {
    const stored = this.readProjectConfig();
    const currentRepositories = Array.isArray(stored.config.repositories)
      ? stored.config.repositories
      : [];
    const existingIds = new Set(currentRepositories.map((repository) => repository.id));
    const skipped = repositories.filter((repository) => existingIds.has(repository.id)).map((repository) => repository.id);
    const additions = repositories.filter((repository) => !existingIds.has(repository.id));
    const nextRepositories = [...currentRepositories, ...additions];
    const resolvedRepositories = this.resolveManifestEntries(nextRepositories);

    const nextConfig = {
      ...stored.config,
      repositories: nextRepositories,
    };
    writeAtomic(this.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);

    return {
      configPath: this.configPath,
      added: additions.map((repository) => repository.id),
      skipped,
      repositories: resolvedRepositories,
    };
  }

  private resolveManifestEntries(repositories: RepositoryConfig[]): RepositoryManifestEntry[] {
    const ids = new Set<string>();
    const roots = new Set<string>();
    const resolved: RepositoryManifestEntry[] = [];
    for (const repository of repositories) {
      if (repository === null || typeof repository !== 'object') {
        throw new Error('Repository manifest entries must be objects');
      }
      if (!isValidRepositoryId(repository.id)) {
        throw new Error(`Invalid repository ID: ${repository.id}`);
      }
      if (typeof repository.path !== 'string' || repository.path.trim().length === 0) {
        throw new Error(`Repository path must be a non-empty string for repository ID: ${repository.id}`);
      }
      if (path.isAbsolute(repository.path)) {
        throw new Error(`Repository path must be project-relative: ${repository.path}`);
      }
      if (ids.has(repository.id)) {
        throw new Error(`Duplicate repository ID: ${repository.id}`);
      }
      ids.add(repository.id);

      const repositoryPath = this.resolveRepositoryPath(repository.path);
      if (!fs.existsSync(repositoryPath)) {
        throw new Error(`Repository path does not exist: ${repositoryPath}`);
      }
      const gitRoot = this.readGitRoot(repositoryPath);
      if (gitRoot === null) {
        throw new Error(`Repository path is not inside a git repository: ${repositoryPath}`);
      }
      if (roots.has(gitRoot)) {
        throw new Error(`Duplicate repository root: ${gitRoot}`);
      }
      roots.add(gitRoot);
      resolved.push({ id: repository.id, path: repository.path, root: gitRoot });
    }
    return resolved;
  }

  private readProjectConfig(): { path: string; config: Record<string, unknown> & { repositories?: RepositoryConfig[] } } {
    if (!fs.existsSync(this.configPath)) {
      return { path: this.configPath, config: {} };
    }

    const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf-8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Project config must be a JSON object: ${this.configPath}`);
    }
    const config = parsed as Record<string, unknown> & { repositories?: RepositoryConfig[] };
    if (config.repositories !== undefined && !Array.isArray(config.repositories)) {
      throw new Error(`Project config repositories must be an array: ${this.configPath}`);
    }
    return { path: this.configPath, config };
  }

  private resolveRepositoryPath(repositoryPath: string): string {
    const resolvedPath = path.resolve(this.projectRoot, repositoryPath);
    const resolvedProjectRoot = path.resolve(this.projectRoot);
    if (resolvedPath !== resolvedProjectRoot && !resolvedPath.startsWith(`${resolvedProjectRoot}${path.sep}`)) {
      throw new Error(`Repository path must stay inside project root: ${repositoryPath}`);
    }
    return resolvedPath;
  }

  private toProjectRelativePath(repositoryPath: string): string {
    const relativePath = path.relative(this.projectRoot, repositoryPath).split(path.sep).join('/');
    return relativePath === '' ? '.' : `./${relativePath}`;
  }

  private suggestRepositoryId(repositoryPath: string, usedIds: Set<string>): string {
    const parts = path.relative(this.projectRoot, repositoryPath).split(path.sep).filter(Boolean);
    const base = parts.at(-1) ?? 'root';
    const normalized = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '');
    const fallback = isValidRepositoryId(normalized) ? normalized : `repo-${usedIds.size + 1}`;
    let candidate = fallback;
    let suffix = 2;
    while (usedIds.has(candidate) || !isValidRepositoryId(candidate)) {
      candidate = `${fallback}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(candidate);
    return candidate;
  }

  private readGitRoot(repositoryPath: string): string | null {
    try {
      const output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: repositoryPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return path.resolve(output.trim());
    } catch {
      return null;
    }
  }
}
