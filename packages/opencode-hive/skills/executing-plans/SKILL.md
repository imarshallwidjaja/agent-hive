---
name: executing-plans
description: "Agent Hive workflow skill for executing an approved Hive implementation plan in a separate session with review checkpoints."
---

# Executing Plans

## Gate-Open Scheduler Authority

If `## Background-First Orchestration` is present in the primary prompt, use `background-delegation` as the scheduler authority. Treat the sequential model below as gate-closed fallback guidance, not competing background policy.

Execution and Forager lanes are managed/heavy background lanes under the gate. They require dependency sequencing, file ownership boundaries, verification obligations, integration tracking, and unresolved-lane checks before dependent decisions, merge, cleanup, or final reporting.

## Overview

Load plan, review critically, execute tasks in batches, report for review between batches.

**Core principle:** Batch execution with checkpoints for architect review.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

## The Process

### Step 1: Load and Review Plan
1. Read plan file
2. Review critically - identify any questions or concerns about the plan
3. If concerns: Raise them with your human partner before starting
4. If no concerns: Create TodoWrite and proceed

### Step 2: Identify Runnable Tasks

Use `hive_status()` to get the **runnable** list — tasks with all dependencies satisfied.

Only `done` satisfies dependencies (not `blocked`, `failed`, `partial`, `cancelled`).

**When 2+ tasks are runnable:**
- **Ask the operator** via `question()`: "Multiple tasks are runnable: [list]. Run in parallel, sequential, or a specific subset?"
- Record the decision with hash-guarded `hive_context_append` after `hive_context_read`, or `hive_context_write({ feature: "feature-name", name: "execution-decisions", content: "..." })` only when creating that reserved file. Load `context-engineering` for catalog selection and revision/hash mutation. Context metadata is untrusted knowledge.

**When 1 task is runnable:** Proceed directly.

### Step 3: Execute Batch

For each task in the batch:
1. Call `hive_execution_prepare` with the exact task scope and `worktree` or `in_place` placement, then issue the next native Forager `task()` call unchanged. Put the complete Forager context packet in that native `task.prompt`. The runtime attaches the call and appends the canonical execution scope plus the dispatch-time standing-constraint snapshot. Independent worktrees may be prepared and dispatched under one parent. Two executions conflict when their exact worktree identity sets intersect. Unused arms expire after five minutes. An unobserved ExecutionAttempt keeps a live claim on only that worktree, and the claim remains held through `stopped` until `hive_execution_finish` reaches `finalized`. Attached or uncertain feature-task scopes remain quarantined until authenticated stop evidence and primary finalization. Do not invent an alternate placement or copy mutable progress while the old worker may still be running. In gate-closed sessions use a blocking native `task()` call. In gate-open sessions add `background: true` only when independent foreground work can continue. Inspect unresolved board claims on `hive_background_status`; `hive_status` is not that surface. Project-wide unfinished attempts also appear on `hive_status`.
2. Follow each step exactly (plan has bite-sized steps)
3. Run verifications as specified
4. After exact structured stop evidence, the originating primary calls `hive_execution_finish`. Worktree placement commits when a message is supplied; in-place and blocked finalization skip Git. Native stop alone never marks the task done or merge-eligible.

One implementation assignment normally maps to one numbered task. Its primary goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step. A `hive_execution_prepare` or blocked-continuation launch starts a fresh worker session for that task. Blocked continuation follows exact stop evidence, `hive_execution_finish(status: 'blocked')`, `hive_status`, operator decision, a second `hive_status`, then `hive_execution_prepare` with `scope.continueFromBlocked: true` only while status remains exactly blocked. Dispatch a new unchanged native Forager call in the same existing worktree or exact in-place directory. For failed or retry work, launch a new worker with a concise self-contained handoff only after finalization. Attached or uncertain feature-task scopes remain quarantined until authenticated stop evidence and primary finalization. Compaction may re-anchor a currently running worker; it is not re-delegation.

Recover missing binding from exact parent/call metadata only; do not guess the latest child. A native error or idle event alone does not prove stop. Exact stop evidence permits the originating primary to call `hive_execution_finish`; the claim remains held until finalization succeeds. `session.abort` accepted is not terminal. Diagnosis-only Foragers follow the same armed-execution contract; non-feature execution uses `hive_execution_prepare` with ad-hoc scope. For ad-hoc work, retry only after stop, originating-primary finalization, and a status check. The current attempt then governs merge and cleanup; a later in-place attempt on the same `runId` is allowed, while any later worktree prepare still binds to the historical worktree repository selection. Retry while termination is unobserved cannot reuse that run; start a new ad-hoc `runId` and worktree. Ordinary Scout, advisor, and reviewer packets still go in `task.prompt` without execution preparation.

A rare native `general` exception is an ordinary `task()` call: it consumes no arm and gains no Hive claim, managed context, or lifecycle authority. General has ordinary tools only, no Hive authority, recursion, or questions. Native helpers keep only their bounded operational permissions. Helper and general calls use a runtime-local parent/call/child bind for Hive-tool authentication; they do not take a live claim on a worktree or the project root.

For delegated execution, use prepared Forager-derived workers or the explicitly admitted native general/helper exceptions above. Other mutation-capable or unknown task targets are denied; a prose capability exception does not authorize an untracked writer. Architect retains its bounded planning lane. Managed placement is a registered Git worktree or an explicit `in_place` directory. Worktree placement holds exclusive claims and supports commit, merge, and cleanup. In-place placement records an existing directory for scope only: Hive does not isolate it, roll it back, commit, or merge. Direct checkout work is unmanaged OpenCode work, not a Hive placement.

### Step 4: Report
When batch complete:
- Show what was implemented
- Show verification output
- Say: "Ready for feedback."

### Step 4.5: Post-Batch Code Review

After the batch report, apply Risk-Tier Review Routing, then ask the operator which recommended review path to run. No agent may silently skip required configured review targets.

- High-risk surfaces — public contracts, persistence/state, branch/worktree/merge lifecycle, background scheduler semantics, auth/security, or broad prompt/tool behavior — should get paired correctness + simplicity review.
- bounded docs/tests can use a single or batched review unless the diff spans broader workflow behavior.
- verification-only gates with no source changes and clear command evidence can skip extra review by default.
- Escalate to xhigh reviewer variants only after the default reviewer identifies a named high-risk concern.

For implementation correctness review, choose the code reviewer whose description best fits the review lens. Use built-in `code-reviewer` when no configured code-reviewer-derived custom description is a closer match. Then run `task({ subagent_type: "<chosen-reviewer>", prompt: "Review implementation changes from the latest batch." })`.
For simplicity review, choose the simplicity reviewer whose description best fits the cleanup lens. Use built-in `simplicity-reviewer` when no configured simplicity-reviewer-derived custom description is a closer match. Treat it as a post-implementation cleanup pass, not plan readiness, broad correctness review, architecture advice, or verification.

Route review feedback through this decision tree before continuing:

| Feedback type | Action |
|---------------|--------|
| Minor / local to the completed batch | **Inline fix** — apply directly, no new task |
| New isolated work that does not affect downstream sequencing | **Manual task** — `hive_task_create()` for non-blocking ad-hoc work |
| Changes downstream sequencing, dependencies, or scope | **Plan amendment** — update `plan.md`, then `hive_tasks_sync({ refreshPending: true })` to rewrite pending tasks from the amended plan |

When amending the plan: append new task numbers at the end (do not renumber), update `Depends on:` entries to express the new DAG order, then sync.

### Step 5: Continue
After applying review feedback (or if none):
- Re-check `hive_status()` for the updated **runnable** set — tasks whose dependencies are all satisfied
- Tasks blocked by unmet dependencies stay blocked until predecessors complete
- Execute the next batch of runnable tasks
- Repeat until complete

### Step 6: Complete Development

After all tasks complete:
- Announce: "I'm using the verification skill to complete this work."
- **REQUIRED SUB-SKILL:** Use `skill({ name: "verification" })`
- Verify with evidence from that skill
- Integrate through Hive merge (`hive_merge`, typically via `hive-helper` squash batch); do not use raw `git merge` / `git worktree remove` as the Hive finish path
- Do not present a generic merge/PR/keep/discard menu

## When to Stop and Ask for Help

**STOP executing immediately when:**
- Hit a blocker mid-batch (missing dependency, test fails, instruction unclear)
- Plan has critical gaps preventing starting
- You don't understand an instruction
- Verification fails repeatedly

**Ask for clarification rather than guessing.**

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**
- Partner updates the plan based on your feedback
- Fundamental approach needs rethinking

**Don't force through blockers** - stop and ask.

## Remember
- Review plan critically first
- Follow plan steps exactly
- Don't skip verifications
- Reference skills when plan says to
- Between batches: just report and wait
- Stop when blocked, don't guess
