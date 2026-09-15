/**
 * Canonical execution ownership for managed writers.
 *
 * Live claims are unsettled ExecutionAttempt rows in `.hive/execution-attempts.json`.
 * NativeTaskLease values are diagnostic history only. Mixed old lease-based plugins
 * after this cutover are unsupported.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import {
  acquireLockSync,
  ensureDir,
  fileExists,
  getExecutionAttemptsPath,
  readJson,
  writeJsonAtomic,
} from '../utils/paths.js';
import type {
  ExecutionAttempt,
  ExecutionAttemptAssignmentRef,
  ExecutionAttemptsJson,
  ExecutionObservedOutcome,
  NativeTaskLease,
} from '../types.js';
import {
  EXECUTION_ATTEMPTS_SCHEMA_VERSION,
  PLACEHOLDER_NATIVE_CHILD_ID,
  PREPARED_ATTEMPT_TTL_MS,
} from '../types.js';
import { SessionService } from './sessionService.js';
import { TaskService } from './taskService.js';

export interface PrepareExecutionAttemptInput {
  kind: ExecutionAttempt['kind'];
  originatingPrimarySession: string;
  workspaceIdentities: string[];
  featureName?: string;
  taskFolder?: string;
  runId?: string;
  assignment?: ExecutionAttemptAssignmentRef;
  attemptSlot?: string;
  branch?: string;
  baseCommit?: string;
  launchId?: string;
  nativeCallId?: string;
}

export interface PrepareExecutionAttemptResult {
  attempt: ExecutionAttempt;
  existing: boolean;
}

export interface SettleExecutionAttemptInput {
  reportLocator?: string;
  reportContentHash?: string;
}

function taskPointerKey(featureName: string, taskFolder: string): string {
  return `${featureName}\u001f${taskFolder}`;
}

function leaseHistoryKey(lease: NativeTaskLease): string {
  return `${lease.parentSessionId}\0${lease.callId}`;
}

function isPlaceholderNativeChildId(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.trim().length === 0 || value.trim() === PLACEHOLDER_NATIVE_CHILD_ID;
}

function isCapabilityLease(lease: NativeTaskLease): boolean {
  return lease.capabilityReason !== undefined
    || lease.agent === 'hive-helper'
    || lease.agent === 'general';
}

function identitiesIntersect(left: string[], right: string[]): boolean {
  const claimed = new Set(left);
  return right.some(identity => claimed.has(identity));
}

export class ExecutionAttemptService {
  private readonly taskService: TaskService;
  private readonly sessionService: SessionService;

  constructor(private readonly projectRoot: string) {
    this.taskService = new TaskService(projectRoot);
    this.sessionService = new SessionService(projectRoot);
    this.migrate();
  }

  migrate(): void {
    const extracted = this.sessionService.peekNativeTaskLeases();
    const filePath = getExecutionAttemptsPath(this.projectRoot);
    if (extracted.length === 0 && !fileExists(filePath)) return;
    this.withStore(store => {
      this.mergeMigratedLeases(store, extracted);
    });
    this.sessionService.extractNativeTaskLeases();
  }

  prepare(input: PrepareExecutionAttemptInput): PrepareExecutionAttemptResult {
    this.assertPrepareShape(input);
    const workspaceIdentities = this.canonicalizeWorkspaceIdentities(input.workspaceIdentities);
    return this.withStore(store => {
      if (input.kind === 'task') {
        const existing = this.currentUnsettledTaskAttempt(store, input.featureName!, input.taskFolder!);
        if (existing) return { attempt: structuredClone(existing), existing: true };
      } else {
        const existing = this.unsettledAdhocAttempt(store, input.runId!);
        if (existing) {
          if (existing.observation === 'unobserved') {
            throw new Error(`Ad-hoc run '${input.runId}' is unobserved and cannot be reused`);
          }
          return { attempt: structuredClone(existing), existing: true };
        }
      }

      this.assertWorkspacesIdleInStore(store, workspaceIdentities);
      const now = new Date().toISOString();
      const attempt = this.createAttemptRecord(store, input, workspaceIdentities, now);
      store.attempts.push(attempt);
      if (attempt.kind === 'task') {
        this.setCurrentTaskAttempt(store, attempt.featureName!, attempt.taskFolder!, attempt.id);
      }
      return { attempt: structuredClone(attempt), existing: false };
    });
  }

  supersede(supersededAttemptId: string, input: PrepareExecutionAttemptInput): PrepareExecutionAttemptResult {
    this.assertPrepareShape(input);
    if (input.kind !== 'task') {
      throw new Error('Only task attempts can be superseded');
    }
    const workspaceIdentities = this.canonicalizeWorkspaceIdentities(input.workspaceIdentities);
    return this.withStore(store => {
      const oldAttempt = this.requireAttempt(store, supersededAttemptId);
      if (oldAttempt.kind !== 'task' || oldAttempt.featureName !== input.featureName
        || oldAttempt.taskFolder !== input.taskFolder) {
        throw new Error(`Attempt ${supersededAttemptId} is not the current task identity for ${input.featureName}/${input.taskFolder}`);
      }
      if (oldAttempt.dispatchState === 'settled') {
        throw new Error(`Attempt ${supersededAttemptId} is already settled`);
      }
      if (!this.isCurrentTaskAttemptInStore(store, input.featureName!, input.taskFolder!, oldAttempt.id)) {
        throw new Error(`Attempt ${supersededAttemptId} is not the current task attempt`);
      }
      this.assertWorkspacesIdleInStore(store, workspaceIdentities);
      const now = new Date().toISOString();
      const replacement = this.createAttemptRecord(store, input, workspaceIdentities, now);
      oldAttempt.supersededBy = replacement.id;
      oldAttempt.updatedAt = now;
      store.attempts.push(replacement);
      this.setCurrentTaskAttempt(store, replacement.featureName!, replacement.taskFolder!, replacement.id);
      return { attempt: structuredClone(replacement), existing: false };
    });
  }

  consumeLaunch(launchId: string, nativeCallId?: string): ExecutionAttempt {
    const normalized = this.requireToken(launchId, 'launchId');
    const callId = nativeCallId === undefined ? undefined : this.requireToken(nativeCallId, 'nativeCallId');
    return this.withStore(store => {
      const matches = store.attempts.filter(attempt => attempt.launchId === normalized);
      if (matches.length !== 1) throw new Error(`Launch id '${normalized}' is not a unique prepared attempt`);
      const attempt = matches[0]!;
      if (attempt.dispatchState !== 'prepared') {
        throw new Error(`Launch id '${normalized}' already consumed`);
      }
      if (callId && attempt.nativeCallId && attempt.nativeCallId !== callId) {
        throw new Error(`Contradictory native call id for attempt ${attempt.id}`);
      }
      attempt.dispatchState = 'dispatched';
      if (callId) attempt.nativeCallId = callId;
      attempt.updatedAt = new Date().toISOString();
      return structuredClone(attempt);
    });
  }

  bindNativeChild(attemptId: string, nativeChildSessionId: string): ExecutionAttempt {
    if (isPlaceholderNativeChildId(nativeChildSessionId)
      || nativeChildSessionId !== nativeChildSessionId.trim()) {
      throw new Error('Placeholder native child id is not bindable');
    }
    const childId = this.requireToken(nativeChildSessionId, 'nativeChildSessionId');
    return this.withStore(store => {
      const attempt = this.requireAttempt(store, attemptId);
      if (attempt.dispatchState === 'settled') {
        throw new Error(`Execution attempt ${attemptId} is already settled`);
      }
      const owner = store.attempts.find(candidate => candidate.nativeChildSessionId === childId);
      if (owner && owner.id !== attempt.id) {
        throw new Error('Contradictory native child session');
      }
      if (attempt.nativeChildSessionId && attempt.nativeChildSessionId !== childId) {
        throw new Error('Contradictory native child session');
      }
      attempt.nativeChildSessionId = childId;
      attempt.updatedAt = new Date().toISOString();
      return structuredClone(attempt);
    });
  }

  markUnobserved(attemptId: string): ExecutionAttempt {
    return this.withStore(store => {
      const attempt = this.requireAttempt(store, attemptId);
      if (attempt.dispatchState !== 'dispatched') {
        throw new Error(`Only dispatched attempts can be marked unobserved (${attemptId})`);
      }
      attempt.observation = 'unobserved';
      attempt.updatedAt = new Date().toISOString();
      return structuredClone(attempt);
    });
  }

  markObserved(attemptId: string): ExecutionAttempt {
    return this.withStore(store => {
      const attempt = this.requireAttempt(store, attemptId);
      if (attempt.dispatchState !== 'dispatched') {
        throw new Error(`Only dispatched attempts can be marked observed (${attemptId})`);
      }
      attempt.observation = 'observed';
      attempt.updatedAt = new Date().toISOString();
      return structuredClone(attempt);
    });
  }

  settle(
    attemptId: string,
    outcome: ExecutionObservedOutcome,
    extras: SettleExecutionAttemptInput = {},
  ): ExecutionAttempt {
    return this.withStore(store => {
      const attempt = this.requireAttempt(store, attemptId);
      this.settleAttemptRecord(attempt, outcome, extras);
      return structuredClone(attempt);
    });
  }

  isCurrentTaskAttempt(featureName: string, taskFolder: string, attemptId: string): boolean {
    const store = this.readStore();
    return this.isCurrentTaskAttemptInStore(store, featureName, taskFolder, attemptId);
  }

  assertWorkspacesIdle(workspaceIdentities: string[]): void {
    const identities = this.canonicalizeWorkspaceIdentities(workspaceIdentities);
    this.withStore(store => {
      this.assertWorkspacesIdleInStore(store, identities);
    });
  }

  getAttempt(attemptId: string): ExecutionAttempt | undefined {
    const attempt = this.readStore().attempts.find(candidate => candidate.id === attemptId);
    return attempt ? structuredClone(attempt) : undefined;
  }

  listAttempts(): ExecutionAttempt[] {
    return structuredClone(this.readStore().attempts);
  }

  recordAssignment(attemptId: string, assignment: ExecutionAttemptAssignmentRef): ExecutionAttempt {
    return this.withStore(store => {
      const attempt = this.requireAttempt(store, attemptId);
      if (attempt.kind !== 'task') {
        throw new Error(`Execution attempt ${attemptId} is not a task attempt`);
      }
      if (attempt.assignment && attempt.assignment.taskAttempt !== assignment.taskAttempt) {
        throw new Error('Assignment taskAttempt does not match the allocated worker attempt');
      }
      const next: ExecutionAttemptAssignmentRef = {
        taskAttempt: assignment.taskAttempt,
      };
      const locator = assignment.locator ?? attempt.assignment?.locator;
      const contentHash = assignment.contentHash ?? attempt.assignment?.contentHash;
      if (locator) next.locator = locator;
      if (contentHash) next.contentHash = contentHash;
      attempt.assignment = next;
      attempt.updatedAt = new Date().toISOString();
      return structuredClone(attempt);
    });
  }

  recordHandoff(attemptId: string, extras: SettleExecutionAttemptInput): ExecutionAttempt {
    return this.withStore(store => {
      const attempt = this.requireAttempt(store, attemptId);
      if (extras.reportLocator) attempt.reportLocator = extras.reportLocator;
      if (extras.reportContentHash) attempt.reportContentHash = extras.reportContentHash;
      attempt.updatedAt = new Date().toISOString();
      return structuredClone(attempt);
    });
  }

  private hasPersistableState(store: ExecutionAttemptsJson): boolean {
    return store.attempts.length > 0
      || (store.nativeTaskLeaseHistory?.length ?? 0) > 0
      || Object.keys(store.currentTaskAttempts ?? {}).length > 0;
  }

  private withStore<T>(mutator: (store: ExecutionAttemptsJson) => T): T {
    const filePath = getExecutionAttemptsPath(this.projectRoot);
    const existed = fileExists(filePath);
    ensureDir(path.dirname(filePath));
    const release = acquireLockSync(filePath);
    try {
      const store = this.readStoreUnlocked();
      this.expirePreparedInStore(store);
      const result = mutator(store);
      if (existed || this.hasPersistableState(store)) {
        writeJsonAtomic(filePath, store);
      }
      return result;
    } finally {
      release();
    }
  }

  private readStore(): ExecutionAttemptsJson {
    const filePath = getExecutionAttemptsPath(this.projectRoot);
    if (!fileExists(filePath)) {
      return { schemaVersion: EXECUTION_ATTEMPTS_SCHEMA_VERSION, attempts: [] };
    }
    const release = acquireLockSync(filePath);
    try {
      const store = this.readStoreUnlocked();
      if (!this.expirePreparedInStore(store)) return store;
      writeJsonAtomic(filePath, store);
      return store;
    } finally {
      release();
    }
  }

  private readStoreUnlocked(): ExecutionAttemptsJson {
    const loaded = readJson<ExecutionAttemptsJson>(getExecutionAttemptsPath(this.projectRoot));
    if (!loaded) return { schemaVersion: EXECUTION_ATTEMPTS_SCHEMA_VERSION, attempts: [] };
    if (loaded.schemaVersion !== EXECUTION_ATTEMPTS_SCHEMA_VERSION) {
      throw new Error(`Unsupported execution-attempts schemaVersion ${String(loaded.schemaVersion)}`);
    }
    loaded.attempts ??= [];
    return loaded;
  }

  private expirePreparedInStore(store: ExecutionAttemptsJson, nowMs = Date.now()): boolean {
    let expired = false;
    for (const attempt of store.attempts) {
      if (attempt.dispatchState !== 'prepared') continue;
      if (nowMs - Date.parse(attempt.createdAt) < PREPARED_ATTEMPT_TTL_MS) continue;
      this.settleAttemptRecord(attempt, 'expired');
      expired = true;
    }
    return expired;
  }

  private createAttemptRecord(
    store: ExecutionAttemptsJson,
    input: PrepareExecutionAttemptInput,
    workspaceIdentities: string[],
    now: string,
  ): ExecutionAttempt {
    const launchId = input.launchId === undefined
      ? randomUUID()
      : this.requireToken(input.launchId, 'launchId');
    if (store.attempts.some(attempt => attempt.launchId === launchId)) {
      throw new Error(`Launch id '${launchId}' already consumed`);
    }
    const assignment = input.kind === 'task' ? this.allocateTaskAssignment(input) : undefined;
    const attempt: ExecutionAttempt = {
      id: randomUUID(),
      kind: input.kind,
      originatingPrimarySession: this.requireToken(input.originatingPrimarySession, 'originatingPrimarySession'),
      workspaceIdentities,
      launchId,
      dispatchState: 'prepared',
      createdAt: now,
      updatedAt: now,
    };
    if (input.kind === 'task') {
      attempt.featureName = input.featureName;
      attempt.taskFolder = input.taskFolder;
      attempt.assignment = assignment;
    } else {
      attempt.runId = input.runId;
    }
    if (input.attemptSlot) attempt.attemptSlot = this.requireToken(input.attemptSlot, 'attemptSlot');
    if (input.branch) attempt.branch = input.branch;
    if (input.baseCommit) attempt.baseCommit = input.baseCommit;
    if (input.nativeCallId) attempt.nativeCallId = this.requireToken(input.nativeCallId, 'nativeCallId');
    return attempt;
  }

  private allocateTaskAssignment(input: PrepareExecutionAttemptInput): ExecutionAttemptAssignmentRef {
    const allocation = this.taskService.allocateWorkerAttempt(input.featureName!, input.taskFolder!);
    if (input.assignment && input.assignment.taskAttempt !== allocation.attempt) {
      throw new Error('Assignment taskAttempt does not match the allocated worker attempt');
    }
    const assignment: ExecutionAttemptAssignmentRef = { taskAttempt: allocation.attempt };
    if (input.assignment?.locator) assignment.locator = input.assignment.locator;
    if (input.assignment?.contentHash) assignment.contentHash = input.assignment.contentHash;
    return assignment;
  }

  private assertPrepareShape(input: PrepareExecutionAttemptInput): void {
    this.requireToken(input.originatingPrimarySession, 'originatingPrimarySession');
    if (input.kind === 'task') {
      this.requireToken(input.featureName, 'featureName');
      this.requireToken(input.taskFolder, 'taskFolder');
    } else if (input.kind === 'adhoc') {
      this.requireToken(input.runId, 'runId');
    } else {
      throw new Error(`Unsupported execution attempt kind: ${String(input.kind)}`);
    }
  }

  private canonicalizeWorkspaceIdentities(identities: string[]): string[] {
    if (!identities.length) throw new Error('workspaceIdentities must not be empty');
    const canonical = [...new Set(identities.map(identity => this.canonicalizeWorkspaceIdentity(identity)))];
    if (!canonical.length) throw new Error('workspaceIdentities must not be empty');
    return canonical;
  }

  private canonicalizeWorkspaceIdentity(identity: string): string {
    if (!identity.trim()) throw new Error('Workspace identity must be a non-empty path');
    if (!path.isAbsolute(identity)) {
      throw new Error(`Workspace identity must be an absolute path: ${identity}`);
    }
    try {
      return fs.realpathSync(identity);
    } catch {
      return path.resolve(identity);
    }
  }

  private currentUnsettledTaskAttempt(
    store: ExecutionAttemptsJson,
    featureName: string,
    taskFolder: string,
  ): ExecutionAttempt | undefined {
    const id = store.currentTaskAttempts?.[taskPointerKey(featureName, taskFolder)];
    if (!id) return undefined;
    const attempt = store.attempts.find(candidate => candidate.id === id);
    if (!attempt || attempt.dispatchState === 'settled') return undefined;
    return attempt;
  }

  private unsettledAdhocAttempt(store: ExecutionAttemptsJson, runId: string): ExecutionAttempt | undefined {
    return store.attempts.find(attempt =>
      attempt.kind === 'adhoc'
      && attempt.runId === runId
      && attempt.dispatchState !== 'settled');
  }

  private setCurrentTaskAttempt(
    store: ExecutionAttemptsJson,
    featureName: string,
    taskFolder: string,
    attemptId: string,
  ): void {
    store.currentTaskAttempts = {
      ...(store.currentTaskAttempts ?? {}),
      [taskPointerKey(featureName, taskFolder)]: attemptId,
    };
  }

  private isCurrentTaskAttemptInStore(
    store: ExecutionAttemptsJson,
    featureName: string,
    taskFolder: string,
    attemptId: string,
  ): boolean {
    return store.currentTaskAttempts?.[taskPointerKey(featureName, taskFolder)] === attemptId;
  }

  private assertWorkspacesIdleInStore(store: ExecutionAttemptsJson, identities: string[]): void {
    for (const attempt of store.attempts) {
      if (attempt.dispatchState === 'settled') continue;
      if (!identitiesIntersect(attempt.workspaceIdentities, identities)) continue;
      const claimed = identities.find(identity => attempt.workspaceIdentities.includes(identity));
      throw new Error(`Workspace identity is claimed by attempt ${attempt.id}: ${claimed}`);
    }
  }

  private requireAttempt(store: ExecutionAttemptsJson, attemptId: string): ExecutionAttempt {
    const attempt = store.attempts.find(candidate => candidate.id === attemptId);
    if (!attempt) throw new Error(`Unknown execution attempt ${attemptId}`);
    return attempt;
  }

  private settleAttemptRecord(
    attempt: ExecutionAttempt,
    outcome: ExecutionObservedOutcome,
    extras: SettleExecutionAttemptInput = {},
  ): void {
    if (attempt.dispatchState === 'settled') {
      throw new Error(`Execution attempt ${attempt.id} is already settled`);
    }
    const now = new Date().toISOString();
    attempt.dispatchState = 'settled';
    attempt.observedOutcome = outcome;
    attempt.settledAt = now;
    attempt.updatedAt = now;
    if (outcome === 'completed' || outcome === 'failed' || outcome === 'blocked' || outcome === 'cancelled') {
      attempt.observation = 'observed';
    }
    if (extras.reportLocator) attempt.reportLocator = extras.reportLocator;
    if (extras.reportContentHash) attempt.reportContentHash = extras.reportContentHash;
  }

  private mergeMigratedLeases(store: ExecutionAttemptsJson, extracted: NativeTaskLease[]): void {
    if (extracted.length === 0) return;
    const history = store.nativeTaskLeaseHistory ?? [];
    const seen = new Set(history.map(leaseHistoryKey));
    for (const lease of extracted) {
      const key = leaseHistoryKey(lease);
      if (seen.has(key)) continue;
      history.push(structuredClone(lease));
      seen.add(key);
    }
    store.nativeTaskLeaseHistory = history;

    for (const lease of extracted) {
      if (!this.shouldCreateLiveClaim(lease)) continue;
      if (store.attempts.some(attempt =>
        attempt.originatingPrimarySession === lease.parentSessionId
        && attempt.nativeCallId === lease.callId)) {
        continue;
      }
      const now = new Date().toISOString();
      const identities = this.canonicalizeWorkspaceIdentities(lease.resourcePaths);
      const inferred = this.inferAttemptIdentity(identities);
      const attempt: ExecutionAttempt = {
        id: randomUUID(),
        kind: inferred.kind,
        originatingPrimarySession: lease.parentSessionId,
        workspaceIdentities: identities,
        dispatchState: 'dispatched',
        observation: 'unobserved',
        nativeCallId: lease.callId,
        createdAt: now,
        updatedAt: now,
      };
      if (inferred.kind === 'task') {
        attempt.featureName = inferred.featureName;
        attempt.taskFolder = inferred.taskFolder;
      } else {
        attempt.runId = inferred.runId;
      }
      if (lease.foragerLaunchId?.trim()) attempt.launchId = lease.foragerLaunchId.trim();
      if (lease.childSessionId && !isPlaceholderNativeChildId(lease.childSessionId)) {
        attempt.nativeChildSessionId = lease.childSessionId;
      }
      store.attempts.push(attempt);
      if (attempt.kind === 'task' && attempt.featureName && attempt.taskFolder
        && !store.currentTaskAttempts?.[taskPointerKey(attempt.featureName, attempt.taskFolder)]) {
        this.setCurrentTaskAttempt(store, attempt.featureName, attempt.taskFolder, attempt.id);
      }
    }
  }

  private shouldCreateLiveClaim(lease: NativeTaskLease): boolean {
    if (lease.terminal || isCapabilityLease(lease) || isPlaceholderNativeChildId(lease.childSessionId)) {
      return false;
    }
    if (!lease.resourcePaths.length) return false;
    return lease.resourcePaths.every(resource => this.isExactWorktreeResource(resource));
  }

  private isExactWorktreeResource(resourcePath: string): boolean {
    if (!path.isAbsolute(resourcePath)) return false;
    const resolved = this.canonicalizeWorkspaceIdentity(resourcePath);
    const projectRoot = this.canonicalizeExistingOrResolved(this.projectRoot);
    if (resolved === projectRoot) return false;
    const worktreesRoot = this.canonicalizeExistingOrResolved(
      path.join(this.projectRoot, '.hive', '.worktrees'),
    );
    const relative = path.relative(worktreesRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.length === 2) return true;
    return parts.length === 4 && parts[2] === 'repos';
  }

  private inferAttemptIdentity(identities: string[]): {
    kind: ExecutionAttempt['kind'];
    featureName?: string;
    taskFolder?: string;
    runId?: string;
  } {
    const worktreesRoot = this.canonicalizeExistingOrResolved(
      path.join(this.projectRoot, '.hive', '.worktrees'),
    );
    const relative = path.relative(worktreesRoot, identities[0]!);
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts[0] === 'adhoc' && parts[1]) {
      return { kind: 'adhoc', runId: parts[1] };
    }
    const directoryName = parts[1] ?? '';
    const separator = directoryName.lastIndexOf('--');
    const taskFolder = separator > 0 ? directoryName.slice(0, separator) : directoryName;
    return { kind: 'task', featureName: parts[0], taskFolder };
  }

  private canonicalizeExistingOrResolved(value: string): string {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  }

  private requireToken(value: string | undefined, field: string): string {
    if (!value || value.trim().length === 0 || value !== value.trim()) {
      throw new Error(`Invalid ${field}`);
    }
    return value;
  }
}
