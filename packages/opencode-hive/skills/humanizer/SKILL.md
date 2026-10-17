---
name: humanizer
description: Use when existing prose reads as AI-written (promotional, vague, over-hedged, or chatbot-like, with AI vocabulary, weasel attribution, actorless passive, mechanical formatting, or chat, placeholder, or citation-markup residue) and must read like a careful person wrote it without changing what it says or commits to; when writing from a writer's own notes, transcript, or rough draft; or when a draft lacks what only the writer knows and the writer should be interviewed; or when your own draft shows a cluster of these tells before you deliver it. Depth skill for writing-for-humans.
---

# Humanizer

Make existing prose read like a specific person wrote it for a specific reader. Keep every fact, commitment, and caveat at the strength the writer gave it, and invent nothing. The patterns here are editing diagnostics, not evidence that a person used AI.

The evaluation behind this workflow (see [provenance](UPSTREAM.md)) reported three findings that shape it:

1. **Readers notice texture**: emphasis with no information in it, uniform rhythm, generic claims, and sentences that do the reader's thinking. Editing fixes those.
2. **Detectors read composition, not wording.** Rewording an AI-composed draft left it reading as AI; pieces built from the writer's own sentences and reasoning read as human. Never promise "undetectable". When the writer needs text that is genuinely theirs, their own material is the strongest input: use the interview or notes route.
3. **Specifics carry the human signal.** Use only specifics that are in the source or that the writer supplies.

## Hard rules

- Do not invent personality, emotion, anecdotes, uncertainty, or factual errors.
- Plain spoken voice from the register defaults below is allowed. Bolted-on personality is not: "Honestly,", "Quick heads-up", "Not bad.", or a joke or rhetorical question the writer didn't make. Readers spot an inserted casual pass as fast as AI polish.
- No fake noise: no planted typos, forced slang, lowercase costume, "lol", or invented "I remember when" stories. Human texture comes from specifics and decisions.
- Preserve factual claims, dates, names, and qualifications exactly. Do not invent a source, actor, purpose, number, or event to make a vague sentence more specific. If an actor, source, or detail is missing, retrieve it when authorized and necessary, ask, or leave the uncertainty explicit.
- Protected text keeps its wording and is never recomposed: exact quotations, titles, proper names, code, public contracts, required schemas, imported agent instructions, and examples discussing a phrase.

Load with `writing-for-humans`. That skill owns drafting, the finish pass, the non-invention rule, and punctuation policy. `stop-slop` owns staging and cadence tells. A full rewrite (the rewrite, interview, and notes modes below) also loads `stop-slop`, whose crafted-line budget and sentence-length band final checks 3 and 4 apply; load it before step 5. A draft audit loads it only when staging or cadence tells appear. This skill owns the rewrite workflow for existing prose and the tells in [patterns](references/patterns.md): vocabulary, inflation and generic claims, register, attribution, hedge placement, doing the reader's work, formatting and labels, and chat residue and placeholders.

## Pick the mode

**Rewrite** (default for supplied text). You are given text; edit it with the full workflow below.

**Draft audit.** Your own draft, or a short draft you are asked to check, before it goes out. The facts are already right; the work is catching a cluster of tells. List the facts and their certainty as in rewrite step 2, then repair vocabulary, register, attribution, hedge placement, formatting, and chat residue in place, keeping your own sentences, structure, commands, and code. Run final checks 1, 2, and 5. There is no interview, no fresh rewrite, no shorter option, and no change notes unless asked. Move to a full rewrite only when the draft is built on formula throughout.

**Interview.** Use it when asked, or when the writer can answer and the draft fails this test: *could anyone with the same one-line request have written it?* Then it is missing what only the writer knows (the real example, the number behind "significantly", what went wrong, what they actually think), and no edit supplies that. This is the usual case for posts, newsletters, essays, bios, talk abstracts, pitch emails, landing pages, job posts, and launch stories. Operational text whose facts are all present, such as a chat update, support answer, release note, policy, or doc, is rewritten without asking.

**Notes route.** The writer supplies notes, a transcript, or a rough draft they wrote themselves. That material is the main source, not background for an AI draft.

## Interview

When the missing facts may already exist in authorized sources (the repository, the conversation, supplied files), retrieve them first. Then ask one round of at most 5 questions through the host's question mechanism, and write.

- Each question fills a gap a reader would feel: the real example, the number, the name, what happened, what the writer thinks. Quote the line the answer will replace.
- Ask for narration, not a form. "In two or three sentences, the way you'd say it out loud: what happened the first time a customer used it?" beats "Please provide a customer example."
- Make it cheap: each question answerable in under a minute, and any can be skipped.
- Ask about tone, audience, or format only when you cannot infer it.

A delegated child that cannot ask returns the numbered questions, each quoting the line it would replace, to its parent in its terminal report, and does not invent answers. When nobody can answer, write the plainer version or cut, and name the gaps.

Compose from their words:

- **Their sentences are the material.** Keep their phrasing, order, and odd word choices; edit only for clarity, grammar, and length. Rewording keeps the writer's fingerprint; recomposing replaces it with yours.
- **The AI draft is a checklist of points, not the skeleton.** Its sentence skeletons carry its signature. Where the writer and the draft disagree, the writer wins.
- **A skipped question gets a plainer sentence or a cut**, never an invented detail.

## Notes route

Notes already carry the writer's reasoning: their claims, the order they make them in, their "because" and "so", their examples.

- **Their structure is the skeleton.** If they argue A because B, so C, the piece goes A, B, C.
- **Their sentences stay whole where possible.** Edit only for clarity, grammar, and length.
- **An AI draft, if there is one, is a checklist.** It may add only a point the notes confirm, placed where it fits their argument. Borrow none of its skeleton, transitions, or framing.
- **The notes are the source for the fact audit.** Every fact, commitment, and caveat in them survives. A fact found only in the AI draft is optional: keep it where it supports the writer's argument and is accurate. Add nothing that is in neither.
- **Ask only what the notes leave open.** If they cover the point, the example, and what the reader should do, write without asking.

## Rewrite

1. **Read for the job.** Genre, reader, and what the reader must know or do afterwards. Decide where the point goes and commit: answer-first for replies, emails, chat, and announcements; evidence-first for explanations and arguments. A text that states its point in line 1 and builds to it again at the end has done both; cut one.
2. **List the facts with their certainty.** Every number, name, date, claim, commitment, caveat, link, and call to action, with the qualifier attached to each ("could", "typically", "about", "helped", "the remaining piece"). This list survives intact.
3. **Write it fresh when the draft is AI-composed.** Put the draft aside and write from the step 2 list the way this writer would write it for this reader: their speaker, their register, plain spoken sentences in normal word order. A patched AI draft still reads like one. Reuse the draft's exact words for names, the reader's own terms, and the wording of commitments and conditions. Every claim appears at the same strength, no stronger and no weaker. When the text is the writer's own prose, keep their sentences and edit in place, as the notes route does. Protected text is never recomposed.
4. **Keep the claim, drop the formula.** A stock line (a generic moral, a value pitch, a gratitude formula, a vague benefit) still carries something the writer meant. Say that thing once, plainly, in their voice: "Those visits helped us get here" becomes "We couldn't have got here without your visits." Cut a stock line only when it repeats something already said.
5. **Cut and fix, strongest first.** Delete filler, restatement, and hype, then fix tells in this order: staging, doing the reader's work, inflation, hedges, rhythm, punctuation and formatting, chat residue. Staging and rhythm tells are diagnosed with `stop-slop`, which a full rewrite has loaded. The rest are in [patterns](references/patterns.md). Cutting must not leave the text clipped: an unpadded draft comes out about as long as it went in. Voice, concrete detail, connective words, and the warmth a genre needs are not padding. Let sentences breathe: use the small words people use when they talk (so, and, but, just, then), and keep two ideas in two clauses rather than one clipped one.
6. **Run the final checks**, including the fact audit against the original.

### What you must not change

- **Certainty.** Keep the level, not necessarily the words. "Could help reduce" is not "cuts", and "typically" is not "always". One qualifier is enough to carry it: "can help spot changes before noticeable symptoms appear" can become "can catch changes before you'd notice symptoms".
- **Commitment.** A proposal stays a proposal; "we propose" or "we plan to" does not become "we will".
- **Reasons and conditions.** Add no explanation, cause, eligibility rule, or benefit the writer didn't state, even an obvious one.
- **Vague into vaguer.** When a claim is vague and nothing specific is available, keep the writer's words or cut the sentence whole. Never swap in a vaguer phrase ("Premium adds more to the app").
- **Who does what.** Keep the actor: "we'll email you" stays with "we" unless the writer is clearly one person.
- **Attribution strength.** Name who when the source does. Cutting a vague attribution must not leave the bare claim stronger, and a claim is scoped ("in our tests") only with a scope the source supplies.

## Sound like a person

Removing tells is half the job. Plain is not flat. Write the way a competent person in this role writes this genre for this reader, as if saying it across a table:

- **Contractions by default** (it's, we're, you'll, don't). Drop them only in formal documents: policies, contracts, formal PRDs.
- **The speaker talks as themselves.** Keep the draft's speaker ("we" stays "we", "I" stays "I"), speaking in the first person instead of described from outside: "The team will review" becomes "We'll review" when the team is writing.
- **"You"** wherever the genre addresses a reader.
- **Everyday verbs**: use, help, start, need, fix, send. Not utilize, leverage, facilitate, ensure, enable.
- **Ownership**: "I'll send the tracking number", not "Tracking details will be provided", when the writer is the one sending it.
- **Warmth where the genre is personal and the draft carries it.** A thank-you, an apology, an invitation, a note to customers: say the warm thing plainly, once. Do not add warmth the draft lacks.
- **Match the room.** Casual where the context is casual (chat, a community newsletter); plain and professional where it is formal (PRD, memo, policy). Formal still means plain verbs and complete, natural sentences.
- **Conversational, not colloquial.** At most one idiom or slangy phrase per paragraph; a cluster of them reads as a humanizing pass.

A user-supplied writing sample outranks these defaults, and so does a selected personal voice overlay. When there is a sample, read it first and note sentence lengths, vocabulary, paragraph openings, punctuation, and recurring phrases. Match those habits rather than only deleting patterns; keep casual words casual and deliberate quirks intact.

## Keep what is already human

- Specific details, unusual word choices, opinions, asides, humor, doubt, mixed feelings, dated references, and varied sentence length. These are what you are protecting.
- The reader's working vocabulary: product names and technical terms they would type or search for. Technical words such as "causal" or "empirical" keep their technical meaning. Cut jargon that performs expertise.
- Genre conventions. A release note can be a list, a PRD can have headers, a support reply can be warm, a letter can have a sign-off.

Calibrate before flagging. A clean human writer hits several patterns without a model involved. Perfect grammar, mixed registers, dryness, formal vocabulary, one transition word, curly quotes, one em dash, or one short emphatic sentence are not reliable tells on their own. Unsourced claims alone are not a tell either: most writing is unsourced. Distinguish an unsupported attribution in the task's evidence from a demand to cite every ordinary sentence.

## Genre notes

- **Chat, DM, thread reply:** the answer or the ask goes first. Cut background the reader already has. One to four sentences is often enough.
- **Cold email:** one specific reason for writing to this person, from the source, and one ask. No "I hope this finds you well".
- **Social post:** line 1 is the most concrete thing in the post. No engagement-bait closer, no hashtag pile.
- **Release note or product update:** what changed, who it is for, what to do, with the numbers the source gives. No "We're thrilled to announce".
- **Landing page:** the concrete outcome and how it happens. Cut empower, unlock, seamless, elevate.
- **Docs, PRDs, policies:** plain and precise; keep the structure; hedge only real uncertainty.
- **PR titles, descriptions, and review comments** keep the artifact requirements owned by `pr-writing`.

## Final checks

1. **Fact audit.** Recomposing is where facts slip, so check sentence by sentence against the original, or against the writer's notes on the notes route. Every number, name, date, price, quote, condition, commitment, benefit, and caveat is present with the same value and certainty, and the speaker is unchanged. Watch the strength words: "can help" must not become "will", "might" must not become "would", "little" must not become "no", a proposal must not become a promise, and nothing gains "only", "every", "always", or "guaranteed". Leave implied what the draft left implied. Then check the other direction: the rewrite adds no fact, example, anecdote, reason, benefit, opinion, or detail the writer did not give. Plain voice is allowed; new content is not.
2. **Mechanical sweep.** Search the final text for em dashes, spaced en dashes, semicolons, and the word lists in [patterns](references/patterns.md) and `stop-slop`; eyes miss them. When code execution is available, run `python3 <base directory>/check.py -` with the text on stdin, or `python3 <base directory>/check.py <file>`, where the base directory is this skill's. Stdin writes no temporary file, so prefer it in read-only roles. Without code execution, search manually. A hit is a prompt to look, not a verdict.
3. **Crafted lines:** one or none. `stop-slop` owns the budget.
4. **Rhythm:** the sentence-length band and the openers, as `stop-slop` describes.
5. **Read it aloud as the writer.** Anything they would not say gets plainer.
6. **Length.** Shorter than a padded input; about the same as an unpadded one. Never cut a fact, the voice, or the warmth the genre needs to get there.
7. **Shorter option.** Leave the final text as it is. Cover each paragraph in turn and read the rest: would the reader miss a fact, a commitment, a decision, or the writer's point? A paragraph that fails is a cut candidate. Common candidates: an opening that states the point in general terms before the piece shows it; lines any similar piece would have (a general moral, a "more to do" close, a second thank-you); a part that says almost the same as another (keep the stronger); a second argument that could stand on its own. Never offer to cut the proof or the stakes: the examples, numbers, commitments, or a disclosure that makes the reader trust the piece. Count the candidates' words rather than guessing. When they add up to about a quarter of the text or more, offer the shorter option; a third or half is fine when those parts don't earn their place. Otherwise the answer is "none, it's already tight." Skip this check for pieces under about 100 words, for ordinary technical answers, reports, docs, plans, and status updates, and in a draft audit.

## What to return

Return the rewritten text in the host's required output format. In interview mode, the numbered questions come first and the text follows the answers.

When the writer asked you to rewrite or tighten their own long-form piece (post, essay, newsletter, email, announcement, bio, pitch) of over about 100 words and you reply in conversation, follow the text with one line starting "Shorter option:": the cuts, roughly how much shorter the piece gets, and any fact a cut would lose and where it could move, or "none, it's already tight." That line sits outside the artifact and never goes inside a file, PR body, commit message, report body, or required schema, including when the artifact is itself a report or another document. The cuts are never applied unasked. A delegated rewrite gives the line to its parent in the notes of its terminal report, separate from the deliverable. Write the shorter version in full only when the writer asks. Ordinary technical answers, reports, docs, plans, and status updates get no shorter option unless the writer asks for one.

Add notes on what changed only when asked: up to five bullets, plus any spot where a real specific would help.
