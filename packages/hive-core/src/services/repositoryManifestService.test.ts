import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryManifestService } from './repositoryManifestService';

const makeTempProject = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hive-repo-manifest-'));

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

describe('RepositoryManifestService status', () => {
  it('reports legacy-root mode when no manifest exists and the project root is a git repo', () => {
    withTempProject((projectRoot) => {
      initGitRepo(projectRoot);

      const status = new RepositoryManifestService(projectRoot).getStatus();

      expect(status.mode).toBe('legacy-root');
      expect(status.repositories).toEqual([{ id: 'root', path: '.', root: projectRoot }]);
    });
  });

  it('reports missing-manifest mode when no manifest exists and the project root is not a git repo', () => {
    withTempProject((projectRoot) => {
      const status = new RepositoryManifestService(projectRoot).getStatus();

      expect(status.mode).toBe('missing-manifest');
      expect(status.repositories).toEqual([]);
      expect(status.error).toContain('Repository manifest is required');
    });
  });
});

describe('RepositoryManifestService discovery', () => {
  it('discovers bounded in-root git repositories while skipping hidden hive and dependency folders', () => {
    withTempProject((projectRoot) => {
      initGitRepo(path.join(projectRoot, 'api'));
      initGitRepo(path.join(projectRoot, 'apps', 'web-ui'));
      initGitRepo(path.join(projectRoot, '.hive', 'ignored'));
      initGitRepo(path.join(projectRoot, 'node_modules', 'ignored'));

      const result = new RepositoryManifestService(projectRoot).discover();

      expect(result.truncated).toBe(false);
      expect(result.candidates.map((candidate) => candidate.path)).toEqual(['./api', './apps/web-ui']);
      expect(result.candidates.map((candidate) => candidate.id)).toEqual(['api', 'web-ui']);
    });
  });
});

describe('RepositoryManifestService add', () => {
  it('creates a project manifest and preserves existing project config fields', () => {
    withTempProject((projectRoot) => {
      const hiveDir = path.join(projectRoot, '.hive');
      fs.mkdirSync(hiveDir, { recursive: true });
      fs.writeFileSync(
        path.join(hiveDir, 'agent-hive.json'),
        JSON.stringify({ sandbox: 'docker', disableSkills: ['example'] }, null, 2),
      );
      initGitRepo(path.join(projectRoot, 'api'));

      const result = new RepositoryManifestService(projectRoot).add([
        { id: 'api', path: './api' },
      ]);

      expect(result.added).toEqual(['api']);
      expect(result.repositories).toEqual([{ id: 'api', path: './api', root: path.join(projectRoot, 'api') }]);
      const stored = JSON.parse(fs.readFileSync(path.join(hiveDir, 'agent-hive.json'), 'utf-8'));
      expect(stored.sandbox).toBe('docker');
      expect(stored.disableSkills).toEqual(['example']);
      expect(stored.repositories).toEqual([{ id: 'api', path: './api' }]);
    });
  });

  it('is atomic when any added repository is invalid', () => {
    withTempProject((projectRoot) => {
      const hiveDir = path.join(projectRoot, '.hive');
      fs.mkdirSync(hiveDir, { recursive: true });
      fs.writeFileSync(
        path.join(hiveDir, 'agent-hive.json'),
        JSON.stringify({ repositories: [{ id: 'api', path: './api' }] }, null, 2),
      );
      initGitRepo(path.join(projectRoot, 'api'));
      initGitRepo(path.join(projectRoot, 'web'));

      expect(() => new RepositoryManifestService(projectRoot).add([
        { id: 'web', path: './web' },
        { id: 'ghost', path: './missing' },
      ])).toThrow('Repository path does not exist');

      const stored = JSON.parse(fs.readFileSync(path.join(hiveDir, 'agent-hive.json'), 'utf-8'));
      expect(stored.repositories).toEqual([{ id: 'api', path: './api' }]);
    });
  });

  it('rejects blank and absolute repository paths before writing', () => {
    withTempProject((projectRoot) => {
      initGitRepo(projectRoot);
      const service = new RepositoryManifestService(projectRoot);

      expect(() => service.add([{ id: 'blank', path: '   ' }])).toThrow(
        'Repository path must be a non-empty string for repository ID: blank',
      );
      expect(() => service.add([{ id: 'absolute', path: projectRoot }])).toThrow(
        `Repository path must be project-relative: ${projectRoot}`,
      );
      expect(fs.existsSync(path.join(projectRoot, '.hive', 'agent-hive.json'))).toBe(false);
    });
  });
});
