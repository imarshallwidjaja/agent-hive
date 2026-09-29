---
name: pr-writing
description: Use when drafting or revising a pull request title or description, a general code review comment, or an inline review comment for a proposed change.
---

# PR Writing

Write for the person deciding what to merge or what to change. Drafting text does not authorize posting, creating or editing a PR or review, or approving or requesting changes.

1. Establish the artifact (title, description, general comment, or inline comment), whether you are the author or a reviewer, the current candidate and anchor, and any applicable template. Read the change, its purpose and relevant contracts before stating a claim. The template governs structure. Separate observed evidence from supplied claims and unrun checks.
2. For an author title or description, say why the change is needed and what it actually changes. Include consequential technical implications, tradeoffs, migrations, and verification with its observed status. A title names the change; the description gives the context necessary to review it. Keep material caveats visible.
3. For reviewer comments, check the intended behavior and the relevant consumer or reader consequence before asserting a defect. Decide whether the point is an evidenced defect, a tradeoff or question, or a preference. A defect outside the author's stated intent can still matter when the change breaks an existing contract. Make bounded evidence checks when useful; a full `/dash-review` is not a prerequisite. Investigate material uncertainty or phrase it as a question, and retain unresolved material concerns for the operator rather than presenting them as proven public findings.
4. Write from the observation: name what changes or fails and why it matters, with a current source anchor for inline comments. Prefer compact, casual sentences without ritual thanks, small talk, or coverage lectures. A general comment summarizes the decision-relevant issue without repeating the inline detail; a template or complex issue can require more space. Keep resolved or nonissue investigation notes out of public comments unless they answer an existing discussion; keep material uncertainty visible to the operator. Keep severity and confidence separate when either matters.

## Reviewer finish check

When the operator asks for findings or comments without requesting solutions, finish each finding at the observed condition and consequence. For example: "Adding `dataset` here shifts `fmask_flags` into the wrong position. The current ArcGIS caller fails at `dataset.crs`." If the operator requests solutions, include them. A comparison with expected behavior can explain a defect without directing an edit. Use questions to resolve missing evidence or tradeoffs. Before returning a findings-only draft, check that both general and inline comments end at the observation, without a request to fix the diff or a pre-merge directive.

Apply a personal voice skill only when the operator explicitly selects one. Review the final text against the actual candidate and template before returning it. Keep the review draft distinct from any action to publish it.
