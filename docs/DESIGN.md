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
├── features/             <- Feature-scoped work
│   └── 01_feature-name/
│       ├── feature.json  <- Feature metadata and state
│       ├── plan.md       <- Single required human-review and execution document (keep a readable design summary before ## Tasks)
│       ├── context/      <- Optional persistent knowledge files (all free-form support notes)
│       └── tasks/        <- Individual task folders
│           └── {task}/
│               ├── status.json      <- Task state (repoIds, baseCommits for manifest-backed tasks)
│               ├── spec.md          <- Task context and requirements
│               └── report.md        <- Execution summary and results
├── .worktrees/           <- Isolated git worktrees per task
│   └── {feature}/{task}/ <- Composite root (manifest-backed) or single git worktree (legacy)
│       ├── workspace.json  <- Repo manifest, branches, base commits (composite only)
│       └── repos/          <- Per-repo git worktrees (composite only)
│           └── {repoId}/
└── ...                   <- Runtime state only; Agent Hive config is global

packages/
├── hive-core/            <- Shared logic (services, types, utils)
├── opencode-hive/        <- OpenCode plugin (planning, execution, tracking)
└── vscode-hive/          <- VS Code extension (viewer-first plan/overview review, status, limited archive)
```

### Execution ownership

Tool availability plus instructions govern action. Each tool validates its own operation. Task status and reports are the execution record. There is no attempt ledger. Old attempt and lease files are unread.

Parent chooses direct work, delegation, or a worktree from the situation. Feature work is location-neutral. Git helpers do not change task status, auto-commit source, or assign workers. Merge wants a clean source and dest pinned SHA. Locks are operation-local. Dirty, untracked, ignored, and unmerged data is protected; there is no force or rm fallback. Same-call squash cleanup may use observed identity; later ambiguous branches stay unless discard is explicit. Composite partial outcomes are not rolled back.

The background board is observational bookkeeping of the originating native parent and call. Stale and unknown observations stay visible. It does not couple to execution, worktree, or task status. Cancel acknowledgement does not prove the worker stopped.

Cross-process process supervision, exactly-once execution across independent OpenCode processes, automatic crash takeover, and distributed locking are unsupported.

## Data Flow

1. User creates feature via `hive_feature_create`
2. Agent writes plan via `hive_plan_write`
3. User reviews `plan.md` and adds comments there
4. User approves via `hive_plan_approve`
5. Tasks synced via `hive_tasks_sync` (generates spec.md for each)
6. Each task executes via an optional `hive_worktree_create` and a native Forager `task()`
7. The primary records status and reports with `hive_task_update`
8. A worktree can be integrated with `hive_worktree_merge`; in-place or report-only work has no Hive merge step

## Prompt Management

- `spec.md` contains the fixed task contract: the matching plan section, manual task requirements, dependencies, and bounded completed-task summaries. Supporting context bodies are not copied into it.
- The primary authors the native Forager `description`, `prompt`, `subagent_type`, and optional `background`. The runtime does not generate, freeze, or replace those fields.
- The runtime appends concise project, feature, and session constraints without replacing caller prompt bytes. Standing constraints are operator directives, not tool permissions.
- Live project and feature catalogs are delivered separately as untrusted metadata under one 8 KiB automatic budget. Catalog continuations and current storage errors remain explicit; supporting document bodies require `hive_context_read`.
- Catalog refresh removes only the plugin-owned synthetic user message with matching session, message, and part identities. Marker-prefixed user or assistant text is preserved.
- Completed-task history retains the 10-task and 2000-character summary budgets. Supporting-context prompt budgets were removed with eager body injection.

## Feature Resolution

Feature-scoped tools use logical feature names even when storage folders are indexed (`01_feature-name`). Omitted feature arguments resolve from local context without project-global selection state:

```typescript
function resolveFeature(explicit?: string, sessionId?: string): string | null {
  if (explicit) return explicit

  const detected = detectContext(cwd)
  if (detected.feature) return detected.feature

  const bound = sessionId ? findFeatureBySession(sessionId) : null
  if (bound) return bound

  const liveFeatures = listLiveFeatures()
  return liveFeatures.length === 1 ? liveFeatures[0] : null
}
```

When multiple live features remain, the tool returns their logical names and makes no mutation. Retry with the explicit `feature` argument, or the explicit `name` argument for `hive_feature_complete`. When no live feature exists, the response tells the agent to create one with `hive_feature_create`.

This keeps task-worktree and session ownership authoritative, supports parallel feature sessions, and prevents alphabetical feature selection from becoming hidden orchestration state.

## Session Tracking

Hive uses a two-level session model so compaction recovery can find the right role before it finds the right feature:

- Global session identity lives in global `.hive/sessions.json`.
- Once a session is bound to a feature, it is mirrored into feature-local `sessions.json` files at `.hive/features/<feature>/sessions.json`.
- The global file is authoritative. Feature-local files are projections and cannot recover or rebind a child when they disagree.

Tracked metadata can include:

- `sessionId`
- `agent` / `baseAgent`
- `sessionKind`
- `featureName`
- `taskFolder`
- `projectRoot`
- `adHocRunId` for project-only ad-hoc workers
- `executionWorkspacePath` for an authenticated delegated execution
- `duplicatedFromSessionId` for generic origin continuity
- `directivePrompt`
- replay flags and activity metadata

This metadata records role and context continuity. Tool availability plus instructions govern action. Each tool validates its own operation. There is no attempt ledger.

### Session kinds

Hive distinguishes `primary`, `subagent`, `task-worker`, and `unknown` sessions.

- `primary`: top-level planner, orchestrator, or hybrid conversations
- `subagent`: delegated research or review sessions
- `task-worker`: workers and worker-derived custom agents executing a task
- `unknown`: safe fallback when Hive cannot classify the session confidently

### Recovery behavior after compaction

When OpenCode emits a compaction event, Hive rebuilds a minimal re-anchor prompt from stored session metadata.

- Primary and subagent sessions are re-anchored to their role.
- Primary and subagent sessions can restore the last real user directive through post-compaction replay, with `directiveRecoveryState` tracking whether recovery is still available for the current directive.
- For primary/subagent sessions the state machine is `available -> consumed -> escalated`, so one normal replay attempt is allowed before later compactions switch the session into escalation-only behavior.
- A new real directive resets the state so the next real assignment can use one fresh recovery cycle instead of inheriting the old session's terminal state.
- Task-worker sessions do not restore the full user directive or replay an earlier generated prompt. Hive refreshes live context catalogs separately as untrusted metadata.
- Recovery uses current catalog reads; historical prompt text is not a new assignment.
- Recovery prompts tell sessions not to switch roles, not to rediscover state through status tools, and not to re-read the full codebase.
- Moving a project root does not continue old task or ad-hoc work. At the new root, create a valid worktree if needed and launch fresh. Historical session records remain unchanged.

This keeps recovery narrow: orchestrators recover their role and directive, while workers recover their task contract from `.hive` state rather than transcript replay. Plugin restart does not continue old live workers.

## Todo Alignment

OpenCode todo behavior remains intentionally simple in this design:

- OpenCode todo state is session-scoped.
- OpenCode todo writes replace the session's todo list rather than patching individual items.
- Hive does not create a derived projected-todo field or another projected todo contract.
- Subagents and task workers should not be modeled as first-class todo writers.

This feature does not introduce a new upstream OpenCode todo API. The source of truth for task state remains `.hive`, while any OpenCode todo usage stays an explicit session-level behavior.

## Task Lifecycle

```
pending -> in_progress -> done
                      \-> blocked -> (resume) -> done
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
- Dependencies and bounded completed-task summaries
- Structured manual-task requirements when the task was created directly

`TaskService.sync` creates or refreshes plan-backed task folders and their `status.json` and `spec.md` files. `TaskService.create` owns the same files for append-only manual tasks. Worktree helpers and native Forager calls read these records; they do not generate `spec.md`.

### Reports
`hive_task_update` stores an optional report string as numeric history plus latest. Omissions are preserved. An explicit status leaving blocked clears the blocker. Partial writes: inspect before retry; there is no journal.

Blocked task status preserves blocker JSON and exposes it through `hive_status.tasks.list[].blocker`. After the operator decision, `hive_task_update` with an explicit status leaving blocked clears it. Put the decision in the next worker prompt.

## Execution Placement

Worktree placement executes a task in an isolated workspace under `.hive/.worktrees/{feature}/{task}/`. In legacy mode that path is a single Git worktree. In manifest-backed mode it is a composite workspace, with one Git worktree per declared repo under `repos/<repoId>/`. In-place placement uses the exact existing directory supplied by the caller and provides no filesystem isolation.

Agents edit the selected workspace. `hive_worktree_merge` integrates a clean pinned SHA. Live-directory work records task status only and has no Hive Git step. `hive_worktree_cleanup` removes a worktree. Git helpers do not change task status, auto-commit source, or assign workers. Unmerged branch delete requires explicit `discard: true`.

### Multi-Repo Composite Workspaces

When `.hive/repositories.json` defines project repositories, tasks with a `Repos:` annotation use composite workspaces. Each declared repo gets its own git worktree under the composite root.

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
- A non-git project root without a matching manifest fails worktree create and merge with a manifest-required error. Live-directory work still requires an explicit existing directory and never invents Git semantics.

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
- Plan tasks on manifest-backed projects declare `**Repos**: api` or `**Repos**: api, web`
- Missing, empty, or unknown repo IDs fail before worktree creation
- Legacy single-root tasks omit `Repos:` and keep implicit root behavior

### Aggregate Commit Contract

Composite commits iterate repositories in persisted placement order. Feature-task order matches the task `Repos:` list; it is not a universally sorted ID order.

| Scenario | `committed` | `partial` | `error` |
|---|---|---|---|
| All changed repos succeed | `true` | absent | absent |
| All repos no changes | `false` | `false` | absent |
| Some succeed, later repo fails | `false` | `true` | names failed repo |

Top-level `sha` is the first repo result SHA in that persisted order. Per-repo SHAs are authoritative. `committed: true` only when at least one repo committed and none failed.

### Aggregate Merge Contract

Composite merges preflight all repos before mutating any. Preflight failure returns `success: false`, `partial: false`, and names the failing repo. Mutation failure after earlier repo success returns `success: false`, `partial: true`, stops immediately, and does not roll back.

Top-level `filesChanged` and `conflicts` flatten per-repo paths as `repoId:path` in stable repo order. Rebase with custom `message` is rejected before any mutation.

## Key Principles

- **No global selection state** — Feature tools use explicit, path, session, or sole-live resolution
- **Detection-first** — Task-worktree paths override session and repository fallback
- **Placement-specific execution** — Worktree tasks are isolated Git workspaces; live-directory work is cooperative and has no Hive rollback, merge, or cleanup
- **Audit trail** — Every action logged to `.hive/`
- **Agent-friendly** — Minimal overhead during execution

## Source of Truth Rules

Hive uses file-based state with clear ownership boundaries:

| File | Owner | Other Access |
|------|-------|--------------| 
| `feature.json` | Primary agent | VS Code (read-only) |
| `status.json` (task) | `TaskService` sync/create and `hive_task_update` | Worker (read), Poller (read-only) |
| `plan.md` | Primary agent | VS Code (read + comment, execution source of truth) |
| `comments/plan.json` | VS Code | Primary agent (read-only) |
| `spec.md` | `TaskService.sync` / `TaskService.create` | Worker (read-only) |
| `report` / `reports` | Primary via `hive_task_update` | All (read-only) |
| `BLOCKED` | Operator | All (read-only, blocks operations) |

### Poller Constraints

The VSCode extension poller watches `.hive/` for changes:
- **Read-only**: Poller NEVER writes to any file
- **Debounced**: File changes debounced to avoid thrashing
- **Selective**: Only watches files it needs for UI

## Field Ownership

Task `status.json` fields and who writes them:

| Field | Written By | When |
|-------|-----------|------|
| `status` | Primary via `hive_task_update` | On recorded disposition |
| `origin` | `hive_tasks_sync` | On task creation |
| `planTitle` | `hive_tasks_sync` | On task creation |
| `summary` | Primary via `hive_task_update` | On recorded disposition |
| `report` | Primary via `hive_task_update` | Latest report string |
| `repoIds` | `hive_tasks_sync` / `hive_task_create` | On plan sync or manual task creation |
| `blocker` | Primary via `hive_task_update` | When blocked status is recorded |
| `dependsOn` | `hive_tasks_sync` / `hive_task_create` | On plan sync or manual task creation |
| `metadata` | `hive_task_create` | On structured manual task creation |

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
- `hive_tasks_sync` - Reconciles plan-backed tasks; `refreshPending: true` rewrites pending plan tasks from `plan.md`, updates `planTitle` / `dependsOn`, regenerates `spec.md`, and removes pending plan tasks deleted from the plan while preserving manual tasks and execution history
- `hive_task_create` - Creates a manual task with explicit `dependsOn` and optional structured metadata
- `hive_task_update` - Optional status/summary/blocker/report; omissions preserved; inspect before retry
- `hive_worktree_create` - Creates or selects a Git workspace
- `hive_worktree_merge` - Merges a task branch
- `hive_worktree_cleanup` - Removes a worktree

### Manual task model

Manual tasks are first-class task records, not loose notes.

- Manual tasks always persist an explicit `dependsOn` array. Omitting it means `[]`, not "infer the previous task".
- Structured manual-task `metadata` can carry `goal`, `description`, `acceptanceCriteria`, `references`, `files`, `reason`, and `source` so Hive can generate a worker-ready `spec.md`.
- Review-sourced manual tasks are for isolated follow-up only. If feedback changes sequencing, dependencies, or scope, update `plan.md` and run `hive_tasks_sync({ refreshPending: true })` so pending plan tasks match the amended DAG.

### Recovery Patterns

If a tool call fails mid-operation:
1. Check `hive_status` to see current state
2. Most operations leave state consistent (atomic file writes)
3. If `hive_task_update` is partial, inspect before retry; there is no journal
4. Composite partial merge outcomes are not rolled back
5. Partial merges require manual git intervention
