import { afterEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import plugin from './index.js';
import { CUSTOM_AGENT_BASES, PlanService, SessionService, TaskService } from 'hive-core';
import { HIVE_TOOL_NAMES } from './utils/plugin-manifest.js';
import { createPluginWithHome } from './e2e/plugin-test-home.js';
import { TASK_TRACE_SUMMARIZER_AGENT } from './task-trace.js';

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionConfig = Record<string, PermissionAction | Record<string, PermissionAction>>;
type PermissionRule = { permission: string; pattern: string; action: PermissionAction };

// OpenCode v1.18.30: core/util/wildcard.ts and opencode/src/permission/index.ts.
function wildcardMatch(input: string, pattern: string): boolean {
  let escaped = pattern.replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?';
  return new RegExp(`^${escaped}$`, 's').test(input.replaceAll('\\', '/'));
}

function permissionRules(config: PermissionConfig): PermissionRule[] {
  return Object.entries(config).flatMap(([permission, value]) => (
    typeof value === 'string'
      ? [{ permission, pattern: '*', action: value }]
      : Object.entries(value).map(([pattern, action]) => ({ permission, pattern, action }))
  ));
}

function evaluatePermission(permission: string, pattern: string, ...rulesets: (PermissionConfig | PermissionRule[])[]): PermissionAction {
  const rules = rulesets.flatMap((ruleset) => Array.isArray(ruleset) ? ruleset : permissionRules(ruleset));
  return rules.findLast((rule) => wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern))?.action ?? 'ask';
}

// Model OpenCode v1.18.30 agent/subagent-permissions.ts and tool/task.ts for fresh sessions.
// Parent *agent* rules are not inherited; parent *session* denies and external-directory rules are.
function spawnSubagentSessionPermission(parentSession: PermissionRule[], subagent: PermissionConfig, primaryTools: string[]): PermissionRule[] {
  const ownRules = permissionRules(subagent);
  const derived = [
    ...parentSession.filter((rule) => rule.permission === 'external_directory' || rule.action === 'deny'),
    ...['todowrite', 'task'].filter((name) => !ownRules.some((rule) => rule.permission === name))
      .map((permission): PermissionRule => ({ permission, pattern: '*', action: 'deny' })),
  ];
  const primaryDenies = primaryTools.map((permission): PermissionRule => ({ permission, pattern: '*', action: 'deny' }));
  return [...derived, ...primaryDenies.filter((deny) => !derived.some((rule) => (
    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action
  )))];
}

const roots: string[] = [];

function createRuntime(options: { detectedFeature?: string; hiveConfig?: Record<string, unknown>; symlinkedRoot?: boolean } = {}) {
  const root = fs.mkdtempSync(`/tmp/hive-runtime-cutover-${process.pid}-`);
  const home = fs.mkdtempSync(`/tmp/hive-runtime-cutover-home-${process.pid}-`);
  roots.push(root, home);
  fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
  if (options.hiveConfig) {
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'agent_hive.json'), JSON.stringify(options.hiveConfig));
  }
  let workTarget = options.detectedFeature
    ? path.join(root, '.hive', '.worktrees', options.detectedFeature, '01-task')
    : root;
  fs.mkdirSync(workTarget, { recursive: true });
  if (options.symlinkedRoot) {
    const aliases = fs.mkdtempSync(`/tmp/hive-runtime-root-alias-${process.pid}-`);
    roots.push(aliases);
    const alias = path.join(aliases, 'checkout');
    fs.symlinkSync(workTarget, alias);
    workTarget = alias;
  }
  // An Error entry stands for a session lookup that returns an error response.
  const sessions = new Map<string, { id: string; parentID?: string } | Error>();
  const transcripts = new Map<string, unknown[]>();
  const client = {
    session: {
      get: async ({ path: inputPath }: { path: { id: string } }) => {
        const known = sessions.get(inputPath.id);
        return known instanceof Error ? { error: { name: known.message } } : { data: known ?? { id: inputPath.id } };
      },
      messages: async ({ path: inputPath }: { path: { id: string } }) => ({ data: transcripts.get(inputPath.id) ?? [] }),
      status: async () => ({ data: {} }),
      abort: async () => ({ data: true }),
    },
  };
  return {
    root,
    workTarget,
    sessions,
    transcripts,
    hooks: createPluginWithHome(home, () => plugin({ directory: workTarget, worktree: workTarget, project: { id: 'test', worktree: workTarget }, client } as any)),
  };
}

function context(sessionID: string, agent = 'hive-master') {
  return { sessionID, messageID: 'message', agent, abort: new AbortController().signal };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createManifestRepository(root: string, id: string): string {
  const repository = path.join(root, id);
  fs.mkdirSync(repository);
  git(repository, ['init']);
  git(repository, ['config', 'user.email', 'test@example.com']);
  git(repository, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'base\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'test: base']);
  return repository;
}

function writeRepositoryManifest(root: string, entries: string[]): void {
  fs.writeFileSync(path.join(root, '.hive', 'repositories.json'), JSON.stringify({
    schemaVersion: 1,
    repositories: entries.map((id) => ({ id, path: id })),
  }));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('coordinated runtime hard cut', () => {
  it('recovers a malformed global session index during chat.message and tracks the reply session', async () => {
    const { root, hooks } = createRuntime({ hiveConfig: { agents: { 'forager-worker': { variant: 'high' } } } });
    const loaded = await hooks;
    const indexPath = path.join(root, '.hive', 'sessions.json');
    fs.writeFileSync(indexPath, Buffer.alloc(64));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const output: any = { message: { agent: 'forager-worker' }, parts: [] };
      await loaded['chat.message']!({ sessionID: 'recovered-session', agent: 'forager-worker' } as any, output);
      expect(output.message.variant).toBe('high');
      const backups = fs.readdirSync(path.dirname(indexPath)).filter((file) => file.startsWith('sessions.json.corrupt-'));
      expect(backups).toHaveLength(1);
      expect(new SessionService(root).getGlobal('recovered-session')).toMatchObject({ agent: 'forager-worker', projectRoot: root });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('continues the chat.message variant hook when the global session index cannot be recovered', async () => {
    for (const [name, bytes, code] of [
      ['unreadable', null, 'EISDIR'],
      ['backup-collision', Buffer.from('{broken'), 'EEXIST'],
    ] as const) {
      const { root, hooks } = createRuntime({ hiveConfig: { agents: { 'forager-worker': { variant: 'high' } } } });
      const loaded = await hooks;
      const indexPath = path.join(root, '.hive', 'sessions.json');
      if (bytes) {
        fs.writeFileSync(indexPath, bytes);
        setSystemTime(new Date('2026-01-02T03:04:05.678Z'));
        fs.writeFileSync(`${indexPath}.corrupt-2026-01-02T03-04-05-678Z`, 'earlier evidence');
      } else {
        fs.mkdirSync(indexPath);
      }
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const output: any = { message: { agent: 'forager-worker' }, parts: [] };
        await loaded['chat.message']!({ sessionID: `session-${name}`, agent: 'forager-worker' } as any, output);
        expect(output.message.variant).toBe('high');
        if (bytes) {
          expect(fs.readFileSync(indexPath)).toEqual(bytes);
          expect(fs.readFileSync(`${indexPath}.corrupt-2026-01-02T03-04-05-678Z`, 'utf8')).toBe('earlier evidence');
        } else {
          expect(fs.statSync(indexPath).isDirectory()).toBe(true);
        }
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(indexPath);
        expect(warn.mock.calls[0][0]).toContain(`session-${name}`);
        expect(warn.mock.calls[0][0]).toContain(code);
        expect(warn.mock.calls[0][0]).not.toContain('{broken');
      } finally {
        warn.mockRestore();
        setSystemTime();
      }
    }
  });

  it('tracks healthy chat.message sessions and still applies the configured variant', async () => {
    const { root, hooks } = createRuntime({ hiveConfig: { agents: { 'forager-worker': { variant: 'high' } } } });
    const loaded = await hooks;
    const output: any = { message: { agent: 'forager-worker' }, parts: [] };
    await loaded['chat.message']!({ sessionID: 'healthy-session', agent: 'forager-worker' } as any, output);
    expect(output.message.variant).toBe('high');
    expect(new SessionService(root).getGlobal('healthy-session')).toMatchObject({ agent: 'forager-worker', projectRoot: root });
  });

  it('exposes exactly the canonical public tool inventory', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    expect(Object.keys(loaded.tool ?? {}).sort()).toEqual([...HIVE_TOOL_NAMES].sort());
    expect(Object.keys(loaded.tool ?? {})).not.toContain('hive_execution_prepare');
    expect(Object.keys(loaded.tool ?? {})).not.toContain('hive_review_workspace_create');
    expect(loaded).not.toHaveProperty('mcp');
  });

  it('leaves operator-owned MCP configuration unchanged', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const absent: any = {};
    await loaded.config!(absent);
    expect(absent).not.toHaveProperty('mcp');

    const operatorMcp = { operator_docs: { type: 'remote', url: 'https://example.test/mcp' } };
    const configured: any = { mcp: operatorMcp };
    await loaded.config!(configured);
    expect(configured.mcp).toBe(operatorMcp);
  });

  it('snapshots feature routes and constraints at dispatch without requiring preparation', async () => {
    const { root, sessions, hooks } = createRuntime();
    const loaded = await hooks;
    const parent = context('parent');
    const routeStartMarker = '<!-- hive-route-snapshot:start -->';
    const routeEndMarker = '<!-- hive-route-snapshot:end -->';
    const sessionSkillRequirement = 'For both design and writing work, load writing-policy, ivan-writing, and stop-slop.';
    const featureSkillRequirement = 'For design work, also load stop-design-slop.';
    const authoredRequirement = 'Assignment requirement: load writing-for-humans for this handoff.';
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-a' }, parent);
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-b' }, parent);
    await loaded.tool!.hive_feature_select.execute({ feature: 'feature-a' }, parent);
    await loaded.tool!.hive_constraints_add.execute({ scope: 'session', constraints: `${sessionSkillRequirement} Quoted marker: ${routeStartMarker}` }, parent);
    await loaded.tool!.hive_constraints_add.execute({ scope: 'feature', feature: 'feature-a', constraints: `${featureSkillRequirement} Quoted marker: ${routeEndMarker}` }, parent);

    const output = { args: { subagent_type: 'forager-worker', prompt: `AUTHORED PREFIX\n${authoredRequirement}`, background: false } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent', callID: 'call-a' } as any, output);
    expect(output.args.prompt.startsWith('AUTHORED PREFIX')).toBe(true);
    expect(output.args.prompt).toContain(authoredRequirement);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":true,"feature":"feature-a"}');
    expect(output.args.prompt).toContain('## Standing Constraints');
    expect(output.args.prompt).toContain('Session constraints (revision 1)');
    expect(output.args.prompt).toContain('Feature constraints for "feature-a" (revision 1)');
    expect(output.args.prompt).toContain(sessionSkillRequirement);
    expect(output.args.prompt).toContain(featureSkillRequirement);
    expect(output.args.prompt.match(/<!-- hive-route-snapshot:start -->/g)).toHaveLength(1);
    expect(output.args.prompt.match(/<!-- hive-route-snapshot:end -->/g)).toHaveLength(1);
    expect(output.args.prompt).toContain(`&lt;!-- hive-route-snapshot:start -->`);
    expect(output.args.prompt).toContain(`&lt;!-- hive-route-snapshot:end -->`);
    expect(output.args).not.toHaveProperty('hive_launch_id');

    await loaded.tool!.hive_feature_select.execute({ feature: 'feature-b' }, parent);
    sessions.set('child-a', { id: 'child-a', parentID: 'parent' });
    await loaded.event!({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: 'parent', callID: 'call-a', metadata: { sessionId: 'child-a' }, state: { input: output.args } } } } } as any);
    expect(new SessionService(root).getGlobal('child-a')?.featureName).toBe('feature-a');
    expect(new SessionService(root).getGlobal('child-a')?.standingConstraints).toBe(`${sessionSkillRequirement} Quoted marker: ${routeStartMarker}`);
    expect(new SessionService(root).getGlobal('parent')?.featureName).toBe('feature-b');
  });

  it('keeps the selected session route unchanged across explicit feature operations', async () => {
    const { root, hooks } = createRuntime();
    git(root, ['init']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'test: base']);
    const loaded = await hooks;
    const caller = context('multi-plan');
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-a' }, caller);
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-b' }, caller);
    await loaded.tool!.hive_feature_select.execute({ feature: 'feature-a' }, caller);
    const selected = () => new SessionService(root).getGlobal('multi-plan')?.featureName;

    await loaded.tool!.hive_plan_write.execute({ feature: 'feature-b', content: '# Feature B\n' }, caller);
    expect(selected()).toBe('feature-a');
    await loaded.tool!.hive_status.execute({ feature: 'feature-b' }, caller);
    expect(selected()).toBe('feature-a');
    await loaded.tool!.hive_context_write.execute({ feature: 'feature-b', name: 'overview', content: 'B notes' }, caller);
    expect(selected()).toBe('feature-a');
    const task = await loaded.tool!.hive_task_create.execute({ feature: 'feature-b', name: 'B task' }, caller);
    expect(selected()).toBe('feature-a');
    const created = JSON.parse(await loaded.tool!.hive_worktree_create.execute({ feature: 'feature-b', task }, caller));
    expect(selected()).toBe('feature-a');
    expect(created).toEqual(JSON.parse(await loaded.tool!.hive_worktree_inspect.execute({ feature: 'feature-b', task }, caller)));
    expect(created.clean).toBe(true);
    expect(created.target).toEqual({ path: root, ref: git(root, ['symbolic-ref', 'HEAD']), commit: git(root, ['rev-parse', 'HEAD']) });
    expect(created.comparison).toEqual({ status: 'ok', targetIsAncestorOfSource: true });
    expect(selected()).toBe('feature-a');
    await loaded.tool!.hive_worktree_cleanup.execute({ feature: 'feature-b', task, discard: true }, caller);
    expect(selected()).toBe('feature-a');

    await loaded.tool!.hive_feature_create.execute({ name: 'feature-c' }, caller);
    expect(selected()).toBe('feature-a');
    await loaded.tool!.hive_plan_write.execute({ content: '# Feature A\n' }, caller);
    expect(JSON.parse(await loaded.tool!.hive_plan_read.execute({}, caller)).content).toBe('# Feature A\n');
    expect(JSON.parse(await loaded.tool!.hive_plan_read.execute({ feature: 'feature-b' }, caller)).content).toBe('# Feature B\n');
  });

  it('changes omitted resolution and child snapshots only through feature selection', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('select-route');
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-a' }, caller);
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-b' }, caller);
    await loaded.tool!.hive_plan_write.execute({ feature: 'feature-a', content: '# A\n' }, caller);
    await loaded.tool!.hive_plan_write.execute({ feature: 'feature-b', content: '# B\n' }, caller);

    await loaded.tool!.hive_feature_select.execute({ feature: 'feature-b' }, caller);
    expect(JSON.parse(await loaded.tool!.hive_plan_read.execute({}, caller)).content).toBe('# B\n');
    const output = { args: { subagent_type: 'forager-worker', prompt: 'Run.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'select-route', callID: 'selected-b' } as any, output);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":true,"feature":"feature-b"}');
  });

  it('uses the selected route for omitted parent and bound-child calls before detected context', async () => {
    const { root, hooks } = createRuntime({ detectedFeature: 'feature-b' });
    const loaded = await hooks;
    const caller = context('detected-route');
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-a' }, caller);
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-b' }, caller);
    await loaded.tool!.hive_plan_write.execute({ feature: 'feature-a', content: '# Selected A\n' }, caller);
    await loaded.tool!.hive_constraints_add.execute({ scope: 'feature', feature: 'feature-a', constraints: 'Use feature A.' }, caller);
    await loaded.tool!.hive_constraints_add.execute({ scope: 'feature', feature: 'feature-b', constraints: 'Use feature B.' }, caller);
    await loaded.tool!.hive_feature_select.execute({ feature: 'feature-a' }, caller);

    expect(JSON.parse(await loaded.tool!.hive_plan_read.execute({}, caller)).content).toBe('# Selected A\n');
    await loaded.tool!.hive_plan_write.execute({ feature: 'feature-b', content: '# Explicit B\n' }, caller);
    expect(JSON.parse(await loaded.tool!.hive_plan_read.execute({ feature: 'feature-b' }, caller)).content).toBe('# Explicit B\n');
    expect(new SessionService(root).getGlobal('detected-route')?.featureName).toBe('feature-a');
    const output = { args: { subagent_type: 'forager-worker', prompt: 'Run.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'detected-route', callID: 'selected-a' } as any, output);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":true,"feature":"feature-a"}');
    expect(output.args.prompt).toContain('Feature constraints for "feature-a" (revision 1)');
    expect(output.args.prompt).toContain('Use feature A.');
    expect(output.args.prompt).not.toContain('Use feature B.');
    await loaded['tool.execute.after']!({ tool: 'task', sessionID: 'detected-route', callID: 'selected-a', args: output.args } as any, { metadata: { sessionId: 'child-selected-a' } } as any);
    expect(new SessionService(root).getGlobal('child-selected-a')?.featureName).toBe('feature-a');
    expect(JSON.parse(await loaded.tool!.hive_plan_read.execute({}, context('child-selected-a', 'forager-worker'))).content).toBe('# Selected A\n');
  });

  it('uses explicit null before detected context for parent and bound-child calls', async () => {
    const { root, hooks } = createRuntime({ detectedFeature: 'feature-b' });
    const loaded = await hooks;
    const caller = context('detected-null-route');
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-b' }, caller);
    await loaded.tool!.hive_constraints_add.execute({ scope: 'feature', feature: 'feature-b', constraints: 'Use feature B.' }, caller);
    await loaded.tool!.hive_feature_select.execute({ feature: null }, caller);

    await expect(loaded.tool!.hive_plan_read.execute({}, caller)).rejects.toThrow('Feature is required');
    const output = { args: { subagent_type: 'forager-worker', prompt: 'Run.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'detected-null-route', callID: 'selected-null' } as any, output);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":true,"feature":null}');
    expect(output.args.prompt).toContain('Feature constraints: (none)');
    expect(output.args.prompt).not.toContain('Use feature B.');
    await loaded['tool.execute.after']!({ tool: 'task', sessionID: 'detected-null-route', callID: 'selected-null', args: output.args } as any, { metadata: { sessionId: 'child-selected-null' } } as any);
    const stored = new SessionService(root).getGlobal('child-selected-null')!;
    expect(Object.prototype.hasOwnProperty.call(stored, 'featureName')).toBe(true);
    expect(stored.featureName).toBeNull();
    await expect(loaded.tool!.hive_plan_read.execute({}, context('child-selected-null', 'forager-worker'))).rejects.toThrow('Feature is required');
  });

  it('captures an unselected detected route without persisting it to the child', async () => {
    const { root, hooks } = createRuntime({ detectedFeature: 'feature-b' });
    const loaded = await hooks;
    const caller = context('detected-unselected');
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-b' }, caller);
    await loaded.tool!.hive_plan_write.execute({ content: '# Detected B\n' }, caller);
    await loaded.tool!.hive_constraints_add.execute({ scope: 'feature', constraints: 'Use feature B.' }, caller);

    expect(JSON.parse(await loaded.tool!.hive_plan_read.execute({}, caller)).content).toBe('# Detected B\n');
    const output = { args: { subagent_type: 'forager-worker', prompt: 'Run.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'detected-unselected', callID: 'detected-b' } as any, output);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":false,"feature":"feature-b"}');
    expect(output.args.prompt).toContain('Feature constraints for "feature-b" (revision 1)');
    expect(output.args.prompt).toContain('Use feature B.');
    await loaded['tool.execute.after']!({ tool: 'task', sessionID: 'detected-unselected', callID: 'detected-b', args: output.args } as any, { metadata: { sessionId: 'child-detected-b' } } as any);
    expect(new SessionService(root).getGlobal('child-detected-b')).not.toHaveProperty('featureName');
    expect(JSON.parse(await loaded.tool!.hive_plan_read.execute({}, context('child-detected-b', 'forager-worker'))).content).toBe('# Detected B\n');
  });

  it('replaces stale route snapshots idempotently while preserving authored comments', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const parent = context('parent-idempotent');
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-a' }, parent);
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-b' }, parent);
    await loaded.tool!.hive_feature_select.execute({ feature: 'feature-a' }, parent);

    const staleSnapshot = [
      '<!-- hive-route-snapshot:start -->',
      '## Hive route snapshot',
      'stale route snapshot',
      '<!-- hive-route-snapshot:end -->',
    ].join('\n');
    const authoredRequirement = 'Assignment requirement: load writing-for-humans for this handoff.';
    const output = {
      args: {
        subagent_type: 'forager-worker',
        prompt: `${authoredRequirement}\nAUTHORED PREFIX\n<!-- ordinary HTML comment -->\n${staleSnapshot}\n\n${staleSnapshot}\n\nAUTHORED SUFFIX`,
      },
    };

    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-idempotent', callID: 'call-a' } as any, output);
    expect(output.args.prompt.match(/<!-- hive-route-snapshot:start -->/g)).toHaveLength(1);
    expect(output.args.prompt).toContain('AUTHORED PREFIX');
    expect(output.args.prompt).toContain('AUTHORED SUFFIX');
    expect(output.args.prompt).toContain(authoredRequirement);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":true,"feature":"feature-a"}');
    expect(output.args.prompt).toContain('<!-- ordinary HTML comment -->');

    const firstPrompt = output.args.prompt;
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-idempotent', callID: 'call-a' } as any, output);
    expect(output.args.prompt).toBe(firstPrompt);
    expect(output.args.prompt.match(/<!-- hive-route-snapshot:start -->/g)).toHaveLength(1);

    await loaded.tool!.hive_feature_select.execute({ feature: 'feature-b' }, parent);
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-idempotent', callID: 'call-b' } as any, output);
    expect(output.args.prompt.match(/<!-- hive-route-snapshot:start -->/g)).toHaveLength(1);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":true,"feature":"feature-b"}');
    expect(output.args.prompt).not.toContain('"featureRoute":{"selected":true,"feature":"feature-a"}');
  });

  it('preserves authored text around malformed route snapshots', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const staleSnapshot = [
      '<!-- hive-route-snapshot:start -->',
      '## Hive route snapshot',
      'stale route snapshot',
      '<!-- hive-route-snapshot:end -->',
    ].join('\n');
    const malformedPrefix = [
      'AUTHORED BEFORE',
      '<!-- hive-route-snapshot:start -->',
      'MALFORMED MARKER-LIKE AUTHORED TEXT',
      'AUTHORED BETWEEN',
    ].join('\n');
    const malformedSuffix = 'AUTHORED AFTER';
    const authoredBase = `${malformedPrefix}\n\n${malformedSuffix}`;
    const malformedOutput = {
      args: {
        subagent_type: 'forager-worker',
        prompt: `${malformedPrefix}\n${staleSnapshot}\n${malformedSuffix}`,
      },
    };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-idempotent', callID: 'call-malformed' } as any, malformedOutput);
    const generatedStart = malformedOutput.args.prompt.lastIndexOf('<!-- hive-route-snapshot:start -->');
    expect(malformedOutput.args.prompt.slice(0, generatedStart - 2)).toBe(authoredBase);
    expect(malformedOutput.args.prompt).not.toContain('stale route snapshot');

    const firstPrompt = malformedOutput.args.prompt;
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-idempotent', callID: 'call-malformed' } as any, malformedOutput);
    expect(malformedOutput.args.prompt).toBe(firstPrompt);
  });

  it('keeps empty and block-only prompts separator-free and stable', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const staleSnapshot = [
      '<!-- hive-route-snapshot:start -->',
      '## Hive route snapshot',
      'stale route snapshot',
      '<!-- hive-route-snapshot:end -->',
    ].join('\n');
    const emptyOutput = { args: { subagent_type: 'forager-worker', prompt: '' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'empty-prompt', callID: 'empty' } as any, emptyOutput);
    expect(emptyOutput.args.prompt.startsWith('<!-- hive-route-snapshot:start -->')).toBe(true);
    expect(emptyOutput.args.prompt.match(/<!-- hive-route-snapshot:start -->/g)).toHaveLength(1);
    expect(emptyOutput.args.prompt.match(/<!-- hive-route-snapshot:end -->/g)).toHaveLength(1);
    const firstEmptyPrompt = emptyOutput.args.prompt;
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'empty-prompt', callID: 'empty' } as any, emptyOutput);
    expect(emptyOutput.args.prompt).toBe(firstEmptyPrompt);

    const blockOnlyOutput = {
      args: {
        subagent_type: 'forager-worker',
        prompt: staleSnapshot,
      },
    };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'empty-prompt', callID: 'block-only' } as any, blockOnlyOutput);
    expect(blockOnlyOutput.args.prompt.startsWith('<!-- hive-route-snapshot:start -->')).toBe(true);
    expect(blockOnlyOutput.args.prompt.match(/<!-- hive-route-snapshot:start -->/g)).toHaveLength(1);
    expect(blockOnlyOutput.args.prompt.match(/<!-- hive-route-snapshot:end -->/g)).toHaveLength(1);
    const firstBlockOnlyPrompt = blockOnlyOutput.args.prompt;
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'empty-prompt', callID: 'block-only' } as any, blockOnlyOutput);
    expect(blockOnlyOutput.args.prompt).toBe(firstBlockOnlyPrompt);
  });

  it('dispatches a stored indexed directory alias with feature constraints', async () => {
    const { root, sessions, hooks } = createRuntime();
    const featureAlias = '03_dagster-product-lifecycle';
    fs.mkdirSync(path.join(root, '.hive', 'features', featureAlias), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.hive', 'features', featureAlias, 'feature.json'),
      JSON.stringify({ name: 'dagster-product-lifecycle', status: 'executing', createdAt: new Date().toISOString() }),
    );
    const loaded = await hooks;
    const parent = context('parent-legacy');
    await loaded.tool!.hive_feature_select.execute({ feature: featureAlias }, parent);
    await loaded.tool!.hive_constraints_add.execute(
      { scope: 'feature', feature: featureAlias, constraints: 'Keep legacy routing.' },
      parent,
    );

    const output = { args: { subagent_type: 'forager-worker', prompt: 'Run.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-legacy', callID: 'call-legacy' } as any, output);

    expect(output.args.prompt).toContain(`Feature constraints for "${featureAlias}"`);
    expect(output.args.prompt).toContain('Keep legacy routing.');
    sessions.set('child-legacy', { id: 'child-legacy', parentID: 'parent-legacy' });
    await loaded.event!({ event: { type: 'message.part.updated', properties: { part: {
      type: 'tool',
      tool: 'task',
      sessionID: 'parent-legacy',
      callID: 'call-legacy',
      metadata: { sessionId: 'child-legacy' },
      state: { input: output.args },
    } } } } as any);

    expect(new SessionService(root).getGlobal('child-legacy')?.featureName).toBe(featureAlias);
  });

  it('suppresses sole-live dispatch fallback for an explicit null route', async () => {
    const { root, sessions, hooks } = createRuntime();
    const loaded = await hooks;
    const parent = context('parent-null');
    await loaded.tool!.hive_feature_create.execute({ name: 'only-live' }, parent);
    await loaded.tool!.hive_constraints_add.execute({ scope: 'feature', feature: 'only-live', constraints: 'Use only-live.' }, parent);
    await loaded.tool!.hive_feature_select.execute({ feature: null }, parent);
    const output = { args: { subagent_type: 'scout-researcher', prompt: 'Inspect.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-null', callID: 'call-null' } as any, output);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":true,"feature":null}');
    expect(output.args.prompt).toContain('Feature constraints: (none)');
    expect(output.args.prompt).not.toContain('Use only-live.');
    sessions.set('child-null', { id: 'child-null', parentID: 'parent-null' });
    await loaded.event!({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: 'parent-null', callID: 'call-null', metadata: { sessionId: 'child-null' }, state: { input: output.args } } } } } as any);
    const stored = new SessionService(root).getGlobal('child-null')!;
    expect(Object.prototype.hasOwnProperty.call(stored, 'featureName')).toBe(true);
    expect(stored.featureName).toBeNull();
  });

  it('captures the same sole-live fallback used by feature tools', async () => {
    const { root, hooks } = createRuntime();
    const loaded = await hooks;
    await loaded.tool!.hive_feature_create.execute({ name: 'sole-live' }, context('creator'));
    await loaded.tool!.hive_constraints_add.execute({ scope: 'feature', feature: 'sole-live', constraints: 'Use sole-live.' }, context('creator'));
    expect(JSON.parse(await loaded.tool!.hive_status.execute({}, context('unbound'))).feature.name).toBe('sole-live');
    const output = { args: { subagent_type: 'scout-researcher', prompt: 'Inspect.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'unbound', callID: 'sole-call' } as any, output);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":false,"feature":"sole-live"}');
    expect(output.args.prompt).toContain('Feature constraints for "sole-live" (revision 1)');
    expect(output.args.prompt).toContain('Use sole-live.');
    await loaded['tool.execute.after']!({ tool: 'task', sessionID: 'unbound', callID: 'sole-call', args: output.args } as any, { metadata: { sessionId: 'child-sole-live' } } as any);
    expect(new SessionService(root).getGlobal('child-sole-live')).not.toHaveProperty('featureName');
  });

  it('captures an effective null route when no feature fallback exists', async () => {
    const { root, hooks } = createRuntime();
    const loaded = await hooks;
    const output = { args: { subagent_type: 'scout-researcher', prompt: 'Inspect.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'unbound', callID: 'no-feature' } as any, output);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":false,"feature":null}');
    await loaded['tool.execute.after']!({ tool: 'task', sessionID: 'unbound', callID: 'no-feature', args: output.args } as any, { metadata: { sessionId: 'child-no-feature' } } as any);
    expect(new SessionService(root).getGlobal('child-no-feature')).not.toHaveProperty('featureName');
  });

  it('accepts a matching scalar pin for a persisted singleton ad-hoc composite', async () => {
    const runtime = createRuntime();
    createManifestRepository(runtime.root, 'api');
    writeRepositoryManifest(runtime.root, ['api']);
    const loaded = await runtime.hooks;

    const created = JSON.parse(await loaded.tool!.hive_adhoc_worktree_create.execute({
      runId: 'singleton-adhoc',
      repoIds: ['api'],
    }, {}));
    expect(created).toEqual(JSON.parse(await loaded.tool!.hive_adhoc_worktree_inspect.execute({ runId: created.runId }, {})));
    expect(created.clean).toBe(true);
    expect(created.repos.api).toMatchObject({ clean: true, target: { path: path.join(runtime.root, 'api'), ref: git(path.join(runtime.root, 'api'), ['symbolic-ref', 'HEAD']), commit: created.repos.api.commit }, comparison: { status: 'ok', targetIsAncestorOfSource: true } });
    const sourcePath = created.repos.api.path;
    fs.writeFileSync(path.join(sourcePath, 'tracked.txt'), 'changed\n');
    git(sourcePath, ['add', '.']);
    git(sourcePath, ['commit', '-m', 'test: singleton source']);
    const inspected = JSON.parse(await loaded.tool!.hive_adhoc_worktree_inspect.execute({ runId: 'singleton-adhoc' }, {}));

    const result = JSON.parse(await loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'singleton-adhoc',
      sourceCommit: inspected.repos.api.commit,
      expectedTarget: inspected.repos.api.target,
      message: 'test: merge singleton source\n\nMerge the persisted singleton candidate.',
      cleanup: 'worktree+branch',
    }, {}));

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(runtime.root, 'api', 'tracked.txt'), 'utf8')).toBe('changed\n');
  });

  it('accepts a matching scalar pin for a persisted singleton feature composite', async () => {
    const runtime = createRuntime();
    createManifestRepository(runtime.root, 'api');
    writeRepositoryManifest(runtime.root, ['api']);
    const loaded = await runtime.hooks;
    const caller = context('singleton-feature');
    await loaded.tool!.hive_feature_create.execute({ name: 'singleton-feature' }, caller);
    const task = await loaded.tool!.hive_task_create.execute({ feature: 'singleton-feature', name: 'Change source', repos: ['api'] }, caller);

    const created = JSON.parse(await loaded.tool!.hive_worktree_create.execute({ feature: 'singleton-feature', task }, caller));
    expect(created).toEqual(JSON.parse(await loaded.tool!.hive_worktree_inspect.execute({ feature: 'singleton-feature', task }, caller)));
    expect(created.clean).toBe(true);
    expect(created.repos.api).toMatchObject({ clean: true, target: { path: path.join(runtime.root, 'api'), ref: git(path.join(runtime.root, 'api'), ['symbolic-ref', 'HEAD']), commit: created.repos.api.commit }, comparison: { status: 'ok', targetIsAncestorOfSource: true } });
    const sourcePath = created.repos.api.path;
    fs.writeFileSync(path.join(sourcePath, 'tracked.txt'), 'feature changed\n');
    git(sourcePath, ['add', '.']);
    git(sourcePath, ['commit', '-m', 'test: feature singleton source']);
    const inspected = JSON.parse(await loaded.tool!.hive_worktree_inspect.execute({ feature: 'singleton-feature', task }, caller));

    const result = JSON.parse(await loaded.tool!.hive_worktree_merge.execute({
      feature: 'singleton-feature',
      task,
      sourceCommit: inspected.repos.api.commit,
      expectedTarget: inspected.repos.api.target,
      message: 'test: merge feature singleton source\n\nMerge the persisted singleton feature candidate.',
      cleanup: 'worktree+branch',
    }, caller));

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(runtime.root, 'api', 'tracked.txt'), 'utf8')).toBe('feature changed\n');
  });

  it('normalizes symlinked active-project sourceDirectory before combining repoIds', async () => {
    const { root, workTarget, hooks } = createRuntime({ symlinkedRoot: true });
    createManifestRepository(root, 'api');
    writeRepositoryManifest(root, ['api']);
    const loaded = await hooks;
    for (const [index, sourceDirectory] of [workTarget, root].entries()) {
      const created = JSON.parse(await loaded.tool!.hive_adhoc_worktree_create.execute({
        runId: `aliased-root-${index}`,
        sourceDirectory,
        repoIds: ['api'],
      }, {}));
      expect(created).toMatchObject({
        mode: 'adhoc-composite',
        path: path.join(root, '.hive', '.worktrees', 'adhoc', `aliased-root-${index}`),
      });
      expect(Object.keys(created.repos)).toEqual(['api']);
    }
  });

  it('reports missing composite metadata on child worktree calls without selecting the non-Git project root', async () => {
    const { root, hooks } = createRuntime();
    const api = createManifestRepository(root, 'api');
    createManifestRepository(root, 'web');
    writeRepositoryManifest(root, ['api', 'web']);
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
    const loaded = await hooks;
    const parent = context('manifest-parent');
    await loaded.tool!.hive_feature_create.execute({ name: 'manifest-feature' }, parent);
    await loaded.tool!.hive_feature_create.execute({ name: 'other-feature' }, parent);
    await loaded.tool!.hive_feature_select.execute({ feature: 'manifest-feature' }, parent);
    const task = await loaded.tool!.hive_task_create.execute({ name: 'Change source', repos: ['api'] }, parent);
    const created = JSON.parse(await loaded.tool!.hive_worktree_create.execute({ task }, parent));
    const head = git(api, ['rev-parse', 'HEAD']);
    const dispatch = { args: { subagent_type: 'hive-helper', prompt: 'Inspect the task worktree.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'manifest-parent', callID: 'manifest-call' } as any, dispatch);
    await loaded.tool!.hive_feature_select.execute({ feature: 'other-feature' }, parent);
    await loaded.event!({ event: { type: 'message.part.updated', properties: { part: {
      type: 'tool', tool: 'task', sessionID: 'manifest-parent', callID: 'manifest-call',
      metadata: { sessionId: 'manifest-child' }, state: { input: dispatch.args },
    } } } } as any);
    const child = context('manifest-child', 'hive-helper');
    expect(new SessionService(root).getGlobal('manifest-child')).toMatchObject({ projectRoot: root, featureName: 'manifest-feature' });

    for (const selectors of [{ task: '01' }, { task, repoIds: ['api'], candidate: task }]) {
      await expect(loaded.tool!.hive_worktree_inspect.execute(selectors, child)).rejects.toThrow('Composite workspace manifest not found');
      await expect(loaded.tool!.hive_worktree_merge.execute(selectors, child)).rejects.toThrow('Composite workspace manifest not found');
      await expect(loaded.tool!.hive_worktree_cleanup.execute({ ...selectors, deleteBranch: true, discard: true }, child)).rejects.toThrow('Composite workspace manifest not found');
    }
    await expect(loaded.tool!.hive_adhoc_worktree_inspect.execute({ runId: 'missing-run' }, child)).rejects.toThrow('Composite workspace manifest not found');
    const inspected = JSON.parse(await loaded.tool!.hive_worktree_inspect.execute({ task }, child));
    expect(inspected).toMatchObject({ path: created.path, mode: 'composite', repos: { api: { commit: head } } });
    expect(new SessionService(root).getGlobal('manifest-child')?.featureName).toBe('manifest-feature');

    const cleaned = JSON.parse(await loaded.tool!.hive_worktree_cleanup.execute({ task, deleteBranch: true, discard: true }, child));
    expect(cleaned.cleanup.outcome).toBe('complete');
    await expect(loaded.tool!.hive_worktree_cleanup.execute({ task, deleteBranch: true }, child)).rejects.toThrow('Composite workspace manifest not found');

    // A leftover generated directory is invalid placement, not a legacy Git worktree.
    const residualFile = path.join(created.path, 'repos', 'api', '.tmp', 'retained.txt');
    fs.mkdirSync(path.dirname(residualFile), { recursive: true });
    fs.writeFileSync(residualFile, 'retained\n');
    const healthyTask = await loaded.tool!.hive_task_create.execute({ name: 'Keep readable', repos: ['api'] }, child);
    const healthy = JSON.parse(await loaded.tool!.hive_worktree_create.execute({ task: healthyTask }, child));
    const status = JSON.parse(await loaded.tool!.hive_status.execute({}, child));
    expect(status.feature.name).toBe('manifest-feature');
    expect(status.tasks.map((entry: any) => entry.folder)).toEqual([task, healthyTask]);
    expect(status.runnable).toEqual([task, healthyTask]);
    expect(status.worktrees.map((entry: any) => entry.path)).toEqual([healthy.path]);
    expect(status.worktreeErrors).toEqual([{
      path: created.path,
      reason: expect.stringContaining('Composite workspace manifest not found'),
    }]);
    expect(status.feature).not.toHaveProperty('tasks');
    const written = JSON.parse(await loaded.tool!.hive_plan_write.execute({ content: '# Plan\n\n## Tasks\n\n### 1. Change source\n\nChange source.\n' }, child));
    fs.rmSync(path.join(path.dirname(written.path), 'tasks', task, 'status.json'));
    const degraded = JSON.parse(await loaded.tool!.hive_status.execute({}, child));
    expect(degraded.tasks.find((entry: any) => entry.folder === task)).toMatchObject({ status: null, integrity: { reason: 'status_missing' } });
    expect(degraded.worktreeErrors).toEqual(status.worktreeErrors);
    expect(degraded.worktrees.map((entry: any) => entry.path)).toEqual([healthy.path]);
    expect(degraded.runnable).toEqual([healthyTask]);
    expect(fs.readFileSync(residualFile, 'utf8')).toBe('retained\n');
    expect(git(api, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('accepts singleton maps and rejects stale or ambiguous pins before mutation', async () => {
    const runtime = createRuntime();
    const repository = createManifestRepository(runtime.root, 'api');
    writeRepositoryManifest(runtime.root, ['api']);
    const loaded = await runtime.hooks;
    const created = JSON.parse(await loaded.tool!.hive_adhoc_worktree_create.execute({ runId: 'pin-validation', repoIds: ['api'] }, {}));
    const sourcePath = created.repos.api.path;
    const staleCommit = created.repos.api.commit;
    fs.writeFileSync(path.join(sourcePath, 'tracked.txt'), 'pin changed\n');
    git(sourcePath, ['add', '.']);
    git(sourcePath, ['commit', '-m', 'test: pin validation source']);
    const inspected = JSON.parse(await loaded.tool!.hive_adhoc_worktree_inspect.execute({ runId: 'pin-validation' }, {}));
    const targetBefore = git(repository, ['rev-parse', 'HEAD']);

    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({ runId: 'pin-validation', sourceCommit: staleCommit }, {})).rejects.toThrow(/does not match/);
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(targetBefore);
    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'pin-validation',
      sourceCommit: inspected.repos.api.commit,
      sourceCommits: { api: inspected.repos.api.commit },
      expectedTargets: { api: inspected.repos.api.target },
    }, {})).rejects.toThrow(/both/);

    const result = JSON.parse(await loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'pin-validation',
      sourceCommits: { api: inspected.repos.api.commit },
      expectedTargets: { api: inspected.repos.api.target },
      message: 'test: merge singleton map\n\nMerge the exact singleton map.',
      cleanup: 'worktree+branch',
    }, {}));
    expect(result.success).toBe(true);
  });

  it('rejects scalar pins for multi-repository composites', async () => {
    const runtime = createRuntime();
    const api = createManifestRepository(runtime.root, 'api');
    const web = createManifestRepository(runtime.root, 'web');
    writeRepositoryManifest(runtime.root, ['api', 'web']);
    const loaded = await runtime.hooks;
    const created = JSON.parse(await loaded.tool!.hive_adhoc_worktree_create.execute({ runId: 'multi-pin', repoIds: ['api', 'web'] }, {}));
    expect(created).toEqual(JSON.parse(await loaded.tool!.hive_adhoc_worktree_inspect.execute({ runId: created.runId }, {})));
    expect(Object.values(created.repos).every((repo: any) => repo.clean && repo.target && repo.comparison.status === 'ok')).toBe(true);
    const targetBefore = { api: git(api, ['rev-parse', 'HEAD']), web: git(web, ['rev-parse', 'HEAD']) };

    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'multi-pin',
      sourceCommit: created.repos.api.commit,
    }, {})).rejects.toThrow(/cannot select a composite candidate/);
    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'multi-pin',
      sourceCommits: { api: created.repos.api.commit },
    }, {})).rejects.toThrow(/exactly match/);
    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'multi-pin',
      sourceCommits: { api: created.repos.api.commit, web: created.repos.web.commit, extra: 'sha' },
    }, {})).rejects.toThrow(/exactly match/);
    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'multi-pin',
      sourceCommits: { api: 'stale', web: created.repos.web.commit },
    }, {})).rejects.toThrow(/exactly match/);
    expect({ api: git(api, ['rev-parse', 'HEAD']), web: git(web, ['rev-parse', 'HEAD']) }).toEqual(targetBefore);
  });

  it('keeps legacy single-root pin validation unchanged', async () => {
    const runtime = createRuntime();
    git(runtime.root, ['init']);
    git(runtime.root, ['config', 'user.email', 'test@example.com']);
    git(runtime.root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(runtime.root, 'tracked.txt'), 'base\n');
    git(runtime.root, ['add', '.']);
    git(runtime.root, ['commit', '-m', 'test: legacy base']);
    const loaded = await runtime.hooks;
    const created = JSON.parse(await loaded.tool!.hive_adhoc_worktree_create.execute({ runId: 'legacy-pin' }, {}));
    expect(created).toEqual(JSON.parse(await loaded.tool!.hive_adhoc_worktree_inspect.execute({ runId: created.runId }, {})));
    expect(created.clean).toBe(true);
    expect(created.target).toEqual({ path: runtime.root, ref: git(runtime.root, ['symbolic-ref', 'HEAD']), commit: created.commit });
    expect(created.comparison).toEqual({ status: 'ok', targetIsAncestorOfSource: true });

    // Reuse must inspect current dirt and detached targets, not report the original creation state.
    fs.writeFileSync(path.join(created.path, 'untracked.txt'), 'retained work\n');
    git(runtime.root, ['checkout', '--detach']);
    const reused = JSON.parse(await loaded.tool!.hive_adhoc_worktree_create.execute({ runId: created.runId }, {}));
    expect(reused).toEqual(JSON.parse(await loaded.tool!.hive_adhoc_worktree_inspect.execute({ runId: created.runId }, {})));
    expect(reused.clean).toBe(false);
    expect(reused.target).toEqual({ path: runtime.root, ref: null, commit: created.commit });
    fs.rmSync(path.join(created.path, 'untracked.txt'));

    await expect(loaded.tool!.hive_adhoc_worktree_merge.execute({ runId: 'legacy-pin', sourceCommits: { root: created.commit } }, {})).rejects.toThrow(/require a composite candidate/);
    fs.writeFileSync(path.join(created.path, 'tracked.txt'), 'legacy changed\n');
    git(created.path, ['add', '.']);
    git(created.path, ['commit', '-m', 'test: legacy source']);
    const inspected = JSON.parse(await loaded.tool!.hive_adhoc_worktree_inspect.execute({ runId: 'legacy-pin' }, {}));
    const result = JSON.parse(await loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: 'legacy-pin',
      sourceCommit: inspected.commit,
      expectedTarget: inspected.target,
      message: 'test: merge legacy source\n\nMerge the exact legacy pin.',
      cleanup: 'worktree+branch',
    }, {}));

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(runtime.root, 'tracked.txt'), 'utf8')).toBe('legacy changed\n');
  });

  it('passes target expectations unchanged and rejects an omitted expectation', async () => {
    const runtime = createRuntime();
    git(runtime.root, ['init']);
    git(runtime.root, ['config', 'user.email', 'test@example.com']);
    git(runtime.root, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(runtime.root, 'tracked.txt'), 'base\n');
    git(runtime.root, ['add', '.']);
    git(runtime.root, ['commit', '-m', 'test: target forwarding base']);
    const loaded = await runtime.hooks;
    const created = JSON.parse(await loaded.tool!.hive_adhoc_worktree_create.execute({ runId: 'target-forwarding' }, {}));
    const inspected = JSON.parse(await loaded.tool!.hive_adhoc_worktree_inspect.execute({ runId: created.runId }, {}));

    const missing = JSON.parse(await loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: created.runId,
      sourceCommit: inspected.commit,
    }, {}));
    expect(missing).toMatchObject({ success: false, reasonCode: 'INVALID_ARGUMENTS' });

    const callerTarget = { ...inspected.target, ref: 'refs/heads/not-the-target' };
    const mismatch = JSON.parse(await loaded.tool!.hive_adhoc_worktree_merge.execute({
      runId: created.runId,
      sourceCommit: inspected.commit,
      expectedTarget: callerTarget,
    }, {}));
    expect(mismatch).toMatchObject({
      success: false,
      reasonCode: 'TARGET_MISMATCH',
      expectedTarget: callerTarget,
      observedTarget: inspected.target,
    });
  });

  it('binds the same complete snapshot when the after hook arrives before the event hook', async () => {
    const { root, hooks } = createRuntime();
    const loaded = await hooks;
    const parent = context('parent-after');
    await loaded.tool!.hive_feature_create.execute({ name: 'feature-after' }, parent);
    await loaded.tool!.hive_feature_select.execute({ feature: 'feature-after' }, parent);
    await loaded.tool!.hive_constraints_add.execute({ constraints: 'Captured once.' }, parent);
    const output = { args: { subagent_type: 'forager-worker', prompt: 'Run.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-after', callID: 'call-after' } as any, output);
    await loaded['tool.execute.after']!({ tool: 'task', sessionID: 'parent-after', callID: 'call-after', args: output.args } as any, { metadata: { sessionId: 'child-after' } } as any);
    await loaded.tool!.hive_feature_select.execute({ feature: null }, parent);
    await loaded.event!({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: 'parent-after', callID: 'call-after', metadata: { sessionId: 'child-after' }, state: { input: output.args } } } } } as any);

    expect(new SessionService(root).getGlobal('child-after')).toMatchObject({
      parentSessionId: 'parent-after',
      featureName: 'feature-after',
      standingConstraints: 'Captured once.',
      standingConstraintsRevision: 1,
    });
  });

  it('refreshes a resumed child from each invocation snapshot without using the later parent route', async () => {
    const { root, hooks } = createRuntime();
    const loaded = await hooks;
    const parent = context('parent-resume');
    await loaded.tool!.hive_feature_create.execute({ name: 'resume-a' }, parent);
    await loaded.tool!.hive_feature_create.execute({ name: 'resume-b' }, parent);
    await loaded.tool!.hive_feature_select.execute({ feature: 'resume-a' }, parent);
    const first = { args: { subagent_type: 'forager-worker', prompt: 'First.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-resume', callID: 'call-1' } as any, first);
    await loaded['tool.execute.after']!({ tool: 'task', sessionID: 'parent-resume', callID: 'call-1', args: first.args } as any, { metadata: { sessionId: 'same-child' } } as any);
    await loaded.tool!.hive_feature_select.execute({ feature: 'resume-b' }, parent);
    const second = { args: { subagent_type: 'forager-worker', prompt: 'Resume.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'parent-resume', callID: 'call-2' } as any, second);
    await loaded.tool!.hive_feature_select.execute({ feature: null }, parent);
    await loaded['tool.execute.after']!({ tool: 'task', sessionID: 'parent-resume', callID: 'call-2', args: second.args } as any, { metadata: { sessionId: 'same-child' } } as any);
    expect(new SessionService(root).getGlobal('same-child')?.featureName).toBe('resume-b');
  });

  it('rejects invalid feature routes and strict constraint argument combinations', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('constraints');
    await expect(loaded.tool!.hive_feature_create.execute({ name: '../escape' }, caller)).rejects.toThrow('Invalid feature name');
    await expect(loaded.tool!.hive_constraints_read.execute({ scope: 'session', feature: 'x' }, caller)).rejects.toThrow(/not allowed/);
    await expect(loaded.tool!.hive_constraints_read.execute({ scope: 'session' }, context(''))).rejects.toThrow(/Session identity/);
    await loaded.tool!.hive_constraints_add.execute({ constraints: 'Original.' }, caller);
    const read = JSON.parse(await loaded.tool!.hive_constraints_read.execute({}, caller));
    const edit = loaded.tool!.hive_constraints_edit;
    await expect(edit.execute({ id: read.entries[0].id, expectedRevision: read.revision }, caller)).rejects.toThrow(/exactly one/);
    await expect(edit.execute({ id: read.entries[0].id, expectedRevision: read.revision, constraints: 'x', remove: true }, caller)).rejects.toThrow(/exactly one/);
    await expect(edit.execute({ id: read.entries[0].id, expectedRevision: read.revision, constraints: '  ' }, caller)).rejects.toThrow(/nonblank/);
  });

  it('serves the paged trace index and guarded event reads through the registered trace tools', async () => {
    const { sessions, transcripts, hooks } = createRuntime();
    const loaded = await hooks;
    const output = `start-${'🙂'.repeat(4_000)}-end`;
    sessions.set('child', { id: 'child', parentID: 'parent' });
    transcripts.set('child', [
      { info: { id: 'msg_u', role: 'user', time: { created: 1 } }, parts: [{ id: 'prt_u', type: 'text', text: 'Run the suite.' }] },
      {
        info: { id: 'msg_a', role: 'assistant', time: { created: 2, completed: 3 } },
        parts: [{ id: 'prt_a', type: 'tool', tool: 'bash', callID: 'call-a', state: { status: 'completed', title: 'Run suite', input: { command: 'bun test' }, output } }],
      },
    ]);
    const trace = loaded.tool!.hive_task_trace;
    const content = loaded.tool!.hive_task_trace_content;

    expect(Object.keys(trace.args).sort()).toEqual(['cursor', 'recovery', 'task_id']);
    expect(Object.keys(content.args).sort()).toEqual(['content_id', 'event', 'field', 'offset', 'task_id']);
    expect((content.args.field as any).safeParse('output').success).toBe(true);
    expect((content.args.field as any).safeParse('reasoning').success).toBe(false);

    const page = JSON.parse(await trace.execute({ task_id: 'child' }, context('parent')));
    expect(page).toMatchObject({
      ok: true,
      version: 3,
      target: { id: 'child', relationship: 'direct_child' },
      coverage: { complete: true, next_cursor: null },
      context: { assignment: { text: 'Run the suite.' } },
    });
    expect(page.events[1]).toMatchObject({ kind: 'tool', tool: 'bash', call_id: 'call-a', input: { command: 'bun test' }, abbreviated: ['output'] });

    const ref = page.events[1].ref;
    const event = JSON.parse(await content.execute({ task_id: 'child', event: ref }, context('parent')));
    expect(event.event).toMatchObject({ message_id: 'msg_a', part_id: 'prt_a', fields: { input: { value: { command: 'bun test' } }, output: { state: 'chunked' } } });
    const rest = JSON.parse(await content.execute({ task_id: 'child', event: ref, field: 'output', offset: event.event.fields.output.next_offset }, context('parent')));
    expect(`${event.event.fields.output.content}${rest.content}`).toBe(output);
    expect(rest.next_offset).toBeNull();
  });

  for (const agentMode of ['dedicated', 'unified']) it(`enforces the complete role matrix against global allow in ${agentMode} mode`, async () => {
    const { hooks } = createRuntime({ hiveConfig: {
      agentMode,
      customAgents: {
        ...Object.fromEntries(CUSTOM_AGENT_BASES.map((baseAgent) => [`audit-${baseAgent}`, {
          baseAgent, description: `Audit variant of ${baseAgent}.`, autoLoadSkills: ['verification'],
        }])),
        ...Object.fromEntries(['general', 'explore', 'dash-reviewer', 'vulnerability-review-primary'].map((name) => [name, {
          baseAgent: 'forager-worker', description: 'Attempted managed-agent replacement.',
        }])),
      },
    } });
    const loaded = await hooks;
    const config: any = {
      permission: { '*': 'allow' },
      experimental: { primary_tools: ['operator_tool', 'question'], mcp_timeout: 1234 },
      agent: Object.fromEntries(['general', 'explore'].map((name) => [name, {
        description: `Operator ${name}`,
        permission: { 'hive_*': 'allow', hive_status: 'allow', task: 'allow', question: 'allow', skill: 'deny', edit: 'allow', '*': 'allow', read: { '*': 'allow', '*.env': 'deny' } },
      }])),
    };
    await loaded.config!(config);

    const reads = ['hive_context_read', 'hive_constraints_read', 'hive_plan_read', 'hive_status', 'hive_repositories_status', 'hive_git_snapshot'];
    const contextWrites = ['hive_context_write', 'hive_context_append'];
    const traces = ['hive_task_trace', 'hive_task_trace_content'];
    const inspections = ['hive_worktree_inspect', 'hive_adhoc_worktree_inspect'];
    const constraints = ['hive_constraints_add', 'hive_constraints_edit', 'hive_constraints_clear'];
    const background = ['hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel'];
    const primaryOnly = [
      'hive_feature_complete', 'hive_feature_select', 'hive_plan_approve', 'hive_tasks_sync', 'hive_task_create',
      'hive_worktree_merge', 'hive_worktree_cleanup', 'hive_adhoc_worktree_create', 'hive_adhoc_worktree_merge', 'hive_adhoc_worktree_cleanup',
      ...constraints, 'hive_context_archive', ...background,
    ];
    const reviewPrimaries = [...reads, ...contextWrites, ...traces, ...inspections, ...constraints, ...background,
      'hive_feature_select', 'hive_adhoc_worktree_create', 'hive_adhoc_worktree_cleanup'];
    const matrix: Record<string, readonly string[]> = {
      'hive-master': HIVE_TOOL_NAMES,
      'swarm-orchestrator': HIVE_TOOL_NAMES,
      'hive-builder': HIVE_TOOL_NAMES,
      'architect-planner': [...reads, ...contextWrites, ...traces, ...inspections, ...constraints, ...background,
        'hive_feature_create', 'hive_feature_select', 'hive_plan_write', 'hive_plan_patch', 'hive_plan_approve', 'hive_tasks_sync',
        'hive_repositories_discover', 'hive_repositories_update', 'hive_context_archive'],
      'scout-researcher': [...reads, 'hive_repositories_discover'],
      'forager-worker': [...reads, ...contextWrites, ...inspections, ...traces, 'hive_task_update', 'hive_worktree_create'],
      'hive-helper': [...reads, ...inspections, ...traces],
      'plan-reviewer': [...reads, ...contextWrites],
      'code-reviewer': [...reads, ...contextWrites],
      'simplicity-reviewer': [...reads, ...contextWrites],
      'approach-advisor': [...reads, ...contextWrites],
      'vulnerability-reviewer': [...reads, ...contextWrites],
      'dash-reviewer': reviewPrimaries,
      'vulnerability-review-primary': reviewPrimaries,
      general: [], explore: [], [TASK_TRACE_SUMMARIZER_AGENT]: [],
    };
    for (const base of CUSTOM_AGENT_BASES) matrix[`audit-${base}`] = matrix[base]!;

    expect(HIVE_TOOL_NAMES).toHaveLength(37);
    expect(config.experimental.primary_tools.toSorted()).toEqual(['operator_tool', 'question', ...primaryOnly].toSorted());
    expect(config.experimental.mcp_timeout).toBe(1234);
    expect(config.subagent_depth).toBe(2);
    expect(Object.keys(config.agent).toSorted()).toEqual(Object.keys(matrix).toSorted());
    const childDenies: PermissionConfig = Object.fromEntries(config.experimental.primary_tools.map((name: string) => [name, 'deny']));
    const action = (agent: string, tool: string, child = false, pattern = '*') => evaluatePermission(
      tool, pattern, config.permission, config.agent[agent].permission, ...(child ? [childDenies] : []),
    );
    for (const [agent, allowed] of Object.entries(matrix)) {
      expect(config.agent[agent].tools, agent).toBeUndefined();
      if (agent !== TASK_TRACE_SUMMARIZER_AGENT) {
        const keys = Object.keys(config.agent[agent].permission);
        expect(config.agent[agent].permission['hive_*'], agent).toBe('deny');
        for (const tool of allowed) {
          expect(keys.indexOf(tool), `${agent}: deny must precede ${tool}`).toBeGreaterThan(keys.indexOf('hive_*'));
        }
      }
      for (const tool of [...HIVE_TOOL_NAMES, 'hive_future_tool']) {
        expect(action(agent, tool), `${agent}:${tool}`).toBe(allowed.includes(tool) ? 'allow' : 'deny');
        expect(action(agent, tool, true), `child ${agent}:${tool}`).toBe(allowed.includes(tool) && !primaryOnly.includes(tool) ? 'allow' : 'deny');
      }
      expect(action(agent, 'question', true), agent).toBe('deny');
      expect(action(agent, 'operator_tool', true), agent).toBe('deny');
      expect(action(agent, 'skill'), agent).toBe(agent === TASK_TRACE_SUMMARIZER_AGENT ? 'deny' : 'allow');
      expect(action(agent, 'read'), agent).toBe(agent === TASK_TRACE_SUMMARIZER_AGENT ? 'deny' : 'allow');
      expect(action(agent, 'bash'), agent).toBe(agent === TASK_TRACE_SUMMARIZER_AGENT ? 'deny' : 'allow');
    }

    const planningHelpers = ['scout-researcher', 'plan-reviewer', 'approach-advisor'];
    const reviewHelpers = CUSTOM_AGENT_BASES.filter((base) => base !== 'forager-worker');
    const executors = ['hive-master', 'swarm-orchestrator', 'hive-builder'];
    const reviewOrchestrators = ['dash-reviewer', 'vulnerability-review-primary'];
    for (const agent of Object.keys(matrix)) {
      const targets = agent === 'architect-planner'
        ? [...planningHelpers, ...planningHelpers.map((base) => `audit-${base}`)]
        : executors.includes(agent)
          ? [...CUSTOM_AGENT_BASES, ...CUSTOM_AGENT_BASES.map((base) => `audit-${base}`), 'architect-planner', 'hive-helper', 'general', 'explore']
          : reviewOrchestrators.includes(agent)
            ? [...reviewHelpers, ...reviewHelpers.map((base) => `audit-${base}`), 'hive-helper']
            : [];
      for (const target of [...Object.keys(matrix), 'unknown-agent']) {
        expect(action(agent, 'task', false, target), `${agent} -> ${target}`).toBe(targets.includes(target) ? 'allow' : 'deny');
        // task is deliberately absent from primary_tools: delegated Architect keeps its one terminal helper layer.
        expect(action(agent, 'task', true, target), `child ${agent} -> ${target}`).toBe(targets.includes(target) ? 'allow' : 'deny');
      }
      expect(action(agent, 'edit'), agent).toBe([...executors, 'forager-worker', 'audit-forager-worker', 'general'].includes(agent) ? 'allow' : 'deny');
      expect(action(agent, 'question'), agent).toBe([...executors, 'architect-planner', ...reviewOrchestrators].includes(agent) ? 'allow' : 'deny');
    }
    for (const agent of ['general', 'explore']) {
      expect(config.agent[agent].description).toBe(`Operator ${agent}`);
      expect(action(agent, 'read', false, 'private.env')).toBe('deny');
    }
    for (const base of CUSTOM_AGENT_BASES) expect(config.agent[`audit-${base}`].permission).toEqual(config.agent[base].permission);
    expect(wildcardMatch('audit-code-reviewer', 'audit-*-reviewe?')).toBe(true);
  });

  it('warns with the native permission keys dropped and the managed boundary reason', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await loaded.config!({});
      expect(warn).not.toHaveBeenCalled();
      const config: any = {
        agent: Object.fromEntries(['general', 'explore'].map((name) => [name, {
          permission: { hive_status: 'allow', 'hive_*': 'allow', task: { '*': 'allow' }, question: 'allow', skill: 'deny',
            edit: 'allow', read: { '*.env': 'deny' }, bash: 'allow' },
        }])),
      };
      await loaded.config!(config);
      const warnings = warn.mock.calls.map((call) => call.join(' '));
      expect(warnings).toHaveLength(2);
      for (const agent of ['general', 'explore']) {
        const droppedKeys = ['hive_status', 'hive_*', 'task', 'question', 'skill', ...(agent === 'explore' ? ['edit'] : [])];
        expect(warnings).toContain(
          `[hive:config] Dropping agent.${agent}.permission overrides for ${droppedKeys.join(', ')}: Hive owns native subagent boundaries (Hive tools, task and question denied; skill allowed${agent === 'explore' ? '; edit denied' : ''}). Other permission rules are preserved.`,
        );
        expect(config.agent[agent].permission.read).toEqual({ '*.env': 'deny' });
        expect(config.agent[agent].permission.bash).toBe('allow');
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('inherits session denials through child Architect while preserving terminal helper allowlists', async () => {
    const planningHelpers = ['scout-researcher', 'plan-reviewer', 'approach-advisor'];
    const { hooks } = createRuntime({ hiveConfig: {
      customAgents: Object.fromEntries(planningHelpers.map((baseAgent) => [`nested-${baseAgent}`, {
        baseAgent, description: `Nested ${baseAgent} specialist.`,
      }])),
    } });
    const loaded = await hooks;
    const config: any = { permission: { '*': 'allow' } };
    await loaded.config!(config);
    expect(config.subagent_depth).toBe(2);

    const parentSession: PermissionRule[] = [
      { permission: 'read', pattern: 'private-*', action: 'deny' },
      { permission: 'external_directory', pattern: '/allowed/*', action: 'allow' },
      { permission: 'external_directory', pattern: '/private/*', action: 'deny' },
      { permission: 'parent_allow_only', pattern: '*', action: 'allow' },
    ];
    const architect = config.agent['architect-planner'].permission;
    const architectSession = spawnSubagentSessionPermission(parentSession, architect, config.experimental.primary_tools);
    expect(evaluatePermission('hive_feature_create', '*', config.permission, architect, architectSession)).toBe('allow');
    expect(evaluatePermission('hive_repositories_update', '*', config.permission, architect, architectSession)).toBe('allow');
    expect(architectSession.some((rule) => rule.permission === 'task')).toBe(false);
    for (const name of config.experimental.primary_tools) {
      expect(architectSession).toContainEqual({ permission: name, pattern: '*', action: 'deny' });
    }

    const reads = ['hive_context_read', 'hive_constraints_read', 'hive_plan_read', 'hive_status', 'hive_repositories_status', 'hive_git_snapshot'];
    for (const base of planningHelpers) for (const target of [base, `nested-${base}`]) {
      expect(evaluatePermission('task', target, config.permission, architect, architectSession), target).toBe('allow');
      const helper = config.agent[target].permission;
      const grandchildSession = spawnSubagentSessionPermission(architectSession, helper, config.experimental.primary_tools);
      for (const rule of architectSession) expect(grandchildSession, target).toContainEqual(rule);
      expect(grandchildSession.some((rule) => rule.permission === 'parent_allow_only'), target).toBe(false);
      const allowed = [...reads, ...(base === 'scout-researcher'
        ? ['hive_repositories_discover'] : ['hive_context_write', 'hive_context_append'])];
      for (const tool of [...HIVE_TOOL_NAMES, 'hive_future_tool']) {
        expect(evaluatePermission(tool, '*', config.permission, helper, grandchildSession), `${target}:${tool}`)
          .toBe(allowed.includes(tool) ? 'allow' : 'deny');
      }
      expect(evaluatePermission('read', 'public-source.ts', config.permission, helper, grandchildSession), target).toBe('allow');
      expect(evaluatePermission('read', 'private-source.ts', config.permission, helper, grandchildSession), target).toBe('deny');
      expect(evaluatePermission('external_directory', '/allowed/source.ts', config.permission, helper, grandchildSession), target).toBe('allow');
      expect(evaluatePermission('external_directory', '/private/source.ts', config.permission, helper, grandchildSession), target).toBe('deny');
      for (const tool of ['task', 'question', 'edit']) {
        expect(evaluatePermission(tool, '*', config.permission, helper, grandchildSession), `${target}:${tool}`).toBe('deny');
      }
      for (const tool of ['skill', 'bash']) {
        expect(evaluatePermission(tool, '*', config.permission, helper, grandchildSession), `${target}:${tool}`).toBe('allow');
      }
    }
  });

  it('allows primary and delegated architects to dispatch planning helpers with the same route snapshot', async () => {
    const { sessions, hooks } = createRuntime();
    const loaded = await hooks;

    await loaded['chat.message']!({ sessionID: 'arch-primary', agent: 'architect-planner' } as any, { message: {}, parts: [] } as any);
    const primaryCall = { args: { subagent_type: 'scout-researcher', description: 'Research', prompt: 'Research the plan.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'arch-primary', callID: 'arch-primary-call' } as any, primaryCall);
    expect(primaryCall.args.prompt).toContain('<!-- hive-route-snapshot:start -->');

    await loaded.event!({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: 'arch-primary', callID: 'arch-primary-call', metadata: { sessionId: 'arch-child-observed' }, state: { input: { subagent_type: 'architect-planner' } } } } } } as any);
    const observedChildCall = { args: { subagent_type: 'scout-researcher', description: 'Research', prompt: 'Nested research.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'arch-child-observed', callID: 'arch-child-observed-call' } as any, observedChildCall);
    expect(observedChildCall.args.prompt.startsWith('Nested research.')).toBe(true);
    expect(observedChildCall.args.prompt).toContain('<!-- hive-route-snapshot:start -->');

    sessions.set('arch-child-native', { id: 'arch-child-native', parentID: 'arch-primary' });
    await loaded['chat.message']!({ sessionID: 'arch-child-native', agent: 'architect-planner' } as any, { message: {}, parts: [] } as any);
    const nativeChildCall = { args: { subagent_type: 'scout-researcher', description: 'Research', prompt: 'Nested research.' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'arch-child-native', callID: 'arch-child-native-call' } as any, nativeChildCall);
    expect(nativeChildCall.args.prompt.startsWith('Nested research.')).toBe(true);
    expect(nativeChildCall.args.prompt).toContain('<!-- hive-route-snapshot:start -->');
  });

  it('injects each full agent prompt through exactly one path', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const config: any = {};
    await loaded.config!(config);
    expect(config.agent['hive-master'].prompt).toBeUndefined();
    const hiveOutput = { system: ['provider'] };
    await loaded['experimental.chat.system.transform']!({ sessionID: 'primary', agent: 'hive-master' } as any, hiveOutput);
    expect(hiveOutput.system[0].split('# Hive (Hybrid)').length - 1).toBe(1);
    expect(hiveOutput.system[0]).toContain('## Capability-Based Tool Selection');
    expect(config.agent['scout-researcher'].prompt).toContain('# Scout');
    expect(config.agent['scout-researcher'].prompt).toContain('## Capability-Based Tool Selection');
    const scoutOutput = { system: ['provider'] };
    await loaded['experimental.chat.system.transform']!({ sessionID: 'scout', agent: 'scout-researcher' } as any, scoutOutput);
    expect(scoutOutput.system[0]).toBe('provider');
  });

  it('continues named context reads with opaque snapshot-validated cursors', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('context-reader');
    const content = `---\ndescription: Large test context\nread_when: Read during continuation tests.\nowner: test\nreview_after: 2099-01-01\n---\n\n${'x'.repeat(10_000)}`;
    await loaded.tool!.hive_context_write.execute({ scope: 'project', name: 'large', content }, caller);
    const first = JSON.parse(await loaded.tool!.hive_context_read.execute({ scope: 'project', name: 'large', maxBytes: 4_096 }, caller));
    expect(first.complete).toBe(false);
    expect(first.nextCursor).toBeString();
    const second = JSON.parse(await loaded.tool!.hive_context_read.execute({ scope: 'project', name: 'large', cursor: first.nextCursor, maxBytes: 4_096 }, caller));
    expect(second.range.startByte).toBe(first.range.endByte);

    await loaded.tool!.hive_context_append.execute({ scope: 'project', name: 'large', content: 'changed', expectedRevision: first.revision, expectedContentHash: first.file.contentHash }, caller);
    await expect(loaded.tool!.hive_context_read.execute({ scope: 'project', name: 'large', cursor: first.nextCursor, maxBytes: 4_096 }, caller)).rejects.toThrow(/cursor|changed/i);
  });

  it('requires context task metadata to name an existing task folder', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('context-task');
    await loaded.tool!.hive_feature_create.execute({ name: 'context-feature' }, caller);
    await expect(loaded.tool!.hive_context_write.execute({ name: 'notes', content: 'body', task: 'missing' }, caller)).rejects.toThrow(/does not exist/);
  });

  it('guards approval plus sync and refreshes pending specs using the standalone sync contract', async () => {
    const { root, hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('approve-sync');
    await loaded.tool!.hive_feature_create.execute({ name: 'approve-sync' }, caller);
    await loaded.tool!.hive_plan_write.execute({ content: '# Plan\n\n## Tasks\n\n### 1. Setup\n\nSetup.\n\n### 2. Build\n\nBuild.\n' }, caller);
    const reviewed = JSON.parse(await loaded.tool!.hive_plan_read.execute({}, caller));
    const result = JSON.parse(await loaded.tool!.hive_plan_approve.execute({ sync: true, expectedRevision: reviewed.revision }, caller));
    const approved = JSON.parse(await loaded.tool!.hive_plan_read.execute({}, caller));
    expect(result).toEqual({ approval: { success: true, feature: 'approve-sync', approvalPersisted: true, revision: approved.revision }, sync: { success: true, created: ['01-setup', '02-build'], removed: [], kept: [], manual: [] } });
    const retry = JSON.parse(await loaded.tool!.hive_plan_approve.execute({ sync: true, expectedRevision: reviewed.revision }, caller));
    expect(retry.approval).toEqual({ ...result.approval, alreadyApproved: true });
    expect(retry.sync).toEqual({ success: true, created: [], removed: [], kept: ['01-setup', '02-build'], manual: [] });
    expect(new PlanService(root).isApproved('approve-sync')).toBe(true);
    expect(JSON.parse(await loaded.tool!.hive_tasks_sync.execute({}, caller))).toEqual({ created: [], removed: [], kept: ['01-setup', '02-build'], manual: [] });

    await loaded.tool!.hive_plan_write.execute({ content: reviewed.content.replace('Build.', 'Build again.') }, caller);
    const revised = JSON.parse(await loaded.tool!.hive_plan_read.execute({}, caller));
    expect(JSON.parse(await loaded.tool!.hive_status.execute({}, caller)).tasks[1].specStale).toBe(true);
    const refreshed = JSON.parse(await loaded.tool!.hive_plan_approve.execute({ sync: true, expectedRevision: revised.revision, refreshPending: true }, caller));
    expect(refreshed.sync).toMatchObject({ success: true, kept: ['01-setup', '02-build'] });
    expect(JSON.parse(await loaded.tool!.hive_status.execute({}, caller)).tasks[1].specStale).toBe(false);

    await loaded.tool!.hive_feature_create.execute({ name: 'approve-only' }, caller);
    await loaded.tool!.hive_plan_write.execute({ feature: 'approve-only', content: reviewed.content }, caller);
    expect(JSON.parse(await loaded.tool!.hive_plan_approve.execute({ feature: 'approve-only' }, caller))).toEqual({ success: true, feature: 'approve-only', approvalPersisted: true, revision: JSON.parse(await loaded.tool!.hive_plan_read.execute({ feature: 'approve-only' }, caller)).revision });
    expect(JSON.parse(await loaded.tool!.hive_status.execute({ feature: 'approve-only' }, caller)).tasks).toEqual([]);
  });

  it('skips sync on missing or stale review revisions and reports sync failure without revoking approval', async () => {
    const { root, hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('approve-failure');
    await loaded.tool!.hive_feature_create.execute({ name: 'approve-failure' }, caller);
    const written = JSON.parse(await loaded.tool!.hive_plan_write.execute({ content: '# Plan\n\n## Tasks\n\n### 1. Setup\n\nSetup.\n' }, caller));
    const reviewed = JSON.parse(await loaded.tool!.hive_plan_read.execute({}, caller));
    const missing = JSON.parse(await loaded.tool!.hive_plan_approve.execute({ sync: true }, caller));
    const refreshOnly = JSON.parse(await loaded.tool!.hive_plan_approve.execute({ refreshPending: true }, caller));
    expect(refreshOnly).toMatchObject({ success: false, reason: 'refresh_pending_requires_sync', stage: 'validation', approvalPersisted: false });
    expect(missing).toMatchObject({ approval: { success: false, reason: 'expected_revision_required' }, sync: { success: false, skipped: true, reason: 'approval_failed' } });
    expect(new PlanService(root).isApproved('approve-failure')).toBe(false);

    fs.writeFileSync(written.path, reviewed.content.replace('Setup.', 'Changed outside the tool.'));
    const stale = JSON.parse(await loaded.tool!.hive_plan_approve.execute({ sync: true, expectedRevision: reviewed.revision }, caller));
    expect(stale).toMatchObject({ approval: { success: false, reason: 'stale_revision', stage: 'validation', approvalPersisted: false }, sync: { success: false, skipped: true, reason: 'approval_failed' } });
    expect(stale.approval.error).toContain('Stale plan revision');
    expect(new PlanService(root).isApproved('approve-failure')).toBe(false);
    expect(JSON.parse(await loaded.tool!.hive_status.execute({}, caller)).tasks).toEqual([]);

    await loaded.tool!.hive_plan_write.execute({ content: '# Plan\n\n## Tasks\n\n### 1. Setup\n\n**Depends on**: 99\n\nSetup.\n' }, caller);
    const invalid = JSON.parse(await loaded.tool!.hive_plan_read.execute({}, caller));
    const failed = JSON.parse(await loaded.tool!.hive_plan_approve.execute({ sync: true, expectedRevision: invalid.revision }, caller));
    expect(failed).toMatchObject({ approval: { success: true, feature: 'approve-failure' }, sync: { success: false, reason: 'task_sync_failed' } });
    expect(failed.sync.error).toMatch(/99|dependency/i);
    expect(new PlanService(root).isApproved('approve-failure')).toBe(true);
    expect(JSON.parse(await loaded.tool!.hive_status.execute({}, caller)).tasks).toEqual([]);
  });

  it('returns persisted approval and the failed metadata stage while skipping sync', async () => {
    const { root, hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('approval-partial');
    await loaded.tool!.hive_feature_create.execute({ name: 'approval-partial' }, caller);
    const written = JSON.parse(await loaded.tool!.hive_plan_write.execute({ content: '# Plan\n\n## Tasks\n\n### 1. Setup\n\nSetup.\n' }, caller));
    const reviewed = JSON.parse(await loaded.tool!.hive_plan_read.execute({}, caller));
    const write = fs.writeFileSync;
    const failure = spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (args[0] === path.join(path.dirname(written.path), 'feature.json')) throw new Error('Injected metadata write failure');
      return write(...args);
    });
    try {
      const result = JSON.parse(await loaded.tool!.hive_plan_approve.execute({ sync: true, expectedRevision: reviewed.revision }, caller));
      expect(result).toMatchObject({ approval: { success: false, reason: 'feature_metadata_write_failed', stage: 'feature_metadata', approvalPersisted: true, revision: expect.any(String) }, sync: { success: false, skipped: true, reason: 'approval_failed' } });
      expect(new PlanService(root).isApproved('approval-partial')).toBe(true);
      expect(JSON.parse(await loaded.tool!.hive_status.execute({}, caller)).tasks).toEqual([]);
    } finally {
      failure.mockRestore();
    }
  });

  it('detects plan writes, patches, and comments across the approve-to-sync boundary', async () => {
    for (const mutation of ['write', 'patch', 'comment'] as const) {
      const { root, hooks } = createRuntime();
      const loaded = await hooks;
      const caller = context(`sync-${mutation}`);
      await loaded.tool!.hive_feature_create.execute({ name: `sync-${mutation}` }, caller);
      await loaded.tool!.hive_plan_write.execute({ content: '# Plan\n\n## Tasks\n\n### 1. Setup\n\nSetup.\n' }, caller);
      const reviewed = JSON.parse(await loaded.tool!.hive_plan_read.execute({}, caller));
      const service = new PlanService(root);
      const sync = TaskService.prototype.sync;
      const concurrent = spyOn(TaskService.prototype, 'sync').mockImplementation(function (feature, options) {
        // Exercise a write before sync reads and a patch/comment after it has written.
        if (mutation === 'write') service.write(feature, reviewed.content.replace('Setup.', 'Concurrent setup.'));
        const result = sync.call(this, feature, options);
        if (mutation === 'patch') service.patch(feature, service.read(feature)!.revision, [{ type: 'replace_task', taskNumber: 1, content: '### 1. Setup\n\nConcurrent patch.\n' }]);
        if (mutation === 'comment') service.addComment(feature, { line: 7, body: 'Concurrent review comment.', replies: [] });
        return result;
      });
      try {
        const result = JSON.parse(await loaded.tool!.hive_plan_approve.execute({ sync: true, expectedRevision: reviewed.revision }, caller));
        expect(result).toMatchObject({ approval: { success: false, reason: 'approval_superseded_during_sync', stage: 'sync_verification', approvalPersisted: mutation === 'comment', revision: expect.any(String), currentRevision: service.read(`sync-${mutation}`)!.revision }, sync: { success: true, created: ['01-setup'] } });
        expect(result.approval.currentRevision).not.toBe(result.approval.revision);
      } finally {
        concurrent.mockRestore();
      }
    }
  });

  it('warns on completion about missing and unreadable task statuses alongside incomplete healthy tasks', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('completion-integrity');
    await loaded.tool!.hive_feature_create.execute({ name: 'completion-integrity' }, caller);
    const written = JSON.parse(await loaded.tool!.hive_plan_write.execute({ content: '# Plan\n\n## Tasks\n\n### 1. Missing\n\nWork.\n\n### 2. Unreadable\n\nWork.\n\n### 3. Pending\n\nWork.\n\n### 4. Done\n\nWork.\n\n### 5. Cancelled\n\nWork.\n' }, caller));
    await loaded.tool!.hive_tasks_sync.execute({}, caller);
    await loaded.tool!.hive_task_update.execute({ task: '04-done', status: 'done' }, caller);
    await loaded.tool!.hive_task_update.execute({ task: '05-cancelled', status: 'cancelled' }, caller);
    const tasksPath = path.join(path.dirname(written.path), 'tasks');
    fs.rmSync(path.join(tasksPath, '01-missing', 'status.json'));
    fs.writeFileSync(path.join(tasksPath, '02-unreadable', 'status.json'), '{ malformed');

    const result = JSON.parse(await loaded.tool!.hive_feature_complete.execute({}, caller));
    expect(result).toMatchObject({ success: true, feature: { status: 'completed' } });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].incompleteTasks).toHaveLength(3);
    expect(result.warnings[0].incompleteTasks).toMatchObject([
      { folder: '01-missing', status: null, integrity: { reason: 'status_missing' } },
      { folder: '02-unreadable', status: null, integrity: { reason: 'status_unreadable', error: expect.any(String) } },
      { folder: '03-pending', status: 'pending' },
    ]);
  });

  it('keeps retained task folders with no readable status visible as non-runnable integrity entries', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('task-integrity');
    await loaded.tool!.hive_feature_create.execute({ name: 'task-integrity' }, caller);
    const written = JSON.parse(await loaded.tool!.hive_plan_write.execute({ content: '# Plan\n\n## Tasks\n\n### 1. Setup\n\nSetup.\n\n### 2. Build\n\nBuild.\n' }, caller));
    await loaded.tool!.hive_tasks_sync.execute({}, caller);
    await loaded.tool!.hive_task_update.execute({ task: '01-setup', handoff: 'Retained successor contract.' }, caller);
    const taskPath = path.join(path.dirname(written.path), 'tasks', '01-setup');
    const spec = fs.readFileSync(path.join(taskPath, 'spec.md'), 'utf8');
    fs.rmSync(path.join(taskPath, 'status.json'));

    const missing = JSON.parse(await loaded.tool!.hive_status.execute({}, caller));
    expect(missing.tasks).toHaveLength(2);
    expect(missing.tasks[0]).toEqual({ folder: '01-setup', name: 'setup', status: null, integrity: { reason: 'status_missing' }, specStale: false, specStaleReason: 'matches_plan', hasHandoff: true });
    expect(missing.runnable).toEqual([]);
    expect(missing.blocked).toEqual({ '02-build': ['01-setup'] });
    expect(fs.readFileSync(path.join(taskPath, 'spec.md'), 'utf8')).toBe(spec);
    expect(fs.readFileSync(path.join(taskPath, 'handoff.md'), 'utf8')).toBe('Retained successor contract.');

    fs.writeFileSync(path.join(taskPath, 'status.json'), '{bad json');
    const unreadable = JSON.parse(await loaded.tool!.hive_status.execute({}, caller));
    expect(unreadable.tasks[0]).toMatchObject({ folder: '01-setup', status: null, integrity: { reason: 'status_unreadable', error: expect.any(String) }, hasHandoff: true });
    expect(unreadable.runnable).toEqual([]);
    expect(unreadable.blocked).toEqual({ '02-build': ['01-setup'] });
  });

  it('reports one task list with heading integrity, blockers, spec freshness, and successor handoffs', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('task-state');
    await loaded.tool!.hive_feature_create.execute({ name: 'task-state' }, caller);
    await loaded.tool!.hive_feature_select.execute({ feature: 'task-state' }, caller);
    const orphanPlan = '# Plan\n\n## Tasks\n\n### 1. Setup\n\nSetup.\n\n### Setup amendment\n\nAmend.\n\n### 2. Build\n\nBuild.\n';

    const written = JSON.parse(await loaded.tool!.hive_plan_write.execute({ content: orphanPlan }, caller));
    expect(written.path).toEndWith('plan.md');
    expect(written.unownedTaskHeadings).toEqual([{ line: 9, title: 'Setup amendment' }]);
    const read = JSON.parse(await loaded.tool!.hive_plan_read.execute({}, caller));
    expect(read.unownedTaskHeadings).toEqual([{ line: 9, title: 'Setup amendment' }]);
    const rejected = JSON.parse(await loaded.tool!.hive_plan_approve.execute({}, caller));
    expect(rejected).toMatchObject({ success: false, reason: 'unowned_task_headings', stage: 'validation', approvalPersisted: false });
    expect(rejected.error).toMatch(/not numbered tasks: line 9: ### Setup amendment/);
    await expect(loaded.tool!.hive_plan_patch.execute({
      expectedRevision: read.revision,
      operations: [{ type: 'insert_after_section', headingPath: ['Tasks', '2. Build'], content: '### Build notes\n\nMore.\n' }],
    }, caller)).rejects.toThrow(/not numbered tasks: line 16: ### Build notes\. /);

    await loaded.tool!.hive_plan_patch.execute({
      expectedRevision: read.revision,
      operations: [{ type: 'replace_section', headingPath: ['Tasks'], content: '## Tasks\n\n### 1. Setup\n\nSetup.\n\n#### Amendment\n\nAmend.\n\n### 2. Build\n\nBuild.\n' }],
    }, caller);
    await loaded.tool!.hive_plan_approve.execute({}, caller);
    expect(JSON.parse(await loaded.tool!.hive_tasks_sync.execute({}, caller)).created).toEqual(['01-setup', '02-build']);

    const handoff = JSON.parse(await loaded.tool!.hive_task_update.execute({ task: '01-setup', handoff: 'Build reads the amendment.' }, caller));
    expect(handoff.status).toBe('pending');
    expect(handoff.handoffPath).toEndWith(path.join('tasks', '01-setup', 'handoff.md'));
    await expect(loaded.tool!.hive_task_update.execute({ task: '01-setup', handoff: 'x'.repeat(2049) }, caller)).rejects.toThrow('Task handoff is 2049 UTF-8 bytes; the limit is 2048.');
    const tasksPath = path.join(path.dirname(written.path), 'tasks');
    fs.mkdirSync(path.join(tasksPath, '02-build', 'handoff.md'));
    const failed = JSON.parse(await loaded.tool!.hive_task_update.execute({ task: '02-build', handoff: 'next' }, caller));
    expect(failed).toMatchObject({ success: false, reason: 'task_update_persistence_failed', failedStage: 'handoff', handoffWritten: false });
    expect(failed.handoffPath).toEndWith(path.join('02-build', 'handoff.md'));
    fs.rmSync(path.join(tasksPath, '02-build', 'handoff.md'), { recursive: true });

    const plan = JSON.parse(await loaded.tool!.hive_plan_read.execute({}, caller));
    fs.writeFileSync(path.join(path.dirname(written.path), 'plan.md'), plan.content.replace('Build.', 'Build again.'));
    const status = JSON.parse(await loaded.tool!.hive_status.execute({}, caller));
    const projected = (entries: any[]) => entries.map(({ folder, dependsOn, specStale, specStaleReason, hasHandoff }) => ({ folder, dependsOn, specStale, specStaleReason, hasHandoff }));
    expect(projected(status.tasks)).toEqual([
      { folder: '01-setup', dependsOn: [], specStale: false, specStaleReason: 'matches_plan', hasHandoff: true },
      { folder: '02-build', dependsOn: ['01-setup'], specStale: true, specStaleReason: 'differs_from_plan', hasHandoff: false },
    ]);
    expect(status.feature).toEqual({ name: 'task-state', status: 'approved', hasPlan: true, commentCount: 0 });
    expect(status).not.toHaveProperty('specFreshnessError');
    expect(status.runnable).toEqual(['01-setup']);
    expect(status.blocked).toEqual({ '02-build': ['01-setup'] });

    // A terminal record keeps its historical edges; a legacy status without dependsOn reads as [].
    await loaded.tool!.hive_task_update.execute({ task: '02-build', status: 'done' }, caller);
    const setupStatusPath = path.join(tasksPath, '01-setup', 'status.json');
    const { dependsOn: _omitted, ...legacySetup } = JSON.parse(fs.readFileSync(setupStatusPath, 'utf8'));
    fs.writeFileSync(setupStatusPath, JSON.stringify(legacySetup));
    const edges = JSON.parse(await loaded.tool!.hive_status.execute({}, caller));
    const dependencyView = (entries: any[]) => entries.map(({ folder, status, dependsOn }) => ({ folder, status, dependsOn }));
    expect(dependencyView(edges.tasks)).toEqual([
      { folder: '01-setup', status: 'pending', dependsOn: [] },
      { folder: '02-build', status: 'done', dependsOn: ['01-setup'] },
    ]);
    expect(edges.feature).not.toHaveProperty('tasks');
    expect(edges.runnable).toEqual(['01-setup']);
    expect(edges.blocked).toEqual({});

    const blocker = { reason: 'Operator decision needed.', options: ['Keep', 'Replace'], recommendation: 'Keep' };
    await loaded.tool!.hive_task_update.execute({ task: '01-setup', status: 'blocked', blocker }, caller);
    fs.writeFileSync(written.path, plan.content.replace('### 2. Build', '### Shared notes\n\nUnowned.\n\n### 2. Build'));
    const blocked = JSON.parse(await loaded.tool!.hive_status.execute({}, caller));
    expect(blocked.tasks[0]).toMatchObject({ status: 'blocked', blocker, specStale: null, specStaleReason: 'unowned_heading_after_task_section' });
    expect(blocked.unownedTaskHeadings).toEqual([{ line: 13, title: 'Shared notes' }]);
    expect(blocked.runnable).toEqual([]);
    expect(blocked.worktrees).toEqual([]);

    fs.rmSync(path.join(tasksPath, '02-build', 'spec.md'));
    fs.mkdirSync(path.join(tasksPath, '02-build', 'spec.md'));
    const degraded = JSON.parse(await loaded.tool!.hive_status.execute({}, caller));
    expect(degraded.specFreshnessError).toMatch(/EISDIR/);
    expect(projected(degraded.tasks)).toEqual([
      { folder: '01-setup', dependsOn: [], specStale: null, specStaleReason: 'freshness_unavailable', hasHandoff: true },
      { folder: '02-build', dependsOn: ['01-setup'], specStale: null, specStaleReason: 'freshness_unavailable', hasHandoff: false },
    ]);
    expect(degraded.feature).not.toHaveProperty('tasks');
  });

  it('appends a task brief after the unchanged route snapshot only for bound Forager dispatches', async () => {
    const { hooks } = createRuntime({ hiveConfig: { customAgents: { 'forager-specialist': { baseAgent: 'forager-worker', description: 'Specialist Forager.' } } } });
    const loaded = await hooks;
    const caller = context('brief-parent');
    const briefStart = /<!-- hive-task-brief:start -->/g;
    const routeStart = /<!-- hive-route-snapshot:start -->/g;
    const briefBlock = /\n\n<!-- hive-task-brief:start -->[\s\S]*<!-- hive-task-brief:end -->$/;
    await loaded.tool!.hive_feature_create.execute({ name: '10_x' }, caller);
    await loaded.tool!.hive_feature_select.execute({ feature: '10_x' }, caller);
    const written = JSON.parse(await loaded.tool!.hive_plan_write.execute({ content: '# Plan\n\n## Tasks\n\n### 1. Setup\n\nSetup.\n\n### 2. Build\n\nBuild.\n' }, caller));
    const featureDir = path.dirname(written.path);
    expect(path.basename(featureDir)).toBe('01_10_x');
    await loaded.tool!.hive_plan_approve.execute({}, caller);
    await loaded.tool!.hive_tasks_sync.execute({}, caller);
    await loaded.tool!.hive_task_update.execute({ task: '01-setup', status: 'done', handoff: 'Setup notes.' }, caller);
    await loaded.tool!.hive_context_write.execute({ name: 'research-notes', content: '---\ndescription: Notes\nread_when: Always.\nowner: test\nreview_after: 2099-01-01\n---\n\nBody.' }, caller);

    const dispatch = async (subagent_type: string, prompt: string, callID: string) => {
      const output = { args: { subagent_type, prompt } };
      await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'brief-parent', callID } as any, output);
      return output;
    };
    const authored = 'Hive task: 02-build\nImplement the build.';
    const forager = await dispatch('forager-worker', authored, 'call-build');
    expect(forager.args.prompt).toContain('Task: 02-build - Build (pending)');

    // Route footer bytes match a dispatch that receives no brief.
    const scout = await dispatch('scout-researcher', authored, 'call-scout');
    expect(forager.args.prompt.replace(briefBlock, '')).toBe(scout.args.prompt);
    expect(forager.args.prompt.indexOf('<!-- hive-route-snapshot:end -->')).toBeLessThan(forager.args.prompt.indexOf('<!-- hive-task-brief:start -->'));
    for (const agent of ['code-reviewer', 'scout-researcher', 'approach-advisor', 'general']) {
      expect((await dispatch(agent, authored, `call-${agent}`)).args.prompt).not.toContain('hive-task-brief');
    }

    const custom = await dispatch('forager-specialist', authored, 'call-custom');
    expect(custom.args.prompt).toBe(forager.args.prompt);

    const redispatched = { args: { subagent_type: 'forager-worker', prompt: forager.args.prompt } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'brief-parent', callID: 'call-build-again' } as any, redispatched);
    expect(redispatched.args.prompt).toBe(forager.args.prompt);
    expect(redispatched.args.prompt.match(routeStart)).toHaveLength(1);
    expect(redispatched.args.prompt.match(briefStart)).toHaveLength(1);
    const reviewerOfMutated = await dispatch('code-reviewer', forager.args.prompt, 'call-review-mutated');
    expect(reviewerOfMutated.args.prompt).toBe(scout.args.prompt);
    expect(reviewerOfMutated.args.prompt).not.toContain('hive-task-brief');

    const [setup, build] = await Promise.all([
      dispatch('forager-worker', 'Hive task: 01-setup\nSetup.', 'call-parallel-setup'),
      dispatch('forager-worker', 'Hive task: 02-build\nBuild.', 'call-parallel-build'),
    ]);
    expect(setup.args.prompt).toContain('Task: 01-setup - Setup (done)');
    expect(setup.args.prompt).not.toContain('Task: 02-build');
    expect(build.args.prompt).toContain('Task: 02-build - Build (pending)');
  });

  it('preserves authored prompts that quote generated block markers inline', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('brief-quoted');
    await loaded.tool!.hive_feature_create.execute({ name: 'quoted' }, caller);
    await loaded.tool!.hive_feature_select.execute({ feature: 'quoted' }, caller);
    await loaded.tool!.hive_plan_write.execute({ content: '# Plan\n\n## Tasks\n\n### 1. Setup\n\nSetup.\n' }, caller);
    await loaded.tool!.hive_plan_approve.execute({}, caller);
    await loaded.tool!.hive_tasks_sync.execute({}, caller);

    const authored = [
      'Hive task: 01-setup',
      'Explain `<!-- hive-task-brief:start -->` and `<!-- hive-task-brief:end -->`.',
      'Explain `<!-- hive-route-snapshot:start -->` and `<!-- hive-route-snapshot:end -->`.',
    ].join('\n');
    const dispatch = async (subagent_type: string, callID: string) => {
      const output = { args: { subagent_type, prompt: authored } };
      await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'brief-quoted', callID } as any, output);
      return output;
    };

    const forager = await dispatch('forager-worker', 'call-quoted-forager');
    expect(forager.args.prompt.startsWith(authored)).toBe(true);
    expect(forager.args.prompt).toContain('Explain `<!-- hive-task-brief:start -->` and `<!-- hive-task-brief:end -->`.');
    expect(forager.args.prompt.match(/<!-- hive-task-brief:(?:start|end) -->/g)).toHaveLength(4);
    expect(forager.args.prompt.match(/<!-- hive-route-snapshot:(?:start|end) -->/g)).toHaveLength(4);

    const scout = await dispatch('scout-researcher', 'call-quoted-scout');
    expect(scout.args.prompt.startsWith(authored)).toBe(true);
    expect(scout.args.prompt).toContain('Explain `<!-- hive-route-snapshot:start -->` and `<!-- hive-route-snapshot:end -->`.');
    expect(scout.args.prompt.match(/<!-- hive-task-brief:(?:start|end) -->/g)).toHaveLength(2);
    expect(scout.args.prompt.match(/<!-- hive-route-snapshot:(?:start|end) -->/g)).toHaveLength(4);

    const redispatched = { args: { subagent_type: 'forager-worker', prompt: forager.args.prompt } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'brief-quoted', callID: 'call-quoted-again' } as any, redispatched);
    expect(redispatched.args.prompt).toBe(forager.args.prompt);
  });

  it('attaches no task brief without a selected feature route', async () => {
    const { hooks } = createRuntime();
    const loaded = await hooks;
    const caller = context('brief-unselected');
    await loaded.tool!.hive_feature_create.execute({ name: 'sole-live' }, caller);
    await loaded.tool!.hive_plan_write.execute({ feature: 'sole-live', content: '# Plan\n\n## Tasks\n\n### 1. Setup\n\nSetup.\n' }, caller);
    await loaded.tool!.hive_plan_approve.execute({ feature: 'sole-live' }, caller);
    await loaded.tool!.hive_tasks_sync.execute({ feature: 'sole-live' }, caller);

    const fallback = { args: { subagent_type: 'forager-worker', prompt: 'Hive task: 01-setup' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'brief-unselected', callID: 'call-fallback' } as any, fallback);
    expect(fallback.args.prompt).toContain('"featureRoute":{"selected":false,"feature":"sole-live"}');
    expect(fallback.args.prompt).not.toContain('hive-task-brief');

    await loaded.tool!.hive_feature_select.execute({ feature: null }, caller);
    const explicitNull = { args: { subagent_type: 'forager-worker', prompt: 'Hive task: 01-setup' } };
    await loaded['tool.execute.before']!({ tool: 'task', sessionID: 'brief-unselected', callID: 'call-null' } as any, explicitNull);
    expect(explicitNull.args.prompt).toContain('"featureRoute":{"selected":true,"feature":null}');
    expect(explicitNull.args.prompt).not.toContain('hive-task-brief');
  });

  it('replays task trace hints on each transformed turn only for children the runtime confirms', async () => {
    const { sessions, hooks } = createRuntime();
    const loaded = await hooks;
    sessions.set('ses_confirmed', { id: 'ses_confirmed', parentID: 'parent' });
    sessions.set('ses_foreign', { id: 'ses_foreign', parentID: 'other-parent' });
    sessions.set('ses_alias', { id: 'ses_other', parentID: 'parent' });
    sessions.set('ses_errored', new Error('NotFoundError'));
    const taskCall = (child: string) => ({
      id: `part-${child}`,
      type: 'tool',
      tool: 'task',
      callID: `call-${child}`,
      state: { status: 'running', input: { description: child, prompt: 'Work.', subagent_type: 'forager-worker' }, metadata: { sessionId: child }, time: { start: 1 } },
      metadata: { anthropic: { cacheControl: 'ephemeral' } },
    });
    const turn = () => ({
      messages: [
        { info: { id: 'dispatch', sessionID: 'parent', role: 'assistant' }, parts: ['ses_confirmed', 'ses_foreign', 'ses_alias', 'ses_errored', 'ses_unknown'].map(taskCall) },
        { info: { id: 'after-restart', sessionID: 'parent', role: 'user' }, parts: [{ id: 'ask', type: 'text', text: 'Status?' }] },
      ],
    });

    for (let index = 0; index < 2; index += 1) {
      const output: any = turn();
      await loaded['experimental.chat.messages.transform']!({} as any, output);
      const hints = output.messages[0].parts.filter((part: any) => part.hiveTaskTraceHint);
      expect(hints.map((part: any) => part.hiveTaskTraceChild)).toEqual(['ses_confirmed']);
      expect(hints[0].text).toContain('the child may still be in flight');
    }
  });

  it('ignores malformed legacy execution-attempt state during startup and status', async () => {
    const runtime = createRuntime();
    fs.writeFileSync(path.join(runtime.root, '.hive', 'execution-attempts.json'), '{ malformed legacy state');
    const loaded = await runtime.hooks;
    const caller = context('parent');
    await loaded.tool!.hive_feature_create.execute({ name: 'legacy-free' }, caller);
    const status = JSON.parse(await loaded.tool!.hive_status.execute({ feature: 'legacy-free' }, caller));
    expect(status.feature.name).toBe('legacy-free');
    expect(fs.readFileSync(path.join(runtime.root, '.hive', 'execution-attempts.json'), 'utf8')).toBe('{ malformed legacy state');
  });
});
