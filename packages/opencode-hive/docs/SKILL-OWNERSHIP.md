# Skill ownership and cutover

oc-arkive ships the skill sources in `packages/opencode-hive/skills/`. OpenCode loads them through the native skill tool after Hive materializes eligible directories into its generated cache. Edit packaged source, not generated cache files.

## Owners

| Concern | Owner | Boundary |
|---|---|---|
| Shared engineering orientation | `ENGINEERING_JUDGMENT_PROMPT` | Compact guidance in the existing role scope |
| Material construction choices | `code-design-principles` | Conditional depth, no separate plan or review verdict |
| Current-code explanation | `how` | Source-grounded mental model; Scouts retrieve and the primary explains |
| Historical rationale | `why` | Explicitly requested/assigned history, calibrated claims and source coverage |
| Diagnosis | `systematic-debugging` | Reproduce/investigate the cause, then fix within authority |
| Selected red-green mechanics | `test-driven-development` | Loading selects TDD; its test-quality reference can be read independently |
| Completion evidence | `verification` | Candidate/input applicability and observed evidence |
| Review methods and acceptance | Existing reviewer roles | Impact/finding heuristics live in the conditional `adversarial-review` reference; roles keep their bars |
| Writing routing and propagation | `writing-policy` | Select depth by artifact and defect; no universal overlay activation |
| Human-facing drafting | `writing-for-humans` | Reader needs, factual preservation, finish pass, naming |
| Cadence and structure repair | `stop-slop` | Existing prose with demonstrated cadence/structure problems |
| Vocabulary and presentation repair | `humanizer` | Existing prose with vocabulary, register, attribution, or formatting problems |
| Agent-facing instructions | `writing-for-agents` | Instruction structure and invocation, not a competing human-prose policy |
| Public PR/review writing | `pr-writing` | Artifact-specific content, source anchoring, and publication authority |

Planning, execution, concurrency, recovery, and managed context keep their established owners. New design guidance does not authorize clearing state, adopting live sessions, deleting public compatibility, bypassing checks, or promoting reviewer votes into acceptance.

## Moving the writing family into package ownership

The canonical names are `writing-policy`, `writing-for-humans`, `stop-slop`, and `humanizer`. There is no `humanize` alias. The package versions retain the operator-maintained principles and scope split, with source provenance in each directory. Cleanup examples that introduced new facts were replaced with evidence-preserving examples.

Native/user skills with the same frontmatter `name` take precedence over Hive bundles. The relevant sources can include global `~/.agents/skills` and `~/.claude/skills`, OpenCode config-directory `skills`/`skill`, project-discovered skill directories, configured `skills.paths`, and configured `skills.urls`. A differently named directory with the same frontmatter name can still shadow a bundle.

To cut over:

1. Install or build the oc-arkive revision containing the four writing directories and their references. Confirm that the actual plugin host is configured to load that inspected package. A build in a temporary worktree does not change what an existing server loads. This guide does not imply an unpublished checkout is already on npm.
2. Inspect the currently loaded skill paths and discovery/configuration sources for those four names. Review local differences and move still-required changes into the canonical package first. Make a backup of the old copies and affected registrations outside all discovered paths; retain it until the new host's skill paths are verified. A personal voice skill can remain separate.
3. Check the active host configuration before withdrawing any copy: the four bundle names must not be in `disableSkills`, and configured URL discovery must be healthy. `disableSkills` suppresses bundled materialization but not native overrides. A failed URL scan suppresses bundles. Resolve either condition rather than using deletion to work around it.
4. Temporarily withdraw the old four skill directories or their discovery registrations from the sources you own, using the retained backups for rollback. The bundles cannot become eligible while same-name overrides remain. Renaming only a directory does not remove a frontmatter-name conflict; a URL or another configured repository path must also stop exposing the old copy. Do not permanently delete the backed-up source yet.
5. Restart the process configured to load the inspected package and begin a new session. If that process is managed by `opencode.service`, restart that service rather than only reconnecting a client. Restarting that service helps only if its plugin configuration points at the inspected package.
6. Load each skill by exact name. Verify the returned path is under the current `agent-hive/generated/opencode-skills/<hash>/` directory and its content, references, and provenance match the inspected revision. Existing-session output is not proof. If startup or any load fails, restore the withdrawn copies/registrations from backup and restart the same host before investigating; do not leave a gap in writing guidance.
7. After all four loads are confirmed, permanently retire obsolete source copies/registrations from the repositories you own. Remove only duplicated local prose rules; retain repository-specific constraints and explicit voice choices. A short pointer to `writing-policy` can replace the duplicated rules. Do not load all four skills unconditionally.

The runtime keeps its existing override behavior. There is no new copy synchronization, alias, migration flag, or dual-source maintenance process. Maintain future shared changes in oc-arkive; maintain deliberate project/voice overrides only where they have a distinct purpose.

## Source-preserving maintenance

The pstack-derived material is pinned to `cursor/plugins` revision `fae2c6ed95821bd85f614a73e4842e13229fa5e5` (pstack 0.15.5). The new skill directories carry the upstream MIT notice and adaptation notes. The operator's writing sources were local, unversioned directories; their provenance records that limitation instead of inventing a commit.

When editing an imported passage, distinguish source wording retained, host-mechanics adaptation, and deliberate policy changes. Keep applicability and exceptions with the rule. Preserve sharp instructional language such as "Execution order is not ownership" rather than routing it through prose cleanup.

Source wording and static tests establish what instructions are present. They do not establish how reliably a model follows them. The repository-only `packages/opencode-hive/evals/skill-integration.json` records representative behavior-review inputs and criteria; it is not included in the npm package. Record actual model/harness, candidate, inputs, and results when running them; the criteria themselves are not passing evidence.

## Deliberate changes to existing guidance

This integration replaces unconditional brainstorming checkpoints, exact-step obedience, blanket post-batch waiting, routine review-consent questions, and numeric intent/delegation proxies with material decisions inside the existing approval and placement contracts. A test failure calls for authorized diagnosis; it is not automatically an operator blocker. Required reviews and explicit operator gates remain binding.

Debugging now challenges shared premises rather than declaring an architecture wrong from an attempt count. Validation is attached to actual trust/mutation boundaries, including needed rechecks. Verification evidence can be reused only when the approved gate, candidate, inputs, and boundary match. Unsourced performance claims about the debugging method were removed.

These are the policy changes approved in the integration design, not merely host syntax substitutions. Selected diagnostic sentences were taken from pstack's bug/performance playbooks; the poteto-mode router, playbook workflow, PR automation, and autonomy policy are not adopted.
