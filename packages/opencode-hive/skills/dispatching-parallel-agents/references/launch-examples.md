# Launch examples

Read this reference when you write the first native Forager launch of a session and want a complete call to adapt, when you need the ad-hoc placement check that validates repository IDs before `hive_adhoc_worktree_create`, when you fan out diagnosis-only lanes, or when you write an assignment prompt and want a worked one. The contracts that make a launch safe stay in `SKILL.md`: one primary goal per launch, one writer per worktree, destination identity in every writing handoff, and a fresh child after every returned result. The examples below illustrate those contracts and add no authority.

Background observation and reconciliation have one example, in `background-delegation`'s `references/board-protocol.md`. The launches here end where that protocol starts.

## Feature-task launch

Independent Forager worktrees may be created and dispatched under one parent. Capture each destination from the creation result, then dispatch with the task folder as the first prompt line.

<!-- hive-host opencode-v1 -->
OpenCode v1:

```typescript
// Gate-open only: use background: true when independent foreground work can continue.
// Issue independent creates together; capture each destination from its create result.
hive_worktree_create({ feature: "feature-name", task: "01-fix-abort-tests" })
hive_worktree_create({ feature: "feature-name", task: "02-fix-batch-tests" })
// When the route is unset/different or matching selection evidence is missing/uncertain:
hive_feature_select({ feature: "feature-name" })
// Issue independent task calls together; reuse this selection for both.
task({ subagent_type: "forager-worker", description: "Fix abort tests", prompt: "Hive task: 01-fix-abort-tests\n\nImplement and commit assigned changes; return sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present.", background: true })
task({ subagent_type: "forager-worker", description: "Fix batch tests", prompt: "Hive task: 02-fix-batch-tests\n\nImplement and commit assigned changes; return sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present.", background: true })

// Blocking alternative, including every gate-closed session:
hive_worktree_create({ feature: "feature-name", task: "03-fix-cleanup-tests" })
// Capture the create result; reuse only a visible same-feature selection (see SKILL.md).
await task({ subagent_type: "forager-worker", description: "Fix cleanup tests", prompt: "Hive task: 03-fix-cleanup-tests\n\nImplement and commit assigned changes; return sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present." })
```
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
OpenCode v2:

```typescript
// Gate-open only: use background: true when independent foreground work can continue.
// Issue independent creates together; capture each destination from its create result.
hive_worktree_create({ feature: "feature-name", task: "01-fix-abort-tests" })
hive_worktree_create({ feature: "feature-name", task: "02-fix-batch-tests" })
// When the route is unset/different or matching selection evidence is missing/uncertain:
hive_feature_select({ feature: "feature-name" })
// Issue independent task calls together; reuse this selection for both.
subagent({ agent: "forager-worker", description: "Fix abort tests", prompt: "Hive task: 01-fix-abort-tests\n\nImplement and commit assigned changes; return sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present.", background: true })
subagent({ agent: "forager-worker", description: "Fix batch tests", prompt: "Hive task: 02-fix-batch-tests\n\nImplement and commit assigned changes; return sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present.", background: true })

// Blocking alternative, including every gate-closed session:
hive_worktree_create({ feature: "feature-name", task: "03-fix-cleanup-tests" })
// Capture the create result; reuse only a visible same-feature selection (see SKILL.md).
await subagent({ agent: "forager-worker", description: "Fix cleanup tests", prompt: "Hive task: 03-fix-cleanup-tests\n\nImplement and commit assigned changes; return sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present." })
```
<!-- /hive-host -->

## Ad-hoc launch with placement check

Placement starts from the repository status. A lane may name only repository IDs that status lists, each once, and the check stops the launch when they do not match exactly.

<!-- hive-host opencode-v1 -->
`hive_repositories_status` returns as an ordinary direct tool call on this host, and the examples read it that way.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
`hive_repositories_status` is a Hive read, so obtain its result through the Hive read transport your system prompt names before the launch. When reads run in Code Mode, call it from code passed to `execute`, using the exact path the Code Mode catalog lists; when your system prompt says Hive reads are direct tool calls, call it directly. That result is a status envelope; the examples below bind its `repositories` array property, not the whole result, as `repositories`. The Hive control tools and the native `subagent()` call in them are direct calls.
<!-- /hive-host -->

Blocking launch (gate-closed sessions):

<!-- hive-host opencode-v1 -->
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
  throw new Error('Placement blocker: lane.repoIds must exactly match repository status IDs');
}
const repoIds = selectedRepoIds;
hive_adhoc_worktree_create({ repoIds });
await task({
  subagent_type: 'forager-worker',
  description: 'Implement the ad-hoc change',
  prompt: 'Concrete work with done criteria; commit changes; return sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present.',
});
```
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
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
  throw new Error('Placement blocker: lane.repoIds must exactly match repository status IDs');
}
const repoIds = selectedRepoIds;
hive_adhoc_worktree_create({ repoIds });
await subagent({
  agent: 'forager-worker',
  description: 'Implement the ad-hoc change',
  prompt: 'Concrete work with done criteria; commit changes; return sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present.',
});
```
<!-- /hive-host -->

A background launch applies to gate-open sessions with independent foreground work. After it, observe and reconcile the lane with `background-delegation`'s board protocol.

Background launch (gate-open sessions):

<!-- hive-host opencode-v1 -->
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
  throw new Error('Placement blocker: lane.repoIds must exactly match repository status IDs');
}
const repoIds = selectedRepoIds;
hive_adhoc_worktree_create({ repoIds });
const { task_id } = task({
  subagent_type: 'forager-worker',
  description: 'Implement the independent ad-hoc change',
  prompt: 'Concrete independent work with done criteria; commit changes; return sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present.',
  background: true,
});
hive_background_status({});
```
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
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
  throw new Error('Placement blocker: lane.repoIds must exactly match repository status IDs');
}
const repoIds = selectedRepoIds;
hive_adhoc_worktree_create({ repoIds });
const { sessionID } = subagent({
  agent: 'forager-worker',
  description: 'Implement the independent ad-hoc change',
  prompt: 'Concrete independent work with done criteria; commit changes; return sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present.',
  background: true,
});
hive_background_status({});
```
<!-- /hive-host -->

## Diagnosis-only fan-out

Read-only diagnosis lanes need no worktree and may launch together. Choose the best-fit available descriptor for the output you need.

<!-- hive-host opencode-v1 -->
OpenCode v1:

```typescript
task({ subagent_type: '<chosen-advisor-or-reviewer>', prompt: 'Diagnose failure A and report without edits' })
task({ subagent_type: '<chosen-advisor-or-reviewer>', prompt: 'Diagnose failure B and report without edits' })
```
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
OpenCode v2:

```typescript
subagent({ agent: '<chosen-advisor-or-reviewer>', prompt: 'Diagnose failure A and report without edits' })
subagent({ agent: '<chosen-advisor-or-reviewer>', prompt: 'Diagnose failure B and report without edits' })
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
