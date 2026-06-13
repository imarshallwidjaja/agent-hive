---
name: background-delegation
description: Agent Hive background-first scheduler guidance for opencode background subagent delegation when the experiment is enabled.
---

# Background Delegation

Background delegation is the Agent Hive scheduler mode for independent primary-agent work when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` enables the native background task experiment.

Core rule: independence first. On non-trivial work, look for independent background lanes before choosing a foreground-only path. Use `task({ background: true, ... })` only when useful foreground work does not depend on the result.

Background is a wait mode, not the definition of parallelism. Independent subagent tasks can run in parallel when the primary agent emits all `task()` calls in the same assistant message. Background mode answers a separate scheduling question: can the primary agent keep doing unrelated foreground work while those subagents run?

Default: Background-first is the scheduler default when the env-gated appendix is present. Allowed foreground/blocking escape reasons: dependency, risk, simplicity, user interaction, or ownership conflict. If the next decision depends on the result, use blocking `task()` and name the escape reason in the handoff.

## Protocol

1. Identify independent lanes and the foreground work that can continue safely.
2. Launch each independent lane with native `task({ background: true, ... })`.
3. Record returned `task_id` values and inspect the scoped board with `hive_background_status`.
4. Follow every `nextActions` entry returned by `hive_background_status`, including `reconcile_required` after consuming or intentionally ignoring terminal results. Treat `waitingForNativeCompletion` as wait-only state and `pendingLaunches` with `jobs: []` as a launch-registration warning, not proof that no background work exists.
5. Continue only foreground work that does not depend on the background result.
6. Do not repeatedly refresh the board while a lane is only listed under `waitingForNativeCompletion`. Wait for OpenCode's native background completion notification, then call `hive_background_status` again so Hive can refresh from the observed native terminal state.
7. Treat `native_completion_pending` as a wait state, not a command to reconcile, cancel, or duplicate the lane.
8. Treat prompt acknowledgment as notification only: a terminal job may stop repeating in prompt detail after Hive showed it once, but it is not reconciled until you consume or intentionally ignore the result.
9. Use `hive_background_reconcile` for one terminal job or `hive_background_reconcile_batch` for multiple terminal jobs after native jobs reach terminal state and you have acted on their results. Use `orchestrationBurden` from `hive_background_status` to report pending completion notifications and reconcile items per visible and actionable lane.
10. Use `hive_background_cancel` only when a background lane is stale, wrong, or no longer needed.

```ts
const { task_id } = task({
  subagent_type: '<chosen-primary-delegated-agent>',
  description: 'Short task label',
  prompt: 'Concrete independent work with done criteria',
  background: true,
});
hive_background_status({ includeStale: false });
// Wait for the native background completion notification, then refresh the Hive board
// instead of repeatedly refreshing or manually mutating runtime state.
hive_background_status({ includeStale: false });
hive_background_reconcile({
  identifier: task_id,
  decision: 'reconciled',
  summary: 'Background job result was applied to the task state.',
});
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
- Launching background work just because the feature exists.
