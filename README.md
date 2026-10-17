# Agent Hive (`oc-arkive`)

[![npm version](https://img.shields.io/npm/v/oc-arkive?logo=npm&logoColor=white)](https://www.npmjs.com/package/oc-arkive)

OpenCode workflow plugin for plan-first development with isolated workers, durable `.hive/` state, and explicit human approval gates.

After installation, ask Hive for a feature in plain language. The first feature loop is below. Ad-hoc work, independent review commands, and the public agent seats are in the [Operator Guide](docs/OPERATOR-GUIDE.md).

## Demo

Older walkthrough of the plan-first loop. Package names and UI have changed since this was recorded.

https://github.com/user-attachments/assets/6290b435-1566-46b4-ac98-0420ed321204

## Requirements

- [OpenCode](https://opencode.ai) v1, with a floor of `1.18.30`, or v2, qualified on `2.0.26`. `oc-arkive@5.0.0` is the first release with both host entries, and releases through 4.2.0 support v1 only. The v2 qualification covers 2.0.26 and is not a support claim for later v2 releases.
- For worktree workflows, a project whose work resolves to one or more Git repositories. Single-repo projects need no manifest. For a multi-repo root, ask Hive to inspect, discover, and update the topology instead of hand-creating `<project>/.hive/repositories.json`.
- Optional: [VS Code](https://code.visualstudio.com/) for sidebar plan review through `vscode-arkive`.

## Install

### OpenCode v1

1. Append `oc-arkive@latest` (or a pinned version such as `oc-arkive@5.0.0`) to the existing `plugin` array in your OpenCode config (`opencode.json` or `opencode.jsonc`). Keep your existing plugin entries and unrelated settings. This JSONC fragment uses placeholders:

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

For a brand-new config, a plugin array containing only `"oc-arkive@latest"` is enough.

2. Restart OpenCode so it loads the plugin.

### OpenCode v2

Install the released package with npm into a dedicated directory (`npm install oc-arkive@5.0.0`) and point the v2 `plugins` entry at the absolute installed `node_modules/oc-arkive/dist` directory. Set `readTransport: "direct"` when `execute` is denied, give the running server's URL and password environment-variable name for history reads and continuation checks, and set `experimental.subagent_depth` to `2` so a delegated Architect can call its helpers. The [v2 setup reference](packages/opencode-hive/README.md#opencode-v2) has the complete fragment, the contributor build path, and the model-selection rules.

Your v2 settings own agent selection, presentation, model and variant, limits, and tool visibility. Hive adds its role instructions to each request and checks role and child authority before every effect, so a tool your settings make visible can still be refused. Before moving a project from one host to the other, follow the [handover procedure](docs/OPERATOR-GUIDE.md#switching-opencode-hosts-and-rollback).

### Upgrade

Update the plugin entry or the installed package first, then restart the long-lived process that loaded the plugin. Restarting a host that still points at an older install keeps running the older version. The [Operator Guide](docs/OPERATOR-GUIDE.md#upgrade) lists configuration keys to remove before upgrading and what to do with live workers.

## First feature loop

1. Ask for a feature in plain language, or run `/hive-plan`. The planner discusses scope and writes a plan.
2. Review the plan in chat or in VS Code, add comments, and ask for changes until it is clear. Before approval the agents also get a readiness assessment (`plan-reviewer`) and an architecture assessment (`approach-advisor`) of the same plan text.
3. Approve it with `/approve-sync-plan`, which also creates the executable task records.
4. Start execution with `/start-execution`. The primary places each task's tracked Git work in a matching worktree, delegates it, reviews the result, and merges the worker's committed changes.
5. The primary runs the plan's final verification on the merged result and completes the feature only after the required checks and reviews pass. A task-branch result does not establish integrated acceptance.

The [Operator Guide](docs/OPERATOR-GUIDE.md) covers each step in depth: source commit pins and destination checks at merge, task reports and handoffs, and how checks are chosen and when earlier results still apply.

## What you can run

| Workflow | When | How you start |
|----------|------|----------------|
| `/grill` | Plan-ready alignment (decisions, rationale, constraints, acceptance criteria) to hand to `/hive-plan` | `/grill <context>` |
| `/interview` | Flexible clarification of an idea, including ad-hoc work, with no fixed next step | `/interview <idea>` |
| Feature | Plan review, task dependencies, isolated task worktrees, or a durable audit trail | Ask in plain language, or `/hive-plan` |
| Ad-hoc (`hive-builder`) | Bounded non-feature work that should not create feature or task records | Talk to `hive-builder` (dedicated mode) or `hive-master` (unified) |
| `/dash-review` | Read-only review of a folder, inline text, or the current checkout | `/dash-review [intent]` |
| `/vuln-review` | Authorized read-only security review of a requested source | `/vuln-review [intent]` |
| `/worklog` | Catch up on where a feature or session stands from its shared Worklog, read-only | `/worklog [request]` |
| `complexity-review` skill | Explicit one-shot complexity review of a diff or bounded named scope; without one, the current staged, unstaged, and relevant nonignored untracked changes | Ask for `complexity-review` by name with the scope in ordinary prose; on the v2 TUI, `@complexity-review <scope>` |
| `complexity-audit` skill | Explicit one-shot complexity audit of named roots or codebases | Ask for `complexity-audit` by name with the roots; on the v2 TUI, `@complexity-audit <scope>` |

`/dash-review` and `/vuln-review` bind to separate review primaries. For ad-hoc work with multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, possible background execution, or an expected need for more than one worker attempt or turn, the ad-hoc seat loads `orchestrating-ad-hoc-work` before creating worktrees or dispatching workers. The [Operator Guide](docs/OPERATOR-GUIDE.md#choose-a-workflow) explains when each workflow fits.

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

The [Operator Guide](docs/OPERATOR-GUIDE.md#agents) explains why each seat exists and how it behaves, including the read-only `hive-helper` for feature and ad-hoc trace questions, interrupted-worker evidence, and destination drift. Each role gets only the Hive tools it needs, and primaries alone own merge, cleanup, approval, constraints, and other control actions. The [tool-access matrix](packages/opencode-hive/docs/HIVE-TOOLS.md#agent-tool-access) lists every grant and how each host enforces it.

Agent Hive's runtime configuration lives in `~/.config/opencode/agent_hive.json` on both hosts, and a project can override only agent `model` and `variant` in `.hive/agent-hive.override.json`. The v2 entry also reads `readTransport` and `server` from its `plugins` entry. Restart the host after changing any of these. See [Configuration](packages/opencode-hive/README.md#configuration) and the [v2 options](packages/opencode-hive/README.md#options).

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

Agent Hive's code is released under the [MIT License](LICENSE), including the `oc-arkive` plugin, `hive-core` and the VS Code extension. Skills imported from other projects keep their upstream licenses, listed in the `LICENSE*` and `UPSTREAM.md` files inside each skill directory.
