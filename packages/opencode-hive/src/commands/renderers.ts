import type { HiveCommandKey } from './registry.js';
import type { HiveCommandContext, HiveCommandRenderers } from './types.js';
import { COMMAND_BEHAVIOR } from './command-bodies.js';
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

  sections.push(`Do:\n${formatList(input.doItems)}`);
  sections.push(`Do not:\n${formatList(input.doNotItems)}`);

  if (input.backgroundItems && input.backgroundItems.length > 0) {
    sections.push(`Background:\n${formatList(input.backgroundItems)}`);
  }

  sections.push(`Output expected:\n${formatList(input.outputItems)}`);
  return sections.join('\n\n');
}

function renderHybridCommand(
  command: HiveCommandKey,
  _context: HiveCommandContext,
  input: CommandSectionInput,
): string {
  const wrapper = renderSections({
    details: input.details,
    doItems: input.doItems,
    doNotItems: input.doNotItems,
    backgroundItems: input.backgroundItems,
    outputItems: input.outputItems,
  });
  return `${wrapper}\n\n---\n\n${COMMAND_BEHAVIOR[command]}`;
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
      details: [`Topic: ${topicOrCurrent(args, 'clarify the operator idea for an implementation-brief handoff')}`],
      doItems: [
        'Load the `grilling` skill and use its shared interaction engine.',
        'Ask exactly one material operator question per turn and wait for the answer before continuing.',
        'Choose the highest-ambiguity, highest-risk, or highest-value missing decision first.',
        'After each answer, show compact progress with settled operator decisions and operator preferences listed separately, unresolved material items, and fact-status counts.',
      ],
      doNotItems: [
        'Do not write code, create plans, or mutate Hive state during the interview; do not edit files except to write the confirmed alignment brief to a named destination.',
        'Do not invent repository facts; verify them or label them as assumptions.',
        'Do not automatically produce an implementation brief or start follow-on work after alignment.',
      ],
      backgroundItems: backgroundItems(context, [
        'Use direct retrieval, one agent, or multiple agents, including independent background lanes when useful, only for bounded material research questions and based on their evidence needs and dependencies.',
        'Continue asking independent operator decisions while research runs; wait only when all remaining material decisions depend on pending evidence.',
      ]),
      outputItems: [
        '## Interview Summary, ## Recommended Next Step, and ## Context For /implementation-brief when appropriate.',
      ],
    });
  },

  grill(args, context) {
    return renderHybridCommand('grill', context, {
      details: [`Context: ${topicOrCurrent(args, 'the context supplied in this conversation')}`],
      doItems: [
        'Load the `grilling` skill and use its shared interaction engine.',
        'Ask exactly one material operator question per turn until no unresolved item could materially change shared understanding.',
        'End with the skill\'s explicit three-way alignment confirmation.',
      ],
      doNotItems: [
        'Do not assume the context concerns software, implementation, a Hive feature, a plan, or a next command.',
        'Do not persist grilling state or expose the internal dependency frontier.',
      ],
      backgroundItems: backgroundItems(context, [
        'Use direct retrieval, one agent, or multiple agents, including independent background lanes when useful, only for bounded material research questions and based on their evidence needs and dependencies.',
        'Continue asking independent operator decisions while research runs; wait only when all remaining material decisions depend on pending evidence.',
      ]),
      outputItems: [
        'A conversation-scoped alignment brief covering interpretation, operator decisions, operator preferences, established facts with provenance and status, assumptions, constraints, scope, disagreements, and open questions, followed by three-way alignment confirmation.',
      ],
    });
  },

  'implementation-brief'(args, context) {
    return renderHybridCommand('implementation-brief', context, {
      details: [`Subject: ${topicOrCurrent(args, 'the current operator request')}`],
      doItems: [
        'Revalidate important repo paths, symbols, commands, and ownership before treating them as facts.',
        'Produce one copy-paste-ready brief for /hive-plan to turn into the formal Hive plan.',
      ],
      doNotItems: [
        'Do not write the Hive implementation plan or call plan-writing tools during brief generation.',
        'Do not present stale paths or unverified codebase claims as facts.',
      ],
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
        'Perform active discovery before writing the plan; inspect relevant files, tests, docs, and constraints first.',
        'Create the feature when needed, then target that feature explicitly in context and plan calls. Feature creation and explicit feature arguments do not change the selected session route. Load context-engineering for hash-guarded reads and writes; do not mass-read every note.',
        'Include documentation updates for non-ad-hoc work when user-facing behavior, setup, install flow, or operator workflow changes.',
      ],
      doNotItems: [
        'Do not write a plan from an unverified brief alone.',
        'Do not assume the active/default agent has every Hive tool; follow the route target and tool boundary.',
      ],
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
        'Resolve the intended feature, then read it with explicit hive_status and hive_plan_read calls before approval.',
        'Approve and sync that same explicit feature with hive_plan_approve and hive_tasks_sync, then read back its status and tasks.',
        'Stop with exact blockers if plan approval, task sync, or readback fails.',
      ],
      doNotItems: [
        'Do not continue into execution unless approval and sync are confirmed by readback.',
        'Do not silently ignore unresolved plan comments, malformed tasks, or sync failures.',
      ],
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
        'Use todos to track task progress and transitions.',
        'Create or inspect the task worktree with an explicit feature target when isolation is needed, call hive_feature_select for that feature immediately before dispatch, then issue the native Forager task() call with that path in its authored prompt.',
        'Read the report a bound worker published, then record status, summary, or blocker with hive_task_update under Task Report Ownership; do not retranscribe the report.',
        'After any returned native task result, launch a fresh child session for follow-up; preserve task_id pass-through only for explicit operator/runtime-owned interruption recovery.',
      ],
      doNotItems: [
        'Do not start execution without an approved and synced plan.',
        'Do not call hive_worktree_merge before worker completion and verification evidence are available.',
      ],
      backgroundItems: backgroundItems(context, [
        'Use independent background-first orchestration only for runnable tasks or validation lanes.',
      ]),
      outputItems: [
        'Confirmed strategy, todos, launched or queued tasks, blockers, and merge/verification expectations.',
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
        'Name objective, direction, include (configured groups/members), constraints, context, assumptions needing validation, and desired output.',
        'Refer to configured global council groups by role, not stale personal aliases or mutable worker seats.',
      ],
      doNotItems: [
        'Do not run council or launch agents.',
        'Do not create Hive plans, worktrees, patches, or commits.',
      ],
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
            'Synthesize a recommendation with consensus, dissent, evidence gaps, and next action.',
          ],
      doNotItems: [
        'Do not infer a group from the first free-text token; only --group selects a non-default group.',
        'Do not add unavailable, excluded, template-placeholder, mutable-base, or duplicate councillors back into the run.',
        'Do not let councillors edit files, create plans, call planning write tools, create worktrees, or commit.',
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

  'compact-summary'(args, context) {
    return renderHybridCommand('compact-summary', context, {
      details: args.trim() ? [`Focus: ${args.trim()}`] : undefined,
      doItems: [
        'Produce a recovery summary only using conversation and tool evidence.',
        'Use the exact section order: Goal, Constraints & Preferences, Progress (Done/In Progress/Blocked), Key Decisions, Next Steps, Critical Context, Relevant Files.',
        'Include verification evidence only when actual command output or tool evidence exists.',
      ],
      doNotItems: [
        'Do not mutate files, start agents, launch background tasks, or change Hive state.',
        'Do not claim verification, tests, builds, or checks succeeded without actual command output.',
      ],
      outputItems: ['Exact compact-summary template sections only.'],
    });
  },
};
