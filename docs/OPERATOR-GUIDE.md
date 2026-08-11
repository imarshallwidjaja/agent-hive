# Operator Guide

Day-to-day operation of `oc-arkive` after install. For first-run setup, see [Getting Started](GETTING-STARTED.md).

## Mental model

Hive coordinates independent workers through structure, shared state, isolation, and clear handoffs:

- **Structure** - features, plans, tasks, and specs define work units
- **Shared state** - `.hive/` files outlive chat memory
- **Isolation** - git worktrees keep concurrent work from colliding
- **Handoffs** - commit, status, merge, and trace tools mark boundaries

You shape direction and approve plans. Agents implement inside those gates.

## Feature workflow

1. Create feature (`hive_feature_create` or planning commands).
2. Write or replace plan (`hive_plan_write`). Bounded amendments use `hive_plan_patch` with `expectedRevision` from `hive_plan_read`.
3. Review plan (comments and/or chat).
4. Approve (`hive_plan_approve`).
5. Sync tasks (`hive_tasks_sync`). Numbered executable tasks come from `## Tasks`. Suite-only checks belong under `## Final Verification` unless they write tracked artifacts.
6. Start each runnable task (`hive_worktree_start`) and launch the returned worker payload.
7. Worker finishes with `hive_worktree_commit` (completed / blocked / failed / partial).
8. Merge completed task branches (`hive_merge`, usually squash with an explicit message).
9. Mark feature complete when done (`hive_feature_complete`).

Important separations:

- `hive_worktree_commit` commits on the task branch. It does not merge.
- `hive_plan_patch` never syncs tasks. After sequencing or scope changes, run `hive_tasks_sync({ refreshPending: true })` explicitly.
- Manual follow-up work uses `hive_task_create` with explicit `dependsOn` when needed. Refreshing pending plan tasks does not erase manual tasks or execution history.

### Blocked continuation

1. Read blockers from `hive_status`.
2. Get an operator decision (primary sessions use `question()`).
3. Continue with `hive_worktree_create({ continueFrom: "blocked", decision })` in the same worktree.
4. Launch a **new** worker session. Do not resume a finished session id.

### Failed or retry work

Start a fresh worker with a self-contained handoff. Compaction may re-anchor a still-running worker; it is not re-delegation.

### Merge notes

- Default integration is squash with a polished aggregate message (subject, blank line, body).
- Rebase and normal merge are explicit exceptions for intentionally structured history.
- No net tracked changes: `hive_merge` can return `success: true`, `merged: false`, `reasonCode: 'NO_TRACKED_CHANGES'`.
- Use `hive_status.helperStatus.mergeEligibility` before merge or cleanup decisions.

## Ad-hoc workflow

Use ad-hoc runs for isolated work that should not create a feature DAG.

| Tool | Purpose |
|------|---------|
| `hive_adhoc_worktree_create` | Create worktree; default `autoSpawnWorker: true` |
| `hive_adhoc_worktree_commit` | Commit in the ad-hoc worktree |
| `hive_adhoc_merge` | Integrate into the current branch |
| `hive_adhoc_cleanup` | Remove worktree (optional branch delete) |

Set `autoSpawnWorker: false` only for inspection, routing, or setup-only trees. Ad-hoc runs do not appear as feature tasks in `hive_status`.

## Agent modes

| Mode | Config | Default primary | Notes |
|------|--------|-----------------|-------|
| Unified | `"agentMode": "unified"` (default) | `hive-master` | Plans and orchestrates |
| Dedicated | `"agentMode": "dedicated"` | `architect-planner` | Planner and `swarm-orchestrator` are separate |

Specialists (both modes) include research, implementation, review, approach advice, helper recovery, ad-hoc orchestration, and simplicity review. Exact tool allowlists are role-filtered; see [HIVE-TOOLS.md](../packages/opencode-hive/docs/HIVE-TOOLS.md).

## Commands

Operator slash commands prepare workflow-specific instructions. They do not grant tools the active agent lacks. `/dash-review` and `/vuln-review` bind to private review primaries.

| Command | Purpose |
|---------|---------|
| `/interview` | One-question-at-a-time clarification |
| `/implementation-brief` | Copy-paste planning brief |
| `/hive-plan` | Create or update feature plan |
| `/approve-sync-plan` | Approve and sync tasks |
| `/start-execution` | Execute approved synced plan |
| `/council-directive` | Shape a reusable council directive |
| `/council` | Read-only council recommendation |
| `/dash-review [scope]` | Frozen disposable implementation review |
| `/vuln-review [intent] [flags]` | Authorized frozen-scope vulnerability review |
| `/compact-summary` | Compact recovery summary for the session |

Dedicated mode still requires the correct primary seat for planning vs execution commands (except the private review commands).

## Background jobs

Available only when OpenCode enables background subagents:

```text
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1
# or
OPENCODE_EXPERIMENTAL=1
```

Without the gate, board tools report disabled and orchestration stays blocking.

With the gate:

1. Launch independent work with native `task({ background: true, ... })` when foreground work can continue.
2. Wait for OpenCode's completion notification.
3. Refresh `hive_background_status`.
4. Reconcile or ignore terminal jobs (`hive_background_reconcile` / `_batch`).
5. Cancel only through `hive_background_cancel` when needed.

Board tools do not roll back files, branches, worktrees, commits, or reports. Do not edit `.hive/background-jobs.json` by hand. `recommendedNextAction` is board-local scheduler guidance, not merge readiness.

## Review commands

### `/dash-review`

Read-only review over one frozen disposable workspace. Arguments can name branch/ref/range/path/task/feature or another coherent target. Without arguments, inference requires a coherent conversation and Git/Hive surface.

### `/vuln-review`

Authorized static/local vulnerability review. No active exploitation, no product-source edits, no automatic fix. Full flag matrix, stages, and report contract: [plugin README Vulnerability Review](../packages/opencode-hive/README.md#vulnerability-review).

Private review tools (`hive_git_snapshot`, review workspace lifecycle, compare-report read) are runtime-gated for those workflows. They are not extra powers for standard roles.

## Task trace and recovery

| Tool | Use |
|------|-----|
| `hive_task_trace({ task_id })` | Compact forensic v2 report for one direct child |
| `hive_task_trace({ task_id, recovery: true })` | Terminal semantic projection only; untrusted claims |
| `hive_task_trace_content` | Re-read authorized non-reasoning v2 locators |

Rules:

- Returned task ids are observe-only. Never pass `task_id` into `task()` to resume.
- Recovery output must not auto-accept, merge, retry, or resume.
- Only complete generated unfinished work may justify a **new** task launch without `task_id`.
- Partial, fallback, error, or compacted results force inspection first.

## Repository manifests

Multi-repo projects declare members in:

```text
<project>/.hive/repositories.json
```

Shape:

```json
{
  "schemaVersion": 1,
  "repositories": [
    { "id": "api", "path": "./api" },
    { "id": "web", "path": "./web" }
  ]
}
```

Paths are project-relative and must stay inside the project root. Tools:

- `hive_repositories_discover` - find candidate repos (read-only)
- `hive_repositories_update` - add entries atomically
- `hive_repositories_status` - inspect mode and manifest

Task and ad-hoc worktrees become composite workspaces with per-repo checkouts under `repos/<repoId>/` when the task or run targets those ids. Legacy global `repositoryRoot` / `repositories` config fields are migration input only.

## Configuration

| Concern | Location |
|---------|----------|
| Runtime policy, agents, skills, MCPs, sandbox, council, hook cadence | `~/.config/opencode/agent_hive.json` only |
| Multi-repo topology | `<project>/.hive/repositories.json` |
| Feature/task state | `<project>/.hive/features/...` |
| Background board state | `<project>/.hive/background-jobs.json` (tool-owned) |

Useful global fields (non-exhaustive):

- `agentMode`: `unified` | `dedicated`
- `agents`: per-agent `model`, `temperature`, `variant`, `autoLoadSkills`
- `disableSkills` / `disableMcps`
- `customAgents` with `baseAgent` inheritance
- `council` groups and caps
- `sandbox`: `none` | `docker` (optional `dockerImage`, `persistentContainers`)
- `hook_cadence`: turn gating for selected hooks

Do not document or rely on inert/ambiguous keys such as `omoSlimEnabled` or `enableToolsFor` as capabilities.

Schema:

```text
https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json
```

## Operational boundaries

- Plan without approval is not permission to implement feature work.
- Workers verify best-effort; full suite verification belongs to the orchestrator after integration when practical.
- Subagents are terminal and cannot recurse, except a delegated planner may launch one level of read-only planning helpers.
- `question` is for primary sessions. Subagents return clarification text to the parent.
- Security-sensitive work that spans tasks needs an integrated review of the merged result, not only task-local checks.
- `/vuln-review` findings stay in session history unless you export them under your own policy.

## Reference map

| Topic | Doc |
|-------|-----|
| Tool contracts | [HIVE-TOOLS.md](../packages/opencode-hive/docs/HIVE-TOOLS.md) |
| On-disk model | [DATA-MODEL.md](../packages/opencode-hive/docs/DATA-MODEL.md) |
| Architecture | [DESIGN.md](DESIGN.md) |
| npm-oriented reference | [packages/opencode-hive/README.md](../packages/opencode-hive/README.md) |
| Hook turn gating | [HOOK_CADENCE.md](../packages/opencode-hive/docs/HOOK_CADENCE.md) |
