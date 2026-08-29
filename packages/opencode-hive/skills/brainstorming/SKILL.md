---
name: brainstorming
description: "Use before creative work such as creating features, building components, adding functionality, or modifying behavior."
---

# Brainstorming Ideas Into Designs

## Overview

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

For ordinary creative work, start by understanding the current project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design in small sections (200-300 words), checking after each section whether it looks right so far.

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
- Ask questions one at a time to refine the idea
- Prefer multiple choice questions when possible, but open-ended is fine too
- Only one question per message - if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**
- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why

**Presenting the design:**
- Once you believe you understand what you're building, present the design
- Break it into sections of 200-300 words
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

## After the Design

**Documentation:**
- Keep the validated design in-session in the conversation unless the user explicitly asks for a tracked artifact
- Write a tracked design document only when the user explicitly requests one or the repository workflow explicitly requires one (for example an approved Hive plan or another named project artifact)

**Implementation (if continuing):**
- After ordinary brainstorming, ask: "Ready to set up for implementation?"
- Use \`skill({ name: "writing-plans" })\` to create detailed implementation plan

## Key Principles

- **One question at a time** - Don't overwhelm with multiple questions during ordinary brainstorming
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Explore alternatives** - Propose 2-3 approaches during ordinary brainstorming or when the operator explicitly requests alternatives
- **Incremental validation** - Present ordinary brainstorming designs in sections and validate each
- **Be flexible** - During ordinary brainstorming, go back and clarify when something does not make sense
- **Challenge assumptions** - During ordinary brainstorming, surface fragile assumptions, ask what changes if they fail, and offer lean fallback options
