import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import simpleGit, { type SimpleGit } from "simple-git";
import type { ResolvedRepository } from "../types";
import { WorktreeService } from "./worktreeService";
import type { MergeResult } from "./worktreeService";
import { WorktreeLinkageError } from "./worktreeOutcome";

interface TestFixture {
  repoPath: string;
  worktreePath: string;
  feature: string;
  task: string;
  service: WorktreeService;
  repoGit: SimpleGit;
}

const tempDirs: string[] = [];
const mergeMessage = 'feat: integrate task work\n\nIntegrate the verified task implementation into project history.';
const testCommitMessage = (subject: string): string => `${subject}\n\nCreate test fixture history with a descriptive body.`;

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

  // Nested worktrees under .hive/ appear as untracked without this ignore.
  await fs.writeFile(path.join(repoPath, ".gitignore"), ".hive/\n", "utf-8");
  await fs.writeFile(path.join(repoPath, "tracked.txt"), "base\n", "utf-8");
  await repoGit.add([".gitignore", "tracked.txt"]);
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

async function commitTaskChanges(
  service: WorktreeService,
  feature: string,
  task: string,
  message?: string,
  attemptSlot?: string,
): Promise<{ committed: boolean; sha: string; message?: string; repos?: Record<string, { committed: boolean; sha: string }> }> {
  const worktree = await service.get(feature, task, attemptSlot);
  if (!worktree) throw new Error('Worktree not found');
  const repositories = worktree.repos
    ? Object.fromEntries(Object.entries(worktree.repos).map(([id, repository]) => [id, repository.path]))
    : { root: worktree.path };
  const results: Record<string, { committed: boolean; sha: string }> = {};
  for (const [id, repositoryPath] of Object.entries(repositories)) {
    const git = simpleGit(repositoryPath);
    const status = await git.status();
    if (status.isClean()) {
      results[id] = { committed: false, sha: (await git.revparse(['HEAD'])).trim() };
      continue;
    }
    if (!message) throw new Error('Direct Git fixture commit requires a message');
    await git.add('-A');
    await git.commit(message);
    results[id] = { committed: true, sha: (await git.revparse(['HEAD'])).trim() };
  }
  const first = Object.values(results)[0]!;
  return {
    committed: Object.values(results).some(result => result.committed),
    sha: first.sha,
    ...(message ? { message } : {}),
    ...(worktree.repos ? { repos: results } : {}),
  };
}

async function createCommittedFixture(): Promise<TestFixture> {
  const fixture = await createFixture();

  await fs.writeFile(path.join(fixture.worktreePath, "task-change.txt"), "task change\n", "utf-8");
  const result = await commitTaskChanges(fixture.service, fixture.feature, fixture.task, testCommitMessage('chore: task change'));
  expect(result.committed).toBe(true);

  await fixture.repoGit.checkout("main");

  return fixture;
}

async function createNetZeroCommittedFixture(): Promise<TestFixture> {
  const fixture = await createFixture();

  await fs.writeFile(path.join(fixture.worktreePath, "tracked.txt"), "transient task change\n", "utf-8");
  const transient = await commitTaskChanges(fixture.service, fixture.feature, fixture.task, testCommitMessage('chore: transient task change'));
  expect(transient.committed).toBe(true);

  await fs.writeFile(path.join(fixture.worktreePath, "tracked.txt"), "base\n", "utf-8");
  const reverted = await commitTaskChanges(fixture.service, fixture.feature, fixture.task, testCommitMessage('revert: transient task change'));
  expect(reverted.committed).toBe(true);

  await fixture.repoGit.checkout("main");

  return fixture;
}

async function createConflictingFixture(): Promise<TestFixture> {
  const fixture = await createFixture();

  await fs.writeFile(path.join(fixture.worktreePath, 'tracked.txt'), 'task change\n', 'utf-8');
  const taskCommit = await commitTaskChanges(fixture.service,
    fixture.feature,
    fixture.task,
    testCommitMessage('chore: conflicting task change'),
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

async function installPrepareCommitMessageHook(repoPath: string, body: string): Promise<void> {
  const hookDir = path.join(repoPath, '.git', 'hooks');
  const hookPath = path.join(hookDir, 'prepare-commit-msg');
  await fs.mkdir(hookDir, { recursive: true });
  await fs.writeFile(hookPath, `#!/bin/sh\n${body}\n`, 'utf-8');
  await fs.chmod(hookPath, 0o755);
  await simpleGit(repoPath).raw(['config', 'core.hooksPath', hookDir]);
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
    expect(JSON.parse(await fs.readFile(`${worktree.path}.json`, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      mode: 'single',
      feature: 'test-feature',
      task: '01-test-task',
      baseCommit: worktree.commit,
    });
  });

  it("places a slotted attempt at a distinct path and branch without changing the default location", async () => {
    const { repoPath } = await createTempRepo();
    const service = new WorktreeService({
      baseDir: repoPath,
      hiveDir: path.join(repoPath, ".hive"),
    });
    const feature = "test-feature";
    const task = "01-test-task";

    expect(service.getWorktreePath(feature, task)).toBe(path.join(repoPath, ".hive", ".worktrees", feature, task));
    expect(service.getWorktreePath(feature, task, "retry")).toBe(
      path.join(repoPath, ".hive", ".worktrees", feature, `${task}--retry`),
    );

    const defaultWorktree = await service.create(feature, task);
    const slotted = await service.create(feature, task, undefined, "retry");

    expect(defaultWorktree.path).toBe(service.getWorktreePath(feature, task));
    expect(defaultWorktree.branch).toBe("hive/test-feature/01-test-task");
    expect(slotted.path).toBe(service.getWorktreePath(feature, task, "retry"));
    expect(slotted.branch).toBe("hive/test-feature/01-test-task-retry");
    expect(await service.get(feature, task)).toMatchObject({ path: defaultWorktree.path, branch: defaultWorktree.branch });
    expect(await service.get(feature, task, "retry")).toMatchObject({ path: slotted.path, branch: slotted.branch });
    expect(slotted.path).not.toBe(defaultWorktree.path);
    expect(await service.listCandidates(feature, task)).toEqual([
      expect.objectContaining({ path: defaultWorktree.path }),
      expect.objectContaining({ path: slotted.path, candidate: 'retry' }),
    ]);
  });

  it('refuses removal when the worktree contains untracked content', async () => {
    const { repoPath } = await createTempRepo();
    const service = new WorktreeService({ baseDir: repoPath, hiveDir: path.join(repoPath, '.hive') });
    const worktree = await service.create('test-feature', '01-test-task');
    await fs.writeFile(path.join(worktree.path, 'untracked.log'), 'keep me\n', 'utf-8');

    const inspected = await service.inspect('test-feature', '01-test-task');
    const removed = await service.remove('test-feature', '01-test-task');

    expect(inspected?.clean).toBe(false);
    expect(removed.cleanup.worktreeRemoval.status).toBe('failed');
    expect(await fs.readFile(path.join(worktree.path, 'untracked.log'), 'utf-8')).toBe('keep me\n');
  });

  it('lets native Git removal handle ignored-only generated content', async () => {
    const { repoPath } = await createTempRepo();
    const service = new WorktreeService({ baseDir: repoPath, hiveDir: path.join(repoPath, '.hive') });
    const worktree = await service.create('test-feature', '01-test-task');
    await fs.writeFile(path.join(worktree.path, '.gitignore'), 'ignored.log\n', 'utf-8');
    await commitTaskChanges(service, 'test-feature', '01-test-task', testCommitMessage('chore: ignore generated log'));
    await fs.writeFile(path.join(worktree.path, 'ignored.log'), 'generated\n', 'utf-8');

    const removed = await service.remove('test-feature', '01-test-task');

    expect(removed.cleanup.worktreeRemoval).toMatchObject({ status: 'succeeded' });
    expect(await pathExists(worktree.path)).toBe(false);
    expect(await pathExists(path.join(worktree.path, 'ignored.log'))).toBe(false);
  });

  it("commits, diffs, and removes a slotted worktree without touching the default worktree", async () => {
    const { repoPath } = await createTempRepo();
    const service = new WorktreeService({
      baseDir: repoPath,
      hiveDir: path.join(repoPath, ".hive"),
    });
    const feature = "test-feature";
    const task = "01-test-task";
    const defaultWorktree = await service.create(feature, task);
    const slotted = await service.create(feature, task, undefined, "retry");
    await fs.writeFile(path.join(slotted.path, "slotted.txt"), "slotted\n", "utf-8");
    await fs.writeFile(path.join(defaultWorktree.path, "default.txt"), "default\n", "utf-8");

    expect(await service.hasUncommittedChanges(feature, task, "retry")).toBe(true);
    expect(await service.hasUncommittedChanges(feature, task)).toBe(true);

    const commit = await commitTaskChanges(service, feature, task, testCommitMessage("feat: slotted work"), "retry");
    expect(commit.committed).toBe(true);
    expect(await service.hasUncommittedChanges(feature, task, "retry")).toBe(false);
    expect(await service.hasUncommittedChanges(feature, task)).toBe(true);
    expect(await fs.readFile(path.join(defaultWorktree.path, "default.txt"), "utf-8")).toBe("default\n");

    const removed = await service.remove(feature, task, false, {}, "retry");
    expect(removed.worktreeRemoved).toBe(true);
    expect(await service.get(feature, task, "retry")).toBeNull();
    expect(await service.get(feature, task)).not.toBeNull();
  });

  it("uses a custom merge message verbatim, including body text", async () => {
    const fixture = await createCommittedFixture();
    const message = "feat(core): merge task\n\nmerge body";

    const result = await fixture.service.merge(fixture.feature, fixture.task, "merge", message);

    expect(result.success).toBe(true);
    expect(result.strategy).toBe('merge');
    expect(result.conflictState).toBe('none');
    expect(result.cleanup).toMatchObject({
      requested: 'none',
      outcome: 'not_requested',
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
    expect(result.cleanup).toMatchObject({
      requested: 'none',
      outcome: 'not_requested',
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
    });
    expect(await readHeadBody(fixture.repoPath)).toBe(message);
  });

  it('rejects squash without an explicit valid aggregate message before mutation', async () => {
    const fixture = await createCommittedFixture();
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task);

    expect(result.success).toBe(false);
    expect(result.strategy).toBe('squash');
    expect(result.error).toMatch(/explicit.*subject.*blank line.*body/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('rejects a malformed later source commit before rebase mutates the target', async () => {
    const fixture = await createFixture();
    const worktreeGit = simpleGit(fixture.worktreePath);
    await fs.writeFile(path.join(fixture.worktreePath, 'valid-source.txt'), 'good\n', 'utf-8');
    await worktreeGit.add('-A');
    await worktreeGit.commit(testCommitMessage('feat: valid first source commit'));
    await fs.writeFile(path.join(fixture.worktreePath, 'malformed-source.txt'), 'bad\n', 'utf-8');
    await worktreeGit.add('-A');
    await worktreeGit.raw(['commit', '-m', 'subject line\ncontinued subject\n\nDescriptive body.']);
    const malformedHead = (await worktreeGit.revparse(['HEAD'])).trim();
    await fixture.repoGit.checkout('main');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'rebase');

    expect(result.success).toBe(false);
    expect(result.error).toContain(malformedHead.slice(0, 7));
    expect(result.error).toMatch(/source commit.*subject.*blank line.*body/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('restores the target after a squash conflict', async () => {
    const fixture = await createConflictingFixture();
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      conflictState: 'aborted',
      conflicts: ['tracked.txt'],
    });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('restores the target when the squash commit hook fails', async () => {
    const fixture = await createCommittedFixture();
    const hookPath = path.join(fixture.repoPath, '.git', 'hooks', 'prepare-commit-msg');
    await fs.writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf-8');
    await fs.chmod(hookPath, 0o755);
    await fixture.repoGit.raw(['config', 'core.hooksPath', path.dirname(hookPath)]);
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage);

    expect(result.success).toBe(false);
    expect(result.merged).toBe(false);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  for (const strategy of ['squash', 'merge'] as const) {
    it(`removes an invalid ${strategy} aggregate commit rewritten by a hook`, async () => {
      const fixture = await createCommittedFixture();
      const hookBody = strategy === 'squash'
        ? `printf '%s\\n' 'subject only' > "$1"`
        : `printf '%s\\n' 'subject line' 'continued subject' '' 'Descriptive body.' > "$1"`;
      await installPrepareCommitMessageHook(fixture.repoPath, hookBody);
      const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

      const result = await fixture.service.merge(fixture.feature, fixture.task, strategy, mergeMessage);

      expect(result.success).toBe(false);
      expect(result.merged).toBe(false);
      expect(result.error).toMatch(/subject.*blank line.*body/i);
      expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
      expect((await fixture.repoGit.status()).isClean()).toBe(true);
    });
  }

  it('removes an invalid cherry-picked commit rewritten by a hook', async () => {
    const fixture = await createCommittedFixture();
    await installPrepareCommitMessageHook(fixture.repoPath, `printf '%s\\n' 'subject only' > "$1"`);
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'rebase');

    expect(result.success).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.error).toMatch(/subject.*blank line.*body/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('does not preserve a hook failure merely because its error mentions conflict', async () => {
    const fixture = await createCommittedFixture();
    await installPrepareCommitMessageHook(fixture.repoPath, `printf '%s\\n' 'hook conflict sentinel' >&2\nexit 1`);
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, {
      preserveConflicts: true,
    });

    expect(result).toMatchObject({ success: false, merged: false, conflictState: 'none', conflicts: [] });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('rejects a dirty target without changing staged or untracked content', async () => {
    const fixture = await createCommittedFixture();
    const trackedPath = path.join(fixture.repoPath, 'tracked.txt');
    const untrackedPath = path.join(fixture.repoPath, 'user-note.txt');
    await fs.writeFile(trackedPath, 'staged user content\n', 'utf-8');
    await fixture.repoGit.add('tracked.txt');
    await fs.writeFile(untrackedPath, 'untracked user content\n', 'utf-8');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    const beforeStatus = await fixture.repoGit.raw(['status', '--porcelain=v1']);
    const beforeIndex = await fixture.repoGit.raw(['diff', '--cached', '--binary']);

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage);

    expect(result).toMatchObject({ success: false, merged: false, conflictState: 'none' });
    expect(result.error).toMatch(/dirty|uncommitted/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect(await fixture.repoGit.raw(['status', '--porcelain=v1'])).toBe(beforeStatus);
    expect(await fixture.repoGit.raw(['diff', '--cached', '--binary'])).toBe(beforeIndex);
    expect(await fs.readFile(trackedPath, 'utf-8')).toBe('staged user content\n');
    expect(await fs.readFile(untrackedPath, 'utf-8')).toBe('untracked user content\n');
  });

  it('restores the target when the second cherry-pick fails', async () => {
    const fixture = await createFixture();
    const worktreeGit = simpleGit(fixture.worktreePath);
    await fs.writeFile(path.join(fixture.worktreePath, 'first.txt'), 'first\n', 'utf-8');
    await worktreeGit.add('-A');
    await worktreeGit.commit(testCommitMessage('feat: first source commit'));
    await fs.writeFile(path.join(fixture.worktreePath, 'tracked.txt'), 'task side\n', 'utf-8');
    await worktreeGit.add('-A');
    await worktreeGit.commit(testCommitMessage('feat: conflicting second source commit'));

    await fixture.repoGit.checkout('main');
    await fs.writeFile(path.join(fixture.repoPath, 'tracked.txt'), 'main side\n', 'utf-8');
    await fixture.repoGit.add('-A');
    await fixture.repoGit.commit(testCommitMessage('feat: conflicting target commit'));
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'rebase');

    expect(result).toMatchObject({ success: false, merged: false, conflictState: 'aborted' });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('returns helper-friendly merge details and preserves branch/worktree by default', async () => {
    const fixture = await createCommittedFixture();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage);

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

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, {
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

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, {
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

  it('keeps an advanced task branch when it moves between validation and compare-and-delete', async () => {
    const fixture = await createCommittedFixture();
    const branch = 'hive/test-feature/01-test-task';
    const originalGetGit = (fixture.service as any).getGit.bind(fixture.service);
    let advanced: string | undefined;
    const gitSpy = spyOn(fixture.service as any, 'getGit').mockImplementation((cwd?: string) => {
      const git = originalGetGit(cwd);
      return new Proxy(git, {
        get(target, key) {
          if (key !== 'raw') return Reflect.get(target, key);
          return async (args: string[]) => {
            if (args[0] === 'update-ref' && args[1] === '-d') {
              advanced = (await fixture.repoGit.revparse(['HEAD'])).trim();
              await target.raw(['update-ref', args[2]!, advanced, args[3]!]);
            }
            return target.raw(args);
          };
        },
      });
    });
    let result;
    try {
      result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, {
        cleanup: 'worktree+branch',
      });
    } finally {
      gitSpy.mockRestore();
    }

    expect(result.cleanup.branchDeletion.status).toBe('failed');
    expect((await fixture.repoGit.revparse([branch])).trim()).toBe(advanced!);
  });

  it('reports rollback failure instead of aborted when Git conflict state remains active', async () => {
    const fixture = await createConflictingFixture();
    const originalGetGit = (fixture.service as any).getGit.bind(fixture.service);
    const gitSpy = spyOn(fixture.service as any, 'getGit').mockImplementation((cwd?: string) => {
      const git = originalGetGit(cwd);
      if (cwd && cwd !== fixture.repoPath) return git;
      return new Proxy(git, {
        get(target, key) {
          if (key !== 'raw') return Reflect.get(target, key);
          return (args: string[]) => {
            if ((args[0] === 'merge' && args[1] === '--abort') || (args[0] === 'reset' && args[1] === '--merge')) {
              return Promise.reject(new Error('simulated rollback failure'));
            }
            return target.raw(args);
          };
        },
      });
    });
    let result;
    try {
      result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage);
    } finally {
      gitSpy.mockRestore();
      await fixture.repoGit.raw(['merge', '--abort']).catch(() => {});
    }

    expect(result).toMatchObject({
      success: false,
      reasonCode: 'ROLLBACK_FAILED',
      conflictState: 'none',
      mutation: 'unknown',
      action: 'manual_recovery',
    });
    expect(result.error).toMatch(/operation remains active|simulated rollback failure/);
  });

  it('does not roll back a completed integration when the requested cleanup throws', async () => {
    const fixture = await createCommittedFixture();
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const cleanupSpy = spyOn(fixture.service as any, 'removeLegacy').mockImplementation(async () => {
      throw new Error('simulated cleanup failure');
    });
    let result: MergeResult;
    try {
      result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, {
        cleanup: 'worktree',
      });
    } finally {
      cleanupSpy.mockRestore();
    }

    expect(result).toMatchObject({
      success: false,
      merged: false,
      reasonCode: 'CLEANUP_FAILED',
      phase: 'cleanup',
      mutation: 'applied',
      retryable: false,
      action: 'cleanup_only',
    });
    expect(result.error).toMatch(/simulated cleanup failure/);
    // The integration commit is durable: no --hard reset to the starting HEAD.
    const afterHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    expect(afterHead).not.toBe(beforeHead);
    expect(await readHeadBody(fixture.repoPath)).toBe(mergeMessage);
    expect(await pathExists(fixture.worktreePath)).toBe(true);
  });

  it('returns NO_TRACKED_CHANGES for divergent histories with identical endpoint trees and leaves target HEAD untouched', async () => {
    const fixture = await createFixture();
    const worktreeGit = simpleGit(fixture.worktreePath);
    await fs.writeFile(path.join(fixture.worktreePath, 'tracked.txt'), 'branch-path\n', 'utf-8');
    await worktreeGit.add('-A');
    await worktreeGit.commit(testCommitMessage('feat: branch intermediate'));
    await fs.writeFile(path.join(fixture.worktreePath, 'tracked.txt'), 'converged\n', 'utf-8');
    await worktreeGit.add('-A');
    await worktreeGit.commit(testCommitMessage('feat: branch converges'));

    await fixture.repoGit.checkout('main');
    await fs.writeFile(path.join(fixture.repoPath, 'tracked.txt'), 'main-path\n', 'utf-8');
    await fixture.repoGit.add('-A');
    await fixture.repoGit.commit(testCommitMessage('feat: main intermediate'));
    await fs.writeFile(path.join(fixture.repoPath, 'tracked.txt'), 'converged\n', 'utf-8');
    await fixture.repoGit.add('-A');
    await fixture.repoGit.commit(testCommitMessage('feat: main converges'));

    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    const beforeStatus = await fixture.repoGit.status();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage);

    expect(result).toMatchObject({
      success: true,
      merged: false,
      reason: 'nothing_to_merge',
      reasonCode: 'NO_TRACKED_CHANGES',
      filesChanged: [],
    });
    expect('sha' in result).toBe(false);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    const afterStatus = await fixture.repoGit.status();
    expect(afterStatus.isClean()).toBe(true);
    expect(afterStatus.current).toBe(beforeStatus.current);
  });

  // The reported delta must describe the integration, not the endpoint
  // comparison: a target that advanced independently after the task branch
  // forked contributes its own files to `git diff <start> <branch>`.
  for (const strategy of ['merge', 'squash', 'rebase'] as const) {
    it(`reports only integration paths in filesChanged for ${strategy} when the target advanced independently`, async () => {
      const fixture = await createFixture();
      await fs.writeFile(path.join(fixture.worktreePath, 'task-only.txt'), 'task content\n', 'utf-8');
      const taskCommit = await commitTaskChanges(fixture.service,
        fixture.feature,
        fixture.task,
        testCommitMessage('chore: task-only change'),
      );
      expect(taskCommit.committed).toBe(true);

      await fixture.repoGit.checkout('main');
      await fs.writeFile(path.join(fixture.repoPath, 'main-only.txt'), 'main content\n', 'utf-8');
      await fixture.repoGit.add('-A');
      await fixture.repoGit.commit(testCommitMessage('feat: independent target advance'));
      const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
      const branchName = `hive/${fixture.feature}/${fixture.task}`;
      const endpointDiff = (
        await fixture.repoGit.diff([beforeHead, branchName, '--name-only'])
      ).split('\n').map((line) => line.trim()).filter(Boolean);

      expect(endpointDiff).toContain('main-only.txt');
      expect(endpointDiff).toContain('task-only.txt');

      const result = await fixture.service.merge(
        fixture.feature,
        fixture.task,
        strategy,
        strategy === 'rebase' ? undefined : mergeMessage,
      );

      expect(result).toMatchObject({
        success: true,
        merged: true,
        strategy,
        mutation: 'applied',
        retryable: false,
        action: 'none',
      });
      expect(result.filesChanged).toEqual(['task-only.txt']);
      expect(result.filesChanged).not.toContain('main-only.txt');
      const observed = (
        await fixture.repoGit.diff([beforeHead, result.sha!, '--name-only'])
      ).split('\n').map((line) => line.trim()).filter(Boolean);
      expect(result.filesChanged).toEqual(observed);
    });
  }

  it('classifies a linkage preflight failure as WORKTREE_LINKAGE_INVALID with a fresh-run action', async () => {
    const fixture = await createFixture();
    const former = await createTempRepo();
    const formerWorktree = path.join(former.repoPath, 'former-worktree');
    await former.repoGit.raw(['worktree', 'add', '-b', 'former-branch', formerWorktree, 'HEAD']);
    const formerPointer = await fs.readFile(path.join(formerWorktree, '.git'), 'utf8');
    await fs.writeFile(path.join(fixture.worktreePath, '.git'), formerPointer, 'utf8');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      reasonCode: 'WORKTREE_LINKAGE_INVALID',
      phase: 'preflight',
      mutation: 'none',
      retryable: false,
      action: 'start_fresh_run',
      partial: false,
    });
    expect(result.error).toMatch(/Worktree linkage preflight failed/);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
  });

  it('classifies an untyped worktree lookup failure as WORKTREE_LOOKUP_FAILED and keeps typed denials on a fresh run', async () => {
    const fixture = await createFixture();
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const untypedSpy = spyOn(fixture.service, 'get').mockImplementation(async () => {
      throw new Error('EIO: i/o error, read');
    });
    let untyped: MergeResult;
    try {
      untyped = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage);
    } finally {
      untypedSpy.mockRestore();
    }

    expect(untyped).toMatchObject({
      success: false,
      merged: false,
      reasonCode: 'WORKTREE_LOOKUP_FAILED',
      phase: 'preflight',
      mutation: 'none',
      retryable: true,
      action: 'inspect_state',
      partial: false,
    });
    expect(untyped.action).not.toBe('start_fresh_run');

    const typedSpy = spyOn(fixture.service, 'get').mockImplementation(async () => {
      throw new WorktreeLinkageError(
        'Worktree linkage preflight failed for repository legacy: administration backlink does not select this exact worktree',
      );
    });
    let typed: MergeResult;
    try {
      typed = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage);
    } finally {
      typedSpy.mockRestore();
    }

    expect(typed).toMatchObject({
      success: false,
      merged: false,
      reasonCode: 'WORKTREE_LINKAGE_INVALID',
      phase: 'preflight',
      mutation: 'none',
      retryable: false,
      action: 'start_fresh_run',
      partial: false,
    });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
  });

  it('classifies an unregistered worktree as WORKTREE_NOT_REGISTERED', async () => {
    const fixture = await createFixture();
    await fixture.repoGit.raw(['worktree', 'remove', fixture.worktreePath, '--force']);
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      reasonCode: 'WORKTREE_NOT_REGISTERED',
      phase: 'preflight',
      mutation: 'none',
      retryable: false,
      action: 'inspect_state',
      partial: false,
    });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
  });

  it('classifies a squash-hook verification failure after the commit exists as POST_INTEGRATION_VERIFICATION_FAILED', async () => {
    const fixture = await createCommittedFixture();
    const hookPath = path.join(fixture.repoPath, '.git', 'hooks', 'prepare-commit-msg');
    await fs.writeFile(hookPath, `#!/bin/sh\nprintf '%s\\n' 'subject only' > "$1"\n`, 'utf-8');
    await fs.chmod(hookPath, 0o755);
    await fixture.repoGit.raw(['config', 'core.hooksPath', path.dirname(hookPath)]);
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      reasonCode: 'POST_INTEGRATION_VERIFICATION_FAILED',
      phase: 'verification',
      mutation: 'unknown',
      retryable: false,
      action: 'inspect_state',
      filesChanged: [],
      cleanup: {
        requested: 'none',
        outcome: 'not_requested',
      },
    });
    expect(result.error).toMatch(/subject.*blank line.*body/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  for (const strategy of ['merge', 'squash', 'rebase'] as const) {
    it(`does not report merged=true when ${strategy} leaves the target HEAD unchanged`, async () => {
      const fixture = await createNetZeroCommittedFixture();
      const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

      const result = await fixture.service.merge(
        fixture.feature,
        fixture.task,
        strategy,
        strategy === 'rebase' ? undefined : mergeMessage,
      );

      expect(result.merged).toBe(false);
      expect(result).toMatchObject({
        success: true,
        reasonCode: 'NO_TRACKED_CHANGES',
        filesChanged: [],
        mutation: 'none',
        retryable: false,
        action: 'none',
      });
      expect('sha' in result).toBe(false);
      expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    });
  }

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

  for (const { stateName, label } of [
    { stateName: 'MERGE_HEAD', label: 'merge' },
    { stateName: 'rebase-merge', label: 'rebase' },
    { stateName: 'CHERRY_PICK_HEAD', label: 'cherry-pick' },
  ] as const) {
    it(`fails safely when a net-zero task merge sees active ${label} state`, async () => {
      const fixture = await createNetZeroCommittedFixture();
      await fs.writeFile(path.join(fixture.repoPath, '.git', stateName), 'deadbeef\n', 'utf-8');

      const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', undefined, {
        cleanup: 'worktree+branch',
      });

      expect(result).toMatchObject({
        success: false,
        merged: false,
        strategy: 'merge',
        filesChanged: [],
        conflicts: [],
        conflictState: 'none',
        cleanup: {
          worktreeRemoved: false,
          branchDeleted: false,
          pruned: false,
        },
      });
      expect(result.error).toMatch(new RegExp(`active ${label} state`, 'i'));
      expect(await pathExists(fixture.worktreePath)).toBe(true);
      expect(await branchExists(fixture.repoGit, 'hive/test-feature/01-test-task')).toBe(true);
    });
  }

  it('blocks direct branch deletion when the task branch has unmerged commits', async () => {
    const fixture = await createCommittedFixture();

    const result = await fixture.service.remove(fixture.feature, fixture.task, true);

    expect(result.cleanup.worktreeRemoval.status).toBe('succeeded');
    expect(result.cleanup.branchDeletion.status).toBe('failed');
    expect(result.cleanup.branchDeletion.error).toMatch(/unmerged commits|hive_merge|discard/i);
    expect(await pathExists(fixture.worktreePath)).toBe(false);
    expect(await branchExists(fixture.repoGit, 'hive/test-feature/01-test-task')).toBe(true);
  });

  it('aborts merge conflicts by default and reports the conflict state', async () => {
    const fixture = await createConflictingFixture();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      strategy: 'merge',
      filesChanged: [],
      conflicts: ['tracked.txt'],
      conflictState: 'aborted',
      reasonCode: 'MERGE_CONFLICT_ABORTED',
      mutation: 'none',
      retryable: true,
      action: 'retry_same_operation',
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

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, {
      preserveConflicts: true,
    });

    expect(result).toMatchObject({
      success: false,
      merged: false,
      strategy: 'merge',
      filesChanged: [],
      conflicts: ['tracked.txt'],
      conflictState: 'preserved',
      reasonCode: 'MERGE_CONFLICT_PRESERVED',
      mutation: 'preserved',
      retryable: false,
      action: 'resolve_conflicts',
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

    const result = await fixture.service.merge(fixture.feature, fixture.task, "rebase", "feat: custom\n\nbody");

    expect(result).toMatchObject({
      success: false,
      merged: false,
      strategy: 'rebase',
      filesChanged: [],
      conflicts: [],
      conflictState: 'none',
      reasonCode: 'MESSAGE_NOT_ALLOWED_FOR_REBASE',
      phase: 'validation',
      mutation: 'none',
      retryable: false,
      action: 'correct_arguments',
      cleanup: {
        worktreeRemoved: false,
        branchDeleted: false,
        pruned: false,
      },
      error: "Custom merge message is not supported for rebase strategy",
    });
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

    // Worktree creation must not mutate task lifecycle state.
    const statusRaw = await fs.readFile(
      path.join(fx.projectRoot, '.hive', 'features', `01_${fx.feature}`, 'tasks', fx.task, 'status.json'),
      'utf-8',
    );
    const status = JSON.parse(statusRaw);
    expect(status.baseCommits).toBeUndefined();
    expect(status.baseCommit).toBeUndefined();
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

  it("rejects a copied same-repository pointer to a sibling administration entry", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const created = await fx.service.create(fx.feature, fx.task);
    const selectedPath = created.repos!.api.path;
    const selectedPointer = await fs.readFile(path.join(selectedPath, '.git'), 'utf8');
    const siblingPath = path.join(fx.projectRoot, 'api-sibling');
    await fx.repos.api.git.raw(['worktree', 'add', '-b', 'sibling-registration', siblingPath, 'HEAD']);
    const siblingPointer = await fs.readFile(path.join(siblingPath, '.git'), 'utf8');
    const workspaceBytes = await fs.readFile(path.join(selectedPath, 'README.md'));

    await fs.writeFile(path.join(selectedPath, '.git'), siblingPointer, 'utf8');
    const adminPaths = [selectedPointer, siblingPointer].map(pointer => pointer.trim().slice('gitdir: '.length));
    const preservedPaths = [path.join(selectedPath, '.git'), path.join(selectedPath, 'README.md'),
      path.join(created.path, 'workspace.json'),
      ...adminPaths.flatMap(admin => ['HEAD', 'index', 'commondir', 'gitdir'].map(name => path.join(admin, name)))];
    const before = await Promise.all(preservedPaths.map(file => fs.readFile(file)));
    const forbiddenAccess: string[] = [];
    const spies = ['access', 'stat', 'lstat', 'readFile', 'realpath', 'readdir', 'open'].map(name => {
      const original = (fs as any)[name];
      return spyOn(fs as any, name).mockImplementation((file: any, ...args: any[]) => {
        if (String(file) === siblingPath || String(file).startsWith(`${siblingPath}${path.sep}`)) forbiddenAccess.push(`${name}:${file}`);
        if (String(file).startsWith(`${selectedPath}${path.sep}`) && String(file) !== path.join(selectedPath, '.git')) forbiddenAccess.push(`${name}:${file}`);
        return original(file, ...args);
      });
    });
    const gitPaths: string[] = [];
    const gitCommands: unknown[] = [];
    const getGit = (fx.service as any).getGit.bind(fx.service);
    const gitSpy = spyOn(fx.service as any, 'getGit').mockImplementation((cwd: string) => {
      gitPaths.push(cwd);
      const git = getGit(cwd);
      return new Proxy(git, { get(target, key) {
        if (key === 'raw') return (...args: unknown[]) => { gitCommands.push([cwd, ...args]); return target.raw(...args); };
        return Reflect.get(target, key);
      } });
    });
    try {
      await expect(fx.service.get(fx.feature, fx.task)).rejects.toThrow(/backlink does not select this exact worktree/);
      expect(forbiddenAccess).toEqual([]);
      expect(gitPaths).toEqual([fx.repos.api.path]);
      expect(gitCommands).toEqual([[fx.repos.api.path, ['rev-parse', '--git-common-dir']]]);
    } finally {
      spies.forEach(spy => spy.mockRestore());
      gitSpy.mockRestore();
    }
    expect(await Promise.all(preservedPaths.map(file => fs.readFile(file)))).toEqual(before);

    expect(await fs.readFile(path.join(selectedPath, 'README.md'))).toEqual(workspaceBytes);
    expect(await fs.readFile(path.join(siblingPath, '.git'), 'utf8')).toBe(siblingPointer);
    await fs.writeFile(path.join(selectedPath, '.git'), selectedPointer, 'utf8');
  });

  it.each(['legacy', 'workspace', 'repository', 'repos-namespace', 'feature-namespace'])('rejects a relocated %s symlink before target access or Git', async (kind) => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const service = kind === 'legacy'
      ? new WorktreeService({ baseDir: fx.repos.api.path, hiveDir: path.join(fx.projectRoot, '.hive-legacy') })
      : fx.service;
    const created = await service.create(fx.feature, fx.task);
    const selected = created.repos?.api.path ?? created.path;
    const pointer = await fs.readFile(path.join(selected, '.git'), 'utf8');
    const admin = pointer.trim().slice('gitdir: '.length);
    const linkPath = kind === 'repository' ? selected
      : kind === 'repos-namespace' ? path.dirname(selected)
      : kind === 'feature-namespace' ? path.dirname(created.path) : created.path;
    const relocated = path.join(fx.projectRoot, 'relocated-workspace');
    const preserved = [path.join(selected, '.git'), path.join(selected, 'README.md'),
      ...(created.repos ? [path.join(created.path, 'workspace.json')] : []),
      ...['HEAD', 'index', 'commondir', 'gitdir'].map(name => path.join(admin, name))];
    const bytes = await Promise.all(preserved.map(file => fs.readFile(file)));
    await fs.rename(linkPath, relocated);
    await fs.symlink(relocated, linkPath);
    const forbidden: string[] = [];
    const spies = ['access', 'stat', 'lstat', 'readFile', 'realpath', 'readdir', 'open'].map(name => {
      const original = (fs as any)[name];
      return spyOn(fs as any, name).mockImplementation((file: any, ...args: any[]) => {
        const candidate = String(file);
        if (candidate.startsWith(relocated) || candidate.startsWith(`${linkPath}${path.sep}`)
          || (candidate === linkPath && name !== 'lstat')) forbidden.push(`${name}:${candidate}`);
        return original(file, ...args);
      });
    });
    const gitSpy = spyOn(service as any, 'getGit');
    try {
      await expect(service.get(fx.feature, fx.task)).rejects.toThrow(/path contains a symlink/);
      await expect(service.create(fx.feature, fx.task)).rejects.toThrow(/path contains a symlink/);
      expect(forbidden).toEqual([]);
      expect(gitSpy).not.toHaveBeenCalled();
    } finally {
      spies.forEach(spy => spy.mockRestore());
      gitSpy.mockRestore();
    }
    expect(await Promise.all(preserved.map(file => fs.readFile(file)))).toEqual(bytes);
    expect(await fs.readlink(linkPath)).toBe(relocated);
  });

  it("accepts a trusted linked manifest repository whose common directory is external to that repository path", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-linked-manifest-'));
    tempDirs.push(projectRoot);
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-external-common-'));
    tempDirs.push(externalRoot);
    const source = await makeRepo(externalRoot, 'source-api');
    const linkedPath = path.join(projectRoot, 'linked-api');
    await source.git.raw(['worktree', 'add', '-b', 'linked-source', linkedPath, 'HEAD']);
    const feature = 'linked-feature';
    const task = '01-linked-task';
    const taskPath = path.join(projectRoot, '.hive', 'features', `01_${feature}`, 'tasks', task);
    await fs.mkdir(taskPath, { recursive: true });
    await fs.writeFile(path.join(taskPath, 'status.json'), JSON.stringify({ status: 'pending', origin: 'plan', repoIds: ['api'] }));
    const service = new WorktreeService({
      baseDir: projectRoot,
      hiveDir: path.join(projectRoot, '.hive'),
      repositoryResolver: { resolveRepositories: () => [{ id: 'api', path: linkedPath, root: linkedPath }] },
      taskRepoResolver: { resolveTaskRepoIds: () => ['api'] },
    });

    const created = await service.create(feature, task);
    const commonDirectoryRaw = (await source.git.raw(['rev-parse', '--git-common-dir'])).trim();
    const commonDirectory = await fs.realpath(path.resolve(source.path, commonDirectoryRaw));

    expect(created.mode).toBe('composite');
    expect(commonDirectory.startsWith(`${linkedPath}${path.sep}`)).toBe(false);
    expect(commonDirectory.startsWith(`${projectRoot}${path.sep}`)).toBe(false);
    expect((await service.get(feature, task))?.repos?.api.path).toBe(created.repos?.api.path);
  });

  it.each([
    ['merge', async (fixture: TestFixture) => {
      const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage);
      if (!result.success) throw new Error(result.error);
      return result;
    }],
    ['remove', (fixture: TestFixture) => fixture.service.remove(fixture.feature, fixture.task)],
    ['cleanup', (fixture: TestFixture) => fixture.service.cleanup(fixture.feature)],
    ['export', (fixture: TestFixture) => fixture.service.exportPatch(fixture.feature, fixture.task)],
  ])('rejects former-root linkage before %s can use or mutate it', async (_operation, invoke) => {
    const fixture = await createFixture();
    const former = await createTempRepo();
    const formerWorktree = path.join(former.repoPath, 'former-worktree');
    await former.repoGit.raw(['worktree', 'add', '-b', 'former-task', formerWorktree, 'HEAD']);
    const formerPointer = await fs.readFile(path.join(formerWorktree, '.git'), 'utf8');
    const localPointerPath = path.join(fixture.worktreePath, '.git');
    await fs.writeFile(localPointerPath, formerPointer, 'utf8');
    const preserved = [
      localPointerPath,
      path.join(fixture.worktreePath, 'tracked.txt'),
      path.join(formerWorktree, '.git'),
      path.join(formerWorktree, 'tracked.txt'),
    ];
    const before = await Promise.all(preserved.map(file => fs.readFile(file)));
    const forbiddenAccess: string[] = [];
    const fsSpies = ['access', 'stat', 'lstat', 'readFile', 'realpath', 'readdir', 'open'].map(name => {
      const original = (fs as any)[name];
      return spyOn(fs as any, name).mockImplementation((file: any, ...args: any[]) => {
        const candidate = String(file);
        if (candidate === former.repoPath || candidate.startsWith(`${former.repoPath}${path.sep}`)) {
          forbiddenAccess.push(`${name}:${candidate}`);
        }
        return original(file, ...args);
      });
    });
    const gitCalls: Array<{ cwd: string | undefined; method: PropertyKey; args: unknown[] }> = [];
    const getGit = (fixture.service as any).getGit.bind(fixture.service);
    const gitSpy = spyOn(fixture.service as any, 'getGit').mockImplementation((cwd?: string) => {
      const git = getGit(cwd);
      return new Proxy(git, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            gitCalls.push({ cwd, method: key, args });
            return value.apply(target, args);
          };
        },
      });
    });
    try {
      await expect(invoke(fixture)).rejects.toThrow(/administration entry is outside the trusted Git common directory/);
      expect(forbiddenAccess).toEqual([]);
      expect(gitCalls[0]).toEqual({
        cwd: fixture.repoPath,
        method: 'raw',
        args: [['rev-parse', '--git-common-dir']],
      });
      expect(gitCalls.every((call) => call.cwd === fixture.repoPath)).toBe(true);
    } finally {
      fsSpies.forEach(spy => spy.mockRestore());
      gitSpy.mockRestore();
    }
    expect(await Promise.all(preserved.map(file => fs.readFile(file)))).toEqual(before);
  });

  it.each(['commondir', 'gitdir', 'entry-symlink', 'metadata-symlink', 'topology'])('rejects %s corruption before suspect Git or former-path access', async (fault) => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const created = await fx.service.create(fx.feature, fx.task);
    const selected = created.repos!.api.path;
    const pointerPath = path.join(selected, '.git');
    const pointer = await fs.readFile(pointerPath, 'utf8');
    const admin = pointer.trim().slice('gitdir: '.length);
    const former = path.join(fx.projectRoot, 'former');
    await fs.mkdir(former);
    await fs.writeFile(path.join(former, 'commondir'), '../..');
    if (fault === 'commondir' || fault === 'gitdir') await fs.writeFile(path.join(admin, fault), former);
    if (fault === 'entry-symlink') {
      await fs.symlink(former, `${admin}-escape`);
      await fs.writeFile(pointerPath, `gitdir: ${admin}-escape\n`);
    }
    if (fault === 'metadata-symlink') {
      await fs.unlink(path.join(admin, 'commondir'));
      await fs.symlink(path.join(former, 'commondir'), path.join(admin, 'commondir'));
    }
    if (fault === 'topology') {
      const file = path.join(created.path, 'workspace.json');
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      manifest.repos.api.repoRoot = former;
      await fs.writeFile(file, JSON.stringify(manifest));
    }
    const forbidden: string[] = [];
    const spies = ['access', 'stat', 'lstat', 'readFile', 'realpath', 'readdir', 'open'].map(name => {
      const original = (fs as any)[name];
      return spyOn(fs as any, name).mockImplementation((file: any, ...args: any[]) => {
        if (String(file).startsWith(former)
          || (fault === 'metadata-symlink' && name === 'readFile' && String(file) === path.join(admin, 'commondir'))) forbidden.push(`${name}:${file}`);
        return original(file, ...args);
      });
    });
    const gitPaths: string[] = [];
    const getGit = (fx.service as any).getGit.bind(fx.service);
    const gitSpy = spyOn(fx.service as any, 'getGit').mockImplementation((cwd: string) => {
      gitPaths.push(cwd);
      return getGit(cwd);
    });
    try {
      await expect(fx.service.get(fx.feature, fx.task)).rejects.toThrow(/Worktree linkage preflight failed/);
      expect(forbidden).toEqual([]);
      expect(gitPaths).toEqual(fault === 'topology' ? [] : [fx.repos.api.path]);
    } finally {
      spies.forEach(spy => spy.mockRestore());
      gitSpy.mockRestore();
    }
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

  it('retries composite creation after a pre-publication manifest failure', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const compositeRoot = path.join(fx.projectRoot, '.hive', '.worktrees', fx.feature, fx.task);
    const manifestPath = path.join(compositeRoot, 'workspace.json');
    const originalRename = fsSync.renameSync;
    let failPublication = true;
    const renameSpy = spyOn(fsSync, 'renameSync').mockImplementation(((source, destination) => {
      if (failPublication && String(destination) === manifestPath) {
        failPublication = false;
        const error = new Error('simulated manifest publication failure');
        throw error;
      }
      return originalRename(source, destination);
    }) as typeof fsSync.renameSync);

    try {
      await expect(fx.service.create(fx.feature, fx.task)).rejects.toThrow(
        /simulated manifest publication failure/,
      );
    } finally {
      renameSpy.mockRestore();
    }

    expect(await pathExists(compositeRoot)).toBe(false);
    expect(await branchExists(fx.repos.api.git, `hive/api/${fx.feature}/${fx.task}`)).toBe(false);

    const retry = await fx.service.create(fx.feature, fx.task);
    expect(retry.mode).toBe('composite');
    expect(await pathExists(retry.path)).toBe(true);
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

  it("list propagates composite linkage failure instead of hiding it", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const created = await fx.service.create(fx.feature, fx.task);
    const selectedPath = created.repos!.api.path;
    const siblingPath = path.join(fx.projectRoot, 'api-list-sibling');
    await fx.repos.api.git.raw(['worktree', 'add', '-b', 'list-sibling', siblingPath, 'HEAD']);
    const siblingPointer = await fs.readFile(path.join(siblingPath, '.git'), 'utf8');
    await fs.writeFile(path.join(selectedPath, '.git'), siblingPointer, 'utf8');

    await expect(fx.service.list(fx.feature)).rejects.toThrow(/backlink does not select this exact worktree/);
  });

  it("list propagates a namespace symlink integrity failure", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    await fx.service.create(fx.feature, fx.task);
    const featurePath = path.join(fx.projectRoot, '.hive', '.worktrees', fx.feature);
    const relocated = path.join(fx.projectRoot, 'relocated-feature');
    await fs.rename(featurePath, relocated);
    await fs.symlink(relocated, featurePath);

    await expect(fx.service.list(fx.feature)).rejects.toThrow(/path contains a symlink/);

    await fs.unlink(featurePath);
    await fs.rename(relocated, featurePath);
  });

  it("list returns an empty result when the worktrees directory is missing", async () => {
    const { repoPath } = await createTempRepo();
    const service = new WorktreeService({
      baseDir: repoPath,
      hiveDir: path.join(repoPath, '.hive'),
    });

    await expect(service.list()).resolves.toEqual([]);
  });

  it("list skips a step whose worktree directory is missing", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const created = await fx.service.create(fx.feature, fx.task);
    await fs.rm(created.path, { recursive: true, force: true });

    await expect(fx.service.list(fx.feature)).resolves.toEqual([]);
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

  it('does not claim a stale candidate was removed when its root remains', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);

    await fs.rm(wt.repos!['web-ui'].path, { recursive: true, force: true });
    await fs.writeFile(path.join(wt.path, 'keep.txt'), 'preserve\n', 'utf-8');

    const result = await fx.service.cleanup(fx.feature);

    expect(result.removed).not.toContain(wt.path);
    expect(await pathExists(wt.path)).toBe(true);
  });

  it("remove reports per-step cleanup status for a composite workspace", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);

    const result = await fx.service.remove(fx.feature, fx.task, true);

    expect(result).toMatchObject({ worktreeRemoved: true, branchDeleted: true, pruned: true });
    expect(result.cleanup).toMatchObject({
      requested: 'worktree+branch',
      outcome: 'complete',
      failures: [],
    });
    expect(result.cleanup.worktreeRemoval.status).toBe('succeeded');
    expect(result.cleanup.branchDeletion.status).toBe('succeeded');
    expect(result.cleanup.prune.status).toBe('succeeded');
    expect(await pathExists(wt.path)).toBe(false);
  });

  it('preserves a composite manifest when branch deletion fails, then retries after worktrees are absent', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    const manifestPath = path.join(wt.path, 'workspace.json');
    const originalGetGit = (fx.service as any).getGit.bind(fx.service);
    let failBranchDeletion = true;
    const gitSpy = spyOn(fx.service as any, 'getGit').mockImplementation((cwd?: string) => {
      const git = originalGetGit(cwd);
      return new Proxy(git, {
        get(target, key) {
          if (key === 'raw') {
            return (args: string[]) => args[0] === 'update-ref' && args[1] === '-d' && failBranchDeletion
              ? Promise.reject(new Error('simulated branch deletion failure'))
              : target.raw(args);
          }
          return Reflect.get(target, key);
        },
      });
    });

    let first;
    try {
      first = await fx.service.remove(fx.feature, fx.task, true);
    } finally {
      gitSpy.mockRestore();
    }

    expect(first.cleanup.branchDeletion.status).toBe('failed');
    expect(await pathExists(wt.path)).toBe(true);
    expect(await pathExists(manifestPath)).toBe(true);
    expect(await pathExists(wt.repos!.api.path)).toBe(false);
    expect(await pathExists(wt.repos!['web-ui'].path)).toBe(false);

    failBranchDeletion = false;
    const retry = await fx.service.remove(fx.feature, fx.task, true);
    expect(retry.cleanup).toMatchObject({ requested: 'worktree+branch', outcome: 'complete' });
    expect(await pathExists(wt.path)).toBe(false);
    expect(await branchExists(fx.repos.api.git, wt.repos!.api.branch)).toBe(false);
    expect(await branchExists(fx.repos['web-ui'].git, wt.repos!['web-ui'].branch)).toBe(false);
  });

  it("remove reports not_requested for branch deletion and an already absent worktree", async () => {
    const fixture = await createFixture();
    await fixture.repoGit.raw(['worktree', 'remove', fixture.worktreePath, '--force']);

    const result = await fixture.service.remove(fixture.feature, fixture.task, false);

    expect(result.cleanup).toMatchObject({
      requested: 'worktree',
      outcome: 'complete',
      failures: [],
    });
    expect(result.cleanup.worktreeRemoval.status).toBe('already_absent');
    expect(result.cleanup.branchDeletion.status).toBe('not_requested');
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(await branchExists(fixture.repoGit, 'hive/test-feature/01-test-task')).toBe(true);
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

  it('rejects an unusable sidecar baseline instead of silently diffing HEAD~1', async () => {
    const fx = await createFixture();
    const metadataPath = `${fx.worktreePath}.json`;
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    metadata.baseCommit = 'not-a-commit';
    await fs.writeFile(metadataPath, JSON.stringify(metadata));

    await expect(fx.service.getDiff(fx.feature, fx.task)).rejects.toThrow(
      new RegExp(`Failed to diff workspace .* from baseline not-a-commit`),
    );
  });

  it('uses the legacy task status baseline when no sidecar exists', async () => {
    const fx = await createFixture();
    const baseCommit = (await fx.repoGit.revparse(['HEAD'])).trim();
    await fs.unlink(`${fx.worktreePath}.json`);
    const statusPath = path.join(fx.repoPath, '.hive', 'features', fx.feature, 'tasks', fx.task, 'status.json');
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(statusPath, JSON.stringify({ baseCommit }));
    await fs.writeFile(path.join(fx.worktreePath, 'legacy-status.txt'), 'change\n');

    const diff = await fx.service.getDiff(fx.feature, fx.task);

    expect(diff.filesChanged).toContain('legacy-status.txt');
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
    await g.commit(testCommitMessage(`chore: ${repoId} ${file}`));
  }

  async function commitNetZeroChangeInRepo(fx: CompositeFixture, repoId: string): Promise<void> {
    const wt = await fx.service.get(fx.feature, fx.task);
    const repoWt = wt!.repos![repoId].path;
    const g = simpleGit(repoWt);
    await fs.writeFile(path.join(repoWt, 'README.md'), `${repoId} transient\n`, 'utf-8');
    await g.add('-A');
    await g.commit(testCommitMessage(`chore: ${repoId} transient`));
    await fs.writeFile(path.join(repoWt, 'README.md'), `# ${repoId}\n`, 'utf-8');
    await g.add('-A');
    await g.commit(testCommitMessage(`revert: ${repoId} transient`));
  }

  it("merges a single-repo composite task into the source repo's current branch", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'task.txt', 'task\n');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

    expect(result.success).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.error).toMatch(/web-ui/);
    expect(result.error).toMatch(/linkage preflight|branch|not found/i);
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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

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
    await wg.commit(testCommitMessage('chore: task side'));

    // Diverge main of web-ui
    await fs.writeFile(path.join(fx.repos['web-ui'].path, 'README.md'), 'main-side\n', 'utf-8');
    await fx.repos['web-ui'].git.add('-A');
    await fx.repos['web-ui'].git.commit('chore: main side');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

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
    await wg.commit(testCommitMessage('chore: task side'));

    await fs.writeFile(path.join(fx.repos['web-ui'].path, 'README.md'), 'main-side\n', 'utf-8');
    await fx.repos['web-ui'].git.add('-A');
    await fx.repos['web-ui'].git.commit('chore: main side');

    const apiHeadBefore = (await fx.repos['api'].git.revparse(['HEAD'])).trim();

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, {
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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

    expect(result.success).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.repos!['api'].success).toBe(true);
    expect(result.repos!['web-ui'].success).toBe(false);
    expect(result.error).toMatch(/web-ui/);
    // api merge not rolled back
    const apiHeadAfter = (await fx.repos['api'].git.revparse(['HEAD'])).trim();
    expect(apiHeadAfter).not.toBe(apiHeadBefore);
  });

  it('reports the durable repository integration delta on a composite partial merge', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'api-new.txt', 'api\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    // web-ui rejects the merge commit through a pre-merge-commit hook, so the
    // api integration is durable and web-ui is not.
    const hookDir = path.join(fx.repos['web-ui'].path, '.git', 'hooks');
    await fs.mkdir(hookDir, { recursive: true });
    const hookPath = path.join(hookDir, 'pre-merge-commit');
    await fs.writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf-8');
    await fs.chmod(hookPath, 0o755);

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      partial: true,
      reasonCode: 'COMPOSITE_PARTIAL',
      mutation: 'partial',
    });
    expect(result.repos!['api'].merged).toBe(true);
    expect(result.repos!['web-ui'].success).toBe(false);
    expect(result.filesChanged).toEqual(['api:api-new.txt']);
  });

  it('rolls back a later repo after its second cherry-pick fails and reports only the earlier repo as partial progress', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'api.txt', 'api\n');

    const wt = await fx.service.get(fx.feature, fx.task);
    const webWorktree = wt!.repos!['web-ui'].path;
    const webWorktreeGit = simpleGit(webWorktree);
    await fs.writeFile(path.join(webWorktree, 'first.txt'), 'first\n', 'utf-8');
    await webWorktreeGit.add('-A');
    await webWorktreeGit.commit(testCommitMessage('feat: first web source commit'));
    await fs.writeFile(path.join(webWorktree, 'README.md'), 'task side\n', 'utf-8');
    await webWorktreeGit.add('-A');
    await webWorktreeGit.commit(testCommitMessage('feat: conflicting second web source commit'));

    await fs.writeFile(path.join(fx.repos['web-ui'].path, 'README.md'), 'main side\n', 'utf-8');
    await fx.repos['web-ui'].git.add('-A');
    await fx.repos['web-ui'].git.commit(testCommitMessage('feat: conflicting web target commit'));
    const before = {
      api: (await fx.repos.api.git.revparse(['HEAD'])).trim(),
      web: (await fx.repos['web-ui'].git.revparse(['HEAD'])).trim(),
    };

    const result = await fx.service.merge(fx.feature, fx.task, 'rebase');

    expect(result).toMatchObject({
      success: false,
      merged: false,
      partial: true,
      reasonCode: 'COMPOSITE_PARTIAL',
      phase: 'integration',
      mutation: 'partial',
      retryable: false,
      action: 'inspect_state',
    });
    expect(result.repos!.api).toMatchObject({ success: true, merged: true });
    expect(result.repos!['web-ui']).toMatchObject({ success: false, merged: false, conflictState: 'aborted' });
    expect(result.repos!.api.operationStatus).toBe('success');
    expect(result.repos!['web-ui'].operationStatus).toBe('failed');
    expect((await fx.repos.api.git.revparse(['HEAD'])).trim()).not.toBe(before.api);
    expect((await fx.repos['web-ui'].git.revparse(['HEAD'])).trim()).toBe(before.web);
    expect((await fx.repos['web-ui'].git.status()).isClean()).toBe(true);
  });

  it('classifies a composite preflight failure with its specific reason code and no partial progress', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');
    await fs.writeFile(path.join(fx.repos['api'].path, 'README.md'), 'dirty\n', 'utf-8');
    const beforeWeb = (await fx.repos['web-ui'].git.revparse(['HEAD'])).trim();

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      reasonCode: 'TARGET_DIRTY',
      phase: 'preflight',
      mutation: 'none',
      retryable: true,
      action: 'clean_target',
      partial: false,
    });
    expect((await fx.repos['web-ui'].git.revparse(['HEAD'])).trim()).toBe(beforeWeb);
  });

  it('classifies a linkage preflight failure in a composite repo as WORKTREE_LINKAGE_INVALID', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const created = await fx.service.create(fx.feature, fx.task);
    const selectedPath = created.repos!.api.path;
    const siblingPath = path.join(fx.projectRoot, 'api-sibling');
    await fx.repos.api.git.raw(['worktree', 'add', '-b', 'sibling-registration', siblingPath, 'HEAD']);
    const siblingPointer = await fs.readFile(path.join(siblingPath, '.git'), 'utf8');
    await fs.writeFile(path.join(selectedPath, '.git'), siblingPointer, 'utf8');
    const beforeHead = (await fx.repos.api.git.revparse(['HEAD'])).trim();

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      reasonCode: 'WORKTREE_LINKAGE_INVALID',
      phase: 'preflight',
      mutation: 'none',
      retryable: false,
      action: 'start_fresh_run',
      partial: false,
    });
    expect(result.error).toMatch(/backlink does not select this exact worktree/);
    expect((await fx.repos.api.git.revparse(['HEAD'])).trim()).toBe(beforeHead);
  });

  it('classifies a workspace topology mismatch as WORKSPACE_TOPOLOGY_MISMATCH', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const created = await fx.service.create(fx.feature, fx.task);
    const manifestPath = path.join(created.path, 'workspace.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    const former = path.join(fx.projectRoot, 'former');
    await fs.mkdir(former, { recursive: true });
    manifest.repos.api.repoRoot = former;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const beforeHead = (await fx.repos.api.git.revparse(['HEAD'])).trim();

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      reasonCode: 'WORKSPACE_TOPOLOGY_MISMATCH',
      phase: 'preflight',
      mutation: 'none',
      retryable: false,
      action: 'start_fresh_run',
      partial: false,
    });
    expect(result.error).toMatch(/workspace topology does not match the trusted repository manifest/);
    expect((await fx.repos.api.git.revparse(['HEAD'])).trim()).toBe(beforeHead);
  });

  it("cleanup=worktree+branch aggregates per-repo cleanup across composite repos", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, {
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

  it('skips all task-composite cleanup when an earlier target moves after integration', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const created = await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'api.txt', 'api\n');
    await commitChangeInRepo(fx, 'web-ui', 'web.txt', 'web\n');
    const original = (fx.service as any).mergeOneRepo.bind(fx.service);
    let calls = 0;
    const mergeSpy = spyOn(fx.service as any, 'mergeOneRepo').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      calls += 1;
      if (calls === 2) {
        await fs.writeFile(path.join(fx.repos.api.path, 'target-race.txt'), 'race\n');
        await fx.repos.api.git.add('-A');
        await fx.repos.api.git.commit(testCommitMessage('chore: advance target during cleanup handoff'));
      }
      return result;
    });
    let result;
    try {
      result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, {
        cleanup: 'worktree+branch',
      });
    } finally {
      mergeSpy.mockRestore();
    }

    expect(result.cleanup.outcome).toBe('failed');
    expect(result.repos!.api.cleanup.worktreeRemoval.status).toBe('not_attempted');
    expect(result.repos!['web-ui'].cleanup.worktreeRemoval.status).toBe('not_attempted');
    expect(await pathExists(created.repos!.api.path)).toBe(true);
    expect(await pathExists(created.repos!['web-ui'].path)).toBe(true);
  });

  it("populates per-repo cleanup fields when cleanup=worktree+branch and aggregates them at top level", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, {
      cleanup: 'worktree+branch',
    });

    expect(result.success).toBe(true);
    expect(result.repos).toBeDefined();
    for (const id of ['api', 'web-ui']) {
      expect(result.repos![id].cleanup).toMatchObject({
        requested: 'worktree+branch',
        outcome: 'complete',
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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, {
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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

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
    await wg.commit(testCommitMessage('chore: web-ui task side'));

    await fs.writeFile(path.join(fx.repos['web-ui'].path, 'README.md'), 'main-side\n', 'utf-8');
    await fx.repos['web-ui'].git.add('-A');
    await fx.repos['web-ui'].git.commit('chore: web-ui main side');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage);

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
      await g.commit(testCommitMessage(`chore: ${id} task change`));
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

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage);

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.repos).toBeUndefined();
    expect(result.partial).toBeUndefined();
  });
});
