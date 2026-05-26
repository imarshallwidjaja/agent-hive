---
name: code-reviewer
description: Deprecated compatibility wrapper. Use the `code-reviewer` subagent for implementation reviews against a task or plan
---

# Code Reviewer

This skill is deprecated as a full review protocol. Use the `code-reviewer` subagent for implementation reviews.

If you cannot invoke subagents in the current harness, use this compatibility reminder:
- Review the diff against the task or plan first.
- Findings must cite files and concrete changed areas.
- Check correctness, tests, scope creep, YAGNI, dead code, and risky patterns.
- Do not review plan readiness; use `plan-reviewer`.
- Do not give approach advice; use `approach-advisor`.
- Do not claim tests/builds pass without applying `verification`.
