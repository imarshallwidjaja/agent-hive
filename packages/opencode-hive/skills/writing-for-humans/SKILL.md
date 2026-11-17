---
name: writing-for-humans
description: Use when drafting or explaining code, architecture, systems, processes, decisions, requirements, PRDs, product outcomes, plans, ADRs, technical documentation, or reviews; or authoring emails, announcements, posts, release notes, or product copy.
---

# Writing for humans

Write as a technically competent human who is trying to make something easy for another human to understand. The reader should find the writing easy to follow and see no sign of a style framework.

This is the generative discipline for software and product writing. Apply it while drafting. Do not announce it. Adapt voice and structure to the artifact and audience.

## Principles

1. **Start from the reader.** Give them what they need in order to act or decide. Make that information findable, understandable, and usable. Leave out decoration. Do not omit a condition, exception, or uncertainty the reader needs.
2. **Name things stably.** Pick one term for each thing and keep it. Preserve necessary technical vocabulary. If the reader may not know a term, explain it briefly at first use using only what the source supports. Expand an unfamiliar abbreviation once. If no accurate short explanation exists, state the specific behavior instead of a loose gloss. A name should still make sense when encountered in isolation.
3. **Keep subjects, verbs, and relationships explicit.** Name the actor when the actor matters, and give a non-human subject only a verb it can literally perform. Say what depends on what, what runs when, and who owns which responsibility. Prefer verbs for actions. Put the new, important information at the end of the sentence, and end the sentence there.
4. **Put the specific point first.** Open a document and each section with its answer, decision, finding, or instruction. Give a short frame first only when the reader cannot follow the point without it. An explanation or argument can build to its conclusion when the reader must see the evidence first. A writer's own notes keep their order. Do not open with a general statement of a point the text then repeats. Keep one topic per paragraph.
5. **Use structure for navigation.** Headings, lists, and tables help when they match the information.
   - Do not convert continuous reasoning into bullets, tiny paragraphs, or a template just to look organized. Keep reasoning that runs from one sentence to the next in prose.
   - Put several independent rules, exceptions, conditions, or steps in a list or separate short paragraphs rather than one long paragraph.
   - Use bold for labels readers scan for in reference material, not to stress words in running prose. Required role and template formats stay.
   - A heading names what its section contains and withholds nothing: a noun phrase the reader would search for, or the finding stated in full. Turn a label heading that starts with What, Why, How, Where, or When into a noun phrase ("Retry limits"). A question heading belongs to the reader's own question, as in a how-to or FAQ. Headings that a role's fixed output format, a required template, numbered plan tasks, or procedure steps require keep their form.
6. **Keep meaning intact.** Preserve necessary qualifiers, scope, trade-offs, constraints, and causal explanation in relevant claims. Do not make a claim sound more certain because a shorter sentence would. Do not collapse distinct ideas into one slogan.
7. **Match the job of the document.** A how-to should help a competent person do a job. An explanation should help someone understand why. Reference should state facts. Requirements should be testable statements of need, not designs, observations, or product principles.

## Cadence

Write prose that can be read continuously. Paragraphs may contain several related sentences.

A sentence carries one main point with the conditions it needs to be true. Restructure it when it has any of these signals:

- A second main point.
- A chain of exceptions.
- A list inside a list.
- A subject far from its verb.

Length is a cue, never a limit or target. Past about 25 words, check for those signals. Keep a long sentence with one clear core. A split keeps the stated relation, such as because, but, so, or for example, and adds no relation the source lacks.

In technical prose, prefer two sentences or a named relation to a semicolon. A supplied voice, quotation, or imported wording keeps its semicolons.

Brevity is useful when it improves understanding. Cutting words is not the goal.

Do not manufacture importance or tension. Avoid antithesis frames such as "This isn't about X, it's about Y," stacked negation ("It's not X, and it's not Y, but Z"), dramatic fragments, chains of one-line paragraphs, Stop/Start couplets, "I used to / then I learned" setups, rhetorical setup and payoff, repeated three-part slogans, a trailing ", not Y" or "rather than Y" tail that answers nothing the reader asked, and phrases written mainly to sound quotable. That register is LinkedIn cadence. Do not reach for "this changes everything", "the real problem is", "here's the thing", "the key insight is", or "the honest answer" when an ordinary explanation would do.

## Finish pass

Before delivering, run one loop: draft, audit, fix.

1. Draft with the principles above, then read it as the intended reader would.
2. Audit with three questions. Where must the reader reread or guess to understand the point, and what makes this read as machine-written? Is each thing introduced by what it is or does, with every remaining exclusion meeting the boundaries test? Does it state any fact, name, number, date, quote, or citation not in the source or conversation?
3. Fix the hits, then check again. Do not narrate the audit unless asked.

For technical and product prose, check the details relevant to the reader: who or what acts, the action and its object or version, conditions and prerequisites, both sides of a comparison, what a quantity or delta measures and its baseline or conditions, and what a result establishes. Unpack compounds or metaphor labels when they obscure an operation or relationship; keep the reader's domain terms and concise known referents. Make relationships explicit before compressing them. Resolve or state necessary missing facts; do not invent an actor, condition, metric, baseline, benefit, or authority to fill a gap.

A rewrite adds nothing that is not in the source or supplied by the user. Specificity comes from the source. If a sentence needs real detail to work, ask for it when necessary or write the plain version without it. Preserve relevant semantically distinct list items; rhythm alone is not a reason to add or delete one.

Calibrate before cutting. A clear reader-facing defect, such as an unclear relation or empty hype, merits repair on its own. Weak signals need context: one "however" or an isolated word proves nothing. Preserve specific detail, mixed feelings, unresolved tension, dated references, genuine asides, and varied sentence length. A user-supplied writing sample outranks these defaults.

Em dash policy: limit them, and pick the substitute by context: a colon between a field label and its value, a period for two complete thoughts, parentheses for a real aside, a comma for a light pause. Never reroute a removed dash into a semicolon or a colon reveal. Replace a label that only classifies the next statement ("One caveat:") with the statement itself. In a rewrite of AI-composed prose, replace em dashes and spaced en dashes unless the writer's own writing uses them. Elsewhere a deliberate aside may keep one, and a user-supplied sample sets the frequency. This is not an absolute ban.

Exact quotations, actual literals, identifiers, schema and protocol values, and UI strings quoted to match the product retain their required wording. Ordinary headings and UI copy are editable when copy is in scope; preserve their meaning and commitments. Imported agent instructions keep their required wording, examples, exceptions, and normative force. A retained historical claim labelled Inferred stays inferred after a prose edit.

## Boundaries and alternatives

Describe each thing by what it is, does, accepts, needs, or produces. A supported affirmative description may be sufficient without claiming exhaustive scope. For each standalone exclusion, identify the concrete consequence for this reader's action, decision, interpretation, or explicit question, grounded in the request, visible context, or actual contract, state, or behavior. Keep it where it matters. A hypothetical misunderstanding, prior presence, or extra explicitness alone is insufficient.

If the source gives only a negative, keep it when necessary, omit it when irrelevant, or retrieve a supported positive when needed; never invent its converse. The same test covers a contrast attached to a sentence, such as a trailing ", not Y". Keep it when it answers the reader's question or corrects a value the reader has seen. State a limit that a contract requires, such as an unrun check or an unknown, as its own fact in the field the contract names. An evidence classification written as a contrast, such as "a static finding, not a reproduced failure", becomes two plain statements: what the evidence is, and what was not done or observed.

Attached qualifiers stay when evidence requires their uncertainty, scope, or commitment. Preserve binding normative guards and their logical force, including safety prohibitions at each applicable step. Apply the same consequence test to non-guarantees, open decisions, missing coverage, evidence gaps, and unruled hypotheses. An unknown that bounds a retained expectation or live operational decision can matter. Deleting an unsupported savings claim alone does not require narrating the missing evidence.

Unsupported or irrelevant claims and whole paragraphs can go. When naming open decisions or missing coverage, give an owner or date only if the source does.

Evidence, requirements, and human stance constrain meaning; a draft is candidate material even when human-authored, and repeated agent wording has no authority. Respect explicit light-edit, faithful-copy, and voice contracts. An affirmative rewrite must not broaden each, all, only, actors, guarantees, or verification level.

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

**Procedures.** Put the condition before the instruction. Name each prerequisite, such as a host, flag, or prior step, before the step that needs it. Give each step one instruction unless the actions happen together. Put a warning before the step it guards. State what to do or avoid, then the risk. In a guard you write, spell out "do not" and "cannot". Keep quoted or imported guards' wording. Keep every guard's logical force.

**Architecture.** Make responsibilities, relationships, runtime behavior, assumptions, trade-offs, constraints, and reasons understandable. Start from context and the problem being solved. State the trade-off an operator must live with. Boxes, layers, and "components" are not a substitute for those facts.

**Product writing.** Keep the underlying problem, desired outcome, evidence, constraints, success criteria, and proposed capability conceptually distinct. An observation is not a requirement. A capability is not a success criterion.

For requested working product-alignment notes or structured brain dumps, start with short task-based sections, list-led ideas, and brief commentary. Keep user workflows, useful outputs, and implementation mechanisms conceptually distinct when present. Use continuous prose where causal reasoning needs it; the distinctions do not prescribe fixed sections or a universal bullet template.

**Requirements.** Write one need per statement when the text is actually a requirement. Make it verifiable. Do not hide a design choice inside a requirement. Use MUST, SHOULD, and MAY only when the statement is normative; do not sprinkle them through ordinary prose.

**Reviews.** Lead with the finding and its source location. Separate defects from preferences. For proposed additions, restorations, or deletions, identify the concrete semantic or reader consequence; for additions or restorations, also identify the missing information. Sufficient supported affirmative scope clears a deletion lead; prior presence or implied-but-not-explicit alone is insufficient for restoration. Requested cleanup is an acceptance criterion under the reviewer's unchanged role bar and verdict.

## Examples and ownership

Read [examples](references/examples.md) when calibrating a rewrite, explaining a system, or drafting technical or product prose where actors, terminology, conditions, comparisons, or evidence need clarification. [Source notes](references/sources.md) record the influences and what not to import from them.

`unslop` owns routing. This skill owns generative discipline, the finish pass, boundaries and alternatives, durable names, and artifact instincts. `stop-slop` owns staging, cadence, and structure rewrites. `humanizer` owns the rewrite workflow for existing prose, including composing from a writer's notes or interview answers, and vocabulary, register, attribution, formatting, and chat-artifact tells. Ordinary drafting needs the finish pass, not automatic activation of both overlays.
