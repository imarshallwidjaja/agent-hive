import type { HiveCommandDashReviewLane } from '../commands/types.js';

type DashReviewLaneBase = 'scout-researcher' | 'code-reviewer' | 'simplicity-reviewer';

export type DashReviewLaneSource = {
  name: string;
  baseAgent: DashReviewLaneBase;
  description: string;
  model?: string;
  variant?: string;
  temperature?: number;
  prompt?: string;
};

type DashReviewLaneConfig = {
  model?: string;
  variant?: string;
  temperature?: number;
  mode: 'subagent';
  description: string;
  prompt: string;
  tools: Record<string, boolean>;
  permission: Record<string, string | Record<string, string>>;
};

function withoutScoutPersistence(prompt: string): string {
  return prompt.replace(/\n## Persistence\n[\s\S]*?(?=\n## |$)/, '\n');
}

function safePrompt(source: DashReviewLaneSource): string {
  const inherited = (source.baseAgent === 'scout-researcher'
    ? withoutScoutPersistence(source.prompt ?? '')
    : source.prompt ?? '')
    .split('\n')
    .filter((line) => !line.includes('hive_context_write'))
    .join('\n');

  const snapshotBoundary = source.baseAgent === 'scout-researcher'
    ? 'This scope/revalidation lane may use `hive_git_snapshot` for Git state only. It accepts structured repositoryIds, refs, ranges, paths, and output bounds; it does not accept commands or flags. Use `hive_repositories_status` for repository context, then select composite repository IDs from the active workspace `workspace.json`, not the project repository config. Use one atomic snapshot set: omitting repositoryIds includes every manifest repository, while an explicit selection must report excluded IDs. Revalidation repeats the same structured scope and compares the set fingerprint. Do not use Bash.'
    : 'You receive the frozen manifest, bounded patch material, and Stage A leads from the scope lane. Do not use `hive_git_snapshot` or Bash.';

  return `${inherited}\n\n## Dash Review Safe Lane

Configured lens: ${source.description}

${snapshotBoundary}

Inspect only repository state relevant to the supplied review scope. Do not edit files, apply patches, write Hive context, create plans, tasks, worktrees, commits, merges, or PRs, or call task() recursively.`;
}

function nextTaskTarget(baseAgent: DashReviewLaneBase, usedNames: Set<string>): string {
  const role = baseAgent === 'scout-researcher'
    ? 'scope'
    : baseAgent === 'code-reviewer'
      ? 'code'
      : 'simplicity';
  let ordinal = 1;
  let target = `__hive_dash_review_lane_${role}_${ordinal}`;
  while (usedNames.has(target)) {
    ordinal += 1;
    target = `__hive_dash_review_lane_${role}_${ordinal}`;
  }
  usedNames.add(target);
  return target;
}

export function buildDashReviewSafeLanes(input: {
  sources: DashReviewLaneSource[];
  existingNames: Iterable<string>;
  tools: Record<string, boolean>;
  scopeTools: Record<string, boolean>;
}): {
  agents: Record<string, DashReviewLaneConfig>;
  lanes: HiveCommandDashReviewLane[];
} {
  const usedNames = new Set(Array.from(input.existingNames, (name) => name.toLowerCase()));
  const agents: Record<string, DashReviewLaneConfig> = {};
  const lanes: HiveCommandDashReviewLane[] = [];

  for (const source of input.sources) {
    const taskTarget = nextTaskTarget(source.baseAgent, usedNames);
    const description = `Dash Review Safe Lane - ${source.name}: ${source.description}`;
    agents[taskTarget] = {
      model: source.model,
      variant: source.variant,
      temperature: source.temperature,
      mode: 'subagent',
      description,
      prompt: safePrompt(source),
      tools: {
        ...(source.baseAgent === 'scout-researcher' ? input.scopeTools : input.tools),
        '*': false,
      },
      permission: {
        edit: 'deny',
        task: 'deny',
        delegate: 'deny',
        skill: 'allow',
        bash: 'deny',
      },
    };
    lanes.push({
      taskTarget,
      sourceAgent: source.name,
      baseAgent: source.baseAgent,
      description: source.description,
      model: source.model,
      variant: source.variant,
    });
  }

  return { agents, lanes };
}
