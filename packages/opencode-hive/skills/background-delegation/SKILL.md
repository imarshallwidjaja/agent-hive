---
name: background-delegation
description: Agent Hive optional guidance for opencode background subagent delegation when the experiment is enabled.
---

# Background Delegation

Background delegation is an optional opencode execution mode for independent agent work. Use it only when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` enables the native background task experiment.

Core rule: independence first. Use `task({ background: true, ... })` only when useful foreground work does not depend on the result.

Background is a wait mode, not the definition of parallelism. Independent subagent tasks can run in parallel with normal blocking `task()` when the primary agent emits all `task()` calls in the same assistant message. Use background only for the separate question: can the primary agent keep doing unrelated foreground work while those subagents run?

Default: normal blocking `task()` remains the default. If the next decision depends on the result, use blocking `task()` or `task_status({ task_id, wait: true, timeout_ms: ... })`.

## Protocol

```ts
const { task_id } = task({
  subagent_type: '<chosen-primary-delegated-agent>',
  description: 'Short task label',
  prompt: 'Concrete independent work with done criteria',
  background: true,
});
task_status({ task_id, wait: false });
task_status({ task_id, wait: true, timeout_ms: 60000 });
```

## Decision Examples

### Parallel exploration

Action: start independent codebase research while you read another bounded area in the foreground.

Decision: use background only when the foreground read does not need the research answer.

Result: poll with `task_status({ task_id, wait: false })`, continue foreground work, then wait before using the findings.

### Planning validation

Action: ask a reviewer agent to check assumptions while you inspect references named in the plan.

Decision: use background only when the validation cannot change the immediate file reads.

Result: wait with `task_status({ task_id, wait: true, timeout_ms: 60000 })` before finalising plan confidence.

### Review and recovery support

Action: request an independent review of a failure transcript while you reproduce the failure locally.

Decision: use background only when local reproduction can proceed without review output.

Result: compare the review result with observed evidence before changing code.

### Execution orchestration

Action: run independent verification or inspection while a foreground implementation step continues.

Decision: use background only when the running check cannot affect the current edit.

Result: wait for the final task status before reporting completion or making the next dependent decision.

## Anti-Patterns

- Using background when the next step depends on the result.
- Launching speculative work without a clear decision point.
- Nested delegation. Do not call `task()` from subagents.
- Forgetting to poll or wait before using background results.
- Launching background work just because the feature exists.
