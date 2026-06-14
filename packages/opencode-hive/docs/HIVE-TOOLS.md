# Hive Tools Inventory

## Tools (26 total)

### Feature Management (2 tools)
| Tool | Purpose |
|------|---------|
| `hive_feature_create` | Create new feature, set as active |
| `hive_feature_complete` | Mark feature completed (irreversible) |

### Repository Manifest (3 tools)
| Tool | Purpose |
|------|---------|
| `hive_repositories_status` | Inspect project repository mode and current project-scoped repository manifest |
| `hive_repositories_discover` | Discover in-workspace git repositories without mutating the manifest |
| `hive_repositories_update` | Add project-relative repositories to `.hive/agent-hive.json` atomically while preserving existing config fields |

#### Repository manifest notes

- Agents should add only repositories they have decided to work in; discovery is not bulk registration.
- Discovery is bounded to the project root, depth 4, and 50 candidates, and skips `.git`, `.hive`, `.opencode`, `node_modules`, build outputs, coverage, and temp folders.
- Updates are add-only and accept project-relative paths only. If any requested repo is invalid, the manifest is not written.

### Plan Management (3 tools)
| Tool | Purpose |
|------|---------|
| `hive_plan_write` | Write plan.md (execution truth; clears plan review comments) |
| `hive_plan_read` | Read plan.md and related review comments so approval can account for overview + plan feedback |
| `hive_plan_approve` | Approve plan for execution |

### Task Management (3 tools)
| Tool | Purpose |
|------|---------|
| `hive_tasks_sync` | Generate tasks from approved plan, or refresh pending plan-backed tasks with `refreshPending: true` after a plan amendment |
| `hive_task_create` | Create manual task (not from plan) with explicit `dependsOn` and optional structured metadata |
| `hive_task_update` | Update task status or summary |

#### Task model notes

- Plan-backed tasks get their DAG from `plan.md` `Depends on:` annotations during `hive_tasks_sync`.
- Modern plans sync numbered task headings only from the `## Tasks` section. A pure final verification checklist belongs in `## Final Verification` outside the task graph unless it writes tracked artifacts or otherwise needs worker execution.
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
| `hive_worktree_create` | Resume blocked task in existing worktree |
| `hive_worktree_commit` | Commit changes, write report (does NOT merge), optional `message` controls git commit text |
| `hive_worktree_discard` | Discard changes, reset status |

#### hive_worktree_commit input notes

- `summary`: task/report summary.
- `message` (optional): git commit message text.
- Multi-line `message` is allowed when creating a commit.
- Omit `message` (or pass `''`) to use default commit message behavior.

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

### Ad-hoc Worktree (4 tools)

These tools are for isolated executor work (Hive Builder). They operate on `.hive/.worktrees/adhoc/<runId>` and do not create feature/task records. Ad-hoc runs do not appear in `hive_status`.

| Tool | Purpose |
|------|---------|
| `hive_adhoc_worktree_create` | Create an isolated ad-hoc worktree; returns `runId`, `workspacePath`, and `branch` |
| `hive_adhoc_worktree_commit` | Commit changes in the ad-hoc worktree for a given `runId` |
| `hive_adhoc_merge` | Merge the ad-hoc branch into the current branch |
| `hive_adhoc_cleanup` | Remove the ad-hoc worktree and branch |

#### Ad-hoc worktree input/output notes

- `hive_adhoc_worktree_create` returns `runId`, `workspacePath`, and `branch`. It accepts optional `runId`, `label`, `baseBranch`, `repoIds`, and `autoSpawnWorker`; `repoIds` selects manifest-backed composite workspaces. On non-git project roots without a project repository manifest, it returns `reason: "repo_manifest_required"` before any git command.
- `autoSpawnWorker` defaults to `true`. In background-enabled sessions, set it to `false` only for inspection, routing, or setup-only ad-hoc worktrees where no worker should be launched; the response suppresses `backgroundTaskCall` and marks the worker launch as suppressed.
- `hive_adhoc_worktree_commit` requires `runId`, `workspacePath`, `branch`, and `message`; `workspacePath` and `branch` must match the run returned by create.
- `hive_adhoc_merge` accepts `runId`, optional `strategy` (`merge`, `squash`, `rebase`), optional `message`, optional `preserveConflicts`, and optional `cleanup` (`none`, `worktree`, `worktree+branch`).
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

- With the env gate unset, the background management tools return `background_tools_disabled`. Primary agents keep the direct/blocking task and worktree workflow, and no background appendix is injected.
- With the env gate set, primary orchestrators receive delegate-first background scheduling guidance and the board tools are active. This is experimental-gate behavior, not the default contract.
- Gate-open delegation uses lane kind to choose how much management is required. Exploratory/read-only and review lanes are lightweight background candidates. Writing/change and execution lanes require path ownership, explicit state tracking, verification routing, unresolved-lane checks before dependent decisions, and integration control.
- Every delegated lane needs a context packet: objective, known facts, relevant paths or references, constraints, prior failures, expected output, and where to find missing context. This matters most for non-feature and ad-hoc Hive Builder work because those workers may not have a plan or task context file.
- Primary orchestrators choose specialists from built-in and custom agent descriptors. Do not add fixed routing tables; use the descriptor that best matches the lane.
- Hive Builder remains a valid ad-hoc executor with the gate closed. With the gate open, non-trivial non-feature work should be decomposed, routed, tracked, verified, and integrated like orchestration, using ad-hoc worktrees for implementation branches when needed.
- In gate-open sessions, launch native background tasks, inspect the scoped board with `hive_background_status`, wait for native completion notifications before dependent decisions, refresh `hive_background_status`, and reconcile terminal jobs with `hive_background_reconcile` or `hive_background_reconcile_batch`.
- `hive_background_status` and reconcile responses include `recommendedNextAction` guidance and may set `requiresHiveStatusRefresh` after reconciliation. Treat these as board-local scheduler hints. They do not predict task merge readiness; use `hive_status` for task/worktree-aware state before merge decisions.
- A `backgroundTaskCall` returned from `hive_worktree_start` is launch guidance, not board state. Until the parent actually launches the native background task, no pending background board entry exists.
- If `hive_background_status` returns `schedulerGuidance.reason: wait_for_native_completion_notification`, do not refresh repeatedly. Wait for OpenCode's native completion notification, continue unrelated foreground work, or cancel only if the lane is stale, wrong, or no longer needed.
- Prompt acknowledgment only means Hive showed the terminal result to the parent session. It does not clear `terminalUnreconciled`; the agent still needs explicit reconciliation after consuming or ignoring the result.
- Reconciled and ignored terminal jobs are archived by the background tools and hidden from normal status output. Do not edit `.hive/background-jobs.json` directly.
- Subagents must not start background tasks or manage the background board.
- Cancellation is not rollback. `hive_background_cancel` does not revert files, branches, worktrees, commits, or task reports; it only records a cancellation request and any confirmed runtime cancellation.
- If a background lane cannot be resumed safely, use no-resume retry/escalation: start a fresh scoped attempt when safe, ignore the stale terminal entry with a reason, or escalate the concrete blocker to the operator.

### Merge (1 tool)
| Tool | Purpose |
|------|---------|
| `hive_merge` | Merge task branch (strategies: merge/squash/rebase); optional helper-friendly conflict preservation, cleanup, and `message` for merge/squash |

#### hive_merge input notes

- `preserveConflicts?: boolean` defaults to `false`; when `true`, merge conflicts stay in place for an isolated helper session instead of being auto-aborted.
- `cleanup?: 'none' | 'worktree' | 'worktree+branch'` defaults to `'none'`; successful merges can keep the worktree, remove only the worktree, or remove the worktree and delete the task branch.
- `message` is optional and applies to `merge`/`squash` strategies.
- Do not provide `message` with `strategy: 'rebase'`.
- Omit `message` (or pass `''`) to use default merge/squash message behavior.

#### hive_merge output

- Returns JSON with the shared merge result envelope plus a concise `message` string.
- Shared result fields:
  - `success`
  - `merged`
  - `strategy`
  - `sha?`
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

### Skill Loading
Skills are loaded via OpenCode's native `skill` tool. Hive bundles are materialized into `.hive/generated/opencode-skills/` and registered through `skills.paths`. No Hive plugin tool is used for skill loading. The `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` env flag enables the primary-agent background-first scheduler contract and background management tools for sessions where OpenCode exposes native background subagents.

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

## Tool Categories Summary

| Category | Count | Tools |
|----------|-------|-------|
| Feature | 2 | create, complete |
| Repository Manifest | 3 | status, discover, update |
| Plan | 3 | write, read, approve |
| Task | 3 | sync, create, update |
| Worktree (task-backed) | 4 | start, create, commit, discard |
| Ad-hoc Worktree | 4 | create, commit, merge, cleanup |
| Background Orchestration | 4 | status, reconcile, batch reconcile, cancel |
| Merge | 1 | merge |
| Context | 1 | write |
| Status | 1 | status |
| **Total** | **26** | |

## Reserved Overview Convention

- There is no dedicated overview write tool.
- Use `hive_context_write({ name: "overview", content })` to maintain `.hive/features/<feature>/context/overview.md`.
- Humans review `context/overview.md` first; `plan.md` stays authoritative for execution and task parsing, and can still include a readable design summary before `## Tasks`.
- `hive_status` and the VS Code extension surface the overview as the primary human-facing document.
