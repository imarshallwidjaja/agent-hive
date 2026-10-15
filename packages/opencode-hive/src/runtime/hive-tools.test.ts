import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import plugin from '../index.js';
import { HIVE_TOOL_NAMES } from '../utils/plugin-manifest.js';
import { createPluginWithHome } from '../e2e/plugin-test-home.js';
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
  const client = {
    session: {
      get: async ({ path: input }: { path: { id: string } }) => ({ data: { id: input.id } }),
      messages: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      abort: async () => ({ data: true }),
    },
  };
  const hooks = await createPluginWithHome(home, () => plugin.server({ directory: root, worktree: root, project: { id: 'test', worktree: root }, client } as any));
  const call = async (name: string, args: Record<string, unknown>, sessionID?: string): Promise<any> => {
    const context = { sessionID: sessionID ?? 'session', messageID: 'message', agent: 'hive-master', abort: new AbortController().signal };
    return (hooks.tool as any)[name].execute(args, context);
  };
  const callJson = async (name: string, args: Record<string, unknown>, sessionID?: string) => JSON.parse(await call(name, args, sessionID));
  const failure = async (name: string, args: Record<string, unknown>, sessionID?: string): Promise<string> => {
    try { await call(name, args, sessionID); } catch (error) { return (error as Error).message; }
    throw new Error(`${name} did not fail`);
  };
  return { root, hooks, call, callJson, failure };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function typeOf(schema: any): string {
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
  'hive_plan_approve(feature?:string, expectedRevision?:string, sync?:boolean, refreshPending?:boolean)',
  'hive_tasks_sync(feature?:string, refreshPending?:boolean)',
  'hive_task_create(name:string, order?:number, feature?:string, description?:string, goal?:string, acceptanceCriteria?:string[], references?:string[], files?:string[], dependsOn?:string[], reason?:string, source?:string, repos?:string[])',
  'hive_task_update(task:string, status?:pending|in_progress|done|cancelled|blocked|failed|partial, summary?:string, blocker?:{reason:string, options?:string[], recommendation?:string, context?:string}|null, report?:string, handoff?:string, feature?:string)',
  'hive_worktree_create(feature?:string, task:string, baseRef?:string, repoIds?:string[], candidate?:string)',
  'hive_worktree_inspect(feature?:string, task:string, repoIds?:string[], candidate?:string)',
  'hive_worktree_merge(feature?:string, task:string, repoIds?:string[], candidate?:string, strategy?:merge|squash|rebase, message?:string, preserveConflicts?:boolean, cleanup?:none|worktree|worktree+branch, sourceCommit?:string, sourceCommits?:record<string>, expectedTarget?:{path:string, ref:string|null, commit:string}, expectedTargets?:record<{path:string, ref:string|null, commit:string}>)',
  'hive_worktree_cleanup(feature?:string, task:string, repoIds?:string[], candidate?:string, deleteBranch?:boolean, discard?:boolean)',
  'hive_adhoc_worktree_create(runId?:string, repoIds?:string[], sourceDirectory?:string)',
  'hive_adhoc_worktree_inspect(runId:string, repoIds?:string[], sourceDirectory?:string)',
  'hive_adhoc_worktree_merge(runId:string, repoIds?:string[], sourceDirectory?:string, strategy?:merge|squash|rebase, message?:string, preserveConflicts?:boolean, cleanup?:none|worktree|worktree+branch, sourceCommit?:string, sourceCommits?:record<string>, expectedTarget?:{path:string, ref:string|null, commit:string}, expectedTargets?:record<{path:string, ref:string|null, commit:string}>)',
  'hive_adhoc_worktree_cleanup(runId:string, repoIds?:string[], sourceDirectory?:string, deleteBranch?:boolean, discard?:boolean)',
  'hive_context_read(name?:string, scope?:feature|project, feature?:string, view?:summary|catalog, query?:string, limit?:number, cursor?:string, maxBytes?:number, scanChars?:boolean)',
  'hive_context_write(name:string, content:string, kind?:durable|evidence, task?:string, expectedRevision?:number, expectedContentHash?:string, scope?:feature|project, feature?:string)',
  'hive_context_append(name:string, content:string, section?:string, task?:string, expectedRevision:number, expectedContentHash:string, scope?:feature|project, feature?:string)',
  'hive_context_archive(names:string[], reason:string, expectedRevision:number, expectedContentHashes:record<string>, scope?:feature|project, feature?:string)',
  'hive_constraints_read(scope?:session|feature, feature?:string)',
  'hive_constraints_add(constraints:string, scope?:session|feature, feature?:string)',
  'hive_constraints_edit(id:string, expectedRevision:number, constraints?:string, remove?:boolean, scope?:session|feature, feature?:string)',
  'hive_constraints_clear(expectedRevision:number, scope?:session|feature, feature?:string)',
  'hive_status(feature?:string)',
  'hive_git_snapshot(directory?:string, repositoryIds?:string[], baseRef?:string, targetRef?:string, range?:string, paths?:string[], maxFiles?:number, maxPatchBytes?:number)',
];

const NATIVE_TRACE_AND_BACKGROUND_TOOLS = [
  'hive_task_trace', 'hive_task_trace_content',
  'hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel',
];

describe('ordinary Hive operation arguments', () => {
  it('registers the 31 ordinary operations after the trace and background tools, with their argument shapes', async () => {
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
  hive_plan_approve: ['expectedRevision', 'sync', 'refreshPending'],
  hive_tasks_sync: ['refreshPending'],
  hive_task_update: ['status', 'blocker', 'report', 'handoff'],
  hive_worktree_create: ['baseRef', 'repoIds', 'candidate'],
  hive_worktree_inspect: ['repoIds', 'candidate'],
  hive_worktree_cleanup: ['repoIds', 'candidate', 'deleteBranch', 'discard'],
  hive_adhoc_worktree_create: ['runId', 'repoIds', 'sourceDirectory'],
  hive_adhoc_worktree_inspect: ['repoIds', 'sourceDirectory'],
  hive_adhoc_worktree_cleanup: ['repoIds', 'sourceDirectory', 'deleteBranch', 'discard'],
  hive_context_read: ['name', 'scope', 'view', 'query', 'limit', 'cursor', 'maxBytes', 'scanChars'],
  hive_context_write: ['content', 'kind', 'task', 'expectedRevision', 'expectedContentHash', 'scope'],
  hive_context_append: ['content', 'section', 'task', 'expectedRevision', 'expectedContentHash', 'scope'],
  hive_context_archive: ['reason', 'expectedRevision', 'expectedContentHashes', 'scope'],
  ...Object.fromEntries(['hive_worktree_merge', 'hive_adhoc_worktree_merge'].map((name) => [name, [
    'strategy', 'message', 'preserveConflicts', 'cleanup', 'sourceCommit', 'sourceCommits', 'expectedTarget', 'expectedTargets',
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
    }
  });
});

describe('ordinary Hive operation metadata retention and naming', () => {
  it('describes task sync retention by current status and keeps candidate naming out of the argument text', async () => {
    const { hooks } = await createRuntime();
    const tools = hooks.tool as Record<string, { description: string; args: any }>;
    expect(tools.hive_tasks_sync!.description).toContain('whose current status is not pending');
    expect(tools.hive_tasks_sync!.description).toContain('including any report or handoff');
    expect(tools.hive_tasks_sync!.description).not.toContain('execution history');
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
    const missingTarget = await callJson('hive_adhoc_worktree_merge', { runId: 'pins', message: 'feat: x\n\nbody' });
    expect(missingTarget).toMatchObject({ success: false, merged: false, error: 'expectedTarget or expectedTargets is required', reasonCode: 'INVALID_ARGUMENTS', mutation: 'none' });
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
