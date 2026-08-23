import { isDeepStrictEqual } from 'node:util';
import type { ReviewSourceRequest, ReviewSourceResolution } from './review-source-resolution.js';

type SessionIdentity = {
  id: string;
  parentID?: string;
  time?: { created?: number };
};

type ScopeReservation = {
  callID: string;
  expectedAgent: string;
  reservedAt: number;
  childSession?: {
    id: string;
    parentID: string;
    created: number;
  };
};

type SnapshotRecord =
  | { state: 'resolving'; input: unknown; token: SnapshotAuthority }
  | {
    state: 'resolved';
    input: unknown;
    output: string;
    sourceResolution: ReviewSourceResolution;
    createInput: Record<string, unknown>;
    createConsumed: boolean;
  };

type InvocationRecord = {
  generation: symbol;
  primarySessionID: string;
  request: ReviewSourceRequest;
  scope?: ScopeReservation;
  snapshot?: SnapshotRecord;
};

type BindingCandidate = {
  primarySessionID: string;
  generation: symbol;
  callID: string;
  expectedAgent: string;
  reservedAt: number;
};

type BindingSnapshot = Readonly<Record<never, never>>;
type SnapshotAuthority = Readonly<Record<never, never>>;

type DashSnapshotAction =
  | { kind: 'execute'; request: ReviewSourceRequest; authority: SnapshotAuthority }
  | { kind: 'replay'; output: string }
  | { kind: 'deny'; reason: 'authority' | 'different-input' | 'in-progress' };

export class DashReviewInvocationStore {
  private readonly invocations = new Map<string, InvocationRecord>();
  private readonly commandSessions = new Set<string>();
  private readonly bindingAuthorities = new WeakMap<BindingSnapshot, { childSessionID: string; candidates: BindingCandidate[] }>();
  private readonly snapshotAuthorities = new WeakMap<SnapshotAuthority, { primarySessionID: string; generation: symbol }>();

  replaceInvocation(primarySessionID: string, request: ReviewSourceRequest): void {
    this.commandSessions.add(primarySessionID);
    this.invocations.delete(primarySessionID);
    this.invocations.set(primarySessionID, {
      generation: Symbol('dash-review-invocation'),
      primarySessionID,
      request: structuredClone(request),
    });
  }

  isCommandSession(sessionID: string): boolean {
    return this.commandSessions.has(sessionID);
  }

  reserveScope(input: {
    primarySessionID: string;
    callID: string;
    expectedAgent: string;
    reservedAt: number;
  }): boolean {
    const record = this.invocations.get(input.primarySessionID);
    if (
      !record
      || record.scope !== undefined
      || !input.callID
      || !input.expectedAgent
      || !Number.isFinite(input.reservedAt)
    ) {
      if (record?.scope !== undefined) this.stop(record);
      return false;
    }
    record.scope = {
      callID: input.callID,
      expectedAgent: input.expectedAgent,
      reservedAt: input.reservedAt,
    };
    return true;
  }

  beginConsumerBinding(input: {
    childSessionID: string;
    inputAgent: string;
    messageAgent: string;
  }): BindingSnapshot | undefined {
    if (!input.childSessionID || !input.inputAgent || input.inputAgent !== input.messageAgent) return undefined;
    const candidates: BindingCandidate[] = [];
    for (const record of this.invocations.values()) {
      if (record.scope && record.scope.childSession === undefined && record.scope.expectedAgent === input.inputAgent) {
        candidates.push({
          primarySessionID: record.primarySessionID,
          generation: record.generation,
          callID: record.scope.callID,
          expectedAgent: record.scope.expectedAgent,
          reservedAt: record.scope.reservedAt,
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
    ) {
      if (authority) this.revokeBindingCandidates(authority.candidates);
      return false;
    }
    for (const candidate of authority.candidates) {
      if (candidate.primarySessionID !== session.parentID || session.time.created < candidate.reservedAt) continue;
      const record = this.invocations.get(candidate.primarySessionID);
      const scope = record?.scope;
      if (
        !record
        || record.generation !== candidate.generation
        || !scope
        || scope.callID !== candidate.callID
        || scope.expectedAgent !== candidate.expectedAgent
        || scope.reservedAt !== candidate.reservedAt
        || scope.childSession !== undefined
      ) continue;
      scope.childSession = {
        id: session.id,
        parentID: session.parentID,
        created: session.time.created,
      };
      return true;
    }
    this.revokeBindingCandidates(authority.candidates);
    return false;
  }

  revokeConsumerBinding(snapshot: BindingSnapshot): boolean {
    const authority = snapshot && typeof snapshot === 'object'
      ? this.bindingAuthorities.get(snapshot)
      : undefined;
    if (!authority) return false;
    this.bindingAuthorities.delete(snapshot);
    this.revokeBindingCandidates(authority.candidates);
    return true;
  }

  beginSnapshot(input: {
    session: SessionIdentity;
    agent: string;
    snapshotInput: unknown;
  }): DashSnapshotAction {
    const record = this.recordForBoundChild(input.session.id, input.agent);
    if (!record || !this.matchesBoundSession(record.scope!.childSession!, input.session)) {
      if (record) this.stop(record);
      return { kind: 'deny', reason: 'authority' };
    }
    if (record.snapshot?.state === 'resolving') {
      this.stop(record);
      return {
        kind: 'deny',
        reason: isDeepStrictEqual(record.snapshot.input, input.snapshotInput) ? 'in-progress' : 'different-input',
      };
    }
    if (record.snapshot?.state === 'resolved') {
      if (isDeepStrictEqual(record.snapshot.input, input.snapshotInput)) {
        return { kind: 'replay', output: record.snapshot.output };
      }
      this.stop(record);
      return { kind: 'deny', reason: 'different-input' };
    }
    const authority = Object.freeze({});
    record.snapshot = {
      state: 'resolving',
      input: structuredClone(input.snapshotInput),
      token: authority,
    };
    this.snapshotAuthorities.set(authority, {
      primarySessionID: record.primarySessionID,
      generation: record.generation,
    });
    return { kind: 'execute', request: structuredClone(record.request), authority };
  }

  recordSnapshot(
    authority: SnapshotAuthority,
    result: {
      output: string;
      sourceResolution: ReviewSourceResolution;
      createInput: Record<string, unknown>;
    },
  ): boolean {
    const match = this.matchingSnapshotAuthority(authority);
    if (!match || match.record.snapshot?.state !== 'resolving' || match.record.snapshot.token !== authority) return false;
    this.snapshotAuthorities.delete(authority);
    match.record.snapshot = {
      state: 'resolved',
      input: match.record.snapshot.input,
      output: result.output,
      sourceResolution: structuredClone(result.sourceResolution),
      createInput: structuredClone(result.createInput),
      createConsumed: false,
    };
    return true;
  }

  revokeSnapshot(authority: SnapshotAuthority): boolean {
    const match = this.matchingSnapshotAuthority(authority);
    this.snapshotAuthorities.delete(authority);
    if (!match) return false;
    this.stop(match.record);
    return true;
  }

  takeCreate(input: {
    session: SessionIdentity;
    agent: string;
    createInput: Record<string, unknown>;
  }): ReviewSourceResolution | undefined {
    const record = this.recordForBoundChild(input.session.id, input.agent);
    const snapshot = record?.snapshot;
    if (
      !record
      || !this.matchesBoundSession(record.scope!.childSession!, input.session)
      || snapshot?.state !== 'resolved'
      || snapshot.createConsumed
      || !isDeepStrictEqual(snapshot.createInput, input.createInput)
    ) {
      if (record && snapshot?.state === 'resolved' && !isDeepStrictEqual(snapshot.createInput, input.createInput)) this.stop(record);
      return undefined;
    }
    snapshot.createConsumed = true;
    return structuredClone(snapshot.sourceResolution);
  }

  revokeForSession(sessionID: string): void {
    const primary = this.invocations.get(sessionID);
    if (primary) this.stop(primary);
    for (const record of this.invocations.values()) {
      if (record.scope?.childSession?.id === sessionID) this.stop(record);
    }
  }

  private matchingSnapshotAuthority(authority: SnapshotAuthority): { record: InvocationRecord } | undefined {
    const token = authority && typeof authority === 'object'
      ? this.snapshotAuthorities.get(authority)
      : undefined;
    if (!token) return undefined;
    const record = this.invocations.get(token.primarySessionID);
    if (!record || record.generation !== token.generation) return undefined;
    return { record };
  }

  private recordForBoundChild(sessionID: string, agent: string): InvocationRecord | undefined {
    for (const record of this.invocations.values()) {
      if (record.scope?.childSession?.id === sessionID && record.scope.expectedAgent === agent) return record;
    }
    return undefined;
  }

  private matchesBoundSession(bound: NonNullable<ScopeReservation['childSession']>, session: SessionIdentity): boolean {
    return session.id === bound.id
      && session.parentID === bound.parentID
      && session.time?.created === bound.created;
  }

  private revokeBindingCandidates(candidates: readonly BindingCandidate[]): void {
    for (const candidate of candidates) {
      const record = this.invocations.get(candidate.primarySessionID);
      if (record?.generation === candidate.generation) this.stop(record);
    }
  }

  private stop(record: InvocationRecord): void {
    if (this.invocations.get(record.primarySessionID) === record) this.invocations.delete(record.primarySessionID);
  }
}
