---
name: background-delegation
description: Agent Hive background-first scheduler guidance for opencode background subagent delegation when the experiment is enabled.
---

# Background Delegation

Background delegation is the Agent Hive scheduler mode for independent primary-agent work when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` enables the native background task experiment.

Core rule: independence first. On non-trivial work, look for independent background lanes before choosing a foreground-only path. Use `task({ background: true, ... })` only when useful foreground work does not depend on the result.

Background is a wait mode, not the definition of parallelism. Independent subagent tasks can run in parallel when the primary agent emits all `task()` calls in the same assistant message. Background mode answers a separate scheduling question: can the primary agent keep doing unrelated foreground work while those subagents run?

Default: Background-first is the scheduler default when the env-gated appendix is present. When `## Background-First Orchestration` is present, background-delegation governs scheduling and wait mode; other skills govern domain workflow and safety. Safety, dependency, user, risk, simplicity, and ownership gates may still force blocking. Allowed foreground/blocking escape reasons: dependency, risk, simplicity, user interaction, or ownership conflict. If the next decision depends on the result, use blocking `task()` and name the escape reason in the handoff.

If the env-gated appendix is absent, preserve the normal direct/blocking workflow. Do not simulate background orchestration from this skill alone.

## Direct Work Boundary

Default to delegating implementation/test work and non-trivial verification actions. The primary agent is the scheduler, not the default implementer.

Direct primary-agent work is allowed when the edit or check is small, cheap, integral to coordination, and clearly lower overhead than delegation. The direct fix threshold is one small, local, immediately verified integration fix. A second patch/test loop, behavior-contract change, or broadened scope must be delegated, resumed, or turned into a manual task/plan amendment.

Direct work normally includes clarifying the request, minimal routing reads, classifying the delegation kind, choosing specialists, maintaining todos and task IDs, launching and monitoring lanes, synthesizing results, running cheap final checks, validating outcomes, and communicating decisions.

## Final Verification Gates

Keep pure final verification outside `## Tasks` in `## Final Verification` when no tracked artifacts are written. Treat that section as a non-branching plan gate, not a worktree-backed task. If verification writes tracked artifacts, model it as a normal numbered task and list those files.

## Delegation Kind Reference

- Exploratory/read-only: small targeted tasks, light management, and independent background fan-out when safe.
- Review: small targeted read-only review tasks and light management; verdicts can gate downstream decisions.
- Writing/change: managed tasks with ownership boundaries, dependencies, expected outputs, verification obligations, and an integration path.
- Execution: highest-management tasks with lifecycle/state, merge or cleanup handling, verification routing, and outcome reporting.

Prefer more smaller targeted background tasks over broad ambiguous tasks, especially for exploratory/read-only and review work. Start with a 2-4 initial lanes fan-out unless there is a clear reason for more, synthesize the results, then dispatch another wave if needed.

## Context Packet

Every delegated task needs a context packet with objective and done criteria, relevant known findings and file/reference pointers, prior failures or attempts if any, constraints, non-goals, ownership boundaries, expected output format, verification or return requirements, and how to find missing context when the orchestrator does not already have it.

## Specialist Selection

Choose specialists by descriptor, not by a fixed routing table. Inspect available built-in and custom specialist descriptions, choose the closest specialist for the lane's purpose and risk, prefer configured custom subagents only when their descriptor is a closer match, and fall back to built-in base specialists when no custom descriptor fits.

## Verification Routing

Orchestrator owns final confidence, not every verification action. Workers and reviewers perform verification actions appropriate to their lane. The orchestrator validates outputs and verdicts, reconciles them with direct evidence, and may run cheap final integration checks.

## Unresolved Lanes

Before any dependent decision, merge, cleanup, final report, or new overlapping writing/execution lane, inspect scoped `hive_background_status`. Treat waiting, pending, terminal-unreconciled, stale, or ownership-overlapping lanes as blockers until they are reconciled, ignored, cancelled, waited for, or explicitly sequenced.

## Protocol

1. Identify independent lanes, delegation kind, ownership boundaries, and the foreground work that can continue safely.
2. Build the context packet for each lane.
3. Launch each independent lane with native `task({ background: true, ... })`.
4. Record returned `task_id` values and inspect the scoped board with `hive_background_status`.
5. Follow `recommendedNextAction` from `hive_background_status` when present; use `nextActions` and `orchestrationBurden` as supporting detail for visible lanes and operator reporting. Treat `waitingForNativeCompletion` as wait-only state and `pendingLaunches` with `jobs: []` as a launch-registration warning, not proof that no background work exists.
6. Continue only foreground work that does not depend on the background result.
7. Do not repeatedly refresh the board while visible lanes are only listed under `waitingForNativeCompletion`. If `completionNotificationsPending > 0` and `reconcileItemsRequired == 0`, wait for OpenCode's native background completion notification before calling `hive_background_status` again, unless a lane is stale, wrong, no longer needed, or a new task ID must be registered.
8. Treat `native_completion_pending` as a wait state, not a command to reconcile, cancel, or duplicate the lane.
9. Treat prompt acknowledgment as notification only: a terminal job may stop repeating in prompt detail after Hive showed it once, but it is not reconciled until you consume or intentionally ignore the result.
10. Use `hive_background_reconcile` for one terminal job or `hive_background_reconcile_batch` for multiple terminal jobs after native jobs reach terminal state and you have acted on their results. Reconciliation archives terminal jobs and hides them from normal status output; do not edit `.hive/background-jobs.json` directly.
11. Use `orchestrationBurden` from `hive_background_status` to report pending completion notifications and reconcile items per visible and actionable lane; it supports the recommended action but does not replace it.
12. Use `hive_background_cancel` only when a background lane is stale, wrong, or no longer needed.

```ts
const { task_id } = task({
  subagent_type: '<chosen-primary-delegated-agent>',
  description: 'Short task label',
  prompt: 'Concrete independent work with done criteria',
  background: true,
});
hive_background_status({ includeStale: false });
// Wait for the native background completion notification, then refresh the Hive board
// instead of repeatedly refreshing or manually mutating .hive/background-jobs.json.
hive_background_status({ includeStale: false });
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

Decision: use background when the foreground read does not need the research answer. Use a blocking escape only when dependency, risk, simplicity, user interaction, or ownership conflict makes foreground scheduling wrong.

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
- Nested delegation. Do not call `task()` from subagents.
- Forgotten terminal jobs: treating a prompt-acknowledged terminal result as reconciled, or forgetting to wait for native completion, refresh, reconcile, or cancel before using background results or ending the turn.
- Empty-board false negatives: treating `jobs: []` as final when `pendingLaunches` or `nextActions` are present.
- Wait-only polling: repeatedly calling `hive_background_status` while `schedulerGuidance.reason` is `wait_for_native_completion_notification`.
- Manual board mutation: editing `.hive/background-jobs.json` instead of using `hive_background_status`, `hive_background_reconcile`, `hive_background_reconcile_batch`, or `hive_background_cancel`.
- Launching background work just because the feature exists.
- Broad ambiguous delegation without ownership boundaries or done criteria.
- Choosing a custom specialist because the work is important rather than because the descriptor is the closest match.
