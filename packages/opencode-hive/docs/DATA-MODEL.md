# Hive Data Model

## Structure

```
.hive/
├── repositories.json          # Optional Hive-managed project-local multi-repo manifest
├── sessions.json              # Optional top-level session index (when used)
├── execution-attempts.json    # ExecutionAttempt history (dispatch/recovery; not liveness proof)
├── background-jobs.json       # Background board (observational bookkeeping, not an ownership registry)
├── context/                    # Project-wide managed knowledge
│   ├── index.json              # Schema-v1 operational index
│   └── {name}.md               # Raw Markdown with discovery frontmatter
└── features/
    └── {feature-name}/
        ├── feature.json         # Feature metadata + lifecycle timestamps
        ├── plan.md              # Execution plan
        ├── comments/            # Document-aware review threads
        │   ├── overview.json    # Comments on context/overview.md
        │   └── plan.json        # Comments on plan.md
        ├── sessions.json        # Session tracking
        ├── context/             # Persistent knowledge files
        │   ├── index.json       # Schema-v1 operational index
        │   ├── .managed-mutation-pending.json # Present only during publication/recovery
        │   ├── overview.md      # Reserved human-facing summary/history/review file
        │   ├── decisions.md     # Optional example context file
        │   ├── architecture.md  # Optional example context file
        │   └── constraints.md   # Optional example context file
        └── tasks/               # Individual task folders (PRIMARY)
            └── {NN-task-name}/
                ├── status.json  # Task state + metadata
                ├── spec.md      # Task context and requirements
                ├── report.md    # Latest report plus immutable-history link
                └── reports/
                    └── finalization-{operationId}.md # Immutable receipt

.hive/execution-reports/
    └── finalization-{operationId}.md # Ad-hoc immutable receipt

.hive/.worktrees/              # Isolated git worktrees
    ├── {feature}/{task}/       # Task-backed: full repo copy for safe execution
    └── adhoc/
        └── {runId}/            # Ad-hoc: isolated orchestration worktree
                                #   No feature/task records, not in hive_status
                                #   Composite: adhoc/{runId}/repos/{repoId}/
```

Runtime Agent Hive configuration is **not** stored under `.hive/`. It lives only at `~/.config/opencode/agent_hive.json`. Project-local `agent_hive.json` / `agent-hive.json` files are ignored.

Single-repo projects use the git root directly; multi-repo topology, when needed, is stored in this manifest.

## Execution attempts and live claims

`.hive/execution-attempts.json` stores **ExecutionAttempt** history. An ExecutionAttempt is the dispatch and recovery record for a managed feature-task or ad-hoc launch. Its lifecycle is `armed` -> `attached` -> `stopped` -> `finalized`. A record holds the attempt id, task or ad-hoc run identity, originating primary session, discriminated `worktree | in_place` placement, exact workspace identity for worktree claims, branch and base commit where applicable, parent/call/child identities, stop evidence, and finalization receipts.

A **live claim** maps exact worktree identity to the active attempt ID. In-place placement creates no exclusive filesystem claim. Composite claims cover the explicit registered worktree set. Two executions conflict when those identity sets intersect. One exact registered worktree may have only one managed writer at a time.

Persisted history is not proof that an execution is still alive. After restart, unattached arms close as `not_started` because no native call could have crossed the durable attachment boundary; attached attempts remain quarantined until exact stop evidence arrives. Migrated dispatched attempts are attached with `background: 'unknown'` unless one exact board record proves blocking or background mode; unknown mode accepts only exact structured background terminal evidence. Unrelated worktrees may proceed. Uncertain workspaces are preserved; they are not reset, copied, or deleted to recover.

A feature-task worktree remains quarantined through `stopped` until the originating primary finalizes it. An unobserved feature-task execution cannot be moved to an alternate placement or force-discarded. For ad-hoc work, retry after finalization may reuse the same `runId` worktree. Retry while termination is unobserved cannot reuse that run; start a new ad-hoc `runId` and worktree.

`.hive/background-jobs.json` is the background board: acknowledgement, archive, and notification bookkeeping. It is not an ownership registry. Archive, reconcile, and ignore do not stop execution, release a workspace, settle an attempt, or authorize retry in the same workspace.

One-shot lease migration extracts leftover `sessions.json` `nativeTaskLeases`, deletes them from that file, and stores them as `nativeTaskLeaseHistory` on `.hive/execution-attempts.json`. Exact worktree-path, non-placeholder, non-capability leases become unobserved attached ExecutionAttempt claims once. This is not an ongoing second admission API. After migration, `sessions.json` does not keep `nativeTaskLeases` as a live sibling.

## Prompt Files

`hive_execution_prepare` records scope and placement and returns lifecycle facts only. The primary authors the native Forager prompt. The native before-hook appends authenticated execution scope and the dispatch-time standing-constraint snapshot to the caller-authored prompt without replacing it. Standing constraints are operator directives, not tool permissions.

## Reserved Overview Convention

- `context/overview.md` is the primary human-facing summary and review surface.
- Create it with `hive_context_write`. For later replacement, call a named `hive_context_read` and pass its revision and `contentHash` as `expectedRevision` and `expectedContentHash`. From a repository-root session, provide `feature` whenever more than one live feature exists; a bound session or sole live feature can resolve it when omitted.
- `plan.md` remains the graph source of truth for plan-backed task generation, dependency parsing, and execution, and may still include a readable design summary before `## Tasks`.
- `context/overview.md` is intentionally excluded from worker execution context so the narrative summary does not blur implementation truth.
- `context/index.json` has `schemaVersion: 1`, a scope-local monotonic `revision`, and metadata keyed by normalized context name. Each non-reserved entry records `kind` (`durable` or `evidence`), creation/update timestamps, an optional task, and the optional hash from its last managed write. Public file metadata reports `kindSource: "index"` for those entries and `kindSource: "legacy_default"` for unindexed non-reserved Markdown under valid or missing control state. Invalid or pending control state does not guess classification. Legacy files remain byte-for-byte unchanged.
- Durable files are the entries eligible for execution and network context. Catalogs list them in deterministic Unicode code-point name order, and `task` association is selection metadata rather than automatic freshness or task-distance prioritization. Evidence files preserve raw logs and historical verification without entering worker or network prompts. Feature hygiene warnings start above 8 durable files or 40,000 UTF-16 characters. Project warnings start above 32 files or 160,000 UTF-16 characters. These thresholds request explicit review; they do not reject otherwise bounded growth.
- `overview`, `draft`, and `execution-decisions` are reserved, excluded from execution context, and uncapped. Plan approval leaves the active draft unchanged so approval cannot partially succeed and then report failure during cleanup. Archive an obsolete draft explicitly with `hive_context_archive` after approval.

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
| `startedAt` | string? | ISO timestamp when task started |
| `completedAt` | string? | ISO timestamp when task completed |
| `baseCommit` | string? | Git commit hash at task start |
| `subtasks` | object[]? | Optional nested subtask state when a task is decomposed during execution. |
| `workerAttempt` | number? | Monotonic task generation used for stale-attempt compare-and-swap during finalization. Native worker identity lives only on the current `ExecutionAttempt`. |
| `dependsOn` | string[]? | Task folder names this task depends on (for example, `["01-setup"]`). A task is runnable only when every dependency is `done`. Plan tasks resolve this from `plan.md` `Depends on:` annotations during `hive_tasks_sync`; manual tasks persist an explicit array and default to `[]`. |
| `metadata` | object? | Structured manual-task metadata used to generate `spec.md`. Omitted for normal plan-backed tasks. |

**Dependency rules**:
- Only status `done` satisfies a dependency.
- `plan.md` is the graph source of truth for plan-backed dependencies.
- Manual tasks always write explicit dependency metadata. Omitting `dependsOn` at creation time means `[]`, not "infer the previous task".
- manual tasks are append-only.
- If `order` is omitted, Hive stores the next order automatically; explicit `order` is accepted only when it equals that next order, so intermediate insertion requires plan amendment.
- Explicit manual dependencies are for isolated ad-hoc/operator work only, and only when every target task is already `done`.
- dependencies on unfinished work require plan amendment.
- Review-sourced manual tasks cannot declare explicit dependencies. If review feedback changes downstream sequencing, dependencies, or scope, amend `plan.md` instead.
- If `dependsOn` is omitted by a legacy task record, Hive applies implicit sequential ordering based on the numeric task prefix (N depends on N-1).

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
- `hive_task_create()` accepts `dependsOn` alongside the metadata fields, but stores it at the top level in `status.json.dependsOn`.
- `buildManualTaskSpec()` turns these structured fields into a worker-ready `spec.md` with `Goal`, `Description`, `Acceptance Criteria`, `Files`, `References`, and `Origin` sections.

## Pending-task refresh path

Within execution, `plan.md` stays authoritative for the plan-backed DAG. When the operator amends `plan.md` and wants pending plan tasks to match the new graph, run:

```ts
hive_tasks_sync({ refreshPending: true })
```

`refreshPending` does the following:
- Rewrites pending plan-backed tasks from the current `plan.md`
- Updates `status.json.planTitle`
- Updates `status.json.dependsOn`
- Regenerates `spec.md`
- Deletes pending plan-backed tasks removed from `plan.md`
- Preserves manual tasks and any task with execution history (`in_progress`, `done`, `blocked`, `failed`, `partial`)

Ad-hoc orchestration uses `hive_execution_prepare` and `hive_execution_finish`, followed by `hive_adhoc_merge` and `hive_adhoc_cleanup` for Git worktree placement. Manual tasks remain for full Hive DAG follow-ups. Route sequencing or scope changes back through `plan.md`, then refresh pending tasks from that graph.

For the issue-72 `3b` / `3c` scenario, treat `helperStatus` and live worktree/task state as the bounded truth surface: ask for a locally testable state or interrupted-state wrap-up summary first, create a safe manual follow-up only when it can append after the approved DAG, and amend `plan.md` instead of inventing intermediate numbering.

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
- `completed`: Terminal state; all later plan and task mutations are rejected

## hive_status Output

`hive_status` returns a JSON summary of feature state, review state, and DAG readiness.

### Top-Level Objects

- `feature.name`, `feature.status`, `feature.ticket`, `feature.createdAt`
- `plan.exists`, `plan.status`, `plan.approved`
- `overview.exists`, `overview.path`, `overview.updatedAt`
- `review.unresolvedTotal`, `review.byDocument.overview`, `review.byDocument.plan`
- `tasks.total`, `tasks.pending`, `tasks.inProgress`, `tasks.done`, `tasks.list`, `tasks.runnable`, `tasks.blockedBy`
- `context.fileCount`, `context.files[]`, `context.metadataClipped`, `context.diagnostics` — `metadataClipped` is `true` when the summary exceeded the response bound and per-file descriptive metadata was omitted. When the context summary read fails, `context` becomes `{ available: false, reason, error, hint }` with null context metrics while all other objects remain valid, `overview.exists` is derived from disk, and `hint` is reason-aware (control-state failures point to primary-management repair rather than the catalog)
- `nextAction`

### Task List Fields

Each entry in `tasks.list` includes:
- `folder` (string)
- `name` (string)
- `status` (string)
- `origin` (string)
- `summary` (string | null)
- `dependsOn` (string[] | null, raw dependency metadata from `status.json`)

### Runnable and Blocked

```
tasks.runnable   # array of task folders ready to start
tasks.blockedBy  # map: task folder -> array of unmet dependency folders
```

Rules:
- Only `done` satisfies dependencies.
- `tasks.runnable` lists task folders whose effective dependency set is fully satisfied.
- `tasks.blockedBy` maps task folders to the unmet dependency folders keeping them blocked.
- `tasks.list[].dependsOn` shows the raw stored dependency metadata; `tasks.runnable` and `tasks.blockedBy` are computed from the effective graph, which applies legacy sequential fallback only when a task record omits `dependsOn`.

Example:

```json
{
  "overview": {
    "exists": true,
    "path": ".hive/features/example/context/overview.md",
    "updatedAt": "2026-03-31T10:30:00.000Z"
  },
  "review": {
    "unresolvedTotal": 1,
    "byDocument": {
      "overview": 0,
      "plan": 1
    }
  },
  "tasks": {
    "list": [
      {"folder":"01-setup","status":"done","dependsOn":[]},
      {"folder":"02-core","status":"pending","dependsOn":["01-setup"]},
      {"folder":"03-ui","status":"pending","dependsOn":["02-core"]}
    ],
    "runnable": ["02-core"],
    "blockedBy": {
      "03-ui": ["02-core"]
    }
  }
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
Supporting context bodies do not appear in generated specs. Live catalogs provide current project and feature metadata after the child session is authenticated.

Manual-task specs derive their sections from structured metadata and may include:
- `## Goal`
- `## Description`
- `## Acceptance Criteria`
- `## Files`
- `## References`
- `## Origin`

## Session Metadata

Canonical session bindings live in project `.hive/sessions.json`. Feature-local `sessions.json` files are projections for navigation and cannot replace missing canonical provenance.

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
      "executionWorkspacePath": "/trusted/project/.hive/.worktrees/feature-a/01-first-task",
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

Task `status.json` records the current worker generation and finalized disposition from `hive_execution_finish`. `ExecutionAttempt.native` is the sole managed execution authority. Stale generated-assignment keys in older JSON are ignored rather than interpreted as authority.

Every catalog delivery and compaction replay revalidates the current runtime root and authenticated session/execution identity. Root relocation or an exact identity mismatch fails explicitly. Recovery creates a fresh attempt and child at the newly trusted root; it never edits old session or execution records in place.

Once an ad-hoc run or execution workspace is bound, ordinary session patches cannot change its root, task, feature, parent, or agent classification. Dispatch and compaction use the authenticated `ExecutionAttempt` scope. Agent-supplied metadata is never authoritative execution identity. Do not treat placeholders such as `forager-child` as live owners, and do not treat a `ses_` prefix as identity validation.

One-shot lease migration extracts leftover `sessions.json` `nativeTaskLeases`, deletes them from that file, and stores them as `nativeTaskLeaseHistory`. Exact worktree-path, non-placeholder, non-capability leases become unobserved attached ExecutionAttempt claims once with fail-closed `background: 'unknown'` unless exact board evidence classifies the launch. This is not an ongoing second admission API. Live claims live with ExecutionAttempt records, not with a lease array on `sessions.json`.

## Migration from Legacy

Previous versions used `execution/` directory with step-based JSON files.
Current version uses `tasks/` with folder-per-task structure containing
`status.json`, `spec.md`, and `report.md`.
