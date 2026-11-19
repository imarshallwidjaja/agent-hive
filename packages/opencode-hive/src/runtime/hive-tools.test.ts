import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import plugin from '../index.js';
import { HIVE_TOOL_NAMES } from '../utils/plugin-manifest.js';
import { createPluginWithHome } from '../e2e/plugin-test-home.js';
import { EXPLORATION_LIMITS, EXPLORATION_UNTRUSTED_NOTICE, ExplorationError, WorklogError } from 'hive-core';
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
  'hive_task_create(name:string, order?:number, feature?:string, description?:string, goal?:string, acceptanceCriteria?:string[], references?:string[], files?:string[], dependsOn?:string[], reason?:string, source?:string, repos?:string[], target?:string)',
  'hive_task_update(task:string, status?:pending|in_progress|done|cancelled|blocked|failed|partial, summary?:string, blocker?:{reason:string, options?:string[], recommendation?:string, context?:string}|null, report?:string, handoff?:string, feature?:string)',
  'hive_worktree_create(feature?:string, task:string, baseRef?:string, repoIds?:string[], candidate?:string)',
  'hive_worktree_inspect(feature?:string, task:string, repoIds?:string[], candidate?:string)',
  'hive_worktree_merge(feature?:string, task:string, repoIds?:string[], candidate?:string, historyIntent:preserve-source|rewrite-private, strategy?:merge|squash|rebase, message?:string, preserveConflicts?:boolean, cleanup?:none|worktree|worktree+branch, sourceCommit?:string, sourceCommits?:record<string>, expectedTarget?:{path:string, ref:string|null, commit:string}, expectedTargets?:record<{path:string, ref:string|null, commit:string}>)',
  'hive_worktree_cleanup(feature?:string, task:string, repoIds?:string[], candidate?:string, deleteBranch?:boolean, discard?:boolean)',
  'hive_adhoc_worktree_create(runId?:string, repoIds?:string[], sourceDirectory?:string, target?:string, baseRef?:string)',
  'hive_adhoc_worktree_inspect(runId:string, repoIds?:string[], sourceDirectory?:string)',
  'hive_adhoc_worktree_merge(runId:string, repoIds?:string[], sourceDirectory?:string, historyIntent:preserve-source|rewrite-private, strategy?:merge|squash|rebase, message?:string, preserveConflicts?:boolean, cleanup?:none|worktree|worktree+branch, sourceCommit?:string, sourceCommits?:record<string>, expectedTarget?:{path:string, ref:string|null, commit:string}, expectedTargets?:record<{path:string, ref:string|null, commit:string}>)',
  'hive_adhoc_worktree_cleanup(runId:string, repoIds?:string[], sourceDirectory?:string, deleteBranch?:boolean, discard?:boolean)',
  'hive_worktree_recover(operationId?:string, markerDigest?:string, observedStateDigest?:string, mutatorsStopped?:boolean, sourceDirectory?:string, workspacePath?:string)',
  'hive_checkouts_list()',
  'hive_checkout_inspect(id:string, local?:boolean, cleanup?:boolean)',
  'hive_checkout_brief(id:string, against?:string)',
  'hive_checkout_create(id:string, branch:string, baseRef?:string, purpose?:string)',
  'hive_checkout_register(id:string, purpose?:string)',
  'hive_checkout_readiness(id:string, expectedTarget:{path:string, ref:string|null, commit:string}|null, expectedRecord?:{id:string}, readiness:{state:ready|not_ready, nextTarget?:string, waitingFor?:string}|null)',
  'hive_checkout_cleanup(id:string, expectedTarget:{path:string, ref:string|null, commit:string}|null, removeIgnored?:boolean, deleteBranch?:{containedIn:string}|{discard:boolean, commit:string})',
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
  'hive_explore_read(id?:string, view?:brief|full)',
  'hive_explore_update(id:string, expectedRevision:number, operationId?:string, goal?:string, subject?:string, priorExplorationId?:string, status?:concluded|abandoned, conclusion?:string, reason?:string, frontier?:{key:string, target:string, state:open|covered|blocked|dropped, question?:string, evidence?:string, reason?:string, refs?:string[]}[], observations?:{key:string, summary:string, status:confirmed|hypothesis|refuted, refs?:string[], supersedes?:string}[])',
  'hive_status(feature?:string)',
  'hive_git_snapshot(directory?:string, repositoryIds?:string[], baseRef?:string, targetRef?:string, range?:string, paths?:string[], maxFiles?:number, maxPatchBytes?:number)',
];

const NATIVE_TRACE_AND_BACKGROUND_TOOLS = [
  'hive_task_trace', 'hive_task_trace_content',
  'hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel',
];

describe('ordinary Hive operation arguments', () => {
  it('registers the 45 ordinary operations after the trace and background tools, with their argument shapes', async () => {
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

// The JSON Schema exports a host or provider may build from tool arguments: the default (output, draft 2020-12),
// input, and the OpenAPI 3.0 dialect some providers convert to. The v2 registrar exports the same arguments with
// io input and output (draft 2020-12), so these cover both hosts.
const JSON_SCHEMA_EXPORTS = [{}, { io: 'input' }, { target: 'openapi-3.0' }, { io: 'input', target: 'openapi-3.0' }] as const;

// Keywords whose values are schemas (or maps or lists of schemas). Everything else, such as const, enum, default,
// examples and required, holds data and is not walked as a schema.
const SUBSCHEMA_KEYWORDS = ['items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'if', 'then', 'else', 'unevaluatedItems', 'unevaluatedProperties'];
const SUBSCHEMA_LIST_KEYWORDS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
const SUBSCHEMA_MAP_KEYWORDS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];

// Every const or enum value that is not a string, with its schema path. Google's legacy Schema/OpenAPI conversion
// accepts enum only on strings, so registered tools keep non-string literals out of every export.
function nonStringLiterals(schema: unknown, at = '$'): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const found: string[] = [];
  if ('const' in node && typeof node.const !== 'string') found.push(`${at}.const=${JSON.stringify(node.const)}`);
  if (Array.isArray(node.enum) && node.enum.some((value) => typeof value !== 'string')) found.push(`${at}.enum=${JSON.stringify(node.enum)}`);
  for (const key of SUBSCHEMA_KEYWORDS) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((item, index) => found.push(...nonStringLiterals(item, `${at}.${key}[${index}]`)));
    else found.push(...nonStringLiterals(child, `${at}.${key}`));
  }
  for (const key of SUBSCHEMA_LIST_KEYWORDS) {
    if (Array.isArray(node[key])) (node[key] as unknown[]).forEach((item, index) => found.push(...nonStringLiterals(item, `${at}.${key}[${index}]`)));
  }
  for (const key of SUBSCHEMA_MAP_KEYWORDS) {
    const children = node[key];
    if (typeof children === 'object' && children !== null) {
      for (const [name, child] of Object.entries(children)) found.push(...nonStringLiterals(child, `${at}.${key}.${name}`));
    }
  }
  return found;
}

function exportedLiterals(args: z.ZodRawShape): string[] {
  return JSON_SCHEMA_EXPORTS.flatMap((options) => nonStringLiterals(z.toJSONSchema(z.object(args), options as any)).map((entry) => `${JSON.stringify(options)} ${entry}`));
}

describe('registered tool schemas', () => {
  it('export no non-string const or enum from any registered tool, in every JSON Schema export', async () => {
    const { hooks } = await createRuntime();
    const registered = Object.entries(hooks.tool as Record<string, { args: z.ZodRawShape }>);
    expect(registered.map(([name]) => name).sort()).toEqual([...HIVE_TOOL_NAMES].sort());
    const offending = registered.flatMap(([name, definition]) => exportedLiterals(definition.args).map((entry) => `${name} ${entry}`));
    expect(offending).toEqual([]);

    // The check reads each export: a true literal fails in all four, a number literal nested in array items is found,
    // and string literals and enums stay allowed.
    expect(exportedLiterals({ discard: z.literal(true) })).toHaveLength(4);
    expect(exportedLiterals({ kind: z.literal('feature'), mode: z.enum(['full', 'outline']), list: z.array(z.literal(1)) })).toEqual(
      JSON_SCHEMA_EXPORTS.map((options) => `${JSON.stringify(options)} $.properties.list.items.${'target' in options ? 'enum=[1]' : 'const=1'}`),
    );
  });

  it('declares the checkout discard as a boolean that must be true and says how to keep the branch', async () => {
    const { hooks } = await createRuntime();
    for (const options of JSON_SCHEMA_EXPORTS) {
      const discard = (z.toJSONSchema(z.object((hooks.tool as any).hive_checkout_cleanup.args), options as any) as any)
        .properties.deleteBranch.anyOf[1].properties.discard;
      expect(discard.type, JSON.stringify(options)).toBe('boolean');
      expect(discard, JSON.stringify(options)).not.toHaveProperty('const');
      expect(discard, JSON.stringify(options)).not.toHaveProperty('enum');
      expect(discard.description).toContain('Must be true');
      expect(discard.description).toContain('omit deleteBranch');
    }
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
  hive_task_create: ['target'],
  hive_adhoc_worktree_create: ['runId', 'repoIds', 'sourceDirectory', 'target', 'baseRef'],
  hive_adhoc_worktree_inspect: ['repoIds', 'sourceDirectory'],
  hive_adhoc_worktree_cleanup: ['repoIds', 'sourceDirectory', 'deleteBranch', 'discard'],
  hive_worktree_recover: ['operationId', 'markerDigest', 'observedStateDigest', 'mutatorsStopped', 'sourceDirectory'],
  hive_checkout_inspect: ['id', 'local', 'cleanup'],
  hive_checkout_brief: ['id', 'against'],
  hive_checkout_create: ['id', 'branch', 'baseRef', 'purpose'],
  hive_checkout_register: ['id', 'purpose'],
  hive_checkout_readiness: ['id', 'expectedTarget', 'expectedRecord', 'readiness'],
  hive_checkout_cleanup: ['id', 'expectedTarget', 'removeIgnored', 'deleteBranch'],
  hive_context_read: ['name', 'scope', 'view', 'query', 'limit', 'cursor', 'maxBytes', 'scanChars'],
  hive_context_write: ['content', 'kind', 'task', 'expectedRevision', 'expectedContentHash', 'scope'],
  hive_context_append: ['content', 'section', 'task', 'expectedRevision', 'expectedContentHash', 'scope'],
  hive_context_edit: ['name', 'oldText', 'newText', 'expectedRevision', 'expectedContentHash', 'scope', 'feature'],
  hive_context_archive: ['reason', 'expectedRevision', 'expectedContentHashes', 'scope'],
  hive_worklog_list: ['kind', 'limit', 'cursor', 'maxBytes'],
  hive_worklog_read: ['ref', 'view', 'limit', 'cursor', 'maxBytes'],
  hive_worklog_record: ['ref', 'operationId', 'title', 'checkpoint', 'briefing', 'expectedRevision'],
  hive_explore_read: ['id', 'view'],
  hive_explore_update: ['id', 'expectedRevision', 'operationId', 'goal', 'subject', 'priorExplorationId', 'status', 'conclusion', 'reason', 'frontier', 'observations'],
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

  it('lists the named-read guard before the body and pages the same chunks under the same budget', async () => {
    const { call, callJson } = await createRuntime();
    await callJson('hive_feature_create', { name: 'ordered' });
    const content = `---\ndescription: Style.\nread_when: Always.\n---\nTone: formal\n${'Body line with filler text.\n'.repeat(1300)}Tail: unchanged\n`;
    await callJson('hive_context_write', { feature: 'ordered', name: 'style-guide', content });
    let raw = await call('hive_context_read', { feature: 'ordered', name: 'style-guide' });
    const first = JSON.parse(raw);
    expect(Object.keys(first)).toEqual(['scope', 'revision', 'snapshot', 'range', 'complete', 'nextCursor', 'file']);
    expect(Object.keys(first.file).at(-1)).toBe('content');
    expect(raw.indexOf('"contentHash"')).toBeLessThan(raw.indexOf('"content":'));
    expect(raw.indexOf('"nextCursor"')).toBeLessThan(raw.indexOf('"content":'));
    let reconstructed = '';
    for (let page = JSON.parse(raw); ; page = JSON.parse(raw)) {
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(16 * 1024);
      expect(page.file.contentHash).toBe(first.file.contentHash);
      expect(page.range.startByte).toBe(Buffer.byteLength(reconstructed, 'utf8'));
      reconstructed += page.file.content;
      if (page.complete) {
        expect(page.nextCursor).toBeUndefined();
        break;
      }
      raw = await call('hive_context_read', { feature: 'ordered', name: 'style-guide', cursor: page.nextCursor });
    }
    expect(reconstructed).toBe(content);
  });

  it('returns a self-contained hash-guard refusal through the tool error and changes nothing until a fresh read', async () => {
    const { root, hooks, callJson, failure } = await createRuntime();
    await callJson('hive_feature_create', { name: 'retained' });
    const content = `---\ndescription: Style.\nread_when: Always.\n---\nTone: formal\n${'Body line with filler text.\n'.repeat(1300)}Tail: unchanged\n`;
    await callJson('hive_context_write', { feature: 'retained', name: 'style-guide', content });
    const contextDir = path.join(root, '.hive', 'features', fs.readdirSync(path.join(root, '.hive', 'features'))[0]!, 'context');
    const stored = () => ({ document: fs.readFileSync(path.join(contextDir, 'style-guide.md')), index: fs.readFileSync(path.join(contextDir, 'index.json')) });
    const before = stored();
    const read = await callJson('hive_context_read', { feature: 'retained', name: 'style-guide' });
    expect(read.complete).toBe(false);
    const hash: string = read.file.contentHash;
    // The paid-case value: a 63-character copy with a short span transposed and one character dropped.
    const retained = `${hash.slice(0, 23)}${hash[24]}${hash[23]}${hash.slice(26)}`;
    const edit = { feature: 'retained', name: 'style-guide', oldText: 'Tone: formal', newText: 'Tone: plain', expectedRevision: read.revision };
    // The registered schema accepts the string, so the service, not generic validation, explains the refusal.
    expect(z.object((hooks.tool as any).hive_context_edit.args).safeParse({ ...edit, expectedContentHash: retained }).success).toBe(true);
    const malformed = "expectedContentHash must be exactly 64 lowercase hexadecimal characters; received 63 characters. Nothing was written. Do not pad, trim or otherwise repair the rejected value. Make a fresh named hive_context_read and rebuild the intended change from it (every chunk for a whole-document replacement; the passage and enough surrounding text for a bounded edit), then pass that read's revision and file.contentHash. Do not resend content built from the earlier read under the new hash.";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await failure('hive_context_edit', { ...edit, expectedContentHash: retained })).toBe(malformed);
      expect(stored()).toEqual(before);
    }
    expect(await failure('hive_context_edit', { ...edit, expectedContentHash: hash.toUpperCase() })).toContain('received 64 characters that are not all lowercase hexadecimal (0-9, a-f)');
    const mistyped = `${hash.slice(0, -1)}${hash.endsWith('0') ? '1' : '0'}`;
    const mismatch = await failure('hive_context_edit', { ...edit, expectedContentHash: mistyped });
    expect(mismatch).toContain('the file changed after it was read, or the value was not copied exactly from file.contentHash');
    expect(mismatch).toContain('Nothing was written.');
    expect(mismatch).not.toContain(hash);
    expect(stored()).toEqual(before);

    const fresh = await callJson('hive_context_read', { feature: 'retained', name: 'style-guide' });
    const applied = await callJson('hive_context_edit', { ...edit, expectedRevision: fresh.revision, expectedContentHash: fresh.file.contentHash });
    expect(applied.revision).toBe(read.revision + 1);
    expect(fs.readFileSync(path.join(contextDir, 'style-guide.md'), 'utf8')).toBe(content.replace('Tone: formal', 'Tone: plain'));
  });

  it('describes every context hash guard as the verbatim file.contentHash without a schema pattern', async () => {
    const { hooks } = await createRuntime();
    const tools = hooks.tool as Record<string, { description: string; args: any }>;
    for (const [name, field] of [['hive_context_write', 'expectedContentHash'], ['hive_context_append', 'expectedContentHash'], ['hive_context_edit', 'expectedContentHash'], ['hive_context_archive', 'expectedContentHashes']] as const) {
      const property = (z.toJSONSchema(z.object(tools[name]!.args)) as any).properties[field];
      const guard = field === 'expectedContentHashes' ? property.additionalProperties : property;
      expect(guard.type, name).toBe('string');
      for (const refinement of ['pattern', 'minLength', 'maxLength', 'format']) expect(guard, name).not.toHaveProperty(refinement);
      expect(property.description, name).toContain('64 lowercase hexadecimal characters copied verbatim from');
      expect(property.description, name).toContain('file.contentHash (not snapshot)');
      expect(property.description, name).toContain('needs a fresh named read, not a retry');
    }
    const read = tools.hive_context_read!.description;
    expect(read).toContain('the same on every chunk and listed before file.content; copy it verbatim into expectedContentHash (the top-level snapshot is not that hash)');
    expect(read).toContain('for hive_context_edit, stop once you have seen the passage and enough surrounding text');
    expect(read).toContain('nextCursor is opaque: copy it unchanged and do not decode or rebuild it');
    expect(tools.hive_context_edit!.description).toContain('A malformed or mismatched expectedContentHash is refused the same way; make a fresh named read and rebuild the edit from what it shows');
    expect(tools.hive_context_write!.description).toContain('Supplying only one of the two is refused, as is a malformed or stale pair, and none of these refusals writes anything');
  });

  it('refuses a half-specified write guard before choosing create or replace', async () => {
    const { root, callJson, failure } = await createRuntime();
    await callJson('hive_feature_create', { name: 'modes' });
    const content = '---\ndescription: Style.\nread_when: Always.\n---\nTone: formal\n';
    const created = await callJson('hive_context_write', { feature: 'modes', name: 'kept', content });
    const retired = await callJson('hive_context_write', { feature: 'modes', name: 'retired', content });
    await callJson('hive_context_archive', { feature: 'modes', names: ['retired'], reason: 'superseded', expectedRevision: retired.revision, expectedContentHashes: { retired: retired.file.contentHash } });
    const contextDir = path.join(root, '.hive', 'features', fs.readdirSync(path.join(root, '.hive', 'features'))[0]!, 'context');
    const stored = () => ({ names: fs.readdirSync(contextDir).sort(), index: fs.readFileSync(path.join(contextDir, 'index.json')), kept: fs.readFileSync(path.join(contextDir, 'kept.md')) });
    const before = stored();
    expect(before.names).not.toContain('retired.md');
    const hashOnly = 'expectedContentHash was supplied without expectedRevision. Nothing was written. To create a missing document, omit both; to replace one, pass the revision and file.contentHash from a fresh named hive_context_read of the complete document, and rebuild the replacement content from that read instead of resending content prepared from an earlier one.';
    // A hash alone must not fall through to create, whether the name is absent, archived, or present.
    for (const name of ['absent', 'retired', 'kept']) {
      expect(await failure('hive_context_write', { feature: 'modes', name, content, expectedContentHash: created.file.contentHash })).toBe(hashOnly);
      expect(await failure('hive_context_write', { feature: 'modes', name, content, expectedContentHash: 'malformed' })).toBe(hashOnly);
      expect(await failure('hive_context_write', { feature: 'modes', name, content, expectedRevision: created.revision }))
        .toBe('expectedRevision was supplied without expectedContentHash. Nothing was written. To create a missing document, omit both; to replace one, pass the revision and file.contentHash from a fresh named hive_context_read of the complete document, and rebuild the replacement content from that read instead of resending content prepared from an earlier one.');
      expect(stored()).toEqual(before);
    }
    // Omitting both still creates, and a refused call left nothing behind that would block it.
    expect((await callJson('hive_context_write', { feature: 'modes', name: 'absent', content })).file.contentHash).toMatch(/^[a-f0-9]{64}$/);
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

// The operator journey through retained checkouts, from tool arguments to Git: core owns the mutators' edge cases, so
// these cases pin what the tools pass, return and refuse.
describe('retained checkout operations', () => {
  const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (cwd: string, file: string) => {
    fs.writeFileSync(path.join(cwd, file), `${file}\n`);
    gitIn(cwd, 'add', '.');
    gitIn(cwd, 'commit', '-m', `test: ${file}`);
    return gitIn(cwd, 'rev-parse', 'HEAD');
  };

  it('binds ad-hoc and task workers to the retained checkout they name and integrates only there', async () => {
    const { root, call, callJson, failure } = await createRuntime();
    const base = gitIn(root, 'rev-parse', 'HEAD');
    const release = await callJson('hive_checkout_create', { id: 'root/release', branch: 'release', baseRef: 'main', purpose: 'Release line' });
    const next = await callJson('hive_checkout_create', { id: 'root/next', branch: 'next', baseRef: 'main' });
    expect(release).toMatchObject({ success: true, checkout: { id: 'root/release', ownership: 'managed', ref: 'refs/heads/release', path: path.join(root, '.hive', 'checkouts', 'root', 'release') } });
    expect(await callJson('hive_checkout_create', { id: 'root/release', branch: 'release', baseRef: 'main' })).toEqual(release);
    const listed = await callJson('hive_checkouts_list', {});
    expect(listed.repositories).toEqual([expect.objectContaining({ id: 'root', path: root, implicit: true })]);
    expect(listed.repositories[0].checkouts.map((view: any) => [view.id, view.onIntendedRef, view.head.commit])).toEqual([['root/next', true, base], ['root/release', true, base]]);

    // A foreign source cannot carry a target; the active root spelled as sourceDirectory is the project itself.
    const foreign = fs.realpathSync(fs.mkdtempSync(`/tmp/hive-tools-foreign-${process.pid}-`));
    roots.push(foreign);
    expect(await failure('hive_adhoc_worktree_create', { runId: 'run', sourceDirectory: foreign, target: 'root/release' })).toContain('cannot be combined with a foreign sourceDirectory');
    expect(await failure('hive_adhoc_worktree_create', { runId: 'run', baseRef: base })).toContain('baseRef applies only to a targeted run');
    const run = await callJson('hive_adhoc_worktree_create', { runId: 'run', sourceDirectory: root, target: 'root/release', baseRef: base });
    expect(run).toMatchObject({
      mode: 'adhoc-targeted', repoId: 'root', branch: 'hive-targeted/adhoc/run', baseCommit: base,
      targetBinding: { id: 'root/release', path: release.checkout.path, ref: 'refs/heads/release', status: 'ok' },
      target: { path: release.checkout.path, ref: 'refs/heads/release', commit: base },
    });
    expect(run).not.toHaveProperty('repos');
    const work = commit(run.path, 'run.txt');
    const merged = await callJson('hive_adhoc_worktree_merge', {
      runId: 'run', historyIntent: 'preserve-source', message: 'feat: run work\n\nIntegrate the run.', sourceCommit: work,
      expectedTarget: (await callJson('hive_adhoc_worktree_inspect', { runId: 'run' })).target,
    });
    expect(merged).toMatchObject({ success: true, merged: true, provenance: { status: 'recorded' } });
    expect(gitIn(release.checkout.path, 'merge-base', '--is-ancestor', work, 'HEAD')).toBe('');
    expect(gitIn(root, 'rev-parse', 'HEAD')).toBe(base);
    // Without a selected feature the run's origin is the creating session's own log; the merge stamps its caller.
    expect(JSON.parse(fs.readFileSync(path.join(root, '.hive', 'provenance', 'integrations', `${merged.sha}.json`), 'utf8'))).toMatchObject({
      origin: { kind: 'adhoc', runId: 'run', worklog: { kind: 'session', owner: 'opencode-v1', sessionId: 'session' } },
      integratedBy: { owner: 'opencode-v1', sessionId: 'session', agent: 'hive-master' },
    });
    // The brief attributes the merged run from its receipt; the preserved source commit is covered, not unattributed.
    const brief = await callJson('hive_checkout_brief', { id: 'root/release', against: 'root/next' });
    expect(brief).toMatchObject({
      success: true,
      comparison: { status: 'resolved', destinationFrom: 'against', ahead: 2, behind: 0 },
      contributions: { total: 1, items: [{ commit: merged.sha, strategy: 'merge', origin: { kind: 'adhoc', runId: 'run', worklog: { kind: 'session', owner: 'opencode-v1', sessionId: 'session' } }, sources: { kind: 'adhoc', worklogHeader: null } }] },
      unattributedCommits: { total: 0 },
    });
    expect(await callJson('hive_checkout_brief', { id: 'root/release', against: 'api/next' })).toMatchObject({ success: false, reason: 'invalid_destination' });

    await callJson('hive_feature_create', { name: 'ship' });
    // With a selected feature the origin is that feature's log, and a caller cannot supply its own.
    await callJson('hive_feature_select', { feature: 'ship' });
    const shipRun = await callJson('hive_adhoc_worktree_create', { runId: 'ship-run', target: 'root/next', origin: { worklog: { kind: 'feature', featureName: 'forged' } } });
    expect(JSON.parse(fs.readFileSync(`${shipRun.path}.json`, 'utf8')).origin).toEqual({ worklog: { kind: 'feature', featureName: 'ship' } });
    await callJson('hive_feature_select', { feature: null });
    expect(await failure('hive_task_create', { feature: 'ship', name: 'bad', target: 'root/next', repos: ['api'] })).toContain('works only in repository root');
    expect(await call('hive_task_create', { feature: 'ship', name: 'work', target: 'root/next' })).toBe('01-work');
    expect((await callJson('hive_status', { feature: 'ship' })).tasks[0]).toMatchObject({ folder: '01-work', target: 'root/next' });
    const task = await callJson('hive_worktree_create', { feature: 'ship', task: '01-work' });
    expect(task).toMatchObject({ mode: 'targeted', targetBinding: { id: 'root/next', status: 'ok' }, target: { path: next.checkout.path, ref: 'refs/heads/next' } });

    // A targeted task that also lists its one repository is still one worktree: it takes the scalar pin and target.
    expect(await call('hive_task_create', { feature: 'ship', name: 'listed', target: 'root/next', repos: ['root'] })).toBe('02-listed');
    const listedTask = await callJson('hive_worktree_create', { feature: 'ship', task: '02-listed', repoIds: ['root'] });
    expect(listedTask).toMatchObject({ mode: 'targeted', targetBinding: { id: 'root/next', status: 'ok' }, target: { path: next.checkout.path, ref: 'refs/heads/next', commit: base } });
    expect(listedTask).not.toHaveProperty('repos');
    const listedWork = commit(listedTask.path, 'listed.txt');
    expect(await callJson('hive_worktree_merge', {
      feature: 'ship', task: '02-listed', repoIds: ['root'], historyIntent: 'preserve-source', message: 'feat: listed work\n\nIntegrate the listed task.',
      sourceCommit: listedWork, expectedTarget: listedTask.target,
    })).toMatchObject({ success: true, merged: true });
    expect(gitIn(next.checkout.path, 'merge-base', '--is-ancestor', listedWork, 'HEAD')).toBe('');
    expect(gitIn(root, 'rev-parse', 'HEAD')).toBe(base);

    // A binding is frozen: once its checkout leaves the bound branch, merge refuses before any mutation.
    const nextHead = gitIn(next.checkout.path, 'rev-parse', 'HEAD');
    gitIn(next.checkout.path, 'checkout', '-b', 'elsewhere');
    expect((await callJson('hive_worktree_inspect', { feature: 'ship', task: '01-work' })).targetBinding).toMatchObject({ id: 'root/next', status: 'ref_changed' });
    const stale = await callJson('hive_worktree_merge', { feature: 'ship', task: '01-work', historyIntent: 'preserve-source', expectedTarget: task.target });
    expect(stale).toMatchObject({ success: false, reasonCode: 'TARGET_MISMATCH', mutation: 'none' });
    expect(gitIn(next.checkout.path, 'rev-parse', 'HEAD')).toBe(nextHead);
  });

  it('completes a feature without removing anything and warns about its task workers that remain, including one whose checkout is gone', async () => {
    const { root, call, callJson } = await createRuntime();
    await callJson('hive_feature_create', { name: 'wrap' });
    expect(await call('hive_task_create', { feature: 'wrap', name: 'kept' })).toBe('01-kept');
    expect(await call('hive_task_create', { feature: 'wrap', name: 'live' })).toBe('02-live');
    const kept = await callJson('hive_worktree_create', { feature: 'wrap', task: '01-kept' });
    const keptTip = commit(kept.path, 'kept.txt');
    expect(await callJson('hive_worktree_cleanup', { feature: 'wrap', task: '01-kept' })).toMatchObject({ worktreeRemoved: true, branchDeleted: false });
    const live = await callJson('hive_worktree_create', { feature: 'wrap', task: '02-live' });
    // A worker created under the feature's directory name sits in that group.
    const directory = fs.readdirSync(path.join(root, '.hive', 'features')).find((entry) => entry.endsWith('_wrap'))!;
    expect(await call('hive_task_create', { feature: 'wrap', name: 'alias' })).toBe('03-alias');
    const alias = await callJson('hive_worktree_create', { feature: directory, task: '03-alias' });
    expect(alias.path).toBe(path.join(root, '.hive', '.worktrees', directory, '03-alias'));
    for (const task of ['01-kept', '02-live', '03-alias']) await callJson('hive_task_update', { feature: 'wrap', task, status: 'done' });

    const completed = await callJson('hive_feature_complete', { name: 'wrap' });
    expect(completed).toMatchObject({ success: true, feature: { status: 'completed' } });
    expect(completed.warnings).toHaveLength(1);
    const { remainingWorkers } = completed.warnings[0];
    expect(Object.keys(completed.warnings[0])).toEqual(['remainingWorkers']);
    expect(remainingWorkers.total).toBe(3);
    expect(remainingWorkers.items).toHaveLength(3);
    // The inventory lists live checkouts before kept records; no order is part of the warning.
    expect(remainingWorkers.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ task: '02-live', path: live.path, branch: 'hive/wrap/02-live', head: live.commit }),
      expect.objectContaining({ task: '01-kept', path: kept.path, branch: 'hive/wrap/01-kept', head: null, retained: { branchCommit: keptTip } }),
      expect.objectContaining({ task: '03-alias', path: alias.path, head: alias.commit }),
    ]));
    expect(fs.existsSync(live.path)).toBe(true);
    expect(gitIn(root, 'rev-parse', 'refs/heads/hive/wrap/01-kept')).toBe(keptTip);
  });

  it('warns that the worktree inventory could not be read when completing a feature, instead of reporting no workers', async () => {
    const { root, callJson } = await createRuntime();
    await callJson('hive_feature_create', { name: 'blind' });
    const worktrees = path.join(root, '.hive', '.worktrees');
    fs.mkdirSync(worktrees, { recursive: true });
    fs.chmodSync(worktrees, 0o000);
    let completed: any;
    try {
      completed = await callJson('hive_feature_complete', { name: 'blind' });
    } finally {
      fs.chmodSync(worktrees, 0o755);
    }
    expect(completed).toMatchObject({ success: true, feature: { status: 'completed' } });
    expect(completed.warnings).toEqual([{ worktreeErrors: { total: 1, items: [{ path: worktrees, reason: expect.stringContaining('EACCES') }] } }]);
  });

  it('pins readiness to an inspected commit and cleans up only an unreferenced checkout at the proposed identity', async () => {
    const { root, hooks, callJson, failure } = await createRuntime();
    const created = await callJson('hive_checkout_create', { id: 'root/release', branch: 'release', baseRef: 'main' });
    const head = (await callJson('hive_checkout_inspect', { id: 'root/release' })).checkout.head;
    expect(head).toEqual({ path: created.checkout.path, ref: 'refs/heads/release', commit: gitIn(root, 'rev-parse', 'HEAD') });

    const readiness = { state: 'ready', waitingFor: 'release review' };
    expect(await callJson('hive_checkout_readiness', { id: 'root/release', expectedTarget: { ...head, commit: '0'.repeat(40) }, readiness }))
      .toMatchObject({ success: false, reason: 'binding_mismatch' });
    expect(await callJson('hive_checkout_readiness', { id: 'root/release', expectedTarget: head, readiness }))
      .toMatchObject({ success: true, checkout: { readiness: { state: 'ready', commit: head.commit, waitingFor: 'release review', declaredBy: { owner: 'opencode-v1', sessionId: 'session', agent: 'hive-master' } } } });
    commit(created.checkout.path, 'later.txt');
    const moved = (await callJson('hive_checkout_inspect', { id: 'root/release' })).checkout;
    expect(moved.readiness).toMatchObject({ commit: head.commit, headMoved: true });
    const cleared = await callJson('hive_checkout_readiness', { id: 'root/release', expectedTarget: moved.head, readiness: null });
    expect(cleared.checkout).not.toHaveProperty('readiness');

    // A missing checkout's readiness clears only against its inspected record, and never alongside a live identity.
    const gone = await callJson('hive_checkout_create', { id: 'root/gone', branch: 'gone', baseRef: 'main' });
    const goneHead = (await callJson('hive_checkout_inspect', { id: 'root/gone' })).checkout.head;
    await callJson('hive_checkout_readiness', { id: 'root/gone', expectedTarget: goneHead, readiness: { state: 'ready', nextTarget: 'root/release' } });
    fs.rmSync(gone.checkout.path, { recursive: true, force: true });
    const goneRecord = (await callJson('hive_checkout_inspect', { id: 'root/gone', cleanup: true })).cleanup.record;
    expect(await failure('hive_checkout_readiness', { id: 'root/gone', expectedTarget: null, readiness: { state: 'ready' }, expectedRecord: goneRecord })).toContain('expectedTarget: null clears the readiness of a missing checkout');
    expect(await failure('hive_checkout_readiness', { id: 'root/release', expectedTarget: moved.head, readiness: null, expectedRecord: goneRecord })).toContain('expectedRecord applies only with expectedTarget: null');
    expect(await callJson('hive_checkout_readiness', { id: 'root/gone', expectedTarget: null, readiness: null, expectedRecord: { ...goneRecord, purpose: 'other' } }))
      .toMatchObject({ success: false, reason: 'binding_mismatch' });
    const goneCleared = await callJson('hive_checkout_readiness', { id: 'root/gone', expectedTarget: null, readiness: null, expectedRecord: goneRecord });
    expect(goneCleared).toMatchObject({ success: true, checkout: { id: 'root/gone' } });
    expect(goneCleared.checkout).not.toHaveProperty('readiness');
    expect(await callJson('hive_checkout_cleanup', { id: 'root/gone', expectedTarget: null })).toMatchObject({ success: true, recordRemoved: true });

    // A worker bound to the checkout keeps it until the worker and its branch are gone.
    await callJson('hive_adhoc_worktree_create', { runId: 'run', target: 'root/release' });
    const referenced = await callJson('hive_checkout_inspect', { id: 'root/release', local: true, cleanup: true });
    expect(referenced.local).toEqual({ tracked: [], untracked: [], ignored: [], truncated: false });
    expect(referenced.cleanup.references).toEqual([expect.objectContaining({ kind: 'worker', runId: 'run' })]);
    expect(await callJson('hive_checkout_cleanup', { id: 'root/release', expectedTarget: referenced.cleanup.identity }))
      .toMatchObject({ success: false, reason: 'referenced' });
    expect(await callJson('hive_adhoc_worktree_cleanup', { runId: 'run', deleteBranch: true, discard: true })).toMatchObject({ worktreeRemoved: true, branchDeleted: true });

    const proposal = (await callJson('hive_checkout_inspect', { id: 'root/release', cleanup: true })).cleanup;
    expect(proposal).toMatchObject({ references: [], unreadableReferences: [], blockers: [], identity: moved.head });

    // Host validation of the deletion option: containment, discard: true and omission parse; false, a string or a
    // missing field do not. A containment object keeps stripping extra keys, as the union always has.
    const cleanupArgs = z.object((hooks.tool as any).hive_checkout_cleanup.args);
    const withOption = (deleteBranch?: unknown) => ({ id: 'root/release', expectedTarget: proposal.identity, ...(deleteBranch === undefined ? {} : { deleteBranch }) });
    const tip = moved.head.commit;
    expect(cleanupArgs.parse(withOption()).deleteBranch).toBeUndefined();
    expect(cleanupArgs.parse(withOption({ containedIn: 'root/main' })).deleteBranch).toEqual({ containedIn: 'root/main' });
    expect(cleanupArgs.parse(withOption({ discard: true, commit: tip })).deleteBranch).toEqual({ discard: true, commit: tip });
    expect(cleanupArgs.parse(withOption({ containedIn: 'root/main', discard: false, commit: tip })).deleteBranch).toEqual({ containedIn: 'root/main' });
    for (const invalid of [{ discard: false, commit: tip }, { discard: 'true', commit: tip }, { discard: true }, { commit: tip }, false, null]) {
      expect(cleanupArgs.safeParse(withOption(invalid)).success, JSON.stringify(invalid)).toBe(false);
    }
    expect(JSON.stringify(cleanupArgs.safeParse(withOption({ discard: false, commit: tip })).error)).toContain('discard must be true');
    // A raw executor call skips that parse; the service still refuses discard: false at the current tip and keeps the checkout.
    expect(await failure('hive_checkout_cleanup', withOption({ discard: false, commit: tip }))).toContain('deleteBranch.discard must be true');
    expect(fs.existsSync(created.checkout.path)).toBe(true);
    expect(gitIn(root, 'rev-parse', 'refs/heads/release')).toBe(tip);

    expect(await callJson('hive_checkout_cleanup', { id: 'root/release', expectedTarget: proposal.identity }))
      .toEqual({ success: true, id: 'root/release', ownership: 'managed', worktreeRemoved: true, branchDeleted: false, recordRemoved: true });
    expect(fs.existsSync(created.checkout.path)).toBe(false);
    expect(gitIn(root, 'rev-parse', 'refs/heads/release')).toBe(moved.head.commit);

    // A registered checkout is the project's own: cleanup forgets the record and leaves the checkout alone.
    const registered = await callJson('hive_checkout_register', { id: 'root/main' });
    expect(registered).toMatchObject({ success: true, checkout: { ownership: 'registered', path: root, ref: 'refs/heads/main' } });
    const own = (await callJson('hive_checkout_inspect', { id: 'root/main', cleanup: true })).cleanup;
    expect(await callJson('hive_checkout_cleanup', { id: 'root/main', expectedTarget: own.identity }))
      .toMatchObject({ success: true, ownership: 'registered', worktreeRemoved: false, recordRemoved: true });
    expect((await callJson('hive_checkouts_list', {})).repositories[0].checkouts).toEqual([]);
    expect(await callJson('hive_checkout_inspect', { id: 'root/main', cleanup: true })).toMatchObject({ success: false, reason: 'not_found' });
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

describe('Exploration operations', () => {
  it('creates, reads, upserts and closes an exploration with the host author and the untrusted notice', async () => {
    const { root, call, callJson } = await createRuntime();
    expect(await callJson('hive_explore_read', {})).toEqual({ view: 'list', explorations: [], totalActive: 0, truncated: false, errors: [], untrustedNotice: EXPLORATION_UNTRUSTED_NOTICE });
    expect(fs.existsSync(path.join(root, '.hive', 'explorations'))).toBe(false);

    const forged = { owner: 'opencode-v2', sessionId: 'someone', agent: 'forged' };
    const created = await callJson('hive_explore_update', {
      id: 'slow-build', expectedRevision: 0, operationId: 'create', goal: 'Find why the build takes four minutes', subject: 'root/main (packages/web)',
      frontier: [{ key: 'bundler', target: 'scripts/build.ts', state: 'open', question: 'Which phase dominates?' }],
      createdBy: forged, author: forged,
    }, 's1', 'hive-builder');
    expect(created).toMatchObject({
      replayed: false, committedRevision: 1, currentRevision: 1, status: 'active', scopeMapped: true,
      createdBy: { owner: 'opencode-v1', sessionId: 's1', agent: 'hive-builder' }, untrustedNotice: EXPLORATION_UNTRUSTED_NOTICE,
    });

    const updated = await callJson('hive_explore_update', {
      id: 'slow-build', expectedRevision: 1,
      frontier: [{ key: 'bundler', target: 'scripts/build.ts', state: 'covered', evidence: 'Type declaration emit takes 80% of the time.', refs: ['scripts/build.ts:30'] }],
      observations: [{ key: 'dts', summary: 'Declaration emit dominates the build', status: 'confirmed' }],
    }, 's2', 'swarm-orchestrator');
    expect(updated).toMatchObject({ revision: 2, lastProgressRevision: 2, updatedBy: { sessionId: 's2', agent: 'swarm-orchestrator' }, gaps: { items: [], total: 0 } });

    // Results are compact JSON, so the brief budget bounds the text the host receives.
    const text = await call('hive_explore_read', { id: 'slow-build' });
    expect(text).toBe(JSON.stringify(JSON.parse(text)));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(EXPLORATION_LIMITS.briefMaxBytes);
    expect((await callJson('hive_explore_read', { id: 'slow-build', view: 'full' })).frontier[0]).toMatchObject({ refs: ['scripts/build.ts:30'] });
    expect((await callJson('hive_explore_read', {})).explorations.map((entry: { id: string }) => entry.id)).toEqual(['slow-build']);

    const close = { id: 'slow-build', expectedRevision: 2, operationId: 'close', status: 'concluded', conclusion: 'Emit declarations in a separate step.' };
    expect(await callJson('hive_explore_update', close, 's1')).toMatchObject({ status: 'concluded', replayed: false });
    expect(await callJson('hive_explore_update', close, 's1')).toMatchObject({ status: 'concluded', replayed: true, committedRevision: 3 });
    expect(await callJson('hive_explore_read', {})).toMatchObject({ explorations: [], totalActive: 0 });
  });

  it('returns domain refusals in the shared Hive failure envelope', async () => {
    const { root, callJson } = await createRuntime();
    expect(await callJson('hive_explore_read', { view: 'full' })).toEqual({ success: false, reason: 'invalid_argument', error: expect.stringContaining('view needs an id'), details: { field: 'view' } });
    expect(await callJson('hive_explore_read', { id: 'missing' })).toEqual({ success: false, reason: 'not_found', error: "No exploration 'missing'.", details: { id: 'missing' } });
    expect(await callJson('hive_explore_update', { id: 'Bad Id', expectedRevision: 0, goal: 'g' }, 's1')).toMatchObject({ success: false, reason: 'invalid_argument' });
    expect(await callJson('hive_explore_update', { id: 'x', expectedRevision: 0, goal: 'g', frontier: [{ key: 'k', target: 't', state: 'covered' }] }, 's1'))
      .toMatchObject({ success: false, reason: 'invalid_argument', error: expect.stringContaining('needs evidence') });
    // Rejected calls create nothing, not even a lock anchor.
    expect(fs.existsSync(path.join(root, '.hive', 'explorations'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.hive', '.locks'))).toBe(false);

    await callJson('hive_explore_update', { id: 'x', expectedRevision: 0, goal: 'g' }, 's1');
    expect(await callJson('hive_explore_update', { id: 'x', expectedRevision: 0, goal: 'g' }, 's1')).toMatchObject({ success: false, reason: 'already_exists' });
    expect(await callJson('hive_explore_update', { id: 'x', expectedRevision: 5, goal: 'g' }, 's1')).toMatchObject({ success: false, reason: 'stale_revision', details: { currentRevision: 1 } });
    expect(await callJson('hive_explore_update', { id: 'x', expectedRevision: 1, subject: 'late' }, 's1')).toMatchObject({ success: false, reason: 'immutable_field' });

    const operations = createHiveOperations({ explorationService: { update: () => { throw new ExplorationError('io_error', 'write failed', { stage: 'write', publication: 'uncertain' }); } }, sessionActor: () => ({ owner: 'opencode-v1', sessionId: 's1', agent: 'hive-master' }) } as any);
    expect(operations.hive_explore_update!.execute({ id: 'x', expectedRevision: 1, goal: 'g' }, { sessionID: 's1', agent: 'hive-master' }))
      .toEqual({ success: false, reason: 'io_error', error: 'write failed', details: { stage: 'write', publication: 'uncertain' } });
    // A refusal without details carries no empty details object.
    const bare = createHiveOperations({ explorationService: { read: () => { throw new ExplorationError('exploration_corrupt', 'bad file'); } } } as any);
    expect(bare.hive_explore_read!.execute({ id: 'x' }, {})).toEqual({ success: false, reason: 'exploration_corrupt', error: 'bad file' });
    const anonymous = createHiveOperations({ explorationService: {}, sessionActor: () => undefined } as any);
    expect(() => anonymous.hive_explore_update!.execute({ id: 'x', expectedRevision: 0, goal: 'g' }, {})).toThrow('calling session and agent');
  });

  it('lets every Hive role read and only live primary sessions of authoring roles write', async () => {
    const { root, sessions, callJson, failure } = await createRuntime();
    const create = (id: string) => ({ id, expectedRevision: 0, goal: 'Explore' });
    sessions.set('child', { id: 'child', parentID: 'primary' });
    sessions.set('broken', new Error('gone'));
    for (const agent of ['hive-master', 'architect-planner']) expect(await failure('hive_explore_update', create('child'), 'child', agent)).toContain('primary-only operation');
    expect(await failure('hive_explore_update', create('broken'), 'broken')).toContain('could not read session broken');
    expect(await failure('hive_explore_update', create('root'), 'root', 'forager-worker')).toContain('not granted to the forager-worker role');
    expect(await failure('hive_explore_update', create('root'), 'root', 'general')).toContain('native general subagent has no Hive tool access');
    expect(fs.existsSync(path.join(root, '.hive', 'explorations'))).toBe(false);
    for (const agent of ['hive-master', 'swarm-orchestrator', 'hive-builder', 'architect-planner', 'dash-reviewer', 'vulnerability-review-primary']) {
      expect((await callJson('hive_explore_update', create(agent), agent, agent)).createdBy).toEqual({ owner: 'opencode-v1', sessionId: agent, agent });
    }
    // Children still read.
    expect((await callJson('hive_explore_read', { id: 'hive-master' }, 'child', 'forager-worker')).id).toBe('hive-master');
  });
});
