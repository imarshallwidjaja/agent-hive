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

  it('reserves dash-reviewer as a custom-agent name without making it a configurable built-in', () => {
    expect(BUILT_IN_AGENT_NAMES).not.toContain('dash-reviewer');
    expect(CUSTOM_AGENT_RESERVED_NAMES).toContain('dash-reviewer');
    expect(DEFAULT_HIVE_CONFIG.agents).not.toHaveProperty('dash-reviewer');
  });

  it("includes simplicity-reviewer as built-in and as a custom-agent base", () => {
    expect(BUILT_IN_AGENT_NAMES).toContain('simplicity-reviewer');
    expect(CUSTOM_AGENT_RESERVED_NAMES).toContain('simplicity-reviewer');
    expect(CUSTOM_AGENT_BASES).toContain('simplicity-reviewer');
  });

  it("includes forager-investigator as a configurable built-in and custom-agent base with verification-only defaults", () => {
    expect(BUILT_IN_AGENT_NAMES).toContain('forager-investigator');
    expect(CUSTOM_AGENT_BASES).toContain('forager-investigator');
    expect(CUSTOM_AGENT_RESERVED_NAMES).toContain('forager-investigator');
    expect(DEFAULT_HIVE_CONFIG.agents?.['forager-investigator']).toEqual({ autoLoadSkills: ['verification'] });
  });

  it("includes hive-builder skill defaults, but no model, in DEFAULT_HIVE_CONFIG", () => {
    expect(DEFAULT_HIVE_CONFIG.agents?.['hive-builder']).toEqual({
      autoLoadSkills: ['verification', 'parallel-exploration'],
    });
  });

  it("exports no generated model defaults", async () => {
    const exported = await import('./index');
    expect(exported).not.toHaveProperty('DEFAULT_AGENT_MODELS');
  });

  it("includes hive-builder and builder in CUSTOM_AGENT_RESERVED_NAMES", () => {
    expect(CUSTOM_AGENT_RESERVED_NAMES).toContain('hive-builder');
    expect(CUSTOM_AGENT_RESERVED_NAMES).toContain('builder');
  });
});
