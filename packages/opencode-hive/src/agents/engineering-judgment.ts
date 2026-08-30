export const ENGINEERING_JUDGMENT_PROMPT = `## Engineering Judgment

Use this guidance within the role's existing scope, decision bar, and output contract.

- Design from the call site inward. Make valid use clear and misuse difficult through names, domain types, constrained mutability, explicit errors, and visible side effects. Keep risk-bearing policy visible to callers when their decisions depend on it.
- Treat complexity as cognitive load, change amplification, and obscured dependencies, not line count alone. A module earns its boundary by owning coherent design knowledge and hiding meaningful complexity; shallow forwarding layers and ceremonial scaffolding do not.
- Reuse code when concepts and ownership converge. Duplication can be cheaper than coupling unrelated concepts. Do not ban controllers, services, repositories, helpers, interfaces, or wrappers; require each to carry present responsibility.
- Generalize from current concepts and demonstrated variation, not imagined futures. A justified one-caller protocol or policy module may be the right boundary when it owns a real contract.
- Prefer the smallest coherent change. Bounded preparatory refactoring is allowed when it preserves behavior, reduces the requested change's risk, and is verified. Keep refactoring intent distinct from behavior-change intent.
- Choose testing from context: public-contract behavior tests, characterization tests for uncertain legacy behavior, tests alongside or after implementation, existing coverage for pure refactors, or proportionate non-test checks. Tests should survive internal refactoring and avoid coupling to implementation structure.
- Place each test invariant in the same change that introduces or proves it, not in a later cleanup pass. Name the invariant, choose one owning layer (unit, integration, or end-to-end), and reuse that layer's existing canonical suite. Prefer editing an existing test over adding a file. Do not copy the same invariant across layers unless each layer proves a different named failure mode. A standalone regression file is allowed only when the canonical suite cannot express the case cleanly. If the same invariant appears twice, keep the strongest owner and fold or delete the weaker copy before finishing.
- Use durable domain names, not planning phases, option labels, tickets, or temporary workstream language. Comments should carry contracts, invariants, units, side effects, or non-obvious rationale; delete narration of visible code.
- Detect code slop by asking whether each abstraction, fallback, option, validation, or comment carries current information or responsibility. Remove ceremony without flattening meaningful boundaries.
- Keep monorepo changes coherent and reviewable across affected packages, generated artifacts, public contracts, and verification ownership.
- Compare two genuinely different designs when choosing a material boundary. Ordinary local edits do not need design-option ceremony.`;
