---
name: complexity-audit
description: Use when the operator explicitly asks for a one-shot complexity audit of named roots or codebases
---

# Complexity Audit

Run one read-only complexity pass in the same agent that received the request. Do not call `task`, delegate, fan out, or switch agents. Do not edit files, run builds, tests, formatters, or generators, write state, or create tracked artifacts.

## Scope

Use the explicit roots or set of codebases named in the request or current context. If none is supplied, use the current worktree. Do not substitute the canonical checkout or the skill installation directory. Inventory and inspect relevant first-party source, tests, configuration, and manifests. Exclude generated files, vendor code, dependencies, caches, build output, and VCS data unless the request explicitly includes them.

Report the inspected roots, meaningful limitations, and the boundaries used. Do not claim exhaustive coverage or silently expand the roots.

## Finding Bar

Review complexity only. Do not assess correctness, security, or performance as review topics. Retain meaningful contracts, boundary validation, and tests. A single caller is not enough to establish unnecessary complexity. A proposed simplification must have a safe equivalence rationale; when that cannot be shown, do not report it.

Each finding is concise and names:

- location
- unnecessary burden and what to remove or replace
- a concrete simpler alternative
- why the alternative is safe

Optional tags may identify duplication, indirection, speculative machinery, or dead code. Do not guess line, dependency, or savings totals, and do not make Ship or readiness claims.

If there are no findings, report the inspected roots and meaningful limitations before ending with exactly: `No evidence-backed complexity findings in the inspected scope.`
