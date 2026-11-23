# Adoption

This reference adds method, not authority. Adoption runs through `project-verification`'s Creating steps and `verification`; SKILL.md holds the rules and stop conditions. Use the questions below to fill those steps with black-box content. They are not a second creation procedure.

## Questions for the Creating steps

- **Inspect what exists:** Which consumer interfaces does the project support (CLIs, HTTP endpoints, tool calls, packed artifacts, exported library APIs)? How does a consumer invoke each one, and does any existing suite already invoke it that way? Which tests reach past those interfaces into internals?
- **Settle the expected-behavior basis:** For each interface, what states its promises: a specification, a published schema, help text the project treats as contract, an operator decision? Which existing expected files have an independent basis, and which are captures that stay characterization?
- **Define claims before tools:** Which observables does each interface promise: exit or HTTP status, error type or code, which output channels, files written, state read back? Which variation does the contract leave open, so that a normalizer may remove it?
- **Choose owning checks:** Which existing runner, fixture layout, and build step can invoke the real interface? Which lower-level tests detect a fault that no interface case can reach, and what is that fault?
- **Prove it**, within your authority: place one interface case as a newcomer would and run it. When the proof breaks behavior to see the case fail for its promised reason, use `test-quality`'s executed break, including its restore steps. Walk one expected-file change through the record rule only when the contract uses expected files. Remove a proof-only case unless a permanent test is inside the request. Report any step you did not run as unvalidated, as `project-verification` requires.

## Local decisions to record

The local contract records each of these with the project's own interfaces, paths, commands, and decisions:

- For each supported interface, how a test invokes it as a consumer, and which suite owns its cases.
- The placement rule: new behavior coverage is an interface case except on allowlisted paths, and lower-level tests that exist at adoption stay until an explicit migration retires them.
- Fixture and expectation conventions: where inputs and expected files live, how a case is named, and the command that runs one case and the whole set.
- Each permitted normalization and the reason the contract allows that variation.
- The expected-file record rule in full, not only where it lives: what a new expected file records; the mapping of each hunk kind in a changed file to its requirement change, with scripted bulk updates allowed under that mapping; that an unmapped hunk kind is not part of the update and is investigated as a regression, a permitted variation that needs a normalizer, or a correction against an unchanged requirement; that a capture without an independent basis stays labeled characterization; and that the record lives in the commit or PR description, plus the report or handoff when an agent makes the change, never inside a diffed expected file.
- Allowlisted paths for lower-level behavior tests, each with the fault only that test detects, or the statement that there are none.
- The mechanical check the operators chose, and what it misses; or the present-tense statement that no mechanical check exists; or, while the operators have not decided, that the decision is pending.

## Handoff test

The contract is complete when a contributor who has never seen oc-arkive can, from the checkout alone, place a new test, run it, review an expected-file change, and tell that pre-existing lower-level tests stay untouched outside an explicit migration. Write the whole contract into the repository. It never tells the reader to load `black-box-testing` to learn how, and it is written for this project, not filled into a template.

Check it by following it as that contributor: open only the repository's instructions and the guide they point to, and confirm each of those tasks is answerable. A question you can answer only from this skill is a gap in the local contract.
