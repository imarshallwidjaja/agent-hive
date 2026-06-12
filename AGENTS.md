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

Release note: the active release path publishes `oc-arkive` to npm and attaches `vscode-arkive.vsix` to the GitHub Release. Prepare root/hive-core/opencode/vscode package version bumps, lockfile updates, changelog entries, and `docs/releases/vX.Y.Z.md` manually before running the GitHub `workflow_dispatch` rehearsal and tagging. The pushed `vX.Y.Z` tag must point at a commit whose root package version is `X.Y.Z` and whose matching release-note file exists. If a tagged release partially fails, rerun the same workflow in tag-backed recovery mode and enable only the unfinished `oc-arkive` npm publish and/or GitHub Release target.

Worktree dependency note: worktrees are lightweight checkouts without project dependencies. Workers do best-effort verification using ast-grep (no dependencies needed). Full build and test verification (`bun run build` + `bun run test`) runs on the main branch after the orchestrator merges a batch of task branches.

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

## Commit Messages

Use **Conventional Commits**:

```
feat: add parallel task execution
fix: handle missing worktree gracefully
docs: update skill documentation
chore: upgrade dependencies
refactor: extract worktree logic to service
test: add feature service unit tests
perf: cache resolved paths
```

Breaking changes use `!`:
```
feat!: change plan format to support subtasks
```

## Architecture Principles

### Core Philosophy

1. **Context Persists** - Write to `.hive/` files; memory is ephemeral
2. **Plan → Approve → Execute** - No code without approved plan
3. **Human Shapes, Agent Builds** - Humans decide direction, agents implement
4. **Good Enough Wins** - Ship working code, iterate later
5. **Batched Parallelism** - Delegate independent tasks to workers
6. **Tests Define Done** - Workers do best-effort checks; orchestrator runs full test suite after batch merge
7. **Iron Laws + Hard Gates** - Non-negotiable constraints per agent
8. **Cross-Model Prompts** — Agent prompts must work across all supported LLM providers. Use conditional triggers ("when X, do Y") instead of absolute mandates ("always do Y") or blanket defaults ("by default, do Y").
9. **Deterministic Contracts Beat Soft Memory** — Prefer hard gates and deterministic tools over soft prompt-only memory when reliability matters.

### Agent Roles

| Agent | Role |
|-------|------|
| Hive (Hybrid) | Plans AND orchestrates; phase-aware |
| Architect | Plans features, interviews, writes plans. NEVER executes |
| Swarm | Orchestrates execution. Delegates, spawns workers, verifies |
| Hive Builder | Ad-hoc executor. Isolates, executes, verifies, merges without feature/task overhead. Available in both modes, not default |
| Scout | Researches codebase + external docs/data |
| Forager | Executes tasks directly in isolated worktrees |
| Hygienic | Reviews plan/code quality. OKAY/REJECT verdict |

### Data Model

Features stored in `.hive/features/<name>/`:
```
.hive/features/my-feature/
├── feature.json       # Feature metadata
├── plan.md            # Execution plan (can include a readable design summary before ## Tasks)
├── tasks.json         # Generated tasks
└── context/           # Persistent context files (free-form by default)
    ├── overview.md    # Primary human-facing branch summary/history
    └── decisions.md   # Optional example context file
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

### Hive Plugin Tools (25 total)

| Domain | Tools |
|--------|-------|
| Feature | hive_feature_create, hive_feature_complete |
| Repository Manifest | hive_repositories_status, hive_repositories_discover, hive_repositories_update |
| Plan | hive_plan_write, hive_plan_read, hive_plan_approve |
| Task | hive_tasks_sync, hive_task_create, hive_task_update |
| Worktree (task-backed) | hive_worktree_start, hive_worktree_create, hive_worktree_commit, hive_worktree_discard |
| Ad-hoc Worktree | hive_adhoc_worktree_create, hive_adhoc_worktree_commit, hive_adhoc_merge, hive_adhoc_cleanup |
| Background Orchestration | hive_background_status, hive_background_reconcile, hive_background_cancel |
| Merge | hive_merge |
| Context | hive_context_write |
| Status | hive_status |

Task-backed worktree tools create feature/task records and appear in `hive_status`. Ad-hoc worktree tools are for isolated executor work (Hive Builder) and do not create feature/task records. `task_status` is not a Hive tool; it is opencode-native when the background subagent experiment is active. Background orchestration tools are primary-agent tools behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`; they manage Hive's board around native background `task`/`task_status` and do not roll back files, branches, worktrees, commits, or reports.

**Tool access is filtered per agent role:**
- **Hive** — all 25 tools (hybrid agent)
- **Swarm** — hive_feature_create, hive_feature_complete, hive_plan_read, hive_plan_approve, hive_repositories_status, hive_repositories_discover, hive_repositories_update, hive_tasks_sync, hive_task_create, hive_task_update, hive_worktree_start, hive_worktree_create, hive_worktree_discard, hive_background_status, hive_background_reconcile, hive_background_cancel, hive_merge, hive_context_write, hive_status (19 tools — excludes hive_worktree_commit, hive_plan_write, and ad-hoc worktree tools)
- **Architect** — hive_feature_create, hive_plan_write, hive_plan_read, hive_repositories_status, hive_repositories_discover, hive_repositories_update, hive_background_status, hive_background_reconcile, hive_background_cancel, hive_context_write, hive_status (11 tools)
- **Hive Builder** — hive_adhoc_worktree_create, hive_adhoc_worktree_commit, hive_adhoc_merge, hive_adhoc_cleanup, hive_repositories_status, hive_repositories_discover, hive_repositories_update, hive_background_status, hive_background_reconcile, hive_background_cancel, hive_context_write (11 tools — ad-hoc worktree + repo manifest + background board + context; denied task-backed worktree, plan, feature, and status tools)
- **Forager** — hive_plan_read, hive_worktree_commit, hive_context_write (3 tools)
- **Scout** — hive_plan_read, hive_context_write, hive_status (3 tools)
- **Hygienic** — hive_plan_read, hive_context_write, hive_status (3 tools)

Skills are loaded through OpenCode's native `skill` tool (via `skills.paths`, `skills.urls`, or `.opencode`/`.claude` discovery), not through a Hive plugin tool. Hive bundles are materialized into `.hive/generated/opencode-skills/` and registered ahead of user paths.

### Workflow

1. `hive_feature_create(name)` - Create feature
2. `hive_plan_write(content)` - Write plan.md
3. User adds comments in VSCode → `hive_plan_read` to see them
4. Revise plan → User approves
5. `hive_tasks_sync()` - Generate tasks from plan
6. `hive_worktree_start(task)` → work in worktree → `hive_worktree_commit(task, summary[, message])`
7. `hive_merge(task[, strategy, message])` - Merge task branch into main (when ready)

**Important:** `hive_worktree_commit` commits changes to task branch but does NOT merge.
Use `hive_merge` to explicitly integrate changes. Worktrees persist until manually removed.

`summary` remains task/report context; optional `message` controls git commit/merge text.
Multi-line `message` is supported where a new commit is created.
Omit `message` (or pass `''`) to keep default message behavior.
Do not provide `message` when using `hive_merge(..., strategy: 'rebase')`.

### Delegated Execution

`hive_worktree_start` creates worktree and spawns worker automatically:

1. `hive_worktree_start(task)` → Creates worktree + spawns Forager (Worker/Coder) worker
2. Worker executes → calls `hive_worktree_commit(status: "completed")`
3. Worker blocked → calls `hive_worktree_commit(status: "blocked", blocker: {...})`

**Handling blocked workers:**
1. Check blockers with `hive_status()`
2. Read the blocker info (reason, options, recommendation, context)
3. Ask user via `question()` tool - NEVER plain text
4. Resume with `hive_worktree_create(task, continueFrom: "blocked", decision: answer)`

**CRITICAL**: When resuming, a NEW worker spawns in the SAME worktree.
The previous worker's progress is preserved. Include the user's decision in the `decision` parameter.

**After task() Returns:**
- task() is BLOCKING by default — when it returns, the worker is DONE
- Call `hive_status()` immediately to check the new task state and find next runnable tasks
- Prefer structured worker-result envelopes over free-form completion interpretation when extending worker/orchestrator flows
- When opencode is launched with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`, primary agents may load and use the bundled `background-delegation` skill and call `task({ background: true, ... })` only for independent foreground work; use `task_status` to check background task results before dependent decisions
- Subagents (including custom derived subagents) must not call `task()` recursively

### Sandbox Configuration

**Docker sandbox** provides isolated test environments for workers:

- **Config read precedence**: user/session policy comes from `~/.config/opencode/agent_hive.json`; project `.hive/agent-hive.json` and legacy `.opencode/agent_hive.json` only overlay project-scoped fields.
- **Invalid project config behavior**: Uses global config/defaults and surfaces a runtime warning.
- **Project-scoped fields**:
  - `sandbox: 'none' | 'docker'` — Isolation mode (default: 'none')
  - `dockerImage?: string` — Custom Docker image (optional, auto-detects if omitted)
  - `persistentContainers?: boolean` — Reuse Docker containers per worktree
  - `repositories?: { id: string; path: string }[]` — Project repository manifest
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
