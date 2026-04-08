import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildCheckpointRehydration, MAX_REHYDRATION_CHARS } from './checkpoint-rehydration.js';

describe('buildCheckpointRehydration', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-checkpoint-rehydration-'));
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('builds a bounded durable task checkpoint summary without replaying raw transcript content', () => {
    const taskDir = path.join(testRoot, '.hive', 'features', 'feature-a', 'tasks', '01-first-task');
    fs.mkdirSync(taskDir, { recursive: true });

    fs.writeFileSync(
      path.join(taskDir, 'status.json'),
      JSON.stringify({
        status: 'in_progress',
        origin: 'plan',
        planTitle: 'First Task',
        summary: 'Rehydrate from durable task state after compaction and after child session return.',
        workerSession: {
          sessionId: 'sess-worker',
          mode: 'delegate',
          attempt: 2,
          messageCount: 21,
        },
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(taskDir, 'spec.md'),
      '# Task\n\nRAW_PROMPT_SHOULD_NOT_SURVIVE\n\nmessages: [tool, user, assistant]\n',
    );
    fs.writeFileSync(
      path.join(taskDir, 'report.md'),
      '# Task Report\n\n## Summary\n\nWHOLE_HISTORY_COPY_SHOULD_NOT_SURVIVE\n',
    );

    const text = buildCheckpointRehydration({
      projectRoot: testRoot,
      featureName: 'feature-a',
      taskFolder: '01-first-task',
      workerPromptPath: '.hive/features/feature-a/tasks/01-first-task/worker-prompt.md',
    });

    expect(text).not.toBeNull();
    expect(text).toContain('Task checkpoint rehydration');
    expect(text).toContain('01-first-task');
    expect(text).toContain('.hive/features/feature-a/tasks/01-first-task/worker-prompt.md');
    expect(text).toContain('.hive/features/feature-a/tasks/01-first-task/status.json');
    expect(text).toContain('.hive/features/feature-a/tasks/01-first-task/spec.md');
    expect(text).toContain('.hive/features/feature-a/tasks/01-first-task/report.md');
    expect(text).toContain('Rehydrate from durable task state after compaction');
    expect(text).not.toContain('RAW_PROMPT_SHOULD_NOT_SURVIVE');
    expect(text).not.toContain('WHOLE_HISTORY_COPY_SHOULD_NOT_SURVIVE');
    expect(text).not.toContain('messages: [tool, user, assistant]');
    expect(text!.length).toBeLessThanOrEqual(MAX_REHYDRATION_CHARS);
  });

  test('prefers checkpoint.json semantic fields over status or transcript-like support files when present', () => {
    const taskDir = path.join(testRoot, '.hive', 'features', 'feature-a', 'tasks', '01-first-task');
    fs.mkdirSync(taskDir, { recursive: true });

    fs.writeFileSync(
      path.join(taskDir, 'checkpoint.json'),
      JSON.stringify({
        schemaVersion: 1,
        taskFolder: '01-first-task',
        currentObjective: 'Resume grounded orchestration after child worker handoff.',
        stateSummary: 'Parent session should replay the selected checkpoint, not the child transcript.',
        importantDecisions: [
          'Use checkpoint.json as the durable source of truth.',
          'Avoid replaying raw prompt bodies or transcript arrays.',
        ],
        filesInPlay: [
          '.hive/features/feature-a/tasks/01-first-task/checkpoint.json',
          'packages/opencode-hive/src/index.ts',
        ],
        verificationState: 'Regression tests red.',
        nextAction: 'Mark the parent session for replay.',
        status: 'active',
        updatedAt: '2026-04-08T00:00:00.000Z',
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(taskDir, 'status.json'),
      JSON.stringify({
        status: 'in_progress',
        planTitle: 'WRONG STATUS TITLE',
        summary: 'RAW_PROMPT_SHOULD_NOT_SURVIVE from status summary',
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(taskDir, 'spec.md'),
      '# Task\n\nmessages: [tool, user, assistant]\n\nWHOLE_HISTORY_COPY_SHOULD_NOT_SURVIVE\n',
    );
    fs.writeFileSync(
      path.join(taskDir, 'report.md'),
      '# Task Report\n\nprompt: RAW_PROMPT_SHOULD_NOT_SURVIVE\n',
    );

    const text = buildCheckpointRehydration({
      projectRoot: testRoot,
      featureName: 'feature-a',
      taskFolder: '01-first-task',
      workerPromptPath: '.hive/features/feature-a/tasks/01-first-task/worker-prompt.md',
    });

    expect(text).not.toBeNull();
    expect(text).toContain('.hive/features/feature-a/tasks/01-first-task/checkpoint.json');
    expect(text).toContain('Resume grounded orchestration after child worker handoff.');
    expect(text).toContain('Parent session should replay the selected checkpoint');
    expect(text).toContain('Use checkpoint.json as the durable source of truth.');
    expect(text).toContain('Regression tests red.');
    expect(text).toContain('Mark the parent session for replay.');
    expect(text).not.toContain('WRONG STATUS TITLE');
    expect(text).not.toContain('RAW_PROMPT_SHOULD_NOT_SURVIVE');
    expect(text).not.toContain('WHOLE_HISTORY_COPY_SHOULD_NOT_SURVIVE');
    expect(text).not.toContain('messages: [tool, user, assistant]');
    expect(text!.length).toBeLessThanOrEqual(MAX_REHYDRATION_CHARS);
  });

  test('returns null when no durable task state can be found', () => {
    const text = buildCheckpointRehydration({
      projectRoot: testRoot,
      featureName: 'missing-feature',
      taskFolder: '99-missing-task',
      workerPromptPath: '.hive/features/missing-feature/tasks/99-missing-task/worker-prompt.md',
    });

    expect(text).toBeNull();
  });
});
