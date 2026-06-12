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

export interface RegisterBackgroundJobInput {
  taskId: string;
  sessionId: string;
  agentName: string;
  customAgentBase?: string;
  description?: string;
  objective?: string;
  scope?: BackgroundJobScope;
  ownership?: BackgroundJobOwnership;
}

export interface RegisterBackgroundPendingLaunchInput {
  parentSessionId: string;
  expectedDescription?: string;
  expectedPrompt?: string;
  agentName: string;
  scope?: BackgroundJobScope;
  ownership?: BackgroundJobOwnership;
}

export interface ConsumeBackgroundPendingLaunchInput {
  parentSessionId: string;
  expectedDescription?: string;
  expectedPrompt?: string;
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
    const record = board.jobs.find(job => job.taskId === identifier || job.sessionId === identifier || job.alias === identifier);
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
        agentName: input.agentName,
        customAgentBase: input.customAgentBase,
        description: input.description,
        objective: input.objective,
        createdAt: now,
        updatedAt: now,
        runtimeState: 'running',
        alias: this.nextAlias(board, input.scope?.parentSessionId),
        scope: input.scope,
        ownership: input.ownership,
      };

      board.jobs.push(record);
      return record;
    });
  }

  registerPendingLaunch(input: RegisterBackgroundPendingLaunchInput): BackgroundPendingLaunch {
    return this.updateBoard((board) => {
      const now = new Date().toISOString();
      const pending: BackgroundPendingLaunch = {
        parentSessionId: input.parentSessionId,
        expectedDescription: input.expectedDescription,
        expectedPrompt: input.expectedPrompt,
        agentName: input.agentName,
        scope: input.scope,
        ownership: input.ownership,
        createdAt: now,
      };

      const pendingLaunches = board.pendingLaunches ?? [];
      const existingIndex = pendingLaunches.findIndex((candidate) =>
        candidate.parentSessionId === input.parentSessionId
        && candidate.expectedDescription === input.expectedDescription
        && candidate.expectedPrompt === input.expectedPrompt
      );

      if (existingIndex >= 0) {
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
      const index = pendingLaunches.findIndex((candidate) =>
        candidate.parentSessionId === input.parentSessionId
        && (candidate.expectedDescription === undefined || candidate.expectedDescription === input.expectedDescription)
        && (candidate.expectedPrompt === undefined || candidate.expectedPrompt === input.expectedPrompt)
      );

      if (index < 0) {
        return undefined;
      }

      const [pending] = pendingLaunches.splice(index, 1);
      board.pendingLaunches = pendingLaunches.length > 0 ? pendingLaunches : undefined;
      return pending;
    });
  }

  updateRuntimeState(identifier: string, runtimeState: BackgroundJobRuntimeState, patch: RuntimeStatePatch = {}): BackgroundJobRecord {
    return this.updateBoard((board) => {
      const record = this.findRecord(board, identifier);
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
      let changed = false;

      changed = this.applyIfChanged(record, 'runtimeState', runtimeState) || changed;
      if (!record.reconciledAt && !record.ignoredAt) {
        changed = this.applyIfChanged(record, 'terminalUnreconciled', true) || changed;
      }
      if (!record.runtimeCompletedAt) {
        record.runtimeCompletedAt = new Date().toISOString();
        changed = true;
      }
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

      this.updateTimestamp(record, changed);
      return record;
    });
  }

  markIgnored(identifier: string, ignoreReason: string): BackgroundJobRecord {
    return this.updateBoard((board) => {
      const record = this.findRecord(board, identifier);
      let changed = false;

      changed = this.applyIfChanged(record, 'terminalUnreconciled', false) || changed;
      if (!record.ignoredAt) {
        record.ignoredAt = new Date().toISOString();
        changed = true;
      }
      changed = this.applyIfChanged(record, 'ignoreReason', ignoreReason) || changed;

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

  listScoped(filter: BackgroundJobScopeFilter = {}): BackgroundJobRecord[] {
    return this.readBoard().jobs.filter((job) => {
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
    return board.jobs.find(job => job.taskId === identifier || job.sessionId === identifier || job.alias === identifier);
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
        createdAt: now,
        updatedAt: now,
        runtimeState: 'running',
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
    if (jobs.length === 0) {
      return 'No background jobs are currently visible for this scope.';
    }

    return jobs.map((job) => {
      const scopeParts = [job.scope?.feature, job.scope?.task, job.scope?.adHocRunId, job.scope?.workflow].filter(Boolean).join('/');
      const details = [
        job.resultSummary,
        job.cancelReason ? `cancel requested: ${job.cancelReason}` : undefined,
        job.terminalUnreconciled ? 'terminal unreconciled' : undefined,
        job.staleAt ? 'stale' : undefined,
        job.ignoredAt ? `ignored: ${job.ignoreReason || 'no reason recorded'}` : undefined,
      ].filter(Boolean).join('; ');

      return `- ${job.alias} ${job.runtimeState} ${job.agentName} ${scopeParts || 'unscoped'}${details ? ` (${details})` : ''}`;
    }).join('\n');
  }
}
