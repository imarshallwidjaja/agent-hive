# Upstream provenance: systematic-debugging

## Retained superpowers text

- **Source repository**: `https://github.com/obra/superpowers`
- **Source file**: `skills/systematic-debugging/SKILL.md`
- **Author**: Jesse Vincent
- **License**: MIT, Copyright (c) 2025 Jesse Vincent. `LICENSE.superpowers` is the upstream `LICENSE` file, byte for byte, from the same revision.
- **Source revision**: `030a222af19c1f3a93c6eb876a7422d8e4fc0162` (2025-12-18). The first copy in this repository (commit `a39afba2`, 2026-01-24) did not record a revision. This one was identified by comparing content: that copy differs from the upstream file at this revision only in three lines that name other skills, where `superpowers:` prefixes became `hive_skill:`. The next upstream change to the file landed on 2026-06-16, after the import.

Passages that remain identical to that upstream revision include the Overview, Iron Law, When to Use, the four phase headings with the steps of Phases 1 to 3, Red Flags, the human-partner signals, Common Rationalizations, Quick Reference, and the "No Root Cause" section.

Hive adapted these passages:

- Phase 1 step 5, "Trace Data Flow", became "Downstream Symptoms and Hidden Writes".
- Phase 4 step 1 changed from a mandatory failing test to selecting a testing and verification strategy, which added a preparatory-refactoring step and renumbered the steps after it.
- The three-failed-fixes escalation became the shared-premise reassessment, with matching changes to Red Flags, Common Rationalizations, Quick Reference, and the "No Root Cause" closing line.
- Supporting Techniques lists Hive guidance instead of upstream's sibling documents. `root-cause-tracing.md`, `defense-in-depth.md`, and `condition-based-waiting.md` are not part of this skill.
- The "Violating the letter..." line and the Real-World Impact section were removed. Skill references use Hive's names and host-specific skill calls.

# Selective pstack material

Shared-premise, restart-state, and hypothesis-reversal guidance draws on Lauren Tan's `principle-attack-the-premise`, `principle-fix-root-causes`, and diagnostic passages of `poteto-mode/playbooks/bug-fix.md` and `perf-issue.md` in pstack 0.15.5, `cursor/plugins` revision `fae2c6ed95821bd85f614a73e4842e13229fa5e5`. Source: https://github.com/cursor/plugins/tree/fae2c6ed95821bd85f614a73e4842e13229fa5e5/pstack/skills . `LICENSE.pstack` covers those passages. This does not import poteto-mode, its playbook workflow, automatic PRs, or autonomy policy. Tests of state hypotheses use isolated copies; retained-state recovery remains governed by Hive.
