import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ContextMutationError,
  PlanApprovalError,
  TASK_HANDOFF_MAX_BYTES,
  TaskUpdatePersistenceError,
  canonicalProjectRoot,
  computeRunnableAndBlocked,
  getPlanPath,
  getTaskHandoffPath,
  projectRootsMatch,
  readCompositeWorkspaceManifest,
  type AdhocMergeOptions,
  type MergeOptions,
  type PlanApprovalResult,
  type PlanUnownedTaskHeading,
  type TaskSpecFreshness,
} from 'hive-core';
import { GitSnapshotError, inspectGitSnapshot, isExactGitTopLevel } from '../utils/git-snapshot.js';
import type { HiveInvocation, HiveServices } from './hive-services.js';
import { z, type ArgInput, type ArgShape } from './schema.js';

const MAX_SNAPSHOT_REPOSITORIES = 32;

/** The serialization every v1 result uses, and the one the named context read measures its `maxBytes` budget against. */
export const json = (value: unknown): string => JSON.stringify(value, null, 2);

/**
 * One ordinary Hive operation. `execute` returns a structured result; `output` says how a host presents it:
 * `json` serializes the result, `text` passes the returned string through unchanged.
 */
export type HiveOperation = {
  description: string;
  args: ArgShape;
  output: 'json' | 'text';
  execute: (input: any, invocation: HiveInvocation) => unknown;
};

export function presentHiveResult(operation: HiveOperation, result: unknown): string {
  return operation.output === 'text' ? result as string : json(result);
}

function operation<Shape extends ArgShape>(definition: {
  description: string;
  args: Shape;
  output?: 'text';
  execute: (input: ArgInput<Shape>, invocation: HiveInvocation) => unknown;
}): HiveOperation {
  return { description: definition.description, args: definition.args, output: definition.output ?? 'json', execute: definition.execute };
}

const targetIdentitySchema = z.object({
  path: z.string(),
  ref: z.string().nullable(),
  commit: z.string(),
});

function normalizeMergePins(
  inspected: { commit: string; repos?: Record<string, { commit: string }> },
  sourceCommit: string | undefined,
  sourceCommits: Record<string, string> | undefined,
): { sourceCommit?: string; sourceCommits?: Record<string, string> } {
  if (sourceCommit !== undefined && sourceCommits !== undefined) throw new Error('sourceCommit and sourceCommits cannot both be supplied');

  if (!inspected.repos) {
    if (sourceCommits !== undefined) throw new Error('sourceCommits require a composite candidate');
    if (sourceCommit !== undefined && sourceCommit !== inspected.commit) throw new Error('sourceCommit does not match the inspected candidate');
    return { sourceCommit: sourceCommit ?? inspected.commit };
  }

  const actualPins = Object.fromEntries(Object.entries(inspected.repos).map(([id, repo]) => [id, repo.commit]));
  const samePins = sourceCommits === undefined
    || JSON.stringify(Object.entries(sourceCommits).sort()) === JSON.stringify(Object.entries(actualPins).sort());
  if (sourceCommit !== undefined) {
    const repoIds = Object.keys(actualPins);
    if (repoIds.length !== 1) throw new Error('sourceCommit cannot select a composite candidate');
    const repoId = repoIds[0]!;
    if (sourceCommit !== actualPins[repoId]) throw new Error('sourceCommit does not match the inspected candidate');
    return { sourceCommits: { [repoId]: sourceCommit } };
  }
  if (!samePins) throw new Error('sourceCommits must exactly match every inspected candidate repository');
  return { sourceCommits: sourceCommits ?? actualPins };
}

function snapshotFailure(error: unknown, repositoryId?: string) {
  if (!(error instanceof GitSnapshotError)) {
    return {
      repositoryId,
      code: 'INVALID_REQUEST' as const,
      phase: 'validation' as const,
      retry: 'not-retryable' as const,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const failure = error;
  return {
    repositoryId,
    code: failure.code,
    phase: failure.phase,
    retry: failure.retry,
    message: failure.message,
  };
}

type NamedReadCursor = { v: 1; n: string; k: string; r: number; s: string; h: string; o: number };

/**
 * Named context reads page through a document with opaque cursors. The cursor binds the document name, scope,
 * revision, snapshot and content hash under a per-activation secret, so a cursor from another document, an earlier
 * revision or another run fails as stale rather than returning a mismatched chunk.
 */
function createNamedContextReader(services: HiveServices) {
  const cursorSecret = randomBytes(32);
  const decodeCursor = (cursor: string, name: string, scopeKey: string): NamedReadCursor => {
    try {
      if (Buffer.byteLength(cursor, 'utf8') > 4_096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('encoding');
      const envelope = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { payload?: unknown; mac?: unknown };
      if (typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string') throw new Error('shape');
      const expected = createHmac('sha256', cursorSecret).update(envelope.payload).digest();
      const actual = Buffer.from(envelope.mac, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('integrity');
      const continuation = JSON.parse(envelope.payload) as NamedReadCursor;
      if (continuation?.v !== 1 || continuation.n !== name || continuation.k !== scopeKey
        || !Number.isInteger(continuation.r) || !Number.isSafeInteger(continuation.o) || continuation.o <= 0
        || typeof continuation.s !== 'string' || typeof continuation.h !== 'string') throw new Error('shape');
      return continuation;
    } catch {
      throw new ContextMutationError('stale_context_cursor', 'The named-read cursor is invalid, expired, or belongs to another document.');
    }
  };

  return (resolved: ReturnType<HiveServices['contextScope']>, name: string, cursor: string | undefined, maxBytes: number | undefined): unknown => {
    const scopeKey = resolved.type === 'project' ? 'project' : `feature:${resolved.featureName}`;
    const continuation = cursor ? decodeCursor(cursor, name, scopeKey) : undefined;
    const budget = maxBytes ?? 16 * 1024;
    if (!Number.isInteger(budget) || budget < 256 || budget > 64 * 1024) throw new ContextMutationError('context_input_too_large', 'maxBytes must be between 256 and 65536.');
    let chunkBudget = budget - 256;
    for (;;) {
      let result;
      try {
        result = services.contextService.readContent(resolved, name, { offset: continuation?.o, maxBytes: Math.max(256, chunkBudget) });
      } catch (error) {
        if (continuation && (error as { reason?: string }).reason === 'invalid_argument') {
          throw new ContextMutationError('stale_context_cursor', 'The named-read cursor byte boundary is no longer valid.');
        }
        throw error;
      }
      if (continuation && (!result || result.revision !== continuation.r || result.snapshot !== continuation.s || result.file.contentHash !== continuation.h)) {
        throw new ContextMutationError('stale_context_cursor', 'Context changed between named-read chunks.');
      }
      if (!result) return null;
      const nextOffset = result.complete ? undefined : result.range.endByte;
      const payload = nextOffset === undefined ? undefined : JSON.stringify({ v: 1, n: name, k: scopeKey, r: result.revision, s: result.snapshot, h: result.file.contentHash, o: nextOffset });
      const nextCursor = payload === undefined ? undefined : Buffer.from(JSON.stringify({ payload, mac: createHmac('sha256', cursorSecret).update(payload).digest('hex') })).toString('base64url');
      const output = { ...result, ...(nextCursor ? { nextCursor } : {}) };
      const excess = Buffer.byteLength(json(output), 'utf8') - budget;
      if (excess <= 0) return output;
      chunkBudget -= excess;
      if (chunkBudget < 256) throw new ContextMutationError('context_response_too_large', 'The named-read response envelope exceeds maxBytes.');
    }
  };
}

/**
 * The 31 ordinary Hive operations, keyed by tool name in registration order. Trace and background tools stay with
 * their own owners. Each operation takes the caller's identity explicitly and resolves feature or session state
 * only through the services it needs.
 */
export function createHiveOperations(services: HiveServices): Record<string, HiveOperation> {
  const {
    projectRoot, featureService, planService, taskService, sessionService, featureConstraintService, contextService,
    repositoryManifestService, worktreeService, configFallbackWarning, hasManifest, repositoryResolver, adhocService,
    requireFeature, contextScope, constraintTarget, readConstraints, assertTaskRepoIds,
  } = services;
  const readNamedContext = createNamedContextReader(services);

  return {
    hive_feature_create: operation({
      description: 'Create a new feature',
      args: { name: z.string(), ticket: z.string().optional() },
      execute: ({ name, ticket }) => featureService.create(name, ticket),
    }),
    hive_feature_select: operation({
      description: 'Select a feature for this session, or select null for an explicitly featureless route.',
      args: { feature: z.string().nullable() },
      execute: ({ feature }, invocation) => {
        if (!invocation.sessionID) throw new Error('Session identity is required');
        return sessionService.setFeatureRoute(invocation.sessionID, feature);
      },
    }),
    hive_feature_complete: operation({
      description: 'Mark a feature completed. Incomplete tasks are returned as warnings.',
      args: { name: z.string().optional() },
      execute: ({ name }, invocation) => {
        const feature = requireFeature(name, invocation);
        const incompleteTasks = taskService.listStatusEntries(feature).filter((task) => task.status !== 'done' && task.status !== 'cancelled');
        const result = featureService.complete(feature);
        return { success: true, feature: result, warnings: incompleteTasks.length ? [{ incompleteTasks }] : [] };
      },
    }),
    hive_repositories_status: operation({ description: 'Inspect project repository mode and manifest.', args: {}, execute: () => repositoryManifestService.getStatus() }),
    hive_repositories_discover: operation({ description: 'Discover repositories.', args: {}, execute: () => repositoryManifestService.discover() }),
    hive_repositories_update: operation({
      description: 'Add repositories to the project manifest.',
      args: { repositories: z.array(z.object({ id: z.string(), path: z.string() })) },
      execute: ({ repositories }) => repositoryManifestService.add(repositories),
    }),
    hive_plan_write: operation({
      description: 'Write plan.md.',
      args: { content: z.string(), feature: z.string().optional() },
      execute: ({ content, feature }, invocation) => planService.write(requireFeature(feature, invocation), content),
    }),
    hive_plan_patch: operation({
      description: 'Patch bounded plan sections.',
      args: {
        expectedRevision: z.string(),
        operations: z.array(z.object({ type: z.enum(['replace_section', 'replace_task', 'insert_after_section']), headingPath: z.array(z.string()).optional(), taskNumber: z.number().optional(), content: z.string() })),
        feature: z.string().optional(),
      },
      execute: ({ expectedRevision, operations, feature }, invocation) => planService.patch(requireFeature(feature, invocation), expectedRevision, operations as any),
    }),
    hive_plan_read: operation({
      description: 'Read plan.md.',
      args: { feature: z.string().optional(), mode: z.enum(['full', 'outline']).optional() },
      execute: ({ feature, mode }, invocation) => {
        const selected = requireFeature(feature, invocation);
        return mode === 'outline' ? planService.read(selected, { mode: 'outline' }) : planService.read(selected, { mode: 'full' });
      },
    }),
    hive_plan_approve: operation({
      description: 'Approve the plan with explicit persistence-stage outcomes. Optional sync requires the reviewed expectedRevision, returns separate approval and task-sync outcomes, and rechecks approval after sync.',
      args: { feature: z.string().optional(), expectedRevision: z.string().optional(), sync: z.boolean().optional(), refreshPending: z.boolean().optional() },
      execute: ({ feature, expectedRevision, sync, refreshPending }, invocation) => {
        const selected = requireFeature(feature, invocation);
        if (sync !== true && refreshPending !== undefined) {
          return { success: false, reason: 'refresh_pending_requires_sync', stage: 'validation', approvalPersisted: planService.isApproved(selected), error: 'refreshPending requires sync: true.' };
        }
        const skippedSync = { success: false, skipped: true, reason: 'approval_failed' };
        if (sync === true && !expectedRevision?.trim()) {
          return { approval: { success: false, reason: 'expected_revision_required', stage: 'validation', approvalPersisted: planService.isApproved(selected), error: 'sync: true requires the expectedRevision returned by hive_plan_read.' }, sync: skippedSync };
        }
        let approval: PlanApprovalResult;
        try {
          approval = planService.approve(selected, expectedRevision);
        } catch (error) {
          const failed = error instanceof PlanApprovalError
            ? { success: false, reason: error.reason, stage: error.stage, approvalPersisted: error.approvalPersisted, ...(error.revision ? { revision: error.revision } : {}), error: error.message }
            : { success: false, reason: 'plan_approval_failed', stage: 'validation', approvalPersisted: planService.isApproved(selected), error: error instanceof Error ? error.message : String(error) };
          return sync === true ? { approval: failed, sync: skippedSync } : failed;
        }
        if (sync !== true) return approval;
        let syncResult;
        try {
          syncResult = { success: true, ...taskService.sync(selected, { refreshPending }) };
        } catch (error) {
          syncResult = { success: false, reason: 'task_sync_failed', error: error instanceof Error ? error.message : String(error) };
        }
        // Approval releases its lock before sync; another writer can invalidate this outcome.
        try {
          const current = planService.read(selected);
          if (current?.status !== 'approved' || current.revision !== approval.revision) {
            return { approval: { success: false, reason: 'approval_superseded_during_sync', stage: 'sync_verification', approvalPersisted: planService.isApproved(selected), revision: approval.revision, currentRevision: current?.revision, error: 'Plan approval changed during task sync. Read and review the current plan before approving and syncing again.' }, sync: syncResult };
          }
        } catch (error) {
          return { approval: { success: false, reason: 'approval_verification_failed', stage: 'sync_verification', approvalPersisted: planService.isApproved(selected), revision: approval.revision, error: error instanceof Error ? error.message : String(error) }, sync: syncResult };
        }
        return { approval, sync: syncResult };
      },
    }),
    hive_tasks_sync: operation({
      description: 'Sync tasks from the approved plan.',
      args: { feature: z.string().optional(), refreshPending: z.boolean().optional() },
      execute: ({ feature, refreshPending }, invocation) => taskService.sync(requireFeature(feature, invocation), { refreshPending }),
    }),
    hive_task_create: operation({
      description: 'Create an append-only manual task. Dependencies need only reference existing tasks.',
      args: {
        name: z.string(), order: z.number().optional(), feature: z.string().optional(),
        description: z.string().optional(), goal: z.string().optional(), acceptanceCriteria: z.array(z.string()).optional(),
        references: z.array(z.string()).optional(), files: z.array(z.string()).optional(), dependsOn: z.array(z.string()).optional(),
        reason: z.string().optional(), source: z.string().optional(), repos: z.array(z.string()).optional(),
      },
      output: 'text',
      execute: ({ name, order, feature, repos, ...metadata }, invocation) => taskService.create(requireFeature(feature, invocation), name, order, { ...metadata, repoIds: repos } as any),
    }),
    hive_task_update: operation({
      description: `Update task state, optionally persist an immutable report (next reports/{N}.md, mirrored to report.md; returns reportPath), and optionally replace the successor handoff (handoff.md, at most ${TASK_HANDOFF_MAX_BYTES} UTF-8 bytes). Omitted fields are preserved. Validation rejections write nothing. On success: false or an unknown result, inspect the files named by failedStage, reportPath, and the written/published flags before retrying; the flags are hints, and a report already in history must not be resubmitted.`,
      args: {
        task: z.string(),
        status: z.enum(['pending', 'in_progress', 'done', 'cancelled', 'blocked', 'failed', 'partial']).optional(),
        summary: z.string().optional(),
        blocker: z.object({ reason: z.string(), options: z.array(z.string()).optional(), recommendation: z.string().optional(), context: z.string().optional() }).nullable().optional(),
        report: z.string().optional(),
        handoff: z.string().optional(),
        feature: z.string().optional(),
      },
      execute: ({ task, feature, ...updates }, invocation) => {
        try { return taskService.update(requireFeature(feature, invocation), task, updates); }
        catch (error) {
          if (!(error instanceof TaskUpdatePersistenceError)) throw error;
          return { success: false, reason: 'task_update_persistence_failed', error: error.message, failedStage: error.failedStage, reportPath: error.reportPath, latestReportPath: error.latestReportPath, reportHistoryWritten: error.reportHistoryWritten, latestReportWritten: error.latestReportWritten, handoffPath: error.handoffPath, handoffWritten: error.handoffWritten, failedWritePublished: error.failedWritePublished };
        }
      },
    }),
    hive_worktree_create: operation({
      description: 'Create a task worktree without changing task state and return its initial inspection, including source cleanliness and destination identity/comparison; later checkpoints still require hive_worktree_inspect.',
      args: { feature: z.string().optional(), task: z.string(), baseRef: z.string().optional(), repoIds: z.array(z.string()).optional(), candidate: z.string().optional() },
      execute: async ({ feature, task, baseRef, repoIds, candidate }, invocation) => {
        const selected = requireFeature(feature, invocation);
        assertTaskRepoIds(selected, task, repoIds);
        await worktreeService.create(selected, task, baseRef, candidate);
        const inspected = await worktreeService.inspect(selected, task, candidate);
        if (!inspected) throw new Error('Created task worktree not found during initial inspection');
        return inspected;
      },
    }),
    hive_worktree_inspect: operation({
      description: 'Inspect a task worktree.',
      args: { feature: z.string().optional(), task: z.string(), repoIds: z.array(z.string()).optional(), candidate: z.string().optional() },
      execute: async ({ feature, task, repoIds, candidate }, invocation) => {
        const selected = requireFeature(feature, invocation);
        assertTaskRepoIds(selected, task, repoIds);
        return worktreeService.inspect(selected, task, candidate);
      },
    }),
    hive_worktree_merge: operation({
      description: 'Merge an exact task worktree source into the current target.',
      args: {
        feature: z.string().optional(), task: z.string(), repoIds: z.array(z.string()).optional(), candidate: z.string().optional(),
        strategy: z.enum(['merge', 'squash', 'rebase']).optional(), message: z.string().optional(), preserveConflicts: z.boolean().optional(),
        cleanup: z.enum(['none', 'worktree', 'worktree+branch']).optional(), sourceCommit: z.string().optional(), sourceCommits: z.record(z.string(), z.string()).optional(),
        expectedTarget: targetIdentitySchema.optional(), expectedTargets: z.record(z.string(), targetIdentitySchema).optional(),
      },
      execute: async ({ feature, task, repoIds, candidate, strategy = 'squash', message, ...options }, invocation) => {
        const selected = requireFeature(feature, invocation);
        assertTaskRepoIds(selected, task, repoIds);
        const inspected = await worktreeService.inspect(selected, task, candidate);
        if (!inspected) throw new Error('Task worktree not found');
        const { sourceCommit, sourceCommits, ...mergeOptions } = options;
        const pins = normalizeMergePins(inspected, sourceCommit, sourceCommits);
        return worktreeService.merge(selected, task, strategy, message, { ...mergeOptions, ...pins } as MergeOptions, candidate);
      },
    }),
    hive_worktree_cleanup: operation({
      description: 'Clean up a task worktree. Set discard to explicitly retire unintegrated work.',
      args: { feature: z.string().optional(), task: z.string(), repoIds: z.array(z.string()).optional(), candidate: z.string().optional(), deleteBranch: z.boolean().optional(), discard: z.boolean().optional() },
      execute: async ({ feature, task, repoIds, candidate, deleteBranch, discard }, invocation) => {
        const selected = requireFeature(feature, invocation);
        assertTaskRepoIds(selected, task, repoIds);
        return worktreeService.remove(selected, task, deleteBranch, { discard }, candidate);
      },
    }),
    hive_adhoc_worktree_create: operation({
      description: 'Create the matching ad-hoc Hive worktree and return its initial inspection, including source cleanliness and destination identity/comparison; later checkpoints still require hive_adhoc_worktree_inspect. An absolute sourceDirectory resolving to the active project root is treated as omitted; foreign sourceDirectory cannot be combined with repoIds.',
      args: { runId: z.string().optional(), repoIds: z.array(z.string()).optional(), sourceDirectory: z.string().optional() },
      execute: async ({ sourceDirectory, ...options }) => {
        let normalizedSourceDirectory = sourceDirectory;
        if (sourceDirectory !== undefined) {
          if (!path.isAbsolute(sourceDirectory)) throw new Error('sourceDirectory must be absolute');
          const resolvedSourceDirectory = canonicalProjectRoot(sourceDirectory);
          normalizedSourceDirectory = projectRootsMatch(resolvedSourceDirectory, projectRoot) ? undefined : resolvedSourceDirectory;
        }
        let repoIds = options.repoIds;
        if (!normalizedSourceDirectory && repoIds?.length === 1) {
          const status = repositoryManifestService.getStatus();
          if (status.mode === 'legacy-root' && repoIds[0] === status.repositories[0]?.id) repoIds = undefined;
        }
        const service = adhocService(normalizedSourceDirectory, repoIds);
        const created = await service.create({ ...options, repoIds });
        const inspected = await service.inspect(created.runId);
        if (!inspected) throw new Error('Created ad-hoc worktree not found during initial inspection');
        return inspected;
      },
    }),
    hive_adhoc_worktree_inspect: operation({
      description: 'Inspect an ad-hoc worktree.',
      args: { runId: z.string(), repoIds: z.array(z.string()).optional(), sourceDirectory: z.string().optional() },
      execute: ({ runId, repoIds, sourceDirectory }) => adhocService(sourceDirectory, repoIds).inspect(runId),
    }),
    hive_adhoc_worktree_merge: operation({
      description: 'Merge an exact ad-hoc source into the selected target.',
      args: {
        runId: z.string(), repoIds: z.array(z.string()).optional(), sourceDirectory: z.string().optional(),
        strategy: z.enum(['merge', 'squash', 'rebase']).optional(), message: z.string().optional(), preserveConflicts: z.boolean().optional(), cleanup: z.enum(['none', 'worktree', 'worktree+branch']).optional(),
        sourceCommit: z.string().optional(), sourceCommits: z.record(z.string(), z.string()).optional(),
        expectedTarget: targetIdentitySchema.optional(), expectedTargets: z.record(z.string(), targetIdentitySchema).optional(),
      },
      execute: async ({ runId, repoIds, sourceDirectory, strategy = 'squash', message, ...options }) => {
        const service = adhocService(sourceDirectory, repoIds);
        const inspected = await service.inspect(runId);
        if (!inspected) throw new Error('Ad-hoc worktree not found');
        const { sourceCommit, sourceCommits, ...mergeOptions } = options;
        const pins = normalizeMergePins(inspected, sourceCommit, sourceCommits);
        return service.merge(runId, strategy, message, { ...mergeOptions, ...pins } as AdhocMergeOptions);
      },
    }),
    hive_adhoc_worktree_cleanup: operation({
      description: 'Clean up an ad-hoc worktree. Set discard to explicitly retire unintegrated work.',
      args: { runId: z.string(), repoIds: z.array(z.string()).optional(), sourceDirectory: z.string().optional(), deleteBranch: z.boolean().optional(), discard: z.boolean().optional() },
      execute: ({ runId, repoIds, sourceDirectory, deleteBranch, discard }) => adhocService(sourceDirectory, repoIds).cleanup(runId, deleteBranch, { discard }),
    }),
    hive_context_read: operation({
      description: 'Read managed project or feature context.',
      args: { name: z.string().optional(), scope: z.enum(['feature', 'project']).optional(), feature: z.string().optional(), view: z.enum(['summary', 'catalog']).optional(), query: z.string().optional(), limit: z.number().optional(), cursor: z.string().optional(), maxBytes: z.number().optional(), scanChars: z.boolean().optional() },
      execute: ({ name, scope, feature, view, query, limit, cursor, maxBytes, scanChars }, invocation) => {
        const resolved = contextScope(scope, feature, invocation);
        if (name) {
          if ([view, query, limit, scanChars].some((value) => value !== undefined)) throw new Error('Named context reads cannot be combined with list options');
          return readNamedContext(resolved, name, cursor, maxBytes);
        }
        if (maxBytes !== undefined) throw new Error('maxBytes is valid only for named context reads');
        if ((view ?? 'summary') === 'summary') {
          if ([query, limit, cursor].some((value) => value !== undefined)) throw new Error('Summary view cannot be combined with catalog options');
          return contextService.readSummary(resolved, { scanChars });
        }
        if (scanChars !== undefined) throw new Error('scanChars is valid only for summary view');
        return contextService.readCatalog(resolved, { query, limit, cursor });
      },
    }),
    hive_context_write: operation({
      description: 'Create or replace managed context.',
      args: { name: z.string(), content: z.string(), kind: z.enum(['durable', 'evidence']).optional(), task: z.string().optional(), expectedRevision: z.number().optional(), expectedContentHash: z.string().optional(), scope: z.enum(['feature', 'project']).optional(), feature: z.string().optional() },
      execute: ({ name, content, kind, task, expectedRevision, expectedContentHash, scope, feature }, invocation) => {
        const resolved = contextScope(scope, feature, invocation, task);
        return expectedRevision === undefined
          ? contextService.create(resolved, name, content, { kind, task })
          : contextService.replace(resolved, name, content, expectedRevision, expectedContentHash!, { kind, task });
      },
    }),
    hive_context_append: operation({
      description: 'Append to managed context.',
      args: { name: z.string(), content: z.string(), section: z.string().optional(), task: z.string().optional(), expectedRevision: z.number(), expectedContentHash: z.string(), scope: z.enum(['feature', 'project']).optional(), feature: z.string().optional() },
      execute: ({ name, content, section, task, expectedRevision, expectedContentHash, scope, feature }, invocation) => contextService.append(contextScope(scope, feature, invocation, task), name, content, expectedRevision, expectedContentHash, { section, task }),
    }),
    hive_context_archive: operation({
      description: 'Archive selected managed context.',
      args: { names: z.array(z.string()), reason: z.string(), expectedRevision: z.number(), expectedContentHashes: z.record(z.string(), z.string()), scope: z.enum(['feature', 'project']).optional(), feature: z.string().optional() },
      execute: ({ names, reason, expectedRevision, expectedContentHashes, scope, feature }, invocation) => contextService.archiveSelected(contextScope(scope, feature, invocation), names, reason, expectedRevision, expectedContentHashes),
    }),
    hive_constraints_read: operation({
      description: 'Read session or feature constraints.',
      args: { scope: z.enum(['session', 'feature']).optional(), feature: z.string().optional() },
      execute: (input, invocation) => readConstraints(constraintTarget(input, invocation)),
    }),
    hive_constraints_add: operation({
      description: 'Add a session or feature constraint.',
      args: { constraints: z.string(), scope: z.enum(['session', 'feature']).optional(), feature: z.string().optional() },
      execute: ({ constraints, ...input }, invocation) => {
        const target = constraintTarget(input, invocation);
        return target.scope === 'session' ? sessionService.addStandingConstraint(target.sessionID, constraints) : featureConstraintService.add(target.feature, constraints);
      },
    }),
    hive_constraints_edit: operation({
      description: 'Edit or remove a session or feature constraint.',
      args: { id: z.string(), expectedRevision: z.number(), constraints: z.string().optional(), remove: z.boolean().optional(), scope: z.enum(['session', 'feature']).optional(), feature: z.string().optional() },
      execute: ({ id, expectedRevision, constraints, remove, ...input }, invocation) => {
        if ((remove === true) === (constraints !== undefined)) throw new Error('Provide exactly one of nonblank constraints or remove: true');
        if (constraints !== undefined && !constraints.trim()) throw new Error('constraints must be nonblank');
        const target = constraintTarget(input, invocation);
        const replacement = remove === true ? null : constraints!;
        return target.scope === 'session' ? sessionService.editStandingConstraint(target.sessionID, id, expectedRevision, replacement) : featureConstraintService.edit(target.feature, id, expectedRevision, replacement);
      },
    }),
    hive_constraints_clear: operation({
      description: 'Clear session or feature constraints.',
      args: { expectedRevision: z.number(), scope: z.enum(['session', 'feature']).optional(), feature: z.string().optional() },
      execute: ({ expectedRevision, ...input }, invocation) => {
        const target = constraintTarget(input, invocation);
        return target.scope === 'session' ? sessionService.clearStandingConstraints(target.sessionID, expectedRevision) : featureConstraintService.clear(target.feature, expectedRevision);
      },
    }),
    hive_status: operation({
      description: 'Get feature metadata, one top-level task list with integrity entries/blockers/freshness/handoffs, dependency readiness, and worktree state. Integrity entries are never runnable.',
      args: { feature: z.string().optional() },
      execute: async ({ feature }, invocation) => {
        const selected = requireFeature(feature, invocation);
        const tasks = taskService.listStatusEntries(selected);
        const { worktrees, errors: worktreeErrors } = await worktreeService.list(selected);
        const info = featureService.get(selected);
        let freshness = new Map<string, TaskSpecFreshness>();
        let specFreshnessError: string | undefined;
        let unownedTaskHeadings: PlanUnownedTaskHeading[] | undefined;
        try {
          unownedTaskHeadings = planService.read(selected)?.unownedTaskHeadings;
          freshness = new Map(taskService.getSpecFreshness(selected).map((entry) => [entry.folder, entry]));
        } catch (error) {
          specFreshnessError = error instanceof Error ? error.message : String(error);
        }
        const projectedTasks = tasks.map(task => {
          return {
            ...task,
            specStale: freshness.get(task.folder)?.specStale ?? null,
            specStaleReason: freshness.get(task.folder)?.specStaleReason ?? 'freshness_unavailable',
            hasHandoff: fs.existsSync(getTaskHandoffPath(projectRoot, selected, task.folder)),
          };
        });
        const graph = computeRunnableAndBlocked(projectedTasks.filter(task => task.status !== null));
        return {
          feature: info ? { name: info.name, status: info.status, hasPlan: fs.existsSync(getPlanPath(projectRoot, selected)), commentCount: planService.getComments(selected).length } : null,
          tasks: projectedTasks,
          runnable: graph.runnable,
          blocked: graph.blocked,
          worktrees,
          ...(unownedTaskHeadings ? { unownedTaskHeadings } : {}),
          ...(worktreeErrors.length ? { worktreeErrors } : {}),
          ...(specFreshnessError ? { specFreshnessError } : {}),
          ...(configFallbackWarning ? { warning: configFallbackWarning } : {}),
        };
      },
    }),
    hive_git_snapshot: operation({
      description: 'Capture a validated Git snapshot, optionally from an explicit foreign Git root.',
      args: { directory: z.string().optional(), repositoryIds: z.array(z.string()).optional(), baseRef: z.string().optional(), targetRef: z.string().optional(), range: z.string().optional(), paths: z.array(z.string()).optional(), maxFiles: z.number().optional(), maxPatchBytes: z.number().optional() },
      execute: async ({ directory: sourceDirectory, repositoryIds, ...snapshot }) => {
        try {
          if (sourceDirectory !== undefined) {
            if (repositoryIds !== undefined) throw new Error('directory cannot be combined with repositoryIds');
            if (!path.isAbsolute(sourceDirectory)) throw new Error('directory must be absolute');
            const root = fs.realpathSync(sourceDirectory);
            if (!(await isExactGitTopLevel(root))) throw new Error('directory must be an exact Git top-level');
            if (await readCompositeWorkspaceManifest(root)) throw new Error('Foreign directory snapshots do not consume a Hive manifest');
            return { schema: 'hive-git-snapshot/v1', status: 'ready', consistency: 'validated', snapshots: [{ repositoryId: 'root', snapshot: await inspectGitSnapshot(root, snapshot) }] };
          }
          if (repositoryIds !== undefined && !hasManifest()) throw new Error('repositoryIds require a repository manifest');
          if (repositoryIds !== undefined && repositoryIds.length === 0) throw new Error('repositoryIds must not be empty');
          if (repositoryIds !== undefined && new Set(repositoryIds).size !== repositoryIds.length) throw new Error('repositoryIds must not contain duplicates');
          const available = hasManifest() ? repositoryResolver() : [{ id: 'root', root: projectRoot, path: projectRoot } as any];
          const availableIds = new Set(available.map((repo) => repo.id));
          const unknown = repositoryIds?.filter((id) => !availableIds.has(id)) ?? [];
          if (unknown.length) throw new Error(`Unknown repositoryIds: ${unknown.join(', ')}`);
          const repositories = repositoryIds === undefined ? available : available.filter((repo) => repositoryIds.includes(repo.id));
          if (repositories.length > MAX_SNAPSHOT_REPOSITORIES) throw new Error(`Snapshot repository count exceeds ${MAX_SNAPSHOT_REPOSITORIES}`);
          const outcomes = await Promise.all(repositories.map(async (repo) => {
            try { return { repositoryId: repo.id, snapshot: await inspectGitSnapshot(repo.root ?? repo.path, snapshot) }; }
            catch (error) { return { repositoryId: repo.id, error: snapshotFailure(error, repo.id) }; }
          }));
          const failures = outcomes.filter((outcome): outcome is { repositoryId: string; error: ReturnType<typeof snapshotFailure> } => 'error' in outcome);
          if (failures.length) return { schema: 'hive-git-snapshot/v1', status: 'failed', consistency: 'failed', failures: failures.map(({ error }) => error) };
          return { schema: 'hive-git-snapshot/v1', status: 'ready', consistency: 'validated', snapshots: outcomes };
        } catch (error) {
          return { schema: 'hive-git-snapshot/v1', status: 'failed', consistency: 'failed', failures: [snapshotFailure(error)] };
        }
      },
    }),
  };
}
