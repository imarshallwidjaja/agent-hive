---
name: background-delegation
description: Agent Hive background-first scheduler guidance for opencode background subagent delegation when the experiment is enabled.
---

# Background Delegation

Background delegation is the Agent Hive scheduler mode for independent primary-agent work when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` enables the native background task experiment.

Core rule: independence first. On non-trivial work, look for independent background lanes before choosing a foreground-only path. Use `task({ background: true, ... })` only when useful foreground work does not depend on the result.

Background is a wait mode, not the definition of parallelism. Independent subagent tasks can run in parallel when the primary agent emits all `task()` calls in the same assistant message. Background mode answers a separate scheduling question: can the primary agent keep doing unrelated foreground work while those subagents run?

Default: Background-first is the scheduler default when the env-gated appendix is present. Allowed foreground/blocking escape reasons: dependency, risk, simplicity, user interaction, or ownership conflict. If the next decision depends on the result, use blocking `task()` or `task_status({ task_id, wait: true, timeout_ms: ... })` and name the escape reason in the handoff.

## Protocol

1. Identify independent lanes and the foreground work that can continue safely.
2. Launch each independent lane with native `task({ background: true, ... })`.
3. Record returned `task_id` values and inspect the scoped board with `hive_background_status`.
4. Continue only foreground work that does not depend on the background result.
5. Use native `task_status` to poll or wait before dependent decisions.
6. Use `hive_background_reconcile` after native jobs reach terminal state so the board does not keep forgotten terminal jobs.
7. Use `hive_background_cancel` only when a background lane is stale, wrong, or no longer needed.

```ts
const { task_id } = task({
  subagent_type: '<chosen-primary-delegated-agent>',
  description: 'Short task label',
  prompt: 'Concrete independent work with done criteria',
  background: true,
});
hive_background_status({ includeStale: false });
task_status({ task_id, wait: false });
task_status({ task_id, wait: true, timeout_ms: 60000 });
hive_background_reconcile({
  identifier: task_id,
  decision: 'reconciled',
  summary: 'Background job result was applied to the task state.',
});
```

## Decision Examples

### Parallel exploration

Action: start independent codebase research while you read another bounded area in the foreground.

Decision: use background when the foreground read does not need the research answer. Use a blocking escape only when dependency, risk, simplicity, user interaction, or ownership conflict makes foreground scheduling wrong.

Result: poll with `task_status({ task_id, wait: false })`, continue foreground work, then wait before using the findings.

### Planning validation

Action: ask a reviewer agent to check assumptions while you inspect references named in the plan.

Decision: use background when the validation cannot change the immediate file reads.

Result: wait with `task_status({ task_id, wait: true, timeout_ms: 60000 })` before finalising plan confidence.

### Review and recovery support

Action: request an independent review of a failure transcript while you reproduce the failure locally.

Decision: use background when local reproduction can proceed without review output.

Result: compare the review result with observed evidence before changing code.

### Execution orchestration

Action: run independent verification or inspection while a foreground implementation step continues.

Decision: use background when the running check cannot affect the current edit.

Result: wait for the final task status before reporting completion or making the next dependent decision.

## Anti-Patterns

- Using background when the next step depends on the result.
- Launching speculative work without a clear decision point.
- Nested delegation. Do not call `task()` from subagents.
- Forgotten terminal jobs: forgetting to poll, wait, reconcile, or cancel before using background results or ending the turn.
- Launching background work just because the feature exists.
