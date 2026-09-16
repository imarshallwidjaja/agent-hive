import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { execSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PluginInput } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk";
import plugin from "../index";
import { QUEEN_BEE_PROMPT } from "../agents/hive";
import { ARCHITECT_BEE_PROMPT } from "../agents/architect";
import { SWARM_BEE_PROMPT } from "../agents/swarm";
import { FORAGER_BEE_PROMPT } from "../agents/forager";
import { HIVE_BUILDER_PROMPT } from "../agents/hive-builder";
import { HIVE_SYSTEM_PROMPT } from "../hooks/system-hook";
import { BUILTIN_SKILLS } from "../skills/registry.generated.js";
import { HIVE_COMMANDS } from '../commands/registry.js';
import { buildPluginManifest, HIVE_TOOL_NAMES, SUPPORTED_PLUGIN_HOOKS } from '../utils/plugin-manifest.js';
import { TASK_TRACE_SUMMARIZER_AGENT } from '../task-trace.js';
import { AdhocWorktreeService, ConfigService, ContextMutationError, ContextService, CUSTOM_AGENT_BASES, DEFAULT_ROUTING_AGENT_DESCRIPTIONS, ExecutionAttemptService, FeatureService, SessionService, resolveFeatureDirectoryName } from 'hive-core';

const OPENCODE_CLIENT = createOpencodeClient({ baseUrl: "http://localhost:1" }) as unknown as PluginInput["client"];
const ROOT_SESSION_CLIENT = {
  ...(OPENCODE_CLIENT as any),
  session: {
    ...(OPENCODE_CLIENT as any).session,
    get: async ({ path: inputPath }: { path: { id: string } }) => ({
      data: {
        id: inputPath.id,
        parentID: undefined,
        time: { created: Date.now(), updated: Date.now() },
      },
    }),
  },
} as PluginInput['client'];
type PluginHooks = Awaited<ReturnType<typeof plugin>>;

type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  abort: AbortSignal;
};

const EXPECTED_TOOLS = [...HIVE_TOOL_NAMES];

const removedHiveSkillTool = ['hive', 'skill'].join('_');

const UNSUPPORTED_RUNTIME_HOOKS = [
  "experimental.session.compacting",
] as const;

const REMOVED_PROJECTED_TODO_FIELD = ['todo', 'Projection'].join('');
const REMOVED_TODO_REFRESH_HINT = ['Refresh hive_status() before syncing OpenCode ', 'todos.'].join('');
const LEGACY_IDLE_CHILD_REPLAY = ['child-session', ' idle'].join('');

const TEST_ROOT_BASE = `/tmp/hive-e2e-plugin-${process.pid}`;
const TEST_PROCESS_CWD = process.cwd();
const FIRST_TASK = "01-first-task";
const TEST_COMMIT_MESSAGE = 'test: record task implementation\n\nRecord verified task work for the integration test.';
const TEST_MERGE_MESSAGE = 'test: integrate task implementation\n\nIntegrate verified task work as project history.';
const preparedStops = new WeakMap<ToolContext, {
  parentSessionID: string;
  childSessionID: string;
  callID: string;
  args: Record<string, unknown>;
}>();

function durableContext(body: string): string {
  return `---\ndescription: Managed context test fixture\nread_when: Read when exercising managed context behavior.\n---\n\n${body}`;
}

function projectContext(body: string): string {
  return `---\ndescription: Managed project context test fixture\nread_when: Read when exercising project context behavior.\nowner: platform\nreview_after: 2027-01-01\n---\n\n${body}`;
}

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
    agent: "hive-master",
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

function readGlobalSessionFeatureName(projectRoot: string, sessionID: string): string | undefined {
  const sessionsPath = path.join(projectRoot, '.hive', 'sessions.json');
  if (!fs.existsSync(sessionsPath)) return undefined;

  const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8')) as {
    sessions: Array<{ sessionId: string; featureName?: string }>;
  };
  return sessions.sessions.find((session) => session.sessionId === sessionID)?.featureName;
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

Interview summary: this fixture documents the operator decision, the requested behavior, and the files the worker may touch so the Discovery section stays long enough for plan admission.

**Research:** plugin-smoke.test.ts seeds this plan for an isolated worktree execution path.

## Tasks

### 1. First Task
Do it
`;
}

function createTwoTaskPlan(title: string, answer: string): string {
  return `# ${title}

## Discovery

**Q: Is this a test?**
A: ${answer}

Interview summary: this fixture documents two independent tasks so Discovery stays long enough for plan admission while merge serialization coverage stays intact.

**Research:** plugin-smoke.test.ts seeds this plan for destination-lock and worktree-claim tests.

## Tasks

### 1. First Task
Do it

### 2. Second Task
Do it too
`;
}

async function seedApprovedFeature(
  hooks: PluginHooks,
  toolContext: ToolContext,
  feature: string,
  plan: string,
): Promise<void> {
  await hooks.tool!.hive_feature_create.execute({ name: feature }, toolContext);
  await hooks.tool!.hive_plan_write.execute({ content: plan, feature }, toolContext);
  await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
  await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);
}

async function createHooksForTest(
  testRoot: string,
  sessionID: string,
  worktree = testRoot,
  client: PluginInput['client'] = ROOT_SESSION_CLIENT,
): Promise<{
  hooks: PluginHooks;
  toolContext: ToolContext;
}> {
  const ctx: PluginInput = {
    directory: testRoot,
    worktree,
    serverUrl: new URL("http://localhost:1"),
    project: createProject(worktree),
    client,
    $: createStubShell(),
  };
  const hooks = await plugin(ctx);
  await hooks['chat.message']?.({ sessionID, agent: 'hive-master' }, {
    message: { agent: 'hive-master' },
    parts: [],
  } as any);

  return {
    hooks,
    toolContext: createToolContext(sessionID),
  };
}

async function observeNativeTaskChild(
  hooks: PluginHooks,
  input: {
    parentSessionID: string;
    callID: string;
    childSessionID: string;
    expectedAgent?: string;
  },
): Promise<void> {
  await hooks.event?.({ event: { type: 'message.part.updated', properties: { part: {
    type: 'tool',
    tool: 'task',
    sessionID: input.parentSessionID,
    callID: input.callID,
    state: {
      input: input.expectedAgent ? { subagent_type: input.expectedAgent } : {},
      metadata: { sessionId: input.childSessionID },
    },
  } } } } as any);
}

async function runOpenCodeV114CommandPath(input: {
  hooks: PluginHooks;
  command: string;
  sessionID: string;
  arguments: string;
  template: string;
  cwd: string;
}): Promise<Array<{ type: 'text'; text: string }>> {
  const args = input.arguments.match(/(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi) ?? [];
  const placeholders = input.template.match(/\$(\d+)/g) ?? [];
  let last = 0;
  for (const placeholder of placeholders) {
    last = Math.max(last, Number(placeholder.slice(1)));
  }
  let template = input.template.replace(/\$(\d+)/g, (_match, index) => {
    const position = Number(index);
    const argumentIndex = position - 1;
    if (argumentIndex >= args.length) return '';
    return position === last ? args.slice(argumentIndex).join(' ') : args[argumentIndex];
  });
  if (!input.template.includes('$ARGUMENTS') && placeholders.length === 0 && input.arguments.trim()) {
    template = `${template}\n\n${input.arguments}`;
  }
  const shellMatches = [...template.matchAll(/!`([^`]+)`/g)];
  for (const match of shellMatches) {
    execSync(match[1], { cwd: input.cwd, stdio: 'ignore' });
  }

  const parts: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: template }];
  const commandBefore = (input.hooks as any)['command.execute.before'] as (hookInput: unknown, output: { parts: typeof parts }) => Promise<void>;
  await commandBefore({
    command: input.command,
    sessionID: input.sessionID,
    arguments: input.arguments,
  }, { parts } as any);
  return parts;
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

  const worktreeRaw = await prepareTaskExecution(hooks, { feature, task: FIRST_TASK }, toolContext);
  const { worktreePath } = JSON.parse(worktreeRaw as string) as {
    worktreePath: string;
  };

  return { hooks, toolContext, worktreePath };
}

async function prepareTaskExecution(
  hooks: PluginHooks,
  input: { feature: string; task: string },
  toolContext: ToolContext,
): Promise<string> {
  const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
    scope: { kind: 'task', feature: input.feature, task: input.task },
    placement: { kind: 'worktree' },
  }, toolContext) as string) as Record<string, any>;
  if (!prepared.success || prepared.placement?.kind !== 'worktree') return JSON.stringify(prepared);

  const parentSessionID = toolContext.sessionID;
  const childSessionID = `prepared-child-${randomUUID()}`;
  const callID = `prepared-call-${randomUUID()}`;
  const args = { subagent_type: 'forager-worker', description: 'Execute prepared integration fixture', prompt: 'Run the prepared task.' };
  await hooks['chat.message']?.({ sessionID: parentSessionID, agent: 'hive-master' }, {
    message: { agent: 'hive-master' }, parts: [],
  } as any);
  await hooks['tool.execute.before']!({ tool: 'task', sessionID: parentSessionID, callID }, { args });
  await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: childSessionID, parentID: parentSessionID } } } } as any);
  await observeNativeTaskChild(hooks, { parentSessionID, callID, childSessionID, expectedAgent: 'forager-worker' });
  await hooks['chat.message']!({ sessionID: childSessionID, agent: 'forager-worker' }, {
    message: { agent: 'forager-worker' }, parts: [],
  } as any);
  toolContext.sessionID = childSessionID;
  toolContext.agent = 'forager-worker';
  preparedStops.set(toolContext, { parentSessionID, childSessionID, callID, args });

  const workspacePath = prepared.placement.workspacePath as string;
  const workspaceManifestPath = path.join(workspacePath, 'workspace.json');
  const workspaceManifest = fs.existsSync(workspaceManifestPath)
    ? JSON.parse(fs.readFileSync(workspaceManifestPath, 'utf-8')) as {
        repos: Record<string, { path: string; branch: string; commit: string }>;
        baseCommits: Record<string, string>;
      }
    : undefined;
  const repos = workspaceManifest && Object.fromEntries(Object.entries(workspaceManifest.repos).map(([id, repo]) => [
    id,
    { ...repo, path: path.join(workspacePath, repo.path) },
  ]));
  return JSON.stringify({
    ...prepared,
    workspacePath,
    worktreePath: workspacePath,
    branch: prepared.placement.branch,
    commit: prepared.placement.baseCommit,
    worktreeMode: repos ? 'composite' : 'legacy',
    repos,
    baseCommits: workspaceManifest?.baseCommits,
  });
}

async function stopPreparedExecution(hooks: PluginHooks, toolContext: ToolContext): Promise<void> {
  const stop = preparedStops.get(toolContext);
  if (!stop) return;
  await hooks['tool.execute.after']!({
    tool: 'task', sessionID: stop.parentSessionID, callID: stop.callID, args: stop.args,
  } as any, { title: '', output: 'done', metadata: { sessionId: stop.childSessionID } });
  toolContext.sessionID = stop.parentSessionID;
  toolContext.agent = 'hive-master';
  preparedStops.delete(toolContext);
}

describe("e2e: opencode-hive plugin (in-process)", () => {
  let testRoot: string;
  let originalHome: string | undefined;
  let originalExperimentalBackgroundSubagents: string | undefined;
  let originalExperimental: string | undefined;

  beforeEach(() => {
    process.chdir(TEST_PROCESS_CWD);
    originalHome = process.env.HOME;
    originalExperimentalBackgroundSubagents = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    originalExperimental = process.env.OPENCODE_EXPERIMENTAL;
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    delete process.env.OPENCODE_EXPERIMENTAL;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, "project-"));
    process.env.HOME = testRoot;

    execSync("git init", { cwd: testRoot });
    execSync('git config user.email "test@example.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    fs.writeFileSync(path.join(testRoot, "README.md"), "smoke test");
    fs.writeFileSync(path.join(testRoot, '.gitignore'), '.hive/\n');
    execSync("git add README.md .gitignore", { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });
  }, 30_000);

  it('does not persist execution-attempt or session stores on empty plugin construct', async () => {
    await plugin({
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL('http://localhost:1'),
      project: createProject(testRoot),
      client: ROOT_SESSION_CLIENT,
      $: createStubShell(),
    });
    expect(fs.existsSync(path.join(testRoot, '.hive', 'execution-attempts.json'))).toBe(false);
    expect(fs.existsSync(path.join(testRoot, '.hive', 'sessions.json'))).toBe(false);
  });

  it('does not register hive_existing_workspace_start', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'missing-existing-workspace');
    expect(hooks.tool!.hive_existing_workspace_start).toBeUndefined();
    expect(HIVE_TOOL_NAMES).not.toContain('hive_existing_workspace_start');
  });

  it('keeps context CAS so one of two same-revision writers wins', async () => {
    const first = await createHooksForTest(testRoot, 'cas-a');
    const created = JSON.parse(await first.hooks.tool!.hive_context_write.execute({
      scope: 'project', name: 'cas-notes', content: projectContext('one'),
    }, first.toolContext) as string);
    const second = await createHooksForTest(testRoot, 'cas-b');
    const winner = JSON.parse(await first.hooks.tool!.hive_context_write.execute({
      scope: 'project', name: 'cas-notes', content: projectContext('two'),
      expectedRevision: created.revision, expectedContentHash: created.file.contentHash,
    }, first.toolContext) as string);
    const stale = JSON.parse(await second.hooks.tool!.hive_context_write.execute({
      scope: 'project', name: 'cas-notes', content: projectContext('three'),
      expectedRevision: created.revision, expectedContentHash: created.file.contentHash,
    }, second.toolContext) as string);
    expect(winner.success).toBe(true);
    expect(stale.success).toBe(false);
  });

  it('keeps canonical routing descriptions effective without persisting them during initialization', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_routing_defaults');
    const opencodeConfig: Record<string, any> = { agent: {} };

    await hooks.config!(opencodeConfig);

    const stored = JSON.parse(fs.readFileSync(
      path.join(testRoot, '.config', 'opencode', 'agent_hive.json'),
      'utf-8',
    ));
    for (const baseAgent of CUSTOM_AGENT_BASES) {
      expect(stored.agents?.[baseAgent]).not.toHaveProperty('description');
      expect(opencodeConfig.agent[baseAgent]?.description).toBe(
        DEFAULT_ROUTING_AGENT_DESCRIPTIONS[baseAgent],
      );
    }
  });

  afterEach(() => {
    process.chdir(TEST_PROCESS_CWD);
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalExperimentalBackgroundSubagents === undefined) {
      delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    } else {
      process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = originalExperimentalBackgroundSubagents;
    }
    if (originalExperimental === undefined) {
      delete process.env.OPENCODE_EXPERIMENTAL;
    } else {
      process.env.OPENCODE_EXPERIMENTAL = originalExperimental;
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
    expect(hooks.tool?.hive_existing_workspace_start).toBeUndefined();
    expect(HIVE_TOOL_NAMES).not.toContain(removedHiveSkillTool);
    expect(HIVE_TOOL_NAMES).not.toContain('hive_existing_workspace_start');

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
  }, 30_000);

  it("hive_plan_patch applies a bounded revision patch without returning full content", async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, "session-plan-patch");

    await hooks.tool!.hive_feature_create.execute({ name: "plan-patch-feature" }, toolContext);

    const plan = `# Patch Plan

## Discovery

This discovery section is intentionally long enough to satisfy the planning gate while testing bounded plan patch behavior through the OpenCode tool path.

## Design Summary

Keep the original design.

## Tasks

### 1. First Task
Do it
`;

    await hooks.tool!.hive_plan_write.execute({ content: plan, feature: "plan-patch-feature" }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature: "plan-patch-feature" }, toolContext);

    const beforeRead = JSON.parse(
      await hooks.tool!.hive_plan_read.execute({ feature: "plan-patch-feature" }, toolContext) as string,
    ) as { revision: string };

    const patchRaw = await hooks.tool!.hive_plan_patch.execute(
      {
        feature: "plan-patch-feature",
        expectedRevision: beforeRead.revision,
        operations: [
          {
            type: "replace_section",
            headingPath: ["Design Summary"],
            content: "## Design Summary\n\nUse the revised design.\n",
          },
        ],
      },
      toolContext,
    );
    const patchResult = JSON.parse(patchRaw as string) as {
      revision: string;
      contentHash: string;
      changedSections: string[];
      content?: string;
      nextAction: string;
    };

    expect(patchResult.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(patchResult.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(patchResult.contentHash).not.toBe(patchResult.revision);
    expect(patchResult.changedSections).toEqual(["Design Summary"]);
    expect(patchResult.content).toBeUndefined();
    expect(patchResult.nextAction).toContain("hive_tasks_sync({ refreshPending: true })");

    const afterRead = JSON.parse(
      await hooks.tool!.hive_plan_read.execute({ feature: "plan-patch-feature" }, toolContext) as string,
    ) as { content: string; status: string; revision: string };

    expect(afterRead.content).toContain("Use the revised design.");
    expect(afterRead.content).not.toContain("Keep the original design.");
    expect(afterRead.status).toBe("planning");
    expect(afterRead.revision).toBe(patchResult.revision);
  });

  it('rejects context writes for explicit missing features', async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_missing_context_feature');

    const output = await hooks.tool!.hive_context_write.execute(
      { feature: 'future-feature', name: 'draft', content: '# Draft' },
      toolContext,
    );

    expect(JSON.parse(output as string)).toMatchObject({
      success: false,
      terminal: true,
      reason: 'feature_not_found',
      error: "Feature 'future-feature' not found. Create it first with hive_feature_create.",
    });
    expect(fs.existsSync(path.join(testRoot, '.hive', 'features', 'future-feature'))).toBe(false);
  });

  it('writes an unbound root context to the sole live feature and binds the session', async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_sole_feature_owner');
    await hooks.tool!.hive_feature_create.execute({ name: 'sole-live-feature' }, toolContext);

    const unboundSessionID = 'sess_sole_feature_context_write';
    await hooks['chat.message']?.({ sessionID: unboundSessionID, agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    } as any);
    const output = await hooks.tool!.hive_context_write.execute(
      { name: 'notes', content: durableContext('# Sole feature notes') },
      createToolContext(unboundSessionID),
    );

    const result = JSON.parse(output as string) as { success: boolean; operation: string; revision: number; path: string };
    expect(result).toMatchObject({ success: true, operation: 'created', revision: 1 });
    expect(result.path).toContain(path.join('01_sole-live-feature', 'context', 'notes.md'));
    expect(fs.readFileSync(path.join(
      testRoot,
      '.hive',
      'features',
      '01_sole-live-feature',
      'context',
      'notes.md',
    ), 'utf-8')).toBe(durableContext('# Sole feature notes'));
    expect(readGlobalSessionFeatureName(testRoot, unboundSessionID)).toBe('sole-live-feature');
  });

  it('manages revisioned context and excludes evidence from status execution flags', async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_managed_context');
    await hooks.tool!.hive_feature_create.execute({ name: 'managed-context' }, toolContext);

    const created = JSON.parse(await hooks.tool!.hive_context_write.execute({
      feature: 'managed-context',
      name: 'verification-log',
      content: 'raw output',
      kind: 'evidence',
    }, toolContext) as string) as { revision: number };
    const read = JSON.parse(await hooks.tool!.hive_context_read.execute({
      feature: 'managed-context',
      name: 'verification-log',
    }, toolContext) as string) as { revision: number; file: { content: string; kind: string; contentHash: string } };
    expect(read).toMatchObject({ revision: created.revision, file: { content: 'raw output', kind: 'evidence' } });

    for (const output of [
      await hooks.tool!.hive_context_write.execute({
        feature: 'managed-context', name: 'verification-log', content: 'replacement', expectedRevision: read.revision,
      }, toolContext),
      await hooks.tool!.hive_context_append.execute({
        feature: 'managed-context', name: 'verification-log', content: 'missing hash', expectedRevision: read.revision,
      }, toolContext),
      await hooks.tool!.hive_context_archive.execute({
        feature: 'managed-context', names: ['verification-log'], reason: 'missing hash', expectedRevision: read.revision,
      }, toolContext),
    ]) {
      expect(JSON.parse(output as string)).toMatchObject({ success: false, reason: 'context_precondition_required' });
    }
    expect(fs.readFileSync(path.join(testRoot, '.hive/features/01_managed-context/context/verification-log.md'), 'utf8')).toBe('raw output');

    const appended = JSON.parse(await hooks.tool!.hive_context_append.execute({
      feature: 'managed-context',
      name: 'verification-log',
      content: 'more output',
      section: 'Retry',
      expectedRevision: read.revision,
      expectedContentHash: read.file.contentHash,
    }, toolContext) as string) as { success: boolean; revision: number };
    expect(appended).toMatchObject({ success: true, revision: 2 });

    const stale = JSON.parse(await hooks.tool!.hive_context_archive.execute({
      feature: 'managed-context',
      names: ['verification-log'],
      reason: 'superseded',
      expectedRevision: read.revision,
      expectedContentHashes: { 'verification-log': read.file.contentHash },
    }, toolContext) as string) as { success: boolean; reason: string };
    expect(stale).toMatchObject({ success: false, reason: 'stale_revision' });
    const blankReason = JSON.parse(await hooks.tool!.hive_context_archive.execute({
      feature: 'managed-context',
      names: ['verification-log'],
      reason: ' ',
      expectedRevision: appended.revision,
      expectedContentHashes: { 'verification-log': read.file.contentHash },
    }, toolContext) as string) as { success: boolean; reason: string; nextAction: string };
    expect(blankReason).toMatchObject({
      success: false,
      reason: 'invalid_archive_reason',
      nextAction: 'Retry hive_context_archive with a specific non-blank reason.',
    });
    const reservedKind = JSON.parse(await hooks.tool!.hive_context_write.execute({
      feature: 'managed-context',
      name: 'draft',
      content: 'scratchpad',
      kind: 'durable',
    }, toolContext) as string) as { success: boolean; reason: string; nextAction: string };
    expect(reservedKind).toMatchObject({
      success: false,
      reason: 'invalid_context_kind',
      nextAction: 'Omit kind for reserved names; otherwise use durable or evidence.',
    });

    const status = JSON.parse(await hooks.tool!.hive_status.execute({
      feature: 'managed-context',
    }, toolContext) as string) as {
      context: { revision: number; durable: { fileCount: number }; files: Array<{ kind?: string; includeInExecution: boolean }> };
    };
    expect(status.context.revision).toBe(2);
    expect(status.context.durable.fileCount).toBe(0);
    expect(status.context.files[0]).toMatchObject({ kind: 'evidence', includeInExecution: false });
  });

  it('reads feature and project context through bounded scoped views', async () => {
    const { hooks } = await createHooksForTest(
      testRoot,
      'sess_scoped_context',
      testRoot,
      ROOT_SESSION_CLIENT,
    );
    const toolContext = { ...createToolContext('sess_scoped_context'), agent: 'hive-master' };
    await hooks.tool!.hive_feature_create.execute({ name: 'scoped-context' }, toolContext);

    const featureCreated = JSON.parse(await hooks.tool!.hive_context_write.execute({
      feature: 'scoped-context',
      name: 'feature-notes',
      content: durableContext('feature fact'),
    }, toolContext) as string);
    const projectCreated = JSON.parse(await hooks.tool!.hive_context_write.execute({
      scope: 'project',
      name: 'project-notes',
      content: projectContext('é😀\n"\\'.repeat(1_000)),
    }, toolContext) as string);
    await hooks.tool!.hive_context_write.execute({
      scope: 'project',
      name: 'project-extra',
      content: projectContext('extra fact'),
    }, toolContext);
    const sessionsPath = path.join(testRoot, '.hive', 'sessions.json');
    const sessionsBeforeReads = fs.readFileSync(sessionsPath, 'utf8');
    expect(featureCreated).toMatchObject({ success: true, scope: { type: 'feature', featureName: 'scoped-context' } });
    expect(projectCreated).toMatchObject({ success: true, scope: { type: 'project' } });

    const summary = JSON.parse(await hooks.tool!.hive_context_read.execute({
      feature: 'scoped-context',
      scanChars: true,
    }, toolContext) as string);
    expect(summary).toMatchObject({
      success: true,
      scope: { type: 'feature', featureName: 'scoped-context' },
      durable: { fileCount: 1, charsMeasurement: 'current' },
    });

    const catalog = JSON.parse(await hooks.tool!.hive_context_read.execute({
      scope: 'project',
      view: 'catalog',
      query: 'project-notes',
      limit: 1,
    }, toolContext) as string);
    expect(catalog).toMatchObject({
      success: true,
      scope: { type: 'project' },
      files: [{ name: 'project-notes', owner: 'platform' }],
      complete: true,
      hasMore: false,
      searchedFields: ['name', 'description', 'read_when'],
    });
    expect(catalog.files[0].content).toBeUndefined();

    const firstPage = JSON.parse(await hooks.tool!.hive_context_read.execute({
      scope: 'project', view: 'catalog', limit: 1,
    }, toolContext) as string);
    expect(firstPage).toMatchObject({ success: true, complete: false, hasMore: true });
    expect(JSON.parse(await hooks.tool!.hive_context_read.execute({
      scope: 'project', view: 'catalog', query: 'different', cursor: firstPage.nextCursor,
    }, toolContext) as string)).toMatchObject({ success: false, reason: 'invalid_context_cursor' });
    await hooks.tool!.hive_context_write.execute({
      scope: 'project', name: 'project-later', content: projectContext('later fact'),
    }, toolContext);
    expect(JSON.parse(await hooks.tool!.hive_context_read.execute({
      scope: 'project', view: 'catalog', cursor: firstPage.nextCursor,
    }, toolContext) as string)).toMatchObject({ success: false, reason: 'stale_context_cursor' });

    const firstChunkRaw = await hooks.tool!.hive_context_read.execute({
      scope: 'project',
      name: 'project-notes',
      maxBytes: 2_048,
    }, toolContext) as string;
    const firstChunk = JSON.parse(firstChunkRaw);
    expect(Buffer.byteLength(firstChunkRaw, 'utf8')).toBeLessThanOrEqual(2_048);
    expect(firstChunk).toMatchObject({ success: true, complete: false, range: { startByte: 0 } });
    expect(firstChunk.file.content.length).toBeGreaterThan(0);

    const secondChunk = JSON.parse(await hooks.tool!.hive_context_read.execute({
      scope: 'project',
      name: 'project-notes',
      cursor: firstChunk.nextCursor,
      maxBytes: 2_048,
    }, toolContext) as string);
    expect(secondChunk.range.startByte).toBe(firstChunk.range.endByte);
    expect(firstChunk.nextOffset).toBeUndefined();
    let chunk = secondChunk;
    let reconstructed = firstChunk.file.content + chunk.file.content;
    while (!chunk.complete) {
      const raw = await hooks.tool!.hive_context_read.execute({
        scope: 'project', name: 'project-notes', cursor: chunk.nextCursor, maxBytes: 2_048,
      }, toolContext) as string;
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(2_048);
      const next = JSON.parse(raw);
      expect(next.success).toBe(true);
      expect(next.range.startByte).toBe(chunk.range.endByte);
      reconstructed += next.file.content;
      chunk = next;
    }
    const documentPath = path.join(testRoot, '.hive', 'context', 'project-notes.md');
    expect(reconstructed).toBe(fs.readFileSync(documentPath, 'utf8'));

    expect(fs.readFileSync(sessionsPath, 'utf8')).toBe(sessionsBeforeReads);
    const restarted = await createHooksForTest(testRoot, 'sess_scoped_context', testRoot, ROOT_SESSION_CLIENT);
    const sessionsBeforeRestartedReads = fs.readFileSync(sessionsPath, 'utf8');
    const readSpy = spyOn(ContextService.prototype, 'readContent');
    try {
      const envelope = JSON.parse(Buffer.from(firstChunk.nextCursor, 'base64url').toString());
      const payload = JSON.parse(envelope.payload);
      const forgedBinding = createHash('sha256').update(JSON.stringify([
        'sess_scoped_context', fs.realpathSync(testRoot), { type: 'project' }, 'project-extra',
      ])).digest('hex');
      for (const change of [
        { o: payload.o + 1 }, { v: 2 }, { r: payload.r + 1 },
        { s: 'a'.repeat(64) }, { h: 'b'.repeat(64) }, { b: forgedBinding },
      ]) {
        const changedPayload = { ...payload, ...change };
        const forged = Buffer.from(JSON.stringify({ ...envelope, payload: JSON.stringify(changedPayload) })).toString('base64url');
        const result = JSON.parse(await hooks.tool!.hive_context_read.execute({
          scope: 'project', name: 'b' in change ? 'project-extra' : 'project-notes', cursor: forged,
        }, toolContext) as string);
        expect(result).toMatchObject({ success: false, reason: 'context_cursor_stale' });
        expect(readSpy).not.toHaveBeenCalled();
      }
      expect(JSON.parse(await restarted.hooks.tool!.hive_context_read.execute({
        scope: 'project', name: 'project-notes', cursor: firstChunk.nextCursor,
      }, toolContext) as string)).toMatchObject({ success: false, reason: 'context_cursor_stale' });
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }

    for (const input of [
      { scope: 'project', name: 'project-extra', cursor: firstChunk.nextCursor },
      { feature: 'scoped-context', name: 'project-notes', cursor: firstChunk.nextCursor },
      { scope: 'project', name: 'project-notes', cursor: 'malformed!' },
      { scope: 'project', name: 'project-notes', cursor: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(firstChunk.nextCursor, 'base64url').toString()), v: 2 })).toString('base64url') },
    ]) {
      expect(JSON.parse(await hooks.tool!.hive_context_read.execute(input, toolContext) as string))
        .toMatchObject({ success: false, reason: 'context_cursor_stale' });
    }
    fs.appendFileSync(documentPath, '\nexternal edit');
    expect(JSON.parse(await hooks.tool!.hive_context_read.execute({
      scope: 'project', name: 'project-notes', cursor: firstChunk.nextCursor,
    }, toolContext) as string)).toMatchObject({ success: false, reason: 'context_changed_during_read' });
    const fresh = JSON.parse(await hooks.tool!.hive_context_read.execute({
      scope: 'project', name: 'project-notes', maxBytes: 2_048,
    }, toolContext) as string);
    expect(fresh).toMatchObject({ success: true, complete: false });
    expect(fresh.nextCursor).toBeString();
    const indexPath = path.join(testRoot, '.hive', 'context', 'index.json');
    const indexBytes = fs.readFileSync(indexPath, 'utf8');
    for (const changedIndex of [indexBytes + '\n', JSON.stringify({ ...JSON.parse(indexBytes), revision: JSON.parse(indexBytes).revision + 1 })]) {
      fs.writeFileSync(indexPath, changedIndex);
      expect(JSON.parse(await hooks.tool!.hive_context_read.execute({
        scope: 'project', name: 'project-notes', cursor: fresh.nextCursor,
      }, toolContext) as string)).toMatchObject({ success: false, reason: 'context_changed_during_read' });
    }
    fs.writeFileSync(indexPath, indexBytes);

    for (const input of [
      { scope: 'project', feature: 'scoped-context' },
      { scope: 'project', name: 'project-notes', query: 'project' },
      { scope: 'project', view: 'catalog', scanChars: true },
      { scope: 'project', view: 'catalog', limit: 1.5 },
      { scope: 'project', name: 'project-notes', offset: 4 },
    ]) {
      expect(JSON.parse(await hooks.tool!.hive_context_read.execute(input, toolContext) as string)).toMatchObject({
        success: false,
        reason: 'invalid_argument',
      });
    }
    expect(JSON.parse(await hooks.tool!.hive_context_write.execute({
      scope: 'project',
      feature: 'scoped-context',
      task: FIRST_TASK,
      name: 'rejected',
      content: projectContext('must not persist'),
    }, toolContext) as string)).toMatchObject({ success: false, reason: 'invalid_argument' });
    expect(fs.existsSync(path.join(testRoot, '.hive', 'context', 'rejected.md'))).toBe(false);
    expect(fs.readFileSync(sessionsPath, 'utf8')).toBe(sessionsBeforeRestartedReads);
  });

  it('returns management-only recovery diagnostics for invalid context control state', async () => {
    const { hooks } = await createHooksForTest(
      testRoot,
      'sess_context_recovery',
      testRoot,
      ROOT_SESSION_CLIENT,
    );
    const toolContext = { ...createToolContext('sess_context_recovery'), agent: 'hive-master' };
    await hooks.tool!.hive_context_write.execute({
      scope: 'project',
      name: 'recovery-notes',
      content: projectContext('preserve this body'),
    }, toolContext);
    const markerPath = path.join(testRoot, '.hive', 'context', '.managed-mutation-pending.json');
    fs.writeFileSync(markerPath, JSON.stringify({
      schemaVersion: 1,
      operation: 'replace',
      names: ['recovery-notes'],
      archiveDestinations: [],
      startedAt: new Date().toISOString(),
      startingRevision: 1,
      startingIndexDigest: 'test-digest',
    }));
    const pending = JSON.parse(await hooks.tool!.hive_context_read.execute({
      scope: 'project',
    }, toolContext) as string);
    expect(pending).toMatchObject({
      success: false,
      reason: 'context_reconciliation_required',
      recovery: { code: 'context_reconciliation_required', pendingMutation: { operation: 'replace' } },
    });
    fs.rmSync(markerPath);
    fs.writeFileSync(path.join(testRoot, '.hive', 'context', 'index.json'), '{ invalid');

    const summary = JSON.parse(await hooks.tool!.hive_context_read.execute({
      scope: 'project',
    }, toolContext) as string);
    expect(summary).toMatchObject({
      success: false,
      terminal: false,
      reason: 'context_index_invalid',
      recovery: {
        code: 'context_index_invalid',
        control: { indexPresent: true },
        totalFiles: 1,
      },
    });
    expect(summary.nextAction).toContain('out of band');

    const named = JSON.parse(await hooks.tool!.hive_context_read.execute({
      scope: 'project',
      name: 'recovery-notes',
      maxBytes: 2_048,
    }, toolContext) as string);
    expect(named).toMatchObject({
      success: true,
      diagnostic: true,
      file: { name: 'recovery-notes', content: projectContext('preserve this body') },
    });
  });

  it('validates supplied context task metadata against exact existing task folders', async () => {
    const feature = 'context-task-validation';
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_context_task_validation');
    await hooks.tool!.hive_feature_create.execute({ name: feature }, toolContext);

    const beforeTasks = JSON.parse(await hooks.tool!.hive_context_write.execute({
      feature,
      name: 'planning-notes',
      content: durableContext('Created before tasks exist.'),
    }, toolContext) as string) as { success: boolean; revision: number };
    expect(beforeTasks.success).toBe(true);

    await hooks.tool!.hive_plan_write.execute({
      feature,
      content: createSingleTaskPlan(
        'Context Task Validation',
        'This regression validates exact task-folder metadata without breaking context creation before task sync.',
      ),
    }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);

    const accepted = JSON.parse(await hooks.tool!.hive_context_write.execute({
      feature,
      name: 'task-notes',
      content: durableContext('Owned by the exact task folder.'),
      task: FIRST_TASK,
    }, toolContext) as string) as { success: boolean; revision: number; file: { task?: string; contentHash: string } };
    expect(accepted).toMatchObject({ success: true, file: { task: FIRST_TASK } });

    for (const task of ['First Task', '1', '99-unknown-task']) {
      const rejected = JSON.parse(await hooks.tool!.hive_context_write.execute({
        feature,
        name: `rejected-${task.replace(/\W+/g, '-').toLowerCase()}`,
        content: 'must not persist',
        task,
      }, toolContext) as string) as {
        success: boolean;
        reason: string;
        error: string;
        task: string;
        availableTasks: string[];
      };
      expect(rejected).toMatchObject({
        success: false,
        reason: 'invalid_argument',
        task,
        availableTasks: [FIRST_TASK],
      });
      expect(rejected.error).toContain('exact existing task folder');
    }

    const appended = JSON.parse(await hooks.tool!.hive_context_append.execute({
      feature,
      name: 'task-notes',
      content: 'Exact-folder append.',
      task: FIRST_TASK,
      expectedRevision: accepted.revision,
      expectedContentHash: accepted.file.contentHash,
    }, toolContext) as string) as { success: boolean; revision: number; file: { contentHash: string } };
    expect(appended.success).toBe(true);

    const rejectedAppend = JSON.parse(await hooks.tool!.hive_context_append.execute({
      feature,
      name: 'task-notes',
      content: 'must not persist',
      task: '1',
      expectedRevision: appended.revision,
      expectedContentHash: appended.file.contentHash,
    }, toolContext) as string) as { success: boolean; reason: string; error: string };
    expect(rejectedAppend).toMatchObject({ success: false, reason: 'invalid_argument' });
    expect(rejectedAppend.error).toContain('exact existing task folder');

    const reserved = JSON.parse(await hooks.tool!.hive_context_write.execute({
      feature,
      name: 'overview',
      content: 'Reserved context remains compatible.',
    }, toolContext) as string) as { success: boolean };
    expect(reserved.success).toBe(true);
  });

  it('leaves draft cleanup explicit after successful plan approval', async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_draft_archive');
    await hooks.tool!.hive_feature_create.execute({ name: 'draft-archive' }, toolContext);
    await hooks.tool!.hive_context_write.execute({
      feature: 'draft-archive',
      name: 'draft',
      content: 'planning scratchpad',
    }, toolContext);
    const planOutput = await hooks.tool!.hive_plan_write.execute({
      feature: 'draft-archive',
      content: createSingleTaskPlan(
        'Draft Archive',
        'Approval persists independently from optional draft cleanup so an archival failure cannot misreport the completed approval.',
      ),
    }, toolContext);
    expect(planOutput).toContain('Plan written');

    const output = await hooks.tool!.hive_plan_approve.execute({ feature: 'draft-archive' }, toolContext);

    expect(output).toContain('Draft cleanup is explicit');
    expect(fs.readFileSync(
      path.join(testRoot, '.hive', 'features', '01_draft-archive', 'context', 'draft.md'),
      'utf-8',
    )).toBe('planning scratchpad');
    expect(new FeatureService(testRoot).get('draft-archive')?.status).toBe('approved');
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

    expect(pluginJson).toEqual(expectedManifest);
    expect(pluginJson.tools).not.toContain(removedHiveSkillTool);
    expect(pluginJson.commands.map((entry) => entry.name)).not.toContain('/hive');
    expect(new Set(pluginJson.commands.map((entry) => entry.name)).size).toBe(pluginJson.commands.length);
  });

  it('ships plugin.json in the npm package manifest allowlist', () => {
    const packageJsonPath = path.resolve(import.meta.dir, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      files?: string[];
    };

    expect(packageJson.files).toContain('plugin.json');
  });

  it('documents exact task-folder metadata and bounds archive requests', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_context_tool_descriptions');
    const tools = hooks.tool as unknown as Record<string, {
      description?: string;
      args?: { names?: { safeParse(value: unknown): { success: boolean } } };
    }>;

    expect(tools.hive_context_write.description).toContain('exact existing task folder');
    expect(tools.hive_context_append.description).toContain('exact existing task folder');
    expect(tools.hive_context_archive.args?.names?.safeParse(Array(50).fill('notes')).success).toBe(true);
    expect(tools.hive_context_archive.args?.names?.safeParse(Array(51).fill('notes')).success).toBe(false);
  });

  it('registers task trace tools and a hidden tool-less recovery summarizer', async () => {
    const configDir = path.join(testRoot, '.config', 'opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'agent_hive.json'), JSON.stringify({
      taskTraceSummarizer: { model: 'provider/model', variant: 'high', temperature: 0.2 },
    }));
    const { hooks } = await createHooksForTest(testRoot, 'sess_trace_config');
    const opencodeConfig: Record<string, any> = {};

    await hooks.config!(opencodeConfig);

    expect(hooks.tool).toHaveProperty('hive_task_trace');
    expect(hooks.tool).toHaveProperty('hive_task_trace_content');
    expect(opencodeConfig.agent[TASK_TRACE_SUMMARIZER_AGENT]).toMatchObject({
      mode: 'primary',
      hidden: true,
      model: 'provider/model',
      variant: 'high',
      temperature: 0.2,
      permission: { '*': 'deny', task: 'deny' },
    });
    const prompt = opencodeConfig.agent[TASK_TRACE_SUMMARIZER_AGENT].prompt;
    expect(prompt).toContain('plaintext reasoning');
    expect(prompt).toContain('may restate it');
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain("agent's assistant response");
    expect(prompt).toContain('kind: "map"');
    expect(prompt).toContain('kind: "reduce"');
    expect(prompt).toContain('basis');
    expect(prompt).toContain('intent');
    expect(prompt).toContain('actions');
    expect(prompt).toContain('findings');
    expect(prompt).toContain('outcome');
    expect(prompt).toContain('unresolved');
    expect(prompt).toContain('1-12 contiguous');
    expect(prompt).toContain('source coverage, not evidence or proof');
    expect(prompt).toContain('opaque reasoning');
    expect(prompt).toContain('Use basis "observed" only when observed source exists');
    expect(prompt).toContain('Use "mixed" only when both channels exist');
    expect(prompt).toContain('An entirely empty card is invalid when visible observed or plaintext reasoning source exists');
    expect(prompt).toContain('read/search completed');
    expect(prompt).toContain('launch_fresh_task');
    expect(prompt).toContain('review_completed_work');
    expect(prompt).toContain('safest_next_action');
    expect(prompt).not.toContain('reasoning_part_ids');
    expect(Object.values(opencodeConfig.agent[TASK_TRACE_SUMMARIZER_AGENT].tools)).not.toContain(true);
  });

  it('explicitly rejects native task dispatch to the hidden trace summarizer', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_trace_dispatch');
    await expect(hooks['tool.execute.before']?.(
      { tool: 'task', sessionID: 'sess_trace_dispatch', callID: 'trace-dispatch' },
      { args: { subagent_type: TASK_TRACE_SUMMARIZER_AGENT, prompt: 'bypass' } } as any,
    )).rejects.toThrow('task trace summarizer cannot be dispatched');
  });

  it('adds a parent-visible trace hint only from native task session metadata', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_trace_hint');
    const output = { title: 'task', output: '', metadata: { sessionId: 'child-session' } };

    await hooks['tool.execute.after']?.({
      tool: 'task',
      sessionID: 'sess_trace_hint',
      callID: 'trace-hint',
      args: { subagent_type: 'scout-researcher' },
    }, output);

    expect(output.output).toContain('hive_task_trace({ task_id: "child-session" })');

    const noMetadata = { title: 'task', output: 'child-session', metadata: {} };
    await hooks['tool.execute.after']?.({
      tool: 'task',
      sessionID: 'sess_trace_hint',
      callID: 'trace-no-hint',
      args: { subagent_type: 'scout-researcher' },
    }, noMetadata);
    expect(noMetadata.output).toBe('child-session');
  });

  it('registers every registry command on hooks.command and returns string guidance', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_command_hooks');
    const commandHooks = (hooks as PluginHooks & {
      command: Record<string, { description: string; run: (args: string) => string }>;
    }).command;

    const registryKeys = HIVE_COMMANDS.map((command) => command.key);
    expect(Object.keys(commandHooks).sort()).toEqual([...registryKeys].sort());
    expect(commandHooks.hive).toBeUndefined();

    for (const command of HIVE_COMMANDS) {
      const handler = commandHooks[command.key];
      expect(handler.description).toBe(command.description);
      const output = handler.run('smoke args');
      expect(typeof output).toBe('string');
      expect(output.trim()).not.toBe('');
    }
  });

  it('injects every registry command into OpenCode config.command for slash command loading', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_config_commands');
    const opencodeConfig: Record<string, unknown> = {};

    await hooks.config!(opencodeConfig);

    const configCommands = opencodeConfig.command as Record<string, { description?: string; template?: string; agent?: string }>;
    const registryKeys = HIVE_COMMANDS.map((command) => command.key);

    expect(Object.keys(configCommands).sort()).toEqual([...registryKeys].sort());
    expect(configCommands.hive).toBeUndefined();

    for (const command of HIVE_COMMANDS) {
      const configCommand = configCommands[command.key];
      expect(configCommand.description).toBe(command.description);
      expect(configCommand.template).not.toMatch(/^Mode:/m);
      expect(configCommand.template).not.toMatch(/^Route:/m);
    }

    expect(configCommands.interview.template).toContain('$ARGUMENTS');
    expect(configCommands.grill.template).toContain('$ARGUMENTS');
    expect(configCommands.grill.template).toContain('Load the `grilling` skill');
    for (const command of ['interview', 'grill'] as const) {
      expect(configCommands[command].template).toContain('settled operator items');
      expect(configCommands[command].template).toContain('confirmed alignment ends the interaction');
      expect(configCommands[command].template).toContain('named destination authorizes writing only the confirmed alignment brief there');
    }
    expect(configCommands.council.template).toContain('Runtime arguments: $ARGUMENTS');
    expect(configCommands.council.template).toContain('Only --group <group> selects a non-default group');
    expect(configCommands.council.template).toContain('## Council Result');
    expect(configCommands.council.template).toContain('## Disagreement');
    expect(configCommands.council.template).toContain('Use only councillors resolved for this run from configured groups');
    expect(configCommands.council.template).not.toContain('Group: decision');
    expect(configCommands.council.template).not.toContain('Directive: $ARGUMENTS');
    expect(configCommands.council.template).not.toContain('forager-smart');
  });

  it('binds dash-review through config.command to the dedicated review orchestrator', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_dash_review_command');
    const opencodeConfig: Record<string, unknown> = {};

    await hooks.config!(opencodeConfig);

    const configCommands = opencodeConfig.command as Record<string, { agent?: string; template?: string }>;
    const agents = opencodeConfig.agent as Record<string, {
      mode?: string;
      hidden?: boolean;
    }>;
    const dashPrimary = agents['__hive_dash_review_primary'];

    expect(configCommands['dash-review'].agent).toBe('__hive_dash_review_primary');
    expect(configCommands['dash-review'].template).toContain('no implementation files');
    expect(configCommands['dash-review'].template).toContain('hive_review_workspace_claim');
    expect(configCommands['dash-review'].template).toContain('dispatches deep lanes only after claim');
    expect(dashPrimary).toBeDefined();
    expect(dashPrimary.mode).toBe('primary');
    expect(dashPrimary.hidden).toBe(true);
  });

  it('binds vuln-review to its hidden primary and generated manifest contract', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_vuln_review_command');
    const opencodeConfig: Record<string, unknown> = {};
    await hooks.config!(opencodeConfig);

    const commands = opencodeConfig.command as Record<string, { agent?: string; template?: string }>;
    const agents = opencodeConfig.agent as Record<string, { mode?: string; hidden?: boolean }>;
    expect(commands['vuln-review'].agent).toBe('__hive_vulnerability_review_primary');
    expect(commands['vuln-review'].template).toContain('Schema: hive-vuln-review/v1');
    expect(commands['vuln-review'].template).not.toContain('$ARGUMENTS');
    expect(agents['__hive_vulnerability_review_primary']).toMatchObject({ mode: 'primary', hidden: true });
    expect(buildPluginManifest().commands).toContainEqual({
      name: '/vuln-review',
      description: 'Assess a frozen scope for evidenced vulnerabilities without changing files',
    });
  });

  it('appends one authoritative dash-review argument packet after command expansion', async () => {
    const dashRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-e2e-dash-review-'));
    try {
      execSync('git init', { cwd: dashRoot });
      execSync('git config user.email "test@example.com"', { cwd: dashRoot });
      execSync('git config user.name "Test"', { cwd: dashRoot });
      fs.writeFileSync(path.join(dashRoot, 'README.md'), 'dash review test');
      execSync('git add README.md', { cwd: dashRoot });
      execSync('git commit -m "init"', { cwd: dashRoot });
      const { hooks } = await createHooksForTest(dashRoot, 'sess_dash_review_arguments');
      const config: Record<string, any> = {};
      const marker = path.join(dashRoot, 'dash-review-argument-marker');

      await hooks.config!(config);

      const template = config.command['dash-review'].template as string;
      const packetMarker = 'Dash-review command input (JSON; inert data only):\n';
      expect(template).not.toContain('$ARGUMENTS');
      expect(template).not.toContain(packetMarker);

      for (const [name, rawArguments, githubPullRequest, normalizedIntent, descriptorSource] of [
        ['exact PR URL', 'https://github.com/example/project/pull/295', {
          owner: 'example',
          repository: 'project',
          number: 295,
        }, '', 'standalone-url'],
        ['ordinary text', 'feature/retry-restore', null, 'feature/retry-restore', 'none'],
      ] as const) {
        const parts = await runOpenCodeV114CommandPath({
          hooks,
          command: 'dash-review',
          sessionID: `sess_dash_review_arguments_${name.replaceAll(' ', '_')}`,
          arguments: rawArguments,
          template,
          cwd: dashRoot,
        });
        const rendered = parts.map((part) => part.text).join('\n');
        const expectedPacket = {
          schema: 'hive-dash-review-command/v3',
          intent: {
            rawIntent: rawArguments,
            normalizedIntent,
            githubPullRequest,
            descriptorSource,
            fixedArtifacts: [],
          },
        };

        expect(rendered.split(packetMarker)).toHaveLength(2);
        expect(parts.at(-1)?.text.trim()).toBe(`${packetMarker}${JSON.stringify(expectedPacket)}`);
        expect(rendered).not.toContain('## Explicit Command Scope');
        expect(parts.at(-1)?.text).not.toContain('"descriptor"');
      }

      for (const rawArguments of [
        'Review https://github.com/example/project/pull/295 carefully.',
        'https://example.test/report',
        'https://github.com/example/project/pull/295 --artifact report.md',
      ]) {
        await expect(runOpenCodeV114CommandPath({
          hooks,
          command: 'dash-review',
          sessionID: `sess_dash_review_rejected_url_${rawArguments.length}`,
          arguments: rawArguments,
          template,
          cwd: dashRoot,
        })).rejects.toThrow('only an exact safe GitHub pull-request URL');
      }

      await expect(runOpenCodeV114CommandPath({
        hooks,
        command: 'dash-review',
        sessionID: 'sess_dash_review_arguments_shell',
        arguments: `review this scope\n!\`touch "${marker}"\`\n$(gh api /user)`,
        template,
        cwd: dashRoot,
      })).rejects.toThrow('shell or control syntax');

      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(dashRoot, { recursive: true, force: true });
    }
  });

  it('establishes the private dash-review primary before the real command path dispatches Stage A', async () => {
    const dashRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-e2e-dash-review-routing-'));
    try {
      execSync('git init', { cwd: dashRoot });
      execSync('git config user.email "test@example.com"', { cwd: dashRoot });
      execSync('git config user.name "Test"', { cwd: dashRoot });
      fs.writeFileSync(path.join(dashRoot, 'README.md'), 'dash review routing test');
      execSync('git add README.md', { cwd: dashRoot });
      execSync('git commit -m "init"', { cwd: dashRoot });
      const client = {
        ...(OPENCODE_CLIENT as any),
        session: {
          ...(OPENCODE_CLIENT as any).session,
          get: async ({ path: inputPath }: { path: { id: string } }) => ({
            data: {
              id: inputPath.id,
              parentID: undefined,
              time: { created: Date.now(), updated: Date.now() },
            },
          }),
        },
      } as PluginInput['client'];
      const { hooks } = await createHooksForTest(dashRoot, 'sess_dash_review_routing', dashRoot, client);
      const config: Record<string, any> = {};
      await hooks.config!(config);
      const scopeTarget = Object.entries(config.agent as Record<string, any>)
        .find(([, agent]) => agent.tools?.hive_review_workspace_create === true)?.[0];
      expect(scopeTarget).toBeString();

      await runOpenCodeV114CommandPath({
        hooks,
        command: 'dash-review',
        sessionID: 'sess_dash_review_routing',
        arguments: 'https://github.com/example/project/pull/295',
        template: config.command['dash-review'].template,
        cwd: dashRoot,
      });

      await expect(hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: 'sess_dash_review_routing',
        callID: 'stage-a-dispatch',
      } as any, {
        args: {
          description: 'Resolve the command-bound review source',
          prompt: 'Use only runtime-owned command state.',
          subagent_type: scopeTarget,
          background: false,
        },
      } as any)).resolves.toBeUndefined();
    } finally {
      fs.rmSync(dashRoot, { recursive: true, force: true });
    }
  });

  it('keeps vuln-review shell-shaped arguments inert and appends canonical parsed data', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-e2e-vuln-review-'));
    try {
      execSync('git init', { cwd: root });
      execSync('git config user.email "test@example.com"', { cwd: root });
      execSync('git config user.name "Test"', { cwd: root });
      fs.writeFileSync(path.join(root, 'README.md'), 'vulnerability review test');
      execSync('git add README.md', { cwd: root });
      execSync('git commit -m "init"', { cwd: root });
      const { hooks } = await createHooksForTest(root, 'sess_vuln_review_arguments');
      const config: Record<string, any> = {};
      const marker = path.join(root, 'vuln-review-argument-marker');
      const rawArguments = `--path '!\`touch "${marker}"\`' --repo root`;
      await hooks.config!(config);

      const parts = await runOpenCodeV114CommandPath({
        hooks,
        command: 'vuln-review',
        sessionID: 'sess_vuln_review_arguments',
        arguments: rawArguments,
        template: config.command['vuln-review'].template,
        cwd: root,
      });
      const appended = parts.map((part) => part.text).join('\n');
      const normalizedPath = `!\`touch "${marker}"\``;
      const fixedOverrides = {
        repositoryIds: ['root'],
        paths: [normalizedPath],
      };
      expect(fs.existsSync(marker)).toBe(false);
      expect(appended).toContain(`Review intent packet (JSON): ${JSON.stringify({
        rawIntent: rawArguments,
        normalizedIntent: '',
        githubPullRequest: null,
        descriptorSource: 'none',
        fixedArtifacts: [],
      })}`);
      expect(appended).toContain(`Fixed overrides (JSON): ${JSON.stringify(fixedOverrides)}`);
      expect(parts.at(-1)?.text).not.toContain('current-change');
      expect(appended).not.toContain('Normalized flags:');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves existing non-Hive OpenCode config commands while injecting Hive commands', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_existing_config_commands');
    const existingCommand = {
      description: 'Existing operator command',
      template: 'Keep this command intact.',
    };
    const opencodeConfig: Record<string, unknown> = {
      command: {
        hive: existingCommand,
        'user-check': existingCommand,
      },
    };

    await hooks.config!(opencodeConfig);

    const configCommands = opencodeConfig.command as Record<string, { description?: string; template?: string }>;
    expect(configCommands.hive).toEqual(existingCommand);
    expect(configCommands['user-check']).toEqual(existingCommand);
    expect(configCommands.interview.description).toBe('Clarify an idea toward a reliable implementation-brief handoff');
    expect(configCommands.grill.description).toBe('Reach explicit alignment on any supplied context');
  });

  it('sanitizes configured council groups in OpenCode command templates', async () => {
    const configPath = path.join(process.env.HOME || '', '.config', 'opencode', 'agent_hive.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        customAgents: {
          'reviewer-example-template': {
            baseAgent: 'code-reviewer',
            description: 'Example template only: rename before use.',
            autoLoadSkills: [],
          },
        },
        council: {
          defaultGroup: 'review',
          groups: {
            review: {
              description: 'Review group with bad members',
              members: [
                'forager-worker',
                'hive-builder',
                'reviewer-example-template',
                'missing-agent',
                'scout-researcher',
                'scout-researcher',
                'code-reviewer',
              ],
            },
          },
        },
      }),
    );
    const { hooks } = await createHooksForTest(testRoot, 'sess_sanitized_council_commands');
    const opencodeConfig: Record<string, unknown> = {};

    await hooks.config!(opencodeConfig);

    const configCommands = opencodeConfig.command as Record<string, { description?: string; template?: string }>;
    const councilTemplate = configCommands.council.template ?? '';

    expect(councilTemplate).toContain('review: Review group with bad members; usable members: scout-researcher (scout-researcher), code-reviewer (code-reviewer)');
    expect(councilTemplate).toContain('warnings:');
    expect(councilTemplate).toContain('Do not add unavailable, excluded, template-placeholder, mutable-base, or duplicate councillors back into the run.');
    expect(councilTemplate).not.toContain('usable members: forager-worker');
    expect(councilTemplate).not.toContain('usable members: hive-builder');
    expect(councilTemplate).not.toContain('usable members: reviewer-example-template');
  });

  it('renders no-usable configured council groups as stop conditions in command templates', async () => {
    const configPath = path.join(process.env.HOME || '', '.config', 'opencode', 'agent_hive.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        council: {
          defaultGroup: 'empty',
          groups: {
            empty: {
              description: 'No usable seats',
              members: ['forager-worker', 'hive-builder'],
            },
          },
        },
      }),
    );
    const { hooks } = await createHooksForTest(testRoot, 'sess_no_usable_council_commands');
    const opencodeConfig: Record<string, unknown> = {};

    await hooks.config!(opencodeConfig);

    const configCommands = opencodeConfig.command as Record<string, { description?: string; template?: string }>;
    const councilTemplate = configCommands.council.template ?? '';

    expect(councilTemplate).toContain('empty: No usable seats; usable members: none usable');
    expect(councilTemplate).toContain('error: No usable council members remain for requested group empty.');
    expect(councilTemplate).toContain('If the selected group has no usable councillors, stop and report the resolver warnings instead of running council.');
    expect(councilTemplate).toContain('When the selected group has usable councillors, run a read-only council');
    expect(councilTemplate).toContain('When usable councillors are resolved and council runs, use this output format:');
    expect(councilTemplate).not.toContain('- Run a read-only council with the resolved councillors');
    expect(councilTemplate).not.toContain('- Council synthesis with recommendation');
  });

  it('returns sorted live candidates and performs no mutation when feature resolution is ambiguous', async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_ambiguous_feature');
    await hooks.tool!.hive_feature_create.execute({ name: 'zeta-feature' }, toolContext);
    await hooks.tool!.hive_feature_create.execute({ name: 'alpha-feature' }, toolContext);

    const output = await hooks.tool!.hive_plan_write.execute(
      {
        content: createSingleTaskPlan(
          'Ambiguous Plan',
          'This integration test verifies that repository ambiguity returns every live candidate and never selects or mutates one implicitly.',
        ),
      },
      toolContext,
    );

    expect(output).toContain('Multiple live features found: alpha-feature, zeta-feature');
    expect(output).toContain('explicit `feature` argument');
    expect(fs.existsSync(path.join(testRoot, '.hive', 'features', '01_zeta-feature', 'plan.md'))).toBe(false);
    expect(fs.existsSync(path.join(testRoot, '.hive', 'features', '02_alpha-feature', 'plan.md'))).toBe(false);
  });

  it('keeps non-feature worktree sessions unbound through chat.message and returns logical ambiguity candidates', async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_non_feature_worktree_setup');
    await hooks.tool!.hive_feature_create.execute({ name: 'zeta-feature' }, toolContext);
    await hooks.tool!.hive_feature_create.execute({ name: 'alpha-feature' }, toolContext);

    for (const namespace of ['adhoc', 'review']) {
      const sessionID = `sess_${namespace}_worker`;
      const worktreePath = path.join(testRoot, '.hive', '.worktrees', namespace, `${namespace}-run`);
      fs.mkdirSync(worktreePath, { recursive: true });
      const { hooks: worktreeHooks, toolContext: worktreeContext } = await createHooksForTest(
        testRoot,
        sessionID,
        worktreePath,
      );

      await worktreeHooks['chat.message']?.(
        { sessionID, agent: 'forager-worker' },
        { message: {} as any, parts: [] },
      );
      const raw = await worktreeHooks.tool!.hive_status.execute({}, worktreeContext);
      const result = JSON.parse(raw as string) as {
        launchId?: string;
        reason?: string;
        candidates?: string[];
        error?: string;
      };

      expect(result.reason).toBe('feature_ambiguous');
      expect(result.candidates).toEqual(['alpha-feature', 'zeta-feature']);
      expect(result.error).toContain('Multiple live features found: alpha-feature, zeta-feature');
      expect(readGlobalSessionFeatureName(testRoot, sessionID)).toBeUndefined();
    }
  });

  it('requires an explicit name and leaves all features live when completion is ambiguous', async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_ambiguous_completion');
    await hooks.tool!.hive_feature_create.execute({ name: 'zeta-feature' }, toolContext);
    await hooks.tool!.hive_feature_create.execute({ name: 'alpha-feature' }, toolContext);

    const output = await hooks.tool!.hive_feature_complete.execute({}, toolContext);

    expect(output).toContain('Multiple live features found: alpha-feature, zeta-feature');
    expect(output).toContain('explicit `name` argument');
    expect(new FeatureService(testRoot).get('alpha-feature')?.status).toBe('planning');
    expect(new FeatureService(testRoot).get('zeta-feature')?.status).toBe('planning');
  });

  it('rejects explicitly blank feature arguments without completing the sole live feature', async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_blank_explicit_feature');
    await hooks.tool!.hive_feature_create.execute({ name: 'still-live-feature' }, toolContext);

    for (const explicitBlank of ['', ' \t ']) {
      const statusRaw = await hooks.tool!.hive_status.execute({ feature: explicitBlank }, toolContext);
      const statusResult = JSON.parse(statusRaw as string) as {
        reason?: string;
        error?: string;
        hint?: string;
      };
      const completionOutput = await hooks.tool!.hive_feature_complete.execute({ name: explicitBlank }, toolContext);

      expect(statusResult.reason).toBe('invalid_argument');
      expect(statusResult.error).toContain('must not be blank or whitespace-only');
      expect(statusResult.hint).toContain('feature: "<feature-name>"');
      expect(completionOutput).toContain('must not be blank or whitespace-only');
      expect(completionOutput).toContain('name: "<feature-name>"');
    }
    expect(new FeatureService(testRoot).get('still-live-feature')?.status).toBe('planning');
  });

  it('excludes completed and archived features when resolving the sole live feature', async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_live_status_candidates');
    await hooks.tool!.hive_feature_create.execute({ name: 'completed-feature' }, toolContext);
    await hooks.tool!.hive_feature_create.execute({ name: 'archived-feature' }, toolContext);
    await hooks.tool!.hive_feature_create.execute({ name: 'live-feature' }, toolContext);
    await hooks.tool!.hive_feature_complete.execute({ name: 'completed-feature' }, toolContext);
    new FeatureService(testRoot).archive('archived-feature');

    const raw = await hooks.tool!.hive_status.execute({}, createToolContext('sess_only_live_status'));
    const result = JSON.parse(raw as string) as { feature?: { name?: string; status?: string } };

    expect(result.feature).toMatchObject({ name: 'live-feature', status: 'planning' });
  });

  it('uses an explicit feature despite repository ambiguity', async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_explicit_ambiguous_feature');
    await hooks.tool!.hive_feature_create.execute({ name: 'zeta-feature' }, toolContext);
    await hooks.tool!.hive_feature_create.execute({ name: 'alpha-feature' }, toolContext);

    const output = await hooks.tool!.hive_plan_write.execute(
      {
        feature: 'zeta-feature',
        content: createSingleTaskPlan(
          'Explicit Plan',
          'This integration test verifies that an explicit feature remains authoritative even when several live repository candidates exist.',
        ),
      },
      toolContext,
    );

    expect(output).toContain(path.join('01_zeta-feature', 'plan.md'));
    expect(fs.existsSync(path.join(testRoot, '.hive', 'features', '01_zeta-feature', 'plan.md'))).toBe(true);
    expect(fs.existsSync(path.join(testRoot, '.hive', 'features', '02_alpha-feature', 'plan.md'))).toBe(false);
  });

  it('uses a detected task-worktree feature before repository candidates', async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_detected_feature_setup');
    await hooks.tool!.hive_feature_create.execute({ name: 'detected-feature' }, toolContext);
    await hooks.tool!.hive_feature_create.execute({ name: 'competing-feature' }, toolContext);
    const worktreePath = path.join(testRoot, '.hive', '.worktrees', 'detected-feature', FIRST_TASK);
    fs.mkdirSync(worktreePath, { recursive: true });
    const { hooks: worktreeHooks, toolContext: worktreeContext } = await createHooksForTest(
      testRoot,
      'sess_detected_feature_write',
      worktreePath,
    );

    const output = await worktreeHooks.tool!.hive_plan_write.execute(
      {
        content: createSingleTaskPlan(
          'Detected Plan',
          'This integration test verifies that a detected task-worktree feature wins before unrelated live repository candidates are considered.',
        ),
      },
      worktreeContext,
    );

    expect(output).toContain(path.join('01_detected-feature', 'plan.md'));
    expect(fs.existsSync(path.join(testRoot, '.hive', 'features', '01_detected-feature', 'plan.md'))).toBe(true);
    expect(fs.existsSync(path.join(testRoot, '.hive', 'features', '02_competing-feature', 'plan.md'))).toBe(false);
  });

  it("returns structured JSON when hive_status feature is blocked", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: ROOT_SESSION_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_blocked_status");
    await hooks['chat.message']?.({ sessionID: toolContext.sessionID, agent: toolContext.agent }, {
      message: { agent: toolContext.agent }, parts: [],
    } as any);

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
        content: durableContext("Need approval from Beekeeper."),
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

  it("returns structured terminal JSON when hive_status has no live feature", async () => {
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
      hint?: string;
    };

    expect(result.success).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.reason).toBe("feature_required");
    expect(result.error).toContain("No live feature could be resolved");
    expect(result.hint).toContain('hive_feature_create');
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
      client: ROOT_SESSION_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_overview_status");
    await hooks['chat.message']?.({ sessionID: toolContext.sessionID, agent: toolContext.agent }, {
      message: { agent: toolContext.agent }, parts: [],
    } as any);

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
        content: durableContext("# Learnings\nDurable summary"),
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

  it("keeps hive_status usable with bounded, reason-aware context failure guidance", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: ROOT_SESSION_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_status_context_degraded");
    await hooks['chat.message']?.({ sessionID: toolContext.sessionID, agent: toolContext.agent }, {
      message: { agent: toolContext.agent }, parts: [],
    } as any);

    await hooks.tool!.hive_feature_create.execute(
      { name: "status-context-degraded-feature" },
      toolContext
    );

    await hooks.tool!.hive_context_write.execute(
      {
        feature: "status-context-degraded-feature",
        name: "overview",
        content: "# Overview\nHuman-facing summary",
      },
      toolContext
    );

    let failure = new ContextMutationError('context_response_too_large', 'Context response construction exceeds 16384 bytes.');
    const summarySpy = spyOn(ContextService.prototype, 'readSummary').mockImplementation(() => { throw failure; });

    try {
      const raw = await hooks.tool!.hive_status.execute(
        { feature: "status-context-degraded-feature" },
        toolContext
      );
      const result = JSON.parse(raw as string) as {
        feature?: { name: string };
        overview?: { exists: boolean; updatedAt: string | null };
        tasks?: { total: number };
        context?: { available?: boolean; fileCount: number | null; reason?: string; error?: string; hint?: string };
      };

      expect(result.feature?.name).toBe("status-context-degraded-feature");
      expect(result.overview?.exists).toBe(true);
      expect(result.overview?.updatedAt).toBeNull();
      expect(result.tasks?.total).toBe(0);
      expect(result.context?.available).toBe(false);
      expect(result.context?.fileCount).toBeNull();
      expect(result.context?.reason).toBe("context_response_too_large");
      expect(result.context?.error).toContain("16384");
      expect(result.context?.hint).toContain('catalog');

      failure = new ContextMutationError('context_inventory_too_large', 'Context namespace exceeds 20000 entries.');
      const inventory = JSON.parse(await hooks.tool!.hive_status.execute(
        { feature: "status-context-degraded-feature" }, toolContext,
      ) as string);
      expect(inventory.context).toMatchObject({ available: false, reason: 'context_inventory_too_large' });
      expect(inventory.context.hint).toContain('out of band');
      expect(inventory.context.hint).toContain('exact named');
      expect(inventory.context.hint).not.toContain('catalog view');

      failure = new ContextMutationError('context_reconciliation_required', 'pending marker');
      const pending = JSON.parse(await hooks.tool!.hive_status.execute(
        { feature: "status-context-degraded-feature" }, toolContext,
      ) as string);
      expect(pending.context.hint).toContain('diagnostics');
      expect(pending.context.hint).toContain('reconcile');

      failure = new ContextMutationError('context_index_invalid', 'invalid index detail');
      const invalid = JSON.parse(await hooks.tool!.hive_status.execute(
        { feature: "status-context-degraded-feature" }, toolContext,
      ) as string);
      expect(invalid.context).toMatchObject({ available: false, reason: 'context_index_invalid' });
      expect(invalid.context.hint).toContain('diagnostics');
      expect(invalid.context.hint).toContain('repair');

      failure = new ContextMutationError('context_authorization_denied' as any, 'secret scope detail');
      const denied = JSON.parse(await hooks.tool!.hive_status.execute(
        { feature: "status-context-degraded-feature" }, toolContext,
      ) as string);
      expect(denied.context).toMatchObject({ available: false, reason: 'context_authorization_denied' });
      expect(denied.context.error).not.toContain('secret scope detail');
      expect(denied.context.hint).not.toContain('catalog');
    } finally {
      summarySpy.mockRestore();
    }
  });

  it("reports a generic reason when the managed context summary read fails unexpectedly", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: ROOT_SESSION_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_status_context_generic_failure");
    await hooks['chat.message']?.({ sessionID: toolContext.sessionID, agent: toolContext.agent }, {
      message: { agent: toolContext.agent }, parts: [],
    } as any);

    await hooks.tool!.hive_feature_create.execute(
      { name: "status-context-generic-failure" },
      toolContext
    );

    const summarySpy = spyOn(ContextService.prototype, 'readSummary').mockImplementation(() => {
      throw new Error('boom');
    });

    try {
      const raw = await hooks.tool!.hive_status.execute(
        { feature: "status-context-generic-failure" },
        toolContext
      );
      const result = JSON.parse(raw as string) as {
        context?: { available?: boolean; fileCount: number | null; reason?: string; error?: string };
      };

      expect(result.context?.available).toBe(false);
      expect(result.context?.fileCount).toBeNull();
      expect(result.context?.reason).toBe("context_summary_read_failed");
      expect(result.context?.error).toContain("boom");
    } finally {
      summarySpy.mockRestore();
    }
  });

  it("flags clipped context metadata in hive_status", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: ROOT_SESSION_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_status_context_clipped");
    await hooks['chat.message']?.({ sessionID: toolContext.sessionID, agent: toolContext.agent }, {
      message: { agent: toolContext.agent }, parts: [],
    } as any);

    await hooks.tool!.hive_feature_create.execute(
      { name: "status-context-clipped-feature" },
      toolContext
    );

    for (let index = 0; index < 30; index++) {
      const name = `notes-${String(index).padStart(2, "0")}`;
      await hooks.tool!.hive_context_write.execute(
        {
          feature: "status-context-clipped-feature",
          name,
          content: `---\ndescription: ${"D".repeat(512)}\nread_when: ${"R".repeat(512)}\n---\n\nbody`,
        },
        toolContext
      );
    }

    const raw = await hooks.tool!.hive_status.execute(
      { feature: "status-context-clipped-feature" },
      toolContext
    );
    const result = JSON.parse(raw as string) as {
      feature?: { name: string };
      context?: {
        fileCount: number | null;
        metadataClipped?: boolean;
        diagnostics?: string[];
        files: Array<{ name: string; bytes?: number }>;
      };
    };

    expect(result.feature?.name).toBe("status-context-clipped-feature");
    expect(result.context?.metadataClipped).toBe(true);
    expect(result.context?.diagnostics?.join("\n")).toContain("descriptive metadata");
    expect(result.context?.fileCount).toBe(30);
    expect(result.context?.files).toHaveLength(30);
    expect(result.context?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "notes-00", bytes: expect.any(Number) }),
        expect.objectContaining({ name: "notes-29", bytes: expect.any(Number) }),
      ])
    );
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
      client: ROOT_SESSION_CLIENT,
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
      client: ROOT_SESSION_CLIENT,
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

  it("system prompt hook injects Hive instructions", async () => {
    const configPath = path.join(process.env.HOME || "", ".config", "opencode", "agent_hive.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          "architect-planner": {
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

    const agents = opencodeConfig.agent as Record<string, { prompt?: string }>;
    const architectPrompt = agents["architect-planner"]?.prompt ?? "";
    expect(agents["hive-master"]).toBeUndefined();
    expect(architectPrompt).toContain("## Hive — Active Session");
    expect(architectPrompt).not.toContain("Use hive_status to check feature state before starting work");
    expect(architectPrompt).not.toContain("Use hive_plan_read to see plan comments");

    const brainstormingSkill = BUILTIN_SKILLS.find((skill) => skill.name === "brainstorming");
    expect(brainstormingSkill).toBeDefined();
    expect(architectPrompt).toContain("## Configured Auto-Load Skills");
    expect(architectPrompt).toContain('skill({ name: "brainstorming" })');
    expect(architectPrompt).not.toContain(brainstormingSkill!.template);
    expect(architectPrompt).toContain("Configured Custom Subagents and Built-In Defaults");
    expect(architectPrompt).toContain("`scout-docs`");
    expect(architectPrompt).not.toContain("`forager-ui` — kind: custom overlay");
    expect(architectPrompt).not.toContain("`reviewer-security` — kind: custom overlay");
    expect(architectPrompt).toContain("the scout researcher whose description best fits the research slice");
    expect(architectPrompt).toContain("Use built-in `scout-researcher` when no configured scout-derived custom description is a closer domain/workflow match");
    expect(architectPrompt).toContain("task({ subagent_type: \"<chosen-researcher>\"");

    const systemTransform = hooks["experimental.chat.system.transform" as keyof typeof hooks] as
      | ((input: { sessionID?: string; agent?: string }, output: { system: string[] }) => Promise<void>)
      | undefined;
    const swarmOutput = { system: ["OpenCode provider base prompt"] };
    await systemTransform?.({ sessionID: "sess", agent: "swarm-orchestrator" }, swarmOutput);
    const swarmPrompt = swarmOutput.system[0];
    expect(swarmPrompt).toContain("Configured Custom Subagents and Built-In Defaults");
    expect(swarmPrompt).toContain("`scout-docs`");
    expect(swarmPrompt).toContain("`reviewer-security`");
    expect(swarmPrompt).toContain("the code reviewer whose description best fits the review lens");
    expect(swarmPrompt).toContain("Use built-in `code-reviewer` when no configured code-reviewer-derived custom description is a closer match");
    expect(swarmPrompt).toContain("task({ subagent_type: \"<chosen-reviewer>\"");

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
    expect(agents["hive-master"]).toBeUndefined();
    expect(agents["forager-worker"]?.prompt).toBeUndefined();
    expect(agents["architect-planner"]?.prompt).toContain(ARCHITECT_BEE_PROMPT);
    expect(agents["scout-researcher"]?.prompt).toBeDefined();
    expect(agents["hive-helper"]?.prompt).toBeDefined();
    expect(agents["code-reviewer"]?.prompt).toBeDefined();

    const systemTransform = hooks["experimental.chat.system.transform" as keyof typeof hooks] as
      | ((input: { sessionID?: string; agent?: string }, output: { system: string[] }) => Promise<void>)
      | undefined;

    const cases = [
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

    for (const prompt of [hivePrompt, architectPrompt, swarmPrompt]) {
      expect(prompt).not.toContain("## Background-First Orchestration");
      expect(prompt).not.toContain('skill({ name: "background-delegation" })');
      expect(prompt).not.toContain("background-delegation governs scheduling and wait mode");
    }

    expect(foragerPrompt).not.toContain("todowrite");
    expect(foragerPrompt).not.toContain(REMOVED_PROJECTED_TODO_FIELD);
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
        message: TEST_COMMIT_MESSAGE,
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

  it('persists and renders a zero-file aggregate diff after no-change completion', async () => {
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

    const featurePath = path.join(testRoot, '.hive', 'features', '01_commit-advisory-fallback-feature');
    const completedStatus = JSON.parse(
      fs.readFileSync(path.join(featurePath, 'tasks', FIRST_TASK, 'status.json'), 'utf-8'),
    ) as {
      summary: string;
      aggregateBranchDiff?: {
        fileCount: number;
        insertions: number;
        deletions: number;
        areas: string[];
        report: string;
      };
    };
    expect(completedStatus.summary).toBe('Completed.');
    expect(completedStatus.aggregateBranchDiff).toEqual({
      fileCount: 0,
      insertions: 0,
      deletions: 0,
      areas: [],
      report: '.hive/features/01_commit-advisory-fallback-feature/tasks/01-first-task/reports/1.md',
    });

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

  it("rejects an empty hive_worktree_commit message without creating a commit", async () => {
    const feature = "commit-empty-message-feature";
    const { hooks, toolContext, worktreePath } = await createSingleTaskWorktree(
      testRoot,
      "sess_commit_empty_message",
      feature,
      "Commit Empty Message Feature",
      "Yes, this test validates empty-string message rejection in hive_worktree_commit.",
    );

    fs.writeFileSync(path.join(worktreePath, "task-note.txt"), "empty message rejection\n");

    const summary = "Added rejection check for empty message. Tests pass (bun test).";
    const beforeHead = execSync('git rev-parse HEAD', { cwd: worktreePath, encoding: 'utf-8' }).trim();

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

    expect(commitResult.ok).toBe(false);
    expect(commitResult.terminal).toBe(false);
    expect(commitResult.commit?.message).toMatch(/subject.*blank line.*body/i);
    expect(execSync('git rev-parse HEAD', { cwd: worktreePath, encoding: 'utf-8' }).trim()).toBe(beforeHead);
  });

  for (const { status, message } of [
    { status: 'failed' as const, message: undefined },
    { status: 'partial' as const, message: 'subject only' },
  ]) {
    it(`keeps ${status} handoff non-terminal when dirty progress lacks a valid commit message`, async () => {
      const feature = `commit-${status}-invalid-message-feature`;
      const { hooks, toolContext, worktreePath } = await createSingleTaskWorktree(
        testRoot,
        `sess_commit_${status}_invalid_message`,
        feature,
        `Commit ${status} Invalid Message Feature`,
        `Yes, this test validates ${status} handoff behavior when dirty progress lacks a valid commit message.`,
      );
      fs.writeFileSync(path.join(worktreePath, 'task-note.txt'), `${status} progress\n`);
      const beforeHead = execSync('git rev-parse HEAD', { cwd: worktreePath, encoding: 'utf-8' }).trim();

      const raw = await hooks.tool!.hive_worktree_commit.execute(
        {
          feature,
          task: FIRST_TASK,
          status,
          summary: `${status} progress could not continue. Tests pass (bun test).`,
          ...(message !== undefined ? { message } : {}),
        },
        toolContext,
      );
      const result = JSON.parse(raw as string) as {
        ok: boolean;
        terminal: boolean;
        reason?: string;
        taskState?: string;
        commit?: { committed?: boolean; message?: string };
      };

      expect(result.ok).toBe(false);
      expect(result.terminal).toBe(false);
      expect(result.reason).toBe('commit_failed');
      expect(result.taskState).toBe('in_progress');
      expect(result.commit?.committed).toBe(false);
      expect(result.commit?.message).toMatch(/subject.*blank line.*body/i);
      expect(execSync('git rev-parse HEAD', { cwd: worktreePath, encoding: 'utf-8' }).trim()).toBe(beforeHead);
    });
  }

  it("returns helper-friendly merge JSON when task is not completed", async () => {
    const feature = "merge-incomplete-task-feature";
    const { hooks, toolContext } = await createSingleTaskWorktree(
      testRoot,
      "sess_merge_incomplete_task",
      feature,
      "Merge Incomplete Task Feature",
      "Yes, this test validates the early hive_merge JSON contract for incomplete tasks.",
    );

    await stopPreparedExecution(hooks, toolContext);

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

    expect(mergeResult).toMatchObject({
      success: false,
      merged: false,
      strategy: 'merge',
      filesChanged: [],
      conflicts: [],
      conflictState: 'none',
      phase: 'preflight',
      mutation: 'none',
      retryable: false,
      action: 'inspect_state',
      cleanup: {
        worktreeRemoved: false,
        branchDeleted: false,
        pruned: false,
        requested: 'none',
        outcome: 'not_requested',
        worktreeRemoval: { status: 'not_requested' },
        branchDeletion: { status: 'not_requested' },
        prune: { status: 'not_requested' },
        failures: [],
      },
      error: 'Task must be completed before merging. Use hive_worktree_commit first.',
      message: 'Merge failed: Task must be completed before merging. Use hive_worktree_commit first.',
    });
    expect(mergeResult.reasonCode).toBeUndefined();
  });

  it("auto-loads parallel exploration for planner agents by default", async () => {
    // Test dedicated-mode (default) planner agents
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
    const parallelExplorationToolCall = 'skill({ name: "parallel-exploration" })';
    const parallelExplorationSkill = BUILTIN_SKILLS.find(
      (skill) => skill.name === "parallel-exploration",
    );
    expect(parallelExplorationSkill).toBeDefined();

    // Default mode is 'dedicated' which includes architect-planner, swarm-orchestrator, scout, forager, reviewers
    const opencodeConfig: Record<string, unknown> = { agent: {} };
    await hooks.config!(opencodeConfig);
    const agents = opencodeConfig.agent as Record<string, { prompt?: string }>;
    expect(opencodeConfig.default_agent).toBe('architect-planner');
    expect(agents['architect-planner']).toBeDefined();
    expect(agents['swarm-orchestrator']).toBeDefined();
    expect(agents['hive-master']).toBeUndefined();
    const systemTransform = hooks["experimental.chat.system.transform" as keyof typeof hooks] as
      | ((input: { sessionID?: string; agent?: string }, output: { system: string[] }) => Promise<void>)
      | undefined;

    const foragerOutput = { system: ["OpenCode provider base prompt"] };
    await systemTransform?.({ sessionID: 'sess_forager_autoload', agent: 'forager-worker' }, foragerOutput);

    // architect-planner embeds parallel-exploration load guidance in its registered prompt (dedicated mode)
    expect(agents["architect-planner"]?.prompt).toContain(parallelExplorationToolCall);
    expect(agents["architect-planner"]?.prompt).not.toContain(parallelExplorationSkill!.template);
    expect(agents["architect-planner"]?.prompt).not.toContain(onboardingSnippet);

    // scout-researcher should NOT have parallel-exploration guidance in prompt
    // (removed to prevent recursive delegation - scout cannot spawn scouts)
    expect(agents["scout-researcher"]?.prompt).toBeDefined();
    expect(agents["scout-researcher"]?.prompt).not.toContain(parallelExplorationToolCall);
    expect(agents["scout-researcher"]?.prompt).not.toContain(
      parallelExplorationSkill!.template,
    );
    expect(agents["scout-researcher"]?.prompt).not.toContain(onboardingSnippet);

    // forager-worker should NOT have parallel-exploration in prompt
    expect(agents["forager-worker"]?.prompt).toBeUndefined();
    expect(foragerOutput.system[0]).not.toContain(parallelExplorationToolCall);
    expect(foragerOutput.system[0]).not.toContain(
      parallelExplorationSkill!.template,
    );
    expect(foragerOutput.system[0]).not.toContain(onboardingSnippet);
  });

  it("hive_plan_read reuses its global session binding despite repository ambiguity", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: ROOT_SESSION_CLIENT,
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
    await hooks.tool!.hive_feature_create.execute(
      { name: "competing-plan-feature" },
      toolContext,
    );
    await hooks.tool!.hive_plan_write.execute(
      {
        content: createSingleTaskPlan(
          "Competing Plan Feature",
          "This feature keeps the repository ambiguous while session resolution is verified."
        ),
        feature: "competing-plan-feature",
      },
      toolContext,
    );

    const workerContext = createToolContext("sess_worker_plan_bind");
    await hooks['chat.message']!({ sessionID: workerContext.sessionID, agent: 'hive-master' } as any, {
      message: { agent: 'hive-master' }, parts: [],
    } as any);
    await hooks.tool!.hive_plan_read.execute(
      { feature: "plan-bind-feature" },
      workerContext
    );
    const boundRead = JSON.parse(await hooks.tool!.hive_plan_read.execute(
      {},
      workerContext,
    ) as string) as { content: string };

    const sessionsPath = path.join(testRoot, ".hive", "sessions.json");
    expect(fs.existsSync(sessionsPath)).toBe(true);
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
    const workerSession = sessions.sessions.find(
      (s: { sessionId: string }) => s.sessionId === "sess_worker_plan_bind"
    );
    expect(workerSession).toBeDefined();
    expect(workerSession.featureName).toBe("plan-bind-feature");
    expect(boundRead.content).toContain('# Plan Bind Feature');
    expect(boundRead.content).not.toContain('# Competing Plan Feature');
  });

  it("uses directory for the global root sentinel and resolves an omitted feature from the session binding", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: "/",
      serverUrl: new URL("http://localhost:1"),
      project: { ...createProject("/"), id: "global" },
      client: ROOT_SESSION_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_ctx_bind");

    await hooks.tool!.hive_feature_create.execute(
      { name: "ctx-bind-feature" },
      toolContext
    );

    const workerContext = createToolContext("sess_worker_ctx_bind");
    await hooks['chat.message']?.({ sessionID: workerContext.sessionID, agent: workerContext.agent }, {
      message: { agent: workerContext.agent }, parts: [],
    } as any);
    const output = await hooks.tool!.hive_context_write.execute(
      { name: "notes", content: durableContext("test notes"), feature: "ctx-bind-feature" },
      workerContext
    );
    const omittedOutput = await hooks.tool!.hive_context_write.execute(
      { name: "follow-up", content: durableContext("bound notes") },
      workerContext,
    );

    expect(JSON.parse(output as string)).toMatchObject({ success: true, operation: 'created' });
    expect(omittedOutput).toContain(path.join("01_ctx-bind-feature", "context", "follow-up.md"));
    expect(fs.readFileSync(path.join(
      testRoot,
      ".hive",
      "features",
      "01_ctx-bind-feature",
      "context",
      "notes.md",
    ), "utf-8")).toBe(durableContext("test notes"));
    expect(fs.readFileSync(path.join(
      testRoot,
      ".hive",
      "features",
      "01_ctx-bind-feature",
      "context",
      "follow-up.md",
    ), "utf-8")).toBe(durableContext("bound notes"));

    const sessionsPath = path.join(testRoot, ".hive", "sessions.json");
    expect(fs.existsSync(sessionsPath)).toBe(true);
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
    const workerSession = sessions.sessions.find(
      (s: { sessionId: string }) => s.sessionId === "sess_worker_ctx_bind"
    );
    expect(workerSession).toBeDefined();
    expect(workerSession.featureName).toBe("ctx-bind-feature");
  });

  it("preserves a non-root worktree for a global project", async () => {
    const worktreeRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, "context-worktree-"));
    const featureName = "global-worktree-feature";
    new FeatureService(worktreeRoot).create(featureName);
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: worktreeRoot,
      serverUrl: new URL("http://localhost:1"),
      project: { ...createProject(worktreeRoot), id: "global" },
      client: ROOT_SESSION_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const writerSessionID = "sess_global_worktree_writer";
    await hooks['chat.message']?.({ sessionID: writerSessionID, agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    } as any);
    const output = await hooks.tool!.hive_context_write.execute(
      { name: "notes", content: durableContext("worktree notes"), feature: featureName },
      createToolContext(writerSessionID),
    );

    const created = JSON.parse(output as string) as { success: boolean; operation: string; revision: number; file: { contentHash: string } };
    expect(created).toMatchObject({ success: true, operation: 'created' });
    const status = JSON.parse(await hooks.tool!.hive_status.execute(
      { feature: featureName },
      createToolContext(writerSessionID),
    ) as string) as {
      feature: { name: string };
      context: {
        revision: number;
        fileCount: number;
        files: Array<{ name: string; bytes: number }>;
        durable: { fileCount: number; chars: number | null };
      };
    };
    expect(status).toMatchObject({
      feature: { name: featureName },
      context: {
        revision: created.revision,
        fileCount: 1,
        files: [{ name: 'notes', bytes: Buffer.byteLength(durableContext('worktree notes'), 'utf8') }],
        durable: { fileCount: 1, chars: null },
      },
    });
    const read = JSON.parse(await hooks.tool!.hive_context_read.execute(
      { name: 'notes', feature: featureName },
      createToolContext(writerSessionID),
    ) as string) as { revision: number; file: { content: string; contentHash: string } };
    expect(read).toMatchObject({ revision: created.revision, file: { content: durableContext('worktree notes') } });
    const appended = JSON.parse(await hooks.tool!.hive_context_append.execute(
      {
        name: 'notes',
        content: 'follow-up',
        expectedRevision: read.revision,
        expectedContentHash: read.file.contentHash,
        feature: featureName,
      },
      createToolContext(writerSessionID),
    ) as string) as { revision: number; file: { contentHash: string } };
    const archived = JSON.parse(await hooks.tool!.hive_context_archive.execute(
      {
        names: ['notes'],
        reason: 'smoke complete',
        expectedRevision: appended.revision,
        expectedContentHashes: { notes: appended.file.contentHash },
        feature: featureName,
      },
      createToolContext(writerSessionID),
    ) as string) as { success: boolean; operation: string; archived: Array<{ archivePath: string }> };
    expect(archived).toMatchObject({ success: true, operation: 'archived' });
    expect(fs.readFileSync(archived.archived[0]!.archivePath, 'utf-8')).toContain('follow-up');
    expect(fs.existsSync(path.join(
      worktreeRoot,
      ".hive",
      "features",
      "01_global-worktree-feature",
      "context",
      "notes.md",
    ))).toBe(false);
    expect(readGlobalSessionFeatureName(worktreeRoot, writerSessionID)).toBe(featureName);
    expect(fs.existsSync(path.join(testRoot, ".hive", "features"))).toBe(false);
  });

  it("does not redirect the root sentinel for a non-global project", async () => {
    const featureName = `root-boundary-${randomUUID()}`;
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: "/",
      serverUrl: new URL("http://localhost:1"),
      project: createProject("/"),
      client: ROOT_SESSION_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const createOutput = await hooks.tool!.hive_feature_create.execute(
      { name: featureName },
      createToolContext("sess_root_boundary_owner")
    );
    expect(createOutput).toContain(`Feature "${featureName}" created`);

    const writerSessionID = "sess_root_boundary_writer";
    const output = await hooks.tool!.hive_context_write.execute(
      { name: "notes", content: "must not be written", feature: featureName },
      createToolContext(writerSessionID)
    );

    expect(JSON.parse(output as string)).toMatchObject({
      success: false,
      terminal: true,
      reason: 'context_root_mismatch',
      error: 'The plugin directory and runtime context resolve to different canonical project roots.',
    });
    expect(fs.existsSync(path.join(
      testRoot,
      ".hive",
      "features",
      `01_${featureName}`,
      "context",
      "notes.md",
    ))).toBe(false);
    expect(readGlobalSessionFeatureName(testRoot, writerSessionID)).toBeUndefined();
  });

  it('uses a root session binding before unrelated live repository candidates', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_context_binding_setup');
    const boundContext = createToolContext('sess_bound_context_write');
    await hooks['chat.message']?.({ sessionID: boundContext.sessionID, agent: boundContext.agent }, {
      message: { agent: boundContext.agent }, parts: [],
    } as any);

    await hooks.tool!.hive_feature_create.execute(
      { name: 'bound-context-feature' },
      createToolContext('sess_bound_feature_owner'),
    );
    await hooks.tool!.hive_context_write.execute(
      { feature: 'bound-context-feature', name: 'initial-notes', content: durableContext('initial') },
      boundContext,
    );
    await hooks.tool!.hive_feature_create.execute(
      { name: 'other-live-feature' },
      createToolContext('sess_other_feature_owner'),
    );

    const output = await hooks.tool!.hive_context_write.execute(
      { name: 'bound-notes', content: durableContext('bound content') },
      boundContext,
    );

    expect(output).toContain(path.join('01_bound-context-feature', 'context', 'bound-notes.md'));
    expect(fs.readFileSync(path.join(
      testRoot,
      '.hive',
      'features',
      '01_bound-context-feature',
      'context',
      'bound-notes.md',
    ), 'utf-8')).toBe(durableContext('bound content'));
    expect(fs.existsSync(path.join(
      testRoot,
      '.hive',
      'features',
      '02_other-live-feature',
      'context',
      'bound-notes.md',
    ))).toBe(false);
  });

  it('treats an ad-hoc worktree namespace as unscoped for context writes', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_adhoc_context_setup');
    await hooks.tool!.hive_feature_create.execute(
      { name: 'adhoc-bound-feature' },
      createToolContext('sess_adhoc_bound_owner'),
    );
    await hooks.tool!.hive_feature_create.execute(
      { name: 'unrelated-live-feature' },
      createToolContext('sess_adhoc_live_owner'),
    );

    const adhocWorktreePath = path.join(
      testRoot,
      '.hive',
      '.worktrees',
      'adhoc',
      'context-target-run',
    );
    fs.mkdirSync(adhocWorktreePath, { recursive: true });
    const { hooks: adhocHooks } = await createHooksForTest(
      testRoot,
      'sess_adhoc_bound_write',
      adhocWorktreePath,
    );
    const boundContext = createToolContext('sess_adhoc_bound_write');
    const unboundContext = createToolContext('sess_adhoc_unbound_write');
    await adhocHooks['chat.message']?.({ sessionID: unboundContext.sessionID, agent: unboundContext.agent }, {
      message: { agent: unboundContext.agent }, parts: [],
    } as any);

    const explicitOutput = await adhocHooks.tool!.hive_context_write.execute(
      { feature: 'adhoc-bound-feature', name: 'initial-notes', content: durableContext('initial') },
      boundContext,
    );
    const omittedOutput = await adhocHooks.tool!.hive_context_write.execute(
      { name: 'follow-up-notes', content: durableContext('follow-up') },
      boundContext,
    );
    const unboundOutput = await adhocHooks.tool!.hive_context_write.execute(
      { name: 'unsafe-notes', content: 'must not write' },
      unboundContext,
    );

    expect(explicitOutput).toContain(path.join('01_adhoc-bound-feature', 'context', 'initial-notes.md'));
    expect(omittedOutput).toContain(path.join('01_adhoc-bound-feature', 'context', 'follow-up-notes.md'));
    expect(omittedOutput).not.toContain("Feature 'adhoc'");
    expect(fs.readFileSync(path.join(
      testRoot,
      '.hive',
      'features',
      '01_adhoc-bound-feature',
      'context',
      'follow-up-notes.md',
    ), 'utf-8')).toBe(durableContext('follow-up'));

    expect(unboundOutput).toContain('Multiple live features found: adhoc-bound-feature, unrelated-live-feature');
    expect(unboundOutput).toContain('explicit `feature` argument');
    expect(unboundOutput).not.toContain("Feature 'adhoc'");
    expect(fs.existsSync(path.join(
      testRoot,
      '.hive',
      'features',
      '02_unrelated-live-feature',
      'context',
      'unsafe-notes.md',
    ))).toBe(false);
  });

  it('uses a detected feature worktree and binds the writing session', async () => {
    const { worktreePath } = await createSingleTaskWorktree(
      testRoot,
      'sess_detected_worktree_setup',
      'detected-context-feature',
      'Detected Context Feature',
      'Yes, this creates a feature worktree so context targeting can be verified from its detected path.',
    );
    const sessionID = 'sess_detected_context_write';
    const { hooks: worktreeHooks, toolContext: detectedContext } = await createHooksForTest(
      testRoot,
      sessionID,
      worktreePath,
    );

    const output = await worktreeHooks.tool!.hive_context_write.execute(
      { name: 'worktree-notes', content: durableContext('detected content') },
      detectedContext,
    );

    expect(output).toContain(path.join('01_detected-context-feature', 'context', 'worktree-notes.md'));
    expect(fs.readFileSync(path.join(
      testRoot,
      '.hive',
      'features',
      '01_detected-context-feature',
      'context',
      'worktree-notes.md',
    ), 'utf-8')).toBe(durableContext('detected content'));
    expect(readGlobalSessionFeatureName(testRoot, sessionID)).toBe('detected-context-feature');
  });

  it('explicit feature overrides a different detected worktree feature', async () => {
    const { worktreePath } = await createSingleTaskWorktree(
      testRoot,
      'sess_explicit_override_setup',
      'detected-override-feature',
      'Detected Override Feature',
      'Yes, this creates a detected worktree feature so an explicit feature param can override it.',
    );
    const { hooks } = await createHooksForTest(testRoot, 'sess_explicit_target_owner');
    await hooks.tool!.hive_feature_create.execute(
      { name: 'explicit-target-feature' },
      createToolContext('sess_explicit_target_owner'),
    );

    const sessionID = 'sess_explicit_override_write';
    const { hooks: worktreeHooks, toolContext: overrideContext } = await createHooksForTest(
      testRoot,
      sessionID,
      worktreePath,
    );

    const output = await worktreeHooks.tool!.hive_context_write.execute(
      {
        feature: 'explicit-target-feature',
        name: 'override-notes',
        content: durableContext('explicit wins'),
      },
      overrideContext,
    );

    expect(output).toContain(path.join('02_explicit-target-feature', 'context', 'override-notes.md'));
    expect(fs.readFileSync(path.join(
      testRoot,
      '.hive',
      'features',
      '02_explicit-target-feature',
      'context',
      'override-notes.md',
    ), 'utf-8')).toBe(durableContext('explicit wins'));
    expect(fs.existsSync(path.join(
      testRoot,
      '.hive',
      'features',
      '01_detected-override-feature',
      'context',
      'override-notes.md',
    ))).toBe(false);

    expect(readGlobalSessionFeatureName(testRoot, sessionID)).toBe('explicit-target-feature');
  });

  it('fails a missing detected feature without falling back to a valid session-bound feature', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_missing_detected_setup');
    const boundContext = createToolContext('sess_missing_detected_write');
    await hooks['chat.message']?.({ sessionID: boundContext.sessionID, agent: boundContext.agent }, {
      message: { agent: boundContext.agent }, parts: [],
    } as any);

    await hooks.tool!.hive_feature_create.execute(
      { name: 'session-bound-feature' },
      createToolContext('sess_session_bound_owner'),
    );
    await hooks.tool!.hive_context_write.execute(
      { feature: 'session-bound-feature', name: 'bound-seed', content: durableContext('seed') },
      boundContext,
    );

    const staleWorktreePath = path.join(
      testRoot,
      '.hive',
      '.worktrees',
      'missing-detected-feature',
      FIRST_TASK,
    );
    fs.mkdirSync(staleWorktreePath, { recursive: true });

    const { hooks: worktreeHooks } = await createHooksForTest(
      testRoot,
      boundContext.sessionID,
      staleWorktreePath,
    );

    const output = await worktreeHooks.tool!.hive_context_write.execute(
      { name: 'should-not-fallback', content: 'must not write' },
      boundContext,
    );

    expect(JSON.parse(output as string)).toMatchObject({
      success: false,
      reason: 'feature_not_found',
      error: "Feature 'missing-detected-feature' not found. Create it first with hive_feature_create.",
    });
    expect(fs.existsSync(path.join(
      testRoot,
      '.hive',
      'features',
      '01_session-bound-feature',
      'context',
      'should-not-fallback.md',
    ))).toBe(false);
    expect(fs.existsSync(path.join(
      testRoot,
      '.hive',
      'features',
      'missing-detected-feature',
    ))).toBe(false);

    expect(readGlobalSessionFeatureName(testRoot, boundContext.sessionID)).toBe('session-bound-feature');
  });

  it('does not bind the session when context write fails', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_write_fail_owner');
    await hooks.tool!.hive_feature_create.execute(
      { name: 'write-fail-feature' },
      createToolContext('sess_write_fail_owner'),
    );

    const featureDir = path.join(testRoot, '.hive', 'features', '01_write-fail-feature');
    const contextPath = path.join(featureDir, 'context');
    fs.writeFileSync(contextPath, 'not-a-directory');

    const sessionID = 'sess_write_fail_unbound';
    await hooks['chat.message']?.({ sessionID, agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    } as any);
    await expect(
      hooks.tool!.hive_context_write.execute(
        { feature: 'write-fail-feature', name: 'failed-notes', content: 'should not persist' },
        createToolContext(sessionID),
      ),
    ).rejects.toThrow();

    expect(fs.existsSync(path.join(featureDir, 'context', 'failed-notes.md'))).toBe(false);

    expect(readGlobalSessionFeatureName(testRoot, sessionID)).toBeUndefined();

    const featureSessionsPath = path.join(featureDir, 'sessions.json');
    if (fs.existsSync(featureSessionsPath)) {
      const featureSessions = JSON.parse(fs.readFileSync(featureSessionsPath, 'utf-8')) as {
        sessions: Array<{ sessionId: string; featureName?: string }>;
      };
      expect(featureSessions.sessions.some((session) => session.sessionId === sessionID)).toBe(false);
    }

    const featureJson = JSON.parse(fs.readFileSync(path.join(featureDir, 'feature.json'), 'utf-8')) as {
      sessionId?: string;
    };
    expect(featureJson.sessionId).not.toBe(sessionID);
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

    const startRaw = await prepareTaskExecution(hooks,
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
        message: TEST_COMMIT_MESSAGE,
      },
      toolContext,
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
        mergeEligibility: Array<{
          task: string;
          eligible: boolean;
          reasonCode: string;
          recommendedCommand?: string;
        }>;
      };
    };

    expect(status.tasks?.pending).toBe(1);
    expect(status.tasks?.runnable).toEqual(['04-fourth-task']);
    expect(status.helperStatus).toMatchObject({
      doneTasksWithLiveWorktrees: ['03-third-task'],
      dirtyWorktrees: ['03-third-task'],
      nonInProgressTasksWithWorktrees: ['03-third-task'],
      mergeEligibility: [
        {
          task: '01-first-task',
          eligible: false,
          reasonCode: 'NO_LIVE_WORKTREE',
        },
        {
          task: '02-second-task',
          eligible: false,
          reasonCode: 'NO_LIVE_WORKTREE',
        },
        {
          task: '03-third-task',
          eligible: true,
          reasonCode: 'TASK_DONE_WITH_LIVE_WORKTREE',
          recommendedCommand: 'hive_merge({ task: "03-third-task" })',
        },
        {
          task: '04-fourth-task',
          eligible: false,
          reasonCode: 'TASK_NOT_DONE',
        },
      ],
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

  it('declares only the runtime hooks needed by the plugin', () => {
    expect([...SUPPORTED_PLUGIN_HOOKS]).toEqual([
      'event',
      'config',
      'chat.message',
      'experimental.chat.system.transform',
      'experimental.chat.messages.transform',
      'command.execute.before',
      'tool.execute.before',
      'tool.execute.after',
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
  fs.writeFileSync(path.join(p, '.gitignore'), '.hive/\n');
  execSync('git add README.md .gitignore', { cwd: p });
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
    const configDir = path.join(testRoot, '.hive');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'repositories.json'),
      JSON.stringify({
        schemaVersion: 1,
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

    const manifest = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'repositories.json'), 'utf-8'));
    expect(manifest.schemaVersion).toBe(1);
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

  it('exposes workspacePath, worktreePath (=workspace root), baseCommits, and repos in managed execution preparation launch metadata', async () => {
    await setupMultiRepoProject(['api', 'web']);
    const parent = 'sess_repos_launch';
    const child = 'composite-child';
    let state = 'busy';
    const runtimeClient = { ...(ROOT_SESSION_CLIENT as any), session: { ...(ROOT_SESSION_CLIENT as any).session,
      get: async ({ path: input }: any) => ({ data: { id: input.id, parentID: input.id === child ? parent : undefined } }),
      status: async () => state === 'unavailable' ? { error: 'offline' } : { data: { [child]: { type: state } } },
    } } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);

    await hooks.tool!.hive_feature_create.execute({ name: 'mr-launch' }, toolContext);
    const plan = `# MR Launch

## Discovery

**Q: ok?**
A: Yes, this regression test validates that managed execution preparation returns composite launch metadata (workspacePath, baseCommits, repos) when the project has a repository manifest and the task declares its repos.

## Tasks

### 1. Multi Repo Task
**Repos**: api, web
Do it.
`;
    await hooks.tool!.hive_plan_write.execute({ content: plan, feature: 'mr-launch' }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature: 'mr-launch' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'mr-launch' }, toolContext);

    const startRaw = await prepareTaskExecution(hooks,
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
    expect(new ExecutionAttemptService(testRoot).getAttempt((start as any).attemptId)).toMatchObject({
      phase: 'attached',
      placement: { workspacePath: start.workspacePath },
    });
    const fresh = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    const status = JSON.parse(await fresh.hooks.tool!.hive_status.execute({ feature: 'mr-launch' }, fresh.toolContext) as string);
    expect(status.unfinishedAttempts?.some((attempt: { dispatchState: string }) => attempt.dispatchState !== 'settled')).toBe(true);
    expect(status.unfinishedAttempts.length).toBeGreaterThan(0);
  });

  it('fails managed execution preparation when a manifest-backed task declares an unknown repo id', async () => {
    await setupMultiRepoProject(['api']);
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_missing');

    await hooks.tool!.hive_feature_create.execute({ name: 'mr-missing' }, toolContext);
    const plan = `# MR Missing

## Discovery

**Q: ok?**
A: Yes, this regression test validates that managed execution preparation fails fast when a task declares a repository id that is absent from the project repository manifest, before any worktree directories are created.

## Tasks

### 1. Bad Task
**Repos**: api, ghost
Do it.
`;
    await hooks.tool!.hive_plan_write.execute({ content: plan, feature: 'mr-missing' }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature: 'mr-missing' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'mr-missing' }, toolContext);

    await expect(
      prepareTaskExecution(hooks,
        { feature: 'mr-missing', task: '01-bad-task' },
        toolContext,
      ),
    ).rejects.toThrow(/missing required repos/);
  });

  it('fails managed execution preparation for a manifest-backed task that omits Repos metadata', async () => {
    await setupMultiRepoProject(['api']);
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_omitted');

    await hooks.tool!.hive_feature_create.execute({ name: 'mr-omit' }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      { content: createSingleTaskPlan('MR Omit', 'Yes, this regression test validates that manifest-backed projects fail managed execution preparation when the task omits the Repos annotation entirely instead of silently picking a default repository.'), feature: 'mr-omit' },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'mr-omit' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'mr-omit' }, toolContext);

    await expect(
      prepareTaskExecution(hooks,
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
      { content: createSingleTaskPlan('Legacy', 'Yes, this regression test validates that projects without a repository manifest stay in legacy single-worktree mode and that managed execution preparation does not surface composite-only launch fields.'), feature: 'legacy-feature' },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'legacy-feature' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'legacy-feature' }, toolContext);

    const startRaw = await prepareTaskExecution(hooks,
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

  it('ignores a global repository manifest scoped to another project', async () => {
    initBareRepo(testRoot);
    // testRoot doubles as HOME during this suite; write a global manifest that
    // would set up bogus repositories. RepositoryService must ignore it.
    const globalDir = path.join(testRoot, '.config', 'opencode');
    fs.mkdirSync(path.join(testRoot, 'another-project'), { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'agent_hive.json'),
      JSON.stringify({ repositoryRoot: path.join(testRoot, 'another-project'), repositories: [{ id: 'bogus', path: './does-not-exist' }] }, null, 2),
    );

    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_repos_global_ignored');

    await hooks.tool!.hive_feature_create.execute({ name: 'ignore-global' }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      { content: createSingleTaskPlan('Ignore Unscoped Global', 'Yes, this regression test validates that a global manifest scoped to another project does not enable composite worktrees.'), feature: 'ignore-global' },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'ignore-global' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'ignore-global' }, toolContext);

    const startRaw = await prepareTaskExecution(hooks,
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
    const hiveDir = path.join(testRoot, '.config', 'opencode');
    fs.mkdirSync(hiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(hiveDir, 'agent_hive.json'),
      JSON.stringify({
        repositoryRoot: testRoot,
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
      prepareTaskExecution(hooks,
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
      prepareTaskExecution(hooks,
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
    const startRaw = await prepareTaskExecution(hooks,
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
      { feature, task: '01-composite-task', status: 'completed', summary: 'Composite single-repo commit. Tests pass.', message: TEST_COMMIT_MESSAGE },
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
      { feature, task: '01-composite-task', status: 'completed', summary: 'Composite multi-repo commit. Tests pass.', message: TEST_COMMIT_MESSAGE },
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

  it('hive_worktree_commit rejects invalid registration before committing an earlier repo', async () => {
    const feature = 'mr-commit-partial';
    const { hooks, toolContext, repos } = await setupCompositeTaskWorktree(['api', 'web'], feature, 'sess_mr_commit_partial');

    // Stage a change in api (sorted first), then break web so its commit fails.
    fs.writeFileSync(path.join(repos.api.path, 'api-note.txt'), 'api change\n');
    fs.rmSync(repos.web.path, { recursive: true, force: true });

    const apiHead = execSync('git rev-parse HEAD', { cwd: repos.api.path, encoding: 'utf8' }).trim();
    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: '01-composite-task', status: 'completed', summary: 'Composite preflight failure attempt. Tests pass.', message: TEST_COMMIT_MESSAGE },
      toolContext,
    );
    const commitResult = JSON.parse(commitRaw as string) as {
      ok: boolean;
      terminal: boolean;
      reasonCode?: string;
      retryable?: boolean;
      action?: string;
      error?: string;
      commit?: unknown;
    };
    expect(commitResult.ok).toBe(false);
    expect(commitResult.terminal).toBe(true);
    expect(commitResult.reasonCode).toBe('WORKTREE_LINKAGE_INVALID');
    expect(commitResult.retryable).toBe(false);
    expect(commitResult.action).toBe('start_fresh_run');
    expect(commitResult.commit).toBeUndefined();
    expect(execSync('git rev-parse HEAD', { cwd: repos.api.path, encoding: 'utf8' }).trim()).toBe(apiHead);
    const taskStatusPath = path.join(
      testRoot,
      '.hive',
      'features',
      '01_mr-commit-partial',
      'tasks',
      '01-composite-task',
      'status.json',
    );
    const taskStatus = JSON.parse(fs.readFileSync(taskStatusPath, 'utf-8')) as {
      aggregateBranchDiff?: unknown;
    };
    expect(taskStatus.aggregateBranchDiff).toBeUndefined();
  });

  it('hive_worktree_commit propagates later missing-worktree preflight failure', async () => {
    const feature = 'mr-commit-later-fail';
    const { hooks, toolContext, repos } = await setupCompositeTaskWorktree(['api', 'web'], feature, 'sess_mr_commit_later_fail');

    fs.writeFileSync(path.join(repos.web.path, 'web-note.txt'), 'web only\n');
    fs.rmSync(repos.web.path, { recursive: true, force: true });

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: '01-composite-task', status: 'completed', summary: 'Later-repo failure after earlier no-change. Tests pass.', message: TEST_COMMIT_MESSAGE },
      toolContext,
    );
    const commitResult = JSON.parse(commitRaw as string) as {
      ok: boolean;
      terminal: boolean;
      reasonCode?: string;
      retryable?: boolean;
      action?: string;
      commit?: { committed?: boolean; repos?: Record<string, { committed: boolean }> };
    };
    expect(commitResult.ok).toBe(false);
    expect(commitResult.terminal).toBe(true);
    expect(commitResult.reasonCode).toBe('WORKTREE_LINKAGE_INVALID');
    expect(commitResult.retryable).toBe(false);
    expect(commitResult.action).toBe('start_fresh_run');
    expect(commitResult.commit).toBeUndefined();
    expect(execSync('git log --oneline', { cwd: repos.api.path, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
  });

  it('hive_merge (composite single-repo): returns aggregate repos and success', async () => {
    const feature = 'mr-merge-single';
    const { hooks, toolContext, repos } = await setupCompositeTaskWorktree(['api'], feature, 'sess_mr_merge_single');

    fs.writeFileSync(path.join(repos.api.path, 'merge-note.txt'), 'composite single merge\n');
    await hooks.tool!.hive_worktree_commit.execute(
      { feature, task: '01-composite-task', status: 'completed', summary: 'Prepare composite single merge. Tests pass.', message: TEST_COMMIT_MESSAGE },
      toolContext,
    );

    await stopPreparedExecution(hooks, toolContext);

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: '01-composite-task', strategy: 'merge', message: TEST_MERGE_MESSAGE },
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
      { feature, task: '01-composite-task', status: 'completed', summary: 'Prepare composite multi merge. Tests pass.', message: TEST_COMMIT_MESSAGE },
      toolContext,
    );

    await stopPreparedExecution(hooks, toolContext);

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: '01-composite-task', strategy: 'merge', message: TEST_MERGE_MESSAGE },
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
      { feature, task: '01-composite-task', status: 'completed', summary: 'Prepare composite preflight merge. Tests pass.', message: TEST_COMMIT_MESSAGE },
      toolContext,
    );

    // Make web target repo dirty so preflight fails.
    fs.writeFileSync(path.join(testRoot, 'repos', 'web', 'dirty.txt'), 'dirty target\n');

    await stopPreparedExecution(hooks, toolContext);

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: '01-composite-task', strategy: 'merge', message: TEST_MERGE_MESSAGE },
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
      { feature, task: '01-composite-task', status: 'completed', summary: 'Prepare composite conflict merge. Tests pass.', message: TEST_COMMIT_MESSAGE },
      toolContext,
    );

    await stopPreparedExecution(hooks, toolContext);

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: '01-composite-task', strategy: 'merge', message: TEST_MERGE_MESSAGE },
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
      { feature, task: '01-composite-task', status: 'completed', summary: 'Prepare composite rebase rejection. Tests pass.', message: TEST_COMMIT_MESSAGE },
      toolContext,
    );

    await stopPreparedExecution(hooks, toolContext);

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

  it('end-to-end smoke: non-git workspace with scoped global manifest and two child repos runs start -> commit -> merge with per-repo results', async () => {
    // Project root is a plain directory (no `git init`), declared composite via
    // a globally stored manifest scoped to this root and two real child repos.
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
A: Yes, this regression test validates the full start -> commit -> merge composite path on a non-git project root declared by a scoped global manifest of two child repos.

## Tasks

### 1. Composite Task
**Repos**: api, web
Do it.
`;
    await hooks.tool!.hive_plan_write.execute({ content: plan, feature }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);

    // Start: composite mode, both repos resolved.
    const startRaw = await prepareTaskExecution(hooks,
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
      { feature, task: '01-composite-task', status: 'completed', summary: 'Non-git composite e2e. Tests pass.', message: TEST_COMMIT_MESSAGE },
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
    await stopPreparedExecution(hooks, toolContext);
    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: '01-composite-task', strategy: 'merge', message: TEST_MERGE_MESSAGE },
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

    const startRaw = await prepareTaskExecution(hooks,
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
      { feature, task: FIRST_TASK, status: 'completed', summary: 'Legacy single-root e2e. Tests pass.', message: TEST_COMMIT_MESSAGE },
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

    await stopPreparedExecution(hooks, toolContext);

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: FIRST_TASK, strategy: 'merge', message: TEST_MERGE_MESSAGE },
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

  it('end-to-end smoke: non-git project with a removed manifest root fails manifest-required and never auto-selects', async () => {
    expect(fs.existsSync(path.join(testRoot, '.git'))).toBe(false);
    initBareRepo(path.join(testRoot, 'repos', 'api'));
    const globalDir = path.join(testRoot, '.config', 'opencode');
    fs.mkdirSync(path.join(testRoot, 'another-project'), { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'agent_hive.json'),
      JSON.stringify({ repositoryRoot: path.join(testRoot, 'another-project'), repositories: [{ id: 'api', path: './repos/api' }] }, null, 2),
    );
    fs.rmSync(path.join(testRoot, 'another-project'), { recursive: true });

    const feature = 'no-manifest-global-ignored';
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_no_manifest_global_ignored');

    await hooks.tool!.hive_feature_create.execute({ name: feature }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      { content: createSingleTaskPlan('No Matching Manifest', 'Yes, this regression test validates that a non-git project without a matching global repositoryRoot fails with manifest-required wording and never auto-selects repositories scoped elsewhere.'), feature },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);

    await expect(
      prepareTaskExecution(hooks, { feature, task: FIRST_TASK }, toolContext),
    ).rejects.toThrow(/Repository manifest is required/);

    // No worktree directory created under either the legacy or composite path.
    const worktreeRoot = path.join(testRoot, '.hive', '.worktrees', feature, FIRST_TASK);
    expect(fs.existsSync(worktreeRoot)).toBe(false);
  });
});
function shell(): PluginInput['$'] {
  let value: PluginInput['$'];
  const fn = (() => { throw new Error('shell unavailable'); }) as unknown as PluginInput['$'];
  value = Object.assign(fn, {
    braces: (pattern: string) => [pattern],
    escape: (input: string) => input,
    env: () => value,
    cwd: () => value,
    nothrow: () => value,
    throws: () => value,
  });
  return value;
}

function initGit(root: string): void {
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email test@example.com', { cwd: root });
  execSync('git config user.name Test', { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'test\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.hive/\n');
  execSync('git add README.md .gitignore && git commit -m init', { cwd: root, stdio: 'ignore' });
}

function plan(title: string): string {
  return `# ${title}

## Discovery

**Q: Is managed execution ready for this fixture?**
A: Yes. The task must use one prepared execution, one unchanged native Forager call, authenticated child scope, and structured stop evidence.

Interview summary: this integration fixture covers the operator-selected armed attachment contract, worktree placement, prompt augmentation, context authorization, and terminal observation without generated native task payloads.

**Research:** the plugin hook owns parent/call attachment while hive-core owns durable execution state and exact worktree claims.

## Tasks

### 1. First Task
Implement it.
`;
}

async function harness(root: string, parentSessionID: string) {
  const parents = new Map<string, string>();
  const baseClient = OPENCODE_CLIENT as any;
  const client = {
    ...baseClient,
    session: {
      ...baseClient.session,
      get: async ({ path: inputPath }: { path: { id: string } }) => ({
        data: { id: inputPath.id, parentID: parents.get(inputPath.id), time: { created: Date.now(), updated: Date.now() } },
      }),
    },
  } as PluginInput['client'];
  const hooks = await plugin({
    directory: root,
    worktree: root,
    serverUrl: new URL('http://localhost:1'),
    project: { id: 'test', worktree: root, time: { created: Date.now() } },
    client,
    $: shell(),
  });
  await hooks['chat.message']?.({ sessionID: parentSessionID, agent: 'hive-master' }, {
    message: { agent: 'hive-master' }, parts: [],
  } as any);
  const context: ToolContext = {
    sessionID: parentSessionID,
    messageID: 'message',
    agent: 'hive-master',
    abort: new AbortController().signal,
  };
  return { hooks, context, parents };
}

async function seedFeature(hooks: Awaited<ReturnType<typeof plugin>>, context: ToolContext, feature: string): Promise<void> {
  await hooks.tool!.hive_feature_create.execute({ name: feature }, context);
  await hooks.tool!.hive_plan_write.execute({ content: plan(feature), feature }, context);
  await hooks.tool!.hive_plan_approve.execute({ feature }, context);
  await hooks.tool!.hive_tasks_sync.execute({ feature }, context);
}

async function prepareTask(
  hooks: Awaited<ReturnType<typeof plugin>>,
  context: ToolContext,
  feature: string,
  placement: Record<string, unknown> = { kind: 'worktree' },
) {
  return JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
    scope: { kind: 'task', feature, task: '01-first-task' },
    placement,
  }, context) as string);
}

async function bindChild(
  hooks: Awaited<ReturnType<typeof plugin>>,
  parents: Map<string, string>,
  parentSessionID: string,
  callID: string,
  childSessionID: string,
  agent = 'forager-worker',
): Promise<void> {
  parents.set(childSessionID, parentSessionID);
  await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: childSessionID, parentID: parentSessionID } } } } as any);
  await hooks.event?.({ event: { type: 'message.part.updated', properties: { part: {
    type: 'tool', tool: 'task', sessionID: parentSessionID, callID,
    state: { input: { subagent_type: agent }, metadata: { sessionId: childSessionID } },
  } } } } as any);
  await hooks['chat.message']?.({ sessionID: childSessionID, agent }, {
    message: { agent }, parts: [],
  } as any);
}

function configureForagerDerivative() {
  return spyOn(ConfigService.prototype, 'get').mockReturnValue({
    agents: {},
    customAgents: {
      'configured-forager': {
        baseAgent: 'forager-worker',
        description: 'Configured implementation worker',
      },
    },
  } as any);
}

describe('managed execution attachment', () => {
  let root: string;
  let oldBackground: string | undefined;

  beforeEach(() => {
    oldBackground = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    root = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'project-'));
    initGit(root);
  });

  afterEach(() => {
    if (oldBackground === undefined) delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    else process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = oldBackground;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
  });

  it('prepares concise task placement and attaches an unchanged native call', async () => {
    const { hooks, context } = await harness(root, 'primary');
    new FeatureService(root).create('feature-a');
    await hooks.tool!.hive_plan_write.execute({ content: plan('feature-a'), feature: 'feature-a' }, context);
    await hooks.tool!.hive_plan_approve.execute({ feature: 'feature-a' }, context);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'feature-a' }, context);
    await hooks.tool!.hive_context_write.execute({
      feature: 'feature-a',
      name: 'scope-reference',
      content: '---\ndescription: Scope reference fixture\nread_when: Testing execution scope paths\n---\n\nFixture.',
    }, context);
    const prepared = await prepareTask(hooks, context, 'feature-a');
    expect(prepared).toMatchObject({ success: true, phase: 'armed', scope: { kind: 'task', feature: 'feature-a', task: '01-first-task' } });
    expect(prepared).not.toHaveProperty('taskToolCall');
    expect(prepared).not.toHaveProperty('launchId');

    const args = { subagent_type: 'forager-worker', description: 'Implement task', prompt: 'Use the task spec.', background: false };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-a' }, { args });
    expect(Object.keys(args).sort()).toEqual(['background', 'description', 'prompt', 'subagent_type']);
    expect(args.prompt).toContain('Use the task spec.');
    expect(args.prompt).toContain('Feature: feature-a');
    const featureDirectory = fs.readdirSync(path.join(root, '.hive', 'features')).find(entry => entry.endsWith('_feature-a'))!;
    const specReference = `.hive/features/${featureDirectory}/tasks/01-first-task/spec.md`;
    const contextReference = `.hive/features/${featureDirectory}/context/`;
    expect(args.prompt).toContain(`Task spec: ${specReference}`);
    expect(args.prompt).toContain(`Feature context: ${contextReference}`);
    expect(fs.existsSync(path.join(root, specReference))).toBe(true);
    expect(fs.existsSync(path.join(root, contextReference))).toBe(true);
    expect(args.prompt).toContain('report and commit through hive_worktree_commit');
    expect(args.prompt).toContain('the primary owns both');
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)).toMatchObject({
      phase: 'attached',
      featureName: 'feature-a',
    });
  });

  it('denies another primary before creating Git resources for the same feature task', async () => {
    const owner = await harness(root, 'primary-owner');
    await seedFeature(owner.hooks, owner.context, 'feature-a');
    const live = path.join(root, 'live-owner');
    fs.mkdirSync(live);
    const prepared = await prepareTask(owner.hooks, owner.context, 'feature-a', { kind: 'in_place', directory: live });
    const branchesBefore = execSync('git branch --format="%(refname:short)"', { cwd: root, encoding: 'utf8' });
    const worktreesBefore = execSync('git worktree list --porcelain', { cwd: root, encoding: 'utf8' });
    const attemptsPath = path.join(root, '.hive', 'execution-attempts.json');
    const attemptsBefore = fs.readFileSync(attemptsPath, 'utf8');
    const taskWorktreePath = path.join(root, '.hive', '.worktrees', 'feature-a', '01-first-task');
    await owner.hooks['chat.message']?.({ sessionID: 'primary-other', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    } as any);

    const denied = await prepareTask(owner.hooks, { ...owner.context, sessionID: 'primary-other' }, 'feature-a');

    expect(denied).toMatchObject({
      success: false,
      reason: 'workspace_conflict_denied',
      mutation: 'none',
      attemptId: prepared.attemptId,
      phase: 'armed',
    });
    expect(execSync('git branch --format="%(refname:short)"', { cwd: root, encoding: 'utf8' })).toBe(branchesBefore);
    expect(execSync('git worktree list --porcelain', { cwd: root, encoding: 'utf8' })).toBe(worktreesBefore);
    expect(fs.existsSync(taskWorktreePath)).toBe(false);
    expect(fs.readFileSync(attemptsPath, 'utf8')).toBe(attemptsBefore);
  });

  it('preserves a winning feature placement when the winner finalizes before loser cleanup', async () => {
    const loser = await harness(root, 'primary-race-loser');
    await seedFeature(loser.hooks, loser.context, 'feature-a');
    const originalArm = ExecutionAttemptService.prototype.arm;
    const originalReserve = ExecutionAttemptService.prototype.reserveWorkspaceCleanup;
    let winnerId: string | undefined;
    const arm = spyOn(ExecutionAttemptService.prototype, 'arm').mockImplementation(function (input) {
      if (!winnerId && input.originatingPrimarySession === 'primary-race-loser') {
        winnerId = originalArm.call(this, { ...input, originatingPrimarySession: 'primary-race-winner' }).attempt.id;
      }
      return originalArm.call(this, input);
    });
    const reserve = spyOn(ExecutionAttemptService.prototype, 'reserveWorkspaceCleanup').mockImplementation(function (identities, protectedAttemptId) {
      if (!winnerId) throw new Error('Expected injected winner');
      this.closeArmNotStarted(winnerId);
      return originalReserve.call(this, identities, protectedAttemptId);
    });

    try {
      const denied = await prepareTask(loser.hooks, loser.context, 'feature-a');
      const worktreePath = path.join(root, '.hive', '.worktrees', 'feature-a', '01-first-task');

      expect(denied).toMatchObject({ success: false, reason: 'workspace_conflict_denied', mutation: 'none' });
      expect(execSync('git branch --format="%(refname:short)"', { cwd: root, encoding: 'utf8' })).toContain('hive/feature-a/01-first-task');
      expect(execSync('git worktree list --porcelain', { cwd: root, encoding: 'utf8' })).toContain(worktreePath);
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(new ExecutionAttemptService(root).getAttempt(denied.attemptId)).toMatchObject({
        id: winnerId,
        phase: 'finalized',
        observedOutcome: 'not_started',
        placement: { kind: 'worktree', workspacePath: fs.realpathSync(worktreePath) },
      });
    } finally {
      reserve.mockRestore();
      arm.mockRestore();
    }
  });

  it('removes a same-parent feature worktree that loses to an in-place arm', async () => {
    const loser = await harness(root, 'primary-feature-race');
    await seedFeature(loser.hooks, loser.context, 'feature-a');
    const liveDirectory = path.join(root, 'live-feature-race');
    fs.mkdirSync(liveDirectory);
    const branchesBefore = execSync('git branch --format="%(refname:short)"', { cwd: root, encoding: 'utf8' });
    const worktreesBefore = execSync('git worktree list --porcelain', { cwd: root, encoding: 'utf8' });
    const originalArm = ExecutionAttemptService.prototype.arm;
    let winnerId: string | undefined;
    const arm = spyOn(ExecutionAttemptService.prototype, 'arm').mockImplementation(function (input) {
      if (!winnerId && input.originatingPrimarySession === 'primary-feature-race') {
        winnerId = originalArm.call(this, {
          ...input,
          placement: { kind: 'in_place', directory: liveDirectory },
        }).attempt.id;
      }
      return originalArm.call(this, input);
    });

    try {
      const denied = await prepareTask(loser.hooks, loser.context, 'feature-a');
      const worktreePath = path.join(root, '.hive', '.worktrees', 'feature-a', '01-first-task');

      expect(denied).toMatchObject({
        success: false,
        reason: 'workspace_conflict_denied',
        mutation: 'none',
        attemptId: winnerId,
      });
      expect(execSync('git branch --format="%(refname:short)"', { cwd: root, encoding: 'utf8' })).toBe(branchesBefore);
      expect(execSync('git worktree list --porcelain', { cwd: root, encoding: 'utf8' })).toBe(worktreesBefore);
      expect(fs.existsSync(worktreePath)).toBe(false);
      const winner = JSON.parse(fs.readFileSync(path.join(root, '.hive', 'execution-attempts.json'), 'utf8'))
        .attempts.find((attempt: { id: string }) => attempt.id === winnerId);
      expect(winner).toMatchObject({
        phase: 'armed',
        placement: { kind: 'in_place', directory: fs.realpathSync(liveDirectory) },
      });
    } finally {
      arm.mockRestore();
    }
  });

  it('does not consume an arm for a non-Forager call and rejects a second Forager call', async () => {
    const { hooks, context } = await harness(root, 'primary');
    await seedFeature(hooks, context, 'feature-a');
    const prepared = await prepareTask(hooks, context, 'feature-a');
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-scout' }, {
      args: { subagent_type: 'scout-researcher', description: 'Inspect', prompt: 'Read only.' },
    });
    const persisted = JSON.parse(fs.readFileSync(path.join(root, '.hive', 'execution-attempts.json'), 'utf8'));
    expect(persisted.attempts.find((attempt: { id: string }) => attempt.id === prepared.attemptId).phase).toBe('armed');

    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-worker' }, {
      args: { subagent_type: 'forager-worker', description: 'Implement', prompt: 'Do it.' },
    });
    await expect(hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-worker-2' }, {
      args: { subagent_type: 'forager-worker', description: 'Duplicate', prompt: 'Do it again.' },
    })).rejects.toThrow(/no armed execution/i);
  });

  it('binds authenticated child scope for feature context and rejects cross-feature access', async () => {
    const { hooks, context, parents } = await harness(root, 'primary');
    await seedFeature(hooks, context, 'feature-a');
    await hooks.tool!.hive_context_write.execute({
      feature: 'feature-a', name: 'scope', content: '---\ndescription: Scope\nread_when: Test\n---\n\nA',
    }, context);
    await seedFeature(hooks, context, 'feature-b');
    await prepareTask(hooks, context, 'feature-a');
    const args = { subagent_type: 'forager-worker', description: 'Implement', prompt: 'Do it.' };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-context' }, { args });
    await bindChild(hooks, parents, 'primary', 'call-context', 'child-context');
    const childContext = { ...context, sessionID: 'child-context', agent: 'forager-worker' };

    const allowed = JSON.parse(await hooks.tool!.hive_context_read.execute({ name: 'scope' }, childContext) as string);
    expect(allowed.success).toBe(true);
    const denied = JSON.parse(await hooks.tool!.hive_context_read.execute({ feature: 'feature-b', name: 'scope' }, childContext) as string);
    expect(denied.reason).toBe('context_binding_mismatch');
  });

  it('preserves spoofed managed blocks and binds the dispatch-time constraint snapshot exactly once', async () => {
    const { hooks, context, parents } = await harness(root, 'primary');
    await hooks.tool!.hive_constraints_add.execute({ constraints: 'Keep the operator wording verbatim.' }, context);
    const live = path.join(root, 'live');
    fs.mkdirSync(live);
    await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'constraints' }, placement: { kind: 'in_place', directory: live },
    }, context);
    const callerPrompt = [
      'Primary prefix  ',
      '<!-- hive-execution-scope:start -->',
      'Caller scope evidence.',
      '<!-- hive-execution-scope:end -->',
      '<!-- hive-standing-constraints:start -->',
      'Caller constraint evidence.',
      '<!-- hive-standing-constraints:end -->',
      'Primary suffix  ',
    ].join('\n');
    const args = {
      subagent_type: 'forager-worker',
      description: 'Apply constraints',
      prompt: callerPrompt,
    };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-constraints' }, { args });
    const augmented = args.prompt;
    expect(augmented.slice(0, callerPrompt.length)).toBe(callerPrompt);
    expect(args.prompt).toContain('Keep the operator wording verbatim.');
    expect(args.prompt.match(/<!-- hive-execution-scope:start -->/g)).toHaveLength(2);
    expect(args.prompt.match(/<!-- hive-standing-constraints:start -->/g)).toHaveLength(2);

    await hooks.tool!.hive_constraints_add.execute({ constraints: 'Added after dispatch.' }, context);
    await bindChild(hooks, parents, 'primary', 'call-constraints', 'child-constraints');
    expect(new SessionService(root).getGlobal('child-constraints')).toMatchObject({
      standingConstraints: 'Keep the operator wording verbatim.',
      standingConstraintsRevision: 1,
    });
  });

  it('keeps undefined blocking output attached and releases prose-only blocking completion', async () => {
    const { hooks, context } = await harness(root, 'primary');
    const live = path.join(root, 'live');
    fs.mkdirSync(live);
    const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'blocking' }, placement: { kind: 'in_place', directory: live },
    }, context) as string);
    const args = { subagent_type: 'forager-worker', description: 'Implement', prompt: 'Do it.', background: false };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-blocking' }, { args });
    await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID: 'call-blocking', args } as any, undefined);
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)?.phase).toBe('attached');
    await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID: 'call-blocking', args } as any, { title: '', output: '', metadata: {} });
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)).toMatchObject({
      phase: 'finalized', observedOutcome: 'completed',
    });
  });

  it('finalizes background execution only from a correlated completion notification', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const { hooks, context, parents } = await harness(root, 'primary');
    const live = path.join(root, 'live');
    fs.mkdirSync(live);
    const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'background' }, placement: { kind: 'in_place', directory: live },
    }, context) as string);
    const args = { subagent_type: 'forager-worker', description: 'Background work', prompt: 'Do it.', background: true };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-background' }, { args });
    await bindChild(hooks, parents, 'primary', 'call-background', 'task-background');
    await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID: 'call-background', args } as any, {
      title: '', output: 'task_id: task-background', metadata: { sessionId: 'task-background' },
    });
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)?.phase).toBe('attached');

    const messages = [{
      info: { id: 'message', sessionID: 'primary', role: 'user', time: { created: Date.now() } },
      parts: [{
        id: 'part', sessionID: 'primary', messageID: 'message', type: 'text',
        text: '<task id="task-background" state="completed"><summary>Done</summary><task_result>Complete.</task_result></task>',
        synthetic: true,
      }],
    }];
    await hooks['experimental.chat.messages.transform']?.({}, { messages } as any);
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)).toMatchObject({
      phase: 'finalized', observedOutcome: 'completed',
    });
  });

  it.each(['completed', 'partial'] as const)('preserves an in-place %s task handoff without Git lifecycle guidance', async (status) => {
    const { hooks, context, parents } = await harness(root, 'primary');
    await seedFeature(hooks, context, 'feature-a');
    const live = path.join(root, 'live');
    fs.mkdirSync(live);
    const prepared = await prepareTask(hooks, context, 'feature-a', { kind: 'in_place', directory: live });
    const args = { subagent_type: 'forager-worker', description: 'Edit live files', prompt: 'Do it.', background: false };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-live' }, { args });
    await bindChild(hooks, parents, 'primary', 'call-live', 'child-live');
    fs.writeFileSync(path.join(live, 'result.txt'), 'live result\n');
    const headBefore = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();

    const handoff = JSON.parse(await hooks.tool!.hive_worktree_commit.execute({
      feature: 'feature-a', task: '01-first-task', status, summary: `Live edit ${status}; verification not run.`,
    }, { ...context, sessionID: 'child-live', agent: 'forager-worker' }) as string);
    expect(handoff).toMatchObject({
      ok: true,
      terminal: true,
      status,
      handoff: { kind: 'report_only', gitOperation: 'not_requested' },
    });
    expect(handoff).not.toHaveProperty('commit');
    expect(JSON.stringify(handoff)).not.toMatch(/hive_merge|\bmerge\b|\bcleanup\b|\bworktree\b/i);
    expect(execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim()).toBe(headBefore);

    await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID: 'call-live', args } as any, {
      title: '', output: `${status} handoff recorded.`, metadata: { sessionId: 'child-live' },
    });
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)).toMatchObject({
      phase: 'finalized', handoffOutcome: status, observedOutcome: status,
    });
  });

  it('rejects a stopped feature-task handoff before Git or report mutation', async () => {
    const { hooks, context, parents } = await harness(root, 'primary');
    await seedFeature(hooks, context, 'feature-a');
    const prepared = await prepareTask(hooks, context, 'feature-a');
    const args = { subagent_type: 'forager-worker', description: 'Stop before handoff', prompt: 'Do it.', background: false };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-stopped-feature' }, { args });
    await bindChild(hooks, parents, 'primary', 'call-stopped-feature', 'child-stopped-feature');
    const attempts = new ExecutionAttemptService(root);
    attempts.observeBlockingStop({
      originatingPrimarySession: 'primary',
      nativeCallId: 'call-stopped-feature',
      outputDefined: true,
    });
    fs.writeFileSync(path.join(prepared.placement.workspacePath, 'stopped-feature.txt'), 'must remain uncommitted\n');
    const headBefore = execSync('git rev-parse HEAD', { cwd: prepared.placement.workspacePath, encoding: 'utf8' }).trim();

    const denied = JSON.parse(await hooks.tool!.hive_worktree_commit.execute({
      feature: 'feature-a', task: '01-first-task', status: 'completed',
      summary: 'This stopped handoff must be rejected. Test intentionally not run.',
      message: 'test: reject stopped handoff\n\nThis commit must never be created.',
    }, { ...context, sessionID: 'child-stopped-feature', agent: 'forager-worker' }) as string);

    expect(denied).toMatchObject({ ok: false, terminal: false, reason: 'workspace_conflict_denied', mutation: 'none' });
    expect(execSync('git rev-parse HEAD', { cwd: prepared.placement.workspacePath, encoding: 'utf8' }).trim()).toBe(headBefore);
    expect(attempts.getAttempt(prepared.attemptId)).toMatchObject({ phase: 'stopped' });
    expect(() => attempts.assertWorkspacesIdle(prepared.placement.workspaceIdentities)).toThrow(/claimed/i);
  });

  it('finalizes a background feature handoff before merge', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const { hooks, context, parents } = await harness(root, 'primary');
    await seedFeature(hooks, context, 'feature-a');
    const prepared = await prepareTask(hooks, context, 'feature-a');
    const args = { subagent_type: 'forager-worker', description: 'Background change', prompt: 'Do it.', background: true };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-feature-background' }, { args });
    await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID: 'call-feature-background', args } as any, {
      title: '', output: 'task_id: child-feature-background', metadata: { sessionId: 'child-feature-background' },
    });
    await bindChild(hooks, parents, 'primary', 'call-feature-background', 'child-feature-background');
    fs.writeFileSync(path.join(prepared.placement.workspacePath, 'feature-result.txt'), 'feature result\n');
    const childContext = { ...context, sessionID: 'child-feature-background', agent: 'forager-worker' };
    const handoff = JSON.parse(await hooks.tool!.hive_worktree_commit.execute({
      feature: 'feature-a', task: '01-first-task', status: 'completed',
      summary: 'Implemented the background change. Test fixture verified.',
      message: 'feat: add feature result\n\nRecord the background worker result for merge verification.',
    }, childContext) as string);
    expect(handoff).toMatchObject({ ok: true, terminal: true, status: 'completed' });

    await hooks['experimental.chat.messages.transform']?.({}, { messages: [{
      info: { id: 'message', sessionID: 'primary', role: 'user', time: { created: Date.now() } },
      parts: [{
        id: 'part', sessionID: 'primary', messageID: 'message', type: 'text', synthetic: true,
        text: '<task id="child-feature-background" state="completed"><summary>Done</summary><task_result>Complete.</task_result></task>',
      }],
    }] } as any);
    expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)).toMatchObject({
      phase: 'finalized', handoffOutcome: 'completed', observedOutcome: 'completed',
    });

    const merged = JSON.parse(await hooks.tool!.hive_merge.execute({
      feature: 'feature-a', task: '01-first-task', strategy: 'squash',
      message: 'feat: merge feature result\n\nIntegrate the authenticated background worker handoff.',
    }, context) as string);
    expect(merged.success).toBe(true);
    expect(fs.readFileSync(path.join(root, 'feature-result.txt'), 'utf8')).toBe('feature result\n');
  });

  it('records an ad-hoc commit disposition and releases it after blocking stop evidence', async () => {
    const configured = configureForagerDerivative();
    try {
      const { hooks, context, parents } = await harness(root, 'primary');
      const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
        scope: { kind: 'adhoc', runId: 'adhoc-bridge' }, placement: { kind: 'worktree' },
      }, context) as string);
      const args = { subagent_type: 'configured-forager', description: 'Ad-hoc change', prompt: 'Do it.', background: false };
      await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID: 'call-adhoc' }, { args });
      expect(args.prompt).toContain('report and commit through hive_adhoc_worktree_commit');
      expect(args.prompt).toContain('the primary owns both');
      await bindChild(hooks, parents, 'primary', 'call-adhoc', 'child-adhoc', 'configured-forager');
      fs.writeFileSync(path.join(prepared.placement.workspacePath, 'adhoc-result.txt'), 'ad-hoc result\n');
      const committed = JSON.parse(await hooks.tool!.hive_adhoc_worktree_commit.execute({
        runId: 'adhoc-bridge', workspacePath: prepared.placement.workspacePath, branch: prepared.placement.branch,
        message: 'feat: add ad-hoc result\n\nRecord the ad-hoc bridge disposition before native stop.',
      }, { ...context, sessionID: 'child-adhoc', agent: 'configured-forager' }) as string);
      expect(committed.success).toBe(true);

      await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID: 'call-adhoc', args } as any, {
        title: '', output: 'Ad-hoc handoff recorded.', metadata: { sessionId: 'child-adhoc' },
      });
      expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)).toMatchObject({
        phase: 'finalized', handoffOutcome: 'completed', observedOutcome: 'completed',
      });

      const merged = JSON.parse(await hooks.tool!.hive_adhoc_merge.execute({
        runId: 'adhoc-bridge', strategy: 'squash',
        message: 'feat: merge ad-hoc result\n\nIntegrate the authenticated ad-hoc worker handoff.',
      }, context) as string);
      expect(merged.success).toBe(true);
      expect(fs.readFileSync(path.join(root, 'adhoc-result.txt'), 'utf8')).toBe('ad-hoc result\n');
    } finally {
      configured.mockRestore();
    }
  });

  it('preserves partial and failed ad-hoc commit dispositions through native completion', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const configured = configureForagerDerivative();
    const commit = spyOn(AdhocWorktreeService.prototype, 'commit')
      .mockResolvedValueOnce({
        committed: true, sha: 'partial-sha', message: 'partial commit', partial: true, error: 'second repository failed',
        phase: 'integration', mutation: 'partial', retryable: false, action: 'manual_recovery',
      })
      .mockResolvedValueOnce({
        committed: false, sha: '', message: 'commit failed', error: 'injected commit failure',
        phase: 'integration', mutation: 'none', retryable: true, action: 'retry_same_operation',
      });
    try {
      const { hooks, context, parents } = await harness(root, 'primary');
      for (const outcome of ['partial', 'failed'] as const) {
        const runId = `adhoc-${outcome}`;
        const callID = `call-${outcome}`;
        const childID = `child-${outcome}`;
        const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
          scope: { kind: 'adhoc', runId }, placement: { kind: 'worktree' },
        }, context) as string);
        const background = outcome === 'partial';
        const args = { subagent_type: 'configured-forager', description: `${outcome} commit`, prompt: 'Do it.', background };
        await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary', callID }, { args });
        await bindChild(hooks, parents, 'primary', callID, childID, 'configured-forager');
        if (background) {
          await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID, args } as any, {
            title: '', output: `task_id: ${childID}`, metadata: { sessionId: childID },
          });
        }

        const result = JSON.parse(await hooks.tool!.hive_adhoc_worktree_commit.execute({
          runId, workspacePath: prepared.placement.workspacePath, branch: prepared.placement.branch,
          message: `test: ${outcome} ad-hoc commit\n\nExercise durable ${outcome} bridge disposition.`,
        }, { ...context, sessionID: childID, agent: 'configured-forager' }) as string);
        expect(result.success).toBe(false);
        expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)?.handoffOutcome).toBe(outcome);

        if (background) {
          await hooks['experimental.chat.messages.transform']?.({}, { messages: [{
            info: { id: `message-${outcome}`, sessionID: 'primary', role: 'user', time: { created: Date.now() } },
            parts: [{
              id: `part-${outcome}`, sessionID: 'primary', messageID: `message-${outcome}`, type: 'text', synthetic: true,
              text: `<task id="${childID}" state="completed"><summary>Done</summary><task_result>${outcome} handoff returned.</task_result></task>`,
            }],
          }] } as any);
        } else {
          await hooks['tool.execute.after']!({ tool: 'task', sessionID: 'primary', callID, args } as any, {
            title: '', output: `${outcome} handoff returned.`, metadata: { sessionId: childID },
          });
        }
        expect(new ExecutionAttemptService(root).getAttempt(prepared.attemptId)).toMatchObject({
          phase: 'finalized', handoffOutcome: outcome, observedOutcome: outcome,
        });
      }
    } finally {
      commit.mockRestore();
      configured.mockRestore();
    }
  });

  it('closes an unattached arm on plugin restart and preserves an attached quarantine', async () => {
    const first = await harness(root, 'primary-a');
    const liveA = path.join(root, 'live-a');
    fs.mkdirSync(liveA);
    const arm = JSON.parse(await first.hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'unattached' }, placement: { kind: 'in_place', directory: liveA },
    }, first.context) as string);
    await harness(root, 'primary-restart');
    let persisted = JSON.parse(fs.readFileSync(path.join(root, '.hive', 'execution-attempts.json'), 'utf8'));
    expect(persisted.attempts.find((attempt: { id: string }) => attempt.id === arm.attemptId)).toMatchObject({ phase: 'finalized', observedOutcome: 'not_started' });

    const second = await harness(root, 'primary-b');
    const liveB = path.join(root, 'live-b');
    fs.mkdirSync(liveB);
    const attached = JSON.parse(await second.hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'attached' }, placement: { kind: 'in_place', directory: liveB },
    }, second.context) as string);
    await second.hooks['tool.execute.before']!({ tool: 'task', sessionID: 'primary-b', callID: 'call-attached' }, {
      args: { subagent_type: 'forager-worker', description: 'Attach', prompt: 'Do it.' },
    });
    await harness(root, 'primary-restart-2');
    persisted = JSON.parse(fs.readFileSync(path.join(root, '.hive', 'execution-attempts.json'), 'utf8'));
    expect(persisted.attempts.find((attempt: { id: string }) => attempt.id === attached.attemptId)?.phase).toBe('attached');
  });
});
