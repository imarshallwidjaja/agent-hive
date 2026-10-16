---
name: adversarial-review
description: Use when explicitly asked for adversarial, hostile, red-team, stress-test, multi-pass, or cross-model review of a plan, approach, code diff, code-vs-plan implementation, or simplicity pass.
---

# Adversarial Review

Adversarial review is a read-only posture that sharpens how a reviewer looks for the ways its artifact could fail. It works inside the method, finding bar, output contract, and tool boundaries the reviewing role already has. A clean in-scope result is a valid outcome.

Core rule: the host agent contract still wins. `plan-reviewer`, `code-reviewer`, `approach-advisor`, `simplicity-reviewer`, and reviewers derived from them keep their own method, verdict labels, and finding bar. Code and simplicity reviewers keep the shared Review Investigation steps; plan review and approach advice keep their own methods and do not adopt those steps. This posture adds no authority, verdict, reviewer, roster, finding quota, or required sequence of passes.

## Reference Basis

This flat skill began as a distillation of these adversarial review patterns, without importing reference subfiles:

- `neverinfamous/memory-journal-mcp` adversarial suite: a baseline pass followed by an adversary pass, consolidated reporting, and domain lenses for planning, skills, workflows, security, and performance.
- `dementev-dev/adversarial-review`: scope detection for plan, code, code-vs-plan, and file review, bounded revise loops, severity-based findings, mutation detection, and failure reporting for invalid reviewer artifacts.
- `poteto/noodle` adversarial-review: scope and intent declaration, reviewer lenses such as Skeptic/Architect/Minimalist, synthesized verdicts, read-only review, and reporting missing or empty external reviewer output.

It keeps the falsification posture, mutation detection, and honest reporting of missing or empty review inputs. It does not keep their mode detection, lens panels, or fixed baseline-then-attack sequence; `UPSTREAM.md` records that adaptation.

## When To Use

Use this skill only when the operator or caller explicitly asks for adversarial review, stress testing, red-team review, hostile review, multi-pass review, cross-model review, or similar wording.

Do not use it for ordinary plan review, code review, simplicity review, or approach advice. Adversarial scrutiny searches harder within the host review's finding bar; it does not lower that bar.

## Posture

- Stay read-only. Do not edit files, update plans, commit, merge, or repair issues while acting as the adversarial reviewer.
- Review whether the artifact achieves the intent its author stated, not whether you prefer a different goal.
- Challenge the assumptions whose failure would change the decision. For each, look for both sides: a counterexample that breaks the assumption, and a guard, contract, or test that already defeats the concern. A concern the artifact's own guard defeats is cleared, and the clearing evidence goes into the role's Coverage entry.
- Spend the extra attention where a failure costs most: public contracts, persistence, trust boundaries, concurrency, migration, hot paths, and complexity with no current requirement. Include unchanged in-scope code when late evidence implicates it.
- Try to falsify the claims the artifact depends on. A failed attempt to find a defect is a legitimate clean result; do not invent findings, praise, or extra structure to look thorough.
- Findings need evidence relevant to the host's decision, such as a discriminating test, an authoritative contract, or a clear source execution path. A plausible failure path alone is a lead, not a mandatory fix.
- Keep severity separate from certainty, and use the role's own severity terms.

## What the Role's Report Keeps

The posture changes where you look. The report keeps whatever format the role requires: its assessment label, the Review Basis and Coverage entries, and for every finding the file:line anchor, the decisive quoted line, the reachable consequence, and what you did to disprove it. Material leads you rejected keep their clearing evidence in Coverage. Host output format wins: if a role requires `OKAY/REJECT`, `APPROVE/REQUEST_CHANGES`, or advisory output, put the adversarial detail inside the sections it allows. No structured output is added for the adversarial pass.

## Illustration

Fictional diff for review against a stated requirement. A change adds `readTimeout(settings)` returning `settings.network.timeoutMs`, and the requirement says a settings file may omit the `network` section.

- Source supports a defect: the only caller passes the parsed file straight through, an omitted section is valid, and the quoted line `return settings.network.timeoutMs;` dereferences `undefined`. The finding rests on that path and the requirement. It is a source-based finding; it does not show that anything ran or that a test fails.
- Guarded control: every caller reaches `readTimeout` through a loader that fills defaults, and a test pins that. The same concern is cleared, with the loader and the test named in Coverage. The code reviewer's assessment is APPROVE with No action. A simplicity reviewer finds nothing to remove (ALREADY_MINIMAL), and an extra internal check in `readTimeout` would duplicate the loader's guarantee.

## Review Inputs

- Report missing, empty, stale, or invalid review inputs (artifact, plan or task reference, diff, supplied command output, external reviewer output). Do not silently skip a reviewer, file, plan, diff, or external validation result.
- If any review step mutates the artifact under review, stop and report the mutation. Continuing would review a moving target.
- For git-backed code reviews, `git --no-optional-locks status --short` and `git diff --name-only` confirm what is under review. Do not run broad commands when the caller already provided bounded evidence.

## External Validation

External or cross-model validation is useful but not required by this posture. A reviewer, companion pass, or external review that the operator, the role, or the configuration requires remains required; this posture neither adds it nor drops it. Attempt additional validation only when the environment provides a safe read-only path and the caller requested or approved it.

If external validation is attempted:

- Name the external mechanism or reviewer model.
- Confirm the output exists and is non-empty before using it.
- Report missing, failed, timed out, or empty output as a validation failure.
- Treat external output as another evidence source, not automatic truth.
- Do not let external tools mutate the artifact under review.

If it is not available or not safe, say it was skipped and continue.

## Where Scrutiny Goes By Artifact

These are places to aim within the role's method, not modes to select.

- **Plan**: hidden blockers, missing references, contradictory dependencies, non-executable verification, and assumptions that affect scope or correctness. `REJECT` still means a capable worker would likely be blocked or seriously misdirected.
- **Code**: changed behavior, public contracts, error paths, tests, and regression risk. `REQUEST_CHANGES` still needs a supported material failure or applicable quality-requirement violation.
- **Code against a plan or task**: omissions, behavior the plan did not ask for, unverified acceptance criteria, and code that satisfies a nearby requirement but not the actual one.
- **Approach**: whether the path survives the constraints, which assumption needs evidence, and what would trigger a different route. Advice stays advisory.
- **Simplicity**: abstractions, option bags, fallback branches, adapters, compatibility paths, and duplicated checks with no current requirement. Report only worthwhile in-scope simplifications that preserve approved behavior; `MINOR_TWEAKS` remains optional.

## Consolidation

Deduplicate by root cause and keep the clearest evidence. Drop concerns that are merely stylistic, unsupported, or outside the host review's scope.

Read [impact and finding judgment](references/impact-and-findings.md) for a shared-contract safety assumption or a noisy finding set. Other ordinary reviewers may read this reference without adopting this posture. The reference does not expand scope, permissions, or the host's finding bar.

## When No Role Format Exists

When an operator asks a primary or general agent for an adversarial review and no reviewer role frames the output, report in this form:

```markdown
**Scope**: [what was reviewed]
**Intent**: [what the author is trying to achieve]
**Artifacts Reviewed**: [files, diff, plan/task refs, commands, external reviewer outputs]
**Validation Notes**: [missing/failed/skipped external validation, mutation checks, stale evidence]

**Adversarial Verdict**: [APPROVED / REVISE / NEEDS_DISCUSSION]

**Bottom Line**: [2-3 sentences]

### Findings
- None | [severity: critical/high/medium/low] [artifact:line] - [issue]
  - What can go wrong: [failure mode]
  - Why vulnerable: [evidence]
  - Impact: [effect]
  - Recommendation: [specific fix direction]

### Coverage
[leads cleared with the clearing evidence; areas not inspected]

### Action Path
[No action | supported actions needed to resolve the review]
```

- `APPROVED`: no supported material blocker remains; optional suggestions may remain.
- `REVISE`: a supported material failure or applicable requirement violation needs action under the host's bar, regardless of severity label.
- `NEEDS_DISCUSSION`: a material artifact, intent, scope, or evidence question prevents a sound decision; name what resolves it. If no artifact is available, return `NEEDS_DISCUSSION` instead of inventing one.

Severity: Critical breaks correctness, data integrity, security, a public contract, or the stated task. High is a likely defect, a serious missing requirement, an unsafe sequence, or a major verification gap. Medium is a consequential supported edge case, maintainability problem, or important unproven behavior. Low is a small cleanup or clarity issue; include it only if the format has room.

Under a host reviewer, use only its output contract and verdict labels: `plan-reviewer` keeps `OKAY/REJECT`, `code-reviewer` keeps `APPROVE/REQUEST_CHANGES/NEEDS_DISCUSSION`, `simplicity-reviewer` keeps `SIMPLIFY/MINOR_TWEAKS/ALREADY_MINIMAL/NEEDS_DISCUSSION`, and `approach-advisor` gives advice without an approval verdict. The template above applies only when no host format exists.
