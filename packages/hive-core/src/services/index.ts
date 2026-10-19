export { FeatureService, FEATURE_NAME_PATTERN, assertValidFeatureName } from './featureService.js';
export { FeatureConstraintService } from './featureConstraintService.js';
export {
  CONSTRAINTS_MAX_CHARS,
  ConstraintRegisterError,
} from './constraintRegister.js';
export type { ConstraintRegister } from './constraintRegister.js';
export { PlanService, PlanApprovalError, getPlanContentHash } from './planService.js';
export type { PlanApprovalResult, PlanApprovalStage, PlanApprovalFailureReason } from './planService.js';
export { TaskService, TaskSyncError, TaskUpdatePersistenceError, TASK_HANDOFF_MAX_BYTES } from './taskService.js';
export type {
  SyncOptions,
  TaskSyncAction,
  TaskSyncApplied,
  TaskSyncInterrupted,
  TaskSyncStage,
  TaskStatusEntry,
  TaskSpecFreshness,
  TaskSpecFreshnessReason,
  TaskUpdateInput,
  TaskUpdatePersistenceStage,
  TaskUpdateResult,
} from './taskService.js';
export { SubtaskService } from './subtaskService.js';
export { WorktreeService, createWorktreeService } from './worktreeService.js';
export type {
  WorktreeInfo,
  WorktreeListError,
  WorktreeListResult,
  WorktreeRepoInfo,
  WorktreeMode,
  DiffResult,
  ApplyResult,
  MergeResult,
  MergeCleanupBlock,
  RepoMergeResult,
  WorktreeConfig,
  MergeOptions,
  WorktreeRemoveOptions,
  RepositoryResolver,
  TaskRepoResolver,
} from './worktreeService.js';
export { AdhocWorktreeService } from './adhocWorktreeService.js';
export type {
  AdhocWorktreeConfig,
  AdhocCreateOptions,
  AdhocWorktreeInfo,
  AdhocWorktreeRepoInfo,
  AdhocWorktreeMode,
  AdhocMergeStrategy,
  AdhocMergeOptions,
  AdhocMergeResult,
  AdhocRepoMergeResult,
  AdhocMergeCleanupBlock,
  AdhocCleanupResult,
  AdhocCleanupOptions,
} from './adhocWorktreeService.js';
export {
  buildCleanupOutcome,
  buildNotRequestedMergeCleanupBlock,
  classifyThrownWorktreeError,
  classifyWorktreeOutcome,
  combineRepoCleanupOutcomes,
  isRetryableWithMutation,
  WorktreeLinkageError,
  WorktreeTopologyMismatchError,
} from './worktreeOutcome.js';
export type {
  WorktreeTargetComparison,
  WorktreeTargetIdentity,
  WorktreeTargetInspection,
} from './worktreeTarget.js';
export type {
  CleanupStepOutcome,
  CleanupStepStatus,
  WorktreeCleanupOutcome,
  WorktreeMutationState,
  WorktreeOperationPhase,
  WorktreeReasonCode,
  WorktreeRecoveryAction,
} from './worktreeOutcome.js';
export {
  ContextService,
  ContextMutationError,
  CONTEXT_INDEX_SCHEMA_VERSION,
  CONTEXT_CANDIDATE_MAX,
  CONTEXT_CATALOG_MAX_BYTES,
  CONTEXT_CHUNK_DEFAULT_BYTES,
  CONTEXT_CHUNK_MAX_BYTES,
  CONTEXT_DOCUMENT_MAX_BYTES,
  CONTEXT_NAMESPACE_ENTRY_MAX,
  CONTEXT_SCANNED_HEADER_MAX_BYTES,
  FEATURE_DURABLE_CHAR_WARNING_CAP,
  FEATURE_DURABLE_FILE_WARNING_CAP,
  PROJECT_DURABLE_CHAR_WARNING_CAP,
  PROJECT_DURABLE_FILE_WARNING_CAP,
} from './contextService.js';
export type {
  ContextArchiveResult,
  ContextCatalogOptions,
  ContextCatalogRead,
  ContextContentOptions,
  ContextContentRead,
  ContextDurableMetrics,
  ContextManagementCatalog,
  ContextManagementOptions,
  ContextKindSource,
  ContextMutationErrorReason,
  ContextMutationResult,
  ContextReadOptions,
  ContextReadSummary,
  ContextRecoverySummary,
} from './contextService.js';
export { ReviewService } from './reviewService.js';
export { SessionService, SessionContinuityError, STANDING_CONSTRAINTS_MAX_CHARS } from './sessionService.js';
export { BackgroundJobService } from './backgroundJobService.js';
export type {
  BackgroundJobScopeFilter,
  ReconcilePatch,
  RegisterBackgroundJobInput,
  RuntimeStatePatch,
} from './backgroundJobService.js';
export { ConfigService } from './configService.js';
export { RepositoryService } from './repositoryService.js';
export { readCompositeWorkspaceManifest } from './workspaceManifest.js';
export { RepositoryManifestService } from './repositoryManifestService.js';
export type {
  RepositoryDiscoveryCandidate,
  RepositoryDiscoveryResult,
  RepositoryManifestEntry,
  RepositoryManifestStatus,
  RepositoryManifestUpdateResult,
} from './repositoryManifestService.js';
export {
  WorklogService,
  WorklogError,
  getWorklogKey,
  getWorklogPath,
  parseWorklogKey,
  WORKLOG_AGENT_MAX_BYTES,
  WORKLOG_BRIEF_RECENT_DEFAULT,
  WORKLOG_BRIEFING_MAX_BYTES,
  WORKLOG_CORRECTED_BY_MAX,
  WORKLOG_CORRECTIONS_MAX,
  WORKLOG_DEFAULT_LIMIT,
  WORKLOG_DEFAULT_RESPONSE_BYTES,
  WORKLOG_DETAIL_MAX_BYTES,
  WORKLOG_ENTRY_MAX_BYTES,
  WORKLOG_FACTS_NOTICE,
  WORKLOG_LIST_CANDIDATE_MAX,
  WORKLOG_LOG_MAX_BYTES,
  WORKLOG_MAX_LIMIT,
  WORKLOG_MAX_RESPONSE_BYTES,
  WORKLOG_OPERATION_ID_MAX_BYTES,
  WORKLOG_REFERENCE_LABEL_MAX_BYTES,
  WORKLOG_REFERENCE_MAX_BYTES,
  WORKLOG_REFERENCES_MAX,
  WORKLOG_SCHEMA_VERSION,
  WORKLOG_SESSION_ID_MAX_BYTES,
  WORKLOG_SUMMARY_MAX_BYTES,
  WORKLOG_TITLE_MAX_BYTES,
} from './worklogService.js';
export type {
  WorklogAuthor,
  WorklogBriefRead,
  WorklogCheckpointInput,
  WorklogEntry,
  WorklogEntryBriefing,
  WorklogErrorReason,
  WorklogFactRow,
  WorklogFactsRead,
  WorklogFactsState,
  WorklogFactsSummary,
  WorklogHistoryRead,
  WorklogKind,
  WorklogListError,
  WorklogListOptions,
  WorklogListResult,
  WorklogReadOptions,
  WorklogReadResult,
  WorklogReadView,
  WorklogRecordInput,
  WorklogRecordResult,
  WorklogRef,
  WorklogReference,
  WorklogServiceOptions,
  WorklogSummary,
} from './worklogService.js';
export { buildEffectiveDependencies, computeRunnableAndBlocked } from './taskDependencyGraph.js';
export type { TaskWithDeps, RunnableBlockedResult } from './taskDependencyGraph.js';
