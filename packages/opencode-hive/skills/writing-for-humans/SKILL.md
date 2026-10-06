---
name: writing-for-humans
description: Use when drafting or explaining code, architecture, systems, processes, decisions, requirements, PRDs, product outcomes, plans, ADRs, technical documentation, reviews, or other substantial human-facing prose.
---

# Writing for humans

Write as a technically competent human who is trying to make something genuinely easy for another human to understand. The reader should notice that the writing is easier, not that a style framework was applied.

This is the generative discipline for software and product writing. Apply it while drafting. Do not announce it. Adapt voice and structure to the artifact and audience.

## Principles

1. **Start from the reader.** Give them what they need in order to act or decide. Make that information findable, understandable, and usable. Leave out decoration. Do not omit a condition, exception, or uncertainty the reader needs.
2. **Name things stably.** Pick one term for each thing and keep it. Preserve necessary technical vocabulary. If the likely reader may not know a term, define it once in context. A name should still make sense when encountered in isolation.
3. **Keep subjects, verbs, and relationships explicit.** Name the actor when the actor matters. Say what depends on what, what runs when, and who owns which responsibility. Prefer verbs for actions.
4. **Give enough context, then the point.** A reader who arrives mid-document should still understand why a statement matters. If an explanation would not land without a frame, supply a short one.
5. **Use structure for navigation.** Headings, lists, and tables help when they match the information. Do not convert continuous reasoning into bullets, tiny paragraphs, or a template just to look organized.
6. **Keep meaning intact.** Preserve hedges, scope, trade-offs, constraints, and causal explanation. Do not make a claim sound more certain because a shorter sentence would. Do not collapse distinct ideas into one slogan.
7. **Match the job of the document.** A how-to should help a competent person do a job. An explanation should help someone understand why. Reference should state facts. Requirements should be testable statements of need, not designs, observations, or product principles.

## Cadence

Write prose that can be read continuously. Paragraphs may contain several related sentences. Sentence length may vary; a semicolon is allowed when it joins two closely related clauses.

Brevity is useful when it improves understanding. Cutting words is not the goal.

Do not manufacture importance or tension. Avoid antithesis frames such as "This isn't about X, it's about Y," stacked negation ("It's not X, and it's not Y, but Z"), dramatic fragments, chains of one-line paragraphs, Stop/Start couplets, "I used to / then I learned" setups, rhetorical setup and payoff, repeated three-part slogans, and phrases written mainly to sound quotable. That register is LinkedIn cadence. Do not reach for "this changes everything", "the real problem is", or "here's the thing" when an ordinary explanation would do.

## Finish pass

Before delivering, run one loop: draft, audit, fix.

1. Draft with the principles above, then read it as the intended reader would.
2. Audit with three questions. What makes this read as machine-written? Is each thing introduced by what it is or does, with every remaining exclusion meeting the boundaries test? Does it state any fact, name, number, date, quote, or citation not in the source or conversation?
3. Fix the hits, then check again. Do not narrate the audit unless asked.

A rewrite adds nothing that is not in the source or supplied by the user. Specificity comes from the source, not from the rewrite. If a sentence needs real detail to work, ask for it when necessary or write the plain version without it. Preserve all semantically distinct list items; rhythm is not a reason to add or delete one.

Calibrate before cutting. Look for clusters of tells rather than single instances; one "however" or one short emphatic sentence proves nothing. Preserve specific detail, mixed feelings, unresolved tension, dated references, genuine asides, and varied sentence length. A user-supplied writing sample outranks these defaults.

Em dash policy: limit them. Prefer a new sentence, a comma, a colon, or parentheses. A deliberate aside may keep one. Match the frequency of a user-supplied sample. This is not an absolute ban.

Exact quotations, public contracts, code, titles, required output formats, and imported agent instructions retain their meaning and required wording. A historical claim labelled Inferred stays inferred after a prose edit.

## Boundaries and alternatives

Describe each thing by what it is, does, needs, or produces. Stating what a thing covers preserves its scope. When the source pairs a boundary with the affirmative fact behind it, such as which surface provides an excluded capability, state that fact. Mention an exclusion only when this reader would still expect the excluded behavior after reading the affirmative description, and then state it once, where the reader would act on that expectation. When the source supplies only the exclusion, keep it as written.

Some facts are negative by nature and keep their form: prohibitions and guards in instructions, MUST NOT requirements, contract non-guarantees, out-of-scope statements in requirements and plans, evidence gaps, and hypotheses not yet ruled out. A safety prohibition stays at each step where it applies. Collect open decisions and missing coverage, such as workflows without mockups, in one place, with an owner or date only when the source names one.

Apply the same test to rejected alternatives: name a discarded option only when this reader would otherwise reopen it or misread the current state.

Keep alternatives in ADRs, design reviews, and answers to "why not X?" Keep a live operational contrast such as "writes still go to Postgres."

Drop them from README current-state sections, commit messages, PR summaries, and status updates unless the ask was to justify the approach. "I didn't use X because", "rather than rewriting", "I considered A, B, and C", "this does not affect Y", and "while preserving Z" are process narration when the reader never held those alternatives.

Architecture writing still states trade-offs the operator has to live with. It does not recap the menu of options the author personally discarded.

## Durable names

Name code, files, docs, components, branches that become the thing's identity, and concepts by purpose, responsibility, domain meaning, or outcome. Do not encode temporary planning context.

Do not use Phase 1, Option B, Workstream 2, ticket-only labels, or "final"/"new" versioning from the conversation as durable names. Prefer `coverage-processing` over `phase-1`, and `scene-ingestion` over `workstream-2`. A planning identifier belongs in a durable name only when it is a first-class concept with a defined meaning, such as an RFC or CVE.

A public protocol version can be such a concept; a tracker ID can belong in a commit subject when that is the repository contract. Do not put an identifier in a type, module, or heading if a reader would have to open the planning thread or an external document just to understand the name.

"Option B" as a filename is the naming form of rejected-alternative leakage.

Scratch paths that will be deleted can be messy. Git-tracked and exported names cannot.

## Artifact instincts

**Code and systems.** Name concrete objects. Say what must exist before something runs. Prefer inputs, outputs, state, handoff points, and failure boundaries over capability claims.

**Architecture.** Make responsibilities, relationships, runtime behavior, assumptions, trade-offs, constraints, and reasons understandable. Start from context and the problem being solved. State the trade-off an operator must live with. Boxes, layers, and "components" are not a substitute for those facts.

**Product writing.** Keep the underlying problem, desired outcome, evidence, constraints, success criteria, and proposed capability conceptually distinct. An observation is not a requirement. A capability is not a success criterion.

**Requirements.** Write one need per statement when the text is actually a requirement. Make it verifiable. Do not hide a design choice inside a requirement. Use MUST, SHOULD, and MAY only when the statement is normative; do not sprinkle them through ordinary prose.

**Reviews.** Lead with the finding and its source location. Separate defects from preferences. The reviewer role owns its finding bar and verdict; writing guidance does not change either.

## Examples and ownership

Read [examples](references/examples.md) when calibrating a rewrite or explaining a system. [Source notes](references/sources.md) record the influences and what not to import from them.

`writing-policy` owns routing. This skill owns generative discipline, the finish pass, boundaries and alternatives, durable names, and artifact instincts. `stop-slop` owns cadence and structure rewrites. `humanizer` owns vocabulary, register, attribution, formatting tells, and chat artifacts. Ordinary drafting needs the finish pass, not automatic activation of both overlays.
