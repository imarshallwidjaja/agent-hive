import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import plugin from '../index.js';
import { HIVE_TOOL_NAMES } from '../utils/plugin-manifest.js';
import { createPluginWithHome } from '../e2e/plugin-test-home.js';
import { WorklogError } from 'hive-core';
import { createHiveServices } from './hive-services.js';
import { createHiveOperations } from './hive-tools.js';
import { z } from './schema.js';

// Contract tests for the shared Hive operations, exercised through the registered v1 plugin so they pin what a host
// sees: argument shapes, result presentation and validation outcomes. Role policy is pinned in runtime.test.ts.

const roots: string[] = [];

async function createRuntime() {
  const root = fs.realpathSync(fs.mkdtempSync(`/tmp/hive-tools-${process.pid}-`));
  const home = fs.mkdtempSync(`/tmp/hive-tools-home-${process.pid}-`);
  roots.push(root, home);
  fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, '.gitignore'), '.hive/\n');
  git('add', '.');
  git('commit', '-m', 'base');
  // A session missing here is a root session; an Error entry stands for a session lookup that returns an error.
  const sessions = new Map<string, { id: string; parentID?: string } | Error>();
  const client = {
    session: {
      get: async ({ path: input }: { path: { id: string } }) => {
        const known = sessions.get(input.id);
        return known instanceof Error ? { error: { name: known.message } } : { data: known ?? { id: input.id } };
      },
      messages: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      abort: async () => ({ data: true }),
    },
  };
  const hooks = await createPluginWithHome(home, () => plugin.server({ directory: root, worktree: root, project: { id: 'test', worktree: root }, client } as any));
  const call = async (name: string, args: Record<string, unknown>, sessionID?: string, agent = 'hive-master'): Promise<any> => {
    const context = { sessionID: sessionID ?? 'session', messageID: 'message', agent, abort: new AbortController().signal };
    return (hooks.tool as any)[name].execute(args, context);
  };
  const callJson = async (name: string, args: Record<string, unknown>, sessionID?: string, agent?: string) => JSON.parse(await call(name, args, sessionID, agent));
  const failure = async (name: string, args: Record<string, unknown>, sessionID?: string, agent?: string): Promise<string> => {
    try { await call(name, args, sessionID, agent); } catch (error) { return (error as Error).message; }
    throw new Error(`${name} did not fail`);
  };
  return { root, hooks, sessions, call, callJson, failure };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function typeOf(schema: any): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.join('|');
  if (schema.anyOf) return schema.anyOf.map(typeOf).join('|');
  if (schema.type === 'array') return `${typeOf(schema.items)}[]`;
  if (schema.type === 'object') return schema.properties ? `{${fields(schema)}}` : `record<${typeOf(schema.additionalProperties)}>`;
  return schema.type;
}

function fields(schema: any): string {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([key, value]) => `${key}${required.has(key) ? '' : '?'}:${typeOf(value)}`).join(', ');
}

// One valid value per required field, so a schema can be parsed with only the arguments it demands.
function sample(schema: any): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return sample(schema.anyOf[0]);
  if (schema.type === 'array') return [];
  if (schema.type === 'object') return schema.properties ? Object.fromEntries((schema.required ?? []).map((key: string) => [key, sample(schema.properties[key])])) : {};
  return { string: 'x', number: 1, boolean: true }[schema.type as string];
}

const ORDINARY_OPERATION_SIGNATURES = [
  'hive_feature_create(name:string, ticket?:string)',
  'hive_feature_select(feature:string|null)',
  'hive_feature_complete(name?:string)',
  'hive_repositories_status()',
  'hive_repositories_discover()',
  'hive_repositories_update(repositories:{id:string, path:string}[])',
  'hive_plan_write(content:string, feature?:string)',
  'hive_plan_patch(expectedRevision:string, operations:{type:replace_section|replace_task|insert_after_section, headingPath?:string[], taskNumber?:number, content:string}[], feature?:string)',
  'hive_plan_read(feature?:string, mode?:full|outline)',
  'hive_plan_approve(feature?:string, expectedRevision?:string, sync?:boolean, refreshPending?:boolean, refreshTasks?:string[])',
  'hive_tasks_sync(feature?:string, refreshPending?:boolean)',
  'hive_task_create(name:string, order?:number, feature?:string, description?:string, goal?:string, acceptanceCriteria?:string[], references?:string[], files?:string[], dependsOn?:string[], reason?:string, source?:string, repos?:string[])',
  'hive_task_update(task:string, status?:pending|in_progress|done|cancelled|blocked|failed|partial, summary?:string, blocker?:{reason:string, options?:string[], recommendation?:string, context?:string}|null, report?:string, handoff?:string, feature?:string)',
  'hive_worktree_create(feature?:string, task:string, baseRef?:string, repoIds?:string[], candidate?:string)',
  'hive_worktree_inspect(feature?:string, task:string, repoIds?:string[], candidate?:string)',
  'hive_worktree_merge(feature?:string, task:string, repoIds?:string[], candidate?:string, historyIntent:preserve-source|rewrite-private, strategy?:merge|squash|rebase, message?:string, preserveConflicts?:boolean, cleanup?:none|worktree|worktree+branch, sourceCommit?:string, sourceCommits?:record<string>, expectedTarget?:{path:string, ref:string|null, commit:string}, expectedTargets?:record<{path:string, ref:string|null, commit:string}>)',
  'hive_worktree_cleanup(feature?:string, task:string, repoIds?:string[], candidate?:string, deleteBranch?:boolean, discard?:boolean)',
  'hive_adhoc_worktree_create(runId?:string, repoIds?:string[], sourceDirectory?:string)',
  'hive_adhoc_worktree_inspect(runId:string, repoIds?:string[], sourceDirectory?:string)',
  'hive_adhoc_worktree_merge(runId:string, repoIds?:string[], sourceDirectory?:string, historyIntent:preserve-source|rewrite-private, strategy?:merge|squash|rebase, message?:string, preserveConflicts?:boolean, cleanup?:none|worktree|worktree+branch, sourceCommit?:string, sourceCommits?:record<string>, expectedTarget?:{path:string, ref:string|null, commit:string}, expectedTargets?:record<{path:string, ref:string|null, commit:string}>)',
  'hive_adhoc_worktree_cleanup(runId:string, repoIds?:string[], sourceDirectory?:string, deleteBranch?:boolean, discard?:boolean)',
  'hive_worktree_recover(operationId?:string, markerDigest?:string, observedStateDigest?:string, mutatorsStopped?:boolean, sourceDirectory?:string)',
  'hive_context_read(name?:string, scope?:feature|project, feature?:string, view?:summary|catalog, query?:string, limit?:number, cursor?:string, maxBytes?:number, scanChars?:boolean)',
  'hive_context_write(name:string, content:string, kind?:durable|evidence, task?:string, expectedRevision?:number, expectedContentHash?:string, scope?:feature|project, feature?:string)',
  'hive_context_append(name:string, content:string, section?:string, task?:string, expectedRevision:number, expectedContentHash:string, scope?:feature|project, feature?:string)',
  'hive_context_edit(name:string, oldText:string, newText:string, expectedRevision:number, expectedContentHash:string, scope?:feature|project, feature?:string)',
  'hive_context_archive(names:string[], reason:string, expectedRevision:number, expectedContentHashes:record<string>, scope?:feature|project, feature?:string)',
  'hive_constraints_read(scope?:session|feature, feature?:string)',
  'hive_constraints_add(constraints:string, scope?:session|feature, feature?:string)',
  'hive_constraints_edit(id:string, expectedRevision:number, constraints?:string, remove?:boolean, scope?:session|feature, feature?:string)',
  'hive_constraints_clear(expectedRevision:number, scope?:session|feature, feature?:string)',
  'hive_worklog_list(kind?:feature|session, limit?:number, cursor?:string, maxBytes?:number)',
  'hive_worklog_read(ref?:{kind:"feature", featureName:string}|{kind:"session", owner:opencode-v1|opencode-v2, sessionId:string}, view?:brief|history|facts, limit?:number, cursor?:string, maxBytes?:number)',
  'hive_worklog_record(ref:{kind:"feature", featureName:string}|{kind:"session", owner:opencode-v1|opencode-v2, sessionId:string}, operationId:string, title?:string, checkpoint:{summary:string, detail?:string, references?:{kind:"path", path:string, label?:string}|{kind:"url", url:string, label?:string}[], corrects?:number[]}, briefing?:string, expectedRevision?:number)',
  'hive_status(feature?:string)',
  'hive_git_snapshot(directory?:string, repositoryIds?:string[], baseRef?:string, targetRef?:string, range?:string, paths?:string[], maxFiles?:number, maxPatchBytes?:number)',
];

const NATIVE_TRACE_AND_BACKGROUND_TOOLS = [
  'hive_task_trace', 'hive_task_trace_content',
  'hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel',
];

describe('ordinary Hive operation arguments', () => {
  it('registers the 35 ordinary operations after the trace and background tools, with their argument shapes', async () => {
    const { hooks } = await createRuntime();
    const registered = Object.entries(hooks.tool as Record<string, { args: any }>);
    const ordinary = registered.filter(([name]) => !NATIVE_TRACE_AND_BACKGROUND_TOOLS.includes(name));
    expect(ordinary.map(([name, definition]) => `${name}(${fields(z.toJSONSchema(z.object(definition.args)))})`)).toEqual(ORDINARY_OPERATION_SIGNATURES);
    expect(registered.slice(0, 6).map(([name]) => name).sort()).toEqual([...NATIVE_TRACE_AND_BACKGROUND_TOOLS].sort());
    expect(registered.map(([name]) => name).sort()).toEqual([...HIVE_TOOL_NAMES].sort());
  });

  it('strips unknown fields and declares no defaults, so input is never stricter than the declared shape', async () => {
    const { hooks } = await createRuntime();
    for (const [name, definition] of Object.entries(hooks.tool as Record<string, { args: any }>)) {
      if (NATIVE_TRACE_AND_BACKGROUND_TOOLS.includes(name)) continue;
      const schema = z.object(definition.args);
      const json = z.toJSONSchema(schema);
      expect(JSON.stringify(json), name).not.toContain('"default"');
      const minimal = sample(json) as Record<string, unknown>;
      const parsed = schema.parse({ ...minimal, unexpected: 1 });
      expect(parsed, name).toEqual(minimal);
      expect(schema.safeParse({}).success, name).toBe(Object.keys(minimal).length === 0);
    }
  });

  it('accepts an explicitly featureless selection and rejects an omitted one', async () => {
    const { hooks } = await createRuntime();
    const schema = z.object((hooks.tool as any).hive_feature_select.args);
    expect(schema.parse({ feature: null })).toEqual({ feature: null });
    expect(schema.safeParse({}).success).toBe(false);
  });
});

// Fields whose meaning depends on another argument, an effect or a retry rule carry a description beside the argument.
const DESCRIBED_FIELDS: Record<string, string[]> = {
  hive_plan_approve: ['expectedRevision', 'sync', 'refreshPending', 'refreshTasks'],
  hive_tasks_sync: ['refreshPending'],
  hive_task_update: ['status', 'blocker', 'report', 'handoff'],
  hive_worktree_create: ['baseRef', 'repoIds', 'candidate'],
  hive_worktree_inspect: ['repoIds', 'candidate'],
  hive_worktree_cleanup: ['repoIds', 'candidate', 'deleteBranch', 'discard'],
  hive_adhoc_worktree_create: ['runId', 'repoIds', 'sourceDirectory'],
  hive_adhoc_worktree_inspect: ['repoIds', 'sourceDirectory'],
  hive_adhoc_worktree_cleanup: ['repoIds', 'sourceDirectory', 'deleteBranch', 'discard'],
  hive_worktree_recover: ['operationId', 'markerDigest', 'observedStateDigest', 'mutatorsStopped', 'sourceDirectory'],
  hive_context_read: ['name', 'scope', 'view', 'query', 'limit', 'cursor', 'maxBytes', 'scanChars'],
  hive_context_write: ['content', 'kind', 'task', 'expectedRevision', 'expectedContentHash', 'scope'],
  hive_context_append: ['content', 'section', 'task', 'expectedRevision', 'expectedContentHash', 'scope'],
  hive_context_edit: ['name', 'oldText', 'newText', 'expectedRevision', 'expectedContentHash', 'scope', 'feature'],
  hive_context_archive: ['reason', 'expectedRevision', 'expectedContentHashes', 'scope'],
  hive_worklog_list: ['kind', 'limit', 'cursor', 'maxBytes'],
  hive_worklog_read: ['ref', 'view', 'limit', 'cursor', 'maxBytes'],
  hive_worklog_record: ['ref', 'operationId', 'title', 'checkpoint', 'briefing', 'expectedRevision'],
  ...Object.fromEntries(['hive_worktree_merge', 'hive_adhoc_worktree_merge'].map((name) => [name, [
    'historyIntent', 'strategy', 'message', 'preserveConflicts', 'cleanup', 'sourceCommit', 'sourceCommits', 'expectedTarget', 'expectedTargets',
  ]])),
};

describe('ordinary Hive operation metadata', () => {
  it('delivers each operation description and argument schema to the v1 host unchanged', async () => {
    const { hooks } = await createRuntime();
    const operations = createHiveOperations({} as any);
    for (const [name, operation] of Object.entries(operations)) {
      const registered = (hooks.tool as Record<string, { description: string; args: any }>)[name]!;
      expect(registered.description, name).toBe(operation.description);
      expect(z.toJSONSchema(z.object(registered.args)), name).toEqual(z.toJSONSchema(z.object(operation.args)));
    }
  });

  it('describes the fields that depend on another argument, an effect or a retry rule', async () => {
    const { hooks } = await createRuntime();
    for (const [name, fieldNames] of Object.entries(DESCRIBED_FIELDS)) {
      const schema = z.toJSONSchema(z.object((hooks.tool as any)[name].args)) as any;
      for (const field of fieldNames) {
        expect(schema.properties[field]?.description, `${name}.${field}`).toEqual(expect.any(String));
        expect(schema.properties[field].description.trim().length, `${name}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('states the exactly-one target expectation, the repository-key rule and the omitted-pin meaning on both merge tools', async () => {
    const { hooks } = await createRuntime();
    for (const name of ['hive_worktree_merge', 'hive_adhoc_worktree_merge']) {
      const registered = (hooks.tool as any)[name] as { description: string; args: any };
      const schema = z.toJSONSchema(z.object(registered.args)) as any;
      const { expectedTarget, expectedTargets, sourceCommit, sourceCommits } = schema.properties;
      expect(expectedTarget.description, name).toContain('Exactly one of expectedTarget and expectedTargets');
      expect(expectedTargets.description, name).toContain('Keys must exactly match every candidate repository');
      expect(expectedTarget.properties.ref.description, name).toContain('null when the destination is detached');
      expect(sourceCommits.description, name).toContain('Keys must exactly match every inspected repository');
      expect(sourceCommit.description, name).toContain('does not show it was verified');
      expect(registered.description, name).toContain('not evidence that it was verified');
      // Boundary errors throw, classified failures return success: false, and success: true can still need cleanup recovery.
      expect(registered.description, name).toContain('a source pin that conflicts with the inspection throws an error');
      expect(registered.description, name).toContain('Failures the merge service classifies return success: false');
      expect(registered.description, name).toContain('even when success is true');
      // Descriptions explain the relationships; the argument shape still leaves both expectations optional.
      expect(schema.required, name).not.toContain('expectedTarget');
      expect(schema.required, name).not.toContain('expectedTargets');
      // History intent is required and has no default; the strategy default follows the intent.
      expect(schema.required, name).toContain('historyIntent');
      expect(schema.properties.historyIntent.enum, name).toEqual(['preserve-source', 'rewrite-private']);
      expect(schema.properties.historyIntent.description, name).toContain('there is no default');
      expect(schema.properties.strategy.description, name).toContain("'merge' for preserve-source, 'squash' for rewrite-private");
      expect(schema.properties.strategy.description, name).not.toContain("Default 'squash'");
    }
  });
});

describe('context edit failure guarantees', () => {
  it('promises no write only for refusals before publication and names the publication-error recovery', async () => {
    const { hooks } = await createRuntime();
    const edit = (hooks.tool as any).hive_context_edit as { description: string; args: any };
    const schema = z.toJSONSchema(z.object(edit.args)) as any;
    expect(edit.description).toContain('A call refused before publication (invalid or oversized text, a stale revision or hash, no match, an ambiguous match, identical text, invalid metadata) writes nothing');
    expect(edit.description).toContain('An error while publishing can leave the document or index uncertain');
    expect(edit.description).toContain('a pending marker remains and managed mutations then report context_reconciliation_required');
    expect(edit.description).toContain('do not assume a same-argument retry is safe');
    expect(edit.description).not.toContain('Nothing is written on any failure');
    expect(schema.properties.feature.description).toContain('Project scope forbids it');
  });
});

describe('ordinary Hive operation metadata retention and naming', () => {
  it('describes task sync retention by current status and history, the refresh handoff, and keeps candidate naming out of the argument text', async () => {
    const { hooks } = await createRuntime();
    const tools = hooks.tool as Record<string, { description: string; args: any }>;
    expect(tools.hive_tasks_sync!.description).toContain('whose current status is not pending');
    expect(tools.hive_tasks_sync!.description).toContain('only when it has no execution history');
    expect(tools.hive_tasks_sync!.description).toContain('Started tasks are refreshed only through hive_plan_approve with refreshTasks');
    expect(tools.hive_tasks_sync!.description).not.toContain('including any report or handoff');
    const refreshTasks = (z.toJSONSchema(z.object(tools.hive_plan_approve!.args)) as any).properties.refreshTasks.description as string;
    expect(refreshTasks).toContain('attests that no assignment for it is still running');
    for (const name of ['hive_plan_read', 'hive_plan_write', 'hive_plan_patch', 'hive_plan_approve', 'hive_tasks_sync']) {
      expect(tools[name]!.description, name).toContain('it never approves, syncs or blocks anything');
    }
    const candidate = (z.toJSONSchema(z.object(tools.hive_worktree_create!.args)) as any).properties.candidate.description as string;
    expect(candidate).not.toMatch(/\{task\}|--/);
  });
});

describe('ordinary Hive operation results', () => {
  it('presents structured results as two-space JSON and the manual task folder name as plain text', async () => {
    const { call } = await createRuntime();
    const created = await call('hive_feature_create', { name: 'contract-feature', ticket: 'T-1' });
    expect(created).toBe(JSON.stringify(JSON.parse(created), null, 2));
    expect(JSON.parse(created)).toMatchObject({ name: 'contract-feature', status: 'planning', ticket: 'T-1' });
    await call('hive_plan_write', { feature: 'contract-feature', content: '# Plan\n\n## Tasks\n\n### 1. First\nDo it.\n' });
    expect(await call('hive_task_create', { feature: 'contract-feature', name: 'manual' })).toBe('01-manual');
    expect(await call('hive_worktree_inspect', { feature: 'contract-feature', task: 'missing' })).toBe('null');
  });

  it('resolves no route for operations that name no feature, leaving a corrupt session index untouched', async () => {
    const { root, call, callJson } = await createRuntime();
    const sessions = path.join(root, '.hive', 'sessions.json');
    fs.writeFileSync(sessions, '{ malformed session index');
    await callJson('hive_feature_create', { name: 'independent' }, 'unrelated-session');
    expect((await callJson('hive_repositories_status', {}, 'unrelated-session')).mode).toBe('legacy-root');
    expect(await callJson('hive_plan_read', { feature: 'independent' }, 'unrelated-session')).toBeNull();
    expect(await callJson('hive_context_read', { feature: 'independent' }, 'unrelated-session')).toMatchObject({ scope: { type: 'feature', featureName: 'independent' } });
    expect(await callJson('hive_context_read', { scope: 'project' }, 'unrelated-session')).toMatchObject({ scope: { type: 'project' } });
    expect(await callJson('hive_git_snapshot', { directory: 'relative' }, 'unrelated-session')).toMatchObject({ status: 'failed' });
    expect(fs.readFileSync(sessions, 'utf8')).toBe('{ malformed session index');
    expect(await call('hive_worktree_inspect', { feature: 'independent', task: 'none' }, 'unrelated-session')).toBe('null');
    expect(fs.readFileSync(sessions, 'utf8')).toBe('{ malformed session index');
  });

  it('resolves the session route only when a feature is omitted', async () => {
    const { callJson, failure } = await createRuntime();
    await callJson('hive_feature_create', { name: 'routed' });
    await callJson('hive_feature_create', { name: 'other' });
    expect(await failure('hive_plan_read', {}, 'unrouted')).toBe('Feature is required. Select one with hive_feature_select or pass feature explicitly.');
    await callJson('hive_feature_select', { feature: 'routed' }, 'routed-session');
    expect(await callJson('hive_context_read', {}, 'routed-session')).toMatchObject({ scope: { featureName: 'routed' } });
    expect(await callJson('hive_context_read', { feature: 'other' }, 'routed-session')).toMatchObject({ scope: { featureName: 'other' } });
    await callJson('hive_feature_select', { feature: null }, 'routed-session');
    expect(await failure('hive_context_read', {}, 'routed-session')).toBe('Feature is required. Select one with hive_feature_select or pass feature explicitly.');
  });

  it('returns a failed snapshot envelope for each rejected request instead of throwing', async () => {
    const { root, callJson } = await createRuntime();
    const failed = async (args: Record<string, unknown>) => {
      const result = await callJson('hive_git_snapshot', args);
      expect(result).toMatchObject({ schema: 'hive-git-snapshot/v1', status: 'failed', consistency: 'failed' });
      return result.failures.map((failure: { code: string; message: string }) => `${failure.code}: ${failure.message}`);
    };
    expect(await failed({ directory: 'relative' })).toEqual(['INVALID_REQUEST: directory must be absolute']);
    expect(await failed({ directory: root, repositoryIds: ['root'] })).toEqual(['INVALID_REQUEST: directory cannot be combined with repositoryIds']);
    expect(await failed({ repositoryIds: ['root'] })).toEqual(['INVALID_REQUEST: repositoryIds require a repository manifest']);
    expect(await failed({ repositoryIds: [] })).toEqual(['INVALID_REQUEST: repositoryIds require a repository manifest']);
    expect(await failed({ directory: path.join(root, 'missing') })).toHaveLength(1);
  });

  it('validates sourceDirectory and repoIds before any worktree work', async () => {
    const { root, failure } = await createRuntime();
    expect(await failure('hive_adhoc_worktree_create', { sourceDirectory: 'relative' })).toBe('sourceDirectory must be absolute');
    expect(await failure('hive_adhoc_worktree_inspect', { runId: 'none', sourceDirectory: 'relative' })).toBe('sourceDirectory must be absolute');
    expect(await failure('hive_adhoc_worktree_inspect', { runId: 'none', sourceDirectory: root, repoIds: ['a'] }))
      .toBe('sourceDirectory cannot be combined with repoIds for a foreign checkout; omit sourceDirectory for the active project root');
    expect(await failure('hive_adhoc_worktree_merge', { runId: 'none', sourceDirectory: root, repoIds: ['a'] }))
      .toContain('sourceDirectory cannot be combined with repoIds');
    expect(await failure('hive_adhoc_worktree_cleanup', { runId: 'none', sourceDirectory: 'relative' })).toBe('sourceDirectory must be absolute');
  });

  it('requires worktree repoIds to match the task repository selection', async () => {
    const { callJson, failure } = await createRuntime();
    await callJson('hive_feature_create', { name: 'repos' });
    await callJson('hive_plan_write', { feature: 'repos', content: '# Plan\n\n## Tasks\n\n### 1. First\nDo it.\n' });
    const expected = 'repoIds must match the task repository selection: (single root)';
    for (const name of ['hive_worktree_create', 'hive_worktree_inspect', 'hive_worktree_merge', 'hive_worktree_cleanup']) {
      expect(await failure(name, { feature: 'repos', task: '01-first', repoIds: ['unknown'] }), name).toBe(expected);
    }
  });

  it('rejects merge pins that conflict with the inspected candidate before merging', async () => {
    const { callJson, failure } = await createRuntime();
    await callJson('hive_adhoc_worktree_create', { runId: 'pins' });
    expect(await failure('hive_adhoc_worktree_merge', { runId: 'pins', sourceCommit: 'a', sourceCommits: { root: 'a' } })).toBe('sourceCommit and sourceCommits cannot both be supplied');
    expect(await failure('hive_adhoc_worktree_merge', { runId: 'pins', sourceCommits: { root: 'a' } })).toBe('sourceCommits require a composite candidate');
    expect(await failure('hive_adhoc_worktree_merge', { runId: 'pins', sourceCommit: 'beef' })).toBe('sourceCommit does not match the inspected candidate');
    const missingTarget = await callJson('hive_adhoc_worktree_merge', { runId: 'pins', historyIntent: 'rewrite-private', message: 'feat: x\n\nbody' });
    expect(missingTarget).toMatchObject({ success: false, merged: false, error: 'expectedTarget or expectedTargets is required', reasonCode: 'INVALID_ARGUMENTS', mutation: 'none' });
  });

  // The executors forward intent and strategy unchanged; the service owns validation and the intent-derived default.
  it('forwards history intent and an omitted strategy to the merge services without a default', async () => {
    const { call, callJson } = await createRuntime();
    await callJson('hive_adhoc_worktree_create', { runId: 'intent' });
    const inspected = await callJson('hive_adhoc_worktree_inspect', { runId: 'intent' });

    const missing = await callJson('hive_adhoc_worktree_merge', { runId: 'intent', expectedTarget: inspected.target });
    expect(missing).toMatchObject({ success: false, reasonCode: 'INVALID_ARGUMENTS', mutation: 'none' });
    expect(missing.error).toContain('historyIntent is required');
    expect(missing).not.toHaveProperty('strategy');

    const contained = await callJson('hive_adhoc_worktree_merge', { runId: 'intent', historyIntent: 'preserve-source', expectedTarget: inspected.target });
    expect(contained).toMatchObject({ success: true, merged: false, strategy: 'merge', reasonCode: 'ALREADY_INTEGRATED' });

    await callJson('hive_feature_create', { name: 'intent-feature' });
    await callJson('hive_plan_write', { feature: 'intent-feature', content: '# Plan\n\n## Tasks\n\n### 1. First\nDo it.\n' });
    expect(await call('hive_task_create', { feature: 'intent-feature', name: 'manual' })).toBe('01-manual');
    const task = await callJson('hive_worktree_create', { feature: 'intent-feature', task: '01-manual' });
    const featureMissing = await callJson('hive_worktree_merge', { feature: 'intent-feature', task: '01-manual', expectedTarget: task.target });
    expect(featureMissing).toMatchObject({ success: false, reasonCode: 'INVALID_ARGUMENTS' });
    expect(featureMissing).not.toHaveProperty('strategy');
    const featureContained = await callJson('hive_worktree_merge', {
      feature: 'intent-feature', task: '01-manual', historyIntent: 'rewrite-private', expectedTarget: task.target,
    });
    expect(featureContained).toMatchObject({ success: true, strategy: 'squash', reasonCode: 'ALREADY_INTEGRATED', taskUpdateRecommended: true });
  });

  it('returns a created worktree with its failed finalization instead of an error', async () => {
    const { callJson } = await createRuntime();
    const originalUnlink = fs.unlinkSync;
    const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation(((target: fs.PathLike) => {
      if (String(target).includes(`${path.sep}operations${path.sep}`) && String(target).endsWith('.json')) {
        throw Object.assign(new Error('marker unlink failed'), { code: 'EIO' });
      }
      return originalUnlink(target);
    }) as typeof fs.unlinkSync);
    let created: any;
    try {
      created = await callJson('hive_adhoc_worktree_create', { runId: 'kept' });
    } finally {
      unlinkSpy.mockRestore();
    }
    expect(created).toMatchObject({ runId: 'kept', branch: 'hive/adhoc/kept', finalization: { markers: 'retained', action: 'manual_recovery' } });
    expect(fs.existsSync(created.path)).toBe(true);
    const { pendingOperations } = await callJson('hive_worktree_recover', {});
    expect(pendingOperations.map((entry: any) => entry.operationId)).toEqual([created.finalization.operationId]);
  });

  it('guards context mutation by revision and content hash', async () => {
    const { callJson, failure } = await createRuntime();
    await callJson('hive_feature_create', { name: 'guarded' });
    const frontmatter = '---\ndescription: Notes.\nread_when: Always.\n---\n# Notes\n';
    const created = await callJson('hive_context_write', { feature: 'guarded', name: 'notes', content: frontmatter });
    expect(created.revision).toBe(1);
    const named = await callJson('hive_context_read', { feature: 'guarded', name: 'notes' });
    const appended = await callJson('hive_context_append', { feature: 'guarded', name: 'notes', content: '## More', expectedRevision: named.revision, expectedContentHash: named.file.contentHash });
    expect(appended.revision).toBe(2);
    const stale = 'Context changed since revision 1; current revision is 2.';
    expect(await failure('hive_context_append', { feature: 'guarded', name: 'notes', content: '## Again', expectedRevision: 1, expectedContentHash: named.file.contentHash })).toBe(stale);
    expect(await failure('hive_context_write', { feature: 'guarded', name: 'notes', content: 'replaced', expectedRevision: 1, expectedContentHash: named.file.contentHash })).toBe(stale);
    expect(await failure('hive_context_archive', { feature: 'guarded', names: ['notes'], reason: 'r', expectedRevision: 1, expectedContentHashes: { notes: named.file.contentHash } })).toBe(stale);
    expect(await failure('hive_context_edit', { feature: 'guarded', name: 'notes', oldText: '## More', newText: '## Less', expectedRevision: 1, expectedContentHash: named.file.contentHash })).toBe(stale);
    const current = await callJson('hive_context_read', { feature: 'guarded', name: 'notes' });
    const edit = { feature: 'guarded', name: 'notes', expectedRevision: current.revision, expectedContentHash: current.file.contentHash };
    expect(await failure('hive_context_edit', { ...edit, oldText: '# notes', newText: '# Log' })).toContain('oldText does not occur in context "notes"');
    expect(await failure('hive_context_edit', { ...edit, oldText: 'e', newText: 'E' })).toContain('Include enough surrounding text to match exactly one passage');
    const edited = await callJson('hive_context_edit', { ...edit, oldText: '# Notes', newText: '# Log' });
    expect(edited).toMatchObject({ revision: 3, file: { name: 'notes', kind: 'durable' } });
    expect((await callJson('hive_context_read', { feature: 'guarded', name: 'notes' })).file.content).toStartWith(frontmatter.replace('# Notes', '# Log'));
    expect(await failure('hive_context_edit', { scope: 'project', feature: 'guarded', name: 'notes', oldText: 'a', newText: 'b', expectedRevision: 0, expectedContentHash: current.file.contentHash })).toBe('Project context does not accept feature or task selectors');
    expect(await failure('hive_context_write', { scope: 'project', feature: 'guarded', name: 'x', content: 'x' })).toBe('Project context does not accept feature or task selectors');
    expect(await failure('hive_context_read', { feature: 'guarded', name: 'notes', maxBytes: 100 })).toBe('maxBytes must be between 256 and 65536.');
    expect(await failure('hive_context_read', { feature: 'guarded', name: 'notes', cursor: 'invalid' })).toBe('The named-read cursor is invalid, expired, or belongs to another document.');
  });

  it('reports a failed handoff write with the report already in history', async () => {
    const { root, callJson } = await createRuntime();
    await callJson('hive_feature_create', { name: 'partial' });
    await callJson('hive_plan_write', { feature: 'partial', content: '# Plan\n\n## Tasks\n\n### 1. First\nDo it.\n' });
    await callJson('hive_plan_approve', { feature: 'partial', sync: true, expectedRevision: (await callJson('hive_plan_read', { feature: 'partial' })).revision });
    const taskDir = path.join(root, '.hive', 'features', fs.readdirSync(path.join(root, '.hive', 'features'))[0]!, 'tasks', '01-first');
    fs.mkdirSync(path.join(taskDir, 'handoff.md'));
    const failed = await callJson('hive_task_update', { feature: 'partial', task: '01-first', report: 'The report.', handoff: 'Next.' });
    expect(failed).toMatchObject({ success: false, reason: 'task_update_persistence_failed', failedStage: 'handoff', reportHistoryWritten: true, handoffWritten: false });
    expect(fs.readFileSync(failed.reportPath, 'utf8')).toBe('The report.');
  });
});

// Every file under .hive with its bytes, so a read can be shown to have written nothing.
function hiveTree(root: string): Record<string, string> {
  const tree: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { tree[`${path.relative(root, full)}/`] = ''; walk(full); }
      else tree[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(path.join(root, '.hive'));
  return tree;
}

describe('Worklog operations', () => {
  it('targets the explicit, selected, or own-session log and never a detected or sole live feature', async () => {
    const { root, callJson, failure } = await createRuntime();
    await callJson('hive_feature_create', { name: 'checkout' });
    const own = (sessionId: string) => ({ kind: 'session', owner: 'opencode-v1', sessionId });
    // Unset route with a sole live feature: the caller's own log, not the feature.
    expect(await callJson('hive_worklog_read', {}, 's-unset')).toMatchObject({ view: 'brief', exists: false, revision: 0, ref: own('s-unset'), key: 'session:opencode-v1:s-unset' });
    await callJson('hive_feature_select', { feature: 'checkout' }, 's-selected');
    expect(await callJson('hive_worklog_read', {}, 's-selected')).toMatchObject({ exists: false, ref: { kind: 'feature', featureName: 'checkout' }, key: 'feature:checkout' });
    await callJson('hive_feature_select', { feature: null }, 's-null');
    expect((await callJson('hive_worklog_read', {}, 's-null')).ref).toEqual(own('s-null'));
    expect((await callJson('hive_worklog_read', { ref: { kind: 'feature', featureName: 'checkout' } }, 's-null')).ref).toEqual({ kind: 'feature', featureName: 'checkout' });
    // A detected feature worktree does not route the Worklog either.
    const detected = createHiveServices({ projectRoot: root, detectedFeature: 'checkout', nativeObservationOwner: 'opencode-v1' });
    expect(detected.resolveFeature(undefined, { sessionID: 's-detected' })).toBe('checkout');
    expect(detected.resolveWorklogRef(undefined, { sessionID: 's-detected' })).toEqual(own('s-detected'));
    // A selected feature that does not resolve fails in core; it does not fall back to the session log or create a directory.
    // A selection whose feature was later renamed away.
    await callJson('hive_feature_create', { name: 'ghost' });
    await callJson('hive_feature_select', { feature: 'ghost' }, 's-ghost');
    const featuresDir = path.join(root, '.hive', 'features');
    const metadata = path.join(featuresDir, fs.readdirSync(featuresDir).find((name) => name.endsWith('ghost'))!, 'feature.json');
    fs.writeFileSync(metadata, JSON.stringify({ ...JSON.parse(fs.readFileSync(metadata, 'utf8')), name: 'renamed' }));
    const features = fs.readdirSync(featuresDir);
    expect(await callJson('hive_worklog_read', {}, 's-ghost')).toMatchObject({ success: false, reason: 'feature_not_found', ref: { kind: 'feature', featureName: 'ghost' } });
    expect(fs.readdirSync(path.join(root, '.hive', 'features'))).toEqual(features);
    expect(await failure('hive_worklog_read', {}, '')).toContain('Session identity is required');
  });

  it('reads and lists without writing and leaves a corrupt session index untouched', async () => {
    const { root, callJson, failure } = await createRuntime();
    await callJson('hive_feature_create', { name: 'checkout' });
    await callJson('hive_worklog_record', { ref: { kind: 'feature', featureName: 'checkout' }, operationId: 'one', checkpoint: { summary: 'Planned' } }, 's1');
    const before = hiveTree(root);
    for (const view of ['brief', 'history', 'facts']) {
      await callJson('hive_worklog_read', { ref: { kind: 'feature', featureName: 'checkout' }, view }, 's1');
      await callJson('hive_worklog_read', { view }, 's-other');
    }
    const listed = await callJson('hive_worklog_list', { kind: 'feature' });
    expect(listed.worklogs).toEqual([expect.objectContaining({ key: 'feature:checkout', title: 'Planned', revision: 1, ref: { kind: 'feature', featureName: 'checkout' } })]);
    expect(hiveTree(root)).toEqual(before);
    const index = path.join(root, '.hive', 'sessions.json');
    fs.writeFileSync(index, '{not json');
    expect(await failure('hive_worklog_read', {}, 's1')).toContain('left unchanged for explicit recovery');
    expect(fs.readFileSync(index, 'utf8')).toBe('{not json');
    // An explicit ref needs no session route.
    expect((await callJson('hive_worklog_read', { ref: { kind: 'feature', featureName: 'checkout' } }, 's1')).revision).toBe(1);
    expect(fs.readFileSync(index, 'utf8')).toBe('{not json');
  });

  it('stamps the host author, keeps session logs to their own session, and surfaces core revision guards and replays', async () => {
    const { callJson } = await createRuntime();
    await callJson('hive_feature_create', { name: 'checkout' });
    const own = await callJson('hive_worklog_read', {}, 's1');
    const forged = { owner: 'opencode-v2', sessionId: 'someone', agent: 'forged' };
    const first = await callJson('hive_worklog_record', { ref: own.ref, operationId: 'a', checkpoint: { summary: 'Started' }, author: forged }, 's1', 'hive-builder');
    expect(first).toMatchObject({ key: 'session:opencode-v1:s1', committedRevision: 1, replayed: false, entry: { author: { owner: 'opencode-v1', sessionId: 's1', agent: 'hive-builder' } } });
    for (const ref of [{ ...own.ref, sessionId: 's2' }, { ...own.ref, owner: 'opencode-v2' }]) {
      expect(await callJson('hive_worklog_record', { ref, operationId: 'b', checkpoint: { summary: 'Elsewhere' } }, 's1')).toMatchObject({ success: false, reason: 'author_mismatch', ref });
    }

    const feature = { kind: 'feature', featureName: 'checkout' };
    const briefed = { ref: feature, operationId: 'f1', checkpoint: { summary: 'Plan approved' }, briefing: 'Plan approved; schema task next.', expectedRevision: 0 };
    expect(await callJson('hive_worklog_record', briefed, 's1')).toMatchObject({ committedRevision: 1, briefingUpdated: true });
    // Another primary shares the feature log.
    expect((await callJson('hive_worklog_record', { ref: feature, operationId: 'f2', checkpoint: { summary: 'Schema merged' } }, 's2', 'swarm-orchestrator')).committedRevision).toBe(2);
    const stale = await callJson('hive_worklog_record', { ref: feature, operationId: 'f3', checkpoint: { summary: 'API started' }, briefing: 'API next.', expectedRevision: 1 }, 's1');
    expect(stale).toMatchObject({ success: false, reason: 'stale_revision', details: { currentRevision: 2 } });
    const reread = await callJson('hive_worklog_read', { ref: feature }, 's1');
    expect(reread).toMatchObject({ revision: 2, checkpointsSinceBriefing: 1, briefing: { text: 'Plan approved; schema task next.', entryId: 1 } });
    expect(await callJson('hive_worklog_record', { ref: feature, operationId: 'f4', checkpoint: { summary: 'API started' }, briefing: 'Schema merged; API running.', expectedRevision: reread.revision }, 's1')).toMatchObject({ committedRevision: 3 });
    // A lost response is resolved by resending the identical request, even after later entries.
    expect(await callJson('hive_worklog_record', briefed, 's1')).toMatchObject({ replayed: true, committedRevision: 1, currentRevision: 3 });
    expect(await callJson('hive_worklog_record', { ...briefed, checkpoint: { summary: 'Different' } }, 's1')).toMatchObject({ success: false, reason: 'operation_conflict', details: { entryId: 1 } });
  });

  it('presents Worklog results as compact JSON so maxBytes bounds the text the host receives', async () => {
    const { call, callJson } = await createRuntime();
    await callJson('hive_feature_create', { name: 'checkout' });
    const feature = { kind: 'feature', featureName: 'checkout' };
    const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

    // Core fits an empty list at its compact size; the emitted text must not grow past that budget.
    const exact = bytes(JSON.stringify(await callJson('hive_worklog_list', {})));
    const fitted = await call('hive_worklog_list', { maxBytes: exact });
    expect(bytes(fitted)).toBe(exact);
    expect(bytes(JSON.stringify(JSON.parse(fitted), null, 2))).toBeGreaterThan(exact);
    // Below the envelope the honest outcome is a structured error that names the size it needs.
    expect(await callJson('hive_worklog_list', { maxBytes: exact - 1 })).toMatchObject({ success: false, reason: 'response_too_large', details: { requiredBytes: exact } });

    for (let index = 1; index <= 6; index++) {
      const recorded = await call('hive_worklog_record', { ref: feature, operationId: `op-${index}`, checkpoint: { summary: `Checkpoint ${index}`, detail: `${index}`.repeat(300) } }, 's1');
      // A record result is not bounded by a read budget, but it uses the same serialization.
      expect(recorded).toBe(JSON.stringify(JSON.parse(recorded)));
    }
    const read = (view: string, maxBytes: number, cursor?: string) => call('hive_worklog_read', { ref: feature, view, limit: 50, maxBytes, cursor }, 's1');
    for (const view of ['brief', 'history', 'facts', 'list']) {
      const open = (maxBytes: number) => view === 'list' ? call('hive_worklog_list', { maxBytes }) : read(view, maxBytes);
      const whole = bytes(JSON.stringify(JSON.parse(await open(64 * 1024))));
      for (const budget of [whole, whole - 1, Math.floor(whole / 2)]) {
        const text = await open(budget);
        const parsed = JSON.parse(text);
        if (parsed.success === false) expect(parsed.reason, `${view} ${budget}`).toBe('response_too_large');
        else expect(bytes(text), `${view} ${budget}`).toBeLessThanOrEqual(budget);
      }
    }
    // A page cut short by the budget still carries its cursor and stays within it.
    const whole = bytes(JSON.stringify(JSON.parse(await read('history', 64 * 1024))));
    const first = JSON.parse(await read('history', whole - 1));
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.entries.length).toBeGreaterThan(0);
    expect(bytes(await read('history', whole - 1))).toBeLessThanOrEqual(whole - 1);
  });

  it('passes a WorklogError reason and details through unchanged, including an uncertain publication', () => {
    const uncertain = new WorklogError('io_error', 'Worklog write failed.', { stage: 'write', code: 'EIO', publication: 'uncertain' });
    const operations = createHiveOperations({ nativeObservationOwner: 'opencode-v1', worklogService: { record: () => { throw uncertain; } } } as any);
    const ref = { kind: 'feature', featureName: 'checkout' };
    expect(operations.hive_worklog_record!.execute({ ref, operationId: 'a', checkpoint: { summary: 'x' } }, { sessionID: 's1', agent: 'hive-master' }))
      .toEqual({ success: false, reason: 'io_error', error: 'Worklog write failed.', details: { stage: 'write', code: 'EIO', publication: 'uncertain' }, ref });
    expect(() => operations.hive_worklog_record!.execute({ ref, operationId: 'a', checkpoint: { summary: 'x' } }, { sessionID: 's1' })).toThrow('calling session and agent');
  });

  it('checks the role grant and the live parent before recording, failing closed when the session cannot be read', async () => {
    const { root, sessions, callJson, failure } = await createRuntime();
    const ref = (sessionId: string) => ({ kind: 'session', owner: 'opencode-v1', sessionId });
    const record = (sessionId: string) => ({ ref: ref(sessionId), operationId: 'a', checkpoint: { summary: 'Recorded' } });
    sessions.set('child', { id: 'child', parentID: 'primary' });
    sessions.set('broken', new Error('gone'));
    // Delegated orchestrators and Architect run in child sessions; the executor denies them whatever the permissions allow.
    for (const agent of ['hive-master', 'architect-planner']) expect(await failure('hive_worklog_record', record('child'), 'child', agent)).toContain('primary-only operation');
    expect(await failure('hive_worklog_record', record('broken'), 'broken')).toContain('could not read session broken');
    expect(await failure('hive_worklog_record', record('root'), 'root', 'forager-worker')).toContain('not granted to the forager-worker role');
    expect(await failure('hive_worklog_record', record('root'), 'root', 'general')).toContain('native general subagent has no Hive tool access');
    expect(fs.existsSync(path.join(root, '.hive', 'worklogs'))).toBe(false);
    // Children still read.
    expect((await callJson('hive_worklog_read', {}, 'child', 'forager-worker')).ref).toEqual(ref('child'));
    for (const agent of ['architect-planner', 'dash-reviewer']) {
      expect((await callJson('hive_worklog_record', record(agent), agent, agent)).entry.author).toEqual({ owner: 'opencode-v1', sessionId: agent, agent });
    }
  });
});
