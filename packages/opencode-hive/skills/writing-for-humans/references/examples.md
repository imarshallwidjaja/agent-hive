# Further examples

These are constructed examples, not external factual claims. Each rewrite preserves only facts in its input.

## Preserve uncertainty

**Before:**
> The outage started within two minutes of deploy `2026-08-19.14`. The deploy could potentially be the cause, but a coincident cache stampede has not been ruled out. We could consider rewriting the pipeline once the cause is checked.

**After:**
> The outage started within two minutes of deploy `2026-08-19.14`. The deploy may be the cause; we have not yet ruled out a coincident cache stampede. Once the cause is checked, we could consider rewriting the pipeline.

Do not promote a hypothesis into a cause to make the paragraph cleaner.

## Explain a system without flattening it

**Before:**
> We added Redis in front of Postgres because catalogue reads took over 400 ms on cache misses. Writes still go to Postgres first and invalidate the cache on publish. A cache failure must fall open to Postgres rather than fail the page.

**After:**
> We added Redis in front of Postgres because catalogue reads took over 400 ms on cache misses. Writes still go to Postgres first; publishing invalidates the cache. A cache failure must fall back to Postgres rather than fail the page.

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
> The Billing Console shows invoices and payment status for each account. The support team issues refunds in the Support Desk. Usage charts show the last 90 days of metered usage. The screenshots show layout direction and their labels show intent; release sign-off uses the QA checklist.
>
> Open: the tax and credit-note views reuse the invoice table and have no screenshots.

Each affirmative sentence carries the scope its exclusion stated. For a reader who would still expect a forecast, add "usage charts do not show forecasts" once, beside the chart.

A runbook guard keeps its form. "Do not fail over while replication lag exceeds 30 s" stays as written, because "fail over when lag is under 30 s" turns a guard into a trigger.

## Rejected alternatives

For a current-state update, "Catalogue reads now go through Redis. Writes still go to Postgres first; publishing invalidates the cache" is enough when those are the supplied facts. An ADR may also need the discarded stores and why they lost. The reader's job determines which account belongs.

## Names and source voice

Name a coverage processor `coverage-processing`, not `phase-1-processor`. Keep a ticket as a reference, not the module's identity.

When importing an instruction such as "Execution order is not ownership," preserve it as instructional source text. Its brevity and contrast express a decision rule; prose cleanup is not a reason to turn it into a generic slogan about maintainability.
