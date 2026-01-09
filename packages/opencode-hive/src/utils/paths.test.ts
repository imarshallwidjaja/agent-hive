import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  getHivePath,
  getFeaturesPath,
  getFeaturePath,
  getPlanPath,
  getCommentsPath,
  getFeatureJsonPath,
  getContextPath,
  getTasksPath,
  getTaskPath,
  getTaskStatusPath,
  getTaskReportPath,
  ensureDir,
  fileExists,
  readJson,
  writeJson,
  readText,
  writeText,
} from "./paths";

const TEST_ROOT = "/tmp/hive-test-paths";

describe("paths.ts", () => {
  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  describe("path generators", () => {
    it("getHivePath returns correct path", () => {
      expect(getHivePath(TEST_ROOT)).toBe(path.join(TEST_ROOT, ".hive"));
    });

    it("getFeaturesPath returns correct path", () => {
      expect(getFeaturesPath(TEST_ROOT)).toBe(
        path.join(TEST_ROOT, ".hive", "features")
      );
    });

    it("getFeaturePath returns correct path", () => {
      expect(getFeaturePath(TEST_ROOT, "my-feature")).toBe(
        path.join(TEST_ROOT, ".hive", "features", "my-feature")
      );
    });

    it("getPlanPath returns correct path", () => {
      expect(getPlanPath(TEST_ROOT, "my-feature")).toBe(
        path.join(TEST_ROOT, ".hive", "features", "my-feature", "plan.md")
      );
    });

    it("getCommentsPath returns correct path", () => {
      expect(getCommentsPath(TEST_ROOT, "my-feature")).toBe(
        path.join(TEST_ROOT, ".hive", "features", "my-feature", "comments.json")
      );
    });

    it("getFeatureJsonPath returns correct path", () => {
      expect(getFeatureJsonPath(TEST_ROOT, "my-feature")).toBe(
        path.join(TEST_ROOT, ".hive", "features", "my-feature", "feature.json")
      );
    });

    it("getContextPath returns correct path", () => {
      expect(getContextPath(TEST_ROOT, "my-feature")).toBe(
        path.join(TEST_ROOT, ".hive", "features", "my-feature", "context")
      );
    });

    it("getTasksPath returns correct path", () => {
      expect(getTasksPath(TEST_ROOT, "my-feature")).toBe(
        path.join(TEST_ROOT, ".hive", "features", "my-feature", "tasks")
      );
    });

    it("getTaskPath returns correct path", () => {
      expect(getTaskPath(TEST_ROOT, "my-feature", "01-setup")).toBe(
        path.join(TEST_ROOT, ".hive", "features", "my-feature", "tasks", "01-setup")
      );
    });

    it("getTaskStatusPath returns correct path", () => {
      expect(getTaskStatusPath(TEST_ROOT, "my-feature", "01-setup")).toBe(
        path.join(TEST_ROOT, ".hive", "features", "my-feature", "tasks", "01-setup", "status.json")
      );
    });

    it("getTaskReportPath returns correct path", () => {
      expect(getTaskReportPath(TEST_ROOT, "my-feature", "01-setup")).toBe(
        path.join(TEST_ROOT, ".hive", "features", "my-feature", "tasks", "01-setup", "report.md")
      );
    });
  });

  describe("file utilities", () => {
    it("ensureDir creates directory recursively", () => {
      const deepPath = path.join(TEST_ROOT, "a", "b", "c");
      ensureDir(deepPath);
      expect(fs.existsSync(deepPath)).toBe(true);
    });

    it("ensureDir is idempotent", () => {
      const dirPath = path.join(TEST_ROOT, "existing");
      fs.mkdirSync(dirPath, { recursive: true });
      expect(() => ensureDir(dirPath)).not.toThrow();
    });

    it("fileExists returns true for existing file", () => {
      const filePath = path.join(TEST_ROOT, "exists.txt");
      fs.writeFileSync(filePath, "content");
      expect(fileExists(filePath)).toBe(true);
    });

    it("fileExists returns false for non-existing file", () => {
      expect(fileExists(path.join(TEST_ROOT, "nope.txt"))).toBe(false);
    });

    it("writeJson and readJson roundtrip", () => {
      const filePath = path.join(TEST_ROOT, "data.json");
      const data = { name: "test", count: 42, nested: { value: true } };
      writeJson(filePath, data);
      const result = readJson<typeof data>(filePath);
      expect(result).toEqual(data);
    });

    it("readJson returns null for non-existing file", () => {
      expect(readJson(path.join(TEST_ROOT, "nope.json"))).toBeNull();
    });

    it("writeText and readText roundtrip", () => {
      const filePath = path.join(TEST_ROOT, "text.md");
      const content = "# Hello\n\nThis is content.";
      writeText(filePath, content);
      const result = readText(filePath);
      expect(result).toBe(content);
    });

    it("readText returns null for non-existing file", () => {
      expect(readText(path.join(TEST_ROOT, "nope.md"))).toBeNull();
    });

    it("writeJson creates parent directories", () => {
      const filePath = path.join(TEST_ROOT, "deep", "nested", "data.json");
      const expected = { test: true };
      writeJson(filePath, expected);
      expect(readJson<{ test: boolean }>(filePath)).toEqual(expected);
    });

    it("writeText creates parent directories", () => {
      const filePath = path.join(TEST_ROOT, "deep", "nested", "file.txt");
      writeText(filePath, "content");
      expect(readText(filePath)).toBe("content");
    });
  });
});
