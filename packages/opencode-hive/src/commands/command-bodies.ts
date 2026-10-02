import type { HiveCommandKey } from './registry.js';

export const COMMAND_BEHAVIOR: Record<HiveCommandKey, string> = {
  interview: `Clarify the operator's idea one material question at a time. Verify repository facts before presenting them as settled. End with aligned decisions, unresolved items, and the recommended next step. Do not implement or mutate Hive state.`,

  grill: `Question supplied context one material issue at a time until shared understanding is explicit. Separate operator decisions, operator preferences, verified facts, assumptions, and unresolved risks. Do not implement or mutate Hive state.`,

  'implementation-brief': `Turn the confirmed conversation into a self-contained planning brief. Include objective, current state, requirements, non-goals, constraints, acceptance criteria, references, risks, and unresolved decisions. Do not invent facts or start implementation.`,

  'hive-plan': `Create or revise one Hive plan from verified requirements and repository evidence. Preserve explicit non-goals and rejected alternatives. Make tasks independently executable with concrete dependencies, files, outcomes, and verification. Do not implement code.`,

  'approve-sync-plan': `Read the current plan and comments, approve only when review issues are resolved, sync tasks, then read back status. Suggest DAG-backed target task milestones and copy-paste run/continue prompts in Session Strategy. Report exact blockers instead of continuing on partial state.`,

  'start-execution': `Execute the approved plan through explicit tasks and ordinary native subagents. Create or inspect a task worktree when isolation is needed, capture its initial destination identity from the create result, and put the returned path and identities in the authored task prompt. Before dispatch, select the feature only if the selected route is unset or differs from the dispatch target, or the selection evidence below is missing or uncertain. Reuse a matching selection across a same-feature batch only when this session's most recent route-changing call visible in context is \`hive_feature_select\` for that same feature, with no later explicit-null or other-feature selection. When that evidence is not visible (for example after compaction or a summary, at session start, or in mixed ad-hoc/feature batches), or you are uncertain, call \`hive_feature_select\` for the dispatch target. Persist outcomes with hive_task_update. Verify before the primary calls hive_worktree_merge with the worker's unchanged source pin and inspected target expectation; use same-call cleanup when retention is not needed. After every returned native task result, launch a fresh child session for follow-up and reuse the same Hive task/worktree where appropriate. Pass task_id only when an explicit operator instruction or runtime-owned interruption-recovery mechanism authorizes continuation. Every invocation receives the current route snapshot.`,

  'council-directive': `Shape rough input into a reusable read-only council directive with objective, context, constraints, assumptions to validate, requested perspectives, and desired output. Do not launch councillors.`,

  council: `Run the configured read-only councillors that match the directive, then synthesize consensus, dissent, evidence quality, assumptions, and next action. Councillors must not edit files or mutate Hive state.`,

  'dash-review': `Run a read-only review over natural paths, inline material, the current checkout, or an operator-selected snapshot/worktree. Choose the smallest useful configured reviewer set and never silently skip an explicitly requested reviewer. Return severity-ordered findings, open questions, and review coverage. Do not edit source.`,

  'vuln-review': `Run a read-only vulnerability review over the requested source using ordinary tools. Dispatch every explicitly requested configured specialist. Report evidenced attacker-to-impact paths, root causes, confidence, affected locations, source identity, and evidence gaps. Preserve the source fingerprint when a Git snapshot is used. Do not edit source, exploit systems, or begin remediation.`,

  'compact-summary': `Summarize the visible session without mutating state. Use these sections in order: Goal; Constraints & Preferences; Progress; Key Decisions; Next Steps; Critical Context; Relevant Files. Include verification only when supported by command or tool evidence.`,
};
