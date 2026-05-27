import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import plugin from "../index";

const OPENCODE_CLIENT = createOpencodeClient({ baseUrl: "http://localhost:1" });
const removedHiveSkillTool = ['hive', 'skill'].join('_');

const TEST_ROOT_BASE = "/tmp/hive-agent-mode-test";

function createProject(worktree: string) {
  return {
    id: "test",
    worktree,
    time: { created: Date.now() },
  };
}

describe("agentMode gating", () => {
  let testRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, "project-"));
    process.env.HOME = testRoot;
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it("registers hive-master, scout, forager, and reviewer agents in unified mode", async () => {
    const configPath = path.join(testRoot, ".config", "opencode", "agent_hive.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agentMode: "unified",
      }),
    );

    const ctx: any = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
    };

    const hooks = await plugin(ctx);
    const opencodeConfig: any = { agent: {} };
    await hooks.config!(opencodeConfig);

    expect(opencodeConfig.agent["hive-master"]).toBeDefined();
    expect(opencodeConfig.agent["architect-planner"]).toBeUndefined();
    expect(opencodeConfig.agent["swarm-orchestrator"]).toBeUndefined();
    expect(opencodeConfig.agent["scout-researcher"]).toBeDefined();
    expect(opencodeConfig.agent["forager-worker"]).toBeDefined();
    expect(opencodeConfig.agent["hive-helper"]).toBeDefined();
    expect(opencodeConfig.agent["plan-reviewer"]).toBeDefined();
    expect(opencodeConfig.agent["code-reviewer"]).toBeDefined();
    expect(opencodeConfig.agent["simplicity-reviewer"]).toBeDefined();
    expect(opencodeConfig.agent["approach-advisor"]).toBeDefined();
    expect(opencodeConfig.agent["hive-builder"]).toBeDefined();
    expect(opencodeConfig.default_agent).toBe("hive-master");
  });

  it("registers dedicated agents in dedicated mode", async () => {
    const configPath = path.join(testRoot, ".config", "opencode", "agent_hive.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agentMode: "dedicated",
      }),
    );

    const ctx: any = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
    };

    const hooks = await plugin(ctx);
    const opencodeConfig: any = { agent: {} };
    await hooks.config!(opencodeConfig);

    expect(opencodeConfig.agent["hive-master"]).toBeUndefined();
    expect(opencodeConfig.agent["architect-planner"]).toBeDefined();
    expect(opencodeConfig.agent["swarm-orchestrator"]).toBeDefined();
    expect(opencodeConfig.agent["scout-researcher"]).toBeDefined();
    expect(opencodeConfig.agent["forager-worker"]).toBeDefined();
    expect(opencodeConfig.agent["hive-helper"]).toBeDefined();
    expect(opencodeConfig.agent["plan-reviewer"]).toBeDefined();
    expect(opencodeConfig.agent["code-reviewer"]).toBeDefined();
    expect(opencodeConfig.agent["simplicity-reviewer"]).toBeDefined();
    expect(opencodeConfig.agent["approach-advisor"]).toBeDefined();
    expect(opencodeConfig.agent["hive-builder"]).toBeDefined();
    expect(opencodeConfig.default_agent).toBe("architect-planner");
  });

  it("injects custom-subagent appendix into dedicated-mode primary prompts and registers custom agents", async () => {
    const configPath = path.join(testRoot, ".config", "opencode", "agent_hive.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agentMode: "dedicated",
        customAgents: {
          "scout-docs": {
            baseAgent: "scout-researcher",
            description: "Use for documentation-heavy research tasks.",
            autoLoadSkills: [],
          },
          "forager-ui": {
            baseAgent: "forager-worker",
            description: "Use for UI-heavy implementation tasks.",
            autoLoadSkills: [],
          },
          "reviewer-security": {
            baseAgent: "code-reviewer",
            description: "Use for security-focused review passes.",
            autoLoadSkills: [],
          },
        },
      }),
    );

    const ctx: any = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
    };

    const hooks = await plugin(ctx);
    const opencodeConfig: any = { agent: {} };
    await hooks.config!(opencodeConfig);

    expect(opencodeConfig.agent["forager-ui"]).toBeDefined();
    expect(opencodeConfig.agent["scout-docs"]).toBeDefined();
    expect(opencodeConfig.agent["reviewer-security"]).toBeDefined();

    const architectPrompt = opencodeConfig.agent["architect-planner"]?.prompt as string;
    expect(architectPrompt).toContain("## Configured Custom Subagents");
    expect(architectPrompt).toContain("scout-docs");
    expect(architectPrompt).toContain("forager-ui");

    expect(opencodeConfig.agent["swarm-orchestrator"]?.prompt).toBeUndefined();
    const systemTransform = hooks["experimental.chat.system.transform" as keyof typeof hooks] as
      | ((input: { sessionID?: string; agent?: string }, output: { system: string[] }) => Promise<void>)
      | undefined;
    const swarmOutput = { system: ["OpenCode provider base prompt"] };
    await systemTransform?.({ sessionID: "sess_swarm_custom_appendix", agent: "swarm-orchestrator" }, swarmOutput);
    const swarmPrompt = swarmOutput.system[0];
    expect(swarmPrompt).toContain("## Configured Custom Subagents");
    expect(swarmPrompt).toContain("scout-docs");
    expect(swarmPrompt).toContain("reviewer-security");

    expect(opencodeConfig.agent["hive-builder"]?.prompt).toBeUndefined();
    await hooks["chat.message"]?.(
      { sessionID: "sess_builder_custom_appendix", agent: "hive-builder" },
      { message: {}, parts: [] } as any,
    );
    const output = { system: ["OpenCode provider base prompt"] };
    await systemTransform?.({ sessionID: "sess_builder_custom_appendix" }, output);
    const builderPrompt = output.system[0];
    expect(builderPrompt).toContain("## Configured Custom Subagents");
    expect(builderPrompt).toContain("scout-docs");
    expect(builderPrompt).toContain("forager-ui");

    expect(opencodeConfig.agent["forager-ui"]?.prompt).toBeUndefined();
    const foragerUiOutput = { system: ["OpenCode provider base prompt"] };
    await systemTransform?.({ sessionID: "sess_forager_ui_appendix", agent: "forager-ui" }, foragerUiOutput);
    const foragerUiPrompt = foragerUiOutput.system[0];
    expect(foragerUiPrompt).toContain("# Forager");
    expect(foragerUiPrompt).not.toContain("Use for UI-heavy implementation tasks.");

    expect(opencodeConfig.agent["hive-master"]).toBeUndefined();
  });

  it("does not expose the removed historical lookup tool to any agent", async () => {
    const configPath = path.join(testRoot, ".config", "opencode", "agent_hive.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agentMode: "dedicated",
      }),
    );

    const ctx: any = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
    };

    const hooks = await plugin(ctx);
    const opencodeConfig: any = { agent: {} };
    await hooks.config!(opencodeConfig);

    const removedNetworkTool = ["hive", "network", "query"].join("_");
    for (const agent of Object.values(opencodeConfig.agent)) {
      expect((agent as any).tools ?? {}).not.toHaveProperty(removedNetworkTool);
    }
  });

  it("keeps hive-helper bounded to merge recovery, state clarification, append-only manual follow-up, and no plugin-defined skill tool", async () => {
    const configPath = path.join(testRoot, ".config", "opencode", "agent_hive.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agentMode: "dedicated",
      }),
    );

    const ctx: any = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
    };

    const hooks = await plugin(ctx);
    const opencodeConfig: any = { agent: {} };
    await hooks.config!(opencodeConfig);

    const helper = opencodeConfig.agent["hive-helper"];
    expect(helper).toBeDefined();
    expect(helper.description).toContain("bounded hard-task operational assistant");
    expect(helper.description).toContain("merge recovery");
    expect(helper.description).toContain("state clarification");
    expect(helper.description).toContain("manual follow-up");
    expect(helper.prompt).toContain("safe append-only manual tasks");
    expect(helper.prompt).toContain("never update plan-backed task state");
    expect(helper.prompt).not.toContain("## Hive Skill:");
    expect(helper.tools?.["hive_merge"]).toBeUndefined();
    expect(helper.tools?.["hive_status"]).toBeUndefined();
    expect(helper.tools?.["hive_context_write"]).toBeUndefined();
    expect(helper.tools?.["hive_task_create"]).toBeUndefined();
    expect(helper.tools?.[removedHiveSkillTool]).toBeUndefined();
    expect(helper.tools?.["hive_task_update"]).toBe(false);
    expect(helper.tools?.["hive_plan_read"]).toBe(false);
    expect(helper.tools?.["hive_tasks_sync"]).toBe(false);
    expect(helper.tools?.["hive_worktree_start"]).toBe(false);
    expect(helper.tools?.["hive_worktree_create"]).toBe(false);
    expect(helper.tools?.["hive_worktree_commit"]).toBe(false);
    expect(helper.permission?.task).toBe("deny");
    expect(helper.permission?.delegate).toBe("deny");
  });
});
