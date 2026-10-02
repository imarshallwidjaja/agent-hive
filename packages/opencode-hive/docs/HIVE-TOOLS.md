# Hive Tools Inventory

Tool availability plus instructions govern action. Each tool validates its own operation.

## Agent Tool Access

Hive registers ordered `agent.permission` rules in OpenCode. Each Hive role starts with `'hive_*': 'deny'`, followed by exact allows and native permissions. OpenCode v1.18.30 appends these rules after global permissions and evaluates the last matching wildcard rule, so a global `{"*":"allow"}` cannot reopen a role-denied Hive tool. The rule also covers future `hive_*` names. Custom agents inherit their base role's permissions.

OpenCode's `experimental.primary_tools` adds session-level deny rules when native `task()` creates a child. These come after agent rules, including for delegated Architect. Hive preserves operator-supplied entries and adds `question` plus these primary-only Hive operations:

- Feature control: `hive_feature_complete`, `hive_feature_select`.
- Plan/task control: `hive_plan_approve`, `hive_tasks_sync`, `hive_task_create`.
- Integration/placement: `hive_worktree_merge`, `hive_worktree_cleanup`, `hive_adhoc_worktree_create`, `hive_adhoc_worktree_merge`, `hive_adhoc_worktree_cleanup`.
- Constraints/archive: `hive_constraints_add`, `hive_constraints_edit`, `hive_constraints_clear`, `hive_context_archive`.
- Parent-owned board: `hive_background_status`, `hive_background_reconcile`, `hive_background_reconcile_batch`, `hive_background_cancel`.

Delegated Architect retains its inherited route and uses explicit feature arguments for planning. It may register discovered repositories through `hive_repositories_update`; other subagent roles' Hive allowlists exclude that tool. It returns approval, sync, archive, and board/control requests to the parent. Its `task` permission allows one terminal layer of blocking Scout, plan-reviewer, approach-advisor, their custom variants, and `hive-helper`; `task` is deliberately absent from `primary_tools`, and `subagent_depth: 2` supports this helper grandchild. Independent permitted calls may be emitted together. Child-role rules take precedence over a background appendix without loading the primary-only `background-delegation` skill; child board tools remain unavailable. Architect as primary or child routes multi-step trace/evidence questions and known identities to Helper and performs single direct spot-check reads itself. Helper is read-only and terminal, retaining inherited child-session denials. Other subagents cannot delegate or ask questions. Execution primaries can dispatch registered workers, reviewers, Architect, Helper, and ordinary native subagents, but cannot dispatch another primary or an unknown target. Review primaries dispatch inspection-only specialists and Helper.

`hive_feature_create` stays available to delegated Architect so it can create the feature that owns its plan without changing the inherited session route.

### Access matrix

Abbreviations enumerate exact tools:

- **R**: `hive_context_read`, `hive_constraints_read`, `hive_plan_read`, `hive_status`, `hive_repositories_status`, `hive_git_snapshot`.
- **C**: `hive_context_write`, `hive_context_append`.
- **I**: `hive_worktree_inspect`, `hive_adhoc_worktree_inspect`.
- **T**: `hive_task_trace`, `hive_task_trace_content`.
- **B**: all four `hive_background_*` tools listed above; still experiment-gated.
- **M**: `hive_constraints_add`, `hive_constraints_edit`, `hive_constraints_clear`.
- **P**: `hive_feature_create`, `hive_feature_select`, `hive_plan_write`, `hive_plan_patch`, `hive_plan_approve`, `hive_tasks_sync`, `hive_repositories_discover`, `hive_repositories_update`, `hive_context_archive`.
- **V**: `hive_feature_select`, `hive_adhoc_worktree_create`, `hive_adhoc_worktree_cleanup` for operator-authorized isolated review placement.

| Agent | Hive tools | Native boundary / usage |
|-------|------------|-------------------------|
| `hive-master` | All 37 registered Hive tools | Primary; integration and cleanup owner |
| `swarm-orchestrator` | All 37 | Primary; integration and cleanup owner |
| `hive-builder` | All 37 | Primary; ad-hoc integration and cleanup owner |
| `architect-planner` (primary) | R + C + I + T + B + M + P | Planning only; terminal planning helpers and Helper investigation; edit denied |
| `architect-planner` (task child) | R + C + I + T + `hive_feature_create`, `hive_plan_write`, `hive_plan_patch`, `hive_repositories_discover`, `hive_repositories_update` | Feature/plan/context authoring, repository registration, terminal planning helpers and Helper investigation; edit/question/board denied |
| `scout-researcher` | R + `hive_repositories_discover` | Read-only retrieval; edit/task/question denied; trace retrieval goes to Helper |
| `forager-worker` | R + C + I + T + `hive_task_update`, `hive_worktree_create` | Assigned implementation/recovery; task/question denied; own report/handoff only |
| `hive-helper` | R + I + T | Feature/ad-hoc investigator; edit/task/question denied; shell/external inspection-only scope is instruction-bound |
| `plan-reviewer` | R + C | Authorized hash-guarded context only; edit/task/question denied |
| `code-reviewer` | R + C | Same; trace-dependent review needs supplied evidence or primary/Helper investigation |
| `simplicity-reviewer` | R + C | Same |
| `approach-advisor` | R + C | Same |
| `vulnerability-reviewer` | R + C | Same; shell/scanners/external probing additionally forbidden by its instructions |
| `dash-reviewer` | R + C + I + T + B + M + V | Hidden review primary; edit and plan/task/integration mutations denied |
| `vulnerability-review-primary` | R + C + I + T + B + M + V | Hidden review primary; same |
| Custom derivatives of all seven supported bases | Exactly their base's set | Inherit base prompt and permissions; extra skills do not expand authority |
| Native `general`, `explore` | None (`'hive_*': 'deny'`) | Ordinary tools; task/question denied; native `skill` allowed; explore edit denied |
| Hidden `__hive_task_trace_summarizer` | None (`'*': 'deny'`) | Supplied evidence only; all tools denied |

`hive_task_update` access is tool-level, not field-level authorization: Forager's own-report/handoff restriction and task ownership remain instructions. Helper/reviewer Hive-tool denials and native edit denial are enforced by OpenCode. These roles retain shell and research integrations under operator permissions; their inspection-only scope for shell and external effects is instruction-bound, an operator-accepted risk. Helper must return mutation requests to the primary and must not substitute shell or external calls for denied Hive operations. Forager's feature-worktree creation is retained for explicitly assigned placement; ad-hoc creation and new-lane orchestration stay with the primary. Its trace tools support assigned recovery, not worker lifecycle control.

Reserved custom-agent IDs, including `general`, `explore`, `dash-reviewer`, and `vulnerability-review-primary`, are skipped with warnings naming the managed identity and the reason. Native `agent.general`/`agent.explore` Hive/task/question/skill overrides and `explore` edit overrides are dropped with a warning listing the replaced permission keys; unrelated rules remain intact.

The Scout prompt and its managed-context skill do not require session traces. Review prompts and packaged review skills, including `adversarial-review`, do not instruct reviewers to call either trace tool; they retain their host's role boundary. Shared system, routing, and skill-auto-load appendices require native `skill`, which is allowed for every ordinary role. Arbitrary operator-installed skills and external tools remain subject to their exposed capabilities and the host role; report a conflict rather than expanding authority or improvising a substitute.

Implementation references for the supported OpenCode baseline, all at `v1.18.30`:

- [Agent config normalization](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/core/src/v1/config/agent.ts): deprecated `tools` converts only during decoding. Hive uses the enforced permission shape in its post-decode config hook.
- [Agent construction](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/agent/agent.ts) and [plugin config hooks](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/plugin/index.ts): per-agent rules append after global rules, including plugin-set rules for native `general`/`explore`.
- [Permission evaluation/filtering](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/permission/index.ts) and [tool selection](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/llm/request.ts): ordered wildcard matching removes denied tools from the model's callable set.
- [Native task creation](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/tool/task.ts) and [child permission derivation](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/agent/subagent-permissions.ts): child-session denials are retained through nested delegation. Existing sessions reused with `task_id` do not get new creation-time rules; after a plugin change, reload the host and launch fresh child sessions.

The canonical permission regression suite is `src/runtime.test.ts`: both agent modes, all Hive tools, every supported custom base, hostile global/native allows, future tool names, wildcard key order, child/grandchild-session denials, dropped native permission warnings, managed-agent ID collisions, and Architect's terminal helper layer. `packages/hive-core/src/services/configService.test.ts` owns reserved-name warning coverage. Agent permissions bound OpenCode tool calls; direct plugin/service invocation is still governed by that API's own validation.

## Feature Management (3 tools)

| Tool | Purpose |
|------|---------|
| `hive_feature_create` | Create a new feature without changing the selected session route |
| `hive_feature_complete` | Mark feature completed; return incomplete tasks as warnings |
| `hive_feature_select` | Set `{ feature }` as the selected session route, or `{ feature: null }` for a featureless route |

`hive_feature_create` takes required `name` and optional `ticket`. `hive_feature_complete` takes optional `name` and returns `{ success, feature, warnings }`. Completion warnings include missing/unreadable task status folders as incomplete entries with `status: null` and `integrity.reason` (`status_missing` or `status_unreadable`), alongside healthy tasks that are neither done nor cancelled. `hive_feature_select` requires `feature` (a name or `null`) and returns the updated session binding.

| Call | Effect |
|------|--------|
| `hive_feature_select({ feature })` | Set the session route used for omitted feature-scoped calls and child dispatch |
| `hive_feature_select({ feature: null })` | Make omitted calls and child dispatch explicitly featureless, suppressing detected and sole-live fallback |
| explicit `feature` or `name` on a feature-scoped tool | Target only that tool call without changing the selected session route |

Only `hive_feature_select` changes the selected route. Feature creation, explicit tool targets, and feature-task worktree lifecycle calls leave it unchanged. Create feature-task worktrees with an explicit feature target. Before native `task()` dispatch, call `hive_feature_select` only when the selected route is unset or differs from the dispatch target, or the selection evidence below is missing or uncertain. Reuse a matching selection across a same-feature batch only when this session's most recent route-changing call visible in context is `hive_feature_select` for that same feature, with no later explicit-null or other-feature selection. When that evidence is not visible (for example after compaction or a summary, at session start, or in mixed ad-hoc/feature batches), or you are uncertain, call `hive_feature_select` for the dispatch target. Explicit null suppresses fallback and stays featureless unless the dispatch intentionally targets a feature.

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

`hive_plan_write` requires `content`, accepts optional `feature`, and returns JSON `{ path, unownedTaskHeadings? }`. `hive_plan_patch` requires `expectedRevision` and `operations`, with optional `feature`; operations use `replace_section` or `insert_after_section` with `headingPath`, or `replace_task` with `taskNumber`, and each supplies `content`. Patch returns revision, content hash, and changed sections. `hive_plan_read` accepts optional `feature` and `mode: 'full' | 'outline'` (default `full`) and returns status, comments, revision, and content hash, plus either full content or headings and task list. Full read, write, task sync, and status include `unownedTaskHeadings: [{ line, title }]` when present.

`hive_plan_approve` accepts optional `feature`, `expectedRevision`, `sync`, and `refreshPending`. Without `sync: true`, it returns the approval outcome directly and does not sync tasks. Success is `{ success: true, feature, approvalPersisted: true, revision, alreadyApproved?: true }`; `revision` is the approved plan revision. A supplied `expectedRevision` guards content, comments, and approval state from `hive_plan_read`. Validation and a pre-write recheck run under the plan lock. A retry with the same pre-approval revision succeeds with `alreadyApproved: true` only when content and comments are unchanged and the approval marker still exists. It leaves an existing successful approval unchanged and retries an incomplete metadata update.

Approval failure is `{ success: false, reason, stage, approvalPersisted, error, revision? }`. `approvalPersisted` reports whether the `APPROVED` marker exists at the failure observation; a rejected call may encounter an approval that already existed. Failure stages distinguish pre-write validation from marker and metadata writes:

| Reason | Stage | Meaning |
|--------|-------|---------|
| `expected_revision_required` | `validation` | `sync: true` needs the reviewed revision; no approval writes |
| `refresh_pending_requires_sync` | `validation` | `refreshPending` was supplied without `sync: true`; flat failure, no approval writes |
| `stale_revision`, `unresolved_comments`, `unowned_task_headings`, `plan_layout_unreadable`, `plan_missing` | `validation` | Approval rejected before writes |
| `plan_approval_failed` | `validation` | Other pre-write failure, such as a completed feature or unavailable plan lock |
| `approval_marker_write_failed` | `approval_marker` | Marker write failed; inspect persisted state before retrying |
| `feature_metadata_write_failed` | `feature_metadata` | Marker step succeeded or was already approved, but `feature.json` update failed; inspect both files |
| `approval_superseded_during_sync` | `sync_verification` | Post-sync approval is absent or its revision differs from the approved revision; includes `revision` and `currentRevision` when readable |
| `approval_verification_failed` | `sync_verification` | Post-sync plan state could not be read; includes `revision` |

With `sync: true`, `expectedRevision` is required and the response is `{ approval, sync }`. Failed approval skips sync as `{ success: false, skipped: true, reason: 'approval_failed' }`, including a partial metadata failure. Successful approval runs the same `TaskService.sync` logic as `hive_tasks_sync`, with optional `refreshPending`; success is `{ success: true, created, removed, kept, manual, unownedTaskHeadings? }`, and failure is `{ success: false, reason: 'task_sync_failed', error }`. The tool then rechecks that approval still holds and the plan revision equals the approved revision, even if sync failed. A concurrent write, patch, or comment makes the approval outcome fail explicitly while retaining the actual sync outcome. These are sequential outcomes, not a transaction; writes are not rolled back. When approval is still successful and only sync failed, address its error and retry with `hive_tasks_sync`. When approval was superseded or verification failed, read and review current state before approving and syncing again.

Inside `## Tasks`, every `###` must be `### N. Title`. Put amendments in a `####` subsection of the owning task using `replace_task`, and shared notes outside `## Tasks`. A patch that adds an unnumbered `###` there is rejected. Approval blocks while one remains or the task layout cannot be read (for example, two Tasks sections). Repair existing unnumbered headings with one `replace_section` on `headingPath: ["Tasks"]`; `replace_task` stops at the next `###` and cannot absorb an orphan heading.

If task sequencing, dependencies, or scope changed after a patch, have the primary approve and sync the reviewed revision with `refreshPending: true`. Use standalone `hive_tasks_sync({ refreshPending: true })` only while approval remains successful and sync still needs to run or retry.

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

The primary calls the matching merge tool with the worker's unchanged verified source pin and inspected target expectation. When retention is not needed, use merge's same-call `cleanup: 'worktree+branch'`; a separate cleanup handles retained state or incomplete cleanup. Batch independent Hive calls in one response/step, while sequencing dependent state changes and integrations sharing a destination. Helper investigates evidence only.

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

Manifest-backed ad-hoc creation requires a nonempty `repoIds` selection. Omitting it reports a topology error before Git runs; inspect the project repository manifest and select the repositories owned by the run.

When a manifest-backed project's root is not a declared Git repository, lifecycle tools require the selected workspace's `workspace.json`. A wrong task folder, candidate, or run ID, a repeat cleanup after that metadata was removed, or an existing directory without metadata reports `Composite workspace manifest not found` with the expected path before running Git against the project root. Check the exact selector and retained placement; `repoIds` and source pins cannot replace missing workspace metadata. Status reports invalid entries in `worktreeErrors: [{ path, reason }]` and keeps healthy worktrees and task summaries readable. Hive preserves those directories for inspection. Existing single-root placements remain readable when the project root is still a declared repository, including a symlink alias of that root.

For an orphaned composite workspace whose metadata cannot be recovered, an operator or authorized primary may perform the manual recovery below. Helper may inspect and return evidence but cannot execute removal, pruning, or branch deletion, and a failed Hive tool never authorizes Helper to reproduce it with raw Git.

To remove confirmed orphan registrations:

1. Use the reported workspace path and `.hive/repositories.json` to identify the owning repository roots. A feature task's `status.json` `repoIds` and retained `repos/<repoId>` directories help locate the selection. Confirm every exact worktree path and branch with `git -C "<repository-root>" worktree list --porcelain`; do not run Git from a non-Git project or composite root. Preserve source commits and local files before removal.
2. For each confirmed repository, inspect `git -C "<workspace-path>/repos/<repoId>" status --short --ignored`, then run `git -C "<repository-root>" worktree remove "<workspace-path>/repos/<repoId>"` only after its work is integrated or its contents have been deliberately retained elsewhere. If the worktree directory is already absent, review the stale registration and run `git -C "<repository-root>" worktree prune`. Also prune after successful removal.
3. After confirming the branch is integrated and is not checked out elsewhere, run `git -C "<repository-root>" branch -d "<confirmed-branch>"`. Use the branch from the registration, with the feature/ad-hoc and candidate naming described above. If Git refuses removal or branch deletion, retain the state and resolve the cause before retrying.
4. Once every repository registration is handled, remove only empty `repos/<repoId>`, `repos`, and workspace directories with `rmdir`. Retained files must be inspected and preserved before those directories can be removed. Refresh `hive_status` to confirm the orphan diagnostic is gone.

Use `sourceCommit` for a legacy single-root workspace. When persisted `repos` are present, use `sourceCommits` as a complete map keyed by persisted repository ID. A singleton composite also accepts a matching scalar `sourceCommit` convenience; multiple repositories still require the complete map. At the tool boundary, the runtime fills an omitted source pin from its source inspection. A supplied composite map must match every inspected repository; it rejects a map for a legacy single-root workspace, a scalar for a multi-repository composite, both pin forms together, and any supplied pin that differs from the inspected candidate. In a worker handoff, pass the worker's returned topology-aware pin unchanged to merge.

Both create tools return the initial inspection directly, in the same shape as their inspect tool: placement, source `commit`, `baseCommit` or `baseCommits` when recorded, `clean` (including untracked and ignored dirt), and destination state. A reused worktree is inspected again, so its result reflects current state. Composite results include per-repository source commits and cleanliness under `repos[repoId]`, plus aggregate `clean`. There is no additional inspection wrapper or duplicate placement projection.

A legacy inspection has top-level `target` and `comparison`; composite results put them only under `repos[repoId]`. `target` is `{ path, ref, commit }`, where `path` is the canonical absolute destination root, `ref` is the full `refs/heads/...` name or `null` when detached, and `commit` is the full OID. If destination identity cannot be read, inspection retains source details and returns `target: null` with `comparison.status: 'error'`. Comparison is one of `{ status: 'ok', targetIsAncestorOfSource }`, `{ status: 'no-common-ancestor' }`, or `{ status: 'error', error }`. A shallow repository may therefore report locally no common ancestry; inspection never fetches and ancestry does not establish semantic completeness. Record the initial target identity from create before dispatch. Later inspect checkpoints after writing handoffs, before review/remediation, after sibling integration or destination movement, and before integration remain required.

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

`hive_background_status` takes optional `feature`, `task`, `adHocRunId`, `workflow`, and `includeArchived` (default `false`). The result contains `jobs`, `scope`, `recommendedNextAction`, `requiresHiveStatusRefresh`, and scheduler/notification guidance when applicable. `hive_background_reconcile` requires `identifier`, `decision: 'reconciled' | 'ignored'`, and `summary`. It returns a compact acknowledgement `{ identifier, decision, success: true, archived: true, state: 'archived_after_reconcile' | 'ignored_archived', requiresHiveStatusRefresh }`, or `{ identifier, decision, success: false, reason, error, hint }`. The refresh flag is true when the successfully archived job had feature or task scope, including ignored stale/uncertain observations. It does not echo the summary, full job record, or board scheduler guidance. The batch form returns `{ success, results, requiresHiveStatusRefresh }` in input order; aggregate success requires every item to succeed, and aggregate refresh is true when any successful item requires it. A malformed item or persistence error fails that item alone; successful items remain archived. Inspect a `reconciliation_failed` item before retrying because a failed write may have published. Cancel requires `identifier` and `reason`; its response distinguishes `runtimeCancelled` from a recorded request.

Failure `hint` is one actionable string. `job_not_terminal` tells the caller to wait for the native completion notification. `stale_job_requires_ignore` and `uncertain_job_requires_ignore` give an exact `hive_background_reconcile({ identifier: "<canonical-alias>", decision: "ignored", summary: "..." })` call; archiving only retires the observation. Resolution failures point to the correct identifier, originating parent scope, or archived view; summary failures request a non-empty summary, and persistence failures request inspection before retry.

The board observes the originating native parent and call, not the current feature or agent, and only for background launches; see [Foreground children after a restart](#foreground-children-after-a-restart). Stale and unknown observations stay visible. It does not couple to execution, worktree, or task status. Multiple launch observations may exist for one native task identity when explicit runtime-owned interruption recovery is used. If completion lacks a call ID or its identity is ambiguous, record unknown and hint `hive_task_trace`; never guess the latest child. Missing or ambiguous completion identity must not block unrelated dispatch, but ownership-overlapping work still requires inspection or waiting; do not send another prompt or launch another writer.

With the env gate unset, the background management tools return `background_tools_disabled`. Primary agents keep normal blocking `task()` wait mode. With the env gate set, primary orchestrators receive delegate-first background scheduling guidance and the board tools are active.

`hive_background_status` owns `recommendedNextAction`. Both status and reconciliation can set `requiresHiveStatusRefresh`; when true, refresh `hive_status` before dependent feature/task or merge decisions. Reconciliation acknowledgements describe only the requested items; use background status when a later decision needs the remaining board.

Reconcile terminal background jobs first, then refresh `hive_status` before dependent task or merge decisions for scoped feature/task work.

If `hive_background_status` returns `schedulerGuidance.reason: wait_for_native_completion_notification`, do not refresh repeatedly. Wait for OpenCode's native completion notification.

Cancellation is not rollback. Cancel acknowledgement does not prove the worker stopped. Do not invent native task IDs. Reconcile and ignore archive board rows only.

## Runtime Session Inspection (2 tools)

These tools are available to execution/review primaries, Architect, Helper, and Forager under the [access matrix](#agent-tool-access). Forager uses them only for assigned recovery; Scout and specialist reviewers have no trace tools. They inspect any explicitly identified OpenCode session visible through the connected runtime. Authorization uses a fresh `session.get` and requires a well-formed record whose ID exactly matches `task_id`. Trace is read-only bounded native identity and freshness, not an allowance.

### Helper investigation contract

Primaries perform single direct reads themselves: one `hive_status`, one worktree inspect, or one `hive_task_trace_content` spot-check of a known event ref. For multi-step forensics (paging a trace, drift comparison, or interrupted-worker evidence packets), route one named question to `hive-helper` with known native session/call, feature/task or ad-hoc run, worktree, source, and destination identities. Architect may use this route as primary or child. The helper returns cited observations, attributed self-reports, hypotheses, and limits. Trace answers cite exact event refs. Interrupted-worker packets include retained placement/registration, observed source HEAD, destination identity, dirty/untracked state, and existing report/handoff paths; ad-hoc runs have no task reports. Drift packets name comparison ranges, intersecting changed paths, shared contracts, and comparison gaps. A disjoint path list alone does not prove semantic independence.

The primary spot-checks decisive cited event refs with `hive_task_trace_content` before acting. It owns acceptance, merge, cleanup, retry, continuation, termination, task creation, and status. Every HEAD discovered by Helper is **observed**, never a returned verified source pin; it cannot replace an inspected target expectation. When investigation needs Hive layout/config/forensics facts, Helper loads `hive-config` first.

Helper's Bash and external integrations are inspection-only. It never mutates repositories, worktrees, branches, files, processes, containers, or Hive state, including through commands that refresh indexes or write output. Use `git --no-optional-locks status`; plain `git status` can refresh/write the index and take `index.lock`. Do not run `git fetch`, `git pull`, `git remote update`, or any remote-ref update, or any build, test, or verification workload in a worktree whose writer is live or uncertain. If a Hive tool fails, it reports the exact failure and retained state rather than reproducing the operation with raw Git or another capability. No merge/squash, commit, forced worktree removal, branch deletion, conflict resolution, cleanup, or cancellation substitute is allowed. A semantic recovery projection is untrusted context, not evidence or lifecycle authority.

| Tool | Purpose |
|------|---------|
| `hive_task_trace` | Read one runtime-visible session as a paged forensic v3 index of surviving non-reasoning events; optionally request turn-scoped recovery |
| `hive_task_trace_content` | Read one guarded index event, continue one of its oversized fields, or re-read a recovery v2 content ID |

`hive_task_trace` requires `task_id` and accepts optional `cursor` or `recovery` (default `false`), not both. `hive_task_trace_content` requires `task_id` and exactly one selector: `event`, `event` plus `field` with optional `offset`, or `content_id` with optional `offset`. Any other combination returns `invalid_selector` before any source read. Every accepted call reauthorizes the target and rereads the source.

Trace inspection never resumes, aborts, retries, polls, or mutates the inspected session.

```text
hive_task_trace({ task_id: "child" })
hive_task_trace({ task_id: "child", cursor: "<coverage.next_cursor>" })
hive_task_trace_content({ task_id: "child", event: "<events[n].ref>" })
hive_task_trace_content({ task_id: "child", event: "<events[n].ref>", field: "output", offset: 8192 })
```

### Forensic index

Each page lists events in source order under a 24 KiB budget (`render.bytes` is exact) and always makes forward progress. An event is one text, tool, retry, patch, compaction, or unsupported part, or an assistant message error. Step markers are counted as `source.structural_parts`. Reasoning is excluded from events, refs, cursors, guards, and errors; `reasoning` reports only part, byte, and token counts.

Each row carries `seq`, `kind`, `actor`, and, where recorded, `tool`, `status`, `call_id`, and `title`. Tool rows show the complete `input` when it is small; otherwise they show the recorded identifying keys that are present (`description`, `command`, `filePath`, `path`, `pattern`, `name`, `url`, `query`, `subagent_type`). Text, output, and error excerpts keep a head and a tail around ` [...] `, so commands and outputs that share a long prefix stay distinguishable. `bytes` gives the canonical size of each present field; a field missing from `bytes` is absent. `abbreviated` names every displayed value that is not complete, including long tool names, titles, types, and call IDs.

A native `task` call row also carries `child_session_id` when the call recorded exactly one valid child ID (in `state.metadata.sessionId`, optionally mirrored in part metadata) and a fresh `session.get` confirms that session exists with the traced session as its parent. Each read checks the distinct candidates on the displayed page or selected event again. A missing, malformed, conflicting, or unconfirmed identity shows no field, and raw metadata is never shown. The recorded identity is part of the event guard, so a ref stops resolving when it changes.

`context.assignment` is the first user text. `context.final` is the terminal assistant text for a terminal lifecycle and is a `child_self_report`, not proof. Both link to their event with `ref` when the event has one and carry `identity` like index rows.

`coverage.next_cursor` continues the index; after `cursor_stale`, restart from the first page. When every event up to the cursor has native identity, the cursor accepts appended events and returns `cursor_stale` when any earlier eligible event was inserted, deleted, or changed. When any of those events lacks native identity, any change to the eligible source returns `cursor_stale`, including an append, because deleting one of several identical events would otherwise go undetected. `coverage.complete: true` means the pages from the first to this one covered every eligible event in the surviving source as observed. It is not evidence about history the runtime no longer holds or about the filesystem. `coverage.limitations` lists `compacted_source`, `compacted_tool_output` (rows marked `compacted`), `unsupported_parts` (rows with `kind: "unsupported"` and only a bounded `type`), and `positional_identity` (rows marked `identity: "positional"` or `"ambiguous"`).

### Event reads

`hive_task_trace_content({ task_id, event })` returns the selected event with native `message_id`, `part_id`, and `call_id` when recorded, a confirmed `child_session_id` under the index rule, and every field of its kind: `input`, `output`, and `error` for tools; `text`; `error`; or `files`. Each field is `{ state: "absent" }`, `{ state: "value", format, bytes, value }`, or, above 8 KiB, `{ state: "chunked", format, bytes, sha256, content, offset, next_offset }`. An empty string is a `value`, not `absent`. Small object inputs stay objects. Chunked `json` fields are canonical JSON with sorted keys; concatenating chunks reproduces the text that `sha256` covers. Continue with the same `event` and `field`, setting the request's `offset` to the prior response's `next_offset`.

Each ref carries a full SHA-256 guard over the event's allowlisted fields, so the tool input, output, and error always come from one stored tool part. Refs with native identity survive unrelated appends and movement. Content equality is not identity, so events without unique native message and part IDs get weaker selectors. An event whose content is unique in the source is marked `identity: "positional"`; its ref names that event only while the whole eligible source is unchanged, and any change, including an append, returns `source_changed`. An event byte-identical to another event is marked `identity: "ambiguous"` and has no ref: its row stays in the index with bounded excerpts, but its full fields cannot be read, and a selector that reaches it returns `identity_unavailable`. A replacement that leaves the eligible source byte-identical is undetectable without native IDs. `event_changed`, `event_not_found`, `event_ambiguous`, and `source_changed` mean the ref no longer establishes the selected event; re-index before drawing conclusions. `source.as_of` in index and event replies is a digest of the eligible event sequence. It changes when an eligible event is added, removed, or changed and ignores reasoning, step markers, and message completion. It gates positional refs and cursors over events without native identity, not native refs.

### Trace policy and recovery

If semantic recovery would help build a fresh handoff, call `hive_task_trace({ task_id: "child", recovery: true })`. Recovery remains untrusted and never authorizes continuation. Every returned task result is terminal, so follow-up work uses a fresh child session and may reuse the same Hive task/worktree. Primaries must not pass `task_id` or infer eligibility from task output, trace, `idle_and_closed`, board state, cancellation acknowledgement, or transcript quality. Pass `task_id` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation; otherwise launch fresh. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer.

Use a successful, intelligible terminal return as the normal handoff, subject to the required review and verification checks. Investigate traces when a specific unresolved question about output, lifecycle, verification evidence, or material instruction compliance could change acceptance or recovery, or when the operator explicitly requests an audit. The primary performs a single known-event spot-check itself; multi-step questions go to Helper with known identities. Helper reads only the events/fields needed and stops when resolved. The primary spot-checks decisive cited refs before acting. A named skill alone does not require a trace, and a terminal return need not list skill loads.

Required skills must still be loaded before covered work. Audit skill loading only for an explicit operator audit request or a concrete concern about material noncompliance. During that audit, check the forensic index for completed native `skill` tool events whose input names the exact required skills before the covered work. A self-report or late load does not prove timely loading; a successful load does not prove adherence to the skill. Missing or incomplete evidence is not a confirmed omission; keep the audit and affected acceptance question unresolved. An omitted or late required load requires a fresh child after the prior child is terminal, with the requirement preserved. If trace tools are unavailable, report the limitation and keep the affected acceptance question unresolved.

Recovery output keeps its v2 projection. Its 24 KiB soft target is advisory, not a cap, and `render.actual_bytes` is exact. Its `content_id` values stay readable through `hive_task_trace_content({ task_id, content_id })`.

`lifecycle` carries `state`, `terminal`, `reason`, and what was observed. `runtime` is the target's status in the runtime instance for the directory recorded on the target session: `busy`, `retry`, `idle`, or `unavailable`. Source and status are read from that directory, not the caller's project. A target without a valid absolute directory reports `placement_unavailable` and is never treated as idle. A missing target entry in a valid status map means idle because OpenCode removes idle entries; an unavailable or invalid map reports `status_unavailable`. `unresolved_tools`, present when nonzero, counts pending or running tool records in the latest message and in earlier messages.

Any unresolved tool record or open latest assistant message keeps `terminal: false`, even when `runtime` is `idle`. A host restart leaves exactly that shape: the new instance does not know the old turn, so it reports idle, while the stored records still show work without a result. Idle status in the current instance says nothing about subprocesses or other effects the old worker started. `idle_and_closed` means only that the observed latest turn finished. It is not a completion check over the whole history: an earlier assistant message left open without an unresolved tool record does not block it, and it says nothing about effects started in earlier turns.

`recovery.scope` names what a recovery covered. `closed_turn` is the normal projection for an `idle_and_closed` lifecycle. `evidence_only` covers an `idle` runtime whose `reason` is `tool_pending_or_running` or `latest_assistant_open`. An evidence-only snapshot keeps `lifecycle.terminal: false` and `final_response: null`, and its `semantic.safest_next_action.action` is always `inspect`, whatever the summarizer proposed. It helps decide what to inspect; it is not execution authority and does not show that the child stopped. Recovery is refused with `scope: null` for active (`busy` or `retry`), `status_unavailable`, `placement_unavailable`, self, empty, and other uncertain lifecycles. After summarizing, recovery resolves the target again and rereads its placement, source, and status. A lost authorization, a changed parent (compared exactly, so a move between two foreign parents counts) or directory, changed source, active or unavailable status, or a changed lifecycle discards the result with a `freshness` failure. `recovery.status: "complete"` means the summary covered the surviving source, not that the task completed.

Semantic output is always `untrusted: true`. Generated `source_steps` arrays are sorted context source coverage, not evidence or proof. Never accept, merge, retry, resume, or auto-run from recovery output.

### Foreground children after a restart

The background board tracks only `background: true` launches. Foreground `task()` calls never appear in `hive_background_status`, and `hive_background_cancel` returns `job_not_found` for them. When a host restart ends a foreground call before it returns, the parent's stored call keeps `running` or `pending` status and the parent never received the child ID in a result. Two supported paths name the child:

- On each later turn, the runtime adds a replay hint to the parent's call naming `hive_task_trace({ task_id })` for the child. The hint says the call has no recorded result and the child may still be in flight. Hints are rebuilt for every turn. Only a child's newest recorded call decides its hint, so a later result for the same child supersedes an older call that has none. Hints cover up to the eight newest children whose newest call needs one, and skip a call that is still the latest message, background launches (`background: true` in the call's recorded metadata or input), and children the runtime does not confirm as direct children of that parent. Empty and terminally unsuccessful foreground task results get the same kind of hint.
- `hive_task_trace` on the parent session (self inspection is allowed) shows `child_session_id` on the parent's `task` rows.

Use these paths instead of runtime exports or `.hive/sessions.json`; neither is a trace source. Then trace the child, and treat its lifecycle and any evidence-only snapshot under the rules above before deciding to wait, ask, or launch fresh.

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

The response is `{ feature, tasks, runnable, blocked, worktrees }`, with optional config fallback `warning`, freshness failure `specFreshnessError`, and `unownedTaskHeadings: [{ line, title }]`. For a known feature, `feature` has `name`, `status`, `hasPlan`, and `commentCount`; for an unknown feature or missing `feature.json`, it is `null` and the other summaries may be empty. Top-level `tasks` is the sole task list. Its summaries (`folder`, `name`, `status`, `origin`, optional `planTitle`, `summary`, `repoIds`, `blocker`) include `dependsOn` (the stored dependency folders, `[]` when missing, kept on done and cancelled tasks as history), `specStale` (true/false/null), `specStaleReason`, and `hasHandoff`. `blocker` carries the stored operator-decision reason, options, recommendation, and context when present. `runnable` and `blocked` are computed from the same task projection. The response lists only forward edges; to find the tasks that depend on one, scan the other entries' `dependsOn`, and judge the actual impact separately. Freshness reasons: `matches_plan`, `differs_from_plan`, `manual_task`, `plan_missing`, `plan_invalid`, `task_not_in_plan`, `spec_missing`, `unowned_heading_after_task_section`, and `freshness_unavailable` when a check fails (with top-level `specFreshnessError`). `differs_from_plan` compares stored spec text with what the current plan would generate, including generator or manual-spec changes; unrelated plan sections do not affect it. `runnable` is a list of folders and `blocked` maps folders to unmet dependencies. Read `status.json`, `spec.md`, `handoff.md`, and reports for other bodies. Ad-hoc runs and the background board do not appear in this response.

Every retained task folder stays visible. A missing or unreadable/corrupt `status.json` yields an integrity entry `{ folder, name, status: null, integrity: { reason: 'status_missing' | 'status_unreadable', error? }, specStale, specStaleReason, hasHandoff }`. The error is present for unreadable/corrupt status. Freshness is derived by folder identity when possible, and existing specs/handoffs are retained. Integrity entries have no invented origin or dependencies, never appear in `runnable` or `blocked`, and never satisfy another task's dependency. Inspect and repair the authoritative task records before treating that folder as executable.

`worktrees` contains healthy entries. When a workspace or namespace cannot be read or validated, the response adds `worktreeErrors: [{ path, reason }]` and retains the remaining feature, task, dependency, and worktree summaries. See the manual orphan recovery procedure under [Worktree families](#worktree-families-8-tools).

### Native feature-task brief

Task folders are sourced from `TaskService.listStatusEntries`. A bound folder with missing/unreadable status receives one actionable `Task status integrity: ...` line with its integrity reason, directing the worker not to execute and the primary to inspect and repair the status. The folder value may be shortened to fit the 2048-byte cap; the repair instruction is retained. Healthy task briefs label integrity-failing dependencies with `status_missing` or `status_unreadable` instead of `unknown`.

Only native `task()` dispatches whose agent resolves to base `forager-worker` (built-in or custom variant) **and** whose route snapshot has an explicitly selected feature (`selected: true`) are eligible. Fallback and explicit-null routes get neither brief nor notice. The binding is the authored assignment's first non-empty line, trimmed: `Hive task: <task-folder>` for a task listed for that feature. After the unchanged route-snapshot block, a bound dispatch receives a generated block bounded by `<!-- hive-task-brief:start -->`, `## Hive task brief`, and `<!-- hive-task-brief:end -->`, at most 2048 UTF-8 bytes:

- A framing line, then `Task: <folder> - <plan title> (<status>)`; long titles end in `...`.
- `Spec: <abs path> - specStale: <v> (<reason>)` is always present; use `freshness_unavailable` when freshness cannot be computed.
- `Plan: <abs path>[ lines a-b]` is omitted if `plan.md` is missing. Unowned-heading line numbers after the task's section follow when present.
- `Handoff: <abs path>` appears when this task has a successor handoff.
- `Dependencies:` lists `- <folder> (<status>)[ handoff: <abs path>]` entries from the task record's `dependsOn`, with `unknown` for unknown folders, or `Dependencies: none`.
- The durable catalog count includes the `hive_context_read` call; `Execution decisions: <abs path>` appears when present. No document bodies are included.

To fit the budget, trailing dependency entries are dropped with `- (+<k> more; see hive_status)`. If still too long, retain core lines plus unowned-heading and handoff lines, then core lines alone; never cut a path. When locators cannot fit, the result is `Hive task brief unavailable: locators exceed 2048 bytes.` An eligible unbound dispatch gets one line under the heading: `No Hive task binding: ...` (missing/invalid marker or unknown folder); composition errors give `Hive task brief unavailable: <message>`. On each task dispatch, only generated blocks (a start marker immediately followed by its heading line) are replaced, for any agent; marker text quoted elsewhere in an authored assignment is preserved. Reviewers, scouts, advisors, and helpers never receive a brief. For task-scoped review, the primary supplies feature/task identity, plan path and current section, spec path, and current `specStale`/`specStaleReason` from `hive_status`; reviewers may query status with the explicit feature to clarify current state.

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
