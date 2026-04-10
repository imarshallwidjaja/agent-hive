import * as path from 'path';
import { WorktreeService } from 'hive-core';
import type { ToolRegistration } from './base';
import { defineTool } from './base';

export function getMergeTools(workspaceRoot: string): ToolRegistration[] {
  const worktreeService = new WorktreeService({
    baseDir: workspaceRoot,
    hiveDir: path.join(workspaceRoot, '.hive'),
  });

  return [
    defineTool({
      name: 'hive_merge',
      toolReferenceName: 'hiveMerge',
      displayName: 'Merge Task Branch',
      modelDescription: 'Merge a completed task branch into current branch. Supports merge, squash, or rebase strategies. Use after hive_worktree_commit to integrate changes.',
      userDescription: 'Merge a completed Hive task branch into the current branch.',
      canBeReferencedInPrompt: true,
      confirmation: {
        title: 'Merge Hive task branch',
        message: 'Merge the completed Hive task branch into the current branch?',
        invocationMessage: 'Merging Hive task branch',
      },
      inputSchema: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'Feature name' },
          task: { type: 'string', description: 'Task folder name' },
          strategy: {
            type: 'string',
            enum: ['merge', 'squash', 'rebase'],
            description: 'Merge strategy (default: merge)',
          },
          message: { type: 'string', description: 'Optional merge commit message for merge/squash only. Empty uses default.' },
          preserveConflicts: {
            type: 'boolean',
            description: 'Keep merge conflict state intact instead of auto-aborting (default: false).',
          },
          cleanup: {
            type: 'string',
            enum: ['none', 'worktree', 'worktree+branch'],
            description: 'Cleanup mode after a successful merge (default: none).',
          },
        },
        required: ['feature', 'task'],
      },
      invoke: async (input) => {
        const { feature, task, strategy = 'merge', message, preserveConflicts, cleanup } = input as {
          feature: string;
          task: string;
          strategy?: string;
          message?: string;
          preserveConflicts?: boolean;
          cleanup?: 'none' | 'worktree' | 'worktree+branch';
        };
        const result = await worktreeService.merge(feature, task, strategy as any, message, {
          preserveConflicts,
          cleanup,
        });
        return JSON.stringify({
          ...result,
          message: result.success
            ? 'Merge completed.'
            : result.error || 'Merge failed.',
        });
      },
    }),
  ];
}
