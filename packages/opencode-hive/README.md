# oc-arkive

[![npm version](https://img.shields.io/npm/v/oc-arkive)](https://www.npmjs.com/package/oc-arkive)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

OpenCode workflow plugin for plan-first feature development and ad-hoc work: feature plans, approval and task sync, Git worktrees, durable `.hive/` state, and review commands.

Version **5.0.0** is the first release that serves both OpenCode hosts from one package: the v1 entry, with a host floor of **1.18.30**, and a native v2 entry qualified on **2.0.26**. Releases through 4.2.0 are v1-only. The v2 qualification covers 2.0.26; it is not a support claim for later v2 releases.

Human onboarding starts in the [root README](../../README.md). This README is the detailed npm and configuration reference.

## Install

### OpenCode v1

For a brand-new config, add the plugin to `opencode.json` or `opencode.jsonc`. OpenCode resolves the npm package; you do not need a separate `npm install` on v1.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-arkive@latest"]
}
```

Pin `oc-arkive@5.0.0` instead of `@latest` when you want a fixed version. Restart OpenCode after changing plugins.

### Package dependencies

The package declares `@opencode/plugin` and `@opencode/client` (both pinned to `2.0.26`, the qualified v2 host release) and `@types/json-schema` as required dependencies, because its public type declarations import them. The plugin entry and the standalone reader at `oc-arkive/dist/v2/client.js` type-check after a plain install with `skipLibCheck` off. `effect` and `@opencode-ai/plugin` are peer dependencies: a v1 host resolves the package's one eager `effect` import from the peer, and a v2 host supplies its own copy. npm 7 and later installs these peers during an ordinary `npm install` unless peer installation is turned off, for example with `--legacy-peer-deps`.

### Existing OpenCode configurations

On v1, append `oc-arkive@latest` to an existing `plugin` array. Keep surrounding settings and existing entries. The v1 config hook intentionally mutates the fields below; v2 has the separate native-precedence contract in the next section.

Before upgrading, remove `disableMcps`, `sandbox`, `dockerImage`, and `persistentContainers` from `~/.config/opencode/agent_hive.json`. Strict validation rejects those removed keys. Earlier versions wrote `disableMcps` and `sandbox` when they created the file. While any of those keys remain, Hive ignores the whole global configuration, including agent model overrides and custom agents. In projects without `.hive/repositories.json` or a generated `workspace.json`, repository and worktree tools also fail with an invalid-config error that names the file but not the key.

The config hook intentionally mutates these OpenCode fields:

- `default_agent`: selects `hive-master` in unified mode or `architect-planner` in dedicated mode.
- `agent`: Shipped agent IDs are replaced; unrelated agent entries remain. Hive/task/question/skill permission overrides on native `general`/`explore`, plus `explore` edit overrides, are replaced with managed boundaries; warnings name the dropped keys and reason. In dedicated mode, the registered `hive-master` seat is hidden from the agent picker.
- `command`: Shipped command keys replace same-key user command definitions; unrelated command keys remain.
- `subagent_depth`: sets the OpenCode value to `2`.
- `skills.paths`: when Hive skills are materialized, registers the generated Hive skill path first, followed by resolved user-configured paths.
- `experimental.primary_tools`: preserves existing entries and adds `question` and the primary-only Hive operations in the [access matrix](docs/HIVE-TOOLS.md#agent-tool-access).

### OpenCode v2

The same package loads through its `server` entry on v1 and its synchronous `effect` entry on v2. On v2 it registers all **41 Hive tools** and **13 commands**, dedicated and unified modes, custom agents, packaged skills, native dispatch and background observation, and the forensic and recovery tools. Qualification ran against stock v1.18.30 and v2.0.26 with scripted model providers, which establishes wiring rather than real-model judgment. On both hosts it loaded a package already installed with plain npm; host-side registry resolution at first use was not part of it.

Install the released package with npm into a dedicated directory that the v2 host can read:

```bash
mkdir -p /absolute/install
cd /absolute/install
npm install oc-arkive@5.0.0
```

Point the v2 `plugins` entry at the absolute installed **dist directory**, `/absolute/install/node_modules/oc-arkive/dist`, which contains `index.js`; the tested local-directory loader needs that entry at the directory root. The host then uses the installed package without another cold registry resolution at first prompt. Preserve server logs if first use stalls before the `loading plugin` event; the cause of that stall is still unknown, and a green retry does not explain it.

#### Contributor build

To load a checkout instead of a release, run `bun install && bun run build` at the checkout root. Create the artifact directory before packing: in `packages/opencode-hive`, run `mkdir -p /absolute/artifact-directory && npm pack --pack-destination /absolute/artifact-directory`. The tarball name carries the package version from `packages/opencode-hive/package.json`, for example `oc-arkive-5.0.0.tgz`. In a clean installation directory, run `npm install /absolute/artifact-directory/oc-arkive-5.0.0.tgz`, then point the v2 entry at that installation's `node_modules/oc-arkive/dist` directory as above. A package-name file specifier such as `oc-arkive@file:/absolute/artifact-directory/oc-arkive-5.0.0.tgz` is also supported by the tested host loader, but resolves its dependencies into the host's cache on first use.

#### Upgrade on v2

Install the new version into the same directory (`npm install oc-arkive@<version>`), or install the new tarball, and then restart the long-lived host process that loaded the plugin. A restart reloads whatever the `plugins` entry points at, so restarting before the installed package changes keeps the old version running.

#### Options

The v2 entry takes options in the plugin list. The schema is [`schema/opencode-v2.options.schema.json`](schema/opencode-v2.options.schema.json):

```json
{
  "plugins": [
    { "package": "/absolute/install/node_modules/oc-arkive/dist", "options": { "readTransport": "direct", "server": { "url": "http://127.0.0.1:4096", "passwordEnv": "OPENCODE_SERVER_PASSWORD" } } }
  ],
  "experimental": { "subagent_depth": 2 }
}
```

- `readTransport`: `codemode` (default) runs `hive_repositories_status`, `hive_git_snapshot` and `hive_task_trace_content` inside Code Mode, which needs the `execute` tool. Every other Hive tool is a direct call. When an agent's permissions deny `execute`, Hive tells that agent its Code Mode reads are unavailable and logs a setup warning; it does not lift the denial. Set `direct` to make every Hive tool a direct call for configurations that deny `execute`.
- `server`: the URL of the running v2 server and the name of the environment variable holding its password, for the session-history reads the in-process plugin API lacks. The password itself never goes into configuration. Hive creates its client on first use, and every read is bracketed by a check that the server answers with this activation's own identity for this directory, so a result read across a server restart, reload or port takeover is discarded; it never guesses a port or starts a server. Deciding whether a session is the caller, its child or descendant, or an unrelated session also reads the caller from the server, and rereads it before accepting the answer. Unknown keys, inline secrets and URLs with credentials fail activation.

Start the server explicitly with `opencode2 serve --hostname 127.0.0.1 --port 4096` in the project, with `OPENCODE_SERVER_PASSWORD` in that server process's environment for the fragment above. `server.passwordEnv` selects the environment variable for Hive's reader and does not configure CLI authentication. If you choose a custom reader variable, the server also needs the same credential under `OPENCODE_PASSWORD` or legacy `OPENCODE_SERVER_PASSWORD` for native authentication. The connecting CLI process needs the same password in its own environment under `OPENCODE_PASSWORD` (or legacy `OPENCODE_SERVER_PASSWORD`); connect using `opencode2 run --server http://127.0.0.1:4096`. The executable name may differ in your installation. `server.username` defaults to `opencode`. Custom credential environment variables may be inherited by trusted shell/tool subprocesses; an environment reference prevents a literal secret in project config, not subprocess exposure or secret isolation.

The server option is also required to adopt an existing native direct child whose Hive binding is missing or has no parent, or change a continuation's route, constraints or agent: Hive checks native parent ancestry first and must verify native idle before native switching or prompt admission. Fresh dispatch and continuation of a proven-compatible parent-bound snapshot need no reader. Activation-local reservations precede awaited qualification and release on all exits. They do not provide an atomic fence against external same-child writers. A route is not immutable for the child's lifetime; qualified idle rebinding is supported. Operator-authorized continuation remains separate from these admission checks.

Hive keeps its state in the project checkout the host resolves for the session: a session opened in a subdirectory shares the checkout's `.hive` (manifest, constraints, features), and a session in a Hive task worktree maps back to the main checkout and its feature.

Hive does not rewrite v2 configuration. Its agent registrations are defaults: your v2 settings for the default agent, an agent's description, mode, hidden state, model and variant, step limits and permission rules take precedence. On v1 the config hook behavior above is unchanged. What v2 configuration cannot change:

- Each Hive role's instructions are added at request time to its ordinary turns and to its compaction and generate requests (the title request names no agent and is left alone). An agent you gave your own system prompt keeps it, followed by the Hive instructions. Hive adds no request options such as temperature; native and provider request settings stay as you configured them. Skill guidance follows the live catalog, including your configured sources. Auto-load guidance retains resolved catalog ids. For name-based requirements, the request's Hive Skill Name Lookup prefers a unique user skill over a bundled skill even when their folder ids differ. Multiple user entries with the same name are reported as ambiguous; configure or request an exact catalog id to select one. User content stays unchanged.
- Commands render against your agents as they are when you run them, so a disabled agent drops out of a council or review roster and your description, model and variant are the ones shown. A command bound to an agent switches the session to that agent and to its effective model and variant, as native configured commands do.
- Hive operations and native effects are checked when they run, from the agent's role (a built-in role name or a custom agent's base role) and the session's actual parent, never from its mode or description. A permission rule that allows a tool makes it visible but does not authorize a role to run a Hive operation it lacks, a primary-only operation in a child session, edits for read-only roles, delegation outside the role's targets, delegation to `hive-master`, `swarm-orchestrator` or `hive-builder` by any agent, or `question` in a child session. Native `general` and `explore` get no Hive tools. Hive roles cannot run the native `opencode_worktree_create`, `opencode_worktree_remove` or `opencode_session_move` tools, including from Code Mode. Agents Hive does not register keep native behavior, apart from the child-session limits.

v2 limits subagent nesting with `experimental.subagent_depth` (default 1). Set it to `2` so a delegated Architect can call its Scout, reviewer and Helper agents; Hive does not set it for you. On the tested v2 host, a top-level session uses the explicit CLI/session model or native configured model, rather than its agent's registered model. A fresh subagent of a Hive role or custom agent uses the agent's effective model/variant, then its parent's model, so a Hive role without a Hive model inherits like a native subagent; Hive refuses a `subagent()` `model` argument for those agents and, when the agent has a configured model, checks that a same-agent continuation's child is on it (a model-less agent inherits and is not checked; an explicit `model` still works for native `general`/`explore` and agents Hive does not register; see [Agent models](#agent-models)). An agent-bound command switches to its effective model/variant. Check actual requests rather than catalog fields. Scripted-provider qualification establishes wiring, not real-model judgment.

See [Switching OpenCode hosts and rollback](../../docs/OPERATOR-GUIDE.md#switching-opencode-hosts-and-rollback) for shared domain state and separate native observations.

### Research integrations

Configure research integrations and their permissions in OpenCode. oc-arkive does not install, register, configure, or alter them. Hive agents inspect the capabilities already exposed to their session, select the narrowest suitable interface from its description and schema, and report a missing capability when required evidence cannot be retrieved. They do not install tools or improvise shell or network substitutes.

Default mode is dedicated (`architect-planner` + `swarm-orchestrator`). Set `"agentMode": "unified"` to make `hive-master` the default agent; see [Agent mode](#agent-mode). Runtime settings live in `~/.config/opencode/agent_hive.json`, with a narrow project-local exception for existing agents' `model` and `variant` values in `.hive/agent-hive.override.json`.

## The Workflow

1. **Create feature** - planning flow or `hive_feature_create`; creation does not change the selected session route
2. **Write plan** - target one feature with explicit `hive_plan_write` / `hive_plan_patch` calls
3. **Human review** - comments and chat
4. **Approve + sync** - `hive_plan_approve({ expectedRevision, sync: true })` using the reviewed plan revision; inspect both outcomes
5. **Execute** - create the matching `hive_worktree_create` workspace with an explicit feature target, capture its initial destination identity, select when the route is unset/different or matching selection evidence is missing/uncertain under [Worktree](#worktree), then issue one ordinary native Forager call
6. **Integrate** - the primary verifies the committed source, passes its unchanged pin and inspected destination identity to `hive_worktree_merge`, and uses same-call cleanup when retention is not needed
7. **Record** - the primary calls `hive_task_update` for status, summary, blocker, or report; mark a task done only after integration succeeds
8. **Complete feature** - `hive_feature_complete` when done

Use the feature flow when work needs plan review, a task DAG, and a durable audit trail. Use ad-hoc orchestration for bounded non-feature work that should not create feature or task records. Hive Builder or unified `hive-master` loads `orchestrating-ad-hoc-work` before requests with multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, possible background execution, or an expected need for more than one worker attempt or turn. Parallel writers use distinct ad-hoc worktrees, but fixed-path fixtures, ports, databases, containers, generated outputs, and external mutable resources still require explicit ownership or sequencing. Ad-hoc Git work uses `hive_adhoc_worktree_create`, `hive_adhoc_worktree_inspect`, `hive_adhoc_worktree_merge`, and `hive_adhoc_worktree_cleanup`. `architect-planner` is planning-only. Operator-facing seats and loops are in the [Operator Guide](../../docs/OPERATOR-GUIDE.md).

### Operator Commands

`oc-arkive` registers these slash commands as operator entry prompts. They prepare the active agent with workflow-specific instructions; they do not replace Hive tools or make unavailable tools available to the current agent. Each command carries its own authority and stop rules, so it is safe when invoked with no arguments or under a primary that is not Hive. `/dash-review` and `/vuln-review` are exceptions: their generated OpenCode commands bind to separate private review primaries. `/implement` binds nothing and runs under the agent and model already selected.

| Command | Purpose |
|---------|---------|
| `/interview` | Clarify an idea toward shared understanding with a flexible endpoint and no fixed next step. |
| `/grill <context>` | Reach plan-ready alignment through researched facts and material questions, ready for `/hive-plan`. |
| `/implementation-brief` | Produce a copy-paste-ready brief for a later Hive plan. |
| `/hive-plan` | Create or update the Hive feature plan from a spec or brief. |
| `/approve-sync-plan` | Approve the active plan and sync executable tasks. |
| `/start-execution` | Start execution for an approved and synced plan. |
| `/implement [steering]` | Implement, as ad-hoc work, the scope this conversation agreed, plus any context or steering typed after the command. |
| `/council-directive` | Turn rough input into a reusable directive for a council run. |
| `/council` | Run a read-only council and synthesize a recommendation. |
| `/dash-review [intent]` | Review a folder, inline text, or the current checkout without changing source. |
| `/vuln-review [scope]` | Review requested source for evidenced vulnerabilities with configured specialists. |
| `/worklog [request]` | Explain where the current work stands from its Worklog, read-only. |
| `/compact-summary` | Produce a compact recovery summary for the current session. |

### Complexity skills

`complexity-review` and `complexity-audit` are packaged skills, not Hive plugin commands. Both are complexity-only passes that report findings and do not apply fixes. Ordinary tooling and delegation contracts apply.

- `complexity-review` reviews an explicit diff or bounded named scope, or current staged, unstaged, and relevant nonignored untracked changes when no scope is supplied. An empty review stops without becoming an audit.
- `complexity-audit` audits named roots or codebases, or the current worktree when no roots are supplied.

On either host, ask for the skill by name with the scope and any philosophy or preferences in ordinary prose, for example "Run complexity-review on the diff against main; prefer deleting code." On the v2 TUI you can also mention the skill directly, as in `@complexity-review <scope>` or `@complexity-audit <scope>`. OpenCode v2.0.26 does not register skills as slash commands, and slash invocation has not been verified on the v1.18.30 floor.

`/hive` has been removed. Feature creation now belongs to the planning flow and the Hive tools, usually `hive_feature_create` followed by explicitly targeted plan writes, review, per-feature approval and task sync, execution, and merge.

`/council` accepts `/council --group <group> <directive>`. If `--group` is omitted, Hive uses `council.defaultGroup`. Free-text tokens are directive text, not implicit group selectors.

Routing depends on `agentMode`:

| Command set | Unified mode | Dedicated mode |
|-------------|--------------|----------------|
| `/interview`, `/grill`, `/implementation-brief`, `/hive-plan`, `/council-directive`, `/council` | Use `hive-master`. | Route or delegate to `architect-planner`. |
| `/approve-sync-plan`, `/start-execution` | Use `hive-master`. | Route or delegate to `swarm-orchestrator`. |
| `/implement` | Runs under the selected agent and model; binds none. | Runs under the selected agent and model; binds none. |
| `/dash-review` | Bound by `config.command` to a private review primary. | Bound by `config.command` to a private review primary. |
| `/vuln-review` | Bound by `config.command` to a private vulnerability-review primary. | Bound by `config.command` to a private vulnerability-review primary. |
| `/compact-summary` | Use `hive-master`. | Route or delegate to `scout-researcher`. |
| `/worklog` | Runs under the active agent. | Runs under the active agent. |

Except for `/dash-review` and `/vuln-review`, dedicated-mode slash commands do not switch agents by themselves. If the active agent is not the route target, delegate or reroute to the target agent and stop if that is not possible.

Use `/grill <context>` when you want a confirmed, plan-ready brief (decisions with rationale, constraints, acceptance criteria) to hand to `/hive-plan`. Use `/interview <idea>` to clarify an idea with a flexible endpoint, including ad-hoc work, and no fixed next step or implementation-brief funnel. Both follow the `grilling` skill: the agent gets its bearings from existing context, explains what it found in plain terms and says where the evidence is uncertain, skips decisions you already made, and asks one material question at a time. Every option carries a short pro and con and a recommendation, and a confident recommendation still leaves a choice that is yours to make. Both run within one continuing invocation: when the `question` tool is available, each answer returns to the same run, which keeps researching, checking, and asking until you confirm alignment or stop it. Without that tool, each plain chat question waits for your reply and the next turn resumes the same loop. The commands do not automatically create a plan, implement, or start follow-on work; a bare confirmation is understanding only, and later action requires a separate operator request, unless you asked upfront for the next stage (for example, "then create a plan after alignment"), which then runs once within the agent's normal planning and approval limits. A named destination authorizes writing only the confirmed alignment brief there. Discoverable facts are researched without forced fan-out. Unavailable or failed research is disclosed as unresolved or an explicit assumption; it is never guessed.

Use `/implement [steering]` when a conversation has scoped work and you want it implemented as ad-hoc work. The command switches neither agent nor model, so the chat stays in place and the selected agent keeps its model, and it points that agent at the `starting-ad-hoc-implementation` skill. Select `hive-builder` first to have it run the work; an agent that cannot implement ad-hoc work, such as `architect-planner` or a plan-first primary, names that limit and stops, and choosing another agent is yours. Everything you type after `/implement` reaches the agent unchanged as further context and steering, so you can add requests in plain language, such as `/implement keep the public API unchanged and skip the docs for now`; with nothing after it, the conversation alone scopes the work. On OpenCode v1 as on v2, `$` sequences and `` !`...` `` spans in that text arrive as typed, and nothing in it runs as a shell command. Invoking the command authorizes implementing the agreed scope and your added instructions through the ad-hoc lifecycle. Loading the skill, earlier discussion, or a confirmation at the end of `/grill` or `/interview` does not. The agent rebuilds the latest agreed scope from the chat, reuses design decisions already settled there, investigates what it needs, and asks only about decisions that are yours, one at a time. When the scope is not ready it says what is unready, why it matters, and what to do next. It does not create a feature, plan, or task by itself, and work under an approved plan still starts with `/start-execution`. Running `/implement` again accounts for work already running or retained instead of starting a second writer on it.

Use `/dash-review` for one read-only Git, process/concept, or local-artifact review. It does not edit source, create Hive tasks, or start a fix. See [Reviews in the Operator Guide](../../docs/OPERATOR-GUIDE.md#reviews).

`/dash-review` is a read-only orchestrator over a folder, inline text, or the current checkout. An optional `hive_git_snapshot({ directory })` or operator-selected worktree covers foreign Git evidence. The primary understands the change and consumers before assigning evidence-linked questions to best-fit reviewers, honors required participation, and independently tries to disprove material candidates. Useful, authorized tests and source evidence determine whether findings survive; unresolved material gaps remain visible. When running the candidate would settle a question, the primary can send a Forager on a report-only runtime exercise within your authorization ([Runtime exercises](../../docs/OPERATOR-GUIDE.md#runtime-exercises)). It does not edit source, create Hive tasks, or start a fix; findings remain review context. Use `pr-writing` to draft grounded PR titles, descriptions, and review comments without posting them.

For an ad-hoc run, review the existing run or branch, then give a later fix instruction to the ad-hoc orchestrator. For a Hive feature run, review the task, feature, or branch, then give the active planner or orchestrator a later fix instruction.

On v1, background instructions appear only when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` has a truthy value (empty, `0`, `false`, and `no` keep the gate closed) and the bundled background protocol is available. On v2, native background support takes the place of that experiment variable. Use the [Background Orchestration](#background-orchestration) section and the `background-delegation` skill for the scheduler protocol. The `/dash-review` command template does not add background instructions, though its private primary has access to the background board tools when the gate is open ([command renderer](src/commands/renderers.ts), [runtime grants](src/runtime/role-policy.ts)).

### Vulnerability Review

Use `/vuln-review` with a source scope in ordinary language, for example `/vuln-review review the authentication boundary changed in this branch`. The private review primary accepts the requested checkout, folder, paths, inline evidence, or an optional Git snapshot through ordinary tools. For a foreign Git root, `hive_git_snapshot({ directory })` takes an absolute path to its exact Git top-level. A prior report can be compared when you supply it as readable input. See [Reviews in the Operator Guide](../../docs/OPERATOR-GUIDE.md#reviews).

The primary selects configured `vulnerability-reviewer` specialists by description and dispatches every explicitly requested configured specialist. It preserves the source fingerprint when it uses a Git snapshot. The report leads with deduplicated, severity-ordered findings backed by an attacker-to-impact path, confidence, affected locations, and root cause; it also states unresolved leads and coverage gaps. With no confirmed findings, it says "No confirmed vulnerabilities found in reviewed scope." A clean result applies only to the reviewed scope, not repository security ([reviewer contract](src/agents/vulnerability-reviewer.ts)).

External research may receive only public dependency names and versions or public advisory IDs such as CVE and GHSA IDs. Never send proprietary source, symbols, paths, configuration, logs, or stack traces to external tools ([reviewer contract](src/agents/vulnerability-reviewer.ts)). Findings stay in session history; the command writes no report file. The private primary has edit permission denied and does not begin remediation in the first response. A local reproduction of a lead runs only as a [runtime exercise](../../docs/OPERATOR-GUIDE.md#runtime-exercises) that your instructions cover, and the specialists stay non-executing ([runtime grants](src/runtime/role-policy.ts), [primary prompt](src/agents/vulnerability-review-primary.ts)).

### Planning-mode delegation

During planning, "don't execute" means "don't implement" (no code edits, no worktrees). Read-only exploration is explicitly allowed and encouraged, both via local tools and by delegating to a researcher.

When delegation is warranted, synthesize the task before handing it off: name the file paths or search target, state the expected result, and say what done looks like. Workers do not inherit planner context.

Each native subagent invocation (`task()` on v1, `subagent()` on v2) has one primary goal and one terminal report. Every returned result is terminal, including completed, failed, empty, partial, blocked, unsatisfactory, review-remediation, retry, new-test-evidence, and operator-decision results. Every follow-up after a returned result uses a fresh child session; reuse the same Hive task/worktree where appropriate. Review findings are fresh assignments in the same implementation lane. Compaction re-anchoring of a currently running worker is distinct from follow-up work. Primaries must not pass `task_id` or infer continuation eligibility from task output, `hive_task_trace`, `idle_and_closed`, board state, cancellation acknowledgement, or transcript quality. Pass `task_id` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation; otherwise launch fresh. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer. Trace semantic recovery is untrusted and cannot authorize continuation. A primary goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step. Give complete constraints and acceptance criteria only for that goal, then split independently verifiable outcomes into fresh launches. Returned IDs are also observe-only handles for status, reconciliation, cancellation, and runtime-visible session trace inspection. An orchestrator delegates plan creation or editing to `architect-planner`; Architect may call one layer of configured Scout, plan-reviewer, or approach-advisor helpers and `hive-helper`.

One implementation assignment normally maps to one numbered task. Amend the DAG or create an append-only manual task for a new independent deliverable. A blocked feature continuation follows `hive_task_update` with blocked status and blocker, the operator decision, then `hive_task_update` with an explicit status leaving blocked. Failed or retry work starts a new worker with a concise self-contained handoff. For ad-hoc work, use multiple fresh one-goal launches on worktrees whose registered identities do not intersect, or sequence writers that share a worktree. Architect is the only subagent allowed one terminal layer of read-only planning helpers; every other subagent is terminal. The `question` tool is reserved for primary sessions. Any subagent that needs operator clarification returns the exact question in its terminal response for the parent orchestrator to ask.

For execution work, treat worker output as evidence to inspect, not proof to trust blindly. OpenCode is the supported execution runtime; if you use `vscode-arkive`, treat it as a review/sidebar companion. Read changed files yourself and run the shared verification commands on the main branch before claiming the batch is complete.

When an operator explicitly requires a skill, include the exact name in the assignment or applicable standing constraints. Each child loads it independently before the covered work; a parent load does not count, and a later load does not satisfy the requirement. A named skill alone does not trigger a trace of a successful return. Audit skill loading only for an explicit operator audit request or a concrete concern about material noncompliance. See [Runtime Session Inspection](docs/HIVE-TOOLS.md#runtime-session-inspection-2-tools) for targeted tracing and audit evidence.

### Local skill and model use cases

- **Local skill experiments:** keep a skill in `<project>/.opencode/skills/<id>/SKILL.md` or `<project>/.claude/skills/<id>/SKILL.md`, then load it with OpenCode's native `skill` tool, reference it in agent instructions, or list its frontmatter `name` in `autoLoadSkills`. User file skills are discovered through OpenCode's native `.opencode`, `.claude`, `.agents`, `skills.paths`, and `skills.urls` mechanisms.
- **Runtime configuration:** set global agent models, variants, custom agents, `taskTraceSummarizer`, and skill auto-load settings in `~/.config/opencode/agent_hive.json`. A project may override only `model` and/or `variant` for matching built-in or effective custom-agent declarations in `.hive/agent-hive.override.json`. Global config remains authoritative for all other settings. See [Configuration](#configuration).

#### Canonical Delegation Threshold

- Route by the requested output rather than read-only status or whether paths are already known. Delegate bounded retrieval to a Scout when a real evidence gap makes delegation useful; keep causal diagnosis, correctness judgments, applicability, tradeoffs, and solution selection with the planner or orchestrator.
- Bounded direct reads remain acceptable whether or not the path was known before inspection. Delegate additional retrieval when it closes a named evidence gap.

## Tools

### Enforced agent access

The role authority below is the same on both hosts; the enforcement mechanism differs.

On v1, Hive registers ordered OpenCode `agent.permission` rules: `'hive_*': 'deny'` first, then each role's exact allows. Agent rules override global `{"*":"allow"}`. Custom variants inherit their base role. `experimental.primary_tools` adds child-session denials for integration/cleanup, ad-hoc creation, feature routing/completion, approval/sync/task creation, constraint mutation, context archive, parent-owned background tools, Worklog recording, and `question`. Worklog recording also checks the role and live parent in its executor.

On v2, your native permission rules decide which tools are visible, and Hive does not rewrite them. Every Hive executor and the native `execute.before` hook check the agent's base role and the session's actual parent before any effect, as described under [OpenCode v2](#opencode-v2). A visible tool can therefore still be refused.

On both hosts, Architect keeps feature creation, repository registration, and bounded planning-helper delegation as a child and hands primary-only requests back to its parent.

All Hive roles can read context, constraints, plans, status, repository scope, Git snapshots, and Worklogs. Scout adds repository discovery. Forager adds context write/append, feature/ad-hoc inspection, recovery traces, assigned feature-worktree creation, and its own report/handoff update. Helper's Hive tools are limited to state/worktree/trace inspection. Reviewers and advisors add authorized context write/append. Hive, Swarm, and Builder have the full Hive set; Architect has planning and primary-control tools; review primaries have metadata/context, inspection/trace, constraints, routing/background, and authorized ad-hoc review placement/cleanup. Hive grants Worklog recording to primary sessions of the full primaries, Architect, and the review primaries. An unmanaged agent that is neither a Hive role nor a custom variant of one keeps its native permission for Hive tools, so it can record from a primary session; its child sessions are refused, as are native `general`/`explore`. The [complete access matrix](docs/HIVE-TOOLS.md#agent-tool-access) names every grant and native boundary.

Native `general`/`explore` have no Hive tools, recursion, or questions. Helper/reviewer role-specific Hive-tool denials and native edit denial are enforced, while shell and research integrations remain available under operator permissions. Their inspection-only scope for shell and external effects is instruction-bound, an operator-accepted risk; these capabilities must not substitute for denied Hive operations. Use Helper first for session-trace retrieval; it returns evidence and mutation requests to the primary. Changes take effect after the OpenCode host reloads; on v1, use fresh child sessions so OpenCode applies the creation-time primary-tool denials.

When Architect is task-spawned, its one permitted terminal helper layer includes `hive-helper` and uses blocking calls, including same-message independent fan-out. Architect as primary or child routes multi-step trace/evidence questions to Helper and performs single direct spot-check reads itself. It returns board/control requests to the parent; child-role rules take precedence over an inherited background appendix without loading the primary-only `background-delegation` skill, and child board tools remain unavailable. Primaries issue independent Hive calls in one response/step and serialize dependent mutations or merges sharing a destination.

### Feature Management
| Tool | Description |
|------|-------------|
| `hive_feature_create` | Create a new feature without changing the selected session route |
| `hive_feature_complete` | Mark feature as complete |
| `hive_feature_select` | Set or clear the session route used for omitted feature-scoped calls and child dispatch |

### Repository Topology

| Tool | Description |
|------|-------------|
| `hive_repositories_status` | Inspect the active repository mode and manifest |
| `hive_repositories_discover` | Discover repositories in the project |
| `hive_repositories_update` | Add repositories to the project manifest |

### Planning
| Tool | Description |
|------|-------------|
| `hive_plan_write` | Write plan.md |
| `hive_plan_patch` | Apply revision-scoped section/task amendments to plan.md; does not sync tasks automatically |
| `hive_plan_read` | Read plan and comments |
| `hive_plan_approve` | Approve plan for execution |

### Tasks
| Tool | Description |
|------|-------------|
| `hive_tasks_sync` | Generate tasks from plan, or rewrite pending plan tasks with `refreshPending: true` after a plan amendment |
| `hive_task_create` | Create a manual task with explicit `dependsOn` and optional structured metadata |
| `hive_task_update` | Optional status (task status enum), summary, report, and successor handoff strings, and blocker object or null. Omissions are preserved |

### Worktree

| Tool | Description |
|------|-------------|
| `hive_worktree_create` | Create or select a feature-task Git workspace |
| `hive_worktree_inspect` | Inspect a feature-task workspace |
| `hive_worktree_merge` | Integrate an exact task source pin against the inspected destination identity, with merge/squash/rebase strategies, optional conflict preservation, and optional cleanup |
| `hive_worktree_cleanup` | Remove a feature-task worktree |

Git helpers do not change task status, auto-commit source, or assign workers. Before dispatching a writing lane, capture the initial inspection from create and record the intended destination's canonical path, full symbolic ref (or detached `null`), and commit. Reinspect after each writing handoff, before review or remediation, after known destination movement, and before integration. Pass the unchanged identity as `expectedTarget` for a legacy single-root workspace or the complete `expectedTargets` map for a composite. A legacy worker returns `sourceCommit`; a composite worker returns the complete `sourceCommits` map keyed by repository ID. A singleton composite can use a matching scalar pin at merge. The primary passes the worker's pin unchanged and uses same-call `cleanup: 'worktree+branch'` when retention is not needed.

Merge requires a clean source and a destination with a clean index and tracked working tree. Disjoint untracked or ignored destination files may remain when the pinned source contains the pinned target history; rebase also requires a linear replay range. Unsafe topology with local data returns `TARGET_RECONCILIATION_REQUIRED` with `reconcile_target` and requires same-worktree reconciliation with fresh pins. Ignored Hive state, dependencies, and build output count as local data even when Git reports a clean worktree. Incoming path collisions always block. Hive preflight and rechecks protect local data without relying on Git merge flags. Dirty, untracked, ignored, and unmerged data is protected; there is no force or rm fallback. Same-call squash cleanup may use observed identity; later ambiguous branches stay unless `discard: true` is explicit. Composite partial outcomes are not rolled back.

For a merge that creates a commit, supply `message` with a one-line subject, a blank line, and a descriptive body. Integration defaults to squash. Rebase does not take a non-blank `message`.

Pass the feature explicitly to `hive_worktree_create`. Before dispatch, call `hive_feature_select` only when the selected route is unset or differs from the dispatch target, or the selection evidence below is missing or uncertain. Reuse a matching selection across a same-feature batch only when this session's most recent route-changing call visible in context is `hive_feature_select` for that same feature, with no later explicit-null or other-feature selection. When that evidence is not visible (for example after compaction or a summary, at session start, or in mixed ad-hoc/feature batches), or you are uncertain, call `hive_feature_select` for the dispatch target. Explicit null suppresses fallback and stays featureless unless the dispatch intentionally targets a feature. Then issue the ordinary native Forager call. Blocking and background calls use the native task shape unchanged.

### Status

| Tool | Description |
|------|-------------|
| `hive_status` | Inspect feature, task, dependency, and worktree state |

When a task branch has no net tracked changes to integrate, `hive_worktree_merge` reports a successful no-op: `success: true`, `merged: false`, `reasonCode: 'NO_TRACKED_CHANGES'`, and no empty `sha`. Requested cleanup can still run when safe. Use `hive_status`, not the background board, to decide whether a task has completed work and a live worktree eligible for merge or cleanup.

### Ad-hoc Worktree

Use ad-hoc orchestration when you need delegation, verification, and a managed worktree without a feature, plan, or task record. Dedicated mode uses `hive-builder`; unified mode can use `hive-master`. The operator loop is in the [Operator Guide](../../docs/OPERATOR-GUIDE.md#ad-hoc-work).

| Tool | Description |
|------|-------------|
| `hive_adhoc_worktree_create` | Create a scoped ad-hoc Git workspace |
| `hive_adhoc_worktree_inspect` | Inspect the source and destination identities |
| `hive_adhoc_worktree_merge` | Integrate the pinned source against the inspected destination |
| `hive_adhoc_worktree_cleanup` | Remove the integrated workspace; `discard: true` explicitly retires unintegrated work |

The ad-hoc orchestrator resolves repository ownership with `hive_repositories_status` unless scope is already explicit, then calls `hive_adhoc_worktree_create` with the owned `repoIds` and a meaningful kebab-case `runId` before an ordinary native Forager call. These runs do not create feature/task records and do not appear in `hive_status`. The response supplies the `runId`, placement, and initial inspection. Record its destination identity before dispatch; later inspection checkpoints remain required. The primary integrates with `hive_adhoc_worktree_merge` using the unchanged inspected identity and returned source pin, with same-call cleanup when retention is not needed. Ad-hoc worktrees are temporary workspace metadata only. See [Hive Tools](docs/HIVE-TOOLS.md) for the full contracts.

Feature escalation is advisory. If the operator rejects it, continue ad-hoc only when material scope, contracts, and risks are otherwise resolved. Ask any remaining concrete blocking question before creating workers.

Forager is an execution role. Use a matching worktree for tracked Git writes; non-Git or report-only work follows the direct-work exceptions. Direct foreground OpenCode work is unmanaged OpenCode work, not a Hive worktree.

Native `general` is an ordinary delegation with ordinary tools only; it cannot delegate or ask questions. Native helpers retain bounded operational permissions.

### Background Orchestration

With the env gate unset on v1 (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`), Hive keeps normal blocking `task()` wait mode. Background board tools report `background_tools_disabled`, and no background appendix is injected into primary prompts. V2 provides native `subagent({ background: true, ... })` and the board without that experiment gate. The rest of this section applies with the env gate set on v1, and on v2 wherever the host supports native background subagents.

With the env gate set, board tools are active. Primary orchestrators receive background wait-mode guidance when `background-delegation` is available. This is the background-first scheduler contract; on v1 it exists only under the experimental gate. It does not add agents or change custom-agent preservation: primary agents still choose built-in or configured custom specialists by descriptor, not by a fixed routing table.

Gate-open orchestration uses lane kind to decide how much management is needed. Exploratory/read-only and review lanes are lightweight background candidates. Writing/change and execution lanes require state tracking, verification routing, unresolved-lane checks, integration control, and a context packet. Declared file ownership is tracking metadata, not a concurrency guarantee. See `docs/HIVE-TOOLS.md` and the `background-delegation` skill for the full scheduler protocol.

With the env gate set, primary agents can launch independent native background tasks when useful foreground work can continue, inspect the scoped board with `hive_background_status`, wait for OpenCode's native completion notification, refresh `hive_background_status`, reconcile terminal jobs with `hive_background_reconcile` or `hive_background_reconcile_batch`, and request cancellation with `hive_background_cancel`. Reconciliation archives terminal jobs and hides them from normal status output; agents should not edit either host's board file (`.hive/background-jobs.json` on v1, `.hive/runtime/opencode-v2/background-jobs.json` on v2) directly. Wait-only scheduler guidance from status means wait for the native notification instead of refreshing repeatedly.

`hive_background_status` returns board-local scheduler outputs such as `recommendedNextAction` and `requiresHiveStatusRefresh`. Reconciliation returns compact per-item acknowledgements with failure hints and a refresh flag when an archived job had feature/task scope; a batch requests refresh when any successful item does. Refresh `hive_status` when requested and before dependent task or merge decisions.

Prompt acknowledgment only means Hive showed a terminal result to the parent session. It does not clear `terminalUnreconciled`; the primary agent still reconciles or ignores the job after consuming the result.

Cancellation is not rollback. A cancellation request does not revert files, branches, worktrees, commits, or reports. Cancel is unavailable without a real native identity. Cancellation is owner-scoped; another primary must not automatically terminate another primary's child. Cancel acknowledgement is not proof of termination. Board rows without a native task ID stay on the board as observational bookkeeping; archive, reconcile, and ignore do not stop execution. The board observes the originating native parent and call. Stale and unknown observations stay visible. Multiple launch observations may exist for one native task identity when explicit runtime-owned interruption recovery is used. If completion lacks a call ID, record unknown and hint `hive_task_trace`.

On v2.0.26 native completion carries parent/child/outcome but no launching call ID. Every matching observation, including a singleton, stays `unknown`/uncertain with the native outcome diagnostic. Inspect it, then use the exact canonical alias with `decision: "ignored"`; terminal reconciliation is refused. Same-process plugin reload makes old observations uncertain; a process restart marks them stale. The board never authorizes dispatch, replacement writers or continuation.

### Runtime Session Inspection

Primary orchestrators can inspect any explicitly identified native OpenCode session visible to the connected runtime with `hive_task_trace`, including self, direct children, foreign-parent sessions, and parentless primaries. Omitted or false `recovery` returns a paged forensic v3 index: surviving non-reasoning events in source order with bounded excerpts, assignment and final self-report context, and coverage limits. For later pages pass the entire `coverage.next_cursor` string unchanged as `cursor`. Pass an event's `events[n].ref` as `event` to `hive_task_trace_content` to read that tool's input, output, and error together under a full integrity guard, then continue an oversized field in UTF-8-safe chunks with `field` and `offset`. `hive_task_trace({ task_id, recovery: true })` requests an untrusted semantic handoff whose content IDs `hive_task_trace_content` also reads. A finished turn recovers with `closed_turn` scope. An idle runtime whose tool or message records stay open, as after a host restart, recovers only an `evidence_only` snapshot that stays non-terminal and inspect-only. Self, active, and other uncertain targets cannot recover, and non-direct-child recovery is always inspect-only. Status and source come from the target session's own directory; a missing target entry in a valid status map means idle because OpenCode removes idle entries, while unavailable or invalid maps and a missing directory are uncertain and make zero model calls. Native call rows (`task` on v1, `subagent` on v2) show a confirmed `child_session_id` only when the stored call recorded the child's ID; on v2 a foreground call that never returned may lack it, and a missing ID does not show that the child stopped. The background board lists a foreground call only after OpenCode v2 moved it to the background. Recovery output never authorizes acceptance, merge, retry, resume, or automatic execution. See [Hive Tools](docs/HIVE-TOOLS.md) for the full contract.

### Managed Context

`hive_context_read`, `hive_context_write`, `hive_context_append`, `hive_context_edit`, and `hive_context_archive` manage project (`.hive/context/`) or feature (`.hive/features/<name>/context/`) knowledge. Feature is the default scope; pass `scope: "project"` for project knowledge. Read the summary or search the catalog by name, `description`, and `read_when`, then read a named file in chunks. Before replacing, editing, appending, or selectively archiving, read its revision and content hash and pass `expectedRevision` and `expectedContentHash` (or `expectedContentHashes` for archive). A whole-document replacement needs every chunk; `hive_context_edit` replaces one exact passage and needs only the chunks that show it and enough surrounding text. Only primary agents can archive. The `hive_context_read` catalog lists durable files; evidence files remain available through named reads ([context service](../hive-core/src/services/contextService.ts)). See [Hive Tools](docs/HIVE-TOOLS.md) for the read and mutation contracts.

### Operator Constraints

`hive_constraints_read`, `hive_constraints_add`, `hive_constraints_edit`, and `hive_constraints_clear` manage durable operator directives. Scope defaults to the current session; pass `scope: "feature"` for a feature directive. Read the current register before editing or clearing; `hive_constraints_edit` takes the constraint `id` and register `expectedRevision`, while `hive_constraints_clear` takes `expectedRevision` ([runtime tools](src/runtime/hive-tools.ts)). Only primary agents can mutate constraints. The selected feature route, session constraints, and feature constraints travel with native child dispatch.

### Worklog

`hive_worklog_list`, `hive_worklog_read`, and `hive_worklog_record` keep a short account of where work stands: a current briefing you can read in about thirty seconds and append-only checkpoints. A feature has one log that every primary shares, and ad-hoc work uses the session's own log. Primaries read it when they start or resume work and record a checkpoint at meaningful milestones such as a direction change, a blocker, a merge or verified result, a handoff, and the conclusion. Workers and reviewers read it. Without an explicit `ref`, reads use the selected feature or the session's own log, never a detected or sole live feature. Use `/worklog [request]` to have the active agent read a log back and explain it; that command does not record. To stop primaries from recording, add a standing constraint. See [Hive Tools](docs/HIVE-TOOLS.md#worklog-3-tools) and the [service contract](../../docs/WORKLOG.md).

### Git Snapshot

`hive_git_snapshot` captures a validated `hive-git-snapshot/v1` envelope for a selected Git range or paths. Its optional absolute `directory` must be an exact foreign Git top-level without a Hive manifest and cannot be combined with `repositoryIds` ([runtime tool](src/runtime/hive-tools.ts)). In a manifest-backed project, omit `directory` and select repositories with `repositoryIds` when needed. Check the returned status and failure records before using the snapshot as review evidence.

### Troubleshooting

#### Repeated blocked-continuation errors / loop

If you see repeated retries around blocked continuation, use this protocol. Blocked continuation follows `hive_task_update` with blocked status and blocker, the operator decision, then `hive_task_update` with an explicit status leaving blocked:

1. Call `hive_status()` first.
2. If the worker blocks, `hive_task_update` with blocked status and blocker, record the operator decision, then `hive_task_update` with an explicit status leaving blocked.

Do not loop blocked updates on non-blocked statuses; re-check `hive_status()`.

#### Using with DCP plugin

When using Dynamic Context Pruning (DCP), use a Hive-safe config in `~/.config/opencode/dcp.jsonc`:

- `manualMode.enabled: true`
- `manualMode.automaticStrategies: false`
- `turnProtection.enabled: true` with `turnProtection.turns: 12`
- `tools.settings.nudgeEnabled: false`
- protect key tools in `tools.settings.protectedTools` (at least: `hive_status`, `hive_worktree_create`, `hive_worktree_merge`, `hive_task_update`, `question`)
- disable aggressive auto strategies:
  - `strategies.deduplication.enabled: false`
  - `strategies.supersedeWrites.enabled: false`
  - `strategies.purgeErrors.enabled: false`

For normal v1 usage, set the OpenCode plugin entry to `"oc-arkive@latest"` or a pinned version. Keep a local file path entry only for contributor testing with a checkout. V2 setup is under [OpenCode v2](#opencode-v2).

### Task worker recovery

After session compaction, use `hive_context_read` to search current catalogs and read the named files you need. Do not replay historical prompt text as a new assignment. Plugin restart does not continue old live workers; finish or abandon them first, then send a new message so the runtime observes the agent again.

Moving a project root does not continue old task or ad-hoc work. At the new root, create a valid worktree if needed and launch fresh. Old sessions and artifacts remain historical.

Manual tasks created with `hive_task_create()` follow the same DAG model as plan-backed tasks. The `goal`, `description`, `acceptanceCriteria`, `files`, and `references` fields are recorded in the task's `spec.md`. The primary's `task()` prompt must carry what the worker needs. To change downstream sequencing or scope after review feedback, update `plan.md` and run `hive_tasks_sync({ refreshPending: true })`.

`hive-helper` is a runtime-only read-only investigator for feature and ad-hoc work. Send it one named question and known identities for trace investigation, interrupted-worker evidence packets, destination-drift relevance checks, or Hive runtime-state clarification. It returns cited observations, attributed self-reports, hypotheses, and limits; trace answers cite exact event refs. Interrupted-worker packets include retained placement/registration, observed source HEAD, destination identity, dirty/untracked state, and existing report/handoff paths. Drift answers compare changed paths and shared contracts, with explicit comparison gaps. When investigation needs Hive layout/config/forensics facts, it loads `hive-config` first.

Primaries perform single direct reads themselves: one `hive_status`, one worktree inspect, or one `hive_task_trace_content` spot-check of a known event ref. For multi-step forensics (paging a trace, drift comparison, or interrupted-worker evidence packets), send the named question to Helper. The primary spot-checks decisive cited refs before acting and owns acceptance, merge, cleanup, retry, continuation, termination, task creation, and status. A Helper-discovered HEAD is observed, never a verified pin, and semantic recovery remains untrusted. Helper has no mutation or delegation authority. Bash stays available for inspection only; no repository, worktree, branch, file, process, container, or Hive-state mutation is allowed. Use `git --no-optional-locks status`; plain `git status` can refresh/write the index and take `index.lock`. Do not run `git fetch`, `git pull`, `git remote update`, or any remote-ref update, or any build, test, or verification workload in a worktree whose writer is live or uncertain. When a Hive tool fails, Helper reports it instead of reproducing it through raw Git or another capability. Its Hive inspection tools and native edit denial are enforced; shell/external inspection-only scope is instruction-bound. It is not a selectable custom base agent.

`simplicity-reviewer` is a built-in read-only reviewer for final post-implementation cleanup and a supported `customAgents` base for specialized cleanup passes. It reviews completed diffs for YAGNI, dead code, duplication, unnecessary abstractions, redundant defensive code, and safe deletion-biased simplification.

## Task Prompts & Observability

For an explicitly selected feature, a Forager assignment whose first non-empty line is `Hive task: <task-folder>` for an existing task receives a bounded path-only Hive task brief after the route snapshot. It points to the current spec and plan section, direct dependencies' successor handoffs, and the durable feature-context catalog; workers read those records as needed. Eligible unbound dispatches receive a notice; fallback and explicit-null routes get neither brief nor notice, and other roles get no brief. No context documents, catalog bodies, or completed-task summaries are injected. Agents can search durable-file catalogs and read named files with `hive_context_read`; evidence files remain readable by name. `taskService` does not include completed-task summaries in `spec.md` ([task service](../hive-core/src/services/taskService.ts)).

### Observability

`hive_worktree_create` and `hive_worktree_inspect` return workspace path, branch, and commit facts. They do not return a generated native-task payload.

### Native Task Prompts

The primary authors the native Forager prompt. At dispatch, Hive appends a route-snapshot footer with `projectRoot`, the selected feature route, session constraints, and feature constraints; it does not attach a context catalog ([runtime hook](src/runtime.ts)).

A blocked continuation waits for an explicit status leaving blocked. The operator decision belongs in the primary-authored native prompt.

## Plan Format

```markdown
# Feature Name

## Overview
What we're building and why.

## Tasks

### 1. Change an owned behavior
Description of the task and its scope.

**Verify**:
- Required before merge: `[exact command]` -> [expected signal]
- Integrated-only deferral: [named behavior or consumer]

### 2. Another Task
Description.

## Final Verification

- [Integrated acceptance group] — owner: [suite/team]; prerequisite: [integrated candidate]; run: `[exact command]`; signal: [expected result]
```

`hive_tasks_sync` reads numbered task headings from `## Tasks` in modern plans. A final verification section stays outside the task DAG unless the verification itself needs tracked artifacts produced by a task.

Keep approved repository and operator checks binding. A required early or pre-merge check stays in the task's `Verify`; every integrated-only deferral named by a task must have a matching final-verification entry with an owner, prerequisite, exact command, and expected signal. Final acceptance records unique integrated proof. The same suite can appear in both places when it proves a different candidate or boundary.

For example, a shared DTO task can verify the DTO owner suite before merge and defer a named CLI consumer check to integrated acceptance. A schema feasibility check required before merge stays in the task even if it is expensive. When a task fails, keep its output, verify the owning regression, and rerun affected consumers and integrated checks; an unexplained green retry does not resolve the failure.

## Configuration

Hive reads runtime configuration from `~/.config/opencode/agent_hive.json` on both hosts. `~` is the `HOME` environment variable (or `USERPROFILE` when `HOME` is unset); `XDG_CONFIG_HOME` does not move this file. The v2 entry's own `readTransport` and `server` options live in its `plugins` entry instead, as shown under [OpenCode v2](#opencode-v2). The only project-local override file is `.hive/agent-hive.override.json`; it accepts only `model` and `variant` under `agents` and `customAgents`, and affects matching agents already present in the effective global/default configuration. Unknown names are ignored and never create agents. Project-local `.hive/agent-hive.json` and `.opencode/agent_hive.json` files remain ignored. Hive uses defaults when the global config is missing, unreadable, invalid JSON, or rejected by runtime validation. That validation rejects unknown top-level keys (including removed `disableMcps`) and wrong types for known fields, but does not enforce every restriction in the published schema: unknown keys inside `agents` declarations and some malformed `customAgents` entries do not invalidate the whole file ([config service](../hive-core/src/services/configService.ts), [schema](schema/agent_hive.schema.json)). A structurally invalid project override (unsupported key, non-string value, invalid JSON) is ignored with a runtime warning. Model settings are the exception to falling back: an invalid effective `model` or `variant`, including a blank string in a project entry that matches an agent, stops the plugin with an error, as described under [Agent models](#agent-models). Restart OpenCode after changing either config file.

Global config remains authoritative for runtime policy, agent definitions, and auto-load skill settings. See [`agent_hive.override.schema.json`](schema/agent_hive.override.schema.json) for the project override shape.

The global schema also accepts `enableToolsFor` (default `[]`), but the current runtime does not use it to grant tools; tool access comes from agent permissions. `repositoryRoot` and `repositories` are migration-only fields for legacy topology. New repository declarations go in the project manifest managed through `hive_repositories_update`.

For example, to change the model for one project without changing the global agent roster, put this in `<project>/.hive/agent-hive.override.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.override.schema.json",
  "agents": {
    "forager-worker": { "model": "anthropic/claude-sonnet-4-20250514", "variant": "high" }
  }
}
```

`hook_cadence` currently has no runtime effect: no production hook invokes the cadence gate. The schema remains the machine-readable reference for this field.

### Agent mode

`agentMode` selects how planning and orchestration seats are registered. Default is `"dedicated"`.

| Value | Default agent | Primary seats | When to use |
|-------|---------------|---------------|-------------|
| `dedicated` | `architect-planner` | Separate `architect-planner` and `swarm-orchestrator` | Default; split planning and execution across two primary seats |
| `unified` | `hive-master` | `hive-master`, `architect-planner`, and `swarm-orchestrator` | `hive-master` is the default for planning and orchestration |

In both modes:

- `architect-planner` and `swarm-orchestrator` stay registered. Researchers, workers, reviewers, `hive-helper`, and `hive-builder` remain available. `hive-master` is hidden in dedicated mode ([runtime registration](src/runtime.ts)).
- Slash-command routing follows the [Operator Commands](#operator-commands) table.
- Custom derived subagents attach to the active planner/orchestrator prompts for that mode.

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "agentMode": "unified"
}
```

Dedicated mode does not auto-switch the live chat agent when you run a slash command. If the active agent is not the route target, delegate or reroute to that target and stop if that is not possible. `/dash-review` and `/vuln-review` always bind to private review primaries regardless of mode.

### Task trace summarizer

`taskTraceSummarizer` configures the **hidden, parentless, tool-less** model used when an agent with trace access calls `hive_task_trace({ task_id, recovery: true })`. It does **not** change forensic (non-recovery) traces, which stay deterministic and model-free.

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `model` | no | The invoking caller session's native model | Explicit `provider/model-id` |
| `variant` | no | With no `model`: the caller's native variant. With `model`: that model's default | Requires `model`. Must match a key under `opencode.json` `provider.<provider>.models.<model>.variants` |

Behavior:

- Recovery interpretation is always marked untrusted (`provenance: 'summarizer_interpretation'`).
- Each recovery binds one model selection when it starts: the configured `model` (with `variant` when set), or, with no `model`, the model and variant the session that called `hive_task_trace` is running on. The model metadata and every summarizer request of that recovery use it, and `recovery.model.requested` reports it with its `source` (`configured` or `caller`). If the caller's selection cannot be read, recovery is reported unavailable rather than run on a guessed model. Hive sets no sampling options on these requests. Each request carries its own stage output contract (a strict JSON Schema plus the rules it cannot express); replies are validated against the same schema.
- `recovery.model.observed` reports the provider, model, and variant the host says it ran. A configured variant that provider metadata shows the model does not offer is not sent; recovery returns deterministic partial fallback and does not claim it was applied. If metadata cannot be read, the variant is still sent and `observed` shows what ran.
- A provider error, an unusable reply, or a request that exceeds the model's input budget produces deterministic partial fallback without provider retry or model fallback. Each affected failure entry may carry up to four `diagnostics`: finite codes, a schema path and step number, the provider error name and HTTP status, finish reason, and reply size. Diagnostics never include provider messages, response bodies, source text, or model text.
- Only the bare JSON object, or that object inside one enclosing code fence, is accepted. Prose around it is a failure, and nothing is extracted or repaired.
- Recovery never authorizes accept, merge, retry, resume, or auto-run. Native `task_id` pass-through requires explicit operator or runtime-owned interruption-recovery authorization; after every returned result, follow-up work uses a fresh child session and may reuse the same Hive task/worktree.
- See [Runtime Session Inspection](docs/HIVE-TOOLS.md#runtime-session-inspection-2-tools) for the full trace/recovery contract.

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "taskTraceSummarizer": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "variant": "high"
  }
}
```

### Council config

Council settings live in `~/.config/opencode/agent_hive.json`.

Built-in council defaults are read-only and portable:

| Group | Purpose | Default members |
|-------|---------|-----------------|
| `design` | Architecture and implementation-shape advice. | `scout-researcher`, `approach-advisor`, `plan-reviewer`, `code-reviewer` |
| `decision` | Hard tradeoff decision support. | `scout-researcher`, `approach-advisor`, `plan-reviewer` |
| `minimal-change` | Smallest correct change and cleanup lens. | `scout-researcher`, `simplicity-reviewer`, `code-reviewer` |
| `documents` | Documentation and prose-oriented review. | `scout-researcher`, `code-reviewer`, `plan-reviewer` |

The default `excludedAgents` list excludes orchestration, implementation, and runtime-investigation seats: `hive-master`, `swarm-orchestrator`, `forager-worker`, `hive-builder`, and `hive-helper`. Member names can be built-in stock agents or configured custom agents. Custom agents derived from mutable bases, including `forager-worker`, are skipped by default with warnings.

Partial global overrides merge with the built-in defaults. Declaring a group replaces that group declaration and leaves omitted default groups intact:

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "council": {
    "defaultGroup": "documents",
    "maxMembers": 3,
    "excludedAgents": ["simplicity-reviewer"],
    "groups": {
      "documents": {
        "description": "Docs and operator prose review",
        "members": ["scout-researcher", "code-reviewer", "plan-reviewer"],
        "maxMembers": 2
      },
      "security": {
        "description": "Security-sensitive review",
        "members": ["scout-researcher", "reviewer-security", "code-reviewer"]
      }
    }
  }
}
```

Council resolution preserves configured order, deduplicates by first occurrence, filters unusable seats before applying the cap, and uses `group.maxMembers ?? council.maxMembers ?? 4`. It skips unavailable agents, explicitly excluded agents, starter template custom agents, mutable-base agents, and duplicates with warnings. If a requested group has no usable seats, `/council` falls back to `council.defaultGroup`; if the fallback also has no usable seats, the command stops with an error instead of running an unsafe council.

### Project-local repository manifest

Optional Hive-managed project state for multi-repo topology. Single-repository projects need no manifest. Do not hand-author this file for normal onboarding; ask Hive to inspect, discover, and update topology with `hive_repositories_status`, `hive_repositories_discover`, and `hive_repositories_update`.

Generated/managed shape (for inspection) at `<project>/.hive/repositories.json`:

```json
{
  "schemaVersion": 1,
  "repositories": [
    { "id": "api", "path": "./api" }
  ]
}
```

### Global-only: Disable Skills

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "disableSkills": ["brainstorming", "writing-plans"]
}
```

#### Available Skills

| ID | Description |
|----|-------------|
| `adversarial-review` | Explicit adversarial / red-team / multi-pass review posture |
| `agents-md-mastery` | Bootstrap, review, or prune AGENTS.md by placing rules next to the code they govern |
| `background-delegation` | Env-gated background wait-mode and board protocol |
| `brainstorming` | Explore intent and design before implementation |
| `code-design-principles` | Conditional depth for state, types, boundaries, shared writers, retries, and internal migration |
| `complexity-audit` | Read-only complexity audit of named roots or the current worktree |
| `complexity-review` | Read-only complexity review of an explicit diff or bounded scope |
| `context-engineering` | Select, retrieve, and update managed context with revision and hash checks |
| `dispatching-parallel-agents` | Coordinate independent subagent work |
| `executing-plans` | Execute an approved plan with review checkpoints |
| `grilling` | Orient on supplied context, explain what is found, and question it until material decisions and evidence are aligned |
| `hive-config` | Hive runtime layout, state-tool ownership, read-only session forensics, and Agent Hive configuration reference |
| `how` | Explain current source-grounded behavior and subsystem flow |
| `humanizer` | Rewrite existing prose without changing its facts or commitments, interview the writer or work from their notes, audit your own draft, and repair vocabulary, register, attribution, and formatting |
| `orchestrating-ad-hoc-work` | Coordinate qualifying ad-hoc work for Hive Builder or unified Hive |
| `parallel-exploration` | Researcher fan-out for read-only research |
| `pr-writing` | Draft PR titles, descriptions, and general or inline review comments |
| `project-verification` | Set up, audit, or maintain a project's durable verification guidance, harness, or formal checks when that is the requested work |
| `starting-ad-hoc-implementation` | Turn a scoped conversation into authorized ad-hoc implementation when the operator asks to implement it |
| `stop-design-slop` | Visual foundation for interfaces: composition from the product's task, diagnostics for generic patterns, and refinement that preserves an existing identity |
| `stop-slop` | Repair staging, formulaic cadence, and structure in existing prose |
| `systematic-debugging` | Root-cause investigation before fixes |
| `test-driven-development` | Strict red-green-refactor when TDD is the selected testing strategy |
| `unslop` | Shared philosophy and router for writing, messaging, and visual work; every Hive role is asked to load it, and it selects depth skills and carries the delegation contract |
| `verification` | Select checks from the candidate repository's own guidance, read their results, and require applicable command/tool evidence before completion or verification claims |
| `why` | Investigate explicitly requested historical rationale with calibrated source evidence |
| `writing-for-agents` | Reference for authoring documents agents consume: skills, subagent prompts, instructions, and pointer architecture |
| `writing-for-humans` | Draft substantial reader-centered prose and apply the non-invention finish pass |
| `writing-plans` | Turn requirements into an implementation plan |

### Per-Agent Skills

Skills are loaded through OpenCode's native `skill` tool, not through a Hive plugin tool. Hive bundles are materialized into the global OpenCode config directory under `agent-hive/generated/opencode-skills/<hash>/` at startup and registered via `opencodeConfig.skills.paths` ahead of any user-configured paths.

**Configuration fields:**

| Field | Behavior |
|-------|----------|
| `skills` | Legacy field kept for config compatibility. Native skill visibility is controlled by OpenCode registration and `disableSkills`, not by per-agent allowlists. |
| `autoLoadSkills` | Adds high-priority prompt guidance telling the agent to load named OpenCode-native skills with the `skill` tool before work covered by them. |
| `disableSkills` (global) | Disables Hive bundled materialization and Hive bundled autoload only. User or native skills with the same name are not blocked. |

**User file skills** should be configured through OpenCode's native `.opencode`, `.claude`, `.agents`, `skills.paths`, or `skills.urls` discovery. They can be loaded manually with the native `skill` tool or advertised to an agent by adding the skill's frontmatter `name` to `autoLoadSkills`. Native/user skills take precedence over Hive bundled skills with the same name.

The writing and visual family is maintained in oc-arkive. `unslop` is the shared philosophy and router, and every Hive role is asked to load it (see [Default auto-load skills](#per-agent-skills) below). It selects the depth skills by case: `writing-for-humans` owns drafting and the finish pass, `stop-slop` owns staging/cadence/structure repair, `humanizer` owns the rewrite workflow for existing prose (rewrite, interview, and notes modes, a focused audit of an agent's own draft, a fact audit, and an optional `check.py` sweep) plus vocabulary/register/attribution/formatting repair, and `stop-design-slop` carries the visual foundation. Depth skills load only on their triggers. `pr-writing` retains its artifact and publication contract, and `writing-for-agents` retains instruction-authoring ownership.

`writing-policy` no longer ships and has no alias: `unslop` replaced it. A personal copy at `~/.agents/skills/writing-policy/` is outside the package, is not migrated or removed, and nothing in oc-arkive loads it now; references to `writing-policy` in your own instructions, constraints, or agent configuration find only that personal copy, if you keep one. A personal `stop-design-slop` skill (for example `~/.agents/skills/stop-design-slop/`) is a same-name native skill, so it takes precedence over the bundled `stop-design-slop` until you remove it. Moving to the bundled foundation is a separate step that the operator takes by hand; oc-arkive migrates nothing automatically.

`code-design-principles` deepens the existing Engineering Judgment block at material design decisions without another workflow or finding bar. `how` and `why` serve explicit explanation and historical-rationale requests; ordinary debugging, future design selection, and routine implementation orientation retain their existing owners.

See [Skill ownership](docs/SKILL-OWNERSHIP.md) for the responsibility map and source-preserving maintenance guidance.

**URL-scan conservative behavior:** If configured `skills.urls` cannot be scanned for conflicts (invalid response, network error), Hive skips bundled skill materialization and Hive bundled autoload guidance for that run and logs a warning rather than risking a native conflict. Local native skills discovered before the URL failure can still be advertised in guidance; partially scanned URL skills are not advertised.

`background-delegation` is bundled and materialized like other Hive skills, but primary prompt references are gated and compact. Delegation-first orchestration lives in the base primary prompts; when the v1 env flag is set, or on v2 with native background support, primary agent prompts add background wait-mode and board protocol guidance and point to the skill for the full protocol. The skill can still be loaded manually with OpenCode's native `skill` tool like any other bundled or user skill.

`orchestrating-ad-hoc-work` is loaded conditionally by Hive Builder or unified `hive-master` when a request has multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, possible background execution, or an expected need for more than one worker attempt or turn. It is not a default `autoLoadSkills` entry and may retain one coherent lane after decomposition. `starting-ad-hoc-implementation` precedes it when the operator asks Hive Builder to implement scoped work: it rebuilds the agreed scope and settles what must be decided first, then hands the scope to this lifecycle. Content tests establish bundling and routing only; they do not establish first-attempt model reliability.

**Example:**

```json
{
  "agents": {
    "hive-master": {
      "autoLoadSkills": ["brainstorming"]
    }
  }
}
```

`autoLoadSkills` resolves names through OpenCode-native skill discovery first, then through eligible Hive bundled skills. The identity is the `name` field in `SKILL.md` frontmatter, not the containing directory name. Disabled Hive skills, Hive skills shadowed by native/user skills, and URL-unsafe Hive skills are skipped. Unknown names emit a warning. Startup continues without failure.

**How `skills` and `autoLoadSkills` interact:**

- `skills` is a legacy field kept for config compatibility. In the native skill slice, skill visibility is controlled by OpenCode's native `skills.paths` registration and `disableSkills`, not by per-agent `skills` allowlists.
- `autoLoadSkills` adds a compact system-prompt directive to load OpenCode-discovered native skills or eligible Hive bundled skills with `skill({ name: "..." })` before matching work; it does not preload full skill bodies
- These are **independent**: a skill can be advertised for native loading even if it is not in the agent's legacy `skills` list
- User `autoLoadSkills` are **merged** with defaults. Global `disableSkills` suppresses only Hive-bundled skill materialization and bundled auto-load guidance; a native/user skill with the same name can still be advertised.

**Default auto-load skills by agent:**

| Agent | autoLoadSkills default |
|-------|------------------------|
| `hive-master` | `parallel-exploration` |
| `forager-worker` | `verification` |
| `hive-builder` | `verification`, `parallel-exploration` |
| `hive-helper` | `hive-config` (fixed; operator `autoLoadSkills` is ignored, `disableSkills` removes it) |
| `scout-researcher` | (none) |
| `architect-planner` | `parallel-exploration` |
| `swarm-orchestrator` | `parallel-exploration` |
| `plan-reviewer` | (none) |
| `code-reviewer` | (none) |
| `simplicity-reviewer` | (none) |
| `approach-advisor` | (none) |
| `vulnerability-reviewer` | (none) |

Every role in this table, `dash-reviewer`, `vulnerability-review-primary`, and every custom agent are also asked to load `unslop` first. It is added when guidance is composed rather than listed in `autoLoadSkills`, so it does not appear in the table, listing it adds nothing, and a custom agent does not repeat it. `disableSkills: ["unslop"]` removes the bundled skill from materialization and guidance without a warning per role; a native or user skill named `unslop` takes precedence, as for any name. The guidance asks the agent to load the skill before covered work and does not preload or enforce it; the skill's own routing then decides which depth skills a case needs.

`background-delegation` is not a default `autoLoadSkills` entry for any agent. For ad-hoc orchestration, delegation-first guidance is in the base prompt; the v1 env flag (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`), or native background support on v2, only appends background wait-mode and board guidance without adding it to the default autoload set.

### Per-Agent Model Variants

You can set a `variant` for each Hive agent to control model reasoning/effort level. Variants are keys that map to model-specific option overrides defined in your `opencode.json`.

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "agents": {
    "hive-master": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "variant": "high"
    },
    "forager-worker": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "variant": "medium"
    },
    "scout-researcher": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "variant": "low"
    }
  }
}
```

A `variant` needs an explicit Hive `model` for the same agent; see [Agent models](#agent-models). The `variant` value must match a key in your OpenCode config at `provider.<provider>.models.<model>.variants`. For example, with Anthropic models you might configure thinking budgets:

```json
// opencode.json
{
  "provider": {
    "anthropic": {
      "models": {
        "claude-sonnet-4-20250514": {
          "variants": {
            "low": { "thinking": { "budget_tokens": 5000 } },
            "medium": { "thinking": { "budget_tokens": 10000 } },
            "high": { "thinking": { "budget_tokens": 25000 } }
          }
        }
      }
    }
  }
}
```

**Precedence:** A variant already chosen for the prompt, by the caller or by OpenCode from the agent's own settings, wins. On v1, Hive fills a missing variant only when the message runs the agent's own Hive model; a message on another model keeps that model's native variant, and an unknown variant key is a no-op. On v2 the variant is part of the registered model reference: a native model setting for the agent replaces the whole reference, and the host rejects a variant the model does not offer.

### Custom Derived Subagents

Define plugin-only custom subagents with `customAgents`. Freshly initialized `agent_hive.json` files already include starter template entries under `customAgents`; those seeded `*-example-template` entries are placeholders only, should be renamed or deleted before real use, and are intentionally worded so planners/orchestrators are unlikely to select them as configured. Each custom agent must declare:

- `baseAgent`: one of `scout-researcher`, `forager-worker`, `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor`, or `vulnerability-reviewer`
- `description`: required non-whitespace delegation guidance injected into eligible primary planner/orchestrator prompts

Custom subagents are scoped routing specialists, not model-upgrade switches. Primary agents choose them autonomously when their description is a closer match for the requested output, task domain, workflow, artifact type, or concrete review/approach risk. They keep the built-in base agent when no configured description is a closer fit. A custom description specializes routing within the inherited base role; it cannot expand that role or override its prompt, tool, or permission boundaries. Candidate-specific conditions in an individual description still apply, including a condition that the candidate may be selected only when the operator explicitly names it. Importance, size, generic complexity, quality sensitivity, and a stronger model are not routing reasons. At runtime, custom agent entries with reserved names, IDs containing native permission wildcard characters (`*` or `?`), non-object declarations, unsupported `baseAgent` values, or missing, blank, or whitespace-only `description` values are skipped with warnings.

The same seven built-in bases allow an optional routing-description override under the existing `agents` map. Nonblank values are trimmed before publication. Omitted, blank, or whitespace-only values inherit the canonical default without dropping unrelated settings on that built-in. Putting `description` on a non-customizable built-in invalidates the stored global config. At runtime, Agent Hive rejects the entire stored config and falls back to defaults, so unrelated stored settings are ignored until the config is corrected. The runtime skip behavior above does not promise a per-entry fallback for arbitrary schema-invalid optional fields. Custom agents never inherit a base description; every custom entry must supply its own non-whitespace description.

| Configurable base | Canonical default description |
|-------------------|-------------------------------|
| `scout-researcher` | Retrieves bounded internal or external code, context, and data evidence without owning diagnosis, tradeoffs, or solution selection. |
| `forager-worker` | Implements and verifies delegated work in its assigned workspace; diagnosis-only assignments remain report-only. |
| `plan-reviewer` | Default for ordinary plan review covering worker readiness, references, dependencies, and executable verification. |
| `code-reviewer` | Default for ordinary implementation review covering correctness, tests, risk, scope creep, YAGNI, and dead code. |
| `simplicity-reviewer` | Default for ordinary post-implementation simplicity review covering unnecessary abstractions, duplication, dead code, and safe deletion. |
| `approach-advisor` | Default for ordinary read-only approach advice on technical direction, architecture, debugging, and tradeoffs. |
| `vulnerability-reviewer` | Default for application-security review focused on evidenced attacker-to-impact paths and root-cause triage. |

Primary orchestrators, `hive-builder`, `hive-helper`, `architect-planner`, private `__hive_*` identities, and generated review lanes do not expose description overrides.

`hive-helper` is not a custom base agent. Its runtime-only investigation role covers both feature and ad-hoc work; primaries own integration, cleanup, and follow-up task creation.

`simplicity-reviewer` is a custom base agent for specialized cleanup passes. Primary agents still use the built-in `simplicity-reviewer` when no configured simplicity-reviewer-derived custom description is a closer match.

`vulnerability-reviewer` is a custom base agent for selectable `/vuln-review` specialist lenses. It preserves the configured description, model and variant and inherits restricted Hive permissions and native edit denial. Its shell/external review-only scope is instruction-bound. Configured reviewer descriptions guide selection.

Published example (validated by `src/e2e/custom-agent-docs-example.test.ts`):

```json
{
  "agents": {
    "scout-researcher": {
      "model": "github-copilot/gpt-5.2-codex",
      "variant": "low"
    },
    "forager-worker": {
      "description": "Default for ordinary backend implementation.",
      "model": "github-copilot/gpt-5.2-codex",
      "variant": "medium"
    },
    "code-reviewer": {
      "model": "github-copilot/gpt-5.2-codex"
    }
  },
  "customAgents": {
    "scout-docs": {
      "baseAgent": "scout-researcher",
      "description": "Use for research centered on documentation, release notes, READMEs, or external docs synthesis."
    },
    "forager-ui": {
      "baseAgent": "forager-worker",
      "description": "Use for UI implementation tasks touching React/Next components, styling, accessibility, or browser-visible behavior.",
      "model": "anthropic/claude-sonnet-4-20250514",
      "variant": "high"
    },
    "reviewer-security": {
      "baseAgent": "code-reviewer",
      "description": "Use for review passes focused on auth, permissions, secret handling, injection risk, or other security-sensitive changes."
    }
  }
}
```

Inheritance rules when a custom agent field is omitted:

| Field | Inheritance behavior |
|-------|----------------------|
| `model` | Inherits the resolved base agent's Hive model (including `agents` settings and the base's project override). With none, the custom agent uses the native OpenCode model |
| `variant` | Inherits the resolved base agent's Hive variant; a variant needs a Hive model from the custom agent or its base |
| `autoLoadSkills` | Merges with base agent auto-load defaults/overrides and de-duplicates (including the universal `unslop`). `disableSkills` only suppresses Hive bundled guidance/materialization, not native/user skills with the same name. |

ID guardrails:

- `customAgents` keys cannot reuse built-in Hive agent IDs
- native `general`/`explore` and review primaries `dash-reviewer`/`vulnerability-review-primary` are reserved; rename a colliding custom reviewer (for example to `reviewer-dashboard`) while retaining its supported base
- custom agent IDs cannot contain native permission wildcard characters (`*` or `?`)
- plugin-reserved aliases are blocked (`hive`, `architect`, `swarm`, `scout`, `forager`, `hygienic`, `hygienic-reviewer`, `receiver`)
- operational IDs are blocked (`build`, `builder`, `plan`, `code`)

Compaction classification follows the base agent:

- `scout-researcher` derivatives are treated as `subagent`
- `forager-worker` derivatives are treated as `task-worker`
- `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor`, and `vulnerability-reviewer` derivatives are treated as `subagent`

This ensures custom workers recover with the same execution constraints as their base role.

### Agent models

Hive ships no model for any role. A built-in role, custom agent or recovery summarizer with neither `model` nor `variant` in `~/.config/opencode/agent_hive.json` uses OpenCode's own model selection, so Hive runs on whichever providers you have connected.

- **Native inheritance.** On v1, a role without a Hive model gets no `model` in its agent entry, so OpenCode uses the model chosen for the prompt or session, or your configured default, and a child task uses its parent's model and variant. On v2, a primary session uses the session model or the host default, a fresh subagent of a Hive role or custom agent uses the agent's effective model, then its parent's model (a continued child keeps its model unless the call switches its agent), and an agent-bound command uses the agent's effective native model. Hive never pins an unconfigured role at startup or request time.
- **Explicit choices.** Set `model` (`provider/model-id`) to pin a role, optionally with a `variant`. A variant needs an explicit Hive model on the same effective declaration: the role's global entry, its project override, or, for a custom agent, its Hive base role. An OpenCode agent, session or default model never completes it. If it is incomplete, or a supplied `model` or `variant` is blank or malformed, the plugin stops at startup with an error that names the file, the property path and the fix (set the model, or remove the variant), without echoing values.
- **Project overrides and global writes.** A project override can complete a global fragment: a project `model` for a global `variant`, or the reverse. When Hive itself writes the global file (first-run creation on v1, or a settings update), it checks that file on its own, so the stored global configuration never depends on one project.
- **Custom agents.** An omitted custom `model` or `variant` inherits the base role's Hive value, including the base's project override. A native OpenCode override of the base agent is not copied into the custom agent.
- **Native precedence.** On v2, your native settings for an agent still win over a valid Hive model and replace the whole model reference, including its variant. On v1, Hive's entries replace native entries with the same agent ID.
- **Subagent model control (v2).** A `subagent()` call that sets `model` for a built-in Hive role or a custom agent is refused before the host runs it, whichever agent calls and whatever the value, including the configured model itself or a `#variant`; no child, binding or board row is created, and the call succeeds when repeated without `model`. A continuation (`sessionID`) on the child's current agent must find the child on that agent's effective model and variant, as the host's agent entry reports it with your native settings applied; a missing variant means the model's default variant. Otherwise Hive refuses it with the expected and actual model, and a fresh call without `sessionID` runs on the configured model. If the agent entry cannot be read, the continuation is refused. A continuation that switches the child to another agent takes that agent's configured model from the host and, like any agent change, needs an idle child; the agent change is judged from the host's session agent as well as the Hive binding. A managed agent with no configured model is not pinned: a fresh child inherits its parent's model and a resumed child keeps the model it had. Native `general`/`explore` and agents Hive does not register accept `model` as the host defines it. This covers the dispatch argument only: configuration files, agent-bound commands, and session APIs or UI that change a session's model directly are outside it.
- **Stored models.** Releases before this one wrote a generated model for every role into the global file. Hive keeps every stored model as written, because a generated value and a deliberate choice look the same. To move a role to native inheritance, delete its `model` and `variant` together.
- **Temperature.** Hive no longer sets sampling. A `temperature` left in `agents`, `customAgents` or `taskTraceSummarizer` is ignored with one warning per read, the rest of the file still applies, and the next Hive write omits it. Each model's native defaults and your provider, model or variant settings apply.

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "agents": {
    "hive-master": { "model": "anthropic/claude-sonnet-4-20250514" },
    "forager-worker": { "model": "anthropic/claude-sonnet-4-20250514", "variant": "high" }
  }
}
```

#### Opt-in preset: OpenCode Go DeepSeek V4.1 Flash

[OpenCode Go](https://opencode.ai/en/docs/go) is a separate paid OpenCode subscription with its own API key, connected with `/connect`. If you subscribe, you can pin Hive roles to its DeepSeek V4.1 Flash model with an ordinary `agents` block in `~/.config/opencode/agent_hive.json`. Keep the roles you want and drop the rest; a dropped role inherits your native model.

```json
{
  "agents": {
    "hive-master": { "model": "opencode-go/deepseek-v4.1-flash" },
    "architect-planner": { "model": "opencode-go/deepseek-v4.1-flash" },
    "swarm-orchestrator": { "model": "opencode-go/deepseek-v4.1-flash" },
    "hive-builder": { "model": "opencode-go/deepseek-v4.1-flash" },
    "scout-researcher": { "model": "opencode-go/deepseek-v4.1-flash" },
    "forager-worker": { "model": "opencode-go/deepseek-v4.1-flash" },
    "hive-helper": { "model": "opencode-go/deepseek-v4.1-flash" },
    "plan-reviewer": { "model": "opencode-go/deepseek-v4.1-flash" },
    "code-reviewer": { "model": "opencode-go/deepseek-v4.1-flash" },
    "simplicity-reviewer": { "model": "opencode-go/deepseek-v4.1-flash" },
    "approach-advisor": { "model": "opencode-go/deepseek-v4.1-flash" },
    "vulnerability-reviewer": { "model": "opencode-go/deepseek-v4.1-flash" }
  }
}
```

The preset sets no `variant`. Hive does not check that your account can use the model or that the model is currently offered, and makes no claim about its quality or reliability for Hive work; run `/models` to confirm it is listed. Merge the block into your existing `agents` entries rather than replacing other settings. Hive never adds this preset to defaults or generated files.

## Focused references

- [Hive Tools](docs/HIVE-TOOLS.md) for tool inventory and contracts
- [Data Model](docs/DATA-MODEL.md) for `.hive/` state and task records
- [Operator Guide](../../docs/OPERATOR-GUIDE.md) for public agents and the feature / ad-hoc / dash-review / vuln-review loops
- [Design](../../docs/DESIGN.md) for architecture and source-of-truth rules

## Pair with VS Code

For the full OpenCode-first workflow, install `vscode-arkive.vsix` from the GitHub Release as an optional review/sidebar companion for inline comments and document review.

## License

`oc-arkive` is released under the [MIT License](LICENSE). Skills imported from other projects keep their upstream licenses, listed in the `LICENSE*` and `UPSTREAM.md` files inside each skill directory.
