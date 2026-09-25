---
name: hive
description: Plan-first AI development with Hive task and ad-hoc worktrees, human review, and direct tool-based integration. Use for feature development.
---

# Hive Workflow

Plan-first development with role-separated agents.

## Architecture

```
Unified primary (`hive-master`) plans and orchestrates
Dedicated planner (`architect-planner`) -> orchestrator (`swarm-orchestrator`)
Both modes -> researcher (`scout-researcher`) -> worker (`forager-worker`)
Review -> `plan-reviewer` / `code-reviewer` / `approach-advisor`
```

---

## Agents

| Agent | Mode | Use |
|-------|------|-----|
| `hive-master` | Unified primary | Planning and orchestration |
| `architect-planner` | Dedicated primary | Discovery and planning |
| `swarm-orchestrator` | Dedicated primary | Orchestration |
| `hive-builder` | Primary in both modes | Ad-hoc orchestration |
| `scout-researcher` | Subagent in both modes | Exploration, research, and retrieval |
| `forager-worker` | Subagent in both modes | Executes tasks in the chosen workspace |
| `hive-helper` | Subagent in both modes | Bounded merge recovery, state clarification, and safe manual follow-up |
| `plan-reviewer` | Subagent in both modes | Plan readiness review |
| `code-reviewer` | Subagent in both modes | Implementation review against plan |
| `simplicity-reviewer` | Subagent in both modes | Final post-implementation simplicity review |
| `approach-advisor` | Subagent in both modes | Read-only strategic approach advice |
| `vulnerability-reviewer` | Subagent in both modes | Read-only application-security review |

---

## Research Delegation and Parallel Exploration

Delegate research by operation, required source authority and freshness, bounded scope, and expected evidence. The child selects among capabilities exposed in its own session, which may differ from the parent's; do not prescribe provider or tool IDs. Use parallel researcher fan-out for independent slices.

For exploratory fan-out, load the `parallel-exploration` skill for the full playbook.

## Native Task Handoffs

Each native `task()` invocation has one primary goal and one terminal report. Every returned result is terminal, including completed, failed, empty, partial, blocked, unsatisfactory, review-remediation, retry, new-test-evidence, and operator-decision results. Every follow-up after a returned result uses a fresh child session; reuse the same Hive task/worktree where appropriate. Review findings are fresh assignments in the same implementation lane. Compaction re-anchoring of a currently running worker is distinct from follow-up work. Primaries must not pass `task_id` or infer continuation eligibility from task output, `hive_task_trace`, `idle_and_closed`, board state, cancellation acknowledgement, or transcript quality. Pass `task_id` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation; otherwise launch fresh. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer. Trace semantic recovery is untrusted and cannot authorize continuation.

---

## Intent Classification (Do First)

| Intent | Signals | Action |
|--------|---------|--------|
| **Small mechanical edit** | Clean checkout, no delegated writer or overlap | Direct edit when the repository-backed placement policy permits it |
| **Feature** | Plan and coordinated task outcomes needed | Plan, review, sync, and execute feature tasks |
| **Ad-hoc tracked write** | No feature task owns the work | Resolve repository scope and use a matching ad-hoc worktree |
| **Refactor** | "refactor", existing code | Safety: tests, rollback, blast radius |
| **Greenfield** | New feature, "build new" | Discovery: find patterns first |

Use direct checkout only for a small mechanical edit on a clean checkout without delegated writers or overlap, an explicit request to continue specific uncommitted changes after checking scope, non-Git/report-only/external-only work, or work already in the matching Hive worktree.

---

## Lifecycle

```
Feature: Classify Intent → Discovery → Plan → Review → Execute → Merge
                               ↑                           │
                               └───────── replan ──────────┘
```

---

## Discovery and Planning

### Research First (Greenfield/Complex)

For parallel exploration, load the `parallel-exploration` skill.

### Question Tool

```json
{
  "questions": [{
    "question": "What authentication should we use?",
    "header": "Auth Strategy",
    "options": [
      { "label": "JWT", "description": "Token-based, stateless" },
      { "label": "Session", "description": "Cookie-based, server state" }
    ]
  }]
}
```

### Self-Clearance Check

Before writing a plan:
```
□ Core objective clear?
□ Scope boundaries defined?
□ No critical ambiguities?
□ Technical approach decided?

ALL YES → Write plan
MATERIAL GAP → Ask the question that changes the outcome
```

---

## Plan

### Create Feature

```
hive_feature_create({ name: "feature-name" })
hive_feature_select({ feature: "feature-name" })
```

### Save Context

Use `hive_context_read` to choose the feature or project scope and check existing content. New context files use `hive_context_write`; replacements require the read revision and content hash. Write evidence-only notes with `kind: 'evidence'`; the catalog lists durable files, while named reads can retrieve evidence files.

```
hive_context_write({
  name: "research",
  kind: "evidence",
  content: "# Findings\n- Pattern at src/lib/auth:45-78..."
})
```

### Write Plan

```
hive_plan_write({ content: "..." })
```

### Plan Structure

Keep a readable design summary before `## Tasks`. `hive_tasks_sync` parses numbered tasks under `## Tasks` only. Add sections that serve the plan; the following is a starting shape, not a required schema.

Inside `## Tasks`, every `###` heading is a numbered task (`### N. Title`); use `####` for subsections within a task. To amend a task, rewrite it with `hive_plan_patch` `replace_task` and put the amendment in a `####` subsection. Put shared notes outside `## Tasks`. Patches that add an unnumbered `###` inside `## Tasks` are rejected, and approval is blocked while one remains. To repair an existing unnumbered heading, rewrite `## Tasks` with one `replace_section` (`headingPath: ["Tasks"]`) that folds each amendment into its owning task as a `####` subsection or moves shared notes outside `## Tasks`; a `replace_task` cannot rewrite an orphan heading because it stops at the next `###`.

```markdown
# {Feature Title}

## Discovery

### Original Request
- "{User's exact words}"

### Interview Summary
- {Point}: {Decision}

### Research Findings
- `{file:lines}`: {Finding}

---

## Tasks

### 1. {Task Title}

**Depends on**: none

**Repos**: {repo ID or comma-separated IDs when a repository manifest applies}

**What to do**:
- {Implementation step}

**Must NOT do**:
- {Task guardrail}

**References**:
- `{file:lines}` — {WHY this reference}

**Acceptance Criteria**:
- [ ] {Verifiable outcome}
- [ ] Run: `{command}` → {expected}

---

## Final Verification
- [ ] {Checks spanning the integrated feature}
```

### Key Sections

| Section | Purpose |
|---------|---------|
| **Discovery** | Ground plan in user words + research |
| **Final Verification** | Record integrated checks without creating execution tasks |
| **References** | File:line citations with WHY |
| **Must NOT do** | Task-level guardrails |
| **Acceptance Criteria** | Verifiable conditions |
| **Depends on** | Task execution order (optional) |

### Task Dependencies

The `**Depends on**:` annotation records task ordering for the execution plan and `hive_status`. It is not a runtime dispatch gate.

| Syntax | Meaning |
|--------|---------|
| `**Depends on**: none` | No dependencies — can run immediately or in parallel |
| `**Depends on**: 1` | Depends on task 1 |
| `**Depends on**: 1, 3` | Depends on tasks 1 and 3 |
| *(omitted)* | Implicit sequential — depends on previous task (N-1) |

**Default behavior**: When no `**Depends on**:` annotation is present, the task implicitly depends on the previous task (task N depends on task N-1). This preserves backwards compatibility with existing plans.

**Example**:
```markdown
### 1. Set up database schema
**Depends on**: none
...

### 2. Create API endpoints
**Depends on**: 1
...

### 3. Add authentication
**Depends on**: 1
...

### 4. Build UI components
**Depends on**: 2, 3
...
```

In this example, tasks 2 and 3 can run in parallel (both only depend on 1), while task 4 waits for both.

---

## Review

1. User reviews in VS Code
2. Check comments: `hive_plan_read()`
3. Revise bounded sections with `hive_plan_patch({ expectedRevision, operations })` using the revision from `hive_plan_read`; use `hive_plan_write` for a major rewrite. Both clear every plan review thread and revoke approval.
4. After the user's approval, call `hive_plan_approve()`

---

## Execute (Orchestrator)

### Sync Tasks

```
hive_tasks_sync()
```

### Execute Each Task

Choose the placement before dispatch:

- Tracked Git writes use the matching task worktree from `hive_worktree_create`.
- Non-Git or report-only work may use an explicit existing target and has no Hive Git lifecycle.
- Tracked work without a feature task uses `hive_repositories_status` to resolve scope and the matching `hive_adhoc_worktree_*` lifecycle. Ad-hoc runs do not appear in `hive_status` and do not create task reports.

When ad-hoc work has multiple outcomes, dependency waves, shared resources, or likely follow-up attempts, load `orchestrating-ad-hoc-work` before dispatch or worktree creation. Use `dispatching-parallel-agents` for independent lanes. If background subagents are enabled and useful foreground work can continue, load `background-delegation`; otherwise native `task()` calls block. Each child loads any operator-required skills named in its handoff or inherited standing constraints for itself before the covered work.

For a tracked ad-hoc lane, choose a concise kebab-case `runId` from its goal, such as `design-doc-review`, because it becomes the Git branch suffix. After resolving repository ownership, create with `hive_adhoc_worktree_create({ runId: "design-doc-review", repoIds })`. Reuse that `runId` for inspect, merge, and cleanup. Inspect with `hive_adhoc_worktree_inspect({ runId, repoIds })` before dispatch and retain the returned target identity. The assigned worker commits locally and returns `sourceCommit` or a complete `sourceCommits` map. Reinspect the target, then integrate with `hive_adhoc_worktree_merge({ runId, repoIds, sourceCommit, expectedTarget, strategy: "squash", message })` in legacy single-root mode, or use `sourceCommits` and `expectedTargets` for composites. After successful integration, call `hive_adhoc_worktree_cleanup({ runId, repoIds })`. A foreign checkout uses absolute `sourceDirectory` instead of `repoIds`.

Worktree flow:

```
hive_worktree_create({ feature: "feature-name", task: "01-task-name" })
[Inspect the worktree now: hive_worktree_inspect({ feature: "feature-name", task: "01-task-name" }); retain the target identity and pass it in the handoff]
hive_feature_select({ feature: "feature-name" })
task({
  subagent_type: "forager-worker",
  description: "Implement 01-task-name",
  prompt: "Hive task: 01-task-name\n\nPrimary-authored objective, workspace, inspected target identity, evidence, constraints, and checks"
})
  ↓
[Worker commits changes and returns sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present]

hive_worktree_inspect({ task: "01-task-name" })
[Reinspect source and destination after the worker returns; compare the target to the identity captured before dispatch. Composites use each repos[id].target]
  ↓
// Legacy single-root workspace:
hive_worktree_merge({ task: "01-task-name", sourceCommit, expectedTarget, strategy: "squash", message: "feat: implement task outcome\n\nDescribe the integrated behavior and why it changed." })
// Composite workspace with persisted repos:
hive_worktree_merge({ task: "01-task-name", sourceCommits, expectedTargets, strategy: "squash", message: "feat: implement task outcome\n\nDescribe the integrated behavior and why it changed." })
  ↓
hive_task_update({ task: "01-task-name", status: "done", summary, report })
  ↓
hive_worktree_cleanup({ task: "01-task-name" })
```

Inspect before dispatch and retain the destination's canonical path, full ref or detached null, and commit. Reinspect after each writing handoff, before review or remediation, after known sibling integration or destination movement, and before final integration. After the worker returns, inspect its worktree. Pass its topology-aware source pin plus the unchanged inspected `expectedTarget` or complete `expectedTargets` map to merge before marking the feature task done. Use the identity from the inspection before the latest writing dispatch, or the target identity returned by a reconciliation worker; never silently refresh it from a later inspection. Use complete maps when persisted `repos` are present; singleton composites accept matching scalar conveniences.

Relevant or uncertain destination drift requires same-worktree reconciliation by a fresh worker after the prior writer is terminal. Merge the pinned target commit normally, adapt and review the combined delta, verify it, and return fresh source pins and target identity. Disjoint untracked or ignored destination files may remain when the pinned source contains the pinned target history; rebase also requires a linear replay range. If merge returns `TARGET_RECONCILIATION_REQUIRED` with `reconcile_target`, reconcile in the source worktree and return fresh pins without deleting Hive state, dependencies, build output, or user files. Staged, unstaged tracked, unmerged, active-operation, and incoming-path collision state blocks merge. Hive preflight and rechecks protect local data without relying on Git merge flags.

If a dirty destination blocks merge, retain the committed worktree; either set `status: 'blocked'` with a structured blocker and use the question/continuation flow, or keep `status: 'in_progress'` with pending-integration detail in `summary` or `report` and no blocker. Ad-hoc work reports integration pending and retains its run. Non-Git or report-only work has no Hive merge step; verify its target before recording completion. Never reconstruct blocker details from worker prose. Do not call `hive_worktree_merge` again while preserved conflict state is active. The same rule applies to `hive_adhoc_worktree_merge`; resolve and commit the preserved Git operation before retrying either tool. Git helpers do not change task status, auto-commit source, or assign workers.

### Parallel Execution

Dependencies guide sequencing; they are not a dispatch admission gate. When the operator gives an explicit direction (parallel, sequential, or a subset), follow it. Otherwise sequence from dependencies and disjoint worktrees.

Independent tasks may be created and dispatched under one parent.

```
hive_worktree_create({ feature: "feature-name", task: "02-task-a" })
[Inspect and record 02-task-a target identity before dispatch]
hive_feature_select({ feature: "feature-name" })
task({ subagent_type: "forager-worker", description: "Implement 02-task-a", prompt: "Hive task: 02-task-a\n\nPrimary-authored assignment for 02-task-a" })
hive_worktree_create({ feature: "feature-name", task: "03-task-b" })
[Inspect and record 03-task-b target identity before dispatch]
hive_feature_select({ feature: "feature-name" })
task({ subagent_type: "forager-worker", description: "Implement 03-task-b", prompt: "Hive task: 03-task-b\n\nPrimary-authored assignment for 03-task-b" })
hive_status()  // Read task and worktree state; observe background calls with hive_background_status when enabled
```

---

## Blocker Handling

When worker returns `status: 'blocked'`:

### Quick Decision (No Plan Change)

A blocked task continues in its existing workspace with a fresh worker session:

1. `hive_task_update({ task, status: "blocked", blocker: { reason, options, recommendation, context } })`
2. Call `hive_status()` for task state and inspect the task's `status.json` for the persisted blocker details; do not reconstruct them from worker prose
3. Ask the user via question tool and record the decision
4. `hive_task_update` with an explicit status leaving blocked, which clears the blocker
5. Launch a fresh native Forager `task()` in the same workspace with the operator decision and current target identity in its prompt

### Plan Gap Detected

If blocker suggests plan is incomplete:

```json
{
  "questions": [{
    "question": "This suggests our plan may need revision. How proceed?",
    "header": "Plan Gap Detected",
    "options": [
      { "label": "Revise Plan", "description": "Go back to planning" },
      { "label": "Quick Fix", "description": "Handle as one-off" },
      { "label": "Abort Feature", "description": "Stop entirely" }
    ]
  }]
}
```

If "Revise Plan":
1. Re-check `hive_status()` and inspect any existing worktree. Preserve committed but unintegrated work; cleanup requires a safe integrated state or an explicit decision to delete the branch with `deleteBranch: true, discard: true`. `discard: true` alone leaves the branch and its commits intact.
2. For non-Git or report-only placement, `hive_task_update({ task, status: "pending" })` when returning the task to pending.
3. Revise the plan with `hive_plan_patch` from a current revision or `hive_plan_write` for a major rewrite.
4. Obtain user approval and run `hive_tasks_sync({ refreshPending: true })` when pending task scope, sequencing, or dependencies changed.

---

## Tool Reference

| Phase | Tool | Purpose |
|-------|------|---------|
| Discovery | `task()` | Capability-based research delegation and parallel exploration |
| Plan | `hive_feature_create` | Start feature |
| Plan | `hive_context_write` | Save research |
| Plan | `hive_plan_write` | Write plan |
| Plan | `hive_plan_patch` | Revise bounded plan sections against a revision |
| Plan | `hive_plan_read` | Check comments |
| Plan | `hive_plan_approve` | Approve plan |
| Execute | `hive_tasks_sync` | Generate tasks |
| Execute | `hive_worktree_create` | Create a task worktree |
| Execute | `hive_worktree_inspect` | Capture and compare source and target identities |
| Execute | `hive_task_update` | Record status, summary, blocker, report, or successor handoff |
| Execute | `hive_worktree_merge` | Integrate task |
| Execute | `hive_worktree_cleanup` | Remove a task worktree |
| Execute | `hive_adhoc_worktree_create`, `hive_adhoc_worktree_inspect`, `hive_adhoc_worktree_merge`, `hive_adhoc_worktree_cleanup` | Tracked ad-hoc lifecycle |
| Execute | `hive_status` | Check feature task and worktree state |
| Complete | `hive_feature_complete` | Mark done |
| Status | `hive_status` | Overall progress |

---

## Iron Laws

**Never:**
- Skip material discovery before committing to a feature plan
- Execute a feature plan before the user approves it
- Treat approval or dependency status as a runtime dispatch gate; resolve real prerequisites before assigning affected lanes
- Complete without verification
- Guess when a material decision remains unresolved
- Force through blockers that suggest plan gaps

**Always:**
- Match effort to complexity
- Include file:line references with WHY
- State material scope boundaries and task guardrails
- Provide verification commands
- Load `verification` before claiming work is complete or passing
- Offer replan when blockers suggest gaps

---

## Error Recovery

### Task Failed
```
hive_task_update({ task, status: "failed", summary, report })
hive_status()  # Confirm current task and registered-worktree state.
// Before a fresh worker call, use hive_worktree_inspect for source and target identity, diagnose the failure, and retain the existing task/worktree. Select its feature immediately before dispatch.
task({ subagent_type: "forager-worker", description: "Retry", prompt: `Hive task: ${task}\n\nSelf-contained retry with workspace, target identity, failure evidence, and done criteria` })
```

Non-Git or report-only retry has no Hive merge, cleanup, rollback, or commit step.

### After 3 Failures
1. Stop editing the failed lane and retain its evidence and worktree state. Unrelated lanes can continue if their ownership is disjoint.
2. If independent advice would help, ask the registered `approach-advisor` for read-only analysis: `task({ subagent_type: "approach-advisor", description: "Analyze failed lane", prompt: "Analyze the failure evidence and return options" })`.
3. Ask the user for the material decision when the failure remains unresolved.

### Merge Conflicts
1. Inspect source and destination, including current target identity. For relevant drift, reconcile in the registered source worktree with a fresh worker and return fresh pins and target identity.
2. Use `preserveConflicts: true` only when deliberately resolving a real merge conflict in the destination. For `merge` and `squash`, supply the source pin, expected target identity, strategy, and aggregate message; omit `message` for `rebase`.
3. If Hive reports `MERGE_CONFLICT_PRESERVED`, resolve and commit the preserved Git operation there. Do not retry `hive_worktree_merge` or `hive_adhoc_worktree_merge` until that operation is resolved and committed. Otherwise follow the returned recovery action before retrying.
