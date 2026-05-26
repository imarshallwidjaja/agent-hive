import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { PluginInput } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk";
import plugin from "../index";
import { QUEEN_BEE_PROMPT } from "../agents/hive";
import { SWARM_BEE_PROMPT } from "../agents/swarm";
import { FORAGER_BEE_PROMPT } from "../agents/forager";
import { HIVE_BUILDER_PROMPT } from "../agents/hive-builder";
import { HIVE_SYSTEM_PROMPT } from "../hooks/system-hook";
import { BUILTIN_SKILLS } from "../skills/registry.generated.js";
import { buildPluginManifest, HIVE_COMMANDS, HIVE_TOOL_NAMES, SUPPORTED_PLUGIN_HOOKS } from '../utils/plugin-manifest.js';

const OPENCODE_CLIENT = createOpencodeClient({ baseUrl: "http://localhost:1" }) as unknown as PluginInput["client"];
type PluginHooks = Awaited<ReturnType<typeof plugin>>;

type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  abort: AbortSignal;
};

const EXPECTED_TOOLS = [...HIVE_TOOL_NAMES];

const EXPECTED_COMMANDS = HIVE_COMMANDS.map(({ name, description }) => ({ name, description }));
const removedHiveSkillTool = ['hive', 'skill'].join('_');

const UNSUPPORTED_RUNTIME_HOOKS = [
  "experimental.session.compacting",
  'tool.execute' + '.after',
] as const;

const REMOVED_PROJECTED_TODO_FIELD = ['todo', 'Projection'].join('');
const REMOVED_TODO_REFRESH_HINT = ['Refresh hive_status() before syncing OpenCode ', 'todos.'].join('');
const LEGACY_IDLE_CHILD_REPLAY = ['child-session', ' idle'].join('');

const TEST_ROOT_BASE = "/tmp/hive-e2e-plugin";
const TEST_PROCESS_CWD = process.cwd();
const FIRST_TASK = "01-first-task";

function createStubShell(): PluginInput["$"] {
  let shell: PluginInput["$"];

  const fn = ((..._args: unknown[]) => {
    throw new Error("shell not available in this test");
  }) as unknown as PluginInput["$"];

  shell = Object.assign(fn, {
    braces(pattern: string) {
      return [pattern];
    },
    escape(input: string) {
      return input;
    },
    env() {
      return shell;
    },
    cwd() {
      return shell;
    },
    nothrow() {
      return shell;
    },
    throws() {
      return shell;
    },
  });

  return shell;
}

function createToolContext(sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: "msg_test",
    agent: "test",
    abort: new AbortController().signal,
  };
}

function createProject(worktree: string): PluginInput["project"] {
  return {
    id: "test",
    worktree,
    time: { created: Date.now() },
  };
}

function readHeadBody(targetPath: string): string {
  return execSync("git log -1 --format=%B", {
    cwd: targetPath,
    encoding: "utf-8",
  }).trimEnd();
}

function createSingleTaskPlan(title: string, answer: string): string {
  return `# ${title}

## Discovery

**Q: Is this a test?**
A: ${answer}

## Tasks

### 1. First Task
Do it
`;
}

async function createHooksForTest(testRoot: string, sessionID: string): Promise<{
  hooks: PluginHooks;
  toolContext: ToolContext;
}> {
  const ctx: PluginInput = {
    directory: testRoot,
    worktree: testRoot,
    serverUrl: new URL("http://localhost:1"),
    project: createProject(testRoot),
    client: OPENCODE_CLIENT,
    $: createStubShell(),
  };

  return {
    hooks: await plugin(ctx),
    toolContext: createToolContext(sessionID),
  };
}

async function createSingleTaskWorktree(
  testRoot: string,
  sessionID: string,
  feature: string,
  title: string,
  answer: string,
): Promise<{
  hooks: PluginHooks;
  toolContext: ToolContext;
  worktreePath: string;
}> {
  const { hooks, toolContext } = await createHooksForTest(testRoot, sessionID);

  await hooks.tool!.hive_feature_create.execute({ name: feature }, toolContext);
  await hooks.tool!.hive_plan_write.execute(
    { content: createSingleTaskPlan(title, answer), feature },
    toolContext,
  );
  await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
  await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);

  const worktreeRaw = await hooks.tool!.hive_worktree_start.execute(
    { feature, task: FIRST_TASK },
    toolContext,
  );
  const { worktreePath } = JSON.parse(worktreeRaw as string) as {
    worktreePath: string;
  };

  return { hooks, toolContext, worktreePath };
}

describe("e2e: opencode-hive plugin (in-process)", () => {
  let testRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    process.chdir(TEST_PROCESS_CWD);
    originalHome = process.env.HOME;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, "project-"));
    process.env.HOME = testRoot;
    
    execSync("git init", { cwd: testRoot });
    execSync('git config user.email "test@example.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    fs.writeFileSync(path.join(testRoot, "README.md"), "smoke test");
    execSync("git add README.md", { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });
  });

  afterEach(() => {
    process.chdir(TEST_PROCESS_CWD);
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it("registers expected tools and basic workflow works", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);

    expect(hooks.tool).toBeDefined();
    expect(hooks.tool?.[removedHiveSkillTool]).toBeUndefined();
    expect(HIVE_TOOL_NAMES).not.toContain(removedHiveSkillTool);

    for (const toolName of EXPECTED_TOOLS) {
      expect(hooks.tool?.[toolName]).toBeDefined();
      expect(typeof hooks.tool?.[toolName].execute).toBe("function");
    }

    for (const hookName of SUPPORTED_PLUGIN_HOOKS) {
      expect(hooks[hookName as keyof typeof hooks]).toBeDefined();
    }

    for (const hookName of UNSUPPORTED_RUNTIME_HOOKS) {
      expect(hooks[hookName as keyof typeof hooks]).toBeUndefined();
    }

    const sessionID = "sess_plugin_smoke";
    const toolContext = createToolContext(sessionID);

    const createOutput = await hooks.tool!.hive_feature_create.execute(
      { name: "smoke-feature" },
      toolContext
    );
    expect(createOutput).toContain('Feature "smoke-feature" created');
    expect(fs.existsSync(path.join(testRoot, '.hive', 'features', '01_smoke-feature'))).toBe(true);

    const plan = `# Smoke Feature

## Discovery

**Q: Is this a test?**
A: Yes, this is an integration test to validate the basic workflow of feature creation, plan writing, task sync, and worktree operations work correctly end-to-end in the plugin.

## Overview

Test

## Tasks

### 1. First Task
Do it
`;
    const planOutput = await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "smoke-feature" },
      toolContext
    );
    expect(planOutput).toContain("Plan written");

    const approveOutput = await hooks.tool!.hive_plan_approve.execute({ feature: "smoke-feature" }, toolContext);
    expect(approveOutput).toContain("Plan approved");

    const syncOutput = await hooks.tool!.hive_tasks_sync.execute({ feature: "smoke-feature" }, toolContext);
    expect(syncOutput).toContain("Tasks synced");

    const taskFolder = path.join(
      testRoot,
      ".hive",
      "features",
      "01_smoke-feature",
      "tasks",
      "01-first-task"
    );

    expect(fs.existsSync(taskFolder)).toBe(true);

    // Session is tracked on the feature metadata
    const featureJsonPath = path.join(
      testRoot,
      ".hive",
      "features",
      "01_smoke-feature",
      "feature.json"
    );

    const featureJson = JSON.parse(fs.readFileSync(featureJsonPath, "utf-8")) as {
      sessionId?: string;
    };

    expect(featureJson.sessionId).toBe(sessionID);

    const statusRaw = await hooks.tool!.hive_status.execute(
      { feature: "smoke-feature" },
      toolContext
    );
    const hiveStatus = JSON.parse(statusRaw as string) as {
      tasks?: {
        list?: Array<{
          folder: string;
          dependsOn?: string[] | null;
          worktree?: { branch: string; hasChanges: boolean | null } | null;
        }>;
        runnable?: string[];
        blockedBy?: Record<string, string[]>;
      };
    };

    expect(hiveStatus.tasks?.list?.[0]?.folder).toBe("01-first-task");
    expect(hiveStatus.tasks?.list?.[0]?.dependsOn).toEqual([]);
    expect(hiveStatus.tasks?.list?.[0]?.worktree).toBeNull();
    expect(hiveStatus.tasks?.runnable).toContain("01-first-task");
    expect(hiveStatus.tasks?.blockedBy).toEqual({});

    const execStartOutput = await hooks.tool!.hive_worktree_start.execute(
      { feature: "smoke-feature", task: "01-first-task" },
      toolContext
    );
    const execStart = JSON.parse(execStartOutput as string) as {
      instructions?: string;
      backgroundTaskCall?: Record<string, unknown>;
    };
    expect(execStart.backgroundTaskCall).toBeUndefined();

    const specPath = path.join(
      testRoot,
      ".hive",
      "features",
      "01_smoke-feature",
      "tasks",
      "01-first-task",
      "spec.md"
    );
    const specContent = fs.readFileSync(specPath, "utf-8");
    expect(specContent).toContain("## Dependencies");

    const statusOutput = await hooks.tool!.hive_status.execute(
      { feature: "smoke-feature" },
      toolContext
    );
    const status = JSON.parse(statusOutput as string) as {
      tasks?: {
        list?: Array<{ folder: string }>;
      };
    };
    expect(status.tasks?.list?.[0]?.folder).toBe("01-first-task");
  });

  it('rejects context writes for explicit missing features', async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_missing_context_feature');

    const output = await hooks.tool!.hive_context_write.execute(
      { feature: 'future-feature', name: 'draft', content: '# Draft' },
      toolContext,
    );

    expect(output).toContain("Error: Feature 'future-feature' not found");
    expect(fs.existsSync(path.join(testRoot, '.hive', 'features', 'future-feature'))).toBe(false);
  });

  it("keeps checked-in plugin.json aligned with the runtime contract", async () => {
    const packageJsonPath = path.resolve(import.meta.dir, '..', '..', 'package.json');
    const pluginJsonPath = path.resolve(import.meta.dir, '..', '..', 'plugin.json');

    const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8')) as {
      version: string;
      commands: Array<{ name: string; description: string }>;
      tools: string[];
    };

    const expectedManifest = buildPluginManifest();

    expect(pluginJson.version).toBe(expectedManifest.version);
    expect(pluginJson.commands).toEqual([...EXPECTED_COMMANDS]);
    expect(pluginJson.tools).not.toContain(removedHiveSkillTool);
    expect(pluginJson.tools).toEqual([...EXPECTED_TOOLS]);
    expect(pluginJson).toEqual(expectedManifest);
  });

  it("writes logical active-feature names and status fallback prefers the shared pointer", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_active_feature_pointer");

    await hooks.tool!.hive_feature_create.execute(
      { name: "zeta-feature" },
      toolContext
    );

    expect(
      fs.readFileSync(path.join(testRoot, ".hive", "active-feature"), "utf-8")
    ).toBe("zeta-feature");

    await hooks.tool!.hive_feature_create.execute(
      { name: "alpha-feature" },
      toolContext
    );

    expect(
      fs.readFileSync(path.join(testRoot, ".hive", "active-feature"), "utf-8")
    ).toBe("alpha-feature");

    const statusRaw = await hooks.tool!.hive_status.execute({}, toolContext);
    const status = JSON.parse(statusRaw as string) as {
      feature?: { name?: string };
    };

    expect(status.feature?.name).toBe("alpha-feature");

    await hooks.tool!.hive_feature_complete.execute(
      { name: "alpha-feature" },
      toolContext
    );

    const fallbackStatusRaw = await hooks.tool!.hive_status.execute({}, toolContext);
    const fallbackStatus = JSON.parse(fallbackStatusRaw as string) as {
      feature?: { name?: string };
    };

    expect(fallbackStatus.feature?.name).toBe("zeta-feature");
  });

  it("returns task tool call using @file prompt", async () => {

    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_task_mode");

    await hooks.tool!.hive_feature_create.execute(
      { name: "task-mode-feature" },
      toolContext
    );

    const plan = `# Task Mode Feature

## Discovery

**Q: Is this a test?**
A: Yes, this is an integration test to validate task mode with @file prompts. Testing that worker prompt files are correctly generated and used.

## Overview

Test

## Tasks

### 1. First Task
Do it
`;
    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "task-mode-feature" },
      toolContext
    );
    await hooks.tool!.hive_plan_approve.execute(
      { feature: "task-mode-feature" },
      toolContext
    );
    await hooks.tool!.hive_tasks_sync.execute(
      { feature: "task-mode-feature" },
      toolContext
    );

    const execStartOutput = await hooks.tool!.hive_worktree_start.execute(
      { feature: "task-mode-feature", task: "01-first-task" },
      toolContext
    );
    const execStart = JSON.parse(execStartOutput as string) as {
      defaultAgent?: string;
      eligibleAgents?: Array<{
        name: string;
        baseAgent: string;
        description: string;
      }>;
      instructions?: string;
      taskToolCall?: {
        subagent_type?: string;
        description?: string;
        prompt?: string;
      };
    };

    const expectedPromptPath = path.posix.join(
      ".hive",
      "features",
      "01_task-mode-feature",
      "tasks",
      "01-first-task",
      "worker-prompt.md"
    );

    expect(execStart.taskToolCall).toBeDefined();
    expect(execStart.defaultAgent).toBe("forager-worker");
    expect(execStart.eligibleAgents).toEqual([
      {
        name: "forager-worker",
        baseAgent: "forager-worker",
        description: "Default implementation worker",
      },
      {
        name: "forager-example-template",
        baseAgent: "forager-worker",
        description: "Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.",
      },
    ]);
    expect(execStart.taskToolCall?.subagent_type).toBeDefined();
    expect(execStart.taskToolCall?.description).toBe("Hive: 01-first-task");
    expect(execStart.taskToolCall?.prompt).toContain(`@${expectedPromptPath}`);
    expect(execStart.instructions).toContain("task({");
    expect(execStart.instructions).toContain(
      "prompt: \"Follow instructions in @.hive/features/01_task-mode-feature/tasks/01-first-task/worker-prompt.md\""
    );
    expect(execStart.instructions).toContain(
      "Use the `@path` attachment syntax in the prompt to reference the file. Do not inline the file contents."
    );
    expect(execStart.instructions).not.toContain("Read the prompt file");
  });

  it("excludes non-execution context from worker prompt payloads", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_reserved_overview");

    await hooks.tool!.hive_feature_create.execute(
      { name: "reserved-overview-feature" },
      toolContext
    );

    const plan = `# Reserved Overview Feature

## Discovery

**Q: Is this a test?**
A: Yes, this regression test validates that reserved overview context stays human-facing and is excluded from worker execution payloads.

## Tasks

### 1. First Task
Do it
`;

    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "reserved-overview-feature" },
      toolContext
    );
    await hooks.tool!.hive_plan_approve.execute(
      { feature: "reserved-overview-feature" },
      toolContext
    );
    await hooks.tool!.hive_tasks_sync.execute(
      { feature: "reserved-overview-feature" },
      toolContext
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: "reserved-overview-feature",
        name: "overview",
        content: "Human-facing overview that must stay out of worker execution context.",
      },
      toolContext
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: "reserved-overview-feature",
        name: "draft",
        content: "Scratchpad draft that must stay out of worker execution context.",
      },
      toolContext
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: "reserved-overview-feature",
        name: "execution-decisions",
        content: "Operational decision that must stay out of worker execution context.",
      },
      toolContext
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: "reserved-overview-feature",
        name: "decisions",
        content: "Technical decision that workers should receive.",
      },
      toolContext
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: "reserved-overview-feature",
        name: "learnings",
        content: "Durable learning that workers should receive.",
      },
      toolContext
    );

    const raw = await hooks.tool!.hive_worktree_start.execute(
      { feature: "reserved-overview-feature", task: "01-first-task" },
      toolContext
    );

    const result = JSON.parse(raw as string) as {
      worktreePath?: string;
    };

    expect(result.worktreePath).toBeDefined();

    const specPath = path.join(
      testRoot,
      ".hive",
      "features",
      "01_reserved-overview-feature",
      "tasks",
      "01-first-task",
      "spec.md"
    );
    const workerPromptPath = path.join(
      testRoot,
      ".hive",
      "features",
      "01_reserved-overview-feature",
      "tasks",
      "01-first-task",
      "worker-prompt.md"
    );

    const specContent = fs.readFileSync(specPath, "utf-8");
    const workerPromptContent = fs.readFileSync(workerPromptPath, "utf-8");

    expect(specContent).toContain("## decisions");
    expect(specContent).toContain("Technical decision that workers should receive.");
    expect(specContent).toContain("## learnings");
    expect(specContent).toContain("Durable learning that workers should receive.");
    expect(specContent).not.toContain("## overview");
    expect(specContent).not.toContain("Human-facing overview that must stay out of worker execution context.");
    expect(specContent).not.toContain("## draft");
    expect(specContent).not.toContain("Scratchpad draft that must stay out of worker execution context.");
    expect(specContent).not.toContain("## execution-decisions");
    expect(specContent).not.toContain("Operational decision that must stay out of worker execution context.");
    expect(workerPromptContent).toContain("Technical decision that workers should receive.");
    expect(workerPromptContent).toContain("Durable learning that workers should receive.");
    expect(workerPromptContent).not.toContain("Human-facing overview that must stay out of worker execution context.");
    expect(workerPromptContent).not.toContain("Scratchpad draft that must stay out of worker execution context.");
    expect(workerPromptContent).not.toContain("Operational decision that must stay out of worker execution context.");
  });

  it("returns forager-derived eligible agents for worktree execution delegation", async () => {
    const configPath = path.join(process.env.HOME || "", ".config", "opencode", "agent_hive.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
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

    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_task_mode_custom_agents");

    await hooks.tool!.hive_feature_create.execute(
      { name: "task-mode-custom-agents-feature" },
      toolContext
    );

    const plan = `# Task Mode Custom Agents Feature

## Discovery

**Q: Is this a test?**
A: Yes, this is an integration test to validate eligible forager-derived worker options and default fallback behavior in hive_worktree_start.

## Overview

Test

## Tasks

### 1. First Task
Do it
`;
    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "task-mode-custom-agents-feature" },
      toolContext
    );
    await hooks.tool!.hive_plan_approve.execute(
      { feature: "task-mode-custom-agents-feature" },
      toolContext
    );
    await hooks.tool!.hive_tasks_sync.execute(
      { feature: "task-mode-custom-agents-feature" },
      toolContext
    );

    const execStartOutput = await hooks.tool!.hive_worktree_start.execute(
      { feature: "task-mode-custom-agents-feature", task: "01-first-task" },
      toolContext
    );
    const execStart = JSON.parse(execStartOutput as string) as {
      defaultAgent?: string;
      eligibleAgents?: Array<{
        name: string;
        baseAgent: string;
        description: string;
      }>;
      instructions?: string;
      taskToolCall?: {
        subagent_type?: string;
      };
    };

    expect(execStart.defaultAgent).toBe("forager-worker");
    expect(execStart.eligibleAgents).toEqual([
      {
        name: "forager-worker",
        baseAgent: "forager-worker",
        description: "Default implementation worker",
      },
      {
        name: "forager-example-template",
        baseAgent: "forager-worker",
        description: "Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.",
      },
      {
        name: "forager-ui",
        baseAgent: "forager-worker",
        description: "Use for UI-heavy implementation tasks.",
      },
    ]);
    expect(execStart.eligibleAgents?.find((agent) => agent.name === "reviewer-security")).toBeUndefined();
    expect(execStart.instructions).toContain("Choose one of the eligible forager-derived agents below.");
    expect(execStart.instructions).toContain("Default to `forager-worker` if no specialist is a better match.");
    expect(execStart.instructions).toContain("`taskToolCall.subagent_type` is prefilled with the default for convenience");
    expect(execStart.instructions).toContain("`forager-ui` — Use for UI-heavy implementation tasks.");
    expect(execStart.taskToolCall?.subagent_type).toBe("forager-worker");
  });

  it("returns structured JSON when hive_worktree_create is called without a feature", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_missing_feature");

    const raw = await hooks.tool!.hive_worktree_create.execute(
      { task: "01-missing-task" },
      toolContext
    );

    const result = JSON.parse(raw as string) as {
      success?: boolean;
      terminal?: boolean;
      error?: string;
      hints?: string[];
    };

    expect(result.success).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.error).toContain("No feature specified");
    expect(Array.isArray(result.hints)).toBe(true);
  });

  it("returns structured JSON when hive_worktree_create task is missing", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_missing_task");

    await hooks.tool!.hive_feature_create.execute(
      { name: "missing-task-feature" },
      toolContext
    );

    const raw = await hooks.tool!.hive_worktree_create.execute(
      { feature: "missing-task-feature", task: "99-nope" },
      toolContext
    );

    const result = JSON.parse(raw as string) as {
      success?: boolean;
      terminal?: boolean;
      error?: string;
      hints?: string[];
    };

    expect(result.success).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.error).toContain('Task "99-nope" not found');
    expect(Array.isArray(result.hints)).toBe(true);
  });

  it("returns structured JSON when hive_worktree_create feature is blocked", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_blocked_feature");

    await hooks.tool!.hive_feature_create.execute(
      { name: "blocked-feature" },
      toolContext
    );

    const blockedPath = path.join(
      testRoot,
      ".hive",
      "features",
      "01_blocked-feature",
      "BLOCKED"
    );
    fs.writeFileSync(blockedPath, "Need approval from Beekeeper.");

    const raw = await hooks.tool!.hive_worktree_create.execute(
      { feature: "blocked-feature", task: "01-first-task" },
      toolContext
    );

    const result = JSON.parse(raw as string) as {
      success?: boolean;
      terminal?: boolean;
      error?: string;
      hints?: string[];
    };

    expect(result.success).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.error).toContain("BLOCKED by Beekeeper");
    expect(Array.isArray(result.hints)).toBe(true);
  });

  it("returns structured JSON when hive_status feature is blocked", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_blocked_status");

    await hooks.tool!.hive_feature_create.execute(
      { name: "blocked-status-feature" },
      toolContext
    );

    const plan = `# Blocked Status Feature

## Discovery

**Q: Is this a test?**
A: Yes, this regression test validates that hive_status returns terminal JSON instead of plain text when a feature is blocked.

## Tasks

### 1. First Task
Do it
`;

    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "blocked-status-feature" },
      toolContext
    );

    await hooks.tool!.hive_context_write.execute(
      {
        feature: "blocked-status-feature",
        name: "BLOCKED",
        content: "Need approval from Beekeeper.",
      },
      toolContext
    );

    const blockedPath = path.join(
      testRoot,
      ".hive",
      "features",
      "01_blocked-status-feature",
      "BLOCKED"
    );
    const blockedContextPath = path.join(
      testRoot,
      ".hive",
      "features",
      "01_blocked-status-feature",
      "context",
      "BLOCKED.md"
    );
    fs.copyFileSync(blockedContextPath, blockedPath);

    const raw = await hooks.tool!.hive_status.execute(
      { feature: "blocked-status-feature" },
      toolContext
    );

    const result = JSON.parse(raw as string) as {
      success?: boolean;
      terminal?: boolean;
      blocked?: boolean;
      error?: string;
      hints?: string[];
    };

    expect(result.success).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.error).toContain("BLOCKED by Beekeeper");
    expect(Array.isArray(result.hints)).toBe(true);
    expect(result.hints?.length).toBeGreaterThan(0);
  });

  it("returns structured terminal JSON when hive_status has no active feature", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_status_no_feature");

    const raw = await hooks.tool!.hive_status.execute({}, toolContext);

    const result = JSON.parse(raw as string) as {
      success?: boolean;
      terminal?: boolean;
      reason?: string;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.reason).toBe("feature_required");
    expect(result.error).toContain("No feature specified");
  });

  it("returns structured terminal JSON when hive_status feature is missing", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_status_missing_feature");

    const raw = await hooks.tool!.hive_status.execute(
      { feature: "does-not-exist" },
      toolContext
    );

    const result = JSON.parse(raw as string) as {
      success?: boolean;
      terminal?: boolean;
      reason?: string;
      error?: string;
      availableFeatures?: unknown[];
    };

    expect(result.success).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.reason).toBe("feature_not_found");
    expect(result.error).toContain("Feature 'does-not-exist' not found");
    expect(Array.isArray(result.availableFeatures)).toBe(true);
  });

  it("reports context handling metadata in hive_status", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_overview_status");

    await hooks.tool!.hive_feature_create.execute(
      { name: "overview-status-feature" },
      toolContext
    );

    const plan = `# Overview Status Feature

## Discovery

**Q: Is this a test?**
A: Yes, this regression test validates that hive_status exposes reserved overview metadata and document-aware review counts.

## Tasks

### 1. First Task
Do it
`;

    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "overview-status-feature" },
      toolContext
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: "overview-status-feature",
        name: "overview",
        content: "# Overview\nHuman-facing summary",
      },
      toolContext
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: "overview-status-feature",
        name: "draft",
        content: "# Draft\nScratchpad summary",
      },
      toolContext
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: "overview-status-feature",
        name: "execution-decisions",
        content: "# Execution Decisions\nOperational summary",
      },
      toolContext
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: "overview-status-feature",
        name: "learnings",
        content: "# Learnings\nDurable summary",
      },
      toolContext
    );

    fs.mkdirSync(
      path.join(testRoot, ".hive", "features", "01_overview-status-feature", "comments"),
      { recursive: true }
    );
    fs.writeFileSync(
      path.join(testRoot, ".hive", "features", "01_overview-status-feature", "comments", "plan.json"),
      JSON.stringify({
        threads: [{ id: "plan-thread", line: 1, body: "Plan review", replies: [] }],
      }, null, 2)
    );
    fs.writeFileSync(
      path.join(testRoot, ".hive", "features", "01_overview-status-feature", "comments", "overview.json"),
      JSON.stringify({
        threads: [{ id: "overview-thread", line: 2, body: "Overview review", replies: [] }],
      }, null, 2)
    );

    const raw = await hooks.tool!.hive_status.execute(
      { feature: "overview-status-feature" },
      toolContext
    );

    const result = JSON.parse(raw as string) as {
      overview?: {
        exists: boolean;
        path: string;
        updatedAt?: string;
      };
      review?: {
        unresolvedTotal: number;
        byDocument: {
          plan: number;
          overview: number;
        };
      };
      context?: {
        files: Array<{
          name: string;
          role: string;
          includeInExecution: boolean;
          includeInNetwork: boolean;
        }>;
      };
    };

    expect(result.overview).toMatchObject({
      exists: true,
      path: ".hive/features/overview-status-feature/context/overview.md",
    });
    expect(typeof result.overview?.updatedAt).toBe("string");
    expect(result.review).toEqual({
      unresolvedTotal: 2,
      byDocument: {
        plan: 1,
        overview: 1,
      },
    });
    expect(result.context?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "draft",
          role: "scratchpad",
          includeInExecution: false,
        }),
        expect.objectContaining({
          name: "execution-decisions",
          role: "operational",
          includeInExecution: false,
        }),
        expect.objectContaining({
          name: "learnings",
          role: "durable",
          includeInExecution: true,
          includeInNetwork: true,
        }),
        expect.objectContaining({
          name: "overview",
          role: "operational",
          includeInExecution: false,
          includeInNetwork: false,
        }),
      ])
    );
  });

  it("omits the removed projected-todo field and stale todo-sync hints from the trimmed runtime contract", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_trimmed_runtime_contract");

    const createOutput = await hooks.tool!.hive_feature_create.execute(
      { name: "trimmed-runtime-feature" },
      toolContext
    );
    expect(createOutput).not.toContain(REMOVED_TODO_REFRESH_HINT);

    const planningStatusRaw = await hooks.tool!.hive_status.execute({ feature: "trimmed-runtime-feature" }, toolContext);
    const planningStatus = JSON.parse(planningStatusRaw as string) as Record<string, unknown>;
    expect(planningStatus).not.toHaveProperty(REMOVED_PROJECTED_TODO_FIELD);

    const plan = createSingleTaskPlan(
      'Trimmed Runtime Feature',
      'Yes, this regression test validates that the trimmed OpenCode runtime no longer exposes the removed projected-todo field or stale todo-sync hints.'
    );

    const planOutput = await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "trimmed-runtime-feature" },
      toolContext
    );
    expect(planOutput).not.toContain(REMOVED_TODO_REFRESH_HINT);

    const approveOutput = await hooks.tool!.hive_plan_approve.execute(
      { feature: "trimmed-runtime-feature" },
      toolContext
    );
    expect(approveOutput).not.toContain(REMOVED_TODO_REFRESH_HINT);

    const syncOutput = await hooks.tool!.hive_tasks_sync.execute(
      { feature: "trimmed-runtime-feature" },
      toolContext
    );
    expect(syncOutput).not.toContain(REMOVED_TODO_REFRESH_HINT);

    const startRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature: "trimmed-runtime-feature", task: FIRST_TASK },
      toolContext
    );
    const startResult = JSON.parse(startRaw as string) as Record<string, unknown>;
    expect(startResult).not.toHaveProperty('todoSync');

    const blockedCommitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature: "trimmed-runtime-feature",
        task: FIRST_TASK,
        status: "blocked",
        summary: "Blocked waiting for a design decision.",
        blocker: {
          reason: "Need a design decision",
          options: ["Option A", "Option B"],
        },
      },
      toolContext
    );
    const blockedCommit = JSON.parse(blockedCommitRaw as string) as Record<string, unknown>;
    expect(blockedCommit).not.toHaveProperty('todoSync');
  });

  it("keeps plan tool messaging overview-first while plan.md remains execution truth", async () => {
    const { hooks, toolContext } = await createHooksForTest(
      testRoot,
      'sess_overview_first_plan_messaging'
    );

    await hooks.tool!.hive_feature_create.execute(
      { name: 'overview-first-plan-feature' },
      toolContext
    );

    const planOutput = await hooks.tool!.hive_plan_write.execute(
      {
        content: createSingleTaskPlan(
          'Overview First Plan Feature',
          'Yes, this regression test validates that plan write and approve messaging point reviewers to context/overview.md first while keeping plan.md as execution truth.'
        ),
        feature: 'overview-first-plan-feature',
      },
      toolContext
    );

    const approveOutput = await hooks.tool!.hive_plan_approve.execute(
      { feature: 'overview-first-plan-feature' },
      toolContext
    );

    expect(planOutput).toContain('Refresh the primary human-facing overview');
    expect(planOutput).toContain('plan.md remains execution truth');
    expect(approveOutput).toContain('plan.md remains execution truth');
  });

  it("guides planners to overview-first status messaging", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_overview_guidance");

    await hooks.tool!.hive_feature_create.execute(
      { name: "overview-guidance-feature" },
      toolContext
    );

    const plan = `# Overview Guidance Feature

## Discovery

**Q: Is this a test?**
A: Yes, this regression test validates that plan messaging and hive_status guidance explicitly direct planners to maintain the reserved overview via hive_context_write.

## Tasks

### 1. First Task
Do it
`;

    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "overview-guidance-feature" },
      toolContext
    );
    const approveOutput = await hooks.tool!.hive_plan_approve.execute(
      { feature: "overview-guidance-feature" },
      toolContext
    );
    expect(approveOutput).toContain('Plan approved');

    const statusRaw = await hooks.tool!.hive_status.execute(
      { feature: "overview-guidance-feature" },
      toolContext
    );
    const status = JSON.parse(statusRaw as string) as { nextAction?: string };
    expect(status.nextAction).toBe('Generate tasks from plan with hive_tasks_sync');

    const draftFeature = 'draft-overview-guidance-feature';
    await hooks.tool!.hive_feature_create.execute(
      { name: draftFeature },
      createToolContext('sess_overview_guidance_draft')
    );

    const draftStatusRaw = await hooks.tool!.hive_status.execute(
      { feature: draftFeature },
      toolContext
    );
    const draftStatus = JSON.parse(draftStatusRaw as string) as { nextAction?: string };

    expect(draftStatus.nextAction).toBe(
      'Write or revise plan with hive_plan_write. Refresh context/overview.md first for human review; plan.md remains execution truth and pre-task Mermaid overview diagrams are optional.'
    );
  });

  it("blocks plan approval when overview review comments remain", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_overview_approval_blocked");

    await hooks.tool!.hive_feature_create.execute(
      { name: "overview-approval-blocked-feature" },
      toolContext
    );

    const plan = `# Overview Approval Blocked Feature

## Discovery

**Q: Is this a test?**
A: Yes, this regression test proves approval must report unresolved overview review comments before execution can proceed.

## Tasks

### 1. First Task
Do it
`;

    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "overview-approval-blocked-feature" },
      toolContext
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: "overview-approval-blocked-feature",
        name: "overview",
        content: "# Overview\n",
      },
      toolContext
    );

    fs.mkdirSync(
      path.join(testRoot, ".hive", "features", "01_overview-approval-blocked-feature", "comments"),
      { recursive: true }
    );
    fs.writeFileSync(
      path.join(testRoot, ".hive", "features", "01_overview-approval-blocked-feature", "comments", "plan.json"),
      JSON.stringify({
        threads: [{ id: "plan-thread", line: 1, body: "Need clearer plan", replies: [] }],
      }, null, 2)
    );

    const approveOutput = await hooks.tool!.hive_plan_approve.execute(
      { feature: "overview-approval-blocked-feature" },
      toolContext
    );

    expect(approveOutput).toContain("Cannot approve");
    expect(approveOutput).toContain("plan review");
  });

  it("returns explicit success and non-terminal contract fields on worktree start", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_success_contract");

    await hooks.tool!.hive_feature_create.execute(
      { name: "success-contract-feature" },
      toolContext
    );

    const plan = `# Success Contract Feature

## Discovery

**Q: Is this a test?**
A: Yes, this test validates that successful hive_worktree_start responses include explicit success and terminal contract fields for machine-readable orchestration.

## Tasks

### 1. First Task
Do it
`;

    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "success-contract-feature" },
      toolContext
    );
    await hooks.tool!.hive_plan_approve.execute(
      { feature: "success-contract-feature" },
      toolContext
    );
    await hooks.tool!.hive_tasks_sync.execute(
      { feature: "success-contract-feature" },
      toolContext
    );

    const raw = await hooks.tool!.hive_worktree_start.execute(
      { feature: "success-contract-feature", task: "01-first-task" },
      toolContext
    );

    const result = JSON.parse(raw as string) as {
      success?: boolean;
      terminal?: boolean;
      worktreePath?: string;
      taskToolCall?: { prompt?: string };
    };

    expect(result.success).toBe(true);
    expect(result.terminal).toBe(false);
    expect(result.worktreePath).toBeDefined();
    expect(result.taskToolCall?.prompt).toContain("worker-prompt.md");
  });

  it("system prompt hook injects Hive instructions", async () => {
    const configPath = path.join(process.env.HOME || "", ".config", "opencode", "agent_hive.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          "hive-master": {
            autoLoadSkills: ["brainstorming"],
          },
        },
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
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);

    await hooks.tool!.hive_feature_create.execute({ name: "active" }, createToolContext("sess"));

    const opencodeConfig: Record<string, unknown> = { agent: {} };
    await hooks.config!(opencodeConfig);
    
    const systemTransform = hooks["experimental.chat.system.transform" as keyof typeof hooks] as
      | ((input: { sessionID?: string; agent?: string }, output: { system: string[] }) => Promise<void>)
      | undefined;
    const output = { system: ["OpenCode provider base prompt"] };
    await systemTransform?.({ sessionID: "sess", agent: "hive-master" }, output);
    const agentConfig = { prompt: output.system[0] };
    expect(agentConfig).toBeDefined();
    expect(agentConfig.prompt).toBeDefined();
    expect(agentConfig.prompt).toContain("## Hive — Active Session");
    expect(agentConfig.prompt).not.toContain("Use hive_status to check feature state before starting work");
    expect(agentConfig.prompt).not.toContain("Use hive_plan_read to see plan comments");
    
    const brainstormingSkill = BUILTIN_SKILLS.find((skill) => skill.name === "brainstorming");
    expect(brainstormingSkill).toBeDefined();
    expect(agentConfig.prompt).toContain(brainstormingSkill!.template);
    expect(agentConfig.prompt).toContain("Configured Custom Subagents");
    expect(agentConfig.prompt).toContain("`scout-docs`");
    expect(agentConfig.prompt).toContain("`reviewer-security`");
    expect(agentConfig.prompt).toContain("default to built-in `scout-researcher`");
    expect(agentConfig.prompt).toContain("Configured Custom Subagents` is a better match");
    expect(agentConfig.prompt).toContain("task({ subagent_type: \"<chosen-researcher>\"");
    expect(agentConfig.prompt).toContain("default to built-in `code-reviewer`");
    expect(agentConfig.prompt).toContain("Configured Custom Subagents` is a better match");
    expect(agentConfig.prompt).toContain("task({ subagent_type: \"<chosen-reviewer>\"");

    const agents = opencodeConfig.agent as Record<string, unknown>;
    expect(agents["forager-worker"]).toBeDefined();
    expect(agents["scout-docs"]).toBeDefined();
    expect(agents["code-reviewer"]).toBeDefined();
    expect(agents["forager-ui"]).toBeDefined();
    expect(agents["reviewer-security"]).toBeDefined();
    
  });

  it("appends selected Hive runtime prompts after OpenCode provider base prompt", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const opencodeConfig: Record<string, unknown> = { agent: {} };
    await hooks.config!(opencodeConfig);

    const agents = opencodeConfig.agent as Record<string, { prompt?: string }>;
    const builderConfig = agents["hive-builder"];
    expect(builderConfig).toBeDefined();
    expect(builderConfig.prompt).toBeUndefined();
    expect(agents["hive-master"]?.prompt).toBeUndefined();
    expect(agents["forager-worker"]?.prompt).toBeUndefined();
    expect(agents["architect-planner"]).toBeUndefined();
    expect(agents["scout-researcher"]?.prompt).toBeDefined();
    expect(agents["hive-helper"]?.prompt).toBeDefined();
    expect(agents["code-reviewer"]?.prompt).toBeDefined();

    const systemTransform = hooks["experimental.chat.system.transform" as keyof typeof hooks] as
      | ((input: { sessionID?: string; agent?: string }, output: { system: string[] }) => Promise<void>)
      | undefined;

    const cases = [
      ['hive-master', QUEEN_BEE_PROMPT],
      ['forager-worker', FORAGER_BEE_PROMPT],
      ['hive-builder', HIVE_BUILDER_PROMPT],
    ] as const;

    for (const [agentName, prompt] of cases) {
      const output = { system: ["OpenCode provider base prompt"] };
      await systemTransform?.({ sessionID: `sess_${agentName}`, agent: agentName }, output);
      expect(output.system[0]).toStartWith(`OpenCode provider base prompt\n\n${prompt.split('\n')[0]}`);
      expect(output.system[0]).toContain(prompt);
    }

    const swarmOutput = { system: ["OpenCode provider base prompt"] };
    await systemTransform?.({ sessionID: 'sess_swarm', agent: 'swarm-orchestrator' }, swarmOutput);
    expect(swarmOutput.system[0]).toContain(SWARM_BEE_PROMPT);
    expect(swarmOutput.system[0]).toContain(HIVE_SYSTEM_PROMPT);

    const scoutOutput = { system: ["OpenCode provider base prompt"] };
    await systemTransform?.({ sessionID: 'sess_scout', agent: 'scout-researcher' }, scoutOutput);
    expect(scoutOutput.system).toEqual(["OpenCode provider base prompt"]);
  });

  it("system prompt hook omits trimmed projected-todo and checkpoint rituals for primary roles", async () => {
    const configPath = path.join(process.env.HOME || "", ".config", "opencode", "agent_hive.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agentMode: "dedicated",
        agents: {
          "architect-planner": {},
          "swarm-orchestrator": {},
        },
      }),
    );

    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const opencodeConfig: Record<string, unknown> = { agent: {} };
    await hooks.config!(opencodeConfig);

    const agents = opencodeConfig.agent as Record<string, { prompt?: string }>;
    const hivePrompt = QUEEN_BEE_PROMPT;
    const architectPrompt = agents["architect-planner"]?.prompt ?? "";
    const swarmPrompt = agents["swarm-orchestrator"]?.prompt ?? "";
    const foragerPrompt = agents["forager-worker"]?.prompt ?? "";

    expect(hivePrompt).not.toContain(REMOVED_PROJECTED_TODO_FIELD);
    expect(hivePrompt).not.toContain("todoread");
    expect(hivePrompt).not.toContain("todowrite");
    expect(hivePrompt).not.toContain("task checkpoints");
    expect(hivePrompt).not.toContain(LEGACY_IDLE_CHILD_REPLAY);

    expect(architectPrompt).not.toContain(REMOVED_PROJECTED_TODO_FIELD);
    expect(architectPrompt).not.toContain("todoread");
    expect(architectPrompt).not.toContain("todowrite");
    expect(architectPrompt).not.toContain("task checkpoints");

    expect(swarmPrompt).not.toContain(REMOVED_PROJECTED_TODO_FIELD);
    expect(swarmPrompt).not.toContain("todoread");
    expect(swarmPrompt).not.toContain("todowrite");
    expect(swarmPrompt).not.toContain("task checkpoints");

    expect(foragerPrompt).not.toContain("todowrite");
    expect(foragerPrompt).not.toContain(REMOVED_PROJECTED_TODO_FIELD);
  });

  it("blocks hive_worktree_create when dependencies are not done", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_dependency_block");

    await hooks.tool!.hive_feature_create.execute(
      { name: "dep-block-feature" },
      toolContext
    );

    const plan = `# Dep Block Feature

## Discovery

**Q: Is this a test?**
A: Yes, this integration test validates dependency blocking. Testing that task 2 cannot start until task 1 completes, ensuring proper dependency enforcement.

## Overview

Test

## Tasks

### 1. First Task
Do it

### 2. Second Task

**Depends on**: 1

Do it later
`;

    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "dep-block-feature" },
      toolContext
    );
    await hooks.tool!.hive_plan_approve.execute(
      { feature: "dep-block-feature" },
      toolContext
    );
    await hooks.tool!.hive_tasks_sync.execute(
      { feature: "dep-block-feature" },
      toolContext
    );

    const execStartOutput = await hooks.tool!.hive_worktree_start.execute(
      { feature: "dep-block-feature", task: "02-second-task" },
      toolContext
    );

    const execStart = JSON.parse(execStartOutput as string) as {
      success?: boolean;
      terminal?: boolean;
      reason?: string;
      error?: string;
    };

    expect(execStart.success).toBe(false);
    expect(execStart.terminal).toBe(true);
    expect(execStart.reason).toBe("dependencies_not_done");
    expect(execStart.error).toContain("dependencies not done");
  });

  it("returns terminal JSON when blocked resume is retried from in_progress", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_invalid_blocked_retry");

    await hooks.tool!.hive_feature_create.execute(
      { name: "invalid-blocked-retry-feature" },
      toolContext
    );

    const plan = `# Invalid Blocked Retry Feature

## Discovery

**Q: Is this a test?**
A: Yes, this regression test validates that retrying continueFrom:'blocked' while a task is still in_progress returns terminal guidance instead of re-entering the blocked resume flow.

## Tasks

### 1. First Task
Do it
`;

    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "invalid-blocked-retry-feature" },
      toolContext
    );
    await hooks.tool!.hive_plan_approve.execute(
      { feature: "invalid-blocked-retry-feature" },
      toolContext
    );
    await hooks.tool!.hive_tasks_sync.execute(
      { feature: "invalid-blocked-retry-feature" },
      toolContext
    );

    await hooks.tool!.hive_worktree_start.execute(
      { feature: "invalid-blocked-retry-feature", task: "01-first-task" },
      toolContext
    );

    const statusRaw = await hooks.tool!.hive_status.execute(
      { feature: "invalid-blocked-retry-feature" },
      toolContext
    );
    const status = JSON.parse(statusRaw as string) as {
      tasks?: {
        list?: Array<{ folder: string; status: string }>;
      };
    };

    const taskStatus = status.tasks?.list?.find(
      (task) => task.folder === "01-first-task"
    );
    expect(taskStatus?.status).toBe("in_progress");

    const invalidRetryRaw = await hooks.tool!.hive_worktree_create.execute(
      {
        feature: "invalid-blocked-retry-feature",
        task: "01-first-task",
        continueFrom: "blocked",
        decision: "Retry with the same approach.",
      },
      toolContext
    );

    const invalidRetry = JSON.parse(invalidRetryRaw as string) as {
      success?: boolean;
      terminal?: boolean;
      reason?: string;
      canRetry?: boolean;
      retryReason?: string;
      currentStatus?: string;
      hints?: string[];
    };

    expect(invalidRetry.success).toBe(false);
    expect(invalidRetry.terminal).toBe(true);
    expect(invalidRetry.reason).toBe("task_not_blocked");
    expect(invalidRetry.canRetry).toBe(false);
    expect(typeof invalidRetry.retryReason).toBe("string");
    expect(invalidRetry.retryReason?.length).toBeGreaterThan(0);
    expect(invalidRetry.currentStatus).toBe("in_progress");
    expect(Array.isArray(invalidRetry.hints)).toBe(true);
    expect(invalidRetry.hints?.length).toBeGreaterThan(0);
    expect(invalidRetry.hints?.some((hint) => /start|resume/i.test(hint))).toBe(true);
    expect(invalidRetry.hints?.some((hint) => /hive_status|status/i.test(hint))).toBe(true);
  });

  it("starts a pending task with hive_worktree_start without continueFrom", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_pending_start");

    await hooks.tool!.hive_feature_create.execute(
      { name: "pending-start-feature" },
      toolContext
    );

    const plan = `# Pending Start Feature

## Discovery

**Q: Is this a test?**
A: Yes, this regression test validates that pending tasks can start via hive_worktree_start without a continueFrom flag.

## Tasks

### 1. First Task
Do it
`;

    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "pending-start-feature" },
      toolContext
    );
    await hooks.tool!.hive_plan_approve.execute(
      { feature: "pending-start-feature" },
      toolContext
    );
    await hooks.tool!.hive_tasks_sync.execute(
      { feature: "pending-start-feature" },
      toolContext
    );

    const raw = await hooks.tool!.hive_worktree_start.execute(
      { feature: "pending-start-feature", task: "01-first-task" },
      toolContext
    );

    const result = JSON.parse(raw as string) as {
      success?: boolean;
      terminal?: boolean;
      worktreePath?: string;
    };

    expect(result.success).toBe(true);
    expect(result.terminal).toBe(false);
    expect(result.worktreePath).toBeDefined();
  });

  it("treats a single completed commit call as the expected terminal merge-ready path", async () => {
    const feature = "commit-expected-path-feature";
    const { hooks, toolContext, worktreePath } = await createSingleTaskWorktree(
      testRoot,
      "sess_commit_expected_path",
      feature,
      "Commit Expected Path Feature",
      "Yes, this test validates that one completed commit call returns terminal merge-ready output.",
    );

    fs.writeFileSync(path.join(worktreePath, "task-note.txt"), "commit expected path test\n");

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: "completed",
        summary: "Added expected-path note file. Tests pass (bun test). Build succeeds (bun run build).",
      },
      toolContext
    );

    const commitResult = JSON.parse(commitRaw as string) as {
      ok: boolean;
      terminal: boolean;
      status: string;
      taskState?: string;
      verificationNote?: string;
      commit?: { sha?: string };
      nextAction?: string;
    };

    expect(commitResult.ok).toBe(true);
    expect(commitResult.terminal).toBe(true);
    expect(commitResult.status).toBe("completed");
    expect(commitResult.taskState).toBe("done");
    expect(commitResult.nextAction).toContain("hive_merge");
  });

  it("keeps advisory fallback completion terminal and done without requiring commit retry", async () => {
    const feature = "commit-advisory-fallback-feature";
    const { hooks, toolContext } = await createSingleTaskWorktree(
      testRoot,
      "sess_commit_advisory_fallback",
      feature,
      "Commit Advisory Fallback Feature",
      "Yes, this test validates advisory fallback interpretation with minimal completion summary and no retry requirement.",
    );

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: "completed",
        summary: "Completed.",
      },
      toolContext
    );

    const commitResult = JSON.parse(commitRaw as string) as {
      ok: boolean;
      terminal: boolean;
      status: string;
      taskState?: string;
      verificationNote?: string;
      nextAction?: string;
    };

    expect(commitResult.ok).toBe(true);
    expect(commitResult.terminal).toBe(true);
    expect(commitResult.status).toBe("completed");
    expect(commitResult.taskState).toBe("done");
    expect(commitResult.nextAction).toContain("hive_merge");

    const statusRaw = await hooks.tool!.hive_status.execute(
      { feature },
      toolContext
    );
    const status = JSON.parse(statusRaw as string) as {
      tasks?: {
        list?: Array<{ folder: string; status: string }>;
      };
    };

    const taskStatus = status.tasks?.list?.find((task) => task.folder === FIRST_TASK);
    expect(taskStatus?.status).toBe("done");
  });

  it("uses custom commit message in task worktree head", async () => {
    const feature = "commit-custom-message-feature";
    const { hooks, toolContext, worktreePath } = await createSingleTaskWorktree(
      testRoot,
      "sess_commit_custom_message",
      feature,
      "Commit Custom Message Feature",
      "Yes, this test validates custom commit message passthrough from the OpenCode tool layer.",
    );

    fs.writeFileSync(path.join(worktreePath, "task-note.txt"), "commit custom message test\n");

    const customMessage = "feat(plugin): custom commit subject\n\ncustom body";
    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: "completed",
        summary: "Added task note. Tests pass (bun test).",
        message: customMessage,
      },
      toolContext
    );

    const commitResult = JSON.parse(commitRaw as string) as {
      ok: boolean;
      terminal: boolean;
      status: string;
      commit?: { message?: string };
    };

    expect(commitResult.ok).toBe(true);
    expect(commitResult.terminal).toBe(true);
    expect(commitResult.status).toBe("completed");
    expect(commitResult.commit?.message).toBe(customMessage);
    expect(readHeadBody(worktreePath)).toBe(customMessage);
  });

  it("falls back when hive_worktree_commit message is empty string", async () => {
    const feature = "commit-empty-message-feature";
    const { hooks, toolContext, worktreePath } = await createSingleTaskWorktree(
      testRoot,
      "sess_commit_empty_message",
      feature,
      "Commit Empty Message Feature",
      "Yes, this test validates empty-string message fallback in hive_worktree_commit.",
    );

    fs.writeFileSync(path.join(worktreePath, "task-note.txt"), "empty message fallback\n");

    const summary = "Added fallback check for empty message. Tests pass (bun test).";
    const expectedMessage = `hive(${FIRST_TASK}): ${summary.slice(0, 50)}`;

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: "completed",
        summary,
        message: "",
      },
      toolContext
    );

    const commitResult = JSON.parse(commitRaw as string) as {
      ok: boolean;
      terminal: boolean;
      status: string;
      commit?: { message?: string };
    };

    expect(commitResult.ok).toBe(true);
    expect(commitResult.terminal).toBe(true);
    expect(commitResult.status).toBe("completed");
    expect(commitResult.commit?.message).toBe(expectedMessage);
    expect(readHeadBody(worktreePath)).toBe(expectedMessage);
  });

  it("returns helper-friendly merge JSON for merge strategy", async () => {
    const feature = "merge-custom-message-feature";
    const { hooks, toolContext, worktreePath } = await createSingleTaskWorktree(
      testRoot,
      "sess_merge_custom_message",
      feature,
      "Merge Custom Message Feature",
      "Yes, this test validates custom merge commit message passthrough for the merge strategy.",
    );

    fs.writeFileSync(path.join(worktreePath, "task-note.txt"), "merge custom message\n");

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: "completed",
        summary: "Prepared merge message test. Tests pass (bun test).",
      },
      toolContext
    );
    const commitResult = JSON.parse(commitRaw as string) as {
      ok: boolean;
      taskState?: string;
    };

    expect(commitResult.ok).toBe(true);
    expect(commitResult.taskState).toBe("done");

    const customMessage = "feat(plugin): merge subject\n\nmerge body";
    const mergeRaw = await hooks.tool!.hive_merge.execute(
      {
        feature,
        task: FIRST_TASK,
        strategy: "merge",
        message: customMessage,
      },
      toolContext
    );

    const mergeResult = JSON.parse(mergeRaw as string) as {
      success: boolean;
      merged: boolean;
      strategy: string;
      sha?: string;
      filesChanged: string[];
      conflicts: string[];
      conflictState: string;
      cleanup: { worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean };
      message: string;
    };

    expect(mergeResult).toMatchObject({
      success: true,
      merged: true,
      strategy: 'merge',
      filesChanged: ['task-note.txt'],
      conflicts: [],
      conflictState: 'none',
      cleanup: {
        worktreeRemoved: false,
        branchDeleted: false,
        pruned: false,
      },
      message: 'Task "01-first-task" merged successfully using merge strategy.',
    });
    expect(typeof mergeResult.sha).toBe('string');
    expect(readHeadBody(testRoot)).toBe(customMessage);
  });

  it("rejects custom merge message for rebase strategy", async () => {
    const feature = "rebase-message-rejection-feature";
    const { hooks, toolContext, worktreePath } = await createSingleTaskWorktree(
      testRoot,
      "sess_rebase_message_rejection",
      feature,
      "Rebase Message Rejection Feature",
      "Yes, this test validates rejection when custom message is used with rebase strategy.",
    );

    fs.writeFileSync(path.join(worktreePath, "task-note.txt"), "rebase custom message rejection\n");

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: "completed",
        summary: "Prepared rebase rejection test. Tests pass (bun test).",
      },
      toolContext
    );
    const commitResult = JSON.parse(commitRaw as string) as {
      ok: boolean;
      taskState?: string;
    };

    expect(commitResult.ok).toBe(true);
    expect(commitResult.taskState).toBe("done");

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      {
        feature,
        task: FIRST_TASK,
        strategy: "rebase",
        message: "feat: custom\n\nbody",
      },
      toolContext
    );

    const mergeResult = JSON.parse(mergeRaw as string) as {
      success: boolean;
      merged: boolean;
      strategy: string;
      filesChanged: string[];
      conflicts: string[];
      conflictState: string;
      cleanup: { worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean };
      error?: string;
      message: string;
    };

    expect(mergeResult).toEqual({
      success: false,
      merged: false,
      strategy: 'rebase',
      filesChanged: [],
      conflicts: [],
      conflictState: 'none',
      cleanup: {
        worktreeRemoved: false,
        branchDeleted: false,
        pruned: false,
      },
      error: 'Custom merge message is not supported for rebase strategy',
      message: 'Merge failed: Custom merge message is not supported for rebase strategy',
    });
  });

  it("returns helper-friendly merge JSON when task is not completed", async () => {
    const feature = "merge-incomplete-task-feature";
    const { hooks, toolContext } = await createSingleTaskWorktree(
      testRoot,
      "sess_merge_incomplete_task",
      feature,
      "Merge Incomplete Task Feature",
      "Yes, this test validates the early hive_merge JSON contract for incomplete tasks.",
    );

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      {
        feature,
        task: FIRST_TASK,
        strategy: "merge",
      },
      toolContext
    );

    const mergeResult = JSON.parse(mergeRaw as string) as {
      success: boolean;
      merged: boolean;
      strategy: string;
      filesChanged: string[];
      conflicts: string[];
      conflictState: string;
      cleanup: { worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean };
      error?: string;
      message: string;
    };

    expect(mergeResult).toEqual({
      success: false,
      merged: false,
      strategy: 'merge',
      filesChanged: [],
      conflicts: [],
      conflictState: 'none',
      cleanup: {
        worktreeRemoved: false,
        branchDeleted: false,
        pruned: false,
      },
      error: 'Task must be completed before merging. Use hive_worktree_commit first.',
      message: 'Merge failed: Task must be completed before merging. Use hive_worktree_commit first.',
    });
  });

  it("auto-loads parallel exploration for planner agents by default", async () => {
    // Test unified mode agents
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);

    const onboardingSnippet = "# Onboarding Preferences";
    const parallelExplorationSkill = BUILTIN_SKILLS.find(
      (skill) => skill.name === "parallel-exploration",
    );
    expect(parallelExplorationSkill).toBeDefined();

    // Default mode is 'unified' which includes hive-master, scout, forager, hygienic
    const opencodeConfig: Record<string, unknown> = { agent: {} };
    await hooks.config!(opencodeConfig);
    const agents = opencodeConfig.agent as Record<string, { prompt?: string }>;
    const systemTransform = hooks["experimental.chat.system.transform" as keyof typeof hooks] as
      | ((input: { sessionID?: string; agent?: string }, output: { system: string[] }) => Promise<void>)
      | undefined;

    const hiveOutput = { system: ["OpenCode provider base prompt"] };
    await systemTransform?.({ sessionID: 'sess_hive_autoload', agent: 'hive-master' }, hiveOutput);
    const foragerOutput = { system: ["OpenCode provider base prompt"] };
    await systemTransform?.({ sessionID: 'sess_forager_autoload', agent: 'forager-worker' }, foragerOutput);

    // hive-master should have parallel-exploration in prompt (unified mode)
    expect(agents["hive-master"]?.prompt).toBeUndefined();
    expect(hiveOutput.system[0]).toContain(
      parallelExplorationSkill!.template,
    );
    expect(hiveOutput.system[0]).not.toContain(onboardingSnippet);

    // scout-researcher should NOT have parallel-exploration in prompt (unified mode)
    // (removed to prevent recursive delegation - scout cannot spawn scouts)
    expect(agents["scout-researcher"]?.prompt).toBeDefined();
    expect(agents["scout-researcher"]?.prompt).not.toContain(
      parallelExplorationSkill!.template,
    );
    expect(agents["scout-researcher"]?.prompt).not.toContain(onboardingSnippet);

    // forager-worker should NOT have parallel-exploration in prompt
    expect(agents["forager-worker"]?.prompt).toBeUndefined();
    expect(foragerOutput.system[0]).not.toContain(
      parallelExplorationSkill!.template,
    );
    expect(foragerOutput.system[0]).not.toContain(onboardingSnippet);
  });

  it("includes task prompt mode", async () => {

    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_task_prompt_mode");

    await hooks.tool!.hive_feature_create.execute(
      { name: "prompt-mode-feature" },
      toolContext
    );

    const plan = `# Prompt Mode Feature

## Discovery

**Q: Is this a test?**
A: Yes, this integration test validates task prompt mode functionality. Ensures worker-prompt.md files are correctly generated with mission context.

## Tasks

### 1. First Task
Do it
`;

    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "prompt-mode-feature" },
      toolContext
    );
    await hooks.tool!.hive_plan_approve.execute(
      { feature: "prompt-mode-feature" },
      toolContext
    );
    await hooks.tool!.hive_tasks_sync.execute(
      { feature: "prompt-mode-feature" },
      toolContext
    );

    const execStartOutput = await hooks.tool!.hive_worktree_start.execute(
      { feature: "prompt-mode-feature", task: "01-first-task" },
      toolContext
    );

    const execStart = JSON.parse(execStartOutput as string) as {
      taskPromptMode?: string;
    };

    expect(execStart.taskPromptMode).toBe("opencode-at-file");
  });

  it("hive_plan_read binds featureName to global session", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_plan_bind");

    await hooks.tool!.hive_feature_create.execute(
      { name: "plan-bind-feature" },
      toolContext
    );
    await hooks.tool!.hive_plan_write.execute(
      {
        content: createSingleTaskPlan(
          "Plan Bind Feature",
          "Yes, this regression test validates that hive_plan_read binds featureName to the global session via SessionService.bindFeature. This is essential for compaction recovery."
        ),
        feature: "plan-bind-feature",
      },
      toolContext
    );

    const workerContext = createToolContext("sess_worker_plan_bind");
    await hooks.tool!.hive_plan_read.execute(
      { feature: "plan-bind-feature" },
      workerContext
    );

    const sessionsPath = path.join(testRoot, ".hive", "sessions.json");
    expect(fs.existsSync(sessionsPath)).toBe(true);
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
    const workerSession = sessions.sessions.find(
      (s: { sessionId: string }) => s.sessionId === "sess_worker_plan_bind"
    );
    expect(workerSession).toBeDefined();
    expect(workerSession.featureName).toBe("plan-bind-feature");
  });

  it("hive_context_write binds featureName to global session", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_ctx_bind");

    await hooks.tool!.hive_feature_create.execute(
      { name: "ctx-bind-feature" },
      toolContext
    );

    const workerContext = createToolContext("sess_worker_ctx_bind");
    await hooks.tool!.hive_context_write.execute(
      { name: "notes", content: "test notes", feature: "ctx-bind-feature" },
      workerContext
    );

    const sessionsPath = path.join(testRoot, ".hive", "sessions.json");
    expect(fs.existsSync(sessionsPath)).toBe(true);
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
    const workerSession = sessions.sessions.find(
      (s: { sessionId: string }) => s.sessionId === "sess_worker_ctx_bind"
    );
    expect(workerSession).toBeDefined();
    expect(workerSession.featureName).toBe("ctx-bind-feature");
  });

  it("hive_worktree_commit binds featureName, taskFolder, and workerPromptPath to global session", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_commit_bind");

    await hooks.tool!.hive_feature_create.execute(
      { name: "commit-bind-feature" },
      toolContext
    );
    await hooks.tool!.hive_plan_write.execute(
      {
        content: createSingleTaskPlan(
          "Commit Bind Feature",
          "Yes, this regression test validates that hive_worktree_commit binds featureName, taskFolder, and workerPromptPath to the global session for compaction recovery."
        ),
        feature: "commit-bind-feature",
      },
      toolContext
    );
    await hooks.tool!.hive_plan_approve.execute(
      { feature: "commit-bind-feature" },
      toolContext
    );
    await hooks.tool!.hive_tasks_sync.execute(
      { feature: "commit-bind-feature" },
      toolContext
    );

    const startRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature: "commit-bind-feature", task: FIRST_TASK },
      toolContext
    );
    const startResult = JSON.parse(startRaw as string);
    expect(startResult.success).toBe(true);

    const workerContext = createToolContext("sess_worker_commit_bind");
    await hooks.tool!.hive_worktree_commit.execute(
      {
        task: FIRST_TASK,
        summary: "Test commit binding. Tests pass.",
        status: "completed",
        feature: "commit-bind-feature",
      },
      workerContext
    );

    const sessionsPath = path.join(testRoot, ".hive", "sessions.json");
    expect(fs.existsSync(sessionsPath)).toBe(true);
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
    const workerSession = sessions.sessions.find(
      (s: { sessionId: string }) => s.sessionId === "sess_worker_commit_bind"
    );
    expect(workerSession).toBeDefined();
    expect(workerSession.featureName).toBe("commit-bind-feature");
    expect(workerSession.taskFolder).toBe(FIRST_TASK);
    expect(workerSession.workerPromptPath).toContain("worker-prompt.md");
  });

  it("preserves manual-task structured spec at worktree launch instead of overwriting", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_manual_spec_preservation");

    await hooks.tool!.hive_feature_create.execute(
      { name: "manual-spec-feature" },
      toolContext
    );

    const plan = `# Manual Spec Feature

## Discovery

**Q: Is this a test?**
A: Yes, this regression test validates that manual tasks with structured metadata preserve their spec.md at worktree launch instead of being overwritten with a plan-section fallback.

## Tasks

### 1. First Task

**Depends on**: none

Do the first thing.
`;

    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "manual-spec-feature" },
      toolContext
    );
    await hooks.tool!.hive_plan_approve.execute(
      { feature: "manual-spec-feature" },
      toolContext
    );
    await hooks.tool!.hive_tasks_sync.execute(
      { feature: "manual-spec-feature" },
      toolContext
    );

    await hooks.tool!.hive_task_create.execute(
      {
        name: "review-fix",
        feature: "manual-spec-feature",
        description: "Fix routing issue found in review",
        goal: "Correct agent routing for swarm dispatch",
        acceptanceCriteria: ["swarm dispatches to correct agent", "existing tests pass"],
        references: ["packages/opencode-hive/src/agents/swarm.ts:107-111"],
        files: ["packages/opencode-hive/src/agents/swarm.ts"],
        reason: "Required by code review",
        source: "review",
      },
      toolContext
    );

    const specPathBefore = path.join(
      testRoot,
      ".hive",
      "features",
      "01_manual-spec-feature",
      "tasks",
      "02-review-fix",
      "spec.md"
    );
    const specBefore = fs.readFileSync(specPathBefore, "utf-8");
    expect(specBefore).toContain("Correct agent routing for swarm dispatch");
    expect(specBefore).toContain("Fix routing issue found in review");

    const raw = await hooks.tool!.hive_worktree_start.execute(
      { feature: "manual-spec-feature", task: "02-review-fix" },
      toolContext
    );

    const result = JSON.parse(raw as string) as {
      success?: boolean;
      worktreePath?: string;
    };
    expect(result.success).toBe(true);
    expect(result.worktreePath).toBeDefined();

    const specAfter = fs.readFileSync(specPathBefore, "utf-8");
    expect(specAfter).toContain("Correct agent routing for swarm dispatch");
    expect(specAfter).toContain("Fix routing issue found in review");
    expect(specAfter).toContain("swarm dispatches to correct agent");
    expect(specAfter).not.toContain("_No plan section available._");
  });

  it("reports deterministic helperStatus that distinguishes done tasks from live wrap-up state", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_helper_status_contract");

    await hooks.tool!.hive_feature_create.execute(
      { name: "helper-status-feature" },
      toolContext
    );

    const plan = `# Helper Status Feature

## Discovery

**Q: Is this a test?**
A: Yes, this regression test validates that OpenCode hive_status exposes deterministic helperStatus fields showing observable task/worktree wrap-up state without inventing merge truth.

## Tasks

### 1. First Task

**Depends on**: none

Finish the first task.

### 2. Second Task

**Depends on**: 1

Wait for task one.

### 3. Third Task

**Depends on**: 1

Also wait for task one.
`;

    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: "helper-status-feature" },
      toolContext
    );
    await hooks.tool!.hive_plan_approve.execute(
      { feature: "helper-status-feature" },
      toolContext
    );
    await hooks.tool!.hive_tasks_sync.execute(
      { feature: "helper-status-feature" },
      toolContext
    );

    await hooks.tool!.hive_task_create.execute(
      {
        feature: "helper-status-feature",
        name: "operator-followup",
        source: "operator",
      },
      toolContext
    );

    const startRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature: "helper-status-feature", task: FIRST_TASK },
      toolContext
    );
    const startResult = JSON.parse(startRaw as string) as {
      success?: boolean;
      worktreePath?: string;
    };

    expect(startResult.success).toBe(true);
    expect(startResult.worktreePath).toBeDefined();

    fs.writeFileSync(
      path.join(startResult.worktreePath!, "wrapup.txt"),
      "observable wrap-up state\n"
    );

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature: "helper-status-feature",
        task: FIRST_TASK,
        status: "completed",
        summary: "Finished the first task. Regression test recorded wrap-up state.",
      },
      createToolContext("sess_helper_status_worker")
    );
    const commitResult = JSON.parse(commitRaw as string) as {
      ok?: boolean;
      taskState?: string;
      worktreePath?: string;
    };

    expect(commitResult.ok).toBe(true);
    expect(commitResult.taskState).toBe("done");
    expect(commitResult.worktreePath).toBe(startResult.worktreePath);

    fs.writeFileSync(
      path.join(startResult.worktreePath!, "post-commit-dirty.txt"),
      "still dirty after task marked done\n"
    );

    const statusRaw = await hooks.tool!.hive_status.execute(
      { feature: "helper-status-feature" },
      toolContext
    );
    const status = JSON.parse(statusRaw as string) as {
      tasks?: {
        pending?: number;
        runnable?: string[];
      };
      helperStatus?: {
        doneTasksWithLiveWorktrees: string[];
        dirtyWorktrees: string[];
        nonInProgressTasksWithWorktrees: string[];
        manualTaskPolicy: {
          order: {
            omitted: string;
            explicitNextOrder: string;
            explicitOtherOrder: string;
          };
          dependsOn: {
            omitted: string;
            explicitDoneTargetsOnly: string;
            explicitMissingTarget: string;
            explicitNotDoneTarget: string;
            reviewSourceWithExplicitDependsOn: string;
          };
        };
        ambiguityFlags: string[];
      };
    };

    expect(status.tasks?.pending).toBe(3);
    expect(status.tasks?.runnable).toEqual([
      "02-second-task",
      "03-third-task",
      "04-operator-followup",
    ]);
    expect(status.helperStatus).toEqual({
      doneTasksWithLiveWorktrees: ["01-first-task"],
      dirtyWorktrees: ["01-first-task"],
      nonInProgressTasksWithWorktrees: ["01-first-task"],
      manualTaskPolicy: {
        order: {
          omitted: "append_next_order",
          explicitNextOrder: "append_next_order",
          explicitOtherOrder: "plan_amendment_required",
        },
        dependsOn: {
          omitted: "store_empty_array",
          explicitDoneTargetsOnly: "allowed",
          explicitMissingTarget: "plan_amendment_required",
          explicitNotDoneTarget: "plan_amendment_required",
          reviewSourceWithExplicitDependsOn: "plan_amendment_required",
        },
      },
      ambiguityFlags: [
        "done_task_has_live_worktree",
        "dirty_non_in_progress_worktree",
        "multiple_runnable_tasks",
      ],
    });
  });

  it("covers the issue-72 3b/3c interruption with explicit helperStatus, unsafe insertion rejection, and safe append-only follow-up", async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_issue_72_followup');

    await hooks.tool!.hive_feature_create.execute({ name: 'issue-72-followup-feature' }, toolContext);

    const plan = `# Issue 72 Follow-up Feature

## Discovery

**Q: Is this a test?**
A: Yes, this integrated regression models the exact issue-72 interruption where task 3 is locally tested and marked done, task 4 is not started yet, and a follow-up 3b/3c request must route through append-only manual-task guardrails.

## Tasks

### 1. First Task

**Depends on**: none

Complete the first planned step.

### 2. Second Task

**Depends on**: 1

Complete the second planned step.

### 3. Third Task

**Depends on**: 2

Locally test and wrap up the third planned step.

### 4. Fourth Task

**Depends on**: 3

Original plan task four content must stay isolated from any append-only manual follow-up.
`;

    await hooks.tool!.hive_plan_write.execute(
      { content: plan, feature: 'issue-72-followup-feature' },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'issue-72-followup-feature' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'issue-72-followup-feature' }, toolContext);

    await hooks.tool!.hive_task_update.execute(
      {
        feature: 'issue-72-followup-feature',
        task: '01-first-task',
        status: 'done',
        summary: 'Setup only: mark task 1 complete so later plan tasks can run without a live worktree.',
      },
      toolContext,
    );
    await hooks.tool!.hive_task_update.execute(
      {
        feature: 'issue-72-followup-feature',
        task: '02-second-task',
        status: 'done',
        summary: 'Setup only: mark task 2 complete so task 3 can model the interrupted wrap-up state.',
      },
      toolContext,
    );

    const startRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature: 'issue-72-followup-feature', task: '03-third-task' },
      toolContext,
    );
    const startResult = JSON.parse(startRaw as string) as {
      success?: boolean;
      worktreePath?: string;
    };

    expect(startResult.success).toBe(true);
    expect(startResult.worktreePath).toBeDefined();

    fs.writeFileSync(
      path.join(startResult.worktreePath!, '03-third-task.txt'),
      '03-third-task completed during issue-72 regression setup\n',
    );

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature: 'issue-72-followup-feature',
        task: '03-third-task',
        status: 'completed',
        summary: 'Completed 03-third-task. Targeted issue-72 regression setup test recorded local wrap-up state.',
      },
      createToolContext('sess_issue_72_worker_03-third-task'),
    );
    const commitResult = JSON.parse(commitRaw as string) as {
      ok?: boolean;
      taskState?: string;
      worktreePath?: string;
    };

    expect(commitResult.ok).toBe(true);
    expect(commitResult.taskState).toBe('done');
    expect(commitResult.worktreePath).toBe(startResult.worktreePath);

    const thirdTaskWorktree = path.join(
      testRoot,
      '.hive',
      '.worktrees',
      'issue-72-followup-feature',
      '03-third-task',
    );
    fs.writeFileSync(
      path.join(thirdTaskWorktree, 'post-commit-dirty.txt'),
      'task 3 still has observable wrap-up state after completion\n',
    );

    const statusRaw = await hooks.tool!.hive_status.execute(
      { feature: 'issue-72-followup-feature' },
      toolContext,
    );
    const status = JSON.parse(statusRaw as string) as {
      tasks?: {
        pending?: number;
        runnable?: string[];
      };
      helperStatus?: {
        doneTasksWithLiveWorktrees: string[];
        dirtyWorktrees: string[];
        nonInProgressTasksWithWorktrees: string[];
        manualTaskPolicy: {
          order: {
            omitted: string;
            explicitNextOrder: string;
            explicitOtherOrder: string;
          };
          dependsOn: {
            omitted: string;
            explicitDoneTargetsOnly: string;
            explicitMissingTarget: string;
            explicitNotDoneTarget: string;
            reviewSourceWithExplicitDependsOn: string;
          };
        };
        ambiguityFlags: string[];
      };
    };

    expect(status.tasks?.pending).toBe(1);
    expect(status.tasks?.runnable).toEqual(['04-fourth-task']);
    expect(status.helperStatus).toEqual({
      doneTasksWithLiveWorktrees: ['03-third-task'],
      dirtyWorktrees: ['03-third-task'],
      nonInProgressTasksWithWorktrees: ['03-third-task'],
      manualTaskPolicy: {
        order: {
          omitted: 'append_next_order',
          explicitNextOrder: 'append_next_order',
          explicitOtherOrder: 'plan_amendment_required',
        },
        dependsOn: {
          omitted: 'store_empty_array',
          explicitDoneTargetsOnly: 'allowed',
          explicitMissingTarget: 'plan_amendment_required',
          explicitNotDoneTarget: 'plan_amendment_required',
          reviewSourceWithExplicitDependsOn: 'plan_amendment_required',
        },
      },
      ambiguityFlags: [
        'done_task_has_live_worktree',
        'dirty_non_in_progress_worktree',
      ],
    });

    let unsafeInsertionError: unknown;
    try {
      await hooks.tool!.hive_task_create.execute(
        {
          feature: 'issue-72-followup-feature',
          name: 'issue-72-3b-followup',
          order: 4,
          description: 'Unsafe 3b insertion that should be rejected.',
          goal: 'Confirm append-only ordering rejects intermediate insertion.',
          acceptanceCriteria: ['Tool rejects non-next order'],
          reason: 'Reproduce issue-72 3b/3c unsafe insertion attempt',
          source: 'operator',
        },
        toolContext,
      );
    } catch (error) {
      unsafeInsertionError = error;
    }

    expect(unsafeInsertionError).toBeInstanceOf(Error);
    expect((unsafeInsertionError as Error).message).toBe(
      'Manual tasks are append-only: requested order 4 does not match the next available order 5. Intermediate insertion requires plan amendment.',
    );
    expect((unsafeInsertionError as Error).message.toLowerCase()).toContain('manual tasks are append-only');
    expect((unsafeInsertionError as Error).message.toLowerCase()).toContain('plan amendment');

    const safeCreateResult = await hooks.tool!.hive_task_create.execute(
      {
        feature: 'issue-72-followup-feature',
        name: 'issue-72-safe-followup',
        description: 'Add the safe append-only follow-up that Hive Helper can create after the interruption.',
        goal: 'Capture the manual follow-up without rewriting the plan-backed task sequence.',
        acceptanceCriteria: [
          'Follow-up lands at the append-only next order',
          'Spec stays isolated from task four plan content',
        ],
        references: ['packages/opencode-hive/src/e2e/plugin-smoke.test.ts'],
        files: ['packages/opencode-hive/src/e2e/plugin-smoke.test.ts'],
        reason: 'Issue-72 safe append-only follow-up after task 3 wrap-up',
        source: 'operator',
      },
      toolContext,
    );

    expect(safeCreateResult).toContain('Manual task created: 05-issue-72-safe-followup');

    const [featureDir] = fs.readdirSync(path.join(testRoot, '.hive', 'features'));
    const safeTaskDir = path.join(
      testRoot,
      '.hive',
      'features',
      featureDir,
      'tasks',
      '05-issue-72-safe-followup',
    );
    const safeTaskStatus = JSON.parse(
      fs.readFileSync(path.join(safeTaskDir, 'status.json'), 'utf-8'),
    ) as {
      status: string;
      origin: string;
      dependsOn: string[];
      planTitle: string;
      metadata?: {
        description?: string;
        goal?: string;
        acceptanceCriteria?: string[];
      };
    };
    const safeTaskSpec = fs.readFileSync(path.join(safeTaskDir, 'spec.md'), 'utf-8');

    expect(safeTaskStatus).toMatchObject({
      status: 'pending',
      origin: 'manual',
      dependsOn: [],
      planTitle: 'issue-72-safe-followup',
      metadata: {
        description: 'Add the safe append-only follow-up that Hive Helper can create after the interruption.',
        goal: 'Capture the manual follow-up without rewriting the plan-backed task sequence.',
        acceptanceCriteria: [
          'Follow-up lands at the append-only next order',
          'Spec stays isolated from task four plan content',
        ],
      },
    });
    expect(safeTaskSpec).toContain('Add the safe append-only follow-up that Hive Helper can create after the interruption.');
    expect(safeTaskSpec).toContain('Capture the manual follow-up without rewriting the plan-backed task sequence.');
    expect(safeTaskSpec).not.toContain('Original plan task four content must stay isolated from any append-only manual follow-up.');
  });

  it("rejects manual-task insertion outside the next append-only slot", async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_manual_task_order_guard');

    await hooks.tool!.hive_feature_create.execute({ name: 'manual-order-feature' }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      {
        content: createSingleTaskPlan(
          'Manual Order Feature',
          'Yes, this regression test validates that manual tasks can only be appended at the next deterministic order.'
        ),
        feature: 'manual-order-feature',
      },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'manual-order-feature' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'manual-order-feature' }, toolContext);

    await expect(
      hooks.tool!.hive_task_create.execute(
        {
          name: 'manual-insert',
          order: 99,
          feature: 'manual-order-feature',
        },
        toolContext,
      ),
    ).rejects.toThrow(/append-only|intermediate insertion requires plan amendment|plan amendment/i);
  });

  it("rejects manual-task dependencies on unfinished work", async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_manual_task_dep_guard');

    await hooks.tool!.hive_feature_create.execute({ name: 'manual-dependency-feature' }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      {
        content: createSingleTaskPlan(
          'Manual Dependency Feature',
          'Yes, this regression test validates that manual tasks reject dependencies on unfinished work.'
        ),
        feature: 'manual-dependency-feature',
      },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'manual-dependency-feature' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'manual-dependency-feature' }, toolContext);

    await expect(
      hooks.tool!.hive_task_create.execute(
        {
          name: 'manual-follow-up',
          feature: 'manual-dependency-feature',
          dependsOn: ['01-first-task'],
        },
        toolContext,
      ),
    ).rejects.toThrow(/dependencies on unfinished work require plan amendment|plan amendment/i);
  });

  it("worker chat.message in task worktree binds featureName, taskFolder, and workerPromptPath before commit", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_start_bind");

    await hooks.tool!.hive_feature_create.execute(
      { name: "start-bind-feature" },
      toolContext
    );
    await hooks.tool!.hive_plan_write.execute(
      {
        content: createSingleTaskPlan(
          "Start Bind Feature",
          "Yes, this regression test validates that hive_worktree_start binds featureName, taskFolder, and workerPromptPath early enough for compaction recovery before worker commit."
        ),
        feature: "start-bind-feature",
      },
      toolContext
    );
    await hooks.tool!.hive_plan_approve.execute(
      { feature: "start-bind-feature" },
      toolContext
    );
    await hooks.tool!.hive_tasks_sync.execute(
      { feature: "start-bind-feature" },
      toolContext
    );

    const startRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature: "start-bind-feature", task: FIRST_TASK },
      toolContext
    );
    const startResult = JSON.parse(startRaw as string);
    expect(startResult.success).toBe(true);

    const workerHooks = await plugin({
      directory: testRoot,
      worktree: startResult.worktreePath,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(startResult.worktreePath),
      client: OPENCODE_CLIENT,
      $: createStubShell(),
    });

    await workerHooks["chat.message"]?.(
      { sessionID: "sess_worker_start_bind", agent: "forager-worker" },
      { message: {} as any, parts: [] }
    );

    const sessionsPath = path.join(testRoot, ".hive", "sessions.json");
    expect(fs.existsSync(sessionsPath)).toBe(true);
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
    const workerSession = sessions.sessions.find(
      (s: { sessionId: string }) => s.sessionId === "sess_worker_start_bind"
    );
    expect(workerSession).toBeDefined();
    expect(workerSession.featureName).toBe("start-bind-feature");
    expect(workerSession.taskFolder).toBe(FIRST_TASK);
    expect(workerSession.workerPromptPath).toContain("worker-prompt.md");
  });

  it('does not declare the removed post-tool hook in the supported hook source of truth', () => {
    expect([...SUPPORTED_PLUGIN_HOOKS]).toEqual([
      'event',
      'config',
      'chat.message',
      'experimental.chat.system.transform',
      'experimental.chat.messages.transform',
      'tool.execute.before',
    ]);
  });
});

// ============================================================================
// Multi-repo / composite workspace e2e
// ============================================================================

function initBareRepo(p: string): void {
  fs.mkdirSync(p, { recursive: true });
  execSync('git init', { cwd: p });
  execSync('git config user.email "test@example.com"', { cwd: p });
  execSync('git config user.name "Test"', { cwd: p });
  fs.writeFileSync(path.join(p, 'README.md'), `repo at ${path.basename(p)}\n`);
  execSync('git add README.md', { cwd: p });
  execSync('git commit -m "init"', { cwd: p });
}

describe('e2e: opencode-hive multi-repo composite workspaces', () => {
  let testRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    process.chdir(TEST_PROCESS_CWD);
    originalHome = process.env.HOME;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'multi-repo-'));
    process.env.HOME = testRoot;
  });

  afterEach(() => {
    process.chdir(TEST_PROCESS_CWD);
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  function writeManifest(repoIds: string[]): void {
    const hiveDir = path.join(testRoot, '.hive');
    fs.mkdirSync(hiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(hiveDir, 'agent-hive.json'),
      JSON.stringify({
        repositories: repoIds.map((id) => ({ id, path: `./repos/${id}` })),
      }, null, 2),
    );
  }

  async function setupMultiRepoProject(repoIds: string[]): Promise<void> {
    initBareRepo(testRoot);
    for (const id of repoIds) {
      initBareRepo(path.join(testRoot, 'repos', id));
    }
    writeManifest(repoIds);
  }

  it('accepts repos in hive_task_create and persists repoIds to status', async () => {
    await setupMultiRepoProject(['api', 'web']);
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_create');

    await hooks.tool!.hive_feature_create.execute({ name: 'mr-create' }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      { content: createSingleTaskPlan('MR Create', 'Yes, this regression test validates that hive_task_create accepts repos and persists repoIds to status.json for manifest-backed projects.'), feature: 'mr-create' },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'mr-create' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'mr-create' }, toolContext);

    const manualResult = await hooks.tool!.hive_task_create.execute(
      {
        feature: 'mr-create',
        name: 'multi-repo-manual',
        repos: ['api', 'web'],
      },
      toolContext,
    );
    expect(String(manualResult)).toContain('Repos: [api, web]');

    const featuresDir = path.join(testRoot, '.hive', 'features');
    const featureDirName = fs.readdirSync(featuresDir).find((d) => d.endsWith('mr-create'))!;
    const statusJson = JSON.parse(
      fs.readFileSync(
        path.join(featuresDir, featureDirName, 'tasks', '02-multi-repo-manual', 'status.json'),
        'utf-8',
      ),
    );
    expect(statusJson.repoIds).toEqual(['api', 'web']);
  });

  it('lets agents inspect, discover, and add project repositories to the manifest', async () => {
    initBareRepo(path.join(testRoot, 'api'));
    initBareRepo(path.join(testRoot, 'apps', 'web-ui'));
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_tools');

    const missingStatusRaw = await hooks.tool!.hive_repositories_status.execute({}, toolContext);
    const missingStatus = JSON.parse(missingStatusRaw as string) as { mode: string; repositories: unknown[] };
    expect(missingStatus.mode).toBe('missing-manifest');
    expect(missingStatus.repositories).toEqual([]);

    const discoverRaw = await hooks.tool!.hive_repositories_discover.execute({}, toolContext);
    const discover = JSON.parse(discoverRaw as string) as {
      candidates: Array<{ id: string; path: string }>;
      truncated: boolean;
    };
    expect(discover.truncated).toBe(false);
    expect(discover.candidates).toEqual([
      expect.objectContaining({ id: 'api', path: './api' }),
      expect.objectContaining({ id: 'web-ui', path: './apps/web-ui' }),
    ]);

    const updateRaw = await hooks.tool!.hive_repositories_update.execute(
      { repositories: [{ id: 'api', path: './api' }] },
      toolContext,
    );
    const update = JSON.parse(updateRaw as string) as { added: string[]; repositories: Array<{ id: string; path: string }> };
    expect(update.added).toEqual(['api']);
    expect(update.repositories).toEqual([expect.objectContaining({ id: 'api', path: './api' })]);

    const manifest = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'agent-hive.json'), 'utf-8'));
    expect(manifest.repositories).toEqual([{ id: 'api', path: './api' }]);
  });

  it('rejects hive_task_create with an unknown repository id', async () => {
    await setupMultiRepoProject(['api']);
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_bad');

    await hooks.tool!.hive_feature_create.execute({ name: 'mr-bad' }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      { content: createSingleTaskPlan('MR Bad', 'Yes, this regression test validates that hive_task_create rejects unknown or invalid repository IDs at creation time before any worktree is touched.'), feature: 'mr-bad' },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'mr-bad' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'mr-bad' }, toolContext);

    // Invalid grammar (uppercase) -> validateRepoIds throws
    await expect(
      hooks.tool!.hive_task_create.execute(
        { feature: 'mr-bad', name: 'bad-grammar', repos: ['NotValid'] },
        toolContext,
      ),
    ).rejects.toThrow(/Invalid repository ID/);

    // Valid grammar but not in the project manifest -> manifest-aware rejection
    await expect(
      hooks.tool!.hive_task_create.execute(
        { feature: 'mr-bad', name: 'ghost-repo', repos: ['ghost'] },
        toolContext,
      ),
    ).rejects.toThrow(/Unknown repository ID\(s\) in repos: ghost/);
  });

  it('exposes repoIds in hive_status task list entries', async () => {
    await setupMultiRepoProject(['api', 'web']);
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_status');

    await hooks.tool!.hive_feature_create.execute({ name: 'mr-status' }, toolContext);
    const plan = `# MR Status

## Discovery

**Q: ok?**
A: Yes, this regression test validates that hive_status exposes the per-task repoIds field for manifest-backed projects so orchestrators and the VS Code viewer can render multi-repo task scope without re-reading status.json.

## Tasks

### 1. Multi Repo Task
**Repos**: api, web
Do it.
`;
    await hooks.tool!.hive_plan_write.execute({ content: plan, feature: 'mr-status' }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature: 'mr-status' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'mr-status' }, toolContext);

    const statusRaw = await hooks.tool!.hive_status.execute({ feature: 'mr-status' }, toolContext);
    const status = JSON.parse(statusRaw as string) as {
      tasks?: { list?: Array<{ folder: string; repoIds?: string[] | null }> };
    };
    const task = status.tasks?.list?.find((t) => t.folder === '01-multi-repo-task');
    expect(task?.repoIds).toEqual(['api', 'web']);
  });

  it('exposes workspacePath, worktreePath (=workspace root), baseCommits, and repos in hive_worktree_start launch metadata', async () => {
    await setupMultiRepoProject(['api', 'web']);
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_launch');

    await hooks.tool!.hive_feature_create.execute({ name: 'mr-launch' }, toolContext);
    const plan = `# MR Launch

## Discovery

**Q: ok?**
A: Yes, this regression test validates that hive_worktree_start returns composite launch metadata (workspacePath, baseCommits, repos) when the project has a repository manifest and the task declares its repos.

## Tasks

### 1. Multi Repo Task
**Repos**: api, web
Do it.
`;
    await hooks.tool!.hive_plan_write.execute({ content: plan, feature: 'mr-launch' }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature: 'mr-launch' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'mr-launch' }, toolContext);

    const startRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature: 'mr-launch', task: '01-multi-repo-task' },
      toolContext,
    );
    const start = JSON.parse(startRaw as string) as {
      success?: boolean;
      worktreePath?: string;
      workspacePath?: string;
      worktreeMode?: string;
      baseCommits?: Record<string, string>;
      repos?: Record<string, { path: string; branch: string; commit: string }>;
    };

    expect(start.success).toBe(true);
    expect(start.worktreeMode).toBe('composite');
    expect(start.workspacePath).toBeDefined();
    expect(start.worktreePath).toBe(start.workspacePath);
    expect(start.workspacePath).toContain('.hive/.worktrees/mr-launch/01-multi-repo-task');
    expect(start.baseCommits).toBeDefined();
    expect(Object.keys(start.baseCommits!).sort()).toEqual(['api', 'web']);
    expect(start.repos).toBeDefined();
    expect(start.repos!.api.path).toContain('repos/api');
    expect(start.repos!.web.path).toContain('repos/web');
    expect(start.repos!.api.branch).toBe('hive/api/mr-launch/01-multi-repo-task');
    expect(start.repos!.web.branch).toBe('hive/web/mr-launch/01-multi-repo-task');
  });

  it('fails hive_worktree_start when a manifest-backed task declares an unknown repo id', async () => {
    await setupMultiRepoProject(['api']);
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_missing');

    await hooks.tool!.hive_feature_create.execute({ name: 'mr-missing' }, toolContext);
    const plan = `# MR Missing

## Discovery

**Q: ok?**
A: Yes, this regression test validates that hive_worktree_start fails fast when a task declares a repository id that is absent from the project repository manifest, before any worktree directories are created.

## Tasks

### 1. Bad Task
**Repos**: api, ghost
Do it.
`;
    await hooks.tool!.hive_plan_write.execute({ content: plan, feature: 'mr-missing' }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature: 'mr-missing' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'mr-missing' }, toolContext);

    await expect(
      hooks.tool!.hive_worktree_start.execute(
        { feature: 'mr-missing', task: '01-bad-task' },
        toolContext,
      ),
    ).rejects.toThrow(/missing required repos/);
  });

  it('fails hive_worktree_start for a manifest-backed task that omits Repos metadata', async () => {
    await setupMultiRepoProject(['api']);
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_omitted');

    await hooks.tool!.hive_feature_create.execute({ name: 'mr-omit' }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      { content: createSingleTaskPlan('MR Omit', 'Yes, this regression test validates that manifest-backed projects fail hive_worktree_start when the task omits the Repos annotation entirely instead of silently picking a default repository.'), feature: 'mr-omit' },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'mr-omit' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'mr-omit' }, toolContext);

    await expect(
      hooks.tool!.hive_worktree_start.execute(
        { feature: 'mr-omit', task: '01-first-task' },
        toolContext,
      ),
    ).rejects.toThrow(/must declare Repos/);
  });

  it('preserves single-repo legacy launch metadata when no project repository manifest is present', async () => {
    initBareRepo(testRoot);
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_legacy');

    await hooks.tool!.hive_feature_create.execute({ name: 'legacy-feature' }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      { content: createSingleTaskPlan('Legacy', 'Yes, this regression test validates that projects without a repository manifest stay in legacy single-worktree mode and that hive_worktree_start does not surface composite-only launch fields.'), feature: 'legacy-feature' },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'legacy-feature' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'legacy-feature' }, toolContext);

    const startRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature: 'legacy-feature', task: '01-first-task' },
      toolContext,
    );
    const start = JSON.parse(startRaw as string) as {
      success?: boolean;
      worktreePath?: string;
      workspacePath?: string;
      worktreeMode?: string;
      repos?: unknown;
      baseCommits?: unknown;
    };

    expect(start.success).toBe(true);
    expect(start.worktreeMode).toBe('legacy');
    expect(start.repos).toBeUndefined();
    expect(start.baseCommits).toBeUndefined();
    expect(start.worktreePath).toContain('.hive/.worktrees/legacy-feature/01-first-task');
    // For legacy, workspacePath falls back to the worktree path.
    expect(start.workspacePath).toBe(start.worktreePath);
  });

  it('ignores ~/.config/opencode/agent_hive.json repositories: global manifests are not used for orchestration', async () => {
    initBareRepo(testRoot);
    // testRoot doubles as HOME during this suite; write a global manifest that
    // would set up bogus repositories. RepositoryService must ignore it.
    const globalDir = path.join(testRoot, '.config', 'opencode');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'agent_hive.json'),
      JSON.stringify({ repositories: [{ id: 'bogus', path: './does-not-exist' }] }, null, 2),
    );

    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_global_ignored');

    await hooks.tool!.hive_feature_create.execute({ name: 'ignore-global' }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      { content: createSingleTaskPlan('Ignore Global', 'Yes, this regression test validates that global ~/.config/opencode/agent_hive.json repositories are not used to drive orchestration: only project-scoped manifests enable composite worktrees.'), feature: 'ignore-global' },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'ignore-global' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'ignore-global' }, toolContext);

    const startRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature: 'ignore-global', task: '01-first-task' },
      toolContext,
    );
    const start = JSON.parse(startRaw as string) as { success?: boolean; worktreeMode?: string };
    expect(start.success).toBe(true);
    // Global manifest must NOT promote this project into composite mode.
    expect(start.worktreeMode).toBe('legacy');
  });

  it('fails loud when a manifest-backed task targets a repo path that does not exist', async () => {
    // Initialise project root and one valid repo; declare a second repo with a
    // missing on-disk path so RepositoryService.resolveRepositories() throws.
    initBareRepo(testRoot);
    initBareRepo(path.join(testRoot, 'repos', 'api'));
    const hiveDir = path.join(testRoot, '.hive');
    fs.mkdirSync(hiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(hiveDir, 'agent-hive.json'),
      JSON.stringify({
        repositories: [
          { id: 'api', path: './repos/api' },
          { id: 'web', path: './repos/web-missing-on-disk' },
        ],
      }, null, 2),
    );

    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_resolver_fail_loud');

    await hooks.tool!.hive_feature_create.execute({ name: 'mr-bad-path' }, toolContext);
    const plan = `# MR Bad Path

## Discovery

**Q: ok?**
A: Yes, this regression test validates that RepositoryService.resolveRepositories failures propagate from the OpenCode resolver instead of being silently swallowed into a legacy fallback before worktree creation.

## Tasks

### 1. Multi Repo Task
**Repos**: api, web
Do it.
`;
    await hooks.tool!.hive_plan_write.execute({ content: plan, feature: 'mr-bad-path' }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature: 'mr-bad-path' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'mr-bad-path' }, toolContext);

    await expect(
      hooks.tool!.hive_worktree_start.execute(
        { feature: 'mr-bad-path', task: '01-multi-repo-task' },
        toolContext,
      ),
    ).rejects.toThrow(/Repository path does not exist/);

    // Worktree must NOT have been created on the legacy fallback path.
    const legacyWorktree = path.join(testRoot, '.hive', '.worktrees', 'mr-bad-path', '01-multi-repo-task');
    expect(fs.existsSync(legacyWorktree)).toBe(false);
  });

  it('fails loud with manifest-required wording when project root is not a git repo and no manifest is configured', async () => {
    // No initBareRepo, no manifest. The project root is just a plain directory.
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_no_manifest_non_git');

    await hooks.tool!.hive_feature_create.execute({ name: 'no-manifest' }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      { content: createSingleTaskPlan('No Manifest', 'Yes, this regression test validates that non-git project roots without a repository manifest fail with explicit manifest-required wording before the legacy git worktree path is attempted.'), feature: 'no-manifest' },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'no-manifest' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'no-manifest' }, toolContext);

    await expect(
      hooks.tool!.hive_worktree_start.execute(
        { feature: 'no-manifest', task: '01-first-task' },
        toolContext,
      ),
    ).rejects.toThrow(/Repository manifest is required/);
  });

  it('rejects hive_task_create({ repos: ["ghost"] }) when project repository manifest is configured', async () => {
    await setupMultiRepoProject(['api']);
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_manifest_unknown');

    await hooks.tool!.hive_feature_create.execute({ name: 'mr-ghost' }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      { content: createSingleTaskPlan('MR Ghost', 'Yes, this regression test validates that hive_task_create rejects valid-but-unknown repo IDs against the project manifest before any task files are written.'), feature: 'mr-ghost' },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'mr-ghost' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'mr-ghost' }, toolContext);

    await expect(
      hooks.tool!.hive_task_create.execute(
        { feature: 'mr-ghost', name: 'ghost-task', repos: ['ghost'] },
        toolContext,
      ),
    ).rejects.toThrow(/Unknown repository ID\(s\) in repos: ghost/);
  });

  // --- Composite commit/merge contract tests (Task 07) ---

  async function setupCompositeTaskWorktree(
    repoIds: string[],
    feature: string,
    sessionID: string,
  ): Promise<{
    hooks: PluginHooks;
    toolContext: ToolContext;
    workspacePath: string;
    repos: Record<string, { path: string; branch: string; commit: string }>;
  }> {
    await setupMultiRepoProject(repoIds);
    const { hooks, toolContext } = await createHooksForTest(testRoot, sessionID);
    await hooks.tool!.hive_feature_create.execute({ name: feature }, toolContext);
    const reposLine = repoIds.join(', ');
    const plan = `# ${feature}\n\n## Discovery\n\n**Q: ok?**\nA: Yes, this regression test validates composite commit/merge wrapper contracts for the multi-repo readiness feature.\n\n## Tasks\n\n### 1. Composite Task\n**Repos**: ${reposLine}\nDo it.\n`;
    await hooks.tool!.hive_plan_write.execute({ content: plan, feature }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);
    const startRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature, task: '01-composite-task' },
      toolContext,
    );
    const start = JSON.parse(startRaw as string) as {
      workspacePath: string;
      repos: Record<string, { path: string; branch: string; commit: string }>;
    };
    return { hooks, toolContext, workspacePath: start.workspacePath, repos: start.repos };
  }

  it('hive_worktree_commit (composite single-repo): success returns ok=true terminal done with commit.repos', async () => {
    const feature = 'mr-commit-single';
    const { hooks, toolContext, repos } = await setupCompositeTaskWorktree(['api'], feature, 'sess_mr_commit_single');

    fs.writeFileSync(path.join(repos.api.path, 'note.txt'), 'single-repo composite commit\n');

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: '01-composite-task', status: 'completed', summary: 'Composite single-repo commit. Tests pass.' },
      toolContext,
    );
    const commitResult = JSON.parse(commitRaw as string) as {
      ok: boolean;
      terminal: boolean;
      taskState?: string;
      commit?: { committed?: boolean; partial?: boolean; error?: string; repos?: Record<string, { committed: boolean }> };
      nextAction?: string;
    };

    expect(commitResult.ok).toBe(true);
    expect(commitResult.terminal).toBe(true);
    expect(commitResult.taskState).toBe('done');
    expect(commitResult.commit?.committed).toBe(true);
    expect(commitResult.commit?.partial).toBeFalsy();
    expect(commitResult.commit?.repos).toBeDefined();
    expect(commitResult.commit?.repos!.api.committed).toBe(true);
    expect(commitResult.nextAction).toContain('hive_merge');
  });

  it('hive_worktree_commit (composite multi-repo): all-success returns ok=true done with per-repo entries and repo-qualified report files', async () => {
    const feature = 'mr-commit-multi';
    const { hooks, toolContext, repos } = await setupCompositeTaskWorktree(['api', 'web'], feature, 'sess_mr_commit_multi');

    fs.writeFileSync(path.join(repos.api.path, 'api-note.txt'), 'api change\n');
    fs.writeFileSync(path.join(repos.web.path, 'web-note.txt'), 'web change\n');

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: '01-composite-task', status: 'completed', summary: 'Composite multi-repo commit. Tests pass.' },
      toolContext,
    );
    const commitResult = JSON.parse(commitRaw as string) as {
      ok: boolean;
      terminal: boolean;
      taskState?: string;
      reportPath?: string;
      commit?: { committed?: boolean; partial?: boolean; repos?: Record<string, { committed: boolean }> };
    };

    expect(commitResult.ok).toBe(true);
    expect(commitResult.terminal).toBe(true);
    expect(commitResult.taskState).toBe('done');
    expect(commitResult.commit?.committed).toBe(true);
    expect(commitResult.commit?.partial).toBeFalsy();
    expect(Object.keys(commitResult.commit?.repos ?? {}).sort()).toEqual(['api', 'web']);
    expect(commitResult.commit?.repos!.api.committed).toBe(true);
    expect(commitResult.commit?.repos!.web.committed).toBe(true);

    // Report should list repo-qualified files (aggregate getDiff returns "repoId:path").
    const reportPath = commitResult.reportPath!;
    const report = fs.readFileSync(reportPath, 'utf-8');
    expect(report).toContain('api:api-note.txt');
    expect(report).toContain('web:web-note.txt');
  });

  it('hive_worktree_commit (composite multi-repo): all repos no changes returns ok=true done with explicit no-file-changes report', async () => {
    const feature = 'mr-commit-noop';
    const { hooks, toolContext } = await setupCompositeTaskWorktree(['api', 'web'], feature, 'sess_mr_commit_noop');

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: '01-composite-task', status: 'completed', summary: 'Composite no-change commit. Tests pass.' },
      toolContext,
    );
    const commitResult = JSON.parse(commitRaw as string) as {
      ok: boolean;
      terminal: boolean;
      taskState?: string;
      reportPath?: string;
      commit?: { committed?: boolean; partial?: boolean; repos?: Record<string, { committed: boolean }> };
    };

    expect(commitResult.ok).toBe(true);
    expect(commitResult.terminal).toBe(true);
    expect(commitResult.taskState).toBe('done');
    expect(commitResult.commit?.committed).toBe(false);
    expect(commitResult.commit?.partial).toBeFalsy();
    expect(commitResult.commit?.repos!.api.committed).toBe(false);
    expect(commitResult.commit?.repos!.web.committed).toBe(false);

    const report = fs.readFileSync(commitResult.reportPath!, 'utf-8');
    expect(report).toContain('No file changes detected');
  });

  it('hive_worktree_commit (composite): partial failure after earlier repo committed keeps task in_progress and surfaces commit.partial/repos/error', async () => {
    const feature = 'mr-commit-partial';
    const { hooks, toolContext, repos } = await setupCompositeTaskWorktree(['api', 'web'], feature, 'sess_mr_commit_partial');

    // Stage a change in api (sorted first), then break web so its commit fails.
    fs.writeFileSync(path.join(repos.api.path, 'api-note.txt'), 'api change\n');
    fs.rmSync(repos.web.path, { recursive: true, force: true });

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: '01-composite-task', status: 'completed', summary: 'Composite partial failure attempt. Tests pass.' },
      toolContext,
    );
    const commitResult = JSON.parse(commitRaw as string) as {
      ok: boolean;
      terminal: boolean;
      status?: string;
      taskState?: string;
      reportPath?: string;
      commit?: { committed?: boolean; partial?: boolean; error?: string; repos?: Record<string, { committed: boolean }> };
      nextAction?: string;
      message?: string;
    };

    expect(commitResult.ok).toBe(false);
    expect(commitResult.terminal).toBe(false);
    expect(commitResult.taskState).toBe('in_progress');
    expect(commitResult.commit?.committed).toBe(false);
    expect(commitResult.commit?.partial).toBe(true);
    expect(commitResult.commit?.repos).toBeDefined();
    expect(commitResult.commit?.repos!.api.committed).toBe(true);
    expect(commitResult.commit?.repos!.web.committed).toBe(false);
    expect(commitResult.commit?.error).toContain('web');
    expect(commitResult.reportPath).toBeUndefined();
    expect(commitResult.nextAction ?? '').toMatch(/resolve|blocked|failed/i);
  });

  it('hive_merge (composite single-repo): returns aggregate repos and success', async () => {
    const feature = 'mr-merge-single';
    const { hooks, toolContext, repos } = await setupCompositeTaskWorktree(['api'], feature, 'sess_mr_merge_single');

    fs.writeFileSync(path.join(repos.api.path, 'merge-note.txt'), 'composite single merge\n');
    await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: '01-composite-task', status: 'completed', summary: 'Prepare composite single merge. Tests pass.' },
      toolContext,
    );

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: '01-composite-task', strategy: 'merge' },
      toolContext,
    );
    const mergeResult = JSON.parse(mergeRaw as string) as {
      success: boolean;
      merged: boolean;
      partial?: boolean;
      filesChanged: string[];
      repos?: Record<string, { success: boolean; merged: boolean }>;
      message: string;
    };

    expect(mergeResult.success).toBe(true);
    expect(mergeResult.merged).toBe(true);
    expect(mergeResult.partial).toBeFalsy();
    expect(mergeResult.repos).toBeDefined();
    expect(mergeResult.repos!.api.success).toBe(true);
    expect(mergeResult.repos!.api.merged).toBe(true);
    expect(mergeResult.filesChanged).toContain('api:merge-note.txt');
    expect(mergeResult.message).toContain('merged successfully');
  });

  it('hive_merge (composite multi-repo): all-success returns aggregate repos with flattened repoId:path filesChanged', async () => {
    const feature = 'mr-merge-multi';
    const { hooks, toolContext, repos } = await setupCompositeTaskWorktree(['api', 'web'], feature, 'sess_mr_merge_multi');

    fs.writeFileSync(path.join(repos.api.path, 'api-merge.txt'), 'api merge\n');
    fs.writeFileSync(path.join(repos.web.path, 'web-merge.txt'), 'web merge\n');
    await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: '01-composite-task', status: 'completed', summary: 'Prepare composite multi merge. Tests pass.' },
      toolContext,
    );

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: '01-composite-task', strategy: 'merge' },
      toolContext,
    );
    const mergeResult = JSON.parse(mergeRaw as string) as {
      success: boolean;
      merged: boolean;
      partial?: boolean;
      filesChanged: string[];
      repos?: Record<string, { success: boolean; merged: boolean }>;
    };

    expect(mergeResult.success).toBe(true);
    expect(mergeResult.merged).toBe(true);
    expect(mergeResult.partial).toBeFalsy();
    expect(Object.keys(mergeResult.repos ?? {}).sort()).toEqual(['api', 'web']);
    expect(mergeResult.repos!.api.merged).toBe(true);
    expect(mergeResult.repos!.web.merged).toBe(true);
    expect(mergeResult.filesChanged).toContain('api:api-merge.txt');
    expect(mergeResult.filesChanged).toContain('web:web-merge.txt');
  });

  it('hive_merge (composite): preflight failure (target repo dirty) returns success=false partial=false before mutating any repo', async () => {
    const feature = 'mr-merge-preflight';
    const { hooks, toolContext, repos } = await setupCompositeTaskWorktree(['api', 'web'], feature, 'sess_mr_merge_preflight');

    fs.writeFileSync(path.join(repos.api.path, 'api-pre.txt'), 'api pre\n');
    fs.writeFileSync(path.join(repos.web.path, 'web-pre.txt'), 'web pre\n');
    await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: '01-composite-task', status: 'completed', summary: 'Prepare composite preflight merge. Tests pass.' },
      toolContext,
    );

    // Make web target repo dirty so preflight fails.
    fs.writeFileSync(path.join(testRoot, 'repos', 'web', 'dirty.txt'), 'dirty target\n');

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: '01-composite-task', strategy: 'merge' },
      toolContext,
    );
    const mergeResult = JSON.parse(mergeRaw as string) as {
      success: boolean;
      merged: boolean;
      partial?: boolean;
      error?: string;
      message: string;
    };

    expect(mergeResult.success).toBe(false);
    expect(mergeResult.merged).toBe(false);
    expect(mergeResult.partial).toBe(false);
    expect(mergeResult.error ?? '').toMatch(/web/);
    expect(mergeResult.message).toContain('Merge failed');

    // Api source repo must not have been advanced.
    const apiLog = execSync('git log --oneline', { cwd: path.join(testRoot, 'repos', 'api'), encoding: 'utf-8' }).trim().split('\n');
    expect(apiLog.length).toBe(1);
  });

  it('hive_merge (composite): partial mutation conflict returns success=false partial=true with successful repo retained', async () => {
    const feature = 'mr-merge-conflict';
    const { hooks, toolContext, repos } = await setupCompositeTaskWorktree(['api', 'web'], feature, 'sess_mr_merge_conflict');

    // Make a conflicting change in the web source repo on main (a file that the task will also touch).
    fs.writeFileSync(path.join(testRoot, 'repos', 'web', 'conflict.txt'), 'main version\n');
    execSync('git add conflict.txt && git commit -m "main-side conflict"', { cwd: path.join(testRoot, 'repos', 'web') });

    fs.writeFileSync(path.join(repos.api.path, 'api-ok.txt'), 'api ok\n');
    fs.writeFileSync(path.join(repos.web.path, 'conflict.txt'), 'task version\n');
    await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: '01-composite-task', status: 'completed', summary: 'Prepare composite conflict merge. Tests pass.' },
      toolContext,
    );

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: '01-composite-task', strategy: 'merge' },
      toolContext,
    );
    const mergeResult = JSON.parse(mergeRaw as string) as {
      success: boolean;
      merged: boolean;
      partial?: boolean;
      conflicts: string[];
      repos?: Record<string, { success: boolean; merged: boolean }>;
    };

    expect(mergeResult.success).toBe(false);
    expect(mergeResult.merged).toBe(false);
    expect(mergeResult.partial).toBe(true);
    expect(mergeResult.repos).toBeDefined();
    expect(mergeResult.repos!.api.merged).toBe(true);
    expect(mergeResult.repos!.web.merged).toBe(false);
    expect(mergeResult.conflicts.some((c) => c.startsWith('web:'))).toBe(true);
  });

  it('hive_merge (composite): rebase with custom message is rejected before mutating any repo', async () => {
    const feature = 'mr-merge-rebase-reject';
    const { hooks, toolContext, repos } = await setupCompositeTaskWorktree(['api', 'web'], feature, 'sess_mr_merge_rebase_reject');

    fs.writeFileSync(path.join(repos.api.path, 'api-r.txt'), 'api r\n');
    fs.writeFileSync(path.join(repos.web.path, 'web-r.txt'), 'web r\n');
    await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: '01-composite-task', status: 'completed', summary: 'Prepare composite rebase rejection. Tests pass.' },
      toolContext,
    );

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: '01-composite-task', strategy: 'rebase', message: 'feat: custom\n\nbody' },
      toolContext,
    );
    const mergeResult = JSON.parse(mergeRaw as string) as {
      success: boolean;
      merged: boolean;
      partial?: boolean;
      error?: string;
      message: string;
    };

    expect(mergeResult.success).toBe(false);
    expect(mergeResult.merged).toBe(false);
    // Rebase+message is rejected before composite/legacy split so `partial` is absent (not true).
    expect(mergeResult.partial).toBeFalsy();
    expect(mergeResult.error ?? '').toMatch(/Custom merge message is not supported for rebase/);

    // Neither source repo should have advanced.
    const apiLog = execSync('git log --oneline', { cwd: path.join(testRoot, 'repos', 'api'), encoding: 'utf-8' }).trim().split('\n');
    const webLog = execSync('git log --oneline', { cwd: path.join(testRoot, 'repos', 'web'), encoding: 'utf-8' }).trim().split('\n');
    expect(apiLog.length).toBe(1);
    expect(webLog.length).toBe(1);
  });

  // --- Task 10: final end-to-end smoke coverage ---

  it('end-to-end smoke: non-git workspace with project manifest and two child repos runs start -> commit -> merge with per-repo results', async () => {
    // Project root is a plain directory (no `git init`), declared composite via
    // a project-scoped manifest that points to two real child git repos.
    initBareRepo(path.join(testRoot, 'repos', 'api'));
    initBareRepo(path.join(testRoot, 'repos', 'web'));
    writeManifest(['api', 'web']);
    expect(fs.existsSync(path.join(testRoot, '.git'))).toBe(false);

    const feature = 'mr-e2e-non-git';
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_mr_e2e_non_git');

    await hooks.tool!.hive_feature_create.execute({ name: feature }, toolContext);
    const plan = `# ${feature}

## Discovery

**Q: ok?**
A: Yes, this regression test validates the full start -> commit -> merge composite path on a non-git project root that is declared multi-repo via a project-scoped manifest of two child repos.

## Tasks

### 1. Composite Task
**Repos**: api, web
Do it.
`;
    await hooks.tool!.hive_plan_write.execute({ content: plan, feature }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);

    // Start: composite mode, both repos resolved.
    const startRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature, task: '01-composite-task' },
      toolContext,
    );
    const start = JSON.parse(startRaw as string) as {
      success: boolean;
      worktreeMode: string;
      workspacePath: string;
      worktreePath: string;
      baseCommits: Record<string, string>;
      repos: Record<string, { path: string; branch: string; commit: string }>;
    };
    expect(start.success).toBe(true);
    expect(start.worktreeMode).toBe('composite');
    expect(start.workspacePath).toBe(start.worktreePath);
    expect(start.workspacePath).toContain(`.hive/.worktrees/${feature}/01-composite-task`);
    expect(Object.keys(start.repos).sort()).toEqual(['api', 'web']);
    expect(start.repos.api.path).toBe(path.join(start.workspacePath, 'repos', 'api'));
    expect(start.repos.web.path).toBe(path.join(start.workspacePath, 'repos', 'web'));
    expect(Object.keys(start.baseCommits).sort()).toEqual(['api', 'web']);

    // Stage changes in both composite repo worktrees.
    fs.writeFileSync(path.join(start.repos.api.path, 'api-e2e.txt'), 'api e2e\n');
    fs.writeFileSync(path.join(start.repos.web.path, 'web-e2e.txt'), 'web e2e\n');

    // Commit: aggregate success with per-repo entries and repo-qualified report files.
    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: '01-composite-task', status: 'completed', summary: 'Non-git composite e2e. Tests pass.' },
      toolContext,
    );
    const commit = JSON.parse(commitRaw as string) as {
      ok: boolean;
      terminal: boolean;
      taskState: string;
      reportPath: string;
      commit: { committed: boolean; partial?: boolean; repos: Record<string, { committed: boolean }> };
      nextAction?: string;
    };
    expect(commit.ok).toBe(true);
    expect(commit.terminal).toBe(true);
    expect(commit.taskState).toBe('done');
    expect(commit.commit.committed).toBe(true);
    expect(commit.commit.partial).toBeFalsy();
    expect(Object.keys(commit.commit.repos).sort()).toEqual(['api', 'web']);
    expect(commit.commit.repos.api.committed).toBe(true);
    expect(commit.commit.repos.web.committed).toBe(true);
    const report = fs.readFileSync(commit.reportPath, 'utf-8');
    expect(report).toContain('api:api-e2e.txt');
    expect(report).toContain('web:web-e2e.txt');
    expect(commit.nextAction).toContain('hive_merge');

    // Merge: aggregate success with per-repo entries and repoId-qualified filesChanged.
    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: '01-composite-task', strategy: 'merge' },
      toolContext,
    );
    const merge = JSON.parse(mergeRaw as string) as {
      success: boolean;
      merged: boolean;
      partial?: boolean;
      filesChanged: string[];
      repos: Record<string, { success: boolean; merged: boolean }>;
      message: string;
    };
    expect(merge.success).toBe(true);
    expect(merge.merged).toBe(true);
    expect(merge.partial).toBeFalsy();
    expect(Object.keys(merge.repos).sort()).toEqual(['api', 'web']);
    expect(merge.repos.api.merged).toBe(true);
    expect(merge.repos.web.merged).toBe(true);
    expect(merge.filesChanged).toContain('api:api-e2e.txt');
    expect(merge.filesChanged).toContain('web:web-e2e.txt');

    // Confirm both source repos advanced (e2e file landed on disk after merge).
    expect(fs.existsSync(path.join(testRoot, 'repos', 'api', 'api-e2e.txt'))).toBe(true);
    expect(fs.existsSync(path.join(testRoot, 'repos', 'web', 'web-e2e.txt'))).toBe(true);
  });

  it('end-to-end smoke: single-repo no-manifest legacy project completes start -> commit -> merge without composite fields', async () => {
    // Legacy single-root: project root is a git repo and there is NO project manifest.
    // Composite fields must NOT appear in any payload.
    initBareRepo(testRoot);
    const feature = 'legacy-e2e';
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_legacy_e2e');

    await hooks.tool!.hive_feature_create.execute({ name: feature }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      { content: createSingleTaskPlan('Legacy E2E', 'Yes, this regression test validates that legacy single-root projects (git project root, no repository manifest) keep the full start -> commit -> merge flow working without surfacing composite-only fields.'), feature },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);

    const startRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature, task: FIRST_TASK },
      toolContext,
    );
    const start = JSON.parse(startRaw as string) as {
      success: boolean;
      worktreeMode: string;
      worktreePath: string;
      workspacePath: string;
      repos?: unknown;
      baseCommits?: unknown;
    };
    expect(start.success).toBe(true);
    expect(start.worktreeMode).toBe('legacy');
    expect(start.repos).toBeUndefined();
    expect(start.baseCommits).toBeUndefined();
    expect(start.workspacePath).toBe(start.worktreePath);

    fs.writeFileSync(path.join(start.worktreePath, 'legacy-note.txt'), 'legacy e2e\n');

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: FIRST_TASK, status: 'completed', summary: 'Legacy single-root e2e. Tests pass.' },
      toolContext,
    );
    const commit = JSON.parse(commitRaw as string) as {
      ok: boolean;
      terminal: boolean;
      taskState: string;
      commit?: { repos?: unknown; partial?: unknown };
      nextAction?: string;
    };
    expect(commit.ok).toBe(true);
    expect(commit.terminal).toBe(true);
    expect(commit.taskState).toBe('done');
    // Legacy commit result must not surface composite-only fields.
    expect(commit.commit?.repos).toBeUndefined();
    expect(commit.commit?.partial).toBeUndefined();
    expect(commit.nextAction).toContain('hive_merge');

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: FIRST_TASK, strategy: 'merge' },
      toolContext,
    );
    const merge = JSON.parse(mergeRaw as string) as {
      success: boolean;
      merged: boolean;
      strategy: string;
      filesChanged: string[];
      partial?: unknown;
      repos?: unknown;
      message: string;
    };
    expect(merge.success).toBe(true);
    expect(merge.merged).toBe(true);
    expect(merge.strategy).toBe('merge');
    // Legacy merge result must not surface composite-only fields.
    expect(merge.partial).toBeUndefined();
    expect(merge.repos).toBeUndefined();
    // Files are plain repo-relative paths (no `repoId:` prefix) in legacy mode.
    expect(merge.filesChanged).toContain('legacy-note.txt');
    expect(merge.filesChanged.every((p) => !p.includes(':'))).toBe(true);

    // Project root advanced (legacy single-root merge landed file on disk).
    expect(fs.existsSync(path.join(testRoot, 'legacy-note.txt'))).toBe(true);
  });

  it('end-to-end smoke: non-git project with global config repositories but no project manifest fails manifest-required and never auto-selects', async () => {
    // No `git init` on testRoot, no project-scoped manifest.
    // testRoot doubles as HOME during this suite, so write a global config that
    // declares repositories. RepositoryService must ignore global manifests for
    // orchestration and the OpenCode resolver must fail loud with the explicit
    // manifest-required wording.
    expect(fs.existsSync(path.join(testRoot, '.git'))).toBe(false);
    initBareRepo(path.join(testRoot, 'repos', 'api'));
    const globalDir = path.join(testRoot, '.config', 'opencode');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'agent_hive.json'),
      JSON.stringify({ repositories: [{ id: 'api', path: path.join(testRoot, 'repos', 'api') }] }, null, 2),
    );

    const feature = 'no-manifest-global-ignored';
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_no_manifest_global_ignored');

    await hooks.tool!.hive_feature_create.execute({ name: feature }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      { content: createSingleTaskPlan('No Manifest Global Ignored', 'Yes, this regression test validates that non-git project roots without a project-scoped repository manifest fail with manifest-required wording even when a global ~/.config/opencode/agent_hive.json declares repositories, and that no fallback auto-selection of a global repo happens.'), feature },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);

    await expect(
      hooks.tool!.hive_worktree_start.execute({ feature, task: FIRST_TASK }, toolContext),
    ).rejects.toThrow(/Repository manifest is required/);

    // No worktree directory created under either the legacy or composite path.
    const worktreeRoot = path.join(testRoot, '.hive', '.worktrees', feature, FIRST_TASK);
    expect(fs.existsSync(worktreeRoot)).toBe(false);
  });
});
