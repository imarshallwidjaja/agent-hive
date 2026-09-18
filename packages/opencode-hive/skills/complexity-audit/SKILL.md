---
name: complexity-audit
description: Use when the operator explicitly asks for a one-shot complexity audit of named roots or codebases
---

# Complexity Audit

Report complexity findings. Do not apply fixes. Keep the pass complexity-only.

## Scope

Use the named roots or codebases. If none is given, audit the current worktree. Honor the operator's philosophy and scope.

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
