---
name: code-design-principles
description: Use when choosing or materially changing state representations, type invariants, API or trust boundaries, shared mutable-state ownership, retry semantics, or an internal API migration. Not for mechanical edits or merely touching typed code.
---

# Code design principles

Deepen the shared Engineering Judgment guidance at a material design choice. This skill supplies recognition tests and construction patterns within the role's existing scope, authority, and output contract. It creates no separate planning stage, review verdict, or permission to refactor.

The engineer who maintains the code next is a user too. Start from what callers need to do and what the system must never allow. The caller's usage is written first and the type sketch derived from it.

## Read the branch you need

- Choosing state or module ownership: [Model the domain](references/domain-modeling.md).
- Parsing, validation, typed invariants, or API boundaries: [Boundaries and types](references/boundaries-and-types.md).
- Concurrent writers, retries, partial runs, or internal replacement: [Lifecycle and migration](references/lifecycle-and-migration.md).

Read the applicable reference before applying its tests. Existing project contracts and meaningful boundaries govern the decision. Routine established-pattern work does not need an alternative-design exercise.

Explain the selected shape through its call sites, invariants, and failure consequences in the artifact already requested. A reviewer still needs evidence that a change violates a requirement or creates worthwhile in-scope complexity; a heuristic is a lead, not a finding.

Debugging remains with `systematic-debugging`; completion evidence with `verification`; selected red-green work with `test-driven-development`. Hive placement, session recovery, and merge policy remain with their operational owners. This skill does not authorize clearing retained state, breaking locks, adopting live sessions, or deleting compatibility relied on by external consumers.
