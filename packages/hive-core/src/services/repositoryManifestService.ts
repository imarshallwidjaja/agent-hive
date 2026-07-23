import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { RepositoryConfig } from '../types.js';
import type { ResolvedRepository } from '../types.js';
import { assertRepositoryManifestContained, canonicalProjectRoot, isValidRepositoryConfig, parseProjectRepositoryManifest, projectRootsMatch } from '../utils/repositoryConfig.js';
import { acquireLockSync, writeJsonAtomic } from '../utils/paths.js';
import { isValidRepositoryId } from '../utils/repositoryIds.js';
import { ConfigService } from './configService.js';
import { RepositoryService } from './repositoryService.js';
import { parseCompositeWorkspaceManifest } from './workspaceManifest.js';

export type RepositoryManifestMode = 'manifest' | 'legacy-root' | 'missing-manifest';

export interface RepositoryManifestEntry extends RepositoryConfig {
  root?: string;
}

export interface RepositoryManifestStatus {
  mode: RepositoryManifestMode;
  configPath: string;
  repositories: RepositoryManifestEntry[];
  error?: string;
  source?: 'local' | 'legacy-global' | 'generated-workspace' | 'single-root';
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
  legacyCleanup?: 'removed' | 'skipped' | 'failed';
  legacyCleanupError?: string;
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
    this.configPath = path.join(this.projectRoot, '.hive', 'repositories.json');
    this.repositoryService = new RepositoryService(this.projectRoot, this.configService);
  }

  getStatus(): RepositoryManifestStatus {
    const generated = this.readGeneratedWorkspaceEntries();
    if (generated) {
      return { mode: 'manifest', configPath: path.join(this.projectRoot, 'workspace.json'), repositories: this.resolveManifestEntries(generated), source: 'generated-workspace' };
    }

    try {
      assertRepositoryManifestContained(this.projectRoot, this.configPath);
      if (fs.existsSync(this.configPath)) {
        const repositories = this.readLocalManifest();
        return { mode: 'manifest', configPath: this.configPath, repositories: this.resolveManifestEntries(repositories), source: 'local' };
      }
    } catch (error) {
      return {
        mode: 'manifest',
        configPath: this.configPath,
        repositories: [],
        error: error instanceof Error ? error.message : String(error),
        source: 'local',
      };
    }

    const config = this.configService.readStored();
    if (config.repositoryRoot !== undefined && projectRootsMatch(config.repositoryRoot, this.projectRoot) && Array.isArray(config.repositories)) {
      try {
        return {
          mode: 'manifest',
          configPath: this.configPath,
          repositories: this.resolveManifestEntries(config.repositories),
          source: 'legacy-global',
        };
      } catch (error) {
        return {
          mode: 'manifest',
          configPath: this.configPath,
          repositories: config.repositories.map((repository) => ({ ...repository })),
          error: error instanceof Error ? error.message : String(error),
          source: 'legacy-global',
        };
      }
    }

    const gitRoot = this.readGitRoot(this.projectRoot);
    if (gitRoot === this.projectRoot) {
      return {
        mode: 'legacy-root',
        configPath: this.configPath,
        repositories: [{ id: 'root', path: '.', root: gitRoot }],
        source: 'single-root',
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

    if (this.readGeneratedWorkspaceEntries()) {
      throw new Error('Repository topology cannot be updated from a generated composite workspace');
    }
    this.assertManifestParentContained();

    let legacyRepositories: RepositoryConfig[] | undefined;
    let legacyRepositoryRoot: string | undefined;
    let additions: RepositoryConfig[];
    let skipped: string[];
    let resolvedRepositories: RepositoryManifestEntry[];
    const release = acquireLockSync(this.configPath);
    try {
      if (this.readGeneratedWorkspaceEntries()) {
        throw new Error('Repository topology cannot be updated from a generated composite workspace');
      }
      let currentRepositories: RepositoryConfig[];
      if (fs.existsSync(this.configPath)) {
        currentRepositories = this.readLocalManifest();
      } else {
        const config = this.configService.readStored();
        legacyRepositories = config.repositoryRoot !== undefined
          && projectRootsMatch(config.repositoryRoot, this.projectRoot)
          && Array.isArray(config.repositories)
          ? config.repositories
          : undefined;
        legacyRepositoryRoot = legacyRepositories ? config.repositoryRoot : undefined;
        currentRepositories = legacyRepositories ?? [];
      }
      const existingIds = new Set(currentRepositories.map((repository) => repository.id));
      skipped = repositories.filter((repository) => existingIds.has(repository.id)).map((repository) => repository.id);
      additions = repositories.filter((repository) => !existingIds.has(repository.id));
      const nextRepositories = [...currentRepositories, ...additions];
      if (nextRepositories.length === 0) {
        throw new Error('Repository manifest must contain at least one repository');
      }
      resolvedRepositories = this.resolveManifestEntries(nextRepositories);
      writeJsonAtomic(this.configPath, { schemaVersion: 1, repositories: nextRepositories });
    } finally {
      release();
    }
    let legacyCleanup: RepositoryManifestUpdateResult['legacyCleanup'];
    let legacyCleanupError: string | undefined;
    if (legacyRepositories) {
      try {
        legacyCleanup = this.configService.removeLegacyRepositoryManifestIfMatches(legacyRepositoryRoot!, legacyRepositories);
      } catch (error) {
        legacyCleanup = 'failed';
        legacyCleanupError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      configPath: this.configPath,
      added: additions.map((repository) => repository.id),
      skipped,
      repositories: resolvedRepositories,
      legacyCleanup,
      legacyCleanupError,
    };
  }

  resolveRepositories(): ResolvedRepository[] {
    const status = this.getStatus();
    if (status.error) throw new Error(status.error);
    return status.repositories.map((repository) => ({ id: repository.id, path: path.resolve(this.projectRoot, repository.path), root: repository.root! }));
  }

  private readLocalManifest(): RepositoryConfig[] {
    assertRepositoryManifestContained(this.projectRoot, this.configPath);
    try {
      return parseProjectRepositoryManifest(JSON.parse(fs.readFileSync(this.configPath, 'utf-8'))).repositories;
    } catch (error) {
      throw new Error(`Invalid project repository manifest at ${this.configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private readGeneratedWorkspaceEntries(): RepositoryConfig[] | null {
    const workspacePath = path.join(this.projectRoot, 'workspace.json');
    if (!fs.existsSync(workspacePath)) return null;
    if (this.readGitRoot(this.projectRoot) === this.projectRoot) return null;
    try {
      const manifest = parseCompositeWorkspaceManifest(JSON.parse(fs.readFileSync(workspacePath, 'utf-8')), workspacePath);
      return Object.entries(manifest.repos).map(([id, entry]) => ({ id, path: entry.path }));
    } catch (error) {
      throw new Error(`Invalid generated composite workspace manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private assertManifestParentContained(): void {
    const hiveDir = path.dirname(this.configPath);
    fs.mkdirSync(hiveDir, { recursive: true });
    assertRepositoryManifestContained(this.projectRoot, this.configPath);
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
