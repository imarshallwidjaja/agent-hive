---
name: verification
description: Use when selecting checks that are not already settled, interpreting check results, or before claiming work is complete, fixed, passing, or independently verified; requires applicable command/tool evidence, proportional falsification checks, and concise PASS/FAIL/PARTIAL reporting
---

# Verification

## Purpose

Verification is the shared evidence protocol for choosing checks, reading their results, and making completion claims. It is not plan review, code review, or approach advice.

Core principle: evidence before claims, always.

## When To Use

Use this skill when:
- Selecting the checks for a claim when the assignment, plan, or a binding requirement has not already settled them
- Interpreting a check result: what it proves, for which candidate, and whether a failure is the product's or the check's

Use this skill before:
- Claiming work is complete, fixed, passing, or verified
- Committing, merging, creating a PR, or closing a task
- Reporting that acceptance criteria are met
- Confirming a bug fix resolves the reported symptom
- Producing a standalone verification report

Do not use this skill for:
- Plan readiness review; use `plan-reviewer`
- Implementation quality review; use `code-reviewer`
- Strategic approach advice; use `approach-advisor`
- The method for setting up, auditing, or maintaining a project's durable verification guidance or harness when that is the requested work; use `project-verification`, and keep using this skill for that work's proof run and evidence

## Modes

### Completion Gate Mode

Use this mode before your own completion claim. Keep the report compact, but include observed command/tool evidence and identify the candidate and inputs it covers.

### Verification Report Mode

Use this mode when the task is explicitly to independently verify work. Be falsification-first and end with `VERDICT: PASS`, `VERDICT: FAIL`, or `VERDICT: PARTIAL`.

Unless the assignment also grants implementation authority, verifying reports and does not repair: change no candidate source, test, fixture, snapshot, or gate, and commit nothing, even when a check fails. Builds and the scratch or runtime effects the assignment authorizes are not such changes. A failed check is a finding; the role's diagnosis-only boundary governs the rest of the run.

## Iron Laws

- No completion claims without actual command output or tool-result evidence that applies to the candidate being claimed.
- Rationalizations are not evidence.
- Reading code is not verification.
- Worker reports are attributed evidence, not independent verification. A report must include the command/tool result and tested-candidate details; worker prose alone is not evidence.
- A source-backed trace can expose tool output, but it does not attest the tested Git candidate, current integration, or mutable live/artifact inputs and is not a result cache.
- Session recency neither proves nor invalidates evidence. Establish whether the tested candidate and relevant inputs still apply.
- Verify the claim being made, not a nearby claim. Build proves build. Lint proves lint. Tests prove only what they exercise.
- Check the real thing, not a proxy: read the written value, exercise the changed flow, or inspect the delivered artifact. If an observation is suspicious, investigate the observation method while preserving the original failure; do not explain a failed check away.

## Evidence Protocol

For each coherent claim group:

1. Identify the claim.
2. Choose the check that would fail if the claim is false.
3. Observe the actual command output or tool result. Run the check on the current target when required output or applicability is unavailable.
4. Identify the tested candidate and relevant inputs: branch/ref and commit, relevant dirty changes, fixtures, configuration, toolchain, generated artifacts, and live or deployed state as applicable.
5. Compare the observed result with the expected signal and decide whether later changes affect the tested behavior or inputs.
6. Report the command/tool, observed output, candidate, input applicability, and attribution before making the claim.

### Choosing Checks

When the assignment, plan, or a binding repository or operator requirement already names checks adequate for the claim, run those without recataloguing the project's checks. When the choice is open:

- Read the candidate's applicable `AGENTS.md`: the instruction files in the worktree and repository under test that cover the changed paths, which in a composite workspace means each affected repository's own root. It holds concise verification guidance or a scoped pointer to the project's canonical detailed guide; follow the pointer for detail. Hive prescribes no location, filename, heading, or format for either, so do not search the tree for a guide no instruction names. When the pointer names a native skill, load it with the native skill tool, because reading its file does not load it, and confirm the loaded copy is the candidate's; when it is unavailable, report that and keep this skill's baseline without searching generated skill caches for a copy.
- When no such entry exists, select from the repository's existing scripts, CI workflows, and test owners.
- A pointer whose target is missing, unreadable, or does not cover the scope it claims is a guidance defect. Report it. Checks it does not affect may still run, but an overall PASS cannot rest on proof the guide was meant to supply.
- Guidance describes method; it does not add or drop a required gate by itself. Repository, operator, and plan obligations stay binding. When guidance conflicts with one, report the conflict to the obligation's owner and continue only independent work; never defer a gate on a guide's say-so.
- Read and run project guidance, scripts, and dependencies from the candidate's own worktree and repository. A parent's cached skill copy or a canonical sibling checkout is not the candidate, and global or shared instructions are guidance, not candidate source. When a check needs another repository or a gate outside your authority, return the mismatch to whoever assigned the work (the primary, or the operator when you are the primary) instead of running the canonical sibling or deferring the gate.

### Candidate and Input Applicability

- Evidence applies to the candidate and relevant inputs it actually tested. A branch result proves that branch only; it does not prove integrated acceptance.
- Record enough identity to distinguish the tested candidate, including relevant dirty changes and mutable fixture, configuration, toolchain, generated-artifact, or live-state inputs. Do not require exhaustive path manifests or result hashes for every check.
- Reuse evidence while the candidate and relevant inputs remain applicable. A later change may leave a result valid when there is a concrete, brief reason it cannot affect the tested behavior; elapsed time or a new session alone does not invalidate it, and a new commit identity alone neither keeps nor discards it. Component results from a failed aggregate count only with their actual recorded result and established independence of the relevant inputs and state from the failure; an unrun node never counts, and an approved aggregate is one invocation until an authorized amendment changes it.
- A required early, feasibility, or pre-merge gate stays at its approved boundary. Each task-named integrated-only deferral must match a `## Final Verification` obligation with an owner, prerequisite, command, and expected signal. Resolve every such obligation on the integrated candidate before claiming acceptance.
- If ownership or impact cannot be bounded, select a broader coherent existing check and report any missing check. Unknown impact is not an empty green result.
- Required checks that are skipped, unrun, failed, or blocked are not PASS. Optional skips may be reported as skipped.

## Rigor By Risk

| Change type | Minimum useful verification |
|---|---|
| Docs, prompts, metadata | Spot-check changed content and syntax/format if applicable |
| Logic change | Relevant tests plus one edge/error path when practical |
| API, tool, or public interface | Build/typecheck plus tests or consumer-style invocation |
| Bug fix | Reproduce original symptom when practical, then verify fix and regression coverage |
| Refactor with no behavior change | Existing behavior tests unchanged; check public API surface if exposed |
| Performance | Compare baseline and treatment on the same workload and measurement surface; report noise and invalidation assumptions |
| Config or infrastructure | Syntax validation, dry-run, or command that exercises the config |
| Frontend behavior | Start app when practical, inspect rendered state or browser automation, and check console/network if available |
| Data or migration | Verify schema/data shape, empty/boundary inputs, and data preservation where relevant |

Scale up when the change touches persistence, auth, public APIs, deployment, concurrency, payments, or destructive operations. Scale down for typo-only or documentation-only changes.

### End-to-end speedup claims

A claim that a delivery schedule is faster needs evidence for the whole schedule the claim covers (initial validation, correction, integration) on the same workload and measurement surface as the baseline. Label each statement as a measured speedup, an observed elimination (a named costly execution that no longer runs), or a projected benefit from the schedule. A faster focused check supports a claim about that check only. Unknown timing is reported as unknown and is not a failure unless a measured goal requires it. Required coverage, candidate applicability, and aggregate authority are decided as above and by the plan's Verification Planning; a speedup claim never overrides them.

### Measured numbers and eval results

When a measured number or eval result is the evidence for a claim (a speedup, regression, throughput, latency, or eval score), establish what it measured. Do only as much as the claim needs.

- Compare equivalent completed work: both sides did the same task on the same workload and measurement surface. Rule out what else the number could be measuring: errors, skipped or cached work, code that never ran, an untuned side left on default settings, noise, and a changed piece too small to account for the difference.
- A causal claim ("faster because of X") needs an observed mechanism, such as a profile or system counters taken during the run and mapped to source; a reading of the code is a hypothesis. A descriptive delta can be reported with its mechanism labelled unknown.
- State the run count and spread when noise could change the conclusion. For an eval result, check that every trial did the task and whether the gap holds across trials and scenarios.
- A claim that rests on no measured number needs none of this, and routine verification gains no profiling or benchmark stage.

## Adversarial Probes

For non-trivial behavior changes, run at least one probe that tries to break the implementation:
- Boundary input: empty, zero, negative, long string, unicode, max value
- Malformed input or missing required fields
- Idempotency: same request or command twice; interruption and retry from a safely isolated partial run
- Orphan operation: missing or deleted ID
- Concurrency: parallel operations against shared state
- Browser interaction beyond page load
- Consumer import or CLI usage from a fresh context

Do not require adversarial probes for trivial docs, prompt text, or metadata changes.

## Interpreting Results

A correctly working check can find a real product failure. Report separately whether the check is valid (it ran on the intended candidate and inputs and could fail), the product result it observed, the scope it covered, and whether the next agent can find and run it. A product failure does not make the check invalid, and a pass says nothing about scope the check did not cover.

Proof strength follows the method:
- A sampled property or generated-input check supports claims about the inputs it sampled.
- An exhaustive bounded model check supports claims inside its stated model and bounds.
- A proof linked to the source supports claims under its stated assumptions.

State the assumptions, bounds, and how the model or proof corresponds to the code. A detached model with an audited mapping to the code can support design analysis, but it cannot show that the check detects a change to the actual code. A negative control demonstrates detection only on the surface it actually broke: breaking the model shows the model check can fail, and a claim that the check catches a code defect needs an observed connection from the real source to the check, such as a mutated source file that the check reads and rejects.

## Failure Handling

If a check fails:
1. Quote the relevant output.
2. State expected vs actual.
3. Mark the result FAIL.
4. Do not explain it away unless repository docs or code prove the behavior is intentional.

Use PARTIAL only for environmental or tool limitations, such as unavailable services, missing credentials, or a server that cannot start for reasons outside the change. Do not use PARTIAL for uncertainty when a check ran.

When output is missing or candidate applicability cannot be established, report UNVERIFIED or BLOCKED, never PASS. After a correction, preserve the original failure, verify the owning regression, and rerun affected consumer and integrated gates; unaffected results stay under the reuse rule above. An unexplained green retry does not resolve an intermittent failure.

## Output Formats

### Completion Gate Mode

```markdown
## Verification Evidence

**Claim**: [claim]
**Command/tool run**: [exact command or tool]
**Output observed**: [relevant output excerpt]
**Candidate and inputs**: [tested ref/commit, relevant dirty changes and mutable inputs, and why evidence still applies]
**Attribution**: [direct observation or attributed worker result]
**Result**: PASS / FAIL / PARTIAL / UNVERIFIED / BLOCKED
```

### Verification Report Mode

Every PASS requires actual command/tool output and tested-candidate applicability. Worker prose alone cannot support a PASS.

```markdown
### Check: [what was verified]
**Command/tool run:**
[exact command or tool]

**Output observed:**
[relevant output excerpt]

**Candidate and inputs:**
[tested ref/commit, relevant dirty changes and mutable inputs, and why evidence still applies]

**Attribution:**
[direct observation or attributed worker result]

**Result:** PASS / FAIL / PARTIAL / UNVERIFIED / BLOCKED

VERDICT: PASS
```

End standalone reports with exactly one verdict line:
- `VERDICT: PASS`
- `VERDICT: FAIL`
- `VERDICT: PARTIAL`

The terminal verdict considers every required claim group. Any required `FAIL` makes the verdict `FAIL`. `PASS` requires an identified required-check set, a `PASS` result for every required group, and no missing required proof; an empty or incomplete set is missing proof. A required `PARTIAL`, `UNVERIFIED`, or `BLOCKED` result, or any other missing required proof, prevents `PASS`: use `PARTIAL` only when an environmental or tool limitation is the sole reason required proof is missing; otherwise use `FAIL`. A final `FAIL` means required acceptance failed or remains unproven; it does not imply that an executed command exited unsuccessfully. Report command failures separately from acceptance status.

## Anti-Rationalization Checklist

Stop and run evidence when you are about to write:
- "should work"
- "looks correct"
- "probably passes"
- "the agent said it passed"
- "the code path is obvious"
- "similar tests passed"
- "this is too small to test"

Once applicable required evidence and reviews are sufficient, stop; rerun only for an identified gap, invalidation, or new risk.
