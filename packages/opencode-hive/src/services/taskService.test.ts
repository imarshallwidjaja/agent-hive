import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import { TaskService } from "./taskService";
import { FeatureService } from "./featureService";
import { PlanService } from "./planService";
import { getTaskPath, getTaskStatusPath, getTaskReportPath } from "../utils/paths";

const TEST_ROOT = "/tmp/hive-test-task";

describe("TaskService", () => {
  let taskService: TaskService;
  let featureService: FeatureService;
  let planService: PlanService;

  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    featureService = new FeatureService(TEST_ROOT);
    planService = new PlanService(TEST_ROOT);
    taskService = new TaskService(TEST_ROOT);
    featureService.create("test-feature");
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  describe("sync", () => {
    it("throws when no plan exists", () => {
      featureService.create("no-plan");
      expect(() => taskService.sync("no-plan")).toThrow();
    });

    it("creates tasks from plan", () => {
      planService.write("test-feature", `# Plan

## Tasks

### 1. Setup Database
Description

### 2. Create API
Description
`);

      const result = taskService.sync("test-feature");

      expect(result.created).toContain("01-setup-database");
      expect(result.created).toContain("02-create-api");
      expect(result.created.length).toBe(2);
    });

    it("keeps done tasks even if removed from plan", () => {
      planService.write("test-feature", `# Plan\n\n## Tasks\n\n### 1. First Task\nDesc`);
      taskService.sync("test-feature");
      taskService.update("test-feature", "01-first-task", { status: "done" });

      planService.write("test-feature", `# Plan\n\n## Tasks\n\n### 1. Different Task\nDesc`);
      const result = taskService.sync("test-feature");

      expect(result.kept).toContain("01-first-task");
    });

    it("removes cancelled tasks", () => {
      planService.write("test-feature", `# Plan\n\n## Tasks\n\n### 1. Task One\nDesc`);
      taskService.sync("test-feature");
      taskService.update("test-feature", "01-task-one", { status: "cancelled" });

      const result = taskService.sync("test-feature");

      expect(result.removed).toContain("01-task-one");
    });

    it("preserves manual tasks", () => {
      planService.write("test-feature", `# Plan\n\n## Tasks\n\n### 1. Plan Task\nDesc`);
      taskService.sync("test-feature");
      taskService.create("test-feature", "manual-task");

      const result = taskService.sync("test-feature");

      expect(result.manual).toContain("02-manual-task");
    });
  });

  describe("create", () => {
    it("creates a manual task", () => {
      const folder = taskService.create("test-feature", "my-task");

      expect(folder).toBe("01-my-task");
      expect(fs.existsSync(getTaskPath(TEST_ROOT, "test-feature", folder))).toBe(true);
    });

    it("auto-increments order", () => {
      taskService.create("test-feature", "first");
      taskService.create("test-feature", "second");
      const third = taskService.create("test-feature", "third");

      expect(third).toBe("03-third");
    });

    it("respects explicit order", () => {
      const folder = taskService.create("test-feature", "specific", 10);

      expect(folder).toBe("10-specific");
    });

    it("creates task with pending status and manual origin", () => {
      const folder = taskService.create("test-feature", "test");
      const task = taskService.get("test-feature", folder);

      expect(task?.status).toBe("pending");
      expect(task?.origin).toBe("manual");
    });
  });

  describe("update", () => {
    it("updates task status", () => {
      const folder = taskService.create("test-feature", "task");

      taskService.update("test-feature", folder, { status: "in_progress" });

      const task = taskService.get("test-feature", folder);
      expect(task?.status).toBe("in_progress");
    });

    it("sets startedAt when status becomes in_progress", () => {
      const folder = taskService.create("test-feature", "task");

      taskService.update("test-feature", folder, { status: "in_progress" });

      const statusPath = getTaskStatusPath(TEST_ROOT, "test-feature", folder);
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
      expect(status.startedAt).toBeDefined();
    });

    it("sets completedAt when status becomes done", () => {
      const folder = taskService.create("test-feature", "task");

      taskService.update("test-feature", folder, { status: "done" });

      const statusPath = getTaskStatusPath(TEST_ROOT, "test-feature", folder);
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
      expect(status.completedAt).toBeDefined();
    });

    it("updates summary", () => {
      const folder = taskService.create("test-feature", "task");

      taskService.update("test-feature", folder, { summary: "Completed setup" });

      const task = taskService.get("test-feature", folder);
      expect(task?.summary).toBe("Completed setup");
    });

    it("throws for non-existing task", () => {
      expect(() => taskService.update("test-feature", "nope", { status: "done" })).toThrow();
    });
  });

  describe("get", () => {
    it("returns task info", () => {
      const folder = taskService.create("test-feature", "my-task");

      const task = taskService.get("test-feature", folder);

      expect(task).not.toBeNull();
      expect(task!.folder).toBe("01-my-task");
      expect(task!.name).toBe("my-task");
      expect(task!.status).toBe("pending");
      expect(task!.origin).toBe("manual");
    });

    it("returns null for non-existing task", () => {
      expect(taskService.get("test-feature", "nope")).toBeNull();
    });
  });

  describe("list", () => {
    it("returns empty array when no tasks", () => {
      expect(taskService.list("test-feature")).toEqual([]);
    });

    it("returns all tasks sorted", () => {
      taskService.create("test-feature", "third", 3);
      taskService.create("test-feature", "first", 1);
      taskService.create("test-feature", "second", 2);

      const tasks = taskService.list("test-feature");

      expect(tasks.length).toBe(3);
      expect(tasks[0].folder).toBe("01-first");
      expect(tasks[1].folder).toBe("02-second");
      expect(tasks[2].folder).toBe("03-third");
    });
  });

  describe("writeReport", () => {
    it("writes report file", () => {
      const folder = taskService.create("test-feature", "task");
      const report = "## Summary\n\nCompleted the task successfully.";

      taskService.writeReport("test-feature", folder, report);

      const reportPath = getTaskReportPath(TEST_ROOT, "test-feature", folder);
      expect(fs.readFileSync(reportPath, "utf-8")).toBe(report);
    });
  });
});
