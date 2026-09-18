---
name: complexity-review
description: Use when the operator explicitly asks for a one-shot complexity review of an explicit diff or bounded named scope, or current staged, unstaged, and relevant nonignored untracked changes
---

# Complexity Review

Run one read-only complexity pass in the same agent that received the request. Do not call `task`, delegate, fan out, or switch agents. Do not edit files, run builds, tests, formatters, or generators, write state, or create tracked artifacts.

## Scope

Use an explicit diff or bounded named scope from the request or current context. Otherwise, inspect current staged, unstaged, and relevant nonignored untracked changes. If the review has no relevant material, report that and stop; never widen it into an audit.

Inventory and inspect relevant first-party source, tests, configuration, and manifests. Exclude generated files, vendor code, dependencies, caches, build output, and VCS data unless the request explicitly includes them. Report the inspected scope and meaningful limitations; do not claim exhaustive coverage.

## Finding Bar

Review complexity only. Do not assess correctness, security, or performance as review topics. Retain meaningful contracts, boundary validation, and tests. A single caller is not enough to establish unnecessary complexity. A proposed simplification must have a safe equivalence rationale; when that cannot be shown, do not report it.

Each finding is concise and names:

- location
- unnecessary burden and what to remove or replace
- a concrete simpler alternative
- why the alternative is safe

Optional tags may identify duplication, indirection, speculative machinery, or dead code. Do not guess line, dependency, or savings totals, and do not make Ship or readiness claims.

If there are no findings, report the inspected scope and meaningful limitations before ending with exactly: `No evidence-backed complexity findings in the inspected scope.`
