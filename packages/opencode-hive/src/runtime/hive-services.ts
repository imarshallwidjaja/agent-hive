import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AdhocWorktreeService,
  CheckoutInspector,
  ConfigService,
  ContextService,
  ExplorationService,
  FeatureConstraintService,
  FeatureResolutionError,
  FeatureService,
  PlanService,
  RepositoryManifestService,
  RetainedCheckoutService,
  SessionService,
  TaskService,
  WorklogService,
  WorktreeOperationRecoveryService,
  WorktreeService,
  assertValidFeatureName,
  readCheckoutBrief,
  type ContextScope,
  type NativeObservationOwner,
  type SessionInfo,
  type StandingConstraintEntry,
  type WorklogAuthor,
  type WorklogRef,
} from 'hive-core';

/**
 * What a host supplies with each operation: the calling session, which resolves routes and constraints; the calling
 * agent as the host runtime reports it, never as a tool argument, for operations that stamp authorship; and, when the
 * host can cancel the call, a signal that aborts when it does. Operations that run long stages observe it.
 */
export type HiveInvocation = { sessionID?: string; agent?: string; signal?: AbortSignal };

export type ConstraintRegister = { entries: StandingConstraintEntry[]; revision: number; constraints: string };

/** The one task of the selected feature, or the one ad-hoc run of this project, that an authored assignment names. */
export type AssignmentBinding = { taskFolder: string } | { adHocRunId: string };

export type RouteSnapshot = {
  projectRoot: string;
  hasFeatureRoute: boolean;
  featureName?: string | null;
  sessionConstraints: ConstraintRegister;
  featureConstraints?: ConstraintRegister;
};

/**
 * What a dispatch's assignment marker (its first non-empty line) says: `none` when that line opens with no
 * `Hive task:` or `Hive run:` marker, `invalid` when it opens with one that names no ID or names a task or run Hive
 * cannot resolve, and `resolved` with the task or run it names.
 */
export type AssignmentMarker = { state: 'none' } | { state: 'invalid' } | { state: 'resolved'; binding: AssignmentBinding };

export type ConstraintTarget =
  | { scope: 'session'; sessionID: string }
  | { scope: 'feature'; feature: string };

const NON_FEATURE_NAMESPACES = new Set(['adhoc', 'review']);

/**
 * Hive's domain services bound to one canonical project root, plus the feature, session and constraint routing
 * every operation shares. Session state is read only when a route or constraint actually needs it, so an
 * operation that takes no feature never touches the session index.
 *
 * `nativeObservationOwner` is chosen by the host adapter. It selects only the session store;
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
  const worklogService = new WorklogService(projectRoot);
  const explorationService = new ExplorationService(projectRoot);
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

  const worktreeRecoveryService = new WorktreeOperationRecoveryService({
    baseDir: projectRoot,
    hiveDir: path.join(projectRoot, '.hive'),
    repositoryResolver: { resolveRepositories: repositoryResolver },
  });
  const checkoutConfig = { baseDir: projectRoot, hiveDir: path.join(projectRoot, '.hive'), repositoryResolver: { resolveRepositories: repositoryResolver } };
  const retainedCheckoutService = new RetainedCheckoutService(checkoutConfig);
  const checkoutInspector = new CheckoutInspector(checkoutConfig);
  const checkoutBrief = (request: { id: string; against?: string }) => readCheckoutBrief(checkoutConfig, request);

  // A listed feature whose metadata is unreadable or whose name is ambiguous is never the sole-live fallback.
  const liveFeatures = (): string[] => featureService.list().filter((name) => {
    let status: string | undefined;
    try {
      status = featureService.get(name)?.status;
    } catch (error) {
      if (error instanceof FeatureResolutionError) return false;
      throw error;
    }
    return status === 'planning' || status === 'approved' || status === 'executing';
  });
  const resolveFeature = (explicit: string | undefined, invocation?: HiveInvocation): string | null => {
    const sessionID = invocation?.sessionID;
    if (explicit !== undefined) {
      const feature = explicit.trim();
      assertValidFeatureName(feature);
      return feature;
    }
    return routeFeature(sessionID ? sessionService.getGlobal(sessionID) : undefined);
  };
  /** The feature a session's stored route selects, else the detected feature, else the sole live feature. */
  const routeFeature = (stored: SessionInfo | undefined): string | null => {
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
  /**
   * The session's route and standing constraints from one read of the session index. A strict capture reads it without
   * the reset-on-corruption path, so an unreadable index fails the capture and stays as found.
   */
  const captureRoute = (sessionID: string, options: { strict?: boolean } = {}): RouteSnapshot => {
    const session = options.strict ? sessionService.peekGlobal(sessionID) : sessionService.getGlobal(sessionID);
    const hasFeatureRoute = !!session && Object.prototype.hasOwnProperty.call(session, 'featureName');
    const featureName = routeFeature(session);
    const sessionConstraints = sessionService.standingConstraintRegister(session);
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
  /** The calling session and agent as a host-attested author, or undefined unless both are known. */
  const sessionActor = (invocation: HiveInvocation): WorklogAuthor | undefined => invocation.sessionID && invocation.agent
    ? { owner: nativeObservationOwner, sessionId: invocation.sessionID, agent: invocation.agent }
    : undefined;
  /**
   * The Worklog an ad-hoc run's creating session records into, by `resolveWorklogRef`'s rule without an explicit ref.
   * Undefined instead of an error when it cannot be resolved, so provenance never fails a create.
   */
  const adhocRunOrigin = (invocation: HiveInvocation): { worklog: WorklogRef } | undefined => {
    try {
      return { worklog: resolveWorklogRef(undefined, invocation) };
    } catch {
      return undefined;
    }
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
    worklogService,
    explorationService,
    worktreeService,
    worktreeRecoveryService,
    retainedCheckoutService,
    checkoutInspector,
    checkoutBrief,
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
    sessionActor,
    adhocRunOrigin,
    readConstraints,
    assertTaskRepoIds,
  };
}

export type HiveServices = ReturnType<typeof createHiveServices>;
