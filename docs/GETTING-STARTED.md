# Getting Started

Onboarding for teammates who already have OpenCode working. Goal: install `oc-arkive`, run one feature, and know where the advanced knobs live.

## Prerequisites

- OpenCode `>= 1.14.48` (matches the `oc-arkive` peer dependency).
- Work in a project with a git repository root, or a valid `<project>/.hive/repositories.json` manifest whose entries point to git repositories. Feature tasks and ad-hoc runs create git worktrees.
- You do not need a separate config repository. Plugin install plus optional global JSON is enough.

## Install

Append `oc-arkive@latest` to the existing `plugin` array in your OpenCode config. Keep your existing plugin entries, preserve unrelated settings, and retain the surrounding config. This JSONC fragment uses placeholders:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "existing-plugin@version", // placeholder: retain your current plugin entry
    "oc-arkive@latest"
  ],
  "model": "provider/model" // placeholder: retain your existing setting
}
```

For a brand-new config, a plugin array containing only `"oc-arkive@latest"` is sufficient.

For the full existing-config compatibility note, see the [plugin README](../packages/opencode-hive/README.md#existing-opencode-configurations).

Restart OpenCode. Confirm agents such as `hive-master` (unified mode) or `architect-planner` (dedicated mode) appear in the agent list.

Optional global config path:

```text
~/.config/opencode/agent_hive.json
```

Project-local `agent_hive.json` / `agent-hive.json` files are ignored. Schema URL for editor completion:

```text
https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json
```

Minimal example:

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "agentMode": "unified"
}
```

## First feature (happy path)

1. Open a project with a git repository root or valid repository manifest in OpenCode.
2. Ask for a feature in plain language, or run `/hive-plan` with a short brief.
3. The planner writes `.hive/features/<name>/plan.md`.
4. Review the plan in chat or with the VS Code companion (comments on `plan.md` / `overview.md`).
5. Approve and sync tasks: `/approve-sync-plan`, or ask the agent to approve and run `hive_tasks_sync`.
6. Start execution: `/start-execution`, or ask the agent to execute the approved plan.
7. Workers implement in isolated worktrees under `.hive/.worktrees/`.
8. Check results, then let the orchestrator merge completed task branches into your current branch.
9. When the feature is done, the orchestrator can mark it complete.

What you should see on disk after planning:

```text
.hive/features/<name>/
  feature.json
  plan.md
  context/
  tasks/          # after sync
```

## First ad-hoc request

Not every change needs a feature plan. For bounded non-feature work (docs fix, small refactor, investigation with a patch), select `hive-builder` for the ad-hoc run. It owns the `hive_adhoc_*` tools in both modes. In unified mode, `hive-master` also has the non-review Hive tool set and can coordinate an ad-hoc run; in dedicated mode, select `hive-builder` directly. `architect-planner` is planning-only and does not route ad-hoc work to Hive Builder.

Ad-hoc runs use `hive_adhoc_*` tools, live under `.hive/.worktrees/adhoc/<runId>/`, and do not create feature or task records. They do not appear in normal feature `hive_status` task lists.

Use a feature when you want plan review, a task DAG, and an audit trail. Use ad-hoc when the work is short-lived and does not need that structure.

## Review surfaces

| Surface | When to use |
|---------|-------------|
| Plan comments (VS Code or chat) | Shape the plan before approval |
| `/dash-review [scope]` | Read-only review of a frozen implementation snapshot |
| `/vuln-review [intent] [flags]` | Authorized static vulnerability review of a frozen scope |
| `/council` / `/council-directive` | Read-only multi-seat recommendation |
| `context/overview.md` | Human-facing branch summary after work lands |

`/vuln-review` does not edit product source and does not auto-remediate. Full scope flags and safety rules are in the [plugin README](../packages/opencode-hive/README.md#vulnerability-review).

## Optional companion: VS Code

Download `vscode-arkive.vsix` from the [GitHub Releases](https://github.com/imarshallwidjaja/agent-hive/releases) page and install it in VS Code. The extension is a viewer plus limited archive actions; OpenCode remains the execution runtime.

## Built-in research tools

The plugin merges research MCPs at startup:

| MCP id | Purpose | Notes |
|--------|---------|-------|
| `websearch` | Exa web search | Needs `EXA_API_KEY` |
| `context7` | Library docs | No key |
| `grep_app` | Public GitHub code search | No key |
| `ast_grep` | Structural code search | Bundled |

Disable selected MCPs globally:

```json
{
  "disableMcps": ["websearch"]
}
```

You do not need to copy an MCP template into the project for these built-ins.

## Initial troubleshooting

| Symptom | Check |
|---------|-------|
| Plugin agents missing | Plugin entry is `oc-arkive@latest`, OpenCode restarted, version `>= 1.14.48` |
| Config changes ignored | Edit `~/.config/opencode/agent_hive.json` only |
| Worktree or merge errors | Project has a git repository root or valid repository manifest; clean or understand dirty state before merge |
| Plan approved but no tasks | Run task sync after approval; numbered tasks come from `## Tasks` in `plan.md` |
| Worker seems stuck after compaction | Task workers re-read `worker-prompt.md`; ask the primary to inspect status, not to resume a dead session id |
| Background tools report disabled | Set `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` only if you want the board |

## Next reading

- [Operator Guide](OPERATOR-GUIDE.md) for feature vs ad-hoc lifecycle, modes, background jobs, manifests, and boundaries
- [Plugin README](../packages/opencode-hive/README.md) for commands, tools, and configuration reference
- [Philosophy](../PHILOSOPHY.md) for the coordination model
