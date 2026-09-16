import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import simpleGit, { type SimpleGit } from "simple-git";
import type { ResolvedRepository } from "../types";
import { AdhocWorktreeService } from "./adhocWorktreeService";
import type { AdhocMergeResult } from "./adhocWorktreeService";
import { WorktreeLinkageError } from "./worktreeOutcome";

interface AdhocFixture {
  repoPath: string;
  hiveDir: string;
  service: AdhocWorktreeService;
  repoGit: SimpleGit;
}

const tempDirs: string[] = [];
const mergeMessage = 'feat: integrate ad-hoc work\n\nIntegrate the verified ad-hoc implementation into project history.';
const testCommitMessage = (subject: string): string => `${subject}\n\nCreate test fixture history with a descriptive body.`;

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

  // Nested worktrees under .hive/ appear as untracked without this ignore.
  await fs.writeFile(path.join(repoPath, ".gitignore"), ".hive/\n", "utf-8");
  await fs.writeFile(path.join(repoPath, "tracked.txt"), "base\n", "utf-8");
  await repoGit.add([".gitignore", "tracked.txt"]);
  await repoGit.commit("chore: base commit");

  return { repoPath, repoGit };
}

async function createFixture(): Promise<AdhocFixture> {
  const { repoPath, repoGit } = await createTempRepo();
  const hiveDir = path.join(repoPath, ".hive");
  const service = new AdhocWorktreeService({ baseDir: repoPath, hiveDir });
  return { repoPath, hiveDir, service, repoGit };
}

async function commitAdhocChanges(
  service: AdhocWorktreeService,
  runId: string,
  message: string,
): Promise<{ committed: boolean; sha: string; message: string; repos?: Record<string, { committed: boolean; sha: string }> }> {
  const worktree = await service.get(runId);
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
    await git.add('-A');
    await git.commit(message);
    results[id] = { committed: true, sha: (await git.revparse(['HEAD'])).trim() };
  }
  const first = Object.values(results)[0]!;
  return {
    committed: Object.values(results).some(result => result.committed),
    sha: first.sha,
    message,
    ...(worktree.repos ? { repos: results } : {}),
  };
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

describe("AdhocWorktreeService.create", () => {
  it("creates worktree at .hive/.worktrees/adhoc/<runId> and branch hive/adhoc/<runId>", async () => {
    const fixture = await createFixture();

    const result = await fixture.service.create();

    expect(result.runId).toBeTruthy();
    expect(result.path).toBe(
      path.join(fixture.hiveDir, ".worktrees", "adhoc", result.runId),
    );
    expect(result.branch).toBe(`hive/adhoc/${result.runId}`);
    expect(result.commit).toBe((await fixture.repoGit.revparse(['HEAD'])).trim());
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

describe("AdhocWorktreeService.merge", () => {
  it("defaults to squash merge and returns cleanup flags=false when cleanup is not requested", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "merge-run" });
    await fs.writeFile(path.join(created.path, "merge-file.txt"), "hi\n", "utf-8");
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('chore: merge content'));

    await fixture.repoGit.checkout("main");

    const result = await fixture.service.merge(
      created.runId,
      undefined,
      'feat: integrate ad-hoc work\n\nIntegrate the verified ad-hoc implementation as one commit.',
    );

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.strategy).toBe("squash");
    expect(await readHeadBody(fixture.repoPath)).toBe(
      'feat: integrate ad-hoc work\n\nIntegrate the verified ad-hoc implementation as one commit.',
    );
    expect(result.conflictState).toBe("none");
    expect(result.cleanup).toMatchObject({
      requested: 'none',
      outcome: 'not_requested',
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
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('chore: merge content'));

    await fixture.repoGit.checkout("main");

    const result = await fixture.service.merge(created.runId, "merge", mergeMessage, {
      cleanup: "worktree+branch",
    });

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.cleanup.worktreeRemoved).toBe(true);
    expect(result.cleanup.branchDeleted).toBe(true);
    expect(await pathExists(created.path)).toBe(false);
    expect(await branchExists(fixture.repoGit, created.branch)).toBe(false);
  });

  it('returns NO_TRACKED_CHANGES for divergent histories with identical endpoint trees and leaves target HEAD untouched', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'merge-converged-trees' });
    const worktreeGit = simpleGit(created.path);
    await fs.writeFile(path.join(created.path, 'tracked.txt'), 'branch-path\n', 'utf-8');
    await worktreeGit.add('-A');
    await worktreeGit.commit(testCommitMessage('feat: branch intermediate'));
    await fs.writeFile(path.join(created.path, 'tracked.txt'), 'converged\n', 'utf-8');
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

    const result = await fixture.service.merge(created.runId, 'merge', mergeMessage);

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
  // comparison: a target that advanced independently after the ad-hoc branch
  // forked contributes its own files to `git diff <start> <branch>`, and those
  // must not appear in `filesChanged`.
  for (const strategy of ["squash", "merge", "rebase"] as const) {
    it(`reports only integration paths in filesChanged for ${strategy} when the target advanced independently`, async () => {
      const fixture = await createFixture();
      const created = await fixture.service.create({ runId: `target-advanced-${strategy}` });
      await fs.writeFile(path.join(created.path, "adhoc-only.txt"), "from ad-hoc branch\n", "utf-8");
      await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: ad-hoc-only change'));

      await fixture.repoGit.checkout("main");
      await fs.writeFile(path.join(fixture.repoPath, "main-only.txt"), "from main after fork\n", "utf-8");
      await fixture.repoGit.add("-A");
      await fixture.repoGit.commit(testCommitMessage("feat: independent target advance"));
      const beforeHead = (await fixture.repoGit.revparse(["HEAD"])).trim();
      const endpointDiff = (
        await fixture.repoGit.diff([beforeHead, created.branch, "--name-only"])
      ).split("\n").map((line) => line.trim()).filter(Boolean);

      // Sanity: the pre-merge endpoint comparison does see the target-only file.
      expect(endpointDiff).toContain("main-only.txt");
      expect(endpointDiff).toContain("adhoc-only.txt");

      const result = await fixture.service.merge(created.runId, strategy, strategy === "rebase" ? undefined : mergeMessage);

      expect(result).toMatchObject({
        success: true,
        merged: true,
        strategy,
        mutation: "applied",
        retryable: false,
        action: "none",
      });
      expect(result.sha).toBeTruthy();
      expect(result.filesChanged).toEqual(["adhoc-only.txt"]);
      expect(result.filesChanged).not.toContain("main-only.txt");

      const observed = (
        await fixture.repoGit.diff([beforeHead, result.sha!, "--name-only"])
      ).split("\n").map((line) => line.trim()).filter(Boolean);
      expect(result.filesChanged).toEqual(observed);
      expect(await pathExists(path.join(fixture.repoPath, "adhoc-only.txt"))).toBe(true);
      expect(await pathExists(path.join(fixture.repoPath, "main-only.txt"))).toBe(true);
    });
  }

  it("does not report merged=true when rebase applies no source commits", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "rebase-no-applicable-commits" });
    // Source branch carries a commit whose net tracked change already exists on
    // main, so the endpoint trees match and nothing is applicable.
    await fs.writeFile(path.join(created.path, "tracked.txt"), "already on main\n", "utf-8");
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: converges with target'));

    await fixture.repoGit.checkout("main");
    await fs.writeFile(path.join(fixture.repoPath, "tracked.txt"), "already on main\n", "utf-8");
    await fixture.repoGit.add("-A");
    await fixture.repoGit.commit(testCommitMessage('feat: target already contains the change'));
    const beforeHead = (await fixture.repoGit.revparse(["HEAD"])).trim();

    const result = await fixture.service.merge(created.runId, "rebase");

    expect(result).toMatchObject({
      success: true,
      merged: false,
      reasonCode: "NO_TRACKED_CHANGES",
      filesChanged: [],
      mutation: "none",
      retryable: false,
      action: "none",
    });
    expect("sha" in result).toBe(false);
    expect((await fixture.repoGit.revparse(["HEAD"])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it("classifies a dirty target as TARGET_DIRTY without mutating anything", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "dirty-target-classification" });
    await fs.writeFile(path.join(created.path, "adhoc-file.txt"), "content\n", "utf-8");
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: ad-hoc change'));

    await fixture.repoGit.checkout("main");
    const dirtyPath = path.join(fixture.repoPath, "user-note.txt");
    await fs.writeFile(dirtyPath, "untracked user content\n", "utf-8");
    const beforeHead = (await fixture.repoGit.revparse(["HEAD"])).trim();

    const result = await fixture.service.merge(created.runId, "squash", mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      reasonCode: "TARGET_DIRTY",
      phase: "preflight",
      mutation: "none",
      retryable: true,
      action: "clean_target",
      filesChanged: [],
      conflicts: [],
    });
    expect((await fixture.repoGit.revparse(["HEAD"])).trim()).toBe(beforeHead);
    expect(await fs.readFile(dirtyPath, "utf-8")).toBe("untracked user content\n");
  });

  it("classifies an active Git operation as GIT_OPERATION_IN_PROGRESS", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "active-state-classification" });
    await fs.writeFile(path.join(created.path, "adhoc-file.txt"), "content\n", "utf-8");
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: ad-hoc change'));

    await fixture.repoGit.checkout("main");
    await fs.writeFile(path.join(fixture.repoPath, ".git", "MERGE_HEAD"), "deadbeef\n", "utf-8");
    const beforeHead = (await fixture.repoGit.revparse(["HEAD"])).trim();

    const result = await fixture.service.merge(created.runId, "squash", mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      reasonCode: "GIT_OPERATION_IN_PROGRESS",
      phase: "preflight",
      mutation: "none",
      retryable: false,
      action: "inspect_state",
    });
    expect((await fixture.repoGit.revparse(["HEAD"])).trim()).toBe(beforeHead);
    expect(await branchExists(fixture.repoGit, created.branch)).toBe(true);
  });

  it("returns a cleanup-eligible no-op when an ad-hoc branch has commits but zero tracked diff", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "merge-no-change-run" });
    await fs.writeFile(path.join(created.path, "tracked.txt"), "transient ad-hoc change\n", "utf-8");
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('chore: transient ad-hoc change'));
    await fs.writeFile(path.join(created.path, "tracked.txt"), "base\n", "utf-8");
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('revert: transient ad-hoc change'));
    await fixture.repoGit.checkout("main");
    const beforeHead = (await fixture.repoGit.revparse(["HEAD"])).trim();

    const result = await fixture.service.merge(created.runId, "squash", undefined, {
      cleanup: "worktree+branch",
    });

    expect(result).toMatchObject({
      success: true,
      merged: false,
      strategy: "squash",
      reason: "nothing_to_merge",
      reasonCode: "NO_TRACKED_CHANGES",
      filesChanged: [],
      conflicts: [],
      conflictState: "none",
      cleanupEligible: true,
      cleanup: {
        worktreeRemoved: true,
        branchDeleted: true,
        pruned: true,
      },
    });
    expect("sha" in result).toBe(false);
    expect((await fixture.repoGit.revparse(["HEAD"])).trim()).toBe(beforeHead);
    expect(await pathExists(created.path)).toBe(false);
    expect(await branchExists(fixture.repoGit, created.branch)).toBe(false);
  });

  for (const { stateName, label } of [
    { stateName: "MERGE_HEAD", label: "merge" },
    { stateName: "rebase-merge", label: "rebase" },
    { stateName: "CHERRY_PICK_HEAD", label: "cherry-pick" },
  ] as const) {
    it(`fails safely when a net-zero ad-hoc merge sees active ${label} state`, async () => {
      const fixture = await createFixture();
      const created = await fixture.service.create({ runId: `merge-active-${label}` });
      await fs.writeFile(path.join(created.path, "tracked.txt"), "transient ad-hoc change\n", "utf-8");
      await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('chore: transient ad-hoc change'));
      await fs.writeFile(path.join(created.path, "tracked.txt"), "base\n", "utf-8");
      await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('revert: transient ad-hoc change'));
      await fixture.repoGit.checkout("main");
      await fs.writeFile(path.join(fixture.repoPath, ".git", stateName), "deadbeef\n", "utf-8");

      const result = await fixture.service.merge(created.runId, "squash", undefined, {
        cleanup: "worktree+branch",
      });

      expect(result).toMatchObject({
        success: false,
        merged: false,
        strategy: "squash",
        filesChanged: [],
        conflicts: [],
        conflictState: "none",
        cleanup: {
          worktreeRemoved: false,
          branchDeleted: false,
          pruned: false,
        },
      });
      expect(result.error).toMatch(new RegExp(`active ${label} state`, "i"));
      expect(await pathExists(created.path)).toBe(true);
      expect(await branchExists(fixture.repoGit, created.branch)).toBe(true);
    });
  }

  it("returns an error for strategy: 'rebase' with a custom message", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "merge-rebase-run" });

    const result = await fixture.service.merge(created.runId, "rebase", "custom rebase msg");

    expect(result.success).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.strategy).toBe("rebase");
    expect(result.error).toBeTruthy();
  });

  it('rejects malformed source commits before normal merge mutates the target', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'invalid-source-merge' });
    const worktreeGit = simpleGit(created.path);
    await fs.writeFile(path.join(created.path, 'bad-source.txt'), 'bad\n', 'utf-8');
    await worktreeGit.add('-A');
    await worktreeGit.commit('subject only');
    await fixture.repoGit.checkout('main');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(
      created.runId,
      'merge',
      'feat: merge structured history\n\nPreserve independently valuable source commits.',
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/source commit.*subject.*blank line.*body/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('rejects a malformed later source commit before rebase mutates the target', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'invalid-later-source-rebase' });
    const worktreeGit = simpleGit(created.path);
    await fs.writeFile(path.join(created.path, 'valid-source.txt'), 'good\n', 'utf-8');
    await worktreeGit.add('-A');
    await worktreeGit.commit(testCommitMessage('feat: valid first ad-hoc source commit'));
    await fs.writeFile(path.join(created.path, 'malformed-source.txt'), 'bad\n', 'utf-8');
    await worktreeGit.add('-A');
    await worktreeGit.raw(['commit', '-m', 'subject line\ncontinued subject\n\nDescriptive body.']);
    const malformedHead = (await worktreeGit.revparse(['HEAD'])).trim();
    await fixture.repoGit.checkout('main');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(created.runId, 'rebase');

    expect(result.success).toBe(false);
    expect(result.error).toContain(malformedHead.slice(0, 7));
    expect(result.error).toMatch(/source commit.*subject.*blank line.*body/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('restores the target after a squash conflict', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'squash-conflict' });
    await fs.writeFile(path.join(created.path, 'tracked.txt'), 'task side\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: conflicting ad-hoc source'));
    await fs.writeFile(path.join(fixture.repoPath, 'tracked.txt'), 'main side\n', 'utf-8');
    await fixture.repoGit.add('-A');
    await fixture.repoGit.commit(testCommitMessage('feat: conflicting ad-hoc target'));
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(created.runId, 'squash', mergeMessage);

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
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'squash-hook-failure' });
    await fs.writeFile(path.join(created.path, 'new-file.txt'), 'new\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: ad-hoc source change'));
    const hookPath = path.join(fixture.repoPath, '.git', 'hooks', 'prepare-commit-msg');
    await fs.writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf-8');
    await fs.chmod(hookPath, 0o755);
    await fixture.repoGit.raw(['config', 'core.hooksPath', path.dirname(hookPath)]);
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(created.runId, 'squash', mergeMessage);

    expect(result.success).toBe(false);
    expect(result.merged).toBe(false);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  for (const strategy of ['squash', 'merge'] as const) {
    it(`removes an invalid ${strategy} aggregate commit rewritten by a hook`, async () => {
      const fixture = await createFixture();
      const created = await fixture.service.create({ runId: `hook-rewritten-${strategy}` });
      await fs.writeFile(path.join(created.path, 'new-file.txt'), 'new\n', 'utf-8');
      await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: ad-hoc source change'));
      const hookBody = strategy === 'squash'
        ? `printf '%s\\n' 'subject only' > "$1"`
        : `printf '%s\\n' 'subject line' 'continued subject' '' 'Descriptive body.' > "$1"`;
      await installPrepareCommitMessageHook(fixture.repoPath, hookBody);
      const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

      const result = await fixture.service.merge(created.runId, strategy, mergeMessage);

      expect(result.success).toBe(false);
      expect(result.merged).toBe(false);
      expect(result.error).toMatch(/subject.*blank line.*body/i);
      expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
      expect((await fixture.repoGit.status()).isClean()).toBe(true);
    });
  }

  it('removes an invalid cherry-picked commit rewritten by a hook', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'hook-rewritten-rebase' });
    await fs.writeFile(path.join(created.path, 'new-file.txt'), 'new\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: ad-hoc source change'));
    await installPrepareCommitMessageHook(fixture.repoPath, `printf '%s\\n' 'subject only' > "$1"`);
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(created.runId, 'rebase');

    expect(result.success).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.error).toMatch(/subject.*blank line.*body/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('does not preserve a hook failure merely because its error mentions conflict', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'hook-conflict-sentinel' });
    await fs.writeFile(path.join(created.path, 'new-file.txt'), 'new\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: ad-hoc source change'));
    await installPrepareCommitMessageHook(fixture.repoPath, `printf '%s\\n' 'hook conflict sentinel' >&2\nexit 1`);
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(created.runId, 'squash', mergeMessage, {
      preserveConflicts: true,
    });

    expect(result).toMatchObject({ success: false, merged: false, conflictState: 'none', conflicts: [] });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('restores the target when the second cherry-pick fails', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'second-cherry-pick-failure' });
    const worktreeGit = simpleGit(created.path);
    await fs.writeFile(path.join(created.path, 'first.txt'), 'first\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: first ad-hoc source commit'));
    await fs.writeFile(path.join(created.path, 'tracked.txt'), 'task side\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: conflicting second ad-hoc source commit'));
    expect((await worktreeGit.log()).total).toBeGreaterThanOrEqual(3);

    await fs.writeFile(path.join(fixture.repoPath, 'tracked.txt'), 'main side\n', 'utf-8');
    await fixture.repoGit.add('-A');
    await fixture.repoGit.commit(testCommitMessage('feat: conflicting ad-hoc target commit'));
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(created.runId, 'rebase');

    expect(result).toMatchObject({
      success: false,
      merged: false,
      conflictState: 'aborted',
      reasonCode: 'MERGE_CONFLICT_ABORTED',
      phase: 'integration',
      mutation: 'none',
      retryable: true,
      action: 'retry_same_operation',
      filesChanged: [],
    });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('classifies rebase plus a non-blank message as MESSAGE_NOT_ALLOWED_FOR_REBASE', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'rebase-message-classification' });
    await fs.writeFile(path.join(created.path, 'adhoc-file.txt'), 'content\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: ad-hoc change'));
    await fixture.repoGit.checkout('main');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(created.runId, 'rebase', 'feat: custom rebase message\n\nBody.');

    expect(result).toMatchObject({
      success: false,
      merged: false,
      reasonCode: 'MESSAGE_NOT_ALLOWED_FOR_REBASE',
      phase: 'validation',
      mutation: 'none',
      retryable: false,
      action: 'correct_arguments',
    });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
  });

  it('classifies a malformed aggregate message as INVALID_MERGE_MESSAGE before mutation', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'invalid-merge-message' });
    await fs.writeFile(path.join(created.path, 'adhoc-file.txt'), 'content\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: ad-hoc change'));
    await fixture.repoGit.checkout('main');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(created.runId, 'squash', 'subject only');

    expect(result).toMatchObject({
      success: false,
      merged: false,
      reasonCode: 'INVALID_MERGE_MESSAGE',
      phase: 'validation',
      mutation: 'none',
      retryable: false,
      action: 'correct_arguments',
    });
    expect(result.error).toMatch(/subject.*blank line.*body/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
  });

  it('classifies a malformed exact source commit as INVALID_COMMIT_MESSAGE before mutation', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'invalid-source-commit-message' });
    const worktreeGit = simpleGit(created.path);
    await fs.writeFile(path.join(created.path, 'bad-source.txt'), 'bad\n', 'utf-8');
    await worktreeGit.add('-A');
    await worktreeGit.commit('subject only');
    await fixture.repoGit.checkout('main');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(created.runId, 'merge', mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      reasonCode: 'INVALID_COMMIT_MESSAGE',
      phase: 'validation',
      mutation: 'none',
      retryable: false,
      action: 'correct_arguments',
    });
    expect(result.error).toMatch(/source commit.*subject.*blank line.*body/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
  });

  it('classifies a preserved conflict as MERGE_CONFLICT_PRESERVED with a resolve-conflicts action', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'preserved-conflict-classification' });
    await fs.writeFile(path.join(created.path, 'tracked.txt'), 'branch side\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: conflicting ad-hoc change'));
    await fs.writeFile(path.join(fixture.repoPath, 'tracked.txt'), 'main side\n', 'utf-8');
    await fixture.repoGit.add('-A');
    await fixture.repoGit.commit(testCommitMessage('feat: conflicting target change'));

    const result = await fixture.service.merge(created.runId, 'squash', mergeMessage, {
      preserveConflicts: true,
    });

    expect(result).toMatchObject({
      success: false,
      merged: false,
      conflictState: 'preserved',
      reasonCode: 'MERGE_CONFLICT_PRESERVED',
      phase: 'integration',
      mutation: 'preserved',
      retryable: false,
      action: 'resolve_conflicts',
      filesChanged: [],
      conflicts: ['tracked.txt'],
    });
    expect((await fixture.repoGit.status()).conflicted).toContain('tracked.txt');
  });

  it("reports CLEANUP_FAILED with cleanup_only when a successful integration's cleanup does not finish", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "merge-cleanup-failure" });
    await fs.writeFile(path.join(created.path, "merge-file.txt"), "hi\n", "utf-8");
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('chore: merge content'));
    await fixture.repoGit.checkout("main");

    const getGit = (fixture.service as any).getGit.bind(fixture.service);
    const gitSpy = spyOn(fixture.service as any, 'getGit').mockImplementation((cwd?: string) => {
      const git = getGit(cwd);
      return new Proxy(git, {
        get(target, key) {
          if (key === 'deleteLocalBranch') {
            return () => Promise.reject(new Error('simulated branch deletion failure'));
          }
          return Reflect.get(target, key);
        },
      });
    });
    let result;
    try {
      result = await fixture.service.merge(created.runId, "merge", mergeMessage, {
        cleanup: "worktree+branch",
      });
    } finally {
      gitSpy.mockRestore();
    }

    // The integration succeeded and is durable; only cleanup fell short.
    expect(result).toMatchObject({
      success: true,
      merged: true,
      reasonCode: "CLEANUP_FAILED",
      phase: "cleanup",
      mutation: "applied",
      retryable: false,
      action: "cleanup_only",
      filesChanged: ["merge-file.txt"],
    });
    expect(result.cleanup.outcome).toBe('partial');
    expect(result.cleanup.branchDeletion.status).toBe('failed');
    expect(result.cleanup.failures).toEqual([
      expect.objectContaining({ step: 'branch-deletion' }),
    ]);
    expect(await readHeadBody(fixture.repoPath)).toBe(mergeMessage);
    expect(await branchExists(fixture.repoGit, created.branch)).toBe(true);
  });

  it('does not roll back a completed integration when the requested cleanup throws', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'merge-cleanup-throw' });
    await fs.writeFile(path.join(created.path, 'merge-file.txt'), 'hi\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('chore: merge content'));
    await fixture.repoGit.checkout('main');
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const cleanupSpy = spyOn(fixture.service, 'cleanup').mockImplementation(async () => {
      throw new Error('simulated cleanup failure');
    });
    let result;
    try {
      result = await fixture.service.merge(created.runId, 'merge', mergeMessage, {
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
    expect(await pathExists(created.path)).toBe(true);
  });

  it('classifies a merge-hook verification failure after the commit exists as POST_INTEGRATION_VERIFICATION_FAILED', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'post-integration-verification' });
    await fs.writeFile(path.join(created.path, 'new-file.txt'), 'new\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: ad-hoc source change'));
    await installPrepareCommitMessageHook(fixture.repoPath, `printf '%s\\n' 'subject only' > "$1"`);
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(created.runId, 'squash', mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      reasonCode: 'POST_INTEGRATION_VERIFICATION_FAILED',
      phase: 'verification',
      mutation: 'unknown',
      retryable: false,
      action: 'inspect_state',
      filesChanged: [],
    });
    expect(result.error).toMatch(/subject.*blank line.*body/i);
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
  });

  it('classifies a failed restore as ROLLBACK_FAILED with an unconfirmed target state', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'rollback-failure' });
    await fs.writeFile(path.join(created.path, 'new-file.txt'), 'new\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: ad-hoc source change'));
    await installPrepareCommitMessageHook(fixture.repoPath, `printf '%s\\n' 'subject only' > "$1"`);
    const originalHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    // Force the restore itself to fail: the hook already invalidated the new
    // aggregate commit, and `reset --hard` must not succeed afterwards.
    const getGit = (fixture.service as any).getGit.bind(fixture.service);
    const gitSpy = spyOn(fixture.service as any, 'getGit').mockImplementation((cwd?: string) => {
      const git = getGit(cwd);
      return new Proxy(git, {
        get(target, key) {
          if (key !== 'raw') return Reflect.get(target, key);
          return (...args: unknown[]) => {
            const command = args[0];
            if (Array.isArray(command) && command[0] === 'reset' && command[1] === '--hard') {
              return Promise.reject(new Error('simulated restore failure'));
            }
            return (target.raw as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
          };
        },
      });
    });
    try {
      const result = await fixture.service.merge(created.runId, 'squash', mergeMessage);

      expect(result).toMatchObject({
        success: false,
        merged: false,
        reasonCode: 'ROLLBACK_FAILED',
        phase: 'rollback',
        mutation: 'unknown',
        retryable: false,
        action: 'manual_recovery',
        filesChanged: [],
      });
      expect(result.error).toMatch(/failed to restore target/i);
    } finally {
      gitSpy.mockRestore();
      await fixture.repoGit.raw(['reset', '--hard', originalHead]);
    }
  });

  it('keeps the retryable-implies-no-mutation invariant across failure results', async () => {
    const fixture = await createFixture();
    const responses: AdhocMergeResult[] = [];

    const cleanRun = await fixture.service.create({ runId: 'invariant-clean' });
    await fs.writeFile(path.join(cleanRun.path, 'f.txt'), 'f\n', 'utf-8');
    await commitAdhocChanges(fixture.service, cleanRun.runId, testCommitMessage('feat: ad-hoc change'));
    await fs.writeFile(path.join(fixture.repoPath, 'dirty.txt'), 'dirty\n', 'utf-8');
    responses.push(await fixture.service.merge(cleanRun.runId, 'squash', mergeMessage));
    await fs.rm(path.join(fixture.repoPath, 'dirty.txt'), { force: true });

    responses.push(await fixture.service.merge(cleanRun.runId, 'rebase', 'feat: with message\n\nBody.'));
    responses.push(await fixture.service.merge('missing-run-id', 'squash', mergeMessage));

    const conflictRun = await fixture.service.create({ runId: 'invariant-conflict' });
    await fs.writeFile(path.join(conflictRun.path, 'tracked.txt'), 'branch side\n', 'utf-8');
    await commitAdhocChanges(fixture.service, conflictRun.runId, testCommitMessage('feat: conflicting ad-hoc change'));
    await fs.writeFile(path.join(fixture.repoPath, 'tracked.txt'), 'main side\n', 'utf-8');
    await fixture.repoGit.add('-A');
    await fixture.repoGit.commit(testCommitMessage('feat: conflicting target change'));
    responses.push(await fixture.service.merge(conflictRun.runId, 'squash', mergeMessage));

    expect(responses.length).toBeGreaterThan(0);
    for (const response of responses) {
      if (response.retryable) {
        expect(response.mutation).toBe('none');
      }
    }
    expect(responses.some((response) => response.retryable)).toBe(true);
  });
});

// ------------------------------ Composite (Task 02) ------------------------------

interface CompositeFixture {
  baseDir: string;
  hiveDir: string;
  repos: ResolvedRepository[];
  apiGit: SimpleGit;
  webGit: SimpleGit;
  service: AdhocWorktreeService;
}

async function createCompositeFixture(): Promise<CompositeFixture> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-core-adhoc-composite-base-"));
  tempDirs.push(baseDir);

  const { repoPath: apiPath, repoGit: apiGit } = await createTempRepo();
  const { repoPath: webPath, repoGit: webGit } = await createTempRepo();

  const repos: ResolvedRepository[] = [
    { id: "api", path: apiPath, root: apiPath },
    { id: "web", path: webPath, root: webPath },
  ];

  const hiveDir = path.join(baseDir, ".hive");
  const service = new AdhocWorktreeService({
    baseDir,
    hiveDir,
    repositoryResolver: () => repos,
  });

  return { baseDir, hiveDir, repos, apiGit, webGit, service };
}

describe("AdhocWorktreeService composite create", () => {
  it("creates per-repo worktrees and branches under .hive/.worktrees/adhoc/<runId>", async () => {
    const fixture = await createCompositeFixture();

    const result = await fixture.service.create({
      runId: "composite-run",
      repoIds: ["api", "web"],
    });

    expect(result.runId).toBe("composite-run");
    expect(result.mode).toBe("adhoc-composite");
    expect(result.workspacePath).toBe(
      path.join(fixture.hiveDir, ".worktrees", "adhoc", "composite-run"),
    );
    expect(result.repos).toBeDefined();
    expect(Object.keys(result.repos!).sort()).toEqual(["api", "web"]);

    const apiWt = path.join(fixture.hiveDir, ".worktrees", "adhoc", "composite-run", "repos", "api");
    const webWt = path.join(fixture.hiveDir, ".worktrees", "adhoc", "composite-run", "repos", "web");
    expect(result.repos!.api.path).toBe(apiWt);
    expect(result.repos!.web.path).toBe(webWt);
    expect(result.repos!.api.branch).toBe("hive/adhoc/api/composite-run");
    expect(result.repos!.web.branch).toBe("hive/adhoc/web/composite-run");
    expect(await pathExists(apiWt)).toBe(true);
    expect(await pathExists(webWt)).toBe(true);
    expect(await branchExists(fixture.apiGit, "hive/adhoc/api/composite-run")).toBe(true);
    expect(await branchExists(fixture.webGit, "hive/adhoc/web/composite-run")).toBe(true);
  });

  it("writes an operational workspace.json manifest at the workspace root", async () => {
    const fixture = await createCompositeFixture();

    const result = await fixture.service.create({
      runId: "manifest-run",
      repoIds: ["api", "web"],
    });

    const manifestPath = path.join(result.workspacePath!, "workspace.json");
    expect(await pathExists(manifestPath)).toBe(true);

    const raw = await fs.readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.mode).toBe("adhoc-composite");
    expect(manifest.runId).toBe("manifest-run");
    expect(Object.keys(manifest.repos).sort()).toEqual(["api", "web"]);
    expect(manifest.repos.api.path).toBe("repos/api");
    expect(manifest.repos.api.branch).toBe("hive/adhoc/api/manifest-run");
    expect(manifest.repos.web.path).toBe("repos/web");
    expect(manifest.repos.web.branch).toBe("hive/adhoc/web/manifest-run");
    expect(Object.keys(manifest.baseCommits).sort()).toEqual(["api", "web"]);
    expect(manifest.baseCommits.api).toBeTruthy();
    expect(manifest.baseCommits.web).toBeTruthy();
  });

  it("does not create .hive/features for composite ad-hoc workspaces", async () => {
    const fixture = await createCompositeFixture();

    await fixture.service.create({ runId: "no-features-run", repoIds: ["api", "web"] });

    expect(await pathExists(path.join(fixture.hiveDir, "features"))).toBe(false);
  });

  it("fails loud when a requested repoId is missing from the resolver", async () => {
    const fixture = await createCompositeFixture();

    await expect(
      fixture.service.create({ runId: "missing-repo", repoIds: ["api", "ghost"] }),
    ).rejects.toThrow(/ghost/);

    // Missing repos are rejected before any partial workspace state is created.
    expect(await branchExists(fixture.apiGit, "hive/adhoc/api/missing-repo")).toBe(false);
    expect(
      await pathExists(path.join(fixture.hiveDir, ".worktrees", "adhoc", "missing-repo")),
    ).toBe(false);
  });

  it("returns an existing explicit composite run only when repo worktrees are registered", async () => {
    const fixture = await createCompositeFixture();

    const first = await fixture.service.create({
      runId: "explicit-composite",
      repoIds: ["web", "api"],
    });
    const second = await fixture.service.create({
      runId: "explicit-composite",
      repoIds: ["api", "web"],
    });

    expect(second.workspacePath).toBe(first.workspacePath);
    expect(second.branch).toBe("hive/adhoc/api/explicit-composite");
    expect(second.commit).toBe(first.repos!.api.commit);
  });

  it("does not return a composite workspace when a manifest repo worktree is missing", async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({
      runId: "missing-composite-worktree",
      repoIds: ["api", "web"],
    });

    await fixture.apiGit.raw(["worktree", "remove", created.repos!.api.path, "--force"]);

    await expect(fixture.service.get(created.runId)).resolves.toBeNull();
  });
});

describe("AdhocWorktreeService composite merge", () => {
  async function commitChangeInCompositeRepo(
    service: AdhocWorktreeService,
    runId: string,
    repoPath: string,
    file: string,
    content: string,
  ): Promise<void> {
    await fs.writeFile(path.join(repoPath, file), content, "utf-8");
      const result = await commitAdhocChanges(service, runId, testCommitMessage(`chore: ${file}`));
    expect(result.committed).toBe(true);
  }

  async function commitNetZeroChangeInCompositeRepo(
    service: AdhocWorktreeService,
    runId: string,
    repoPath: string,
  ): Promise<void> {
    await fs.writeFile(path.join(repoPath, "tracked.txt"), "transient composite change\n", "utf-8");
    const transient = await commitAdhocChanges(service, runId, testCommitMessage('chore: transient composite change'));
    expect(transient.committed).toBe(true);
    await fs.writeFile(path.join(repoPath, "tracked.txt"), "base\n", "utf-8");
    const reverted = await commitAdhocChanges(service, runId, testCommitMessage('revert: transient composite change'));
    expect(reverted.committed).toBe(true);
  }

  it("merges in stable repo ID order, returns per-repo results, and supports cleanup", async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({
      runId: "merge-composite",
      repoIds: ["api", "web"],
    });

    await fs.writeFile(path.join(created.repos!.api.path, "api-new.txt"), "a\n", "utf-8");
    await fs.writeFile(path.join(created.repos!.web.path, "web-new.txt"), "w\n", "utf-8");
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: changes in both repos'));

    // Both source repos already on main and clean.
    const result = await fixture.service.merge(created.runId, "merge", mergeMessage, {
      cleanup: "worktree+branch",
    });

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.repos).toBeDefined();
    expect(Object.keys(result.repos!).sort()).toEqual(["api", "web"]);
    expect(result.repos!.api.success).toBe(true);
    expect(result.repos!.web.success).toBe(true);

    // Cleanup applied
    expect(await pathExists(created.workspacePath!)).toBe(false);
    expect(await branchExists(fixture.apiGit, "hive/adhoc/api/merge-composite")).toBe(false);
    expect(await branchExists(fixture.webGit, "hive/adhoc/web/merge-composite")).toBe(false);
  });

  it("returns an all-repo composite no-op when every ad-hoc repo has zero tracked diff", async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({
      runId: "merge-composite-no-change",
      repoIds: ["api", "web"],
    });
    await commitNetZeroChangeInCompositeRepo(fixture.service, created.runId, created.repos!.api.path);
    await commitNetZeroChangeInCompositeRepo(fixture.service, created.runId, created.repos!.web.path);
    const before = {
      api: (await fixture.apiGit.revparse(["HEAD"])).trim(),
      web: (await fixture.webGit.revparse(["HEAD"])).trim(),
    };

    const result = await fixture.service.merge(created.runId, "merge", undefined, {
      cleanup: "worktree+branch",
    });

    expect(result).toMatchObject({
      success: true,
      merged: false,
      reason: "nothing_to_merge",
      reasonCode: "NO_TRACKED_CHANGES",
      filesChanged: [],
      conflicts: [],
      conflictState: "none",
      cleanupEligible: true,
      cleanup: {
        worktreeRemoved: true,
        branchDeleted: true,
        pruned: true,
      },
    });
    expect("sha" in result).toBe(false);
    expect(result.repos!.api).toMatchObject({ success: true, merged: false, reasonCode: "NO_TRACKED_CHANGES" });
    expect(result.repos!.web).toMatchObject({ success: true, merged: false, reasonCode: "NO_TRACKED_CHANGES" });
    expect((await fixture.apiGit.revparse(["HEAD"])).trim()).toBe(before.api);
    expect((await fixture.webGit.revparse(["HEAD"])).trim()).toBe(before.web);
    expect(await pathExists(created.workspacePath!)).toBe(false);
    expect(await branchExists(fixture.apiGit, "hive/adhoc/api/merge-composite-no-change")).toBe(false);
    expect(await branchExists(fixture.webGit, "hive/adhoc/web/merge-composite-no-change")).toBe(false);
  });

  it("aggregates mixed ad-hoc composite no-op and changed repos as a successful actual merge", async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({
      runId: "merge-composite-mixed-no-change",
      repoIds: ["api", "web"],
    });
    await commitNetZeroChangeInCompositeRepo(fixture.service, created.runId, created.repos!.api.path);
    await commitChangeInCompositeRepo(fixture.service, created.runId, created.repos!.web.path, "web-new.txt", "w\n");

    const result = await fixture.service.merge(created.runId, "merge", mergeMessage);

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.reasonCode).toBeUndefined();
    expect(typeof result.sha).toBe("string");
    expect(result.filesChanged).toEqual(["web:web-new.txt"]);
    expect(result.repos!.api).toMatchObject({ success: true, merged: false, reasonCode: "NO_TRACKED_CHANGES" });
    expect(result.repos!.web.merged).toBe(true);
  });

  it("preflights clean target repos and refuses to merge when a source repo is dirty", async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({
      runId: "merge-dirty",
      repoIds: ["api", "web"],
    });

    await fs.writeFile(path.join(created.repos!.api.path, "api-new.txt"), "a\n", "utf-8");
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: api change only'));

    // Dirty the api source repo
    await fs.writeFile(path.join(fixture.repos[0].path, "dirty.txt"), "dirty\n", "utf-8");

    const result = await fixture.service.merge(created.runId);

    expect(result.success).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.error).toMatch(/api/);
    expect(result.error?.toLowerCase()).toMatch(/dirty|uncommitted/);
  });

  it('rolls back a later repo after its second cherry-pick fails and reports only the earlier repo as partial progress', async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({
      runId: 'merge-composite-second-cherry-pick-failure',
      repoIds: ['api', 'web'],
    });
    await fs.writeFile(path.join(created.repos!.api.path, 'api.txt'), 'api\n', 'utf-8');
    await fs.writeFile(path.join(created.repos!.web.path, 'first.txt'), 'first\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: first composite source commits'));
    await fs.writeFile(path.join(created.repos!.web.path, 'tracked.txt'), 'task side\n', 'utf-8');
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: conflicting second web source commit'));

    await fs.writeFile(path.join(fixture.repos[1].path, 'tracked.txt'), 'main side\n', 'utf-8');
    await fixture.webGit.add('-A');
    await fixture.webGit.commit(testCommitMessage('feat: conflicting web target commit'));
    const before = {
      api: (await fixture.apiGit.revparse(['HEAD'])).trim(),
      web: (await fixture.webGit.revparse(['HEAD'])).trim(),
    };

    const result = await fixture.service.merge(created.runId, 'rebase');

    expect(result).toMatchObject({
      success: false,
      merged: false,
      partial: true,
      reasonCode: 'COMPOSITE_PARTIAL',
      mutation: 'partial',
      retryable: false,
      action: 'inspect_state',
    });
    expect(result.repos!.api).toMatchObject({ success: true, merged: true });
    expect(result.repos!.web).toMatchObject({ success: false, merged: false, conflictState: 'aborted' });
    // The merged repository's SHA is reported only under its repo entry.
    expect('sha' in result).toBe(false);
    expect(result.repos!.api.sha).toBe((await fixture.apiGit.revparse(['HEAD'])).trim());
    expect((await fixture.apiGit.revparse(['HEAD'])).trim()).not.toBe(before.api);
    expect((await fixture.webGit.revparse(['HEAD'])).trim()).toBe(before.web);
    expect((await fixture.webGit.status()).isClean()).toBe(true);
  });

  it("classifies a composite preflight failure with its specific reason code and no partial flag", async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({
      runId: "merge-composite-preflight-classification",
      repoIds: ["api", "web"],
    });
    await fs.writeFile(path.join(created.repos!.api.path, "api-new.txt"), "a\n", "utf-8");
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: api change only'));
    await fs.writeFile(path.join(fixture.repos[0].path, "dirty.txt"), "dirty\n", "utf-8");

    const result = await fixture.service.merge(created.runId, "squash", mergeMessage);

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
  });

  it("classifies a composite stop after an earlier repository merged as COMPOSITE_PARTIAL", async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({
      runId: "merge-composite-partial-nonconflict",
      repoIds: ["api", "web"],
    });
    await fs.writeFile(path.join(created.repos!.api.path, "api-new.txt"), "a\n", "utf-8");
    await fs.writeFile(path.join(created.repos!.web.path, "web-new.txt"), "w\n", "utf-8");
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage('feat: changes in both repos'));

    // web rejects the merge commit through a pre-merge-commit hook.
    const hookDir = path.join(fixture.repos[1].path, '.git', 'hooks');
    await fs.mkdir(hookDir, { recursive: true });
    const hookPath = path.join(hookDir, 'pre-merge-commit');
    await fs.writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf-8');
    await fs.chmod(hookPath, 0o755);

    const result = await fixture.service.merge(created.runId, "merge", mergeMessage);

    expect(result).toMatchObject({
      success: false,
      merged: false,
      partial: true,
      reasonCode: 'COMPOSITE_PARTIAL',
      mutation: 'partial',
      retryable: false,
      action: 'inspect_state',
    });
    expect(result.repos!.api).toMatchObject({ success: true, merged: true });
    expect(result.repos!.web.success).toBe(false);
    // The api integration is durable, so its observed delta is flattened.
    expect(result.filesChanged).toEqual(['api:api-new.txt']);
  });
});

describe("AdhocWorktreeService cleanup observability", () => {
  it("reports a failed requested branch deletion as partial with the step and cause", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "cleanup-branch-failure" });

    const getGit = (fixture.service as any).getGit.bind(fixture.service);
    const gitSpy = spyOn(fixture.service as any, 'getGit').mockImplementation((cwd?: string) => {
      const git = getGit(cwd);
      return new Proxy(git, {
        get(target, key) {
          if (key === 'deleteLocalBranch') {
            return () => Promise.reject(new Error('simulated branch deletion failure'));
          }
          return Reflect.get(target, key);
        },
      });
    });
    let result;
    try {
      result = await fixture.service.cleanup(created.runId, true);
    } finally {
      gitSpy.mockRestore();
    }

    expect(result.cleanup.branchDeletion.status).toBe('failed');
    expect(result.cleanup.branchDeletion.error).toMatch(/simulated branch deletion failure/);
    expect(result.cleanup.outcome).toBe('partial');
    expect(result.cleanup.requested).toBe('worktree+branch');
    expect(result.cleanup.failures).toEqual([
      expect.objectContaining({ step: 'branch-deletion' }),
    ]);
    expect(result.branchDeleted).toBe(false);
    expect(result.reasonCode).toBe('CLEANUP_FAILED');
    expect(result.retryable).toBe(false);
    expect(result.action).toBe('cleanup_only');
    expect(await pathExists(created.path)).toBe(false);
  });

  it("reports an already absent branch as already_absent and keeps cleanup complete", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "cleanup-branch-absent" });
    await fixture.repoGit.raw(["worktree", "remove", created.path, "--force"]);
    await fixture.repoGit.deleteLocalBranch(created.branch, true);

    const result = await fixture.service.cleanup(created.runId, true);

    expect(result.cleanup.branchDeletion.status).toBe('already_absent');
    expect(result.cleanup.worktreeRemoval.status).toBe('already_absent');
    expect(result.cleanup.outcome).toBe('complete');
    expect(result.branchDeleted).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.reasonCode).toBeUndefined();
    expect(result.action).toBe('none');
  });

  it("reports not_requested for branch deletion when deleteBranch is false while cleanup completes", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "cleanup-no-branch" });

    const result = await fixture.service.cleanup(created.runId, false);

    expect(result.cleanup).toMatchObject({
      requested: 'worktree',
      outcome: 'complete',
    });
    expect(result.cleanup.branchDeletion.status).toBe('not_requested');
    expect(result.cleanup.worktreeRemoval.status).toBe('succeeded');
    expect(result.cleanup.prune.status).toBe('succeeded');
    expect(result.branchDeleted).toBe(false);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.reasonCode).toBeUndefined();
    expect(await branchExists(fixture.repoGit, created.branch)).toBe(true);
  });

  it("names the failing repository when composite cleanup preflight fails", async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({ runId: "cleanup-composite-preflight", repoIds: ["api", "web"] });
    await fixture.webGit.raw(["worktree", "remove", created.repos!.web.path, "--force"]);

    const result = await fixture.service.cleanup(created.runId, true);

    expect(result.cleanup.outcome).toBe('failed');
    expect(result.cleanup.worktreeRemoval.status).toBe('not_attempted');
    expect(result.cleanup.failures).toEqual([
      expect.objectContaining({ step: 'preflight', repoId: 'web' }),
    ]);
    expect(result.reasonCode).toBe('CLEANUP_FAILED');
    expect(result.phase).toBe('cleanup');
    expect(result.mutation).toBe('none');
    expect(result.retryable).toBe(false);
    expect(result.action).toBe('cleanup_only');
    expect(await pathExists(created.workspacePath!)).toBe(true);
  });

  it("reports composite cleanup complete across repos when every step succeeds", async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({ runId: "cleanup-composite-complete", repoIds: ["api", "web"] });

    const result = await fixture.service.cleanup(created.runId, true);

    expect(result.cleanup).toMatchObject({
      requested: 'worktree+branch',
      outcome: 'complete',
      failures: [],
    });
    expect(result.cleanup.worktreeRemoval.status).toBe('succeeded');
    expect(result.cleanup.branchDeletion.status).toBe('succeeded');
    expect(result.cleanup.prune.status).toBe('succeeded');
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.reasonCode).toBeUndefined();
    expect(await pathExists(created.workspacePath!)).toBe(false);
  });
});

describe("AdhocWorktreeService linkage preflight", () => {
  it("rejects a copied former-root pointer before use or mutation", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "former-root-run" });
    const former = await createTempRepo();
    const formerWorktree = path.join(former.repoPath, "former-worktree");
    await former.repoGit.raw(["worktree", "add", "-b", "former-branch", formerWorktree, "HEAD"]);
    const formerPointer = await fs.readFile(path.join(formerWorktree, ".git"), "utf8");
    const localPointerPath = path.join(created.path, ".git");
    await fs.writeFile(localPointerPath, formerPointer, "utf8");

    const preserved = [
      localPointerPath,
      path.join(created.path, "tracked.txt"),
      path.join(formerWorktree, ".git"),
      path.join(formerWorktree, "tracked.txt"),
    ];
    const before = await Promise.all(preserved.map((file) => fs.readFile(file)));

    const forbiddenAccess: string[] = [];
    const fsSpies = ["access", "stat", "lstat", "readFile", "realpath", "readdir", "open"].map((name) => {
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
    const gitSpy = spyOn(fixture.service as any, "getGit").mockImplementation((cwd?: string) => {
      const git = getGit(cwd);
      return new Proxy(git, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            gitCalls.push({ cwd, method: key, args });
            return value.apply(target, args);
          };
        },
      });
    });
    try {
      await expect(fixture.service.get(created.runId)).rejects.toThrow(
        /administration entry is outside the trusted Git common directory/,
      );
      await expect(
        commitAdhocChanges(fixture.service, created.runId, testCommitMessage("feat: should not commit")),
      ).rejects.toThrow(/administration entry is outside the trusted Git common directory/);
      const mergeResult = await fixture.service.merge(created.runId, "squash", mergeMessage);
      expect(mergeResult.success).toBe(false);
      expect(mergeResult.merged).toBe(false);
      expect(mergeResult.error).toMatch(
        /administration entry is outside the trusted Git common directory/,
      );
      await expect(fixture.service.cleanup(created.runId, true)).rejects.toThrow(
        /administration entry is outside the trusted Git common directory/,
      );

      expect(forbiddenAccess).toEqual([]);
      expect(gitCalls.length).toBeGreaterThan(0);
      expect(gitCalls.every((call) => call.cwd === fixture.repoPath)).toBe(true);
    } finally {
      fsSpies.forEach((spy) => spy.mockRestore());
      gitSpy.mockRestore();
    }
    expect(await Promise.all(preserved.map((file) => fs.readFile(file)))).toEqual(before);
    expect(await branchExists(fixture.repoGit, created.branch)).toBe(true);
  });

  it("rejects composite topology drift before Git or mutation in any selected repo", async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({ runId: "topology-drift", repoIds: ["api", "web"] });
    const manifestPath = path.join(created.workspacePath!, "workspace.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    const former = path.join(fixture.baseDir, "former");
    manifest.repos.api.repoRoot = former;
    manifest.repos.api.repoPath = former;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const manifestBytes = await fs.readFile(manifestPath);
    const apiBranchHead = (await fixture.apiGit.revparse(["hive/adhoc/api/topology-drift"])).trim();

    const forbidden: string[] = [];
    const spies = ["access", "stat", "lstat", "readFile", "realpath", "readdir", "open"].map((name) => {
      const original = (fs as any)[name];
      return spyOn(fs as any, name).mockImplementation((file: any, ...args: any[]) => {
        if (String(file).startsWith(former)) forbidden.push(`${name}:${file}`);
        return original(file, ...args);
      });
    });
    const gitPaths: string[] = [];
    const getGit = (fixture.service as any).getGit.bind(fixture.service);
    const gitSpy = spyOn(fixture.service as any, "getGit").mockImplementation((cwd: string) => {
      gitPaths.push(cwd);
      return getGit(cwd);
    });
    try {
      await expect(fixture.service.get(created.runId)).rejects.toThrow(
        /workspace topology does not match the trusted repository manifest/,
      );
      await expect(
        commitAdhocChanges(fixture.service, created.runId, testCommitMessage("feat: should not commit")),
      ).rejects.toThrow(/workspace topology does not match the trusted repository manifest/);
      await expect(fixture.service.merge(created.runId, "squash", mergeMessage)).rejects.toThrow(
        /workspace topology does not match the trusted repository manifest/,
      );
      await expect(fixture.service.cleanup(created.runId, true)).rejects.toThrow(
        /workspace topology does not match the trusted repository manifest/,
      );

      expect(forbidden).toEqual([]);
      expect(gitPaths).toEqual([]);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      gitSpy.mockRestore();
    }

    expect(await fs.readFile(manifestPath)).toEqual(manifestBytes);
    expect(await pathExists(created.workspacePath!)).toBe(true);
    expect(await pathExists(created.repos!.api.path)).toBe(true);
    expect(await pathExists(created.repos!.web.path)).toBe(true);
    expect((await fixture.apiGit.revparse(["hive/adhoc/api/topology-drift"])).trim()).toBe(apiBranchHead);
    expect(await branchExists(fixture.apiGit, "hive/adhoc/api/topology-drift")).toBe(true);
    expect(await branchExists(fixture.webGit, "hive/adhoc/web/topology-drift")).toBe(true);
  });

  it("retains the composite workspace root when cleanup preflight fails", async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({ runId: "cleanup-preflight", repoIds: ["api", "web"] });
    await fixture.webGit.raw(["worktree", "remove", created.repos!.web.path, "--force"]);
    const apiBranchHead = (await fixture.apiGit.revparse(["hive/adhoc/api/cleanup-preflight"])).trim();

    const result = await fixture.service.cleanup(created.runId, true);

    expect(result).toMatchObject({
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
      reasonCode: 'CLEANUP_FAILED',
      phase: 'cleanup',
      mutation: 'none',
      retryable: false,
      action: 'cleanup_only',
      cleanup: {
        requested: 'worktree+branch',
        outcome: 'failed',
        failures: [
          expect.objectContaining({ step: 'preflight', repoId: 'web' }),
        ],
      },
    });
    expect(await pathExists(created.workspacePath!)).toBe(true);
    expect(await pathExists(created.repos!.api.path)).toBe(true);
    expect((await fixture.apiGit.revparse(["hive/adhoc/api/cleanup-preflight"])).trim()).toBe(apiBranchHead);
    expect(await branchExists(fixture.apiGit, "hive/adhoc/api/cleanup-preflight")).toBe(true);
  });

  it("rejects a copied composite manifest before redirecting to the source run", async () => {
    const fixture = await createCompositeFixture();
    const source = await fixture.service.create({ runId: "copy-source", repoIds: ["api", "web"] });
    const target = await fixture.service.create({ runId: "copy-target", repoIds: ["api", "web"] });
    await fs.writeFile(path.join(source.repos!.api.path, "source-only.txt"), "source-only\n", "utf-8");
    await commitAdhocChanges(fixture.service, source.runId, testCommitMessage("feat: source-only composite change"));

    const sourceManifestPath = path.join(source.workspacePath!, "workspace.json");
    const targetManifestPath = path.join(target.workspacePath!, "workspace.json");
    await fs.writeFile(targetManifestPath, await fs.readFile(sourceManifestPath));

    const sourceRoot = source.workspacePath!;
    const sourceApiHead = (await fixture.apiGit.revparse(["hive/adhoc/api/copy-source"])).trim();
    const sourceWebHead = (await fixture.webGit.revparse(["hive/adhoc/web/copy-source"])).trim();
    const targetApiHead = (await fixture.apiGit.revparse(["hive/adhoc/api/copy-target"])).trim();
    const targetWebHead = (await fixture.webGit.revparse(["hive/adhoc/web/copy-target"])).trim();
    const preserved = [
      sourceManifestPath,
      targetManifestPath,
      path.join(source.repos!.api.path, "source-only.txt"),
      path.join(source.repos!.api.path, "tracked.txt"),
      path.join(target.repos!.api.path, "tracked.txt"),
    ];
    const realReadFile = fs.readFile.bind(fs);
    const readPreserved = () => Promise.all(preserved.map((file) => realReadFile(file)));
    let before = await readPreserved();

    const forbiddenAccess: string[] = [];
    const fsSpies = ["access", "stat", "lstat", "readFile", "realpath", "readdir", "open"].map((name) => {
      const original = (fs as any)[name];
      return spyOn(fs as any, name).mockImplementation((file: any, ...args: any[]) => {
        const candidate = String(file);
        if (candidate === sourceRoot || candidate.startsWith(`${sourceRoot}${path.sep}`)) {
          forbiddenAccess.push(`${name}:${candidate}`);
        }
        return original(file, ...args);
      });
    });
    const gitCalls: string[] = [];
    const getGit = (fixture.service as any).getGit.bind(fixture.service);
    const gitSpy = spyOn(fixture.service as any, "getGit").mockImplementation((cwd?: string) => {
      gitCalls.push(cwd ?? fixture.baseDir);
      return getGit(cwd);
    });
    const runIdentityError = /workspace manifest run identity does not match the requested ad-hoc run/;
    try {
      await expect(fixture.service.get(target.runId)).rejects.toThrow(runIdentityError);
      await expect(
        fixture.service.create({ runId: target.runId, repoIds: ["api", "web"] }),
      ).rejects.toThrow(runIdentityError);
      await expect(
        commitAdhocChanges(fixture.service, target.runId, testCommitMessage("feat: copied manifest must not commit")),
      ).rejects.toThrow(runIdentityError);
      await expect(fixture.service.merge(target.runId, "squash", mergeMessage)).rejects.toThrow(
        runIdentityError,
      );
      await expect(fixture.service.cleanup(target.runId, true)).rejects.toThrow(runIdentityError);
      expect(await readPreserved()).toEqual(before);

      // A copied manifest claiming a different workspace kind must still fail run
      // identity before mode classification can fall back to single-worktree handling.
      const foreignModeManifest = JSON.parse(String(await realReadFile(targetManifestPath)));
      foreignModeManifest.mode = "review-composite";
      await fs.writeFile(targetManifestPath, JSON.stringify(foreignModeManifest));
      before = await readPreserved();
      await expect(fixture.service.get(target.runId)).rejects.toThrow(runIdentityError);
      await expect(fixture.service.cleanup(target.runId, true)).rejects.toThrow(runIdentityError);

      expect(forbiddenAccess).toEqual([]);
      expect(gitCalls).toEqual([]);
    } finally {
      fsSpies.forEach((spy) => spy.mockRestore());
      gitSpy.mockRestore();
    }

    expect(await Promise.all(preserved.map((file) => fs.readFile(file)))).toEqual(before);
    expect(await pathExists(source.workspacePath!)).toBe(true);
    expect(await pathExists(target.workspacePath!)).toBe(true);
    expect((await fixture.apiGit.revparse(["hive/adhoc/api/copy-source"])).trim()).toBe(sourceApiHead);
    expect((await fixture.webGit.revparse(["hive/adhoc/web/copy-source"])).trim()).toBe(sourceWebHead);
    expect((await fixture.apiGit.revparse(["hive/adhoc/api/copy-target"])).trim()).toBe(targetApiHead);
    expect((await fixture.webGit.revparse(["hive/adhoc/web/copy-target"])).trim()).toBe(targetWebHead);
    expect(await branchExists(fixture.apiGit, "hive/adhoc/api/copy-source")).toBe(true);
    expect(await branchExists(fixture.webGit, "hive/adhoc/web/copy-source")).toBe(true);
    expect(await branchExists(fixture.apiGit, "hive/adhoc/api/copy-target")).toBe(true);
    expect(await branchExists(fixture.webGit, "hive/adhoc/web/copy-target")).toBe(true);
  });

  it.each(["workspace", "run-namespace"])(
    "rejects an ad-hoc %s symlink before target access or Git",
    async (kind) => {
      const fixture = await createFixture();
      const created = await fixture.service.create({ runId: "symlink-run" });
      const pointer = await fs.readFile(path.join(created.path, ".git"), "utf8");
      const admin = pointer.trim().slice("gitdir: ".length);
      const linkPath = kind === "workspace" ? created.path : path.dirname(created.path);
      const relocated = path.join(fixture.repoPath, "relocated-workspace");
      const preserved = [
        path.join(created.path, ".git"),
        path.join(created.path, "tracked.txt"),
        ...["HEAD", "index", "commondir", "gitdir"].map((name) => path.join(admin, name)),
      ];
      const bytes = await Promise.all(preserved.map((file) => fs.readFile(file)));
      await fs.rename(linkPath, relocated);
      await fs.symlink(relocated, linkPath);
      const forbidden: string[] = [];
      const spies = ["access", "stat", "lstat", "readFile", "realpath", "readdir", "open"].map((name) => {
        const original = (fs as any)[name];
        return spyOn(fs as any, name).mockImplementation((file: any, ...args: any[]) => {
          const candidate = String(file);
          if (candidate.startsWith(relocated) || candidate.startsWith(`${linkPath}${path.sep}`)
            || (candidate === linkPath && name !== "lstat")) forbidden.push(`${name}:${candidate}`);
          return original(file, ...args);
        });
      });
      const gitSpy = spyOn(fixture.service as any, "getGit");
      try {
        await expect(fixture.service.get(created.runId)).rejects.toThrow(/path contains a symlink/);
        await expect(fixture.service.cleanup(created.runId)).rejects.toThrow(/path contains a symlink/);
        expect(forbidden).toEqual([]);
        expect(gitSpy).not.toHaveBeenCalled();
      } finally {
        spies.forEach((spy) => spy.mockRestore());
        gitSpy.mockRestore();
      }
      expect(await Promise.all(preserved.map((file) => fs.readFile(file)))).toEqual(bytes);
      expect(await fs.readlink(linkPath)).toBe(relocated);
    },
  );

  it("accepts a trusted linked manifest repository with an external common directory", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-core-adhoc-linked-base-"));
    tempDirs.push(baseDir);
    const source = await createTempRepo();
    const linkedPath = path.join(baseDir, "linked-api");
    await source.repoGit.raw(["worktree", "add", "-b", "linked-main", linkedPath, "HEAD"]);
    const repos: ResolvedRepository[] = [{ id: "api", path: linkedPath, root: linkedPath }];
    const service = new AdhocWorktreeService({
      baseDir,
      hiveDir: path.join(baseDir, ".hive"),
      repositoryResolver: () => repos,
    });

    const created = await service.create({ runId: "linked-run", repoIds: ["api"] });
    const reloaded = await service.get(created.runId);

    expect(created.mode).toBe("adhoc-composite");
    expect(reloaded?.mode).toBe("adhoc-composite");
    expect(reloaded?.repos?.api.path).toBe(created.repos!.api.path);
    expect((await source.repoGit.raw(["rev-parse", "--git-common-dir"])).trim()).not.toBe("");
  });

  it("classifies an untyped lookup failure as WORKTREE_LOOKUP_FAILED and keeps typed denials on a fresh run", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "lookup-failure-classification" });
    await fs.writeFile(path.join(created.path, "adhoc-file.txt"), "content\n", "utf-8");
    await commitAdhocChanges(fixture.service, created.runId, testCommitMessage("feat: ad-hoc change"));
    await fixture.repoGit.checkout("main");
    const beforeHead = (await fixture.repoGit.revparse(["HEAD"])).trim();
    const preservedBytes = await fs.readFile(path.join(created.path, "adhoc-file.txt"));

    const untypedSpy = spyOn(fixture.service, "get").mockImplementation(async () => {
      throw new Error("EACCES: permission denied, scandir");
    });
    let untyped: AdhocMergeResult;
    try {
      untyped = await fixture.service.merge(created.runId, "squash", mergeMessage);
    } finally {
      untypedSpy.mockRestore();
    }

    expect(untyped).toMatchObject({
      success: false,
      merged: false,
      reasonCode: "WORKTREE_LOOKUP_FAILED",
      phase: "preflight",
      mutation: "none",
      retryable: true,
      action: "inspect_state",
      filesChanged: [],
      conflicts: [],
    });
    expect(untyped.action).not.toBe("start_fresh_run");

    const typedSpy = spyOn(fixture.service, "get").mockImplementation(async () => {
      throw new WorktreeLinkageError(
        "Worktree linkage preflight failed for repository adhoc: administration backlink does not select this exact worktree",
      );
    });
    let typed: AdhocMergeResult;
    try {
      typed = await fixture.service.merge(created.runId, "squash", mergeMessage);
    } finally {
      typedSpy.mockRestore();
    }

    expect(typed).toMatchObject({
      success: false,
      merged: false,
      reasonCode: "WORKTREE_LINKAGE_INVALID",
      phase: "preflight",
      mutation: "none",
      retryable: false,
      action: "start_fresh_run",
      filesChanged: [],
      conflicts: [],
    });
    expect((await fixture.repoGit.revparse(["HEAD"])).trim()).toBe(beforeHead);
    expect(await fs.readFile(path.join(created.path, "adhoc-file.txt"))).toEqual(preservedBytes);
    expect(await branchExists(fixture.repoGit, created.branch)).toBe(true);
  });
});
