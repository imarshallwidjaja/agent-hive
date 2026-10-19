# Verification planning

Read this reference when you plan or amend a costly, stateful, live, or release gate; when a gate follows a failed or changed candidate; when an amendment adds, changes, reruns, or drops a gate; or when the request or plan states a verification-efficiency outcome. The baseline that holds without it is the Verification Planning section of `SKILL.md`. This reference adds method, not authority: an approved explicit gate stays binding until an approved amendment changes it.

These rules apply to new plans and new amendments. They do not relax an approved plan: an approved explicit gate stays binding until an approved amendment retains, replaces, defers, or drops it.

## Gate records

Record each required gate once, under its owning task's `Verify` or under `## Final Verification`:
- A cheap gate with no mutable inputs needs one line: owner, command, expected signal, and "no mutable inputs".
- A costly, stateful, live, or release gate records its owner and canonical test layer, the invariant or risk it proves, prerequisites, command and expected signal, expected cost, the candidate and input identity it binds to, invalidation conditions, and its boundary.
- Gates that share candidate and input context may state it once for the group.

Expected cost guides sequencing. It becomes a pass/fail limit only when a binding requirement sets one. Run independent cheap gates before expensive ones when prerequisites allow. Keep legitimate stateful order: a consumer that destroys shared state runs last among that state's consumers, or each later gate owns an independent fixture. When an expensive gate stays `not run` behind slower gates, plan an earlier feasibility run on its own fixture if its prerequisites allow.

Boundaries:
- `local iteration`: a worker's diagnostic loop. It does not establish acceptance merely because a command passed; reuse requires the approved gate, candidate, inputs, and boundary to match.
- `task acceptance`: required checks on the task candidate before merge (the existing "pre-merge" gate).
- `integration checkpoint`: a cross-owner gate on a named candidate that discharges named deferrals without certifying a release.
- `release certification`: the complete-release gate set for a changed release boundary, run on a settled candidate. That is the task candidate when the task owns the release-boundary change, and otherwise the integrated candidate.

"Early" and "feasibility" describe timing within a boundary. An integrated-only deferral names a check owned by `## Final Verification`.

## Evidence decisions and amendments

A later commit does not automatically keep or discard earlier evidence. Assess each gate against the inputs that actually changed: source and test files that enter build contexts, locks, Dockerfiles, migrations, fixtures, mutable images, daemon state, and live or deployed state. A change labelled "tests only" can still rotate an image whose build context copies tests.

When an amendment adds, changes, reruns, or drops a gate, or follows a failed or changed candidate, it replaces the task's current `Verify` list and decision table (for integrated gates, the one in `## Final Verification`). The `####` note from `replace_task` records the latest amendment's cause and scope and replaces any earlier note; task reports hold earlier runs, observed candidates, counts, and rationale. The table's rows name the gate and why it stays or changes, and point to the report for what was observed. The table has one row per gate, or per group of gates sharing a reason, with:
- state: `passed and applies` (the tested candidate and its relevant inputs are unchanged, or a later change is shown not to reach them; an unrelated commit does not invalidate it), `invalidated` (name the changed input), `not run`, `failed` (first failure retained), or `blocked` (name the prerequisite);
- disposition with its reason: `retain` (why it still applies), `replace` (by which gate), `invalidate` (which input changed; rerun at its boundary on the settled candidate), `defer` (to which later boundary or the integrated candidate), or `drop` (why it no longer applies; only through an approved amendment).

A blanket "preserve all earlier gates" is unreconciled. When a general evidence-reuse rule and a task-specific unconditional rerun conflict, resolve them before approval.

Before approval, ask for each expensive gate: what failure can it detect from this delta; why is a cheaper owning gate insufficient; is the same gate already due at a later boundary; and, when a focused run and a union both execute the same node, what role does each run serve? A focused fail-fast run that fails before slower gates is `local iteration` evidence, not a second acceptance record for that node on the same candidate.

## Verification-efficiency goals

When the request, plan, or a correction states an explicit verification-efficiency outcome (faster delivery, less repeated verification), plan against the scope the outcome states; for a delivery-level outcome that is the complete delivery schedule, not one check. Compare the existing and proposed schedules across initial validation, one representative correction after a failure, and integration. For each, count preparation and setup, queueing and locks, execution, cleanup, and repeated acceptance. Use observed costs where they exist and mark the rest unknown. State which costly executions disappear and which remain, with the binding reason for each remaining one. Faster focused checks alone do not establish a whole-delivery improvement: judge the outcome's stated scope against the complete schedule evidence. Keeping every required acceptance run is valid when that evidence supports the improvement the outcome claims (for example cheaper setup, queueing, or diagnosis). An explicitly local feedback outcome stays local: keep the integration gates, report no end-to-end gain without evidence, and add no whole-delivery comparison. A plan cannot narrow an operator-defined outcome on its own; changing the requirement needs the operator's agreement, and an unsupported broader claim blocks approval. Plans without such an outcome need none of this, and it sets no numerical limit or measured-baseline requirement.

Separate required coverage from invocation packaging before approval. Keep indivisible composition, state, order, and default-routing proofs, and required real-runtime, scientific, and security tests. A proposed split needs evidence that it preserves the relevant invariants and coverage. Component results from a failed aggregate are reusable only with their actual recorded result and established independence of the relevant inputs and state from the failure; an unrun node never counts. An approved explicit aggregate stays one invocation until an authorized amendment changes it, and plan wording cannot override a repository requirement.

When the request corrects a verification policy, identify its intended scope first. If it is broader than one task, reconcile every covered unfinished task, `## Final Verification`, and canonical repository guidance, keep completed history, and name each retained exception and each unchanged default that could recreate the cost. A feature-local correction still names the repository default it leaves in place. Changing a gate or a repository instruction needs existing approval or change authority; scope similarity alone does not authorize amending a task.

## After a broad gate fails

1. Retain the first failure and its cleanup evidence. A green retry without an identified cause is not resolution.
2. Reproduce the failure red with the smallest valid check at the owning layer, then fix it with the owning regression.
3. Verify the owner and affected consumers.
4. Decide from input impact whether the certificate is invalidated. Rerun the broad gate when it is, or when a required proof only that gate supplies has no applicable passing record for this candidate; a new commit identity alone is not that reason. A binding whole-invocation gate reruns whole, and a selective subset never waives required acceptance.

## Certificates and unions

A certificate is the set of candidate-bound gate records that establishes a named boundary's acceptance for a named candidate. A record counts only while it is `passed and applies` to that candidate. An approved aggregate union runs as one invocation until an amendment changes it, and gates sharing state keep their order inside it. Any required gate that is `not run`, `failed`, or `blocked` leaves the certificate incomplete.

Reserve complete-release unions for a changed release boundary or a settled candidate. When a later change invalidates a certificate, record the invalidating input and rerun the invalidated records at their boundary; run another union when a binding requirement or an indivisible proof needs one invocation. A "one union per feature" rule does not certify a candidate that changed after the union passed, and an automatic full rerun per commit ignores records that still apply.

## Examples

Physical-STAC correction. A release-delivery task's complete union (identity bridge, backend integration, PgSTAC, physical-STAC, lifecycle, released-CPU) is its `release certification`. A physical-STAC run failed because a test helper supplied a historical binding to a current image.
- Before: the plan's general rule allowed reuse of evidence whose inputs still applied, yet every amendment blanket-preserved earlier gates and appended the unchanged complete union. Final Verification required the focused physical-STAC run and the union's physical-STAC node as two acceptance records. Each repair paid about 30-35 minutes for the bridge before reaching later gates, and released-CPU never ran.
- After: a daemon-free absent-bundle binding test reproduces the failure red and, with the fake-Docker cleanup tests, is the `task acceptance` owner; these run first. The focused physical-STAC run is pre-union `local iteration`, placed so a failure surfaces before the bridge. Decision table: the changed tests enter the bootstrap image's build context, so the rebuilt release, rebuild-identity, and the union's release-consuming nodes are `invalidated`; the backend batch is `invalidated` because its test files changed; released-CPU is `not run`; host, package, and docs results are `retain` with `passed and applies` only where their inputs are unchanged. The complete union then runs once on the settled task candidate and supplies candidate-bound bridge, lifecycle, physical-STAC, and released-CPU evidence, with released-CPU last as the destructive consumer. If the union fails, the recovery sequence applies instead of another appended union.

Justified broad rerun. A change to a Dockerfile stage shared by the release images invalidates every image built from that stage and every gate that consumes those images. A change to a migration or backfill that runs on populated data invalidates every gate that migrates that data. Either change justifies the complete release-certification union on the settled candidate. When a later fix changes that Dockerfile stage or migration again, the earlier certificate is invalidated; record that input and run the union again.
