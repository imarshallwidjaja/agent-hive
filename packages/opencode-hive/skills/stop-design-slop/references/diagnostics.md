# Diagnostics

Read when reviewing, critiquing, or diagnosing a design or generated frontend. This adds vocabulary and checks, not authority. Each entry names a symptom and the question behind it; a pattern is a prompt to look, and the listed exception shows when it is correct.

## Patterns

| Pattern and formal term | What it looks like | Repair direction | Valid when |
|---|---|---|---|
| **Card soup** (excessive common-region grouping) | Every heading and body cluster in its own rounded box; cards inside cards; equal shadow and radius | Group with proximity, alignment, type, dividers, indentation, or a background-plane shift; let one workspace surface hold several typographic sections | The card is a selectable, draggable, or independently actionable record, or must stay grouped as the layout changes |
| **Radius inflation** (indiscriminate shape-token use) | 16 to 24 px rounding on every table, panel, dialog, input, badge, and screenshot | Define a few shape roles; square or lightly round dense and structural objects | A standalone prominent object or a brand-defined geometry |
| **Capsule misuse** (chip and tag misuse) | Pills wrapping eyebrows, subtitles, section labels, statistics, or decorative words | Reserve capsules for status, tags, filters, selections, toggles, short metadata | The capsule marks a compact token-like object |
| **Effect stacking** (ornament without a governing idea) | Gradient, blur, glow, translucent border, shadow, and glass on one component | Remove all effects, settle composition and artifact, then reintroduce one motif the brand supports | The effect carries identity, state, or spatial meaning |
| **Template hero** (template convergence) | Eyebrow pill, centered giant heading, muted subtitle, two buttons, floating screenshot, glow | Lead with the strongest real proof or action; choose alignment from the content | The product's own opening happens to take this shape for a reason |
| **Equal feature row** (artificial equality) | Three identical columns of icon, title, and two lines | Rank the features; show the dominant one with a real artifact; show a sequence if causal, a comparison if alternatives matter | The items really are peers |
| **Icon wallpaper** (decorative iconification) | A generic line icon in a tinted rounded square beside every heading | Delete and see whether comprehension changes; keep icons that aid recognition, state, or action | The icon identifies, navigates, or signals state |
| **KPI strip** (tiles without decision value) | Four statistic tiles on top of every dashboard | Promote only figures that trigger action or state the system's condition; put context beside the chart or table it explains | A recurring decision depends on the figures |
| **Premium minimalism** (showroom UI) | Huge title, enormous margins, one small content block, low-contrast gray, few controls | Measure what must be compared at once; raise density without raising competition; keep large whitespace for major breaks | Reading and persuading surfaces that want room |
| **Weak type hierarchy** | Many barely different text styles; boxes doing the type's work | A small coherent scale with clear jumps | None; fix it |
| **Equal salience** | Same padding, border, heading size, and contrast in every region | Assign dominant, supporting, quiet, and background roles; strip chrome from quiet elements | None; fix it |
| **Mechanical spacing** | One gap value regardless of relationship | Within-group, between-group, and section-transition roles | Uniform data grids where the uniformity is the content |
| **Over-centering** | Centered text and layout throughout an information-heavy screen | Leading alignment for scanning; centering for bounded statements | Focused, bounded statements |
| **Fake product proof** (fictive artifact) | Fabricated chart, dashboard, map, logo strip, feed, or metric | Use authentic output; label sample data; prefer a schematic of real function | The sample is labelled and shows real behavior |
| **Library fingerprint** (component-library fingerprinting) | The page reads as a starter kit before the logo is visible | Change macro layout first, then type, density, shape, surfaces, and states | The library's native look is a requirement |
| **Brand as color** (surface-level theming) | Identity limited to an accent color | Recurring type, geometry, density, imagery, motion, chart language, interaction | None; grayscale should keep some identity |
| **Generic copy** (low information scent) | "Smarter insights, faster." | Product nouns, actions, constraints, outcomes | None |
| **Dead signifiers** | Decoration styled like buttons or chips; links to pages that do not exist | Style only controls as controls; remove or label placeholders | None |

## Checks

Each is a question that exposes a defect. Use the ones that fit the case; none is a gate, and no total score is kept.

- **Task:** is the dominant task obvious and supported?
- **Hierarchy:** are the first, second, and third attention targets clear?
- **Logo swap:** could an unrelated product's logo replace this one without the page feeling wrong? If so, find the structural decisions that belong to this product.
- **Card removal:** with container edges gone, does the grouping collapse? If not, some containers are redundant.
- **Decoration removal:** without gradients, shadows, glows, and exaggerated rounding, does a strong composition remain?
- **Squint:** are the top three targets still evident?
- **Product proof:** is every prominent screenshot, chart, map, figure, or logo strip authentic, representative, and useful?
- **Interaction signifier:** does everything that looks clickable behave clickable, and no dead buttons or links remain?
- **Screenshot versus task:** would a power user accept this after eight hours of work, or is it built for a thumbnail?
- **Working states:** do data views have empty, loading, and error states, and are placeholders labelled as placeholders?
- **Accessibility:** are contrast, focus, targets, text scaling, and order handled? Record contrast from `contrast_check.py` rather than judging by eye.

## Reporting a review

- Name each defect with the terms above, and separate usability problems (task, hierarchy, accessibility, honesty) from distinctiveness problems (specificity, identity). Distinctiveness never outweighs a usability or accessibility defect.
- Say what to remove, merge, promote, quiet, or restructure, and what to keep. Subjective notes such as "make it pop" carry no structure.
- Recommend novelty only when it keeps learnability and task efficiency. Familiar category conventions aid orientation; keep them while differentiating composition, content, and identity.
- A check that was not run is reported as not run.
