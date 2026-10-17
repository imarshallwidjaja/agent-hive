# Refinement and redesign

Read when changing an existing interface. This adds method, not authority. The refinement and redesign definitions and steps adapt `impeccable` (Apache 2.0) with changes; see [UPSTREAM](../UPSTREAM.md).

## Choose which one the request is

- **Refinement preserves.** The incumbent identity, behavior, copy, and everything outside the requested scope stay. Words like polish, tighten, fix, align, quiet down, or simplify point here.
- **Redesign replaces.** Product truth, content, function, native affordances, and constraints stay. The old look becomes evidence about what to replace, and a new visual world takes its place. Words like redesign, new direction, or "start over visually" point here.

Take the smaller reading when the request is ambiguous, or ask one question if the difference changes the work. A redesign does not split the difference with polish on the look being retired.

## Refine

1. **Read the incumbent first.** Inspect the target and at least one representative source of its visual truth: tokens, theme, CSS, a component, or an asset. A missing design document does not make the project new; the code and assets are the evidence.
2. **Diagnose with the names in [diagnostics](diagnostics.md)** and fix the named defect, not the whole screen.
3. **Take the smallest structural change** that resolves it, in this order: hierarchy and order, grouping, type, spacing, then surfaces and effects. Reuse the project's tokens and components.
4. **Keep copy factual.** Ask before replacing factual copy or adding a claim, a figure, or a customer reference.
5. **Check the result** at the sizes and states the product ships: working states, both themes where present, contrast computed with `contrast_check.py`, and a keyboard pass through the changed region.

Removing slop is not the same as designing. A result that is merely flat, clean, and gray has also failed, so supply the missing idea from the product's task and objects.

## Redesign

1. Keep the product's task, content, function, and constraints. Keep native or platform affordances people rely on.
2. Treat the incumbent look as an anti-reference and choose a replacement world from [composition](composition.md): the governing idea, the primary object, the type, density, and shape roles.
3. Replace the visual language as a whole, so tokens, components, and copy tone move together.
4. A pinned brand, font, palette, or material in the brief wins over this guidance.

## In a read-only role

Diagnose and recommend. Describe the structural change in terms an editor can apply, and leave the edit to the role that owns the artifact.
