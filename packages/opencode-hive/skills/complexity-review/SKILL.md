---
name: complexity-review
description: Use when the operator explicitly asks for a one-shot complexity review of an explicit diff or bounded named scope, or current staged, unstaged, and relevant nonignored untracked changes
---

# Complexity Review

Report complexity findings. Do not apply fixes. Keep the pass complexity-only.

## Scope

Use the requested diff or bounded named scope. If none is given, review current staged, unstaged, and relevant nonignored untracked changes in the current worktree. Honor the operator's philosophy and scope. If there is no relevant material, say so and stop; do not widen into an audit.

## Consider

- Dead or speculative code
- Unnecessary indirection, abstractions, fallbacks, options, dependencies, and production shims added purely to mock internals (keeping natural seams and scoped hooks needed for deterministic failure-mode proof)
- Better-fitting implementations, judged by fit rather than presence (credit existing code for proven behavior and integration); when code implements a general capability (parsing, scheduling, locking, retries, dates) or accumulates its edge cases, check whether a platform feature or maintained package could take over that responsibility, counting adoption costs, and stop once fit and tradeoffs are clear
- Cognitive burden, change amplification, and obscured dependencies rather than line count, function size, or file count
- Boundaries whose deletion loses nothing (cleaning up dead bindings or redundant checks left at call sites, and reshaping a shared internal helper with its callers when its signature forces glue or flags and every affected caller is in scope), against boundaries whose deletion would push concepts, invariants, ordering, or dependencies onto callers
- Meaningful ownership, safe behavior, existing determinism, contracts, and tests

## Outcome

Each finding is concise: location, what to cut or simplify, a replacement, and why required and pre-existing behavior stays equivalent given the evidence; removing unrequested behavior the reviewed change itself added stays a finding. A test or document records current behavior: a consumer that relies on it stops a finding, while a binding requirement, external constraint, or failure mode that needs the complexity defeats the alternative too. A worthwhile alternative that changes behavior that predates the reviewed change (for a named scope without a diff, current behavior), including behavior a test asserts, a public contract, or external dependencies, or that reaches callers beyond the reviewed scope, is a structural proposal, not a finding, even when a dependent relies on it: report it separately with evidence that it covers the responsibility, the delta and known dependents, its main cost, and the evidence still open, marking unverified external facts as open. Structural proposals authorize no change by themselves. Note coverage limitations when they matter. Do not claim unsupported numerical savings or readiness.

## Operator request

The following text supplies the requested scope, philosophy, and preferences. If it is empty or the literal placeholder, use the request, conversation, or defaults.

$ARGUMENTS
