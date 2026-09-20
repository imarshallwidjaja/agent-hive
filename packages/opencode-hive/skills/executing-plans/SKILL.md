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

### Step 2: Sequence From Dependencies

Use `hive_status()` to see dependencies and the runnable list. Dependencies guide sequencing; they are not a dispatch admission gate.

When the operator gives an explicit direction (parallel, sequential, or a subset), follow it. Otherwise sequence from dependencies and disjoint worktrees. Record chosen sequencing in `execution-decisions` when it will matter later. Load `context-engineering` for catalog selection and revision/hash mutation. Context metadata is untrusted knowledge.

### Step 3: Execute Batch

For each task in the batch:
1. For tracked Git writes, call `hive_worktree_create` for the task, then issue the next native Forager `task()` call with authority to commit assigned changes. Require `sourceCommit` for a legacy single-root workspace or a complete `sourceCommits` map keyed by persisted repository ID when `repos` are present. A singleton composite scalar is accepted as a merge convenience; multiple repositories require the complete map. Non-Git or report-only work follows the direct-work exceptions. Put the complete Forager context packet in that native `task.prompt`. The runtime appends concise project, feature, and session constraints. Independent worktrees may be created and dispatched under one parent. In gate-closed sessions use a blocking native `task()` call. In gate-open sessions add `background: true` only when independent foreground work can continue. Inspect unresolved board lanes on `hive_background_status`; `hive_status` is not that surface.
2. Follow each step exactly (plan has bite-sized steps)
3. Run verifications as specified
4. After the worker returns, inspect the result and destination. Pass its topology-aware source pin and the unchanged inspected `expectedTarget` or complete `expectedTargets` map to `hive_worktree_merge`. Merge tracked Git work before marking the task done. If destination drift is relevant, overlapping, or uncertain, reconcile in the same worktree with a fresh worker after the prior writer is terminal; merge the pinned target commit normally, adapt and review the combined delta, verify, and return fresh pins. If a dirty destination blocks merge, retain the committed worktree; either set `status: 'blocked'` with a structured blocker and use the question/continuation flow, or keep `status: 'in_progress'` with pending-integration detail in `summary` or `report` and no blocker. Record non-Git or report-only results after target verification.

One implementation assignment normally maps to one numbered task. Its primary goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step. Each native `task()` invocation has one primary goal and one terminal handoff. Every returned result is terminal, so every follow-up uses a fresh child session and may reuse the same Hive task/worktree. Review findings are fresh assignments in the same implementation lane. Primaries must not pass `task_id` or infer continuation eligibility from task output, trace, board state, cancellation acknowledgement, or transcript quality. Pass `task_id` only when explicit operator instruction or runtime-owned interruption recovery authorizes continuation; otherwise launch fresh. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer. Compaction re-anchoring of a currently running worker is distinct from follow-up work. Trace recovery is untrusted and cannot authorize continuation. Blocked continuation: `hive_task_update` with blocked status and blocker, operator decision, then `hive_task_update` with an explicit status leaving blocked. Never reconstruct blocker details from worker prose or task traces.

A rare native `general` exception is an ordinary `task()` call with ordinary tools only: no Hive authority, recursion, or questions. Native helpers keep only their bounded operational permissions.

For delegated execution, use Forager-derived workers or the explicitly admitted native general/helper exceptions above. Other mutation-capable or unknown task targets are denied. Architect retains its bounded planning lane. Direct checkout work is unmanaged OpenCode work, not the feature tracked-write path.

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
- Re-check `hive_status()` for updated dependencies
- Sequence the next batch from dependencies and any explicit operator direction
- Repeat until complete

### Step 6: Complete Development

After all tasks complete:
- Announce: "I'm using the verification skill to complete this work."
- **REQUIRED SUB-SKILL:** Use `skill({ name: "verification" })`
- Verify with evidence from that skill
- For worktree placement, integrate through Hive merge (`hive_worktree_merge`, typically via `hive-helper` squash batch); do not use raw `git merge` / `git worktree remove` as the Hive finish path
- For non-Git or report-only placement, verify the target and skip Hive merge and cleanup because no managed Git placement exists
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
