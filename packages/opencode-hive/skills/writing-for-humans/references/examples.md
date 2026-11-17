# Further examples

These are constructed examples, not external factual claims. Each rewrite preserves only facts in its input.

## Technical and product clarity

Each source note supplies the context for its short before-sentence. The repairs are examples, not required sentence shapes.

**Order and domain terms**

Source: The readiness check runs before the authentication handler. The audience knows the term "authentication handler".

Before: "The readiness check sits at the session entry boundary."

After: "The readiness check runs before the authentication handler."

**Measured and unknown quantities**

Source: On dataset A, median import time fell from 12 s to 9 s. A separate report says only that its numbers improved; its metric and baseline are unavailable.

Before: "Import improved by 3 s. The other numbers improved too."

After: "On dataset A, median import time fell from 12 s to 9 s. The other report says its numbers improved, but does not identify the metric or baseline."

If the other report is irrelevant to the reader's question, omit its vague claim without a gap disclaimer. If the question asks whether that report establishes an improvement, explain the missing metric and baseline.

**Useful connection and redundant gloss**

Source: The snapshot may omit later changes. The report describes the snapshot, so it does not establish the dataset's current state. A snapshot is a saved copy.

Before: "The report describes the snapshot, a saved copy. In other words, it describes the saved copy. The snapshot may omit later changes, so the report does not establish the dataset's current state."

After: "The report describes the snapshot, a saved copy. The snapshot may omit later changes, so the report does not establish the dataset's current state."

**Status and dependency**

Source: The poll is still running. When the poll finishes, the coordinator will report the poll result. Deploy cannot begin until the result is approved. No other task status is supplied.

Before: "The result is the remaining dependency, with reporting following the polling boundary."

After: "The poll is still running. When the poll finishes, the coordinator will report the poll result. Deploy cannot begin until the result is approved."

**Metaphor and known operation**

Source: The worker's "safety net" retries a failed upload once. No other behavior is specified.

Before: "The safety net protects uploads."

After: "The worker retries a failed upload once."

**Known jargon and useful passive**

Source: Engineers know the term "write-ahead log". The log is flushed before the transaction is acknowledged; the actor that flushes it is unspecified.

Before: "The write-ahead log is flushed before the transaction is acknowledged."

After: "The write-ahead log is flushed before the transaction is acknowledged."

**Actor and input**

Source: Software uses satellite data to calculate a screening result.

Before: "Satellite data produces a screening result."

After: "The software uses satellite data to calculate the screening result."

**Reader-relative terminology**

Source: Processing software returns reports and output records in a defined format. The readers are unfamiliar with type systems.

Before: "Processing returns typed evidence about its outputs."

After: "The processing software returns reports and output records in a defined format."

**One source, two audiences**

Source: A report generator uses dataset `D-12`. After an analyst approves `D-12`, the generator may reuse a snapshot to create report `R-4`. A snapshot is a saved copy of the dataset at one point in time and may not include later changes to `D-12`. The report describes the data in that snapshot; it does not establish the current state of `D-12`.

Technical peer: "After an analyst approves dataset `D-12`, the report generator may reuse a snapshot, a saved copy of the dataset at one point in time, to create report `R-4`. The report describes the data in that snapshot."

Product partner unfamiliar with the implementation: "After an analyst approves dataset `D-12`, the report generator may create report `R-4` using a previously saved copy of the dataset. This copy, called a snapshot, captures the dataset at one point in time. `R-4` describes that copy."

Asked whether `R-4` verifies the current dataset: "The snapshot may omit later changes, so `R-4` does not establish the current state of `D-12`."

**Identity, checks, and permitted use**

Source: A saved Workflow A result has passed technical checks and meets the rules for use by Workflow B.

Before: "The result is exact, technically ready and eligible."

After: "The saved Workflow A result passed the technical checks and meets the rules for use by Workflow B."

The saved result's identity, the checks, and the rules for its use are separate facts. The source does not say who grants permission.

**Comparison**

Source: A reviewer compares the system's retained or new answer against the answer reported in the submitted study.

Before: "Compare the result with the study."

After: "The reviewer compares the system's retained or new answer with the answer reported in the submitted study."

**Retry scope**

Source: Repeating an acceptance operation after interruption retrieves its recorded outcome instead of duplicating its effect. The source does not say whether earlier calculations run again.

Before: "Retries avoid repeating the work."

After: "After an interruption, repeating the acceptance operation retrieves its recorded outcome without duplicating its effect."

**Responsibilities and recorded cost**

Source: A coordinator assigns jobs to workers. Workers run the jobs, and the coordinator records each job's execution cost. No before-and-after cost measurement is available.

Before: "The architecture reduces processing costs."

Mechanism question: "The coordinator assigns jobs to workers and records each job's execution cost. Workers run the jobs."

Did costs drop? "The coordinator records each job's execution cost, but no before-and-after cost measurement is available."

The missing measurement matters to the second question. It need not accompany the mechanism description.

## Sentence endings, subjects, and deferred nouns

**Required limit written as an evidence contrast**

Source: The focused suite passed on commit `3f1c9e0`. The full suite was not run. The report contract requires every unrun check to be listed.

Before: "The focused suite passed on commit `3f1c9e0`; this is a focused result, not a full-suite pass."

After: "The focused suite passed on commit `3f1c9e0`. The full suite was not run."

The tail classified the evidence by contrast. The repair states what ran, then states the unrun suite the contract requires in its own sentence. No fact is added or dropped.

**Non-human subject and the finding**

Source: Table 2 lists p95 latency for runs 1 to 4. Run 4 has the highest p95, 2.1 s. The median p95 across the four runs is 0.9 s.

Before: "The table shows it. The median hides run 4."

After: "Table 2 lists a p95 of 2.1 s for run 4, the highest of the four runs. The median p95 across the four runs is 0.9 s."

A table can list and a median can be computed. Neither can show or hide. The rewrite states the numbers the reader needed.

**Deferred noun**

Source: The token refresher expires sessions early. It needs a fix before the release.

Before: "One component needs attention before the release. It is the token refresher, which expires sessions early."

After: "The token refresher expires sessions early and needs a fix before the release."

Name the thing in the sentence that introduces it.

## Preserve uncertainty

**Before:**
> The outage started within two minutes of deploy `2026-08-19.14`. The deploy could potentially be the cause, but a coincident cache stampede has not been ruled out. We could consider rewriting the pipeline once the cause is checked.

**After:**
> The outage started within two minutes of deploy `2026-08-19.14`. The deploy may be the cause, but we have not yet ruled out a coincident cache stampede. Once the cause is checked, we could consider rewriting the pipeline.

Do not promote a hypothesis into a cause to make the paragraph cleaner.

## Explain a system without flattening it

**Before:**
> We added Redis in front of Postgres because catalogue reads took over 400 ms on cache misses. Writes still go to Postgres first and invalidate the cache on publish. A cache failure must fall open to Postgres rather than fail the page.

**After:**
> We added Redis in front of Postgres because catalogue reads took over 400 ms on cache misses. Writes still go to Postgres first. Publishing invalidates the cache. A cache failure must fall back to Postgres rather than fail the page.

Do not turn this into "Add Redis. Reads are faster." That loses the measured condition, write path, invalidation, and failure behavior. Do not claim a measured speedup without after evidence.

## Observation is not a requirement

**Input:**
> Checkout p95 is 2.8 s on mid-range Android. Session recordings show abandonment after the spinner. The team proposes a new homepage, but has not selected a latency target.

**Faithful explanation:**
> Checkout p95 is 2.8 s on mid-range Android, and recordings show people abandoning after the spinner. The team proposes a new homepage and has not selected a latency target.

Do not invent a p95 target to make the requirement look complete.

## Review finding

**Before:**
> Great work overall! One small nit: `billing/capture.ts:88` swallows `CardDeclined` and returns HTTP 200, so a declined card looks paid to the client. Food for thought.

**After:**
> Small nit: `billing/capture.ts:88` swallows `CardDeclined` and returns HTTP 200. A declined card then looks paid to the client.

Add a remedy only when requested or required by the review contract. Do not invent downstream behavior to strengthen the finding.

The rewrite preserves the supplied severity label. A correctness reviewer might challenge that label, but a prose edit alone does not silently reclassify the finding.

## Boundaries

**Source notes:**
> The Billing Console shows invoices and payment status for each account. It does not issue refunds; the support team issues refunds in the Support Desk. Usage charts do not show forecasts; they show the last 90 days of metered usage. The screenshots are not final designs; they show layout direction, and their labels show intent. Release sign-off uses the QA checklist, not the screenshots. The tax and credit-note views reuse the invoice table and are not shown.

**Design-direction page:**
> The Billing Console shows invoices and payment status for each account. The support team issues refunds in the Support Desk. Usage charts show the last 90 days of metered usage. The screenshots show layout direction and their labels show intent. Release sign-off uses the QA checklist.
>
> Open: the tax and credit-note views reuse the invoice table and have no screenshots.

Each affirmative sentence states supported scope without claiming it is exhaustive. If the request asks whether the charts forecast usage, answer that question directly.

A runbook guard keeps its form. "Do not fail over while replication lag exceeds 30 s" stays as written, because "fail over when lag is under 30 s" turns a guard into a trigger.

A caption can say "Search composer" without calling the image illustrative or high quality. When documenting a button by its exact product label, retain that quoted label. Ordinary interface copy can be revised when requested.

## Rejected alternatives

For a current-state update, "Catalogue reads now go through Redis. Writes still go to Postgres first. Publishing invalidates the cache" is enough when those are the supplied facts. An ADR may also need the discarded stores and why they lost. The reader's job determines which account belongs.

## Context, sentence load, and procedures

**Conversation and outside reader**

Source: In the conversation, "the green path" means the worker retries a failed upload once. The brief calls the operation an upload, a term the parent who wrote the brief knows.

In the conversation: "The green path retries once."

In a handoff to the parent: "The worker retries a failed upload once."

The handoff replaces the conversation-only label and leaves the brief's term "upload" unexplained.

**Exceptions and one clear core**

Source: A reviewer may approve a report after all checks pass. Exceptions apply if the source is missing, if the owner has not signed, or if the dataset is restricted and either the access record or the release record is missing. The exceptions apply even when the review is complete and all other records are present. An approved report lists every check result for the supplied dataset, along with the check name, the time it ran, and the version of the data used during the review.

Before: "A reviewer may approve a report after all checks pass except when the source is missing, the owner has not signed, or the dataset is restricted and either the access record or the release record is missing, including when the review is complete and all other records are present."

After: "A reviewer may approve a report after all checks pass, except in these cases:"

- The source is missing.
- The owner has not signed.
- The dataset is restricted and either the access record or the release record is missing.

The exceptions apply even when the review is complete and all other records are present.

Unchanged: "An approved report lists every check result for the supplied dataset, along with the check name, the time it ran, and the version of the data used during the review."

**Guarded procedure**

Source: Failover uses the standby host. Do not fail over while replication lag exceeds 30 s. If failover is needed, check lag on the standby host before promotion. Do not call the promote endpoint again without checking the replica role: a 504 may mean promotion succeeded. Call the endpoint to promote the standby.

Procedure:

Prerequisite: Failover uses the standby host.

1. If failover is needed, check replication lag on the standby host.

Do not fail over while replication lag exceeds 30 s.

2. Call the promote endpoint to promote the standby.

Do not call the promote endpoint again without checking the replica role. A 504 may mean promotion succeeded.

## Names and source voice

Name a coverage processor `coverage-processing`, not `phase-1-processor`. Keep a ticket as a reference, not the module's identity.

When importing an instruction such as "Execution order is not ownership," preserve it as instructional source text. Its brevity and contrast express a decision rule. Prose cleanup is not a reason to turn it into a generic slogan about maintainability.
