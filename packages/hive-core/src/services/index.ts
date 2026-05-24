export { FeatureService } from './featureService.js';
export { PlanService } from './planService.js';
export { TaskService } from './taskService.js';
export type { SyncOptions } from './taskService.js';
export { SubtaskService } from './subtaskService.js';
export { WorktreeService, createWorktreeService } from './worktreeService.js';
export type {
  WorktreeInfo,
  WorktreeRepoInfo,
  WorktreeMode,
  DiffResult,
  ApplyResult,
  CommitResult,
  MergeResult,
  WorktreeConfig,
  RepositoryResolver,
  TaskRepoResolver,
} from './worktreeService.js';
export { ContextService } from './contextService.js';
export { ReviewService } from './reviewService.js';
export { SessionService } from './sessionService.js';
export { ConfigService } from './configService.js';
export { RepositoryService } from './repositoryService.js';
export { RepositoryManifestService } from './repositoryManifestService.js';
export type {
  RepositoryDiscoveryCandidate,
  RepositoryDiscoveryResult,
  RepositoryManifestEntry,
  RepositoryManifestStatus,
  RepositoryManifestUpdateResult,
} from './repositoryManifestService.js';
export { AgentsMdService } from './agentsMdService.js';
export type { InitResult, SyncResult, ApplyResult as AgentsMdApplyResult } from './agentsMdService.js';
export { DockerSandboxService } from './dockerSandboxService.js';
export type { SandboxConfig } from './dockerSandboxService.js';
export { buildEffectiveDependencies, computeRunnableAndBlocked } from './taskDependencyGraph.js';
export type { TaskWithDeps, RunnableBlockedResult } from './taskDependencyGraph.js';
