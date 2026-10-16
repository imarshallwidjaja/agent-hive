# Task milestones

A milestone is a stopping point: a target task, any explicitly named companion tasks, and the unfinished prerequisite closure needed to finish them. Two different jobs read this reference. Read Shared definitions plus the one section that matches your job.

| Job | Section | Read when |
|---|---|---|
| Propose stopping points | Suggesting milestones | You are building `## Recommended Execution Order` and `## Session Strategy` from a synced readback, for `/approve-sync-plan` or any plan handoff that proposes stopping points |
| Carry one out | Executing requested milestones | The operator or a Session Strategy prompt asks to run or continue a feature until a task is complete or done, before dispatch and again on every resumption |

This reference adds procedure, not authority. It grants no tool, skips no review, and does not change what `done` means. If it cannot be read, say so, stay inside the baseline in `SKILL.md`, and do not search generated skill caches for another copy.

## Shared definitions

- **Requested roots** are the target plus only the companions the request names. A bare target has no companions. Never infer companions from task numbers, readiness, or topic.
- **Closure** of a root is the root plus the recursive union of its own stored `dependsOn` edges, read from `hive_status({ feature })` after approval and sync. Resolved implicit sequential shorthand counts as a stored edge. Never infer an edge from numbering and never follow reverse dependents. Stop traversal at a `done` task: its outgoing edges are historical.
- **Only `done` satisfies a dependency.** `pending`, `in_progress`, `blocked`, `failed`, and `partial` are unfinished, not satisfied. A `cancelled` or missing root or prerequisite is a blocker. Report an invalid graph; do not repair edges while suggesting or executing.
- **Companions expand requested scope, not dependency edges.**
- **Scope** is the unfinished part of the union of every requested root's closure. Name it by exact task folder and title, including non-contiguous tasks. Numerical ranges such as "tasks 2-8" never define scope.

## Suggesting milestones

Work from the synced readback: the single top-level `tasks` list from `hive_status`, after any `status: null` integrity entries are inspected. Those entries are never runnable and never satisfy a dependency.

1. **Choose targets.** Prefer meaningful outcome or join tasks. When independent work is necessary to the same approved outcome, list it as an explicit companion in that milestone, with its exact folder, title, and the plan source that justifies it. For other desired branches, suggest separate milestones and list the remaining work. Never fabricate a dependency to force a linear split, and never sweep in earlier-numbered or all-ready tasks.
2. **Ground each stopping point in the approved plan.** State what the operator or system can do at that point and the verifiable signal, citing the source task or plan section instead of a subsystem label. Describe expected capability, not proven readiness before execution, and do not invent capabilities or evidence.
3. **Write the table** under `## Recommended Execution Order`. Columns: exact target task number, folder, and title; expected observable behavior at that stopping point; projected NEW unfinished task count; the actual task folders counted (inline or a bounded per-row list). Name companions in the target cell or the list, with `companions: none` when there are none, and distinguish target and its prerequisites from companions and their prerequisites.
4. **Count incrementally from DAG sets.** Let U_i be the current unfinished union of the closures of suggested target i and its explicitly listed companions, including every requested root; traversal stops at done tasks. The first milestone's new work is U_1. Later new work is U_i minus the union of the preceding suggested U_j. Deduplicate shared prerequisites, and count each requested root unless it is already covered or done. Show the exact folders in each counted set. Label the numbers as projected incremental counts that assume the earlier listed milestones completed. The operator can combine or omit stopping points, and omitted milestones or a changed order change the counts. Execution re-reads current status and recomputes scope on every request.
5. **Write the continuation prompts** in `## Session Strategy`, linked to the table targets without repeating the table. Substitute concrete names:

   ```text
   Run feature "<feature>" until task "<task-folder>" (<task-title>) is complete.
   Continue feature "<feature>" until task "<next-task-folder>" (<next-task-title>) is done.
   Also complete companion task "<companion-folder>" (<companion-title>) before stopping.
   ```

   Add the companion line once per listed companion and omit it when there is none. Each prompt must carry its whole explicit scope into a fresh session with status alone, because no persistent milestone manifest exists. Say that each prompt includes the unfinished prerequisites of every named root, excludes unrelated and descendant tasks, and keeps verification, review, integration, and cleanup obligations. A bare target request includes only the target closure. The session stops only after the target and every named companion are done with their gates complete.
6. **Add the terminal handoff.** Session Strategy also gives `Run final verification for feature "<feature>" and complete it only after the required checks pass.` with the concrete feature name. It is a separate continuation, used after no unfinished feature tasks remain, and it routes to the existing full-feature verification and completion procedure, carrying deferred checks and applicable cleanup.

If status cannot be read, the graph is invalid, a root or prerequisite is cancelled or missing, or an integrity entry blocks the readback, report those as the blockers. Do not produce a projection from numbering. Approval and sync outcomes stay as they were persisted.

### Worked example

In this plan `08-client-ready` depends, directly or through its prerequisites, on tasks 2 to 7, and tasks 2 to 5 end in `05-api-ready`. `01-access-guide` and `09-diagnostics-guide` depend on nothing. Nothing is done yet.

| Target number / folder / title | Expected behavior at stopping point (source acceptance criteria) | Projected NEW unfinished tasks | Task folders counted |
| --- | --- | --- | --- |
| 5 / `05-api-ready` / API ready; companions: none | An operator can create and retrieve a record; the API round-trip check returns the saved record (`05-api-ready`). | 4 | Target/prerequisites: `02-contract`, `03-storage`, `04-write-api`, `05-api-ready` |
| 8 / `08-client-ready` / Client ready; companion: `01-access-guide` / Access guide | A new operator can follow setup instructions and save a record through the client, then see it after reload; the setup walkthrough and client round-trip check succeed (client-delivery outcome, tasks 1 and 8). | 4 | Target/prerequisites: `06-client`, `07-persistence-check`, `08-client-ready`; companion: `01-access-guide` |
| 9 / `09-diagnostics-guide` / Diagnostics guide; companions: none | An operator can collect the required diagnostic bundle by following the guide; its walkthrough produces the listed files (`09-diagnostics-guide`). | 1 | Target: `09-diagnostics-guide` |

The second milestone's combined closure contains tasks 1 to 8, but tasks 2 to 5 were already counted in the first row. If the operator omits the first stopping point and starts with client delivery plus its companion, the projected count is 8. A bare request until task 8 counts 7 and covers tasks 2 to 8 only. Task 1 is non-contiguous with the rest of its row, which is why folders, not intervals, are listed.

## Executing requested milestones

Applies to a request to run or continue a feature until task X is complete or done, with or without explicit companion tasks, including a Session Strategy prompt from `/approve-sync-plan`.

The request is the whole scope manifest, because no persistent milestone manifest exists: preserve the exact feature, target, and explicitly named companions from the suggested prompt, report the milestone scope, and stop at that boundary. Follow explicit operator direction on order or parallelism; otherwise sequence from dependencies, owned paths, and shared resources, and ask only when a material scheduling or authority decision remains unresolved.

1. Resolve the exact feature and read `hive_status({ feature })` after confirming approval and sync. Resolve X and each explicitly named companion to one unique task folder/title within that feature. Ask for clarification if the feature, target, or any companion is ambiguous or missing; do not substitute a similarly named task or another feature. These requested roots are the target plus only the companions named in the request. A bare target request has no companions; never infer them from task numbers, readiness, or topic. A cancelled requested root is a blocker. Only if all requested roots are already `done`, report the milestone satisfied without dispatch; an already-done target does not short-circuit unfinished companions.
2. Build the combined prerequisite closure as the union of each requested root's own stored `dependsOn` edges recursively, including each root. Use synced edges, including resolved implicit sequential shorthand; never infer edges from numbering or follow reverse dependents. Deduplicate roots and shared prerequisites. Include companion prerequisites even when numbered beyond the target. Stop traversal at `done` tasks: their outgoing edges are historical. List the actual task folders, including non-contiguous tasks, distinguish target/prerequisites from explicit companions and their prerequisites, and split satisfied tasks from unfinished scope. Only `done` satisfies a dependency. Cancelled or missing prerequisites are blockers; `pending`, `in_progress`, `blocked`, `failed`, and `partial` are unfinished, not satisfied. Companions expand requested scope, not dependency edges. Report invalid graphs rather than repairing edges during execution.
3. Schedule only the combined unfinished closure by actual dependencies and existing ownership/resource rules. Respect retained workers/worktrees, freshness, reviews, and safety procedures when resuming non-done work. Inspect live or uncertain workers before dispatch; do not launch overlapping replacements. Exclude unrelated tasks and descendants unless the operator explicitly expands scope. Re-read status between batches and on each new run/continue request; recompute the union for all requested roots from updated stored edges each time, including approved and synced dependency amendments. Skip done prerequisites rather than trusting a prior batch or session's projected task list.
4. Stop dispatch at the milestone boundary. Achievement requires the target AND every explicitly named companion verified, integrated where applicable, and marked `done`, with applicable checks, required review, and cleanup completed. Wait for a slower independent companion even if the target finishes first. A source commit or worker completion alone is insufficient. If blocked, report the unmet prerequisite or gate and retain recoverable state under the existing blocker procedure. Do not dispatch unrelated work to fill the session or call `hive_feature_complete` merely because the milestone was achieved while other tasks remain.
5. Report the exact feature and achieved/blocked target and companions, completed and remaining combined closure scope, other remaining feature tasks, verification/integration evidence, and a concrete continuation prompt for the next suggested milestone (or the same requested roots if blocked). Include exact feature and target folder/title; append `Also complete companion task "<companion-folder>" (<companion-title>) before stopping.` for each companion. When no unfinished feature tasks remain after achievement, emit `Run final verification for feature "<feature>" and complete it only after the required checks pass.` with the exact feature substituted. Stop at the requested milestone and hand off final verification instead of executing it in that request. Carry applicable deferred checks with their owners; milestone completion does not waive whole-feature final verification.

### Worked cases

Cases use the example plan from the Suggesting section.

- **Bare target, companion, and done target.** `08-client-ready` depends on tasks 2-7, while `01-access-guide` and `09-diagnostics-guide` are independent. A bare request until `08-client-ready` includes only tasks 2-8. Appending `Also complete companion task "01-access-guide" (Access guide) before stopping.` adds task 1 and its own prerequisites; task 9 stays outside scope unless named or required by a requested root. If task 8 is already done and task 1 is unfinished, execute task 1's unfinished closure. Stop only after both requested roots are done and their gates complete.
- **Shared prerequisites.** Two requested roots that share `03-storage` count and run it once.
- **Cancelled prerequisite.** A cancelled task in a requested root's closure blocks the milestone. Report it with the affected folders; do not rewrite the edge.
- **Resumption in a fresh session.** Treat the prompt plus a fresh status read as the whole input. Tasks that finished in an earlier session are `done` and skipped.
