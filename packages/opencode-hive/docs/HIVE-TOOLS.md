# Hive Tools Inventory

## Standard Hive Tools (33 total)

### Feature Management (2 tools)
| Tool | Purpose |
|------|---------|
| `hive_feature_create` | Create new feature, set as active |
| `hive_feature_complete` | Mark feature completed (irreversible) |

### Repository Manifest (3 tools)
| Tool | Purpose |
|------|---------|
| `hive_repositories_status` | Inspect project repository mode and `.hive/repositories.json` |
| `hive_repositories_discover` | Discover in-workspace git repositories without mutating the manifest |
| `hive_repositories_update` | Add project-relative repositories to `.hive/repositories.json` atomically; matching legacy global topology is migration-only |

#### Repository manifest notes

- Single-repo projects use the normal git-root path; these tools manage explicit multi-repo topology when needed.
- Agents should add only repositories they have decided to work in; discovery is not bulk registration.
- Discovery is bounded to the project root, depth 4, and 50 candidates, and skips `.git`, `.hive`, `.opencode`, `node_modules`, build outputs, coverage, and temp folders.
- Updates are add-only and accept project-relative paths only. If any requested repo is invalid, the manifest is not written.

### Plan Management (4 tools)
| Tool | Purpose |
|------|---------|
| `hive_plan_write` | Write or replace the full plan.md for initial plans and major rewrites (execution truth; clears plan review comments) |
| `hive_plan_patch` | Patch bounded plan sections/tasks with `expectedRevision` from `hive_plan_read`; clears plan review comments, revokes approval, and does not sync tasks |
| `hive_plan_read` | Read plan.md and related review comments, including revision/hash; use `mode: "outline"` when full content is not needed |
| `hive_plan_approve` | Approve plan for execution |

#### Plan amendment notes

- Use `hive_plan_write` for initial plans and major rewrites where resending the full execution plan is clearer.
- Use `hive_plan_patch` for bounded review amendments by heading path or task number to avoid resending the whole plan.
- If task sequencing, dependencies, or scope changed after a patch, run `hive_tasks_sync({ refreshPending: true })` explicitly after review/approval. The patch tool never auto-syncs tasks.

### Task Management (3 tools)
| Tool | Purpose |
|------|---------|
| `hive_tasks_sync` | Generate tasks from approved plan, or refresh pending plan-backed tasks with `refreshPending: true` after a plan amendment |
| `hive_task_create` | Create manual task (not from plan) with explicit `dependsOn` and optional structured metadata |
| `hive_task_update` | Update task status or summary |

#### Task model notes

- Plan-backed tasks get their DAG from `plan.md` `Depends on:` annotations during `hive_tasks_sync`.
- Modern plans sync numbered task headings only from the `## Tasks` section. A pure final verification checklist belongs in `## Final Verification` outside the task graph unless it writes tracked artifacts.
- Plans without a `## Tasks` heading keep the legacy whole-document parser path. Modern plans with an empty or malformed `## Tasks` section sync zero tasks instead of falling back to numbered headings elsewhere.
- Manual tasks always persist explicit `dependsOn`; omitting it means `[]`, not implicit sequential ordering.
- manual tasks are append-only.
- If `order` is omitted, Hive uses the next order; explicit `order` is only accepted when it equals that next order, so intermediate insertion requires plan amendment.
- Explicit manual dependencies are only for isolated follow-up work that already depends on finished tasks; dependencies on unfinished work require plan amendment.
- Structured manual task metadata can include `goal`, `description`, `acceptanceCriteria`, `references`, `files`, `reason`, and `source`; Hive uses it to build worker-facing `spec.md` content.
- Use manual tasks for isolated ad-hoc/operator work. In the issue-72 `3b` / `3c` shape, first ask `hive-helper` for observable state clarification or interrupted-state wrap-up; only request a manual task when the follow-up can append safely after the approved DAG. If review feedback changes downstream sequencing, dependencies, or scope, amend `plan.md` instead, then run `hive_tasks_sync({ refreshPending: true })`.

### Recovery fields and failure classification

Task-backed worktree, ad-hoc worktree, and merge results carry the same recovery classification fields, added alongside all existing fields rather than replacing them. They describe where an operation stopped and what the caller may safely do next; a `NO_TRACKED_CHANGES` no-op also carries them, with `action: 'none'`. The core service owns the facts; OpenCode wrappers only render guidance from them.

| Field | Meaning |
|------|---------|
| `phase` | Where the operation stopped: `validation`, `preflight`, `finalization`, `integration`, `rollback`, `verification`, or `cleanup`. |
| `reasonCode` | Stable uppercase code naming the condition. See the classification table below. |
| `mutation` | Durable target state relative to the operation's starting state: `none`, `applied`, `partial`, `preserved`, or `unknown`. Cleanup itself never changes this value; a failed cleanup after a completed integration still reports the integration's `applied`, because the target moved. |
| `retryable` | True only when the exact same tool call may be repeated after satisfying the reported prerequisite and no durable target mutation occurred from this attempt. False whenever `mutation` is anything other than `none`. |
| `action` | The conservative recovery step: `correct_arguments`, `clean_target`, `resolve_conflicts`, `inspect_state`, `retry_same_operation`, `cleanup_only`, `start_fresh_run`, `manual_recovery`, or `none`. |

| `reasonCode` | `phase` | `mutation` | `retryable` | `action` |
|------|------|------|------|------|
| `INVALID_ARGUMENTS` | `validation` | `none` | `false` | `correct_arguments` |
| `INVALID_COMMIT_MESSAGE` | `validation` | `none` | `false` | `correct_arguments` |
| `INVALID_MERGE_MESSAGE` | `validation` | `none` | `false` | `correct_arguments` |
| `MESSAGE_NOT_ALLOWED_FOR_REBASE` | `validation` | `none` | `false` | `correct_arguments` |
| `RUN_NOT_FOUND` | `preflight` | `none` | `false` | `inspect_state` |
| `WORKTREE_NOT_REGISTERED` | `preflight` | `none` | `false` | `inspect_state` |
| `WORKTREE_LINKAGE_INVALID` | `preflight` | `none` | `false` | `start_fresh_run` |
| `WORKSPACE_TOPOLOGY_MISMATCH` | `preflight` | `none` | `false` | `start_fresh_run` |
| `WORKTREE_LOOKUP_FAILED` | `preflight` | `none` | `true` | `inspect_state` |
| `SOURCE_BRANCH_MISSING` | `preflight` | `none` | `false` | `inspect_state` |
| `TARGET_DIRTY` | `preflight` | `none` | `true` | `clean_target` |
| `GIT_OPERATION_IN_PROGRESS` | `preflight` | `none` | `false` | `inspect_state` |
| `FINALIZATION_STATE_UNKNOWN` | `finalization` | `unknown` | `false` | `inspect_state` |
| `NO_TRACKED_CHANGES` | `integration` | `none` | `false` | `none` |
| `MERGE_CONFLICT_ABORTED` | `integration` | `none` | `true` | `retry_same_operation` |
| `MERGE_CONFLICT_PRESERVED` | `integration` | `preserved` | `false` | `resolve_conflicts` |
| `GIT_OPERATION_FAILED` | `integration` | `none` | `true` | `inspect_state` |
| `ROLLBACK_FAILED` | `rollback` | `unknown` | `false` | `manual_recovery` |
| `POST_INTEGRATION_VERIFICATION_FAILED` | `verification` | `unknown` | `false` | `inspect_state` |
| `CLEANUP_FAILED` | `cleanup` | `applied` after a completed integration; `none` for cleanup-only runs | `false` | `cleanup_only` |
| `COMPOSITE_PARTIAL` | `integration` | `partial` | `false` | `inspect_state` |

- `NO_TRACKED_CHANGES` keeps its current meaning: the source had no net tracked changes to integrate, the operation is a successful no-op, `merged` stays `false`, and no `sha` is reported. An operation never reports `merged: true` when the target HEAD did not actually move; `rebase` with no applicable source commits reports this same no-op.
- `filesChanged` behavior fix: on a successful integration, `filesChanged` is the observed difference between the target HEAD immediately before integration and the target HEAD after integration. The earlier two-endpoint comparison between the target HEAD and the source branch could include files that only the target changed after the source branch forked, so it did not describe the integration. `filesChanged` is empty for a no-op, for a failure that was fully restored to its starting state, and for a preserved conflict; conflict paths remain in `conflicts`. Composite results flatten entries as `repoId:path`.
- Cleanup results report per-step status for worktree removal, branch deletion, and prune using `not_requested`, `not_attempted`, `already_absent`, `succeeded`, or `failed`, plus a `failures` list naming the step and cause. `worktreeRemoved`, `branchDeleted`, and `pruned` remain as factual projections of those steps.
- `WORKTREE_LINKAGE_INVALID` and `WORKSPACE_TOPOLOGY_MISMATCH` mean the run's worktree identity no longer matches its trusted Git registration. Neither is retryable. Recovery is a fresh authenticated attempt or ad-hoc run at an independently valid workspace, per the relocation rules in the [Operator Guide](../../../docs/OPERATOR-GUIDE.md#when-work-blocks-or-fails). Recovery never repairs, rewrites, or migrates Git metadata or roots.
- `COMPOSITE_PARTIAL` means at least one repository was integrated and a later repository failed. Earlier repositories remain integrated. Per-repository results are authoritative, and an aggregate top-level `sha` is a representative value from one repository, not a cross-repository identifier. Start recovery from the per-repository results rather than repeating the whole operation.
- When integration succeeds and requested cleanup does not fully complete, the result reports `CLEANUP_FAILED` with `action: 'cleanup_only'`. `mutation` still reflects the completed integration. Repeat only the cleanup step; the caller must not re-run the merge.

### Execution (3 tools)
| Tool | Purpose |
|------|---------|
| `hive_execution_prepare` | Arm one task or ad-hoc Forager dispatch with worktree or in-place placement |
| `hive_execution_finish` | Originating-primary-only checkpointed Git/report/disposition finalization after exact native stop evidence |
| `hive_worktree_discard` | Discard changes, reset status |

Discard, cleanup, and archival never cancel execution. Current-slot discard is refused while that source worktree has a live or unobserved claim. Uncertain workspaces stay in place; they are not reset, copied, or deleted to recover.

#### hive_worktree_discard input notes

- Omit `attemptId` to discard the current task slot, or pass the current `attemptId` for the same current-slot discard. That path may close an unconsumed arm as `not_started`, or remove an already finalized worktree and reset the task to pending. It never discards an attached, stopped, or uncertain execution.
- Pass a non-current `attemptId` only for a finalized historical worktree attempt. The current task pointer and task status stay unchanged. Attached, stopped, and unobserved attempts remain quarantined and cannot be discarded. Inspect `hive_status.unfinishedAttempts` before cleanup.

#### hive_execution_finish input notes

- `attemptId`: must identify an execution owned by the calling primary with exact structured `stopped` evidence. Worker prose and background board state never authorize finalization.
- `status` and nonblank `summary` form immutable report input. `status: 'blocked'` also requires `blocker.reason` to be nonblank; blocker data on other statuses is rejected. A stale task attempt receives an immutable historical report but cannot mutate task status or replace the current generation's `report.md` pointer.
- `message`: required whenever a non-blocked worktree placement has changes to commit. In-place and blocked finalization reject commit messages and never run Git.
- Every created commit message must contain a non-empty one-line subject, a blank line, and a non-empty descriptive body.
- Finalization persists intent first, then per-repository baseline/tree/result receipts, an immutable deterministic report receipt, generation-guarded disposition, and `finalized` last. Retry the exact same input after interruption. A commit can be adopted only when HEAD parent, tree, and exact message match the receipt; ambiguous HEAD movement requires explicit recovery.
- Composite partial commits are not rolled back. The stopped claim remains reserved until every checkpoint completes.
- The returned `reportPath` is authoritative. Task receipts live under the task's `reports/finalization-<operationId>.md`; task `report.md` links the receipt only for the current generation. Ad-hoc receipts live under `.hive/execution-reports/finalization-<operationId>.md` and have no task-local `report.md`.
- An unclassified finish failure returns `phase: 'finalization'`, `reasonCode: 'FINALIZATION_STATE_UNKNOWN'`, `mutation: 'unknown'`, `retryable: false`, and `action: 'inspect_state'`. Inspect the durable receipt, task or ad-hoc attempt state, Git state, and exact native stop evidence. If stop evidence is absent, trace or wait and keep the placement quarantined; do not finish or retry. After confirming the execution stopped and the prior finish call is no longer running, retry the identical finish input; changing it conflicts with the persisted immutable intent.

#### hive_execution_prepare output

- Returns the durable attempt ID, exact scope and placement, task/context references, arm expiry, and lifecycle facts. Native task arguments remain unchanged.
- The next Forager-derived native call from that primary consumes the sole arm and persists exact parent/call attachment before dispatch. Non-Forager calls do not consume it. Missing or ambiguous arms fail loudly.
- Worktree placement validates exact Git registration and holds claims through `stopped`; in-place placement is cooperative and creates no filesystem exclusion claim. Cross-process exclusivity is unsupported.
- In-place `directory` must be a resolved absolute path to an existing directory. Expand shell shorthand such as `~` before passing the tool argument.
- Starting the same task twice allocates atomically one active attempt; the second caller is rejected or returned the existing attempt. A feature-task worktree remains quarantined through `stopped` until the originating primary calls `hive_execution_finish`. Uncertain workspaces are preserved; they are not reset, copied, discarded, or replaced with another placement.
- Native `general` is an ordinary unmanaged delegation. It consumes no Forager arm and receives no Hive claim or lifecycle authority.
- Workers have no lifecycle mutation or commit tool. They return one terminal handoff; the originating primary calls `hive_execution_finish` only after exact stop evidence.
- Every native `task()` launch has one primary goal, one fresh subagent session, and one terminal handoff. A goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step. Give complete constraints and acceptance criteria only for that goal, and split independently verifiable outcomes into fresh launches.
- Do not pass `task_id` to `task()`. Returned task IDs are observe-only handles for background management and read-only runtime-visible session inspection with `hive_task_trace`; they are not inputs for session continuation. Recovery context belongs in a NEW task without `task_id`. Do not send a follow-up prompt to a completed, failed, or blocked session. Subagents are terminal and cannot recurse, except a delegated `architect-planner` may launch one level of read-only planning helpers; those children cannot delegate.
- The `question` tool is reserved for primary sessions. Subagents return required operator clarification as an exact terminal-response question for their parent orchestrator.
- A blocked feature continuation follows one order: exact stop evidence; `hive_execution_finish({ status: 'blocked', blocker: { reason: '<nonblank>' } })`; retain its `reportPath`; `hive_status` and `tasks.list[].blocker`; operator decision and decision record; a second `hive_status`; while status remains exactly blocked, `hive_execution_prepare` with `scope.continueFromBlocked: true` and the same finalized placement; then a new unchanged native Forager call with the decision in its prompt. The persisted blocker or immutable report is authoritative; never reconstruct blocker details from worker prose or task traces. Legacy blocked status without blocker data requires explicit inspection and blocker recovery before continuation.
- One implementation assignment normally maps to one numbered task. Amend the DAG or create an append-only manual task for a new independent deliverable.
- Preparation failures return structured scope/placement recovery guidance and never return a generated native-task payload.

### Integration (3 tools)

`hive_merge` integrates a finalized feature-task worktree. The ad-hoc tools operate on `.hive/.worktrees/adhoc/<runId>` and do not create feature/task records; ad-hoc runs do not appear in `hive_status`. In-place feature and ad-hoc executions have no Hive integration step.

Only finalized worktree attempts can be merged or cleaned up. An ad-hoc run must merge or clean up its finalized registered worktree before switching to in-place placement. In-place attempts have no merge or cleanup lifecycle.

| Tool | Purpose |
|------|---------|
| `hive_merge` | Integrate a finalized completed feature-task worktree |
| `hive_adhoc_merge` | Merge the ad-hoc branch into the current branch |
| `hive_adhoc_cleanup` | Remove the ad-hoc worktree and branch |

#### Ad-hoc worktree input/output notes

- For ad-hoc work, use multiple fresh one-goal launches on worktrees whose registered identities do not intersect, or sequence writers that share a worktree. Declared file ownership is not a concurrency guarantee. Do not use a returned task ID to continue a prior session.
- `hive_execution_prepare` creates or reuses the ad-hoc worktree and returns `runId`, exact placement, and attempt identity. `repoIds` selects manifest-backed composite workspaces. Non-git roots require a repository manifest for worktree placement.
- Prepare and finalize ad-hoc work through `hive_execution_prepare` and `hive_execution_finish`; commit receipts use the same crash-safe journal as feature tasks.
- `hive_adhoc_merge` defaults to `squash`. Both `squash` and normal `merge` require an explicit polished aggregate `message` with the same subject, separator, and body structure.
- `rebase` is an explicit history-preservation exception, accepts no aggregate message, and validates the exact raw message of every source commit before mutation. Normal merge performs the same source validation.
- `hive_adhoc_merge` returns `commitMessage` when it creates a merge/squash commit.
- A failed non-preserved integration restores the affected target repository to its original HEAD and clean state. `preserveConflicts: true` retains only an actual conflict state. Ad-hoc merge uses the same operation-scoped integration lock as `hive_merge`.
- `hive_adhoc_cleanup` accepts `runId` and optional `deleteBranch`; merge and cleanup resolve `workspacePath` and `branch` from the run ID. Cleanup never cancels execution and is refused while the source worktree has a live or unobserved claim.
- Ad-hoc prepare, finish, merge, and cleanup failures report the shared recovery fields ([Recovery fields and failure classification](#recovery-fields-and-failure-classification)) when classified. An unclassified finish failure reports `phase: 'finalization'`, `reasonCode: 'FINALIZATION_STATE_UNKNOWN'`, `mutation: 'unknown'`, `retryable: false`, and `action: 'inspect_state'`; follow the finish recovery rule above, including exact stop-evidence inspection and quarantine when evidence is absent, before retrying the identical finish input. Unclassified merge and cleanup errors use the operation phase's conservative `inspect_state` classification. Unclassified prepare errors keep their tool-specific fallback fields. See that section for `COMPOSITE_PARTIAL`, `CLEANUP_FAILED`, and per-step cleanup status.

### Background Orchestration (4 tools)

These tools are primary-agent-only and are available when the OpenCode background subagent experiment is enabled with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`. They manage Hive's scoped background job board around native OpenCode `task({ background: true, ... })` completion notifications.

| Tool | Purpose |
|------|---------|
| `hive_background_status` | List active background jobs visible to the current primary session scope, optionally including stale or archived entries and filtering by feature, task, ad-hoc run, or workflow |
| `hive_background_reconcile` | Mark a terminal native background job as reconciled or intentionally ignored with a required summary, then archive it from normal status output |
| `hive_background_reconcile_batch` | Mark multiple terminal native background jobs reconciled or intentionally ignored in one scoped operation, then archive them from normal status output |
| `hive_background_cancel` | Request cancellation for a visible background job and record runtime cancellation only after OpenCode confirms it |

#### Background orchestration notes

- With the env gate unset, the background management tools return `background_tools_disabled`. Primary agents keep normal blocking `task()` wait mode, and no background appendix is injected.
- With the env gate set, primary orchestrators receive delegate-first background scheduling guidance and the board tools are active. This is experimental-gate behavior, not the default contract.
- Gate-open delegation uses lane kind to choose how much management is required. Exploratory/read-only and review lanes are lightweight background candidates. Writing/change and execution lanes require explicit state tracking, verification routing, unresolved-lane checks before dependent decisions, and integration control. Declared file ownership is tracking metadata, not a concurrency guarantee. Concurrency exclusion is exact registered worktree identity.
- Every delegated lane needs a context packet: objective, known facts, relevant paths or references, constraints, prior failures, expected output, and where to find missing context. Put that packet directly in the ordinary native task prompt after preparation. Hive appends the authenticated scope and standing-constraint snapshot.
- Primary orchestrators choose specialists from built-in and custom agent descriptors. Do not add fixed routing tables; use the descriptor that best matches the lane.
- Ad-hoc orchestration works in both gate-closed and gate-open sessions. Non-trivial non-feature work should be decomposed, routed, tracked, verified, and integrated like orchestration, using ad-hoc worktrees for implementation branches when needed.
- In gate-open sessions, launch native background tasks, inspect the scoped board with `hive_background_status`, wait for native completion notifications before dependent decisions, refresh `hive_background_status`, and reconcile terminal jobs with `hive_background_reconcile` or `hive_background_reconcile_batch`.
- `hive_background_status` and reconcile responses include `recommendedNextAction` guidance and may set `requiresHiveStatusRefresh` after reconciliation. Treat these as board-local scheduler hints. They do not predict task merge readiness; use `hive_status` for task/worktree-aware state before merge decisions.
- Preparing an execution does not create background board state. Board state begins only when the parent launches the ordinary native background task.
- If `hive_background_status` returns `schedulerGuidance.reason: wait_for_native_completion_notification`, do not refresh repeatedly. Wait for OpenCode's native completion notification, continue unrelated foreground work, or cancel only if the lane is stale, wrong, or no longer needed.
- Prompt acknowledgment only means Hive showed the terminal result to the parent session. It does not clear `terminalUnreconciled`; the agent still needs explicit reconciliation after consuming or ignoring the result.
- Reconciled and ignored terminal jobs are archived by the background tools and hidden from normal status output. Do not edit `.hive/background-jobs.json` directly.
- Subagents must not start background tasks or manage the background board.
- Returned background task IDs are observe-only board handles for status, reconcile, and cancel. Never pass `task_id` to `task()` or treat it as an input for session continuation.
- Cancellation is not rollback. `hive_background_cancel` does not revert files, branches, worktrees, commits, or task reports; it only records a cancellation request and any confirmed runtime cancellation. Cancel is unavailable without a real native identity. Cancellation is owner-scoped: another primary must not automatically terminate another primary's child. Cancel acknowledgement is not proof of termination; live claims remain until termination is observed. Cleanup and archival never imply execution cancellation.
- The board is observational bookkeeping; `hive_status` is not that surface. Do not invent native task IDs. Exact callbacks can update board visibility and provide authenticated stop evidence, but reconciliation and ignore only archive board rows. They do not release an execution claim or authorize retry in the same workspace.
- If a background feature-task lane cannot be resumed safely, its worktree remains quarantined until authenticated stop evidence and primary finalization. For ad-hoc work, retry after finalization may reuse the same `runId` worktree. Retry while termination is unobserved cannot reuse that run; start a new ad-hoc `runId` and worktree. Ignoring stale board bookkeeping does not authorize retry. Escalate a concrete blocker to the operator when needed.

### Runtime Session Inspection (2 tools)

These primary-orchestrator-only tools inspect any explicitly identified OpenCode session visible through the connected runtime, including the caller, direct children, foreign-parent sessions, and parentless primary sessions. Authorization uses a fresh `session.get` and requires a well-formed record whose ID exactly matches `task_id`; missing, malformed, mismatched, and API-error responses return the same opaque unavailable response. The connected runtime and caller directory remain the access boundary.

| Tool | Purpose |
|------|---------|
| `hive_task_trace` | Read one runtime-visible session as a compact complete v2 situation report; optionally request turn-scoped recovery |
| `hive_task_trace_content` | Re-read and verify one allowlisted non-reasoning source field referenced by a v2 content ID |

- Trace inspection never resumes, aborts, retries, polls, or mutates the inspected session. Recovery mutations address only newly created hidden summarizer sessions.
- When a delegated result failed, blocked, timed out, was cancelled, is empty, or is unclear, start with the deterministic forensic call:

```text
hive_task_trace({ task_id: "child" })
```

The repository fixture returns the lifecycle decision plus `errors`, `changed_files`, and `latest`, with the complete tool activity in `timeline`:

```json
{
  "ok": true,
  "version": 2,
  "task_id": "child",
  "target": { "id": "child", "relationship": "direct_child" },
  "lifecycle": { "state": "terminal", "terminal": true, "reason": "idle_and_closed" },
  "errors": [
    { "kind": "tool", "step": 4, "error": { "message": "one test failed" } },
    { "kind": "retry", "step": 4, "error": { "message": "retry also failed" } }
  ],
  "changed_files": { "files": ["src/a.ts"], "exhaustive": false },
  "latest": {
    "final": { "step": 5, "text": 1 },
    "tool": { "step": 4, "call": 1 },
    "error": { "step": 4, "error": 2 }
  },
  "timeline": [
    {
      "step": 3,
      "actor": "assistant",
      "state": "closed",
      "files": [1]
    },
    {
      "step": 4,
      "actor": "assistant",
      "state": "closed",
      "tool_calls": [
        {
          "tool": 2,
          "status": "error",
          "input": { "command": "bun test" }
        }
      ],
      "errors": [1, 2]
    },
    {
      "step": 5,
      "actor": "assistant",
      "state": "closed",
      "text": ["Blocked because the upstream fixture is unavailable."]
    }
  ]
}
```

This excerpt omits `source`, `instruction`, `reasoning`, `content_dictionary`, `tool_dictionary`, `tool_rollup`, `open_tools`, and `render`. Dictionary references are one-based.

Inspect those fields before relaunching. If semantic recovery would help build a fresh handoff, call `hive_task_trace({ task_id: "child", recovery: true })`. Recovery remains untrusted, and runtime evidence such as errors, fallback cards, compacted input, invalid structure, or a non-direct-child target forces `semantic.safest_next_action.action` to `inspect` with no launch context. Any usable recovery context goes to a NEW `task()` call without `task_id`.

Long allowlisted values may be externalized. Follow the returned locator without guessing its contents:

```text
hive_task_trace_content({ task_id: "child", content_id: "<content_id from hive_task_trace>", offset: 0 })
```

- `hive_task_trace({ task_id, recovery?: boolean })` resolves the target once, captures messages and status, and normalizes every surviving source step in API order. A successful recovery attempt re-reads messages and status before publication; forensic reads do not perform that freshness pass. Compaction fidelity describes the compacted surviving source; it does not claim pre-compaction completeness.
- Omitted or false `recovery` preserves the deterministic compact forensic v2 shape: complete timeline, reasoning counts, tool dictionary/rollup, structured errors, patch files, open tools, and source-backed content locators. Its 24 KiB soft target is advisory, not a cap. Irreducible larger reports stay `ok: true`; `render.actual_bytes` is exact.
- Use `hive_task_trace({ task_id, recovery: true })` for a semantic handoff. It branches after the shared capture, normalization, and lifecycle decision and returns only lifecycle/source metadata, task instruction, the final response labelled `child_self_report`, recovery metadata, untrusted semantic phases/claims/action, deterministic structured errors, PatchPart file names, and exact render bytes. It excludes the forensic timeline/dictionaries/rollups/open tools, successful tool payloads, and raw reasoning. Long instruction/final/error values can carry a direct v2 `content_id` without a public dictionary.
- Semantic recovery requires a valid status map and a closed, idle, non-summary assistant tail with no pending/running tools. A missing target entry in a valid map means idle because OpenCode removes idle entries; an unavailable or invalid map is uncertain. Self, empty, active, or uncertain traces return `status: 'unavailable'`, ordered eligibility failures, `semantic: null`, and make zero model calls. `idle_and_closed` means only that the observed turn finished; it does not establish permanent session completion.
- The mapper sends every captured step through UTF-8-safe requests sized from model metadata or the fixed fallback envelope, runs at most four hidden summarizer sessions concurrently, preserves batch order, and requires exactly one semantic card per unique step. Split-step cards merge in fragment order. Any provider, schema, or cleanup failure falls back the whole affected step to an extractive card made only from assistant text, tool names/statuses, and structured errors; other batches continue once without retry. If no generated card survives, the reducer is skipped. Undeleted ephemeral sessions remain quarantined.
- The reducer consumes every ordered card plus deterministic error/file anchors. Generated phases must be 1-12 ordered, contiguous, non-overlapping ranges covering step 1 through N exactly; invalid output uses balanced deterministic fallback phases. Phase `basis` and `error_steps` are attached by the runtime. `source_steps` arrays are sorted context source coverage, not evidence or proof.
- Recovery `status` is `complete`, `partial`, or `unavailable`; ordered `failures` retain concurrent provider/schema/coverage and cleanup causes. `cards_source` and `phases_source` identify generated, mixed, or fallback material. Semantic output is always `untrusted: true`; generated output uses `provenance: 'summarizer_interpretation'` and may restate plaintext reasoning sent transiently to the hidden, parentless, tool-less model.
- The runtime, not the model, gates `safest_next_action`. Any partial/fallback result, deterministic error, compacted source, invalid structure, or non-direct-child relationship forces `inspect` with null context. Complete generated unfinished work from a direct child permits only `launch_fresh_task` with nonempty self-contained context; complete work with no unfinished claims returns `review_completed_work`. Recovery never accepts, merges, retries, resumes, or auto-runs work.
- After model processing, recovery re-fetches the target messages and status. A changed source digest, active target, or unavailable or invalid status map discards the generated projection without retry and returns an explicit freshness failure. A missing target entry in a valid map still means idle.
- `hive_task_trace_content({ task_id, content_id, offset? })` re-resolves the runtime-visible target, re-reads messages once, permits only the v2 non-reasoning field allowlist, and verifies byte length plus digest before returning a UTF-8-safe chunk of at most 8 KiB with `next_offset`. Changed or deleted fields return `stale_or_not_found`. No copied trace/blob store is created.
- Configure optional recovery interpretation under global `taskTraceSummarizer` (`model`, `variant`, `temperature` 0–2). Omitted model/variant use OpenCode defaults; temperature defaults to 0. This setting affects only `recovery: true` interpretation; forensic traces stay model-free. An unavailable configured model/variant produces deterministic partial fallback without provider retry. Operator reference: [Task trace summarizer](../README.md#task-trace-summarizer).
- Recovery context is input for a NEW task without `task_id`; fresh-session-only delegation remains mandatory.

### Feature-task merge details

#### hive_merge input notes

- `preserveConflicts?: boolean` defaults to `false`; when `true`, merge conflicts stay in place for an isolated helper session instead of being auto-aborted.
- `cleanup?: 'none' | 'worktree' | 'worktree+branch'` defaults to `'none'`; successful merges can keep the worktree, remove only the worktree, or remove the worktree and delete the task branch.
- `squash` is the default and creates one polished integration commit. `message` is required for both `squash` and normal `merge` and must contain a non-empty one-line subject, a blank line, and a non-empty descriptive body.
- Use `rebase` or normal `merge` only when preserving independently valuable source commits or branch topology is intentional. Hive validates every exact raw source commit message before mutation.
- Do not provide a non-blank `message` with `strategy: 'rebase'`.
- Failed integrations restore the target to its original HEAD and clean state unless an actual conflict is explicitly preserved.
- A preserved conflict leaves an active Git operation in the destination checkout. Resolve and commit that operation there; do not call `hive_merge` again while the preserved state is active. An auto-aborted conflict may be retried only after satisfying its returned recovery action, with the required merge/squash message.
- Integration locking is operation-scoped: source worktree, destination checkout, and composite repositories. Two integrations into the same destination checkout serialize. Integration while unrelated worktrees are active is allowed when source and destination do not conflict. Integration is refused while the source worktree has an active writer. The project root does not overlap every worktree merely because it is an ancestor path.

#### hive_merge output

- Returns JSON with the shared merge result envelope plus a concise `message` string.
- Shared result fields:
  - `success`
  - `merged`
  - `strategy`
  - `sha?`
  - `commitMessage?` when a merge/squash commit is created
  - `filesChanged`
  - `conflicts`
  - `conflictState` (`none`, `aborted`, or `preserved`)
  - `phase`, `reasonCode`, `mutation`, `retryable`, `action`: shared recovery classification ([Recovery fields and failure classification](#recovery-fields-and-failure-classification))
  - `cleanup.worktreeRemoved`
  - `cleanup.branchDeleted`
  - `cleanup.pruned`
  - `error?`
- The `cleanup` block also reports per-step status and a `failures` list; the three booleans remain factual projections ([Recovery fields and failure classification](#recovery-fields-and-failure-classification)).
- Composite merges also return per-repository `repos` results. Per-repository results are authoritative for what each repository integrated.
- `filesChanged` reports the observed integration delta ([Recovery fields and failure classification](#recovery-fields-and-failure-classification)).
- A branch with no net tracked changes is the successful `NO_TRACKED_CHANGES` no-op, and requested cleanup still runs when safe ([Recovery fields and failure classification](#recovery-fields-and-failure-classification)).
- If the integration succeeds but requested cleanup does not fully complete, the result reports `reasonCode: 'CLEANUP_FAILED'` with `action: 'cleanup_only'`. The integration remains in place and must not be re-run; repeat only the cleanup step.
- `conflictState: 'preserved'` means the caller requested `preserveConflicts: true` and must resolve the merge locally before cleanup can finish.

### Context (4 tools)
| Tool | Purpose |
|------|---------|
| `hive_context_read` | Read a scoped summary, bounded durable catalog, or chunked exact document |
| `hive_context_write` | Explicitly create a scoped file, or replace one whole document with revision and hash preconditions |
| `hive_context_append` | Append a dated block while preserving prior bytes and checking revision plus content hash |
| `hive_context_archive` | Selectively archive named files with a reason, revision, and per-name hashes |

Omitted `scope` retains feature-default behavior. Use `scope: "project"` explicitly for `.hive/context/`; project calls reject `feature` and `task`. An authenticated primary management session can read and mutate either scope. Authenticated bound workers and research/review helpers can read project context and their bound feature, but cannot switch features. Project mutations and all archive calls require primary management authorization. Private dash/vulnerability review lanes receive no live context inventory or bodies. Each call, including a cursor continuation, revalidates runtime session lineage and canonical workspace containment before context storage is inspected.

With no `name`, `hive_context_read` defaults to `view: "summary"`. Summary reads return revision, snapshot, stat/header inventory, durable byte totals, and character measurement state. They do not scan all bodies unless an authorized management caller explicitly sets `scanChars: true`; `durable.chars` is otherwise `null` with `charsMeasurement: "unavailable"`. Use `view: "catalog"` with optional literal `query`, `limit`, and returned `cursor` for durable metadata discovery. Catalog and management pages always return `hasMore` as the inverse of `complete`; follow `nextCursor` only while `hasMore` is true. Filtered catalogs search only `name`, `description`, and `read_when`, report those names in `searchedFields`, and retain owner only as display metadata. Catalog responses are capped at 16 KiB and never include document bodies. Named reads accept `cursor` and `maxBytes`, return `range: { startByte, endByte, totalBytes }`, `complete`, and `nextCursor`, and place the raw UTF-8 chunk in `file.content`. Pass `nextCursor` unchanged as `cursor` with the same scope and name until `complete: true`; arbitrary byte offsets are rejected. Named cursors bind version, authenticated session, canonical project, scope/feature, document name, namespace revision/control snapshot, actual content hash, and next byte boundary. Replay against another identity or document, malformed cursors, and unsupported versions return `context_cursor_stale`; changed control state or body returns `context_changed_during_read` (or `context_cursor_stale` if the byte boundary no longer exists). Start a new read explicitly after either error. `maxBytes` is the total serialized UTF-8 JSON response budget, including the cursor, not the content allowance; it defaults to 16 KiB and cannot exceed 64 KiB.

Named-read cursors carry an HMAC-SHA-256 over the entire serialized versioned payload, checked in constant time before any cursor-driven context read. Each plugin instance generates a private in-memory secret that is never exposed or persisted. Cursors expire when that instance is replaced or its process restarts; another instance rejects them with `context_cursor_stale`. Restart the named read without a cursor after that error. Authorization still runs on every continuation before cursor-driven storage access.

Call `hive_context_read` before replacement, append, or archive. Existing-content mutations require the current revision and actual SHA-256 `contentHash`; archive requires a hash for every selected name. A replacement always replaces the whole document. Finish all named-read chunks before constructing replacement content. Managed durable create and replacement require `description` and `read_when` of at most 512 Unicode code points; project durable documents also require `owner` of at most 128 code points. Legacy or directly edited over-limit metadata remains byte-preserved and filename-discoverable with bounded diagnostics. Non-reserved files default to `durable`. Their `kindSource` is `index` when a valid index entry supplies the kind and `legacy_default` when a valid or missing index has no entry. Invalid or pending control state never guesses a source. Mark raw logs and historical verification material as `evidence`; evidence remains explicitly readable but never enters worker or network prompts. Feature hygiene warnings begin above 8 durable files or 40,000 UTF-16 code units; project warnings begin above 32 files or 160,000 units. These are review signals, not aggregate admission limits.

Invalid indexes return `context_index_invalid`; surviving managed-mutation markers return `context_reconciliation_required`. Only an authenticated primary management session receives the bounded recovery envelope or can read an exact named raw document in diagnostic mode. Repair is out of band: quiesce writers, preserve and inspect the bytes, repair the index/manifest or reconcile the pending marker, then retry a normal read. Hive does not infer classification, delete files, or retry repairs automatically. Other actionable failures distinguish oversized inventory/input/response, invalid or stale cursors, root or binding mismatch, missing hashes, stale revisions, and content-hash mismatch without exposing denied scope names.

`overview`, `draft`, and `execution-decisions` are reserved and excluded from execution context. They do not accept a caller-provided `kind`. Plan approval does not archive `draft`, because cleanup failure must not make a persisted approval appear unsuccessful. Archive an obsolete draft explicitly after approval.

### Operator Constraints (4 tools)
| Tool | Purpose |
|------|---------|
| `hive_constraints_read` | Read entries, stable IDs, aggregate text, and revision |
| `hive_constraints_add` | Add one verbatim directive without replacing unrelated entries |
| `hive_constraints_edit` | Replace or explicitly remove one entry by ID and expected revision |
| `hive_constraints_clear` | Clear the whole register by expected revision after an explicit operator request |

#### Operator constraints notes

- Add only durable session-wide operator directives, not every user message, example, or task-local request. Store the operator's own wording, not a paraphrase.
- Call `hive_constraints_read` before correcting or removing an entry. `hive_constraints_edit` uses the returned stable ID and expected revision; removal requires `remove: true`.
- Call `hive_constraints_clear` only when the operator explicitly requests a whole-register clear, using the revision from `hive_constraints_read`.
- Blank additions and replacements, missing IDs, stale revisions, and aggregate content over 8000 UTF-16 code units are rejected without changing the register. Identical repeated additions are idempotent.
- Access is limited to primary orchestrators: `hive-master`, `swarm-orchestrator`, `architect-planner`, and `hive-builder`. Foragers, scouts, and reviewers cannot call it.
- The runtime adds the register text to every delegated `task()` prompt from that session, and from its task-created architect child, under the heading `## Standing Constraints (operator, session-wide)`.
- Injection is skipped for `/dash-review` and `/vuln-review` lanes. Those workflows are fixed policy with their own operator-intent contract.
- Standing constraints are operator-scoped and session-wide. Plan-declared task requirements stay task-scoped. A worker that finds the two in conflict reports the conflict rather than choosing one.

### Status (1 tool)
| Tool | Purpose |
|------|---------|
| `hive_status` | Get comprehensive feature status as JSON, including overview metadata, per-document review counts, context inclusion flags, and task/worktree-aware merge eligibility |

#### hive_status output notes

- Frozen dash-review and vulnerability-review recipients, including their recorded descendants, receive only `context: { available: false, reason: "context_authorization_denied", hint }`. The generic hint directs the recipient to an authenticated authorized session. The recipient policy runs before status storage reads, so no context names, revision, metrics, or underlying error detail are exposed.

- When the managed context summary read fails, `hive_status` degrades instead of failing: feature, plan, task, review, and helper state remain valid, and `context` becomes `{ available: false, reason, error, hint }` with null context metrics. `context_response_too_large` points to the paginated catalog because inventory construction succeeded. `context_inventory_too_large` instead requires trusted out-of-band inventory reduction or authorized exact named inspection. Invalid or pending controls point to bounded primary-management diagnostics and repair or reconciliation. Authority failures disclose no underlying error detail and direct the caller only to an authenticated authorized session. Symlink failures require removing the symlink, and concurrent change asks for a retry. `overview.exists` is still derived from disk when the summary read fails.

- A successful `context` block includes `metadataClipped` and `diagnostics` alongside `fileCount`, `files`, `revision`, and `durable`. `metadataClipped: true` means the summary exceeded the response bound and per-file descriptive metadata was omitted; the clipping notice appears in `diagnostics`. Use `hive_context_read` with the catalog view for full per-file metadata.

- `helperStatus.mergeEligibility` is the canonical operator surface for whether completed task work has a live worktree and can be considered for merge or cleanup.
- A task list item includes `traceTaskId` only after Hive deterministically associates native task metadata with that feature-task launch. Blocked and failed `nextAction` guidance includes the exact forensic call when this ID exists and explicitly says when it does not.
- Background board state is intentionally separate. Reconcile terminal background jobs first, then refresh `hive_status` before making dependent task or merge decisions.

## Review and Snapshot Runtime Tools (7 workflow-only tools)

`/dash-review` and `/vuln-review` use runtime-gated review tools. These tools are registered with the plugin but are not general-purpose operator or agent tools. Exact workflow identity, private-agent identity, pending-session state, ownership token, and lifecycle state provide runtime gates for each call.

| Tool | Purpose | Authorized caller |
|------|---------|-------------------|
| `hive_git_snapshot` | Preview a structured read-only Git snapshot set as a versioned `hive-git-snapshot/v1` envelope | Authenticated primary, operator, or external sessions that the runtime does not classify as a review role; all `/dash-review` and `/vuln-review` roles are denied |
| `hive_review_evidence_resolve` | Resolve one invocation-bound `git`, `inline`, or `local-artifacts` evidence kind and return compact fingerprints/provenance | The exact bound Stage A child; vulnerability review accepts `git` only |
| `hive_vulnerability_compare_report_read` | Consume the current vulnerability invocation's normalized prior-report capability; accepts neither a path nor a token and has no arguments | The bound vulnerability scope lane only |
| `hive_review_workspace_create` | Materialize the stored evidence plan from its exact `resolutionFingerprint`; vulnerability review also supplies its stored source-resolution fingerprint | The active workflow's generated private scope lane |
| `hive_review_workspace_claim` | Bind a created workspace to the active private primary session | The same workflow's private primary, with the returned token |
| `hive_review_workspace_inspect` | Compare the workspace with its materialized baseline and revalidate the live source identity | The owning private primary |
| `hive_review_workspace_cleanup` | Remove the disposable workspace and release its persisted run state | The owning private primary, or the vulnerability scope lane with exact failed-materialize cleanup authority |

### Direct snapshot diagnostic (`hive_git_snapshot`)

`hive_git_snapshot` is a low-level diagnostic, not the normal agent interface. It exists so an authenticated primary, operator, or external session can inspect Git state without shell access and without Git flags. Built-in Hive agents do not receive it in their tool allowlists. Private review does not use it directly; `/dash-review` and `/vuln-review` acquire Git evidence through `hive_review_evidence_resolve`, which drives the same capture engine under one-shot invocation authority.

Authorization is positive. A call proceeds only when the caller presents a non-empty agent and session identity, does not resolve to a review policy role, holds no active review invocation or vulnerability consumer reservation, and is not a review lane task target or frozen workspace recipient. Tool visibility is not an authorization boundary on its own. Denials are distinct: a review role keeps `Direct review hive_git_snapshot access is denied; use hive_review_evidence_resolve.`, a frozen review lane receives `hive_git_snapshot is not available to frozen review lanes.`, and a missing identity receives `hive_git_snapshot requires an authenticated session identity.`

#### Response envelope

Every call returns the same `hive-git-snapshot/v1` envelope, so a single-root caller and a composite caller parse one shape.

A successful call reports `status: "ready"` and `consistency: "validated"`. The `validated` value is a claim about the payload: every entry in `changedPaths`, every patch component, and the `fingerprint` describe one validated repository generation. A single root returns `snapshot`; a composite workspace returns `composite`, `manifestRepositoryIds`, `selectedRepositoryIds`, `excludedRepositoryIds`, `fingerprint`, and `snapshots`. Both carry `repositoryIds`.

A failed call reports `status: "failed"` with a `failure` object: `code`, `phase`, `repositoryIds`, a `repositories` array sorted by repository ID, an aggregate `retry`, and a bounded `message`. Each `repositories` entry carries its own `code`, `phase`, `message`, `retry`, and `elapsedMs`/`limitMs` when known. `failure.retry` is the most conservative action across the listed repositories, with precedence `not-retryable`, `operator-action`, `narrow-scope`, `fresh-capture`. Messages are derived from structured fields and never carry raw Git stderr.

#### Failure codes

The engine reports its contract codes in uppercase. Four legacy kebab-case codes (`missing-ref`, `merge-base-unavailable`, `output-truncated`, `timeout`) remain in the union and keep their historical values, because existing review renderers and tests branch on them. A caller that needs to handle every failure must accept both vocabularies; the phase and retry columns below apply to both.

| Code | Meaning | Phase | Retry |
|------|---------|-------|-------|
| `INVALID_REQUEST` | Input failed validation before any Git command ran. | `validation` | `not-retryable` |
| `MISSING_REF` / `missing-ref` | A requested ref does not resolve in the object store. | `ref-resolution` | `operator-action` |
| `MERGE_BASE_UNAVAILABLE` / `merge-base-unavailable` | No merge base exists for the comparison. | `ref-resolution` | `narrow-scope` |
| `UNSAFE_REPOSITORY_STATE` | In-scope submodule gitlink, concealed index path, unsupported filter attribute, or unrecognized untracked file type. | `preflight` | `operator-action` |
| `INCOMPLETE_UNTRACKED_CAPTURE` | Untracked inventory exceeded its count, per-file, total-byte, or deadline bound. | `untracked-capture` | `narrow-scope` |
| `OUTPUT_LIMIT_EXCEEDED` / `output-truncated` | A Git command exceeded the output byte bound. | `capture` | `narrow-scope` |
| `OPERATION_TIMEOUT` | The whole-operation deadline elapsed. | the running phase | `fresh-capture` |
| `SOURCE_DRIFT` | Repository content changed during capture and could not be revalidated. | `revalidation` | `fresh-capture` |
| `timeout` | One Git command exceeded its own bound. | `capture` | `fresh-capture` |
| `INTERNAL_ERROR` | Any other unclassified failure. | the running phase | `operator-action` |

#### Capture consistency and timing

Capture is bracketed by a generation check. The engine observes a generation marker, captures diffs, path lists, and untracked content, then re-observes the marker. A mismatch fails with `SOURCE_DRIFT` rather than returning material from two generations. The engine does not retry internally. A committed snapshot (`targetRef` or `range`) scopes the marker to resolved commits, so unrelated dirty state stays excluded.

One whole-operation deadline of 15 seconds covers repository resolution, preflight, diffs, path capture, untracked capture, and revalidation. Each Git command additionally receives the smaller of its own five-second bound and the remaining operation time. An `OPERATION_TIMEOUT` therefore reports the phase that was running and the elapsed and limit values, and is not the same as a single command exceeding five seconds.

`fresh-capture` means repeating the call starts a new capture against source that may have changed. It never resumes, repairs, or continues the previous attempt. `narrow-scope` means reduce `paths`, `maxFiles`, `maxPatchBytes`, or `repositoryIds` and call again. `operator-action` means fix the repository or the ref first. `not-retryable` means the same call fails again unchanged.

#### Per-section omissions

`omissions.changedPaths` and `omissions.patch` keep their existing meaning, and `omissions.sections` adds a per-section breakdown. Section names are `comparison`, `staged`, `unstaged`, and `untracked:<repository-relative-path>`. Each entry reports `capturedBytes`, `returnedBytes`, `omittedBytes`, and a `reason` of `section-preview-limit`, `aggregate-limit`, or `null`, and the identity `capturedBytes = returnedBytes + omittedBytes` holds per section. When a section is clipped by both the per-source preview cap and the final aggregate truncation, `reason` reports `section-preview-limit` because it is the earlier cause, and the aggregate remains visible in `patch.omittedBytes`.

#### Composite behavior

A composite snapshot set is all-or-error. Every selected repository is captured while failures are collected, and no partial success is returned. This is not a simultaneous capture: a successful set reports independently observed repository snapshots rather than one shared instant. Per-repository failures and their causes are reported in the failure envelope.

#### Hard limits

Caller-supplied `maxFiles` (cap 200) and `maxPatchBytes` (cap 256 KiB) are clamped, and the effective values appear in `limits`. Other bounds are fixed and are not caller arguments: 8 MiB per Git command, 5 seconds per Git command, 15 seconds per operation, 100 untracked files, 2 MiB per untracked file, 8 MiB total untracked bytes, 128 KiB total untracked preview, and 32 composite repositories. A request below a bound still fails when a fixed bound is exceeded, so a narrow request is the remedy rather than a larger limit.

### Review workspace lifecycle and gates

- The command hook stores immutable review intent. A validated PR fixes Git; `--artifact` fixes packet-owned local artifacts; empty dash arguments permit Git only. One invocation resolves once. Mixed kinds, replay, wrong child/primary/version, expiry, and model-supplied artifact paths fail closed.
- Create accepts fingerprints only. Git refs, repository IDs, paths, Hive scope, inline bytes, and artifact paths come from runtime-owned resolution/candidate state and are not caller arguments.
- `/dash-review` dispatches Git to `ReviewWorkspaceService` and inline/artifacts to `ReviewEvidenceBundleService`. Claim, inspect, cleanup, restart recovery, duplicate cleanup, and stale-run sweeping route from persisted owner metadata.
- Vulnerability Stage 1 rejects non-Git evidence before `BOUNDED`. Resolve cannot create. Only a fresh materialize call that exact-matches the stored `AcceptedCandidate`, evidence resolution, and source resolution can consume create authority.
- Shared dash and vulnerability preview normalization excludes internal review state from live untracked capture. It adds no public `excludePaths` parameter. Vulnerability READY requires strict descriptor, source-fingerprint, and ordered repository-fingerprint equality for both single and composite scopes.
- The scope lane returns a READY ownership token to the private primary but cannot claim or inspect the run. It can clean only an exact create result reserved for failed materialization; it cannot clean an accepted workspace. Deep review lanes cannot call any lifecycle tool. The private primary can claim, inspect, and clean but cannot create the workspace.
- Claim must succeed before deep lanes start. Runtime-bound deep children receive evidence kind, run ID, workspace path, and scope/source/resolution fingerprints. Local-path tools require absolute realpath containment under that workspace with no live-source fallback.
- Inspection compares tracked content, untracked additions, and the materialized fingerprint, then checks whether the corresponding live source identity stayed stable. A mismatch is reported; it is not repaired or rolled back.
- Persisted lease metadata supports bounded handoff, session-deletion cleanup, dead-owner recovery, and stale-run sweeping. Recovery validates recorded Git identity before removing a registered worktree and preserves anomalies it cannot safely attribute.
- Workflow agent registration, per-role tool permissions, exact private task targets, caller inference, and persisted ownership checks are separate runtime gates. A prompt instruction alone is not the authorization boundary.
- A frozen Git worktree is not an OS sandbox and does not make files immutable. Workspace inspection detects review-local drift and live-source instability; it cannot prove that an external process or a tool available to another workflow had no side effects. Each review workflow therefore documents its own narrower tool and effect policy.

### Pinned vulnerability capability lifecycle

- `--compare` is normalized by the command parser as a project-relative regular file and bound to the current invocation. The private reader accepts no path or token. Agent identity is bound from child chat metadata, then the child ID, parent ID, creation time, and agent identity are rechecked at tool context before the one-use read.
- OpenCode `session.get` supplies the child ID, parent ID, and time record but no agent identity; the chat hook supplies the agent binding. The capability is revoked on invocation replacement, a later task call, session error, idle status, session deletion, report deletion or read failure, and process restart.
- The pinned failure orders are intentionally different. A pre-execution agent lookup failure publishes `session.error`, then throws, and has no after-hook. A caught executor failure calls `tool.execute.after(..., undefined)` before recording task error state.
- The after-hook revokes the exact matching reservation without parsing output; the reservation is matched by opaque identity. Replacement, later-call, idle, deletion, and session-error cleanup remain idempotent fallbacks; stale callbacks cannot revoke newer authority.

### Skill Loading
Skills are loaded via OpenCode's native `skill` tool. Hive bundles are materialized into the global OpenCode config directory under `agent-hive/generated/opencode-skills/` and registered through `skills.paths`. No Hive plugin tool is used for skill loading. The `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` env flag enables the primary-agent background-first scheduler contract and background management tools for sessions where OpenCode exposes native background subagents.

---

## Standard Tool Categories Summary

| Category | Count | Tools |
|----------|-------|-------|
| Feature | 2 | create, complete |
| Repository Manifest | 3 | status, discover, update |
| Plan | 4 | write, patch, read, approve |
| Task | 3 | sync, create, update |
| Execution | 3 | prepare, finish, discard |
| Integration | 3 | merge, ad-hoc merge, ad-hoc cleanup |
| Background Orchestration | 4 | status, reconcile, batch reconcile, cancel |
| Runtime Session Inspection | 2 | trace, source-backed content |
| Context | 4 | read, write, append, archive |
| Operator Constraints | 4 | read, add, edit, clear |
| Status | 1 | status |
| **Total** | **33** | |

## Feature Resolution

Feature-scoped tools resolve an omitted feature in this order: current task worktree/path, current session binding, then the sole live feature. Primary sessions may select an explicit feature, and other feature-scoped tools accept an explicit feature argument where the tool supports one. The context tools (`hive_context_*`) are the exception that enforces the authenticated feature binding: a bound delegated caller cannot use `feature` to switch away from its bound feature, and a delegated caller without a binding is denied feature-scoped context operations. Primary management sessions retain explicit feature selection; project reads stay available to authenticated delegated callers, and project mutations require primary management. `hive_feature_complete` uses the equivalent `name` argument.

If multiple live features remain, the tool returns their logical names without mutating any feature. Retry with the explicit `feature` or `name` argument using one of those candidates. If no live feature exists, create one with `hive_feature_create`.

## Reserved Overview Convention

- There is no dedicated overview write tool.
- Use `hive_context_read({ feature: "feature-name", name: "overview" })` through all returned chunks first, then pass the current revision and `file.contentHash` to `hive_context_write({ feature: "feature-name", name: "overview", content, expectedRevision, expectedContentHash })`. Replacement writes the whole document. Omit both preconditions only when creating it.
- Humans review `context/overview.md` first; `plan.md` stays authoritative for execution and task parsing, and can still include a readable design summary before `## Tasks`.
- `hive_status` and the VS Code extension surface the overview as the primary human-facing document.
