import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import simpleGit, { type SimpleGit } from "simple-git";
import type { ResolvedRepository } from "../types";
import { WorktreeService } from "./worktreeService";

interface TestFixture {
  repoPath: string;
  worktreePath: string;
  feature: string;
  task: string;
  service: WorktreeService;
  repoGit: SimpleGit;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

async function createTempRepo(): Promise<{ repoPath: string; repoGit: SimpleGit }> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "hive-core-worktree-service-test-"));
  tempDirs.push(repoPath);

  const rootGit = simpleGit();
  try {
    await rootGit.raw(["init", "-b", "main", repoPath]);
  } catch {
    await rootGit.raw(["init", repoPath]);
    await simpleGit(repoPath).raw(["branch", "-M", "main"]);
  }

  const repoGit = simpleGit(repoPath);
  await repoGit.raw(["config", "user.email", "test@example.com"]);
  await repoGit.raw(["config", "user.name", "Test User"]);

  await fs.writeFile(path.join(repoPath, "tracked.txt"), "base\n", "utf-8");
  await repoGit.add("tracked.txt");
  await repoGit.commit("chore: base commit");

  return { repoPath, repoGit };
}

async function createFixture(): Promise<TestFixture> {
  const { repoPath, repoGit } = await createTempRepo();
  const feature = "test-feature";
  const task = "01-test-task";
  const service = new WorktreeService({
    baseDir: repoPath,
    hiveDir: path.join(repoPath, ".hive"),
  });

  const worktree = await service.create(feature, task);

  return {
    repoPath,
    worktreePath: worktree.path,
    feature,
    task,
    service,
    repoGit,
  };
}

async function createCommittedFixture(): Promise<TestFixture> {
  const fixture = await createFixture();

  await fs.writeFile(path.join(fixture.worktreePath, "task-change.txt"), "task change\n", "utf-8");
  const result = await fixture.service.commitChanges(fixture.feature, fixture.task, "chore: task change");
  expect(result.committed).toBe(true);

  await fixture.repoGit.checkout("main");

  return fixture;
}

async function createConflictingFixture(): Promise<TestFixture> {
  const fixture = await createFixture();

  await fs.writeFile(path.join(fixture.worktreePath, 'tracked.txt'), 'task change\n', 'utf-8');
  const taskCommit = await fixture.service.commitChanges(
    fixture.feature,
    fixture.task,
    'chore: conflicting task change',
  );
  expect(taskCommit.committed).toBe(true);

  await fixture.repoGit.checkout('main');
  await fs.writeFile(path.join(fixture.repoPath, 'tracked.txt'), 'main change\n', 'utf-8');
  await fixture.repoGit.add('tracked.txt');
  await fixture.repoGit.commit('chore: conflicting main change');

  return fixture;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(git: SimpleGit, branchName: string): Promise<boolean> {
  const branches = await git.branch();
  return branches.all.includes(branchName);
}

async function readHeadBody(targetPath: string): Promise<string> {
  const git = simpleGit(targetPath);
  const body = await git.raw(["log", "-1", "--format=%B"]);
  return body.trimEnd();
}

describe("WorktreeService merge and commit messages", () => {
  it("uses logical feature names for indexed worktree storage and branch naming", async () => {
    const { repoPath } = await createTempRepo();
    const service = new WorktreeService({
      baseDir: repoPath,
      hiveDir: path.join(repoPath, ".hive"),
    });

    await fs.mkdir(path.join(repoPath, ".hive", "features", "03_test-feature", "tasks", "01-test-task"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoPath, ".hive", "features", "03_test-feature", "tasks", "01-test-task", "status.json"),
      JSON.stringify({ status: "pending", origin: "plan" }),
      "utf-8",
    );

    const worktree = await service.create("test-feature", "01-test-task");

    expect(worktree.path).toBe(path.join(repoPath, ".hive", ".worktrees", "test-feature", "01-test-task"));
    expect(worktree.branch).toBe("hive/test-feature/01-test-task");
    expect(await service.get("test-feature", "01-test-task")).not.toBeNull();
  });

  it("uses a custom commit message verbatim, including body text", async () => {
    const fixture = await createFixture();
    await fs.writeFile(path.join(fixture.worktreePath, "custom-commit.txt"), "custom\n", "utf-8");

    const message = "feat(core): custom subject\n\nbody line 1\nbody line 2";
    const result = await fixture.service.commitChanges(fixture.feature, fixture.task, message);

    expect(result.committed).toBe(true);
    expect(await readHeadBody(fixture.worktreePath)).toBe(message);
  });

  it("falls back when commit message is an empty string", async () => {
    const fixture = await createFixture();
    await fs.writeFile(path.join(fixture.worktreePath, "empty-commit-message.txt"), "empty\n", "utf-8");

    await fixture.service.commitChanges(fixture.feature, fixture.task, "");

    expect(await readHeadBody(fixture.worktreePath)).toBe("hive(01-test-task): task changes");
  });

  it("uses a custom merge message verbatim, including body text", async () => {
    const fixture = await createCommittedFixture();
    const message = "feat(core): merge task\n\nmerge body";

    const result = await fixture.service.merge(fixture.feature, fixture.task, "merge", message);

    expect(result.success).toBe(true);
    expect(result.strategy).toBe('merge');
    expect(result.conflictState).toBe('none');
    expect(result.cleanup).toEqual({
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
    });
    expect(await readHeadBody(fixture.repoPath)).toBe(message);
  });

  it("uses a custom squash message verbatim, including body text", async () => {
    const fixture = await createCommittedFixture();
    const message = "feat(core): squash task\n\nsquash body";

    const result = await fixture.service.merge(fixture.feature, fixture.task, "squash", message);

    expect(result.success).toBe(true);
    expect(result.strategy).toBe('squash');
    expect(result.conflictState).toBe('none');
    expect(result.cleanup).toEqual({
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
    });
    expect(await readHeadBody(fixture.repoPath)).toBe(message);
  });

  it('returns helper-friendly merge details and preserves branch/worktree by default', async () => {
    const fixture = await createCommittedFixture();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge');

    expect(result).toMatchObject({
      success: true,
      merged: true,
      strategy: 'merge',
      filesChanged: ['task-change.txt'],
      conflicts: [],
      conflictState: 'none',
      cleanup: {
        worktreeRemoved: false,
        branchDeleted: false,
        pruned: false,
      },
    });
    expect(typeof result.sha).toBe('string');
    expect(await pathExists(fixture.worktreePath)).toBe(true);
    expect(await branchExists(fixture.repoGit, 'hive/test-feature/01-test-task')).toBe(true);
  });

  it('removes the worktree but keeps the branch when cleanup is worktree', async () => {
    const fixture = await createCommittedFixture();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', undefined, {
      cleanup: 'worktree',
    });

    expect(result).toMatchObject({
      success: true,
      merged: true,
      strategy: 'merge',
      conflictState: 'none',
      cleanup: {
        worktreeRemoved: true,
        branchDeleted: false,
        pruned: true,
      },
    });
    expect(await pathExists(fixture.worktreePath)).toBe(false);
    expect(await branchExists(fixture.repoGit, 'hive/test-feature/01-test-task')).toBe(true);
  });

  it('removes the worktree and deletes the branch when cleanup is worktree+branch', async () => {
    const fixture = await createCommittedFixture();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', undefined, {
      cleanup: 'worktree+branch',
    });

    expect(result).toMatchObject({
      success: true,
      merged: true,
      strategy: 'merge',
      conflictState: 'none',
      cleanup: {
        worktreeRemoved: true,
        branchDeleted: true,
        pruned: true,
      },
    });
    expect(await pathExists(fixture.worktreePath)).toBe(false);
    expect(await branchExists(fixture.repoGit, 'hive/test-feature/01-test-task')).toBe(false);
  });

  it('aborts merge conflicts by default and reports the conflict state', async () => {
    const fixture = await createConflictingFixture();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge');

    expect(result).toMatchObject({
      success: false,
      merged: false,
      strategy: 'merge',
      filesChanged: ['tracked.txt'],
      conflicts: ['tracked.txt'],
      conflictState: 'aborted',
      cleanup: {
        worktreeRemoved: false,
        branchDeleted: false,
        pruned: false,
      },
      error: 'Merge conflicts detected',
    });
    const status = await fixture.repoGit.status();
    expect(status.conflicted).toEqual([]);
  });

  it('preserves merge conflicts when requested', async () => {
    const fixture = await createConflictingFixture();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', undefined, {
      preserveConflicts: true,
    });

    expect(result).toMatchObject({
      success: false,
      merged: false,
      strategy: 'merge',
      filesChanged: ['tracked.txt'],
      conflicts: ['tracked.txt'],
      conflictState: 'preserved',
      cleanup: {
        worktreeRemoved: false,
        branchDeleted: false,
        pruned: false,
      },
      error: 'Merge conflicts detected',
    });
    const status = await fixture.repoGit.status();
    expect(status.conflicted).toContain('tracked.txt');
  });

  it("rejects rebase plus custom message", async () => {
    const fixture = await createCommittedFixture();

    expect(await fixture.service.merge(fixture.feature, fixture.task, "rebase", "feat: custom\n\nbody")).toEqual(
      {
        success: false,
        merged: false,
        strategy: 'rebase',
        filesChanged: [],
        conflicts: [],
        conflictState: 'none',
        cleanup: {
          worktreeRemoved: false,
          branchDeleted: false,
          pruned: false,
        },
        error: "Custom merge message is not supported for rebase strategy",
      },
    );
  });
});

interface CompositeFixture {
  projectRoot: string;
  repos: Record<string, { path: string; git: SimpleGit }>;
  feature: string;
  task: string;
  service: WorktreeService;
}

async function makeRepo(rootDir: string, name: string): Promise<{ path: string; git: SimpleGit }> {
  const repoPath = path.join(rootDir, name);
  await fs.mkdir(repoPath, { recursive: true });
  const rootGit = simpleGit();
  try {
    await rootGit.raw(["init", "-b", "main", repoPath]);
  } catch {
    await rootGit.raw(["init", repoPath]);
    await simpleGit(repoPath).raw(["branch", "-M", "main"]);
  }
  const git = simpleGit(repoPath);
  await git.raw(["config", "user.email", "test@example.com"]);
  await git.raw(["config", "user.name", "Test User"]);
  await fs.writeFile(path.join(repoPath, "README.md"), `# ${name}\n`, "utf-8");
  await git.add("README.md");
  await git.commit(`chore: ${name} base`);
  return { path: repoPath, git };
}

async function createCompositeFixture(opts: {
  repoIds: string[];
  feature?: string;
  task?: string;
}): Promise<CompositeFixture> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hive-composite-test-"));
  tempDirs.push(projectRoot);
  const feature = opts.feature ?? 'multi-feature';
  const task = opts.task ?? '01-multi-task';
  const repos: Record<string, { path: string; git: SimpleGit }> = {};
  const resolved: ResolvedRepository[] = [];
  for (const id of opts.repoIds) {
    const r = await makeRepo(projectRoot, id);
    repos[id] = r;
    resolved.push({ id, path: r.path, root: r.path });
  }

  const featureDir = path.join(projectRoot, ".hive", "features", `01_${feature}`, "tasks", task);
  await fs.mkdir(featureDir, { recursive: true });
  await fs.writeFile(
    path.join(featureDir, "status.json"),
    JSON.stringify({ status: "pending", origin: "plan", repoIds: opts.repoIds }),
    "utf-8",
  );

  const service = new WorktreeService({
    baseDir: projectRoot,
    hiveDir: path.join(projectRoot, ".hive"),
    repositoryResolver: { resolveRepositories: () => resolved },
    taskRepoResolver: { resolveTaskRepoIds: () => opts.repoIds },
  });

  return { projectRoot, repos, feature, task, service };
}

describe("WorktreeService composite workspaces", () => {
  it("creates a composite workspace with workspace.json for a single-repo task", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const wt = await fx.service.create(fx.feature, fx.task);

    expect(wt.mode).toBe('composite');
    const compositeRoot = path.join(fx.projectRoot, ".hive", ".worktrees", fx.feature, fx.task);
    expect(wt.path).toBe(compositeRoot);
    expect(wt.workspacePath).toBe(compositeRoot);
    expect(wt.repos).toBeDefined();
    expect(wt.repos!['api'].path).toBe(path.join(compositeRoot, 'repos', 'api'));
    expect(wt.repos!['api'].branch).toBe(`hive/api/${fx.feature}/${fx.task}`);
    expect(wt.branch).toBe(wt.repos!['api'].branch);
    expect(typeof wt.commit).toBe('string');
    expect(wt.baseCommits).toBeDefined();
    expect(wt.baseCommits!['api']).toBe(wt.repos!['api'].commit);

    const workspaceJsonRaw = await fs.readFile(path.join(compositeRoot, 'workspace.json'), 'utf-8');
    const workspaceJson = JSON.parse(workspaceJsonRaw);
    expect(workspaceJson.feature).toBe(fx.feature);
    expect(workspaceJson.task).toBe(fx.task);
    expect(workspaceJson.repos.api.branch).toBe(wt.repos!['api'].branch);
    expect(workspaceJson.repos.api.path).toBe('repos/api');
  });

  it("creates per-repo worktrees for multi-repo composite tasks", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);

    expect(wt.mode).toBe('composite');
    expect(Object.keys(wt.repos!).sort()).toEqual(['api', 'web-ui']);
    for (const id of ['api', 'web-ui']) {
      const repoWtPath = path.join(wt.path, 'repos', id);
      expect(wt.repos![id].path).toBe(repoWtPath);
      expect(await pathExists(repoWtPath)).toBe(true);
      expect(wt.repos![id].branch).toBe(`hive/${id}/${fx.feature}/${fx.task}`);
      expect(await branchExists(fx.repos[id].git, wt.repos![id].branch)).toBe(true);
      expect(wt.baseCommits![id]).toBe(wt.repos![id].commit);
    }

    // Persisted base commits in task status
    const statusRaw = await fs.readFile(
      path.join(fx.projectRoot, '.hive', 'features', `01_${fx.feature}`, 'tasks', fx.task, 'status.json'),
      'utf-8',
    );
    const status = JSON.parse(statusRaw);
    expect(status.baseCommits).toEqual(wt.baseCommits);
    expect(status.baseCommit).toBe(wt.baseCommits!['api']);
  });

  it("aggregate get returns composite info matching create()", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const created = await fx.service.create(fx.feature, fx.task);
    const fetched = await fx.service.get(fx.feature, fx.task);
    expect(fetched).not.toBeNull();
    expect(fetched!.mode).toBe('composite');
    expect(fetched!.path).toBe(created.path);
    expect(fetched!.workspacePath).toBe(created.workspacePath);
    expect(Object.keys(fetched!.repos!).sort()).toEqual(['api', 'web-ui']);
    expect(fetched!.repos!['api'].branch).toBe(created.repos!['api'].branch);
    expect(fetched!.branch).toBe(created.branch);
  });

  it("remove cleans up all per-repo worktrees and the composite root", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    expect(await pathExists(wt.path)).toBe(true);

    const result = await fx.service.remove(fx.feature, fx.task, true);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.pruned).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(await pathExists(wt.path)).toBe(false);
    for (const id of ['api', 'web-ui']) {
      expect(await branchExists(fx.repos[id].git, `hive/${id}/${fx.feature}/${fx.task}`)).toBe(false);
    }
  });

  it("preserves legacy single-root paths when no manifest/task resolver is provided", async () => {
    const { repoPath } = await createTempRepo();
    const service = new WorktreeService({
      baseDir: repoPath,
      hiveDir: path.join(repoPath, ".hive"),
    });
    const wt = await service.create('legacy-feature', '01-legacy');
    expect(wt.mode ?? 'legacy').toBe('legacy');
    expect(wt.path).toBe(path.join(repoPath, '.hive', '.worktrees', 'legacy-feature', '01-legacy'));
    expect(wt.branch).toBe('hive/legacy-feature/01-legacy');
    expect(wt.repos).toBeUndefined();
    expect(wt.workspacePath).toBeUndefined();
  });

  it("create fails when manifest is missing a task-required repo", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hive-composite-test-"));
    tempDirs.push(projectRoot);
    const api = await makeRepo(projectRoot, 'api');
    const service = new WorktreeService({
      baseDir: projectRoot,
      hiveDir: path.join(projectRoot, ".hive"),
      repositoryResolver: { resolveRepositories: () => [{ id: 'api', path: api.path, root: api.path }] },
      taskRepoResolver: { resolveTaskRepoIds: () => ['api', 'web-ui'] },
    });
    await expect(service.create('f', '01-t')).rejects.toThrow(/web-ui/);
    // No composite root left behind
    expect(await pathExists(path.join(projectRoot, '.hive', '.worktrees', 'f', '01-t'))).toBe(false);
  });

  it("create fails before legacy fallback when a manifest-backed task has no repo IDs", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hive-composite-test-"));
    tempDirs.push(projectRoot);
    const api = await makeRepo(projectRoot, 'api');
    const feature = 'multi-feature';
    const task = '01-missing-repos';
    const service = new WorktreeService({
      baseDir: projectRoot,
      hiveDir: path.join(projectRoot, ".hive"),
      repositoryResolver: { resolveRepositories: () => [{ id: 'api', path: api.path, root: api.path }] },
      taskRepoResolver: { resolveTaskRepoIds: () => undefined },
    });

    await expect(service.create(feature, task)).rejects.toThrow(/must declare Repos/);
    expect(await pathExists(path.join(projectRoot, '.hive', '.worktrees', feature, task))).toBe(false);
    expect(await branchExists(api.git, `hive/${feature}/${task}`)).toBe(false);
    expect(await branchExists(api.git, `hive/api/${feature}/${task}`)).toBe(false);
  });

  it("rolls back first repo worktree and branch when a later repo fails to create", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hive-composite-test-"));
    tempDirs.push(projectRoot);
    const api = await makeRepo(projectRoot, 'api');
    // 'web' resolved path does not exist => git worktree add will fail
    const service = new WorktreeService({
      baseDir: projectRoot,
      hiveDir: path.join(projectRoot, ".hive"),
      repositoryResolver: () => [
        { id: 'api', path: api.path, root: api.path },
        { id: 'web', path: path.join(projectRoot, 'does-not-exist'), root: path.join(projectRoot, 'does-not-exist') },
      ],
      taskRepoResolver: { resolveTaskRepoIds: () => ['api', 'web'] },
    } as any);

    const feature = 'f';
    const task = '01-t';
    await expect(service.create(feature, task)).rejects.toThrow();

    // Repo 1 worktree and branch must be cleaned up
    const repo1Wt = path.join(projectRoot, '.hive', '.worktrees', feature, task, 'repos', 'api');
    expect(await pathExists(repo1Wt)).toBe(false);
    expect(await branchExists(api.git, `hive/api/${feature}/${task}`)).toBe(false);
    // Composite root and workspace.json must be cleaned up
    expect(await pathExists(path.join(projectRoot, '.hive', '.worktrees', feature, task, 'workspace.json'))).toBe(false);
    expect(await pathExists(path.join(projectRoot, '.hive', '.worktrees', feature, task))).toBe(false);
  });

  it("hasUncommittedChanges returns true when any composite repo has changes", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    expect(await fx.service.hasUncommittedChanges(fx.feature, fx.task)).toBe(false);
    await fs.writeFile(path.join(wt.repos!['web-ui'].path, 'new.txt'), 'x\n', 'utf-8');
    expect(await fx.service.hasUncommittedChanges(fx.feature, fx.task)).toBe(true);
  });

  it("workspace.json persists source repo root and path alongside branch/commit", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);

    const compositeRoot = path.join(fx.projectRoot, ".hive", ".worktrees", fx.feature, fx.task);
    const raw = await fs.readFile(path.join(compositeRoot, 'workspace.json'), 'utf-8');
    const manifest = JSON.parse(raw);
    for (const id of ['api', 'web-ui']) {
      expect(manifest.repos[id].path).toBe(`repos/${id}`);
      expect(manifest.repos[id].repoRoot).toBe(fx.repos[id].path);
      expect(manifest.repos[id].repoPath).toBe(fx.repos[id].path);
      expect(typeof manifest.repos[id].branch).toBe('string');
      expect(typeof manifest.repos[id].commit).toBe('string');
    }
  });

  it("create fails before mutating any repo when composite root already exists without a manifest", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const compositeRoot = path.join(fx.projectRoot, ".hive", ".worktrees", fx.feature, fx.task);
    await fs.mkdir(compositeRoot, { recursive: true });
    await fs.writeFile(path.join(compositeRoot, 'stray.txt'), 'pre-existing\n', 'utf-8');

    await expect(fx.service.create(fx.feature, fx.task)).rejects.toThrow(/already exists/);

    // No per-repo worktree should have been created
    for (const id of ['api', 'web-ui']) {
      expect(await pathExists(path.join(compositeRoot, 'repos', id))).toBe(false);
      expect(await branchExists(fx.repos[id].git, `hive/${id}/${fx.feature}/${fx.task}`)).toBe(false);
    }
    // Stray file untouched
    expect(await pathExists(path.join(compositeRoot, 'stray.txt'))).toBe(true);
  });

  it("create fails before mutating any repo when a branch collision exists in a later repo", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const collidingBranch = `hive/web-ui/${fx.feature}/${fx.task}`;
    // Pre-create the colliding branch in repo 'web-ui'
    await fx.repos['web-ui'].git.raw(['branch', collidingBranch]);

    await expect(fx.service.create(fx.feature, fx.task)).rejects.toThrow(/Branch collision/);

    const compositeRoot = path.join(fx.projectRoot, ".hive", ".worktrees", fx.feature, fx.task);
    // No per-repo worktree should have been created in either repo
    expect(await pathExists(path.join(compositeRoot, 'repos', 'api'))).toBe(false);
    expect(await pathExists(path.join(compositeRoot, 'repos', 'web-ui'))).toBe(false);
    // No new branch in the earlier repo
    expect(await branchExists(fx.repos['api'].git, `hive/api/${fx.feature}/${fx.task}`)).toBe(false);
    // The colliding branch in web-ui still exists, unchanged
    expect(await branchExists(fx.repos['web-ui'].git, collidingBranch)).toBe(true);
  });

  it("list aggregates composite workspaces alongside legacy entries", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const created = await fx.service.create(fx.feature, fx.task);
    const listed = await fx.service.list(fx.feature);
    expect(listed).toHaveLength(1);
    expect(listed[0].mode).toBe('composite');
    expect(listed[0].path).toBe(created.path);
    expect(listed[0].workspacePath).toBe(created.workspacePath);
    expect(Object.keys(listed[0].repos!).sort()).toEqual(['api', 'web-ui']);
    expect(listed[0].repos!['api'].branch).toBe(`hive/api/${fx.feature}/${fx.task}`);
  });

  it("cleanup removes a stale composite workspace whose per-repo worktree was destroyed", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);

    // Make the composite stale by deleting one repo worktree directory directly (git no longer sees a valid HEAD).
    await fs.rm(wt.repos!['web-ui'].path, { recursive: true, force: true });

    const result = await fx.service.cleanup(fx.feature);
    expect(result.removed).toContain(wt.path);
    expect(result.pruned).toBe(true);
    expect(await pathExists(wt.path)).toBe(false);
  });
});
