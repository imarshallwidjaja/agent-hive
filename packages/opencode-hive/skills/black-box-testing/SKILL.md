---
name: black-box-testing
description: Use when asked explicitly to write a black-box test, or to adopt, migrate to, or audit black-box testing for a project, or when working in a repository whose instructions declare a black-box test contract and name this skill. Ordinary test work in other repositories does not trigger it.
---

# Black-box testing

A black-box test drives a real consumer interface the way a consumer does and asserts what that interface promises. This skill supplies testing-policy content only. It grants no tool, edit, commit, deletion, or instruction-change authority; the role and the request set what you may change.

## Uses and authority

The request selects the use.

- **One-off case:** an explicit request for a black-box case in a project that has not adopted a contract. Write that one case with the project's existing runner and conventions under the Case Rules. It adopts no policy and never forbids, rewrites, or deletes the project's other tests.
- **Adopt:** an explicit request to adopt black-box testing for a project. Load `project-verification` and `verification`; adoption runs through them, and this skill supplies only the content of the local contract. Adoption deletes nothing and retires no test.
- **Migrate:** an explicit request to migrate a project's tests to its black-box contract. Retire lower-level tests only under the retirement rule below.
- **Audit:** an explicit request to audit black-box testing. Report only, under the audit rule below. An audit deletes nothing and starts no migration.

In a repository whose instructions declare a black-box test contract, that local contract governs placement and the expected-file record. When you write a new black-box case and the local contract is silent on a point, apply the Case Rules and report the gap. Silence in the local contract, or a difference from these packaged rules, never authorizes rejecting a test that satisfies the local contract, treating a missing allowlist as a ban on lower-level tests, or starting a migration.

## Case Rules

These apply to every use.

- **Consumer interface.** Any real consumer interface counts: a CLI, an HTTP endpoint, a tool call, a packed artifact, or a library's exported API as a consumer installs it. Invoke it as a consumer would: the installed or built entry point, the public import path, the packed tarball. An export, flag, or hook that only a test uses is not a consumer interface.
- **A case** is a requirement, a concrete input, a real invocation, and every observable the requirement promises: exit status (or HTTP status, or error type), each output channel the contract names (stdout and stderr, response body, emitted events), files written, and state a consumer can read back. A case that matches the text but skips the status passes on a wrong status.
- **Expected values come from the requirement**, never from running the subject. A capture with no independent basis is characterization, not an expectation: label it so, and do not present it as proof of the requirement.
- **Two peer assertion styles.** Targeted assertions on the promised fields, and a full diff of normalized output against an expected file, are peers. Use a full diff when the whole output is the contract, such as a report, a generated file, or a wire format; use targeted assertions when only some fields are promised. Neither is a fallback for the other.
- **Normalize only variation the contract permits**, such as a timestamp, a temporary path, or an order the contract leaves open. Give each normalizer a reason. Never normalize a value the requirement specifies. A normalizer that does not find what it expects fails the case instead of passing raw output through.
- **Ordinary cases, not exceptions:** a case that substitutes an external service while the real product still runs, and a test that pins delivered text (a prompt, a configuration, a packaged file) by reading the delivered artifact.
- **Expected-file record.** A new expected file records the requirement values it was checked against. A changed expected file maps each kind of diff hunk to the requirement change behind it; a scripted bulk update is allowed when that mapping covers every hunk kind. A hunk kind with no requirement change behind it is not part of the update: investigate whether it is a regression, a permitted variation that needs a normalizer, or a correction against an unchanged requirement. The record goes in the commit or PR description and in the worker's report or handoff, never inside a diffed expected file, where it would become compared output.

Load `test-quality` before adding or changing a case: its executed break applies to black-box cases too.

## Adopted-Contract Rules

These apply only under a declared local contract or an explicit adopt, migrate, or audit request.

- **Allowlist.** After adoption, a lower-level behavior test is allowed only on a path the local contract lists, and each listed path names the fault that only that test detects. Everywhere else, new behavior coverage is an interface case. Lower-level tests that exist at adoption stay until an explicit migration retires them.
- **Mechanical check.** Adoption proposes one mechanical check that fits the project's existing tooling, such as a path rule in the test runner's configuration or a CI script, and states what it misses. The project's operators decide. When they decline, the contract states in the present tense that no mechanical check exists. A pending decision is recorded as pending, not as declined.
- **Retirement (migration only).** Retire a lower-level test outside the allowlist only by one of two routes:
  - (a) An interface case fails on the fault that test guarded. One executed break introduces one fault, so it retires only the lower-level tests that guard that fault, and the record shows each interface assertion failed for that fault; tests guarding distinct faults need separate breaks.
  - (b) Its branch is unreachable, and the branch is removed together with the test. Judge reachability against every entry point of the repository, whether or not the local contract declares it (other CLIs, webhooks, workers, build scripts, sibling packages), every published or workspace-internal export, and indirect entries, and check consumers across the whole repository, not only inside the migration's writable scope. Absent static callers or strict static types do not prove unreachability where config- or string-keyed dispatch, reflection, framework or serialization hooks, plugins, or untyped wire, persisted, or runtime input can reach the code. A branch reached through a runtime or external fault, or through a dependency-injection seam, is reachable: it is an allowlist candidate or an uncertain case, never route (b).

  A `test-quality` exemption that lets you add a test without an executed break does not let you retire its predecessor. Remove product code only inside the migration's writable scope. When either route is uncertain, keep the test and report the question that would settle it.
- **Audit.** Use the `test-quality` suite audit, limited to behavior tests, and answer two more questions: do the inspected behavior tests and expected-file changes follow the local contract's placement, unique-fault, and record rules; and is the local contract complete and usable, and where does it differ from these packaged rules? Report each difference as an omission, an approved local decision, or a proposed change. A difference never authorizes amending the repository, failing a valid test, or starting a migration. When the repository declares no local contract, the audit reports its absence and applies no allowlist or retirement rule.

## Stop conditions

Stop and report, or ask, when:

- the project, the interfaces in scope, or the use is not settled by the request;
- no consumer interface reaches the behavior; report it instead of adding a test-only entry point;
- an expected value has no independent basis and the operator has not settled it;
- a contract decision, such as the mechanical check or the allowlist, is still pending with the operators; record it as pending and report the contract as incomplete. A pending `AGENTS.md` approval is separate: `project-verification` reports it as discoverability not yet adopted;
- a retirement lacks the evidence its route needs; the test stays;
- the local contract conflicts with the request, or a required skill is unavailable for the affected use.

A project skill created during adoption must not be named `black-box-testing`, because a same-name skill replaces this packaged one. Name it after the project.

## References

Read [references/adoption.md](references/adoption.md) when adopting a contract: the questions that populate it, the local decisions to record, and the handoff test.

Read [references/migration.md](references/migration.md) when migrating: inventory, the evidence each retirement route needs, and the report.

Read [references/expected-file-example.md](references/expected-file-example.md) when writing or reviewing a case that diffs output against an expected file.

Some ideas are adapted from Paleo's `sharp-testing` (CC0 1.0); see `UPSTREAM.md` and `LICENSE.paleo`.
