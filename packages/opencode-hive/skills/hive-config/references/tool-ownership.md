# Tool ownership

Each piece of Hive state has one owning tool. If that tool is not exposed to your role, return the change to a role that has it. Do not substitute shell, editor, or Git writes. Tool availability is a ceiling, not authorization: your assignment still decides whether a call is in scope.

## How access is enforced

- The plugin registers ordered `agent.permission` rules for every Hive role: `'hive_*': 'deny'` first, then that role's exact allows. OpenCode applies agent rules after global rules and takes the last matching rule. A global `"*": "allow"` or a global `permission` entry therefore cannot re-grant a Hive tool the role denies.
- Custom agents inherit their base role's tools and permissions exactly. Extra auto-load skills never add authority.
- When native `task()` creates a child session, OpenCode adds session-level denials for the primary-only tools below plus `question`, even if the child's agent would otherwise allow them. A reused session (`task_id`) keeps its creation-time rules; after a plugin change, restart the host and start fresh children.
- Native `general` and `explore` get no Hive tools, no `task`, and no `question`.
- Shell and external integrations are not Hive-gated. For read-only roles, staying read-only with them is an instruction, not an enforced boundary.

## Read sets (no Hive state changes)

| Set | Tools | Roles |
|---|---|---|
| R | `hive_status`, `hive_plan_read`, `hive_context_read`, `hive_constraints_read`, `hive_repositories_status`, `hive_git_snapshot` | Every Hive role except the hidden trace summarizer |
| I | `hive_worktree_inspect`, `hive_adhoc_worktree_inspect` | Primaries, Architect, Forager, Hive Helper, review primaries |
| T | `hive_task_trace`, `hive_task_trace_content` | Same as I |
| Discover | `hive_repositories_discover` | Primaries, Architect, Scout |
| Board | `hive_background_status` | Full primaries, Architect as a primary, review primaries. Primary-only (denied in child sessions) and experiment-gated (see below); not part of R |

## Mutating tools

Roles: **P** = full primaries (`hive-master`, `swarm-orchestrator`, `hive-builder`), **A** = `architect-planner` as a primary, **Ac** = `architect-planner` as a task child, **RP** = review primaries (`dash-reviewer`, `vulnerability-review-primary`), **F** = `forager-worker`, **Rev** = `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor`, `vulnerability-reviewer`. "Primary-only" tools are denied in every child session.

| Tool | State it changes | Roles | Primary-only |
|---|---|---|---|
| `hive_feature_create` | New `features/<NN>_<name>/`, `feature.json` | P, A, Ac | |
| `hive_feature_select` | Selected route in `.hive/sessions.json` | P, A, RP | yes |
| `hive_feature_complete` | `feature.json` status | P | yes |
| `hive_plan_write`, `hive_plan_patch` | `plan.md` | P, A, Ac | |
| `hive_plan_approve` | `APPROVED`, `feature.json`, optional task sync | P, A | yes |
| `hive_tasks_sync` | `tasks/*/status.json`, `spec.md` | P, A | yes |
| `hive_task_create` | New manual task folder | P | yes |
| `hive_task_update` | `status.json`, `reports/<N>.md`, `report.md`, `handoff.md` | P, F | |
| `hive_worktree_create` | Feature-task worktree, branch, sidecar or `workspace.json` | P, F | |
| `hive_worktree_merge` | Destination branch (integration commit) | P | yes |
| `hive_worktree_cleanup` | Removes feature-task worktree, optionally its branch | P | yes |
| `hive_adhoc_worktree_create` | Ad-hoc worktree, branch, sidecar or `workspace.json` | P, RP | yes |
| `hive_adhoc_worktree_merge` | Destination branch (integration commit) | P | yes |
| `hive_adhoc_worktree_cleanup` | Removes ad-hoc worktree, optionally its branch | P, RP | yes |
| `hive_repositories_update` | `.hive/repositories.json` | P, A, Ac | |
| `hive_context_write`, `hive_context_append` | `context/<name>.md`, `context/index.json` (feature or project) | P, A, Ac, RP, F, Rev | |
| `hive_context_archive` | Moves context into `archive/context/` | P, A | yes |
| `hive_constraints_add`, `hive_constraints_edit`, `hive_constraints_clear` | Session constraints in `sessions.json`; feature `constraints.json` | P, A, RP | yes |
| `hive_background_reconcile`, `hive_background_reconcile_batch`, `hive_background_cancel` | `.hive/background-jobs.json` | P, A, RP; experiment-gated | yes |

Roles with none of these: `scout-researcher` (read-only; R plus discover), `hive-helper` (R, I, T only; also denied native edit, `task`, and `question`), native `general`/`explore`, and the hidden trace summarizer (all tools denied).

## Native `task()` targets

Each role's `task` permission denies everything, then allows named targets (plus custom agents derived from an allowed base):

| Caller | May dispatch |
|---|---|
| Full primaries | Scout, Forager, every reviewer and advisor, `architect-planner`, `hive-helper`, native `general` and `explore` |
| Architect, as primary or task child | One terminal layer of `scout-researcher`, `plan-reviewer`, `approach-advisor`, and `hive-helper` |
| Review primaries | Scout, every reviewer and advisor, `hive-helper`; not Forager |
| Every other role, including `hive-helper` | Nothing (`task` denied) |

Full primaries are never valid `task()` targets, and `hive-helper` is not a custom-agent base. The host's `subagent_depth: 2` is what lets a delegated Architect's helper grandchild exist.

## Boundaries the matrix does not show

- `hive_task_update` is tool-level access. A Forager publishes its own report and handoff for its assigned task; the primary records status, summary, and blocker.
- A Forager may create only the feature-task worktree its assignment names. Ad-hoc placement and new lanes belong to the primary.
- Trace tools let Forager support assigned recovery and Hive Helper investigate. They never authorize resuming, retrying, or continuing a session.
- Background tools exist only when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` is set; otherwise they return `background_tools_disabled`.
- Skills load through OpenCode's native `skill` tool, which every Hive role except the hidden trace summarizer may call.

When the agent-hive source is available, the enforced matrix lives in `packages/opencode-hive/src/runtime.ts` (config hook) and is documented in `packages/opencode-hive/docs/HIVE-TOOLS.md` under "Agent Tool Access". Prefer those over this table if they disagree.
