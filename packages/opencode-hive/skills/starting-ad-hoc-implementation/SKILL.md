---
name: starting-ad-hoc-implementation
description: Use when the operator explicitly asks Agent Hive Builder to implement ad-hoc work that the current conversation or detailed supplied context already scopes, through `/implement` or a plain request such as "implement it", before any worktree or dispatch.
---

# Starting Ad-Hoc Implementation

This skill covers the step between "we discussed it" and "a lane starts": what the request authorizes, how the agreed scope is rebuilt from the conversation, and what must be settled before work begins. It stops owning the process when the scope goes to the ad-hoc lifecycle.

## Trigger and Role

Hive Builder, or another primary whose own instructions authorize ad-hoc implementation on request, applies this skill when the operator explicitly asks to implement ad-hoc work. The request is `/implement`, which binds Hive Builder in the current session so the conversation stays in place, or plain words such as "implement it" or "go ahead and build this". The conversation or the supplied context must scope the work.

Text after `/implement` is further context and natural-language steering. Read it whole as prose, as part of the request.

- An approved feature plan or feature task runs through `/start-execution` and `executing-plans`. A selected feature does not make a request feature work.
- Architect plans only. A primary whose instructions require a plan before implementation keeps that rule: say so, and point to `/implement`, which runs under Hive Builder.

## Authority

The operator's explicit request in this turn authorizes implementing the agreed outcome and the current additional instructions through the ad-hoc lifecycle. Loading this skill, earlier history, and a bare confirmation at the end of `/grill` or `/interview` authorize nothing by themselves. New scope, an external effect such as push, publish, or deploy, and any Hive feature, plan, or task need their own authority.

## Rebuild the Scope

Read the current conversation and the operator text, with newer instructions overriding older ones. From the latest agreement, settle:

- the outcome, constraints, non-goals, and acceptance criteria
- decisions the conversation superseded or rejected, which stay out
- which claims the work depends on are verified in source and which only the conversation asserts
- open material issues

Scope is what was agreed, not everything mentioned: tangents, rejected options, and passing questions stay out. Reuse design decisions and advice the conversation already settled instead of asking or researching them again.

## Close the Gaps

Bounded investigation and clarification are part of the request. Read the code the scope touches and resolve discoverable facts through your role's usual retrieval; ask the operator only about decisions that are theirs.

- **Approach unsettled** (competing routes, or a risk the conversation did not weigh): ground a first pass in source, then take advice from the approach-advisor and, when the risk calls for a second adversarial view, from the configured advisor or reviewer whose description fits it. Consolidate that evidence into the scope. A change that follows an established pattern needs neither alternatives nor advice.
- **Material operator decision** (scope, behavior, public contract, persistence, data, security, external effect): ask one at a time, through `question` when it is exposed and otherwise as one plain chat question. Say what you found, what each option changes, and your recommendation.
- **Scope not ready**: say what is unready, why it matters, and the recommended next step, such as `/grill` for broad open questions or a narrower scope. Start no worker until it is resolved.

Once the open issues are resolved within the scope, proceed without asking for approval again.

## Hand Off

State the scope in a few lines (outcome, constraints, acceptance) so the operator and the lane handoffs share one reading. Then continue under your own lifecycle: repository-backed placement, `orchestrating-ad-hoc-work` when its triggers hold (one coherent lane is a valid result), delegation, review, verification, merge, and cleanup. Give every worker the scope above.

This skill adds no readiness status, design file, plan, or Hive record, and it selects no test strategy. Brainstorming, orchestration, dispatch, background, review, and verification keep their methods.

## Repeated Invocation

Before starting, account for work from this conversation that is already running or retained: workers, background jobs, ad-hoc runs by their known run IDs (`hive_adhoc_worktree_inspect`), and todos. A new `/implement` steers that work, adds an outcome, or both. Reconcile it with the existing lane and its owner; one worktree has one writer, and a lane whose lifecycle is uncertain is inspected or awaited, not duplicated.

## Missing Capability

When this agent's role, or a tool or skill the current path needs, is unavailable, state which one and what it blocks, and pause only the work it blocks. A skill named here for another path, such as `executing-plans` for feature work or `orchestrating-ad-hoc-work` when its triggers do not hold, is not needed. A different route, such as editing the canonical checkout directly or creating a feature, is a separate decision for the operator.
