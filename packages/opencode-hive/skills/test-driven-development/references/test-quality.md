# Test quality

This reference assesses assertions; reading it does not select TDD or change the host's review bar.

Do not change tests merely to match a wrong implementation. Do not weaken existing assertions unless the expected behavior genuinely changed. Prefer no new test over a bad test: when brittle mocks or unrelated harness setup obscure the contract, select a stronger proportionate executable check and state what it proves.

For a changed behavior test, ask what concrete defect would make it fail. The pstack question "would it still pass if every function it imports returned `undefined`?" can expose a test that never observes the subject. It is a heuristic, not a universal test-quality theorem.

Look for assertions that only check a call occurred, derive their expected result from the implementation under test, inspect a fixture without running the subject, or accept almost any output. Exercise the intended call site and assert its observable result or effect. A valid absence assertion can prove an important contract; pair it with a relevant positive control when that distinguishes a broken implementation.

Prompt/configuration composition checks, repository-mandated pins, and tests protecting a named public or safety contract can be legitimate. Identify the invariant before retaining or deleting one. Wording presence proves presence, not model behavior. Do not turn a scoped change into deletion of unrelated tests.

Use the existing canonical suite for each invariant and preserve unique behavior coverage. The source inspiration is pstack's `tdd` and `principle-test-behavior-not-implementation`; this skill's `UPSTREAM.md` and `LICENSE.pstack` identify the revision and license.
