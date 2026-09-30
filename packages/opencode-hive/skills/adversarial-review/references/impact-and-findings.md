# Impact and finding judgment

Adapted from pstack's `blast-radius` and `interrogate` lead judgment. This skill's `UPSTREAM.md` and `LICENSE.pstack` record the source revision and MIT notice.

## Establish the safety assumption

Listing the callers is not the job. The job is the breakage grep won't show you. For each materially affected region, identify the fact its safety depends on. Inspect boundaries that a symbol search misses: serialized names, external consumers, pinned dependency behavior, timing, teardown, and persistence.

A search that finds nothing is still an answer; never make up a caller or an API. Report where the evidence stopped: an assertion, a cited contract, a traced execution path, a discriminating test, or the running feature. These are evidence descriptions, not another verdict system or a requirement to climb every rung.

Run code only when permitted, safe, useful, and within the host's tool limits. A clear source path or authoritative contract can establish a finding without execution. Name useful missing proof. One safety fact does not narrow a required reviewer's scope or clear unrelated risks.

## Filter without hiding findings

"What if someone passes null here?" is only a finding if the caller can actually pass null. Trace the call site. "I would have done it differently" is not evidence of a defect. Check whether an apparent workaround records a real external constraint before recommending its removal.

Agreement across reviewers may prioritize investigation; it does not establish correctness. Keep a concrete lone-reviewer defect. Do not impose a finding-count cap, code-size threshold, or obligation to invent a simplification.

Give counter-evidence for rejected material concerns so the operator can challenge the decision. Keep exhaustive investigation notes out of public review comments unless they answer an existing discussion. Use the host's optional-improvement and material-finding distinctions; the public prose rules remain with `pr-writing` and `writing-policy`.
