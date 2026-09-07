import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { SessionService } from './sessionService.js';
import { getGlobalSessionsPath } from '../utils/paths.js';

const TEST_DIR = '/tmp/hive-core-sessionservice-test-' + process.pid;
const PROJECT_ROOT = TEST_DIR;

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

function setupFeature(featureName: string): void {
  const featurePath = path.join(TEST_DIR, '.hive', 'features', featureName);
  fs.mkdirSync(featurePath, { recursive: true });
  fs.writeFileSync(
    path.join(featurePath, 'feature.json'),
    JSON.stringify({ name: featureName, status: 'executing', createdAt: new Date().toISOString() })
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
      service.trackGlobal('global', { standingConstraintEntries: [{ id: 'one', text: 'Keep scope' }] });
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
        workerPromptPath: '.hive/features/feature-a/tasks/01-first-task/worker-prompt.md',
      });
      expect(session.featureName).toBe('feature-a');
      expect(session.taskFolder).toBe('01-first-task');
      expect(session.agent).toBe('forager-worker');
      expect(session.baseAgent).toBe('forager-worker');
      expect(session.sessionKind).toBe('task-worker');
      expect(session.workerPromptPath).toBe('.hive/features/feature-a/tasks/01-first-task/worker-prompt.md');
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
