# Tool ownership

Each piece of Hive state has one owning tool. If that tool is not exposed to your role, return the change to a role that has it. Do not substitute shell, editor, or Git writes. Tool availability is a ceiling, not authorization: your assignment still decides whether a call is in scope.

## How access is enforced

<!-- hive-host opencode-v1 -->
- The plugin registers ordered `agent.permission` rules for every Hive role: `'hive_*': 'deny'` first, then that role's exact allows. OpenCode applies agent rules after global rules and takes the last matching rule. A global `"*": "allow"` or a global `permission` entry therefore cannot re-grant a Hive tool the role denies.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
- OpenCode v2 configuration owns what each agent can see: the user's `permissions` rules apply and the last matching rule wins. Hive registers role defaults and enforces each role's operations and child restrictions inside its own tools and the public execution hooks, so a native allow rule can make a forbidden Hive operation visible but never authorizes it.
<!-- /hive-host -->
- Custom agents inherit their base role's tools and permissions exactly. Extra auto-load skills never add authority.
<!-- hive-host opencode-v1 -->
- When native `task()` creates a child session, OpenCode adds session-level denials for the primary-only tools below plus `question`, even if the child's agent would otherwise allow them. A reused session (`task_id`) keeps its creation-time rules; after a plugin change, restart the host and start fresh children.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
- A child session created by the native `subagent()` call may not run the primary-only tools below or `question`. Hive derives that restriction from the session's actual ancestry, not from an agent's mode or description, and applies it when the tool runs. A reused child (`sessionID`) is checked the same way.
<!-- /hive-host -->
<!-- hive-host opencode-v1 -->
- Native `general` and `explore` get no Hive tools, no `task`, and no `question`.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
- Native `general` and `explore` get no Hive tools, no `subagent`, and no `question`.
<!-- /hive-host -->
- Shell and external integrations are not Hive-gated. For read-only roles, staying read-only with them is an instruction, not an enforced boundary.

## Read sets (no Hive state changes)

| Set | Tools | Roles |
|---|---|---|
| R | `hive_status`, `hive_plan_read`, `hive_context_read`, `hive_constraints_read`, `hive_repositories_status`, `hive_git_snapshot`, `hive_worklog_list`, `hive_worklog_read` | Every Hive role except the hidden trace summarizer |
| I | `hive_worktree_inspect`, `hive_adhoc_worktree_inspect` | Primaries, Architect, Forager, Investigator, Hive Helper, review primaries |
| T | `hive_task_trace`, `hive_task_trace_content` | Primaries, Architect, Forager, Hive Helper, review primaries (not Investigator) |
| Discover | `hive_repositories_discover` | Primaries, Architect, Scout |
<!-- hive-host opencode-v1 -->
| Board | `hive_background_status` | Full primaries, Architect as a primary, review primaries. Primary-only (denied in child sessions) and experiment-gated (see below); not part of R |
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
| Board | `hive_background_status` | Full primaries, Architect as a primary, review primaries. Primary-only (denied in child sessions); not part of R |
<!-- /hive-host -->

## Mutating tools

Roles: **P** = full primaries (`hive-master`, `swarm-orchestrator`, `hive-builder`), **A** = `architect-planner` as a primary (its ad-hoc create and cleanup are for experiment placements; it never merges), **Ac** = `architect-planner` as a task child, **RP** = review primaries (`dash-reviewer`, `vulnerability-review-primary`), **F** = `forager-worker`, **Rev** = `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor`, `vulnerability-reviewer`. "Primary-only" tools are denied in every child session.

| Tool | State it changes | Roles | Primary-only |
|---|---|---|---|
| `hive_feature_create` | New `features/<NN>_<name>/`, `feature.json` | P, A, Ac | |
| `hive_feature_select` | Selected route in the host owner's `sessions.json` (`.hive/sessions.json` for OpenCode v1) | P, A, RP | yes |
| `hive_feature_complete` | `feature.json` status | P | yes |
| `hive_plan_write`, `hive_plan_patch` | `plan.md` | P, A, Ac | |
| `hive_plan_approve` | `APPROVED`, `feature.json`, optional task sync | P, A | yes |
| `hive_tasks_sync` | `tasks/*/status.json`, `spec.md` | P, A | yes |
| `hive_task_create` | New manual task folder | P | yes |
| `hive_task_update` | `status.json`, `reports/<N>.md`, `report.md`, `handoff.md` | P, F | |
| `hive_worktree_create` | Feature-task worktree, branch, sidecar or `workspace.json` | P, F | |
| `hive_worktree_merge` | Destination branch (integration commit) | P | yes |
| `hive_worktree_cleanup` | Removes feature-task worktree, optionally its branch | P | yes |
| `hive_adhoc_worktree_create` | Ad-hoc worktree, branch, sidecar or `workspace.json` | P, A, RP | yes |
| `hive_adhoc_worktree_merge` | Destination branch (integration commit) | P | yes |
| `hive_adhoc_worktree_cleanup` | Removes ad-hoc worktree, optionally its branch | P, A, RP | yes |
| `hive_repositories_update` | `.hive/repositories.json` | P, A, Ac | |
| `hive_context_write`, `hive_context_append`, `hive_context_edit` | `context/<name>.md`, `context/index.json` (feature or project); edit changes one exact passage of an existing file | P, A, Ac, RP, F, Rev | |
| `hive_context_archive` | Moves context into `archive/context/` | P, A | yes |
| `hive_constraints_add`, `hive_constraints_edit`, `hive_constraints_clear` | Session constraints in `sessions.json`; feature `constraints.json` | P, A, RP | yes |
| `hive_worklog_record` | Appends one checkpoint (and optionally the briefing) to a feature's `worklog.json` or the session's `.hive/worklogs/sessions/<owner>/<sha256>.json` | P, A, RP | yes |
<!-- hive-host opencode-v1 -->
| `hive_background_reconcile`, `hive_background_reconcile_batch`, `hive_background_cancel` | Host owner's `background-jobs.json` (`.hive/background-jobs.json` for OpenCode v1) | P, A, RP; experiment-gated | yes |
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
| `hive_background_reconcile`, `hive_background_reconcile_batch`, `hive_background_cancel` | Host owner's `background-jobs.json` (`.hive/runtime/opencode-v2/background-jobs.json` for OpenCode v2) | P, A, RP | yes |
<!-- /hive-host -->

<!-- hive-host opencode-v1 -->
Roles with none of these: `scout-researcher` (read-only; R plus discover), `forager-investigator` (R and I only; native scratch edit and shell stay under operator permissions, `task` and `question` denied), `hive-helper` (R, I, T only; also denied native edit, `task`, and `question`), native `general`/`explore`, and the hidden trace summarizer (all tools denied).
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
Roles with none of these: `scout-researcher` (read-only; R plus discover), `forager-investigator` (R and I only; native scratch edit and shell stay under operator permissions, `subagent` and `question` denied), `hive-helper` (R, I, T only; also denied native edit, `subagent`, and `question`), native `general`/`explore`, and the hidden trace summarizer (all tools denied).
<!-- /hive-host -->

<!-- hive-host opencode-v1 -->
## Native `task()` targets

Each role's `task` permission denies everything, then allows named targets (plus custom agents derived from an allowed base):
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
## Native `subagent()` targets

Each role's `subagent` permission denies every agent, then allows named targets (plus custom agents derived from an allowed base):
<!-- /hive-host -->

| Caller | May dispatch |
|---|---|
| Full primaries | Scout, Forager, Investigator, every reviewer and advisor, `architect-planner`, `hive-helper`, native `general` and `explore` |
| Architect, as primary or task child | One terminal layer of `scout-researcher`, `forager-investigator`, `plan-reviewer`, `approach-advisor`, and `hive-helper`; never `forager-worker` |
| Review primaries | Scout, every reviewer and advisor, `hive-helper`, and Investigators (built-in and derived) for runtime exercises; never `forager-worker` or its derivatives |
<!-- hive-host opencode-v1 -->
| Every other role, including `hive-helper` | Nothing (`task` denied) |
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
| Every other role, including `hive-helper` | Nothing (`subagent` denied) |
<!-- /hive-host -->

<!-- hive-host opencode-v1 -->
Full primaries are never valid `task()` targets, and `hive-helper` is not a custom-agent base. The host's `subagent_depth: 2` is what lets a delegated Architect's helper grandchild exist.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
Full primaries are never valid `subagent()` targets, and `hive-helper` is not a custom-agent base. A delegated Architect's helper grandchild exists only when the user's v2 configuration allows `experimental.subagent_depth` of at least 2; Hive does not rewrite it.
<!-- /hive-host -->

## Boundaries the matrix does not show

- `hive_task_update` is tool-level access. A Forager publishes its own report and handoff for its assigned task; the primary records status, summary, and blocker.
- A Forager may create only the feature-task worktree its assignment names. Ad-hoc placement and new lanes belong to the primary.
- An Investigator returns evidence; it commits nothing. A run that changes source uses a disposable placement its primary created, and that placement ends with cleanup, not merge. Its native scratch scope is instruction-bound, not a sandbox.
- Trace tools let Forager support assigned recovery and Hive Helper investigate. They never authorize resuming, retrying, or continuing a session.
- `hive_worklog_record` stamps the calling session and agent as the author; a session log accepts only its own session, while any primary may record into a feature log. Its executor also checks the live parent on both hosts and refuses when the session cannot be read.
<!-- hive-host opencode-v1 -->
- Background tools exist only when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` is set; otherwise they return `background_tools_disabled`.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
- No experiment variable gates background subagents on OpenCode v2.
<!-- /hive-host -->
- Skills load through OpenCode's native `skill` tool, which every Hive role except the hidden trace summarizer may call. A skill's references are knowledge read from the skill's own directory: reading one grants no tool or role authority, and a missing or overridden reference is never a reason to search generated skill caches or read another copy.

When the agent-hive source is available, the enforced matrix lives in `packages/opencode-hive/src/runtime/role-policy.ts` (applied by the config hook in `runtime.ts`) and is documented in `packages/opencode-hive/docs/HIVE-TOOLS.md` under "Agent Tool Access". Prefer those over this table if they disagree.
