# Model the domain

Encode the real domain in a data structure instead of scattering it across conditionals.

Scattered booleans, repeated shape assumptions, and branching spread across files are accidental complexity. A structure that matches the domain makes invalid states unrepresentable and deletes branches. Choosing it at write time is cheap. Recovering it later reads as a refactor and gets deferred.

Reach for structures like these:

- A state machine instead of scattered booleans, phases, or lifecycle checks.
- A typed object/model instead of loose parameters or repeated shape assumptions.
- A map, registry, lookup table, or discriminated union instead of branching spread across files.
- A reducer or command/event model instead of ad hoc state mutations.
- A module organized around one body of domain knowledge instead of a sequence such as load, validate, transform, and save. Execution order is not ownership.
- A small module boundary that gathers repeated behavior, ownership, or invariants.
- A queue, cache, index, graph/tree, or normalized collection where the data access pattern calls for it.
- Any other structure that fits. When none fits, work out what the code must never allow and how the data gets read, then find the structure that encodes exactly that.

Do not force an abstraction. Prefer boring code if the current shape is already clear, local, and unlikely to grow. Be skeptical of an abstraction that adds indirection without removing branches, duplicated rules, invalid states, or lifecycle risk.

The sign that you skipped this is a new feature that grows an existing if/else chain by one more branch, or a second boolean that must stay in sync with the first. Temporal decomposition is another sign. Phase-named modules repeat the same domain rules across steps.

## Reader load

Track two axes: layers the reader must trace and hidden or mutable state they must hold. A flat file full of globals can be as hard to reason about as an adapter stack.

- Make adjacent layers change the abstraction. A layer that repeats the same methods and arguments adds reader load without compression.
- Demand interface compression. Prefer boundaries that hide meaningful decisions.
- Shrink state scope: prefer pure functions, locals over fields, fields over module state, and module state over globals. Derive instead of sync.
- Name the invariant at the boundary, not in every consumer, so the reader learns it once.
- Before adding a layer or a piece of state, ask: does this reduce reader load somewhere else by at least as much?

Ask "where does X come from?" and "what can change X?" Preserve a one-caller boundary that owns real knowledge or policy. Caller count, file length, and call depth alone are not simplification criteria.

## Material alternatives

For a novel boundary choice with multiple viable shapes, compare concrete caller examples and invariants. A second flavor of the first shape does not count. Use a sketch or authorized prototype to settle observable facts; ask the operator for a genuine product or preference decision.

Skip competing designs for mechanical implementation, clear-target bug fixes/refactors, or constraints that dictate one viable approach. A redesign question can expose a poor fit, but does not authorize a rewrite beyond the task.

Question the threading. If a task asks you to pass a new signal through types, schemas, pipelines, or similar layers, look for a more direct path before extending each layer. Types and data models should converge. Three similar statements still beat a premature abstraction.
