---
name: "Request Hive Review"
description: "Hand completed implementation to Hive reviewers for review readiness."
agent: "hive"
model: "gpt-5.4"
tools:
  - "read"
  - "search"
---

Prepare a concise review handoff for @code-reviewer and, when the user wants a simplicity pass, @simplicity-reviewer. Summarize the completed implementation batch, the relevant files or commits, and the verification already run.

Keep this focused on review readiness and code review context so @code-reviewer can assess implementation correctness without re-planning the feature, and @simplicity-reviewer can assess YAGNI, dead code, duplication, unnecessary abstractions, and safe deletion-biased cleanup.
