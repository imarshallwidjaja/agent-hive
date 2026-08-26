import { describe, expect, it } from 'bun:test';
import { buildWorkerPrompt } from './worker-prompt.js';

describe('buildWorkerPrompt commit handoff', () => {
  it('follows the mission-selected testing strategy and always requires proportional verification', () => {
    const prompt = buildWorkerPrompt({
      feature: 'test-feature',
      task: '01-test-task',
      taskOrder: 1,
      worktreePath: '/tmp/worktree',
      branch: 'hive/test-feature/01-test-task',
      plan: '# Plan',
      contextFiles: [],
      spec: 'Use tests after implementation for this task.',
    });

    expect(prompt).toContain('testing strategy selected by the mission or repository policy');
    expect(prompt).toContain('## Testing Strategy');
    expect(prompt).toContain('When TDD is selected');
    expect(prompt).toContain('characterization tests');
    expect(prompt).toContain('tests alongside or after implementation');
    expect(prompt).toContain('existing public-contract coverage for a behavior-preserving refactor');
    expect(prompt).toContain('No-new-test choices still require proportional verification');
    expect(prompt).toContain('verification selected by the mission, plan, or repository policy');
    expect(prompt).not.toContain('| New behavior | Run tests covering the new code; record pass/fail counts |');
    expect(prompt).not.toContain('## TDD Protocol (Required)');
  });

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
