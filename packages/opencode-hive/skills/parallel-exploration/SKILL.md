---
name: parallel-exploration
description: "Agent Hive workflow skill for Scout fan-out. Use when a Hive agent needs parallel, read-only exploration through task()."
---

# Parallel Exploration (Scout Fan-Out)

## Overview

When you need to answer "where/how does X work?" across multiple domains (codebase, tests, docs, OSS), investigating sequentially wastes time. Each investigation is independent and can happen in parallel.

**Core principle:** Use one independently answerable, non-overlapping, context-bounded question per fresh Scout session. Launch every currently known, necessary, non-duplicative independent question in the same assistant message, then synthesize the bounded results.

**Delegation kind:** This is exploratory/read-only lightweight delegation. For kind-based scheduling under the gate, load `background-delegation` and let it govern foreground/blocking vs background wait mode.

**Safe in Planning mode:** This is read-only exploration. It is OK to use during exploratory research even when there is no feature, no plan, and no approved tasks.

**This skill is for read-only research.** For parallel implementation work, use \`skill({ name: "dispatching-parallel-agents" })\` with \`hive_worktree_start\`.

## When to Use

**Use when:**
- Investigation spans multiple domains (code + tests + docs)
- Questions are independent (answer to A doesn't affect B)
- No edits needed (read-only exploration)
- User asks for an exploration that likely spans multiple files/packages
- The work is read-only and the questions can be investigated independently

**Only skip this skill when:**
- Investigation requires shared state or context between questions
- It's a focused question that the primary agent can answer with a bounded direct lookup
- Questions are dependent (answer A materially changes what to ask for B)
- Work involves file edits (use Hive tasks / Forager instead)

**Important:** Do not treat "this is exploratory" as a reason to avoid delegation. This skill is specifically for exploratory research when fan-out makes it faster and cleaner.

## The Pattern

### 1. Decompose Into Independent Questions

Split the investigation into independently answerable, non-overlapping questions. Each question should fit in one context window. If a request will not fit in one context window, narrow the slice, capture bounded findings, and return to Hive with recommended next steps instead of pushing toward an oversized final report. Good decomposition:

Breadth, ambiguity, multi-domain or multi-repository scope, whole-incident RCA, and unknown targets are decomposition signals, not capable/custom Scout selection signals. When these signals are present, split the work into bounded slices before choosing any researcher.

| Domain | Question Example |
|--------|------------------|
| Codebase | "Where is X implemented? What files define it?" |
| Tests | "How is X tested? What test patterns exist?" |
| Docs/OSS | "How do other projects implement X? What's the recommended pattern?" |
| Config | "How is X configured? What environment variables affect it?" |

**Bad decomposition (dependent questions):**
- "What is X?" then "How is X used?" (second depends on first)
- "Find the bug" then "Fix the bug" (not read-only)

**Stop and return to Hive when:**
- another question would expand beyond the assigned objective
- a sub-question no longer fits in one context window
- the next useful step is implementation rather than exploration

### 2. Select Researcher For Each Bounded Slice

Choose the researcher only after each slice passes the one-window bound check. Use `scout-researcher` by default for each bounded exploratory slice. Use `scout-researcher-capable` only when one already-bounded question needs stronger synthesis, such as conflicting evidence or dense evidence on a named surface, or when the operator explicitly names it. Other configured scout-derived custom subagents remain valid when their domain or workflow clearly matches an already-bounded question. Capable or custom Scouts do not relax the one-window boundary and never replace decomposition or fan-out.

### 3. Decide Wait Mode And Dispatch

Dependency decides serial vs parallel. Wait mode decides blocking foreground vs background.

Blocking does not mean serial. Blocking only means the primary agent waits after dispatch. If several subagent tasks are independent, emit all of their `task()` calls in the same assistant message, then wait for the batch results.

- Serial: one `task()` call, wait for the result, then decide whether to call another. Use this only when a later prompt needs an earlier result.
- Blocking parallel fan-out: multiple `task()` calls in one assistant message, then wait for all results before continuing.
- Background parallel fan-out: background-mode task calls only when the primary agent can do unrelated foreground work. Follow the `background-delegation` skill before using background mode.

If the only reason for serializing is `task()` is blocking, that is incorrect. Blocking applies after dispatch, not between independent dispatches.

Launch every currently known, necessary, non-duplicative independent question before waiting for any results. Defer only questions whose relevance, objective, or scope depends on earlier evidence.

Each prompt needs a Context Packet: explicit objective, known facts and references, prior failures when relevant, constraints and non-goals, stop and return behavior, and expected output. Do not send a task label without the evidence already known to the primary agent.

Each native `task()` launch has one primary goal, starts one fresh subagent session, and ends with one terminal handoff. Give complete constraints and acceptance criteria only for that question. Never pass `task_id` to `task()`; returned task IDs are observe-only board handles for status, reconcile, and cancel. Do not send a follow-up prompt to a completed, failed, or blocked session. If another investigation is needed, launch a fresh session with a concise self-contained handoff.

```typescript
// Parallelize by issuing multiple task() calls in the same assistant message.
task({
  subagent_type: '<chosen-researcher>',
  description: 'Find API route implementation',
  prompt: `Where are API routes implemented and registered?
    - Find the tool definition
    - Find the plugin registration
    - Return file paths with line numbers`,
});

task({
  subagent_type: '<chosen-researcher>',
  description: 'Analyze background task concurrency',
  prompt: `How does background task concurrency/queueing work?
    - Find the manager/scheduler code
    - Document the concurrency model
    - Return file paths with evidence`,
});

task({
  subagent_type: '<chosen-researcher>',
  description: 'Find parent notification mechanism',
  prompt: `How does parent notification work for background tasks?
    - Where is the notification built?
    - How is it sent to the parent session?
    - Return file paths with evidence`,
});
```

**Key points:**
- Decompose and bound each slice before choosing any built-in or custom researcher
- Use `subagent_type: 'scout-researcher'` for bounded exploratory discovery unless that bounded question clearly needs a matching specialist
- Give each task a clear, focused `description`
- Make prompts specific about what evidence to return, including known facts and expected output
- Dispatch dependency-independent slices together, even though normal `task()` is blocking
- When the env-gated appendix is present, follow `background-delegation` for wait mode; otherwise use the normal blocking return flow

### 4. Collect Results

After the fan-out message, collect the task results through the normal `task()` return flow. Do not invent background polling or a separate async workflow.

### 5. Synthesize Findings

When each task completes, its result is returned directly. Collect the outputs from each task and proceed to synthesis.

Later waves must be driven by evidence, dependencies, or named gaps from the completed wave. Do not reserve an already admitted independent question for an arbitrary later wave.

### 6. Cleanup (If Needed)

Combine results from all tasks:
- Cross-reference findings (file X mentioned by tasks A and B)
- Identify gaps (task C found nothing, need different approach)
- Build coherent answer from parallel evidence
- If the remaining work would no longer fit in one context window, return to Hive with bounded findings and recommended next steps

No manual cancellation is required in task mode.

## Prompt Templates

### Codebase Slice

```
Investigate [TOPIC] in the codebase:
- Where is [X] defined/implemented?
- What files contain [X]?
- How does [X] interact with [Y]?

Return:
- File paths with line numbers
- Brief code snippets as evidence
- Key patterns observed
```

### Tests Slice

```
Investigate how [TOPIC] is tested:
- What test files cover [X]?
- What testing patterns are used?
- What edge cases are tested?

Return:
- Test file paths
- Example test patterns
- Coverage gaps if obvious
```

### Docs/OSS Slice

```
Research [TOPIC] in external sources:
- How do other projects implement [X]?
- What does the official documentation say?
- What are common patterns/anti-patterns?

Return:
- Links to relevant docs/repos
- Key recommendations
- Patterns that apply to our codebase
```

## Real Example

**Investigation:** "How does the API routing system work?"

**Decomposition:**
1. Implementation: Where are API routes defined?
2. Routing: How does route registration work?
3. Notifications: How are errors surfaced to the caller?

**Fan-out:**
```typescript
// Parallelize by issuing multiple task() calls in the same assistant message.
task({
  subagent_type: '<chosen-researcher>',
  description: 'Find API route implementation',
  prompt: 'Where are API routes implemented? Find tool definition and registration.',
});

task({
  subagent_type: '<chosen-researcher>',
  description: 'Analyze concurrency model',
  prompt: 'How does background task concurrency work? Find the manager/scheduler.',
});

task({
  subagent_type: '<chosen-researcher>',
  description: 'Find notification mechanism',
  prompt: 'How are parent sessions notified of task completion?',
});
```

**Results:**
- Task 1: Found `background-tools.ts` (tool definition), `index.ts` (registration)
- Task 2: Found `manager.ts` with concurrency=3 default, queue-based scheduling
- Task 3: Found `session.prompt()` call in manager for parent notification

**Synthesis:** Complete picture of background task lifecycle in ~1/3 the time of sequential investigation.

## Common Mistakes

**Spawning sequentially (defeats the purpose):**
```typescript
// BAD: Wait for each before spawning next
await task({ ... });
await task({ ... });
```

```typescript
// GOOD: Spawn all in the same assistant message
task({ ... });
task({ ... });
task({ ... });
```

**Dependent questions:**
- Don't spawn task B if it needs task A's answer
- Either make them independent or run sequentially

**Using for edits:**
- Scout is read-only; use Forager for implementation
- This skill is for exploration, not execution

## Key Benefits

1. **Speed** - 3 investigations in time of 1
2. **Focus** - Each Scout has narrow scope
3. **Independence** - No interference between tasks
4. **Flexibility** - Ignore irrelevant returned findings and dispatch follow-up tasks only after synthesis

## Verification

After using this pattern, verify:
- [ ] All tasks spawned before collecting any results (true fan-out)
- [ ] Verified `task()` fan-out pattern used for parallel exploration
- [ ] Synthesized findings into coherent answer
