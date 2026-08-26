---
name: writing-plans
description: "Agent Hive workflow skill for turning requirements into an approved Hive implementation plan before code changes."
---

# Writing Plans

## Purpose

Write an executable plan for a capable engineer who lacks the planning session's context. Ground it in repository evidence and the requested behavior. Carry forward call-site contracts, ownership boundaries, constraints, acceptance criteria, verification, and any justified preparatory refactoring.

During planning, implementation files remain read-only; Hive planning state may be written with `hive_feature_create`, `hive_plan_write` or `hive_plan_patch`, and `hive_context_write`. Do not open implementation worktrees. Use `hive_plan_patch` with the revision from `hive_plan_read` for bounded amendments. If sequencing, dependencies, or scope changes after tasks exist, record the required refresh in the planning handoff. The orchestrator performs `hive_tasks_sync({ refreshPending: true })` after review or approval.

## Planning Standard

- Cite repository evidence as `file:line` references and explain why each reference matters.
- State requested behavior and call-site contracts, including inputs, outputs, errors, side effects, and caller-visible risk policy where relevant.
- Identify ownership boundaries and the design knowledge each affected module should own or hide.
- Record constraints, non-goals, must-not-do guardrails, and assumptions that affect correctness or scope.
- State the context-selected testing strategy for each behavior: TDD when examples discover a contract, algorithm, or regression; characterization tests before poorly understood legacy changes; tests alongside or after implementation when design needs exploration or behavior is clear; existing contract coverage for a pure internal refactor; or proportionate no-new-test verification with concrete rationale. Ask only when repository evidence and requirements leave a material choice unresolved. Keep tests with their implementation task by default.
- Include bounded behavior-preserving preparatory refactoring only when it directly lowers risk for the requested outcome. Mark it separately from behavior change and say how preservation is checked.
- Code snippets only when exact syntax removes material ambiguity. Describe contracts and observable outcomes instead of transcribing the implementation.
- Use durable domain names. Planning phases, option labels, task numbers, and ticket language do not belong in lasting code names.

## Worker-Branch Task Granularity

Numbered tasks are coordination boundaries, not module boundaries. One task can cover tightly coupled code, tests, docs, and generated artifacts when they share one outcome and owner. Split by dependency, path ownership, verification boundary, or independently deliverable behavior. Reads, commands, and commits are steps inside a task. A typical plan has roughly 3-12 tasks; larger plans need grouping or justification.

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
- [Testing strategy and any justified preparatory refactoring]
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
- Context files hold durable notes that help later workers, not duplicated plan text.

## Handoff

After saving the plan, ask whether to consult `plan-reviewer`. Then offer execution through the current orchestrator or a separate session using `executing-plans`. The orchestrator owns task synchronization and execution; the plan does not prescribe a universal commit cadence or test ritual beyond the selected strategy.
