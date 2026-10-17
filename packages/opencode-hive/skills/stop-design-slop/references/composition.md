# Composition

Read when designing a new surface or choosing layout, type, spacing, shape, or surface treatment. This adds method, not authority.

## 1. Establish the product's constraints before styling

Before proposing a layout, name:

- **Dominant task:** what the person is here to accomplish.
- **Primary object:** the record, dataset, document, map, queue, timeline, graph, or artifact that should govern the screen.
- **Decision hierarchy:** what must be seen first, second, and third.
- **Density need:** reading, comparison, monitoring, investigation, operation, or persuasion.
- **Real artifacts:** the screenshots, outputs, media, or data the product can show.
- **Brand character:** the structural traits that recur, such as typography, geometry, density, imagery, iconography, motion, chart language, interaction patterns, and tone, not only color.

When these are unknown, produce a restrained wireframe and say what is missing. Invented decorative specificity misleads more than an honest gap.

## 2. Choose one governing idea

A major screen has a discernible idea that the layout follows. Examples: the map is the workspace; chronology structures the investigation; evidence behaves like a case file; the graph is also the navigation; the primary record fills the canvas and controls live in a rail; the document is the interface; one authentic product artifact carries the page.

A pile of attractive effects is not an idea. If removing the gradient, shadow, glow, rounding, and animation collapses the composition, the structure needs the idea first.

## 3. Build hierarchy before containers

Work in this order, stopping when the relationship is already clear:

1. Reading order and alignment.
2. Scale and type hierarchy.
3. Proximity and whitespace.
4. Columns, grid, and relative width.
5. Contrast and emphasis.
6. Dividers or background-plane changes.
7. Semantic containers, only where needed.

Proximity and common region are both grouping cues, and a border is the stronger one. Use it when the boundary means something: an independently actionable or selectable object, a bounded interaction region, a materially different context or state, or a collection item whose edge aids scanning.

## 4. Assign visual weight

Classify the major elements as **dominant** (the primary object or action), **supporting** (context needed to work with it), **quiet** (metadata, secondary controls), or **background** (persistent chrome). Make those layers visibly different. When every region carries a border, heading, icon, shadow, and equal padding, attention has no path. Squinting at the screen should still show the first three targets.

## 5. Type, spacing, and shape

- **Type** carries hierarchy before boxes do. Use a small coherent system with clear jumps in importance, and control size, weight, line height, line length, and contrast.
- **Spacing** tokens are a vocabulary. Composition decides which token fits: tighter inside a conceptual group, larger between groups and at major transitions. Dense work surfaces may stay dense.
- **Shape** follows object semantics and scale. Define two to four shape roles, such as dense surface, control, prominent surface, and capsule. Dense tables and analytical surfaces can be square or lightly rounded. Capsules suit compact token-like objects: status, tag, filter, selection, toggle.
- **Alignment** follows the content. Centering suits focused, bounded statements; scan-heavy or operational content usually reads better against a leading edge.
- **Symmetry** is a choice. Unequal information often wants unequal mass and scale: a dominant canvas with a narrow rail, an oversized artifact with a compact explanation.

## 6. Surfaces and effects

Use a strong effect when it carries identity, hierarchy, state, or spatial meaning, and prefer one coherent motif to several simultaneous embellishments. Translucency earns its place when seeing the layer below helps orientation. Keep legibility and non-text contrast intact; blur does not substitute for hierarchy. A dark navy backdrop with violet and cyan glow and glass panels is a default look, appropriate only when the brand leads there.

## 7. Components as primitives

When using shadcn, Radix, Material, Carbon, Bootstrap, Tailwind UI, or similar, keep their accessibility and interaction behavior. Set composition, typography, density, proportions, shape, borders, surfaces, and states to the product. Skip the library's demo-page arrangements. If a knowledgeable reviewer can name the starter kit from the page, find which of macro layout, default type, radius, proportions, surfaces, or icons gives it away, and change that, unless the library's native look is the requirement.

## 8. Openings and proof

For a marketing or product page, choose the opening that reflects the product: a live map, a real artifact, a search or action field, a dense operational view, an image, a result, a comparison, or one strong sentence. Rank features before laying them out; equal columns assert equal importance. Use annotated product views, sequences, comparisons, or compact lists when they match the information.

Icons stay where they aid recognition, navigation, state, or action. KPI tiles earn top-level salience when a decision depends on the figure, its change matters, or it states system state.

## 9. Copy

Use concrete product nouns, actions, constraints, and outcomes. Specific copy gives the layout specific things to do. Phrases like "unlock the power of", "seamlessly", or "everything you need" fit any product and so describe none. For prose beyond interface copy, follow `unslop`.
