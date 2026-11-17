---
name: test-quality
description: Use when reviewing changed assertions, test coverage claims, or duplicate tests; auditing a repository test suite; or pruning weak or redundant tests when explicitly asked.
---

# Test quality

Assess whether tests distinguish the required outcome from a plausible fault, with one canonical owner per invariant and failure mode. Use this lens within the active role's scope and finding bar. Loading it does not select TDD, authorize execution, grant write access, or expand a diff review into a repository audit.

## Modes

The request selects the mode; this skill grants no authority of its own. Under `/dash-review` or a read-only, review, or planning role, report within the assigned scope and never enter prune mode.

- **Review:** report evidence-backed findings within the active role's bar. A scoped review stays scoped.
- **Suite audit:** read [suite audit](references/suite-audit.md) for the repository mapping and report method. Audit is report-only; never fix or delete tests by default. Suite audit covers `/test-audit`, explicit audit requests, and questions such as "which tests should we remove?".
- **Prune:** an explicit imperative request or worker assignment to prune, rewrite, or remove weak or redundant tests is the implementation request; no separate follow-up request is needed. A request to review, audit, investigate, or fix failing tests is not one. Act within the scope the request or conversation names; when no scope is settled, ask instead of defaulting to the whole repository. Work under the active role's own implementation lifecycle; a role that plans before implementing keeps that rule, and a primary that delegates the work names `test-quality` as a required skill for the worker. Read [prune](references/prune.md) for the method. Establish the baseline, preserve unique coverage, and run affected checks. Pre-existing failures stay findings; remove support code only inside the settled scope after checking its consumers and public contracts; when a requirement, consumer, or fault overlap stays uncertain, keep the test or code and report the question that would settle it. Loading this skill or its reference grants no write access to a reviewer or planner.

## Outcome and oracle

For each assessed test, identify the requirement, public observable result, exercised subject and path, independent oracle, and plausible fault the assertion distinguishes. An oracle is the basis for the expected result: derive it from the requirement, an independent model, or a valid metamorphic relation, not from the same implementation used for the actual result.

Do not change tests merely to match a wrong implementation. Do not weaken existing assertions unless the expected behavior genuinely changed. Prefer no new test over a bad test: when brittle mocks or unrelated harness setup obscure the contract, select a stronger proportionate executable check and state what it proves.

A test is a claim about what the code does for its users: a caller, an end user, or another service. Behavior is what those users can observe through the interface they use: return values, errors, state they can read back, and effects on systems outside the code, such as a request sent, a row written, or a message emitted. Implementation is what they cannot observe: private helpers, internal call order, intermediate data, and which collaborator did the work. Outcome does not mean only an end-to-end UI test.

Judge a changed behavior test against two imagined edits:

- **Break the behavior.** Make the code return a wrong value, skip an effect, or perform it twice. If the test still passes, it proves nothing about that behavior. Usual causes are an assertion looser than the contract, an expected value computed by the same code under test, a fixture inspected without running the subject, or a mock's scripted response checked while product behavior is bypassed.
- **Change the internals.** Keep every observable result and restructure underneath. If the test now fails, it is pinned to the implementation and will need a rewrite on each refactor without catching a bug.

Keep a test that catches the first edit and survives the second. Drive the code through its users' interface with a concrete input and assert what the contract promises, no less and no more. These counterfactuals are reasoning tools, not a demand for mutation tooling or a benchmark campaign.

## What a weak test depends on

These are diagnostic leads; the contract and the observed product path decide. A test that misses the behavior break or fails the behavior-preserving refactor needs investigation, and it usually depends on one of these instead of the intended behavior:

- **The implementation:** the expected value is computed by the code under test, or the test reads private state, internal call order, or which helper ran.
- **Nothing:** no plausible product edit can fail it, as with a mock of the subject checked against itself or a re-check of what the language, type checker, framework, or platform guarantees. It is redundant only when it exercises no repository-owned behavior, integration, configuration, or runtime boundary; export-surface checks, dependency-upgrade canaries, and validation of untyped input are not "nothing".
- **An obsolete requirement:** it asserts that removed code, files, or wording stay absent. Ask what would be wrong if they came back. An absence check that observes a continuing requirement stays, such as retired wording that must not return or an invariant the repository's instructions require to stay pinned; a historical marker with no current requirement goes. A generator, sync script, vendored source, or persisted data can show a plausible way back, but it neither establishes nor rules out the requirement.
- **Another test:** a retained owner at the same layer fails on the specific fault this test guards, including its boundary and regression inputs.

A characterization test that pins unspecified legacy behavior stays until a contract test replaces it.

The contract decides, not the shape of the assertion. The payload a mocked external service receives is behavior, because that service observes it; a call to a private helper is not, because no user can see it. Reading a fixture after the product mutates it can prove observable state; asserting only the fixture's setup data cannot. An absence assertion can prove an important contract ("an empty cart never charges"); establish credible observability, for example with a paired case where the call does happen. When callers branch on an error type, the type is the contract and an exact-message assertion pins wording no one reads. A test can also pin an invariant, such as a key that must exist in two tables or a compile-time type check.

Prompt, configuration, and packaging pins can be legitimate when the delivered text, configuration, or safety contract is the behavior and the test reads the delivered artifact. Identify the invariant before retaining or deleting one; a pin that restates a constant the code never reads is the weak case. Wording presence proves delivery, not LLM compliance or model behavior. Do not turn a scoped change into deletion of unrelated tests.

## Ownership

Use the existing canonical suite for each invariant and failure mode; preserve unique behavior coverage. Similar assertions at different layers can detect distinct faults, such as a unit calculation error and an integration wiring error. Recommend folding duplicates only after naming the retained canonical owner and showing which unique coverage survives.

The source inspiration is pstack's `tdd` and `principle-test-behavior-not-implementation`; `UPSTREAM.md` and `LICENSE.pstack` identify the revisions, adaptations, and license. The prune mode adapts caldoai's `prune-tests`, recorded in `UPSTREAM.md` with `LICENSE.caldoai`.
