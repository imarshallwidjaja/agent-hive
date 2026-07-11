import type { HiveCommandKey } from './registry.js';

export const COMMAND_BEHAVIOR: Record<HiveCommandKey, string> = {
  interview: `Conduct a focused interview to help the operator clarify an idea, make decisions, and surface the right next steps.

Use the operator-provided topic, prompt, or context from runtime arguments when provided.

Your job is to collect the decisions, constraints, assumptions, goals, and unresolved questions that matter for moving the work forward.

Optimize for a strong handoff into \`/implementation-brief\` when the discussion is heading toward implementation planning.
Do not force the interview into that workflow when the operator is still brainstorming, exploring options, or shaping the problem.

Do not jump into implementation.
Do not write code.
Do not create Hive plans or mutate Hive state during the interview.
Do not invent repository facts, file paths, or code references that have not already been established in this session.

Interview rules:

- Ask exactly one question at a time.
- Prefer the \`question\` tool for each turn when it helps the operator answer cleanly.
- Focus on the highest-ambiguity, highest-risk, and highest-value questions first.
- When using the \`question\` tool, prefer 2-4 concise options with useful descriptions, put your recommended option first when there is a sensible default, and leave custom input available when the options are incomplete.
- Base each next question on what you just learned. Skip questions whose answers are already obvious.
- Keep the interview tight and decision-oriented. Usually 4-7 questions is enough. Do not ask more than 8 questions unless the operator explicitly wants a deeper interview.
- After each answer, reply with a short running summary covering what is now decided, what constraints are clear, and what still needs clarification.
- If the operator supplied goals or requirements in runtime arguments, treat them as steering context for the interview rather than repeating them mechanically.
- If there are no more useful high-value questions, conclude the interview immediately.

Prioritize collecting:

- the real problem being solved
- the shape of the idea if the operator is still brainstorming
- who the change is for and how it will be used
- the desired outcome and success criteria
- hard constraints, non-goals, and compatibility expectations
- scope boundaries for the next implementation effort
- alternative directions or tradeoffs when the right path is still unclear
- important domain rules, workflows, or edge cases
- unknowns that must be validated against the live codebase before implementation planning

Use the current session as source of truth for any already-established technical context.
If the session already contains relevant repo findings, capture them accurately.
If it does not, clearly mark codebase details as "needs validation" rather than guessing.

Stop the interview when you have enough information to produce a useful clarified brief and a sensible next step.

At the end, output all of the following:

## Interview Summary

- problem
- target outcome
- scope
- non-goals
- constraints
- decisions made
- open questions

## Recommended Next Step

Choose the most sensible next step based on the interview outcome.

- If the interview produced enough clarity for planning, recommend \`/implementation-brief\` and explain why.
- If the operator is still deciding direction, recommend continuing brainstorming or narrowing the problem first.
- If important repo or product facts are still unknown, say that validation or exploration is needed before implementation planning.

## Context For \`/implementation-brief\`

When implementation planning is the likely next step, write a compact handoff block that an operator can keep in the session or pass as extra context. It must include:

- problem being solved
- exact high-value scope to target next
- confirmed decisions from the interview
- assumptions that still need codebase validation
- repo questions and technical unknowns the planning pass must resolve
- parity, migration, or compatibility concerns if any were identified
- expected implementation-planning outcome

If implementation planning is not yet the right next step, say so plainly and do not fabricate this handoff block.`,

  'implementation-brief': `Turn the current exploration in this session into an implementation brief that the operator can pass to \`/hive-plan\`.

Use the live codebase as source of truth, not just prior notes. Revalidate the current code paths, references, and assumptions first.

Use extra context from runtime arguments when provided.

Produce a single copy-paste-ready brief. The brief tells the receiving agent to treat the enclosed information as directional goals, validate every assumption against the live codebase, use live code references and call paths as discovery anchors, and route through \`/hive-plan\` to produce the formal Hive plan.

The brief must clearly define:

- the problem being solved
- the exact high-value scope to target
- the live code references and call paths involved
- what is already known from this exploration
- the strongest solution leads already identified
- the expected solution outcomes
- the repo and parity constraints that must be preserved
- what the receiving agent must validate, research, and resolve in order to produce an execution-ready implementation plan

The brief should be detailed, concrete, and strong enough that the receiving agent can begin immediately without follow-up steering.

Output only the final brief in one fenced code block.`,

  'hive-plan': `Create a Hive plan for implementing the spec or brief from runtime arguments when provided.

Take initiative to define one primary goal per implementation assignment. That goal may include tightly coupled code, tests, docs, and multiple files; do not split work by file or step. Give complete constraints and acceptance criteria only for that goal. Split independently verifiable outcomes into fresh assignments.

One implementation assignment normally maps to one numbered task. For an independently verifiable new deliverable, amend the DAG or create an append-only manual task. Independent assignments can be parallelized cleanly. Only split work when it improves execution quality; do not break apart tasks that should remain together to preserve code quality or coherence.

If the intention detected is not an ad-hoc piece of work: make sure plans include updating documentation when user-facing behavior, setup, install flow, or operator workflow changes.

When prompting the operator for decisions, include the detail needed to make the decision and explain the reasoning behind your recommendation.

If a worker task fails, do not send a follow-up prompt to that session. Launch a new worker in a fresh subagent session with a concise self-contained handoff: the primary goal, what was attempted, where it failed, relevant errors, the likely cause, and the next constraints. Compaction may re-anchor a currently running worker; it is not re-delegation.

When delegating scouts or explorers, prefer more subagents with narrower scopes, minimising decision making to keep the context for each subagent focused and manageable.

Prioritize active discovery. Use tools to find current repository information and external information when needed, while using pre-trained knowledge only as guidance.

Always validate technical designs against the discovered information and the repository's current state to ensure the plan is feasible and well-informed.

Use \`hive_feature_create\`, \`hive_context_write\`, and \`hive_plan_write\` as appropriate. Read back state with \`hive_plan_read\` and \`hive_status\`.

Present: feature and plan status, plan readback, task breakdown, recommended execution order, session strategy, applied operator input, and remaining decision points.`,

  'approve-sync-plan': `Finalize the current Hive plan for execution and return an operator-ready brief.

Follow this workflow exactly:

1. Identify the active feature name (\`hive_status\`).
2. Read the plan and verify it is ready for execution (\`hive_plan_read\`).
3. Approve the plan (\`hive_plan_approve\`).
4. Sync tasks from the approved plan (\`hive_tasks_sync\`).
5. Read the final plan and task state again after approval and sync (\`hive_status\`, \`hive_plan_read\`).

If approval or sync fails, stop and report the exact blocker, what you attempted, and the shortest recovery path.

Return these sections with these headings:

## Feature

- feature name
- plan approval status
- task sync status

## Plan Readback

Summarize the final plan in plain language, including:

- objective and intended outcome
- scope boundaries and non-goals
- key constraints, assumptions, and risks
- dependency highlights

## Task Breakdown

For every task, explain:

- what it delivers
- why it matters
- key dependencies or ordering constraints
- what done looks like

## Recommended Execution Order

Give the best task order with reasoning. Use parallelism only where dependencies allow it, and call out tasks that must remain sequential.

## Session Strategy (Min Sessions, No Context Overload)

Design the fewest reasonable execution sessions without overloading any one session. Include:

- recommended number of sessions
- tasks assigned to each session
- why the grouping keeps session count low safely
- context-load risk checks for each session
- handoff notes between sessions

Default to fewer, stronger sessions. Split only when context size, risk, or dependency complexity justifies it.

## Additional Operator Input

State how you interpreted and applied additional operator input from runtime arguments. If none was provided, write: "No additional operator input provided."

## Decision Points For Operator

List only decisions still needed before execution. For each one, include:

- recommended default
- impact of choosing differently

Output rules:

- be concrete and execution-oriented
- do not write code
- do not omit any task
- avoid generic advice`,

  'start-execution': `Start executing the approved Hive plan. Use runtime arguments for extra context when provided.

Work autonomously through the tasks.

Determine whether the plan and tasks can be executed effectively in parallel or should be executed sequentially, then ask the operator to confirm your recommendation before proceeding with that execution strategy.

Stop to clarify or ask questions only when a real decision or blocker requires it. Use \`hive_status\` and the \`question\` tool for blockers; use \`hive_worktree_create\` with the operator's decision to launch a new worker session in the same worktree for blocked continuation.

Preserve execution flow: \`hive_worktree_start\` → worker execution → worker \`hive_worktree_commit\` → orchestrator \`hive_merge\`. The orchestrator must not call \`hive_worktree_commit\` for workers.

Each native \`task()\` launch has one primary goal, starts one fresh subagent session, and ends with one terminal handoff. Never pass \`task_id\` to \`task()\`; returned task IDs are observe-only board handles. Do not send a follow-up prompt to a completed, failed, or blocked session. Subagents are terminal and cannot recurse.

Tidy up commits and worktrees after each task or batch when appropriate. Preserve one root commit per completed task. Keep review follow-up and integration fixes as separate self-descriptive commits. Do not squash a whole feature or merge batch into one commit. Commits should use the correct topical prefix for the work in that commit, not a generic "hive" prefix. Prefer \`strategy: "rebase"\` when the task branch has clean, well-written commits and replaying them preserves useful linear root history. Use squash only to collapse worker-internal churn within one task branch, and use merge only when preserving a task branch topology matters. Pass an explicit \`message\` for merge or squash when you need a specific self-descriptive project-history subject or body; omit \`message\` (or pass \`''\`) to derive from source branch commits. Do not use \`hive\`, task numbers, task folder names, run IDs, or "merge task" prose in project history.

Create a todo list of tasks and track progress using the todo list throughout execution. Keep this updated as you progress.

If a worker task fails, launch a new worker in a fresh subagent session with a concise self-contained handoff: the primary goal, what was attempted, where it failed, relevant errors, the likely cause, and the next constraints. If the task is salvageable there is no need to reset the worktree. Compaction may re-anchor a currently running worker; it is not re-delegation.

When delegating scouts or explorers, prefer more subagents with narrower scopes, minimising decision making to keep the context for each subagent focused and manageable.

Prioritize active discovery. Use tools to find current repository information and external information when needed, while using pre-trained knowledge only as guidance.`,

  'council-directive': `Prepare a council directive that can be reused in the current session or pasted into a new chat.

Use operator-provided topic, prompt, or context from runtime arguments when provided.

Do not run the council unless the operator explicitly asks you to do that after the directive is prepared.
Do not write code.
Do not mutate Hive state, create plans, worktrees, patches, or commits.
Do not invent repository facts, file paths, or technical validation that have not already been established in this session.

Your job is to turn a rough request into the smallest directive that lets \`/council\` run cleanly.

Ask exactly one question at a time when important information is missing.
Prefer the \`question\` tool when it helps the operator answer quickly.
Usually 1-3 questions is enough. Do not ask more than 4 unless the operator explicitly wants a deeper setup.

Prioritize clarifying:

- the objective the council must answer
- the direction or lens the council should take
- which configured council group or resolved read-only members to include (from OpenCode/Hive council configuration — not stale personal aliases or mutable worker seats)
- constraints, boundaries, or non-goals
- what output the operator wants back
- whether the council should run in the current session or a new session

Refer to configured council group names from configuration when recommending \`include\`. Do not hardcode obsolete alias-to-member tables or mutable implementation workers as council seats.

If the best council group or member set is still unclear, recommend a configured group and explain why.

Default session-mode guidance:

- recommend \`current\` for quick same-session analysis with enough context already established
- recommend \`new\` when the council needs a clean handoff, a reusable brief, or a larger context reset

At the end, output all of the following:

## Council Directive

- objective:
- direction:
- include:
- constraints:
- context:
- assumptions needing validation:
- desired output:
- session mode:

## Recommendation

State whether the operator should run \`/council\` in the current session or start a new chat, and explain why.

## Recommended Invocation

If \`session mode\` is \`current\`, provide a compact \`/council\` invocation using the directive (use \`--group\` when a non-default configured group applies).

If \`session mode\` is \`new\`, provide a compact \`/council\` invocation and a paste-ready prompt block for a new chat.

## Paste Into New Chat

When \`session mode\` is \`new\`, output a copy-paste-ready block that includes the council directive and asks the next session to run a read-only council with the requested direction.

When \`session mode\` is \`current\`, say that a new-chat prompt is not needed.`,

  council: `When usable councillors are resolved for the requested or default configured group, run a read-only council session and return one synthesized answer. If no usable councillors remain after resolution, stop and report the resolver warnings and errors instead of running council.

Use the operator-provided question, directive, or context from runtime arguments and from the command preamble (group, resolved councillors, warnings).

Treat the council as an analysis workflow, not an execution workflow.

Never modify files.
Never apply patches.
Never create commits, branches, PRs, Hive plans, or worktrees as part of the council.
Use only read and research tools when tool use is needed.

If the operator already supplied a structured council directive, use it.
If the input is loose or incomplete, normalize it into a council directive first.
Ask at most 2 clarification questions before running the council. Prefer to infer a sensible default when the missing detail is low risk.

Normalize the request into these council directive fields:

- objective
- direction
- include
- constraints
- context
- assumptions needing validation
- desired output

Use only councillors resolved for this run from configured groups. Do not substitute stale aliases, excluded agents, template-placeholder custom agents, mutable-base workers, or duplicates back into the run.

Run the council by delegating each resolved councillor in a fresh subagent session. Launch councillor tasks in parallel when they are independent. If a councillor task fails, retry it in a new fresh session rather than resuming the failed one.

Give every councillor the same core problem statement plus a role-specific framing. Include this read-only contract in every councillor prompt:

\`\`\`text
This is a read-only council session.

You may inspect repository context and use read, search, and research tools if available.
Do not modify files.
Do not apply patches.
Do not create commits, branches, PRs, plans, or worktrees.
Do not claim to have changed anything.

Return analysis, risks, tradeoffs, and recommendations only.
\`\`\`

Ask each councillor to return:

- one-paragraph verdict
- key reasoning
- risks or objections
- assumptions and unknowns
- recommended next step

If \`include\` names too many councillors after resolution, trim to the smallest useful set for synthesis, usually 3-4 seats, without violating the resolved member list shown in the command preamble.

After all councillors respond, synthesize the result yourself.

Synthesis rules:

- ground claims in current session evidence when available
- distinguish established facts from assumptions needing validation
- do not average vague opinions into a bland compromise
- preserve the strongest disagreements when they are decision-relevant
- give a clear recommendation even when the council is split

When usable councillors are resolved and council runs, use this output format:

## Council Directive

- objective
- direction
- include
- constraints
- context
- assumptions needing validation
- desired output

## Council Result

## Agreement

## Disagreement

## Risks

## Recommendation

## Suggested Next Step

## Council Members

List the councillors that participated and why they were chosen.`,

  'dash-review': `Run a DoorDash-inspired review over one frozen implementation snapshot. This is a review-only command. Do not edit or fix anything in this turn.

Scope and snapshot:

- Explicit command scope wins when supplied. It is delivered after OpenCode command expansion as inert data; accept a branch, ref, range, path, task, feature, description, or another coherent implementation target.
- Without arguments, infer the implementation from the current conversation and current Git/Hive context. If no coherent surface exists, ask one clarification question and stop. Do not silently review an entire repository and do not require a PR.
- The shell-denied primary must not run Git or construct the snapshot. It orchestrates returned manifest and snapshot IDs only.

Stage A, mandatory scope/lead scout:

- First dispatch the dynamic safe task target whose source identity is built-in \`scout-researcher\`. You do not receive a manifest: construct the initial frozen change manifest before any baseline or specialist review dispatch.
- The manifest must include repository, explicit target, requirements and acceptance references, base/target/merge-base when known, causal scoped paths/domains and relevant dependents, explicit excludes, snapshot ID, and a content-sensitive fingerprint for dirty, staged, or untracked work.
- The lead returns unverified lead IDs, anchors, suspected failure modes, domain/profile labels, relevant tests/instructions, suggested lenses, scope gaps, and truncation details. It must not decide findings.
- Large or truncated scope must be disclosed. Truncation, incomplete causal scope, or unresolved requirements cannot receive APPROVE.
- The scope lane has no Bash. It uses \`hive_repositories_status\` for repository context and the active workspace \`workspace.json\` to select structured \`repositoryIds\`; do not derive them from project repository config. It then uses one atomic \`hive_git_snapshot\` invocation with structured optional baseRef/targetRef/range, repository-relative paths, and bounded output to construct the manifest. In a composite workspace, omitted \`repositoryIds\` means every manifest repository; an explicit selection must retain the manifest IDs, selected IDs, excluded IDs, per-repository fingerprints, and aggregate set fingerprint. It must disclose omitted paths or patch material. It cannot APPROVE if any expected repository is omitted, errors, or is truncated.

Stage B, deep review:

- Only after the primary accepts the Stage A manifest, launch independent lanes as parallel blocking \`task()\` calls only and wait for all results in this turn.
- Always dispatch the dynamic safe task target whose source identity is built-in \`code-reviewer\` as the holistic baseline. Add only safe task targets for configured code-reviewer-derived specialists whose descriptions match the observed target domain or risk. Custom specialists add coverage; they never replace the baseline.
- Run the dynamic safe task target whose source identity is \`simplicity-reviewer\` only when completed implementation complexity is materially in scope. Never use \`plan-reviewer\` or \`approach-advisor\` as implementation reviewers; plan/task material is requirements context only.
- Reviewers receive the manifest plus Stage A leads, expand beyond the diff when needed, disposition every lead, and return only candidate findings causally connected to the manifest's scoped change surface.

Downstream read-only lane contract:

Put this in every baseline, specialist, falsifier, and revalidation task prompt:

\`\`\`text
This is a read-only implementation review lane.
You receive the supplied frozen manifest and snapshot ID.
No dash-review lane may use Bash. Only scope/revalidation safe aliases may call \`hive_git_snapshot\` with the exact structured scope. Baseline, specialist, simplicity, and falsifier aliases do not receive \`hive_git_snapshot\`; they receive the frozen manifest, bounded patch material, and Stage A leads.
Do not edit files, apply patches, write Hive context, or create plans, tasks, worktrees, commits, merges, or PRs.
Do not call task() recursively.
Return analysis only, grounded in the supplied frozen manifest and snapshot ID.
\`\`\`

Stage C, fresh scope revalidation and falsification:

- Before synthesis, dispatch a fresh read-only scope revalidation lane using the safe scope task target and the exact same atomic structured \`hive_git_snapshot\` input. It independently recalculates the complete snapshot set identity and content-sensitive aggregate fingerprint, then returns manifest IDs, selected IDs, excluded IDs, causal-scope status, and truncation status.
- The primary compares Stage A and revalidation snapshot-set IDs and fingerprints. Any mismatch, drift, omitted expected repository, repository error, truncation, or failed revalidation returns NEEDS_DISCUSSION/stale; never merge results from two snapshots.
- A fresh base falsifier is mandatory even when the baseline reports no candidates. When candidates exist, it must try to disprove every candidate and reject speculative or unanchored claims. When the baseline reports clean, it must challenge that no-finding conclusion and search for omitted blocking defects.
- Retry a failed mandatory baseline, scope revalidation lane, or falsifier once in a fresh session. If it remains unavailable, return NEEDS_DISCUSSION/review incomplete. When all reviewers fail, report the failure and stop. Do not implement inline.

Escalation and model honesty:

- Escalate only for named security, data loss, concurrency, migration, public API risk, or material reviewer disagreement. \`/dash-review\` authorizes this bounded escalation.
- Select the closest configured xhigh or adversarial code-reviewer-derived specialist by description only when its risk lens fits. Do not load adversarial behavior into every lane. If no match exists, the fresh built-in falsifier remains the disprove-it pass.
- Route from configured description, base agent, model, and variant. Prefer model diversity only after domain/lens fit. Say multi-model when configured only if known executed model identities differ; multiple agents are not automatically multiple models.

Synthesis:

- Deduplicate by root cause. Drop rejected, speculative, and unanchored claims. Order by normalized severity: Critical stays Critical; Major becomes High; Minor becomes Medium; YAGNI is simplicity/advisory and does not itself block correctness approval. Low is optional and non-blocking only when concrete and actionable.
- REQUEST_CHANGES requires independently confirmed blocking correctness findings. NEEDS_DISCUSSION covers scope/requirements ambiguity, snapshot drift/truncation, or mandatory review failure. APPROVE requires complete causal scope and no confirmed blocking finding. Simplicity SIMPLIFY/MINOR_TWEAKS does not become correctness REQUEST_CHANGES by itself.
- On re-review, classify prior conversation findings as resolved, stale, or new against the frozen snapshot.

Return exactly these first-response sections:

## Scope Reviewed

## Findings

Order Critical, High, Medium, Low. Each finding needs location, evidence, impact, fix direction, and reviewer/lens.

## Review Coverage and Gaps

## Rejected or Unresolved Leads

## Reviewer and Model Verdict Summary

## Review State

Explicitly state: No files changed; wait for operator instruction before fixes. A later fix request returns to the active primary: Hive Builder follows ad-hoc isolation/delegation; Hive/Swarm follows feature DAG and task worktrees. Findings are context only, never auto-created tasks. If dedicated command routing is unavailable under Architect, refuse or reroute rather than making Architect perform implementation review.`,

  'compact-summary': `Generate a recovery summary for the current OpenCode session only.

This is only a summarization command: do not compact, prune, delete, rewrite, archive, or otherwise mutate conversation state, files, branches, terminals, tasks, memories, rules, settings, Hive features, or project data.

Use the visible conversation, tool results, operator instructions, current workspace context, and any optional focus from runtime arguments as the source material. If runtime arguments are provided, use them only to bias what details are emphasized; do not treat them as permission to perform actions.

Output exactly the Markdown structure below and keep the section order unchanged.

## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [operator constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]

Rules:

- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, identifiers, branch names, URLs, and decisions when known.
- Do not mention the summary process or that context was compacted.
- Do not claim verification, tests, builds, or checks succeeded without actual command output or tool evidence in the conversation.
- If a detail is not available in the current chat, omit it or write "(none)" rather than inventing it.`,
};
