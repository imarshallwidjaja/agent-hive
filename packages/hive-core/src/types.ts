export type FeatureStatusType = 'planning' | 'approved' | 'executing' | 'completed' | 'archived';

export interface FeatureJson {
  name: string;
  status: FeatureStatusType;
  ticket?: string;
  sessionId?: string;
  createdAt: string;
  approvedAt?: string;
  completedAt?: string;
  archivedAt?: string;
  archiveReason?: string;
}

export interface FeatureDirectoryInfo {
  directoryName: string;
  logicalName: string;
  index: number | null;
}

export type TaskStatusType = 'pending' | 'in_progress' | 'done' | 'cancelled' | 'blocked' | 'failed' | 'partial';
export type TaskOrigin = 'plan' | 'manual';
export type SubtaskType = 'test' | 'implement' | 'review' | 'verify' | 'research' | 'debug' | 'custom';

export interface Subtask {
  id: string;
  name: string;
  folder: string;
  status: TaskStatusType;
  type?: SubtaskType;
  createdAt?: string;
  completedAt?: string;
}

export interface SubtaskStatus {
  status: TaskStatusType;
  type?: SubtaskType;
  createdAt: string;
  completedAt?: string;
}

export interface ManualTaskMetadata {
  goal?: string;
  description?: string;
  acceptanceCriteria?: string[];
  references?: string[];
  files?: string[];
  repoIds?: string[];
  reason?: string;
  source?: 'review' | 'operator' | 'ad_hoc';
  dependsOn?: string[];
}

export interface TaskAggregateBranchDiff {
  fileCount: number;
  insertions: number;
  deletions: number;
  areas: string[];
  report: string;
}

export interface TaskBlocker {
  reason: string;
  options?: string[];
  recommendation?: string;
  context?: string;
}

export interface TaskStatus {
  /** Schema version for forward compatibility (default: 1) */
  schemaVersion?: number;
  status: TaskStatusType;
  origin: TaskOrigin;
  planTitle?: string;
  summary?: string;
  /** Persisted operator-decision input for a blocked task. */
  blocker?: TaskBlocker;
  /** Runtime-owned aggregate branch diff captured when a terminal report is written. */
  aggregateBranchDiff?: TaskAggregateBranchDiff;
  startedAt?: string;
  completedAt?: string;
  baseCommit?: string;
  baseCommits?: Record<string, string>;
  repoIds?: string[];
  subtasks?: Subtask[];
  /**
   * Task dependencies expressed as task folder names (e.g., '01-setup', '02-core-api').
   * A task cannot start until all its dependencies have status 'done'.
   * Resolved from plan.md dependency annotations during hive_tasks_sync, or supplied at manual
   * creation. Writers store an explicit array; a missing field (legacy files) reads as [].
   * Edges of unfinished tasks must name existing tasks without cycles; edges of done or
   * cancelled tasks are history and are not revalidated.
   */
  dependsOn?: string[];
  /** Structured metadata for manual tasks */
  metadata?: ManualTaskMetadata;
}

export type ReviewDocument = 'plan';

export interface ReviewThread {
  id: string;
  line: number;
  body: string;
  replies: string[];
}

export interface CommentsJson {
  threads: ReviewThread[];
}

export interface ReviewCounts {
  plan: number;
}

export type PlanComment = ReviewThread;

export type PlanReadMode = 'full' | 'outline';

export interface PlanHeadingOutline {
  level: number;
  title: string;
  path: string[];
}

export interface PlanTaskOutline {
  taskNumber: number;
  title: string;
}

/** A level-3 heading inside `## Tasks` that is not a numbered `### N. Title` task. */
export interface PlanUnownedTaskHeading {
  /** 1-based line number in plan.md. */
  line: number;
  /** Heading text after `###`. */
  title: string;
}

export interface PlanReadResult {
  content: string;
  status: FeatureStatusType;
  comments: ReviewThread[];
  revision: string;
  contentHash: string;
  /** Non-blocking diagnostic, present only when `## Tasks` contains unowned headings. */
  unownedTaskHeadings?: PlanUnownedTaskHeading[];
}

export interface PlanWriteResult {
  path: string;
  /** Non-blocking diagnostic, present only when `## Tasks` contains unowned headings. */
  unownedTaskHeadings?: PlanUnownedTaskHeading[];
}

export interface PlanReadOutlineResult {
  status: FeatureStatusType;
  comments: ReviewThread[];
  revision: string;
  contentHash: string;
  headings: PlanHeadingOutline[];
  taskList: PlanTaskOutline[];
}

export interface PlanReadOptions {
  mode?: PlanReadMode;
}

export type PlanPatchOperation =
  | {
      type: 'replace_section';
      headingPath: string[];
      content: string;
    }
  | {
      type: 'replace_task';
      taskNumber: number;
      content: string;
    }
  | {
      type: 'insert_after_section';
      headingPath: string[];
      content: string;
    };

export interface PlanPatchResult {
  revision: string;
  contentHash: string;
  changedSections: string[];
}

export interface TasksSyncResult {
  created: string[];
  removed: string[];
  kept: string[];
  manual: string[];
  /** Existing tasks whose plan-owned fields and spec were rewritten from the plan; present only when nonempty. */
  refreshed?: string[];
  /** Selected or removable tasks left unchanged because their status changed during sync; present only when nonempty. */
  skipped?: string[];
  /** Non-blocking diagnostic, present only when `## Tasks` contains unowned headings. */
  unownedTaskHeadings?: PlanUnownedTaskHeading[];
}

/**
 * Whether the stored tasks reflect the current plan content, as last recorded by task sync. Advisory only:
 * it says nothing about approval, readiness, or whether a worker is running.
 * - current: the last sync reconciled this exact plan content and every unfinished plan task still matches it.
 * - changed: plan content changed since the last reconciled sync.
 * - incomplete: the last sync did not finish reconciling, or task records drifted from the synced plan.
 * - unknown: no readable sync record or plan to compare against.
 */
export type PlanSyncState = 'current' | 'changed' | 'incomplete' | 'unknown';

export interface PlanSyncStatus {
  state: PlanSyncState;
  hint?: string;
}

/** `task-sync.json` in the feature directory, written only by task sync. */
export interface TaskSyncCheckpoint {
  schemaVersion: 1;
  state: 'reconciled' | 'incomplete';
  /** Raw plan.md content hash of the last sync that reconciled every task, or null when none has. */
  lastReconciledContentHash: string | null;
}

export interface TaskInfo {
  folder: string;
  name: string;
  status: TaskStatusType;
  origin: TaskOrigin;
  planTitle?: string;
  summary?: string;
  repoIds?: string[];
}

export type ContextRole = 'human' | 'scratchpad' | 'operational' | 'durable' | 'evidence';
export type ContextKind = 'durable' | 'evidence';
export type ContextKindSource = 'index' | 'legacy_default';

export type ContextScope =
  | { type: 'feature'; featureName: string }
  | { type: 'project' };

export interface ContextMetadata {
  description?: string;
  readWhen?: string;
  owner?: string;
  reviewAfter?: string;
  warnings: string[];
}

export interface ContextIndexEntry {
  kind: ContextKind;
  createdAt: string;
  updatedAt: string;
  task?: string;
  lastManagedContentHash?: string;
}

export interface ContextIndex {
  schemaVersion: 1;
  revision: number;
  entries: Record<string, ContextIndexEntry>;
}

export interface ContextFile {
  name: string;
  content: string;
  updatedAt: string;
  createdAt?: string;
  kind?: ContextKind;
  kindSource?: ContextKindSource;
  task?: string;
  role: ContextRole;
  includeInExecution: boolean;
  includeInNetwork: boolean;
  bytes?: number;
  contentHash?: string;
  description?: string;
  readWhen?: string;
  owner?: string;
  reviewAfter?: string;
  warnings?: string[];
}

export type SessionKind = 'primary' | 'subagent' | 'task-worker' | 'unknown';

export type DirectiveRecoveryState = 'available' | 'consumed' | 'escalated';

export interface StandingConstraintEntry {
  id: string;
  text: string;
}

export interface SessionInfo {
  sessionId: string;
  parentSessionId?: string;
  duplicatedFromSessionId?: string;
  featureName?: string | null;
  taskFolder?: string;
  projectRoot?: string;
  adHocRunId?: string;
  agent?: string;
  baseAgent?: string;
  sessionKind?: SessionKind;
  directivePrompt?: string;
  standingConstraints?: string;
  standingConstraintEntries?: StandingConstraintEntry[];
  standingConstraintsRevision?: number;
  directiveRecoveryState?: DirectiveRecoveryState;
  replayDirectivePending?: boolean;
  startedAt: string;
  lastActiveAt: string;
  messageCount?: number;
}

export interface SessionsJson {
  master?: string;
  sessions: SessionInfo[];
}

export type BackgroundJobRuntimeState = 'running' | 'completed' | 'error' | 'cancelled' | 'unknown';

export interface BackgroundJobScope {
  feature?: string;
  task?: string;
  adHocRunId?: string;
  workflow?: string;
  parentSessionId?: string;
  primaryAgent?: string;
  projectRoot?: string;
}

export interface BackgroundJobRecord {
  taskId: string;
  sessionId: string;
  callId?: string;
  agentName: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  runtimeState: BackgroundJobRuntimeState;
  runtimeId?: string;
  terminalUnreconciled?: boolean;
  statusUncertain?: boolean;
  resultSummary?: string;
  lastStatusError?: string;
  runtimeCompletedAt?: string;
  cancelRequestedAt?: string;
  cancelReason?: string;
  reconciledAt?: string;
  reconciledBy?: string;
  reconciliationSummary?: string;
  ignoredAt?: string;
  ignoreReason?: string;
  archivedAt?: string;
  archiveReason?: 'reconciled' | 'ignored';
  staleAt?: string;
  promptNotifiedAt?: string;
  promptNotifiedInSessionId?: string;
  promptAcknowledgedAt?: string;
  promptBoardInjectionCount?: number;
  alias: string;
  scope?: BackgroundJobScope;
}

export function isBackgroundJobArchived(job: { archivedAt?: string; ignoredAt?: string; reconciledAt?: string }): boolean {
  return !!(job.archivedAt || job.ignoredAt || job.reconciledAt);
}

export interface BackgroundJobsJson {
  schemaVersion: 1;
  jobs: BackgroundJobRecord[];
  updatedAt?: string;
}

export interface TaskSpec {
  taskFolder: string;
  featureName: string;
  planSection: string;
  context: string;
  priorTasks: Array<{ folder: string; summary?: string }>;
}

/**
 * Agent model and skill configuration. Without `model` and `variant` the agent inherits the host's native model; a
 * `variant` requires an explicit Hive `model` on the effective declaration.
 */
export interface AgentModelConfig {
  /** Model to use - format: "provider/model-id" (e.g., 'anthropic/claude-sonnet-4-20250514') */
  model?: string;
  /** Skills to enable for this agent (legacy; native skill visibility is controlled by OpenCode registration, not by this allowlist) */
  skills?: string[];
  /** Native discovered or Hive bundled skill names to inject into this agent prompt at startup */
  autoLoadSkills?: string[];
  /** Variant key for model reasoning/effort level (e.g., 'low', 'medium', 'high', 'max') */
  variant?: string;
}

export interface RoutingAgentConfig extends AgentModelConfig {
  /** Human-facing routing description. Omission inherits the canonical Hive default. */
  description?: string;
}

export const BUILT_IN_AGENT_NAMES = [
  'hive-master',
  'architect-planner',
  'swarm-orchestrator',
  'scout-researcher',
  'forager-worker',
  'hive-helper',
  'plan-reviewer',
  'code-reviewer',
  'simplicity-reviewer',
  'approach-advisor',
  'vulnerability-reviewer',
  'hive-builder',
] as const;

export type BuiltInAgentName = (typeof BUILT_IN_AGENT_NAMES)[number];

export const CUSTOM_AGENT_BASES = [
  'scout-researcher',
  'forager-worker',
  'plan-reviewer',
  'code-reviewer',
  'simplicity-reviewer',
  'approach-advisor',
  'vulnerability-reviewer',
] as const;

export type CustomAgentBase = (typeof CUSTOM_AGENT_BASES)[number];

export const DEFAULT_ROUTING_AGENT_DESCRIPTIONS: Record<CustomAgentBase, string> = {
  'scout-researcher': 'Retrieves bounded internal or external code, context, and data evidence without owning diagnosis, tradeoffs, or solution selection.',
  'forager-worker': 'Implements and verifies delegated work in its assigned workspace; diagnosis-only assignments remain report-only.',
  'plan-reviewer': 'Default for ordinary plan review covering worker readiness, references, dependencies, and executable verification.',
  'code-reviewer': 'Default for ordinary implementation review covering correctness, tests, risk, scope creep, YAGNI, and dead code.',
  'simplicity-reviewer': 'Default for ordinary post-implementation simplicity review covering unnecessary abstractions, duplication, dead code, and safe deletion.',
  'approach-advisor': 'Default for ordinary read-only approach advice on technical direction, architecture, debugging, and tradeoffs.',
  'vulnerability-reviewer': 'Default for application-security review focused on evidenced attacker-to-impact paths and root-cause triage.',
};

export const CUSTOM_AGENT_RESERVED_NAMES = [
  ...BUILT_IN_AGENT_NAMES,
  'dash-reviewer',
  'vulnerability-review-primary',
  '__hive_task_trace_summarizer',
  'hive',
  'architect',
  'swarm',
  'scout',
  'forager',
  'hygienic',
  'hygienic-reviewer',
  'plan-reviewer',
  'code-reviewer',
  'simplicity-reviewer',
  'approach-advisor',
  'receiver',
  'build',
  'builder',
  'plan',
  'code',
  'general',
  'explore',
] as const;

export interface CustomAgentConfig {
  baseAgent: CustomAgentBase;
  description: string;
  model?: string;
  variant?: string;
  /** Additional native discovered or Hive bundled skill names to inject into this custom agent prompt at startup */
  autoLoadSkills?: string[];
}

export interface ResolvedCustomAgentConfig extends AgentModelConfig {
  baseAgent: CustomAgentBase;
  description: string;
}

export interface RepositoryConfig {
  id: string;
  path: string;
}

export interface CouncilGroupConfig {
  description?: string;
  members: string[];
  maxMembers?: number;
}

export interface CouncilConfig {
  defaultGroup?: string;
  maxMembers?: number;
  excludedAgents?: string[];
  groups?: Record<string, CouncilGroupConfig>;
}

/** Recovery summarizer model. Empty: each recovery uses the invoking caller's native model and variant. */
export interface TaskTraceSummarizerConfig {
  model?: string;
  variant?: string;
}

export interface ResolvedRepository {
  id: string;
  path: string;
  root: string;
}

export interface HiveConfig {
  /** Schema reference for config file */
  $schema?: string;
  /** Enable hive tools for specific features */
  enableToolsFor?: string[];
  /** Globally disable specific Hive bundled skills (excluded from materialization and autoload). Does not block user or native skills with the same name. */
  disableSkills?: string[];
  /** Choose between unified or dedicated agent modes */
  agentMode?: 'unified' | 'dedicated';
  /** Agent configuration */
  agents?: {
    /** Hive Master (hybrid planner + orchestrator) */
    'hive-master'?: AgentModelConfig;
    /** Architect Planner (planning-only) */
    'architect-planner'?: AgentModelConfig;
    /** Swarm Orchestrator */
    'swarm-orchestrator'?: AgentModelConfig;
    /** Scout Researcher */
    'scout-researcher'?: RoutingAgentConfig;
    /** Forager Worker */
    'forager-worker'?: RoutingAgentConfig;
    /** Hive Helper */
    'hive-helper'?: AgentModelConfig;
    /** Plan Reviewer */
    'plan-reviewer'?: RoutingAgentConfig;
    /** Code Reviewer */
    'code-reviewer'?: RoutingAgentConfig;
    /** Simplicity Reviewer */
    'simplicity-reviewer'?: RoutingAgentConfig;
    /** Approach Advisor */
    'approach-advisor'?: RoutingAgentConfig;
    /** Vulnerability Reviewer */
    'vulnerability-reviewer'?: RoutingAgentConfig;
    /** Hive Builder (ad-hoc executor) */
    'hive-builder'?: AgentModelConfig;
  };
  customAgents?: Record<string, CustomAgentConfig>;
  /** Global council command group configuration. */
  council?: CouncilConfig;
  /** Optional model settings for delegated-task recovery interpretation. */
  taskTraceSummarizer?: TaskTraceSummarizerConfig;
  /** @deprecated Migration-only root for legacy globally stored repository topology. */
  repositoryRoot?: string;
  /** @deprecated Migration-only topology. New manifests live in .hive/repositories.json. */
  repositories?: RepositoryConfig[];
  /** Hook execution cadence (number of turns between hook invocations). Key = hook name, Value = cadence (1 = every turn, 3 = every 3rd turn) */
  hook_cadence?: Record<string, number>;
}

export const DEFAULT_COUNCIL_CONFIG: CouncilConfig = {
  defaultGroup: 'decision',
  maxMembers: 4,
  excludedAgents: ['hive-master', 'swarm-orchestrator', 'forager-worker', 'hive-builder', 'hive-helper'],
  groups: {
    design: {
      description: 'Architecture and implementation-shape advice',
      members: ['scout-researcher', 'approach-advisor', 'plan-reviewer', 'code-reviewer'],
    },
    decision: {
      description: 'Hard tradeoff decision support',
      members: ['scout-researcher', 'approach-advisor', 'plan-reviewer'],
    },
    'minimal-change': {
      description: 'Smallest correct change and cleanup lens',
      members: ['scout-researcher', 'simplicity-reviewer', 'code-reviewer'],
    },
    documents: {
      description: 'Documentation and prose-oriented review',
      members: ['scout-researcher', 'code-reviewer', 'plan-reviewer'],
    },
  },
};

export const STARTER_CUSTOM_AGENTS: Record<string, CustomAgentConfig> = {
  'scout-example-template': {
    baseAgent: 'scout-researcher',
    description: 'Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.',
    autoLoadSkills: [],
  },
  'forager-example-template': {
    baseAgent: 'forager-worker',
    description: 'Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.',
    autoLoadSkills: ['verification'],
  },
  'reviewer-example-template': {
    baseAgent: 'code-reviewer',
    description: 'Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.',
    autoLoadSkills: [],
  },
};

export const DEFAULT_HIVE_CONFIG: HiveConfig = {
  $schema: 'https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json',
  enableToolsFor: [],
  disableSkills: [],
  agentMode: 'dedicated',
  council: DEFAULT_COUNCIL_CONFIG,
  customAgents: {},
  agents: {
    'hive-master': {
      autoLoadSkills: ['parallel-exploration'],
    },
    'architect-planner': {
      autoLoadSkills: ['parallel-exploration'],
    },
    'swarm-orchestrator': {
      autoLoadSkills: ['parallel-exploration'],
    },
    'scout-researcher': {
      autoLoadSkills: [],
    },
    'forager-worker': {
      autoLoadSkills: ['verification'],
    },
    'hive-helper': {
      autoLoadSkills: ['hive-config'],
    },
    'plan-reviewer': {
      autoLoadSkills: [],
    },
    'code-reviewer': {
      autoLoadSkills: [],
    },
    'simplicity-reviewer': {
      autoLoadSkills: [],
    },
    'approach-advisor': {
      autoLoadSkills: [],
    },
    'vulnerability-reviewer': {
      autoLoadSkills: [],
    },
    'hive-builder': {
      autoLoadSkills: ['verification', 'parallel-exploration'],
    },
  },
};
