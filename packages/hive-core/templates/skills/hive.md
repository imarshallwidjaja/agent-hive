---
name: hive
description: Plan-first AI development with managed worktree or in-place worker placement and human review. Use for any feature development.
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
| `forager-worker` | Subagent in both modes | Executes tasks in the placement selected by `hive_execution_prepare` |
| `hive-helper` | Subagent in both modes | Bounded merge recovery, state clarification, and safe manual follow-up |
| `plan-reviewer` | Subagent in both modes | Plan readiness review |
| `code-reviewer` | Subagent in both modes | Implementation review against plan |
| `simplicity-reviewer` | Subagent in both modes | Final post-implementation simplicity review |
| `approach-advisor` | Subagent in both modes | Read-only strategic approach advice |
| `vulnerability-reviewer` | Subagent in both modes | Read-only application-security review |

---

## Research Delegation (MCP Tools + Parallel Exploration)

Use MCP tools for focused research; for multi-domain exploration, use parallel researcher fan-out.

| Tool | Use For |
|------|---------|
| `grep_app_searchGitHub` | Find code in OSS repos |
| `context7_query-docs` | Library documentation |
| `websearch_web_search_exa` | Web search and scraping |
| `ast_grep_find_code` / `ast_grep_find_code_by_rule` | AST-aware code search |
| `task()` | Parallel exploration via researcher fan-out |

For exploratory fan-out, load the `parallel-exploration` skill for the full playbook.

---

## Intent Classification (Do First)

| Intent | Signals | Action |
|--------|---------|--------|
| **Trivial** | Single file, <10 lines | Do directly. No feature. |
| **Simple** | 1-2 files, <30 min | Quick questions → light plan or just do it |
| **Complex** | 3+ files, needs review | Full feature workflow |
| **Refactor** | "refactor", existing code | Safety: tests, rollback, blast radius |
| **Greenfield** | New feature, "build new" | Discovery: find patterns first |

**Don't over-plan trivial tasks.**

---

## Lifecycle

```
Classify Intent → Discovery → Plan → Review → Execute → Merge
                      ↑                           │
                      └───────── replan ──────────┘
```

---

## Phase 1: Discovery and Planning

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

After each exchange:
```
□ Core objective clear?
□ Scope boundaries defined?
□ No critical ambiguities?
□ Technical approach decided?

ALL YES → Write plan
ANY NO → Ask the unclear thing
```

---

## Phase 2: Plan

### Create Feature

```
hive_feature_create({ name: "feature-name" })
```

### Save Context

```
hive_context_write({
  name: "research",
  content: "# Findings\n- Pattern at src/lib/auth:45-78..."
})
```

### Write Plan

```
hive_plan_write({ content: "..." })
```

### Plan Structure (REQUIRED)

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

## Non-Goals (What we're NOT building)
- {Explicit exclusion}

## Ghost Diffs (Alternatives Rejected)
- {Approach}: {Why rejected}

---

## Tasks

### 1. {Task Title}

**Depends on**: none

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

## Success Criteria
- [ ] {Final checklist}
```

### Key Sections

| Section | Purpose |
|---------|---------|
| **Discovery** | Ground plan in user words + research |
| **Non-Goals** | Prevents scope creep |
| **Ghost Diffs** | Prevents re-proposing rejected solutions |
| **References** | File:line citations with WHY |
| **Must NOT do** | Task-level guardrails |
| **Acceptance Criteria** | Verifiable conditions |
| **Depends on** | Task execution order (optional) |

### Task Dependencies

The `**Depends on**:` annotation declares which tasks must complete before a task can start.

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

## Phase 3: Review

1. User reviews in VS Code
2. Check comments: `hive_plan_read()`
3. Revise if needed
4. User approves via: `hive_plan_approve()`

---

## Phase 4: Execute (Orchestrator)

### Sync Tasks

```
hive_tasks_sync()
```

### Execute Each Task

Choose the placement before dispatch:

- `worktree` uses an exact registered Git worktree identity. After stop evidence, `hive_execution_finish` may commit changes; `hive_merge` integrates the finalized task.
- `in_place` uses one resolved absolute existing directory. It is cooperative live editing with no Hive filesystem exclusion, Git isolation, rollback, commit, merge, or cleanup.

Worktree flow:

```
hive_execution_prepare({ scope: { kind: "task", task: "01-task-name" }, placement: { kind: "worktree" } })
task({
  subagent_type: "forager-worker",
  description: "Implement 01-task-name",
  prompt: "Primary-authored objective, evidence, constraints, and checks"
})
  ↓
[Worker implements in worktree and returns one terminal handoff]
  ↓
hive_execution_finish({ attemptId, status: "completed", summary, message })
  ↓
hive_merge({ task: "01-task-name", strategy: "squash", message: "feat: implement task outcome\n\nDescribe the integrated behavior and why it changed." })
```

In-place flow:

```
hive_execution_prepare({ scope: { kind: "task", task: "01-task-name" }, placement: { kind: "in_place", directory: "/absolute/existing/directory" } })
task({
  subagent_type: "forager-worker",
  description: "Implement 01-task-name",
  prompt: "Primary-authored objective, evidence, constraints, and checks"
})
  ↓
[Worker edits the live directory and returns one terminal handoff]
  ↓
hive_execution_finish({ attemptId, status: "completed", summary })
hive_status()
```

After exact native stop evidence, call `hive_execution_finish` before `hive_status()` or any continuation. Failed or partial recovery without exact stop evidence must trace or wait and keep the placement quarantined; do not finish or prepare a retry. Only a stopped attempt may be finalized. The persisted `hive_status` blocker or immutable finalization report is authoritative for blocked continuation; never reconstruct blocker details from worker prose or task traces. Blocked task continuation must reuse the prior finalized placement: exact registered worktree identities for `worktree`, or the exact resolved directory for `in_place`. Only finalized worktree attempts can be merged or cleaned up. A later in-place attempt on the same `runId` governs disposition and report state only and has no merge or cleanup lifecycle. Any later worktree prepare still binds to the historical worktree repository selection; repository IDs are normalized and deduplicated, and a different worktree selection requires a new `runId`.

### Parallel Execution

When multiple tasks have their dependencies satisfied (runnable), the orchestrator should ask the operator how to proceed:

```json
{
  "questions": [{
    "question": "Multiple tasks are ready. How should we proceed?",
    "header": "Parallel Execution",
    "options": [
      { "label": "Parallel", "description": "Run all ready tasks simultaneously" },
      { "label": "Sequential", "description": "Run one at a time for easier review" },
      { "label": "Pick", "description": "Let me choose which to run" }
    ]
  }]
}
```

Independent tasks may be prepared and dispatched under one parent. The same feature task stays serial until native terminal evidence.

```
hive_execution_prepare({ scope: { kind: "task", task: "02-task-a" }, placement: { kind: "worktree" } })
task({ subagent_type: "forager-worker", description: "Implement 02-task-a", prompt: "Primary-authored packet for 02-task-a" })
hive_execution_prepare({ scope: { kind: "task", task: "03-task-b" }, placement: { kind: "worktree" } })
task({ subagent_type: "forager-worker", description: "Implement 03-task-b", prompt: "Primary-authored packet for 03-task-b" })
hive_status()  // Monitor all
```

---

## Blocker Handling

When worker returns `status: 'blocked'`:

### Quick Decision (No Plan Change)

A blocked task continues in its existing worktree or in-place placement with a fresh worker session, but only after the stopped attempt is finalized:

1. Observe exact stop evidence
2. Finalize the stopped attempt: `hive_execution_finish({ attemptId, status: "blocked", summary, blocker })`; retain its authoritative immutable report
3. Call `hive_status()` and read the persisted blocker details; do not reconstruct them from worker prose
4. Ask the user via question tool and record the decision
5. Call `hive_status()` again; continue only while status is exactly blocked
6. Continue with the same placement kind and exact worktree identities or exact in-place directory: `hive_execution_prepare({ scope: { kind: "task", task, continueFromBlocked: true }, placement })`, then an unchanged native Forager `task()` whose prompt includes the operator decision

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
1. Confirm the stopped attempt was finalized and re-check `hive_status()`
2. Worktree placement: `hive_worktree_discard({ task })` only when the current attempt is armed or finalized. Discard is refused for attached, stopped, or unobserved claims.
3. In-place placement: do not discard. After finalization, `hive_task_update({ task, status: "pending" })`, then replan.
4. `hive_context_write({ name: "learnings", content: "..." })`
5. `hive_plan_write({ content: "..." })` (updated plan)
6. Wait for re-approval

---

## Tool Reference

| Phase | Tool | Purpose |
|-------|------|---------|
| Discovery | `grep_app_searchGitHub` / `context7_query-docs` / `task()` | Research delegation (parallel exploration) |
| Plan | `hive_feature_create` | Start feature |
| Plan | `hive_context_write` | Save research |
| Plan | `hive_plan_write` | Write plan |
| Plan | `hive_plan_read` | Check comments |
| Plan | `hive_plan_approve` | Approve plan |
| Execute | `hive_tasks_sync` | Generate tasks |
| Execute | `hive_execution_prepare` | Arm the next Forager dispatch |
| Finalize | `hive_execution_finish` | Persist primary disposition and release execution |
| Execute | `hive_worktree_discard` | Discard task |
| Execute | `hive_merge` | Integrate task |
| Execute | `hive_status` | Check workers/blockers |
| Complete | `hive_feature_complete` | Mark done |
| Status | `hive_status` | Overall progress |

---

## Iron Laws

**Never:**
- Plan without discovery
- Execute without approval
- Complete without verification
- Assume when uncertain - ASK
- Force through blockers that suggest plan gaps

**Always:**
- Match effort to complexity
- Include file:line references with WHY
- Define Non-Goals and Must NOT guardrails
- Provide verification commands
- Offer replan when blockers suggest gaps

---

## Error Recovery

### Task Failed
```
hive_execution_finish({
  attemptId,
  status: "failed",
  summary,
  ...(worktreeHasChanges ? { message: "fix: preserve failed task progress\n\nRecord the current worktree changes for the next worker attempt." } : {})
})
hive_status()  # Confirm finalization and current task state before retry.
hive_execution_prepare({ scope: { kind: "task", task }, placement: { kind: "worktree" } })  # Reuse the worktree; fresh arm. Do not discard failed work by default.
```

### After 3 Failures
1. Stop all workers
2. Ask the registered `approach-advisor` for read-only failure analysis: `task({ subagent_type: "approach-advisor", prompt: "Analyze failure..." })`
3. If the advisor is unavailable or the failure remains unresolved, ask the user how to proceed

### Merge Conflicts
1. Call `hive_merge({ task, strategy: "squash", message: "fix: integrate resolved outcome\n\nDescribe the integrated behavior.", preserveConflicts: true })` only when you intend to resolve a real conflict in the destination checkout.
2. If Hive reports `MERGE_CONFLICT_PRESERVED`, resolve and commit the preserved Git operation in that destination checkout.
3. Do not call `hive_merge` again while preserved conflict state is active. If Hive aborted the conflict instead, satisfy the returned recovery action and retry with a valid message.
