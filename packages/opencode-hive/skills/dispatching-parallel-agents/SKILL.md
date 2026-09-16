---
name: dispatching-parallel-agents
description: "Agent Hive workflow skill for coordinating independent Hive subagent work. Use when 2+ tasks can run without shared state."
---

# Dispatching Parallel Agents

## Overview

When you have multiple unrelated failures (different test files, different subsystems, different bugs), investigating them sequentially wastes time. Each investigation is independent and can happen in parallel.

**Core principle:** Dispatch one fresh subagent session per independent primary goal. Parallel writes require disjoint registered worktrees (separate tasks or distinct ad-hoc runIds). Multiple writes in the same worktree must run sequentially.

### Worktree Concurrency & Sequencing
- **One writer per worktree:** A single worktree has exactly one active writer at a time.
- **Parallel writes across worktrees:** You can dispatch writing workers in parallel ONLY if each worker runs in its own distinct worktree (distinct feature tasks or distinct ad-hoc `runId`s).
- **Sequential passes within a worktree:** If multiple tasks or bug fixes target the SAME worktree, sequence them: `prepare` -> `dispatch the unchanged native call` -> `wait for completion` -> `inspect/commit` -> `prepare again`.
- **Read-only fan-out:** Scouts and reviewers do not write code and can run concurrently anywhere.

When `## Background-First Orchestration` is present, load `background-delegation` for scheduler and wait-mode decisions. This skill covers task independence, scope, and prompt quality; the background skill governs whether each independent lane runs blocking or background.

## Workflow Mode

In feature-task mode, use the prerequisites below. In Hive Builder or unified Hive ad-hoc mode, load `orchestrating-ad-hoc-work`; that skill owns decomposition, the lane inventory, dependency waves, resource ownership, and integration order. This skill retains only common fan-out mechanics, the fresh-session contract, and one-writer/worktree rules.

## Feature-Task Prerequisite: Check Runnable Tasks

In feature-task mode, before dispatching, use `hive_status()` to get the **runnable** list — tasks whose dependencies are all satisfied.

**Only dispatch tasks that are runnable.** Never start tasks with unmet dependencies.

Only `done` satisfies dependencies (not `blocked`, `failed`, `partial`, `cancelled`).

**Feature-task operator choice:**
- Use `question()`: "These tasks are runnable and independent: [list]. Execute in parallel?"
- Record the decision with `hive_context_write({ feature: "feature-name", name: "execution-decisions", content: "..." })`
- Proceed only after operator approval

## When to Use

```dot
digraph when_to_use {
    "Multiple failures?" [shape=diamond];
    "Are they independent?" [shape=diamond];
    "Single agent investigates all" [shape=box];
    "One agent per problem domain" [shape=box];
    "Can they work in parallel?" [shape=diamond];
    "Sequential agents" [shape=box];
    "Parallel dispatch" [shape=box];

    "Multiple failures?" -> "Are they independent?" [label="yes"];
    "Are they independent?" -> "Single agent investigates all" [label="no - related"];
    "Are they independent?" -> "Can they work in parallel?" [label="yes"];
    "Can they work in parallel?" -> "Parallel dispatch" [label="yes"];
    "Can they work in parallel?" -> "Sequential agents" [label="no - shared state"];
}
```

**Use when:**
- 3+ test files failing with different root causes
- Multiple subsystems broken independently
- Each problem can be understood without context from others
- No shared state between investigations

**Don't use when:**
- Failures are related (fix one might fix others)
- Need to understand full system state
- Agents would interfere with each other

## The Pattern

### 1. Identify Independent Domains

Group failures by what's broken:
- File A tests: Tool approval flow
- File B tests: Batch completion behavior
- File C tests: Abort functionality

Each domain is independent - fixing tool approval doesn't affect abort tests.

In ad-hoc mode, do not use this step to define lane boundaries. Consume the ready wave from `orchestrating-ad-hoc-work`.

### 2. Create Focused Agent Tasks

Each agent gets:
- **Specific scope:** One primary goal, which may include tightly coupled code, tests, docs, and multiple files
- **Clear goal:** Make these tests pass
- **Constraints:** Don't change other code
- **Expected output:** Summary of what you found and fixed

Each native `task()` launch has one primary goal and one terminal handoff. Give complete constraints and acceptance criteria only for that goal. Point at catalog names and IDs rather than pasting every context body. Never pass `task_id` to `task()` or send a follow-up prompt to a completed, failed, or blocked session. Returned task IDs are observe-only board handles for status, reconcile, and cancel.

In feature-task mode, one implementation assignment normally maps to one numbered task; an independently verifiable new deliverable requires a DAG amendment or append-only manual task. In ad-hoc mode, use multiple fresh one-goal launches with disjoint path ownership or sequence overlapping writers.

### 3. Dispatch in Parallel

The example below is feature-task mode. In ad-hoc mode, consume the ready wave and prepared runs from `orchestrating-ad-hoc-work`.

```typescript
// Gate-open only: use background: true when independent foreground work can continue.
hive_execution_prepare({ scope: { kind: "task", task: "01-fix-abort-tests" }, placement: { kind: "worktree" } })
task({ subagent_type: "forager-worker", description: "Fix abort tests", prompt: "Fix abort tests", background: true })
hive_execution_prepare({ scope: { kind: "task", task: "02-fix-batch-tests" }, placement: { kind: "worktree" } })
task({ subagent_type: "forager-worker", description: "Fix batch tests", prompt: "Fix batch tests", background: true })

// Blocking alternative, including every gate-closed session:
hive_execution_prepare({ scope: { kind: "task", task: "03-fix-cleanup-tests" }, placement: { kind: "worktree" } })
await task({ subagent_type: "forager-worker", description: "Fix cleanup tests", prompt: "Fix cleanup tests" })
```

Independent Forager worktrees may be prepared and dispatched under one parent. Call `hive_execution_prepare` with the exact task or ad-hoc scope and placement, then issue the next native `task()` call unchanged with a Forager or Forager-derived agent. Two executions conflict when their exact worktree identity sets intersect. A live claim blocks conflicting preparation, dispatch, and lifecycle mutation of that worktree identity. Treat installs, builds, formatters, generators, and tests as mutations. Distinct worktrees do not isolate fixed-path fixtures, ports, databases, containers, generated outputs, or external mutable resources; consume the owning workflow's resource sequencing. Ordinary Scout, advisor, and reviewer launches remain eligible for same-message parallel dispatch and do not require an armed execution.

Use Forager-derived workers for delegated execution. A rare native `general` exception is an ordinary `task()` call: it consumes no arm and gains no Hive claim, managed context, or lifecycle authority. General receives ordinary tools only, no Hive authority, recursion, or questions. Native helpers keep only their bounded operational permissions. Helper and general calls use a runtime-local parent/call/child bind for Hive-tool authentication; they do not take a live claim on a worktree or the project root. Unknown targets remain denied. Hive's bounded Architect planning lane remains available. Isolated worktrees are the managed placement. Direct checkout work is unmanaged OpenCode work, not a Hive placement. Worktree integration follows its authorized lifecycle.

Recover native binding from exact parent/call metadata only; never guess the latest child or infer ownership from prose. Preserve the workspace while a writer may still be live, and never copy its mutable progress. Retry after confirmed termination may reuse the same worktree. Attached or uncertain feature-task scopes remain quarantined, and preparation stays denied until exact supported stop or finalization evidence is recorded. Do not invent an alternate feature-task placement while the prior writer may still be live. For ad-hoc work, retry after confirmed termination may reuse the same `runId` worktree. Retry while termination is unobserved cannot reuse that run; start a new ad-hoc `runId` and worktree without copying mutable progress from the uncertain run. Archive, restart, and preparation expiry do not release uncertain execution. See `background-delegation` for board recovery.
For read-only research, use `parallel-exploration`; this skill owns writing/change and execution dispatch.

```typescript
task({ subagent_type: '<chosen-advisor-or-reviewer>', prompt: 'Diagnose failure A and report without edits' })
task({ subagent_type: '<chosen-advisor-or-reviewer>', prompt: 'Diagnose failure B and report without edits' })
```

Choose the best-fit available descriptor for the requested output. Scout is for bounded source retrieval, not causal diagnosis or solution selection. A Forager diagnosis-only lane reports evidence, hypotheses tested and untested, a supported conclusion or unresolved status, and options when asked; it must not fix, edit, commit, or perform destructive reproduction unless the mission separately authorizes implementation in appropriate isolation.

### 4. Review and Integrate

When agents return:
- Read each summary
- Verify fixes don't conflict
- In feature-task mode, follow the feature workflow's verification and `hive_merge` lifecycle.
- In ad-hoc mode, return result state to `orchestrating-ad-hoc-work`, which owns review gates, primary-only `hive_execution_finish`, deterministic integration, full integrated-batch verification, and `hive_adhoc_merge`.

## Agent Prompt Structure

Good agent prompts are:
1. **Focused** - One clear problem domain
2. **Self-contained** - All context needed to understand the problem, as pointers and known facts, not a dump of every note
3. **Specific about output** - What should the agent return?

```markdown
Fix the 3 failing tests in src/agents/agent-tool-abort.test.ts:

1. "should abort tool with partial output capture" - expects 'interrupted at' in message
2. "should handle mixed completed and aborted tools" - fast tool aborted instead of completed
3. "should properly track pendingToolCount" - expects 3 results but gets 0

These are timing/race condition issues. Your task:

1. Read the test file and understand what each test verifies
2. Identify root cause - timing issues or actual bugs?
3. Fix by:
   - Replacing arbitrary timeouts with event-based waiting
   - Fixing bugs in abort implementation if found
   - Adjusting test expectations if testing changed behavior

Do NOT just increase timeouts - find the real issue.

Return: Summary of what you found and what you fixed.
```

## Common Mistakes

**❌ Too broad:** "Fix all the tests" - agent gets lost
**✅ Specific:** "Fix agent-tool-abort.test.ts" - focused scope

**❌ No context:** "Fix the race condition" - agent doesn't know where
**✅ Context:** Paste the error messages and test names

**❌ No constraints:** Agent might refactor everything
**✅ Constraints:** "Do NOT change production code" or "Fix tests only"

**❌ Vague output:** "Fix it" - you don't know what changed
**✅ Specific:** "Return summary of root cause and changes"

## When NOT to Use

**Related failures:** Fixing one might fix others - investigate together first
**Need full context:** Understanding requires seeing entire system
**Exploratory debugging:** You don't know what's broken yet
**Shared state:** Agents would interfere (editing same files, using same resources)

## Real Example from Session

**Scenario:** 6 test failures across 3 files after major refactoring

**Failures:**
- agent-tool-abort.test.ts: 3 failures (timing issues)
- batch-completion-behavior.test.ts: 2 failures (tools not executing)
- tool-approval-race-conditions.test.ts: 1 failure (execution count = 0)

**Decision:** Independent domains - abort logic separate from batch completion separate from race conditions

**Dispatch:**
```
Agent 1 → Fix agent-tool-abort.test.ts
Agent 2 → Fix batch-completion-behavior.test.ts
Agent 3 → Fix tool-approval-race-conditions.test.ts
```

**Results:**
- Agent 1: Replaced timeouts with event-based waiting
- Agent 2: Fixed event structure bug (threadId in wrong place)
- Agent 3: Added wait for async tool execution to complete

**Integration:** All fixes independent, no conflicts, full suite green

**Time saved:** 3 problems solved in parallel vs sequentially

## Key Benefits

1. **Parallelization** - Multiple investigations happen simultaneously
2. **Focus** - Each agent has narrow scope, less context to track
3. **Independence** - Agents don't interfere with each other
4. **Speed** - 3 problems solved in time of 1

## Verification by Mode

In feature-task mode, follow the feature workflow's review, merge, and final-verification gates, including its full-suite policy. In ad-hoc mode, return result and resource state to `orchestrating-ad-hoc-work`; it owns per-lane gates and one integrated canonical verification after the accepted batch is merged.

## Real-World Impact

From debugging session (2025-10-03):
- 6 failures across 3 files
- 3 agents dispatched in parallel
- All investigations completed concurrently
- All fixes integrated successfully
- Zero conflicts between agent changes
