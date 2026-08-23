---
name: grilling
description: Use when an operator wants systematic questions, researched facts, and explicit alignment on supplied context before proceeding.
---

# Grilling

Reach shared understanding through one decision at a time and evidence where evidence is available. This interaction is conversation-scoped; do not persist state or create resume infrastructure.

## Interaction Engine

- Maintain an internal dependency-aware frontier of unresolved material items. Do not expose the tree.
- Classify items as operator decisions, operator preferences, assumptions, or discoverable facts. Keep decisions and preferences distinct.
- Ask exactly one material operator question per turn. Ask the highest-impact currently answerable question, explain tradeoffs, and recommend an option when useful.
- Research discoverable facts instead of asking the operator. Label assumptions rather than presenting them as facts.
- After every answer or evidence result, recompute the frontier. Accept revised answers, surface contradictions without silently choosing one, and record skipped items as unresolved unless they become immaterial.
- Show compact progress without exposing the frontier: summarize settled operator items and unresolved material items, and give counts for facts marked `validated`, `pending`, `failed`, or `assumed`.

## Research Policy

Choose direct retrieval, one agent, or multiple agents based only on bounded material evidence needs and dependencies. No minimum, maximum, fixed research timing, or forced delegation applies.

When background research is available, continue asking independent operator decisions while useful evidence runs. Wait only when every remaining material decision depends on pending evidence. When background research is unavailable, use direct or blocking research; never turn a discoverable fact into an operator question merely because delegation is unavailable.

If research is unavailable or fails, disclose the gap and keep the fact unresolved, or carry it as an explicit assumption when progress requires one. Never guess.

## Coverage And Finish

No fixed question cap applies. Stop when no unresolved item could materially change shared understanding. If the operator says `wrap up`, stop expanding the frontier, state unresolved or skipped material items, and prepare alignment from current evidence.

Finish with a compact alignment brief covering:

- topic and interpretation
- operator decisions
- operator preferences
- established facts with provenance and status
- assumptions
- constraints and scope
- disagreements or contradictions
- open questions

Then require an explicit three-way alignment confirmation:

1. Aligned: the brief is accurate.
2. Aligned with named corrections: apply them and restate the corrected brief.
3. Not aligned: continue with the single most material unresolved question.

## Separate Action Boundary

Confirmed alignment ends the interaction. Planning, implementation, or any other follow-on work requires a separate operator request. Keep the confirmed brief in the conversation unless the invocation or operator names a destination. A named destination authorizes writing only the confirmed alignment brief there; it does not authorize planning, implementation, Hive-state mutation, or another workflow.
