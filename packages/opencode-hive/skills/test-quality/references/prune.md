# Prune

The method for prune mode. Authority, scope, and stop conditions are in SKILL.md.

## Steps

1. **Baseline.** Before editing, run the scoped tests, and the type check when the project has one. Record failures that already exist.
2. **Classify.** For each in-scope test, name the plausible fault it catches and what it depends on (SKILL.md). Read the product path and adjacent suites before calling a test vacuous, obsolete, or a duplicate. For an absence check, also read the governing instructions, provenance notes, and the history of the removal before deciding.
3. **Probe a doubtful deletion claim.** When reading leaves a material question and a cheap, safe probe would settle it, introduce one specific fault the candidate claims to catch before deleting it. For suspected vacuity, see whether the candidate detects the fault. For suspected duplication, run the candidate and the retained owner against the same fault. Introduce one fault per run, never batched, and only in an isolated clean placement. Confirm the run executes the changed code: when tests read a compiled dependency's build output, rebuild it after introducing the fault. Restore the exact original bytes immediately after each probe, before the next probe or any edit, including any rebuilt output. One probe refutes or supports a claim; it does not prove two tests equivalent.
4. **Act.**
   - **Keep** a test that depends on intended behavior.
   - **Rewrite** a test that depends on the implementation but covers behavior something relies on: drive the public interface and take the expected value from the requirement.
   - **Delete or fold** a test that depends on nothing, on an obsolete requirement, or on another test. Name the retained owner of a fold.
   - **Remove support code** made unnecessary by deleted tests, such as a test reset hook or a debug dump, when its file is inside the writable scope and only after checking its remaining consumers and public contracts. Keep package and public exports, published or workspace-internal, utilities that other packages or tests use, and protocol methods called indirectly (`toJSON`, `Symbol.*`). Keep dependency-injection seams, such as an injected clock or client, whether or not a retained test uses them. Report what you could not establish.
5. **Verify.** The scoped tests and type check pass apart from recorded baseline failures. When a shared symbol changed, run the affected sibling packages' checks. No probe edit remains.

## Done when

- Unique contract coverage survives: layer-specific faults, boundary effects, delivered artifacts, type contracts, and continuing absence requirements.
- Each removal states its reason, and each fold names its retained owner.
- Support code in scope that existed only for deleted tests is gone where its consumers were established.

## Report

- One row per removed, folded, rewritten, or uncertain test: anchor, what it depends on, action, and the reason, retained owner, or settling question. Then a count of kept tests.
- Support code removed.
- Probes run: the fault introduced and which tests failed.
- Baseline and final check output.

## Example

Each `#` line explains the change below it.

```diff
--- a/backoff.test.ts
+++ b/backoff.test.ts
# rewritten: the expected value repeated the code's formula; the spec says 100 ms, doubled per failure
 test("doubles the delay after each failure", () => {
-  expect(delayFor(3)).toBe(BASE_MS * 2 ** 3);
+  expect(delayFor(3)).toBe(800);
 });
# folded: "caps the delay at 30 s" in this file asserts delayFor(10) is exactly 30000
-test("never exceeds the cap", () => {
-  expect(delayFor(10)).toBeLessThanOrEqual(30_000);
-});
--- a/retrier.test.ts
+++ b/retrier.test.ts
# deleted with its helper: it read the private queue, "runs the job after the delay" owns scheduling, _dumpQueue is not exported and has no other caller, and retrier.ts is in scope
-test("queues the job", () => {
-  retrier.schedule(job);
-  expect(retrier._dumpQueue()).toEqual([job.id]);
-});
# kept: the gateway rejects requests that carry the retired header, so it must not come back
 test("does not send the retired x-retry-token header", async () => {
   await retrier.run(job);
   expect(sent[0].headers).not.toHaveProperty("x-retry-token");
 });
--- a/retrier.ts
+++ b/retrier.ts
-  _dumpQueue() { return this.queue.map((j) => j.id); }
```
