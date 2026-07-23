import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryService } from './repositoryService';

const initGitRepo = (root: string) => {
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
};

const withTempEnvironment = (run: (projectRoot: string, home: string) => void) => {
  const originalHome = process.env.HOME;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-repos-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-repos-home-'));
  process.env.HOME = home;
  try {
    run(projectRoot, home);
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
};

describe('RepositoryService manifest resolution', () => {
  it('uses an implicit root repository for an unscoped git project', () => {
    withTempEnvironment((projectRoot) => {
      initGitRepo(projectRoot);
      expect(new RepositoryService(projectRoot).resolveRepositories()).toEqual([
        { id: 'root', path: projectRoot, root: projectRoot },
      ]);
    });
  });

  it('rejects an external manifest directory symlink instead of falling back to the root repository', () => {
    withTempEnvironment((projectRoot) => {
      const external = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-repos-manifest-external-'));
      try {
        initGitRepo(projectRoot);
        fs.symlinkSync(external, path.join(projectRoot, '.hive'));

        expect(() => new RepositoryService(projectRoot).resolveRepositories()).toThrow('must stay inside project root');
      } finally {
        fs.rmSync(external, { recursive: true, force: true });
      }
    });
  });

  it('rejects duplicate repository IDs', () => {
    withTempEnvironment((projectRoot) => {
      initGitRepo(path.join(projectRoot, 'api'));
      initGitRepo(path.join(projectRoot, 'other'));

      expect(() => new RepositoryService(projectRoot).resolveManifest([
        { id: 'api', path: './api' },
        { id: 'api', path: './other' },
      ])).toThrow('Duplicate repository ID: api');
    });
  });

  it('rejects a repository symlink whose canonical git root escapes the project root', () => {
    withTempEnvironment((projectRoot) => {
      const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-external-repo-'));
      try {
        initGitRepo(externalRoot);
        fs.symlinkSync(externalRoot, path.join(projectRoot, 'external'));
        expect(() => new RepositoryService(projectRoot).resolveManifest([
          { id: 'external', path: './external' },
        ])).toThrow('must stay inside project root');
      } finally {
        fs.rmSync(externalRoot, { recursive: true, force: true });
      }
    });
  });
});

describe('RepositoryService repository ID validation', () => {
  it.each(['api', 'web-ui', 'data.v2', 'api_v2'])('accepts safe repository ID %s', (id) => {
    expect(RepositoryService.isValidRepositoryId(id)).toBe(true);
  });

  it.each(['Api', '../api', 'api/web', 'api web', '..', 'api..v2', 'api.lock'])('rejects unsafe repository ID %s', (id) => {
    expect(RepositoryService.isValidRepositoryId(id)).toBe(false);
  });
});
