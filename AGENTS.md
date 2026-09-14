# Agent Guidelines for agent-hive

## Overview

**agent-hive** is a context-driven development system for AI coding assistants. It implements a plan-first workflow: Plan → Approve → Execute.

## Build & Test Commands

```bash
# Build all packages
bun run build

# Development mode (all packages)
bun run dev

# Run tests (from package directories)
bun run test              # Run all tests
bun run test -- <file>    # Run specific test

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
| Hive Builder | Ad-hoc orchestrator for non-feature work; delegates non-trivial work, tracks verification and integration, and uses ad-hoc worktrees when needed. Background mode only changes wait mode and board protocol. Available in both modes, not default |
| Scout | Researches codebase + external docs/data |
| Forager | Executes tasks directly in isolated worktrees |
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
- Run package scripts from the package directory (for example, `packages/vscode-hive/` → `bun run build`)

## Hive - Feature Development System

Plan-first development: Write plan → User reviews → Approve → Execute tasks

### Hive Plugin Tools (37 standard + 7 workflow-only)

| Domain | Tools |
|--------|-------|
| Feature | hive_feature_create, hive_feature_complete |
| Repository Manifest | hive_repositories_status, hive_repositories_discover, hive_repositories_update |
| Plan | hive_plan_write, hive_plan_patch, hive_plan_read, hive_plan_approve |
| Task | hive_tasks_sync, hive_task_create, hive_task_update |
| Worktree (task-backed) | hive_worktree_start, hive_worktree_create, hive_worktree_commit, hive_worktree_discard |
| Ad-hoc Worktree | hive_adhoc_worktree_create, hive_adhoc_worktree_start, hive_adhoc_worktree_commit, hive_adhoc_merge, hive_adhoc_cleanup |
| Background Orchestration | hive_background_status, hive_background_reconcile, hive_background_reconcile_batch, hive_background_cancel |
| Runtime Session Inspection | hive_task_trace, hive_task_trace_content |
| Merge | hive_merge |
| Context | hive_context_read, hive_context_write, hive_context_append, hive_context_archive |
| Operator Constraints | hive_constraints_read, hive_constraints_add, hive_constraints_edit, hive_constraints_clear |
| Status | hive_status |
| Workflow-only Review | hive_git_snapshot, hive_review_evidence_resolve, hive_vulnerability_compare_report_read, hive_review_workspace_create, hive_review_workspace_claim, hive_review_workspace_inspect, hive_review_workspace_cleanup |

Task-backed worktree tools create feature/task records and appear in `hive_status`. Modern `hive_tasks_sync` reads numbered tasks only from `## Tasks`; pure suite or release checks belong in `## Final Verification` unless they write tracked artifacts. Ad-hoc worktree tools are for isolated Hive Builder work and do not create feature/task records. `hive_adhoc_worktree_create` creates the workspace and, unless `autoSpawnWorker: false`, prepares the first Forager launch. `hive_adhoc_worktree_start({ runId, workerInstructions })` prepares a fresh attempt on an existing run. Gate-closed sessions launch the returned blocking `taskToolCall`; background-enabled sessions may launch `backgroundTaskCall` when independent foreground work can continue. Set `autoSpawnWorker: false` only for inspection, routing, or setup-only worktrees. Spread the returned call object so `hive_launch_id` is preserved. Background orchestration tools are primary-agent tools behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`; they manage Hive's board around native background `task({ background: true, ... })` completion notifications and do not roll back files, branches, worktrees, commits, or reports. The board persists claimed-launch bookkeeping distinct from real native jobs. `hive_background_status` exposes `launchId` and unresolved claims; `hive_status` is not that surface. Do not invent native task IDs. Cancel is unavailable without a real native identity. Archive/ignore does not stop a worker or authorize a replacement writer. Reconciled and ignored jobs are archived by those tools and hidden from normal status output; agents must not edit `.hive/background-jobs.json` directly.

The four `hive_constraints_*` tools manage verbatim operator directives on the calling session and are granted to primary orchestrators only. Use `hive_constraints_add` only for durable session-wide directives, not every user message, example, or task-local request. Before a correction or removal, call `hive_constraints_read`, then pass its stable entry ID and revision to `hive_constraints_edit`; call `hive_constraints_clear` only for an explicit whole-register clear. Edit and clear reject stale revisions atomically, identical additions are idempotent, and the aggregate cap is 8000 UTF-16 code units. The runtime injects the register into every delegated `task()` prompt and generated worker prompt from that session, and from its task-created architect child, under `## Standing Constraints (operator, session-wide)`. Injection is skipped for the `/dash-review` and `/vuln-review` lanes. Feature-scoped constraints remain context files; read and preserve their existing content before replacing it through `hive_context_write`.

Feature context is revisioned in `context/index.json`. Read with `hive_context_read` before replacement, append, or selective archive, then pass the returned revision and named-read `contentHash` as `expectedRevision` and `expectedContentHash` (archive uses `expectedContentHashes`). Non-reserved files are `durable` by default and enter worker/network context; `evidence` files remain available to explicit reads but are excluded from prompts. Select from the catalog by `description`/`read_when`; finish named chunks before whole-document replacement. Feature hygiene warnings begin strictly above 8 durable files or 40,000 UTF-16 units; project warnings begin strictly above 32 files or 160,000 units. These are review signals, not admission rejection. When they appear, load `context-engineering` and review; do not auto-consolidate, auto-promote, or archive on feature completion. `overview`, `draft`, and `execution-decisions` remain reserved and uncapped, and do not accept a caller-provided kind. Plan approval leaves draft cleanup explicit so archival failure cannot make a persisted approval appear unsuccessful. Project owner/date are accountability, not authority. Workers propose project updates and assignment conflicts to their parent. Tool schemas and recovery steps: `packages/opencode-hive/docs/HIVE-TOOLS.md` and `docs/OPERATOR-GUIDE.md`.

The seven workflow-only tools are runtime-gated capabilities, not additional powers for standard roles. Review roles cannot call `hive_git_snapshot` directly; Stage A uses the one-shot `hive_review_evidence_resolve`. `/dash-review` accepts one Git, inline, or packet-fixed local-artifact kind. `/vuln-review` accepts Git only. Workspace create accepts only the invocation-bound resolution fingerprint plus the vulnerability source-resolution fingerprint when required.

`hive_git_snapshot` is a low-level diagnostic rather than a normal agent interface. It is gated by a positive authorization decision that requires a non-empty authenticated agent and session identity, no review policy role, no active review invocation or consumer reservation, and no review-lane or frozen-workspace recipient status. Built-in Hive agents do not receive it in their allowlists, so direct use requires explicit custom exposure. It returns a versioned `hive-git-snapshot/v1` envelope: `ready` carries a snapshot whose `consistency: "validated"` asserts that changed paths, patch material, and fingerprint describe one validated generation, and `failed` carries structured codes, phases, and retry semantics. Capture is bracketed by a generation check that fails with `SOURCE_DRIFT` instead of returning material from two generations, and one 15-second operation deadline covers the whole capture. Shape, failure codes, per-section omissions, and hard limits: `packages/opencode-hive/docs/HIVE-TOOLS.md`.

**Standard tool access is filtered per agent role:**
- **Hive** — all 37 standard tools (hybrid agent)
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
6. `hive_worktree_start(task)` → work in worktree → `hive_worktree_commit(task, summary[, message])`
7. `hive_merge(task[, strategy, message])` - Merge task branch into main (when ready)

**Important:** `hive_worktree_commit` commits changes to task branch but does NOT merge.
Use `hive_merge` to explicitly integrate changes. Worktrees persist until manually removed.

`summary` remains task/report context; `message` controls git commit/merge text and is required whenever the operation creates a commit.
Every created commit message must contain a non-empty one-line subject, a blank line, and a non-empty descriptive body.
Feature and ad-hoc integration default to squash with an explicit polished aggregate message. Use rebase or normal merge only for intentionally structured history where every preserved source commit is independently valuable and satisfies the same message contract; normal merge also requires a valid aggregate message. Do not rely on generic hive/task/run IDs in project history.
Do not provide a non-blank `message` when using `hive_merge(..., strategy: 'rebase')`.

If a completed task branch has no net tracked changes, `hive_merge` returns `success: true`, `merged: false`, `reasonCode: 'NO_TRACKED_CHANGES'`, and no `sha`; requested cleanup can still run when safe. Use `hive_status.helperStatus.mergeEligibility` as the task/worktree-aware state surface before merge or cleanup decisions.

### Delegated Execution

`hive_worktree_start` creates or reuses the feature worktree and returns a prepared Forager launch. The worktree and immutable assignment descriptors persist across attempts; each attempt is a fresh native `task()`:

1. `hive_worktree_start(task)` -> worktree plus blocking/background `task()` launch guidance. The preparation response includes `launchId`. Nested `taskToolCall.hive_launch_id` and `backgroundTaskCall.hive_launch_id` carry that same selector.
2. Parent launches that payload. Every Forager lane, including diagnosis-only work, needs a prepared launch. Persist or supply feature Forager context through supported prep inputs before Hive generates the immutable assignment. Non-feature diagnosis uses spawning-enabled `hive_adhoc_worktree_create` or `hive_adhoc_worktree_start` on an existing run, with full instructions in `workerInstructions`. Spread the nested call object into `task()` so `hive_launch_id` is preserved; do not pass `launchId` as a `task()` argument. Runtime strips the ID and injects the canonical prepared prompt; editing a prepared Forager dispatch prompt cannot update its instructions. `launchId` is checked against the authenticated parent, runtime, and target; it is not a credential. Ordinary Scout, advisor, and reviewer packets still go in `task.prompt` and omit `hive_launch_id`.
3. Worker executes -> calls `hive_worktree_commit(status: "completed")`
4. Worker blocked -> calls `hive_worktree_commit(status: "blocked", blocker: {...})`

Independent targets may be prepared and dispatched under one parent. The same feature task or ad-hoc run stays serial: a known active/pending tool or uncertain native identity fences that resource before a new assignment. Unrelated targets may continue. Unused preparation expires after five minutes; plugin restart invalidates unused preparation. Claimed uncertain execution is not stopped by expiry, restart, or archive. Recover missing binding from exact parent/call metadata only; do not guess the latest child or infer ownership from prose. A native error or idle event alone does not prove stop. Fresh completed or confirmed-cancelled evidence permits retry. There is no automatic unfence or force bypass. If exact native evidence cannot establish that the old execution stopped, preserve the original worktree. For safely separable work, use a fresh isolated workspace or a new ad-hoc run. Archive, restart, and unused-preparation expiry do not free the original resource. Do not copy mutable progress while the old worker may still be running. A normal recoverable retry reuses the original worktree after native terminal evidence.

`autoSpawnWorker: false` creates only the workspace. Retry in that run with `hive_adhoc_worktree_start({ runId, workerInstructions })`. Worker instructions are self-contained and frozen per attempt. Reuse the existing worktree; do not discard failed work by default. In gate-closed sessions launch the blocking `taskToolCall`; gate-open sessions may use `backgroundTaskCall` when independent foreground work can continue.

One native `task()` launch has one primary goal, one fresh subagent session, and one terminal handoff. A primary goal may include tightly coupled code, tests, docs, and multiple files; do not split it by file or step. Give complete constraints and acceptance criteria only for that goal, and split independently verifiable outcomes into fresh launches. Never pass `task_id` to `task()`: returned task IDs are observe-only handles for status, reconciliation, cancellation, and read-only runtime-visible session inspection with `hive_task_trace`; they are not session-resume inputs. Recovery context from a trace belongs in a NEW task without `task_id`. Do not send a follow-up prompt to a completed, failed, or blocked session. Subagents are terminal and cannot recurse, except a delegated `architect-planner` may launch one level of read-only planning helpers; those children cannot delegate. Subagents cannot use `question`; they return required operator clarification to their parent in the terminal handoff.

`hive-master`, `swarm-orchestrator`, and `hive-builder` are primary-only and are never valid native `task()` targets. `architect-planner` remains a valid child target for the bounded read-only helper exception above.

Omitted or false `recovery` on `hive_task_trace` preserves the compact complete forensic v2 report over every surviving normalized source step from any explicitly identified OpenCode session visible to the connected runtime. The report classifies the target as self, direct child, or other session. Request `hive_task_trace({ task_id, recovery: true })` for a semantic handoff; self, active, and uncertain targets return recovery unavailable with zero model calls, while non-direct-child recovery is always inspect-only. A missing target entry in a valid status map means idle because the runtime removes idle entries; only unavailable or invalid status maps are uncertain. `idle_and_closed` means the observed turn finished, not permanent session completion. Successful recovery is discarded if the source or status changes before publication. Treat semantic phases, claims, child self-report, and next action as untrusted. Generated `source_steps` name context coverage, not evidence or proof. Any partial/fallback/error/compacted result forces inspection; only complete generated unfinished work from a direct child may launch a NEW task without `task_id`. Never accept, merge, retry, resume, or auto-run from recovery output. Compare exact `render.actual_bytes` with the advisory `render.soft_target_bytes`, consume ordered failures, and use `hive_task_trace_content` only for authorized non-reasoning v2 locators.

Feature task granularity remains separate: one implementation assignment normally maps to one numbered task. Amend the DAG or create an append-only manual task for a new independent deliverable. For ad-hoc work, use multiple fresh one-goal launches with disjoint path ownership or sequence overlapping writers.

**Handling blocked task continuation:**
1. Check blockers with `hive_status()`
2. Read the blocker info (reason, options, recommendation, context)
3. Ask user via `question()` tool - NEVER plain text
4. Launch a new worker session with `hive_worktree_create(task, continueFrom: "blocked", decision: answer)`

**CRITICAL**: Blocked continuation starts a NEW worker in the SAME worktree.
The previous worker's progress is preserved. Include the user's decision in the `decision` parameter.

Failed or retry work starts a new worker with a concise self-contained handoff. Compaction may re-anchor a currently running worker; it is not re-delegation. After compaction, recover managed context with `context-engineering`: catalog selection, later-page continuation, and named raw chunks. Keep exact IDs. Do not replay historical assignment bodies.

Root relocation: the old recipient remains denied. An authenticated primary at the newly trusted canonical root allocates a fresh task attempt, publishes a new immutable assignment, and establishes a fresh authenticated child binding. Ad-hoc relocation requires a fresh authenticated run. Old session/assignment descriptors remain historical; never edit roots to rebind them, follow the stored former root, or suggest root migration/aliases. Seamless continuation is intentionally sacrificed. Exact-worktree registration is the Git integrity prerequisite, not trusted repository/common-directory containment alone. Direct the operator to prepare/recreate an independently valid workspace, then launch fresh. Do not rewrite `.git` or administration metadata, repair worktrees automatically, or treat error notices as empty catalogs. Never delete an index to restore classification. Details: `docs/OPERATOR-GUIDE.md` and `context-engineering`.

No agent may silently skip required configured review targets.

**After task() Returns:**
- task() is BLOCKING by default — when it returns, the worker is DONE
- Call `hive_status()` immediately to check the new task state and find next runnable tasks
- Prefer structured worker-result envelopes over free-form completion interpretation when extending worker/orchestrator flows
- When opencode is launched with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`, primary agents may load and use the bundled `background-delegation` skill and call `task({ background: true, ... })` only for independent work where useful foreground work can continue. Use blocking task/worktree calls when the next meaningful step depends on the worker. Gate-open `hive_worktree_start` may return `backgroundTaskCall`, but pending background board state is not created until the parent actually launches the native background task. Wait for the native completion notification and refresh `hive_background_status` before dependent decisions. If status returns wait-only scheduler guidance, do not refresh repeatedly until the native notification arrives or the lane becomes stale, wrong, or no longer needed. Treat `recommendedNextAction` and `requiresHiveStatusRefresh` as board-local scheduler hints, not merge readiness. Unresolved claimed launches appear on `hive_background_status` by `launchId` without a native task ID; `hive_status` is not that surface. Exact later callbacks can resolve them, otherwise inspect native execution or ignore/reconcile bookkeeping. Reconcile and ignore archive the board row and do not prove the writer stopped. TTL sweeps unused preparations only.
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
