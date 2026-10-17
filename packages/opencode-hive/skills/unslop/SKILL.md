---
name: unslop
description: Use when producing, reviewing, repairing, or handing off anything a person will read or look at, including replies, docs, plans, reports, PR text, product or UI copy, interfaces, mockups, and prose delegated to another agent.
---

# Unslop

Slop is output that statistical habit shaped instead of this reader, this artifact, and this product. Unslop works from the other end: name who will read or use the thing and what they need from it, then give every sentence, label, and visual choice a purpose you can state. A choice with no purpose gets replaced by something specific, or removed.

This skill is the shared philosophy and the router. It applies to writing, to reviewing and cleaning up existing material, and to handoffs, in every role. It changes no role's authority, finding bar, verdict, or required output format. A read-only reviewer names the defect and the direction of the repair; the role that owns the artifact rewrites it.

## Baseline

Apply to every human-facing output, short replies included, without announcing it:

- **Reader first.** Put the answer or the decision first, in the words this reader would use. A short reply stays short and needs nothing further loaded.
- **Concrete nouns.** Name the real symbol, file, flag, command, number, or person, not a synonym, a description, or a metaphor for it. Give each thing one name and keep it.
- **One reading.** Each "it", "this", "they", and "which" points at one obvious noun; repeat the noun when in doubt. Place "only" and "not" beside the word they change. Keep the verb and the small words that show a sentence's structure.
- **Enough words.** Compression that makes the reader rebuild the sentence moves the work to them. Shorter is clearer only when nothing the reader needs was cut.
- **Only what the sources hold.** Every fact, name, number, date, quote, source, and outcome comes from the sources or the conversation.
- **The source's judgment.** Carry taste, scope, caveats, claims, actors, and voice through unchanged unless asked to change them: a sharp opinion stays sharp, a hedge keeps its strength, the actor stays the actor, and an instruction, requirement, or warning keeps its force, exceptions included.
- **Draft, audit, fix.** Before delivering, read the draft as the reader would and ask what a careful editor would mark. Fix it, then check again.

Exact quotations, code, public strings, required schemas, titles, and meaning-bearing confidence labels are not style targets.

Product copy, announcements, and interface labels meet the same test: concrete product nouns, the action, and the outcome. A visual choice meets it too, through hierarchy, grouping, state, identity, or access.

## Route

Routing is a load obligation. When a row matches, load the skills it names with the native skill tool before drafting or repair, plus any those skills name for themselves. Load only the rows the case matches; none applies to every turn.

| Case | Load |
|---|---|
| Substantial docs, plans, reports, reviews, explanations, or a prose handoff | `writing-for-humans` |
| Cadence or structure problems: antithesis, stacked negation, fragment runs, quotable closers, uniform rhythm | `writing-for-humans` and `stop-slop` |
| Rewriting existing prose to remove AI tone (vocabulary, register, attribution, formatting, chat artifacts), or composing from a writer's notes, transcript, or interview answers | `writing-for-humans` and `humanizer`; a full rewrite adds `stop-slop` |
| Your own draft shows a cluster of those tells before you deliver it | `humanizer` for a draft audit, adding `stop-slop` when staging or cadence tells appear |
| A broadly slop-heavy rewrite | `writing-for-humans`, `humanizer`, and `stop-slop` |
| Agent-consumed instructions: skills, prompts, `AGENTS.md`, pointers | `writing-for-agents` |
| PR titles, descriptions, and review comments | `pr-writing` |
| Interfaces, dashboards, landing pages, mockups, design systems, or frontend code | `stop-design-slop` |

- `how` and `why` own the content of an explanation of current code or of history. This skill owns the presentation.
- `writing-for-agents` owns instructional structure and invocation. Human-facing explanations about those instructions follow this skill. When importing instructions, keep their wording, examples, and exceptions; prose cleanup does not permit weakening their force.
- `pr-writing` owns the artifact requirements and the publication boundary. This skill owns the prose routing.
- A personal voice overlay loads only when applicable instructions or the operator name it. Availability alone selects no voice.
- Domain-specific writing skills stay conditional on their own triggers.

## Delegation

Parent-loaded skills do not imply child loading. When delegation is permitted, a prose handoff names the artifact, audience, voice when specified, the operator's stated reader outcome when there is one, and required writing skills. Require the child to load those skills itself. Give boundaries as facts, with the affirmative fact behind each when known, and leave their wording and placement to `writing-for-humans`. Quote wording only when it must appear verbatim, since writers tend to reproduce quoted sentences, and check requested sections against the reader outcome before dispatch. A fresh follow-up or prose review receives the same writing contract; the reviewer checks the prose against the reader outcome alongside factual fidelity, within its role's finding bar. Where nested delegation is permitted, descendants preserve that contract rather than assuming the parent's loaded set. This rule does not authorize delegation or extend a child's role.

## Ownership

`unslop` selects. `writing-for-humans` guides drafting and the finish pass. `stop-slop` repairs staging, cadence, and structure. `humanizer` owns the rewrite workflow for existing prose, the focused audit of a draft, and the repair of vocabulary, register, attribution, and formatting. `stop-design-slop` carries the visual depth. No depth skill creates another writing policy, and none is activated just because the others exist.
