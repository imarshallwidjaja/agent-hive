---
name: test-quality
description: Use when reviewing changed assertions, test coverage claims, or duplicate tests; adding or changing a behavior test in implementation work; auditing a repository test suite; or pruning weak or redundant tests when explicitly asked.
---

# Test quality

Assess whether tests distinguish the required outcome from a plausible fault, with one canonical owner per invariant and failure mode. Use this lens within the active role's scope and finding bar. Loading it does not select TDD, authorize execution, grant write access, or expand a diff review into a repository audit.

## Modes

The request selects the mode; this skill grants no authority of its own. Under `/dash-review` or a read-only, review, or planning role, report within the assigned scope and never enter prune mode.

- **Review:** report evidence-backed findings within the active role's bar. A scoped review stays scoped. For an added or changed behavior test, report a break record that is missing without a fitting exemption, or a break or red run that misses the behavior the requirement names; a stated exemption that fits is not a finding, and a stated obstruction is a verification gap to note, not a defect in the test. The reviewer reads the record and runs nothing.
- **Suite audit:** read [suite audit](references/suite-audit.md) for the repository mapping and report method. Audit is report-only; never fix or delete tests by default. Suite audit covers `/test-audit`, explicit audit requests, and questions such as "which tests should we remove?".
- **Prune:** an explicit imperative request or worker assignment to prune, rewrite, or remove weak or redundant tests is the implementation request; no separate follow-up request is needed. A request to review, audit, investigate, or fix failing tests is not one. Act within the scope the request or conversation names; when no scope is settled, ask instead of defaulting to the whole repository. Work under the active role's own implementation lifecycle; a role that plans before implementing keeps that rule, and a primary that delegates the work names `test-quality` as a required skill for the worker. Read [prune](references/prune.md) for the method. Establish the baseline, preserve unique coverage, and run affected checks. Pre-existing failures stay findings; remove support code only inside the settled scope after checking its consumers and public contracts; when a requirement, consumer, or fault overlap stays uncertain, keep the test or code and report the question that would settle it. Loading this skill or its reference grants no write access to a reviewer or planner.

## Outcome and oracle

For each assessed test, identify the requirement, public observable result, exercised subject and path, independent oracle, and plausible fault the assertion distinguishes. An oracle is the basis for the expected result: derive it from the requirement, an independent model, or a valid metamorphic relation, not from the same implementation used for the actual result. A snapshot or golden file captured from the implementation is implementation-derived until its expected values are checked against the requirement; a characterization test may still record unspecified behavior.

Do not change tests merely to match a wrong implementation. Do not weaken existing assertions unless the expected behavior genuinely changed. Prefer no new test over a bad test: when brittle mocks or unrelated harness setup obscure the contract, select a stronger proportionate executable check and state what it proves. Coverage numbers and new branches alone do not justify a test.

A test is a claim about what the code does for its users: a caller, an end user, or another service. Behavior is what those users can observe through the interface they use: return values, errors, state they can read back, and effects on systems outside the code, such as a request sent, a row written, or a message emitted. Implementation is what they cannot observe: private helpers, internal call order, intermediate data, and which collaborator did the work. Outcome does not mean only an end-to-end UI test.

Judge a changed behavior test against two counterfactual edits:

- **Break the behavior.** Make the code return a wrong value, skip an effect, or perform it twice. If the test still passes, it proves nothing about that behavior. Usual causes are an assertion looser than the contract, an expected value computed by the same code under test, a fixture inspected without running the subject, or a mock's scripted response checked while product behavior is bypassed.

  When your implementation work adds or changes a behavior test, make this edit for real, in this order (a reviewer only reasons about it and runs nothing):

  1. Change the value, branch, or effect the requirement names, and rebuild any compiled output the test reads.
  2. Run the test. Record the edit and the failing assertion.
  3. Reverse only the break edit by hand, never with a checkout, restore, reset, or stash over a file that holds uncommitted work. Rebuild whatever you rebuilt for the break, including tracked build output, confirm the diff holds no trace of the break, and rerun the test green before committing.

  The break counts only when the test's own assertion fails for the promised reason; a compile error, a broken setup, an unconditional throw (unless throwing is the contract), a deleted symbol, or an edited expectation does not count. One break may cover several tests when the record shows each failed for its own promised reason. Strengthen a test that no such break fails, or remove it only after naming the retained owner that covers its behavior. A break that cannot run is a gap to report, not a reason to delete the test.

  An observed red run counts instead when the added or changed assertion was seen failing for the missing or incorrect behavior before the production change was made, including an assertion added to an existing test and a bug-fix regression test. A test written or changed alongside or after the production change needs the executed break. Refactors under existing coverage, characterization tests, prompt, configuration, and packaging wording pins, and suites too slow for a local iteration loop keep the reasoning check. When an added or changed behavior test gets no executed break, state in one line which case applies and why: the observed red run and its failing assertion, the exempt category (for a slow suite, why no focused run of that test was feasible), or the concrete obstruction that kept the break from running.
- **Change the internals.** Keep every observable result and restructure underneath. If the test now fails, it is pinned to the implementation and will need a rewrite on each refactor without catching a bug.

Keep a test that catches the first edit and survives the second. Drive the code through its users' interface with a concrete input and assert what the contract promises, no less and no more. No role needs mutation tooling or a benchmark campaign.

## What a weak test depends on

These are diagnostic leads; the contract and the observed product path decide. A test that misses the behavior break or fails the behavior-preserving refactor needs investigation, and it usually depends on one of these instead of the intended behavior:

- **The implementation:** the expected value is computed by the code under test, or the test reads private state, internal call order, or which helper ran. An export, flag, or hook used only by a test is a lead to inspect, not proof: check indirect consumers and public or workspace contracts, and keep dependency-injection seams and deterministic failure-mode hooks.
- **Nothing:** no plausible product edit can fail it, as with a mock of the subject checked against itself or a re-check of what the language, type checker, framework, or platform guarantees. It is redundant only when it exercises no repository-owned behavior, integration, configuration, or runtime boundary; export-surface checks, dependency-upgrade canaries, and validation of untyped input are not "nothing".
- **An obsolete requirement:** it asserts that removed code, files, or wording stay absent. Ask what would be wrong if they came back. An absence check that observes a continuing requirement stays, such as retired wording that must not return or an invariant the repository's instructions require to stay pinned; a historical marker with no current requirement goes. A generator, sync script, vendored source, or persisted data can show a plausible way back, but it neither establishes nor rules out the requirement.
- **Another test:** a retained owner at the same layer fails on the specific fault this test guards, including its boundary and regression inputs.

A characterization test that pins unspecified legacy behavior stays until a contract test replaces it.

The contract decides, not the shape of the assertion. The payload a mocked external service receives is behavior, because that service observes it; a call to a private helper is not, because no user can see it. Reading a fixture after the product mutates it can prove observable state; asserting only the fixture's setup data cannot. An absence assertion can prove an important contract ("an empty cart never charges"); establish credible observability, for example with a paired case where the call does happen. When callers branch on an error type, the type is the contract and an exact-message assertion pins wording no one reads. For a rejection, violate the intended guard with otherwise-valid input and assert the error code, type, or exit status the contract specifies; a failure that an earlier, unrelated check causes proves nothing about that guard. A test can also pin an invariant, such as a key that must exist in two tables or a compile-time type check.

Prompt, configuration, and packaging pins can be legitimate when the delivered text, configuration, or safety contract is the behavior and the test reads the delivered artifact. Identify the invariant before retaining or deleting one; a pin that restates a constant the code never reads is the weak case. Wording presence proves delivery, not LLM compliance or model behavior. Do not turn a scoped change into deletion of unrelated tests.

## Ownership

Use the existing canonical suite for each invariant and failure mode; preserve unique behavior coverage. Similar assertions at different layers can detect distinct faults, such as a unit calculation error and an integration wiring error. Recommend folding duplicates only after naming the retained canonical owner and showing which unique coverage survives.

When repository instructions declare a black-box test contract, follow it for test placement and the expected-file record. `black-box-testing` owns migration to and audit of that contract, including retiring a lower-level test in favor of an interface case, which the same-layer fold rule here does not cover.

The source inspiration is pstack's `tdd` and `principle-test-behavior-not-implementation`; `UPSTREAM.md` and `LICENSE.pstack` identify the revisions, adaptations, and license. The prune mode adapts caldoai's `prune-tests`, recorded in `UPSTREAM.md` with `LICENSE.caldoai`. The notes on captured snapshots, rejection guards, coverage-driven tests, and test-only exports, flags, or hooks adapt Paleo's `sharp-testing`, recorded in `UPSTREAM.md` with `LICENSE.paleo`.
