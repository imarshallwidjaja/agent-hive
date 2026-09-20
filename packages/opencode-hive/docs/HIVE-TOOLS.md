# Hive Tools Inventory

Tool availability plus instructions govern action. Each tool validates its own operation.

## Feature Management (3 tools)

| Tool | Purpose |
|------|---------|
| `hive_feature_create` | Create new feature, set as active |
| `hive_feature_complete` | Mark feature completed (irreversible) |
| `hive_feature_select` | Set `{ feature }` as the active selection, or `{ feature: null }` to clear with no fallback |

| Call | Effect |
|------|--------|
| `hive_feature_select({ feature })` | Set the active feature that routes context and constraints |
| `hive_feature_select({ feature: null })` | Clear it with no fallback |
| explicit `feature` on a feature-scoped tool | May select the current feature for that call |

Child capture is fixed at dispatch.

## Repository Manifest (3 tools)

| Tool | Purpose |
|------|---------|
| `hive_repositories_status` | Inspect project repository mode and `.hive/repositories.json` |
| `hive_repositories_discover` | Discover in-workspace git repositories without mutating the manifest |
| `hive_repositories_update` | Add project-relative repositories to `.hive/repositories.json` atomically; matching legacy global topology is migration-only |

Single-repo projects use the normal git-root path. Agents should add only repositories they have decided to work in. Discovery is bounded to the project root, depth 4, and 50 candidates, and skips `.git`, `.hive`, `.opencode`, `node_modules`, build outputs, coverage, and temp folders. Updates are add-only.

## Plan Management (4 tools)

| Tool | Purpose |
|------|---------|
| `hive_plan_write` | Write or replace the full plan.md for initial plans and major rewrites (execution truth; clears plan review comments) |
| `hive_plan_patch` | Patch bounded plan sections/tasks with `expectedRevision` from `hive_plan_read`; clears plan review comments, revokes approval, and does not sync tasks |
| `hive_plan_read` | Read plan.md and related review comments, including revision/hash; use `mode: "outline"` when full content is not needed |
| `hive_plan_approve` | Approve plan for execution |

If task sequencing, dependencies, or scope changed after a patch, run `hive_tasks_sync({ refreshPending: true })` explicitly after review/approval.

Plans, approval, and dependencies guide work and status visibility. They are not dispatch or status admission gates. Structural missing refs and cycles remain invalid.

## Task Management (3 tools)

| Tool | Purpose |
|------|---------|
| `hive_tasks_sync` | Generate tasks from approved plan, or refresh pending plan-backed tasks with `refreshPending: true` after a plan amendment |
| `hive_task_create` | Create manual task (not from plan) with explicit `dependsOn` and optional structured metadata |
| `hive_task_update` | Optional `status`, `summary`, `blocker`, and `report` string. Omissions are preserved |

Plan-backed tasks get their DAG from `plan.md` `Depends on:` annotations during `hive_tasks_sync`. Modern plans sync numbered task headings only from the `## Tasks` section. A pure final verification checklist belongs in `## Final Verification` unless it writes tracked artifacts.

`report` is a string stored as numeric history plus latest. An explicit status leaving blocked clears the blocker. Partial writes: inspect before retry; there is no journal.

Manual tasks are append-only. Explicit manual dependencies are only for isolated follow-up work that already depends on finished tasks; dependencies on unfinished work require plan amendment.

## Recovery fields and failure classification

Worktree and merge results carry the same recovery classification fields, added alongside all existing fields rather than replacing them. They describe where an operation stopped and what the caller may safely do next; a `NO_TRACKED_CHANGES` no-op also carries them, with `action: 'none'`.

| Field | Meaning |
|------|---------|
| `phase` | Where the operation stopped: `validation`, `preflight`, `integration`, `rollback`, `verification`, or `cleanup`. |
| `reasonCode` | Stable uppercase code naming the condition. |
| `mutation` | Durable target state relative to the operation's starting state: `none`, `applied`, `partial`, `preserved`, or `unknown`. Cleanup itself never changes this value. |
| `retryable` | True only when the exact same tool call may be repeated after satisfying the reported prerequisite and no durable target mutation occurred from this attempt. |
| `action` | The conservative recovery step: `correct_arguments`, `clean_target`, `resolve_conflicts`, `inspect_state`, `retry_same_operation`, `cleanup_only`, `start_fresh_run`, `manual_recovery`, or `none`. |

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
- `filesChanged` on a successful integration is the observed difference between the target HEAD immediately before integration and the target HEAD after integration. Composite results flatten entries as `repoId:path`.
- Cleanup results report per-step status for worktree removal, branch deletion, and prune using `not_requested`, `not_attempted`, `already_absent`, `succeeded`, or `failed`, plus a `failures` list.
- `COMPOSITE_PARTIAL` means at least one repository was integrated and a later repository failed. Earlier repositories remain integrated. There is no rollback of partial composite outcomes.
- When integration succeeds and requested cleanup does not fully complete, the result reports `CLEANUP_FAILED` with `action: 'cleanup_only'`. Repeat only the cleanup step.

## Worktree families (8 tools)

Public names are fixed. Git helpers do not change task status, auto-commit source, or assign workers.

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

Canonical workspace names are metadata. Existing slotted or composite workspaces are selectable. Merge wants a clean source and dest pinned SHA, squash default, and an explicit message. Locks are operation-local. Dirty, untracked, ignored, and unmerged data is protected; there is no force or rm fallback. Same-call squash cleanup may use observed identity; later ambiguous branches stay unless `discard: true` is explicit. `deleteBranch` alone does not discard an unmerged branch.

Stable public inputs:

| Tool | Inputs |
|------|--------|
| `hive_worktree_create` | `task`; optional `feature`, `baseRef`, `repoIds`, `candidate` |
| `hive_worktree_inspect` | `task`; optional `feature`, `repoIds`, `candidate` |
| `hive_worktree_merge` | `task`; required `expectedTarget` or `expectedTargets`; optional `feature`, `repoIds`, `candidate`, `strategy`, `message`, `cleanup`, `sourceCommit`, `sourceCommits` |
| `hive_worktree_cleanup` | `task`; optional `feature`, `repoIds`, `candidate`, `deleteBranch`, `discard` |
| `hive_adhoc_worktree_create` | optional `runId`, optional `repoIds`, optional absolute `sourceDirectory` |
| `hive_adhoc_worktree_inspect` | `runId`, optional `repoIds`, optional absolute `sourceDirectory` |
| `hive_adhoc_worktree_merge` | `runId`; required `expectedTarget` or `expectedTargets`; optional `repoIds`, absolute `sourceDirectory`, `strategy`, `message`, `cleanup`, `sourceCommit`, `sourceCommits` |
| `hive_adhoc_worktree_cleanup` | `runId`, optional `repoIds`, optional absolute `sourceDirectory`, plus `deleteBranch`, `discard` |

`cleanup` is `'none' | 'worktree' | 'worktree+branch'`. `preserveConflicts` defaults to `false`. Do not provide a non-blank `message` with `strategy: 'rebase'`. Failed integrations restore the target unless an actual conflict is explicitly preserved. A preserved conflict leaves an active Git operation in the destination checkout; do not call merge again while that state is active.

Ad-hoc worktrees are temporary workspace metadata only: no run history, evidence ledgers, or reports.

On creation, `repoIds` selects the repositories owned by the lane. Later feature-task lifecycle calls validate `repoIds` against the task's persisted repository selection; later ad-hoc lifecycle calls use `runId` to locate the persisted placement. `sourceDirectory` selects a foreign checkout and cannot be combined with `repoIds`. For create, an absolute path resolving to the active project root is treated as omitted, so it may be supplied with project/manifest `repoIds`.

Use `sourceCommit` for a legacy single-root workspace. When persisted `repos` are present, use `sourceCommits` as a complete map keyed by persisted repository ID. A singleton composite also accepts a matching scalar `sourceCommit` convenience; multiple repositories still require the complete map. Pass the worker's topology-aware pin unchanged. The merge tool rejects a map for a legacy single-root workspace, a scalar for a multi-repository composite, both pin forms together, and any supplied pin that differs from the inspected candidate.

Inspect also returns destination state. A legacy result has top-level `target` and `comparison`; composite results put them only under `repos[repoId]`. `target` is `{ path, ref, commit }`, where `path` is the canonical absolute destination root, `ref` is the full `refs/heads/...` name or `null` when detached, and `commit` is the full OID. If destination identity cannot be read, inspect retains source details and returns `target: null` with `comparison.status: 'error'`. Comparison is one of `{ status: 'ok', targetIsAncestorOfSource }`, `{ status: 'no-common-ancestor' }`, or `{ status: 'error', error }`. A shallow repository may therefore report locally no common ancestry; inspect never fetches and ancestry does not establish semantic completeness.

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

The board observes the originating native parent and call, not the current feature or agent. Stale and unknown observations stay visible. It does not couple to execution, worktree, or task status. Multiple launch observations may exist for one native task identity when explicit runtime-owned interruption recovery is used. If completion lacks a call ID or its identity is ambiguous, record unknown and hint `hive_task_trace`; never guess the latest child. Missing or ambiguous completion identity must not block unrelated dispatch, but ownership-overlapping work still requires inspection or waiting; do not send another prompt or launch another writer.

With the env gate unset, the background management tools return `background_tools_disabled`. Primary agents keep normal blocking `task()` wait mode. With the env gate set, primary orchestrators receive delegate-first background scheduling guidance and the board tools are active.

`hive_background_status` and reconcile responses include `recommendedNextAction` guidance and may set `requiresHiveStatusRefresh` after reconciliation. Treat these as board-local scheduler hints.

If `hive_background_status` returns `schedulerGuidance.reason: wait_for_native_completion_notification`, do not refresh repeatedly. Wait for OpenCode's native completion notification.

Cancellation is not rollback. Cancel acknowledgement does not prove the worker stopped. Do not invent native task IDs. Reconcile and ignore archive board rows only.

## Runtime Session Inspection (2 tools)

These primary-orchestrator-only tools inspect any explicitly identified OpenCode session visible through the connected runtime. Authorization uses a fresh `session.get` and requires a well-formed record whose ID exactly matches `task_id`. Trace is read-only bounded native identity and freshness, not an allowance.

| Tool | Purpose |
|------|---------|
| `hive_task_trace` | Read one runtime-visible session as a compact complete v2 situation report; optionally request turn-scoped recovery |
| `hive_task_trace_content` | Re-read and verify one allowlisted non-reasoning source field referenced by a v2 content ID |

Trace inspection never resumes, aborts, retries, polls, or mutates the inspected session.

```text
hive_task_trace({ task_id: "child" })
```

If semantic recovery would help build a fresh handoff, call `hive_task_trace({ task_id: "child", recovery: true })`. Recovery remains untrusted and never authorizes continuation. Every returned task result is terminal, so follow-up work uses a fresh child session and may reuse the same Hive task/worktree. Primaries must not pass `task_id` or infer eligibility from task output, trace, `idle_and_closed`, board state, cancellation acknowledgement, or transcript quality. Pass `task_id` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation; otherwise launch fresh. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer.

Omitted or false `recovery` preserves the deterministic compact forensic v2 shape. Its 24 KiB soft target is advisory, not a cap. Irreducible larger reports stay `ok: true`; `render.actual_bytes` is exact.

A missing target entry in a valid map means idle because OpenCode removes idle entries; an unavailable or invalid map is uncertain. `idle_and_closed` means only that the observed turn finished.

Semantic output is always `untrusted: true`. Generated `source_steps` arrays are sorted context source coverage, not evidence or proof. Never accept, merge, retry, resume, or auto-run from recovery output.

Configure optional recovery interpretation under global `taskTraceSummarizer` (`model`, `variant`, `temperature` 0–2). Operator reference: [Task trace summarizer](../README.md#task-trace-summarizer).

## Context (4 tools)

| Tool | Purpose |
|------|---------|
| `hive_context_read` | Read a scoped summary, bounded durable catalog, or chunked exact document |
| `hive_context_write` | Explicitly create a scoped file, or replace one whole document with revision and hash preconditions |
| `hive_context_append` | Append a dated block while preserving prior bytes and checking revision plus content hash |
| `hive_context_archive` | Selectively archive named files with a reason, revision, and per-name hashes |

Omitted `scope` retains feature-default behavior. Use `scope: "project"` explicitly for `.hive/context/`. Tool scope selects data. Foragers and reviewers write feature and project context through revision and content-hash checks. Scouts are read-only. Archive is primary-only.

With no `name`, `hive_context_read` defaults to `view: "summary"`. Use `view: "catalog"` with optional literal `query`, `limit`, and returned `cursor` for durable metadata discovery. Named reads accept `cursor` and `maxBytes`, return `range: { startByte, endByte, totalBytes }`, `complete`, and `nextCursor`. `maxBytes` defaults to 16 KiB and cannot exceed 64 KiB.

Call `hive_context_read` before replacement, append, or archive. Existing-content mutations require the current revision and actual SHA-256 `contentHash`. Non-reserved files default to `durable`. Mark raw logs and historical verification material as `evidence`. Feature hygiene warnings begin above 8 durable files or 40,000 UTF-16 code units; project warnings begin above 32 files or 160,000 units. These are review signals, not aggregate admission limits.

`overview`, `draft`, and `execution-decisions` are reserved and excluded from execution context. They do not accept a caller-provided `kind`. Plan approval does not archive `draft`. Archive an obsolete draft explicitly after approval.

## Operator Constraints (4 tools)

| Tool | Purpose |
|------|---------|
| `hive_constraints_read` | Read entries, stable IDs, aggregate text, and revision |
| `hive_constraints_add` | Add one verbatim directive without replacing unrelated entries |
| `hive_constraints_edit` | Replace or explicitly remove one entry by ID and expected revision |
| `hive_constraints_clear` | Clear the whole register by expected revision after an explicit operator request |

Scope is `session` (default) or `feature`. Add only durable operator directives, not every user message, example, or task-local request. Store the operator's own wording. Call `hive_constraints_read` before correcting or removing an entry. Call `hive_constraints_clear` only when the operator explicitly requests a whole-register clear. Blank additions and replacements, missing IDs, stale revisions, and aggregate content over 8000 UTF-16 code units are rejected. Identical repeated additions are idempotent.

Only primaries can add, edit, or clear constraints. Workers receive the injected register and may read it. That is tool exposure, not a semantic runtime gate. Inherited session and feature labels travel with every child captured at dispatch, including review children. If they conflict, the agent surfaces the conflict. Do not promote context files into constraints.

## Status (1 tool)

| Tool | Purpose |
|------|---------|
| `hive_status` | Get comprehensive feature status as JSON, including overview metadata, per-document review counts, context inclusion flags, and task/worktree-aware merge eligibility |

When the managed context summary read fails, `hive_status` degrades instead of failing. Background board state is intentionally separate. Reconcile terminal background jobs first, then refresh `hive_status` before making dependent task or merge decisions.

## Snapshot

`hive_git_snapshot` is a low-level diagnostic with an optional `directory` for a foreign checkout. It returns a versioned `hive-git-snapshot/v1` envelope: `ready` with `consistency: "validated"`, or `failed` with structured codes, phases, and retry semantics. Capture is bracketed by a generation check that fails with `SOURCE_DRIFT`. One 15-second operation deadline covers the whole capture.

Caller-supplied `maxFiles` (cap 200) and `maxPatchBytes` (cap 256 KiB) are clamped. A composite snapshot set is all-or-error.

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

Feature-scoped tools resolve an omitted feature in this order: current task worktree/path, current session binding, then the sole live feature. `hive_feature_select` and an explicit `feature` argument may select the current feature. If multiple live features remain, the tool returns their logical names without mutating any feature. Retry with the explicit `feature` or `name` argument. If no live feature exists, create one with `hive_feature_create`.

## Reserved Overview Convention

- There is no dedicated overview write tool.
- Use `hive_context_read({ feature: "feature-name", name: "overview" })` through all returned chunks first, then pass the current revision and `file.contentHash` to `hive_context_write`.
- Humans review `context/overview.md` first; `plan.md` stays authoritative for execution and task parsing.
- `hive_status` and the VS Code extension surface the overview as the primary human-facing document.
