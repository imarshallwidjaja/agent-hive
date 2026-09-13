import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { getFeaturePath, getGlobalSessionsPath, ensureDir, readJson, writeJson, acquireLockSync, writeJsonAtomic } from '../utils/paths.js';
import type { SessionInfo, SessionsJson, StandingConstraintEntry, WorkerAssignmentDescriptor } from '../types.js';
import { WORKER_ASSIGNMENT_FORMAT } from '../types.js';

export const STANDING_CONSTRAINTS_MAX_CHARS = 8000;
export const LEGACY_STANDING_CONSTRAINT_ID = 'legacy';

export class SessionContinuityError extends Error {
  constructor(readonly reason: 'missing_origin' | 'invalid_origin' | 'invalid_worker_assignment', message: string) {
    super(`assignment_recovery_error: ${message}`);
  }
}

export function validateAssignmentDescriptorShape(value: unknown): value is WorkerAssignmentDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptor = value as Record<string, unknown>;
  const nonEmptyString = (member: unknown): member is string => (
    typeof member === 'string' && member.trim().length > 0
  );
  const safeSegment = (member: unknown): member is string => nonEmptyString(member)
    && member !== '.' && member !== '..' && !/[\\/\x00]/.test(member);
  if (descriptor.format !== WORKER_ASSIGNMENT_FORMAT || !nonEmptyString(descriptor.projectRoot)
    || !safeSegment(descriptor.featureName) || !safeSegment(descriptor.taskFolder)
    || !nonEmptyString(descriptor.locator) || !Number.isSafeInteger(descriptor.attempt)
    || (descriptor.attempt as number) < 1
    || typeof descriptor.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.contentHash)) return false;
  const locator = descriptor.locator.split('/');
  return locator.length === 7 && locator[0] === '.hive' && locator[1] === 'features'
    && safeSegment(locator[2]) && locator[3] === 'tasks' && locator[4] === descriptor.taskFolder
    && locator[5] === 'assignments' && locator[6] === `attempt-${descriptor.attempt}.md`;
}

function hasWorkerAssignment(session: Partial<SessionInfo>): boolean {
  if (!Object.prototype.hasOwnProperty.call(session, 'workerAssignment')) return false;
  if (!validateAssignmentDescriptorShape(session.workerAssignment)) {
    throw new SessionContinuityError('invalid_worker_assignment', 'invalid immutable worker assignment');
  }
  return true;
}

export interface StandingConstraintRegister {
  entries: StandingConstraintEntry[];
  revision: number;
  constraints: string;
  constraintsChars: number;
}

export function workerAssignmentsEqual(left: WorkerAssignmentDescriptor | undefined, right: WorkerAssignmentDescriptor): boolean {
  return !!left
    && left.format === right.format
    && left.projectRoot === right.projectRoot
    && left.featureName === right.featureName
    && left.taskFolder === right.taskFolder
    && left.attempt === right.attempt
    && left.locator === right.locator
    && left.contentHash === right.contentHash;
}

export class StandingConstraintError extends Error {
  constructor(
    readonly reason: 'blank_constraint' | 'constraints_too_long' | 'constraint_not_found' | 'stale_revision',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Fields whose absence is meaningful state: an explicit `undefined` in a patch
 * clears them instead of being ignored as "not supplied".
 */
const CLEARABLE_SESSION_FIELDS = new Set<keyof SessionInfo>([
  'directiveRecoveryState',
  'standingConstraints',
  'standingConstraintEntries',
]);

export class SessionService {
  constructor(private projectRoot: string) {}

  private applySessionPatch(target: SessionInfo, patch?: Partial<SessionInfo>): void {
    const targetHasAssignment = hasWorkerAssignment(target);
    if (!patch) {
      return;
    }

    const { sessionId: _sessionId, ...rest } = patch;
    if (target.duplicatedFromSessionId !== undefined && rest.duplicatedFromSessionId !== undefined
      && target.duplicatedFromSessionId !== rest.duplicatedFromSessionId) {
      throw new Error('assignment_recovery_error: immutable duplicate source cannot change');
    }
    hasWorkerAssignment(rest);
    if (targetHasAssignment || Object.prototype.hasOwnProperty.call(target, 'adHocRunId')) {
      const identityFields: Array<keyof SessionInfo> = [
        'workerAssignment', 'assignmentSourceSessionId', 'duplicatedFromSessionId', 'adHocRunId', 'projectRoot',
        'featureName', 'taskFolder', 'parentSessionId', 'sessionKind', 'agent', 'baseAgent',
      ];
      for (const key of identityFields) {
        if (!Object.prototype.hasOwnProperty.call(rest, key) || rest[key] === undefined) continue;
        const unchanged = key === 'workerAssignment'
          ? workerAssignmentsEqual(target.workerAssignment, rest.workerAssignment!)
          : target[key] === rest[key];
        if (!unchanged) throw new Error(`assignment_recovery_error: immutable session identity field ${key} cannot change`);
      }
    }
    for (const [key, value] of Object.entries(rest) as Array<[keyof Omit<SessionInfo, 'sessionId'>, SessionInfo[keyof Omit<SessionInfo, 'sessionId'>]]>) {
      if (value !== undefined || CLEARABLE_SESSION_FIELDS.has(key)) {
        target[key] = value as never;
      }
    }
  }

  private getSessionsPath(featureName: string): string {
    return path.join(getFeaturePath(this.projectRoot, featureName), 'sessions.json');
  }

  private getSessions(featureName: string): SessionsJson {
    const sessionsPath = this.getSessionsPath(featureName);
    return readJson<SessionsJson>(sessionsPath) || { sessions: [] };
  }

  private saveSessions(featureName: string, data: SessionsJson): void {
    const sessionsPath = this.getSessionsPath(featureName);
    ensureDir(path.dirname(sessionsPath));
    writeJson(sessionsPath, data);
  }

  private getGlobalSessions(): SessionsJson {
    const globalPath = getGlobalSessionsPath(this.projectRoot);
    return readJson<SessionsJson>(globalPath) || { sessions: [] };
  }

  private saveGlobalSessions(data: SessionsJson): void {
    const globalPath = getGlobalSessionsPath(this.projectRoot);
    ensureDir(path.dirname(globalPath));
    writeJson(globalPath, data);
  }

  private updateGlobalSessions<T>(mutator: (data: SessionsJson) => T): T {
    const globalPath = getGlobalSessionsPath(this.projectRoot);
    ensureDir(path.dirname(globalPath));
    const release = acquireLockSync(globalPath);

    try {
      const data = readJson<SessionsJson>(globalPath) || { sessions: [] };
      const session = mutator(data);
      writeJsonAtomic(globalPath, data);
      return session;
    } finally {
      release();
    }
  }

  trackGlobal(sessionId: string, patch?: Partial<SessionInfo>): SessionInfo {
    return this.updateGlobalSessions((data) => {
      const now = new Date().toISOString();

      let session = data.sessions.find(s => s.sessionId === sessionId);
      if (session) {
        session.lastActiveAt = now;
        this.applySessionPatch(session, patch);
      } else {
        session = {
          sessionId,
          startedAt: now,
          lastActiveAt: now,
        };
        this.applySessionPatch(session, patch);
        data.sessions.push(session);
      }

      return session;
    });
  }

  bindFeature(sessionId: string, featureName: string, patch?: Partial<SessionInfo>): SessionInfo {
    const session = this.updateGlobalSessions((data) => {
      let current = data.sessions.find(s => s.sessionId === sessionId);
      const now = new Date().toISOString();

      if (!current) {
        current = {
          sessionId,
          startedAt: now,
          lastActiveAt: now,
        };
        data.sessions.push(current);
      }

      if (current.workerAssignment && current.workerAssignment.featureName !== featureName) {
        throw new Error('assignment_recovery_error: an immutable assignment cannot be rebound to another feature');
      }
      if (Object.prototype.hasOwnProperty.call(current, 'adHocRunId') && current.featureName !== featureName) {
        throw new Error('assignment_recovery_error: an immutable ad-hoc run cannot acquire another feature binding');
      }

      current.featureName = featureName;
      current.lastActiveAt = now;
      this.applySessionPatch(current, patch);

      return current;
    });

    const featureData = this.getSessions(featureName);
    let featureSession = featureData.sessions.find(s => s.sessionId === sessionId);
    if (featureSession) {
      Object.assign(featureSession, session);
    } else {
      featureData.sessions.push({ ...session });
    }
    this.saveSessions(featureName, featureData);

    return session;
  }

  bindWorkerAssignment(
    sessionId: string,
    parentSessionId: string,
    assignment: WorkerAssignmentDescriptor,
    patch?: Partial<SessionInfo>,
  ): SessionInfo {
    hasWorkerAssignment({ workerAssignment: assignment });
    const session = this.updateGlobalSessions((data) => {
      const current = this.getOrCreateGlobalSession(data, sessionId);
      if (Object.prototype.hasOwnProperty.call(current, 'adHocRunId')) {
        throw new Error('assignment_recovery_error: an immutable ad-hoc run cannot become a task assignment');
      }
      if (current.parentSessionId && current.parentSessionId !== parentSessionId) {
        throw new Error('assignment_recovery_error: parent session mismatch');
      }
      if (current.workerAssignment && !workerAssignmentsEqual(current.workerAssignment, assignment)) {
        throw new Error('assignment_recovery_error: immutable assignment mismatch');
      }
      this.applySessionPatch(current, patch);
      current.parentSessionId = parentSessionId;
      current.projectRoot = assignment.projectRoot;
      current.featureName = assignment.featureName;
      current.taskFolder = assignment.taskFolder;
      current.workerAssignment = { ...assignment };
      current.lastActiveAt = new Date().toISOString();
      return { ...current, workerAssignment: { ...assignment } };
    });
    this.mirrorSessionProjection(assignment.featureName, session);
    return session;
  }

  copySessionOrigin(sessionId: string, sourceSessionId: string): SessionInfo {
    return this.updateGlobalSessions((data) => {
      const source = data.sessions.find(candidate => candidate.sessionId === sourceSessionId);
      if (!source) throw new SessionContinuityError('missing_origin', 'missing generic duplicate source');
      if (hasWorkerAssignment(source) || sessionId === sourceSessionId) {
        throw new SessionContinuityError('invalid_origin', 'invalid immutable generic duplicate origin');
      }
      const current = this.getOrCreateGlobalSession(data, sessionId);
      hasWorkerAssignment(current);
      const identity = {
        agent: source?.agent, baseAgent: source?.baseAgent, sessionKind: source?.sessionKind,
        projectRoot: source?.projectRoot, featureName: source?.featureName,
        duplicatedFromSessionId: sourceSessionId,
      };
      if (current.parentSessionId !== undefined || current.workerAssignment !== undefined
        || current.taskFolder !== undefined || current.workerPromptPath !== undefined || current.adHocRunId !== undefined
        || current.assignmentSourceSessionId !== undefined
        || Object.entries(identity).some(([key, value]) =>
          current[key as keyof SessionInfo] !== undefined && current[key as keyof SessionInfo] !== value)) {
        throw new Error('assignment_recovery_error: immutable duplicate recipient identity mismatch');
      }
      if (current.duplicatedFromSessionId === sourceSessionId) return { ...current };
      this.applySessionPatch(current, {
        ...identity,
        directivePrompt: source.directivePrompt,
        replayDirectivePending: source.replayDirectivePending,
        standingConstraints: source?.standingConstraints,
        standingConstraintEntries: source?.standingConstraintEntries?.map(entry => ({ ...entry })),
        standingConstraintsRevision: source?.standingConstraintsRevision,
      });
      return { ...current };
    });
  }

  copyWorkerAssignment(sessionId: string, sourceSessionId: string): SessionInfo | undefined {
    const copied = this.updateGlobalSessions((data) => {
      const recipient = data.sessions.find(candidate => candidate.sessionId === sessionId);
      if (recipient && Object.prototype.hasOwnProperty.call(recipient, 'adHocRunId')) {
        throw new Error('assignment_recovery_error: an immutable ad-hoc run cannot become a task assignment');
      }
      const currentHasAssignment = recipient ? hasWorkerAssignment(recipient) : false;
      const source = data.sessions.find(candidate => candidate.sessionId === sourceSessionId);
      if (!source || !hasWorkerAssignment(source)) return undefined;
      const canonicalSourceId = source.assignmentSourceSessionId ?? sourceSessionId;
      const visited = new Set([sessionId]);
      let ancestor: SessionInfo | undefined = source;
      while (ancestor) {
        if (visited.has(ancestor.sessionId) || visited.size > 32
          || Object.prototype.hasOwnProperty.call(ancestor, 'adHocRunId')
          || !hasWorkerAssignment(ancestor)
          || !workerAssignmentsEqual(ancestor.workerAssignment, source.workerAssignment!)) {
          throw new Error('assignment_recovery_error: invalid immutable duplicate provenance');
        }
        visited.add(ancestor.sessionId);
        if (ancestor.sessionId === canonicalSourceId) {
          if (ancestor.assignmentSourceSessionId || ancestor.duplicatedFromSessionId) {
            throw new Error('assignment_recovery_error: invalid immutable canonical source');
          }
          break;
        }
        if (ancestor.assignmentSourceSessionId !== canonicalSourceId || !ancestor.duplicatedFromSessionId) {
          throw new Error('assignment_recovery_error: invalid immutable duplicate provenance');
        }
        ancestor = data.sessions.find(candidate => candidate.sessionId === ancestor!.duplicatedFromSessionId);
      }
      if (!ancestor) throw new Error('assignment_recovery_error: missing immutable duplicate source');
      const current = this.getOrCreateGlobalSession(data, sessionId);
      const duplicateIdentity = {
        agent: source.agent, baseAgent: source.baseAgent, sessionKind: source.sessionKind,
        projectRoot: source.projectRoot, featureName: source.featureName, taskFolder: source.taskFolder,
        assignmentSourceSessionId: canonicalSourceId, duplicatedFromSessionId: sourceSessionId,
      };
      if (current.parentSessionId !== undefined || Object.entries(duplicateIdentity).some(([key, value]) =>
        current[key as keyof SessionInfo] !== undefined && current[key as keyof SessionInfo] !== value)) {
        throw new Error('assignment_recovery_error: immutable duplicate recipient identity mismatch');
      }
      if (currentHasAssignment && (!workerAssignmentsEqual(current.workerAssignment, source.workerAssignment!)
        || current.assignmentSourceSessionId !== canonicalSourceId
        || current.duplicatedFromSessionId !== sourceSessionId
        || current.agent !== source.agent || current.baseAgent !== source.baseAgent
        || current.sessionKind !== source.sessionKind || current.projectRoot !== source.projectRoot
        || current.featureName !== source.featureName || current.taskFolder !== source.taskFolder)) {
        throw new Error('assignment_recovery_error: immutable assignment mismatch');
      }
      if (currentHasAssignment) return { ...current };
      this.applySessionPatch(current, {
        agent: source.agent,
        baseAgent: source.baseAgent,
        sessionKind: source.sessionKind,
        projectRoot: source.projectRoot,
        featureName: source.featureName,
        taskFolder: source.taskFolder,
        workerAssignment: { ...source.workerAssignment! },
        assignmentSourceSessionId: canonicalSourceId,
        duplicatedFromSessionId: sourceSessionId,
        standingConstraints: source.standingConstraints,
        standingConstraintEntries: source.standingConstraintEntries?.map(entry => ({ ...entry })),
        standingConstraintsRevision: source.standingConstraintsRevision,
      });
      current.lastActiveAt = new Date().toISOString();
      return { ...current, workerAssignment: { ...source.workerAssignment! } };
    });
    if (copied) this.mirrorSessionProjection(copied.workerAssignment!.featureName, copied);
    return copied;
  }

  private mirrorSessionProjection(featureName: string, session: SessionInfo): void {
    const featureData = this.getSessions(featureName);
    const existing = featureData.sessions.find(candidate => candidate.sessionId === session.sessionId);
    if (existing) Object.assign(existing, session);
    else featureData.sessions.push({ ...session });
    this.saveSessions(featureName, featureData);
  }

  listGlobal(): SessionInfo[] {
    return this.getGlobalSessions().sessions;
  }

  getGlobal(sessionId: string): SessionInfo | undefined {
    const data = this.getGlobalSessions();
    return data.sessions.find(s => s.sessionId === sessionId);
  }

  private standingConstraintRegister(session?: SessionInfo): StandingConstraintRegister {
    const entries = session?.standingConstraintEntries
      ? session.standingConstraintEntries.map((entry) => ({ ...entry }))
      : session?.standingConstraints !== undefined
        ? [{ id: LEGACY_STANDING_CONSTRAINT_ID, text: session.standingConstraints }]
        : [];
    const constraints = entries.map((entry) => entry.text).join('\n\n');
    return {
      entries,
      revision: session?.standingConstraintsRevision ?? 0,
      constraints,
      constraintsChars: constraints.length,
    };
  }

  private persistStandingConstraintRegister(
    session: SessionInfo,
    entries: StandingConstraintEntry[],
    revision: number,
  ): StandingConstraintRegister {
    const constraints = entries.map((entry) => entry.text).join('\n\n');
    if (constraints.length > STANDING_CONSTRAINTS_MAX_CHARS) {
      throw new StandingConstraintError(
        'constraints_too_long',
        `Standing constraints are ${constraints.length} characters (UTF-16 code units), over the ${STANDING_CONSTRAINTS_MAX_CHARS} character cap.`,
        { constraintsChars: constraints.length, cap: STANDING_CONSTRAINTS_MAX_CHARS },
      );
    }

    session.standingConstraintEntries = entries.map((entry) => ({ ...entry }));
    session.standingConstraintsRevision = revision;
    session.standingConstraints = constraints || undefined;
    session.lastActiveAt = new Date().toISOString();
    return this.standingConstraintRegister(session);
  }

  private getOrCreateGlobalSession(data: SessionsJson, sessionId: string): SessionInfo {
    let session = data.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session) {
      const now = new Date().toISOString();
      session = { sessionId, startedAt: now, lastActiveAt: now };
      data.sessions.push(session);
    }
    return session;
  }

  readStandingConstraints(sessionId: string): StandingConstraintRegister {
    return this.standingConstraintRegister(this.getGlobal(sessionId));
  }

  addStandingConstraint(sessionId: string, text: string): StandingConstraintRegister {
    if (!text.trim()) {
      throw new StandingConstraintError('blank_constraint', 'Standing constraint additions must not be blank.');
    }

    return this.updateGlobalSessions((data) => {
      const session = this.getOrCreateGlobalSession(data, sessionId);
      const current = this.standingConstraintRegister(session);
      if (current.entries.some((entry) => entry.text === text)) {
        return current;
      }
      return this.persistStandingConstraintRegister(
        session,
        [...current.entries, { id: `constraint-${randomUUID()}`, text }],
        current.revision + 1,
      );
    });
  }

  editStandingConstraint(
    sessionId: string,
    id: string,
    expectedRevision: number,
    replacement: string | null,
  ): StandingConstraintRegister {
    if (replacement !== null && !replacement.trim()) {
      throw new StandingConstraintError('blank_constraint', 'Standing constraint edits must not be blank. Use explicit removal instead.');
    }

    return this.updateGlobalSessions((data) => {
      const session = this.getOrCreateGlobalSession(data, sessionId);
      const current = this.standingConstraintRegister(session);
      if (current.revision !== expectedRevision) {
        throw new StandingConstraintError(
          'stale_revision',
          `Standing constraints changed since revision ${expectedRevision}; current revision is ${current.revision}.`,
          { expectedRevision, revision: current.revision },
        );
      }
      const index = current.entries.findIndex((entry) => entry.id === id);
      if (index === -1) {
        throw new StandingConstraintError('constraint_not_found', `Standing constraint ID "${id}" does not exist.`, { id });
      }
      if (replacement === current.entries[index]!.text) {
        return current;
      }
      const entries = [...current.entries];
      if (replacement === null) {
        entries.splice(index, 1);
      } else {
        entries[index] = { ...entries[index]!, text: replacement };
      }
      return this.persistStandingConstraintRegister(session, entries, current.revision + 1);
    });
  }

  clearStandingConstraints(sessionId: string, expectedRevision: number): StandingConstraintRegister {
    return this.updateGlobalSessions((data) => {
      const session = this.getOrCreateGlobalSession(data, sessionId);
      const current = this.standingConstraintRegister(session);
      if (current.revision !== expectedRevision) {
        throw new StandingConstraintError(
          'stale_revision',
          `Standing constraints changed since revision ${expectedRevision}; current revision is ${current.revision}.`,
          { expectedRevision, revision: current.revision },
        );
      }
      return this.persistStandingConstraintRegister(session, [], current.revision + 1);
    });
  }

  track(featureName: string, sessionId: string, taskFolder?: string): SessionInfo {
    const data = this.getSessions(featureName);
    const now = new Date().toISOString();

    let session = data.sessions.find(s => s.sessionId === sessionId);
    if (session) {
      session.lastActiveAt = now;
      if (taskFolder) session.taskFolder = taskFolder;
    } else {
      session = {
        sessionId,
        taskFolder,
        startedAt: now,
        lastActiveAt: now,
      };
      data.sessions.push(session);
    }

    if (!data.master) {
      data.master = sessionId;
    }

    this.saveSessions(featureName, data);
    return session;
  }

  setMaster(featureName: string, sessionId: string): void {
    const data = this.getSessions(featureName);
    data.master = sessionId;
    this.saveSessions(featureName, data);
  }

  getMaster(featureName: string): string | undefined {
    return this.getSessions(featureName).master;
  }

  list(featureName: string): SessionInfo[] {
    return this.getSessions(featureName).sessions;
  }

  get(featureName: string, sessionId: string): SessionInfo | undefined {
    return this.getSessions(featureName).sessions.find(s => s.sessionId === sessionId);
  }

  getByTask(featureName: string, taskFolder: string): SessionInfo | undefined {
    return this.getSessions(featureName).sessions.find(s => s.taskFolder === taskFolder);
  }

  remove(featureName: string, sessionId: string): boolean {
    const data = this.getSessions(featureName);
    const index = data.sessions.findIndex(s => s.sessionId === sessionId);
    if (index === -1) return false;

    data.sessions.splice(index, 1);
    if (data.master === sessionId) {
      data.master = data.sessions[0]?.sessionId;
    }
    this.saveSessions(featureName, data);
    return true;
  }

  findFeatureBySession(sessionId: string): string | null {
    return this.getGlobal(sessionId)?.featureName || null;
  }

  fork(featureName: string, fromSessionId?: string): SessionInfo {
    const data = this.getSessions(featureName);
    const now = new Date().toISOString();
    
    const sourceSession = fromSessionId 
      ? data.sessions.find(s => s.sessionId === fromSessionId)
      : data.sessions.find(s => s.sessionId === data.master);

    const newSessionId = `ses_fork_${Date.now()}`;
    const newSession: SessionInfo = {
      sessionId: newSessionId,
      taskFolder: sourceSession?.taskFolder,
      startedAt: now,
      lastActiveAt: now,
    };

    data.sessions.push(newSession);
    this.saveSessions(featureName, data);
    return newSession;
  }

  fresh(featureName: string, title?: string): SessionInfo {
    const data = this.getSessions(featureName);
    const now = new Date().toISOString();

    const newSessionId = `ses_${title ? title.replace(/\s+/g, '_').toLowerCase() : Date.now()}`;
    const newSession: SessionInfo = {
      sessionId: newSessionId,
      startedAt: now,
      lastActiveAt: now,
    };

    data.sessions.push(newSession);
    this.saveSessions(featureName, data);
    return newSession;
  }
}
