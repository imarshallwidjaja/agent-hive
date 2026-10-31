# Suite audit

Audit the named roots or natural-language scope; when none is named, use the current repository. Inspect its applicable instructions, test entry points, and product boundaries. State the scope, candidate identity, and any sampling before drawing conclusions. Read-only inspection can still have effects: do not install dependencies, update snapshots, run the candidate, or start a mutation/benchmark campaign without the required authorization.

Map the inspected tests to their requirement/invariant, exercised subject and path, independent oracle, plausible detected fault, and owning layer (unit, integration, or end-to-end). Use the common lens in SKILL.md. Follow relevant source and callers to establish whether product behavior is actually exercised. Search adjacent suites before declaring a gap or duplicate. A large suite may need sampling; name the sampled areas and leave uninspected areas explicit.

Look for important outcomes without meaningful proof and for tests repeating the same invariant and failure mode. Test count and coverage percentage alone are not quality verdicts. Different layer-specific failure modes justify similar assertions. Inspect setup, mocks, and readbacks before calling an assertion tautological.

For each supported finding, give:

- Test and source anchors, the requirement, and the observed assertion/path.
- The plausible undetected fault and its consequence, or the duplicate's retained canonical owner and why both catch the same fault.
- Unique coverage that must survive, including boundary wiring, error paths, state/effects, and delivery contracts.
- A concrete **keep**, **rewrite**, **fold**, or **remove** recommendation with the evidence that makes it safe.

Report findings first, then the inspected mapping or a concise summary, cleared leads, uninspected areas, and execution/evidence limitations. Do not describe a sample as exhaustive or a passing suite as proof of all outcomes. A missing required skill/reference is an affected audit gap, not an empty clean report.

When the active primary supports independent reviewers, use its existing review/challenge method and code/simplicity roles, keeping each within its permissions and bar. A standalone skill invocation never grants delegation or execution authority. No new durable record is required.

The audit ends with the report. A request to audit, even one asking which tests to remove, does not authorize remediation. An explicit follow-up implementation request may act on accepted findings through the authorized implementation lifecycle with baseline and affected checks.
