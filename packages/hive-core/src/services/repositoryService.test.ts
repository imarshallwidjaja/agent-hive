import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from './configService';
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

const writeGlobalConfig = (home: string, config: unknown) => {
  const configPath = path.join(home, '.config', 'opencode', 'agent_hive.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
};

describe('RepositoryService manifest resolution', () => {
  it('resolves a global manifest only when repositoryRoot matches the active project', () => {
    withTempEnvironment((projectRoot, home) => {
      const apiRoot = path.join(projectRoot, 'api');
      initGitRepo(apiRoot);
      writeGlobalConfig(home, {
        repositoryRoot: projectRoot,
        repositories: [{ id: 'api', path: './api' }],
      });

      expect(new RepositoryService(projectRoot, new ConfigService(projectRoot)).resolveRepositories()).toEqual([
        { id: 'api', path: apiRoot, root: apiRoot },
      ]);
    });
  });

  it('resolves a manifest scoped through a symlink alias of the active project', () => {
    withTempEnvironment((projectRoot, home) => {
      const projectAlias = path.join(home, 'project-alias');
      const apiRoot = path.join(projectRoot, 'api');
      initGitRepo(apiRoot);
      fs.symlinkSync(projectRoot, projectAlias);
      writeGlobalConfig(home, {
        repositoryRoot: projectRoot,
        repositories: [{ id: 'api', path: './api' }],
      });

      expect(new RepositoryService(projectAlias).resolveRepositories()).toEqual([
        { id: 'api', path: apiRoot, root: apiRoot },
      ]);
    });
  });

  it('ignores a global manifest scoped to another project', () => {
    withTempEnvironment((projectRoot, home) => {
      const otherProjectRoot = path.join(home, 'another-project');
      fs.mkdirSync(otherProjectRoot);
      initGitRepo(path.join(projectRoot, 'api'));
      writeGlobalConfig(home, {
        repositoryRoot: otherProjectRoot,
        repositories: [{ id: 'api', path: './api' }],
      });

      expect(() => new RepositoryService(projectRoot, new ConfigService(projectRoot)).resolveRepositories()).toThrow(
        `Repository manifest is required because project root is not a git repository: ${projectRoot}`,
      );
    });
  });

  it('treats a manifest whose stored repository root was removed as inactive', () => {
    withTempEnvironment((projectRoot, home) => {
      const removedProjectRoot = path.join(home, 'removed-project');
      fs.mkdirSync(removedProjectRoot);
      writeGlobalConfig(home, {
        repositoryRoot: removedProjectRoot,
        repositories: [{ id: 'api', path: './api' }],
      });
      fs.rmSync(removedProjectRoot, { recursive: true });
      initGitRepo(projectRoot);

      expect(new RepositoryService(projectRoot).resolveRepositories()).toEqual([
        { id: 'root', path: projectRoot, root: projectRoot },
      ]);
    });
  });

  it('ignores project config manifests', () => {
    withTempEnvironment((projectRoot) => {
      const apiRoot = path.join(projectRoot, 'api');
      initGitRepo(apiRoot);
      const projectConfigPath = path.join(projectRoot, '.hive', 'agent-hive.json');
      fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
      fs.writeFileSync(projectConfigPath, JSON.stringify({ repositories: [{ id: 'api', path: './api' }] }));

      expect(() => new RepositoryService(projectRoot, new ConfigService(projectRoot)).resolveRepositories()).toThrow(
        `Repository manifest is required because project root is not a git repository: ${projectRoot}`,
      );
    });
  });

  it('uses an implicit root repository for an unscoped git project', () => {
    withTempEnvironment((projectRoot) => {
      initGitRepo(projectRoot);
      expect(new RepositoryService(projectRoot).resolveRepositories()).toEqual([
        { id: 'root', path: projectRoot, root: projectRoot },
      ]);
    });
  });

  it('rejects duplicate repository IDs in the active global manifest', () => {
    withTempEnvironment((projectRoot, home) => {
      initGitRepo(path.join(projectRoot, 'api'));
      initGitRepo(path.join(projectRoot, 'other'));
      writeGlobalConfig(home, {
        repositoryRoot: projectRoot,
        repositories: [{ id: 'api', path: './api' }, { id: 'api', path: './other' }],
      });

      expect(() => new RepositoryService(projectRoot).resolveRepositories()).toThrow('Duplicate repository ID: api');
    });
  });

  it('rejects a repository symlink whose canonical git root escapes the project root', () => {
    withTempEnvironment((projectRoot, home) => {
      const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-external-repo-'));
      try {
        initGitRepo(externalRoot);
        fs.symlinkSync(externalRoot, path.join(projectRoot, 'external'));
        writeGlobalConfig(home, {
          repositoryRoot: projectRoot,
          repositories: [{ id: 'external', path: './external' }],
        });

        expect(() => new RepositoryService(projectRoot).resolveRepositories()).toThrow('must stay inside project root');
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
