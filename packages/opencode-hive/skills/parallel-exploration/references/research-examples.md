# Research examples

Read this reference when you write the first Scout fan-out of a session and want complete calls and prompts to adapt, when you split a broad question into slices and want sample decompositions, or when you check a fan-out for the sequential-spawning mistake. The rules stay in `SKILL.md`: one independently answerable, context-bounded question per fresh Scout session, every known independent question launched in the same assistant message, and synthesis owned by the parent. The examples illustrate those rules and add no authority.

## Sample decomposition

| Domain | Question example |
|--------|------------------|
| Codebase | "Where is X implemented? What files define it?" |
| Tests | "How is X tested? What test patterns exist?" |
| Docs/OSS | "How do other projects implement X? What pattern does each source recommend?" |
| Config | "How is X configured? What environment variables affect it?" |

Dependent questions are a poor decomposition: "What is X?" followed by "How is X used?" (the second depends on the first), or "Find the bug" followed by "Fix the bug" (not read-only). Run dependent questions serially or rewrite them as independent evidence slices.

## Fan-out calls

Issue every independent call in the same assistant message, then collect the results.

<!-- hive-host opencode-v1 -->
OpenCode v1:

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
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
OpenCode v2:

```typescript
// Parallelize by issuing multiple subagent() calls in the same assistant message.
subagent({
  agent: '<chosen-researcher>',
  description: 'Find API route implementation',
  prompt: `Where are API routes implemented and registered?
    - Find the tool definition
    - Find the plugin registration
    - Return file paths with line numbers`,
});

subagent({
  agent: '<chosen-researcher>',
  description: 'Analyze background task concurrency',
  prompt: `How does background task concurrency/queueing work?
    - Find the manager/scheduler code
    - Document the concurrency model
    - Return file paths with evidence`,
});

subagent({
  agent: '<chosen-researcher>',
  description: 'Find parent notification mechanism',
  prompt: `How does parent notification work for background tasks?
    - Where is the notification built?
    - How is it sent to the parent session?
    - Return file paths with evidence`,
});
```
<!-- /hive-host -->

## Sequential spawning

Waiting for each call before issuing the next defeats the fan-out. Blocking applies after dispatch, not between independent dispatches.

<!-- hive-host opencode-v1 -->
OpenCode v1:

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
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
OpenCode v2:

```typescript
// BAD: Wait for each before spawning next
await subagent({ ... });
await subagent({ ... });
```

```typescript
// GOOD: Spawn all in the same assistant message
subagent({ ... });
subagent({ ... });
subagent({ ... });
```
<!-- /hive-host -->

## Slice prompt templates

Each prompt carries the Context Packet from `SKILL.md`: explicit objective, known facts and references, prior failures when relevant, constraints and non-goals, stop and return behavior, and expected output. The templates below show the evidence request; add the packet around them.

### Codebase slice

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

### Tests slice

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

### Docs/OSS slice

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

## Synthesis

Combine the returned slices into one answer. Cross-reference findings (file X mentioned by slices A and B), identify gaps (slice C found nothing, so a different approach is needed), and build a coherent answer from the parallel evidence. Name each retrieval gap that remains. If the remaining retrieval would no longer fit in one context window, return to Hive with the bounded findings and the named gaps.
