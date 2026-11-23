# Paleo sharp-testing

Some ideas in this skill are adapted from Paleo's `sharp-testing` skill, version 0.4.1, in `paleo/paleo-skills` at commit `e1241e31a4c701e218c0047a93a8a5b4ce67cb8c`, the latest commit that touches `skills/sharp-testing/SKILL.md` when this adaptation was made. Source: https://github.com/paleo/paleo-skills/blob/e1241e31a4c701e218c0047a93a8a5b4ce67cb8c/skills/sharp-testing/SKILL.md . The upstream skill declares `license: CC0 1.0`; `LICENSE.paleo` is the repository's CC0 1.0 Universal text at that commit.

Adapted ideas, reworded rather than copied:

- Expected values come from the requirement, not from the implementation.
- Output captured from the code under test is a change detector until it is checked against the requirement.
- A rejection case exercises the intended guard; failing earlier for another reason proves nothing.
- Each contract has one owner.

Not from upstream, and in part contradicting it:

- The black-box adoption policy: a declared local contract, an allowlist for lower-level behavior tests, the mechanical-check decision, and migration that retires lower-level tests. Upstream prefers focused unit tests for pure logic and puts end-to-end tests outside its scope.
- A full diff of normalized output as a peer of targeted assertions. Upstream requires a named consumer or compatibility obligation for exact representations and leaves incidental fields unconstrained.
- Delivered-text pins as ordinary cases. Upstream says never to assert authored copy.

CC0 requires no notice. The license text ships beside this file because every imported source in this package carries its license in the skill directory that uses it.
