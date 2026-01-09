# Hive Design

## Core Concept

Context-Driven Development for AI coding assistants.

```
PROBLEM  -> CONTEXT  -> EXECUTION -> REPORT
(why)       (what)      (how)        (shape)
```

## Architecture

```
.hive/                    <- Shared data (all clients)
├── features/             <- Feature-scoped work
│   └── {feature}/
│       ├── plan.md       <- Approved execution plan
│       ├── status.json   <- Feature state (planning/approved/executing/done)
│       ├── context/      <- Persistent knowledge files
│       └── tasks/        <- Individual task folders
│           └── {task}/
│               ├── status.json  <- Task state
│               ├── spec.md      <- Task context and requirements
│               └── report.md    <- Execution summary and results
└── .worktrees/           <- Isolated git worktrees per task
    └── {feature}/{task}/ <- Full repo copy for safe execution

packages/
├── opencode-hive/        <- OpenCode plugin (planning, execution, tracking)
└── vscode-hive/          <- VSCode extension (visualization, review, approval)
```

## Data Flow

1. User creates feature via `hive_feature_create`
2. Agent writes plan via `hive_plan_write`
3. User reviews in VSCode, adds comments
4. User approves via `hive_plan_approve`
5. Tasks synced via `hive_tasks_sync` (generates spec.md for each)
6. Each task executed via `hive_exec_start` -> work -> `hive_exec_complete`
7. Changes applied from worktree to main repo
8. Report generated with diff stats and file list

## Feature Resolution (v0.5.0)

All tools use detection-based feature resolution instead of global state:

```typescript
function resolveFeature(explicit?: string): string | null {
  // 1. Use explicit parameter if provided
  if (explicit) return explicit
  
  // 2. Detect from worktree path (.hive/.worktrees/{feature}/{task}/)
  const detected = detectContext(cwd)
  if (detected?.feature) return detected.feature
  
  // 3. Fall back to single feature if only one exists
  const features = listFeatures()
  if (features.length === 1) return features[0]
  
  // 4. Require explicit parameter if multiple features
  return null
}
```

This enables:
- Multi-session support (parallel agents on different features)
- Worktree detection (agent knows which feature from its cwd)
- Explicit override (always specify feature when needed)

## Session Tracking

Sessions tracked per feature in `sessions/` directory:
- Each session captures: id, title, startedAt, endedAt
- Sessions can be forked (continue from existing) or fresh (new start)
- VSCode extension shows session history per feature

## Task Lifecycle

```
pending -> in_progress -> done
                      \-> failed
                      \-> skipped
```

### spec.md (generated on task sync)
Contains task context for the executing agent:
- Task number, name, feature, folder
- Full description from plan
- Prior tasks (what came before)
- Upcoming tasks (what comes after)

### report.md (generated on task complete)
Contains execution results:
- Feature name, completion timestamp
- Status (success/failed)
- Summary (agent-provided)
- Diff statistics (files changed, insertions, deletions)
- List of modified files

## Worktree Isolation

Each task executes in an isolated git worktree:
- Full repo copy at `.hive/.worktrees/{feature}/{task}/`
- Agent makes changes freely without affecting main repo
- On `exec_complete`: diff extracted and applied to main repo
- On `exec_abort`: worktree discarded, no changes applied

## Key Principles

- **No global state** — All tools accept explicit feature parameter
- **Detection-first** — Worktree path reveals feature context
- **Isolation** — Each task in own worktree, safe to discard
- **Audit trail** — Every action logged to `.hive/`
- **Agent-friendly** — Minimal overhead during execution
