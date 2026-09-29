import * as fs from 'fs';
import * as path from 'path';
import { getFeaturePath, getGlobalSessionsPath, ensureDir, fileExists, readJson, writeJson, acquireLockSync, writeJsonAtomic, syncFile, syncDirectory } from '../utils/paths.js';
import type { SessionInfo, SessionsJson, StandingConstraintEntry } from '../types.js';
import {
  addConstraint,
  clearConstraints,
  CONSTRAINTS_MAX_CHARS,
  ConstraintRegisterError,
  editConstraint,
  LEGACY_CONSTRAINT_ID,
  readConstraintRegister,
} from './constraintRegister.js';
import type { ConstraintRegister } from './constraintRegister.js';
import { resolveExistingFeaturePath } from './featureConstraintService.js';

export const STANDING_CONSTRAINTS_MAX_CHARS = CONSTRAINTS_MAX_CHARS;
export const LEGACY_STANDING_CONSTRAINT_ID = LEGACY_CONSTRAINT_ID;
export { ConstraintRegisterError as StandingConstraintError };
export type { ConstraintRegister as StandingConstraintRegister };

export class SessionContinuityError extends Error {
  constructor(readonly reason: 'missing_origin' | 'invalid_origin', message: string) {
    super(`assignment_recovery_error: ${message}`);
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
    if (!patch) {
      return;
    }

    const { sessionId: _sessionId, ...rest } = patch;
    if (target.duplicatedFromSessionId !== undefined && rest.duplicatedFromSessionId !== undefined
      && target.duplicatedFromSessionId !== rest.duplicatedFromSessionId) {
      throw new Error('assignment_recovery_error: immutable duplicate source cannot change');
    }
    const applyFields = (session: SessionInfo): void => {
      for (const [key, value] of Object.entries(rest) as Array<[keyof Omit<SessionInfo, 'sessionId'>, SessionInfo[keyof Omit<SessionInfo, 'sessionId'>]]>) {
        if (value !== undefined || CLEARABLE_SESSION_FIELDS.has(key)) {
          session[key] = value as never;
        }
      }
    };
    const hasConstraintPatch = (['standingConstraints', 'standingConstraintEntries', 'standingConstraintsRevision'] as const)
      .some((key) => Object.prototype.hasOwnProperty.call(rest, key));
    if (hasConstraintPatch) {
      const register = this.resolvePatchedConstraintRegister(target, rest);
      applyFields(target);
      this.persistStandingConstraintRegister(target, register);
      return;
    }
    applyFields(target);
  }

  /**
   * Builds the one canonical register a constraint patch writes. Supplied
   * structured entries take precedence over supplied flattened text, but when
   * both carry content they must flatten to the same bytes. Omitted fields fall
   * back to the target register instead of clearing it.
   */
  private resolvePatchedConstraintRegister(target: SessionInfo, patch: Partial<SessionInfo>): ConstraintRegister {
    const hasEntries = Object.prototype.hasOwnProperty.call(patch, 'standingConstraintEntries');
    const hasText = Object.prototype.hasOwnProperty.call(patch, 'standingConstraints');
    const hasRevision = Object.prototype.hasOwnProperty.call(patch, 'standingConstraintsRevision');
    const suppliedEntries = hasEntries && patch.standingConstraintEntries !== undefined
      ? patch.standingConstraintEntries
      : undefined;
    const suppliedText = hasText && patch.standingConstraints !== undefined
      ? patch.standingConstraints
      : undefined;
    const revision = hasRevision && patch.standingConstraintsRevision !== undefined
      ? patch.standingConstraintsRevision
      : target.standingConstraintsRevision ?? 0;

    let entries: StandingConstraintEntry[];
    if (suppliedEntries !== undefined) {
      entries = suppliedEntries;
    } else if (suppliedText !== undefined) {
      entries = [{ id: LEGACY_CONSTRAINT_ID, text: suppliedText }];
    } else if (hasEntries || hasText) {
      entries = [];
    } else {
      entries = this.standingConstraintRegister(target).entries.map((entry) => ({ ...entry }));
    }

    const register = readConstraintRegister({ entries, revision });
    if (suppliedEntries !== undefined && suppliedText !== undefined && register.constraints !== suppliedText) {
      throw new ConstraintRegisterError(
        'invalid_register',
        'Structured standing constraint entries and flattened standing constraints disagree; refusing to persist conflicting representations.',
        { field: 'standingConstraints' },
      );
    }
    return register;
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
    try {
      return readJson<SessionsJson>(globalPath) || { sessions: [] };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    // Another writer may have replaced the index since the unlocked read, so recovery re-reads under the lock.
    const release = acquireLockSync(globalPath);
    try {
      return this.readOrResetGlobalSessions(globalPath);
    } finally {
      release();
    }
  }

  /**
   * Reads the global index while the caller holds its lock. Unparseable bytes
   * are copied to a new sibling `sessions.json.corrupt-<timestamp>` file before
   * an empty index replaces them, which discards every saved session route and
   * standing constraint. I/O errors propagate without a reset.
   */
  private readOrResetGlobalSessions(globalPath: string): SessionsJson {
    try {
      return readJson<SessionsJson>(globalPath) || { sessions: [] };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const backupPath = `${globalPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(globalPath, backupPath, fs.constants.COPYFILE_EXCL);
    syncFile(backupPath);
    syncDirectory(path.dirname(globalPath));
    const empty: SessionsJson = { sessions: [] };
    writeJsonAtomic(globalPath, empty);
    console.warn(
      `[hive:sessions] ${globalPath} was not valid JSON. Preserved it as ${backupPath} and started an empty index; saved session routes and standing constraints were reset.`,
    );
    return empty;
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
      const data = this.readOrResetGlobalSessions(globalPath);
      const session = mutator(data);
      writeJsonAtomic(globalPath, data);
      return session;
    } finally {
      release();
    }
  }

  trackGlobal(sessionId: string, patch?: Partial<SessionInfo>): SessionInfo {
    if (patch?.featureName !== undefined && patch.featureName !== null) {
      resolveExistingFeaturePath(this.projectRoot, patch.featureName);
    }
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
    const session = this.setFeatureRoute(sessionId, featureName, patch);

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

  setFeatureRoute(sessionId: string, featureName: string | null, patch?: Partial<SessionInfo>): SessionInfo {
    if (featureName !== null) resolveExistingFeaturePath(this.projectRoot, featureName);
    return this.updateGlobalSessions((data) => {
      const session = this.getOrCreateGlobalSession(data, sessionId);
      this.applySessionPatch(session, patch);
      session.featureName = featureName;
      session.lastActiveAt = new Date().toISOString();
      return session;
    });
  }

  clearFeatureRoute(sessionId: string): SessionInfo {
    return this.updateGlobalSessions((data) => {
      const session = this.getOrCreateGlobalSession(data, sessionId);
      delete session.featureName;
      session.lastActiveAt = new Date().toISOString();
      return session;
    });
  }

  snapshotChildSession(
    parentSessionId: string,
    childSessionId: string,
    patch?: Partial<SessionInfo>,
  ): SessionInfo {
    return this.updateGlobalSessions((data) => {
      const parent = data.sessions.find((candidate) => candidate.sessionId === parentSessionId);
      if (!parent) throw new SessionContinuityError('missing_origin', 'missing child snapshot parent');
      if (parentSessionId === childSessionId) {
        throw new SessionContinuityError('invalid_origin', 'child snapshot parent and child must differ');
      }
      const {
        sessionId: _sessionId,
        parentSessionId: _parentSessionId,
        featureName: _featureName,
        standingConstraints: _standingConstraints,
        standingConstraintEntries: _standingConstraintEntries,
        standingConstraintsRevision: _standingConstraintsRevision,
        ...metadata
      } = patch ?? {};
      let child = data.sessions.find((candidate) => candidate.sessionId === childSessionId);
      if (child) {
        if (child.parentSessionId !== parentSessionId) {
          throw new SessionContinuityError('invalid_origin', 'existing child snapshot parent cannot change');
        }
        const retry = { ...child };
        this.applySessionPatch(retry, metadata);
        if (Object.keys(metadata).some((key) => retry[key as keyof SessionInfo] !== child![key as keyof SessionInfo])) {
          throw new SessionContinuityError('invalid_origin', 'existing child snapshot metadata cannot change');
        }
      } else {
        child = this.getOrCreateGlobalSession(data, childSessionId);
        this.applySessionPatch(child, metadata);
        child.parentSessionId = parentSessionId;
      }
      if (Object.prototype.hasOwnProperty.call(parent, 'featureName')) child.featureName = parent.featureName;
      else delete child.featureName;
      this.persistStandingConstraintRegister(child, this.standingConstraintRegister(parent));
      return { ...child, standingConstraintEntries: child.standingConstraintEntries?.map((entry) => ({ ...entry })) };
    });
  }

  listGlobal(): SessionInfo[] {
    return this.getGlobalSessions().sessions;
  }

  getGlobal(sessionId: string): SessionInfo | undefined {
    const data = this.getGlobalSessions();
    return data.sessions.find(s => s.sessionId === sessionId);
  }

  private standingConstraintRegister(session?: SessionInfo): ConstraintRegister {
    const entries = session?.standingConstraintEntries !== undefined
      ? session.standingConstraintEntries
      : session?.standingConstraints !== undefined
        ? [{ id: LEGACY_CONSTRAINT_ID, text: session.standingConstraints }]
        : [];
    return readConstraintRegister({ entries, revision: session?.standingConstraintsRevision ?? 0 });
  }

  private persistStandingConstraintRegister(
    session: SessionInfo,
    register: ConstraintRegister,
  ): ConstraintRegister {
    session.standingConstraintEntries = register.entries.map((entry) => ({ ...entry }));
    session.standingConstraintsRevision = register.revision;
    session.standingConstraints = register.constraints || undefined;
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

  readStandingConstraints(sessionId: string): ConstraintRegister {
    return this.standingConstraintRegister(this.getGlobal(sessionId));
  }

  addStandingConstraint(sessionId: string, text: string): ConstraintRegister {
    return this.updateGlobalSessions((data) => {
      const session = this.getOrCreateGlobalSession(data, sessionId);
      const current = this.standingConstraintRegister(session);
      const next = addConstraint(current, text);
      return next === current ? current : this.persistStandingConstraintRegister(session, next);
    });
  }

  editStandingConstraint(
    sessionId: string,
    id: string,
    expectedRevision: number,
    replacement: string | null,
  ): ConstraintRegister {
    return this.updateGlobalSessions((data) => {
      const session = this.getOrCreateGlobalSession(data, sessionId);
      const current = this.standingConstraintRegister(session);
      const next = editConstraint(current, id, expectedRevision, replacement);
      return next === current ? current : this.persistStandingConstraintRegister(session, next);
    });
  }

  clearStandingConstraints(sessionId: string, expectedRevision: number): ConstraintRegister {
    return this.updateGlobalSessions((data) => {
      const session = this.getOrCreateGlobalSession(data, sessionId);
      const current = this.standingConstraintRegister(session);
      return this.persistStandingConstraintRegister(session, clearConstraints(current, expectedRevision));
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
    const sourceConstraints = sourceSession ? this.standingConstraintRegister(sourceSession) : undefined;

    const newSessionId = `ses_fork_${Date.now()}`;
    const newSession: SessionInfo = {
      sessionId: newSessionId,
      taskFolder: sourceSession?.taskFolder,
      ...(sourceSession && Object.prototype.hasOwnProperty.call(sourceSession, 'featureName')
        ? { featureName: sourceSession.featureName }
        : {}),
      standingConstraints: sourceConstraints?.constraints || undefined,
      standingConstraintEntries: sourceConstraints?.entries.map((entry) => ({ ...entry })),
      standingConstraintsRevision: sourceConstraints?.revision,
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
