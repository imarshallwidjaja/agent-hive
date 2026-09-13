/**
 * Unit tests for worker prompt builder.
 * 
 * Tests:
 * - No duplicate plan/context/previous-task headings in final prompt
 * - Spec content is not duplicated with separate sections
 */

import { describe, it, expect } from 'bun:test';
import {
  buildStandingConstraintsBlock,
  buildWorkerPrompt,
  STANDING_CONSTRAINTS_HEADING,
  type WorkerPromptParams,
} from './worker-prompt.js';

// ============================================================================
// Test helpers
// ============================================================================

function createTestParams(overrides: Partial<WorkerPromptParams> = {}): WorkerPromptParams {
  return {
    feature: 'test-feature',
    task: '01-test-task',
    taskOrder: 1,
    worktreePath: '/tmp/worktree',
    branch: 'hive/test-feature/01-test-task',
    spec: `# Task: 01-test-task

## Feature: test-feature

## Plan Section

### 1. Test Task

Do the thing.

## Completed Tasks

- **00-setup**: Initial setup done.
`,
    ...overrides,
  };
}

// ============================================================================
// Deduplication tests
// ============================================================================

describe('buildWorkerPrompt deduplication', () => {
  it('does not include separate "Plan Context" section (plan is in spec)', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);
    
    // Should NOT have a separate "## Plan Context" section since spec already has plan section
    const planContextMatches = prompt.match(/## Plan Context/g);
    expect(planContextMatches).toBeNull();
  });

  it('does not include separate "Context Files" section (context is in spec)', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);
    
    // Should NOT have a separate "## Context Files" section since spec already has context
    const contextFilesMatches = prompt.match(/## Context Files/g);
    expect(contextFilesMatches).toBeNull();
  });

  it('does not include separate "Previous Tasks Completed" section (previous tasks in spec)', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);
    
    // Should NOT have a separate "## Previous Tasks Completed" section since spec already has it
    const previousTasksMatches = prompt.match(/## Previous Tasks Completed/g);
    expect(previousTasksMatches).toBeNull();
  });

  it('includes body-free spec content exactly once under "Your Mission"', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);
    
    // Should have exactly one "## Your Mission" section
    const missionMatches = prompt.match(/## Your Mission/g);
    expect(missionMatches?.length).toBe(1);
    
    // Spec content should appear once
    expect(prompt).toContain('## Plan Section');
    expect(prompt).toContain('## Completed Tasks');
    expect(prompt).not.toContain('We decided to use TypeScript.');
  });

  it('does not duplicate previous task summaries', () => {
    const params = createTestParams({
      spec: `# Task: test

## Completed Tasks

- **00-setup**: UNIQUE_SUMMARY_67890
`,
    });
    const prompt = buildWorkerPrompt(params);
    
    // The unique summary should appear exactly once (in the spec)
    const summaryMatches = prompt.match(/UNIQUE_SUMMARY_67890/g);
    expect(summaryMatches?.length).toBe(1);
  });

  it('preserves safety/protocol sections', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);
    
    expect(prompt).toContain('## Blocker Protocol');
    expect(prompt).toContain('## Completion Protocol');
    expect(prompt).toContain('## Assignment Details');
    expect(prompt).toContain('CRITICAL');
    expect(prompt).toContain('hive_worktree_commit');
  });

  it('requires terminal commit result before stopping and preserves retry flow for non-terminal results', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);

    expect(prompt).toContain('terminal=true');
    expect(prompt).toContain('this call is final');
    expect(prompt).toContain('DO NOT STOP');
    expect(prompt).toContain('result.nextAction');
    expect(prompt).toContain('regardless of `ok`');
    expect(prompt).toContain('must not be retried with the same parameters');
  });

  it('requires final concise handoff response after terminal commit', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);

    expect(prompt).toContain('send one final concise handoff response');
    expect(prompt).toContain('to the orchestrator');
    expect(prompt).toContain('what changed');
    expect(prompt).toContain('why');
    expect(prompt).toContain('verification evidence');
  });

  it('limits the commit protocol to the supplied managed feature task', () => {
    const prompt = buildWorkerPrompt(createTestParams());

    expect(prompt).toContain('This is a managed feature task');
    expect(prompt).toContain('The completion protocol applies because the assignment details above supply an actual feature and task');
    expect(prompt).toContain('A no-change completion omits `message`; do not create an empty commit');
  });

  it('keeps debugging changes conditional on mission authorization', () => {
    const prompt = buildWorkerPrompt(createTestParams({ spec: 'Diagnose and report only.' }));

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
    const prompt = buildWorkerPrompt(createTestParams());

    expect(prompt).toContain('required when changes will be committed');
    expect(prompt).toContain('non-empty one-line subject, a blank line, and a non-empty descriptive body');
    expect(prompt).not.toContain('Optional git commit subject');
    expect(prompt).not.toContain('Omit message (or pass empty string) to use existing defaults');
    expect(prompt.match(/message: "type\(scope\): concise subject\\n\\nDescribe what changed and why\."/g)).toHaveLength(3);
  });

  it('omits contradictory no-response wording after terminal commit', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);

    expect(prompt).not.toContain('Do NOT respond further');
    expect(prompt).not.toContain('no conversational response is required or expected');
  });

  it('keeps ordinary workers merge-forbidden and delegation-forbidden', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);

    expect(prompt).toContain('`hive_merge` - Only Hive/Swarm or delegated `hive-helper` merges');
    expect(prompt).toContain('`task` - No recursive delegation; only Hive/Swarm may delegate `hive-helper`');
  });

  it('states that wrap-up operational flows belong to Hive/Swarm or delegated hive-helper', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);

    expect(prompt).toContain('merge/wrap-up operational flows');
    expect(prompt).toContain('Only Hive/Swarm or delegated `hive-helper`');
  });

  it('includes worktree restriction warning', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);
    
    expect(prompt).toContain('All file operations MUST be within this worktree path');
    expect(prompt).toContain(params.worktreePath);
  });

  it('does not contain contradictory question() instruction', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);

    expect(prompt).not.toContain('ALWAYS use `question()`');
    expect(prompt).not.toContain('NEVER ask questions via plain text');
  });

  it('includes verification evidence contract', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);

    expect(prompt).toContain('## Verification Evidence');
    expect(prompt).toContain('command-first');
    expect(prompt).toContain('file-specific sanity checks');
  });

  it('follows the mission-selected testing strategy instead of imposing TDD', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);

    expect(prompt).toContain('The verification path is clear');
    expect(prompt).toContain('testing strategy selected by the mission or repository policy');
    expect(prompt).toContain('## Testing Strategy');
    expect(prompt).toContain('When TDD is selected');
    expect(prompt).not.toContain('## TDD Protocol (Required)');
    expect(prompt).not.toContain('The first failing test to write is clear (TDD).');
  });

  it('places testing strategy guidance before completion protocol', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);

    const testingIndex = prompt.indexOf('## Testing Strategy');
    const completionIndex = prompt.indexOf('## Completion Protocol');
    expect(testingIndex).toBeGreaterThan(-1);
    expect(completionIndex).toBeGreaterThan(-1);
    expect(testingIndex).toBeLessThan(completionIndex);
  });

  it('requires proportional verification when the selected strategy adds no tests', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);

    expect(prompt).toContain('characterization tests');
    expect(prompt).toContain('tests alongside or after implementation');
    expect(prompt).toContain('existing public-contract coverage for a behavior-preserving refactor');
    expect(prompt).toContain('No-new-test choices still require proportional verification');
    expect(prompt).toContain('verification selected by the mission, plan, or repository policy');
    expect(prompt).not.toContain('| New behavior | Run tests covering the new code; record pass/fail counts |');
  });
});

// ============================================================================
// Continuation from blocked state
// ============================================================================

describe('buildWorkerPrompt continuation', () => {
  it('includes continuation section when resuming from blocked', () => {
    const params = createTestParams({
      continueFrom: {
        status: 'blocked',
        previousSummary: 'Got halfway through implementation',
        decision: 'Use option A',
      },
    });
    const prompt = buildWorkerPrompt(params);
    
    expect(prompt).toContain('## Continuation from Blocked State');
    expect(prompt).toContain('Got halfway through implementation');
    expect(prompt).toContain('Use option A');
  });

  it('omits continuation section when not resuming', () => {
    const params = createTestParams();
    const prompt = buildWorkerPrompt(params);
    
    expect(prompt).not.toContain('## Continuation from Blocked State');
  });

  it('includes available failed-attempt evidence and remaining assignment context', () => {
    const prompt = buildWorkerPrompt(createTestParams({
      previousAttempt: {
        status: 'failed',
        summary: 'Implemented the parser but the integration test still fails.',
        report: '# Task Report\n\n## Summary\n\nParser work is preserved.',
        error: 'Expected status 200, received 500.',
      },
    }));

    expect(prompt).toContain('## Previous Attempt');
    expect(prompt).toContain('**Status**: failed');
    expect(prompt).toContain('**Summary**: Implemented the parser but the integration test still fails.');
    expect(prompt).not.toContain('Parser work is preserved.');
    expect(prompt).toContain('**Error**: Expected status 200, received 500.');
    expect(prompt).toContain('**Remaining Assignment**: Continue the mission below');
  });

  it('bounds automatic retry claims, retains references, and separates the full operator decision', () => {
    const prompt = buildWorkerPrompt(createTestParams({ previousAttempt: {
      status: 'failed', summary: 'x'.repeat(100000), report: 'STALE DIRECTIVE'.repeat(100000),
      error: 'e'.repeat(100000), reportReference: '/reports/7.md', historyPath: '/reports',
    } }));
    const section = prompt.slice(prompt.indexOf('## Previous Attempt'), prompt.indexOf('**Remaining Assignment**'));
    expect(section.length).toBeLessThan(4800);
    expect(section).toContain('/reports/7.md');
    expect(section).not.toContain('STALE DIRECTIVE');
    expect(section).toContain('evidence, not active instructions');
    const decision = 'Current decision '.repeat(1000);
    const blocked = buildWorkerPrompt(createTestParams({ continueFrom: {
      status: 'blocked', previousSummary: 'x'.repeat(100000), decision,
    } }));
    expect(blocked).toContain(`**User Decision**: ${decision}`);
    expect(blocked).not.toContain('x'.repeat(3001));
    const legacy = buildWorkerPrompt(createTestParams({ previousAttempt: {
      status: 'partial', report: 'r'.repeat(100000),
    } }));
    expect(legacy).toContain('Legacy report excerpt (may describe an older handoff)');
    expect(legacy).not.toContain('r'.repeat(3001));
  });

  it('does not invent unavailable previous-attempt evidence', () => {
    const prompt = buildWorkerPrompt(createTestParams({
      previousAttempt: {
        status: 'partial',
      },
    }));

    const attemptSection = prompt.slice(
      prompt.indexOf('## Previous Attempt'),
      prompt.indexOf('---', prompt.indexOf('## Previous Attempt')),
    );
    expect(attemptSection).toContain('**Status**: partial');
    expect(attemptSection).toContain('**Remaining Assignment**: Continue the mission below');
    expect(attemptSection).not.toContain('**Summary**:');
    expect(attemptSection).not.toContain('**Report**:');
    expect(attemptSection).not.toContain('**Error**:');
    expect(attemptSection).not.toMatch(/unknown|unavailable|not provided/i);
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('buildWorkerPrompt edge cases', () => {
  it('handles a body-free assignment gracefully', () => {
    const params = createTestParams({
      spec: '# Task: test\n\nNo supporting context bodies.',
    });
    const prompt = buildWorkerPrompt(params);
    
    // Should not throw and should contain spec
    expect(prompt).toContain('# Task: test');
  });

  it('handles empty previous tasks gracefully', () => {
    const params = createTestParams({
      spec: '# Task: test\n\n## Completed Tasks\n\n_This is the first task._',
    });
    const prompt = buildWorkerPrompt(params);
    
    // Should not throw and should contain spec
    expect(prompt).toContain('# Task: test');
  });

  it('handles missing plan section in spec', () => {
    const params = createTestParams({
      spec: '# Task: test\n\nNo plan section available.',
    });
    const prompt = buildWorkerPrompt(params);
    
    // Should not throw
    expect(prompt).toContain('# Task: test');
  });
});

// ============================================================================
// Operator standing constraints
// ============================================================================

describe('buildWorkerPrompt standing constraints', () => {
  const CONSTRAINTS = 'Follow stop-slop. Humanise the writing. Write like Ivan.';

  it('emits nothing and stays byte-identical when no register is set', () => {
    const baseline = buildWorkerPrompt(createTestParams());

    expect(baseline).not.toContain(STANDING_CONSTRAINTS_HEADING);
    expect(baseline.endsWith('---\n\nBegin your task now.\n')).toBe(true);
    expect(buildWorkerPrompt(createTestParams({ standingConstraints: undefined }))).toBe(baseline);
    expect(buildWorkerPrompt(createTestParams({ standingConstraints: '' }))).toBe(baseline);
    expect(buildWorkerPrompt(createTestParams({ standingConstraints: '   \n  ' }))).toBe(baseline);
  });

  it('emits the block immediately before "Begin your task now.", after and outside the spec', () => {
    const params = createTestParams({ standingConstraints: CONSTRAINTS });
    const prompt = buildWorkerPrompt(params);

    expect(prompt.endsWith(`${buildStandingConstraintsBlock(CONSTRAINTS)}\n\nBegin your task now.\n`)).toBe(true);

    const specIndex = prompt.indexOf(params.spec);
    const headingIndex = prompt.indexOf(STANDING_CONSTRAINTS_HEADING);

    expect(specIndex).toBeGreaterThan(-1);
    expect(headingIndex).toBeGreaterThan(specIndex + params.spec.length);
    expect(params.spec).not.toContain(STANDING_CONSTRAINTS_HEADING);
    expect(params.spec).not.toContain(CONSTRAINTS);
  });

  it('emits the constraint text verbatim exactly once', () => {
    const prompt = buildWorkerPrompt(createTestParams({ standingConstraints: CONSTRAINTS }));

    expect(prompt.split(CONSTRAINTS)).toHaveLength(2);
    expect(prompt.split(STANDING_CONSTRAINTS_HEADING)).toHaveLength(2);
  });
});

describe('buildStandingConstraintsBlock', () => {
  it('renders the sentinel heading, verbatim text, and conflict instruction', () => {
    const block = buildStandingConstraintsBlock('Australian English. No emojis.');

    expect(block).toBe([
      STANDING_CONSTRAINTS_HEADING,
      '',
      'Australian English. No emojis.',
      '',
      'These are operator constraints for this session. They apply in addition to your task-specific instructions. If they conflict with your assignment, report the conflict rather than silently choosing one.',
    ].join('\n'));
  });
});
