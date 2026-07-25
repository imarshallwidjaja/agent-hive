import { describe, expect, it } from 'bun:test';
import { buildWorkerPrompt } from './worker-prompt.js';

describe('buildWorkerPrompt commit handoff', () => {
  it('requires an explicit subject and body for every terminal status that may commit changes', () => {
    const prompt = buildWorkerPrompt({
      feature: 'test-feature',
      task: '01-test-task',
      taskOrder: 1,
      worktreePath: '/tmp/worktree',
      branch: 'hive/test-feature/01-test-task',
      plan: '# Plan',
      contextFiles: [],
      spec: 'Implement the task.',
    });

    expect(prompt).toContain('required when changes will be committed');
    expect(prompt).toContain('non-empty one-line subject, a blank line, and a non-empty descriptive body');
    expect(prompt).not.toContain('Optional git commit subject');
    expect(prompt).not.toContain('Omit message (or pass empty string) to use existing defaults');
    expect(prompt.match(/message: "type\(scope\): concise subject\\n\\nDescribe what changed and why\."/g)).toHaveLength(3);
  });
});
