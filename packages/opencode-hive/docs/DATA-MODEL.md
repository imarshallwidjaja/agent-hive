# Hive Data Model

## Structure

```
.hive/
├── agent-hive.override.json   # Optional project-local agent model/variant overrides
├── repositories.json          # Optional Hive-managed project-local multi-repo manifest
├── sessions.json              # Canonical session bindings and session constraints
├── background-jobs.json       # Background board (observational bookkeeping)
├── context/                    # Project-wide managed knowledge
│   ├── index.json              # Schema-v1 operational index
│   └── {name}.md               # Raw Markdown with discovery frontmatter
├── archive/context/            # Archived project context
└── features/
    └── {NN}_{feature-name}/    # New features use indexed directories; older names still resolve
        ├── feature.json         # Feature metadata + lifecycle timestamps
        ├── plan.md              # Execution plan
        ├── APPROVED             # Plan approval marker
        ├── comments/plan.json   # Plan review threads
        ├── constraints.json     # Optional feature-scoped operator directives
        ├── sessions.json        # Optional feature-local navigation projection
        ├── context/             # Persistent knowledge files
        │   ├── index.json       # Schema-v1 operational index
        │   ├── .managed-mutation-pending.json # Present only during publication/recovery
        │   ├── overview.md      # Reserved human-facing summary/history file
        │   ├── decisions.md     # Optional example context file
        │   ├── architecture.md  # Optional example context file
        │   └── constraints.md   # Optional example context file
        ├── archive/context/     # Archived feature context
        └── tasks/               # Individual task folders (PRIMARY)
            └── {NN-task-name}/
                ├── status.json  # Task state + metadata
                ├── spec.md      # Task context and requirements
                ├── handoff.md   # Latest bounded successor note (when written)
                ├── report.md    # Latest report (when a report has been written)
                └── reports/     # Numeric {N}.md report history

.hive/.worktrees/              # Isolated git worktrees
    ├── {feature}/{task}/       # Task-backed single-root worktree
    │                           # Composite: {feature}/{task}/repos/{repoId}/
    └── adhoc/
        └── {runId}/            # Ad-hoc: temporary workspace metadata only
                                #   No feature/task records, not in hive_status
                                #   Composite: adhoc/{runId}/repos/{repoId}/
```

Task worktree paths may instead end in `{task}--{candidate}`. The corresponding single-root branches are `hive/{feature}/{task}` or `hive/{feature}/{task}-{candidate}`; composite branches prefix the feature with `{repoId}`. Ad-hoc branches are `hive/adhoc/{runId}` (single root) or `hive/adhoc/{repoId}/{runId}` (composite). Single-root workspace metadata sits beside the worktree as `{task}.json` or `{runId}.json`; composite roots contain `workspace.json` and one worktree per selected repository.

Runtime Agent Hive configuration lives at `~/.config/opencode/agent_hive.json`. The only project-local runtime configuration file is `.hive/agent-hive.override.json`, which can override `model` and `variant` for matching built-in or effective custom-agent declarations. Global config remains authoritative for all other settings. Project `.hive/agent-hive.json` and `.opencode/agent_hive.json` remain ignored; restart OpenCode after changing configuration.

Single-repo projects use the git root directly. Multi-repo topology is stored in `.hive/repositories.json` as `{ "schemaVersion": 1, "repositories": [{ "id": "repo-id", "path": "relative/path" }] }`. Paths are project-relative and contained within the project root; global `repositoryRoot`/`repositories` are migration-only legacy fields.

`feature.json` stores required `name`, `status`, and `createdAt`, with optional `ticket`, `sessionId`, `approvedAt`, `completedAt`, `archivedAt`, and `archiveReason`. New features start in `planning` and use an indexed directory such as `01_example`; callers address them by logical name `example`. Existing unindexed or differently separated indexed feature directories remain resolvable by the logical name in `feature.json`.

## Execution records

Task status and reports are the execution record. `hive_task_update({ report })` writes `reports/{N}.md`, mirrors it to `report.md`, then publishes `status.json`. The report body is not stored in `status.json`; inspect the three locations if publication fails before retrying. `N` is write order; the Markdown attribution line, not the number, names the author. `report.md` is the latest successful write, not a maintained synthesis. There is no attempt ledger. Old `execution-attempts.json` and lease files are left unread. Useful plans, tasks, context, reports, and workspace files remain readable.

`hive_task_update({ handoff })` replaces `tasks/{task}/handoff.md` with a nonblank successor note of at most 2048 UTF-8 bytes, independent of status or report updates. A later remediation run can replace it; omitted handoff leaves it unchanged. The result includes `handoffPath` when written; a failed handoff publication identifies the `handoff` stage, path, and `handoffWritten` flag.

`.hive/background-jobs.json` is the background board: acknowledgement, archive, and notification bookkeeping. It observes the originating native parent and call, not the current feature or agent. Stale and unknown observations stay visible. It does not couple to execution, worktree, or task status. Archive, reconcile, and ignore do not stop execution.

The board file has `schemaVersion: 1`, `jobs: BackgroundJobRecord[]`, and optional `updatedAt`. Each job stores native `taskId` and `sessionId`, required `alias`, agent identity, timestamps, `runtimeState` (`running`, `completed`, `error`, `cancelled`, or `unknown`), and optional `callId`, scope, notification, cancellation, reconciliation, and archive fields. Reconciled and ignored jobs remain stored but are hidden from the default background status view.

Ad-hoc worktrees are temporary workspace metadata only: no run history, evidence ledgers, or reports.

## Prompt Files

The primary authors the native Forager prompt. At native `task()` dispatch, the runtime appends a route-snapshot footer with `projectRoot`, the selected feature route, session constraints, and feature constraints. A selected feature-task Forager bound by `Hive task: <task-folder>` as its first non-empty authored line also receives a bounded path-only task brief after that footer. It does not inject context documents or catalogs; there is no project constraint register. Standing constraints are operator directives, not tool permissions.

## Reserved Overview Convention

- `context/overview.md` is a human-facing summary. Plan review threads are stored in `comments/plan.json`; `comments.json` is a legacy fallback.
- Create it with `hive_context_write`. For later replacement, call a named `hive_context_read` and pass its revision and `contentHash` as `expectedRevision` and `expectedContentHash`. From a repository-root session, provide `feature` whenever more than one live feature exists; a bound session or sole live feature can resolve it when omitted.
- `plan.md` remains the graph source of truth for plan-backed task generation, dependency parsing, and execution, and may still include a readable design summary before `## Tasks`.
- `context/overview.md` is readable by name but absent from the durable catalog.
- `context/index.json` has `schemaVersion: 1`, a scope-local monotonic `revision`, and metadata keyed by normalized context name. Each indexed entry records `kind` (`durable` or `evidence`), creation/update timestamps, an optional task, and the optional hash from its last managed write. Public file metadata reports `kindSource: "index"` for indexed non-reserved entries and `kindSource: "legacy_default"` for unindexed non-reserved Markdown under valid or missing control state. Invalid or pending control state does not guess classification. Legacy files remain byte-for-byte unchanged.
- Durable files appear in the `hive_context_read` catalog in deterministic Unicode code-point name order. `task` association is selection metadata rather than automatic freshness or task-distance prioritization. Evidence files remain readable by name but are absent from the durable catalog; neither kind enters prompts automatically. Feature hygiene warnings start above 8 durable files or 40,000 UTF-16 characters. Project warnings start above 32 files or 160,000 UTF-16 characters. These thresholds request explicit review; they do not reject otherwise bounded growth.
- `overview`, `draft`, and `execution-decisions` are reserved, absent from the durable catalog and excluded from durable-context hygiene counts. Each managed file still has a 1 MiB content limit. Plan approval leaves the active draft unchanged so approval cannot partially succeed and then report failure during cleanup. Archive an obsolete draft explicitly with `hive_context_archive` after approval.

## Managed Context Storage

Managed context stores raw Markdown bytes. Durable creates require YAML frontmatter with nonblank `description` and `read_when` strings of at most 512 Unicode code points. Project durable documents also require an accountability `owner` of at most 128 code points and a strict `review_after` date in `YYYY-MM-DD` form. A review is due on or after that date. Metadata is parsed as bounded data: aliases, duplicate keys, custom tags, malformed YAML, non-string recognized fields, and over-limit values are rejected on managed creation or replacement. Existing malformed, incomplete, or over-limit metadata produces bounded warnings and omits the invalid display value without rewriting or hiding the filename.

The operational index stays at schema version 1. Managed writes add `lastManagedContentHash`; old readers can ignore that field without changing stored Markdown. Invalid JSON, an unknown schema version, or an invalid operational entry fails closed as `context_index_invalid`. A missing index is different: absent control data retains the documented legacy durable default when no interrupted mutation is present. Recovery must not delete an invalid index to force that default.

Ordinary summaries and catalogs read directory entries, stat bytes, index bytes, and at most 8 KiB of frontmatter per candidate. They do not read every body to calculate characters. `durable.bytes` is the stat-byte total. `durable.chars` is available only from an explicit `scanChars` management scan and remains an exact UTF-16 count; callers must not treat bytes and characters as interchangeable. Catalog construction is bounded by 20,000 namespace entries, 10,000 Markdown candidates, 64 MiB of scanned headers, and a 16 KiB serialized response. Exceeding a construction limit returns `context_inventory_too_large`, never a partial response labeled complete.

Catalog cursors are versioned and bind scope, literal ASCII-folded query, traversal position, and a snapshot digest. The digest covers the observed index bytes and revision plus sorted inventory and header fingerprints. An index-only kind change therefore invalidates a cursor even if no body or revision changed. Cursor, snapshot, revision, and per-document `contentHash` serve different purposes and are not authorization grants.

Catalog pages default to 10 entries and accept at most 50. Both catalog views use the same prospective-cursor page admission algorithm and always report `hasMore` as the inverse of `complete`. The byte budget includes the prospective continuation cursor, so large metadata can produce smaller pages. A filtered durable catalog searches only name, description, and read_when, reports those three fields in `searchedFields`, and keeps owner as display metadata. Follow `nextCursor` while `hasMore` is true.

Named reads bypass full inventory construction. They stream and hash the complete raw file while returning the canonical UTF-8-safe `range: { startByte, endByte, totalBytes }`. The default serialized response budget is 16 KiB and the maximum is 64 KiB. Continue until `complete` is true to reconstruct a whole document. Existing-content replace and append operations require the current scope revision and the actual hash from that named read. Archive requires one hash for every selected name. A client must not compute a new hash at mutation time as a substitute for the read precondition.

The compatibility `write` and `delete` methods require the same revision and per-file hash; `write` replaces existing content, while explicit creation uses `create`. Compatibility `archive` requires the current revision and hashes for every file in the namespace, including reserved and evidence files. Missing preconditions reject without publication.

## Interrupted Publication

Every managed multi-file mutation writes `.managed-mutation-pending.json` under the context namespace after taking the existing index lock and before publishing content, creating archive destinations, removing archive sources, or publishing control data. On POSIX platforms, the writer flushes the marker file and containing directory before those changes, then flushes published files and changed directories before removing and directory-flushing the marker. Rollback follows the same ordering, and an uncertain publication, rollback, or marker-removal flush restores or retains the marker for reconciliation. Node does not expose the same directory-flush primitive on Windows, so Windows retains atomic rename and explicit file flushes but not the POSIX directory-durability guarantee. The marker identifies the operation, affected names, contained archive destinations, and starting control identity. It contains no body copies and is not a replay journal.

A surviving marker returns `context_reconciliation_required` for catalogs and mutations. Stale-lock reclamation leaves the marker in place and never resumes the operation. Authorized primary-management diagnostics may inspect bounded control digests, unclassified names and stats, or exact named raw chunks without classifying unknown evidence as legacy durable. Reads do not create directories, locks, indexes, markers, or repairs.

`readRecoverySummary` returns a typed envelope within 16 KiB: the blocking control code, safely extractable revision (otherwise null), index parse/schema errors, pending operation details, and presence/digests for the index, marker, and archive manifest. Its unclassified inventory reports `totalFiles` and `complete`; pending details have their own counts and completeness flag. Inspect omitted or truncated details locally. Recovery instructions are included in every envelope. These observations neither infer classification nor supply mutation preconditions.

Recovery is intentionally out of band in this version. Quiesce writers, inspect the marker and named bytes, restore or correct the index and archive manifest, then reconcile the marker explicitly. The ordering narrows the unsafe state but does not make the mutation universally power-loss-safe or crash-atomic, and the marker is not a generic journal or database transaction. Editors that ignore Hive locks can still race between a read and mutation; revision plus actual content hashes detect ordinary drift but do not prove that a caller read every chunk.

All bundled source consumers must use the hash-aware signatures together. Mixed old and new managed writers are unsupported. Storage remains compatible with existing schema-v1 Markdown and index bytes, while chunked reads and mandatory mutation hashes are intentional client contract upgrades.

## Task status.json

```json
{
  "status": "pending",
  "origin": "manual",
  "planTitle": "capture dag handoff",
  "dependsOn": ["02-route-review-follow-up"],
  "metadata": {
    "goal": "Record the operator-facing workflow after the review batch",
    "description": "Write the handoff notes after the isolated follow-up task finishes",
    "acceptanceCriteria": [
      "handoff.md lists the commands that passed",
      "overview.md reflects the final DAG workflow"
    ],
    "references": [
      "packages/opencode-hive/docs/DATA-MODEL.md:43-190"
    ],
    "files": [
      "packages/opencode-hive/docs/DATA-MODEL.md"
    ],
    "reason": "Operator requested final handoff notes",
    "source": "ad_hoc"
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | number? | Forward-compatibility version for `status.json`. Current value is `1`. |
| `status` | string | Task status (see Status Values below) |
| `origin` | string | `"plan"` (from plan.md) or `"manual"` (manually created) |
| `planTitle` | string? | Task title from plan.md |
| `summary` | string? | Execution summary |
| `blocker` | object? | `TaskBlocker` with required reason and optional options, recommendation, and context; present while blocked |
| `aggregateBranchDiff` | object? | Captured file count, insertions, deletions, areas, and report for a terminal report |
| `startedAt` | string? | ISO timestamp when task started |
| `completedAt` | string? | ISO timestamp when task completed |
| `baseCommit` | string? | Git commit hash at task start |
| `baseCommits` | map? | Base commit hashes keyed by repository ID |
| `repoIds` | string[]? | Persisted repository selection for a manifest-backed task |
| `subtasks` | object[]? | Optional nested subtask state when a task is decomposed during execution. |
| `dependsOn` | string[]? | Task folder names this task depends on (for example, `["01-setup"]`). Plan tasks resolve this from `plan.md` `Depends on:` annotations during `hive_tasks_sync`; manual tasks persist an explicit array and default to `[]`. A missing field in an older record reads as `[]`; reads never rewrite the file. |
| `metadata` | object? | Structured manual-task metadata used to generate `spec.md`. Omitted for normal plan-backed tasks. |

**Dependency rules**:
- Only status `done` satisfies a dependency.
- `plan.md` is the graph source of truth for plan-backed dependencies.
- Manual tasks always write explicit dependency metadata. Omitting `dependsOn` at creation time means `[]`, not "infer the previous task".
- manual tasks are append-only.
- If `order` is omitted, Hive stores the next order automatically; explicit `order` is accepted only when it equals that next order, so intermediate insertion requires plan amendment.
- Manual dependencies may name unfinished existing tasks. They block readiness until those tasks are `done`.
- Review-sourced manual tasks cannot declare explicit dependencies. If review feedback changes downstream sequencing, dependencies, or scope, amend `plan.md` instead.
- A missing `dependsOn` field means no dependencies. Folder numbers never imply an edge; the "previous task" default for a plan task without a `Depends on:` line is applied when sync compiles the plan and is stored explicitly.
- Sync and manual creation reject a resulting graph in which an unfinished task (`pending`, `in_progress`, `blocked`, `failed`, `partial`) depends on a missing task or itself, or unfinished tasks form a cycle. A rejected call writes no task files.
- Dependencies of `done` and `cancelled` tasks are history. They are kept unchanged and are not validated. A done or cancelled dependency target must exist, and only `done` satisfies it.
- Cancelled tasks are retained across syncs with their artifacts. Cancelling releases the task's outgoing dependencies from validation; it does not rewire tasks that depend on it. Repair routes are listed in [HIVE-TOOLS.md](HIVE-TOOLS.md#task-dependency-graph).

### Manual-task metadata

Manual tasks support the following structured metadata in `status.json.metadata`:

| Field | Type | Purpose |
|-------|------|---------|
| `goal` | string? | Why this task exists and what done means |
| `description` | string? | Worker-facing execution summary |
| `acceptanceCriteria` | string[]? | Observable outcomes the operator expects |
| `references` | string[]? | Relevant files, docs, or line ranges |
| `files` | string[]? | Likely edit targets |
| `reason` | string? | Why the task was created |
| `source` | string? | One of `review`, `operator`, or `ad_hoc` |

Some notes:
- `hive_task_create()` accepts `dependsOn` and `repos` alongside the metadata fields, but stores them at the top level in `status.json.dependsOn` and `status.json.repoIds`.
- `buildManualTaskSpec()` turns these structured fields into a worker-ready `spec.md` with `Goal`, `Description`, `Acceptance Criteria`, `Files`, `References`, and `Origin` sections; when repositories are declared it also includes `Repositories`.

## Pending-task refresh path

Within execution, `plan.md` stays authoritative for the plan-backed DAG. When the operator amends `plan.md` and wants pending plan tasks to match the new graph, run:

```ts
hive_tasks_sync({ refreshPending: true })
```

`refreshPending` does the following:
- Rewrites pending plan-backed tasks from the current `plan.md`
- Updates `status.json.planTitle`
- Updates `status.json.dependsOn`
- Updates `status.json.repoIds` from `Repos:` in the plan (or removes it if the plan no longer declares repositories)
- Regenerates `spec.md`
- Deletes pending plan-backed tasks removed from `plan.md`
- Preserves manual tasks, cancelled tasks, and any task with execution history (`in_progress`, `done`, `blocked`, `failed`, `partial`)
- Rejects the whole sync, before any write, when the resulting unfinished-task graph is invalid; refreshing a pending task's outdated dependencies is one of the repair routes

Ad-hoc orchestration uses `hive_adhoc_worktree_create`, `hive_adhoc_worktree_merge`, and `hive_adhoc_worktree_cleanup` for Git worktree placement. Manual tasks remain for full Hive DAG follow-ups. Route sequencing or scope changes back through `plan.md`, then refresh pending tasks from that graph.

For interrupted work, treat live worktree and task state as the bounded truth surface: ask for a locally testable state or interrupted-state wrap-up summary first, create a safe manual follow-up only when it can append after the approved DAG, and amend `plan.md` instead of inventing intermediate numbering. An interrupted worker run leaves the task `in_progress` for retry; the primary appends an attributed interruption report, and a report written before the failure is that worker's narrative, not proof of completion.

## Status Values

Task statuses (TaskStatusType):
- `pending`: Not started
- `in_progress`: Currently being worked on
- `done`: Completed successfully
- `blocked`: Waiting for user decision
- `failed`: Execution failed (errors, tests not passing)
- `partial`: Partially completed (some work done, not finished)
- `cancelled`: Cancelled by user

Feature statuses (FeatureStatusType):
- `planning`: Plan being written/reviewed
- `approved`: Plan approved, ready for execution
- `executing`: Tasks being executed
- `completed`: Feature marked complete; it cannot be reopened, and plan write, patch, and approval are rejected
- `archived`: Feature archived and hidden from the default feature listing

## hive_status Output

`hive_status({ feature? })` returns feature information, task summaries, dependency readiness, and feature-task worktrees. It does not include the background board, ad-hoc runs, managed context, report bodies, or an overview projection.

### Top-Level Objects

- `feature`: `{ name, status, tasks, hasPlan, commentCount, reviewCounts: { plan } }` from `FeatureService.getInfo`, or `null` for an unknown feature or missing `feature.json`. This is a summary, not the full `feature.json` (which also stores `ticket`, `createdAt`, and optional lifecycle timestamps).
- `tasks`: task summaries from `TaskService.list`.
- `runnable`: pending task folders whose stored dependencies are all `done`.
- `blocked`: pending task folders mapped to their unmet stored dependencies.
- `worktrees`: healthy feature-task workspace state from `WorktreeService.list`.
- `worktreeErrors` (optional): invalid workspace or namespace entries as `{ path, reason }`; one bad entry does not prevent other worktrees or task summaries from being read.
- `warning` (optional): config fallback warning.
- `specFreshnessError` (optional): freshness check failure; every task entry reports `specStale: null` and `specStaleReason: 'freshness_unavailable'`.

With `feature: null`, the other summaries may be empty.

### Task List Fields

Each entry in `tasks` includes:
- `folder` (string)
- `name` (string)
- `status` (string)
- `origin` (string)
- `planTitle`, `summary`, and `repoIds` (optional)
- `dependsOn` (string[]), in both `tasks` and `feature.tasks`: the stored dependency folders, `[]` when the field is missing. Done and cancelled tasks keep theirs as history.
- `specStale` (true/false/null), `specStaleReason`, and `hasHandoff` (boolean), in both `tasks` and `feature.tasks`. `differs_from_plan` compares the stored spec with current generated text for that task; unrelated plan edits do not make it stale. Null reasons cover manual tasks, missing/invalid plans, missing plan task or spec, and unowned headings after the task section.

The full `status.json` may contain a `blocker` (`TaskBlocker`, optional and present only while `status` is `blocked`). `TaskBlocker` contains a required nonblank `reason` and optional `options`, `recommendation`, and `context`. An explicit status leaving blocked clears the blocker. Read `report.md` and `reports/{N}.md` for report bodies.

### Runnable and Blocked

```
runnable   # array of pending task folders with satisfied dependencies
blocked    # map: pending task folder -> array of unmet dependency folders
```

Rules:
- Only `done` satisfies dependencies.
- Only pending tasks appear in `runnable` or `blocked`. Both are computed from the same `dependsOn` values the task lists report.
- These arrays describe dependency readiness; they are not a dispatch-admission gate.

Example:

```json
{
  "feature": { "name": "example", "status": "executing", "tasks": [
    { "folder": "01-setup", "name": "setup", "status": "done", "origin": "plan", "dependsOn": [] },
    { "folder": "02-core", "name": "core", "status": "pending", "origin": "plan", "dependsOn": ["01-setup"] },
    { "folder": "03-ui", "name": "ui", "status": "pending", "origin": "plan", "dependsOn": ["02-core"] }
  ], "hasPlan": true, "commentCount": 1, "reviewCounts": { "plan": 1 } },
  "tasks": [
    { "folder": "01-setup", "name": "setup", "status": "done", "origin": "plan", "dependsOn": [] },
    { "folder": "02-core", "name": "core", "status": "pending", "origin": "plan", "dependsOn": ["01-setup"] },
    { "folder": "03-ui", "name": "ui", "status": "pending", "origin": "plan", "dependsOn": ["02-core"] }
  ],
  "runnable": ["02-core"],
  "blocked": { "03-ui": ["02-core"] },
  "worktrees": []
}
```

## spec.md Structure

`spec.md` is generated for each task. Every generated spec includes a **Dependencies** section:

```
## Dependencies
- **1. Setup** (01-setup)
```

If a task has no dependencies (explicit `Depends on: none`), the section is:

```
## Dependencies
_None_
```

Plan-backed specs also include the matching `## Plan Section` excerpt from `plan.md`.
Supporting context bodies do not appear in generated specs. The runtime does not deliver context catalogs to child prompts; agents can query current project or feature context through `hive_context_read`.

Manual-task specs derive their sections from structured metadata and may include:
- `## Repositories` (when `repos` were supplied)
- `## Goal`
- `## Description`
- `## Acceptance Criteria`
- `## Files`
- `## References`
- `## Origin`

## Session Metadata

Canonical session bindings and session-scoped constraint entries live in project `.hive/sessions.json`. Feature-local `sessions.json` files are projections for navigation and cannot replace missing canonical provenance. A selected feature route is stored as `featureName`; explicit `null` means featureless, while an absent field leaves route fallback available. Feature-scoped constraints live separately in `.hive/features/{feature-directory}/constraints.json` as `{ "entries": [{ "id": "constraint-...", "text": "..." }], "revision": 1 }`.

```json
{
  "master": "ses_abc123",
  "sessions": [
    {
      "sessionId": "ses_abc123",
      "parentSessionId": "ses_parent",
      "featureName": "feature-a",
      "taskFolder": "01-first-task",
      "projectRoot": "/trusted/project",
      "startedAt": "2025-01-05T09:00:00Z",
      "lastActiveAt": "2025-01-05T10:30:00Z",
      "messageCount": 42,
      "standingConstraints": "Australian English.\n\nNo emojis.",
      "standingConstraintEntries": [
        { "id": "constraint-...", "text": "Australian English." },
        { "id": "constraint-...", "text": "No emojis." }
      ],
      "standingConstraintsRevision": 2
    }
  ]
}
```

`standingConstraintEntries` holds independently addressable verbatim directives. `standingConstraintsRevision` provides optimistic concurrency for targeted edits and explicit whole-register clears. `standingConstraints` is the rendered aggregate injected into delegated task and worker prompts, capped at 8000 UTF-16 code units. String-only records written by earlier versions are read as one deterministic `legacy` entry and migrate on the next mutation.

When `.hive/sessions.json` exists but does not parse as JSON (including an empty or all-NUL file), the next session read or update reads it again while holding `sessions.json.lock` and, if it is still invalid, copies it unchanged to a new sibling `sessions.json.corrupt-<UTC timestamp>` file before replacing it with `{ "sessions": [] }`. A warning names both paths. Saved session routes and session constraints start fresh; feature-scoped constraints are separate files and are unaffected. Other read errors, such as permissions or a directory at that path, are reported without a reset.

Task `status.json` records status, summary, and blocker from `hive_task_update`; report history and the latest report are Markdown files under the task directory. Stale generated-assignment keys in older JSON are ignored.

The session register and the feature register are separate. The runtime captures both registers for child dispatch and labels each in the prompt; it stores the session snapshot in the child's canonical session entry.

## Compatibility

Old attempt and lease files are left unread. Useful plans, tasks, context, reports, and workspace files remain readable. There is no user-facing migration ceremony.
