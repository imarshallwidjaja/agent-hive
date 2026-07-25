import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import simpleGit, { type SimpleGit } from "simple-git";
import type { ResolvedRepository } from "../types";
import { AdhocWorktreeService } from "./adhocWorktreeService";

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

  it('rejects a malformed message before changing HEAD or the index', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'invalid-commit-message' });
    await fs.writeFile(path.join(created.path, 'new-file.txt'), 'hello\n', 'utf-8');
    const git = simpleGit(created.path);
    const beforeHead = (await git.revparse(['HEAD'])).trim();

    const result = await fixture.service.commit(created.runId, 'subject only');

    expect(result.committed).toBe(false);
    expect(result.message).toMatch(/subject.*blank line.*body/i);
    expect((await git.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await git.status()).staged).toEqual([]);
  });

  it('removes a direct commit when a hook rewrites its message and preserves the file changes', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: 'hook-rewritten-commit' });
    const filePath = path.join(created.path, 'hook-rewritten.txt');
    await fs.writeFile(filePath, 'preserve me\n', 'utf-8');
    await installPrepareCommitMessageHook(fixture.repoPath, `printf '%s\\n' 'subject only' > "$1"`);
    const git = simpleGit(created.path);
    const beforeHead = (await git.revparse(['HEAD'])).trim();

    const result = await fixture.service.commit(created.runId, testCommitMessage('feat: valid direct input'));

    expect(result.committed).toBe(false);
    expect(result.message).toMatch(/subject.*blank line.*body/i);
    expect((await git.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('preserve me\n');
    const status = await git.status();
    expect(status.staged).toEqual([]);
    expect(status.not_added).toContain('hook-rewritten.txt');
  });
});

describe("AdhocWorktreeService.merge", () => {
  it("defaults to squash merge and returns cleanup flags=false when cleanup is not requested", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "merge-run" });
    await fs.writeFile(path.join(created.path, "merge-file.txt"), "hi\n", "utf-8");
    await fixture.service.commit(created.runId, testCommitMessage('chore: merge content'));

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
    await fixture.service.commit(created.runId, testCommitMessage('chore: merge content'));

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

  it("returns a cleanup-eligible no-op when an ad-hoc branch has commits but zero tracked diff", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.create({ runId: "merge-no-change-run" });
    await fs.writeFile(path.join(created.path, "tracked.txt"), "transient ad-hoc change\n", "utf-8");
    await fixture.service.commit(created.runId, testCommitMessage('chore: transient ad-hoc change'));
    await fs.writeFile(path.join(created.path, "tracked.txt"), "base\n", "utf-8");
    await fixture.service.commit(created.runId, testCommitMessage('revert: transient ad-hoc change'));
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
      await fixture.service.commit(created.runId, testCommitMessage('chore: transient ad-hoc change'));
      await fs.writeFile(path.join(created.path, "tracked.txt"), "base\n", "utf-8");
      await fixture.service.commit(created.runId, testCommitMessage('revert: transient ad-hoc change'));
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
    await fixture.service.commit(created.runId, testCommitMessage('feat: conflicting ad-hoc source'));
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
    await fixture.service.commit(created.runId, testCommitMessage('feat: ad-hoc source change'));
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
      await fixture.service.commit(created.runId, testCommitMessage('feat: ad-hoc source change'));
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
    await fixture.service.commit(created.runId, testCommitMessage('feat: ad-hoc source change'));
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
    await fixture.service.commit(created.runId, testCommitMessage('feat: ad-hoc source change'));
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
    await fixture.service.commit(created.runId, testCommitMessage('feat: first ad-hoc source commit'));
    await fs.writeFile(path.join(created.path, 'tracked.txt'), 'task side\n', 'utf-8');
    await fixture.service.commit(created.runId, testCommitMessage('feat: conflicting second ad-hoc source commit'));
    expect((await worktreeGit.log()).total).toBeGreaterThanOrEqual(3);

    await fs.writeFile(path.join(fixture.repoPath, 'tracked.txt'), 'main side\n', 'utf-8');
    await fixture.repoGit.add('-A');
    await fixture.repoGit.commit(testCommitMessage('feat: conflicting ad-hoc target commit'));
    const beforeHead = (await fixture.repoGit.revparse(['HEAD'])).trim();

    const result = await fixture.service.merge(created.runId, 'rebase');

    expect(result).toMatchObject({ success: false, merged: false, conflictState: 'aborted' });
    expect((await fixture.repoGit.revparse(['HEAD'])).trim()).toBe(beforeHead);
    expect((await fixture.repoGit.status()).isClean()).toBe(true);
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

describe("AdhocWorktreeService composite commit", () => {
  it("commits only repos with changes and reports per-repo results", async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({
      runId: "commit-composite",
      repoIds: ["api", "web"],
    });

    // Only mutate the api repo
    await fs.writeFile(path.join(created.repos!.api.path, "new.txt"), "hello\n", "utf-8");

    const result = await fixture.service.commit(created.runId, testCommitMessage('feat: api change'));

    expect(result.repos).toBeDefined();
    expect(result.repos!.api.committed).toBe(true);
    expect(result.repos!.api.sha).toBeTruthy();
    expect(result.repos!.web.committed).toBe(false);
    expect(result.repos!.web.message).toBe("No changes to commit");
  });

  it('uses the first committed repo as the aggregate result when an earlier repo has no changes', async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({
      runId: 'commit-composite-later-change',
      repoIds: ['api', 'web'],
    });
    await fs.writeFile(path.join(created.repos!.web.path, 'new.txt'), 'hello\n', 'utf-8');
    const message = testCommitMessage('feat: web change');

    const result = await fixture.service.commit(created.runId, message);

    expect(result.committed).toBe(true);
    expect(result.repos!.api).toMatchObject({ committed: false, message: 'No changes to commit' });
    expect(result.repos!.web.committed).toBe(true);
    expect(result.sha).toBe(result.repos!.web.sha);
    expect(result.message).toBe(result.repos!.web.message);
    expect(result.message).toBe(message);
  });

  it("refuses to commit when a manifest repo worktree is no longer registered", async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({
      runId: "commit-missing-composite",
      repoIds: ["api", "web"],
    });

    await fixture.apiGit.raw(["worktree", "remove", created.repos!.api.path, "--force"]);

    const result = await fixture.service.commit(created.runId, testCommitMessage('feat: should not commit'));

    expect(result.committed).toBe(false);
    expect(result.error).toContain("api: Worktree not found");
    expect(result.repos!.api.message).toBe("Worktree not found");
  });

  it('uses the first failed repo message/sha/error when an earlier repo is unchanged and a later repo fails', async () => {
    const fixture = await createCompositeFixture();
    const created = await fixture.service.create({
      runId: 'commit-composite-later-fail',
      repoIds: ['api', 'web'],
    });
    await fs.writeFile(path.join(created.repos!.web.path, 'w.txt'), 'w\n', 'utf-8');
    await fixture.webGit.raw(['worktree', 'remove', created.repos!.web.path, '--force']);

    const result = await fixture.service.commit(created.runId, testCommitMessage('feat: later fail'));

    expect(result.committed).toBe(false);
    expect(result.partial).toBeUndefined();
    expect(result.repos!.api).toMatchObject({ committed: false, message: 'No changes to commit' });
    expect(result.repos!.web.committed).toBe(false);
    expect(result.repos!.web.message).not.toBe('No changes to commit');
    expect(result.error).toContain('web');
    expect(result.message).toBe(result.repos!.web.message);
    expect(result.sha).toBe(result.repos!.web.sha);
    expect(result.message).not.toBe('No changes to commit');
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
      const result = await service.commit(runId, testCommitMessage(`chore: ${file}`));
    expect(result.committed).toBe(true);
  }

  async function commitNetZeroChangeInCompositeRepo(
    service: AdhocWorktreeService,
    runId: string,
    repoPath: string,
  ): Promise<void> {
    await fs.writeFile(path.join(repoPath, "tracked.txt"), "transient composite change\n", "utf-8");
    const transient = await service.commit(runId, testCommitMessage('chore: transient composite change'));
    expect(transient.committed).toBe(true);
    await fs.writeFile(path.join(repoPath, "tracked.txt"), "base\n", "utf-8");
    const reverted = await service.commit(runId, testCommitMessage('revert: transient composite change'));
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
    await fixture.service.commit(created.runId, testCommitMessage('feat: changes in both repos'));

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
    await fixture.service.commit(created.runId, testCommitMessage('feat: api change only'));

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
    await fixture.service.commit(created.runId, testCommitMessage('feat: first composite source commits'));
    await fs.writeFile(path.join(created.repos!.web.path, 'tracked.txt'), 'task side\n', 'utf-8');
    await fixture.service.commit(created.runId, testCommitMessage('feat: conflicting second web source commit'));

    await fs.writeFile(path.join(fixture.repos[1].path, 'tracked.txt'), 'main side\n', 'utf-8');
    await fixture.webGit.add('-A');
    await fixture.webGit.commit(testCommitMessage('feat: conflicting web target commit'));
    const before = {
      api: (await fixture.apiGit.revparse(['HEAD'])).trim(),
      web: (await fixture.webGit.revparse(['HEAD'])).trim(),
    };

    const result = await fixture.service.merge(created.runId, 'rebase');

    expect(result.success).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.repos!.api).toMatchObject({ success: true, merged: true });
    expect(result.repos!.web).toMatchObject({ success: false, merged: false, conflictState: 'aborted' });
    expect((await fixture.apiGit.revparse(['HEAD'])).trim()).not.toBe(before.api);
    expect((await fixture.webGit.revparse(['HEAD'])).trim()).toBe(before.web);
    expect((await fixture.webGit.status()).isClean()).toBe(true);
  });
});
