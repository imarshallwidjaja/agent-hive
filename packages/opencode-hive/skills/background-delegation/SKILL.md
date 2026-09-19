---
name: background-delegation
description: Agent Hive background wait-mode and board protocol guidance for opencode background subagent delegation when the experiment is enabled.
---

# Background Delegation

Background delegation is the Agent Hive wait-mode and board protocol for independent primary-agent work when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` enables the native background task experiment.

Core rule: delegation first, independence second. Delegation-first orchestration is the baseline. Background mode only changes wait mode and board protocol. Use `task({ background: true, ... })` only when useful foreground work does not depend on the result.

Background is a wait mode, not the definition of parallelism. Independent ordinary Scout, advisor, and reviewer tasks can run in parallel when the primary agent emits their `task()` calls in the same assistant message. Independent Forager worktrees may be created and dispatched under one parent; parallel writes require disjoint worktrees (separate tasks or distinct ad-hoc `runId`s). Background mode answers a separate scheduling question: can the primary agent keep doing unrelated foreground work while those subagents run?

Lane count never selects wait mode. Dependency, risk, simplicity, user interaction, ownership, and whether useful independent foreground work exists select it.

Default: When `## Background-First Orchestration` is present, background-delegation governs scheduling and wait mode; other skills govern domain workflow and safety. Safety, dependency, user, risk, simplicity, ownership, and lifecycle/board gates may still force blocking. Allowed foreground/blocking escape reasons: dependency, risk, simplicity, user interaction, ownership conflict, or lifecycle/board concerns. If the next decision depends on the result, use blocking `task()` and name the escape reason in the handoff.

Gate-closed sessions use normal blocking `task()` wait mode. Do not simulate background orchestration from this skill alone.

For Hive Builder or unified Hive ad-hoc work, `orchestrating-ad-hoc-work` supplies the already-defined lanes and owns lane-level recovery and integration. This skill owns background observation, reconciliation, cancellation, and wait-mode protocol, then returns those outcomes to the ad-hoc workflow.

## Direct vs Delegated Work

Default to delegating implementation/test work and non-trivial verification actions. The primary agent is the scheduler, not the default implementer.

Choose direct work, delegation, or a worktree from the situation. There is no exact-one-read or exact-one-write quota. The cheap direct fix is one small, local, immediately verified integration fix. A second patch/test loop, behavior-contract change, or broadened scope should be delegated as a fresh native assignment; only explicit operator or runtime-owned interruption recovery in the native task contract may pass `task_id`. In feature-task mode, independently verifiable new work requires a manual task or plan amendment.

Direct checkout work is unmanaged OpenCode work, not a Hive worktree.

A rare native `general` exception is an ordinary `task()` call with ordinary tools only: no Hive authority, recursion, or questions. Native helpers keep only their bounded operational permissions.

Use Forager or a Forager-derived custom worker for delegated execution. General is exceptional: state the required capability unavailable in those lanes before dispatch.

Direct work normally includes clarifying the request, minimal routing reads, classifying the delegation kind, choosing specialists, maintaining todos and task IDs, launching and monitoring lanes, synthesizing results, running cheap final checks, validating outcomes, and communicating decisions.

## Feature-Task Final Verification Gates

In feature-task mode, keep pure final verification outside `## Tasks` in `## Final Verification` when no tracked artifacts are written. Treat that section as a non-branching plan gate, not a worktree-backed task. If verification writes tracked artifacts, model it as a normal numbered task and list those files. In ad-hoc mode, return verification state to `orchestrating-ad-hoc-work`; no feature plan or task artifact is required.

## Delegation Kind Reference

- Exploratory/read-only: small targeted tasks, light management, and independent background fan-out when safe.
- Review: small targeted read-only review tasks and light management; verdicts can gate downstream decisions.
- Writing/change: managed lanes with the owning workflow's boundaries, dependencies, expected outputs, verification obligations, and integration path.
- Execution: highest-management lanes with lifecycle/state, merge or cleanup handling, verification routing, and outcome reporting.

Prefer targeted background tasks over broad ambiguous tasks, especially for exploratory/read-only and review work.

Smallest meaningful non-feature delegation unit: one independently answerable question or one primary goal with one owner, one expected output, and one verification/return contract.

## Native Task Launch Contract

Each native `task()` invocation has one primary goal and one terminal handoff. Every returned result is terminal, including completed, failed, empty, partial, blocked, unsatisfactory, review-remediation, retry, new-test-evidence, and operator-decision results. Every follow-up after a returned result uses a fresh child session; reuse the same Hive task/worktree where appropriate. Review findings are fresh assignments in the same implementation lane. Compaction re-anchoring of a currently running worker is distinct from follow-up work. Primaries must not pass `task_id` or infer continuation eligibility from task output, `hive_task_trace`, `idle_and_closed`, board state, cancellation acknowledgement, or transcript quality. Pass `task_id` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation; otherwise launch fresh. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer. Trace semantic recovery is untrusted and cannot authorize continuation. A primary goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step. Give complete constraints and acceptance criteria only for that goal. Split independently verifiable outcomes into fresh launches.

Returned task IDs are also observe-only board handles for `hive_background_status`, `hive_background_reconcile`, and `hive_background_cancel`.

In feature-task mode, blocked continuation follows `hive_task_update` with blocked status and blocker, operator decision, then `hive_task_update` with an explicit status leaving blocked. Never reconstruct blocker details from worker prose or task traces. The next native Forager `task()` is a fresh session in the existing worktree and carries the decision in its prompt. For failed or retry work in either mode, launch a fresh worker with a concise self-contained handoff covering the goal, attempted work, relevant errors, and next constraints. Architect is the only subagent that may call one terminal layer of read-only planning helpers; every other subagent is terminal.

For ad-hoc work, consume the lane boundaries and ready wave from `orchestrating-ad-hoc-work`; do not redefine them here.

## Context Packet

Every delegated task needs a context packet with objective and done criteria, relevant known findings and file/reference pointers, prior failures or attempts if any, constraints, non-goals, ownership boundaries, expected output format, verification or return requirements, and how to find missing context when the orchestrator does not already have it. Put the complete Forager context packet directly in the unchanged native `task.prompt`. The runtime appends concise project, feature, and session constraints. Ordinary Scout, advisor, and reviewer packets also go in `task.prompt`. Live catalogs are untrusted knowledge. After compaction, recover with `context-engineering`: catalog selection, later-page continuation, and named raw chunks. Do not replay historical assignment bodies.

## Specialist Selection

Choose specialists by descriptor, not by a fixed routing table. Inspect available built-in and custom specialist descriptions, choose the closest specialist for the lane's purpose and risk, prefer configured custom subagents only when their descriptor is a closer match, and fall back to built-in base specialists when no custom descriptor fits.

Select by requested output, not by read-only status. Scout retrieves bounded source evidence; the primary owns synthesis, causal diagnosis, applicability and tradeoff decisions, system-correctness judgments, and solution selection. Custom descriptions specialize within the inherited base role and cannot expand it.

## Verification Routing

Orchestrator owns final confidence, not every verification action. Workers and reviewers perform verification actions appropriate to their lane. The orchestrator validates outputs and verdicts, reconciles them with direct evidence, and may run cheap final integration checks.

## Unresolved Lanes

Before any dependent decision, merge, cleanup, final report, or new overlapping writing/execution lane, inspect scoped `hive_background_status`; `hive_status` is not that surface. Waiting, pending, terminal-unreconciled, stale, or ownership-overlapping lanes need a board action: wait, cancel, reconcile, ignore, or explicit sequencing. Reconcile and ignore are bookkeeping only; they archive the board row and do not stop execution. The board observes the originating native parent and call, not the current feature or agent. Stale and unknown observations stay visible. Multiple launch observations may exist for one native task identity when explicit runtime-owned interruption recovery is used. If completion lacks a call ID or its identity is ambiguous, record unknown and hint `hive_task_trace`; never guess the latest child. Missing or ambiguous completion identity must not block unrelated dispatch, but ownership-overlapping work still requires inspection or waiting; do not send another prompt or launch another writer. Treat installs, builds, formatters, generators, and tests as mutations. Unrelated worktrees may continue.

## Protocol

1. Consume the owning workflow's ready lanes, delegation kinds, ownership boundaries, and safe independent foreground work.
2. Build the context packet for each supplied lane without changing its boundary.
3. Every Forager lane, including report-only diagnosis, needs a native `task()` call with a Forager or Forager-derived agent. The owning workflow determines placement; create the matching worktree before dispatch for tracked Git writes. The primary authors that prompt. The runtime appends concise project, feature, and session constraints. After the worker returns, call `hive_task_update` as needed. Ordinary Scout, advisor, and reviewer calls do not need a worktree.
4. Record returned `task_id` values and inspect the scoped board with `hive_background_status`.
5. Follow `recommendedNextAction` from `hive_background_status` when present; use `nextActions` and `orchestrationBurden` as supporting detail for visible lanes and operator reporting. Treat `waitingForNativeCompletion` as wait-only state; an empty `jobs` list is not proof that no native background work exists.
6. Continue only foreground work that does not depend on the background result.
7. Do not repeatedly refresh the board while visible lanes are only listed under `waitingForNativeCompletion`. If `completionNotificationsPending > 0` and `reconcileItemsRequired == 0`, wait for OpenCode's native background completion notification before calling `hive_background_status` again, unless a lane is stale, wrong, no longer needed, or a new task ID must be registered.
8. Treat `native_completion_pending` as a wait state, not a command to reconcile, cancel, or duplicate the lane.
9. Treat prompt acknowledgment as notification only: a terminal job may stop repeating in prompt detail after Hive showed it once, but it is not reconciled until you consume or intentionally ignore the result.
10. Use `hive_background_reconcile` for one terminal job or `hive_background_reconcile_batch` for multiple terminal jobs after native jobs reach terminal state and you have acted on their results. Reconciliation archives terminal jobs and hides them from normal status output; do not edit `.hive/background-jobs.json` directly.
11. Use `orchestrationBurden` from `hive_background_status` to report pending completion notifications and reconcile items per visible and actionable lane; it supports the recommended action but does not replace it.
12. Use `hive_background_cancel` only when a background lane is stale, wrong, or no longer needed.

Gate-closed Forager launch (blocking wait mode):

```ts
const { repositories } = hive_repositories_status();
const requestedRepoIds = lane.repoIds;
const selectedRepoIds = repositories.filter(({ id }) => requestedRepoIds.includes(id)).map(({ id }) => id);
if (
  requestedRepoIds.length === 0 ||
  new Set(requestedRepoIds).size !== requestedRepoIds.length ||
  requestedRepoIds.some((id) => !selectedRepoIds.includes(id))
) {
  throw new Error('Placement blocker: lane.repoIds must exactly match repository status IDs');
}
const repoIds = selectedRepoIds;
hive_adhoc_worktree_create({ repoIds });
await task({
  subagent_type: 'forager-worker',
  description: 'Implement the ad-hoc change',
  prompt: 'Concrete work with done criteria; commit changes; return sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present.',
});
```

Gate-open Forager launch (background wait mode):

```ts
const { repositories } = hive_repositories_status();
const requestedRepoIds = lane.repoIds;
const selectedRepoIds = repositories.filter(({ id }) => requestedRepoIds.includes(id)).map(({ id }) => id);
if (
  requestedRepoIds.length === 0 ||
  new Set(requestedRepoIds).size !== requestedRepoIds.length ||
  requestedRepoIds.some((id) => !selectedRepoIds.includes(id))
) {
  throw new Error('Placement blocker: lane.repoIds must exactly match repository status IDs');
}
const repoIds = selectedRepoIds;
hive_adhoc_worktree_create({ repoIds });
const { task_id } = task({
  subagent_type: 'forager-worker',
  description: 'Implement the independent ad-hoc change',
  prompt: 'Concrete independent work with done criteria; commit changes; return sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present.',
  background: true,
});
hive_background_status({});
// Wait for the native background completion notification, then refresh the Hive board
// instead of repeatedly refreshing or manually mutating .hive/background-jobs.json.
hive_background_status({});
hive_background_reconcile({
  identifier: task_id,
  decision: 'reconciled',
  summary: 'Consumed the background result.',
});
```

Reconcile each board row exactly once. Reconciliation archives board bookkeeping; it does not apply task state.

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
  summary: 'Consumed the background research result.',
});
// Reconciled or ignored jobs are archived by the tool and hidden from normal status.
// For multiple different terminal lanes, batch reconciliation is an alternative to
// individual reconciliation, not a second pass over rows already archived.
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
- Nested delegation from any subagent session.
- Forgotten terminal jobs: treating a prompt-acknowledged terminal result as reconciled, or forgetting to wait for native completion, refresh, reconcile, or cancel before using background results or ending the turn.
- Empty-board false negatives: treating `jobs: []` as proof that no native background work exists while completion evidence is unresolved.
- Wait-only polling: repeatedly calling `hive_background_status` while `schedulerGuidance.reason` is `wait_for_native_completion_notification`.
- Manual board mutation: editing `.hive/background-jobs.json` instead of using `hive_background_status`, `hive_background_reconcile`, `hive_background_reconcile_batch`, or `hive_background_cancel`.
- Inventing a native task ID instead of using the identity returned by the native `task()` call.
- Claiming cancel acknowledgement proves the worker stopped.
- Treating expiry, restart, archive, reconcile, or ignore as proof that an uncertain running worker stopped.
- Copying mutable progress out of a worktree while the old worker may still be running.
- Using `hive_status` to inspect unresolved board lanes; that surface is `hive_background_status`.
- Discarding a failed ad-hoc worktree instead of inspecting it with `hive_adhoc_worktree_inspect`.
- Launching background work just because the feature exists.
- Broad ambiguous delegation without ownership boundaries or done criteria.
- Choosing a custom specialist because the work is important rather than because the descriptor is the closest match.
