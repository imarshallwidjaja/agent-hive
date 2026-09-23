---
name: verification
description: Use before claiming work is complete, fixed, passing, or independently verified; requires applicable command/tool evidence, proportional falsification checks, and concise PASS/FAIL/PARTIAL reporting
---

# Verification

## Purpose

Verification is the shared evidence protocol for completion claims. It is not plan review, code review, or approach advice.

Core principle: evidence before claims, always.

## When To Use

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

## Modes

### Completion Gate Mode

Use this mode before your own completion claim. Keep the report compact, but include observed command/tool evidence and identify the candidate and inputs it covers.

### Verification Report Mode

Use this mode when the task is explicitly to independently verify work. Be falsification-first and end with `VERDICT: PASS`, `VERDICT: FAIL`, or `VERDICT: PARTIAL`.

## Iron Laws

- No completion claims without actual command output or tool-result evidence that applies to the candidate being claimed.
- Rationalizations are not evidence.
- Reading code is not verification.
- Worker reports are attributed evidence, not independent verification. A report must include the command/tool result and tested-candidate details; worker prose alone is not evidence.
- A source-backed trace can expose tool output, but it does not attest the tested Git candidate, current integration, or mutable live/artifact inputs and is not a result cache.
- Session recency neither proves nor invalidates evidence. Establish whether the tested candidate and relevant inputs still apply.
- Verify the claim being made, not a nearby claim. Build proves build. Lint proves lint. Tests prove only what they exercise.

## Evidence Protocol

For each coherent claim group:

1. Identify the claim.
2. Choose the check that would fail if the claim is false.
3. Observe the actual command output or tool result. Run the check on the current target when required output or applicability is unavailable.
4. Identify the tested candidate and relevant inputs: branch/ref and commit, relevant dirty changes, fixtures, configuration, toolchain, generated artifacts, and live or deployed state as applicable.
5. Compare the observed result with the expected signal and decide whether later changes affect the tested behavior or inputs.
6. Report the command/tool, observed output, candidate, input applicability, and attribution before making the claim.

### Candidate and Input Applicability

- Evidence applies to the candidate and relevant inputs it actually tested. A branch result proves that branch only; it does not prove integrated acceptance.
- Record enough identity to distinguish the tested candidate, including relevant dirty changes and mutable fixture, configuration, toolchain, generated-artifact, or live-state inputs. Do not require exhaustive path manifests or result hashes for every check.
- Reuse evidence while the candidate and relevant inputs remain applicable. A later change may leave a result valid when there is a concrete, brief reason it cannot affect the tested behavior; elapsed time or a new session alone does not invalidate it.
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
| Config or infrastructure | Syntax validation, dry-run, or command that exercises the config |
| Frontend behavior | Start app when practical, inspect rendered state or browser automation, and check console/network if available |
| Data or migration | Verify schema/data shape, empty/boundary inputs, and data preservation where relevant |

Scale up when the change touches persistence, auth, public APIs, deployment, concurrency, payments, or destructive operations. Scale down for typo-only or documentation-only changes.

## Adversarial Probes

For non-trivial behavior changes, run at least one probe that tries to break the implementation:
- Boundary input: empty, zero, negative, long string, unicode, max value
- Malformed input or missing required fields
- Idempotency: same request or command twice
- Orphan operation: missing or deleted ID
- Concurrency: parallel operations against shared state
- Browser interaction beyond page load
- Consumer import or CLI usage from a fresh context

Do not require adversarial probes for trivial docs, prompt text, or metadata changes.

## Failure Handling

If a check fails:
1. Quote the relevant output.
2. State expected vs actual.
3. Mark the result FAIL.
4. Do not explain it away unless repository docs or code prove the behavior is intentional.

Use PARTIAL only for environmental or tool limitations, such as unavailable services, missing credentials, or a server that cannot start for reasons outside the change. Do not use PARTIAL for uncertainty when a check ran.

When output is missing or candidate applicability cannot be established, report UNVERIFIED or BLOCKED, never PASS. After a correction, preserve the original failure, verify the owning regression, and rerun affected consumer and integrated gates. Retain unaffected results only with a short, defensible non-impact reason. An unexplained green retry does not resolve an intermittent failure. Report required skips and unrun checks honestly; do not claim acceptance while a required result is missing.

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

When output is missing, applicability is uncertain, or a required input changed, run the required check on the current target or report the claim as unverified/blocked. Once applicable required evidence and reviews are sufficient, stop; rerun only for an identified gap, invalidation, or new risk.
