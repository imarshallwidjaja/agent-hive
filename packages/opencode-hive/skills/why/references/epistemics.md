# Epistemics

How to reason about confidence when evidence is historical, fragmentary, and sometimes contradictory, and how to communicate it without flattening it into false certainty.

Code doesn't carry its own motivation. You can read what code does. You can't read *why it exists*. That lives in commits, PRs, tickets, docs, and conversations, all incomplete, biased, and sometimes missing entirely. Pretending otherwise produces confident-sounding guesses that mislead the user.

## Confidence tiers

Every historical claim in the answer sits in one of these tiers. The tier determines how it is phrased.

### Direct

An explicit, textual citation that answers the question. Not "the code does X so the author must have wanted X." Something an author actually *wrote* that says why.

Examples include a PR saying it fixes pagination for users with more than 1000 items, a ticket stating a customer's requirement, or a comment explaining an upstream API limit.

State the rationale with the citation and its author/date context when available. A direct statement is evidence of the recorded rationale, not proof that its author was right or that the same constraint still holds.

### Supported

Multiple pieces of indirect evidence converge. No single source states it explicitly, but the pattern across sources makes it likely.

Phrasing: "The evidence points strongly to X: [the specific pieces]." Cite multiple sources and what each contributes.

### Inferred

A reasonable reading of the context, but nothing explicitly supports it. The reader should understand this is *your interpretation*, not a fact from the record.

Phrasing: "It appears", "likely", "suggests", "is consistent with", "one reading is". Make the inference chain explicit: "Given A and B, C seems likely because D." Do not call this tier well-supported merely to make the account more decisive.

### Speculative

A plausible hypothesis, but the evidence is thin and other explanations fit equally well. Presenting these is valuable, but mark them clearly as guesses.

Phrasing: "One possibility is X, but we have no direct evidence." Present competing explanations when the record cannot distinguish them.

### Unknown

You looked and couldn't find out. A valid and important outcome. Document it.

"We searched X, Y, and Z and found no evidence of why" is more useful than "we couldn't find out." State actual queries and coverage. If a source was unavailable or not searched, say that separately rather than implying it was empty.

## Avoid rationalization

Code that "makes sense" today may have been written for reasons that no longer apply, or that were wrong when they were written. Don't retrofit a clean rationale onto messy history.

Resist the urge to:

- Assume the author did the "right" thing and work backward to justify it.
- Assume a consistent pattern across the codebase was intentional when it might be copy-paste.
- Turn an absence of evidence into evidence of absence.

The user's guess is a prompt for investigation, not a conclusion to validate.

## Contradictions and gaps

If two sources disagree, surface both with their citations. The ticket's customer requirement and the PR's cleanup rationale may both matter; do not pick the one that fits a tidier narrative.

An honest "we don't know" is one of the most valuable outputs this skill can produce. The reader can decide whether to ask an original author or stop pursuing the question. Failing to mark a gap and filling it with a confident guess actively harms the user.

Name the question, what sources and queries were actually searched, and what was missing. Do not manufacture a gap when the evidence answers the requested question.

## Calibration

Before returning, check citations, phrasing, contradictions, and gaps. "Because", "was designed to", and "the team decided" imply evidence of rationale. Keep the citation adjacent. Never cite code as evidence for its own intent. Prose cleanup must not remove the uncertainty that distinguishes inference from a recorded fact.

Useful inference language includes "appears to", "seems to", "likely", "suggests", "is consistent with", "one reading is", "plausibly", "may have been", and "the evidence points toward". Pick the phrase that matches the evidence, not a stronger one for cleaner prose.

Avoid "obviously", "clearly", "of course", and dismissive "just" when they replace an explanation. "I think" and "I believe" do not establish historical support; describe the inference instead. If no gaps are mentioned, check whether the record is unusually complete or uncertainty was lost. Do not invent a gap solely to fill a section.
