---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
---

# Systematic Debugging

## Overview

Random fixes waste time and create new bugs. Quick patches mask underlying issues.

**Core principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes.

## When to Use

Use for ANY technical issue:
- Test failures
- Bugs in production
- Unexpected behavior
- Performance problems
- Build failures
- Integration issues

**Use this ESPECIALLY when:**
- Under time pressure (emergencies make guessing tempting)
- "Just one quick fix" seems obvious
- You've already tried multiple fixes
- Previous fix didn't work
- You don't fully understand the issue

**Don't skip when:**
- Issue seems simple (simple bugs have root causes too)
- You're in a hurry (rushing guarantees rework)
- Manager wants it fixed NOW (systematic is faster than thrashing)

## The Four Phases

You MUST complete each phase before proceeding to the next.

### Phase 1: Root Cause Investigation

**BEFORE attempting ANY fix:**

1. **Read Error Messages Carefully**
   - Don't skip past errors or warnings
   - They often contain the exact solution
   - Read stack traces completely
   - Note line numbers, file paths, error codes

2. **Reproduce Consistently**
   - Can you trigger it reliably?
   - What are the exact steps?
   - Does it happen every time?
   - If not reproducible → gather more data, don't guess

3. **Check Recent Changes**
   - What changed that could cause this?
   - Git diff, recent commits
   - New dependencies, config changes
   - Environmental differences

4. **Gather Evidence in Multi-Component Systems**

   **WHEN system has multiple components (CI → build → signing, API → service → database):**

   **BEFORE proposing fixes, add diagnostic instrumentation:**
   ```
   For EACH component boundary:
     - Log what data enters component
     - Log what data exits component
     - Verify environment/config propagation
     - Check state at each layer

   Run once to gather evidence showing WHERE it breaks
   THEN analyze evidence to identify failing component
   THEN investigate that specific component
   ```

   **Example (multi-layer system):**
   ```bash
   # Layer 1: Workflow
   echo "=== Secrets available in workflow: ==="
   echo "IDENTITY: ${IDENTITY:+SET}${IDENTITY:-UNSET}"

   # Layer 2: Build script
   echo "=== Env vars in build script: ==="
   env | grep IDENTITY || echo "IDENTITY not in environment"

   # Layer 3: Signing script
   echo "=== Keychain state: ==="
   security list-keychains
   security find-identity -v

   # Layer 4: Actual signing
   codesign --sign "$IDENTITY" --verbose=4 "$APP"
   ```

   **This reveals:** Which layer fails (secrets → workflow ✓, workflow → build ✗)

5. **Downstream Symptoms and Hidden Writes**

   **WHEN the visible error is a contract, parse, null, schema, hydration, or state-ownership failure that may be downstream:**

   - Do not stop at the first contract, parsing, type, null, or schema error
   - State expected behavior, the invariant, and what definitely did not happen
   - Trace the causal chain from the intended action or event to the observed effect
   - Ask whether the request, mutation, or write should have happened at all
   - Identify the canonical source of truth and competing sources
   - Find the first unintended side effect or write; fix that layer first
   - Do not make a contract more permissive unless you can prove the observed payload is intended

   Hidden write checks: lifecycle hooks, callbacks, subscribers, watchers, interceptors, middleware, retries, background jobs, cache refreshers, persistence restore, scheduled tasks, startup code, observer-driven mirroring.

   For other deep-stack errors, keep tracing up until you find the source. Fix at source, not at symptom.

### Phase 2: Pattern Analysis

**Find the pattern before fixing:**

1. **Find Working Examples**
   - Locate similar working code in same codebase
   - What works that's similar to what's broken?

2. **Compare Against References**
   - If implementing pattern, read reference implementation COMPLETELY
   - Don't skim - read every line
   - Understand the pattern fully before applying

3. **Identify Differences**
   - What's different between working and broken?
   - List every difference, however small
   - Don't assume "that can't matter"

4. **Understand Dependencies**
   - What other components does this need?
   - What settings, config, environment?
   - What assumptions does it make?

### Phase 3: Hypothesis and Testing

**Scientific method:**

1. **Form Single Hypothesis**
   - State clearly: "I think X is the root cause because Y"
   - Write it down
   - Be specific, not vague

2. **Test Minimally**
   - Make the SMALLEST possible change to test hypothesis
   - One variable at a time
   - Don't fix multiple things at once

3. **Verify Before Continuing**
   - Did it work? Yes → Phase 4
   - Didn't work? Form NEW hypothesis
   - DON'T add more fixes on top

4. **When You Don't Know**
   - Say "I don't understand X"
   - Don't pretend to know
   - Ask for help
   - Research more

### Phase 4: Implementation

**Fix the root cause, not the symptom:**

1. **Select Durable Testing and Verification**
   - Reproduction or equivalent root-cause evidence is required before a fix.
   - Select the durable testing and verification strategy from the defect, repository evidence, and mission.
   - Use strict TDD only when that strategy is selected; then load \`test-driven-development\` and observe the expected failure before implementation.
   - Other valid strategies include characterization tests before changing uncertain legacy behavior, tests alongside or after implementation when behavior is clear or design needs exploration, existing contract coverage for a pure internal refactor, and proportionate no-new-test verification with concrete rationale.

2. **Prepare Safely When Needed**
   - Permit tightly bounded behavior-preserving preparatory refactoring when the current structure makes a safe fix awkward.
   - Keep the preservation work tied to the defect, verify existing behavior, and separate it from the intended behavior change.

3. **Implement Single Fix**
   - Address the root cause identified
   - ONE change at a time
   - No "while I'm here" improvements

4. **Verify Fix**
   - Does the selected check now pass?
   - Did existing relevant checks remain green?
   - Issue actually resolved?

5. **If Fix Doesn't Work**
   - Preserve the failure and return to Phase 1 with the new evidence
   - Do not stack another speculative fix on the failed experiment
   - If recurring failures share a premise or reveal coupling symptoms, reassess that premise in step 6 before another equivalent attempt

6. **Recurring Failures: Question the Shared Premise**

   **Pattern indicating architectural problem:**
   - Each fix reveals new shared state/coupling/problem in different place
   - Fixes require "massive refactoring" to implement
   - Each fix creates new symptoms elsewhere

   **STOP and question fundamentals:**
   - Is this pattern fundamentally sound?
   - Are we "sticking with it through sheer inertia"?
   - Should we refactor architecture vs. continue fixing symptoms?

   When two or more fixes share a premise and fail the same gate, suspect the premise, not the fixes. The premise is the one sentence that every failed fix assumed. State it and choose evidence that could disprove it. For a load-imbalance problem, a per-actor census can distinguish the shared premise from an isolated symptom; it is not required for unrelated defects.

   Repeated failure is a reason to question architecture, not proof that architecture is wrong. Ask the operator only when a material scope, authority, or product decision remains; subagents return that clarification to their parent.

## Red Flags - STOP and Follow Process

If you catch yourself thinking:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "Skip meaningful verification; the fix is obvious"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "Pattern says X but I'll adapt it differently"
- "Here are the main problems: [lists fixes without investigation]"
- Proposing solutions before tracing data flow
- **"One more fix attempt" without new evidence about the shared premise**
- **Each fix reveals new problem in different place**

**ALL of these mean: STOP. Return to Phase 1.**

Repeated failures sharing a premise trigger the architecture reassessment in Phase 4.6; do not count attempts as proof of a cause.

## your human partner's Signals You're Doing It Wrong

**Watch for these redirections:**
- "Is that not happening?" - You assumed without verifying
- "Will it show us...?" - You should have added evidence gathering
- "Stop guessing" - You're proposing fixes without understanding
- "Ultrathink this" - Question fundamentals, not just symptoms
- "We're stuck?" (frustrated) - Your approach isn't working

**When you see these:** STOP. Return to Phase 1.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| "No new test means no verification is needed" | Every selected strategy still requires proportionate evidence that the defect is resolved. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |
| "One more fix attempt" after repeated failures | Name the shared premise and the new discriminating evidence before another equivalent attempt. |

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare | Identify differences |
| **3. Hypothesis** | Form theory, test minimally | Confirmed or new hypothesis |
| **4. Implementation** | Select strategy, prepare if needed, fix, verify | Bug resolved with proportionate evidence |

## When Process Reveals "No Root Cause"

If systematic investigation reveals issue is truly environmental, timing-dependent, or external:

1. You've completed the process
2. Document what you investigated
3. Implement appropriate handling (retry, timeout, error message)
4. Add monitoring/logging for future investigation

Before calling the cause external, state which local hypotheses were tested and what evidence excludes them. Missing evidence remains an open question.

## Supporting Techniques

- Validate at each actual trust or mutation boundary. Avoid rechecking an established invariant inside one boundary; retain checks after another actor, lock release, or await could have invalidated the observation.
- Prefer condition-based waiting: poll a condition instead of arbitrary timeouts.
- Restart bugs: suspect stale persistent state as well as code. Inspect or reproduce on an isolated copy; do not clear user or Hive-managed files, break locks, or discard retained evidence to test the hypothesis.
- When evidence refutes a hypothesis, reverse only the isolated experimental change it motivated. Preserve the failure evidence and unrelated work. Belt-and-suspenders that "might help" is a hypothesis, not a fix.
- Check for the pattern, not just the instance. Fix other instances only within the authorized scope; report those outside it.
- For measured slowness, use the same workload and measurement surface before and after. Name cache invalidation before claiming a caching win. A trace without source attribution supports a hypothesis, not a confirmed cause.

**Related skills:**
- **test-driven-development** - Load only when strict TDD is the selected strategy
- **skill({ name: "verification" })** - Verify fix worked before claiming success

The premise, restart-state, and hypothesis-reversal guidance is adapted from pstack; see `UPSTREAM.md` and `LICENSE.pstack` in this skill. These additions do not replace Hive's source/candidate evidence or recovery contracts.
