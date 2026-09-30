# Lifecycle and migration

## Separate before serializing shared state

Before coordinating two writers, ask whether they need to share one mutable object. Separate state by owner when possible and aggregate at a boundary that can provide the consistency readers need. Separate fields in one JSON file still share a write target.

Treat "we need a lock" as a design smell to check, not the default answer. Eliminate an unnecessary shared write target; retain structural serialization when sharing is a real invariant.

When sharing is real, enforce serialization structurally: lockfiles, sequential phases, exclusive ownership. Instructions and conventions are not concurrency control.

This is a design principle for the system being changed, not permission to alter Hive's lock, session, or worktree protocol. Independent worktrees can still share ports, fixtures, databases, or output paths.

## Make operations idempotent

Design operations so they converge to the correct state regardless of how many times they run or where they start from. Ask:

1. What happens if this runs twice in a row?
2. What happens if the previous run crashed at every possible point?
3. Does re-execution converge to the same end state?

If the answer depends on partial prior state, name the reconciliation responsibility. Preserve evidence and use the system's supported recovery operation. Idempotence does not authorize deleting a lock, clearing user state, adopting a live session, or relaunching a writer whose termination is uncertain. A PID or elapsed time alone does not establish that a distributed actor stopped.

## Migrate callers then delete legacy APIs

When a new internal API is the right design, migrate callers and remove the old API in the same refactor wave instead of preserving compatibility layers merely because internal callers remain.

- Inventory callers, migrate them, and delete the old internal API within the authorized wave.
- Treat temporary adapters as exceptional and time-boxed, not default architecture.
- Update tests to assert the new contract; retire tests protecting only abandoned implementation details.

When this applies:

- No external users depend on backward compatibility.
- The project can absorb coordinated breaking changes.
- The new API is part of a simplification or refactor initiative.

Published APIs, cross-process formats, persisted user data, and existing readable `.hive` records are real compatibility boundaries. Name them before choosing a hard cut. No unrelated caller migration is authorized by finding the same pattern elsewhere; report out-of-scope instances.

Intermediate breakage is acceptable only when it is planned, scoped, and reversible inside an authorized migration phase. Preserve required pre-merge gates, dependent-lane prerequisites, and final acceptance. A target design is not permission to merge an unverified result.
