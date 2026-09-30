# Vocabulary, register, attribution, and formatting

Use patterns in context. A cluster can reveal a writing problem; an isolated word is not a blacklist match. Every example below is constructed and its rewrite adds no facts.

## Inflated significance

Words to watch: stands/serves as, is a testament/reminder, a vital/significant/crucial/pivotal/key role/moment, underscores/highlights its importance/significance, reflects broader, symbolizing its ongoing/enduring/lasting, contributing to the, setting the stage for, marking/shaping the, represents/marks a shift, key turning point, evolving landscape, focal point, indelible mark, deeply rooted, a new era of, the future of [X], ushering in, revolutionising.

Puffing up arbitrary facts into sweeping "this matters" claims is ceremony rather than content. Retain an actual source-backed significance claim when it belongs.

Before: "The institute was established in 1989, marking a pivotal moment in the evolution of regional statistics."

After: "The institute was established in 1989."

Do not invent its mission or institutional independence to replace the inflated clause.

## Promotional language

Words to watch: boasts a, vibrant, rich (figurative), profound, enhancing its, showcasing, exemplifies, commitment to, natural beauty, nestled, in the heart of, groundbreaking (figurative), renowned, breathtaking, must-visit, stunning. These often advertise instead of explain. Keep a genuine attributed judgment or the user's selected promotional voice; otherwise describe only the supplied behavior.

Before: "The tool offers a seamless way to export rows as CSV."

After: "The tool exports rows as CSV."

## Notability as a substitute for substance

A list of outlets or follower counts does not explain a person's work. Retain relevant supplied facts; do not manufacture an interview date or quotation to make the paragraph substantive. Ask for the missing substance when the task requires it.

Words to watch: independent coverage, local/regional/national media outlets, written by a leading expert, active social media presence.

## Vague attribution

Words to watch: Industry reports, Observers have cited, Experts argue, Some critics argue, several sources/publications. These name no retrievable source. Look up the source when authorized. If none is supplied or found, preserve the attribution's uncertainty or identify the gap instead of inventing an expert, survey, or institution.

Before: "Experts believe this retry limit improves reliability."

After: "Unnamed experts believe this retry limit improves reliability."

Flag the missing attribution separately when the assignment requires source checking. A clean assertion that the limit improves reliability would falsely strengthen the source.

## Challenges and future prospects

Watch for "Despite its... faces several challenges", "Despite these challenges", "Challenges and Legacy", and "Future Outlook". A template section can say nothing concrete. Keep actual challenges and plans supplied by the source; cut the generic resilience or future-success conclusion.

## Vocabulary clusters and copula avoidance

High-frequency words to examine in clusters: Additionally, align with, crucial, cutting-edge, delve, elevate, emphasizing, empower, enduring, enhance, fostering, game-changer, garner, highlight (verb), highlighting, interplay, intricate/intricacies, journey (figurative), key (adjective), landscape (abstract noun), meticulous, next-level, pivotal, revolutionary (figurative), robust (figurative), seamless, showcase, showcasing, tapestry (abstract noun), testament, underscore (verb), unlock (figurative), valuable, vibrant.

Also examine superficially scientific vocabulary such as causal, empirical, and correlate when it dresses up an unsupported claim. Keep those words when they are the accurate technical term. This is not a model-specific diagnostic or an authorship claim.

Words to watch: serves as/stands as/marks/represents/functions as/operates as [a], boasts/features/offers [a], refers to (when the sentence is about the thing, not the term). They can obscure a simple "is", "has", or concrete verb.

Before: "The gateway serves as the entry point and boasts support for signed requests."

After: "The gateway is the entry point and accepts signed requests."

## Superficial analysis and association

Trailing "highlighting", "reflecting", or "symbolizing" clauses often assert a relationship without evidence. "Associated with" and "in connection with" can hide which relationship is claimed. State a supported relation; if the source establishes only association, do not strengthen it into causation.

Other riders: underscoring, emphasizing, ensuring, contributing to, cultivating, fostering, encompassing, showcasing. Other association phrases: in association with, connected with/to, particularly/widely associated. A participle or association is valid when it describes the evidenced relation.

## Stable terminology

Do not rotate "protagonist", "central figure", and "hero" merely to avoid repetition. Use one name for one thing. Replace false ranges with the actual supplied topics; do not invent endpoints or new topics.

For example, "from X to Y" needs a meaningful scale. Keep distinct topics instead of manufacturing a range or erasing one endpoint.

## Uncertainty and source gaps

Remove stacked modals such as "could potentially possibly" while retaining the meaningful qualifier. A historical inference remains an inference. Model-training disclaimers do not belong in the artifact, but a real evidence gap does.

Words to watch: "as of [date]", "Up to my last training update", "based on available information", "not widely documented/available", and "While specific details are limited, the [subject] likely...". These can leak model meta or invent an absence and then fill it with a plausible story. Do not speculate into a gap you just declared. State the gap plainly, and state a date or figure only when the source supplies it.

Keep real source dates, time bounds, and explicitly supplied hypotheses with their uncertainty. This diagnostic does not authorize deleting an author's hypothesis merely because it is uncertain; it prevents an editor inventing one to fill missing evidence.

Before: "The service could potentially have failed during the deploy; the logs are unavailable."

After: "The service may have failed during the deploy; the logs are unavailable."

Do not turn missing logs into proof of either success or failure.

## Actorless passive

Name an actor when the source identifies one. Passive is appropriate when the actor is unknown, irrelevant, or deliberately withheld, or the object is the paragraph's subject.

Before: "The guide was rewritten by the support team for the new roles."

After: "The support team rewrote the guide for the new roles."

If the input did not name the actor of this same action, do not invent "the support team".

## Inanimate subjects with human verbs

"The roadmap wants" or "the dashboard understands" gives an abstraction a mind. Describe actual behavior using supplied facts. "The report shows" and "the form submits" are ordinary product verbs, not defects.

Before: "The dashboard understands your priorities and opens the three cohorts you pinned last."

After: "The dashboard opens the three cohorts you pinned last."

## Mechanical formatting

- Use sentence case in headings, except required titles or the selected author's style. "Strategic Negotiations And Global Partnerships" becomes "Strategic negotiations and global partnerships".
- Bold should mark useful emphasis, not every noun or acronym.
- Inline-header vertical lists such as `- **Thing:** sentence` can read like auto-generated changelogs. Convert unnecessary labels to sentences; vary structure. Preserve a required output schema or a list whose labels genuinely help scan distinct items.
- Remove decorative emoji unless the audience expects them.
- Convert to straight quotes for plain-text/code-adjacent writing; preserve exact quotations and explicitly selected authorial typography. Curly quotes alone are not evidence of AI authorship.
- Punctuation follows `writing-for-humans`. There is no separate em-dash or semicolon ban.
- Horizontal rules between every section, skipped heading levels, a dump of H1s, a heading whose only children are more headings, and tiny tables used only for layout can obscure hierarchy. Use the structure the content needs.
- All-caps emphasis and clusters of scare quotes can manufacture urgency or distance. Preserve genuine quoted language and required normative words.

## Chat artifacts and placeholders

Remove "I hope this helps", "Certainly!", empty praise, and generic upbeat closers when they are pasted into the artifact. A real answer to a user's concern is not empty reassurance.

Words to watch: Of course!, You're absolutely right!, Would you like..., let me know, here is a... . Sycophantic or servile tone substitutes praise for judgment. Be direct; agree or disagree with the substance. Generic conclusions such as "The future looks bright" and "exciting times ahead" add nothing unless the source supplies a concrete plan. End on the last useful claim rather than inventing a next step or metric.

Fill placeholders only from supplied evidence. Replace leaked model citation markup with a real citation, or remove the unsupported claim. Do not remove a working native citation in a chat answer merely because the interface renders it specially.

Placeholder residue includes `[Your Name]`, `[Specific Topic]`, `INSERT_SOURCE_URL`, `2025-XX-XX`, `_(Add your URL here)_`, and `TODO: fill in`. Leaked markup includes `contentReference`, `oaicite`, `turn0search0`, `grok_card`, `grok_render_citation_card_json`, `[cite: 1]`, `[span_1]`, `attached_file`, `ppl-ai-file-upload`, and `:::writing` when pasted into a standalone artifact.

## Filler substitutions

| Filler | Plain form |
|---|---|
| In order to achieve this goal | To achieve this |
| Due to the fact that | Because |
| At this point in time | Now |
| In the event that | If |

Substitute only when the referent and meaning stay intact. Empty filler differs from a qualification carrying uncertainty or scope.

## Cadence handoff

Antithesis, dramatic fragments, forced triplets, aphorism formulas, signposting announcements, fake-candid openers, and section restatements belong to `stop-slop`. When they are also present, load that overlay instead of maintaining another cadence policy here.

## Sources

The operator-maintained source used [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) as a field guide. Later actor, passive, quotation, and register diagnostics were adapted from [anti-slop](https://github.com/miqdadbadjuber/anti-slop), Miqdad Badjuber, MIT. The license notice is bundled. The unsafe source examples that added facts during rewriting have been replaced with the constructed examples above.
