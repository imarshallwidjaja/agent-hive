---
name: parallel-exploration
description: Use when you need parallel, read-only exploration with the agent tool (Scout fan-out)
---

# Parallel Exploration (Scout Fan-Out)

## Overview

When you need to answer "where/how does X work?" across multiple domains (codebase, tests, docs, OSS), investigating sequentially wastes time. Each investigation is independent and can happen in parallel.

**Core principle:** Use one independently answerable, non-overlapping, context-bounded question per fresh Scout session. Launch every currently known, necessary, non-duplicative independent question together, then synthesize the results.

**Safe in Planning mode:** This is read-only exploration. It is OK to use during exploratory research even when there is no feature, no plan, and no approved tasks.

**This skill is for read-only research.** For parallel implementation work, refer to the skill at .github/skills/dispatching-parallel-agents/SKILL.md and invoke @forager directly for each runnable task.

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

## Tool-Aware Research

Load this skill before any multi-domain, read-only investigation that benefits from Scout fan-out.

- When the answer depends on rendered UI, browser state, console output, or network activity, use `browser` as one of the read-only slices.
- When external docs, APIs, or third-party implementations matter, use `web` or `io.github.upstash/context7/*` for the docs/OSS slice.
- Use `todo` only when you need to track multiple questions and evidence coverage during synthesis.
- Use `vscode/memory` only for findings the parent agent or a later turn will need after synthesis.

## The Pattern

### 1. Decompose Into Independent Questions

Split the investigation into independently answerable, non-overlapping questions. Good decomposition:

| Domain | Question Example |
|--------|------------------|
| Codebase | "Where is X implemented? What files define it?" |
| Tests | "How is X tested? What test patterns exist?" |
| Docs/OSS | "How do other projects implement X? What's the recommended pattern?" |
| Config | "How is X configured? What environment variables affect it?" |

**Bad decomposition (dependent questions):**
- "What is X?" then "How is X used?" (second depends on first)
- "Find the bug" then "Fix the bug" (not read-only)

### 2. Invoke Scout Agents in Parallel

Start every currently known, necessary, non-duplicative independent Scout request before waiting on any result. Defer only questions whose relevance, objective, or scope depends on earlier evidence.

```text
Invoke the @scout agent via the agent tool for question 1.
Invoke the @scout agent via the agent tool for question 2.
Invoke the @scout agent via the agent tool for question 3.
```

**Key points:**
- Invoke the @scout agent via the agent tool for read-only exploration
- Give each invocation a clear, focused scope
- Include the objective, known facts and references, constraints and non-goals, stop and return behavior, and expected output

### 3. Continue Working (Optional)

While tasks run, you can:
- Work on other aspects of the problem
- Prepare synthesis structure
- Start drafting based on what you already know

Each scout result returns to the parent chat when it completes.

### 4. Collect Results

When each task completes, its result is returned directly. Collect the outputs from each task and proceed to synthesis.

Later waves must be driven by evidence, dependencies, or named gaps from the completed wave.

### 5. Synthesize Findings

Combine results from all tasks:
- Cross-reference findings (file X mentioned by tasks A and B)
- Identify gaps (task C found nothing, need different approach)
- Build coherent answer from parallel evidence

### 6. Cleanup (If Needed)

No manual cancellation is required for these agent invocations.

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
```text
Invoke the @scout agent via the agent tool to find API route implementation.
Invoke the @scout agent via the agent tool to analyze concurrency.
Invoke the @scout agent via the agent tool to find the notification mechanism.
```

**Results:**
- Task 1: Found `background-tools.ts` (tool definition), `index.ts` (registration)
- Task 2: Found `manager.ts` with concurrency=3 default, queue-based scheduling
- Task 3: Found `session.prompt()` call in manager for parent notification

**Synthesis:** Complete picture of background task lifecycle in ~1/3 the time of sequential investigation.

## Common Mistakes

**Spawning sequentially (defeats the purpose):**
```text
Bad: invoke one scout agent, wait, then decide whether to invoke the next.
```

```text
Good: issue all independent scout invocations in the same response.
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
4. **Flexibility** - Cancel unneeded tasks, add new ones

## Verification

After using this pattern, verify:
- [ ] All tasks spawned before collecting any results (true fan-out)
- [ ] Verified agent-tool fan-out pattern used for parallel exploration
- [ ] Synthesized findings into coherent answer
