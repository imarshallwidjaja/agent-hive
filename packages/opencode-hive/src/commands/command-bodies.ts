import type { HiveCommandKey } from './registry.js';

export const COMMAND_BEHAVIOR: Record<HiveCommandKey, string> = {
  interview: `Conduct a focused interview to help the operator clarify an idea, make decisions, and surface the right next steps.

Use the operator-provided topic or context from runtime arguments when provided.

Collect decisions, constraints, assumptions, goals, and unresolved questions that matter for moving the work forward.

Optimize for a strong handoff into \`/implementation-brief\` when heading toward implementation planning. Do not force that workflow when the operator is still brainstorming.

Do not jump into implementation. Do not write code or Hive plans. Do not invent repository facts not established in this session.

Interview rules:
- Ask exactly one question at a time.
- Prefer the \`question\` tool when it helps the operator answer cleanly.
- Choose the highest-ambiguity, highest-risk, or highest-value missing decision first.
- After each answer, include a short running summary of what is decided, constraints, and what still needs clarification.
- Usually 4-7 questions; do not exceed 8 unless the operator wants a deeper interview.
- Conclude when no more high-value questions remain.

End with:
## Interview Summary (problem, target outcome, scope, non-goals, constraints, decisions made, open questions)
## Recommended Next Step (include \`/implementation-brief\` when appropriate)
## Context For \`/implementation-brief\` (compact handoff when planning is next; otherwise say plainly)`,

  'implementation-brief': `Turn current session exploration into a copy-paste-ready implementation-planning prompt for another agent.

Revalidate live repo paths, symbols, commands, and ownership before treating them as facts. Use runtime arguments for extra context.

Do not produce the Hive implementation plan. Do not write code. Do not call \`hive_plan_write\`.

The prompt must define: problem, exact scope, live code references and call paths, known facts, solution leads, expected outcomes, repo/parity constraints, and validations the next agent must perform.

Output only the final prompt in one fenced code block.`,

  'hive-plan': `Create a Hive plan from runtime arguments when provided.

Prioritize active discovery before writing: inspect files, tests, docs, and constraints. Validate feasibility against the live repository.

Split tasks for clean parallelism without over-splitting coherent work. For non-ad-hoc work, include documentation updates when user-facing behavior or operator workflow changes.

Use \`hive_feature_create\`, \`hive_context_write\`, \`hive_plan_write\`, and read back state with \`hive_plan_read\` / \`hive_status\`.

Present: feature and plan status, plan readback, task breakdown, recommended execution order, session strategy, applied operator input, and remaining decision points.`,

  'approve-sync-plan': `Finalize the active Hive plan for execution.

Workflow: \`hive_status\` → \`hive_plan_read\` → \`hive_plan_approve\` → \`hive_tasks_sync\` → read back status/tasks. Stop on exact blockers with recovery path.

Return sections: ## Feature, ## Plan Readback, ## Task Breakdown, ## Recommended Execution Order, ## Session Strategy (Min Sessions, No Context Overload), ## Additional Operator Input, ## Decision Points For Operator.

Do not write code. Do not omit any task.`,

  'start-execution': `Execute the approved Hive plan using runtime arguments when provided.

Confirm parallel vs sequential strategy with the operator before proceeding.

Preserve flow: \`hive_worktree_start\` → worker execution → worker \`hive_worktree_commit\` → orchestrator \`hive_merge\`. The orchestrator must not call \`hive_worktree_commit\` for workers.

Track todos through execution. Retry failed workers in fresh sessions with failure context. Handle blockers via \`hive_status\` and \`question()\`, then \`hive_worktree_create\` with the decision.`,

  'council-directive': `Prepare a reusable council directive. Do not run council. Do not write code or mutate Hive state.

Ask one question at a time when needed (max 4). Use configured council group names from configuration, not stale aliases or mutable worker seats.

Output: ## Council Directive (objective, direction, include, constraints, context, assumptions needing validation, desired output), ## Recommendation, ## Recommended Invocation, ## Paste Into New Chat when appropriate.`,

  council: `When usable councillors are resolved, run a read-only council and synthesize one recommendation. If no usable councillors remain, stop and report the resolver warnings instead of running council.

Normalize loose input into a directive; ask at most 2 clarification questions when needed.

Use resolved councillors from configured groups only. Never modify files, plans, or worktrees during council.

Preserve dissent and evidence gaps. Output: ## Council Directive, ## Council Result, ## Agreement, ## Disagreement, ## Risks, ## Recommendation, ## Suggested Next Step, ## Council Members.`,

  'compact-summary': `Recovery summary for the current OpenCode session only. Do not mutate state.

Output exact sections in order: ## Goal, ## Constraints & Preferences, ## Progress (### Done, ### In Progress, ### Blocked), ## Key Decisions, ## Next Steps, ## Critical Context, ## Relevant Files.

Terse bullets. Preserve exact paths, commands, errors, branches, URLs. Do not claim verification, tests, builds, or checks succeeded without actual command output in the conversation.`,

};
