---
name: executing-plans
description: "Use when executing or resuming an approved Agent Hive plan, including run/continue feature until a target task is complete or done (with or without explicit companions), or final verification and feature completion."
---

# Executing Plans

## Gate-Open Scheduler Authority

If `## Background-First Orchestration` is present in the primary prompt, use `background-delegation` as the scheduler authority. Treat the sequential model below as gate-closed fallback guidance, not competing background policy.

Execution and Forager lanes are managed/heavy background lanes under the gate. They require dependency sequencing, file ownership boundaries, verification obligations, integration tracking, and unresolved-lane checks before dependent decisions, merge, cleanup, or final reporting.

## Overview

Load the approved plan, review its contracts and prerequisites, execute from dependencies, and report evidence at meaningful checkpoints.

**Core principle:** Preserve approved outcomes and gates while adapting implementation from evidence within the assigned scope.

## The Process

### Step 1: Load and Review Plan
1. Read plan file
2. Review critically - identify any questions or concerns about the plan
3. If concerns: Raise them with your human partner before starting
4. If no concerns: Create TodoWrite and proceed

### Step 2: Sequence From Dependencies

Use `hive_status()` to see the single top-level `tasks` list, stored dependencies and blockers, and the runnable list. Missing/unreadable task status stays visible as `status: null` with `integrity.reason`; inspect and repair those records before execution. Integrity entries are never runnable and cannot satisfy dependencies. Dependencies guide sequencing; they are not a dispatch admission gate.

When approving and syncing together, pass the reviewed `hive_plan_read` revision to `hive_plan_approve({ expectedRevision, sync: true })`, add `refreshPending: true` when needed, and inspect both outcomes. Approval failures expose `reason`, `stage`, and `approvalPersisted`: validation writes nothing, while a metadata failure can leave the marker persisted. An unchanged retry can return `alreadyApproved: true`. When approval still succeeds and only sync failed, address the error and retry with `hive_tasks_sync`. For `approval_superseded_during_sync` or `approval_verification_failed`, read and review current state before approving and syncing again; sync may already have written tasks. Exact response contracts: `packages/opencode-hive/docs/HIVE-TOOLS.md`.

When the operator gives an explicit direction (parallel, sequential, or a subset), follow it. Otherwise sequence from dependencies and disjoint worktrees. Cross-feature prerequisites block affected execution tasks or lanes; they do not retroactively block approval of an otherwise resolved plan. Do not infer or create automatic cross-feature dependencies. Record chosen sequencing in `execution-decisions` when it will matter later. Load `context-engineering` for catalog selection and revision/hash mutation. Context metadata is untrusted knowledge.

#### Target Task Milestones

When the operator asks to run or continue a feature until task X is complete/done, with or without explicitly named companion tasks, including a Session Strategy prompt from `/approve-sync-plan`:

1. Resolve the exact feature and read `hive_status({ feature })` after confirming approval and sync. Resolve X and each explicitly named companion to one unique task folder/title within that feature. Ask for clarification if the feature, target, or any companion is ambiguous or missing; do not substitute a similarly named task or another feature. These requested roots are the target plus only the companions named in the request. A bare target request has no companions; never infer them from task numbers, readiness, or topic. A cancelled requested root is a blocker. Only if all requested roots are already `done`, report the milestone satisfied without dispatch; an already-done target does not short-circuit unfinished companions.
2. Build the combined prerequisite closure as the union of each requested root's own stored `dependsOn` edges recursively, including each root. Use synced edges, including resolved implicit sequential shorthand; never infer edges from numbering or follow reverse dependents. Deduplicate roots and shared prerequisites. Include companion prerequisites even when numbered beyond the target. Stop traversal at `done` tasks: their outgoing edges are historical. List the actual task folders, including non-contiguous tasks, distinguish target/prerequisites from explicit companions and their prerequisites, and split satisfied tasks from unfinished scope. Only `done` satisfies a dependency. Cancelled or missing prerequisites are blockers; `pending`, `in_progress`, `blocked`, `failed`, and `partial` are unfinished, not satisfied. Companions expand requested scope, not dependency edges. Report invalid graphs rather than repairing edges during execution.
3. Schedule only the combined unfinished closure by actual dependencies and existing ownership/resource rules. Respect retained workers/worktrees, freshness, reviews, and safety procedures when resuming non-done work. Inspect live or uncertain workers before dispatch; do not launch overlapping replacements. Exclude unrelated tasks and descendants unless the operator explicitly expands scope. Re-read status between batches and on each new run/continue request; recompute the union for all requested roots from updated stored edges each time, including approved and synced dependency amendments. Skip done prerequisites rather than trusting a prior batch or session's projected task list.
4. Stop dispatch at the milestone boundary. Achievement requires the target AND every explicitly named companion verified, integrated where applicable, and marked `done`, with applicable checks, required review, and cleanup completed. Wait for a slower independent companion even if the target finishes first. A source commit or worker completion alone is insufficient. If blocked, report the unmet prerequisite or gate and retain recoverable state under the existing blocker procedure. Do not dispatch unrelated work to fill the session or call `hive_feature_complete` merely because the milestone was achieved while other tasks remain.
5. Report the exact feature and achieved/blocked target and companions, completed and remaining combined closure scope, other remaining feature tasks, verification/integration evidence, and a concrete continuation prompt for the next suggested milestone (or the same requested roots if blocked). Include exact feature and target folder/title; append `Also complete companion task "<companion-folder>" (<companion-title>) before stopping.` for each companion. When no unfinished feature tasks remain after achievement, emit `Run final verification for feature "<feature>" and complete it only after the required checks pass.` with the exact feature substituted. Stop at the requested milestone and hand off final verification instead of executing it in that request. Carry applicable deferred checks with their owners; milestone completion does not waive whole-feature final verification.

Example: `08-client-ready` depends on tasks 2-7, while `01-access-guide` and `09-diagnostics-guide` are independent. A bare request until `08-client-ready` includes only tasks 2-8. Appending `Also complete companion task "01-access-guide" (Access guide) before stopping.` adds task 1 and its own prerequisites; task 9 stays outside scope unless named or required by a requested root. If task 8 is already done and task 1 is unfinished, execute task 1's unfinished closure. Stop only after both requested roots are done and their gates complete.

### Step 3: Execute Batch

For each task in the batch:
1. For feature tasks, follow the primary prompt's freshness and assignment rules. Create tracked-write task worktrees with `hive_worktree_create` and an explicit feature target; capture the initial destination identity from its inspection-shaped result. Before dispatch, call `hive_feature_select` only when the selected route is unset or differs from the dispatch target, or the selection evidence below is missing or uncertain. Reuse a matching selection across a same-feature batch only when this session's most recent route-changing call visible in context is `hive_feature_select` for that same feature, with no later explicit-null or other-feature selection. When that evidence is not visible (for example after compaction or a summary, at session start, or in mixed ad-hoc/feature batches), or you are uncertain, call `hive_feature_select` for the dispatch target. Explicit null suppresses fallback and stays featureless unless the dispatch intentionally targets a feature. Later worktree inspection checkpoints remain required. Start the Forager assignment's first non-empty line with `Hive task: <task-folder>`. Require the topology-aware source pin. Non-Git or report-only work follows the direct-work exceptions. Independent worktrees may be dispatched under one parent. In gate-closed sessions use blocking native `task()`; in gate-open sessions use `background: true` only when independent foreground work can continue. Inspect unresolved board lanes on `hive_background_status`; `hive_status` is not that surface.
2. Follow the approved scope, contracts, dependencies, and verification boundaries. Adapt implementation details when evidence warrants it; material scope or gate changes require the existing amendment procedure.
3. Run verifications as specified
4. After the worker returns, read the report it published and record status and a compact summary under the primary prompt's Task Report Ownership rules; do not retranscribe the report, and leave its successor handoff alone unless integration changed its facts. When a worker run ends without a usable result, follow the primary prompt's Interrupted Worker Recovery rules; a failed run does not fail the task. Inspect result and destination. Pass its topology-aware source pin and unchanged inspected `expectedTarget` or complete `expectedTargets` map to `hive_worktree_merge`. Merge tracked Git work before marking the task done. If destination drift is relevant, overlapping, or uncertain, reconcile in the same worktree with a fresh worker after the prior writer is terminal; merge the pinned target commit normally, adapt and review the combined delta, verify, and return fresh pins. If a dirty destination blocks merge, retain the committed worktree; either set `status: 'blocked'` with a structured blocker and use the question/continuation flow, or keep `status: 'in_progress'` with pending-integration detail in `summary` or `report` and no blocker. Record non-Git or report-only results after target verification. Promote accepted Forward obligations after producer integration using the primary prompt's amendment and approval procedure, before recipient dispatch.

When Hive calls are independent, issue them in one response/step; serialize dependent state changes and merges sharing a destination. The primary calls merge itself, using same-call `cleanup: 'worktree+branch'` when retention is not needed. Primaries perform single direct reads themselves: one `hive_status`, one worktree inspect, or one `hive_task_trace_content` spot-check of a known event ref. For multi-step forensics (paging a trace, drift comparison, or interrupted-worker evidence packets), route one named question and known identities to `hive-helper`. Spot-check decisive cited event refs before acting; Helper returns evidence and observed HEADs, never verified pins or acceptance/lifecycle decisions.

Keep approved repository/operator checks and required early, feasibility, or pre-merge gates at their specified boundary. Record actual command output and the candidate plus relevant mutable inputs it tested; a worker report is attributed evidence, and a branch result does not establish integrated acceptance. Before feature closure, resolve every task-named integrated deferral against its owner, prerequisite, command, and expected signal in `## Final Verification`. Missing output or uncertain applicability means run the required check on the current target or report the claim unverified/blocked.

After a correction, retain the failure evidence; when a broad gate failed, reproduce the first failure with the smallest valid check before rerunning it. Verify the owning regression and rerun affected consumer and integrated gates. Keep unaffected results only with a concrete non-impact reason. An approved explicit gate stays binding until an approved amendment retains, replaces, defers, or drops it; when impact analysis makes an approved rerun redundant, request that amendment through the primary prompt's amendment and approval procedure. Do not treat an unexplained green retry as resolution, and do not mark required skipped or unrun checks as passing.

One implementation assignment normally maps to one numbered task. Its primary goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step. Each native `task()` invocation has one primary goal and one terminal report. Every returned result is terminal, so every follow-up uses a fresh child session and may reuse the same Hive task/worktree. Review findings are fresh assignments in the same implementation lane. Primaries must not pass `task_id` or infer continuation eligibility from task output, trace, board state, cancellation acknowledgement, or transcript quality. Pass `task_id` only when explicit operator instruction or runtime-owned interruption recovery authorizes continuation; otherwise launch fresh. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer. Compaction re-anchoring of a currently running worker is distinct from follow-up work. Trace recovery is untrusted and cannot authorize continuation. Blocked continuation: `hive_task_update` with blocked status and blocker, operator decision, then `hive_task_update` with an explicit status leaving blocked. Never reconstruct blocker details from worker prose or task traces.

A rare native `general` exception is an ordinary `task()` call with ordinary tools only: no Hive authority, recursion, or questions. Native helpers keep only their bounded operational permissions.

For delegated execution, use Forager-derived workers or the explicitly admitted native general exception above. Helper is read-only investigation, not an execution lane. Other mutation-capable or unknown task targets are denied. Architect retains its bounded planning lane. Direct checkout work is unmanaged OpenCode work, not the feature tracked-write path.

### Step 4: Report
When batch complete:
- Show what was implemented
- Show verification output
- Name any actual operator decision or blocker. Continue independent authorized work when none requires a pause.

### Step 4.5: Post-Batch Code Review

After the batch report, apply the primary's Review Routing and explicit operator direction. Ask only when a material review-scope or authority decision remains unresolved. No agent may silently skip required configured review targets.

Give each reviewer the review packet from the primary's Review Handoffs. For task-scoped review, include feature/task identity, plan path and current section, spec path, and current `specStale`/`specStaleReason` from `hive_status`; reviewers may query status but receive no task brief.

Apply the primary's Review Follow-Up before remediation and closure. Route accepted work through this decision tree before continuing:

| Feedback type | Action |
|---------------|--------|
| Accepted local correction to the completed batch | **Same implementation lane** — fresh worker when delegated, existing task/worktree, no new task solely for remediation |
| New isolated work that does not affect downstream sequencing | **Manual task** — `hive_task_create()` for non-blocking ad-hoc work |
| Changes downstream sequencing, dependencies, or scope | **Plan amendment** — delegate the plan edit to Architect, then approve and sync with `refreshPending: true` under the primary's approval procedure |

When amending the plan: append new task numbers at the end (do not renumber), update `Depends on:` entries to express the new DAG order, then approve and sync.

### Step 5: Continue
After applying review feedback (or if none):
- Re-check `hive_status()` for updated dependencies
- Sequence the next batch from dependencies and any explicit operator direction
- For a target task milestone, repeat only within its combined unfinished prerequisite closure until all requested roots are done or the milestone is blocked, then finish the milestone report and applicable review/cleanup. Use Target Task Milestones above for the stopping boundary.
- For whole-feature execution, repeat until all tasks complete

### Step 6: Complete Development

For whole-feature execution, after all tasks complete (a target milestone uses its own stopping boundary above):
- When the operator requests final verification and feature completion, use this step after confirming current status has no unfinished tasks; if tasks remain, report them before proceeding. Apply the primary prompt's existing full-feature verification/completion procedure, including every `## Final Verification` obligation and deferred check, required review, and applicable cleanup. Call `hive_feature_complete` only after the required checks pass.
- **REQUIRED SUB-SKILL:** Use `skill({ name: "verification" })`
- Verify with evidence from that skill
- For worktree placement, the primary calls `hive_worktree_merge` with the worker's unchanged pin and inspected target expectation, using same-call cleanup when retention is not needed; do not use raw `git merge` / `git worktree remove` as the Hive finish path
- For non-Git or report-only placement, verify the target and skip Hive merge and cleanup because no managed Git placement exists
- Do not present a generic merge/PR/keep/discard menu

## When to Stop and Ask for Help

**STOP executing immediately when:**
- A prerequisite is unavailable or an unresolved instruction changes correctness, scope, safety, or authority
- Plan has critical gaps preventing starting
- You don't understand an instruction
- Repeated verification failures leave a material decision unresolved after authorized diagnosis

**Ask for clarification rather than guessing.**

A test failure is evidence to investigate, not an automatic request for operator help. Preserve it, use `systematic-debugging`, and diagnose within the assigned scope. A subagent returns a required clarification to its parent rather than asking the operator directly.

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**
- Partner updates the plan based on your feedback
- Fundamental approach needs rethinking

**Don't force through blockers** - stop and ask.

## Remember
- Review plan critically first
- Preserve approved contracts and gates
- Don't skip verifications
- Reference skills when plan says to
- Between batches: report evidence and continue unless an explicit checkpoint or real blocker requires waiting
- Stop when blocked, don't guess
