---
name: project-verification
description: Use when the operator explicitly asks for, or an assignment names, setting up, auditing, or maintaining a project's durable verification capability, such as its verification guide, the AGENTS.md entry that holds or points to it, a verification harness, or a formal check. Ordinary feature or regression tests, routine in-scope fixtures, and temporary diagnostic probes stay ordinary implementation or diagnosis.
---

# Project Verification

## Purpose

A project's verification capability is what lets the next agent, arriving cold in the middle of a change, prove the project's important claims: concise guidance in the repository's applicable `AGENTS.md` or a scoped pointer there to a canonical detailed guide, plus whatever existing or operator-approved checks that guidance orchestrates. This skill creates, audits, and maintains that capability. `verification` owns how any agent selects checks, reads their results, and claims completion; this skill builds the material that `verification` routes to.

Writing a test for the feature you are building, adding a fixture your change needs, or running a throwaway probe while diagnosing is ordinary work under the role's existing guidance, not this skill.

## Authority

This skill grants no tool, edit, commit, or role authority. The role and the assignment set what you may change:

- A read-only role reports findings and a proposed guide, pointer, or harness for the primary to authorize.
- A verify-only assignment is a report-only diagnosis: it changes no candidate source, test, fixture, snapshot, or gate and commits nothing. Builds and the scratch or runtime effects the assignment names are not such changes.
- Architect and a plan-first Hive primary keep planning first; this skill shapes the plan's tasks. Hive Builder runs the work through its ordinary ad-hoc lifecycle.
- A documentation-only request permits the documentation it names. A request for a concrete harness, script, or dependency authorizes that named work.

Scope tooling with the operators of this project, because whether new scripts, dependencies, services, or installed tools are acceptable differs by project. Reuse authorization they have already given and ask only about material choices that remain open; record anything you could not settle as a proposal.

The `AGENTS.md` entry is an instruction change. Ground its wording and target path in what the repository holds, and get item-level approval under `agents-md-mastery` before writing it; a documentation-only task never changes instructions as a side effect. When that approval is still pending, report discoverability as not yet adopted, apart from readiness: call the guide or harness ready to use only when its proof run below executed every setup step it needs; otherwise report it as unvalidated and name the steps that did not run. A product failure that the proof run finds does not lower readiness (see step 6).

Choose a project skill when an agent-only package is needed for reusable controls, within authorized scope. Use a project-supported skill location, creating it when needed within that scope. A documentation-only request does not authorize creating a skill. A project skill package needs a valid `SKILL.md` with `name` and `description` and its own relative helpers. A missing or malformed manifest is a package defect, not native readiness.

Load the candidate's skill through the native skill tool and confirm the loaded copy matches the candidate, not a cached or parent copy. If host discovery or candidate-identity access is unavailable, or the loaded copy is not the candidate's, read the candidate file as guidance and report it as not natively loaded. Reading does not satisfy an explicit requirement to load natively; report that acceptance unmet.

## Control ownership

Assign artifacts by responsibility and actual independent consumers, not by who created them. New agent-only control recipes and loop scripts belong with the project skill in a project-supported location. Tests of an agent helper, or occasional human invocation, do not alone make it shared product code. Shared product clients, contributor tools, CI harnesses and test oracles retain their canonical owners; improve them only under covering authority. Permanent regression coverage for a product change belongs in its existing canonical owning test suite when authorized. An agent control may assert observed outputs, but cannot substitute for that coverage; if the suite edit is out of scope, report and propose the gap. Do not force migration of existing shared tools. Keep human product and operation documentation canonical and link to it.

## Run Records and Versioned Guidance

Keep run-specific decisions and evidence in session or work logs or untracked artifacts, not in commits or canonical reusable controls. Update versioned guidance only when a shared procedure, contract, or requirement changes; state the current rule without decision history. Explicitly required scientific provenance and reusable fixtures may be kept in version control. Retain required evidence through cleanup.

## Creating Verification Capability

1. **Inspect what exists.** Read the applicable `AGENTS.md` files, any guide they name, the repository's scripts, CI workflows, test suites, and harnesses, and the user-facing claims that matter most: what users touch, what breaks them, and which claims existing checks already reach.
2. **Settle the expected-behavior basis.** For each claim, find what says it is correct: a specification, a public contract, an operator decision, or expected values derived independently of the code. Observed current behavior is a characterization, not an expectation. Ask the operator about product intent only when that evidence cannot settle it.
3. **Define claims and evidence before tools.** State each claim and the observation that would show it false. Then choose how to check it.
   For an outcome spanning current and future capabilities, define the meaningful current supported scope before execution from product promises, contracts, the candidate, and operator requirements. Identify usable outputs and the user's next task, and separately identify capabilities not yet implemented outside that scope. Historical or reference workflows inform user needs and the destination; they do not automatically set current acceptance or default parameters. A promised or expressly required capability that is absent or fails remains a failure, not a future gap. A broader outcome does not require testing unimplemented capabilities, and passing current checks does not establish completion of that outcome.
4. **Choose owning checks and controls.** Prefer the project's existing scripts and test suites, and reuse existing canonical guidance or a native skill that already covers the ground. Reuse commands, tools, native browser input and capture, and harnesses before adding code. Add a helper within scoped authority for a demonstrated repeated or fragile operation, not wrapper ceremony. A successful one-off workaround can become a reusable documented procedure; a missing convenience does not by itself require a product CLI extension. Nothing requires a feature map of a set size, and the guide does not repeat documentation that already exists.
5. **Write the guide.** It is content, not a schema; its location, filename, and headings follow the project. Cover:
   - applicability, and the claims with the basis for each expected outcome;
   - the owning checks, pointing to their executable definitions in scripts or configuration without copying whole command, test, or CI inventories;
   - real prerequisites, isolation from other instances and shared state, readiness, and supported reusable controls to reach relevant state, drive behavior, inspect actual results, and repeat a focused check. For non-UI libraries and configurations use real consumer, CLI, or property surfaces;
   - feature-specific agent interaction knowledge not already in docs or tests. State bypassed surfaces: an API result never substitutes for a UI pass;
   - where evidence is kept, and cleanup that removes what a run started while keeping that evidence;
   - when the guide assesses a user outcome, how to record progress toward it, limitations, and manual user work actually needed to complete it, such as assembly, reconciliation, or reconstruction. Distinguish that work from legitimate domain judgment and agent, verification, setup, or diagnostic overhead; record observed effort, supporting evidence, and unknowns without inventing savings or service levels;
   - known limitations and the changes that should prompt maintenance.

6. **Prove it as the next agent would.** Follow the published instructions within your authority: prepare, confirm readiness, exercise the generated or reused controls, inspect real output rather than exit status alone, and repeat a focused check. When a broad journey is requested or required, show how the same appropriate controls compose it. Capture evidence proportional to the check and any required evidence, clean up, and confirm that evidence survived cleanup. A step you did not run is unvalidated; say which, and never call unrun setup operationally validated. When the proof run finds a product failure, report check validity, the product result, the covered scope, and discoverability separately, as `verification` describes. A product failure found by a working check does not make the guide or harness a draft.

## Maintaining Verification Capability

- Preserve the first failure and its evidence before changing anything.
- Classify each discrepancy from evidence as guidance drift, a harness gap, a product failure, or an intended contract change. An intended change needs evidence such as the specification, the operator, or the change that introduced it.
- The same failure on an equivalent base shows the failure predates the change. It does not show that the harness drifted.
- Unchanged assertion text does not show unchanged coverage when a fixture, selector, input set, or bound narrowed.
- Changing an expected guarantee, a skip, retry, tolerance, assumption, or bound, or a selected gate obligation needs covering authority and a visible statement of its impact. Never weaken a check to make it pass; disclosing a weakening does not authorize it.
- Keep fixed regression inputs binding unless the operator authorizes a change. Do not reclassify skipped checks or shrink inputs after failure to obtain a pass. Keep the original results when using a recovery variant, and state the variant's separate applicability.
- Fixing the product needs implementation scope that covers the fix. Without it, report the product failure and keep it out of the verification change.
- Maintenance is requested work. No periodic job, pull request, or installation is required.

## Formal Verification

Read [references/formal-verification.md](references/formal-verification.md) when the requested capability uses a model checker, prover, code-level verifier, or exhaustive property check. Ordinary changes carry no proof obligation, and the limits on what each kind of proof result supports are in `verification`.

## Done

Stop when the requested capability exists within the authorized scope, its proof run is recorded with each unrun step named, any pending `AGENTS.md` approval is reported, and product findings are reported apart from verification changes. Report what you changed, the evidence, and what remains unvalidated.

Adapted from four pstack skills by Lauren Tan (MIT); see `UPSTREAM.md` and `LICENSE.pstack` in this skill for the source revision and what changed.
