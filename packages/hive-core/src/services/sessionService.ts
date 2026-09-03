import * as path from 'path';
import { getFeaturePath, getGlobalSessionsPath, ensureDir, readJson, writeJson, acquireLockSync, writeJsonAtomic } from '../utils/paths.js';
import type { SessionInfo, SessionsJson } from '../types.js';

/**
 * Fields whose absence is meaningful state: an explicit `undefined` in a patch
 * clears them instead of being ignored as "not supplied".
 */
const CLEARABLE_SESSION_FIELDS = new Set<keyof SessionInfo>([
  'directiveRecoveryState',
  'standingConstraints',
]);

export class SessionService {
  constructor(private projectRoot: string) {}

  private applySessionPatch(target: SessionInfo, patch?: Partial<SessionInfo>): void {
    if (!patch) {
      return;
    }

    const { sessionId: _sessionId, ...rest } = patch;
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

  private updateGlobalSessions(mutator: (data: SessionsJson) => SessionInfo): SessionInfo {
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

  getGlobal(sessionId: string): SessionInfo | undefined {
    const data = this.getGlobalSessions();
    return data.sessions.find(s => s.sessionId === sessionId);
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
