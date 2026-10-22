# Board protocol

Read this reference when you interpret `hive_background_status` output, wait for a native completion notification, reconcile one or several terminal jobs, follow a failed reconcile, cancel a lane, or meet a completion with a missing or ambiguous identity. The rules that keep you safe without it stay in `SKILL.md`: inspect the board before a dependent decision, reconcile and ignore are bookkeeping, cancel acknowledgement is not termination, and an uncertain lane never gets a second writer. This reference adds field meanings and the recovery steps, not authority.

The board is observational bookkeeping. It tracks the originating native parent and call, not the current feature or agent, and it never couples to execution, worktree, or task status. Stale and unknown observations stay visible. Multiple launch observations may exist for one native task identity when explicit runtime-owned interruption recovery is used.

<!-- hive-host opencode-v1 -->
The v1 board store is `.hive/background-jobs.json`. Returned task IDs are the observe-only board handles for status, reconcile, and cancel. Take the identity from the native `task()` result; never invent one.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
The v2 board store is `.hive/runtime/opencode-v2/background-jobs.json`. The returned `sessionID` identifies the child session, and `hive_background_status` lists the observe-only board handle for each lane, which reconcile and cancel take. Never invent an identity.
<!-- /hive-host -->
Never edit either store; the board tools are the only writers.

## Reading the board

1. Inspect the scoped board with `hive_background_status` after launching and before any dependent decision, merge, cleanup, final report, or new overlapping writing lane. `hive_status` is not that surface.
2. Follow `recommendedNextAction` when present. Use `nextActions` and `orchestrationBurden` as supporting detail for visible lanes and for reporting the pending completion notifications and reconcile items per visible and actionable lane. They support the recommended action and do not replace it.
3. `waitingForNativeCompletion` lists lanes that only wait. An empty `jobs` list is not proof that no native background work exists while completion evidence is unresolved.
4. `native_completion_pending` is a wait state. It is not a command to reconcile, cancel, or duplicate the lane.
5. Treat prompt acknowledgment as notification only. A terminal job may stop repeating in prompt detail after Hive showed it once, but it is not reconciled until you consume or intentionally ignore its result.

## Waiting

While visible lanes are only listed under `waitingForNativeCompletion` and `schedulerGuidance.reason` is `wait_for_native_completion_notification`, do not refresh the board repeatedly. If `completionNotificationsPending > 0` and `reconcileItemsRequired == 0`, wait for the native background completion notification before calling `hive_background_status` again, unless a lane is stale, wrong, no longer needed, or a new native identity must be recorded. Continue only foreground work that does not depend on the background result.

If a completion arrives without a call ID or with an ambiguous identity, record it as unknown and hint `hive_task_trace`; never guess the latest child. That must not block unrelated dispatch, but work whose ownership overlaps still needs inspection or waiting. Do not send another prompt or launch another writer.

## Reconciling

Use `hive_background_reconcile` for one terminal job and `hive_background_reconcile_batch` for several terminal jobs, after native completion and after you have acted on the results. Reconcile each board row exactly once; a batch is an alternative to individual calls, not a second pass over archived rows.

- Reconciliation returns compact per-item acknowledgements: `identifier`, `decision`, `success`, archived `state`, and `requiresHiveStatusRefresh`, or on failure `reason`, `error`, and `hint`. It archives terminal jobs and hides them from normal status output, and it does not apply task state.
- Batch success requires every item to succeed. Successful items remain archived when others fail, and a persistence failure may have published, so inspect each failure before retrying. A malformed item fails alone.
- A successful archive with feature or task scope sets `requiresHiveStatusRefresh: true`; the batch flag is true when any successful item sets it. Refresh `hive_status` when requested and before dependent feature, task, or merge decisions.
- Follow failure hints. `job_not_terminal` means wait for native completion. Stale or uncertain hints give an exact `decision: "ignored"` call with the canonical alias; inspect the lane before ignoring it.
- Archiving an observation does not prove native termination and does not authorize a replacement writer. Reconcile and ignore are bookkeeping only.

## Cancelling

Use `hive_background_cancel` only when a lane is stale, wrong, or no longer needed. A cancel acknowledgement does not prove the worker stopped, and neither do expiry, restart, archive, reconcile, or ignore. Copying mutable progress out of a worktree while the old worker may still be running is also unsafe. Inspect the lane, and for a failed ad-hoc worktree use `hive_adhoc_worktree_inspect` instead of discarding it. Installs, builds, formatters, generators, and tests count as mutations.

Cancel acts on the child session of one board row:

<!-- hive-host opencode-v1 -->
On v1 it calls OpenCode's session abort. `runtimeCancelled: true` means the abort request succeeded, and the native abort also cancels that session's running background jobs and their descendants.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
On v2 it interrupts the child session with resume disabled. `interruptAcknowledged: true` means the host accepted the interruption; `runtimeCancelled` stays `false`, and the row keeps its cancel request on record. When the board later observes the execution settle or the completion notification, it marks the row uncertain, never cancelled. Background children that the interrupted session launched keep running; this cancel does not reach them.
<!-- /hive-host -->

## Example

Launch an independent read-only lane in the background, keep doing unrelated foreground work, observe the board, then reconcile once.

<!-- hive-host opencode-v1 -->
OpenCode v1:

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
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
OpenCode v2:

```ts
const { sessionID } = subagent({
  agent: '<chosen-primary-delegated-agent>',
  description: 'Short task label',
  prompt: 'Concrete independent work with done criteria',
  background: true,
});
hive_background_status({});
// Wait for the native background completion notification, then refresh the Hive board
// instead of repeatedly refreshing or manually mutating .hive/runtime/opencode-v2/background-jobs.json.
hive_background_status({});
hive_background_reconcile({
  identifier: boardAlias, // the handle hive_background_status lists for this lane
  decision: 'reconciled',
  summary: 'Consumed the background research result.',
});
// Reconciled or ignored jobs are archived by the tool and hidden from normal status.
// For multiple different terminal lanes, batch reconciliation is an alternative to
// individual reconciliation, not a second pass over rows already archived.
```
<!-- /hive-host -->

## Board mistakes

- Forgotten terminal jobs: treating a prompt-acknowledged terminal result as reconciled, or ending the turn without waiting for native completion, refreshing, reconciling, or cancelling.
- Empty-board false negatives: treating `jobs: []` as proof that no native background work exists while completion evidence is unresolved.
- Wait-only polling: repeatedly calling `hive_background_status` while `schedulerGuidance.reason` is `wait_for_native_completion_notification`.
- Manual board mutation: editing the active host's `background-jobs.json` instead of using the board tools.
- Using `hive_status` to inspect unresolved board lanes.
