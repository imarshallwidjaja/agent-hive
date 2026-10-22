# Diagnostic techniques

Choose a technique by the question the evidence so far leaves open. None is a stage to pass through: stop when the causal-evidence bar in `SKILL.md` is met, and skip any technique whose question is already answered. This reference adds method and not authority. A technique that writes state, runs risky behavior, or touches retained evidence stays inside the authority and isolation rules in `SKILL.md`, and a diagnosis-only assignment uses read-only forms, or the isolated scratch and runtime reproduction it names, and reports what it could not observe.

The first five techniques adapt the investigation steps of obra/superpowers `systematic-debugging` (MIT, Copyright (c) 2025 Jesse Vincent); `UPSTREAM.md` and `LICENSE.superpowers` record the source revision and what changed. The stale-state, slowness and shared-premise techniques draw on pstack under `LICENSE.pstack`.

## What exactly failed?

Use when you have not yet seen the failure text, or have only a summary of it. Read errors and warnings completely before interpreting them: full stack traces, line numbers, file paths and error codes often contain the answer. This ends when you can quote the first error and say where it came from.

## Can I trigger it?

Use when the failure is intermittent or you lack steps. Find the exact steps and whether it happens every time. If it is not reproducible, gather more data (inputs, timing, environment, logs) instead of guessing. This ends when you can trigger it on demand, or can say which missing data would show why you cannot.

## What changed?

Use when it used to work or began after a change. Check the diff and recent commits, new dependencies, configuration changes, and environmental differences. This ends when the changes that could account for the failure are named or excluded.

## Which component boundary breaks?

Use when the failure crosses components (CI to build to signing, API to service to database) and the evidence does not say which boundary fails. Observe at the boundary the evidence points to first: what enters, what leaves, whether environment and configuration propagated, and the state at that layer. Widen to the neighbouring boundary only if the first does not localise the break. One run that shows where it breaks is worth more than logging every component, and the technique is unnecessary when the failing component is already known.

Example (a signing step fails in CI; each layer prints only what it receives):

```bash
# Layer 1: Workflow
echo "IDENTITY: ${IDENTITY:+SET}${IDENTITY:-UNSET}"
# Layer 2: Build script
env | grep IDENTITY || echo "IDENTITY not in environment"
# Layer 3: Signing script
security find-identity -v
```

This reveals which layer fails (workflow has the secret, the build script does not), so the next step investigates that component.

## What does working code do differently?

Use when a similar working path exists or you are applying an existing pattern. Find the working example in the same codebase. When implementing a pattern, read the reference implementation completely instead of skimming. List every difference between working and broken, however small, and note what the pattern depends on: settings, configuration, environment and assumptions. This ends when the differences are listed and the ones that could matter are tested or excluded.

## Which of several causes?

Use when two or more causes still fit the evidence. State one hypothesis ("I think X is the root cause because Y") and write it down. Prefer an observation the competing causes predict differently over more reading. Make the smallest change that tests it, one variable at a time, and do not fix several things at once. A confirmed hypothesis moves to the fix; a refuted one is replaced by a new hypothesis, and no further fixes are stacked on the failed experiment.

## Is persistent state stale?

Use for bugs that appear only after a restart, or whose behavior depends on what was stored earlier. Inspect the stored state, or reproduce on an isolated copy, and compare it with what the code expects. The state protections in `SKILL.md` apply to every experiment.

## Why is it slow?

Use for measured slowness. Take the same workload and measurement surface before and after a change. Name the cache invalidation before claiming a caching win. A trace without source attribution supports a hypothesis, not a confirmed cause.

## Is a timing assumption hiding the cause?

Use when a test or step passes or fails depending on timing. Poll a condition instead of waiting an arbitrary time, so the wait ends when the state is true rather than when a guess elapses.

## Where should a validation sit?

Use after the root cause is fixed, to decide where else to check. Validate at each actual trust or mutation boundary. Avoid rechecking an established invariant inside one boundary, and keep checks that another actor, a lock release, or an await could have invalidated.

## Does a premise explain several failures?

Use when two or more fixes failed the same gate. The premise is the one sentence every failed fix assumed. Choose evidence that could disprove it. For a load-imbalance problem, a per-actor census can separate the shared premise from an isolated symptom; unrelated defects do not need it. Reassessing a premise changes which question the next attempt investigates. It neither resets nor extends any attempt budget the role keeps.
