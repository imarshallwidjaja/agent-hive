---
name: writing-policy
description: Use when producing human-facing prose or delegating prose work, including docs, plans, reports, reviews, explanations, PR or commit text, and handoffs that will write for a reader.
---

# Writing policy

This skill owns prose routing and delegated propagation. It does not replace the depth skills or the host's output contract.

## Baseline

Apply a small baseline to every human-facing output, including short replies: write for the reader, keep names stable, do not invent facts, and run a silent draft-audit-fix loop before delivery. Do not announce the policy.

## Route

Load depth skills only when the case matches:

- Substantial docs, plans, reports, reviews, or explanations: `writing-for-humans`.
- Cadence or structure rewrite problems: `writing-for-humans` plus `stop-slop`.
- Vocabulary, register, attribution, formatting, or chat-artifact rewrite problems: `writing-for-humans` plus `humanizer`.
- A broadly slop-heavy rewrite: `writing-for-humans` plus both overlays.
- A personal voice overlay: load only the skill named by applicable instructions or the operator. Availability alone does not select a personal voice.
- Agent-consumed instructions: `writing-for-agents` owns instructional structure and invocation. Human-facing explanations about those instructions still use this policy. Preserve source wording, examples, and exceptions when importing instructions; prose cleanup is not permission to weaken their force.
- PR titles, descriptions, and review comments: `pr-writing` owns the artifact-specific requirements and publication boundary. This policy owns the prose routing.

Domain-specific writing skills stay conditional on their own triggers. Exact quotations, code, public strings, required schemas, and meaning-bearing confidence labels are not style-cleanup targets.

## Delegation

Parent-loaded skills do not imply child loading. When delegation is permitted, a prose handoff names the artifact, audience, voice when specified, and required writing skills. Require the child to load those skills itself. A fresh follow-up receives the same writing contract. Where nested delegation is permitted, descendants preserve that contract rather than assuming the parent's loaded set. This rule does not authorize delegation or extend a child's role.

The four packaged writing skills have one ownership chain: this policy selects; `writing-for-humans` guides drafting and the finish pass; `stop-slop` repairs cadence and structure; `humanizer` repairs vocabulary, register, attribution, and formatting. Neither overlay creates another writing policy.
