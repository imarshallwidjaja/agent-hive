import { describe, expect, it, spyOn } from 'bun:test';
import { execFileSync, spawn } from 'child_process';
import * as childProcess from 'child_process';
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
    withTempEnvironment((projectRoot) => {
      initGitRepo(projectRoot);
      const status = new RepositoryManifestService(projectRoot).getStatus();
      expect(status).toEqual({
        mode: 'legacy-root',
        configPath: path.join(projectRoot, '.hive', 'repositories.json'),
        repositories: [{ id: 'root', path: '.', root: projectRoot }],
        source: 'single-root',
      });
    });
  });

  it('ignores unrelated workspace metadata at a normal git root and uses the local manifest', () => {
    withTempEnvironment((projectRoot) => {
      initGitRepo(projectRoot);
      fs.mkdirSync(path.join(projectRoot, '.hive'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.hive', 'repositories.json'), JSON.stringify({
        schemaVersion: 1,
        repositories: [{ id: 'root', path: '.' }],
      }));
      fs.writeFileSync(path.join(projectRoot, 'workspace.json'), JSON.stringify({ name: 'unrelated workspace metadata' }));

      expect(new RepositoryManifestService(projectRoot).getStatus()).toMatchObject({
        mode: 'manifest',
        source: 'local',
        repositories: [{ id: 'root', path: '.', root: projectRoot }],
      });
    });
  });

  it('keeps valid composite-shaped workspace metadata subordinate at a normal git root', () => {
    withTempEnvironment((projectRoot) => {
      initGitRepo(projectRoot);
      initGitRepo(path.join(projectRoot, 'repos', 'api'));
      const commit = '0123456789abcdef';
      fs.writeFileSync(path.join(projectRoot, 'workspace.json'), JSON.stringify({
        schemaVersion: 1,
        mode: 'adhoc-composite',
        runId: 'ambiguous-workspace',
        repos: {
          api: {
            path: 'repos/api',
            repoRoot: path.join(projectRoot, 'repos', 'api'),
            repoPath: path.join(projectRoot, 'repos', 'api'),
            branch: 'hive/adhoc/api/ambiguous-workspace',
            commit,
          },
        },
        baseCommits: { api: commit },
        createdAt: new Date().toISOString(),
      }));
      const service = new RepositoryManifestService(projectRoot);

      expect(service.getStatus()).toEqual({
        mode: 'legacy-root',
        configPath: path.join(projectRoot, '.hive', 'repositories.json'),
        repositories: [{ id: 'root', path: '.', root: projectRoot }],
        source: 'single-root',
      });
      expect(service.add([{ id: 'root', path: '.' }]).added).toEqual(['root']);
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
        configPath: path.join(projectRoot, '.hive', 'repositories.json'),
        repositories: [{ id: 'root', path: '.', root: projectRoot }],
        source: 'single-root',
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

  it('writes a project-local manifest without changing global policy', () => {
    withTempEnvironment((projectRoot, configPath) => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ sandbox: 'docker', disableSkills: ['example'] }));
      initGitRepo(path.join(projectRoot, 'api'));

      const result = new RepositoryManifestService(projectRoot).add([{ id: 'api', path: './api' }]);
      const manifestPath = path.join(projectRoot, '.hive', 'repositories.json');
      const stored = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const globalConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      expect(result.configPath).toBe(manifestPath);
      expect(stored).toEqual({
        schemaVersion: 1,
        repositories: [{ id: 'api', path: './api' }],
      });
      expect(globalConfig).toEqual({ sandbox: 'docker', disableSkills: ['example'] });
    });
  });

  it('serializes concurrent additions without losing either successful update', async () => {
    const originalHome = process.env.HOME;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-repo-manifest-race-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-repo-home-race-'));
    const manifestPath = path.join(projectRoot, '.hive', 'repositories.json');
    const continuePath = path.join(projectRoot, '.hive', 'continue');
    const markers = [
      path.join(projectRoot, '.hive', 'read-web'),
      path.join(projectRoot, '.hive', 'read-worker'),
    ];
    process.env.HOME = home;

    try {
      initGitRepo(path.join(projectRoot, 'api'));
      initGitRepo(path.join(projectRoot, 'web'));
      initGitRepo(path.join(projectRoot, 'worker'));
      new RepositoryManifestService(projectRoot).add([{ id: 'api', path: './api' }]);

      const serviceModule = new URL('./repositoryManifestService.ts', import.meta.url).href;
      const childScript = `
        import { spyOn } from 'bun:test';
        import * as fs from 'fs';
        import { RepositoryManifestService } from ${JSON.stringify(serviceModule)};

        const originalReadFileSync = fs.readFileSync;
        let capturedManifest = false;
        const readSpy = spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
          const value = originalReadFileSync(filePath, ...args);
          if (!capturedManifest && String(filePath) === process.env.MANIFEST_PATH) {
            capturedManifest = true;
            fs.writeFileSync(process.env.READ_MARKER, '');
            while (!fs.existsSync(process.env.CONTINUE_PATH)) {}
          }
          return value;
        });

        try {
          new RepositoryManifestService(process.env.PROJECT_ROOT).add([{
            id: process.env.REPOSITORY_ID,
            path: process.env.REPOSITORY_PATH,
          }]);
        } finally {
          readSpy.mockRestore();
        }
      `;
      const runAddition = (id: string, repositoryPath: string, marker: string): Promise<void> => {
        const child = spawn(process.execPath, ['-e', childScript], {
          env: {
            ...process.env,
            HOME: home,
            PROJECT_ROOT: projectRoot,
            MANIFEST_PATH: manifestPath,
            READ_MARKER: marker,
            CONTINUE_PATH: continuePath,
            REPOSITORY_ID: id,
            REPOSITORY_PATH: repositoryPath,
          },
        });
        let stderr = '';
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        return new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr || `Manifest addition exited with code ${code}`));
          });
        });
      };

      const additions = [
        runAddition('web', './web', markers[0]!),
        runAddition('worker', './worker', markers[1]!),
      ];
      const deadline = Date.now() + 5000;
      while (true) {
        const readCount = markers.filter((marker) => fs.existsSync(marker)).length;
        if (readCount === markers.length || (readCount > 0 && fs.existsSync(`${manifestPath}.lock`))) break;
        if (Date.now() >= deadline) throw new Error('Timed out waiting for concurrent manifest reads');
        await Bun.sleep(10);
      }
      fs.writeFileSync(continuePath, '');
      await Promise.all(additions);

      const stored = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(stored.repositories.map(({ id }: { id: string }) => id).sort()).toEqual(['api', 'web', 'worker']);
    } finally {
      fs.mkdirSync(path.dirname(continuePath), { recursive: true });
      fs.writeFileSync(continuePath, '');
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps independent project manifests local after a project is relocated', () => {
    withTempEnvironment((containerRoot) => {
      const firstRoot = path.join(containerRoot, 'first-project');
      const secondRoot = path.join(containerRoot, 'second-project');
      const relocatedRoot = path.join(containerRoot, 'relocated-project');
      initGitRepo(path.join(firstRoot, 'api'));
      initGitRepo(path.join(secondRoot, 'web'));
      new RepositoryManifestService(firstRoot).add([{ id: 'api', path: './api' }]);
      new RepositoryManifestService(secondRoot).add([{ id: 'web', path: './web' }]);

      fs.renameSync(firstRoot, relocatedRoot);

      expect(new RepositoryManifestService(relocatedRoot).resolveRepositories()).toEqual([
        { id: 'api', path: path.join(relocatedRoot, 'api'), root: path.join(relocatedRoot, 'api') },
      ]);
      expect(new RepositoryManifestService(secondRoot).resolveRepositories()).toEqual([
        { id: 'web', path: path.join(secondRoot, 'web'), root: path.join(secondRoot, 'web') },
      ]);
    });
  });

  it('does not use legacy topology scoped to another project', () => {
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
      const stored = JSON.parse(fs.readFileSync(path.join(projectRoot, '.hive', 'repositories.json'), 'utf-8'));
      expect(stored.repositories).toEqual([{ id: 'api', path: './api' }]);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).repositoryRoot).toBe(otherProjectRoot);
    });
  });

  it.each([
    { repository: { id: '../escape', path: './api' }, label: 'invalid ID' },
    { repository: { id: 'absolute', path: '/tmp/api' }, label: 'absolute path' },
    { repository: { id: 'empty', path: '' }, label: 'empty path' },
    { repository: { id: 'escape', path: './api/../../../outside' }, label: 'escaping path' },
  ])('rejects an $label without changing stored state', ({ repository }) => {
    withTempEnvironment((projectRoot, configPath) => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const original = `${JSON.stringify({ sandbox: 'none' }, null, 2)}\n`;
      fs.writeFileSync(configPath, original);

      expect(() => new RepositoryManifestService(projectRoot).add([repository])).toThrow('Invalid repository entry');
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
      expect(fs.existsSync(path.join(projectRoot, '.hive', 'repositories.json'))).toBe(false);
    });
  });

  it('prefers an existing local manifest and never falls back to matching legacy topology', () => {
    withTempEnvironment((projectRoot, configPath) => {
      initGitRepo(path.join(projectRoot, 'local'));
      initGitRepo(path.join(projectRoot, 'legacy'));
      fs.mkdirSync(path.join(projectRoot, '.hive'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.hive', 'repositories.json'), JSON.stringify({
        schemaVersion: 1,
        repositories: [{ id: 'local', path: './local' }],
      }));
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        repositoryRoot: projectRoot,
        repositories: [{ id: 'legacy', path: './legacy' }],
      }));

      const status = new RepositoryManifestService(projectRoot).getStatus();
      expect(status.mode).toBe('manifest');
      expect(status.configPath).toBe(path.join(projectRoot, '.hive', 'repositories.json'));
      expect(status.repositories.map(({ id }) => id)).toEqual(['local']);
    });
  });

  it('reports matching legacy topology without migrating it during status', () => {
    withTempEnvironment((projectRoot, configPath) => {
      initGitRepo(path.join(projectRoot, 'api'));
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        repositoryRoot: projectRoot,
        repositories: [{ id: 'api', path: './api' }],
      }));

      const status = new RepositoryManifestService(projectRoot).getStatus();
      expect(status.mode).toBe('manifest');
      expect(status.configPath).toBe(path.join(projectRoot, '.hive', 'repositories.json'));
      expect(fs.existsSync(status.configPath)).toBe(false);
    });
  });

  it('migrates matching legacy topology on update and removes only legacy keys', () => {
    withTempEnvironment((projectRoot, configPath) => {
      initGitRepo(path.join(projectRoot, 'api'));
      initGitRepo(path.join(projectRoot, 'web'));
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        sandbox: 'docker',
        repositoryRoot: projectRoot,
        repositories: [{ id: 'api', path: './api' }],
      }));

      const result = new RepositoryManifestService(projectRoot).add([{ id: 'web', path: './web' }]);
      expect(result.repositories.map(({ id }) => id)).toEqual(['api', 'web']);
      expect(result.legacyCleanup).toBe('removed');
      expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({ sandbox: 'docker' });
    });
  });

  it('blocks status and update when the local manifest is malformed', () => {
    withTempEnvironment((projectRoot, configPath) => {
      fs.mkdirSync(path.join(projectRoot, '.hive'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.hive', 'repositories.json'), '{bad json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ repositoryRoot: projectRoot, repositories: [{ id: 'api', path: './api' }] }));
      const service = new RepositoryManifestService(projectRoot);

      expect(service.getStatus().error).toContain('Invalid project repository manifest');
      expect(() => service.add([])).toThrow('Invalid project repository manifest');
      expect(fs.readFileSync(path.join(projectRoot, '.hive', 'repositories.json'), 'utf-8')).toBe('{bad json');
    });
  });

  it.each([
    { schemaVersion: 2, repositories: [{ id: 'api', path: './api' }] },
    { schemaVersion: 1, repositories: [] },
    { schemaVersion: 1, repositories: [{ id: 'api', path: './api' }], extra: true },
    { schemaVersion: 1, repositories: [{ id: 'api', path: './api', extra: true }] },
  ])('rejects a local manifest outside the exact schema', (manifest) => {
    withTempEnvironment((projectRoot) => {
      fs.mkdirSync(path.join(projectRoot, '.hive'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.hive', 'repositories.json'), JSON.stringify(manifest));
      const service = new RepositoryManifestService(projectRoot);

      expect(service.getStatus().error).toContain('Invalid project repository manifest');
      expect(() => service.add([{ id: 'api', path: './api' }])).toThrow('Invalid project repository manifest');
    });
  });

  it('rejects a manifest directory symlink that redirects writes outside the project', () => {
    withTempEnvironment((projectRoot) => {
      const external = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-manifest-external-'));
      try {
        initGitRepo(path.join(projectRoot, 'api'));
        fs.symlinkSync(external, path.join(projectRoot, '.hive'));
        expect(() => new RepositoryManifestService(projectRoot).add([{ id: 'api', path: './api' }])).toThrow('must stay inside project root');
        expect(fs.existsSync(path.join(external, 'repositories.json'))).toBe(false);
      } finally {
        fs.rmSync(external, { recursive: true, force: true });
      }
    });
  });

  it('reports an external manifest directory symlink instead of falling back during status', () => {
    withTempEnvironment((projectRoot) => {
      const external = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-manifest-status-external-'));
      try {
        initGitRepo(projectRoot);
        fs.symlinkSync(external, path.join(projectRoot, '.hive'));

        expect(new RepositoryManifestService(projectRoot).getStatus()).toMatchObject({
          mode: 'manifest',
          configPath: path.join(projectRoot, '.hive', 'repositories.json'),
          repositories: [],
          error: expect.stringContaining('must stay inside project root'),
          source: 'local',
        });
      } finally {
        fs.rmSync(external, { recursive: true, force: true });
      }
    });
  });

  it('rejects a manifest file symlink that redirects reads outside the project', () => {
    withTempEnvironment((projectRoot) => {
      const external = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-manifest-file-external-'));
      const externalManifest = path.join(external, 'repositories.json');
      try {
        initGitRepo(projectRoot);
        fs.mkdirSync(path.join(projectRoot, '.hive'));
        fs.writeFileSync(externalManifest, JSON.stringify({
          schemaVersion: 1,
          repositories: [{ id: 'root', path: '.' }],
        }));
        fs.symlinkSync(externalManifest, path.join(projectRoot, '.hive', 'repositories.json'));
        const service = new RepositoryManifestService(projectRoot);

        expect(service.getStatus().error).toContain('must stay inside project root');
        expect(() => service.add([{ id: 'root', path: '.' }])).toThrow('must stay inside project root');
      } finally {
        fs.rmSync(external, { recursive: true, force: true });
      }
    });
  });

  it('rejects a local repository symlink before invoking Git outside the project', () => {
    if (process.platform === 'win32') return;
    withTempEnvironment((projectRoot) => {
      const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-local-manifest-external-'));
      const realExecFileSync = execFileSync;
      const gitCwds: string[] = [];
      try {
        initGitRepo(projectRoot);
        initGitRepo(externalRoot);
        fs.symlinkSync(externalRoot, path.join(projectRoot, 'external'));
        fs.mkdirSync(path.join(projectRoot, '.hive'));
        fs.writeFileSync(path.join(projectRoot, '.hive', 'repositories.json'), JSON.stringify({
          schemaVersion: 1,
          repositories: [{ id: 'external', path: './external' }],
        }));
        const gitSpy = spyOn(childProcess, 'execFileSync').mockImplementation(((command, args, options) => {
          if (command === 'git' && options && typeof options === 'object' && 'cwd' in options && typeof options.cwd === 'string') {
            gitCwds.push(fs.realpathSync(options.cwd));
          }
          return realExecFileSync(command, args, options as any);
        }) as typeof execFileSync);
        try {
          const status = new RepositoryManifestService(projectRoot).getStatus();

          expect(gitCwds).not.toContain(externalRoot);
          expect(status.error).toContain('must not be a symlink');
        } finally {
          gitSpy.mockRestore();
        }
      } finally {
        fs.rmSync(externalRoot, { recursive: true, force: true });
      }
    });
  });

  it('keeps downstream Git operations on the canonical repository after a parent symlink swap', () => {
    if (process.platform === 'win32') return;
    withTempEnvironment((projectRoot) => {
      const containedParent = path.join(projectRoot, 'contained');
      const containedRepository = path.join(containedParent, 'api');
      const externalParent = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-manifest-parent-swap-'));
      const externalRepository = path.join(externalParent, 'api');
      const linkedParent = path.join(projectRoot, 'repos');
      try {
        initGitRepo(containedRepository);
        initGitRepo(externalRepository);
        fs.symlinkSync(containedParent, linkedParent);
        fs.mkdirSync(path.join(projectRoot, '.hive'));
        fs.writeFileSync(path.join(projectRoot, '.hive', 'repositories.json'), JSON.stringify({
          schemaVersion: 1,
          repositories: [{ id: 'api', path: './repos/api' }],
        }));
        const repositories = new RepositoryManifestService(projectRoot).resolveRepositories();

        fs.unlinkSync(linkedParent);
        fs.symlinkSync(externalParent, linkedParent);

        expect(execFileSync('git', ['rev-parse', '--show-toplevel'], {
          cwd: repositories[0]!.path,
          encoding: 'utf8',
        }).trim()).toBe(containedRepository);
        expect(repositories[0]).toEqual({
          id: 'api',
          path: containedRepository,
          root: containedRepository,
        });
      } finally {
        fs.rmSync(externalParent, { recursive: true, force: true });
      }
    });
  });

  it('uses generated workspace.json as frozen authority and rejects topology updates', () => {
    withTempEnvironment((projectRoot) => {
      initGitRepo(path.join(projectRoot, 'repos', 'api'));
      const commit = '0123456789abcdef';
      fs.writeFileSync(path.join(projectRoot, 'workspace.json'), JSON.stringify({
        schemaVersion: 1,
        mode: 'adhoc-composite',
        runId: 'manifest-test',
        repos: {
          api: {
            path: 'repos/api',
            repoRoot: path.join(projectRoot, 'repos', 'api'),
            repoPath: path.join(projectRoot, 'repos', 'api'),
            branch: 'hive/adhoc/manifest-test',
            commit,
          },
        },
        baseCommits: { api: commit },
        createdAt: new Date().toISOString(),
      }));
      const service = new RepositoryManifestService(projectRoot);

      expect(service.getStatus()).toMatchObject({
        mode: 'manifest',
        source: 'generated-workspace',
        configPath: path.join(projectRoot, 'workspace.json'),
      });
      expect(() => service.add([{ id: 'api', path: './repos/api' }])).toThrow('cannot be updated from a generated composite workspace');
    });
  });

  it('rejects a partial generated workspace manifest through the canonical parser', () => {
    withTempEnvironment((projectRoot) => {
      initGitRepo(path.join(projectRoot, 'repos', 'api'));
      fs.writeFileSync(path.join(projectRoot, 'workspace.json'), JSON.stringify({
        schemaVersion: 1,
        mode: 'adhoc-composite',
        runId: 'manifest-test',
        repos: { api: { path: 'repos/api' } },
        baseCommits: { api: '0123456789abcdef' },
        createdAt: new Date().toISOString(),
      }));

      expect(() => new RepositoryManifestService(projectRoot).getStatus()).toThrow('Invalid generated composite workspace manifest');
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
