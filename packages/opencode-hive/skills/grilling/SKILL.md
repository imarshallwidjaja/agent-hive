---
name: grilling
description: Use when an operator wants systematic questions, researched facts, and explicit alignment on supplied context before proceeding.
---

# Grilling

Reach shared understanding through one decision at a time and evidence where evidence is available. This interaction is conversation-scoped; do not persist state or create resume infrastructure.

## Continuous Loop

One invocation is one continuing loop: ask, take in the answer, investigate and falsify, recompute the frontier, then ask again. A question and its answer are steps inside the loop, not the end of your work.

- When the `question` tool is exposed, ask every operator question through it. Its answer returns inside the same invocation, so carry on with the next research step, check, or question in the same turn.
- When the `question` tool is not exposed, ask one plain chat question. That reply unavoidably ends the turn; when the operator answers, resume the same loop where it stopped. Never claim a tool call, answer, or check result that did not happen.
- Only an operator answer settles a question. When an exposed `question` call returns no answer (rejected, cancelled, dismissed, or errored), keep that item unresolved and alignment unconfirmed. Treat an explicit operator cancellation, pause, or stop as a stop. For a transport failure or rejection, disclose it and yield with the open question in chat; do not supply an answer, retry a call already known to fail, or work around the denied interaction.
- A progress update, a status summary, or an offer to continue is a step inside the loop; follow it with the next question, check, or the alignment brief.

## Interaction Engine

- Maintain an internal dependency-aware frontier of unresolved material items. Do not expose the tree.
- Classify items as operator decisions, operator preferences, assumptions, or discoverable facts. Keep decisions and preferences distinct.
- Ask exactly one material operator question at a time. Ask the highest-impact currently answerable question, explain tradeoffs, and recommend an option when useful.
- Research discoverable facts instead of asking the operator. Label assumptions rather than presenting them as facts.
- After every answer or evidence result, recompute the frontier. Accept revised answers, surface contradictions without silently choosing one, and record skipped items as unresolved unless they become immaterial.
- Falsify before settling. Test each material factual claim or assumption, including those inside operator answers, with a proportional check that could disprove it: read the source, run a read-only check, or look for a discriminating counterexample. Stay read-only unless the invocation already authorizes more. Resolve a discoverable fact before asking a question that depends on it. Accepting an operator preference settles the preference, not the facts it assumes.
- Show compact progress without exposing the frontier: summarize settled operator items and unresolved material items, and give counts for facts marked `validated`, `pending`, `failed`, or `assumed`.

## Research Policy

Choose direct retrieval, one agent, or multiple agents based only on bounded material evidence needs and dependencies. No minimum, maximum, fixed research timing, or forced delegation applies.

When background research is available, continue asking independent operator decisions and running independent checks while useful evidence runs. Wait only when no independent material work remains and every remaining material decision depends on pending evidence. At that point a required native completion may suspend the invocation; wait for its notification instead of polling or launching a duplicate lane, and resume the same loop when it arrives. When background research is unavailable, use direct or blocking research; never turn a discoverable fact into an operator question merely because delegation is unavailable.

If research is unavailable or fails, disclose the gap and keep the fact unresolved, or carry it as an explicit assumption when progress requires one. Never guess.

## Coverage And Finish

No fixed question cap applies. Move to the alignment brief when no unresolved item could materially change shared understanding. If the operator says `wrap up`, stop expanding the frontier, state unresolved or skipped material items, and prepare alignment from current evidence. If the operator pauses or stops, stop asking, state settled and unresolved material items, and leave alignment unconfirmed.

Finish with a compact alignment brief covering:

- topic and interpretation
- operator decisions
- operator preferences
- established facts with provenance and status
- assumptions
- constraints and scope
- disagreements or contradictions
- open questions

Then require an explicit three-way alignment confirmation, asked through the same question transport as the loop:

1. Aligned: the brief is accurate.
2. Aligned with named corrections: apply them, check any factual claims they introduce, ask any question they make material, then restate the corrected brief and ask for confirmation again.
3. Not aligned: return to the loop with the single most material unresolved question, and confirm again once it settles.

## Separate Action Boundary

Confirmed alignment ends the interaction. Planning, implementation, or any other follow-on work requires a separate operator request. Keep the confirmed brief in the conversation unless the invocation or operator names a destination. A named destination authorizes writing only the confirmed alignment brief there; it does not authorize planning, implementation, Hive-state mutation, or another workflow.
