---
name: stop-slop
description: Use when rewriting existing prose whose cadence or structure reads as machine-written, such as antithesis, stacked negation, fragment runs, LinkedIn cadence, rhetorical setups, pause-and-point lines or colon reveals, restating or engagement closers, uniform sentence rhythm, throat-clearing openers, or quotable one-liners. Depth skill for writing-for-humans.
---

# Stop slop

Remove filler, staging, formulaic structures, and mechanical cadence from prose while preserving meaning, facts, and tone.

## Core rules

1. **Cut filler phrases.** Remove throat-clearing openers, emphasis crutches, pause-and-point lines, restating closers, and filler transitions. See [phrases](references/phrases.md).
2. **Break formulaic structures.** Avoid LinkedIn cadence, antithesis, stacked negation, dramatic fragmentation, and rhetorical setups. See [structures](references/structures.md). Flattening the rhythm is not enough if the contrast frame remains.
3. **Vary rhythm without reshaping meaning.** AI prose clusters sentence lengths in one band, usually 10 to 20 words. When more than about 70% of sentences sit within five words of the median, vary them in the direction the text needs. Uniformly long: split one or two and add a short sentence that lands a fact. Uniformly short and choppy, the usual result of removing dashes and fragments: merge sentences into a longer one that breathes, around 25 to 40 words. A short sentence must carry a fact or a decision; "It works." carries nothing. Merging sentences is not merging list items: never add, merge, or remove list items for cadence. Retain every semantically distinct item.
4. **Trust readers.** State facts directly. Preserve meaningful uncertainty, scope, and qualifiers. Remove empty hedging that only softens the point without adding information.
5. **Cut quotables.** If it sounds like a pull-quote, rewrite it. Budget at most one crafted, quotable line per piece, and zero is fine; flatten the rest into plain statements that keep the fact. Preserve source quotations and concise instructional tests whose wording changes a decision; this test targets manufactured profundity in prose.

## Ownership

Load with `writing-for-humans`. That skill owns the finish pass, non-invention, punctuation policy, durable names, and boundaries and alternatives. This skill owns staging, cadence, and structure rewrites. `humanizer` owns the rewrite workflow for existing prose plus vocabulary, register, attribution, and formatting tells; load it when the rewrite needs that workflow or those defects also occur. A full `humanizer` rewrite loads this skill for its crafted-line budget and sentence-length band.

## Checks

- A run of sentences has mechanical length or every paragraph ends punchily: vary the rhythm without changing the claims.
- Too many sentences start with The, It's, That's, This, or You: vary the openers.
- The sentences could be shuffled without losing meaning, so the text is a stack of facts, not an argument: rebuild the spine so each sentence leans on the one before (cause, contrast, example, consequence). Sprinkled connectors only fake it.
- One sentence per paragraph for emphasis: join related sentences.
- "It's not X, and it's not Y, but Z": state Z. X and Y stay only when they pass the boundaries test in `writing-for-humans`.
- A one-line colon reveal ("The best part: it learns.") or a count announced before a list ("Three things changed:"): make the point simply the next sentence.
- A restating or engagement closer ("The bottom line?", "Key takeaway:", "Thoughts?"): end on the last concrete thing, or on one line of what the writer concludes.
- A fragment stack in prose ("No setup. No config. Just results."): merge into one sentence with a subject and a verb. Lists are exempt.
- An invented metaphor label that names nothing the reader can use ("a comfort blanket", "the operating system for your team"): say the plain thing.
- "The best X don't Y. They Z": state the claim without manufacturing authority.
- "Stop X. Start Y": state the action, preserving both requirements when both matter.
- "And that's okay": delete empty permission-giving; retain an answer to a real concern.
- Explaining a metaphor? Trust it to land when the intended reader can understand it without the explanation.
- Em-dash before a reveal? Remove the staged reveal; follow the core punctuation policy.

These are diagnostic questions, not automatic substitutions. A deliberate authorial choice or required quotation survives the checklist. See [examples](references/examples.md).
