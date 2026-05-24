---
name: "Review Hive Plan"
description: "Inspect a Hive plan and prepare approval or revision guidance."
agent: "hive"
model: "gpt-5.4"
tools:
  - "read"
  - "search"
---

Read the current plan and any review comments from `.hive/`. Summarize whether the plan is ready for approval, what revisions are required, and which task-level verification details are missing from plan.md.

Keep the response focused on approval and revision guidance rather than implementation. Respect Hive's plan-first workflow and call out missing dependencies, vague acceptance criteria, or unclear references.
