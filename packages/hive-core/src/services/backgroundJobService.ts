import * as path from 'path';
import { acquireLockSync, getHivePath, readJson, writeJsonAtomic } from '../utils/paths.js';
import type {
  BackgroundJobOwnership,
  BackgroundPendingLaunch,
  BackgroundJobRecord,
  BackgroundJobRuntimeState,
  BackgroundJobsJson,
  BackgroundJobScope,
} from '../types.js';
import { isBackgroundJobArchived } from '../types.js';

export interface RegisterBackgroundJobInput {
  taskId: string;
  sessionId: string;
  launchId?: string;
  callId?: string;
  agentName: string;
  customAgentBase?: string;
  description?: string;
  objective?: string;
  runtimeId?: string;
  scopeSource?: BackgroundJobRecord['scopeSource'];
  scope?: BackgroundJobScope;
  ownership?: BackgroundJobOwnership;
}

export interface RegisterBackgroundPendingLaunchInput {
  launchId: string;
  parentSessionId: string;
  expectedDescription?: string;
  expectedPrompt?: string;
  agentName: string;
  scope?: BackgroundJobScope;
  ownership?: BackgroundJobOwnership;
}

export interface ConsumeBackgroundPendingLaunchInput {
  launchId: string;
  parentSessionId: string;
}

export interface RuntimeStatePatch {
  statusUncertain?: boolean;
  resultSummary?: string;
  lastStatusError?: string;
}

export interface ReconcilePatch {
  reconciledBy?: string;
  reconciliationSummary?: string;
}

export type BackgroundJobScopeFilter = BackgroundJobScope;
export interface BackgroundJobListOptions {
  includeArchived?: boolean;
}

const CLAIMED_LAUNCH_ARCHIVE_LIMIT_PER_PARENT = 100;

export class BackgroundJobService {
  constructor(private readonly projectRoot: string) {}

  private getBoardPath(): string {
    return path.join(getHivePath(this.projectRoot), 'background-jobs.json');
  }

  private readBoard(): BackgroundJobsJson {
    return readJson<BackgroundJobsJson>(this.getBoardPath()) || { schemaVersion: 1, jobs: [] };
  }

  private writeBoard(board: BackgroundJobsJson): void {
    board.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.getBoardPath(), board);
  }

  private updateBoard<T>(mutator: (board: BackgroundJobsJson) => T): T {
    const boardPath = this.getBoardPath();
    const release = acquireLockSync(boardPath);

    try {
      const board = readJson<BackgroundJobsJson>(boardPath) || { schemaVersion: 1, jobs: [] };
      const record = mutator(board);
      this.writeBoard(board);
      return record;
    } finally {
      release();
    }
  }

  private findRecord(board: BackgroundJobsJson, identifier: string): BackgroundJobRecord {
    const matches = board.jobs.filter(job => job.taskId === identifier || job.sessionId === identifier || job.alias === identifier || job.launchId === identifier);
    if (matches.length > 1) throw new Error(`Ambiguous background job identifier: ${identifier}`);
    const record = matches[0];
    if (!record) {
      throw new Error(`Background job not found: ${identifier}`);
    }
    return record;
  }

  private nextAlias(board: BackgroundJobsJson, parentSessionId: string | undefined): string {
    const scopeKey = parentSessionId || 'global';
    let index = 1;
    let alias = `${scopeKey}:job-${index}`;
    const aliases = new Set(board.jobs.map(job => job.alias));

    while (aliases.has(alias)) {
      index += 1;
      alias = `${scopeKey}:job-${index}`;
    }

    return alias;
  }

  private findPendingLaunch(board: BackgroundJobsJson, launchId: string): BackgroundPendingLaunch | undefined {
    const matches = (board.pendingLaunches ?? []).filter(item => item.launchId === launchId);
    if (matches.length > 1) throw new Error('launch_binding_error: ambiguous launch identity');
    return matches[0];
  }

  private pruneClaimedLaunchArchives(board: BackgroundJobsJson, parentSessionId: string): void {
    const pendingLaunches = board.pendingLaunches ?? [];
    const archived = pendingLaunches
      .map((pending, index) => ({ pending, index }))
      .filter(({ pending }) => pending.parentSessionId === parentSessionId && pending.disposition === 'claimed' && pending.archivedAt)
      .sort((left, right) => {
        const byTime = Date.parse(right.pending.archivedAt!) - Date.parse(left.pending.archivedAt!);
        return Number.isFinite(byTime) && byTime !== 0 ? byTime : right.index - left.index;
      });
    if (archived.length <= CLAIMED_LAUNCH_ARCHIVE_LIMIT_PER_PARENT) return;

    const retained = new Set(archived.slice(0, CLAIMED_LAUNCH_ARCHIVE_LIMIT_PER_PARENT).map(({ pending }) => pending));
    const kept = pendingLaunches.filter(pending =>
      pending.parentSessionId !== parentSessionId
      || !pending.archivedAt
      || pending.disposition !== 'claimed'
      || retained.has(pending));
    board.pendingLaunches = kept.length ? kept : undefined;
  }

  private applyIfChanged<T extends keyof BackgroundJobRecord>(record: BackgroundJobRecord, key: T, value: BackgroundJobRecord[T]): boolean {
    if (record[key] === value) {
      return false;
    }
    record[key] = value;
    return true;
  }

  private updateTimestamp(record: BackgroundJobRecord, changed: boolean): void {
    if (changed) {
      record.updatedAt = new Date().toISOString();
    }
  }

  registerLaunch(input: RegisterBackgroundJobInput): BackgroundJobRecord {
    return this.updateBoard((board) => {
      const pending = input.launchId ? this.findPendingLaunch(board, input.launchId) : undefined;
      if (input.callId && board.pendingLaunches?.some(item => !item.archivedAt && item.parentSessionId === input.scope?.parentSessionId && item.callId === input.callId && item !== pending)) throw new Error('launch_binding_error: native registration conflicts with claimed call');
      if (input.launchId && (pending || input.callId || board.jobs.some(job => job.launchId === input.launchId)) && (!pending || pending.disposition !== 'claimed' || pending.parentSessionId !== input.scope?.parentSessionId || pending.callId !== input.callId)) {
        const existingMatches = board.jobs.filter(job => job.launchId === input.launchId);
        if (existingMatches.length > 1) throw new Error('launch_binding_error: ambiguous registered launch');
        const existing = existingMatches[0];
        if (existing && existing.taskId === input.taskId && existing.sessionId === input.sessionId && existing.callId === input.callId && existing.scope?.parentSessionId === input.scope?.parentSessionId) return existing;
        throw new Error('launch_binding_error: launch, parent and call must match the claimed launch');
      }
      const callMatches = input.callId ? board.jobs.filter(job => job.callId === input.callId && job.scope?.parentSessionId === input.scope?.parentSessionId) : [];
      if (callMatches.length > 1) throw new Error('launch_binding_error: ambiguous native call');
      const sameCall = callMatches[0];
      if (sameCall) {
        if (sameCall.taskId === input.taskId && sameCall.sessionId === input.sessionId && sameCall.launchId === input.launchId) return sameCall;
        throw new Error('launch_binding_error: contradictory native identity for call');
      }
      if (board.jobs.some(job => job.taskId === input.taskId)) {
        throw new Error(`Background job already registered for task ID: ${input.taskId}`);
      }
      if (board.jobs.some(job => job.sessionId === input.sessionId)) {
        throw new Error(`Background job already registered for session ID: ${input.sessionId}`);
      }

      const now = new Date().toISOString();
      const record: BackgroundJobRecord = {
        taskId: input.taskId,
        sessionId: input.sessionId,
        launchId: input.launchId,
        callId: input.callId,
        agentName: input.agentName,
        customAgentBase: input.customAgentBase,
        description: input.description,
        objective: input.objective,
        runtimeId: input.runtimeId,
        createdAt: now,
        updatedAt: now,
        runtimeState: 'running',
        scopeSource: input.scopeSource,
        alias: this.nextAlias(board, input.scope?.parentSessionId),
        scope: pending?.scope ?? input.scope,
        ownership: pending?.ownership ?? input.ownership,
        archivedAt: pending?.archivedAt,
        archiveReason: pending?.archiveReason,
        reconciliationSummary: pending?.reconciliationSummary,
      };

      board.jobs.push(record);
      if (pending) {
        const remaining = board.pendingLaunches!.filter(item => item !== pending);
        board.pendingLaunches = remaining.length ? remaining : undefined;
      }
      return record;
    });
  }

  registerPendingLaunch(input: RegisterBackgroundPendingLaunchInput): BackgroundPendingLaunch {
    return this.updateBoard((board) => {
      if (board.jobs.some(job => job.launchId === input.launchId)) throw new Error('launch_binding_error: launch already registered');
      if (input.scope?.parentSessionId && input.scope.parentSessionId !== input.parentSessionId) throw new Error('launch_binding_error: contradictory parent scope');
      const now = new Date().toISOString();
      const pending: BackgroundPendingLaunch = {
        launchId: input.launchId,
        parentSessionId: input.parentSessionId,
        expectedDescription: input.expectedDescription,
        expectedPrompt: input.expectedPrompt,
        agentName: input.agentName,
        scope: input.scope,
        ownership: input.ownership,
        createdAt: now,
        disposition: 'prepared',
      };

      const pendingLaunches = board.pendingLaunches ?? [];
      this.findPendingLaunch(board, input.launchId);
      const existingIndex = pendingLaunches.findIndex((candidate) =>
        candidate.launchId === input.launchId
      );

      if (existingIndex >= 0) {
        if (pendingLaunches[existingIndex].disposition === 'claimed' || pendingLaunches[existingIndex].parentSessionId !== input.parentSessionId) throw new Error('launch_binding_error: cannot replace claimed or foreign preparation');
        pendingLaunches[existingIndex] = pending;
      } else {
        pendingLaunches.push(pending);
      }

      board.pendingLaunches = pendingLaunches;
      return pending;
    });
  }

  consumePendingLaunch(input: ConsumeBackgroundPendingLaunchInput): BackgroundPendingLaunch | undefined {
    return this.updateBoard((board) => {
      const pendingLaunches = board.pendingLaunches ?? [];
      const index = findPendingLaunchIndex(pendingLaunches, input);

      if (index < 0) {
        return undefined;
      }

      const [pending] = pendingLaunches.splice(index, 1);
      if (pending.disposition === 'claimed') throw new Error('launch_binding_error: claimed launches cannot be consumed as preparation');
      board.pendingLaunches = pendingLaunches.length > 0 ? pendingLaunches : undefined;
      return pending;
    });
  }

  claimPendingLaunch(input: ConsumeBackgroundPendingLaunchInput & { callId: string; runtimeId?: string; background?: boolean }): BackgroundPendingLaunch {
    return this.updateBoard(board => {
      const pending = this.findPendingLaunch(board, input.launchId);
      const callMatches = board.pendingLaunches?.filter(item => !item.archivedAt && item.parentSessionId === input.parentSessionId && item.callId === input.callId) ?? [];
      if (!pending || pending.archivedAt || pending.parentSessionId !== input.parentSessionId || (pending.callId && pending.callId !== input.callId) || callMatches.some(item => item !== pending) || board.jobs.some(job => job.launchId === input.launchId || (job.scope?.parentSessionId === input.parentSessionId && job.callId === input.callId))) {
        throw new Error('launch_binding_error: missing or contradictory launch claim');
      }
      pending.disposition = 'claimed';
      pending.callId = input.callId;
      pending.claimedAt ??= new Date().toISOString();
      pending.runtimeId ??= input.runtimeId;
      pending.background ??= input.background;
      return pending;
    });
  }

  findClaimedLaunch(parentSessionId: string, callId: string): BackgroundPendingLaunch | undefined {
    const matches = (this.readBoard().pendingLaunches ?? []).filter(item => item.disposition === 'claimed' && item.parentSessionId === parentSessionId && item.callId === callId);
    const activeMatches = matches.filter(item => !item.archivedAt);
    const selectedMatches = activeMatches.length > 0 ? activeMatches : matches;
    if (selectedMatches.length > 1) throw new Error('launch_binding_error: ambiguous claimed call');
    return selectedMatches[0] ? { ...selectedMatches[0], archivedAt: selectedMatches[0].archivedAt } : undefined;
  }

  finishClaimedLaunch(launchId: string, parentSessionId: string, callId: string, registrationError?: string): void {
    this.updateBoard(board => {
      const pending = this.findPendingLaunch(board, launchId);
      if (!pending || pending.disposition !== 'claimed' || pending.parentSessionId !== parentSessionId || pending.callId !== callId) throw new Error('launch_binding_error: claimed launch mismatch');
      if (registrationError) pending.registrationError = registrationError;
      else {
        const remaining = board.pendingLaunches!.filter(item => item !== pending);
        board.pendingLaunches = remaining.length ? remaining : undefined;
      }
    });
  }

  archiveClaimedLaunch(launchId: string, parentSessionId: string, decision: 'ignored' | 'reconciled', summary: string): BackgroundPendingLaunch {
    if (!summary.trim()) throw new Error('A non-empty reconciliation reason is required');
    return this.updateBoard(board => {
      const pending = this.findPendingLaunch(board, launchId);
      if (!pending || pending.parentSessionId !== parentSessionId || pending.disposition !== 'claimed') throw new Error('launch_binding_error: claimed launch not found');
      pending.archivedAt ??= new Date().toISOString();
      pending.archiveReason = decision;
      pending.reconciliationSummary = summary;
      this.pruneClaimedLaunchArchives(board, parentSessionId);
      return pending;
    });
  }

  retireParentLaunches(parentSessionId: string): BackgroundPendingLaunch[] {
    if (!this.readBoard().pendingLaunches?.some(pending => pending.parentSessionId === parentSessionId)) return [];

    return this.updateBoard(board => {
      const now = new Date().toISOString();
      const archivedClaims: BackgroundPendingLaunch[] = [];
      const retained = (board.pendingLaunches ?? []).filter(pending => {
        if (pending.parentSessionId !== parentSessionId) return true;
        if (pending.disposition !== 'claimed') return false;

        pending.archivedAt ??= now;
        pending.archiveReason ??= 'ignored';
        pending.reconciliationSummary ??= 'Parent session deleted; claimed launch bookkeeping retired without changing native execution state.';
        archivedClaims.push(pending);
        return true;
      });
      board.pendingLaunches = retained.length ? retained : undefined;
      this.pruneClaimedLaunchArchives(board, parentSessionId);
      return archivedClaims;
    });
  }

  sweepExpiredPendingLaunches(ttlMs: number): BackgroundPendingLaunch[] {
    if (!this.readBoard().pendingLaunches?.length) {
      return [];
    }

    return this.updateBoard((board) => {
      const pendingLaunches = board.pendingLaunches ?? [];
      const cutoff = Date.now() - ttlMs;
      const expired = pendingLaunches.filter((pending) => {
        if (pending.disposition === 'claimed') return false;
        const createdAt = Date.parse(pending.createdAt);
        return !Number.isFinite(createdAt) || createdAt <= cutoff;
      });
      if (expired.length === 0) {
        return [];
      }
      const expiredIds = new Set(expired.map(pending => pending.launchId));
      const kept = pendingLaunches.filter(pending => !expiredIds.has(pending.launchId));
      board.pendingLaunches = kept.length > 0 ? kept : undefined;
      return expired;
    });
  }

  updateRuntimeState(identifier: string, runtimeState: BackgroundJobRuntimeState, patch: RuntimeStatePatch = {}): BackgroundJobRecord {
    return this.updateBoard((board) => {
      const record = this.findRecord(board, identifier);
      if (isTerminalRuntimeState(record.runtimeState)) return record;
      let changed = false;

      changed = this.applyIfChanged(record, 'runtimeState', runtimeState) || changed;
      if (patch.statusUncertain !== undefined) {
        changed = this.applyIfChanged(record, 'statusUncertain', patch.statusUncertain) || changed;
      }
      if (patch.resultSummary !== undefined) {
        changed = this.applyIfChanged(record, 'resultSummary', patch.resultSummary) || changed;
      }
      if (patch.lastStatusError !== undefined) {
        changed = this.applyIfChanged(record, 'lastStatusError', patch.lastStatusError) || changed;
      }

      this.updateTimestamp(record, changed);
      return record;
    });
  }

  markTerminal(identifier: string, runtimeState: 'completed' | 'error' | 'cancelled', patch: RuntimeStatePatch = {}): BackgroundJobRecord {
    return this.updateBoard((board) => {
      const record = this.findRecord(board, identifier);
      if (isTerminalRuntimeState(record.runtimeState) && record.runtimeState !== runtimeState) return record;
      let changed = false;

      changed = this.applyIfChanged(record, 'runtimeState', runtimeState) || changed;
      if (!isBackgroundJobArchived(record)) {
        changed = this.applyIfChanged(record, 'terminalUnreconciled', true) || changed;
      }
      if (!record.runtimeCompletedAt) {
        record.runtimeCompletedAt = new Date().toISOString();
        changed = true;
      }
      if (patch.statusUncertain !== undefined && record.statusUncertain === undefined) {
        changed = this.applyIfChanged(record, 'statusUncertain', patch.statusUncertain) || changed;
      }
      if (patch.resultSummary !== undefined && record.resultSummary === undefined) {
        changed = this.applyIfChanged(record, 'resultSummary', patch.resultSummary) || changed;
      }
      if (patch.lastStatusError !== undefined && record.lastStatusError === undefined) {
        changed = this.applyIfChanged(record, 'lastStatusError', patch.lastStatusError) || changed;
      }

      this.updateTimestamp(record, changed);
      return record;
    });
  }

  markReconciled(identifier: string, patch: ReconcilePatch = {}): BackgroundJobRecord {
    return this.updateBoard((board) => {
      const record = this.findRecord(board, identifier);
      let changed = false;

      changed = this.applyIfChanged(record, 'terminalUnreconciled', false) || changed;
      if (!record.reconciledAt) {
        record.reconciledAt = new Date().toISOString();
        changed = true;
      }
      if (patch.reconciledBy !== undefined) {
        changed = this.applyIfChanged(record, 'reconciledBy', patch.reconciledBy) || changed;
      }
      if (patch.reconciliationSummary !== undefined) {
        changed = this.applyIfChanged(record, 'reconciliationSummary', patch.reconciliationSummary) || changed;
      }
      if (!record.archivedAt) {
        record.archivedAt = new Date().toISOString();
        changed = true;
      }
      changed = this.applyIfChanged(record, 'archiveReason', 'reconciled') || changed;

      this.updateTimestamp(record, changed);
      return record;
    });
  }

  markIgnored(identifier: string, ignoreReason: string): BackgroundJobRecord {
    return this.updateBoard((board) => {
      const record = this.findRecord(board, identifier);

      if (record.archivedAt || record.ignoredAt || record.reconciledAt) {
        return record;
      }

      let changed = false;

      changed = this.applyIfChanged(record, 'terminalUnreconciled', false) || changed;
      if (!record.ignoredAt) {
        record.ignoredAt = new Date().toISOString();
        changed = true;
      }
      changed = this.applyIfChanged(record, 'ignoreReason', ignoreReason) || changed;
      if (!record.archivedAt) {
        record.archivedAt = new Date().toISOString();
        changed = true;
      }
      changed = this.applyIfChanged(record, 'archiveReason', 'ignored') || changed;

      this.updateTimestamp(record, changed);
      return record;
    });
  }

  markCancelRequested(identifier: string, cancelReason: string): BackgroundJobRecord {
    return this.updateBoard((board) => {
      const record = this.findRecord(board, identifier);
      let changed = false;

      if (!record.cancelRequestedAt) {
        record.cancelRequestedAt = new Date().toISOString();
        changed = true;
      }
      changed = this.applyIfChanged(record, 'cancelReason', cancelReason) || changed;

      this.updateTimestamp(record, changed);
      return record;
    });
  }

  markRuntimeCancelled(identifier: string, patch: RuntimeStatePatch = {}): BackgroundJobRecord {
    return this.markTerminal(identifier, 'cancelled', patch);
  }

  markStale(identifier: string): BackgroundJobRecord {
    return this.updateBoard((board) => {
      const record = this.findRecord(board, identifier);
      let changed = false;

      if (!record.staleAt) {
        record.staleAt = new Date().toISOString();
        changed = true;
      }

      this.updateTimestamp(record, changed);
      return record;
    });
  }

  markRuntimeEpochStale(identifier: string, currentRuntimeId: string, lastStatusError: string): BackgroundJobRecord | undefined {
    return this.updateBoard((board) => {
      const record = this.findRecord(board, identifier);
      const isActive = record.runtimeState === 'running' || record.runtimeState === 'unknown';
      const isForeignRuntime = record.runtimeId !== currentRuntimeId;

      if (!isActive || !isForeignRuntime || isBackgroundJobArchived(record) || record.staleAt) {
        return undefined;
      }

      let changed = false;
      record.staleAt = new Date().toISOString();
      changed = true;
      changed = this.applyIfChanged(record, 'statusUncertain', true) || changed;
      changed = this.applyIfChanged(record, 'lastStatusError', lastStatusError) || changed;
      this.updateTimestamp(record, changed);
      return record;
    });
  }

  markPromptNotified(taskIds: string[], parentSessionId: string): BackgroundJobRecord[] {
    const uniqueIds = new Set(taskIds);
    if (uniqueIds.size === 0) {
      return [];
    }
    if (!this.readBoard().jobs.some(record => isPromptNotificationCandidate(record, uniqueIds, parentSessionId))) {
      return [];
    }

    return this.updateBoard((board) => {
      const now = new Date().toISOString();
      const changedRecords: BackgroundJobRecord[] = [];

      for (const record of board.jobs) {
        if (!isPromptNotificationCandidate(record, uniqueIds, parentSessionId)) {
          continue;
        }

        record.promptNotifiedAt = record.promptNotifiedAt ?? now;
        record.promptNotifiedInSessionId = parentSessionId;
        record.promptBoardInjectionCount = (record.promptBoardInjectionCount ?? 0) + 1;
        this.updateTimestamp(record, true);
        changedRecords.push(record);
      }

      return changedRecords;
    });
  }

  markPromptAcknowledgedForSession(parentSessionId: string): BackgroundJobRecord[] {
    if (!this.readBoard().jobs.some(record => isPromptAcknowledgmentCandidate(record, parentSessionId))) {
      return [];
    }

    return this.updateBoard((board) => {
      const now = new Date().toISOString();
      const changedRecords: BackgroundJobRecord[] = [];

      for (const record of board.jobs) {
        if (!isPromptAcknowledgmentCandidate(record, parentSessionId)) {
          continue;
        }

        record.promptAcknowledgedAt = now;
        this.updateTimestamp(record, true);
        changedRecords.push(record);
      }

      return changedRecords;
    });
  }

  listScoped(filter: BackgroundJobScopeFilter = {}, options: BackgroundJobListOptions = {}): BackgroundJobRecord[] {
    return this.readBoard().jobs.filter((job) => {
      if (!options.includeArchived && isBackgroundJobArchived(job)) {
        return false;
      }
      const scope = job.scope || {};
      return Object.entries(filter).every(([key, value]) => {
        if (value === undefined) {
          return true;
        }
        return scope[key as keyof BackgroundJobScope] === value;
      });
    });
  }

  listPendingLaunches(filter: BackgroundJobScopeFilter = {}, options: BackgroundJobListOptions = {}): BackgroundPendingLaunch[] {
    return (this.readBoard().pendingLaunches ?? []).filter((pending) => {
      if (pending.archivedAt && !options.includeArchived) return false;
      const scope = pending.scope || {};
      return Object.entries(filter).every(([key, value]) => {
        if (value === undefined) {
          return true;
        }
        if (key === 'parentSessionId') {
          return pending.parentSessionId === value;
        }
        return scope[key as keyof BackgroundJobScope] === value;
      });
    });
  }

  resolve(identifier: string): BackgroundJobRecord | undefined {
    const board = this.readBoard();
    const matches = board.jobs.filter(job => job.taskId === identifier || job.sessionId === identifier || job.alias === identifier || job.launchId === identifier);
    if (matches.length > 1) throw new Error(`Ambiguous background job identifier: ${identifier}`);
    return matches[0];
  }

  recordRetry(identifier: string, input: RegisterBackgroundJobInput): BackgroundJobRecord {
    return this.updateBoard((board) => {
      const original = this.findRecord(board, identifier);
      if (board.jobs.some(job => job.taskId === input.taskId)) {
        throw new Error(`Background job already registered for task ID: ${input.taskId}`);
      }
      if (board.jobs.some(job => job.sessionId === input.sessionId)) {
        throw new Error(`Background job already registered for session ID: ${input.sessionId}`);
      }

      const now = new Date().toISOString();
      const retry: BackgroundJobRecord = {
        taskId: input.taskId,
        sessionId: input.sessionId,
        agentName: input.agentName,
        customAgentBase: input.customAgentBase,
        description: input.description,
        objective: input.objective,
        runtimeId: input.runtimeId,
        createdAt: now,
        updatedAt: now,
        runtimeState: 'running',
        scopeSource: 'retry',
        retryOf: original.taskId,
        alias: this.nextAlias(board, input.scope?.parentSessionId),
        scope: input.scope,
        ownership: input.ownership,
      };

      original.supersedes = retry.taskId;
      original.updatedAt = now;
      board.jobs.push(retry);
      return retry;
    });
  }

  formatForPrompt(filter: BackgroundJobScopeFilter = {}): string {
    const jobs = this.listScoped(filter);
    const claims = this.listPendingLaunches(filter).filter(item => item.disposition === 'claimed');
    if (jobs.length === 0 && claims.length === 0) {
      return 'No background jobs are currently visible for this scope.';
    }

    const lines = jobs.map((job) => {
      const scopeParts = [job.scope?.feature, job.scope?.task, job.scope?.adHocRunId, job.scope?.workflow].filter(Boolean).join('/');
      const details = [
        job.resultSummary,
        job.cancelReason ? `cancel requested: ${job.cancelReason}` : undefined,
        job.terminalUnreconciled ? 'terminal unreconciled' : undefined,
        job.staleAt ? 'stale' : undefined,
        job.ignoredAt ? `ignored: ${job.ignoreReason || 'no reason recorded'}` : undefined,
      ].filter(Boolean).join('; ');

      return `- ${job.alias} ${job.runtimeState} ${job.agentName} ${scopeParts || 'unscoped'}${details ? ` (${details})` : ''}`;
    });
    return [...lines, ...claims.map(item => `- launch ${item.launchId} parent ${item.parentSessionId} call ${item.callId}: native identity unavailable; execution may still be running. Scope: ${JSON.stringify(item.scope)}; ownership: ${JSON.stringify(item.ownership)}. Inspect native execution or archive bookkeeping by launchId with a reason. Archiving does not stop execution or authorize a replacement writer.`)].join('\n');
  }
}

function findPendingLaunchIndex(pendingLaunches: BackgroundPendingLaunch[], input: ConsumeBackgroundPendingLaunchInput): number {
  return pendingLaunches.findIndex(pending =>
    pending.parentSessionId === input.parentSessionId
    && pending.launchId === input.launchId
  );
}

function isTerminalRuntimeState(state: BackgroundJobRecord['runtimeState']): boolean {
  return state === 'completed' || state === 'error' || state === 'cancelled';
}

function isPromptNotificationCandidate(record: BackgroundJobRecord, taskIds: Set<string>, parentSessionId: string): boolean {
  return taskIds.has(record.taskId)
    && isTerminalRuntimeState(record.runtimeState)
    && record.terminalUnreconciled === true
    && (!record.promptNotifiedAt || record.promptNotifiedInSessionId !== parentSessionId);
}

function isPromptAcknowledgmentCandidate(record: BackgroundJobRecord, parentSessionId: string): boolean {
  return isTerminalRuntimeState(record.runtimeState)
    && record.terminalUnreconciled === true
    && record.promptNotifiedInSessionId === parentSessionId
    && !!record.promptNotifiedAt
    && !record.promptAcknowledgedAt;
}
