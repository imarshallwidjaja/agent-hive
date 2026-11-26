import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, fileExists, readJson, acquireLockSync, writeJsonAtomic, syncFile, syncDirectory, resolveExistingFeaturePath } from '../utils/paths.js';
import {
  assertNativeObservationOwner,
  DEFAULT_NATIVE_OBSERVATION_OWNER,
  getNativeSessionsPath,
} from '../native-observations.js';
import type { NativeObservationOwner } from '../native-observations.js';
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

export const STANDING_CONSTRAINTS_MAX_CHARS = CONSTRAINTS_MAX_CHARS;
export const LEGACY_STANDING_CONSTRAINT_ID = LEGACY_CONSTRAINT_ID;
export { ConstraintRegisterError as StandingConstraintError };
export type { ConstraintRegister as StandingConstraintRegister };

/**
 * Fields whose absence is meaningful state: an explicit `undefined` in a patch
 * clears them instead of being ignored as "not supplied". A child's task and
 * ad-hoc run association is one assignment, so binding one clears the other.
 */
const CLEARABLE_SESSION_FIELDS = new Set<keyof SessionInfo>([
  'standingConstraints',
  'standingConstraintEntries',
  'taskFolder',
  'adHocRunId',
]);

export class SessionService {
  readonly owner: NativeObservationOwner;

  /**
   * `projectRoot` is the real project root; it keys feature resolution and visibility. `owner` selects which
   * native host's session index this service reads and writes.
   */
  constructor(private projectRoot: string, owner: NativeObservationOwner = DEFAULT_NATIVE_OBSERVATION_OWNER) {
    this.owner = assertNativeObservationOwner(owner);
  }

  private applySessionPatch(target: SessionInfo, patch?: Partial<SessionInfo>): void {
    if (!patch) {
      return;
    }

    const { sessionId: _sessionId, ...rest } = patch;
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

  private getGlobalSessionsPath(): string {
    return getNativeSessionsPath(this.projectRoot, this.owner);
  }

  private getGlobalSessions(): SessionsJson {
    const globalPath = this.getGlobalSessionsPath();
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

  private updateGlobalSessions<T>(mutator: (data: SessionsJson) => T): T {
    const globalPath = this.getGlobalSessionsPath();
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

  listGlobal(): SessionInfo[] {
    return this.getGlobalSessions().sessions;
  }

  getGlobal(sessionId: string): SessionInfo | undefined {
    const data = this.getGlobalSessions();
    return data.sessions.find(s => s.sessionId === sessionId);
  }

  /**
   * Strictly read-only lookup. Unlike `getGlobal`, an unparseable or malformed index throws and stays
   * untouched: no backup, reset, lock, or directory creation.
   */
  peekGlobal(sessionId: string): SessionInfo | undefined {
    const globalPath = this.getGlobalSessionsPath();
    if (!fileExists(globalPath)) return undefined;
    let data: SessionsJson | null;
    try {
      data = readJson<SessionsJson>(globalPath);
    } catch (error) {
      throw new Error(`Session index ${globalPath} is unreadable; it was left unchanged for explicit recovery.`, { cause: error });
    }
    // `readJson` also returns null for a file holding the literal `null`, which is a malformed index.
    if (typeof data !== 'object' || data === null || !Array.isArray(data.sessions)) {
      throw new Error(`Session index ${globalPath} has no sessions array; it was left unchanged for explicit recovery.`);
    }
    return data.sessions.find((session) => session?.sessionId === sessionId);
  }

  /** The standing-constraint register a session record holds; an absent session holds none. */
  standingConstraintRegister(session?: SessionInfo): ConstraintRegister {
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
    // Entries are the one stored form; drop the flattened text an older writer may have left beside them.
    delete session.standingConstraints;
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
}
