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

/** Worker session information for background task execution */
export interface WorkerSession {
  /** Background task ID when the worker runs as a background subagent */
  taskId?: string;
  /** Unique session identifier */
  sessionId: string;
  /** Worker instance identifier */
  workerId?: string;
  /** Agent type handling this task */
  agent?: string;
  /** Execution mode: inline (same session) or delegate (background) */
  mode?: 'inline' | 'delegate';
  /** ISO timestamp of last heartbeat */
  lastHeartbeatAt?: string;
  /** Current attempt number (1-based) */
  attempt?: number;
  /** Number of messages exchanged in session */
  messageCount?: number;
}

export const WORKER_ASSIGNMENT_FORMAT = 'hive-worker-assignment/v1' as const;

export interface WorkerAssignmentDescriptor {
  format: typeof WORKER_ASSIGNMENT_FORMAT;
  projectRoot: string;
  featureName: string;
  taskFolder: string;
  attempt: number;
  /** Project-root-relative path to the immutable assignment bytes. */
  locator: string;
  /** SHA-256 of the raw assignment bytes. */
  contentHash: string;
}

export interface WorkerAttemptRecord {
  attempt: number;
  idempotencyKey: string;
  state: 'allocated' | 'published' | 'associated' | 'publication_failed';
  assignment?: WorkerAssignmentDescriptor;
  workerSessionId?: string;
  failure?: string;
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

export function renderAggregateBranchDiff(diff: TaskAggregateBranchDiff): string {
  return `Aggregate branch diff at commit time: ${diff.fileCount} file(s), +${diff.insertions}/-${diff.deletions}; `
    + `areas: ${diff.areas.length > 0 ? diff.areas.join(', ') : 'none'}; report: ${diff.report}`;
}

export interface TaskStatus {
  /** Schema version for forward compatibility (default: 1) */
  schemaVersion?: number;
  status: TaskStatusType;
  origin: TaskOrigin;
  planTitle?: string;
  summary?: string;
  /** Runtime-owned aggregate branch diff captured when a terminal report is written. */
  aggregateBranchDiff?: TaskAggregateBranchDiff;
  startedAt?: string;
  completedAt?: string;
  baseCommit?: string;
  baseCommits?: Record<string, string>;
  repoIds?: string[];
  subtasks?: Subtask[];
  /** Idempotency key for safe retries */
  idempotencyKey?: string;
  /** Current worker launch attempt (1-based), including attempts not yet associated with a session */
  workerAttempt?: number;
  /** Worker session info for background execution */
  workerSession?: WorkerSession;
  /** Immutable descriptor for the currently published assignment. */
  workerAssignment?: WorkerAssignmentDescriptor;
  /** Append-only launch-attempt state, including failed publications. */
  workerAttempts?: WorkerAttemptRecord[];
  /**
   * Task dependencies expressed as task folder names (e.g., '01-setup', '02-core-api').
   * A task cannot start until all its dependencies have status 'done'.
   * Resolved from plan.md dependency annotations during hive_tasks_sync.
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

export interface PlanReadResult {
  content: string;
  status: FeatureStatusType;
  comments: ReviewThread[];
  revision: string;
  contentHash: string;
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

export interface FeatureInfo {
  name: string;
  status: FeatureStatusType;
  tasks: TaskInfo[];
  hasPlan: boolean;
  commentCount: number;
  reviewCounts: ReviewCounts;
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
  featureName?: string;
  taskFolder?: string;
  projectRoot?: string;
  workerAssignment?: WorkerAssignmentDescriptor;
  assignmentSourceSessionId?: string;
  adHocRunId?: string;
  /** Immutable active workspace assigned to a delegated execution session. */
  executionWorkspacePath?: string;
  agent?: string;
  baseAgent?: string;
  sessionKind?: SessionKind;
  workerPromptPath?: string;
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

export interface NativeTaskLease {
  parentSessionId: string;
  callId: string;
  agent: string;
  projectRoot: string;
  resourcePaths: string[];
  runtimeId: string;
  capabilityReason?: string;
  /** Ownership only; prepared runtime assignment provenance grants Forager authority. */
  foragerLaunchId?: string;
  childSessionId?: string;
  terminal?: boolean;
}

export interface SessionsJson {
  master?: string;
  sessions: SessionInfo[];
  nativeTaskLeases?: NativeTaskLease[];
  /** Set to 2 after NativeTaskLease values are extracted into execution-attempts history. */
  executionOwnershipVersion?: 2;
}

export const EXECUTION_ATTEMPTS_SCHEMA_VERSION = 2;
export const EXECUTION_OWNERSHIP_VERSION = 2;
export const ARMED_ATTEMPT_TTL_MS = 5 * 60 * 1000;
export const PLACEHOLDER_NATIVE_CHILD_ID = 'forager-child';

export type ExecutionAttemptKind = 'task' | 'adhoc';
export type ExecutionAttemptPhase = 'armed' | 'attached' | 'stopped' | 'finalized';
export type ExecutionObservedOutcome =
  | 'not_started'
  | 'completed'
  | 'failed'
  | 'partial'
  | 'blocked'
  | 'cancelled'
  | 'superseded'
  | 'expired';

export type ExecutionPlacement =
  | {
      kind: 'worktree';
      /** Exact registered worktree paths (realpath). Composite workspaces list every repo worktree. */
      workspaceIdentities: string[];
      workspacePath: string;
      attemptSlot?: string;
      branch?: string;
      baseCommit?: string;
    }
  | {
      kind: 'in_place';
      /** Canonical existing directory. In-place placement does not establish an exclusion claim. */
      directory: string;
    };

export interface ExecutionNativeAttachment {
  parentSessionId: string;
  callId: string;
  selectedAgent: string;
  background: boolean;
  attachedAt: string;
  childSessionId?: string;
  constraintSnapshot?: {
    sourceSessionId: string;
    constraints?: string;
    entries?: StandingConstraintEntry[];
    revision?: number;
  };
}

export interface ExecutionStopEvidence {
  kind: 'blocking_after' | 'background_terminal' | 'tool_error';
  observedAt: string;
  state: 'completed' | 'error' | 'cancelled';
  nativeTaskId?: string;
}

export interface ExecutionAttempt {
  id: string;
  kind: ExecutionAttemptKind;
  featureName?: string;
  taskFolder?: string;
  runId?: string;
  originatingPrimarySession: string;
  /** Current task generation allocated when the arm is created. */
  taskAttempt?: number;
  placement: ExecutionPlacement;
  phase: ExecutionAttemptPhase;
  armRuntimeId?: string;
  expiresAt?: string;
  native?: ExecutionNativeAttachment;
  stopEvidence?: ExecutionStopEvidence;
  observedOutcome?: ExecutionObservedOutcome;
  reportLocator?: string;
  reportContentHash?: string;
  handoffOutcome?: ExecutionObservedOutcome;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
  finalizedAt?: string;
}

export interface ExecutionAttemptsJson {
  schemaVersion: 2;
  attempts: ExecutionAttempt[];
  nativeTaskLeaseHistory?: NativeTaskLease[];
  /** Current dispatch pointer per feature/task. Late records on superseded attempts must not move this. */
  currentTaskAttempts?: Record<string, string>;
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

export interface BackgroundJobOwnership {
  worktreePath?: string;
  branch?: string;
  workerPromptPath?: string;
  files?: string[];
  repoIds?: string[];
}

export interface BackgroundPendingLaunch {
  launchId: string;
  parentSessionId: string;
  disposition?: 'prepared' | 'claimed';
  background?: boolean;
  callId?: string;
  claimedAt?: string;
  runtimeId?: string;
  registrationError?: string;
  archivedAt?: string;
  archiveReason?: 'ignored' | 'reconciled';
  reconciliationSummary?: string;
  expectedDescription?: string;
  expectedPrompt?: string;
  agentName: string;
  scope?: BackgroundJobScope;
  ownership?: BackgroundJobOwnership;
  createdAt: string;
}

export interface BackgroundJobRecord {
  taskId: string;
  sessionId: string;
  launchId?: string;
  callId?: string;
  agentName: string;
  customAgentBase?: string;
  description?: string;
  objective?: string;
  createdAt: string;
  updatedAt: string;
  runtimeState: BackgroundJobRuntimeState;
  scopeSource?: 'pending-launch' | 'native-fallback' | 'retry';
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
  retryOf?: string;
  supersedes?: string;
  alias: string;
  scope?: BackgroundJobScope;
  ownership?: BackgroundJobOwnership;
}

export function isBackgroundJobArchived(job: { archivedAt?: string; ignoredAt?: string; reconciledAt?: string }): boolean {
  return !!(job.archivedAt || job.ignoredAt || job.reconciledAt);
}

export interface BackgroundJobsJson {
  schemaVersion: 1;
  jobs: BackgroundJobRecord[];
  pendingLaunches?: BackgroundPendingLaunch[];
  updatedAt?: string;
}

export interface TaskSpec {
  taskFolder: string;
  featureName: string;
  planSection: string;
  context: string;
  priorTasks: Array<{ folder: string; summary?: string }>;
}

/** Agent model/temperature configuration */
export interface AgentModelConfig {
  /** Model to use - format: "provider/model-id" (e.g., 'anthropic/claude-sonnet-4-20250514') */
  model?: string;
  /** Temperature for generation (0-2) */
  temperature?: number;
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
  '__hive_dash_review_primary',
  '__hive_vulnerability_review_primary',
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
] as const;

export interface CustomAgentConfig {
  baseAgent: CustomAgentBase;
  description: string;
  model?: string;
  temperature?: number;
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

export interface TaskTraceSummarizerConfig {
  model?: string;
  variant?: string;
  temperature?: number;
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
  /** Globally disable specific MCP servers. Available: websearch, context7, grep_app, ast_grep */
  disableMcps?: string[];
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
  /** Sandbox mode for worker isolation */
  sandbox?: 'none' | 'docker';
  /** Docker image to use when sandbox is 'docker' (optional explicit override) */
  dockerImage?: string;
  /** Reuse Docker containers per worktree (default: true when sandbox is 'docker') */
  persistentContainers?: boolean;
  /** @deprecated Migration-only root for legacy globally stored repository topology. */
  repositoryRoot?: string;
  /** @deprecated Migration-only topology. New manifests live in .hive/repositories.json. */
  repositories?: RepositoryConfig[];
  /** Hook execution cadence (number of turns between hook invocations). Key = hook name, Value = cadence (1 = every turn, 3 = every 3rd turn) */
  hook_cadence?: Record<string, number>;
}

/** Default models for Hive agents */
export const DEFAULT_AGENT_MODELS = {
  'hive-master': 'github-copilot/claude-opus-4.5',
  'architect-planner': 'github-copilot/gpt-5.2-codex',
  'swarm-orchestrator': 'github-copilot/claude-opus-4.5',
  'scout-researcher': 'zai-coding-plan/glm-4.7',
  'forager-worker': 'github-copilot/gpt-5.2-codex',
  'hive-helper': 'github-copilot/gpt-5.2-codex',
  'plan-reviewer': 'github-copilot/gpt-5.2-codex',
  'code-reviewer': 'github-copilot/gpt-5.2-codex',
  'simplicity-reviewer': 'github-copilot/gpt-5.2-codex',
  'approach-advisor': 'github-copilot/gpt-5.2-codex',
  'vulnerability-reviewer': 'github-copilot/gpt-5.2-codex',
  'hive-builder': 'github-copilot/gpt-5.2-codex',
} as const;

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

export const DEFAULT_HIVE_CONFIG: HiveConfig = {
  $schema: 'https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json',
  enableToolsFor: [],
  disableSkills: [],
  disableMcps: [],
  agentMode: 'dedicated',
  sandbox: 'none',
  council: DEFAULT_COUNCIL_CONFIG,
  taskTraceSummarizer: { temperature: 0 },
  customAgents: {
    'scout-example-template': {
      baseAgent: 'scout-researcher',
      description: 'Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.',
      autoLoadSkills: [],
    },
    'forager-example-template': {
      baseAgent: 'forager-worker',
      description: 'Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.',
      model: 'anthropic/claude-sonnet-4-20250514',
      temperature: 0.2,
      variant: 'high',
      autoLoadSkills: ['verification'],
    },
    'reviewer-example-template': {
      baseAgent: 'code-reviewer',
      description: 'Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.',
      autoLoadSkills: [],
    },
  },
  agents: {
    'hive-master': {
      model: DEFAULT_AGENT_MODELS['hive-master'],
      temperature: 0.5,
      autoLoadSkills: ['parallel-exploration'],
    },
    'architect-planner': {
      model: DEFAULT_AGENT_MODELS['architect-planner'],
      temperature: 0.7,
      autoLoadSkills: ['parallel-exploration'],
    },
    'swarm-orchestrator': {
      model: DEFAULT_AGENT_MODELS['swarm-orchestrator'],
      temperature: 0.5,
      autoLoadSkills: ['parallel-exploration'],
    },
    'scout-researcher': {
      model: DEFAULT_AGENT_MODELS['scout-researcher'],
      temperature: 0.5,
      autoLoadSkills: [],
    },
    'forager-worker': {
      model: DEFAULT_AGENT_MODELS['forager-worker'],
      temperature: 0.3,
      autoLoadSkills: ['verification'],
    },
    'hive-helper': {
      model: DEFAULT_AGENT_MODELS['hive-helper'],
      temperature: 0.3,
      autoLoadSkills: [],
    },
    'plan-reviewer': {
      model: DEFAULT_AGENT_MODELS['plan-reviewer'],
      temperature: 0.3,
      autoLoadSkills: [],
    },
    'code-reviewer': {
      model: DEFAULT_AGENT_MODELS['code-reviewer'],
      temperature: 0.3,
      autoLoadSkills: [],
    },
    'simplicity-reviewer': {
      model: DEFAULT_AGENT_MODELS['simplicity-reviewer'],
      temperature: 0.1,
      autoLoadSkills: [],
    },
    'approach-advisor': {
      model: DEFAULT_AGENT_MODELS['approach-advisor'],
      temperature: 0.3,
      autoLoadSkills: [],
    },
    'vulnerability-reviewer': {
      model: DEFAULT_AGENT_MODELS['vulnerability-reviewer'],
      temperature: 0.3,
      autoLoadSkills: [],
    },
    'hive-builder': {
      model: DEFAULT_AGENT_MODELS['hive-builder'],
      temperature: 0.4,
      autoLoadSkills: ['verification', 'parallel-exploration'],
    },
  },
};
