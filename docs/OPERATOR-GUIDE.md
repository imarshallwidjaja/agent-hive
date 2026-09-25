# Operator Guide

This guide covers day-to-day work after installation. Use the [root README](../README.md) for first setup, the [plugin README](../packages/opencode-hive/README.md) for command and configuration details, and [Hive Tools](../packages/opencode-hive/docs/HIVE-TOOLS.md) for tool contracts.

## Mental model

Agent Hive separates decisions from execution:

- **You** set direction, review the plan, answer blockers, and approve risk.
- The **primary agent** turns the request into a plan and orchestrates the work.
- **Researchers and reviewers** inspect code, plans, or review evidence.
- **Workers** implement assigned tracked Git work in matching feature-task or ad-hoc worktrees; non-Git or report-only work follows the direct-work exceptions.
- **`.hive/`** stores durable plans, task state, reports, and comments.

Approve a feature plan before asking for feature implementation. Approval and task sync guide the agents; they are not runtime admission gates for dispatch or task status. `/dash-review` and `/vuln-review` bind to separate review primaries so the agent that wrote the change is not the one judging it.

Tool availability plus instructions govern action. Each Hive tool validates its own operation.

OpenCode owns research integrations and permissions. oc-arkive does not install, register, configure, or alter them. Agents select among capabilities already exposed to their session by operation, source authority, freshness, scope, and permitted effects. If a required capability is absent, they report the evidence gap instead of installing a tool or recreating it through shell commands or ad hoc network requests.

Engineering Judgment is included once in Hive, Architect, Swarm, Hive Builder, Forager, Plan Reviewer, Code Reviewer, Simplicity Reviewer, Approach Advisor, and Dash Reviewer. Hive and Architect apply it to planning; Swarm and Builder apply it to decomposition, handoffs, and integration without gaining implementation authority; Forager and the reviewers apply it within their existing contracts; Approach Advisor uses it for route selection; Dash Reviewer uses it for reviewer selection and synthesis. Scout, Hive Helper, both vulnerability roles, and trace/tool summarizers do not receive this shared block.

## Agents

OpenCode shows these public seats. Dedicated mode (the default) uses `architect-planner` as the default planning seat and `swarm-orchestrator` for execution; `hive-master` is hidden. Unified mode (`"agentMode": "unified"`) makes `hive-master` the default while retaining the split seats. `hive-builder` and the subagents below stay available in both modes.

### Primary seats

**`architect-planner`** exists so feature work can be scoped before anyone writes code. Default seat in dedicated mode, and the one primary agent that can also run as a subagent when another orchestrator needs a plan created or edited. It interviews, writes `plan.md`, and may call one layer of configured Scout, plan-reviewer, or approach-advisor helpers. Those helpers are terminal. "Do X" means "plan X". Architect does not implement, call execution workers, start worktrees, or merge. Planning notes such as `draft` and `overview` use the managed context tools below.

MO: classify the request, clear requirements one gap at a time, then write a worker-executable plan. It stops at an approved plan. Switch to `swarm-orchestrator` (or keep talking to `hive-master` in unified mode) for execution.

**`swarm-orchestrator`** exists so approved feature work can run without owning plan authorship. Dedicated-mode execution seat. It delegates plan changes to `architect-planner`, syncs tasks, starts workers in matching task worktrees, inspects handoffs, merges, and tracks `.hive/` status.

MO: delegate by default. Choose direct work or delegation according to the repository-backed placement policy. One numbered task is one implementation assignment. Worker output is evidence to inspect, not proof that the batch is done.

**`hive-master`** exists for operators who want one feature seat across planning and execution. Unified-mode default. It is phase-aware: no feature or unapproved plan means delegating plan authorship to `architect-planner`; approved tasks mean orchestration.

MO: same situational direct-vs-delegate choice as the split seats. It still waits for your approval before implementation. It can also coordinate ad-hoc work in unified mode; dedicated mode leaves that to `hive-builder`.

**`hive-builder`** exists for bounded work that should not become a feature, plan, or task DAG. It is the dedicated-mode ad-hoc orchestrator and remains available in unified mode. If accepted escalation needs a feature plan, Builder delegates plan authorship to `architect-planner`.

MO: coordinate coherent ad-hoc lanes under the repository-backed placement policy. It does not create feature or task records. Decomposition does not add a blanket approval step. If unresolved contracts, inexpressible handoffs, migration or irreversible risk, or audit/governance needs make the feature workflow materially safer, it recommends escalation. If you reject escalation, it continues ad-hoc only when material scope, contracts, and risks are otherwise resolved; otherwise it asks the concrete blocking question before creating workers.

### Subagents you will see

Primaries launch these. Ask the primary for a named seat when you want that lens. Custom agents in `~/.config/opencode/agent_hive.json` derive from these bases; their descriptions specialize routing within the inherited role and cannot expand its prompt, tool, or permission boundaries.

**`scout-researcher`** retrieves bounded evidence from local code, docs, and external sources. It can summarize facts, trace calls and references, preserve contradictory evidence, and report attributed source recommendations. It does not diagnose observed failures, judge system correctness, decide applicability or tradeoffs, select solutions, edit, implement, or launch other agents. Primaries route by the requested output rather than read-only status: they own synthesis and decisions, check decisive provenance and plausible alternatives, and use Scouts when a real evidence gap makes delegation useful.

**`forager-worker`** implements in the assigned Hive worktree against a written assignment without inventing extra scope. Implementation missions code, run best-effort checks, create the authorized local source commit, and return `sourceCommit` for a legacy single-root workspace or the complete `sourceCommits` map when persisted `repos` are present. A singleton composite scalar is accepted as a merge convenience; multiple repositories still require the complete map. The primary records status and reports with `hive_task_update`. Diagnosis-only missions report evidence, tested and untested hypotheses, a supported conclusion or unresolved status, and requested options without fixing, editing, committing, or using destructive reproduction. It never delegates. Hive git helpers do not auto-commit; worktree execution grants no push, PR, publish, or release authority.

**`plan-reviewer`** exists to catch plans that a worker cannot execute. Core question: can a capable worker run this without getting stuck? It checks work content, references, scope, dependencies, executable verification, and written assumptions. It samples representative task handoffs and path ownership: missing dependencies and unsafe shared-write overlap are blockers. It may report nonblocking coordination observations, but a low parallel task count does not justify rejection. Verdict is OKAY or REJECT based on execution blockers. It does not judge whether the architecture is optimal.

**`code-reviewer`** exists to check an implementation against the task or plan that authorized it. Core question: is this sound for the stated assignment? It maps changed files to requirements, then correctness, tests, risk, and YAGNI. Verdict is APPROVE (including a clean No action result or optional suggestions), REQUEST_CHANGES for a supported material issue, or NEEDS_DISCUSSION for a material unanswered question. It does not review plan readiness or relitigate architecture unless the diff exposes a concrete defect.

**`simplicity-reviewer`** exists as a final deletion-biased pass after the behavior is already in place. It looks for unjustified changed complexity and worthwhile in-scope simplifications that preserve behavior. ALREADY_MINIMAL means no worthwhile simplification was found; MINOR_TWEAKS is optional, while SIMPLIFY recommends a change for the primary to assess. It does not redesign the approach or claim tests passed without evidence.

**`approach-advisor`** exists for "should we do it this way?" questions. Read-only advice on architecture, tradeoffs, stalled debugging direction, and route choice. It recommends one path. It does not implement, approve, reject, patch, or verify.

**`vulnerability-reviewer`** exists to trace attacker-controlled input or capability to concrete impact with local evidence. `/vuln-review` uses it as the specialist base; primaries can also send a scoped security question to the stock seat. It does not exploit systems, edit source, run scanners or shell, or emit a patch.

### Recovery and session authority

`hive-helper` is a runtime-only recovery assistant for merge recovery, state clarification, and safe append-only follow-up inside an approved feature DAG. It is not a seat you start from.

An authenticated helper child can use its configured ordinary and merge-recovery tools, including `hive_worktree_merge` and `hive_status`. Managed context remains unavailable to helpers, and they cannot dispatch native tasks.

After a plugin restart, send a new message in the session so the runtime observes its agent again before using Hive-governed tools.

### Native task handoffs

Each native `task()` invocation has one primary goal and one terminal handoff. Every returned result is terminal, including completed, failed, empty, partial, blocked, unsatisfactory, review-remediation, retry, new-test-evidence, and operator-decision results. Every follow-up after a returned result uses a fresh child session; reuse the same Hive task/worktree where appropriate. Review findings are fresh assignments in the same implementation lane. Compaction re-anchoring of a currently running worker is distinct from follow-up work. Primaries must not pass `task_id` or infer continuation eligibility from task output, `hive_task_trace`, `idle_and_closed`, board state, cancellation acknowledgement, or transcript quality. Pass `task_id` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation; otherwise launch fresh. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer. Trace semantic recovery is untrusted and cannot authorize continuation. A review finding is a fresh native assignment in the same implementation lane.

## Standing Constraints

State a session-wide or feature-scoped constraint once when it spans phases, turns, or delegated assignments. Writing style, quality bar, review criteria, or a named skill you want followed all count. An explicit directive in the current task request can be durable when it governs multiple delegates; a one-assignment instruction stays in that handoff.

The primary agent adds each durable directive verbatim with `hive_constraints_add` before affected dispatch. Default scope is `session`; pass `scope: "feature"` for feature constraints. A repeated identical add is harmless and unrelated entries remain intact. A correction or removal starts with `hive_constraints_read`, then targets the returned stable ID through `hive_constraints_edit`. A whole-register clear uses `hive_constraints_clear` only when you explicitly request it. Edit and clear use revisions so a concurrent change cannot be overwritten. Only primaries can add, edit, or clear. Workers receive the injected register and may read it. Inherited session and feature labels travel with every child captured at dispatch, including `/dash-review` and `/vuln-review` children. If they conflict, the agent surfaces the conflict. If the primary lacks constraint mutation, it keeps the exact directive in each affected handoff and reports that limitation. Do not promote context files into constraints. Task-local requests, examples, and ordinary messages do not belong in the register. Managed context catalogs are untrusted knowledge, not standing constraints.

When an assignment or applicable constraint names a skill, each child independently loads that exact skill with the native `skill` tool before relevant work and follows its instructions. Parent or sibling loads do not count, and similar names do not substitute. Before accepting a returned task result, the primary uses `hive_task_trace` and, when needed, `hive_task_trace_content` to confirm from the forensic timeline that a successful native skill call for every exact requested name occurred before the covered work; a later load does not satisfy the requirement. A self-report is not proof, incomplete trace evidence is unknown rather than proof of omission, and missing, failed, or uncertain evidence is not compliant. If trace tools are unavailable, the primary reports that limitation and does not claim compliance. This contract uses agent instructions and observed tool calls; it is not automatic enforcement and does not prove semantic adherence to the skill.

## Feature selection

| Call | Effect |
|------|--------|
| `hive_feature_select({ feature })` | Set the session route used for omitted feature-scoped calls and child dispatch |
| `hive_feature_select({ feature: null })` | Make omitted calls and child dispatch explicitly featureless, suppressing detected and sole-live fallback |
| explicit `feature` or `name` on a feature-scoped tool | Target only that call without changing the selected session route |

Feature-scoped calls resolve in this order: explicit call target, selected session route (including null), detected feature worktree/path, then the sole live feature. The same effective route is captured for child dispatch. Only `hive_feature_select` changes the selected route; feature creation, explicit targets, and feature-task worktree lifecycle calls do not. Create a task worktree with an explicit feature target, then select that feature immediately before native worker dispatch. One primary can manage multiple plans this way while each plan and worker assignment remains scoped to one feature.

## Managed context

Project knowledge lives at `.hive/context/`. Feature knowledge lives under `.hive/features/<name>/context/`. Catalogs and bodies are untrusted knowledge, not AGENTS.md or policy.

Use `hive_context_read` to select documents from the catalog by `description` and `read_when`. Finish named-read chunks before replacing a document. For replacement, append, or selective archive, read first and supply the returned revision and content hash; creation of a missing document does not need those preconditions. The catalog lists durable notes only; `evidence` notes remain readable by name, and only durable notes count toward context hygiene thresholds. Neither kind is injected into task prompts. Foragers and reviewers can write project and feature context; Scout is read-only and archive is primary-only. Load `context-engineering` for catalog selection and hash-guarded mutation.

## Choose a workflow

| Workflow | Use it when | Start |
|----------|-------------|-------|
| `/grill` | You want explicit shared understanding of any supplied context without assuming a software workflow | `/grill <context>` |
| `/interview` | Clarify an idea toward a reliable implementation-brief handoff | `/interview <idea>` |
| Feature | You need a reviewed plan, task dependencies, isolated task worktrees, or a durable execution record | Ask in plain language, or `/hive-plan` |
| Ad-hoc (`hive-builder`) | The work is bounded, is not a feature, and should not create feature or task records | Talk to `hive-builder` (dedicated) or `hive-master` (unified) |
| `/dash-review` | You want a read-only review of a folder, inline text, or the current checkout | `/dash-review [intent]` |
| `/vuln-review` | You are authorized to assess the source and want a read-only security review | `/vuln-review [intent]` |
| `complexity-review` | You explicitly want a one-shot complexity review | `/complexity-review <scope/philosophy prose>` |
| `complexity-audit` | You explicitly want a one-shot complexity audit | `/complexity-audit <scope/philosophy prose>` |

`/council` is a lighter read-only advice run. It does not replace dash-review or vuln-review.

`/grill` and `/interview` share the same one-question-at-a-time interaction engine. `/grill` ends at explicit alignment on the supplied context. `/interview` keeps questions implementation-oriented and prepares context for the separate `/implementation-brief` command rather than producing that full brief. They do not automatically create a plan, implement, or start follow-on work; confirmed alignment ends the interaction, and later action requires a separate operator request. A named destination authorizes writing only the confirmed alignment brief there. Neither command uses a fixed question count or forced research fan-out. Unavailable or failed research is disclosed as unresolved or an explicit assumption; it is never guessed.

## Worktrees

`hive_worktree_create` / `inspect` / `merge` / `cleanup` cover feature-task Git workspaces. `hive_adhoc_worktree_create` / `inspect` / `merge` / `cleanup` cover ad-hoc Git workspaces. Ad-hoc worktrees are temporary workspace metadata only. Use a concise goal-based kebab-case `runId` for ad-hoc creation; it becomes the branch suffix.

Git helpers do not change task status, auto-commit source, or assign workers. A worktree implementation assignment explicitly authorizes committing assigned changes. A legacy single-root worker returns the exact `sourceCommit` SHA; a composite worker returns the complete `sourceCommits` map keyed by persisted repository ID. The primary or helper passes that topology-aware pin unchanged to merge. A singleton composite also accepts a matching scalar convenience; multiple repositories still require the complete map. In-place and diagnosis-only missions do not authorize commits. Orchestration merge via `hive-helper` owns integration. Canonical workspace names are metadata; existing slotted or composite workspaces are selectable. Merge wants a clean source, a destination with no staged, unstaged tracked, unmerged, or active Git-operation state, squash default, and an explicit message. Disjoint untracked or ignored destination files are eligible when the pinned source contains the pinned target history; rebase also requires a linear replay range. Unsafe topology with local data returns `TARGET_RECONCILIATION_REQUIRED` with `reconcile_target` and requires same-worktree reconciliation with fresh pins, even when Git reports a clean worktree because Hive state, dependencies, or build output is ignored. Incoming path collisions always block. Hive preflight and rechecks protect local data without relying on Git merge flags. Do not delete local state to make a retry pass. Locks are operation-local. Dirty, untracked, ignored, and unmerged data is protected; there is no force or rm fallback. Same-call squash cleanup may use observed identity; later ambiguous branches stay unless `discard: true` is explicit. `deleteBranch` alone does not discard an unmerged branch. Composite partial outcomes are not rolled back.

Start every writing lane with inspect and record the intended destination `{ path, ref, commit }` in its handoff and task report. Reinspect after each writing handoff, before review or remediation, after known sibling integration or destination movement, and before final integration. Merge requires that exact `expectedTarget` or complete `expectedTargets` map; Hive never silently refreshes it. Long workers check at coherent committed milestones before another substantial chunk and before terminal return.

If no destination work is missing, proceed. Bounded work may continue through demonstrably independent drift when the reason and next checkpoint are recorded. Relevant, overlapping, or uncertain drift must be reconciled before more substantial implementation, remediation, final review, or integration. Investigate a wrong path/ref, no common ancestor, comparison error, or unexplained source movement. Reconcile only after the previous writer is truly terminal: verify the same worktree is registered and clean, preserve ignored dependency/build files, merge the pinned destination commit normally, resolve and adapt, review prior work plus the refreshed delta, run relevant checks, and return fresh source pins and the target identity used. Do not treat cancellation acknowledgement as termination, use Hive's `rebase` strategy for source refresh, replace the worktree for ordinary content conflicts, or retry a preserved destination conflict with a refreshed expectation. Composite operations use complete maps and may retain earlier repository integrations when a later repository fails.

Parent chooses direct work or delegation according to the repository-backed placement policy. Feature work uses a matching task worktree for tracked Git writes.

### Repository-backed placement

Before a non-trivial writing lane, resolve repository ownership. In ad-hoc work, call `hive_repositories_status` once per execution batch unless repository scope is already explicit, then pass only the returned repository IDs owned by the current lane; use all returned IDs only for genuinely cross-repository work. Feature-task execution may reuse declared task repositories.

Use the matching Hive worktree for tracked Git writes: feature-task worktree when a task exists, ad-hoc otherwise. If creation fails, correct the invocation or report the blocker; never fall back to the canonical checkout. When persisted `repos` are present, use the complete map keyed by repository ID; a singleton composite also accepts a matching scalar convenience, while multiple repositories require the complete map. A legacy single-root workspace uses the exact scalar pin. Pass the selected pin unchanged to merge. Complete verification, status/diff inspection, squash merge by default, and cleanup after successful integration. Mark feature tasks done only after merge. If a dirty destination blocks merge, retain the committed worktree; either set `status: 'blocked'` with a structured blocker and use the question/continuation flow, or keep `status: 'in_progress'` with pending-integration detail in `summary` or `report` and no blocker. Ad-hoc work reports integration pending and retains the run. Direct checkout is limited to an explicit operator request to continue specific existing uncommitted changes plus confirmation that the scoped edit will not overwrite unrelated changes, small mechanical edits on a clean checkout without delegated writers or overlap, non-Git/report-only/external-only work, or work already inside the matching Hive worktree. A dirty checkout alone does not justify direct checkout.

## Verification and acceptance

Select checks from the changed behavior, its risk boundaries, binding repository and operator requirements, canonical test owners, and affected consumers. Keep repository-required checks and approved early, feasibility, or pre-merge gates at their stated boundary. A check needed before merge remains in the task's `Verify`, even when an integrated check will run later. Reconcile final obligations before calling `hive_feature_complete`; the tool does not enforce verification gates.

When the repository has no gate catalogue, inspect its scripts, CI workflows, and test owners. If consumer reach or impact cannot be bounded, choose a broader coherent existing check and name any missing check. Do not turn uncertainty into an empty green result.

Task checks and integrated acceptance answer different questions. A task may verify its branch before merge. If it defers an integrated-only behavior, name that deferral in the task and repeat it under `## Final Verification` with the owner, prerequisite, exact command, and expected signal. For example, a shared DTO task can run its owner suite before merge and name the CLI consumer suite as an integrated deferral. Final verification then identifies the CLI owner, the prerequisite that the DTO is integrated, the repository command, and the expected compatibility result. A required schema-feasibility check remains a pre-merge task gate. The same suite may run at both boundaries when each run proves a distinct candidate or claim.

Live checks can share a batch only when their prerequisites, fixtures, and mutable state are compatible. Sequence checks that share state or require different setup. Binding repository/operator checks still run even when the plan selects narrower checks for change-specific impact.

For every passing result, capture actual command output or tool evidence and identify the tested candidate: its ref/commit, relevant dirty changes, and mutable fixtures, configuration, toolchain, generated artifacts, or live state. Worker output is attributed evidence; prose alone does not establish a pass. A trace can expose source-backed tool output but cannot attest the tested Git candidate or current live state. A branch result never proves integrated acceptance. Evidence does not expire because a session changed; later changes matter only when they affect the candidate or relevant inputs. When preserving a result across changes, record a short, concrete reason it remains applicable.

After a correction, retain the original failure and verify the owning regression. Rerun affected owner, consumer, and integrated checks; preserve unaffected results only with a short non-impact reason. An unexplained green retry does not resolve an intermittent failure. Required skipped, unrun, failed, or blocked checks are not passing. If output or applicability is missing, run the required check on the current target or report the result as unverified/blocked. Stop once applicable required evidence and reviews suffice; run additional checks only for a named gap, invalidation, or new risk.

## Tasks and reports

`hive_task_update` takes optional `status`, `summary`, `blocker`, and `report` string. Omissions are preserved. Report is stored as numeric history plus latest. An explicit status leaving blocked clears the blocker. Partial writes: inspect before retry; there is no journal.

Plans, approval, and dependencies guide work and status visibility. They are not dispatch or status admission gates. Approval and task sync are per-feature. Cross-feature overlap or activity does not block approval; concrete prerequisites block the affected execution tasks or lanes unless they leave the plan materially unresolved. Unresolved plan comments still block approval. Hive does not infer cross-feature dependencies. Structural missing refs and cycles remain invalid.

For a plan-backed task with missing or incorrect repository metadata, amend the plan and run `hive_tasks_sync({ refreshPending: true })` before worktree creation. For an incorrectly scoped manual task, automatically replace and cancel it only when no work has started and no existing task depends on it; the replacement mirrors incoming `dependsOn` and supplies corrected `repos` via `hive_task_create(...)`. If work started or reverse dependents exist, retain the incorrect task as blocked with a structured blocker and escalate; do not rewrite dependencies.

When a worker is blocked: record blocked status and blocker, ask via `question()`, then update with an explicit status leaving blocked. Put the decision in the next worker prompt. Do not reconstruct blocker details from worker prose.

## Ad-hoc work

For ad-hoc work with multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, possible background execution, or an expected need for more than one worker attempt or turn, load `orchestrating-ad-hoc-work` before worktree create or delegated dispatch.

1. **Inspect and classify.** Stay ad-hoc unless the feature workflow is materially safer; resolve repository ownership before non-trivial writing lanes.
2. **Place and delegate.** Use `hive_adhoc_worktree_create` for tracked Git writes, then dispatch Foragers with the topology-aware return contract: `sourceCommit` for legacy single-root workspaces and the complete `sourceCommits` map when persisted `repos` are present. A singleton composite scalar is accepted as a merge convenience; multiple repositories require the complete map. Scouts research. Reviewers check settled results.
3. **Verify, integrate, and clean up.** Inspect the committed worktree, pass its returned source pin and target identity unchanged to `hive_adhoc_worktree_merge`, use squash by default, then call `hive_adhoc_worktree_cleanup`. Keep a committed worktree when destination drift or dirt leaves integration pending.

After reviewing ad-hoc work, give any fix instruction to the active ad-hoc primary: `hive-builder` in dedicated mode or `hive-master` in unified mode.

## Background board

Background board tools are enabled when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` has a truthy value; empty, `0`, `false`, and `no` disable the gate. Primary background guidance also requires `background-delegation` to be available. The primary loads that skill for scheduling and board protocol. Use `hive_background_status` to inspect jobs, `hive_background_reconcile` or `hive_background_reconcile_batch` to archive terminal or stale observations, and `hive_background_cancel` to request cancellation.

The board observes the originating native parent and call, not the current feature or agent. Stale and unknown observations stay visible. It does not couple to execution, worktree, or task status. Multiple launch observations may exist for one native task identity when explicit runtime-owned interruption recovery is used. If completion lacks a call ID or its identity is ambiguous, record unknown and hint `hive_task_trace`; never guess the latest child. Missing or ambiguous completion identity must not block unrelated dispatch, but ownership-overlapping work still requires inspection or waiting; do not send another prompt or launch another writer. Cancel acknowledgement does not prove the worker stopped. `hive_status` is not that surface.

## Reviews

`/dash-review` and `/vuln-review` are ordinary orchestrators over natural folders, inline text, or the current checkout. Optional `hive_git_snapshot({ directory })` and an ad-hoc worktree cover a foreign PR or ref. They select review lanes by the requested scope and configured reviewer descriptions. Do not silently skip an explicitly requested or configured reviewer. Reviews do not start fixes; give a separate fix request to the active feature or ad-hoc primary.

### Dash review

Ask `/dash-review [intent]` for a read-only review of a path, inline material, or checkout. The review primary returns supported findings by severity with source locations, open questions, and the scope it inspected. A clean in-scope result says `No action`.

### Vulnerability review

Ask `/vuln-review [intent]` for an authorized read-only source review. Give the target and any required specialist in ordinary prose. The review primary compares a prior report only when you supply it through readable input. It reports evidenced attacker-to-impact paths, affected locations, confidence, and coverage gaps. It does not exploit live systems or begin remediation.

### Complexity passes

`/complexity-review <scope/philosophy prose>` and `/complexity-audit <scope/philosophy prose>` are native skill commands. A review uses an explicit diff or bounded named scope, or current staged, unstaged, and relevant nonignored untracked changes when scope is absent; an empty review stops and never widens to an audit. An audit uses named roots or codebases, or the current worktree when roots are absent. Both report complexity findings and do not apply fixes. Command prose supplies scope, philosophy, and preferences.

Slash-command arguments for these native skills are interpolated into the skill template. `$$`, `$&`, `` $` ``, and `$'` are replacement sequences, and `` !`command` `` is expanded by the shell. For a literal snippet that contains those, use ordinary conversation and name the requested skill instead.

## Upgrade

Before upgrading, remove `disableMcps`, `sandbox`, `dockerImage`, and `persistentContainers` from `~/.config/opencode/agent_hive.json`. Strict validation rejects those removed keys. Configurations created by earlier versions contain `disableMcps` and `sandbox` by default. While any of those keys remain, Hive ignores the whole global configuration, and repository and worktree tools fail with an invalid-config error.

Restart OpenCode after upgrade. Finish or abandon old live workers first. Remove stale copied user-authored workflow instructions yourself; Hive does not silently overwrite global settings. Old attempt and lease files are left unread. Useful plans, tasks, context, reports, and workspace files remain readable.
