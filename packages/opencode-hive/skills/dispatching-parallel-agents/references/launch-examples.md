# Launch examples

Read this reference when you write the first native Forager launch of a session and want a complete call to adapt, when you need the ad-hoc placement check that validates repository IDs before `hive_adhoc_worktree_create`, when you fan out diagnosis-only lanes, or when you write an assignment prompt and want a worked one. The contracts that make a launch safe stay in `SKILL.md`: one primary goal per launch, one writer per worktree, destination identity in every writing handoff, and the host's continuation rule. The examples below illustrate those contracts and add no authority.

Each case has one example per host, and neither host needs a status call after a launch.
<!-- hive-host opencode-v1 -->
Every `task()` call blocks until its child returns, so there is no separate background launch.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
Every `subagent()` call runs in the background and returns a launch receipt; the child's result arrives in its final report under `## Native Subagent Wait` in your system prompt.
<!-- /hive-host -->

## Feature-task launch

These feature tasks each have an explicit single-repository target. Confirm the creation result's repository, path, and ref match the intended target, then include its path, ref, and commit in the assignment before dispatch; the abbreviated examples use the placeholders shown.

<!-- hive-host opencode-v1 -->
OpenCode v1:

```typescript
// Issue independent creates together; capture each destination from its create result.
hive_worktree_create({ feature: "feature-name", task: "01-fix-abort-tests" })
hive_worktree_create({ feature: "feature-name", task: "02-fix-batch-tests" })
// When the route is unset/different or matching selection evidence is missing/uncertain:
hive_feature_select({ feature: "feature-name" })
// Issue independent task calls together; reuse this selection for both. Each call blocks until
// its child returns sourceCommit, and calls issued in one message run in parallel.
task({ subagent_type: "forager-worker", description: "Fix abort tests", prompt: "Hive task: 01-fix-abort-tests\n\nTargeted single-repository worktree; destination: <path, ref, commit from create>. Implement and commit assigned changes; return sourceCommit." })
task({ subagent_type: "forager-worker", description: "Fix batch tests", prompt: "Hive task: 02-fix-batch-tests\n\nTargeted single-repository worktree; destination: <path, ref, commit from create>. Implement and commit assigned changes; return sourceCommit." })
```
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
OpenCode v2:

```typescript
// Issue independent creates together; capture each destination from its create result.
hive_worktree_create({ feature: "feature-name", task: "01-fix-abort-tests" })
hive_worktree_create({ feature: "feature-name", task: "02-fix-batch-tests" })
// When the route is unset/different or matching selection evidence is missing/uncertain:
hive_feature_select({ feature: "feature-name" })
// Issue independent task calls together; reuse this selection for both. Each returns a launch receipt;
// its sourceCommit comes in that child's final report (Native Subagent Wait in your system prompt).
subagent({ agent: "forager-worker", description: "Fix abort tests", prompt: "Hive task: 01-fix-abort-tests\n\nTargeted single-repository worktree; destination: <path, ref, commit from create>. Implement and commit assigned changes; return sourceCommit." })
subagent({ agent: "forager-worker", description: "Fix batch tests", prompt: "Hive task: 02-fix-batch-tests\n\nTargeted single-repository worktree; destination: <path, ref, commit from create>. Implement and commit assigned changes; return sourceCommit." })
```
<!-- /hive-host -->

## Targeted ad-hoc launch

The placement policy identifies `target` and the inspected destination identity before this example. The worker starts at the target's current HEAD. To start from another branch's pinned source commit, explicitly supply `baseRef`. Confirm the returned destination before dispatch; the run ID is the Hive worktree run ID.

<!-- hive-host opencode-v1 -->
OpenCode v1:

```ts
hive_adhoc_worktree_create({ runId: lane.runId, target: lane.target });
await task({ subagent_type: 'forager-worker', description: 'Implement the change', prompt: `Hive run: ${lane.runId}\n\nDestination: <confirmed path, ref, commit>. Implement and commit; return sourceCommit.` });
```
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
OpenCode v2:

```ts
hive_adhoc_worktree_create({ runId: lane.runId, target: lane.target });
subagent({ agent: 'forager-worker', description: 'Implement the change', prompt: `Hive run: ${lane.runId}\n\nDestination: <confirmed path, ref, commit>. Implement and commit; return sourceCommit.` });
```
<!-- /hive-host -->

## Ad-hoc launch with placement check

Placement starts from repository status. These examples resume an existing untargeted composite run using the saved `runId` and `repoIds` from the existing lane; first inspect the saved run with `hive_adhoc_worktree_inspect` (or reuse its existing inspection) and confirm it still exists. If it is missing, stop rather than creating a fresh untargeted composite run. Include each inspected destination path, ref, and commit in the assignment. The saved selection must be nonempty and each ID must still be configured; core checks it against the run's owned selection. Do not widen it to all configured repositories.

<!-- hive-host opencode-v1 -->
`hive_repositories_status` returns as an ordinary direct tool call on this host, and the examples read it that way.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
`hive_repositories_status` is a Hive read, so obtain its result through the Hive read transport your system prompt names before the launch. When reads run in Code Mode, call it from code passed to `execute`, using the exact path the Code Mode catalog lists; when your system prompt says Hive reads are direct tool calls, call it directly. That result is a status envelope; the examples below bind its `repositories` array property, not the whole result, as `repositories`. The Hive control tools and the native `subagent()` call in them are direct calls.
<!-- /hive-host -->

<!-- hive-host opencode-v1 -->
Launch:

OpenCode v1:

```ts
const { repositories } = hive_repositories_status();
const requestedRepoIds = lane.repoIds;
const selectedRepoIds = repositories.filter(({ id }) => requestedRepoIds.includes(id)).map(({ id }) => id);
if (
  requestedRepoIds.length === 0 ||
  new Set(requestedRepoIds).size !== requestedRepoIds.length ||
  requestedRepoIds.some((id) => !selectedRepoIds.includes(id))
) {
  throw new Error('Placement blocker: saved lane.repoIds must be nonempty, unique, and configured');
}
const repoIds = selectedRepoIds;
hive_adhoc_worktree_create({ runId: lane.runId, repoIds });
await task({
  subagent_type: 'forager-worker',
  description: 'Implement the ad-hoc change',
  prompt: `Hive run: ${lane.runId}\n\nResume the untargeted composite run; destinations: <per-repository path, ref, commit from create>. Complete the assigned work and commit; return the complete sourceCommits map keyed by repository ID.`,
});
```
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
The launch returns at once. Wait for the child's final report before dependent work, or keep doing foreground work that does not depend on it.

Launch:

OpenCode v2:

```ts
// repositories: the repositories array from the hive_repositories_status result, read through the Hive read transport first.
const requestedRepoIds = lane.repoIds;
const selectedRepoIds = repositories.filter(({ id }) => requestedRepoIds.includes(id)).map(({ id }) => id);
if (
  requestedRepoIds.length === 0 ||
  new Set(requestedRepoIds).size !== requestedRepoIds.length ||
  requestedRepoIds.some((id) => !selectedRepoIds.includes(id))
) {
  throw new Error('Placement blocker: saved lane.repoIds must be nonempty, unique, and configured');
}
const repoIds = selectedRepoIds;
hive_adhoc_worktree_create({ runId: lane.runId, repoIds });
const { sessionID } = subagent({
  agent: 'forager-worker',
  description: 'Implement the ad-hoc change',
  prompt: `Hive run: ${lane.runId}\n\nResume the untargeted composite run; destinations: <per-repository path, ref, commit from create>. Complete the assigned work and commit; return the complete sourceCommits map keyed by repository ID.`,
});
```
<!-- /hive-host -->

## Diagnosis-only fan-out

Read-only diagnosis lanes need no worktree and may launch together. Choose the best-fit available descriptor for the output you need: an advisor or reviewer reasons from source, and an Investigator judges from source and evidence or runs the candidate where your Experiments method places it, in a disposable placement you created and named when the run changes source.

<!-- hive-host opencode-v1 -->
OpenCode v1:

```typescript
task({ subagent_type: '<chosen-advisor-or-reviewer>', prompt: 'Diagnose failure A and report without edits' })
task({ subagent_type: '<chosen-advisor-or-reviewer>', prompt: 'Diagnose failure B and report without edits' })
task({ subagent_type: 'forager-investigator', prompt: 'Reproduce failure C on candidate <commit> in placement <path>; keep evidence in <evidence-dir>; report a conclusion or the unresolved result' })
```
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
OpenCode v2:

```typescript
subagent({ agent: '<chosen-advisor-or-reviewer>', prompt: 'Diagnose failure A and report without edits' })
subagent({ agent: '<chosen-advisor-or-reviewer>', prompt: 'Diagnose failure B and report without edits' })
subagent({ agent: 'forager-investigator', prompt: 'Reproduce failure C on candidate <commit> in placement <path>; keep evidence in <evidence-dir>; report a conclusion or the unresolved result' })
```
<!-- /hive-host -->

## A worked assignment prompt

A good prompt is focused on one problem domain, carries the context the worker needs as pointers and known facts rather than a dump of every note, and says what to return.

```markdown
Fix the 3 failing tests in src/agents/agent-tool-abort.test.ts:

1. "should abort tool with partial output capture" - expects 'interrupted at' in message
2. "should handle mixed completed and aborted tools" - fast tool aborted instead of completed
3. "should properly track pendingToolCount" - expects 3 results but gets 0

These are timing/race condition issues. Your task:

1. Read the test file and understand what each test verifies
2. Identify root cause - timing issues or actual bugs?
3. Fix by:
   - Replacing arbitrary timeouts with event-based waiting
   - Fixing bugs in abort implementation if found
   - Adjusting test expectations if testing changed behavior

Do NOT just increase timeouts - find the real issue.

Return: Summary of what you found and what you fixed.
```

Contrasts that decide whether a prompt works:

| Weak | Strong |
|---|---|
| "Fix all the tests": the agent gets lost | "Fix agent-tool-abort.test.ts": focused scope |
| "Fix the race condition": no location | Error messages and test names pasted in |
| No constraints: the agent may refactor everything | "Do NOT change production code" or "Fix tests only" |
| "Fix it": you cannot tell what changed | "Return a summary of root cause and changes" |
