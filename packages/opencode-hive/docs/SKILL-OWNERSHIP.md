# Skill ownership

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
| Human-facing drafting | `writing-for-humans` | Reader needs, factual preservation, boundaries, finish pass, naming |
| Cadence and structure repair | `stop-slop` | Existing prose with demonstrated cadence/structure problems |
| Vocabulary and presentation repair | `humanizer` | Existing prose with vocabulary, register, attribution, or formatting problems |
| Agent-facing instructions | `writing-for-agents` | Instruction structure and invocation, not a competing human-prose policy |
| Public PR/review writing | `pr-writing` | Artifact-specific content, source anchoring, and publication authority |
| Hive runtime layout, state ownership, read-only forensics, and Agent Hive configuration | `hive-config` | Self-contained reference for where `.hive/` state lives, which tool owns each change, read-only task/Git/session-store recipes, and `agent_hive.json`/override editing. It points to owners rather than restating them: managed context selection and mutation stay with `context-engineering`, background board protocol with `background-delegation`, and tool input/output contracts with the tool schemas and `docs/HIVE-TOOLS.md`. `skill-content.test.ts` pins its config keys, agent names, reserved IDs, tool names, and paths to source |

Planning, execution, concurrency, recovery, and managed context keep their established owners. New design guidance does not authorize clearing state, adopting live sessions, deleting public compatibility, bypassing checks, or promoting reviewer votes into acceptance.

## Source-preserving maintenance

Imported skills carry source provenance, applicable license notices, and adaptation notes in their skill directories.

When editing an imported passage, distinguish source wording retained, host-mechanics adaptation, and deliberate policy changes. Keep applicability and exceptions with the rule. Preserve sharp instructional language such as "Execution order is not ownership" rather than routing it through prose cleanup.

Source wording and static tests establish what instructions are present. They do not establish how reliably a model follows them. The repository-only `packages/opencode-hive/evals/skill-integration.json` records representative behavior-review inputs and criteria; it is not included in the npm package. Record actual model/harness, candidate, inputs, and results when running them; the criteria themselves are not passing evidence.
