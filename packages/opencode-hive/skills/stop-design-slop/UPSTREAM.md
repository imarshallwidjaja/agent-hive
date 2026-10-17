# Provenance

Imported from the operator-maintained `~/.agents/skills/stop-design-slop/` (its frontmatter reads version 1.0.0) at the operator's explicit request. The local source was not a Git checkout and had no license file; no upstream revision is asserted and no license is claimed for the whole local copy. The operator asked for the visual guidance to become one oc-arkive-owned foundation, and oc-arkive maintains it from here.

## What was imported

The imported scope is `SKILL.md`, the review rubric, the pattern catalog, the terminology table, the source index, and `scripts/contrast_check.py`. The source's research-basis note is not shipped; its evidence caveats survive as the interpretation notes in `references/source-index.md`.

Retained from the source: the question behind each visual decision, the working order of constraints, a governing idea, hierarchy before containers, and visual weight; components as primitives; the anti-pattern rules, now a diagnostic table with the valid exception beside each; the review tests, now questions rather than a checklist; the guidance on authentic product artifacts, labelled sample data, working states, and non-fabricated proof; and the rule that contrast is computed, not judged by eye.

## Notices

`scripts/contrast_check.py` and the honesty-and-function checks (working states, placeholders, signifiers, both themes) come from [miqdadbadjuber/anti-slop](https://github.com/miqdadbadjuber/anti-slop) (Miqdad Badjuber, MIT), as the source skill's own notes stated. The notice in `LICENSE.antislop` was compared with the upstream repository's `LICENSE` file when this skill was imported and is identical. The script runs unchanged from the source copy, and its self-test passes.

Portions of `SKILL.md` and `references/refinement.md` adapt text from `impeccable` ([pbakaus/impeccable](https://github.com/pbakaus/impeccable), Copyright 2025 Paul Bakaus, Apache License 2.0). The adapted portions are the surface-mode descriptions in `SKILL.md` (the sentence "Brand lives in precise details." is verbatim), the rule that the brief wins over a pattern warning, and the refinement and redesign definitions and steps in `references/refinement.md`. `LICENSE.impeccable` carries the upstream license text unchanged. The copy matches upstream `LICENSE` at tag `skill-v4.1.1` and on `main` byte for byte, and the notice applies only to those adapted portions. `references/composition.md` and `references/diagnostics.md` share no six-word sequence with the local `impeccable` files, so no `impeccable` licensing is claimed for them.

The local source is `~/.config/opencode/skills/impeccable/SKILL.md`, which reports version 4.1.1 and `license: Apache 2.0` in its frontmatter and ships without a license file. Upstream tag `skill-v4.1.1` resolves to commit `5a149f3fdb1b5793f10567233b1dcab98fc305fd`, and its `skill/SKILL.src.md` has the same text as the local file for the mode and "How to design" passages above. The local file is a built `SKILL.md`, so this does not show that it is byte-identical to that tag; the tag is cited as the authoritative upstream, not as the exact import source.

Upstream's `NOTICE.md` credits ehmo's `platform-design-skills` (MIT) for upstream's `ios.md` and `android.md` references. Nothing from those files is adapted here, so that notice is not carried, as Apache 2.0 section 4(d) allows for notices that do not pertain.

## Changes from the source

- One skill with three scoped references (composition, diagnostics, refinement) replaces the single long file plus separate rubric, catalog, and terminology files. No second visual skill exists.
- The 0 to 2 scoring rubric, the 18 of 24 release gate, the "answer all of these" review requirement, and the instruction to run a static detector are not carried over. Checks are diagnostic questions; a recorded check names what was inspected or computed.
- The source's closing rule to add a governing idea, one focal point per screen, and one deliberate accent is narrowed to supplying a governing idea. A fixed accent count is not adopted.
- A mode for the surface (Operate, Read, Persuade), a distinction between refinement that preserves the incumbent and redesign that replaces it, and "the brief wins over a pattern warning" are added. This wording is adapted from the operator-maintained `impeccable` skill (see Notices), reworded and shortened, so `SKILL.md` and `references/refinement.md` are modified versions of those passages. No script, command table, setup procedure, document system, absolute ban, or aesthetic default was taken from it.
- Motion is stated as a question (what does it communicate, how often does it happen) rather than a fixed intensity. Other local design skills (`design-taste-frontend`, `redesign-existing-projects`, `emil-design-eng`, `animate`, `ui-mockups`) were read for comparison and contributed no text.
- The source's SVG diagrams, six HTML examples, and `audit_ui.py` regex detector are not shipped: nothing here needs them, and a regex detector would turn diagnostics into verdicts.
- Honest scoping is explicit: the role boundary (a read-only reviewer diagnoses and describes the change; an editing role applies it), real versus demo content, accessibility truth, and density that follows the task.
- `references/source-index.md` keeps the source's citations as the source listed them, with a note that they were not re-fetched.
