# Migration

This reference adds method, not authority. Migration needs an explicit request; the retirement rule and stop conditions are in SKILL.md. Load `test-quality`: its prune method supplies the baseline, classification, single-fault probes and restore, and its executed break defines which failures count.

## Inventory

Group the inventory by requirement and fault, not by file. For each group, name the requirement, the fault the lower-level tests guard, whether a listed allowlist path covers it, and the interface case that does or would cover it. One file often holds several groups; one group often spans files.

## Evidence for each retirement route

- **(a) An interface case fails on the guarded fault.** Introduce that one fault in the product code with the prune method's probe, run the interface cases, and record each failing assertion and why it failed for that fault. The break retires only the lower-level tests that guard that same fault; a test in the group that guards a different fault needs its own break.
- **(b) The branch is unreachable.** Record the search across the whole repository: every entry point, declared or not (other CLIs, webhooks, workers, build scripts, sibling packages), every published or workspace-internal export, and indirect entries such as protocol methods, config- or string-keyed dispatch, reflection, framework or serialization hooks, plugins, and untyped wire, persisted, or runtime input. A branch that a runtime or external fault or a dependency-injection seam reaches is reachable and does not take this route. Remove the branch together with the test and run the affected checks. When the branch's file is outside the migration's writable scope, keep both and report it.

When the evidence for a route is incomplete, the test stays. Report the question that would settle it, such as "does the plugin loader reach `legacyParse` through a configured name?".

## Report

Extend the prune report from `test-quality`:

- One row per retired test or group: anchor, the guarded fault, the route, and its evidence: for (a) the interface case and the failure it showed for that fault; for (b) the reachability search and the removed branch.
- Retained uncertain tests, each with the question that would settle it.
- Interface cases added, each with the requirement values behind its expected output.
