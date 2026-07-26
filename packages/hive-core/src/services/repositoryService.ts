import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { RepositoryConfig, ResolvedRepository } from '../types.js';
import { isValidRepositoryId } from '../utils/repositoryIds.js';
import { assertRepositoryManifestContained, canonicalProjectRoot, parseProjectRepositoryManifest, projectRootsMatch } from '../utils/repositoryConfig.js';
import { ConfigService } from './configService.js';

export class RepositoryService {
  private readonly projectRoot: string;

  constructor(
    projectRoot: string,
    private readonly configService = new ConfigService(projectRoot),
  ) {
    this.projectRoot = canonicalProjectRoot(projectRoot);
  }

  static isValidRepositoryId(id: string): boolean {
    return isValidRepositoryId(id);
  }

  resolveRepositories(): ResolvedRepository[] {
    const localManifestPath = path.join(this.projectRoot, '.hive', 'repositories.json');
    assertRepositoryManifestContained(this.projectRoot, localManifestPath);
    if (fs.existsSync(localManifestPath)) {
      try {
        const manifest = parseProjectRepositoryManifest(JSON.parse(fs.readFileSync(localManifestPath, 'utf-8')));
        return this.resolveManifest(manifest.repositories);
      } catch (error) {
        throw new Error(`Invalid project repository manifest at ${localManifestPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const config = this.configService.get();
    const manifest = config.repositoryRoot !== undefined && projectRootsMatch(config.repositoryRoot, this.projectRoot)
      ? config.repositories
      : undefined;

    if (manifest !== undefined) {
      return this.resolveManifest(manifest);
    }

    const resolvedProjectRoot = this.projectRoot;
    if (!fs.existsSync(resolvedProjectRoot)) {
      throw new Error(`Repository manifest is required because project root is not a git repository: ${resolvedProjectRoot}`);
    }

    const gitRoot = this.readGitRoot(resolvedProjectRoot);
    if (gitRoot === null || gitRoot !== resolvedProjectRoot) {
      throw new Error(`Repository manifest is required because project root is not a git repository: ${resolvedProjectRoot}`);
    }

    return [{ id: 'root', path: resolvedProjectRoot, root: gitRoot }];
  }

  resolveManifest(manifest: RepositoryConfig[]): ResolvedRepository[] {
    const ids = new Set<string>();
    const roots = new Set<string>();
    const repositories: ResolvedRepository[] = [];
    const resolvedProjectRoot = this.projectRoot;

    for (const repository of manifest) {
      if (ids.has(repository.id)) {
        throw new Error(`Duplicate repository ID: ${repository.id}`);
      }
      ids.add(repository.id);

      const resolvedPath = path.resolve(resolvedProjectRoot, repository.path);
      if (resolvedPath !== resolvedProjectRoot && !resolvedPath.startsWith(`${resolvedProjectRoot}${path.sep}`)) {
        throw new Error(`Repository path must stay inside project root: ${repository.path}`);
      }

      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Repository path does not exist: ${resolvedPath}`);
      }

      const repositoryStat = fs.lstatSync(resolvedPath);
      if (repositoryStat.isSymbolicLink()) {
        throw new Error(`Repository path must stay inside project root and must not be a symlink: ${repository.path}`);
      }
      const canonicalPath = fs.realpathSync(resolvedPath);
      if (canonicalPath !== resolvedProjectRoot && !canonicalPath.startsWith(`${resolvedProjectRoot}${path.sep}`)) {
        throw new Error(`Repository path must stay inside project root: ${repository.path}`);
      }

      const gitRoot = this.readGitRoot(canonicalPath);
      if (gitRoot === null) {
        throw new Error(`Repository path is not inside a git repository: ${resolvedPath}`);
      }
      const canonicalGitRoot = fs.realpathSync(gitRoot);
      if (canonicalGitRoot !== resolvedProjectRoot && !canonicalGitRoot.startsWith(`${resolvedProjectRoot}${path.sep}`)) {
        throw new Error(`Repository path must stay inside project root: ${repository.path}`);
      }

      if (roots.has(canonicalGitRoot)) {
        throw new Error(`Duplicate repository root: ${canonicalGitRoot}`);
      }
      roots.add(canonicalGitRoot);

      repositories.push({ id: repository.id, path: canonicalPath, root: canonicalGitRoot });
    }

    return repositories;
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
