import { describe, expect, it } from 'bun:test';
import { buildCompactionReanchor } from './compaction-anchor.js';
import type { CompactionSessionContext, CompactionReanchor } from './compaction-anchor.js';

describe('buildCompactionReanchor', () => {
  describe('minimum anchor contract (all session kinds)', () => {
    const kinds: CompactionSessionContext['sessionKind'][] = [
      'primary',
      'subagent',
      'task-worker',
      'unknown',
    ];

    for (const kind of kinds) {
      describe(`sessionKind=${kind}`, () => {
        let anchor: CompactionReanchor;

        it('returns a CompactionReanchor', () => {
          anchor = buildCompactionReanchor({
            sessionKind: kind,
            agent: kind === 'primary' ? 'hive-master' :
                   kind === 'subagent' ? 'scout-researcher' :
                   kind === 'task-worker' ? 'forager-worker' :
                   undefined,
          });
          expect(anchor).toBeDefined();
          expect(typeof anchor.prompt).toBe('string');
          expect(Array.isArray(anchor.context)).toBe(true);
        });

        it('contains Compaction recovery', () => {
          anchor = buildCompactionReanchor({
            sessionKind: kind,
            agent: kind === 'primary' ? 'hive-master' : undefined,
          });
          expect(anchor.prompt).toContain('Compaction recovery');
        });

        it('contains Do not switch roles', () => {
          anchor = buildCompactionReanchor({
            sessionKind: kind,
            agent: kind === 'primary' ? 'hive-master' : undefined,
          });
          expect(anchor.prompt).toContain('Do not switch roles');
        });

        it('contains Do not re-read the full codebase', () => {
          anchor = buildCompactionReanchor({
            sessionKind: kind,
            agent: kind === 'primary' ? 'hive-master' : undefined,
          });
          expect(anchor.prompt).toContain('Do not re-read the full codebase');
        });

        it('contains explicit anti-loop guidance for status tools', () => {
          anchor = buildCompactionReanchor({
            sessionKind: kind,
            agent: kind === 'primary' ? 'hive-master' : undefined,
          });
          expect(anchor.prompt).toContain('Do not call status tools');
        });

        it('contains Next action:', () => {
          anchor = buildCompactionReanchor({
            sessionKind: kind,
            agent: kind === 'primary' ? 'hive-master' : undefined,
          });
          expect(anchor.prompt).toContain('Next action:');
        });
      });
    }
  });

  describe('primary agents', () => {
    it('anchors hive-master with Role: Hive', () => {
      const anchor = buildCompactionReanchor({
        agent: 'hive-master',
        sessionKind: 'primary',
        directivePrompt: 'Finish the current task and report findings only.',
      });
      expect(anchor.prompt).toContain('Role: Hive');
      expect(anchor.prompt).toContain('Original directive survives via post-compaction replay.');
      expect(anchor.context).toEqual([]);
    });

    it('anchors architect-planner with Role: Architect', () => {
      const anchor = buildCompactionReanchor({
        agent: 'architect-planner',
        sessionKind: 'primary',
      });
      expect(anchor.prompt).toContain('Role: Architect');
    });

    it('anchors swarm-orchestrator with Role: Swarm', () => {
      const anchor = buildCompactionReanchor({
        agent: 'swarm-orchestrator',
        sessionKind: 'primary',
      });
      expect(anchor.prompt).toContain('Role: Swarm');
    });

    it('anchors hive-builder with Role: Hive Builder', () => {
      const anchor = buildCompactionReanchor({
        agent: 'hive-builder',
        sessionKind: 'primary',
      });
      expect(anchor.prompt).toContain('Role: Hive Builder');
    });
  });

  describe('normal subagents', () => {
    it('anchors scout-researcher with Role: Scout', () => {
      const anchor = buildCompactionReanchor({
        agent: 'scout-researcher',
        sessionKind: 'subagent',
      });
      expect(anchor.prompt).toContain('Role: Scout');
    });

    it('anchors code-reviewer with Role: Code Reviewer', () => {
      const anchor = buildCompactionReanchor({
        agent: 'code-reviewer',
        sessionKind: 'subagent',
      });
      expect(anchor.prompt).toContain('Role: Code Reviewer');
    });

    it('anchors simplicity-reviewer with Role: Simplicity Reviewer', () => {
      const anchor = buildCompactionReanchor({
        agent: 'simplicity-reviewer',
        sessionKind: 'subagent',
      });
      expect(anchor.prompt).toContain('Role: Simplicity Reviewer');
    });

    it('anchors hive-helper with Role: Hive Helper', () => {
      const anchor = buildCompactionReanchor({
        agent: 'hive-helper',
        sessionKind: 'subagent',
      });
      expect(anchor.prompt).toContain('Role: Hive Helper');
    });

    it('anchors custom code-reviewer derivative with Role: Code Reviewer', () => {
      const anchor = buildCompactionReanchor({
        agent: 'my-custom-reviewer',
        baseAgent: 'code-reviewer',
        sessionKind: 'subagent',
      });
      expect(anchor.prompt).toContain('Role: Code Reviewer');
    });

    it('does not mention worker-prompt.md for subagents', () => {
      const anchor = buildCompactionReanchor({
        agent: 'scout-researcher',
        sessionKind: 'subagent',
      });
      expect(anchor.prompt).not.toContain('worker-prompt.md');
    });
  });

  describe('task workers', () => {
    it('anchors forager-worker with Role: Forager', () => {
      const anchor = buildCompactionReanchor({
        agent: 'forager-worker',
        sessionKind: 'task-worker',
        featureName: 'feature-a',
        taskFolder: '01-first-task',
        workerPromptPath: '.hive/features/feature-a/tasks/01-first-task/worker-prompt.md',
      });
      expect(anchor.prompt).toContain('Role: Forager');
    });

    it('defers immutable assignment replay to the runtime', () => {
      const anchor = buildCompactionReanchor({
        agent: 'forager-worker',
        sessionKind: 'task-worker',
        featureName: 'feature-a',
        taskFolder: '01-first-task',
        workerAssignment: {
          format: 'hive-worker-assignment/v1',
          projectRoot: '/project',
          featureName: 'feature-a',
          taskFolder: '01-first-task',
          attempt: 1,
          locator: '.hive/features/feature-a/tasks/01-first-task/assignments/attempt-1.md',
          contentHash: 'a'.repeat(64),
        },
      });
      expect(anchor.prompt).toContain('hash-verified immutable assignment');
      expect(anchor.context).toEqual([]);
    });

    it('tells the worker not to delegate', () => {
      const anchor = buildCompactionReanchor({
        agent: 'forager-worker',
        sessionKind: 'task-worker',
        featureName: 'feature-a',
        taskFolder: '01-first-task',
        workerPromptPath: '.hive/features/feature-a/tasks/01-first-task/worker-prompt.md',
      });
      expect(anchor.prompt).toContain('Do not delegate');
    });

    it('does not infer an assignment path from partial task metadata', () => {
      const anchor = buildCompactionReanchor({
        agent: 'forager-worker',
        sessionKind: 'task-worker',
        featureName: 'feature-a',
        taskFolder: '01-first-task',
      });
      expect(anchor.context).toEqual([]);
      expect(anchor.prompt).toContain('exact provenance is unavailable');
      expect(anchor.prompt).not.toContain('task worktree root');
    });

    it('rejects legacy mutable prompt replay', () => {
      const anchor = buildCompactionReanchor({
        agent: 'forager-worker',
        sessionKind: 'task-worker',
        featureName: 'feature-a',
        taskFolder: '01-first-task',
        workerPromptPath: '.hive/features/feature-a/tasks/01-first-task/worker-prompt.md',
      });
      expect(anchor.context).toEqual([]);
      expect(anchor.prompt).toContain('Legacy mutable assignment recovery is unavailable');
    });

    it('anchors custom forager-worker derivative with Role: Forager', () => {
      const anchor = buildCompactionReanchor({
        agent: 'my-custom-worker',
        baseAgent: 'forager-worker',
        sessionKind: 'task-worker',
        featureName: 'feature-b',
        taskFolder: '02-second-task',
        workerPromptPath: '.hive/features/feature-b/tasks/02-second-task/worker-prompt.md',
      });
      expect(anchor.prompt).toContain('Role: Forager');
      expect(anchor.prompt).toContain('Legacy mutable assignment recovery is unavailable');
    });
  });

  describe('unknown sessions (safe fallback)', () => {
    it('produces a valid anchor with no session context', () => {
      const anchor = buildCompactionReanchor({});
      expect(anchor.prompt).toContain('Compaction recovery');
      expect(anchor.prompt).toContain('Do not switch roles');
      expect(anchor.prompt).toContain('Next action:');
    });

    it('does not mention worker-prompt.md for unknown sessions', () => {
      const anchor = buildCompactionReanchor({});
      expect(anchor.prompt).not.toContain('worker-prompt.md');
    });

    it('returns empty context for unknown sessions', () => {
      const anchor = buildCompactionReanchor({});
      expect(anchor.context).toEqual([]);
    });
  });

  describe('only task-worker anchors mention worker-prompt.md', () => {
    it('primary agents do not mention worker-prompt.md', () => {
      const anchor = buildCompactionReanchor({
        agent: 'hive-master',
        sessionKind: 'primary',
      });
      expect(anchor.prompt).not.toContain('worker-prompt.md');
      expect(anchor.context.join('\n')).not.toContain('worker-prompt.md');
    });

    it('subagents do not mention worker-prompt.md', () => {
      const anchor = buildCompactionReanchor({
        agent: 'code-reviewer',
        sessionKind: 'subagent',
      });
      expect(anchor.prompt).not.toContain('worker-prompt.md');
      expect(anchor.context.join('\n')).not.toContain('worker-prompt.md');
    });

    it('unknown sessions do not mention worker-prompt.md', () => {
      const anchor = buildCompactionReanchor({
        sessionKind: 'unknown',
      });
      expect(anchor.prompt).not.toContain('worker-prompt.md');
      expect(anchor.context.join('\n')).not.toContain('worker-prompt.md');
    });
  });
});
