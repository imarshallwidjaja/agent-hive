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
| Review methods and acceptance | Shared `REVIEW_INVESTIGATION_PROMPT` for implementation reviewers; existing reviewer roles for acceptance | The shared prompt owns the lead -> verify -> disprove method; impact/finding depth lives in the conditional `adversarial-review` reference; roles keep their bars |
| Writing routing and propagation | `writing-policy` | Select depth by artifact and defect; no universal overlay activation |
| Human-facing drafting | `writing-for-humans` | Reader needs, factual preservation, boundaries, finish pass, naming |
| Staging, cadence, and structure repair | `stop-slop` | Existing prose with staging, rhythm, or structure problems, including the crafted-line budget |
| Rewrite workflow, vocabulary, and presentation repair | `humanizer` | Rewriting existing prose or composing from a writer's notes or interview answers with a fact audit; vocabulary, register, attribution, hedge-placement, formatting, and chat-residue problems |
| Agent-facing instructions | `writing-for-agents` | Instruction structure and invocation, not a competing human-prose policy |
| Public PR/review writing | `pr-writing` | Artifact-specific content, source anchoring, and publication authority |
| Hive runtime layout, state ownership, read-only forensics, and Agent Hive configuration | `hive-config` | Self-contained reference for where `.hive/` state lives, which tool owns each change, read-only task/Git/session-store recipes, and `agent_hive.json`/override editing. It points to owners rather than restating them: managed context selection and mutation stay with `context-engineering`, background board protocol with `background-delegation`, and tool input/output contracts with the tool schemas and `docs/HIVE-TOOLS.md`. `skill-content.test.ts` pins its config keys, agent names, reserved IDs, tool names, and paths to source |

Planning, execution, concurrency, recovery, and managed context keep their established owners. New design guidance does not authorize clearing state, adopting live sessions, deleting public compatibility, bypassing checks, or promoting reviewer votes into acceptance.

## Host-specific wording

One canonical policy serves both OpenCode hosts. Only the host's own names differ, and they come from one `HostProfile` (`src/runtime/host-profile.ts`): the native subagent call (`task()` with `subagent_type` and `task_id` on v1, `subagent()` with `agent` and `sessionID` on v2), the native skill call (`skill({ name })` on v1; `skill({ id })` on v2, where `id` is the `<id>` of the available-skills catalog entry whose `<name>` is the skill's name, never assumed equal to it), the shell tool name, the Hive read transport, and whether background subagents are gated by an experiment variable. Agent prompts, command bodies and the system prompt are `render*(host)` functions; the exported `*_PROMPT` constants are their v1 renders. A new prompt sentence that names native syntax takes the profile slot, not a literal.

Packaged skills are rendered by the materializer (`src/skills/host-renderer.ts`) for the host that loads them. A sentence or example that differs between hosts is written twice, each wrapped in a section on its own marker lines:

```
<!-- hive-host opencode-v1 -->
...text for OpenCode v1...
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
...text for OpenCode v2...
<!-- /hive-host -->
```

- Both sections stay in the packaged source, so a skill discovered directly from the package is complete and has no placeholders. Materialization keeps the selected host's sections and removes the markers. An unknown host, a nested or unclosed section, or a stray closing marker fails materialization and names the file and line.
- Rendering runs on regular `.md` files in the staged copy before the cache identity is computed, so each host gets its own generated directory. Symbolic links are neither followed nor rewritten, non-Markdown files and imported `UPSTREAM`/`LICENSE` files are copied unchanged, and no cache directory is pruned.
- Markers stay outside code fences. A native-call example is written once per host as a complete fenced block under a plain "OpenCode v1:" or "OpenCode v2:" label, inside its own section, so a skill read straight from the package shows whole examples and no fence mixes two hosts' calls. Text that does not differ stays outside the sections.
- Raw v2 wording may depend on the read transport the system prompt names. A skill does not call a Code Mode read directly: it tells the agent to obtain the result through the transport first (code passed to `execute` with the exact path the catalog lists, or a direct call when reads are direct) and uses the result afterwards. The renderer has no transport dimension.
- Keep a section to the sentence, bullet or example whose syntax differs. Rules, strength and exceptions stay in shared text; a section that adds or drops a rule is a policy fork.
- Historical host-specific material, such as the OpenCode v1 database recipes in `hive-config`, is labelled with its version and never stands in for the public APIs another host provides.

## Disclosed references

A skill keeps its decision-changing rules, authority boundaries and stop conditions in `SKILL.md`. Worked examples, long procedures, ceilings and exceptional recovery sit in `references/` behind a read-when pointer in `SKILL.md`. The pointer is a relative link inside the skill directory; no pointer names an absolute or installed path, or a file outside the directory.

| Skill | Reference | What it discloses |
|---|---|---|
| `background-delegation` | `board-protocol.md` | Meaning of the `hive_background_status` fields, wait and reconcile steps, failed-reconcile hints, and the one observation and reconciliation example |
| `dispatching-parallel-agents` | `launch-examples.md` | Complete Forager launches, the ad-hoc placement check, diagnosis fan-out, and a worked assignment prompt |
| `parallel-exploration` | `research-examples.md` | Sample decompositions, Scout fan-out calls, and slice prompt templates |
| `executing-plans` | `task-milestones.md` | Two sections for two consumers: suggesting milestones (targets, companions, recommendation table, incremental counts, continuation prompts) and executing a requested milestone (fresh status, closure, resumption, stopping) |
| `writing-plans` | `verification-planning.md` | Gate records, evidence decisions and amendments, efficiency outcomes, recovery after a broad gate fails, certificates, and examples |
| `context-engineering` | `mutation-and-recovery.md` | Call shapes, frontmatter, hygiene thresholds and ceilings, and the operator recovery procedure |

- A reference adds method and examples, never authority. Reading one grants no tool or role access.
- The `SKILL.md` baseline holds when a reference is missing. A same-name user or native skill replaces the whole packaged directory: on v1 Hive leaves a detected conflict out of the materialized copy, and on v2 the copy can still hold the bundle while the effective skill catalog resolves the name to the unique user skill. A disabled skill is not materialized, and nothing falls back to an older generated copy. No caller searches generated skill caches for another copy.
- A command that runs under a non-Hive primary cannot assume the skill is present. `/approve-sync-plan` keeps approval, sync and readback authority, the persisted-outcome meanings, the scope and count meaning of a milestone, and the copyable continuation prompts. When `executing-plans` or its milestone reference is unavailable, it reports the persisted outcomes and withholds the projection. `/start-execution` dispatches no milestone work in that case and says why.
- Delivery of a reference is shown by an installed-package run on both hosts (a child reads each pointed reference under stock permissions, and a native `build` agent invoking `/start-execution` reads the milestone reference), not by the file existing in the source tree. The wiring run is credential-free; whether a model selects and follows a reference is a separate, qualitative question.
- Authority clarification: repair of context control files (`index.json`, the pending marker, manifests) is separately authorized operator recovery. `context-engineering` says so inline, and its recovery reference describes the operator procedure without granting an agent permission to run it. Tool behavior is unchanged: the tools never repair those files.
- The verification-planning method moved verbatim from `writing-plans`; its inline section keeps the gate, boundary, evidence and deferral rules. Imported passages stay in their `SKILL.md` files, so `dispatching-parallel-agents/UPSTREAM.md` and the pstack license are unchanged.

## Source-preserving maintenance

Imported skills carry source provenance, applicable license notices, and adaptation notes in their skill directories.

When editing an imported passage, distinguish source wording retained, host-mechanics adaptation, and deliberate policy changes. Keep applicability and exceptions with the rule. Preserve sharp instructional language such as "Execution order is not ownership" rather than routing it through prose cleanup.

Source wording and static tests establish what instructions are present. They do not establish how reliably a model follows them. The repository-only `packages/opencode-hive/evals/skill-integration.json` records representative behavior-review inputs and criteria; it is not included in the npm package. Record actual model/harness, candidate, inputs, and results when running them; the criteria themselves are not passing evidence.
