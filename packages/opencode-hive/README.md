# oc-arkive

[![npm version](https://img.shields.io/npm/v/oc-arkive)](https://www.npmjs.com/package/oc-arkive)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

OpenCode workflow plugin for plan-first feature development and ad-hoc work: feature plans, approval and task sync, Git worktrees, durable `.hive/` state, and review commands.

Version **5.0.0** is the first release that serves both OpenCode hosts from one package: the v1 entry, with a host floor of **1.18.30**, and a native v2 entry. Version **6.0.0** qualifies the v2 entry on **2.3.2** and does not support 2.0.26; the current source qualifies it on **2.4.1**. The 5.0.0 through 5.3.0 releases were qualified on **2.0.26**, and 5.3.0 does not activate on 2.3.2. Releases through 4.2.0 are v1-only. The v2 qualification covers 2.4.1; it is not a support claim for other v2 releases.

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

Pin `oc-arkive@6.0.0` instead of `@latest` when you want a fixed version. Restart OpenCode after changing plugins.

### Package dependencies

The package declares `@opencode/plugin` and `@opencode/client` (both pinned to `2.4.1`, the qualified v2 host release) and `@types/json-schema` as required dependencies, because its public type declarations import them. The plugin entry and the standalone reader at `oc-arkive/dist/v2/client.js` type-check after a plain install with `skipLibCheck` off. `effect` and `@opencode-ai/plugin` are peer dependencies: a v1 host resolves the package's one eager `effect` import from the peer, and a v2 host supplies its own copy. npm 7 and later installs these peers during an ordinary `npm install` unless peer installation is turned off, for example with `--legacy-peer-deps`.

### Existing OpenCode configurations

On v1, append `oc-arkive@latest` to an existing `plugin` array. Keep surrounding settings and existing entries. The v1 config hook intentionally mutates the fields below; v2 has the separate native-precedence contract in the next section.

Before upgrading, remove `disableMcps`, `sandbox`, `dockerImage`, and `persistentContainers` from `~/.config/opencode/agent_hive.json`. Strict validation rejects those removed keys. Earlier versions wrote `disableMcps` and `sandbox` when they created the file. While any of those keys remain, Hive ignores the whole global configuration, including agent model overrides and custom agents. When repository topology is read from the global file, unrelated invalid or unknown settings do not block it. Malformed JSON, a non-object root, or an invalid `repositoryRoot`/`repositories` pair still causes an error.

The config hook intentionally mutates these OpenCode fields:

- `default_agent`: selects `hive-master` in unified mode or `architect-planner` in dedicated mode.
- `agent`: Shipped agent IDs are replaced; unrelated agent entries remain. For an agent Hive registers with mode `subagent`, `disable: true` from your configuration is kept; on `architect-planner` and the primaries, Hive's registration still overwrites it. Hive/task/question/skill permission overrides on native `general`/`explore`, plus `explore` edit overrides, are replaced with managed boundaries; warnings name the dropped keys and reason. In dedicated mode, the registered `hive-master` seat is hidden from the agent picker.
- `command`: Shipped command keys replace same-key user command definitions; unrelated command keys remain.
- `subagent_depth`: sets the OpenCode value to `2`.
- `skills.paths`: when Hive skills are materialized, registers the generated Hive skill path first, followed by resolved user-configured paths.
- `experimental.primary_tools`: preserves existing entries and adds `question` and the primary-only Hive operations in the [access matrix](docs/HIVE-TOOLS.md#agent-tool-access).

### OpenCode v2

The same package loads through its `server` entry on v1 and its synchronous `effect` entry on v2. On v2 it registers every Hive tool and all **18 commands**, dedicated and unified modes, custom agents, packaged skills, native dispatch with live child status and cancellation, and the forensic and recovery tools. The 6.0.0 qualification ran against stock v1.18.30 and v2.3.2 with scripted model providers, which establishes wiring rather than real-model judgment. On both hosts it loaded a package already installed with plain npm; host-side registry resolution at first use was not part of it.

The current plugin manifest declares 50 Hive tools and 18 commands on both hosts. On the installed hosts, the 6.0.0 qualification checked registration, schemas and v2 Code Mode discovery of the 50 tools, the listing of the 17 commands that release had, selected context and repository operations, the `/start-execution` command, and model and skill wiring. It does not exercise every tool and command at runtime. `/sharpen` and the `sharpening` skill were added after 6.0.0 and have not yet run installed-host qualification.

Install the released package with npm into a dedicated directory that the v2 host can read:

```bash
mkdir -p /absolute/install
cd /absolute/install
npm install oc-arkive@6.0.0
```

`oc-arkive@6.0.0` is qualified on v2 2.3.2. The 5.x releases are qualified on v2 2.0.26, and 5.3.0 does not activate on 2.3.2, so a v2 host that stays on 2.0.26 keeps `oc-arkive@5.3.0`.

Point the v2 `plugins` entry at the absolute installed **dist directory**, `/absolute/install/node_modules/oc-arkive/dist`, which contains `index.js`; the tested local-directory loader needs that entry at the directory root. The host then uses the installed package without another cold registry resolution at first prompt. Preserve server logs if first use stalls before the `loading plugin` event; the cause of that stall is still unknown, and a green retry does not explain it.

#### Contributor build

To load a checkout instead of a release, run `bun install && bun run build` at the checkout root. Create the artifact directory before packing: in `packages/opencode-hive`, run `mkdir -p /absolute/artifact-directory && npm pack --pack-destination /absolute/artifact-directory`. The tarball name carries the package version from `packages/opencode-hive/package.json`, for example `oc-arkive-6.0.0.tgz`; that tarball is this checkout, which can differ from the published version of the same number. In a clean installation directory, run `npm install /absolute/artifact-directory/oc-arkive-6.0.0.tgz`, then point the v2 entry at that installation's `node_modules/oc-arkive/dist` directory as above. A package-name file specifier such as `oc-arkive@file:/absolute/artifact-directory/oc-arkive-<version>.tgz` worked with the v2.0.26 host loader, which resolved its dependencies into the host's cache on first use. It has not been checked on 2.3.2 or 2.4.1.

#### Upgrade on v2

Install the new version into the same directory (`npm install oc-arkive@<version>`), or install the new tarball, and then restart the long-lived host process that loaded the plugin. A restart reloads whatever the `plugins` entry points at, so restarting before the installed package changes keeps the old version running. When the host still runs 2.0.26, keep a copy of its native home before the first 2.3.2 start, because 2.3.2 migrates the native database in a way 2.0.26 cannot read back ([Switching OpenCode hosts and rollback](../../docs/OPERATOR-GUIDE.md#switching-opencode-hosts-and-rollback)).

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

- `readTransport`: `codemode` (default) runs `hive_repositories_status`, `hive_repositories_discover`, `hive_git_snapshot`, `hive_task_trace_content`, `hive_worklog_list`, `hive_worklog_read`, `hive_checkouts_list`, `hive_checkout_brief` and `hive_explore_read` inside Code Mode, which needs the `execute` tool. They share the Code Mode namespace `hive` and keep their `hive_*` tool IDs, so code calls `hive_checkout_brief` as `tools.hive.checkout_brief`. Every other Hive tool is a direct call. When a Hive role agent's permissions deny `execute`, Hive tells that agent which of its granted reads are unavailable and logs a setup warning; it does not lift the denial. Other agents get no such notice. Set `direct` to make every Hive tool a direct call for configurations that deny `execute`.
- `server`: the URL of the running v2 server and the name of the environment variable holding its password, for the session-history reads the in-process plugin API lacks. The password itself never goes into configuration. Hive creates its client on first use, and every read is bracketed by a check that the server answers with this activation's own identity for this directory, so a result read across a server restart, reload or port takeover is discarded; it never guesses a port or starts a server. Deciding whether a session is the caller, its child or descendant, or an unrelated session also reads the caller from the server, and rereads it before accepting the answer. Unknown keys, inline secrets and URLs with credentials fail activation. Omit `server` to use the managed local service described below.

Without `server`, Hive's reader uses the managed local service when that service is the OpenCode process that loaded the plugin, as with `opencode serve --service`. Activation and fresh dispatch connect to nothing. The first reader operation (a history read, or the settlement read of a `sessionID` continuation) reads the service registration file to make a binding, and so does each later attempt after a refused registration or a failed identity check; a healthy binding is reused, and a failed call is not retried. The file is the official client's default path (`@opencode/client/service` `fallback()`, which is `$XDG_STATE_HOME/opencode/service.json` or `~/.local/state/opencode/service.json`), fixed from the plugin process's environment when the plugin activates, and it must be a regular file of at most 64 KiB. Hive accepts the registration only when it names this process's PID and a numeric loopback `http`/`https` URL (127.0.0.0/8 or `[::1]`) without credentials, path, query or fragment; it then authenticates with the official `headers` for that endpoint and refuses HTTP redirects, so the managed path needs no password variable or other configuration. A missing, foreign or malformed registration reports `not_configured` without its contents and is never sent a request. A failure of the managed service keeps its error code, such as `unauthorized` or `wrong_instance`, but its diagnosis is fixed text that never repeats the service or the client. Hive never probes, starts, replaces or stops the service, and it reads only that default file name, so a build that registers under another channel's file name is not found. The same PID only admits a candidate: every read still passes the identity checks above. A plugin in any other OpenCode process, such as a separately started `opencode2 serve`, needs the `server` option. When `server` is set, Hive reads only that server; a missing password variable or rejected credentials fail and never fall back to the managed service.

When you choose the `server` option, start the server explicitly with `opencode2 serve --hostname 127.0.0.1 --port 4096` in the project, with `OPENCODE_SERVER_PASSWORD` in that server process's environment for the fragment above. `server.passwordEnv` selects the environment variable for Hive's reader and does not configure CLI authentication. If you choose a custom reader variable, the server also needs the same credential under `OPENCODE_PASSWORD` or legacy `OPENCODE_SERVER_PASSWORD` for native authentication. The connecting CLI process needs the same password in its own environment under `OPENCODE_PASSWORD` (or legacy `OPENCODE_SERVER_PASSWORD`); connect using `opencode2 run --server http://127.0.0.1:4096`. The executable name may differ in your installation. `server.username` defaults to `opencode`. Custom credential environment variables may be inherited by trusted shell/tool subprocesses; an environment reference prevents a literal secret in project config, not subprocess exposure or secret isolation.

A working reader, through `server` or the managed service, is also required for every continuation with `sessionID`, including adopting an existing native direct child whose Hive binding is missing or has no parent. Hive checks native parent ancestry first. On 2.4.1 the host joins a follow-up to a child's current run, so before native switching or prompt admission Hive reads, through the server, whether the child has settled: any job the host still lists for the child or its descendants (a listed job is either running or holds a report not yet delivered), then every session under the child from the session list, then those sessions' queued inbox items, then their active executions. Hive refuses the continuation while any of them shows work, or when one cannot be read. It reads them again when the host reports the child's progress, after any permission prompt and just before the host prompts the child, together with the agent, model and binding checks. While a permission prompt waits, another client (or an unmanaged call's `model`) can still change the child. Fresh dispatch needs no reader. An activation-local reservation, one call per child, comes before these reads and is released on every exit. Neither the reservation nor the reads are atomic with the host, so they do not fence off another client that starts work for the same child. A continuation keeps the child's bound project, feature, agent and task or run; it can adopt only a dimension the binding lacks, and it takes the parent's current standing constraints. Operator-authorized continuation remains separate from these admission checks.

Hive keeps its state in the project checkout the host resolves for the session: a session opened in a subdirectory shares the checkout's `.hive` (manifest, constraints, features), and a session in a Hive task worktree maps back to the main checkout and its feature.

Hive does not rewrite v2 configuration. Its agent registrations are defaults: your v2 settings for the default agent, an agent's description, mode, hidden state, model and variant, step limits and permission rules take precedence. On v1 the config hook behavior above is unchanged. What v2 configuration cannot change:

- Each Hive role's instructions are added at request time to its ordinary turns and to its compaction and generate requests (the title request names no agent and is left alone). An agent you gave your own system prompt keeps it, followed by the Hive instructions. Hive adds no request options such as temperature; native and provider request settings stay as you configured them. Skill guidance follows the live catalog, including your configured sources. Auto-load guidance retains resolved catalog ids. For name-based requirements, the request's Hive Skill Name Lookup prefers a unique user skill over a bundled skill even when their folder ids differ. Multiple user entries with the same name are reported as ambiguous; configure or request an exact catalog id to select one. User content stays unchanged.
- Commands render against your agents as they are when you run them, so a disabled agent drops out of a review roster and your description, model and variant are the ones shown. `hive_councils_list` checks council seats against the host's agent list each time it is called, so a disabled agent also drops out of a council. A command bound to an agent switches the session to that agent and to its effective model and variant, as native configured commands do.
- Hive operations and native effects are checked when they run, from the agent's role (a built-in role name or a custom agent's base role) and the session's actual parent, never from its mode or description. A permission rule that allows a tool makes it visible but does not authorize a role to run a Hive operation it lacks, a primary-only operation in a child session, edits for read-only roles, delegation outside the role's targets, delegation to `hive-master`, `swarm-orchestrator` or `hive-builder` by any agent, or `question` in a child session. Native `general` and `explore` get no Hive tools. Hive roles cannot run the native `opencode_worktree_create`, `opencode_worktree_remove` or `opencode_session_move` tools, including from Code Mode or by a dotted Code Mode name such as `opencode.session.move` called at top level. With full Code Mode, v2.4.1 also offers `opencode_session_interrupt`, which stops any session other than the caller and its ancestors without Hive's checks on who owns it; Hive roles, native `general` and `explore`, and every child session cannot run it, and `hive_background_cancel` covers a direct child. Unless automations are turned off, v2.4.1 also offers `automation_create`, `automation_resume`, `automation_pause` and `automation_delete`. An armed automation later prompts a session or starts a subagent outside Hive's dispatch checks, and pausing or deleting one changes your project's schedule, so these four are yours: Hive roles, native `general` and `explore`, and every child session cannot run them, under either name, while listing automations stays native. Hive registers the same tools as default permission denies, so they are hidden as well as refused. A top-level agent Hive does not register keeps native automation and session-interrupt authority, and automations that already exist are yours to manage; Hive does not inspect or stop them. The guard reads tool names and the subagent call's `agent`, not the code a tool runs, so it bounds these tools and is not a sandbox. Agents Hive does not register keep native behavior, apart from the child-session limits.

v2 limits subagent nesting with `experimental.subagent_depth` (default 1). Set it to `2` so a delegated Architect can call its Scout, Investigator, plan-reviewer, approach-advisor and Hive Helper agents; Hive does not set it for you. On the tested v2 host, a top-level session uses the explicit CLI/session model or native configured model, rather than its agent's registered model. A fresh subagent of a Hive role or custom agent uses the agent's effective model/variant, then its parent's model, so a Hive role without a Hive model inherits like a native subagent; Hive refuses a `subagent()` `model` argument for those agents and, when the agent has a configured model, checks that a same-agent continuation's child is on it (a model-less agent inherits and is not checked; an explicit `model` still works for native `general`/`explore` and agents Hive does not register; see [Agent models](#agent-models)). An agent-bound command switches to its effective model/variant. Check actual requests rather than catalog fields. Scripted-provider qualification establishes wiring, not real-model judgment.

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

`oc-arkive` registers these slash commands as operator entry prompts. They prepare the active agent with workflow-specific instructions; they do not replace Hive tools or make unavailable tools available to the current agent. Each command carries its own authority and stop rules, so it is safe when invoked with no arguments or under a primary that is not Hive. `/dash-review`, `/test-audit`, and `/vuln-review` are exceptions: their generated OpenCode commands bind to private review primaries. `/sharpen`, `/implement`, `/investigate`, `/walkthrough`, `/merge-to-main`, `/handoff`, `/council` and `/worklog` bind nothing and run under the agent and model already selected.

| Command | Purpose |
|---------|---------|
| `/sharpen [prompt or idea]` | Ground, deepen, and when warranted reframe a candidate prompt, then return one rewritten prompt and a recommended next command, without acting on it. |
| `/interview` | Clarify an idea toward shared understanding with a flexible endpoint and no fixed next step. |
| `/grill <context>` | Pressure-test supplied context through researched facts and material questions until scope and acceptance criteria are agreed, then recommend the next step. |
| `/investigate [problem]` | Diagnose a problem from evidence and propose a fix with success criteria, without changing product code. |
| `/walkthrough [subsystem or change]` | Explain how a subsystem works now, or what a finished change did, with examples and the evidence behind them. |
| `/implementation-brief` | Produce a copy-paste-ready brief for a later Hive plan. |
| `/hive-plan` | Create or update the Hive feature plan from a spec or brief. |
| `/approve-sync-plan` | Approve the active plan and sync executable tasks. |
| `/start-execution` | Start execution for an approved and synced plan. |
| `/implement [steering]` | Implement, as ad-hoc work, the scope this conversation agreed, plus any context or steering typed after the command. |
| `/merge-to-main [steering]` | Merge the intended work into its main branch: review the combined result against the destination baseline, then verify it on the destination. |
| `/council` | Convene a configured council of read-only reviewers on a directive and synthesize a recommendation. |
| `/dash-review [intent]` | Review a folder, inline text, or the current checkout without changing source. |
| `/test-audit [paths or natural-language scope]` | Report outcome, oracle, and duplicate-coverage findings for a suite; defaults to the current repository. |
| `/vuln-review [scope]` | Review requested source for evidenced vulnerabilities with configured specialists. |
| `/worklog [request]` | Explain where the current work stands from its Worklog, read-only. |
| `/handoff [next job]` | Write one copyable, self-contained assignment so another agent can pick up the next job. |
| `/compact-summary` | Produce a compact recovery summary for the current session. |

### Complexity skills

`complexity-review` and `complexity-audit` are packaged skills, not Hive plugin commands. Both are complexity-only passes that report findings and do not apply fixes. Findings preserve required and pre-existing behavior; a worthwhile alternative that changes behavior that predates the reviewed change (in an audit or a named scope without a diff, current behavior), a public contract, or external dependencies, or that reaches callers beyond the reviewed scope, is reported separately as a structural proposal for an operator decision, naming its dependents, and authorizes no change by itself. Ordinary tooling and delegation contracts apply.

- `complexity-review` reviews an explicit diff or bounded named scope, or current staged, unstaged, and relevant nonignored untracked changes when no scope is supplied. An empty review stops without becoming an audit.
- `complexity-audit` audits named roots or codebases, or the current worktree when no roots are supplied.

On either host, ask for the skill by name with the scope and any philosophy or preferences in ordinary prose, for example "Run complexity-review on the diff against main; prefer deleting code." On the v2 TUI you can also mention the skill directly, as in `@complexity-review <scope>` or `@complexity-audit <scope>`. OpenCode v2.4.1 lists no skill among its commands, and slash invocation has not been verified on the v1.18.30 floor.

`/hive` has been removed. Feature creation now belongs to the planning flow and the Hive tools, usually `hive_feature_create` followed by explicitly targeted plan writes, review, per-feature approval and task sync, execution, and merge.

A council sends one directive to several read-only seats, such as a Scout and a set of reviewers, and the convening agent synthesizes their answers into a recommendation. The packaged `council` skill owns the procedure: draft the directive, decide who can convene, resolve the council, brief the seats, and synthesize. An agent loads that skill in three cases:

- You ask for a council, in prose or with `/council`.
- A condition you set in an instruction or standing constraint is met, for example "use council if you get stuck".
- You ask for a draft directive. `/council-directive` has been removed; ask for the draft in prose instead.

`/council` is a thin entry to the skill. It binds no agent and runs under whichever agent is selected. It passes your text to the agent as ordinary prose, for example `/council use the design group to assess this plan`. With no trailing text, it uses the current operator request as the directive. On OpenCode v1, native host processing of special template syntax (`$1`, `$ARGUMENTS`, shell and file references) still applies, so literal preservation of that syntax is not guaranteed. The agent selects a council only when you name one; otherwise it uses `council.defaultGroup`. An unknown council, or one with no usable seat, stops with an error, and nobody is launched.

A council is resolved with `hive_councils_list`. Among Hive roles, six hold it: `hive-master`, `swarm-orchestrator`, `hive-builder`, `architect-planner`, `dash-reviewer` and `vulnerability-review-primary`. Hive refuses it in every child session, so a subagent, including a delegated Architect, cannot convene a council and returns a council request to its parent instead. An unmanaged top-level agent, such as native `build`, keeps whatever its native permissions allow for this tool, as for other Hive tools; Hive adds no guard for it.

Being stuck starts a council only when an operator instruction or standing constraint says to use one. In that case a stuck worker returns a council request to its primary. The primary decides whether to convene, and continues with a fresh worker only when the council resolved the blocker.

Read-only is an instruction to the convenor and every seat. Hive does not sandbox them. Reviewer seats hold context-write tools and shell, and Scout seats hold shell.

Routing depends on `agentMode`:

| Command set | Unified mode | Dedicated mode |
|-------------|--------------|----------------|
| `/interview`, `/grill`, `/implementation-brief`, `/hive-plan` | Use `hive-master`. | Route or delegate to `architect-planner`. |
| `/approve-sync-plan`, `/start-execution` | Use `hive-master`. | Route or delegate to `swarm-orchestrator`. |
| `/sharpen`, `/implement`, `/investigate`, `/walkthrough`, `/merge-to-main`, `/handoff`, `/council` | Runs under the selected agent and model; binds none. | Runs under the selected agent and model; binds none. |
| `/dash-review` | Bound by `config.command` to a private review primary. | Bound by `config.command` to a private review primary. |
| `/test-audit` | Bound to `dash-reviewer`; report-only suite audit. | Bound to `dash-reviewer`; report-only suite audit. |
| `/vuln-review` | Bound by `config.command` to a private vulnerability-review primary. | Bound by `config.command` to a private vulnerability-review primary. |
| `/compact-summary` | Use `hive-master`. | Route or delegate to `scout-researcher`. |
| `/worklog` | Runs under the active agent. | Runs under the active agent. |

Except for `/dash-review`, `/test-audit`, and `/vuln-review`, dedicated-mode slash commands do not switch agents by themselves. If the active agent is not the route target, delegate or reroute to the target agent and stop if that is not possible.

Use `/grill <context>` when you want supplied context pressure-tested into a confirmed brief (decisions with rationale, constraints, scope, acceptance criteria). After you confirm, it recommends the next step the result warrants: a direct answer, `/implement` for scope clear enough to build as ad-hoc work, `/hive-plan` for work that needs a reviewed plan, or `/investigate` when an open question needs evidence first. When that step needs a different agent, such as `hive-builder` for `/implement`, it says which to select instead of switching. Use `/interview <idea>` to clarify an idea with a flexible endpoint, including ad-hoc work, and no fixed next step or implementation-brief funnel. Both follow the `grilling` skill: the agent gets its bearings from existing context, explains what it found in plain terms and says where the evidence is uncertain, skips decisions you already made, and asks one material question at a time. Every option carries a short pro and con and a recommendation, and a confident recommendation still leaves a choice that is yours to make. Both run within one continuing invocation: when the `question` tool is available, each answer returns to the same run, which keeps researching, checking, and asking until you confirm alignment or stop it. Without that tool, each plain chat question waits for your reply and the next turn resumes the same loop. When the `question` tool is available, the agent also writes each question, the options it offered, and your answer, or the fact that none came, into the chat after the tool returns. With either transport, its closing response reads back every question and answer in order, the confirmation included; if you stop early, you get the readback so far with alignment unconfirmed. The commands do not automatically create a plan, implement, or start follow-on work; a bare confirmation is understanding only, and later action requires a separate operator request, unless you asked upfront for the next stage (for example, "then create a plan after alignment"), which then runs once within the agent's normal planning and approval limits. A named destination authorizes writing only the confirmed alignment brief there. Discoverable facts are researched without forced fan-out. Unavailable or failed research is disclosed as unresolved or an explicit assumption; it is never guessed.

Use `/implement [steering]` when a conversation has scoped work and you want it implemented as ad-hoc work. The command switches neither agent nor model, so the chat stays in place and the selected agent keeps its model, and it points that agent at the `starting-ad-hoc-implementation` skill. Select `hive-builder` first to have it run the work; an agent that cannot implement ad-hoc work, such as `architect-planner` or a plan-first primary, names that limit and stops, and choosing another agent is yours. Text after `/implement` supplies further context and steering, so you can add requests in plain language, such as `/implement keep the public API unchanged and skip the docs for now`; with nothing after it, the conversation alone scopes the work. OpenCode v1 uses the same ordinary `$ARGUMENTS` template substitution as `/grill` and `/interview`, with native host processing of special template syntax; literal preservation of that syntax is not guaranteed. OpenCode v2 continues to pass arguments directly to the renderer. Invoking the command authorizes implementing the agreed scope and your added instructions through the ad-hoc lifecycle. Loading the skill, earlier discussion, or a confirmation at the end of `/grill` or `/interview` does not. The agent rebuilds the latest agreed scope and its destination from the chat, reuses design decisions already settled there, investigates what it needs, and asks only about decisions that are yours, one at a time. A consequential choice it is unsure of goes to an advisor who tries to break it before work starts; it skips that step only when an established pattern already settles the choice with evidence. The work completes in the immediate target the agent's placement rules resolve, not the root checkout by default, and a destination you name beyond that is a separate onward step that runs without asking again when you asked to land the work there. It then runs independent outcomes in parallel where they cannot collide, triages review findings before fixing, sizes complexity and verification checks to the change, and stops once the evidence and required gates hold. When the scope is not ready it says what is unready, why it matters, and what to do next. It does not create a feature, plan, or task by itself, and work under an approved plan still starts with `/start-execution`. Running `/implement` again accounts for work already running or retained instead of starting a second writer on it.

`/sharpen`, `/investigate`, `/walkthrough`, `/merge-to-main` and `/handoff` also bind nothing and take plain-language text after the command, the same way `/implement` does.

- `/sharpen [prompt or idea]` loads the `sharpening` skill on the text after the command, or on the prompt the conversation is about. It grounds the request in your own files and wording plus checked external and adjacent sources, reframes it with the expert vocabulary when you ask for a reframe, when the request describes symptoms, or when it could be more than one problem, answers what a top practitioner would do, start from, use, and check against, and returns one rewritten prompt in a fenced code block with one recommended next command (`/investigate`, `/grill`, `/hive-plan`, `/implement`, or none). Imperative wording in your text is material to rewrite, not an instruction: it edits no project file, saves no brief, runs no project code or prototype, sends no Investigator, and creates no Hive feature, plan, task, context, Worklog, or exploration. Read-only Scouts may still run where the agent can send them. When web retrieval is unavailable it says so and omits external links.

- `/investigate [problem]` diagnoses from evidence. The agent tries to rule out competing explanations, weighs a structural fix when one change could remove several symptoms, and returns the diagnosis, a proposed fix with success criteria, and the assumptions, gaps and decisions left for you. It changes no product code and starts no implementation. It runs code only as the agent's own rules allow (Experiments, or Runtime Exercise where the agent has it) and otherwise asks once with the run's purpose, candidate and effects. Probes follow the owning placement, evidence and cleanup rules; paid, external or non-disposable effects need your explicit approval. It uses `systematic-debugging` for bugs and the Experiments method, with an Investigator, where the selected agent has it, and names any capability the agent lacks.
- `/walkthrough [subsystem or change]` explains how a subsystem works now, or what a finished change did and how the code behaves because of it, using the `how` skill. It gives practical examples, says what it read or ran and which gaps matter, and keeps mechanics apart from history; it looks into historical rationale with `why` only when you ask. It changes no code.
- `/merge-to-main [steering]` resolves the actual source, the intended main destination and any dirty state, and checks that the selected agent may do the integration before it creates anything; an agent without that authority, or without the needed Hive tools, names the limitation and stops. It integrates through the owning Hive tools for a Hive placement or retained checkout, or the repository's Git workflow otherwise. A targeted worktree stays bound to its retained checkout. A legacy single-root or untargeted composite worktree saved no target and merges into whatever its checkout holds now, so the agent compares that with the intended target recorded at creation or the last accepted handoff (per repository for a composite), treats a branch switch at the same commit as a different target, and stops with the missing evidence when the original target can't be established. When the target is not main, the agent finishes the worktree there, resolves retained checkouts for that target and main, and delivers on to main through Closure in `orchestrating-ad-hoc-work`, reporting main as pending until that second step lands. Fixes for an existing Hive worker go into the same worktree through a fresh worker, and the merge uses the newly verified pin. It records the destination baseline, has the combined candidate reviewed against it for correctness and simplicity, following the agent's review routing where it has one, with complexity covered in the simplicity review, triages and fixes material findings, keeps published ancestry, rewrites only private history it has authority to rewrite, and runs the required checks before integrating and again on the destination before cleanup. It never pushes unless you ask.
- `/handoff [next job]` writes one self-contained assignment in chat for another agent, shaped for the next job (diagnosis, implementation, review and so on). It covers goal and scope, current state, settled decisions and constraints, verified evidence apart from unverified claims, exact checkout, ref, path and pin, the next action, and workers or resources whose state is still open. It dispatches nothing and writes no Hive record, including a task's successor handoff. `/implementation-brief` remains the input for formal planning, and `/compact-summary` the recovery summary for the whole session.

Use `/dash-review` for one read-only Git, process/concept, or local-artifact review. It does not edit source, create Hive tasks, or start a fix. See [Reviews in the Operator Guide](../../docs/OPERATOR-GUIDE.md#reviews).

Use `/test-audit` for a repository or named suite audit using `test-quality`. It reports meaningful-outcome gaps and duplicate failure-mode coverage with source/test anchors, recommendations, and honest sampling limits. The audit never fixes tests by default. To act, ask explicitly to prune, rewrite, or remove weak or redundant tests in a named scope; that request runs the skill's prune mode under the normal implementation lifecycle. Code and simplicity reviewers also load the skill for relevant assertions, coverage claims, and duplicate tests within their assigned review scope. Implementing workers also load it when they add or change a behavior test; see [Verification and acceptance](../../docs/OPERATOR-GUIDE.md#verification-and-acceptance). A missing or disabled skill leaves the affected review coverage open; native overrides remain authoritative.

`/dash-review` is a read-only orchestrator over a folder, inline text, or the current checkout. An optional `hive_git_snapshot({ directory })` or operator-selected worktree covers foreign Git evidence. The primary understands the change and consumers before assigning evidence-linked questions to best-fit reviewers, honors required participation, and independently tries to disprove material candidates. Useful, authorized tests and source evidence determine whether findings survive; unresolved material gaps remain visible. When running the candidate would settle a question, the primary can send an Investigator on a runtime exercise within your authorization ([Runtime exercises](../../docs/OPERATOR-GUIDE.md#runtime-exercises)). It does not edit source, create Hive tasks, or start a fix; findings remain review context. Use `pr-writing` to draft grounded PR titles, descriptions, and review comments without posting them.

For an ad-hoc run, review the existing run or branch, then give a later fix instruction to the ad-hoc orchestrator. For a Hive feature run, review the task, feature, or branch, then give the active planner or orchestrator a later fix instruction.

On v1 a native `task()` call blocks until its child returns. On v2 every `subagent()` call runs its child in the background; see [Background subagents](#background-subagents). The private `/dash-review` primary holds the live child tools `hive_background_status` and `hive_background_cancel` ([runtime grants](src/runtime/role-policy.ts)).

### Vulnerability Review

Use `/vuln-review` with a source scope in ordinary language, for example `/vuln-review review the authentication boundary changed in this branch`. The private review primary accepts the requested checkout, folder, paths, inline evidence, or an optional Git snapshot through ordinary tools. For a foreign Git root, `hive_git_snapshot({ directory })` takes an absolute path to its exact Git top-level. A prior report can be compared when you supply it as readable input. See [Reviews in the Operator Guide](../../docs/OPERATOR-GUIDE.md#reviews).

The primary selects configured `vulnerability-reviewer` specialists by description and dispatches every explicitly requested configured specialist. It preserves the source fingerprint when it uses a Git snapshot. The report leads with deduplicated, severity-ordered findings backed by an attacker-to-impact path, confidence, affected locations, and root cause; it also states unresolved leads and coverage gaps. With no confirmed findings, it says "No confirmed vulnerabilities found in reviewed scope." A clean result applies only to the reviewed scope, not repository security ([reviewer contract](src/agents/vulnerability-reviewer.ts)).

External research may receive only public dependency names and versions or public advisory IDs such as CVE and GHSA IDs. Never send proprietary source, symbols, paths, configuration, logs, or stack traces to external tools ([reviewer contract](src/agents/vulnerability-reviewer.ts)). Findings stay in session history; the command writes no report file. The private primary has edit permission denied and does not begin remediation in the first response. A local reproduction of a lead runs only as a [runtime exercise](../../docs/OPERATOR-GUIDE.md#runtime-exercises) that your instructions cover, and the specialists stay non-executing ([runtime grants](src/runtime/role-policy.ts), [primary prompt](src/agents/vulnerability-review-primary.ts)).

### Planning-mode delegation

During planning, "don't execute" means "don't implement" (no code edits and no implementation worktrees). Read-only exploration is explicitly allowed and encouraged, both via local tools and by delegating to a researcher. A primary Architect may create and clean up an ad-hoc placement for an Investigator [experiment](../../docs/OPERATOR-GUIDE.md#experiments) that settles a planning question; it never merges one.

When delegation is warranted, synthesize the task before handing it off: name the file paths or search target, state the expected result, and say what done looks like. Workers do not inherit planner context.

Each native subagent invocation (`task()` on v1, `subagent()` on v2) has one primary goal and one terminal report. On v1 the blocking call returns that report. On v2 the call returns a launch receipt, and the terminal report is the matching `<background-result kind="subagent">` report with state `completed`, `error` or `cancelled`; a `state="running"` report is interim. Every terminal report ends that invocation, including completed, failed, empty, partial, blocked, unsatisfactory, review-remediation, retry, new-test-evidence, and operator-decision results. Review findings are new assignments in the same implementation lane. Compaction re-anchoring of a currently running worker is distinct from follow-up work. On v1 every follow-up uses a fresh child session, reusing the same Hive task/worktree where appropriate; primaries pass `task_id` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation, and never infer eligibility from task output, `hive_task_trace`, `idle_and_closed`, cancellation acknowledgement, or transcript quality. On v2 a settled child of `forager-worker`, `forager-investigator` or `architect-planner` (or a custom agent derived from one) may be continued with `sessionID` on the same agent and the same task or investigation for one or two bounded follow-ups, such as applying review fixes; Scouts, reviewers, advisors and `hive-helper` are one-shot, and a new task, an independent review or challenge pass, or a retry after a dead end starts a fresh child. Hive's dispatch wrapper refuses a continuation of a child that has not settled, runs another agent, or has a conflicting route or marker. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer. Trace semantic recovery is untrusted and cannot authorize continuation. A primary goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step. Give complete constraints and acceptance criteria only for that goal, then split independently verifiable outcomes into fresh launches. A returned child ID is also the handle for runtime-visible session trace inspection and, on v2, for `hive_background_status` and `hive_background_cancel`. An orchestrator delegates plan creation or editing to `architect-planner`; Architect may call one layer of configured Scout, Investigator, plan-reviewer, or approach-advisor helpers and `hive-helper`.

One implementation assignment normally maps to one numbered task. Amend the DAG or create an append-only manual task for a new independent deliverable. A blocked feature continuation follows `hive_task_update` with blocked status and blocker, the operator decision, then `hive_task_update` with an explicit status leaving blocked. Failed or retry work starts a new worker with a concise self-contained handoff. For ad-hoc work, use multiple fresh one-goal launches on worktrees whose registered identities do not intersect, or sequence writers that share a worktree. Architect is the only subagent allowed one terminal layer of planning helpers; every other subagent is terminal. The `question` tool is reserved for primary sessions. Any subagent that needs operator clarification returns the exact question in its terminal response for the parent orchestrator to ask.

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

On v1, Hive registers ordered OpenCode `agent.permission` rules: `'hive_*': 'deny'` first, then each role's exact allows. Agent rules override global `{"*":"allow"}`. Custom variants inherit their base role. `experimental.primary_tools` adds child-session denials for integration/cleanup, ad-hoc creation, retained checkout changes, feature routing/completion, approval/sync/task creation, constraint mutation, context archive, the live child tools, Worklog recording, and `question`. Worklog recording also checks the role and live parent in its executor.

On v2, your native permission rules decide which tools are visible, and Hive does not rewrite them. Every Hive executor and the native `execute.before` hook check the agent's base role and the session's actual parent before any effect, as described under [OpenCode v2](#opencode-v2). A visible tool can therefore still be refused.

On both hosts, Architect keeps feature creation, repository registration, and bounded planning-helper delegation as a child and hands primary-only requests back to its parent.

All Hive roles can read context, constraints, plans, status, repository scope, Git snapshots, Worklogs, and the retained checkout list. Scout adds repository discovery. Forager adds context write/append, feature/ad-hoc/checkout inspection, recovery traces, assigned feature-worktree creation, and its own report/handoff update. Helper's Hive tools are limited to state/worktree/trace inspection. Reviewers and advisors add authorized context write/append. Hive, Swarm, and Builder have the full Hive set, including retained checkout changes; Architect has planning and primary-control tools; review primaries have metadata/context, inspection/trace, constraints, routing, live child tools, and authorized ad-hoc review placement/cleanup. Hive grants Worklog recording to primary sessions of the full primaries, Architect, and the review primaries. An unmanaged agent that is neither a Hive role nor a custom variant of one keeps its native permission for Hive tools, so it can record from a primary session; its child sessions are refused, as are native `general`/`explore`. The [complete access matrix](docs/HIVE-TOOLS.md#agent-tool-access) names every grant and native boundary.

Native `general`/`explore` have no Hive tools, recursion, or questions. Helper/reviewer role-specific Hive-tool denials and native edit denial are enforced, while shell and research integrations remain available under operator permissions. Their inspection-only scope for shell and external effects is instruction-bound, an operator-accepted risk; these capabilities must not substitute for denied Hive operations. Use Helper first for session-trace retrieval; it returns evidence and mutation requests to the primary. Changes take effect after the OpenCode host reloads; on v1, use fresh child sessions so OpenCode applies the creation-time primary-tool denials.

When Architect is task-spawned, its one permitted terminal helper layer includes `hive-helper`, including same-message independent fan-out, and it waits for each helper's result before relying on it. Architect as primary or child routes multi-step trace/evidence questions to Helper and performs single direct spot-check reads itself. As a child it returns primary-only requests (approval, sync, archive, council, placement create or cleanup) to the parent and reports an interrupted or unresolved helper with its identity there; the live child tools are unavailable to it, and the parent's live child tools inspect or interrupt the delegated Architect itself, not its helpers. Primaries issue independent Hive calls in one response/step and serialize dependent mutations or merges sharing a destination.

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
| `hive_worktree_merge` | Integrate an exact task source pin against the inspected destination identity under a required history intent, with optional conflict preservation and optional cleanup |
| `hive_worktree_cleanup` | Remove a feature-task worktree |

Git helpers do not change task status, auto-commit source, or assign workers. Before dispatching a writing lane, capture the initial inspection from create and record the intended destination's canonical path, full symbolic ref (or detached `null`), and commit. Reinspect after each writing handoff, before review or remediation, after known destination movement, and before integration. Pass the unchanged identity as `expectedTarget` for a legacy single-root workspace or the complete `expectedTargets` map for a composite. A legacy worker returns `sourceCommit`; a composite worker returns the complete `sourceCommits` map keyed by repository ID. A singleton composite can use a matching scalar pin at merge. The primary passes the worker's pin unchanged and uses same-call `cleanup: 'worktree+branch'` when retention is not needed.

Merge requires a clean source and a destination with a clean index and tracked working tree. Disjoint untracked or ignored destination files may remain when the pinned source contains the pinned target history; rebase also requires a linear replay range. A source already contained in the destination returns `ALREADY_INTEGRATED` without a commit. For a noncontained source, unsafe topology with local data returns `TARGET_RECONCILIATION_REQUIRED` with `reconcile_target` and requires same-worktree reconciliation with fresh pins. Ignored Hive state, dependencies, and build output count as local data even when Git reports a clean worktree. Incoming path collisions always block. Hive preflight and rechecks protect local data without relying on Git merge flags. Dirty, untracked, ignored, and unmerged data is protected; there is no force or rm fallback. Same-call cleanup runs only after fresh identities and the completed work's proof hold in every selected repository; a failed proof retains the source placements. Later ambiguous branches stay unless `discard: true` is explicit. Composite partial outcomes are not rolled back.

Every merge declares `historyIntent`; there is no default. `preserve-source` keeps the source ancestry and its commit messages unchanged and permits only a normal merge. `rewrite-private` declares that all source-only history is private and permits `squash`, its default, or `rebase`. For a merge that creates a commit, supply `message` with a one-line subject, a blank line, and a descriptive body. Rebase does not take a non-blank `message`.

Pass the feature explicitly to `hive_worktree_create`. Before dispatch, call `hive_feature_select` only when the selected route is unset or differs from the dispatch target, or the selection evidence below is missing or uncertain. Reuse a matching selection across a same-feature batch only when this session's most recent route-changing call visible in context is `hive_feature_select` for that same feature, with no later explicit-null or other-feature selection, or, on OpenCode v2, when this session's `hive.session` session instruction entry shows that feature as the selected route; Hive keeps that entry through compaction. When neither is visible (for example at session start, in mixed ad-hoc/feature batches, or on v1 after compaction or a summary), or you are uncertain, call `hive_feature_select` for the dispatch target. Explicit null suppresses fallback and stays featureless unless the dispatch intentionally targets a feature. Then issue the ordinary native Forager call. Blocking and background calls use the native task shape unchanged.

### Status

| Tool | Description |
|------|-------------|
| `hive_status` | Inspect feature, task, dependency, and worktree state |

When the destination already contains the task source, `hive_worktree_merge` reports a successful no-op with `reasonCode: 'ALREADY_INTEGRATED'`. Under `rewrite-private`, a source with no net tracked changes reports `reasonCode: 'NO_TRACKED_CHANGES'`. Both have `success: true`, `merged: false`, and no empty `sha`. Requested cleanup can still run when safe. Use `hive_status`, not live child status, to decide whether a task has completed work and a live worktree eligible for merge or cleanup.

### Ad-hoc Worktree

Use ad-hoc orchestration when you need delegation, verification, and a managed worktree without a feature, plan, or task record. Dedicated mode uses `hive-builder`; unified mode can use `hive-master`. The operator loop is in the [Operator Guide](../../docs/OPERATOR-GUIDE.md#ad-hoc-work).

| Tool | Description |
|------|-------------|
| `hive_adhoc_worktree_create` | Create a scoped ad-hoc Git workspace |
| `hive_adhoc_worktree_inspect` | Inspect the source and destination identities |
| `hive_adhoc_worktree_merge` | Integrate the pinned source against the inspected destination |
| `hive_adhoc_worktree_cleanup` | Remove the integrated workspace; `discard: true` explicitly retires unintegrated work |
| `hive_worktree_recover` | List or acknowledge an interrupted task or ad-hoc worktree operation after its processes stopped; it never replays the operation |

The ad-hoc orchestrator resolves repository ownership with `hive_repositories_status` unless scope is already explicit, then calls `hive_adhoc_worktree_create` with the owned `repoIds` and a meaningful kebab-case `runId` before an ordinary native Forager call. These runs do not create feature/task records and do not appear in `hive_status`. The response supplies the `runId`, placement, and initial inspection. Record its destination identity before dispatch; later inspection checkpoints remain required. The primary integrates with `hive_adhoc_worktree_merge` using the unchanged inspected identity, the returned source pin, and a declared `historyIntent`, with same-call cleanup when retention is not needed. Ad-hoc worktrees are temporary workspace metadata only. See [Hive Tools](docs/HIVE-TOOLS.md) for the full contracts.

Feature escalation is advisory. If the operator rejects it, continue ad-hoc only when material scope, contracts, and risks are otherwise resolved. Ask any remaining concrete blocking question before creating workers.

Forager is an execution role. Use a matching worktree for tracked Git writes; non-Git or report-only work follows the direct-work exceptions. Standalone diagnosis, experiments, and verify-only runs go to `forager-investigator` ([Experiments](../../docs/OPERATOR-GUIDE.md#experiments)). A source-based judgment needs no placement; a run that changes source uses a disposable placement that is cleaned up instead of merged; runtime-only work names its URL or environment. Direct foreground OpenCode work is unmanaged OpenCode work, not a Hive worktree.

Native `general` is an ordinary delegation with ordinary tools only; it cannot delegate or ask questions. Native helpers retain bounded operational permissions.

### Retained Checkouts

A retained checkout `<repoId>/<slug>` is a long-lived branch checkout, such as a release line beside `main`, that temporary workers integrate into instead of the project root. A project without a repository manifest has the one repository `root`.

| Tool | Description |
|------|-------------|
| `hive_checkouts_list` | Every repository with its retained checkouts and task and ad-hoc workers; read-only |
| `hive_checkout_inspect` | One checkout; optionally its local paths and the cleanup proposal |
| `hive_checkout_brief` | What one checkout holds relative to another and which Hive integrations produced it, with pointers to their Worklogs and task records; read-only |
| `hive_checkout_create` | Create a managed checkout at `.hive/checkouts/<repoId>/<slug>` on a new or existing branch |
| `hive_checkout_register` | Record a checkout the project already configures, which Hive never removes |
| `hive_checkout_readiness` | Declare or clear readiness pinned to the checkout's current commit; it gates nothing |
| `hive_checkout_cleanup` | Remove an unreferenced checkout at the identity its cleanup proposal returned |

Workers bind to a retained checkout only when the caller names it: `target` on `hive_task_create`, a plan task's `**Hive target**: <repoId>/<slug>` line, or `target` (optionally with `baseRef`) on `hive_adhoc_worktree_create`. A targeted worker's inspection reports the checkout as its `target`, merges take the scalar `sourceCommit` and `expectedTarget`, and a binding whose checkout changed branch cannot merge. For example, a run that builds on the release line and lands on a hotfix line:

```text
hive_checkout_create({ id: "root/release", branch: "release", baseRef: "main" })
hive_checkout_create({ id: "root/hotfix", branch: "hotfix", baseRef: "main" })
hive_adhoc_worktree_create({ runId: "fix-login", target: "root/hotfix", baseRef: "release" })
```

Only Hive, Swarm and Hive Builder primary sessions change retained checkouts. See [Hive Tools](docs/HIVE-TOOLS.md#retained-checkouts-7-tools) for results, refusals and cleanup rules.

### Background subagents

On v1 a native `task()` call blocks until its child returns, and `hive_background_status` and `hive_background_cancel` return `unsupported_on_host`.

On v2 every `subagent()` call runs its child in the background: it takes no `background` field, returns `running` with the child's `sessionID` at once, and the host reports the child's result in a later `<background-result kind="subagent">` message. The system prompt's `## Native Subagent Wait` section tells agents to wait for that final report and treat `state="running"` as interim. Hive keeps no record of these launches.

Two primary-only tools read and interrupt the calling session's direct children live and write no `.hive` file:

- `hive_background_status` lists the children that still have work running, a job of the child or its descendants or an active execution (`includeSettled` also lists the rest), or, with `sessionID`, reads whether one child's whole session tree has settled, queued inbox input included. Feature, task and run filters match the binding Hive wrote at dispatch.
- `hive_background_cancel` interrupts one child's active execution with resume disabled. It does not stop `shell` commands or descendant jobs the child already moved to the background, and it is not rollback: files, branches, worktrees, commits and reports stay as they are.

Agents call them only when a child's liveness is uncertain or a child is no longer needed. A cancellation result or an `error` or `cancelled` report does not prove the worker stopped; read the child's settlement before starting an overlapping writer. See [Live Subagent Children](docs/HIVE-TOOLS.md#live-subagent-children-2-tools) for results and refusals.

### Runtime Session Inspection

Primary orchestrators can inspect any explicitly identified native OpenCode session visible to the connected runtime with `hive_task_trace`, including self, direct children, foreign-parent sessions, and parentless primaries. Omitted or false `recovery` returns a paged forensic v3 index: surviving non-reasoning events in source order with bounded excerpts, assignment and final self-report context, and coverage limits. For later pages pass the entire `coverage.next_cursor` string unchanged as `cursor`. Pass an event's `events[n].ref` as `event` to `hive_task_trace_content` to read that tool's input, output, and error together under a full integrity guard, then continue an oversized field in UTF-8-safe chunks with `field` and `offset`. `hive_task_trace({ task_id, recovery: true })` requests an untrusted semantic handoff whose content IDs `hive_task_trace_content` also reads. A finished turn recovers with `closed_turn` scope. An idle runtime whose tool or message records stay open, as after a host restart, recovers only an `evidence_only` snapshot that stays non-terminal and inspect-only. Self, active, and other uncertain targets cannot recover, and non-direct-child recovery is always inspect-only. Status and source come from the target session's own directory; on v1 a missing target entry in a valid status map means idle because OpenCode removes idle entries, while on v2 the target is busy until its whole session tree has settled. An unavailable status and a missing directory are uncertain and make zero model calls. Native call rows (`task` on v1, `subagent` on v2) show a confirmed `child_session_id` only when the stored call recorded the child's ID; on v2 a call that a restart ended before it returned may lack it, though `hive_background_status({ includeSettled: true })` still lists the child among the caller's direct children (then read its settlement with `hive_background_status({ sessionID })`; when more than one child fits, its identity stays unresolved), and a missing ID does not show that the child stopped. Recovery output never authorizes acceptance, merge, retry, resume, or automatic execution. See [Hive Tools](docs/HIVE-TOOLS.md) for the full contract.

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

For an explicitly selected feature, a Forager assignment whose first non-empty line is `Hive task: <task-folder>` for an existing task receives a bounded path-only Hive task brief appended to its prompt. On OpenCode v1 the brief follows the route-snapshot footer; on OpenCode v2 it follows the authored prompt, because the route snapshot goes to the child's `hive.session` session instruction entry instead. It points to the current spec and plan section, direct dependencies' successor handoffs, and the durable feature-context catalog; workers read those records as needed. Eligible unbound dispatches receive a notice; fallback and explicit-null routes get neither brief nor notice, and other roles get no brief. No context documents, catalog bodies, or completed-task summaries are injected. Agents can search durable-file catalogs and read named files with `hive_context_read`; evidence files remain readable by name. `taskService` does not include completed-task summaries in `spec.md` ([task service](../hive-core/src/services/taskService.ts)).

The same first line, `Hive task: <task-folder>` or `Hive run: <runId>` for an ad-hoc run with a worktree in this project, associates the child session with that task or run in its session record once the host reports the dispatched child. On a fresh call, a line Hive cannot resolve associates nothing. On v1, a later dispatch with a resolved line replaces the association and clears the other kind; on v2, a resolved line sets the association on a fresh call or adopts one when a continued child has none, and refuses a continuation naming another task or run. A continuation without a line keeps the stored association, except on v1 when the effective feature changed, including a move to or from a featureless route, which clears it. On v2 a continuation whose line Hive cannot resolve, or whose line names another task or run than the child's binding, is refused ([details](docs/HIVE-TOOLS.md#child-session-association)).

### Observability

`hive_worktree_create` and `hive_worktree_inspect` return workspace path, branch, and commit facts. They do not return a generated native-task payload.

### Native Task Prompts

The primary authors the native Forager prompt. At dispatch, Hive delivers a route snapshot with `projectRoot`, the selected feature route, session constraints, and feature constraints: on OpenCode v1 it appends the snapshot to the prompt as a footer ([runtime hook](src/runtime.ts)), and on OpenCode v2 it writes the snapshot to the child's `hive.session` session instruction entry ([dispatch](src/v2/dispatch.ts)). It does not attach a context catalog.

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

Dedicated mode does not auto-switch the live chat agent when you run a slash command. If the active agent is not the route target, delegate or reroute to that target and stop if that is not possible. `/dash-review`, `/test-audit`, and `/vuln-review` always bind to private review primaries regardless of mode.

### Task trace summarizer

`taskTraceSummarizer` configures the **hidden, parentless, tool-less** model used when an agent with trace access calls `hive_task_trace({ task_id, recovery: true })`. It does **not** change forensic (non-recovery) traces, which stay deterministic and model-free.

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `model` | no | The invoking caller session's native model | Explicit `provider/model-id` |
| `variant` | no | With no `model`: the caller's native variant. With `model`: that model's default | Requires `model`. Must match a key under `opencode.json` `provider.<provider>.models.<model>.variants` |

Behavior:

- Recovery interpretation is always marked untrusted (`provenance: 'summarizer_interpretation'`).
- Each recovery binds one model selection when it starts: the configured `model` (with `variant` when set), or, with no `model`, the model and variant the session that called `hive_task_trace` is running on. On OpenCode v2 a calling session without its own model runs on its agent's configured model and variant when that model is available, else on the host default. A session that names no agent runs on the default agent, which Hive takes from the agent the host names for the `hive_task_trace` call; Hive binds the same choice, and reports recovery unavailable when the host default is one the runner would skip. The model metadata and every summarizer request of that recovery use it, and `recovery.model.requested` reports it with its `source` (`configured` or `caller`). If the caller's selection cannot be read, recovery is reported unavailable rather than run on a guessed model. Hive sets no sampling options on these requests. Each request carries its own stage output contract (a strict JSON Schema plus the rules it cannot express); replies are validated against the same schema.
- `recovery.model.observed` reports the provider, model, and variant the host says it ran. A configured variant that provider metadata shows the model does not offer is not sent; recovery returns deterministic partial fallback and does not claim it was applied. If metadata cannot be read, the variant is still sent and `observed` shows what ran.
- A provider error, an unusable reply, or a request that exceeds the model's input budget produces deterministic partial fallback without provider retry or model fallback. Each affected failure entry may carry up to four `diagnostics`: finite codes, a schema path and step number, the provider error name and HTTP status, finish reason, and reply size. Diagnostics never include provider messages, response bodies, source text, or model text.
- Only the bare JSON object, or that object inside one enclosing code fence, is accepted. Prose around it is a failure, and nothing is extracted or repaired.
- Recovery never authorizes accept, merge, retry, resume, continuation, or auto-run. On v1 follow-up work after a returned result uses a fresh child session, which may reuse the same Hive task/worktree, unless an explicit operator instruction or runtime-owned interruption recovery authorizes `task_id` pass-through. On v2 `sessionID` continuation is limited to settled children of resumable roles and to the checks in `src/v2/dispatch.ts` ([details](docs/HIVE-TOOLS.md#v2-subagent-dispatch-and-continuation)).
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

Built-in council defaults are read-only and portable. Each built-in group seats only built-in base agents:

| Group | Purpose | Default members |
|-------|---------|-----------------|
| `design` | Architecture and implementation-shape advice. | `scout-researcher`, `approach-advisor`, `plan-reviewer`, `code-reviewer` |
| `decision` | Hard tradeoff decision support. | `scout-researcher`, `approach-advisor`, `plan-reviewer` |
| `minimal-change` | Smallest correct change and cleanup lens. | `scout-researcher`, `simplicity-reviewer`, `code-reviewer` |
| `documents` | Documentation and prose-oriented review. | `scout-researcher`, `code-reviewer`, `plan-reviewer` |

Your `council` settings merge with the built-in defaults. `council.groups.<name>` replaces the whole group of that name and leaves omitted default groups intact; a new name adds a group. `council.defaultGroup` selects the council used when none is named:

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "council": {
    "defaultGroup": "documents",
    "groups": {
      "documents": {
        "description": "Docs and operator prose review",
        "members": ["scout-researcher", "plan-reviewer"]
      },
      "security": {
        "description": "Security-sensitive review",
        "members": ["scout-researcher", "vulnerability-reviewer", "code-reviewer"]
      }
    }
  }
}
```

A member name can be a built-in agent or a configured custom agent. A seat must derive from one of six base roles: `scout-researcher`, `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor` or `vulnerability-reviewer`. Foragers, Investigators, `hive-helper` and primaries cannot sit on a council, and neither can custom agents derived from them.

Every usable seat in a group runs. The roster keeps the configured order; the convenor launches the seats together, and they answer in parallel. Resolution skips a seat and reports one of these reasons:

- `not_registered`: the name is not an agent Hive registers, that is, neither a built-in Hive role nor a configured custom agent. A native agent Hive does not manage is also `not_registered`.
- `not_available`: on OpenCode v1, a Hive subagent with `disable: true` in your OpenCode configuration. Hive keeps that setting for the agents it registers with mode `subagent`, so a disabled reviewer also drops out of the v1 `/dash-review` and `/vuln-review` rosters. On v2, an agent absent from the host's agent list when `hive_councils_list` is called, or a Hive subagent you changed to `mode: primary`.
- `example_template`: an agent whose name contains `example-template` or whose Hive description starts with "Example template only".
- `ineligible_base`: the agent does not derive from one of the six seat base roles.
- `duplicate`: the name already appeared earlier in the group.

A blank or unmatched council name returns `unknown_council`, and a council whose seats are all skipped returns `no_usable_seats`. In both cases there is no roster and nobody is launched. Hive does not fall back to the default group.

To see what a council resolves to before you use it, ask a primary agent to call `hive_councils_list`, optionally with `name`. With no name, it resolves the configured default council. The result carries a `notice`, the configured `councils` with their names and descriptions, the `selected` council it resolved, and the `skipped` seats with their reasons. It then has either `ok: true` with the seat `members`, or `ok: false` with a `reason`. It dispatches nobody.

`council.maxMembers`, `council.groups.<name>.maxMembers` and `council.excludedAgents` are ignored. Files that still set them load and validate, and the JSON schema marks them deprecated.

After you upgrade, every usable eligible seat in a group is selected, including seats that a cap or `excludedAgents` used to keep out. An eligible seat is one derived from the six seat base roles. Resolution can still skip an eligible seat for one of the reasons above, such as `not_available`, `example_template` or `duplicate`. Entries in `excludedAgents` for agents that cannot sit on a council, such as the orchestration and worker agents of the old default list, need no action, because resolution still skips those agents. The reported reason is `ineligible_base` or the reason of an earlier check, such as `not_registered`. To keep an eligible seat out of a group:

- For a group you declared under `council.groups`, remove the seat from that group's `members`.
- For a built-in group you did not declare, add an override under `council.groups.<name>` that lists the members you want, as the `documents` override in the example above does. A file that sets only `excludedAgents` inherits the built-in groups unchanged, so it has no `members` list to edit.

Before the first council after upgrading, ask a primary agent to call `hive_councils_list` and check the resolved roster.

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
| `black-box-testing` | Write a black-box case through a real consumer interface, or adopt, migrate to, or audit a project's black-box test contract when asked |
| `brainstorming` | Explore intent and design before implementation |
| `code-design-principles` | Conditional depth for state, types, boundaries, shared writers, retries, and internal migration |
| `complexity-audit` | Read-only complexity audit of named roots or the current worktree |
| `complexity-review` | Read-only complexity review of an explicit diff or bounded scope |
| `context-engineering` | Select, retrieve, and update managed context with revision and hash checks |
| `council` | Draft a council directive, resolve a configured council, brief its read-only seats, and synthesize their answers |
| `dispatching-parallel-agents` | Coordinate independent subagent work |
| `executing-plans` | Execute an approved plan with review checkpoints |
| `grilling` | Orient on supplied context, explain what is found, and question it until material decisions and evidence are aligned |
| `hive-config` | Hive runtime layout, state-tool ownership, read-only session forensics, and Agent Hive configuration reference |
| `how` | Explain current source-grounded behavior and subsystem flow |
| `humanizer` | Rewrite existing prose without changing its facts or commitments, interview the writer or work from their notes, audit your own or supplied draft, and repair vocabulary, register, attribution, and formatting |
| `modern-web-guidance` | Vendored web-platform guides for HTML, CSS, DOM and UI components, forms, accessibility, Core Web Vitals, and client-side security, plus a codebase UI/UX audit and modernization workflow |
| `orchestrating-ad-hoc-work` | Coordinate qualifying ad-hoc work for Hive Builder or unified Hive |
| `parallel-exploration` | Researcher fan-out for read-only research |
| `pr-writing` | Draft PR titles, descriptions, and general or inline review comments |
| `project-verification` | Set up, audit, or maintain a project's durable verification guidance, reusable agent controls, harness, or formal checks when requested |
| `security-audit` | White-box security audit method for `/vuln-review`: surface and shared-defense mapping, multi-wave frontier hunting, independent falsification, sibling sweeps, findings and coverage reports, and authorized local pentest craft |
| `sharpening` | Opt-in pass behind `/sharpen` that grounds, deepens, and when warranted reframes a candidate prompt, then rewrites it once and recommends a next command |
| `starting-ad-hoc-implementation` | Turn a scoped conversation into authorized ad-hoc implementation when the operator asks to implement it |
| `stop-design-slop` | Visual foundation for interfaces: composition from the product's task, diagnostics for generic patterns, and refinement that preserves an existing identity |
| `stop-slop` | Repair staging, formulaic cadence, and structure in existing prose |
| `systematic-debugging` | Root-cause investigation before fixes |
| `test-driven-development` | Strict red-green-refactor when TDD is the selected testing strategy |
| `test-quality` | Outcome/oracle and duplicate-coverage lens for reviewers, a recorded break for workers that add or change behavior tests, report-only suite audits, and an explicit prune mode for weak or redundant tests |
| `unslop` | Shared philosophy and router for writing, messaging, and visual work; every Hive role is asked to load it, and it selects depth skills and carries the delegation contract |
| `verification` | Select checks from the candidate repository's own guidance, size proof to what a change touches and reaches, read their results, and require applicable command/tool evidence before completion or verification claims |
| `why` | Investigate explicitly requested historical rationale with calibrated source evidence |
| `writing-for-agents` | Reference for authoring documents agents consume: skills, subagent prompts, instructions, and pointer architecture |
| `writing-for-humans` | Draft reader-centered prose, including emails, announcements, posts, release notes, and product copy, and apply the non-invention finish pass |
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

The writing and visual family is maintained in oc-arkive. `unslop` is the shared philosophy and router, and every Hive role is asked to load it (see [Default auto-load skills](#per-agent-skills) below). It selects the depth skills by case: `writing-for-humans` owns drafting and the finish pass, `stop-slop` owns staging/cadence/structure repair, `humanizer` owns the rewrite workflow for existing prose (rewrite, interview, and notes modes, a focused audit of an agent's own or supplied draft, a fact audit, and an optional `check.py` sweep) plus vocabulary/register/attribution/formatting repair, and `stop-design-slop` carries the visual foundation. Depth skills load only on their triggers. `pr-writing` retains its artifact and publication contract, and `writing-for-agents` retains instruction-authoring ownership.

`writing-policy` no longer ships and has no alias: `unslop` replaced it. A personal copy at `~/.agents/skills/writing-policy/` is outside the package, is not migrated or removed, and nothing in oc-arkive loads it now; references to `writing-policy` in your own instructions, constraints, or agent configuration find only that personal copy, if you keep one. A personal `stop-design-slop` skill (for example `~/.agents/skills/stop-design-slop/`) is a same-name native skill, so it takes precedence over the bundled `stop-design-slop` until you remove it. Moving to the bundled foundation is a separate step that the operator takes by hand; oc-arkive migrates nothing automatically.

`code-design-principles` deepens the existing Engineering Judgment block at material design decisions without another workflow or finding bar. `how` and `why` serve explicit explanation and historical-rationale requests; ordinary debugging, future design selection, and routine implementation orientation retain their existing owners.

`modern-web-guidance` holds 208 guides from GoogleChrome's modern-web-guidance v1.0.0 release as local Markdown, with category indexes for search and no CLI or network access. The Engineering Judgment block names it as a conditional load for UI/UX audits, frontend modernization, and browser-facing HTML, CSS, DOM, forms, client-side JavaScript, accessibility, Core Web Vitals, and browser security work; backend, infrastructure, build-tool configuration, and copy-only edits do not trigger it. For a named component or a scoped change, it enforces the guides on touched code. For a codebase UI/UX audit or modernization, it runs a legacy-pattern pass and then a seven-axis pass over UX, semantics, CSS, forms, motion, accessibility and performance, and security. `stop-design-slop` pairs with it there: `stop-design-slop` decides visual composition and hierarchy, and `modern-web-guidance` decides the platform primitives and their fallbacks. A project's `.mwgrc` sets its browser-support baseline and whether Origin Trial or volatile APIs may be adopted.

See [Skill ownership](docs/SKILL-OWNERSHIP.md) for the responsibility map and source-preserving maintenance guidance.

**URL-scan conservative behavior:** If configured `skills.urls` cannot be scanned for conflicts (invalid response, network error), Hive skips bundled skill materialization and Hive bundled autoload guidance for that run and logs a warning rather than risking a native conflict. Local native skills discovered before the URL failure can still be advertised in guidance; partially scanned URL skills are not advertised.

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
| `forager-investigator` | `verification` |
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
| `dash-reviewer` | (none) |
| `vulnerability-review-primary` | (none) |

Every role in this table and every custom agent are also asked to load `unslop` first. It is added when guidance is composed rather than listed in `autoLoadSkills`, so it does not appear in the table, listing it adds nothing, and a custom agent does not repeat it. `disableSkills: ["unslop"]` removes the bundled skill from materialization and guidance without a warning per role; a native or user skill named `unslop` takes precedence, as for any name. The guidance asks the agent to load the skill before covered work and does not preload or enforce it; the skill's own routing then decides which depth skills a case needs.

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

- `baseAgent`: one of `scout-researcher`, `forager-worker`, `forager-investigator`, `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor`, or `vulnerability-reviewer`
- `description`: required non-whitespace delegation guidance injected into eligible primary planner/orchestrator prompts

Custom subagents are scoped routing specialists, not model-upgrade switches. Primary agents choose them autonomously when their description is a closer match for the requested output, task domain, workflow, artifact type, or concrete review/approach risk. They keep the built-in base agent when no configured description is a closer fit. A custom description specializes routing within the inherited base role; it cannot expand that role or override its prompt, tool, or permission boundaries. Candidate-specific conditions in an individual description still apply, including a condition that the candidate may be selected only when the operator explicitly names it. Importance, size, generic complexity, quality sensitivity, and a stronger model are not routing reasons. At runtime, custom agent entries with reserved names, IDs containing native permission wildcard characters (`*` or `?`), non-object declarations, unsupported `baseAgent` values, or missing, blank, or whitespace-only `description` values are skipped with warnings.

The same eight built-in bases allow an optional routing-description override under the existing `agents` map. Nonblank values are trimmed before publication. Omitted, blank, or whitespace-only values inherit the canonical default without dropping unrelated settings on that built-in. Putting `description` on a non-customizable built-in invalidates the stored global config. At runtime, Agent Hive rejects the entire stored config and falls back to defaults, so unrelated stored settings are ignored until the config is corrected. The runtime skip behavior above does not promise a per-entry fallback for arbitrary schema-invalid optional fields. Custom agents never inherit a base description; every custom entry must supply its own non-whitespace description.

| Configurable base | Canonical default description |
|-------------------|-------------------------------|
| `scout-researcher` | Retrieves bounded internal or external code, context, and data evidence without owning diagnosis, tradeoffs, or solution selection. |
| `forager-worker` | Implements and verifies delegated work in its assigned workspace, including diagnosis coupled to that implementation; any diagnosis-only assignment stays report-only. |
| `forager-investigator` | Runs standalone diagnosis, experiments, and verify-only checks, using a disposable placement when a run changes source, and returns evidence and conclusions, never a product patch. |
| `plan-reviewer` | Default for ordinary plan review covering worker readiness, references, dependencies, and executable verification. |
| `code-reviewer` | Default for ordinary implementation review covering correctness, tests, risk, scope creep, YAGNI, and dead code. |
| `simplicity-reviewer` | Default for ordinary post-implementation simplicity review covering unnecessary abstractions, duplication, dead code, and safe deletion. |
| `approach-advisor` | Default for ordinary read-only approach advice on technical direction, architecture, debugging, and tradeoffs. |
| `vulnerability-reviewer` | Default for application-security review focused on evidenced attacker-to-impact paths and root-cause triage. |

Primary orchestrators, `hive-builder`, `hive-helper`, `architect-planner`, the hidden review primaries `dash-reviewer` and `vulnerability-review-primary`, private `__hive_*` identities, and generated review lanes do not expose description overrides.

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
| `variant` | Inherits the resolved base agent's Hive variant, unless the custom agent sets a different `model`; a variant needs a Hive model from the custom agent or its base. See [Agent models](#agent-models) |
| `autoLoadSkills` | Merges with base agent auto-load defaults/overrides and de-duplicates (including the universal `unslop`). `disableSkills` only suppresses Hive bundled guidance/materialization, not native/user skills with the same name. |

ID guardrails:

- `customAgents` keys cannot reuse built-in Hive agent IDs, including the hidden review primaries `dash-reviewer` and `vulnerability-review-primary`; neither review primary can be a `baseAgent`
- native `general`/`explore` are reserved; rename a colliding custom reviewer (for example to `reviewer-dashboard`) while retaining its supported base
- custom agent IDs cannot contain native permission wildcard characters (`*` or `?`)
- plugin-reserved aliases are blocked (`hive`, `architect`, `swarm`, `scout`, `forager`, `hygienic`, `hygienic-reviewer`, `receiver`)
- operational IDs are blocked (`build`, `builder`, `plan`, `code`)

Compaction classification follows the base agent:

- `scout-researcher` derivatives are treated as `subagent`
- `forager-worker` derivatives are treated as `task-worker`
- `forager-investigator` derivatives are treated as `subagent`; they get the route snapshot but never a Forager task brief
- `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor`, and `vulnerability-reviewer` derivatives are treated as `subagent`

This ensures custom workers recover with the same execution constraints as their base role.

### Agent models

Hive ships no model for any role. A built-in role, custom agent or recovery summarizer with neither `model` nor `variant` in `~/.config/opencode/agent_hive.json` uses OpenCode's own model selection, so Hive runs on whichever providers you have connected.

- **Native inheritance.** On v1, a role without a Hive model gets no `model` in its agent entry, so OpenCode uses the model chosen for the prompt or session, or your configured default, and a child task uses its parent's model and variant. On v2, a primary session uses the session model or the host default, a fresh subagent of a Hive role or custom agent uses the agent's effective model, then its parent's model (a continued child keeps its model), and an agent-bound command uses the agent's effective native model. Hive never pins an unconfigured role at startup or request time.
- **Explicit choices.** Set `model` (`provider/model-id`) to pin a role, optionally with a `variant`. A variant needs an explicit Hive model on the same effective declaration: the role's global entry, its project override, or, for a custom agent, its Hive base role. An OpenCode agent, session or default model never completes it. If it is incomplete, or a supplied `model` or `variant` is blank or malformed, the plugin stops at startup with an error that names the file, the property path and the fix (set the model, or remove the variant), without echoing values.
- **Project overrides and global writes.** A project override can complete a global fragment: a project `model` for a global `variant`, or the reverse. When Hive itself writes the global file (first-run creation on v1, or a settings update), it checks that file on its own, so the stored global configuration never depends on one project.
- **Review primaries.** `dash-reviewer` and `vulnerability-review-primary` accept `model`, `variant` and `autoLoadSkills` under `agents` in `agent_hive.json`, and `model` and `variant` in `.hive/agent-hive.override.json`, like the other primaries. When one of them has a configured model, `/dash-review` and `/test-audit` (for `dash-reviewer`) or `/vuln-review` (for `vulnerability-review-primary`) switch the session to that model; without one, the command keeps the session's current model.
- **Custom agents.** An omitted custom `model` inherits the base role's Hive model, including the base's project override. An omitted custom `variant` inherits the base role's variant only while no later layer changes the model, as the next item describes. A native OpenCode override of the base agent is not copied into the custom agent.
- **Model changes clear the variant.** Hive applies `model` and `variant` in layers: for a built-in role, the global entry then its project override; for a custom agent, its base role's effective settings, then its global declaration, then its project override. At each layer a supplied `variant` wins. A supplied `model` that differs from the model so far, compared as the complete trimmed `provider/model-id` including case and every slash, clears the variant so far, because a variant belongs to one model; set a `variant` in the same layer to choose one. An omitted or identical `model`, or a first `model` for a variant-only entry, keeps it. A cleared variant stays cleared, even when a project `model` switches a custom agent back to its base model. For example, with `code-reviewer` at `openai/gpt-6.2-sol` + `xhigh`, a custom agent with `"model": "9router/ag/gemini-4-neon-high"` and no `variant` runs on that model's default variant instead of `xhigh`. An invalid variant that a model change would clear is still reported as an error.
- **Native precedence.** On v2, your native settings for an agent still win over a valid Hive model and replace the whole model reference, including its variant. On v1, Hive's entries replace native entries with the same agent ID.
- **Subagent model control (v2).** A `subagent()` call that sets `model` for a built-in Hive role or a custom agent is refused before the host runs it, whichever agent calls and whatever the value, including the configured model itself or a `#variant`; no child or binding is created, and the call succeeds when repeated without `model`. A continuation (`sessionID`) on the child's current agent must find the child on that agent's effective model and variant, as the host's agent entry reports it with your native settings applied; a missing variant means the model's default variant. Otherwise Hive refuses it with the expected and actual model, and a fresh call without `sessionID` runs on the configured model. If the agent entry cannot be read, the continuation is refused. A continuation that names another agent than the child runs is refused; the agent is judged from the host's session agent as well as the Hive binding. A managed agent with no configured model is not pinned: a fresh child inherits its parent's model and a resumed child keeps the model it had. Native `general`/`explore` and agents Hive does not register accept `model` as the host defines it. This covers the dispatch argument only: configuration files, agent-bound commands, and session APIs or UI that change a session's model directly are outside it.
- **Stored models.** Releases before this one wrote a generated model for every role into the global file. Hive keeps every stored model as written, because a generated value and a deliberate choice look the same. To move a role to native inheritance, delete its `model` and `variant` together.
- **Temperature.** Hive no longer sets sampling. A `temperature` left in `agents`, `customAgents` or `taskTraceSummarizer` is ignored with one warning per read, the rest of the file still applies, and the next full Hive configuration write omits it. Topology-only migration cleanup preserves unrelated stored settings, including `temperature`. Each model's native defaults and your provider, model or variant settings apply.

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
