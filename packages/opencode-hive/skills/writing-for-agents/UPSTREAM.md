# Upstream Provenance: writing-for-agents

- **Source Repository**: `https://github.com/mattpocock/skills`
- **Source Directory**: `skills/productivity/writing-for-agents`
- **Author**: Matt Pocock
- **License**: MIT (see `LICENSE`)
- **Pinned Commit**: `321658273cb1d20b76026717d027d505790106d4`
- **Import Date**: 2026-09-15

## Vendored Files

1. `SKILL.md`: Core document-writing theory and reference (context pointers, two loads, information hierarchy, completion criteria, leading words, positive framing, pruning).
2. `SKILL-MECHANICS.md`: Skill invocation, mechanics, and router skills.
3. `LICENSE`: Upstream MIT license.

## Local Adaptations & Architecture Boundary

- **Frontmatter Description**: Scoped to authoring skills, subagent prompts, instructions, and pointer architecture. Explicitly avoids conflicting with `agents-md-mastery`'s pointer for `AGENTS.md` modification.
- **Division of Responsibility**:
  - `writing-for-agents` owns universal writing technique and theory for agent-consumed documents.
  - `agents-md-mastery` owns repository governance for `AGENTS.md`: progressive directory placement, write-what-exists grounding, signal vs noise filtering, and the item-level human approval maintenance workflow.
- **Predictability objective (deliberate adaptation of `SKILL.md`'s opening)**: Upstream's opening says the levers make a document predictable because the agent takes the same process every run. Hive's copy replaces that sentence and adds a "Contracts, protocols, and techniques" section. A contract states a required outcome, a protocol fixes an order that protects state, authority, or evidence, and a technique is selected to answer an open question. Identical process across runs is the goal only where a protocol protects something. This adaptation leaves the context pointers, two loads, information hierarchy, completion criteria, leading words and pruning sections, `SKILL-MECHANICS.md` and the upstream license as they were. It keeps this skill from asking instruction authors to turn every method into a mandatory sequence.
- **Runtime Compatibility Note**: Added to `SKILL-MECHANICS.md` explaining OpenCode's native skill discovery via plugin manifest / `skill` tool vs Claude Code's `disable-model-invocation` frontmatter.
