/**
 * Shared failure classification and cleanup observability for worktree,
 * ad-hoc, and merge operations.
 *
 * The classification table is the single source of truth for the phase,
 * mutation, retryable, and recovery action reported alongside a reason code.
 * `retryable` is always derived so the hard invariant holds everywhere:
 * a retryable result never reports a durable mutation.
 */

export type WorktreeOperationPhase =
  | 'validation'
  | 'preflight'
  | 'integration'
  | 'rollback'
  | 'verification'
  | 'cleanup';

export type WorktreeReasonCode =
  | 'INVALID_ARGUMENTS'
  | 'INVALID_COMMIT_MESSAGE'
  | 'INVALID_MERGE_MESSAGE'
  | 'MESSAGE_NOT_ALLOWED_FOR_REBASE'
  | 'RUN_NOT_FOUND'
  | 'WORKTREE_NOT_REGISTERED'
  | 'WORKTREE_LINKAGE_INVALID'
  | 'WORKSPACE_TOPOLOGY_MISMATCH'
  | 'WORKTREE_LOOKUP_FAILED'
  | 'SOURCE_BRANCH_MISSING'
  | 'TARGET_MISMATCH'
  | 'TARGET_DIRTY'
  | 'TARGET_RECONCILIATION_REQUIRED'
  | 'GIT_OPERATION_IN_PROGRESS'
  | 'ALREADY_INTEGRATED'
  | 'NO_TRACKED_CHANGES'
  | 'MERGE_CONFLICT_ABORTED'
  | 'MERGE_CONFLICT_PRESERVED'
  | 'GIT_OPERATION_FAILED'
  | 'ROLLBACK_FAILED'
  | 'POST_INTEGRATION_VERIFICATION_FAILED'
  | 'CLEANUP_FAILED'
  | 'COMPOSITE_PARTIAL'
  | 'OPERATION_RECOVERY_REQUIRED';

export type WorktreeRecoveryAction =
  | 'correct_arguments'
  | 'clean_target'
  | 'reconcile_target'
  | 'resolve_conflicts'
  | 'inspect_state'
  | 'retry_same_operation'
  | 'cleanup_only'
  | 'start_fresh_run'
  | 'manual_recovery'
  | 'none';

/**
 * Durable target state relative to the pre-operation starting state.
 * - none: target confirmed at (or restored to) its starting state
 * - applied: integration created durable target changes, not rolled back
 * - partial: composite operation where some repositories have durable changes and others do not
 * - preserved: Git conflict state intentionally left in place for a helper session
 * - unknown: service cannot confirm target state
 */
export type WorktreeMutationState = 'none' | 'applied' | 'partial' | 'preserved' | 'unknown';

export type CleanupStepStatus =
  | 'not_requested'
  | 'not_attempted'
  | 'already_absent'
  | 'succeeded'
  | 'failed';

export interface CleanupStepOutcome {
  status: CleanupStepStatus;
  error?: string;
}

export interface WorktreeCleanupOutcome {
  requested: 'none' | 'worktree' | 'worktree+branch';
  outcome: 'not_requested' | 'complete' | 'partial' | 'failed';
  worktreeRemoval: CleanupStepOutcome;
  branchDeletion: CleanupStepOutcome;
  prune: CleanupStepOutcome;
  failures: Array<{ step: string; repoId?: string; cause: string }>;
}

export interface WorktreeMergeCleanupBlock extends WorktreeCleanupOutcome {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  pruned: boolean;
}

export type WorktreeCleanupFacts = Pick<
  WorktreeMergeCleanupBlock,
  'worktreeRemoved' | 'branchDeleted' | 'pruned'
>;

export interface WorktreeRepositoryMergeResult {
  success: boolean;
  merged: boolean;
  sha?: string;
  commitMessage?: string;
  reason?: string;
  reasonCode?: WorktreeReasonCode;
  cleanupEligible?: boolean;
  filesChanged: string[];
  conflicts: string[];
  conflictState: 'none' | 'aborted' | 'preserved';
  cleanup: WorktreeMergeCleanupBlock;
  error?: string;
  phase: WorktreeOperationPhase;
  mutation: WorktreeMutationState;
  retryable: boolean;
  action: WorktreeRecoveryAction;
  expectedTarget?: import('./worktreeTarget.js').WorktreeTargetIdentity;
  observedTarget?: import('./worktreeTarget.js').WorktreeTargetIdentity | null;
}

interface WorktreeOutcomeRule {
  phase: WorktreeOperationPhase;
  mutation: WorktreeMutationState;
  retryable: boolean;
  action: WorktreeRecoveryAction;
}

/**
 * Frozen classification table. CLEANUP_FAILED carries a caller-supplied
 * mutation because cleanup itself never mutates the target: the value reflects
 * the completed integration the cleanup followed. POST_INTEGRATION_VERIFICATION_FAILED
 * accepts an `applied` override when the created commit is known to exist.
 */
const WORKTREE_OUTCOME_TABLE: Record<WorktreeReasonCode, WorktreeOutcomeRule> = {
  INVALID_ARGUMENTS: { phase: 'validation', mutation: 'none', retryable: false, action: 'correct_arguments' },
  INVALID_COMMIT_MESSAGE: { phase: 'validation', mutation: 'none', retryable: false, action: 'correct_arguments' },
  INVALID_MERGE_MESSAGE: { phase: 'validation', mutation: 'none', retryable: false, action: 'correct_arguments' },
  MESSAGE_NOT_ALLOWED_FOR_REBASE: { phase: 'validation', mutation: 'none', retryable: false, action: 'correct_arguments' },
  RUN_NOT_FOUND: { phase: 'preflight', mutation: 'none', retryable: false, action: 'inspect_state' },
  WORKTREE_NOT_REGISTERED: { phase: 'preflight', mutation: 'none', retryable: false, action: 'inspect_state' },
  WORKTREE_LINKAGE_INVALID: { phase: 'preflight', mutation: 'none', retryable: false, action: 'start_fresh_run' },
  WORKSPACE_TOPOLOGY_MISMATCH: { phase: 'preflight', mutation: 'none', retryable: false, action: 'start_fresh_run' },
  WORKTREE_LOOKUP_FAILED: { phase: 'preflight', mutation: 'none', retryable: true, action: 'inspect_state' },
  SOURCE_BRANCH_MISSING: { phase: 'preflight', mutation: 'none', retryable: false, action: 'inspect_state' },
  TARGET_MISMATCH: { phase: 'preflight', mutation: 'none', retryable: false, action: 'inspect_state' },
  TARGET_DIRTY: { phase: 'preflight', mutation: 'none', retryable: true, action: 'clean_target' },
  TARGET_RECONCILIATION_REQUIRED: { phase: 'preflight', mutation: 'none', retryable: false, action: 'reconcile_target' },
  GIT_OPERATION_IN_PROGRESS: { phase: 'preflight', mutation: 'none', retryable: false, action: 'inspect_state' },
  ALREADY_INTEGRATED: { phase: 'integration', mutation: 'none', retryable: false, action: 'none' },
  NO_TRACKED_CHANGES: { phase: 'integration', mutation: 'none', retryable: false, action: 'none' },
  MERGE_CONFLICT_ABORTED: { phase: 'integration', mutation: 'none', retryable: true, action: 'retry_same_operation' },
  MERGE_CONFLICT_PRESERVED: { phase: 'integration', mutation: 'preserved', retryable: false, action: 'resolve_conflicts' },
  GIT_OPERATION_FAILED: { phase: 'integration', mutation: 'none', retryable: true, action: 'inspect_state' },
  ROLLBACK_FAILED: { phase: 'rollback', mutation: 'unknown', retryable: false, action: 'manual_recovery' },
  POST_INTEGRATION_VERIFICATION_FAILED: { phase: 'verification', mutation: 'unknown', retryable: false, action: 'inspect_state' },
  CLEANUP_FAILED: { phase: 'cleanup', mutation: 'none', retryable: false, action: 'cleanup_only' },
  COMPOSITE_PARTIAL: { phase: 'integration', mutation: 'partial', retryable: false, action: 'inspect_state' },
  OPERATION_RECOVERY_REQUIRED: { phase: 'preflight', mutation: 'none', retryable: false, action: 'manual_recovery' },
};

export function isRetryableWithMutation(mutation: WorktreeMutationState): boolean {
  return mutation === 'none';
}

/**
 * Whether a finished integration reports a known destination state: neither the
 * aggregate nor any repository result says `unknown`. An unknown outcome keeps
 * the operation's pending markers so no replacement mutation runs blind.
 */
export function isMutationOutcomeKnown<T extends { mutation: WorktreeMutationState; repos?: Record<string, { mutation: WorktreeMutationState }> }>(result: T): boolean {
  return result.mutation !== 'unknown' && !Object.values(result.repos ?? {}).some((repository) => repository.mutation === 'unknown');
}

/**
 * Thrown when a workspace manifest's recorded topology no longer matches the
 * trusted repository manifest. Carries a stable reason code so callers can
 * classify the denial at the narrow call site without matching exception text.
 */
export class WorktreeTopologyMismatchError extends Error {
  readonly reasonCode: WorktreeReasonCode = 'WORKSPACE_TOPOLOGY_MISMATCH';

  constructor(message: string) {
    super(message);
    this.name = 'WorktreeTopologyMismatchError';
  }
}

/**
 * Thrown when worktree registration or trusted-Git identity cannot be
 * established: symlinked path components, a malformed or misdirected `.git`
 * pointer, an administration entry outside the trusted common directory, a
 * mismatched commondir or backlink.
 */
export class WorktreeLinkageError extends Error {
  readonly reasonCode: WorktreeReasonCode = 'WORKTREE_LINKAGE_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'WorktreeLinkageError';
  }
}

/**
 * Thrown before any effect when the repositories an operation selected, or the
 * Git common directories behind them, changed while it waited for operation
 * locks. The workspace may be consistent on the next read, so the recovery is
 * to inspect and retry rather than to start a fresh run.
 */
export class WorktreeSelectionChangedError extends Error {
  readonly reasonCode: WorktreeReasonCode = 'WORKTREE_LOOKUP_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'WorktreeSelectionChangedError';
  }
}

/**
 * Thrown when an interrupted worktree mutation still guards a resource, or a
 * pre-native operation lock file is present. `mutation` is `unknown` when the
 * operation that throws had itself begun mutating; `none` when it was refused
 * before any effect. Never retryable: inspect, confirm every mutator stopped,
 * then acknowledge the operation through supported recovery.
 */
export class WorktreeOperationRecoveryRequiredError extends Error {
  readonly reasonCode: WorktreeReasonCode = 'OPERATION_RECOVERY_REQUIRED';
  readonly mutation: WorktreeMutationState;
  readonly operationIds: string[];

  constructor(message: string, options: { mutation: WorktreeMutationState; operationIds: string[]; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WorktreeOperationRecoveryRequiredError';
    this.mutation = options.mutation;
    this.operationIds = options.operationIds;
  }
}

/**
 * Bookkeeping that failed after a worktree mutation produced its result. The
 * result itself stands: it reports what the operation did, and nothing was
 * rolled back. `markers` says whether this call's pending markers still guard
 * its resources:
 * - `retained`: the files in `retainedMarkers` remain, and later mutations of
 *   the resources they guard stay refused until the operation is acknowledged
 *   through Hive worktree recovery.
 * - `cleared_unflushed`: every marker file was removed, so nothing guards the
 *   resources now, but flushing the removal failed and it may not survive a
 *   host crash.
 * - `cleared` or `not_published`: no marker of this call exists.
 */
export interface WorktreeFinalizationFailure {
  /** The operation whose markers are retained or whose removal was not flushed; omitted otherwise. */
  operationId?: string;
  markers: 'not_published' | 'cleared' | 'cleared_unflushed' | 'retained';
  /** With `retained`: the marker files still present. */
  retainedMarkers?: string[];
  /** Why markers could not be removed, or why their removal could not be flushed. */
  markerError?: string;
  /** Why releasing an operation lock failed; the operating system releases it when this host process exits. */
  lockReleaseError?: string;
  /** `manual_recovery` while markers are retained; otherwise `inspect_state`, with nothing to acknowledge. */
  action: Extract<WorktreeRecoveryAction, 'manual_recovery' | 'inspect_state'>;
}

/**
 * Thrown by the operation guard when a mutation returned a result but clearing
 * its markers or releasing its locks failed. `result` is the unchanged result
 * the mutation returned. Callers report it with `finalization` instead of
 * turning the failure into a generic error.
 */
export class WorktreeOperationFinalizationError<T = unknown> extends Error {
  readonly result: T;
  readonly finalization: WorktreeFinalizationFailure;

  constructor(message: string, result: T, finalization: WorktreeFinalizationFailure, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorktreeOperationFinalizationError';
    this.result = result;
    this.finalization = finalization;
  }
}

/**
 * Report a mutation result together with its failed finalization. A classified
 * result becomes non-retryable once the operation began mutating, because a
 * repeat would be refused while markers remain or could repeat applied work;
 * its reason, mutation state, per-repository results and cleanup are kept.
 */
export function withFinalizationFailure<T extends object>(
  result: T,
  finalization: WorktreeFinalizationFailure,
): T & { finalization: WorktreeFinalizationFailure } {
  const began = finalization.markers !== 'not_published';
  return { ...result, ...(began && 'retryable' in result ? { retryable: false } : {}), finalization };
}

/**
 * Classify an exception thrown by a worktree service into a stable reason code.
 * Returns undefined when the error is neither a trusted-identity denial nor a
 * selection change, so callers can fall back to a generic operational failure.
 */
export function classifyThrownWorktreeError(error: unknown): WorktreeReasonCode | undefined {
  if (error instanceof WorktreeTopologyMismatchError) return 'WORKSPACE_TOPOLOGY_MISMATCH';
  if (error instanceof WorktreeLinkageError) return 'WORKTREE_LINKAGE_INVALID';
  if (error instanceof WorktreeSelectionChangedError) return 'WORKTREE_LOOKUP_FAILED';
  if (error instanceof WorktreeOperationRecoveryRequiredError) return 'OPERATION_RECOVERY_REQUIRED';
  return undefined;
}

/**
 * Resolve the reported classification for a reason code. `retryable` is derived
 * from the table and gated on `mutation`, so `retryable === true` implies
 * `mutation === 'none'`.
 */
export function classifyWorktreeOutcome(
  reasonCode: WorktreeReasonCode,
  mutation?: WorktreeMutationState,
): WorktreeOutcomeRule & { reasonCode: WorktreeReasonCode } {
  const rule = WORKTREE_OUTCOME_TABLE[reasonCode];
  const resolvedMutation = mutation ?? rule.mutation;
  return {
    phase: rule.phase,
    reasonCode,
    mutation: resolvedMutation,
    retryable: rule.retryable && isRetryableWithMutation(resolvedMutation),
    action: rule.action,
  };
}

/**
 * Assemble a cleanup outcome from per-step statuses. A step counts as complete
 * when it succeeded or was already absent. `outcome` is derived, not supplied.
 * Failed requested steps are listed in `failures`; callers may add causes that
 * are not tied to a single step (preflight denial, composite root removal).
 */
export function buildCleanupOutcome(
  requested: WorktreeCleanupOutcome['requested'],
  parts: {
    worktreeRemoval: CleanupStepOutcome;
    branchDeletion: CleanupStepOutcome;
    prune: CleanupStepOutcome;
    failures?: Array<{ step: string; repoId?: string; cause: string }>;
  },
): WorktreeCleanupOutcome {
  const stepLabels: Array<{ step: 'worktreeRemoval' | 'branchDeletion' | 'prune'; label: string }> = [
    { step: 'worktreeRemoval', label: 'worktree-removal' },
    { step: 'branchDeletion', label: 'branch-deletion' },
    { step: 'prune', label: 'prune' },
  ];
  const failures: Array<{ step: string; repoId?: string; cause: string }> = [];
  for (const { step, label } of stepLabels) {
    const outcome = parts[step];
    if (outcome.status === 'failed' && !(parts.failures ?? []).some((entry) => entry.step === label)) {
      failures.push({ step: label, cause: outcome.error ?? `${label} failed` });
    }
  }
  failures.push(...(parts.failures ?? []));

  const requestedSteps: CleanupStepOutcome[] = [parts.worktreeRemoval, parts.prune];
  if (requested === 'worktree+branch') requestedSteps.push(parts.branchDeletion);

  let outcome: WorktreeCleanupOutcome['outcome'];
  if (requested === 'none') {
    outcome = 'not_requested';
  } else {
    const allComplete = requestedSteps.every(
      (step) => step.status === 'succeeded' || step.status === 'already_absent',
    );
    const noneComplete = requestedSteps.every(
      (step) => step.status === 'failed' || step.status === 'not_attempted',
    );
    if (allComplete && failures.length === 0) outcome = 'complete';
    else if (noneComplete) outcome = 'failed';
    else outcome = 'partial';
  }

  return {
    requested,
    outcome,
    worktreeRemoval: parts.worktreeRemoval,
    branchDeletion: parts.branchDeletion,
    prune: parts.prune,
    failures,
  };
}

/**
 * Cleanup that never reached a destructive step: a failed pre-cleanup proof
 * or identity recheck. Every requested step is not_attempted.
 */
export function buildSkippedCleanupOutcome(
  requested: Exclude<WorktreeCleanupOutcome['requested'], 'none'>,
  failure: { step: string; repoId?: string; cause: string },
): WorktreeCleanupOutcome {
  return buildCleanupOutcome(requested, {
    worktreeRemoval: { status: 'not_attempted' },
    branchDeletion: requested === 'worktree+branch' ? { status: 'not_attempted' } : { status: 'not_requested' },
    prune: { status: 'not_attempted' },
    failures: [failure],
  });
}

/**
 * Thrown when a cleanup action fails after the worktree, prune, and branch
 * steps already produced `outcome`. Standalone cleanup surfaces the throw;
 * an integration caller reports the known steps with `step` as the failure.
 */
export class CleanupActionError extends Error {
  constructor(
    readonly outcome: WorktreeCleanupOutcome,
    readonly step: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'CleanupActionError';
  }
}

/**
 * Cleanup that threw after a completed integration. A CleanupActionError keeps
 * the steps it already observed and adds its failing action. Otherwise the
 * steps that ran before the exception are unknown, so no requested step is
 * reported complete. Either way the caller still reports the completed
 * integration with CLEANUP_FAILED.
 */
export function buildThrownCleanupOutcome(
  requested: Exclude<WorktreeCleanupOutcome['requested'], 'none'>,
  error: unknown,
  repoId?: string,
): WorktreeCleanupOutcome {
  const cause = error instanceof Error ? error.message : String(error);
  if (error instanceof CleanupActionError) {
    return buildCleanupOutcome(error.outcome.requested, {
      worktreeRemoval: error.outcome.worktreeRemoval,
      branchDeletion: error.outcome.branchDeletion,
      prune: error.outcome.prune,
      failures: [
        ...error.outcome.failures,
        { step: error.step, ...(repoId !== undefined ? { repoId } : {}), cause },
      ],
    });
  }
  const unknownStep: CleanupStepOutcome = { status: 'failed', error: `Cleanup threw before reporting this step: ${cause}` };
  return buildCleanupOutcome(requested, {
    worktreeRemoval: unknownStep,
    branchDeletion: requested === 'worktree+branch' ? unknownStep : { status: 'not_requested' },
    prune: unknownStep,
    failures: [{ step: 'cleanup', ...(repoId !== undefined ? { repoId } : {}), cause }],
  });
}

export function cleanupStepDone(step: CleanupStepOutcome): boolean {
  return step.status === 'succeeded' || step.status === 'already_absent';
}

export function buildNotRequestedCleanupOutcome(): WorktreeCleanupOutcome {
  return buildCleanupOutcome('none', {
    worktreeRemoval: { status: 'not_requested' },
    branchDeletion: { status: 'not_requested' },
    prune: { status: 'not_requested' },
  });
}

export function cleanupFacts(outcome: WorktreeCleanupOutcome): WorktreeCleanupFacts {
  return {
    worktreeRemoved: cleanupStepDone(outcome.worktreeRemoval),
    branchDeleted: outcome.requested === 'worktree+branch' && cleanupStepDone(outcome.branchDeletion),
    pruned: outcome.prune.status === 'succeeded',
  };
}

export function toMergeCleanupBlock(outcome: WorktreeCleanupOutcome): WorktreeMergeCleanupBlock {
  return { ...outcome, ...cleanupFacts(outcome) };
}

/**
 * Build the cleanup block for an operation that never requested cleanup, with
 * the same boolean projection the services apply to a real cleanup outcome.
 * Wrappers that must report cleanup state for a rejected or preflight-denied
 * operation use this instead of re-deriving the block by hand.
 */
export function buildNotRequestedMergeCleanupBlock(): WorktreeMergeCleanupBlock {
  return toMergeCleanupBlock(buildNotRequestedCleanupOutcome());
}

/**
 * Aggregate per-repository cleanup outcomes, attributing every failed step to
 * its repository so a composite failure names what needs attention. Failures
 * not tied to a step (a skipped proof, a cleanup exception) carry over once,
 * keeping the repository they name. A step succeeds only when every requested
 * repository step succeeded or was already absent. `rootFailure` records
 * composite-root removal failure.
 */
export function combineRepoCleanupOutcomes(
  requested: WorktreeCleanupOutcome['requested'],
  perRepo: Array<{ repoId: string; cleanup: WorktreeCleanupOutcome }>,
  rootFailure?: { cause: string },
): WorktreeCleanupOutcome {
  const failures: Array<{ step: string; repoId?: string; cause: string }> = [];
  const stepLabels = new Set(['worktree-removal', 'branch-deletion', 'prune']);
  for (const entry of perRepo) {
    for (const failure of entry.cleanup.failures) {
      if (stepLabels.has(failure.step)) continue;
      const attributed = { ...failure, repoId: failure.repoId ?? entry.repoId };
      const seen = failures.some((existing) =>
        existing.step === attributed.step && existing.repoId === attributed.repoId && existing.cause === attributed.cause);
      if (!seen) failures.push(attributed);
    }
  }

  const combineStep = (
    step: 'worktreeRemoval' | 'branchDeletion' | 'prune',
    label: string,
    requestedStep: boolean,
  ): CleanupStepOutcome => {
    if (!requestedStep) return { status: 'not_requested' };
    if (perRepo.length === 0) return { status: 'not_attempted' };
    const outcomes = perRepo.map((entry) => entry.cleanup[step]);
    for (const entry of perRepo) {
      const stepOutcome = entry.cleanup[step];
      if (stepOutcome.status === 'failed') {
        failures.push({
          step: label,
          repoId: entry.repoId,
          cause: stepOutcome.error ?? `${label} failed`,
        });
      }
    }
    if (outcomes.every((entry) => entry.status === 'already_absent')) return { status: 'already_absent' };
    if (outcomes.every((entry) => entry.status === 'succeeded' || entry.status === 'already_absent')) {
      return { status: 'succeeded' };
    }
    if (outcomes.every((entry) => entry.status === 'not_attempted')) return { status: 'not_attempted' };
    const errors = outcomes
      .map((entry) => entry.error)
      .filter((entry): entry is string => Boolean(entry));
    return { status: 'failed', ...(errors.length > 0 ? { error: errors.join('; ') } : {}) };
  };

  let worktreeRemoval = combineStep('worktreeRemoval', 'worktree-removal', requested !== 'none');
  if (rootFailure) {
    worktreeRemoval = { status: 'failed', error: rootFailure.cause };
    failures.push({ step: 'composite-root', cause: rootFailure.cause });
  }

  return buildCleanupOutcome(requested, {
    worktreeRemoval,
    branchDeletion: combineStep('branchDeletion', 'branch-deletion', requested === 'worktree+branch'),
    prune: combineStep('prune', 'prune', requested !== 'none'),
    failures,
  });
}
