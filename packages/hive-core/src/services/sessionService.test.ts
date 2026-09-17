import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { SessionService, SessionContinuityError, STANDING_CONSTRAINTS_MAX_CHARS } from './sessionService.js';
import { getGlobalSessionsPath } from '../utils/paths.js';

const TEST_DIR = '/tmp/hive-core-sessionservice-test-' + process.pid;
const PROJECT_ROOT = TEST_DIR;

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

function setupFeature(directoryName: string, logicalName = directoryName): void {
  const featurePath = path.join(TEST_DIR, '.hive', 'features', directoryName);
  fs.mkdirSync(featurePath, { recursive: true });
  fs.writeFileSync(
    path.join(featurePath, 'feature.json'),
    JSON.stringify({ name: logicalName, status: 'executing', createdAt: new Date().toISOString() })
  );
}

describe('SessionService', () => {
  let service: SessionService;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    service = new SessionService(PROJECT_ROOT);
  });

  afterEach(() => {
    cleanup();
  });

  describe('existing per-feature behavior', () => {
    it('tracks a session for a feature', () => {
      setupFeature('my-feature');
      const session = service.track('my-feature', 'sess-existing');
      expect(session.sessionId).toBe('sess-existing');
      expect(session.startedAt).toBeDefined();
    });

    it('get returns session by feature and id', () => {
      setupFeature('my-feature');
      service.track('my-feature', 'sess-existing');
      const found = service.get('my-feature', 'sess-existing');
      expect(found?.sessionId).toBe('sess-existing');
    });

    it('fork preserves explicit featureless routing and an empty constraint register', () => {
      setupFeature('my-feature');
      const sessionsPath = path.join(TEST_DIR, '.hive', 'features', 'my-feature', 'sessions.json');
      fs.writeFileSync(sessionsPath, JSON.stringify({
        sessions: [{
          sessionId: 'source',
          featureName: null,
          standingConstraintEntries: [],
          standingConstraintsRevision: 0,
          startedAt: 'start',
          lastActiveAt: 'start',
        }],
      }));

      expect(service.fork('my-feature', 'source')).toMatchObject({
        featureName: null,
        standingConstraintEntries: [],
        standingConstraintsRevision: 0,
      });
    });

    it('rejects a corrupt source without writing a fork', () => {
      setupFeature('my-feature');
      const sessionsPath = path.join(TEST_DIR, '.hive', 'features', 'my-feature', 'sessions.json');
      fs.writeFileSync(sessionsPath, JSON.stringify({
        sessions: [{
          sessionId: 'source',
          standingConstraints: 'A'.repeat(STANDING_CONSTRAINTS_MAX_CHARS + 1),
          startedAt: 'start',
          lastActiveAt: 'start',
        }],
      }));
      const before = fs.readFileSync(sessionsPath);

      expect(() => service.fork('my-feature', 'source')).toThrow(/over the 8000 character cap/);
      expect(fs.readFileSync(sessionsPath)).toEqual(before);
    });
  });

  describe('listGlobal', () => {
    it('reads a missing registry without creating files', () => {
      expect(service.listGlobal()).toEqual([]);
      expect(service.readStandingConstraints('missing').entries).toEqual([]);
      expect(fs.readdirSync(PROJECT_ROOT)).toEqual([]);
    });

    it('uses only the authoritative registry and returns detached records', () => {
      setupFeature('mirror');
      fs.writeFileSync(path.join(PROJECT_ROOT, '.hive/features/mirror/sessions.json'), JSON.stringify({ sessions: [{ sessionId: 'mirror-only' }] }));
      service.trackGlobal('global', { standingConstraintEntries: [{ id: 'legacy', text: 'Keep scope' }] });
      const sessions = service.listGlobal();
      expect(sessions.map(session => session.sessionId)).toEqual(['global']);
      sessions[0].standingConstraintEntries![0].text = 'Changed';
      expect(service.listGlobal()[0].standingConstraintEntries![0].text).toBe('Keep scope');
    });
  });

  describe('trackGlobal', () => {
    it('tracks global session identity before feature binding', () => {
      const session = service.trackGlobal('sess-1', {
        agent: 'forager-worker',
        baseAgent: 'forager-worker',
        sessionKind: 'task-worker',
      });
      expect(session.sessionKind).toBe('task-worker');
      expect(session.featureName).toBeUndefined();
      expect(session.agent).toBe('forager-worker');
      expect(session.baseAgent).toBe('forager-worker');
    });

    it('writes to .hive/sessions.json', () => {
      service.trackGlobal('sess-g1', { agent: 'hive-master', sessionKind: 'primary' });
      const globalPath = getGlobalSessionsPath(PROJECT_ROOT);
      expect(fs.existsSync(globalPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
      expect(data.sessions.some((s: { sessionId: string }) => s.sessionId === 'sess-g1')).toBe(true);
    });

    it('does not require a feature name', () => {
      const session = service.trackGlobal('sess-nofeat', {
        sessionKind: 'subagent',
      });
      expect(session.sessionId).toBe('sess-nofeat');
      expect(session.featureName).toBeUndefined();
    });

    it('merges repeated updates rather than replacing metadata', () => {
      service.trackGlobal('sess-merge', { agent: 'forager-worker', sessionKind: 'task-worker' });
      const updated = service.trackGlobal('sess-merge', { messageCount: 5, directivePrompt: 'Investigate the current issue.' });
      expect(updated.agent).toBe('forager-worker');
      expect(updated.sessionKind).toBe('task-worker');
      expect(updated.messageCount).toBe(5);
      expect(updated.directivePrompt).toBe('Investigate the current issue.');
    });

    it('preserves directiveRecoveryState across successive global updates', () => {
      service.trackGlobal('sess-recovery-global', {
        agent: 'scout-researcher',
        sessionKind: 'subagent',
        directivePrompt: 'Investigate the current issue.',
        directiveRecoveryState: 'available',
      });

      const updated = service.trackGlobal('sess-recovery-global', { messageCount: 5 });

      expect(updated.directiveRecoveryState).toBe('available');
      expect(updated.directivePrompt).toBe('Investigate the current issue.');
      expect(updated.messageCount).toBe(5);
    });

    it('stores standing constraints and preserves them across unrelated updates', () => {
      service.trackGlobal('sess-constraints', { agent: 'hive-master', sessionKind: 'primary' });
      service.trackGlobal('sess-constraints', { standingConstraints: 'Australian English. No emojis.' });

      const updated = service.trackGlobal('sess-constraints', { messageCount: 3 });

      expect(updated.standingConstraints).toBe('Australian English. No emojis.');
      expect(updated.agent).toBe('hive-master');
    });

    it('tracks parentSessionId and duplicatedFromSessionId lineage', () => {
      const child = service.trackGlobal('sess-child', {
        parentSessionId: 'sess-parent',
        sessionKind: 'subagent',
      });
      expect(child.parentSessionId).toBe('sess-parent');
      expect(child.duplicatedFromSessionId).toBeUndefined();

      const duplicated = service.trackGlobal('sess-dup', {
        duplicatedFromSessionId: 'sess-original',
        standingConstraints: 'Be concise.',
      });
      expect(duplicated.duplicatedFromSessionId).toBe('sess-original');
      expect(duplicated.standingConstraints).toBe('Be concise.');

      const patched = service.trackGlobal('sess-dup', {
        messageCount: 2,
      });
      expect(patched.duplicatedFromSessionId).toBe('sess-original');
      expect(patched.standingConstraints).toBe('Be concise.');
      expect(patched.messageCount).toBe(2);
    });

    it('clears standing constraints when patched with undefined', () => {
      service.trackGlobal('sess-constraints-clear', {
        agent: 'hive-master',
        sessionKind: 'primary',
        standingConstraints: 'Australian English. No emojis.',
      });

      const cleared = service.trackGlobal('sess-constraints-clear', { standingConstraints: undefined });

      expect(cleared.standingConstraints).toBeUndefined();
      expect(cleared.agent).toBe('hive-master');
      expect(service.getGlobal('sess-constraints-clear')?.standingConstraints).toBeUndefined();
    });

    it('rejects malformed constraint patches without changing the registry', () => {
      service.trackGlobal('sess-invalid-patch', { agent: 'hive-master' });
      const globalPath = getGlobalSessionsPath(PROJECT_ROOT);
      const before = fs.readFileSync(globalPath);

      expect(() => service.trackGlobal('sess-invalid-patch', {
        standingConstraintEntries: [{ id: 'legacy', text: '  ' }],
        standingConstraintsRevision: 1,
      })).toThrow(/non-blank/);
      expect(fs.readFileSync(globalPath)).toEqual(before);

      expect(() => service.trackGlobal('sess-invalid-patch', {
        standingConstraints: 'A'.repeat(STANDING_CONSTRAINTS_MAX_CHARS + 1),
      })).toThrow(/over the 8000 character cap/);
      expect(fs.readFileSync(globalPath)).toEqual(before);

      expect(() => service.trackGlobal('sess-invalid-patch', { standingConstraints: null as any })).toThrow(/non-blank/);
      expect(fs.readFileSync(globalPath)).toEqual(before);
    });

    it('preserves earlier global sessions across successive writes', () => {
      service.trackGlobal('sess-a', { agent: 'hive-master', sessionKind: 'primary' });
      service.trackGlobal('sess-b', { agent: 'forager-worker', sessionKind: 'task-worker' });

      const globalPath = getGlobalSessionsPath(PROJECT_ROOT);
      const data = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
      expect(data.sessions.some((s: { sessionId: string }) => s.sessionId === 'sess-a')).toBe(true);
      expect(data.sessions.some((s: { sessionId: string }) => s.sessionId === 'sess-b')).toBe(true);
    });
  });

  describe('getGlobal', () => {
    it('returns undefined for unknown session', () => {
      expect(service.getGlobal('no-such-session')).toBeUndefined();
    });

    it('returns tracked global session', () => {
      service.trackGlobal('sess-gget', { agent: 'scout-researcher' });
      const session = service.getGlobal('sess-gget');
      expect(session?.agent).toBe('scout-researcher');
    });
  });

  describe('standing constraint register', () => {
    it('preserves additions, edits only the target, and makes duplicate additions idempotent', () => {
      const first = service.addStandingConstraint('sess-register', 'A');
      const second = service.addStandingConstraint('sess-register', 'B');
      const duplicate = service.addStandingConstraint('sess-register', 'A');

      expect(second.constraints).toBe('A\n\nB');
      expect(second.revision).toBe(2);
      expect(duplicate).toEqual(second);

      const edited = service.editStandingConstraint(
        'sess-register',
        second.entries[1]!.id,
        second.revision,
        'B corrected',
      );
      expect(edited.constraints).toBe('A\n\nB corrected');
      expect(edited.entries[0]).toEqual(first.entries[0]);
      expect(edited.entries[1]!.id).toBe(second.entries[1]!.id);
    });

    it('rejects stale, missing, blank, and over-cap mutations without changing the register', () => {
      const first = service.addStandingConstraint('sess-atomic', 'A');
      const current = service.addStandingConstraint('sess-atomic', 'B');

      expect(() => service.editStandingConstraint('sess-atomic', first.entries[0]!.id, first.revision, 'stale')).toThrow();
      expect(service.readStandingConstraints('sess-atomic')).toEqual(current);
      expect(() => service.editStandingConstraint('sess-atomic', 'missing', current.revision, null)).toThrow();
      expect(() => service.editStandingConstraint('sess-atomic', current.entries[0]!.id, current.revision, '  ')).toThrow();
      expect(() => service.addStandingConstraint('sess-atomic', 'C'.repeat(8000))).toThrow();
      expect(service.readStandingConstraints('sess-atomic')).toEqual(current);
    });

    it('accepts exactly the UTF-16 cap and rejects one code unit more', () => {
      expect(service.addStandingConstraint('sess-cap', 'A'.repeat(STANDING_CONSTRAINTS_MAX_CHARS)))
        .toMatchObject({ constraintsChars: STANDING_CONSTRAINTS_MAX_CHARS });
      expect(() => service.addStandingConstraint('sess-over-cap', 'A'.repeat(STANDING_CONSTRAINTS_MAX_CHARS + 1)))
        .toThrow(/over the 8000 character cap/);
      expect(service.getGlobal('sess-over-cap')).toBeUndefined();
    });

    it('reads legacy strings as one deterministic entry and migrates them on mutation', () => {
      service.trackGlobal('sess-legacy', { standingConstraints: 'Legacy verbatim text.' });

      const firstRead = service.readStandingConstraints('sess-legacy');
      const restarted = new SessionService(PROJECT_ROOT).readStandingConstraints('sess-legacy');
      expect(firstRead).toEqual({
        entries: [{ id: 'legacy', text: 'Legacy verbatim text.' }],
        revision: 0,
        constraints: 'Legacy verbatim text.',
        constraintsChars: 21,
      });
      expect(restarted).toEqual(firstRead);

      const added = new SessionService(PROJECT_ROOT).addStandingConstraint('sess-legacy', 'New text.');
      expect(added.entries).toEqual([
        { id: 'legacy', text: 'Legacy verbatim text.' },
        expect.objectContaining({ text: 'New text.' }),
      ]);
      expect(added.revision).toBe(1);
    });

    it('rejects disagreeing structured and flattened constraint patches before writing', () => {
      service.trackGlobal('sess-conflict', { agent: 'hive-master' });
      const globalPath = getGlobalSessionsPath(PROJECT_ROOT);
      const before = fs.readFileSync(globalPath);

      expect(() => service.trackGlobal('sess-conflict', {
        standingConstraintEntries: [{ id: 'legacy', text: 'Structured text.' }],
        standingConstraints: 'Different flattened text.',
        standingConstraintsRevision: 1,
      })).toThrow(/disagree/);
      expect(fs.readFileSync(globalPath)).toEqual(before);
      expect(service.readStandingConstraints('sess-conflict')).toMatchObject({ entries: [], revision: 0 });

      expect(() => service.trackGlobal('sess-conflict', {
        standingConstraintEntries: [],
        standingConstraints: 'Orphaned flattened text.',
      })).toThrow(/disagree/);
      expect(fs.readFileSync(globalPath)).toEqual(before);
    });

    it('persists one canonical register from agreeing representations and preserves entries on revision-only patches', () => {
      service.trackGlobal('sess-canonical', { standingConstraints: 'Alpha' });
      const agreed = service.trackGlobal('sess-canonical', {
        standingConstraintEntries: [{ id: 'legacy', text: 'Alpha\n\nBeta' }],
        standingConstraints: 'Alpha\n\nBeta',
        standingConstraintsRevision: 3,
      });
      expect(agreed).toMatchObject({
        standingConstraintEntries: [{ id: 'legacy', text: 'Alpha\n\nBeta' }],
        standingConstraints: 'Alpha\n\nBeta',
        standingConstraintsRevision: 3,
      });

      const revisionOnly = service.trackGlobal('sess-canonical', { standingConstraintsRevision: 5 });
      expect(revisionOnly).toMatchObject({
        standingConstraintEntries: [{ id: 'legacy', text: 'Alpha\n\nBeta' }],
        standingConstraints: 'Alpha\n\nBeta',
        standingConstraintsRevision: 5,
      });
    });

    it('keeps revision history after explicit whole-register clear', () => {
      const added = service.addStandingConstraint('sess-clear-revision', 'A');
      const cleared = service.clearStandingConstraints('sess-clear-revision', added.revision);

      expect(cleared).toMatchObject({ entries: [], revision: 2, constraints: '' });
      expect(() => service.clearStandingConstraints('sess-clear-revision', added.revision)).toThrow();
      expect(service.readStandingConstraints('sess-clear-revision')).toEqual(cleared);
    });
  });

  describe('bindFeature', () => {
    it('binds a global session to a feature and preserves earlier metadata', () => {
      service.trackGlobal('sess-bind', { agent: 'forager-worker', baseAgent: 'forager-worker', sessionKind: 'task-worker' });
      setupFeature('feature-a');
      const session = service.bindFeature('sess-bind', 'feature-a', {
        taskFolder: '01-first-task',
      });
      expect(session.featureName).toBe('feature-a');
      expect(session.taskFolder).toBe('01-first-task');
      expect(session.agent).toBe('forager-worker');
      expect(session.baseAgent).toBe('forager-worker');
      expect(session.sessionKind).toBe('task-worker');
    });

    it('mirrors bound session into feature-local sessions.json', () => {
      service.trackGlobal('sess-mirror', { agent: 'forager-worker', sessionKind: 'task-worker' });
      setupFeature('feature-b');
      service.bindFeature('sess-mirror', 'feature-b', { taskFolder: '02-second-task' });

      const featureSession = service.get('feature-b', 'sess-mirror');
      expect(featureSession?.taskFolder).toBe('02-second-task');
    });

    it('does not write feature-local sessions.json before binding', () => {
      service.trackGlobal('sess-nobind', { agent: 'hive-master', sessionKind: 'primary' });
      setupFeature('feature-c');
      const featureSessPath = path.join(TEST_DIR, '.hive', 'features', 'feature-c', 'sessions.json');
      expect(fs.existsSync(featureSessPath)).toBe(false);
    });

    it('does not clobber earlier agent, baseAgent, sessionKind on bind', () => {
      service.trackGlobal('sess-noclobber', {
        agent: 'forager-worker',
        baseAgent: 'forager-worker',
        sessionKind: 'task-worker',
      });
      setupFeature('feature-d');
      const session = service.bindFeature('sess-noclobber', 'feature-d', {
        taskFolder: '03-task',
      });
      expect(session.agent).toBe('forager-worker');
      expect(session.baseAgent).toBe('forager-worker');
      expect(session.sessionKind).toBe('task-worker');
    });

    it('persists directiveRecoveryState through bindFeature mirroring', () => {
      service.trackGlobal('sess-recovery-bind', {
        agent: 'scout-researcher',
        sessionKind: 'subagent',
        directivePrompt: 'Investigate the current issue.',
        directiveRecoveryState: 'consumed',
      });
      setupFeature('feature-recovery');

      const session = service.bindFeature('sess-recovery-bind', 'feature-recovery', {
        taskFolder: '03-task',
      });

      expect(session.directiveRecoveryState).toBe('consumed');
      expect(session.directivePrompt).toBe('Investigate the current issue.');

      const featureSession = service.get('feature-recovery', 'sess-recovery-bind');
      expect(featureSession?.directiveRecoveryState).toBe('consumed');
      expect(featureSession?.directivePrompt).toBe('Investigate the current issue.');
    });

  });

  describe('feature routing snapshots', () => {
    it('distinguishes unset, selected, and explicitly featureless routes', () => {
      setupFeature('feature-a');
      expect(service.trackGlobal('route').featureName).toBeUndefined();
      expect(service.setFeatureRoute('route', 'feature-a').featureName).toBe('feature-a');
      expect(service.setFeatureRoute('route', null)).toMatchObject({ featureName: null });
      const cleared = service.clearFeatureRoute('route');
      expect(cleared.featureName).toBeUndefined();
      expect(cleared).not.toHaveProperty('featureName');
    });

    it('validates selected features without creating missing feature paths', () => {
      expect(() => service.setFeatureRoute('route', '../missing')).toThrow("Feature '../missing' not found");
      expect(() => service.trackGlobal('route', { featureName: '../missing' })).toThrow("Feature '../missing' not found");
      expect(fs.existsSync(path.join(TEST_DIR, '.hive', 'features'))).toBe(false);
      expect(service.getGlobal('route')).toBeUndefined();
    });

    it('stores an indexed directory alias as the session route', () => {
      setupFeature('03_dagster-product-lifecycle', 'dagster-product-lifecycle');

      const session = service.setFeatureRoute('route', '03_dagster-product-lifecycle');

      expect(session.featureName).toBe('03_dagster-product-lifecycle');
      expect(service.getGlobal('route')?.featureName).toBe('03_dagster-product-lifecycle');
    });

    it('snapshots parent route and session constraints independently', () => {
      setupFeature('feature-a');
      setupFeature('feature-b');
      service.setFeatureRoute('parent', 'feature-a');
      service.addStandingConstraint('parent', 'Parent A');

      const child = service.snapshotChildSession('parent', 'child', { agent: 'forager-worker' });
      service.setFeatureRoute('parent', 'feature-b');
      service.editStandingConstraint(
        'parent',
        service.readStandingConstraints('parent').entries[0]!.id,
        service.readStandingConstraints('parent').revision,
        'Parent B',
      );

      expect(child).toMatchObject({ parentSessionId: 'parent', featureName: 'feature-a', standingConstraints: 'Parent A' });
      expect(service.getGlobal('child')).toMatchObject({ featureName: 'feature-a', standingConstraints: 'Parent A' });
      expect(service.getGlobal('parent')).toMatchObject({ featureName: 'feature-b', standingConstraints: 'Parent B' });
    });

    it('persists null routes and empty constraint snapshots without changing old leases', () => {
      const sessionsPath = getGlobalSessionsPath(PROJECT_ROOT);
      fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
      const lease = { parentSessionId: 'old', callId: 'call', agent: 'general', projectRoot: PROJECT_ROOT, resourcePaths: [PROJECT_ROOT], runtimeId: 'runtime' };
      fs.writeFileSync(sessionsPath, JSON.stringify({
        sessions: [{ sessionId: 'parent', featureName: null, standingConstraintEntries: [], standingConstraintsRevision: 0, startedAt: 'start', lastActiveAt: 'start' }],
        nativeTaskLeases: [lease],
      }));

      service.setFeatureRoute('parent', null);
      const added = service.addStandingConstraint('parent', 'Temporary');
      service.clearStandingConstraints('parent', added.revision);
      const child = service.snapshotChildSession('parent', 'child');

      expect(child).toMatchObject({ featureName: null, standingConstraintEntries: [], standingConstraintsRevision: 2 });
      expect(JSON.parse(fs.readFileSync(sessionsPath, 'utf8')).nativeTaskLeases).toEqual([lease]);
    });

    it('rejects a different snapshot parent before changing the existing child', () => {
      service.trackGlobal('parent-a');
      service.trackGlobal('parent-b');
      service.snapshotChildSession('parent-a', 'child', { agent: 'forager-worker' });
      const before = fs.readFileSync(getGlobalSessionsPath(PROJECT_ROOT), 'utf8');

      expect(() => service.snapshotChildSession('parent-b', 'child', { agent: 'other' })).toThrow(/parent cannot change/);
      expect(fs.readFileSync(getGlobalSessionsPath(PROJECT_ROOT), 'utf8')).toBe(before);
    });
  });

  describe('findFeatureBySession', () => {
    it('finds feature from global sessions.json after binding', () => {
      service.trackGlobal('sess-find', { sessionKind: 'task-worker' });
      setupFeature('feature-find');
      service.bindFeature('sess-find', 'feature-find', { taskFolder: '01-task' });
      const found = service.findFeatureBySession('sess-find');
      expect(found).toBe('feature-find');
    });

    it('does not resolve from feature-local sessions when the global binding is absent', () => {
      setupFeature('feature-local-only');
      service.bindFeature('sess-local-only', 'feature-local-only');
      fs.rmSync(getGlobalSessionsPath(PROJECT_ROOT));

      const found = service.findFeatureBySession('sess-local-only');

      expect(found).toBeNull();
    });
  });
});
