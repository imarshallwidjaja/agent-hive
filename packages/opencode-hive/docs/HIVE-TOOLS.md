# Hive Tools Inventory

## Standard Hive Tools (29 total)

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

### Worktree (4 tools)
| Tool | Purpose |
|------|---------|
| `hive_worktree_start` | Create worktree and begin normal work |
| `hive_worktree_create` | Launch blocked-task continuation in existing worktree |
| `hive_worktree_commit` | Commit changes with an explicit structured `message`, write report (does NOT merge) |
| `hive_worktree_discard` | Discard changes, reset status |

#### hive_worktree_commit input notes

- `summary`: task/report summary.
- `message`: required whenever the worktree has changes to commit, including `completed`, `failed`, and `partial` handoffs.
- Every created commit message must contain a non-empty one-line subject, a blank line, and a non-empty descriptive body.
- `message` may be omitted only when the worktree has no changes to commit. There is no default or derived commit message.

#### hive_worktree_commit output

- Always returns JSON with control-flow fields:
  - `ok`: whether the operation succeeded
  - `terminal`: whether worker should stop (`true`) or continue (`false`)
  - `status`: completion status (`completed`, `blocked`, `failed`, `partial`) or error/rejected state
  - `taskState`: resulting persisted task state
  - `nextAction`: explicit next step for worker/orchestrator
- Non-terminal responses (for example `reason: "verification_required"`) require worker remediation and retry.

#### hive_worktree_start / hive_worktree_create output

- `workerPromptPath`: file path to `.hive/features/<feature>/tasks/<task>/worker-prompt.md`
- `workerPromptPreview`: short preview of the prompt
- `promptMeta`, `payloadMeta`, `budgetApplied`, `warnings`: size and budget observability
- In gate-open sessions, `hive_worktree_start` can also return a `backgroundTaskCall` for independent work that can run while useful foreground work continues. The pending background board entry is created only after the parent actually launches the native background `task({ background: true, ... })`; blocking `hive_worktree_start` remains the correct path when the next meaningful step depends on the worker result.
- Every native `task()` launch has one primary goal, one fresh subagent session, and one terminal handoff. A goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step. Give complete constraints and acceptance criteria only for that goal, and split independently verifiable outcomes into fresh launches.
- Do not pass `task_id` to `task()`. Returned task IDs are observe-only handles for background management and read-only direct-child inspection with `hive_task_trace`; they are not inputs for session continuation. Recovery context belongs in a NEW task without `task_id`. Do not send a follow-up prompt to a completed, failed, or blocked session. Subagents are terminal and cannot recurse, except a delegated `architect-planner` may launch one level of read-only planning helpers; those children cannot delegate.
- The `question` tool is reserved for primary sessions. Subagents return required operator clarification as an exact terminal-response question for their parent orchestrator.
- A blocked feature continuation starts a new worker session in the same worktree with the operator decision. Failed or retry work starts a new worker with a concise self-contained handoff. Compaction may re-anchor a currently running worker; it is not re-delegation.
- One implementation assignment normally maps to one numbered task. Amend the DAG or create an append-only manual task for a new independent deliverable.

### Ad-hoc Worktree (4 tools)

These tools are for isolated ad-hoc orchestration work. They operate on `.hive/.worktrees/adhoc/<runId>` and do not create feature/task records. Ad-hoc runs do not appear in `hive_status`.

| Tool | Purpose |
|------|---------|
| `hive_adhoc_worktree_create` | Create an isolated ad-hoc worktree; returns `runId`, `workspacePath`, and `branch` |
| `hive_adhoc_worktree_commit` | Commit changes in the ad-hoc worktree for a given `runId` |
| `hive_adhoc_merge` | Merge the ad-hoc branch into the current branch |
| `hive_adhoc_cleanup` | Remove the ad-hoc worktree and branch |

#### Ad-hoc worktree input/output notes

- For ad-hoc work, use multiple fresh one-goal launches with disjoint path ownership or sequence overlapping writers. Do not use a returned task ID to continue a prior session.
- `hive_adhoc_worktree_create` returns `runId`, `workspacePath`, and `branch`. It accepts optional `runId`, `label`, `baseBranch`, `repoIds`, and `autoSpawnWorker`; `repoIds` selects manifest-backed composite workspaces. On non-git project roots without a project repository manifest, it returns `reason: "repo_manifest_required"` before any git command.
- `autoSpawnWorker` defaults to `true`. With the background gate closed, create returns a blocking `taskToolCall`; launch it instead of working directly in the ad-hoc worktree. In background-enabled sessions, create returns both `taskToolCall` (blocking) and `backgroundTaskCall` (same prompt/description/subagent except `background: true`); register pending board state applies to the background launch path. Use blocking when the next step depends on the worker; use background only for independent lanes. Set `autoSpawnWorker` to `false` only for inspection, routing, or setup-only ad-hoc worktrees; the response sets `launchMode: "suppressed"` and omits launch payloads.
- `hive_adhoc_worktree_commit` requires `runId`, `workspacePath`, `branch`, and a structured `message`; `workspacePath` and `branch` must match the run returned by create.
- `hive_adhoc_merge` defaults to `squash`. Both `squash` and normal `merge` require an explicit polished aggregate `message` with the same subject, separator, and body structure.
- `rebase` is an explicit history-preservation exception, accepts no aggregate message, and validates the exact raw message of every source commit before mutation. Normal merge performs the same source validation.
- `hive_adhoc_merge` returns `commitMessage` when it creates a merge/squash commit.
- A failed non-preserved integration restores the affected target repository to its original HEAD and clean state. `preserveConflicts: true` retains only an actual conflict state.
- `hive_adhoc_cleanup` accepts `runId` and optional `deleteBranch`; merge and cleanup resolve `workspacePath` and `branch` from the run ID.

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
- Gate-open delegation uses lane kind to choose how much management is required. Exploratory/read-only and review lanes are lightweight background candidates. Writing/change and execution lanes require path ownership, explicit state tracking, verification routing, unresolved-lane checks before dependent decisions, and integration control.
- Every delegated lane needs a context packet: objective, known facts, relevant paths or references, constraints, prior failures, expected output, and where to find missing context. This matters most for non-feature and ad-hoc work because those workers may not have a plan or task context file.
- Primary orchestrators choose specialists from built-in and custom agent descriptors. Do not add fixed routing tables; use the descriptor that best matches the lane.
- Ad-hoc orchestration works in both gate-closed and gate-open sessions. Non-trivial non-feature work should be decomposed, routed, tracked, verified, and integrated like orchestration, using ad-hoc worktrees for implementation branches when needed.
- In gate-open sessions, launch native background tasks, inspect the scoped board with `hive_background_status`, wait for native completion notifications before dependent decisions, refresh `hive_background_status`, and reconcile terminal jobs with `hive_background_reconcile` or `hive_background_reconcile_batch`.
- `hive_background_status` and reconcile responses include `recommendedNextAction` guidance and may set `requiresHiveStatusRefresh` after reconciliation. Treat these as board-local scheduler hints. They do not predict task merge readiness; use `hive_status` for task/worktree-aware state before merge decisions.
- A `backgroundTaskCall` returned from `hive_worktree_start` is launch guidance, not board state. Until the parent actually launches the native background task, no pending background board entry exists.
- If `hive_background_status` returns `schedulerGuidance.reason: wait_for_native_completion_notification`, do not refresh repeatedly. Wait for OpenCode's native completion notification, continue unrelated foreground work, or cancel only if the lane is stale, wrong, or no longer needed.
- Prompt acknowledgment only means Hive showed the terminal result to the parent session. It does not clear `terminalUnreconciled`; the agent still needs explicit reconciliation after consuming or ignoring the result.
- Reconciled and ignored terminal jobs are archived by the background tools and hidden from normal status output. Do not edit `.hive/background-jobs.json` directly.
- Subagents must not start background tasks or manage the background board.
- Returned background task IDs are observe-only board handles for status, reconcile, and cancel. Never pass `task_id` to `task()` or treat it as an input for session continuation.
- Cancellation is not rollback. `hive_background_cancel` does not revert files, branches, worktrees, commits, or task reports; it only records a cancellation request and any confirmed runtime cancellation.
- If a background lane cannot be resumed safely, use no-resume retry/escalation: start a fresh scoped attempt when safe, ignore the stale terminal entry with a reason, or escalate the concrete blocker to the operator.

### Delegated Task Inspection (2 tools)

These primary-orchestrator-only tools inspect one native OpenCode child session. Authorization requires a fresh `session.get` proving that the supplied child session ID has the current tool session as its direct parent. Missing, sibling, grandchild, and mismatched sessions return the same unavailable response.

| Tool | Purpose |
|------|---------|
| `hive_task_trace` | Read one direct child once as a compact complete v2 situation report; optionally request terminal recovery |
| `hive_task_trace_content` | Re-read and verify one allowlisted non-reasoning source field referenced by a v2 content ID |

- Trace inspection never resumes, aborts, retries, polls, or mutates the delegated child.
- `hive_task_trace({ task_id, recovery?: boolean })` authorizes once, reads `session.messages` once, reads status once, and normalizes every surviving source step in API order. Compaction fidelity describes the compacted surviving source; it does not claim pre-compaction completeness.
- Omitted or false `recovery` preserves the deterministic compact forensic v2 shape: complete timeline, reasoning counts, tool dictionary/rollup, structured errors, patch files, open tools, and source-backed content locators. Its 24 KiB soft target is advisory, not a cap. Irreducible larger reports stay `ok: true`; `render.actual_bytes` is exact.
- Use `hive_task_trace({ task_id, recovery: true })` for a semantic handoff. It branches after the shared capture, normalization, and lifecycle decision and returns only lifecycle/source metadata, task instruction, the final response labelled `child_self_report`, recovery metadata, untrusted semantic phases/claims/action, deterministic structured errors, PatchPart file names, and exact render bytes. It excludes the forensic timeline/dictionaries/rollups/open tools, successful tool payloads, and raw reasoning. Long instruction/final/error values can carry a direct v2 `content_id` without a public dictionary.
- Semantic recovery requires usable status and a closed, idle, non-summary assistant tail with no pending/running tools. Empty, active, or uncertain traces return `status: 'unavailable'`, ordered eligibility failures, `semantic: null`, and make zero model calls.
- The mapper sends every captured step through UTF-8-safe requests of at most 20 KiB and requires exactly one semantic card per unique step. Split-step cards merge in fragment order. Any provider, schema, or cleanup failure falls back the whole affected step to an extractive card made only from assistant text, tool names/statuses, and structured errors; other batches continue once without retry. If no generated card survives, the reducer is skipped. Undeleted ephemeral sessions remain quarantined.
- The reducer consumes every ordered card plus deterministic error/file anchors. Generated phases must be 1-12 ordered, contiguous, non-overlapping ranges covering step 1 through N exactly; invalid output uses balanced deterministic fallback phases. Phase `basis` and `error_steps` are attached by the runtime. `source_steps` arrays are sorted context source coverage, not evidence or proof.
- Recovery `status` is `complete`, `partial`, or `unavailable`; ordered `failures` retain concurrent provider/schema/coverage and cleanup causes. `cards_source` and `phases_source` identify generated, mixed, or fallback material. Semantic output is always `untrusted: true`; generated output uses `provenance: 'summarizer_interpretation'` and may restate plaintext reasoning sent transiently to the hidden, parentless, tool-less model.
- The runtime, not the model, gates `safest_next_action`. Any partial/fallback result, deterministic error, compacted source, or invalid structure forces `inspect` with null context. Complete generated unfinished work permits only `launch_fresh_task` with nonempty self-contained context; complete work with no unfinished claims returns `review_completed_work`. Recovery never accepts, merges, retries, resumes, or auto-runs work.
- `hive_task_trace_content({ task_id, content_id, offset? })` reauthorizes the direct parent, re-reads messages once, permits only the v2 non-reasoning field allowlist, and verifies byte length plus digest before returning a UTF-8-safe chunk of at most 8 KiB with `next_offset`. Changed or deleted fields return `stale_or_not_found`. No copied trace/blob store is created.
- Configure optional recovery interpretation under global `taskTraceSummarizer` with `model`, `variant`, and `temperature` (0 through 2). Omitted model/variant use OpenCode defaults; temperature defaults to 0. An unavailable configured model/variant produces deterministic partial fallback without provider retry.
- Recovery context is input for a NEW task without `task_id`; fresh-session-only delegation remains mandatory.

### Merge (1 tool)
| Tool | Purpose |
|------|---------|
| `hive_merge` | Integrate a task branch; defaults to one squash commit with an explicit aggregate message |

#### hive_merge input notes

- `preserveConflicts?: boolean` defaults to `false`; when `true`, merge conflicts stay in place for an isolated helper session instead of being auto-aborted.
- `cleanup?: 'none' | 'worktree' | 'worktree+branch'` defaults to `'none'`; successful merges can keep the worktree, remove only the worktree, or remove the worktree and delete the task branch.
- `squash` is the default and creates one polished integration commit. `message` is required for both `squash` and normal `merge` and must contain a non-empty one-line subject, a blank line, and a non-empty descriptive body.
- Use `rebase` or normal `merge` only when preserving independently valuable source commits or branch topology is intentional. Hive validates every exact raw source commit message before mutation.
- Do not provide a non-blank `message` with `strategy: 'rebase'`.
- Failed integrations restore the target to its original HEAD and clean state unless an actual conflict is explicitly preserved.

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
  - `cleanup.worktreeRemoved`
  - `cleanup.branchDeleted`
  - `cleanup.pruned`
  - `error?`
- If the task branch has no net tracked changes to integrate, `hive_merge` returns `success: true`, `merged: false`, `reasonCode: 'NO_TRACKED_CHANGES'`, omits `sha`, and still performs requested cleanup when safe.
- `conflictState: 'preserved'` means the caller requested `preserveConflicts: true` and must resolve the merge locally before cleanup can finish.

### Context (1 tool)
| Tool | Purpose |
|------|---------|
| `hive_context_write` | Write context file, including reserved `context/overview.md` via `name: "overview"` |

### Status (1 tool)
| Tool | Purpose |
|------|---------|
| `hive_status` | Get comprehensive feature status as JSON, including overview metadata, per-document review counts, context inclusion flags, and task/worktree-aware merge eligibility |

#### hive_status output notes

- `helperStatus.mergeEligibility` is the canonical operator surface for whether completed task work has a live worktree and can be considered for merge or cleanup.
- Background board state is intentionally separate. Reconcile terminal background jobs first, then refresh `hive_status` before making dependent task or merge decisions.

## Private Review Workflow Tools (6 workflow-only tools)

`/dash-review` and `/vuln-review` use runtime-gated review tools. These tools are registered with the plugin but are not general-purpose operator or agent tools. Exact workflow identity, private-agent identity, pending-session state, ownership token, and lifecycle state provide runtime gates for each call.

| Tool | Purpose | Authorized caller |
|------|---------|-------------------|
| `hive_git_snapshot` | Preview one structured, atomic read-only Git snapshot set without raw Git commands or flags | A generated private scope lane |
| `hive_vulnerability_compare_report_read` | Consume the current vulnerability invocation's normalized prior-report capability; accepts neither a path nor a token and has no arguments | The bound vulnerability scope lane only |
| `hive_review_workspace_create` | Materialize one frozen disposable workspace from structured repository/ref/path scope and return its run ID, ownership token, paths, and fingerprints | The active workflow's generated private scope lane |
| `hive_review_workspace_claim` | Bind a created workspace to the active private primary session | The same workflow's private primary, with the returned token |
| `hive_review_workspace_inspect` | Compare the workspace with its materialized baseline and revalidate the live source identity | The owning private primary |
| `hive_review_workspace_cleanup` | Remove the disposable workspace and release its persisted run state | The owning private primary, or the vulnerability scope lane with exact failed-materialize cleanup authority |

### Review workspace lifecycle and gates

- Create accepts structured scope aliases only. It does not accept raw Git commands or arbitrary Git flags. Repository IDs, paths, refs, and optional Hive task/feature identity are validated before materialization.
- Vulnerability Stage 1 has separate resolve and materialize calls. Resolve can preview. Resolve cannot create. Only a fresh materialize call that exact-matches the stored `AcceptedCandidate` can consume the server's one-use create authority, and it must do so before capture. A second ambiguity, malformed packet, create drift, or cleanup uncertainty stops before claim.
- Vulnerability preview normalization excludes internal review state only for the private vulnerability preview. It adds no public `excludePaths` parameter and makes no `/dash-review` contract change. READY requires strict descriptor, source-fingerprint, and ordered repository-fingerprint equality for both single and composite scopes.
- The scope lane returns a READY ownership token to the private primary but cannot claim or inspect the run. It can clean only an exact create result reserved for failed materialization; it cannot clean an accepted workspace. Deep review lanes cannot call any lifecycle tool. The private primary can claim, inspect, and clean but cannot create the workspace.
- Claim must succeed before deep lanes start. Inspection runs after review and before cleanup. Cleanup is attempted even after lane, drift, or integrity failure.
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

## Removed Tools

| Tool | Reason |
|------|--------|
| `hive_subtask_*` (5 tools) | Subtask complexity not needed, use todowrite instead |
| `hive_session_*` (2 tools) | Replaced by `hive_status` |
| Custom Hive skill-loading tool | Replaced by OpenCode's native `skill` tool |
| `hive_context_read` | Agents can read files directly |
| `hive_agents_md` | Replaced by direct agent review of the full feature record plus normal documentation edits |
| `hive_context_list` | Agents can use glob/Read |

---

## Standard Tool Categories Summary

| Category | Count | Tools |
|----------|-------|-------|
| Feature | 2 | create, complete |
| Repository Manifest | 3 | status, discover, update |
| Plan | 4 | write, patch, read, approve |
| Task | 3 | sync, create, update |
| Worktree (task-backed) | 4 | start, create, commit, discard |
| Ad-hoc Worktree | 4 | create, commit, merge, cleanup |
| Background Orchestration | 4 | status, reconcile, batch reconcile, cancel |
| Delegated Task Inspection | 2 | trace, source-backed content |
| Merge | 1 | merge |
| Context | 1 | write |
| Status | 1 | status |
| **Total** | **29** | |

## Reserved Overview Convention

- There is no dedicated overview write tool.
- Use `hive_context_write({ feature: "feature-name", name: "overview", content })` to maintain `.hive/features/<feature>/context/overview.md` from a repository-root session until that session is bound.
- Humans review `context/overview.md` first; `plan.md` stays authoritative for execution and task parsing, and can still include a readable design summary before `## Tasks`.
- `hive_status` and the VS Code extension surface the overview as the primary human-facing document.
