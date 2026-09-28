# Hive Tools Inventory

Tool availability plus instructions govern action. Each tool validates its own operation.

## Feature Management (3 tools)

| Tool | Purpose |
|------|---------|
| `hive_feature_create` | Create a new feature without changing the selected session route |
| `hive_feature_complete` | Mark feature completed; return incomplete tasks as warnings |
| `hive_feature_select` | Set `{ feature }` as the selected session route, or `{ feature: null }` for a featureless route |

`hive_feature_create` takes required `name` and optional `ticket`. `hive_feature_complete` takes optional `name` and returns `{ success, feature, warnings }`. `hive_feature_select` requires `feature` (a name or `null`) and returns the updated session binding.

| Call | Effect |
|------|--------|
| `hive_feature_select({ feature })` | Set the session route used for omitted feature-scoped calls and child dispatch |
| `hive_feature_select({ feature: null })` | Make omitted calls and child dispatch explicitly featureless, suppressing detected and sole-live fallback |
| explicit `feature` or `name` on a feature-scoped tool | Target only that tool call without changing the selected session route |

Only `hive_feature_select` changes the selected route. Feature creation, explicit tool targets, and feature-task worktree lifecycle calls leave it unchanged. Create feature-task worktrees with an explicit feature target, then deliberately call `hive_feature_select` immediately before native `task()` dispatch when the child needs that route.

## Repository Manifest (3 tools)

| Tool | Purpose |
|------|---------|
| `hive_repositories_status` | Inspect project repository mode and `.hive/repositories.json` |
| `hive_repositories_discover` | Discover in-workspace git repositories without mutating the manifest |
| `hive_repositories_update` | Add project-relative repositories to `.hive/repositories.json` atomically; matching legacy global topology is migration-only |

Status and discover take no arguments. Update requires `repositories: [{ id, path }]` and returns `configPath`, `added`, `skipped`, `repositories`, and optional legacy cleanup details. Status reports `mode` (`manifest`, `legacy-root`, or `missing-manifest`), `configPath`, `repositories`, and optional `source`/`error`; discover reports bounded `candidates` and a `truncated` flag.

Single-repo projects use the normal git-root path. Agents should add only repositories they have decided to work in. Discovery is bounded to the project root, depth 4, and 50 candidates, and skips `.git`, `.hive`, `.opencode`, `node_modules`, build outputs, coverage, and temp folders. Updates are add-only.

## Plan Management (4 tools)

| Tool | Purpose |
|------|---------|
| `hive_plan_write` | Write or replace the full plan.md for initial plans and major rewrites (execution truth; clears plan review comments) |
| `hive_plan_patch` | Patch bounded plan sections/tasks with `expectedRevision` from `hive_plan_read`; clears plan review comments, revokes approval, and does not sync tasks |
| `hive_plan_read` | Read plan.md and related review comments, including revision/hash; use `mode: "outline"` when full content is not needed |
| `hive_plan_approve` | Approve plan for execution |

`hive_plan_write` requires `content`, accepts optional `feature`, and returns JSON `{ path, unownedTaskHeadings? }`. `hive_plan_patch` requires `expectedRevision` and `operations`, with optional `feature`; operations use `replace_section` or `insert_after_section` with `headingPath`, or `replace_task` with `taskNumber`, and each supplies `content`. Patch returns revision, content hash, and changed sections. `hive_plan_read` accepts optional `feature` and `mode: 'full' | 'outline'` (default `full`) and returns status, comments, revision, and content hash, plus either full content or headings and task list. Full read, write, and task sync include `unownedTaskHeadings: [{ line, title }]` when present. `hive_plan_approve` accepts optional `feature` and returns `{ success: true, feature }` after approval.

Inside `## Tasks`, every `###` must be `### N. Title`. Put amendments in a `####` subsection of the owning task using `replace_task`, and shared notes outside `## Tasks`. A patch that adds an unnumbered `###` there is rejected. Approval blocks while one remains or the task layout cannot be read (for example, two Tasks sections). Repair existing unnumbered headings with one `replace_section` on `headingPath: ["Tasks"]`; `replace_task` stops at the next `###` and cannot absorb an orphan heading.

If task sequencing, dependencies, or scope changed after a patch, run `hive_tasks_sync({ refreshPending: true })` explicitly after review/approval.

Plans, approval, and dependencies guide work and status visibility. They are not dispatch or status admission gates. Approval and task sync are per-feature. Cross-feature overlap or activity does not block approval; concrete prerequisites block affected execution tasks or lanes unless they leave the plan materially unresolved. Unresolved plan comments still block approval. Hive does not infer cross-feature dependencies. Authored plans keep their structural dependency checks, and sync and manual creation validate the dependencies of unfinished tasks (see [Task dependency graph](#task-dependency-graph)).

## Task Management (3 tools)

| Tool | Purpose |
|------|---------|
| `hive_tasks_sync` | Generate tasks from plan, or refresh pending plan-backed tasks with `refreshPending: true` after a plan amendment |
| `hive_task_create` | Create an append-only manual task with optional `dependsOn`, `repos`, and structured metadata |
| `hive_task_update` | Update optional task status, summary, blocker, terminal report, or successor handoff; omissions are preserved |

`hive_tasks_sync` takes optional `feature` and `refreshPending` (default `false`) and returns `created`, `removed`, `kept`, and `manual` task folders plus `unownedTaskHeadings` when present. `hive_task_create` requires `name`; optional inputs are `order`, `feature`, `description`, `goal`, `acceptanceCriteria`, `references`, `files`, `dependsOn`, `reason`, `source`, and `repos`. It returns the new task folder. `hive_task_update` requires `task`; optional inputs are `feature` (string), `status` (`pending` | `in_progress` | `done` | `blocked` | `failed` | `partial` | `cancelled`), `summary`, `report`, and `handoff` (strings), and `blocker` (an object or `null`). A non-null `blocker` requires `status: 'blocked'` or a task already blocked.

Plan-backed tasks get their DAG from `plan.md` `Depends on:` annotations during `hive_tasks_sync`. Modern plans sync numbered task headings only from the `## Tasks` section. Task numbers must be unique; a plan that reuses one is rejected before sync writes anything. A pure final verification checklist belongs in `## Final Verification` unless it writes tracked artifacts.

Sync keeps manual tasks, plan tasks with execution history, and cancelled tasks, with their reports and other files, whether or not the plan still lists them. A kept cancelled plan task appears in `kept` and a cancelled manual task stays in `manual`; neither is recreated as pending. A manual task keeps its manual origin and stored dependencies even when a plan heading produces the same folder. Pending plan tasks missing from the plan are removed. With `refreshPending: true`, pending plan tasks still in the plan take their title, dependencies, repositories, and spec from the current plan.

### Task dependency graph

A stored `dependsOn` array lists task folders. A status file without the field has no dependencies; folder numbers never imply one. Plan shorthand (a task with no `Depends on:` line depends on the previous task number) is resolved when sync compiles the plan, and the result is stored as an explicit array.

Before writing anything, sync and manual creation check the graph they would leave behind. Each dependency of an unfinished task (`pending`, `in_progress`, `blocked`, `failed`, or `partial`) must name an existing task other than itself, and unfinished tasks must not form a cycle. Dependencies of `done` and `cancelled` tasks are history: they stay in `status.json` and in `hive_status`, but they are not checked. An unfinished task may depend on a done or cancelled task, which must exist; only `done` satisfies the dependency.

A rejected sync or manual creation changes no task files. The error names the unfinished task and its missing target, self-reference, or cycle, then the repair routes that apply:

- A pending plan task with outdated stored dependencies: amend its `Depends on:` line if needed, then run `hive_tasks_sync({ refreshPending: true })`.
- A missing task that a plan heading can recreate under the same folder (`### N. Title` with a free number N and a title that produces the folder name): restore that heading and sync again. Manual creation is append-only and cannot restore an earlier folder.
- A manual task or a task with execution history: no tool edits its stored dependencies, and changing its status does not change them. If the task is obsolete and the operator approves, cancel it with `hive_task_update` and create a replacement with `hive_task_create` when the work is still needed. Cancelling releases its outgoing dependencies. It does not stop a running worker, and it does not rewire tasks that depend on it; those tasks keep the dependency and stay blocked until the operator decides what replaces it. Started work and tasks that depend on the obsolete one need an explicit operator decision; do not bulk-rewrite dependencies.

Sync validates the graph it would produce, not the current one, so a restored heading or refreshed pending task can repair a feature whose stored graph is already invalid, for example after an older sync deleted a plan task that a manual task still referenced. `hive_task_update` does not check dependencies: reopening a done or cancelled task makes its stored dependencies active again, and the next sync or manual creation reports them if they are invalid. Sync is not transactional; the check guarantees only that a rejected call writes nothing, not that a filesystem failure part way through the writes is rolled back.

`report` is a nonblank string written to `tasks/{task}/reports/{N}.md` and mirrored to `tasks/{task}/report.md`; it is not a `status.json` field. `handoff` is nonblank, limited to 2048 UTF-8 bytes (rejected rather than truncated), and replaces `tasks/{task}/handoff.md`; other updates leave it intact. The update returns `reportPath` or `handoffPath` when it writes one. An explicit status leaving blocked clears the blocker. All supplied fields are validated before any write; writes then run in order: report history, `report.md`, `handoff.md`, `status.json`. If report-history, latest-report, handoff, or status publication fails, the tool returns `success: false`, `reason: 'task_update_persistence_failed'`, `failedStage` (including `handoff`), the affected paths, and write/publication flags including `handoffPath` and `handoffWritten`. A validation rejection writes nothing. Any other failure, including a lost tool result, may still have written earlier stages, so history can hold the report while `report.md`, `handoff.md`, or status is stale. `failedWritePublished: true` means the failed destination's text matches the attempted content, possibly because it already matched before this call. It does not prove this call wrote the file or that the write is durable; the failed stage's written flag remains `false`. Treat the flags as hints: inspect the files before retrying, and do not resubmit a report that already has a history copy. `report.md` is stale only when the latest report write did not publish; an update carrying only missing status, summary, or handoff fields does not refresh it. There is no journal or repair tool.

A bound implementation Forager calls `hive_task_update({ feature, task, report, handoff })` without `status`, `summary`, or `blocker`, then returns the numbered `reportPath`. When that update fails or its result is unknown, the Forager returns the confirmed history path, the failure stage and flags, the narrative when no history copy is confirmed, and the exact handoff text when the handoff did not publish. The primary records status and summary, repairs missing fields after inspecting the files, appends review-decision, interruption, and closure reports when they apply, and reads report content rather than trusting a path. Report numbers record write order, not author or session identity. Reports stay out of task briefs and the context catalog.

Manual tasks are append-only. `dependsOn` may name existing tasks whether or not they are done; creation applies the graph check above to the new task and to every existing unfinished task, so an older invalid dependency also blocks creation. Review-sourced manual tasks cannot declare explicit dependencies. In `hive_status`, a pending task appears in `runnable` when every stored dependency is `done`; a missing `dependsOn` field counts as `[]`.

## Recovery fields and failure classification

Merge results and ad-hoc cleanup results carry recovery classification fields alongside their operation fields. Feature-task cleanup returns `worktreeRemoved`, `branchDeleted`, `pruned`, and `cleanup` without recovery fields. Create and inspect return workspace information instead. The recovery fields describe where an operation stopped and what the caller may safely do next; a `NO_TRACKED_CHANGES` no-op also carries them, with `action: 'none'`. A missing task worktree or ad-hoc run makes the merge tool throw before it returns a classified result.

| Field | Meaning |
|------|---------|
| `phase` | Where the operation stopped: `validation`, `preflight`, `integration`, `rollback`, `verification`, or `cleanup`. |
| `reasonCode` | Stable uppercase code naming the condition. |
| `mutation` | Durable target state relative to the operation's starting state: `none`, `applied`, `partial`, `preserved`, or `unknown`. Cleanup itself never changes this value. |
| `retryable` | True only when the exact same tool call may be repeated after satisfying the reported prerequisite and no durable target mutation occurred from this attempt. |
| `action` | The conservative recovery step: `correct_arguments`, `clean_target`, `reconcile_target`, `resolve_conflicts`, `inspect_state`, `retry_same_operation`, `cleanup_only`, `start_fresh_run`, `manual_recovery`, or `none`. |

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
| `TARGET_MISMATCH` | `preflight` | `none` | `false` | `inspect_state` |
| `TARGET_DIRTY` | `preflight` | `none` | `true` | `clean_target` |
| `TARGET_RECONCILIATION_REQUIRED` | `preflight` | `none` | `false` | `reconcile_target` |
| `GIT_OPERATION_IN_PROGRESS` | `preflight` | `none` | `false` | `inspect_state` |
| `NO_TRACKED_CHANGES` | `integration` | `none` | `false` | `none` |
| `MERGE_CONFLICT_ABORTED` | `integration` | `none` | `true` | `retry_same_operation` |
| `MERGE_CONFLICT_PRESERVED` | `integration` | `preserved` | `false` | `resolve_conflicts` |
| `GIT_OPERATION_FAILED` | `integration` | `none` | `true` | `inspect_state` |
| `ROLLBACK_FAILED` | `rollback` | `unknown` | `false` | `manual_recovery` |
| `POST_INTEGRATION_VERIFICATION_FAILED` | `verification` | `unknown` | `false` | `inspect_state` |
| `CLEANUP_FAILED` | `cleanup` | `applied` after a completed integration; `none` for cleanup-only runs | `false` | `cleanup_only` |
| `COMPOSITE_PARTIAL` | `integration` | `partial` | `false` | `inspect_state` |

- `NO_TRACKED_CHANGES` keeps its current meaning: the source had no net tracked changes to integrate, the operation is a successful no-op, `merged` stays `false`, and no `sha` is reported.
- `TARGET_DIRTY` covers tracked/index dirt and incoming-path collisions. `TARGET_RECONCILIATION_REQUIRED` means the integration topology is unsafe while the target contains local data, including ignored Hive state, dependencies, or build output. Reconcile the pinned target into the source worktree and return fresh pins; do not delete local data to make the retry pass. Hive's preflight scan and immediate or per-pick rechecks protect local data. Git merge flags are not the protection boundary.
- `filesChanged` on a successful integration is the observed difference between the target HEAD immediately before integration and the target HEAD after integration. Composite results flatten entries as `repoId:path`.
- Merge results include `success`, `merged`, `strategy`, `filesChanged`, `conflicts`, `conflictState`, `cleanup`, and the recovery fields above; `sha`, `commitMessage`, `reasonCode`, `repos`, and target identities appear when applicable. Both cleanup tools report per-step status for worktree removal, branch deletion, and prune using `not_requested`, `not_attempted`, `already_absent`, `succeeded`, or `failed`, plus a `failures` list in `cleanup`.
- `COMPOSITE_PARTIAL` means at least one repository was integrated and a later repository failed. Earlier repositories remain integrated. There is no rollback of partial composite outcomes.
- When integration succeeds and requested cleanup does not fully complete, the result reports `CLEANUP_FAILED` with `action: 'cleanup_only'`. Repeat only the cleanup step.

## Worktree families (8 tools)

Public names are fixed. Git helpers do not change task status, auto-commit source, or assign workers.

| Tool | Purpose |
|------|---------|
| `hive_worktree_create` | Create or select a feature-task Git workspace |
| `hive_worktree_inspect` | Inspect a feature-task workspace |
| `hive_worktree_merge` | Integrate a feature-task branch |
| `hive_worktree_cleanup` | Remove a feature-task worktree and optionally its branch |
| `hive_adhoc_worktree_create` | Create or select a temporary ad-hoc Git workspace |
| `hive_adhoc_worktree_inspect` | Inspect an ad-hoc workspace |
| `hive_adhoc_worktree_merge` | Integrate an ad-hoc branch |
| `hive_adhoc_worktree_cleanup` | Remove an ad-hoc worktree and optionally its branch |

Canonical workspace names are metadata. Existing slotted or composite workspaces are selectable. Merge wants a clean source, a destination with a clean index and tracked working tree, the pinned SHA, squash default, and an explicit message when it creates a commit. A commit message needs a nonempty one-line subject, blank line, and nonempty body. Disjoint untracked or ignored destination files may remain when the pinned source contains the pinned target history; rebase also requires a linear replay range. Unsafe topology with local data requires same-worktree reconciliation and fresh pins, even when Git reports a clean worktree because Hive state, dependencies, or build output is ignored. Incoming path collisions always block. Hive preflight and rechecks protect local data without relying on Git merge flags. Locks are operation-local. Dirty, untracked, ignored, and unmerged data is protected; there is no force or rm fallback. Same-call squash cleanup may use observed identity; later ambiguous branches stay unless `discard: true` is explicit. `deleteBranch` alone does not discard an unmerged branch.

Stable public inputs:

| Tool | Inputs |
|------|--------|
| `hive_worktree_create` | `task`; optional `feature`, `baseRef`, `repoIds`, `candidate` |
| `hive_worktree_inspect` | `task`; optional `feature`, `repoIds`, `candidate` |
| `hive_worktree_merge` | `task`; required `expectedTarget` or `expectedTargets`; optional `feature`, `repoIds`, `candidate`, `strategy`, `message`, `preserveConflicts`, `cleanup`, `sourceCommit`, `sourceCommits` |
| `hive_worktree_cleanup` | `task`; optional `feature`, `repoIds`, `candidate`, `deleteBranch`, `discard` |
| `hive_adhoc_worktree_create` | optional `runId`, optional `repoIds`, optional absolute `sourceDirectory` |
| `hive_adhoc_worktree_inspect` | `runId`, optional `repoIds`, optional absolute `sourceDirectory` |
| `hive_adhoc_worktree_merge` | `runId`; required `expectedTarget` or `expectedTargets`; optional `repoIds`, absolute `sourceDirectory`, `strategy`, `message`, `preserveConflicts`, `cleanup`, `sourceCommit`, `sourceCommits` |
| `hive_adhoc_worktree_cleanup` | `runId`, optional `repoIds`, optional absolute `sourceDirectory`, plus `deleteBranch`, `discard` |

Merge `cleanup` is `'none' | 'worktree' | 'worktree+branch'` and defaults to `'none'`. Cleanup `deleteBranch` defaults to `false`. `preserveConflicts` defaults to `false`. Do not provide a non-blank `message` with `strategy: 'rebase'`. Failed integrations attempt to restore the target unless an actual conflict is explicitly preserved. If target identity no longer matches after a commit, `recordOperationCommit` returns `POST_INTEGRATION_VERIFICATION_FAILED` with `mutation: 'unknown'` without rolling back. The same failure after squash staging retains staged operation state for inspection. A preserved conflict leaves an active Git operation in the destination checkout; do not call merge again while that state is active.

Ad-hoc worktrees are temporary workspace metadata only: no run history, evidence ledgers, or reports.

By default, a feature-task worktree lives at `.hive/.worktrees/{feature}/{task}` on `hive/{feature}/{task}`. A `candidate` changes the directory suffix to `{task}--{candidate}` and branch suffix to `{task}-{candidate}`. Composite workspaces put repository worktrees under `repos/{repoId}` and use branches `hive/{repoId}/{feature}/{task}` (with the candidate suffix when supplied). Ad-hoc runs use `.hive/.worktrees/adhoc/{runId}` and branch `hive/adhoc/{runId}`; composite branches are `hive/adhoc/{repoId}/{runId}`. An omitted `runId` is generated; an explicit one must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. The run ID is the branch suffix, so choose a readable one.

On creation, `repoIds` selects the repositories owned by the lane. Later feature-task lifecycle calls validate `repoIds` against the task's persisted repository selection; later ad-hoc lifecycle calls use `runId` to locate the persisted placement. `sourceDirectory` selects a foreign checkout and cannot be combined with `repoIds`. For create, an absolute path resolving to the active project root is treated as omitted, so it may be supplied with project/manifest `repoIds`.

Use `sourceCommit` for a legacy single-root workspace. When persisted `repos` are present, use `sourceCommits` as a complete map keyed by persisted repository ID. A singleton composite also accepts a matching scalar `sourceCommit` convenience; multiple repositories still require the complete map. At the tool boundary, the runtime fills an omitted source pin from its source inspection. A supplied composite map must match every inspected repository; it rejects a map for a legacy single-root workspace, a scalar for a multi-repository composite, both pin forms together, and any supplied pin that differs from the inspected candidate. In a worker handoff, pass the worker's returned topology-aware pin unchanged to merge.

Inspect also returns destination state. A legacy result has top-level `target` and `comparison`; composite results put them only under `repos[repoId]`. `target` is `{ path, ref, commit }`, where `path` is the canonical absolute destination root, `ref` is the full `refs/heads/...` name or `null` when detached, and `commit` is the full OID. If destination identity cannot be read, inspect retains source details and returns `target: null` with `comparison.status: 'error'`. Comparison is one of `{ status: 'ok', targetIsAncestorOfSource }`, `{ status: 'no-common-ancestor' }`, or `{ status: 'error', error }`. A shallow repository may therefore report locally no common ancestry; inspect never fetches and ancestry does not establish semantic completeness.

Every merge must include the exact inspect value as `expectedTarget` for legacy mode or `expectedTargets` as a complete exact-key map for composite mode. A singleton composite accepts a scalar expectation and normalizes it without changing identity values. Missing, both, malformed, extra, or topology-incompatible expectation forms fail with `INVALID_ARGUMENTS`. Runtime forwarding never fills or refreshes target expectations. `TARGET_MISMATCH` includes expected and observed identities, performs no mutation, is not retryable, and requires `inspect_state`. All composite targets are checked before the first repository mutation and each target is checked again at its integration boundary. Earlier composite integrations remain when a later boundary fails.

The identity guard coordinates Hive operations under the existing repository locks. It does not exclude arbitrary Git writers or another lock namespace; callers still need exclusive destination ownership. Squash integration rechecks identity after staging and before commit. If it moved, Hive leaves the source and staged operation state for inspection and reports post-integration verification with unknown mutation rather than committing or destructively resetting external changes. Cleanup checks full target path/ref/commit plus the source pin, including no-op cleanup.

## Background Orchestration (4 tools)

These tools are primary-agent-only and are available when the OpenCode background subagent experiment is enabled with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`. They manage Hive's scoped background job board around native completion notifications from OpenCode `task({ background: true, ... })`.

| Tool | Purpose |
|------|---------|
| `hive_background_status` | List background jobs visible to the originating native parent and call |
| `hive_background_reconcile` | Mark a terminal native background job as reconciled or intentionally ignored with a required summary, then archive it from normal status output |
| `hive_background_reconcile_batch` | Mark multiple terminal native background jobs reconciled or intentionally ignored in one scoped operation, then archive them from normal status output |
| `hive_background_cancel` | Request cancellation for a visible background job and record runtime cancellation only after OpenCode confirms it |

`hive_background_status` takes optional `feature`, `task`, `adHocRunId`, `workflow`, and `includeArchived` (default `false`). The result contains `jobs`, `scope`, `recommendedNextAction`, `requiresHiveStatusRefresh`, and scheduler/notification guidance when applicable. `hive_background_reconcile` requires `identifier`, `decision: 'reconciled' | 'ignored'`, and `summary`; the batch form requires an `items` array with those fields per item and returns individual results. Cancel requires `identifier` and `reason`; its response distinguishes `runtimeCancelled` from a recorded request.

The board observes the originating native parent and call, not the current feature or agent. Stale and unknown observations stay visible. It does not couple to execution, worktree, or task status. Multiple launch observations may exist for one native task identity when explicit runtime-owned interruption recovery is used. If completion lacks a call ID or its identity is ambiguous, record unknown and hint `hive_task_trace`; never guess the latest child. Missing or ambiguous completion identity must not block unrelated dispatch, but ownership-overlapping work still requires inspection or waiting; do not send another prompt or launch another writer.

With the env gate unset, the background management tools return `background_tools_disabled`. Primary agents keep normal blocking `task()` wait mode. With the env gate set, primary orchestrators receive delegate-first background scheduling guidance and the board tools are active.

`hive_background_status` and reconcile responses include `recommendedNextAction` guidance and may set `requiresHiveStatusRefresh` after reconciliation. Treat these as board-local scheduler hints.

Reconcile terminal background jobs first, then refresh `hive_status` before dependent task or merge decisions for scoped feature/task work.

If `hive_background_status` returns `schedulerGuidance.reason: wait_for_native_completion_notification`, do not refresh repeatedly. Wait for OpenCode's native completion notification.

Cancellation is not rollback. Cancel acknowledgement does not prove the worker stopped. Do not invent native task IDs. Reconcile and ignore archive board rows only.

## Runtime Session Inspection (2 tools)

These primary-orchestrator-only tools inspect any explicitly identified OpenCode session visible through the connected runtime. Authorization uses a fresh `session.get` and requires a well-formed record whose ID exactly matches `task_id`. Trace is read-only bounded native identity and freshness, not an allowance.

| Tool | Purpose |
|------|---------|
| `hive_task_trace` | Read one runtime-visible session as a compact complete v2 situation report; optionally request turn-scoped recovery |
| `hive_task_trace_content` | Re-read and verify one allowlisted non-reasoning source field referenced by a v2 content ID |

`hive_task_trace` requires `task_id` and accepts optional `recovery` (default `false`). `hive_task_trace_content` requires `task_id` and `content_id`, with optional UTF-8 byte `offset` (default zero); its response includes byte count, SHA-256, and `next_offset` for continuation.

Trace inspection never resumes, aborts, retries, polls, or mutates the inspected session.

```text
hive_task_trace({ task_id: "child" })
```

If semantic recovery would help build a fresh handoff, call `hive_task_trace({ task_id: "child", recovery: true })`. Recovery remains untrusted and never authorizes continuation. Every returned task result is terminal, so follow-up work uses a fresh child session and may reuse the same Hive task/worktree. Primaries must not pass `task_id` or infer eligibility from task output, trace, `idle_and_closed`, board state, cancellation acknowledgement, or transcript quality. Pass `task_id` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation; otherwise launch fresh. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer.

Use a successful, intelligible terminal return as the normal handoff, subject to the required review and verification checks. Trace when a specific unresolved question about output, lifecycle, verification evidence, or material instruction compliance could change acceptance or recovery, or when the operator explicitly requests an audit. Name the question before tracing; use `hive_task_trace_content` only for source fields needed to answer it, and stop when it is resolved. A named skill alone does not require a trace, and a terminal return need not list skill loads.

Required skills must still be loaded before covered work. Audit skill loading only for an explicit operator audit request or a concrete concern about material noncompliance. During that audit, check the forensic timeline for successful native `skill` calls with the exact required names before the covered work. A self-report or late load does not prove timely loading; a successful load does not prove adherence to the skill. Missing or incomplete evidence is not a confirmed omission; keep the audit and affected acceptance question unresolved. An omitted or late required load requires a fresh child after the prior child is terminal, with the requirement preserved. If trace tools are unavailable, report the limitation and keep the affected acceptance question unresolved.

Omitted or false `recovery` preserves the deterministic compact forensic v2 shape. Its 24 KiB soft target is advisory, not a cap. Irreducible larger reports stay `ok: true`; `render.actual_bytes` is exact.

A missing target entry in a valid map means idle because OpenCode removes idle entries; an unavailable or invalid map is uncertain. `idle_and_closed` means only that the observed turn finished.

Semantic output is always `untrusted: true`. Generated `source_steps` arrays are sorted context source coverage, not evidence or proof. Never accept, merge, retry, resume, or auto-run from recovery output.

Configure optional recovery interpretation under global `taskTraceSummarizer` (`model`, `variant`, `temperature` 0–2). Operator reference: [Task trace summarizer](../README.md#task-trace-summarizer).

## Context (4 tools)

| Tool | Purpose |
|------|---------|
| `hive_context_read` | Read a scoped summary, bounded durable catalog, or chunked exact document |
| `hive_context_write` | Explicitly create a scoped file, or replace one whole document with revision and hash preconditions |
| `hive_context_append` | Append a dated block while preserving prior bytes and checking revision plus content hash |
| `hive_context_archive` | Selectively archive named files with a reason, revision, and per-name hashes |

All four context tools accept optional `scope: 'feature' | 'project'` (default `feature`) and optional `feature` for feature scope. Read also accepts `name`, `view: 'summary' | 'catalog'`, `query`, `limit`, `cursor`, `maxBytes`, and `scanChars`, subject to the view restrictions below. Write requires `name` and `content`, with optional `kind`, `task`, `expectedRevision`, and `expectedContentHash`; omit the preconditions only when creating a missing file. Append requires `name`, `content`, `expectedRevision`, and `expectedContentHash`, with optional `section` and `task`. Archive requires `names`, `reason`, `expectedRevision`, and `expectedContentHashes`.

Omitted `scope` retains feature-default behavior. Use `scope: "project"` explicitly for `.hive/context/`. Tool scope selects data. Foragers and reviewers write feature and project context through revision and content-hash checks. Scouts are read-only. Archive is primary-only.

With no `name`, `hive_context_read` defaults to `view: "summary"`. Use `view: "catalog"` with optional literal `query`, `limit`, and returned `cursor` for durable metadata discovery. Named reads accept `cursor` and `maxBytes`, return `range: { startByte, endByte, totalBytes }`, `complete`, and `nextCursor`. `maxBytes` defaults to 16 KiB and cannot exceed 64 KiB.

For shared contracts, repository-wide conventions, or cross-feature decisions, permitted non-isolated agents consult the project catalog alongside relevant feature context. Catalog `task` associations are relevance hints, not filters or authority. See [context-engineering](../skills/context-engineering/SKILL.md) for selective reads and review isolation.

Call `hive_context_read` before replacement, append, or archive. Existing-content mutations require the current revision and actual SHA-256 `contentHash`. Non-reserved files default to `durable`. Mark raw logs and historical verification material as `evidence`. Feature hygiene warnings begin above 8 durable files or 40,000 UTF-16 code units; project warnings begin above 32 files or 160,000 units. These are review signals, not aggregate admission limits.

`overview`, `draft`, and `execution-decisions` are reserved and excluded from the durable catalog and durable-context hygiene counts. They remain readable by name. They do not accept a caller-provided `kind`; the per-document size limit still applies. Plan approval does not archive `draft`. Archive an obsolete draft explicitly after approval.

## Operator Constraints (4 tools)

| Tool | Purpose |
|------|---------|
| `hive_constraints_read` | Read entries, stable IDs, aggregate text, and revision |
| `hive_constraints_add` | Add one verbatim directive without replacing unrelated entries |
| `hive_constraints_edit` | Replace or explicitly remove one entry by ID and expected revision |
| `hive_constraints_clear` | Clear the whole register by expected revision after an explicit operator request |

All four tools accept optional `scope: 'session' | 'feature'` (default `session`) and optional `feature` only for feature scope. Add requires `constraints`; edit requires `id`, `expectedRevision`, and exactly one of `constraints` or `remove: true`; clear requires `expectedRevision`. Read takes no other inputs and returns `entries`, `revision`, `constraints`, and `constraintsChars`.

Scope is `session` (default) or `feature`. Add only durable operator directives that span phases, turns, or delegated assignments, including an explicit named-skill requirement in a task request that governs multiple children. Store the operator's own wording. A one-assignment requirement belongs in the task handoff. Call `hive_constraints_read` before correcting or removing an entry. Call `hive_constraints_clear` only when the operator explicitly requests a whole-register clear. Blank additions and replacements, missing IDs, stale revisions, and aggregate content over 8000 UTF-16 code units are rejected. Identical repeated additions are idempotent.

Only primaries can add, edit, or clear constraints. Workers receive the injected register and may read it. That is tool exposure, not a semantic runtime gate. Inherited session and feature labels travel with every child captured at dispatch, including review children. If they conflict, the agent surfaces the conflict. Do not promote context files into constraints.

## Status (1 tool)

| Tool | Purpose |
|------|---------|
| `hive_status` | Get feature metadata, task summaries, dependency readiness, and feature-task worktrees as JSON |

The response is `{ feature, tasks, runnable, blocked, worktrees }`, with optional config fallback `warning` and freshness failure `specFreshnessError`. For a known feature, `feature` has `name`, `status`, `tasks`, `hasPlan`, `commentCount`, and `reviewCounts: { plan }`; for an unknown feature or missing `feature.json`, it is `null` and the other summaries may be empty. Both `tasks` and `feature.tasks` hold task summaries (`folder`, `name`, `status`, `origin`, optional `planTitle`, `summary`, `repoIds`) with `dependsOn` (the stored dependency folders, `[]` when the field is missing, kept on done and cancelled tasks as history), `specStale` (true/false/null), `specStaleReason`, and `hasHandoff`. `runnable` and `blocked` are computed from the same `dependsOn` values. The response lists only forward edges; to find the tasks that depend on one, scan the other entries' `dependsOn`, and judge the actual impact separately. Reasons: `matches_plan`, `differs_from_plan`, `manual_task`, `plan_missing`, `plan_invalid`, `task_not_in_plan`, `spec_missing`, `unowned_heading_after_task_section`, and `freshness_unavailable` when a check fails (with top-level `specFreshnessError`). `differs_from_plan` compares stored spec text with what the current plan would generate, including generator or manual-spec changes; unrelated plan sections do not affect it. `runnable` is a list of folders and `blocked` maps folders to unmet dependencies. Read `status.json`, `spec.md`, `handoff.md`, and reports for bodies. Ad-hoc runs and the background board do not appear in this response.

### Native feature-task brief

Only native `task()` dispatches whose agent resolves to base `forager-worker` (built-in or custom variant) **and** whose route snapshot has an explicitly selected feature (`selected: true`) are eligible. Fallback and explicit-null routes get neither brief nor notice. The binding is the authored assignment's first non-empty line, trimmed: `Hive task: <task-folder>` for a task listed for that feature. After the unchanged route-snapshot block, a bound dispatch receives a generated block bounded by `<!-- hive-task-brief:start -->`, `## Hive task brief`, and `<!-- hive-task-brief:end -->`, at most 2048 UTF-8 bytes:

- A framing line, then `Task: <folder> - <plan title> (<status>)`; long titles end in `...`.
- `Spec: <abs path> - specStale: <v> (<reason>)` is always present; use `freshness_unavailable` when freshness cannot be computed.
- `Plan: <abs path>[ lines a-b]` is omitted if `plan.md` is missing. Unowned-heading line numbers after the task's section follow when present.
- `Handoff: <abs path>` appears when this task has a successor handoff.
- `Dependencies:` lists `- <folder> (<status>)[ handoff: <abs path>]` entries from the task record's `dependsOn`, with `unknown` for unknown folders, or `Dependencies: none`.
- The durable catalog count includes the `hive_context_read` call; `Execution decisions: <abs path>` appears when present. No document bodies are included.

To fit the budget, trailing dependency entries are dropped with `- (+<k> more; see hive_status)`. If still too long, retain core lines plus unowned-heading and handoff lines, then core lines alone; never cut a path. When locators cannot fit, the result is `Hive task brief unavailable: locators exceed 2048 bytes.` An eligible unbound dispatch gets one line under the heading: `No Hive task binding: ...` (missing/invalid marker or unknown folder); composition errors give `Hive task brief unavailable: <message>`. On each task dispatch, only generated blocks (a start marker immediately followed by its heading line) are replaced, for any agent; marker text quoted elsewhere in an authored assignment is preserved. Reviewers, scouts, advisors, and helpers never receive a brief. For task-scoped review, the primary supplies feature/task identity, plan path and current section, spec path, and current `specStale`/`specStaleReason` from `hive_status`; code reviewers cannot query `hive_status`.

## Snapshot

`hive_git_snapshot` is a low-level diagnostic. Inputs are optional `directory`, `repositoryIds`, `baseRef`, `targetRef`, `range`, `paths`, `maxFiles`, and `maxPatchBytes`. `directory` must be an absolute exact Git top-level and cannot be combined with `repositoryIds`; `repositoryIds` requires a manifest. It returns a `hive-git-snapshot/v1` envelope: `{ schema, status: 'ready', consistency: 'validated', snapshots: [{ repositoryId, snapshot }] }`, or `{ schema, status: 'failed', consistency: 'failed', failures: [{ repositoryId?, code, phase, retry, message }] }`. Capture is bracketed by a generation check that fails with `SOURCE_DRIFT`. One 15-second operation deadline covers the whole capture.

Each snapshot has `repository`, `scope`, `consistency`, `limits`, `changedPaths` (comparison, staged, unstaged, untracked), `fingerprint`, `patch`, and `omissions` (counts by changed-path group, patch truncation/omitted bytes, and per-section captured/returned/omitted bytes and reason). Error codes are `INVALID_REQUEST`, `UNSAFE_REPOSITORY_STATE`, `INCOMPLETE_UNTRACKED_CAPTURE`, `OUTPUT_LIMIT_EXCEEDED`, `OPERATION_TIMEOUT`, `SOURCE_DRIFT`, `INTERNAL_ERROR`, `missing-ref`, `merge-base-unavailable`, `output-truncated`, and `timeout`. Phases are `validation`, `ref-resolution`, `preflight`, `capture`, `untracked-capture`, `revalidation`, or `serialization`; retry values are `fresh-capture`, `narrow-scope`, `operator-action`, or `not-retryable`. `maxFiles` defaults to 100 (cap 200); `maxPatchBytes` defaults to 64 KiB (cap 256 KiB). Supplied limits above the caps are clamped. At most 32 repositories can be captured in one call. A composite snapshot set is all-or-error.

`/dash-review` and `/vuln-review` are ordinary orchestrators over natural folders, inline text, or the current checkout. Optional snapshot `directory` and an ad-hoc worktree cover a foreign PR or ref.

## Skill Loading

Skills are loaded via OpenCode's native `skill` tool. Hive bundles are materialized into the global OpenCode config directory under `agent-hive/generated/opencode-skills/` and registered through `skills.paths`. The `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` env flag enables the primary-agent background-first scheduler contract and background management tools for sessions where OpenCode exposes native background subagents.

## Standard Tool Categories Summary

| Category | Count | Tools |
|----------|-------|-------|
| Feature | 3 | create, complete, select |
| Repository Manifest | 3 | status, discover, update |
| Plan | 4 | write, patch, read, approve |
| Task | 3 | sync, create, update |
| Worktree | 4 | create, inspect, merge, cleanup |
| Ad-hoc worktree | 4 | create, inspect, merge, cleanup |
| Background Orchestration | 4 | status, reconcile, batch reconcile, cancel |
| Runtime Session Inspection | 2 | trace, source-backed content |
| Context | 4 | read, write, append, archive |
| Operator Constraints | 4 | read, add, edit, clear |
| Status | 1 | status |
| Snapshot | 1 | git snapshot |

## Feature Resolution

Feature-scoped tools resolve in this order: explicit `feature` or `name`, selected session route (including null), detected feature worktree/path, then the sole live feature. The same effective route is captured for child dispatch. An explicit target wins only for that call and never changes the selected route. Explicit null suppresses detected-context and sole-live fallback. Without a resolved feature, a feature-required tool throws an error asking for `hive_feature_select` or an explicit feature. If no live feature exists, create one with `hive_feature_create`.

## Reserved Overview Convention

- There is no dedicated overview write tool.
- Use `hive_context_read({ feature: "feature-name", name: "overview" })` through all returned chunks first, then pass the current revision and `file.contentHash` to `hive_context_write`.
- Humans review `context/overview.md` first; `plan.md` stays authoritative for execution and task parsing.
- Read the overview with `hive_context_read`; the VS Code extension also surfaces it for human review. `hive_status` returns feature and task summaries without overview content.
