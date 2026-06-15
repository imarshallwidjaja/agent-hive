import type { HiveCommandKey } from './registry.js';
import type { HiveCommandContext, HiveCommandRenderers } from './types.js';
import { COMMAND_BEHAVIOR } from './command-bodies.js';
import { resolveCouncilMembers } from './council.js';

type CommandSectionInput = {
  mode: HiveCommandContext['agentMode'];
  route: string;
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

const DEDICATED_ROUTE_NOTE = 'Slash commands do not switch agents automatically; if the active agent is not the route target, delegate or reroute to the target agent and stop if that is not possible.';
const COUNCIL_USAGE = 'Usage: /council [--group <group>] <directive>';

function routeFor(context: HiveCommandContext, unifiedTarget: string, dedicatedTarget: string): string {
  const target = context.agentMode === 'unified' ? unifiedTarget : dedicatedTarget;
  return context.agentMode === 'dedicated'
    ? `${target}. ${DEDICATED_ROUTE_NOTE}`
    : target;
}

function formatList(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function renderSections(input: CommandSectionInput): string {
  const sections = [
    `Mode: ${input.mode}`,
    `Route: ${input.route}`,
  ];

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
  context: HiveCommandContext,
  input: Omit<CommandSectionInput, 'mode' | 'route'> & { unifiedRoute: string; dedicatedRoute: string },
): string {
  const wrapper = renderSections({
    mode: context.agentMode,
    route: routeFor(context, input.unifiedRoute, input.dedicatedRoute),
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
    mode: context.agentMode,
    route: routeFor(context, 'hive-master', 'architect-planner'),
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
      unifiedRoute: 'hive-master',
      dedicatedRoute: 'architect-planner',
      details: [`Topic: ${topicOrCurrent(args, 'clarify the operator idea before planning')}`],
      doItems: [
        'Ask exactly one question at a time and wait for the answer before continuing.',
        'Choose the highest-ambiguity, highest-risk, or highest-value missing decision first.',
        'After each answer, include a short running summary of decisions, constraints, and open questions.',
      ],
      doNotItems: [
        'Do not write code, edit files, create plans, or mutate Hive state during the interview.',
        'Do not invent repository facts; verify them or label them as assumptions.',
      ],
      backgroundItems: backgroundItems(context, [
        'When useful, run independent validation or research in background lanes while continuing safe interview questions.',
        'Distinguish validated facts from pending assumptions until those lanes finish.',
      ]),
      outputItems: [
        '## Interview Summary, ## Recommended Next Step, and ## Context For /implementation-brief when appropriate.',
      ],
    });
  },

  'implementation-brief'(args, context) {
    return renderHybridCommand('implementation-brief', context, {
      unifiedRoute: 'hive-master',
      dedicatedRoute: 'architect-planner',
      details: [`Subject: ${topicOrCurrent(args, 'the current operator request')}`],
      doItems: [
        'Revalidate important repo paths, symbols, commands, and ownership before treating them as facts.',
        'Produce one copy-paste-ready brief for another agent to make the real implementation plan.',
      ],
      doNotItems: [
        'Do not write the Hive implementation plan or call plan-writing tools.',
        'Do not present stale paths or unverified codebase claims as facts.',
      ],
      backgroundItems: backgroundItems(context, [
        'Use independent background research only when foreground brief assembly can safely continue without those results.',
      ]),
      outputItems: ['Output only the final prompt in one fenced code block.'],
    });
  },

  'hive-plan'(args, context) {
    return renderHybridCommand('hive-plan', context, {
      unifiedRoute: 'hive-master',
      dedicatedRoute: 'architect-planner',
      details: [`Planning input: ${topicOrCurrent(args, 'the current spec or brief')}`],
      doItems: [
        'Perform active discovery before writing the plan; inspect relevant files, tests, docs, and constraints first.',
        'Create or select the feature, write durable context when useful, then write the plan using hive_feature_create, hive_context_write, and hive_plan_write as appropriate.',
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
      unifiedRoute: 'hive-master',
      dedicatedRoute: 'swarm-orchestrator',
      details: args.trim() ? [`Additional operator input: ${args.trim()}`] : undefined,
      doItems: [
        'Read the active state with hive_status and hive_plan_read before approval.',
        'Approve with hive_plan_approve, sync with hive_tasks_sync, then read back status and tasks.',
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
      unifiedRoute: 'hive-master',
      dedicatedRoute: 'swarm-orchestrator',
      details: args.trim() ? [`Context: ${args.trim()}`] : undefined,
      doItems: [
        'Confirm parallel vs sequential execution strategy with the operator before proceeding.',
        'Use todos to track task progress and transitions.',
        'Preserve hive_worktree_start -> worker execution -> hive_worktree_commit -> hive_merge; orchestrator does not call hive_worktree_commit for workers.',
        'Retry failed worker sessions in fresh workers with concise failure context.',
      ],
      doNotItems: [
        'Do not start execution without an approved and synced plan.',
        'Do not merge before worker completion and verification evidence are available.',
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
      unifiedRoute: 'hive-master',
      dedicatedRoute: 'architect-planner',
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
      unifiedRoute: 'hive-master',
      dedicatedRoute: 'architect-planner',
      details,
      doItems: resolution.error
        ? ['Stop and report the council member resolution error with all warnings.']
        : [
            'Run a read-only council with the resolved councillors in the displayed order.',
            'Give every councillor the directive, relevant evidence, and the read-only contract.',
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
        mode: context.agentMode,
        route: routeFor(context, councilInput.unifiedRoute, councilInput.dedicatedRoute),
        details: councilInput.details,
        doItems: councilInput.doItems,
        doNotItems: councilInput.doNotItems,
        backgroundItems: councilInput.backgroundItems,
        outputItems: councilInput.outputItems,
      });
    }

    return renderHybridCommand('council', context, councilInput);
  },

  'compact-summary'(args, context) {
    return renderHybridCommand('compact-summary', context, {
      unifiedRoute: 'hive-master',
      dedicatedRoute: 'scout-researcher',
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
