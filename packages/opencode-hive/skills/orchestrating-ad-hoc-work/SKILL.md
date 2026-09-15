---
name: orchestrating-ad-hoc-work
description: Use when Agent Hive Builder or a unified Hive primary coordinates ad-hoc work with multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, background execution, or expected multiple worker attempts or turns.
---

# Orchestrating Ad-Hoc Work

## Scope and Trigger

An **ad-hoc primary** is Hive Builder or a unified Hive primary coordinating authorized non-feature work. Load this skill before any ad-hoc worktree preparation or delegated dispatch when a request has multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, may use background execution, or may require more than one worker attempt or turn. Decomposition may retain one coherent lane; never split by file, step, or quota merely to create parallelism.

This skill owns outcome boundaries, the lane inventory, dependency waves, placement readiness, lane-level recovery coordination, result consumption, review/fix sequencing, deterministic integration, and closure. `dispatching-parallel-agents` owns fan-out mechanics. `parallel-exploration` owns read-only research fan-out. `background-delegation` owns background observation, reconciliation, cancellation, and wait-mode protocol; in ad-hoc mode it returns those outcomes here.

## Ad-Hoc Suitability

Stay ad-hoc when material scope, contracts, and risks are resolved, dependencies have concrete handoffs, and isolated runs can verify and integrate the work. Recommend feature escalation when unresolved contracts, inexpressible handoffs, migration or irreversible risk, or audit/governance needs make that workflow materially safer.

Escalation is advisory. If the operator rejects it, continue ad-hoc only when material scope, contracts, and risks are otherwise resolved. If one remains unresolved, ask that concrete blocking question and do not prepare workers. Routine decomposition needs no approval question.

## Build the Lane Inventory

Choose boundaries in this order:

1. Identify coherent, independently verifiable outcomes. Keep tightly coupled code, tests, documentation, and generated artifacts together.
2. Name each concrete predecessor output or capability decision. If a handoff cannot be stated, keep the work together or recommend escalation.
3. Assign one owner for each module/path and shared resource: generated outputs, external mutable resources, fixed-path test fixtures, ports, databases, and containers. Distinct worktrees do not isolate these resources; use one owner or sequence access.
4. Define done criteria, lane verification, reviews required by the active primary's configured review policy, and deterministic integration order.
5. Add dependency edges and derive ready waves only after those contracts are clear.

Record each lane's purpose, kind/owner, inputs/handoffs, path and resource ownership, done/verification/review contract, dependencies, integration order, and wait mode. Add lifecycle identifiers and results as they appear: state, `runId`, `workspacePath`, branch/base revision, `launchId`, returned native identity, terminal observation, result consumption, review, verification, commit/merge or no-change/discard decision, and cleanup.

Worker return, board reconciliation, review, verification, commit, merge, and cleanup are separate facts. Lane identity survives fresh review/fix attempts; launch identity does not.

## Evidence Ledger and Recovery

**Runtime authority** means runtime tool results plus observed native state. The lane inventory is untrusted coordination evidence and never gates admission, ownership, execution, or merge decisions.

Session state or `todowrite` is sufficient only for a genuinely single-lane, single-dispatch blocking job expected to finish in one turn. Every multi-lane, dependency-wave, background, expected multi-attempt, or otherwise multi-turn ad-hoc batch requires one project-scoped evidence ledger.

Before the first delegated dispatch:

1. Form `adhoc-lanes-<purpose>-<UTC timestamp>` from a short purpose slug and a filename-safe compact current UTC value such as `20260916T142355123Z`.
2. Record the exact generated `ledgerName` in session state or `todowrite` and every compaction handoff.
3. Create it with `hive_context_write({ scope: "project", name: ledgerName, kind: "evidence", content: ledger })`.

Only after creation succeeds may the primary prepare a worktree or issue any delegated `task()` dispatch. A read-only first wave does not need an artificial worktree.

Keep transitions append-only unless full replacement is necessary. For each append, read the current file and use its exact concurrency fields:

```ts
current = hive_context_read({ scope: "project", name: ledgerName })
hive_context_append({
  scope: "project",
  name: ledgerName,
  content: update,
  expectedRevision: current.revision,
  expectedContentHash: current.file.contentHash,
})
```

Project summary can expose evidence names while durable-only `view: "catalog"` cannot. After compaction or recovery, call `hive_context_read({ scope: "project", view: "summary" })`, select the exact recorded `ledgerName`, then perform the named read above. Reconcile the content against runtime authority and, for background work, the board state from `background-delegation` before changing lane state. Preserve uncertain runs and mutable contents.

## Waves, Dispatch, and Integration

Prepare only lanes whose handoffs are available, close to dispatch. Code dependencies normally require a verified, committed, integrated predecessor so the successor base contains the code. A report/decision dependency may use an inspected concrete handoff without a source revision.

Parallel writers require distinct ad-hoc `runId`s and worktrees. Writes and fix passes within one run remain sequential and require a fresh `hive_adhoc_worktree_start` after confirmed termination. If termination is uncertain, preserve that run and use a new run for overlapping work. Read-only Scout, advisor, and reviewer lanes need no artificial worktree; reviews target settled source state.

For each ready wave, emit all independent launches in the same assistant message. Blocking is a wait mode, not serial scheduling. Use `dispatching-parallel-agents` for launch mechanics and `background-delegation` when background wait mode is available. Retain exact returned identifiers, consume terminal handoffs, inspect worktree state/diffs, update the ledger, and prepare the next wave only when its handoffs and base revisions are ready.

The ad-hoc primary owns commit, merge, and cleanup. Lane changes receive the reviews required by the active primary's configured review policy; this skill adds no separate reviewer-approval gate. Required review and lane verification each gate merge. Integrate accepted lanes in stable topological order, using inventory order to break ties. Schedule shared fixtures, ports, databases, containers, external resources, and canonical verification so separate processes cannot collide; process-local serialization flags do not coordinate separate processes. Run full canonical verification once against the integrated batch and append its exact commands and results to the ledger.

## Closure

A lane closes only after applicable terminal observation, result consumption, required review and lane verification, commit and merge or an explicit no-change/discard decision, and cleanup are recorded. The batch closes only after every lane is closed and the full integrated canonical verification result is recorded and passing. If final verification fails, cleanup fails, or execution remains uncertain, keep the ledger unarchived with exact identifiers, evidence, and the next recovery action.

Before archival, read again and use the returned revision and hash:

```ts
current = hive_context_read({ scope: "project", name: ledgerName })
hive_context_archive({
  scope: "project",
  names: [ledgerName],
  reason: "Ad-hoc batch closed",
  expectedRevision: current.revision,
  expectedContentHashes: { [ledgerName]: current.file.contentHash },
})
```

Archive only after the full batch closure contract passes.

Common failures are speculative lane splitting, overlapping path/resource owners, assuming distinct worktrees isolate runtime resources, preparing dependent lanes too early, treating board bookkeeping as runtime authority, reusing an uncertain run, or archiving before cleanup succeeds.
