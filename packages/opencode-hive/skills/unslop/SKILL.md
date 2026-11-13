---
name: unslop
description: Use when producing, reviewing, repairing, or handing off anything a person will read or look at, including replies, docs, plans, reports, PR text, product or UI copy, interfaces, mockups, and prose delegated to another agent.
---

# Unslop

Slop is output that statistical habit shaped instead of this reader, this artifact, and this product. Unslop works from the other end: name who will read or use the thing and what they need from it, then give every sentence, label, and visual choice a purpose you can state. A choice with no purpose gets replaced by something specific, or removed.

This skill is the shared philosophy and the router. It applies to writing, to reviewing and cleaning up existing material, and to handoffs, in every role. It changes no role's authority, finding bar, verdict, or required output format. A read-only reviewer names the defect and the direction of the repair; the role that owns the artifact rewrites it.

## Baseline

Apply to every human-facing output, short replies included, without announcing it:

- **Reader first.** Put the answer, decision, or next action first, in the words this reader would use.
- **Claim in the subject and verb.** Make the topic the subject and its action the verb; name a source-given actor when it matters. A non-human subject does only what it literally can; state the finding: given "Table 2: p95 2.1 s", write "Table 2 lists a p95 of 2.1 s" for "The table shows it."
- **Concrete nouns, literal words.** Name the real symbol, file, flag, command, number, or person, with literal verbs and adjectives: write "required" for "load-bearing". Give each thing one name and keep it.
- **One reading.** Each "it", "this", "they", and "which" points at one obvious noun; repeat the noun when in doubt. Place "only" and "not" beside the word they change. Keep the verb and the small words that show a sentence's structure.
- **Enough words.** Compression that makes the reader rebuild a relationship or guess what a number means moves the work to them. Shorter is clearer only when nothing the reader needs was cut.
- **End the sentence on the fact.** State a limit as what was done and what was not: given a review that read the source and ran no tests, write "The source was read. No test ran." for "These findings are static, not tested." Keep a contrast the reader asked for or a correction to a value they have seen. Guards, required limits, unrun checks, and unknowns stay, each as its own sentence.
- **Headings that withhold nothing.** Use a noun phrase the reader would search for, or the finding in full: write "Retry limits" for "What retries actually do". Question headings are the reader's own questions. Headings a role or template requires stay.
- **Only what the sources hold.** Every fact, name, number, date, quote, source, and outcome comes from the sources or the conversation.
- **Meaning and authority.** Describe things by what they are, do, accept, or produce. Evidence, requirements, and the human's stance constrain meaning; draft prose is editable, and agent repetition grants it no authority. Keep necessary claim qualifiers and binding guards at their original force. A standalone exclusion needs a concrete reader consequence; `writing-for-humans` defines that test.
- **Draft, audit, fix.** Before delivering, read the draft as the reader would, ask what a careful editor would mark, and check sentence endings and headings. Fix it, then check again.

Preserve actual literals, quotations, identifiers, schema and protocol values, and UI strings quoted to match the product. Ordinary headings and UI copy are editable when copy is in scope; retain their meaning and commitments.

Product copy, announcements, and interface labels meet the same test: concrete product nouns, the action, and the outcome. A visual choice meets it too, through hierarchy, grouping, state, identity, or access.

## Route

Routing is a load obligation. The task and actual defects determine matching rows and applicable workflows and checks regardless of length. When a row matches, load the skills it names with the native skill tool before drafting or repair, plus any those skills name for themselves. Load only matching rows; the baseline suffices when none applies.

| Case | Load |
|---|---|
| Docs, plans, reports, reviews, explanations, prose handoffs, or authoring emails, announcements, posts, release notes, or product copy | `writing-for-humans` |
| Cadence or structure problems: antithesis, stacked negation, fragment runs, quotable closers, uniform rhythm | `writing-for-humans` and `stop-slop` |
| Rewriting existing prose to remove AI tone (vocabulary, register, attribution, formatting, chat artifacts), or composing from a writer's notes, transcript, or interview answers | `writing-for-humans` and `humanizer`; a full rewrite adds `stop-slop` |
| Your own draft shows a clear defect or a contextual cluster of those tells before you deliver it, or supplied prose is requested for an audit or check | `humanizer` for a draft audit, adding `stop-slop` when staging or cadence tells appear |
| A broadly slop-heavy rewrite | `writing-for-humans`, `humanizer`, and `stop-slop` |
| Agent-consumed instructions: skills, prompts, `AGENTS.md`, pointers | `writing-for-agents` |
| PR titles, descriptions, and review comments | `pr-writing` |
| Interfaces, dashboards, landing pages, mockups, design systems, or frontend code | `stop-design-slop` |

- `how` and `why` own the content of an explanation of current code or of history. This skill owns the presentation.
- `writing-for-agents` owns instructional structure and invocation. Human-facing explanations about those instructions follow this skill. When importing instructions, keep their wording, examples, and exceptions; prose cleanup does not permit weakening their force.
- `pr-writing` owns the artifact requirements and the publication boundary. This skill owns the prose routing.
- Select a personal voice overlay from the artifact's authorship or intended voice, or an operator or workspace instruction whose conditions apply to that artifact. A generic technical-register preference or the requester's identity alone does not select an overlay.
- Domain-specific writing skills stay conditional on their own triggers.

## Delegation

Parent-loaded skills do not imply child loading. When delegation is permitted, a prose handoff names the artifact, audience, voice when specified, the operator's stated reader outcome when there is one, and required writing skills. Carry only the overlay selection applicable to the artifact; do not turn an inferred register into an operator requirement. Require the child to load those skills itself. Give boundaries as facts, with the affirmative fact behind each when known, and leave their wording and placement to `writing-for-humans`. Quote wording only when it must appear verbatim, since writers tend to reproduce quoted sentences, and check requested sections against the reader outcome before dispatch. A fresh follow-up or prose review receives the same writing contract; the reviewer checks the prose against the reader outcome alongside factual fidelity within the role's finding bar, and applies the `writing-for-humans` boundary rule to proposed additions, restorations, and deletions. Where nested delegation is permitted, descendants preserve that contract rather than assuming the parent's loaded set. This rule does not authorize delegation or extend a child's role.

## Ownership

`unslop` selects. `writing-for-humans` guides drafting and the finish pass. `stop-slop` repairs staging, cadence, and structure. `humanizer` owns the rewrite workflow for existing prose, the focused audit of a draft, and the repair of vocabulary, register, attribution, and formatting. `stop-design-slop` carries the visual depth. No depth skill creates another writing policy, and none is activated just because the others exist.
