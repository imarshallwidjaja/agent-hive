import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { WorktreeService } from "./worktreeService";

const TEST_ROOT = "/tmp/hive-test-worktree";

describe("WorktreeService", () => {
  let service: WorktreeService;

  beforeEach(async () => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    
    const { execSync } = await import("child_process");
    execSync("git init", { cwd: TEST_ROOT });
    execSync("git config user.email 'test@test.com'", { cwd: TEST_ROOT });
    execSync("git config user.name 'Test'", { cwd: TEST_ROOT });
    fs.writeFileSync(path.join(TEST_ROOT, "README.md"), "# Test");
    execSync("git add . && git commit -m 'init'", { cwd: TEST_ROOT });
    
    service = new WorktreeService({ baseDir: TEST_ROOT, hiveDir: path.join(TEST_ROOT, ".hive") });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a worktree", async () => {
      const result = await service.create("my-feature", "01-setup");

      expect(result.path).toContain(".hive/.worktrees/my-feature/01-setup");
      expect(result.branch).toBe("hive/my-feature/01-setup");
      expect(fs.existsSync(result.path)).toBe(true);
    });

    it("worktree contains files from base branch", async () => {
      const result = await service.create("my-feature", "01-setup");

      expect(fs.existsSync(path.join(result.path, "README.md"))).toBe(true);
    });
  });

  describe("get", () => {
    it("returns null for non-existing worktree", async () => {
      const result = await service.get("nope", "nope");
      expect(result).toBeNull();
    });

    it("returns worktree info after creation", async () => {
      await service.create("my-feature", "01-task");

      const result = await service.get("my-feature", "01-task");

      expect(result).not.toBeNull();
      expect(result!.feature).toBe("my-feature");
      expect(result!.step).toBe("01-task");
    });
  });

  describe("list", () => {
    it("returns empty array when no worktrees", async () => {
      const result = await service.list();
      expect(result).toEqual([]);
    });

    it("lists all worktrees", async () => {
      await service.create("feature-a", "01-task");
      await service.create("feature-b", "01-task");

      const result = await service.list();

      expect(result.length).toBe(2);
    });

    it("filters by feature", async () => {
      await service.create("feature-a", "01-task");
      await service.create("feature-a", "02-task");
      await service.create("feature-b", "01-task");

      const result = await service.list("feature-a");

      expect(result.length).toBe(2);
      expect(result.every(w => w.feature === "feature-a")).toBe(true);
    });
  });

  describe("remove", () => {
    it("removes worktree", async () => {
      const created = await service.create("my-feature", "01-task");
      expect(fs.existsSync(created.path)).toBe(true);

      await service.remove("my-feature", "01-task");

      expect(fs.existsSync(created.path)).toBe(false);
    });

    it("removes branch when deleteBranch is true", async () => {
      await service.create("my-feature", "01-task");
      const { execSync } = await import("child_process");

      await service.remove("my-feature", "01-task", true);

      const branches = execSync("git branch", { cwd: TEST_ROOT, encoding: "utf-8" });
      expect(branches).not.toContain("hive/my-feature/01-task");
    });
  });

  describe("getDiff", () => {
    it("returns empty diff when no changes", async () => {
      await service.create("my-feature", "01-task");

      const diff = await service.getDiff("my-feature", "01-task");

      expect(diff.hasDiff).toBe(false);
      expect(diff.diffContent).toBe("");
      expect(diff.filesChanged).toEqual([]);
    });

    it("returns diff when files changed", async () => {
      const worktree = await service.create("my-feature", "01-task");
      fs.writeFileSync(path.join(worktree.path, "new-file.txt"), "content");
      const { execSync } = await import("child_process");
      execSync("git add .", { cwd: worktree.path });
      execSync("git commit -m 'add file'", { cwd: worktree.path });

      const diff = await service.getDiff("my-feature", "01-task");

      expect(diff.hasDiff).toBe(true);
      expect(diff.filesChanged).toContain("new-file.txt");
    });
  });

  describe("cleanup", () => {
    it("removes invalid worktrees for a feature", async () => {
      const wt1 = await service.create("cleanup-test", "01-task");
      const wt2 = await service.create("cleanup-test", "02-task");

      fs.writeFileSync(path.join(wt1.path, ".git"), "gitdir: /nonexistent\n");
      fs.writeFileSync(path.join(wt2.path, ".git"), "gitdir: /nonexistent\n");

      expect(fs.existsSync(wt1.path)).toBe(true);
      expect(fs.existsSync(wt2.path)).toBe(true);

      const result = await service.cleanup("cleanup-test");

      expect(result.removed.length).toBe(2);
      expect(fs.existsSync(wt1.path)).toBe(false);
      expect(fs.existsSync(wt2.path)).toBe(false);

      const remaining = await service.list("cleanup-test");
      expect(remaining).toEqual([]);
    });
  });
});
