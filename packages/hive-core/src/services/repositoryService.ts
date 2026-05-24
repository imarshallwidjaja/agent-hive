import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { RepositoryConfig, ResolvedRepository } from '../types.js';
import { isValidRepositoryId } from '../utils/repositoryIds.js';
import { ConfigService } from './configService.js';

export class RepositoryService {
  constructor(
    private readonly projectRoot: string,
    private readonly configService = new ConfigService(projectRoot),
  ) {}

  static isValidRepositoryId(id: string): boolean {
    return isValidRepositoryId(id);
  }

  resolveRepositories(): ResolvedRepository[] {
    const projectConfig = this.configService.getProjectConfig();
    const manifest = projectConfig?.repositories;

    if (manifest !== undefined) {
      return this.resolveManifest(manifest);
    }

    const resolvedProjectRoot = path.resolve(this.projectRoot);
    if (!fs.existsSync(resolvedProjectRoot)) {
      throw new Error(`Repository manifest is required because project root is not a git repository: ${resolvedProjectRoot}`);
    }

    const gitRoot = this.readGitRoot(resolvedProjectRoot);
    if (gitRoot === null || gitRoot !== resolvedProjectRoot) {
      throw new Error(`Repository manifest is required because project root is not a git repository: ${resolvedProjectRoot}`);
    }

    return [{ id: 'root', path: resolvedProjectRoot, root: gitRoot }];
  }

  private resolveManifest(manifest: RepositoryConfig[]): ResolvedRepository[] {
    const ids = new Set<string>();
    const roots = new Set<string>();
    const repositories: ResolvedRepository[] = [];

    for (const repository of manifest) {
      if (ids.has(repository.id)) {
        throw new Error(`Duplicate repository ID: ${repository.id}`);
      }
      ids.add(repository.id);

      const resolvedPath = path.isAbsolute(repository.path)
        ? path.resolve(repository.path)
        : path.resolve(this.projectRoot, repository.path);

      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Repository path does not exist: ${resolvedPath}`);
      }

      const gitRoot = this.readGitRoot(resolvedPath);
      if (gitRoot === null) {
        throw new Error(`Repository path is not inside a git repository: ${resolvedPath}`);
      }

      if (roots.has(gitRoot)) {
        throw new Error(`Duplicate repository root: ${gitRoot}`);
      }
      roots.add(gitRoot);

      repositories.push({ id: repository.id, path: resolvedPath, root: gitRoot });
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
