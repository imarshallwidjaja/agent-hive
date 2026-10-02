# Runtime layout

Everything below is relative to the project root, the directory that holds `.hive/`. In a composite or ad-hoc worktree, the project root is the canonical checkout, not the worktree.

## `.hive/` tree

```
.hive/
├── agent-hive.override.json   optional project model/variant override (see configuration.md)
├── repositories.json          optional multi-repo manifest
├── sessions.json              session bindings, selected feature route, session constraints
├── background-jobs.json       background board: observational bookkeeping only
├── context/                   project-scope managed context
│   ├── index.json             revisioned control index
│   └── <name>.md
├── archive/context/           archived project context
├── features/
│   └── <NN>_<feature-name>/   indexed feature directory
│       ├── feature.json       name, status, createdAt; optional ticket, sessionId, approvedAt, completedAt, archivedAt, archiveReason
│       ├── plan.md            plan; `## Tasks` holds `### N. Title` task sections
│       ├── APPROVED           approval marker file
│       ├── comments/plan.json plan review threads (`comments.json` is a legacy fallback)
│       ├── constraints.json   feature-scoped operator constraints
│       ├── sessions.json      feature-local navigation projection, not canonical
│       ├── context/           feature-scope managed context (index.json + <name>.md)
│       ├── archive/context/   archived feature context
│       └── tasks/
│           └── <NN-task-name>/
│               ├── status.json   task state, dependsOn, repoIds, summary, blocker, metadata
│               ├── spec.md       generated worker spec
│               ├── report.md     latest successful report write
│               ├── reports/<N>.md numbered report history; N is write order, not author
│               └── handoff.md    latest successor note, at most 2048 UTF-8 bytes
├── .worktrees/                Hive-managed Git worktrees (see below)
└── .operation-locks/          per-repository operation locks
```

Files that no current code reads, such as `execution-attempts.json`, lease files, or other leftovers from older versions, are legacy. Do not treat them as current state.

Lock files sit beside the file they guard as `<file>.lock` and hold the holder's `pid` and `timestamp`. A lock that outlives its owner needs manual operator recovery; agents report it rather than delete it.

## Features

- Tools address features by **logical name** (`[A-Za-z0-9][A-Za-z0-9_-]*`). New directories are `<NN>_<name>` with a zero-padded index one above the current maximum.
- Resolution: an exact directory-name match wins; otherwise the directory whose `feature.json` `name` (or the suffix after `NN_` / `NN-`) equals the logical name. Older unprefixed directories stay readable.
- Feature statuses: `planning`, `approved`, `executing`, `completed`, `archived`. A completed feature cannot be reopened.
- Approval writes `APPROVED` before updating `feature.json`, so a marker can exist while `feature.json` still says `planning` after a failed write. `hive_plan_approve` reports this through `approvalPersisted` and `stage`; the fix is a retry through the tool, not an edit.

## Tasks

- Task folders are `<NN>-<slug>`. The folder number does not imply a dependency; `status.json` `dependsOn` is the stored graph, and for plan-backed tasks `plan.md` is its source.
- Task statuses: `pending`, `in_progress`, `done`, `blocked`, `failed`, `partial`, `cancelled`. Only `done` satisfies a dependency.
- `hive_task_update({ report })` writes, in order, `reports/<N>.md`, then `report.md`, then `handoff.md` (when supplied), then `status.json`. After a failure, any prefix may already be published: inspect the files before retrying and never resubmit a report already in history.
- Report bodies never live in `status.json`. Read `report.md` for the latest and `reports/` for history. Current agent prompts require writers to open with an attribution line naming the author role and basis, but `hive_task_update` stores the text unchanged and does not enforce it. Treat a report whose first line is missing or is not an attribution line as unattributed.

## Context

- Feature context: the feature directory's `context/`. Project context: `.hive/context/`.
- `index.json` carries `schemaVersion: 1`, a monotonic `revision`, and per-name `kind` (`durable` or `evidence`).
- `overview`, `draft`, and `execution-decisions` are reserved names, outside the durable catalog.
- `.managed-mutation-pending.json` in a context directory means an interrupted publication. Context tools then return `context_reconciliation_required`; recovery is an operator procedure.
- Read and mutate through `hive_context_*`; the `context-engineering` skill owns how.

## Worktrees and branches

| Placement | Directory | Branch |
|---|---|---|
| Feature task, single root | `.hive/.worktrees/<feature>/<task>` | `hive/<feature>/<task>` |
| Feature task with candidate | `.hive/.worktrees/<feature>/<task>--<candidate>` | `hive/<feature>/<task>-<candidate>` |
| Feature task, composite | `.hive/.worktrees/<feature>/<task>/repos/<repoId>` | `hive/<repoId>/<feature>/<task>` |
| Ad-hoc, single root | `.hive/.worktrees/adhoc/<runId>` | `hive/adhoc/<runId>` |
| Ad-hoc, composite | `.hive/.worktrees/adhoc/<runId>/repos/<repoId>` | `hive/adhoc/<repoId>/<runId>` |

- `<feature>` is the name the create call received, normally the logical name. Older placements can differ, so take the path from inspect or status output.
- Single-root workspace metadata is a sidecar file beside the worktree: `<task>.json` or `adhoc/<runId>.json`, recording mode, paths, branch, and `baseCommit`.
- Composite roots contain `workspace.json` and one worktree per selected repository under `repos/<repoId>/`.
- Ad-hoc runs create no feature or task records and do not appear in `hive_status`. They have no run history or reports.
- The `adhoc` and `review` directory names under `.worktrees/` are not features.

## Repository manifest

`.hive/repositories.json` holds `{ "schemaVersion": 1, "repositories": [{ "id": "api", "path": "./api" }] }`. Paths are relative to and contained by the project root. Single-repository projects need no manifest. Manage it with `hive_repositories_status`, `hive_repositories_discover`, and `hive_repositories_update`. Global `repositoryRoot` and `repositories` in `agent_hive.json` are migration-only legacy fields.

## Sessions and constraints

`.hive/sessions.json` holds canonical session bindings: selected feature route (`featureName`, where explicit `null` means featureless), parent session, task folder, and session constraints with a `standingConstraintsRevision`. Feature constraints live in the feature's `constraints.json`. `sessions.json` is not a trace source.

If `.hive/sessions.json` is not valid JSON, the first read or update of the session index copies the bytes to `sessions.json.corrupt-<timestamp>` and writes `{ "sessions": [] }`; an update then writes its own change on top. That discards every saved route and standing constraint. Triggers include:

- The host's `chat.message` hook, which records the session whenever a message carries an agent. The file is left holding only that one session.
- Route resolution in any feature-scoped tool called without an explicit `feature`, such as `hive_status()`, as well as feature selection, constraint tools, and native `task()` dispatch, which captures the route.

So read `.hive/sessions.json` directly, with a shell or file read, before any session-resolving call. If it does not parse, or a `sessions.json.corrupt-*` sibling exists, report both paths to the primary or operator, who decides how to restore it. An empty or one-session index next to a `corrupt-*` copy is reset damage, not intentional state. Until the operator decides, avoid session-resolving calls; when you need a feature-scoped read, pass `feature` explicitly.

## Background board

`.hive/background-jobs.json` records background `task()` launches (`schemaVersion: 1`, `jobs[]` with native `taskId`, `sessionId`, `alias`, `runtimeState`). It observes the originating parent and call, not feature or task status, and never tracks foreground calls. Archive and cancel acknowledgements do not prove a worker stopped. Agents never edit it; `background-delegation` owns the protocol.

## Integrity signals

| Signal | Meaning | What to do |
|---|---|---|
| `hive_status` task entry with `status: null` and `integrity.reason: status_missing` | Task folder exists but `status.json` is missing | Not runnable and cannot satisfy dependencies. Report it; the primary repairs records before execution |
| `integrity.reason: status_unreadable` (with `error`) | `status.json` is corrupt or unreadable | Same |
| `worktreeErrors: [{ path, reason }]` | A worktree directory or namespace failed validation (missing `workspace.json`, symlink, bad registration) | Preserve the directory. Healthy entries remain usable. The primary or operator follows manual orphan recovery |
| `specFreshnessError` | The freshness check failed for the whole feature; every task reports `freshness_unavailable` | Treat spec/plan comparison as unknown; report it |
| `unownedTaskHeadings` | An unnumbered `###` sits inside `## Tasks` | Plan repair by the planner; approval blocks until fixed |
| `context_reconciliation_required` | Interrupted context publication marker present | Stop context mutation; report |
| `context_index_invalid` | Context `index.json` invalid | Stop context mutation; report. Do not delete the index |
| `Failed to acquire lock <path>.lock ... Manual recovery is required` | Lock held, possibly by a dead process | Report holder pid and path; do not delete |

### Spec freshness (`specStaleReason`)

Every `hive_status` task carries `specStale` (`true`, `false`, or `null` when no comparison ran) and one `specStaleReason`:

| Reason | Meaning | What governs the task |
|---|---|---|
| `matches_plan` | `specStale: false`. The stored `spec.md` equals what the current plan section generates | Plan section and spec agree; use either |
| `differs_from_plan` | `specStale: true`. The stored spec differs from the current plan section (plan edit, older generator, or hand-edited spec) | The current plan section governs. Return scope, repository, or dependency changes to the primary |
| `manual_task` | Created with `hive_task_create`; no plan section exists | The manual `spec.md` is the task contract |
| `unowned_heading_after_task_section` | An unnumbered `###` follows the task's section; `unownedHeadingLines` lists it | Neither record governs. Escalate for plan repair |
| `plan_missing` | The feature has no `plan.md` | Neither record governs. Report the uncomparable records |
| `plan_invalid` | `plan.md` does not parse or has an invalid dependency graph | Same |
| `task_not_in_plan` | No plan task matches this folder | Same |
| `spec_missing` | The task resolves in the plan but has no `spec.md` | Same |
| `freshness_unavailable` | Added by `hive_status` when the check failed (`specFreshnessError` is set) | Same |

Read-only orphan diagnosis, safe for any role with shell access. Find owning repository roots from `.hive/repositories.json` and the task's `repoIds`; run Git against a repository root or a per-repository worktree, never against a non-Git project root or composite root:

```bash
git -C "<repository-root>" worktree list --porcelain
git -C "<worktree-path>" --no-optional-locks status --short --ignored
git -C "<repository-root>" branch --list 'hive/*'
```

`--no-optional-locks` keeps `status` from refreshing the index and taking `index.lock`. Never run `checkout`, `reset`, `clean`, `stash`, `worktree remove`, `worktree prune`, or `branch -d` while diagnosing. Removing registrations, branches, or directories is a primary or operator action. It requires the work to be integrated or deliberately preserved first.
