import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryManifestService } from './repositoryManifestService';

const initGitRepo = (root: string) => {
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
};

const withTempEnvironment = (run: (projectRoot: string, configPath: string) => void) => {
  const originalHome = process.env.HOME;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-repo-manifest-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-repo-home-'));
  process.env.HOME = home;
  try {
    run(projectRoot, path.join(home, '.config', 'opencode', 'agent_hive.json'));
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
};

describe('RepositoryManifestService', () => {
  it('reports legacy-root mode for an unscoped git project', () => {
    withTempEnvironment((projectRoot, configPath) => {
      initGitRepo(projectRoot);
      const status = new RepositoryManifestService(projectRoot).getStatus();
      expect(status).toEqual({
        mode: 'legacy-root',
        configPath,
        repositories: [{ id: 'root', path: '.', root: projectRoot }],
      });
    });
  });

  it('reports an inactive manifest when its stored repository root no longer exists', () => {
    withTempEnvironment((projectRoot, configPath) => {
      const removedProjectRoot = path.join(projectRoot, 'removed-project');
      fs.mkdirSync(removedProjectRoot);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        repositoryRoot: removedProjectRoot,
        repositories: [{ id: 'api', path: './api' }],
      }));
      fs.rmSync(removedProjectRoot, { recursive: true });
      initGitRepo(projectRoot);

      expect(new RepositoryManifestService(projectRoot).getStatus()).toEqual({
        mode: 'legacy-root',
        configPath,
        repositories: [{ id: 'root', path: '.', root: projectRoot }],
      });
    });
  });

  it('discovers bounded project-relative git repositories', () => {
    withTempEnvironment((projectRoot) => {
      initGitRepo(path.join(projectRoot, 'api'));
      initGitRepo(path.join(projectRoot, 'apps', 'web-ui'));
      initGitRepo(path.join(projectRoot, '.hive', 'ignored'));
      const result = new RepositoryManifestService(projectRoot).discover();
      expect(result.candidates.map(({ id, path: repositoryPath }) => ({ id, path: repositoryPath }))).toEqual([
        { id: 'api', path: './api' },
        { id: 'web-ui', path: './apps/web-ui' },
      ]);
    });
  });

  it('writes the global manifest with an exact active-project scope and preserves global policy', () => {
    withTempEnvironment((projectRoot, configPath) => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ sandbox: 'docker', disableSkills: ['example'] }));
      initGitRepo(path.join(projectRoot, 'api'));

      const result = new RepositoryManifestService(projectRoot).add([{ id: 'api', path: './api' }]);
      const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      expect(result.configPath).toBe(configPath);
      expect(stored).toMatchObject({
        sandbox: 'docker',
        disableSkills: ['example'],
        repositoryRoot: projectRoot,
        repositories: [{ id: 'api', path: './api' }],
      });
    });
  });

  it('replaces a manifest scoped to another project without carrying its entries across', () => {
    withTempEnvironment((projectRoot, configPath) => {
      const otherProjectRoot = path.join(projectRoot, 'other-project');
      fs.mkdirSync(otherProjectRoot);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        repositoryRoot: otherProjectRoot,
        repositories: [{ id: 'other', path: './other' }],
      }));
      initGitRepo(path.join(projectRoot, 'api'));

      new RepositoryManifestService(projectRoot).add([{ id: 'api', path: './api' }]);
      const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(stored.repositoryRoot).toBe(projectRoot);
      expect(stored.repositories).toEqual([{ id: 'api', path: './api' }]);
    });
  });

  it.each([
    { repository: { id: '../escape', path: './api' }, label: 'invalid ID' },
    { repository: { id: 'absolute', path: '/tmp/api' }, label: 'absolute path' },
    { repository: { id: 'empty', path: '' }, label: 'empty path' },
    { repository: { id: 'escape', path: './api/../../../outside' }, label: 'escaping path' },
  ])('rejects an $label without changing the global config', ({ repository }) => {
    withTempEnvironment((projectRoot, configPath) => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const original = `${JSON.stringify({ sandbox: 'none' }, null, 2)}\n`;
      fs.writeFileSync(configPath, original);

      expect(() => new RepositoryManifestService(projectRoot).add([repository])).toThrow('Invalid repository entry');
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
    });
  });

  it('rejects an invalid global config for status and update operations', () => {
    withTempEnvironment((projectRoot, configPath) => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ sandbox: 'bogus' }));
      initGitRepo(projectRoot);
      const service = new RepositoryManifestService(projectRoot);

      expect(() => service.getStatus()).toThrow('Invalid global Agent Hive config');
      expect(() => service.add([])).toThrow('Invalid global Agent Hive config');
    });
  });

  it('rejects a repository symlink whose canonical git root escapes the project root', () => {
    withTempEnvironment((projectRoot, configPath) => {
      const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-external-manifest-'));
      try {
        initGitRepo(externalRoot);
        fs.symlinkSync(externalRoot, path.join(projectRoot, 'external'));
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
          repositoryRoot: projectRoot,
          repositories: [{ id: 'external', path: './external' }],
        }));
        const service = new RepositoryManifestService(projectRoot);

        expect(service.getStatus().error).toContain('must stay inside project root');
        expect(() => service.add([])).toThrow('must stay inside project root');
      } finally {
        fs.rmSync(externalRoot, { recursive: true, force: true });
      }
    });
  });
});
