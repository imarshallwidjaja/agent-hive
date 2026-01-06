# Agent Hive 🐝

**From Vibe Coding to Hive Coding** — Organize the chaos into structured execution.

[![License: MIT with Commons Clause](https://img.shields.io/badge/License-MIT%20with%20Commons%20Clause-blue.svg)](LICENSE)

---

## The Problem

AI coding assistants are powerful, but without structure you get:
- 🌀 Lost context between sessions
- 🔄 No record of decisions made
- 📝 Zero audit trail
- 🎯 Scope creep and forgotten requirements

**Traditional solutions** like Spec Kit require you to write detailed specifications upfront. That works for some teams, but most developers just want to code — not write documentation before they start.

---

## The Hive Difference

| Spec Kit Approach | Hive Approach |
|-------------------|---------------|
| Write all specs before coding | Specs emerge as you go |
| Heavy documentation upfront | Passive documentation along the way |
| Separate planning phase | Planning happens in conversation |
| Manual process tracking | Automatic audit of all actions |
| Requires discipline to maintain | Works with how you already code |

**Hive doesn't change how you work. It just makes what you do traceable.**

---

## How It Works

```
You: "Let's add dark mode to the app"
Agent: Plans the feature, Hive automatically captures it
You: Review, chat, refine
Agent: Executes tasks, Hive tracks every step
You: Ship with full audit trail
```

### The Magic: Automatic Capture

When you work with your AI agent, Hive automatically:
- 📋 **Captures plans** as they're discussed
- 💬 **Records decisions** from your conversation
- 🔄 **Tracks execution** of each task
- 📊 **Builds documentation** as a side effect

**You don't write specs. Specs write themselves.**

---

## Two Ways to Use Hive

### 1. Automatic Mode (Recommended)
Just work normally. Hive kicks in when it detects planning.

```
You: "I need to refactor the auth system"
Agent: [Plans automatically captured by Hive]
       Here's my plan:
       1. Extract auth logic to service
       2. Add token refresh
       3. Update API routes
You: "Looks good, let's do it"
Agent: [Executes with full tracking]
```

### 2. Explicit Mode
When you want more control:

```
hive_feature_create("auth-refactor")    # Start a feature
hive_plan_write(plan)                    # Write the plan
hive_plan_approve()                      # Approve it
hive_exec_start("01-extract-service")   # Execute task
hive_exec_complete(task, summary)        # Complete with summary
```

---

## Why Hive?

### 🎯 Easy Orchestrate
Break work into isolated tasks. Each runs in its own git worktree. No conflicts.

### 📊 Easy Audit
Every decision, every change, every conversation — automatically captured.

### 🚀 Easy Ship
When you're done, you have:
- Clean git history
- Full documentation
- Traceable decisions

---

## The Workflow

```
┌─────────────────────────────────────────────────────────────┐
│  PLAN                                                       │
│  Chat with your agent about what to build                   │
│  Hive captures the plan automatically                       │
├─────────────────────────────────────────────────────────────┤
│  REVIEW                                                     │
│  See the plan in VS Code                                    │
│  Add comments, refine, approve                              │
├─────────────────────────────────────────────────────────────┤
│  EXECUTE                                                    │
│  Agent works on tasks in isolated worktrees                 │
│  Every action tracked and auditable                         │
├─────────────────────────────────────────────────────────────┤
│  SHIP                                                       │
│  Clean merges, full history                                 │
│  Documentation generated as side effect                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Packages

| Package | Platform | Description |
|---------|----------|-------------|
| **[opencode-hive](https://www.npmjs.com/package/opencode-hive)** | npm | OpenCode plugin — planning, execution, tracking |
| **[vscode-hive](https://marketplace.visualstudio.com/items?itemName=tctinh.vscode-hive)** | VS Code | Review plans, add comments, approve |

---

## Quick Start

### 1. Install

```bash
# OpenCode plugin
npm install opencode-hive

# VS Code extension
code --install-extension tctinh.vscode-hive
```

### 2. Just Start Coding

```
You: "Let's build a user dashboard"
Agent: [Hive automatically activates]
       I'll create a plan for the user dashboard...
```

Or be explicit:

```
You: "Hive a plan for user dashboard"
You: "Hive execute dashboard-feature"
```

---

## Built for the OpenCode Ecosystem

Designed to work seamlessly with:
- **[OpenCode](https://opencode.ai)** — The AI coding CLI
- **VS Code** — Your editor for reviews
- **Git** — Worktrees for isolation

Inspired by the workflow principles of **[Antigravity](https://antigravity.dev)**.

---

## Comparison

| Feature | Vibe Coding | Spec Kit | Agent Hive |
|---------|-------------|----------|------------|
| Setup required | None | Heavy | Minimal |
| Documentation | None | Upfront | Automatic |
| Planning | Ad-hoc | Required first | Conversational |
| Tracking | None | Manual | Automatic |
| Audit trail | None | If maintained | Built-in |
| Learning curve | None | Steep | Low |

---

## License

MIT with Commons Clause — Free for personal and non-commercial use. See [LICENSE](LICENSE) for details.

---

<p align="center">
  <strong>Stop vibing. Start hiving.</strong> 🐝
  <br><br>
  <em>Specs along the way. Not in the way.</em>
</p>
