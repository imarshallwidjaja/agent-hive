# Agent Hive (`oc-arkive`)

[![npm version](https://img.shields.io/npm/v/oc-arkive?logo=npm&logoColor=white)](https://www.npmjs.com/package/oc-arkive)

OpenCode workflow plugin for plan-first development with isolated workers, durable `.hive/` state, and explicit human approval gates.

After installation, ask Hive for a feature in plain language. The first feature loop is below. Ad-hoc work, independent review commands, and the public agent seats are in the [Operator Guide](docs/OPERATOR-GUIDE.md).

## Demo

Older walkthrough of the plan-first loop. Package names and UI have changed since this was recorded.

https://github.com/user-attachments/assets/6290b435-1566-46b4-ac98-0420ed321204

## Requirements

Feature work is location-neutral: a Git worktree, the current checkout, a non-Git directory, or report-only. Worktree tools provide optional Git isolation and integration; they do not assign workers or change task status. See the [Operator Guide](docs/OPERATOR-GUIDE.md).

- [OpenCode](https://opencode.ai) `>= 1.18.30` (peer dependency of `oc-arkive`; required for native `tool.definition` and task attachment hooks)
- Worktree workflows require a project whose work resolves to one or more git repositories. Single-repo projects need no manifest; multi-repo topology is optional. When a multi-repo root needs explicit topology, ask Hive to inspect, discover, and update it; do not hand-create `<project>/.hive/repositories.json`.
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
4. Start execution with `/start-execution`. The primary chooses direct work,
   delegation, or a worktree from the situation, then tracks dependencies and progress.
5. Each worker runs task-level, best-effort checks. The primary
   records status and reports with `hive_task_update`.
6. Merge completed worktree task branches with `hive_worktree_merge`. In-place
   or report-only work has no Hive Git merge step.
7. Run fresh build/test verification against the merged result or the live target.
8. Mark the feature complete only after that target verification passes.

## What you can run

| Workflow | When | How you start |
|----------|------|----------------|
| `/grill` | Explicit alignment on any context, without assuming implementation or a next command | `/grill <context>` |
| `/interview` | Clarify an idea toward a reliable implementation-brief handoff | `/interview <idea>` |
| Feature | Plan review, task dependencies, isolated task worktrees, or a durable audit trail | Ask in plain language, or `/hive-plan` |
| Ad-hoc (`hive-builder`) | Bounded non-feature work that should not create feature or task records | Talk to `hive-builder` (dedicated mode) or `hive-master` (unified) |
| `/dash-review` | Read-only review of a folder, inline text, or the current checkout | `/dash-review [intent]` |
| `/vuln-review` | Authorized bounded static security review | `/vuln-review [intent] [flags]` |

By default (dedicated mode), `architect-planner` and `swarm-orchestrator` handle
feature work and `hive-builder` handles ad-hoc work. Set `"agentMode": "unified"`
for one hybrid `hive-master` that can coordinate both. `/dash-review` and
`/vuln-review` always bind to separate review primaries.

For ad-hoc work with multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, possible background execution, or an expected need for more than one worker attempt or turn, either ad-hoc seat loads `orchestrating-ad-hoc-work` before worktree create or delegated dispatch. Rejected feature escalation continues ad-hoc only after material scope, contracts, and risks are resolved.

## Agents at a glance

Dedicated mode registers `architect-planner` and `swarm-orchestrator`. Unified
mode registers `hive-master` instead. `hive-builder` and the subagents below
are in both modes.

| Seat | Role |
|------|------|
| `architect-planner` | Writes feature plans. Does not implement. Default in dedicated mode. |
| `swarm-orchestrator` | Executes approved feature work. Dedicated-mode execution seat. |
| `hive-master` | Hybrid planner and orchestrator. Unified-mode default. |
| `hive-builder` | Ad-hoc orchestrator. No feature or task DAG. |
| `scout-researcher` | Retrieves bounded source evidence; does not own diagnosis, tradeoffs, or solution selection. |
| `forager-worker` | Implements in the chosen workspace; diagnosis-only work is report-only. Never delegates. |
| `plan-reviewer` | Checks whether a plan is worker-executable. |
| `code-reviewer` | Checks an implementation against the task or plan. |
| `simplicity-reviewer` | Deletion-biased cleanup of a completed diff. |
| `approach-advisor` | Read-only architecture and tradeoff advice. |
| `vulnerability-reviewer` | Read-only attacker-to-impact review. |

Why each seat exists, how it behaves, and the full ad-hoc / dash-review /
vuln-review loops are in the [Operator Guide](docs/OPERATOR-GUIDE.md).

Runtime configuration is global only: `~/.config/opencode/agent_hive.json`.
Project-local `agent_hive.json` and `agent-hive.json` files are ignored. Dedicated
mode is the default; set `"agentMode": "unified"` for a single `hive-master` seat
(see the [plugin README agent mode section](packages/opencode-hive/README.md#agent-mode)).
For existing-config compatibility, see the
[plugin README](packages/opencode-hive/README.md#existing-opencode-configurations).

## Packages

| Package | Distribution | Role |
|---------|--------------|------|
| [`oc-arkive`](https://www.npmjs.com/package/oc-arkive) | npm | OpenCode plugin: agents, tools, skills, MCPs, commands |
| `vscode-arkive` | GitHub Release VSIX | Sidebar, plan/overview review, background job viewer |

## Documentation

| Doc | Audience |
|-----|----------|
| [Operator Guide](docs/OPERATOR-GUIDE.md) | Agents, feature / ad-hoc / dash-review / vuln-review workflows |
| [Plugin README](packages/opencode-hive/README.md) | Slash-command flags, tool contracts, helper recovery, and config |
| [Philosophy](PHILOSOPHY.md) | Why the workflow is shaped this way |
| [Design](docs/DESIGN.md) | Internal architecture and source-of-truth rules |
| [Hive Tools](packages/opencode-hive/docs/HIVE-TOOLS.md) | Full tool inventory and contracts |
| [Data Model](packages/opencode-hive/docs/DATA-MODEL.md) | `.hive/` layout and task status fields |
| [VS Code extension](packages/vscode-hive/README.md) | Companion install and scope |
| [Releasing](docs/RELEASING.md) | Maintainers: publish and recovery |

## License

MIT with Commons Clause. See [LICENSE](LICENSE).
