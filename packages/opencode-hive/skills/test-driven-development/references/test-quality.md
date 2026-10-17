# Test quality

This reference assesses assertions; reading it does not select TDD or change the host's review bar.

Do not change tests merely to match a wrong implementation. Do not weaken existing assertions unless the expected behavior genuinely changed. Prefer no new test over a bad test: when brittle mocks or unrelated harness setup obscure the contract, select a stronger proportionate executable check and state what it proves.

A test is a claim about what the code does for its users: a caller, an end user, or another service. Behavior is what those users can observe through the interface they use: return values, errors, state they can read back, and effects on systems outside the code, such as a request sent, a row written, or a message emitted. Implementation is what they cannot observe: private helpers, internal call order, intermediate data, and which collaborator did the work.

Judge a changed behavior test against two imagined edits:

- **Break the behavior.** Make the code return a wrong value, skip an effect, or perform it twice. If the test still passes, it proves nothing about that behavior. Usual causes are an assertion looser than the contract, an expected value computed by the code under test, a restated constant or prompt string that never runs the code that reads it, a fixture inspected without running the subject, and an assertion on data the test built itself.
- **Change the internals.** Keep every observable result and restructure underneath. If the test now fails, it is pinned to the implementation and will need a rewrite on each refactor without catching a bug.

Keep a test that catches the first edit and survives the second. To write one, drive the code through its users' interface with a concrete input, derive the expected value from the requirement and not from a run of the code, and assert what the contract promises, no less and no more.

The contract decides, not the shape of the assertion. The payload a mocked external service receives is behavior, because that service observes it; a call to a private helper is not, because no user can see it. An absence assertion can prove an important contract ("an empty cart never charges"); pair it with a case where the call does happen, so the test shows it can see one. When callers branch on an error type, the type is the contract and an exact-message assertion pins wording no one reads. A test can also pin an invariant instead of a call, such as a key that must exist in two tables or a compile-time type check.

Prompt, configuration, and packaging pins can be legitimate when the delivered text, configuration, or safety contract is the behavior and the test reads the delivered artifact. Identify the invariant before retaining or deleting one; a pin that restates a constant the code never reads is the weak case. Wording presence proves presence, not model behavior. Do not turn a scoped change into deletion of unrelated tests.

Use the existing canonical suite for each invariant and preserve unique behavior coverage. The source inspiration is pstack's `tdd` and `principle-test-behavior-not-implementation`; this skill's `UPSTREAM.md` and `LICENSE.pstack` identify the revisions and license.
