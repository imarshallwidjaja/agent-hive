import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Effect, Exit, Scope, Stream } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import { Tool } from '@opencode/schema/tool';
import plugin from '../index.js';
import { SUBAGENT_CLARIFICATION_PROMPT } from '../hooks/system-hook.js';
import { HIVE_COMMANDS } from '../commands/registry.js';
import { CODEMODE_READ_TOOLS } from '../runtime/host-profile.js';
import { createHiveOperations } from '../runtime/hive-tools.js';
import { HIVE_TOOL_NAMES } from '../utils/plugin-manifest.js';
import { createHiveAuthority, toModelRef } from './registration.js';
import { codemodeFlag, standardSchema, toToolInfo } from './tools.js';
import { z } from '../runtime/schema.js';

// Registration owns the v2 catalog contract: Code Mode flags, validators and structured results, the execution
// guards, request-time instructions and the native-precedence split. These tests drive the real activation through a
// fake host that applies transforms in the host's order (Hive first, then the user's agent configuration).

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type AgentInfo = {
  id: string; name: string; model?: { id: string; providerID: string; variant?: string };
  request: { settings: Record<string, unknown>; headers: Record<string, string>; body: Record<string, unknown> };
  system?: string; description?: string; mode: string; hidden: boolean; steps?: number;
  permissions: Array<{ action: string; resource: string; effect: string }>;
};
type Session = { id: string; parentID?: string; agent?: string };

function defaultAgent(id: string): AgentInfo {
  return { id, name: id, request: { settings: {}, headers: {}, body: {} }, mode: 'primary', hidden: false, permissions: [{ action: '*', resource: '*', effect: 'allow' }] };
}

/** A user's agent configuration applied the way the host's config-agent plugin does: after plugin transforms. */
type UserAgentConfig = { default_agent?: string; agents?: Record<string, Partial<Pick<AgentInfo, 'system' | 'description' | 'mode' | 'hidden' | 'model' | 'steps'>> & { permissions?: AgentInfo['permissions']; disabled?: boolean }>; permissions?: AgentInfo['permissions'] };

type UserSkill = { id: string; name: string; description: string; path: string; content: string };

/**
 * `directory` is where the session is opened; `projectDirectory` is the checkout the host resolved for it (the
 * location's `project.directory`), which differs when a session is opened in a subdirectory or a task worktree.
 */
function createFakeHost(directory: string, options: Record<string, unknown> = {}, projectDirectory = directory) {
  const transforms = { agent: [] as Array<(editor: any) => void>, skill: [] as Array<(editor: any) => void>, command: [] as Array<(editor: any) => void>, tool: [] as Array<(editor: any) => void> };
  const hooks = { before: [] as Array<(event: any) => Effect.Effect<void, any>>, context: [] as Array<(event: any) => Effect.Effect<void, any>>, compaction: [] as Array<(event: any) => Effect.Effect<void, any>>, generate: [] as Array<(event: any) => Effect.Effect<void, any>> };
  const sessions = new Map<string, Session>();
  const prompts: any[] = [];
  const switches: any[] = [];
  const modelSwitches: any[] = [];
  const registration = { dispose: Effect.void };
  const sessionGets: string[] = [];
  let userConfig: UserAgentConfig = {};
  const userSkills: UserSkill[] = [];
  const context = {
    location: { directory, project: { id: 'project', directory: projectDirectory, canonical: projectDirectory } },
    options,
    rpc: { register: () => Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } }) },
    event: { subscribe: () => Stream.empty },
    agent: {
      transform: (cb: any) => Effect.sync(() => { transforms.agent.push(cb); return registration; }),
      list: () => Effect.sync(() => ({ data: [...agents(userConfig).registry.values()] })),
    },
    skill: {
      transform: (cb: any) => Effect.sync(() => { transforms.skill.push(cb); return registration; }),
      list: () => Effect.sync(() => ({ data: [...skills().values()] })),
    },
    command: { transform: (cb: any) => Effect.sync(() => { transforms.command.push(cb); return registration; }) },
    tool: {
      transform: (cb: any) => Effect.sync(() => { transforms.tool.push(cb); return registration; }),
      hook: (name: string, cb: any) => Effect.sync(() => { if (name === 'execute.before') hooks.before.push(cb); return registration; }),
    },
    session: {
      hook: (name: string, cb: any) => Effect.sync(() => { if (name === 'context' || name === 'compaction' || name === 'generate') hooks[name].push(cb); return registration; }),
      get: ({ sessionID }: { sessionID: string }) => Effect.suspend(() => {
        sessionGets.push(sessionID);
        const session = sessions.get(sessionID);
        return session ? Effect.succeed(session) : Effect.fail(new Error(`unknown session ${sessionID}`));
      }),
      switchAgent: (input: any) => Effect.sync(() => { switches.push(input); }),
      switchModel: (input: any) => Effect.sync(() => { modelSwitches.push(input); }),
      prompt: (input: any) => Effect.sync(() => { prompts.push(input); return {}; }),
    },
  } as unknown as Plugin.Context;

  /** The agent registry after Hive's transform and then the user's configuration, as the host builds it. */
  function agents(user: UserAgentConfig = userConfig) {
    const registry = new Map<string, AgentInfo>(['build', 'general', 'explore'].map((id) => [id, defaultAgent(id)]));
    let selected: string | undefined;
    const editor = {
      list: () => [...registry.values()],
      get: (id: string) => registry.get(id),
      default: (id: string | undefined) => { selected = id; },
      update: (id: string, fn: (agent: AgentInfo) => void) => { const agent = registry.get(id) ?? defaultAgent(id); registry.set(id, agent); fn(agent); },
      remove: (id: string) => registry.delete(id),
    };
    for (const cb of transforms.agent) cb(editor);
    if (user.default_agent) selected = user.default_agent;
    for (const agent of registry.values()) agent.permissions.push(...(user.permissions ?? []));
    for (const [id, item] of Object.entries(user.agents ?? {})) {
      if (item.disabled) {
        editor.remove(id);
        continue;
      }
      editor.update(id, (agent) => {
        const { permissions, disabled: _disabled, ...rest } = item;
        Object.assign(agent, rest);
        if (permissions) agent.permissions.push(...permissions);
      });
    }
    return { registry, selected };
  }
  const tools = () => {
    const registry = new Map<string, any>();
    // `update` ignores missing tools, as the host's editor does; the native subagent tool is not registered here.
    for (const cb of transforms.tool) cb({
      add: (info: any) => {
        expect(registry.has(info.name)).toBe(false);
        registry.set(info.name, info);
      },
      update: (id: string, fn: (info: any) => void) => { if (registry.has(id)) fn(registry.get(id)); },
    });
    return registry;
  };
  /** The skill catalog after Hive's transform and then the user's configured sources, as the host builds it. */
  function skills() {
    const registry = new Map<string, any>();
    for (const cb of transforms.skill) cb({ add: (info: any) => registry.set(info.id, info) });
    for (const skill of userSkills) registry.set(skill.id, skill);
    return registry;
  }
  const commands = () => {
    const registry = new Map<string, any>();
    for (const cb of transforms.command) cb({ add: (info: any) => registry.set(info.name, info) });
    return registry;
  };
  /** Runs every execute.before hook, as the host does for direct and Code Mode inner calls. */
  const before = (event: { tool: string; sessionID: string; agent: string; input?: unknown }) =>
    Effect.runPromiseExit(Effect.forEach(hooks.before, (hook) => hook({ messageID: 'm', id: 'c', input: {}, ...event }), { discard: true }));
  /** Runs the hooks for one model request (ordinary turn by default) and returns the resulting draft. */
  const requestDraft = async (event: { sessionID: string; agent: string; system: string[]; tools?: string[]; options?: Record<string, unknown>; kind?: 'context' | 'compaction' | 'generate' }) => {
    const draft = { sessionID: event.sessionID, agent: event.agent, system: event.system.map((text) => ({ type: 'text', text })), tools: Object.fromEntries((event.tools ?? ['execute', 'read']).map((name) => [name, { description: '', input: {} }])), messages: [], options: { ...event.options } };
    for (const hook of hooks[event.kind ?? 'context']) await Effect.runPromise(hook(draft));
    return draft;
  };
  const request = async (event: Parameters<typeof requestDraft>[0]) =>
    (await requestDraft(event)).system.map((part: { text: string }) => part.text);
  /** Executes a registered Hive tool through its own executor. */
  const execute = async (name: string, args: unknown, caller: { sessionID: string; agent: string }) => {
    const info = tools().get(name);
    return Effect.runPromiseExit(info.execute(args, { ...caller, messageID: 'm', id: 'c', progress: () => Effect.void }));
  };
  return {
    context, sessions, prompts, switches, modelSwitches, sessionGets, agents, tools, skills, commands, before, request, requestDraft, execute,
    /** What `context.agent.list()` reports from now on: Hive's defaults with this user configuration applied. */
    useAgentConfig: (config: UserAgentConfig) => { userConfig = config; },
    /** Adds a skill from a user-configured source; the host applies it after plugin transforms, so it wins on id. */
    addUserSkill: (skill: UserSkill) => { userSkills.push(skill); },
  };
}

function createProject() {
  const root = fs.realpathSync(fs.mkdtempSync(`/tmp/hive-v2-registration-${process.pid}-`));
  const home = fs.mkdtempSync(`/tmp/hive-v2-registration-home-${process.pid}-`);
  cleanup.push(root, home);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return { root, home };
}

async function activate(options: Record<string, unknown> = {}, hiveConfig?: Record<string, unknown>, placement: { directory?: string; projectDirectory?: string; seed?: (root: string) => void } = {}) {
  const { root, home } = createProject();
  placement.seed?.(root);
  if (hiveConfig) {
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'agent_hive.json'), JSON.stringify(hiveConfig));
  }
  const directory = placement.directory ? path.join(root, placement.directory) : root;
  fs.mkdirSync(directory, { recursive: true });
  const projectDirectory = placement.projectDirectory ? path.join(root, placement.projectDirectory) : root;
  fs.mkdirSync(projectDirectory, { recursive: true });
  const host = createFakeHost(directory, options, projectDirectory);
  const saved = { HOME: process.env.HOME, OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.OPENCODE_CONFIG_DIR = path.join(home, '.config', 'opencode');
  delete process.env.XDG_CONFIG_HOME;
  try {
    const scope = Effect.runSync(Scope.make());
    await Effect.runPromise(plugin.effect(host.context).pipe(Scope.provide(scope)));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  host.sessions.set('primary', { id: 'primary' });
  host.sessions.set('child', { id: 'child', parentID: 'primary' });
  return { ...host, root, home };
}

function denied(exit: Exit.Exit<unknown, unknown>): string | undefined {
  if (Exit.isSuccess(exit)) return undefined;
  const error = exit.cause.reasons.find((reason: any) => reason._tag === 'Fail') as any;
  return error?.error?.message ?? 'defect';
}

describe('v2 tool registration', () => {
  it('registers all 41 Hive tools once, with an explicit Code Mode flag from the selected transport', async () => {
    expect(HIVE_TOOL_NAMES).toHaveLength(41);
    for (const transport of ['codemode', 'direct'] as const) {
      const host = await activate({ readTransport: transport });
      const tools = host.tools();
      expect([...tools.keys()].sort()).toEqual([...HIVE_TOOL_NAMES].sort());
      for (const [name, info] of tools) {
        expect(typeof info.options.codemode).toBe('boolean');
        expect(info.options.codemode).toBe(transport === 'codemode' && (CODEMODE_READ_TOOLS as readonly string[]).includes(name));
      }
    }
    expect(CODEMODE_READ_TOOLS.map((name) => codemodeFlag(name, 'codemode'))).toEqual([true, true, true]);
    expect(HIVE_TOOL_NAMES.filter((name) => codemodeFlag(name, 'codemode')).sort()).toEqual([...CODEMODE_READ_TOOLS].sort());
    expect(HIVE_TOOL_NAMES.some((name) => codemodeFlag(name, 'direct'))).toBe(false);
  });

  it('validates input with the operation schema and exports its JSON Schema through Standard Schema', async () => {
    const schema = standardSchema(z.object({ task: z.string(), limit: z.number().optional() }));
    expect(await schema['~standard'].validate({ task: 'a', extra: true })).toEqual({ value: { task: 'a' } });
    const invalid = await schema['~standard'].validate({ limit: 'x' }) as { issues: unknown[] };
    expect(invalid.issues.length).toBe(2);
    expect(schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toMatchObject({ type: 'object', properties: { task: { type: 'string' } }, required: ['task'] });

    const host = await activate();
    const info = host.tools().get('hive_task_update');
    const rejected = await info.input['~standard'].validate({ status: 'done' });
    expect(rejected.issues?.[0]?.path).toEqual(['task']);
    expect(info.output['~standard'].vendor).toBe('zod');
    expect(await info.output['~standard'].validate({ a: [1, null] })).toEqual({ value: { a: [1, null] } });
    expect((await info.output['~standard'].validate({ a: undefined })).issues).toBeDefined();
    expect(host.tools().get('hive_task_create').output).toBeUndefined();
  });

  it('delivers each ordinary operation description and field descriptions unchanged through the JSON Schema export', async () => {
    const operations = createHiveOperations({} as any);
    const tools = (await activate()).tools();
    for (const [name, operation] of Object.entries(operations)) {
      const info = tools.get(name);
      expect(info.description, name).toBe(operation.description);
      expect(info.input['~standard'].jsonSchema.input({ target: 'draft-2020-12' }), name)
        .toEqual(z.toJSONSchema(z.object(operation.args), { io: 'input', target: 'draft-2020-12' }));
    }
    const merge = tools.get('hive_worktree_merge').input['~standard'].jsonSchema.input({ target: 'draft-2020-12' }) as any;
    expect(merge.properties.expectedTarget.description).toBe((operations.hive_worktree_merge!.args.expectedTarget as any).description);
    expect(merge.properties.expectedTarget.description).toContain('Exactly one of expectedTarget and expectedTargets');
    expect(merge.required).toEqual(['task', 'historyIntent']);
    expect(merge.properties.historyIntent.enum).toEqual(['preserve-source', 'rewrite-private']);
  });

  it('returns the structured domain result with its v1 JSON text, and plain text for text operations', async () => {
    const host = await activate();
    const exit = await host.execute('hive_repositories_status', {}, { sessionID: 'primary', agent: 'hive-master' });
    expect(Exit.isSuccess(exit)).toBe(true);
    const result = (exit as Exit.Success<any>).value;
    expect(result.output).toMatchObject({ mode: 'legacy-root' });
    expect(JSON.parse(result.content)).toEqual(result.output);

    const operations = createHiveOperations({} as any);
    const text = toToolInfo('hive_task_create', { ...operations.hive_task_create, execute: () => 'created 01-x' }, 'codemode', () => Effect.void);
    const created = await Effect.runPromise(text.execute({ name: 'x' }, { sessionID: 's', agent: 'a' } as any));
    expect(created).toEqual({ content: 'created 01-x' });
  });

  it('runs the guard before the operation and reports operation failures as tool errors', async () => {
    let ran = false;
    const operation = { description: 'd', args: {}, output: 'json' as const, execute: () => { ran = true; return {}; } };
    const deny = toToolInfo('hive_status', operation, 'direct', () => Effect.fail(new Tool.Error({ message: 'no' })));
    const exit = await Effect.runPromiseExit(deny.execute({}, { sessionID: 's', agent: 'a' } as any));
    expect(denied(exit)).toBe('no');
    expect(ran).toBe(false);
    const failing = toToolInfo('hive_status', { ...operation, execute: () => { throw new Error('boom'); } }, 'direct', () => Effect.void);
    expect(denied(await Effect.runPromiseExit(failing.execute({}, { sessionID: 's', agent: 'a' } as any)))).toBe('boom');
  });

  it('keeps the admitted Code Mode reads and their guard free of Hive store writes and session reads', async () => {
    const host = await activate();
    const tree = (dir: string): string[] => fs.existsSync(dir)
      ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).map((entry) => {
        const full = path.join(entry.parentPath, entry.name);
        return `${path.relative(dir, full)}:${fs.statSync(full).mtimeMs}`;
      }).sort()
      : [];
    const gitIndex = () => fs.statSync(path.join(host.root, '.git', 'index')).mtimeMs;
    const beforeHive = tree(path.join(host.root, '.hive'));
    const beforeIndex = gitIndex();
    for (const agent of ['scout-researcher', 'forager-worker', 'hive-master']) {
      for (const name of ['hive_repositories_status', 'hive_git_snapshot']) {
        expect(denied(await host.before({ tool: name, sessionID: 'child', agent }))).toBeUndefined();
        const exit = await host.execute(name, {}, { sessionID: 'child', agent });
        expect(Exit.isSuccess(exit)).toBe(true);
      }
    }
    expect(tree(path.join(host.root, '.hive'))).toEqual(beforeHive);
    expect(gitIndex()).toBe(beforeIndex);
    // Neither read is primary-only, so the guard needs no session lookup for them.
    expect(host.sessionGets).toEqual([]);
  });
});

describe('v2 project placement', () => {
  const seedManifest = (root: string) => {
    fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
    fs.writeFileSync(path.join(root, '.hive', 'repositories.json'), JSON.stringify({ schemaVersion: 1, repositories: [{ id: 'root', path: '.' }] }));
  };
  const primary = { sessionID: 'primary', agent: 'hive-master' };

  it('shares the checkout state of a session opened in a subdirectory instead of starting a nested one', async () => {
    const host = await activate({}, undefined, { directory: 'packages/app', seed: seedManifest });
    const status = await host.execute('hive_repositories_status', {}, primary);
    expect((status as Exit.Success<any>).value.output).toMatchObject({ mode: 'manifest', repositories: [{ id: 'root' }] });
    expect(Exit.isSuccess(await host.execute('hive_feature_create', { name: 'shared' }, primary))).toBe(true);
    expect(fs.readdirSync(path.join(host.root, '.hive', 'features'))).toHaveLength(1);
    expect(fs.existsSync(path.join(host.root, 'packages', 'app', '.hive'))).toBe(false);
  });

  it('maps a session in a Hive task worktree back to the main checkout and its feature', async () => {
    const worktree = path.join('.hive', '.worktrees', 'demo', '01-task');
    const host = await activate({}, undefined, { directory: path.join(worktree, 'pkg'), projectDirectory: worktree, seed: seedManifest });
    expect(Exit.isSuccess(await host.execute('hive_feature_create', { name: 'demo' }, primary))).toBe(true);
    expect(fs.readdirSync(path.join(host.root, '.hive', 'features'))).toHaveLength(1);
    expect(fs.existsSync(path.join(host.root, '.hive', '.worktrees', 'demo', '01-task', '.hive'))).toBe(false);
    const status = await host.execute('hive_status', {}, primary);
    expect((status as Exit.Success<any>).value.output).toMatchObject({ feature: { name: 'demo' } });
  });
});

describe('v2 execution guards', () => {
  const cases: Array<[string, string, string, unknown, boolean]> = [
    // [agent, session, tool, input, allowed]
    ['architect-planner', 'child', 'hive_plan_read', {}, true],
    ['architect-planner', 'child', 'hive_plan_write', {}, true],
    ['architect-planner', 'child', 'hive_repositories_status', {}, true],
    ['architect-planner', 'child', 'hive_plan_approve', {}, false],
    ['architect-planner', 'child', 'hive_feature_select', {}, false],
    ['architect-planner', 'primary', 'hive_plan_approve', {}, true],
    ['architect-planner', 'child', 'subagent', { agent: 'scout-researcher' }, true],
    ['architect-planner', 'child', 'subagent', { agent: 'hive-helper' }, true],
    ['architect-planner', 'child', 'subagent', { agent: 'forager-worker' }, false],
    ['architect-planner', 'child', 'subagent', { agent: 'architect-planner' }, false],
    ['architect-planner', 'child', 'question', {}, false],
    ['forager-worker', 'child', 'hive_task_update', {}, true],
    ['forager-worker', 'child', 'hive_worktree_merge', {}, false],
    ['forager-worker', 'child', 'subagent', { agent: 'scout-researcher' }, false],
    ['scout-researcher', 'child', 'edit', {}, false],
    ['scout-researcher', 'child', 'write', {}, false],
    ['scout-researcher', 'child', 'read', {}, true],
    ['scout-researcher', 'child', 'hive_plan_write', {}, false],
    ['hive-helper', 'child', 'hive_task_trace_content', {}, true],
    ['swarm-orchestrator', 'primary', 'hive_worktree_merge', {}, true],
    ['swarm-orchestrator', 'primary', 'subagent', { agent: 'forager-worker' }, true],
    ['swarm-orchestrator', 'primary', 'subagent', { agent: 'hive-builder' }, false],
    ['swarm-orchestrator', 'primary', 'subagent', { agent: 'architect-planner' }, true],
    ['hive-master', 'primary', 'subagent', { agent: 'swarm-orchestrator' }, false],
    ['build', 'primary', 'subagent', { agent: 'hive-master' }, false],
    ['build', 'primary', 'subagent', { agent: 'swarm-orchestrator' }, false],
    ['build', 'primary', 'subagent', { agent: 'hive-builder' }, false],
    ['build', 'primary', 'subagent', { agent: 'architect-planner' }, true],
    ['build', 'primary', 'subagent', { agent: 'scout-researcher' }, true],
    ['security-scout', 'child', 'subagent', { agent: 'hive-master' }, false],
    ['swarm-orchestrator', 'primary', 'opencode_worktree_create', {}, false],
    ['swarm-orchestrator', 'primary', 'opencode_session_move', {}, false],
    ['swarm-orchestrator', 'primary', 'opencode_worktree_remove', {}, false],
    ['swarm-orchestrator', 'primary', 'opencode_session_rename', {}, true],
    ['general', 'child', 'hive_status', {}, false],
    ['general', 'child', 'subagent', { agent: 'explore' }, false],
    ['general', 'child', 'edit', {}, true],
    ['explore', 'child', 'hive_context_read', {}, false],
    ['explore', 'child', 'edit', {}, false],
    ['explore', 'child', 'question', {}, false],
    ['build', 'primary', 'hive_worktree_merge', {}, true],
    ['build', 'primary', 'question', {}, true],
    ['build', 'primary', 'opencode_worktree_create', {}, true],
    ['build', 'child', 'hive_worktree_merge', {}, false],
    ['build', 'child', 'question', {}, false],
    ['build', 'child', 'hive_status', {}, true],
    ['security-scout', 'child', 'hive_status', {}, true],
    ['security-scout', 'child', 'hive_plan_write', {}, false],
    ['security-scout', 'child', 'edit', {}, false],
    // Bounded context edits follow write/append authority.
    ['architect-planner', 'child', 'hive_context_edit', {}, true],
    ['forager-worker', 'child', 'hive_context_edit', {}, true],
    ['code-reviewer', 'child', 'hive_context_edit', {}, true],
    ['scout-researcher', 'child', 'hive_context_edit', {}, false],
    ['hive-helper', 'child', 'hive_context_edit', {}, false],
    ['general', 'child', 'hive_context_edit', {}, false],
    ['security-scout', 'child', 'hive_context_edit', {}, false],
    // Worklog: every Hive role reads; only primary sessions of recording roles write.
    ['forager-worker', 'child', 'hive_worklog_read', {}, true],
    ['scout-researcher', 'child', 'hive_worklog_list', {}, true],
    ['hive-helper', 'child', 'hive_worklog_read', {}, true],
    ['code-reviewer', 'child', 'hive_worklog_read', {}, true],
    ['general', 'child', 'hive_worklog_read', {}, false],
    ['explore', 'child', 'hive_worklog_list', {}, false],
    ['hive-builder', 'primary', 'hive_worklog_record', {}, true],
    ['architect-planner', 'primary', 'hive_worklog_record', {}, true],
    ['dash-reviewer', 'primary', 'hive_worklog_record', {}, true],
    ['architect-planner', 'child', 'hive_worklog_record', {}, false],
    ['forager-worker', 'child', 'hive_worklog_record', {}, false],
    ['code-reviewer', 'child', 'hive_worklog_record', {}, false],
    ['hive-helper', 'child', 'hive_worklog_record', {}, false],
    ['general', 'child', 'hive_worklog_record', {}, false],
    ['build', 'child', 'hive_worklog_record', {}, false],
  ];

  it.each(cases)('%s in a %s session calling %s', async (agent, sessionID, tool, input, allowed) => {
    const host = await activate({}, { customAgents: { 'security-scout': { baseAgent: 'scout-researcher', description: 'Primary orchestrator with full authority' } } });
    const hook = denied(await host.before({ tool, sessionID, agent, input }));
    expect(hook === undefined).toBe(allowed);
    if (tool.startsWith('hive_') && host.tools().has(tool)) {
      const exit = await host.execute(tool, {}, { sessionID, agent });
      const executorDenied = denied(exit);
      if (!allowed) expect(executorDenied).toBe(hook);
    }
  });

  it('lets both review primaries dispatch Investigators and their derivatives but not implementation Foragers, under a user global allow', async () => {
    const host = await activate({}, { customAgents: {
      'ui-investigator': { baseAgent: 'forager-investigator', description: 'Browser-visible UI exercises.' },
      'ui-forager': { baseAgent: 'forager-worker', description: 'Browser-visible UI implementation.' },
    } });
    host.useAgentConfig({ permissions: [{ action: '*', resource: '*', effect: 'allow' }] });
    const allowedTargets = ['forager-investigator', 'ui-investigator', 'scout-researcher', 'code-reviewer', 'hive-helper'];
    const deniedTargets = ['forager-worker', 'ui-forager', 'hive-master', 'swarm-orchestrator', 'hive-builder', 'architect-planner', 'unknown-agent'];
    for (const agent of ['dash-reviewer', 'vulnerability-review-primary']) {
      for (const target of allowedTargets) expect(denied(await host.before({ tool: 'subagent', sessionID: 'primary', agent, input: { agent: target } })), `${agent} -> ${target}`).toBeUndefined();
      for (const target of deniedTargets) expect(denied(await host.before({ tool: 'subagent', sessionID: 'primary', agent, input: { agent: target } })), `${agent} -> ${target}`).toBeDefined();
      // The review primary stays a source-preserving reviewer: it cannot edit, merge, or bypass Hive worktrees.
      for (const tool of ['edit', 'write', 'patch', 'hive_worktree_merge', 'hive_adhoc_worktree_merge', 'opencode_worktree_create']) {
        expect(denied(await host.before({ tool, sessionID: 'primary', agent, input: {} })), `${agent} ${tool}`).toBeDefined();
      }
      const rules = host.agents().registry.get(agent)!.permissions.filter((rule) => rule.action === 'subagent');
      expect(rules).toContainEqual({ action: 'subagent', resource: 'forager-investigator', effect: 'allow' });
      expect(rules).toContainEqual({ action: 'subagent', resource: 'ui-investigator', effect: 'allow' });
      expect(rules).not.toContainEqual({ action: 'subagent', resource: 'forager-worker', effect: 'allow' });
      expect(rules).toContainEqual({ action: 'subagent', resource: '*', effect: 'deny' });
      // The same catalog gives the primary the method and the derivative's routing card, here with the v2 call name.
      const system = host.agents().registry.get(agent)!.system!;
      expect(system).toContain('native `subagent()` call');
      expect(system).toContain('- `ui-investigator` — kind: custom overlay; base: `forager-investigator`; Browser-visible UI exercises.');
      expect(system).not.toContain('`ui-forager`');
    }
    // An Investigator session started by a review primary cannot delegate further.
    host.sessions.set('exercise', { id: 'exercise', parentID: 'primary', agent: 'forager-investigator' });
    expect(denied(await host.before({ tool: 'subagent', sessionID: 'exercise', agent: 'ui-investigator', input: { agent: 'scout-researcher' } }))).toBeDefined();
  });

  it('gives an Investigator exactly read and inspection Hive tools with native scratch edits, and lets Architect dispatch it but not a Forager', async () => {
    const host = await activate({}, { customAgents: { 'ui-investigator': { baseAgent: 'forager-investigator', description: 'Browser-visible UI exercises.' } } });
    host.useAgentConfig({ permissions: [{ action: '*', resource: '*', effect: 'allow' }] });
    host.sessions.set('experiment', { id: 'experiment', parentID: 'primary', agent: 'ui-investigator' });
    const investigator = { sessionID: 'experiment', agent: 'ui-investigator' };
    for (const tool of ['hive_status', 'hive_context_read', 'hive_worktree_inspect', 'hive_adhoc_worktree_inspect', 'edit', 'write']) {
      expect(denied(await host.before({ tool, ...investigator, input: {} })), tool).toBeUndefined();
    }
    for (const tool of ['hive_context_write', 'hive_task_update', 'hive_worktree_create', 'hive_task_trace', 'hive_adhoc_worktree_create', 'question']) {
      expect(denied(await host.before({ tool, ...investigator, input: {} })), tool).toBeDefined();
    }
    expect(denied(await host.before({ tool: 'subagent', ...investigator, input: { agent: 'scout-researcher' } }))).toBeDefined();
    // The custom Investigator gets its base instructions at request time, with no Forager task-report or source-pin contract.
    const instructions = (await host.request({ sessionID: 'experiment', agent: 'ui-investigator', system: ['x'], tools: ['read'] })).join('\n');
    expect(instructions).toContain('# Forager Investigator (Experimental Worker)');
    expect(instructions).not.toContain('# Forager (Worker/Coder)');
    expect(instructions).not.toContain('sourceCommit');
    for (const architect of [{ sessionID: 'primary' }, { sessionID: 'experiment' }]) {
      if (architect.sessionID === 'experiment') host.sessions.set('experiment', { id: 'experiment', parentID: 'primary', agent: 'architect-planner' });
      for (const target of ['forager-investigator', 'ui-investigator']) {
        expect(denied(await host.before({ tool: 'subagent', ...architect, agent: 'architect-planner', input: { agent: target } })), target).toBeUndefined();
      }
      expect(denied(await host.before({ tool: 'subagent', ...architect, agent: 'architect-planner', input: { agent: 'forager-worker' } }))).toBeDefined();
    }
    // Primary Architect places and removes experiments; a delegated Architect returns those requests to its parent.
    expect(denied(await host.before({ tool: 'hive_adhoc_worktree_create', sessionID: 'primary', agent: 'architect-planner', input: {} }))).toBeUndefined();
    expect(denied(await host.before({ tool: 'hive_adhoc_worktree_merge', sessionID: 'primary', agent: 'architect-planner', input: {} }))).toBeDefined();
    for (const tool of ['hive_adhoc_worktree_create', 'hive_adhoc_worktree_cleanup']) {
      expect(denied(await host.before({ tool, sessionID: 'experiment', agent: 'architect-planner', input: {} })), tool).toBeDefined();
    }
  });

  it('applies a child Forager bounded context edit through the v2 executor', async () => {
    const host = await activate();
    const content = '---\ndescription: Style.\nread_when: Always.\nowner: test\nreview_after: 2099-01-01\n---\nTone: formal\r\nTail\r\n';
    const output = (exit: Exit.Exit<any, unknown>) => (exit as Exit.Success<any>).value.output;
    output(await host.execute('hive_context_write', { scope: 'project', name: 'style-guide', content }, { sessionID: 'primary', agent: 'hive-master' }));
    const forager = { sessionID: 'child', agent: 'forager-worker' };
    const read = output(await host.execute('hive_context_read', { scope: 'project', name: 'style-guide' }, forager));
    const args = { scope: 'project', name: 'style-guide', oldText: 'Tone: formal', newText: 'Tone: plain', expectedRevision: read.revision, expectedContentHash: read.file.contentHash };
    expect(denied(await host.before({ tool: 'hive_context_edit', ...forager }))).toBeUndefined();
    expect(output(await host.execute('hive_context_edit', args, forager))).toMatchObject({ revision: read.revision + 1, file: { name: 'style-guide' } });
    expect(fs.readFileSync(path.join(host.root, '.hive', 'context', 'style-guide.md'), 'utf8')).toBe(content.replace('formal', 'plain'));
    expect(denied(await host.execute('hive_context_edit', args, forager))).toContain(`Context changed since revision ${read.revision}`);
  });

  it('carries refreshTasks and planSync through the shared approval operation and keeps it primary-only', async () => {
    const host = await activate();
    const output = (exit: Exit.Exit<any, unknown>) => (exit as Exit.Success<any>).value.output;
    const primary = { sessionID: 'primary', agent: 'hive-master' };
    const plan = '# Plan\n\n## Tasks\n\n### 1. Build\n\nBuild.\n';
    output(await host.execute('hive_feature_create', { name: 'refresh' }, primary));
    output(await host.execute('hive_plan_write', { feature: 'refresh', content: plan }, primary));
    const first = output(await host.execute('hive_plan_read', { feature: 'refresh' }, primary));
    output(await host.execute('hive_plan_approve', { feature: 'refresh', sync: true, expectedRevision: first.revision }, primary));
    output(await host.execute('hive_task_update', { feature: 'refresh', task: '01-build', status: 'in_progress' }, primary));
    expect(output(await host.execute('hive_plan_write', { feature: 'refresh', content: plan.replace('Build.', 'Build v2.') }, primary)).planSync).toMatchObject({ state: 'changed' });
    const amended = output(await host.execute('hive_plan_read', { feature: 'refresh' }, primary));
    const args = { feature: 'refresh', sync: true, expectedRevision: amended.revision, refreshTasks: ['01-build'] };

    const child = { sessionID: 'child', agent: 'hive-master' };
    expect(denied(await host.before({ tool: 'hive_plan_approve', ...child, input: args }))).toContain('primary-only');
    expect(denied(await host.execute('hive_plan_approve', args, child))).toContain('primary-only');
    expect(output(await host.execute('hive_plan_read', { feature: 'refresh' }, primary)).status).toBe('planning');

    expect(output(await host.execute('hive_plan_approve', args, primary))).toMatchObject({ approval: { success: true }, sync: { success: true, refreshed: ['01-build'] }, planSync: { state: 'current' } });
    expect(output(await host.execute('hive_status', { feature: 'refresh' }, primary))).toMatchObject({ tasks: [{ status: 'in_progress', specStale: false }], planSync: { state: 'current' } });
  });

  it('denies a primary orchestrator as a delegation target even when native configuration makes it callable', async () => {
    const host = await activate();
    const callable = host.agents({
      permissions: [{ action: 'subagent', resource: '*', effect: 'allow' }],
      agents: { 'hive-builder': { mode: 'all' }, 'swarm-orchestrator': { mode: 'subagent' }, 'hive-master': { mode: 'all', hidden: false } },
    }).registry;
    expect(['hive-builder', 'swarm-orchestrator', 'hive-master'].map((id) => callable.get(id)!.mode)).toEqual(['all', 'subagent', 'all']);
    for (const target of ['hive-builder', 'swarm-orchestrator', 'hive-master']) {
      for (const caller of ['build', 'architect-planner', 'general']) {
        expect(denied(await host.before({ tool: 'subagent', sessionID: 'primary', agent: caller, input: { agent: target } }))).toContain('primary-only orchestrator');
      }
    }
  });

  it('stamps the v2 owner and calling agent on Worklog records and writes nothing for a child or unreadable session', async () => {
    const host = await activate();
    const output = (exit: Exit.Exit<any, unknown>) => (exit as Exit.Success<any>).value.output;
    const primary = { sessionID: 'primary', agent: 'hive-builder' };
    const read = output(await host.execute('hive_worklog_read', {}, primary));
    expect(read).toMatchObject({ view: 'brief', exists: false, revision: 0, ref: { kind: 'session', owner: 'opencode-v2', sessionId: 'primary' }, key: 'session:opencode-v2:primary' });
    const args = { ref: read.ref, operationId: 'start', checkpoint: { summary: 'Started' }, author: { owner: 'opencode-v1', sessionId: 'x', agent: 'forged' } };
    const recorded = output(await host.execute('hive_worklog_record', args, primary));
    expect(recorded.entry.author).toEqual({ owner: 'opencode-v2', sessionId: 'primary', agent: 'hive-builder' });
    const logPath = path.join(host.root, '.hive', 'worklogs', 'sessions', 'opencode-v2');
    const files = () => fs.readdirSync(logPath).map((name) => fs.readFileSync(path.join(logPath, name), 'utf8'));
    const before = files();
    const childRef = { kind: 'session', owner: 'opencode-v2', sessionId: 'child' };
    expect(denied(await host.execute('hive_worklog_record', { ...args, ref: childRef }, { sessionID: 'child', agent: 'hive-builder' }))).toContain('primary-only');
    expect(denied(await host.execute('hive_worklog_record', { ...args, ref: { ...childRef, sessionId: 'gone' } }, { sessionID: 'gone', agent: 'hive-builder' }))).toContain('could not read session gone');
    expect(files()).toEqual(before);
    expect(fs.readdirSync(logPath)).toHaveLength(1);
  });

  it('presents Worklog results as compact JSON, with the same structured output, so maxBytes bounds the content text', async () => {
    const host = await activate();
    const primary = { sessionID: 'primary', agent: 'hive-builder' };
    const run = async (name: string, args: Record<string, unknown>) => (await host.execute(name, args, primary) as Exit.Success<{ output: any; content: string }>).value;
    const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

    const empty = await run('hive_worklog_list', {});
    const exact = bytes(JSON.stringify(empty.output));
    expect(empty.content).toBe(JSON.stringify(empty.output));
    const fitted = await run('hive_worklog_list', { maxBytes: exact });
    expect(bytes(fitted.content)).toBe(exact);
    expect(fitted.output).toEqual(empty.output);
    expect((await run('hive_worklog_list', { maxBytes: exact - 1 })).output).toMatchObject({ success: false, reason: 'response_too_large', details: { requiredBytes: exact } });

    const { ref } = await run('hive_worklog_read', {}).then((result) => result.output);
    for (let index = 1; index <= 6; index++) {
      const recorded = await run('hive_worklog_record', { ref, operationId: `op-${index}`, checkpoint: { summary: `Checkpoint ${index}`, detail: `${index}`.repeat(300) } });
      expect(recorded.content).toBe(JSON.stringify(recorded.output));
    }
    const whole = bytes((await run('hive_worklog_read', { ref, view: 'history', limit: 50, maxBytes: 64 * 1024 })).content);
    for (const budget of [whole, whole - 1, Math.floor(whole / 2)]) {
      const page = await run('hive_worklog_read', { ref, view: 'history', limit: 50, maxBytes: budget });
      expect(bytes(page.content), String(budget)).toBeLessThanOrEqual(budget);
      expect(page.content).toBe(JSON.stringify(page.output));
    }
    // Other tools keep the indented presentation.
    const status = await run('hive_repositories_status', {});
    expect(status.content).toBe(JSON.stringify(status.output, null, 2));
  });

  it('denies a primary-only call when the session cannot be read, rather than guessing it is a primary', async () => {
    const authority = createHiveAuthority({ session: { get: () => Effect.fail(new Error('gone')) } } as any, {});
    const exit = await Effect.runPromiseExit(authority.guardHive('hive_worktree_merge', { sessionID: 'missing', agent: 'swarm-orchestrator' }));
    expect(denied(exit)).toContain('could not read session missing');
    expect(Exit.isSuccess(await Effect.runPromiseExit(authority.guardHive('hive_status', { sessionID: 'missing', agent: 'swarm-orchestrator' })))).toBe(true);
  });
});

describe('v2 native precedence and canonical instructions', () => {
  const conflicting: UserAgentConfig = {
    default_agent: 'build',
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    agents: {
      'scout-researcher': { system: 'USER SCOUT PROMPT', description: 'user description', mode: 'primary', model: { providerID: 'user', id: 'model' }, steps: 3, permissions: [{ action: 'hive_*', resource: '*', effect: 'allow' }, { action: 'edit', resource: '*', effect: 'allow' }] },
      'swarm-orchestrator': { system: 'USER SWARM PROMPT', permissions: [{ action: 'subagent', resource: '*', effect: 'allow' }] },
    },
  };

  it('registers Hive defaults that native user configuration overrides', async () => {
    const host = await activate({}, {
      agents: {
        'scout-researcher': { model: 'hive-provider/scout-model', variant: 'high', temperature: 0.3 },
        'forager-worker': { variant: 'low' },
      },
      customAgents: {
        'scout-fast': { baseAgent: 'scout-researcher', description: 'Fast scout', variant: 'low' },
        'reviewer-native': { baseAgent: 'code-reviewer', description: 'Native reviewer' },
      },
    }, { seed: (root) => {
      fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
      fs.writeFileSync(path.join(root, '.hive', 'agent-hive.override.json'), JSON.stringify({ agents: { 'forager-worker': { model: 'project/forager' } } }));
    } });
    const defaults = host.agents();
    const scout = defaults.registry.get('scout-researcher')!;
    expect(scout.mode).toBe('subagent');
    expect(scout.model).toEqual({ providerID: 'hive-provider', id: 'scout-model', variant: 'high' });
    // A custom variant completes its Hive base model; a project model completes a global variant.
    expect(defaults.registry.get('scout-fast')!.model).toEqual({ providerID: 'hive-provider', id: 'scout-model', variant: 'low' });
    expect(defaults.registry.get('forager-worker')!.model).toEqual({ providerID: 'project', id: 'forager', variant: 'low' });
    // Roles and custom agents without Hive model settings register no model, so OpenCode's own selection applies.
    for (const id of ['hive-builder', 'swarm-orchestrator', 'code-reviewer', 'reviewer-native', 'dash-reviewer']) {
      expect(defaults.registry.get(id)!.model, id).toBeUndefined();
    }
    expect(scout.system).toContain('Scout');
    expect(scout.permissions).toContainEqual({ action: 'hive_*', resource: '*', effect: 'deny' });
    expect(scout.permissions).toContainEqual({ action: 'opencode_worktree_create', resource: '*', effect: 'deny' });
    expect(defaults.selected).toBe('architect-planner');
    expect(defaults.registry.get('swarm-orchestrator')!.system).toBeUndefined();
    expect(defaults.registry.get('general')!.permissions).toContainEqual({ action: 'hive_*', resource: '*', effect: 'deny' });

    const user = host.agents(conflicting);
    const overridden = user.registry.get('scout-researcher')!;
    expect(user.selected).toBe('build');
    expect(overridden).toMatchObject({ system: 'USER SCOUT PROMPT', description: 'user description', mode: 'primary', steps: 3 });
    // The user's model reference replaces Hive's whole reference, so Hive's variant does not survive on it.
    expect(overridden.model).toEqual({ providerID: 'user', id: 'model' });
    // The user's allow comes last, so the host shows the tools; visibility is not authority.
    expect(overridden.permissions.at(-1)).toEqual({ action: 'edit', resource: '*', effect: 'allow' });
    expect(denied(await host.before({ tool: 'edit', sessionID: 'child', agent: 'scout-researcher' }))).toContain('cannot use edit');
    expect(denied(await host.before({ tool: 'hive_plan_write', sessionID: 'primary', agent: 'scout-researcher' }))).toContain('not granted');
    expect(denied(await host.execute('hive_plan_write', { content: 'x' }, { sessionID: 'primary', agent: 'scout-researcher' }))).toContain('not granted');
  });

  it('keeps the canonical role instructions in each request, after a user system prompt, without duplicating them', async () => {
    const host = await activate();
    const registered = host.agents().registry.get('scout-researcher')!.system!;
    const kept = await host.request({ sessionID: 'child', agent: 'scout-researcher', system: [registered] });
    expect(kept.filter((text) => text.includes(registered))).toHaveLength(1);

    const replaced = await host.request({ sessionID: 'child', agent: 'scout-researcher', system: ['USER SCOUT PROMPT'] });
    expect(replaced[0]).toBe('USER SCOUT PROMPT');
    expect(replaced[1]).toBe(registered);
    expect(replaced.at(-1)).toBe(SUBAGENT_CLARIFICATION_PROMPT.trim());

    const swarm = await host.request({ sessionID: 'primary', agent: 'swarm-orchestrator', system: ['HOST DEFAULT PROMPT'] });
    expect(swarm[0]).toBe('HOST DEFAULT PROMPT');
    expect(swarm[1]).toContain('Swarm');
    expect(swarm).not.toContain(SUBAGENT_CLARIFICATION_PROMPT.trim());

    const unmanaged = await host.request({ sessionID: 'primary', agent: 'build', system: ['BUILD'] });
    expect(unmanaged).toEqual(['BUILD']);
  });

  it('applies the role instructions to the compaction and generate requests and leaves every request option to the host', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A legacy stored temperature is ignored; Hive sets no sampling option on any request.
      const host = await activate({}, { agents: { 'scout-researcher': { temperature: 0.3 } }, customAgents: { 'scout-docs': { baseAgent: 'scout-researcher', description: 'd', temperature: 0.2 } } });
      const registered = host.agents().registry.get('scout-researcher')!.system!;
      for (const kind of ['context', 'compaction', 'generate'] as const) {
        for (const agent of ['scout-researcher', 'scout-docs', 'swarm-orchestrator', 'build']) {
          expect((await host.requestDraft({ kind, sessionID: 'child', agent, system: ['x'] })).options, `${kind} ${agent}`).toEqual({});
          expect((await host.requestDraft({ kind, sessionID: 'child', agent, system: ['x'], options: { temperature: 0.9, maxTokens: 10 } })).options).toEqual({ temperature: 0.9, maxTokens: 10 });
        }
      }
      for (const kind of ['compaction', 'generate'] as const) {
        const draft = await host.requestDraft({ kind, sessionID: 'child', agent: 'scout-researcher', system: ['USER SCOUT PROMPT'], tools: ['read'] });
        // A child session without `execute` would get the clarification rule and the Code Mode notice on an ordinary turn.
        // Skill guidance reaches these requests too, so the universal skill is the only addition for a role with no configured names.
        expect(draft.system.map((part: { text: string }) => part.text)).toEqual(['USER SCOUT PROMPT', registered, expect.stringContaining('skill({ id: "unslop" })')]);
        const unmanaged = await host.requestDraft({ kind, sessionID: 'primary', agent: 'build', system: ['BUILD'] });
        expect(unmanaged.system).toEqual([{ type: 'text', text: 'BUILD' }]);
      }
      const ordinary = await host.request({ sessionID: 'child', agent: 'scout-researcher', system: ['USER SCOUT PROMPT'], tools: ['read'] });
      expect(ordinary).toContain(SUBAGENT_CLARIFICATION_PROMPT.trim());
      expect(warn.mock.calls.filter(([message]) => String(message).includes('removed setting temperature'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('stops activation with the semantic model error, so a native model for the role cannot complete the Hive variant', async () => {
    // The user's native model for the role would apply only after Hive registers, which activation never reaches.
    await expect(activate({}, { agents: { 'forager-worker': { variant: 'high' } } })).rejects.toThrow('agents.forager-worker.variant is set without a Hive model');
    await expect(activate({}, { agents: { 'forager-worker': { variant: 'high' } } })).rejects.toThrow('agent_hive.json');
  });

  it('diagnoses Code Mode reads that execute denial makes unreachable, and stays silent for direct reads', async () => {
    const codemode = await activate();
    const without = await codemode.request({ sessionID: 'child', agent: 'scout-researcher', system: ['x'], tools: ['read'] });
    expect(without.some((text) => text.includes('## Hive Read Transport Setup') && text.includes('`readTransport` to `direct`'))).toBe(true);
    const withExecute = await codemode.request({ sessionID: 'child', agent: 'scout-researcher', system: ['x'], tools: ['execute'] });
    expect(withExecute.some((text) => text.includes('Read Transport Setup'))).toBe(false);

    const direct = await activate({ readTransport: 'direct' });
    const directParts = await direct.request({ sessionID: 'child', agent: 'scout-researcher', system: ['x'], tools: ['read', 'hive_repositories_status'] });
    expect(directParts.some((text) => text.includes('Read Transport Setup'))).toBe(false);
    expect(direct.tools().get('hive_repositories_status').options.codemode).toBe(false);
    expect(directParts[1]).toContain('are direct tool calls');
  });
});

describe('v2 skills, commands and models', () => {
  it('registers materialized Hive skills by catalog id, rendered for v2', async () => {
    const host = await activate();
    const skills = host.skills();
    const verification = skills.get('verification');
    expect(verification.name).toBe('verification');
    expect(verification.path.endsWith(path.join('verification', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(verification.path)).toBe(true);
    expect([...skills.values()].some((skill) => skill.content.includes('skill({ name'))).toBe(false);
  });

  it('keeps user content and resolves name-based requirements to a unique user id, while retaining explicit ids', async () => {
    const host = await activate({}, { agents: { 'scout-researcher': { autoLoadSkills: ['verification', 'systematic-debugging', 'team-debugging'] } } });
    host.addUserSkill({ id: 'verification', name: 'verification', description: 'user', path: '/user/verification/SKILL.md', content: 'USER VERIFICATION' });
    expect(host.skills().get('verification').content).toBe('USER VERIFICATION');
    host.addUserSkill({ id: 'team-debugging', name: 'systematic-debugging', description: 'user', path: '/user/debugging/SKILL.md', content: 'USER DEBUGGING' });
    expect(host.skills().get('systematic-debugging')).toBeDefined();
    const parts = await host.request({ sessionID: 'child', agent: 'scout-researcher', system: ['x'], tools: ['read'] });
    const guidance = parts.find((text) => text.includes('## Configured Auto-Load Skills'))!;
    expect(guidance).toContain('"systematic-debugging": `skill({ id: "team-debugging" })`');
    expect(guidance.split('## Configured Auto-Load Skills')[1]).toContain('skill({ id: "team-debugging" })');
    expect(guidance).not.toContain('skill({ id: "systematic-debugging" })');
    // The lookup also accompanies canonical requirements in roles with no configured auto-loads.
    const reviewer = await host.request({ sessionID: 'child', agent: 'dash-reviewer', system: ['x'], tools: ['read'] });
    expect(reviewer.join('\n')).toContain('"systematic-debugging": `skill({ id: "team-debugging" })`');
    expect(host.skills().get('team-debugging').content).toBe('USER DEBUGGING');
  });

  it('asks every role and custom agent for unslop at request time, through the id of the skill with that name', async () => {
    const roles = [
      'hive-master', 'architect-planner', 'swarm-orchestrator', 'hive-builder', 'scout-researcher', 'forager-worker',
      'forager-investigator', 'hive-helper', 'plan-reviewer', 'code-reviewer', 'simplicity-reviewer', 'approach-advisor', 'vulnerability-reviewer',
      'dash-reviewer', 'vulnerability-review-primary',
    ];
    const host = await activate({}, { customAgents: { 'audit-reviewer': { baseAgent: 'code-reviewer', description: 'd', autoLoadSkills: ['unslop'] } } });
    const autoLoad = async (agent: string) => {
      const parts = await host.request({ sessionID: 'child', agent, system: ['x'], tools: ['read'] });
      return (parts.find((text) => text.includes('## Configured Auto-Load Skills')) ?? '').split('## Configured Auto-Load Skills')[1] ?? '';
    };
    for (const agent of [...roles, 'audit-reviewer']) {
      const guidance = await autoLoad(agent);
      expect(guidance.split('skill({ id: "unslop" })').length - 1, agent).toBe(1);
    }
    // A user catalog entry named unslop under another id wins by name, for primaries, private review primaries, and custom agents alike.
    host.addUserSkill({ id: 'team-unslop', name: 'unslop', description: 'user', path: '/user/unslop/SKILL.md', content: 'USER UNSLOP' });
    for (const agent of ['hive-master', 'dash-reviewer', 'vulnerability-review-primary', 'audit-reviewer']) {
      const guidance = await autoLoad(agent);
      expect(guidance, agent).toContain('skill({ id: "team-unslop" })');
      expect(guidance, agent).not.toContain('skill({ id: "unslop" })');
    }
    expect(host.skills().get('team-unslop').content).toBe('USER UNSLOP');
  });

  it('never takes the catalog id unslop for the implicit universal skill, while an operator-configured id stays exact', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const bundledDisabled of [false, true]) {
        const label = bundledDisabled ? 'bundled unslop disabled' : 'bundled unslop enabled';
        warn.mockClear();
        const host = await activate({}, {
          ...(bundledDisabled ? { disableSkills: ['unslop'] } : {}),
          customAgents: {
            'plain-reviewer': { baseAgent: 'code-reviewer', description: 'd' },
            'audit-reviewer': { baseAgent: 'code-reviewer', description: 'd', autoLoadSkills: ['unslop'] },
          },
        });
        const autoLoad = async (agent: string) => {
          const parts = await host.request({ sessionID: 'child', agent, system: ['x'], tools: ['read'] });
          return (parts.find((text) => text.includes('## Configured Auto-Load Skills')) ?? '').split('## Configured Auto-Load Skills')[1] ?? '';
        };
        // No skill is named unslop here: the id unslop belongs to a skill with another name.
        host.addUserSkill({ id: 'unslop', name: 'another-skill', description: 'user', path: '/user/another/SKILL.md', content: 'ANOTHER' });
        for (const agent of ['hive-master', 'scout-researcher', 'dash-reviewer', 'vulnerability-review-primary', 'plain-reviewer']) {
          const guidance = await autoLoad(agent);
          expect(guidance, `${label} ${agent}`).not.toContain('skill({ id: "unslop" })');
          expect(guidance, `${label} ${agent}`).not.toContain('another-skill');
        }
        // The operator named the id explicitly, so that exact catalog entry still loads, once.
        const explicit = await autoLoad('audit-reviewer');
        expect(explicit.split('skill({ id: "unslop" })').length - 1, label).toBe(1);
        // A disabled universal skill is the operator's choice and stays quiet; a missing one is reported.
        const reported = warn.mock.calls.some(([message]) => String(message).includes('Auto-load skill "unslop"'));
        expect(reported, label).toBe(!bundledDisabled);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('resolves auto-load skills against the effective skill catalog, including user-configured sources', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const host = await activate({}, {
        disableSkills: ['writing-plans'],
        agents: { 'scout-researcher': { autoLoadSkills: ['team-checklist', 'by-catalog-id', 'writing-plans', 'no-such-skill', 'verification'] } },
        customAgents: { 'security-scout': { baseAgent: 'scout-researcher', description: 'd', autoLoadSkills: ['custom-only'] } },
      });
      host.addUserSkill({ id: 'checklist-dir', name: 'team-checklist', description: 'user', path: '/user/checklist/SKILL.md', content: 'USER CHECKLIST' });
      host.addUserSkill({ id: 'by-catalog-id', name: 'Renamed Skill', description: 'user', path: '/user/renamed/SKILL.md', content: 'USER RENAMED' });
      host.addUserSkill({ id: 'custom-only', name: 'custom-only', description: 'user', path: '/user/custom/SKILL.md', content: 'USER CUSTOM' });
      const guidance = (parts: string[]) => parts.find((text) => text.includes('## Configured Auto-Load Skills')) ?? '';
      const scout = guidance(await host.request({ sessionID: 'child', agent: 'scout-researcher', system: ['x'], tools: ['read'] }));
      expect(scout).toContain('skill({ id: "checklist-dir" })');
      expect(scout).toContain('skill({ id: "by-catalog-id" })');
      expect(scout).toContain('skill({ id: "verification" })');
      expect(scout).not.toContain('no-such-skill');
      expect(scout).not.toContain('writing-plans');
      const custom = guidance(await host.request({ sessionID: 'child', agent: 'security-scout', system: ['x'], tools: ['read'] }));
      expect(custom).toContain('"checklist-dir"');
      expect(custom).toContain('"custom-only"');
      const messages = warn.mock.calls.map(([message]) => String(message));
      expect(messages.some((message) => message.includes('"writing-plans"') && message.includes('disabled in Hive config'))).toBe(true);
      expect(messages.some((message) => message.includes('"no-such-skill"') && message.includes('not found'))).toBe(true);
      expect(messages.some((message) => message.includes('"team-checklist"'))).toBe(false);
      // The guidance is a separate part, so the registered agent prompt is unchanged and never duplicated.
      const registered = host.agents().registry.get('scout-researcher')!.system!;
      expect(registered).not.toContain('Configured Auto-Load Skills');
    } finally {
      warn.mockRestore();
    }
  });

  it('reports multiple user candidates as ambiguous and still resolves an explicit configured id', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const host = await activate({}, { agents: { 'scout-researcher': { autoLoadSkills: ['systematic-debugging', 'team-debugging'] } } });
      host.addUserSkill({ id: 'team-debugging', name: 'systematic-debugging', description: 'user', path: '/user/team/SKILL.md', content: 'TEAM' });
      host.addUserSkill({ id: 'other-debugging', name: 'systematic-debugging', description: 'user', path: '/user/other/SKILL.md', content: 'OTHER' });
      const parts = await host.request({ sessionID: 'child', agent: 'scout-researcher', system: ['x'], tools: ['read'] });
      const guidance = parts.find((text) => text.includes('## Configured Auto-Load Skills'))!;
      expect(guidance).toContain('"systematic-debugging": unresolved (multiple user catalog ids: "team-debugging", "other-debugging")');
      const autoLoad = guidance.split('## Configured Auto-Load Skills')[1]!;
      expect(autoLoad).toContain('skill({ id: "team-debugging" })');
      expect(autoLoad).not.toContain('"other-debugging"');
      expect(autoLoad).not.toContain('"systematic-debugging"');
      expect(warn.mock.calls.some(([message]) => String(message).includes('multiple user skills share this name'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('renders commands against the agents the host has now', async () => {
    const host = await activate({}, { customAgents: {
      'primary-simplicity': { baseAgent: 'simplicity-reviewer', description: 'custom simplicity' },
      'disabled-security': { baseAgent: 'vulnerability-reviewer', description: 'disabled security' },
      'security-specialist': { baseAgent: 'vulnerability-reviewer', description: 'security specialist' },
    } });
    host.useAgentConfig({
      agents: {
        'approach-advisor': { disabled: true },
        'code-reviewer': { description: 'USER REVIEWER DESCRIPTION', model: { providerID: 'user', id: 'reviewer', variant: 'max' } },
        'primary-simplicity': { mode: 'primary' },
        'disabled-security': { disabled: true },
        'vulnerability-reviewer': { mode: 'primary' },
        'security-specialist': { description: 'USER SECURITY DESCRIPTION', model: { providerID: 'user', id: 'security', variant: 'high' } },
      },
    });
    host.sessions.set('s1', { id: 's1', agent: 'swarm-orchestrator' });
    const commands = host.commands();
    await Effect.runPromise(commands.get('council').execute({ sessionID: 's1', prompt: { text: 'is this safe?' }, delivery: 'steer' }));
    expect(host.prompts[0].text).toContain('Skipped approach-advisor: agent is not available');
    await Effect.runPromise(commands.get('dash-review').execute({ sessionID: 's1', prompt: { text: 'HEAD~1..HEAD' }, delivery: 'steer' }));
    expect(host.prompts[1].text).toContain('code-reviewer (base: code-reviewer; model: user/reviewer; variant: max; USER REVIEWER DESCRIPTION');
    expect(host.prompts[1].text).not.toContain('approach-advisor (base:');
    expect(host.prompts[1].text).not.toContain('primary-simplicity (base:');
    expect(host.prompts[1].text).toContain('Do not silently skip a required configured reviewer');
    await Effect.runPromise(commands.get('vuln-review').execute({ sessionID: 's1', prompt: { text: 'scope' }, delivery: 'steer' }));
    expect(host.prompts[2].text).toContain('security-specialist');
    expect(host.prompts[2].text).toContain('model: user/security; variant: high; USER SECURITY DESCRIPTION');
    expect(host.prompts[2].text).not.toContain('disabled-security');
    expect(host.prompts[2].text).not.toContain('vulnerability-reviewer (');
    expect(host.prompts[2].text).toContain('Run every explicitly requested specialist');
    expect(host.prompts[2].text).toContain('or silently skip requested reviewers');
  });

  it('switches an agent-bound command to the agent and its effective model and variant, as native commands do', async () => {
    const host = await activate();
    host.sessions.set('s1', { id: 's1', agent: 'swarm-orchestrator' });
    host.useAgentConfig({ agents: { 'dash-reviewer': { model: { providerID: 'user', id: 'dash', variant: 'high' } } } });
    await Effect.runPromise(host.commands().get('dash-review').execute({ sessionID: 's1', prompt: { text: 'HEAD' }, delivery: 'steer' }));
    expect(host.switches).toEqual([{ sessionID: 's1', agent: 'dash-reviewer' }]);
    expect(host.modelSwitches).toEqual([{ sessionID: 's1', model: { providerID: 'user', id: 'dash', variant: 'high' } }]);
    // An agent without a model leaves the session's model alone, and a command that is not agent-bound changes neither.
    host.useAgentConfig({});
    await Effect.runPromise(host.commands().get('vuln-review').execute({ sessionID: 's1', prompt: { text: 'scope' }, delivery: 'steer' }));
    await Effect.runPromise(host.commands().get('interview').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'queue' }));
    expect(host.switches.at(-1)).toEqual({ sessionID: 's1', agent: 'vulnerability-review-primary' });
    expect(host.modelSwitches).toHaveLength(1);
  });

  it('fails an agent-bound command whose agent the configuration removed, instead of prompting the wrong agent', async () => {
    const host = await activate();
    host.sessions.set('s1', { id: 's1', agent: 'swarm-orchestrator' });
    host.useAgentConfig({ agents: { 'dash-reviewer': { disabled: true } } });
    const exit = await Effect.runPromiseExit(host.commands().get('dash-review').execute({ sessionID: 's1', prompt: { text: 'HEAD' }, delivery: 'steer' }));
    expect(denied(exit)).toContain('needs the dash-reviewer agent');
    expect(host.prompts).toEqual([]);
    expect(host.switches).toEqual([]);
  });

  it('renders commands at invocation and switches to a command agent before prompting', async () => {
    const host = await activate();
    const commands = host.commands();
    expect([...commands.keys()].sort()).toEqual(HIVE_COMMANDS.map((command) => command.key).sort());
    host.sessions.set('s1', { id: 's1', agent: 'swarm-orchestrator' });
    await Effect.runPromise(commands.get('dash-review').execute({ sessionID: 's1', prompt: { text: 'HEAD~1..HEAD' }, delivery: 'steer' }));
    expect(host.switches).toEqual([{ sessionID: 's1', agent: 'dash-reviewer' }]);
    expect(host.prompts[0]).toMatchObject({ sessionID: 's1', delivery: 'steer' });
    expect(host.prompts[0].text).toContain('HEAD~1..HEAD');
    await Effect.runPromise(commands.get('interview').execute({ sessionID: 's1', prompt: { text: 'an idea' }, delivery: 'queue' }));
    expect(host.switches).toHaveLength(1);
    expect(host.prompts[1].text).toContain('an idea');
    expect(host.prompts[1].text).not.toContain('task(');
    // /implement binds no agent: the session keeps the agent and model it has, whichever agent it is and whatever model
    // Hive Builder is configured with, and the prompt carries the operator's prose exactly as typed.
    host.useAgentConfig({ agents: { 'hive-builder': { model: { providerID: 'user', id: 'builder', variant: 'high' } }, 'team-custom': {} } });
    const prose = 'ship the retry fix, but keep "legacy" mode\n\n- skip docs for now\n  (and ask before touching $HOME-ish paths)';
    const switchesBefore = host.switches.length;
    for (const [index, agent] of ['architect-planner', 'swarm-orchestrator', 'build', 'team-custom', 'hive-builder'].entries()) {
      const sessionID = `i${index}`;
      host.sessions.set(sessionID, { id: sessionID, agent });
      await Effect.runPromise(commands.get('implement').execute({ sessionID, prompt: { text: prose }, delivery: 'steer' }));
      expect(host.prompts.at(-1), agent).toMatchObject({ sessionID, delivery: 'steer' });
      expect(host.prompts.at(-1).text, agent).toContain(`<operator-text>\n${prose}\n</operator-text>`);
    }
    expect(host.switches).toHaveLength(switchesBefore);
    expect(host.modelSwitches).toEqual([]);
    // A blank invocation still prompts the same session with its own delivery.
    await Effect.runPromise(commands.get('implement').execute({ sessionID: 'i0', prompt: { text: '' }, delivery: 'queue' }));
    expect(host.prompts.at(-1)).toMatchObject({ sessionID: 'i0', delivery: 'queue' });
    expect(host.prompts.at(-1).text).toContain('<operator-text>\n\n</operator-text>');
    expect(host.switches).toHaveLength(switchesBefore);
    expect(host.modelSwitches).toEqual([]);
  });

  it('runs /implement on the selected agent in unified mode, even when Hive Builder is disabled', async () => {
    const host = await activate({}, { agentMode: 'unified' });
    host.sessions.set('s1', { id: 's1', agent: 'hive-master' });
    host.useAgentConfig({ agents: { 'hive-builder': { disabled: true } } });
    await Effect.runPromise(host.commands().get('implement').execute({ sessionID: 's1', prompt: { text: 'it' }, delivery: 'steer' }));
    expect(host.switches).toEqual([]);
    expect(host.modelSwitches).toEqual([]);
    expect(host.prompts).toHaveLength(1);
    expect(host.prompts[0]).toMatchObject({ sessionID: 's1', delivery: 'steer' });
    expect(host.prompts[0].text).toContain('<operator-text>\nit\n</operator-text>');
  });

  it('parses configured models into native references and fails loudly on a model validation should have rejected', () => {
    expect(toModelRef('anthropic/claude-x', 'max')).toEqual({ providerID: 'anthropic', id: 'claude-x', variant: 'max' });
    expect(toModelRef('openrouter/vendor/model', undefined)).toEqual({ providerID: 'openrouter', id: 'vendor/model' });
    expect(() => toModelRef('invalid', undefined)).toThrow();
  });

  it('stops activation on invalid options instead of guessing a transport', async () => {
    await expect(activate({ readTransport: 'auto' })).rejects.toThrow('readTransport');
  });
});
