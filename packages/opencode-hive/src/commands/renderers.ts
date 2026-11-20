import type { HiveCommandKey } from './registry.js';
import type { HiveCommandContext, HiveCommandRenderers } from './types.js';
import { renderCommandBehavior, type CommandBodyKey } from './command-bodies.js';
import { nativeCall, readTransportInstruction, skillCall } from '../runtime/host-profile.js';

type CommandSectionInput = {
  doItems: string[];
  doNotItems: string[];
  outputItems: string[];
  details?: string[];
  backgroundItems?: string[];
};

function formatList(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function renderSections(input: CommandSectionInput): string {
  const sections: string[] = [];

  if (input.details && input.details.length > 0) {
    sections.push(input.details.join('\n'));
  }

  if (input.doItems.length > 0) {
    sections.push(`Do:\n${formatList(input.doItems)}`);
  }
  if (input.doNotItems.length > 0) {
    sections.push(`Do not:\n${formatList(input.doNotItems)}`);
  }

  if (input.backgroundItems && input.backgroundItems.length > 0) {
    sections.push(`Background:\n${formatList(input.backgroundItems)}`);
  }

  sections.push(`Output expected:\n${formatList(input.outputItems)}`);
  return sections.join('\n\n');
}

/** Invocation context and mechanics first, then the command's static body (see command-bodies.ts). */
function renderHybridCommand(
  command: CommandBodyKey,
  context: HiveCommandContext,
  input: CommandSectionInput,
): string {
  const wrapper = renderSections({
    details: input.details,
    doItems: input.doItems,
    doNotItems: input.doNotItems,
    backgroundItems: input.backgroundItems,
    outputItems: input.outputItems,
  });
  return `${wrapper}\n\n---\n\n${renderCommandBehavior(context.host)[command]}`;
}

function topicOrCurrent(args: string, fallback: string): string {
  const topic = args.trim();
  return topic || fallback;
}

/** Host-supplied prose after the command, kept whole for the agent to read; nothing is parsed out of it. */
function operatorText(command: string, args: string): string {
  return `Operator text after /${command} (blank when none):\n<operator-text>\n${args}\n</operator-text>`;
}

function backgroundItems(
  context: HiveCommandContext,
  items: string[],
): string[] | undefined {
  return context.backgroundGuidance.available ? items : undefined;
}

function configuredDashReviewCandidates(context: HiveCommandContext, suiteAudit = false): string {
  const candidates = context.dashReviewLanes
    .filter((lane) => !suiteAudit || lane.baseAgent === 'code-reviewer' || lane.baseAgent === 'simplicity-reviewer')
    .map((lane) => {
      const model = lane.model ?? 'unknown';
      const variant = lane.variant ?? 'unknown';
      return `${lane.sourceAgent} (base: ${lane.baseAgent}; model: ${model}; variant: ${variant}; ${lane.description}; Task target: ${lane.taskTarget})`;
    });
  return candidates.length > 0 ? candidates.join('\n') : 'none registered';
}

function configuredVulnerabilityReviewCandidates(context: HiveCommandContext): string {
  const candidates = (context.vulnerabilityReviewLanes ?? []).map((lane) => {
    const model = lane.model ?? 'unknown';
    const variant = lane.variant ?? 'unknown';
    return `${lane.taskTarget} (role: ${lane.role}; source: ${lane.sourceAgent}; model: ${model}; variant: ${variant}; ${lane.description})`;
  });
  return candidates.length > 0 ? candidates.join('\n') : 'none registered';
}

export const hiveCommandRenderers: HiveCommandRenderers<HiveCommandKey> = {
  interview(args, context) {
    return renderHybridCommand('interview', context, {
      details: [`Topic: ${topicOrCurrent(args, 'clarify the operator idea')}`],
      doItems: [
        'Load the `grilling` skill and use its shared interaction engine.',
        'Run the whole interaction as the skill\'s continuous loop in this invocation.',
        'End with the skill\'s explicit three-way alignment confirmation and its closing readback.',
      ],
      doNotItems: [],
      backgroundItems: backgroundItems(context, [
        'Use direct retrieval, one agent, or multiple agents, including independent background lanes when useful, only for bounded material research questions and based on their evidence needs and dependencies.',
        'Continue asking independent operator decisions while research runs; wait only when all remaining material decisions depend on pending evidence.',
      ]),
      outputItems: [
        '## Interview Summary and ## Recommended Next Step, followed by three-way alignment confirmation and the skill\'s closing readback. The next step is whatever the clarified idea calls for, such as an answer, ad-hoc work, `/hive-plan`, or none.',
      ],
    });
  },

  grill(args, context) {
    return renderHybridCommand('grill', context, {
      details: [`Context: ${topicOrCurrent(args, 'the context supplied in this conversation')}`],
      doItems: [
        'Load the `grilling` skill and use its shared interaction engine.',
        'Run the whole interaction as the skill\'s continuous loop in this invocation.',
        'End with the skill\'s explicit three-way alignment confirmation and its closing readback.',
      ],
      doNotItems: [],
      backgroundItems: backgroundItems(context, [
        'Use direct retrieval, one agent, or multiple agents, including independent background lanes when useful, only for bounded material research questions and based on their evidence needs and dependencies.',
        'Continue asking independent operator decisions while research runs; wait only when all remaining material decisions depend on pending evidence.',
      ]),
      outputItems: [
        'The skill\'s alignment brief with acceptance criteria added, followed by three-way alignment confirmation and the skill\'s closing readback.',
        'After confirmation, recommend the next step the result warrants, unless the operator already asked for the next stage.',
      ],
    });
  },

  investigate(args, context) {
    return renderHybridCommand('investigate', context, {
      details: [operatorText('investigate', args)],
      doItems: [],
      doNotItems: [],
      outputItems: [
        'What is happening and the evidence for it; the explanations you ruled out and how; the fix you would propose, with success criteria that would show it worked; and the assumptions, gaps, and decisions you need from me.',
      ],
    });
  },

  walkthrough(args, context) {
    return renderHybridCommand('walkthrough', context, {
      details: [operatorText('walkthrough', args)],
      doItems: [],
      doNotItems: [],
      outputItems: [
        'The explanation with its examples, then what it rests on (what you read or ran) and the gaps that matter for my question.',
      ],
    });
  },

  'implementation-brief'(args, context) {
    return renderHybridCommand('implementation-brief', context, {
      details: [`Subject: ${topicOrCurrent(args, 'the current operator request')}`],
      doItems: ['Produce one copy-paste-ready brief for /hive-plan to turn into the formal Hive plan.'],
      doNotItems: [],
      backgroundItems: backgroundItems(context, [
        'Use independent background research only when foreground brief assembly can safely continue without those results.',
      ]),
      outputItems: ['Output only the final brief in one fenced code block.'],
    });
  },

  'hive-plan'(args, context) {
    return renderHybridCommand('hive-plan', context, {
      details: [`Planning input: ${topicOrCurrent(args, 'the current spec or brief')}`],
      doItems: [
        'Create the feature when needed, then target that feature explicitly in context and plan calls. Feature creation and explicit feature arguments do not change the selected session route. Load context-engineering for hash-guarded reads and writes; do not mass-read every note.',
        'Include documentation updates for non-ad-hoc work when user-facing behavior, setup, install flow, or operator workflow changes.',
      ],
      doNotItems: [],
      backgroundItems: backgroundItems(context, [
        'Use independent scout validation in background lanes when it can run without blocking plan framing.',
      ]),
      outputItems: [
        'Feature, plan readback, task breakdown, recommended execution order, session strategy, operator input, and decision points.',
      ],
    });
  },

  'approve-sync-plan'(args, context) {
    return renderHybridCommand('approve-sync-plan', context, {
      details: args.trim() ? [`Additional operator input: ${args.trim()}`] : undefined,
      doItems: [
        'Resolve the intended feature, then issue independent explicit hive_status and hive_plan_read calls in one response/step before approval. Note the contentHash from that hive_plan_read and check which plan assessments name it.',
        'Invoking this command requests approval and does not waive the plan assessments described below. Approve without them only when the operator explicitly directs approval without review.',
        'Approve and sync that same explicit feature with hive_plan_approve({ feature, expectedRevision, sync: true }), using the reviewed hive_plan_read revision; add refreshPending: true when pending specs need refresh. Inspect both approval and sync outcomes, approvalPersisted, and failure reason/stage; validation writes nothing, metadata failure can leave the marker persisted, and an unchanged retry may return alreadyApproved: true.',
        'Apply the sync retry rules in this command when sync failed. Then read back status and its single top-level tasks list; status: null integrity entries need inspection and repair, never execution.',
        'Build ## Recommended Execution Order from the synced stored dependsOn graph in that readback, including resolved implicit sequential shorthand. A milestone is a target task, its own dependsOn recursively (the unfinished prerequisite closure including the target), and any explicitly named companion tasks. Companions are explicit requested scope, not dependsOn edges, and are never inferred from topic, earlier numbering, or readiness. Use exact feature name and task folder/title, not numerical A-to-B ranges or edges inferred from numbering.',
        'Require a table under ## Recommended Execution Order with columns for exact target task number/folder/title, expected observable behavior at that stopping point grounded in approved plan outcomes, projected NEW unfinished task count, and the actual task folders counted (inline or bounded per-row accompanying lists), showing companions: none when unnecessary. Counts are projected incremental counts assuming prior listed milestones completed: each unfinished task counts once, in the first suggested milestone that needs it, and every counted set shows its exact task folders; never calculate counts from numerical intervals. Report cancelled or missing roots/prerequisites and invalid graphs as blockers, not achievable projections. The operator can combine or omit stopping points, and omitted milestones or changed order can change counts. Execution must re-read current status and recompute scope on every request instead of assuming prior suggestions ran.',
        'Before writing the table, load executing-plans and read its references/task-milestones.md section "Suggesting milestones": it holds target and companion selection, outcome grounding, the incremental-count calculation, and worked examples. When executing-plans or that reference is unavailable (disabled, overridden without its references, or no skill access under this primary), stop after the status readback: report the approval and sync outcomes exactly as persisted, say that the milestone projection was not produced, and do not infer scope from task numbers or search generated skill caches.',
        'In ## Session Strategy, link copy-paste run/continue prompts to the table targets without duplicating the detailed table. Give prompts with concrete names substituted: Run feature "<feature>" until task "<task-folder>" (<task-title>) is complete. Then: Continue feature "<feature>" until task "<next-task-folder>" (<next-task-title>) is done. Append Also complete companion task "<companion-folder>" (<companion-title>) before stopping. for each listed companion, omitting that suffix when none. The prompt must carry the whole explicit scope into a fresh session with status alone, without a persistent milestone manifest. Explain that each prompt includes unfinished prerequisites of all named roots, excludes unrelated and descendant tasks, and retains verification, review, integration, and cleanup obligations. Bare target requests include only the target closure; stop only after the target AND every named companion are done with their gates complete.',
        'Include a terminal verification handoff in Session Strategy with the concrete feature name: Run final verification for feature "<feature>" and complete it only after the required checks pass. Explain that this is a separate continuation after no unfinished feature tasks remain, routed to executing-plans Step 6 and the existing full-feature verification/completion procedure, carrying deferred checks and applicable cleanup.',
      ],
      doNotItems: [],
      outputItems: [
        '## Feature, ## Plan Readback, ## Task Breakdown, ## Recommended Execution Order, ## Session Strategy, ## Additional Operator Input, ## Decision Points For Operator.',
      ],
    });
  },

  'start-execution'(args, context) {
    return renderHybridCommand('start-execution', context, {
      details: args.trim() ? [`Context: ${args.trim()}`] : undefined,
      doItems: [
        'Follow explicit operator execution direction; otherwise sequence from dependencies, owned paths, and shared resources. Ask only when a material scheduling or authority decision remains unresolved.',
        'When direction is run/continue a feature until a target task is complete/done, including an explicit companion suffix, load executing-plans, apply its Target Task Milestones procedure, and read its references/task-milestones.md section "Executing requested milestones" before dispatch and on resumption. Preserve the exact feature, target, and explicitly named companions from the suggested prompt; report milestone scope and stop at that boundary. When executing-plans or that reference is unavailable (disabled, overridden without its references, or no skill access under this primary), dispatch no milestone work: report the exact feature, target, and companions requested, the status you could read, and that the procedure was unavailable; do not infer scope from task numbers or search generated skill caches.',
        'Use todos to track task progress and transitions.',
        'Reinspect the destination at each later checkpoint. Before dispatch, call hive_feature_select only when the selected route is unset or differs from the dispatch target, or the selection evidence below is missing or uncertain, then issue the native Forager ' + nativeCall(context.host) + ' call with that path in its authored prompt. Reuse a matching selection across a same-feature batch only when this session\'s most recent route-changing call visible in context is `hive_feature_select` for that same feature, with no later explicit-null or other-feature selection. When that evidence is not visible (for example after compaction or a summary, at session start, or in mixed ad-hoc/feature batches), or you are uncertain, call `hive_feature_select` for the dispatch target. Explicit null stays featureless unless the dispatch intentionally changes target.',
      ],
      doNotItems: [],
      backgroundItems: backgroundItems(context, [
        'Use independent background-first orchestration only for runnable tasks or validation lanes.',
      ]),
      outputItems: [
        'Confirmed strategy, todos, launched or queued tasks, blockers, and merge/verification expectations.',
      ],
    });
  },

  implement(args, context) {
    return renderHybridCommand('implement', context, {
      details: [operatorText('implement', args)],
      doItems: [
        'Load the `starting-ad-hoc-implementation` skill and follow it with this conversation and the operator text above; blank operator text means the conversation alone scopes the work.',
      ],
      doNotItems: [],
      outputItems: [
        'The scope you are implementing in a few lines, then the ad-hoc lifecycle\'s result with its verification evidence, or the one decision or limitation that stops the work.',
      ],
    });
  },

  'merge-to-main'(args, context) {
    return renderHybridCommand('merge-to-main', context, {
      details: [operatorText('merge-to-main', args)],
      doItems: [],
      doNotItems: [],
      outputItems: [
        'The source and destination with their commits, the baseline, how it was integrated and the resulting commit, the review findings and what happened to each, the checks on the candidate and on the destination with their results, what was cleaned up and what was kept, and anything still blocking.',
      ],
    });
  },

  council(args, context) {
    return renderHybridCommand('council', context, {
      details: [operatorText('council', args)],
      doItems: [
        `Load the \`council\` skill with ${skillCall(context.host, 'council')} and follow it, with the operator text above as the council directive. Blank text means the current operator request is the directive.`,
      ],
      doNotItems: [
        'If the `council` skill or the hive_councils_list tool is unavailable, say which one is missing and launch nobody. Do not search generated skill caches for a copy of the skill.',
      ],
      outputItems: ['The council result the `council` skill defines, or the reason no council was convened.'],
    });
  },

  'dash-review'(args, context) {
    return renderSections({
      details: [
        `Review input: ${topicOrCurrent(args, 'the current checkout and operator request')}`,
        `Configured reviewer candidates:\n${configuredDashReviewCandidates(context)}`,
      ],
      doItems: [
        'Resolve the target and operator steering; understand the material change, governing requirements, and relevant consumers before delegation.',
        'Dispatch best-fit reviewers for evidence-linked leads and applicable obligations; preserve explicitly requested reviewer scope.',
        'Independently challenge material candidates, run discriminating tests when useful and authorized, then adjudicate by evidence.',
        'When running the candidate would settle a question reading cannot, follow Runtime Exercise in your instructions: ask before running development code unless an operator instruction already covers it, then send an Investigator.',
      ],
      doNotItems: [
        'Do not edit reviewed source. Outside an authorized Runtime Exercise, do not create a review workspace on your own.',
        'Do not silently skip a required configured reviewer or claim a clean review while that obligation or material challenge is open.',
      ],
      outputItems: [
        'Severity-ordered findings with confidence and source locations; a compact Review Basis, unresolved questions, and required-review or proof gaps.',
        'Structural proposals kept separate as operator decisions; they do not block No action.',
      ],
    });
  },

  'test-audit'(args, context) {
    return renderSections({
      details: [
        `Test audit scope: ${topicOrCurrent(args, 'the current repository')}`,
        `Configured reviewer candidates:\n${configuredDashReviewCandidates(context, true)}`,
      ],
      doItems: [
        `Load the effective test-quality skill with ${skillCall(context.host, 'test-quality')} and follow its audit guidance, whether inline in SKILL.md or in its own referenced material. Read the supplied audit reference when directed. If the guidance needed for the audit is unavailable, report the affected audit gap and stop; respect native overrides and disabled skills without searching generated caches.`,
        'Audit the named roots or natural-language scope as a repository/suite audit, not just the current diff. Use your existing understanding-led review and independent challenge method with code and simplicity reviewer roles within their permissions; require each selected reviewer to load test-quality.',
      ],
      doNotItems: [
        'Do not fix or delete tests, edit source, or start remediation. Remediation requires an explicit follow-up implementation request through an authorized implementation lifecycle.',
        'Do not run the candidate without the authorization required by your Runtime Exercise method.',
      ],
      outputItems: [
        'An evidence-backed test-quality report with test/source anchors, keep/rewrite/fold/remove recommendations, preserved unique coverage, and covered/uninspected areas. Report findings first; sampling is not exhaustive coverage.',
      ],
    });
  },

  'vuln-review'(args, context) {
    return renderSections({
      details: [
        `Review input: ${topicOrCurrent(args, 'the current checkout and operator request')}`,
        `Configured vulnerability reviewers:\n${configuredVulnerabilityReviewCandidates(context)}`,
      ],
      doItems: [
        `Resolve the requested source with ordinary tools, load ${skillCall(context.host, 'security-audit')} for the audit method, and follow your Review Sequence.`,
        'Run every explicitly requested specialist and preserve a snapshot source fingerprint when one is used.',
        'Reproduce a lead locally, or run an active simulated pentest of a disposable local instance that the operator asked for, only as a Runtime Exercise that its Authorization covers; reviewing a lead does not by itself permit running code.',
      ],
      doNotItems: ['Do not edit source, exploit live systems, scan remote networks or hosts, or silently skip requested reviewers.'],
      outputItems: [
        'Plain-English vulnerability findings first, severity-ordered and each labelled Observed in local run or Traced in source, with evidenced attacker-to-impact paths, root causes, locations, and source identity; then unresolved leads and Coverage, and, when a prior report is compared, each earlier finding marked Fixed, Still reproducible, or Unverified.',
      ],
    });
  },

  worklog(args, context) {
    return renderHybridCommand('worklog', context, {
      details: [`Request: ${topicOrCurrent(args, 'where the current work stands')}`],
      doItems: [
        ...[readTransportInstruction(context.host, ['hive_worklog_read', 'hive_worklog_list'])].filter(Boolean),
        'Choose the log from the request. A named feature reads `hive_worklog_read` with `ref: { kind: "feature", featureName }`; a pasted key reads its ref (`feature:<name>`, or `session:<owner>:<sessionId>` where only the first colon after the owner separates the fields); otherwise omit ref, which reads the feature selected for this session or this session\'s own log.',
        'Call `hive_worklog_list` when the request asks which logs exist or names a log you cannot resolve to one ref; page it with nextCursor as needed.',
        'Start with the brief view. Expand with the history view for earlier checkpoints, the facts view for recorded task rows, and nextCursor or a larger maxBytes for more, only as far as the request needs.',
        'When the request asks for current status or reconciliation, compare the saved briefing with the checkpoints and facts that came after it, and give the difference as your unsaved synthesis.',
      ],
      doNotItems: ['Do not call `hive_worklog_record` or change any other state from this command.'],
      outputItems: [
        'The log title, key and ref; the saved briefing with its author and time; what changed since it; and any unsaved synthesis labelled as yours. When the log is missing or a read fails, say so with the reason.',
      ],
    });
  },

  handoff(args, context) {
    return renderHybridCommand('handoff', context, {
      details: [operatorText('handoff', args)],
      doItems: [],
      doNotItems: [],
      outputItems: [
        'One fenced code block holding the handoff, then one line naming anything you left out or could not confirm.',
      ],
    });
  },

  'compact-summary'(args, context) {
    return renderHybridCommand('compact-summary', context, {
      details: args.trim() ? [`Focus: ${args.trim()}`] : undefined,
      doItems: [],
      doNotItems: [],
      outputItems: ['A recovery summary built only from conversation and tool evidence, in the exact compact-summary template sections.'],
    });
  },
};
