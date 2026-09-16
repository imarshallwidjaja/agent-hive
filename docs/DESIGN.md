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
│       ├── tasks.json    <- Task list with status
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

Hive admits one managed writer per exact registered worktree identity. Multiple primary sessions in one project may run concurrently on independent worktrees. Two executions conflict when their exact registered worktree identity sets intersect. A composite claim covers the explicit registered worktree set. Generic ancestor or descendant filesystem containment is not the conflict model, so the project root does not overlap every worktree merely because it is an ancestor path. Declared file ownership is not a concurrency guarantee.

An **ExecutionAttempt** is the dispatch and recovery record (`armed` -> `attached` -> `stopped` -> `finalized`). Persist attempt history in `.hive/execution-attempts.json`. A **live claim** maps exact worktree identity to the active attempt ID. In-place placement records an existing directory for scope only and creates no exclusive filesystem claim. Persisted history is not proof that an execution is still alive. After restart, unattached arms close as `not_started`; attached attempts remain quarantined until exact stop evidence arrives.

When native execution is unobserved or unavailable, only the affected worktree is quarantined; unrelated worktrees may proceed. Uncertain workspaces are preserved; they are not reset, copied, or deleted to recover. A feature-task worktree cannot be retried until authenticated stop evidence and primary finalization release its claim. Starting the same task twice allocates atomically one active attempt; the second caller is rejected or returned the existing attempt. For ad-hoc work, retry after finalization may reuse the same `runId` worktree. Retry while termination is unobserved cannot reuse that run; start a new ad-hoc `runId` and worktree.

An **integration lock** is operation-scoped: source worktree, destination checkout, and composite repositories. Two integrations into the same destination checkout serialize. Integration while unrelated worktrees are active is allowed when source and destination do not conflict. Integration is refused while the source worktree has an active writer. Context, plan, and constraint mutations keep revision and hash conflict handling.

`hive_existing_workspace_start` is unavailable. Isolated worktrees are the managed placement. Direct foreground OpenCode work may still modify the current checkout; that work is unmanaged OpenCode work, not a Hive placement. The native `general` or helper exception is not a replacement placement.

The background board is observational bookkeeping. Archive, reconcile, and ignore do not stop execution, release a workspace, settle an attempt, or authorize retry in the same workspace. A parent may hold only one undispatched Forager arm. Agent-supplied metadata is never authoritative execution identity. Do not treat placeholders such as `forager-child` as live owners, and do not treat a `ses_` prefix as identity validation. `NativeTaskLease` values are diagnostic history after one-shot migration onto `nativeTaskLeaseHistory`; they are not scheduling authority.

Cancellation is owner-scoped. Another primary must not automatically terminate another primary's child. Cancel acknowledgement is not proof of termination; live claims remain until termination is observed. Cleanup and archival never imply execution cancellation. Workers return one terminal handoff; the originating primary calls `hive_execution_finish` after exact structured stop evidence.

Cross-process process supervision, exactly-once execution across independent OpenCode processes, automatic crash takeover, and distributed locking are unsupported. Independent OpenCode runtimes sharing a project do not get a complete exclusivity promise. Review-workspace claim and cleanup remain a separate security boundary.

## Data Flow

1. User creates feature via `hive_feature_create`
2. Agent writes plan via `hive_plan_write`
3. User reviews `plan.md` and adds comments there
4. User approves via `hive_plan_approve`
5. Tasks synced via `hive_tasks_sync` (generates spec.md for each)
6. Each task executed via `hive_execution_prepare` -> unchanged native Forager `task()` -> structured stop -> `hive_execution_finish`
7. Changes applied from a finalized worktree to the destination checkout with `hive_merge`
8. Report written as an immutable finalization receipt

## Prompt Management

- `spec.md` contains the fixed task contract: the matching plan section, manual task requirements, dependencies, and bounded completed-task summaries. Supporting context bodies are not copied into it.
- The primary authors the native Forager `description`, `prompt`, `subagent_type`, and optional `background`. Preparation does not generate, freeze, or replace those fields.
- The native before-hook appends a factual `## Hive execution scope` footer and the dispatch-time `## Standing Constraints (operator, session-wide)` snapshot without replacing caller prompt bytes. Standing constraints are operator directives, not tool permissions.
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

This metadata records role and context continuity. Managed execution authority comes only from exact `ExecutionAttempt.native` parent/call/child correlation and placement scope.

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
- Task-worker sessions do not restore the full user directive or replay an earlier generated prompt. The attached `ExecutionAttempt.native` parent/call/child identity and placement remain the managed execution binding. Hive refreshes live context catalogs separately as untrusted metadata.
- Missing or contradictory native identity leaves the attempt quarantined. Recovery uses exact runtime binding and current catalog reads; historical prompt text is not authority for a new launch.
- Recovery prompts tell sessions not to switch roles, not to rediscover state through status tools, and not to re-read the full codebase.
- Relocation intentionally loses seamless continuation. Stored roots are compared as provenance and are never followed as lookup redirects. An authenticated primary at the newly trusted canonical root must create a fresh task attempt and native child binding. Ad-hoc work requires a fresh authenticated run. Historical session and execution records remain unchanged.

This keeps recovery narrow and deterministic: orchestrators recover their role and directive, while workers recover their exact task contract without drifting into orchestration. In operator terms, the durable recovery surface is task-level semantic `.hive` state, not transcript replay.

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

### spec.md (generated on task sync)
Contains task context for the executing agent:
- Task number, name, feature, folder
- Full description from plan
- Prior tasks (what came before)
- Upcoming tasks (what comes after)

### Finalization reports
Task finalization writes an immutable `reports/finalization-<operationId>.md` receipt and updates `report.md` with the same report plus a history link. Ad-hoc finalization writes `.hive/execution-reports/finalization-<operationId>.md` and has no task-local latest report. The returned `reportPath` is authoritative. Each report records the attempt, operation, disposition, primary-authored summary, and per-repository commit SHA or `NO_TRACKED_CHANGES`; blocked reports also record the blocker JSON.

## Worktree Isolation

Each task executes in an isolated workspace under `.hive/.worktrees/{feature}/{task}/`. In legacy mode that path is a single git worktree. In manifest-backed mode that path is a composite workspace, with one git worktree per declared repo under `repos/<repoId>/`.

Agents edit only the selected workspace. For worktree placement, `hive_execution_finish` collects the task diff after exact stop evidence. In-place placement records disposition only and never runs Git. `hive_worktree_discard` removes a worktree without applying changes, and is refused while that worktree has a live or unobserved claim.

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
- A non-git project root without a matching manifest fails worktree placement, worktree finalization, and merge with a manifest-required error. In-place placement and finalization still require an explicit existing directory and never invent Git semantics.

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

Composite commits iterate declared repos in stable sorted ID order:

| Scenario | `committed` | `partial` | `error` |
|---|---|---|---|
| All changed repos succeed | `true` | absent | absent |
| All repos no changes | `false` | `false` | absent |
| Some succeed, later repo fails | `false` | `true` | names failed repo |

Top-level `sha` is the first repo result SHA in stable order. Per-repo SHAs are authoritative. `committed: true` only when at least one repo committed and none failed.

### Aggregate Merge Contract

Composite merges preflight all repos before mutating any. Preflight failure returns `success: false`, `partial: false`, and names the failing repo. Mutation failure after earlier repo success returns `success: false`, `partial: true`, stops immediately, and does not roll back.

Top-level `filesChanged` and `conflicts` flatten per-repo paths as `repoId:path` in stable repo order. Rebase with custom `message` is rejected before any mutation.

## Key Principles

- **No global selection state** — Feature tools use explicit, path, session, or sole-live resolution
- **Detection-first** — Task-worktree paths override session and repository fallback
- **Isolation** — Each task in own worktree, safe to discard
- **Audit trail** — Every action logged to `.hive/`
- **Agent-friendly** — Minimal overhead during execution

## Source of Truth Rules

Hive uses file-based state with clear ownership boundaries:

| File | Owner | Other Access |
|------|-------|--------------| 
| `feature.json` | Primary agent | VS Code (read-only) |
| `tasks.json` | Primary agent | VS Code (read-only) |
| `status.json` (task) | Originating primary via `hive_execution_finish` | Worker (read), Poller (read-only) |
| `plan.md` | Primary agent | VS Code (read + comment, execution source of truth) |
| `comments/plan.json` | VS Code | Primary agent (read-only) |
| `spec.md` | `hive_execution_prepare` | Worker (read-only) |
| `report.md` | Originating primary via `hive_execution_finish` | All (read-only) |
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
| `status` | Originating primary via `hive_execution_finish` | On finalized disposition |
| `origin` | `hive_tasks_sync` | On task creation |
| `planTitle` | `hive_tasks_sync` | On task creation |
| `summary` | Originating primary via `hive_execution_finish` | On finalized disposition |
| `startedAt` | `hive_execution_prepare` | On arming/resume |
| `completedAt` | `hive_execution_finish` | On finalized completion |
| `baseCommit` | `hive_execution_prepare` | On worktree creation/resume (legacy; first repo HEAD) |
| `baseCommits` | `hive_execution_prepare` | On composite worktree creation/resume (per-repo) |
| `repoIds` | `hive_tasks_sync` / `hive_task_create` | On plan sync or manual task creation |
| `blocker` | Originating primary via `hive_execution_finish` | When blocked disposition is recorded |
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
- `hive_task_update` - Mutates task status/summary and is not a retry-safe read
- `hive_execution_prepare` - Arms one next Forager dispatch and may create or reuse placement
- `hive_execution_finish` - Checkpointed Git/report/disposition finalization after exact stop evidence
- `hive_merge` - Merges a finalized completed branch (fails if already merged)

### Manual task model

Manual tasks are first-class task records, not loose notes.

- Manual tasks always persist an explicit `dependsOn` array. Omitting it means `[]`, not "infer the previous task".
- Structured manual-task `metadata` can carry `goal`, `description`, `acceptanceCriteria`, `references`, `files`, `reason`, and `source` so Hive can generate a worker-ready `spec.md`.
- Review-sourced manual tasks are for isolated follow-up only. If feedback changes sequencing, dependencies, or scope, update `plan.md` and run `hive_tasks_sync({ refreshPending: true })` so pending plan tasks match the amended DAG.

### Recovery Patterns

If a tool call fails mid-operation:
1. Check `hive_status` to see current state
2. Most operations leave state consistent (atomic file writes)
3. If `hive_execution_finish` fails, inspect its durable receipt, task or ad-hoc attempt state, and Git state, then retry the identical finish input after confirming the prior call stopped
4. Discard only an unconsumed arm or a finalized worktree attempt; attached, stopped, and uncertain attempts remain quarantined
5. Partial merges require manual git intervention
