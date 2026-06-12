---
name: adversarial-review
description: Use when explicitly asked for adversarial, hostile, red-team, stress-test, multi-pass, or cross-model review of a plan, approach, code diff, code-vs-plan implementation, or simplicity pass.
---

# Adversarial Review

Adversarial review is a read-only second-pass review posture. It tries to break the artifact under review, then consolidates only evidence-backed findings into a usable verdict or action path.

Core rule: the host agent contract still wins. `plan-reviewer`, `code-reviewer`, `approach-advisor`, and `simplicity-reviewer` keep their normal scope, verdict labels, and tool boundaries.

## Reference Basis

This flat skill distills these adversarial review patterns without importing reference subfiles:

- `neverinfamous/memory-journal-mcp` adversarial suite: dual-role baseline/adversary phases, phase isolation, consolidated reporting, and domain lenses for planning, skills, workflows, security, and performance.
- `dementev-dev/adversarial-review`: explicit mode detection for plan/code/code-vs-plan/file review, bounded revise loops, severity-based findings, mutation detection, and failure reporting for invalid reviewer artifacts.
- `poteto/noodle` adversarial-review: scope and intent declaration, reviewer lenses such as Skeptic/Architect/Minimalist, synthesized verdicts, read-only review, and reporting missing or empty external reviewer output.

## When To Use

Use this skill only when the operator or caller explicitly asks for adversarial review, stress testing, red-team review, hostile review, multi-pass review, cross-model review, or similar wording.

Do not use it for ordinary plan review, code review, simplicity review, or approach advice. Adversarial mode is intentionally noisier and should not contaminate normal reviewer behavior.

## Non-Negotiables

- Stay read-only. Do not edit files, update plans, commit, merge, or repair issues while acting as the adversarial reviewer.
- State scope and intent before reviewing. Review whether the artifact achieves the intent, not whether you personally prefer a different goal.
- Separate baseline from attack. First establish what exists; then switch posture and try to invalidate it.
- Report missing, empty, stale, or invalid review inputs. Do not silently skip a reviewer, file, plan, diff, or external validation result.
- If any review step mutates the artifact under review, stop and report the mutation. Continuing would review a moving target.
- Findings need concrete evidence. No vague concerns, taste comments, or speculative risks without a plausible failure path.
- Host output format wins. If a base reviewer requires `OKAY/REJECT`, `APPROVE/REQUEST_CHANGES`, or advisory output, preserve that contract and put adversarial detail inside the allowed sections.

## Mode Detection

Choose the narrowest mode from the caller's explicit request. If the request is ambiguous, infer from available context:

| Signal | Mode | Review Target |
|---|---|---|
| Plan text, Hive `plan.md`, task specs, no code diff | `plan` | Worker-readiness and plan failure modes |
| Code diff only | `code` | Implementation correctness and regression risk |
| Code diff plus plan/task reference | `code-vs-plan` | Whether implementation satisfies the plan/task |
| Architecture, migration, integration, persistence, deployment route | `approach` | Whether the proposed direction survives constraints |
| Completed implementation cleanup request | `simplicity` | Whether complexity is justified by current requirements |
| Explicit file path | `file` | That file only, unless imports are needed for evidence |

If no artifact is available, return `NEEDS_DISCUSSION` or the host agent's equivalent instead of inventing one.

## Review Protocol

### 1. Scope And Intent

Write a short scope statement:

```markdown
**Scope**: [plan/code/code-vs-plan/approach/simplicity/file]
**Intent**: [what the author is trying to achieve]
**Artifacts Reviewed**: [files, diff, plan/task refs, commands, external reviewer outputs]
```

If the artifact list is incomplete, say what is missing and how that limits the review.

### 2. Artifact Validation

Before critique, validate the inputs:

- Plan or task references exist when the review claims plan alignment.
- Diff or file paths exist when reviewing code.
- External reviewer output exists and is non-empty if external validation was attempted.
- Any supplied command output is fresh enough for the claim being reviewed.
- The artifact was not changed during review. If mutation is detected or suspected, stop and report it.

For git-backed code reviews, useful checks include `git status --short`, `git diff --name-only`, and the supplied plan/task reference. Do not run broad commands when the caller already provided enough bounded evidence.

### 3. Baseline Pass

Act as the baseline reviewer. Map what the artifact actually does or proposes:

- For `plan`: task sequence, dependencies, references, verification points, assumptions.
- For `code`: changed files, behavior changes, public contracts, tests, risky boundaries.
- For `code-vs-plan`: plan requirements mapped to changed files and verification.
- For `approach`: constraints, chosen route, alternatives explicitly rejected, escalation triggers.
- For `simplicity`: core purpose, added complexity, current requirement served by each abstraction.

Do not critique in this pass. Build the map the adversarial pass will attack.

### 4. Adversarial Pass

Switch posture. Assume the baseline missed something material.

Use the smallest lens set that fits the risk:

| Size / Risk | Lenses |
|---|---|
| Small, local, low-risk | Skeptic |
| Medium or multi-file | Skeptic + Architect |
| Large, high-risk, or broad diff | Skeptic + Architect + Minimalist |
| Security, persistence, concurrency, migration, public API | Add Boundary Breaker |
| Performance-sensitive path | Add Stress Tester |

Lens definitions:

- Skeptic: looks for false assumptions, missing edge cases, unhandled errors, and weak evidence.
- Architect: looks for coupling, sequencing failures, integration mismatches, migration risk, and operational blind spots.
- Minimalist: looks for unnecessary abstraction, compatibility branches, duplicated logic, and speculative flexibility.
- Boundary Breaker: attacks trust boundaries, auth/authz, data integrity, persistence, concurrency, and public contracts.
- Stress Tester: attacks hot paths, scaling assumptions, expensive loops, test/runtime cost, and resource leaks.

Only report a finding if it has a concrete failure mode, affected artifact, impact, and fix direction.

### 5. Optional External Validation

External or cross-model validation is useful but not required. Attempt it only when the environment provides a safe read-only path and the caller requested or approved it.

If external validation is attempted:

- Name the external mechanism or reviewer model.
- Confirm the output exists and is non-empty before using it.
- Report missing, failed, timed out, or empty output as a validation failure.
- Treat external output as another evidence source, not automatic truth.
- Do not let external tools mutate the artifact under review.

If external validation is not available or not safe, say it was skipped and continue with the internal adversarial pass.

### 6. Consolidation

Deduplicate findings. Keep the highest severity and clearest evidence. Drop concerns that are merely stylistic, already covered by host reviewer scope, or not actionable.

Severity:

- Critical: breaks correctness, data integrity, security, public contract, or the stated task.
- High: likely defect, serious missing requirement, unsafe sequence, or major verification gap.
- Medium: plausible edge case, maintainability risk, or meaningful missing coverage.
- Low: small cleanup or clarity issue. Include only if the host format has room.

## Mode-Specific Bars

### Plan Mode

Preserve `plan-reviewer` semantics. `REJECT` still means a capable worker would likely be blocked or seriously misdirected. Use adversarial findings to expose hidden blockers, missing references, contradictory dependencies, non-executable verification, or assumptions that affect scope/correctness.

### Code Mode

Preserve `code-reviewer` semantics. Findings must cite changed files or behavior. Prefer defects, missing tests, requirement mismatches, risky persistence/API/concurrency behavior, and verification gaps over broad style feedback.

### Code-Vs-Plan Mode

Map each material plan requirement to implementation evidence. Attack omissions, changed behavior not called for by the plan, unverified acceptance criteria, and code that satisfies a nearby requirement but not the actual one.

### Approach Mode

Preserve `approach-advisor` semantics. Do not approve or reject. Recommend whether the path survives constraints, which assumption is weakest, and what would trigger escalation to a different route.

### Simplicity Mode

Preserve `simplicity-reviewer` semantics. The adversarial posture is deletion-biased: attack every abstraction, option bag, fallback branch, adapter, compatibility path, and duplicated check. Only report simplifications that preserve approved behavior.

## Output Template

Use the host agent's required format when one exists. If no format is provided, use:

```markdown
**Scope**: [mode]
**Intent**: [intent]
**Artifacts Reviewed**: [list]
**Validation Notes**: [missing/failed/skipped external validation, mutation checks, stale evidence]

**Adversarial Verdict**: [APPROVED / REVISE / NEEDS_DISCUSSION]

**Bottom Line**: [2-3 sentences]

### Findings
- None | [severity: critical/high/medium/low] [artifact:line] - [issue]
  - What can go wrong: [failure mode]
  - Why vulnerable: [evidence]
  - Impact: [effect]
  - Recommendation: [specific fix direction]

### Lens Coverage
- Skeptic: [covered / not used + reason]
- Architect: [covered / not used + reason]
- Minimalist: [covered / not used + reason]
- Boundary Breaker: [covered / not used + reason]
- Stress Tester: [covered / not used + reason]

### Action Path
1. [highest priority fix or "No action"]
2. [next]
```

Verdict guidance:

- `APPROVED`: no critical/high/medium findings remain.
- `REVISE`: at least one critical/high/medium finding needs action.
- `NEEDS_DISCUSSION`: artifact, intent, scope, or evidence is too ambiguous to review honestly.

When running under `plan-reviewer`, translate this into `OKAY` or `REJECT`. When running under `approach-advisor`, do not use approval language; provide a recommendation and risks.
