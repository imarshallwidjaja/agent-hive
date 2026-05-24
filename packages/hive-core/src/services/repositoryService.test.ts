import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from './configService';
import { RepositoryService } from './repositoryService';

const makeTempProject = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hive-repos-'));

const writeProjectConfig = (projectRoot: string, config: unknown) => {
  const configPath = path.join(projectRoot, '.hive', 'agent-hive.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
};

const writeGlobalConfig = (homeDir: string, config: unknown) => {
  const configPath = path.join(homeDir, '.config', 'opencode', 'agent_hive.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
};

const initGitRepo = (repoRoot: string) => {
  fs.mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
};

const withTempProject = (run: (projectRoot: string) => void) => {
  const projectRoot = makeTempProject();
  try {
    run(projectRoot);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
};

describe('RepositoryService repository ID validation', () => {
  it.each(['api', 'web-ui', 'data.v2', 'api_v2'])('accepts safe repository ID %s', (id) => {
    expect(RepositoryService.isValidRepositoryId(id)).toBe(true);
  });

  it.each(['Api', '../api', 'api/web', 'api web', '..', 'api..v2', 'api.lock'])('rejects unsafe repository ID %s', (id) => {
    expect(RepositoryService.isValidRepositoryId(id)).toBe(false);
  });
});

describe('RepositoryService manifest resolution', () => {
  it('resolves project-relative repository paths to git roots', () => {
    withTempProject((projectRoot) => {
      const apiRoot = path.join(projectRoot, 'api');
      const webRoot = path.join(projectRoot, 'web-ui');
      initGitRepo(apiRoot);
      initGitRepo(webRoot);
      writeProjectConfig(projectRoot, {
        repositories: [
          { id: 'api', path: 'api' },
          { id: 'web-ui', path: './web-ui' },
        ],
      });

      const repositories = new RepositoryService(projectRoot, new ConfigService(projectRoot)).resolveRepositories();

      expect(repositories).toEqual([
        { id: 'api', path: path.resolve(projectRoot, 'api'), root: apiRoot },
        { id: 'web-ui', path: path.resolve(projectRoot, 'web-ui'), root: webRoot },
      ]);
    });
  });

  it('resolves absolute repository paths after git validation', () => {
    withTempProject((projectRoot) => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-absolute-repo-'));
      try {
        initGitRepo(repoRoot);
        writeProjectConfig(projectRoot, {
          repositories: [{ id: 'api', path: repoRoot }],
        });

        const repositories = new RepositoryService(projectRoot, new ConfigService(projectRoot)).resolveRepositories();

        expect(repositories).toEqual([{ id: 'api', path: repoRoot, root: repoRoot }]);
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });

  it('rejects duplicate repository IDs', () => {
    withTempProject((projectRoot) => {
      const apiRoot = path.join(projectRoot, 'api');
      const secondRoot = path.join(projectRoot, 'second-api');
      initGitRepo(apiRoot);
      initGitRepo(secondRoot);
      writeProjectConfig(projectRoot, {
        repositories: [
          { id: 'api', path: 'api' },
          { id: 'api', path: 'second-api' },
        ],
      });

      expect(() => new RepositoryService(projectRoot, new ConfigService(projectRoot)).resolveRepositories()).toThrow(
        'Duplicate repository ID: api',
      );
    });
  });

  it('rejects duplicate resolved git roots', () => {
    withTempProject((projectRoot) => {
      const apiRoot = path.join(projectRoot, 'api');
      initGitRepo(apiRoot);
      fs.mkdirSync(path.join(apiRoot, 'src'));
      writeProjectConfig(projectRoot, {
        repositories: [
          { id: 'api', path: 'api' },
          { id: 'web', path: 'api/src' },
        ],
      });

      expect(() => new RepositoryService(projectRoot, new ConfigService(projectRoot)).resolveRepositories()).toThrow(
        `Duplicate repository root: ${apiRoot}`,
      );
    });
  });

  it('rejects missing repository paths', () => {
    withTempProject((projectRoot) => {
      writeProjectConfig(projectRoot, {
        repositories: [{ id: 'api', path: 'missing-api' }],
      });

      expect(() => new RepositoryService(projectRoot, new ConfigService(projectRoot)).resolveRepositories()).toThrow(
        `Repository path does not exist: ${path.join(projectRoot, 'missing-api')}`,
      );
    });
  });

  it('rejects repository paths that are not inside a git repository', () => {
    withTempProject((projectRoot) => {
      const apiPath = path.join(projectRoot, 'api');
      fs.mkdirSync(apiPath);
      writeProjectConfig(projectRoot, {
        repositories: [{ id: 'api', path: 'api' }],
      });

      expect(() => new RepositoryService(projectRoot, new ConfigService(projectRoot)).resolveRepositories()).toThrow(
        `Repository path is not inside a git repository: ${apiPath}`,
      );
    });
  });

  it('uses an implicit root repository when no project manifest exists and the project root is a git repository', () => {
    withTempProject((projectRoot) => {
      initGitRepo(projectRoot);

      const repositories = new RepositoryService(projectRoot, new ConfigService(projectRoot)).resolveRepositories();

      expect(repositories).toEqual([{ id: 'root', path: projectRoot, root: projectRoot }]);
    });
  });

  it('requires a project manifest when no project manifest exists and the project root is not a git repository', () => {
    withTempProject((projectRoot) => {
      expect(() => new RepositoryService(projectRoot, new ConfigService(projectRoot)).resolveRepositories()).toThrow(
        `Repository manifest is required because project root is not a git repository: ${projectRoot}`,
      );
    });
  });

  it('ignores global repository manifests for project-scoped repository resolution', () => {
    const originalHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-repos-home-'));
    try {
      process.env.HOME = tempHome;
      withTempProject((projectRoot) => {
        const apiRoot = path.join(projectRoot, 'api');
        initGitRepo(apiRoot);
        writeGlobalConfig(tempHome, {
          repositories: [{ id: 'api', path: apiRoot }],
        });

        expect(() => new RepositoryService(projectRoot, new ConfigService(projectRoot)).resolveRepositories()).toThrow(
          `Repository manifest is required because project root is not a git repository: ${projectRoot}`,
        );
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
