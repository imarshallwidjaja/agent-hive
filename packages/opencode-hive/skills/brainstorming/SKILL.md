---
name: brainstorming
description: "Use before creative work such as creating features, building components, adding functionality, or modifying behavior."
---

# Brainstorming Ideas Into Designs

## Overview

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Ground creative work in the current project and the requested outcome. Ask one material question at a time when its answer changes correctness, safety, scope, persistence, UX, or a public contract. A clear implementation request does not need a manufactured interview or readiness prompt; preserve required planning, approval, isolation, and verification boundaries.

## Corrective Feedback Fast Path

Use this fast path only when operator corrective feedback concretely identifies all four:
- The wrong behavior
- The desired behavior
- The affected artifact
- The correction direction

Bare bug reports and vague feature requests do not qualify. If the operator explicitly asks to explore alternatives, discuss the change, or design it, keep the work exploratory even when the feedback is concrete.

For qualifying corrective feedback:
- Skip only the brainstorming dialogue and readiness prompt: do not ask ordinary refinement questions, propose 2-3 approaches, or present and validate incremental design sections
- Retain applicable project-context review, planning, isolation, testing, and verification requirements; if planning is required, enter that workflow without a readiness prompt
- Ask exactly one targeted question only when a material ambiguity affects correctness, safety, data scope, persistence, UX, or a public contract
- If the question is unanswered, or material ambiguity remains after the answer, stop rather than guess or enter the ordinary brainstorming process

## The Process

**Understanding the idea:**
- Check out the current project state first (files, docs, recent commits)
- Ask questions one at a time when a material decision remains unresolved
- Prefer multiple choice questions when possible, but open-ended is fine too
- Only one question per message - if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**
- Compare concrete alternatives when the choice is material and more than one approach is viable. A second flavor of the first shape does not count.
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why
- Skip competing designs for established patterns, clear-target fixes/refactors, or constraints that dictate one viable approach. Use `code-design-principles` for material representation, type, boundary, lifecycle, or internal-migration choices.

**Presenting the design:**
- Once you believe you understand what you're building, present the design
- Present enough of the design to decide the unresolved question. Use incremental checkpoints when the operator is exploring with you or the next section depends on their decision; do not impose section-size or approval rituals.
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

## After the Design

**Documentation:**
- Keep the validated design in-session in the conversation unless the user explicitly asks for a tracked artifact
- Write a tracked design document only when the user explicitly requests one or the repository workflow explicitly requires one (for example an approved Hive plan or another named project artifact)

**Implementation (if continuing):**
- If the operator requested exploration only, stop with the design and remaining decisions. If implementation is already authorized, continue through the applicable planning or execution route without asking for the same authority again.
- Use \`skill({ name: "writing-plans" })\` to create detailed implementation plan

## Key Principles

- **One question at a time** - Don't overwhelm with multiple questions during ordinary brainstorming
- **Multiple choice preferred** - Offer choices when that makes a material decision easier to answer
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Explore alternatives** - Compare genuinely different shapes at material uncertain decisions or when explicitly requested
- **Incremental validation** - Check decisions at meaningful boundaries, not after every paragraph
- **Be flexible** - During ordinary brainstorming, go back and clarify when something does not make sense
- **Challenge assumptions** - During ordinary brainstorming, surface fragile assumptions, ask what changes if they fail, and offer lean fallback options
