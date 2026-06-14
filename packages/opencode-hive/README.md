# oc-arkive

[![npm version](https://img.shields.io/npm/v/oc-arkive)](https://www.npmjs.com/package/oc-arkive)
[![License: MIT with Commons Clause](https://img.shields.io/badge/License-MIT%20with%20Commons%20Clause-blue.svg)](../../LICENSE)

OpenCode plugin for plan-first development with isolated task execution, review gates, and persistent audit trails.

## Why Hive?

Hive adds a small, strict loop on top of OpenCode: plan, approve, then execute in isolated git worktrees with full audit trails.

## Installation

Add the plugin to `opencode.json`. OpenCode handles npm resolution automatically; you do not need to run `npm install` yourself.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-arkive@latest"]
}
```

## Optional: Enable MCP Research Tools

1. Create `.opencode/mcp-servers.json` using the template:
   - From this repo: `packages/opencode-hive/templates/mcp-servers.json`
   - Or from the installed npm package: `node_modules/oc-arkive/templates/mcp-servers.json`
2. Set `EXA_API_KEY` to enable `websearch_exa` (optional).
3. Restart OpenCode.

This enables tools like `grep_app_searchGitHub`, `context7_query-docs`, `websearch_web_search_exa`, and the official ast-grep MCP tools: `ast_grep_dump_syntax_tree`, `ast_grep_test_match_code_rule`, `ast_grep_find_code`, and `ast_grep_find_code_by_rule`.

The bundled `ast_grep` MCP tools run through the official ast-grep server.

## The Workflow

1. **Create Feature** — `hive_feature_create("dark-mode")`
2. **Write Plan** — AI generates structured plan
3. **Review** — Optional `vscode-arkive` companion for overview/plan review and comments
4. **Approve** — `hive_plan_approve()`
5. **Execute** — Tasks run in isolated git worktrees
6. **Ship** — Clean commits, full audit trail

Modern plans sync numbered tasks only from `## Tasks`. Keep pure release or suite-level checks in `## Final Verification` unless they need a worker to write tracked artifacts.

### Operator Commands

`oc-arkive` registers these slash commands as operator entry prompts. They prepare the active agent with workflow-specific instructions; they do not replace Hive tools, switch agents automatically, or make unavailable tools available to the current agent.

| Command | Purpose |
|---------|---------|
| `/interview` | Clarify an idea one question at a time before planning. |
| `/implementation-brief` | Produce a copy-paste-ready brief for a later Hive plan. |
| `/hive-plan` | Create or update the Hive feature plan from a spec or brief. |
| `/approve-sync-plan` | Approve the active plan and sync executable tasks. |
| `/start-execution` | Start execution for an approved and synced plan. |
| `/council-directive` | Turn rough input into a reusable directive for a council run. |
| `/council` | Run a read-only council and synthesize a recommendation. |
| `/compact-summary` | Produce a compact recovery summary for the current session. |

`/hive` has been removed. Feature creation now belongs to the planning flow and the Hive tools, usually `hive_feature_create` followed by `hive_plan_write`, review, approval, task sync, execution, and merge.

`/council` accepts `/council --group <group> <directive>`. If `--group` is omitted, Hive uses `council.defaultGroup`. Free-text tokens are directive text, not implicit group selectors.

Routing depends on `agentMode`:

| Command set | Unified mode | Dedicated mode |
|-------------|--------------|----------------|
| `/interview`, `/implementation-brief`, `/hive-plan`, `/council-directive`, `/council` | Use `hive-master`. | Route or delegate to `architect-planner`. |
| `/approve-sync-plan`, `/start-execution` | Use `hive-master`. | Route or delegate to `swarm-orchestrator`. |
| `/compact-summary` | Use `hive-master`. | Route or delegate to `scout-researcher`. |

In dedicated mode, slash commands do not switch agents by themselves. If the active agent is not the route target, delegate or reroute to the target agent and stop if that is not possible.

Background instructions appear only when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` is set and the bundled background protocol is available. Use the existing Background Orchestration section and the `background-delegation` skill for the scheduler protocol; command text only points at it when the gate is open.

### Planning-mode delegation

During planning, "don't execute" means "don't implement" (no code edits, no worktrees). Read-only exploration is explicitly allowed and encouraged, both via local tools and by delegating to Scout.

When delegation is warranted, synthesize the task before handing it off: name the file paths or search target, state the expected result, and say what done looks like. Workers do not inherit planner context.

For execution work, treat worker output as evidence to inspect, not proof to trust blindly. OpenCode is the supported execution runtime; if you use `vscode-arkive`, treat it as a review/sidebar companion. Read changed files yourself and run the shared verification commands on the main branch before claiming the batch is complete.

### Local skill and model use cases

- **Local skill experiments:** keep a skill in `<project>/.opencode/skills/<id>/SKILL.md` or `<project>/.claude/skills/<id>/SKILL.md`, then load it with OpenCode's native `skill` tool, reference it in agent instructions, or list its frontmatter `name` in `autoLoadSkills`. User file skills are discovered through OpenCode's native `.opencode`, `.claude`, `.agents`, `skills.paths`, and `skills.urls` mechanisms.
- **Local model tuning:** set per-agent models or variants in `~/.config/opencode/agent_hive.json`. Project `.hive/agent-hive.json` is reserved for project-scoped sandbox and repository-manifest settings.

#### Canonical Delegation Threshold

- Delegate to Scout when you cannot name the file path upfront, expect to inspect 2+ files, or the question is open-ended ("how/where does X work?").
- Local `read`/`grep`/`glob` is acceptable only for a single known file and a bounded question.

## Tools

### Feature Management
| Tool | Description |
|------|-------------|
| `hive_feature_create` | Create a new feature |
| `hive_feature_complete` | Mark feature as complete |

### Planning
| Tool | Description |
|------|-------------|
| `hive_plan_write` | Write plan.md |
| `hive_plan_read` | Read plan and comments |
| `hive_plan_approve` | Approve plan for execution |

### Tasks
| Tool | Description |
|------|-------------|
| `hive_tasks_sync` | Generate tasks from plan, or rewrite pending plan tasks with `refreshPending: true` after a plan amendment |
| `hive_task_create` | Create a manual task with explicit `dependsOn` and optional structured metadata |
| `hive_task_update` | Update task status/summary |

### Worktree
| Tool | Description |
|------|-------------|
| `hive_worktree_start` | Start normal work on task (creates worktree) |
| `hive_worktree_create` | Resume blocked task in existing worktree |
| `hive_worktree_commit` | Complete task (applies changes) |
| `hive_worktree_discard` | Abort task (discard changes) |

In gate-open sessions, `hive_worktree_start` may return a `backgroundTaskCall` for independent work. That output is launch guidance only; Hive does not create pending background board state until the parent actually starts the native background task. Use the normal blocking call when the next meaningful step depends on the worker result.

### Merge and Status

| Tool | Description |
|------|-------------|
| `hive_merge` | Merge a completed task branch, with merge/squash/rebase strategies, optional conflict preservation, and optional cleanup |
| `hive_status` | Inspect feature state, including task/worktree-aware merge eligibility through `helperStatus.mergeEligibility` |

When a task branch has no net tracked changes to integrate, `hive_merge` reports a successful no-op: `success: true`, `merged: false`, `reasonCode: 'NO_TRACKED_CHANGES'`, and no empty `sha`. Requested cleanup can still run when safe. Use `hive_status`, not the background board, to decide whether a task has completed work and a live worktree eligible for merge or cleanup.

### Ad-hoc Worktree

Hive Builder uses `hive_adhoc_*` tools for isolated non-feature work under `.hive/.worktrees/adhoc/<runId>`. These runs do not create feature/task records and do not appear in `hive_status`. With the background gate closed, Hive Builder remains a direct ad-hoc executor. `hive_adhoc_worktree_create` accepts `autoSpawnWorker`, default `true`; set it to `false` only for inspection, routing, or setup-only worktrees where no worker should auto-launch. See `docs/HIVE-TOOLS.md` for the full tool contracts.

### Background Orchestration

With the env gate unset (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`), Hive keeps the current direct/blocking task and worktree workflow. Background board tools report `background_tools_disabled`, and no background appendix is injected into primary prompts.

With the env gate set, primary orchestrators receive delegate-first background scheduling guidance and the board tools are active. This is the background-first scheduler contract under the experimental gate, not always-on behavior. It does not add agents or change custom-agent preservation: primary agents still choose built-in or configured custom specialists by descriptor, not by a fixed routing table.

Gate-open orchestration uses lane kind to decide how much management is needed. Exploratory/read-only and review lanes are lightweight background candidates. Writing/change and execution lanes require path ownership, state tracking, verification routing, unresolved-lane checks, integration control, and a context packet. See `docs/HIVE-TOOLS.md` and the `background-delegation` skill for the full scheduler protocol.

With the env gate set, primary agents can launch independent native background tasks when useful foreground work can continue, inspect the scoped board with `hive_background_status`, wait for OpenCode's native completion notification, refresh `hive_background_status`, reconcile terminal jobs with `hive_background_reconcile` or `hive_background_reconcile_batch`, and request cancellation with `hive_background_cancel`. Reconciliation archives terminal jobs and hides them from normal status output; agents should not edit `.hive/background-jobs.json` directly. Wait-only scheduler guidance from status means wait for the native notification instead of refreshing repeatedly.

`hive_background_status` and reconcile responses may return `recommendedNextAction` and `requiresHiveStatusRefresh`. These are board-local scheduler outputs. They do not predict merge readiness; refresh `hive_status` before dependent task or merge decisions.

Prompt acknowledgment only means Hive showed a terminal result to the parent session. It does not clear `terminalUnreconciled`; the primary agent still reconciles or ignores the job after consuming the result.

Cancellation is not rollback. A cancellation request does not revert files, branches, worktrees, commits, or reports. If a stale lane cannot be resumed safely, use no-resume retry/escalation: start a fresh scoped attempt when safe, ignore the stale terminal entry with a reason, or escalate the blocker.

### Troubleshooting

#### Repeated blocked-resume errors / loop

If you see repeated retries around `continueFrom: "blocked"`, use this protocol:

1. Call `hive_status()` first.
2. If status is `pending` or `in_progress`, start normally with:
   - `hive_worktree_start({ feature, task })`
3. Only use blocked resume when status is exactly `blocked`:
   - `hive_worktree_create({ task, continueFrom: "blocked", decision })`

Do not retry the same blocked-resume call on non-blocked statuses; re-check `hive_status()` and use `hive_worktree_start` for normal starts.

#### Using with DCP plugin

When using Dynamic Context Pruning (DCP), use a Hive-safe config in `~/.config/opencode/dcp.jsonc`:

- `manualMode.enabled: true`
- `manualMode.automaticStrategies: false`
- `turnProtection.enabled: true` with `turnProtection.turns: 12`
- `tools.settings.nudgeEnabled: false`
- protect key tools in `tools.settings.protectedTools` (at least: `hive_status`, `hive_worktree_start`, `hive_worktree_create`, `hive_worktree_commit`, `hive_worktree_discard`, `question`)
- disable aggressive auto strategies:
  - `strategies.deduplication.enabled: false`
  - `strategies.supersedeWrites.enabled: false`
  - `strategies.purgeErrors.enabled: false`

For normal usage, set the OpenCode plugin entry to `"oc-arkive@latest"`. Keep a local file path entry only for contributor testing with a checkout.

### Task worker recovery

After session compaction, task workers re-read `worker-prompt.md` and continue from the current worktree state. Primary and subagent sessions replay the stored user directive once, then escalate if needed.

Manual tasks created with `hive_task_create()` follow the same DAG model as plan-backed tasks. The `goal`, `description`, `acceptanceCriteria`, `files`, and `references` fields are turned into `spec.md` content visible to the worker. To change downstream sequencing or scope after review feedback, update `plan.md` and run `hive_tasks_sync({ refreshPending: true })`.

`hive-helper` is a runtime-only bounded assistant for merge recovery, state clarification, interrupted-state wrap-up, and safe manual-follow-up assistance. It stays within the current approved DAG boundary and does not appear in `.github/agents/`.

`simplicity-reviewer` is a built-in read-only reviewer for final post-implementation cleanup. It reviews completed diffs for YAGNI, dead code, duplication, unnecessary abstractions, redundant defensive code, and safe deletion-biased simplification. It is not a custom-agent base; use it directly when a simplicity pass is needed.

## Prompt Budgeting & Observability

Hive automatically bounds worker prompt sizes to prevent context overflow and tool output truncation.

### Budgeting Defaults

| Limit | Default | Description |
|-------|---------|-------------|
| `maxTasks` | 10 | Number of previous tasks included |
| `maxSummaryChars` | 2,000 | Max chars per task summary |
| `maxContextChars` | 20,000 | Max chars per context file |
| `maxTotalContextChars` | 60,000 | Total context budget |

When limits are exceeded, content is truncated with `...[truncated]` markers and file path hints are provided so workers can read the full content.

### Observability

`hive_worktree_start` and blocked-resume `hive_worktree_create` output include metadata fields:

- **`promptMeta`**: Character counts for plan, context, previousTasks, spec, workerPrompt
- **`payloadMeta`**: JSON payload size, whether prompt is inlined or referenced by file
- **`budgetApplied`**: Budget limits, tasks included/dropped, path hints for dropped content
- **`warnings`**: Array of threshold exceedances with severity levels (info/warning/critical)

### Prompt Files

Large prompts are written to `.hive/features/<feature>/tasks/<task>/worker-prompt.md` and passed by file reference (`workerPromptPath`) rather than inlined in tool output. This prevents truncation of large prompts.

That same `worker-prompt.md` path is also reused during compaction recovery so task workers can re-anchor to the exact task assignment after a compacted session resumes.

## Plan Format

```markdown
# Feature Name

## Overview
What we're building and why.

## Tasks

### 1. Task Name
Description of what to do.

### 2. Another Task
Description.

## Final Verification

- Run the full test suite after task branches are merged.
```

`hive_tasks_sync` reads numbered task headings from `## Tasks` in modern plans. A final verification section stays outside the task DAG unless the verification itself needs tracked artifacts produced by a task.

## Configuration

Hive reads user/session policy from `~/.config/opencode/agent_hive.json`, then overlays project-scoped fields from the first project config file that exists:

1. `<project>/.hive/agent-hive.json` (preferred project overlay)
2. `<project>/.opencode/agent_hive.json` (legacy fallback, used only when the new file is missing)
3. defaults for anything not set globally or by the project overlay

Project config only affects `sandbox`, `dockerImage`, `persistentContainers`, and `repositories`. Agent models, variants, routing, custom agents, council groups, disabled MCPs, disabled skills, and hook cadence are global user settings. If `.hive/agent-hive.json` exists but is invalid JSON or an invalid shape, Hive warns, skips the legacy project file, and uses the global config and defaults.

### Council config

Council settings are global-only and live in `~/.config/opencode/agent_hive.json`. Structurally valid project-local `council` values are ignored during runtime merge. Malformed project-local `council` values still make the project config invalid before they can be ignored, so the normal invalid-project fallback applies: Hive warns and uses global config/defaults.

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

### Project-local config example

Create `.hive/agent-hive.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "sandbox": "docker",
  "repositories": [
    { "id": "api", "path": "./api" }
  ]
}
```

### Global-only: Disable Skills or MCPs

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "disableSkills": ["brainstorming", "writing-plans"],
  "disableMcps": ["websearch", "ast_grep"]
}
```

#### Available Skills

| ID | Description |
|----|-------------|
| `brainstorming` | Use before any creative work. Explores user intent, requirements, and design through collaborative dialogue before implementation. |
| `writing-plans` | Use when you have a spec or requirements for a multi-step task. Creates detailed implementation plans with bite-sized tasks. |
| `executing-plans` | Use when you have a written implementation plan. Executes tasks in batches with review checkpoints. |
| `dispatching-parallel-agents` | Use when facing 2+ independent tasks. Dispatches multiple agents to work concurrently on unrelated problems. |
| `test-driven-development` | Use when implementing any feature or bugfix. Enforces write-test-first, red-green-refactor cycle. |
| `systematic-debugging` | Use when encountering any bug or test failure. Requires root cause investigation before proposing fixes. |
| `code-reviewer` | Deprecated compatibility wrapper. Use the `code-reviewer` subagent for implementation review. |
| `verification` | Use before claiming work is complete or when independently checking an implementation against a plan. Requires fresh command output before success claims. |
| `background-delegation` | Use when opencode background subagents are available (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`). Defines the env-gated delegate-first scheduler protocol, including board status, reconciliation, and cancellation. Not loaded as a default `autoLoadSkills` entry; the env flag appends an on-demand reference only. |

#### Available MCPs

| ID | Description | Requirements |
|----|-------------|--------------|
| `websearch` | Web search via [Exa AI](https://exa.ai). Real-time web searches and content scraping. | Set `EXA_API_KEY` env var |
| `context7` | Library documentation lookup via [Context7](https://context7.com). Query up-to-date docs for any programming library. | None |
| `grep_app` | GitHub code search via [grep.app](https://grep.app). Find real-world code examples from public repositories. | None |
| `ast_grep` | AST-aware code search and replace via [ast-grep](https://ast-grep.github.io). Pattern matching across 25+ languages. | None (runs via npx) |

### Per-Agent Skills

Skills are loaded through OpenCode's native `skill` tool, not through a Hive plugin tool. Hive bundles are materialized into `.hive/generated/opencode-skills/<hash>/` at startup and registered via `opencodeConfig.skills.paths` ahead of any user-configured paths.

**Configuration fields:**

| Field | Behavior |
|-------|----------|
| `skills` | Legacy field kept for config compatibility. Native skill visibility is controlled by OpenCode registration and `disableSkills`, not by per-agent allowlists. |
| `autoLoadSkills` | Adds high-priority prompt guidance telling the agent to load named OpenCode-native skills with the `skill` tool before work covered by them. |
| `disableSkills` (global) | Disables Hive bundled materialization and Hive bundled autoload only. User or native skills with the same name are not blocked. |

**User file skills** should be configured through OpenCode's native `.opencode`, `.claude`, `.agents`, `skills.paths`, or `skills.urls` discovery. They can be loaded manually with the native `skill` tool or advertised to an agent by adding the skill's frontmatter `name` to `autoLoadSkills`. Native/user skills take precedence over Hive bundled skills with the same name.

**URL-scan conservative behavior:** If configured `skills.urls` cannot be scanned for conflicts (invalid response, network error), Hive skips bundled skill materialization and Hive bundled autoload guidance for that run and logs a warning rather than risking a native conflict. Local native skills discovered before the URL failure can still be advertised in guidance; partially scanned URL skills are not advertised.

`background-delegation` is bundled and materialized like other Hive skills, but primary prompt references are env-gated and compact. When the env flag is set, primary agent prompts include the delegate-first scheduler contract and point to the skill for the full protocol instead of treating background delegation as appendix-only text. The skill can still be loaded manually with OpenCode's native `skill` tool like any other bundled or user skill.

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
- User `autoLoadSkills` are **merged** with defaults (use global `disableSkills` to remove defaults from autoload)

**Default auto-load skills by agent:**

| Agent | autoLoadSkills default |
|-------|------------------------|
| `hive-master` | `parallel-exploration` |
| `forager-worker` | `test-driven-development`, `verification` |
| `hive-builder` | `verification` |
| `hive-helper` | (none) |
| `scout-researcher` | (none) |
| `architect-planner` | `parallel-exploration` |
| `swarm-orchestrator` | (none) |
| `plan-reviewer` | (none) |
| `code-reviewer` | (none) |
| `approach-advisor` | (none) |

`background-delegation` is not a default `autoLoadSkills` entry for any agent. For Hive Builder, background-first delegation and the Builder-specific specialist-default rail are advertised by env-gated compact scheduler guidance only. The env flag (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`) appends the on-demand guidance to primary agent prompts without adding it to the default autoload set.

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

- `baseAgent`: one of `scout-researcher`, `forager-worker`, `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, or `approach-advisor`
- `description`: delegation guidance injected into primary planner/orchestrator prompts

Custom subagents are scoped routing specialists, not model-upgrade switches. Primary agents choose them when their description matches the task's domain, workflow, artifact type, or review/approach risk lens, or when the operator explicitly names them. They keep the built-in base agent when no configured description is a closer fit. A stronger model alone is not a routing reason.

`hive-helper` is not a custom base agent. In v1 it stays runtime-only for isolated merge recovery and does not appear in `.github/agents/`.

`simplicity-reviewer` is a custom base agent for specialized cleanup passes. Primary agents still use the built-in `simplicity-reviewer` when no configured simplicity-reviewer-derived custom description is a closer match.

`hive-helper` is also not a network consumer; planning, orchestration, and review roles get network access first.

Published example (validated by `src/e2e/custom-agent-docs-example.test.ts`):

```json
{
  "agents": {
    "scout-researcher": {
      "variant": "low"
    },
    "forager-worker": {
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
- plugin-reserved aliases are blocked (`hive`, `architect`, `swarm`, `scout`, `forager`, `hygienic`, `hygienic-reviewer`, `receiver`)
- operational IDs are blocked (`build`, `plan`, `code`)

Compaction classification follows the base agent:

- `scout-researcher` derivatives are treated as `subagent`
- `forager-worker` derivatives are treated as `task-worker`
- `plan-reviewer`, `code-reviewer`, and `approach-advisor` derivatives are treated as `subagent`

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

## Pair with VS Code

For the full OpenCode-first workflow, install `vscode-arkive.vsix` from the GitHub Release as an optional review/sidebar companion for inline comments and document review.

## License

MIT with Commons Clause — Free for personal and non-commercial use. See [LICENSE](../../LICENSE) for details.

---
