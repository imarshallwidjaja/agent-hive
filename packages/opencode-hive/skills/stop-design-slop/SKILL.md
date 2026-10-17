---
name: stop-design-slop
description: Use when designing, generating, reviewing, refining, or redesigning product interfaces, dashboards, landing pages, data applications, design systems, mockups, or frontend code, or when a UI is described as premium, modern, clean, minimal, or SaaS without stronger product-specific direction.
---

# Stop Design Slop

Design from the product's task, information, domain objects, and identity, not from the statistical average of modern SaaS interfaces. The aim is specificity with usability: a structure that could only have come from this product, still legible, accessible, and effective at its job. Novelty is not the aim.

Load with `unslop`, which holds the shared philosophy and the prose side of the same work (copy, labels, captions). This skill carries the visual depth.

## The question

For each prominent visual decision, be able to say why it is like this. Acceptable reasons are hierarchy or salience, grouping or boundary, interaction or state, reading, scanning, or comparison, product identity, accessibility, or a deliberate compositional idea. "It looks modern", "it feels premium", "that is standard SaaS", and "the component library does this" explain nothing.

Cards, gradients, pills, rounding, glass, whitespace, and component libraries are tools. Each stays wherever its function can be explained.

## Pick the mode

The mode names what success looks like for the person using this surface. Choose it from the surface requested, not from the product: a tool's landing page is Persuade, and its documentation is Read.

- **Operate:** the person completes a task in an app, dashboard, editor, console, or settings screen. Scanning, consistency, and the real working conditions outrank expression, and density follows the task. Brand lives in precise details.
- **Read:** the person understands something in docs, articles, guides, or a changelog. Structure for comprehension first, then make the reading pleasant.
- **Persuade:** the person decides and acts on a landing page, campaign, or pricing page. The page earns attention with the product's real proof or action.

When the artifact is the work itself, such as a portfolio or a gallery, let it lead and let the interface recede.

## Pick the reference

Read the reference that matches the case before acting on it.

| Case | Read |
|---|---|
| Designing a new surface, or choosing a layout, type, spacing, shape, or surface treatment | [composition](references/composition.md) |
| Reviewing, critiquing, or diagnosing a design or a piece of generated frontend | [diagnostics](references/diagnostics.md) |
| Changing an existing interface: polish, restyle, simplify, or redesign | [refinement](references/refinement.md) |

[Source index](references/source-index.md) lists where the imported guidance came from. The mode descriptions and the rule that the brief wins adapt `impeccable` (Apache 2.0) with changes; see [UPSTREAM](UPSTREAM.md).

## Always true

- **Accessibility.** Keep readable contrast, visible focus, usable targets, text scaling, and a logical reading and focus order. Distinctiveness never trades them away. Compute a color pair with `python3 <base directory>/scripts/contrast_check.py <fg> <bg>` (see [contrast_check.py](scripts/contrast_check.py)), where the base directory is this skill's, and check the worst spot when text sits over an image or gradient. Without code execution, report the contrast as unchecked.
- **Real content.** Use the product's own artifacts, copy, and data. Illustrative content is labelled sample or demo and shows a real product behavior. With no real data, show nothing rather than a plausible number, chart, customer logo, or activity feed.
- **Working states.** Empty, loading, error, disabled, focus, and hover states exist where the product has them. When a theme toggle ships, both themes work. What looks clickable behaves clickable, and decoration does not imitate controls.
- **Density follows the task.** Monitoring, comparison, and investigation often want dense, well-structured surfaces. Reading and persuading want room. Whitespace and sparse content are not quality by themselves.
- **The brief wins.** Honor a pinned brand, font, palette, era, material, or component system, even when it resembles a pattern named in the references.
- **Components supply behavior.** Keep the accessibility and interaction a library provides. Composition, type, density, shape, and surfaces are the product's own decisions.
- **Motion meets the same question.** It communicates a state change, hierarchy, or continuity. Its intensity follows how often it happens and what it says, not a fixed setting.

## Role boundary

This skill does not change what a role may do. A read-only reviewer diagnoses with the vocabulary in the references and describes the structural change; a role that edits applies it. The checks in the references are prompts for judgment, not pass or fail gates, and a recorded check names what was inspected or computed.
