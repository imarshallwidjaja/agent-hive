import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import simpleGit from 'simple-git';
import type {
  ExecutionAttempt,
  ExecutionFinalizationReceipt,
  ExecutionFinalizationStatus,
  TaskStatusType,
} from '../types.js';
import { normalizeCommitMessage } from '../utils/mergeMessage.js';
import { getTaskPath, writeAtomic } from '../utils/paths.js';
import { ExecutionAttemptService } from './executionAttemptService.js';
import { TaskService } from './taskService.js';

export type ExecutionFinalizationCheckpoint =
  | 'before_intent'
  | 'after_intent'
  | `after_repository_preparation:${string}`
  | `after_repository_commit:${string}`
  | `after_repository_receipt:${string}`
  | 'after_report_write'
  | 'after_report_receipt'
  | 'after_task_status'
  | 'after_disposition'
  | 'before_release';

export interface ExecutionFinishInput {
  attemptId: string;
  originatingPrimarySession: string;
  status: ExecutionFinalizationStatus;
  summary: string;
  blocker?: unknown;
  message?: string;
}

export interface ExecutionFinishResult {
  attempt: ExecutionAttempt;
  reportPath: string;
  currentTaskUnchanged: boolean;
}

export interface ExecutionFinalizationServiceOptions {
  checkpoint?: (checkpoint: ExecutionFinalizationCheckpoint) => void;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class ExecutionFinalizationService {
  constructor(
    private readonly projectRoot: string,
    private readonly options: ExecutionFinalizationServiceOptions,
    private readonly attempts: ExecutionAttemptService,
    private readonly tasks = new TaskService(projectRoot),
  ) {}

  async finish(input: ExecutionFinishInput): Promise<ExecutionFinishResult> {
    const attempt = this.requireAuthorizedStoppedAttempt(input);
    const summary = input.summary.trim();
    if (!summary) throw new Error('Finalization summary must not be blank');
    if (input.status === 'blocked' && input.message?.trim()) {
      throw new Error('Blocked finalization skips Git and does not accept a commit message');
    }
    if (attempt.placement.kind === 'in_place' && input.message?.trim()) {
      throw new Error('In-place finalization skips Git and does not accept a commit message');
    }

    const repositories = attempt.placement.kind === 'worktree' && input.status !== 'blocked'
      ? attempt.placement.workspaceIdentities.map((repositoryPath, index) => ({
          id: attempt.placement.kind === 'worktree' && attempt.placement.workspaceIdentities.length === 1
            ? 'root'
            : path.basename(repositoryPath) || `repo-${index + 1}`,
          path: repositoryPath,
        }))
      : [];
    const message = await this.validateCommitIntent(repositories.map(repository => repository.path), input.message);
    const reportInput = {
      attemptId: attempt.id,
      kind: attempt.kind,
      featureName: attempt.featureName,
      taskFolder: attempt.taskFolder,
      runId: attempt.runId,
      status: input.status,
      summary,
      blocker: input.blocker ?? null,
      stoppedAt: attempt.stoppedAt,
    };
    const reportInputHash = hash(stableJson(reportInput));
    const operationId = hash(`execution-finalization\0${attempt.id}`);
    const intent = {
      operationId,
      expectedTaskAttempt: attempt.taskAttempt,
      reportInputHash,
      status: input.status,
      summary,
      blocker: input.blocker,
      message,
      repositories,
    };
    const receipt: ExecutionFinalizationReceipt = {
      ...intent,
      intentHash: hash(stableJson(intent)),
    };

    if (attempt.phase === 'finalized') {
      if (attempt.finalization?.intentHash !== receipt.intentHash || !attempt.finalization.report) {
        throw new Error(`Execution attempt ${attempt.id} is finalized with a different receipt`);
      }
      return {
        attempt,
        reportPath: path.join(this.projectRoot, attempt.finalization.report.locator),
        currentTaskUnchanged: attempt.finalization.disposition?.currentTaskUnchanged === true,
      };
    }

    this.checkpoint('before_intent');
    let current = this.attempts.beginFinalization(attempt.id, receipt);
    this.checkpoint('after_intent');

    for (const repository of current.finalization!.repositories) {
      await this.finishRepository(current.id, repository.id, repository.path, current.finalization!.message);
    }

    current = this.attempts.getAttempt(attempt.id)!;
    const reportBody = this.renderReport(current);
    const reportHash = hash(reportBody);
    const reportPath = this.reportPath(current, operationId);
    this.writeImmutable(reportPath, reportBody, reportHash);
    this.checkpoint('after_report_write');
    current = this.attempts.recordFinalizationReport(current.id, path.relative(this.projectRoot, reportPath), reportHash);
    this.checkpoint('after_report_receipt');
    const currentTaskGeneration = current.kind !== 'task' || (
      this.attempts.isCurrentTaskAttempt(current.featureName!, current.taskFolder!, current.id)
      && this.tasks.getRawStatus(current.featureName!, current.taskFolder!)?.workerAttempt === current.taskAttempt
    );
    if (currentTaskGeneration) this.writeLatestTaskReport(current, reportBody);

    let currentTaskUnchanged = false;
    if (!current.finalization!.disposition) {
      if (current.kind === 'task') {
        const taskStatus = this.taskStatus(input.status);
        const result = this.tasks.finalizeWorkerAttempt(
          current.featureName!,
          current.taskFolder!,
          current.taskAttempt!,
          {
            status: taskStatus,
            summary,
            ...(input.status === 'blocked' ? { blocker: input.blocker as any } : {}),
          },
        );
        currentTaskUnchanged = !result.applied;
      }
      this.checkpoint('after_task_status');
      current = this.attempts.recordFinalizationDisposition(current.id, {
        applied: !currentTaskUnchanged,
        ...(currentTaskUnchanged ? { currentTaskUnchanged: true } : {}),
      });
    } else {
      currentTaskUnchanged = current.finalization.disposition.currentTaskUnchanged === true;
    }
    this.checkpoint('after_disposition');
    this.checkpoint('before_release');
    current = this.attempts.finalize(current.id, input.status);
    return { attempt: current, reportPath, currentTaskUnchanged };
  }

  private requireAuthorizedStoppedAttempt(input: ExecutionFinishInput): ExecutionAttempt {
    const attempt = this.attempts.getAttempt(input.attemptId);
    if (!attempt) throw new Error(`Unknown execution attempt ${input.attemptId}`);
    if (attempt.originatingPrimarySession !== input.originatingPrimarySession) {
      throw new Error('Only the originating primary may finalize this execution');
    }
    if (attempt.phase === 'finalized') {
      if (!attempt.finalization) throw new Error('Finalized execution has no finalization receipt');
      return attempt;
    }
    if (attempt.phase !== 'stopped' || !attempt.stopEvidence) {
      throw new Error(`Execution attempt ${attempt.id} has no exact stopped evidence`);
    }
    return attempt;
  }

  private async validateCommitIntent(repositoryPaths: string[], rawMessage: string | undefined): Promise<string | undefined> {
    if (repositoryPaths.length === 0) return undefined;
    const dirty = (await Promise.all(repositoryPaths.map(async repositoryPath => {
      const status = await simpleGit(repositoryPath).status();
      return !status.isClean();
    }))).some(Boolean);
    if (!dirty && !rawMessage?.trim()) return undefined;
    return normalizeCommitMessage(rawMessage);
  }

  private async finishRepository(
    attemptId: string,
    repositoryId: string,
    repositoryPath: string,
    message: string | undefined,
  ): Promise<void> {
    let attempt = this.attempts.getAttempt(attemptId)!;
    let repository = attempt.finalization!.repositories.find(candidate => candidate.id === repositoryId)!;
    if (repository.result) return;
    const git = simpleGit(repositoryPath);
    if (!repository.baselineHead) {
      await git.add('-A');
      const baselineHead = (await git.revparse(['HEAD'])).trim();
      const expectedTree = (await git.raw(['write-tree'])).trim();
      attempt = this.attempts.recordRepositoryPreparation(attemptId, repositoryId, baselineHead, expectedTree);
      repository = attempt.finalization!.repositories.find(candidate => candidate.id === repositoryId)!;
      this.checkpoint(`after_repository_preparation:${repositoryId}`);
    }

    const baselineTree = (await git.revparse([`${repository.baselineHead}^{tree}`])).trim();
    if (baselineTree === repository.expectedTree) {
      this.attempts.recordRepositoryResult(attemptId, repositoryId, 'no_changes', repository.baselineHead!);
      this.checkpoint(`after_repository_receipt:${repositoryId}`);
      return;
    }
    if (!message) throw new Error(`Repository ${repositoryId} has changes but finalization has no commit message`);

    const head = (await git.revparse(['HEAD'])).trim();
    let commitSha = head;
    if (head === repository.baselineHead) {
      await git.commit(message);
      commitSha = (await git.revparse(['HEAD'])).trim();
      this.checkpoint(`after_repository_commit:${repositoryId}`);
    } else {
      const [parent, tree, actualMessage] = await Promise.all([
        git.revparse([`${head}^`]).then(value => value.trim()),
        git.revparse([`${head}^{tree}`]).then(value => value.trim()),
        git.raw(['show', '-s', '--format=%B', head]).then(value => value.trim()),
      ]);
      if (parent !== repository.baselineHead || tree !== repository.expectedTree || actualMessage !== message) {
        throw new Error(`Repository ${repositoryId} HEAD moved ambiguously after finalization intent; explicit recovery is required`);
      }
    }
    this.attempts.recordRepositoryResult(attemptId, repositoryId, 'committed', commitSha);
    this.checkpoint(`after_repository_receipt:${repositoryId}`);
  }

  private renderReport(attempt: ExecutionAttempt): string {
    const finalization = attempt.finalization!;
    const commits = finalization.repositories.length === 0
      ? '- Git operation skipped for this disposition and placement.'
      : finalization.repositories.map(repository =>
          `- ${repository.id}: ${repository.result === 'no_changes' ? 'NO_TRACKED_CHANGES' : repository.commitSha}`,
        ).join('\n');
    return [
      `# Execution Report: ${attempt.kind === 'task' ? attempt.taskFolder : attempt.runId}`,
      '',
      `**Attempt:** ${attempt.id}`,
      `**Operation:** ${finalization.operationId}`,
      `**Disposition:** ${finalization.status}`,
      '',
      '## Summary',
      '',
      finalization.summary,
      '',
      '## Git receipts',
      '',
      commits,
      ...(finalization.status === 'blocked'
        ? ['', '## Blocker', '', '```json', JSON.stringify(stableValue(finalization.blocker ?? null), null, 2), '```']
        : []),
      '',
    ].join('\n');
  }

  private reportPath(attempt: ExecutionAttempt, operationId: string): string {
    if (attempt.kind === 'task') {
      return path.join(getTaskPath(this.projectRoot, attempt.featureName!, attempt.taskFolder!), 'reports', `finalization-${operationId}.md`);
    }
    return path.join(this.projectRoot, '.hive', 'execution-reports', `finalization-${operationId}.md`);
  }

  private writeImmutable(reportPath: string, content: string, contentHash: string): void {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    try {
      fs.writeFileSync(reportPath, content, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (hash(fs.readFileSync(reportPath, 'utf8')) !== contentHash) {
        throw new Error(`Existing finalization report does not match its deterministic content: ${reportPath}`);
      }
    }
  }

  private writeLatestTaskReport(attempt: ExecutionAttempt, content: string): void {
    if (attempt.kind !== 'task') return;
    const immutable = attempt.finalization!.report!.locator;
    writeAtomic(path.join(getTaskPath(this.projectRoot, attempt.featureName!, attempt.taskFolder!), 'report.md'), [
      content,
      '---',
      '',
      '## Report history',
      '',
      `Immutable finalization report: [${path.basename(immutable)}](reports/${path.basename(immutable)}).`,
      '',
    ].join('\n'));
  }

  private taskStatus(status: ExecutionFinalizationStatus): TaskStatusType {
    return status === 'completed' ? 'done' : status;
  }

  private checkpoint(checkpoint: ExecutionFinalizationCheckpoint): void {
    this.options.checkpoint?.(checkpoint);
  }
}
