import type { HiveCommandDashReviewLane } from '../commands/types.js';
import {
  buildReviewPermission,
  buildReviewToolConfig,
  REVIEW_ROLE_POLICIES,
} from '../review-tool-policy.js';
import {
  REVIEW_FROZEN_WORKSPACE_BOUNDARY,
  REVIEW_SOURCE_RESOLUTION_BOUNDARY,
} from '../review-runtime-prompts.js';
import { compareUnicodeCodePoints } from '../review-runtime-kernel.js';

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
const DASH_REVIEW_LANE_DESCRIPTION_PREFIX = 'Frozen Workspace Review Lane - ';

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
      'Use exactly three scope states: `verified PR commits`, `local snapshot scope`, and `unverified local checkout`. Call `hive_git_snapshot` once with the structured runtime boundaries and consume its runtime-produced `sourceResolution` unchanged; the runtime owns provider candidate OIDs, local object verification, and the canonical state label. The no-descriptor versus explicit-selector provenance reason identifies whether the local scope came from lane inference or an operator selector.',
      'Never retry, authorize fallback, change candidate refs, reconstruct provenance, or pass provider metadata yourself. Only the runtime may perform one fallback after a structured missing-provider-OID failure. Explicit local refs remain strict and never fall back.',
      'Preserve the returned descriptor/outcome, candidate SHAs, snapshot outcome, selected repositories/paths, comparison commits, dirty-aware change groups, source fingerprint, and canonical provenance fingerprint. Never synthesize provider refs such as `refs/pull/<n>/head`.',
    ].join(' ')
    : [
      'Use only the supplied frozen review workspace paths and identity. Do not inspect or write to the live source workspace.',
      'process cwd is live source. Before any local-source file/Git/shell/cymbal/build/test/glob/grep/ast-grep/read operation, every tool must use an explicit frozen absolute `workdir`/`cwd`, `project_folder`, or absolute path. Never rely on default cwd or `cd`. If a tool cannot be scoped, do not use it.',
      'Require manifest-led file discovery before direct reads: use manifest paths or discover under the frozen absolute root; never guess filenames.',
    ].join(' ');
  const operationsBoundary = source.baseAgent === 'scout-researcher'
    ? `${REVIEW_SOURCE_RESOLUTION_BOUNDARY} Consume runtime candidate metadata only. Do not use provider CLI or network lookup. Stage A must not run direct CLI Git object checks; hive_git_snapshot is the sole permitted object-resolution exception. The required hive_review_workspace_create materialization is the only workspace-creation exception. Do not edit files, write Hive context, create plans, tasks, worktrees, commits, merges, or PRs, or call task recursively.`
    : `${REVIEW_FROZEN_WORKSPACE_BOUNDARY} Use only the enabled dash deep-lane tools inside the frozen review workspace: read, glob, grep, bash, webfetch, skill, and universal Hive metadata. MCP, Railway, Vercel, and other remote-service tools are not authorized. Report self-reported source-path escape or shell effects. Live source drift is non-attributable; do not use generic rollback. Treat ignored live artifacts as non-source output; regenerate required artifacts in serialized verification. Only the serialized verification lane returns a structured command transcript. Do not edit files through the editor, write Hive context, create plans, tasks, worktrees, commits, merges, or PRs, or call task recursively.`;

  return `${inherited}

## Frozen Workspace Review Lane

Configured lens: ${source.description}

${scopeBoundary}

${operationsBoundary}`;
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

  for (const source of [...input.sources].sort((left, right) => compareUnicodeCodePoints(left.name, right.name))) {
    aliasBySourceName.set(source.name, allocateAlias(source.name, usedNames));
  }

  for (const source of input.sources) {
    const taskTarget = aliasBySourceName.get(source.name)!;
    const policy = source.baseAgent === 'scout-researcher'
      ? REVIEW_ROLE_POLICIES['dash-review:scope']
      : REVIEW_ROLE_POLICIES['dash-review:deep'];
    const tools = buildReviewToolConfig(policy, input.hiveTools);
    agents[taskTarget] = {
      model: source.model,
      variant: source.variant,
      temperature: source.temperature,
      mode: 'subagent',
      description: `${DASH_REVIEW_LANE_DESCRIPTION_PREFIX}${source.name}: ${source.description}`,
      prompt: lanePrompt(source),
      tools,
      permission: {
        ...buildReviewPermission(policy),
        edit: 'deny',
        task: 'deny',
        delegate: 'deny',
        skill: source.baseAgent === 'scout-researcher' ? 'deny' : 'allow',
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
