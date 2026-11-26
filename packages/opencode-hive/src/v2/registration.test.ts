import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Effect, Exit, Scope, Stream } from 'effect';
import { Tool } from '@opencode/plugin/effect';
import type { Plugin } from '@opencode/plugin/effect';
import plugin from '../index.js';
import { SUBAGENT_CLARIFICATION_PROMPT } from '../hooks/system-hook.js';
import { HIVE_COMMANDS } from '../commands/registry.js';
import { CODEMODE_READ_TOOLS } from '../runtime/host-profile.js';
import { createHiveOperations } from '../runtime/hive-tools.js';
import { createHiveServices } from '../runtime/hive-services.js';
import { COUNCIL_SEAT_BASES, PRIMARY_ONLY_TOOLS, authorizeNativeCall, createRolePolicy, isToolUnconditionallyDenied } from '../runtime/role-policy.js';
import { HIVE_TOOL_NAMES } from '../utils/plugin-manifest.js';
import { createHiveAuthority, toModelRef } from './registration.js';
import { standardSchema, toToolInfo } from './tools.js';
import { z } from '../runtime/schema.js';

/** For operation sets whose tests never read a council roster. */
const unusedCouncilReader = async (): Promise<never> => { throw new Error('council agent reader called unexpectedly'); };

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
  type Hook = (event: any) => Effect.Effect<void, any>;
  const hooks = { before: [] as Hook[], after: [] as Hook[], context: [] as Hook[], compaction: [] as Hook[], generate: [] as Hook[], prompt: [] as Hook[] };
  const instructionEntries = new Map<string, unknown>();
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
      hook: (name: string, cb: any) => Effect.sync(() => {
        if (name === 'execute.before') hooks.before.push(cb);
        if (name === 'execute.after') hooks.after.push(cb);
        return registration;
      }),
    },
    session: {
      hook: (name: string, cb: any) => Effect.sync(() => { if (name === 'context' || name === 'compaction' || name === 'generate' || name === 'prompt') hooks[name].push(cb); return registration; }),
      instructions: {
        entry: {
          put: ({ sessionID, key, value }: { sessionID: string; key: string; value: unknown }) => Effect.sync(() => { instructionEntries.set(`${sessionID}/${key}`, value); }),
          remove: ({ sessionID, key }: { sessionID: string; key: string }) => Effect.sync(() => { instructionEntries.delete(`${sessionID}/${key}`); }),
        },
      },
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
  /**
   * The tool registry keyed by effective ID, as the host builds it: a tool in a namespace the same transform declared
   * gets the ID `<namespace>_<name>`.
   */
  const toolCatalog = () => {
    const registry = new Map<string, any>();
    const namespaces = new Map<string, string>();
    // `update` ignores missing tools, as the host's editor does; the native subagent tool is not registered here.
    for (const cb of transforms.tool) {
      const declared = new Set<string>();
      cb({
        namespace: (ns: { name: string; description: string }) => { declared.add(ns.name); namespaces.set(ns.name, ns.description); },
        add: (info: any) => {
          const ns = info.options?.namespace;
          if (ns !== undefined) expect(declared.has(ns)).toBe(true);
          const id = ns === undefined ? info.name : `${ns}_${info.name}`;
          expect(registry.has(id)).toBe(false);
          registry.set(id, info);
        },
        update: (id: string, fn: (info: any) => void) => { if (registry.has(id)) fn(registry.get(id)); },
      });
    }
    return { registry, namespaces };
  };
  const tools = () => toolCatalog().registry;
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
  /** Executes a Hive tool and then runs every execute.after hook on its outcome, as the host does after each call. */
  const executeWithAfter = async (name: string, args: unknown, caller: { sessionID: string; agent: string }) => {
    const exit = await execute(name, args, caller);
    const outcome = Exit.isSuccess(exit) ? { status: 'completed', result: exit.value } : { status: 'error', error: exit.cause };
    for (const hook of hooks.after) await Effect.runPromise(hook({ tool: name, ...caller, messageID: 'm', id: 'c', input: args, codemode: false, ...outcome }));
    return exit;
  };
  /** Runs every prompt hook, as the host does before it admits a prompt to the session. */
  const prompt = (sessionID: string) => Effect.runPromise(Effect.forEach(hooks.prompt, (hook) => hook({ sessionID }), { discard: true }));
  return {
    context, sessions, prompts, switches, modelSwitches, sessionGets, agents, tools, toolCatalog, skills, commands, before, request, requestDraft, execute, executeWithAfter, prompt, instructionEntries,
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
  // XDG_STATE_HOME also moves: without a `server` option the reader looks for the managed service registered there.
  const saved = { HOME: process.env.HOME, OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.HOME = home;
  process.env.XDG_STATE_HOME = path.join(home, '.local', 'state');
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
  it('registers every Hive tool once by its hive_* ID, grouping only the Code Mode reads in the hive namespace', async () => {
    const reads = [
      'hive_checkout_brief', 'hive_checkouts_list', 'hive_explore_read', 'hive_git_snapshot', 'hive_repositories_discover', 'hive_repositories_status',
      'hive_task_trace_content', 'hive_worklog_list', 'hive_worklog_read',
    ];
    expect([...CODEMODE_READ_TOOLS].sort()).toEqual(reads);
    for (const transport of ['codemode', 'direct'] as const) {
      const catalog = (await activate({ readTransport: transport })).toolCatalog();
      expect([...catalog.registry.keys()].sort(), transport).toEqual([...HIVE_TOOL_NAMES].sort());
      expect([...catalog.namespaces], transport).toEqual(transport === 'codemode' ? [['hive', 'Agent Hive.']] : []);
      for (const [id, info] of catalog.registry) {
        // The host joins a namespace and a local name with `_`, so a grouped read keeps its hive_* ID.
        const grouped = transport === 'codemode' && reads.includes(id);
        expect([info.name, info.options], `${transport} ${id}`)
          .toEqual(grouped ? [id.slice('hive_'.length), { namespace: 'hive', codemode: true }] : [id, { codemode: false }]);
      }
    }
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

    // A refined argument validates through Standard Schema too: the checkout discard accepts only true.
    const cleanup = host.tools().get('hive_checkout_cleanup').input['~standard'];
    const cleanupInput = (deleteBranch: unknown) => ({ id: 'root/x', expectedTarget: null, deleteBranch });
    expect(await cleanup.validate(cleanupInput({ discard: true, commit: 'abc' }))).toEqual({ value: cleanupInput({ discard: true, commit: 'abc' }) });
    for (const invalid of [{ discard: false, commit: 'abc' }, { discard: 'true', commit: 'abc' }, { discard: true }]) {
      expect((await cleanup.validate(cleanupInput(invalid))).issues, JSON.stringify(invalid)).toBeDefined();
    }
  });

  it('delivers each ordinary operation description and field descriptions unchanged through the JSON Schema export', async () => {
    const operations = createHiveOperations({} as any, unusedCouncilReader);
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

    const operations = createHiveOperations({} as any, unusedCouncilReader);
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
    // Seed a selected feature with a Worklog entry and an exploration, so the reads below return stored documents.
    const builder = { sessionID: 'primary', agent: 'hive-builder' };
    const succeeded = (exit: Exit.Exit<any, unknown>) => { expect(denied(exit)).toBeUndefined(); return (exit as Exit.Success<any>).value.output; };
    succeeded(await host.execute('hive_feature_create', { name: 'demo' }, builder));
    succeeded(await host.execute('hive_feature_select', { feature: 'demo' }, builder));
    const featureRef = { kind: 'feature', featureName: 'demo' };
    succeeded(await host.execute('hive_worklog_record', { ref: featureRef, operationId: 'seed', checkpoint: { summary: 'Seeded' } }, builder));
    succeeded(await host.execute('hive_explore_update', { id: 'audit', expectedRevision: 0, goal: 'Audit the login surface', frontier: [{ key: 'login', target: 'POST /login', state: 'open' }] }, builder));
    // Two retained checkouts in the one repository, so a brief compares a managed checkout against the registered root.
    succeeded(await host.execute('hive_checkout_register', { id: 'root/main' }, builder));
    succeeded(await host.execute('hive_checkout_create', { id: 'root/topic', branch: 'topic', baseRef: 'main' }, builder));
    const seedGets = host.sessionGets.length;
    const tree = (dir: string): string[] => fs.existsSync(dir)
      ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).map((entry) => {
        const full = path.join(entry.parentPath, entry.name);
        return `${path.relative(dir, full)}:${fs.statSync(full).mtimeMs}`;
      }).sort()
      : [];
    // The main checkout's index and the managed checkout's worktree index.
    const gitIndex = () => [path.join(host.root, '.git', 'index'), path.join(host.root, '.git', 'worktrees', 'topic', 'index')].map((file) => fs.statSync(file).mtimeMs);
    const beforeHive = tree(path.join(host.root, '.hive'));
    const beforeIndex = gitIndex();
    for (const agent of ['scout-researcher', 'forager-worker', 'hive-master']) {
      const read = async (name: string, args: Record<string, unknown>, sessionID = 'child') => {
        expect(denied(await host.before({ tool: name, sessionID, agent }))).toBeUndefined();
        return succeeded(await host.execute(name, args, { sessionID, agent }));
      };
      await read('hive_repositories_status', {});
      await read('hive_git_snapshot', {});
      // Without ref, a session with no selected feature reads its own log under the v2 owner, which does not exist yet.
      expect(await read('hive_worklog_read', {})).toMatchObject({ exists: false, revision: 0, ref: { kind: 'session', owner: 'opencode-v2', sessionId: 'child' } });
      // A session with a selected feature reads that feature's log.
      expect(await read('hive_worklog_read', {}, 'primary')).toMatchObject({ exists: true, revision: 1, ref: featureRef, key: 'feature:demo' });
      // An explicit ref reads that log from any session.
      expect(await read('hive_worklog_read', { ref: featureRef })).toMatchObject({ exists: true, revision: 1, key: 'feature:demo' });
      expect((await read('hive_worklog_list', {})).worklogs).toEqual([expect.objectContaining({ ref: featureRef })]);
      expect(await read('hive_explore_read', {})).toMatchObject({ totalActive: 1, explorations: [expect.objectContaining({ id: 'audit' })] });
      expect(await read('hive_explore_read', { id: 'audit', view: 'full' })).toMatchObject({ view: 'full', revision: 1 });
      const listed = await read('hive_checkouts_list', {});
      expect(listed.repositories[0].checkouts.map((checkout: any) => checkout.id).sort()).toEqual(['root/main', 'root/topic']);
      const brief = await read('hive_checkout_brief', { id: 'root/topic', against: 'root/main' });
      expect(brief).toMatchObject({ success: true, source: { id: 'root/topic' }, destination: { id: 'root/main' } });
      expect(brief.comparison.status).not.toBe('unresolved');
      // Only Scout and the primary are granted discovery; the guard refuses it to a Forager.
      if (agent === 'forager-worker') expect(denied(await host.before({ tool: 'hive_repositories_discover', sessionID: 'child', agent }))).toBeDefined();
      else expect((await read('hive_repositories_discover', {})).candidates).toEqual([expect.objectContaining({ path: '.', root: host.root })]);
    }
    expect(tree(path.join(host.root, '.hive'))).toEqual(beforeHive);
    expect(gitIndex()).toEqual(beforeIndex);
    // No admitted read is primary-only, so the guard needs no session lookup for them.
    expect(host.sessionGets.slice(seedGets)).toEqual([]);
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

  it('maps a session in a retained checkout back to the main checkout without inventing a feature', async () => {
    const checkout = path.join('.hive', 'checkouts', 'root', 'release');
    const host = await activate({}, undefined, { directory: path.join(checkout, 'pkg'), projectDirectory: checkout, seed: seedManifest });
    const repositories = await host.execute('hive_repositories_status', {}, primary);
    expect((repositories as Exit.Success<any>).value.output).toMatchObject({ mode: 'manifest', repositories: [{ id: 'root' }] });
    expect(Exit.isSuccess(await host.execute('hive_feature_create', { name: 'one' }, primary))).toBe(true);
    expect(Exit.isSuccess(await host.execute('hive_feature_create', { name: 'two' }, primary))).toBe(true);
    expect(fs.existsSync(path.join(host.root, checkout, '.hive'))).toBe(false);
    // With two live features and no selection, nothing names one: the checkout path is not a feature route.
    expect(denied(await host.execute('hive_status', {}, primary))).toContain('Feature is required');
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
    // Automations: the four mutating tools are the operator's. Every Hive role (primary or child, editing or not),
    // native subagent and child session is refused them; listing stays native. A top-level unmanaged agent keeps
    // native authority.
    ['swarm-orchestrator', 'primary', 'automation_create', {}, false],
    ['swarm-orchestrator', 'primary', 'automation_resume', {}, false],
    ['swarm-orchestrator', 'primary', 'automation_pause', {}, false],
    ['swarm-orchestrator', 'primary', 'automation_delete', {}, false],
    ['swarm-orchestrator', 'primary', 'automation_list', {}, true],
    ['forager-worker', 'child', 'automation_create', {}, false],
    ['forager-worker', 'child', 'automation_delete', {}, false],
    ['forager-investigator', 'child', 'automation_pause', {}, false],
    ['scout-researcher', 'child', 'automation_pause', {}, false],
    ['architect-planner', 'primary', 'automation_pause', {}, false],
    ['security-scout', 'child', 'automation_delete', {}, false],
    ['security-scout', 'child', 'automation_list', {}, true],
    ['general', 'child', 'automation_create', {}, false],
    ['general', 'child', 'automation_pause', {}, false],
    ['explore', 'child', 'automation_resume', {}, false],
    ['build', 'primary', 'automation_create', {}, true],
    ['build', 'primary', 'automation_resume', {}, true],
    ['build', 'primary', 'automation_pause', {}, true],
    ['build', 'primary', 'automation_delete', {}, true],
    ['build', 'child', 'automation_create', {}, false],
    ['build', 'child', 'automation_resume', {}, false],
    ['build', 'child', 'automation_pause', {}, false],
    ['build', 'child', 'automation_delete', {}, false],
    ['build', 'child', 'automation_list', {}, true],
    // Interrupting another session is the operator's, like the automations: Hive roles, native subagents and child
    // sessions are refused; a top-level unmanaged agent keeps native authority.
    ['swarm-orchestrator', 'primary', 'opencode_session_interrupt', {}, false],
    ['forager-worker', 'child', 'opencode_session_interrupt', {}, false],
    ['general', 'child', 'opencode_session_interrupt', {}, false],
    ['explore', 'child', 'opencode_session_interrupt', {}, false],
    ['build', 'primary', 'opencode_session_interrupt', {}, true],
    ['build', 'child', 'opencode_session_interrupt', {}, false],
    // A model can call a Code Mode tool at top level by its dotted qualified name; the host then reports that name to
    // execute.before once and runs the tool without a second hook, so the dotted name gets the same decision.
    ['swarm-orchestrator', 'primary', 'opencode.worktree_create', {}, false],
    ['swarm-orchestrator', 'primary', 'opencode.worktree_remove', {}, false],
    ['swarm-orchestrator', 'primary', 'opencode.session.move', {}, false],
    ['swarm-orchestrator', 'primary', 'opencode.session.interrupt', {}, false],
    ['swarm-orchestrator', 'primary', 'automation.create', {}, false],
    ['swarm-orchestrator', 'primary', 'automation.resume', {}, false],
    ['swarm-orchestrator', 'primary', 'automation.pause', {}, false],
    ['swarm-orchestrator', 'primary', 'automation.delete', {}, false],
    ['swarm-orchestrator', 'primary', 'automation.list', {}, true],
    ['forager-worker', 'child', 'automation.create', {}, false],
    ['forager-worker', 'child', 'opencode.session.interrupt', {}, false],
    ['general', 'child', 'automation.create', {}, false],
    ['general', 'child', 'opencode.session.interrupt', {}, false],
    ['explore', 'child', 'automation.pause', {}, false],
    ['explore', 'child', 'opencode.session.interrupt', {}, false],
    ['build', 'primary', 'automation.create', {}, true],
    ['build', 'primary', 'opencode.session.interrupt', {}, true],
    ['build', 'primary', 'opencode.session.move', {}, true],
    ['build', 'child', 'automation.create', {}, false],
    ['build', 'child', 'automation.delete', {}, false],
    ['build', 'child', 'opencode.session.interrupt', {}, false],
    ['build', 'child', 'automation.list', {}, true],
    ['forager-worker', 'child', 'hive.worklog_read', {}, true],
    ['general', 'child', 'hive.worklog_read', {}, false],
    ['forager-worker', 'child', 'hive.feature_complete', {}, false],
    ['build', 'child', 'hive.feature_complete', {}, false],
    ['build', 'primary', 'hive.feature_complete', {}, true],
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
    // Explorations: every Hive role reads; only primary sessions of authoring roles write.
    ['forager-worker', 'child', 'hive_explore_read', {}, true],
    ['scout-researcher', 'child', 'hive_explore_read', {}, true],
    ['forager-investigator', 'child', 'hive_explore_read', {}, true],
    ['vulnerability-reviewer', 'child', 'hive_explore_read', {}, true],
    ['general', 'child', 'hive_explore_read', {}, false],
    ['explore', 'child', 'hive_explore_read', {}, false],
    ['hive-builder', 'primary', 'hive_explore_update', {}, true],
    ['architect-planner', 'primary', 'hive_explore_update', {}, true],
    ['vulnerability-review-primary', 'primary', 'hive_explore_update', {}, true],
    ['architect-planner', 'child', 'hive_explore_update', {}, false],
    ['hive-builder', 'child', 'hive_explore_update', {}, false],
    ['forager-worker', 'primary', 'hive_explore_update', {}, false],
    ['vulnerability-reviewer', 'child', 'hive_explore_update', {}, false],
    ['general', 'child', 'hive_explore_update', {}, false],
    ['build', 'child', 'hive_explore_update', {}, false],
    // Retained checkouts: every Hive role lists them and inspection follows worktree inspection; who changes them is
    // pinned under a global allow below.
    ['scout-researcher', 'child', 'hive_checkouts_list', {}, true],
    ['security-scout', 'child', 'hive_checkouts_list', {}, true],
    ['forager-worker', 'child', 'hive_checkout_inspect', {}, true],
    ['hive-helper', 'child', 'hive_checkout_inspect', {}, true],
    ['scout-researcher', 'child', 'hive_checkout_inspect', {}, false],
    ['general', 'child', 'hive_checkouts_list', {}, false],
    ['hive-helper', 'child', 'hive_checkout_brief', {}, true],
    ['code-reviewer', 'child', 'hive_checkout_brief', {}, true],
    ['forager-investigator', 'child', 'hive_checkout_brief', {}, true],
    ['general', 'child', 'hive_checkout_brief', {}, false],
    // The reads Code Mode groups keep their hive_* IDs, so grants and refusals name them exactly.
    ['scout-researcher', 'child', 'hive_checkout_brief', {}, true],
    ['security-scout', 'child', 'hive_checkout_brief', {}, true],
    ['forager-investigator', 'child', 'hive_checkouts_list', {}, true],
    ['scout-researcher', 'child', 'hive_repositories_discover', {}, true],
    ['security-scout', 'child', 'hive_repositories_discover', {}, true],
    ['forager-investigator', 'child', 'hive_repositories_discover', {}, false],
    ['general', 'child', 'hive_repositories_discover', {}, false],
    ['build', 'primary', 'hive_checkout_create', {}, true],
    ['build', 'child', 'hive_checkout_cleanup', {}, false],
  ];

  it.each(cases)('%s in a %s session calling %s', async (agent, sessionID, tool, input, allowed) => {
    const host = await activate({}, { customAgents: { 'security-scout': { baseAgent: 'scout-researcher', description: 'Primary orchestrator with full authority' } } });
    const hook = denied(await host.before({ tool, sessionID, agent, input }));
    expect(hook === undefined).toBe(allowed);
    if (tool.startsWith('hive_') && host.tools().has(tool)) {
      const exit = await host.execute(tool, {}, { sessionID, agent });
      const executorDenied = denied(exit);
      if (!allowed) expect(executorDenied).toBe(hook);
      // An allowed call may still fail its own input validation, but never on a role or session refusal.
      else expect(executorDenied ?? '').not.toMatch(new RegExp(`${tool} is (not granted|a primary-only|denied)|has no Hive tool access`));
    }
  });

  it('reads the parent of an unmanaged caller for dotted automation and interrupt calls, and denies one it cannot read', async () => {
    const host = await activate();
    for (const tool of ['automation.create', 'automation.resume', 'automation.pause', 'automation.delete', 'opencode.session.interrupt']) {
      const seen = host.sessionGets.length;
      expect(denied(await host.before({ tool, sessionID: 'primary', agent: 'build', input: {} })), tool).toBeUndefined();
      expect(host.sessionGets.slice(seen), tool).toEqual(['primary']);
      expect(denied(await host.before({ tool, sessionID: 'missing', agent: 'build', input: {} })), tool).toBeDefined();
    }
  });

  it('keeps retained checkout changes with executing primary sessions under a user global allow', async () => {
    const host = await activate({}, { customAgents: { 'release-builder': { baseAgent: 'forager-worker', description: 'Release work.' } } });
    host.useAgentConfig({ permissions: [{ action: '*', resource: '*', effect: 'allow' }] });
    const mutations = ['hive_checkout_create', 'hive_checkout_register', 'hive_checkout_readiness', 'hive_checkout_cleanup'];
    for (const tool of mutations) {
      for (const agent of ['hive-master', 'swarm-orchestrator', 'hive-builder']) {
        expect(denied(await host.before({ tool, sessionID: 'primary', agent, input: {} })), `${agent} ${tool}`).toBeUndefined();
        expect(denied(await host.before({ tool, sessionID: 'child', agent, input: {} })), `child ${agent} ${tool}`).toBeDefined();
      }
      for (const agent of ['architect-planner', 'dash-reviewer', 'forager-worker', 'release-builder', 'general']) {
        expect(denied(await host.before({ tool, sessionID: 'primary', agent, input: {} })), `${agent} ${tool}`).toBeDefined();
      }
    }
    expect(denied(await host.before({ tool: 'hive_checkout_inspect', sessionID: 'child', agent: 'release-builder', input: {} }))).toBeUndefined();
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
    expect(denied(await host.before({ tool: 'hive_worktree_recover', sessionID: 'primary', agent: 'architect-planner', input: {} }))).toBeUndefined();
    for (const tool of ['hive_adhoc_worktree_create', 'hive_adhoc_worktree_cleanup', 'hive_worktree_recover']) {
      expect(denied(await host.before({ tool, sessionID: 'experiment', agent: 'architect-planner', input: {} })), tool).toBeDefined();
    }
  });

  it('lets primary and child Architect dispatch every council seat base and its derivatives, under a user global allow', async () => {
    const host = await activate({}, { customAgents: {
      'security-specialist': { baseAgent: 'vulnerability-reviewer', description: 'Security seat.' },
      'ui-forager': { baseAgent: 'forager-worker', description: 'Browser-visible UI implementation.' },
    } });
    host.useAgentConfig({ permissions: [{ action: '*', resource: '*', effect: 'allow' }] });
    host.sessions.set('delegated', { id: 'delegated', parentID: 'primary', agent: 'architect-planner' });
    const allowedTargets = [...COUNCIL_SEAT_BASES, 'security-specialist'];
    const deniedTargets = ['forager-worker', 'ui-forager', 'architect-planner', 'hive-master', 'swarm-orchestrator', 'hive-builder'];
    for (const sessionID of ['primary', 'delegated']) {
      const dispatch = async (target: string) => denied(await host.before({ tool: 'subagent', sessionID, agent: 'architect-planner', input: { agent: target } }));
      for (const target of allowedTargets) expect(await dispatch(target), `${sessionID} -> ${target}`).toBeUndefined();
      for (const target of deniedTargets) expect(await dispatch(target), `${sessionID} -> ${target}`).toBeDefined();
    }
    const rules = host.agents().registry.get('architect-planner')!.permissions.filter((rule) => rule.action === 'subagent');
    for (const target of allowedTargets) expect(rules, target).toContainEqual({ action: 'subagent', resource: target, effect: 'allow' });
    for (const target of deniedTargets) expect(rules, target).not.toContainEqual({ action: 'subagent', resource: target, effect: 'allow' });
    expect(rules).toContainEqual({ action: 'subagent', resource: '*', effect: 'deny' });
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

  it('stamps the v2 owner on exploration updates, presents compact JSON, and writes nothing for a child or unreadable session', async () => {
    const host = await activate();
    const primary = { sessionID: 'primary', agent: 'vulnerability-review-primary' };
    const args = { id: 'audit', expectedRevision: 0, goal: 'Audit the login surface', frontier: [{ key: 'login', target: 'POST /login', state: 'open' }], createdBy: { owner: 'opencode-v1', sessionId: 'x', agent: 'forged' } };
    const created = (await host.execute('hive_explore_update', args, primary) as Exit.Success<{ output: any; content: string }>).value;
    expect(created.output.createdBy).toEqual({ owner: 'opencode-v2', sessionId: 'primary', agent: 'vulnerability-review-primary' });
    expect(created.content).toBe(JSON.stringify(created.output));
    const directory = path.join(host.root, '.hive', 'explorations');
    const before = fs.readdirSync(directory, { recursive: true });
    expect(denied(await host.execute('hive_explore_update', { ...args, id: 'child-audit' }, { sessionID: 'child', agent: 'hive-builder' }))).toContain('primary-only');
    expect(denied(await host.execute('hive_explore_update', { ...args, id: 'gone-audit' }, { sessionID: 'gone', agent: 'hive-builder' }))).toContain('could not read session gone');
    expect(fs.readdirSync(directory, { recursive: true })).toEqual(before);
    const read = (await host.execute('hive_explore_read', { id: 'audit' }, { sessionID: 'child', agent: 'forager-worker' }) as Exit.Success<{ output: any }>).value.output;
    expect(read).toMatchObject({ view: 'brief', revision: 1, gaps: { total: 1 } });
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
    for (const id of ['hive-builder', 'swarm-orchestrator', 'code-reviewer', 'reviewer-native', 'dash-reviewer', 'vulnerability-review-primary']) {
      expect(defaults.registry.get(id)!.model, id).toBeUndefined();
    }
    for (const id of ['dash-reviewer', 'vulnerability-review-primary']) {
      expect(defaults.registry.get(id)!.mode, id).toBe('primary');
      expect(defaults.registry.get(id)!.hidden, id).toBe(true);
    }
    expect(scout.system).toContain('Scout');
    expect(scout.permissions).toContainEqual({ action: 'hive_*', resource: '*', effect: 'deny' });
    expect(scout.permissions).toContainEqual({ action: 'opencode_worktree_create', resource: '*', effect: 'deny' });
    // The default denies hide exactly the bypass tools the execution guard refuses to each agent.
    const automationDenies = (id: string) => defaults.registry.get(id)!.permissions
      .filter((rule: { action: string; effect: string }) => rule.action.startsWith('automation_') && rule.effect === 'deny')
      .map((rule: { action: string }) => rule.action.slice('automation_'.length)).sort();
    for (const id of ['scout-researcher', 'scout-fast', 'forager-worker', 'swarm-orchestrator', 'general', 'explore']) {
      expect(automationDenies(id), id).toEqual(['create', 'delete', 'pause', 'resume']);
    }
    expect(automationDenies('build')).toEqual([]);
    const interruptDenied = (id: string) => defaults.registry.get(id)!.permissions.some((rule: { action: string; effect: string }) => rule.action === 'opencode_session_interrupt' && rule.effect === 'deny');
    for (const id of ['scout-researcher', 'scout-fast', 'forager-worker', 'swarm-orchestrator', 'general', 'explore']) {
      expect(interruptDenied(id), id).toBe(true);
    }
    expect(interruptDenied('build')).toBe(false);
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

  it('registers a custom agent on its own model without the base role variant meant for another model', async () => {
    const host = await activate({}, {
      agents: { 'code-reviewer': { model: 'openai/gpt-6.2-sol', variant: 'xhigh' } },
      customAgents: { 'ui-reviewer': { baseAgent: 'code-reviewer', description: 'UI reviewer', model: '9router/ag/gemini-4-neon-high' } },
    });
    const registry = host.agents().registry;

    expect(registry.get('ui-reviewer')!.model).toEqual({ providerID: '9router', id: 'ag/gemini-4-neon-high' });
    expect(registry.get('ui-reviewer')!.model).not.toHaveProperty('variant');
    expect(registry.get('code-reviewer')!.model).toEqual({ providerID: 'openai', id: 'gpt-6.2-sol', variant: 'xhigh' });
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
        const unmanaged = await host.requestDraft({ kind, sessionID: 'primary', agent: 'build', system: ['BUILD'] });
        expect(unmanaged.system).toEqual([{ type: 'text', text: 'BUILD' }]);
      }
      // A child session without `execute` gets the clarification rule and the Code Mode notice on turn-prefixed
      // requests; generate gets only the role instructions and skill guidance (here the universal skill alone).
      const generate = await host.request({ kind: 'generate', sessionID: 'child', agent: 'scout-researcher', system: ['USER SCOUT PROMPT'], tools: ['read'] });
      expect(generate).toEqual(['USER SCOUT PROMPT', registered, expect.stringContaining('skill({ id: "unslop" })')]);
      const ordinary = await host.request({ sessionID: 'child', agent: 'scout-researcher', system: ['USER SCOUT PROMPT'], tools: ['read'] });
      expect(ordinary).toContain(SUBAGENT_CLARIFICATION_PROMPT.trim());
      expect(warn.mock.calls.filter(([message]) => String(message).includes('removed setting temperature'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps a primary session's route instruction entry current through activation, and writes none on a model request", async () => {
    const host = await activate();
    const caller = { sessionID: 'primary', agent: 'swarm-orchestrator' };
    const entry = () => host.instructionEntries.get('primary/hive.session') as string | undefined;
    // A constraint another client wrote reaches the entry at the next prompt.
    const seeded = createHiveServices({ projectRoot: host.root, nativeObservationOwner: 'opencode-v2' });
    seeded.sessionService.addStandingConstraint('primary', 'Seeded before the prompt.');
    expect(entry()).toBeUndefined();
    await host.prompt('primary');
    expect(entry()).toContain('Session constraints (revision 1):\nSeeded before the prompt.');
    const register = seeded.sessionService.readStandingConstraints('primary');
    seeded.sessionService.clearStandingConstraints('primary', register.revision);
    await host.prompt('primary');
    expect(entry()).toBeUndefined();
    expect(Exit.isSuccess(await host.executeWithAfter('hive_feature_create', { name: 'alpha' }, caller))).toBe(true);
    expect(Exit.isSuccess(await host.executeWithAfter('hive_feature_select', { feature: 'alpha' }, caller))).toBe(true);
    expect(entry()).toContain('"featureRoute":{"selected":true,"feature":"alpha"}');
    expect(Exit.isSuccess(await host.executeWithAfter('hive_constraints_add', { constraints: 'Prefer small diffs.' }, caller))).toBe(true);
    expect(entry()).toContain('Session constraints (revision 3):\nPrefer small diffs.');
    // A model request writes no entry.
    host.instructionEntries.clear();
    await host.request({ sessionID: 'primary', agent: 'swarm-orchestrator', system: ['x'] });
    await host.request({ kind: 'compaction', sessionID: 'primary', agent: 'swarm-orchestrator', system: ['x'] });
    expect(host.instructionEntries.size).toBe(0);
  });

  it('gives a compaction the same system parts as an ordinary turn, while generate stays minimal', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const readTransport of ['codemode', 'direct'] as const) {
        const host = await activate({ readTransport });
        const cases = [
          { sessionID: 'primary', agent: 'swarm-orchestrator', tools: ['execute', 'read'] },
          { sessionID: 'child', agent: 'scout-researcher', tools: ['execute', 'read'] },
          { sessionID: 'primary', agent: 'hive-helper', tools: ['read'] },
          { sessionID: 'child', agent: 'scout-researcher', tools: ['read'] },
        ];
        for (const request of cases) {
          const label = `${readTransport} ${request.sessionID} ${request.agent} ${request.tools.join('+')}`;
          const turn = await host.request({ ...request, kind: 'context', system: ['HOST PROMPT'] });
          const compaction = await host.request({ ...request, kind: 'compaction', system: ['HOST PROMPT'] });
          const generate = await host.request({ ...request, kind: 'generate', system: ['HOST PROMPT'] });
          expect(compaction, label).toEqual(turn);
          expect(generate, label).toEqual(turn.slice(0, 3));
          // Each case adds what only a turn carries: the clarification rule for a child, the notice without execute.
          const extras = turn.slice(3);
          expect(extras.includes(SUBAGENT_CLARIFICATION_PROMPT.trim()), label).toBe(request.sessionID === 'child');
          expect(extras.some((text) => text.includes('## Hive Read Transport Setup')), label).toBe(readTransport === 'codemode' && !request.tools.includes('execute'));
        }
      }
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
    // The notice names only the reads the role is granted; the guard still decides each call.
    const notice = (parts: string[]) => parts.find((text) => text.includes('## Hive Read Transport Setup')) ?? '';
    const scout = notice(without);
    for (const read of ['hive_repositories_discover', 'hive_checkout_brief', 'hive_worklog_read']) expect(scout).toContain(`\`${read}\``);
    expect(scout).not.toContain('hive_task_trace_content');
    const investigator = notice(await codemode.request({ sessionID: 'child', agent: 'forager-investigator', system: ['x'], tools: ['read'] }));
    expect(investigator).toContain('`hive_checkouts_list`');
    for (const read of ['hive_task_trace_content', 'hive_repositories_discover']) expect(investigator).not.toContain(read);
    expect(notice(await codemode.request({ sessionID: 'primary', agent: 'hive-helper', system: ['x'], tools: ['read'] }))).toContain('`hive_task_trace_content`');
    const withExecute = await codemode.request({ sessionID: 'child', agent: 'scout-researcher', system: ['x'], tools: ['execute'] });
    expect(withExecute.some((text) => text.includes('Read Transport Setup'))).toBe(false);

    const direct = await activate({ readTransport: 'direct' });
    const directParts = await direct.request({ sessionID: 'child', agent: 'scout-researcher', system: ['x'], tools: ['read', 'hive_repositories_status'] });
    expect(directParts.some((text) => text.includes('Read Transport Setup'))).toBe(false);
    expect(direct.tools().get('hive_repositories_status').options.codemode).toBe(false);
    expect(directParts[1]).toContain('are direct tool calls');
  });
});

describe('v2 request tool pruning', () => {
  // Every native tool a broad `"*": "allow"` rule can expose next to the Hive tools, in the names the host reports.
  const NATIVE_TOOLS = ['read', 'edit', 'write', 'patch', 'shell', 'execute', 'question', 'subagent', 'skill',
    'opencode_worktree_create', 'opencode_worktree_remove', 'opencode_session_move', 'opencode_session_interrupt',
    'automation_create', 'automation_resume', 'automation_pause', 'automation_delete', 'automation_list'];
  const OPERATOR_ONLY = ['automation_create', 'automation_resume', 'automation_pause', 'automation_delete', 'opencode_session_interrupt'];
  const LIFECYCLE = ['opencode_worktree_create', 'opencode_worktree_remove', 'opencode_session_move'];
  const SAFE_NATIVE = ['read', 'shell', 'execute', 'skill', 'automation_list'];
  const EDITS = ['edit', 'write', 'patch'];
  const DIRECT_READ_HIVE = ['hive_context_read', 'hive_constraints_read', 'hive_plan_read', 'hive_status'];
  const DIRECT_REVIEW_HIVE = [...DIRECT_READ_HIVE, 'hive_context_write', 'hive_context_append', 'hive_context_edit'];

  async function setup() {
    const host = await activate();
    // Under the default Code Mode transport the Code Mode reads reach the model through `execute`, not `event.tools`.
    const directHive = [...host.tools().entries()].filter(([name, info]) => name.startsWith('hive_') && info.options?.codemode !== true).map(([name]) => name);
    expect(directHive.some((name) => CODEMODE_READ_TOOLS.includes(name))).toBe(false);
    const exposed = [...directHive, ...NATIVE_TOOLS];
    const kept = async (sessionID: string, agent: string, kind: 'context' | 'compaction' | 'generate' = 'context', tools = exposed) =>
      Object.keys((await host.requestDraft({ kind, sessionID, agent, system: ['x'], tools })).tools).sort();
    return { host, exposed, kept };
  }
  const sorted = (names: string[]) => [...new Set(names)].sort();

  it('drops the same tools on context and compaction, leaving identical tools and system parts', async () => {
    const { host, exposed } = await setup();
    const cases = [
      ['primary', 'swarm-orchestrator'], ['primary', 'architect-planner'], ['child', 'architect-planner'], ['child', 'forager-worker'],
      ['child', 'code-reviewer'], ['child', 'general'], ['child', 'explore'], ['primary', 'build'], ['child', 'build'],
    ] as const;
    for (const [sessionID, agent] of cases) {
      const turn = await host.requestDraft({ kind: 'context', sessionID, agent, system: ['HOST PROMPT'], tools: exposed });
      const compaction = await host.requestDraft({ kind: 'compaction', sessionID, agent, system: ['HOST PROMPT'], tools: exposed });
      expect(compaction.tools, `${sessionID} ${agent}`).toEqual(turn.tools);
      expect(compaction.system, `${sessionID} ${agent}`).toEqual(turn.system);
    }
  });

  it('keeps only the direct Hive tools and native tools a forager child may run', async () => {
    const { kept } = await setup();
    const hive = [...DIRECT_REVIEW_HIVE, 'hive_worktree_inspect', 'hive_adhoc_worktree_inspect', 'hive_checkout_inspect', 'hive_task_trace', 'hive_task_update', 'hive_worktree_create'];
    expect(await kept('child', 'forager-worker')).toEqual(sorted([...hive, ...SAFE_NATIVE, ...EDITS]));
    // Dotted names the host can report for namespaced tools are matched by their canonical ID.
    expect(await kept('child', 'forager-worker', 'context', ['read', 'automation.create', 'opencode.session.interrupt', 'hive.plan_approve'])).toEqual(['read']);
  });

  it('drops edits, delegation, questions and ungranted Hive tools for read-only reviewer and scout children', async () => {
    const { kept } = await setup();
    expect(await kept('child', 'code-reviewer')).toEqual(sorted([...DIRECT_REVIEW_HIVE, ...SAFE_NATIVE]));
    expect(await kept('child', 'scout-researcher')).toEqual(sorted([...DIRECT_READ_HIVE, ...SAFE_NATIVE]));
  });

  it('keeps delegation for Architect in both session kinds and drops primary-only tools from its child', async () => {
    const { kept } = await setup();
    const primary = await kept('primary', 'architect-planner');
    for (const name of ['subagent', 'question', 'hive_plan_approve', 'hive_councils_list', 'hive_feature_select', 'hive_feature_create']) expect(primary).toContain(name);
    for (const name of ['hive_worktree_merge', 'hive_task_update', ...EDITS, ...LIFECYCLE, ...OPERATOR_ONLY]) expect(primary).not.toContain(name);
    const child = await kept('child', 'architect-planner');
    expect(child).toEqual(primary.filter((name) => !PRIMARY_ONLY_TOOLS.includes(name)));
    for (const name of ['subagent', 'hive_feature_create', 'hive_plan_write']) expect(child).toContain(name);
  });

  it('drops every Hive tool, delegation, questions and operator tools for native subagents, and edits for explore', async () => {
    const { kept } = await setup();
    const general = await kept('child', 'general');
    expect(general).toEqual(sorted([...SAFE_NATIVE, ...EDITS, ...LIFECYCLE]));
    expect(await kept('child', 'explore')).toEqual(sorted([...SAFE_NATIVE, ...LIFECYCLE]));
  });

  it('leaves an unmanaged primary untouched and drops only child-refused tools from an unmanaged child', async () => {
    const { kept, exposed } = await setup();
    expect(await kept('primary', 'build')).toEqual(sorted(exposed));
    expect(await kept('primary', 'build', 'context', ['automation.create', 'read'])).toEqual(['automation.create', 'read']);
    const child = await kept('child', 'build');
    expect(child).toEqual(sorted(exposed.filter((name) => !PRIMARY_ONLY_TOOLS.includes(name) && !OPERATOR_ONLY.includes(name))));
    for (const name of ['edit', 'subagent', 'hive_status', 'hive_task_update']) expect(child).toContain(name);
  });

  it('leaves the tools of a generate request alone', async () => {
    const { kept, exposed } = await setup();
    expect(await kept('child', 'forager-worker', 'generate')).toEqual(sorted(exposed));
  });

  it('keeps delegation for a role whose task rule denies some agents without a deny-all fallback', () => {
    const policy = createRolePolicy({});
    policy['scout-researcher'] = { ...policy['scout-researcher'], permission: { ...policy['scout-researcher'].permission, task: { 'forager-worker': 'deny' } } };
    const caller = { kind: 'role', role: 'scout-researcher' } as const;
    expect(authorizeNativeCall(policy, { tool: 'subagent', toolInput: { agent: 'code-reviewer' }, caller, isChild: true }).allowed).toBe(true);
    expect(authorizeNativeCall(policy, { tool: 'subagent', toolInput: { agent: 'forager-worker' }, caller, isChild: true }).allowed).toBe(false);
    expect(isToolUnconditionallyDenied(policy, { tool: 'subagent', caller, isChild: true })).toBe(false);
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

  it('keeps a bundled skill whose same-named file on disk the host catalog does not load', async () => {
    // A server started without project configuration does not load this file; only the live catalog knows that.
    const host = await activate({}, undefined, {
      seed: (root) => {
        fs.mkdirSync(path.join(root, '.claude', 'skills', 'verification'), { recursive: true });
        fs.writeFileSync(path.join(root, '.claude', 'skills', 'verification', 'SKILL.md'), '---\nname: verification\ndescription: user copy\n---\nUSER VERIFICATION\n');
      },
    });
    expect(host.skills().get('verification')?.content).not.toBe('USER VERIFICATION');
    expect(host.skills().get('verification')?.name).toBe('verification');
    // When the host does load the user skill, its later source wins on the shared id.
    host.addUserSkill({ id: 'verification', name: 'verification', description: 'user', path: '/user/verification/SKILL.md', content: 'USER VERIFICATION' });
    expect(host.skills().get('verification').content).toBe('USER VERIFICATION');
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
    const host = await activate({}, { council: { groups: { review: { members: ['primary-simplicity', 'code-reviewer'] } } }, customAgents: {
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
    const councilProse = 'use the review group to assess "is this safe?"\nKeep --strict as prose.';
    await Effect.runPromise(commands.get('council').execute({ sessionID: 's1', prompt: { text: councilProse }, delivery: 'steer' }));
    expect(host.prompts[0].text).toContain(`<operator-text>\n${councilProse}\n</operator-text>`);
    // The roster comes from hive_councils_list when the council runs; the command carries none.
    expect(host.prompts[0].text).toContain('skill({ id })` for the catalog entry named "council"');
    expect(host.prompts[0].text).not.toContain('configured-council-rosters');
    expect(host.prompts[0].text).not.toContain('primary-simplicity');
    expect(host.switches).toEqual([]);
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

  it('resolves council rosters from the agents the host has now, with canonical descriptions, for primaries that hold the tool', async () => {
    const host = await activate({}, {
      council: { defaultGroup: 'review', groups: { review: { members: ['primary-simplicity', 'code-reviewer', 'approach-advisor', 'disabled-security', 'security-specialist'] } } },
      customAgents: {
        'primary-simplicity': { baseAgent: 'simplicity-reviewer', description: 'custom simplicity' },
        'disabled-security': { baseAgent: 'vulnerability-reviewer', description: 'disabled security' },
        'security-specialist': { baseAgent: 'vulnerability-reviewer', description: 'security specialist' },
      },
    });
    host.useAgentConfig({ agents: {
      'approach-advisor': { disabled: true },
      'code-reviewer': { description: 'USER REVIEWER DESCRIPTION' },
      'primary-simplicity': { mode: 'primary' },
      'disabled-security': { disabled: true },
    } });
    const call = (agent: string, sessionID = 'primary', args: Record<string, unknown> = {}) => host.execute('hive_councils_list', args, { sessionID, agent });

    const exit = await call('architect-planner');
    expect(Exit.isSuccess(exit)).toBe(true);
    expect((exit as Exit.Success<any>).value.output).toMatchObject({
      selected: 'review', ok: true,
      members: [
        { name: 'code-reviewer', baseAgent: 'code-reviewer', description: expect.not.stringContaining('USER REVIEWER DESCRIPTION') },
        { name: 'security-specialist', baseAgent: 'vulnerability-reviewer', description: 'security specialist' },
      ],
      skipped: [
        { name: 'primary-simplicity', reason: 'not_available' },
        { name: 'approach-advisor', reason: 'not_available' },
        { name: 'disabled-security', reason: 'not_available' },
      ],
    });

    for (const agent of ['hive-master', 'swarm-orchestrator', 'hive-builder', 'dash-reviewer', 'vulnerability-review-primary', 'security-specialist']) {
      const allowed = agent !== 'security-specialist';
      expect(denied(await call(agent)), agent).toBe(allowed ? undefined : 'hive_councils_list is not granted to the vulnerability-reviewer role.');
    }
    for (const agent of ['scout-researcher', 'forager-worker', 'forager-investigator', 'hive-helper', 'plan-reviewer', 'code-reviewer', 'simplicity-reviewer', 'approach-advisor', 'vulnerability-reviewer']) {
      expect(denied(await call(agent, 'child')), agent).toBe(`hive_councils_list is not granted to the ${agent} role.`);
    }
    expect(denied(await call('architect-planner', 'child'))).toBe('hive_councils_list is a primary-only operation and is denied in child sessions.');
    expect(Exit.isSuccess(await host.before({ tool: 'hive_councils_list', sessionID: 'child', agent: 'architect-planner' }))).toBe(false);

    (host.context as any).agent.list = () => Effect.fail(new Error('agent list failed'));
    expect(denied(await call('hive-master', 'primary', { name: 'review' }))).toContain('agent list failed');
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

  it('registers Agent Hive models for the review primaries and switches their commands to them, with native settings winning', async () => {
    const host = await activate({}, {
      agents: {
        'dash-reviewer': { model: 'hive/dash', variant: 'high', autoLoadSkills: ['verification'] },
        'vulnerability-review-primary': { model: 'hive/vuln', autoLoadSkills: ['hive-config'] },
      },
    });
    const { registry } = host.agents();
    for (const id of ['dash-reviewer', 'vulnerability-review-primary']) {
      expect(registry.get(id)!.mode, id).toBe('primary');
      expect(registry.get(id)!.hidden, id).toBe(true);
    }
    for (const [agent, skill] of [['dash-reviewer', 'verification'], ['vulnerability-review-primary', 'hive-config']] as const) {
      const guidance = (await host.request({ sessionID: 's1', agent, system: ['x'], tools: ['read'] })).join('\n');
      expect(guidance.split('skill({ id: "unslop" })').length - 1, agent).toBe(1);
      expect(guidance, agent).toContain(`skill({ id: "${skill}" })`);
    }
    expect(registry.get('dash-reviewer')!.model).toEqual({ providerID: 'hive', id: 'dash', variant: 'high' });
    expect(registry.get('vulnerability-review-primary')!.model).toEqual({ providerID: 'hive', id: 'vuln' });

    host.sessions.set('s1', { id: 's1', agent: 'swarm-orchestrator' });
    await Effect.runPromise(host.commands().get('dash-review').execute({ sessionID: 's1', prompt: { text: 'HEAD' }, delivery: 'steer' }));
    await Effect.runPromise(host.commands().get('vuln-review').execute({ sessionID: 's1', prompt: { text: 'scope' }, delivery: 'steer' }));
    expect(host.modelSwitches).toEqual([
      { sessionID: 's1', model: { providerID: 'hive', id: 'dash', variant: 'high' } },
      { sessionID: 's1', model: { providerID: 'hive', id: 'vuln' } },
    ]);

    host.useAgentConfig({ agents: { 'dash-reviewer': { model: { providerID: 'user', id: 'dash', variant: 'low' } } } });
    await Effect.runPromise(host.commands().get('dash-review').execute({ sessionID: 's1', prompt: { text: 'HEAD' }, delivery: 'steer' }));
    expect(host.modelSwitches.at(-1)).toEqual({ sessionID: 's1', model: { providerID: 'user', id: 'dash', variant: 'low' } });
  });

  it('registers a project-override model for the review primaries without a global Agent Hive file', async () => {
    const host = await activate({}, undefined, { seed: (root) => {
      fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
      fs.writeFileSync(path.join(root, '.hive', 'agent-hive.override.json'), JSON.stringify({ agents: {
        'dash-reviewer': { model: 'project/dash', variant: 'max' },
        'vulnerability-review-primary': { model: 'project/vuln' },
      } }));
    } });
    const { registry } = host.agents();
    expect(registry.get('dash-reviewer')!.model).toEqual({ providerID: 'project', id: 'dash', variant: 'max' });
    expect(registry.get('vulnerability-review-primary')!.model).toEqual({ providerID: 'project', id: 'vuln' });
    expect(registry.get('dash-reviewer')!.hidden).toBe(true);
  });

  it('fails an agent-bound command whose agent the configuration removed, instead of prompting the wrong agent', async () => {
    const host = await activate();
    host.sessions.set('s1', { id: 's1', agent: 'swarm-orchestrator' });
    host.useAgentConfig({ agents: { 'dash-reviewer': { disabled: true } } });
    for (const name of ['dash-review', 'test-audit']) {
      const exit = await Effect.runPromiseExit(host.commands().get(name).execute({ sessionID: 's1', prompt: { text: 'HEAD' }, delivery: 'steer' }));
      expect(denied(exit)).toContain('needs the dash-reviewer agent');
    }
    expect(host.prompts).toEqual([]);
    expect(host.switches).toEqual([]);
  });

  it('renders commands at invocation and switches to a command agent before prompting', async () => {
    const host = await activate();
    const commands = host.commands();
    expect([...commands.keys()].sort()).toEqual(HIVE_COMMANDS.map((command) => command.key).sort());
    host.sessions.set('s1', { id: 's1', agent: 'swarm-orchestrator' });
    await Effect.runPromise(commands.get('test-audit').execute({ sessionID: 's1', prompt: { text: 'packages/api retry tests' }, delivery: 'steer' }));
    expect(host.switches).toEqual([{ sessionID: 's1', agent: 'dash-reviewer' }]);
    expect(host.prompts[0]).toMatchObject({ sessionID: 's1', delivery: 'steer' });
    expect(host.prompts[0].text).toContain('Test audit scope: packages/api retry tests');
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
    // The other unbound operator commands also prompt the session they were run in, on whatever agent it has.
    for (const name of ['sharpen', 'investigate', 'walkthrough', 'handoff', 'merge-to-main']) {
      await Effect.runPromise(commands.get(name).execute({ sessionID: 'i2', prompt: { text: prose }, delivery: 'steer' }));
      expect(host.prompts.at(-1), name).toMatchObject({ sessionID: 'i2', delivery: 'steer' });
      expect(host.prompts.at(-1).text, name).toContain(`Operator text after /${name} (blank when none):\n<operator-text>\n${prose}\n</operator-text>`);
    }
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
