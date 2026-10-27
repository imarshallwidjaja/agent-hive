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

Create no native skill as the project's guide by default. When the operator asks for one, it must be loaded through the native skill tool, which reading its file does not replace, and the copy the host loaded must match the candidate under test rather than a cached or parent copy.

## Creating Verification Capability

1. **Inspect what exists.** Read the applicable `AGENTS.md` files, any guide they name, the repository's scripts, CI workflows, test suites, and harnesses, and the user-facing claims that matter most: what users touch, what breaks them, and which claims existing checks already reach.
2. **Settle the expected-behavior basis.** For each claim, find what says it is correct: a specification, a public contract, an operator decision, or expected values derived independently of the code. Observed current behavior is a characterization, not an expectation. Ask the operator about product intent only when that evidence cannot settle it.
3. **Define claims and evidence before tools.** State each claim and the observation that would show it false. Then choose how to check it.
4. **Choose owning checks.** Prefer the project's existing scripts and test suites, and reuse existing canonical guidance or a native skill that already covers the ground. Add a harness, test library, control command, or script only within the scoped authority above, and only for a claim nothing existing reaches. Nothing requires a feature map of a set size, and the guide does not repeat documentation that already exists.
5. **Write the guide.** It is content, not a schema; its location, filename, and headings follow the project. Cover:
   - applicability, and the claims with the basis for each expected outcome;
   - the owning checks, pointing to their executable definitions in scripts or configuration without copying whole command, test, or CI inventories;
   - real prerequisites, isolation from other instances and shared state, readiness, how to drive the behavior, and what to observe;
   - where evidence is kept, and cleanup that removes what a run started while keeping that evidence;
   - known limitations and the changes that should prompt maintenance.

   Evidence from runs belongs in reports and artifacts, not as accumulating run history in the guide.
6. **Prove it as the next agent would.** Follow the guide yourself within your authority: prepare, confirm readiness, drive, capture evidence, clean up, and confirm the evidence survived cleanup. A step you did not run is unvalidated; say which, and never call unrun setup operationally validated. When the proof run finds a product failure, report check validity, the product result, the covered scope, and discoverability separately, as `verification` describes. A product failure found by a working check does not make the guide or harness a draft.

## Maintaining Verification Capability

- Preserve the first failure and its evidence before changing anything.
- Classify each discrepancy from evidence as guidance drift, a harness gap, a product failure, or an intended contract change. An intended change needs evidence such as the specification, the operator, or the change that introduced it.
- The same failure on an equivalent base shows the failure predates the change. It does not show that the harness drifted.
- Unchanged assertion text does not show unchanged coverage when a fixture, selector, input set, or bound narrowed.
- Changing an expected guarantee, a skip, retry, tolerance, assumption, or bound, or a selected gate obligation needs covering authority and a visible statement of its impact. Never weaken a check to make it pass; disclosing a weakening does not authorize it.
- Fixing the product needs implementation scope that covers the fix. Without it, report the product failure and keep it out of the verification change.
- Maintenance is requested work. No periodic job, pull request, or installation is required.

## Formal Verification

Read [references/formal-verification.md](references/formal-verification.md) when the requested capability uses a model checker, prover, code-level verifier, or exhaustive property check. Ordinary changes carry no proof obligation, and the limits on what each kind of proof result supports are in `verification`.

## Done

Stop when the requested capability exists within the authorized scope, its proof run is recorded with each unrun step named, any pending `AGENTS.md` approval is reported, and product findings are reported apart from verification changes. Report what you changed, the evidence, and what remains unvalidated.

Adapted from four pstack skills by Lauren Tan (MIT); see `UPSTREAM.md` and `LICENSE.pstack` in this skill for the source revision and what changed.
