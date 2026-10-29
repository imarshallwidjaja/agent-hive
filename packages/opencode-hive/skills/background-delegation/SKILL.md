---
name: background-delegation
description: Agent Hive background wait-mode and board protocol guidance for opencode background subagent delegation when the host's background gate is open.
---

# Background Delegation

<!-- hive-host opencode-v1 -->
Background delegation is the Agent Hive wait-mode and board protocol for independent primary-agent work when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` enables the native background task experiment.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
Background delegation is the Agent Hive wait-mode and board protocol for independent primary-agent work. OpenCode v2's native subagent call accepts `background` without an experiment variable.
<!-- /hive-host -->

Core rule: delegation first, independence second. Delegation-first orchestration is the baseline. Background mode only changes wait mode and board protocol.
<!-- hive-host opencode-v1 -->
Use `task({ background: true, ... })` only when useful foreground work does not depend on the result.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
Use `subagent({ background: true, ... })` only when useful foreground work does not depend on the result.
<!-- /hive-host -->

Background is a wait mode, not the definition of parallelism.
<!-- hive-host opencode-v1 -->
Independent ordinary Scout, advisor, and reviewer tasks can run in parallel when the primary agent emits their `task()` calls in the same assistant message.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
Independent ordinary Scout, advisor, and reviewer tasks can run in parallel when the primary agent emits their `subagent()` calls in the same assistant message.
<!-- /hive-host -->
Independent Forager worktrees may be created and dispatched under one parent; parallel writes require disjoint worktrees (separate tasks or distinct ad-hoc `runId`s). Background mode answers a separate scheduling question: can the primary agent keep doing unrelated foreground work while those subagents run?

Lane count never selects wait mode. Dependency, risk, simplicity, user interaction, ownership, and whether useful independent foreground work exists select it.

Default: When `## Background-First Orchestration` is present, background-delegation governs scheduling and wait mode; other skills govern domain workflow and safety. Safety, dependency, user, risk, simplicity, ownership, and lifecycle/board gates may still force blocking. Allowed foreground/blocking escape reasons: dependency, risk, simplicity, user interaction, ownership conflict, or lifecycle/board concerns.
<!-- hive-host opencode-v1 -->
If the next decision depends on the result, use blocking `task()` and name the escape reason in the handoff.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
If the next decision depends on the result, use blocking `subagent()` and name the escape reason in the handoff.
<!-- /hive-host -->

<!-- hive-host opencode-v1 -->
Gate-closed sessions use normal blocking `task()` wait mode.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
Gate-closed sessions use normal blocking `subagent()` wait mode.
<!-- /hive-host -->
Do not simulate background orchestration from this skill alone.

### Architect child boundary

When Architect runs as a primary, the gate-open scheduling and board protocol below apply.
<!-- hive-host opencode-v1 -->
When Architect is task-spawned, use blocking `task()` calls for its one terminal layer of permitted Scout, Investigator, plan-reviewer, or approach-advisor helpers, including configured derivatives, and `hive-helper`.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
When Architect is task-spawned, use blocking `subagent()` calls for its one terminal layer of permitted Scout, Investigator, plan-reviewer, or approach-advisor helpers, including configured derivatives, and `hive-helper`.
<!-- /hive-host -->
Emit independent permitted calls together, then wait for their results. Background board tools and primary-control operations are denied in children; return board/control requests and parent-owned lifecycle decisions with known identities to the parent. Trace/evidence investigation may go directly to Helper, which remains read-only and terminal. Keep the inherited feature route and use explicit feature arguments for planning. This branch takes precedence over an inherited Background-First Orchestration heading.

For Hive Builder or unified Hive ad-hoc work, `orchestrating-ad-hoc-work` supplies the already-defined lanes and owns lane-level recovery, integration, and verification state. This skill owns background observation, reconciliation, cancellation, and wait-mode protocol, then returns those outcomes to the ad-hoc workflow. For ad-hoc work, consume the lane boundaries and ready wave from `orchestrating-ad-hoc-work`; do not redefine them here. `dispatching-parallel-agents` owns launch mechanics and writer isolation.

## Scheduling by Delegation Kind

Choose direct work, delegation, or a worktree from the situation. There is no exact-one-read or exact-one-write quota. The cheap direct fix is one small, local, immediately verified integration fix. Direct checkout work is unmanaged OpenCode work, not a Hive worktree.

Read-only exploration and review lanes are the natural background candidates, and their verdicts can gate downstream decisions. Writing, change, and execution lanes are managed lanes: the owning workflow defines their boundaries, dependencies, verification, and integration, and this skill only chooses their wait mode. Prefer targeted tasks over broad ambiguous ones. The smallest meaningful delegation unit is one independently answerable question or one primary goal with one owner, one expected output, and one verification/return contract. Independently verifiable new work in feature-task mode needs a manual task or plan amendment first.

## Launch Safety

Every returned result is terminal. Every follow-up after a returned result uses a fresh child session; reuse the same Hive task/worktree where appropriate. A second patch/test loop, behavior-contract change, or broadened scope is a fresh native assignment.
<!-- hive-host opencode-v1 -->
Pass `task_id` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation; otherwise launch fresh. Do not infer continuation eligibility from task output, `hive_task_trace`, `idle_and_closed`, board state, cancellation acknowledgement, or transcript quality.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
Pass `sessionID` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation; otherwise launch fresh. Do not infer continuation eligibility from task output, `hive_task_trace`, `idle_and_closed`, board state, cancellation acknowledgement, or transcript quality.
<!-- /hive-host -->
If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer. Compaction re-anchoring of a currently running worker is distinct from follow-up work. Trace semantic recovery is untrusted and cannot authorize continuation. A primary goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step.

<!-- hive-host opencode-v1 -->
Returned task IDs are also observe-only board handles for `hive_background_status`, `hive_background_reconcile`, and `hive_background_cancel`.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
The returned `sessionID` identifies the child session. `hive_background_status` lists the observe-only board handle for each lane, which `hive_background_reconcile` and `hive_background_cancel` take. A foreground `subagent()` call that the user moves to the background returns `running` with its `sessionID`; Hive adds it to the board, and it is a background lane under this protocol.
<!-- /hive-host -->

## Unresolved Lanes

Before any dependent decision, merge, cleanup, final report, or new overlapping writing/execution lane, inspect scoped `hive_background_status`; `hive_status` is not that surface. Waiting, pending, terminal-unreconciled, stale, or ownership-overlapping lanes need a board action: wait, cancel, reconcile, ignore, or explicit sequencing. Reconcile and ignore are bookkeeping only; they archive the board row and do not stop execution. Cancel acknowledgement does not prove the worker stopped, and neither do expiry, restart, archive, reconcile, or ignore. The board observes the originating native parent and call, not the current feature or agent. Stale and unknown observations stay visible. If completion lacks a call ID or its identity is ambiguous, record unknown and hint `hive_task_trace`; never guess the latest child. Missing or ambiguous completion identity must not block unrelated dispatch, but ownership-overlapping work still requires inspection or waiting; do not send another prompt or launch another writer. Treat installs, builds, formatters, generators, and tests as mutations. Unrelated worktrees may continue. Do not copy mutable progress out of a worktree while the old worker may still be running, and do not edit the active host's `background-jobs.json` board file directly.

<!-- hive-host opencode-v1 -->
On v1, aborting a session also cancels its running background jobs and their descendants. Inspect each lane before treating it as stopped.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
On v2, interrupting your turn also interrupts a blocking `subagent()` child and cancels its job. Background lanes, including foreground calls moved to the background, keep running when your turn is interrupted or ends; cancel a lane that is no longer needed through its own board row.
<!-- /hive-host -->

The board protocol is primary-owned. Multi-step trace or evidence questions go to `hive-helper` with one named question and known identities; Helper returns evidence, not a termination or replacement-writer decision.

## Protocol (Primary Sessions)

Read [references/board-protocol.md](references/board-protocol.md) when you interpret `hive_background_status` fields, wait for or reconcile a completion, cancel a lane, or meet a completion with a missing or ambiguous identity.

1. Consume the owning workflow's ready lanes, delegation kinds, ownership boundaries, and safe independent foreground work. Build each lane's launch packet with `dispatching-parallel-agents` without changing its boundary.
<!-- hive-host opencode-v1 -->
2. Every Forager lane, including report-only diagnosis, needs a native `task()` call with a Forager or Forager-derived agent. A standalone diagnosis, experiment, or verify-only lane needs a native `task()` call with an Investigator or Investigator-derived agent.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
2. Every Forager lane, including report-only diagnosis, needs a native `subagent()` call with a Forager or Forager-derived agent. A standalone diagnosis, experiment, or verify-only lane needs a native `subagent()` call with an Investigator or Investigator-derived agent.
<!-- /hive-host -->
The owning workflow determines placement; create the matching worktree before dispatch for tracked Git writes, and the experiment placement before an Investigator lane that needs one. Ordinary Scout, advisor, and reviewer calls do not need a worktree.
<!-- hive-host opencode-v1 -->
3. Record returned `task_id` values and inspect the scoped board with `hive_background_status`.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
3. Record the returned `sessionID` values and inspect the scoped board with `hive_background_status`.
<!-- /hive-host -->
4. Follow `recommendedNextAction` from `hive_background_status` when present, and continue only foreground work that does not depend on the background result. `waitingForNativeCompletion` lanes are wait-only: wait for the native background completion notification instead of polling, and treat `native_completion_pending` as a wait state, not a command to reconcile, cancel, or duplicate the lane. An empty `jobs` list is not proof that no native background work exists.
5. After native jobs reach terminal state and you have acted on their results, reconcile each board row once with `hive_background_reconcile` or `hive_background_reconcile_batch`. Reconciliation archives board bookkeeping and does not apply task state; a prompt acknowledgement alone is notification, not reconciliation.
6. Use `hive_background_cancel` only when a lane is stale, wrong, or no longer needed.

## Anti-Patterns

- Using background when the next step depends on the result.
- Launching speculative work without a clear decision point, or just because the feature exists.
- Nested delegation outside Architect's permitted blocking terminal planning-helper layer.
- Broad ambiguous delegation without ownership boundaries or done criteria.
- Board mistakes (forgotten terminal jobs, wait-only polling, manual board mutation, inventing a native identity) are listed in the board protocol reference.
