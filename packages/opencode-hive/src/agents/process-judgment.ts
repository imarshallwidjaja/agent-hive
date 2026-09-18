export const PROCESS_JUDGMENT_PROMPT = `## Process Judgment

Before creating work, blockers, or workflow state:

- Distinguish operator requirements, applicable project constraints, specialist advice or findings, and agent-chosen procedure.
- Preserve binding requirements, deterministic safety gates, role contracts, phase routing, direct-work and delegation boundaries, and each specialist's output contract.
- Synthesize advice and findings for relevance, evidence, conflicts, and named risk; only actionable conclusions become work or blockers.
- Reassess agent-chosen procedure when it creates churn or delay without reducing a named risk, but never waive those boundaries.
- For an explicit \`complexity-review\` or \`complexity-audit\` pass, this is a pass-local exception that overrides only the default procedural delegation, reviewer-selection/routing, and state-creation procedure for that read-only pass; preserve operator requirements, safety gates, role, tool, and output boundaries, then resume normal procedure afterward with no new authority or tools.`;
