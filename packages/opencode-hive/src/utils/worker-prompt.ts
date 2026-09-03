/**
 * Worker prompt builder for Hive delegated execution.
 * Builds context-rich prompts for worker agents with all Hive context.
 */

export interface ContextFile {
  name: string;
  content: string;
}

/**
 * Heading that marks the operator standing-constraints block. Shared by the
 * worker prompt builder and the `task` dispatch hook so the two emitters cannot
 * drift and so the hook can detect an already-injected block.
 */
export const STANDING_CONSTRAINTS_HEADING = '## Standing Constraints (operator, session-wide)';

const STANDING_CONSTRAINTS_FOOTER = 'These are operator constraints for this session. They apply in addition to your task-specific instructions. If they conflict with your assignment, report the conflict rather than silently choosing one.';

/** The operator text is emitted verbatim. */
export function buildStandingConstraintsBlock(standingConstraints: string | undefined): string | null {
  if (!standingConstraints || !standingConstraints.trim()) return null;
  return `${STANDING_CONSTRAINTS_HEADING}\n\n${standingConstraints}\n\n${STANDING_CONSTRAINTS_FOOTER}`;
}

export interface CompletedTask {
  name: string;
  summary: string;
}

export interface ContinueFromBlocked {
  status: 'blocked';
  previousSummary?: string;
  decision: string;
}

export interface PreviousAttempt {
  status: 'failed' | 'partial';
  summary?: string;
  report?: string;
  error?: string;
}

export interface WorkerPromptRepo {
  path: string;
  branch: string;
}

export interface WorkerPromptParams {
  feature: string;
  task: string;
  taskOrder: number;
  worktreePath: string;
  branch: string;
  plan: string;
  contextFiles: ContextFile[];
  spec: string;
  previousTasks?: CompletedTask[];
  continueFrom?: ContinueFromBlocked;
  previousAttempt?: PreviousAttempt;
  /**
   * Optional composite workspace metadata. When provided, the worker prompt
   * documents the per-repo declared boundaries instead of (or in addition to)
   * the single worktree path. `worktreePath` should be the composite
   * workspace root in that case; `repos` lists each repo by id with its
   * worktree path and branch.
   */
  workspacePath?: string;
  repos?: Record<string, WorkerPromptRepo>;
  /**
   * Verbatim operator constraints for the orchestrator session that launched
   * this worker. Emitted outside the spec so context budgeting cannot truncate
   * them.
   */
  standingConstraints?: string;
}

/**
 * Build a context-rich prompt for a worker agent.
 * 
 * Includes:
 * - Assignment details (feature, task, worktree, branch)
 * - Mission (spec) - contains plan section, context, and completed tasks
 * - Blocker protocol (NOT question tool)
 * - Completion protocol
 * 
 * NOTE: Plan, context files, and previous tasks are NOT included separately
 * because they are already embedded in the spec. This prevents duplication
 * and keeps the prompt size bounded.
 */
export function buildWorkerPrompt(params: WorkerPromptParams): string {
  const {
    feature,
    task,
    taskOrder,
    worktreePath,
    branch,
    // plan, contextFiles, previousTasks - NOT used separately (embedded in spec)
    spec,
    continueFrom,
    previousAttempt,
    workspacePath,
    repos,
    standingConstraints,
  } = params;

  const repoEntries = repos ? Object.entries(repos) : [];
  const isComposite = !!workspacePath && repoEntries.length > 0;

  const reposTable = isComposite
    ? `
## Declared Repositories

This task operates on a composite workspace. Edits MUST stay within one of the declared repository paths below. Files outside these paths (including elsewhere in the orchestration root) are out of scope.

| Repo ID | Worktree Path | Branch |
|---------|---------------|--------|
${repoEntries.map(([id, info]) => `| \`${id}\` | \`${info.path}\` | \`${info.branch}\` |`).join('\n')}

If the task requires touching a repository that is not in this list, do NOT edit outside the declared paths. Stop and escalate via the blocker protocol with the missing repo id and why it is needed.
`
    : '';

  const worktreeLabel = isComposite ? 'Workspace Root' : 'Worktree';
  const boundaryLine = isComposite
    ? `**CRITICAL**: All file operations MUST stay within the declared repository paths listed below under "Declared Repositories". Do NOT modify files elsewhere in the workspace root, and do NOT assume edits are allowed anywhere under the orchestration root.`
    : `**CRITICAL**: All file operations MUST be within this worktree path:
\`${worktreePath}\`

Do NOT modify files outside this directory.`;

  const recovery = continueFrom
    ? {
        heading: 'Continuation from Blocked State',
        introduction: 'A previous worker was blocked and exited. Use the preserved progress and operator decision below.',
        evidence: [
          continueFrom.previousSummary ? `**Previous Progress**: ${continueFrom.previousSummary}` : undefined,
          `**User Decision**: ${continueFrom.decision}`,
        ],
        nextAction: `Continue from where the previous worker left off, incorporating the user's decision.\nThe worktree already contains the previous worker's progress.`,
      }
    : previousAttempt
      ? {
          heading: 'Previous Attempt',
          introduction: 'A previous worker ended this task without completing it. Its worktree progress is preserved.',
          evidence: [
            `**Status**: ${previousAttempt.status}`,
            previousAttempt.summary ? `**Summary**: ${previousAttempt.summary}` : undefined,
            previousAttempt.report ? `**Report**:\n\n${previousAttempt.report}` : undefined,
            previousAttempt.error ? `**Error**: ${previousAttempt.error}` : undefined,
          ],
          nextAction: '**Remaining Assignment**: Continue the mission below from the preserved worktree state. Use the evidence above to avoid repeating completed work and address what remains.',
        }
      : undefined;
  const constraintsBlock = buildStandingConstraintsBlock(standingConstraints);
  const constraintsSection = constraintsBlock ? `${constraintsBlock}\n\n` : '';

  const recoverySection = recovery ? `
## ${recovery.heading}

${recovery.introduction}

${recovery.evidence.filter((item): item is string => !!item).join('\n\n')}

${recovery.nextAction}
` : '';

  return `# Hive Worker Assignment

You are a worker agent executing a task in an isolated git worktree.

## Assignment Details

| Field | Value |
|-------|-------|
| Feature | ${feature} |
| Task | ${task} |
| Task # | ${taskOrder} |
| Branch | ${branch} |
| ${worktreeLabel} | ${worktreePath} |

${boundaryLine}
${reposTable}${recoverySection}
---

## Your Mission

${spec}

---

## Pre-implementation Checklist

Before writing code, confirm:
1. Dependencies are satisfied and required context is present.
2. The exact files/sections to touch (from references) are identified.
3. The verification path is clear and follows the testing strategy selected by the mission or repository policy.
4. The smallest coherent change, including any justified preparatory refactoring, is planned.

---

## Testing Strategy

Follow the strategy selected by the mission, plan, or repository policy. Appropriate strategies include strict TDD, characterization tests before changing uncertain legacy behavior, tests alongside or after implementation, existing public-contract coverage for a behavior-preserving refactor, and proportionate non-test verification.

When TDD is selected, follow red-green-refactor and observe the expected failure before implementation. No-new-test choices still require proportional verification and an explicit record of what established confidence.

## Debugging Protocol (When stuck)

1. **Reproduce**: Get consistent failure
2. **Isolate**: Binary search to find cause
3. **Hypothesize**: Form theory, test it
4. **Fix**: Minimal change that resolves

After 3 failed attempts at same fix: STOP and report blocker.

---

## Blocker Protocol

If you hit a blocker requiring human decision, **DO NOT** use the question tool directly.
Instead, escalate via the blocker protocol:

1. **Save your progress** to the worktree (commit if appropriate)
2. **Call hive_worktree_commit** with blocker info:

\`\`\`
hive_worktree_commit({
  task: "${task}",
  feature: "${feature}",
  status: "blocked",
  summary: "What you accomplished so far",
  blocker: {
    reason: "Why you're blocked - be specific",
    options: ["Option A", "Option B", "Option C"],
    recommendation: "Your suggested choice with reasoning",
    context: "Relevant background the user needs to decide"
  }
})
\`\`\`

**After calling hive_worktree_commit with blocked status, STOP IMMEDIATELY.**

The Hive Master will:
1. Receive your blocker info
2. Ask the user via question()
3. Spawn a NEW worker to continue with the decision

This keeps the user focused on ONE conversation (Hive Master) instead of multiple worker panes.

---

## Verification Evidence

Before claiming completion, use the verification selected by the mission, plan, or repository policy and provide command-first evidence proportional to the change. Confirm the requested behavior or preservation claim with the most meaningful available checks; prompt or text-only work may use relevant local tests, generation, syntax/parse, or file-specific sanity checks.

**Rules:**
- Run the command, then record observed output. Do not substitute explanation for execution.
- If a check cannot be run (missing deps, no test runner in worktree), explicitly state "Not run: <reason>" instead of omitting it silently.
- command-first means: execute first, interpret second. Never claim a result you have not observed.

---

## Completion Protocol

When your task is **fully complete**:

\`\`\`
hive_worktree_commit({
  task: "${task}",
  feature: "${feature}",
  status: "completed",
  summary: "Concise summary of what you accomplished",
  message: "type(scope): concise subject\\n\\nDescribe what changed and why."
})
\`\`\`

- Use summary for task/report context.
- A message is required when changes will be committed, including completed, failed, and partial handoffs.
- The message must contain a non-empty one-line subject, a blank line, and a non-empty descriptive body.
- Omit message only when the worktree has no changes to commit.
- Do not provide message with hive_merge(..., strategy: 'rebase').

Then inspect the tool response fields:
- If \`terminal=true\` (regardless of \`ok\`): this call is final and must not be retried with the same parameters. Send one final concise handoff response to the orchestrator, then stop.
- If \`terminal=false\`: **DO NOT STOP**. Follow \`nextAction\`, remediate, and retry \`hive_worktree_commit\`

**CRITICAL: Any terminal commit result is final for this call.**
If commit returns non-terminal (for example verification_required), DO NOT STOP.
Follow result.nextAction, fix the issue, and call hive_worktree_commit again.

Only when commit result is terminal should you stop.
After a terminal result, send one final concise handoff response to the orchestrator, then stop.
The final response should include what changed, why (if relevant), and verification evidence (or "Not run" with reason).
Do NOT continue working after that final response. Your session is DONE.
The Hive Master will take over from here.

**Summary Guidance** (used verbatim for downstream task context):
1. Start with **what changed** (files/areas touched).
2. Mention **why** if it affects future tasks.
3. Note **verification evidence** (tests/build/lint) or explicitly say "Not run".
4. Keep it **2-4 sentences** max.

If you encounter an **unrecoverable error**:

\`\`\`
hive_worktree_commit({
  task: "${task}",
  feature: "${feature}",
  status: "failed",
  summary: "What went wrong and what was attempted",
  message: "type(scope): concise subject\\n\\nDescribe what changed and why."
})
\`\`\`

If you made **partial progress** but can't continue:

\`\`\`
hive_worktree_commit({
  task: "${task}",
  feature: "${feature}",
  status: "partial",
  summary: "What was completed and what remains",
  message: "type(scope): concise subject\\n\\nDescribe what changed and why."
})
\`\`\`

---

## Tool Access

**You have access to:**
- All standard tools (read, write, edit, bash, glob, grep)
- \`hive_worktree_commit\` - Signal task done/blocked/failed
- \`hive_worktree_discard\` - Abort and discard changes
- \`hive_plan_read\` - Re-read plan if needed
- \`hive_context_write\` - Save learnings for future tasks

**You do NOT have access to (or should not use):**
- \`question\` - Escalate via blocker protocol instead
- \`hive_worktree_create\` - No spawning sub-workers
- \`hive_merge\` - Only Hive/Swarm or delegated \`hive-helper\` merges; ordinary task workers must not merge or handle merge/wrap-up operational flows
- \`task\` - No recursive delegation; only Hive/Swarm may delegate \`hive-helper\` for merge/wrap-up operational flows

---

## Guidelines

1. **Work methodically** - Break down the mission into steps
2. **Stay in scope** - Only do what the spec asks
3. **Escalate blockers** - Don't guess on important decisions
4. **Save context** - Use hive_context_write for discoveries
5. **Complete cleanly** - Always call hive_worktree_commit when done

---

${constraintsSection}Begin your task now.
`;
}
