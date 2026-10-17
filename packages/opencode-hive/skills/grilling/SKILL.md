---
name: grilling
description: Use when an operator wants systematic questions, researched facts, and explicit shared understanding of supplied context or an idea before proceeding.
---

# Grilling

Bring the operator and yourself to the same understanding: they understand what the evidence shows, and you understand what they decided and why. Work one decision at a time, from evidence where evidence is available. This interaction is conversation-scoped; do not persist state or create resume infrastructure.

The dialogue runs in this order: orient and research, explain, ask one material question, investigate and falsify the answer, incorporate corrections. Repeat the questions and checks until no unresolved item could materially change shared understanding, then end the whole dialogue with an explicit three-way confirmation. The invoking command sets the endpoint; this skill owns the method.

## Continuous Loop

One invocation is one continuing loop: ask, take in the answer, investigate and falsify, recompute the frontier, then ask again. A question and its answer are steps inside the loop, not the end of your work.

- When the `question` tool is exposed, ask every operator question through it. Its answer returns inside the same invocation, so carry on with the next research step, check, or question in the same turn.
- When the `question` tool is not exposed, ask one plain chat question. That reply unavoidably ends the turn; when the operator answers, resume the same loop where it stopped. Never claim a tool call, answer, or check result that did not happen.
- Only an operator answer settles a question. When an exposed `question` call returns no answer (rejected, cancelled, dismissed, or errored), keep that item unresolved and alignment unconfirmed. Treat an explicit operator cancellation, pause, or stop as a stop. For a transport failure or rejection, disclose it and yield with the open question in chat; do not supply an answer, retry a call already known to fail, or work around the denied interaction.
- A progress update, a status summary, or an offer to continue is a step inside the loop; follow it with the next question, check, or the alignment brief.

## Orient And Explain

- Get your bearings before the first question. Read what the conversation, the supplied context, and the repository or project context already say, and research discoverable facts. A decision the operator already made there is settled: carry it into the brief and do not ask it again unless new evidence contradicts it.
- Explain what you found in plain spoken sentences: what the thing is, how it works, and why it is that way where the evidence shows why. Give the smallest complete account first, then go deeper where the operator's question sits or when they ask. Skip what they plainly already know.
- Keep the evidence's confidence. Say what a source establishes, what it only suggests, and what you could not find, especially for history and rationale. Never promote an inferred reason to a stated fact.
- Explain the way you would to a colleague: no quizzes, no asking them to repeat it back, no lecture. After explaining, ask the next question and let them respond.

## Interaction Engine

- Maintain an internal dependency-aware frontier of unresolved material items. Do not expose the tree.
- Classify items as operator decisions, operator preferences, assumptions, or discoverable facts. Keep decisions and preferences distinct.
- Ask exactly one material operator question at a time. Ask the highest-impact currently answerable question.
- Give every option you present a short pro, a short con, and your recommendation with its reason. Name a real cost; when an option has none worth naming, say so instead of inventing one.
- A recommendation does not settle a decision. However confident you are, a material choice the operator has not made stays on the frontier: ask it with your recommendation attached, and never fold it into the brief as an assumption.
- Research discoverable facts instead of asking the operator. Label assumptions rather than presenting them as facts.
- After every answer or evidence result, recompute the frontier. Accept revised answers, surface contradictions without silently choosing one, and record skipped items as unresolved unless they become immaterial.
- When the operator corrects your explanation, a fact, or a recommendation, accept it, check its factual claims as below, say what changed in your account, and drop any question it made moot.
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
- operator decisions, each with its reason when the operator or the evidence gave one
- operator preferences
- established facts with provenance and status
- assumptions
- constraints and scope
- disagreements or contradictions
- open questions

The invoking command may name further content its endpoint needs.

Then require an explicit three-way alignment confirmation, asked through the same question transport as the loop. Give each outcome its cost and benefit, and recommend Aligned only when no material item is open; otherwise recommend the outcome that closes the gap:

1. Aligned: the brief is accurate. It ends the interaction at once; any error left in the brief carries forward.
2. Aligned with named corrections: apply them, check any factual claims they introduce, ask any question they make material, then restate the corrected brief and ask for confirmation again. It costs another round and keeps the brief accurate.
3. Not aligned: return to the loop with the single most material unresolved question, and confirm again once it settles. It costs the most time and is right when a material item is wrong or missing.

## Separate Action Boundary

Confirmed alignment ends the interaction. A bare confirmation is understanding only: planning, implementation, or any other follow-on work requires a separate operator request. Grilling itself creates no Hive feature, plan, or other Hive state.

An explicit instruction given upfront to continue after alignment, such as "then create a plan after alignment", is that request in advance. It authorizes the one next stage it names, only once alignment is confirmed, and you do not ask for authorization a second time. That stage runs under the active role's existing planning, approval, and tool boundaries; the instruction never implies approval, task sync, or execution.

Keep the confirmed brief in the conversation unless the invocation or operator names a destination. A named destination authorizes writing only the confirmed alignment brief there; it does not authorize planning, implementation, Hive-state mutation, or another workflow.
