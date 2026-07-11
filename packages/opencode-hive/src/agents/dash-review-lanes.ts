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

function lanePrompt(source: DashReviewLaneSource): string {
  const inherited = (source.baseAgent === 'scout-researcher'
    ? withoutScoutPersistence(source.prompt ?? '')
    : source.prompt ?? '')
    .split('\n')
    .filter((line) => !line.includes('hive_context_write'))
    .join('\n');
  const scopeBoundary = source.baseAgent === 'scout-researcher'
    ? 'This scope lane may use `hive_repositories_status`, `hive_git_snapshot`, and `hive_review_workspace_create` with structured scope data only. It captures and materializes the frozen review workspace before any deep review runs.'
    : 'Use only the supplied frozen review workspace paths and identity. Do not inspect or write to the live source workspace.';

  return `${inherited}

## Dash Review Lane

Configured lens: ${source.description}

${scopeBoundary}

You may use normal local CLI and retrieval tools inside the frozen review workspace. Read-only Railway, Vercel, status, log, and diagnostic commands are allowed when relevant. Remote mutation such as deploy, up, promote, push, migrate, database changes, or API writes is prohibited by policy. Source-path escape and remote effects are self-reported boundaries, not technically impossible states; report any observed escape or effect. Live source drift is non-attributable. Do not use generic rollback. Treat ignored live artifacts as non-source output; regenerate required artifacts in serialized verification. Only the serialized verification lane returns a structured command transcript; other lanes report exceptional boundaries and recovery limits. Do not edit files through the editor; this is only a reviewer-role speed bump and is not filesystem immutability because CLI commands can write. Do not write Hive context, create plans, tasks, worktrees, commits, merges, or PRs, and do not call task() recursively.`;
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

export function buildDashReviewLanes(input: {
  sources: DashReviewLaneSource[];
  existingNames: Iterable<string>;
  hiveTools: readonly string[];
}): {
  agents: Record<string, DashReviewLaneConfig>;
  lanes: HiveCommandDashReviewLane[];
} {
  const usedNames = new Set(Array.from(input.existingNames, (name) => name.toLowerCase()));
  const agents: Record<string, DashReviewLaneConfig> = {};
  const lanes: HiveCommandDashReviewLane[] = [];

  for (const source of input.sources) {
    const taskTarget = nextTaskTarget(source.baseAgent, usedNames);
    const tools = Object.fromEntries(input.hiveTools.map((tool) => [tool, false]));
    if (source.baseAgent === 'scout-researcher') {
      tools.hive_repositories_status = true;
      tools.hive_git_snapshot = true;
      tools.hive_review_workspace_create = true;
    }
    agents[taskTarget] = {
      model: source.model,
      variant: source.variant,
      temperature: source.temperature,
      mode: 'subagent',
      description: `Dash Review Lane - ${source.name}: ${source.description}`,
      prompt: lanePrompt(source),
      tools,
      permission: {
        edit: 'deny',
        task: 'deny',
        delegate: 'deny',
        skill: 'allow',
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
