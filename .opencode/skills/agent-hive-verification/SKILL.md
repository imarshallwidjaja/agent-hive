---
name: agent-hive-verification
description: Use when selecting or running verification for changes to Agent Hive components, installed OpenCode hosts, instruction contracts, packaging, or the repository's exercise harness.
---

# Agent Hive verification

Use `verification` for evidence selection, interpretation and completion claims. This reference maps changed responsibilities to existing checks; it does not change gates in the assignment, plan or root `AGENTS.md`.

Before a run, identify each changed contract, its independent expectation and the observation that would falsify it. Select the owning tests and any required integration gate. Record the candidate commit and dirty inputs, fixture and configuration, and relevant built artifact identity. Read the actual output, including failures and skips. Component checks suffice when they cover the changed invariant at its owning boundary and no broader gate or installed-host claim applies. Expand when a change crosses boundaries or its impact is uncertain.

## Component owners

Paths are repository-root-relative. To run a focused test from its owning package with `bun test <relative-test-path>`, drop the `packages/<pkg>/` prefix. Inspect the named suite for the cases and setup that apply; these are entry points, not an exhaustive inventory. For an unlisted component, start with its colocated owning test, then use the owning package's test script if no focused test covers the change.

| Changed responsibility or invariant | Owning checks |
| --- | --- |
| Feature, plan and task state, dependencies and freshness | `packages/hive-core/src/services/featureService.test.ts`, `packages/hive-core/src/services/planService.test.ts`, `packages/hive-core/src/services/taskService.test.ts`, `packages/hive-core/src/services/taskDependencyGraph.test.ts` |
| Context revisions, guarded writes and recovery | `packages/hive-core/src/services/contextService.test.ts`; tool contract also `packages/opencode-hive/src/runtime/hive-tools.test.ts` |
| Worklog records and concurrent file/lock behavior | `packages/hive-core/src/services/worklogService.test.ts`, `packages/hive-core/src/utils/paths.test.ts` |
| Worktree identity, integration, operations and ad-hoc lifecycle | `packages/hive-core/src/services/worktreeService.test.ts`, `packages/hive-core/src/services/adhocWorktreeService.test.ts`, `packages/hive-core/src/services/worktreeTarget.test.ts`, `packages/hive-core/src/services/worktreeOperation.test.ts` |
| Retained checkout registration, readiness, cleanup, governing project detection and read-only inspection | `packages/hive-core/src/services/retainedCheckoutService.test.ts`, `packages/hive-core/src/services/checkoutInspector.test.ts`, `packages/hive-core/src/utils/detection.test.ts`; exposed operations also `packages/opencode-hive/src/runtime/hive-tools.test.ts` |
| Task target metadata and dispatch association across hosts | `packages/hive-core/src/services/taskService.test.ts`, `packages/opencode-hive/src/task-brief.test.ts`, `packages/opencode-hive/src/runtime.test.ts`, `packages/opencode-hive/src/v2/dispatch.test.ts`, `packages/opencode-hive/src/background/backgroundJobAdapter.test.ts`; tool contract also `packages/opencode-hive/src/runtime/hive-tools.test.ts` |
| Plugin tool registration, schema and permissions on both hosts | `packages/opencode-hive/src/runtime/hive-tools.test.ts`, `packages/opencode-hive/src/runtime.test.ts`, `packages/opencode-hive/src/v2/registration.test.ts`, `packages/opencode-hive/src/v2/plugin.test.ts` |
| Dispatch, background observations and trace identity | `packages/opencode-hive/src/v2/dispatch.test.ts`, `packages/opencode-hive/src/background/backgroundTools.test.ts`, `packages/opencode-hive/src/background/backgroundJobAdapter.test.ts`, `packages/opencode-hive/src/background/taskLifecycleHook.test.ts`, `packages/opencode-hive/src/v2/background.test.ts`, `packages/opencode-hive/src/task-trace.test.ts`, `packages/opencode-hive/src/v2/trace-source.test.ts` |
| Prompt and skill wording, materialization and host rendering | `packages/opencode-hive/src/agents/prompts.test.ts`, `packages/opencode-hive/src/skills/skill-content.test.ts`, `packages/opencode-hive/src/skills/native-materializer.test.ts`; follow `packages/opencode-hive/docs/SKILL-OWNERSHIP.md` |
| Packed public declarations, consumer dependencies and native assets | Follow `package.json` `release:check` and `.github/workflows/ci.yml` for builds and release artifact, workflow and documentation checks, including `release-artifacts.test.mjs`, `release-vscode-bundle.test.mjs`, `release-workflow.test.mjs` and `release-docs.test.mjs`. Build the required packages before running artifact checks; follow `AGENTS.md` for pins and release obligations. |
| Shared instruction-contract harness, isolation, credentials, lifecycle and evidence | `packages/opencode-hive/evals/instruction-contracts/harness.test.ts`; see its `README.md` and `EXERCISES.md` for installed-host checks |

For example, a context hash-guard change needs the core context suite and, if the exposed tool contract changes, the plugin tool suite. A role permission change needs both host permission checks and may need installed-host wiring. A prompt wording change needs the pinned wording suites; a claim that a model follows it needs qualitative evidence. A native dependency or public type change needs the applicable packed-consumer and VSIX checks, not just unit tests.

Install dependencies in the candidate worktree when needed, confirm `hive-core` resolves there, and build core before OpenCode checks as root `AGENTS.md` requires. Follow its concurrency-failure procedure and generated VS Code bundle rule. After integration, follow the root AGENTS.md verification rule on the actual target; required release gates remain binding. A local component edit does not by itself require a release rehearsal.

## Installed-host and model evidence

The fixed suite's authoritative procedure is `packages/opencode-hive/evals/instruction-contracts/README.md`. Its `run.mjs` builds a committed candidate from an archive; dirty edits are not the subject. It binds the subject, harness, artifact and runtime identities. Use **wiring** with the scripted mock provider when the claim concerns installed package exposure, tool schemas, host registration, skill delivery or model selection. Wiring on both hosts is not model-behavior evidence.

Use **acceptance rehearsal** for a selected scenario's installed-host fixture and compliant mock path. It reuses the wiring artifact and verifies the safety and fixture controls; it does not assess model behavior. Select only scenarios covering the changed instruction contract. The fixed menu in the README is:

| Scenario ID | Contract to examine |
| --- | --- |
| `worker-bounded-change` | Worker execution, report and retained attempt limit |
| `milestone-closure` | Target and companion closure with reviews |
| `adhoc-coordination` | Shared ownership and no-background coordination |
| `partial-result-decisions` | Partial publication, guarded context and safe stops |
| `interrupted-writer` | Uncertain writer and observed versus verified pin |
| `paired-review-adversarial` | Independent reviews, seeded defect and controls |
| `skill-override-reference` | Native skill override and reference selection |
| `substantive-handoff` | Binding scope, identity and evidence in a handoff |

When those fixed cases answer a real-model question, obtain explicit authorization for the named paid run and follow the README's acceptance procedure. `collected` means records were collected, not that behavior passed: assess each case against its expectation and evidence limits. A failed or incomplete case is not a behavioral pass. A time deadline is not a request or spending cap; report actual visibility and unknown costs. No automatic paid reruns are authorized by this guide.

For a question requiring supervision across turns or a different workflow, use `packages/opencode-hive/evals/instruction-contracts/EXERCISES.md`: define the question, observables and stop conditions in temporary inputs, prepare credential-free, then obtain authorization for the exact named live run before start. Inspect, supervise and stop as that procedure specifies. The exercise accepts project skill text through its `skills` input; ensure it is the candidate's `SKILL.md` and verify native loading and candidate identity in the observed host. A file read or a packaged-plugin wiring pass alone does not prove this project skill was loaded. Qualification uses a mock and does not prove real-model behavior.

For either harness, the access token is readable by container tool processes; follow the owning procedure's isolation, lifetime and export controls. Retain complete available outputs, manifests, identities and bounded evidence before teardown, and report clipping, missing observations and partial outcomes. Follow the owning procedure's resource cleanup and confirm evidence survives it; preserve unresolved resource identities. Record the observed model and settings when applicable. Keep fixture, harness, host, provider and product failures distinct from instruction behavior, and never treat unrun work as passing.
