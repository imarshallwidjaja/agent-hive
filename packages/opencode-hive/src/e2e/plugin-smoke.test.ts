import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { execSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PluginInput } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { Schema } from 'effect';
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
import { BackgroundJobService, ContextMutationError, ContextService, CUSTOM_AGENT_BASES, DEFAULT_ROUTING_AGENT_DESCRIPTIONS, FeatureService, SessionService, WorktreeService, AdhocWorktreeService } from 'hive-core';

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

## Tasks

### 1. First Task
Do it
`;
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
  });

  it.each([false, true])('rejects raw %s-background forager dispatch before creating a child', async (background) => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, `raw-forager-${background}`);

    await expect(hooks['tool.execute.before']?.({
      tool: 'task',
      sessionID: toolContext.sessionID,
      callID: `raw-forager-call-${background}`,
    }, {
      args: {
        subagent_type: 'forager-worker',
        description: 'Raw implementation launch',
        prompt: 'Implement without preparing a Hive worktree',
        ...(background ? { background: true } : {}),
      },
    })).rejects.toThrow(/launch_binding_error[\s\S]*non-empty hive_launch_id/i);

    if (!background) {
      await expect(hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
      }, {
        args: { subagent_type: 'forager-worker', description: 'Missing call ID', prompt: 'Do work', hive_launch_id: randomUUID() },
      })).rejects.toThrow(/launch_binding_error[\s\S]*call ID/);
    }
  });

  it('rejects hive_launch_id on an incompatible ordinary task target', async () => {
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'incompatible-launch-id');
    await expect(hooks['tool.execute.before']?.({
      tool: 'task', sessionID: toolContext.sessionID, callID: 'ordinary-scout',
    }, {
      args: {
        subagent_type: 'scout-researcher',
        description: 'Inspect code',
        prompt: 'Read only',
        hive_launch_id: randomUUID(),
      },
    })).rejects.toThrow(/hive_launch_id is valid only for a Forager-derived task target/);
  });

  it('binds an authenticated ad-hoc overlay by claimed identity despite caller prose edits', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const configPath = path.join(testRoot, '.config', 'opencode', 'agent_hive.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      customAgents: {
        'forager-domain': { baseAgent: 'forager-worker', description: 'Domain implementation' },
      },
    }));
    const parent = 'adhoc-parent';
    const child = 'adhoc-child';
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: { ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: { id: input.id, parentID: input.id === child ? parent : undefined } }),
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);

    const workspaceOnly = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'workspace-only',
      autoSpawnWorker: false,
    }, toolContext) as string);
    expect(workspaceOnly.taskToolCall).toBeUndefined();
    await expect(hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'workspace-only-call' }, {
      args: { subagent_type: 'forager-worker', description: 'Workspace only', prompt: 'No launch intent exists' },
    })).rejects.toThrow(/launch_binding_error[\s\S]*non-empty hive_launch_id/);

    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'claimed-adhoc',
      workerInstructions: 'Implement the bounded change.',
    }, toolContext) as string);
    const dispatch = { args: {
      ...launch.backgroundTaskCall,
      subagent_type: 'forager-domain',
      description: 'Caller-edited description',
      prompt: 'Caller-edited ad-hoc instructions',
    } };
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'claimed-adhoc-call' }, dispatch);
    const boardPath = path.join(testRoot, '.hive', 'background-jobs.json');
    expect(JSON.parse(fs.readFileSync(boardPath, 'utf8')).pendingLaunches).toEqual([
      expect.objectContaining({ disposition: 'claimed', callId: 'claimed-adhoc-call' }),
    ]);
    await hooks.event?.({ event: {
      type: 'session.created',
      properties: { info: { id: child, parentID: parent } },
    } } as any);
    await observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID: 'claimed-adhoc-call',
      childSessionID: child,
      expectedAgent: 'forager-domain',
    });
    await hooks['chat.message']?.({ sessionID: child, agent: 'forager-domain' }, {
      message: { agent: 'forager-domain' }, parts: [],
    } as any);
    const authority = JSON.parse(await hooks.tool!.hive_context_read.execute(
      { scope: 'project', view: 'catalog' },
      { ...toolContext, sessionID: child, agent: 'forager-domain' },
    ) as string);
    expect(authority.success).toBe(true);
    await hooks['tool.execute.after']?.(
      { tool: 'task', sessionID: parent, callID: 'claimed-adhoc-call', args: dispatch.args },
      { title: 'task', output: 'done', metadata: { sessionId: child } },
    );
    expect(new SessionService(testRoot).getGlobal(child)).toMatchObject({
      parentSessionId: parent,
      adHocRunId: 'claimed-adhoc',
      agent: 'forager-domain',
      baseAgent: 'forager-worker',
      sessionKind: 'task-worker',
    });
  }, 30_000);

  it('rejects wrong-parent, expired, and restarted-runtime ad-hoc launch intents', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'intent-parent';
    const otherParent = 'intent-other-parent';
    const initial = await createHooksForTest(testRoot, parent);
    await initial.hooks['chat.message']?.({ sessionID: otherParent, agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    } as any);
    const wrongParentLaunch = JSON.parse(await initial.hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'wrong-parent-run', workerInstructions: 'Implement one change.',
    }, initial.toolContext) as string);
    await expect(initial.hooks['tool.execute.before']?.({ tool: 'task', sessionID: otherParent, callID: 'wrong-parent-call' }, {
      args: { ...wrongParentLaunch.backgroundTaskCall },
    })).rejects.toThrow(/launch_binding_error[\s\S]*different authenticated parent/);

    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);
    try {
      await expect(initial.hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'expired-call' }, {
        args: { ...wrongParentLaunch.backgroundTaskCall },
      })).rejects.toThrow(/launch_binding_error[\s\S]*expired/);
    } finally {
      clock.mockRestore();
    }

    const restartedLaunch = JSON.parse(await initial.hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'restart-run', workerInstructions: 'Implement after restart.',
    }, initial.toolContext) as string);
    const fresh = await createHooksForTest(testRoot, parent);
    await expect(fresh.hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'restart-call' }, {
      args: { ...restartedLaunch.backgroundTaskCall },
    })).rejects.toThrow(/launch_binding_error[\s\S]*earlier plugin runtime/);
  }, 30_000);

  it('does not let an older same-agent child consume the prepared forager launch claim', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'claim-theft-parent';
    const olderChild = 'claim-older-child';
    const realChild = 'claim-real-child';
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: { ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: { id: input.id, parentID: input.id === olderChild || input.id === realChild ? parent : undefined } }),
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);

    await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: olderChild, parentID: parent } } } } as any);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'theft-run',
      workerInstructions: 'Implement one bounded change.',
    }, toolContext) as string);
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'theft-call' }, {
      args: { ...launch.backgroundTaskCall },
    });

    await expect(hooks['chat.message']?.({ sessionID: olderChild, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any)).rejects.toThrow(/launch_binding_error[\s\S]*correlation/i);
    const sessions = new SessionService(testRoot);
    expect(sessions.getGlobal(olderChild)?.adHocRunId).toBeUndefined();
    expect(sessions.getGlobal(olderChild)?.sessionKind).not.toBe('task-worker');

    await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: realChild, parentID: parent } } } } as any);
    await observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID: 'theft-call',
      childSessionID: realChild,
      expectedAgent: 'forager-worker',
    });
    await hooks['chat.message']?.({ sessionID: realChild, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    expect(sessions.getGlobal(realChild)).toMatchObject({
      parentSessionId: parent,
      adHocRunId: 'theft-run',
      agent: 'forager-worker',
      baseAgent: 'forager-worker',
      sessionKind: 'task-worker',
    });
  }, 30_000);

  it.each([
    ['wrong parent', 'correlation-parent-other', 'forager-worker', 'forager-worker', 'forager-worker'],
    ['wrong selected agent', 'correlation-parent', 'forager-domain', 'forager-worker', 'forager-domain'],
    ['wrong correlated expected agent', 'correlation-parent', 'forager-worker', 'forager-worker', 'forager-domain'],
  ])('rejects native child correlation with %s before persisting worker authority', async (_case, correlatedParent, selectedAgent, observedAgent, expectedAgent) => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'correlation-parent';
    const child = `correlation-child-${_case.replaceAll(' ', '-')}`;
    const configPath = path.join(testRoot, '.config', 'opencode', 'agent_hive.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      customAgents: { 'forager-domain': { baseAgent: 'forager-worker', description: 'Domain implementation' } },
    }));
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: { ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: { id: input.id, parentID: input.id === child ? parent : undefined } }),
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: `correlation-${_case.replaceAll(' ', '-')}`,
      workerInstructions: 'Implement one bounded change.',
    }, toolContext) as string);
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: `call-${_case}` }, {
      args: { ...launch.backgroundTaskCall, subagent_type: selectedAgent },
    });
    await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: child, parentID: parent } } } } as any);
    await observeNativeTaskChild(hooks, {
      parentSessionID: correlatedParent,
      callID: `call-${_case}`,
      childSessionID: child,
      expectedAgent,
    });

    await expect(hooks['chat.message']?.({ sessionID: child, agent: observedAgent }, {
      message: { agent: observedAgent }, parts: [],
    } as any)).rejects.toThrow(/launch_binding_error/);
    expect(new SessionService(testRoot).getGlobal(child)?.adHocRunId).toBeUndefined();
    expect(new SessionService(testRoot).getGlobal(child)?.sessionKind).not.toBe('task-worker');
  }, 30_000);

  it('binds in native host order before the task after-hook exposes the child', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'native-order-parent';
    const child = 'native-order-child';
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: { ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: { id: input.id, parentID: input.id === child ? parent : undefined } }),
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'native-order-run', workerInstructions: 'Implement one bounded change.',
    }, toolContext) as string);
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'native-order-call' }, {
      args: { ...launch.backgroundTaskCall },
    });
    const createdObservation = hooks.event?.({ event: { type: 'session.created', properties: { info: { id: child, parentID: parent } } } } as any);
    const taskObservation = observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID: 'native-order-call',
      childSessionID: child,
      expectedAgent: 'forager-worker',
    });
    const duplicateTaskObservation = observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID: 'native-order-call',
      childSessionID: child,
      expectedAgent: 'forager-worker',
    });
    await hooks['chat.message']?.({ sessionID: child, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    await Promise.all([createdObservation, taskObservation, duplicateTaskObservation]);

    const firstTool = JSON.parse(await hooks.tool!.hive_context_read.execute(
      { scope: 'project', view: 'catalog' },
      { ...toolContext, sessionID: child, agent: 'forager-worker' },
    ) as string);
    expect(firstTool.success).toBe(true);
    expect(new SessionService(testRoot).getGlobal(child)).toMatchObject({
      parentSessionId: parent,
      adHocRunId: 'native-order-run',
      agent: 'forager-worker',
      sessionKind: 'task-worker',
    });
  }, 30_000);

  it('keeps an unbound launch claim when a metadata-free task after-hook precedes native correlation', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'metadata-free-after-parent';
    const child = 'metadata-free-after-child';
    const callID = 'metadata-free-after-call';
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: { ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: { id: input.id, parentID: input.id === child ? parent : undefined } }),
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'metadata-free-after-run', workerInstructions: 'Implement one bounded change.',
    }, toolContext) as string);
    const dispatch = { args: { ...launch.backgroundTaskCall } };
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID }, dispatch);

    await hooks['tool.execute.after']?.(
      { tool: 'task', sessionID: parent, callID, args: dispatch.args },
      { title: 'task', output: 'running', metadata: {} },
    );
    await observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID,
      childSessionID: child,
      expectedAgent: 'forager-worker',
    });
    await hooks['chat.message']?.({ sessionID: child, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);

    const firstTool = JSON.parse(await hooks.tool!.hive_context_read.execute(
      { scope: 'project', view: 'catalog' },
      { ...toolContext, sessionID: child, agent: 'forager-worker' },
    ) as string);
    expect(firstTool.success).toBe(true);
    expect(new SessionService(testRoot).getGlobal(child)).toMatchObject({
      parentSessionId: parent,
      adHocRunId: 'metadata-free-after-run',
      sessionKind: 'task-worker',
    });
  }, 30_000);

  it('cleans up a bound launch after metadata-free completion while preserving its replay guard', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'bound-metadata-free-parent';
    const child = 'bound-metadata-free-child';
    const replacementChild = 'bound-metadata-free-replacement';
    const callID = 'bound-metadata-free-call';
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: { ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: {
          id: input.id,
          parentID: input.id === child || input.id === replacementChild ? parent : undefined,
        } }),
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'bound-metadata-free-run', workerInstructions: 'Implement one bounded change.',
    }, toolContext) as string);
    const dispatch = { args: { ...launch.backgroundTaskCall } };
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID }, dispatch);
    await observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID,
      childSessionID: child,
      expectedAgent: 'forager-worker',
    });
    await hooks['chat.message']?.({ sessionID: child, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    await hooks['tool.execute.after']?.(
      { tool: 'task', sessionID: parent, callID, args: dispatch.args },
      { title: 'task', output: 'running', metadata: {} },
    );

    await expect(hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID }, {
      args: { ...launch.backgroundTaskCall },
    })).rejects.toThrow(/reused session\/tool callID|already claimed/);

    const replacement = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'bound-metadata-free-replacement-run', workerInstructions: 'Implement the replacement change.',
    }, toolContext) as string);
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'bound-metadata-free-replacement-call' }, {
      args: { ...replacement.backgroundTaskCall },
    });
    await observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID: 'bound-metadata-free-replacement-call',
      childSessionID: replacementChild,
      expectedAgent: 'forager-worker',
    });
    await hooks['chat.message']?.({ sessionID: replacementChild, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    expect(new SessionService(testRoot).getGlobal(replacementChild)?.adHocRunId).toBe('bound-metadata-free-replacement-run');
  }, 30_000);

  it('retires only a denied correlated claim so the parent can dispatch a fresh launch', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'denied-correlation-recovery-parent';
    const olderChild = 'denied-correlation-older-child';
    const deniedChild = 'denied-correlation-rejected-child';
    const freshChild = 'denied-correlation-fresh-child';
    const childIDs = new Set([olderChild, deniedChild, freshChild]);
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: { ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: { id: input.id, parentID: childIDs.has(input.id) ? parent : undefined } }),
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);

    const bindLaunch = async (runId: string, callID: string, childSessionID: string): Promise<void> => {
      const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
        runId, workerInstructions: 'Implement one bounded change.',
      }, toolContext) as string);
      await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID }, {
        args: { ...launch.backgroundTaskCall },
      });
      await observeNativeTaskChild(hooks, {
        parentSessionID: parent,
        callID,
        childSessionID,
        expectedAgent: 'forager-worker',
      });
      await hooks['chat.message']?.({ sessionID: childSessionID, agent: 'forager-worker' }, {
        message: { agent: 'forager-worker' }, parts: [],
      } as any);
    };

    await bindLaunch('denied-correlation-older-run', 'denied-correlation-older-call', olderChild);

    const rejectedLaunch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'denied-correlation-rejected-run', workerInstructions: 'Implement one bounded change.',
    }, toolContext) as string);
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'denied-correlation-rejected-call' }, {
      args: { ...rejectedLaunch.backgroundTaskCall },
    });
    await observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID: 'denied-correlation-rejected-call',
      childSessionID: deniedChild,
      expectedAgent: 'forager-domain',
    });
    await expect(hooks['chat.message']?.({ sessionID: deniedChild, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any)).rejects.toThrow(/launch_binding_error[\s\S]*metadata agent/);

    await bindLaunch('denied-correlation-fresh-run', 'denied-correlation-fresh-call', freshChild);
    for (const [childSessionID, runId] of [
      [olderChild, 'denied-correlation-older-run'],
      [freshChild, 'denied-correlation-fresh-run'],
    ] as const) {
      const firstTool = JSON.parse(await hooks.tool!.hive_context_read.execute(
        { scope: 'project', view: 'catalog' },
        { ...toolContext, sessionID: childSessionID, agent: 'forager-worker' },
      ) as string);
      expect(firstTool.success).toBe(true);
      expect(new SessionService(testRoot).getGlobal(childSessionID)?.adHocRunId).toBe(runId);
    }
    expect(new SessionService(testRoot).getGlobal(deniedChild)?.adHocRunId).toBeUndefined();
  }, 30_000);

  it('fences a task re-preparation while its prior claimed writer is unresolved', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'superseded-child-first-parent';
    const rejectedChild = 'superseded-child-first-rejected';
    const replacementChild = 'superseded-child-first-replacement';
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: { ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: {
          id: input.id,
          parentID: input.id === rejectedChild || input.id === replacementChild ? parent : undefined,
        } }),
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    await hooks.tool!.hive_feature_create.execute({ name: 'superseded-child-first' }, toolContext);
    await hooks.tool!.hive_plan_write.execute({
      feature: 'superseded-child-first',
      content: createSingleTaskPlan(
        'Superseded child first',
        'This integration test supersedes a positively correlated child before its after-hook, then proves that only the rejected claim is retired and its replacement can bind.',
      ),
    }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature: 'superseded-child-first' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'superseded-child-first' }, toolContext);

    const rejectedLaunch = JSON.parse(await hooks.tool!.hive_worktree_start.execute({
      feature: 'superseded-child-first', task: FIRST_TASK,
    }, toolContext) as string);
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'superseded-child-first-rejected-call' }, {
      args: { ...rejectedLaunch.backgroundTaskCall },
    });
    await observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID: 'superseded-child-first-rejected-call',
      childSessionID: rejectedChild,
      expectedAgent: 'forager-worker',
    });

    await expect(hooks.tool!.hive_worktree_start.execute({
      feature: 'superseded-child-first', task: FIRST_TASK,
    }, toolContext)).rejects.toThrow(/writer_fence_error[\s\S]*prior claimed launch/);
    expect(new SessionService(testRoot).getGlobal(replacementChild)).toBeUndefined();
  }, 30_000);

  it('archives only the matching parent launch without releasing its writer call', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'deleted-correlation-parent';
    const otherParent = 'deleted-correlation-other-parent';
    const deletedChild = 'deleted-correlation-child';
    const replacementChild = 'deleted-correlation-replacement';
    const otherChild = 'deleted-correlation-other-child';
    const callID = 'deleted-correlation-call';
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: { ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: {
          id: input.id,
          parentID: input.id === deletedChild || input.id === replacementChild
            ? parent
            : input.id === otherChild
              ? otherParent
              : undefined,
        } }),
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    const otherToolContext = createToolContext(otherParent);
    await hooks['chat.message']?.({ sessionID: otherParent, agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    } as any);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'deleted-correlation-run', workerInstructions: 'Implement one bounded change.',
    }, toolContext) as string);
    const otherLaunch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'deleted-correlation-other-run', workerInstructions: 'Implement an unrelated bounded change.',
    }, otherToolContext) as string);
    const dispatch = { args: { ...launch.backgroundTaskCall } };
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID }, dispatch);
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: otherParent, callID: 'deleted-correlation-other-call' }, {
      args: { ...otherLaunch.backgroundTaskCall },
    });
    await observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID,
      childSessionID: deletedChild,
      expectedAgent: 'forager-worker',
    });
    await hooks['tool.execute.after']?.(
      { tool: 'task', sessionID: parent, callID, args: dispatch.args },
      { title: 'task', output: 'running', metadata: {} },
    );
    await hooks.event?.({ event: { type: 'session.deleted', properties: { info: { id: parent } } } } as any);
    const retiredLaunches = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'background-jobs.json'), 'utf8')).pendingLaunches;
    expect(retiredLaunches.find((pending: any) => pending.scope?.adHocRunId === 'deleted-correlation-run')).toMatchObject({
      disposition: 'claimed',
      archivedAt: expect.any(String),
      archiveReason: 'ignored',
    });
    expect(retiredLaunches.find((pending: any) => pending.scope?.adHocRunId === 'deleted-correlation-other-run')?.archivedAt).toBeUndefined();
    await hooks['chat.message']?.({ sessionID: parent, agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    } as any);

    const replacementLaunch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'deleted-correlation-replacement-run', workerInstructions: 'Implement the replacement bounded change.',
    }, toolContext) as string);
    await expect(hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID }, {
      args: { ...replacementLaunch.backgroundTaskCall },
    })).rejects.toThrow(/launch_binding_error[\s\S]*already claimed/);
    const replacementCallID = 'deleted-correlation-replacement-call';
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: replacementCallID }, {
      args: { ...replacementLaunch.backgroundTaskCall },
    });
    await observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID: replacementCallID,
      childSessionID: replacementChild,
      expectedAgent: 'forager-worker',
    });
    await hooks['chat.message']?.({ sessionID: replacementChild, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    await observeNativeTaskChild(hooks, {
      parentSessionID: otherParent,
      callID: 'deleted-correlation-other-call',
      childSessionID: otherChild,
      expectedAgent: 'forager-worker',
    });
    await hooks['chat.message']?.({ sessionID: otherChild, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);

    const firstTool = JSON.parse(await hooks.tool!.hive_context_read.execute(
      { scope: 'project', view: 'catalog' },
      { ...toolContext, sessionID: replacementChild, agent: 'forager-worker' },
    ) as string);
    expect(firstTool.success).toBe(true);
    expect(new SessionService(testRoot).getGlobal(replacementChild)?.adHocRunId).toBe('deleted-correlation-replacement-run');
    expect(new SessionService(testRoot).getGlobal(otherChild)?.adHocRunId).toBe('deleted-correlation-other-run');
  }, 30_000);

  it.each(['after-before-message', 'message-before-after'])('preserves exact background binding when %s', async (ordering) => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = `background-order-parent-${ordering}`;
    const child = `background-order-child-${ordering}`;
    const callID = `background-order-call-${ordering}`;
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, ROOT_SESSION_CLIENT);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: `background-order-run-${ordering}`, workerInstructions: 'Implement one bounded change.',
    }, toolContext) as string);
    const dispatch = { args: { ...launch.backgroundTaskCall } };
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID }, dispatch);
    await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: child, parentID: parent } } } } as any);
    await observeNativeTaskChild(hooks, { parentSessionID: parent, callID, childSessionID: child, expectedAgent: 'forager-worker' });
    const after = () => hooks['tool.execute.after']?.(
      { tool: 'task', sessionID: parent, callID, args: dispatch.args },
      { title: 'task', output: 'running', metadata: { sessionId: child } },
    );
    const message = () => hooks['chat.message']?.({ sessionID: child, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    if (ordering === 'after-before-message') {
      await after();
      await message();
    } else {
      await message();
      await after();
    }
    expect(new SessionService(testRoot).getGlobal(child)).toMatchObject({
      parentSessionId: parent,
      adHocRunId: `background-order-run-${ordering}`,
      sessionKind: 'task-worker',
    });
  }, 30_000);

  it('restores a failed before-hook claim so the same prepared launch can retry', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'before-retry-parent';
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, ROOT_SESSION_CLIENT);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'before-retry-run', workerInstructions: 'Implement one bounded change.',
    }, toolContext) as string);
    const boardPath = path.join(testRoot, '.hive', 'background-jobs.json');
    const originalBoard = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
    const originalClaim = (await import('hive-core')).BackgroundJobService.prototype.claimPendingLaunch;
    let fail = true;
    const claim = spyOn((await import('hive-core')).BackgroundJobService.prototype, 'claimPendingLaunch').mockImplementation(function (input) {
      if (fail) {
        fail = false;
        throw new Error('injected before-hook failure');
      }
      return originalClaim.call(this, input);
    });
    try {
      await expect(hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'before-retry-call-a' }, {
        args: { ...launch.backgroundTaskCall },
      })).rejects.toThrow('injected before-hook failure');
      expect(JSON.parse(fs.readFileSync(boardPath, 'utf8')).pendingLaunches).toEqual(originalBoard.pendingLaunches);
      await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'before-retry-call-b' }, {
        args: { ...launch.backgroundTaskCall },
      });
    } finally {
      claim.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(boardPath, 'utf8')).pendingLaunches).toEqual([
      expect.objectContaining({ disposition: 'claimed', callId: 'before-retry-call-b' }),
    ]);
  }, 30_000);

  it('preserves an already-bound call guard across repeated before-hook replays', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'bound-replay-parent';
    const child = 'bound-replay-child';
    const callID = 'bound-replay-call';
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, ROOT_SESSION_CLIENT);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'bound-replay-run', workerInstructions: 'Implement one bounded change.',
    }, toolContext) as string);
    const args = { ...launch.backgroundTaskCall };
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID }, { args: { ...args } });
    await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: child, parentID: parent } } } } as any);
    await observeNativeTaskChild(hooks, { parentSessionID: parent, callID, childSessionID: child, expectedAgent: 'forager-worker' });
    await hooks['chat.message']?.({ sessionID: child, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    await hooks['tool.execute.after']?.(
      { tool: 'task', sessionID: parent, callID, args },
      { title: 'task', output: 'running', metadata: { sessionId: child } },
    );

    const replayErrors: string[] = [];
    for (let replay = 0; replay < 2; replay++) {
      try {
        await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID }, {
          args: { ...args },
        });
      } catch (error) {
        replayErrors.push(String(error));
      }
    }
    expect(replayErrors).toHaveLength(2);
    expect(replayErrors[1]).toBe(replayErrors[0]);
    await expect(observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID,
      childSessionID: 'bound-replay-other-child',
      expectedAgent: 'forager-worker',
    })).rejects.toThrow(/launch_binding_error[\s\S]*contradictory.*child/);
    expect(new SessionService(testRoot).getGlobal(child)).toMatchObject({
      parentSessionId: parent,
      adHocRunId: 'bound-replay-run',
      sessionKind: 'task-worker',
    });
  }, 30_000);

  it('serializes concurrent forager dispatch claims so exactly one durable claim wins', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'concurrent-claim-parent';
    const child = 'concurrent-claim-child';
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, ROOT_SESSION_CLIENT);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'concurrent-run',
      workerInstructions: 'Implement one bounded change.',
    }, toolContext) as string);

    const results = await Promise.allSettled([
      hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'concurrent-call-a' }, { args: { ...launch.backgroundTaskCall } }),
      hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'concurrent-call-b' }, { args: { ...launch.backgroundTaskCall } }),
    ]);
    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    const winningCallID = results[0]?.status === 'fulfilled' ? 'concurrent-call-a' : 'concurrent-call-b';
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as any).reason)).toMatch(/launch_binding_error/);

    await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: child, parentID: parent } } } } as any);
    await observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID: winningCallID,
      childSessionID: child,
      expectedAgent: 'forager-worker',
    });
    await hooks['chat.message']?.({ sessionID: child, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    const sessions = new SessionService(testRoot);
    expect(sessions.getGlobal(child)).toMatchObject({
      parentSessionId: parent,
      adHocRunId: 'concurrent-run',
      agent: 'forager-worker',
      sessionKind: 'task-worker',
    });

    const boardPath = path.join(testRoot, '.hive', 'background-jobs.json');
    expect(JSON.parse(fs.readFileSync(boardPath, 'utf8')).pendingLaunches).toEqual([
      expect.objectContaining({ disposition: 'claimed', callId: winningCallID }),
    ]);

    await expect(hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'concurrent-call-c' }, {
      args: { ...launch.backgroundTaskCall },
    })).rejects.toThrow(/launch_binding_error[\s\S]*already claimed/);
  }, 30_000);

  it('preserves an ad-hoc launch prepared while another claim awaits worktree validation', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'concurrent-prepare-parent';
    const childA = 'concurrent-prepare-child-a';
    const childB = 'concurrent-prepare-child-b';
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: { ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: {
          id: input.id,
          parentID: input.id === childA || input.id === childB ? parent : undefined,
        } }),
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    const launchA = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'concurrent-prepare-a', workerInstructions: 'Implement bounded change A.',
    }, toolContext) as string);
    const { AdhocWorktreeService } = await import('hive-core');
    const originalGet = AdhocWorktreeService.prototype.get;
    let releaseValidation!: () => void;
    let reportValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => { reportValidationStarted = resolve; });
    const validationRelease = new Promise<void>((resolve) => { releaseValidation = resolve; });
    let held = false;
    const get = spyOn(AdhocWorktreeService.prototype, 'get').mockImplementation(async function (runId) {
      if (runId === 'concurrent-prepare-a' && !held) {
        held = true;
        reportValidationStarted();
        await validationRelease;
      }
      return originalGet.call(this, runId);
    });
    try {
      const claimA = hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'concurrent-prepare-call-a' }, {
        args: { ...launchA.backgroundTaskCall },
      });
      await validationStarted;
      const launchB = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
        runId: 'concurrent-prepare-b', workerInstructions: 'Implement bounded change B.',
      }, toolContext) as string);
      releaseValidation();
      await claimA;
      await observeNativeTaskChild(hooks, {
        parentSessionID: parent,
        callID: 'concurrent-prepare-call-a',
        childSessionID: childA,
        expectedAgent: 'forager-worker',
      });
      await hooks['chat.message']?.({ sessionID: childA, agent: 'forager-worker' }, {
        message: { agent: 'forager-worker' }, parts: [],
      } as any);

      await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'concurrent-prepare-call-b' }, {
        args: { ...launchB.backgroundTaskCall },
      });
      await observeNativeTaskChild(hooks, {
        parentSessionID: parent,
        callID: 'concurrent-prepare-call-b',
        childSessionID: childB,
        expectedAgent: 'forager-worker',
      });
      await hooks['chat.message']?.({ sessionID: childB, agent: 'forager-worker' }, {
        message: { agent: 'forager-worker' }, parts: [],
      } as any);

      expect(new SessionService(testRoot).getGlobal(childA)?.adHocRunId).toBe('concurrent-prepare-a');
      expect(new SessionService(testRoot).getGlobal(childB)?.adHocRunId).toBe('concurrent-prepare-b');
      const board = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'background-jobs.json'), 'utf8'));
      expect(board.pendingLaunches).toHaveLength(2);
      expect(board.pendingLaunches).toEqual(expect.arrayContaining([
        expect.objectContaining({ disposition: 'claimed', callId: 'concurrent-prepare-call-a' }),
        expect.objectContaining({ disposition: 'claimed', callId: 'concurrent-prepare-call-b' }),
      ]));
    } finally {
      releaseValidation?.();
      get.mockRestore();
    }
  }, 30_000);

  it('replaces and claims the superseded pending launch when the same task is prepared again', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'superseded-task-parent', testRoot, ROOT_SESSION_CLIENT);
    await hooks.tool!.hive_feature_create.execute({ name: 'superseded-feature' }, toolContext);
    await hooks.tool!.hive_plan_write.execute(
      { content: createSingleTaskPlan('Superseded', 'This integration test proves that re-preparing the same task replaces the persisted pending launch instead of appending a superseded entry.'), feature: 'superseded-feature' },
      toolContext,
    );
    await hooks.tool!.hive_plan_approve.execute({ feature: 'superseded-feature' }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: 'superseded-feature' }, toolContext);

    await hooks.tool!.hive_worktree_start.execute({ feature: 'superseded-feature', task: FIRST_TASK }, toolContext);
    const relaunch = JSON.parse(await hooks.tool!.hive_worktree_start.execute({ feature: 'superseded-feature', task: FIRST_TASK }, toolContext) as string);
    const boardPath = path.join(testRoot, '.hive', 'background-jobs.json');
    expect(JSON.parse(fs.readFileSync(boardPath, 'utf8')).pendingLaunches).toHaveLength(1);

    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: toolContext.sessionID, callID: 'superseded-dispatch' }, {
      args: { ...relaunch.taskToolCall },
    });
    expect(JSON.parse(fs.readFileSync(boardPath, 'utf8')).pendingLaunches).toEqual([
      expect.objectContaining({ disposition: 'claimed', callId: 'superseded-dispatch' }),
    ]);
  }, 30_000);

  it('replaces and claims the superseded ad-hoc pending launch when the same run is prepared again', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'superseded-adhoc-parent';
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, ROOT_SESSION_CLIENT);
    const stale = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'superseded-run', workerInstructions: 'Implement the stale bounded change.' }, toolContext) as string);
    const relaunch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'superseded-run', workerInstructions: 'Implement one bounded change.' }, toolContext) as string);
    const boardPath = path.join(testRoot, '.hive', 'background-jobs.json');
    expect(JSON.parse(fs.readFileSync(boardPath, 'utf8')).pendingLaunches).toHaveLength(1);
    await expect(hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'stale-superseded-adhoc' }, {
      args: { ...stale.backgroundTaskCall },
    })).rejects.toThrow(/launch_binding_error[\s\S]*unknown or superseded/);
    expect(JSON.parse(fs.readFileSync(boardPath, 'utf8')).pendingLaunches).toEqual([
      expect.objectContaining({ launchId: relaunch.launchId, disposition: 'prepared' }),
    ]);

    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'superseded-adhoc-dispatch' }, {
      args: { ...relaunch.backgroundTaskCall },
    });
    expect(JSON.parse(fs.readFileSync(boardPath, 'utf8')).pendingLaunches).toEqual([
      expect.objectContaining({ disposition: 'claimed', callId: 'superseded-adhoc-dispatch' }),
    ]);
  }, 30_000);

  it.each([false, true])('serializes same-run claims across parents with background available=%s', async (background) => {
    if (background) process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    else delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    const parent = 'race-parent';
    const other = 'race-other';
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, ROOT_SESSION_CLIENT);
    await hooks['chat.message']?.({ sessionID: other, agent: 'hive-master' }, { message: { agent: 'hive-master' }, parts: [] } as any);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'race-run' }, toolContext) as string);
    const second = JSON.parse(await hooks.tool!.hive_adhoc_worktree_start.execute({ runId: 'race-run' }, createToolContext(other)) as string);
    const unrelated = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'race-unrelated' }, createToolContext(other)) as string);
    const outputs = [{ args: { ...launch.taskToolCall, prompt: 'caller text' } }, { args: { ...(background ? second.backgroundTaskCall : second.taskToolCall), prompt: 'caller text' } }];
    const results = await Promise.allSettled(outputs.map((output, i) => hooks['tool.execute.before']!({ tool: 'task', sessionID: i ? other : parent, callID: `race-${i}` }, output)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const loser = results.findIndex(result => result.status === 'rejected');
    expect(outputs[loser]!.args.prompt).toBe('caller text');
    expect(outputs[loser]!.args.hive_launch_id).toBe(loser ? second.launchId : launch.launchId);
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: other, callID: 'race-unrelated' }, { args: { ...unrelated.taskToolCall } });
  }, 30_000);

  it('uses fresh native evidence after lifecycle hints and prior closed turns', async () => {
    const parent = 'fresh-evidence-parent';
    const child = 'fresh-evidence-child';
    let status = 'busy';
    let toolStatus = 'running';
    const runtimeClient = { ...(ROOT_SESSION_CLIENT as any), session: { ...(ROOT_SESSION_CLIENT as any).session,
      get: async ({ path: input }: any) => ({ data: { id: input.id, parentID: input.id === child ? parent : undefined } }),
      status: async () => ({ data: { [child]: { type: status } } }),
      messages: async () => ({ data: [{ info: { role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'tool', state: { status: toolStatus } }] }] }),
    } } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'fresh-evidence-run' }, toolContext) as string);
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: parent, callID: 'fresh-evidence-call' }, { args: { ...launch.taskToolCall } });
    await observeNativeTaskChild(hooks, { parentSessionID: parent, callID: 'fresh-evidence-call', childSessionID: child, expectedAgent: 'forager-worker' });
    await hooks['chat.message']!({ sessionID: child, agent: 'forager-worker' }, { message: { agent: 'forager-worker' }, parts: [] } as any);
    const retry = async () => JSON.parse(await hooks.tool!.hive_adhoc_worktree_start.execute({ runId: 'fresh-evidence-run' }, toolContext) as string);
    for (const type of ['session.error', 'session.idle', 'session.status', 'session.deleted']) {
      await hooks.event!({ event: { type, properties: { sessionID: child, info: { id: child }, status: { type: 'idle' } } } } as any);
      status = 'retry';
      expect((await retry()).success).toBe(false);
      status = 'idle';
      for (toolStatus of ['pending', 'running']) expect((await retry()).success).toBe(false);
    }
    toolStatus = 'completed';
    expect(await retry()).toMatchObject({ success: true });
    status = 'busy';
    expect((await retry()).success).toBe(false);
  }, 30_000);

  it('recovers a late child only through the exact parent task part and fresh terminal evidence', async () => {
    const parent = 'late-exact-parent';
    const child = 'late-exact-child';
    let parts: any[] = [];
    let status = 'busy';
    const runtimeClient = { ...(ROOT_SESSION_CLIENT as any), session: { ...(ROOT_SESSION_CLIENT as any).session,
      get: async ({ path: input }: any) => ({ data: { id: input.id, parentID: input.id === child ? parent : undefined } }),
      status: async () => ({ data: { [child]: { type: status } } }),
      messages: async ({ path: input }: any) => ({ data: input.id === parent ? [{ info: { role: 'assistant' }, parts }] : [{ info: { role: 'assistant', time: { completed: 1 } }, parts: [] }] }),
    } } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'late-exact-run' }, toolContext) as string);
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: parent, callID: 'late-exact-call' }, { args: { ...launch.taskToolCall } });
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);
    try {
      const retry = async () => JSON.parse(await hooks.tool!.hive_adhoc_worktree_start.execute({ runId: 'late-exact-run' }, toolContext) as string);
      expect((await retry()).success).toBe(false);
      const part = { type: 'tool', tool: 'task', sessionID: parent, callID: 'wrong-call', state: { input: { subagent_type: 'forager-worker' }, metadata: { sessionId: child } } };
      parts = [part];
      expect((await retry()).success).toBe(false);
      part.callID = 'late-exact-call';
      expect((await retry()).success).toBe(false);
      expect(new SessionService(testRoot).getGlobal(child)?.adHocRunId).toBe('late-exact-run');
      status = 'idle';
      expect(await retry()).toMatchObject({ success: true });
    } finally { clock.mockRestore(); }
  }, 30_000);

  it('keeps a near-expiry claim valid for its independent binding window', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'near-expiry-parent';
    const child = 'near-expiry-child';
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: { ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: { id: input.id, parentID: input.id === child ? parent : undefined } }),
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    const startedAt = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(startedAt);
    try {
      const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
        runId: 'near-expiry-run', workerInstructions: 'Implement one bounded change.',
      }, toolContext) as string);
      clock.mockReturnValue(startedAt + 5 * 60 * 1000 - 1);
      await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'near-expiry-call' }, {
        args: { ...launch.backgroundTaskCall },
      });
      clock.mockReturnValue(startedAt + 5 * 60 * 1000 + 1000);
      await observeNativeTaskChild(hooks, {
        parentSessionID: parent,
        callID: 'near-expiry-call',
        childSessionID: child,
        expectedAgent: 'forager-worker',
      });
      await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: child, parentID: parent } } } } as any);
      await hooks['chat.message']?.({ sessionID: child, agent: 'forager-worker' }, {
        message: { agent: 'forager-worker' }, parts: [],
      } as any);
      expect(new SessionService(testRoot).getGlobal(child)?.adHocRunId).toBe('near-expiry-run');
    } finally {
      clock.mockRestore();
    }
  }, 30_000);

  it('retains more than 100 archived unresolved writers without fencing unrelated targets', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'archived-writer-parent';
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, ROOT_SESSION_CLIENT);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'archived-writer-run', workerInstructions: 'Implement one bounded change.',
    }, toolContext) as string);
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'archived-writer-call' }, {
      args: { ...launch.backgroundTaskCall },
    });
    new BackgroundJobService(testRoot).archiveClaimedLaunch(
      launch.launchId,
      parent,
      'ignored',
      'Bookkeeping archived without native cancellation.',
    );
    const unrelated = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'archived-writer-unrelated-run', autoSpawnWorker: false,
    }, toolContext) as string);
    const backgroundJobs = new BackgroundJobService(testRoot);
    for (let index = 0; index < 100; index += 1) {
      const launchId = `archived-writer-history-${index}`;
      const callId = `archived-writer-history-call-${index}`;
      backgroundJobs.registerPendingLaunch({
        launchId,
        parentSessionId: parent,
        agentName: 'forager-worker',
        scope: { projectRoot: testRoot, parentSessionId: parent, adHocRunId: `archived-history-run-${index}` },
      });
      backgroundJobs.claimPendingLaunch({ launchId, parentSessionId: parent, callId });
      backgroundJobs.archiveClaimedLaunch(launchId, parent, 'ignored', 'Retained unresolved execution history.');
    }
    const fresh = await createHooksForTest(testRoot, parent, testRoot, ROOT_SESSION_CLIENT);

    const retry = JSON.parse(await fresh.hooks.tool!.hive_adhoc_worktree_start.execute({
      runId: 'archived-writer-run', workerInstructions: 'Unsafe retry.',
    }, fresh.toolContext) as string);
    expect(retry.success).toBe(false);
    expect(retry.error).toContain('writer_fence_error');
    expect(retry.error).toContain(`claimed launch '${launch.launchId}'`);
    expect(backgroundJobs.listPendingLaunches({}, { includeArchived: true }).some(pending => pending.launchId === launch.launchId)).toBe(true);

    const unrelatedStart = JSON.parse(await fresh.hooks.tool!.hive_adhoc_worktree_start.execute({
      runId: unrelated.runId, workerInstructions: 'Use the unrelated target.',
    }, fresh.toolContext) as string);
    expect(unrelatedStart.success).toBe(true);
    expect(unrelatedStart.taskToolCall).toBeDefined();
  }, 30_000);

  it('blocks an active bound writer before mutation and permits retry after confirmed cancellation', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'cancelled-writer-parent';
    const child = 'cancelled-writer-child';
    let childStatus: 'busy' | 'idle' = 'busy';
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: {
        ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: { id: input.id, parentID: input.id === child ? parent : undefined } }),
        status: async () => ({ data: { [child]: { type: childStatus } } }),
        messages: async ({ path: input }: any) => ({ data: input.id === child && childStatus === 'idle'
          ? [{ info: { role: 'assistant', time: { completed: Date.now() } }, parts: [] }]
          : [] }),
        abort: async () => {
          childStatus = 'idle';
          return { data: true };
        },
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'cancelled-writer-run', workerInstructions: 'Implement one bounded change.',
    }, toolContext) as string);
    const dispatch = { args: { ...launch.backgroundTaskCall } };
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'cancelled-writer-call' }, dispatch);
    await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: child, parentID: parent } } } } as any);
    await observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID: 'cancelled-writer-call',
      childSessionID: child,
      expectedAgent: 'forager-worker',
    });
    await hooks['chat.message']?.({ sessionID: child, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    await hooks['tool.execute.after']?.(
      { tool: 'task', sessionID: parent, callID: 'cancelled-writer-call', args: dispatch.args },
      { title: 'task', output: `task_id: ${child}`, metadata: { sessionId: child } },
    );

    const blocked = JSON.parse(await hooks.tool!.hive_adhoc_worktree_start.execute({
      runId: 'cancelled-writer-run', workerInstructions: 'Unsafe concurrent retry.',
    }, toolContext) as string);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain(`native session '${child}' is active`);

    const cancelled = JSON.parse(await hooks.tool!.hive_background_cancel.execute({
      identifier: launch.launchId,
      reason: 'Test confirms exact native cancellation before retry.',
    }, toolContext) as string);
    expect(cancelled.runtimeCancelled).toBe(true);
    const retry = JSON.parse(await hooks.tool!.hive_adhoc_worktree_start.execute({
      runId: 'cancelled-writer-run', workerInstructions: 'Safe retry after cancellation.',
    }, toolContext) as string);
    expect(retry).toMatchObject({ success: true });
    expect(retry.launchId).not.toBe(launch.launchId);
  }, 30_000);

  it('prunes unused preparations at initialization while preserving unresolved claimed execution', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'stale-pending-parent';
    const initial = await createHooksForTest(testRoot, parent, testRoot, ROOT_SESSION_CLIENT);
    await initial.hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'stale-run', workerInstructions: 'Implement one bounded change.' }, initial.toolContext);
    const boardPath = path.join(testRoot, '.hive', 'background-jobs.json');
    const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
    board.pendingLaunches[0].createdAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    board.pendingLaunches.push({
      ...board.pendingLaunches[0],
      launchId: 'claimed-before-restart',
      disposition: 'claimed',
      callId: 'claimed-call',
      background: true,
      runtimeId: 'old-runtime',
      claimedAt: board.pendingLaunches[0].createdAt,
    });
    fs.writeFileSync(boardPath, JSON.stringify(board));

    const fresh = await createHooksForTest(testRoot, parent, testRoot, ROOT_SESSION_CLIENT);
    expect(JSON.parse(fs.readFileSync(boardPath, 'utf8')).pendingLaunches).toEqual([
      expect.objectContaining({ launchId: 'claimed-before-restart', disposition: 'claimed', callId: 'claimed-call' }),
    ]);
    await expect(fresh.hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'stale-dispatch' }, {
      args: { subagent_type: 'forager-worker', description: 'Stale', prompt: 'Stale dispatch' },
    })).rejects.toThrow(/launch_binding_error/);
    expect(JSON.parse(fs.readFileSync(boardPath, 'utf8')).pendingLaunches).toHaveLength(1);
  }, 30_000);

  it('replaces a prior-runtime prepared record only for the same ad-hoc target', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'restart-preparation-parent';
    const initial = await createHooksForTest(testRoot, parent, testRoot, ROOT_SESSION_CLIENT);
    const old = JSON.parse(await initial.hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'restart-preparation-run', workerInstructions: 'Old preparation.',
    }, initial.toolContext) as string);
    const unrelated = JSON.parse(await initial.hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'restart-unrelated-run', workerInstructions: 'Unrelated preparation.',
    }, initial.toolContext) as string);

    const fresh = await createHooksForTest(testRoot, parent, testRoot, ROOT_SESSION_CLIENT);
    const replacement = JSON.parse(await fresh.hooks.tool!.hive_adhoc_worktree_create.execute({
      runId: 'restart-preparation-run', workerInstructions: 'Fresh preparation.',
    }, fresh.toolContext) as string);
    const pending = JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'background-jobs.json'), 'utf8')).pendingLaunches;
    expect(pending.map((entry: any) => entry.launchId)).toEqual(expect.arrayContaining([
      unrelated.launchId,
      replacement.launchId,
    ]));
    expect(pending.map((entry: any) => entry.launchId)).not.toContain(old.launchId);
    expect(pending).toHaveLength(2);
  }, 30_000);

  it('rejects an unknown launch ID without consuming independently prepared launches', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'ambiguous-recovery-parent', testRoot, ROOT_SESSION_CLIENT);
    for (const feature of ['ambiguous-recovery-a', 'ambiguous-recovery-b', 'ambiguous-recovery-c']) {
      await hooks.tool!.hive_feature_create.execute({ name: feature }, toolContext);
      await hooks.tool!.hive_plan_write.execute(
        { content: createSingleTaskPlan(feature, 'This integration test proves that ambiguous launch reservations are invalidated so exactly one fresh launch can be prepared and dispatched.'), feature },
        toolContext,
      );
      await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
      await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);
    }
    const launchA = JSON.parse(await hooks.tool!.hive_worktree_start.execute({ feature: 'ambiguous-recovery-a', task: FIRST_TASK }, toolContext) as string);
    const launchB = JSON.parse(await hooks.tool!.hive_worktree_start.execute({ feature: 'ambiguous-recovery-b', task: FIRST_TASK }, toolContext) as string);
    const boardPath = path.join(testRoot, '.hive', 'background-jobs.json');
    const beforeUnknown = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
    beforeUnknown.pendingLaunches[0].createdAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(boardPath, JSON.stringify(beforeUnknown));

    await expect(hooks['tool.execute.before']?.({ tool: 'task', sessionID: toolContext.sessionID, callID: 'ambiguous-recovery-call' }, {
      args: { subagent_type: 'forager-worker', description: 'Unknown', prompt: 'Unknown dispatch', hive_launch_id: randomUUID() },
    })).rejects.toThrow(/launch_binding_error[\s\S]*unknown or superseded/);
    expect(JSON.parse(fs.readFileSync(boardPath, 'utf8')).pendingLaunches ?? []).toHaveLength(2);

    await Promise.all([
      hooks['tool.execute.before']?.({ tool: 'task', sessionID: toolContext.sessionID, callID: 'recovery-a' }, { args: { ...launchA.taskToolCall } }),
      hooks['tool.execute.before']?.({ tool: 'task', sessionID: toolContext.sessionID, callID: 'recovery-b' }, { args: { ...launchB.taskToolCall } }),
    ]);

    const launchC = JSON.parse(await hooks.tool!.hive_worktree_start.execute({ feature: 'ambiguous-recovery-c', task: FIRST_TASK }, toolContext) as string);
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: toolContext.sessionID, callID: 'recovery-dispatch' }, {
      args: { ...launchC.taskToolCall },
    });
    await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: 'recovery-child', parentID: toolContext.sessionID } } } } as any);
    await observeNativeTaskChild(hooks, {
      parentSessionID: toolContext.sessionID,
      callID: 'recovery-dispatch',
      childSessionID: 'recovery-child',
      expectedAgent: 'forager-worker',
    });
    await hooks['chat.message']?.({ sessionID: 'recovery-child', agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    expect(new SessionService(testRoot).getGlobal('recovery-child')).toMatchObject({
      parentSessionId: toolContext.sessionID,
      sessionKind: 'task-worker',
    });
  }, 30_000);

  it('binds a forager child whose parent metadata arrives by session.updated before its first message', async () => {
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
    const parent = 'late-parent-metadata-parent';
    const child = 'late-parent-metadata-child';
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: { ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: { id: input.id, parentID: input.id === child ? parent : undefined } }),
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: child } } } } as any);

    const launch = JSON.parse(await hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'late-parent-run', workerInstructions: 'Implement one bounded change.' }, toolContext) as string);
    await hooks['tool.execute.before']?.({ tool: 'task', sessionID: parent, callID: 'late-parent-call' }, {
      args: { ...launch.backgroundTaskCall },
    });
    await hooks.event?.({ event: { type: 'session.updated', properties: { info: { id: child, parentID: parent } } } } as any);
    await observeNativeTaskChild(hooks, {
      parentSessionID: parent,
      callID: 'late-parent-call',
      childSessionID: child,
      expectedAgent: 'forager-worker',
    });
    await hooks['chat.message']?.({ sessionID: child, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);

    const sessions = new SessionService(testRoot);
    expect(sessions.getGlobal(child)).toMatchObject({
      parentSessionId: parent,
      adHocRunId: 'late-parent-run',
      agent: 'forager-worker',
      baseAgent: 'forager-worker',
      sessionKind: 'task-worker',
    });
    const authority = JSON.parse(await hooks.tool!.hive_context_read.execute(
      { scope: 'project', view: 'catalog' },
      { ...toolContext, sessionID: child, agent: 'forager-worker' },
    ) as string);
    expect(authority.success).toBe(true);
  }, 30_000);

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
      sessionPolicy?: {
        version?: number;
        sessionMode?: string;
        taskIdUse?: string;
        followUpMode?: string;
        workerLifecycle?: string;
        goalMode?: string;
      };
      taskToolCall?: {
        description?: string;
        prompt?: string;
        subagent_type?: string;
        background?: boolean;
        task_id?: string;
      };
      backgroundTaskCall?: unknown;
    };
    expect(execStart.taskToolCall).toMatchObject({
      description: "Hive: 01-first-task",
      prompt: expect.stringMatching(/@\.hive\/features\/01_smoke-feature\/tasks\/01-first-task\/assignments\/attempt-1\.md$/),
      subagent_type: "forager-worker",
    });
    expect(execStart.taskToolCall?.background).toBeUndefined();
    expect(execStart.taskToolCall).not.toHaveProperty("task_id");
    expect(execStart.sessionPolicy).toEqual({
      version: 1,
      sessionMode: "fresh",
      taskIdUse: "observe-only",
      followUpMode: "new-launch",
      workerLifecycle: "terminal",
      goalMode: "one-primary",
    });
    expect(execStart.backgroundTaskCall).toBeUndefined();
    expect(execStart.instructions).toContain("taskToolCall.prompt");
    expect(execStart.instructions).not.toContain("background: true");
    const boardPath = path.join(testRoot, ".hive", "background-jobs.json");
    expect(fs.existsSync(boardPath)).toBe(false);

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

  it('describes task worktree tools as returning fresh-worker launch guidance', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'sess_worktree_tool_descriptions');
    const tools = hooks.tool as unknown as Record<string, { description?: string }>;
    const startDescription = tools.hive_worktree_start.description ?? '';
    const continuationDescription = tools.hive_worktree_create.description ?? '';

    expect(startDescription).toContain('Returns fresh-worker launch guidance');
    expect(continuationDescription).toContain('blocked-task continuation in the existing worktree');
    expect(continuationDescription).toContain('Returns fresh-worker launch guidance');
    expect(startDescription).not.toMatch(/spawn.*automatically/i);
    expect(continuationDescription).not.toMatch(/spawn.*automatically|resume.*session/i);
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

  it("returns task tool call using @file prompt", async () => {

    const configPath = path.join(testRoot, '.config', 'opencode', 'agent_hive.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        'forager-worker': {
          description: '  Default for ordinary backend implementation.  ',
        },
      },
      customAgents: {
        'forager-backend': {
          baseAgent: 'forager-worker',
          description: 'Use for backend implementation involving persistence or service boundaries.',
        },
      },
    }));

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
      "assignments",
      "attempt-1.md"
    );

    expect(execStart.taskToolCall).toBeDefined();
    expect(execStart.defaultAgent).toBe("forager-worker");
    expect(execStart.eligibleAgents).toEqual([
      {
        name: "forager-worker",
        baseAgent: "forager-worker",
        description: "Default for ordinary backend implementation.",
      },
      {
        name: "forager-backend",
        baseAgent: "forager-worker",
        description: "Use for backend implementation involving persistence or service boundaries.",
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
    expect(execStart.instructions).toContain("Choose autonomously the agent whose description best matches the task's domain, workflow, artifact type, or concrete review/approach risk; use the built-in base agent when no configured custom subagent is a closer fit.");
    expect(execStart.instructions).toContain('Candidate-specific conditions in an individual description still apply, including a condition that the candidate may be selected only when the operator explicitly names it.');
    expect(execStart.instructions).not.toContain('or when the operator explicitly names it');
    expect(execStart.instructions).toContain(
      "prompt: \"Follow instructions in @.hive/features/01_task-mode-feature/tasks/01-first-task/assignments/attempt-1.md\""
    );
    expect(execStart.instructions).toContain(
      "Use the `@path` attachment syntax in the prompt to reference the file. Do not inline the file contents."
    );
    expect(execStart.instructions).not.toContain("Read the prompt file");
  });

  it("returns env-gated background task call metadata with one pending launch reservation", async () => {
    const previousBackgroundEnv = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "1";

    try {
      const { hooks, toolContext } = await createHooksForTest(testRoot, "sess_background_feature_launch");

      await hooks.tool!.hive_feature_create.execute(
        { name: "background-feature" },
        toolContext,
      );
      await hooks.tool!.hive_plan_write.execute(
        { content: createSingleTaskPlan("Background", "Yes, this integration test validates background feature launch metadata for background-capable task delegation responses."), feature: "background-feature" },
        toolContext,
      );
      await hooks.tool!.hive_plan_approve.execute(
        { feature: "background-feature" },
        toolContext,
      );
      await hooks.tool!.hive_tasks_sync.execute(
        { feature: "background-feature" },
        toolContext,
      );

      const raw = await hooks.tool!.hive_worktree_start.execute(
        { feature: "background-feature", task: FIRST_TASK },
        toolContext,
      );
      const result = JSON.parse(raw as string) as {
        backgroundTaskCall?: {
          background?: boolean;
          subagent_type?: string;
          description?: string;
          prompt?: string;
          task_id?: string;
        };
        taskToolCall?: { prompt?: string; task_id?: string; background?: boolean };
        sessionPolicy?: {
          version?: number;
          sessionMode?: string;
          taskIdUse?: string;
          followUpMode?: string;
          workerLifecycle?: string;
          goalMode?: string;
        };
        instructions?: string;
      };

      expect(result.backgroundTaskCall).toEqual({
        background: true,
        subagent_type: "forager-worker",
        description: "Hive: 01-first-task",
        prompt: result.taskToolCall?.prompt,
        hive_launch_id: result.launchId,
      });
      expect(result.taskToolCall).toBeDefined();
      expect(result.taskToolCall).not.toHaveProperty("task_id");
      expect(result.backgroundTaskCall).not.toHaveProperty("task_id");
      expect(result.sessionPolicy).toEqual({
        version: 1,
        sessionMode: "fresh",
        taskIdUse: "observe-only",
        followUpMode: "new-launch",
        workerLifecycle: "terminal",
        goalMode: "one-primary",
      });
      expect((result.taskToolCall as { background?: boolean } | undefined)?.background).toBeUndefined();
      expect(result.instructions).toContain("backgroundTaskCall");
      expect(result.instructions).toContain("independent lane");
      expect(result.instructions).toContain("safe foreground work can continue");
      expect(result.instructions).toContain("blocking `task()` is correct");
      expect(result.instructions).toContain("next meaningful step depends on the worker");

      const boardPath = path.join(testRoot, ".hive", "background-jobs.json");
      expect(JSON.parse(fs.readFileSync(boardPath, 'utf8')).pendingLaunches).toHaveLength(1);
    } finally {
      if (previousBackgroundEnv === undefined) {
        delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      } else {
        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previousBackgroundEnv;
      }
    }
  });

  it("gate-closed blocking launch associates the exact child without writing a launch artifact", async () => {
    const previousBackgroundEnv = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    const previousExperimental = process.env.OPENCODE_EXPERIMENTAL;
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    delete process.env.OPENCODE_EXPERIMENTAL;

    try {
      const { hooks, toolContext } = await createHooksForTest(testRoot, "sess_gate_closed_worktree", testRoot, ROOT_SESSION_CLIENT);

      await hooks.tool!.hive_feature_create.execute({ name: "gate-closed-feature" }, toolContext);
      await hooks.tool!.hive_plan_write.execute(
        {
          content: createSingleTaskPlan(
            "Gate Closed",
            "Yes, this integration test validates gate-closed hive_worktree_start stays blocking-first and does not mutate the background board.",
          ),
          feature: "gate-closed-feature",
        },
        toolContext,
      );
      await hooks.tool!.hive_plan_approve.execute({ feature: "gate-closed-feature" }, toolContext);
      await hooks.tool!.hive_tasks_sync.execute({ feature: "gate-closed-feature" }, toolContext);

      const raw = await hooks.tool!.hive_worktree_start.execute(
        { feature: "gate-closed-feature", task: FIRST_TASK },
        toolContext,
      );
      const result = JSON.parse(raw as string) as {
        taskToolCall?: { description: string; prompt: string; subagent_type: string; background?: boolean };
        backgroundTaskCall?: unknown;
        instructions?: string;
      };
      const taskArgs = { ...result.taskToolCall! };

      expect(result.taskToolCall).toMatchObject({
        subagent_type: "forager-worker",
        description: "Hive: 01-first-task",
        prompt: expect.stringContaining("@.hive/features/01_gate-closed-feature/tasks/01-first-task/assignments/attempt-1.md"),
      });
      expect(result.taskToolCall?.background).toBeUndefined();
      expect(result.backgroundTaskCall).toBeUndefined();
      expect(result.instructions).toContain("taskToolCall.prompt");
      expect(result.instructions).not.toContain("backgroundTaskCall");
      expect(result.instructions).not.toContain("independent lane");

      const boardPath = path.join(testRoot, ".hive", "background-jobs.json");
      expect(fs.existsSync(boardPath)).toBe(false);
      const taskDirectory = path.join(testRoot, '.hive', 'features', '01_gate-closed-feature', 'tasks', FIRST_TASK);
      expect(fs.readdirSync(taskDirectory).sort()).toEqual(['assignments', 'spec.md', 'status.json', 'worker-prompt.md']);

      await hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'gate-closed-worker',
        args: taskArgs,
      }, {
        args: { ...taskArgs },
      });
      await hooks.event?.({ event: {
        type: 'session.created',
        properties: { info: { id: 'gate-closed-child', parentID: toolContext.sessionID } },
      } } as any);
      await observeNativeTaskChild(hooks, {
        parentSessionID: toolContext.sessionID,
        callID: 'gate-closed-worker',
        childSessionID: 'gate-closed-child',
        expectedAgent: 'forager-worker',
      });
      await hooks['chat.message']?.({ sessionID: 'gate-closed-child', agent: 'forager-worker' }, {
        message: { agent: 'forager-worker' }, parts: [],
      } as any);
      await hooks['tool.execute.after']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'gate-closed-worker',
        args: taskArgs,
      }, {
        title: 'task',
        output: 'done',
        metadata: { sessionId: 'gate-closed-child' },
      });
      const statusPath = path.join(testRoot, '.hive', 'features', '01_gate-closed-feature', 'tasks', FIRST_TASK, 'status.json');
      expect(JSON.parse(fs.readFileSync(statusPath, 'utf-8')).workerSession).toMatchObject({
        sessionId: 'gate-closed-child',
        attempt: 1,
      });
      const hiveStatus = JSON.parse(await hooks.tool!.hive_status.execute(
        { feature: 'gate-closed-feature' },
        toolContext,
      ) as string) as { tasks: { list: Array<{ traceTaskId?: string }> } };
      expect(hiveStatus.tasks.list[0].traceTaskId).toBe('gate-closed-child');
    } finally {
      if (previousBackgroundEnv === undefined) {
        delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      } else {
        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previousBackgroundEnv;
      }
      if (previousExperimental === undefined) {
        delete process.env.OPENCODE_EXPERIMENTAL;
      } else {
        process.env.OPENCODE_EXPERIMENTAL = previousExperimental;
      }
    }
  }, 30_000);

  it("selects two task launch reservations by ID under one parent", async () => {
    const { hooks, toolContext } = await createHooksForTest(
      testRoot,
      "sess_same_folder_parent",
      testRoot,
      ROOT_SESSION_CLIENT,
    );
    for (const feature of ["same-folder-a", "same-folder-b"]) {
      await hooks.tool!.hive_feature_create.execute({ name: feature }, toolContext);
      await hooks.tool!.hive_plan_write.execute(
        {
          content: createSingleTaskPlan(
            feature,
            "This regression test proves exact feature ownership when two launches use the same task folder under one parent session.",
          ),
          feature,
        },
        toolContext,
      );
      await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
      await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);
    }

    const launchA = JSON.parse(await hooks.tool!.hive_worktree_start.execute(
      { feature: "same-folder-a", task: FIRST_TASK },
      toolContext,
    ) as string);
    const launchB = JSON.parse(await hooks.tool!.hive_worktree_start.execute(
      { feature: "same-folder-b", task: FIRST_TASK },
      toolContext,
    ) as string);

    const dispatchB = { args: { ...launchB.taskToolCall, prompt: 'edited B' } };
    const dispatchA = { args: { ...launchA.taskToolCall, description: 'edited A' } };
    await Promise.all([
      hooks["tool.execute.before"]?.(
        { tool: "task", sessionID: toolContext.sessionID, callID: 'selected-launch-b', args: dispatchB.args },
        dispatchB,
      ),
      hooks["tool.execute.before"]?.(
        { tool: "task", sessionID: toolContext.sessionID, callID: 'selected-launch-a', args: dispatchA.args },
        dispatchA,
      ),
    ]);
    expect(launchA.taskToolCall.prompt).not.toBe(launchB.taskToolCall.prompt);
    expect(dispatchA.args.prompt).toContain('same-folder-a');
    expect(dispatchB.args.prompt).toContain('same-folder-b');
  }, 30_000);

  it('retrieves later-page live knowledge without revising the verified assignment or weakening child authority', async () => {
    const parent = 'catalog-parent';
    const rejectedChild = 'catalog-rejected-child';
    const child = 'catalog-child';
    const feature = 'catalog-lifecycle';
    let rejectedTerminal = false;
    const runtimeClient = {
      ...(ROOT_SESSION_CLIENT as any),
      session: { ...(ROOT_SESSION_CLIENT as any).session,
        get: async ({ path: input }: any) => ({ data: {
          id: input.id,
          parentID: input.id === rejectedChild || input.id === child ? parent : undefined,
        } }),
        status: async () => ({ data: rejectedTerminal ? { [rejectedChild]: { type: 'idle' } } : {} }),
        messages: async ({ path: input }: any) => ({ data: input.id === rejectedChild && rejectedTerminal
          ? [{ info: { role: 'assistant', time: { completed: Date.now() } }, parts: [] }]
          : [] }),
      },
    } as PluginInput['client'];
    const { hooks, toolContext } = await createHooksForTest(testRoot, parent, testRoot, runtimeClient);
    await hooks.tool!.hive_feature_create.execute({ name: feature }, toolContext);
    await hooks.tool!.hive_plan_write.execute({ feature, content: createSingleTaskPlan('Catalog lifecycle', 'Preserve REQUIRED-CATALOG-CONTRACT while retrieving current supporting facts.').replace('Do it', 'Preserve REQUIRED-CATALOG-CONTRACT while retrieving current supporting facts.') }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);
    const publishedConstraint = 'CONSTRAINT-PRESENT-BEFORE-PUBLICATION';
    await hooks.tool!.hive_constraints_add.execute({ constraints: publishedConstraint }, toolContext);
    const fact = 'src/payments/settle.ts invoice_87 ERR_SETTLEMENT_CONFLICT';
    for (const scope of ['project', 'feature'] as const) {
      for (let i = 0; i < 13; i++) {
        const name = i === 12 ? 'zz-required' : `distractor-${String(i).padStart(2, '0')}`;
        const body = i === 12 ? `${'supporting background\n'.repeat(1200)}${fact}` : `irrelevant supporting body ${i}`;
        await hooks.tool!.hive_context_write.execute({
          ...(scope === 'project' ? { scope } : { feature }), name,
          content: `---\ndescription: ${name}\nread_when: Read for settlement details\nowner: platform\nreview_after: 2027-01-01\n---\n${body}`,
        }, toolContext);
      }
    }
    const launch = JSON.parse(await hooks.tool!.hive_worktree_start.execute({ feature, task: FIRST_TASK }, toolContext) as string);
    let artifact = path.join(testRoot, launch.taskToolCall.prompt.replace('Follow instructions in @', ''));
    let original = fs.readFileSync(artifact);
    expect(original.toString('utf8').split(publishedConstraint)).toHaveLength(2);
    const dispatch = { args: { ...launch.taskToolCall } };
    fs.writeFileSync(artifact, 'UNVERIFIED DISPATCH');
    await expect(hooks['tool.execute.before']!({ tool: 'task', sessionID: parent, callID: 'bad-catalog-launch' }, { args: { ...launch.taskToolCall } })).rejects.toThrow(/assignment_recovery_error/);
    fs.writeFileSync(artifact, original);
    const readFile = fs.readFileSync;
    const race = spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      const bytes = (readFile as any)(file, ...args);
      if (file === artifact) fs.writeFileSync(artifact, 'UNVERIFIED DISPATCH');
      return bytes;
    }) as any);
    try {
      await hooks.tool!.hive_constraints_add.execute({ constraints: 'CONSTRAINT-ADDED-AFTER-PUBLICATION' }, toolContext);
      await hooks['tool.execute.before']!({ tool: 'task', sessionID: parent, callID: 'catalog-launch' }, dispatch);
    } finally {
      race.mockRestore();
    }
    expect(dispatch.args.prompt).toBe(original.toString('utf8'));
    expect(dispatch.args.prompt).not.toContain('CONSTRAINT-ADDED-AFTER-PUBLICATION');
    expect(dispatch.args.prompt).toContain('REQUIRED-CATALOG-CONTRACT');
    expect(dispatch.args.prompt).not.toContain(fact);
    await hooks.event!({ event: { type: 'message.part.updated', properties: { part: {
      type: 'tool', tool: 'task', sessionID: parent, callID: 'catalog-launch',
      state: { input: dispatch.args, metadata: { sessionId: rejectedChild } },
    } } } } as any);
    expect(new SessionService(testRoot).getGlobal(rejectedChild)?.workerAssignment).toBeUndefined();
    await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: rejectedChild, parentID: parent } } } } as any);
    await expect(hooks['chat.message']!({ sessionID: rejectedChild, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any)).rejects.toThrow(/assignment_recovery_error/);
    expect(new SessionService(testRoot).getGlobal(rejectedChild)?.workerAssignment).toBeUndefined();
    fs.writeFileSync(artifact, original);
    await hooks['tool.execute.after']!({ tool: 'task', sessionID: parent, callID: 'catalog-launch', args: dispatch.args }, {
      title: 'task', output: '', metadata: { sessionId: rejectedChild },
    });
    await hooks['chat.message']!({ sessionID: rejectedChild, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    rejectedTerminal = true;
    await hooks.event?.({ event: { type: 'session.status', properties: { sessionID: rejectedChild, status: { type: 'idle' } } } } as any);

    const replacementLaunch = JSON.parse(await hooks.tool!.hive_worktree_start.execute({ feature, task: FIRST_TASK }, toolContext) as string);
    artifact = path.join(testRoot, replacementLaunch.taskToolCall.prompt.replace('Follow instructions in @', ''));
    original = fs.readFileSync(artifact);
    const replacementDispatch = { args: { ...replacementLaunch.taskToolCall } };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: parent, callID: 'catalog-replacement-launch' }, replacementDispatch);
    await hooks.event!({ event: { type: 'message.part.updated', properties: { part: {
      type: 'tool', tool: 'task', sessionID: parent, callID: 'catalog-replacement-launch',
      state: { input: replacementDispatch.args, metadata: { sessionId: child } },
    } } } } as any);
    await hooks.event?.({ event: { type: 'session.created', properties: { info: { id: child, parentID: parent } } } } as any);
    await hooks['chat.message']!({ sessionID: child, agent: 'forager-worker' }, {
      message: { agent: 'forager-worker' }, parts: [],
    } as any);
    const sessions = new SessionService(testRoot);
    const bound = sessions.getGlobal(child)!;
    const childContext = { ...toolContext, sessionID: child, agent: 'forager-worker' };
    const catalogSpy = spyOn(ContextService.prototype, 'readCatalog');
    const readSpy = spyOn(ContextService.prototype, 'readContent');
    const inventorySpy = spyOn(ContextService.prototype as any, 'buildInventory');
    const headerSpy = spyOn(ContextService.prototype as any, 'readHeader');
    const output = { messages: [{ info: { id: 'catalog-turn', sessionID: child, role: 'assistant', time: { created: Date.now() } }, parts: [] }] };
    try {
      await hooks['experimental.chat.messages.transform']!({}, output as any);
      const text = (output.messages.at(-1)!.parts[0] as any).text;
      const automaticBytes = Buffer.byteLength(text);
      expect(automaticBytes).toBeLessThanOrEqual(8192);
      expect(text).not.toContain(fact);
      expect(readSpy).not.toHaveBeenCalled();
      const payload = JSON.parse(text.slice(text.indexOf('\n') + 1));
      expect(payload.catalogs.map((entry: any) => entry.scope.type)).toEqual(['project', 'feature']);
      for (const entry of payload.catalogs) {
        expect(entry.catalog.complete).toBe(false);
        expect(entry.catalog.files.some((file: any) => file.name === 'zz-required')).toBe(false);
        let page = entry.catalog;
        const scope = entry.scope.type === 'project' ? { scope: 'project' } : { feature };
        const names = page.files.map((file: any) => file.name);
        while (!page.complete) {
          page = JSON.parse(await hooks.tool!.hive_context_read.execute({ ...scope, view: 'catalog', cursor: page.nextCursor }, childContext) as string);
          expect(page.success).toBe(true);
          names.push(...page.files.map((file: any) => file.name));
        }
        expect(names).toHaveLength(13);
        expect(names.at(-1)).toBe('zz-required');
        let chunk: any;
        let recalled = '';
        do {
          chunk = JSON.parse(await hooks.tool!.hive_context_read.execute({ ...scope, name: 'zz-required', maxBytes: 8192, ...(chunk ? { cursor: chunk.nextCursor } : {}) }, childContext) as string);
          expect(chunk.success).toBe(true);
          recalled += chunk.file.content;
        } while (!chunk.complete);
        expect(recalled.indexOf(fact)).toBeGreaterThan(20_000);
      }
      console.log('catalog lifecycle metrics', JSON.stringify({ automaticBytes, listCalls: catalogSpy.mock.calls.length, readCalls: readSpy.mock.calls.length, inventoryScans: inventorySpy.mock.calls.length, headerReads: headerSpy.mock.calls.length, headerBytes: headerSpy.mock.results.reduce((sum: number, result: any) => sum + (result.value?.length ?? 0), 0) }));
      expect(catalogSpy.mock.calls).toHaveLength(4);
      expect(readSpy.mock.calls).toHaveLength(8);
      const note = path.join(testRoot, '.hive', 'context', 'zz-required.md');
      fs.appendFileSync(note, '\nUPDATED-SUPPORTING-FACT');
      const changed = JSON.parse(await hooks.tool!.hive_context_read.execute({ scope: 'project', name: 'zz-required', maxBytes: 65536 }, childContext) as string);
      expect(changed.file.content).toContain('UPDATED-SUPPORTING-FACT');
      expect(fs.readFileSync(artifact)).toEqual(original);
      expect(sessions.getGlobal(child)!.workerAssignment).toEqual(bound.workerAssignment);

      const indexPath = path.join(testRoot, '.hive', 'context', 'index.json');
      const indexBytes = fs.readFileSync(indexPath);
      const index = JSON.parse(indexBytes.toString());
      index.entries['distractor-00'].kind = 'evidence';
      fs.writeFileSync(indexPath, JSON.stringify(index));
      await hooks['experimental.chat.messages.transform']!({}, output as any);
      const refreshed = JSON.parse((output.messages.at(-1)!.parts[0] as any).text.split('\n').slice(1).join('\n'));
      expect(refreshed.catalogs[0].catalog.files.some((file: any) => file.name === 'distractor-00')).toBe(false);
      expect(JSON.parse(await hooks.tool!.hive_context_read.execute({ scope: 'project', view: 'catalog', cursor: payload.catalogs[0].catalog.nextCursor }, childContext) as string).reason).toBe('stale_context_cursor');
      const pending = path.join(testRoot, '.hive', 'context', '.managed-mutation-pending.json');
      fs.writeFileSync(pending, '{}');
      await hooks['experimental.chat.messages.transform']!({}, output as any);
      expect((output.messages.at(-1)!.parts[0] as any).text).toContain('context_reconciliation_required');
      fs.unlinkSync(pending);
      fs.writeFileSync(indexPath, '{broken');
      await hooks['experimental.chat.messages.transform']!({}, output as any);
      expect((output.messages.at(-1)!.parts[0] as any).text).toContain('context_index_invalid');
      fs.writeFileSync(indexPath, indexBytes);

      await expect(hooks['chat.message']!({ sessionID: child, agent: 'scout-researcher' }, { message: {}, parts: [] } as any)).rejects.toThrow(/launch_binding_error/);
      expect(sessions.getGlobal(child)!.sessionKind).toBe('task-worker');
      // A persisted misclassification must not bypass assignment validation either.
      const registryPath = path.join(testRoot, '.hive', 'sessions.json');
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      Object.assign(registry.sessions.find((session: any) => session.sessionId === child), { agent: 'scout-researcher', baseAgent: 'scout-researcher', sessionKind: 'subagent' });
      fs.writeFileSync(registryPath, JSON.stringify(registry));
      fs.writeFileSync(artifact, 'INVALID ASSIGNMENT');
      catalogSpy.mockClear(); readSpy.mockClear();
      await hooks['experimental.chat.messages.transform']!({}, output as any);
      expect((output.messages.at(-1)!.parts[0] as any).text).toContain('context_authorization_denied');
      const denied = JSON.parse(await hooks.tool!.hive_context_read.execute({ scope: 'project', name: 'zz-required' }, { ...childContext, agent: 'scout-researcher' }) as string);
      expect(denied.reason).toBe('context_authorization_denied');
      expect(catalogSpy).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
      const mutated = registry.sessions.find((session: any) => session.sessionId === child);
      Object.assign(mutated, { agent: 'forager-worker', baseAgent: 'forager-worker', sessionKind: 'task-worker' });
      delete mutated.workerAssignment;
      delete mutated.workerPromptPath;
      delete mutated.assignmentSourceSessionId;
      fs.writeFileSync(registryPath, JSON.stringify(registry));
      fs.writeFileSync(artifact, original);
      inventorySpy.mockClear(); headerSpy.mockClear();
      await hooks['experimental.chat.messages.transform']!({}, output as any);
      expect((output.messages.at(-1)!.parts[0] as any).text).toContain('assignment_recovery_error');
      const missing = JSON.parse(await hooks.tool!.hive_context_read.execute({ scope: 'project', name: 'zz-required' }, childContext) as string);
      expect(missing.reason).toBe('assignment_recovery_error');
      await expect(hooks['tool.execute.before']!({ tool: 'bash', sessionID: child, callID: 'invalid-worker-execution' }, { args: { command: 'true' } })).rejects.toThrow(/assignment_recovery_error/);
      expect(catalogSpy).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
      expect(inventorySpy).not.toHaveBeenCalled();
      expect(headerSpy).not.toHaveBeenCalled();
    } finally {
      catalogSpy.mockRestore(); readSpy.mockRestore(); inventorySpy.mockRestore(); headerSpy.mockRestore();
    }
  }, 30_000);

  it('denies relocated historical workers and permits only a fresh launch in an independently valid workspace', async () => {
    const feature = 'relocated-assignment';
    const oldParent = 'relocation-parent';
    const oldChild = 'relocation-old-child';
    const freshParent = 'relocation-fresh-parent';
    const freshChild = 'relocation-fresh-child';
    const oldAdhocChild = 'relocation-old-adhoc';
    const freshAdhocChild = 'relocation-fresh-adhoc';
    const runtimeClient = { ...(ROOT_SESSION_CLIENT as any), session: { ...(ROOT_SESSION_CLIENT as any).session,
      get: async ({ path: input }: any) => ({ data: { id: input.id, parentID: [oldChild, oldAdhocChild].includes(input.id) ? oldParent : [freshChild, freshAdhocChild].includes(input.id) ? freshParent : undefined } }),
    } } as PluginInput['client'];
    const initial = await createHooksForTest(testRoot, oldParent, testRoot, runtimeClient);
    await initial.hooks.tool!.hive_feature_create.execute({ name: feature }, initial.toolContext);
    await initial.hooks.tool!.hive_plan_write.execute({ feature, content: createSingleTaskPlan('Relocated assignment', 'Require a fresh authenticated launch after independently preparing the relocated workspace.') }, initial.toolContext);
    await initial.hooks.tool!.hive_plan_approve.execute({ feature }, initial.toolContext);
    await initial.hooks.tool!.hive_tasks_sync.execute({ feature }, initial.toolContext);
    const launch = JSON.parse(await initial.hooks.tool!.hive_worktree_start.execute({ feature, task: FIRST_TASK }, initial.toolContext) as string);
    await initial.hooks['tool.execute.before']!({ tool: 'task', sessionID: oldParent, callID: 'old-launch' }, { args: { ...launch.taskToolCall } });
    await initial.hooks.event?.({ event: { type: 'session.created', properties: { info: { id: oldChild, parentID: oldParent } } } } as any);
    await observeNativeTaskChild(initial.hooks, { parentSessionID: oldParent, callID: 'old-launch', childSessionID: oldChild, expectedAgent: 'forager-worker' });
    await initial.hooks['chat.message']!({ sessionID: oldChild, agent: 'forager-worker' }, { message: { agent: 'forager-worker' }, parts: [] } as any);
    await initial.hooks['tool.execute.after']!({ tool: 'task', sessionID: oldParent, callID: 'old-launch', args: launch.taskToolCall }, { title: 'task', output: '', metadata: { sessionId: oldChild } });
    const historical = new SessionService(testRoot).getGlobal(oldChild)!;
    const oldRun = JSON.parse(await initial.hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'historical-run', workerInstructions: 'Inspect project supporting knowledge.' }, initial.toolContext) as string);
    await initial.hooks['tool.execute.before']!({ tool: 'task', sessionID: oldParent, callID: 'old-run-launch' }, { args: { ...oldRun.taskToolCall } });
    await initial.hooks.event?.({ event: { type: 'session.created', properties: { info: { id: oldAdhocChild, parentID: oldParent } } } } as any);
    await observeNativeTaskChild(initial.hooks, { parentSessionID: oldParent, callID: 'old-run-launch', childSessionID: oldAdhocChild, expectedAgent: 'forager-worker' });
    await initial.hooks['chat.message']!({ sessionID: oldAdhocChild, agent: 'forager-worker' }, { message: { agent: 'forager-worker' }, parts: [] } as any);
    await initial.hooks['tool.execute.after']!({ tool: 'task', sessionID: oldParent, callID: 'old-run-launch', args: oldRun.taskToolCall }, { title: 'task', output: '', metadata: { sessionId: oldAdhocChild } });
    const historicalRun = new SessionService(testRoot).getGlobal(oldAdhocChild)!;
    expect(historicalRun.adHocRunId).toBe('historical-run');
    const oldArtifact = fs.readFileSync(path.join(testRoot, historical.workerAssignment!.locator));
    const relocated = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'relocated-'));
    try {
      initBareRepo(relocated);
      fs.cpSync(path.join(testRoot, '.hive'), path.join(relocated, '.hive'), { recursive: true });
      const fresh = await createHooksForTest(relocated, freshParent, relocated, runtimeClient);
      const forbiddenAccess: string[] = [];
      const spies = ['accessSync', 'statSync', 'lstatSync', 'readFileSync', 'realpathSync', 'readdirSync', 'openSync'].map(name => {
        const original = (fs as any)[name];
        return spyOn(fs as any, name).mockImplementation((file: any, ...args: any[]) => {
          if (String(file) === testRoot || String(file).startsWith(`${testRoot}${path.sep}`)) forbiddenAccess.push(`${name}:${file}`);
          return original(file, ...args);
        });
      });
      const asyncFs = await import('fs/promises');
      for (const name of ['access', 'stat', 'lstat', 'readFile', 'realpath', 'readdir', 'open']) {
        const original = (asyncFs as any)[name];
        spies.push(spyOn(asyncFs as any, name).mockImplementation((file: any, ...args: any[]) => {
          if (String(file) === testRoot || String(file).startsWith(`${testRoot}${path.sep}`)) forbiddenAccess.push(`${name}:${file}`);
          return original(file, ...args);
        }));
      }
      const gitPaths: string[] = [];
      const originalGetGit = (WorktreeService.prototype as any).getGit;
      const gitSpy = spyOn(WorktreeService.prototype as any, 'getGit').mockImplementation(function(this: any, cwd: string) {
        gitPaths.push(cwd ?? this.config.baseDir);
        return originalGetGit.call(this, cwd);
      });
      const adhocGitPaths: string[] = [];
      const originalAdhocGetGit = (AdhocWorktreeService.prototype as any).getGit;
      const adhocGitSpy = spyOn(AdhocWorktreeService.prototype as any, 'getGit').mockImplementation(function(this: any, cwd: string) {
        adhocGitPaths.push(cwd ?? this.config.baseDir);
        return originalAdhocGetGit.call(this, cwd);
      });
      const adhocWorktreePath = path.join(relocated, '.hive', '.worktrees', 'adhoc', 'historical-run');
      const adhocPointerPath = path.join(adhocWorktreePath, '.git');
      const adhocPointerBefore = fs.readFileSync(adhocPointerPath);
      const taskWorktreePointerPath = path.join(relocated, '.hive', '.worktrees', feature, FIRST_TASK, '.git');
      const taskPointerBefore = fs.readFileSync(taskWorktreePointerPath);
      const copiedStatusPath = path.join(relocated, '.hive', 'features', '01_relocated-assignment', 'tasks', FIRST_TASK, 'status.json');
      const copiedStatusBefore = fs.readFileSync(copiedStatusPath, 'utf-8');
      try {
        const denied = JSON.parse(await fresh.hooks.tool!.hive_context_read.execute({ scope: 'project' }, { ...fresh.toolContext, sessionID: oldChild, agent: 'forager-worker' }) as string);
        expect(denied.success).toBe(false);
        const deniedRun = JSON.parse(await fresh.hooks.tool!.hive_context_read.execute({ scope: 'project' }, { ...fresh.toolContext, sessionID: oldAdhocChild, agent: 'forager-worker' }) as string);
        expect(deniedRun.success).toBe(false);
        const deniedStart = JSON.parse(await fresh.hooks.tool!.hive_worktree_start.execute({ feature, task: FIRST_TASK }, fresh.toolContext) as string);
        expect(deniedStart.success).toBe(false);
        expect(deniedStart.terminal).toBe(true);
        expect(deniedStart.reasonCode).toBe('WORKTREE_LINKAGE_INVALID');
        expect(deniedStart.retryable).toBe(false);
        expect(deniedStart.action).toBe('start_fresh_run');
        expect(deniedStart.taskToolCall).toBeUndefined();
        expect(String(deniedStart.nextAction)).toContain('independently valid workspace');
        expect(String(deniedStart.nextAction)).toContain('Do not repair, rewrite, or migrate Git metadata');
        const deniedAdhocStart = JSON.parse(await fresh.hooks.tool!.hive_adhoc_worktree_start.execute(
          { runId: 'historical-run', workerInstructions: 'Do not reuse the relocated workspace.' },
          fresh.toolContext,
        ) as string);
        expect(deniedAdhocStart.success).toBe(false);
        expect(deniedAdhocStart.reasonCode).toBe('WORKTREE_LINKAGE_INVALID');
        expect(deniedAdhocStart.retryable).toBe(false);
        expect(deniedAdhocStart.action).toBe('start_fresh_run');
        expect(deniedAdhocStart.launchId).toBeUndefined();
        expect(deniedAdhocStart.taskToolCall).toBeUndefined();
        expect(deniedAdhocStart.backgroundTaskCall).toBeUndefined();
        expect(String(deniedAdhocStart.nextAction)).toContain('independently valid workspace');
        fs.writeFileSync(copiedStatusPath, JSON.stringify({ ...JSON.parse(copiedStatusBefore), status: 'done' }));
        const deniedTaskMerge = JSON.parse(await fresh.hooks.tool!.hive_merge.execute(
          { feature, task: FIRST_TASK, strategy: 'squash', message: TEST_MERGE_MESSAGE },
          fresh.toolContext,
        ) as string);
        expect(deniedTaskMerge.success).toBe(false);
        expect(String(deniedTaskMerge.error)).toContain('linkage preflight failed');
        fs.writeFileSync(copiedStatusPath, copiedStatusBefore);
        const deniedDiscard = JSON.parse(await fresh.hooks.tool!.hive_worktree_discard.execute(
          { feature, task: FIRST_TASK },
          fresh.toolContext,
        ) as string);
        expect(deniedDiscard.success).toBe(false);
        expect(deniedDiscard.reasonCode).toBe('WORKTREE_LINKAGE_INVALID');
        expect(deniedDiscard.retryable).toBe(false);
        expect(deniedDiscard.action).toBe('start_fresh_run');
        const deniedAdhocMerge = JSON.parse(await fresh.hooks.tool!.hive_adhoc_merge.execute(
          { runId: 'historical-run', strategy: 'squash', message: TEST_MERGE_MESSAGE },
          fresh.toolContext,
        ) as string);
        expect(deniedAdhocMerge.success).toBe(false);
        expect(String(deniedAdhocMerge.error)).toContain('linkage preflight failed');
        const deniedAdhocCleanup = JSON.parse(await fresh.hooks.tool!.hive_adhoc_cleanup.execute(
          { runId: 'historical-run', deleteBranch: true },
          fresh.toolContext,
        ) as string);
        expect(deniedAdhocCleanup.success).toBe(false);
        expect(String(deniedAdhocCleanup.error)).toContain('linkage preflight failed');
        expect(forbiddenAccess).toEqual([]);
        expect(gitPaths.every(cwd => cwd === relocated)).toBe(true);
        expect(adhocGitPaths.length).toBeGreaterThan(0);
        expect(adhocGitPaths.every(cwd => cwd === relocated)).toBe(true);
        expect(fs.readFileSync(adhocPointerPath)).toEqual(adhocPointerBefore);
        expect(fs.readFileSync(taskWorktreePointerPath)).toEqual(taskPointerBefore);
        expect(fs.existsSync(adhocWorktreePath)).toBe(true);
        expect(execSync('git branch --list', { cwd: relocated, encoding: 'utf8' })).not.toContain('hive/adhoc/historical-run');
        expect(execSync('git status --porcelain', { cwd: relocated, encoding: 'utf8' }).trim()).toBe('');
      } finally {
        spies.forEach(spy => spy.mockRestore()); gitSpy.mockRestore(); adhocGitSpy.mockRestore();
      }
      // The operator prepares a separate workspace; the runtime never repairs copied Git pointers.
      fs.rmSync(path.join(relocated, '.hive', '.worktrees'), { recursive: true });
      const recovered = JSON.parse(await fresh.hooks.tool!.hive_worktree_start.execute({ feature, task: FIRST_TASK }, fresh.toolContext) as string);
      expect(recovered.taskToolCall).toBeDefined();
      await fresh.hooks['tool.execute.before']!({ tool: 'task', sessionID: freshParent, callID: 'fresh-launch' }, { args: { ...recovered.taskToolCall } });
      await fresh.hooks.event?.({ event: { type: 'session.created', properties: { info: { id: freshChild, parentID: freshParent } } } } as any);
      await observeNativeTaskChild(fresh.hooks, { parentSessionID: freshParent, callID: 'fresh-launch', childSessionID: freshChild, expectedAgent: 'forager-worker' });
      await fresh.hooks['chat.message']!({ sessionID: freshChild, agent: 'forager-worker' }, { message: { agent: 'forager-worker' }, parts: [] } as any);
      await fresh.hooks['tool.execute.after']!({ tool: 'task', sessionID: freshParent, callID: 'fresh-launch', args: recovered.taskToolCall }, { title: 'task', output: '', metadata: { sessionId: freshChild } });
      const freshRun = JSON.parse(await fresh.hooks.tool!.hive_adhoc_worktree_create.execute({ runId: 'fresh-run', workerInstructions: 'Inspect project supporting knowledge.' }, fresh.toolContext) as string);
      await fresh.hooks['tool.execute.before']!({ tool: 'task', sessionID: freshParent, callID: 'fresh-run-launch' }, { args: { ...freshRun.taskToolCall } });
      await fresh.hooks.event?.({ event: { type: 'session.created', properties: { info: { id: freshAdhocChild, parentID: freshParent } } } } as any);
      await observeNativeTaskChild(fresh.hooks, { parentSessionID: freshParent, callID: 'fresh-run-launch', childSessionID: freshAdhocChild, expectedAgent: 'forager-worker' });
      await fresh.hooks['chat.message']!({ sessionID: freshAdhocChild, agent: 'forager-worker' }, { message: { agent: 'forager-worker' }, parts: [] } as any);
      await fresh.hooks['tool.execute.after']!({ tool: 'task', sessionID: freshParent, callID: 'fresh-run-launch', args: freshRun.taskToolCall }, { title: 'task', output: '', metadata: { sessionId: freshAdhocChild } });
      const sessions = new SessionService(relocated);
      expect(sessions.getGlobal(oldChild)).toEqual(historical);
      expect(sessions.getGlobal(oldAdhocChild)).toEqual(historicalRun);
      expect(sessions.getGlobal(freshAdhocChild)).toMatchObject({ projectRoot: relocated, adHocRunId: 'fresh-run' });
      expect(sessions.getGlobal(freshChild)!.workerAssignment!.projectRoot).toBe(relocated);
      expect(sessions.getGlobal(freshChild)!.workerAssignment!.attempt).toBeGreaterThan(historical.workerAssignment!.attempt);
      expect(fs.readFileSync(path.join(relocated, historical.workerAssignment!.locator))).toEqual(oldArtifact);
      for (const [recipient, success] of [[oldChild, false], [freshChild, true], [oldAdhocChild, false], [freshAdhocChild, true]] as const) {
        const result = JSON.parse(await fresh.hooks.tool!.hive_context_read.execute({ scope: 'project', view: 'catalog' }, { ...fresh.toolContext, sessionID: recipient, agent: 'forager-worker' }) as string);
        expect(result.success).toBe(success);
      }
      expect(new SessionService(testRoot).getGlobal(oldChild)).toEqual(historical);
      expect(fs.readFileSync(path.join(testRoot, historical.workerAssignment!.locator))).toEqual(oldArtifact);
    } finally { fs.rmSync(relocated, { recursive: true, force: true }); }
  }, 30_000);

  it("uses one-shot parent-scoped launch intents and rejects replay, wrong agents, and delayed attempts", async () => {
    const previousBackgroundEnv = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    const previousExperimental = process.env.OPENCODE_EXPERIMENTAL;
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "1";

    try {
      let failSessionLookup = false;
      let featureTaskTerminal = false;
      const retryableSessionClient = {
        ...(ROOT_SESSION_CLIENT as any),
        session: {
          ...(ROOT_SESSION_CLIENT as any).session,
          get: async ({ path: inputPath }: { path: { id: string } }) => {
            if (failSessionLookup) throw new Error("transient session lookup failure");
            return {
              data: {
                id: inputPath.id,
                parentID: inputPath.id === 'feature-task-child'
                  ? 'sess_background_no_worker_session'
                  : undefined,
                time: { created: Date.now(), updated: Date.now() },
              },
            };
          },
          status: async () => ({ data: featureTaskTerminal ? { 'feature-task-child': { type: 'idle' } } : {} }),
          messages: async ({ path: inputPath }: { path: { id: string } }) => ({
            data: inputPath.id === 'feature-task-child' && featureTaskTerminal
              ? [{ info: { role: 'assistant', time: { completed: Date.now() } }, parts: [] }]
              : [],
          }),
        },
      } as PluginInput['client'];
      const { hooks, toolContext } = await createHooksForTest(
        testRoot,
        "sess_background_no_worker_session",
        testRoot,
        retryableSessionClient,
      );

      await hooks.tool!.hive_feature_create.execute({ name: "no-worker-session" }, toolContext);
      await hooks.tool!.hive_plan_write.execute(
        { content: createSingleTaskPlan("No Worker Session", "Yes, this integration test validates workerSession is not generic background board state before launch observation."), feature: "no-worker-session" },
        toolContext,
      );
      await hooks.tool!.hive_plan_approve.execute({ feature: "no-worker-session" }, toolContext);
      await hooks.tool!.hive_tasks_sync.execute({ feature: "no-worker-session" }, toolContext);
      await hooks.tool!.hive_context_write.execute({
        feature: 'no-worker-session',
        name: 'feature-catalog-entry',
        content: durableContext('supporting feature body'),
      }, toolContext);
      await hooks.tool!.hive_context_write.execute({
        scope: 'project',
        name: 'project-catalog-entry',
        content: `---\ndescription: Project catalog entry\nread_when: Read in the catalog test.\nowner: platform\nreview_after: 2027-01-01\n---\n\nsupporting project body`,
      }, toolContext);

      const launchRaw = await hooks.tool!.hive_worktree_start.execute(
        { feature: "no-worker-session", task: FIRST_TASK },
        toolContext,
      );
      const launch = JSON.parse(launchRaw as string) as {
        taskToolCall: { description: string; prompt: string; subagent_type: string };
        backgroundTaskCall: { background: true; description: string; prompt: string; subagent_type: string };
      };
      const statusPath = path.join(
        testRoot,
        ".hive",
        "features",
        "01_no-worker-session",
        "tasks",
        FIRST_TASK,
        "status.json",
      );
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as {
        workerSession?: unknown;
        idempotencyKey?: string;
        workerAttempt?: number;
      };

      expect(status.idempotencyKey).toBe("hive-no-worker-session-01-first-task-1");
      expect(status.workerAttempt).toBe(1);
      expect(status.workerSession).toBeUndefined();

      await hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'generic-research',
      }, {
        args: {
          subagent_type: 'scout-researcher',
          description: 'Research something else',
          prompt: 'Inspect unrelated code',
        },
      });
      await hooks['tool.execute.after']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'generic-research',
        args: {
          subagent_type: 'scout-researcher',
          description: 'Research something else',
          prompt: 'Inspect unrelated code',
        },
      }, {
        title: 'task',
        output: 'research complete',
        metadata: { sessionId: 'generic-child' },
      });
      expect(JSON.parse(fs.readFileSync(statusPath, "utf-8")).workerSession).toBeUndefined();

      await hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'generic-review',
      }, {
        args: {
          subagent_type: 'code-reviewer',
          description: 'Review something else',
          prompt: 'Review unrelated code',
        },
      });

      const canonicalAssignmentPath = launch.taskToolCall.prompt.replace('Follow instructions in @', '');
      const canonicalAssignment = fs.readFileSync(path.join(testRoot, canonicalAssignmentPath), 'utf8');
      const workerOutput = {
        title: 'task',
        output: '',
        metadata: { sessionId: 'feature-task-child' },
      };
      const mutatedDispatch = { args: {
        ...launch.backgroundTaskCall,
        description: 'Caller-edited task description',
        prompt: 'Caller-written text must not become the assignment',
      } };
      await hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'mutated-worker',
        args: { ...launch.backgroundTaskCall },
      }, mutatedDispatch);
      await expect(hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'second-before-child',
      }, { args: { ...launch.backgroundTaskCall } })).rejects.toThrow(/launch_binding_error[\s\S]*already claimed/);
      expect(mutatedDispatch.args.prompt).toBe(canonicalAssignment);
      expect(mutatedDispatch.args.prompt).not.toContain('Caller-written text');
      expect(JSON.parse(fs.readFileSync(path.join(testRoot, '.hive', 'background-jobs.json'), 'utf8')).pendingLaunches).toEqual([
        expect.objectContaining({ disposition: 'claimed', callId: 'mutated-worker' }),
      ]);

      await hooks.event?.({ event: {
        type: 'session.created',
        properties: { info: { id: 'feature-task-child', parentID: toolContext.sessionID } },
      } } as any);
      await observeNativeTaskChild(hooks, {
        parentSessionID: toolContext.sessionID,
        callID: 'mutated-worker',
        childSessionID: 'feature-task-child',
        expectedAgent: 'forager-worker',
      });
      await hooks['chat.message']?.({ sessionID: 'feature-task-child', agent: 'forager-worker' }, {
        message: { agent: 'forager-worker' }, parts: [],
      } as any);
      const earlyAuthority = JSON.parse(await hooks.tool!.hive_context_read.execute(
        { scope: 'project', view: 'catalog' },
        { ...toolContext, sessionID: 'feature-task-child', agent: 'forager-worker' },
      ) as string);
      expect(earlyAuthority.success).toBe(true);
      await hooks.event?.({ event: {
        type: 'session.created',
        properties: { info: { id: 'feature-task-child', parentID: toolContext.sessionID } },
      } } as any);
      await hooks['chat.message']?.({ sessionID: 'feature-task-child', agent: 'forager-worker' }, {
        message: { agent: 'forager-worker' }, parts: [],
      } as any);
      await expect(hooks.event?.({ event: { type: 'message.part.updated', properties: { part: {
        type: 'tool', tool: 'task', sessionID: toolContext.sessionID, callID: 'mutated-worker',
        state: { input: mutatedDispatch.args, metadata: { sessionId: 'second-child' } },
      } } } } as any)).rejects.toThrow(/launch_binding_error[\s\S]*different child/);
      await hooks['tool.execute.after']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'mutated-worker',
        args: mutatedDispatch.args,
      }, workerOutput);
      expect(JSON.parse(fs.readFileSync(statusPath, "utf-8")).workerSession.sessionId).toBe('feature-task-child');

      failSessionLookup = true;
      await expect(hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'failed-before-worker',
        args: { ...launch.backgroundTaskCall },
      }, {
        args: { ...launch.backgroundTaskCall },
      })).rejects.toThrow('Runtime session lineage is unavailable');
      failSessionLookup = false;
      expect(JSON.parse(fs.readFileSync(statusPath, "utf-8")).workerSession.sessionId).toBe('feature-task-child');

      const associated = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as {
        workerSession?: { sessionId?: string; mode?: string };
        workerAssignment: { locator: string; contentHash: string };
      };
      expect(associated.workerSession?.sessionId).toBe('feature-task-child');
      expect(associated.workerSession?.mode).toBe('delegate');
      expect(associated.workerAssignment?.locator).toBe(canonicalAssignmentPath);
      const assignmentBytes = fs.readFileSync(path.join(testRoot, associated.workerAssignment.locator));
      expect(createHash('sha256').update(assignmentBytes).digest('hex')).toBe(associated.workerAssignment.contentHash);
      const boundChild = new SessionService(testRoot).getGlobal('feature-task-child');
      expect(boundChild?.workerAssignment).toEqual(associated.workerAssignment);
      const catalogOutput = {
        messages: [{
          info: { id: 'catalog-base', sessionID: 'feature-task-child', role: 'assistant', time: { created: Date.now() } },
          parts: [{ id: 'catalog-part', sessionID: 'feature-task-child', messageID: 'catalog-base', type: 'text', text: 'existing' }],
        }],
      };
      await hooks['experimental.chat.messages.transform']?.({}, catalogOutput as any);
      await hooks['experimental.chat.messages.transform']?.({}, catalogOutput as any);
      const catalogMessages = catalogOutput.messages.filter(message => message.parts.some(part => part.text?.startsWith('[hive-live-context-catalog/v1]')));
      expect(catalogMessages).toHaveLength(1);
      const catalogText = catalogMessages[0]!.parts[0]!.text!;
      expect(Buffer.byteLength(catalogText, 'utf8')).toBeLessThanOrEqual(8 * 1024);
      expect(catalogText).toContain('project-catalog-entry');
      expect(catalogText).toContain('feature-catalog-entry');
      expect(catalogText).not.toContain('supporting project body');
      expect(catalogText).not.toContain('supporting feature body');
      expect(workerOutput.output).toContain('hive_task_trace({ task_id: "feature-task-child" })');

      const hiveStatusRaw = await hooks.tool!.hive_status.execute(
        { feature: "no-worker-session" },
        toolContext,
      );
      const hiveStatus = JSON.parse(hiveStatusRaw as string) as {
        tasks: { list: Array<{ traceTaskId?: string }> };
      };
      expect(hiveStatus.tasks.list[0].traceTaskId).toBe('feature-task-child');

      await expect(hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'replayed-worker',
      }, {
        args: { ...launch.backgroundTaskCall },
      })).rejects.toThrow(/launch_binding_error/);
      expect(JSON.parse(fs.readFileSync(statusPath, 'utf-8')).workerSession.sessionId).toBe('feature-task-child');

      await hooks.event?.({ event: {
        type: 'session.status',
        properties: { sessionID: 'feature-task-child', status: { type: 'idle' } },
      } } as any);
      featureTaskTerminal = true;

      const replacementRaw = await hooks.tool!.hive_worktree_start.execute(
        { feature: 'no-worker-session', task: FIRST_TASK },
        toolContext,
      );
      const delayed = JSON.parse(replacementRaw as string) as {
        taskToolCall: { description: string; prompt: string; subagent_type: string };
      };
      const pendingReplacement = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as {
        idempotencyKey?: string;
        workerAttempt?: number;
        workerSession?: unknown;
      };
      expect(pendingReplacement.idempotencyKey).toBe('hive-no-worker-session-01-first-task-2');
      expect(pendingReplacement.workerAttempt).toBe(2);
      expect(pendingReplacement.workerSession).toBeUndefined();
      const pendingStatus = JSON.parse(await hooks.tool!.hive_status.execute(
        { feature: 'no-worker-session' },
        toolContext,
      ) as string) as { tasks: { list: Array<{ traceTaskId?: string }> } };
      expect(pendingStatus.tasks.list[0].traceTaskId).toBeUndefined();

      await hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'delayed-second-attempt',
      }, {
        args: { ...delayed.taskToolCall },
      });

      await expect(hooks.tool!.hive_worktree_start.execute(
        { feature: 'no-worker-session', task: FIRST_TASK },
        toolContext,
      )).rejects.toThrow(/writer_fence_error[\s\S]*awaiting exact native child correlation/);
      expect(JSON.parse(fs.readFileSync(statusPath, 'utf-8'))).toMatchObject({
        workerAttempt: 2,
        idempotencyKey: 'hive-no-worker-session-01-first-task-2',
      });

      await hooks['tool.execute.after']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'delayed-second-attempt',
        args: { ...delayed.taskToolCall },
      }, {
        title: 'task',
        output: 'late second attempt',
        metadata: { sessionId: 'late-second-child' },
      });
      await hooks.event?.({ event: {
        type: 'session.created',
        properties: { info: { id: 'late-second-child', parentID: toolContext.sessionID } },
      } } as any);
      await hooks['chat.message']?.({ sessionID: 'late-second-child', agent: 'forager-worker' }, {
        message: { agent: 'forager-worker' }, parts: [],
      } as any);
      expect(JSON.parse(fs.readFileSync(statusPath, 'utf-8')).workerSession.sessionId).toBe('late-second-child');

      await expect(hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'wrong-agent-worker',
      }, {
        args: { ...delayed.taskToolCall, subagent_type: 'scout-researcher' },
      })).rejects.toThrow(/hive_launch_id is valid only for a Forager-derived task target/);

      await expect(hooks['tool.execute.before']?.({
        tool: 'task',
        sessionID: toolContext.sessionID,
        callID: 'replacement-worker',
      }, {
        args: { ...delayed.taskToolCall },
      })).rejects.toThrow(/launch_binding_error[\s\S]*(already claimed|unknown or superseded)/);
    } finally {
      if (previousBackgroundEnv === undefined) {
        delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      } else {
        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previousBackgroundEnv;
      }
      if (previousExperimental === undefined) {
        delete process.env.OPENCODE_EXPERIMENTAL;
      } else {
        process.env.OPENCODE_EXPERIMENTAL = previousExperimental;
      }
    }
  }, 30_000);

  it("excludes non-execution context from worker prompt payloads", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: ROOT_SESSION_CLIENT,
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
        content: durableContext("Technical decision that workers should receive."),
      },
      toolContext
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: "reserved-overview-feature",
        name: "learnings",
        content: durableContext("Durable learning that workers should receive."),
      },
      toolContext
    );

    const raw = await hooks.tool!.hive_worktree_start.execute(
      { feature: "reserved-overview-feature", task: "01-first-task" },
      toolContext
    );

    const result = JSON.parse(raw as string) as {
      worktreePath?: string;
      workerPromptPath?: string;
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
    const workerPromptPath = path.join(testRoot, result.workerPromptPath!);

    const specContent = fs.readFileSync(specPath, "utf-8");
    const workerPromptContent = fs.readFileSync(workerPromptPath, "utf-8");

    expect(specContent).not.toContain("Technical decision that workers should receive.");
    expect(specContent).not.toContain("Durable learning that workers should receive.");
    expect(specContent).not.toContain("## overview");
    expect(specContent).not.toContain("Human-facing overview that must stay out of worker execution context.");
    expect(specContent).not.toContain("## draft");
    expect(specContent).not.toContain("Scratchpad draft that must stay out of worker execution context.");
    expect(specContent).not.toContain("## execution-decisions");
    expect(specContent).not.toContain("Operational decision that must stay out of worker execution context.");
    expect(workerPromptContent).not.toContain("Technical decision that workers should receive.");
    expect(workerPromptContent).not.toContain("Durable learning that workers should receive.");
    expect(workerPromptContent).not.toContain("Human-facing overview that must stay out of worker execution context.");
    expect(workerPromptContent).not.toContain("Scratchpad draft that must stay out of worker execution context.");
    expect(workerPromptContent).not.toContain("Operational decision that must stay out of worker execution context.");
  });

  it('keeps context bodies out of immutable assignments while retaining completed-task history', async () => {
    const feature = 'context-priority-feature';
    const { hooks, toolContext } = await createHooksForTest(testRoot, 'sess_context_priority');
    await hooks.tool!.hive_feature_create.execute({ name: feature }, toolContext);
    const plan = `# Context Priority Feature

## Discovery

**Q: Is this a test?**
A: Yes, this regression validates that durable context bodies stay out of fixed assignments across task attempts.

## Tasks

### 1. Foundation
**Depends on**: none
Build it.

### 2. Current
**Depends on**: 1
Use it.
`;
    await hooks.tool!.hive_plan_write.execute({ content: plan, feature }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature }, toolContext);

    await hooks.tool!.hive_context_write.execute(
      { feature, name: 'current-context', content: durableContext('current task context'), task: '02-current' },
      toolContext,
    );
    await hooks.tool!.hive_context_write.execute(
      { feature, name: 'dependency-context', content: durableContext('dependency context'), task: '01-foundation' },
      toolContext,
    );
    await hooks.tool!.hive_context_write.execute(
      { feature, name: 'untagged-context', content: durableContext('untagged context') },
      toolContext,
    );

    await hooks.tool!.hive_task_update.execute(
      { feature, task: '01-foundation', status: 'done', summary: 'Foundation complete.' },
      toolContext,
    );
    await hooks.tool!.hive_task_update.execute(
      { feature, task: '01-foundation', status: 'failed', summary: 'Retry required.' },
      toolContext,
    );
    await hooks.tool!.hive_context_write.execute(
      { feature, name: 'between-attempts', content: durableContext('Context written after the first completion.') },
      toolContext,
    );
    await hooks.tool!.hive_task_update.execute(
      { feature, task: '01-foundation', status: 'done', summary: 'Final completion.' },
      toolContext,
    );

    await hooks.tool!.hive_worktree_start.execute({ feature, task: '02-current' }, toolContext);
    const spec = fs.readFileSync(
      path.join(
        testRoot,
        '.hive',
        'features',
        '01_context-priority-feature',
        'tasks',
        '02-current',
        'spec.md',
      ),
      'utf-8',
    );

    expect(spec).not.toContain('current task context');
    expect(spec).not.toContain('dependency context');
    expect(spec).not.toContain('untagged context');
    expect(spec).not.toContain('Context written after the first completion.');
    expect(spec).toContain('Final completion.');
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
        description: "Implements and verifies changes in an isolated worktree; diagnosis-only assignments remain report-only.",
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
    expect(execStart.instructions).toContain("Choose autonomously the agent whose description best matches the task's domain, workflow, artifact type, or concrete review/approach risk; use the built-in base agent when no configured custom subagent is a closer fit.");
    expect(execStart.instructions).toContain('Candidate-specific conditions in an individual description still apply, including a condition that the candidate may be selected only when the operator explicitly names it.');
    expect(execStart.instructions).not.toContain('or when the operator explicitly names it');
    expect(execStart.instructions).toContain(`Default to \`forager-worker\` if no specialist is a better match.
Choose autonomously the agent whose description best matches the task's domain, workflow, artifact type, or concrete review/approach risk; use the built-in base agent when no configured custom subagent is a closer fit.
Candidate-specific conditions in an individual description still apply, including a condition that the candidate may be selected only when the operator explicitly names it.

- \`forager-worker\` — Implements and verifies changes in an isolated worktree; diagnosis-only assignments remain report-only.
- \`forager-example-template\` — Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.
- \`forager-ui\` — Use for UI-heavy implementation tasks.`);
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
    expect(result.error).toContain("No live feature could be resolved");
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
    expect(result.taskToolCall?.prompt).toMatch(/\/assignments\/attempt-1\.md$/);
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
    expect(invalidRetry.retryReason).toContain('blocked-task continuation');
    expect(invalidRetry.retryReason).not.toMatch(/blocked resume/i);
    expect(invalidRetry.currentStatus).toBe("in_progress");
    expect(Array.isArray(invalidRetry.hints)).toBe(true);
    expect(invalidRetry.hints?.length).toBeGreaterThan(0);
    expect(invalidRetry.hints?.some((hint) => /blocked-task continuation/i.test(hint))).toBe(true);
    expect(invalidRetry.hints?.some((hint) => /blocked-resume/i.test(hint))).toBe(false);
    expect(invalidRetry.hints?.some((hint) => /start|resume/i.test(hint))).toBe(true);
    expect(invalidRetry.hints?.some((hint) => /hive_status|status/i.test(hint))).toBe(true);
  });

  it('continues a blocked task with a fresh worker in the existing worktree', async () => {
    const feature = 'blocked-continuation-feature';
    const { hooks, toolContext, worktreePath } = await createSingleTaskWorktree(
      testRoot,
      'sess_blocked_continuation',
      feature,
      'Blocked Continuation Feature',
      'Yes, this test validates self-contained blocked-task continuation in the existing worktree.',
    );
    const summary = 'Implemented request parsing; authorization policy needs an operator decision.';
    const decision = 'Keep the strict authorization policy and update the fixture.';
    const statusPath = path.join(
      testRoot,
      '.hive',
      'features',
      '01_blocked-continuation-feature',
      'tasks',
      FIRST_TASK,
      'status.json',
    );
    const initialStatus = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as {
      baseCommit: string;
      workerAssignment: { attempt: number; locator: string; contentHash: string };
    };
    const initialBaseCommit = initialStatus.baseCommit;
    const initialAssignmentBytes = fs.readFileSync(path.join(testRoot, initialStatus.workerAssignment.locator));

    const blockedRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: 'blocked',
        summary,
        blocker: {
          reason: 'Authorization policy is ambiguous.',
          options: ['Keep strict policy', 'Relax policy'],
        },
      },
      toolContext,
    );
    const blocked = JSON.parse(blockedRaw as string) as { message?: string; nextAction?: string; reportPath: string; reportReference: string };
    const blockedReport = fs.readFileSync(blocked.reportReference, 'utf8');
    expect(blockedReport).toContain(`\n## Summary\n\n${summary}\n`);
    expect(blocked.reportReference).not.toBe(blocked.reportPath);
    expect(blockedReport).toContain('Authorization policy is ambiguous.');
    expect(blockedReport).toContain('**Worker-reported outcome:** blocked');
    expect(blockedReport).toContain('No Git operation was requested');
    expect(blockedReport).not.toContain('**Created commit:**');
    expect(fs.existsSync(blocked.reportPath)).toBe(true);
    expect(blocked.message).toMatch(/launch a new worker.*existing worktree/i);
    expect(blocked.nextAction).toMatch(/fresh worker.*existing worktree/i);
    expect(blocked.message).not.toMatch(/resume/i);
    const blockedStatus = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as {
      baseCommit: string;
      aggregateBranchDiff?: unknown;
    };
    expect(blockedStatus.baseCommit).toBe(initialBaseCommit);
    expect(blockedStatus.aggregateBranchDiff).toBeUndefined();

    const missingDecisionRaw = await hooks.tool!.hive_worktree_create.execute(
      { feature, task: FIRST_TASK, continueFrom: 'blocked' },
      toolContext,
    );
    const missingDecision = JSON.parse(missingDecisionRaw as string) as {
      success?: boolean;
      terminal?: boolean;
      reason?: string;
      error?: string;
    };
    expect(missingDecision.success).toBe(false);
    expect(missingDecision.terminal).toBe(true);
    expect(missingDecision.reason).toBe('operator_decision_required');
    expect(missingDecision.error).toMatch(/operator decision.*fresh worker.*existing worktree/i);

    const continuationRaw = await hooks.tool!.hive_worktree_create.execute(
      { feature, task: FIRST_TASK, continueFrom: 'blocked', decision },
      toolContext,
    );
    const continuation = JSON.parse(continuationRaw as string) as {
      success?: boolean;
      terminal?: boolean;
      worktreePath?: string;
      workerPromptPath?: string;
      taskToolCall?: { task_id?: string; subagent_type: string; description: string; prompt: string };
    };

    expect(continuation.success).toBe(true);
    expect(continuation.terminal).toBe(false);
    expect(continuation.worktreePath).toBe(worktreePath);
    expect(continuation.taskToolCall).not.toHaveProperty('task_id');
    const prompt = fs.readFileSync(path.resolve(testRoot, continuation.workerPromptPath!), 'utf-8');
    expect(prompt).toContain('## Continuation from Blocked State');
    expect(prompt).toContain(summary);
    expect(prompt).toContain(decision);
    expect(prompt.match(new RegExp(decision, 'g'))).toHaveLength(1);
    expect(prompt).toContain('The worktree already contains the previous worker\'s progress.');
    const continuationStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as {
      workerAssignment: { attempt: number; locator: string; contentHash: string };
      workerAttempts: Array<{ attempt: number; state: string }>;
    };
    expect(continuationStatus.workerAssignment.attempt).toBe(initialStatus.workerAssignment.attempt + 1);
    expect(continuationStatus.workerAssignment.locator).toBe(continuation.workerPromptPath);
    expect(continuationStatus.workerAttempts.map(attempt => attempt.state)).toEqual(['published', 'published']);
    expect(fs.readFileSync(path.join(testRoot, initialStatus.workerAssignment.locator))).toEqual(initialAssignmentBytes);
    await hooks['tool.execute.before']?.({
      tool: 'task', sessionID: toolContext.sessionID, callID: 'blocked-continuation-child',
    }, { args: { ...continuation.taskToolCall } });
    await hooks.event?.({ event: {
      type: 'session.created',
      properties: { info: { id: 'blocked-continuation-worker', parentID: toolContext.sessionID } },
    } } as any);
    await observeNativeTaskChild(hooks, {
      parentSessionID: toolContext.sessionID,
      callID: 'blocked-continuation-child',
      childSessionID: 'blocked-continuation-worker',
      expectedAgent: continuation.taskToolCall!.subagent_type,
    });
    await hooks['chat.message']?.({ sessionID: 'blocked-continuation-worker', agent: continuation.taskToolCall!.subagent_type }, {
      message: { agent: continuation.taskToolCall!.subagent_type }, parts: [],
    } as any);
    await hooks['tool.execute.after']?.({
      tool: 'task', sessionID: toolContext.sessionID, callID: 'blocked-continuation-child', args: { ...continuation.taskToolCall },
    }, { title: 'task', output: 'done', metadata: { sessionId: 'blocked-continuation-worker' } });
    const associatedContinuation = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as {
      workerSession: { sessionId: string; attempt: number };
      workerAttempts: Array<{ state: string }>;
    };
    expect(associatedContinuation.workerSession).toMatchObject({
      sessionId: 'blocked-continuation-worker',
      attempt: continuationStatus.workerAssignment.attempt,
    });
    expect(associatedContinuation.workerAttempts.map(attempt => attempt.state)).toEqual(['published', 'associated']);

    const statusRaw = await hooks.tool!.hive_status.execute({ feature }, toolContext);
    const status = JSON.parse(statusRaw as string) as {
      tasks?: { list?: Array<{ folder: string; status: string }> };
    };
    expect(status.tasks?.list?.find((task) => task.folder === FIRST_TASK)?.status).toBe('in_progress');
    const continuedStatus = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as {
      baseCommit: string;
      aggregateBranchDiff?: unknown;
    };
    expect(continuedStatus.baseCommit).toBe(initialBaseCommit);
    expect(continuedStatus.aggregateBranchDiff).toBeUndefined();
  });

  it.each(['failed', 'partial'] as const)(
    'starts a fresh self-contained worker after a %s attempt',
    async (attemptStatus) => {
      const feature = attemptStatus === 'failed'
        ? 'attempt-recovery-one-feature'
        : 'attempt-recovery-two-feature';
      const { hooks, toolContext, worktreePath } = await createSingleTaskWorktree(
        testRoot,
        `sess_${attemptStatus}_attempt_recovery`,
        feature,
        attemptStatus === 'failed' ? 'Failed Attempt Recovery Feature' : 'Partial Attempt Recovery Feature',
        `Yes, this test validates self-contained ${attemptStatus} attempt recovery, including persisted report evidence, fresh-worker launch payloads, and unchanged task-state transitions.`,
      );
      const summary = attemptStatus === 'failed'
        ? 'Parser changes are preserved; the response assertion still fails.'
        : 'Parser changes and unit coverage are complete; the integration fixture remains.';
      fs.writeFileSync(path.join(worktreePath, `${attemptStatus}-progress.txt`), `${summary}\n`);
      const beforeHead = execSync('git rev-parse HEAD', { cwd: worktreePath, encoding: 'utf-8' }).trim();

      const terminalRaw = await hooks.tool!.hive_worktree_commit.execute(
        { feature, task: FIRST_TASK, status: attemptStatus, summary, message: TEST_COMMIT_MESSAGE },
        toolContext,
      );
      const terminal = JSON.parse(terminalRaw as string) as {
        terminal?: boolean;
        taskState?: string;
        nextAction?: string;
        commit?: { committed?: boolean; message?: string; sha?: string };
      };
      expect(terminal.terminal).toBe(true);
      expect(terminal.taskState).toBe(attemptStatus);
      expect(terminal.nextAction).toMatch(/hive_worktree_start/i);
      expect(terminal.nextAction).not.toMatch(/hive_merge/i);
      expect(terminal.commit).toMatchObject({ committed: true, message: TEST_COMMIT_MESSAGE });
      expect(execSync('git rev-parse HEAD', { cwd: worktreePath, encoding: 'utf-8' }).trim()).not.toBe(beforeHead);
      expect(readHeadBody(worktreePath)).toBe(TEST_COMMIT_MESSAGE);
      expect(execSync('git status --porcelain', { cwd: worktreePath, encoding: 'utf-8' })).toBe('');

      const retryRaw = await hooks.tool!.hive_worktree_start.execute(
        { feature, task: FIRST_TASK },
        toolContext,
      );
      const retry = JSON.parse(retryRaw as string) as {
        success?: boolean;
        terminal?: boolean;
        worktreePath?: string;
        workerPromptPath?: string;
        taskToolCall?: { task_id?: string };
      };

      expect(retry.success).toBe(true);
      expect(retry.terminal).toBe(false);
      expect(retry.worktreePath).toBe(worktreePath);
      expect(retry.taskToolCall).not.toHaveProperty('task_id');
      const prompt = fs.readFileSync(path.resolve(testRoot, retry.workerPromptPath!), 'utf-8');
      expect(prompt).toContain('## Previous Attempt');
      expect(prompt).toContain(`**Status**: ${attemptStatus}`);
      expect(prompt).toContain(`**Summary**: ${summary}`);
      expect(prompt).toContain('Full historical report');
      expect(prompt).toContain('/reports/1.md');
      expect(prompt).not.toContain(`# Task Report: ${FIRST_TASK}`);
      expect(prompt).toContain('**Remaining Assignment**: Continue the mission below');
      expect(prompt).toContain('## Your Mission');
      expect(prompt).not.toContain('**Error**: Unknown error');
      expect(prompt).not.toContain('No previous summary');

      const statusRaw = await hooks.tool!.hive_status.execute({ feature }, toolContext);
      const status = JSON.parse(statusRaw as string) as {
        tasks?: { list?: Array<{ folder: string; status: string }> };
      };
      expect(status.tasks?.list?.find((task) => task.folder === FIRST_TASK)?.status).toBe('in_progress');
    },
  );

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

  it('keeps worker prose separate from structured aggregate diff metadata across retries', async () => {
    const feature = 'commit-summary-diff-feature';
    const workerSummary = 'Implemented the requested worker behavior. Tests pass.';
    const { hooks, toolContext, worktreePath } = await createSingleTaskWorktree(
      testRoot,
      'sess_commit_summary_diff',
      feature,
      'Commit Summary Diff Feature',
      'Yes, this test validates deterministic aggregate branch diff metadata in downstream task summaries.',
    );

    fs.mkdirSync(path.join(worktreePath, 'packages', 'api'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'packages', 'api', 'note.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(worktreePath, 'root-note.txt'), 'root\n');

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: 'completed',
        summary: workerSummary,
        message: TEST_COMMIT_MESSAGE,
      },
      toolContext,
    );
    const commitResult = JSON.parse(commitRaw as string) as {
      summary: string;
      reportPath: string;
      reportReference: string;
    };
    expect(fs.readFileSync(commitResult.reportReference, 'utf8')).toContain(`\n## Summary\n\n${workerSummary}\n`);
    expect(commitResult.reportReference).not.toBe(commitResult.reportPath);
    const taskStatusPath = path.join(
      testRoot,
      '.hive',
      'features',
      '01_commit-summary-diff-feature',
      'tasks',
      FIRST_TASK,
      'status.json',
    );
    const firstStoredStatus = JSON.parse(fs.readFileSync(taskStatusPath, 'utf-8')) as {
      summary: string;
      baseCommit: string;
      aggregateBranchDiff?: {
        fileCount: number;
        insertions: number;
        deletions: number;
        areas: string[];
        report: string;
      };
    };

    expect(commitResult.summary).toBe(workerSummary);
    expect(firstStoredStatus.summary).toBe(workerSummary);
    expect(firstStoredStatus.aggregateBranchDiff).toEqual({
      fileCount: 2,
      insertions: 3,
      deletions: 0,
      areas: ['packages', 'root-note.txt'],
      report: '.hive/features/01_commit-summary-diff-feature/tasks/01-first-task/reports/1.md',
    });
    expect(firstStoredStatus.aggregateBranchDiff?.report).not.toBe(commitResult.reportPath);

    const retryWorkerSummary = [
      'Retry verified the same branch.',
      '> - "Aggregate branch diff at commit time: 2 file(s), +3/-0; areas: packages, root-note.txt; '
        + `report: ${firstStoredStatus.aggregateBranchDiff.report}"`,
      '1. **`Aggregate branch diff at commit time: 9 file(s), +8/-7; areas: prose; report: prose.md`**',
      'User prose mentions Aggregate branch diff at commit time: without matching generated metadata and must remain.',
    ].join('\n');
    await hooks.tool!.hive_task_update.execute(
      { feature, task: FIRST_TASK, status: 'failed', summary: retryWorkerSummary },
      toolContext,
    );
    const startAgainRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature, task: FIRST_TASK },
      toolContext,
    );
    const startAgain = JSON.parse(startAgainRaw as string) as {
      success: boolean;
      workerPromptPath: string;
    };
    expect(startAgain.success).toBe(true);
    const retryPrompt = fs.readFileSync(path.resolve(testRoot, startAgain.workerPromptPath), 'utf-8');
    const previousAttemptSection = retryPrompt.slice(
      retryPrompt.indexOf('## Previous Attempt'),
      retryPrompt.indexOf('---', retryPrompt.indexOf('## Previous Attempt')),
    );
    expect(previousAttemptSection).toContain('Retry verified the same branch.');
    expect(previousAttemptSection).toContain(
      'User prose mentions Aggregate branch diff at commit time: without matching generated metadata and must remain.',
    );
    expect(previousAttemptSection).toContain('2 file(s), +3/-0');
    expect(previousAttemptSection).toContain('9 file(s), +8/-7');
    const retryStoredStatus = JSON.parse(fs.readFileSync(taskStatusPath, 'utf-8')) as { baseCommit: string };
    expect(retryStoredStatus.baseCommit).toBe(firstStoredStatus.baseCommit);

    const retryCommitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: 'completed',
        summary: retryWorkerSummary,
        message: TEST_COMMIT_MESSAGE,
      },
      toolContext,
    );
    const retryCommit = JSON.parse(retryCommitRaw as string) as { summary: string };
    const finalStoredStatus = JSON.parse(fs.readFileSync(taskStatusPath, 'utf-8')) as {
      summary: string;
      baseCommit: string;
      aggregateBranchDiff?: {
        fileCount: number;
        insertions: number;
        deletions: number;
        areas: string[];
        report: string;
      };
    };
    expect(retryCommit.summary).toBe(retryWorkerSummary);
    expect(finalStoredStatus.baseCommit).toBe(firstStoredStatus.baseCommit);
    expect(finalStoredStatus.summary).toBe(retryWorkerSummary);
    expect(finalStoredStatus.aggregateBranchDiff).toEqual({
      ...firstStoredStatus.aggregateBranchDiff,
      report: '.hive/features/01_commit-summary-diff-feature/tasks/01-first-task/reports/2.md',
    });
    const history = path.join(path.dirname(taskStatusPath), 'reports');
    expect(fs.readFileSync(path.join(history, '1.md'), 'utf8')).toContain(workerSummary);
    expect(fs.readFileSync(path.join(history, '2.md'), 'utf8')).toContain(retryWorkerSummary);
    expect(fs.readFileSync(commitResult.reportPath, 'utf8')).toContain('Observed HEAD (no new commit)');
  });

  it('renders structured aggregate metadata after a budgeted long worker summary', async () => {
    const feature = 'commit-long-summary-feature';
    const longSummary = `Tests pass. ${'Detailed worker prose. '.repeat(120)}`;
    const { hooks, toolContext, worktreePath } = await createSingleTaskWorktree(
      testRoot,
      'sess_commit_long_summary',
      feature,
      'Commit Long Summary Feature',
      'Yes, this test validates structured aggregate metadata after the completed-task summary budget.',
    );
    fs.writeFileSync(path.join(worktreePath, 'long-summary-note.txt'), 'long summary\n');

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: 'completed',
        summary: longSummary,
        message: TEST_COMMIT_MESSAGE,
      },
      toolContext,
    );
    const commitResult = JSON.parse(commitRaw as string) as { summary: string };
    expect(commitResult.summary).toBe(longSummary);

    await hooks.tool!.hive_task_create.execute(
      {
        name: 'consume-long-summary',
        feature,
        dependsOn: [FIRST_TASK],
        description: 'Use the completed task context.',
        source: 'operator',
      },
      toolContext,
    );
    const downstreamRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature, task: '02-consume-long-summary' },
      toolContext,
    );
    const downstream = JSON.parse(downstreamRaw as string) as {
      success: boolean;
      workerPromptPath: string;
    };
    expect(downstream.success).toBe(true);
    const downstreamPrompt = fs.readFileSync(path.resolve(testRoot, downstream.workerPromptPath), 'utf-8');
    const completedSection = downstreamPrompt.slice(downstreamPrompt.indexOf('### Completed Task Context'));
    expect(completedSection).toContain('...[truncated]');
    expect(completedSection).toContain(
      'Aggregate branch diff at commit time: 1 file(s), +1/-0; areas: long-summary-note.txt; '
        + 'report: .hive/features/01_commit-long-summary-feature/tasks/01-first-task/reports/1.md',
    );
    expect(completedSection.indexOf('...[truncated]')).toBeLessThan(
      completedSection.indexOf('Aggregate branch diff at commit time:'),
    );
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

  it('hive_merge reports no tracked changes as a no-op instead of a successful merge', async () => {
    const feature = 'merge-no-tracked-changes-feature';
    const { hooks, toolContext } = await createSingleTaskWorktree(
      testRoot,
      'sess_merge_no_tracked_changes',
      feature,
      'Merge No Tracked Changes Feature',
      'Yes, this regression test validates that hive_merge preserves service-level no-change merge semantics in the OpenCode tool response.',
    );

    await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: 'completed',
        summary: 'Completed without tracked file changes.',
      },
      toolContext,
    );

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: FIRST_TASK, strategy: 'merge', cleanup: 'worktree' },
      toolContext,
    );
    const mergeResult = JSON.parse(mergeRaw as string) as {
      success: boolean;
      merged: boolean;
      reason?: string;
      reasonCode?: string;
      cleanupEligible?: boolean;
      taskUpdateRecommended?: boolean;
      filesChanged: string[];
      sha?: string;
      cleanup: { worktreeRemoved: boolean; branchDeleted: boolean; pruned: boolean };
      message: string;
    };

    expect(mergeResult.success).toBe(true);
    expect(mergeResult.merged).toBe(false);
    expect(mergeResult.reasonCode).toBe('NO_TRACKED_CHANGES');
    expect(mergeResult.reason).toBe('nothing_to_merge');
    expect(mergeResult.cleanupEligible).toBe(true);
    expect(mergeResult.taskUpdateRecommended).toBe(true);
    expect(mergeResult.filesChanged).toEqual([]);
    expect(mergeResult.sha).toBeUndefined();
    expect(mergeResult.cleanup.worktreeRemoved).toBe(true);
    expect(mergeResult.message).toBe(`Task "${FIRST_TASK}" had no tracked changes to merge; cleanup completed.`);
    expect(mergeResult.message).not.toContain('merged successfully');
  });

  it('hive_merge reports the no-op prose, not a successful merge, when requested cleanup did not finish', async () => {
    const feature = 'merge-noop-cleanup-failed-feature';
    const { hooks, toolContext } = await createSingleTaskWorktree(
      testRoot,
      'sess_merge_noop_cleanup_failed',
      feature,
      'Merge Noop Cleanup Failed Feature',
      'Yes, this regression test validates that a NO_TRACKED_CHANGES no-op whose requested cleanup failed does not read as a successful merge.',
    );

    await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: 'completed',
        summary: 'Completed without tracked file changes.',
      },
      toolContext,
    );

    // The service marks a no-op whose requested cleanup fell short by
    // overriding reasonCode with CLEANUP_FAILED while keeping success=true and
    // merged=false. The wrapper must still render no-op prose.
    const mergeSpy = spyOn(WorktreeService.prototype, 'merge').mockImplementation(async function (
      _feature: string,
      _step: string,
      strategy: 'merge' | 'squash' | 'rebase',
    ) {
      return {
        success: true,
        merged: false,
        strategy,
        reason: 'nothing_to_merge',
        reasonCode: 'CLEANUP_FAILED',
        cleanupEligible: true,
        taskUpdateRecommended: true,
        filesChanged: [],
        conflicts: [],
        conflictState: 'none' as const,
        cleanup: {
          requested: 'worktree' as const,
          outcome: 'failed' as const,
          worktreeRemoval: { status: 'failed' as const, error: 'simulated removal failure' },
          branchDeletion: { status: 'not_requested' as const },
          prune: { status: 'succeeded' as const },
          failures: [{ step: 'worktree-removal', cause: 'simulated removal failure' }],
          worktreeRemoved: false,
          branchDeleted: false,
          pruned: false,
        },
        phase: 'cleanup' as const,
        mutation: 'none' as const,
        retryable: false,
        action: 'cleanup_only' as const,
      };
    });
    let mergeResult: { success: boolean; merged: boolean; reasonCode?: string; action?: string; message: string };
    try {
      const mergeRaw = await hooks.tool!.hive_merge.execute(
        { feature, task: FIRST_TASK, strategy: 'merge', cleanup: 'worktree' },
        toolContext,
      );
      mergeResult = JSON.parse(mergeRaw as string);
    } finally {
      mergeSpy.mockRestore();
    }

    expect(mergeResult.success).toBe(true);
    expect(mergeResult.merged).toBe(false);
    expect(mergeResult.reasonCode).toBe('CLEANUP_FAILED');
    expect(mergeResult.action).toBe('cleanup_only');
    expect(mergeResult.message).not.toContain('merged successfully');
    expect(mergeResult.message).toContain('had no tracked changes to merge');
    expect(mergeResult.message).toContain('cleanup did not finish');
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
        message: TEST_COMMIT_MESSAGE,
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
      commitMessage?: string;
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
    expect(mergeResult.commitMessage).toBe(customMessage);
    expect(readHeadBody(testRoot)).toBe(customMessage);
  });

  it('rejects squash merge with omitted aggregate message before mutation', async () => {
    const feature = 'merge-omitted-squash-message-feature';
    const { hooks, toolContext, worktreePath } = await createSingleTaskWorktree(
      testRoot,
      'sess_merge_omitted_squash_message',
      feature,
      'Merge Omitted Squash Message Feature',
      'Yes, this test validates rejection when a squash aggregate message is omitted.',
    );

    fs.writeFileSync(path.join(worktreePath, 'task-note.txt'), 'squash without aggregate message\n');

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: 'completed',
        summary: 'Prepared omitted squash merge message test. Tests pass (bun test).',
        message: TEST_COMMIT_MESSAGE,
      },
      toolContext,
    );
    const commitResult = JSON.parse(commitRaw as string) as { ok: boolean; taskState?: string };
    expect(commitResult.ok).toBe(true);
    expect(commitResult.taskState).toBe('done');

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: FIRST_TASK, strategy: 'squash' },
      toolContext,
    );
    const mergeResult = JSON.parse(mergeRaw as string) as {
      success: boolean;
      merged: boolean;
      commitMessage?: string;
    };

    expect(mergeResult.success).toBe(false);
    expect(mergeResult.merged).toBe(false);
    expect(mergeResult.commitMessage).toBeUndefined();
  });

  it('rejects normal merge with omitted aggregate message before mutation', async () => {
    const feature = 'merge-omitted-normal-message-feature';
    const { hooks, toolContext, worktreePath } = await createSingleTaskWorktree(
      testRoot,
      'sess_merge_omitted_normal_message',
      feature,
      'Merge Omitted Normal Message Feature',
      'Yes, this test validates rejection when a normal merge aggregate message is omitted.',
    );

    fs.writeFileSync(path.join(worktreePath, 'task-note.txt'), 'normal merge without aggregate message\n');
    const sourceMessage = 'feat: normal source narrative\n\nNormal merge body from task branch.';
    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature,
        task: FIRST_TASK,
        status: 'completed',
        summary: 'Prepared omitted normal merge message test. Tests pass (bun test).',
        message: sourceMessage,
      },
      toolContext,
    );
    const commitResult = JSON.parse(commitRaw as string) as { ok: boolean; taskState?: string };
    expect(commitResult.ok).toBe(true);
    expect(commitResult.taskState).toBe('done');

    const mergeRaw = await hooks.tool!.hive_merge.execute(
      { feature, task: FIRST_TASK, strategy: 'merge' },
      toolContext,
    );
    const mergeResult = JSON.parse(mergeRaw as string) as {
      success: boolean;
      merged: boolean;
      commitMessage?: string;
    };

    expect(mergeResult.success).toBe(false);
    expect(mergeResult.merged).toBe(false);
    expect(mergeResult.commitMessage).toBeUndefined();
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
        message: TEST_COMMIT_MESSAGE,
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

    expect(mergeResult).toMatchObject({
      success: false,
      merged: false,
      strategy: 'rebase',
      filesChanged: [],
      conflicts: [],
      conflictState: 'none',
      reasonCode: 'MESSAGE_NOT_ALLOWED_FOR_REBASE',
      phase: 'validation',
      mutation: 'none',
      retryable: false,
      action: 'correct_arguments',
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

  it("hive_worktree_commit does not fabricate worker provenance", async () => {
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
    expect(workerSession).toBeUndefined();
  });

  it("launches manual tasks with fresh ranked context and completed summaries without rewriting spec.md", async () => {
    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: createProject(testRoot),
      client: ROOT_SESSION_CLIENT,
      $: createStubShell(),
    };

    const hooks = await plugin(ctx);
    const toolContext = createToolContext("sess_manual_spec_preservation");
    await hooks['chat.message']?.({ sessionID: toolContext.sessionID, agent: toolContext.agent }, {
      message: { agent: toolContext.agent }, parts: [],
    } as any);

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
    await hooks.tool!.hive_task_update.execute(
      {
        feature: 'manual-spec-feature',
        task: FIRST_TASK,
        status: 'done',
        summary: 'First task completed for downstream manual work.',
      },
      toolContext,
    );

    await hooks.tool!.hive_task_create.execute(
      {
        name: "review-fix",
        feature: "manual-spec-feature",
        dependsOn: [FIRST_TASK],
        description: "Fix routing issue found in review",
        goal: "Correct agent routing for swarm dispatch",
        acceptanceCriteria: ["swarm dispatches to correct agent", "existing tests pass"],
        references: ["packages/opencode-hive/src/agents/swarm.ts:107-111"],
        files: ["packages/opencode-hive/src/agents/swarm.ts"],
        reason: "Required by code review",
        source: "operator",
      },
      toolContext
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: 'manual-spec-feature',
        name: 'manual-task-context',
        content: durableContext('Context owned by the manual task.'),
        task: '02-review-fix',
      },
      toolContext,
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: 'manual-spec-feature',
        name: 'dependency-context',
        content: durableContext('Context owned by the completed dependency.'),
        task: FIRST_TASK,
      },
      toolContext,
    );
    await hooks.tool!.hive_context_write.execute(
      {
        feature: 'manual-spec-feature',
        name: 'untagged-context',
        content: durableContext('Fresh untagged context.'),
      },
      toolContext,
    );

    const featurePath = path.join(testRoot, '.hive', 'features', '01_manual-spec-feature');
    const contextIndexPath = path.join(featurePath, 'context', 'index.json');
    const contextIndex = JSON.parse(fs.readFileSync(contextIndexPath, 'utf-8'));
    contextIndex.entries['manual-task-context'].updatedAt = '2026-09-01T00:00:00.000Z';
    contextIndex.entries['dependency-context'].updatedAt = '2026-09-02T00:00:00.000Z';
    contextIndex.entries['untagged-context'].updatedAt = '2026-09-03T00:00:00.000Z';
    fs.writeFileSync(contextIndexPath, JSON.stringify(contextIndex, null, 2));
    const firstStatusPath = path.join(featurePath, 'tasks', FIRST_TASK, 'status.json');
    const firstStatus = JSON.parse(fs.readFileSync(firstStatusPath, 'utf-8'));
    firstStatus.completedAt = '2026-09-02T12:00:00.000Z';
    fs.writeFileSync(firstStatusPath, JSON.stringify(firstStatus, null, 2));

    const specPathBefore = path.join(
      testRoot,
      ".hive",
      "features",
      "01_manual-spec-feature",
      "tasks",
      "02-review-fix",
      "spec.md"
    );
    const generatedSpec = fs.readFileSync(specPathBefore, 'utf-8');
    const specBefore = [
      generatedSpec,
      '',
      '## Context',
      '',
      'Manual mission context that must retain its own meaning.',
      '',
      '## Completed Tasks',
      '',
      '- Manual checklist item, not runtime history.',
      '',
    ].join('\n');
    fs.writeFileSync(specPathBefore, specBefore);
    expect(specBefore).toContain('Correct agent routing for swarm dispatch');
    expect(specBefore).toContain('Fix routing issue found in review');

    const raw = await hooks.tool!.hive_worktree_start.execute(
      { feature: "manual-spec-feature", task: "02-review-fix" },
      toolContext
    );

    const result = JSON.parse(raw as string) as {
      success?: boolean;
      worktreePath?: string;
      workerPromptPath?: string;
    };
    expect(result.success).toBe(true);
    expect(result.worktreePath).toBeDefined();

    const specAfter = fs.readFileSync(specPathBefore, "utf-8");
    expect(specAfter).toBe(specBefore);

    const workerPrompt = fs.readFileSync(
      path.join(testRoot, result.workerPromptPath!),
      'utf-8',
    );
    expect(workerPrompt).toContain("Correct agent routing for swarm dispatch");
    expect(workerPrompt).not.toContain('Context owned by the manual task.');
    expect(workerPrompt).not.toContain('Context owned by the completed dependency.');
    expect(workerPrompt).not.toContain('Fresh untagged context.');
    expect(workerPrompt).toContain('- 01-first-task: First task completed for downstream manual work.');
    expect(workerPrompt).toContain('Manual mission context that must retain its own meaning.');
    expect(workerPrompt).toContain('- Manual checklist item, not runtime history.');
    expect(workerPrompt.match(/## Context/g)).toHaveLength(1);
    expect(workerPrompt.match(/## Completed Tasks/g)).toHaveLength(1);
    expect(workerPrompt.match(/## Runtime-Injected Launch Supplement/g)).toHaveLength(1);
    expect(workerPrompt).not.toContain('### Current Context');
    expect(workerPrompt.match(/### Completed Task Context/g)).toHaveLength(1);

    const repeatedRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature: 'manual-spec-feature', task: '02-review-fix' },
      toolContext,
    );
    const repeated = JSON.parse(repeatedRaw as string) as { success: boolean; workerPromptPath: string };
    expect(repeated.success).toBe(true);
    expect(fs.readFileSync(specPathBefore, 'utf-8')).toBe(specBefore);
    const repeatedPrompt = fs.readFileSync(
      path.join(testRoot, repeated.workerPromptPath),
      'utf-8',
    );
    expect(repeated.workerPromptPath).not.toBe(result.workerPromptPath);
    expect(fs.readFileSync(path.join(testRoot, result.workerPromptPath!), 'utf8')).toBe(workerPrompt);
    expect(repeatedPrompt.match(/## Runtime-Injected Launch Supplement/g)).toHaveLength(1);
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
        message: TEST_COMMIT_MESSAGE,
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
        mergeEligibility: Array<{
          task: string;
          eligible: boolean;
          reasonCode: string;
          recommendedCommand?: string;
        }>;
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
      mergeEligibility: [
        {
          task: "01-first-task",
          eligible: true,
          reasonCode: "TASK_DONE_WITH_LIVE_WORKTREE",
          recommendedCommand: 'hive_merge({ task: "01-first-task" })',
        },
        {
          task: "02-second-task",
          eligible: false,
          reasonCode: "TASK_NOT_DONE",
        },
        {
          task: "03-third-task",
          eligible: false,
          reasonCode: "TASK_NOT_DONE",
        },
        {
          task: "04-operator-followup",
          eligible: false,
          reasonCode: "TASK_NOT_DONE",
        },
      ],
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
        message: TEST_COMMIT_MESSAGE,
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
    expect(status.helperStatus).toEqual({
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

  it("worker chat.message cannot infer assignment provenance from worktree and agent", async () => {
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
    expect(workerSession.featureName).toBeUndefined();
    expect(workerSession.taskFolder).toBeUndefined();
    expect(workerSession.workerAssignment).toBeUndefined();
  });

  it('declares only the runtime hooks needed by the plugin', () => {
    expect([...SUPPORTED_PLUGIN_HOOKS]).toEqual([
      'event',
      'config',
      'chat.message',
      'experimental.chat.system.transform',
      'experimental.chat.messages.transform',
      'command.execute.before',
      'tool.definition',
      'tool.execute.before',
      'tool.execute.after',
    ]);
  });

  it('extends the native task definition without replacing existing fields', async () => {
    const { hooks } = await createHooksForTest(testRoot, 'task-definition-extension');
    const prompt = Schema.String;
    const output = { parameters: Schema.Struct({ prompt }) };
    await hooks['tool.definition']?.({ toolID: 'task' } as any, output as any);
    expect((output.parameters as any).fields.prompt).toBe(prompt);
    expect((output.parameters as any).fields.hive_launch_id).toBeDefined();

    const ordinary = { parameters: Schema.Struct({ value: Schema.String }) };
    const before = ordinary.parameters;
    await hooks['tool.definition']?.({ toolID: 'read' } as any, ordinary as any);
    expect(ordinary.parameters).toBe(before);
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
      hooks.tool!.hive_worktree_start.execute({ feature, task: FIRST_TASK }, toolContext),
    ).rejects.toThrow(/Repository manifest is required/);

    // No worktree directory created under either the legacy or composite path.
    const worktreeRoot = path.join(testRoot, '.hive', '.worktrees', feature, FIRST_TASK);
    expect(fs.existsSync(worktreeRoot)).toBe(false);
  });
});
