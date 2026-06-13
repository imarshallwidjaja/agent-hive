# Agent Hive

A plan-first development workflow for OpenCode. Features, tasks, and review gates live in `.hive/` alongside your code.

Agent Hive is a workflow layer that sits on top of your AI coding tool. It imposes just enough structure to make multi-agent, multi-step work traceable and recoverable — without taking ownership of your editor, your model, or your coding style.

This fork publishes the OpenCode runtime as `oc-arkive` and ships the VS Code review companion as a release VSIX named `vscode-arkive`.

[![npm](https://img.shields.io/npm/v/oc-arkive.svg?label=oc-arkive)](https://www.npmjs.com/package/oc-arkive)
[![License: MIT with Commons Clause](https://img.shields.io/badge/License-MIT%20with%20Commons%20Clause-blue.svg)](LICENSE)

---

## Demo

https://github.com/user-attachments/assets/6290b435-1566-46b4-ac98-0420ed321204

---

## Why Hive

Raw agentic coding has a consistent failure mode: agents spray changes across a codebase, sessions lose context, parallel workers collide, and nobody can reconstruct what happened. Hive fixes this with a small, strict loop:

```
You describe the work
    ↓
Hive discovers, asks, builds plan.md
    ↓
You review and approve   ← human gate
    ↓
Workers execute tasks in isolated git worktrees (batched parallel)
    ↓
Results merge. plan/spec/report live in .hive/ forever.
```

| Without Hive | With Hive |
|---|---|
| Agent touches 40 files, half break | Tasks run in isolated worktrees — discard any worker |
| New session starts from zero | Feature state persists in `.hive/features/<name>/` |
| Parallel agents collide, duplicate | Explicit batches with dependency ordering |
| "What happened here?" | plan.md, spec.md, report.md per task |
| Scope creep mid-execution | Human approval gate before any code change |

---

## OpenCode

OpenCode is Hive's supported runtime. It integrates with OpenCode's session, plugin, and compaction systems natively.

### Install

Add the plugin to `opencode.json` — OpenCode handles npm resolution automatically; you do not need to `npm install` yourself.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-arkive@latest"]
}
```

### Optional config — `.hive/agent-hive.json`

Project-scoped config (preferred); falls back to `.opencode/agent_hive.json` or `~/.config/opencode/agent_hive.json`.

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "agentMode": "unified",
  "agents": {
    "hive-master":    { "model": "anthropic/claude-sonnet-4-20250514", "temperature": 0.5 },
    "forager-worker": { "model": "anthropic/claude-sonnet-4-20250514", "temperature": 0.3 }
  }
}
```

### Start

Chat with OpenCode. Ask it to "create a feature for user authentication" and Hive activates automatically.

### What you get

- **Runtime agents** - Unified mode: `hive-master` handles planning + orchestration. Dedicated mode uses `architect-planner` + `swarm-orchestrator`; specialist agents handle research, implementation, review, approach advice, helper recovery, ad-hoc execution, and simplicity review. Background-first orchestration adds no new agents; custom derived agents keep their configured base-agent inheritance.
- **Hive tools** - Full lifecycle: feature, plan, tasks, worktrees, ad-hoc worktrees, background status/reconcile/cancel, context, merge, and status.
- **15 skills** — Loaded via OpenCode's native `skill` tool.
- **Compaction recovery** — OpenCode sessions compact on long runs; Hive stores durable session metadata in `.hive/sessions.json` so agents re-anchor with the correct role after compaction.
- **Optional research MCPs** — Exa web search, Context7 docs, grep.app, ast-grep. Disable individually via `disableMcps`.

See [`packages/opencode-hive/README.md`](packages/opencode-hive/README.md) for per-agent model routing, derived subagents, and DCP safety.

---

## VS Code

The VS Code extension is a **companion**, not a runtime. It shows you the state of `.hive/` that the OpenCode CLI runtime is writing, and lets you review plans and add inline comments without leaving the editor.

### Install

```bash
code --install-extension ./vscode-arkive.vsix
```

Download `vscode-arkive.vsix` from the GitHub Release first.

### What you get

- **Hive sidebar** (activity-bar view) — features tree, per-task status, inline comments on `plan.md` and `overview.md`.
- **Background Jobs and Tracked Repositories views** - viewer-only state for `.hive/background-jobs.json` and `.hive/agent-hive.json`.
- **Plan and overview review** — opens docs from the sidebar, lets you add/resolve inline comments, Done Review button marks the review as complete.
- **Task detail** — open `spec.md` (what the worker was told) and `report.md` (what it did).
- **File watching** — tracks changes to `.hive/` and refreshes the sidebar in real time.

### Typical setup

Run OpenCode in a terminal pane; keep VS Code open for the Hive sidebar. Plan review happens in VS Code; approval and execution happen in the OpenCode CLI. The extension watches `.hive/` and reflects changes in real time.

---

## The Workflow

Every feature runs through the same four phases.

### 1. Discovery + Plan

Hive asks questions, reads the codebase, checks existing patterns, then writes `.hive/features/<name>/plan.md`:

```markdown
# User Authentication

## Overview
Add JWT-based auth with login, signup, protected routes.

## Tasks

### 1. Extract auth logic to service
Move scattered auth code to AuthService.

### 2. Add token refresh mechanism
Implement refresh token rotation.

### 3. Update API routes
Convert all routes to use AuthService.
```

### 2. Human Approval

Nothing executes until you approve in the chat or by calling `hive_plan_approve`. VS Code is for review comments, not approval or execution. The human owns the *what*. The agent owns the *how*.

### 3. Batched Parallel Execution

```
Orchestrator
├── Batch 1 (parallel):
│   ├── Forager A → worktree-a → commit
│   ├── Forager B → worktree-b → commit
│   └── Forager C → worktree-c → commit
│       ↓ merge + full test suite
└── Batch 2 (parallel):
    ├── Forager D (uses A+B+C results)
    └── Forager E
        ↓ merge + full test suite
```

Independent tasks run concurrently. Dependent tasks wait. Each worker runs in its own worktree, verifies its own work, and commits. The orchestrator merges batch-by-batch and runs the full suite after each merge.

When OpenCode's background subagent experiment is enabled with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`, primary agents use background-first scheduler mode for independent work. They launch native background tasks when safe foreground work can continue, inspect the scoped board with `hive_background_status`, wait for OpenCode's native completion notification, refresh `hive_background_status`, reconcile terminal jobs with `hive_background_reconcile` or `hive_background_reconcile_batch`, and request cancellation with `hive_background_cancel`. With the env gate unset, the current blocking task/worktree behavior remains in place. Prompt acknowledgment only means Hive showed a terminal result once; explicit reconciliation still records whether the result was consumed or ignored.

### 4. Audit Trail

```
.hive/features/01_user-auth/
├── plan.md              # the approved contract
├── tasks.json           # task state
├── context/
│   └── overview.md      # human-facing branch summary
└── tasks/
    ├── 01-extract-auth-logic/
    │   ├── spec.md      # what the worker was told
    │   └── report.md    # what it did
    └── 02-add-token-refresh/
        ├── spec.md
        └── report.md
```

---

## Philosophy

Hive is built on nine principles. They explain why the workflow is shaped the way it is.

**P1 — Context Persists.** `.hive/features/` is durable memory. Plan, tasks, context, reports survive session end, compaction, and restarts.

**P2 — Plan → Approve → Execute.** No code changes before a human approves the plan. Trust is established, not assumed.

**P3 — Human Shapes, Agent Builds.** The human owns *what* and *why*. The agent owns *how*. Scope is fixed at approval.

**P4 — Good Enough Wins.** Workers do best-effort verification at task level; the full suite runs at batch level. No perfectionism spirals.

**P5 — Batched Parallelism.** Independent tasks run in parallel inside a batch. Batches run sequentially so context flows forward.

**P6 — Tests Define Done.** A batch is done when the suite passes, not when a worker says so.

**P7 — Iron Laws + Hard Gates.** Constraints are enforced by tools, not by prompts. A plan without `## Tasks` does not pass; a worker that commits incomplete work gets rejected.

**P8 — Cross-Model Prompts.** Agent instructions work across model families. The workflow design does not depend on any one model's quirks.

**P9 — Deterministic Contracts Beat Soft Memory.** What a version ships is defined by the checked-in artifacts all agreeing on a version. What a feature did is defined by `plan.md`, `spec.md`, `report.md` — not by what anyone remembers.

See [PHILOSOPHY.md](PHILOSOPHY.md) for the full evolution log.

---

## Skills

| Skill | When the orchestrator loads it |
|---|---|
| `writing-plans` | Creating or revising a feature plan |
| `executing-plans` | Running a batch execution pass |
| `dispatching-parallel-agents` | Spawning multiple concurrent workers |
| `parallel-exploration` | Multi-domain research |
| `systematic-debugging` | Diagnosing a failing test or regression |
| `test-driven-development` | Implementing new behaviour with tests |
| `verification` | Checking work before declaring done |
| `code-reviewer` | Deprecated compatibility wrapper; use the `code-reviewer` subagent for implementation review |
| `brainstorming` | Exploring options before committing |
| `docker-mastery` | Docker / docker-compose / container debugging |
| `agents-md-mastery` | Reviewing agent instruction files |

---

## Troubleshooting

**Worker appears stuck.** Call `hive_status({ feature })` first. Use `continueFrom: 'blocked'` only when status confirms `blocked` — not `pending` or `in_progress`.

**Session resumed without context.** Compaction recovery should re-inject. If not, call `hive_status` explicitly.

**OpenCode with DCP.** Protect Hive tools from pruning:

```jsonc
{
  "tools": {
    "settings": {
      "protectedTools": ["hive_status", "hive_worktree_start", "hive_worktree_create", "hive_worktree_commit", "hive_worktree_discard", "question"]
    }
  }
}
```

---

## Packages

| Package | Registry | Description |
|---|---|---|
| [`oc-arkive`](https://www.npmjs.com/package/oc-arkive) | npm | OpenCode plugin — full Hive runtime, tools, agents, skills, and background board support |
| `vscode-arkive` | GitHub Release VSIX | Sidebar, plan review, file watcher |

---

## License

MIT with Commons Clause — free for personal and non-commercial use. See [LICENSE](LICENSE).

---
