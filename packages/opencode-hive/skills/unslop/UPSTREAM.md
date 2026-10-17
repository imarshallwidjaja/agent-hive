# Provenance

Imported from the operator-maintained `~/.agents/skills/writing-policy/SKILL.md` on 2026-10-01 at the operator's request. The local source was not a Git checkout; no upstream revision is asserted.

oc-arkive now maintains this copy. The baseline and routing/propagation split are retained. Local adaptations make role/output boundaries explicit, add `pr-writing` and `writing-for-agents` ownership, and protect source wording from style cleanup. This skill does not select a personal voice automatically.

A later oc-arkive policy change extends the delegation rule: prose handoffs carry the operator's reader outcome, give boundaries as facts, quote only wording that must appear verbatim, and check requested sections against the reader outcome before dispatch. Prose reviews receive the same writing contract and check the reader outcome within the reviewer role's finding bar. This wording is not from the imported source.

## Rename to `unslop`

The skill that was `writing-policy` is now `unslop`, and `writing-policy` no longer ships. There is no alias: a request for `writing-policy` finds nothing in the packaged set, and the operator's own `~/.agents/skills/writing-policy/` is outside the package and unchanged. Active package pointers, tests, and documentation name `unslop`. The CHANGELOG, `docs/releases/`, and the provenance of the other writing skills keep `writing-policy` where they describe a past release or import.

The delegation section is the former delegation rule carried over word for word, apart from the ownership chain, which now names `unslop` and adds the new rows below. The route table and its wording are rewritten around the same selection principle.

## What changed in oc-arkive after the rename

- The skill is the shared philosophy and router for prose, messaging, and visual work, and every Hive role is configured to load it. The system prompt no longer carries a separate writing trigger. Depth stays conditional on the route table.
- The baseline gains concrete technical nouns, one reading for pronouns and modifiers, enough words against over-compression, and carrying the source's taste, scope, caveats, claims, actors, voice, and instruction force through unchanged.
- Routing is stated as a load obligation, and the table adds a row for an agent's own draft (a `humanizer` draft audit), for agent-consumed instructions, and for interfaces (`stop-design-slop`).
- Review and cleanup are named as in scope, with the role boundary stated: the skill never widens a role, and a read-only reviewer describes the repair instead of making it.

## pstack consulted

Three skills from [cursor/plugins](https://github.com/cursor/plugins) were read for this change: `pstack/skills/technical-writing/SKILL.md`, `pstack/skills/unslop/SKILL.md`, and `pstack/skills/teach/SKILL.md` (current `main` fetched 2026-10-17; no commit is asserted). Their ideas informed the baseline: real symbol names over synonyms, pronoun and modifier ambiguity, keeping the small words that show structure, and stating a skill dependency as an explicit load. No text was copied, so no license file is bundled. The name `unslop` and the idea of one writing skill that every role knows come from the pstack skill of that name.

Not adopted: the universal sentence-length caps, the ban on dashes and parentheses, the controlled-vocabulary rules, mandatory history and diagrams for explanations, "have opinions" and "let some mess in" as instructions, and an unconditional "must always apply" for every turn. Depth loading here stays conditional, and short replies stay light.
