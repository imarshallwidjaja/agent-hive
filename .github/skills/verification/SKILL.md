---
name: verification
description: Use before claiming work is complete, fixed, passing, or independently verified; requires fresh command/tool evidence and concise PASS/FAIL/PARTIAL reporting
---

# Verification

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

## Evidence Protocol

For each coherent claim group:

1. Identify the claim.
2. Choose the check that would fail if the claim is false.
3. Run the command or observable tool check fresh.
4. Read the output, exit code, status, screenshot, or tool result.
5. Compare expected vs actual.
6. Report the command/tool and relevant output before making the claim.

## Output

```markdown
## Verification Evidence

**Claim**: [claim]
**Command/tool run**: [exact command or tool]
**Output observed**: [relevant output excerpt]
**Result**: PASS / FAIL / PARTIAL
```

For standalone verification reports, end with exactly one verdict line:
- `VERDICT: PASS`
- `VERDICT: FAIL`
- `VERDICT: PARTIAL`
