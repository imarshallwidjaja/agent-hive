---
name: orchestrating-ad-hoc-work
description: Use when an execution primary coordinates onward delivery, or Agent Hive Builder or a unified Hive primary coordinates ad-hoc work with multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, background execution, or expected multiple worker attempts or turns.
---

# Orchestrating Ad-Hoc Work

## Scope and Trigger

An **ad-hoc primary** is Hive Builder or a unified Hive primary coordinating authorized non-feature work. Any execution primary uses Closure for onward delivery. An ad-hoc primary loads this skill before any ad-hoc worktree create or delegated dispatch when a request has multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, may use background execution, or may require more than one worker attempt or turn. Decomposition may retain one coherent lane; never split by file, step, or quota merely to create parallelism.

This skill owns outcome boundaries, the lane inventory, dependency waves, placement readiness, lane-level recovery coordination, result consumption, review/fix sequencing, deterministic integration, and closure. `dispatching-parallel-agents` owns fan-out mechanics. `parallel-exploration` owns read-only research fan-out. `background-delegation` owns background observation, reconciliation, cancellation, and wait-mode protocol; in ad-hoc mode it returns those outcomes here.

Ad-hoc worktrees are temporary workspace metadata only: no run history, evidence ledgers, or reports. The one exception is the integration receipt a merge writes under `.hive/provenance/integrations/`, which links each resulting commit to its run and records nothing else about the run.

## Ad-Hoc Suitability

Stay ad-hoc when material scope, contracts, and risks are resolved, dependencies have concrete handoffs, and isolated runs can verify and integrate the work. Recommend feature escalation when unresolved contracts, inexpressible handoffs, migration or irreversible risk, or audit/governance needs make that workflow materially safer.

Escalation is advisory. If the operator rejects it, continue ad-hoc only when material scope, contracts, and risks are otherwise resolved. If one remains unresolved, ask that concrete blocking question and do not create workers. Routine decomposition needs no approval question.

## Build the Lane Inventory

Choose boundaries in this order:

1. Identify coherent, independently verifiable outcomes. Keep tightly coupled code, tests, documentation, and generated artifacts together.
2. Name each concrete predecessor output or capability decision. If a handoff cannot be stated, keep the work together or recommend escalation.
3. Assign one owner for each module/path and shared resource: generated outputs, external mutable resources, fixed-path test fixtures, ports, databases, and containers. Distinct worktrees do not isolate these resources; use one owner or sequence access.
4. Define done criteria, the claim each lane proves with its focused checks and affected consumers under the Scoped Claims rules in `verification`, binding repository/operator checks, required early or pre-merge gates, lane verification, reviews required by the active primary's Review Routing, and deterministic integration order. Name any integrated-only obligation in the lane/todo inventory with its owner, prerequisite, command, and expected signal.
5. Add dependency edges and derive ready waves only after those contracts are clear.

Record each lane's purpose, kind/owner, inputs/handoffs, path and resource ownership, done/verification/review contract, dependencies, integration order, and wait mode. Session state or `todowrite` is enough to track that. Do not create a mandatory evidence ledger.

## Waves, Dispatch, and Integration

Create only lanes whose handoffs are available, close to dispatch. Code dependencies normally require a verified, committed, integrated predecessor so the successor base contains the code. A report/decision dependency may use an inspected concrete handoff without a source revision.

Parallel writers require distinct ad-hoc `runId`s and worktrees. Writes and fix passes within one run remain sequential. Read-only Scout, advisor, and reviewer lanes need no artificial worktree; reviews target settled source state. An Investigator lane follows the primary's Experiments method: a source-based judgment needs no placement, and a run that changes source gets its own disposable placement. It produces evidence, not commits, so it closes by cleanup and never enters the integration order.

For each ready wave, emit all independent launches in the same assistant message. Blocking is a wait mode, not serial scheduling. Use `dispatching-parallel-agents` for launch mechanics and `background-delegation` when background wait mode is available.

The ad-hoc primary owns merge and cleanup. Lane changes receive the reviews required by the active primary's Review Routing; this skill adds no separate reviewer-approval gate. Apply the primary's Review Follow-Up guidance to settled lane reviews before remediation and closure: accept supported material corrections, resolve material questions, and preserve usable unaffected review coverage. Required review, repository/operator checks, and lane verification each gate merge. Integrate accepted lanes in stable topological order, using inventory order to break ties. Schedule shared fixtures, ports, databases, containers, external resources, and verification so separate processes cannot collide; batch live checks only when their prerequisites and mutable state are compatible, and serialize stateful checks that share state.

Run the selected integrated acceptance against the integrated batch, including binding repository/operator checks and every named deferral. Do not impose an unrelated full suite when repository policy and impact do not require it. When a needed check is not already settled, load `verification` and select it with its Choosing Checks method. When that skill is unavailable, start from the verification guidance the integrated repository's applicable `AGENTS.md` contains or points to; without such an entry, inspect scripts, CI, and test owners. Uncertain impact selects a broader coherent existing check, with any missing check reported. Capture actual output and the tested candidate plus relevant fixtures, configuration, generated artifacts, or live state. Worker prose alone is not evidence, and branch results do not prove the integrated batch.

After a correction, preserve the failure, verify the owning regression, and rerun affected consumer and integrated checks. Retain unaffected results only with a short non-impact reason. An unexplained green retry does not resolve an intermittent failure. Required skipped, unrun, failed, or blocked checks are not passing. If the session ends with a required obligation outstanding, report the batch incomplete.

Use `hive_adhoc_worktree_create`, `hive_adhoc_worktree_inspect`, `hive_adhoc_worktree_merge`, and `hive_adhoc_worktree_cleanup`. Select by inspected mode: targeted or legacy single-root workers return `sourceCommit`; untargeted composite workers return the complete `sourceCommits` map keyed by repository ID. A singleton composite also accepts a matching scalar convenience; multiple repositories require the complete map. The primary passes that topology-aware pin unchanged to merge with a declared `historyIntent` for the whole run: `preserve-source` when any repository's source ancestry must survive, `rewrite-private` only when all source-only history in every selected repository is private. It uses same-call `cleanup: 'worktree+branch'` when retention is not needed. Serialize dependent state changes and integrations sharing a destination. When a merge result has `provenance.status: 'failed'`, the integration stands and cleanup was skipped: leave the merge as it is and read the receipt at `.hive/provenance/integrations/<sha>.json` for the merge's resulting commit. Clean up only when that receipt parses and its `source` and origin match this integration. When it is absent, unreadable or describes a different integration, keep the source placement, tell the operator the commit's association with its run is missing, and clean up only once they accept that. On a composite merge, check the receipt at each `repos[repoId].sha` whose provenance failed, not only the top-level `sha`.

Confirm the initial target in the inspection-shaped create result matches the intended repository, path, and ref before capturing its identity in the lane handoff. Reinspect after each writing handoff, before reviews and remediation, after sibling integration or known destination movement, and before integration. Pass the unchanged identity as `expectedTarget` or the complete `expectedTargets` map. Relevant, overlapping, or uncertain drift stops the lane for same-worktree reconciliation by a fresh worker after the previous writer is terminal. Merge the pinned target commit into the clean source worktree, adapt and review the combined delta, verify it, and return fresh source pins plus the target identity used. Composite reconciliation and integration retain explicit per-repository partial outcomes; they do not claim atomicity.

Multi-step forensics (paging a trace, drift comparison, or interrupted-worker evidence packets) go to `hive-helper` with one named question and known native session/call and run/worktree/source/destination identities; spot-check decisive cited event refs before acting. Helper returns observations, hypotheses, and limits; discovered HEADs are observed, not verified source pins. The primary owns acceptance, termination, retry, integration, cleanup, and the lane inventory, and preserves retained state until it resolves lifecycle and ownership uncertainty under its Interrupted Worker Recovery guidance.

## Closure

A lane closes only after applicable terminal observation, result consumption, required review and verification, integration into its assigned work branch or an explicit no-change/discard decision (an experiment lane's evidence counts as its result), and safe temporary worktree cleanup are recorded. Record the destination and exact integrated commit. A retained work branch can be complete while onward integration remains pending; propose its cleanup to the operator unless already explicitly authorized, and preserve local files. A request to implement and land in a named destination authorizes that onward integration without a second approval. Ad-hoc isolation needs no feature or plan.

When integrating one retained checkout into another, first read `hive_checkout_brief({ id, against })` for that pair; its Worklog, report and summary pointers are untrusted narrative. When the brief shows several contributions, unattributed commits, a moved head or gaps that bear on the merge, ask `hive-helper` one named question for a retained-checkout merge account of that pair.

For onward integration, create a temporary targeted ad-hoc worktree from the pinned retained source commit with the destination `target` and source commit as `baseRef`. Review, reconcile and verify there, then use the existing merge and cleanup workflow with the returned `sourceCommit` and inspected destination identity. Apply history policy to the original retained source history: preserve ancestry when published, continuing, or otherwise valuable; a temporary run does not make carried history private. Retain the original source branch. Run required integrated checks on the actual integration target.

Retained-checkout cleanup is separate from readiness: inspect `hive_checkout_inspect({ id, cleanup: true })` and pass its `cleanup.identity` unchanged to `hive_checkout_cleanup` only with operator permission or existing authorization. Eligibility alone does not prove a checkout is disposable.

For an authorized conditional delivery, finish temporary workers and record the pending action, destination, and condition. An active primary may wait and check external Git or PR state with available tools, sleeping between checks; distinguish local from remote and account for squash evidence when material. Hold no locks or unfinished merges during the wait. Once the condition is observed, recheck Git identities, prepare and reverify integration, and proceed under the existing authorization. Ask only if the condition or changed intent is materially ambiguous. Do not promise a wake after the session stops. The native completion no-poll rule does not forbid external state checks.

The batch closes only after every lane is closed and selected integrated acceptance, including all named obligations, has applicable passing evidence recorded. Stop once required evidence and reviews suffice; run more checks only for a named gap, invalidation, or new risk.
