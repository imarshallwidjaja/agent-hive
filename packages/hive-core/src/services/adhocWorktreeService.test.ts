import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import simpleGit, { type SimpleGit } from "simple-git";
import { AdhocWorktreeService } from "./adhocWorktreeService";

interface AdhocFixture {
  repoPath: string;
  hiveDir: string;
  service: AdhocWorktreeService;
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
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "hive-core-adhoc-worktree-test-"));
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

async function createFixture(): Promise<AdhocFixture> {
  const { repoPath, repoGit } = await createTempRepo();
  const hiveDir = path.join(repoPath, ".hive");
  const service = new AdhocWorktreeService({ baseDir: repoPath, hiveDir });
  return { repoPath, hiveDir, service, repoGit };
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

describe("AdhocWorktreeService.create", () => {
  it("creates worktree at .hive/.worktrees/adhoc/<runId> and branch hive/adhoc/<runId>", async () => {
    const fixture = await createFixture();

    const result = await fixture.service.create();

    expect(result.runId).toBeTruthy();
    expect(result.path).toBe(
      path.join(fixture.hiveDir, ".worktrees", "adhoc", result.runId),
    );
    expect(result.branch).toBe(`hive/adhoc/${result.runId}`);
    expect(await pathExists(result.path)).toBe(true);
    expect(await branchExists(fixture.repoGit, result.branch)).toBe(true);
  });

  it("does not create .hive/features", async () => {
    const fixture = await createFixture();

    await fixture.service.create();

    expect(await pathExists(path.join(fixture.hiveDir, "features"))).toBe(false);
  });

  it("returns the existing worktree when the same safe explicit runId is provided", async () => {
    const fixture = await createFixture();

    const first = await fixture.service.create({ runId: "safe-run-id" });
    const second = await fixture.service.create({ runId: "safe-run-id" });

    expect(second.runId).toBe("safe-run-id");
    expect(second.path).toBe(first.path);
    expect(second.branch).toBe(first.branch);
  });

  it("generates unique runIds across calls with no explicit runId", async () => {
    const fixture = await createFixture();

    const first = await fixture.service.create();
    const second = await fixture.service.create();

    expect(second.runId).not.toBe(first.runId);
    expect(second.path).not.toBe(first.path);
  });

  it("rejects unsafe runId values containing path separators or invalid characters", async () => {
    const fixture = await createFixture();

    await expect(fixture.service.create({ runId: "../escape" })).rejects.toThrow();
    await expect(fixture.service.create({ runId: "with/slash" })).rejects.toThrow();
    await expect(fixture.service.create({ runId: "with space" })).rejects.toThrow();
    await expect(fixture.service.create({ runId: "" })).rejects.toThrow();
  });

  it("returns a structured failure when the branch exists but the worktree path does not", async () => {
    const fixture = await createFixture();

    // Pre-create a branch that would collide with the generated branch.
    const runId = "collide-id";
    await fixture.repoGit.raw(["branch", `hive/adhoc/${runId}`]);

    await expect(fixture.service.create({ runId })).rejects.toThrow(/collision|exists/i);

    // Did not overwrite/create the worktree directory.
    expect(
      await pathExists(path.join(fixture.hiveDir, ".worktrees", "adhoc", runId)),
    ).toBe(false);
  });

  it("rejects an explicit runId when the path is an unrelated git repository", async () => {
    const fixture = await createFixture();
    const runId = "stale-run";
    const stalePath = path.join(fixture.hiveDir, ".worktrees", "adhoc", runId);

    await fs.mkdir(stalePath, { recursive: true });

    await expect(fixture.service.create({ runId })).rejects.toThrow(
      /without matching branch/i,
    );
  });

  it("rejects an explicit runId when path and branch exist but are not the same worktree", async () => {
    const fixture = await createFixture();
    const runId = "wrong-worktree";
    const stalePath = path.join(fixture.hiveDir, ".worktrees", "adhoc", runId);

    await fixture.repoGit.raw(["branch", `hive/adhoc/${runId}`]);
    await fs.mkdir(stalePath, { recursive: true });

    await expect(fixture.service.create({ runId })).rejects.toThrow(
      /do not match the requested ad-hoc worktree/i,
    );
  });

  it("rejects an explicit runId when an unrelated repo has the matching branch name", async () => {
    const fixture = await createFixture();
    const runId = "stale-matching-branch";
    const branchName = `hive/adhoc/${runId}`;
    const stalePath = path.join(fixture.hiveDir, ".worktrees", "adhoc", runId);

    await fixture.repoGit.raw(["branch", branchName]);
    await fs.mkdir(stalePath, { recursive: true });
    const staleGit = simpleGit(stalePath);
    await staleGit.raw(["init"]);
    await staleGit.raw(["config", "user.email", "test@example.com"]);
    await staleGit.raw(["config", "user.name", "Test User"]);
    await fs.writeFile(path.join(stalePath, "stale.txt"), "stale\n", "utf-8");
    await staleGit.add("stale.txt");
    await staleGit.commit("chore: stale repo");
    await staleGit.raw(["branch", "-M", branchName]);

    await expect(fixture.service.create({ runId })).rejects.toThrow(
      /do not match the requested ad-hoc worktree/i,
    );
  });
});

describe("AdhocWorktreeService.commit", () => {
  it("stages all changes, uses the provided commit message verbatim, and returns committed=true with sha", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "commit-run" });

    await fs.writeFile(path.join(created.path, "new-file.txt"), "hello\n", "utf-8");

    const message = "feat(adhoc): subject line\n\nbody line 1\nbody line 2";
    const result = await fixture.service.commit(created.runId, message);

    expect(result.committed).toBe(true);
    expect(result.sha).toBeTruthy();
    expect(result.message).toBe(message);
    expect(await readHeadBody(created.path)).toBe(message);
  });
});

describe("AdhocWorktreeService.merge", () => {
  it("supports default merge and returns cleanup flags=false when cleanup is not requested", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "merge-run" });
    await fs.writeFile(path.join(created.path, "merge-file.txt"), "hi\n", "utf-8");
    await fixture.service.commit(created.runId, "chore: merge content");

    await fixture.repoGit.checkout("main");

    const result = await fixture.service.merge(created.runId);

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.strategy).toBe("merge");
    expect(result.conflictState).toBe("none");
    expect(result.cleanup).toEqual({
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
    });
    expect(await pathExists(created.path)).toBe(true);
    expect(await branchExists(fixture.repoGit, created.branch)).toBe(true);
  });

  it("with cleanup: 'worktree+branch' removes worktree and deletes the ad-hoc branch", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "merge-cleanup-run" });
    await fs.writeFile(path.join(created.path, "merge-file.txt"), "hi\n", "utf-8");
    await fixture.service.commit(created.runId, "chore: merge content");

    await fixture.repoGit.checkout("main");

    const result = await fixture.service.merge(created.runId, "merge", undefined, {
      cleanup: "worktree+branch",
    });

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.cleanup.worktreeRemoved).toBe(true);
    expect(result.cleanup.branchDeleted).toBe(true);
    expect(await pathExists(created.path)).toBe(false);
    expect(await branchExists(fixture.repoGit, created.branch)).toBe(false);
  });

  it("returns an error for strategy: 'rebase' with a custom message", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "merge-rebase-run" });

    const result = await fixture.service.merge(created.runId, "rebase", "custom rebase msg");

    expect(result.success).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.strategy).toBe("rebase");
    expect(result.error).toBeTruthy();
  });
});
