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

### Planning-mode delegation

During planning, "don't execute" means "don't implement" (no code edits, no worktrees). Read-only exploration is explicitly allowed and encouraged, both via local tools and by delegating to Scout.

When delegation is warranted, synthesize the task before handing it off: name the file paths or search target, state the expected result, and say what done looks like. Workers do not inherit planner context.

For execution work, treat worker output as evidence to inspect, not proof to trust blindly. OpenCode is the supported execution runtime; if you use `vscode-arkive`, treat it as a review/sidebar companion. Read changed files yourself and run the shared verification commands on the main branch before claiming the batch is complete.

### Local skill and model use cases

- **Local skill experiments:** keep a skill in `<project>/.opencode/skills/<id>/SKILL.md` or `<project>/.claude/skills/<id>/SKILL.md`, then load it with OpenCode's native `skill` tool, reference it in agent instructions, or list its frontmatter `name` in `autoLoadSkills`. User file skills are discovered through OpenCode's native `.opencode`, `.claude`, `.agents`, `skills.paths`, and `skills.urls` mechanisms.
- **Local model tuning:** set per-agent models or variants in `<project>/.hive/agent-hive.json` when you want a repository-specific routing setup without changing your global OpenCode defaults.

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

### Ad-hoc Worktree

Hive Builder uses `hive_adhoc_*` tools for isolated executor work under `.hive/.worktrees/adhoc/<runId>`. These runs do not create feature/task records and do not appear in `hive_status`. See `docs/HIVE-TOOLS.md` for the tool contracts.

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
```

## Configuration

Hive reads config from these locations, in order:

1. `<project>/.hive/agent-hive.json` (preferred)
2. `<project>/.opencode/agent_hive.json` (legacy fallback, used only when the new file is missing)
3. `~/.config/opencode/agent_hive.json` (global fallback)

If `.hive/agent-hive.json` exists but is invalid JSON or an invalid shape, Hive warns, skips the legacy project file, and falls back to the global config and defaults.

You can customize agent models, variants, disable skills, and disable MCP servers.

### Project-local config example

Create `.hive/agent-hive.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "agentMode": "unified",
  "disableSkills": []
}
```

### Disable Skills or MCPs

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
| `background-delegation` | Use when opencode background subagents are available (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`). Enables primary agents to dispatch independent work with `task({ background: true, ... })` and `task_status`. Not loaded as a default `autoLoadSkills` entry; the env flag appends an on-demand reference only. |

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
| `autoLoadSkills` | Injects OpenCode-discovered native skill bodies or eligible Hive bundled skill bodies into the agent's system prompt at session start. |
| `disableSkills` (global) | Disables Hive bundled materialization and Hive bundled autoload only. User or native skills with the same name are not blocked. |

**User file skills** should be configured through OpenCode's native `.opencode`, `.claude`, `.agents`, `skills.paths`, or `skills.urls` discovery. They can be loaded with the native `skill` tool or injected at startup by adding the skill's frontmatter `name` to `autoLoadSkills`. Native/user skills take precedence over Hive bundled skills with the same name.

**URL-scan conservative behavior:** If configured `skills.urls` cannot be scanned for conflicts (invalid response, network error), Hive skips bundled skill materialization and Hive bundled autoload for that run and logs a warning rather than risking a native conflict. Local native skills discovered before the URL failure can still be injected; partially scanned URL skills are not injected.

`background-delegation` is bundled and materialized like other Hive skills, but primary prompt references are env-gated and compact. When the env flag is set, primary agent prompts include a short on-demand reference rather than the full skill body. The skill can still be loaded manually with OpenCode's native `skill` tool like any other bundled or user skill.

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
- `autoLoadSkills` injects OpenCode-discovered native skill bodies or eligible Hive bundled skill bodies into the agent's system prompt at session start - no manual loading needed
- These are **independent**: a skill's body can be auto-loaded even if it is not in the agent's `skills` list
- User `autoLoadSkills` are **merged** with defaults (use global `disableSkills` to remove defaults from autoload)

**Default auto-load skills by agent:**

| Agent | autoLoadSkills default |
|-------|------------------------|
| `hive-master` | `parallel-exploration` |
| `forager-worker` | `test-driven-development`, `verification` |
| `hive-builder` | `verification`, `dispatching-parallel-agents`, `parallel-exploration` |
| `hive-helper` | (none) |
| `scout-researcher` | (none) |
| `architect-planner` | `parallel-exploration` |
| `swarm-orchestrator` | (none) |
| `plan-reviewer` | (none) |
| `code-reviewer` | (none) |
| `approach-advisor` | (none) |

`background-delegation` is not a default `autoLoadSkills` entry for any agent. For Hive Builder, it is advertised by env-gated compact appendix only — the env flag (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`) appends an on-demand reference to primary agent prompts without adding it to the default autoload set.

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

- `baseAgent`: one of `scout-researcher`, `forager-worker`, `plan-reviewer`, `code-reviewer`, or `approach-advisor`
- `description`: delegation guidance injected into primary planner/orchestrator prompts

Custom subagents are exception routes, not capability upgrades. Primary agents default to the built-in base agent unless a custom agent description matches a concrete named condition, or the operator explicitly names the custom agent to use. If no custom route clearly matches, the base agent remains the safe default.

`hive-helper` is not a custom base agent. In v1 it stays runtime-only for isolated merge recovery and does not appear in `.github/agents/`.

`simplicity-reviewer` is also not a custom base agent. It is a built-in direct reviewer for final post-implementation cleanup, so operators can invoke it without defining a custom OpenCode agent.

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
      "description": "Use for documentation-heavy research tasks."
    },
    "forager-ui": {
      "baseAgent": "forager-worker",
      "description": "Use for UI-heavy implementation tasks.",
      "model": "anthropic/claude-sonnet-4-20250514",
      "temperature": 0.2,
      "variant": "high"
    },
    "reviewer-security": {
      "baseAgent": "code-reviewer",
      "description": "Use for security-focused review passes."
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
| `autoLoadSkills` | Merges with base agent auto-load defaults/overrides and de-duplicates. `disableSkills` only suppresses Hive bundled content, not native/user skills with the same name. |

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
