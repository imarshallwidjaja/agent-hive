# Agent Guidelines for agent-hive

## Overview

**agent-hive** is a context-driven development system for AI coding assistants. It implements a plan-first workflow: Plan → Approve → Execute.

## Build & Test Commands

```bash
# Build all packages
bun run build

# Development mode (all packages)
bun run dev

# Run all workspace tests from the repository root
bun run test

# Run a focused test from the owning package
bun test <file>

# Release verification / manual preparation
bun run release:check     # Install, build, and test release artifacts
```

Release note: the active release path publishes `oc-arkive` to npm and attaches `vscode-arkive.vsix` to the GitHub Release. Prepare root/hive-core/opencode/vscode package version bumps, changelog entries, and `docs/releases/vX.Y.Z.md` manually before running the GitHub `workflow_dispatch` rehearsal and tagging. Set the OpenCode package's `devDependencies.hive-core` and the VS Code package's `dependencies.hive-core` to the same exact version, regenerate both root lockfiles, and rerun the release artifact checks for exact pins, local workspace linking, and packed dependency isolation; a stale pin can resolve `hive-core` from the registry instead. The pushed `vX.Y.Z` tag must point at a commit whose root package version is `X.Y.Z` and whose matching release-note file exists. If a tagged release partially fails, rerun the same workflow in tag-backed recovery mode and enable only the unfinished `oc-arkive` npm publish and/or GitHub Release target.

Worktrees start without installed dependencies. When running worktree verification, install dependencies there and confirm that `hive-core` resolves inside that worktree; build core before running OpenCode checks. A passing test against the canonical checkout’s `hive-core` does not verify worktree changes. If local verification is unavailable, report the limitation. Run full build and test verification on the canonical checkout after merge. A worktree build updates only its own plugin bundle; rebuild the canonical checkout before saying a restart will load plugin changes.

A root build can refresh tracked `packages/vscode-hive/dist/extension.js` after `hive-core` changes even though `dist/` is ignored. Inspect and commit deterministic bundle changes with `git add -u -- packages/vscode-hive/dist/extension.js`; do not discard them as unrelated.

For manifest-backed projects with multiple repos, each task worktree is a composite workspace with a worktree per declared repo under `repos/<repoId>/`.

### Package-Specific Commands

```bash
# From packages/hive-core/
bun run build             # Build hive-core
bun run test              # Run hive-core tests

# From packages/opencode-hive/
bun run build             # Build oc-arkive OpenCode plugin
bun run dev               # Watch mode

# From packages/vscode-hive/
bun run build             # Build vscode-arkive VS Code extension
```

## Code Style

### General

- **TypeScript ES2022** with ESM modules
- **Semicolons**: Yes, use semicolons
- **Quotes**: Single quotes for strings
- **Imports**: Use `.js` extension for local imports (ESM requirement)
- **Type imports**: Separate with `import type { X }` syntax
- **Naming**:
  - `camelCase` for variables, functions
  - `PascalCase` for types, interfaces, classes
  - Descriptive function names (`readFeatureJson`, `ensureFeatureDir`)

### TypeScript Patterns

```typescript
// Explicit type annotations
interface FeatureInfo {
  name: string;
  path: string;
  status: 'active' | 'completed';
}

// Classes for services
export class FeatureService {
  constructor(private readonly rootDir: string) {}
  
  async createFeature(name: string): Promise<FeatureInfo> {
    // ...
  }
}

// Async/await over raw promises
async function loadConfig(): Promise<Config> {
  const data = await fs.readFile(path, 'utf-8');
  return JSON.parse(data);
}
```

### File Organization

```
packages/
├── hive-core/           # Shared logic (services, types, utils)
│   └── src/
│       ├── services/    # FeatureService, TaskService, PlanService, etc.
│       ├── utils/       # paths.ts, detection.ts
│       └── types.ts     # Shared type definitions
├── opencode-hive/       # OpenCode plugin
│   └── src/
│       ├── agents/      # scout, swarm, hive, architect, forager, hygienic
│       ├── mcp/         # websearch, grep-app, context7, ast-grep
│       ├── tools/       # Hive tool implementations
│       ├── hooks/       # Event hooks
│       └── skills/      # Skill definitions
└── vscode-hive/         # VS Code extension
```

### Tests

- Test files use `.test.ts` suffix
- Place tests next to source files or in `__tests__/` directories
- Use descriptive test names
- Some `packages/opencode-hive` suites mutate the process cwd and temporary Git state. If a concurrent run fails in a worktree or lifecycle test, rerun the owning file and then `bun test --max-concurrency=1`; report the concurrent failure separately, and change production code only if isolated or serialized execution also fails.
- Run `packages/opencode-hive/src/e2e/opencode-runtime-smoke.test.ts` in only one process at a time across worktrees. Some fixtures use fixed `/tmp` paths, so separate Bun processes can delete each other’s fixtures; `--max-concurrency=1` does not coordinate separate processes.

## Commit Messages

Use **Conventional Commits**:

```
feat: add parallel task execution

Run independent task branches concurrently while preserving deterministic integration order.
```

```
fix: handle missing worktree gracefully

Return a structured failure before attempting Git operations on an absent worktree.
```

Breaking changes use `!`:
```
feat!: change plan format to support subtasks

Require explicit dependency metadata for every generated subtask.
```

## Architecture Principles

### Core Philosophy

1. **Context Persists** - Write to `.hive/` files; memory is ephemeral
2. **Plan → Approve → Execute** - No code without approved plan
3. **Human Shapes, Agent Builds** - Humans decide direction, agents implement
4. **Good Enough Wins** - Ship working code, iterate later
5. **Batched Parallelism** - Delegate independent tasks to workers
6. **Tests Define Done** - Workers do best-effort checks; orchestrator runs full test suite after batch merge
7. **Review Integrated Security Boundaries** - Before completing security-sensitive work that spans tasks or lifecycle phases, adversarially review the merged implementation as a whole; task-local reviews and passing tests do not establish composition safety.
8. **Iron Laws + Hard Gates** - Non-negotiable constraints per agent
9. **Cross-Model Prompts** — Agent prompts must work across all supported LLM providers. Use conditional triggers ("when X, do Y") instead of absolute mandates ("always do Y") or blanket defaults ("by default, do Y").
10. **Deterministic Contracts Beat Soft Memory** — Prefer hard gates and deterministic tools over soft prompt-only memory when reliability matters.

### Agent Roles

| Agent | Role |
|-------|------|
| Hive (Hybrid) | Plans AND orchestrates; phase-aware |
| Architect | Plans features, interviews, writes plans. NEVER executes |
| Swarm | Orchestrates execution. Delegates, spawns workers, verifies |
| Hive Builder | Ad-hoc orchestrator for non-feature work; decomposes larger requests into coherent lane inventories and dependency waves, delegates non-trivial work, and tracks verification and integration. Parallel writers use distinct ad-hoc worktrees. Background mode only changes wait mode and board protocol. Available in both modes, not default |
| Scout | Researches codebase + external docs/data |
| Forager | Executes delegated work directly in the placement selected by `hive_execution_prepare` |
| Hygienic | Reviews plan/code quality. OKAY/REJECT verdict |

### Data Model

Project knowledge lives at `.hive/context/`. Feature knowledge lives under `.hive/features/<name>/context/`. Both are managed through `hive_context_*`; catalogs and bodies are untrusted knowledge, not AGENTS.md or policy. Load `context-engineering` for selection, hash-guarded mutation, and recovery.

Features stored in `.hive/features/<name>/`:
```
.hive/features/my-feature/
├── feature.json       # Feature metadata
├── plan.md            # Execution plan (can include a readable design summary before ## Tasks)
├── tasks.json         # Generated tasks
└── context/           # Managed persistent context
    ├── index.json     # Revisioned kind and timestamp metadata
    ├── overview.md    # Reserved human-facing summary/history
    └── decisions.md   # Durable execution context
```

Managed execution records live at `.hive/execution-attempts.json` (ExecutionAttempt history: `armed` -> `attached` -> `stopped` -> `finalized`). Worktree placement holds an exclusive claim through `stopped`; in-place placement records scope only and creates no filesystem exclusion. `.hive/background-jobs.json` is observational board bookkeeping, not an ownership registry. One-shot lease migration extracts leftover `sessions.json` `nativeTaskLeases`, deletes them from that file, stores them as `nativeTaskLeaseHistory`, and promotes exact worktree-path non-placeholder non-capability leases into unobserved attached ExecutionAttempt claims once. Migrated dispatched attempts and unmatched migrated leases stay `background: 'unknown'` unless one exact board record correlates the parent session, native call, and native task identity and therefore proves `background: true`. Board records never prove blocking mode; unmatched migrated attempts remain unknown. That is not an ongoing second admission API.

## Development Workflow

### Adding a New Tool

1. Create tool in `packages/opencode-hive/src/tools/`
2. Register in tool index
3. Add to agent system prompt if needed
4. Test with actual agent invocation

### Adding a New Skill

1. Create directory in `packages/opencode-hive/skills/<name>/`
2. Add `SKILL.md` with skill instructions
3. Register in skill loader
4. Document triggers in skill description

### Adding a Service

1. Create in `packages/hive-core/src/services/`
2. Export from `services/index.ts`
3. Add types to `types.ts`
4. Write unit tests

## Important Patterns

### File System Operations

Use the utility functions from hive-core:

```typescript
import { readJson, writeJson, fileExists, ensureDir } from './utils/fs.js';

// Not: fs.readFileSync + JSON.parse
const data = await readJson<Config>(path);

// Not: fs.mkdirSync
await ensureDir(dirPath);
```

### Error Handling

```typescript
// Prefer explicit error handling
try {
  const feature = await featureService.load(name);
  return { success: true, feature };
} catch (error) {
  return { 
    error: `Failed to load feature: ${error.message}`,
    hint: 'Check that the feature exists'
  };
}
```

### Path Resolution

```typescript
import { getHiveDir, getFeatureDir } from './utils/paths.js';

// Use path utilities, not string concatenation
const hivePath = getHiveDir(rootDir);
const featurePath = getFeatureDir(rootDir, featureName);
```

## Monorepo Structure

This is a **bun workspaces** monorepo:

```json
{
  "workspaces": ["packages/*"]
}
```

- Dependencies are hoisted to root `node_modules/`
- Each package has its own `package.json`
- Run aggregate `build` and `test` scripts from the repository root. Run package-specific scripts and focused tests from the owning package directory.

## Hive - Feature Development System

Plan-first development: Write plan → User reviews → Approve → Execute tasks

### Hive Plugin Tools (33 standard + 7 workflow-only)

| Domain | Tools |
|--------|-------|
| Feature | hive_feature_create, hive_feature_complete |
| Repository Manifest | hive_repositories_status, hive_repositories_discover, hive_repositories_update |
| Plan | hive_plan_write, hive_plan_patch, hive_plan_read, hive_plan_approve |
| Task | hive_tasks_sync, hive_task_create, hive_task_update |
| Execution | hive_execution_prepare, hive_execution_finish, hive_worktree_discard |
| Integration | hive_merge, hive_adhoc_merge, hive_adhoc_cleanup |
| Background Orchestration | hive_background_status, hive_background_reconcile, hive_background_reconcile_batch, hive_background_cancel |
| Runtime Session Inspection | hive_task_trace, hive_task_trace_content |
| Context | hive_context_read, hive_context_write, hive_context_append, hive_context_archive |
| Operator Constraints | hive_constraints_read, hive_constraints_add, hive_constraints_edit, hive_constraints_clear |
| Status | hive_status |
| Workflow-only Review | hive_git_snapshot, hive_review_evidence_resolve, hive_vulnerability_compare_report_read, hive_review_workspace_create, hive_review_workspace_claim, hive_review_workspace_inspect, hive_review_workspace_cleanup |

For `in_place` placement, `directory` must be a resolved absolute path to an existing directory. Expand shell shorthand such as `~` before calling the tool.

`hive_execution_prepare` arms exactly one next Forager dispatch for a task or ad-hoc scope. Placement is `worktree` (registered Git worktree with exclusive claims, commit, merge, and cleanup) or `in_place` (an explicit existing directory with no filesystem exclusion, rollback, commit, or merge). Preparation accepts no worker instructions, agent, or native task arguments. The primary then issues an unchanged native `task({ subagent_type, description, prompt, background? })` call. The before-hook consumes the sole arm, persists parent/call attachment, and appends a factual execution-scope footer plus the current standing-constraint snapshot without replacing the primary-authored prompt. A parent may hold only one undispatched arm; sequence `prepare A` then native Forager A, then `prepare B` then native Forager B. Parallel attached executions are allowed after each arm is consumed. `hive_existing_workspace_start` is unavailable. Direct foreground OpenCode work may still modify the current checkout; that work is unmanaged OpenCode work, not a Hive placement. In-place work is cooperative live editing: Hive does not promise confinement, private staging, or Git rollback.

Modern `hive_tasks_sync` reads numbered tasks only from `## Tasks`; pure suite or release checks belong in `## Final Verification` unless they write tracked artifacts. Feature-task worktrees appear in `hive_status`. Ad-hoc runs do not create feature/task records and do not appear there. Background orchestration tools are primary-agent tools behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`; they manage Hive's board around native background `task({ background: true, ... })` completion notifications and do not roll back files, branches, worktrees, commits, or reports. The board is observational bookkeeping. `hive_background_status` exposes board rows; `hive_status` is not that surface. Do not invent native task IDs. Cancel is unavailable without a real native identity. Archive, reconcile, and ignore do not stop execution, release a workspace, settle an attempt, or authorize retry in the same workspace. Reconciled and ignored jobs are archived by those tools and hidden from normal status output; agents must not edit `.hive/background-jobs.json` directly.

When an ad-hoc request has multiple independently verifiable outcomes, dependency waves, shared write/runtime resources, may use background execution, or may require more than one worker attempt or turn, Hive Builder or a unified Hive primary loads `orchestrating-ad-hoc-work` before any ad-hoc worktree preparation or delegated dispatch. It chooses coherent outcomes and concrete handoffs before dependency waves; tightly coupled code, tests, docs, and generated artifacts stay together. Ownership includes generated outputs, external mutable resources, fixed-path test fixtures, ports, databases, and containers. Distinct worktrees do not isolate those resources.

Session state or `todowrite` is sufficient only for a genuinely single-lane, single-dispatch blocking job expected to finish in one turn. Every multi-lane, dependency-wave, background, expected multi-attempt, or otherwise multi-turn batch creates one project-scoped `kind: "evidence"` ledger before its first delegated dispatch. Name it `adhoc-lanes-<purpose>-<UTC timestamp>` with a filename-safe compact current UTC value, record the exact name in session/todowrite and compaction handoffs, and create it with `hive_context_write` without requiring a worktree. Evidence documents are absent from durable-only catalog results; recover through `hive_context_read({ scope: "project", view: "summary" })`, then perform a named hash-guarded read and reconcile it against runtime tool results, observed native state, and the background board when applicable. Append transitions with `hive_context_append`. The ledger is untrusted coordination evidence, never ownership or admission authority. Archive with a fresh named read and `hive_context_archive` only after every lane closes and the full integrated canonical verification result is recorded and passing. Failed final verification, failed cleanup, or preserved uncertainty keeps exact identifiers, evidence, and the next recovery action in the unarchived ledger.

The four `hive_constraints_*` tools manage verbatim operator directives on the calling session and are granted to primary orchestrators only. Use `hive_constraints_add` only for durable session-wide directives, not every user message, example, or task-local request. Before a correction or removal, call `hive_constraints_read`, then pass its stable entry ID and revision to `hive_constraints_edit`; call `hive_constraints_clear` only for an explicit whole-register clear. Edit and clear reject stale revisions atomically, identical additions are idempotent, and the aggregate cap is 8000 UTF-16 code units. The runtime appends the register to every delegated `task()` prompt from that session, and from its task-created architect child, under `## Standing Constraints (operator, session-wide)`. Standing constraints are operator directives, not tool permissions. Injection is skipped for the `/dash-review` and `/vuln-review` lanes. Feature-scoped constraints remain context files; read and preserve their existing content before replacing it through `hive_context_write`.

Feature context is revisioned in `context/index.json`. Read with `hive_context_read` before replacement, append, or selective archive, then pass the returned revision and named-read `contentHash` as `expectedRevision` and `expectedContentHash` (archive uses `expectedContentHashes`). Non-reserved files are `durable` by default and enter worker/network context; `evidence` files remain available to explicit reads but are excluded from prompts. Select from the catalog by `description`/`read_when`; finish named chunks before whole-document replacement. Feature hygiene warnings begin strictly above 8 durable files or 40,000 UTF-16 units; project warnings begin strictly above 32 files or 160,000 units. These are review signals, not admission rejection. When they appear, load `context-engineering` and review; do not auto-consolidate, auto-promote, or archive on feature completion. `overview`, `draft`, and `execution-decisions` remain reserved and uncapped, and do not accept a caller-provided kind. Plan approval leaves draft cleanup explicit so archival failure cannot make a persisted approval appear unsuccessful. Project owner/date are accountability, not authority. Workers propose project updates and assignment conflicts to their parent. Tool schemas and recovery steps: `packages/opencode-hive/docs/HIVE-TOOLS.md` and `docs/OPERATOR-GUIDE.md`.

The seven workflow-only tools are runtime-gated capabilities, not additional powers for standard roles. Review roles cannot call `hive_git_snapshot` directly; Stage A uses the one-shot `hive_review_evidence_resolve`. `/dash-review` accepts one Git, inline, or packet-fixed local-artifact kind. `/vuln-review` accepts Git only. Workspace create accepts only the invocation-bound resolution fingerprint plus the vulnerability source-resolution fingerprint when required.

`hive_git_snapshot` is a low-level diagnostic rather than a normal agent interface. It is gated by a positive authorization decision that requires a non-empty authenticated agent and session identity, no review policy role, no active review invocation or consumer reservation, and no review-lane or frozen-workspace recipient status. Built-in Hive agents do not receive it in their allowlists, so direct use requires explicit custom exposure. It returns a versioned `hive-git-snapshot/v1` envelope: `ready` carries a snapshot whose `consistency: "validated"` asserts that changed paths, patch material, and fingerprint describe one validated generation, and `failed` carries structured codes, phases, and retry semantics. Capture is bracketed by a generation check that fails with `SOURCE_DRIFT` instead of returning material from two generations, and one 15-second operation deadline covers the whole capture. Shape, failure codes, per-section omissions, and hard limits: `packages/opencode-hive/docs/HIVE-TOOLS.md`.

**Standard tool access is filtered per agent role:**
- **Hive** — all 33 standard tools (hybrid agent)
- **Swarm, Architect, and Hive Builder** — all four context tools: read, write, append, and archive
- **Forager and Scout** — context read, append, and write. Their prompts permit write only for explicit creation because tool permissions cannot constrain arguments; replacement still requires a revision at runtime.
- **Review roles** — context read, append, and write where their existing persistence contract allows it; selective archive remains primary-orchestrator-only.

Skills are loaded through OpenCode's native `skill` tool (via `skills.paths`, `skills.urls`, or `.opencode`/`.claude` discovery), not through a Hive plugin tool. Hive bundles are materialized into the global OpenCode config directory under `agent-hive/generated/opencode-skills/` and registered ahead of user paths.

### Workflow

1. `hive_feature_create(name)` - Create feature
2. `hive_plan_write(content)` - Write the initial plan.md or replace it for a major rewrite
   Use `hive_plan_patch({ expectedRevision, operations })` for bounded review amendments from the current `hive_plan_read` revision. If task sequencing, dependencies, or scope changed, run `hive_tasks_sync({ refreshPending: true })` explicitly after review/approval; patching never syncs tasks automatically.
3. User adds comments in VSCode → `hive_plan_read` to see them
4. Revise plan → User approves
5. `hive_tasks_sync()` - Generate tasks from plan
6. `hive_execution_prepare({ scope: { kind: "task", task }, placement: { kind: "worktree" } })` → unchanged native Forager `task()` → structured stop → originating-primary `hive_execution_finish`
7. `hive_merge(task[, strategy, message])` - Merge a finalized completed task branch (when ready)

**Important:** `hive_execution_finish` records disposition and, for worktree placement, commits under the crash-safe journal. It does not merge. Use `hive_merge` to integrate. Worktrees persist until explicitly removed.
`hive_worktree_discard` omits `attemptId` for the current task worktree, or accepts a finalized non-current attempt when removing historical worktree state. Discard is refused while the source worktree has an attached, stopped, or otherwise unobserved claim.

`summary` remains task/report context; `message` controls git commit/merge text and is required whenever the operation creates a commit.
Every created commit message must contain a non-empty one-line subject, a blank line, and a non-empty descriptive body.
Feature and ad-hoc integration default to squash with an explicit polished aggregate message. Use rebase or normal merge only for intentionally structured history where every preserved source commit is independently valuable and satisfies the same message contract; normal merge also requires a valid aggregate message. Do not rely on generic hive/task/run IDs in project history.
Do not provide a non-blank `message` when using `hive_merge(..., strategy: 'rebase')`.

If a completed task branch has no net tracked changes, `hive_merge` returns `success: true`, `merged: false`, `reasonCode: 'NO_TRACKED_CHANGES'`, and no `sha`; requested cleanup can still run when safe. Use `hive_status.helperStatus.mergeEligibility` as the task/worktree-aware state surface before merge or cleanup decisions. Merge requires finalized execution and every live source HEAD to equal the committed receipt SHA or the no-change baseline HEAD. Native stop alone is not merge eligibility. Integration locking is operation-scoped (source worktree, destination checkout, and composite repositories). Two integrations into the same destination checkout serialize. Integration is refused while the source worktree has an active writer. Unrelated worktrees may keep executing when source and destination do not conflict. `hive_execution_finish` persists intent first, then per-repository receipts, an immutable report, generation-guarded disposition, and `finalized` last; retry the same input after interruption. A commit can be adopted only when HEAD parent, tree, and exact message match the receipt.

### Delegated Execution

Multiple primary sessions in one project are supported through isolated worktrees. The same exact registered workspace may have only one managed writer at a time. Two executions conflict when their exact registered worktree identity sets intersect. Composite claims cover the explicit registered worktree set. Generic ancestor or descendant filesystem containment is not the conflict model. Declared file ownership is not a concurrency guarantee. Uncertainty quarantines only the affected worktree. Integration locking is operation-scoped. Background jobs are observational bookkeeping, not ownership authority. Cross-process process supervision is unsupported. `hive_existing_workspace_start` is unavailable.

Forager is the default execution role. Native `general` is an ordinary `task()` call: it consumes no arm and gains no Hive claim, managed context, or lifecycle authority. General has ordinary tools only, no Hive authority, recursion, or questions. Helper calls retain bounded operational permissions. Neither call is a managed placement.

Canonical Forager flow:

1. `hive_execution_prepare` with exact task or ad-hoc scope and `worktree` or `in_place` placement. It returns `attemptId`, scope, placement facts, references, expiry, and lifecycle reminders. IDs returned here are Hive lifecycle selectors, never native task arguments.
2. Issue one unchanged native Forager `task({ subagent_type, description, prompt, background? })`. The primary authors those fields. The runtime consumes the sole arm, persists parent/call attachment before dispatch continues, and appends execution scope plus the dispatch-time standing-constraint snapshot. Caller-supplied headings do not suppress real injection.
3. Observe structured stop evidence for that exact parent/call. A blocking `task()` return with defined output is terminal. A background task is terminal only on an authenticated native completion notification for the stored task/job identity. Worker prose, board state, `task_status` samples, idle events, timeouts, undefined after-hook output, and cancel acknowledgement are not stop evidence.
4. Originating primary calls `hive_execution_finish({ attemptId, status, summary, blocker?, message? })`. Worktree placement commits through the crash-safe journal when a message is supplied. In-place and blocked finalization reject commit messages and skip Git. Worker text is report input, not authorization to finish.
5. Git integration remains explicit: `hive_merge` or `hive_adhoc_merge`, then cleanup. Merge requires finalized execution, matching receipt SHAs or no-change baselines, and no active source writer.

Four placements use that same sequence:

- Git feature task: prepare task/worktree, native Forager, stop, finish with report and commit, then `hive_merge`.
- Git ad-hoc work: prepare ad-hoc/worktree, native Forager, stop, finish with report and commit, then `hive_adhoc_merge`.
- Non-Git ad-hoc work: prepare ad-hoc/in-place for an explicit directory, native Forager with live-edit instructions, stop, finish with a report only.
- Feature-scoped non-Git work: prepare task/in-place, native Forager, retain feature catalog/context access, stop, finish task state without Git.

Independent worktrees whose registered identities do not intersect may be prepared and dispatched under one parent. Starting the same task twice allocates atomically one active attempt; the second caller is rejected or returned the existing attempt. Unused arms expire after five minutes. Unobserved native execution quarantines only that worktree. Cancel acknowledgement is not proof of termination; live claims remain until termination is observed. There is no automatic claim release or force bypass.

Recover missing native binding from exact parent/call metadata only; never guess the latest child or infer ownership from prose or placeholders such as `forager-child`. Do not treat a `ses_` prefix as identity validation. If native evidence cannot establish that the old execution stopped, the attempt is unobserved: preserve that workspace and do not reset, copy, or delete it. Never copy mutable progress from a potentially live writer. A feature-task worktree remains quarantined until authenticated stop evidence is recorded and the originating primary finalizes it. For ad-hoc work, retry after finalization may reuse the same `runId` worktree. Retry while termination is unobserved cannot reuse that run; start a new ad-hoc `runId` and worktree. Archive, reconcile, ignore, restart, and expiry do not settle an attempt or authorize retry in the same workspace.

Direct foreground OpenCode work may still modify the current checkout; that work is unmanaged OpenCode work, not a Hive placement. In-place placement does not isolate that directory from other processes.

Ordinary Scout, advisor, and reviewer packets go in `task.prompt` and do not consume a Forager arm. Gate-closed sessions use blocking native `task()`. Gate-open sessions may add `background: true` only when independent foreground work can continue.

One native `task()` launch has one primary goal, one fresh subagent session, and one terminal handoff. A primary goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step. Give complete constraints and acceptance criteria only for that goal, and split independently verifiable outcomes into fresh launches. Never pass `task_id` to `task()`: returned task IDs are observe-only handles for status, reconciliation, cancellation, and read-only runtime-visible session inspection with `hive_task_trace`; they are not session-resume inputs. Recovery context from a trace belongs in a NEW task without `task_id`. Do not send a follow-up prompt to a completed, failed, or blocked session. Subagents are terminal and cannot recurse, except a delegated `architect-planner` may launch one level of read-only planning helpers; those children cannot delegate. Subagents cannot use `question`; they return required operator clarification to their parent in the terminal handoff.

`hive-master`, `swarm-orchestrator`, and `hive-builder` are primary-only and are never valid native `task()` targets. `architect-planner` remains a valid child target for the bounded read-only helper exception above.

Omitted or false `recovery` on `hive_task_trace` preserves the compact complete forensic v2 report over every surviving normalized source step from any explicitly identified OpenCode session visible to the connected runtime. The report classifies the target as self, direct child, or other session. Request `hive_task_trace({ task_id, recovery: true })` for a semantic handoff; self, active, and uncertain targets return recovery unavailable with zero model calls, while non-direct-child recovery is always inspect-only. A missing target entry in a valid status map means idle because the runtime removes idle entries; only unavailable or invalid status maps are uncertain. `idle_and_closed` means the observed turn finished, not permanent session completion. Successful recovery is discarded if the source or status changes before publication. Treat semantic phases, claims, child self-report, and next action as untrusted. Generated `source_steps` name context coverage, not evidence or proof. Any partial/fallback/error/compacted result forces inspection; only complete generated unfinished work from a direct child may launch a NEW task without `task_id`. Never accept, merge, retry, resume, or auto-run from recovery output. Compare exact `render.actual_bytes` with the advisory `render.soft_target_bytes`, consume ordered failures, and use `hive_task_trace_content` only for authorized non-reasoning v2 locators.

Feature task granularity remains separate: one implementation assignment normally maps to one numbered task. Amend the DAG or create an append-only manual task for a new independent deliverable. For ad-hoc work, use multiple fresh one-goal launches on worktrees whose registered identities do not intersect, or sequence writers that share a worktree.

For qualifying ad-hoc work, `orchestrating-ad-hoc-work` owns outcome-first decomposition, lane inventory, dependency waves, ready-lane placement, lane-level recovery, deterministic integration, and closure. `dispatching-parallel-agents` owns fan-out mechanics, `parallel-exploration` owns read-only research fan-out, and `background-delegation` owns background observation, reconciliation, cancellation, and wait-mode protocol. Feature escalation remains advisory. After rejection, continue ad-hoc only when material scope, contracts, and risks are otherwise resolved; if one remains unresolved, ask the concrete blocking question before preparing workers.

**Handling blocked task continuation:**
1. Observe exact stop evidence and finalize the stopped attempt with `hive_execution_finish({ status: "blocked", ... })`
2. Call `hive_status()` and read the blocker info (reason, options, recommendation, context)
3. Ask the user via `question()` - NEVER plain text - and record the decision
4. Call `hive_status()` again; only while status remains exactly blocked, call `hive_execution_prepare` with `scope.continueFromBlocked: true` and put the decision in the native Forager `task.prompt`

**CRITICAL**: Blocked continuation starts a NEW worker in the SAME existing worktree or exact in-place directory.
The previous worker's progress is preserved. The operator decision belongs in the fresh primary-authored native prompt.

Failed or retry work starts only after the stopped attempt is finalized and status is re-checked. The new worker receives a concise self-contained handoff. An unobserved feature-task attempt remains quarantined; do not create an alternate placement. Compaction may re-anchor a currently running worker; it is not re-delegation. After compaction, recover managed context with `context-engineering`: catalog selection, later-page continuation, and named raw chunks. Keep exact IDs. Do not replay historical assignment bodies.

Root relocation: the old recipient remains denied. An authenticated primary at the newly trusted canonical root allocates a fresh task attempt and establishes a fresh authenticated child binding. Ad-hoc relocation requires a fresh authenticated run. Old persisted metadata remains inert history; never edit roots to rebind it, follow the stored former root, or suggest root migration/aliases. Seamless continuation is intentionally sacrificed. Exact-worktree registration is the Git integrity prerequisite, not trusted repository/common-directory containment alone. Direct the operator to prepare/recreate an independently valid workspace, then launch fresh. Do not rewrite `.git` or administration metadata, repair worktrees automatically, or treat error notices as empty catalogs. Never delete an index to restore classification. Details: `docs/OPERATOR-GUIDE.md` and `context-engineering`.

No agent may silently skip required configured review targets.

**After task() Returns:**
- task() is BLOCKING by default — when it returns with defined output, that is structured stop evidence for the exact call
- Originating primary calls `hive_execution_finish` before treating the task as complete or merge-eligible. Native stop alone never satisfies dependencies or integration.
- Call `hive_status()` after finalization to check the new task state and find next runnable tasks
- Prefer structured worker-result envelopes over free-form completion interpretation when extending worker/orchestrator flows
- When opencode is launched with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`, primary agents may load and use the bundled `background-delegation` skill and call `task({ background: true, ... })` only for independent work where useful foreground work can continue. Use blocking native `task()` when the next meaningful step depends on the worker. Preparing an execution does not create background board state; board state begins only when the parent launches the ordinary native background task. Wait for the native completion notification and refresh `hive_background_status` before dependent decisions. If status returns wait-only scheduler guidance, do not refresh repeatedly until the native notification arrives or the lane becomes stale, wrong, or no longer needed. Treat `recommendedNextAction` and `requiresHiveStatusRefresh` as board-local scheduler hints, not merge readiness. Board rows may appear on `hive_background_status` without a native task ID; `hive_status` is not that surface. Exact later callbacks can update board visibility and provide authenticated stop evidence; they do not settle an ExecutionAttempt. Archive, reconcile, and ignore archive the board row and do not stop execution, release a workspace, settle an attempt, or authorize retry in the same workspace. TTL sweeps unused arms only. Cancellation is owner-scoped; cancel acknowledgement is not proof of termination.
- The subagent depth and clarification contract above also applies to custom derived subagents.

### Sandbox Configuration

**Docker sandbox** provides isolated test environments for workers:

- **Config source**: all Agent Hive runtime configuration comes only from `~/.config/opencode/agent_hive.json`; project `.hive/agent-hive.json` and `.opencode/agent_hive.json` files are ignored.
- **Repository topology**: `<canonical-project-root>/.hive/repositories.json` stores `{ "schemaVersion": 1, "repositories": [...] }`; paths are relative to and contained by that root. Global `repositoryRoot`/`repositories` are migration-only legacy fields.
- **Runtime fields**:
  - `sandbox: 'none' | 'docker'` — Isolation mode (default: 'none')
  - `dockerImage?: string` — Custom Docker image (optional, auto-detects if omitted)
  - `persistentContainers?: boolean` — Reuse Docker containers per worktree
- **Auto-detection**: Detects runtime from project files:
  - `package.json` → `node:22-slim`
  - `requirements.txt` / `pyproject.toml` → `python:3.12-slim`
  - `go.mod` → `golang:1.22-slim`
  - `Cargo.toml` → `rust:1.77-slim`
  - `Dockerfile` → builds from project Dockerfile
  - Fallback → `ubuntu:24.04`
- **Escape hatch**: Prefix commands with `HOST:` to bypass sandbox and run directly on host

**Example config**:
```json
{
  "sandbox": "docker",
  "dockerImage": "node:22-slim"
}
```

Workers are unaware of sandboxing — bash commands are transparently intercepted and wrapped with `docker run`.
