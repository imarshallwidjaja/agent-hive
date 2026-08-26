---
name: test-driven-development
description: Use when TDD has been selected by the operator, plan, repository policy, or as a useful design technique for behavior examples
---

# Test-Driven Development

## Scope

Use strict red-green-refactor when TDD has been selected by the operator, plan, or repository policy, or when executable examples are the useful design technique for discovering a behavior or API. Loading this skill means that selection has been made; follow the mechanics below rather than silently switching strategies.

TDD is one testing strategy, not a universal completion contract. Follow the active plan and repository policy.

## Red-Green-Refactor

### RED: Describe One Behavior

Write one focused test through the public contract or intended call site. Prefer real behavior over mock interactions. Name the observable outcome and include meaningful boundary or error cases.

### Verify RED

Run the narrow test and confirm:
- it fails rather than errors
- the failure is the expected missing or incorrect behavior
- it would pass only when the intended contract exists

If it passes immediately, determine whether behavior already exists, the assertion is too weak, or a characterization test is the correct strategy.

### GREEN: Implement the Behavior

Make the smallest coherent change that satisfies the example. Do not add speculative variation. Bounded preparatory refactoring may precede the behavior change when it preserves behavior, lowers implementation risk, and stays green under existing coverage.

### Verify GREEN

Run the narrow test, then the owning suite. Confirm the selected behavior passes and no covered public contract regressed.

### REFACTOR: Improve Structure

Improve names, contracts, ownership, duplication, or dependency clarity while tests remain green. Keep refactoring intent distinct from behavior-change intent.

## Test Quality

- Test public contracts and observable behavior so tests survive internal refactoring.
- Use implementation-detail assertions only when that implementation unit owns the contract.
- Prefer one canonical owning suite; avoid duplicate coverage at several layers unless each proves a different failure mode.
- Mock only boundaries that cannot be exercised directly; do not test the mock's script instead of product behavior.
- Do not require one test per function. Coverage follows behavior, risk, and contract ownership.

## Legacy and Refactor Work

For uncertain legacy behavior, first add characterization tests around the behavior that must remain stable, then perform preparatory refactoring under that coverage before changing behavior. For a pure refactor with trustworthy existing public-contract coverage, keep that coverage green; a new failing test is neither possible nor required.

If the plan selected tests alongside or after implementation, do not relabel that work as TDD. Write tests against the requested contract and record the verification actually performed. If no new automated test is justified, run proportionate non-test verification and explain what established confidence.

## Completion Check

- The RED failure was observed and matched the intended missing behavior.
- GREEN passed in the owning suite.
- Refactoring remained green and did not broaden behavior.
- Tests express public contracts rather than incidental structure.
- Final verification matches the plan and repository policy.
