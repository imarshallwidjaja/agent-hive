---
name: orchestrating-ad-hoc-work
description: Use when Agent Hive Builder or a unified Hive primary coordinates ad-hoc work with multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, background execution, or expected multiple worker attempts or turns.
---

# Orchestrating Ad-Hoc Work

## Scope and Trigger

An **ad-hoc primary** is Hive Builder or a unified Hive primary coordinating authorized non-feature work. Load this skill before any ad-hoc worktree create or delegated dispatch when a request has multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, may use background execution, or may require more than one worker attempt or turn. Decomposition may retain one coherent lane; never split by file, step, or quota merely to create parallelism.

This skill owns outcome boundaries, the lane inventory, dependency waves, placement readiness, lane-level recovery coordination, result consumption, review/fix sequencing, deterministic integration, and closure. `dispatching-parallel-agents` owns fan-out mechanics. `parallel-exploration` owns read-only research fan-out. `background-delegation` owns background observation, reconciliation, cancellation, and wait-mode protocol; in ad-hoc mode it returns those outcomes here.

Ad-hoc worktrees are temporary workspace metadata only: no run history, evidence ledgers, or reports.

## Ad-Hoc Suitability

Stay ad-hoc when material scope, contracts, and risks are resolved, dependencies have concrete handoffs, and isolated runs can verify and integrate the work. Recommend feature escalation when unresolved contracts, inexpressible handoffs, migration or irreversible risk, or audit/governance needs make that workflow materially safer.

Escalation is advisory. If the operator rejects it, continue ad-hoc only when material scope, contracts, and risks are otherwise resolved. If one remains unresolved, ask that concrete blocking question and do not create workers. Routine decomposition needs no approval question.

## Build the Lane Inventory

Choose boundaries in this order:

1. Identify coherent, independently verifiable outcomes. Keep tightly coupled code, tests, documentation, and generated artifacts together.
2. Name each concrete predecessor output or capability decision. If a handoff cannot be stated, keep the work together or recommend escalation.
3. Assign one owner for each module/path and shared resource: generated outputs, external mutable resources, fixed-path test fixtures, ports, databases, and containers. Distinct worktrees do not isolate these resources; use one owner or sequence access.
4. Define done criteria, lane verification, reviews required by the active primary's configured review policy, and deterministic integration order.
5. Add dependency edges and derive ready waves only after those contracts are clear.

Record each lane's purpose, kind/owner, inputs/handoffs, path and resource ownership, done/verification/review contract, dependencies, integration order, and wait mode. Session state or `todowrite` is enough to track that. Do not create a mandatory evidence ledger.

## Waves, Dispatch, and Integration

Create only lanes whose handoffs are available, close to dispatch. Code dependencies normally require a verified, committed, integrated predecessor so the successor base contains the code. A report/decision dependency may use an inspected concrete handoff without a source revision.

Parallel writers require distinct ad-hoc `runId`s and worktrees. Writes and fix passes within one run remain sequential. Read-only Scout, advisor, and reviewer lanes need no artificial worktree; reviews target settled source state.

For each ready wave, emit all independent launches in the same assistant message. Blocking is a wait mode, not serial scheduling. Use `dispatching-parallel-agents` for launch mechanics and `background-delegation` when background wait mode is available.

The ad-hoc primary owns merge and cleanup. Lane changes receive the reviews required by the active primary's configured review policy; this skill adds no separate reviewer-approval gate. Required review and lane verification each gate merge. Integrate accepted lanes in stable topological order, using inventory order to break ties. Schedule shared fixtures, ports, databases, containers, external resources, and canonical verification so separate processes cannot collide. Run full canonical verification once against the integrated batch.

Use `hive_adhoc_worktree_create`, `hive_adhoc_worktree_inspect`, `hive_adhoc_worktree_merge`, and `hive_adhoc_worktree_cleanup`. A legacy single-root worker returns `sourceCommit`; a composite worker returns the complete `sourceCommits` map keyed by persisted repository ID. A singleton composite also accepts a matching scalar convenience; multiple repositories require the complete map. Pass that topology-aware pin unchanged to merge. Git helpers do not auto-commit source or assign workers.

## Closure

A lane closes only after applicable terminal observation, result consumption, required review and lane verification, merge or an explicit no-change/discard decision, and cleanup are recorded. The batch closes only after every lane is closed and the full integrated canonical verification result is recorded and passing.
