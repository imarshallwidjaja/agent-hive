export const REPOSITORY_WORKTREE_POLICY_PROMPT = `## Repository-backed placement

Before a non-trivial writing lane, resolve repository ownership. For ad-hoc execution, call \`hive_repositories_status\` once at the start of each execution batch unless repository scope is already explicit, then reuse that result. Pass only the returned repository IDs owned by the current lane; use all returned IDs only for genuinely cross-repository work. Feature-task execution may reuse declared task repositories.

For tracked Git writes, use the matching Hive worktree: the feature-task worktree when a task exists, and an ad-hoc worktree otherwise. If worktree creation fails, correct the invocation or report the blocker; never fall back to the canonical checkout. A worktree implementation assignment explicitly authorizes the worker to commit assigned changes. A single-repository worker returns the exact \`sourceCommit\` SHA; a composite worker returns the complete \`sourceCommits\` map keyed by repository ID. Pass the returned scalar or map unchanged to the matching merge tool. In-place and diagnosis-only missions do not authorize commits. Git helpers do not auto-commit source; integration is a separate local commit and grants no push, PR, publish, or release authority.

Complete each worktree lane by verifying, inspecting status and diff, merging by default with squash, and cleaning up after successful integration. For a feature task, mark it done only after the merge succeeds. If a dirty destination blocks merge, retain the committed worktree; either set \`status: 'blocked'\` with a structured blocker and use the question/continuation flow, or keep \`status: 'in_progress'\` with pending-integration detail in \`summary\` or \`report\` and no blocker. For ad-hoc work, report integration pending and retain the run. Use direct checkout only for an explicit operator request to continue specific existing uncommitted changes plus confirmation that the scoped edit will not overwrite unrelated changes, a small mechanical edit on a clean checkout without delegated writers or overlap, non-Git/report-only/external-only work, or work already inside the matching Hive worktree. A dirty checkout alone does not justify direct checkout.`;

export const PROCESS_JUDGMENT_PROMPT = `## Process Judgment

Before creating work, blockers, or workflow state:

- Distinguish operator requirements, applicable project constraints, specialist advice or findings, and agent-chosen procedure.
- Preserve binding requirements, deterministic safety gates, role contracts, phase routing, direct-work and delegation boundaries, and each specialist's output contract.
- Synthesize advice and findings for relevance, evidence, conflicts, and named risk; only actionable conclusions become work or blockers.
- Reassess agent-chosen procedure when it creates churn or delay without reducing a named risk, but never waive those boundaries.`;
