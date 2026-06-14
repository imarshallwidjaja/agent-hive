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

async function createNetZeroCommittedFixture(): Promise<TestFixture> {
  const fixture = await createFixture();

  await fs.writeFile(path.join(fixture.worktreePath, "tracked.txt"), "transient task change\n", "utf-8");
  const transient = await fixture.service.commitChanges(fixture.feature, fixture.task, "chore: transient task change");
  expect(transient.committed).toBe(true);

  await fs.writeFile(path.join(fixture.worktreePath, "tracked.txt"), "base\n", "utf-8");
  const reverted = await fixture.service.commitChanges(fixture.feature, fixture.task, "revert: transient task change");
  expect(reverted.committed).toBe(true);

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

  for (const strategy of ['merge', 'squash', 'rebase'] as const) {
    it(`returns a cleanup-eligible no-op for a net-zero ${strategy} task merge`, async () => {
      const fixture = await createNetZeroCommittedFixture();
      const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

      const result = await fixture.service.merge(fixture.feature, fixture.task, strategy, undefined, {
        cleanup: 'worktree+branch',
      });

      expect(result).toMatchObject({
        success: true,
        merged: false,
        strategy,
        reason: 'nothing_to_merge',
        reasonCode: 'NO_TRACKED_CHANGES',
        filesChanged: [],
        conflicts: [],
        conflictState: 'none',
        cleanupEligible: true,
        taskUpdateRecommended: true,
        cleanup: {
          worktreeRemoved: true,
          branchDeleted: true,
          pruned: true,
        },
      });
      expect('sha' in result).toBe(false);
      expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
      expect(await pathExists(fixture.worktreePath)).toBe(false);
      expect(await branchExists(fixture.repoGit, 'hive/test-feature/01-test-task')).toBe(false);
    });
  }

  it('blocks direct branch deletion when the task branch has unmerged commits', async () => {
    const fixture = await createCommittedFixture();

    await expect(fixture.service.remove(fixture.feature, fixture.task, true)).rejects.toThrow(
      /unmerged commits|hive_merge|discard/i,
    );

    expect(await pathExists(fixture.worktreePath)).toBe(true);
    expect(await branchExists(fixture.repoGit, 'hive/test-feature/01-test-task')).toBe(true);
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

describe("WorktreeService composite diff aggregation", () => {
  it("returns repo-qualified files and per-repo details for a single-repo composite task", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const wt = await fx.service.create(fx.feature, fx.task);

    await fs.writeFile(path.join(wt.repos!['api'].path, 'new.txt'), 'hello\n', 'utf-8');

    const diff = await fx.service.getDiff(fx.feature, fx.task);

    expect(diff.hasDiff).toBe(true);
    expect(diff.repos).toBeDefined();
    expect(Object.keys(diff.repos!).sort()).toEqual(['api']);
    expect(diff.repos!['api'].hasDiff).toBe(true);
    expect(diff.repos!['api'].filesChanged).toContain('new.txt');
    expect(diff.filesChanged).toContain('api:new.txt');
    expect(diff.insertions).toBeGreaterThanOrEqual(1);
  });

  it("aggregates diff across multiple repos with mixed change states", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);

    // Only modify the api repo
    await fs.writeFile(path.join(wt.repos!['api'].path, 'a.txt'), 'a\n', 'utf-8');

    const diff = await fx.service.getDiff(fx.feature, fx.task);

    expect(diff.hasDiff).toBe(true);
    expect(diff.repos!['api'].hasDiff).toBe(true);
    expect(diff.repos!['web-ui'].hasDiff).toBe(false);
    expect(diff.filesChanged).toContain('api:a.txt');
    expect(diff.filesChanged.every(f => !f.startsWith('web-ui:'))).toBe(true);
  });

  it("returns hasDiff=false when no composite repo has changes", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);

    const diff = await fx.service.getDiff(fx.feature, fx.task);

    expect(diff.hasDiff).toBe(false);
    expect(diff.filesChanged).toEqual([]);
    expect(diff.insertions).toBe(0);
    expect(diff.deletions).toBe(0);
    expect(Object.keys(diff.repos!).sort()).toEqual(['api', 'web-ui']);
    expect(diff.repos!['api'].hasDiff).toBe(false);
    expect(diff.repos!['web-ui'].hasDiff).toBe(false);
  });

  it("preserves legacy diff behavior when no manifest is configured", async () => {
    const { repoPath } = await createTempRepo();
    const service = new WorktreeService({
      baseDir: repoPath,
      hiveDir: path.join(repoPath, ".hive"),
    });
    const feature = 'legacy-diff';
    const task = '01-legacy';
    const wt = await service.create(feature, task);
    await fs.writeFile(path.join(wt.path, 'legacy-change.txt'), 'legacy\n', 'utf-8');

    const diff = await service.getDiff(feature, task);

    expect(diff.hasDiff).toBe(true);
    expect(diff.repos).toBeUndefined();
    expect(diff.filesChanged).toContain('legacy-change.txt');
  });
});

describe("WorktreeService composite commit aggregation", () => {
  it("commits a single-repo composite task and returns aggregate sha", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    await fs.writeFile(path.join(wt.repos!['api'].path, 'change.txt'), 'x\n', 'utf-8');

    const result = await fx.service.commitChanges(fx.feature, fx.task, 'feat: api change');

    expect(result.committed).toBe(true);
    expect(result.partial).not.toBe(true);
    expect(result.repos).toBeDefined();
    expect(result.repos!['api'].committed).toBe(true);
    expect(typeof result.repos!['api'].sha).toBe('string');
    expect(result.repos!['api'].sha.length).toBeGreaterThan(0);
    expect(result.sha).toBe(result.repos!['api'].sha);
  });

  it("commits multiple repos in stable repo ID order when all have changes", async () => {
    const fx = await createCompositeFixture({ repoIds: ['web-ui', 'api'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    await fs.writeFile(path.join(wt.repos!['api'].path, 'a.txt'), 'a\n', 'utf-8');
    await fs.writeFile(path.join(wt.repos!['web-ui'].path, 'w.txt'), 'w\n', 'utf-8');

    const result = await fx.service.commitChanges(fx.feature, fx.task, 'feat: multi');

    expect(result.committed).toBe(true);
    expect(result.partial).not.toBe(true);
    expect(Object.keys(result.repos!)).toEqual(['api', 'web-ui']);
    expect(result.repos!['api'].committed).toBe(true);
    expect(result.repos!['web-ui'].committed).toBe(true);
  });

  it("commits only changed repos and reports no-change for the rest as success", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    await fs.writeFile(path.join(wt.repos!['api'].path, 'a.txt'), 'a\n', 'utf-8');

    const result = await fx.service.commitChanges(fx.feature, fx.task, 'feat: partial change');

    expect(result.committed).toBe(true);
    expect(result.partial).not.toBe(true);
    expect(result.repos!['api'].committed).toBe(true);
    expect(result.repos!['web-ui'].committed).toBe(false);
    expect(result.repos!['web-ui'].message).toMatch(/no changes/i);
  });

  it("returns committed=false and no error when no composite repo has changes", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);

    const result = await fx.service.commitChanges(fx.feature, fx.task, 'feat: nothing');

    expect(result.committed).toBe(false);
    expect(result.partial).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.message).toBe('No changes to commit');
    expect(result.repos!['api'].committed).toBe(false);
    expect(result.repos!['web-ui'].committed).toBe(false);
    // Aggregate sha is the first repo (in stable ID order) HEAD.
    const firstRepoHead = (await simpleGit(wt.repos!['api'].path).revparse(['HEAD'])).trim();
    expect(result.sha).toBe(firstRepoHead);
    expect(result.sha).toBe(result.repos!['api'].sha);
  });

  it("uses first repo HEAD as top-level sha when first repo has no changes but a later repo does", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    // Only the second repo (web-ui in stable order) has changes; api has none.
    await fs.writeFile(path.join(wt.repos!['web-ui'].path, 'w.txt'), 'w\n', 'utf-8');

    const result = await fx.service.commitChanges(fx.feature, fx.task, 'feat: only second');

    expect(result.committed).toBe(true);
    expect(result.partial).not.toBe(true);
    expect(result.repos!['api'].committed).toBe(false);
    expect(result.repos!['web-ui'].committed).toBe(true);
    // Top-level sha is the first repo (api) HEAD, NOT the committed web-ui sha.
    const apiHead = (await simpleGit(wt.repos!['api'].path).revparse(['HEAD'])).trim();
    expect(result.sha).toBe(apiHead);
    expect(result.sha).toBe(result.repos!['api'].sha);
    expect(result.sha).not.toBe(result.repos!['web-ui'].sha);
    expect(result.message).toBe('No changes to commit');
  });

  it("reports partial=true and error when a later repo commit fails after an earlier success", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    await fs.writeFile(path.join(wt.repos!['api'].path, 'a.txt'), 'a\n', 'utf-8');
    await fs.writeFile(path.join(wt.repos!['web-ui'].path, 'w.txt'), 'w\n', 'utf-8');

    // Sabotage web-ui by removing its worktree directory after staging would otherwise succeed.
    await fs.rm(wt.repos!['web-ui'].path, { recursive: true, force: true });

    const result = await fx.service.commitChanges(fx.feature, fx.task, 'feat: partial fail');

    expect(result.committed).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.error).toBeDefined();
    expect(result.repos!['api'].committed).toBe(true);
    expect(result.repos!['web-ui'].committed).toBe(false);
  });

  it("preserves legacy single-repo commit shape when no manifest is configured", async () => {
    const fixture = await createFixture();
    await fs.writeFile(path.join(fixture.worktreePath, 'legacy.txt'), 'legacy\n', 'utf-8');

    const result = await fixture.service.commitChanges(fixture.feature, fixture.task, 'chore: legacy commit');

    expect(result.committed).toBe(true);
    expect(typeof result.sha).toBe('string');
    expect(result.sha.length).toBeGreaterThan(0);
    expect(result.repos).toBeUndefined();
    expect(result.partial).toBeUndefined();
  });
});

describe("WorktreeService composite merge aggregation", () => {
  async function commitChangeInRepo(
    fx: CompositeFixture,
    repoId: string,
    file: string,
    content: string,
  ): Promise<void> {
    const wt = await fx.service.get(fx.feature, fx.task);
    const repoWt = wt!.repos![repoId].path;
    await fs.writeFile(path.join(repoWt, file), content, 'utf-8');
    const g = simpleGit(repoWt);
    await g.add('-A');
    await g.commit(`chore: ${repoId} ${file}`);
  }

  async function commitNetZeroChangeInRepo(fx: CompositeFixture, repoId: string): Promise<void> {
    const wt = await fx.service.get(fx.feature, fx.task);
    const repoWt = wt!.repos![repoId].path;
    const g = simpleGit(repoWt);
    await fs.writeFile(path.join(repoWt, 'README.md'), `${repoId} transient\n`, 'utf-8');
    await g.add('-A');
    await g.commit(`chore: ${repoId} transient`);
    await fs.writeFile(path.join(repoWt, 'README.md'), `# ${repoId}\n`, 'utf-8');
    await g.add('-A');
    await g.commit(`revert: ${repoId} transient`);
  }

  it("merges a single-repo composite task into the source repo's current branch", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'task.txt', 'task\n');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge');

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.partial).toBeUndefined();
    expect(result.repos).toBeDefined();
    expect(result.repos!['api'].success).toBe(true);
    expect(result.repos!['api'].merged).toBe(true);
    expect(result.filesChanged).toContain('api:task.txt');
    expect(result.conflicts).toEqual([]);
    expect(result.conflictState).toBe('none');
    // Source repo HEAD on main now has the task.txt
    const apiHeadBody = await readHeadBody(fx.repos['api'].path);
    expect(apiHeadBody).toMatch(/merge|task/);
  });

  it("merges multiple composite repos in stable repo ID order with flattened files", async () => {
    const fx = await createCompositeFixture({ repoIds: ['web-ui', 'api'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge');

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.partial).toBeUndefined();
    expect(Object.keys(result.repos!)).toEqual(['api', 'web-ui']);
    expect(result.repos!['api'].success).toBe(true);
    expect(result.repos!['web-ui'].success).toBe(true);
    expect(result.filesChanged.sort()).toEqual(['api:a.txt', 'web-ui:w.txt']);
    expect(result.conflicts).toEqual([]);
  });

  it("uses a custom merge message verbatim in every composite repo", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    const message = 'feat(core): multi merge\n\nbody line';
    const result = await fx.service.merge(fx.feature, fx.task, 'merge', message);

    expect(result.success).toBe(true);
    expect(await readHeadBody(fx.repos['api'].path)).toBe(message);
    expect(await readHeadBody(fx.repos['web-ui'].path)).toBe(message);
  });

  it("uses a custom squash message verbatim in every composite repo", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    const message = 'feat(core): squash multi\n\nsquash body';
    const result = await fx.service.merge(fx.feature, fx.task, 'squash', message);

    expect(result.success).toBe(true);
    expect(result.repos!['api'].success).toBe(true);
    expect(result.repos!['web-ui'].success).toBe(true);
    expect(await readHeadBody(fx.repos['api'].path)).toBe(message);
    expect(await readHeadBody(fx.repos['web-ui'].path)).toBe(message);
  });

  it("rejects rebase plus custom message before mutating any repo", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    const before = {
      api: (await fx.repos['api'].git.revparse(['HEAD'])).trim(),
      web: (await fx.repos['web-ui'].git.revparse(['HEAD'])).trim(),
    };

    const result = await fx.service.merge(fx.feature, fx.task, 'rebase', 'feat: nope');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Custom merge message is not supported for rebase/);
    expect(result.partial).toBeUndefined();
    expect(result.repos).toBeUndefined();
    // No repo mutated
    expect((await fx.repos['api'].git.revparse(['HEAD'])).trim()).toBe(before.api);
    expect((await fx.repos['web-ui'].git.revparse(['HEAD'])).trim()).toBe(before.web);
  });

  it("fails preflight when a per-repo task branch is missing and does not mutate any repo", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    // Delete the web-ui task branch from source repo
    const taskBranchWeb = `hive/web-ui/${fx.feature}/${fx.task}`;
    // Cannot delete a checked-out branch; remove the per-repo worktree first
    try { await fx.repos['web-ui'].git.raw(['worktree', 'remove', '--force', `.hive/.worktrees/${fx.feature}/${fx.task}/repos/web-ui`]); } catch {}
    // Recreate path so source repo no longer has worktree mapping
    await fx.repos['web-ui'].git.raw(['worktree', 'prune']);
    await fx.repos['web-ui'].git.deleteLocalBranch(taskBranchWeb, true);

    const before = (await fx.repos['api'].git.revparse(['HEAD'])).trim();

    const result = await fx.service.merge(fx.feature, fx.task, 'merge');

    expect(result.success).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.error).toMatch(/web-ui/);
    expect(result.error).toMatch(/branch|not found/i);
    // No mutation in api despite preflight failing in web-ui
    expect((await fx.repos['api'].git.revparse(['HEAD'])).trim()).toBe(before);
  });

  it("fails preflight when a source repo's target branch is dirty and does not mutate any repo", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    // Dirty the api source repo working tree
    await fs.writeFile(path.join(fx.repos['api'].path, 'README.md'), 'dirty\n', 'utf-8');

    const beforeWeb = (await fx.repos['web-ui'].git.revparse(['HEAD'])).trim();

    const result = await fx.service.merge(fx.feature, fx.task, 'merge');

    expect(result.success).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.error).toMatch(/dirty|uncommitted/i);
    expect(result.error).toMatch(/api/);
    // No mutation in web-ui
    expect((await fx.repos['web-ui'].git.revparse(['HEAD'])).trim()).toBe(beforeWeb);
  });

  it("fails preflight when a source repo has an active merge state and does not mutate any repo", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    // Simulate an active merge in api
    await fs.writeFile(path.join(fx.repos['api'].path, '.git', 'MERGE_HEAD'), 'deadbeef\n', 'utf-8');

    const beforeWeb = (await fx.repos['web-ui'].git.revparse(['HEAD'])).trim();

    const result = await fx.service.merge(fx.feature, fx.task, 'merge');

    expect(result.success).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.error).toMatch(/active (merge|rebase|cherry-pick)/i);
    expect(result.error).toMatch(/api/);
    expect((await fx.repos['web-ui'].git.revparse(['HEAD'])).trim()).toBe(beforeWeb);
  });

  it("aborts on conflict and returns partial=true when an earlier repo already merged successfully", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');

    // Make a conflicting change in web-ui: change tracked file in worktree and in source
    const wt = await fx.service.get(fx.feature, fx.task);
    await fs.writeFile(path.join(wt!.repos!['web-ui'].path, 'README.md'), 'task-side\n', 'utf-8');
    const wg = simpleGit(wt!.repos!['web-ui'].path);
    await wg.add('-A');
    await wg.commit('chore: task side');

    // Diverge main of web-ui
    await fs.writeFile(path.join(fx.repos['web-ui'].path, 'README.md'), 'main-side\n', 'utf-8');
    await fx.repos['web-ui'].git.add('-A');
    await fx.repos['web-ui'].git.commit('chore: main side');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge');

    expect(result.success).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.conflictState).toBe('aborted');
    expect(result.conflicts).toContain('web-ui:README.md');
    expect(result.repos!['api'].success).toBe(true);
    expect(result.repos!['api'].merged).toBe(true);
    expect(result.repos!['web-ui'].success).toBe(false);
    expect(result.repos!['web-ui'].conflictState).toBe('aborted');
    // web-ui aborted: no conflict markers left
    const wstatus = await fx.repos['web-ui'].git.status();
    expect(wstatus.conflicted).toEqual([]);
  });

  it("preserves conflicts when requested and does not roll back earlier successful repo merges", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');

    const wt = await fx.service.get(fx.feature, fx.task);
    await fs.writeFile(path.join(wt!.repos!['web-ui'].path, 'README.md'), 'task-side\n', 'utf-8');
    const wg = simpleGit(wt!.repos!['web-ui'].path);
    await wg.add('-A');
    await wg.commit('chore: task side');

    await fs.writeFile(path.join(fx.repos['web-ui'].path, 'README.md'), 'main-side\n', 'utf-8');
    await fx.repos['web-ui'].git.add('-A');
    await fx.repos['web-ui'].git.commit('chore: main side');

    const apiHeadBefore = (await fx.repos['api'].git.revparse(['HEAD'])).trim();

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', undefined, {
      preserveConflicts: true,
    });

    expect(result.success).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.conflictState).toBe('preserved');
    expect(result.repos!['web-ui'].conflictState).toBe('preserved');
    expect(result.conflicts).toContain('web-ui:README.md');
    const wstatus = await fx.repos['web-ui'].git.status();
    expect(wstatus.conflicted).toContain('README.md');
    // api merge not rolled back
    const apiHeadAfter = (await fx.repos['api'].git.revparse(['HEAD'])).trim();
    expect(apiHeadAfter).not.toBe(apiHeadBefore);
  });

  it("stops after mutation failure in a later repo and reports partial without rolling back earlier merges", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    // Sabotage web-ui via a pre-merge-commit hook that exits 1
    const hookDir = path.join(fx.repos['web-ui'].path, '.git', 'hooks');
    await fs.mkdir(hookDir, { recursive: true });
    const hookPath = path.join(hookDir, 'pre-merge-commit');
    await fs.writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf-8');
    await fs.chmod(hookPath, 0o755);

    const apiHeadBefore = (await fx.repos['api'].git.revparse(['HEAD'])).trim();

    const result = await fx.service.merge(fx.feature, fx.task, 'merge');

    expect(result.success).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.repos!['api'].success).toBe(true);
    expect(result.repos!['web-ui'].success).toBe(false);
    expect(result.error).toMatch(/web-ui/);
    // api merge not rolled back
    const apiHeadAfter = (await fx.repos['api'].git.revparse(['HEAD'])).trim();
    expect(apiHeadAfter).not.toBe(apiHeadBefore);
  });

  it("cleanup=worktree+branch aggregates per-repo cleanup across composite repos", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', undefined, {
      cleanup: 'worktree+branch',
    });

    expect(result.success).toBe(true);
    expect(result.cleanup.worktreeRemoved).toBe(true);
    expect(result.cleanup.branchDeleted).toBe(true);
    expect(result.cleanup.pruned).toBe(true);
    expect(await pathExists(wt.path)).toBe(false);
    for (const id of ['api', 'web-ui']) {
      expect(await branchExists(fx.repos[id].git, `hive/${id}/${fx.feature}/${fx.task}`)).toBe(false);
    }
  });

  it("populates per-repo cleanup fields when cleanup=worktree+branch and aggregates them at top level", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', undefined, {
      cleanup: 'worktree+branch',
    });

    expect(result.success).toBe(true);
    expect(result.repos).toBeDefined();
    for (const id of ['api', 'web-ui']) {
      expect(result.repos![id].cleanup).toEqual({
        worktreeRemoved: true,
        branchDeleted: true,
        pruned: true,
      });
    }
    // Top-level cleanup is the aggregate of per-repo results.
    expect(result.cleanup.worktreeRemoved).toBe(true);
    expect(result.cleanup.branchDeleted).toBe(true);
    expect(result.cleanup.pruned).toBe(true);
  });

  it("populates per-repo cleanup fields when cleanup=worktree and keeps branches across repos", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', undefined, {
      cleanup: 'worktree',
    });

    expect(result.success).toBe(true);
    for (const id of ['api', 'web-ui']) {
      expect(result.repos![id].cleanup.worktreeRemoved).toBe(true);
      expect(result.repos![id].cleanup.branchDeleted).toBe(false);
      expect(result.repos![id].cleanup.pruned).toBe(true);
      expect(await branchExists(fx.repos[id].git, `hive/${id}/${fx.feature}/${fx.task}`)).toBe(true);
    }
    expect(result.cleanup.worktreeRemoved).toBe(true);
    expect(result.cleanup.branchDeleted).toBe(false);
    expect(result.cleanup.pruned).toBe(true);
  });

  it('returns an all-repo composite no-op when every repo has zero tracked diff', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    await commitNetZeroChangeInRepo(fx, 'api');
    await commitNetZeroChangeInRepo(fx, 'web-ui');
    const before = {
      api: (await fx.repos['api'].git.revparse(['HEAD'])).trim(),
      web: (await fx.repos['web-ui'].git.revparse(['HEAD'])).trim(),
    };

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', undefined, {
      cleanup: 'worktree+branch',
    });

    expect(result).toMatchObject({
      success: true,
      merged: false,
      reason: 'nothing_to_merge',
      reasonCode: 'NO_TRACKED_CHANGES',
      filesChanged: [],
      conflicts: [],
      conflictState: 'none',
      cleanupEligible: true,
      taskUpdateRecommended: true,
      cleanup: {
        worktreeRemoved: true,
        branchDeleted: true,
        pruned: true,
      },
    });
    expect('sha' in result).toBe(false);
    expect(result.repos!['api']).toMatchObject({ success: true, merged: false, reasonCode: 'NO_TRACKED_CHANGES' });
    expect(result.repos!['web-ui']).toMatchObject({ success: true, merged: false, reasonCode: 'NO_TRACKED_CHANGES' });
    expect((await fx.repos['api'].git.revparse(['HEAD'])).trim()).toBe(before.api);
    expect((await fx.repos['web-ui'].git.revparse(['HEAD'])).trim()).toBe(before.web);
    expect(await pathExists(wt.path)).toBe(false);
    expect(await branchExists(fx.repos['api'].git, `hive/api/${fx.feature}/${fx.task}`)).toBe(false);
    expect(await branchExists(fx.repos['web-ui'].git, `hive/web-ui/${fx.feature}/${fx.task}`)).toBe(false);
  });

  it('aggregates mixed composite no-op and changed repos as a successful actual merge', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitNetZeroChangeInRepo(fx, 'api');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge');

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.reasonCode).toBeUndefined();
    expect(typeof result.sha).toBe('string');
    expect(result.filesChanged).toEqual(['web-ui:w.txt']);
    expect(result.repos!['api']).toMatchObject({ success: true, merged: false, reasonCode: 'NO_TRACKED_CHANGES' });
    expect(result.repos!['web-ui'].merged).toBe(true);
  });

  it('does not mark a composite failure partial after only no-op repos have succeeded', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitNetZeroChangeInRepo(fx, 'api');

    const wt = await fx.service.get(fx.feature, fx.task);
    await fs.writeFile(path.join(wt!.repos!['web-ui'].path, 'README.md'), 'task-side\n', 'utf-8');
    const wg = simpleGit(wt!.repos!['web-ui'].path);
    await wg.add('-A');
    await wg.commit('chore: web-ui task side');

    await fs.writeFile(path.join(fx.repos['web-ui'].path, 'README.md'), 'main-side\n', 'utf-8');
    await fx.repos['web-ui'].git.add('-A');
    await fx.repos['web-ui'].git.commit('chore: web-ui main side');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge');

    expect(result.success).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.repos!['api']).toMatchObject({ success: true, merged: false, reasonCode: 'NO_TRACKED_CHANGES' });
    expect(result.repos!['web-ui'].success).toBe(false);
    expect(result.conflicts).toContain('web-ui:README.md');
  });

  it("does not report aggregate merged=true when a per-repo result is success=true but merged=false", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    // Force the 'web-ui' merge to return success=true but merged=false by
    // patching its mergeOneRepo invocation indirectly: we monkey-patch the
    // service's mergeOneRepo via prototype to override behavior for web-ui.
    const original = (fx.service as unknown as { mergeOneRepo: Function }).mergeOneRepo.bind(fx.service);
    (fx.service as unknown as { mergeOneRepo: Function }).mergeOneRepo = async (opts: { branchName: string }) => {
      const result = await original(opts);
      if (opts.branchName.includes('/web-ui/')) {
        return { ...result, success: true, merged: false, error: undefined };
      }
      return result;
    };

    const result = await fx.service.merge(fx.feature, fx.task, 'merge');

    expect(result.success).toBe(false);
    expect(result.merged).toBe(false);
    // api already merged successfully, then web-ui returned merged=false -> partial.
    expect(result.partial).toBe(true);
    expect(result.repos!['api'].merged).toBe(true);
    expect(result.repos!['web-ui'].success).toBe(true);
    expect(result.repos!['web-ui'].merged).toBe(false);
    expect(result.error).toMatch(/web-ui/);
  });

  it("detects active merge state in a linked worktree where .git is a file via git rev-parse --git-path", async () => {
    // Build a custom composite where the 'api' source repo IS a linked git
    // worktree of a separate host repo (so `api/.git` is a FILE, not a dir).
    // Joining `repoRoot/.git/MERGE_HEAD` would miss the real state file which
    // lives under the host's `.git/worktrees/<name>/MERGE_HEAD`.
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-composite-test-'));
    tempDirs.push(projectRoot);

    // Host repo for api (becomes the .git store for the linked worktree).
    const hostApi = path.join(projectRoot, 'host-api');
    await fs.mkdir(hostApi, { recursive: true });
    const root = simpleGit();
    try {
      await root.raw(['init', '-b', 'main', hostApi]);
    } catch {
      await root.raw(['init', hostApi]);
      await simpleGit(hostApi).raw(['branch', '-M', 'main']);
    }
    const hostApiGit = simpleGit(hostApi);
    await hostApiGit.raw(['config', 'user.email', 'h@example.com']);
    await hostApiGit.raw(['config', 'user.name', 'Host User']);
    await fs.writeFile(path.join(hostApi, 'README.md'), '# host-api\n', 'utf-8');
    await hostApiGit.add('README.md');
    await hostApiGit.commit('chore: host-api base');

    // The "api" source repo is a linked worktree off host-api on a non-main branch.
    const apiPath = path.join(projectRoot, 'api');
    await hostApiGit.raw(['worktree', 'add', '-b', 'api-target', apiPath, 'main']);
    const apiGit = simpleGit(apiPath);
    // Sanity: api/.git is a file in a linked worktree.
    const apiGitStat = await fs.stat(path.join(apiPath, '.git'));
    expect(apiGitStat.isFile()).toBe(true);

    // Build a normal web-ui repo.
    const webRepo = await makeRepo(projectRoot, 'web-ui');

    const feature = 'lwt-feature';
    const task = '01-lwt';
    const featureDir = path.join(projectRoot, '.hive', 'features', `01_${feature}`, 'tasks', task);
    await fs.mkdir(featureDir, { recursive: true });
    await fs.writeFile(
      path.join(featureDir, 'status.json'),
      JSON.stringify({ status: 'pending', origin: 'plan', repoIds: ['api', 'web-ui'] }),
      'utf-8',
    );
    const service = new WorktreeService({
      baseDir: projectRoot,
      hiveDir: path.join(projectRoot, '.hive'),
      repositoryResolver: {
        resolveRepositories: () => [
          { id: 'api', path: apiPath, root: apiPath },
          { id: 'web-ui', path: webRepo.path, root: webRepo.path },
        ],
      },
      taskRepoResolver: { resolveTaskRepoIds: () => ['api', 'web-ui'] },
    });

    await service.create(feature, task);
    // Commit a task change in each per-repo worktree.
    const wt = await service.get(feature, task);
    for (const id of ['api', 'web-ui']) {
      await fs.writeFile(path.join(wt!.repos![id].path, `${id}.txt`), `${id}\n`, 'utf-8');
      const g = simpleGit(wt!.repos![id].path);
      await g.add('-A');
      await g.commit(`chore: ${id} task change`);
    }

    // Simulate an "active merge" in the api source repo (which is itself a
    // linked worktree). The real state file path comes from `rev-parse`.
    const stateRel = (await apiGit.raw(['rev-parse', '--git-path', 'MERGE_HEAD'])).trim();
    const stateAbs = path.isAbsolute(stateRel) ? stateRel : path.join(apiPath, stateRel);
    await fs.mkdir(path.dirname(stateAbs), { recursive: true });
    await fs.writeFile(stateAbs, 'deadbeef\n', 'utf-8');
    // Sanity: legacy `<repoRoot>/.git/MERGE_HEAD` does NOT exist here.
    expect(await pathExists(path.join(apiPath, '.git', 'MERGE_HEAD'))).toBe(false);

    const webHeadBefore = (await webRepo.git.revparse(['HEAD'])).trim();

    const result = await service.merge(feature, task, 'merge');

    expect(result.success).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.error).toMatch(/active (merge|rebase|cherry-pick)/i);
    expect(result.error).toMatch(/api/);
    // web-ui must not have been mutated.
    expect((await webRepo.git.revparse(['HEAD'])).trim()).toBe(webHeadBefore);
  });

  it("preserves legacy single-repo merge shape when no manifest is configured", async () => {
    const fixture = await createCommittedFixture();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge');

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.repos).toBeUndefined();
    expect(result.partial).toBeUndefined();
  });
});
