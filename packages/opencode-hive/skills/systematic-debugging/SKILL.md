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
NO FIXES WITHOUT CAUSAL EVIDENCE FIRST
```

Until you can say what is wrong, where it first goes wrong, and why that produces the symptom, you cannot propose fixes. How much investigation that takes depends on what the evidence already shows; the bar below says when to stop.

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

## The Causal-Evidence Bar

Investigate until the evidence meets this bar, then fix. No fixed sequence of steps has to run first.

- **Observed**: you have seen the failure, as complete error text and stack or as a reproduction. When the mission allows only equivalent evidence such as a log or a report, name what stands in for the reproduction.
- **Located**: you can point to the first wrong behavior, the earliest place where what happened departs from what should have happened, not only where the error surfaced.
- **Explained**: you can say why that behavior produces the symptom, and each competing explanation you considered is excluded by evidence or named as still open.

Settled evidence ends the search. When the stack trace lands on one changed line and a reproduction fails there the same way, reading that line and its caller is enough; instrumenting every component only delays the fix. Ambiguous evidence needs a discriminating observation, one that the competing causes predict differently. When a nightly job began failing on the day a dependency bump and a new cache layer both landed, and either explains the stale output, rerunning with only the dependency reverted separates them. Reading more logs does not.

When you cannot meet the bar, say "I don't understand X", research it or ask for help; do not pretend to know.

## Choose Techniques By Uncertainty

Pick the technique that answers the question the evidence leaves open. This table is enough to choose.

| Open question | Technique |
|---|---|
| What exactly failed? | Read the complete error and stack trace |
| Can I trigger it? | Reproduce; when you cannot, gather more data |
| What changed? | Diff, recent commits, dependencies, configuration, environment |
| Which component boundary breaks? | Observe at the boundary the evidence points to first |
| What does working code do differently? | Compare against a working example |
| Which of several causes? | One hypothesis and the smallest discriminating test |
| Is persistent state stale? | Inspect it or reproduce on an isolated copy |
| Why is it slow? | Same workload and measurement surface before and after |

A technique that writes state, runs risky behavior, or touches retained evidence stays inside your assignment's authority. A diagnosis-only assignment uses read-only forms and reports what it could not observe.

Read [references/diagnostic-techniques.md](references/diagnostic-techniques.md) when you need a technique's steps, the boundary-observation example, or the hypothesis, stale-state, slowness and shared-premise techniques.

## Downstream Symptoms and Hidden Writes

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

## Fix the Root Cause

1. **Select Durable Testing and Verification**
   - Reproduction or equivalent root-cause evidence is required before a fix.
   - Select the durable testing and verification strategy from the defect, repository evidence, and mission.
   - Use strict TDD only when that strategy is selected; then load `test-driven-development` and observe the expected failure before implementation.
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

## When a Fix Does Not Work

Preserve the failure and return to the causal question with the new evidence. Do not stack another speculative fix on the failed experiment.

When two or more fixes share a premise and fail the same gate, suspect the premise, not the fixes. The premise is the one sentence that every failed fix assumed. State it and choose evidence that could disprove it. Repeated failure is a reason to question architecture, not proof that architecture is wrong. Two attempts assumed the stale value came from the cache and both failed the same check; reading the value at the code that writes it tests that shared premise, where a third cache fix would not.

**Attempt limits stay as the role sets them.** Reassessing a premise changes which question the next attempt investigates; it never resets or extends the role's retained attempt budget. A Forager keeps its three iterations and three failed approaches, and every failed attempt counts toward them. At the limit, follow the role's own safe recovery and reporting: a Forager stops editing, preserves retained state, and reports blocked with the attempts made, the premise tested and the evidence. A diagnosis-only assignment stays report-only throughout and reports the evidence, the hypotheses tested and untested, and a supported conclusion or the unresolved status. Ask the operator only when a material scope, authority, or product decision remains; subagents return that clarification to their parent.

## Red Flags - Return to the Causal Question

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

**ALL of these mean: STOP. Return to the causal-evidence bar.**

Repeated failures sharing a premise call for the reassessment above; do not count attempts as proof of a cause.

## your human partner's Signals You're Doing It Wrong

**Watch for these redirections:**
- "Is that not happening?" - You assumed without verifying
- "Will it show us...?" - You should have added evidence gathering
- "Stop guessing" - You're proposing fixes without understanding
- "Ultrathink this" - Question fundamentals, not just symptoms
- "We're stuck?" (frustrated) - Your approach isn't working

**When you see these:** STOP. Return to the causal-evidence bar.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. The evidence bar is short for simple bugs, not absent. |
| "Emergency, no time for process" | Establishing the cause is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| "No new test means no verification is needed" | Every selected strategy still requires proportionate evidence that the defect is resolved. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |
| "One more fix attempt" after repeated failures | Name the shared premise and the new discriminating evidence before another equivalent attempt. |

## When Investigation Finds No Local Root Cause

If investigation shows the issue is truly environmental, timing-dependent, or external:

1. Document what you investigated
2. Implement appropriate handling (retry, timeout, error message)
3. Add monitoring/logging for future investigation

Before calling the cause external, state which local hypotheses were tested and what evidence excludes them. Missing evidence remains an open question.

## Protect State While Experimenting

- Restart bugs: suspect stale persistent state as well as code. Inspect or reproduce on an isolated copy; do not clear user or Hive-managed files, break locks, or discard retained evidence to test the hypothesis.
- When evidence refutes a hypothesis, reverse only the isolated experimental change it motivated. Preserve the failure evidence and unrelated work. Belt-and-suspenders that "might help" is a hypothesis, not a fix.
- Check for the pattern, not just the instance. Fix other instances only within the authorized scope; report those outside it.

**Related skills:**
- **test-driven-development** - Load only when strict TDD is the selected strategy
<!-- hive-host opencode-v1 -->
- **skill({ name: "verification" })** - Verify fix worked before claiming success
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
- **skill({ id })** for the catalog entry named "verification" - Verify fix worked before claiming success
<!-- /hive-host -->

The causal-evidence bar and technique selection adapt the four-phase process from obra/superpowers (MIT, Copyright (c) 2025 Jesse Vincent); see `UPSTREAM.md` and `LICENSE.superpowers` in this skill for the source revision, the passages kept and what changed.

The premise, restart-state, and hypothesis-reversal guidance is adapted from pstack; see `UPSTREAM.md` and `LICENSE.pstack` in this skill. These additions do not replace Hive's source/candidate evidence or recovery contracts.
