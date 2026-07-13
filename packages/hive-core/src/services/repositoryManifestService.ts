import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { RepositoryConfig } from '../types.js';
import { canonicalProjectRoot, isValidRepositoryConfig, projectRootsMatch } from '../utils/repositoryConfig.js';
import { isValidRepositoryId } from '../utils/repositoryIds.js';
import { ConfigService } from './configService.js';
import { RepositoryService } from './repositoryService.js';

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
  private readonly projectRoot: string;
  private readonly configPath: string;
  private readonly configService: ConfigService;
  private readonly repositoryService: RepositoryService;

  constructor(projectRoot: string) {
    this.projectRoot = canonicalProjectRoot(projectRoot);
    this.configService = new ConfigService(this.projectRoot);
    this.configPath = this.configService.getPath();
    this.repositoryService = new RepositoryService(this.projectRoot, this.configService);
  }

  getStatus(): RepositoryManifestStatus {
    const config = this.configService.readStored();
    if (config.repositoryRoot !== undefined && projectRootsMatch(config.repositoryRoot, this.projectRoot) && Array.isArray(config.repositories)) {
      try {
        return {
          mode: 'manifest',
          configPath: this.configPath,
          repositories: this.resolveManifestEntries(config.repositories),
        };
      } catch (error) {
        return {
          mode: 'manifest',
          configPath: this.configPath,
          repositories: config.repositories.map((repository) => ({ ...repository })),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const gitRoot = this.readGitRoot(this.projectRoot);
    if (gitRoot === this.projectRoot) {
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
      error: `Repository manifest is required because project root is not a git repository: ${this.projectRoot}`,
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
      if (gitRoot === canonicalProjectRoot(dir)) {
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

    visit(this.projectRoot, 0);

    return {
      projectRoot: this.projectRoot,
      maxDepth: DISCOVERY_MAX_DEPTH,
      maxCandidates: DISCOVERY_MAX_CANDIDATES,
      truncated,
      candidates: candidates.sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  add(repositories: RepositoryConfig[]): RepositoryManifestUpdateResult {
    for (const repository of repositories) {
      if (!isValidRepositoryConfig(repository)) {
        throw new Error(`Invalid repository entry: ${JSON.stringify(repository)}`);
      }
    }

    const config = this.configService.readStored();
    const currentRepositories = config.repositoryRoot !== undefined && projectRootsMatch(config.repositoryRoot, this.projectRoot) && Array.isArray(config.repositories)
      ? config.repositories
      : [];
    const existingIds = new Set(currentRepositories.map((repository) => repository.id));
    const skipped = repositories.filter((repository) => existingIds.has(repository.id)).map((repository) => repository.id);
    const additions = repositories.filter((repository) => !existingIds.has(repository.id));
    const nextRepositories = [...currentRepositories, ...additions];
    const resolvedRepositories = this.resolveManifestEntries(nextRepositories);

    this.configService.set({
      repositoryRoot: this.projectRoot,
      repositories: nextRepositories,
    });

    return {
      configPath: this.configPath,
      added: additions.map((repository) => repository.id),
      skipped,
      repositories: resolvedRepositories,
    };
  }

  private resolveManifestEntries(repositories: RepositoryConfig[]): RepositoryManifestEntry[] {
    const resolved = this.repositoryService.resolveManifest(repositories);
    return resolved.map((repository, index) => ({
      id: repository.id,
      path: repositories[index]!.path,
      root: repository.root,
    }));
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
      return canonicalProjectRoot(output.trim());
    } catch {
      return null;
    }
  }
}
