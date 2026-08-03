# oc-arkive

[![npm version](https://img.shields.io/npm/v/oc-arkive)](https://www.npmjs.com/package/oc-arkive)
[![License: MIT with Commons Clause](https://img.shields.io/badge/License-MIT%20with%20Commons%20Clause-blue.svg)](../../LICENSE)

OpenCode plugin for plan-first development with isolated task execution, review gates, and persistent audit trails.

## Why Hive?

Hive adds a small, strict loop on top of OpenCode: plan, approve, then execute in isolated git worktrees with full audit trails.

## Installation

Add the plugin to `opencode.json`. OpenCode handles npm resolution automatically; you do not need to run `npm install` yourself.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-arkive@latest"]
}
```

## Optional: Enable MCP Research Tools

1. Create `.opencode/mcp-servers.json` using the template:
   - From this repo: `packages/opencode-hive/templates/mcp-servers.json`
   - Or from the installed npm package: `node_modules/oc-arkive/templates/mcp-servers.json`
2. Set `EXA_API_KEY` to enable `websearch_exa` (optional).
3. Restart OpenCode.

This enables tools like `grep_app_searchGitHub`, `context7_query-docs`, `websearch_web_search_exa`, and the official ast-grep MCP tools: `ast_grep_dump_syntax_tree`, `ast_grep_test_match_code_rule`, `ast_grep_find_code`, and `ast_grep_find_code_by_rule`.

The bundled `ast_grep` MCP tools run through the official ast-grep server.

## The Workflow

1. **Create Feature** — `hive_feature_create("dark-mode")`
2. **Write Plan** — AI generates structured plan
3. **Review** — Optional `vscode-arkive` companion for overview/plan review and comments
4. **Approve** — `hive_plan_approve()`
5. **Execute** — Tasks run in isolated git worktrees
6. **Ship** — Clean commits, full audit trail

Modern plans sync numbered tasks only from `## Tasks`. Keep pure release or suite-level checks in `## Final Verification` unless they need a worker to write tracked artifacts.

### Operator Commands

`oc-arkive` registers these slash commands as operator entry prompts. They prepare the active agent with workflow-specific instructions; they do not replace Hive tools or make unavailable tools available to the current agent. `/dash-review` and `/vuln-review` are exceptions: their generated OpenCode commands bind to separate private review primaries.

| Command | Purpose |
|---------|---------|
| `/interview` | Clarify an idea one question at a time before planning. |
| `/implementation-brief` | Produce a copy-paste-ready brief for a later Hive plan. |
| `/hive-plan` | Create or update the Hive feature plan from a spec or brief. |
| `/approve-sync-plan` | Approve the active plan and sync executable tasks. |
| `/start-execution` | Start execution for an approved and synced plan. |
| `/council-directive` | Turn rough input into a reusable directive for a council run. |
| `/council` | Run a read-only council and synthesize a recommendation. |
| `/dash-review [scope]` | Review one frozen disposable workspace without changing implementation source. |
| `/vuln-review [intent] [flags]` | Resolve a conversational scope, then run a findings-first static vulnerability review over one frozen disposable workspace. |
| `/compact-summary` | Produce a compact recovery summary for the current session. |

`/hive` has been removed. Feature creation now belongs to the planning flow and the Hive tools, usually `hive_feature_create` followed by `hive_plan_write`, review, approval, task sync, execution, and merge.

`/council` accepts `/council --group <group> <directive>`. If `--group` is omitted, Hive uses `council.defaultGroup`. Free-text tokens are directive text, not implicit group selectors.

Routing depends on `agentMode`:

| Command set | Unified mode | Dedicated mode |
|-------------|--------------|----------------|
| `/interview`, `/implementation-brief`, `/hive-plan`, `/council-directive`, `/council` | Use `hive-master`. | Route or delegate to `architect-planner`. |
| `/approve-sync-plan`, `/start-execution` | Use `hive-master`. | Route or delegate to `swarm-orchestrator`. |
| `/dash-review` | Bound by `config.command` to a private review primary. | Bound by `config.command` to a private review primary. |
| `/vuln-review` | Bound by `config.command` to a private vulnerability-review primary. | Bound by `config.command` to a private vulnerability-review primary. |
| `/compact-summary` | Use `hive-master`. | Route or delegate to `scout-researcher`. |

Except for `/dash-review` and `/vuln-review`, dedicated-mode slash commands do not switch agents by themselves. If the active agent is not the route target, delegate or reroute to the target agent and stop if that is not possible.

`/dash-review` accepts a branch/ref/range/path/task/feature/description or another coherent implementation target. Arguments win. Without one, it infers the current implementation only when the conversation and Git/Hive context identify a coherent surface; otherwise it asks one clarification question and stops. OpenCode substitutes command templates and expands `!\`...\`` before plugin command hooks run. `/dash-review` therefore never interpolates raw arguments into its template. Its command hook appends the original argument string after expansion as inert review scope data. Shell-style argument fragments are not evaluated.

The inert transport requires `@opencode-ai/plugin >=1.14.48`, which exposes OpenCode's `command.execute.before` hook. Earlier runtimes are not supported because they expand command templates before any safe plugin interception point.

A scope/lead scout constructs the frozen manifest, causal scope, and content-sensitive fingerprint before deep review. Scope contract overrides inherited guidance: all lanes may call universal metadata tools `hive_repositories_status`, `hive_plan_read`, and `hive_status`; the scope lane additionally retains `hive_git_snapshot` and `hive_review_workspace_create`; for legacy single-root omit `repositoryIds` entirely from snapshot/create; for composite use manifest IDs consistently. The scope lane returns `runId`/token without claim/inspect/cleanup. It uses `hive_repositories_status`, the active composite `workspace.json`, `hive_git_snapshot`, and `hive_review_workspace_create` with the same structured scope. After Stage A returns `runId` and `ownershipToken`, the private primary calls `hive_review_workspace_claim` for its session before dispatching deep review lanes. This claim owns inspection, cleanup, and session-deletion cleanup. In a composite workspace, omitted repository IDs select every manifest repository; an explicit selection reports exclusions. A Git root with an unrelated or invalid workspace.json remains single-root; a Git root with a valid Hive composite manifest is rejected as ambiguous.

Each command run creates one shared disposable workspace at `.hive/.worktrees/review/<runId>`. Single repositories use a detached Git worktree. Composite review uses `repos/<repoId>` plus a review-mode workspace.json. Dirty review captures final file bytes, modes, symlinks, additions, deletions, and renames into the detached workspace; it does not replay staged and unstaged patches. Committed refs/ranges materialize the resolved target without overlaying a different live HEAD. The source fingerprint is checked before and after materialization. One retry is allowed; a second mismatch is stale and returns NEEDS_DISCUSSION. Workspace operations use exclusive token-and-PID locks: live locks are never stolen, and a later process can recover only a dead holder. A sealed claimed run is retained while its owner PID is alive; a dead owner is swept. An unclaimed sealed run is retained for its creator PID during a bounded handoff window, then swept when the creator dies or the window expires. Recovery validates the recorded source Git root/common directory before removing a registered worktree. Metadata-less state is preserved and reported. Live drift is non-attributable and generic rollback is not used.

The first response is findings only: it reports scope, coverage gaps, reviewer/model verdicts, execution integrity, and APPROVE, REQUEST_CHANGES, or NEEDS_DISCUSSION. It never creates Hive state or starts fixes.

Untracked content is read sequentially with a 100-file, 2 MiB per-file, 8 MiB aggregate, and five-second capture limit. Crossing a limit fails the snapshot as incomplete; nothing is silently omitted from its fingerprint.

Review lanes are generated from the built-in and eligible configured scout/code/simplicity sources as human-readable `review-<sanitized-source-name>` wrappers. Collisions with existing agent names or sanitized peers get deterministic numeric suffixes; authorization is exact-target only, never by prefix. They preserve each source model, variant, review lens, and skill guidance while denying Hive lifecycle mutations and task recursion. The command renders each target with source identity, description, model, and variant. `/dash-review` uses parallel blocking native `task()` calls only, even when the global background gate is open.

Lanes retain normal local CLI, retrieval, MCP, and configured-tool access inside the disposable workspace. Process cwd remains the live source, so every local-source file/Git/shell/cymbal/build/test/glob/grep/ast-grep/read call must pass an explicit frozen absolute `workdir`/`cwd`, `project_folder`, or absolute path; never rely on default cwd or `cd`. File discovery is manifest-led under the frozen root; do not guess filenames. `edit: deny` is a reviewer-role speed bump, not filesystem immutability, because a CLI can write. The orchestration boundary remains strict: task/delegate recursion is denied; direct Hive feature/task/worktree/merge/commit/context mutation tools are unavailable; only the scope lane may capture/materialize and only the private primary may inspect or clean up. Runtime enforcement keeps pending-session identity and primary task-target checks, rather than maintaining a dash-wide allowlist. Hive Git capture still accepts no raw commands or flags, checks Gitlinks and concealed index paths, and uses fixed read-only Git arguments with bounded hashing.

Deep reviewers and specialists run in parallel against the one workspace. They can use local CLI, retrieval, MCP, and read-only Railway, Vercel, status, log, and diagnostic commands. A dedicated verification code-reviewer executes requested local build/test/lint commands serially and returns the structured command transcript, then the falsifier runs unconditionally in the same workspace. Remote mutation such as deploy, up, promote, push, migrate, database changes, or API writes is prohibited by policy. Source-path escape and remote effects are self-reported boundaries, not technically impossible states; other lanes report exceptional boundaries rather than full command transcripts.

Before synthesis, the private primary inspects the workspace against its materialized baseline and revalidates the identical live source scope. Tracked workspace drift, source drift, materialization mismatch, a self-reported source-path escape, a disclosed remote policy violation, or mandatory lane failure returns NEEDS_DISCUSSION. Ignored live artifacts are not source and are regenerated in serialized verification. Generated review artifacts are reported and discarded. Inspection is followed by unconditional cleanup; cleanup failure reports the derived workspace path and run ID. Session deletion attempts every explicitly claimed run independently and releases a failed claim once before continuing. Later sweeps process each run independently, preserve and report anomalies, and only reclaim stale sealed or incomplete runs after dead-owner validation. No review-local output is copied back to source.

The runtime command agent is the private `__hive_dash_review_primary` identity so a pre-existing `customAgents.dash-reviewer` keeps its public model and variant behavior. The private primary uses the normal OpenCode model resolution path and has no public Hive configuration alias.

For a Hive Builder ad-hoc run, review the existing run or branch, then give a later fix instruction to Hive Builder so it resumes the normal ad-hoc isolation and delegation flow. For a Hive feature run, review the task/feature or branch, then give the active Hive/Swarm primary a later fix instruction so it uses the feature DAG and task worktrees. Findings are review context, never auto-created tasks.

Background instructions appear only when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` is set and the bundled background protocol is available. Use the existing Background Orchestration section and the `background-delegation` skill for the scheduler protocol; command text only points at it when the gate is open. `/dash-review` is a deliberate exception and remains blocking-only.

### Vulnerability Review

`/vuln-review` is for authorized use against source the operator is permitted to assess. It performs a bounded static/local review and does not establish compliance, replace SAST or DAST, prove exhaustive coverage, or establish repository security.

#### Scope and examples

The command accepts free text, recognized flags, a mixture of both, or no arguments. Text and relevant bounded conversation context supply inert intent for one coherent target; no-argument use infers from conversation and current Git/Hive metadata rather than silently selecting current change. Recognized flags are deterministic fixed overrides: inference can fill absent dimensions but cannot replace, widen, or reinterpret a fixed value. Whole-repository scope requires `--whole-repo` or explicit approval of that inferred expansion. Exact examples:

- No arguments (scope inferred): `/vuln-review`
- Current change narrowed by repository and path: `/vuln-review --repo api --path src/auth`
- Git range: `/vuln-review --range main...HEAD`
- Git refs: `/vuln-review --base main --target HEAD`
- Hive task: `/vuln-review --task 03-implement-auth`
- Hive feature: `/vuln-review --feature authentication`
- Whole repository: `/vuln-review --whole-repo`
- Current change compared with a prior report: `/vuln-review --compare approved/prior-review.md`
- Free-text intent: `/vuln-review review the authentication boundary changed in this branch`
- Free text with fixed boundaries: `/vuln-review review authentication --repo api --path src/auth`

Legal combinations:

| Mode | Required mode flag | Other allowed flags |
|------|--------------------|---------------------|
| Current change | No dedicated mode flag; available only when inferred and accepted | Repeatable `--repo <id>`, repeatable `--path <relative-path>`, one `--compare <local-prior-report.md>` |
| Git range | One `--range <base>...<target>` | Repeatable `--repo`, repeatable `--path`, one `--compare` |
| Git refs | One `--base <ref>` | Optional `--target <ref>`, repeatable `--repo`, repeatable `--path`, one `--compare` |
| Hive task | One `--task <task-folder>` | Repeatable `--repo`, repeatable `--path`, one `--compare` |
| Hive feature | One `--feature <feature-name>` | Repeatable `--repo`, repeatable `--path`, one `--compare` |
| Whole repository | `--whole-repo` | Repeatable `--repo`, one `--compare`; `--path` is not allowed |

`--range` cannot be combined with `--base` or `--target`; `--target` requires `--base`. Git mode, task mode, feature mode, and whole-repository mode are mutually exclusive. Singleton flags cannot be repeated. Ordinary positional text, including PR numbers and PR URLs, remains inert intent rather than becoming a provider selector; `--pr` is unsupported. Fetch or check out relevant refs locally, then use local `--base` and optional `--target` refs; the workflow does not call `gh` or another provider CLI.

Current change is one possible canonical mode after inference and acceptance, not a parser default selected by omitting flags.

Stage 1 uses the hard-cut `hive-vuln-review-stage1/v2` schema and returns exactly `BOUNDED`, `NEEDS_CLARIFICATION`, or `STOP`. A clarification stores the complete normalized non-ephemeral proposal, asks at most one question with `Yes` and `No`, and advances only for the exact case-sensitive answer `Yes`. The runtime derives expansion approvals and constructs the expected candidate; attempt 2 may add only the stored clarification and those approvals. Any other resolve-input, target, threat-context, lens, intent, evidence, provenance, comparison, preview, descriptor, create-input, or scope-echo drift stops and revokes materialize authority. `BOUNDED` stores one immutable `AcceptedCandidate`, and the primary emits its exact `scopeEcho`. Only a fresh materialize call that exact-matches that stored candidate may create the workspace; resolve itself cannot create one.

`--compare` is a parser-normalized project-relative regular file bound to the current invocation. The private scope lane never receives its path as tool input: `hive_vulnerability_compare_report_read` accepts no arguments, path, or token. The runtime binds the scope-lane agent from child chat metadata, rechecks the same identity and child lineage at tool context, and permits one read. Replacement, any later task call, error, idle status, session deletion, read failure, or process restart revokes the ephemeral authority.

#### Authorized-use and safety boundary

The workflow performs source review only: no active exploitation, no network scanning or probing, no credential use, no package installation, no shell commands, no scanner execution, no source edits, no external-state mutation, no recursive delegation, and no Hive lifecycle mutation. No product-source, report, SARIF, remediation, or Hive feature/task files are created. Frame does create a disposable frozen workspace and persisted lease metadata for lifecycle safety; cleanup removes the workspace and releases the persisted run state. The workflow produces no automatic fix, remediation, plan, task, worktree outside that disposable review workspace, commit, merge, or patch. Remediation requires separate operator authorization after the review.

The private roles use an exact allowlist:

- The primary can call only `task`, `question`, `hive_review_workspace_claim`, `hive_review_workspace_inspect`, and `hive_review_workspace_cleanup`. Task targets are restricted to the generated private lanes.
- The scope scout can call `read`, `glob`, `grep`, `hive_repositories_status`, `hive_status`, `hive_plan_read`, `hive_git_snapshot`, `hive_vulnerability_compare_report_read`, `hive_review_workspace_create`, `hive_review_workspace_cleanup`, and the approved MCP tools listed below. Its only permitted pre-freeze product input is the invocation-bound optional prior report through the private reader.
- Baseline, specialist, and falsifier lanes can call only `read`, `glob`, `grep`, and the approved MCP tools. Every local operation must use a supplied frozen absolute workspace path, never the live source or process cwd.
- Approved MCP calls are `ast_grep_dump_syntax_tree`, `ast_grep_find_code`, `ast_grep_find_code_by_rule`, `ast_grep_test_match_code_rule`, `context7_resolve-library-id`, `context7_query-docs`, `grep_app_searchGitHub`, and `websearch_web_search_exa`.

External queries may contain only public dependency names and versions or public advisory identifiers such as CVE or GHSA IDs. They must not contain proprietary source, symbols, paths, configuration, logs, or stack traces. Optional MCP unavailability is a coverage gap, not permission to add another tool. The workflow adds zero new scanner dependencies and requires no scanner setup.

Sensitive findings remain in OpenCode session history. No report file or SARIF is written. Operators must apply appropriate session retention and access controls, or manually export the report to an approved location under their own data-handling policy.

#### Stages and evidence

The stages run in this order:

1. **Resolve** combines intent, conversation, and Git/Hive metadata with fixed overrides. It reads an optional comparison report, previews the source, builds threat context, selects zero to two specialist lenses, and returns a bounded candidate, one clarification, or stop. Resolve cannot create a workspace.
2. **Materialize** receives only the stored accepted candidate. It forwards that candidate's create input, then requires strict single-repository or composite descriptor and fingerprint equality across the preview, create result, and live lease before returning `READY`. A second ambiguity, malformed packet, `NEEDS_DISCUSSION`, drift, or cleanup uncertainty stops before claim. Materialize cannot reread the prior report.
3. **Claim** binds the `READY` workspace to the private primary session before deep review starts.
4. **Investigate** runs the mandatory cross-cutting baseline and zero to two selected specialists as fresh blocking lanes. Specialists supplement the baseline and are selected from the observed attack surface, not model prestige.
5. **Challenge** gives every normalized candidate to the fixed falsifier. With no candidates, it tests the bounded hypothesis that no actionable vulnerability exists in the reviewed scope. A falsifier-originated suspicion remains unresolved and cannot become a confirmed finding in that run.
6. **Inspect and cleanup** checks the materialized baseline, new-untracked state, and live-source stability, then attempts cleanup unconditionally. Drift, unavailable integrity evidence, policy violations, omitted scope, truncation, or cleanup uncertainty makes the run `INCOMPLETE` without discarding already confirmed evidence.
7. **Synthesize and report** groups confirmed findings by root cause, orders them by severity, records coverage and integrity limits, and returns the report in the session only.

The source preview applies vulnerability-only preview normalization so internal Hive review state does not alter the accepted fingerprint. This is not a public `excludePaths` option and does not change `/dash-review`. Materialize preserves the public create schema and requires exact descriptor, source fingerprint, and ordered per-repository fingerprint equality for both single and composite workspaces.

A failed mandatory baseline or falsifier gets one fresh retry. A repeated mandatory failure, any selected specialist failure, declined required expansion, integrity failure, or cleanup uncertainty produces `INCOMPLETE`.

#### Report contract

The report starts with these case-sensitive metadata lines:

```text
Schema: hive-vuln-review/v1
Scope mode: <current-change|git-comparison|hive-task|hive-feature|whole-repository>
Scope fingerprint: sha256:<64 lowercase hex>
Source fingerprint: sha256:<64 lowercase hex>
Repositories: <sorted comma-separated IDs>
Paths: <canonical JSON string array>
Comparison base: <selector-or-none>
Hive scope: <task:name|feature:name|none>
Selected lenses: <canonical JSON string array>
Prior comparison: <not-requested|skipped:reason|comparable>
```

Canonical arrays are JSON-escaped, code-point sorted, deduplicated, and contain no extra whitespace. The scope fingerprint hashes canonical scope identity in this key order: schema, mode, repositories, paths, comparison base, and Hive scope. The source fingerprint separately covers resolved commits and captured dirty content. The report then contains `Scope`, `Threat Context`, `Findings`, `Coverage Gaps`, `Rejected Leads`, `Unresolved Leads`, `Re-review Classification`, `Review Lanes`, `Integrity`, and `State`, in that order. Scope metadata records normalized selectors, repositories, refs, paths, fingerprints, Hive identity, and prior-report status. Review-lane metadata lists only agents, models, variants, and lenses that actually ran.

Every confirmed finding includes a display ID, Root-cause key, severity, locations, evidence, attacker-to-impact path, impact, exploitability stance, confidence, fix direction without a patch, variants, producing lens, and falsifier disposition. The Root-cause key has four `::`-separated, `encodeURIComponent`-encoded segments: manifest repository ID; POSIX-normalized repository-relative primary path; trimmed case-preserving symbol or boundary; and lowercase ASCII missing-control slug. To build the slug, each non-`[a-z0-9]` run becomes one hyphen and edge hyphens are removed. The key excludes line numbers and run-local display IDs.

Prior comparison runs only for a supported `hive-vuln-review/v1` report with complete scope/source/lens metadata and Root-cause keys. Scope mode, repositories, paths, comparison base, and task/feature identity must match exactly. Otherwise the report says `comparison skipped` with a reason and assigns no per-finding classification. For comparable reports, `new` is a current key not present before and `unchanged` is a key still confirmed. `resolved` requires changed source plus explicit re-examination of the prior location, exploit preconditions, and prior or equivalent coverage. An absent prior key is `stale` when any resolution precondition is missing; same-source or nondeterministic absence never proves resolution.

The report ends with exactly one state: `CONFIRMED_FINDINGS`, `NO_CONFIRMED_FINDINGS_IN_REVIEWED_SCOPE`, or `INCOMPLETE`. `INCOMPLETE` takes precedence over a clean state, but confirmed findings remain visible when attribution or cleanup later fails.

#### Models and specialists

The four built-in specialist lenses are:

- `trust-and-identity`: authentication, authorization, tenant/object isolation, session, and privilege boundaries.
- `untrusted-data`: parsing, injection, deserialization, path, process, template, and database boundaries.
- `secrets-and-platform`: cryptography, secrets/configuration, dependencies, CI/IaC, cloud, and container exposure.
- `stateful-abuse`: replay, races/TOCTOU, workflow bypass, business logic, and state-transition invariants.

The workflow uses OpenCode's normal provider/model resolution. It adds no model-provider SDK, credential setup, or provider-specific CLI dependency beyond the operator's existing OpenCode configuration. A different configured model or variant is allowed, but the report says multi-model only when different model identities actually ran.

Custom agents with `baseAgent: "vulnerability-reviewer"` become selectable private specialists when their descriptions match the observed risk. They inherit the configured base model, variant, and temperature unless overridden. They cannot replace the mandatory baseline or the fixed falsifier, change the tool allowlist, or bypass workspace and report gates.

### Planning-mode delegation

During planning, "don't execute" means "don't implement" (no code edits, no worktrees). Read-only exploration is explicitly allowed and encouraged, both via local tools and by delegating to Scout.

When delegation is warranted, synthesize the task before handing it off: name the file paths or search target, state the expected result, and say what done looks like. Workers do not inherit planner context.

Each native `task()` launch has one primary goal, starts one fresh subagent session, and ends with one terminal handoff. A primary goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step. Give complete constraints and acceptance criteria only for that goal, then split independently verifiable outcomes into fresh launches. Never pass `task_id` to `task()`: returned IDs are observe-only handles for status, reconciliation, cancellation, and direct-child trace inspection. Recovery context from `hive_task_trace` belongs in a NEW task without `task_id`. Do not send a follow-up prompt to a completed, failed, or blocked session. Compaction may re-anchor a currently running worker; it is not re-delegation.

One implementation assignment normally maps to one numbered task. Amend the DAG or create an append-only manual task for a new independent deliverable. A blocked feature continuation starts a new worker session in the same worktree with the operator decision. Failed or retry work starts a new worker with a concise self-contained handoff. For ad-hoc work, use multiple fresh one-goal launches with disjoint path ownership or sequence overlapping writers. Subagents are terminal and cannot recurse, except a delegated `architect-planner` may launch one level of read-only Scout, plan-reviewer, and approach-advisor helpers; those children cannot delegate. The `question` tool is reserved for primary sessions. Any subagent that needs operator clarification returns the exact question in its terminal response for the parent orchestrator to ask.

For execution work, treat worker output as evidence to inspect, not proof to trust blindly. OpenCode is the supported execution runtime; if you use `vscode-arkive`, treat it as a review/sidebar companion. Read changed files yourself and run the shared verification commands on the main branch before claiming the batch is complete.

### Local skill and model use cases

- **Local skill experiments:** keep a skill in `<project>/.opencode/skills/<id>/SKILL.md` or `<project>/.claude/skills/<id>/SKILL.md`, then load it with OpenCode's native `skill` tool, reference it in agent instructions, or list its frontmatter `name` in `autoLoadSkills`. User file skills are discovered through OpenCode's native `.opencode`, `.claude`, `.agents`, `skills.paths`, and `skills.urls` mechanisms.
- **Runtime configuration:** set global agent models, variants, sandbox policy, custom agents, task-trace summarizer settings, and skill auto-load settings in `~/.config/opencode/agent_hive.json`. `taskTraceSummarizer` accepts optional nonempty `model`/`variant` strings and `temperature` from 0 through 2; omitted model/variant use OpenCode defaults and temperature defaults to 0. Repository topology lives in `<project>/.hive/repositories.json`; legacy global topology fields are migration-only.

#### Canonical Delegation Threshold

- Delegate to Scout when you cannot name the file path upfront, expect to inspect 2+ files, or the question is open-ended ("how/where does X work?").
- Local `read`/`grep`/`glob` is acceptable only for a single known file and a bounded question.

## Tools

### Feature Management
| Tool | Description |
|------|-------------|
| `hive_feature_create` | Create a new feature |
| `hive_feature_complete` | Mark feature as complete |

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
| `hive_task_update` | Update task status/summary |

### Worktree
| Tool | Description |
|------|-------------|
| `hive_worktree_start` | Start normal work on task (creates worktree) |
| `hive_worktree_create` | Launch blocked-task continuation in existing worktree |
| `hive_worktree_commit` | Complete task (applies changes) |
| `hive_worktree_discard` | Abort task (discard changes) |

In gate-open sessions, `hive_worktree_start` may return a `backgroundTaskCall` for independent work. That output is launch guidance only; Hive does not create pending background board state until the parent actually starts the native background task. Use the normal blocking call when the next meaningful step depends on the worker result.

### Merge and Status

| Tool | Description |
|------|-------------|
| `hive_merge` | Merge a completed task branch, with merge/squash/rebase strategies, optional conflict preservation, and optional cleanup |
| `hive_status` | Inspect feature state, including task/worktree-aware merge eligibility through `helperStatus.mergeEligibility` |

When a task branch has no net tracked changes to integrate, `hive_merge` reports a successful no-op: `success: true`, `merged: false`, `reasonCode: 'NO_TRACKED_CHANGES'`, and no empty `sha`. Requested cleanup can still run when safe. Use `hive_status`, not the background board, to decide whether a task has completed work and a live worktree eligible for merge or cleanup.

### Ad-hoc Worktree

Hive Builder uses `hive_adhoc_*` tools for isolated non-feature work under `.hive/.worktrees/adhoc/<runId>`. These runs do not create feature/task records and do not appear in `hive_status`. Hive Builder is an ad-hoc orchestrator in both gate-closed and gate-open sessions; gate-closed sessions return blocking `taskToolCall` payloads, while gate-open sessions return both `taskToolCall` and `backgroundTaskCall` (identical except `background: true`) so blocking remains available when the next step depends on the worker. `hive_adhoc_worktree_create` accepts `autoSpawnWorker`, default `true`; set it to `false` only for inspection, routing, or setup-only worktrees where no worker should auto-launch. See `docs/HIVE-TOOLS.md` for the full tool contracts.

### Background Orchestration

With the env gate unset (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`), Hive keeps normal blocking `task()` wait mode. Background board tools report `background_tools_disabled`, and no background appendix is injected into primary prompts.

With the env gate set, primary orchestrators receive delegate-first background scheduling guidance and the board tools are active. This is the background-first scheduler contract under the experimental gate, not always-on behavior. It does not add agents or change custom-agent preservation: primary agents still choose built-in or configured custom specialists by descriptor, not by a fixed routing table.

Gate-open orchestration uses lane kind to decide how much management is needed. Exploratory/read-only and review lanes are lightweight background candidates. Writing/change and execution lanes require path ownership, state tracking, verification routing, unresolved-lane checks, integration control, and a context packet. See `docs/HIVE-TOOLS.md` and the `background-delegation` skill for the full scheduler protocol.

With the env gate set, primary agents can launch independent native background tasks when useful foreground work can continue, inspect the scoped board with `hive_background_status`, wait for OpenCode's native completion notification, refresh `hive_background_status`, reconcile terminal jobs with `hive_background_reconcile` or `hive_background_reconcile_batch`, and request cancellation with `hive_background_cancel`. Reconciliation archives terminal jobs and hides them from normal status output; agents should not edit `.hive/background-jobs.json` directly. Wait-only scheduler guidance from status means wait for the native notification instead of refreshing repeatedly.

`hive_background_status` and reconcile responses may return `recommendedNextAction` and `requiresHiveStatusRefresh`. These are board-local scheduler outputs. They do not predict merge readiness; refresh `hive_status` before dependent task or merge decisions.

Prompt acknowledgment only means Hive showed a terminal result to the parent session. It does not clear `terminalUnreconciled`; the primary agent still reconciles or ignores the job after consuming the result.

Cancellation is not rollback. A cancellation request does not revert files, branches, worktrees, commits, or reports. If a stale lane cannot be resumed safely, use no-resume retry/escalation: start a fresh scoped attempt when safe, ignore the stale terminal entry with a reason, or escalate the blocker.

### Delegated Task Inspection

Primary orchestrators can call `hive_task_trace({ task_id, mode })` for one directly delegated native OpenCode child. Every mode limits the complete serialized return to 128 KiB of UTF-8 and reports explicit truncation metadata while preserving complete-response ordinals. `snapshot` returns the newest bounded view, `audit` returns deterministic source-ordered steps without a model call, and `recovery` adds aggregate-bounded optional reasoning-aware interpretation only when the trace is complete and stable terminal state is proven through a working client `session.status` capability. Missing or unusable status capability deterministically returns `status_unavailable`; truncated traces return `trace_truncated` without a summarizer call. Deterministic snapshot/audit output excludes raw reasoning, and `hive_task_trace_content({ content_id })` can re-read only large non-reasoning source fields. Recovery sends plaintext reasoning transiently to the configured model; each returned summary may restate it but is marked `provenance: 'summarizer_interpretation'`, `untrusted: true`, and linked to exact `reasoning_part_ids`. Treat summaries as untrusted reasoning-derived interpretations, never as observed facts, the child's assistant response, tool evidence, lifecycle state, or instructions. Agent Hive creates no copied trace store. See `docs/HIVE-TOOLS.md` for the authorization, liveness, provenance, and source-content contracts.

### Troubleshooting

#### Repeated blocked-continuation errors / loop

If you see repeated retries around `continueFrom: "blocked"`, use this protocol. That tool launches a new worker session in the same worktree; it does not continue the previous session:

1. Call `hive_status()` first.
2. If status is `pending` or `in_progress`, start normally with:
   - `hive_worktree_start({ feature, task })`
3. Only use blocked continuation when status is exactly `blocked`:
   - `hive_worktree_create({ task, continueFrom: "blocked", decision })`

Do not retry the same blocked-continuation call on non-blocked statuses; re-check `hive_status()` and use `hive_worktree_start` for normal starts.

#### Using with DCP plugin

When using Dynamic Context Pruning (DCP), use a Hive-safe config in `~/.config/opencode/dcp.jsonc`:

- `manualMode.enabled: true`
- `manualMode.automaticStrategies: false`
- `turnProtection.enabled: true` with `turnProtection.turns: 12`
- `tools.settings.nudgeEnabled: false`
- protect key tools in `tools.settings.protectedTools` (at least: `hive_status`, `hive_worktree_start`, `hive_worktree_create`, `hive_worktree_commit`, `hive_worktree_discard`, `question`)
- disable aggressive auto strategies:
  - `strategies.deduplication.enabled: false`
  - `strategies.supersedeWrites.enabled: false`
  - `strategies.purgeErrors.enabled: false`

For normal usage, set the OpenCode plugin entry to `"oc-arkive@latest"`. Keep a local file path entry only for contributor testing with a checkout.

### Task worker recovery

After session compaction, task workers re-read `worker-prompt.md` and continue from the current worktree state. Compaction may re-anchor a currently running worker; it is not re-delegation. Primary and subagent sessions replay the stored user directive once, then escalate if needed.

Manual tasks created with `hive_task_create()` follow the same DAG model as plan-backed tasks. The `goal`, `description`, `acceptanceCriteria`, `files`, and `references` fields are turned into `spec.md` content visible to the worker. To change downstream sequencing or scope after review feedback, update `plan.md` and run `hive_tasks_sync({ refreshPending: true })`.

`hive-helper` is a runtime-only bounded assistant for merge recovery, state clarification, interrupted-state wrap-up, and safe manual-follow-up assistance. It stays within the current approved DAG boundary and does not appear in `.github/agents/`.

`simplicity-reviewer` is a built-in read-only reviewer for final post-implementation cleanup. It reviews completed diffs for YAGNI, dead code, duplication, unnecessary abstractions, redundant defensive code, and safe deletion-biased simplification. It is not a custom-agent base; use it directly when a simplicity pass is needed.

## Prompt Budgeting & Observability

Hive automatically bounds worker prompt sizes to prevent context overflow and tool output truncation.

### Budgeting Defaults

| Limit | Default | Description |
|-------|---------|-------------|
| `maxTasks` | 10 | Number of previous tasks included |
| `maxSummaryChars` | 2,000 | Max chars per task summary |
| `maxContextChars` | 20,000 | Max chars per context file |
| `maxTotalContextChars` | 60,000 | Total context budget |

When limits are exceeded, content is truncated with `...[truncated]` markers and file path hints are provided so workers can read the full content.

### Observability

`hive_worktree_start` and blocked-resume `hive_worktree_create` output include metadata fields:

- **`promptMeta`**: Character counts for plan, context, previousTasks, spec, workerPrompt
- **`payloadMeta`**: JSON payload size, whether prompt is inlined or referenced by file
- **`budgetApplied`**: Budget limits, tasks included/dropped, path hints for dropped content
- **`warnings`**: Array of threshold exceedances with severity levels (info/warning/critical)

### Prompt Files

Large prompts are written to `.hive/features/<feature>/tasks/<task>/worker-prompt.md` and passed by file reference (`workerPromptPath`) rather than inlined in tool output. This prevents truncation of large prompts.

That same `worker-prompt.md` path is also reused during compaction recovery so task workers can re-anchor to the exact task assignment after a compacted session resumes.

## Plan Format

```markdown
# Feature Name

## Overview
What we're building and why.

## Tasks

### 1. Task Name
Description of what to do.

### 2. Another Task
Description.

## Final Verification

- Run the full test suite after task branches are merged.
```

`hive_tasks_sync` reads numbered task headings from `## Tasks` in modern plans. A final verification section stays outside the task DAG unless the verification itself needs tracked artifacts produced by a task.

## Configuration

Hive reads runtime configuration only from `~/.config/opencode/agent_hive.json`. Project-local `.hive/agent-hive.json` and `.opencode/agent_hive.json` files are ignored, including malformed files. Global config failures still produce a runtime warning and fall back to defaults.

All runtime policy, agent definitions, and auto-load skill settings use the global file. Repository topology is project-local in `<project>/.hive/repositories.json`; entry paths are relative to the canonical project root and cannot escape it. Legacy global `repositoryRoot` and `repositories` fields remain accepted only as migration input for `hive_repositories_update`.

### Council config

Council settings live in `~/.config/opencode/agent_hive.json`.

Built-in council defaults are read-only and portable:

| Group | Purpose | Default members |
|-------|---------|-----------------|
| `design` | Architecture and implementation-shape advice. | `scout-researcher`, `approach-advisor`, `plan-reviewer`, `code-reviewer` |
| `decision` | Hard tradeoff decision support. | `scout-researcher`, `approach-advisor`, `plan-reviewer` |
| `minimal-change` | Smallest correct change and cleanup lens. | `scout-researcher`, `simplicity-reviewer`, `code-reviewer` |
| `documents` | Documentation and prose-oriented review. | `scout-researcher`, `code-reviewer`, `plan-reviewer` |

The default `excludedAgents` list excludes mutable orchestration or implementation seats: `hive-master`, `swarm-orchestrator`, `forager-worker`, `hive-builder`, and `hive-helper`. Member names can be built-in stock agents or configured custom agents. Custom agents derived from mutable bases, including `forager-worker`, are skipped by default with warnings.

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

### Project-local repository manifest example

Add the manifest to `<project>/.hive/repositories.json`:

```json
{
  "schemaVersion": 1,
  "repositories": [
    { "id": "api", "path": "./api" }
  ]
}
```

### Global-only: Disable Skills or MCPs

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json",
  "disableSkills": ["brainstorming", "writing-plans"],
  "disableMcps": ["websearch", "ast_grep"]
}
```

#### Available Skills

| ID | Description |
|----|-------------|
| `brainstorming` | Use before any creative work. Explores user intent, requirements, and design through collaborative dialogue before implementation. |
| `writing-plans` | Use when you have a spec or requirements for a multi-step task. Creates detailed implementation plans with worker-branch tasks. |
| `executing-plans` | Use when you have a written implementation plan. Executes tasks in batches with review checkpoints. |
| `dispatching-parallel-agents` | Use when facing 2+ independent tasks. Dispatches multiple agents to work concurrently on unrelated problems. |
| `test-driven-development` | Use when implementing any feature or bugfix. Enforces write-test-first, red-green-refactor cycle. |
| `systematic-debugging` | Use when encountering any bug or test failure. Requires root cause investigation before proposing fixes. |
| `code-reviewer` | Deprecated compatibility wrapper. Use the `code-reviewer` subagent for implementation review. |
| `verification` | Use before claiming work is complete or when independently checking an implementation against a plan. Requires fresh command output before success claims. |
| `background-delegation` | Use when opencode background subagents are available (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`). Defines the env-gated background wait-mode and board protocol, including board status, reconciliation, and cancellation. Not loaded as a default `autoLoadSkills` entry; the env flag appends an on-demand reference only. |

#### Available MCPs

| ID | Description | Requirements |
|----|-------------|--------------|
| `websearch` | Web search via [Exa AI](https://exa.ai). Real-time web searches and content scraping. | Set `EXA_API_KEY` env var |
| `context7` | Library documentation lookup via [Context7](https://context7.com). Query up-to-date docs for any programming library. | None |
| `grep_app` | GitHub code search via [grep.app](https://grep.app). Find real-world code examples from public repositories. | None |
| `ast_grep` | AST-aware code search and replace via [ast-grep](https://ast-grep.github.io). Pattern matching across 25+ languages. | None (runs via npx) |

### Per-Agent Skills

Skills are loaded through OpenCode's native `skill` tool, not through a Hive plugin tool. Hive bundles are materialized into the global OpenCode config directory under `agent-hive/generated/opencode-skills/<hash>/` at startup and registered via `opencodeConfig.skills.paths` ahead of any user-configured paths.

**Configuration fields:**

| Field | Behavior |
|-------|----------|
| `skills` | Legacy field kept for config compatibility. Native skill visibility is controlled by OpenCode registration and `disableSkills`, not by per-agent allowlists. |
| `autoLoadSkills` | Adds high-priority prompt guidance telling the agent to load named OpenCode-native skills with the `skill` tool before work covered by them. |
| `disableSkills` (global) | Disables Hive bundled materialization and Hive bundled autoload only. User or native skills with the same name are not blocked. |

**User file skills** should be configured through OpenCode's native `.opencode`, `.claude`, `.agents`, `skills.paths`, or `skills.urls` discovery. They can be loaded manually with the native `skill` tool or advertised to an agent by adding the skill's frontmatter `name` to `autoLoadSkills`. Native/user skills take precedence over Hive bundled skills with the same name.

**URL-scan conservative behavior:** If configured `skills.urls` cannot be scanned for conflicts (invalid response, network error), Hive skips bundled skill materialization and Hive bundled autoload guidance for that run and logs a warning rather than risking a native conflict. Local native skills discovered before the URL failure can still be advertised in guidance; partially scanned URL skills are not advertised.

`background-delegation` is bundled and materialized like other Hive skills, but primary prompt references are env-gated and compact. Delegation-first orchestration lives in the base primary prompts; when the env flag is set, primary agent prompts add background wait-mode and board protocol guidance and point to the skill for the full protocol. The skill can still be loaded manually with OpenCode's native `skill` tool like any other bundled or user skill.

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
- User `autoLoadSkills` are **merged** with defaults (use global `disableSkills` to remove defaults from autoload)

**Default auto-load skills by agent:**

| Agent | autoLoadSkills default |
|-------|------------------------|
| `hive-master` | `parallel-exploration` |
| `forager-worker` | `test-driven-development`, `verification` |
| `hive-builder` | `verification`, `parallel-exploration` |
| `hive-helper` | (none) |
| `scout-researcher` | (none) |
| `architect-planner` | `parallel-exploration` |
| `swarm-orchestrator` | `parallel-exploration` |
| `plan-reviewer` | (none) |
| `code-reviewer` | (none) |
| `approach-advisor` | (none) |

`background-delegation` is not a default `autoLoadSkills` entry for any agent. For Hive Builder, delegation-first orchestration is in the base prompt; the env flag (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`) only appends background wait-mode and board guidance without adding it to the default autoload set.

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
      "variant": "low"
    }
  }
}
```

The `variant` value must match a key in your OpenCode config at `provider.<provider>.models.<model>.variants`. For example, with Anthropic models you might configure thinking budgets:

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

**Precedence:** If a prompt already has an explicit variant set, the per-agent config acts as a default and will not override it. Invalid or missing variant keys are treated as no-op (the model runs with default settings).

### Custom Derived Subagents

Define plugin-only custom subagents with `customAgents`. Freshly initialized `agent_hive.json` files already include starter template entries under `customAgents`; those seeded `*-example-template` entries are placeholders only, should be renamed or deleted before real use, and are intentionally worded so planners/orchestrators are unlikely to select them as configured. Each custom agent must declare:

- `baseAgent`: one of `scout-researcher`, `forager-worker`, `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor`, or `vulnerability-reviewer`
- `description`: delegation guidance injected into primary planner/orchestrator prompts

Custom subagents are scoped routing specialists, not model-upgrade switches. Primary agents choose them when their description matches the task's domain, workflow, artifact type, or review/approach risk lens, or when the operator explicitly names them. They keep the built-in base agent when no configured description is a closer fit. A stronger model alone is not a routing reason.

`hive-helper` is not a custom base agent. In v1 it stays runtime-only for isolated merge recovery and does not appear in `.github/agents/`.

`simplicity-reviewer` is a custom base agent for specialized cleanup passes. Primary agents still use the built-in `simplicity-reviewer` when no configured simplicity-reviewer-derived custom description is a closer match.

`vulnerability-reviewer` is a custom base agent for selectable `/vuln-review` specialist lenses. Its private wrapper preserves the configured description, model, variant, and temperature while enforcing the vulnerability workflow's read-only tool policy. A custom specialist cannot replace the mandatory baseline or fixed falsifier.

`hive-helper` is also not a network consumer; planning, orchestration, and review roles get network access first.

Published example (validated by `src/e2e/custom-agent-docs-example.test.ts`):

```json
{
  "agents": {
    "scout-researcher": {
      "variant": "low"
    },
    "forager-worker": {
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
      "temperature": 0.2,
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
| `model` | Inherits resolved base agent model (including user overrides in `agents`) |
| `temperature` | Inherits resolved base agent temperature |
| `variant` | Inherits resolved base agent variant |
| `autoLoadSkills` | Merges with base agent auto-load defaults/overrides and de-duplicates. `disableSkills` only suppresses Hive bundled guidance/materialization, not native/user skills with the same name. |

ID guardrails:

- `customAgents` keys cannot reuse built-in Hive agent IDs
- plugin-reserved aliases are blocked (`hive`, `architect`, `swarm`, `scout`, `forager`, `hygienic`, `hygienic-reviewer`, `receiver`)
- operational IDs are blocked (`build`, `plan`, `code`)

Compaction classification follows the base agent:

- `scout-researcher` derivatives are treated as `subagent`
- `forager-worker` derivatives are treated as `task-worker`
- `plan-reviewer`, `code-reviewer`, `approach-advisor`, and `vulnerability-reviewer` derivatives are treated as `subagent`

This ensures custom workers recover with the same execution constraints as their base role.

### Custom Models

Override models for specific agents:

```json
{
  "agents": {
    "hive-master": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "temperature": 0.5
    }
  }
}
```

## Pair with VS Code

For the full OpenCode-first workflow, install `vscode-arkive.vsix` from the GitHub Release as an optional review/sidebar companion for inline comments and document review.

## License

MIT with Commons Clause — Free for personal and non-commercial use. See [LICENSE](../../LICENSE) for details.

---
