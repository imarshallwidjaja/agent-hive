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

const MAX_ALIAS_LENGTH = 64;
export const DASH_REVIEW_LANE_DESCRIPTION_PREFIX = 'Frozen Workspace Review Lane - ';
export const UNIVERSAL_METADATA_HIVE_TOOLS = ['hive_repositories_status', 'hive_plan_read', 'hive_status'] as const;

function withoutScoutPersistence(prompt: string): string {
  return prompt.replace(/(?:^|\n)## Persistence\n[\s\S]*?(?=\n## |$)/, '\n');
}

function sanitizeSourceToken(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'agent';
}

function aliasWithSuffix(token: string, suffix: string): string {
  const maxTokenLength = Math.max(1, MAX_ALIAS_LENGTH - 'review-'.length - suffix.length);
  const base = token.slice(0, maxTokenLength).replace(/-+$/g, '') || 'agent';
  return `review-${base}${suffix}`;
}

function allocateAlias(sourceName: string, usedNames: Set<string>): string {
  const token = sanitizeSourceToken(sourceName);
  let target = aliasWithSuffix(token, '');
  let ordinal = 2;
  while (usedNames.has(target.toLowerCase())) {
    target = aliasWithSuffix(token, `-${ordinal}`);
    ordinal += 1;
  }
  usedNames.add(target.toLowerCase());
  return target;
}

function lanePrompt(source: DashReviewLaneSource): string {
  const inherited = (source.baseAgent === 'scout-researcher'
    ? withoutScoutPersistence(source.prompt ?? '')
    : source.prompt ?? '')
    .split('\n')
    .filter((line) => !line.includes('hive_context_write'))
    .join('\n');
  const scopeBoundary = source.baseAgent === 'scout-researcher'
    ? [
      'This scope lane may use the universal metadata tools (`hive_repositories_status`, `hive_plan_read`, `hive_status`), plus `hive_git_snapshot` and `hive_review_workspace_create` with structured scope data only. It captures and materializes the frozen review workspace before any deep review runs.',
      'Scope contract overrides any inherited guidance: the first tool call must be `hive_repositories_status`; for legacy single-root omit `repositoryIds` entirely from snapshot/create; for composite use manifest IDs consistently; this lane may only use universal metadata, snapshot, and create tools and must return run ID/token without claim/inspect/cleanup.',
    ].join(' ')
    : [
      'Use only the supplied frozen review workspace paths and identity. Do not inspect or write to the live source workspace.',
      'process cwd is live source. Before any local-source file/Git/shell/cymbal/build/test/glob/grep/ast-grep/read operation, every tool must use an explicit frozen absolute `workdir`/`cwd`, `project_folder`, or absolute path. Never rely on default cwd or `cd`. If a tool cannot be scoped, do not use it.',
      'Require manifest-led file discovery before direct reads: use manifest paths or discover under the frozen absolute root; never guess filenames.',
    ].join(' ');

  return `${inherited}

## Frozen Workspace Review Lane

Configured lens: ${source.description}

${scopeBoundary}

You may use normal local CLI and retrieval tools inside the frozen review workspace. Read-only Railway, Vercel, status, log, and diagnostic commands are allowed when relevant. Remote mutation such as deploy, up, promote, push, migrate, database changes, or API writes is prohibited by policy. Source-path escape and remote effects are self-reported boundaries, not technically impossible states; report any observed escape or effect. Live source drift is non-attributable. Do not use generic rollback. Treat ignored live artifacts as non-source output; regenerate required artifacts in serialized verification. Only the serialized verification lane returns a structured command transcript; other lanes report exceptional boundaries and recovery limits. Do not edit files through the editor; this is only a reviewer-role speed bump and is not filesystem immutability because CLI commands can write. Do not write Hive context, create plans, tasks, worktrees, commits, merges, or PRs, and do not call task() recursively.`;
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
  const aliasBySourceName = new Map<string, string>();

  for (const source of [...input.sources].sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    aliasBySourceName.set(source.name, allocateAlias(source.name, usedNames));
  }

  for (const source of input.sources) {
    const taskTarget = aliasBySourceName.get(source.name)!;
    const tools = Object.fromEntries(input.hiveTools.map((tool) => [tool, false]));
    for (const tool of UNIVERSAL_METADATA_HIVE_TOOLS) {
      tools[tool] = true;
    }
    if (source.baseAgent === 'scout-researcher') {
      tools.hive_git_snapshot = true;
      tools.hive_review_workspace_create = true;
    }
    agents[taskTarget] = {
      model: source.model,
      variant: source.variant,
      temperature: source.temperature,
      mode: 'subagent',
      description: `${DASH_REVIEW_LANE_DESCRIPTION_PREFIX}${source.name}: ${source.description}`,
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
