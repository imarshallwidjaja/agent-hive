# oc-arkive

[![npm version](https://img.shields.io/npm/v/oc-arkive)](https://www.npmjs.com/package/oc-arkive)
[![License: MIT with Commons Clause](https://img.shields.io/badge/License-MIT%20with%20Commons%20Clause-blue.svg)](../../LICENSE)

OpenCode workflow plugin for plan-first feature development and ad-hoc work: feature plans, approval and task sync, Git worktrees, durable `.hive/` state, and review commands.

Requires **OpenCode >= 1.18.30** for native task attachment hooks. Open your project and ask Hive to work.

Human onboarding starts in the [root README](../../README.md). This README is the detailed npm and operator reference.

## Install

For a brand-new config, add the plugin to `opencode.json` or `opencode.jsonc`. OpenCode resolves the npm package; you do not need a separate `npm install` for normal use.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-arkive@latest"]
}
```

Restart OpenCode after changing plugins.

### Existing OpenCode configurations

If you already have an OpenCode config, append `oc-arkive@latest` to its existing `plugin` array. Keep your surrounding settings and existing plugin entries, and preserve unrelated settings in the source file. The plugin still intentionally mutates the OpenCode fields listed below. This section is the full compatibility reference; the root README points here instead of repeating these mutations.

Before upgrading, remove `disableMcps`, `sandbox`, `dockerImage`, and `persistentContainers` from `~/.config/opencode/agent_hive.json`. Strict validation rejects those removed keys. Earlier versions wrote `disableMcps` and `sandbox` when they created the file. While any of those keys remain, Hive ignores the whole global configuration, including agent model overrides and custom agents. In projects without `.hive/repositories.json` or a generated `workspace.json`, repository and worktree tools also fail with an invalid-config error that names the file but not the key.

The config hook intentionally mutates these OpenCode fields:

- `default_agent`: selects `hive-master` in unified mode or `architect-planner` in dedicated mode.
- `agent`: Shipped agent IDs are replaced; unrelated agent entries remain. Hive/task/question/skill permission overrides on native `general`/`explore`, plus `explore` edit overrides, are replaced with managed boundaries; warnings name the dropped keys and reason. In dedicated mode, the registered `hive-master` seat is hidden from the agent picker.
- `command`: Shipped command keys replace same-key user command definitions; unrelated command keys remain.
- `subagent_depth`: sets the OpenCode value to `2`.
- `skills.paths`: when Hive skills are materialized, registers the generated Hive skill path first, followed by resolved user-configured paths.
- `experimental.primary_tools`: preserves existing entries and adds `question` and the primary-only Hive operations in the [access matrix](docs/HIVE-TOOLS.md#agent-tool-access).

### Research integrations

Configure research integrations and their permissions in OpenCode. oc-arkive does not install, register, configure, or alter them. Hive agents inspect the capabilities already exposed to their session, select the narrowest suitable interface from its description and schema, and report a missing capability when required evidence cannot be retrieved. They do not install tools or improvise shell or network substitutes.

Default mode is dedicated (`architect-planner` + `swarm-orchestrator`). Set `"agentMode": "unified"` to make `hive-master` the default agent; see [Agent mode](#agent-mode). Runtime settings live in `~/.config/opencode/agent_hive.json`, with a narrow project-local exception for existing agents' `model` and `variant` values in `.hive/agent-hive.override.json`.

## The Workflow

1. **Create feature** - planning flow or `hive_feature_create`; creation does not change the selected session route
2. **Write plan** - target one feature with explicit `hive_plan_write` / `hive_plan_patch` calls
3. **Human review** - comments and chat
4. **Approve + sync** - `hive_plan_approve({ expectedRevision, sync: true })` using the reviewed plan revision; inspect both outcomes
5. **Execute** - create and inspect the matching `hive_worktree_create` workspace with an explicit feature target, record the destination identity, select that feature immediately before dispatch, then issue one ordinary native Forager call
6. **Integrate** - verify the committed source, pass its pin and the inspected destination identity to `hive_worktree_merge`, and clean up the integrated worktree
7. **Record** - the primary calls `hive_task_update` for status, summary, blocker, or report; mark a task done only after integration succeeds
8. **Complete feature** - `hive_feature_complete` when done

Use the feature flow when work needs plan review, a task DAG, and a durable audit trail. Use ad-hoc orchestration for bounded non-feature work that should not create feature or task records. Hive Builder or unified `hive-master` loads `orchestrating-ad-hoc-work` before requests with multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, possible background execution, or an expected need for more than one worker attempt or turn. Parallel writers use distinct ad-hoc worktrees, but fixed-path fixtures, ports, databases, containers, generated outputs, and external mutable resources still require explicit ownership or sequencing. Ad-hoc Git work uses `hive_adhoc_worktree_create`, `hive_adhoc_worktree_inspect`, `hive_adhoc_worktree_merge`, and `hive_adhoc_worktree_cleanup`. `architect-planner` is planning-only. Operator-facing seats and loops are in the [Operator Guide](../../docs/OPERATOR-GUIDE.md).

### Operator Commands

`oc-arkive` registers these slash commands as operator entry prompts. They prepare the active agent with workflow-specific instructions; they do not replace Hive tools or make unavailable tools available to the current agent. `/dash-review` and `/vuln-review` are exceptions: their generated OpenCode commands bind to separate private review primaries.

| Command | Purpose |
|---------|---------|
| `/interview` | Clarify an idea toward a reliable implementation-brief handoff. |
| `/grill <context>` | Reach explicit alignment on any context through material questions and researched facts. |
| `/implementation-brief` | Produce a copy-paste-ready brief for a later Hive plan. |
| `/hive-plan` | Create or update the Hive feature plan from a spec or brief. |
| `/approve-sync-plan` | Approve the active plan and sync executable tasks. |
| `/start-execution` | Start execution for an approved and synced plan. |
| `/council-directive` | Turn rough input into a reusable directive for a council run. |
| `/council` | Run a read-only council and synthesize a recommendation. |
| `/dash-review [intent]` | Review a folder, inline text, or the current checkout without changing source. |
| `/vuln-review [scope]` | Review requested source for evidenced vulnerabilities with configured specialists. |
| `/compact-summary` | Produce a compact recovery summary for the current session. |

### Native Skill Commands

OpenCode exposes these packaged skills as native slash commands. They are not Hive plugin-registered commands. Both are complexity-only passes that report findings and do not apply fixes. Ordinary tooling and delegation contracts apply.

- `/complexity-review <scope/philosophy prose>` reviews an explicit diff or bounded named scope, or current staged, unstaged, and relevant nonignored untracked changes when no scope is supplied. An empty review stops without becoming an audit.
- `/complexity-audit <scope/philosophy prose>` audits named roots or codebases, or the current worktree when no roots are supplied.

`/hive` has been removed. Feature creation now belongs to the planning flow and the Hive tools, usually `hive_feature_create` followed by explicitly targeted plan writes, review, per-feature approval and task sync, execution, and merge.

`/council` accepts `/council --group <group> <directive>`. If `--group` is omitted, Hive uses `council.defaultGroup`. Free-text tokens are directive text, not implicit group selectors.

Routing depends on `agentMode`:

| Command set | Unified mode | Dedicated mode |
|-------------|--------------|----------------|
| `/interview`, `/grill`, `/implementation-brief`, `/hive-plan`, `/council-directive`, `/council` | Use `hive-master`. | Route or delegate to `architect-planner`. |
| `/approve-sync-plan`, `/start-execution` | Use `hive-master`. | Route or delegate to `swarm-orchestrator`. |
| `/dash-review` | Bound by `config.command` to a private review primary. | Bound by `config.command` to a private review primary. |
| `/vuln-review` | Bound by `config.command` to a private vulnerability-review primary. | Bound by `config.command` to a private vulnerability-review primary. |
| `/compact-summary` | Use `hive-master`. | Route or delegate to `scout-researcher`. |

Except for `/dash-review` and `/vuln-review`, dedicated-mode slash commands do not switch agents by themselves. If the active agent is not the route target, delegate or reroute to the target agent and stop if that is not possible.

Use `/interview <idea>` to clarify an idea toward a reliable implementation-brief handoff. It keeps questions implementation-oriented and prepares context for the separate `/implementation-brief` command rather than producing that full brief. Use `/grill <context>` when the endpoint is explicit shared understanding of any topic. Both ask one material question per turn and do not automatically create a plan, implement, or start follow-on work; confirmed alignment ends the interaction, and later action requires a separate operator request. A named destination authorizes writing only the confirmed alignment brief there. Discoverable facts are researched without forced fan-out. Unavailable or failed research is disclosed as unresolved or an explicit assumption; it is never guessed.

Use `/dash-review` for one read-only Git, process/concept, or local-artifact review. It does not edit source, create Hive tasks, or start a fix. See [Reviews in the Operator Guide](../../docs/OPERATOR-GUIDE.md#reviews).

`/dash-review` is a read-only orchestrator over a folder, inline text, or the current checkout. An optional `hive_git_snapshot({ directory })` or operator-selected worktree covers foreign Git evidence. The primary understands the change and consumers before assigning evidence-linked questions to best-fit reviewers, honors required participation, and independently tries to disprove material candidates. Useful, authorized tests and source evidence determine whether findings survive; unresolved material gaps remain visible. It does not edit source, create Hive tasks, or start a fix; findings remain review context. Use `pr-writing` to draft grounded PR titles, descriptions, and review comments without posting them.

For an ad-hoc run, review the existing run or branch, then give a later fix instruction to the ad-hoc orchestrator. For a Hive feature run, review the task, feature, or branch, then give the active planner or orchestrator a later fix instruction.

Background instructions appear only when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` has a truthy value (empty, `0`, `false`, and `no` keep the gate closed) and the bundled background protocol is available. Use the [Background Orchestration](#background-orchestration) section and the `background-delegation` skill for the scheduler protocol. The `/dash-review` command template does not add background instructions, though its private primary has access to the background board tools when the gate is open ([command renderer](src/commands/renderers.ts), [runtime grants](src/runtime.ts)).

### Vulnerability Review

Use `/vuln-review` with a source scope in ordinary language, for example `/vuln-review review the authentication boundary changed in this branch`. The private review primary accepts the requested checkout, folder, paths, inline evidence, or an optional Git snapshot through ordinary tools. For a foreign Git root, `hive_git_snapshot({ directory })` takes an absolute path to its exact Git top-level. A prior report can be compared when you supply it as readable input. See [Reviews in the Operator Guide](../../docs/OPERATOR-GUIDE.md#reviews).

The primary selects configured `vulnerability-reviewer` specialists by description and dispatches every explicitly requested configured specialist. It preserves the source fingerprint when it uses a Git snapshot. The report leads with deduplicated, severity-ordered findings backed by an attacker-to-impact path, confidence, affected locations, and root cause; it also states unresolved leads and coverage gaps. With no confirmed findings, it says "No confirmed vulnerabilities found in reviewed scope." A clean result applies only to the reviewed scope, not repository security ([reviewer contract](src/agents/vulnerability-reviewer.ts)).

External research may receive only public dependency names and versions or public advisory IDs such as CVE and GHSA IDs. Never send proprietary source, symbols, paths, configuration, logs, or stack traces to external tools ([reviewer contract](src/agents/vulnerability-reviewer.ts)). Findings stay in session history; the command writes no report file. The private primary has edit permission denied and does not begin remediation in the first response ([runtime grants](src/runtime.ts), [primary prompt](src/agents/vulnerability-review-primary.ts)).

### Planning-mode delegation

During planning, "don't execute" means "don't implement" (no code edits, no worktrees). Read-only exploration is explicitly allowed and encouraged, both via local tools and by delegating to a researcher.

When delegation is warranted, synthesize the task before handing it off: name the file paths or search target, state the expected result, and say what done looks like. Workers do not inherit planner context.

Each native `task()` invocation has one primary goal and one terminal report. Every returned result is terminal, including completed, failed, empty, partial, blocked, unsatisfactory, review-remediation, retry, new-test-evidence, and operator-decision results. Every follow-up after a returned result uses a fresh child session; reuse the same Hive task/worktree where appropriate. Review findings are fresh assignments in the same implementation lane. Compaction re-anchoring of a currently running worker is distinct from follow-up work. Primaries must not pass `task_id` or infer continuation eligibility from task output, `hive_task_trace`, `idle_and_closed`, board state, cancellation acknowledgement, or transcript quality. Pass `task_id` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation; otherwise launch fresh. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer. Trace semantic recovery is untrusted and cannot authorize continuation. A primary goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step. Give complete constraints and acceptance criteria only for that goal, then split independently verifiable outcomes into fresh launches. Returned IDs are also observe-only handles for status, reconciliation, cancellation, and runtime-visible session trace inspection. An orchestrator delegates plan creation or editing to `architect-planner`; Architect may call one layer of configured Scout, plan-reviewer, or approach-advisor helpers.

One implementation assignment normally maps to one numbered task. Amend the DAG or create an append-only manual task for a new independent deliverable. A blocked feature continuation follows `hive_task_update` with blocked status and blocker, the operator decision, then `hive_task_update` with an explicit status leaving blocked. Failed or retry work starts a new worker with a concise self-contained handoff. For ad-hoc work, use multiple fresh one-goal launches on worktrees whose registered identities do not intersect, or sequence writers that share a worktree. Architect is the only subagent allowed one terminal layer of read-only planning helpers; every other subagent is terminal. The `question` tool is reserved for primary sessions. Any subagent that needs operator clarification returns the exact question in its terminal response for the parent orchestrator to ask.

For execution work, treat worker output as evidence to inspect, not proof to trust blindly. OpenCode is the supported execution runtime; if you use `vscode-arkive`, treat it as a review/sidebar companion. Read changed files yourself and run the shared verification commands on the main branch before claiming the batch is complete.

When an operator explicitly requires a skill, include the exact name in the assignment or applicable standing constraints. Each child loads it independently before the covered work; a parent load does not count, and a later load does not satisfy the requirement. A named skill alone does not trigger a trace of a successful return. Audit skill loading only for an explicit operator audit request or a concrete concern about material noncompliance. See [Runtime Session Inspection](docs/HIVE-TOOLS.md#runtime-session-inspection-2-tools) for targeted tracing and audit evidence.

### Local skill and model use cases

- **Local skill experiments:** keep a skill in `<project>/.opencode/skills/<id>/SKILL.md` or `<project>/.claude/skills/<id>/SKILL.md`, then load it with OpenCode's native `skill` tool, reference it in agent instructions, or list its frontmatter `name` in `autoLoadSkills`. User file skills are discovered through OpenCode's native `.opencode`, `.claude`, `.agents`, `skills.paths`, and `skills.urls` mechanisms.
- **Runtime configuration:** set global agent models, variants, custom agents, `taskTraceSummarizer`, and skill auto-load settings in `~/.config/opencode/agent_hive.json`. A project may override only `model` and/or `variant` for matching built-in or effective custom-agent declarations in `.hive/agent-hive.override.json`. Global config remains authoritative for all other settings. See [Configuration](#configuration).

#### Canonical Delegation Threshold

- Route by the requested output rather than read-only status or whether paths are already known. Delegate bounded retrieval to a Scout when a real evidence gap makes delegation useful; keep causal diagnosis, correctness judgments, applicability, tradeoffs, and solution selection with the planner or orchestrator.
- Bounded direct reads remain acceptable whether or not the path was known before inspection. Delegate additional retrieval when it closes a named evidence gap.

## Tools

### Enforced agent access

Hive registers ordered OpenCode `agent.permission` rules: `'hive_*': 'deny'` first, then each role's exact allows. Agent rules override global `{"*":"allow"}`. Custom variants inherit their base role. `experimental.primary_tools` adds child-session denials for integration/cleanup, ad-hoc creation, feature routing/completion, approval/sync/task creation, constraint mutation, context archive, parent-owned background tools, and `question`. Architect keeps feature creation, repository registration, and bounded planning-helper delegation as a child and hands primary-only requests back to its parent.

All Hive roles can read context, constraints, plans, status, repository scope, and Git snapshots. Scout adds repository discovery. Forager adds context write/append, feature/ad-hoc inspection, recovery traces, assigned feature-worktree creation, and its own report/handoff update. Helper's Hive tools are limited to state/worktree/trace inspection. Reviewers and advisors add authorized context write/append. Hive, Swarm, and Builder have the full Hive set; Architect has planning and primary-control tools; review primaries have metadata/context, inspection/trace, constraints, routing/background, and authorized ad-hoc review placement/cleanup. The [complete access matrix](docs/HIVE-TOOLS.md#agent-tool-access) names every grant and native boundary.

Native `general`/`explore` have no Hive tools, recursion, or questions. Helper/reviewer role-specific Hive-tool denials and native edit denial are enforced, while shell and research integrations remain available under operator permissions. Their inspection-only scope for shell and external effects is instruction-bound, an operator-accepted risk; these capabilities must not substitute for denied Hive operations. Use Helper first for session-trace retrieval; it returns evidence and mutation requests to the primary. Changes take effect after the OpenCode host reloads; use fresh child sessions so OpenCode applies the creation-time primary-tool denials.

### Feature Management
| Tool | Description |
|------|-------------|
| `hive_feature_create` | Create a new feature without changing the selected session route |
| `hive_feature_complete` | Mark feature as complete |
| `hive_feature_select` | Set or clear the session route used for omitted feature-scoped calls and child dispatch |

### Repository Topology

| Tool | Description |
|------|-------------|
| `hive_repositories_status` | Inspect the active repository mode and manifest |
| `hive_repositories_discover` | Discover repositories in the project |
| `hive_repositories_update` | Add repositories to the project manifest |

### Planning
| Tool | Description |
|------|-------------|
| `hive_plan_write` | Write plan.md |
| `hive_plan_patch` | Apply revision-scoped section/task amendments to plan.md; does not sync tasks automatically |
| `hive_plan_read` | Read plan and comments |
| `hive_plan_approve` | Approve plan for execution |

### Tasks
| Tool | Description |
|------|-------------|
| `hive_tasks_sync` | Generate tasks from plan, or rewrite pending plan tasks with `refreshPending: true` after a plan amendment |
| `hive_task_create` | Create a manual task with explicit `dependsOn` and optional structured metadata |
| `hive_task_update` | Optional status (task status enum), summary, report, and successor handoff strings, and blocker object or null. Omissions are preserved |

### Worktree

| Tool | Description |
|------|-------------|
| `hive_worktree_create` | Create or select a feature-task Git workspace |
| `hive_worktree_inspect` | Inspect a feature-task workspace |
| `hive_worktree_merge` | Integrate an exact task source pin against the inspected destination identity, with merge/squash/rebase strategies, optional conflict preservation, and optional cleanup |
| `hive_worktree_cleanup` | Remove a feature-task worktree |

Git helpers do not change task status, auto-commit source, or assign workers. Before dispatching a writing lane, inspect the worktree and record the intended destination's canonical path, full symbolic ref (or detached `null`), and commit. Reinspect after each writing handoff, before review or remediation, after known destination movement, and before integration. Pass the unchanged identity as `expectedTarget` for a legacy single-root workspace or the complete `expectedTargets` map for a composite. A legacy worker returns `sourceCommit`; a composite worker returns the complete `sourceCommits` map keyed by repository ID. A singleton composite can use a matching scalar pin at merge. Pass the worker's pin unchanged.

Merge requires a clean source and a destination with a clean index and tracked working tree. Disjoint untracked or ignored destination files may remain when the pinned source contains the pinned target history; rebase also requires a linear replay range. Unsafe topology with local data returns `TARGET_RECONCILIATION_REQUIRED` with `reconcile_target` and requires same-worktree reconciliation with fresh pins. Ignored Hive state, dependencies, and build output count as local data even when Git reports a clean worktree. Incoming path collisions always block. Hive preflight and rechecks protect local data without relying on Git merge flags. Dirty, untracked, ignored, and unmerged data is protected; there is no force or rm fallback. Same-call squash cleanup may use observed identity; later ambiguous branches stay unless `discard: true` is explicit. Composite partial outcomes are not rolled back.

For a merge that creates a commit, supply `message` with a one-line subject, a blank line, and a descriptive body. Integration defaults to squash. Rebase does not take a non-blank `message`.

Pass the feature explicitly to `hive_worktree_create`, select that feature immediately before dispatch, then issue one ordinary native Forager call. Blocking and background calls use the native task shape unchanged.

### Status

| Tool | Description |
|------|-------------|
| `hive_status` | Inspect feature, task, dependency, and worktree state |

When a task branch has no net tracked changes to integrate, `hive_worktree_merge` reports a successful no-op: `success: true`, `merged: false`, `reasonCode: 'NO_TRACKED_CHANGES'`, and no empty `sha`. Requested cleanup can still run when safe. Use `hive_status`, not the background board, to decide whether a task has completed work and a live worktree eligible for merge or cleanup.

### Ad-hoc Worktree

Use ad-hoc orchestration when you need delegation, verification, and a managed worktree without a feature, plan, or task record. Dedicated mode uses `hive-builder`; unified mode can use `hive-master`. The operator loop is in the [Operator Guide](../../docs/OPERATOR-GUIDE.md#ad-hoc-work).

| Tool | Description |
|------|-------------|
| `hive_adhoc_worktree_create` | Create a scoped ad-hoc Git workspace |
| `hive_adhoc_worktree_inspect` | Inspect the source and destination identities |
| `hive_adhoc_worktree_merge` | Integrate the pinned source against the inspected destination |
| `hive_adhoc_worktree_cleanup` | Remove the integrated workspace; `discard: true` explicitly retires unintegrated work |

The ad-hoc orchestrator resolves repository ownership with `hive_repositories_status` unless scope is already explicit, then calls `hive_adhoc_worktree_create` with the owned `repoIds` and a meaningful kebab-case `runId` before an ordinary native Forager call. These runs do not create feature/task records and do not appear in `hive_status`. The response supplies the `runId`, placement, and initial inspection. Record its destination identity before dispatch; later inspection checkpoints remain required. Integrate with `hive_adhoc_worktree_merge` using the inspected identity and committed source pin, then clean up with `hive_adhoc_worktree_cleanup`. Ad-hoc worktrees are temporary workspace metadata only. See [Hive Tools](docs/HIVE-TOOLS.md) for the full contracts.

Feature escalation is advisory. If the operator rejects it, continue ad-hoc only when material scope, contracts, and risks are otherwise resolved. Ask any remaining concrete blocking question before creating workers.

Forager is an execution role. Use a matching worktree for tracked Git writes; non-Git or report-only work follows the direct-work exceptions. Direct foreground OpenCode work is unmanaged OpenCode work, not a Hive worktree.

Native `general` is an ordinary delegation with ordinary tools only; it cannot delegate or ask questions. Native helpers retain bounded operational permissions.

### Background Orchestration

With the env gate unset (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`), Hive keeps normal blocking `task()` wait mode. Background board tools report `background_tools_disabled`, and no background appendix is injected into primary prompts.

With the env gate set, board tools are active. Primary orchestrators receive background wait-mode guidance when `background-delegation` is available. This is the background-first scheduler contract under the experimental gate, not always-on behavior. It does not add agents or change custom-agent preservation: primary agents still choose built-in or configured custom specialists by descriptor, not by a fixed routing table.

Gate-open orchestration uses lane kind to decide how much management is needed. Exploratory/read-only and review lanes are lightweight background candidates. Writing/change and execution lanes require state tracking, verification routing, unresolved-lane checks, integration control, and a context packet. Declared file ownership is tracking metadata, not a concurrency guarantee. See `docs/HIVE-TOOLS.md` and the `background-delegation` skill for the full scheduler protocol.

With the env gate set, primary agents can launch independent native background tasks when useful foreground work can continue, inspect the scoped board with `hive_background_status`, wait for OpenCode's native completion notification, refresh `hive_background_status`, reconcile terminal jobs with `hive_background_reconcile` or `hive_background_reconcile_batch`, and request cancellation with `hive_background_cancel`. Reconciliation archives terminal jobs and hides them from normal status output; agents should not edit `.hive/background-jobs.json` directly. Wait-only scheduler guidance from status means wait for the native notification instead of refreshing repeatedly.

`hive_background_status` returns board-local scheduler outputs such as `recommendedNextAction` and `requiresHiveStatusRefresh`. Reconciliation returns compact per-item acknowledgements with failure hints and a refresh flag when an archived job had feature/task scope; a batch requests refresh when any successful item does. Refresh `hive_status` when requested and before dependent task or merge decisions.

Prompt acknowledgment only means Hive showed a terminal result to the parent session. It does not clear `terminalUnreconciled`; the primary agent still reconciles or ignores the job after consuming the result.

Cancellation is not rollback. A cancellation request does not revert files, branches, worktrees, commits, or reports. Cancel is unavailable without a real native identity. Cancellation is owner-scoped; another primary must not automatically terminate another primary's child. Cancel acknowledgement is not proof of termination. Board rows without a native task ID stay on the board as observational bookkeeping; archive, reconcile, and ignore do not stop execution. The board observes the originating native parent and call. Stale and unknown observations stay visible. Multiple launch observations may exist for one native task identity when explicit runtime-owned interruption recovery is used. If completion lacks a call ID, record unknown and hint `hive_task_trace`.

### Runtime Session Inspection

Primary orchestrators can inspect any explicitly identified native OpenCode session visible to the connected runtime with `hive_task_trace`, including self, direct children, foreign-parent sessions, and parentless primaries. Omitted or false `recovery` returns a paged forensic v3 index: surviving non-reasoning events in source order with bounded excerpts, assignment and final self-report context, and coverage limits. Follow `coverage.next_cursor` with `cursor` for later pages. Pass an event's `ref` to `hive_task_trace_content` to read that tool's input, output, and error together under a full integrity guard, then continue an oversized field in UTF-8-safe chunks with `field` and `offset`. `hive_task_trace({ task_id, recovery: true })` requests an untrusted semantic handoff whose content IDs `hive_task_trace_content` also reads. A finished turn recovers with `closed_turn` scope. An idle runtime whose tool or message records stay open, as after a host restart, recovers only an `evidence_only` snapshot that stays non-terminal and inspect-only. Self, active, and other uncertain targets cannot recover, and non-direct-child recovery is always inspect-only. Status and source come from the target session's own directory; a missing target entry in a valid status map means idle because OpenCode removes idle entries, while unavailable or invalid maps and a missing directory are uncertain and make zero model calls. Native `task` rows show a confirmed `child_session_id`, which is how to find a foreground child after a restart; the background board does not list foreground calls. Recovery output never authorizes acceptance, merge, retry, resume, or automatic execution. See [Hive Tools](docs/HIVE-TOOLS.md) for the full contract.

### Managed Context

`hive_context_read`, `hive_context_write`, `hive_context_append`, and `hive_context_archive` manage project (`.hive/context/`) or feature (`.hive/features/<name>/context/`) knowledge. Feature is the default scope; pass `scope: "project"` for project knowledge. Read the summary or search the catalog by name, `description`, and `read_when`, then read a named file in chunks. Before replacing, appending, or selectively archiving, read its revision and content hash and pass `expectedRevision` and `expectedContentHash` (or `expectedContentHashes` for archive). Only primary agents can archive. The `hive_context_read` catalog lists durable files; evidence files remain available through named reads ([context service](../hive-core/src/services/contextService.ts)). See [Hive Tools](docs/HIVE-TOOLS.md) for the read and mutation contracts.

### Operator Constraints

`hive_constraints_read`, `hive_constraints_add`, `hive_constraints_edit`, and `hive_constraints_clear` manage durable operator directives. Scope defaults to the current session; pass `scope: "feature"` for a feature directive. Read the current register before editing or clearing; `hive_constraints_edit` takes the constraint `id` and register `expectedRevision`, while `hive_constraints_clear` takes `expectedRevision` ([runtime tools](src/runtime.ts)). Only primary agents can mutate constraints. The selected feature route, session constraints, and feature constraints travel with native child dispatch.

### Git Snapshot

`hive_git_snapshot` captures a validated `hive-git-snapshot/v1` envelope for a selected Git range or paths. Its optional absolute `directory` must be an exact foreign Git top-level without a Hive manifest and cannot be combined with `repositoryIds` ([runtime tool](src/runtime.ts)). In a manifest-backed project, omit `directory` and select repositories with `repositoryIds` when needed. Check the returned status and failure records before using the snapshot as review evidence.

### Troubleshooting

#### Repeated blocked-continuation errors / loop

If you see repeated retries around blocked continuation, use this protocol. Blocked continuation follows `hive_task_update` with blocked status and blocker, the operator decision, then `hive_task_update` with an explicit status leaving blocked:

1. Call `hive_status()` first.
2. If the worker blocks, `hive_task_update` with blocked status and blocker, record the operator decision, then `hive_task_update` with an explicit status leaving blocked.

Do not loop blocked updates on non-blocked statuses; re-check `hive_status()`.

#### Using with DCP plugin

When using Dynamic Context Pruning (DCP), use a Hive-safe config in `~/.config/opencode/dcp.jsonc`:

- `manualMode.enabled: true`
- `manualMode.automaticStrategies: false`
- `turnProtection.enabled: true` with `turnProtection.turns: 12`
- `tools.settings.nudgeEnabled: false`
- protect key tools in `tools.settings.protectedTools` (at least: `hive_status`, `hive_worktree_create`, `hive_worktree_merge`, `hive_task_update`, `question`)
- disable aggressive auto strategies:
  - `strategies.deduplication.enabled: false`
  - `strategies.supersedeWrites.enabled: false`
  - `strategies.purgeErrors.enabled: false`

For normal usage, set the OpenCode plugin entry to `"oc-arkive@latest"`. Keep a local file path entry only for contributor testing with a checkout.

### Task worker recovery

After session compaction, use `hive_context_read` to search current catalogs and read the named files you need. Do not replay historical prompt text as a new assignment. Plugin restart does not continue old live workers; finish or abandon them first, then send a new message so the runtime observes the agent again.

Moving a project root does not continue old task or ad-hoc work. At the new root, create a valid worktree if needed and launch fresh. Old sessions and artifacts remain historical.

Manual tasks created with `hive_task_create()` follow the same DAG model as plan-backed tasks. The `goal`, `description`, `acceptanceCriteria`, `files`, and `references` fields are recorded in the task's `spec.md`. The primary's `task()` prompt must carry what the worker needs. To change downstream sequencing or scope after review feedback, update `plan.md` and run `hive_tasks_sync({ refreshPending: true })`.

`hive-helper` is a runtime-only investigator for feature/ad-hoc state, worktree identities, and session traces. Use it for evidence during merge recovery, state clarification, and interrupted-state investigation. It returns merge, cleanup, and manual-follow-up requests to the primary, which owns those mutations. Its Hive inspection tools and native edit denial are enforced; shell/external inspection-only scope is instruction-bound. It is not a selectable custom base agent.

`simplicity-reviewer` is a built-in read-only reviewer for final post-implementation cleanup and a supported `customAgents` base for specialized cleanup passes. It reviews completed diffs for YAGNI, dead code, duplication, unnecessary abstractions, redundant defensive code, and safe deletion-biased simplification.

## Task Prompts & Observability

For an explicitly selected feature, a Forager assignment whose first non-empty line is `Hive task: <task-folder>` for an existing task receives a bounded path-only Hive task brief after the route snapshot. It points to the current spec and plan section, direct dependencies' successor handoffs, and the durable feature-context catalog; workers read those records as needed. Eligible unbound dispatches receive a notice; fallback and explicit-null routes get neither brief nor notice, and other roles get no brief. No context documents, catalog bodies, or completed-task summaries are injected. Agents can search durable-file catalogs and read named files with `hive_context_read`; evidence files remain readable by name. `taskService` does not include completed-task summaries in `spec.md` ([task service](../hive-core/src/services/taskService.ts)).

### Observability

`hive_worktree_create` and `hive_worktree_inspect` return workspace path, branch, and commit facts. They do not return a generated native-task payload.

### Native Task Prompts

The primary authors the native Forager prompt. At dispatch, Hive appends a route-snapshot footer with `projectRoot`, the selected feature route, session constraints, and feature constraints; it does not attach a context catalog ([runtime hook](src/runtime.ts)).

A blocked continuation waits for an explicit status leaving blocked. The operator decision belongs in the primary-authored native prompt.

## Plan Format

```markdown
# Feature Name

## Overview
What we're building and why.

## Tasks

### 1. Change an owned behavior
Description of the task and its scope.

**Verify**:
- Required before merge: `[exact command]` -> [expected signal]
- Integrated-only deferral: [named behavior or consumer]

### 2. Another Task
Description.

## Final Verification

- [Integrated acceptance group] — owner: [suite/team]; prerequisite: [integrated candidate]; run: `[exact command]`; signal: [expected result]
```

`hive_tasks_sync` reads numbered task headings from `## Tasks` in modern plans. A final verification section stays outside the task DAG unless the verification itself needs tracked artifacts produced by a task.

Keep approved repository and operator checks binding. A required early or pre-merge check stays in the task's `Verify`; every integrated-only deferral named by a task must have a matching final-verification entry with an owner, prerequisite, exact command, and expected signal. Final acceptance records unique integrated proof. The same suite can appear in both places when it proves a different candidate or boundary.

For example, a shared DTO task can verify the DTO owner suite before merge and defer a named CLI consumer check to integrated acceptance. A schema feasibility check required before merge stays in the task even if it is expensive. When a task fails, keep its output, verify the owning regression, and rerun affected consumers and integrated checks; an unexplained green retry does not resolve the failure.

## Configuration

Hive reads runtime configuration from `~/.config/opencode/agent_hive.json`. The only project-local override file is `.hive/agent-hive.override.json`; it accepts only `model` and `variant` under `agents` and `customAgents`, and affects matching agents already present in the effective global/default configuration. Unknown names are ignored and never create agents. Project-local `.hive/agent-hive.json` and `.opencode/agent_hive.json` files remain ignored. Hive uses defaults when the global config is missing, unreadable, invalid JSON, or rejected by runtime validation. That validation rejects unknown top-level keys (including removed `disableMcps`) and wrong types for known fields, but does not enforce every restriction in the published schema: unknown keys inside `agents` declarations and some malformed `customAgents` entries do not invalidate the whole file ([config service](../hive-core/src/services/configService.ts), [schema](schema/agent_hive.schema.json)). An invalid project override is ignored with a runtime warning. Restart OpenCode after changing either config file.

Global config remains authoritative for runtime policy, agent definitions, and auto-load skill settings. See [`agent_hive.override.schema.json`](schema/agent_hive.override.schema.json) for the project override shape.

The global schema also accepts `enableToolsFor` (default `[]`), but the current runtime does not use it to grant tools; tool access comes from agent permissions. `repositoryRoot` and `repositories` are migration-only fields for legacy topology. New repository declarations go in the project manifest managed through `hive_repositories_update`.

For example, to change the model for one project without changing the global agent roster, put this in `<project>/.hive/agent-hive.override.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.override.schema.json",
  "agents": {
    "forager-worker": { "model": "anthropic/claude-sonnet-4-20250514", "variant": "high" }
  }
}
```

`hook_cadence` currently has no runtime effect: no production hook invokes the cadence gate. The schema remains the machine-readable reference for this field.

### Agent mode

`agentMode` selects how planning and orchestration seats are registered. Default is `"dedicated"`.

| Value | Default agent | Primary seats | When to use |
|-------|---------------|---------------|-------------|
| `dedicated` | `architect-planner` | Separate `architect-planner` and `swarm-orchestrator` | Default; split planning and execution across two primary seats |
| `unified` | `hive-master` | `hive-master`, `architect-planner`, and `swarm-orchestrator` | `hive-master` is the default for planning and orchestration |

In both modes:

- `architect-planner` and `swarm-orchestrator` stay registered. Researchers, workers, reviewers, `hive-helper`, and `hive-builder` remain available. `hive-master` is hidden in dedicated mode ([runtime registration](src/runtime.ts)).
- Slash-command routing follows the [Operator Commands](#operator-commands) table.
- Custom derived subagents attach to the active planner/orchestrator prompts for that mode.

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "agentMode": "unified"
}
```

Dedicated mode does not auto-switch the live chat agent when you run a slash command. If the active agent is not the route target, delegate or reroute to that target and stop if that is not possible. `/dash-review` and `/vuln-review` always bind to private review primaries regardless of mode.

### Task trace summarizer

`taskTraceSummarizer` configures the **hidden, parentless, tool-less** model used only when a primary agent calls `hive_task_trace({ task_id, recovery: true })`. It does **not** change forensic (non-recovery) traces, which stay deterministic and model-free.

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `model` | no | OpenCode default model | Nonempty `provider/model-id` string |
| `variant` | no | OpenCode default / none | Must match a key under `opencode.json` `provider.<provider>.models.<model>.variants` |
| `temperature` | no | `0` | Number from `0` through `2` |

Behavior:

- Recovery interpretation is always marked untrusted (`provenance: 'summarizer_interpretation'`).
- An unavailable configured model or variant produces deterministic partial fallback without provider retry.
- Recovery never authorizes accept, merge, retry, resume, or auto-run. Native `task_id` pass-through requires explicit operator or runtime-owned interruption-recovery authorization; after every returned result, follow-up work uses a fresh child session and may reuse the same Hive task/worktree.
- See [Runtime Session Inspection](docs/HIVE-TOOLS.md#runtime-session-inspection-2-tools) for the full trace/recovery contract.

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "taskTraceSummarizer": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "variant": "high",
    "temperature": 0
  }
}
```

### Council config

Council settings live in `~/.config/opencode/agent_hive.json`.

Built-in council defaults are read-only and portable:

| Group | Purpose | Default members |
|-------|---------|-----------------|
| `design` | Architecture and implementation-shape advice. | `scout-researcher`, `approach-advisor`, `plan-reviewer`, `code-reviewer` |
| `decision` | Hard tradeoff decision support. | `scout-researcher`, `approach-advisor`, `plan-reviewer` |
| `minimal-change` | Smallest correct change and cleanup lens. | `scout-researcher`, `simplicity-reviewer`, `code-reviewer` |
| `documents` | Documentation and prose-oriented review. | `scout-researcher`, `code-reviewer`, `plan-reviewer` |

The default `excludedAgents` list excludes mutable orchestration or implementation seats: `hive-master`, `swarm-orchestrator`, `forager-worker`, `hive-builder`, and `hive-helper`. Member names can be built-in stock agents or configured custom agents. Custom agents derived from mutable bases, including `forager-worker`, are skipped by default with warnings.

Partial global overrides merge with the built-in defaults. Declaring a group replaces that group declaration and leaves omitted default groups intact:

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "council": {
    "defaultGroup": "documents",
    "maxMembers": 3,
    "excludedAgents": ["simplicity-reviewer"],
    "groups": {
      "documents": {
        "description": "Docs and operator prose review",
        "members": ["scout-researcher", "code-reviewer", "plan-reviewer"],
        "maxMembers": 2
      },
      "security": {
        "description": "Security-sensitive review",
        "members": ["scout-researcher", "reviewer-security", "code-reviewer"]
      }
    }
  }
}
```

Council resolution preserves configured order, deduplicates by first occurrence, filters unusable seats before applying the cap, and uses `group.maxMembers ?? council.maxMembers ?? 4`. It skips unavailable agents, explicitly excluded agents, starter template custom agents, mutable-base agents, and duplicates with warnings. If a requested group has no usable seats, `/council` falls back to `council.defaultGroup`; if the fallback also has no usable seats, the command stops with an error instead of running an unsafe council.

### Project-local repository manifest

Optional Hive-managed project state for multi-repo topology. Single-repository projects need no manifest. Do not hand-author this file for normal onboarding; ask Hive to inspect, discover, and update topology with `hive_repositories_status`, `hive_repositories_discover`, and `hive_repositories_update`.

Generated/managed shape (for inspection) at `<project>/.hive/repositories.json`:

```json
{
  "schemaVersion": 1,
  "repositories": [
    { "id": "api", "path": "./api" }
  ]
}
```

### Global-only: Disable Skills

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "disableSkills": ["brainstorming", "writing-plans"]
}
```

#### Available Skills

| ID | Description |
|----|-------------|
| `adversarial-review` | Explicit adversarial / red-team / multi-pass review posture |
| `agents-md-mastery` | Bootstrap, review, or prune AGENTS.md by placing rules next to the code they govern |
| `background-delegation` | Env-gated background wait-mode and board protocol |
| `brainstorming` | Explore intent and design before implementation |
| `code-design-principles` | Conditional depth for state, types, boundaries, shared writers, retries, and internal migration |
| `complexity-audit` | Read-only complexity audit of named roots or the current worktree |
| `complexity-review` | Read-only complexity review of an explicit diff or bounded scope |
| `context-engineering` | Select, retrieve, and update managed context with revision and hash checks |
| `dispatching-parallel-agents` | Coordinate independent subagent work |
| `executing-plans` | Execute an approved plan with review checkpoints |
| `grilling` | Question supplied context until material decisions and evidence are aligned |
| `how` | Explain current source-grounded behavior and subsystem flow |
| `humanizer` | Repair vocabulary, register, attribution, and formatting in existing prose |
| `orchestrating-ad-hoc-work` | Coordinate qualifying ad-hoc work for Hive Builder or unified Hive |
| `parallel-exploration` | Researcher fan-out for read-only research |
| `pr-writing` | Draft PR titles, descriptions, and general or inline review comments |
| `stop-slop` | Repair formulaic cadence and structure in existing prose |
| `systematic-debugging` | Root-cause investigation before fixes |
| `test-driven-development` | Strict red-green-refactor when TDD is the selected testing strategy |
| `verification` | Applicable command/tool evidence before completion or verification claims |
| `why` | Investigate explicitly requested historical rationale with calibrated source evidence |
| `writing-for-agents` | Reference for authoring documents agents consume: skills, subagent prompts, instructions, and pointer architecture |
| `writing-for-humans` | Draft substantial reader-centered prose and apply the non-invention finish pass |
| `writing-policy` | Select writing depth skills and propagate the writing contract to permitted delegates |
| `writing-plans` | Turn requirements into an implementation plan |

### Per-Agent Skills

Skills are loaded through OpenCode's native `skill` tool, not through a Hive plugin tool. Hive bundles are materialized into the global OpenCode config directory under `agent-hive/generated/opencode-skills/<hash>/` at startup and registered via `opencodeConfig.skills.paths` ahead of any user-configured paths.

**Configuration fields:**

| Field | Behavior |
|-------|----------|
| `skills` | Legacy field kept for config compatibility. Native skill visibility is controlled by OpenCode registration and `disableSkills`, not by per-agent allowlists. |
| `autoLoadSkills` | Adds high-priority prompt guidance telling the agent to load named OpenCode-native skills with the `skill` tool before work covered by them. |
| `disableSkills` (global) | Disables Hive bundled materialization and Hive bundled autoload only. User or native skills with the same name are not blocked. |

**User file skills** should be configured through OpenCode's native `.opencode`, `.claude`, `.agents`, `skills.paths`, or `skills.urls` discovery. They can be loaded manually with the native `skill` tool or advertised to an agent by adding the skill's frontmatter `name` to `autoLoadSkills`. Native/user skills take precedence over Hive bundled skills with the same name.

The writing family is maintained in oc-arkive: `writing-policy` routes, `writing-for-humans` owns drafting and the finish pass, `stop-slop` owns cadence/structure repair, and `humanizer` owns vocabulary/register/attribution/formatting repair. The base prompt points to the policy; depth skills load only on their triggers. These pointers do not change `autoLoadSkills` defaults or override explicitly disabled skills. `pr-writing` retains its artifact and publication contract, and `writing-for-agents` retains instruction-authoring ownership.

`code-design-principles` deepens the existing Engineering Judgment block at material design decisions without another workflow or finding bar. `how` and `why` serve explicit explanation and historical-rationale requests; ordinary debugging, future design selection, and routine implementation orientation retain their existing owners.

See [Skill ownership](docs/SKILL-OWNERSHIP.md) for the responsibility map and source-preserving maintenance guidance.

**URL-scan conservative behavior:** If configured `skills.urls` cannot be scanned for conflicts (invalid response, network error), Hive skips bundled skill materialization and Hive bundled autoload guidance for that run and logs a warning rather than risking a native conflict. Local native skills discovered before the URL failure can still be advertised in guidance; partially scanned URL skills are not advertised.

`background-delegation` is bundled and materialized like other Hive skills, but primary prompt references are env-gated and compact. Delegation-first orchestration lives in the base primary prompts; when the env flag is set, primary agent prompts add background wait-mode and board protocol guidance and point to the skill for the full protocol. The skill can still be loaded manually with OpenCode's native `skill` tool like any other bundled or user skill.

`orchestrating-ad-hoc-work` is loaded conditionally by Hive Builder or unified `hive-master` when a request has multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, possible background execution, or an expected need for more than one worker attempt or turn. It is not a default `autoLoadSkills` entry and may retain one coherent lane after decomposition. Content tests establish bundling and routing only; they do not establish first-attempt model reliability.

**Example:**

```json
{
  "agents": {
    "hive-master": {
      "autoLoadSkills": ["brainstorming"]
    }
  }
}
```

`autoLoadSkills` resolves names through OpenCode-native skill discovery first, then through eligible Hive bundled skills. The identity is the `name` field in `SKILL.md` frontmatter, not the containing directory name. Disabled Hive skills, Hive skills shadowed by native/user skills, and URL-unsafe Hive skills are skipped. Unknown names emit a warning. Startup continues without failure.

**How `skills` and `autoLoadSkills` interact:**

- `skills` is a legacy field kept for config compatibility. In the native skill slice, skill visibility is controlled by OpenCode's native `skills.paths` registration and `disableSkills`, not by per-agent `skills` allowlists.
- `autoLoadSkills` adds a compact system-prompt directive to load OpenCode-discovered native skills or eligible Hive bundled skills with `skill({ name: "..." })` before matching work; it does not preload full skill bodies
- These are **independent**: a skill can be advertised for native loading even if it is not in the agent's legacy `skills` list
- User `autoLoadSkills` are **merged** with defaults. Global `disableSkills` suppresses only Hive-bundled skill materialization and bundled auto-load guidance; a native/user skill with the same name can still be advertised.

**Default auto-load skills by agent:**

| Agent | autoLoadSkills default |
|-------|------------------------|
| `hive-master` | `parallel-exploration` |
| `forager-worker` | `verification` |
| `hive-builder` | `verification`, `parallel-exploration` |
| `hive-helper` | (none) |
| `scout-researcher` | (none) |
| `architect-planner` | `parallel-exploration` |
| `swarm-orchestrator` | `parallel-exploration` |
| `plan-reviewer` | (none) |
| `code-reviewer` | (none) |
| `simplicity-reviewer` | (none) |
| `approach-advisor` | (none) |
| `vulnerability-reviewer` | (none) |

`background-delegation` is not a default `autoLoadSkills` entry for any agent. For ad-hoc orchestration, delegation-first guidance is in the base prompt; the env flag (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`) only appends background wait-mode and board guidance without adding it to the default autoload set.

### Per-Agent Model Variants

You can set a `variant` for each Hive agent to control model reasoning/effort level. Variants are keys that map to model-specific option overrides defined in your `opencode.json`.

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "agents": {
    "hive-master": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "variant": "high"
    },
    "forager-worker": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "variant": "medium"
    },
    "scout-researcher": {
      "variant": "low"
    }
  }
}
```

The `variant` value must match a key in your OpenCode config at `provider.<provider>.models.<model>.variants`. For example, with Anthropic models you might configure thinking budgets:

```json
// opencode.json
{
  "provider": {
    "anthropic": {
      "models": {
        "claude-sonnet-4-20250514": {
          "variants": {
            "low": { "thinking": { "budget_tokens": 5000 } },
            "medium": { "thinking": { "budget_tokens": 10000 } },
            "high": { "thinking": { "budget_tokens": 25000 } }
          }
        }
      }
    }
  }
}
```

**Precedence:** If a prompt already has an explicit variant set, the per-agent config acts as a default and will not override it. Invalid or missing variant keys are treated as no-op (the model runs with default settings).

### Custom Derived Subagents

Define plugin-only custom subagents with `customAgents`. Freshly initialized `agent_hive.json` files already include starter template entries under `customAgents`; those seeded `*-example-template` entries are placeholders only, should be renamed or deleted before real use, and are intentionally worded so planners/orchestrators are unlikely to select them as configured. Each custom agent must declare:

- `baseAgent`: one of `scout-researcher`, `forager-worker`, `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor`, or `vulnerability-reviewer`
- `description`: required non-whitespace delegation guidance injected into eligible primary planner/orchestrator prompts

Custom subagents are scoped routing specialists, not model-upgrade switches. Primary agents choose them autonomously when their description is a closer match for the requested output, task domain, workflow, artifact type, or concrete review/approach risk. They keep the built-in base agent when no configured description is a closer fit. A custom description specializes routing within the inherited base role; it cannot expand that role or override its prompt, tool, or permission boundaries. Candidate-specific conditions in an individual description still apply, including a condition that the candidate may be selected only when the operator explicitly names it. Importance, size, generic complexity, quality sensitivity, and a stronger model are not routing reasons. At runtime, custom agent entries with reserved names, IDs containing native permission wildcard characters (`*` or `?`), non-object declarations, unsupported `baseAgent` values, or missing, blank, or whitespace-only `description` values are skipped with warnings.

The same seven built-in bases allow an optional routing-description override under the existing `agents` map. Nonblank values are trimmed before publication. Omitted, blank, or whitespace-only values inherit the canonical default without dropping unrelated settings on that built-in. Putting `description` on a non-customizable built-in invalidates the stored global config. At runtime, Agent Hive rejects the entire stored config and falls back to defaults, so unrelated stored settings are ignored until the config is corrected. The runtime skip behavior above does not promise a per-entry fallback for arbitrary schema-invalid optional fields. Custom agents never inherit a base description; every custom entry must supply its own non-whitespace description.

| Configurable base | Canonical default description |
|-------------------|-------------------------------|
| `scout-researcher` | Retrieves bounded internal or external code, context, and data evidence without owning diagnosis, tradeoffs, or solution selection. |
| `forager-worker` | Implements and verifies delegated work in its assigned workspace; diagnosis-only assignments remain report-only. |
| `plan-reviewer` | Default for ordinary plan review covering worker readiness, references, dependencies, and executable verification. |
| `code-reviewer` | Default for ordinary implementation review covering correctness, tests, risk, scope creep, YAGNI, and dead code. |
| `simplicity-reviewer` | Default for ordinary post-implementation simplicity review covering unnecessary abstractions, duplication, dead code, and safe deletion. |
| `approach-advisor` | Default for ordinary read-only approach advice on technical direction, architecture, debugging, and tradeoffs. |
| `vulnerability-reviewer` | Default for application-security review focused on evidenced attacker-to-impact paths and root-cause triage. |

Primary orchestrators, `hive-builder`, `hive-helper`, `architect-planner`, private `__hive_*` identities, and generated review lanes do not expose description overrides.

`hive-helper` is not a custom base agent. Its runtime-only investigation role covers both feature and ad-hoc work; primaries own integration, cleanup, and follow-up task creation.

`simplicity-reviewer` is a custom base agent for specialized cleanup passes. Primary agents still use the built-in `simplicity-reviewer` when no configured simplicity-reviewer-derived custom description is a closer match.

`vulnerability-reviewer` is a custom base agent for selectable `/vuln-review` specialist lenses. It preserves the configured description, model, variant, and temperature and inherits restricted Hive permissions and native edit denial. Its shell/external review-only scope is instruction-bound. Configured reviewer descriptions guide selection.

Published example (validated by `src/e2e/custom-agent-docs-example.test.ts`):

```json
{
  "agents": {
    "scout-researcher": {
      "variant": "low"
    },
    "forager-worker": {
      "description": "Default for ordinary backend implementation.",
      "variant": "medium"
    },
    "code-reviewer": {
      "model": "github-copilot/gpt-5.2-codex"
    }
  },
  "customAgents": {
    "scout-docs": {
      "baseAgent": "scout-researcher",
      "description": "Use for research centered on documentation, release notes, READMEs, or external docs synthesis."
    },
    "forager-ui": {
      "baseAgent": "forager-worker",
      "description": "Use for UI implementation tasks touching React/Next components, styling, accessibility, or browser-visible behavior.",
      "model": "anthropic/claude-sonnet-4-20250514",
      "temperature": 0.2,
      "variant": "high"
    },
    "reviewer-security": {
      "baseAgent": "code-reviewer",
      "description": "Use for review passes focused on auth, permissions, secret handling, injection risk, or other security-sensitive changes."
    }
  }
}
```

Inheritance rules when a custom agent field is omitted:

| Field | Inheritance behavior |
|-------|----------------------|
| `model` | Inherits resolved base agent model (including user overrides in `agents`) |
| `temperature` | Inherits resolved base agent temperature |
| `variant` | Inherits resolved base agent variant |
| `autoLoadSkills` | Merges with base agent auto-load defaults/overrides and de-duplicates. `disableSkills` only suppresses Hive bundled guidance/materialization, not native/user skills with the same name. |

ID guardrails:

- `customAgents` keys cannot reuse built-in Hive agent IDs
- native `general`/`explore` and review primaries `dash-reviewer`/`vulnerability-review-primary` are reserved; rename a colliding custom reviewer (for example to `reviewer-dashboard`) while retaining its supported base
- custom agent IDs cannot contain native permission wildcard characters (`*` or `?`)
- plugin-reserved aliases are blocked (`hive`, `architect`, `swarm`, `scout`, `forager`, `hygienic`, `hygienic-reviewer`, `receiver`)
- operational IDs are blocked (`build`, `builder`, `plan`, `code`)

Compaction classification follows the base agent:

- `scout-researcher` derivatives are treated as `subagent`
- `forager-worker` derivatives are treated as `task-worker`
- `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor`, and `vulnerability-reviewer` derivatives are treated as `subagent`

This ensures custom workers recover with the same execution constraints as their base role.

### Custom Models

Override models for specific agents:

```json
{
  "agents": {
    "hive-master": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "temperature": 0.5
    }
  }
}
```

## Focused references

- [Hive Tools](docs/HIVE-TOOLS.md) for tool inventory and contracts
- [Data Model](docs/DATA-MODEL.md) for `.hive/` state and task records
- [Operator Guide](../../docs/OPERATOR-GUIDE.md) for public agents and the feature / ad-hoc / dash-review / vuln-review loops
- [Design](../../docs/DESIGN.md) for architecture and source-of-truth rules

## Pair with VS Code

For the full OpenCode-first workflow, install `vscode-arkive.vsix` from the GitHub Release as an optional review/sidebar companion for inline comments and document review.

## License

MIT with Commons Clause - Free for personal and non-commercial use. See [LICENSE](../../LICENSE) for details.

---
