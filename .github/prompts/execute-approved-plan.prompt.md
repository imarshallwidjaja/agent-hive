---
name: "Execute Approved Hive Plan"
description: "Sync tasks from an approved plan and begin execution."
agent: "hive"
model: "gpt-5.4"
tools:
  - "read"
  - "search"
---

Confirm the plan is approved through the supported OpenCode runtime, sync tasks there, then delegate the next runnable task directly to @forager.

Preserve Hive guardrails: follow task dependencies, keep planning and execution separate, and have the worker record progress and completion with hive_task_update rather than worktree or merge flows.

If the work involves browser behavior, web flows, or end-to-end validation, prefer built-in browser tools and Playwright MCP where available instead of inventing extension-only browser helpers.
