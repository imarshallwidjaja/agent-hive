# Hive Design

## Core Concept

Context-Driven Development for AI coding assistants.

```
PROBLEM  -> CONTEXT  -> EXECUTION -> REPORT
(why)       (what)      (how)        (shape)
```

## Architecture

```
.hive/                    <- Shared data (all clients)
├── context/              <- Managed project knowledge (index.json and Markdown files)
├── repositories.json     <- Optional project repository manifest
├── sessions.json         <- Global session metadata, session constraints, and selected routes
├── features/             <- Feature-scoped work
│   └── 01_feature-name/
│       ├── feature.json  <- Feature metadata and state
│       ├── plan.md       <- Human-reviewed plan; numbered executable tasks live under ## Tasks
│       ├── context/      <- Managed feature knowledge (index.json and Markdown files)
│       ├── comments/plan.json <- Plan review threads (when present)
│       ├── comments/overview.json <- Overview review threads (when present)
│       ├── constraints.json <- Feature standing constraints (when present)
│       └── tasks/        <- Individual task folders
│           └── {task}/
│               ├── status.json      <- Task state and declared repo IDs
│               ├── spec.md          <- Task context and requirements
│               ├── report.md        <- Latest optional report
│               └── reports/         <- Numbered report history
├── .worktrees/           <- Isolated feature-task and ad-hoc Git worktrees
│   ├── {feature}/{task}/ <- Feature-task workspace
│   └── adhoc/{runId}/    <- Ad-hoc workspace
│       ├── workspace.json <- Composite placement metadata (composite only)
│       └── repos/{repoId}/ <- Per-repo worktrees (composite only)
├── background-jobs.json <- Observational background board
└── agent-hive.override.json <- Optional model/variant overrides for agents

packages/
├── hive-core/            <- Shared logic (services, types, utils)
├── opencode-hive/        <- OpenCode plugin (planning, execution, tracking)
└── vscode-hive/          <- VS Code extension (viewer-first plan/overview review, status, limited archive)
```

### Component responsibilities

- `hive-core` owns feature, plan, task, context, repository-manifest, session, constraint, background-board, and worktree services. `TaskService` parses tasks and persists status and reports; `WorktreeService` and `AdhocWorktreeService` inspect and integrate Git workspaces without assigning workers or updating task state.
- `opencode-hive/src/runtime.ts` registers the direct `hive_*` tools, builds agent and command configuration, captures route and constraint snapshots for native `task()` calls, and connects background observation. Bundled skills are discovered and materialized from packaged `SKILL.md` files.
- `vscode-hive` displays feature and task state, plans, comments, and scoped context; its plan comment controller writes review threads while its filesystem watcher triggers UI refresh.

### Execution ownership

Tool availability plus instructions govern action. Each tool validates its own operation. Task status and reports are the execution record. There is no attempt ledger. Old attempt and lease files are unread.

Parent applies the repository-backed placement policy. Tracked feature writes use matching task worktrees; non-Git or report-only work follows the direct-work exceptions. Git helpers do not change task status, auto-commit source, or assign workers. A legacy single-root worker returns `sourceCommit`; a composite worker returns the complete `sourceCommits` map keyed by persisted repository ID. The primary passes that topology-aware pin unchanged to merge. A singleton composite also accepts a matching scalar convenience; multiple repositories still require the complete map. The target index and tracked working tree must be clean. Disjoint untracked or ignored destination files may remain when the pinned source contains the pinned target history; rebase also requires a linear replay range. Unsafe topology with local data returns `TARGET_RECONCILIATION_REQUIRED` with `reconcile_target` and requires same-worktree reconciliation with fresh pins. Ignored Hive state, dependencies, and build output count as local data even when Git reports a clean worktree. Incoming path collisions always block. Hive preflight and rechecks protect local data without relying on Git merge flags. Locks are operation-local. Dirty, untracked, ignored, and unmerged data is protected; there is no force or rm fallback. Same-call squash cleanup may use observed identity; later ambiguous branches stay unless discard is explicit. Composite partial outcomes are not rolled back.

Worktree inspect captures the canonical destination path, full symbolic ref or detached state, commit OID, and local ancestry comparison against each source. The primary owns that intended destination identity in handoffs and task reports. Merge requires the unchanged inspected identity and checks it under the existing repository locks before mutation, at each composite integration boundary, after squash staging before commit, and before cleanup. These locks coordinate Hive operations only; arbitrary Git writers and other lock namespaces still require exclusive destination ownership. Ancestry checks do not fetch and do not prove semantic completeness.

When relevant or uncertain destination drift appears, reconciliation stays in the same registered worktree after the previous writer is terminal. A fresh worker verifies clean source state and the source pin, merges the pinned target commit without rewriting history, resolves and adapts the combined result, reviews both prior work and refreshed delta, and returns fresh source pins plus the target identity used. Replacement worktrees are reserved for invalid identity/topology, untrustworthy history, or an explicit rewrite decision. Composite reconciliation and merge expose partial retention instead of claiming atomicity.

The background board is observational bookkeeping of the originating native parent and call. Stale and unknown observations stay visible. It does not couple to execution, worktree, or task status. Cancel acknowledgement does not prove the worker stopped.

Cross-process process supervision, exactly-once execution across independent OpenCode processes, automatic crash takeover, and distributed locking are unsupported.

## Data Flow

1. User creates feature via `hive_feature_create`
2. Agent writes plan via `hive_plan_write`
3. User reviews `plan.md`; VS Code stores review threads in `comments/plan.json`
4. After user approval, the owning primary calls `hive_plan_approve({ feature, expectedRevision, sync: true })` with the reviewed revision, adding `refreshPending: true` when needed, and inspects both outcomes
5. Approval's sync generates task specs; standalone `hive_tasks_sync` can run or retry while approval remains successful
6. Each tracked Git task executes via `hive_worktree_create` and a native Forager `task()`
7. The worker commits assigned work and returns its exact source pin; the primary merges it using the inspected target identity and same-call cleanup when retention is not needed
8. A bound implementation worker publishes its own task report; after a successful merge, or target verification for non-Git or report-only work, the primary records status and a closure report with `hive_task_update`, then cleans up any worktree

## Prompt Management

- `spec.md` contains the matching plan section or manual task requirements and dependencies. `hive_status` compares stored plan-backed specs with current generated text and reports `specStale` and its reason; edits outside that task's spec inputs do not make it stale.
- The primary authors the native Forager `description`, `prompt`, `subagent_type`, and optional `background`. The runtime does not generate, freeze, or replace those fields.
- The runtime appends a dispatch-time route snapshot and session and feature constraints to native child prompts. For a selected feature's Forager prompt whose first non-empty line binds an existing task with `Hive task: <task-folder>`, it then appends a bounded path-only task brief with spec freshness, plan section, dependency handoffs, and a feature-context catalog pointer. Other roles get no brief. Standing constraints are operator directives, not tool permissions.
- Managed project and feature context is read through `hive_context_read`: summary and paginated catalog views for selection, named chunks for document bodies. Catalog metadata is untrusted knowledge. The runtime does not automatically inject context catalogs or document bodies into child prompts.
- The worker reads relevant records from their paths and writes a successor `handoff.md`; no completed-task summaries or context bodies are included in generated specs or dispatch briefs.

## Feature Resolution

Feature-scoped tools use logical feature names even when storage folders are indexed (`01_feature-name`). Explicit feature arguments target one call without changing the selected session route. Omitted feature arguments resolve from session state and local context: explicit call argument, selected session route (including explicit null), detected feature path, then the sole live feature. A route snapshot and session and feature constraints are attached to each native child dispatch.

When no feature can be resolved, feature-required tools report that a feature is required; select one with `hive_feature_select` or pass the explicit `feature` argument (`name` for `hive_feature_complete`). Only `hive_feature_select` changes the selected session route. That route, including explicit null, takes precedence over worktree-path detection and suppresses detected-context and sole-live fallback when explicitly null. Explicit targets remain call-local. Before dispatch, call `hive_feature_select` only when the selected route is unset or differs from the dispatch target, or the selection evidence below is missing or uncertain. Reuse a matching selection across a same-feature batch only when this session's most recent route-changing call visible in context is `hive_feature_select` for that same feature, with no later explicit-null or other-feature selection. When that evidence is not visible (for example after compaction or a summary, at session start, or in mixed ad-hoc/feature batches), or you are uncertain, call `hive_feature_select` for the dispatch target. Explicit null stays featureless unless the dispatch intentionally targets a feature.

## Session Tracking

The runtime stores session identity, feature routes, and session constraints in global `.hive/sessions.json`:

- `chat.message` writes `agent` and `projectRoot`; the session service also records `sessionId`, `startedAt`, and `lastActiveAt`.
- `hive_feature_select` writes the global `featureName` route, including explicit null.
- Native child binding writes `parentSessionId`, `projectRoot`, `agent` when provided, `featureName` when selected, and `standingConstraints`, `standingConstraintEntries`, and `standingConstraintsRevision` from the captured session constraints. Constraint tools also update the session constraint register.

`SessionService.bindFeature` can write a feature-local `sessions.json` projection, but no current runtime path calls it. The global file governs route selection and child dispatch.

`classifySession` recognizes `primary`, `subagent`, `task-worker`, and `unknown`, but the runtime calls `createVariantHook` without a session service. It does not persist `sessionKind` or `baseAgent`. No production runtime path writes `taskFolder` or `adHocRunId` to session metadata.

Tool availability plus instructions govern action. Each tool validates its own operation. There is no attempt ledger.

### Session inspection and follow-ups

`hive_task_trace` inspects a runtime-visible OpenCode session, including one with compacted surviving messages. Its optional semantic recovery projection is untrusted context coverage, not authority to accept, merge, retry, or resume work. A returned native `task()` call is terminal; subsequent assignments use fresh child sessions unless the operator or explicit runtime-owned interruption recovery authorizes continuation. Child dispatch captures the current feature route and standing constraints.

Primaries perform single direct reads themselves: one `hive_status`, one worktree inspect, or one `hive_task_trace_content` spot-check of a known event ref. For multi-step forensics (paging a trace, drift comparison, or interrupted-worker evidence packets), route one named question with known identities to the read-only `hive-helper`. It returns cited observations, hypotheses, limits, and observed HEADs, never verified pins or lifecycle decisions. The primary spot-checks decisive event refs before deciding acceptance, termination, retry, integration, or cleanup. A task-spawned Architect may call Helper for trace/evidence questions within its blocking terminal helper layer and returns board/control requests to its parent.

## Todo Alignment

OpenCode todo behavior remains intentionally simple in this design:

- OpenCode todo state is session-scoped.
- OpenCode todo writes replace the session's todo list rather than patching individual items.
- Hive does not create a derived projected-todo field or another projected todo contract.
- Subagents and task workers should not be modeled as first-class todo writers.

The source of truth for task state remains `.hive`; OpenCode todos are session-level UI state.

## Task Lifecycle

```
pending -> in_progress -> done
                      \-> blocked -> (fresh worker) -> done
                      \-> failed
                      \-> partial
                      \-> cancelled
```

### Status Vocabulary (TaskStatusType)

| Status | Description |
|--------|-------------|
| `pending` | Not started |
| `in_progress` | Currently being worked on |
| `done` | Completed successfully |
| `blocked` | Waiting for user decision (blocker protocol) |
| `failed` | Execution failed (errors, tests not passing) |
| `partial` | Partially completed (some work done, not finished) |
| `cancelled` | Cancelled by user |

### spec.md (generated by TaskService)
Contains task context for the executing agent:
- Task number, name, feature, folder
- Full description from plan
- Dependencies and the matching plan section, without completed-task summaries
- Structured manual-task requirements when the task was created directly

`TaskService.sync` creates or refreshes plan-backed task folders and their `status.json` and `spec.md` files. `TaskService.create` owns the same files for append-only manual tasks. Worktree helpers and native Forager calls read these records; they do not generate `spec.md`.

### Reports
`hive_task_update` stores an optional report string as numbered history plus `report.md`. Omissions are preserved. An explicit status leaving blocked clears the blocker. Report authorship, primary closure, and partial-write recovery are described in [Tasks and reports](OPERATOR-GUIDE.md#tasks-and-reports).

An optional nonblank `handoff` of at most 2048 UTF-8 bytes replaces the task's `handoff.md` without changing status. A later remediation can replace it; omitted handoffs remain intact. The primary promotes accepted forward obligations into a named successor's plan section before that task runs.

Blocked task status preserves blocker JSON in `status.json`. `hive_status` returns task summaries and dependency-blocked entries; inspect the persisted task record for the operator-decision blocker. After the decision, `hive_task_update` with an explicit status leaving blocked clears it. Put the decision in the next worker prompt.

## Execution Placement

Worktree placement executes a tracked Git task in an isolated workspace under `.hive/.worktrees/{feature}/{task}/`. In legacy mode that path is a single Git worktree. In manifest-backed mode it is a composite workspace, with one Git worktree per declared repo under `repos/<repoId>/`. Non-Git or report-only work may use an explicit existing target and provides no filesystem isolation.

Agents edit the selected workspace and commit assigned changes in a worktree implementation lane. `hive_worktree_merge` integrates the worker's exact scalar or complete composite pin before the task is marked done. Non-Git or report-only work records task status only and has no Hive Git step. `hive_worktree_cleanup` removes a worktree. Git helpers do not change task status, auto-commit source, or assign workers. Unmerged branch delete requires explicit `discard: true`.

### Multi-Repo Composite Workspaces

When `.hive/repositories.json` defines project repositories, every task with tracked writes MUST declare a `Repos:` annotation before task sync or worktree creation. Such tasks use composite workspaces, and each declared repo gets its own git worktree under the composite root.

**Project-local manifest shape:**

```json
{
  "schemaVersion": 1,
  "repositories": [
    { "id": "api", "path": "./packages/api" },
    { "id": "web", "path": "./packages/web-ui" }
  ]
}
```

**Repository ID grammar:**
- Must match `^[a-z0-9][a-z0-9._-]*$`
- Must not be `.`, `..`, contain `..`, `/`, `\\`, whitespace, uppercase, or Unicode
- Must not end in `.lock`
- Must pass `git check-ref-format --branch hive/<repoId>/<feature>/<task>`

**Manifest source rule:**
- Repository manifests are read from `<canonical-project-root>/.hive/repositories.json`
- Repository paths are relative to the project root and must stay inside it
- Matching legacy `repositoryRoot`/`repositories` global data is migration-only and is copied on explicit update, never during status or startup
- A non-git project root without a matching manifest fails worktree create and merge with a manifest-required error. Non-Git or report-only work still requires an explicit existing directory and never invents Git semantics.

**Manifest management tools:**
- `hive_repositories_status` reports whether the project is using a manifest, legacy single-root mode, or is missing a required manifest
- `hive_repositories_discover` scans only inside the OpenCode project root for candidate git repositories; it is read-only, bounded to depth 4, capped at 50 candidates, and skips `.git`, `.hive`, `.opencode`, `node_modules`, build outputs, coverage, and temp folders
- `hive_repositories_update` is add-only and atomic: it accepts project-relative paths, validates the merged topology, writes `.hive/repositories.json`, and then conditionally removes matching legacy global topology while preserving global preferences
- Agents add only repositories they have decided to work in; discovery does not bulk-register every candidate repo

**Composite workspace layout:**

```
.hive/.worktrees/{feature}/{task}/   <- composite root (WorktreeInfo.path)
├── workspace.json                   <- repo IDs, paths, branches, base commits
└── repos/
    └── {repoId}/                    <- per-repo git worktree
```

**Path semantics:**
- Legacy (no manifest): `WorktreeInfo.path` is the single git worktree; `workspacePath` is absent or equal to `path`
- Composite: `WorktreeInfo.path` is the composite workspace root; `workspacePath === path`; per-repo git worktree paths live under `repos[repoId].path`
- OpenCode/VS Code expose `worktreePath` from `WorktreeInfo.path`; workers start from the composite root and use the repo map for git operations

**Task Repos annotation:**
- Plan tasks with tracked writes on manifest-backed projects MUST declare `**Repos**: api` or `**Repos**: api, web` before task sync or worktree creation
- For a plan-backed task with missing or incorrect metadata, amend the plan and have the primary approve/sync the reviewed revision with `refreshPending: true` before worktree creation
- For an incorrectly scoped manual task, automatically replace and cancel it only when no work has started and no existing task depends on it; the replacement mirrors incoming `dependsOn` and supplies corrected `repos` via `hive_task_create(...)`. If work started or reverse dependents exist, retain the incorrect task as blocked with a structured blocker and escalate; do not rewrite dependencies
- Missing, empty, or unknown repo IDs fail before worktree creation
- Legacy single-root tasks omit `Repos:` and keep implicit root behavior

### Source Commit Contract

Workers commit their assigned changes in each selected repository and return the exact commit pin: `sourceCommit` in legacy single-root mode or a complete `sourceCommits` map in composite mode. Hive Git helpers do not create worker commits. Integration validates the pins against the inspected source; a singleton composite accepts the matching scalar pin.

### Aggregate Merge Contract

Composite merges preflight all repos before mutating any. Preflight failure returns `success: false`, `partial: false`, and names the failing repo. Mutation failure after earlier repo success returns `success: false`, `partial: true`, stops immediately, and does not roll back.

Top-level `filesChanged` and `conflicts` flatten per-repo paths as `repoId:path` in stable repo order. Rebase with custom `message` is rejected before any mutation.

## Key Principles

- **Session-scoped selection** — Feature tools resolve explicit target, selected route, detected path, then sole live feature
- **Dispatch snapshots** — Native child calls capture the effective feature route and session and feature constraints
- **Placement-specific execution** — Tracked Git tasks use isolated workspaces; non-Git or report-only work is cooperative and has no Hive rollback, merge, or cleanup
- **Durable records** — Plans, task states, report history, context, and workspace metadata live under `.hive/`; ad-hoc runs have no task report record
- **Agent-friendly** — Minimal overhead during execution

## Source of Truth Rules

Hive uses file-based state with clear ownership boundaries:

| File | Owner | Other Access |
|------|-------|--------------| 
| `feature.json` | Feature/plan tools, including delegated Architect's feature creation | VS Code (read-only) |
| `status.json` (task) | `TaskService` sync/create and `hive_task_update` | Worker (read), VS Code watcher (read-only) |
| `plan.md` | Architect through plan tools, as primary or planning child | VS Code (read + comment, execution source of truth) |
| `comments/plan.json` | VS Code writes threads; `PlanService` clears them on plan write or patch | Primary agent (read-only) |
| `spec.md` | `TaskService.sync` / `TaskService.create` | Worker (read-only) |
| `report.md` / `reports/*.md` | `hive_task_update` | All (read-only) |
| `sessions.json` (global) | `SessionService` | Runtime route and constraint reads |
| `context/index.json` and managed Markdown | `ContextService` via `hive_context_*` | Agent roles according to tool permissions |
| `repositories.json` | `RepositoryManifestService` | Worktree services (read) |

### VS Code watcher

The VS Code `HiveWatcher` watches `.hive/**/*` and calls the sidebar refresh callback on create, change, and delete events, excluding `.lock` files. Review comments are written by the plan comment controller, not by the watcher.

## Field Ownership

Task `status.json` fields and who writes them:

| Field | Written By | When |
|-------|-----------|------|
| `status` | `TaskService` on plan sync or manual task creation; primary via `hive_task_update` | Initially `pending`, then on recorded disposition |
| `origin` | `hive_tasks_sync` | On task creation |
| `planTitle` | `hive_tasks_sync` | On task creation |
| `summary` | Primary via `hive_task_update` | On recorded disposition |
| `repoIds` | `hive_tasks_sync` / `hive_task_create` | On plan sync or manual task creation |
| `blocker` | Primary via `hive_task_update` | When blocked status is recorded |
| `dependsOn` | `hive_tasks_sync` / `hive_task_create` | On plan sync for created or refreshed pending plan tasks, or on manual task creation; other records keep their stored value |
| `metadata` | `hive_task_create` | On structured manual task creation |

Reports are separate files: `report.md` holds the latest report and `reports/<number>.md` preserves each update. A report write precedes the status write; if an update fails partway through, inspect the returned persistence stage and on-disk files before retrying.

### Reused worktree integrity

Containment inside a Git common directory does not prove that a selected HEAD and index belong to the requested worktree. Before any Git command runs in a reused task worktree, Hive resolves the common directory with Git only from each currently trusted topology-resolved repository. A trusted linked manifest repository may have a common directory outside the canonical project root.

Hive reads the suspect worktree's local `.git` pointer as bytes, resolves its syntax without dereferencing the target, and requires identity-bound containment with no symlink components before reading the selected administration metadata. The selected entry's `commondir` must resolve to the trusted common directory, and its normalized `gitdir` backlink must equal the current worktree's own `.git` path. Repository and persisted workspace topology must also match. A sibling or old entry is rejected before suspect-worktree Git or access through its mismatched backlink. Rejection does not rewrite `.git`, repair or delete the worktree, migrate roots, or modify historical execution state; the operator prepares a valid workspace before a fresh launch.

## Idempotency Expectations

### Idempotent Operations

These operations are safe to retry:
- `hive_plan_read` - Pure read
- `hive_status` - Pure read

### Non-Idempotent Operations

These operations have side effects:
- `hive_feature_create` - Creates feature directory (errors if exists)
- `hive_plan_write` - Overwrites plan.md, clears comments
- `hive_tasks_sync` - Reconciles plan-backed tasks; `refreshPending: true` rewrites pending plan tasks from `plan.md`, updates `planTitle` / `dependsOn`, regenerates `spec.md`, and removes pending plan tasks deleted from the plan while preserving manual tasks, cancelled tasks, and execution history. It derives all actions first and writes nothing when the resulting unfinished-task graph is invalid; it is not transactional after validation passes
- `hive_task_create` - Creates a manual task with explicit `dependsOn` and optional structured metadata, after the same unfinished-task graph check
- `hive_task_update` - Optional status/summary/blocker/report/handoff; omissions preserved; inspect written files before retry and never resubmit a report already in history
- `hive_worktree_create` - Creates or selects a task Git workspace
- `hive_worktree_merge` - Merges a task branch
- `hive_worktree_cleanup` - Removes a worktree
- `hive_adhoc_worktree_create` / `hive_adhoc_worktree_merge` / `hive_adhoc_worktree_cleanup` - Manage tracked ad-hoc Git work without task records

### Manual task model

Manual tasks are first-class task records, not loose notes.

- Manual tasks always persist an explicit `dependsOn` array. Omitting it means `[]`, not "infer the previous task". A stored record without the field also reads as `[]`.
- Dependencies of unfinished tasks (`pending`, `in_progress`, `blocked`, `failed`, `partial`) are active constraints: sync and manual creation reject missing targets, self-references, and cycles among them. Dependencies of `done` and `cancelled` tasks are history and are not revalidated. Cancelled tasks are retained and never satisfy a prerequisite. [Hive Tools](../packages/opencode-hive/docs/HIVE-TOOLS.md#task-dependency-graph) lists the repair routes.
- Structured manual-task `metadata` can carry `goal`, `description`, `acceptanceCriteria`, `references`, `files`, `reason`, and `source` so Hive can generate a worker-ready `spec.md`.
- Review-sourced manual tasks are for primary-created isolated follow-up only. If feedback changes sequencing, dependencies, or scope, delegate the plan amendment to Architect, then have the primary approve/sync the reviewed revision with `refreshPending: true` so pending plan tasks match the amended DAG.

### Recovery Patterns

If a tool call fails mid-operation:
1. Inspect the operation result, task state, and registered worktree before retrying.
2. For partial `hive_task_update` writes, inspect report history, latest report, handoff, and status separately, and do not resubmit a report already in history; there is no journal.
3. A composite merge may retain earlier repository integrations if a later one fails. Inspect per-repository results before deciding the next action.
