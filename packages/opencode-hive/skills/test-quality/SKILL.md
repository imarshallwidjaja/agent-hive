---
name: test-quality
description: Use when reviewing changed assertions, test coverage claims, or duplicate tests; auditing a repository test suite; or explicitly remediating weak or redundant tests.
---

# Test quality

Assess whether tests distinguish the required outcome from a plausible fault, with one canonical owner per invariant and failure mode. Use this lens within the active role's scope and finding bar. Loading it does not select TDD, authorize execution, grant write access, or expand a diff review into a repository audit.

## Outcome and oracle

For each assessed test, identify the requirement, public observable result, exercised subject and path, independent oracle, and plausible fault the assertion distinguishes. An oracle is the basis for the expected result: derive it from the requirement, an independent model, or a valid metamorphic relation, not from the same implementation used for the actual result.

Do not change tests merely to match a wrong implementation. Do not weaken existing assertions unless the expected behavior genuinely changed. Prefer no new test over a bad test: when brittle mocks or unrelated harness setup obscure the contract, select a stronger proportionate executable check and state what it proves.

A test is a claim about what the code does for its users: a caller, an end user, or another service. Behavior is what those users can observe through the interface they use: return values, errors, state they can read back, and effects on systems outside the code, such as a request sent, a row written, or a message emitted. Implementation is what they cannot observe: private helpers, internal call order, intermediate data, and which collaborator did the work. Outcome does not mean only an end-to-end UI test.

Judge a changed behavior test against two imagined edits:

- **Break the behavior.** Make the code return a wrong value, skip an effect, or perform it twice. If the test still passes, it proves nothing about that behavior. Usual causes are an assertion looser than the contract, an expected value computed by the same code under test, a fixture inspected without running the subject, or a mock's scripted response checked while product behavior is bypassed.
- **Change the internals.** Keep every observable result and restructure underneath. If the test now fails, it is pinned to the implementation and will need a rewrite on each refactor without catching a bug.

Keep a test that catches the first edit and survives the second. Drive the code through its users' interface with a concrete input and assert what the contract promises, no less and no more. These counterfactuals are reasoning tools, not a demand for mutation tooling or a benchmark campaign.

The contract decides, not the shape of the assertion. The payload a mocked external service receives is behavior, because that service observes it; a call to a private helper is not, because no user can see it. Reading a fixture after the product mutates it can prove observable state; asserting only the fixture's setup data cannot. An absence assertion can prove an important contract ("an empty cart never charges"); establish credible observability, for example with a paired case where the call does happen. When callers branch on an error type, the type is the contract and an exact-message assertion pins wording no one reads. A test can also pin an invariant, such as a key that must exist in two tables or a compile-time type check.

Prompt, configuration, and packaging pins can be legitimate when the delivered text, configuration, or safety contract is the behavior and the test reads the delivered artifact. Identify the invariant before retaining or deleting one; a pin that restates a constant the code never reads is the weak case. Wording presence proves delivery, not LLM compliance or model behavior. Do not turn a scoped change into deletion of unrelated tests.

## Ownership and authority

Use the existing canonical suite for each invariant and failure mode; preserve unique behavior coverage. Similar assertions at different layers can detect distinct faults, such as a unit calculation error and an integration wiring error. Recommend folding duplicates only after naming the retained canonical owner and showing which unique coverage survives.

- **Review:** report evidence-backed findings within the active role's bar. A scoped review stays scoped.
- **Suite audit:** read [suite audit](references/suite-audit.md) for the repository mapping and report method. Audit is report-only; never fix or delete tests by default.
- **Explicit remediation:** only a separate implementation request authorizes fixes, under the active role's implementation lifecycle. Establish the baseline, preserve unique coverage, and run affected checks. A reviewer does not gain write access by loading this skill.

The source inspiration is pstack's `tdd` and `principle-test-behavior-not-implementation`; `UPSTREAM.md` and `LICENSE.pstack` identify the revisions, adaptations, and license.
