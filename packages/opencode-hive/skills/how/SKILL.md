---
name: how
description: Use when the operator asks for a source-grounded walkthrough of current code, runtime flow, data movement, or existing subsystem ownership. Not for choosing a future design, diagnosing a failure, or routine orientation during implementation.
---

# How

Explain a subsystem at the depth of a senior engineer onboarding a colleague: enough to work in it confidently, without producing annotated source code.

## Ground the explanation

Identify the actual question and current checkout or artifact. Read [exploration](references/exploration.md) before gathering evidence and [explanation](references/explanation.md) before synthesizing it. A narrow question may need one direct trace. Use `parallel-exploration` only when independent bounded evidence slices justify delegation; no fixed explorer count or dedicated explainer agent is required.

When delegation is permitted, Scouts gather facts within their assigned slice and the primary owns the explanation. Give them source paths, the question, the slice, and the exploration reference. A terminal worker does its own authorized reading and returns evidence without spawning another layer.

Don't guess from names. Read the code. Preserve contradictions until the decisive source resolves them; show an unresolved connection as a gap.

## Boundaries

- "Where does this live now?" is observable ownership. "Where should this live?" is a design decision for the existing approach-advisor path.
- A failing behavior belongs to `systematic-debugging`; a current-flow explanation does not become a fix.
- Historical motivation belongs to `why` when explicitly requested or assigned. Do not infer author intent from mechanics or automatically launch a history sweep.
- Return an explanation without editing code or persisting research as standing instructions.

Use `writing-policy` for presentation. For a teaching request, infer the needed concepts from the conversation rather than quizzing the user. Give the smallest complete account that answers the request, then add depth when asked. A request for a thorough one-shot explanation still deserves the complete answer. No pacing theater, mandatory diagrams, or stock invitations.
