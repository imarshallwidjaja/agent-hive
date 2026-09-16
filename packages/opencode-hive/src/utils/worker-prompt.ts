export const STANDING_CONSTRAINTS_HEADING = '## Standing Constraints (operator, session-wide)';
export const STANDING_CONSTRAINTS_START = '<!-- hive-standing-constraints:start -->';
export const STANDING_CONSTRAINTS_END = '<!-- hive-standing-constraints:end -->';
export const EXECUTION_SCOPE_HEADING = '## Hive execution scope';
export const EXECUTION_SCOPE_START = '<!-- hive-execution-scope:start -->';
export const EXECUTION_SCOPE_END = '<!-- hive-execution-scope:end -->';

const STANDING_CONSTRAINTS_FOOTER = 'These are operator constraints for this session. They apply in addition to your task-specific instructions. If they conflict with your assignment, report the conflict rather than silently choosing one.';

/** The operator text is emitted verbatim. */
export function buildStandingConstraintsBlock(standingConstraints: string | undefined): string | null {
  if (!standingConstraints || !standingConstraints.trim()) return null;
  return `${STANDING_CONSTRAINTS_START}\n${STANDING_CONSTRAINTS_HEADING}\n\n${standingConstraints}\n\n${STANDING_CONSTRAINTS_FOOTER}\n${STANDING_CONSTRAINTS_END}`;
}

export interface ExecutionScopeBlockInput {
  kind: 'task' | 'adhoc';
  featureName?: string;
  taskFolder?: string;
  runId?: string;
  placement: { kind: 'worktree'; workspacePath: string } | { kind: 'in_place'; directory: string };
}

export function buildExecutionScopeBlock(input: ExecutionScopeBlockInput): string {
  const scope = input.kind === 'task'
    ? `Feature: ${input.featureName}\nTask: ${input.taskFolder}`
    : `Ad-hoc run: ${input.runId}`;
  const directory = input.placement.kind === 'worktree' ? input.placement.workspacePath : input.placement.directory;
  const references = input.kind === 'task'
    ? `Task spec: .hive/features/${input.featureName}/tasks/${input.taskFolder}/spec.md\nFeature context: .hive/features/${input.featureName}/context/`
    : 'Managed context: project scope only unless the authenticated execution has a feature binding.';
  const placement = input.placement.kind === 'worktree'
    ? input.kind === 'task'
      ? 'Placement: registered Git worktree. For the temporary worker bridge, report and commit through hive_worktree_commit. That handoff does not authorize merge or cleanup; the primary owns both.'
      : 'Placement: registered Git worktree. For the temporary worker bridge, report and commit through hive_adhoc_worktree_commit. That handoff does not authorize merge or cleanup; the primary owns both.'
    : input.kind === 'task'
      ? 'Placement: live in-place directory. Changes are immediately visible; Hive provides no filesystem confinement, staging, rollback, commit, or merge guarantee. For the temporary worker bridge, report through the task handoff tool without a commit message; Hive records disposition without running Git.'
      : 'Placement: live in-place directory. Changes are immediately visible; Hive provides no filesystem confinement, staging, rollback, commit, or merge guarantee. Return the outcome and verification evidence in your terminal prose handoff to the primary.';
  return `${EXECUTION_SCOPE_START}\n${EXECUTION_SCOPE_HEADING}\n\n${scope}\nWorking directory: ${directory}\n${references}\n${placement}\nReturn one terminal handoff to the primary; worker prose does not finalize execution state.\n${EXECUTION_SCOPE_END}`;
}

/** Append trusted runtime material without interpreting or rewriting caller-authored bytes. */
export function appendManagedPromptBlock(prompt: string, block: string | null): string {
  if (!block) return prompt;
  return `${prompt}${prompt ? '\n\n' : ''}${block}`;
}
