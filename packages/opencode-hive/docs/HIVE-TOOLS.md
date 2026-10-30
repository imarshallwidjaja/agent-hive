# Hive Tools Inventory

Tool availability plus instructions govern action. Each tool validates its own operation.

## Host entries and read transport

From 5.0.0, one package supplies native v1 and v2 entries, each with all 41 tools and 13 commands. Releases through 4.2.0 are v1-only. The qualified hosts are v1.18.30 and v2.0.26. Installation, `plugins` options and actual model-selection semantics are in the [plugin README](../README.md#opencode-v2).

V2 registers every tool through one validating registrar. `readTransport: "codemode"` (default) explicitly admits only `hive_repositories_status`, `hive_git_snapshot` and `hive_task_trace_content` to Code Mode; controls, repairing reads, worktree inspections and mixed `hive_task_trace` stay direct. `readTransport: "direct"` makes all 41 direct, with the same IDs and authority. The three Worklog tools are direct under both transports. Use direct mode when global, per-role or custom-agent permissions deny `execute`. Hive diagnoses unavailable Code Mode reads and preserves the denial.

Both hosts deliver the same tool descriptions and argument descriptions to the model, built from one definition per operation. Those descriptions explain how arguments relate, what an operation changes, what its result means and when a retry is unsafe. They do not enforce anything: the Zod argument shapes, the services and the role guards do, and this document is the reference for operators and engineers. The runtime does not read it.

The access matrix below names canonical role authority on both hosts. Its config-hook/`primary_tools` mechanism is v1-specific. On v2 native user settings own supported default selection, presentation, model/variant, limits and permission visibility. User allow rules can expose a forbidden tool, but every Hive executor and the native `execute.before` hook still check canonical role/custom inheritance and actual child ancestry before effects. Mode/description do not grant authority; ordinary native `general`/`explore` cannot run Hive tools. The v2 `subagent()` wrapper refuses a `model` argument when the target is a Hive role or custom agent, before route capture or any native effect, and, when the target has an effective configured model, refuses a same-agent continuation unless the child's session model equals it (a model-less target inherits and is not checked; `src/v2/dispatch.ts`; operator rules in the [plugin README](../README.md#agent-models)). Request-time instructions survive user prompt configuration; user skills retain live-catalog precedence. V2 needs operator-set `experimental.subagent_depth: 2` for delegated Architect helpers.

## Agent Tool Access

On v1, Hive registers ordered `agent.permission` rules in OpenCode. Each Hive role starts with `'hive_*': 'deny'`, followed by exact allows and native permissions. OpenCode v1.18.30 appends these rules after global permissions and evaluates the last matching wildcard rule, so a global `{"*":"allow"}` cannot reopen a role-denied Hive tool. The rule also covers future `hive_*` names. Custom agents inherit their base role's permissions.

On v1, OpenCode's `experimental.primary_tools` adds session-level deny rules when native `task()` creates a child. These come after agent rules, including for delegated Architect. Hive preserves operator-supplied entries and adds `question` plus the primary-only Hive operations below. On v2, Hive refuses the same operations and `question` in any child session at execution time, whatever the native permission rules show:

- Feature control: `hive_feature_complete`, `hive_feature_select`.
- Plan/task control: `hive_plan_approve`, `hive_tasks_sync`, `hive_task_create`.
- Integration/placement: `hive_worktree_merge`, `hive_worktree_cleanup`, `hive_adhoc_worktree_create`, `hive_adhoc_worktree_merge`, `hive_adhoc_worktree_cleanup`.
- Constraints/archive: `hive_constraints_add`, `hive_constraints_edit`, `hive_constraints_clear`, `hive_context_archive`.
- Parent-owned board: `hive_background_status`, `hive_background_reconcile`, `hive_background_reconcile_batch`, `hive_background_cancel`.
- Worklog authorship: `hive_worklog_record`.

`hive_worklog_record` stamps the calling session as the author of shared records, so on v1 its executor also checks the caller's role grant and reads the session's live parent before writing, as the v2 guard does for every Hive tool. A broad operator allow rule or a missing `primary_tools` entry therefore cannot let a child, including delegated Architect, record, and the call is refused when the session cannot be read.

Delegated Architect retains its inherited route and uses explicit feature arguments for planning. It may register discovered repositories through `hive_repositories_update`; other subagent roles' Hive allowlists exclude that tool. It returns approval, sync, archive, and board/control requests to the parent. Its `task` permission allows one terminal layer of blocking Scout, Investigator, plan-reviewer, approach-advisor, their custom variants, and `hive-helper`; `task` is deliberately absent from `primary_tools`, and `subagent_depth: 2` supports this helper grandchild. Independent permitted calls may be emitted together. Child-role rules take precedence over a background appendix without loading the primary-only `background-delegation` skill; child board tools remain unavailable. Architect as primary or child routes multi-step trace/evidence questions and known identities to Helper and performs single direct spot-check reads itself. Helper is read-only and terminal, retaining inherited child-session denials. Other subagents cannot delegate or ask questions. Execution primaries can dispatch registered workers, reviewers, Architect, Helper, and ordinary native subagents, but cannot dispatch another primary or an unknown target. Architect, as primary or child, can dispatch Investigators (built-in and derived) for experiments but never implementation Foragers. Review primaries dispatch inspection-only specialists, Helper, and Investigators (built-in and derived) for runtime exercises; they cannot dispatch implementation Foragers, Architect, native `general`/`explore`, or another primary. The grant is dispatch authority only: whether a run is authorized, where it happens, and how it ends are instructions in the shared Experiments method, and Investigator returns evidence, never a patch to merge.

`hive_feature_create` stays available to delegated Architect so it can create the feature that owns its plan without changing the inherited session route.

### Access matrix

Abbreviations enumerate exact tools:

- **R**: `hive_context_read`, `hive_constraints_read`, `hive_plan_read`, `hive_status`, `hive_repositories_status`, `hive_git_snapshot`, `hive_worklog_list`, `hive_worklog_read`.
- **C**: `hive_context_write`, `hive_context_append`, `hive_context_edit`.
- **I**: `hive_worktree_inspect`, `hive_adhoc_worktree_inspect`.
- **T**: `hive_task_trace`, `hive_task_trace_content`.
- **B**: all four `hive_background_*` tools listed above; experiment-gated on v1 and native on v2.
- **M**: `hive_constraints_add`, `hive_constraints_edit`, `hive_constraints_clear`.
- **P**: `hive_feature_create`, `hive_feature_select`, `hive_plan_write`, `hive_plan_patch`, `hive_plan_approve`, `hive_tasks_sync`, `hive_repositories_discover`, `hive_repositories_update`, `hive_context_archive`.
- **V**: `hive_feature_select`, `hive_adhoc_worktree_create`, `hive_adhoc_worktree_cleanup` for operator-authorized isolated review placement.
- **X**: `hive_adhoc_worktree_create`, `hive_adhoc_worktree_cleanup` for experiment placement; primary sessions only, and never paired with merge.
- **W**: `hive_worklog_record`; primary sessions only.

| Agent | Hive tools | Native boundary / usage |
|-------|------------|-------------------------|
| `hive-master` | All 41 registered Hive tools | Primary; integration and cleanup owner |
| `swarm-orchestrator` | All 41 | Primary; integration and cleanup owner |
| `hive-builder` | All 41 | Primary; ad-hoc integration and cleanup owner |
| `architect-planner` (primary) | R + C + I + T + B + M + P + W + X | Planning plus commissioned Investigator experiments; terminal planning helpers and Helper investigation; no merge; edit denied |
| `architect-planner` (task child) | R + C + I + T + `hive_feature_create`, `hive_plan_write`, `hive_plan_patch`, `hive_repositories_discover`, `hive_repositories_update` | Feature/plan/context authoring, repository registration, terminal planning helpers (Investigator included) and Helper investigation inside parent-covered placement; edit/question/board and placement create/cleanup denied |
| `scout-researcher` | R + `hive_repositories_discover` | Read-only retrieval; edit/task/question denied; trace retrieval goes to Helper |
| `forager-worker` | R + C + I + T + `hive_task_update`, `hive_worktree_create` | Assigned implementation/recovery, including implementation-coupled diagnosis; task/question denied; own report/handoff only |
| `forager-investigator` | R + I | Standalone diagnosis, experiments, and verify-only runs; a run that changes source uses a primary-owned disposable placement; native scratch edit and shell under operator permissions; task/question denied; no Hive writes, traces, task brief, report, or source pin |
| `hive-helper` | R + I + T | Feature/ad-hoc investigator; edit/task/question denied; shell/external inspection-only scope is instruction-bound |
| `plan-reviewer` | R + C | Authorized hash-guarded context only; edit/task/question denied |
| `code-reviewer` | R + C | Same; trace-dependent review needs supplied evidence or primary/Helper investigation |
| `simplicity-reviewer` | R + C | Same |
| `approach-advisor` | R + C | Same |
| `vulnerability-reviewer` | R + C | Same; shell/scanners/external probing additionally forbidden by its instructions |
| `dash-reviewer` | R + C + I + T + B + M + V + W | Hidden review primary; edit and plan/task/integration mutations denied; may dispatch Investigators for runtime exercises, never implementation Foragers |
| `vulnerability-review-primary` | R + C + I + T + B + M + V + W | Hidden review primary; same |
| Custom derivatives of all eight supported bases | Exactly their base's set | Inherit base prompt and permissions; extra skills do not expand authority |
| Native `general`, `explore` | None (`'hive_*': 'deny'`) | Ordinary tools; task/question denied; native `skill` allowed; explore edit denied |
| Hidden `__hive_task_trace_summarizer` | None (`'*': 'deny'`) | Supplied evidence only; all tools denied |

`hive_task_update` access is tool-level, not field-level authorization: Forager's own-report/handoff restriction and task ownership remain instructions. Helper/reviewer Hive-tool denials and native edit denial are enforced by OpenCode. These roles retain shell and research integrations under operator permissions; their inspection-only scope for shell and external effects is instruction-bound, an operator-accepted risk. Helper must return mutation requests to the primary and must not substitute shell or external calls for denied Hive operations. Forager's feature-worktree creation is retained for explicitly assigned placement; ad-hoc creation and new-lane orchestration stay with the primary. Investigator's native edit and shell scope is instruction-bound, not a sandbox, and its Hive grants stop at reads and worktree inspection. Forager's trace tools support assigned recovery, not worker lifecycle control.

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

`hive_plan_write` requires `content`, accepts optional `feature`, and returns JSON `{ path, unownedTaskHeadings? }`. `hive_plan_patch` requires `expectedRevision` and `operations`, with optional `feature`; operations use `replace_section` or `insert_after_section` with `headingPath`, or `replace_task` with `taskNumber`, and each supplies `content`. Patch returns revision, content hash, and changed sections. `hive_plan_read` accepts optional `feature` and `mode: 'full' | 'outline'` (default `full`) and returns status, comments, revision, and content hash, plus either full content or headings and task list. Full read, write, task sync, and status include `unownedTaskHeadings: [{ line, title }]` when present. Read (both modes, when a plan exists), write, patch, approval, task sync, and status also carry the advisory `planSync` described under [Plan sync status](#plan-sync-status).

`hive_plan_read` returns two identities. `contentHash` is the SHA-256 of the plan text alone; `revision` hashes `contentHash` together with the comments and the approval state, so a comment or an approval change moves `revision` and leaves `contentHash` as it was. Feature plan assessment (the paired `plan-reviewer` and `approach-advisor` assessments the planning and orchestrating prompts require before approval) binds to the `contentHash` the assessors read, while approval keeps passing `expectedRevision` from a fresh read. `hive_plan_approve` neither requires nor records assessments; the obligation sits with the agents.

`hive_plan_approve` accepts optional `feature`, `expectedRevision`, `sync`, `refreshPending`, and `refreshTasks`. Without `sync: true`, it returns the approval outcome directly and does not sync tasks. Success is `{ success: true, feature, approvalPersisted: true, revision, contentHash, alreadyApproved?: true }`; `revision` is the approved plan revision and `contentHash` the plan content that approval checked. A supplied `expectedRevision` guards content, comments, and approval state from `hive_plan_read`. Validation and a pre-write recheck run under the plan lock. A retry with the same pre-approval revision succeeds with `alreadyApproved: true` only when content and comments are unchanged and the approval marker still exists. It leaves an existing successful approval unchanged and retries an incomplete metadata update.

Approval failure is `{ success: false, reason, stage, approvalPersisted, error, revision? }`. `approvalPersisted` reports whether the `APPROVED` marker exists at the failure observation; a rejected call may encounter an approval that already existed. Failure stages distinguish pre-write validation from marker and metadata writes:

| Reason | Stage | Meaning |
|--------|-------|---------|
| `expected_revision_required` | `validation` | `sync: true` needs the reviewed revision; no approval writes |
| `refresh_pending_requires_sync` | `validation` | `refreshPending` was supplied without `sync: true`; flat failure, no approval writes |
| `refresh_tasks_requires_sync` | `validation` | `refreshTasks` was supplied without `sync: true`; flat failure, no approval writes |
| `invalid_refresh_tasks` | `validation` | The `refreshTasks` selection fails the checks under [Selected task refresh](#selected-task-refresh) against the current plan and task records; no approval writes |
| `stale_revision`, `unresolved_comments`, `unowned_task_headings`, `plan_layout_unreadable`, `plan_missing` | `validation` | Approval rejected before writes |
| `plan_approval_failed` | `validation` | Other pre-write failure, such as a completed feature or unavailable plan lock |
| `approval_marker_write_failed` | `approval_marker` | Marker write failed; inspect persisted state before retrying |
| `feature_metadata_write_failed` | `feature_metadata` | Marker step succeeded or was already approved, but `feature.json` update failed; inspect both files |
| `approval_superseded_during_sync` | `sync_verification` | Post-sync approval is absent or its revision differs from the approved revision; includes `revision` and `currentRevision` when readable |
| `approval_verification_failed` | `sync_verification` | Post-sync plan state could not be read; includes `revision` |

With `sync: true`, `expectedRevision` is required and the response is `{ approval, sync }`. Failed approval skips sync as `{ success: false, skipped: true, reason: 'approval_failed' }`, including a partial metadata failure. Successful approval runs the same `TaskService.sync` logic as `hive_tasks_sync`, with optional `refreshPending` and `refreshTasks`, bound to the approved `contentHash`: if `plan.md` changed after approval checked it, sync rejects before writing anything. Sync success is `{ success: true, created, removed, kept, manual, refreshed?, skipped?, unownedTaskHeadings? }`, and failure is `{ success: false, reason: 'task_sync_failed', stage?, applied?, interrupted?, error }` (see [Task Management](#task-management-3-tools) for the failure fields). The tool then rechecks that approval still holds and the plan revision equals the approved revision, even if sync failed. A concurrent write, patch, or comment makes the approval outcome fail explicitly while retaining the actual sync outcome. These are sequential outcomes, not a transaction; writes are not rolled back. Read `stage`, `applied`, and `interrupted` and inspect the tasks they name before retrying. When approval is still successful and the failed call selected no `refreshTasks`, address the error and retry `hive_tasks_sync`, keeping `refreshPending: true` when the call had it. When the failed call selected `refreshTasks`, fix the cause and repeat the approve-and-sync call on a freshly read and reviewed revision, because standalone sync cannot select tasks; an unchanged approval returns `alreadyApproved: true`. When approval was superseded or verification failed, read and review current state before approving and syncing again.

Inside `## Tasks`, every `###` must be `### N. Title`. Put amendments in a `####` subsection of the owning task using `replace_task`, and shared notes outside `## Tasks`. A patch that adds an unnumbered `###` there is rejected. Approval blocks while one remains or the task layout cannot be read (for example, two Tasks sections). Repair existing unnumbered headings with one `replace_section` on `headingPath: ["Tasks"]`; `replace_task` stops at the next `###` and cannot absorb an orphan heading.

If task sequencing, dependencies, or scope changed after a patch, have the primary approve and sync the reviewed revision with `refreshPending: true`. Use standalone `hive_tasks_sync({ refreshPending: true })` only while approval remains successful and sync still needs to run or retry, and only when the failed call selected no `refreshTasks`.

### Selected task refresh

`refreshPending` rewrites only pending plan tasks. To apply an amended plan to a started plan task, the primary passes its folder in `refreshTasks` on `hive_plan_approve({ expectedRevision, sync: true, refreshTasks: [...] })`; `hive_tasks_sync` does not accept the option. Selecting a folder is the primary's statement that it confirmed no assignment for the task is still running and that the task's changed scope was reconciled with its retained work. Hive does not derive either fact from task status.

A selected task takes its title, dependencies, repositories, and spec from the approved plan and keeps everything else: status, blocker, summary, timestamps, base commits, reports, and handoff. Matching is by folder name. The tool checks the selection against the current plan and task records before approving, and sync checks it again under its lock. It rejects, writing nothing:

- an empty list or a repeated folder;
- a folder that is not a task of the feature, has no readable status, is manual, or is `done` or `cancelled`;
- a folder the plan no longer produces, for example because its heading was retitled. Restore the old title, or add the new work as a new task;
- a repository change while the task has a retained worktree, or when the feature's worktrees could not be listed. Integrate or clean up that worktree first, or keep the task's `Repos:` line unchanged;
- a plan whose resulting unfinished-task graph is invalid.

### Plan sync status

`planSync: { state, hint? }` says whether the stored tasks reflect the current plan content. Sync records its progress in `task-sync.json` in the feature directory, and the status is computed from that record and the current task files each time it is read:

| State | Meaning |
|-------|---------|
| `current` | The last sync reconciled exactly this plan content, and every unfinished plan task still has the title, dependencies, repositories, and spec the plan produces, within a valid dependency graph |
| `changed` | Plan content changed since the last reconciled sync, including edits outside `## Tasks` |
| `incomplete` | The last sync failed, raced a status change, or left a started task unrefreshed, or task records drifted from the synced plan; the hint names up to five affected folders |
| `unknown` | No task sync is recorded (for example, a feature last synced before this record existed), the record is unreadable, or the plan or a task record cannot be compared |

The baseline is the SHA-256 of the raw `plan.md` bytes, the same `contentHash` that `hive_plan_read` reports, so a line-ending rewrite counts as a change. Comments and approval do not. Manual, `done`, and `cancelled` tasks are history and are not compared. Reading the status writes nothing: it creates no record, lock, or directory and repairs nothing; the next sync rewrites a missing or unreadable record. When the status cannot be calculated, a successful mutation still returns its outcome with `planSync.state: 'unknown'`.

The status is advisory. It never approves, syncs, or blocks anything, and it says nothing about whether a worker is running. When it is not `current`, check the affected tasks and shared contracts, then review, approve, and sync as needed before dispatch.

Plans, approval, and dependencies guide work and status visibility. They are not dispatch or status admission gates. Approval and task sync are per-feature. Cross-feature overlap or activity does not block approval; concrete prerequisites block affected execution tasks or lanes unless they leave the plan materially unresolved. Unresolved plan comments still block approval. Hive does not infer cross-feature dependencies. Authored plans keep their structural dependency checks, and sync and manual creation validate the dependencies of unfinished tasks (see [Task dependency graph](#task-dependency-graph)).

## Task Management (3 tools)

| Tool | Purpose |
|------|---------|
| `hive_tasks_sync` | Generate tasks from plan, or refresh pending plan-backed tasks with `refreshPending: true` after a plan amendment; started tasks are refreshed only through `hive_plan_approve` with `refreshTasks` |
| `hive_task_create` | Create an append-only manual task with optional `dependsOn`, `repos`, and structured metadata |
| `hive_task_update` | Update optional task status, summary, blocker, terminal report, or successor handoff; omissions are preserved |

`hive_tasks_sync` takes optional `feature` and `refreshPending` (default `false`) and returns `created`, `removed`, `kept`, and `manual` task folders, `planSync`, and when nonempty `refreshed` (tasks rewritten from the plan), `skipped` (tasks left unchanged because their records changed while sync ran), and `unownedTaskHeadings`. Core sync fails with `TaskSyncError`, which carries a `stage`, `applied: { removed, created, refreshed }` (actions that completed), `interrupted: { action: 'remove' | 'create' | 'refresh', folder } | null`. At `validation` it wrote nothing, and at `checkpoint` it wrote no task file. At `tasks`, `verification` and `publication_unconfirmed` it may have applied the listed task changes, which are not rolled back. `interrupted` names the action that was running when the write threw. It is never listed in `applied`, because a write can fail before or after its rename publishes, so that task's files may be unchanged, partly written, or fully written; a created task can be left with its `status.json` but no `spec.md`, and `hive_tasks_sync({ refreshPending: true })` rewrites it. A `tasks` failure never attempted the reconciled record, so `task-sync.json` holds `incomplete`. In a `verification` failure every task change was applied and the reconciled write reported an error; sync then read `task-sync.json` back and it held no reconciliation of this plan content, so `planSync` read at that point was not `current`. A `publication_unconfirmed` failure also applied every task change, but the reconciled write reported an error and the read-back failed or found no record, so whether reconciliation was published is unknown and the error text says so. Read `planSync` with `hive_status` before replaying sync after an unconfirmed failure. It describes `task-sync.json` as read then: `current` shows the task data is current now, not what the failed call published, and a later `unknown` or `incomplete` is likewise not a verdict on that call. A later sync records reconciliation without rewriting tasks that already match the plan (see [Plan sync status](#plan-sync-status)). Standalone `hive_tasks_sync` returns this failure as a tool error whose message states whether files changed, lists applied changes, and names an interrupted action; the approve-and-sync call returns `stage`, `applied`, and `interrupted` as fields of its `sync` outcome. `hive_task_create` requires `name`; optional inputs are `order`, `feature`, `description`, `goal`, `acceptanceCriteria`, `references`, `files`, `dependsOn`, `reason`, `source`, and `repos`. It returns the new task folder. `hive_task_update` requires `task`; optional inputs are `feature` (string), `status` (`pending` | `in_progress` | `done` | `blocked` | `failed` | `partial` | `cancelled`), `summary`, `report`, and `handoff` (strings), and `blocker` (an object or `null`). A non-null `blocker` requires `status: 'blocked'` or a task already blocked.

Plan-backed tasks get their DAG from `plan.md` `Depends on:` annotations during `hive_tasks_sync`. Modern plans sync numbered task headings only from the `## Tasks` section. Task numbers must be unique; a plan that reuses one is rejected before sync writes anything. A pure final verification checklist belongs in `## Final Verification` unless it writes tracked artifacts.

Sync keeps manual tasks and plan tasks whose current status is not pending (including cancelled ones), with their reports and other files, whether or not the plan still lists them. The test is the stored status, not whether the task has a report or other history. A kept cancelled plan task appears in `kept` and a cancelled manual task stays in `manual`; neither is recreated as pending. A manual task keeps its manual origin and stored dependencies even when a plan heading produces the same folder. A pending plan task missing from the plan is removed with its task folder only when it has no execution history. One with a recorded start, a report, or a handoff, for example a task reset to pending after work began, rejects the sync: restore its heading, or cancel it with `hive_task_update` to keep it as a retained record. With `refreshPending: true`, pending plan tasks still in the plan take their title, dependencies, repositories, and spec from the current plan; started tasks change only through [Selected task refresh](#selected-task-refresh).

Sync also protects task identity. It never recreates a plan task folder whose `status.json` is missing; repair the record first. It never creates a new folder for a heading number whose earlier folder holds started or finished work (`in_progress`, `blocked`, `failed`, `partial`, or `done`), which is what retitling that heading would do. Restore the heading title that produces the existing folder, or give the new task its own number. Sync never renames task folders or moves worktrees.

Syncs of one feature are serialized by the lock on `task-sync.json`. Each refresh or removal rereads the task's status under the same lock as `hive_task_update` and writes only the plan-owned fields, so a concurrent update is kept. A task that is no longer eligible on that reread (a pending task that started or gained history, or a selected task that finished) is skipped, as is a new folder that appeared after sync planned to create it.

### Task dependency graph

A stored `dependsOn` array lists task folders. A status file without the field has no dependencies; folder numbers never imply one. Plan shorthand (a task with no `Depends on:` line depends on the previous task number) is resolved when sync compiles the plan, and the result is stored as an explicit array.

Before writing anything, sync and manual creation check the graph they would leave behind. Each dependency of an unfinished task (`pending`, `in_progress`, `blocked`, `failed`, or `partial`) must name an existing task other than itself, and unfinished tasks must not form a cycle. Dependencies of `done` and `cancelled` tasks are history: they stay in `status.json` and in `hive_status`, but they are not checked. An unfinished task may depend on a done or cancelled task, which must exist; only `done` satisfies the dependency.

A rejected sync or manual creation changes no task files. The error names the unfinished task and its missing target, self-reference, or cycle, then the repair routes that apply:

- A pending plan task with outdated stored dependencies: amend its `Depends on:` line if needed, then run `hive_tasks_sync({ refreshPending: true })`.
- A missing task that a plan heading can recreate under the same folder (`### N. Title` with a free number N and a title that produces the folder name): restore that heading and sync again. Manual creation is append-only and cannot restore an earlier folder.
- An unfinished started plan task (`in_progress`, `blocked`, `failed`, or `partial`) whose plan heading still produces its folder: amend its `Depends on:` line, confirm no assignment for it is running, then approve and sync with `refreshTasks` naming it (see [Selected task refresh](#selected-task-refresh)).
- A manual task, a `done` or `cancelled` task, or a plan task whose heading is gone: no tool edits its stored dependencies, and changing its status does not change them. If the task is obsolete and the operator approves, cancel it with `hive_task_update` and create a replacement with `hive_task_create` when the work is still needed. Cancelling releases its outgoing dependencies. It does not stop a running worker, and it does not rewire tasks that depend on it; those tasks keep the dependency and stay blocked until the operator decides what replaces it. Started work and tasks that depend on the obsolete one need an explicit operator decision; do not bulk-rewrite dependencies.

Sync validates the graph it would produce, not the current one, so a restored heading or refreshed pending task can repair a feature whose stored graph is already invalid, for example after an older sync deleted a plan task that a manual task still referenced. `hive_task_update` does not check dependencies: reopening a done or cancelled task makes its stored dependencies active again, and the next sync or manual creation reports them if they are invalid. Sync is not transactional; the check guarantees only that a rejected call writes nothing, not that a filesystem failure part way through the writes is rolled back. Such a failure reports the changes it applied and leaves `planSync` `incomplete` until a later sync reconciles.

`report` is a nonblank string written to `tasks/{task}/reports/{N}.md` and mirrored to `tasks/{task}/report.md`; it is not a `status.json` field. `handoff` is nonblank, limited to 2048 UTF-8 bytes (rejected rather than truncated), and replaces `tasks/{task}/handoff.md`; other updates leave it intact. The update returns `reportPath` or `handoffPath` when it writes one. An explicit status leaving blocked clears the blocker. All supplied fields are validated before any write; writes then run in order: report history, `report.md`, `handoff.md`, `status.json`. If report-history, latest-report, handoff, or status publication fails, the tool returns `success: false`, `reason: 'task_update_persistence_failed'`, `failedStage` (including `handoff`), the affected paths, and write/publication flags including `handoffPath` and `handoffWritten`. A validation rejection writes nothing. Any other failure, including a lost tool result, may still have written earlier stages, so history can hold the report while `report.md`, `handoff.md`, or status is stale. `failedWritePublished: true` means the failed destination's text matches the attempted content, possibly because it already matched before this call. It does not prove this call wrote the file or that the write is durable; the failed stage's written flag remains `false`. Treat the flags as hints: inspect the files before retrying, and do not resubmit a report that already has a history copy. `report.md` is stale only when the latest report write did not publish; an update carrying only missing status, summary, or handoff fields does not refresh it. There is no journal or repair tool.

A bound implementation Forager calls `hive_task_update({ feature, task, report, handoff })` without `status`, `summary`, or `blocker`, then returns the numbered `reportPath`. When that update fails or its result is unknown, the Forager returns the confirmed history path, the failure stage and flags, the narrative when no history copy is confirmed, and the exact handoff text when the handoff did not publish. The primary records status and summary, repairs missing fields after inspecting the files, appends review-decision, interruption, and closure reports when they apply, and reads report content rather than trusting a path. Report numbers record write order, not author or session identity. Reports stay out of task briefs and the context catalog.

Manual tasks are append-only. `dependsOn` may name existing tasks whether or not they are done; creation applies the graph check above to the new task and to every existing unfinished task, so an older invalid dependency also blocks creation. Review-sourced manual tasks cannot declare explicit dependencies. In `hive_status`, a pending task appears in `runnable` when every stored dependency is `done`; a missing `dependsOn` field counts as `[]`.

## Recovery fields and failure classification

Merge results and ad-hoc cleanup results carry recovery classification fields alongside their operation fields. Feature-task cleanup returns `worktreeRemoved`, `branchDeleted`, `pruned`, and `cleanup` without recovery fields. Create and inspect return workspace information instead. The recovery fields describe where an operation stopped and what the caller may safely do next; an `ALREADY_INTEGRATED` or `NO_TRACKED_CHANGES` no-op also carries them, with `action: 'none'`. The merge tools throw an error, with no mutation and no classified result, for a missing task worktree or ad-hoc run, an unresolved feature, a `repoIds` mismatch, and a source pin that conflicts with the inspected candidate. Failures the merge service classifies come back as `success: false` results. A result with `success: true` can still carry a recovery classification, so read `reasonCode`, `action`, and `cleanup` on every result.

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
| `ALREADY_INTEGRATED` | `integration` | `none` | `false` | `none` |
| `NO_TRACKED_CHANGES` | `integration` | `none` | `false` | `none` |
| `MERGE_CONFLICT_ABORTED` | `integration` | `none` | `true` | `retry_same_operation` |
| `MERGE_CONFLICT_PRESERVED` | `integration` | `preserved` | `false` | `resolve_conflicts` |
| `GIT_OPERATION_FAILED` | `integration` | `none` | `true` | `inspect_state` |
| `ROLLBACK_FAILED` | `rollback` | `unknown` | `false` | `manual_recovery` |
| `POST_INTEGRATION_VERIFICATION_FAILED` | `verification` | `applied` when the operation checkpoint confirms the created commit; otherwise `unknown` | `false` | `inspect_state` |
| `CLEANUP_FAILED` | `cleanup` | `applied` after a completed integration; `none` for cleanup-only runs | `false` | `cleanup_only` |
| `COMPOSITE_PARTIAL` | `integration` | `partial` | `false` | `inspect_state` |

- `ALREADY_INTEGRATED` means the pinned source is an ancestor of, or equal to, the target under either intent. It is classified after the identity, cleanliness, and active-operation guards and before topology and local-data eligibility, so differing trees or protected ignored data do not turn it into `TARGET_RECONCILIATION_REQUIRED`. The result has `reason: 'already_integrated'`, `merged: false`, `mutation: 'none'`, `filesChanged: []`, `cleanupEligible: true`, no `sha`, and needs no `message`; feature results add `taskUpdateRecommended: true`. A source equal to the target reports `ALREADY_INTEGRATED`.
- `NO_TRACKED_CHANGES` applies only to `rewrite-private`: the source is not contained in the target and has no net tracked changes, so nothing is squashed or replayed. The operation is a successful no-op, `merged` stays `false`, and no `sha` is reported. Under `preserve-source` the same source is joined by a normal merge commit with `merged: true` and `filesChanged: []`.
- A composite no-op aggregate reports `ALREADY_INTEGRATED` only when every repository is contained; any private content no-op makes it `NO_TRACKED_CHANGES`. A graph-only preservation merge counts as an actual merge.
- `TARGET_DIRTY` covers tracked/index dirt and incoming-path collisions. `TARGET_RECONCILIATION_REQUIRED` means the integration topology is unsafe while the target contains local data, including ignored Hive state, dependencies, or build output. Reconcile the pinned target into the source worktree and return fresh pins; do not delete local data to make the retry pass. Hive's preflight scan and immediate or per-pick rechecks protect local data. Git merge flags are not the protection boundary.
- `filesChanged` on a successful integration is the observed difference between the target HEAD immediately before integration and the target HEAD after integration. Composite results flatten entries as `repoId:path`.
- Merge results include `success`, `merged`, `strategy`, `filesChanged`, `conflicts`, `conflictState`, `cleanup`, and the recovery fields above; `sha`, `commitMessage`, `reasonCode`, `repos`, and target identities appear when applicable. Both cleanup tools report per-step status for worktree removal, branch deletion, and prune using `not_requested`, `not_attempted`, `already_absent`, `succeeded`, or `failed`, plus a `failures` list in `cleanup`.
- `COMPOSITE_PARTIAL` means at least one repository was integrated and a later repository failed. Earlier repositories remain integrated. There is no rollback of partial composite outcomes.
- When integration succeeds and requested cleanup does not fully complete, including when a cleanup step throws or the pre-cleanup proof fails, the result keeps `success: true`, `merged`, `sha`, and per-repository outcomes, and reports `CLEANUP_FAILED` with `action: 'cleanup_only'`. When a later cleanup action such as metadata removal fails after the worktree, prune, and branch steps ran, those steps keep their observed status and the action is listed in `failures`; a single-root or per-repository exception with no step report leaves every requested step in that outcome `failed`. A composite aggregate may still be partial. Composite `cleanup.failures` names the repository for each per-repository entry, including a skipped proof; a `composite-root` failure has no `repoId`. Repeat only the cleanup step.
- After a `preserve-source` merge commit exists, Hive verifies that the target contains the source. When that check is negative or cannot be read, the result is `POST_INTEGRATION_VERIFICATION_FAILED`: the created commit is not rolled back, no cleanup runs, and `observedTarget` names the created commit.
- A missing, unknown, or incompatible `historyIntent` or `strategy` returns `INVALID_ARGUMENTS` before any lock, Git read, or mutation. When no strategy was resolved, the result omits `strategy`.

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

Canonical workspace names are metadata. Existing slotted or composite workspaces are selectable. Merge wants a clean source, a destination with a clean index and tracked working tree, the pinned SHA, a declared `historyIntent`, and an explicit message when it creates a commit. A commit message needs a nonempty one-line subject, blank line, and nonempty body. Disjoint untracked or ignored destination files may remain when the pinned source contains the pinned target history; rebase also requires a linear replay range. A source already contained in the target returns `ALREADY_INTEGRATED` before this check. For a noncontained source, unsafe topology with local data requires same-worktree reconciliation and fresh pins, even when Git reports a clean worktree because Hive state, dependencies, or build output is ignored. Incoming path collisions always block. Hive preflight and rechecks protect local data without relying on Git merge flags. Locks are operation-local. Dirty, untracked, ignored, and unmerged data is protected; there is no force or rm fallback. Same-call cleanup runs only after a proof across every selected repository; later ambiguous branches stay unless `discard: true` is explicit. `deleteBranch` alone does not discard an unmerged branch.

Stable public inputs:

| Tool | Inputs |
|------|--------|
| `hive_worktree_create` | `task`; optional `feature`, `baseRef`, `repoIds`, `candidate` |
| `hive_worktree_inspect` | `task`; optional `feature`, `repoIds`, `candidate` |
| `hive_worktree_merge` | `task`, `historyIntent`; required `expectedTarget` or `expectedTargets`; optional `feature`, `repoIds`, `candidate`, `strategy`, `message`, `preserveConflicts`, `cleanup`, `sourceCommit`, `sourceCommits` |
| `hive_worktree_cleanup` | `task`; optional `feature`, `repoIds`, `candidate`, `deleteBranch`, `discard` |
| `hive_adhoc_worktree_create` | optional `runId`, optional `repoIds`, optional absolute `sourceDirectory` |
| `hive_adhoc_worktree_inspect` | `runId`, optional `repoIds`, optional absolute `sourceDirectory` |
| `hive_adhoc_worktree_merge` | `runId`, `historyIntent`; required `expectedTarget` or `expectedTargets`; optional `repoIds`, absolute `sourceDirectory`, `strategy`, `message`, `preserveConflicts`, `cleanup`, `sourceCommit`, `sourceCommits` |
| `hive_adhoc_worktree_cleanup` | `runId`, optional `repoIds`, optional absolute `sourceDirectory`, plus `deleteBranch`, `discard` |

`historyIntent` is required and has no default. `preserve-source` permits only `strategy: 'merge'`, its default; it keeps existing source commits and their messages unchanged and validates only the new merge commit message. `rewrite-private` attests that all source-only history in every selected repository is private and authorized for rewriting; it permits `'squash'`, its default, or `'rebase'`, and rebase also validates every replayed source message. Hive does not prove privacy. For published-history repair, confirm that the known published commit is in the source or target ancestry and verify that it is in the final destination's ancestry before claiming repair.

Merge `cleanup` is `'none' | 'worktree' | 'worktree+branch'` and defaults to `'none'`. Cleanup `deleteBranch` defaults to `false`. `preserveConflicts` defaults to `false`. Do not provide a non-blank `message` with `strategy: 'rebase'`. Failed integrations attempt to restore the target unless an actual conflict is explicitly preserved. If target identity no longer matches after a commit, `recordOperationCommit` returns `POST_INTEGRATION_VERIFICATION_FAILED` with `mutation: 'unknown'` without rolling back. The same failure after squash staging retains staged operation state for inspection. A preserved conflict leaves an active Git operation in the destination checkout; do not call merge again while that state is active.

Ad-hoc worktrees are temporary workspace metadata only: no run history, evidence ledgers, or reports.

By default, a feature-task worktree lives at `.hive/.worktrees/{feature}/{task}` on `hive/{feature}/{task}`. A `candidate` changes the directory suffix to `{task}--{candidate}` and branch suffix to `{task}-{candidate}`. Composite workspaces put repository worktrees under `repos/{repoId}` and use branches `hive/{repoId}/{feature}/{task}` (with the candidate suffix when supplied). Ad-hoc runs use `.hive/.worktrees/adhoc/{runId}` and branch `hive/adhoc/{runId}`; composite branches are `hive/adhoc/{repoId}/{runId}`. An omitted `runId` is generated; an explicit one must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. The run ID is the branch suffix, so choose a readable one.

On creation, `repoIds` selects the repositories owned by the lane. Later feature-task lifecycle calls validate `repoIds` against the task's persisted repository selection; later ad-hoc lifecycle calls pass the same `runId` and the same `sourceDirectory` or `repoIds` used at creation. `sourceDirectory` selects a foreign checkout and cannot be combined with `repoIds`; it also sets the service root, so inspect, merge, and cleanup of a placement created for a foreign checkout must pass that same absolute `sourceDirectory`. For create, an absolute path resolving to the active project root is treated as omitted, so it may be supplied with project/manifest `repoIds`.

Manifest-backed ad-hoc creation requires a nonempty `repoIds` selection. Omitting it reports a topology error before Git runs; inspect the project repository manifest and select the repositories owned by the run.

When a manifest-backed project's root is not a declared Git repository, lifecycle tools require the selected workspace's `workspace.json`. A wrong task folder, candidate, or run ID, a repeat cleanup after that metadata was removed, or an existing directory without metadata reports `Composite workspace manifest not found` with the expected path before running Git against the project root. Check the exact selector and retained placement; `repoIds` and source pins cannot replace missing workspace metadata. Status reports invalid entries in `worktreeErrors: [{ path, reason }]` and keeps healthy worktrees and task summaries readable. Hive preserves those directories for inspection. Existing single-root placements remain readable when the project root is still a declared repository, including a symlink alias of that root.

For an orphaned composite workspace whose metadata cannot be recovered, an operator or authorized primary may perform the manual recovery below. Helper may inspect and return evidence but cannot execute removal, pruning, or branch deletion, and a failed Hive tool never authorizes Helper to reproduce it with raw Git.

To remove confirmed orphan registrations:

1. Use the reported workspace path and `.hive/repositories.json` to identify the owning repository roots. A feature task's `status.json` `repoIds` and retained `repos/<repoId>` directories help locate the selection. Confirm every exact worktree path and branch with `git -C "<repository-root>" worktree list --porcelain`; do not run Git from a non-Git project or composite root. Preserve source commits and local files before removal.
2. For each confirmed repository, inspect `git -C "<workspace-path>/repos/<repoId>" status --short --ignored`, then run `git -C "<repository-root>" worktree remove "<workspace-path>/repos/<repoId>"` only after its work is integrated or its contents have been deliberately retained elsewhere. If the worktree directory is already absent, review the stale registration and run `git -C "<repository-root>" worktree prune`. Also prune after successful removal.
3. After confirming the branch is integrated and is not checked out elsewhere, run `git -C "<repository-root>" branch -d "<confirmed-branch>"`. Use the branch from the registration, with the feature/ad-hoc and candidate naming described above. If Git refuses removal or branch deletion, retain the state and resolve the cause before retrying.
4. Once every repository registration is handled, remove only empty `repos/<repoId>`, `repos`, and workspace directories with `rmdir`. Retained files must be inspected and preserved before those directories can be removed. Refresh `hive_status` to confirm the orphan diagnostic is gone.

Use `sourceCommit` for a legacy single-root workspace. When persisted `repos` are present, use `sourceCommits` as a complete map keyed by persisted repository ID. A singleton composite also accepts a matching scalar `sourceCommit` convenience; multiple repositories still require the complete map. At the tool boundary, the runtime fills an omitted source pin from its own source inspection at merge time. That selects the source as observed in that call. It does not show that the source was ever verified, and it is the only thing the omission means: a worker-returned pin identifies the candidate the worker checked, and omitting the pin cannot recover that identity if the source has since moved. A supplied composite map must match every inspected repository; it rejects a map for a legacy single-root workspace, a scalar for a multi-repository composite, both pin forms together, and any supplied pin that differs from the inspected candidate, so a stale explicit pin fails before any mutation while an omitted one merges the newer source. In a worker handoff, pass the worker's returned topology-aware pin unchanged to merge.

Both create tools return the initial inspection directly, in the same shape as their inspect tool: placement, source `commit`, `baseCommit` or `baseCommits` when recorded, `clean` (including untracked and ignored dirt), and destination state. A reused worktree is inspected again, so its result reflects current state. Composite results include per-repository source commits and cleanliness under `repos[repoId]`, plus aggregate `clean`. There is no additional inspection wrapper or duplicate placement projection.

A legacy inspection has top-level `target` and `comparison`; composite results put them only under `repos[repoId]`. `target` is `{ path, ref, commit }`, where `path` is the canonical absolute destination root, `ref` is the full `refs/heads/...` name or `null` when detached, and `commit` is the full OID. If destination identity cannot be read, inspection retains source details and returns `target: null` with `comparison.status: 'error'`. Comparison is one of `{ status: 'ok', targetIsAncestorOfSource }`, `{ status: 'no-common-ancestor' }`, or `{ status: 'error', error }`. A shallow repository may therefore report locally no common ancestry; inspection never fetches and ancestry does not establish semantic completeness. Record the initial target identity from create before dispatch. Later inspect checkpoints after writing handoffs, before review/remediation, after sibling integration or destination movement, and before integration remain required.

Every merge must include exactly one target expectation: the exact inspect value as `expectedTarget` for legacy mode, or `expectedTargets` as a complete map for composite mode. In a composite, the map's keys must equal the candidate's repository IDs, and each value is that repository's `repos[repoId].target` from inspect. A singleton composite accepts a scalar expectation and normalizes it without changing identity values. Missing, both, malformed, extra, or topology-incompatible expectation forms fail with `INVALID_ARGUMENTS`. The two target fields stay optional in the argument shape because the choice depends on the workspace; the merge service validates the rule. Runtime forwarding never fills or refreshes target expectations. `TARGET_MISMATCH` includes expected and observed identities, performs no mutation, is not retryable, and requires `inspect_state`. All composite targets are checked before the first repository mutation and each target is checked again at its integration boundary. Earlier composite integrations remain when a later boundary fails.

The identity guard coordinates Hive operations under the existing repository locks. It does not exclude arbitrary Git writers or another lock namespace; callers still need exclusive destination ownership. Squash integration rechecks identity after staging and before commit. If it moved, Hive leaves the source and staged operation state for inspection and reports post-integration verification with unknown mutation rather than committing or destructively resetting external changes. Before any destructive same-call cleanup, Hive rereads the full target path/ref/commit and the source pin, including for no-op cleanup, and checks the proof the completed work requires: source containment in the target for `preserve-source` merges and `ALREADY_INTEGRATED` no-ops, or verified completion plus the `rewrite-private` attestation for squash, rebase, and private content no-ops. A composite proves every repository before removing anything. A failed proof retains every source placement and reports a `cleanup.failures` entry (`identity-recheck` or `ancestry-proof`).

## Background Orchestration (4 tools)

These tools are primary-agent-only. V1 enables them with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` around native `task({ background: true, ... })`. V2 supplies native `subagent({ background: true, ... })` and the board without that experiment gate.

| Tool | Purpose |
|------|---------|
| `hive_background_status` | List background jobs visible to the originating native parent and call |
| `hive_background_reconcile` | Mark a terminal native background job as reconciled or intentionally ignored with a required summary, then archive it from normal status output |
| `hive_background_reconcile_batch` | Mark multiple terminal native background jobs reconciled or intentionally ignored in one scoped operation, then archive them from normal status output |
| `hive_background_cancel` | Request cancellation for a visible background job: v1 aborts the child session and records runtime cancellation once the abort succeeds; v2 records only the host's interruption acknowledgement |

`hive_background_status` takes optional `feature`, `task`, `adHocRunId`, `workflow`, and `includeArchived` (default `false`). The result contains `jobs`, `scope`, `recommendedNextAction`, `requiresHiveStatusRefresh`, and scheduler/notification guidance when applicable. `hive_background_reconcile` requires `identifier`, `decision: 'reconciled' | 'ignored'`, and `summary`. It returns a compact acknowledgement `{ identifier, decision, success: true, archived: true, state: 'archived_after_reconcile' | 'ignored_archived', requiresHiveStatusRefresh }`, or `{ identifier, decision, success: false, reason, error, hint }`. The refresh flag is true when the successfully archived job had feature or task scope, including ignored stale/uncertain observations. It does not echo the summary, full job record, or board scheduler guidance. The batch form returns `{ success, results, requiresHiveStatusRefresh }` in input order; aggregate success requires every item to succeed, and aggregate refresh is true when any successful item requires it. A malformed item or persistence error fails that item alone; successful items remain archived. Inspect a `reconciliation_failed` item before retrying because a failed write may have published. Cancel requires `identifier` and `reason`; its response distinguishes `runtimeCancelled` from a recorded request.

Failure `hint` is one actionable string. `job_not_terminal` tells the caller to wait for the native completion notification. `stale_job_requires_ignore` and `uncertain_job_requires_ignore` give an exact `hive_background_reconcile({ identifier: "<canonical-alias>", decision: "ignored", summary: "..." })` call; archiving only retires the observation. Resolution failures point to the correct identifier, originating parent scope, or archived view; summary failures request a non-empty summary, and persistence failures request inspection before retry.

The board observes the originating native parent and call, not the current feature or agent, and only for background launches, which on v2 include a foreground call moved to the background; see [Foreground children after a restart](#foreground-children-after-a-restart). Stale and unknown observations stay visible. It does not couple to execution, worktree, or task status. Multiple launch observations may exist for one native task identity when explicit runtime-owned interruption recovery is used. If completion lacks a call ID or its identity is ambiguous, record unknown and hint `hive_task_trace`; never guess the latest child. Missing or ambiguous completion identity must not block unrelated dispatch, but ownership-overlapping work still requires inspection or waiting; do not send another prompt or launch another writer.

On v1 with the env gate unset, the background management tools return `background_tools_disabled`. Primary agents keep normal blocking `task()` wait mode. With the env gate set, primary orchestrators receive delegate-first background scheduling guidance and the board tools are active. V2 availability follows its native background support.

`hive_background_status` owns `recommendedNextAction`. Both status and reconciliation can set `requiresHiveStatusRefresh`; when true, refresh `hive_status` before dependent feature/task or merge decisions. Reconciliation acknowledgements describe only the requested items; use background status when a later decision needs the remaining board.

Reconcile terminal background jobs first, then refresh `hive_status` before dependent task or merge decisions for scoped feature/task work.

If `hive_background_status` returns `schedulerGuidance.reason: wait_for_native_completion_notification`, do not refresh repeatedly. Wait for OpenCode's native completion notifications, then inspect the board.

Cancellation is not rollback. `hive_background_cancel` acts on the child session of one visible board row. On v1 it calls OpenCode's session abort, and `runtimeCancelled: true` means the abort request succeeded; v1's native abort also cancels that session's running background jobs and their descendants. On v2 it interrupts the child session with resume disabled. `interruptAcknowledged: true` means the host accepted the interruption; `runtimeCancelled` stays `false`, and the row keeps its cancel request on record. When the board later observes the execution settle or the completion notification, it marks the row uncertain, never cancelled. Background children that the interrupted session launched keep running; this cancel does not reach them. Cancel acknowledgement does not prove the worker stopped, or that subprocesses it started have ended. Do not invent native task IDs. Reconcile and ignore archive board rows only.

On v2, a blocking `subagent()` child is tied to its caller: interrupting the parent turn interrupts the child and cancels its job. A background child does not: `subagent({ background: true })` launches, and foreground calls moved to the background, keep running after the parent turn is interrupted or ends. Request cancellation of one that is no longer needed with `hive_background_cancel`.

On v2.0.26 every native completion notification lacks the launching call ID. All matching rows, including a singleton, stay `unknown`/uncertain with the native outcome in `lastStatusError`. Terminal reconciliation returns `uncertain_job_requires_ignore`; inspect the child, then archive only the exact canonical alias with `decision: "ignored"`. Same-process reload makes existing observations uncertain, while a process restart makes old rows stale/uncertain. Native interruption acknowledgement is separate from settlement and notification; none of these board states authorizes dispatch or a replacement writer.

V2 dispatch binds captured parent route/constraints at awaited native progress before child prompt admission. Fresh children and proven-compatible parent-bound continuations need no read client. Adopting an existing native direct child whose Hive binding is missing or has no parent, or changing route/constraints/agent, requires the explicit server option and verified native idle before the native executor can switch or prompt it. Hive checks native parent ancestry first. An activation-local reservation precedes the awaited read and releases on every exit; a matching pending reservation alone is not compatibility proof. Idle rebinding is supported, with no lifetime-immutable route or external same-child atomic-fence guarantee.

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

V2 reads the complete public message timeline, not active context or a filtered export, through the verified server client. The `server` option binds the exact activation/location using its held nonce; both identity checks bracket each read. Placement is independent of native relationship: self, child, descendant and other are classified without rerouting another location. Non-direct-child recovery stays inspect-only. Native `subagent` rows use their recorded `sessionID` metadata for child disclosure.

When verified read access fails, the `read_access` string names a connection or caller boundary: `not_configured`, `unauthorized`, `unreachable`, `wrong_location`, `wrong_instance`, `caller_unavailable` or `caller_displaced`. Target failures such as `target_unavailable` and `inconsistent_lookup` return `unavailable_or_unauthorized` without `read_access` to avoid disclosing target details. Missing configuration is not an empty timeline or confirmed idle. Configure the URL and password environment-variable reference in the **server process**; custom variables may also reach trusted tool subprocesses. The reader cannot guess a server or start one.

Each page lists events in source order under a 24 KiB budget (`render.bytes` is exact) and always makes forward progress. An event is one text, tool, retry, patch, compaction, or unsupported part, or an assistant message error. Step markers are counted as `source.structural_parts`. Reasoning is excluded from events, refs, cursors, guards, and errors; `reasoning` reports only part, byte, and token counts.

Each row carries `seq`, `kind`, `actor`, and, where recorded, `tool`, `status`, `call_id`, and `title`. Tool rows show the complete `input` when it is small; otherwise they show the recorded identifying keys that are present (`description`, `command`, `filePath`, `path`, `pattern`, `name`, `url`, `query`, `subagent_type`). Text, output, and error excerpts keep a head and a tail around ` [...] `, so commands and outputs that share a long prefix stay distinguishable. `bytes` gives the canonical size of each present field; a field missing from `bytes` is absent. `abbreviated` names every displayed value that is not complete, including long tool names, titles, types, and call IDs.

A native `task` call row also carries `child_session_id` when the call recorded exactly one valid child ID (in `state.metadata.sessionId`, optionally mirrored in part metadata) and a fresh `session.get` confirms that session exists with the traced session as its parent. Each read checks the distinct candidates on the displayed page or selected event again. A missing, malformed, conflicting, or unconfirmed identity shows no field, and raw metadata is never shown. The recorded identity is part of the event guard, so a ref stops resolving when it changes.

`context.assignment` is the first user text. `context.final` is the terminal assistant text for a terminal lifecycle and is a `child_self_report`, not proof. Both link to their event with `ref` when the event has one and carry `identity` like index rows.

`coverage.next_cursor` continues the index. Pass the entire string unchanged as `cursor`; read one event's detail by passing that row's `events[n].ref` as `event` to `hive_task_trace_content`. The cursor is a readable string of the form `trace-cursor:v3:<scope>:<after_seq>:<guard>`. `scope` is `prefix` or `source`, `after_seq` is the last `seq` already returned, and `guard` is the complete 43-character SHA-256 digest. Callers do not decode or rebuild it. A copy that no longer has this form, such as a shortened or padded one, returns `invalid_cursor` with a `hint`, and an edited copy that keeps the form but no longer matches its guard returns `cursor_stale`; omit `cursor` to restart from the first page. Cursors issued before this form (a base64url encoding of a four-element JSON array) are still accepted when valid. After `cursor_stale`, restart from the first page. A `prefix` cursor guards the native-identity chain of the events already returned. When every event up to the cursor has native identity, the cursor accepts appended events and returns `cursor_stale` when any earlier eligible event was inserted, deleted, or changed. When any of those events lacks native identity, the cursor is a `source` cursor and any change to the eligible source returns `cursor_stale`, including an append, because deleting one of several identical events would otherwise go undetected. `coverage.complete: true` means the pages from the first to this one covered every eligible event in the surviving source as observed. It is not evidence about history the runtime no longer holds or about the filesystem. `coverage.limitations` lists `compacted_source`, `compacted_tool_output` (rows marked `compacted`), `unsupported_parts` (rows with `kind: "unsupported"` and only a bounded `type`), and `positional_identity` (rows marked `identity: "positional"` or `"ambiguous"`).

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

Summarizer requests carry a per-stage output contract built from the same strict schema that validates the reply. Map replies are `{ kind: "map", range, cards }` and reduce replies are `{ kind: "reduce", semantic }`; unknown or missing keys, blank strings, and wrong ranges are rejected. A malformed map card falls back on its own step while valid sibling cards are kept. A step with neither observed evidence nor plaintext reasoning takes the explicit all-empty card. An unfinished claim must cite at least one step that has observed evidence or plaintext reasoning, and a completed claim must cite at least one such assistant step, which the reduce request lists as `completion_steps`; a user request can support an unfinished claim but never a completed one. A claim citing only unsupported steps fails reduce validation, and a recovery with no such assistant step always proposes `inspect`. The configured variant is validated against provider metadata and never claimed as applied when unavailable; `recovery.model.observed` comes from the host's response. A provider error, absent or unparseable text, or a request above the model input budget (including the contract) falls back deterministically. Failure entries may include at most four value-free `diagnostics`, never provider messages, bodies, source text, or model text. Cleanup of ephemeral sessions is always attempted under bounded deadlines; a cleanup failure is reported and any session ID whose deletion is unconfirmed is retained. There is no model fallback or automatic retry.

Semantic output is always `untrusted: true`. Generated `source_steps` arrays are sorted context source coverage, not evidence or proof. Never accept, merge, retry, resume, or auto-run from recovery output.

Ordinary v1 trace/content cancellation behavior is unchanged. Ordinary v2 trace/content reads stop with the calling invocation, including identity, relationship, paging and status requests. Recovery reads/generation cancel with the caller on both hosts; cleanup uses independent bounded deadlines.

For v2 recovery, the plugin allocates the summarizer ID before public `session.create({ id })`, excludes the target ID before ownership/create, and keeps allocated IDs cleanup-owned even if creation commits before returning. Cleanup waits for an unsettled create within its 10-second deadline. Native `Session.NotFoundError` or `SessionNotFoundError` confirms absence. A create that commits after that window can leave a known unconfirmed ID; there is no later sweeper. Live failures report `ephemeral_cleanup_failed`; interrupted callers retain unconfirmed IDs in activation-local accounting. V1's acquisition behavior remains unchanged.

Each recovery binds one model selection when it starts and uses it for the model metadata and every map and reduce request. With no `taskTraceSummarizer` model, the selection is the invoking caller session's current native model and variant, read without changing that session; a v2 caller session without its own model runs on the host default model, which is bound with no variant only when that default names a provider package, since the v2 runner otherwise picks another model that Hive does not reproduce. A configured `model` alone replaces the caller's model and uses that model's default variant; a configured `model` and `variant` replace both. Configuration validation rejects a `variant` without a `model`. If the caller's selection cannot be established, recovery returns `status: "unavailable"` with a `model`-stage `summarizer_unavailable` failure and the `caller_model_unavailable` diagnostic, and no session is created; Hive never substitutes a guessed model. `recovery.model.requested` reports the bound `model`, `variant` and its `source` (`caller` or `configured`). Unsupported variants produce `variant_unavailable` before creating a session, rather than silently dropping the request. Hive sets no request options such as temperature on summarizer requests. Observed model/variant comes from the actual native generation (the v2 `generate` hook, or the v1 reply info). Provider-internal retries are not claimed controlled by Hive.

### Foreground children after a restart

On v1 the background board tracks only `task({ background: true })` launches. On v2 it tracks `subagent({ background: true })` launches and also a foreground `subagent()` call that the user moved to the background: that call returns `running` with the child's `sessionID`, and Hive records its board row when the result arrives. A foreground call that returned no result has no board row on either host, so `hive_background_status` does not list it and `hive_background_cancel` returns `job_not_found` for it. When a host restart ends a foreground call before it returns, the parent's stored call keeps `running` or `pending` status and the parent never received the child ID in a result. These paths can name the child:

- On v1 only, on each later turn, the runtime adds a replay hint to the parent's call naming `hive_task_trace({ task_id })` for the child. The hint says the call has no recorded result and the child may still be in flight. Hints are rebuilt for every turn. Only a child's newest recorded call decides its hint, so a later result for the same child supersedes an older call that has none. Hints cover up to the eight newest children whose newest call needs one, and skip a call that is still the latest message, background launches (`background: true` in the call's recorded metadata or input), and children the runtime does not confirm as direct children of that parent. Empty and terminally unsuccessful foreground task results get the same kind of hint.
- `hive_task_trace` on the parent session (self inspection is allowed) shows `child_session_id` on a parent's native call row (`task` on v1, `subagent` on v2) only when the stored call records the child's session ID in its metadata and the runtime confirms that child belongs to the parent. On v2.0.26 a `subagent()` call reports its child through progress events, which do not reach the stored call's metadata, so a foreground call that never returned may show no `child_session_id`.

Use these paths instead of runtime exports or `.hive/sessions.json`; neither is a trace source. When neither path names the child, its identity stays unresolved; a missing child ID does not show that the child stopped, so wait, ask, or keep inspecting instead of launching a replacement writer. When a path names the child, trace it, and treat its lifecycle and any evidence-only snapshot under the rules above before deciding to wait, ask, or launch fresh.

Configure an optional recovery model under global `taskTraceSummarizer` (`model`, and `variant` only with `model`). Operator reference: [Task trace summarizer](../README.md#task-trace-summarizer).

## Context (5 tools)

| Tool | Purpose |
|------|---------|
| `hive_context_read` | Read a scoped summary, bounded durable catalog, or chunked exact document |
| `hive_context_write` | Explicitly create a scoped file, or replace one whole document with revision and hash preconditions |
| `hive_context_append` | Append a dated block while preserving prior bytes and checking revision plus content hash |
| `hive_context_edit` | Replace one exact passage of an existing file, keeping every other byte, with revision and hash preconditions |
| `hive_context_archive` | Selectively archive named files with a reason, revision, and per-name hashes |

All five context tools accept optional `scope: 'feature' | 'project'` (default `feature`) and optional `feature` for feature scope. Read also accepts `name`, `view: 'summary' | 'catalog'`, `query`, `limit`, `cursor`, `maxBytes`, and `scanChars`, subject to the view restrictions below. Write requires `name` and `content`, with optional `kind`, `task`, `expectedRevision`, and `expectedContentHash`; omit the preconditions only when creating a missing file. Append requires `name`, `content`, `expectedRevision`, and `expectedContentHash`, with optional `section` and `task`. Edit requires `name`, `oldText`, `newText`, `expectedRevision`, and `expectedContentHash`, and takes no `kind`, `task`, or section option. Archive requires `names`, `reason`, `expectedRevision`, and `expectedContentHashes`.

Omitted `scope` retains feature-default behavior. Use `scope: "project"` explicitly for `.hive/context/`. Tool scope selects data. Foragers and reviewers write feature and project context through revision and content-hash checks. Scouts are read-only. Archive is primary-only.

With no `name`, `hive_context_read` defaults to `view: "summary"`. Use `view: "catalog"` with optional literal `query`, `limit`, and returned `cursor` for durable metadata discovery. Named reads accept `cursor` and `maxBytes`, return `range: { startByte, endByte, totalBytes }`, `complete`, and `nextCursor`. `maxBytes` defaults to 16 KiB and cannot exceed 64 KiB.

For shared contracts, repository-wide conventions, or cross-feature decisions, permitted non-isolated agents consult the project catalog alongside relevant feature context. Catalog `task` associations are relevance hints, not filters or authority. See [context-engineering](../skills/context-engineering/SKILL.md) for selective reads and review isolation.

A named read pages through one document. Its `nextCursor` binds the document, scope, revision and content hash, so a cursor from another document, an earlier revision or another activation fails as `stale_context_cursor`; restart the read. Finish the chunks (`complete: true`) before replacing a document, because a partial read does not cover the whole file. Creating a name that exists fails with `context_already_exists`. On `context_index_invalid` or `context_reconciliation_required`, stop managed mutations and report the actual error; reading about repair does not authorize an agent to edit Hive control files.

`hive_context_edit` changes one passage without reproducing the rest. The caller's own named read needs to show the whole passage and enough surrounding text to justify the change; unrelated chunks may stay unread. Every chunk carries the whole-file hash, so the revision and hash guards refuse a document that changed after the read, but they do not show what unread bytes say. Under the context lock the service checks the revision, then the hash, then requires `oldText` to occur exactly once as literal UTF-8 bytes, counting overlapping occurrences. It splices `newText` between the untouched prefix and suffix bytes, so BOM, CRLF, Unicode and replacement patterns such as `$&` are preserved as written. Failures are `context_not_found` (no namespace is created), `context_edit_no_match` (the message names CRLF when the document has it), `context_edit_ambiguous`, `context_edit_no_change` for identical text, `invalid_argument` for empty `oldText` or an unpaired surrogate, `context_invalid_utf8`, `context_input_too_large` when an operand or the edited document exceeds 1 MiB, and `invalid_context_metadata`. Each is refused before publication and writes nothing. Empty `newText` deletes the passage; evidence and reserved files may become empty, while durable files keep their required metadata. The edit keeps the index kind, task and `createdAt`, advances the revision once and returns the same result shape as write. After an error or unknown result, read and confirm whether the edit applied before retrying: an identical retry after success fails `stale_revision`, a blind replay can apply twice when `newText` contains `oldText`, and seeing `newText` does not prove this call applied it. The lock and guards cover writers that use the context tools; a direct file write during publication is outside that guarantee, and a publication error restores the prior bytes or leaves the pending marker, after which managed mutations report `context_reconciliation_required`.

Call `hive_context_read` before replacement, edit, append, or archive. Existing-content mutations require the current revision and actual SHA-256 `contentHash`. Non-reserved files default to `durable`. Mark raw logs and historical verification material as `evidence`. Feature hygiene warnings begin above 8 durable files or 40,000 UTF-16 code units; project warnings begin above 32 files or 160,000 units. These are review signals, not aggregate admission limits.

`overview`, `draft`, and `execution-decisions` are reserved and excluded from the durable catalog and durable-context hygiene counts. `overview` keeps a feature's purpose and design summary and `execution-decisions` the reasoning behind orchestration choices; progress, revision history, and routine execution narration go to the [Worklog](#worklog-3-tools). They remain readable by name. They do not accept a caller-provided `kind`; the per-document size limit still applies. Plan approval does not archive `draft`. Archive an obsolete draft explicitly after approval.

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

## Worklog (3 tools)

| Tool | Purpose |
|------|---------|
| `hive_worklog_list` | List feature and session Worklogs from their storage files, newest first |
| `hive_worklog_read` | Read one Worklog's brief, history, or recorded-facts view |
| `hive_worklog_record` | Append one checkpoint, optionally replacing the current briefing in the same commit |

A Worklog is a short account of where work stands: a current briefing a reader can absorb in about thirty seconds, plus append-only checkpoints. Each feature has one log shared by every primary session; ad-hoc work uses the calling session's own log under its host owner. Reads also project recorded task facts from `status.json` files, which describe stored state only. The service contract, including storage, limits and every failure reason, is [docs/WORKLOG.md](../../../docs/WORKLOG.md); results are the core result shapes unchanged, so each names its resolved `ref` and `key`.

- `hive_worklog_list` takes optional `kind` (`feature` or `session`), `limit`, `cursor`, and `maxBytes`. It reads the fixed storage locations, not the session index, so completed and archived features and ended sessions stay listed.
- `hive_worklog_read` takes optional `ref`, `view` (`brief` default, `history`, `facts`), `limit`, `cursor`, and `maxBytes`. Without `ref` it reads the feature selected for the calling session with `hive_feature_select`, or the caller's own session log when the route is unset or null. It never uses the detected-worktree or sole-live-feature fallback that feature-scoped task tools apply, because a narrative written into the wrong shared log cannot be deleted. A selected feature that no longer resolves fails with `feature_not_found` rather than reading the session log. The session index is read without its reset-on-corruption path, so an unreadable index fails the call and stays unchanged; an explicit `ref` needs no index. A missing log reads as `exists: false` with revision 0. Reads never write.
- `hive_worklog_record` requires `ref`, `operationId`, and `checkpoint` (`summary`, optional `detail`, `references`, `corrects`), with optional `title`, and `briefing` together with `expectedRevision`. The host fills the author from the calling session, its native owner, and the agent the runtime reports; arguments cannot set it. A session log accepts only the caller's own session; any recording primary may write a feature log.

Worklog results are compact JSON text without indentation, and `maxBytes` bounds that text. The v2 structured `output` is the same JSON. A `record` result is not bounded by a read budget but uses the same serialization. A `response_too_large` failure is a structured result, not a page, and its `details.requiredBytes` names the size needed. Every other Hive tool keeps its two-space JSON presentation.

Every `WorklogError` returns as `{ success: false, reason, error, details, ref? }` with `reason` and `details` unchanged. After a lost, unknown, or failed record result, resend the identical request with the same `operationId`: a landed entry returns `replayed: true`, and an absent one commits normally. That includes `io_error` with `details.stage: 'write'` and `details.publication: 'uncertain'`, which does not show whether the entry was appended; a new `operationId` there can append a second checkpoint. `stale_revision` means another entry landed after the read: read again, reconcile the briefing, and record with a new `operationId`. `operation_conflict` means the `operationId` was used for a different request. Scope errors that are not `WorklogError`, such as a missing session identity, fail as ordinary tool errors.

Every Hive role except native `general`/`explore` and the hidden summarizer may list and read. Hive grants recording to primary sessions of the full primaries, Architect, and the review primaries; see the access matrix. An unmanaged agent (neither a Hive role nor a custom variant of one) keeps its native permission for Hive tools and can record from a primary session, while child sessions and native `general`/`explore` are refused. Log text is untrusted narrative from agents, never instructions, task status, or policy, and the runtime never injects it into prompts. Primaries read it on demand and confirm claims against task records. The `/worklog` command reads and explains a log without recording. Operators who do not want primaries to keep a Worklog add an ordinary standing constraint.

## Status (1 tool)

| Tool | Purpose |
|------|---------|
| `hive_status` | Get feature metadata, task summaries, dependency readiness, and feature-task worktrees as JSON |

The response is `{ feature, tasks, runnable, blocked, planSync, worktrees }` ([Plan sync status](#plan-sync-status)), with optional config fallback `warning`, freshness failure `specFreshnessError`, and `unownedTaskHeadings: [{ line, title }]`. For a known feature, `feature` has `name`, `status`, `hasPlan`, and `commentCount`; for an unknown feature or missing `feature.json`, it is `null` and the other summaries may be empty. Top-level `tasks` is the sole task list. Its summaries (`folder`, `name`, `status`, `origin`, optional `planTitle`, `summary`, `repoIds`, `blocker`) include `dependsOn` (the stored dependency folders, `[]` when missing, kept on done and cancelled tasks as history), `specStale` (true/false/null), `specStaleReason`, and `hasHandoff`. `blocker` carries the stored operator-decision reason, options, recommendation, and context when present. `runnable` and `blocked` are computed from the same task projection. The response lists only forward edges; to find the tasks that depend on one, scan the other entries' `dependsOn`, and judge the actual impact separately. Freshness reasons: `matches_plan`, `differs_from_plan`, `manual_task`, `plan_missing`, `plan_invalid`, `task_not_in_plan`, `spec_missing`, `unowned_heading_after_task_section`, and `freshness_unavailable` when a check fails (with top-level `specFreshnessError`). `differs_from_plan` compares stored spec text with what the current plan would generate, including generator or manual-spec changes; unrelated plan sections do not affect it. `runnable` is a list of folders and `blocked` maps folders to unmet dependencies. Read `status.json`, `spec.md`, `handoff.md`, and reports for other bodies. Ad-hoc runs and the background board do not appear in this response.

Every retained task folder stays visible. A missing or unreadable/corrupt `status.json` yields an integrity entry `{ folder, name, status: null, integrity: { reason: 'status_missing' | 'status_unreadable', error? }, specStale, specStaleReason, hasHandoff }`. The error is present for unreadable/corrupt status. Freshness is derived by folder identity when possible, and existing specs/handoffs are retained. Integrity entries have no invented origin or dependencies, never appear in `runnable` or `blocked`, and never satisfy another task's dependency. Inspect and repair the authoritative task records before treating that folder as executable.

`worktrees` contains healthy entries. When a workspace or namespace cannot be read or validated, the response adds `worktreeErrors: [{ path, reason }]` and retains the remaining feature, task, dependency, and worktree summaries. See the manual orphan recovery procedure under [Worktree families](#worktree-families-8-tools).

### Native feature-task brief

Task folders are sourced from `TaskService.listStatusEntries`. A bound folder with missing/unreadable status receives one actionable `Task status integrity: ...` line with its integrity reason, directing the worker not to execute and the primary to inspect and repair the status. The folder value may be shortened to fit the 2048-byte cap; the repair instruction is retained. Healthy task briefs label integrity-failing dependencies with `status_missing` or `status_unreadable` instead of `unknown`.

Only native `task()` dispatches whose agent resolves to base `forager-worker` (built-in or custom variant) **and** whose route snapshot has an explicitly selected feature (`selected: true`) are eligible. Fallback and explicit-null routes get neither brief nor notice. The binding is the authored assignment's first non-empty line, trimmed: `Hive task: <task-folder>` for a task listed for that feature. After the unchanged route-snapshot block, a bound dispatch receives a generated block bounded by `<!-- hive-task-brief:start -->`, `## Hive task brief`, and `<!-- hive-task-brief:end -->`, at most 2048 UTF-8 bytes:

- A framing line, then `Task: <folder> - <plan title> (<status>)`; long titles end in `...`.
- `Spec: <abs path> - specStale: <v> (<reason>)` is always present; use `freshness_unavailable` when freshness cannot be computed.
- `Plan: <abs path>[ lines a-b]` is omitted if `plan.md` is missing.
- `Plan sync <state>: <hint>` appears when the feature's [plan sync status](#plan-sync-status) is not `current`. Unowned-heading line numbers after the task's section follow when present.
- `Handoff: <abs path>` appears when this task has a successor handoff.
- `Dependencies:` lists `- <folder> (<status>)[ handoff: <abs path>]` entries from the task record's `dependsOn`, with `unknown` for unknown folders, or `Dependencies: none`.
- `Feature context: <n> durable catalog entries; read with hive_context_read({ feature: "<feature>", view: "catalog" }).` gives the durable count (`unknown` when it cannot be read) and the exact catalog call. `Execution decisions: <abs path>` follows when that file exists. No document bodies are included.

To fit the budget, trailing dependency entries are dropped with `- (+<k> more; see hive_status)`. If still too long, retain core lines plus the plan-sync, unowned-heading, and handoff lines, then core lines alone; never cut a path. When locators cannot fit, the result is `Hive task brief unavailable: locators exceed 2048 bytes.` An eligible unbound dispatch gets one line under the heading: `No Hive task binding: ...` (missing/invalid marker or unknown folder); composition errors give `Hive task brief unavailable: <message>`. On each task dispatch, only generated blocks (a start marker immediately followed by its heading line) are replaced, for any agent; marker text quoted elsewhere in an authored assignment is preserved. Reviewers, scouts, advisors, and helpers never receive a brief. For task-scoped review, the primary supplies feature/task identity, plan path and current section, spec path, and current `specStale`/`specStaleReason` from `hive_status`; reviewers may query status with the explicit feature to clarify current state.

## Snapshot

`hive_git_snapshot` is a low-level diagnostic. Inputs are optional `directory`, `repositoryIds`, `baseRef`, `targetRef`, `range`, `paths`, `maxFiles`, and `maxPatchBytes`. `directory` must be an absolute exact Git top-level and cannot be combined with `repositoryIds`; `repositoryIds` requires a manifest. It returns a `hive-git-snapshot/v1` envelope: `{ schema, status: 'ready', consistency: 'validated', snapshots: [{ repositoryId, snapshot }] }`, or `{ schema, status: 'failed', consistency: 'failed', failures: [{ repositoryId?, code, phase, retry, message }] }`. Capture is bracketed by a generation check that fails with `SOURCE_DRIFT`. One 15-second operation deadline covers the whole capture.

Each snapshot has `repository`, `scope`, `consistency`, `limits`, `changedPaths` (comparison, staged, unstaged, untracked), `fingerprint`, `patch`, and `omissions` (counts by changed-path group, patch truncation/omitted bytes, and per-section captured/returned/omitted bytes and reason). Error codes are `INVALID_REQUEST`, `UNSAFE_REPOSITORY_STATE`, `INCOMPLETE_UNTRACKED_CAPTURE`, `OUTPUT_LIMIT_EXCEEDED`, `OPERATION_TIMEOUT`, `SOURCE_DRIFT`, `INTERNAL_ERROR`, `missing-ref`, `merge-base-unavailable`, `output-truncated`, and `timeout`. Phases are `validation`, `ref-resolution`, `preflight`, `capture`, `untracked-capture`, `revalidation`, or `serialization`; retry values are `fresh-capture`, `narrow-scope`, `operator-action`, or `not-retryable`. `maxFiles` defaults to 100 (cap 200); `maxPatchBytes` defaults to 64 KiB (cap 256 KiB). Supplied limits above the caps are clamped. At most 32 repositories can be captured in one call. A composite snapshot set is all-or-error.

`/dash-review` and `/vuln-review` are ordinary orchestrators over natural folders, inline text, or the current checkout. Optional snapshot `directory` and an ad-hoc worktree cover a foreign PR or ref.

## Skill Loading

Skills are loaded via OpenCode's native `skill` tool. Hive bundles are materialized into the global OpenCode config directory under `agent-hive/generated/opencode-skills/` and registered through `skills.paths`. On v1, the `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` env flag enables the primary-agent background-first scheduler contract and background management tools for sessions where OpenCode exposes native background subagents. On v2, native background support enables them without an env flag.

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
| Worklog | 3 | list, read, record |
| Status | 1 | status |
| Snapshot | 1 | git snapshot |

## Feature Resolution

Feature-scoped tools resolve in this order: explicit `feature` or `name`, selected session route (including null), detected feature worktree/path, then the sole live feature. The same effective route is captured for child dispatch. An explicit target wins only for that call and never changes the selected route. Explicit null suppresses detected-context and sole-live fallback. Without a resolved feature, a feature-required tool throws an error asking for `hive_feature_select` or an explicit feature. If no live feature exists, create one with `hive_feature_create`.

## Reserved Overview Convention

- There is no dedicated overview write tool.
- Use `hive_context_read({ feature: "feature-name", name: "overview" })` through all returned chunks first, then pass the current revision and `file.contentHash` to `hive_context_write`.
- Humans review `context/overview.md` first for purpose and design; `plan.md` stays authoritative for execution and task parsing, and the feature Worklog carries progress and history.
- Read the overview with `hive_context_read`; the VS Code extension also surfaces it for human review. `hive_status` returns feature and task summaries without overview content.
