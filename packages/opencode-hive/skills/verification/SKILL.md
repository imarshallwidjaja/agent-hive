---
name: verification
description: Use before claiming work is complete, fixed, passing, or independently verified; requires fresh command/tool evidence, proportional falsification checks, and concise PASS/FAIL/PARTIAL reporting
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

Use this mode before your own completion claim. Keep the report compact, but include fresh evidence from this session.

### Verification Report Mode

Use this mode when the task is explicitly to independently verify work. Be falsification-first and end with `VERDICT: PASS`, `VERDICT: FAIL`, or `VERDICT: PARTIAL`.

## Iron Laws

- No completion claims without fresh command/tool evidence.
- Rationalizations are not evidence.
- Reading code is not verification.
- Agent reports, stale logs, similar checks, and confidence are not evidence.
- Verify the claim being made, not a nearby claim. Build proves build. Lint proves lint. Tests prove only what they exercise.

## Evidence Protocol

For each coherent claim group:

1. Identify the claim.
2. Choose the check that would fail if the claim is false.
3. Run the command or observable tool check fresh.
4. Read the output, exit code, status, screenshot, or tool result.
5. Compare expected vs actual.
6. Report the command/tool and relevant output before making the claim.

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

## Output Formats

### Completion Gate Mode

```markdown
## Verification Evidence

**Claim**: [claim]
**Command/tool run**: [exact command or tool]
**Output observed**: [relevant output excerpt]
**Result**: PASS / FAIL / PARTIAL
```

### Verification Report Mode

Every PASS requires command/tool evidence.

```markdown
### Check: [what was verified]
**Command/tool run:**
[exact command or tool]

**Output observed:**
[relevant output excerpt]

**Result:** PASS / FAIL / PARTIAL

VERDICT: PASS
```

End standalone reports with exactly one verdict line:
- `VERDICT: PASS`
- `VERDICT: FAIL`
- `VERDICT: PARTIAL`

## Anti-Rationalization Checklist

Stop and run evidence when you are about to write:
- "should work"
- "looks correct"
- "probably passes"
- "the agent said it passed"
- "the code path is obvious"
- "similar tests passed"
- "this is too small to test"

No shortcuts. Run the command or tool check, read the output, then state the result.
