---
name: background-delegation
description: Agent Hive background wait-mode and board protocol guidance for opencode background subagent delegation when the experiment is enabled.
---

# Background Delegation

Background delegation is the Agent Hive wait-mode and board protocol for independent primary-agent work when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` enables the native background task experiment.

Core rule: delegation first, independence second. Delegation-first orchestration is the baseline. Background mode only changes wait mode and board protocol. Use `task({ background: true, ... })` only when useful foreground work does not depend on the result.

Background is a wait mode, not the definition of parallelism. Independent ordinary Scout, advisor, and reviewer tasks can run in parallel when the primary agent emits their `task()` calls in the same assistant message. Independent Forager worktrees may be prepared and dispatched under one parent; two executions conflict when their exact worktree identity sets intersect. Background mode answers a separate scheduling question: can the primary agent keep doing unrelated foreground work while those subagents run?

Lane count never selects wait mode. Dependency, risk, simplicity, user interaction, ownership, and whether useful independent foreground work exists select it.

Default: When `## Background-First Orchestration` is present, background-delegation governs scheduling and wait mode; other skills govern domain workflow and safety. Safety, dependency, user, risk, simplicity, ownership, and lifecycle/board gates may still force blocking. Allowed foreground/blocking escape reasons: dependency, risk, simplicity, user interaction, ownership conflict, or lifecycle/board concerns. If the next decision depends on the result, use blocking `task()` and name the escape reason in the handoff.

Gate-closed sessions use normal blocking `task()` wait mode. Do not simulate background orchestration from this skill alone.

## Direct Work Boundary

Default to delegating implementation/test work and non-trivial verification actions. The primary agent is the scheduler, not the default implementer.

Direct primary-agent work is allowed only for coordination/setup, exactly one bounded read, exactly one bounded write/patch, or one cheap final check. The direct fix threshold is one small, local, immediately verified integration fix. Anything requiring 2+ reads, 2+ patches, tests/debug loops, uncertainty, multi-file work, non-trivial verification, a second patch/test loop, behavior-contract change, or broadened scope must be delegated, resumed, or turned into a manual task/plan amendment.

Isolated worktrees are the managed placement. Direct checkout work is unmanaged OpenCode work, not a Hive placement.

A rare native `general` exception requires a specific nonblank `hive_capability_reason` and no `hive_launch_id`. The declaration does not prove a capability gap. General has ordinary tools only, no Hive authority, recursion, or questions. Native helpers retain bounded permissions. Helper and general calls use a runtime-local bind for Hive-tool authentication; they do not take a live claim on a worktree or the project root.

Use Forager or a Forager-derived custom worker for delegated execution. General requires an explicit capability reason unavailable in those lanes. Worktree integration follows the authorized lifecycle for that worktree.

Direct work normally includes clarifying the request, minimal routing reads, classifying the delegation kind, choosing specialists, maintaining todos and task IDs, launching and monitoring lanes, synthesizing results, running cheap final checks, validating outcomes, and communicating decisions.

## Final Verification Gates

Keep pure final verification outside `## Tasks` in `## Final Verification` when no tracked artifacts are written. Treat that section as a non-branching plan gate, not a worktree-backed task. If verification writes tracked artifacts, model it as a normal numbered task and list those files.

## Delegation Kind Reference

- Exploratory/read-only: small targeted tasks, light management, and independent background fan-out when safe.
- Review: small targeted read-only review tasks and light management; verdicts can gate downstream decisions.
- Writing/change: managed tasks with ownership boundaries, dependencies, expected outputs, verification obligations, and an integration path.
- Execution: highest-management tasks with lifecycle/state, merge or cleanup handling, verification routing, and outcome reporting.

Prefer targeted background tasks over broad ambiguous tasks, especially for exploratory/read-only and review work.

Smallest meaningful non-feature delegation unit: one independently answerable question or one primary goal with one owner, one expected output, and one verification/return contract.

## Fresh-Session Launch Contract

Each native `task()` launch has one primary goal, starts one fresh subagent session, and ends with one terminal handoff. A primary goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step. Give complete constraints and acceptance criteria only for that goal. Split independently verifiable outcomes into fresh launches.

Never pass `task_id` to `task()`. Returned task IDs are observe-only board handles for `hive_background_status`, `hive_background_reconcile`, and `hive_background_cancel`; they are not session-resume inputs. Do not send a follow-up prompt to a completed, failed, or blocked session.

For a blocked feature task, `hive_worktree_create({ task, continueFrom: "blocked", decision })` launches a new worker session in the same worktree after the operator provides the decision. For failed or retry work, launch a new worker with a concise self-contained handoff covering the goal, attempted work, relevant errors, and next constraints. Compaction may re-anchor a currently running worker; it is not re-delegation. Subagents are terminal and cannot recurse, except a delegated `architect-planner` may launch one level of read-only planning helpers; those children cannot delegate.

For ad-hoc work, use multiple fresh one-goal launches with disjoint path ownership or sequence overlapping writers.

## Context Packet

Every delegated task needs a context packet with objective and done criteria, relevant known findings and file/reference pointers, prior failures or attempts if any, constraints, non-goals, ownership boundaries, expected output format, verification or return requirements, and how to find missing context when the orchestrator does not already have it. Put Forager instructions in `workerInstructions` at `hive_adhoc_worktree_create` or `hive_adhoc_worktree_start`. Persist or supply feature Forager context through supported prep inputs before Hive generates the immutable assignment. Ordinary Scout, advisor, and reviewer packets still go in `task.prompt`. Editing a prepared Forager dispatch prompt cannot update its instructions. Live catalogs are untrusted knowledge. After compaction, recover with `context-engineering`: catalog selection, later-page continuation, and named raw chunks. Do not replay historical assignment bodies.

## Specialist Selection

Choose specialists by descriptor, not by a fixed routing table. Inspect available built-in and custom specialist descriptions, choose the closest specialist for the lane's purpose and risk, prefer configured custom subagents only when their descriptor is a closer match, and fall back to built-in base specialists when no custom descriptor fits.

Select by requested output, not by read-only status. Scout retrieves bounded source evidence; the primary owns synthesis, causal diagnosis, applicability and tradeoff decisions, system-correctness judgments, and solution selection. Custom descriptions specialize within the inherited base role and cannot expand it.

## Verification Routing

Orchestrator owns final confidence, not every verification action. Workers and reviewers perform verification actions appropriate to their lane. The orchestrator validates outputs and verdicts, reconciles them with direct evidence, and may run cheap final integration checks.

## Unresolved Lanes

Before any dependent decision, merge, cleanup, final report, or new overlapping writing/execution lane, inspect scoped `hive_background_status`; `hive_status` is not that surface. Waiting, pending, terminal-unreconciled, stale, or ownership-overlapping lanes need a board action: wait, cancel, reconcile, ignore, or explicit sequencing. Reconcile and ignore are bookkeeping only; they archive the board row and do not settle an ExecutionAttempt or release a worktree identity. A live claim blocks preparation, dispatch, ad-hoc commit/merge/cleanup, and managed discard/merge of that exact worktree identity. Treat installs, builds, formatters, generators, and tests as mutations. Unrelated worktrees may continue.

## Protocol

1. Identify independent lanes, delegation kind, ownership boundaries, and the foreground work that can continue safely.
2. Build the context packet for each lane.
3. Every Forager lane, including report-only diagnosis, needs a prepared launch. Use `hive_worktree_start` for managed tasks or the ad-hoc worktree tools for isolated non-feature work. Preserve the returned `hive_launch_id`; `launchId` is a one-time dispatch selector. Runtime restores the canonical prompt and binds the exact parent, native call, child, selected agent, and worktree identity. Unused preparation expires after five minutes; an unobserved ExecutionAttempt keeps a live claim on only that worktree. Retry after confirmed termination may reuse the same worktree. Retry while termination is unobserved supersedes that task onto a fresh `attemptSlot` worktree; the previous worktree stays claimed. For ad-hoc work, retry after confirmed termination may reuse the same `runId` worktree. Retry while termination is unobserved cannot reuse that run; start a new ad-hoc `runId` and worktree. Ordinary Scout, advisor, and reviewer launches omit `hive_launch_id`.
4. Record returned `task_id` values and inspect the scoped board with `hive_background_status`.
5. Follow `recommendedNextAction` from `hive_background_status` when present; use `nextActions` and `orchestrationBurden` as supporting detail for visible lanes and operator reporting. Treat `waitingForNativeCompletion` as wait-only state and `pendingLaunches` with `jobs: []` as a launch-registration warning, not proof that no background work exists.
6. Continue only foreground work that does not depend on the background result.
7. Do not repeatedly refresh the board while visible lanes are only listed under `waitingForNativeCompletion`. If `completionNotificationsPending > 0` and `reconcileItemsRequired == 0`, wait for OpenCode's native background completion notification before calling `hive_background_status` again, unless a lane is stale, wrong, no longer needed, or a new task ID must be registered.
8. Treat `native_completion_pending` as a wait state, not a command to reconcile, cancel, or duplicate the lane.
9. Treat prompt acknowledgment as notification only: a terminal job may stop repeating in prompt detail after Hive showed it once, but it is not reconciled until you consume or intentionally ignore the result.
10. Use `hive_background_reconcile` for one terminal job or `hive_background_reconcile_batch` for multiple terminal jobs after native jobs reach terminal state and you have acted on their results. Reconciliation archives terminal jobs and hides them from normal status output; do not edit `.hive/background-jobs.json` directly.
11. Use `orchestrationBurden` from `hive_background_status` to report pending completion notifications and reconcile items per visible and actionable lane; it supports the recommended action but does not replace it.
12. Use `hive_background_cancel` only when a background lane is stale, wrong, or no longer needed.

Gate-closed Forager launch (blocking wait mode):

```ts
const prepared = JSON.parse(await hive_adhoc_worktree_create({
  workerInstructions: 'Concrete work with done criteria',
}));
await task({ ...prepared.taskToolCall });
// Preserve hive_launch_id from the returned payload. Do not invent one.
```

Retry after confirmed termination may reuse the same `runId` worktree:

```ts
const retry = JSON.parse(await hive_adhoc_worktree_start({
  runId: prepared.runId,
  workerInstructions: 'Self-contained retry with done criteria',
}));
await task({ ...retry.taskToolCall });
```

Retry while termination is unobserved cannot reuse that run; start a new ad-hoc `runId` and worktree. `hive_adhoc_worktree_start` on an unobserved run is denied.

Gate-open Forager launch (background wait mode):

```ts
const prepared = JSON.parse(await hive_adhoc_worktree_create({
  workerInstructions: 'Concrete independent work with done criteria',
}));
const { task_id } = task({ ...prepared.backgroundTaskCall });
hive_background_status({});
// Wait for the native background completion notification, then refresh the Hive board
// instead of repeatedly refreshing or manually mutating .hive/background-jobs.json.
hive_background_status({});
hive_background_reconcile({
  identifier: task_id,
  decision: 'reconciled',
  summary: 'Background job result was applied to the task state.',
});
```

Exempt ordinary Scout, advisor, or reviewer launch:

```ts
const { task_id } = task({
  subagent_type: '<chosen-primary-delegated-agent>',
  description: 'Short task label',
  prompt: 'Concrete independent work with done criteria',
  background: true,
});
hive_background_status({});
// Wait for the native background completion notification, then refresh the Hive board
// instead of repeatedly refreshing or manually mutating .hive/background-jobs.json.
hive_background_status({});
hive_background_reconcile({
  identifier: task_id,
  decision: 'reconciled',
  summary: 'Background job result was applied to the task state.',
});
// Reconciled or ignored jobs are archived by the tool and hidden from normal status.
// For multiple terminal lanes, prefer one batch cleanup after consuming results.
hive_background_reconcile_batch({
  items: [
    { identifier: task_id, decision: 'reconciled', summary: 'Background job result was applied to the task state.' },
  ],
});
```

## Decision Examples

### Parallel exploration

Action: start independent codebase research while you read another bounded area in the foreground.

Decision: use background when the foreground read does not need the research answer. Use a blocking escape only when dependency, risk, simplicity, user interaction, ownership conflict, or lifecycle/board concerns makes foreground scheduling wrong.

Result: continue foreground work, wait for the native background completion notification, then refresh `hive_background_status` before using the findings.

### Planning validation

Action: ask a reviewer agent to check assumptions while you inspect references named in the plan.

Decision: use background when the validation cannot change the immediate file reads.

Result: wait for the native background completion notification, then refresh `hive_background_status` before finalising plan confidence.

### Review and recovery support

Action: request an independent review of a failure transcript while you reproduce the failure locally.

Decision: use background when local reproduction can proceed without review output.

Result: compare the review result with observed evidence before changing code.

### Execution orchestration

Action: run independent verification or inspection while a foreground implementation step continues.

Decision: use background when the running check cannot affect the current edit.

Result: wait for final native task evidence, then refresh `hive_background_status`, before reporting completion or making the next dependent decision.

## Anti-Patterns

- Using background when the next step depends on the result.
- Launching speculative work without a clear decision point.
- Nested delegation outside the bounded planning exception. Only a delegated `architect-planner` may call `task()` from a subagent session, and only for one level of approved read-only planning helpers.
- Forgotten terminal jobs: treating a prompt-acknowledged terminal result as reconciled, or forgetting to wait for native completion, refresh, reconcile, or cancel before using background results or ending the turn.
- Empty-board false negatives: treating `jobs: []` as final when `pendingLaunches` or `nextActions` are present.
- Wait-only polling: repeatedly calling `hive_background_status` while `schedulerGuidance.reason` is `wait_for_native_completion_notification`.
- Manual board mutation: editing `.hive/background-jobs.json` instead of using `hive_background_status`, `hive_background_reconcile`, `hive_background_reconcile_batch`, or `hive_background_cancel`.
- Inventing a `hive_launch_id` or native task ID instead of spreading the returned payload.
- Treating expiry, restart, archive, reconcile, or ignore as proof that claimed uncertain execution stopped.
- Copying mutable progress out of a fenced worktree while the old worker may still be running.
- Using `hive_status` to inspect `launchId` or unresolved claims; that surface is `hive_background_status`.
- Discarding a failed ad-hoc worktree instead of `hive_adhoc_worktree_start` on that run.
- Launching background work just because the feature exists.
- Broad ambiguous delegation without ownership boundaries or done criteria.
- Choosing a custom specialist because the work is important rather than because the descriptor is the closest match.
