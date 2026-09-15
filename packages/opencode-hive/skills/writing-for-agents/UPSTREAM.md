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
- **Runtime Compatibility Note**: Added to `SKILL-MECHANICS.md` explaining OpenCode's native skill discovery via plugin manifest / `skill` tool vs Claude Code's `disable-model-invocation` frontmatter.
