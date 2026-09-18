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
- Unnecessary indirection, abstractions, fallbacks, options, and dependencies
- Compatible local reuse, stdlib, or native facilities
- Cognitive burden, change amplification, and obscured dependencies rather than line count
- Meaningful ownership, safe behavior, contracts, and tests

## Outcome

Each finding is concise: location, what to cut or simplify, a replacement, and why that is safe given the evidence. Note coverage limitations when they matter. Do not claim unsupported numerical savings or readiness.

## Operator request

The following text supplies the requested scope, philosophy, and preferences. If it is empty or the literal placeholder, use the request, conversation, or defaults.

$ARGUMENTS
