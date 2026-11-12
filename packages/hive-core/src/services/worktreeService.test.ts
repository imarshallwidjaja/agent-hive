import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import simpleGit, { type SimpleGit } from "simple-git";
import type { ResolvedRepository } from "../types";
import { WorktreeService as CoreWorktreeService } from "./worktreeService";
import type { BulkCleanupFailure, MergeOptions, MergeResult, WorktreeConfig } from "./worktreeService";
import { WorktreeLinkageError, WorktreeOperationRecoveryRequiredError } from "./worktreeOutcome";
import { repositoryResourceName, trustedGitCommonDirectory, WorktreeOperationRecoveryService } from './worktreeOperation.js';
import { RepositoryService } from './repositoryService.js';
import { inspectTargetMergeEligibility } from './worktreeIntegration.js';
import { recordIntegrationReceipt } from './integrationReceipt.js';
import { readWorktreeTargetIdentity } from './worktreeTarget.js';
import { RetainedCheckoutService } from './retainedCheckoutService.js';
import { TaskService } from './taskService.js';
import { probeLock } from '../utils/paths.js';

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
// Parameterized strategy tests declare the intent each strategy requires.
const intentFor = (strategy: 'merge' | 'squash' | 'rebase') => strategy === 'merge' ? 'preserve-source' as const : 'rewrite-private' as const;

// Existing behavior tests supply the inspect result as an operator would. Tests
// for the mandatory expectation and history-intent contracts instantiate
// CoreWorktreeService. This subclass never supplies a strategy or intent.
class WorktreeService extends CoreWorktreeService {
  private readonly testConfig: WorktreeConfig;

  constructor(config: WorktreeConfig) {
    super(config);
    this.testConfig = config;
  }

  override async merge(
    feature: string,
    step: string,
    strategy: 'merge' | 'squash' | 'rebase' | undefined,
    message: string | undefined,
    options: MergeOptions,
    attemptSlot?: string,
  ): Promise<MergeResult> {
    if (options.expectedTarget === undefined && options.expectedTargets === undefined) {
      try {
        const inspected = await this.inspect(feature, step, attemptSlot);
        if (inspected?.repos) {
          options = {
            ...options,
            expectedTargets: Object.fromEntries(Object.entries(inspected.repos).map(([id, repo]) => [id, repo.target!])),
          };
        } else if (inspected) {
          options = { ...options, expectedTarget: inspected.target! };
        } else {
          options = { ...options, expectedTarget: await readWorktreeTargetIdentity(this.testConfig.baseDir) };
        }
      } catch {
        const taskResolver = this.testConfig.taskRepoResolver;
        const repoIds = typeof taskResolver === 'function'
          ? taskResolver(feature, step)
          : taskResolver?.resolveTaskRepoIds(feature, step);
        const repositoryResolver = this.testConfig.repositoryResolver;
        const repositories = typeof repositoryResolver === 'function'
          ? repositoryResolver()
          : repositoryResolver?.resolveRepositories();
        if (repoIds?.length && repositories) {
          options = {
            ...options,
            expectedTargets: Object.fromEntries(await Promise.all(repoIds.map(async (id) => {
              const repository = repositories.find((entry) => entry.id === id)!;
              return [id, await readWorktreeTargetIdentity(repository.path)];
            }))),
          };
        } else {
          options = { ...options, expectedTarget: await readWorktreeTargetIdentity(this.testConfig.baseDir) };
        }
      }
    }
    return super.merge(feature, step, strategy, message, options, attemptSlot);
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

async function createTempRepo(seedTask = true): Promise<{ repoPath: string; repoGit: SimpleGit }> {
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

  if (seedTask) {
    const taskPath = path.join(repoPath, '.hive', 'features', 'test-feature', 'tasks', '01-test-task');
    await fs.mkdir(taskPath, { recursive: true });
    await fs.writeFile(path.join(taskPath, 'status.json'), JSON.stringify({ status: 'pending', origin: 'plan' }));
  }
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
  // These Git merge fixtures isolate integration behavior; Hive local-data protection has its own test.
  await fs.rm(path.join(repoPath, '.hive', 'features', feature, 'tasks', task), { recursive: true });

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

async function createDivergentDirectoryRenameFixture(sourcePath: string): Promise<TestFixture> {
  const fixture = await createFixture();
  const originalDirectory = path.join(fixture.repoPath, 'original');
  await fs.mkdir(originalDirectory);
  await fs.writeFile(path.join(originalDirectory, 'base.txt'), 'base directory content\n', 'utf-8');
  await fixture.repoGit.add('-A');
  await fixture.repoGit.commit(testCommitMessage('feat: add original directory'));
  const sharedCommit = (await fixture.repoGit.revparse(['HEAD'])).trim();

  const worktreeGit = simpleGit(fixture.worktreePath);
  await worktreeGit.merge([sharedCommit, '--ff-only']);
  const sourceFile = path.join(fixture.worktreePath, sourcePath);
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, 'incoming source content\n', 'utf-8');
  await worktreeGit.add('-A');
  await worktreeGit.commit(testCommitMessage('feat: add source file before directory rename'));

  await fixture.repoGit.mv('original', 'renamed');
  await fixture.repoGit.add('-A');
  await fixture.repoGit.commit(testCommitMessage('refactor: rename target directory'));
  return fixture;
}

async function createLateRebaseEligibilityFixture(): Promise<{
  fixture: TestFixture;
  beforeHead: string;
  collisionPath: string;
}> {
  const fixture = await createFixture();
  const worktreeGit = simpleGit(fixture.worktreePath);
  await fs.writeFile(path.join(fixture.worktreePath, 'first.txt'), 'first\n', 'utf-8');
  await worktreeGit.add('-A');
  await worktreeGit.commit(testCommitMessage('feat: add first file'));
  await fs.mkdir(path.join(fixture.worktreePath, 'nested'));
  await fs.writeFile(path.join(fixture.worktreePath, 'nested', 'file.txt'), 'task content\n', 'utf-8');
  await worktreeGit.add('-A');
  await worktreeGit.commit(testCommitMessage('feat: add nested file'));
  await fs.appendFile(path.join(fixture.repoPath, '.gitignore'), 'nested/\n', 'utf-8');
  await fixture.repoGit.add('.gitignore');
  await fixture.repoGit.commit(testCommitMessage('chore: ignore nested repository'));
  return {
    fixture,
    beforeHead: (await fixture.repoGit.revparse(['HEAD'])).trim(),
    collisionPath: path.join(fixture.repoPath, 'nested', 'user.txt'),
  };
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

// Reads ancestry through Git's own exit status, independently of the service.
function gitIsAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoPath });
  if (result.status !== 0 && result.status !== 1) throw new Error(`merge-base failed: ${result.stderr}`);
  return result.status === 0;
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

async function waitForPath(targetPath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pathExists(targetPath))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${targetPath}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Stall the next commit in a repository inside its hook, so an operation that
 * commits there keeps that repository's operation lock until released.
 */
async function stallNextCommit(repoPath: string): Promise<{ held: Promise<void>; release: () => Promise<void> }> {
  const gate = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-task-commit-gate-'));
  tempDirs.push(gate);
  await installPrepareCommitMessageHook(
    repoPath,
    `touch "${gate}/held"\nwhile [ ! -f "${gate}/release" ]; do sleep 0.05; done`,
  );
  return {
    held: waitForPath(path.join(gate, 'held')),
    release: () => fs.writeFile(path.join(gate, 'release'), ''),
  };
}

describe("WorktreeService merge and commit messages", () => {
  it.each(['missing-folder', 'missing-status', 'unreadable-status', 'null-record', 'null-status', 'invalid-string-status', 'boolean-status', 'number-status', 'object-status', 'array-status'])('rejects a legacy task with %s before creating Git state', async (integrity) => {
    const { repoPath, repoGit } = await createTempRepo(false);
    const service = new WorktreeService({ baseDir: repoPath, hiveDir: path.join(repoPath, '.hive') });
    const taskPath = path.join(repoPath, '.hive', 'features', 'test-feature', 'tasks', '01-test-task');
    if (integrity !== 'missing-folder') {
      await fs.mkdir(taskPath, { recursive: true });
      if (integrity !== 'missing-status') {
        const content = {
          'unreadable-status': '{',
          'null-record': 'null',
          'null-status': '{"status":null}',
          'invalid-string-status': '{"status":"completed"}',
          'boolean-status': '{"status":true}',
          'number-status': '{"status":1}',
          'object-status': '{"status":{}}',
          'array-status': '{"status":[]}',
        }[integrity]!;
        await fs.writeFile(path.join(taskPath, 'status.json'), content);
      }
    }
    const before = await repoGit.raw(['worktree', 'list', '--porcelain']);
    await expect(service.create('test-feature', '01-test-task')).rejects.toThrow('has no readable task status');
    expect(await repoGit.raw(['worktree', 'list', '--porcelain'])).toBe(before);
    expect(await branchExists(repoGit, 'hive/test-feature/01-test-task')).toBe(false);
    expect(await pathExists(service.getWorktreePath('test-feature', '01-test-task'))).toBe(false);
  });

  it.each(['pending', 'in_progress', 'blocked', 'failed', 'partial', 'done', 'cancelled'])('creates a legacy worktree for recognized task status %s', async (status) => {
    const { repoPath, repoGit } = await createTempRepo(false);
    const service = new WorktreeService({ baseDir: repoPath, hiveDir: path.join(repoPath, '.hive') });
    const taskPath = path.join(repoPath, '.hive', 'features', 'test-feature', 'tasks', '01-test-task');
    await fs.mkdir(taskPath, { recursive: true });
    await fs.writeFile(path.join(taskPath, 'status.json'), JSON.stringify({ status }));

    const worktree = await service.create('test-feature', '01-test-task');
    expect(await branchExists(repoGit, worktree.branch)).toBe(true);
    expect(await pathExists(worktree.path)).toBe(true);
    expect(await service.get('test-feature', '01-test-task')).toMatchObject({ path: worktree.path, branch: worktree.branch });
  });

  it("uses logical feature names for indexed worktree storage and branch naming", async () => {
    const { repoPath } = await createTempRepo(false);
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

    const result = await fixture.service.merge(fixture.feature, fixture.task, "merge", message, { historyIntent: 'preserve-source' });

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

    const result = await fixture.service.merge(fixture.feature, fixture.task, "squash", message, { historyIntent: 'rewrite-private' });

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

    const result = await fixture.service.merge(fixture.feature, fixture.task, undefined, undefined, { historyIntent: 'rewrite-private' });

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

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'rebase', undefined, { historyIntent: 'rewrite-private' });

    expect(result.success).toBe(false);
    expect(result.error).toContain(malformedHead.slice(0, 7));
    expect(result.error).toMatch(/source commit.*subject.*blank line.*body/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('restores the target after a squash conflict', async () => {
    const fixture = await createConflictingFixture();
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });

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

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });

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

      const result = await fixture.service.merge(fixture.feature, fixture.task, strategy, mergeMessage, { historyIntent: intentFor(strategy) });

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

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'rebase', undefined, { historyIntent: 'rewrite-private' });

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
      historyIntent: 'rewrite-private',
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

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });

    expect(result).toMatchObject({ success: false, merged: false, conflictState: 'none' });
    expect(result.error).toMatch(/dirty|uncommitted/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect(await fixture.repoGit.raw(['status', '--porcelain=v1'])).toBe(beforeStatus);
    expect(await fixture.repoGit.raw(['diff', '--cached', '--binary'])).toBe(beforeIndex);
    expect(await fs.readFile(trackedPath, 'utf-8')).toBe('staged user content\n');
    expect(await fs.readFile(untrackedPath, 'utf-8')).toBe('untracked user content\n');
  });

  for (const strategy of ['squash', 'merge', 'rebase'] as const) {
    it(`preserves disjoint untracked and ignored target files during path-bounded ${strategy}`, async () => {
      const fixture = await createCommittedFixture();
      const worktreeGit = simpleGit(fixture.worktreePath);
      await fs.writeFile(path.join(fixture.worktreePath, 'second-task-change.txt'), 'second task change\n', 'utf-8');
      await worktreeGit.add('-A');
      await worktreeGit.commit(testCommitMessage('feat: add second source commit'));
      const untrackedPath = path.join(fixture.repoPath, 'user\nnote.txt');
      const untrackedContent = Buffer.from([0, 1, 2, 10, 255]);
      await fs.writeFile(untrackedPath, untrackedContent);
      await fs.appendFile(path.join(fixture.repoPath, '.git', 'info', 'exclude'), 'build/\n', 'utf-8');
      const ignoredPath = path.join(fixture.repoPath, 'build', 'cache.bin');
      const ignoredContent = Buffer.from([255, 0, 17, 10]);
      await fs.mkdir(path.dirname(ignoredPath));
      await fs.writeFile(ignoredPath, ignoredContent);

      const result = await fixture.service.merge(
        fixture.feature,
        fixture.task,
        strategy,
        strategy === 'rebase' ? undefined : mergeMessage,
        { historyIntent: intentFor(strategy) },
      );

      expect(result).toMatchObject({ success: true, merged: true });
      expect(await fs.readFile(untrackedPath)).toEqual(untrackedContent);
      expect(await fs.readFile(ignoredPath)).toEqual(ignoredContent);
      expect((await fixture.repoGit.raw(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0')).toContain('user\nnote.txt');
    });
  }

  it('rejects an untracked collision at a rename destination without mutation', async () => {
    const fixture = await createFixture();
    const worktreeGit = simpleGit(fixture.worktreePath);
    await worktreeGit.mv('tracked.txt', 'renamed.txt');
    await worktreeGit.commit(testCommitMessage('refactor: rename tracked file'));
    await fs.writeFile(path.join(fixture.repoPath, 'renamed.txt'), 'user content\n', 'utf-8');
    await fixture.repoGit.raw(['config', 'status.showUntrackedFiles', 'no']);
    expect(await fixture.repoGit.raw(['status', '--porcelain=v1'])).toBe('');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

    expect(result).toMatchObject({ success: false, reasonCode: 'TARGET_DIRTY', mutation: 'none' });
    expect(result.error).toMatch(/untracked path.*renamed\.txt.*collides/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect(await fs.readFile(path.join(fixture.repoPath, 'renamed.txt'), 'utf-8')).toBe('user content\n');
  });

  for (const strategy of ['squash', 'merge', 'rebase'] as const) {
    it(`rejects divergent ${strategy} before a directory rename can overwrite an ignored destination`, async () => {
      const fixture = await createDivergentDirectoryRenameFixture('original/generated.txt');
      await fs.appendFile(path.join(fixture.repoPath, '.git', 'info', 'exclude'), 'renamed/generated.txt\n', 'utf-8');
      const sentinelPath = path.join(fixture.repoPath, 'renamed', 'generated.txt');
      const sentinel = Buffer.from([0, 255, 10, 99]);
      await fs.writeFile(sentinelPath, sentinel);
      const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
      const beforeStatus = await fixture.repoGit.raw([
        'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching',
      ]);

      const result = await fixture.service.merge(
        fixture.feature,
        fixture.task,
        strategy,
        strategy === 'rebase' ? undefined : mergeMessage,
        { historyIntent: intentFor(strategy) },
      );

      expect(result).toMatchObject({
        success: false,
        reasonCode: 'TARGET_RECONCILIATION_REQUIRED',
        mutation: 'none',
        retryable: false,
        action: 'reconcile_target',
      });
      expect(result.error).toMatch(/pinned target.*source worktree.*fresh source and target pins/i);
      expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
      expect(await fixture.repoGit.raw([
        'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching',
      ])).toBe(beforeStatus);
      expect(await fs.readFile(sentinelPath)).toEqual(sentinel);
    });
  }

  it('rejects a divergent directory rename without changing an untracked nested repository', async () => {
    const fixture = await createDivergentDirectoryRenameFixture('original/foreign/incoming.txt');
    const foreignRoot = path.join(fixture.repoPath, 'renamed', 'foreign');
    await fs.mkdir(foreignRoot);
    const foreignGit = simpleGit(foreignRoot);
    await foreignGit.init();
    await foreignGit.raw(['config', 'user.email', 'foreign@example.com']);
    await foreignGit.raw(['config', 'user.name', 'Foreign User']);
    const foreignFile = path.join(foreignRoot, 'incoming.txt');
    await fs.writeFile(foreignFile, 'foreign bytes\n', 'utf-8');
    await foreignGit.add('-A');
    await foreignGit.commit(testCommitMessage('chore: preserve foreign repository'));
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    const foreignHead = (await foreignGit.revparse(['HEAD'])).trim();
    const foreignStatus = await foreignGit.raw(['status', '--porcelain=v1', '-z']);

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });

    expect(result).toMatchObject({
      success: false,
      reasonCode: 'TARGET_RECONCILIATION_REQUIRED',
      mutation: 'none',
      retryable: false,
      action: 'reconcile_target',
    });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await foreignGit.revparse(['HEAD'])).trim()).toBe(foreignHead);
    expect(await foreignGit.raw(['status', '--porcelain=v1', '-z'])).toBe(foreignStatus);
    expect(await fs.readFile(foreignFile, 'utf-8')).toBe('foreign bytes\n');
  });

  it('requires reconciliation for divergent history with local data hidden by status configuration', async () => {
    const fixture = await createCommittedFixture();
    await fs.writeFile(path.join(fixture.repoPath, 'target-only.txt'), 'target change\n', 'utf-8');
    await fixture.repoGit.add('-A');
    await fixture.repoGit.commit(testCommitMessage('feat: advance target independently'));
    await fixture.repoGit.raw(['config', 'status.showUntrackedFiles', 'no']);
    const localPath = path.join(fixture.repoPath, 'disjoint-local.txt');
    await fs.writeFile(localPath, 'local content\n', 'utf-8');
    expect(await fixture.repoGit.raw(['status', '--porcelain=v1'])).toBe('');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

    expect(result).toMatchObject({
      success: false,
      reasonCode: 'TARGET_RECONCILIATION_REQUIRED',
      mutation: 'none',
      retryable: false,
      action: 'reconcile_target',
    });
    expect(result.error).toMatch(/path-bounded integration.*reconcile/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect(await fs.readFile(localPath, 'utf-8')).toBe('local content\n');
  });

  it('preserves standard-layout Hive state when divergent history requires reconciliation', async () => {
    const fixture = await createCommittedFixture();
    await fs.writeFile(path.join(fixture.repoPath, 'target-only.txt'), 'target change\n', 'utf-8');
    await fixture.repoGit.add('-A');
    await fixture.repoGit.commit(testCommitMessage('feat: advance target with Hive state present'));
    const hiveStatePath = path.join(fixture.repoPath, '.hive', 'features', 'active', 'context', 'decisions.md');
    const hiveState = '# Decisions\n\nKeep this local state.\n';
    await fs.mkdir(path.dirname(hiveStatePath), { recursive: true });
    await fs.writeFile(hiveStatePath, hiveState, 'utf-8');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

    expect(result).toMatchObject({
      success: false,
      reasonCode: 'TARGET_RECONCILIATION_REQUIRED',
      phase: 'preflight',
      mutation: 'none',
      retryable: false,
      action: 'reconcile_target',
    });
    expect(result.error).toContain('.hive/features/active/context/decisions.md');
    expect(result.error).not.toMatch(/clean|delete|remove/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect(await fs.readFile(hiveStatePath, 'utf-8')).toBe(hiveState);
  });

  it('expands root commits and rescans excluded roots with literal pathspecs', async () => {
    const { repoPath, repoGit } = await createTempRepo();
    const targetCommit = (await repoGit.revparse(['HEAD'])).trim();
    await repoGit.raw(['checkout', '--orphan', 'root-source']);
    await repoGit.raw(['rm', '-rf', '.']);
    await fs.writeFile(path.join(repoPath, 'root-source.txt'), 'root source\n', 'utf-8');
    await repoGit.add('-A');
    await repoGit.commit(testCommitMessage('feat: create unrelated root source'));
    const sourceCommit = (await repoGit.revparse(['HEAD'])).trim();
    await repoGit.checkout('main');

    const excludedPath = path.join(repoPath, 'local[1]', 'excluded');
    await fs.mkdir(excludedPath, { recursive: true });
    await fs.writeFile(path.join(excludedPath, 'diagnostic.json'), '{}\n', 'utf-8');
    const preservedPath = path.join(repoPath, 'local[1]', 'preserved.txt');
    await fs.writeFile(preservedPath, 'preserved\n', 'utf-8');

    const result = await inspectTargetMergeEligibility({
      targetGit: repoGit,
      targetRoot: repoPath,
      targetCommit,
      sourceCommit,
      policy: { historyIntent: 'rewrite-private', strategy: 'rebase' },
      excludedLocalPaths: [excludedPath],
    });

    expect(result).toMatchObject({ reasonCode: 'TARGET_RECONCILIATION_REQUIRED' });
    expect('error' in result && result.error).toContain('local[1]/preserved.txt');
    expect(await fs.readFile(preservedPath, 'utf-8')).toBe('preserved\n');
  });

  it('refuses a nonlinear rebase range as an argument error before topology, local data or any mutation', async () => {
    const fixture = await createFixture();
    const worktreeGit = simpleGit(fixture.worktreePath);
    const sourceBranch = (await worktreeGit.branch()).current;
    await worktreeGit.checkoutLocalBranch('nonlinear-side');
    await fs.writeFile(path.join(fixture.worktreePath, 'side.txt'), 'side\n', 'utf-8');
    await worktreeGit.add('-A');
    await worktreeGit.commit(testCommitMessage('feat: add side change'));
    await worktreeGit.checkout(sourceBranch);
    await fs.writeFile(path.join(fixture.worktreePath, 'main-source.txt'), 'main source\n', 'utf-8');
    await worktreeGit.add('-A');
    await worktreeGit.commit(testCommitMessage('feat: add main source change'));
    await worktreeGit.merge(['nonlinear-side', '--no-ff', '-m', testCommitMessage('merge: combine source history')]);
    const localPath = path.join(fixture.repoPath, 'local-note.txt');
    await fs.writeFile(localPath, 'local\n', 'utf-8');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'rebase', undefined, { historyIntent: 'rewrite-private' });

    expect(result).toMatchObject({
      success: false,
      reasonCode: 'INVALID_ARGUMENTS',
      phase: 'validation',
      mutation: 'none',
      retryable: false,
      action: 'correct_arguments',
      error: expect.stringMatching(/linear replay range.*strategy 'squash'.*normal merge/),
    });
    expect(await pathExists(path.join(fixture.repoPath, '.hive', '.locks', 'operations'))
      ? fsSync.readdirSync(path.join(fixture.repoPath, '.hive', '.locks', 'operations'))
      : []).toEqual([]);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect(await pathExists(path.join(fixture.repoPath, 'main-source.txt'))).toBe(false);
    expect(await pathExists(path.join(fixture.repoPath, 'side.txt'))).toBe(false);
    expect(await fs.readFile(localPath, 'utf-8')).toBe('local\n');
  });

  it('rejects an untracked file that is an ancestor of an incoming path', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.join(fixture.worktreePath, 'nested'));
    await fs.writeFile(path.join(fixture.worktreePath, 'nested', 'change.txt'), 'task content\n', 'utf-8');
    await commitTaskChanges(fixture.service, fixture.feature, fixture.task, testCommitMessage('feat: add nested change'));
    await fs.writeFile(path.join(fixture.repoPath, 'nested'), 'user content\n', 'utf-8');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });

    expect(result).toMatchObject({ success: false, reasonCode: 'TARGET_DIRTY', mutation: 'none' });
    expect(result.error).toMatch(/untracked path.*nested.*collides/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect(await fs.readFile(path.join(fixture.repoPath, 'nested'), 'utf-8')).toBe('user content\n');
  });

  for (const strategy of ['squash', 'merge', 'rebase'] as const) {
    it(`rejects an exact ignored-file collision during ${strategy} without mutation`, async () => {
      const fixture = await createFixture();
      await fs.appendFile(path.join(fixture.repoPath, '.gitignore'), 'build/\n', 'utf-8');
      await fixture.repoGit.add('.gitignore');
      await fixture.repoGit.commit(testCommitMessage('chore: ignore build output'));
      const targetCommit = (await fixture.repoGit.revparse(['HEAD'])).trim();
      const worktreeGit = simpleGit(fixture.worktreePath);
      await worktreeGit.merge([targetCommit, '--ff-only']);
      await fs.mkdir(path.join(fixture.worktreePath, 'build'));
      await fs.writeFile(path.join(fixture.worktreePath, 'build', 'output.txt'), 'task content\n', 'utf-8');
      await worktreeGit.add(['-f', 'build/output.txt']);
      await worktreeGit.commit(testCommitMessage('feat: add build output'));
      await fs.mkdir(path.join(fixture.repoPath, 'build'), { recursive: true });
      await fs.writeFile(path.join(fixture.repoPath, 'build', 'output.txt'), 'user content\n', 'utf-8');
      const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

      const result = await fixture.service.merge(
        fixture.feature,
        fixture.task,
        strategy,
        strategy === 'rebase' ? undefined : mergeMessage,
        { historyIntent: intentFor(strategy) },
      );

      expect(result).toMatchObject({ success: false, reasonCode: 'TARGET_DIRTY', mutation: 'none' });
      expect(result.error).toMatch(/ignored path.*build\/output\.txt.*collides/i);
      expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
      expect(await fs.readFile(path.join(fixture.repoPath, 'build', 'output.txt'), 'utf-8')).toBe('user content\n');
    });
  }

  for (const strategy of ['squash', 'merge', 'rebase'] as const) {
    it(`rejects an ignored nested repository directory collision during ${strategy}`, async () => {
      const fixture = await createFixture();
      await fs.appendFile(path.join(fixture.repoPath, '.gitignore'), 'nested/\n', 'utf-8');
      await fixture.repoGit.add('.gitignore');
      await fixture.repoGit.commit(testCommitMessage('chore: ignore nested repository'));
      const targetCommit = (await fixture.repoGit.revparse(['HEAD'])).trim();
      const worktreeGit = simpleGit(fixture.worktreePath);
      await worktreeGit.merge([targetCommit, '--ff-only']);
      await fs.mkdir(path.join(fixture.worktreePath, 'nested'));
      await fs.writeFile(path.join(fixture.worktreePath, 'nested', 'file.txt'), 'task content\n', 'utf-8');
      await worktreeGit.add(['-f', 'nested/file.txt']);
      await worktreeGit.commit(testCommitMessage('feat: add nested file'));
      const nestedPath = path.join(fixture.repoPath, 'nested');
      await fs.mkdir(nestedPath);
      await simpleGit(nestedPath).init();
      const ignoredPath = path.join(nestedPath, 'user.txt');
      await fs.writeFile(ignoredPath, 'user content\n', 'utf-8');
      const ignoredListing = await fixture.repoGit.raw([
        'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', 'nested', 'nested/file.txt',
      ]);
      expect(ignoredListing.split('\0')).toContain('nested/');
      const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

      const result = await fixture.service.merge(
        fixture.feature,
        fixture.task,
        strategy,
        strategy === 'rebase' ? undefined : mergeMessage,
        { historyIntent: intentFor(strategy) },
      );

      expect(result).toMatchObject({ success: false, reasonCode: 'TARGET_DIRTY', mutation: 'none' });
      expect(result.error).toMatch(/ignored path.*nested\/.*collides/i);
      expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
      expect(await fs.readFile(ignoredPath, 'utf-8')).toBe('user content\n');
    });
  }

  for (const strategy of ['squash', 'merge', 'rebase'] as const) {
    it(`rejects an untracked nested repository collision during ${strategy} without changing the foreign worktree`, async () => {
      const fixture = await createFixture();
      await fs.mkdir(path.join(fixture.worktreePath, 'urepo'));
      await fs.writeFile(path.join(fixture.worktreePath, 'urepo', 'file.txt'), 'task content\n', 'utf-8');
      await commitTaskChanges(fixture.service, fixture.feature, fixture.task, testCommitMessage('feat: add nested repository file'));
      const nestedPath = path.join(fixture.repoPath, 'urepo');
      await fs.mkdir(nestedPath);
      const nestedGit = simpleGit(nestedPath);
      await nestedGit.init();
      await nestedGit.raw(['config', 'user.email', 'foreign@example.com']);
      await nestedGit.raw(['config', 'user.name', 'Foreign User']);
      const foreignPath = path.join(nestedPath, 'file.txt');
      await fs.writeFile(foreignPath, 'foreign content\n', 'utf-8');
      await nestedGit.add('file.txt');
      await nestedGit.commit(testCommitMessage('chore: preserve foreign content'));
      const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
      const foreignHead = (await nestedGit.revparse(['HEAD'])).trim();
      const foreignStatus = await nestedGit.raw(['status', '--porcelain=v1', '-z']);

      const result = await fixture.service.merge(
        fixture.feature,
        fixture.task,
        strategy,
        strategy === 'rebase' ? undefined : mergeMessage,
        { historyIntent: intentFor(strategy) },
      );

      expect(result).toMatchObject({ success: false, reasonCode: 'TARGET_DIRTY', mutation: 'none' });
      expect(result.error).toMatch(/untracked path.*urepo\/.*collides/i);
      expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
      expect((await nestedGit.revparse(['HEAD'])).trim()).toBe(foreignHead);
      expect(await nestedGit.raw(['status', '--porcelain=v1', '-z'])).toBe(foreignStatus);
      expect(await fs.readFile(foreignPath, 'utf-8')).toBe('foreign content\n');
    });
  }

  it('revalidates target path collisions immediately before mutation', async () => {
    const fixture = await createCommittedFixture();
    const originalGetGit = (fixture.service as any).getGit.bind(fixture.service);
    const collisionPath = path.join(fixture.repoPath, 'task-change.txt');
    let pathScans = 0;
    const gitSpy = spyOn(fixture.service as any, 'getGit').mockImplementation((cwd?: string) => {
      const git = originalGetGit(cwd);
      if (cwd !== undefined) return git;
      return new Proxy(git, {
        get(target, key) {
          if (key !== 'raw') return Reflect.get(target, key);
          return async (args: string[]) => {
            if (args.includes('ls-files') && ++pathScans === 3) {
              await fs.writeFile(collisionPath, 'late user content\n', 'utf-8');
            }
            return target.raw(args);
          };
        },
      });
    });
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    let result;
    try {
      result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });
    } finally {
      gitSpy.mockRestore();
    }

    expect(result).toMatchObject({ success: false, reasonCode: 'TARGET_DIRTY', mutation: 'none' });
    expect(result.error).toMatch(/untracked path.*task-change\.txt.*collides/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect(await fs.readFile(collisionPath, 'utf-8')).toBe('late user content\n');
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

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'rebase', undefined, { historyIntent: 'rewrite-private' });

    expect(result).toMatchObject({ success: false, merged: false, conflictState: 'aborted' });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('restores earlier picks when the pre-pick recheck finds an ignored collision', async () => {
    const { fixture, beforeHead, collisionPath } = await createLateRebaseEligibilityFixture();
    const originalGetGit = (fixture.service as any).getGit.bind(fixture.service);
    let cherryPicks = 0;
    let endpointDiffScans = 0;
    let commitDiffScans = 0;
    const gitSpy = spyOn(fixture.service as any, 'getGit').mockImplementation((cwd?: string) => {
      const git = originalGetGit(cwd);
      if (cwd !== undefined) return git;
      return new Proxy(git, {
        get(target, key) {
          if (key !== 'raw') return Reflect.get(target, key);
          return async (args: string[]) => {
            if (args[0] === 'diff' && args.includes('--name-status')) endpointDiffScans++;
            if (args[0] === 'diff-tree' && args.includes('--name-status')) commitDiffScans++;
            const result = await target.raw(args);
            if (args[0] === 'cherry-pick' && ++cherryPicks === 1) {
              await fs.mkdir(path.dirname(collisionPath));
              await simpleGit(path.dirname(collisionPath)).init();
              await fs.writeFile(collisionPath, 'late user content\n', 'utf-8');
            }
            return result;
          };
        },
      });
    });

    let result;
    try {
      result = await fixture.service.merge(fixture.feature, fixture.task, 'rebase', undefined, { historyIntent: 'rewrite-private' });
    } finally {
      gitSpy.mockRestore();
    }

    expect(cherryPicks).toBe(1);
    expect(endpointDiffScans).toBe(1);
    expect(commitDiffScans).toBe(2);
    expect(result).toMatchObject({
      success: false,
      reasonCode: 'TARGET_RECONCILIATION_REQUIRED',
      mutation: 'none',
      retryable: false,
      action: 'reconcile_target',
      conflictState: 'none',
    });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect(await pathExists(path.join(fixture.repoPath, 'first.txt'))).toBe(false);
    expect(await fs.readFile(collisionPath, 'utf-8')).toBe('late user content\n');
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
    for (const state of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply']) {
      expect(await fixture.repoGit.raw(['rev-parse', '--git-path', state]).then(pathExists)).toBe(false);
    }
  });

  it('skips late eligibility rollback when the target moves after the last operation checkpoint', async () => {
    const { fixture, collisionPath } = await createLateRebaseEligibilityFixture();
    await fixture.repoGit.checkoutLocalBranch('external-target');
    await fs.writeFile(path.join(fixture.repoPath, 'external.txt'), 'external\n', 'utf-8');
    await fixture.repoGit.add('-A');
    await fixture.repoGit.commit(testCommitMessage('feat: external target move'));
    const externalHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    await fixture.repoGit.checkout('main');
    const originalGetGit = (fixture.service as any).getGit.bind(fixture.service);
    let cherryPicks = 0;
    let operationHead: string | undefined;
    let targetMoved = false;
    const gitSpy = spyOn(fixture.service as any, 'getGit').mockImplementation((cwd?: string) => {
      const git = originalGetGit(cwd);
      if (cwd !== undefined) return git;
      return new Proxy(git, {
        get(target, key) {
          if (key !== 'raw') return Reflect.get(target, key);
          return async (args: string[]) => {
            const moveTarget = args.includes('ls-files') && cherryPicks === 1 && !targetMoved;
            if (moveTarget) targetMoved = true;
            const result = await target.raw(args);
            if (args[0] === 'cherry-pick' && ++cherryPicks === 1) {
              operationHead = (await target.revparse(['HEAD'])).trim();
              await fs.mkdir(path.dirname(collisionPath));
              await simpleGit(path.dirname(collisionPath)).init();
              await fs.writeFile(collisionPath, 'late user content\n', 'utf-8');
            }
            if (moveTarget) await target.raw(['update-ref', 'refs/heads/main', externalHead]);
            return result;
          };
        },
      });
    });

    let result;
    try {
      result = await fixture.service.merge(fixture.feature, fixture.task, 'rebase', undefined, { historyIntent: 'rewrite-private' });
    } finally {
      gitSpy.mockRestore();
    }

    expect(targetMoved).toBe(true);
    expect(result).toMatchObject({
      success: false,
      reasonCode: 'POST_INTEGRATION_VERIFICATION_FAILED',
      mutation: 'unknown',
      expectedTarget: { commit: operationHead },
      observedTarget: { commit: externalHead },
    });
    expect(result.error).toMatch(/protected local data.*nested\/.*rollback was skipped.*checkpoint/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(externalHead);
    expect(await fs.readFile(collisionPath, 'utf-8')).toBe('late user content\n');
  });

  for (const resetBehavior of ['fails', 'does not restore HEAD'] as const) {
    it(`reports ROLLBACK_FAILED when the late eligibility reset ${resetBehavior}`, async () => {
      const { fixture, beforeHead, collisionPath } = await createLateRebaseEligibilityFixture();
      const originalGetGit = (fixture.service as any).getGit.bind(fixture.service);
      let cherryPicks = 0;
      let operationHead: string | undefined;
      const gitSpy = spyOn(fixture.service as any, 'getGit').mockImplementation((cwd?: string) => {
        const git = originalGetGit(cwd);
        if (cwd !== undefined) return git;
        return new Proxy(git, {
          get(target, key) {
            if (key !== 'raw') return Reflect.get(target, key);
            return async (args: string[]) => {
              if (args[0] === 'reset' && args[1] === '--merge') {
                if (resetBehavior === 'fails') throw new Error('simulated late eligibility reset failure');
                return '';
              }
              const result = await target.raw(args);
              if (args[0] === 'cherry-pick' && ++cherryPicks === 1) {
                operationHead = (await target.revparse(['HEAD'])).trim();
                await fs.mkdir(path.dirname(collisionPath));
                await simpleGit(path.dirname(collisionPath)).init();
                await fs.writeFile(collisionPath, 'late user content\n', 'utf-8');
              }
              return result;
            };
          },
        });
      });

      let result;
      try {
        result = await fixture.service.merge(fixture.feature, fixture.task, 'rebase', undefined, { historyIntent: 'rewrite-private' });
      } finally {
        gitSpy.mockRestore();
      }

      expect(result).toMatchObject({
        success: false,
        reasonCode: 'ROLLBACK_FAILED',
        mutation: 'unknown',
        action: 'manual_recovery',
      });
      expect(result.error).toMatch(/protected local data.*nested\/.*failed to restore target/i);
      expect(result.error).toMatch(resetBehavior === 'fails'
        ? /simulated late eligibility reset failure/
        : /reset did not restore the original target HEAD/i);
      expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(operationHead!);
      expect(operationHead).not.toBe(beforeHead);
      expect(await fs.readFile(path.join(fixture.repoPath, 'first.txt'), 'utf-8')).toBe('first\n');
      expect(await fs.readFile(collisionPath, 'utf-8')).toBe('late user content\n');
    });
  }

  it('returns helper-friendly merge details and preserves branch/worktree by default', async () => {
    const fixture = await createCommittedFixture();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

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
      historyIntent: 'preserve-source',
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
      historyIntent: 'preserve-source',
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
        historyIntent: 'preserve-source',
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
      result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });
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
        historyIntent: 'preserve-source',
        cleanup: 'worktree',
      });
    } finally {
      cleanupSpy.mockRestore();
    }

    // The integration commit is durable: no --hard reset to the starting HEAD.
    const afterHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    expect(afterHead).not.toBe(beforeHead);
    expect(result).toMatchObject({
      success: true,
      merged: true,
      sha: afterHead,
      filesChanged: ['task-change.txt'],
      reasonCode: 'CLEANUP_FAILED',
      phase: 'cleanup',
      mutation: 'applied',
      retryable: false,
      action: 'cleanup_only',
    });
    expect(result.cleanup.outcome).toBe('failed');
    expect(result.cleanup.failures).toContainEqual(expect.objectContaining({
      step: 'cleanup',
      cause: expect.stringMatching(/simulated cleanup failure/),
    }));
    expect(await readHeadBody(fixture.repoPath)).toBe(mergeMessage);
    expect(await pathExists(fixture.worktreePath)).toBe(true);
  });

  it('keeps a completed integration result when same-call cleanup cannot remove worktree metadata', async () => {
    const fixture = await createCommittedFixture();
    const metadataPath = `${fixture.worktreePath}.json`;
    const originalUnlink = fs.unlink;
    const unlinkSpy = spyOn(fs, 'unlink').mockImplementation(async (file: any) => {
      if (String(file) === metadataPath) {
        throw Object.assign(new Error('EACCES: simulated metadata unlink failure'), { code: 'EACCES' });
      }
      return originalUnlink(file);
    });
    let result: MergeResult;
    try {
      result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, {
        historyIntent: 'preserve-source',
        cleanup: 'worktree+branch',
      });
    } finally {
      unlinkSpy.mockRestore();
    }

    const afterHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    expect(result).toMatchObject({
      success: true,
      merged: true,
      sha: afterHead,
      reasonCode: 'CLEANUP_FAILED',
      phase: 'cleanup',
      mutation: 'applied',
      retryable: false,
      action: 'cleanup_only',
    });
    // The worktree and branch were removed before metadata removal threw; the
    // reported steps match the repository state.
    expect(await pathExists(fixture.worktreePath)).toBe(false);
    expect(await branchExists(fixture.repoGit, 'hive/test-feature/01-test-task')).toBe(false);
    expect(await pathExists(metadataPath)).toBe(true);
    expect(result.cleanup).toMatchObject({
      outcome: 'partial',
      worktreeRemoval: { status: 'succeeded' },
      prune: { status: 'succeeded' },
      branchDeletion: { status: 'succeeded' },
      worktreeRemoved: true,
      pruned: true,
      branchDeleted: true,
    });
    expect(result.cleanup.failures).toEqual([{
      step: 'metadata-removal',
      cause: expect.stringMatching(/simulated metadata unlink failure/),
    }]);
  });

  async function createDivergentEqualTreeFixture(): Promise<TestFixture & { sourceCommit: string }> {
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
    return { ...fixture, sourceCommit: (await worktreeGit.revparse(['HEAD'])).trim() };
  }

  it('joins divergent histories with identical endpoint trees under preserve-source', async () => {
    const fixture = await createDivergentEqualTreeFixture();
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    const beforeTree = (await fixture.repoGit.revparse(['HEAD^{tree}'])).trim();
    expect(gitIsAncestor(fixture.repoPath, fixture.sourceCommit, beforeHead)).toBe(false);

    const result = await fixture.service.merge(fixture.feature, fixture.task, undefined, mergeMessage, {
      historyIntent: 'preserve-source',
      cleanup: 'worktree+branch',
    });

    const afterHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    expect(result).toMatchObject({
      success: true,
      merged: true,
      strategy: 'merge',
      sha: afterHead,
      filesChanged: [],
      mutation: 'applied',
      action: 'none',
      cleanup: { outcome: 'complete', worktreeRemoved: true, branchDeleted: true },
    });
    expect((await fixture.repoGit.raw(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').slice(1))
      .toEqual([beforeHead, fixture.sourceCommit]);
    expect((await fixture.repoGit.revparse(['HEAD^{tree}'])).trim()).toBe(beforeTree);
    expect(gitIsAncestor(fixture.repoPath, fixture.sourceCommit, afterHead)).toBe(true);
  });

  it('keeps a divergent identical-tree source as a private content no-op under rewrite-private', async () => {
    const fixture = await createDivergentEqualTreeFixture();
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', undefined, { historyIntent: 'rewrite-private' });

    expect(result).toMatchObject({
      success: true,
      merged: false,
      strategy: 'squash',
      reason: 'nothing_to_merge',
      reasonCode: 'NO_TRACKED_CHANGES',
      filesChanged: [],
      mutation: 'none',
    });
    expect('sha' in result).toBe(false);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
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
        { historyIntent: intentFor(strategy) },
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

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

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
      untyped = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });
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
      typed = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });
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

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

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

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });

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

  // A private content no-op is not contained in the target; same-call cleanup
  // relies on the completed operation and the private attestation instead.
  for (const strategy of ['squash', 'rebase'] as const) {
    it(`returns a cleanup-eligible private no-op for a net-zero ${strategy} task merge`, async () => {
      const fixture = await createNetZeroCommittedFixture();
      const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
      const sourceCommit = (await fixture.repoGit.revparse(['hive/test-feature/01-test-task'])).trim();

      const result = await fixture.service.merge(fixture.feature, fixture.task, strategy, undefined, {
        historyIntent: 'rewrite-private',
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
        mutation: 'none',
        retryable: false,
        action: 'none',
        cleanup: {
          worktreeRemoved: true,
          branchDeleted: true,
          pruned: true,
        },
      });
      expect('sha' in result).toBe(false);
      expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
      expect(gitIsAncestor(fixture.repoPath, sourceCommit, beforeHead)).toBe(false);
      expect(await pathExists(fixture.worktreePath)).toBe(false);
      expect(await branchExists(fixture.repoGit, 'hive/test-feature/01-test-task')).toBe(false);
    });
  }

  it('records net-zero source history as graph progress under preserve-source before cleanup', async () => {
    const fixture = await createNetZeroCommittedFixture();
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    const sourceCommit = (await fixture.repoGit.revparse(['hive/test-feature/01-test-task'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, {
      historyIntent: 'preserve-source',
      cleanup: 'worktree+branch',
    });

    const afterHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    expect(result).toMatchObject({
      success: true,
      merged: true,
      sha: afterHead,
      filesChanged: [],
      mutation: 'applied',
      cleanup: { outcome: 'complete', worktreeRemoved: true, branchDeleted: true },
    });
    expect(afterHead).not.toBe(beforeHead);
    expect(gitIsAncestor(fixture.repoPath, sourceCommit, afterHead)).toBe(true);
    expect(await branchExists(fixture.repoGit, 'hive/test-feature/01-test-task')).toBe(false);
  });

  for (const historyIntent of ['preserve-source', 'rewrite-private'] as const) {
    it(`classifies a source equal to the target as ALREADY_INTEGRATED under ${historyIntent}`, async () => {
      const fixture = await createFixture();
      const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

      const result = await fixture.service.merge(fixture.feature, fixture.task, undefined, undefined, {
        historyIntent,
        cleanup: 'worktree+branch',
      });

      expect(result).toEqual({
        success: true,
        merged: false,
        strategy: historyIntent === 'preserve-source' ? 'merge' : 'squash',
        reason: 'already_integrated',
        reasonCode: 'ALREADY_INTEGRATED',
        cleanupEligible: true,
        taskUpdateRecommended: true,
        filesChanged: [],
        conflicts: [],
        conflictState: 'none',
        cleanup: expect.objectContaining({ requested: 'worktree+branch', outcome: 'complete' }),
        phase: 'integration',
        mutation: 'none',
        retryable: false,
        action: 'none',
      });
      expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
      expect(await pathExists(fixture.worktreePath)).toBe(false);
    });
  }

  it('classifies a contained source before local-data eligibility when target trees differ', async () => {
    const fixture = await createFixture();
    const sourceCommit = (await fixture.repoGit.revparse(['hive/test-feature/01-test-task'])).trim();
    await fs.writeFile(path.join(fixture.repoPath, 'target-only.txt'), 'target change\n', 'utf-8');
    await fixture.repoGit.add('-A');
    await fixture.repoGit.commit(testCommitMessage('feat: advance target past the source'));
    await fs.appendFile(path.join(fixture.repoPath, '.git', 'info', 'exclude'), 'build/\n', 'utf-8');
    const ignoredPath = path.join(fixture.repoPath, 'build', 'cache.bin');
    await fs.mkdir(path.dirname(ignoredPath));
    await fs.writeFile(ignoredPath, 'protected\n', 'utf-8');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    expect(gitIsAncestor(fixture.repoPath, sourceCommit, beforeHead)).toBe(true);

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', undefined, {
      historyIntent: 'preserve-source',
    });

    expect(result).toMatchObject({
      success: true,
      merged: false,
      reasonCode: 'ALREADY_INTEGRATED',
      mutation: 'none',
      taskUpdateRecommended: true,
    });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect(await fs.readFile(ignoredPath, 'utf-8')).toBe('protected\n');
  });

  it('cleans up a completed private squash without requiring source containment', async () => {
    const fixture = await createCommittedFixture();
    const sourceCommit = (await fixture.repoGit.revparse(['hive/test-feature/01-test-task'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, {
      historyIntent: 'rewrite-private',
      cleanup: 'worktree+branch',
    });

    const afterHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    expect(result).toMatchObject({
      success: true,
      merged: true,
      sha: afterHead,
      cleanup: { outcome: 'complete', worktreeRemoved: true, branchDeleted: true },
    });
    expect(gitIsAncestor(fixture.repoPath, sourceCommit, afterHead)).toBe(false);
  });

  it('preserves published source history after a source-side join with protected local data', async () => {
    const fixture = await createCommittedFixture();
    const worktreeGit = simpleGit(fixture.worktreePath);
    const published = (await worktreeGit.revparse(['HEAD'])).trim();
    const remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-published-remote-'));
    tempDirs.push(remotePath);
    await simpleGit().raw(['init', '--bare', remotePath]);
    await worktreeGit.raw(['push', remotePath, `${published}:refs/heads/published`]);

    await fs.writeFile(path.join(fixture.repoPath, 'target-only.txt'), 'target change\n', 'utf-8');
    await fixture.repoGit.add('-A');
    await fixture.repoGit.commit(testCommitMessage('feat: advance destination independently'));
    await fs.appendFile(path.join(fixture.repoPath, '.git', 'info', 'exclude'), 'build/\n', 'utf-8');
    const ignoredPath = path.join(fixture.repoPath, 'build', 'cache.bin');
    await fs.mkdir(path.dirname(ignoredPath));
    await fs.writeFile(ignoredPath, 'protected\n', 'utf-8');
    const pinnedTarget = (await fixture.repoGit.revparse(['HEAD'])).trim();
    await worktreeGit.merge([pinnedTarget, '--no-ff', '-m', testCommitMessage('merge: join destination history')]);
    const sourceCommit = (await worktreeGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(fixture.feature, fixture.task, undefined, mergeMessage, {
      historyIntent: 'preserve-source',
      sourceCommit,
      cleanup: 'worktree+branch',
    });

    const finalHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
    expect(result).toMatchObject({ success: true, merged: true, sha: finalHead, mutation: 'applied' });
    expect(gitIsAncestor(fixture.repoPath, published, finalHead)).toBe(true);
    expect(gitIsAncestor(fixture.repoPath, sourceCommit, finalHead)).toBe(true);
    expect(await fs.readFile(path.join(fixture.repoPath, 'task-change.txt'), 'utf-8')).toBe('task change\n');
    expect(await fs.readFile(path.join(fixture.repoPath, 'target-only.txt'), 'utf-8')).toBe('target change\n');
    expect(await fs.readFile(ignoredPath, 'utf-8')).toBe('protected\n');
    expect((await simpleGit(remotePath).revparse(['refs/heads/published'])).trim()).toBe(published);
  });

  for (const verification of ['negative', 'unreadable'] as const) {
    it(`retains the preservation commit and placements when post-merge ancestry verification is ${verification}`, async () => {
      const fixture = await createCommittedFixture();
      const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
      const sourceCommit = (await fixture.repoGit.revparse(['hive/test-feature/01-test-task'])).trim();
      const originalGetGit = (fixture.service as any).getGit.bind(fixture.service);
      const gitSpy = spyOn(fixture.service as any, 'getGit').mockImplementation((cwd?: string) => {
        const git = originalGetGit(cwd);
        if (cwd !== undefined) return git;
        return new Proxy(git, {
          get(target, key) {
            if (key !== 'raw') return Reflect.get(target, key);
            return async (args: string[]) => {
              // Only the check against the created commit: earlier checks start at the pinned target or source.
              const left = args[0] === 'rev-list' && args[1] === '--count' ? args[2]!.split('..')[0] : undefined;
              if (left && left !== beforeHead && left !== sourceCommit) {
                if (verification === 'unreadable') throw new Error('simulated ancestry read failure');
                return '1\n';
              }
              return target.raw(args);
            };
          },
        });
      });
      let result: MergeResult;
      try {
        result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, {
          historyIntent: 'preserve-source',
          cleanup: 'worktree+branch',
        });
      } finally {
        gitSpy.mockRestore();
      }

      const afterHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
      expect(afterHead).not.toBe(beforeHead);
      expect((await fixture.repoGit.raw(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').slice(1))
        .toEqual([beforeHead, sourceCommit]);
      expect(result).toMatchObject({
        success: false,
        reasonCode: 'POST_INTEGRATION_VERIFICATION_FAILED',
        phase: 'verification',
        mutation: 'applied',
        retryable: false,
        action: 'inspect_state',
        observedTarget: { commit: afterHead },
        cleanup: { requested: 'none', outcome: 'not_requested' },
      });
      expect(result.error).toMatch(verification === 'unreadable' ? /simulated ancestry read failure/ : /does not contain source/);
      expect(await pathExists(fixture.worktreePath)).toBe(true);
      expect(await branchExists(fixture.repoGit, 'hive/test-feature/01-test-task')).toBe(true);
    });
  }

  it('rejects a precomputed classification under a different history policy', async () => {
    const fixture = await createCommittedFixture();
    const targetCommit = (await fixture.repoGit.revparse(['HEAD'])).trim();
    const sourceCommit = (await fixture.repoGit.revparse(['hive/test-feature/01-test-task'])).trim();
    const preserved = await inspectTargetMergeEligibility({
      targetGit: fixture.repoGit,
      targetRoot: fixture.repoPath,
      targetCommit,
      sourceCommit,
      policy: { historyIntent: 'preserve-source', strategy: 'merge' },
    });
    expect(preserved).toMatchObject({ workKind: 'preservation', candidateFiles: ['task-change.txt'] });

    await expect(inspectTargetMergeEligibility({
      targetGit: fixture.repoGit,
      targetRoot: fixture.repoPath,
      targetCommit,
      sourceCommit,
      policy: { historyIntent: 'rewrite-private', strategy: 'squash' },
      precomputedCandidates: preserved as Exclude<typeof preserved, { error: string }>,
    })).rejects.toThrow(/history policy/);
  });

  for (const { stateName, label } of [
    { stateName: 'MERGE_HEAD', label: 'merge' },
    { stateName: 'rebase-merge', label: 'rebase' },
    { stateName: 'CHERRY_PICK_HEAD', label: 'cherry-pick' },
  ] as const) {
    it(`fails safely when a net-zero task merge sees active ${label} state`, async () => {
      const fixture = await createNetZeroCommittedFixture();
      await fs.writeFile(path.join(fixture.repoPath, '.git', stateName), 'deadbeef\n', 'utf-8');

      const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', undefined, {
        historyIntent: 'preserve-source',
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

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

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
      historyIntent: 'preserve-source',
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

    const result = await fixture.service.merge(fixture.feature, fixture.task, "rebase", "feat: custom\n\nbody", { historyIntent: 'rewrite-private' });

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

// These tests use the core service directly: no subclass supplies a strategy,
// intent or target expectation.
describe('WorktreeService history intent contract', () => {
  for (const { name, strategy, options } of [
    { name: 'a missing intent', strategy: undefined, options: {} },
    { name: 'missing options from an untyped caller', strategy: 'squash', options: undefined },
    { name: 'an unknown intent', strategy: undefined, options: { historyIntent: 'keep-everything' } },
    { name: 'an unknown strategy', strategy: 'octopus', options: { historyIntent: 'preserve-source' } },
    { name: 'preserve-source with squash', strategy: 'squash', options: { historyIntent: 'preserve-source' } },
    { name: 'preserve-source with rebase', strategy: 'rebase', options: { historyIntent: 'preserve-source' } },
    { name: 'rewrite-private with merge', strategy: 'merge', options: { historyIntent: 'rewrite-private' } },
  ] as const) {
    it(`rejects ${name} before any Git access or mutation`, async () => {
      const fixture = await createCommittedFixture();
      const core = new CoreWorktreeService({ baseDir: fixture.repoPath, hiveDir: path.join(fixture.repoPath, '.hive') });
      const expectedTarget = await readWorktreeTargetIdentity(fixture.repoPath);
      const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();
      const gitSpy = spyOn(core as any, 'getGit');

      const untypedMerge = core.merge.bind(core) as (...args: unknown[]) => Promise<MergeResult>;
      const result = await untypedMerge(
        fixture.feature,
        fixture.task,
        strategy,
        mergeMessage,
        options === undefined ? undefined : { ...options, expectedTarget, cleanup: 'worktree+branch' },
      );

      expect(gitSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        merged: false,
        reasonCode: 'INVALID_ARGUMENTS',
        phase: 'validation',
        mutation: 'none',
        retryable: false,
        action: 'correct_arguments',
        partial: false,
      });
      expect('strategy' in result).toBe(false);
      expect(result.error).toMatch(/historyIntent|strategy/);
      expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
      expect(await pathExists(fixture.worktreePath)).toBe(true);
      expect(await branchExists(fixture.repoGit, 'hive/test-feature/01-test-task')).toBe(true);
    });
  }

  it('resolves an omitted strategy from preserve-source as a normal merge', async () => {
    const fixture = await createCommittedFixture();
    const core = new CoreWorktreeService({ baseDir: fixture.repoPath, hiveDir: path.join(fixture.repoPath, '.hive') });
    const sourceCommit = (await fixture.repoGit.revparse(['hive/test-feature/01-test-task'])).trim();

    const result = await core.merge(fixture.feature, fixture.task, undefined, mergeMessage, {
      historyIntent: 'preserve-source',
      expectedTarget: await readWorktreeTargetIdentity(fixture.repoPath),
    });

    expect(result).toMatchObject({ success: true, merged: true, strategy: 'merge' });
    expect(gitIsAncestor(fixture.repoPath, sourceCommit, result.sha!)).toBe(true);
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
    if (kind === 'legacy') {
      const taskPath = path.join(fx.projectRoot, '.hive-legacy', 'features', fx.feature, 'tasks', fx.task);
      await fs.mkdir(taskPath, { recursive: true });
      await fs.writeFile(path.join(taskPath, 'status.json'), JSON.stringify({ status: 'pending', origin: 'plan' }));
    }
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
      const result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });
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
    const taskPath = path.join(repoPath, '.hive', 'features', 'legacy-feature', 'tasks', '01-legacy');
    await fs.mkdir(taskPath, { recursive: true });
    await fs.writeFile(path.join(taskPath, 'status.json'), JSON.stringify({ status: 'pending', origin: 'plan' }));
    const wt = await service.create('legacy-feature', '01-legacy');
    expect(wt.mode ?? 'legacy').toBe('legacy');
    expect(wt.path).toBe(path.join(repoPath, '.hive', '.worktrees', 'legacy-feature', '01-legacy'));
    expect(wt.branch).toBe('hive/legacy-feature/01-legacy');
    expect(wt.repos).toBeUndefined();
    expect(wt.workspacePath).toBeUndefined();
  });

  it.each([false, true])('reads declared-root legacy placement with a symlinked root: %s', async (symlinked) => {
    const fx = await createFixture();
    let baseDir = fx.repoPath;
    if (symlinked) {
      const aliases = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-root-alias-'));
      tempDirs.push(aliases);
      baseDir = path.join(aliases, 'checkout');
      await fs.symlink(fx.repoPath, baseDir);
    }
    const repositories = new RepositoryService(baseDir).resolveManifest([{ id: 'root', path: '.' }]);
    const service = new WorktreeService({
      baseDir,
      hiveDir: path.join(fx.repoPath, '.hive'),
      repositoryResolver: () => repositories,
    });
    const inspected = await service.inspect(fx.feature, fx.task);
    expect(inspected).toMatchObject({ path: fx.worktreePath, mode: 'legacy', clean: true });
    expect(inspected!.target!.path).toBe(fx.repoPath);
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

  it('removes nothing when markers cannot be published before cleanup of an already integrated composite', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const created = await fx.service.create(fx.feature, fx.task);
    const expectedTargets = {
      api: await readWorktreeTargetIdentity(fx.repos.api.path),
      'web-ui': await readWorktreeTargetIdentity(fx.repos['web-ui'].path),
    };
    const originalRename = fsSync.renameSync;
    const renameSpy = spyOn(fsSync, 'renameSync').mockImplementation(((source, destination) => {
      if (String(destination).includes(`${path.sep}operations${path.sep}`)) throw new Error('marker publication failed');
      return originalRename(source, destination);
    }) as typeof fsSync.renameSync);
    let refused: MergeResult;
    try {
      // Every repository is contained, so cleanup is the first effect the operation guard must cover.
      refused = await fx.service.merge(fx.feature, fx.task, undefined, undefined, { historyIntent: 'preserve-source', cleanup: 'worktree+branch', expectedTargets });
    } finally {
      renameSpy.mockRestore();
    }
    expect(refused).toMatchObject({ success: false, mutation: 'none', error: expect.stringContaining('marker publication failed') });
    for (const repoId of ['api', 'web-ui']) {
      expect(await pathExists(created.repos![repoId].path)).toBe(true);
      expect(await branchExists(fx.repos[repoId].git, created.repos![repoId].branch)).toBe(true);
    }
    expect(await pathExists(path.join(fx.projectRoot, '.hive', '.locks', 'operations'))
      ? await fs.readdir(path.join(fx.projectRoot, '.hive', '.locks', 'operations'))
      : []).toEqual([]);
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
    expect(listed.errors).toEqual([]);
    expect(listed.worktrees).toHaveLength(1);
    expect(listed.worktrees[0].mode).toBe('composite');
    expect(listed.worktrees[0].path).toBe(created.path);
    expect(listed.worktrees[0].workspacePath).toBe(created.workspacePath);
    expect(Object.keys(listed.worktrees[0].repos!).sort()).toEqual(['api', 'web-ui']);
    expect(listed.worktrees[0].repos!['api'].branch).toBe(`hive/api/${fx.feature}/${fx.task}`);
  });

  it('list reports a composite linkage failure alongside healthy worktrees', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const created = await fx.service.create(fx.feature, fx.task);
    const healthy = await fx.service.create(fx.feature, '02-healthy-task');
    const selectedPath = created.repos!.api.path;
    const siblingPath = path.join(fx.projectRoot, 'api-list-sibling');
    await fx.repos.api.git.raw(['worktree', 'add', '-b', 'list-sibling', siblingPath, 'HEAD']);
    const siblingPointer = await fs.readFile(path.join(siblingPath, '.git'), 'utf8');
    await fs.writeFile(path.join(selectedPath, '.git'), siblingPointer, 'utf8');

    const listed = await fx.service.list(fx.feature);
    expect(listed.worktrees.map(worktree => worktree.path)).toEqual([healthy.path]);
    expect(listed.errors).toEqual([{
      path: created.path,
      reason: expect.stringContaining('backlink does not select this exact worktree'),
    }]);
  });

  it('rejects an existing manifestless composite directory before Git and preserves its contents', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const created = await fx.service.create(fx.feature, fx.task);
    const inspected = await fx.service.inspect(fx.feature, fx.task);
    await fs.unlink(path.join(created.path, 'workspace.json'));
    const pointer = await fs.readFile(path.join(created.repos!.api.path, '.git'));
    const gitSpy = spyOn(fx.service as any, 'getGit');
    try {
      await expect(fx.service.get(fx.feature, fx.task)).rejects.toThrow(`Composite workspace manifest not found at ${path.join(created.path, 'workspace.json')}`);
      await expect(fx.service.inspect(fx.feature, fx.task)).rejects.toThrow('Composite workspace manifest not found');
      await expect(fx.service.remove(fx.feature, fx.task, true, { discard: true })).rejects.toThrow('Composite workspace manifest not found');
      const merged = await fx.service.merge(fx.feature, fx.task, 'squash', mergeMessage, {
        historyIntent: 'rewrite-private',
        sourceCommits: { api: created.repos!.api.commit },
        expectedTargets: { api: inspected!.repos!.api.target! },
      });
      expect(merged).toMatchObject({ success: false, reasonCode: 'WORKTREE_LINKAGE_INVALID', mutation: 'none' });
      expect(merged.error).toContain('Composite workspace manifest not found');
      expect(gitSpy).not.toHaveBeenCalled();
    } finally {
      gitSpy.mockRestore();
    }
    const listed = await fx.service.list(fx.feature);
    expect(listed).toEqual({ worktrees: [], errors: [{
      path: created.path,
      reason: expect.stringContaining('Composite workspace manifest not found'),
    }] });
    expect(await fs.readFile(path.join(created.repos!.api.path, '.git'))).toEqual(pointer);
    expect(await branchExists(fx.repos.api.git, created.repos!.api.branch)).toBe(true);
  });

  it('list reports a namespace symlink without blocking other features', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    await fx.service.create(fx.feature, fx.task);
    const healthy = await fx.service.create('healthy-feature', fx.task);
    const featurePath = path.join(fx.projectRoot, '.hive', '.worktrees', fx.feature);
    const relocated = path.join(fx.projectRoot, 'relocated-feature');
    await fs.rename(featurePath, relocated);
    await fs.symlink(relocated, featurePath);

    const listed = await fx.service.list();
    expect(listed.worktrees.map(worktree => worktree.path)).toEqual([healthy.path]);
    expect(listed.errors).toEqual([{
      path: featurePath,
      reason: expect.stringContaining('path contains a symlink'),
    }]);

    await fs.unlink(featurePath);
    await fs.rename(relocated, featurePath);
  });

  it("list returns an empty result when the worktrees directory is missing", async () => {
    const { repoPath } = await createTempRepo();
    const service = new WorktreeService({
      baseDir: repoPath,
      hiveDir: path.join(repoPath, '.hive'),
    });

    await expect(service.list()).resolves.toEqual({ worktrees: [], errors: [] });
  });

  it("list skips a step whose worktree directory is missing", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const created = await fx.service.create(fx.feature, fx.task);
    await fs.rm(created.path, { recursive: true, force: true });

    await expect(fx.service.list(fx.feature)).resolves.toEqual({ worktrees: [], errors: [] });
  });

  it.each([false, true])('bulk cleanup rejects manifestless placement before root Git with a feature selector: %s', async (selected) => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const created = await fx.service.create(fx.feature, fx.task);
    await fs.unlink(path.join(created.path, 'workspace.json'));
    const pointer = await fs.readFile(path.join(created.repos!.api.path, '.git'));
    const gitSpy = spyOn(fx.service as any, 'getGit');
    try {
      await expect(fx.service.cleanup(selected ? fx.feature : undefined)).rejects.toThrow('Composite workspace manifest not found');
      expect(gitSpy.mock.calls.every(([cwd]) => cwd === fx.repos.api.path)).toBe(true);
    } finally {
      gitSpy.mockRestore();
    }
    expect(await fs.readFile(path.join(created.repos!.api.path, '.git'))).toEqual(pointer);
    expect(await branchExists(fx.repos.api.git, created.repos!.api.branch)).toBe(true);
  });

  it('bulk cleanup prunes declared repositories instead of the non-Git project root', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    const getGit = (fx.service as any).getGit.bind(fx.service);
    const pruned: string[] = [];
    const gitSpy = spyOn(fx.service as any, 'getGit').mockImplementation((cwd?: string) => {
      expect(cwd).toBeDefined();
      expect(cwd).not.toBe(fx.projectRoot);
      const git = getGit(cwd);
      return new Proxy(git, {
        get(target, key) {
          if (key === 'raw') return (args: string[]) => {
            if (args[0] === 'worktree' && args[1] === 'prune') pruned.push(cwd!);
            return target.raw(args);
          };
          return Reflect.get(target, key);
        },
      });
    });
    try {
      const cleaned = await fx.service.cleanup(fx.feature);
      expect(cleaned).toEqual({ removed: [], pruned: true });
      expect(pruned.sort()).toEqual(Object.values(fx.repos).map(repo => repo.path).sort());
    } finally {
      gitSpy.mockRestore();
    }
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

  it('removes each stale workspace under its own workspace lock, so a record guarding only that workspace keeps it', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const stale = await fx.service.create(fx.feature, fx.task);
    await fs.rm(stale.repos!['web-ui'].path, { recursive: true, force: true });
    // A lock file a pre-native host left for this workspace alone names no repository.
    const legacyLock = path.join(fx.projectRoot, '.hive', '.operation-locks', `workspace-${createHash('sha256').update(stale.path).digest('hex')}.lock`);
    fsSync.mkdirSync(path.dirname(legacyLock), { recursive: true });
    fsSync.writeFileSync(legacyLock, JSON.stringify({ pid: 3858212 }));

    await expect(fx.service.cleanup(fx.feature)).rejects.toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    expect(await pathExists(stale.repos!.api.path)).toBe(true);
    expect(await pathExists(path.join(stale.path, 'workspace.json'))).toBe(true);

    fsSync.unlinkSync(legacyLock);
    expect(await fx.service.cleanup(fx.feature)).toEqual({ removed: [stale.path], pruned: true });
    expect(await pathExists(stale.path)).toBe(false);
  }, 30_000);

  it('reports the workspaces a bulk cleanup already removed when a later removal throws', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const stale = [await fx.service.create(fx.feature, fx.task), await fx.service.create(fx.feature, '02-other-task')];
    for (const workspace of stale) await fs.rm(workspace.repos!.api.path, { recursive: true, force: true });
    const removeIfStale = (fx.service as any).removeIfStale.bind(fx.service);
    let calls = 0;
    const spy = spyOn(fx.service as any, 'removeIfStale').mockImplementation((...args: unknown[]) => {
      calls += 1;
      return calls === 1 ? removeIfStale(...args) : Promise.reject(new Error('simulated second removal failure'));
    });
    let failure: unknown;
    try {
      failure = await fx.service.cleanup(fx.feature).catch((error) => error);
    } finally {
      spy.mockRestore();
    }

    expect(calls).toBe(2);
    const removedBeforeFailure = (failure as BulkCleanupFailure).removedBeforeFailure;
    expect(removedBeforeFailure).toHaveLength(1);
    expect(await pathExists(removedBeforeFailure[0]!)).toBe(false);
    expect(await pathExists(stale.map((workspace) => workspace.path).find((workspacePath) => workspacePath !== removedBeforeFailure[0])!)).toBe(true);
    expect((failure as Error).message).toContain(`simulated second removal failure; this cleanup had already removed ${removedBeforeFailure[0]}`);
  }, 30_000);

  it('recovers an interrupted bulk cleanup whose markers name the workspace and its sources, and refuses sources outside a linked placement', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const repositories = Object.entries(fx.repos).map(([id, repo]) => ({ id, path: repo.path, root: repo.path }));
    const hiveDir = path.join(fx.projectRoot, '.hive');
    const recovery = new WorktreeOperationRecoveryService({ baseDir: fx.projectRoot, hiveDir, repositoryResolver: () => repositories });
    const stale = await fx.service.create(fx.feature, fx.task);
    const kept = await fx.service.create(fx.feature, '02-kept-task');
    await fs.rm(stale.repos!['web-ui'].path, { recursive: true, force: true });

    const originalUnlink = fsSync.unlinkSync;
    const unlinkSpy = spyOn(fsSync, 'unlinkSync').mockImplementation(((target: fsSync.PathLike) => {
      if (String(target).includes(`${path.sep}operations${path.sep}`) && String(target).endsWith('.json')) {
        throw Object.assign(new Error('marker unlink failed'), { code: 'EIO' });
      }
      return originalUnlink(target);
    }) as typeof fsSync.unlinkSync);
    let cleaned: Awaited<ReturnType<CoreWorktreeService['cleanup']>>;
    try {
      cleaned = await fx.service.cleanup(fx.feature);
    } finally {
      unlinkSpy.mockRestore();
    }
    // The removal whose markers stayed ends the cleanup before the prune, so nothing else runs behind the retained record.
    expect(cleaned).toMatchObject({ removed: [stale.path], pruned: false, finalization: { markers: 'retained', action: 'manual_recovery' } });
    const operationId = cleaned.finalization!.operationId!;

    // Each stale workspace is removed as its own operation, recording that workspace and its checkouts.
    const [entry] = await recovery.list();
    expect(entry).toMatchObject({
      operationId,
      marker: { kind: 'cleanup', subject: { type: 'task', feature: fx.feature, task: fx.task }, workspacePath: stale.path },
      recovery: { available: true },
    });
    expect(entry!.marker!.repositories.map((repository) => repository.sourceWorktreePath)).toEqual([stale.repos!.api.path, stale.repos!['web-ui'].path]);
    expect(entry!.observed.repositories.map((repository) => repository.source?.present)).toEqual([false, false]);
    // The record guards the repositories, so other workspaces of them report it and refuse mutation.
    expect((await fx.service.inspect(fx.feature, '02-kept-task'))?.pendingOperations?.map((pending) => pending.operationId)).toEqual([operationId]);
    await expect(fx.service.remove(fx.feature, '02-kept-task')).rejects.toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    const request = (pending: { operationId: string; markerDigest: string; observedStateDigest: string }) => ({
      operationId: pending.operationId,
      markerDigest: pending.markerDigest,
      observedStateDigest: pending.observedStateDigest,
      mutatorsStopped: true,
    });
    await recovery.recover(request(entry!));
    expect(await recovery.list()).toEqual([]);

    // The same project-wide shape is trusted only for a linked checkout of a project worktree placement.
    const apiCommonDirectory = await trustedGitCommonDirectory(fx.repos.api.path);
    const markerFile = path.join(hiveDir, '.locks', 'operations', `${repositoryResourceName(apiCommonDirectory)}.json`);
    const plant = (sourceWorktreePath: string) => fsSync.writeFileSync(markerFile, JSON.stringify({
      protocol: 'hive-worktree-operation/v1',
      operationId: 'planted-cleanup',
      kind: 'cleanup',
      subject: { type: 'project' },
      workspacePath: null,
      repositories: [{ repositoryPath: fx.repos.api.path, commonDirectory: apiCommonDirectory, repoId: 'api', sourceWorktreePath }],
      startedAt: '2026-10-30T00:00:00.000Z',
      pid: 1,
    }));
    const keptApi = kept.repos!.api.path;
    plant(keptApi);
    const [linked] = await recovery.list();
    expect(linked).toMatchObject({ recovery: { available: true } });
    expect(linked!.observed.repositories[0]!.source).toMatchObject({ worktreePath: keptApi, present: true, branch: kept.repos!.api.branch });

    const foreign = await makeRepo(fx.projectRoot, 'foreign');
    const foreignCheckout = path.join(fx.projectRoot, 'foreign-checkout');
    await foreign.git.raw(['worktree', 'add', '-b', 'foreign-branch', '--', foreignCheckout]);
    const keptPointer = path.join(keptApi, '.git');
    const pointer = await fs.readFile(keptPointer, 'utf-8');
    for (const [label, source, redirect] of [
      ['outside the worktree placements', fx.repos.api.path, false],
      ['a placement checkout whose .git names another repository', keptApi, true],
    ] as const) {
      plant(source);
      if (redirect) await fs.copyFile(path.join(foreignCheckout, '.git'), keptPointer);
      try {
        const [listed] = await recovery.list();
        expect({ label, listed }).toMatchObject({ label, listed: { observed: { workspace: null, repositories: [] }, recovery: { available: false } } });
        expect((await recovery.recover(request(listed!)).catch((error) => error)).reason).toBe('resource_untrusted');
      } finally {
        await fs.writeFile(keptPointer, pointer);
      }
    }
    await fs.unlink(markerFile);
    expect((await fx.service.remove(fx.feature, '02-kept-task')).cleanup.outcome).toBe('complete');
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
    const taskPath = path.join(repoPath, '.hive', 'features', feature, 'tasks', task);
    await fs.mkdir(taskPath, { recursive: true });
    await fs.writeFile(path.join(taskPath, 'status.json'), JSON.stringify({ status: 'pending', origin: 'plan' }));
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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.partial).toBeUndefined();
    expect(Object.keys(result.repos!)).toEqual(['api', 'web-ui']);
    expect(result.repos!['api'].success).toBe(true);
    expect(result.repos!['web-ui'].success).toBe(true);
    expect(result.filesChanged.sort()).toEqual(['api:a.txt', 'web-ui:w.txt']);
    expect(result.conflicts).toEqual([]);
  });

  it('distinguishes an unreadable composite target from a confirmed target mismatch', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    const inspected = await fx.service.inspect(fx.feature, fx.task);
    const headPath = path.join(fx.repos.api.path, '.git', 'HEAD');
    const originalHead = await fs.readFile(headPath, 'utf8');
    const originalGet = (fx.service as any).get.bind(fx.service);
    const getSpy = spyOn(fx.service as any, 'get').mockImplementation(async (...args: unknown[]) => {
      const registered = await originalGet(...args);
      await fs.writeFile(headPath, 'invalid-target-head\n');
      return registered;
    });

    let result;
    try {
      result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, {
        historyIntent: 'preserve-source',
        sourceCommits: { api: inspected!.repos!.api.commit },
        expectedTargets: { api: inspected!.repos!.api.target! },
      });
    } finally {
      getSpy.mockRestore();
      await fs.writeFile(headPath, originalHead);
    }

    expect(result).toMatchObject({
      success: false,
      reasonCode: 'GIT_OPERATION_FAILED',
      mutation: 'none',
      partial: false,
    });
    expect(result.error).toMatch(/api: unable to read target identity: Reading target commit failed/i);
    expect(result.error).not.toMatch(/no longer matches/);
  });

  it("uses a custom merge message verbatim in every composite repo", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    const message = 'feat(core): multi merge\n\nbody line';
    const result = await fx.service.merge(fx.feature, fx.task, 'merge', message, { historyIntent: 'preserve-source' });

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
    const result = await fx.service.merge(fx.feature, fx.task, 'squash', message, { historyIntent: 'rewrite-private' });

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

    const result = await fx.service.merge(fx.feature, fx.task, 'rebase', 'feat: nope', { historyIntent: 'rewrite-private' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Custom merge message is not supported for rebase/);
    expect(result.partial).toBeUndefined();
    expect(result.repos).toBeUndefined();
    // No repo mutated
    expect((await fx.repos['api'].git.revparse(['HEAD'])).trim()).toBe(before.api);
    expect((await fx.repos['web-ui'].git.revparse(['HEAD'])).trim()).toBe(before.web);
  });

  it('rejects a later repository source message in preflight against detached pinned targets', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    const webWorktreeGit = simpleGit(wt.repos!['web-ui'].path);
    await fs.writeFile(path.join(wt.repos!['web-ui'].path, 'w.txt'), 'w\n', 'utf-8');
    await webWorktreeGit.add('-A');
    await webWorktreeGit.commit('one-line web source');
    const before: Record<string, string> = {};
    for (const id of ['api', 'web-ui']) {
      await fx.repos[id].git.raw(['checkout', '--detach']);
      before[id] = (await fx.repos[id].git.revparse(['HEAD'])).trim();
    }

    const result = await fx.service.merge(fx.feature, fx.task, 'rebase', undefined, { historyIntent: 'rewrite-private' });

    expect(result).toMatchObject({
      success: false,
      partial: false,
      reasonCode: 'INVALID_COMMIT_MESSAGE',
      mutation: 'none',
    });
    expect(result.error).toMatch(/^web-ui: Source commit/);
    for (const id of ['api', 'web-ui']) {
      expect((await fx.repos[id].git.revparse(['HEAD'])).trim()).toBe(before[id]);
    }
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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

    expect(result.success).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.error).toMatch(/dirty|uncommitted/i);
    expect(result.error).toMatch(/api/);
    // No mutation in web-ui
    expect((await fx.repos['web-ui'].git.revparse(['HEAD'])).trim()).toBe(beforeWeb);
  });

  it('allows disjoint untracked files across composite feature targets', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');
    const apiNote = path.join(fx.repos.api.path, 'api-note.txt');
    const webNote = path.join(fx.repos['web-ui'].path, 'web-note.txt');
    await fs.writeFile(apiNote, 'api user content\n', 'utf-8');
    await fs.writeFile(webNote, 'web user content\n', 'utf-8');

    const result = await fx.service.merge(fx.feature, fx.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });

    expect(result).toMatchObject({ success: true, merged: true });
    expect(await fs.readFile(apiNote, 'utf-8')).toBe('api user content\n');
    expect(await fs.readFile(webNote, 'utf-8')).toBe('web user content\n');
  });

  it('propagates reconciliation-required classification from composite preflight', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'api-new.txt', 'api source\n');
    await commitChangeInRepo(fx, 'web-ui', 'web-new.txt', 'web source\n');
    await fs.writeFile(path.join(fx.repos['web-ui'].path, 'web-target.txt'), 'target change\n', 'utf-8');
    await fx.repos['web-ui'].git.add('-A');
    await fx.repos['web-ui'].git.commit(testCommitMessage('feat: advance web target'));
    const localPath = path.join(fx.repos['web-ui'].path, 'web-local.txt');
    await fs.writeFile(localPath, 'local content\n', 'utf-8');
    const beforeApi = (await fx.repos.api.git.revparse(['HEAD'])).trim();
    const beforeWeb = (await fx.repos['web-ui'].git.revparse(['HEAD'])).trim();

    const result = await fx.service.merge(fx.feature, fx.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });

    expect(result).toMatchObject({
      success: false,
      merged: false,
      partial: false,
      reasonCode: 'TARGET_RECONCILIATION_REQUIRED',
      phase: 'preflight',
      mutation: 'none',
      retryable: false,
      action: 'reconcile_target',
    });
    expect(result.error).toMatch(/web-ui.*reconcile the pinned target/i);
    expect((await fx.repos.api.git.revparse(['HEAD'])).trim()).toBe(beforeApi);
    expect((await fx.repos['web-ui'].git.revparse(['HEAD'])).trim()).toBe(beforeWeb);
    expect(await fs.readFile(localPath, 'utf-8')).toBe('local content\n');
  });

  it("fails preflight when a source repo has an active merge state and does not mutate any repo", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    // Simulate an active merge in api
    await fs.writeFile(path.join(fx.repos['api'].path, '.git', 'MERGE_HEAD'), 'deadbeef\n', 'utf-8');

    const beforeWeb = (await fx.repos['web-ui'].git.revparse(['HEAD'])).trim();

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

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
      historyIntent: 'preserve-source',
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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

    expect(result.success).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.repos!['api'].success).toBe(true);
    expect(result.repos!['web-ui'].success).toBe(false);
    expect(result.error).toMatch(/web-ui/);
    // api merge not rolled back
    const apiHeadAfter = (await fx.repos['api'].git.revparse(['HEAD'])).trim();
    expect(apiHeadAfter).not.toBe(apiHeadBefore);
  }, 20000);

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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

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

    const result = await fx.service.merge(fx.feature, fx.task, 'rebase', undefined, { historyIntent: 'rewrite-private' });

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
  }, 20000);

  it('classifies a composite preflight failure with its specific reason code and no partial progress', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');
    await fs.writeFile(path.join(fx.repos['api'].path, 'README.md'), 'dirty\n', 'utf-8');
    const beforeWeb = (await fx.repos['web-ui'].git.revparse(['HEAD'])).trim();

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

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
      historyIntent: 'preserve-source',
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
  }, 20000);

  it('keeps completed composite integration results when deferred cleanup throws', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');
    const originalRemove = (fx.service as any).removeWorktreeStep.bind(fx.service);
    const removeSpy = spyOn(fx.service as any, 'removeWorktreeStep').mockImplementation(async (...args: any[]) => {
      if (String(args[1]).endsWith(path.join('repos', 'web-ui'))) {
        throw Object.assign(new Error('EACCES: simulated lstat failure'), { code: 'EACCES' });
      }
      return originalRemove(...args);
    });
    let result: MergeResult;
    try {
      result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, {
        historyIntent: 'preserve-source',
        cleanup: 'worktree+branch',
      });
    } finally {
      removeSpy.mockRestore();
    }

    const apiHead = (await fx.repos.api.git.revparse(['HEAD'])).trim();
    const webHead = (await fx.repos['web-ui'].git.revparse(['HEAD'])).trim();
    expect(result).toMatchObject({
      success: true,
      merged: true,
      sha: apiHead,
      reasonCode: 'CLEANUP_FAILED',
      phase: 'cleanup',
      mutation: 'applied',
      retryable: false,
      action: 'cleanup_only',
    });
    expect(result.repos!.api).toMatchObject({ success: true, merged: true, sha: apiHead });
    expect(result.repos!['web-ui']).toMatchObject({ success: true, merged: true, sha: webHead });
    expect(result.repos!['web-ui'].cleanup.failures).toContainEqual(expect.objectContaining({
      cause: expect.stringMatching(/simulated lstat failure/),
    }));
    expect(result.filesChanged.sort()).toEqual(['api:a.txt', 'web-ui:w.txt']);
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
        historyIntent: 'preserve-source',
        cleanup: 'worktree+branch',
      });
    } finally {
      mergeSpy.mockRestore();
    }

    expect(result.cleanup.outcome).toBe('failed');
    expect(result.cleanup).toMatchObject({
      worktreeRemoval: { status: 'not_attempted' },
      branchDeletion: { status: 'not_attempted' },
      prune: { status: 'not_attempted' },
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
    });
    expect(result.cleanup.failures).toEqual([{
      step: 'identity-recheck',
      repoId: 'api',
      cause: expect.stringMatching(/moved after integration; cleanup was skipped/),
    }]);
    expect(result.repos!.api.cleanup.worktreeRemoval.status).toBe('not_attempted');
    expect(result.repos!['web-ui'].cleanup.worktreeRemoval.status).toBe('not_attempted');
    expect(await pathExists(created.repos!.api.path)).toBe(true);
    expect(await pathExists(created.repos!['web-ui'].path)).toBe(true);
    expect(await branchExists(fx.repos.api.git, created.repos!.api.branch)).toBe(true);
    expect(await branchExists(fx.repos['web-ui'].git, created.repos!['web-ui'].branch)).toBe(true);
  });

  it('skips all task-composite cleanup when a target switches branches at the same commit after integration', async () => {
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
        const integratedApiHead = (await fx.repos.api.git.revparse(['HEAD'])).trim();
        await fx.repos.api.git.raw(['branch', 'same-target-commit', integratedApiHead]);
        await fx.repos.api.git.checkout('same-target-commit');
      }
      return result;
    });
    let result;
    try {
      result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, {
        historyIntent: 'preserve-source',
        cleanup: 'worktree+branch',
      });
    } finally {
      mergeSpy.mockRestore();
    }

    expect(result.cleanup.outcome).toBe('failed');
    expect(result.cleanup).toMatchObject({
      worktreeRemoval: { status: 'not_attempted' },
      branchDeletion: { status: 'not_attempted' },
      prune: { status: 'not_attempted' },
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
    });
    expect(result.cleanup.failures).toEqual([{
      step: 'identity-recheck',
      repoId: 'api',
      cause: expect.stringMatching(/moved after integration; cleanup was skipped/),
    }]);
    expect(result.repos!.api.cleanup.worktreeRemoval.status).toBe('not_attempted');
    expect(result.repos!['web-ui'].cleanup.worktreeRemoval.status).toBe('not_attempted');
    expect(await pathExists(created.repos!.api.path)).toBe(true);
    expect(await pathExists(created.repos!['web-ui'].path)).toBe(true);
    expect(await branchExists(fx.repos.api.git, created.repos!.api.branch)).toBe(true);
    expect(await branchExists(fx.repos['web-ui'].git, created.repos!['web-ui'].branch)).toBe(true);
  });

  it("populates per-repo cleanup fields when cleanup=worktree+branch and aggregates them at top level", async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitChangeInRepo(fx, 'api', 'a.txt', 'a\n');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, {
      historyIntent: 'preserve-source',
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
      historyIntent: 'preserve-source',
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

  it('returns an all-repo private composite no-op when every repo has zero tracked diff', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    await commitNetZeroChangeInRepo(fx, 'api');
    await commitNetZeroChangeInRepo(fx, 'web-ui');
    const before = {
      api: (await fx.repos['api'].git.revparse(['HEAD'])).trim(),
      web: (await fx.repos['web-ui'].git.revparse(['HEAD'])).trim(),
    };

    const result = await fx.service.merge(fx.feature, fx.task, 'squash', undefined, {
      historyIntent: 'rewrite-private',
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

  it('returns ALREADY_INTEGRATED only when every composite repository is contained', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    await fs.writeFile(path.join(fx.repos['web-ui'].path, 'web-target.txt'), 'target change\n', 'utf-8');
    await fx.repos['web-ui'].git.add('-A');
    await fx.repos['web-ui'].git.commit(testCommitMessage('feat: advance web target past the source'));
    await fs.appendFile(path.join(fx.repos['web-ui'].path, '.git', 'info', 'exclude'), 'cache/\n', 'utf-8');
    const ignoredPath = path.join(fx.repos['web-ui'].path, 'cache', 'local.bin');
    await fs.mkdir(path.dirname(ignoredPath));
    await fs.writeFile(ignoredPath, 'protected\n', 'utf-8');

    const result = await fx.service.merge(fx.feature, fx.task, undefined, undefined, {
      historyIntent: 'preserve-source',
      cleanup: 'worktree+branch',
    });

    expect(result).toMatchObject({
      success: true,
      merged: false,
      strategy: 'merge',
      reason: 'already_integrated',
      reasonCode: 'ALREADY_INTEGRATED',
      mutation: 'none',
      taskUpdateRecommended: true,
      cleanup: { outcome: 'complete' },
    });
    expect(result.repos!.api).toMatchObject({ success: true, merged: false, reasonCode: 'ALREADY_INTEGRATED' });
    expect(result.repos!['web-ui']).toMatchObject({ success: true, merged: false, reasonCode: 'ALREADY_INTEGRATED' });
    expect(await fs.readFile(ignoredPath, 'utf-8')).toBe('protected\n');
    expect(await pathExists(wt.path)).toBe(false);
  });

  it('aggregates contained and private content no-op repositories as NO_TRACKED_CHANGES', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitNetZeroChangeInRepo(fx, 'web-ui');

    const result = await fx.service.merge(fx.feature, fx.task, 'squash', undefined, { historyIntent: 'rewrite-private' });

    expect(result).toMatchObject({ success: true, merged: false, reasonCode: 'NO_TRACKED_CHANGES', mutation: 'none' });
    expect(result.repos!.api.reasonCode).toBe('ALREADY_INTEGRATED');
    expect(result.repos!['web-ui'].reasonCode).toBe('NO_TRACKED_CHANGES');
  });

  it('aggregates mixed private composite no-op and changed repos as a successful actual merge', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitNetZeroChangeInRepo(fx, 'api');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');

    const result = await fx.service.merge(fx.feature, fx.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.reasonCode).toBeUndefined();
    expect(typeof result.sha).toBe('string');
    expect(result.filesChanged).toEqual(['web-ui:w.txt']);
    expect(result.repos!['api']).toMatchObject({ success: true, merged: false, reasonCode: 'NO_TRACKED_CHANGES' });
    expect(result.repos!['web-ui'].merged).toBe(true);
  });

  it('counts a graph-only preservation merge as actual composite progress', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    await fx.service.create(fx.feature, fx.task);
    await commitNetZeroChangeInRepo(fx, 'api');
    await commitChangeInRepo(fx, 'web-ui', 'w.txt', 'w\n');
    const apiSource = (await fx.repos.api.git.revparse([`hive/api/${fx.feature}/${fx.task}`])).trim();

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

    const apiHead = (await fx.repos.api.git.revparse(['HEAD'])).trim();
    expect(result).toMatchObject({ success: true, merged: true, sha: apiHead, filesChanged: ['web-ui:w.txt'] });
    expect(result.repos!.api).toMatchObject({ success: true, merged: true, sha: apiHead, filesChanged: [] });
    expect(gitIsAncestor(fx.repos.api.path, apiSource, apiHead)).toBe(true);
  });

  it('does not mark a composite failure partial after only private no-op repos have succeeded', async () => {
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

    const result = await fx.service.merge(fx.feature, fx.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });

    expect(result.success).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.repos!['api']).toMatchObject({ success: true, merged: false, reasonCode: 'NO_TRACKED_CHANGES' });
    expect(result.repos!['web-ui'].success).toBe(false);
    expect(result.conflicts).toContain('web-ui:README.md');
  });

  it('reports a later failure after a graph-only preservation merge as partial and defers cleanup', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const wt = await fx.service.create(fx.feature, fx.task);
    await commitNetZeroChangeInRepo(fx, 'api');
    await fs.writeFile(path.join(wt.repos!['web-ui'].path, 'README.md'), 'task-side\n', 'utf-8');
    const wg = simpleGit(wt.repos!['web-ui'].path);
    await wg.add('-A');
    await wg.commit(testCommitMessage('chore: web-ui task side'));
    await fs.writeFile(path.join(fx.repos['web-ui'].path, 'README.md'), 'main-side\n', 'utf-8');
    await fx.repos['web-ui'].git.add('-A');
    await fx.repos['web-ui'].git.commit(testCommitMessage('chore: web-ui main side'));

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, {
      historyIntent: 'preserve-source',
      cleanup: 'worktree+branch',
    });

    expect(result).toMatchObject({
      success: false,
      partial: true,
      reasonCode: 'COMPOSITE_PARTIAL',
      mutation: 'partial',
      cleanup: { requested: 'none', outcome: 'not_requested' },
    });
    expect(result.repos!.api).toMatchObject({ success: true, merged: true, filesChanged: [] });
    expect(result.repos!['web-ui']).toMatchObject({ success: false, conflictState: 'aborted' });
    expect(await pathExists(wt.repos!.api.path)).toBe(true);
    expect(await pathExists(wt.repos!['web-ui'].path)).toBe(true);
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

    const result = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

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

    const result = await service.merge(feature, task, 'merge', undefined, { historyIntent: 'preserve-source' });

    expect(result.success).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.error).toMatch(/active (merge|rebase|cherry-pick)/i);
    expect(result.error).toMatch(/api/);
    // web-ui must not have been mutated.
    expect((await webRepo.git.revparse(['HEAD'])).trim()).toBe(webHeadBefore);
  });

  it("preserves legacy single-repo merge shape when no manifest is configured", async () => {
    const fixture = await createCommittedFixture();

    const result = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source' });

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.repos).toBeUndefined();
    expect(result.partial).toBeUndefined();
  });
});

describe("WorktreeService repository operation locks", () => {
  it("reports a merge that fails after its first mutation as a non-retryable unknown outcome and refuses later mutations", async () => {
    const fx = await createFixture();
    await fs.writeFile(path.join(fx.worktreePath, "guarded.txt"), "guarded\n");
    await commitTaskChanges(fx.service, fx.feature, fx.task, testCommitMessage("feat: add guarded file"));
    const spy = spyOn(fx.service as any, "mergeOneRepo").mockImplementationOnce(async (options: any) => {
      await options.beforeMutation();
      throw new Error("host lost the integration");
    });
    let interrupted: MergeResult;
    try {
      interrupted = await fx.service.merge(fx.feature, fx.task, "squash", mergeMessage, { historyIntent: 'rewrite-private' });
    } finally {
      spy.mockRestore();
    }
    expect(interrupted).toMatchObject({
      success: false,
      reasonCode: "OPERATION_RECOVERY_REQUIRED",
      mutation: "unknown",
      retryable: false,
      action: "manual_recovery",
      error: expect.stringContaining("host lost the integration"),
    });
    expect(interrupted.partial).toBeUndefined();
    // The result names the operation whose retained markers now guard the workspace.
    expect(interrupted.finalization).toMatchObject({ markers: "retained", action: "manual_recovery" });
    expect(interrupted.finalization!.retainedMarkers).toHaveLength(2);

    const refused = await fx.service.merge(fx.feature, fx.task, "squash", mergeMessage, { historyIntent: 'rewrite-private' });
    expect(refused).toMatchObject({ success: false, reasonCode: "OPERATION_RECOVERY_REQUIRED", mutation: "none", retryable: false, partial: false });
    expect(refused.finalization).toBeUndefined();
    const inspected = await fx.service.inspect(fx.feature, fx.task);
    expect(inspected?.pendingOperations).toEqual([expect.objectContaining({
      operationId: interrupted.finalization!.operationId,
      state: "interrupted",
      marker: expect.objectContaining({ kind: "merge", subject: { type: "task", feature: fx.feature, task: fx.task } }),
    })]);
    await expect(fx.service.remove(fx.feature, fx.task)).rejects.toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
  });

  it("returns a completed merge and its same-call cleanup when its pending markers cannot be cleared", async () => {
    const fx = await createFixture();
    await fs.writeFile(path.join(fx.worktreePath, "finalized.txt"), "finalized\n");
    await commitTaskChanges(fx.service, fx.feature, fx.task, testCommitMessage("feat: add finalized file"));
    const originalUnlink = fsSync.unlinkSync;
    const unlinkSpy = spyOn(fsSync, "unlinkSync").mockImplementation(((target: fsSync.PathLike) => {
      if (String(target).includes(`${path.sep}operations${path.sep}`) && String(target).endsWith(".json")) {
        throw Object.assign(new Error("marker unlink failed"), { code: "EIO" });
      }
      return originalUnlink(target);
    }) as typeof fsSync.unlinkSync);
    let result: MergeResult;
    try {
      result = await fx.service.merge(fx.feature, fx.task, "merge", mergeMessage, { historyIntent: "preserve-source", cleanup: "worktree+branch" });
    } finally {
      unlinkSpy.mockRestore();
    }
    // The integration and its cleanup are reported as they happened, not as a generic retryable failure.
    expect(result).toMatchObject({
      success: true,
      merged: true,
      sha: (await fx.repoGit.revparse(["HEAD"])).trim(),
      mutation: "applied",
      retryable: false,
      cleanup: { outcome: "complete", worktreeRemoved: true, branchDeleted: true },
      finalization: { markers: "retained", action: "manual_recovery" },
    });
    expect(result.reasonCode).toBeUndefined();
    expect(result.finalization!.markerError).toContain("marker unlink failed");
    expect(await pathExists(fx.worktreePath)).toBe(false);
    const refused = await fx.service.merge(fx.feature, fx.task, "merge", mergeMessage, { historyIntent: "preserve-source" });
    expect(refused).toMatchObject({ reasonCode: "OPERATION_RECOVERY_REQUIRED", mutation: "none", retryable: false });
  });

  async function createSplitRepositoryFixture() {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-split-repositories-'));
    tempDirs.push(projectRoot);
    const api = await makeRepo(projectRoot, 'api');
    const web = await makeRepo(projectRoot, 'web');
    const repositories: ResolvedRepository[] = [
      { id: 'api', path: api.path, root: api.path },
      { id: 'web', path: web.path, root: web.path },
    ];
    const taskRepoIds: Record<string, string[]> = {
      '01-api-task': ['api'],
      '02-web-task': ['web'],
      '03-api-holder': ['api'],
    };
    const config: WorktreeConfig = {
      baseDir: projectRoot,
      hiveDir: path.join(projectRoot, '.hive'),
      repositoryResolver: { resolveRepositories: () => repositories },
      taskRepoResolver: { resolveTaskRepoIds: (_feature, task) => taskRepoIds[task] },
    };
    return { projectRoot, api, web, config, feature: 'split-feature', service: new WorktreeService(config) };
  }

  async function commitFile(worktreePath: string, file: string): Promise<void> {
    await fs.writeFile(path.join(worktreePath, file), `${file}\n`, 'utf-8');
    const git = simpleGit(worktreePath);
    await git.add('-A');
    await git.commit(testCommitMessage(`feat: add ${file}`));
  }

  it("runs an api-only task's operations while another task holds the web repository lock", async () => {
    const fx = await createSplitRepositoryFixture();
    const webTask = await fx.service.create(fx.feature, '02-web-task');
    await commitFile(webTask.repos!.web.path, 'web.txt');
    const webStall = await stallNextCommit(fx.web.path);
    const webMerge = fx.service.merge(fx.feature, '02-web-task', 'squash', mergeMessage, { historyIntent: 'rewrite-private' });

    try {
      await webStall.held;
      const created = await fx.service.create(fx.feature, '01-api-task');
      expect(Object.keys(created.repos!)).toEqual(['api']);
      const inspected = await fx.service.inspect(fx.feature, '01-api-task');
      expect(inspected!.clean).toBe(true);

      await commitFile(created.repos!.api.path, 'api.txt');
      const merged = await fx.service.merge(fx.feature, '01-api-task', 'squash', mergeMessage, { historyIntent: 'rewrite-private', cleanup: 'worktree+branch' });
      expect(merged).toMatchObject({ success: true, merged: true });
      expect(Object.keys(merged.repos!)).toEqual(['api']);
      expect(merged.cleanup.outcome).toBe('complete');

      await fx.service.create(fx.feature, '03-api-holder');
      const removed = await fx.service.remove(fx.feature, '03-api-holder', true);
      expect(removed.cleanup.outcome).toBe('complete');
      expect(await branchExists(fx.api.git, `hive/api/${fx.feature}/03-api-holder`)).toBe(false);
    } finally {
      await webStall.release();
    }

    expect(await webMerge).toMatchObject({ success: true, merged: true });
    expect(await branchExists(fx.web.git, `hive/web/${fx.feature}/02-web-task`)).toBe(true);
    expect(await pathExists(path.join(fx.api.path, 'api.txt'))).toBe(true);
  }, 30_000);

  it("refuses a merge whose persisted repository selection changed while it waited for locks, as inspectable state", async () => {
    const fx = await createSplitRepositoryFixture();
    const task = await fx.service.create(fx.feature, '01-api-task');
    const holder = await fx.service.create(fx.feature, '03-api-holder');
    await commitFile(holder.repos!.api.path, 'api.txt');
    const apiStall = await stallNextCommit(fx.api.path);
    const holderMerge = fx.service.merge(fx.feature, '03-api-holder', 'squash', mergeMessage, { historyIntent: 'rewrite-private' });

    // A second service instance stands in for another process waiting on the api lock.
    const waiting = new CoreWorktreeService(fx.config);
    const readManifest = (waiting as any).readWorkspaceManifest.bind(waiting);
    let selectionRead!: () => void;
    const firstSelectionRead = new Promise<void>((resolve) => { selectionRead = resolve; });
    const manifestSpy = spyOn(waiting as any, 'readWorkspaceManifest').mockImplementation(async (...args: unknown[]) => {
      const manifest = await readManifest(...args);
      selectionRead();
      return manifest;
    });
    const gitPaths: string[] = [];
    const getGit = (waiting as any).getGit.bind(waiting);
    const gitSpy = spyOn(waiting as any, 'getGit').mockImplementation((cwd?: string) => {
      gitPaths.push(cwd ?? fx.projectRoot);
      return getGit(cwd);
    });

    let merge: Promise<MergeResult> | undefined;
    try {
      await apiStall.held;
      merge = waiting.merge(fx.feature, '01-api-task', 'squash', mergeMessage, { historyIntent: 'rewrite-private' });
      await firstSelectionRead;

      const manifestPath = path.join(task.path, 'workspace.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      manifest.repos.web = {
        path: 'repos/web',
        repoRoot: fx.web.path,
        repoPath: fx.web.path,
        branch: `hive/web/${fx.feature}/01-api-task`,
        commit: manifest.repos.api.commit,
      };
      manifest.baseCommits.web = manifest.repos.api.commit;
      await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');
    } finally {
      await apiStall.release();
    }

    try {
      const result = await merge!;
      // The workspace may be consistent again on the next read, so the caller inspects and retries.
      expect(result).toMatchObject({
        success: false,
        merged: false,
        reasonCode: 'WORKTREE_LOOKUP_FAILED',
        phase: 'preflight',
        mutation: 'none',
        retryable: true,
        action: 'inspect_state',
      });
      expect(result.error).toMatch(/repository selection changed while waiting for operation locks/);
      expect(gitPaths.some((gitPath) => gitPath.startsWith(fx.web.path))).toBe(false);
    } finally {
      manifestSpy.mockRestore();
      gitSpy.mockRestore();
    }
    expect(await holderMerge).toMatchObject({ success: true, merged: true });
  }, 30_000);

  it("refuses an operation whose selected repository path moved to another Git common directory while it waited", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-moved-common-directory-'));
    tempDirs.push(projectRoot);
    const origin = await makeRepo(projectRoot, 'origin');
    const replacement = await makeRepo(projectRoot, 'replacement');
    // The api repository is a linked checkout, so its lock is its origin's common directory.
    const linkedApiPath = path.join(projectRoot, 'api');
    await origin.git.raw(['worktree', 'add', '-b', 'api-checkout', '--', linkedApiPath]);
    const repositories: ResolvedRepository[] = [
      { id: 'api', path: linkedApiPath, root: linkedApiPath },
      { id: 'origin', path: origin.path, root: origin.path },
    ];
    const taskRepoIds: Record<string, string[]> = { '01-api-task': ['api'], '03-origin-holder': ['origin'] };
    const config: WorktreeConfig = {
      baseDir: projectRoot,
      hiveDir: path.join(projectRoot, '.hive'),
      repositoryResolver: { resolveRepositories: () => repositories },
      taskRepoResolver: { resolveTaskRepoIds: (_feature, task) => taskRepoIds[task] },
    };
    const feature = 'moved-feature';
    const service = new WorktreeService(config);
    const holder = await service.create(feature, '03-origin-holder');
    await commitFile(holder.repos!.origin.path, 'origin.txt');
    const originStall = await stallNextCommit(origin.path);
    const holderMerge = service.merge(feature, '03-origin-holder', 'squash', mergeMessage, { historyIntent: 'rewrite-private' });

    const waiting = new CoreWorktreeService(config);
    const commonDirectory = (waiting as any).trustedGitCommonDirectory.bind(waiting);
    let lockScopeRead!: () => void;
    const firstLockScopeRead = new Promise<void>((resolve) => { lockScopeRead = resolve; });
    const commonDirectorySpy = spyOn(waiting as any, 'trustedGitCommonDirectory').mockImplementation(async (repositoryPath: unknown) => {
      const resolved = await commonDirectory(repositoryPath);
      lockScopeRead();
      return resolved;
    });

    let creation: Promise<unknown> | undefined;
    try {
      await originStall.held;
      creation = waiting.create(feature, '01-api-task');
      creation.catch(() => {});
      await firstLockScopeRead;

      // Replace the checkout at the same path with one of an unrelated repository.
      await origin.git.raw(['worktree', 'remove', '--', linkedApiPath]);
      await replacement.git.raw(['worktree', 'add', '-b', 'api-checkout', '--', linkedApiPath]);
    } finally {
      await originStall.release();
    }

    try {
      await expect(creation!).rejects.toThrow(/repository selection changed while waiting for operation locks/);
    } finally {
      commonDirectorySpy.mockRestore();
    }
    expect(await branchExists(replacement.git, `hive/api/${feature}/01-api-task`)).toBe(false);
    expect(await branchExists(origin.git, `hive/api/${feature}/01-api-task`)).toBe(false);
    expect(await pathExists(service.getWorktreePath(feature, '01-api-task'))).toBe(false);
    expect(await holderMerge).toMatchObject({ success: true, merged: true });
  }, 30_000);

  it("serializes concurrent creates of one task workspace whose declared repositories differ", async () => {
    const fx = await createSplitRepositoryFixture();
    // Another process read the task after its declared repositories changed to web.
    const other = new CoreWorktreeService({ ...fx.config, taskRepoResolver: { resolveTaskRepoIds: () => ['web'] } });

    const results = await Promise.allSettled([
      fx.service.create(fx.feature, '01-api-task'),
      other.create(fx.feature, '01-api-task'),
    ]);

    const workspacePath = fx.service.getWorktreePath(fx.feature, '01-api-task');
    const manifest = JSON.parse(await fs.readFile(path.join(workspacePath, 'workspace.json'), 'utf-8'));
    const owned = Object.keys(manifest.repos);
    expect(owned).toHaveLength(1);
    // The second create adopts the workspace the first one persisted; nothing is orphaned.
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
      expect(Object.keys((result as PromiseFulfilledResult<{ repos?: Record<string, unknown> }>).value.repos!)).toEqual(owned);
    }
    expect(await fs.readdir(path.join(workspacePath, 'repos'))).toEqual(owned);
    expect(await branchExists(fx.api.git, `hive/api/${fx.feature}/01-api-task`)).toBe(owned.includes('api'));
    expect(await branchExists(fx.web.git, `hive/web/${fx.feature}/01-api-task`)).toBe(owned.includes('web'));
  }, 30_000);
});

function operationMarkers(repoPath: string): string[] {
  const directory = path.join(repoPath, '.hive', '.locks', 'operations');
  return fsSync.existsSync(directory) ? fsSync.readdirSync(directory) : [];
}

/**
 * Make the atomic rename of one metadata file fail, as a full disk would. With `confirming`, only the first write
 * that confirms a create fails: the one without `createUnconfirmed`, after the create's own worktree add.
 */
function failMetadataWrite(metadataPath: string, options: { confirming?: boolean } = {}): { mockRestore(): void } {
  const originalRename = fsSync.renameSync;
  let failed = false;
  return spyOn(fsSync, 'renameSync').mockImplementation(((from: fsSync.PathLike, to: fsSync.PathLike) => {
    const selected = !options.confirming || (!failed && !fsSync.readFileSync(from, 'utf-8').includes('"createUnconfirmed"'));
    if (String(to) === metadataPath && selected) {
      failed = true;
      throw Object.assign(new Error('simulated metadata write failure'), { code: 'EIO' });
    }
    return originalRename(from, to);
  }) as typeof fsSync.renameSync);
}

/**
 * Make the first write that confirms a create at `metadataPath` fail after its rename published the confirmed bytes,
 * as a directory flush failure would. With `restoreFails`, the write that puts `createUnconfirmed` back fails too.
 */
function failMetadataFlushAfterRename(metadataPath: string, options: { restoreFails?: boolean } = {}): { mockRestore(): void } {
  const originalRename = fsSync.renameSync;
  const originalFsync = fsSync.fsyncSync;
  let armed = false;
  let flushFailed = false;
  const renameSpy = spyOn(fsSync, 'renameSync').mockImplementation(((from: fsSync.PathLike, to: fsSync.PathLike) => {
    if (String(to) === metadataPath) {
      const confirming = !fsSync.readFileSync(from, 'utf-8').includes('"createUnconfirmed"');
      if (confirming && !flushFailed) armed = true;
      else if (!confirming && flushFailed && options.restoreFails) throw Object.assign(new Error('simulated restore failure'), { code: 'EIO' });
    }
    return originalRename(from, to);
  }) as typeof fsSync.renameSync);
  const fsyncSpy = spyOn(fsSync, 'fsyncSync').mockImplementation(((descriptor: number) => {
    if (armed) {
      armed = false;
      flushFailed = true;
      throw Object.assign(new Error('simulated directory flush failure'), { code: 'EIO' });
    }
    return originalFsync(descriptor);
  }) as typeof fsSync.fsyncSync);
  return { mockRestore: () => { fsyncSpy.mockRestore(); renameSpy.mockRestore(); } };
}

/** Acknowledge every pending worktree operation, as an operator does once its processes are known to have stopped. */
async function acknowledgePendingOperations(recovery: WorktreeOperationRecoveryService): Promise<void> {
  const pending = await recovery.list();
  expect(pending.length).toBeGreaterThan(0);
  for (const entry of pending) {
    await recovery.recover({ operationId: entry.operationId, markerDigest: entry.markerDigest, observedStateDigest: entry.observedStateDigest, mutatorsStopped: true });
  }
}

/** Hide `file` from Git in `repositoryPath` and every worktree of it, so a checkout holding it has only ignored content. */
async function ignoreInRepository(repositoryPath: string, file: string): Promise<void> {
  await fs.appendFile(path.join(repositoryPath, '.git', 'info', 'exclude'), `${file}\n`);
}

describe("WorktreeService lifecycle integrity", () => {
  const feature = 'test-feature';
  const task = '01-test-task';
  const branch = `hive/${feature}/${task}`;

  /** Route one service's Git calls through `intercept`, which may handle a raw call or return undefined to run it. */
  function interceptGit(
    service: CoreWorktreeService,
    intercept: (cwd: string | undefined, args: string[], git: SimpleGit) => Promise<unknown> | undefined,
  ): { mockRestore(): void } {
    const getGit = (service as any).getGit.bind(service);
    return spyOn(service as any, 'getGit').mockImplementation((cwd?: string) => {
      const git = getGit(cwd);
      return new Proxy(git, {
        get(target, key) {
          if (key !== 'raw') return Reflect.get(target, key);
          return (args: string[]) => intercept(cwd, args, target) ?? target.raw(args);
        },
      });
    });
  }

  it('reattaches a retained task branch with its baseline and never deletes it when the create fails', async () => {
    const { repoPath, repoGit } = await createTempRepo();
    const service = new WorktreeService({ baseDir: repoPath, hiveDir: path.join(repoPath, '.hive') });
    const created = await service.create(feature, task);
    const metadataPath = `${created.path}.json`;
    const worktreeGit = simpleGit(created.path);
    await fs.writeFile(path.join(created.path, 'task-work.txt'), 'unique task work\n');
    await worktreeGit.add('-A');
    await worktreeGit.commit(testCommitMessage('feat: unique task work'));
    const tip = (await worktreeGit.revparse(['HEAD'])).trim();
    expect((await service.remove(feature, task)).cleanup.outcome).toBe('complete');
    // The branch stays, so its baseline record stays with it.
    expect(JSON.parse(await fs.readFile(metadataPath, 'utf8')).baseCommit).toBe(created.commit);
    const retainedRecord = await fs.readFile(metadataPath, 'utf8');
    await fs.writeFile(path.join(repoPath, 'target.txt'), 'destination moved\n');
    await repoGit.add('target.txt');
    await repoGit.commit(testCommitMessage('feat: advance the destination'));

    for (const fault of ['unconfirmed', 'confirming', 'add'] as const) {
      const spy = fault === 'add'
        ? interceptGit(service, (_cwd, args) => args[0] === 'worktree' && args[1] === 'add' ? Promise.reject(new Error('simulated add failure')) : undefined)
        : failMetadataWrite(metadataPath, { confirming: fault === 'confirming' });
      try {
        await expect(service.create(feature, task)).rejects.toThrow(fault === 'add' ? /simulated add failure/ : /simulated metadata write failure/);
      } finally {
        spy.mockRestore();
      }
      // The retained branch and its unique commit survive, the verified rollback leaves nothing to recover, and the
      // record the create found, with the branch's baseline, is back as it was.
      expect((await repoGit.raw(['rev-parse', `refs/heads/${branch}`])).trim()).toBe(tip);
      expect(await pathExists(created.path)).toBe(false);
      expect(operationMarkers(repoPath)).toEqual([]);
      expect(await fs.readFile(metadataPath, 'utf8')).toBe(retainedRecord);
    }

    const reattached = await service.create(feature, task);
    expect(reattached.commit).toBe(tip);
    expect((await service.get(feature, task))?.baseCommit).toBe(created.commit);
    expect((await service.getDiff(feature, task)).filesChanged).toEqual(['task-work.txt']);

    // Without a surviving record, the baseline is the fork point with the destination, never the retained tip.
    expect((await service.remove(feature, task)).cleanup.outcome).toBe('complete');
    await fs.unlink(metadataPath);
    await service.create(feature, task);
    expect((await service.get(feature, task))?.baseCommit).toBe(created.commit);

    // A record that describes another workspace refuses the reattachment before any effect.
    expect((await service.remove(feature, task)).cleanup.outcome).toBe('complete');
    const record = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    await fs.writeFile(metadataPath, JSON.stringify({ ...record, task: '02-other-task' }));
    await expect(service.create(feature, task)).rejects.toThrow(/Cannot reattach retained task branch .* describes a different workspace/);
    expect(operationMarkers(repoPath)).toEqual([]);
    expect((await repoGit.raw(['rev-parse', `refs/heads/${branch}`])).trim()).toBe(tip);
  }, 30_000);

  it('removes only the branch a failed fresh create made, without falling back to another checkout', async () => {
    const { repoPath, repoGit } = await createTempRepo();
    const service = new WorktreeService({ baseDir: repoPath, hiveDir: path.join(repoPath, '.hive') });
    const adds: string[][] = [];
    // The create makes the branch itself, then only attaches it; a failed attach leaves the branch this create made.
    const spy = interceptGit(service, (_cwd, args) => {
      if (args[0] !== 'worktree' || args[1] !== 'add') return undefined;
      adds.push(args);
      return Promise.reject(new Error('simulated checkout failure'));
    });
    try {
      await expect(service.create(feature, task)).rejects.toThrow(/simulated checkout failure/);
    } finally {
      spy.mockRestore();
    }
    expect(adds).toHaveLength(1);
    expect(adds[0]).not.toContain('-b');
    expect(await branchExists(repoGit, branch)).toBe(false);
    expect(operationMarkers(repoPath)).toEqual([]);

    const metadataPath = path.join(repoPath, '.hive', '.worktrees', feature, `${task}.json`);
    const failure = failMetadataWrite(metadataPath, { confirming: true });
    try {
      await expect(service.create(feature, task)).rejects.toThrow(/simulated metadata write failure/);
    } finally {
      failure.mockRestore();
    }
    expect(await branchExists(repoGit, branch)).toBe(false);
    expect(await pathExists(metadataPath)).toBe(false);
    expect(operationMarkers(repoPath)).toEqual([]);
    expect((await service.create(feature, task)).branch).toBe(branch);
    expect(JSON.parse(await fs.readFile(metadataPath, 'utf8')).createUnconfirmed).toBeUndefined();
  });

  /**
   * Create `branchName` at `commit` as another Git client would, outside Hive's locks, just before the first call that
   * creates that branch: the exclusive ref creation, or a `worktree add`.
   */
  function raceBranchCreation(service: CoreWorktreeService, repositoryPath: string | undefined, branchName: string, commit: string): { raced(): boolean; mockRestore(): void } {
    let raced = false;
    const spy = interceptGit(service, (cwd, args, git) => {
      const creates = (args[0] === 'worktree' && args[1] === 'add') || (args[0] === 'update-ref' && args.includes(`refs/heads/${branchName}`));
      if (raced || !creates || (repositoryPath !== undefined && cwd !== repositoryPath)) return undefined;
      raced = true;
      return git.raw(['branch', branchName, commit]).then(() => git.raw(args));
    });
    return { raced: () => raced, mockRestore: () => spy.mockRestore() };
  }

  it('keeps a task branch another Git client creates after the preflight saw it absent', async () => {
    const { repoPath, repoGit } = await createTempRepo();
    const service = new WorktreeService({ baseDir: repoPath, hiveDir: path.join(repoPath, '.hive') });
    const base = (await repoGit.revparse(['HEAD'])).trim();
    const race = raceBranchCreation(service, undefined, branch, base);
    let failure: unknown;
    try {
      failure = await service.create(feature, task).catch((error) => error);
    } finally {
      race.mockRestore();
    }

    expect(race.raced()).toBe(true);
    // The branch is at the very commit this create would have used, yet it is not this create's to delete.
    expect((await repoGit.raw(['rev-parse', `refs/heads/${branch}`])).trim()).toBe(base);
    expect(failure).toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    expect((failure as Error).message).toMatch(new RegExp(`branch ${branch} .*was kept`));
    expect(await pathExists(path.join(repoPath, '.hive', '.worktrees', feature, task))).toBe(false);
    expect(operationMarkers(repoPath)).not.toEqual([]);
  });

  it('keeps a composite repository branch another Git client creates mid-create and rolls back only the branches it made', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const web = fx.repos['web-ui'];
    const webBranch = `hive/web-ui/${fx.feature}/${fx.task}`;
    const webBase = (await web.git.revparse(['HEAD'])).trim();
    const race = raceBranchCreation(fx.service, web.path, webBranch, webBase);
    let failure: unknown;
    try {
      failure = await fx.service.create(fx.feature, fx.task).catch((error) => error);
    } finally {
      race.mockRestore();
    }

    expect(race.raced()).toBe(true);
    expect((await web.git.raw(['rev-parse', `refs/heads/${webBranch}`])).trim()).toBe(webBase);
    expect(await branchExists(fx.repos.api.git, `hive/api/${fx.feature}/${fx.task}`)).toBe(false);
    expect(await pathExists(path.join(fx.service.getWorktreePath(fx.feature, fx.task), 'repos', 'api'))).toBe(false);
    expect(failure).toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    expect((failure as Error).message).toMatch(new RegExp(`branch ${webBranch} in repository web-ui .*was kept`));
  }, 30_000);

  /**
   * Just before this create's `worktree add` in `repositoryPath`, another Git client attaches its own clean checkout of
   * the very branch the create just made at the placement and leaves an ignored payload in it, so the create's add
   * fails because the path is taken. Placement, registration and branch then all look like the create's own.
   */
  function attachForeignCheckoutBeforeAdd(service: CoreWorktreeService, repositoryPath: string, routedCwd: string | undefined): { placement(): string | undefined; mockRestore(): void } {
    let placement: string | undefined;
    const spy = interceptGit(service, (cwd, args, git) => {
      if (placement !== undefined || args[0] !== 'worktree' || args[1] !== 'add' || cwd !== routedCwd) return undefined;
      placement = args[args.indexOf('--') + 1]!;
      const target = placement;
      return git.raw(['worktree', 'add', '--', target, args[args.indexOf('--') + 2]!])
        .then(async () => {
          await ignoreInRepository(repositoryPath, 'payload.local');
          await fs.writeFile(path.join(target, 'payload.local'), 'foreign ignored payload\n');
        })
        .then(() => git.raw(args));
    });
    return { placement: () => placement, mockRestore: () => spy.mockRestore() };
  }

  async function expectForeignCheckoutKept(repoGit: SimpleGit, placement: string, checkedOut: string): Promise<void> {
    expect(await fs.readFile(path.join(placement, 'payload.local'), 'utf-8')).toBe('foreign ignored payload\n');
    expect((await simpleGit(placement).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(checkedOut);
    expect(await repoGit.raw(['worktree', 'list', '--porcelain'])).toContain(`worktree ${await fs.realpath(placement)}\n`);
  }

  it('keeps a same-branch checkout another Git client attached at the placement through recovery, cleanup and create until it is gone', async () => {
    const { repoPath, repoGit } = await createTempRepo();
    const hiveDir = path.join(repoPath, '.hive');
    const service = new WorktreeService({ baseDir: repoPath, hiveDir });
    const foreign = attachForeignCheckoutBeforeAdd(service, repoPath, undefined);
    let failure: unknown;
    try {
      failure = await service.create(feature, task).catch((error) => error);
    } finally {
      foreign.mockRestore();
    }

    const placement = foreign.placement()!;
    const metadataPath = `${placement}.json`;
    expect(placement).toBe(path.join(hiveDir, '.worktrees', feature, task));
    await expectForeignCheckoutKept(repoGit, placement, branch);
    // The branch is this create's, but the placement is not shown to be, so the markers guard both for recovery.
    expect(failure).toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    expect((failure as Error).message).toMatch(/rollback left worktree .*01-test-task, which this create cannot show it attached/);
    expect(JSON.parse(await fs.readFile(metadataPath, 'utf-8'))).toMatchObject({ branch, createUnconfirmed: true });

    // Acknowledging the operation clears its markers, not the doubt: cleanup keeps the checkout, its ignored payload
    // and its registration, and create will not hand it out as the task's worker.
    await acknowledgePendingOperations(new WorktreeOperationRecoveryService({ baseDir: repoPath, hiveDir }));
    expect(operationMarkers(repoPath)).toEqual([]);

    // Inspection still shows the doubt, and merge refuses to integrate the foreign client's commit even with the
    // source pin and target the inspection supplies.
    const foreignGit = simpleGit(placement);
    await fs.writeFile(path.join(placement, 'foreign.txt'), 'foreign work\n');
    await foreignGit.add('foreign.txt');
    await foreignGit.commit(testCommitMessage('feat: foreign work'));
    const inspected = await service.inspect(feature, task);
    expect(inspected).toMatchObject({ path: placement, branch, createUnconfirmed: true });
    const destination = (await repoGit.revparse(['HEAD'])).trim();
    const refused = await service.merge(feature, task, 'merge', mergeMessage, { historyIntent: 'preserve-source', sourceCommit: inspected!.commit, expectedTarget: inspected!.target! });
    expect(refused).toMatchObject({ success: false, merged: false, reasonCode: 'CREATE_UNCONFIRMED', phase: 'preflight', mutation: 'none', retryable: false, action: 'manual_recovery' });
    expect(refused.error).toMatch(/never confirmed it \(createUnconfirmed in .*01-test-task\.json\).* is not integrated/);
    expect((await repoGit.revparse(['HEAD'])).trim()).toBe(destination);
    expect(await pathExists(path.join(repoPath, 'foreign.txt'))).toBe(false);
    expect(operationMarkers(repoPath)).toEqual([]);
    await foreignGit.raw(['reset', '--hard', 'HEAD~1']);

    const kept = await service.remove(feature, task, true);
    expect(kept.cleanup.worktreeRemoval).toMatchObject({ status: 'failed', error: expect.stringMatching(/Refusing to remove worktree .*01-test-task, which holds changed, untracked or ignored files: .*createUnconfirmed/) });
    expect(kept.branchDeleted).toBe(false);
    await expectForeignCheckoutKept(repoGit, placement, branch);
    await expect(service.create(feature, task)).rejects.toThrow(/was left by a create that never confirmed it \(createUnconfirmed in .*01-test-task\.json\)/);
    await expectForeignCheckoutKept(repoGit, placement, branch);

    // Once its owner removes that checkout, cleanup finishes and create starts over with a confirmed worker.
    await repoGit.raw(['worktree', 'remove', placement]);
    expect((await service.remove(feature, task, true)).cleanup.outcome).toBe('complete');
    expect(await pathExists(metadataPath)).toBe(false);
    expect(await branchExists(repoGit, branch)).toBe(false);
    const created = await service.create(feature, task);
    expect(JSON.parse(await fs.readFile(metadataPath, 'utf-8')).createUnconfirmed).toBeUndefined();
    // A confirmed worker's ignored dependencies and build output remain cleanup's to delete.
    await fs.writeFile(path.join(created.path, 'payload.local'), 'generated output\n');
    expect((await service.remove(feature, task, true)).cleanup.outcome).toBe('complete');
    expect(await pathExists(created.path)).toBe(false);
  });

  for (const fault of ['before its rename', 'after its rename published it'] as const) {
    it(`keeps an owned placement whose rollback would delete ignored files when the confirming write fails ${fault}`, async () => {
      const { repoPath, repoGit } = await createTempRepo();
      const hiveDir = path.join(repoPath, '.hive');
      const service = new WorktreeService({ baseDir: repoPath, hiveDir });
      const placement = path.join(hiveDir, '.worktrees', feature, task);
      const payload = path.join(placement, '.hive', 'payload.local');
      const add = interceptGit(service, (_cwd, args, git) => args[0] === 'worktree' && args[1] === 'add'
        ? git.raw(args).then(() => fs.mkdir(path.join(placement, '.hive'), { recursive: true }))
          .then(() => fs.writeFile(payload, 'ignored work\n'))
        : undefined);
      const metadata = fault === 'before its rename'
        ? failMetadataWrite(`${placement}.json`, { confirming: true })
        : failMetadataFlushAfterRename(`${placement}.json`);
      let failure: unknown;
      try {
        failure = await service.create(feature, task).catch((error) => error);
      } finally {
        metadata.mockRestore();
        add.mockRestore();
      }

      expect(failure).toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
      expect((failure as Error).message).toMatch(/simulated (metadata write|directory flush) failure; rollback left worktree .*01-test-task, which holds changed, untracked or ignored files/);
      expect((failure as Error).message).not.toMatch(/unresolved/);
      expect(await fs.readFile(payload, 'utf-8')).toBe('ignored work\n');
      expect(await branchExists(repoGit, branch)).toBe(true);
      expect(operationMarkers(repoPath)).not.toEqual([]);
      // Whether or not the rename published the confirmed record, the record again says the create never confirmed
      // the placement, so acknowledging the operation does not let cleanup delete the ignored files.
      expect(JSON.parse(await fs.readFile(`${placement}.json`, 'utf-8')).createUnconfirmed).toBe(true);
      await acknowledgePendingOperations(new WorktreeOperationRecoveryService({ baseDir: repoPath, hiveDir }));
      const kept = await service.remove(feature, task, true);
      expect(kept.cleanup.worktreeRemoval).toMatchObject({ status: 'failed', error: expect.stringMatching(/createUnconfirmed/) });
      expect(await fs.readFile(payload, 'utf-8')).toBe('ignored work\n');
      expect(await branchExists(repoGit, branch)).toBe(true);

      await fs.rm(path.join(placement, '.hive'), { recursive: true });
      expect((await service.remove(feature, task, true)).cleanup.outcome).toBe('complete');
      expect([await pathExists(placement), await pathExists(`${placement}.json`), await branchExists(repoGit, branch)]).toEqual([false, false, false]);
    });
  }

  it('names a record it cannot put back to createUnconfirmed as unresolved and keeps the markers', async () => {
    const { repoPath, repoGit } = await createTempRepo();
    const service = new WorktreeService({ baseDir: repoPath, hiveDir: path.join(repoPath, '.hive') });
    const placement = path.join(repoPath, '.hive', '.worktrees', feature, task);
    const add = interceptGit(service, (_cwd, args, git) => args[0] === 'worktree' && args[1] === 'add'
      ? git.raw(args).then(() => fs.mkdir(path.join(placement, '.hive'), { recursive: true }))
        .then(() => fs.writeFile(path.join(placement, '.hive', 'payload.local'), 'ignored work\n'))
      : undefined);
    const metadata = failMetadataFlushAfterRename(`${placement}.json`, { restoreFails: true });
    let failure: unknown;
    try {
      failure = await service.create(feature, task).catch((error) => error);
    } finally {
      metadata.mockRestore();
      add.mockRestore();
    }

    expect(failure).toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    expect((failure as Error).message).toMatch(/simulated directory flush failure; putting createUnconfirmed back in .*01-test-task\.json also failed .*simulated restore failure.*; rollback left worktree .*The workspace record .*01-test-task\.json is unresolved: it may read as confirmed, and recovery does not read workspace records\. Do not acknowledge the operation: keep the record and the kept checkout as they are and report both to the operator/);
    // The agent is not told to repair the record itself.
    expect((failure as Error).message).not.toMatch(/set createUnconfirmed: true in it or remove the kept checkout yourself/);
    // The record reads as confirmed; only the retained markers still refuse every later mutation.
    expect(JSON.parse(await fs.readFile(`${placement}.json`, 'utf-8')).createUnconfirmed).toBeUndefined();
    expect(operationMarkers(repoPath)).not.toEqual([]);
    await expect(service.remove(feature, task, true)).rejects.toThrow(WorktreeOperationRecoveryRequiredError);
    expect(await fs.readFile(path.join(placement, '.hive', 'payload.local'), 'utf-8')).toBe('ignored work\n');
    expect(await branchExists(repoGit, branch)).toBe(true);
  });

  it('refuses to reattach a retained branch whose record a create never confirmed once its checkout is gone', async () => {
    const { repoPath, repoGit } = await createTempRepo();
    const service = new WorktreeService({ baseDir: repoPath, hiveDir: path.join(repoPath, '.hive') });
    const created = await service.create(feature, task);
    const metadataPath = `${created.path}.json`;
    // A create that stopped after its own add and before confirming it leaves the record unconfirmed.
    const record = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
    await fs.writeFile(metadataPath, JSON.stringify({ ...record, createUnconfirmed: true }));
    expect((await service.remove(feature, task)).cleanup.outcome).toBe('complete');
    const tip = (await repoGit.revparse([branch])).trim();

    // The checkout is gone and the branch stays; the branch may now hold another client's commits, so create neither
    // reattaches it nor confirms the record, and it refuses before any marker or Git effect.
    await expect(service.create(feature, task)).rejects.toThrow(/Cannot reattach retained task branch hive\/test-feature\/01-test-task: its workspace metadata .*01-test-task\.json was left by a create that never confirmed it \(createUnconfirmed\).*hive_worktree_cleanup/);
    expect(await pathExists(created.path)).toBe(false);
    expect(JSON.parse(await fs.readFile(metadataPath, 'utf-8')).createUnconfirmed).toBe(true);
    expect((await repoGit.revparse([branch])).trim()).toBe(tip);
    expect(operationMarkers(repoPath)).toEqual([]);

    // Deleting the branch releases the record, and create starts over with a confirmed worker.
    expect((await service.remove(feature, task, true)).cleanup.outcome).toBe('complete');
    expect([await pathExists(metadataPath), await branchExists(repoGit, branch)]).toEqual([false, false]);
    await service.create(feature, task);
    expect(JSON.parse(await fs.readFile(metadataPath, 'utf-8')).createUnconfirmed).toBeUndefined();
  });

  it('keeps an unconfirmed composite workspace root and manifest while its worker branches remain', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const created = await fx.service.create(fx.feature, fx.task);
    const manifestPath = path.join(created.path, 'workspace.json');
    const branches = { api: `hive/api/${fx.feature}/${fx.task}`, 'web-ui': `hive/web-ui/${fx.feature}/${fx.task}` };
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, createUnconfirmed: true }));

    // Worktree-only cleanup removes the empty checkouts but keeps the root and its unconfirmed manifest beside the
    // branches, and says so instead of reporting a complete removal, also when it runs again.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const removed = await fx.service.remove(fx.feature, fx.task);
      expect(removed.cleanup.outcome).toBe('partial');
      expect(removed.worktreeRemoved).toBe(false);
      expect(removed.cleanup.failures).toContainEqual(expect.objectContaining({ step: 'composite-root', cause: expect.stringMatching(/Kept .* with its manifest .*workspace\.json, which a create never confirmed \(createUnconfirmed\), while worker branches remain: hive\/api\/.* in repository api, hive\/web-ui\/.* in repository web-ui/) }));
      expect(JSON.parse(await fs.readFile(manifestPath, 'utf-8')).createUnconfirmed).toBe(true);
      expect([await pathExists(created.repos!.api.path), await pathExists(created.repos!['web-ui'].path)]).toEqual([false, false]);
      expect([await branchExists(fx.repos.api.git, branches.api), await branchExists(fx.repos['web-ui'].git, branches['web-ui'])]).toEqual([true, true]);
    }
    await expect(fx.service.create(fx.feature, fx.task)).rejects.toThrow(/never confirmed it \(createUnconfirmed in .*workspace\.json\).*keeps this record until the worker branches are deleted too/);

    // Another Git client attaches both branches again and leaves an ignored payload in one: the workspace still reads
    // as unconfirmed, merge refuses it, and cleanup keeps the payload with the manifest.
    for (const repoId of ['api', 'web-ui'] as const) {
      await fx.repos[repoId].git.raw(['worktree', 'add', '--', created.repos![repoId].path, branches[repoId]]);
    }
    await ignoreInRepository(fx.repos['web-ui'].path, 'payload.local');
    await fs.writeFile(path.join(created.repos!['web-ui'].path, 'payload.local'), 'foreign ignored payload\n');
    const inspected = (await fx.service.inspect(fx.feature, fx.task))!;
    expect(inspected.createUnconfirmed).toBe(true);
    const refused = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, {
      historyIntent: 'preserve-source',
      sourceCommits: Object.fromEntries(Object.entries(inspected.repos!).map(([id, repo]) => [id, repo.commit])),
      expectedTargets: Object.fromEntries(Object.entries(inspected.repos!).map(([id, repo]) => [id, repo.target!])),
    });
    expect(refused).toMatchObject({ success: false, merged: false, reasonCode: 'CREATE_UNCONFIRMED', mutation: 'none' });
    const kept = await fx.service.remove(fx.feature, fx.task, true);
    expect(kept.cleanup.outcome).not.toBe('complete');
    expect(await fs.readFile(path.join(created.repos!['web-ui'].path, 'payload.local'), 'utf-8')).toBe('foreign ignored payload\n');
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf-8')).createUnconfirmed).toBe(true);

    // Once that checkout is gone, cleanup with branch deletion retires every branch and removes the workspace.
    await fx.repos['web-ui'].git.raw(['worktree', 'remove', '--force', created.repos!['web-ui'].path]);
    expect((await fx.service.remove(fx.feature, fx.task, true)).cleanup.outcome).toBe('complete');
    expect(await pathExists(created.path)).toBe(false);
    expect([await branchExists(fx.repos.api.git, branches.api), await branchExists(fx.repos['web-ui'].git, branches['web-ui'])]).toEqual([false, false]);
  }, 30_000);

  it('refuses a workspace record whose createUnconfirmed is anything but true', async () => {
    const { repoPath } = await createTempRepo();
    const service = new WorktreeService({ baseDir: repoPath, hiveDir: path.join(repoPath, '.hive') });
    const single = await service.create(feature, task);
    const fx = await createCompositeFixture({ repoIds: ['api'] });
    const composite = await fx.service.create(fx.feature, fx.task);
    const records = [
      { file: `${single.path}.json`, read: () => service.get(feature, task), error: /Invalid single workspace metadata/ },
      { file: path.join(composite.path, 'workspace.json'), read: () => fx.service.get(fx.feature, fx.task), error: /Invalid composite workspace manifest/ },
    ];
    for (const { file, read, error } of records) {
      const record = JSON.parse(await fs.readFile(file, 'utf-8'));
      for (const value of [false, 'true', null]) {
        await fs.writeFile(file, JSON.stringify({ ...record, createUnconfirmed: value }));
        await expect(read()).rejects.toThrow(error);
      }
    }
    await expect(service.remove(feature, task)).rejects.toThrow(/Invalid single workspace metadata/);
    await expect(fx.service.remove(fx.feature, fx.task)).rejects.toThrow(/Invalid composite workspace manifest/);
    expect(await pathExists(single.path)).toBe(true);
    expect(await pathExists(composite.repos!.api.path)).toBe(true);
  }, 30_000);

  it('keeps a same-branch checkout another Git client attached at a composite repository placement until it is gone, rolling back the repositories it attached', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const web = fx.repos['web-ui'];
    const webBranch = `hive/web-ui/${fx.feature}/${fx.task}`;
    const foreign = attachForeignCheckoutBeforeAdd(fx.service, web.path, web.path);
    let failure: unknown;
    try {
      failure = await fx.service.create(fx.feature, fx.task).catch((error) => error);
    } finally {
      foreign.mockRestore();
    }

    const workspacePath = fx.service.getWorktreePath(fx.feature, fx.task);
    const manifestPath = path.join(workspacePath, 'workspace.json');
    const placement = foreign.placement()!;
    expect(placement).toBe(path.join(workspacePath, 'repos', 'web-ui'));
    await expectForeignCheckoutKept(web.git, placement, webBranch);
    expect(await pathExists(path.join(workspacePath, 'repos', 'api'))).toBe(false);
    expect(await branchExists(fx.repos.api.git, `hive/api/${fx.feature}/${fx.task}`)).toBe(false);
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf-8')).createUnconfirmed).toBe(true);
    expect(failure).toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    expect((failure as Error).message).toMatch(/rollback left worktree .*repos\/web-ui, which this create cannot show it attached, branch hive\/web-ui\/.*kept unconfirmed/);

    const repositories = Object.entries(fx.repos).map(([id, repo]) => ({ id, path: repo.path, root: repo.path }));
    await acknowledgePendingOperations(new WorktreeOperationRecoveryService({ baseDir: fx.projectRoot, hiveDir: path.join(fx.projectRoot, '.hive'), repositoryResolver: () => repositories }));
    const kept = await fx.service.remove(fx.feature, fx.task, true);
    expect(kept.cleanup.outcome).not.toBe('complete');
    expect(kept.cleanup.failures).toContainEqual(expect.objectContaining({ repoId: 'web-ui', cause: expect.stringMatching(/Refusing to remove worktree .*repos\/web-ui, which holds changed, untracked or ignored files: .*createUnconfirmed/) }));
    await expectForeignCheckoutKept(web.git, placement, webBranch);
    expect(await pathExists(manifestPath)).toBe(true);
    await expect(fx.service.create(fx.feature, fx.task)).rejects.toThrow(/never confirmed it \(createUnconfirmed in .*workspace\.json\)/);

    await web.git.raw(['worktree', 'remove', placement]);
    expect((await fx.service.remove(fx.feature, fx.task, true)).cleanup.outcome).toBe('complete');
    expect(await pathExists(workspacePath)).toBe(false);
    expect(await branchExists(web.git, webBranch)).toBe(false);
    const created = await fx.service.create(fx.feature, fx.task);
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf-8')).createUnconfirmed).toBeUndefined();
    await fs.writeFile(path.join(created.repos!['web-ui'].path, 'payload.local'), 'generated output\n');
    expect((await fx.service.remove(fx.feature, fx.task, true)).cleanup.outcome).toBe('complete');
    expect(await pathExists(workspacePath)).toBe(false);
  }, 30_000);

  it('cleans up an unconfirmed composite workspace whose checkouts hold nothing, and keeps a checkout holding ignored files', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const created = await fx.service.create(fx.feature, fx.task);
    const manifestPath = path.join(created.path, 'workspace.json');
    // A create that stopped after its own adds and before confirming them leaves the manifest unconfirmed.
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    expect(manifest.createUnconfirmed).toBeUndefined();
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, createUnconfirmed: true }));
    await expect(fx.service.create(fx.feature, fx.task)).rejects.toThrow(/never confirmed it/);
    const inspected = (await fx.service.inspect(fx.feature, fx.task))!;
    expect(inspected.createUnconfirmed).toBe(true);
    const refused = await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, {
      historyIntent: 'preserve-source',
      sourceCommits: Object.fromEntries(Object.entries(inspected.repos!).map(([id, repo]) => [id, repo.commit])),
      expectedTargets: Object.fromEntries(Object.entries(inspected.repos!).map(([id, repo]) => [id, repo.target!])),
    });
    expect(refused).toMatchObject({ success: false, merged: false, reasonCode: 'CREATE_UNCONFIRMED', mutation: 'none', action: 'manual_recovery' });
    expect(refused.error).toMatch(/workspace\.json\).* is not integrated/);
    expect(operationMarkers(fx.projectRoot)).toEqual([]);
    const webPath = created.repos!['web-ui'].path;
    await ignoreInRepository(fx.repos['web-ui'].path, 'payload.local');
    await fs.writeFile(path.join(webPath, 'payload.local'), 'ignored work\n');

    const partial = await fx.service.remove(fx.feature, fx.task, true);
    expect(partial.cleanup.outcome).not.toBe('complete');
    expect(await pathExists(created.repos!.api.path)).toBe(false);
    expect(await fs.readFile(path.join(webPath, 'payload.local'), 'utf-8')).toBe('ignored work\n');

    await fs.unlink(path.join(webPath, 'payload.local'));
    expect((await fx.service.remove(fx.feature, fx.task, true)).cleanup.outcome).toBe('complete');
    expect(await pathExists(created.path)).toBe(false);
    expect(await branchExists(fx.repos['web-ui'].git, `hive/web-ui/${fx.feature}/${fx.task}`)).toBe(false);
  }, 30_000);

  it('reports a task branch as absent only when its exact ref is missing', async () => {
    const fixture = await createCommittedFixture();
    // An unreadable containment check is a failed deletion, not an absent branch.
    const spy = interceptGit(fixture.service, (_cwd, args) => args[0] === 'rev-list' && args[1] === '--count'
      ? Promise.reject(new Error("fatal: ambiguous argument 'main..HEAD': unknown revision or path not in the working tree."))
      : undefined);
    let unreadable: Awaited<ReturnType<CoreWorktreeService['remove']>>;
    try {
      unreadable = await fixture.service.remove(fixture.feature, fixture.task, true);
    } finally {
      spy.mockRestore();
    }
    expect(unreadable.cleanup.branchDeletion).toMatchObject({ status: 'failed', error: expect.stringContaining('ambiguous argument') });
    expect(unreadable.branchDeleted).toBe(false);
    expect(await branchExists(fixture.repoGit, branch)).toBe(true);

    // A detached target is compared by its HEAD commit.
    await fixture.repoGit.raw(['checkout', '--detach', 'HEAD']);
    const detached = await fixture.service.remove(fixture.feature, fixture.task, true);
    expect(detached.cleanup.branchDeletion).toMatchObject({ status: 'failed', error: expect.stringMatching(/1 unmerged commits would be discarded/) });
    expect(await branchExists(fixture.repoGit, branch)).toBe(true);

    await fixture.repoGit.raw(['update-ref', '-d', `refs/heads/${branch}`]);
    expect((await fixture.service.remove(fixture.feature, fixture.task, true)).cleanup.branchDeletion.status).toBe('already_absent');
  });

  it('leaves staged destination data untouched when a preflight read fails before any mutation', async () => {
    const fixture = await createCommittedFixture();
    const stagedPath = path.join(fixture.repoPath, 'staged-user.txt');
    await fs.writeFile(stagedPath, 'staged user content\n');
    await fixture.repoGit.add('staged-user.txt');
    let failed = false;
    const spy = interceptGit(fixture.service, (cwd, args) => {
      if (cwd !== undefined || failed || args.join(' ') !== 'status --porcelain=v1 -z --untracked-files=no') return undefined;
      failed = true;
      return Promise.reject(new Error('simulated status read failure'));
    });
    let result: MergeResult;
    try {
      result = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });
    } finally {
      spy.mockRestore();
    }

    expect(failed).toBe(true);
    expect(result).toMatchObject({ success: false, reasonCode: 'GIT_OPERATION_FAILED', mutation: 'none', error: expect.stringContaining('simulated status read failure') });
    expect(await fs.readFile(stagedPath, 'utf-8')).toBe('staged user content\n');
    expect((await fixture.repoGit.raw(['diff', '--cached', '--name-only'])).trim()).toBe('staged-user.txt');
    expect(operationMarkers(fixture.repoPath)).toEqual([]);
  });

  it('reports a squash retry whose changes already landed beside independent target work as a no-op', async () => {
    const fixture = await createCommittedFixture();
    await fs.writeFile(path.join(fixture.repoPath, 'independent.txt'), 'independent\n');
    await fixture.repoGit.add('independent.txt');
    await fixture.repoGit.commit(testCommitMessage('feat: independent target work'));
    const sourceCommit = (await simpleGit(fixture.worktreePath).revparse(['HEAD'])).trim();
    const first = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private', sourceCommit });
    expect(first).toMatchObject({ success: true, merged: true, provenance: { status: 'recorded' } });
    const head = (await fixture.repoGit.revparse(['HEAD'])).trim();
    // The first merge's receipt sits in this project-root destination; it is not protected local data.
    expect(await fs.readdir(path.join(fixture.repoPath, '.hive', 'provenance', 'integrations'))).toEqual([`${head}.json`]);

    const retry = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private', sourceCommit });
    expect(retry).toMatchObject({ success: true, merged: false, reasonCode: 'NO_TRACKED_CHANGES', mutation: 'none', retryable: false, action: 'none' });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(head);
    expect(await pathExists(path.join(fixture.repoPath, '.git', 'SQUASH_MSG'))).toBe(false);
    expect((await fixture.repoGit.raw(['status', '--porcelain=v1'])).trim()).toBe('');
    expect(operationMarkers(fixture.repoPath)).toEqual([]);

    // The private attestation, not source containment, proves the completed no-op for same-call cleanup.
    const cleaned = await fixture.service.merge(fixture.feature, fixture.task, 'squash', mergeMessage, {
      historyIntent: 'rewrite-private',
      sourceCommit,
      cleanup: 'worktree+branch',
    });
    expect(cleaned).toMatchObject({ success: true, reasonCode: 'NO_TRACKED_CHANGES', cleanup: { outcome: 'complete' } });
    expect(await branchExists(fixture.repoGit, branch)).toBe(false);
  }, 30_000);

  it('persists a composite manifest before the first worktree add, so an incompletely rolled back create is cleaned up by the owning tool', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const workspacePath = fx.service.getWorktreePath(fx.feature, fx.task);
    const manifestPath = path.join(workspacePath, 'workspace.json');
    const heads = Object.fromEntries(await Promise.all(Object.entries(fx.repos).map(async ([id, repo]) => [id, (await repo.git.revparse(['HEAD'])).trim()])));
    const manifestAtAdd: unknown[] = [];
    const spy = interceptGit(fx.service, (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        manifestAtAdd.push(fsSync.existsSync(manifestPath) ? JSON.parse(fsSync.readFileSync(manifestPath, 'utf-8')) : null);
        if (cwd === fx.repos['web-ui'].path) return Promise.reject(new Error('simulated web-ui add failure'));
      }
      if (args[0] === 'worktree' && args[1] === 'remove' && cwd === fx.repos.api.path) return Promise.reject(new Error('simulated api removal failure'));
      return undefined;
    });
    let failure: unknown;
    try {
      failure = await fx.service.create(fx.feature, fx.task).catch((error) => error);
    } finally {
      spy.mockRestore();
    }

    expect(manifestAtAdd[0]).toMatchObject({ mode: 'composite', baseCommits: heads, repos: { api: { commit: heads.api }, 'web-ui': { commit: heads['web-ui'] } } });
    // The original failure and what the rollback left are both reported; the markers guard what remains.
    expect(failure).toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    expect((failure as Error).message).toMatch(/simulated web-ui add failure; rollback left worktree .*repos\/api, branch hive\/api\//);
    expect(await pathExists(manifestPath)).toBe(true);
    expect(await pathExists(path.join(workspacePath, 'repos', 'api'))).toBe(true);
    expect(await branchExists(fx.repos['web-ui'].git, `hive/web-ui/${fx.feature}/${fx.task}`)).toBe(false);

    const recovery = new WorktreeOperationRecoveryService({
      baseDir: fx.projectRoot,
      hiveDir: path.join(fx.projectRoot, '.hive'),
      repositoryResolver: () => Object.entries(fx.repos).map(([id, repo]) => ({ id, path: repo.path, root: repo.path })),
    });
    const [pending] = await recovery.list();
    expect(pending).toMatchObject({ operationId: (failure as WorktreeOperationRecoveryRequiredError).operationIds[0], marker: { kind: 'create' }, recovery: { available: true } });
    await recovery.recover({ operationId: pending!.operationId, markerDigest: pending!.markerDigest, observedStateDigest: pending!.observedStateDigest, mutatorsStopped: true });

    expect((await fx.service.remove(fx.feature, fx.task, true)).cleanup.outcome).toBe('complete');
    expect(await pathExists(workspacePath)).toBe(false);
    expect(await branchExists(fx.repos.api.git, `hive/api/${fx.feature}/${fx.task}`)).toBe(false);

    // An empty placement, as an interrupted create or root removal leaves, holds nothing to preserve.
    await fs.mkdir(workspacePath, { recursive: true });
    expect((await fx.service.create(fx.feature, fx.task)).mode).toBe('composite');
  }, 30_000);

  it('completes a composite squash retry after a partial result, treating the already squashed repository as a no-op', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web'] });
    const created = await fx.service.create(fx.feature, fx.task);
    const commitIn = async (cwd: string, file: string, content: string, subject: string) => {
      await fs.writeFile(path.join(cwd, file), content);
      const git = simpleGit(cwd);
      await git.add(file);
      await git.commit(testCommitMessage(subject));
      return (await git.revparse(['HEAD'])).trim();
    };
    await commitIn(created.repos!.api.path, 'api-change.txt', 'task change\n', 'feat: api task change');
    await commitIn(created.repos!.web.path, 'README.md', '# web\n\ntask edit\n', 'feat: web task change');
    await commitIn(fx.repos.api.path, 'api-independent.txt', 'independent\n', 'feat: independent api work');
    await commitIn(fx.repos.web.path, 'README.md', '# web\n\nconflicting edit\n', 'feat: conflicting web work');

    const partial = await fx.service.merge(fx.feature, fx.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private' });
    expect(partial).toMatchObject({ reasonCode: 'COMPOSITE_PARTIAL', repos: { api: { merged: true }, web: { reasonCode: 'MERGE_CONFLICT_ABORTED' } } });
    const apiHead = (await fx.repos.api.git.revparse(['HEAD'])).trim();
    await simpleGit(created.repos!.web.path).raw(['merge', '-X', 'ours', 'main', '-m', testCommitMessage('chore: reconcile web target')]);

    const retry = await fx.service.merge(fx.feature, fx.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private', cleanup: 'worktree+branch' });
    expect(retry).toMatchObject({
      success: true,
      merged: true,
      repos: { api: { merged: false, reasonCode: 'NO_TRACKED_CHANGES', mutation: 'none' }, web: { merged: true } },
      cleanup: { outcome: 'complete' },
    });
    expect((await fx.repos.api.git.revparse(['HEAD'])).trim()).toBe(apiHead);
    expect(await pathExists(path.join(fx.repos.api.path, '.git', 'SQUASH_MSG'))).toBe(false);
    expect(await pathExists(created.path)).toBe(false);
  }, 30_000);

  it('refuses a rebase that would preserve conflicts before any lock or Git read', async () => {
    const fixture = await createConflictingFixture();
    const gitSpy = spyOn(fixture.service as any, 'getGit');
    let result: MergeResult;
    try {
      result = await fixture.service.merge(fixture.feature, fixture.task, 'rebase', undefined, { historyIntent: 'rewrite-private', preserveConflicts: true, expectedTarget: await readWorktreeTargetIdentity(fixture.repoPath) });
      expect(gitSpy).not.toHaveBeenCalled();
    } finally {
      gitSpy.mockRestore();
    }
    expect(result).toMatchObject({
      success: false,
      reasonCode: 'INVALID_ARGUMENTS',
      mutation: 'none',
      retryable: false,
      action: 'correct_arguments',
      error: expect.stringMatching(/strategy 'squash'.*normal merge/),
    });
    expect(operationMarkers(fixture.repoPath)).toEqual([]);
  });

  /**
   * Run `change` after a create selected its placement and before it publishes the placement record, and record the
   * feature's task-sync lock, the status lock and the record's presence the moment the record is written, and both
   * locks again when Git runs.
   */
  function interruptPlacementPublication(service: CoreWorktreeService, statusPath: string, placementRecord: string) {
    const publish = (service as any).publishTaskPlacement.bind(service);
    const validate = (service as any).validateExactWorktreeRegistration.bind(service);
    // <feature>/<tasks|execution>/<task>/status.json
    const taskSyncPath = path.join(path.dirname(path.dirname(path.dirname(statusPath))), 'task-sync.json');
    const locks = () => `task-sync lock ${probeLock(taskSyncPath)}, status lock ${probeLock(statusPath)}`;
    const observed: string[] = [];
    let change = async () => {};
    const spies = [
      spyOn(service as any, 'publishTaskPlacement').mockImplementation(async (...args: any[]) => {
        await change();
        const [owner, step, selectedStatusPath, admit, write] = args;
        return publish(owner, step, selectedStatusPath, admit, () => {
          write();
          observed.push(`published: ${locks()}, record ${fsSync.existsSync(placementRecord)}`);
        });
      }),
      spyOn(service as any, 'validateExactWorktreeRegistration').mockImplementation(async (...args: any[]) => {
        observed.push(`git: ${locks()}`);
        return validate(...args);
      }),
    ];
    return {
      observed,
      between(next: () => Promise<void>) { change = next; },
      mockRestore() { spies.forEach((spy) => spy.mockRestore()); },
    };
  }

  it('publishes a worker placement under the task status lock only while the task still selects it', async () => {
    const { repoPath, repoGit } = await createTempRepo();
    const hiveDir = path.join(repoPath, '.hive');
    const taskPath = path.join(hiveDir, 'features', feature, 'tasks', task);
    const statusPath = path.join(taskPath, 'status.json');
    const status = await fs.readFile(statusPath, 'utf-8');
    const sidecar = path.join(hiveDir, '.worktrees', feature, `${task}.json`);
    const service = new WorktreeService({ baseDir: repoPath, hiveDir });
    const interrupted = interruptPlacementPublication(service, statusPath, sidecar);
    try {
      // A task sync removed the pending task while the create waited between selecting its placement and publishing it.
      interrupted.between(() => fs.rm(taskPath, { recursive: true }));
      await expect(service.create(feature, task)).rejects.toThrow(`Task ${feature}/${task} no longer has a task record`);
      // Nothing was published, the removed task's folder is not recreated, and nothing is left to recover.
      expect(await pathExists(sidecar)).toBe(false);
      expect(await pathExists(taskPath)).toBe(false);
      expect(await branchExists(repoGit, branch)).toBe(false);
      expect(operationMarkers(repoPath)).toEqual([]);

      // A refresh moved the task's repositories.
      await fs.mkdir(taskPath, { recursive: true });
      await fs.writeFile(statusPath, status);
      interrupted.between(() => fs.writeFile(statusPath, JSON.stringify({ ...JSON.parse(status), repoIds: ['api'] })));
      await expect(service.create(feature, task)).rejects.toThrow(`Task ${feature}/${task} now declares repositories api`);
      expect(await pathExists(sidecar)).toBe(false);
      expect(await branchExists(repoGit, branch)).toBe(false);
      expect(operationMarkers(repoPath)).toEqual([]);

      await fs.writeFile(statusPath, status);
      interrupted.between(async () => {});
      expect(await service.create(feature, task)).toMatchObject({ mode: 'legacy', branch });
    } finally {
      interrupted.mockRestore();
    }
    // The record task sync's placement check finds exists before the locks are released, and Git runs after they are.
    expect(interrupted.observed).toEqual(['published: task-sync lock held, status lock held, record true', 'git: task-sync lock free, status lock free']);
    // Creating the worker reads the task record and never writes it.
    expect(await fs.readFile(statusPath, 'utf-8')).toBe(status);
  });

  it('claims a worker placement from the status file its selection read, never a legacy record left behind', async () => {
    const { repoPath, repoGit } = await createTempRepo();
    const hiveDir = path.join(repoPath, '.hive');
    const taskPath = path.join(hiveDir, 'features', feature, 'tasks', task);
    const status = await fs.readFile(path.join(taskPath, 'status.json'), 'utf-8');
    // An older layout's record of the same task, identical in everything that chooses its placement.
    const legacyTaskPath = path.join(hiveDir, 'features', feature, 'execution', task);
    const legacyStatusPath = path.join(legacyTaskPath, 'status.json');
    await fs.mkdir(legacyTaskPath, { recursive: true });
    await fs.writeFile(legacyStatusPath, status);
    const sidecar = path.join(hiveDir, '.worktrees', feature, `${task}.json`);
    const service = new WorktreeService({ baseDir: repoPath, hiveDir });
    const interrupted = interruptPlacementPublication(service, legacyStatusPath, sidecar);
    try {
      // The selection read the modern record; a task sync removed it before the claim, leaving the legacy record.
      interrupted.between(() => fs.rm(taskPath, { recursive: true }));
      await expect(service.create(feature, task)).rejects.toThrow(`Task ${feature}/${task} status now resolves to ${legacyStatusPath}`);
      expect(await pathExists(sidecar)).toBe(false);
      expect(await pathExists(taskPath)).toBe(false);
      expect(await branchExists(repoGit, branch)).toBe(false);
      expect(operationMarkers(repoPath)).toEqual([]);

      // A task whose only record is the legacy one still gets its worker, claimed under that record's lock.
      interrupted.between(async () => {});
      expect(await service.create(feature, task)).toMatchObject({ mode: 'legacy', branch });
      expect(await pathExists(taskPath)).toBe(false);
    } finally {
      interrupted.mockRestore();
    }
    expect(interrupted.observed).toEqual(['published: task-sync lock held, status lock held, record true', 'git: task-sync lock free, status lock free']);
    expect(await fs.readFile(legacyStatusPath, 'utf-8')).toBe(status);
  });

  it('publishes a composite workspace root under the task status lock only while the task keeps its repositories', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const hiveDir = path.join(fx.projectRoot, '.hive');
    const statusPath = path.join(hiveDir, 'features', `01_${fx.feature}`, 'tasks', fx.task, 'status.json');
    const status = await fs.readFile(statusPath, 'utf-8');
    const workspaceRoot = path.join(hiveDir, '.worktrees', fx.feature, fx.task);
    const interrupted = interruptPlacementPublication(fx.service, statusPath, workspaceRoot);
    try {
      interrupted.between(() => fs.writeFile(statusPath, JSON.stringify({ ...JSON.parse(status), repoIds: ['api'] })));
      await expect(fx.service.create(fx.feature, fx.task)).rejects.toThrow(`Task ${fx.feature}/${fx.task} now declares repositories api`);
      expect(await pathExists(workspaceRoot)).toBe(false);
      for (const [id, repo] of Object.entries(fx.repos)) {
        expect(await branchExists(repo.git, `hive/${id}/${fx.feature}/${fx.task}`)).toBe(false);
        expect(operationMarkers(repo.path)).toEqual([]);
      }

      await fs.writeFile(statusPath, status);
      interrupted.between(async () => {});
      expect(await fx.service.create(fx.feature, fx.task)).toMatchObject({ mode: 'composite' });
    } finally {
      interrupted.mockRestore();
    }
    expect(interrupted.observed).toEqual(['published: task-sync lock held, status lock held, record true', 'git: task-sync lock free, status lock free', 'git: task-sync lock free, status lock free']);
    expect(await fs.readFile(statusPath, 'utf-8')).toBe(status);
  });
});

describe('WorktreeService targeted tasks', () => {
  it('creates a task worker bound to a retained checkout of one manifest repository and integrates into it', async () => {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const repositories = Object.entries(fx.repos).map(([id, repository]) => ({ id, path: repository.path, root: repository.path }));
    const hiveDir = path.join(fx.projectRoot, '.hive');
    await new RetainedCheckoutService({ baseDir: fx.projectRoot, hiveDir, repositoryResolver: () => repositories })
      .create({ id: 'api/release', branch: 'release', baseRef: 'HEAD' });
    const checkoutPath = path.join(hiveDir, 'checkouts', 'api', 'release');
    await fs.writeFile(
      path.join(fx.projectRoot, '.hive', 'features', `01_${fx.feature}`, 'tasks', fx.task, 'status.json'),
      JSON.stringify({ status: 'pending', origin: 'plan', repoIds: ['api'], target: 'api/release' }),
    );
    const apiRoot = await readWorktreeTargetIdentity(fx.repos.api.path);

    const created = await fx.service.create(fx.feature, fx.task);
    expect(created).toMatchObject({
      mode: 'targeted',
      repoId: 'api',
      branch: `hive-targeted/task/${fx.feature}/${fx.task}`,
      baseCommit: apiRoot.commit,
      targetBinding: { id: 'api/release', path: checkoutPath, ref: 'refs/heads/release' },
    });
    expect((await fx.service.list(fx.feature)).worktrees.map((worktree) => worktree.mode)).toEqual(['targeted']);
    await expect(fx.service.cleanup(fx.feature)).resolves.toMatchObject({ removed: [] });

    await fs.writeFile(path.join(created.path, 'release.txt'), 'release\n');
    const workerGit = simpleGit(created.path);
    await workerGit.add(['release.txt']);
    await workerGit.commit(testCommitMessage('feat: add release note'));
    const sourceCommit = (await workerGit.revparse(['HEAD'])).trim();
    const inspected = (await fx.service.inspect(fx.feature, fx.task))!;
    expect(inspected.targetBinding?.status).toBe('ok');
    expect(inspected.createUnconfirmed).toBeUndefined();

    // A sidecar its create never confirmed is shown by inspection and never integrated.
    const sidecarPath = `${created.path}.json`;
    const sidecar = await fs.readFile(sidecarPath, 'utf-8');
    await fs.writeFile(sidecarPath, JSON.stringify({ ...JSON.parse(sidecar), createUnconfirmed: true }));
    expect((await fx.service.inspect(fx.feature, fx.task))?.createUnconfirmed).toBe(true);
    const checkoutBefore = await readWorktreeTargetIdentity(checkoutPath);
    const refused = await fx.service.merge(fx.feature, fx.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private', sourceCommit, expectedTarget: inspected.target! });
    expect(refused).toMatchObject({ success: false, merged: false, reasonCode: 'CREATE_UNCONFIRMED', mutation: 'none', action: 'manual_recovery' });
    expect(refused.error).toMatch(/is not integrated.*hive_worktree_cleanup/);
    expect(await readWorktreeTargetIdentity(checkoutPath)).toEqual(checkoutBefore);
    await fs.writeFile(sidecarPath, sidecar);

    const merged = await fx.service.merge(fx.feature, fx.task, 'squash', mergeMessage, { historyIntent: 'rewrite-private', sourceCommit, expectedTarget: inspected.target!, cleanup: 'worktree+branch' });
    expect(merged).toMatchObject({ success: true, merged: true, cleanup: { outcome: 'complete' } });
    expect(await pathExists(path.join(checkoutPath, 'release.txt'))).toBe(true);
    expect(await readWorktreeTargetIdentity(fx.repos.api.path)).toEqual(apiRoot);
    expect(await fx.service.get(fx.feature, fx.task)).toBeNull();
  });

  async function targetedTaskFixture() {
    const fx = await createCompositeFixture({ repoIds: ['api', 'web-ui'] });
    const repositories = Object.entries(fx.repos).map(([id, repository]) => ({ id, path: repository.path, root: repository.path }));
    const hiveDir = path.join(fx.projectRoot, '.hive');
    await new RetainedCheckoutService({ baseDir: fx.projectRoot, hiveDir, repositoryResolver: () => repositories })
      .create({ id: 'api/release', branch: 'release', baseRef: 'HEAD' });
    const statusPath = path.join(fx.projectRoot, '.hive', 'features', `01_${fx.feature}`, 'tasks', fx.task, 'status.json');
    const writeStatus = (status: unknown) => fs.writeFile(statusPath, typeof status === 'string' ? status : JSON.stringify(status));
    return { ...fx, hiveDir, writeStatus };
  }

  it('refuses to create any worker when the task status that could name a target is unreadable or malformed', async () => {
    const fx = await targetedTaskFixture();
    const placement = path.join(fx.hiveDir, '.worktrees', fx.feature, fx.task);
    for (const [status, error] of [
      ['{', /has no readable task status/],
      [{ status: 'pending', origin: 'plan', repoIds: ['api'], target: 42 }, /target must be a retained checkout ID/],
      [{ status: 'pending', origin: 'plan', repoIds: ['api'], target: 'API/release' }, /Invalid retained checkout ID "API\/release"/],
      [{ status: 'unknown', repoIds: ['api'], target: 'api/release' }, /corrupt status file/],
    ] as const) {
      await fx.writeStatus(status);
      // The manifest project's composite path would otherwise accept the task's repositories.
      await expect(fx.service.create(fx.feature, fx.task)).rejects.toThrow(error);
      expect(await pathExists(placement)).toBe(false);
    }
    await fx.writeStatus({ status: 'pending', origin: 'plan', repoIds: ['api', 'web-ui'] });
    const composite = await fx.service.create(fx.feature, fx.task);
    expect(composite).toMatchObject({ mode: 'composite' });
    // A target declared after an untargeted worker exists never integrates through that worker's destinations.
    await fx.writeStatus({ status: 'pending', origin: 'plan', repoIds: ['api'], target: 'api/release' });
    const inspected = (await fx.service.inspect(fx.feature, fx.task))!;
    const expectedTargets = Object.fromEntries(Object.entries(inspected.repos!).map(([id, repo]) => [id, repo.target!]));
    const sourceCommits = Object.fromEntries(Object.entries(inspected.repos!).map(([id, repo]) => [id, repo.commit]));
    expect(await fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source', sourceCommits, expectedTargets }))
      .toMatchObject({ success: false, reasonCode: 'WORKSPACE_TOPOLOGY_MISMATCH', error: expect.stringContaining('declares target api/release, but its worker has no targeted metadata') });
  });

  /** A plan-backed targeted task: a sync that retargets it and a reader of its stored target and worker binding. */
  async function retargetableTaskFixture() {
    const fx = await targetedTaskFixture();
    const repositories = Object.entries(fx.repos).map(([id, repository]) => ({ id, path: repository.path, root: repository.path }));
    await new RetainedCheckoutService({ baseDir: fx.projectRoot, hiveDir: fx.hiveDir, repositoryResolver: () => repositories })
      .create({ id: 'api/next', branch: 'next', baseRef: 'HEAD' });
    const featurePath = path.join(fx.hiveDir, 'features', `01_${fx.feature}`);
    // Task sync refuses a feature directory without metadata, so give the fixture a real feature.
    fsSync.writeFileSync(path.join(featurePath, 'feature.json'), JSON.stringify({ name: fx.feature, status: 'executing', createdAt: '2026-01-01T00:00:00.000Z' }));
    const writePlan = (target: string) => fsSync.writeFileSync(path.join(featurePath, 'plan.md'), `# Plan\n\n## Tasks\n\n### 1. Multi task\n\n**Repos**: api\n\n**Hive target**: ${target}\n\nShip it.\n`);
    const tasks = new TaskService(fx.projectRoot);
    writePlan('api/release');
    tasks.sync(fx.feature, { refreshPending: true });
    const sidecar = path.join(fx.hiveDir, '.worktrees', fx.feature, `${fx.task}.json`);
    const state = async () => ({
      declared: tasks.getRawStatus(fx.feature, fx.task)?.target,
      bound: await fs.readFile(sidecar, 'utf-8').then((raw) => JSON.parse(raw).target.id as string, () => null),
    });
    return { ...fx, repositories, tasks, writePlan, state, retarget: () => {
      writePlan('api/next');
      return tasks.sync(fx.feature, { refreshPending: true });
    } };
  }

  it('refuses to bind a worker to the target a concurrent task sync just replaced', async () => {
    const fx = await retargetableTaskFixture();
    const service = new CoreWorktreeService({ baseDir: fx.projectRoot, hiveDir: fx.hiveDir, repositoryResolver: { resolveRepositories: () => fx.repositories } });
    const commonDirectory = (service as any).trustedGitCommonDirectory.bind(service);
    let synced: ReturnType<typeof fx.retarget> | undefined;
    // The worker read the stored target before its operation locks; the sync lands while it waits for them.
    const spy = spyOn(service as any, 'trustedGitCommonDirectory').mockImplementation(async (repositoryPath: unknown) => {
      synced ??= fx.retarget();
      return commonDirectory(repositoryPath);
    });
    try {
      await expect(service.create(fx.feature, fx.task)).rejects.toThrow(`Task ${fx.feature}/${fx.task} now declares target api/next, not api/release`);
    } finally {
      spy.mockRestore();
    }
    expect(synced).toMatchObject({ refreshed: [fx.task] });
    expect(await fx.state()).toEqual({ declared: 'api/next', bound: null });
    expect(await pathExists(path.join(fx.hiveDir, '.worktrees', fx.feature, fx.task))).toBe(false);
    expect(await branchExists(fx.repos.api.git, `hive-targeted/task/${fx.feature}/${fx.task}`)).toBe(false);
    // Nothing is left to recover: the next create binds the current target.
    expect(await service.create(fx.feature, fx.task)).toMatchObject({ targetBinding: { id: 'api/next' } });
  }, 30_000);

  it('holds a worker placement claim off while a concurrent task sync decides to replace the task target', async () => {
    const fx = await retargetableTaskFixture();
    const coreModule = path.join(import.meta.dir, 'worktreeService.ts');
    // The worker runs in another process, between the sync's checks and its task writes. Its claim needs the
    // task-sync lock the sync holds, so it cannot bind the old target there; it times out instead of waiting forever
    // only because this sync is blocked on the worker.
    const deriveSync = (fx.tasks as any).deriveSync.bind(fx.tasks);
    let worker: { status: number | null; stderr: string } | undefined;
    const spy = spyOn(fx.tasks as any, 'deriveSync').mockImplementation((...args: unknown[]) => {
      const derived = deriveSync(...args);
      worker = spawnSync(process.execPath, ['-e', `
        const { WorktreeService } = await import(${JSON.stringify(coreModule)});
        const repositories = ${JSON.stringify(fx.repositories)};
        await new WorktreeService({ baseDir: ${JSON.stringify(fx.projectRoot)}, hiveDir: ${JSON.stringify(fx.hiveDir)}, repositoryResolver: { resolveRepositories: () => repositories } })
          .create(${JSON.stringify(fx.feature)}, ${JSON.stringify(fx.task)});
      `], { encoding: 'utf-8' });
      return derived;
    });
    let synced: ReturnType<typeof fx.retarget>;
    try {
      synced = fx.retarget();
    } finally {
      spy.mockRestore();
    }
    expect(worker?.status).not.toBe(0);
    expect(worker?.stderr).toMatch(/Failed to acquire lock .*task-sync\.json after 5000ms/);
    expect(synced).toMatchObject({ refreshed: [fx.task] });
    expect(await fx.state()).toEqual({ declared: 'api/next', bound: null });
    expect(await pathExists(path.join(fx.hiveDir, '.worktrees', fx.feature, fx.task))).toBe(false);
    expect(await branchExists(fx.repos.api.git, `hive-targeted/task/${fx.feature}/${fx.task}`)).toBe(false);
    expect(operationMarkers(fx.projectRoot)).toEqual([]);
    expect(fx.tasks.getPlanSyncStatus(fx.feature).state).toBe('current');
    expect(await fx.service.create(fx.feature, fx.task)).toMatchObject({ targetBinding: { id: 'api/next' } });
  }, 30_000);

  it('refuses to retarget a task whose worker was created through its indexed feature name', async () => {
    const fx = await retargetableTaskFixture();
    const indexed = `01_${fx.feature}`;
    const created = await fx.service.create(indexed, fx.task);
    expect(created).toMatchObject({ path: path.join(fx.hiveDir, '.worktrees', indexed, fx.task), targetBinding: { id: 'api/release' } });

    // Sync names the feature by its logical name; the worker's placement is under the indexed one.
    expect(() => fx.retarget()).toThrow(/Task sync rejected; no task files were changed\. "01-multi-task" would change its target from api\/release to api\/next/);
    expect(fx.tasks.getRawStatus(fx.feature, fx.task)?.target).toBe('api/release');
    expect(await fx.service.get(indexed, fx.task)).toMatchObject({ targetBinding: { id: 'api/release' } });
  }, 30_000);

  /**
   * The retargetable task kept only as a legacy execution/ record, which task sync does not list: the plan still names
   * it, so a sync would create its tasks/ record beside the legacy one.
   */
  async function legacyTaskFixture() {
    const fx = await retargetableTaskFixture();
    const featurePath = path.join(fx.hiveDir, 'features', `01_${fx.feature}`);
    const modernStatusPath = path.join(featurePath, 'tasks', fx.task, 'status.json');
    const legacyStatusPath = path.join(featurePath, 'execution', fx.task, 'status.json');
    await fs.mkdir(path.join(featurePath, 'execution'), { recursive: true });
    await fs.rename(path.dirname(modernStatusPath), path.dirname(legacyStatusPath));
    const legacyStatus = await fs.readFile(legacyStatusPath, 'utf-8');
    const sidecar = path.join(fx.hiveDir, '.worktrees', fx.feature, `${fx.task}.json`);
    const workerBranch = `hive-targeted/task/${fx.feature}/${fx.task}`;
    return { ...fx, modernStatusPath, legacyStatusPath, legacyStatus, sidecar, workerBranch };
  }

  it('refuses a worker claim after a concurrent task sync created a task record beside the legacy one it selected', async () => {
    const fx = await legacyTaskFixture();
    const service = new CoreWorktreeService({ baseDir: fx.projectRoot, hiveDir: fx.hiveDir, repositoryResolver: { resolveRepositories: () => fx.repositories } });
    const commonDirectory = (service as any).trustedGitCommonDirectory.bind(service);
    // A sync that moves the target, and one whose new record matches the legacy record exactly: either new record
    // would become the task's identity while the worker was bound from the legacy one.
    for (const target of ['api/next', 'api/release']) {
      let synced: ReturnType<typeof fx.tasks.sync> | undefined;
      // The worker selected the legacy record before its operation locks; the sync lands while it waits for them.
      const spy = spyOn(service as any, 'trustedGitCommonDirectory').mockImplementation(async (repositoryPath: unknown) => {
        if (synced === undefined) {
          fx.writePlan(target);
          synced = fx.tasks.sync(fx.feature, { refreshPending: true });
        }
        return commonDirectory(repositoryPath);
      });
      try {
        await expect(service.create(fx.feature, fx.task)).rejects.toThrow(`Task ${fx.feature}/${fx.task} status now resolves to ${fx.modernStatusPath}, not ${fx.legacyStatusPath}`);
      } finally {
        spy.mockRestore();
      }
      expect(synced).toMatchObject({ created: [fx.task] });
      expect(fx.tasks.getRawStatus(fx.feature, fx.task)?.target).toBe(target);
      expect(await pathExists(fx.sidecar)).toBe(false);
      expect(await branchExists(fx.repos.api.git, fx.workerBranch)).toBe(false);
      expect(operationMarkers(fx.projectRoot)).toEqual([]);
      expect(await fs.readFile(fx.legacyStatusPath, 'utf-8')).toBe(fx.legacyStatus);
      // Start the next round from the legacy record alone.
      await fs.rm(path.dirname(fx.modernStatusPath), { recursive: true });
    }
    // Once the task has its tasks/ record, the next create binds the record it resolves to.
    fx.writePlan('api/next');
    expect(fx.tasks.sync(fx.feature, { refreshPending: true })).toMatchObject({ created: [fx.task] });
    expect(await service.create(fx.feature, fx.task)).toMatchObject({ targetBinding: { id: 'api/next' } });
  }, 30_000);

  it('refuses to create a task record over a worker claimed from the legacy record', async () => {
    const fx = await legacyTaskFixture();
    expect(await fx.service.create(fx.feature, fx.task)).toMatchObject({ targetBinding: { id: 'api/release' } });

    // A plan that moves the target and one that matches the legacy record would both give the task a new record.
    for (const target of ['api/next', 'api/release']) {
      fx.writePlan(target);
      expect(() => fx.tasks.sync(fx.feature, { refreshPending: true }))
        .toThrow(/Task sync rejected; no task files were changed\. Task "01-multi-task" has no record under tasks\/, but a worker placement or binding/);
      expect(await pathExists(fx.modernStatusPath)).toBe(false);
    }
    expect(() => fx.tasks.create(fx.feature, 'Multi task')).toThrow(/Manual task creation rejected; no task files were changed\. Task "01-multi-task"/);
    expect(await pathExists(fx.modernStatusPath)).toBe(false);
    expect(await fs.readFile(fx.legacyStatusPath, 'utf-8')).toBe(fx.legacyStatus);
    expect(await fx.service.get(fx.feature, fx.task)).toMatchObject({ targetBinding: { id: 'api/release' } });

    // Once that worker is gone, sync gives the task its tasks/ record as for any legacy-only feature.
    expect((await fx.service.remove(fx.feature, fx.task, true)).cleanup.outcome).toBe('complete');
    expect(fx.tasks.sync(fx.feature, { refreshPending: true })).toMatchObject({ created: [fx.task] });
  }, 30_000);

  it('keeps a concurrent task sync from publishing a task record while a worker claims the legacy record', async () => {
    const fx = await legacyTaskFixture();
    fx.writePlan('api/next');
    const taskModule = path.join(import.meta.dir, 'taskService.ts');
    const taskSyncPath = path.join(path.dirname(path.dirname(path.dirname(fx.legacyStatusPath))), 'task-sync.json');
    const publishTaskPlacement = (fx.service as any).publishTaskPlacement.bind(fx.service);
    const observed: string[] = [];
    let sync: { status: number | null; stderr: string } | undefined;
    // While the claim publishes the worker's binding, a sync in another process tries to create the task's record.
    const spy = spyOn(fx.service as any, 'publishTaskPlacement').mockImplementation(async (...args: any[]) => {
      const [owner, step, statusPath, admit, publish] = args;
      return publishTaskPlacement(owner, step, statusPath, admit, () => {
        publish();
        observed.push(`published: task-sync lock ${probeLock(taskSyncPath)}, status lock ${probeLock(fx.legacyStatusPath)}`);
        sync = spawnSync(process.execPath, ['-e', `
          const { TaskService } = await import(${JSON.stringify(taskModule)});
          new TaskService(${JSON.stringify(fx.projectRoot)}).sync(${JSON.stringify(fx.feature)}, { refreshPending: true });
        `], { encoding: 'utf-8' });
      });
    });
    try {
      expect(await fx.service.create(fx.feature, fx.task)).toMatchObject({ targetBinding: { id: 'api/release' } });
    } finally {
      spy.mockRestore();
    }
    expect(observed).toEqual(['published: task-sync lock held, status lock held']);
    expect(sync?.status).not.toBe(0);
    expect(sync?.stderr).toMatch(/Failed to acquire lock .*task-sync\.json after 5000ms/);
    expect(await pathExists(fx.modernStatusPath)).toBe(false);
    // After the claim, the sync finds the worker's binding and refuses instead of hiding the record it was bound from.
    expect(() => fx.tasks.sync(fx.feature, { refreshPending: true })).toThrow(/Task "01-multi-task" has no record under tasks\//);
    expect(await pathExists(fx.modernStatusPath)).toBe(false);
    expect(await fs.readFile(fx.legacyStatusPath, 'utf-8')).toBe(fx.legacyStatus);
  }, 30_000);

  it('keeps a same-branch checkout another Git client attached at a targeted worker placement until it is gone', async () => {
    const fx = await targetedTaskFixture();
    await fx.writeStatus({ status: 'pending', origin: 'plan', repoIds: ['api'], target: 'api/release' });
    const api = fx.repos.api;
    const placement = path.join(fx.hiveDir, '.worktrees', fx.feature, fx.task);
    const sidecar = `${placement}.json`;
    const branch = `hive-targeted/task/${fx.feature}/${fx.task}`;
    const base = (await api.git.revparse(['HEAD'])).trim();

    // A create whose confirming write fails rolls its own worker and binding back completely.
    const confirming = failMetadataWrite(sidecar, { confirming: true });
    try {
      await expect(fx.service.create(fx.feature, fx.task)).rejects.toThrow(/simulated metadata write failure/);
    } finally {
      confirming.mockRestore();
    }
    expect([await pathExists(placement), await pathExists(sidecar), await branchExists(api.git, branch)]).toEqual([false, false, false]);
    expect(operationMarkers(fx.projectRoot)).toEqual([]);

    // Once the create has begun and is binding the worker, another Git client creates the worker branch with its own
    // checkout at the placement, so the create's `worktree add -b` fails.
    const publishTaskPlacement = (fx.service as any).publishTaskPlacement.bind(fx.service);
    let attached = false;
    const spy = spyOn(fx.service as any, 'publishTaskPlacement').mockImplementation(async (...args: unknown[]) => {
      if (!attached && operationMarkers(fx.projectRoot).length > 0) {
        attached = true;
        await api.git.raw(['worktree', 'add', '-b', branch, '--', placement, base]);
        await ignoreInRepository(api.path, 'payload.local');
        await fs.writeFile(path.join(placement, 'payload.local'), 'foreign ignored payload\n');
      }
      return publishTaskPlacement(...args);
    });
    let failure: unknown;
    try {
      failure = await fx.service.create(fx.feature, fx.task).catch((error) => error);
    } finally {
      spy.mockRestore();
    }
    expect(attached).toBe(true);
    expect(failure).toBeInstanceOf(WorktreeOperationRecoveryRequiredError);
    expect((failure as Error).message).toMatch(/its metadata .* is kept unconfirmed/);
    expect(JSON.parse(await fs.readFile(sidecar, 'utf-8'))).toMatchObject({ branch, createUnconfirmed: true });

    const repositories = Object.entries(fx.repos).map(([id, repo]) => ({ id, path: repo.path, root: repo.path }));
    await acknowledgePendingOperations(new WorktreeOperationRecoveryService({ baseDir: fx.projectRoot, hiveDir: fx.hiveDir, repositoryResolver: () => repositories }));
    const kept = await fx.service.remove(fx.feature, fx.task, true);
    expect(kept.cleanup.worktreeRemoval).toMatchObject({ status: 'failed', error: expect.stringMatching(/holds changed, untracked or ignored files: .*createUnconfirmed/) });
    expect(await fs.readFile(path.join(placement, 'payload.local'), 'utf-8')).toBe('foreign ignored payload\n');
    expect(await pathExists(sidecar)).toBe(true);
    await expect(fx.service.create(fx.feature, fx.task)).rejects.toThrow(/never confirmed it \(createUnconfirmed in /);

    await api.git.raw(['worktree', 'remove', placement]);
    expect((await fx.service.remove(fx.feature, fx.task, true)).cleanup.outcome).toBe('complete');
    expect([await pathExists(sidecar), await branchExists(api.git, branch)]).toEqual([false, false]);
    const created = await fx.service.create(fx.feature, fx.task);
    expect(JSON.parse(await fs.readFile(sidecar, 'utf-8')).createUnconfirmed).toBeUndefined();

    // Only true marks a binding unconfirmed; any other value is a damaged record.
    const record = JSON.parse(await fs.readFile(sidecar, 'utf-8'));
    await fs.writeFile(sidecar, JSON.stringify({ ...record, createUnconfirmed: false }));
    await expect(fx.service.get(fx.feature, fx.task)).rejects.toThrow(/Invalid targeted workspace metadata/);
    await fs.writeFile(sidecar, JSON.stringify(record));

    await fs.writeFile(path.join(created.path, 'payload.local'), 'generated output\n');
    expect((await fx.service.remove(fx.feature, fx.task, true)).cleanup.outcome).toBe('complete');
    expect(await pathExists(placement)).toBe(false);
  }, 30_000);

  it('refuses a targeted worker whose task status no longer names its binding', async () => {
    const fx = await targetedTaskFixture();
    await fx.writeStatus({ status: 'pending', origin: 'plan', repoIds: ['api'], target: 'api/release' });
    const created = await fx.service.create(fx.feature, fx.task);
    const inspected = (await fx.service.inspect(fx.feature, fx.task))!;
    const merge = () => fx.service.merge(fx.feature, fx.task, 'merge', mergeMessage, { historyIntent: 'preserve-source', sourceCommit: created.commit, expectedTarget: inspected.target! });

    await fx.writeStatus({ status: 'pending', origin: 'plan', repoIds: ['api'] });
    await expect(fx.service.create(fx.feature, fx.task)).rejects.toThrow('declares target (none), but its worker is bound to api/release');
    expect(await merge()).toMatchObject({ success: false, reasonCode: 'WORKSPACE_TOPOLOGY_MISMATCH', error: expect.stringContaining('is bound to api/release') });
    await fx.writeStatus({ status: 'pending', origin: 'plan', repoIds: ['api'], target: 'api/other' });
    await expect(fx.service.create(fx.feature, fx.task)).rejects.toThrow('already targets api/release, not api/other');
    expect(await merge()).toMatchObject({ success: false, error: expect.stringContaining('declares target api/other') });
    await fx.writeStatus('{');
    expect(await merge()).toMatchObject({ success: false, error: expect.stringContaining('has no readable task status') });

    await fx.writeStatus({ status: 'pending', origin: 'plan', repoIds: ['api'], target: 'api/release' });
    expect(await merge()).toMatchObject({ success: true, reasonCode: 'ALREADY_INTEGRATED' });
  });
});

describe('WorktreeService integration receipts', () => {
  it('records the task and integrator for a preserve-source merge with no replaced links, and writes nothing for a repeat', async () => {
    const fixture = await createCommittedFixture();
    const hiveDir = path.join(fixture.repoPath, '.hive');
    const receiptsDir = path.join(hiveDir, 'provenance', 'integrations');
    const sourceCommit = (await simpleGit(fixture.worktreePath).revparse(['HEAD'])).trim();
    // A receipt already keyed by the source commit stays reachable through a normal merge, so it is not linked.
    await recordIntegrationReceipt(hiveDir, { git: fixture.repoGit, before: sourceCommit, after: sourceCommit, source: sourceCommit, targetRef: null, strategy: 'merge' }, { kind: 'adhoc', runId: 'upstream' });
    const integratedBy = { owner: 'opencode-v2' as const, sessionId: 'ses_swarm', agent: 'swarm-orchestrator' };

    const merged = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source', integratedBy });
    expect(merged).toMatchObject({ success: true, merged: true, action: 'none', provenance: { status: 'recorded' } });
    expect(JSON.parse(await fs.readFile(path.join(receiptsDir, `${merged.sha}.json`), 'utf8'))).toMatchObject({
      after: merged.sha,
      source: sourceCommit,
      targetRef: 'refs/heads/main',
      strategy: 'merge',
      origins: [{ kind: 'task', feature: fixture.feature, task: fixture.task }],
      integratedBy,
    });
    expect(JSON.parse(await fs.readFile(path.join(receiptsDir, `${merged.sha}.json`), 'utf8'))).not.toHaveProperty('replaced');
    const recorded = (await fs.readdir(receiptsDir)).sort();

    const repeat = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source', integratedBy });
    expect(repeat).toMatchObject({ success: true, merged: false, reasonCode: 'ALREADY_INTEGRATED' });
    expect(repeat.provenance).toBeUndefined();
    expect((await fs.readdir(receiptsDir)).sort()).toEqual(recorded);
  });

  it('keeps the merged commit and reports provenance failed when the recorder rejects with an unprintable value', async () => {
    const fixture = await createCommittedFixture();
    // Every production route builds its recorder through taskRecorder; replace it with one that throws a null-prototype object.
    (fixture.service as unknown as { taskRecorder: () => () => Promise<never> }).taskRecorder = () => async () => {
      throw Object.create(null);
    };

    const merged = await fixture.service.merge(fixture.feature, fixture.task, 'merge', mergeMessage, { historyIntent: 'preserve-source', cleanup: 'worktree+branch' });

    expect(merged).toMatchObject({ success: true, merged: true, action: 'inspect_state', provenance: { status: 'failed', error: 'unprintable error value' } });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(merged.sha);
    expect(merged.cleanup.worktreeRemoval.status).toBe('not_attempted');
  });
});
