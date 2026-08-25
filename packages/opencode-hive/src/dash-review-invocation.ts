import { isDeepStrictEqual } from 'node:util';
import * as path from 'node:path';
import type { DashReviewCommandPacket } from './commands/renderers.js';
import {
  fingerprintReviewIntent,
  parseReviewEvidenceResolution,
  parseReviewIntentPacket,
  type ReviewEvidenceResolution,
  type ReviewIntentPacket,
} from './review-evidence-resolution.js';
import type { ReviewSourceResolution } from './review-source-resolution.js';
import type { FrozenWorkspaceRootIdentity } from './review-frozen-workspace.js';

type SessionIdentity = {
  id: string;
  parentID?: string;
  time?: { created?: number };
};

export type DashReviewAuthorizationReason =
  | 'missing-primary-runtime-identity'
  | 'invocation-not-registered'
  | 'primary-agent-mismatch'
  | 'child-not-bound-to-invocation'
  | 'capability-expired'
  | 'runtime-generated-version-mismatch'
  | 'scope-already-reserved'
  | 'invalid-task-dispatch'
  | 'evidence-resolution-in-progress'
  | 'evidence-kind-mismatch'
  | 'evidence-not-resolved'
  | 'resolution-fingerprint-mismatch'
  | 'capability-consumed'
  | 'workspace-create-failed'
  | 'workspace-not-created'
  | 'workspace-not-claimed'
  | 'workspace-identity-mismatch'
  | 'workspace-cleaned'
  | 'source-stale'
  | 'session-ended';

type TaskReservation = {
  kind: 'scope' | 'deep';
  callID: string;
  expectedAgent: string;
  reservedAt: number;
  expiresAt: number;
  childSessionID?: string;
  childSession?: {
    id: string;
    parentID: string;
    created: number;
    ended?: boolean;
  };
};

type WorkspaceLifecycle = {
  runId: string;
  ownershipToken: string;
  workspacePath: string;
  claimed: boolean;
  boundary: DashReviewEvidenceBoundary;
  frozenRoot?: FrozenWorkspaceRootIdentity;
};

export type DashReviewMaterializationPlan =
  | { kind: 'git'; sourceResolution: ReviewSourceResolution }
  | { kind: 'inline'; bytes: Uint8Array }
  | { kind: 'local-artifacts'; sourcePaths: string[] };

export type DashReviewEvidenceBoundary = {
  kind: ReviewEvidenceResolution['kind'];
  scopeFingerprint: string;
  sourceFingerprint: string;
  resolutionFingerprint: string;
};

type EvidenceRecord =
  | { state: 'resolving'; kind: ReviewEvidenceResolution['kind']; token: EvidenceAuthority }
  | {
    state: 'resolved';
    resolution: ReviewEvidenceResolution;
    plan: DashReviewMaterializationPlan;
    createConsumed: boolean;
  };

type InvocationRecord = {
  generation: symbol;
  primarySessionID: string;
  primaryAgent: string;
  runtimeVersion: number;
  expiresAt: number;
  packet?: DashReviewCommandPacket;
  scope?: TaskReservation;
  deepTasks: Map<string, TaskReservation>;
  evidence?: EvidenceRecord;
  workspace?: WorkspaceLifecycle;
};

type BindingCandidate = {
  primarySessionID: string;
  generation: symbol;
  callID: string;
  expectedAgent: string;
  reservedAt: number;
  expiresAt: number;
  runtimeVersion: number;
  kind: TaskReservation['kind'];
};

type BindingSnapshot = Readonly<Record<never, never>>;
type EvidenceAuthority = Readonly<Record<never, never>>;
export type DashCreateAuthority = Readonly<Record<never, never>>;

export type DashEvidenceResolutionAction =
  | { kind: 'execute'; intent: ReviewIntentPacket; authority: EvidenceAuthority }
  | { kind: 'deny'; reason: DashReviewAuthorizationReason };

export type DashCreateAction =
  | {
      kind: 'execute';
      resolution: ReviewEvidenceResolution;
      plan: DashReviewMaterializationPlan;
      authority: DashCreateAuthority;
    }
  | { kind: 'deny'; reason: DashReviewAuthorizationReason };

type AuthorizationResult =
  | { allowed: true; agent: string }
  | { allowed: false; reason: DashReviewAuthorizationReason };

export type DashReviewLaneAuthorization =
  | {
    allowed: true;
    role: TaskReservation['kind'];
    workspacePath?: string;
    boundary?: DashReviewEvidenceBoundary;
    frozenRoot?: FrozenWorkspaceRootIdentity;
  }
  | { allowed: false; reason: DashReviewAuthorizationReason };

type TerminalAudit = {
  reason: DashReviewAuthorizationReason;
  terminatedAt: number;
  runtimeVersion: number;
  commandAuthorizationReleased?: boolean;
};

const DEFAULT_CAPABILITY_TTL_MS = 5 * 60 * 1000;
const MAX_AUDIT_SESSIONS = 128;

export class DashReviewInvocationStore {
  private readonly invocations = new Map<string, InvocationRecord>();
  private readonly bindingAuthorities = new WeakMap<BindingSnapshot, { childSessionID: string; candidates: BindingCandidate[] }>();
  private readonly evidenceAuthorities = new WeakMap<EvidenceAuthority, { primarySessionID: string; generation: symbol }>();
  private readonly createAuthorities = new WeakMap<DashCreateAuthority, { primarySessionID: string; generation: symbol }>();
  private readonly terminalAudit = new Map<string, TerminalAudit>();
  private readonly now: () => number;
  private readonly capabilityTtlMs: number;

  constructor(options: {
    now?: () => number;
    capabilityTtlMs?: number;
  } = {}) {
    this.now = options.now ?? Date.now;
    this.capabilityTtlMs = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  }

  replaceInvocation(input: {
    primarySessionID: string;
    primaryAgent: string;
    runtimeVersion: number;
    packet: DashReviewCommandPacket;
  }): void {
    if (input.packet.schema !== 'hive-dash-review-command/v3') {
      throw new Error('dash-review command packet schema is invalid.');
    }
    const packet: DashReviewCommandPacket = {
      schema: 'hive-dash-review-command/v3',
      intent: parseReviewIntentPacket(input.packet.intent),
    };
    const now = this.now();
    this.invocations.delete(input.primarySessionID);
    this.terminalAudit.delete(input.primarySessionID);
    this.invocations.set(input.primarySessionID, {
      generation: Symbol('dash-review-invocation'),
      primarySessionID: input.primarySessionID,
      primaryAgent: input.primaryAgent,
      runtimeVersion: input.runtimeVersion,
      expiresAt: now + this.capabilityTtlMs,
      packet: structuredClone(packet),
      deepTasks: new Map(),
    });
  }

  authorizePrimary(input: {
    sessionID: string;
    primaryAgent?: string;
    runtimeVersion: number;
  }): AuthorizationResult {
    const record = this.invocations.get(input.sessionID);
    if (!record) {
      return {
        allowed: false,
        reason: this.terminalAudit.get(input.sessionID)?.reason ?? 'invocation-not-registered',
      };
    }
    if (!input.primaryAgent) return { allowed: false, reason: 'missing-primary-runtime-identity' };
    if (input.primaryAgent !== record.primaryAgent) {
      this.stop(record, 'primary-agent-mismatch');
      return { allowed: false, reason: 'primary-agent-mismatch' };
    }
    if (input.runtimeVersion !== record.runtimeVersion) {
      this.stop(record, 'runtime-generated-version-mismatch');
      return { allowed: false, reason: 'runtime-generated-version-mismatch' };
    }
    if (!record.workspace && this.isExpired(record)) {
      this.stop(record, 'capability-expired');
      return { allowed: false, reason: 'capability-expired' };
    }
    return { allowed: true, agent: record.primaryAgent };
  }

  hasActiveInvocation(sessionID: string): boolean {
    return this.invocations.has(sessionID);
  }

  confirmPrimaryIdentity(input: {
    sessionID: string;
    observedAgent?: string;
    runtimeVersion: number;
  }): AuthorizationResult {
    const record = this.invocations.get(input.sessionID);
    if (!record) return { allowed: false, reason: 'invocation-not-registered' };
    if (!input.observedAgent) {
      this.stop(record, 'missing-primary-runtime-identity');
      return { allowed: false, reason: 'missing-primary-runtime-identity' };
    }
    return this.authorizePrimary({
      sessionID: input.sessionID,
      primaryAgent: input.observedAgent,
      runtimeVersion: input.runtimeVersion,
    });
  }

  terminalReasonForSession(sessionID: string): DashReviewAuthorizationReason | undefined {
    return this.terminalAudit.get(sessionID)?.reason;
  }

  hasTerminalPrimaryAuthorization(sessionID: string): boolean {
    const audit = this.terminalAudit.get(sessionID);
    return audit !== undefined && audit.commandAuthorizationReleased !== true;
  }

  reserveScope(input: {
    primarySessionID: string;
    primaryAgent: string;
    runtimeVersion: number;
    callID: string;
    expectedAgent: string;
    reservedAt: number;
    background: unknown;
  }): { allowed: true } | { allowed: false; reason: DashReviewAuthorizationReason } {
    const primary = this.authorizePrimary({
      sessionID: input.primarySessionID,
      primaryAgent: input.primaryAgent,
      runtimeVersion: input.runtimeVersion,
    });
    if ('reason' in primary) return primary;
    const record = this.invocations.get(input.primarySessionID)!;
    if (record.workspace || record.evidence?.state === 'resolved') return { allowed: false, reason: 'capability-consumed' };
    if (record.scope !== undefined) {
      this.stop(record, 'scope-already-reserved');
      return { allowed: false, reason: 'scope-already-reserved' };
    }
    if (
      !input.callID
      || !input.expectedAgent
      || !Number.isFinite(input.reservedAt)
      || input.background !== false
    ) {
      return { allowed: false, reason: 'invalid-task-dispatch' };
    }
    record.scope = {
      kind: 'scope',
      callID: input.callID,
      expectedAgent: input.expectedAgent,
      reservedAt: input.reservedAt,
      expiresAt: input.reservedAt + this.capabilityTtlMs,
    };
    return { allowed: true };
  }

  reserveDeep(input: {
    primarySessionID: string;
    primaryAgent: string;
    runtimeVersion: number;
    callID: string;
    expectedAgent: string;
    reservedAt: number;
    background: unknown;
  }):
    | { allowed: true; runId: string; workspacePath: string; boundary: DashReviewEvidenceBoundary }
    | { allowed: false; reason: DashReviewAuthorizationReason } {
    const primary = this.authorizePrimary({
      sessionID: input.primarySessionID,
      primaryAgent: input.primaryAgent,
      runtimeVersion: input.runtimeVersion,
    });
    if ('reason' in primary) return primary;
    const record = this.invocations.get(input.primarySessionID)!;
    if (!record.workspace?.claimed || !record.workspace.frozenRoot) return { allowed: false, reason: 'workspace-not-claimed' };
    if (
      !input.callID
      || !input.expectedAgent
      || !Number.isFinite(input.reservedAt)
      || input.background !== false
    ) {
      return { allowed: false, reason: 'invalid-task-dispatch' };
    }
    if (record.scope?.callID === input.callID || record.deepTasks.has(input.callID)) {
      return { allowed: false, reason: 'scope-already-reserved' };
    }
    record.deepTasks.set(input.callID, {
      kind: 'deep',
      callID: input.callID,
      expectedAgent: input.expectedAgent,
      reservedAt: input.reservedAt,
      expiresAt: input.reservedAt + this.capabilityTtlMs,
    });
    return {
      allowed: true,
      runId: record.workspace.runId,
      workspacePath: record.workspace.workspacePath,
      boundary: structuredClone(record.workspace.boundary),
    };
  }

  bindTaskChild(input: {
    primarySessionID: string;
    callID: string;
    childSessionID: string;
    expectedAgent?: string;
    runtimeVersion: number;
  }): boolean {
    if (!input.primarySessionID || !input.callID || !input.childSessionID) return false;
    const record = this.invocations.get(input.primarySessionID);
    if (!record || record.runtimeVersion !== input.runtimeVersion) return false;
    const reservation = this.taskReservation(record, input.callID);
    if (!reservation || (input.expectedAgent && reservation.expectedAgent !== input.expectedAgent)) return false;
    if (this.now() >= reservation.expiresAt) {
      this.stop(record, 'capability-expired', input.childSessionID);
      return false;
    }
    if (reservation.childSessionID && reservation.childSessionID !== input.childSessionID) {
      this.stop(record, 'child-not-bound-to-invocation', input.childSessionID);
      return false;
    }
    reservation.childSessionID = input.childSessionID;
    return true;
  }

  beginConsumerBinding(input: {
    childSessionID: string;
    inputAgent: string;
    messageAgent: string;
    runtimeVersion: number;
  }): BindingSnapshot | undefined {
    if (!input.childSessionID || !input.inputAgent || input.inputAgent !== input.messageAgent) return undefined;
    const candidates: BindingCandidate[] = [];
    for (const record of this.invocations.values()) {
      if (record.runtimeVersion !== input.runtimeVersion) {
        this.stop(record, 'runtime-generated-version-mismatch', input.childSessionID);
        continue;
      }
      for (const reservation of this.taskReservations(record)) {
        if (
          reservation.childSessionID !== input.childSessionID
          || reservation.childSession !== undefined
          || reservation.expectedAgent !== input.inputAgent
        ) continue;
        if (this.now() >= reservation.expiresAt) {
          this.stop(record, 'capability-expired', input.childSessionID);
          continue;
        }
        candidates.push({
          primarySessionID: record.primarySessionID,
          generation: record.generation,
          callID: reservation.callID,
          expectedAgent: reservation.expectedAgent,
          reservedAt: reservation.reservedAt,
          expiresAt: reservation.expiresAt,
          runtimeVersion: record.runtimeVersion,
          kind: reservation.kind,
        });
      }
    }
    if (candidates.length === 0) return undefined;
    const snapshot = Object.freeze({});
    this.bindingAuthorities.set(snapshot, { childSessionID: input.childSessionID, candidates });
    return snapshot;
  }

  commitConsumerBinding(snapshot: BindingSnapshot, session: SessionIdentity): boolean {
    const authority = snapshot && typeof snapshot === 'object'
      ? this.bindingAuthorities.get(snapshot)
      : undefined;
    if (authority) this.bindingAuthorities.delete(snapshot);
    if (
      !authority
      || session.id !== authority.childSessionID
      || typeof session.parentID !== 'string'
      || typeof session.time?.created !== 'number'
      || !Number.isFinite(session.time.created)
    ) return false;
    for (const candidate of authority.candidates) {
      if (
        candidate.primarySessionID !== session.parentID
        || session.time.created < candidate.reservedAt
        || session.time.created >= candidate.expiresAt
      ) continue;
      const record = this.invocations.get(candidate.primarySessionID);
      const reservation = record ? this.taskReservation(record, candidate.callID) : undefined;
      if (
        !record
        || record.generation !== candidate.generation
        || record.runtimeVersion !== candidate.runtimeVersion
        || !reservation
        || reservation.kind !== candidate.kind
        || reservation.callID !== candidate.callID
        || reservation.expectedAgent !== candidate.expectedAgent
        || reservation.reservedAt !== candidate.reservedAt
        || reservation.childSessionID !== session.id
        || reservation.childSession !== undefined
      ) continue;
      if (this.now() >= reservation.expiresAt) {
        this.stop(record, 'capability-expired', session.id);
        return false;
      }
      reservation.childSession = {
        id: session.id,
        parentID: session.parentID,
        created: session.time.created,
      };
      return true;
    }
    return false;
  }

  revokeConsumerBinding(snapshot: BindingSnapshot): boolean {
    const authority = snapshot && typeof snapshot === 'object'
      ? this.bindingAuthorities.get(snapshot)
      : undefined;
    if (!authority) return false;
    this.bindingAuthorities.delete(snapshot);
    return true;
  }

  beginEvidenceResolution(input: {
    session: SessionIdentity;
    agent: string;
    runtimeVersion: number;
    requestedKind: ReviewEvidenceResolution['kind'];
  }): DashEvidenceResolutionAction {
    const record = this.recordForBoundChild(input.session.id, input.agent);
    if (!record) {
      return {
        kind: 'deny',
        reason: this.terminalAudit.get(input.session.id)?.reason ?? 'child-not-bound-to-invocation',
      };
    }
    const invalid = this.validateBoundRecord(record, input.session, input.runtimeVersion);
    if (invalid) return { kind: 'deny', reason: invalid };
    if (!record.packet) return { kind: 'deny', reason: 'evidence-not-resolved' };
    if (record.evidence?.state === 'resolving') {
      return { kind: 'deny', reason: 'evidence-resolution-in-progress' };
    }
    if (record.evidence?.state === 'resolved') return { kind: 'deny', reason: 'capability-consumed' };
    const intent = record.packet.intent;
    const fixedKind = intent.githubPullRequest
      ? 'git'
      : intent.fixedArtifacts.length > 0
        ? 'local-artifacts'
        : intent.normalizedIntent.trim().length === 0
          ? 'git'
          : undefined;
    if (
      (fixedKind !== undefined && input.requestedKind !== fixedKind)
      || (fixedKind === undefined && input.requestedKind === 'local-artifacts')
    ) {
      this.stop(record, 'evidence-kind-mismatch', input.session.id);
      return { kind: 'deny', reason: 'evidence-kind-mismatch' };
    }
    const authority = Object.freeze({});
    record.evidence = {
      state: 'resolving',
      kind: input.requestedKind,
      token: authority,
    };
    this.evidenceAuthorities.set(authority, {
      primarySessionID: record.primarySessionID,
      generation: record.generation,
    });
    return { kind: 'execute', intent: structuredClone(intent), authority };
  }

  recordEvidenceResolution(
    authority: EvidenceAuthority,
    result: {
      resolution: ReviewEvidenceResolution;
      plan: DashReviewMaterializationPlan;
    },
  ): boolean {
    const match = this.matchingEvidenceAuthority(authority);
    const evidence = match?.record.evidence;
    if (!match || evidence?.state !== 'resolving' || evidence.token !== authority || !match.record.packet) return false;
    this.evidenceAuthorities.delete(authority);
    let resolution: ReviewEvidenceResolution;
    try {
      resolution = parseReviewEvidenceResolution(result.resolution);
      if (
        resolution.kind !== evidence.kind
        || resolution.intentFingerprint !== fingerprintReviewIntent(match.record.packet.intent)
        || result.plan.kind !== resolution.kind
      ) throw new Error('resolution mismatch');
      if (result.plan.kind === 'git') {
        if (resolution.kind !== 'git' || !isDeepStrictEqual(result.plan.sourceResolution, resolution.evidence.sourceResolution)) {
          throw new Error('Git materialization plan mismatch');
        }
      } else if (result.plan.kind === 'inline') {
        if (
          resolution.kind !== 'inline'
          || !Buffer.from(result.plan.bytes).equals(Buffer.from(match.record.packet.intent.normalizedIntent, 'utf8'))
        ) throw new Error('Inline materialization plan mismatch');
      } else if (
        resolution.kind !== 'local-artifacts'
        || !isDeepStrictEqual(result.plan.sourcePaths, match.record.packet.intent.fixedArtifacts)
      ) throw new Error('Artifact materialization plan mismatch');
    } catch {
      this.stop(match.record, 'evidence-not-resolved', match.record.scope?.childSession?.id);
      return false;
    }
    match.record.evidence = {
      state: 'resolved',
      resolution: structuredClone(resolution),
      plan: structuredClone(result.plan),
      createConsumed: false,
    };
    return true;
  }

  revokeEvidenceResolution(authority: EvidenceAuthority): boolean {
    const match = this.matchingEvidenceAuthority(authority);
    this.evidenceAuthorities.delete(authority);
    if (!match) return false;
    this.stop(match.record, 'workspace-create-failed', match.record.scope?.childSession?.id);
    return true;
  }

  takeCreate(input: {
    session: SessionIdentity;
    agent: string;
    runtimeVersion: number;
    resolutionFingerprint: string;
  }): DashCreateAction {
    const record = this.recordForBoundChild(input.session.id, input.agent);
    if (!record) {
      return {
        kind: 'deny',
        reason: this.terminalAudit.get(input.session.id)?.reason ?? 'child-not-bound-to-invocation',
      };
    }
    const invalid = this.validateBoundRecord(record, input.session, input.runtimeVersion);
    if (invalid) return { kind: 'deny', reason: invalid };
    const evidence = record.evidence;
    if (evidence?.state !== 'resolved') {
      this.stop(record, 'evidence-not-resolved', input.session.id);
      return { kind: 'deny', reason: 'evidence-not-resolved' };
    }
    if (evidence.createConsumed) return { kind: 'deny', reason: 'capability-consumed' };
    if (evidence.resolution.resolutionFingerprint !== input.resolutionFingerprint) {
      this.stop(record, 'resolution-fingerprint-mismatch', input.session.id);
      return { kind: 'deny', reason: 'resolution-fingerprint-mismatch' };
    }
    evidence.createConsumed = true;
    const authority = Object.freeze({});
    this.createAuthorities.set(authority, {
      primarySessionID: record.primarySessionID,
      generation: record.generation,
    });
    return {
      kind: 'execute',
      resolution: structuredClone(evidence.resolution),
      plan: structuredClone(evidence.plan),
      authority,
    };
  }

  completeCreate(input: {
    authority: DashCreateAuthority;
    runId: string;
    ownershipToken: string;
    workspacePath: string;
    boundary: DashReviewEvidenceBoundary;
  }): boolean {
    const record = this.matchingCreateAuthority(input.authority);
    this.createAuthorities.delete(input.authority);
    if (!record) return false;
    if (!input.runId || !input.ownershipToken || !path.isAbsolute(input.workspacePath) || record.workspace) return false;
    if (record.evidence?.state !== 'resolved' || record.evidence.createConsumed !== true) return false;
    const resolution = record.evidence.resolution;
    if (
      input.boundary.kind !== resolution.kind
      || input.boundary.resolutionFingerprint !== resolution.resolutionFingerprint
      || !/^[a-f0-9]{64}$/.test(input.boundary.scopeFingerprint)
      || !/^[a-f0-9]{64}$/.test(input.boundary.sourceFingerprint)
    ) return false;
    record.workspace = {
      runId: input.runId,
      ownershipToken: input.ownershipToken,
      workspacePath: input.workspacePath,
      claimed: false,
      boundary: structuredClone(input.boundary),
    };
    return true;
  }

  authorizeWorkspaceClaim(input: {
    primarySessionID: string;
    primaryAgent: string;
    runtimeVersion: number;
    runId: string;
    ownershipToken: string;
  }): AuthorizationResult {
    const primary = this.authorizePrimary({
      sessionID: input.primarySessionID,
      primaryAgent: input.primaryAgent,
      runtimeVersion: input.runtimeVersion,
    });
    if ('reason' in primary) return primary;
    const workspace = this.invocations.get(input.primarySessionID)?.workspace;
    if (!workspace) return { allowed: false, reason: 'workspace-not-created' };
    if (workspace.runId !== input.runId || workspace.ownershipToken !== input.ownershipToken) {
      return { allowed: false, reason: 'workspace-identity-mismatch' };
    }
    return primary;
  }

  recordWorkspaceClaimed(input: {
    primarySessionID: string;
    runId: string;
    ownershipToken: string;
    frozenRoot: FrozenWorkspaceRootIdentity;
  }): boolean {
    const workspace = this.invocations.get(input.primarySessionID)?.workspace;
    if (
      !workspace
      || workspace.runId !== input.runId
      || workspace.ownershipToken !== input.ownershipToken
      || workspace.workspacePath !== input.frozenRoot.canonicalPath
      || input.frozenRoot.serviceKind !== (workspace.boundary.kind === 'git' ? 'git' : 'evidence-bundle')
    ) return false;
    workspace.claimed = true;
    workspace.frozenRoot = structuredClone(input.frozenRoot);
    return true;
  }

  restoreClaimedWorkspace(input: {
    primarySessionID: string;
    primaryAgent: string;
    runtimeVersion: number;
    runId: string;
    ownershipToken: string;
    workspacePath: string;
    boundary: DashReviewEvidenceBoundary;
    frozenRoot: FrozenWorkspaceRootIdentity;
  }): boolean {
    if (
      !input.primarySessionID
      || !input.primaryAgent
      || !Number.isFinite(input.runtimeVersion)
      || !input.runId
      || !input.ownershipToken
      || !path.isAbsolute(input.workspacePath)
      || !input.boundary
      || input.workspacePath !== input.frozenRoot.canonicalPath
      || input.frozenRoot.serviceKind !== (input.boundary.kind === 'git' ? 'git' : 'evidence-bundle')
    ) return false;
    const existing = this.invocations.get(input.primarySessionID);
    if (existing) {
      const workspace = existing.workspace;
      if (
        existing.primaryAgent !== input.primaryAgent
        || existing.runtimeVersion !== input.runtimeVersion
        || !workspace
        || workspace.runId !== input.runId
        || workspace.ownershipToken !== input.ownershipToken
        || workspace.workspacePath !== input.workspacePath
        || !isDeepStrictEqual(workspace.boundary, input.boundary)
        || (workspace.frozenRoot !== undefined && !isDeepStrictEqual(workspace.frozenRoot, input.frozenRoot))
      ) return false;
      workspace.claimed = true;
      workspace.frozenRoot = structuredClone(input.frozenRoot);
      return true;
    }
    this.terminalAudit.delete(input.primarySessionID);
    this.invocations.set(input.primarySessionID, {
      generation: Symbol('dash-review-recovered-invocation'),
      primarySessionID: input.primarySessionID,
      primaryAgent: input.primaryAgent,
      runtimeVersion: input.runtimeVersion,
      expiresAt: Number.POSITIVE_INFINITY,
      deepTasks: new Map(),
      workspace: {
        runId: input.runId,
        ownershipToken: input.ownershipToken,
        workspacePath: input.workspacePath,
        claimed: true,
        boundary: structuredClone(input.boundary),
        frozenRoot: structuredClone(input.frozenRoot),
      },
    });
    return true;
  }

  authorizeWorkspaceAccess(input: {
    primarySessionID: string;
    primaryAgent: string;
    runtimeVersion: number;
    runId: string;
    ownershipToken: string;
  }): AuthorizationResult {
    const claim = this.authorizeWorkspaceClaim(input);
    if (!claim.allowed) return claim;
    const workspace = this.invocations.get(input.primarySessionID)!.workspace!;
    return workspace.claimed && workspace.frozenRoot ? claim : { allowed: false, reason: 'workspace-not-claimed' };
  }

  abortCreate(authority: DashCreateAuthority, reason: DashReviewAuthorizationReason): boolean {
    const record = this.matchingCreateAuthority(authority);
    this.createAuthorities.delete(authority);
    if (!record) return false;
    this.stop(record, reason, record.scope?.childSession?.id);
    return true;
  }

  abortForSession(sessionID: string, reason: DashReviewAuthorizationReason): boolean {
    const primary = this.invocations.get(sessionID);
    if (primary) {
      this.stop(primary, reason);
      return true;
    }
    for (const record of this.invocations.values()) {
      if (this.taskReservations(record).some((reservation) => reservation.childSession?.id === sessionID)) {
        this.stop(record, reason, sessionID);
        return true;
      }
    }
    return false;
  }

  finishScopeTask(input: { primarySessionID: string; callID: string; completed: boolean }): void {
    const record = this.invocations.get(input.primarySessionID);
    const reservation = record ? this.taskReservation(record, input.callID) : undefined;
    if (!record || !reservation) return;
    if (reservation.kind === 'deep') {
      record.deepTasks.delete(input.callID);
      return;
    }
    if (!record.workspace || !input.completed) {
      this.stop(record, 'workspace-create-failed', reservation.childSession?.id ?? reservation.childSessionID);
    }
  }

  authorizeLaneChild(input: {
    sessionID: string;
    agent: string;
    runtimeVersion: number;
  }): DashReviewLaneAuthorization {
    for (const record of this.invocations.values()) {
      const reservation = this.taskReservations(record).find((candidate) => (
        candidate.childSession?.id === input.sessionID
        && candidate.expectedAgent === input.agent
      ));
      if (!reservation) continue;
      if (record.runtimeVersion !== input.runtimeVersion) {
        this.stop(record, 'runtime-generated-version-mismatch', input.sessionID);
        return { allowed: false, reason: 'runtime-generated-version-mismatch' };
      }
      if (reservation.childSession?.ended) return { allowed: false, reason: 'session-ended' };
      if (reservation.kind === 'deep') {
        if (!record.workspace?.claimed || !record.workspace.frozenRoot) return { allowed: false, reason: 'workspace-not-claimed' };
        return {
          allowed: true,
          role: 'deep',
          workspacePath: record.workspace.workspacePath,
          boundary: structuredClone(record.workspace.boundary),
          frozenRoot: structuredClone(record.workspace.frozenRoot),
        };
      }
      return { allowed: true, role: 'scope' };
    }
    return {
      allowed: false,
      reason: this.terminalAudit.get(input.sessionID)?.reason ?? 'child-not-bound-to-invocation',
    };
  }

  releaseForAgentTransition(sessionID: string): boolean {
    const record = this.invocations.get(sessionID);
    if (record) this.stop(record, 'primary-agent-mismatch');
    const audit = this.terminalAudit.get(sessionID);
    if (!audit) return false;
    audit.commandAuthorizationReleased = true;
    return true;
  }

  completeForSession(sessionID: string): boolean {
    const record = this.invocations.get(sessionID);
    if (!record) return false;
    this.stop(record, 'workspace-cleaned');
    return true;
  }

  revokeForSession(sessionID: string): void {
    const primary = this.invocations.get(sessionID);
    if (primary) {
      this.stop(primary, 'session-ended');
      return;
    }
    for (const record of this.invocations.values()) {
      const reservation = this.taskReservations(record).find((candidate) => candidate.childSession?.id === sessionID);
      const child = reservation?.childSession;
      if (!reservation || !child) continue;
      if (reservation.kind === 'scope' && record.workspace) {
        child.ended = true;
        this.recordAudit(sessionID, {
          reason: 'session-ended',
          terminatedAt: this.now(),
          runtimeVersion: record.runtimeVersion,
        });
      } else if (reservation.kind === 'scope') {
        this.stop(record, 'session-ended', sessionID);
      } else {
        record.deepTasks.delete(reservation.callID);
        this.recordAudit(sessionID, {
          reason: 'session-ended',
          terminatedAt: this.now(),
          runtimeVersion: record.runtimeVersion,
        });
      }
      return;
    }
  }

  private validateBoundRecord(
    record: InvocationRecord,
    session: SessionIdentity,
    runtimeVersion: number,
  ): DashReviewAuthorizationReason | undefined {
    if (record.runtimeVersion !== runtimeVersion) {
      this.stop(record, 'runtime-generated-version-mismatch', session.id);
      return 'runtime-generated-version-mismatch';
    }
    if (this.isExpired(record)) {
      this.stop(record, 'capability-expired', session.id);
      return 'capability-expired';
    }
    if (!this.matchesBoundSession(record.scope!.childSession!, session)) {
      this.stop(record, 'child-not-bound-to-invocation', session.id);
      return 'child-not-bound-to-invocation';
    }
    return undefined;
  }

  private matchingEvidenceAuthority(authority: EvidenceAuthority): { record: InvocationRecord } | undefined {
    const token = authority && typeof authority === 'object'
      ? this.evidenceAuthorities.get(authority)
      : undefined;
    if (!token) return undefined;
    const record = this.invocations.get(token.primarySessionID);
    if (!record || record.generation !== token.generation) return undefined;
    return { record };
  }

  private matchingCreateAuthority(authority: DashCreateAuthority): InvocationRecord | undefined {
    const token = authority && typeof authority === 'object'
      ? this.createAuthorities.get(authority)
      : undefined;
    if (!token) return undefined;
    const record = this.invocations.get(token.primarySessionID);
    if (!record || record.generation !== token.generation) return undefined;
    return record;
  }

  private recordForBoundChild(sessionID: string, agent: string): InvocationRecord | undefined {
    for (const record of this.invocations.values()) {
      if (
        record.scope?.childSession?.id === sessionID
        && record.scope.childSession.ended !== true
        && record.scope.expectedAgent === agent
      ) return record;
    }
    return undefined;
  }

  private taskReservations(record: InvocationRecord): TaskReservation[] {
    return [
      ...(record.scope ? [record.scope] : []),
      ...record.deepTasks.values(),
    ];
  }

  private taskReservation(record: InvocationRecord, callID: string): TaskReservation | undefined {
    if (record.scope?.callID === callID) return record.scope;
    return record.deepTasks.get(callID);
  }

  private matchesBoundSession(bound: NonNullable<TaskReservation['childSession']>, session: SessionIdentity): boolean {
    return session.id === bound.id
      && session.parentID === bound.parentID
      && session.time?.created === bound.created;
  }

  private isExpired(record: InvocationRecord): boolean {
    return this.now() >= (record.scope?.expiresAt ?? record.expiresAt);
  }

  private stop(
    record: InvocationRecord,
    reason: DashReviewAuthorizationReason,
    childSessionID?: string,
  ): void {
    if (this.invocations.get(record.primarySessionID) !== record) return;
    this.invocations.delete(record.primarySessionID);
    const audit = {
      reason,
      terminatedAt: this.now(),
      runtimeVersion: record.runtimeVersion,
    };
    this.recordAudit(record.primarySessionID, audit);
    if (childSessionID) this.recordAudit(childSessionID, audit);
  }

  private recordAudit(sessionID: string, audit: TerminalAudit): void {
    this.terminalAudit.delete(sessionID);
    this.terminalAudit.set(sessionID, audit);
    while (this.terminalAudit.size > MAX_AUDIT_SESSIONS) {
      const oldest = this.terminalAudit.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.terminalAudit.delete(oldest);
    }
  }
}
