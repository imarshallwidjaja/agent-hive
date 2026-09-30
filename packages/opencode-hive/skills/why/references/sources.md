# Select historical evidence

Choose categories for the question and tools actually exposed. Vendor names are examples, not required integrations. Read-only access and permitted data handling govern every query.

| Source | Evidence to seek | Common trap |
|---|---|---|
| Source control and forge | Introducing commit, blame/history through renames, PR description, reviews, linked issues | Treating a code change or a squash commit title as proof of intent |
| Issue tracker | Linked ticket, parent/sub-issues, product constraint, acceptance criteria, incident reference | Treating a closed status as proof that behavior shipped or stayed fixed |
| Design documents | Full decision record, alternatives, contemporaneous comments, revisions | Treating a stale proposal as deployed reality |
| Team conversation | Bounded searches by symbol, PR URL, author, date, error signature; full relevant thread | Removing the context of a quotation or exposing unrelated private conversation |
| Infrastructure observability | Monitors, thresholds, incidents, time-bounded logs/traces near the change | Correlation or instrumentation mistaken for a cause |
| Error tracking | First/last seen, release, concrete event and environment | Treating an automated root-cause suggestion as primary evidence |
| Product analytics | Existing documented schema, bounded distribution around a threshold or decision | Inventing tables/columns or making an unbounded warehouse scan |

For defensive code such as retries, timeouts, rate limits, or guards, look for the incident or upstream failure that motivated it. Corroborate an incident ID across sources when relevant; do not fan out simply to fill the table.

Use available repository history to orient the search, then follow actual references. Missing forge credentials or an absent MCP is an unavailable source, not a reason to invent an API or recreate the capability. Report chosen sources and why others were not searched. Query external sources only when the task and privacy boundaries permit it.
