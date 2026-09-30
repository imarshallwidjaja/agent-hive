# Boundaries and types

Place validation, type narrowing, and error handling at system boundaries. Scattered validation is noisy, redundant, and gives a false sense of safety. Keep logic out of framework wiring so it can be tested without the framework.

- At boundaries such as CLI args, config files, external APIs, and network protocols: parse, validate, and return meaningful errors.
- Inside an established invariant: use typed data and error propagation rather than repeating the same validation.
- Across the boundary: expose domain concepts instead of leaking a private representation, unless that representation is itself the intended public contract.

A boundary is a responsibility, not a package name. Tool arguments, persisted JSON another actor can edit, process/session metadata, and Git state after a lock or await can cross a fresh trust or mutation boundary. Preserve rechecks that establish a fact again after it could have changed. Do not delete runtime checks merely because the code is internal or typed.

## Types as constructions

The type checker is a proof assistant. Use it to eliminate impossible states, mismatched primitives, and unhandled variants at compile time where the language and project settings support those guarantees.

- **Make illegal states unrepresentable.** Don't model state as a bag of optional fields where contradictory combinations compile. `{ completed: boolean; completedAt?: Date }` admits a completed state without its date. Derive the boolean from one source, or model `{ kind: 'open' } | { kind: 'done'; at: Date }`.
- **Types are constructions, not restrictions.** A non-empty list is a head plus a rest, not a list with a length check. A valid time range can be a start plus a validated nonnegative duration, rather than two timestamps every caller must keep ordered. Choose the shape that encodes the actual domain and expose what callers need on top.
- **Distinguish semantic primitives when confusion is a real risk.** `UserId` and `OrderId` should not be accidentally interchangeable. Use the project's established newtype or branding convention when it earns its cost; do not retrofit brands throughout unrelated code.
- **External data is untyped until parsed.** RPC payloads, JSON, IPC messages, CLI args, config files, environment variables, and database rows need an owning parse boundary. Prefer the schema system the project already uses; do not add a dependency for one guard.
- **Don't lie to the type system.** Trace casts and assertion functions to their evidence. Validate, narrow, refine the model, or make the remaining hazard explicit. A lying guard is worse than `as`.
- **Exhaust variants.** Use the language's exhaustiveness mechanism; verify what its actual compiler settings enforce before claiming a compile-time guarantee.
- **Derive types from authoritative schemas.** Do not hand-maintain a parallel shape already owned by a protocol, schema, migration, or token definition.
- **Strengthen a type only where partiality appears.** A runtime assertion, null check, or "this should never happen" throw can mark a type that is too weak. Push that check up into the type when it is an internal representable invariant. Then stop. The type system's job is to track the cases each use site must handle, not to describe the data as precisely as possible. `sum` of an empty list is 0, so it takes the plain list. `head` needs either a non-empty input or an explicit absent result.

Ask: "Can I explain this combination of fields only with a comment?" "Is this type duplicating a shape another file owns?" "Am I strengthening this type to keep an operation total, or just to be more precise?"

These questions identify design opportunities within the changed scope. They do not make every existing cast, comment, or optional value a review defect.
