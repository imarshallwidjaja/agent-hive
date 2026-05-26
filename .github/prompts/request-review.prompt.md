---
name: "Request Hive Review"
description: "Hand completed implementation to code-reviewer for review readiness."
agent: "hive"
model: "gpt-5.4"
tools:
  - "read"
  - "search"
---

Prepare a concise code review handoff for @code-reviewer. Summarize the completed implementation batch, the relevant files or commits, and the verification already run.

Keep this focused on review readiness and code review context so @code-reviewer can assess the implementation without re-planning the feature.
