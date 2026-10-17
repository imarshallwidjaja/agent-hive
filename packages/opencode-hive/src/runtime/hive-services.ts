import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AdhocWorktreeService,
  BackgroundJobService,
  ConfigService,
  ContextService,
  FeatureConstraintService,
  FeatureService,
  PlanService,
  RepositoryManifestService,
  SessionService,
  TaskService,
  WorklogService,
  WorktreeService,
  assertValidFeatureName,
  type ContextScope,
  type NativeObservationOwner,
  type StandingConstraintEntry,
  type WorklogRef,
} from 'hive-core';

/**
 * What a host supplies with each operation: the calling session, which resolves routes and constraints; the calling
 * agent as the host runtime reports it, never as a tool argument, for operations that stamp authorship; and, when the
 * host can cancel the call, a signal that aborts when it does. Operations that run long stages observe it.
 */
export type HiveInvocation = { sessionID?: string; agent?: string; signal?: AbortSignal };

export type ConstraintRegister = { entries: StandingConstraintEntry[]; revision: number; constraints: string };

export type RouteSnapshot = {
  projectRoot: string;
  hasFeatureRoute: boolean;
  featureName?: string | null;
  sessionConstraints: ConstraintRegister;
  featureConstraints?: ConstraintRegister;
};

export type ConstraintTarget =
  | { scope: 'session'; sessionID: string }
  | { scope: 'feature'; feature: string };

const NON_FEATURE_NAMESPACES = new Set(['adhoc', 'review']);

/**
 * Hive's domain services bound to one canonical project root, plus the feature, session and constraint routing
 * every operation shares. Session state is read only when a route or constraint actually needs it, so an
 * operation that takes no feature never touches the session index.
 *
 * `nativeObservationOwner` is chosen by the host adapter. It selects only the session and background stores;
 * the project root stays the real one for every other service.
 */
export function createHiveServices(options: { projectRoot: string; detectedFeature?: string; nativeObservationOwner: NativeObservationOwner }) {
  const { projectRoot, detectedFeature, nativeObservationOwner } = options;
  const featureService = new FeatureService(projectRoot);
  const planService = new PlanService(projectRoot);
  const taskService = new TaskService(projectRoot);
  const sessionService = new SessionService(projectRoot, nativeObservationOwner);
  const featureConstraintService = new FeatureConstraintService(projectRoot);
  const contextService = new ContextService(projectRoot);
  const configService = new ConfigService(projectRoot);
  const repositoryManifestService = new RepositoryManifestService(projectRoot);
  const backgroundJobService = new BackgroundJobService(projectRoot, nativeObservationOwner);
  const worklogService = new WorklogService(projectRoot);
  // Loading the config is what records a fallback warning, so read it once here for status and startup reporting.
  configService.get();
  const configFallbackWarning = configService.getLastFallbackWarning()?.message;

  const hasManifest = (): boolean => repositoryManifestService.getStatus().mode === 'manifest';
  const repositoryResolver = () => hasManifest() ? repositoryManifestService.resolveRepositories() : [];
  const worktreeService = new WorktreeService({
    baseDir: projectRoot,
    hiveDir: path.join(projectRoot, '.hive'),
    repositoryResolver: { resolveRepositories: repositoryResolver },
    taskRepoResolver: { resolveTaskRepoIds: (feature, task) => taskService.getRawStatus(feature, task)?.repoIds },
  });
  const adhocService = (sourceDirectory?: string, repoIds?: string[]) => {
    if (sourceDirectory && repoIds !== undefined) throw new Error('sourceDirectory cannot be combined with repoIds for a foreign checkout; omit sourceDirectory for the active project root');
    if (sourceDirectory && !path.isAbsolute(sourceDirectory)) throw new Error('sourceDirectory must be absolute');
    const baseDir = sourceDirectory ? fs.realpathSync(sourceDirectory) : projectRoot;
    return new AdhocWorktreeService({
      baseDir,
      hiveDir: path.join(projectRoot, '.hive'),
      repositoryResolver: { resolveRepositories: sourceDirectory ? () => [] : repositoryResolver },
    });
  };

  const liveFeatures = (): string[] => featureService.list().filter((name) => {
    const status = featureService.get(name)?.status;
    return status === 'planning' || status === 'approved' || status === 'executing';
  });
  const resolveFeature = (explicit: string | undefined, invocation?: HiveInvocation): string | null => {
    const sessionID = invocation?.sessionID;
    if (explicit !== undefined) {
      const feature = explicit.trim();
      assertValidFeatureName(feature);
      return feature;
    }
    const stored = sessionID ? sessionService.getGlobal(sessionID) : undefined;
    if (stored && Object.prototype.hasOwnProperty.call(stored, 'featureName')) {
      if (stored.featureName !== null && stored.featureName !== undefined) assertValidFeatureName(stored.featureName);
      return stored.featureName ?? null;
    }
    if (detectedFeature && !NON_FEATURE_NAMESPACES.has(detectedFeature)) {
      assertValidFeatureName(detectedFeature);
      return detectedFeature;
    }
    const candidates = liveFeatures();
    return candidates.length === 1 ? candidates[0]! : null;
  };
  const requireFeature = (explicit: string | undefined, invocation?: HiveInvocation): string => {
    const feature = resolveFeature(explicit, invocation);
    if (!feature) throw new Error('Feature is required. Select one with hive_feature_select or pass feature explicitly.');
    return feature;
  };
  const contextScope = (scope: 'feature' | 'project' | undefined, feature: string | undefined, invocation?: HiveInvocation, task?: string): ContextScope => {
    if (scope === 'project') {
      if (feature !== undefined || task !== undefined) throw new Error('Project context does not accept feature or task selectors');
      return { type: 'project' };
    }
    const featureName = requireFeature(feature, invocation);
    if (task !== undefined && !taskService.getRawStatus(featureName, task)) throw new Error(`Task '${task}' does not exist in feature '${featureName}'`);
    return { type: 'feature', featureName };
  };
  const captureRoute = (sessionID: string): RouteSnapshot => {
    const session = sessionService.getGlobal(sessionID);
    const hasFeatureRoute = !!session && Object.prototype.hasOwnProperty.call(session, 'featureName');
    const featureName = resolveFeature(undefined, { sessionID });
    const sessionConstraints = sessionService.readStandingConstraints(sessionID);
    const featureConstraints = typeof featureName === 'string' ? featureConstraintService.read(featureName) : undefined;
    return { projectRoot, hasFeatureRoute, featureName, sessionConstraints, featureConstraints };
  };
  const constraintTarget = (input: { scope?: 'session' | 'feature'; feature?: string }, invocation: HiveInvocation): ConstraintTarget => {
    if ((input.scope ?? 'session') === 'session') {
      if (input.feature !== undefined) throw new Error('feature is not allowed with session constraint scope');
      if (!invocation.sessionID) throw new Error('Session identity is required');
      return { scope: 'session', sessionID: invocation.sessionID };
    }
    return { scope: 'feature', feature: requireFeature(input.feature, invocation) };
  };
  /**
   * The Worklog a call targets: an explicit ref (validated by core), else the feature selected for the calling
   * session, else that session's own log under this host's owner. Unlike `resolveFeature`, it never falls back to a
   * detected or sole live feature, because a narrative written into the wrong shared log cannot be deleted. The
   * session index is read without the reset-on-corruption path, and a selected feature that does not resolve fails
   * in core rather than falling back to the session log.
   */
  const resolveWorklogRef = (explicit: WorklogRef | undefined, invocation: HiveInvocation): WorklogRef => {
    if (explicit !== undefined) return explicit;
    const sessionID = invocation.sessionID;
    if (!sessionID) throw new Error('Session identity is required to resolve the default Worklog; pass ref explicitly.');
    const stored = sessionService.peekGlobal(sessionID);
    const selected = stored?.featureName;
    if (typeof selected === 'string') return { kind: 'feature', featureName: selected };
    if (selected !== undefined && selected !== null) throw new Error(`Session ${sessionID} has an invalid selected feature route; select a feature or null with hive_feature_select, or pass ref explicitly.`);
    return { kind: 'session', owner: nativeObservationOwner, sessionId: sessionID };
  };
  const readConstraints = (target: ConstraintTarget): ConstraintRegister => target.scope === 'session'
    ? sessionService.readStandingConstraints(target.sessionID)
    : featureConstraintService.read(target.feature);
  const assertTaskRepoIds = (feature: string, task: string, repoIds?: string[]): void => {
    if (repoIds === undefined) return;
    const stored = taskService.getRawStatus(feature, task)?.repoIds ?? [];
    if (JSON.stringify([...new Set(repoIds)].sort()) !== JSON.stringify([...new Set(stored)].sort())) {
      throw new Error(`repoIds must match the task repository selection: ${stored.join(', ') || '(single root)'}`);
    }
  };

  return {
    projectRoot,
    nativeObservationOwner,
    featureService,
    planService,
    taskService,
    sessionService,
    featureConstraintService,
    contextService,
    configService,
    repositoryManifestService,
    backgroundJobService,
    worklogService,
    worktreeService,
    configFallbackWarning,
    hasManifest,
    repositoryResolver,
    adhocService,
    resolveFeature,
    requireFeature,
    contextScope,
    captureRoute,
    constraintTarget,
    resolveWorklogRef,
    readConstraints,
    assertTaskRepoIds,
  };
}

export type HiveServices = ReturnType<typeof createHiveServices>;
