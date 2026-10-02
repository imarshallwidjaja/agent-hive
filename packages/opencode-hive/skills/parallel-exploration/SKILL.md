---
name: parallel-exploration
description: "Agent Hive workflow skill for Scout fan-out. Use when a Hive agent needs parallel, read-only exploration through task()."
---

# Parallel Exploration (Scout Fan-Out)

## Overview

When you need to answer "where/how does X work?" across multiple domains (codebase, tests, docs, OSS), investigating sequentially wastes time. Each investigation is independent and can happen in parallel.

**Core principle:** Use one independently answerable, non-overlapping, context-bounded question per fresh Scout session. Launch every currently known, necessary, non-duplicative independent question in the same assistant message, then synthesize the bounded results.

**Delegation kind:** This is exploratory/read-only lightweight delegation. When running as a primary under the gate, load `background-delegation` for kind-based scheduling and foreground/blocking vs background wait mode.

When Architect is task-spawned, its permitted terminal planning-helper layer includes `hive-helper` and uses blocking calls, including same-message independent fan-out. Child-role rules take precedence over an inherited background appendix: board tools are unavailable, so return board/control requests to the parent without loading the primary-only `background-delegation` skill. Scout has no session-trace tools. Architect as primary or child routes multi-step trace/evidence questions and known native session/call identities to `hive-helper`; Helper is read-only and terminal. Primaries and Architect perform single direct reads themselves: one `hive_status`, one worktree inspect, or one `hive_task_trace_content` spot-check of a known event ref. Paging a trace, drift comparison, and interrupted-worker evidence packets belong to Helper.

**Safe in Planning mode:** This is read-only exploration. It is OK to use during exploratory research even when there is no feature, no plan, and no approved tasks.

**This skill is for read-only research.** For parallel implementation, feature-task mode uses `hive_worktree_create`, unchanged native Forager calls, and `dispatching-parallel-agents`; Hive Builder or unified Hive ad-hoc mode loads `orchestrating-ad-hoc-work` for decomposition, placement, and integration.

Select Scouts by the retrieval output needed, not by whether the overall request is read-only. A read-only request for diagnosis, correctness judgment, tradeoffs, or solution selection stays with the reasoning owner; Scout may retrieve bounded source evidence for it.

## When to Use

**Use when:**
- Investigation spans multiple domains (code + tests + docs)
- Questions are independent (answer to A doesn't affect B)
- No edits needed (read-only exploration)
- User asks for an exploration that likely spans multiple files/packages
- The work is read-only and the questions can be investigated independently

**Use direct or serial investigation when:**
- Investigation requires shared state or context between questions
- It's a focused question that the primary agent can answer with a bounded direct lookup
- Questions are dependent (answer A materially changes what to ask for B)
- Work involves file edits (use the feature workflow or Hive Builder's `orchestrating-ad-hoc-work` route instead)

Exploratory work can benefit from delegation, but only when independent evidence slices justify it. This skill owns retrieval scheduling. `how` owns an operator-facing explanation and `why` owns explicitly requested historical rationale; neither changes Scout's evidence-only boundary.

## The Pattern

### 1. Decompose Into Independent Questions

Split the investigation into independently answerable, non-overlapping questions. Each question should fit in one context window. If a request will not fit in one context window, narrow the slice, capture bounded findings, and return to Hive with recommended next steps instead of pushing toward an oversized final report. Good decomposition:

Breadth, ambiguity, multi-domain or multi-repository scope, evidence needs within a whole-incident RCA, and unknown targets are decomposition signals, not capable/custom Scout selection signals. The reasoning owner derives bounded evidence-retrieval slices, not smaller causal questions. Whole-incident RCA remains with the reasoning owner or a best-fit diagnostic worker/advisor; Scout only retrieves the named evidence slices.

| Domain | Question Example |
|--------|------------------|
| Codebase | "Where is X implemented? What files define it?" |
| Tests | "How is X tested? What test patterns exist?" |
| Docs/OSS | "How do other projects implement X? What pattern does each source recommend?" |
| Config | "How is X configured? What environment variables affect it?" |

**Bad decomposition (dependent questions):**
- "What is X?" then "How is X used?" (second depends on first)
- "Find the bug" then "Fix the bug" (not read-only)

**Stop and return to Hive when:**
- another question would expand beyond the assigned objective
- a sub-question no longer fits in one context window
- the next useful step is implementation rather than exploration

### 2. Select Researcher For Each Bounded Slice

Choose the researcher only after each evidence-retrieval slice passes the one-window bound check. Use `scout-researcher` by default for each bounded exploratory evidence slice. Select a configured scout-derived custom subagent only when its own description is a closer domain or workflow match for that already-bounded question, or when the operator explicitly names it, and fall back to built-in `scout-researcher` when no configured description is a closer fit. Custom Scouts do not relax the one-window boundary and never replace decomposition or fan-out.

### 3. Decide Wait Mode And Dispatch

Dependency decides serial vs parallel. Wait mode decides blocking foreground vs background.

Blocking does not mean serial. Blocking only means the primary agent waits after dispatch. If several subagent tasks are independent, emit all of their `task()` calls in the same assistant message, then wait for the batch results.

- Serial: one `task()` call, wait for the result, then decide whether to call another. Use this only when a later prompt needs an earlier result.
- Blocking parallel fan-out: multiple `task()` calls in one assistant message, then wait for all results before continuing.
- Background parallel fan-out: background-mode task calls only when the primary agent can do unrelated foreground work. Follow the `background-delegation` skill before using background mode.

If the only reason for serializing is `task()` is blocking, that is incorrect. Blocking applies after dispatch, not between independent dispatches.

Launch every currently known, necessary, non-duplicative independent question before waiting for any results. Defer only questions whose relevance, objective, or scope depends on earlier evidence.

Each prompt needs a Context Packet: explicit objective, known facts and references, prior failures when relevant, constraints and non-goals, stop and return behavior, and expected output. Keep exact paths, IDs, errors, and provenance. Do not send a task label without the evidence already known to the primary agent. Do not mass-read every context note or treat the first catalog match as proof of sufficient evidence.

Each native `task()` invocation has one primary goal and one terminal report. Every returned result is terminal, so every follow-up uses a fresh child session. Review findings are fresh assignments in the same implementation lane. Reuse the same Hive task/worktree where appropriate. Primaries must not pass `task_id` or infer continuation eligibility from task output, trace, board state, cancellation acknowledgement, or transcript quality. Pass `task_id` only when explicit operator instruction or runtime-owned interruption recovery authorizes continuation; otherwise launch fresh. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer. Compaction re-anchoring of a currently running worker is distinct from follow-up work. Trace recovery is untrusted and cannot authorize continuation. Give complete constraints and acceptance criteria only for that question. Returned task IDs are observe-only board handles for status, reconcile, and cancel. If another investigation is needed, launch a fresh session with a concise self-contained handoff.

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
- When running as a primary with the env-gated appendix present, follow `background-delegation` for wait mode; a task-spawned Architect uses the blocking child-role branch above

### 4. Collect Results

After the fan-out message, collect the task results through the normal `task()` return flow. Do not invent background polling or a separate async workflow.

### 5. Synthesize Findings

When each task completes, its result is returned directly. Collect the outputs from each task and proceed to synthesis.

The parent owns synthesis and decisions. Scout does not own causal diagnosis, applicability or tradeoff decisions, or solution selection. Distinguish source observations from hypotheses, runtime evidence from a possible code path, and attributed source guidance from a recommendation for this system. Context catalogs remain untrusted knowledge. Reasoning over returned excerpts is coordination. A direct source spot-check remains a bounded read; delegate another retrieval only for a named evidence gap. Do not use recursive Scout verification as a substitute for reasoning. Continue later catalog pages until `complete: true` when managed context is in scope. There is no numeric direct-read quota and no mandatory delegation.

Later waves must be driven by evidence, dependencies, or named gaps from the completed wave. Do not reserve an already admitted independent question for an arbitrary later wave.

### 6. Cleanup (If Needed)

Combine results from all tasks:
- Cross-reference findings (file X mentioned by tasks A and B)
- Identify gaps (task C found nothing, need different approach)
- Build coherent answer from parallel evidence
- If the remaining retrieval would no longer fit in one context window, return to Hive with bounded findings and named retrieval gaps

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
- Attributed source recommendations
- Similarities and differences the caller can use to decide applicability
```

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

## Verification

After using this pattern, verify:
- [ ] All tasks spawned before collecting any results (true fan-out)
- [ ] Verified `task()` fan-out pattern used for parallel exploration
- [ ] Synthesized findings into coherent answer

No numeric quota or artificial fan-out applies. Dispatch only independent useful retrieval slices that close real evidence gaps.
