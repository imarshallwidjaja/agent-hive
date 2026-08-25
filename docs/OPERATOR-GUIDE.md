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

MO: inspect, classify direct vs delegated work, isolate in an ad-hoc worktree, delegate non-trivial work, verify, inspect status/diff, commit, merge, cleanup. It does not create feature or task records. If a durable plan, task dependencies, or an audit trail would actually help, it asks before escalating; if you say no, it stays ad-hoc.

### Subagents you will see

Primaries launch these. Ask the primary for a named seat when you want that lens. Custom agents in `~/.config/opencode/agent_hive.json` derive from these bases; they are routing specialists, not a reason to pick a stronger model.

**`scout-researcher`** exists so primaries do not wander the tree themselves. Read-only research: local code, docs, and external lookup. It answers one assigned question, parallelizes independent evidence, and returns partial findings plus next-slice recommendations when the question will not fit one context window. It does not edit, implement, or launch other agents.

**`forager-worker`** exists so implementation happens in isolation, against a written assignment, without the worker inventing extra scope. It codes in a task or ad-hoc worktree, runs best-effort checks, and commits through the Hive worktree tools. It never delegates. If three approaches fail, it stops and reports blocked instead of improvising a fourth.

**`plan-reviewer`** exists to catch plans that a worker cannot execute. Core question: can a capable worker run this without getting stuck? It checks work content, references, scope, dependencies, executable verification, and written assumptions. Verdict is OKAY or REJECT. It does not judge whether the architecture is optimal.

**`code-reviewer`** exists to check an implementation against the task or plan that authorized it. Core question: is this sound for the stated assignment? It maps changed files to requirements, then correctness, tests, risk, and YAGNI. Verdict is APPROVE, REQUEST_CHANGES, or NEEDS_DISCUSSION. It does not review plan readiness or relitigate architecture unless the diff exposes a concrete defect.

**`simplicity-reviewer`** exists as a final deletion-biased pass after the behavior is already in place. Core question: is the completed change as simple as it can safely be? It looks for YAGNI, dead code, duplication, and extra abstractions. It does not redesign the approach or claim tests passed without evidence.

**`approach-advisor`** exists for "should we do it this way?" questions. Read-only advice on architecture, tradeoffs, stalled debugging direction, and route choice. It recommends one path. It does not implement, approve, reject, patch, or verify.

**`vulnerability-reviewer`** exists to trace attacker-controlled input or capability to concrete impact with local evidence. `/vuln-review` uses it as the specialist base; primaries can also send a scoped security question to the stock seat. It does not exploit systems, edit source, run scanners or shell, or emit a patch.

`hive-helper` is a runtime-only recovery assistant for merge recovery, state clarification, and safe append-only follow-up inside an approved feature DAG. It is not a seat you start from.

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

## Feature lifecycle

### 1. Discuss and plan

Describe the outcome, constraints, and important context in plain language. The primary agent researches where needed and writes the feature plan.

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

Merge completed task branches after inspecting their output. Then run fresh build/test verification against the merged result. Mark the feature complete only after that merged-result verification passes.

## Ad-hoc lifecycle (`hive-builder`)

Use this when the change is real work (isolation, delegation, verification, merge) but does not deserve a feature record.

1. **Inspect and classify.** `hive-builder` gathers enough context to decide direct work vs a delegated lane. Direct work stays tiny: setup, one bounded read, one bounded write, or one cheap check.
2. **Isolate.** Non-trivial writes go into an ad-hoc worktree under `.hive/.worktrees/adhoc/<runId>`. These runs do not appear in `hive_status` and do not create `plan.md` or tasks.
3. **Delegate.** Scouts research. Foragers implement. Reviewers check the result. Each native `task()` launch is one primary goal and one terminal handoff.
4. **Verify.** Relevant checks run before merge. Unverified integration needs an explicit operator instruction after the risk is reported.
5. **Inspect, merge, cleanup.** Default integration is squash with a polished message. Cleanup removes the ad-hoc worktree and branch.

After a `/dash-review` or `/vuln-review` on ad-hoc work, give any fix instruction to `hive-builder`. Findings are review context, not auto-created tasks.

If the request grows task dependencies, a reviewed plan, or a durable audit trail, `hive-builder` should ask before opening a feature. Tool contracts: [Ad-hoc Worktree](../packages/opencode-hive/README.md#ad-hoc-worktree).

## `/dash-review`

Use this when you want a read-only second opinion without starting a fix.

1. Git review: run `/dash-review`, provide an exact GitHub PR URL, or describe the current Git target. A PR fixes Git evidence. Empty arguments can resolve only Git evidence.
2. Process or concept review: provide nonempty natural-language intent. Stage A can select inline evidence with subject kind `process`, `concept`, or `general`; this uses advisory lanes rather than implementation severity semantics.
3. Local files: repeat `--artifact <project-relative-file>`. Example: `/dash-review review these outputs --artifact reports/result.bin --artifact notes/review.txt`. Artifact paths come only from the command packet. They cannot be supplied later by a model. One bundle accepts at most 32 files, 16 MiB per file, and 32 MiB total.
4. One invocation resolves one evidence kind. PR plus artifact, arbitrary URL evidence, absolute/private/traversing paths, symlinks, and mixed kind-specific fields fail before acquisition.
5. Git freezes under `.hive/.worktrees/review/<runId>`. Inline and artifact evidence freezes under `.hive/.worktrees/review-evidence/<runId>`. The primary claims, reviewers read only that absolute workspace, then the primary inspects and cleans it.
6. The response includes scope/source/resolution fingerprints, requested questions answered, limitations, integrity, and cleanup. Git/code review remains findings-first. Process/concept review leads with direct answers and advice.
7. If you want a fix, ask the feature orchestrator or `hive-builder` later. Dash-review writes no source, Hive tasks, commits, patches, or report file.

`/vuln-review` remains Git-only. It rejects inline and artifact evidence before `BOUNDED`. Tool details and lane contracts: [Operator Commands](../packages/opencode-hive/README.md#operator-commands).

## `/vuln-review`

Use this for authorized static review of source you are allowed to assess. It is a findings-first pass over one frozen snapshot, not a pentest and not a substitute for SAST, DAST, or an audit.

1. Run `/vuln-review` with free text, flags, both, or nothing. Flags are fixed overrides. Whole-repository scope needs `--whole-repo` or an explicit yes to that inferred expansion.
2. Resolve returns `BOUNDED`, `NEEDS_CLARIFICATION`, or `STOP`. Clarification asks one Yes/No question. Only the stored accepted candidate can be materialized.
3. Investigate runs a mandatory baseline plus at most two specialist lenses chosen from the observed attack surface. A falsifier then challenges every candidate, including the hypothesis that nothing actionable exists in scope.
4. The report stays in the OpenCode session. No report file, SARIF, patch, or Hive task is written. Confirmed findings include evidence, attacker-to-impact path, and fix direction without a patch.
5. Remediation is a separate operator instruction to the feature or ad-hoc orchestrator after you accept the risk and the scope.

The workflow does not exploit systems, scan networks, use credentials, install packages, run scanners, edit source, or mutate remote state. A clean scoped result is not a repository-security claim. Intent flags, specialist lenses, and the report schema: [Vulnerability Review](../packages/opencode-hive/README.md#vulnerability-review).

## When work blocks or fails

After a worker fails or reports partial progress, start again through the normal task-start path, [`hive_worktree_start`](../packages/opencode-hive/docs/HIVE-TOOLS.md#worktree-4-tools). This normal path covers retries; it is not restricted to pending or in-progress tasks.

When a worker is blocked, inspect the blocker and make the operator decision. The blocked path, [`hive_worktree_create`](../packages/opencode-hive/docs/HIVE-TOOLS.md#worktree-4-tools), launches a fresh worker in the existing worktree.

## Other review options

- **Plan comments**: review requirements, dependencies, and scope in the plan document or chat before approval.
- **`/council`**: read-only advice about a design or tradeoff. It synthesizes member notes. It does not approve, execute, merge, or freeze a review workspace.

## Background and trace notes

Background execution is optional and experimental. When enabled, wait for the native completion notification, then inspect and reconcile terminal jobs. Background controls do not roll back files, branches, worktrees, commits, or reports. `/dash-review` and `/vuln-review` stay blocking.

Trace output helps inspect delegated work. It is untrusted and does not authorize acceptance, merge, retry, or resume.

## Multi-repo projects

Single-repo projects use the normal git-root path. Hive manages multi-repo topology and uses a composite workspace with one checkout per selected repository.
