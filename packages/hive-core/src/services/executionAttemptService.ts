/** Durable execution ownership for managed Forager dispatches. */
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
  ExecutionAttemptsJson,
  ExecutionObservedOutcome,
  ExecutionPlacement,
  NativeTaskLease,
} from '../types.js';
import {
  ARMED_ATTEMPT_TTL_MS,
  EXECUTION_ATTEMPTS_SCHEMA_VERSION,
  PLACEHOLDER_NATIVE_CHILD_ID,
} from '../types.js';
import { SessionService } from './sessionService.js';
import { TaskService } from './taskService.js';

export interface ArmExecutionAttemptInput {
  kind: ExecutionAttempt['kind'];
  originatingPrimarySession: string;
  placement: ExecutionPlacement;
  featureName?: string;
  taskFolder?: string;
  runId?: string;
}

export interface ArmExecutionAttemptResult {
  attempt: ExecutionAttempt;
  existing: boolean;
}

export class ExecutionScopeConflictError extends Error {
  constructor(readonly attempt: ExecutionAttempt) {
    super(`Execution scope is already owned by another primary (${attempt.originatingPrimarySession})`);
    this.name = 'ExecutionScopeConflictError';
  }
}

export interface AttachExecutionAttemptInput {
  originatingPrimarySession: string;
  nativeCallId: string;
  selectedAgent: string;
  background: boolean;
  constraintSnapshot?: NonNullable<ExecutionAttempt['native']>['constraintSnapshot'];
}

export interface BindNativeChildInput {
  originatingPrimarySession: string;
  nativeCallId: string;
  nativeChildSessionId: string;
}

export interface ObserveBlockingStopInput {
  originatingPrimarySession: string;
  nativeCallId: string;
  outputDefined: boolean;
}

export interface ObserveBackgroundStopInput {
  originatingPrimarySession: string;
  nativeCallId: string;
  nativeTaskId: string;
  state: 'completed' | 'error' | 'cancelled';
}

export interface FinalizeExecutionAttemptInput {
  reportLocator?: string;
  reportContentHash?: string;
  outcome?: ExecutionObservedOutcome;
}

interface LegacyExecutionAttempt {
  id: string;
  kind: 'task' | 'adhoc';
  featureName?: string;
  taskFolder?: string;
  runId?: string;
  originatingPrimarySession: string;
  assignment?: { taskAttempt: number };
  workspaceIdentities?: string[];
  attemptSlot?: string;
  branch?: string;
  baseCommit?: string;
  dispatchState: 'prepared' | 'dispatched' | 'settled';
  nativeChildSessionId?: string;
  nativeCallId?: string;
  observedOutcome?: ExecutionObservedOutcome | 'expired';
  reportLocator?: string;
  reportContentHash?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
}

interface LegacyExecutionAttemptsJson {
  schemaVersion: 1;
  attempts: LegacyExecutionAttempt[];
  nativeTaskLeaseHistory?: NativeTaskLease[];
  currentTaskAttempts?: Record<string, string>;
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
  return lease.capabilityReason !== undefined || lease.agent === 'hive-helper' || lease.agent === 'general';
}

function identitiesIntersect(left: string[], right: string[]): boolean {
  const claimed = new Set(left);
  return right.some(identity => claimed.has(identity));
}

export class ExecutionAttemptService {
  private readonly taskService: TaskService;
  private readonly sessionService: SessionService;

  constructor(
    private readonly projectRoot: string,
    private readonly runtimeId = `execution-runtime-${randomUUID()}`,
  ) {
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
      this.closeForeignRuntimeArms(store);
    });
    this.sessionService.extractNativeTaskLeases();
  }

  arm(input: ArmExecutionAttemptInput): ArmExecutionAttemptResult {
    this.assertArmShape(input);
    const placement = this.canonicalizePlacement(input.placement);
    return this.withStore(store => {
      const parentArm = store.attempts.find(attempt =>
        attempt.originatingPrimarySession === input.originatingPrimarySession && attempt.phase === 'armed');
      if (parentArm) {
        if (this.sameScope(parentArm, input)) return { attempt: structuredClone(parentArm), existing: true };
        throw new Error(`Primary session '${input.originatingPrimarySession}' already has an armed execution`);
      }

      const existing = this.currentAttemptForScope(store, input);
      if (existing) {
        if (existing.originatingPrimarySession !== input.originatingPrimarySession) {
          throw new ExecutionScopeConflictError(structuredClone(existing));
        }
        return { attempt: structuredClone(existing), existing: true };
      }
      if (placement.kind === 'worktree') {
        this.assertWorkspacesIdleInStore(store, placement.workspaceIdentities);
      }
      const now = new Date().toISOString();
      const attempt: ExecutionAttempt = {
        id: randomUUID(),
        kind: input.kind,
        originatingPrimarySession: this.requireToken(input.originatingPrimarySession, 'originatingPrimarySession'),
        placement,
        phase: 'armed',
        armRuntimeId: this.runtimeId,
        expiresAt: new Date(Date.now() + ARMED_ATTEMPT_TTL_MS).toISOString(),
        createdAt: now,
        updatedAt: now,
      };
      if (input.kind === 'task') {
        const allocation = this.taskService.allocateWorkerAttempt(input.featureName!, input.taskFolder!);
        attempt.featureName = input.featureName;
        attempt.taskFolder = input.taskFolder;
        attempt.taskAttempt = allocation.attempt;
        this.setCurrentTaskAttempt(store, input.featureName!, input.taskFolder!, attempt.id);
      } else {
        attempt.runId = input.runId;
      }
      store.attempts.push(attempt);
      return { attempt: structuredClone(attempt), existing: false };
    });
  }

  attachNext(input: AttachExecutionAttemptInput): ExecutionAttempt {
    const parent = this.requireToken(input.originatingPrimarySession, 'originatingPrimarySession');
    const callId = this.requireToken(input.nativeCallId, 'nativeCallId');
    const selectedAgent = this.requireToken(input.selectedAgent, 'selectedAgent');
    return this.withStore(store => {
      const arms = store.attempts.filter(attempt => attempt.originatingPrimarySession === parent && attempt.phase === 'armed');
      if (arms.length !== 1) throw new Error(`Primary session '${parent}' has no armed execution`);
      const attempt = arms[0]!;
      if (store.attempts.some(candidate => candidate.native?.parentSessionId === parent && candidate.native.callId === callId)) {
        throw new Error(`Native call '${callId}' is already attached`);
      }
      this.assertCurrentTaskGeneration(store, attempt);
      const now = new Date().toISOString();
      attempt.phase = 'attached';
      attempt.native = {
        parentSessionId: parent,
        callId,
        selectedAgent,
        background: input.background,
        attachedAt: now,
        ...(input.constraintSnapshot ? { constraintSnapshot: structuredClone(input.constraintSnapshot) } : {}),
      };
      delete attempt.armRuntimeId;
      delete attempt.expiresAt;
      attempt.updatedAt = now;
      return structuredClone(attempt);
    });
  }

  bindNativeChild(input: BindNativeChildInput): ExecutionAttempt {
    if (isPlaceholderNativeChildId(input.nativeChildSessionId)
      || input.nativeChildSessionId !== input.nativeChildSessionId.trim()) {
      throw new Error('Placeholder native child id is not bindable');
    }
    const childId = this.requireToken(input.nativeChildSessionId, 'nativeChildSessionId');
    return this.withStore(store => {
      const attempt = this.requireAttachedCall(store, input.originatingPrimarySession, input.nativeCallId);
      const owner = store.attempts.find(candidate => candidate.native?.childSessionId === childId);
      if (owner && owner.id !== attempt.id) throw new Error('Contradictory native child session');
      if (attempt.native!.childSessionId && attempt.native!.childSessionId !== childId) {
        throw new Error('Contradictory native child session');
      }
      attempt.native!.childSessionId = childId;
      attempt.updatedAt = new Date().toISOString();
      return structuredClone(attempt);
    });
  }

  observeBlockingStop(input: ObserveBlockingStopInput): ExecutionAttempt | undefined {
    if (!input.outputDefined) return undefined;
    return this.withStore(store => {
      const attempt = this.requireAttachedCall(store, input.originatingPrimarySession, input.nativeCallId);
      if (attempt.native!.background) throw new Error('Background execution requires structured background terminal evidence');
      return this.stopAttempt(attempt, 'blocking_after', 'completed');
    });
  }

  observeBackgroundStop(input: ObserveBackgroundStopInput): ExecutionAttempt {
    return this.withStore(store => {
      const attempt = this.requireAttachedCall(store, input.originatingPrimarySession, input.nativeCallId);
      if (!attempt.native!.background || attempt.native!.childSessionId !== input.nativeTaskId) {
        throw new Error('Background terminal evidence does not match the exact attached execution');
      }
      return this.stopAttempt(attempt, 'background_terminal', input.state, input.nativeTaskId);
    });
  }

  closeArmNotStarted(attemptId: string): ExecutionAttempt {
    return this.withStore(store => {
      const attempt = this.requireAttempt(store, attemptId);
      if (attempt.phase !== 'armed') throw new Error(`Execution attempt ${attemptId} is not armed`);
      this.finalizeRecord(attempt, 'not_started');
      return structuredClone(attempt);
    });
  }

  finalize(
    attemptId: string,
    outcome: ExecutionObservedOutcome,
    extras: FinalizeExecutionAttemptInput = {},
  ): ExecutionAttempt {
    return this.withStore(store => {
      const attempt = this.requireAttempt(store, attemptId);
      if (attempt.phase === 'finalized') return structuredClone(attempt);
      if (attempt.phase !== 'stopped') throw new Error(`Execution attempt ${attempt.id} has not stopped`);
      this.finalizeRecord(attempt, outcome, extras);
      return structuredClone(attempt);
    });
  }

  isCurrentTaskAttempt(featureName: string, taskFolder: string, attemptId: string): boolean {
    return this.isCurrentTaskAttemptInStore(this.readStore(), featureName, taskFolder, attemptId);
  }

  assertWorkspacesIdle(workspaceIdentities: string[]): void {
    const identities = this.canonicalizeWorkspaceIdentities(workspaceIdentities);
    this.withStore(store => this.assertWorkspacesIdleInStore(store, identities));
  }

  getAttempt(attemptId: string): ExecutionAttempt | undefined {
    const attempt = this.readStore().attempts.find(candidate => candidate.id === attemptId);
    return attempt ? structuredClone(attempt) : undefined;
  }

  findByNativeCall(parentSessionId: string, callId: string): ExecutionAttempt | undefined {
    const attempt = this.readStore().attempts.find(candidate =>
      candidate.native?.parentSessionId === parentSessionId && candidate.native.callId === callId);
    return attempt ? structuredClone(attempt) : undefined;
  }

  armedForParent(parentSessionId: string): ExecutionAttempt | undefined {
    const attempt = this.readStore().attempts.find(candidate =>
      candidate.originatingPrimarySession === parentSessionId && candidate.phase === 'armed');
    return attempt ? structuredClone(attempt) : undefined;
  }

  listAttempts(): ExecutionAttempt[] {
    return structuredClone(this.readStore().attempts);
  }

  recordHandoff(attemptId: string, extras: FinalizeExecutionAttemptInput): ExecutionAttempt {
    return this.withStore(store => {
      const attempt = this.requireAttempt(store, attemptId);
    if (extras.reportLocator) attempt.reportLocator = extras.reportLocator;
    if (extras.reportContentHash) attempt.reportContentHash = extras.reportContentHash;
    if (extras.outcome) attempt.handoffOutcome = extras.outcome;
      attempt.updatedAt = new Date().toISOString();
      return structuredClone(attempt);
    });
  }

  private stopAttempt(
    attempt: ExecutionAttempt,
    kind: 'blocking_after' | 'background_terminal' | 'tool_error',
    state: 'completed' | 'error' | 'cancelled',
    nativeTaskId?: string,
  ): ExecutionAttempt {
    if (attempt.phase === 'stopped' || attempt.phase === 'finalized') return structuredClone(attempt);
    if (attempt.phase !== 'attached') throw new Error(`Execution attempt ${attempt.id} is not attached`);
    const now = new Date().toISOString();
    attempt.phase = 'stopped';
    attempt.stopEvidence = { kind, state, observedAt: now, ...(nativeTaskId ? { nativeTaskId } : {}) };
    attempt.stoppedAt = now;
    attempt.updatedAt = now;
    return structuredClone(attempt);
  }

  private finalizeRecord(
    attempt: ExecutionAttempt,
    outcome: ExecutionObservedOutcome,
    extras: FinalizeExecutionAttemptInput = {},
  ): void {
    const now = new Date().toISOString();
    attempt.phase = 'finalized';
    attempt.observedOutcome = outcome;
    attempt.finalizedAt = now;
    attempt.updatedAt = now;
    delete attempt.armRuntimeId;
    delete attempt.expiresAt;
      if (extras.reportLocator) attempt.reportLocator = extras.reportLocator;
      if (extras.reportContentHash) attempt.reportContentHash = extras.reportContentHash;
      if (extras.outcome) attempt.handoffOutcome = extras.outcome;
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
      this.expireArmsInStore(store);
      const result = mutator(store);
      if (existed || this.hasPersistableState(store)) writeJsonAtomic(filePath, store);
      return result;
    } finally {
      release();
    }
  }

  private readStore(): ExecutionAttemptsJson {
    const filePath = getExecutionAttemptsPath(this.projectRoot);
    if (!fileExists(filePath)) return { schemaVersion: EXECUTION_ATTEMPTS_SCHEMA_VERSION, attempts: [] };
    const release = acquireLockSync(filePath);
    try {
      const store = this.readStoreUnlocked();
      if (this.expireArmsInStore(store)) writeJsonAtomic(filePath, store);
      return store;
    } finally {
      release();
    }
  }

  private readStoreUnlocked(): ExecutionAttemptsJson {
    const loaded = readJson<ExecutionAttemptsJson | LegacyExecutionAttemptsJson>(getExecutionAttemptsPath(this.projectRoot));
    if (!loaded) return { schemaVersion: EXECUTION_ATTEMPTS_SCHEMA_VERSION, attempts: [] };
    if (loaded.schemaVersion === 1) return this.migrateLegacyStore(loaded);
    if (loaded.schemaVersion !== EXECUTION_ATTEMPTS_SCHEMA_VERSION) {
      throw new Error(`Unsupported execution-attempts schemaVersion ${String((loaded as { schemaVersion: unknown }).schemaVersion)}`);
    }
    loaded.attempts ??= [];
    return loaded;
  }

  private migrateLegacyStore(legacy: LegacyExecutionAttemptsJson): ExecutionAttemptsJson {
    const attempts = legacy.attempts.map(old => {
      const now = new Date().toISOString();
      const workspaceIdentities = this.canonicalizeWorkspaceIdentities(old.workspaceIdentities ?? []);
      const placement: ExecutionPlacement = {
        kind: 'worktree',
        workspaceIdentities,
        workspacePath: this.workspacePathForIdentities(workspaceIdentities),
        ...(old.attemptSlot ? { attemptSlot: old.attemptSlot } : {}),
        ...(old.branch ? { branch: old.branch } : {}),
        ...(old.baseCommit ? { baseCommit: old.baseCommit } : {}),
      };
      const phase = old.dispatchState === 'prepared'
        ? 'finalized'
        : old.dispatchState === 'dispatched' ? 'attached' : 'finalized';
      const attempt: ExecutionAttempt = {
        id: old.id,
        kind: old.kind,
        originatingPrimarySession: old.originatingPrimarySession,
        placement,
        phase,
        createdAt: old.createdAt,
        updatedAt: now,
      };
      if (old.featureName) attempt.featureName = old.featureName;
      if (old.taskFolder) attempt.taskFolder = old.taskFolder;
      if (old.runId) attempt.runId = old.runId;
      if (old.assignment?.taskAttempt) attempt.taskAttempt = old.assignment.taskAttempt;
      if (old.dispatchState === 'prepared') {
        attempt.observedOutcome = 'not_started';
        attempt.finalizedAt = now;
      } else if (old.dispatchState === 'dispatched') {
        attempt.native = {
          parentSessionId: old.originatingPrimarySession,
          callId: old.nativeCallId ?? `legacy-unobserved-${old.id}`,
          selectedAgent: 'forager-worker',
          background: false,
          attachedAt: old.updatedAt,
          ...(!isPlaceholderNativeChildId(old.nativeChildSessionId) && old.nativeChildSessionId
            ? { childSessionId: old.nativeChildSessionId }
            : {}),
        };
      } else {
        attempt.observedOutcome = old.observedOutcome === 'expired' ? 'not_started' : old.observedOutcome;
        attempt.finalizedAt = old.settledAt ?? now;
      }
      if (old.reportLocator) attempt.reportLocator = old.reportLocator;
      if (old.reportContentHash) attempt.reportContentHash = old.reportContentHash;
      if (old.supersededBy) attempt.supersededBy = old.supersededBy;
      return attempt;
    });
    return {
      schemaVersion: EXECUTION_ATTEMPTS_SCHEMA_VERSION,
      attempts,
      ...(legacy.nativeTaskLeaseHistory ? { nativeTaskLeaseHistory: legacy.nativeTaskLeaseHistory } : {}),
      ...(legacy.currentTaskAttempts ? { currentTaskAttempts: legacy.currentTaskAttempts } : {}),
    };
  }

  private expireArmsInStore(store: ExecutionAttemptsJson, nowMs = Date.now()): boolean {
    let changed = false;
    for (const attempt of store.attempts) {
      if (attempt.phase !== 'armed' || !attempt.expiresAt || Date.parse(attempt.expiresAt) > nowMs) continue;
      this.finalizeRecord(attempt, 'not_started');
      changed = true;
    }
    return changed;
  }

  private closeForeignRuntimeArms(store: ExecutionAttemptsJson): void {
    for (const attempt of store.attempts) {
      if (attempt.phase === 'armed' && attempt.armRuntimeId !== this.runtimeId) {
        this.finalizeRecord(attempt, 'not_started');
      }
    }
  }

  private assertArmShape(input: ArmExecutionAttemptInput): void {
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

  private canonicalizePlacement(placement: ExecutionPlacement): ExecutionPlacement {
    if (placement.kind === 'in_place') {
      const directory = this.canonicalizeExistingDirectory(placement.directory);
      return { kind: 'in_place', directory };
    }
    const workspaceIdentities = this.canonicalizeWorkspaceIdentities(placement.workspaceIdentities);
    const workspacePath = this.canonicalizeExistingDirectory(placement.workspacePath);
    return {
      kind: 'worktree',
      workspaceIdentities,
      workspacePath,
      ...(placement.attemptSlot ? { attemptSlot: this.requireToken(placement.attemptSlot, 'attemptSlot') } : {}),
      ...(placement.branch ? { branch: placement.branch } : {}),
      ...(placement.baseCommit ? { baseCommit: placement.baseCommit } : {}),
    };
  }

  private canonicalizeWorkspaceIdentities(identities: string[]): string[] {
    if (!identities.length) throw new Error('workspaceIdentities must not be empty');
    return [...new Set(identities.map(identity => this.canonicalizeWorkspaceIdentity(identity)))];
  }

  private canonicalizeWorkspaceIdentity(identity: string): string {
    if (!identity.trim() || !path.isAbsolute(identity)) {
      throw new Error(`Workspace identity must be an absolute non-empty path: ${identity}`);
    }
    try {
      return fs.realpathSync(identity);
    } catch {
      return path.resolve(identity);
    }
  }

  private canonicalizeExistingDirectory(directory: string): string {
    if (!directory.trim() || !path.isAbsolute(directory)) {
      throw new Error(`Placement directory must be an absolute non-empty path: ${directory}`);
    }
    const canonical = fs.realpathSync(directory);
    if (!fs.statSync(canonical).isDirectory()) throw new Error(`Placement is not a directory: ${directory}`);
    return canonical;
  }

  private currentAttemptForScope(
    store: ExecutionAttemptsJson,
    input: ArmExecutionAttemptInput,
  ): ExecutionAttempt | undefined {
    if (input.kind === 'task') {
      const id = store.currentTaskAttempts?.[taskPointerKey(input.featureName!, input.taskFolder!)];
      const attempt = id ? store.attempts.find(candidate => candidate.id === id) : undefined;
      return attempt?.phase === 'finalized' ? undefined : attempt;
    }
    return store.attempts.find(attempt =>
      attempt.kind === 'adhoc' && attempt.runId === input.runId && attempt.phase !== 'finalized');
  }

  private sameScope(attempt: ExecutionAttempt, input: ArmExecutionAttemptInput): boolean {
    return attempt.kind === input.kind
      && (attempt.kind === 'task'
        ? attempt.featureName === input.featureName && attempt.taskFolder === input.taskFolder
        : attempt.runId === input.runId);
  }

  private assertCurrentTaskGeneration(store: ExecutionAttemptsJson, attempt: ExecutionAttempt): void {
    if (attempt.kind !== 'task') return;
    if (!this.isCurrentTaskAttemptInStore(store, attempt.featureName!, attempt.taskFolder!, attempt.id)) {
      throw new Error(`Armed task attempt ${attempt.id} was superseded`);
    }
    const status = this.taskService.getRawStatus(attempt.featureName!, attempt.taskFolder!);
    if (!status || status.workerAttempt !== attempt.taskAttempt) {
      throw new Error(`Armed task attempt ${attempt.id} was superseded by a newer task generation`);
    }
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
      if (attempt.phase === 'finalized' || attempt.placement.kind !== 'worktree') continue;
      if (!identitiesIntersect(attempt.placement.workspaceIdentities, identities)) continue;
      const claimed = identities.find(identity => attempt.placement.kind === 'worktree'
        && attempt.placement.workspaceIdentities.includes(identity));
      throw new Error(`Workspace identity is claimed by attempt ${attempt.id}: ${claimed}`);
    }
  }

  private requireAttachedCall(
    store: ExecutionAttemptsJson,
    parentSessionId: string,
    callId: string,
  ): ExecutionAttempt {
    const parent = this.requireToken(parentSessionId, 'originatingPrimarySession');
    const call = this.requireToken(callId, 'nativeCallId');
    const attempt = store.attempts.find(candidate =>
      candidate.native?.parentSessionId === parent && candidate.native.callId === call);
    if (!attempt || (attempt.phase !== 'attached' && attempt.phase !== 'stopped' && attempt.phase !== 'finalized')) {
      throw new Error('No exact attached execution matches the authenticated parent and call');
    }
    return attempt;
  }

  private requireAttempt(store: ExecutionAttemptsJson, attemptId: string): ExecutionAttempt {
    const attempt = store.attempts.find(candidate => candidate.id === attemptId);
    if (!attempt) throw new Error(`Unknown execution attempt ${attemptId}`);
    return attempt;
  }

  private mergeMigratedLeases(store: ExecutionAttemptsJson, extracted: NativeTaskLease[]): void {
    if (extracted.length === 0) return;
    const history = store.nativeTaskLeaseHistory ?? [];
    const seen = new Set(history.map(leaseHistoryKey));
    for (const lease of extracted) {
      const key = leaseHistoryKey(lease);
      if (!seen.has(key)) {
        history.push(structuredClone(lease));
        seen.add(key);
      }
    }
    store.nativeTaskLeaseHistory = history;

    for (const lease of extracted) {
      const matching = store.attempts.find(attempt => attempt.native?.parentSessionId === lease.parentSessionId
        && attempt.native.callId === lease.callId);
      if (matching) {
        if (matching.phase === 'attached' && matching.native) {
          matching.native.selectedAgent = lease.agent;
          if (lease.childSessionId && !isPlaceholderNativeChildId(lease.childSessionId)) {
            matching.native.childSessionId ??= lease.childSessionId;
          }
          if (matching.placement.kind === 'worktree') {
            matching.placement.workspacePath = this.workspacePathForIdentities(matching.placement.workspaceIdentities);
          }
          matching.updatedAt = new Date().toISOString();
        }
        continue;
      }
      if (!this.shouldCreateLiveClaim(lease)) continue;
      const now = new Date().toISOString();
      const identities = this.canonicalizeWorkspaceIdentities(lease.resourcePaths);
      const inferred = this.inferAttemptIdentity(identities);
      const attempt: ExecutionAttempt = {
        id: randomUUID(),
        kind: inferred.kind,
        originatingPrimarySession: lease.parentSessionId,
        placement: { kind: 'worktree', workspaceIdentities: identities, workspacePath: this.workspacePathForIdentities(identities) },
        phase: 'attached',
        native: {
          parentSessionId: lease.parentSessionId,
          callId: lease.callId,
          selectedAgent: lease.agent,
          background: false,
          attachedAt: now,
          ...(lease.childSessionId && !isPlaceholderNativeChildId(lease.childSessionId)
            ? { childSessionId: lease.childSessionId }
            : {}),
        },
        createdAt: now,
        updatedAt: now,
      };
      if (inferred.kind === 'task') {
        attempt.featureName = inferred.featureName;
        attempt.taskFolder = inferred.taskFolder;
      } else {
        attempt.runId = inferred.runId;
      }
      store.attempts.push(attempt);
      if (attempt.kind === 'task' && attempt.featureName && attempt.taskFolder
        && !store.currentTaskAttempts?.[taskPointerKey(attempt.featureName, attempt.taskFolder)]) {
        this.setCurrentTaskAttempt(store, attempt.featureName, attempt.taskFolder, attempt.id);
      }
    }
  }

  private shouldCreateLiveClaim(lease: NativeTaskLease): boolean {
    if (lease.terminal || isCapabilityLease(lease) || isPlaceholderNativeChildId(lease.childSessionId)) return false;
    return lease.resourcePaths.length > 0 && lease.resourcePaths.every(resource => this.isExactWorktreeResource(resource));
  }

  private isExactWorktreeResource(resourcePath: string): boolean {
    if (!path.isAbsolute(resourcePath)) return false;
    const resolved = this.canonicalizeWorkspaceIdentity(resourcePath);
    const projectRoot = this.canonicalizeExistingOrResolved(this.projectRoot);
    if (resolved === projectRoot) return false;
    const worktreesRoot = this.canonicalizeExistingOrResolved(path.join(this.projectRoot, '.hive', '.worktrees'));
    const relative = path.relative(worktreesRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const parts = relative.split(path.sep).filter(Boolean);
    return parts.length === 2 || (parts.length === 4 && parts[2] === 'repos');
  }

  private inferAttemptIdentity(identities: string[]): {
    kind: ExecutionAttempt['kind'];
    featureName?: string;
    taskFolder?: string;
    runId?: string;
  } {
    const worktreesRoot = this.canonicalizeExistingOrResolved(path.join(this.projectRoot, '.hive', '.worktrees'));
    const parts = path.relative(worktreesRoot, identities[0]!).split(path.sep).filter(Boolean);
    if (parts[0] === 'adhoc' && parts[1]) return { kind: 'adhoc', runId: parts[1] };
    const directoryName = parts[1] ?? '';
    const separator = directoryName.lastIndexOf('--');
    return {
      kind: 'task',
      featureName: parts[0],
      taskFolder: separator > 0 ? directoryName.slice(0, separator) : directoryName,
    };
  }

  private workspacePathForIdentities(identities: string[]): string {
    const first = identities[0]!;
    const parent = path.dirname(first);
    return path.basename(parent) === 'repos' ? path.dirname(parent) : first;
  }

  private canonicalizeExistingOrResolved(value: string): string {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  }

  private requireToken(value: string | undefined, field: string): string {
    if (!value || value.trim().length === 0 || value !== value.trim()) throw new Error(`Invalid ${field}`);
    return value;
  }
}
