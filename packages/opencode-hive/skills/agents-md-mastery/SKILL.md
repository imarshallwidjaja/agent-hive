---
name: agents-md-mastery
description: "Use when bootstrapping, reviewing, or pruning AGENTS.md memory and other durable agent instructions."
---

# AGENTS.md Mastery

## Overview

AGENTS.md is durable behavioral memory. Every line is loaded into later sessions. A bad entry misleads agents for a long time. A missing entry repeats the same mistake.

Write so a future agent acts differently. Prefer a short file of decision-changing rules over a long file that tries to cover the repository.

## Iron Law

```
EVERY ENTRY MUST CHANGE AGENT BEHAVIOR
```

Keep an entry only if it:

- Prevents a specific recurring mistake
- Selects a workflow the agent would otherwise miss
- Preserves a non-obvious convention, ownership boundary, or gotcha

If it only documents what the agent can already observe, it does not belong.

**Prune test:** If I delete this sentence, could a competent agent reasonably make a different decision? If no, delete it.

A related test: would a fresh session make a mistake without this entry? If no, it is noise.

## Progressive Placement

Instructions load from the repository root inward to the files in scope. A nested `AGENTS.md` owns a narrower path. It refines the root. It overrides a root rule only when it names that override.

Place a rule at the narrowest directory where it remains true. Add a nested `AGENTS.md` in the same change as that directory only if the directory has a rule that is not true at root. Do not add an empty or repeating nested file. Do not create instruction files for paths that do not exist.

This is how the instruction set grows: by real placement next to the code it governs, as that code appears.

Do not map the repository in AGENTS.md as a directory tree, component catalogue, or "where things live" diagram. That map is overlooked, goes stale, and becomes a second source of truth that no longer matches the tree. Discovery is the tree plus nested files beside the code.

Commands, package managers, and test runners belong in the files that actually invoke them. Mention a command in AGENTS.md only when an agent would still pick the wrong tool after those files exist.

Prefer `AGENTS.md`, and `.agents/` if the repository uses it, over vendor IDE rule directories as source of truth.

## Write What Exists

Name the current choice. Refer only to files, packages, services, directories, commands, and product objects that exist in this repository.

Do not record rejected alternatives, discarded options, or "we considered X" history. Git history is enough for what was left behind.

Do not put a standing job, milestone, or product object in AGENTS.md unless that object exists in the tree. A job line licenses the agent to invent architecture.

Do not seed intended component names, future directories, or example paths that an agent will copy as layout.

Wrong:
> We considered Redis for sessions, then chose Postgres. Do not use Redis as the session store.

Right:
> Sessions are stored in Postgres.

Keep a Wrong/Right pair only when it teaches a writing shape the prose does not already make obvious. Delete pairs that restate the paragraph above.

## Names

Name code, files, docs, components, and concepts by purpose, responsibility, domain meaning, or outcome. A name must make sense in isolation.

Do not name things after phases, options, workstreams, ticket numbers, or labels that only make sense in the current conversation or an external document. A planning identifier may appear only when it is a first-class concept whose meaning is defined and available alongside the artifact.

## When To Use

| Trigger | Action |
| --- | --- |
| New repository bootstrap | Write working philosophy, placement protocol, write-what-exists, and the prune bar. Do not invent build commands, a stack, or a layout the tree does not have. |
| Language or component first lands | Put local rules in that directory's `AGENTS.md` if they are not true at root. Record the toolchain in the component manifest, not as a stack list in root AGENTS.md. |
| Feature completion | Review the feature record, then propose durable learnings that still pass the prune test. |
| Repeated agent mistake | Add the missing rule at the narrowest true scope. |
| Periodic review | Prune stale, redundant, generic, and structure-map entries. |

## Signal Versus Noise

**Signal** (keep when the tree already chose this and agents still miss it):

- `Run bun test. This repository does not use npm.`
- `Use .js extensions for local imports. This is ESM.`
- `Use ensureDir. ensureDirSync does not exist.`
- `Worktrees do not share node_modules. Install in each worktree.`
- A nested `AGENTS.md` beside the code it governs, for a rule that is not true at root.

**Noise** (remove):

- Observable facts: `This project uses TypeScript`
- Generic advice: `Use descriptive variable names`
- Code summaries: `FeatureService manages features`
- History and metadata: created-on, original author, license text already in LICENSE
- Directory maps: a labelled tree of packages in root AGENTS.md
- Future layout: a `worker/` note because workers will need extra rules later
- Restating Wrong/Right examples
- A root line that says where a subsystem lives. If that directory has a local rule, put it in that directory's nested file after the directory exists.

Zustand versus Redux is signal only after the tree has already chosen one. Name the current tool. Do not freeze a stack list to pre-empt that choice, and do not keep the rejected tool in the instruction.

## Maintenance Workflow

1. Gather evidence from the conversation, diffs, failures, repository, and existing instructions.
2. Classify each candidate: root AGENTS.md, nested AGENTS.md, other durable docs, or not durable.
3. Re-read the proposed target for duplicates, conflicts, stale wording, and structure maps.
4. Present exact proposed text, destination, evidence, and operation.
5. Wait for item-level approval. Apply only accepted items to the approved target.
6. Show the resulting diff. Summarize applied, rejected, and unchanged items.

Do not auto-approve. One bad entry pollutes every later session.

Provisional one-off preferences stay out of AGENTS.md until repeated or mature evidence shows they are useful.

## When To Prune

Remove entries that are outdated, redundant, too generic, describing code, or proven unnecessary.

Also remove:

- Directory trees and "where things live" sections
- Commands for tools that are not in the tree
- Job or milestone lines naming objects that are not in the tree
- Nested files for paths that do not exist
- Wrong/Right blocks that only repeat the preceding paragraph
- Sentences that fail the prune test

Silence is not evidence that a hard-won safety rule is unnecessary. Preserve gotchas unless evidence shows they are obsolete.

## Red Flags

| Warning | Why | Fix |
| --- | --- | --- |
| Architecture or layout map in AGENTS.md | Second source of truth; goes stale | Delete the map. Put local rules beside the code |
| Invented build/test commands on bootstrap | Agents run commands that do not exist | Add commands only after they exist and agents pick the wrong one |
| Required empty Gotchas section | Forces noise | Add a gotcha when one is proven |
| Example paths that look like intended components | Agents create those directories | Use clearly counterfactual examples, or none |
| Nested AGENTS.md on every mkdir | Empty or copy-paste files | Add only when a local rule exists |
| AGENTS.md as comprehensive reference | Agents miss the few rules that matter | Filter. Link to real docs that own the detail |
| Historical "we considered X" | Rejected-alternative leakage | Name the current choice only |
| Line-count targets (500, 800) as quality | Length is not the prune bar | Use the prune test |

## Anti-Patterns

| Anti-pattern | Better approach |
| --- | --- |
| Document everything | Document only what changes a decision |
| Keep it for history | Git is history |
| Might be useful someday | Add when proven |
| Explain the system | Agents read the tree and the owning docs |
| Comprehensive architecture section | Nested files next to the code |
| One root file for all future conventions | Progressive placement as directories appear |

## Verification

Before finalizing AGENTS.md updates:

- Every remaining sentence passes the prune test
- No directory map, component catalogue, or future-layout sketch
- Nested files exist only beside code they govern, and only for rules not true at root
- Named commands, packages, and product objects exist in the tree
- No rejected-alternative history
- No generic advice that applies to every project
- A fresh agent session would act differently because of each remaining entry

## Summary

Place rules next to the code they govern as that code appears. Do not draw the tree in the instruction file. Name what exists. Delete any sentence a competent agent would decide the same way without.
