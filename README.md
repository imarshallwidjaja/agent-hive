# Agent Hive (`oc-arkive`)

[![npm version](https://img.shields.io/npm/v/oc-arkive?logo=npm&logoColor=white)](https://www.npmjs.com/package/oc-arkive)

OpenCode workflow plugin for plan-first development with isolated workers, durable `.hive/` state, and explicit human approval gates.

After installation, ask Hive for a feature in plain language. The first feature loop is below. Ad-hoc work, independent review commands, and the public agent seats are in the [Operator Guide](docs/OPERATOR-GUIDE.md).

## Demo

Older walkthrough of the plan-first loop. Package names and UI have changed since this was recorded.

https://github.com/user-attachments/assets/6290b435-1566-46b4-ac98-0420ed321204

## Requirements

Tracked feature writes use matching Git worktrees; non-Git or report-only work follows the documented direct-work exceptions. Worktree tools do not assign workers or change task status. See the [Operator Guide](docs/OPERATOR-GUIDE.md).

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
4. Start execution with `/start-execution`. The primary resolves repository-backed
   placement, delegates work, and tracks dependencies and progress.
5. For a worktree implementation assignment, the worker runs selected checks,
   commits assigned changes, and returns the exact source commit pin with
   evidence for the tested candidate. In-place, non-Git, report-only, and
   diagnosis-only assignments return evidence without a source commit. The
   primary records status and reports with `hive_task_update`.
6. Inspect the worktree and merge completed task branches with
   `hive_worktree_merge`, supplying the worker's source pin and the previously
   inspected destination identity (`expectedTarget` or `expectedTargets`).
   Non-Git or report-only work has no Hive Git merge step.
7. Run selected integrated acceptance on the merged candidate, including
   binding repository/operator checks and every named `## Final Verification`
   obligation. Keep required pre-merge checks before merge.
8. Mark the feature complete only after applicable required evidence and reviews
   pass. A task-branch result does not establish integrated acceptance.

The planner selects checks from changed behavior, risk, repository requirements,
canonical owners, and affected consumers. If impact is unclear, the operator
guide explains how to broaden checks, preserve failure evidence, and decide when
existing results still apply.

## What you can run

| Workflow | When | How you start |
|----------|------|----------------|
| `/grill` | Explicit alignment on any context, without assuming implementation or a next command | `/grill <context>` |
| `/interview` | Clarify an idea toward a reliable implementation-brief handoff | `/interview <idea>` |
| Feature | Plan review, task dependencies, isolated task worktrees, or a durable audit trail | Ask in plain language, or `/hive-plan` |
| Ad-hoc (`hive-builder`) | Bounded non-feature work that should not create feature or task records | Talk to `hive-builder` (dedicated mode) or `hive-master` (unified) |
| `/dash-review` | Read-only review of a folder, inline text, or the current checkout | `/dash-review [intent]` |
| `/vuln-review` | Authorized read-only security review of a requested source | `/vuln-review [intent]` |
| Native `complexity-review` | Explicit one-shot complexity review of an explicit diff or bounded named scope; otherwise current staged, unstaged, and relevant nonignored untracked changes | `/complexity-review <scope/philosophy prose>` |
| Native `complexity-audit` | Explicit one-shot complexity audit of named roots or codebases | `/complexity-audit <scope/philosophy prose>` |

`/dash-review` and `/vuln-review` bind to separate review primaries.

For ad-hoc work with multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, possible background execution, or an expected need for more than one worker attempt or turn, either ad-hoc seat loads `orchestrating-ad-hoc-work` before worktree create or delegated dispatch. Rejected feature escalation continues ad-hoc only after material scope, contracts, and risks are resolved.

## Agents at a glance

Dedicated mode defaults to `architect-planner` for planning and uses
`swarm-orchestrator` for execution; `hive-master` is hidden. Unified mode makes
`hive-master` the default and keeps the split seats available. `hive-builder`
and the subagents below are available in both modes.

| Seat | Role |
|------|------|
| `architect-planner` | Writes feature plans. Does not implement. Default in dedicated mode. |
| `swarm-orchestrator` | Executes approved feature work. Dedicated-mode execution seat. |
| `hive-master` | Hybrid planner and orchestrator for feature and ad-hoc work. Unified-mode default. |
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

Runtime configuration lives in `~/.config/opencode/agent_hive.json`. A project
may override `model` and/or `variant` for matching built-in or configured custom
agents in `.hive/agent-hive.override.json`, under the `agents` or `customAgents`
keys. Unknown names do not create agents. The global file remains authoritative
for all other settings. Project `.hive/agent-hive.json` and
`.opencode/agent_hive.json` files remain ignored. Restart OpenCode after changing
either config file. For agent-mode settings and existing-config compatibility,
see the [plugin README](packages/opencode-hive/README.md#agent-mode) and its
[existing-config section](packages/opencode-hive/README.md#existing-opencode-configurations).

## Packages

| Package | Distribution | Role |
|---------|--------------|------|
| [`oc-arkive`](https://www.npmjs.com/package/oc-arkive) | npm | OpenCode plugin: agents, Hive tools, skills, commands |
| `vscode-arkive` | GitHub Release VSIX | Sidebar, plan/overview review, background job viewer |

## Documentation

| Doc | Audience |
|-----|----------|
| [Operator Guide](docs/OPERATOR-GUIDE.md) | Agents, feature / ad-hoc / dash-review / vuln-review workflows |
| [Plugin README](packages/opencode-hive/README.md) | Command usage, helper recovery, and config |
| [Philosophy](PHILOSOPHY.md) | Why the workflow is shaped this way |
| [Design](docs/DESIGN.md) | Internal architecture and source-of-truth rules |
| [Hive Tools](packages/opencode-hive/docs/HIVE-TOOLS.md) | Full tool inventory and contracts |
| [Data Model](packages/opencode-hive/docs/DATA-MODEL.md) | `.hive/` layout and task status fields |
| [VS Code extension](packages/vscode-hive/README.md) | Companion install and scope |
| [Releasing](docs/RELEASING.md) | Maintainers: publish and recovery |

## License

MIT with Commons Clause. See [LICENSE](LICENSE).
