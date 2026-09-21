import * as path from 'path';
import { acquireLockSync, getHivePath, readJson, writeJsonAtomic } from '../utils/paths.js';
import type {
  BackgroundJobRecord,
  BackgroundJobRuntimeState,
  BackgroundJobsJson,
  BackgroundJobScope,
} from '../types.js';
import { isBackgroundJobArchived } from '../types.js';

export interface RegisterBackgroundJobInput {
  taskId: string;
  sessionId: string;
  callId?: string;
  agentName: string;
  description?: string;
  runtimeId?: string;
  scope?: BackgroundJobScope;
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

export class BackgroundJobService {
  constructor(private readonly projectRoot: string) {}

  private getBoardPath(): string {
    return path.join(getHivePath(this.projectRoot), 'background-jobs.json');
  }

  private readBoard(): BackgroundJobsJson {
    return this.loadBoard(this.getBoardPath());
  }

  private loadBoard(boardPath: string): BackgroundJobsJson {
    const loaded = readJson<BackgroundJobsJson>(boardPath);
    return {
      schemaVersion: 1,
      jobs: loaded?.jobs ?? [],
      ...(loaded?.updatedAt ? { updatedAt: loaded.updatedAt } : {}),
    };
  }

  private writeBoard(board: BackgroundJobsJson): void {
    board.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.getBoardPath(), board);
  }

  private updateBoard<T>(mutator: (board: BackgroundJobsJson) => T): T {
    const boardPath = this.getBoardPath();
    const release = acquireLockSync(boardPath);

    try {
      const board = this.loadBoard(boardPath);
      const record = mutator(board);
      this.writeBoard(board);
      return record;
    } finally {
      release();
    }
  }

  private findRecord(board: BackgroundJobsJson, identifier: string): BackgroundJobRecord {
    const matches = board.jobs.filter(job => job.taskId === identifier || job.sessionId === identifier || job.alias === identifier);
    if (matches.length > 1) {
      throw new Error(`Ambiguous background job identifier '${identifier}'. Use one of these exact aliases: ${matches.map(job => job.alias).join(', ')}`);
    }
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
      const projectRoot = input.scope?.projectRoot ?? this.projectRoot;
      const callMatches = input.callId ? board.jobs.filter(job =>
        job.callId === input.callId
        && job.scope?.parentSessionId === input.scope?.parentSessionId
        && (job.scope?.projectRoot ?? this.projectRoot) === projectRoot) : [];
      if (callMatches.length > 1) throw new Error('launch_binding_error: ambiguous native call');
      const sameCall = callMatches[0];
      if (sameCall) {
        if (sameCall.taskId === input.taskId && sameCall.sessionId === input.sessionId) return sameCall;
        throw new Error('launch_binding_error: contradictory native identity for call');
      }
      const now = new Date().toISOString();
      const record: BackgroundJobRecord = {
        taskId: input.taskId,
        sessionId: input.sessionId,
        callId: input.callId,
        agentName: input.agentName,
        description: input.description,
        runtimeId: input.runtimeId,
        createdAt: now,
        updatedAt: now,
        runtimeState: 'running',
        alias: this.nextAlias(board, input.scope?.parentSessionId),
        scope: input.scope,
      };

      board.jobs.push(record);
      return record;
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
      if (Object.prototype.hasOwnProperty.call(patch, 'lastStatusError')) {
        if (patch.lastStatusError === undefined) {
          if (Object.prototype.hasOwnProperty.call(record, 'lastStatusError')) {
            delete record.lastStatusError;
            changed = true;
          }
        } else {
          changed = this.applyIfChanged(record, 'lastStatusError', patch.lastStatusError) || changed;
        }
      }

      this.updateTimestamp(record, changed);
      return record;
    });
  }

  markTerminal(identifier: string, runtimeState: 'completed' | 'error' | 'cancelled', patch: RuntimeStatePatch = {}): BackgroundJobRecord {
    return this.updateBoard((board) => {
      const record = this.findRecord(board, identifier);
      const wasTerminal = isTerminalRuntimeState(record.runtimeState);
      if (wasTerminal && record.runtimeState !== runtimeState) return record;
      let changed = false;

      changed = this.applyIfChanged(record, 'runtimeState', runtimeState) || changed;
      if (!isBackgroundJobArchived(record)) {
        changed = this.applyIfChanged(record, 'terminalUnreconciled', true) || changed;
      }
      if (!record.runtimeCompletedAt) {
        record.runtimeCompletedAt = new Date().toISOString();
        changed = true;
      }
      if (patch.statusUncertain !== undefined) {
        changed = this.applyIfChanged(record, 'statusUncertain', patch.statusUncertain) || changed;
      }
      if (patch.resultSummary !== undefined && record.resultSummary === undefined) {
        changed = this.applyIfChanged(record, 'resultSummary', patch.resultSummary) || changed;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'lastStatusError')) {
        if (patch.lastStatusError === undefined) {
          if (Object.prototype.hasOwnProperty.call(record, 'lastStatusError')) {
            delete record.lastStatusError;
            changed = true;
          }
        } else if (!wasTerminal || record.lastStatusError === undefined) {
          changed = this.applyIfChanged(record, 'lastStatusError', patch.lastStatusError) || changed;
        }
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

  resolve(identifier: string): BackgroundJobRecord | undefined {
    const board = this.readBoard();
    const matches = board.jobs.filter(job => job.taskId === identifier || job.sessionId === identifier || job.alias === identifier);
    if (matches.length > 1) {
      throw new Error(`Ambiguous background job identifier '${identifier}'. Use one of these exact aliases: ${matches.map(job => job.alias).join(', ')}`);
    }
    return matches[0];
  }

  formatForPrompt(filter: BackgroundJobScopeFilter = {}): string {
    const jobs = this.listScoped(filter);
    if (jobs.length === 0) {
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
    return lines.join('\n');
  }
}

function isTerminalRuntimeState(state: BackgroundJobRecord['runtimeState']): boolean {
  return state === 'completed' || state === 'error' || state === 'cancelled';
}

function isPromptNotificationCandidate(record: BackgroundJobRecord, taskIds: Set<string>, parentSessionId: string): boolean {
  return taskIds.has(record.taskId)
    && record.scope?.parentSessionId === parentSessionId
    && isTerminalRuntimeState(record.runtimeState)
    && record.terminalUnreconciled === true
    && (!record.promptNotifiedAt || record.promptNotifiedInSessionId !== parentSessionId);
}

function isPromptAcknowledgmentCandidate(record: BackgroundJobRecord, parentSessionId: string): boolean {
  return record.scope?.parentSessionId === parentSessionId
    && isTerminalRuntimeState(record.runtimeState)
    && record.terminalUnreconciled === true
    && record.promptNotifiedInSessionId === parentSessionId
    && !!record.promptNotifiedAt
    && !record.promptAcknowledgedAt;
}
