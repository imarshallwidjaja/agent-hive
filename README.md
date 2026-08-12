# Agent Hive (`oc-arkive`)

[![npm version](https://img.shields.io/npm/v/oc-arkive?logo=npm&logoColor=white)](https://www.npmjs.com/package/oc-arkive)

OpenCode workflow plugin for plan-first development with isolated workers, durable `.hive/` state, and explicit human approval gates.

After installation, ask Hive for a feature in plain language. The first feature loop is below; the [Operator Guide](docs/OPERATOR-GUIDE.md) covers day-to-day operation.

## Requirements

- [OpenCode](https://opencode.ai) `>= 1.14.48` (peer dependency of `oc-arkive`)
- A project whose work resolves to one or more git repositories. Single-repo projects need no manifest; multi-repo topology is optional. When a multi-repo root needs explicit topology, ask Hive to inspect, discover, and update it; do not hand-create `<project>/.hive/repositories.json`.
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

## First feature loop

1. Open the project and ask for a feature in plain language, or use `/hive-plan`.
2. The primary agent discusses the scope and writes a plan. Review it in chat or
   VS Code, add comments, and request changes until the plan is clear.
3. Approve the plan with `/approve-sync-plan` or ask the agent to approve and
   sync it. Hive creates the executable task records.
4. Start execution with `/start-execution`. Workers perform task-level,
   best-effort checks in isolated git worktrees while implementing tasks. The
   primary agent tracks dependencies and progress.
5. The operator/orchestrator inspects completed worker output.
6. Merge completed task branches after inspection.
7. Run fresh build/test verification against the merged result.
8. Mark the feature complete only after that merged-result verification passes.

Use a feature when the work needs plan review, task dependencies, isolated task
worktrees, or a durable audit trail. Use an ad-hoc run for bounded non-feature
work that should not create feature or task records. In unified mode the primary
agent coordinates both; in dedicated mode, the planner and orchestrator handle
feature work and `hive-builder` handles ad-hoc work.

Runtime configuration is global only: `~/.config/opencode/agent_hive.json`.
Project-local `agent_hive.json` and `agent-hive.json` files are ignored. Set
`"agentMode": "dedicated"` for separate planner and orchestrator seats. For
existing-config compatibility, see the [plugin README](packages/opencode-hive/README.md#existing-opencode-configurations).

## Packages

| Package | Distribution | Role |
|---------|--------------|------|
| [`oc-arkive`](https://www.npmjs.com/package/oc-arkive) | npm | OpenCode plugin: agents, tools, skills, MCPs, commands |
| `vscode-arkive` | GitHub Release VSIX | Sidebar, plan/overview review, background job viewer |

## Documentation

| Doc | Audience |
|-----|----------|
| [Operator Guide](docs/OPERATOR-GUIDE.md) | Day-to-day workflow and review choices |
| [Plugin README](packages/opencode-hive/README.md) | Detailed npm, operator, helper recovery, and simplicity review reference |
| [Philosophy](PHILOSOPHY.md) | Why the workflow is shaped this way |
| [Design](docs/DESIGN.md) | Internal architecture and source-of-truth rules |
| [Hive Tools](packages/opencode-hive/docs/HIVE-TOOLS.md) | Full tool inventory and contracts |
| [Data Model](packages/opencode-hive/docs/DATA-MODEL.md) | `.hive/` layout and task status fields |
| [VS Code extension](packages/vscode-hive/README.md) | Companion install and scope |
| [Releasing](docs/RELEASING.md) | Maintainers: publish and recovery |

## License

MIT with Commons Clause. See [LICENSE](LICENSE).
