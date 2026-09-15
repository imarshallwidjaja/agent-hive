# Operator Guide

This guide covers day-to-day work after installation. Use the [root README](../README.md) for first setup. Exact slash-command flags, tool contracts, and report schemas live in the [plugin README](../packages/opencode-hive/README.md).

## Mental model

Agent Hive separates decisions from execution:

- **You** set direction, review the plan, answer blockers, and approve risk.
- The **primary agent** turns the request into a plan and orchestrates the work.
- **Researchers and reviewers** inspect code, plans, or frozen review workspaces.
- **Workers** implement approved tasks in isolated git worktrees.
- **`.hive/`** stores durable plans, task state, reports, comments, and recovery metadata.

A plan does not authorize implementation until you approve it. `/dash-review` and `/vuln-review` bind to separate review primaries so the agent that wrote the change is not the one judging it.

## Agents

OpenCode shows these public seats. Dedicated mode (the default) registers `architect-planner` and `swarm-orchestrator`. Unified mode (`"agentMode": "unified"`) registers `hive-master` instead. `hive-builder` and the subagents below stay available in both modes.

Hidden runtime seats used by `/dash-review`, `/vuln-review`, and task-trace recovery are not listed here. You invoke those products with the slash commands, not by picking the private agent.

### Primary seats

**`architect-planner`** exists so feature work can be scoped before anyone writes code. Default seat in dedicated mode. It interviews, researches through scouts, and writes `plan.md`. "Do X" means "plan X". It does not implement, start worktrees, or merge.

MO: classify the request, clear requirements one gap at a time, then write a worker-executable plan. It stops at an approved plan. Switch to `swarm-orchestrator` (or keep talking to `hive-master` in unified mode) for execution.

**`swarm-orchestrator`** exists so approved feature work can run without rewriting the plan. Dedicated-mode execution seat. It syncs tasks, starts workers, inspects handoffs, merges, and tracks `.hive/` status.

MO: delegate by default. Direct work is only coordination, one bounded read, one bounded write, or one cheap final check. One numbered task is one implementation assignment. Worker output is evidence to inspect, not proof that the batch is done.

**`hive-master`** exists for operators who want one feature seat across planning and execution. Unified-mode default. It is phase-aware: no feature or unapproved plan means planning; approved tasks mean orchestration.

MO: same direct-work boundary as the split seats. It still waits for your approval before implementation. It can also coordinate ad-hoc work in unified mode; dedicated mode leaves that to `hive-builder`.

**`hive-builder`** exists for bounded work that should not become a feature, plan, or task DAG. It is the dedicated-mode ad-hoc orchestrator and remains available in unified mode.

MO: inspect, classify or decompose into coherent lanes, place ready writing lanes in separate ad-hoc worktrees, delegate non-trivial work, verify, inspect status/diff, commit, merge, cleanup. It does not create feature or task records. Decomposition does not add a blanket approval step. If unresolved contracts, inexpressible handoffs, migration or irreversible risk, or audit/governance needs make the feature workflow materially safer, it recommends escalation. If you reject escalation, it continues ad-hoc only when material scope, contracts, and risks are otherwise resolved; otherwise it asks the concrete blocking question before preparing workers.

### Subagents you will see

Primaries launch these. Ask the primary for a named seat when you want that lens. Custom agents in `~/.config/opencode/agent_hive.json` derive from these bases; their descriptions specialize routing within the inherited role and cannot expand its prompt, tool, or permission boundaries.

**`scout-researcher`** retrieves bounded evidence from local code, docs, and external sources. It can summarize facts, trace calls and references, preserve contradictory evidence, and report attributed source recommendations. It does not diagnose observed failures, judge system correctness, decide applicability or tradeoffs, select solutions, edit, implement, or launch other agents. Primaries route by the requested output rather than read-only status: they own synthesis and decisions, check decisive provenance and plausible alternatives, and use Scouts when a real evidence gap makes delegation useful.

**`forager-worker`** implements in isolation against a written assignment without inventing extra scope. Implementation missions code and run best-effort checks; managed feature tasks complete through `hive_worktree_commit`, while ad-hoc workers return a report for the parent to commit. Diagnosis-only missions report evidence, tested and untested hypotheses, a supported conclusion or unresolved status, and requested options without fixing, editing, committing, or using destructive reproduction. It never delegates.

**`plan-reviewer`** exists to catch plans that a worker cannot execute. Core question: can a capable worker run this without getting stuck? It checks work content, references, scope, dependencies, executable verification, and written assumptions. It samples representative task handoffs and path ownership: missing dependencies and unsafe shared-write overlap are blockers. It may report nonblocking coordination observations, but a low parallel task count does not justify rejection. Verdict is OKAY or REJECT based on execution blockers. It does not judge whether the architecture is optimal.

**`code-reviewer`** exists to check an implementation against the task or plan that authorized it. Core question: is this sound for the stated assignment? It maps changed files to requirements, then correctness, tests, risk, and YAGNI. Verdict is APPROVE, REQUEST_CHANGES, or NEEDS_DISCUSSION. It does not review plan readiness or relitigate architecture unless the diff exposes a concrete defect.

**`simplicity-reviewer`** exists as a final deletion-biased pass after the behavior is already in place. Core question: is the completed change as simple as it can safely be? It looks for YAGNI, dead code, duplication, and extra abstractions. It does not redesign the approach or claim tests passed without evidence.

**`approach-advisor`** exists for "should we do it this way?" questions. Read-only advice on architecture, tradeoffs, stalled debugging direction, and route choice. It recommends one path. It does not implement, approve, reject, patch, or verify.

**`vulnerability-reviewer`** exists to trace attacker-controlled input or capability to concrete impact with local evidence. `/vuln-review` uses it as the specialist base; primaries can also send a scoped security question to the stock seat. It does not exploit systems, edit source, run scanners or shell, or emit a patch.

### Recovery and session authority

`hive-helper` is a runtime-only recovery assistant for merge recovery, state clarification, and safe append-only follow-up inside an approved feature DAG. It is not a seat you start from.

An authenticated helper child can use its configured ordinary and merge-recovery tools, including `hive_merge` and `hive_status`. Managed context remains unavailable to helpers, and they cannot dispatch native tasks.

A runtime-authenticated top-level primary fork, including a promoted Magic Compact backup, retains full primary capabilities after normal agent observation: ordinary tools, task dispatch, managed context, and primary management. Stored identity must corroborate the observed primary agent and parent-free runtime lineage. Actual worker assignments, ad-hoc bindings, parent lineage, conflicting identity, and malformed state still deny authority.

Task-worker copies retain delegated execution authority, including when parent-free, when their copied immutable assignments and authenticated assignment-copy provenance validate. The external/session flow must supply authenticated origin metadata that triggers `copyWorkerAssignment`, and the source must have a valid immutable assignment. Hive does not automatically stamp worker origins or produce worker backups. Generic forks of ad-hoc or unassigned subagent sessions do not inherit execution authority and require a fresh authenticated launch.

Hive stamps authenticated primary origins on a best-effort basis, including sessions without standing constraints. Origin metadata supports copying feature context, directives, and constraints; it is not an authorization prerequisite for primary backups. Worker copies depend on authenticated assignment-copy provenance. Primary origin copies exclude stale worker prompt paths, task folders, and ad-hoc run IDs. If metadata stamping is unsupported or promotion loses optional copied continuity, the observed primary session remains usable and can re-establish feature context. Magic Compact is an external compaction plugin/flow whose backup may be promoted. Hive supports that backup as a primary once runtime authentication succeeds; backup promotion and deletion of the original are controlled by the external flow.

Helpers do not receive managed compaction directive or assignment replay. Primary forks use the same directive replay rules as other primaries; worker assignment replay requires authenticated worker provenance. After a plugin restart, stored identity alone is insufficient: send a new message in the session so the runtime observes its agent again before using Hive-governed tools. Restart OpenCode after installing this change to load the rebuilt plugin.

A copied worker assignment retains its original owner and immediate duplicate source. Generic copies and worker copies reject conflicting recipient identity or stored parent provenance before changing the recipient or its constraints. Missing generic origin continuity is skipped with a warning and no recipient copy, rather than returned as an operator-facing error. Unknown non-Hive children keep their configured ordinary tools and receive no live-context catalog solely from parentage. Every `hive_*` call requires authority from a supported Hive role.

## Standing constraints

State a session-wide constraint once. Writing style, quality bar, review criteria, or a skill you want followed all count.

The primary agent adds each durable directive verbatim with `hive_constraints_add`; a repeated identical add is harmless and unrelated entries remain intact. A correction or removal starts with `hive_constraints_read`, then targets the returned stable ID through `hive_constraints_edit`. A whole-register clear uses `hive_constraints_clear` only when you explicitly request it. Edit and clear use revisions so a concurrent change cannot be overwritten. The runtime adds the register to delegated worker and reviewer prompts in that session. Task-local requests, examples, and ordinary messages do not belong in the register. Constraints apply on top of the plan, while `/dash-review` and `/vuln-review` use their own fixed contract and ignore the register. Managed context catalogs are untrusted knowledge, not standing constraints.

## Choose a workflow

| Workflow | Use it when | Start |
|----------|-------------|-------|
| `/grill` | You want explicit shared understanding of any supplied context without assuming a software workflow | `/grill <context>` |
| `/interview` | Clarify an idea toward a reliable implementation-brief handoff | `/interview <idea>` |
| Feature | You need a reviewed plan, task dependencies, isolated task worktrees, or a durable execution record | Ask in plain language, or `/hive-plan` |
| Ad-hoc (`hive-builder`) | The work is bounded, is not a feature, and should not create feature or task records | Talk to `hive-builder` (dedicated) or `hive-master` (unified) |
| `/dash-review` | You want a read-only Git, process/concept, or local-artifact review | `/dash-review [intent] [--artifact <file>]` |
| `/vuln-review` | You are authorized to assess the source and want a bounded static security review | `/vuln-review [intent] [flags]` |

`/council` is a lighter read-only advice run. It does not replace dash-review or vuln-review.

`/grill` and `/interview` share the same one-question-at-a-time interaction engine. `/grill` ends at explicit alignment on the supplied context. `/interview` keeps questions implementation-oriented and prepares context for the separate `/implementation-brief` command rather than producing that full brief. They do not automatically create a plan, implement, or start follow-on work; confirmed alignment ends the interaction, and later action requires a separate operator request. A named destination authorizes writing only the confirmed alignment brief there. Neither command uses a fixed question count or forced research fan-out. Unavailable or failed research is disclosed as unresolved or an explicit assumption; it is never guessed.

## Execution ownership

Hive coordinates cooperative local coding agents. These statements are the current contract:

- Multiple primary sessions in one project are supported through isolated worktrees.
- The same exact registered workspace may have only one managed writer at a time. Multiple write passes in one worktree run strictly sequentially: prepare -> dispatch -> await completion -> inspect/commit -> prepare a fresh pass.
- Uncertainty (unobserved or unavailable native execution) quarantines only the affected worktree. Unrelated worktrees may proceed.
- Cross-process process supervision, exactly-once execution across independent OpenCode processes, automatic crash takeover, and distributed locking are unsupported. Independent OpenCode runtimes sharing a project do not get a complete exclusivity promise.
- `hive_existing_workspace_start` is unavailable. Isolated worktrees are the managed placement. Direct foreground OpenCode work may still modify the current checkout; that work is unmanaged OpenCode work, not a Hive placement.
- Integration locking is operation-scoped: source worktree, destination checkout, and composite repositories.
- Background jobs and the board are observational bookkeeping (acknowledgement, archive, notification). They are not ownership authority.

An **ExecutionAttempt** is the dispatch and recovery record (`prepared` -> `dispatched` -> `settled`). Persist attempt history in `.hive/execution-attempts.json`. A **live claim** maps exact **worktree identity** to the active attempt ID. Composite claims cover the explicit registered worktree set. Two executions conflict when those identity sets intersect. Persisted history is not proof that an execution is still alive. After restart, unsettled attempts become **unobserved** and only those workspaces are quarantined.

Conflict uses exact registered worktree identity. Generic ancestor or descendant filesystem containment is not the conflict model. The project root does not overlap every worktree merely because it is an ancestor path. Declared file ownership is not a concurrency guarantee.

Uncertain workspaces are preserved; they are not reset, copied, or deleted to recover. Retry after confirmed termination may reuse the same worktree. Retry while termination is unobserved supersedes that task onto a fresh `attemptSlot` worktree; the previous worktree stays claimed. Starting the same task twice allocates atomically one active attempt; the second caller is rejected or returned the existing attempt. For ad-hoc work, retry after confirmed termination may reuse the same `runId` worktree. Retry while termination is unobserved cannot reuse that run; start a new ad-hoc `runId` and worktree.

Two integrations into the same destination checkout serialize. Integration while unrelated worktrees are active is allowed when source and destination do not conflict. Integration is refused while the source worktree has an active writer. Context, plan, and constraint mutations keep revision and hash conflict handling.

`launchId` is a one-time dispatch selector, not a distributed authority graph. Agent-supplied metadata is never authoritative execution identity. Do not treat placeholders such as `forager-child` as live owners, and do not treat a `ses_` prefix as identity validation. `NativeTaskLease` values are diagnostic history after one-shot migration onto `nativeTaskLeaseHistory`; they are not scheduling authority.

Cancellation is owner-scoped. Another primary must not automatically terminate another primary's child. Cancel acknowledgement is not proof of termination; live claims remain until termination is observed. Cleanup and archival never imply execution cancellation. Archive, reconcile, and ignore on the background board do not stop execution, release a workspace, settle an attempt, or authorize retry in the same workspace.

Worker-side `hive_worktree_commit` remains for managed feature tasks and is authorized by the live attempt association. Review-workspace claim, inspect, and cleanup stay a separate security boundary for `/dash-review` and `/vuln-review`; they do not grant cross-primary kill of another primary's child.

## Feature lifecycle

### 1. Discuss and plan

Describe the outcome, constraints, and important context in plain language. The primary agent researches where needed and writes the feature plan. Architect and Hive load `writing-plans` when drafting or materially revising task boundaries or dependencies. They choose coherent outcomes, predecessor outputs, path ownership, and verification before assigning dependencies. Independently verifiable capabilities may be separated from shared integration when the handoff is concrete and worth the coordination cost; the integration task owns named behavior, exact shared paths, and tests. Task counts and parallelism are not quotas. Managed context is selected from the live catalog; agents should not mass-read every note.

### 2. Review

Read the plan in chat or in VS Code. Add comments when a requirement, dependency, or risk needs correction. Ask the primary agent to revise it until the scope is clear.

### 3. Approve and sync

Approve the reviewed plan. Hive then creates the executable task records.

### 4. Execute

The primary agent starts runnable tasks. Each worker receives a task-specific prompt and performs task-level, best-effort checks in its own isolated git worktree. Workers report completion, failure, or blockers through the task boundary.

A worker commit records the task branch. It does not merge that branch.

### 5. Inspect worker output

The operator/orchestrator inspects completed worker output. Worker claims and task-level checks are handoff evidence, not a substitute for verification.

### 6. Merge, verify, and complete

Merge completed task branches after inspecting their output. Then run fresh build/test verification against the merged result. Mark the feature complete only after that merged-result verification passes. Feature completion does not archive context. Project owner and review date are accountability labels; a primary re-reviews against evidence and hash-guarded replaces or archives with a reason. There is no metadata-only renewal.

## Ad-hoc lifecycle (`hive-builder`)

Use this when the change is real work (isolation, delegation, verification, merge) but does not deserve a feature record. Dedicated mode uses `hive-builder`; unified mode uses `hive-master` as the ad-hoc primary.

1. **Inspect, classify, and decompose.** The ad-hoc primary gathers enough context to decide direct work versus delegation. Requests with multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, possible background execution, or an expected need for more than one worker attempt or turn load `orchestrating-ad-hoc-work` before worktree preparation or delegated dispatch. The lane inventory records coherent outcomes, concrete handoffs, done criteria, and ownership for paths, generated outputs, external mutable resources, fixed-path fixtures, ports, databases, and containers. Distinct worktrees do not isolate those resources. One coherent lane may still be right.
2. **Place ready lanes.** Managed delegated execution uses isolated ad-hoc worktrees under `.hive/.worktrees/adhoc/<runId>`. Parallel writers get distinct runs and worktrees; shared runtime resources are separately sequenced. Dependent writers wait for predecessor output, normally integrated into their base revision. Read-only research and review need no artificial worktree. `hive_existing_workspace_start` is unavailable.
3. **Delegate and track.** Scouts research. Foragers implement in the selected worktree. Reviewers check settled results. Session state or `todowrite` is enough only for a single-lane, single-dispatch blocking job expected to finish in one turn. Every multi-lane, dependency-wave, background, expected multi-attempt, or otherwise multi-turn batch creates one project-scoped `kind: "evidence"` ledger before its first delegated dispatch. Name it `adhoc-lanes-<purpose>-<UTC timestamp>` with a filename-safe compact current UTC value and record the exact name in session/todowrite and compaction handoffs. No worktree is needed to create the ledger or run a read-only first wave. Because evidence ledgers are absent from the durable-only catalog, recovery starts with `hive_context_read({ scope: "project", view: "summary" })`, followed by a named hash-guarded read and reconciliation against runtime tool results, observed native state, and the background board when applicable. Append each transition. Retry after confirmed termination may reuse the run; uncertainty requires preserving it and starting a new run for overlapping work.
4. **Review and verify.** Run lane-specific checks and inspect effects and dirty state after each worker stops. Lane changes receive the reviews required by the active primary's configured review policy; the ad-hoc skill adds no separate reviewer-approval gate. Required review and lane verification each gate merge. Run full canonical verification after the integrated batch and record its exact result in the ledger.
5. **Integrate and clean up.** Perform authorized integration in stable dependency and lane-inventory order, then clean up each ad-hoc worktree. A lane closes only after terminal observation, result consumption, required review and lane verification, commit and merge or a no-change/discard decision, and cleanup are recorded. Archive only after every lane closes and the full integrated canonical verification result is recorded and passing. Failed final verification, failed cleanup, or uncertain execution leaves exact identifiers, evidence, and the next recovery action in the unarchived ledger. Default integration is squash with a polished message.

Use Forager or a Forager-derived custom worker for delegated execution. General is exceptional: state the required capability unavailable in the Forager lanes before choosing it. General receives ordinary tools only and is not a managed placement.

After a `/dash-review` or `/vuln-review` on ad-hoc work, give any fix instruction to the active ad-hoc primary (`hive-builder` in dedicated mode or `hive-master` in unified mode). Findings are review context, not auto-created tasks.

Lanes do not automatically require a feature or operator approval. The ad-hoc primary recommends feature escalation when requirements or contracts remain unresolved, dependencies cannot be expressed as concrete handoffs, migration or irreversible risk needs approval, or durable audit/governance is required. Escalation remains advisory, but rejecting it does not resolve a material contract or risk: the primary asks that concrete blocking question and does not prepare workers until it is resolved. Tool contracts: [Ad-hoc Worktree](../packages/opencode-hive/README.md#ad-hoc-worktree).

## Review options

### `/dash-review`

Use this when you want a read-only second opinion without changing source.

1. Git review: run `/dash-review`, provide an exact GitHub PR URL, or describe the current Git target. A PR fixes Git evidence. Empty arguments can resolve only Git evidence.
2. Process or concept review: provide nonempty natural-language intent. Stage A can select inline evidence with subject kind `process`, `concept`, or `general`; this uses advisory lanes rather than implementation severity semantics.
3. Local files: repeat `--artifact <project-relative-file>`. Example: `/dash-review review these outputs --artifact reports/result.bin --artifact notes/review.txt`. Artifact paths come only from the command packet. They cannot be supplied later by a model. One bundle accepts at most 32 files, 16 MiB per file, and 32 MiB total.
4. One invocation resolves one evidence kind. PR plus artifact, arbitrary URL evidence, absolute/private/traversing paths, symlinks, and mixed kind-specific fields fail before acquisition.
5. Git freezes under `.hive/.worktrees/review/<runId>`. Inline and artifact evidence freezes under `.hive/.worktrees/review-evidence/<runId>`. The primary claims, reviewers read only that absolute workspace, then the primary inspects and cleans it.
6. The response includes scope/source/resolution fingerprints, requested questions answered, limitations, integrity, and cleanup. Git/code review remains findings-first. Process/concept review leads with direct answers and advice.
7. If you want a fix, ask the feature orchestrator or the active ad-hoc primary later. Dash-review writes no source, Hive tasks, commits, patches, or report file.

`/vuln-review` remains Git-only. It rejects inline and artifact evidence before `BOUNDED`. Tool details and lane contracts: [Operator Commands](../packages/opencode-hive/README.md#operator-commands).

### `/vuln-review`

Use this for authorized static review of source you are allowed to assess. `/vuln-review` does not edit source or apply automatic fixes. It is a findings-first pass over one frozen snapshot, not a pentest and not a substitute for SAST, DAST, or an audit.

1. Run `/vuln-review` with free text, flags, both, or nothing. Flags are fixed overrides. Whole-repository scope needs `--whole-repo` or an explicit yes to that inferred expansion.
2. Resolve returns `BOUNDED`, `NEEDS_CLARIFICATION`, or `STOP`. Clarification asks one Yes/No question. Only the stored accepted candidate can be materialized.
3. Investigate runs a mandatory baseline plus at most two specialist lenses chosen from the observed attack surface. A falsifier then challenges every candidate, including the hypothesis that nothing actionable exists in scope.
4. The report stays in the OpenCode session. No report file, SARIF, patch, or Hive task is written. Confirmed findings include evidence, attacker-to-impact path, and fix direction without a patch.
5. Remediation is a separate operator instruction to the feature or ad-hoc orchestrator after you accept the risk and the scope.

The workflow does not exploit systems, scan networks, use credentials, install packages, run scanners, edit source, or mutate remote state. A clean scoped result is not a repository-security claim. Intent flags, specialist lenses, and the report schema: [Vulnerability Review](../packages/opencode-hive/README.md#vulnerability-review).

## When work blocks or fails

After a worker fails or reports partial progress, start again through the normal task-start path, [`hive_worktree_start`](../packages/opencode-hive/docs/HIVE-TOOLS.md#worktree-4-tools). This normal path covers retries; it is not restricted to pending or in-progress tasks. Retry after confirmed termination may reuse the same worktree. Retry while termination is unobserved supersedes that task onto a fresh `attemptSlot` worktree; the previous worktree stays claimed. Starting the same task twice allocates atomically one active attempt; the second caller is rejected or returned the existing attempt.

Ad-hoc retry after confirmed termination may reuse the same `runId` worktree. Retry while termination is unobserved cannot reuse that run; start a new ad-hoc `runId` and worktree. `hive_adhoc_worktree_start` on an unobserved run is denied (`unobserved and cannot be reused` / `workspace_conflict_denied`).

When a worker is blocked, inspect the blocker and make the operator decision. The blocked path, [`hive_worktree_create`](../packages/opencode-hive/docs/HIVE-TOOLS.md#worktree-4-tools), launches a fresh worker in the existing worktree after that blocked handoff has settled.

Accepted worker handoffs, including blocked handoffs without a Git operation, retain their full narratives in task-local `reports/<revision>.md`. `report.md` remains the latest entry point and links five recent revisions plus the history directory. Revisions count report writes, not attempts or commits. Existing legacy `report.md` bytes are preserved on first replacement; overwritten reports from before this change cannot be recovered.

Reports capture worker claims and branch changes at handoff, not independently verified results, current task state, or merged state. Reopening a task leaves the historical snapshot intact. A report write failure preserves the previous latest report; an immutable copy may remain if latest replacement fails. Git, report storage, and status updates are separate operations.

Retries automatically include at most 3,000 characters of summary (or a separately labelled legacy report excerpt) and 1,000 characters of error, with report references for explicit reading. Blocked continuation bounds previous progress to 3,000 characters and preserves the current operator decision verbatim. Append current cross-attempt knowledge into existing task-tagged durable context with report references after a named read; historical claims are evidence, not active instructions. Older mixed prompts without a new assignment marker need a fresh parent launch.

If the workspace root moved, the old recipient remains denied. An authenticated primary at the newly trusted canonical root allocates a fresh task attempt, publishes a new immutable assignment, and establishes a fresh authenticated child binding. Ad-hoc relocation requires a fresh authenticated run. Old session and assignment descriptors remain historical; never edit roots to rebind them, follow the stored former root, or suggest root migration/aliases. Seamless continuation is intentionally sacrificed.

Exact-worktree registration is the Git integrity prerequisite, not trusted repository or common-directory containment alone. Local byte/path inspection first rejects untrusted `.git` targets without dereferencing them. Only after the selected administration path passes trusted identity-bound common-directory containment without symlink escape may preflight inspect its metadata: `commondir` must resolve to the expected trusted common directory and the parsed/normalized `gitdir` backlink must match the current worktree's own trusted `.git` path. Reject sibling/old entries inside the same valid common directory explicitly, with zero access through mismatched backlinks/former paths and before any suspect-worktree Git. Preserve all workspace, Git administration, and historical descriptor/artifact bytes and state. Common-directory discovery from trusted topology-resolved source repositories is permitted, including linked repositories with external common directories. Suspect-worktree Git before exact registration is forbidden.

Prepare or recreate an independently valid workspace at the new root, then launch a fresh attempt or run. Recovery does not rewrite `.git` or administration metadata, migrate roots, delete/repair/recreate worktrees automatically, or add a recovery record. Error notices are not empty or current catalogs. Never delete an index to restore classification. Invalid-index and pending-mutation repair stays out of band: quiesce writers, inspect bytes, restore the index/manifest, then reconcile the marker. `.hive/sessions.json` is canonical global session truth.

### Reading a failure result

Git-affecting worktree, ad-hoc, and merge failures return classification fields alongside the existing result: `phase`, `reasonCode`, `mutation`, `retryable`, and `action`. Field definitions and the full code table live in [Recovery fields and failure classification](../packages/opencode-hive/docs/HIVE-TOOLS.md#recovery-fields-and-failure-classification). Read `mutation` before anything else: it says whether the target moved, and it governs whether the operation can be repeated. If `retryable` is `false`, repeating the same call is not the recovery path.

Group the codes by the decision you actually make:

- **Fix the call.** `correct_arguments` covers missing or invalid input, commit or merge message shape, and a message supplied with `rebase`, which accepts none. No durable target mutation occurred, so no repair is needed beyond the corrected call.
- **Inspect first.** `inspect_state` means the reported condition must be read before the next move. It covers an unknown run or worktree, a missing source branch, an in-progress Git operation, an unclassified Git failure, a failed post-integration check, and a partially merged composite run. `GIT_OPERATION_FAILED` also reports `retryable: true` even though it lands in this group: inspect it first, and repeat the same call only once the cause is understood.
- **Narrow preconditions.** `clean_target` and `retry_same_operation` gate a retry on satisfying a stated prerequisite: a clean target, or a conflict Hive already aborted and restored to its starting state. Satisfy it, then repeat the same call.
- **Handle state that Hive left in place.** `resolve_conflicts` applies to `MERGE_CONFLICT_PRESERVED`, where the conflict state is preserved for you; conflict paths are in `conflicts`. `cleanup_only` applies to `CLEANUP_FAILED`, where cleanup ran after a successful integration and did not fully finish. Read the per-step cleanup status and the `failures` list, repeat only the cleanup step, and do not re-run the merge.
- **Do not retry.** `WORKTREE_LINKAGE_INVALID` and `WORKSPACE_TOPOLOGY_MISMATCH` mean the run's worktree identity no longer matches its trusted Git registration. Neither is retryable, and neither is repaired in place. Prepare or recreate an independently valid workspace, then launch a fresh authenticated attempt or ad-hoc run, following the relocation rules above. `manual_recovery` applies to `ROLLBACK_FAILED`, where Hive could not restore the target and the durable state is `unknown`; inspect the repository by hand.

A composite run that integrated an earlier repository and then failed reports `COMPOSITE_PARTIAL` with `mutation: 'partial'`. Earlier repositories remain integrated, so the result does not mean nothing happened, and repeating the whole operation is not the recovery. Read the per-repository results, which are authoritative; an aggregate top-level `sha` is a representative value from one repository, not a cross-repository identifier.

`filesChanged` describes the integration itself: it is the difference in the target between immediately before and immediately after integration. A no-op, a failure fully restored to its starting state, and a preserved conflict report it empty; conflict paths stay in `conflicts`. `NO_TRACKED_CHANGES` remains the successful no-op: `success: true`, `merged: false`, no `sha`, and cleanup still runs when requested. A merge never reports `merged: true` when the target HEAD did not move.

## Inspect context and constraints in VS Code

In Features, expand a task to open **Latest handoff report** or expand **Report history** for immutable revisions, newest first; revisions count report writes, not attempts or commits. Legacy tasks without revision files show only the latest report.

The Arkive extension keeps its three native views. In Features, expand Context to inspect Markdown documents, classifications, sizes, inclusion policy and durable budgets. Evidence exclusion applies to automatic prompt injection; it is not a privacy guarantee. `overview.md` still opens normally and supports review comments. Direct editor saves bypass managed context revisions and mutation-time caps. Feature hygiene warnings begin strictly above 8 durable files or 40,000 UTF-16 units; project warnings begin strictly above 32 files or 160,000 units. `durable.bytes` is the stat-byte total; `durable.chars` is exact UTF-16 only after an explicit `scanChars` summary scan.

Use **Archive Context** on a Context folder or file to select documents, supply a reason and confirm their exact filenames. The operation uses the revision captured before selection. A stale revision fails without retrying; reopen the action to review current state. Cancelling any step leaves context unchanged.

Use **Hive: Inspect Session Standing Constraints** in the command palette to explicitly select a session with entries from the authoritative project registry. The read-only document shows identity/scope, stable entry IDs and text, revision, and usage against the 8,000-character cap. It omits directive prompts, paths and recovery metadata. Inspection never chooses an active session or writes the registry. Manage directives in OpenCode. `.hive` changes and **Hive: Refresh** update open inspectors.

## Other review options

- **Plan comments**: review requirements, dependencies, and scope in the plan document or chat before approval.
- **`/council`**: read-only advice about a design or tradeoff. It synthesizes member notes. It does not approve, execute, merge, or freeze a review workspace.

## Background and trace notes

Background execution is optional and experimental. When enabled, wait for the native completion notification, then inspect and reconcile terminal jobs. Background controls do not roll back files, branches, worktrees, commits, or reports. `/dash-review` and `/vuln-review` stay blocking. The board is observational bookkeeping. Archive, reconcile, and ignore do not stop execution, release a workspace, settle an attempt, or authorize retry in the same workspace.

All Foragers, including diagnosis-only workers, need a prepared launch in an isolated worktree. Use `hive_worktree_start` for managed feature tasks and the ad-hoc worktree tools for isolated non-feature work. `hive_existing_workspace_start` is unavailable. The preparation response includes `launchId`; preserve the nested `hive_launch_id`. `launchId` is a one-time dispatch selector. Runtime restores immutable instructions for that prepared assignment. Reused worktrees still require exact Git registration before launch.

A rare native `general` capability exception requires a specific nonblank `hive_capability_reason` and no `hive_launch_id`. The dedicated argument is stripped before native dispatch; the reason remains in the native description and durable admission record. It declares a need, not proof that Forager lacks the capability. General receives ordinary tools only, with no Hive authority, recursion, or questions. Native helper calls retain bounded operational permissions. Neither call is a managed placement, and neither recreates existing-workspace execution.

Independent worktrees whose registered identities do not intersect may be prepared under one parent. Two executions conflict when their exact registered worktree identity sets intersect. A live claim maps worktree identity to the active attempt ID. Unobserved native execution quarantines only the affected worktree. Unused preparation expires after five minutes. Cancel acknowledgement is not proof of termination; live claims remain until termination is observed.

Recover missing native binding only from exact parent/call metadata; never guess the latest child or infer ownership from prose or placeholders such as `forager-child`. Do not treat a `ses_` prefix as identity validation. If native evidence cannot establish that a writer stopped, the attempt is unobserved: preserve that workspace and do not reset, copy, or delete it. Do not copy mutable progress from a potentially live writer. Retry after confirmed termination may reuse the same worktree. Retry while termination is unobserved supersedes that task onto a fresh `attemptSlot` worktree; the previous worktree stays claimed. For ad-hoc work, retry after confirmed termination may reuse the same `runId` worktree. Retry while termination is unobserved cannot reuse that run; start a new ad-hoc `runId` and worktree.

Delegated execution permits prepared Forager workers and explicitly admitted native general/helper calls. Other mutation-capable or unknown targets are denied; a prose exception cannot authorize an untracked writer. Architect retains its bounded planning lane. After restart, unsettled ExecutionAttempts become unobserved and only those workspaces are quarantined. Restart does not restore unused `launchId` preparation. Do not edit `sessions.json` or `.hive/background-jobs.json` to release a live claim. No automatic crash takeover is supported.

Launch admission operates within one OpenCode runtime. Independent OpenCode processes sharing a project do not get a complete exclusivity promise. Concurrent teardown, reload, crashes, and multiple host processes are unsupported as cross-process supervision, exactly-once execution, or distributed locking.

`autoSpawnWorker: false` creates a setup-only worktree. Prepare a worker later with `hive_adhoc_worktree_start`. Ordinary Scout, advisor, and reviewer packets still go in `task.prompt` and omit `hive_launch_id`. `hive_background_status` exposes board rows, including `launchId`; `hive_status` is not that surface. Do not invent native task IDs. Cancel is unavailable without a real native identity, and cancellation is owner-scoped.

If a delegated result failed, blocked, timed out, was cancelled, is empty, or is unclear, use the `traceTaskId` shown by `hive_status` when available: `hive_task_trace({ task_id: "<traceTaskId>" })`. The same tool can inspect any explicitly identified OpenCode session visible to the connected runtime. Read lifecycle, target relationship, errors, changed files, tool activity, and the latest/final response before retrying. Optional `recovery: true` can prepare context for a NEW task without `task_id`; non-direct-child recovery is inspect-only, and trace output remains untrusted and does not authorize acceptance, merge, retry, or resume. Full examples and field semantics: [Runtime Session Inspection](../packages/opencode-hive/docs/HIVE-TOOLS.md#runtime-session-inspection-2-tools).

## Multi-repo projects

Single-repo projects use the normal git-root path. Hive manages multi-repo topology and uses a composite workspace with one checkout per selected repository.
