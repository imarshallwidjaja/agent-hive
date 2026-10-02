import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "node:child_process";
import { TaskService, TaskUpdatePersistenceError, TASK_STATUS_SCHEMA_VERSION } from "./taskService";
import { PlanService } from "./planService";
import { SubtaskService } from "./subtaskService";
import { TaskUpdatePersistenceError as PublicTaskUpdatePersistenceError } from "../index";
import type { TaskUpdateInput as PublicTaskUpdateInput, TaskUpdateResult as PublicTaskUpdateResult } from "../index";
import { TaskStatus } from "../types";
import { getLockPath, readJson } from "../utils/paths";

const TEST_DIR = "/tmp/hive-core-taskservice-test-" + process.pid;
const PROJECT_ROOT = TEST_DIR;

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

function setupFeature(featureName: string): void {
  const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
  fs.mkdirSync(featurePath, { recursive: true });

  // Create a minimal feature.json
  fs.writeFileSync(
    path.join(featurePath, "feature.json"),
    JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
  );

  // Create plan.md with a task
  fs.writeFileSync(
    path.join(featurePath, "plan.md"),
    `# Plan\n\n## Tasks\n\n### 1. Test Task\n\nDescription of the test task.\n`
  );
}

function setupTask(featureName: string, taskFolder: string, status: Partial<TaskStatus> = {}): void {
  const taskPath = path.join(TEST_DIR, ".hive", "features", featureName, "tasks", taskFolder);
  fs.mkdirSync(taskPath, { recursive: true });

  const taskStatus: TaskStatus = {
    status: "pending",
    origin: "plan",
    planTitle: "Test Task",
    ...status,
  };

  fs.writeFileSync(path.join(taskPath, "status.json"), JSON.stringify(taskStatus, null, 2));
}

describe("TaskService", () => {
  let service: TaskService;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    service = new TaskService(PROJECT_ROOT);
  });

  afterEach(() => {
    cleanup();
  });

  it("inspects retained folders with missing, malformed, and unreadable status without inventing pending state", () => {
    const featureName = "status-integrity";
    setupFeature(featureName);
    for (const folder of ["01-missing", "02-malformed", "03-unreadable", "04-null", "05-valid"]) setupTask(featureName, folder);
    const taskPath = (folder: string) => path.join(TEST_DIR, ".hive", "features", featureName, "tasks", folder);
    fs.writeFileSync(path.join(taskPath("01-missing"), "spec.md"), "Retained spec.\n");
    fs.writeFileSync(path.join(taskPath("01-missing"), "handoff.md"), "Retained handoff.\n");
    fs.rmSync(path.join(taskPath("01-missing"), "status.json"));
    fs.writeFileSync(path.join(taskPath("02-malformed"), "status.json"), "{bad json");
    fs.rmSync(path.join(taskPath("03-unreadable"), "status.json"));
    fs.mkdirSync(path.join(taskPath("03-unreadable"), "status.json"));
    fs.writeFileSync(path.join(taskPath("04-null"), "status.json"), "null");

    const entries = service.listStatusEntries(featureName);
    expect(entries.map(entry => entry.folder)).toEqual(["01-missing", "02-malformed", "03-unreadable", "04-null", "05-valid"]);
    expect(entries[0]).toEqual({ folder: "01-missing", name: "missing", status: null, integrity: { reason: "status_missing" } });
    for (const entry of entries.slice(1, 4)) {
      expect(entry).toMatchObject({ status: null, integrity: { reason: "status_unreadable", error: expect.any(String) } });
      expect(entry).not.toHaveProperty("dependsOn");
    }
    expect(entries[4]).toMatchObject({ status: "pending", dependsOn: [] });
    expect(fs.readFileSync(path.join(taskPath("01-missing"), "spec.md"), "utf8")).toBe("Retained spec.\n");
    expect(fs.readFileSync(path.join(taskPath("01-missing"), "handoff.md"), "utf8")).toBe("Retained handoff.\n");
  });

  it("delegates the subtask lifecycle while preserving both public slug contracts", () => {
    const featureName = "subtask-lifecycle";
    setupFeature(featureName);
    setupTask(featureName, "01-task-api");
    setupTask(featureName, "02-subtask-api");

    const taskSlash = service.createSubtask(featureName, "01-task-api", "API / UI", "implement");
    const taskUnderscore = service.createSubtask(featureName, "01-task-api", "Hello_World");
    expect([taskSlash.folder, taskUnderscore.folder]).toEqual(["1-api-ui", "2-hello-world"]);
    expect(service.listSubtasks(featureName, "01-task-api")).toHaveLength(2);
    expect(service.getSubtask(featureName, "01-task-api", taskSlash.id)).toMatchObject({
      folder: "1-api-ui",
      status: "pending",
      type: "implement",
    });

    expect(service.writeSubtaskSpec(featureName, "01-task-api", taskSlash.id, "spec")).toEndWith("/spec.md");
    expect(service.writeSubtaskReport(featureName, "01-task-api", taskSlash.id, "report")).toEndWith("/report.md");
    expect(service.readSubtaskSpec(featureName, "01-task-api", taskSlash.id)).toBe("spec");
    expect(service.readSubtaskReport(featureName, "01-task-api", taskSlash.id)).toBe("report");
    expect(service.updateSubtask(featureName, "01-task-api", taskSlash.id, "done")).toMatchObject({
      status: "done",
      completedAt: expect.any(String),
    });
    service.deleteSubtask(featureName, "01-task-api", taskSlash.id);
    expect(service.getSubtask(featureName, "01-task-api", taskSlash.id)).toBeNull();
    expect(service.readSubtaskSpec(featureName, "01-task-api", taskSlash.id)).toBeNull();
    expect(() => service.updateSubtask(featureName, "01-task-api", taskSlash.id, "done"))
      .toThrow("Subtask '1.1' not found in task '01-task-api'");
    expect(() => service.writeSubtaskReport(featureName, "01-task-api", taskSlash.id, "missing"))
      .toThrow("Subtask '1.1' not found in task '01-task-api'");
    expect(() => service.deleteSubtask(featureName, "01-task-api", taskSlash.id))
      .toThrow("Subtask '1.1' not found in task '01-task-api'");

    const publicSubtasks = new SubtaskService(PROJECT_ROOT);
    expect(publicSubtasks.create(featureName, "02-subtask-api", "API / UI").folder).toBe("1-api--ui");
    expect(publicSubtasks.create(featureName, "02-subtask-api", "Hello_World").folder).toBe("2-helloworld");
  });

  describe("update", () => {
    it("updates task status with locked atomic write", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task");

      const result = service.update(featureName, "01-test-task", {
        status: "in_progress",
      });

      expect(result.status).toBe("in_progress");
      expect(result.startedAt).toBeDefined();
      expect(result.schemaVersion).toBe(TASK_STATUS_SCHEMA_VERSION);

      // Verify no lock file remains
      const statusPath = path.join(
        TEST_DIR,
        ".hive",
        "features",
        featureName,
        "tasks",
        "01-test-task",
        "status.json"
      );
      expect(fs.existsSync(getLockPath(statusPath))).toBe(false);
    });

    it("renews completedAt only when transitioning from a non-done status to done", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      const completionTimes = [
        new Date("2026-09-01T00:00:00.000Z"),
        new Date("2026-09-03T00:00:00.000Z"),
      ];
      service = new TaskService(PROJECT_ROOT, () => completionTimes.shift()!);
      setupTask(featureName, "01-test-task", { startedAt: "2026-08-31T00:00:00.000Z" });

      const firstCompletion = service.update(featureName, "01-test-task", {
        status: "done",
        summary: "Task completed successfully",
      });
      const idempotentCompletion = service.update(featureName, "01-test-task", {
        status: "done",
        summary: "Task remains complete",
      });
      const reopened = service.update(featureName, "01-test-task", {
        status: "failed",
        summary: "Verification failed after completion",
      });
      const finalCompletion = service.update(featureName, "01-test-task", {
        status: "done",
        summary: "Task completed successfully on retry",
      });

      expect(firstCompletion.completedAt).toBe("2026-09-01T00:00:00.000Z");
      expect(idempotentCompletion.completedAt).toBe(firstCompletion.completedAt);
      expect(reopened.completedAt).toBe(firstCompletion.completedAt);
      expect(finalCompletion.status).toBe("done");
      expect(finalCompletion.completedAt).toBe("2026-09-03T00:00:00.000Z");
      expect(finalCompletion.summary).toBe("Task completed successfully on retry");
      expect(completionTimes).toHaveLength(0);
    });

    it("throws error for non-existent task without creating task folder", () => {
      const featureName = "test-feature";
      const missingTask = "nonexistent-task";
      setupFeature(featureName);
      const missingTaskPath = path.join(
        TEST_DIR,
        ".hive",
        "features",
        featureName,
        "tasks",
        missingTask
      );

      expect(fs.existsSync(missingTaskPath)).toBe(false);

      expect(() =>
        service.update(featureName, missingTask, { status: "in_progress" })
      ).toThrow(/not found/);

      expect(fs.existsSync(missingTaskPath)).toBe(false);
    });

    it("surfaces corrupt task status instead of treating it as missing", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task");
      const statusPath = path.join(
        TEST_DIR, ".hive", "features", featureName, "tasks", "01-test-task", "status.json"
      );
      fs.writeFileSync(statusPath, JSON.stringify({ status: "unknown", origin: "plan" }));

      expect(() => service.update(featureName, "01-test-task", {
        summary: "Must not publish",
      })).toThrow(/corrupt status file/i);
      expect(JSON.parse(fs.readFileSync(statusPath, "utf8"))).toEqual({
        status: "unknown",
        origin: "plan",
      });
    });

    it("wraps truncated task status JSON with task and path context", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task");
      const statusPath = path.join(
        TEST_DIR, ".hive", "features", featureName, "tasks", "01-test-task", "status.json"
      );
      fs.writeFileSync(statusPath, '{"status":');

      expect(() => service.update(featureName, "01-test-task", { summary: "Must not publish" }))
        .toThrow(new RegExp(`01-test-task.*corrupt status file.*${statusPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
    });

    it("does not steal an existing status lock based on age", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task");
      const statusPath = path.join(
        TEST_DIR, ".hive", "features", featureName, "tasks", "01-test-task", "status.json"
      );
      const lockPath = getLockPath(statusPath);
      fs.writeFileSync(lockPath, "held by another writer");
      fs.utimesSync(lockPath, new Date(0), new Date(0));

      expect(() => service.update(featureName, "01-test-task", {
        summary: "Must wait",
      }, {
        timeout: 5,
        retryInterval: 1,
        staleLockTTL: 0,
      })).toThrow(/failed to acquire lock/i);
      expect(fs.readFileSync(lockPath, "utf8")).toBe("held by another writer");
    });

    it("preserves existing fields on update", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task", {
        planTitle: "Original Title",
        baseCommit: "abc123",
      });

      const result = service.update(featureName, "01-test-task", {
        status: "in_progress",
      });

      expect(result.planTitle).toBe("Original Title");
      expect(result.baseCommit).toBe("abc123");
    });

    it("patches only supplied fields and supports explicit blocker clearing", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task", {
        status: "blocked",
        summary: "Existing summary",
        blocker: { reason: "Needs a decision" },
      });

      const summaryOnly = service.update(featureName, "01-test-task", {
        summary: "Revised summary",
      });
      expect(summaryOnly.status).toBe("blocked");
      expect(summaryOnly.blocker).toEqual({ reason: "Needs a decision" });

      const cleared = service.update(featureName, "01-test-task", { blocker: null });
      expect(cleared.status).toBe("blocked");
      expect(cleared.summary).toBe("Revised summary");
      expect(cleared.blocker).toBeUndefined();
    });

    it("rejects invalid runtime status values", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task");

      expect(() => service.update(featureName, "01-test-task", {
        status: "completed" as any,
      })).toThrow(/invalid task status.*completed/i);
    });

    it("publishes report-only updates as numeric history and latest while preserving old finalization reports", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task", {
        status: "blocked",
        summary: "Keep this summary",
        blocker: { reason: "Keep this blocker" },
      });
      const taskPath = path.join(TEST_DIR, ".hive", "features", featureName, "tasks", "01-test-task");
      const reportsPath = path.join(taskPath, "reports");
      fs.mkdirSync(reportsPath, { recursive: true });
      fs.writeFileSync(path.join(reportsPath, "finalization-old.md"), "old finalization");

      const first = service.update(featureName, "01-test-task", { report: "first report" });
      const second = service.update(featureName, "01-test-task", { report: "second report" });

      expect(first.reportPath).toBe(path.join(reportsPath, "1.md"));
      expect(second.reportPath).toBe(path.join(reportsPath, "2.md"));
      expect(fs.readFileSync(path.join(reportsPath, "1.md"), "utf8")).toBe("first report");
      expect(fs.readFileSync(path.join(reportsPath, "2.md"), "utf8")).toBe("second report");
      expect(fs.readFileSync(path.join(taskPath, "report.md"), "utf8")).toBe("second report");
      expect(fs.readFileSync(path.join(reportsPath, "finalization-old.md"), "utf8")).toBe("old finalization");
      expect(second.status).toBe("blocked");
      expect(second.summary).toBe("Keep this summary");
      expect(second.blocker).toEqual({ reason: "Keep this blocker" });
    });

    it("exports task update contracts from the package root", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task");
      const input: PublicTaskUpdateInput = { report: "public report" };
      const result: PublicTaskUpdateResult = service.update(featureName, "01-test-task", input);

      expect(PublicTaskUpdatePersistenceError).toBe(TaskUpdatePersistenceError);
      expect(result.reportPath).toEndWith("/reports/1.md");
    });

    it("syncs a newly created reports directory entry before publishing report history", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task");
      const taskPath = path.join(TEST_DIR, ".hive", "features", featureName, "tasks", "01-test-task");
      const reportPath = path.join(taskPath, "reports", "1.md");
      const descriptorPaths = new Map<number, string>();
      const events: string[] = [];
      const originalOpen = fs.openSync;
      const originalFsync = fs.fsyncSync;
      const originalRename = fs.renameSync;
      const openSpy = spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
        const descriptor = originalOpen(target, flags, mode);
        descriptorPaths.set(descriptor, String(target));
        return descriptor;
      }) as typeof fs.openSync);
      const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((descriptor => {
        events.push(`fsync:${descriptorPaths.get(descriptor)}`);
        originalFsync(descriptor);
      }) as typeof fs.fsyncSync);
      const renameSpy = spyOn(fs, "renameSync").mockImplementation(((source, destination) => {
        events.push(`rename:${String(destination)}`);
        originalRename(source, destination);
      }) as typeof fs.renameSync);

      try {
        service.update(featureName, "01-test-task", { report: "durable report" });
      } finally {
        renameSpy.mockRestore();
        fsyncSpy.mockRestore();
        openSpy.mockRestore();
      }

      if (process.platform !== "win32") {
        expect(events.indexOf(`fsync:${taskPath}`)).toBeGreaterThanOrEqual(0);
        expect(events.indexOf(`fsync:${taskPath}`)).toBeLessThan(events.indexOf(`rename:${reportPath}`));
      }
    });

    it("reports partial persistence when latest report publication fails", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task", { summary: "Original" });
      const taskPath = path.join(TEST_DIR, ".hive", "features", featureName, "tasks", "01-test-task");
      fs.mkdirSync(path.join(taskPath, "report.md"));

      let thrown: unknown;
      try {
        service.update(featureName, "01-test-task", {
          status: "done",
          summary: "Updated",
          report: "durable history",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TaskUpdatePersistenceError);
      const persistenceError = thrown as TaskUpdatePersistenceError;
      expect(persistenceError.failedStage).toBe("latest_report");
      expect(persistenceError.reportHistoryWritten).toBe(true);
      expect(persistenceError.latestReportWritten).toBe(false);
      expect(persistenceError.failedWritePublished).toBe(false);
      expect(fs.readFileSync(path.join(taskPath, "reports", "1.md"), "utf8")).toBe("durable history");
      expect(service.getRawStatus(featureName, "01-test-task")).toMatchObject({
        status: "pending",
        summary: "Original",
      });
    });

    // Directory fsync is a no-op on Windows, so the post-rename failure cannot occur there.
    it.skipIf(process.platform === "win32")("reports a published report history copy when durability fails after the rename", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task", { summary: "Original" });
      const taskPath = path.join(TEST_DIR, ".hive", "features", featureName, "tasks", "01-test-task");
      const reportsPath = path.join(taskPath, "reports");
      const descriptorPaths = new Map<number, string>();
      const originalOpen = fs.openSync;
      const originalFsync = fs.fsyncSync;
      const openSpy = spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
        const descriptor = originalOpen(target, flags, mode);
        descriptorPaths.set(descriptor, String(target));
        return descriptor;
      }) as typeof fs.openSync);
      const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((descriptor => {
        if (descriptorPaths.get(descriptor) === reportsPath) throw new Error("reports directory fsync failed");
        originalFsync(descriptor);
      }) as typeof fs.fsyncSync);
      let thrown: unknown;

      try {
        service.update(featureName, "01-test-task", { status: "done", report: "published history" });
      } catch (error) {
        thrown = error;
      } finally {
        fsyncSpy.mockRestore();
        openSpy.mockRestore();
      }

      expect(thrown).toBeInstanceOf(TaskUpdatePersistenceError);
      const persistenceError = thrown as TaskUpdatePersistenceError;
      expect(persistenceError.failedStage).toBe("report_history");
      expect(persistenceError.message).toBe("Task update failed while writing report_history. The destination was published, but durability is uncertain.");
      expect(persistenceError.reportHistoryWritten).toBe(false);
      expect(persistenceError.failedWritePublished).toBe(true);
      expect(persistenceError.reportPath).toBe(path.join(reportsPath, "1.md"));
      expect(fs.readFileSync(persistenceError.reportPath!, "utf8")).toBe("published history");
      expect(persistenceError.latestReportWritten).toBe(false);
      expect(fs.existsSync(path.join(taskPath, "report.md"))).toBe(false);
      expect(service.getRawStatus(featureName, "01-test-task")).toMatchObject({ status: "pending", summary: "Original" });
    });

    it("reports status-stage partial persistence without leaking report fields into status", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task", { summary: "Original" });
      const taskPath = path.join(TEST_DIR, ".hive", "features", featureName, "tasks", "01-test-task");
      const statusPath = path.join(taskPath, "status.json");
      const originalRename = fs.renameSync;
      const renameSpy = spyOn(fs, "renameSync").mockImplementation(((source, destination) => {
        if (String(destination) === statusPath) throw new Error("status rename failed");
        originalRename(source, destination);
      }) as typeof fs.renameSync);
      let thrown: unknown;

      try {
        service.update(featureName, "01-test-task", {
          status: "done",
          summary: "Updated",
          report: "published report",
          handoff: "next steps",
        });
      } catch (error) {
        thrown = error;
      } finally {
        renameSpy.mockRestore();
      }

      expect(thrown).toBeInstanceOf(TaskUpdatePersistenceError);
      const persistenceError = thrown as TaskUpdatePersistenceError;
      expect(persistenceError.failedStage).toBe("status");
      expect(persistenceError.reportHistoryWritten).toBe(true);
      expect(persistenceError.latestReportWritten).toBe(true);
      expect(persistenceError.handoffWritten).toBe(true);
      expect(persistenceError.failedWritePublished).toBe(false);
      expect(persistenceError.reportPath).toBe(path.join(taskPath, "reports", "1.md"));
      expect(persistenceError.latestReportPath).toBe(path.join(taskPath, "report.md"));
      expect(persistenceError.handoffPath).toBe(path.join(taskPath, "handoff.md"));
      expect(fs.readFileSync(persistenceError.handoffPath!, "utf8")).toBe("next steps");
      expect(fs.readFileSync(persistenceError.reportPath!, "utf8")).toBe("published report");
      expect(fs.readFileSync(persistenceError.latestReportPath!, "utf8")).toBe("published report");
      const stored = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      expect(stored).toMatchObject({ status: "pending", summary: "Original" });
      expect(stored).not.toHaveProperty("report");
      expect(stored).not.toHaveProperty("reportPath");
      expect(stored).not.toHaveProperty("latestReportPath");
    });

    it("persists a handoff without touching status fields or reports, and keeps it across later updates", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task", {
        status: "blocked",
        summary: "Keep this summary",
        blocker: { reason: "Keep this blocker" },
      });
      const taskPath = path.join(TEST_DIR, ".hive", "features", featureName, "tasks", "01-test-task");
      const handoffPath = path.join(taskPath, "handoff.md");

      const first = service.update(featureName, "01-test-task", { handoff: "Start from the parser; tests pin folder identity." });

      expect(first.handoffPath).toBe(handoffPath);
      expect(first.reportPath).toBeUndefined();
      expect(fs.readFileSync(handoffPath, "utf8")).toBe("Start from the parser; tests pin folder identity.");
      expect(service.getRawStatus(featureName, "01-test-task")).toMatchObject({
        status: "blocked",
        summary: "Keep this summary",
        blocker: { reason: "Keep this blocker" },
      });
      expect(service.getRawStatus(featureName, "01-test-task")).not.toHaveProperty("handoff");
      expect(fs.existsSync(path.join(taskPath, "reports"))).toBe(false);
      expect(fs.existsSync(path.join(taskPath, "report.md"))).toBe(false);

      const later = service.update(featureName, "01-test-task", { status: "done", summary: "Finished", report: "final report" });
      expect(later.handoffPath).toBeUndefined();
      expect(fs.readFileSync(handoffPath, "utf8")).toBe("Start from the parser; tests pin folder identity.");

      service.update(featureName, "01-test-task", { handoff: "Latest handoff wins." });
      expect(fs.readFileSync(handoffPath, "utf8")).toBe("Latest handoff wins.");
      expect(service.getRawStatus(featureName, "01-test-task")).toMatchObject({ status: "done", summary: "Finished" });
    });

    it("rejects blank and oversize handoffs before any write", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task", { summary: "Original" });
      const taskPath = path.join(TEST_DIR, ".hive", "features", featureName, "tasks", "01-test-task");
      const statusBefore = fs.readFileSync(path.join(taskPath, "status.json"), "utf8");
      // 1025 two-byte characters: under 2048 UTF-16 units, over 2048 UTF-8 bytes.
      const oversize = "\u00e9".repeat(1025);
      const assertRejectedWithoutWrites = () => {
        expect(fs.existsSync(path.join(taskPath, "handoff.md"))).toBe(false);
        expect(fs.existsSync(path.join(taskPath, "reports"))).toBe(false);
        expect(fs.readFileSync(path.join(taskPath, "status.json"), "utf8")).toBe(statusBefore);
      };

      expect(() => service.update(featureName, "01-test-task", { handoff: "   \n" })).toThrow("Task handoff cannot be blank");
      assertRejectedWithoutWrites();
      expect(() => service.update(featureName, "01-test-task", { status: "done", report: "report", handoff: oversize })).toThrow(
        "Task handoff is 2050 UTF-8 bytes; the limit is 2048. Shorten it; handoffs are not truncated.",
      );
      assertRejectedWithoutWrites();
      expect(() => service.update(featureName, "01-test-task", { handoff: "" })).toThrow("Task handoff cannot be blank");
      assertRejectedWithoutWrites();

      expect(service.update(featureName, "01-test-task", { handoff: "a".repeat(2048) }).handoffPath).toBe(path.join(taskPath, "handoff.md"));
      fs.rmSync(path.join(taskPath, "handoff.md"));
    });

    it("reports handoff-stage partial persistence after reports are published", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task", { summary: "Original" });
      const taskPath = path.join(TEST_DIR, ".hive", "features", featureName, "tasks", "01-test-task");
      fs.mkdirSync(path.join(taskPath, "handoff.md"));
      let thrown: unknown;

      try {
        service.update(featureName, "01-test-task", { status: "done", report: "published report", handoff: "next steps" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TaskUpdatePersistenceError);
      const persistenceError = thrown as TaskUpdatePersistenceError;
      expect(persistenceError.failedStage).toBe("handoff");
      expect(persistenceError.message).toBe("Task update failed while writing handoff. The destination was not published.");
      expect(persistenceError.reportHistoryWritten).toBe(true);
      expect(persistenceError.latestReportWritten).toBe(true);
      expect(persistenceError.handoffPath).toBe(path.join(taskPath, "handoff.md"));
      expect(persistenceError.handoffWritten).toBe(false);
      expect(persistenceError.failedWritePublished).toBe(false);
      expect(service.getRawStatus(featureName, "01-test-task")).toMatchObject({ status: "pending", summary: "Original" });
    });

    it("wraps report history setup failures with no writes reported", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task");
      const taskPath = path.join(TEST_DIR, ".hive", "features", featureName, "tasks", "01-test-task");
      fs.writeFileSync(path.join(taskPath, "reports"), "not a directory");
      let thrown: unknown;

      try {
        service.update(featureName, "01-test-task", { report: "must not publish" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TaskUpdatePersistenceError);
      const persistenceError = thrown as TaskUpdatePersistenceError;
      expect(persistenceError.failedStage).toBe("report_history");
      expect(persistenceError.reportHistoryWritten).toBe(false);
      expect(persistenceError.latestReportWritten).toBe(false);
      expect(persistenceError.failedWritePublished).toBe(false);
      expect(persistenceError.reportPath).toBeUndefined();
      expect(persistenceError.latestReportPath).toBe(path.join(taskPath, "report.md"));
    });

    it("serializes concurrent report updates into immutable numeric history", async () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task");
      const serviceModule = new URL("./taskService.ts", import.meta.url).href;
      const childScript = `
        import { TaskService } from ${JSON.stringify(serviceModule)};
        new TaskService(process.env.PROJECT_ROOT).update(
          process.env.FEATURE,
          process.env.TASK,
          { report: process.env.REPORT },
        );
      `;
      const publish = (report: string): Promise<void> => {
        const child = spawn(process.execPath, ["-e", childScript], {
          env: {
            ...process.env,
            PROJECT_ROOT,
            FEATURE: featureName,
            TASK: "01-test-task",
            REPORT: report,
          },
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", chunk => { stderr += chunk; });
        return new Promise((resolve, reject) => {
          child.on("error", reject);
          child.on("exit", code => code === 0
            ? resolve()
            : reject(new Error(stderr || `Report update exited with code ${code}`)));
        });
      };

      await Promise.all([publish("report a"), publish("report b")]);

      const taskPath = path.join(TEST_DIR, ".hive", "features", featureName, "tasks", "01-test-task");
      const history = ["1.md", "2.md"].map(name =>
        fs.readFileSync(path.join(taskPath, "reports", name), "utf8")
      );
      expect(history.sort()).toEqual(["report a", "report b"]);
      expect(history).toContain(fs.readFileSync(path.join(taskPath, "report.md"), "utf8"));
    });

    it.each(["pending", "in_progress", "done", "failed", "partial", "cancelled"] as const)(
      "clears stale blocker data when transitioning to %s",
      (status) => {
        const featureName = "test-feature";
        setupFeature(featureName);
        setupTask(featureName, "01-test-task", {
          status: "blocked",
          blocker: { reason: "Old decision" },
        });

        expect(service.update(featureName, "01-test-task", { status }).blocker).toBeUndefined();
      },
    );
  });

  describe("getSpecFreshness", () => {
    const writePlan = (featureName: string, plan: string): string => {
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });
      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );
      fs.writeFileSync(path.join(featurePath, "plan.md"), plan);
      return featurePath;
    };
    const byFolder = (featureName: string) => new Map(service.getSpecFreshness(featureName).map(entry => [entry.folder, entry]));
    const plan = `# Plan

## Tasks

### 1. Setup

Setup.

### 2. Build

Build.

## Final Verification

Run tests.
`;

    it("matches freshly synced specs, flags an in-progress task whose section changed, and ignores the preamble", () => {
      const featureName = "freshness";
      const featurePath = writePlan(featureName, plan);
      service.sync(featureName);

      expect(service.getSpecFreshness(featureName)).toEqual([
        { folder: "01-setup", specStale: false, specStaleReason: "matches_plan", planSection: { startLine: 5, endLine: 7 } },
        { folder: "02-build", specStale: false, specStaleReason: "matches_plan", planSection: { startLine: 9, endLine: 11 } },
      ]);

      service.update(featureName, "02-build", { status: "in_progress" });
      fs.writeFileSync(
        path.join(featurePath, "plan.md"),
        plan.replace("# Plan\n", "# Plan\n\nNew preamble.\n").replace("Build.", "Build with the revised contract."),
      );

      const freshness = byFolder(featureName);
      expect(freshness.get("01-setup")).toEqual({ folder: "01-setup", specStale: false, specStaleReason: "matches_plan", planSection: { startLine: 7, endLine: 9 } });
      expect(freshness.get("02-build")).toEqual({ folder: "02-build", specStale: true, specStaleReason: "differs_from_plan", planSection: { startLine: 11, endLine: 13 } });
    });

    it("flags a dependent task when its dependency title changes without changing folders", () => {
      const featureName = "freshness-dependency-title";
      const featurePath = writePlan(featureName, plan);
      service.sync(featureName);
      service.update(featureName, "01-setup", { status: "done" });
      service.update(featureName, "02-build", { status: "in_progress" });

      fs.writeFileSync(path.join(featurePath, "plan.md"), plan.replace("### 1. Setup", "### 1. Setup!"));
      const freshness = byFolder(featureName);

      expect(freshness.get("01-setup")?.specStaleReason).toBe("differs_from_plan");
      expect(freshness.get("02-build")).toMatchObject({ specStale: true, specStaleReason: "differs_from_plan" });
      expect(service.buildSpecContent({
        featureName,
        task: { folder: "02-build", name: "Build", order: 2 },
        dependsOn: ["01-setup"],
        allTasks: [{ folder: "01-setup", name: "Setup!", order: 1 }, { folder: "02-build", name: "Build", order: 2 }],
      })).toContain("- **1. Setup!** (01-setup)");
    });

    it("keeps folder identity from the raw heading title, including closing hashes", () => {
      const featureName = "freshness-closing-hashes";
      writePlan(featureName, "# Plan\n\n## Tasks\n\n### 1. Setup ##\n\nSetup.\n");

      expect(service.sync(featureName).created).toEqual(["01-setup-"]);
      expect(service.getRawStatus(featureName, "01-setup-")?.planTitle).toBe("Setup ##");
      expect(service.getSpecFreshness(featureName)).toEqual([
        { folder: "01-setup-", specStale: false, specStaleReason: "matches_plan", planSection: { startLine: 5, endLine: 7 } },
      ]);
    });

    it("returns null freshness with a reason when the spec cannot be compared", () => {
      const featureName = "freshness-null-reasons";
      const featurePath = writePlan(featureName, plan);
      service.sync(featureName);
      service.create(featureName, "Manual Follow Up");
      fs.rmSync(path.join(featurePath, "tasks", "01-setup", "spec.md"));
      service.update(featureName, "02-build", { status: "in_progress" });

      // Renaming task 2 keeps its number, but the folder must not rebind by number.
      fs.writeFileSync(path.join(featurePath, "plan.md"), plan.replace("### 2. Build", "### 2. Compile"));
      expect(service.getSpecFreshness(featureName)).toEqual([
        { folder: "01-setup", specStale: null, specStaleReason: "spec_missing", planSection: { startLine: 5, endLine: 7 } },
        { folder: "02-build", specStale: null, specStaleReason: "task_not_in_plan" },
        { folder: "03-manual-follow-up", specStale: null, specStaleReason: "manual_task" },
      ]);

      fs.writeFileSync(path.join(featurePath, "plan.md"), `${plan}\n## tasks\n\n### 3. Extra\n`);
      expect(byFolder(featureName).get("01-setup")).toEqual({ folder: "01-setup", specStale: null, specStaleReason: "plan_invalid" });

      fs.rmSync(path.join(featurePath, "plan.md"));
      expect(byFolder(featureName).get("01-setup")).toEqual({ folder: "01-setup", specStale: null, specStaleReason: "plan_missing" });
      expect(byFolder(featureName).get("03-manual-follow-up")?.specStaleReason).toBe("manual_task");
    });

    it("treats an invalid dependency graph and duplicate task numbers as plan_invalid", () => {
      const featureName = "freshness-invalid-graph";
      const featurePath = writePlan(featureName, plan);
      service.sync(featureName);

      fs.writeFileSync(path.join(featurePath, "plan.md"), plan.replace("### 2. Build\n\nBuild.", "### 2. Build\n\nDepends on: 3\n\nBuild."));
      expect(byFolder(featureName).get("01-setup")).toEqual({ folder: "01-setup", specStale: null, specStaleReason: "plan_invalid" });
      expect(byFolder(featureName).get("02-build")?.specStaleReason).toBe("plan_invalid");

      fs.writeFileSync(path.join(featurePath, "plan.md"), plan.replace("### 2. Build", "### 1. Build"));
      expect(byFolder(featureName).get("01-setup")).toEqual({ folder: "01-setup", specStale: null, specStaleReason: "plan_invalid" });
      expect(byFolder(featureName).get("02-build")?.specStaleReason).toBe("plan_invalid");
    });

    it("flags a spec as differing when the plan's Repos line changes", () => {
      const featureName = "freshness-repos-line";
      const featurePath = writePlan(featureName, "# Plan\n\n## Tasks\n\n### 1. Setup\n\nRepos: root\n\nSetup.\n");
      service.sync(featureName);

      expect(byFolder(featureName).get("01-setup")).toMatchObject({ specStale: false, specStaleReason: "matches_plan" });
      expect(service.readSpec(featureName, "01-setup")).toContain("## Repositories\n\n- root");

      fs.writeFileSync(path.join(featurePath, "plan.md"), "# Plan\n\n## Tasks\n\n### 1. Setup\n\nRepos: core\n\nSetup.\n");
      expect(byFolder(featureName).get("01-setup")).toMatchObject({ specStale: true, specStaleReason: "differs_from_plan" });
    });

    it("reports unowned headings that follow a task section instead of comparing its spec", () => {
      const featureName = "freshness-unowned";
      const featurePath = writePlan(featureName, plan);
      service.sync(featureName);
      fs.writeFileSync(
        path.join(featurePath, "plan.md"),
        plan.replace("### 2. Build", "### Task 1 amendment (binding)\n\nUse the amendment.\n\n```md\n### fenced\n```\n\n### Notes\n\n### 2. Build"),
      );

      const freshness = byFolder(featureName);
      expect(freshness.get("01-setup")).toEqual({
        folder: "01-setup",
        specStale: null,
        specStaleReason: "unowned_heading_after_task_section",
        planSection: { startLine: 5, endLine: 7 },
        unownedHeadingLines: [9, 17],
      });
      expect(freshness.get("02-build")).toEqual({ folder: "02-build", specStale: false, specStaleReason: "matches_plan", planSection: { startLine: 19, endLine: 21 } });
    });

    it("surfaces unowned task-section headings from sync without blocking task creation", () => {
      const featureName = "sync-unowned";
      writePlan(featureName, plan.replace("### 2. Build", "### Shared Notes\n\nNotes.\n\n### 2. Build"));

      const result = service.sync(featureName);

      expect(result.created).toEqual(["01-setup", "02-build"]);
      expect(result.unownedTaskHeadings).toEqual([{ line: 9, title: "Shared Notes" }]);

      writePlan("sync-clean", plan);
      expect(service.sync("sync-clean")).not.toHaveProperty("unownedTaskHeadings");
    });
  });

  describe("getRawStatus", () => {
    it("returns full TaskStatus including aggregate branch metadata", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-test-task", {
        schemaVersion: 1,
        aggregateBranchDiff: {
          fileCount: 2,
          insertions: 8,
          deletions: 3,
          areas: ["packages", "docs"],
          report: ".hive/features/test-feature/tasks/01-test-task/report.md",
        },
      });

      const result = service.getRawStatus(featureName, "01-test-task");

      expect(result).not.toBeNull();
      expect(result?.schemaVersion).toBe(1);
      expect(result?.aggregateBranchDiff).toEqual({
        fileCount: 2,
        insertions: 8,
        deletions: 3,
        areas: ["packages", "docs"],
        report: ".hive/features/test-feature/tasks/01-test-task/report.md",
      });
    });

    it("returns null for non-existent task", () => {
      const featureName = "test-feature";
      setupFeature(featureName);

      const result = service.getRawStatus(featureName, "nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("dependsOn field", () => {
    it("existing tasks without dependsOn continue to load and display", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      // Create task without dependsOn (legacy format)
      setupTask(featureName, "01-test-task", {
        status: "pending",
        planTitle: "Test Task",
        // No dependsOn field
      });

      const result = service.getRawStatus(featureName, "01-test-task");

      expect(result).not.toBeNull();
      expect(result?.status).toBe("pending");
      expect(result?.planTitle).toBe("Test Task");
      // dependsOn should be undefined for legacy tasks
      expect(result?.dependsOn).toBeUndefined();
    });

    it("tasks with dependsOn array load correctly", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "02-dependent-task", {
        status: "pending",
        planTitle: "Dependent Task",
        dependsOn: ["01-setup", "01-core-api"],
      });

      const result = service.getRawStatus(featureName, "02-dependent-task");

      expect(result).not.toBeNull();
      expect(result?.dependsOn).toEqual(["01-setup", "01-core-api"]);
    });

    it("preserves dependsOn field on update", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "02-dependent-task", {
        status: "pending",
        dependsOn: ["01-setup"],
      });

      const result = service.update(featureName, "02-dependent-task", {
        status: "in_progress",
      });

      expect(result.status).toBe("in_progress");
      expect(result.dependsOn).toEqual(["01-setup"]);
    });

    it("handles empty dependsOn array", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-independent-task", {
        status: "pending",
        dependsOn: [],
      });

      const result = service.getRawStatus(featureName, "01-independent-task");

      expect(result).not.toBeNull();
      expect(result?.dependsOn).toEqual([]);
    });
  });

  describe("sync() - dependency parsing", () => {
    it("parses explicit Depends on: annotations and resolves to folder names", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      // Plan with explicit dependencies
      const planContent = `# Plan

## Tasks

### 1. Setup Base

Base setup task.

### 2. Build Core

**Depends on**: 1

Build the core module.

### 3. Build UI

**Depends on**: 1, 2

Build the UI layer.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toContain("01-setup-base");
      expect(result.created).toContain("02-build-core");
      expect(result.created).toContain("03-build-ui");

      // Check status.json for dependencies
      const task1Status = service.getRawStatus(featureName, "01-setup-base");
      const task2Status = service.getRawStatus(featureName, "02-build-core");
      const task3Status = service.getRawStatus(featureName, "03-build-ui");

      // Task 1 has no dependencies (first task, implicit none)
      expect(task1Status?.dependsOn).toEqual([]);

      // Task 2 depends on task 1
      expect(task2Status?.dependsOn).toEqual(["01-setup-base"]);

      // Task 3 depends on tasks 1 and 2
      expect(task3Status?.dependsOn).toEqual(["01-setup-base", "02-build-core"]);
    });

    it("parses Depends on: none and produces empty dependency list", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

### 1. Independent Task A

**Depends on**: none

Can run independently.

### 2. Independent Task B

Depends on: none

Also independent.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      const task1Status = service.getRawStatus(featureName, "01-independent-task-a");
      const task2Status = service.getRawStatus(featureName, "02-independent-task-b");

      expect(task1Status?.dependsOn).toEqual([]);
      expect(task2Status?.dependsOn).toEqual([]);
    });

    it("applies implicit sequential dependencies when Depends on: is missing", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      // Plan without any dependency annotations - should use implicit sequential
      const planContent = `# Plan

## Tasks

### 1. First Task

Do the first thing.

### 2. Second Task

Do the second thing.

### 3. Third Task

Do the third thing.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      const task1Status = service.getRawStatus(featureName, "01-first-task");
      const task2Status = service.getRawStatus(featureName, "02-second-task");
      const task3Status = service.getRawStatus(featureName, "03-third-task");

      // Task 1 - no dependencies (first task)
      expect(task1Status?.dependsOn).toEqual([]);

      // Task 2 - implicit dependency on task 1
      expect(task2Status?.dependsOn).toEqual(["01-first-task"]);

      // Task 3 - implicit dependency on task 2
      expect(task3Status?.dependsOn).toEqual(["02-second-task"]);
    });

    it("generates spec.md with dependency section", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

### 1. Setup

Setup task.

### 2. Build

**Depends on**: 1

Build task.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      service.sync(featureName);

      // Read spec.md for task 2
      const specPath = path.join(featurePath, "tasks", "02-build", "spec.md");
      const specContent = fs.readFileSync(specPath, "utf-8");

      expect(specContent).toContain("## Dependencies");
      expect(specContent).toContain("## Plan Section");
      expect(specContent).toContain("01-setup");
    });

    it("generates spec.md with Dependencies: none when explicitly empty", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

### 1. Independent Task

**Depends on**: none

Independent task.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      service.sync(featureName);

      const specPath = path.join(featurePath, "tasks", "01-independent-task", "spec.md");
      const specContent = fs.readFileSync(specPath, "utf-8");

      expect(specContent).toContain("## Dependencies");
      expect(specContent).toContain("_None_");
    });

    it("handles mixed explicit and implicit dependencies", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

### 1. Base

Base task.

### 2. Core

No dependency annotation - implicit sequential.

### 3. UI

**Depends on**: 1

Explicitly depends only on 1, not 2.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      service.sync(featureName);

      const task1Status = service.getRawStatus(featureName, "01-base");
      const task2Status = service.getRawStatus(featureName, "02-core");
      const task3Status = service.getRawStatus(featureName, "03-ui");

      // Task 1 - no dependencies
      expect(task1Status?.dependsOn).toEqual([]);

      // Task 2 - implicit dependency on task 1
      expect(task2Status?.dependsOn).toEqual(["01-base"]);

      // Task 3 - explicit dependency on task 1 only (not 2)
      expect(task3Status?.dependsOn).toEqual(["01-base"]);
    });
  });

  describe("sync() - repository metadata parsing", () => {
    it("parses a single bold Repos annotation into status, info, and spec metadata", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

### 1. Build API

**Repos**: api

Build the API service.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      service.sync(featureName);

      const status = service.getRawStatus(featureName, "01-build-api");
      const info = service.get(featureName, "01-build-api");
      const specContent = fs.readFileSync(path.join(featurePath, "tasks", "01-build-api", "spec.md"), "utf-8");

      expect(status?.repoIds).toEqual(["api"]);
      expect(info?.repoIds).toEqual(["api"]);
      expect(specContent).toContain("## Repositories");
      expect(specContent).toContain("- api");
    });

    it("parses comma-separated non-bold Repos annotations", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

### 1. Coordinate Apps

Repos: api, web

Coordinate both repos.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      service.sync(featureName);

      const status = service.getRawStatus(featureName, "01-coordinate-apps");
      const specContent = fs.readFileSync(path.join(featurePath, "tasks", "01-coordinate-apps", "spec.md"), "utf-8");

      expect(status?.repoIds).toEqual(["api", "web"]);
      expect(specContent).toContain("- api");
      expect(specContent).toContain("- web");
    });

    it("rejects invalid repository IDs in Repos annotations", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

### 1. Invalid Repo Task

**Repos**: api, Web_App

Invalid repo annotation.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      expect(() => service.sync(featureName)).toThrow(/invalid repository id.*Web_App.*plan\.md/i);
    });

    it("leaves repoIds undefined when Repos is absent", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );
      fs.writeFileSync(
        path.join(TEST_DIR, ".hive", "agent-hive.json"),
        JSON.stringify({ repositories: [{ id: "api", path: "api" }, { id: "web", path: "web" }] })
      );

      const planContent = `# Plan

## Tasks

### 1. Rootless Task

No repository annotation.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      service.sync(featureName);

      const status = service.getRawStatus(featureName, "01-rootless-task");
      const info = service.get(featureName, "01-rootless-task");
      const specContent = fs.readFileSync(path.join(featurePath, "tasks", "01-rootless-task", "spec.md"), "utf-8");

      expect(status?.repoIds).toBeUndefined();
      expect(info?.repoIds).toBeUndefined();
      expect(specContent).not.toContain("## Repositories");
    });
  });

  describe("sync() - dependency validation", () => {
    it("throws error for unknown task numbers in dependencies", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      // Task 2 depends on non-existent task 99
      const planContent = `# Plan

## Tasks

### 1. First Task

First task description.

### 2. Second Task

**Depends on**: 1, 99

Second task depends on unknown task 99.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      expect(() => service.sync(featureName)).toThrow(/unknown task number.*99/i);
    });

    it("throws error for self-dependency", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      // Task 2 depends on itself
      const planContent = `# Plan

## Tasks

### 1. First Task

First task description.

### 2. Self Referential Task

**Depends on**: 2

This task depends on itself.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      expect(() => service.sync(featureName)).toThrow(/self-dependency.*task 2/i);
    });

    it("throws error for cyclic dependencies (simple A->B->A)", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      // Task 1 depends on task 2, task 2 depends on task 1
      const planContent = `# Plan

## Tasks

### 1. Task A

**Depends on**: 2

Task A depends on B.

### 2. Task B

**Depends on**: 1

Task B depends on A.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      expect(() => service.sync(featureName)).toThrow(/cycle.*1.*2/i);
    });

    it("throws error for cyclic dependencies (longer chain A->B->C->A)", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      // Cycle: 1->2->3->1
      const planContent = `# Plan

## Tasks

### 1. Task A

**Depends on**: 3

Task A depends on C.

### 2. Task B

**Depends on**: 1

Task B depends on A.

### 3. Task C

**Depends on**: 2

Task C depends on B.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      expect(() => service.sync(featureName)).toThrow(/cycle/i);
    });

    it("error message for unknown deps points to plan.md", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

### 1. Only Task

**Depends on**: 5

Depends on non-existent task 5.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      expect(() => service.sync(featureName)).toThrow(/plan\.md/i);
    });

    it("error message for cycle points to plan.md", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

### 1. Task A

**Depends on**: 2

Cycle with B.

### 2. Task B

**Depends on**: 1

Cycle with A.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      expect(() => service.sync(featureName)).toThrow(/plan\.md/i);
    });

    it("accepts valid dependency graphs without cycles", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      // Valid DAG: 1 <- 2, 1 <- 3, 2 <- 4, 3 <- 4
      const planContent = `# Plan

## Tasks

### 1. Base

**Depends on**: none

Base task.

### 2. Left Branch

**Depends on**: 1

Left branch.

### 3. Right Branch

**Depends on**: 1

Right branch.

### 4. Merge

**Depends on**: 2, 3

Merge both branches.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      // Should not throw
      const result = service.sync(featureName);
      expect(result.created).toContain("01-base");
      expect(result.created).toContain("02-left-branch");
      expect(result.created).toContain("03-right-branch");
      expect(result.created).toContain("04-merge");
    });
  });

  describe("sync() - dependency parsing edge cases", () => {
    it("ignores a human-facing summary section before tasks", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Discovery

- Keep the plan human-friendly.

## Design Summary

This section helps humans review the plan before execution starts.

### Sequence Overview

- Setup first
- Build second

## Tasks

### 1. Setup

**Depends on**: none

Prepare the environment.

### 2. Build

**Depends on**: 1

Build the implementation.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toEqual(["01-setup", "02-build"]);
      expect(service.getRawStatus(featureName, "01-setup")?.dependsOn).toEqual([]);
      expect(service.getRawStatus(featureName, "02-build")?.dependsOn).toEqual(["01-setup"]);
    });

    it("ignores optional mermaid blocks in the pre-task summary when parsing tasks and spec sections", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Design Summary

Quick sequence for humans.

\`\`\`mermaid
sequenceDiagram
    participant Human
    participant Hive
    Human->>Hive: Review summary
    Hive->>Human: Show tasks
\`\`\`

## Tasks

### 1. Setup

**Depends on**: none

Setup task.

### 2. Build

**Depends on**: 1

Build task.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toEqual(["01-setup", "02-build"]);
      expect(service.getRawStatus(featureName, "02-build")?.dependsOn).toEqual(["01-setup"]);

      const specPath = path.join(featurePath, "tasks", "02-build", "spec.md");
      const specContent = fs.readFileSync(specPath, "utf-8");

      expect(specContent).toContain("### 2. Build");
      expect(specContent).not.toContain("sequenceDiagram");
      expect(specContent).not.toContain("### Sequence Overview");
    });

    it("builds spec sections only from the canonical level-two Tasks section", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Discovery

### Tasks

This is a discovery subsection, not the executable task section.

\`\`\`markdown
## Tasks

### 1. Fake Task

Do not sync this fenced example.
\`\`\`

### 1. Real Task

This pre-task heading must not become the generated task spec section.

## Tasks

### 1. Real Task

**Depends on**: none

Use this real task section.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toEqual(["01-real-task"]);
      const specContent = fs.readFileSync(path.join(featurePath, "tasks", "01-real-task", "spec.md"), "utf-8");
      expect(specContent).toContain("### 1. Real Task");
      expect(specContent).toContain("Use this real task section.");
      expect(specContent).not.toContain("This pre-task heading must not become");
      expect(specContent).not.toContain("Do not sync this fenced example");
    });

    it("builds spec sections from non-fenced task headings inside canonical Tasks", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

\`\`\`markdown
### 1. Real Task

Fenced fake section must not appear in spec.md.
\`\`\`

### 1. Real Task

Real task section must appear in spec.md.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toEqual(["01-real-task"]);
      const specContent = fs.readFileSync(path.join(featurePath, "tasks", "01-real-task", "spec.md"), "utf-8");
      expect(specContent).toContain("Real task section must appear in spec.md.");
      expect(specContent).not.toContain("Fenced fake section must not appear");
    });

    it("does not extract a stray task-like heading without a separating space as a task's spec section", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      fs.writeFileSync(path.join(featurePath, "plan.md"), `# Plan

## Tasks

###1. Impostor

Impostor text.

### 1. Real Task

Real task body.
`);

      const result = service.sync(featureName);

      expect(result.created).toEqual(["01-real-task"]);
      const specContent = fs.readFileSync(path.join(featurePath, "tasks", "01-real-task", "spec.md"), "utf-8");
      expect(specContent).toContain("### 1. Real Task");
      expect(specContent).toContain("Real task body.");
      expect(specContent).not.toContain("Impostor");
    });

    it("parses task headings indented up to three spaces", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

   ### 1. Indented Task

Indented task body.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toEqual(["01-indented-task"]);
    });

    it("rejects duplicate canonical level-two Tasks sections", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

### 1. First Task

First task.

## tasks

### 2. Second Task

Second task.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      expect(() => service.sync(featureName)).toThrow(/multiple Tasks sections/i);
    });

    it("handles whitespace variations in Depends on line", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      // Whitespace variations: extra spaces, tabs, etc.
      const planContent = `# Plan

## Tasks

### 1. Base Task

Base task.

### 2. Task With Spaces

**Depends on**:   1

Task with extra spaces after colon.

### 3. Task With Comma Spaces

**Depends on**: 1 , 2

Task with spaces around comma.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toContain("01-base-task");
      expect(result.created).toContain("02-task-with-spaces");
      expect(result.created).toContain("03-task-with-comma-spaces");

      const task2Status = service.getRawStatus(featureName, "02-task-with-spaces");
      const task3Status = service.getRawStatus(featureName, "03-task-with-comma-spaces");

      expect(task2Status?.dependsOn).toEqual(["01-base-task"]);
      expect(task3Status?.dependsOn).toEqual(["01-base-task", "02-task-with-spaces"]);
    });

    it("handles non-bold Depends on format", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      // Non-bold format
      const planContent = `# Plan

## Tasks

### 1. First

First task.

### 2. Second

Depends on: 1

Second depends on first (non-bold format).
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      const task2Status = service.getRawStatus(featureName, "02-second");
      expect(task2Status?.dependsOn).toEqual(["01-first"]);
    });

    it("handles case insensitive none keyword", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      // "None" with capital N
      const planContent = `# Plan

## Tasks

### 1. Independent Task

**Depends on**: None

Independent task with capital None.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      const task1Status = service.getRawStatus(featureName, "01-independent-task");
      expect(task1Status?.dependsOn).toEqual([]);
    });

    it("ignores numbered headings under Discovery when a later ## Tasks section exists", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Discovery

### 1. Historical Context

Should not become a task.

## Tasks

### 1. Real Task

**Depends on**: none

Do the work.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toEqual(["01-real-task"]);
      expect(service.getRawStatus(featureName, "01-historical-context")).toBeNull();
    });

    it("ignores fenced Tasks headings before the real Tasks section", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Discovery

\`\`\`markdown
## Tasks

### 1. Hidden Task

Should not become a task.
\`\`\`

## Tasks

### 1. Real Task

**Depends on**: none

Do the work.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toEqual(["01-real-task"]);
      expect(service.getRawStatus(featureName, "01-hidden-task")).toBeNull();
    });

    it("does not create tasks from ## Final Verification after ## Tasks", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

### 1. Implement

**Depends on**: none

Implementation work.

## Final Verification

### 1. Run full test suite

- [ ] Run: bun test -> PASS

### Final checks

Non-numbered verification gate.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toEqual(["01-implement"]);
      expect(service.getRawStatus(featureName, "01-run-full-test-suite")).toBeNull();
    });

    it("stops task parsing at a later H1 boundary", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Tasks

### 1. Real Task

**Depends on**: none

Do the work.

# Appendix

### 2. Appendix Task-Like Heading

Should not become a task.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toEqual(["01-real-task"]);
      expect(service.getRawStatus(featureName, "02-appendix-task-like-heading")).toBeNull();
    });

    it("detects indented ## Tasks headings and stops at indented top-level boundaries", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Discovery

### 1. Historical Context

Should not become a task.

   ## Tasks

### 1. Real Task

**Depends on**: none

Do the work.

   ## Final Verification

### 2. Verification Checklist

Should not become a task.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toEqual(["01-real-task"]);
      expect(service.getRawStatus(featureName, "01-historical-context")).toBeNull();
      expect(service.getRawStatus(featureName, "02-verification-checklist")).toBeNull();
    });

    it("returns no tasks when ## Tasks exists but contains no valid numbered tasks", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

## Discovery

### 1. Legacy Heading

Would be a task under legacy parsing.

## Tasks

No numbered task headings here yet.

## Final Verification

Checklist only.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toEqual([]);
      expect(service.getRawStatus(featureName, "01-legacy-heading")).toBeNull();
    });

    it("does not parse executable tasks when plan has no canonical ## Tasks heading", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planContent = `# Plan

### 1. Legacy Task

**Depends on**: none

This pre-task heading must not create an executable task.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      const result = service.sync(featureName);

      expect(result.created).toEqual([]);
      expect(service.getRawStatus(featureName, "01-legacy-task")).toBeNull();
    });
  });

  describe("sync() - plan task section extraction", () => {
    const writePlan = (featureName: string, plan: string): string => {
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });
      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );
      fs.writeFileSync(path.join(featurePath, "plan.md"), plan);
      return featurePath;
    };
    const readSpec = (featurePath: string, folder: string): string =>
      fs.readFileSync(path.join(featurePath, "tasks", folder, "spec.md"), "utf-8");
    const specPlanSection = (spec: string): string => {
      const afterHeading = spec.split("## Plan Section\n\n")[1] ?? "";
      const taskTypeAt = afterHeading.indexOf("\n\n## Task Type");
      return (taskTypeAt === -1 ? afterHeading : afterHeading.slice(0, taskTypeAt)).replace(/\n+$/, "");
    };
    const planLines = (plan: string, startLine: number, endLine: number): string =>
      plan.split("\n").slice(startLine - 1, endLine).join("\n");
    const freshnessByFolder = (featureName: string) =>
      new Map(service.getSpecFreshness(featureName).map(entry => [entry.folder, entry]));

    it("copies zero-padded task headings into specs and reports the same lines as freshness", () => {
      const featureName = "zero-padded-sections";
      const plan = `# Plan

## Tasks

### 01. Setup

Setup body.

### 02. Build

Build body.
`;
      const featurePath = writePlan(featureName, plan);

      expect(service.sync(featureName).created).toEqual(["01-setup", "02-build"]);

      const expected = [
        { folder: "01-setup", startLine: 5, endLine: 7 },
        { folder: "02-build", startLine: 9, endLine: 11 },
      ];
      const freshness = freshnessByFolder(featureName);
      for (const { folder, startLine, endLine } of expected) {
        expect(freshness.get(folder)).toEqual({
          folder,
          specStale: false,
          specStaleReason: "matches_plan",
          planSection: { startLine, endLine },
        });
        expect(specPlanSection(readSpec(featurePath, folder))).toBe(planLines(plan, startLine, endLine));
      }
      expect(readSpec(featurePath, "01-setup")).not.toContain("_No plan section available._");
    });

    it("flags legacy specs that lack a zero-padded section and refreshes them when pending", () => {
      const featureName = "zero-padded-legacy-spec";
      const plan = `# Plan

## Tasks

### 01. Setup

Setup body.

### 02. Build

Build body.
`;
      const featurePath = writePlan(featureName, plan);
      service.sync(featureName);

      const legacySection = "## Plan Section\n\n_No plan section available._\n";
      fs.writeFileSync(
        path.join(featurePath, "tasks", "01-setup", "spec.md"),
        `# Task: 01-setup\n\n## Feature: ${featureName}\n\n## Dependencies\n\n_None_\n\n${legacySection}`
      );
      service.update(featureName, "02-build", { status: "in_progress" });
      fs.writeFileSync(
        path.join(featurePath, "tasks", "02-build", "spec.md"),
        `# Task: 02-build\n\n## Feature: ${featureName}\n\n## Dependencies\n\n- **1. Setup** (01-setup)\n\n${legacySection}`
      );

      const before = freshnessByFolder(featureName);
      expect(before.get("01-setup")).toEqual({
        folder: "01-setup",
        specStale: true,
        specStaleReason: "differs_from_plan",
        planSection: { startLine: 5, endLine: 7 },
      });
      expect(before.get("02-build")).toEqual({
        folder: "02-build",
        specStale: true,
        specStaleReason: "differs_from_plan",
        planSection: { startLine: 9, endLine: 11 },
      });

      service.sync(featureName, { refreshPending: true });

      expect(specPlanSection(readSpec(featurePath, "01-setup"))).toBe("### 01. Setup\n\nSetup body.");
      expect(readSpec(featurePath, "01-setup")).not.toContain("_No plan section available._");
      expect(readSpec(featurePath, "02-build")).toContain("_No plan section available._");
      expect(service.getRawStatus(featureName, "02-build")?.status).toBe("in_progress");

      const after = freshnessByFolder(featureName);
      expect(after.get("01-setup")?.specStaleReason).toBe("matches_plan");
      expect(after.get("02-build")).toMatchObject({ specStale: true, specStaleReason: "differs_from_plan" });
    });

    it("does not cross-match single-digit and multi-digit task numbers", () => {
      const featureName = "task-number-cross-match";
      const plan = `# Plan

## Tasks

### 1. First

First body.

### 10. Tenth

Tenth body.
`;
      const featurePath = writePlan(featureName, plan);

      expect(service.sync(featureName).created).toEqual(["01-first", "10-tenth"]);
      expect(specPlanSection(readSpec(featurePath, "01-first"))).toBe("### 1. First\n\nFirst body.");
      expect(specPlanSection(readSpec(featurePath, "10-tenth"))).toBe("### 10. Tenth\n\nTenth body.");
    });

    it("ends sections at unowned headings and keeps trailing blanks and nested subsections out of the wrong section", () => {
      const featureName = "section-boundaries";
      const plan = `# Plan

## Tasks

### 1. Setup

Own body.



### Notes

Not part of Setup.

### 2. Build

Build body.

#### 2.1 Detail

Detail body.

### 3. Final

Final body.
`;
      const featurePath = writePlan(featureName, plan);
      service.sync(featureName);

      expect(specPlanSection(readSpec(featurePath, "01-setup"))).toBe("### 1. Setup\n\nOwn body.");
      expect(specPlanSection(readSpec(featurePath, "02-build"))).toBe("### 2. Build\n\nBuild body.\n\n#### 2.1 Detail\n\nDetail body.");
      expect(specPlanSection(readSpec(featurePath, "03-final"))).toBe("### 3. Final\n\nFinal body.");
    });
  });

  describe("CRLF plan parsing", () => {
    const LF_PLAN = `# Plan

## Tasks

### 1. Setup

**Repos**: root

Prepare the workspace.

### 2. Build

**Depends on**: 1

Build the workspace.

### 3. Verify

**Depends on**: 1, 2

**Repos**: root, docs

Verify the workspace.
`;
    const asCrlf = (plan: string): string => plan.replace(/\n/g, "\r\n");

    const writePlan = (featureName: string, plan: string): string => {
      setupFeature(featureName);
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.writeFileSync(path.join(featurePath, "plan.md"), plan);
      return featurePath;
    };
    const readSpec = (featurePath: string, folder: string): string =>
      fs.readFileSync(path.join(featurePath, "tasks", folder, "spec.md"), "utf-8");

    it("syncs CRLF plans to the same folders, dependencies, repositories, and specs as LF plans", () => {
      const featureName = "crlf-sync";
      const featurePath = writePlan(featureName, LF_PLAN);
      expect(service.sync(featureName).created).toEqual(["01-setup", "02-build", "03-verify"]);

      const lfSpecs = new Map(
        ["01-setup", "02-build", "03-verify"].map(folder => [folder, readSpec(featurePath, folder)])
      );
      const lfStatuses = new Map(
        ["01-setup", "02-build", "03-verify"].map(folder => [folder, service.getRawStatus(featureName, folder)])
      );

      fs.rmSync(path.join(featurePath, "tasks"), { recursive: true, force: true });
      fs.writeFileSync(path.join(featurePath, "plan.md"), asCrlf(LF_PLAN));

      const crlfResult = service.sync(featureName);

      expect(crlfResult.created).toEqual(["01-setup", "02-build", "03-verify"]);
      for (const folder of crlfResult.created) {
        expect(service.getRawStatus(featureName, folder)).toEqual(lfStatuses.get(folder));
        const crlfSpec = readSpec(featurePath, folder);
        expect(crlfSpec).toBe(lfSpecs.get(folder));
        expect(crlfSpec).not.toContain("\r");
      }

      expect(service.getRawStatus(featureName, "01-setup")?.repoIds).toEqual(["root"]);
      expect(service.getRawStatus(featureName, "02-build")?.dependsOn).toEqual(["01-setup"]);
      expect(service.getRawStatus(featureName, "03-verify")?.dependsOn).toEqual(["01-setup", "02-build"]);
      expect(service.getRawStatus(featureName, "03-verify")?.repoIds).toEqual(["root", "docs"]);
    });

    it("reports matches_plan freshness with the same planSection line numbers as LF plans", () => {
      writePlan("crlf-freshness-lf", LF_PLAN);
      writePlan("crlf-freshness-crlf", asCrlf(LF_PLAN));
      service.sync("crlf-freshness-lf");
      service.sync("crlf-freshness-crlf");

      const crlfFreshness = service.getSpecFreshness("crlf-freshness-crlf");
      expect(crlfFreshness).toEqual(service.getSpecFreshness("crlf-freshness-lf"));
      expect(crlfFreshness).toEqual([
        { folder: "01-setup", specStale: false, specStaleReason: "matches_plan", planSection: { startLine: 5, endLine: 9 } },
        { folder: "02-build", specStale: false, specStaleReason: "matches_plan", planSection: { startLine: 11, endLine: 15 } },
        { folder: "03-verify", specStale: false, specStaleReason: "matches_plan", planSection: { startLine: 17, endLine: 23 } },
      ]);
    });

    it("parses mixed-ending plans with LF task headings and CRLF annotation lines like LF plans", () => {
      const featureName = "crlf-mixed";
      const featurePath = writePlan(featureName, LF_PLAN);
      service.sync(featureName);
      const folders = ["01-setup", "02-build", "03-verify"];
      const lfStatuses = new Map(folders.map(folder => [folder, service.getRawStatus(featureName, folder)]));
      const lfSpecs = new Map(folders.map(folder => [folder, readSpec(featurePath, folder)]));

      const mixedPlan = LF_PLAN
        .replace("**Repos**: root\n", "**Repos**: root\r\n")
        .replace("**Depends on**: 1\n", "**Depends on**: 1\r\n")
        .replace("**Depends on**: 1, 2\n", "**Depends on**: 1, 2\r\n")
        .replace("**Repos**: root, docs\n", "**Repos**: root, docs\r\n");
      fs.rmSync(path.join(featurePath, "tasks"), { recursive: true, force: true });
      fs.writeFileSync(path.join(featurePath, "plan.md"), mixedPlan);

      const mixedResult = service.sync(featureName);

      expect(mixedResult.created).toEqual(folders);
      // 03-verify names both earlier tasks; the implicit previous-task fallback would only chain 02-build.
      expect(service.getRawStatus(featureName, "03-verify")?.dependsOn).toEqual(["01-setup", "02-build"]);
      expect(service.getRawStatus(featureName, "01-setup")?.repoIds).toEqual(["root"]);
      expect(service.getRawStatus(featureName, "03-verify")?.repoIds).toEqual(["root", "docs"]);
      for (const folder of mixedResult.created) {
        expect(service.getRawStatus(featureName, folder)).toEqual(lfStatuses.get(folder));
        expect(readSpec(featurePath, folder)).toBe(lfSpecs.get(folder));
      }
    });

    it("syncs a CRLF plan after planService.patch replaces a task", () => {
      const featureName = "crlf-patch";
      writePlan(featureName, asCrlf(LF_PLAN));

      const planService = new PlanService(PROJECT_ROOT);
      const plan = planService.read(featureName);
      expect(plan).not.toBeNull();
      const patched = planService.patch(featureName, plan!.revision, [
        {
          type: "replace_task",
          taskNumber: 2,
          content: "### 2. Build\n\n**Depends on**: 1\n\nBuild the patched workspace.\n",
        },
      ]);
      expect(patched.changedSections).toEqual(["Task 2"]);

      const result = service.sync(featureName);
      expect(result.created).toEqual(["01-setup", "02-build", "03-verify"]);
      expect(service.getRawStatus(featureName, "02-build")?.dependsOn).toEqual(["01-setup"]);
      expect(service.getRawStatus(featureName, "03-verify")?.dependsOn).toEqual(["01-setup", "02-build"]);
      const spec = service.readSpec(featureName, "02-build") ?? "";
      expect(spec).toContain("Build the patched workspace.");
      expect(spec).not.toContain("\r");
    });
  });

  describe("sync() - dependency validation edge cases", () => {
    it("allows forward dependencies (later task depending on earlier)", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      // Normal forward dependency
      const planContent = `# Plan

## Tasks

### 1. Foundation

**Depends on**: none

Foundation task.

### 2. Build

**Depends on**: 1

Build depends on foundation.

### 3. Test

**Depends on**: 2

Test depends on build.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      // Should not throw
      const result = service.sync(featureName);
      expect(result.created.length).toBe(3);
    });

    it("throws error for diamond with cycle", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      // Diamond with cycle: 1->2, 1->3, 2->4, 3->4, 4->1
      const planContent = `# Plan

## Tasks

### 1. Start

**Depends on**: 4

Start depends on end (creates cycle).

### 2. Left

**Depends on**: 1

Left branch.

### 3. Right

**Depends on**: 1

Right branch.

### 4. End

**Depends on**: 2, 3

End depends on both branches.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      expect(() => service.sync(featureName)).toThrow(/cycle/i);
    });

    it("provides clear error for multiple unknown dependencies", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      // Multiple unknown task numbers
      const planContent = `# Plan

## Tasks

### 1. Only Task

**Depends on**: 5, 10, 99

Depends on multiple non-existent tasks.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planContent);

      expect(() => service.sync(featureName)).toThrow(/unknown.*task/i);
    });
  });

  describe("buildSpecContent - task type inference", () => {
    it("should infer greenfield type when plan section has only Create: files", () => {
      const featureName = "test-feature";
      const planContent = `# Plan

## Tasks

### 1. Greenfield Task

**Depends on**: none

**Files:**
- Create: \`packages/hive-core/src/new-module.ts\`

Create the new module.
`;

      const specContent = service.buildSpecContent({
        featureName,
        task: { folder: "01-greenfield-task", name: "Greenfield Task", order: 1 },
        dependsOn: [],
        allTasks: [{ folder: "01-greenfield-task", name: "Greenfield Task", order: 1 }],
        planContent,
      });

      expect(specContent).toContain("## Task Type");
      expect(specContent).toContain("greenfield");
    });

    it("should infer testing type when plan section has only Test: files", () => {
      const featureName = "test-feature";
      const planContent = `# Plan

## Tasks

### 1. Coverage Update

**Depends on**: none

**Files:**
- Test: \`packages/hive-core/src/services/taskService.test.ts\`

Add coverage for task specs.
`;

      const specContent = service.buildSpecContent({
        featureName,
        task: { folder: "01-coverage-update", name: "Coverage Update", order: 1 },
        dependsOn: [],
        allTasks: [{ folder: "01-coverage-update", name: "Coverage Update", order: 1 }],
        planContent,
      });

      expect(specContent).toContain("## Task Type");
      expect(specContent).toContain("testing");
    });

    it("should infer modification type when plan section has Modify: files", () => {
      const featureName = "test-feature";
      const planContent = `# Plan

## Tasks

### 1. Update Worker Prompt

**Depends on**: none

**Files:**
- Modify: \`packages/opencode-hive/src/agents/forager.ts\`

Update prompt copy.
`;

      const specContent = service.buildSpecContent({
        featureName,
        task: { folder: "01-update-worker-prompt", name: "Update Worker Prompt", order: 1 },
        dependsOn: [],
        allTasks: [{ folder: "01-update-worker-prompt", name: "Update Worker Prompt", order: 1 }],
        planContent,
      });

      expect(specContent).toContain("## Task Type");
      expect(specContent).toContain("modification");
    });

    it("should omit task type when no inference signal is present", () => {
      const featureName = "test-feature";
      const planContent = `# Plan

## Tasks

### 1. Align Docs

**Depends on**: none

Align documentation wording.
`;

      const specContent = service.buildSpecContent({
        featureName,
        task: { folder: "01-align-docs", name: "Align Docs", order: 1 },
        dependsOn: [],
        allTasks: [{ folder: "01-align-docs", name: "Align Docs", order: 1 }],
        planContent,
      });

      expect(specContent).not.toContain("## Task Type");
    });
  });

  describe("create() - manual task hardening", () => {
    it("writes dependsOn: [] by default for manual tasks", () => {
      const featureName = "test-feature";
      setupFeature(featureName);

      const folder = service.create(featureName, "ad-hoc-fix");

      const status = service.getRawStatus(featureName, folder);
      expect(status).not.toBeNull();
      expect(status?.origin).toBe("manual");
      expect(status?.dependsOn).toEqual([]);
    });

    it("uses slug-safe folder names while preserving the manual task title", () => {
      const featureName = "test-feature";
      setupFeature(featureName);

      const folder = service.create(featureName, "Background smoke worker A!", undefined, {
        description: "Create the smoke marker file.",
      });

      expect(folder).toBe("01-background-smoke-worker-a");
      expect(service.getRawStatus(featureName, folder)?.planTitle).toBe("Background smoke worker A!");
      expect(fs.existsSync(path.join(TEST_DIR, ".hive", "features", featureName, "tasks", folder))).toBe(true);
    });

    it("rejects manual task names that cannot produce a safe folder slug", () => {
      const featureName = "test-feature";
      setupFeature(featureName);

      expect(() => service.create(featureName, "!!!")).toThrow(/safe task folder slug/i);
    });

    it("creates a spec.md during manual-task creation", () => {
      const featureName = "test-feature";
      setupFeature(featureName);

      const folder = service.create(featureName, "ad-hoc-fix");

      const specPath = path.join(
        TEST_DIR,
        ".hive",
        "features",
        featureName,
        "tasks",
        folder,
        "spec.md"
      );
      expect(fs.existsSync(specPath)).toBe(true);
      const specContent = fs.readFileSync(specPath, "utf-8");
      expect(specContent).toContain("# Task:");
      expect(specContent).toContain("## Dependencies");
      expect(specContent).toContain("_None_");
    });

    it("accepts structured metadata and persists it in status.json", () => {
      const featureName = "test-feature";
      setupFeature(featureName);

      const folder = service.create(featureName, "review-fix", undefined, {
        description: "Fix routing issue found in review",
        goal: "Correct agent routing for swarm dispatch",
        acceptanceCriteria: ["swarm dispatches to correct agent", "existing tests pass"],
        references: ["packages/opencode-hive/src/agents/swarm.ts:107-111"],
        files: ["packages/opencode-hive/src/agents/swarm.ts"],
        reason: "Required by code review",
        source: "review",
      });

      const status = service.getRawStatus(featureName, folder);
      expect(status?.origin).toBe("manual");
      expect(status?.dependsOn).toEqual([]);
      expect((status as any).metadata?.description).toBe("Fix routing issue found in review");
      expect((status as any).metadata?.goal).toBe("Correct agent routing for swarm dispatch");
      expect((status as any).metadata?.acceptanceCriteria).toEqual([
        "swarm dispatches to correct agent",
        "existing tests pass",
      ]);
      expect((status as any).metadata?.source).toBe("review");
    });

    it("includes metadata in generated spec.md", () => {
      const featureName = "test-feature";
      setupFeature(featureName);

      const folder = service.create(featureName, "review-fix", undefined, {
        description: "Fix routing issue",
        goal: "Correct agent routing",
        acceptanceCriteria: ["tests pass"],
        references: ["packages/opencode-hive/src/agents/swarm.ts:107-111"],
        files: ["packages/opencode-hive/src/agents/swarm.ts"],
        reason: "Code review",
        source: "review",
      });

      const specPath = path.join(
        TEST_DIR,
        ".hive",
        "features",
        featureName,
        "tasks",
        folder,
        "spec.md"
      );
      const specContent = fs.readFileSync(specPath, "utf-8");
      expect(specContent).toContain("Fix routing issue");
      expect(specContent).toContain("Correct agent routing");
      expect(specContent).toContain("tests pass");
      expect(specContent).toContain("swarm.ts");
    });

    it("persists manual task repoIds and includes them in spec.md", () => {
      const featureName = "test-feature";
      setupFeature(featureName);

      const folder = service.create(featureName, "manual-repo-task", undefined, {
        repoIds: ["api", "web"],
        description: "Manual multi-repo follow-up",
      });

      const status = service.getRawStatus(featureName, folder);
      const info = service.get(featureName, folder);
      const specContent = fs.readFileSync(
        path.join(TEST_DIR, ".hive", "features", featureName, "tasks", folder, "spec.md"),
        "utf-8"
      );

      expect(status?.repoIds).toEqual(["api", "web"]);
      expect((status as any).metadata?.repoIds).toBeUndefined();
      expect(info?.repoIds).toEqual(["api", "web"]);
      expect(specContent).toContain("## Repositories");
      expect(specContent).toContain("- api");
      expect(specContent).toContain("- web");
    });

    it("accepts explicit dependsOn for manual tasks", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-setup", { status: "done", origin: "plan", dependsOn: [] });

      const folder = service.create(featureName, "follow-up", undefined, {
        dependsOn: ["01-setup"],
      });

      const status = service.getRawStatus(featureName, folder);
      expect(status?.dependsOn).toEqual(["01-setup"]);
    });

    it("accepts explicit order when it matches the next append-only slot", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-existing-task", { status: "done", origin: "plan", dependsOn: [] });

      const folder = service.create(featureName, "next-task", 2);

      expect(folder).toBe("02-next-task");
    });

    it("rejects explicit order lower than the next append-only slot", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-existing-task", { status: "done", origin: "plan", dependsOn: [] });

      expect(() => service.create(featureName, "inserted-task", 1)).toThrow(
        /append-only|intermediate insertion requires plan amendment|plan amendment/i
      );
    });

    it("rejects explicit order higher than the next append-only slot", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-existing-task", { status: "done", origin: "plan", dependsOn: [] });

      expect(() => service.create(featureName, "far-future-task", 99)).toThrow(
        /append-only|intermediate insertion requires plan amendment|plan amendment/i
      );
    });

    it("rejects explicit dependsOn when the target task is missing", () => {
      const featureName = "test-feature";
      setupFeature(featureName);

      expect(() =>
        service.create(featureName, "follow-up", undefined, {
          dependsOn: ["01-missing-task"],
        })
      ).toThrow(/dependency.*does not exist/i);
    });

    it("accepts explicit dependsOn when the target task is unfinished", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-setup", { status: "pending", origin: "plan", dependsOn: [] });

      const folder = service.create(featureName, "follow-up", undefined, {
        dependsOn: ["01-setup"],
      });

      expect(service.getRawStatus(featureName, folder)?.dependsOn).toEqual(["01-setup"]);
    });

    it("rejects self-referential manual dependencies", () => {
      const featureName = "test-feature";
      setupFeature(featureName);

      expect(() => service.create(featureName, "follow-up", undefined, {
        dependsOn: ["01-follow-up"],
      })).toThrow(/self-dependency/i);
    });

    it("rejects cycles introduced through existing unfinished dependencies", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-setup", {
        status: "pending",
        origin: "plan",
        dependsOn: ["02-follow-up"],
      });

      expect(() => service.create(featureName, "follow-up", undefined, {
        dependsOn: ["01-setup"],
      })).toThrow(/cycle/i);
    });

    it("reads a legacy status file without dependsOn as no dependencies, not the previous folder", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-setup", {
        status: "pending",
        origin: "plan",
        dependsOn: ["03-follow-up"],
      });
      setupTask(featureName, "02-build", { status: "pending", origin: "plan" });

      const folder = service.create(featureName, "follow-up", undefined, { dependsOn: ["02-build"] });

      expect(folder).toBe("03-follow-up");
      expect(service.getRawStatus(featureName, "02-build")).not.toHaveProperty("dependsOn");
    });

    it("identifies stale stored dependencies separately from the proposed dependency", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-setup", {
        status: "pending",
        origin: "plan",
        dependsOn: ["99-removed"],
      });

      expect(() => service.create(featureName, "follow-up")).toThrow(
        /no task files were changed.*"01-setup" \(pending\) depends on "99-removed", which does not exist/i,
      );
      expect(service.getRawStatus(featureName, "02-follow-up")).toBeNull();
    });

    it("wraps truncated status JSON while loading the manual dependency graph", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-setup");
      const statusPath = path.join(
        TEST_DIR, ".hive", "features", featureName, "tasks", "01-setup", "status.json"
      );
      fs.writeFileSync(statusPath, '{"status":');

      expect(() => service.create(featureName, "follow-up")).toThrow(/01-setup.*corrupt status file/i);
    });

    it("rejects explicit order that reuses an occupied non-append slot", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "05-existing-task", { status: "pending", origin: "plan", dependsOn: [] });

      expect(() => service.create(featureName, "new-task", 5)).toThrow(
        /append-only|intermediate insertion requires plan amendment|plan amendment/i
      );
    });

    it("rejects review-sourced manual tasks with explicit dependsOn", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-setup", { status: "done", origin: "plan", dependsOn: [] });

      expect(() =>
        service.create(featureName, "review-fix", undefined, {
          source: "review",
          dependsOn: ["01-setup"],
          description: "Fix found in review",
        })
      ).toThrow(/review.*dependsOn|dependsOn.*review|plan amendment/i);
    });

    it("allows review-sourced manual tasks without dependsOn", () => {
      const featureName = "test-feature";
      setupFeature(featureName);

      const folder = service.create(featureName, "review-fix", undefined, {
        source: "review",
        description: "Fix found in review",
      });

      const status = service.getRawStatus(featureName, folder);
      expect(status?.origin).toBe("manual");
      expect(status?.dependsOn).toEqual([]);
    });
  });

  describe("readSpec", () => {
    it("returns spec.md content for an existing task", () => {
      const featureName = "test-feature";
      setupFeature(featureName);

      const folder = service.create(featureName, "has-spec", undefined, {
        goal: "Verify readSpec returns the structured content",
        source: "review",
      });

      const spec = service.readSpec(featureName, folder);
      expect(spec).not.toBeNull();
      expect(spec).toContain("# Task:");
      expect(spec).toContain("Verify readSpec returns the structured content");
    });

    it("returns null for a task without spec.md", () => {
      const featureName = "test-feature";
      setupFeature(featureName);
      setupTask(featureName, "01-no-spec");

      const spec = service.readSpec(featureName, "01-no-spec");
      expect(spec).toBeNull();
    });
  });

  describe("sync() - refreshPending mode", () => {
    it("rewrites pending plan tasks when refreshPending is true", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planV1 = `# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: none\n\nSetup.\n\n### 2. Build\n\n**Depends on**: 1\n\nBuild.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV1);
      service.sync(featureName);

      const planV2 = `# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: none\n\nSetup revised.\n\n### 2. Build\n\n**Depends on**: none\n\nBuild now independent.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV2);

      const result = service.sync(featureName, { refreshPending: true });

      const task2Status = service.getRawStatus(featureName, "02-build");
      expect(task2Status?.dependsOn).toEqual([]);
    });

    it("refreshes repoIds for pending plan tasks", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planV1 = `# Plan\n\n## Tasks\n\n### 1. Build\n\n**Repos**: api\n\nBuild.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV1);
      service.sync(featureName);

      const planV2 = `# Plan\n\n## Tasks\n\n### 1. Build\n\n**Repos**: web\n\nBuild revised.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV2);

      service.sync(featureName, { refreshPending: true });

      const status = service.getRawStatus(featureName, "01-build");
      const specContent = fs.readFileSync(path.join(featurePath, "tasks", "01-build", "spec.md"), "utf-8");

      expect(status?.repoIds).toEqual(["web"]);
      expect(specContent).toContain("- web");
      expect(specContent).not.toContain("- api");
    });

    it("does not rewrite repoIds for tasks with execution history during refreshPending", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planV1 = `# Plan\n\n## Tasks\n\n### 1. Build\n\n**Repos**: api\n\nBuild.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV1);
      service.sync(featureName);
      service.update(featureName, "01-build", { status: "in_progress" });

      const planV2 = `# Plan\n\n## Tasks\n\n### 1. Build\n\n**Repos**: web\n\nBuild revised.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV2);

      service.sync(featureName, { refreshPending: true });

      const status = service.getRawStatus(featureName, "01-build");

      expect(status?.status).toBe("in_progress");
      expect(status?.repoIds).toEqual(["api"]);
    });

    it("deletes pending plan tasks removed from plan when refreshPending is true", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planV1 = `# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: none\n\nSetup.\n\n### 2. Old Task\n\n**Depends on**: 1\n\nOld task.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV1);
      service.sync(featureName);

      const planV2 = `# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: none\n\nSetup.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV2);

      const result = service.sync(featureName, { refreshPending: true });
      expect(result.removed).toContain("02-old-task");

      const oldTaskStatus = service.getRawStatus(featureName, "02-old-task");
      expect(oldTaskStatus).toBeNull();
    });

    it("preserves manual tasks during refreshPending sync", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const plan = `# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: none\n\nSetup.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), plan);
      service.sync(featureName);

      service.create(featureName, "manual-fix");

      const result = service.sync(featureName, { refreshPending: true });
      expect(result.manual).toContain("02-manual-fix");

      const manualStatus = service.getRawStatus(featureName, "02-manual-fix");
      expect(manualStatus).not.toBeNull();
      expect(manualStatus?.origin).toBe("manual");
    });

    it("does not touch tasks with execution history during refreshPending", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const plan = `# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: none\n\nSetup.\n\n### 2. Build\n\n**Depends on**: 1\n\nBuild.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), plan);
      service.sync(featureName);

      service.update(featureName, "01-setup", { status: "done", summary: "Done" });

      const planV2 = `# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: none\n\nSetup revised.\n\n### 2. Build\n\n**Depends on**: none\n\nBuild revised.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV2);

      service.sync(featureName, { refreshPending: true });

      const setupStatus = service.getRawStatus(featureName, "01-setup");
      expect(setupStatus?.status).toBe("done");
      expect(setupStatus?.summary).toBe("Done");
    });

    it("refreshes planTitle and spec.md for pending plan tasks", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planV1 = `# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: none\n\nOld description.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV1);
      service.sync(featureName);

      const planV2 = `# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: none\n\nNew description with changes.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV2);
      service.sync(featureName, { refreshPending: true });

      const specPath = path.join(featurePath, "tasks", "01-setup", "spec.md");
      const specContent = fs.readFileSync(specPath, "utf-8");
      expect(specContent).toContain("New description with changes");
    });

    it("preserves in_progress tasks during refreshPending", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const plan = `# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: none\n\nSetup.\n\n### 2. Build\n\n**Depends on**: 1\n\nBuild.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), plan);
      service.sync(featureName);

      service.update(featureName, "02-build", { status: "in_progress" });

      const planV2 = `# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: none\n\nSetup.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV2);

      service.sync(featureName, { refreshPending: true });

      const buildStatus = service.getRawStatus(featureName, "02-build");
      expect(buildStatus).not.toBeNull();
      expect(buildStatus?.status).toBe("in_progress");
    });

    it("preserves blocked/failed/partial tasks during refreshPending", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const plan = `# Plan\n\n## Tasks\n\n### 1. TaskA\n\n**Depends on**: none\n\nA.\n\n### 2. TaskB\n\n**Depends on**: 1\n\nB.\n\n### 3. TaskC\n\n**Depends on**: 1\n\nC.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), plan);
      service.sync(featureName);

      service.update(featureName, "01-taska", { status: "blocked" });
      service.update(featureName, "02-taskb", { status: "failed" });
      service.update(featureName, "03-taskc", { status: "partial" });

      const planV2 = `# Plan\n\n## Tasks\n\n### 1. NewTask\n\n**Depends on**: none\n\nNew.\n`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV2);

      service.sync(featureName, { refreshPending: true });

      expect(service.getRawStatus(featureName, "01-taska")?.status).toBe("blocked");
      expect(service.getRawStatus(featureName, "02-taskb")?.status).toBe("failed");
      expect(service.getRawStatus(featureName, "03-taskc")?.status).toBe("partial");
    });

    it("does not remove pending tasks when a non-task Final Verification section is added", () => {
      const featureName = "test-feature";
      const featurePath = path.join(TEST_DIR, ".hive", "features", featureName);
      fs.mkdirSync(featurePath, { recursive: true });

      fs.writeFileSync(
        path.join(featurePath, "feature.json"),
        JSON.stringify({ name: featureName, status: "executing", createdAt: new Date().toISOString() })
      );

      const planV1 = `# Plan

## Tasks

### 1. Setup

**Depends on**: none

Setup.

### 2. Build

**Depends on**: 1

Build.
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV1);
      service.sync(featureName);

      const planV2 = `${planV1}
## Final Verification

### 1. Run verification

- [ ] Run: bun test -> PASS
`;
      fs.writeFileSync(path.join(featurePath, "plan.md"), planV2);

      const result = service.sync(featureName, { refreshPending: true });

      expect(result.removed).not.toContain("01-setup");
      expect(result.removed).not.toContain("02-build");
      expect(service.getRawStatus(featureName, "01-setup")).not.toBeNull();
      expect(service.getRawStatus(featureName, "02-build")).not.toBeNull();
      expect(service.getRawStatus(featureName, "01-run-verification")).toBeNull();
    });
  });

  describe("sync() - unfinished stored dependency graph", () => {
    const featureName = "test-feature";
    const featurePath = () => path.join(TEST_DIR, ".hive", "features", featureName);
    const writePlan = (content: string) => fs.writeFileSync(path.join(featurePath(), "plan.md"), content);

    function snapshotTasks(): Record<string, string | null> {
      const tasksPath = path.join(featurePath(), "tasks");
      const snapshot: Record<string, string | null> = {};
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const relative = path.relative(tasksPath, full);
          if (entry.isDirectory()) {
            snapshot[relative] = null;
            walk(full);
          } else {
            snapshot[relative] = fs.readFileSync(full, "utf-8");
          }
        }
      };
      if (fs.existsSync(tasksPath)) walk(tasksPath);
      return snapshot;
    }

    beforeEach(() => {
      setupFeature(featureName);
    });

    it("rejects removing a plan task that an unfinished manual task still depends on, leaving task files unchanged", () => {
      writePlan(`# Plan\n\n## Tasks\n\n### 1. Producer\n\n**Depends on**: none\n\nProduce.\n\n### 2. Independent\n\n**Depends on**: none\n\nIndependent.\n`);
      service.sync(featureName);
      const consumer = service.create(featureName, "consumer", undefined, { dependsOn: ["01-producer"] });
      expect(consumer).toBe("03-consumer");

      writePlan(`# Plan\n\n## Tasks\n\n### 2. Independent\n\n**Depends on**: none\n\nIndependent.\n`);
      const before = snapshotTasks();

      let message = "";
      try {
        service.sync(featureName, { refreshPending: true });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("no task files were changed");
      expect(message).toContain('"03-consumer" (pending) depends on "01-producer", which this sync would remove');
      expect(message).toContain('add a "### 1. <title>" task to plan.md');
      expect(message).toMatch(/cancel it with hive_task_update.*does not stop a running worker or rewire/);
      expect(message).not.toContain("refreshPending");
      expect(snapshotTasks()).toEqual(before);
    });

    it("rejects a cycle formed between a retained unfinished task and a refreshed pending task", () => {
      writePlan(`# Plan\n\n## Tasks\n\n### 1. Alpha\n\n**Depends on**: 2\n\nAlpha.\n\n### 2. Beta\n\n**Depends on**: none\n\nBeta.\n`);
      service.sync(featureName);
      service.update(featureName, "01-alpha", { status: "in_progress" });

      writePlan(`# Plan\n\n## Tasks\n\n### 1. Alpha\n\n**Depends on**: none\n\nAlpha.\n\n### 2. Beta\n\n**Depends on**: 1\n\nBeta.\n`);
      const before = snapshotTasks();

      expect(() => service.sync(featureName, { refreshPending: true })).toThrow(
        /cycle: 01-alpha -> 02-beta -> 01-alpha.*"01-alpha" keeps its stored dependencies.*"02-beta" takes its dependencies from plan\.md/,
      );
      expect(snapshotTasks()).toEqual(before);
    });

    it("names refreshPending for a stale pending plan edge and accepts the refreshed graph", () => {
      writePlan(`# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: none\n\nSetup.\n\n### 2. Build\n\n**Depends on**: 1\n\nBuild.\n`);
      service.sync(featureName);
      setupTask(featureName, "02-build", { status: "pending", origin: "plan", planTitle: "Build", dependsOn: ["09-gone"] });
      const before = snapshotTasks();

      expect(() => service.sync(featureName)).toThrow(
        /"02-build" \(pending\) depends on "09-gone", which does not exist.*refreshPending: true/,
      );
      expect(snapshotTasks()).toEqual(before);

      expect(service.sync(featureName, { refreshPending: true }).kept).toEqual(["01-setup", "02-build"]);
      expect(service.getRawStatus(featureName, "02-build")?.dependsOn).toEqual(["01-setup"]);
    });

    it("validates the proposed graph, so restoring a missing predecessor repairs an old dangling edge", () => {
      writePlan(`# Plan\n\n## Tasks\n\n### 2. Independent\n\n**Depends on**: none\n\nIndependent.\n`);
      service.sync(featureName);
      setupTask(featureName, "03-consumer", { status: "blocked", origin: "manual", dependsOn: ["01-producer"] });

      expect(() => service.sync(featureName)).toThrow(/"03-consumer" \(blocked\) depends on "01-producer", which does not exist/);

      writePlan(`# Plan\n\n## Tasks\n\n### 1. Producer\n\n**Depends on**: none\n\nProduce.\n\n### 2. Independent\n\n**Depends on**: none\n\nIndependent.\n`);
      expect(service.sync(featureName).created).toEqual(["01-producer"]);
    });

    it("uses a manual record's stored edges even when a plan heading has the same folder", () => {
      setupTask(featureName, "02-build", { status: "pending", origin: "manual", dependsOn: ["01-setup"] });
      writePlan(`# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: 2\n\nSetup.\n\n### 2. Build\n\n**Depends on**: none\n\nBuild.\n`);
      const before = snapshotTasks();

      expect(() => service.sync(featureName)).toThrow(
        /cycle: 02-build -> 01-setup -> 02-build.*"02-build" keeps its stored dependencies.*"01-setup" takes its dependencies from plan\.md/,
      );
      expect(snapshotTasks()).toEqual(before);
      expect(service.getRawStatus(featureName, "02-build")?.origin).toBe("manual");
    });

    it("ignores done and cancelled tasks' historical edges when validating the stored graph", () => {
      writePlan(`# Plan\n\n## Tasks\n\n### 1. History\n\n**Depends on**: none\n\nHistory.\n\n### 2. Consumer\n\n**Depends on**: 1\n\nConsumer.\n`);
      service.sync(featureName);
      setupTask(featureName, "01-history", { status: "done", origin: "plan", planTitle: "History", dependsOn: ["02-consumer", "09-gone"] });
      setupTask(featureName, "03-abandoned", { status: "cancelled", origin: "manual", dependsOn: ["03-abandoned", "08-gone"] });

      expect(service.sync(featureName, { refreshPending: true })).toMatchObject({
        removed: [],
        kept: ["01-history", "02-consumer"],
        manual: ["03-abandoned"],
      });
      expect(service.getRawStatus(featureName, "01-history")?.dependsOn).toEqual(["02-consumer", "09-gone"]);
    });

    it("releases a cancelled source's edges without rewiring its consumers, and keeps cancelled records across syncs", () => {
      writePlan(`# Plan\n\n## Tasks\n\n### 1. Producer\n\n**Depends on**: none\n\nProduce.\n\n### 2. Obsolete\n\n**Depends on**: none\n\nObsolete.\n`);
      service.sync(featureName);
      const middle = service.create(featureName, "middle", undefined, { dependsOn: ["01-producer"] });
      const consumer = service.create(featureName, "consumer", undefined, { dependsOn: [middle] });
      service.update(featureName, "02-obsolete", { status: "cancelled", report: "Superseded.", handoff: "Do not resume." });

      writePlan(`# Plan\n\n## Tasks\n\n### 2. Obsolete\n\n**Depends on**: none\n\nObsolete.\n`);
      expect(() => service.sync(featureName)).toThrow(/"03-middle" \(pending\) depends on "01-producer"/);

      service.update(featureName, middle, { status: "cancelled" });
      writePlan(`# Plan\n\n## Tasks\n\nNo remaining plan tasks.\n`);
      const first = service.sync(featureName);
      const artifacts = snapshotTasks();
      const second = service.sync(featureName);

      for (const result of [first, second]) {
        expect(result.kept).toContain("02-obsolete");
        expect(result.manual).toEqual(["03-middle", "04-consumer"]);
      }
      expect(first.removed).toEqual(["01-producer"]);
      expect(second.removed).toEqual([]);
      expect(snapshotTasks()).toEqual(artifacts);
      expect(artifacts[path.join("02-obsolete", "report.md")]).toBe("Superseded.");
      expect(artifacts[path.join("02-obsolete", "handoff.md")]).toBe("Do not resume.");
      expect(service.getRawStatus(featureName, "02-obsolete")?.status).toBe("cancelled");
      expect(service.getRawStatus(featureName, middle)).toMatchObject({ status: "cancelled", dependsOn: ["01-producer"] });
      expect(service.getRawStatus(featureName, consumer)).toMatchObject({ status: "pending", dependsOn: [middle] });
    });

    it("rejects duplicate plan task numbers before any task file is written", () => {
      writePlan(`# Plan\n\n## Tasks\n\n### 1. Setup\n\nSetup.\n\n### 1. Other\n\nOther.\n`);

      expect(() => service.sync(featureName)).toThrow(/task number 1 is used by both "Setup" and "Other"/);
      expect(snapshotTasks()).toEqual({});
    });

    it("leaves task updates ungated but detects a reopened task's invalid edge at the next sync or manual creation", () => {
      writePlan(`# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: none\n\nSetup.\n`);
      service.sync(featureName);
      setupTask(featureName, "01-setup", { status: "done", origin: "plan", planTitle: "Setup", dependsOn: ["09-gone"] });
      service.sync(featureName);

      expect(service.update(featureName, "01-setup", { status: "pending" }).status).toBe("pending");
      expect(() => service.sync(featureName)).toThrow(/"01-setup" \(pending\) depends on "09-gone"/);
      expect(() => service.create(featureName, "follow-up")).toThrow(
        /Manual task creation rejected.*"01-setup" \(pending\) depends on "09-gone"/,
      );
    });
  });
});
