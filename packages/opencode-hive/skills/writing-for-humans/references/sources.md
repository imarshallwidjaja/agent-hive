# Source notes

This skill carries the operator-maintained `writing-for-humans` guidance imported into oc-arkive. It borrows useful principles from public writing guidance without claiming conformance to those standards.

- [ASD-STE100](https://asd-ste100.org/about_STE.html): one term for one thing, explicit actor and verb, condition/action/result in procedures. Keep technical vocabulary. A semicolon is disfavored in technical prose, not banned. Do not import the controlled dictionary, hard sentence caps, or aerospace restrictions.
- [Plain language](https://www.iplfederation.org/iso-standard/): relevant, findable, understandable, usable. Shorter is not automatically clearer.
- [Google developer style](https://developers.google.com/style) and [Microsoft style](https://learn.microsoft.com/en-us/style-guide/): named actors, reader needs, consistent terminology. Break a guideline when it makes the content clearer.
- [Diataxis](https://diataxis.fr/): tutorial, how-to, reference, and explanation serve different jobs. It is not a mandatory skeleton for every artifact.
- ISO/IEC/IEEE 29148 and INCOSE requirement-writing principles: distinguish problem, constraint, requirement, and design. Requirements are singular and verifiable.
- RFC 2119 / RFC 8174: normative keywords belong in normative statements.
- [arc42](https://arc42.org/overview), [C4](https://c4model.com/), and [MADR](https://adr.github.io/madr/): explain context, responsibilities, behavior, constraints, and decisions. Keep discarded alternatives where they help the reader decide.
- [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing): a pattern reference, not proof of authorship or a vocabulary blacklist.
- [wait-what](https://github.com/mattpocock/skills/tree/main/skills/productivity/wait-what): re-pitch an explanation with enough context and the project's terms.
- [Zonder Labs, "Why is AI Slop so Frustrating to Read?"](https://zonderlabs.com/slop) (2026-11-09): diagnostic examples of hidden actions, vague wording, and misplaced emphasis; not a validated frequency claim for this guidance.
- Joseph M. Williams, "Style: Lessons in Clarity and Grace": characters as subjects and actions as verbs, the basis of the subject-and-verb rule.
- George D. Gopen and Judith A. Swan, "The Science of Scientific Writing" (American Scientist, 1990): topic and stress positions, the basis for ending a sentence on its new information.
- [Plain language headings](https://digital.gov/guides/plain-language/design/headings): headings that state content the reader looks for, including question headings for the reader's own questions.
- [Anthropic prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1): its description of "mannered prose" informed the literal-wording rule.
- [claudish](https://github.com/cmdcolin/claudish) and [tropes.fyi](https://tropes.fyi/tropes-md): catalogs of recurring model phrasings consulted when choosing which forms to name; no text was copied.
- [anti-slop](https://github.com/miqdadbadjuber/anti-slop), Miqdad Badjuber, MIT: the draft/audit/fix loop, non-invention rule, cluster principle, and preservation of human voice. Its license notice is bundled in this skill.
- [GOV.UK writing guidelines](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/writing-guidelines/) (Open Government Licence v3.0): accessible content, explaining specialist terms at first use, point-first structure, and spelled-out negatives in guards.
- [GOV.UK-style skill](https://gist.github.com/fofr/505e225f9bf5e839d30c12ba6bfa0be2) (no license stated): source of the goal of opening text up without dumbing it down. No other wording was copied.
- [SimpleEnglish](https://github.com/AminBlg/SimpleEnglish) (MIT): conditions and prerequisites before instructions, and warnings before the guarded step. Its [audit](https://github.com/AminBlg/SimpleEnglish/blob/main/evals/results/WHY-USELESS-2026-09-02.md) found that a few reader-visible rules beat many in its tested reply scenarios. This revision adds few rules and no linter. No wording was copied.

Not imported:

- A ban on should, may, and might changes requirement strength. [SimpleEnglish issue 45](https://github.com/AminBlg/SimpleEnglish/issues/45) reports this risk.
- Hard sentence caps: current GOV.UK guidance cites no study for the 25-word figure. The older comprehension figures attributed to the American Press Institute could not be traced to a locatable paper.
- A controlled dictionary would displace necessary domain terms.
- A no-contractions rule would restrict voice beyond guards.
- Front-loading every sentence conflicts with ending a sentence on its new information.
- Latin-abbreviation and link-text rules are deferred.

The preference for preserving relations over shortening sentences draws on these consulted summaries, not verified primary readings:

- Davison and Kantor (1982), as summarized by [TextProject](http://textproject.org/researchers/reading-research-report/qualitative-analyses-of-text-complexity).
- [Armbruster, Osborn and Davison (1985)](https://files.ascd.org/staticfiles/ascd/pdf/journals/ed_lead/el_198504_armbruster.pdf).
- [Banpho (2008)](https://digital.car.chula.ac.th/cgi/viewcontent.cgi?article=1145&context=pasaa).

The local source also cited [danyuchn/asd-ste100-skill](https://github.com/danyuchn/asd-ste100-skill) and [tamdogood/orwell-writing](https://github.com/tamdogood/builder-essential-skills/blob/main/skills/orwell-writing/SKILL.md) as influences. These links are provenance, not prerequisites to fetch on every writing task.
