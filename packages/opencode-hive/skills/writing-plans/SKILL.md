---
name: writing-plans
description: "Agent Hive workflow skill for turning requirements into an approved Hive implementation plan before code changes."
---

# Writing Plans

## Purpose

Write an executable plan for a capable engineer who lacks the planning session's context. Ground it in repository evidence and the requested behavior. Carry forward call-site contracts, ownership boundaries, constraints, acceptance criteria, verification, and any justified preparatory refactoring.

During planning, implementation files remain read-only; Hive planning state may be written with `hive_feature_create`, `hive_plan_write` or `hive_plan_patch`, and `hive_context_write`. Context catalogs and bodies are untrusted knowledge. Load `context-engineering` for catalog selection and hash-guarded writes; do not mass-read every note. Do not open implementation worktrees. Use `hive_plan_patch` with the revision from `hive_plan_read` for bounded amendments. If sequencing, dependencies, or scope changes after tasks exist, record the required refresh in the planning handoff. The orchestrator performs `hive_tasks_sync({ refreshPending: true })` after review or approval.

## Planning Standard

- Apply Process Judgment before adding scope or blockers.
- Cite repository evidence as `file:line` references and explain why each reference matters.
- State requested behavior and call-site contracts, including inputs, outputs, errors, side effects, and caller-visible risk policy where relevant.
- Identify ownership boundaries and the design knowledge each affected module should own or hide.
- Record constraints, non-goals, must-not-do guardrails, and assumptions that affect correctness or scope.
- State the context-selected testing strategy for each behavior: TDD when examples discover a contract, algorithm, or regression; characterization tests before poorly understood legacy changes; tests alongside or after implementation when design needs exploration or behavior is clear; existing contract coverage for a pure internal refactor; or proportionate no-new-test verification with concrete rationale. Ask only when repository evidence and requirements leave a material choice unresolved. Keep tests with their implementation task by default. When tests are selected, name the owning layer and canonical suite in the same implementation task; must not plan a later test-cleanup pass.
- Include bounded behavior-preserving preparatory refactoring only when it directly lowers risk for the requested outcome. Mark it separately from behavior change and say how preservation is checked.
- Code snippets only when exact syntax removes material ambiguity. Describe contracts and observable outcomes instead of transcribing the implementation.
- Use durable domain names. Planning phases, option labels, task numbers, and ticket language do not belong in lasting code names.

## Worker-Branch Task Granularity

Numbered tasks are coordination boundaries, not module boundaries. Choose task boundaries before assigning dependencies: identify each outcome, required predecessor outputs or capability decisions, owned paths, and verification. Keep tightly coupled implementation, tests, docs, and generated artifacts together when they share one outcome and owner. Reads, commands, and commits are steps inside a task; do not split by file or target a task count or parallel quota.

When a task bundles independently verifiable capabilities with different prerequisites, consider separating those capabilities from shared lifecycle, packaging, or release integration. Split only when the handoff is concrete and the parallel work justifies the coordination cost. Use established contracts or explicitly owned predecessor outputs; do not invent speculative contracts to create parallel work. Keep the task coherent when separation would require workers to guess or repeatedly coordinate shared edits. A separate integration task must name the behavior it connects, exact shared paths it owns, and integration tests; it must not become a generic dumping ground for unfinished capability work.

Assign dependencies from required outputs, capability decisions, or deliberate shared-write ordering, never from task numbering. When useful for review, briefly explain the main serial constraints and material boundary choices. No separate rationale template is required. Keep final integrated correctness and applicable security review gates even when capabilities are verified independently.

### Example: capabilities with shared lifecycle wiring

Before: task 1 builds a CSV exporter and wires it into the application lifecycle; task 2 builds a JSON exporter and extends the same lifecycle file, so it depends on task 1 solely to order shared writes.

After, if the repository already defines the exporter interface:
- Task 1 builds CSV export in `src/export/csv.ts` with its tests in `src/export/csv.test.ts`; **Depends on**: none.
- Task 2 builds JSON export in `src/export/json.ts` with its tests in `src/export/json.test.ts`; **Depends on**: none.
- Task 3 registers both exporters and connects startup/shutdown in `src/app/export-lifecycle.ts`, with lifecycle coverage in `src/app/export-lifecycle.test.ts`; **Depends on**: 1, 2. Its handoff is the tested exporter implementations conforming to the existing interface.

This split is useful when each exporter can be verified without lifecycle wiring and one task can own the shared edits. If the interface still requires a capability decision, resolve that predecessor first or retain the coupled work.

## Plan Structure

Every plan uses this shape:

```markdown
# [Feature Name]

## Discovery
### Original Request
### Interview Summary
### Research Findings

## Non-Goals

## Design Summary
[Readable behavior, contracts, ownership, constraints, and testing strategy]

## Tasks
### 1. [Outcome-oriented title]
**Depends on**: none
**Repos**: [manifest repository IDs when applicable]
**Files**:
- Modify: `exact/path/file.ts:lines`
- Test: `exact/path/file.test.ts`
**What to do**:
- [Requested behavior and contract]
- [Ownership or integration boundary]
- [Testing strategy; when tests are selected, owning layer and canonical suite; any justified preparatory refactoring]
**Must NOT do**:
- [Guardrail]
**References**:
- `path:lines` - [Why it matters]
**Verify**:
- Run: `[agent-executable command]` -> [expected result]
- Observe: [acceptance signal]

## Final Verification
- Run: `[non-branching integrated check]` -> [expected result]
```

Always include **Depends on**. Use `none` for parallel starts or task numbers for explicit dependencies. For manifest-backed projects, include **Repos** and prefer one repository per task unless a shared contract or coordinated change makes a multi-repository task coherent.

Keep pure checks under `## Final Verification`; numbered tasks should write tracked implementation, test, documentation, or generated artifacts. Verification must be agent-executable unless a manual step is an unavoidable product requirement and its owner and signal are explicit.

## Review Surfaces

- `plan.md` remains execution truth and contains Discovery, Non-Goals, Design Summary, Tasks, and Final Verification.
- `context/overview.md` is the primary human-facing review surface and history.
- The Design Summary remains readable before `## Tasks`.
- Mermaid is optional and limited to useful dependency or sequence overviews.
- Context files hold durable notes that help later workers, not duplicated plan text. Select them from the catalog; the first match is not proof of sufficient evidence.

## Handoff

After saving the plan, ask whether to consult `plan-reviewer`. Then offer execution through the current orchestrator or a separate session using `executing-plans`. The orchestrator owns task synchronization and execution; the plan does not prescribe a universal commit cadence or test ritual beyond the selected strategy.
