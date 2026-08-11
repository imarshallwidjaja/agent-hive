# Agent Hive (`oc-arkive`)

OpenCode workflow plugin for plan-first development with isolated workers, durable `.hive/` state, and explicit human approval gates.

If you already run OpenCode, install the plugin, restart, and ask for a feature. The shortest path is below. Deeper operator detail lives in the docs linked at the end.

## Requirements

- [OpenCode](https://opencode.ai) `>= 1.14.48` (peer dependency of `oc-arkive`)
- A git repository root, or a valid `<project>/.hive/repositories.json` manifest whose entries point to git repositories (task and ad-hoc worktrees need one of these)
- Optional: [VS Code](https://code.visualstudio.com/) for sidebar plan review via `vscode-arkive`

## Quick start

1. Append `oc-arkive@latest` to the existing `plugin` array in your OpenCode config (`opencode.json` or `opencode.jsonc`). Keep your existing plugin entries, preserve unrelated settings, and retain the surrounding config. This JSONC fragment uses placeholders:

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

2. Restart OpenCode so it loads the plugin.
3. Open a project with a git repository root or valid repository manifest and ask for a feature in plain language, or use `/hive-plan`.
4. Review the plan (editor comments or chat). Approve when ready (`/approve-sync-plan` or ask the agent to approve and sync).
5. Start execution (`/start-execution` or ask the agent to run the approved plan). Workers implement in isolated git worktrees.
6. Verify results, then let the orchestrator merge completed task branches.

Built-in research MCPs (web search, Context7, grep.app, ast-grep) load with the plugin. Disable any of them with `disableMcps` in `~/.config/opencode/agent_hive.json`. Set `EXA_API_KEY` if you want Exa web search.
For existing-config compatibility details, see the [plugin compatibility note](packages/opencode-hive/README.md#existing-opencode-configurations).

Runtime config is global only: `~/.config/opencode/agent_hive.json`. Project-local `agent_hive.json` / `agent-hive.json` files are ignored. Repository topology for multi-repo projects lives in `<project>/.hive/repositories.json`.

Default agent mode is **unified** (`hive-master` plans and orchestrates). Set `"agentMode": "dedicated"` for separate planner (`architect-planner`) and orchestrator (`swarm-orchestrator`) seats.

## Capability map

Happy path first. Everything below the line is optional or advanced.

**Core**

- Feature plan, approval, task sync, isolated task worktrees, merge, status
- Durable feature state under `.hive/features/<name>/`
- Unified or dedicated agent modes
- 29 standard Hive tools plus 6 runtime-gated private review tools
- 16 bundled skills loaded through OpenCode's native `skill` tool
- Research, worker, reviewer, helper recovery, ad-hoc orchestration, and simplicity review
- Built-in research MCPs; per-MCP disable via `disableMcps`

**Common next steps**

- Ad-hoc orchestration outside a feature (`hive_adhoc_*`)
- Optional VS Code companion for sidebar status and plan/overview comments
- Council commands (`/council-directive`, `/council`) for read-only multi-seat advice
- `/dash-review` for frozen disposable implementation review
- `/vuln-review` for authorized, read-only static vulnerability review of a frozen scope

**Advanced / optional**

- Background job board (`hive_background_status` / reconcile / cancel) when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` is set
- Repository manifests and composite multi-repo workspaces
- Task trace and terminal recovery inspection (`hive_task_trace`, `hive_task_trace_content`)
- Docker sandbox for worker shell commands
- Custom derived subagents, per-agent models, council group overrides
- Compaction recovery via durable `.hive/sessions.json` metadata

## Packages

| Package | Distribution | Role |
|---------|--------------|------|
| [`oc-arkive`](https://www.npmjs.com/package/oc-arkive) | npm | OpenCode plugin: agents, tools, skills, MCPs, commands |
| `vscode-arkive` | GitHub Release VSIX | Sidebar, plan/overview review, background job viewer |

## Documentation

| Doc | Audience |
|-----|----------|
| [Getting Started](docs/GETTING-STARTED.md) | Teammates with OpenCode already configured |
| [Operator Guide](docs/OPERATOR-GUIDE.md) | Day-to-day feature, ad-hoc, review, and config operations |
| [Philosophy](PHILOSOPHY.md) | Why the workflow is shaped this way |
| [Design](docs/DESIGN.md) | Internal architecture and source-of-truth rules |
| [Plugin README](packages/opencode-hive/README.md) | npm install, commands, tools, config reference |
| [Hive Tools](packages/opencode-hive/docs/HIVE-TOOLS.md) | Full tool inventory and contracts |
| [Data Model](packages/opencode-hive/docs/DATA-MODEL.md) | `.hive/` layout and task status fields |
| [Hook Cadence](packages/opencode-hive/docs/HOOK_CADENCE.md) | Optional hook turn gating |
| [VS Code extension](packages/vscode-hive/README.md) | Companion install and scope |
| [Releasing](docs/RELEASING.md) | Maintainers: publish and recovery |

## License

MIT with Commons Clause. See [LICENSE](LICENSE).
