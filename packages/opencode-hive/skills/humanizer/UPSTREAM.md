# Provenance

Imported from the operator-maintained `~/.agents/skills/humanizer/` on 2026-10-01 at the operator's request. The local source was not a Git checkout; no upstream revision is asserted. Its two files attributed the pattern vocabulary to Wikipedia's Signs of AI writing and later diagnostics to Miqdad Badjuber's MIT-licensed anti-slop project.

oc-arkive maintains the canonical copy. The non-invention rules, voice calibration, contextual diagnostic approach, vocabulary/register/attribution ownership, and diagnostic vocabulary are retained. Cadence-only entries move to `stop-slop` with their detection lists. The checklist is organized by editing problem rather than numbering; examples that invented dates, actors, purposes, or citations have been replaced. Required schemas and selected authorial typography are explicit exceptions to formatting cleanup, consistent with the core writing policy. The local source had no license file; the public anti-slop notice was retrieved during import and included in `LICENSE.antislop`, scoped to its adapted portions.

The public [blader/humanizer](https://github.com/blader/humanizer) skill (retrieved as version 3.1.0 during import review) was also consulted. It shares diagnostic vocabulary and examples with the local source, but the local copy's historical derivation cannot be established from a Git record. `LICENSE.blader` includes Siqi Chen's MIT notice for that overlapping source material; no pinned historical lineage is asserted. The package does not adopt that version's universal dash ban, mandatory multi-output format, or permission to add personal reactions.

## work-humanizer integration (2026-10-10)

The rewrite workflow now comes from [phuryn/work-humanizer](https://github.com/phuryn/work-humanizer) at commit `819ac9925fffc20f12931cdf7a447db69163cbb2` (Pawel Huryn, MIT; notice in `LICENSE.workhumanizer`). Its README reports a blind multi-judge comparison against blader/humanizer, a one-line prompt, and Emulate-1. On the 12-text scoreboard, work-humanizer made 18 meaning changes against 33 for blader/humanizer, and judges most often chose its rewrite to send. Across the 56 texts it rewrote in five test sets, it invented no facts. Its authors note small samples, AI judges, and that they designed the test; the method and data are in its `evidence/` directory. `SKILL.md` summarizes three of its findings as the upstream evaluation's, not as established fact.

Retained source wording, lightly edited: the goal statement, the three findings, the rewrite, interview, and notes-route modes with their triggers and composition rules, the rewrite steps (upstream step 6, the rhythm pass, is folded into step 5, which already routes rhythm tells to `stop-slop`), "What you must not change", "Sound like a person", "Keep what is already human", the genre notes, final checks 1 to 7 including the fact audit and the shorter-option check, and the word lists and logic of `check.py`. In `references/patterns.md`, doing the reader's work, hedge placement, constructions nobody says out loud, the stock-vocabulary and marketing-register lists, labels that say nothing, exclamation marks, and the added chat residue come from the same source.

Host-mechanics adaptations:

- Interview questions go through the host's question mechanism. Facts that may exist in authorized sources are retrieved before asking. A delegated child that cannot ask returns the numbered questions to its parent instead of inventing answers; when nobody can answer, the rewrite takes the plainer version or cuts and names the gaps.
- "Write it fresh" applies to AI-composed drafts. The writer's own prose keeps its sentences and is edited in place, and protected text is never recomposed.
- The shorter option is offered only when replying to the writer in conversation, outside the artifact, and never inside a file, PR body, commit message, report body, or required schema. The rewritten text follows the host's required output format.
- Ownership is split across the writing family. Staging, rhythm, closers, the crafted-line budget, fragment stacks, metaphor labels, openers, the shuffle test, and filler transitions live in `stop-slop`; punctuation policy lives in `writing-for-humans`; this skill keeps the workflow and the remaining tells. Synonym cycling merges into the existing stable-terminology entry.
- `tells.md` is not shipped. Its lists are merged into `references/patterns.md` and `stop-slop/references/phrases.md`, deduplicated against existing lists.
- `check.py` writes dash characters as `\u2014` and `\u2013` escapes so the file stays ASCII, and it skips fenced code blocks and inline code spans before counting, because technical prose carries semicolons and dashes in code. The rest of its behavior is unchanged.

Deliberate policy changes:

- Vague attribution is stricter than the source. The source allows cutting or scoping an unnamed authority ("in our tests"); here, cutting it must not leave the bare claim stronger, a scope is used only when the source supplies it, and the existing "Unnamed experts believe..." rule stays.
- Dashes keep the `writing-for-humans` policy (limit them, never reroute into a semicolon or colon reveal) with a rewrite clause for AI-composed prose, rather than the source's unconditional removal.
- A user-supplied writing sample or a selected personal voice overlay outranks the register defaults.
- Warmth is said plainly only where the genre is personal and the draft already carries it; the rewrite does not add warmth the draft lacks.
- "What you must not change" adds that a proposal stays a proposal. The source's own example notes flagged "We will" turning proposals into commitments.

## Draft audit and shorter option (2026-10-17)

An oc-arkive change, not present in either source, adds a focused draft-audit mode for an agent's own draft before delivery, makes the full rewrite's dependency on `stop-slop` explicit (final checks 3 and 4 use its budget and band), and limits the shorter option to a writer's own long-form piece. Ordinary technical answers, reports, docs, plans, and status updates get none unless asked. The upstream shorter-option check is otherwise unchanged.

The local mode selection follows the requested operation and provenance at any length. Audits retain the fact audit and run cadence checks when applicable; weak word hits need context, while a confirmed defect can stand alone. The shorter-option threshold governs presentation after applicable cleanup.

Vocabulary classification is adapted: listed words are examined in context rather than treated as automatic drift, protecting legitimate voice and domain terms. A lone empty hype claim still warrants repair. The earlier cluster test is therefore not a prerequisite for a clear defect.

## Local check.py detectors (2026-11-13)

An oc-arkive change, not present in either source, adds eight counts to `check.py`: trailing exclusions (", not Y." tails, counted in list items and field lines too, with parenthetical text masked), rather-than tails, two-sentence negations ("It is not X. It is Y."), question-word headings, figures, significance crowns, label openers, and intensifiers. Six of them are adapted from a local measurement of 24,000 assistant messages whose detectors were tuned against hand-judged samples: trailing exclusions, two-sentence negations, question-word headings, figures, significance crowns, and the explicit label-opener prefixes. "Seam" is left out of the figures because it is a standard testing term and made up 45% of the measured hits. Rather-than tails and intensifiers are new here and have no such tuning. A trailing-exclusion or rather-than tail never continues onto the next line. The script still only flags, and its header lists the false alarms each new count knowingly keeps.

## Reader-impact correction

The upstream all-facts and all-caveats audit is adapted to select supported, relevant content before rewriting and audit that selection. The `writing-for-humans` boundary rule governs standalone exclusions and evidence gaps; retained claims keep their qualifications, imported instructions keep required wording, examples, exceptions, and force, and explicit faithful-copy and light-edit contracts remain binding. Interview and voice workflows stay in place.

The main rewrite step deliberately adapts the upstream deletion test for doing the reader's work: inferable meaning alone does not make a restatement removable when it carries a definition or connection the intended reader needs. Reader effort matters, while irrelevant or unsupported material remains removable. Zonder Labs' [clarity diagnostics](https://zonderlabs.com/slop) (2026-11-09) informed this distinction; its examples are diagnostic, not evidence of a validated frequency here.
