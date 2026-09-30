---
name: humanizer
description: Use when rewriting existing prose that is promotional, vague, over-hedged, or chatbot-like, or shows AI vocabulary clusters, weasel attribution, actorless passive, placeholder residue, citation markup, or mechanical formatting. Depth skill for writing-for-humans.
---

# Humanizer

Remove common AI-writing patterns while keeping the meaning, facts, and intended tone intact. These patterns are editing diagnostics, not evidence that a person used AI.

## Hard rules

- Do not invent personality, emotion, anecdotes, uncertainty, or factual errors.
- Do not add voice that was not present. Remove patterns; do not replace them with fabricated tone.
- Preserve factual claims, dates, names, and qualifications exactly. Do not invent a source, actor, purpose, number, or event to make a vague sentence more specific.
- Exact quotations, titles, proper names, code, public contracts, and examples discussing a phrase are not vocabulary-cleanup targets.

Load with `writing-for-humans`. That skill owns the finish pass, non-invention rule, and punctuation policy. `stop-slop` owns cadence and structure. This skill owns vocabulary, register, attribution, formatting tells, and chatbot artifacts.

## Editing

Read [patterns](references/patterns.md) for the defect present in the text. Prefer plain, direct constructions when they preserve the claim. Remove empty chatbot meta. If an actor or source is missing, retrieve it when authorized and necessary, ask, or leave the uncertainty explicit; do not fill the gap by invention.

## What not to flag

A clean human writer can hit several patterns without a model involved. Perfect grammar, mixed registers, dryness, formal vocabulary, one transition word, curly quotes, an em dash, or one short emphatic sentence are not reliable tells on their own. Technical uses of words such as "causal" or "empirical" remain appropriate when that is what the source means.

Unsourced claims alone are not a tell. Most writing is unsourced, and a missing citation proves nothing about authorship. Distinguish an unsupported attribution in the task's evidence from a demand to add citations to every ordinary sentence.

If the user supplies a writing sample, read it first and note sentence lengths, vocabulary, paragraph openings, punctuation, and recurring phrases. Match those habits rather than only deleting patterns; do not upgrade casual words or regularize deliberate quirks. The sample outranks these defaults.

Return the rewritten text unless the user requests an explanation. Preserve the host's required output format.
