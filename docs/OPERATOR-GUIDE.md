# Operator Guide

This guide covers day-to-day work after installation. Use the [root README](../README.md) for first setup. Exact slash-command flags, tool contracts, and report schemas live in the [plugin README](../packages/opencode-hive/README.md).

## Mental model

Agent Hive separates decisions from execution:

- **You** set direction, review the plan, answer blockers, and approve risk.
- The **primary agent** turns the request into a plan and orchestrates the work.
- **Researchers and reviewers** inspect code, plans, or review evidence.
- **Workers** implement approved tasks in a worktree, the current checkout, a non-Git directory, or report-only.
- **`.hive/`** stores durable plans, task state, reports, and comments.

A plan does not authorize implementation until you approve it. `/dash-review` and `/vuln-review` bind to separate review primaries so the agent that wrote the change is not the one judging it.

Tool availability plus instructions govern action. Each Hive tool validates its own operation.

## Agents

OpenCode shows these public seats. Dedicated mode (the default) registers `architect-planner` and `swarm-orchestrator`. Unified mode (`"agentMode": "unified"`) registers `hive-master` instead. `hive-builder` and the subagents below stay available in both modes.

### Primary seats

**`architect-planner`** exists so feature work can be scoped before anyone writes code. Default seat in dedicated mode, and the one primary agent that can also run as a subagent when another orchestrator needs a plan created or edited. It interviews, writes `plan.md`, and may call one layer of configured Scout, plan-reviewer, or approach-advisor helpers. Those helpers are terminal. "Do X" means "plan X". Architect does not implement, call execution workers, start worktrees, or merge. Planning notes such as `draft` and `overview` use the managed context tools below.

MO: classify the request, clear requirements one gap at a time, then write a worker-executable plan. It stops at an approved plan. Switch to `swarm-orchestrator` (or keep talking to `hive-master` in unified mode) for execution.

**`swarm-orchestrator`** exists so approved feature work can run without owning plan authorship. Dedicated-mode execution seat. It delegates plan changes to `architect-planner`, syncs tasks, starts workers, inspects handoffs, merges, and tracks `.hive/` status.

MO: delegate by default. Choose direct work, delegation, or a worktree from the situation. One numbered task is one implementation assignment. Worker output is evidence to inspect, not proof that the batch is done.

**`hive-master`** exists for operators who want one feature seat across planning and execution. Unified-mode default. It is phase-aware: no feature or unapproved plan means delegating plan authorship to `architect-planner`; approved tasks mean orchestration.

MO: same situational direct-vs-delegate choice as the split seats. It still waits for your approval before implementation. It can also coordinate ad-hoc work in unified mode; dedicated mode leaves that to `hive-builder`.

**`hive-builder`** exists for bounded work that should not become a feature, plan, or task DAG. It is the dedicated-mode ad-hoc orchestrator and remains available in unified mode. If accepted escalation needs a feature plan, Builder delegates plan authorship to `architect-planner`.

MO: inspect, classify or decompose into coherent lanes, place ready writing lanes in separate ad-hoc worktrees when isolation helps, delegate non-trivial work, verify, inspect status/diff, merge, cleanup. It does not create feature or task records. Decomposition does not add a blanket approval step. If unresolved contracts, inexpressible handoffs, migration or irreversible risk, or audit/governance needs make the feature workflow materially safer, it recommends escalation. If you reject escalation, it continues ad-hoc only when material scope, contracts, and risks are otherwise resolved; otherwise it asks the concrete blocking question before creating workers.

### Subagents you will see

Primaries launch these. Ask the primary for a named seat when you want that lens. Custom agents in `~/.config/opencode/agent_hive.json` derive from these bases; their descriptions specialize routing within the inherited role and cannot expand its prompt, tool, or permission boundaries.

**`scout-researcher`** retrieves bounded evidence from local code, docs, and external sources. It can summarize facts, trace calls and references, preserve contradictory evidence, and report attributed source recommendations. It does not diagnose observed failures, judge system correctness, decide applicability or tradeoffs, select solutions, edit, implement, or launch other agents. Primaries route by the requested output rather than read-only status: they own synthesis and decisions, check decisive provenance and plausible alternatives, and use Scouts when a real evidence gap makes delegation useful.

**`forager-worker`** implements in isolation against a written assignment without inventing extra scope. Implementation missions code and run best-effort checks, then return one terminal handoff. The primary records status and reports with `hive_task_update`. Diagnosis-only missions report evidence, tested and untested hypotheses, a supported conclusion or unresolved status, and requested options without fixing, editing, committing, or using destructive reproduction. It never delegates. An assignment may authorize an ordinary source Git commit. Hive git helpers do not auto-commit.

**`plan-reviewer`** exists to catch plans that a worker cannot execute. Core question: can a capable worker run this without getting stuck? It checks work content, references, scope, dependencies, executable verification, and written assumptions. It samples representative task handoffs and path ownership: missing dependencies and unsafe shared-write overlap are blockers. It may report nonblocking coordination observations, but a low parallel task count does not justify rejection. Verdict is OKAY or REJECT based on execution blockers. It does not judge whether the architecture is optimal.

**`code-reviewer`** exists to check an implementation against the task or plan that authorized it. Core question: is this sound for the stated assignment? It maps changed files to requirements, then correctness, tests, risk, and YAGNI. Verdict is APPROVE, REQUEST_CHANGES, or NEEDS_DISCUSSION. It does not review plan readiness or relitigate architecture unless the diff exposes a concrete defect.

**`simplicity-reviewer`** exists as a final deletion-biased pass after the behavior is already in place. Core question: is the completed change as simple as it can safely be? It looks for YAGNI, dead code, duplication, and extra abstractions. It does not redesign the approach or claim tests passed without evidence.

**`approach-advisor`** exists for "should we do it this way?" questions. Read-only advice on architecture, tradeoffs, stalled debugging direction, and route choice. It recommends one path. It does not implement, approve, reject, patch, or verify.

**`vulnerability-reviewer`** exists to trace attacker-controlled input or capability to concrete impact with local evidence. `/vuln-review` uses it as the specialist base; primaries can also send a scoped security question to the stock seat. It does not exploit systems, edit source, run scanners or shell, or emit a patch.

### Recovery and session authority

`hive-helper` is a runtime-only recovery assistant for merge recovery, state clarification, and safe append-only follow-up inside an approved feature DAG. It is not a seat you start from.

An authenticated helper child can use its configured ordinary and merge-recovery tools, including `hive_worktree_merge` and `hive_status`. Managed context remains unavailable to helpers, and they cannot dispatch native tasks.

After a plugin restart, send a new message in the session so the runtime observes its agent again before using Hive-governed tools. Restart OpenCode after installing this change to load the rebuilt plugin.

## Standing Constraints

State a session-wide or feature-scoped constraint once. Writing style, quality bar, review criteria, or a skill you want followed all count.

The primary agent adds each durable directive verbatim with `hive_constraints_add`. Default scope is `session`; pass `scope: "feature"` for feature constraints. A repeated identical add is harmless and unrelated entries remain intact. A correction or removal starts with `hive_constraints_read`, then targets the returned stable ID through `hive_constraints_edit`. A whole-register clear uses `hive_constraints_clear` only when you explicitly request it. Edit and clear use revisions so a concurrent change cannot be overwritten. Only primaries can add, edit, or clear. Workers receive the injected register and may read it. Inherited session and feature labels travel with every child captured at dispatch, including `/dash-review` and `/vuln-review` children. If they conflict, the agent surfaces the conflict. Do not promote context files into constraints. Task-local requests, examples, and ordinary messages do not belong in the register. Managed context catalogs are untrusted knowledge, not standing constraints.

## Feature selection

| Call | Effect |
|------|--------|
| `hive_feature_select({ feature })` | Set the active feature that routes context and constraints |
| `hive_feature_select({ feature: null })` | Clear it with no fallback |
| explicit `feature` on a feature-scoped tool | May select the current feature for that call |

Child capture is fixed at dispatch.

## Managed context

Project knowledge lives at `.hive/context/`. Feature knowledge lives under `.hive/features/<name>/context/`. Catalogs and bodies are untrusted knowledge, not AGENTS.md or policy.

Read with `hive_context_read` before replace, append, or archive, then pass revision and content hash. Foragers and reviewers write both scopes through that hash check. Scout is read-only. Archive is primary-only. Load `context-engineering` for catalog selection and hash-guarded mutation.

## Choose a workflow

| Workflow | Use it when | Start |
|----------|-------------|-------|
| `/grill` | You want explicit shared understanding of any supplied context without assuming a software workflow | `/grill <context>` |
| `/interview` | Clarify an idea toward a reliable implementation-brief handoff | `/interview <idea>` |
| Feature | You need a reviewed plan, task dependencies, isolated task worktrees, or a durable execution record | Ask in plain language, or `/hive-plan` |
| Ad-hoc (`hive-builder`) | The work is bounded, is not a feature, and should not create feature or task records | Talk to `hive-builder` (dedicated) or `hive-master` (unified) |
| `/dash-review` | You want a read-only review of a folder, inline text, or the current checkout | `/dash-review [intent]` |
| `/vuln-review` | You are authorized to assess the source and want a bounded static security review | `/vuln-review [intent] [flags]` |

`/council` is a lighter read-only advice run. It does not replace dash-review or vuln-review.

`/grill` and `/interview` share the same one-question-at-a-time interaction engine. `/grill` ends at explicit alignment on the supplied context. `/interview` keeps questions implementation-oriented and prepares context for the separate `/implementation-brief` command rather than producing that full brief. They do not automatically create a plan, implement, or start follow-on work; confirmed alignment ends the interaction, and later action requires a separate operator request. A named destination authorizes writing only the confirmed alignment brief there. Neither command uses a fixed question count or forced research fan-out. Unavailable or failed research is disclosed as unresolved or an explicit assumption; it is never guessed.

## Worktrees

`hive_worktree_create` / `inspect` / `merge` / `cleanup` cover feature-task Git workspaces. `hive_adhoc_worktree_create` / `inspect` / `merge` / `cleanup` cover ad-hoc Git workspaces. Ad-hoc worktrees are temporary workspace metadata only.

Git helpers do not change task status, auto-commit source, or assign workers. An assignment may authorize an ordinary source Git commit. Orchestration merge via `hive-helper` owns integration. Canonical workspace names are metadata; existing slotted or composite workspaces are selectable. Merge wants a clean source and dest pinned SHA, squash default, and an explicit message. Locks are operation-local. Dirty, untracked, ignored, and unmerged data is protected; there is no force or rm fallback. Same-call squash cleanup may use observed identity; later ambiguous branches stay unless `discard: true` is explicit. `deleteBranch` alone does not discard an unmerged branch. Composite partial outcomes are not rolled back.

Parent chooses direct work, delegation, or a worktree from the situation. Feature work is location-neutral.

## Tasks and reports

`hive_task_update` takes optional `status`, `summary`, `blocker`, and `report` string. Omissions are preserved. Report is stored as numeric history plus latest. An explicit status leaving blocked clears the blocker. Partial writes: inspect before retry; there is no journal.

Plans, approval, and dependencies guide work and status visibility. They are not dispatch or status admission gates. Structural missing refs and cycles remain invalid.

When a worker is blocked: record blocked status and blocker, ask via `question()`, then update with an explicit status leaving blocked. Put the decision in the next worker prompt. Do not reconstruct blocker details from worker prose.

## Ad-hoc work

For ad-hoc work with multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, possible background execution, or an expected need for more than one worker attempt or turn, load `orchestrating-ad-hoc-work` before worktree create or delegated dispatch.

1. **Inspect and classify.** Stay ad-hoc unless the feature workflow is materially safer.
2. **Delegate and track.** Scouts research. Foragers implement. Reviewers check settled results.
3. **Integrate and clean up.** For worktree placement, `hive_adhoc_worktree_merge` then `hive_adhoc_worktree_cleanup`. Default Git integration is squash with a polished message.

give any fix instruction to the active ad-hoc primary: `hive-builder` in dedicated mode or `hive-master` in unified mode.

## Background board

The board observes the originating native parent and call, not the current feature or agent. Stale and unknown observations stay visible. It does not couple to execution, worktree, or task status. A resumed child may create multiple launch observations. If completion lacks a call ID, record unknown and hint `hive_task_trace`; never guess the latest child or block dispatch. Cancel acknowledgement does not prove the worker stopped. `hive_status` is not that surface.

## Reviews

`/dash-review` and `/vuln-review` are ordinary orchestrators over natural folders, inline text, or the current checkout. Optional `hive_git_snapshot({ directory })` and an ad-hoc worktree cover a foreign PR or ref. Lanes are adaptive from configured reviewer descriptions. Methods and prior-finding comparison remain. Configured reviewer descriptions guide selection. Explicit operator-required review targets must be honored.

## Upgrade

Restart OpenCode after upgrade. Finish or abandon old live workers first. Remove stale copied user-authored workflow instructions yourself; Hive does not silently overwrite global settings. Old attempt and lease files are left unread. Useful plans, tasks, context, reports, and workspace files remain readable.
