import { describe, expect, it } from "bun:test";
import { BUILT_IN_AGENT_NAMES, CUSTOM_AGENT_BASES, CUSTOM_AGENT_RESERVED_NAMES, DEFAULT_HIVE_CONFIG, getHivePath } from "./index";
import { detectContext } from "./utils/detection";

describe("hive-core", () => {
  it("exports path helpers", () => {
    expect(getHivePath("/tmp/project")).toBe("/tmp/project/.hive");
  });

  it("detects worktree paths on Windows", () => {
    const result = detectContext("C:\\repo\\.hive\\.worktrees\\feature-x\\01-task");

    expect(result.isWorktree).toBe(true);
    expect(result.feature).toBe("feature-x");
    expect(result.task).toBe("01-task");
    expect(result.projectRoot).toBe("C:/repo");
  });

  it("keeps hive-helper reserved only once", () => {
    expect(CUSTOM_AGENT_RESERVED_NAMES.filter((name) => name === 'hive-helper')).toHaveLength(1);
  });

  it("includes hive-builder in BUILT_IN_AGENT_NAMES", () => {
    expect(BUILT_IN_AGENT_NAMES).toContain('hive-builder');
  });

  it("includes simplicity-reviewer as built-in but not as a custom-agent base", () => {
    expect(BUILT_IN_AGENT_NAMES).toContain('simplicity-reviewer');
    expect(CUSTOM_AGENT_RESERVED_NAMES).toContain('simplicity-reviewer');
    expect(CUSTOM_AGENT_BASES).not.toContain('simplicity-reviewer');
  });

  it("includes hive-builder defaults in DEFAULT_HIVE_CONFIG", () => {
    expect(DEFAULT_HIVE_CONFIG.agents?.['hive-builder']).toBeDefined();
    expect(DEFAULT_HIVE_CONFIG.agents?.['hive-builder']?.temperature).toBe(0.4);
    expect(DEFAULT_HIVE_CONFIG.agents?.['hive-builder']?.model).toBe('github-copilot/gpt-5.2-codex');
    expect(DEFAULT_HIVE_CONFIG.agents?.['hive-builder']?.autoLoadSkills).toEqual([
      'verification',
      'dispatching-parallel-agents',
      'parallel-exploration',
    ]);
  });

  it("includes hive-builder and builder in CUSTOM_AGENT_RESERVED_NAMES", () => {
    expect(CUSTOM_AGENT_RESERVED_NAMES).toContain('hive-builder');
    expect(CUSTOM_AGENT_RESERVED_NAMES).toContain('builder');
  });
});
