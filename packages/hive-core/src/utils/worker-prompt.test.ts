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
    expect(prompt).toContain('## Pre-mission Checklist');
    expect(prompt).toContain('Make a minimal fix only when implementation is authorized');
    expect(prompt).toContain('otherwise report the evidence and conclusion without edits');
    expect(prompt).toContain('For implementation-authorized work, use hive_context_write for substantial discoveries');
    expect(prompt).toContain('set `task: "01-test-task"` using the exact task folder from Assignment Details');
    expect(prompt).toContain('later readers can associate it with this task');
    expect(prompt).not.toContain('downstream injection can prioritize it');
    expect(prompt).toContain('Keep report-only diagnostic discoveries in the terminal handoff unless the mission explicitly authorizes context persistence');
    expect(prompt).toContain('required managed lifecycle completion or blocker reporting still uses hive_worktree_commit');
    expect(prompt).not.toContain('**Save context** - Use hive_context_write for discoveries');
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

  it('identifies generated worker prompts as managed feature tasks with zero-diff completion', () => {
    const prompt = buildWorkerPrompt({
      feature: 'test-feature',
      task: '01-test-task',
      taskOrder: 1,
      worktreePath: '/tmp/worktree',
      branch: 'hive/test-feature/01-test-task',
      plan: '# Plan',
      contextFiles: [],
      spec: 'Report whether an edit is needed.',
    });

    expect(prompt).toContain('This is a managed feature task');
    expect(prompt).toContain('The completion protocol applies because the assignment details above supply an actual feature and task');
    expect(prompt).toContain('A no-change completion omits `message`; do not create an empty commit');
  });
});
