# Philosophy

Agent Hive is a plan-first workflow plugin for OpenCode. It coordinates independent workers through structure, shared state, isolation, and clear handoffs. The hive name is a coordination analogy, not a role taxonomy.

## Why this shape

Chat memory is ephemeral. Multi-step agent work fails when plans stay implicit, workers share one dirty tree, and "done" means a confident sentence instead of checked output.

Hive keeps the durable pieces on disk under `.hive/`. Its feature workflow calls for human approval before execution and uses isolated Git worktrees for tracked feature implementation. Ad-hoc tracked Git work has matching ad-hoc worktrees; direct-work exceptions cover non-Git and report-only work.

## Core principles

Aligned with the project agent guidelines:

1. **Context persists** - Write decisions and status to `.hive/` files; do not rely on chat alone.
2. **Plan → approve → execute** - Agents seek approval and sync tasks before feature implementation; the tools do not enforce this sequence as a dispatch gate.
3. **Human shapes, agent builds** - Operators set direction and accept risk; agents implement inside gates.
4. **Good enough wins** - Ship working increments; refine with follow-up tasks instead of infinite polish gates.
5. **Batched parallelism** - Independent tasks run in parallel; integration order stays explicit.
6. **Tests define done** - Workers run selected task checks; orchestrators run required checks at their stated boundary and verify applicable integrated behavior after merge before claiming completion.
7. **Review integrated security boundaries** - Cross-task security work needs whole-result review, not only task-local green checks.
8. **Tool exposure governs action** - Role tool access and each tool's validation bound operations; agent instructions govern workflow decisions such as approval and verification.
9. **Cross-model prompts** - Prefer conditional triggers over provider-specific absolute mandates.
10. **Deterministic contracts beat soft memory** - Prefer tools, schemas, and file state over prompt-only memory when reliability matters.

## Coordination model

| Piece | Role |
|-------|------|
| Operator | Sets direction, approves feature plans, answers blockers and decides unresolved risk |
| Planner / hybrid primary | Discovers requirements, writes `plan.md`, does not silently skip approval |
| Orchestrator / hybrid primary | Syncs tasks, launches workers, merges, tracks status |
| Worker | Implements the assigned feature task or ad-hoc goal in its matching worktree against the primary-authored native prompt |
| Researchers and reviewers | Read-only or bounded review seats; they do not own the feature lifecycle |
| `.hive/` | Shared durable state: plans, tasks, reports, session recovery metadata |

The name describes coordination. It does not define agent roles.

## References

Use the [root README documentation section](README.md#documentation) for current documentation ownership.
