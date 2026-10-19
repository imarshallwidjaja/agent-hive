import type { HiveCommandKey } from './registry.js';
import type { HiveCommandContext, HiveCommandRenderers } from './types.js';
import { renderCommandBehavior, type CommandBodyKey } from './command-bodies.js';
import { nativeCall } from '../runtime/host-profile.js';
import { resolveCouncilMembers } from './council.js';

type CommandSectionInput = {
  doItems: string[];
  doNotItems: string[];
  outputItems: string[];
  details?: string[];
  backgroundItems?: string[];
};

type ParsedCouncilArgs = {
  group?: string;
  directive: string;
  error?: string;
};

const COUNCIL_USAGE = 'Usage: /council [--group <group>] <directive>';

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

function backgroundItems(
  context: HiveCommandContext,
  items: string[],
): string[] | undefined {
  return context.backgroundGuidance.available ? items : undefined;
}

function configuredGroupNames(context: HiveCommandContext): string {
  const names = Object.keys(context.council.groups ?? {});
  return names.length > 0 ? names.join(', ') : 'none configured';
}

function configuredDashReviewCandidates(context: HiveCommandContext): string {
  const candidates = context.dashReviewLanes
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
    const lens = lane.lens ? `; lens: ${lane.lens}` : '';
    return `${lane.taskTarget} (role: ${lane.role}; source: ${lane.sourceAgent}${lens}; model: ${model}; variant: ${variant}; ${lane.description})`;
  });
  return candidates.length > 0 ? candidates.join('\n') : 'none registered';
}

function tokenizeArgs(args: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(args)) !== null) {
    tokens.push((match[1] ?? match[2] ?? match[3]).replace(/\\(["'])/g, '$1'));
  }

  return tokens;
}

function parseCouncilArgs(args: string): ParsedCouncilArgs {
  const tokens = tokenizeArgs(args);
  const directiveTokens: string[] = [];
  let group: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === '--group') {
      const value = tokens[index + 1];
      if (!value || value.startsWith('--')) {
        return { directive: directiveTokens.join(' ').trim(), error: `${COUNCIL_USAGE}\nMissing value for --group.` };
      }
      group = value;
      index += 1;
      continue;
    }

    if (token.startsWith('--')) {
      return { directive: directiveTokens.join(' ').trim(), error: `${COUNCIL_USAGE}\nUnknown flag: ${token}` };
    }

    directiveTokens.push(token);
  }

  return { group, directive: directiveTokens.join(' ').trim() };
}

function renderUsage(context: HiveCommandContext, error: string): string {
  return renderSections({
    details: [error],
    doItems: [
      'Provide deterministic council input as /council --group <group> <directive>, or omit --group to use the configured default group.',
      'Treat free-text tokens as directive text, not group selectors.',
    ],
    doNotItems: [
      'Do not infer a council group from the first free-text token.',
      'Do not run council when command flags are invalid.',
    ],
    outputItems: ['Usage/help guidance only.'],
  });
}

export const hiveCommandRenderers: HiveCommandRenderers<HiveCommandKey> = {
  interview(args, context) {
    return renderHybridCommand('interview', context, {
      details: [`Topic: ${topicOrCurrent(args, 'clarify the operator idea')}`],
      doItems: [
        'Load the `grilling` skill and use its shared interaction engine.',
        'Run the whole interaction as the skill\'s continuous loop in this invocation.',
        'End with the skill\'s explicit three-way alignment confirmation.',
      ],
      doNotItems: [],
      backgroundItems: backgroundItems(context, [
        'Use direct retrieval, one agent, or multiple agents, including independent background lanes when useful, only for bounded material research questions and based on their evidence needs and dependencies.',
        'Continue asking independent operator decisions while research runs; wait only when all remaining material decisions depend on pending evidence.',
      ]),
      outputItems: [
        '## Interview Summary and ## Recommended Next Step, followed by three-way alignment confirmation. The next step is whatever the clarified idea calls for, such as an answer, ad-hoc work, `/hive-plan`, or none.',
      ],
    });
  },

  grill(args, context) {
    return renderHybridCommand('grill', context, {
      details: [`Context: ${topicOrCurrent(args, 'the context supplied in this conversation')}`],
      doItems: [
        'Load the `grilling` skill and use its shared interaction engine.',
        'Run the whole interaction as the skill\'s continuous loop in this invocation.',
        'End with the skill\'s explicit three-way alignment confirmation.',
      ],
      doNotItems: [],
      backgroundItems: backgroundItems(context, [
        'Use direct retrieval, one agent, or multiple agents, including independent background lanes when useful, only for bounded material research questions and based on their evidence needs and dependencies.',
        'Continue asking independent operator decisions while research runs; wait only when all remaining material decisions depend on pending evidence.',
      ]),
      outputItems: [
        'The skill\'s alignment brief with acceptance criteria added, followed by three-way alignment confirmation.',
        'After confirmation, name `/hive-plan` as the handoff unless the operator already asked for the next stage.',
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
      // The operator text is inserted as written so multiline prose, quotes, and punctuation reach the agent unchanged.
      details: [`Operator text after /implement (verbatim; blank when none):\n<operator-text>\n${args}\n</operator-text>`],
      doItems: [
        'Load the `starting-ad-hoc-implementation` skill and follow it with this conversation and the operator text above; blank operator text means the conversation alone scopes the work.',
      ],
      doNotItems: [],
      outputItems: [
        'The scope you are implementing in a few lines, then the ad-hoc lifecycle\'s result with its verification evidence, or the one decision or limitation that stops the work.',
      ],
    });
  },

  'council-directive'(args, context) {
    return renderHybridCommand('council-directive', context, {
      details: [
        `Rough input: ${topicOrCurrent(args, 'the current operator request')}`,
        `Configured council groups: ${configuredGroupNames(context)}`,
      ],
      doItems: [
        'Ask one question at a time when needed (max 4) to shape a reusable council directive.',
      ],
      doNotItems: [],
      outputItems: [
        '## Council Directive, ## Recommendation, ## Recommended Invocation, and ## Paste Into New Chat when appropriate.',
      ],
    });
  },

  council(args, context) {
    const parsed = parseCouncilArgs(args);
    if (parsed.error) {
      return renderUsage(context, parsed.error);
    }

    const requestedGroup = parsed.group ?? context.council.defaultGroup ?? 'decision';
    const resolution = resolveCouncilMembers(context.council, context.agents, requestedGroup);
    const directive = parsed.directive || 'Use the current operator request as the directive.';
    const details = [
      `Group: ${resolution.groupName}`,
      ...(resolution.fallbackFrom ? [`Fallback: ${resolution.fallbackFrom} -> ${resolution.groupName}`] : []),
      `Directive: ${directive}`,
      resolution.members.length > 0
        ? `Councillors: ${resolution.members.map((member) => `${member.name} (${member.baseAgent})`).join(', ')}`
        : 'Councillors: none usable',
      ...(resolution.warnings.length > 0 ? [`Warnings:\n${formatList(resolution.warnings)}`] : []),
      ...(resolution.error ? [`Error: ${resolution.error}`] : []),
      'Read-only contract: councillors must not edit files, apply patches, commit, create Hive plans, or create worktrees.',
      'architect-planner must not call planning write tools during a council run.',
    ];

    const councilInput = {
      details,
      doItems: resolution.error
        ? ['Stop and report the council member resolution error with all warnings.']
        : [
            'Run a read-only council with the resolved councillors in the displayed order.',
            'Give every councillor the directive, relevant evidence, read-only contract, and its actual base role from the rendered roster.',
            'Keep Scout-derived seats to evidence, unknowns, and contradictions; do not infer agreement from a missing Scout verdict.',
          ],
      doNotItems: [
        'Do not infer a group from the first free-text token; only --group selects a non-default group.',
        'Do not add unavailable, excluded, template-placeholder, mutable-base, or duplicate councillors back into the run.',
      ],
      backgroundItems: resolution.error
        ? undefined
        : backgroundItems(context, [
            'Independent councillor lanes are native background candidates only from the orchestrating agent.',
            'Wait for native completion notification and reconcile terminal lanes with hive_background_reconcile or hive_background_reconcile_batch before synthesis.',
            'Councillors must not call task recursively.',
          ]),
      outputItems: resolution.error
        ? ['Clear error explaining why no usable council members remain.']
        : ['Council synthesis with recommendation, dissent, evidence quality, assumptions, and follow-up actions.'],
    };

    if (resolution.error) {
      return renderSections({
        details: councilInput.details,
        doItems: councilInput.doItems,
        doNotItems: councilInput.doNotItems,
        backgroundItems: councilInput.backgroundItems,
        outputItems: councilInput.outputItems,
      });
    }

    return renderHybridCommand('council', context, councilInput);
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
      ],
      doNotItems: [
        'Do not edit source or create an automatic review workspace.',
        'Do not silently skip a required configured reviewer or claim a clean review while that obligation or material challenge is open.',
      ],
      outputItems: [
        'Severity-ordered findings with confidence and source locations; a compact Review Basis, unresolved questions, and required-review or proof gaps.',
      ],
    });
  },

  'vuln-review'(args, context) {
    return renderSections({
      details: [
        `Review input: ${topicOrCurrent(args, 'the current checkout and operator request')}`,
        `Configured vulnerability reviewers:\n${configuredVulnerabilityReviewCandidates(context)}`,
      ],
      doItems: ['Resolve the requested source with ordinary tools.', 'Run every explicitly requested specialist and preserve a snapshot source fingerprint when one is used.', 'Report evidenced attacker-to-impact paths and root causes.'],
      doNotItems: ['Do not edit source, exploit live systems, scan networks, or silently skip requested reviewers.'],
      outputItems: ['Severity-ordered vulnerability findings, evidence gaps, and source identity.'],
    });
  },

  worklog(args, context) {
    return renderHybridCommand('worklog', context, {
      details: [`Request: ${topicOrCurrent(args, 'where the current work stands')}`],
      doItems: [
        'Choose the log from the request. A named feature reads `hive_worklog_read({ ref: { kind: "feature", featureName } })`; a pasted key reads its ref (`feature:<name>`, or `session:<owner>:<sessionId>` where only the first colon after the owner separates the fields); otherwise omit ref, which reads the feature selected for this session or this session\'s own log.',
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

  'compact-summary'(args, context) {
    return renderHybridCommand('compact-summary', context, {
      details: args.trim() ? [`Focus: ${args.trim()}`] : undefined,
      doItems: [],
      doNotItems: [],
      outputItems: ['A recovery summary built only from conversation and tool evidence, in the exact compact-summary template sections.'],
    });
  },
};
