import { describe, expect, it } from 'bun:test';
import {
  appendManagedPromptBlock,
  buildExecutionScopeBlock,
  buildStandingConstraintsBlock,
  EXECUTION_SCOPE_START,
  STANDING_CONSTRAINTS_END,
  STANDING_CONSTRAINTS_HEADING,
  STANDING_CONSTRAINTS_START,
} from './worker-prompt.js';

describe('managed prompt blocks', () => {
  it('renders standing constraints verbatim inside the trusted block', () => {
    const constraints = 'Australian English. No emojis.';
    expect(buildStandingConstraintsBlock(constraints)).toBe([
      STANDING_CONSTRAINTS_START,
      STANDING_CONSTRAINTS_HEADING,
      '',
      constraints,
      '',
      'These are operator constraints for this session. They apply in addition to your task-specific instructions. If they conflict with your assignment, report the conflict rather than silently choosing one.',
      STANDING_CONSTRAINTS_END,
    ].join('\n'));
  });

  it('preserves every caller-authored byte when spoofed managed markers are present', () => {
    const caller = `before\n${EXECUTION_SCOPE_START}\ncaller evidence\n${STANDING_CONSTRAINTS_END}\nafter  `;
    const block = buildStandingConstraintsBlock('Keep scope.');
    const augmented = appendManagedPromptBlock(caller, block);
    expect(augmented.slice(0, caller.length)).toBe(caller);
    expect(augmented).toBe(`${caller}\n\n${block}`);
  });

  it('describes in-place handoff as report-only', () => {
    const block = buildExecutionScopeBlock({
      kind: 'task', featureName: 'feature', featureDirectory: '09_feature', taskFolder: '01-task',
      placement: { kind: 'in_place', directory: '/tmp/live' },
    });

    expect(block).toContain('Task spec: .hive/features/09_feature/tasks/01-task/spec.md');
    expect(block).toContain('Feature context: .hive/features/09_feature/context/');
    expect(block).toContain('without a commit message');
    expect(block).not.toContain('hive_worktree_commit');
  });

  it('directs ad-hoc in-place workers to a terminal prose handoff', () => {
    const block = buildExecutionScopeBlock({
      kind: 'adhoc', runId: 'live-run',
      placement: { kind: 'in_place', directory: '/tmp/live' },
    });

    expect(block).toContain('terminal prose handoff');
    expect(block).not.toContain('task handoff tool');
  });

  it('directs feature worktree workers through the temporary commit bridge', () => {
    const block = buildExecutionScopeBlock({
      kind: 'task', featureName: 'feature', featureDirectory: '09_feature', taskFolder: '01-task',
      placement: { kind: 'worktree', workspacePath: '/tmp/feature-worktree' },
    });

    expect(block).toContain('report and commit through hive_worktree_commit');
    expect(block).toContain('the primary owns both');
    expect(block).not.toContain('hive_adhoc_worktree_commit');
  });

  it('directs ad-hoc worktree workers through the temporary commit bridge', () => {
    const block = buildExecutionScopeBlock({
      kind: 'adhoc', runId: 'adhoc-run',
      placement: { kind: 'worktree', workspacePath: '/tmp/adhoc-worktree' },
    });

    expect(block).toContain('report and commit through hive_adhoc_worktree_commit');
    expect(block).toContain('the primary owns both');
    expect(block).not.toContain('hive_worktree_commit.');
  });
});
