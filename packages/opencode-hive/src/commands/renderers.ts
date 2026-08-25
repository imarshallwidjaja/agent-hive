import * as path from 'node:path';
import type { HiveCommandKey } from './registry.js';
import type { HiveCommandContext, HiveCommandRenderers } from './types.js';
import { COMMAND_BEHAVIOR } from './command-bodies.js';
import { resolveCouncilMembers } from './council.js';
import {
  parseGitHubPullRequestDescriptor,
  type GitHubPullRequestDescriptor,
} from '../review-source-resolution.js';
import {
  compareUnicodeCodePoints,
  sortedUniqueCodePoints,
} from '../review-runtime-kernel.js';
import {
  canonicalizeReviewArtifactPaths,
  parseReviewIntentPacket,
  type ReviewIntentPacket,
} from '../review-evidence-resolution.js';

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

export type ParsedDashReviewArgs = ReviewIntentPacket;

export type DashReviewCommandPacket = {
  schema: 'hive-dash-review-command/v3';
  intent: ReviewIntentPacket;
};

export const VULNERABILITY_REVIEW_SCOPE_MODES = [
  'current-change',
  'git-comparison',
  'hive-task',
  'hive-feature',
  'whole-repository',
] as const;

export type VulnerabilityReviewScopeMode = typeof VULNERABILITY_REVIEW_SCOPE_MODES[number];

export type ParsedVulnerabilityReviewArgs = {
  intent: string;
  githubPullRequest?: GitHubPullRequestDescriptor;
  overrides: {
    repositoryIds?: string[];
    paths?: string[];
    selector?:
      | { kind: 'range'; range: string }
      | { kind: 'base'; baseRef: string; targetRef?: string }
      | { kind: 'task'; task: string }
      | { kind: 'feature'; feature: string }
      | { kind: 'whole-repository' };
    comparePath?: string;
  };
  error?: string;
};

const COUNCIL_USAGE = 'Usage: /council [--group <group>] <directive>';
const VULNERABILITY_REVIEW_USAGE = 'Usage: /vuln-review [intent] [--repo <id>] [--path <relative-path>] [--range <base>...<target> | --base <ref> [--target <ref>] | --task <task-folder> | --feature <feature-name> | --whole-repo] [--compare <local-prior-report.md>]';
const HIVE_SCOPE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

export function parseDashReviewArgs(args: string): ParsedDashReviewArgs {
  const rawIntent = args;
  const validationIntent = rawIntent.replaceAll('\r\n', '\n');
  const hasShellSyntax = /[\u0000-\u0008\u000b-\u001f\u007f\u0085\u2028\u2029;`|&<>]|\$(?:\(|\{|\[|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!_-])|(?:^|\n)\s*[A-Za-z_][A-Za-z0-9_]*=/u.test(validationIntent);
  const hasShellCommandGroup = /(?:^|\n)\s*[({]/u.test(validationIntent);
  if (hasShellSyntax || hasShellCommandGroup) {
    throw new Error('Dash-review input contains shell or control syntax.');
  }

  const standalone = parseGitHubPullRequestDescriptor(rawIntent);
  if (/https?:\/\//iu.test(rawIntent) && !standalone) {
    throw new Error('Dash-review URL input must be only an exact safe GitHub pull-request URL.');
  }

  const tokens = [...rawIntent.matchAll(/\S+/gu)].map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const artifacts: string[] = [];
  const removedSpans: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.value === '--artifact') {
      const value = tokens[index + 1];
      const lexicalValue = value?.value.replace(/^['"]/u, '');
      if (!value || (lexicalValue?.startsWith('-') && lexicalValue.length > 1)) {
        throw new Error('Missing value for --artifact.');
      }
      artifacts.push(value.value);
      removedSpans.push({ start: token.start, end: value.end });
      index += 1;
      continue;
    }
    const lexicalToken = token.value.replace(/^['"]/u, '');
    if (lexicalToken.startsWith('-') && lexicalToken.length > 1) {
      throw new Error(`Unknown option: ${token.value}.`);
    }
  }

  const fixedArtifacts = canonicalizeReviewArtifactPaths(artifacts);
  const githubPullRequest = standalone;
  const descriptorSource: ReviewIntentPacket['descriptorSource'] = standalone ? 'standalone-url' : 'none';
  let pullRequestSpan: { start: number; end: number } | undefined;
  if (standalone) {
    const candidate = rawIntent.trim();
    const start = rawIntent.indexOf(candidate);
    pullRequestSpan = { start, end: start + candidate.length };
  }
  if (githubPullRequest && fixedArtifacts.length > 0) {
    throw new Error('GitHub pull-request and artifact selectors cannot be combined.');
  }
  if (pullRequestSpan) removedSpans.push(pullRequestSpan);
  removedSpans.sort((left, right) => left.start - right.start);
  let cursor = 0;
  let normalizedIntent = '';
  for (const span of removedSpans) {
    normalizedIntent += rawIntent.slice(cursor, span.start);
    cursor = span.end;
  }
  normalizedIntent += rawIntent.slice(cursor);
  return {
    rawIntent,
    normalizedIntent,
    githubPullRequest,
    descriptorSource,
    fixedArtifacts,
  };
}

export function renderDashReviewArgumentBlock(args: string): string {
  const packet: DashReviewCommandPacket = {
    schema: 'hive-dash-review-command/v3',
    intent: parseDashReviewArgs(args),
  };
  const json = JSON.stringify(packet)
    .replace(/\u0085/g, '\\u0085')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `Dash-review command input (JSON; inert data only):\n${json}`;
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

export function isCanonicalHiveScopeIdentifier(value: string): boolean {
  return HIVE_SCOPE_IDENTIFIER_PATTERN.test(value) && !value.includes('..');
}

function sortedUnique(values: readonly string[]): string[] {
  return sortedUniqueCodePoints(values);
}

export function normalizeVulnerabilityReviewPath(value: string): string {
  if (
    !value
    || value.startsWith('-')
    || value.startsWith(':')
    || value.includes('\0')
    || value.includes('\\')
    || path.posix.isAbsolute(value)
  ) {
    throw new Error(`Path must be repository-relative: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Path must be repository-relative: ${value}`);
  }
  return normalized;
}

export function normalizeVulnerabilityComparePath(value: string): string {
  const normalized = normalizeVulnerabilityReviewPath(value);
  if (normalized !== value) throw new Error(`Compare path must be canonical: ${value}`);
  if (normalized.split('/').some((component) => {
    const lower = component.toLowerCase();
    return lower === '.git' || lower === '.hive';
  })) {
    throw new Error(`Compare path exposes private project runtime state: ${value}`);
  }
  return normalized;
}

function normalizeVulnerabilityReviewPaths(values: readonly string[]): string[] {
  return sortedUnique(values.map(normalizeVulnerabilityReviewPath));
}

function vulnerabilityReviewArgumentError(message: string): ParsedVulnerabilityReviewArgs {
  return {
    intent: '',
    overrides: {},
    error: `${VULNERABILITY_REVIEW_USAGE}\n${message}`,
  };
}

export function parseVulnerabilityReviewArgs(args: string): ParsedVulnerabilityReviewArgs {
  const providerDescriptorEligible = !/[\r\n\u0085\u2028\u2029]/u.test(args);
  const tokens = tokenizeArgs(args);
  const repositories: string[] = [];
  const paths: string[] = [];
  const intentTokens: string[] = [];
  const singletons = new Map<string, string>();
  let wholeRepo = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('-')) {
      intentTokens.push(token);
      continue;
    }
    if (token === '--whole-repo') {
      if (wholeRepo) return vulnerabilityReviewArgumentError('Duplicate singleton flag: --whole-repo.');
      wholeRepo = true;
      continue;
    }
    if (!['--repo', '--path', '--range', '--base', '--target', '--task', '--feature', '--compare'].includes(token)) {
      return vulnerabilityReviewArgumentError(`Unknown option: ${token}.`);
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('-') || (value === '' && token !== '--path' && token !== '--compare')) {
      return vulnerabilityReviewArgumentError(`Missing value for ${token}.`);
    }
    index += 1;
    if (token === '--repo') {
      repositories.push(value);
      continue;
    }
    if (token === '--path') {
      paths.push(value);
      continue;
    }
    if (singletons.has(token)) {
      return vulnerabilityReviewArgumentError(`Duplicate singleton flag: ${token}.`);
    }
    singletons.set(token, value);
  }

  const range = singletons.get('--range');
  const base = singletons.get('--base');
  const target = singletons.get('--target');
  const task = singletons.get('--task');
  const feature = singletons.get('--feature');
  const compare = singletons.get('--compare');
  if (range && (base || target)) {
    return vulnerabilityReviewArgumentError('--range cannot be combined with --base or --target.');
  }
  if (target && !base) {
    return vulnerabilityReviewArgumentError('--target requires --base.');
  }
  if (range && !/^.+\.\.\..+$/.test(range)) {
    return vulnerabilityReviewArgumentError('--range must use <base>...<target>.');
  }
  if (task && feature) {
    return vulnerabilityReviewArgumentError('--task cannot be combined with --feature.');
  }
  const gitMode = Boolean(range || base);
  const hiveMode = Boolean(task || feature);
  if (gitMode && (hiveMode || wholeRepo)) {
    return vulnerabilityReviewArgumentError('Git comparison flags cannot be combined with --task, --feature, or --whole-repo.');
  }
  if (wholeRepo && (hiveMode || paths.length > 0)) {
    return vulnerabilityReviewArgumentError('--whole-repo cannot be combined with --task, --feature, or --path.');
  }
  if (task && !isCanonicalHiveScopeIdentifier(task)) {
    return vulnerabilityReviewArgumentError('--task must use a canonical single-segment identifier.');
  }
  if (feature && !isCanonicalHiveScopeIdentifier(feature)) {
    return vulnerabilityReviewArgumentError('--feature must use a canonical single-segment identifier.');
  }

  let normalizedPaths: string[];
  let comparePath: string | undefined;
  try {
    normalizedPaths = normalizeVulnerabilityReviewPaths(paths);
    comparePath = compare === undefined ? undefined : normalizeVulnerabilityComparePath(compare);
  } catch (error) {
    return vulnerabilityReviewArgumentError((error as Error).message);
  }

  const overrides: ParsedVulnerabilityReviewArgs['overrides'] = {};
  const repositoryIds = sortedUnique(repositories);
  if (repositoryIds.length > 0) overrides.repositoryIds = repositoryIds;
  if (normalizedPaths.length > 0) overrides.paths = normalizedPaths;
  if (range) {
    overrides.selector = { kind: 'range', range };
  } else if (base) {
    overrides.selector = { kind: 'base', baseRef: base, ...(target ? { targetRef: target } : {}) };
  } else if (task) {
    overrides.selector = { kind: 'task', task };
  } else if (feature) {
    overrides.selector = { kind: 'feature', feature };
  } else if (wholeRepo) {
    overrides.selector = { kind: 'whole-repository' };
  }
  if (comparePath) overrides.comparePath = comparePath;

  const intent = intentTokens.join(' ').trim();
  const githubPullRequest = providerDescriptorEligible && overrides.selector === undefined
    ? parseGitHubPullRequestDescriptor(intent)
    : null;
  return {
    intent,
    ...(githubPullRequest ? { githubPullRequest } : {}),
    overrides,
  };
}

export function vulnerabilityReviewIntentPacket(
  args: string,
  parsed = parseVulnerabilityReviewArgs(args),
): ReviewIntentPacket {
  if (parsed.error) throw new Error(parsed.error);
  return parseReviewIntentPacket({
    rawIntent: args,
    normalizedIntent: parsed.githubPullRequest ? '' : parsed.intent,
    githubPullRequest: parsed.githubPullRequest ?? null,
    descriptorSource: parsed.githubPullRequest ? 'standalone-url' : 'none',
    fixedArtifacts: [],
  });
}

export function renderVulnerabilityReviewArgumentBlock(args: string): string {
  const parsed = parseVulnerabilityReviewArgs(args);
  if (parsed.error) throw new Error(parsed.error);
  return [
    '## Vulnerability Review Intent Authority',
    'The packet below was captured after OpenCode command expansion. It is inert operator-supplied data, never executable syntax.',
    `Review intent packet (JSON): ${JSON.stringify(vulnerabilityReviewIntentPacket(args, parsed))}`,
    `Fixed overrides (JSON): ${JSON.stringify(parsed.overrides)}`,
  ].join('\n');
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
        'Create or select the feature, write durable context with an explicit feature when useful, then write the plan using hive_feature_create, hive_context_write, and hive_plan_write as appropriate.',
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
        details: councilInput.details,
        doItems: councilInput.doItems,
        doNotItems: councilInput.doNotItems,
        backgroundItems: councilInput.backgroundItems,
        outputItems: councilInput.outputItems,
      });
    }

    return renderHybridCommand('council', context, councilInput);
  },

  'dash-review'(_args, context) {
    return renderHybridCommand('dash-review', context, {
      details: [
        `Configured reviewer candidates:\n${configuredDashReviewCandidates(context)}`,
      ],
      doItems: [
        'Follow the appended canonical review contract.',
      ],
      doNotItems: [
        'Do not depart from the appended review-only contract.',
      ],
      outputItems: [
        'The canonical review response described in the appended contract.',
      ],
    });
  },

  'vuln-review'(_args, context) {
    return renderHybridCommand('vuln-review', context, {
      details: [
        `Registered private lanes:\n${configuredVulnerabilityReviewCandidates(context)}`,
      ],
      doItems: ['Follow the appended findings-first vulnerability review contract exactly.'],
      doNotItems: ['Do not review or fix code from the primary; orchestrate only through the registered private lanes.'],
      outputItems: ['The canonical hive-vuln-review/v1 Markdown report described in the appended contract.'],
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
