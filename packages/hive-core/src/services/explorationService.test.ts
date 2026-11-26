import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EXPLORATION_LIMITS,
  EXPLORATION_UNTRUSTED_NOTICE,
  ExplorationError,
  ExplorationService,
} from './explorationService.js';
import type {
  ExplorationBriefView,
  ExplorationErrorReason,
  ExplorationFullView,
  ExplorationListView,
  ExplorationUpdateInput,
} from './explorationService.js';
import type { WorklogAuthor } from './worklogService.js';

const TEST_DIR = `/tmp/hive-core-exploration-test-${process.pid}`;
const HIVE = path.join(TEST_DIR, '.hive');
const EXPLORATIONS = path.join(HIVE, 'explorations');
const PRIMARY: WorklogAuthor = { owner: 'opencode-v1', sessionId: 'ses_primary', agent: 'hive-master' };
const OTHER: WorklogAuthor = { owner: 'opencode-v2', sessionId: 'ses_other', agent: 'dash-reviewer' };

let clock = 0;
let service: ExplorationService;

function expectError(run: () => unknown, reason: ExplorationErrorReason): ExplorationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ExplorationError);
    expect((error as ExplorationError).reason).toBe(reason);
    return error as ExplorationError;
  }
  throw new Error(`Expected ExplorationError ${reason}`);
}

function brief(id: string): ExplorationBriefView {
  return service.read({ id }) as ExplorationBriefView;
}

function full(id: string): ExplorationFullView {
  return service.read({ id, view: 'full' }) as ExplorationFullView;
}

function list(): ExplorationListView {
  return service.read() as ExplorationListView;
}

function create(id: string, extra: Partial<ExplorationUpdateInput> = {}) {
  return service.update({ id, expectedRevision: 0, goal: `Explore ${id}`, ...extra }, PRIMARY);
}

const ACTIVE = path.join(EXPLORATIONS, 'active');
const CLOSED = path.join(EXPLORATIONS, 'closed');

/** Writes a stored document, changed by `edit`, at `placement/<id>.json`. */
function writeStored(placement: 'active' | 'closed', id: string, source: string, edit: (doc: Record<string, any>) => void = () => {}): void {
  const doc = JSON.parse(fs.readFileSync(source, 'utf8'));
  doc.id = id;
  edit(doc);
  fs.mkdirSync(path.join(EXPLORATIONS, placement), { recursive: true });
  fs.writeFileSync(path.join(EXPLORATIONS, placement, `${id}.json`), JSON.stringify(doc));
}

/** Every path under the project with its modification time, to prove a call wrote nothing. */
function snapshotTree(): string[] {
  if (!fs.existsSync(TEST_DIR)) return [];
  return fs.readdirSync(TEST_DIR, { recursive: true, withFileTypes: true })
    .map((entry) => path.join(entry.parentPath, entry.name))
    .map((file) => `${file}:${fs.lstatSync(file).mtimeMs}`)
    .sort();
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  clock = 0;
  service = new ExplorationService(TEST_DIR, { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)) });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('ExplorationService', () => {
  describe('worked examples', () => {
    it('maps, settles and concludes a non-security debugging exploration', () => {
      const created = create('flaky-login-test', {
        goal: 'Find why the login integration test fails intermittently',
        subject: 'root/main @ 5c163be (packages/web/test/login.test.ts)',
        operationId: 'create-1',
        frontier: [
          { key: 'fixture', target: 'test/fixtures/session.ts', state: 'open', question: 'Does the fixture share state between tests?' },
          { key: 'clock', target: 'src/auth/token.ts', state: 'open', question: 'Does token expiry use wall-clock time?' },
          { key: 'ci-env', target: 'CI runner image', state: 'open' },
        ],
      });
      // An update returns a compact receipt; the goal, gaps, observations and authors stay in the read views.
      expect(created).toEqual({
        id: 'flaky-login-test', status: 'active', scopeMapped: true, lastProgressRevision: 0, stagnantRevisions: 1,
        counts: { frontierTotal: 3, open: 3, covered: 0, blocked: 0, dropped: 0, observationsTotal: 0, confirmed: 0, hypothesis: 0, refuted: 0 },
        committedRevision: 1, currentRevision: 1, replayed: false,
      });
      expect(brief('flaky-login-test')).toMatchObject({
        revision: 1, createdBy: PRIMARY, updatedBy: PRIMARY, gaps: { total: 3 }, untrustedNotice: EXPLORATION_UNTRUSTED_NOTICE,
      });

      const settled = service.update({
        id: 'flaky-login-test', expectedRevision: 1,
        frontier: [
          { key: 'fixture', target: 'test/fixtures/session.ts', state: 'covered', evidence: 'Each test builds a fresh session store.', refs: ['test/fixtures/session.ts:12'] },
          { key: 'ci-env', target: 'CI runner image', state: 'dropped', reason: 'Fails locally too.' },
        ],
        observations: [
          { key: 'expiry', summary: 'Token expiry compares Date.now() with a 1s window', status: 'hypothesis', refs: ['src/auth/token.ts:40'] },
        ],
      }, OTHER);
      expect(settled).toMatchObject({ currentRevision: 2, lastProgressRevision: 2, stagnantRevisions: 0, counts: { open: 1, covered: 1, dropped: 1, hypothesis: 1 } });
      expect(brief('flaky-login-test')).toMatchObject({ createdBy: PRIMARY, updatedBy: OTHER });
      expect(brief('flaky-login-test').gaps.items.map((item) => item.key)).toEqual(['clock']);

      // Adding a speculative open item and editing the goal is not progress.
      const widened = service.update({
        id: 'flaky-login-test', expectedRevision: 2, goal: 'Find why the login test fails intermittently on slow machines',
        frontier: [{ key: 'retry', target: 'test/helpers/retry.ts', state: 'open' }],
      }, PRIMARY);
      expect(widened).toMatchObject({ currentRevision: 3, lastProgressRevision: 2, stagnantRevisions: 1 });

      service.update({
        id: 'flaky-login-test', expectedRevision: 3,
        frontier: [{ key: 'clock', target: 'src/auth/token.ts', state: 'covered', evidence: 'A 1100ms delay reproduces the failure every run.' }],
        observations: [
          { key: 'expiry-confirmed', summary: 'Expiry window is too tight under load', status: 'confirmed', supersedes: 'expiry' },
          { key: 'expiry', summary: 'Token expiry compares Date.now() with a 1s window', status: 'refuted', refs: ['src/auth/token.ts:40'] },
        ],
      }, PRIMARY);
      expect(brief('flaky-login-test').observations.items.map((item) => [item.key, item.status])).toEqual([['expiry-confirmed', 'confirmed'], ['expiry', 'refuted']]);

      const concluded = service.update({
        id: 'flaky-login-test', expectedRevision: 4, status: 'concluded', conclusion: 'The token expiry window is too tight; widen it to 5s.',
      }, PRIMARY);
      expect(concluded).toMatchObject({ status: 'concluded', currentRevision: 5 });
      expect(brief('flaky-login-test')).toMatchObject({ status: 'concluded', closedAt: expect.any(String), conclusion: expect.stringContaining('5s') });
      expect(fs.existsSync(path.join(EXPLORATIONS, 'closed', 'flaky-login-test.json'))).toBe(true);
      expect(fs.existsSync(path.join(EXPLORATIONS, 'active', 'flaky-login-test.json'))).toBe(false);
      expect(list().explorations).toEqual([]);
      expect(full('flaky-login-test').frontier.find((item) => item.key === 'fixture')).toMatchObject({ refs: ['test/fixtures/session.ts:12'], updatedRevision: 2 });
    });

    it('records a security audit with blocked surfaces and continues it in a follow-up exploration', () => {
      create('audit-auth', {
        goal: 'Audit the authentication surface for authorization bypasses',
        subject: 'http://127.0.0.1:3000',
        frontier: [
          { key: 'POST /login', target: 'POST /login', state: 'open', question: 'Is the rate limit per account or per IP?' },
          { key: 'GET /admin', target: 'GET /admin', state: 'blocked', reason: 'Needs an admin fixture account.' },
        ],
        observations: [{ key: 'csrf', summary: 'State-changing routes check the CSRF header', status: 'confirmed', refs: ['src/middleware/csrf.ts'] }],
      });
      const audit = brief('audit-auth');
      expect(audit.gaps.items.map((item) => [item.key, item.state])).toEqual([['POST /login', 'open'], ['GET /admin', 'blocked']]);
      expect(audit.lastProgressRevision).toBe(1);
      service.update({ id: 'audit-auth', expectedRevision: 1, status: 'abandoned', reason: 'Scope moved to the new gateway.' }, PRIMARY);
      // A closed exploration takes no further updates; a retest starts a new one citing it.
      expectError(() => service.update({ id: 'audit-auth', expectedRevision: 2, goal: 'retry' }, PRIMARY), 'already_closed');
      create('audit-auth-2', { goal: 'Retest the gateway authentication surface', priorExplorationId: 'audit-auth' });
      expect(brief('audit-auth-2').priorExplorationId).toBe('audit-auth');
      expect(list().explorations.map((entry) => entry.id)).toEqual(['audit-auth-2']);
    });
  });

  describe('state machine and invariants', () => {
    it('enforces frontier and closing invariants before writing anything', () => {
      const cases: Array<[Partial<ExplorationUpdateInput>, ExplorationErrorReason]> = [
        [{ goal: undefined }, 'invalid_argument'],
        [{ goal: '   ' }, 'invalid_argument'],
        [{ goal: 'line\nbreak' }, 'invalid_argument'],
        [{ goal: 'x'.repeat(513) }, 'input_too_large'],
        [{ goal: '\ud800' }, 'invalid_argument'],
        [{ frontier: [{ key: 'a', target: 't', state: 'covered' }] }, 'invalid_argument'],
        [{ frontier: [{ key: 'a', target: 't', state: 'blocked' }] }, 'invalid_argument'],
        [{ frontier: [{ key: 'a', target: 't', state: 'dropped', reason: ' ' }] }, 'invalid_argument'],
        // Evidence belongs only to covered items, and a reason only to blocked and dropped ones.
        [{ frontier: [{ key: 'a', target: 't', state: 'open', evidence: 'seen' }] }, 'invalid_argument'],
        [{ frontier: [{ key: 'a', target: 't', state: 'blocked', reason: 'r', evidence: 'seen' }] }, 'invalid_argument'],
        [{ frontier: [{ key: 'a', target: 't', state: 'dropped', reason: 'r', evidence: 'seen' }] }, 'invalid_argument'],
        [{ frontier: [{ key: 'a', target: 't', state: 'open', reason: 'r' }] }, 'invalid_argument'],
        [{ frontier: [{ key: 'a', target: 't', state: 'covered', evidence: 'seen', reason: 'r' }] }, 'invalid_argument'],
        [{ frontier: [{ key: 'a', target: '', state: 'open' }] }, 'invalid_argument'],
        [{ frontier: [{ key: 'a', target: 't', state: 'done' as never }] }, 'invalid_argument'],
        [{ frontier: [{ key: 'a', target: 't', state: 'open' }, { key: 'a', target: 'u', state: 'open' }] }, 'invalid_argument'],
        [{ frontier: [{ key: ' a', target: 't', state: 'open' }] }, 'invalid_argument'],
        [{ frontier: Array.from({ length: EXPLORATION_LIMITS.batchMax + 1 }, (_, i) => ({ key: `k${i}`, target: 't', state: 'open' as const })) }, 'input_too_large'],
        [{ frontier: [{ key: 'a', target: 't', state: 'open', refs: Array.from({ length: 9 }, () => 'r') }] }, 'input_too_large'],
        [{ observations: [{ key: 'o', summary: 's', status: 'maybe' as never }] }, 'invalid_argument'],
        [{ observations: [{ key: 'o', summary: 's', status: 'confirmed', supersedes: 'o' }] }, 'invalid_argument'],
        [{ observations: [{ key: 'o', summary: 's', status: 'confirmed' }, { key: 'o', summary: 't', status: 'refuted' }] }, 'invalid_argument'],
        [{ status: 'concluded' }, 'invalid_argument'],
        [{ status: 'abandoned', conclusion: 'done' }, 'invalid_argument'],
        [{ conclusion: 'no status' }, 'invalid_argument'],
        [{ reason: 'no status' }, 'invalid_argument'],
        [{ status: 'active' as never }, 'invalid_argument'],
        [{ priorExplorationId: 'bad id' }, 'invalid_argument'],
        [{ operationId: '-bad' }, 'invalid_argument'],
        [{ expectedRevision: -1 }, 'invalid_argument'],
        [{ expectedRevision: 1.5 }, 'invalid_argument'],
        [{ id: '../escape' }, 'invalid_argument'],
        [{ id: 'Upper' }, 'invalid_argument'],
      ];
      for (const [extra, reason] of cases) {
        expectError(() => service.update({ id: 'probe', expectedRevision: 0, goal: 'g', ...extra } as ExplorationUpdateInput, PRIMARY), reason);
      }
      expectError(() => service.update({ id: 'probe', expectedRevision: 0, goal: 'g' }, { ...PRIMARY, owner: 'nobody' as never }), 'invalid_argument');
      expectError(() => service.update({ id: 'probe', expectedRevision: 1 }, PRIMARY), 'invalid_argument');
      // Nothing was created: no explorations directory and no lock anchors.
      expect(fs.readdirSync(TEST_DIR)).toEqual([]);
    });

    it('requires exact revisions, rejects duplicates and unknown ids, and keeps subject and prior id immutable', () => {
      create('e1', { subject: 'scope', priorExplorationId: 'e0' });
      expectError(() => create('e1'), 'already_exists');
      expectError(() => service.update({ id: 'missing', expectedRevision: 1, goal: 'g' }, PRIMARY), 'not_found');
      const stale = expectError(() => service.update({ id: 'e1', expectedRevision: 2, goal: 'g' }, PRIMARY), 'stale_revision');
      expect(stale.details).toMatchObject({ currentRevision: 1, expectedRevision: 2 });
      expectError(() => service.update({ id: 'e1', expectedRevision: 1, subject: 'other' }, PRIMARY), 'immutable_field');
      expectError(() => service.update({ id: 'e1', expectedRevision: 1, priorExplorationId: 'e9' }, PRIMARY), 'immutable_field');
      // Repeating the stored value is not a change.
      expect(service.update({ id: 'e1', expectedRevision: 1, subject: 'scope', goal: 'new goal' }, PRIMARY)).toMatchObject({ currentRevision: 2 });
      expect(brief('e1')).toMatchObject({ goal: 'new goal', subject: 'scope' });
      expectError(() => service.update({ id: 'e1', expectedRevision: 2, observations: [{ key: 'b', summary: 's', status: 'confirmed', supersedes: 'ghost' }] }, PRIMARY), 'invalid_argument');
      expect(brief('e1').revision).toBe(2);
      create('e2');
      service.update({ id: 'e2', expectedRevision: 1, status: 'concluded', conclusion: 'done' }, PRIMARY);
      // Both closing states are terminal: a concluded exploration cannot be abandoned or reopened.
      expectError(() => service.update({ id: 'e2', expectedRevision: 2, status: 'abandoned', reason: 'again' }, PRIMARY), 'already_closed');
    });

    it('upserts by key and keeps the revision tag of an unchanged item', () => {
      create('upsert', { frontier: [{ key: 'a', target: 'A', state: 'open' }, { key: 'b', target: 'B', state: 'open' }] });
      service.update({ id: 'upsert', expectedRevision: 1, frontier: [{ key: 'a', target: 'A', state: 'open' }, { key: 'c', target: 'C', state: 'open' }] }, PRIMARY);
      const doc = full('upsert');
      expect(doc.frontier.map((item) => [item.key, item.updatedRevision])).toEqual([['a', 1], ['b', 1], ['c', 2]]);
      service.update({ id: 'upsert', expectedRevision: 2, frontier: [{ key: 'b', target: 'B2', state: 'covered', evidence: 'seen' }] }, PRIMARY);
      expect(full('upsert').frontier.find((item) => item.key === 'b')).toEqual({ key: 'b', target: 'B2', state: 'covered', evidence: 'seen', updatedRevision: 3 });
      expect(full('upsert').counts).toMatchObject({ frontierTotal: 3, open: 2, covered: 1 });
    });

    it('rejects updates that change nothing, after the immutable-field check', () => {
      create('noop', { subject: 'scope', priorExplorationId: 'earlier', frontier: [{ key: 'a', target: 'A', state: 'open' }] });
      const before = snapshotTree();
      // Pre-lock: empty collections alone carry nothing.
      expectError(() => service.update({ id: 'noop', expectedRevision: 1, frontier: [] }, PRIMARY), 'invalid_argument');
      expectError(() => service.update({ id: 'noop', expectedRevision: 1, observations: [] }, PRIMARY), 'invalid_argument');
      // Under the lock: repeating the stored immutable values is no change.
      expectError(() => service.update({ id: 'noop', expectedRevision: 1, subject: 'scope' }, PRIMARY), 'invalid_argument');
      expectError(() => service.update({ id: 'noop', expectedRevision: 1, priorExplorationId: 'earlier' }, PRIMARY), 'invalid_argument');
      expectError(() => service.update({ id: 'noop', expectedRevision: 1, subject: 'scope', priorExplorationId: 'earlier', frontier: [], observations: [] }, PRIMARY), 'invalid_argument');
      // A changed immutable value still reports immutable_field.
      expectError(() => service.update({ id: 'noop', expectedRevision: 1, subject: 'other' }, PRIMARY), 'immutable_field');
      expectError(() => service.update({ id: 'noop', expectedRevision: 1, priorExplorationId: 'another', frontier: [] }, PRIMARY), 'immutable_field');
      expect(snapshotTree().filter((entry) => !entry.includes('.locks'))).toEqual(before.filter((entry) => !entry.includes('.locks')));
      expect(brief('noop').revision).toBe(1);
    });

    it('rejects supersedes cycles and counts a supersedes change as progress', () => {
      create('chain', {
        observations: [
          { key: 'a', summary: 'first', status: 'hypothesis' },
          { key: 'b', summary: 'second', status: 'confirmed', supersedes: 'a' },
        ],
      });
      expectError(() => service.update({ id: 'chain', expectedRevision: 1, observations: [{ key: 'a', summary: 'first', status: 'hypothesis', supersedes: 'b' }] }, PRIMARY), 'invalid_argument');
      expectError(() => service.update({
        id: 'chain', expectedRevision: 1,
        observations: [{ key: 'c', summary: 'third', status: 'confirmed', supersedes: 'b' }, { key: 'a', summary: 'first', status: 'hypothesis', supersedes: 'c' }],
      }, PRIMARY), 'invalid_argument');
      expect(brief('chain').revision).toBe(1);

      // Widening the frontier is not progress; changing only what an observation supersedes is.
      service.update({ id: 'chain', expectedRevision: 1, frontier: [{ key: 'f', target: 'F', state: 'open' }] }, PRIMARY);
      expect(brief('chain')).toMatchObject({ revision: 2, lastProgressRevision: 1, stagnantRevisions: 1 });
      service.update({ id: 'chain', expectedRevision: 2, observations: [{ key: 'c', summary: 'third', status: 'confirmed' }] }, PRIMARY);
      const progressed = service.update({ id: 'chain', expectedRevision: 3, observations: [{ key: 'c', summary: 'third', status: 'confirmed', supersedes: 'b' }] }, PRIMARY);
      expect(progressed).toMatchObject({ currentRevision: 4, lastProgressRevision: 4, stagnantRevisions: 0 });
      // Resending an unchanged observation keeps its revision tag and is not progress.
      service.update({ id: 'chain', expectedRevision: 4, goal: 'new goal', observations: [{ key: 'c', summary: 'third', status: 'confirmed', supersedes: 'b' }] }, PRIMARY);
      expect(full('chain')).toMatchObject({ revision: 5, lastProgressRevision: 4 });
      expect(full('chain').observations.find((item) => item.key === 'c')!.updatedRevision).toBe(4);
    });

    it('rejects supersedes errors a batch shows on its own before taking a lock', () => {
      const cycle = [
        { key: 'a', summary: 's', status: 'confirmed' as const, supersedes: 'b' },
        { key: 'b', summary: 's', status: 'confirmed' as const, supersedes: 'a' },
      ];
      const dangling = [{ key: 'a', summary: 's', status: 'confirmed' as const, supersedes: 'ghost' }];
      // A new exploration holds only its batch, so cycles and missing targets are both known up front.
      expectError(() => create('fresh', { observations: cycle }), 'invalid_argument');
      expectError(() => create('fresh', { observations: dangling }), 'invalid_argument');
      // An existing one may link into stored observations, but a cycle within the batch is refused up front too.
      expectError(() => service.update({ id: 'fresh', expectedRevision: 1, observations: cycle }, PRIMARY), 'invalid_argument');
      // Nothing was created: no explorations directory and no lock anchors.
      expect(fs.readdirSync(TEST_DIR)).toEqual([]);
    });

    it('refuses stored documents that break the frontier, supersedes or prior-id invariants', () => {
      create('source', {
        frontier: [{ key: 'k', target: 't', state: 'open' }],
        observations: [{ key: 'a', summary: 's', status: 'confirmed' }, { key: 'b', summary: 's', status: 'confirmed', supersedes: 'a' }],
      });
      const source = path.join(ACTIVE, 'source.json');
      writeStored('active', 'open-evidence', source, (doc) => { doc.frontier[0].evidence = 'seen'; });
      writeStored('active', 'open-reason', source, (doc) => { doc.frontier[0].reason = 'why'; });
      writeStored('active', 'cycle', source, (doc) => { doc.observations[0].supersedes = 'b'; });
      writeStored('active', 'ghost', source, (doc) => { doc.observations[1].supersedes = 'ghost'; });
      writeStored('active', 'self-prior', source, (doc) => { doc.priorExplorationId = 'self-prior'; });
      writeStored('active', 'active-closed-at', source, (doc) => { doc.closedAt = doc.updatedAt; });
      for (const id of ['open-evidence', 'open-reason', 'cycle', 'ghost', 'self-prior', 'active-closed-at']) {
        expectError(() => service.read({ id }), 'exploration_corrupt');
        expectError(() => service.update({ id, expectedRevision: 1, goal: 'g' }, PRIMARY), 'exploration_corrupt');
      }
      expect(list().errors.map((error) => [error.file, error.reason])).toEqual([
        ['active-closed-at.json', 'exploration_corrupt'],
        ['cycle.json', 'exploration_corrupt'],
        ['ghost.json', 'exploration_corrupt'],
        ['open-evidence.json', 'exploration_corrupt'],
        ['open-reason.json', 'exploration_corrupt'],
        ['self-prior.json', 'exploration_corrupt'],
      ]);
    });
  });

  describe('retries', () => {
    it('replays an identical request, even after closure, and refuses a changed one', () => {
      const first = create('retry', { operationId: 'op-1', frontier: [{ key: 'a', target: 'A', state: 'open' }] });
      service.update({ id: 'retry', expectedRevision: 1, operationId: 'op-2', observations: [{ key: 'o', summary: 's', status: 'confirmed' }] }, PRIMARY);
      const replay = create('retry', { operationId: 'op-1', frontier: [{ key: 'a', target: 'A', state: 'open' }] });
      // A replay reports the revision it committed, while status, counts and stagnation describe the exploration now.
      expect(replay).toEqual({
        id: 'retry', status: 'active', scopeMapped: true, lastProgressRevision: 2, stagnantRevisions: 0,
        counts: { frontierTotal: 1, open: 1, covered: 0, blocked: 0, dropped: 0, observationsTotal: 1, confirmed: 1, hypothesis: 0, refuted: 0 },
        committedRevision: first.committedRevision, currentRevision: 2, replayed: true,
      });
      expect(first.committedRevision).toBe(1);
      const conflict = expectError(() => create('retry', { operationId: 'op-1', goal: 'different' }), 'operation_conflict');
      expect(conflict.details).toMatchObject({ committedRevision: 1 });
      // Another session's identical operationId is a new request, which the revision guard refuses.
      expectError(() => service.update({ id: 'retry', expectedRevision: 0, goal: 'Explore retry', operationId: 'op-1', frontier: [{ key: 'a', target: 'A', state: 'open' }] }, OTHER), 'already_exists');

      const close = { id: 'retry', expectedRevision: 2, operationId: 'close', status: 'concluded' as const, conclusion: 'done' };
      expect(service.update(close, PRIMARY)).toMatchObject({ replayed: false, committedRevision: 3 });
      expect(service.update(close, PRIMARY)).toMatchObject({ replayed: true, committedRevision: 3, currentRevision: 3, status: 'concluded' });
      expectError(() => service.update({ ...close, conclusion: 'other' }, PRIMARY), 'operation_conflict');
    });

    it('keeps a bounded receipt ring', () => {
      create('ring', { operationId: 'op-0' });
      for (let index = 1; index <= EXPLORATION_LIMITS.receiptsMax; index++) {
        service.update({ id: 'ring', expectedRevision: index, operationId: `op-${index}`, goal: `goal ${index}` }, PRIMARY);
      }
      const stored = JSON.parse(fs.readFileSync(path.join(EXPLORATIONS, 'active', 'ring.json'), 'utf8'));
      expect(stored.receipts).toHaveLength(EXPLORATION_LIMITS.receiptsMax);
      expect(stored.receipts[0].operationId).toBe('op-1');
      // The evicted receipt no longer replays; the revision guard answers instead.
      expectError(() => create('ring', { operationId: 'op-0' }), 'already_exists');
    });

    it('serializes concurrent writers from separate processes without losing updates', async () => {
      create('shared');
      const serviceModule = new URL('./explorationService.ts', import.meta.url).href;
      const script = `
        import { ExplorationService } from ${JSON.stringify(serviceModule)};
        const service = new ExplorationService(process.env.PROJECT_ROOT);
        const author = { owner: 'opencode-v1', sessionId: process.env.WRITER, agent: 'hive-master' };
        for (let i = 0; i < 5; i++) {
          for (;;) {
            const { revision } = service.read({ id: 'shared' });
            try {
              service.update({ id: 'shared', expectedRevision: revision, operationId: process.env.WRITER + '-' + i,
                observations: [{ key: process.env.WRITER + '-' + i, summary: 'from ' + process.env.WRITER, status: 'confirmed' }] }, author);
              break;
            } catch (error) {
              if (error.reason !== 'stale_revision') throw error;
            }
          }
        }
      `;
      const writers = ['w1', 'w2', 'w3', 'w4'];
      await Promise.all(writers.map((writer) => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], {
          env: { ...process.env, PROJECT_ROOT: TEST_DIR, WRITER: writer },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${writer} exited ${code}: ${stderr}`))));
      })));
      const doc = full('shared');
      expect(doc.revision).toBe(21);
      expect(doc.observations).toHaveLength(20);
      expect(new Set(doc.observations.map((item) => item.key)).size).toBe(20);
    }, 30000);
  });

  describe('storage', () => {
    it('reads without writing and lists an empty project without creating directories', () => {
      expect(list()).toEqual({ view: 'list', explorations: [], totalActive: 0, truncated: false, errors: [], untrustedNotice: EXPLORATION_UNTRUSTED_NOTICE });
      expectError(() => service.read({ id: 'nothing' }), 'not_found');
      expectError(() => service.read({ view: 'full' }), 'invalid_argument');
      expectError(() => service.read({ id: 'x', view: 'other' as never }), 'invalid_argument');
      expect(fs.existsSync(HIVE)).toBe(false);
      create('one');
      const before = snapshotTree();
      brief('one');
      full('one');
      list();
      expect(snapshotTree()).toEqual(before);
    });

    it('discovers active and closed IDs by file name, newest first, without opening any file or writing', () => {
      expect(service.discover()).toEqual({ active: [], closed: [] });
      expect(fs.existsSync(HIVE)).toBe(false);
      for (const id of ['old-active', 'new-active', 'interrupted', 'old-closed', 'new-closed']) create(id);
      for (const id of ['interrupted', 'old-closed', 'new-closed']) {
        service.update({ id, expectedRevision: 1, status: 'concluded', conclusion: 'done' }, PRIMARY);
      }
      // An interrupted close leaves both copies; discovery lists the ID once, as closed, like a named read.
      fs.copyFileSync(path.join(CLOSED, 'interrupted.json'), path.join(ACTIVE, 'interrupted.json'));
      fs.writeFileSync(path.join(CLOSED, 'corrupt.json'), '{not json');
      fs.writeFileSync(path.join(CLOSED, 'new-closed.json.tmp.1.2'), '{');
      fs.writeFileSync(path.join(CLOSED, 'Not-An-Id.json'), '{}');
      fs.writeFileSync(path.join(ACTIVE, 'README'), 'ignored');
      const at = (placement: string, id: string, seconds: number) => fs.utimesSync(path.join(EXPLORATIONS, placement, `${id}.json`), seconds, seconds);
      at('active', 'old-active', 100);
      at('active', 'new-active', 300);
      at('active', 'interrupted', 400);
      at('closed', 'old-closed', 100);
      at('closed', 'new-closed', 300);
      at('closed', 'interrupted', 200);
      at('closed', 'corrupt', 200);

      const before = snapshotTree();
      const opened = spyOn(fs, 'openSync');
      try {
        expect(service.discover()).toEqual({
          active: ['new-active', 'old-active'],
          closed: ['new-closed', 'corrupt', 'interrupted', 'old-closed'],
        });
        expect(opened).not.toHaveBeenCalled();
      } finally {
        opened.mockRestore();
      }
      expect(snapshotTree()).toEqual(before);
      // The agent list stays active-only, and the corrupt record fails only when it is read.
      expect(list().explorations.map((entry) => entry.id).sort()).toEqual(['new-active', 'old-active']);
      expectError(() => service.read({ id: 'corrupt' }), 'exploration_corrupt');
    });

    it('lists an exploration closed between the two placement scans once, as closed', () => {
      create('closing');
      create('staying');
      const originalReaddir = fs.readdirSync;
      const scanned: string[] = [];
      // The close lands right after the first placement scan, whichever placement that is.
      let closing = false;
      const readdir = spyOn(fs, 'readdirSync').mockImplementation(((directory: fs.PathLike, options?: unknown) => {
        const names = (originalReaddir as (...args: unknown[]) => string[])(directory, options);
        if (closing) return names;
        scanned.push(path.basename(String(directory)));
        if (scanned.length === 1) {
          closing = true;
          service.update({ id: 'closing', expectedRevision: 1, status: 'concluded', conclusion: 'done' }, PRIMARY);
          closing = false;
        }
        return names;
      }) as typeof fs.readdirSync);
      try {
        expect(service.discover()).toEqual({ active: ['staying'], closed: ['closing'] });
      } finally {
        readdir.mockRestore();
      }
      expect(scanned).toEqual(['active', 'closed']);
    });

    it.skipIf(process.platform === 'win32')('checks closed/ again just before scanning it', () => {
      const outside = `${TEST_DIR}-outside`;
      fs.mkdirSync(outside, { recursive: true });
      const originalReaddir = fs.readdirSync;
      try {
        create('kept');
        fs.mkdirSync(CLOSED, { recursive: true });
        fs.writeFileSync(path.join(outside, 'hidden.json'), '{}');
        // After the upfront check passed and active/ was scanned, closed/ is swapped for a link.
        const readdir = spyOn(fs, 'readdirSync').mockImplementation(((directory: fs.PathLike, options?: unknown) => {
          const names = (originalReaddir as (...args: unknown[]) => string[])(directory, options);
          if (String(directory) === ACTIVE) {
            fs.rmdirSync(CLOSED);
            fs.symlinkSync(outside, CLOSED);
          }
          return names;
        }) as typeof fs.readdirSync);
        try {
          expect(expectError(() => service.discover(), 'unsafe_path').details).toMatchObject({ path: '.hive/explorations/closed' });
        } finally {
          readdir.mockRestore();
        }
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('fails discovery through a linked or non-directory placement instead of reading it as empty', () => {
      const outside = `${TEST_DIR}-outside`;
      fs.mkdirSync(outside, { recursive: true });
      try {
        create('kept');
        fs.writeFileSync(path.join(outside, 'hidden.json'), '{}');
        fs.symlinkSync(outside, CLOSED);
        expect(expectError(() => service.discover(), 'unsafe_path').details).toMatchObject({ path: '.hive/explorations/closed' });
        fs.unlinkSync(CLOSED);
        fs.writeFileSync(CLOSED, 'not a directory');
        expect(expectError(() => service.discover(), 'io_error').details).toMatchObject({ stage: 'path', code: 'ENOTDIR' });
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('prefers the closed copy when an interrupted close left both files, and cleans up on the next write', () => {
      create('both', { operationId: 'c' });
      const activeFile = path.join(EXPLORATIONS, 'active', 'both.json');
      const saved = fs.readFileSync(activeFile, 'utf8');
      service.update({ id: 'both', expectedRevision: 1, operationId: 'close', status: 'abandoned', reason: 'out of scope' }, PRIMARY);
      fs.writeFileSync(activeFile, saved);
      expect(brief('both').status).toBe('abandoned');
      expect(list().explorations).toEqual([]);
      expectError(() => service.update({ id: 'both', expectedRevision: 1, goal: 'g' }, PRIMARY), 'already_closed');
      expect(fs.existsSync(activeFile)).toBe(false);
    });

    it('flushes closed/ and its parents before removing the active copy on a first close and on replay cleanup', () => {
      // syncDirectory opens no descriptor on Windows, so the flush order is observable only on POSIX; the storage
      // outcome is checked everywhere.
      const observesFlushes = process.platform !== 'win32';
      const activeFile = path.join(ACTIVE, 'durable.json');
      const events: string[] = [];
      const originalOpen = fs.openSync;
      const originalUnlink = fs.unlinkSync;
      const record = () => {
        const open = spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
          if (file === CLOSED || file === EXPLORATIONS || file === HIVE) events.push(`sync ${path.relative(TEST_DIR, String(file))}`);
          if (file === TEST_DIR) events.push('sync project root');
          return (originalOpen as (...args: unknown[]) => number)(file, ...rest);
        }) as typeof fs.openSync);
        const unlink = spyOn(fs, 'unlinkSync').mockImplementation(((file: fs.PathLike) => {
          if (file === activeFile) events.push('unlink active');
          return originalUnlink(file);
        }) as typeof fs.unlinkSync);
        return () => { open.mockRestore(); unlink.mockRestore(); };
      };

      create('durable', { operationId: 'create' });
      const saved = fs.readFileSync(activeFile, 'utf8');
      expect(fs.existsSync(CLOSED)).toBe(false);
      const close = { id: 'durable', expectedRevision: 1, operationId: 'close', status: 'concluded' as const, conclusion: 'done' };
      let restore = record();
      try {
        service.update(close, PRIMARY);
      } finally {
        restore();
      }
      // The first close creates closed/, so closed/, explorations/, .hive/ and the project root that holds .hive/ must
      // be flushed before the unlink.
      const parentSyncs = ['sync .hive/explorations/closed', 'sync .hive/explorations', 'sync .hive', 'sync project root'];
      const unlinkAt = events.indexOf('unlink active');
      expect(unlinkAt).toBeGreaterThanOrEqual(0);
      if (observesFlushes) expect(events.slice(0, unlinkAt)).toEqual(expect.arrayContaining(parentSyncs));
      expect(fs.existsSync(activeFile)).toBe(false);

      // An interrupted close left the active copy behind; the replay removes it only after the same flushes.
      fs.writeFileSync(activeFile, saved);
      events.length = 0;
      restore = record();
      try {
        expect(service.update(close, PRIMARY)).toMatchObject({ replayed: true, status: 'concluded' });
      } finally {
        restore();
      }
      // The replay acknowledges only after flushing the published copy, then cleanup flushes again before the unlink.
      expect(events).toEqual(observesFlushes ? [...parentSyncs, ...parentSyncs, 'unlink active'] : ['unlink active']);
      expect(fs.existsSync(activeFile)).toBe(false);

      if (!observesFlushes) return;
      // When the cleanup flush fails, the active copy stays and reads still answer from closed/.
      fs.writeFileSync(activeFile, saved);
      const failing = spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
        if (file === CLOSED) throw Object.assign(new Error('EIO: flush failed'), { code: 'EIO' });
        return (originalOpen as (...args: unknown[]) => number)(file, ...rest);
      }) as typeof fs.openSync);
      try {
        expectError(() => service.update({ id: 'durable', expectedRevision: 2, goal: 'again' }, PRIMARY), 'already_closed');
      } finally {
        failing.mockRestore();
      }
      expect(fs.existsSync(activeFile)).toBe(true);
      expect(brief('durable').status).toBe('concluded');
      expectError(() => service.update({ id: 'durable', expectedRevision: 2, goal: 'again' }, PRIMARY), 'already_closed');
      expect(fs.existsSync(activeFile)).toBe(false);
    });

    it('answers a named read from closed/ when a close lands between its closed/ and active/ checks', () => {
      create('race');
      const activeFile = path.join(ACTIVE, 'race.json');
      const closedFile = path.join(CLOSED, 'race.json');
      const activeContent = fs.readFileSync(activeFile, 'utf8');
      service.update({ id: 'race', expectedRevision: 1, status: 'abandoned', reason: 'moved' }, PRIMARY);
      const closedContent = fs.readFileSync(closedFile, 'utf8');
      const originalUnlink = fs.unlinkSync;
      const reset = () => {
        fs.rmSync(closedFile);
        fs.writeFileSync(activeFile, activeContent);
      };
      // The close another process performs: publish closed/, then remove active/.
      const closeNow = () => {
        fs.writeFileSync(closedFile, closedContent);
        originalUnlink(activeFile);
      };

      // The close lands after closed/ was found empty and before active/ is examined.
      reset();
      const originalLstat = fs.lstatSync;
      let sawClosed = false;
      let fired = false;
      const lstat = spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options?: unknown) => {
        if (file === closedFile) sawClosed = true;
        if (file === activeFile && sawClosed && !fired) {
          fired = true;
          closeNow();
        }
        return (originalLstat as (...args: unknown[]) => fs.Stats)(file, options);
      }) as typeof fs.lstatSync);
      try {
        expect(brief('race')).toMatchObject({ status: 'abandoned', reason: 'moved', revision: 2 });
      } finally {
        lstat.mockRestore();
      }
      expect(fired).toBe(true);

      // The close lands after active/ was examined and before it is opened: the open sees ENOENT.
      reset();
      const originalOpen = fs.openSync;
      fired = false;
      const open = spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
        if (file === activeFile && !fired) {
          fired = true;
          closeNow();
        }
        return (originalOpen as (...args: unknown[]) => number)(file, ...rest);
      }) as typeof fs.openSync);
      try {
        expect(full('race')).toMatchObject({ status: 'abandoned', revision: 2 });
      } finally {
        open.mockRestore();
      }
      expect(fired).toBe(true);
    });

    it('refuses a document whose status does not match its directory in reads, updates and the list', () => {
      create('misplaced-active');
      const activeSource = path.join(ACTIVE, 'misplaced-active.json');
      // An active document copied into closed/ must not shadow the real active copy or swallow writes.
      writeStored('closed', 'misplaced-active', activeSource);
      expectError(() => service.read({ id: 'misplaced-active' }), 'exploration_corrupt');
      const before = fs.readFileSync(activeSource, 'utf8');
      expectError(() => service.update({ id: 'misplaced-active', expectedRevision: 1, goal: 'lost?' }, PRIMARY), 'exploration_corrupt');
      expect(fs.readFileSync(activeSource, 'utf8')).toBe(before);

      create('misplaced-closed');
      service.update({ id: 'misplaced-closed', expectedRevision: 1, status: 'concluded', conclusion: 'done' }, PRIMARY);
      fs.renameSync(path.join(CLOSED, 'misplaced-closed.json'), path.join(ACTIVE, 'misplaced-closed.json'));
      expectError(() => service.read({ id: 'misplaced-closed' }), 'exploration_corrupt');
      expectError(() => service.update({ id: 'misplaced-closed', expectedRevision: 2, goal: 'g' }, PRIMARY), 'exploration_corrupt');

      expect(list().errors.map((error) => [error.file, error.reason])).toEqual([
        ['misplaced-active.json', 'exploration_corrupt'],
        ['misplaced-closed.json', 'exploration_corrupt'],
      ]);
    });

    it('reports a linked or corrupt closed copy beside an active file instead of hiding or listing it', () => {
      const outside = `${TEST_DIR}-outside`;
      fs.mkdirSync(outside, { recursive: true });
      try {
        for (const id of ['linked-valid', 'linked-dangling', 'corrupt-closed', 'plain']) create(id);
        // A valid closed document outside the project, which a followed link would have trusted.
        create('donor');
        service.update({ id: 'donor', expectedRevision: 1, status: 'concluded', conclusion: 'done' }, PRIMARY);
        const external = path.join(outside, 'linked-valid.json');
        const donor = JSON.parse(fs.readFileSync(path.join(CLOSED, 'donor.json'), 'utf8'));
        fs.writeFileSync(external, JSON.stringify({ ...donor, id: 'linked-valid' }));
        fs.symlinkSync(external, path.join(CLOSED, 'linked-valid.json'));
        fs.symlinkSync(path.join(outside, 'missing.json'), path.join(CLOSED, 'linked-dangling.json'));
        fs.writeFileSync(path.join(CLOSED, 'corrupt-closed.json'), '{');

        const listed = list();
        expect(listed.explorations.map((entry) => entry.id)).toEqual(['plain']);
        expect(listed.errors.map((error) => [error.file, error.reason])).toEqual([
          ['corrupt-closed.json', 'exploration_corrupt'],
          ['linked-dangling.json', 'unsafe_path'],
          ['linked-valid.json', 'unsafe_path'],
        ]);
        expectError(() => service.read({ id: 'linked-valid' }), 'unsafe_path');
        expectError(() => service.read({ id: 'linked-dangling' }), 'unsafe_path');
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('isolates corrupt, symlinked, oversized and temporary files in the list without throwing', () => {
      create('good-a');
      create('good-b', { frontier: [{ key: 'k', target: 't', state: 'open' }] });
      const active = path.join(EXPLORATIONS, 'active');
      fs.writeFileSync(path.join(active, 'broken.json'), '{not json');
      fs.writeFileSync(path.join(active, 'future.json'), JSON.stringify({ schemaVersion: 2, id: 'future' }));
      fs.writeFileSync(path.join(active, 'renamed.json'), fs.readFileSync(path.join(active, 'good-a.json')));
      fs.writeFileSync(path.join(active, 'huge.json'), 'x'.repeat(EXPLORATION_LIMITS.maxDocBytes + 1));
      fs.writeFileSync(path.join(active, 'good-a.json.tmp.1.2'), '{');
      fs.writeFileSync(path.join(active, 'README'), 'ignored');
      fs.symlinkSync(path.join(active, 'good-a.json'), path.join(active, 'linked.json'));
      const invalid = JSON.parse(fs.readFileSync(path.join(active, 'good-b.json'), 'utf8'));
      invalid.id = 'invalid';
      invalid.frontier[0].state = 'covered';
      fs.writeFileSync(path.join(active, 'invalid.json'), JSON.stringify(invalid));

      const listed = list();
      expect(listed.explorations.map((entry) => entry.id)).toEqual(['good-b', 'good-a']);
      expect(listed.totalActive).toBe(2);
      expect(Object.fromEntries(listed.errors.map((error) => [error.file, error.reason]))).toEqual({
        'broken.json': 'exploration_corrupt',
        'future.json': 'unsupported_schema',
        'renamed.json': 'exploration_corrupt',
        'huge.json': 'exploration_corrupt',
        'linked.json': 'unsafe_path',
        'invalid.json': 'exploration_corrupt',
      });
      expectError(() => service.read({ id: 'invalid' }), 'exploration_corrupt');
      expectError(() => service.read({ id: 'linked' }), 'unsafe_path');
      expectError(() => service.update({ id: 'broken', expectedRevision: 1, goal: 'g' }, PRIMARY), 'exploration_corrupt');
    });

    it('refuses a symlinked explorations directory before locking or writing', () => {
      const outside = `${TEST_DIR}-outside`;
      fs.mkdirSync(outside, { recursive: true });
      try {
        fs.mkdirSync(HIVE, { recursive: true });
        fs.symlinkSync(outside, EXPLORATIONS);
        expectError(() => create('escape'), 'unsafe_path');
        expectError(() => list(), 'unsafe_path');
        expect(fs.readdirSync(outside)).toEqual([]);
        expect(fs.existsSync(path.join(HIVE, '.locks'))).toBe(false);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('fails a list or read through a symlinked closed/ directory instead of hiding or trusting it', () => {
      const outside = `${TEST_DIR}-outside`;
      fs.mkdirSync(outside, { recursive: true });
      try {
        create('kept');
        fs.symlinkSync(outside, CLOSED);
        expect(expectError(() => list(), 'unsafe_path').details).toMatchObject({ path: '.hive/explorations/closed' });
        expectError(() => service.read({ id: 'kept' }), 'unsafe_path');
        expectError(() => service.read({ id: 'kept', view: 'full' }), 'unsafe_path');
        expect(fs.readdirSync(outside)).toEqual([]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform === 'win32')('fails the list when closed/ is replaced by a symbolic link mid-scan', () => {
      const outside = `${TEST_DIR}-outside`;
      fs.mkdirSync(outside, { recursive: true });
      const originalLstat = fs.lstatSync;
      let swapped = false;
      try {
        create('first');
        create('second');
        create('done');
        service.update({ id: 'done', expectedRevision: 1, status: 'concluded', conclusion: 'done' }, PRIMARY);
        // A valid closed copy of `second` outside the project, which a followed closed/ link would have trusted.
        writeStored('closed', 'second', path.join(CLOSED, 'done.json'));
        fs.renameSync(path.join(CLOSED, 'second.json'), path.join(outside, 'second.json'));
        const firstActive = path.join(ACTIVE, 'first.json');
        // After the upfront check passed and the first entry is being read, closed/ is swapped for a link.
        const lstat = spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options?: unknown) => {
          if (file === firstActive && !swapped) {
            swapped = true;
            fs.renameSync(CLOSED, `${CLOSED}-real`);
            fs.symlinkSync(outside, CLOSED);
          }
          return (originalLstat as (...args: unknown[]) => fs.Stats)(file, options);
        }) as typeof fs.lstatSync);
        try {
          expect(expectError(() => list(), 'unsafe_path').details).toMatchObject({ path: '.hive/explorations/closed' });
        } finally {
          lstat.mockRestore();
        }
        expect(swapped).toBe(true);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('rejects a file that grows past the limit after its size check without reading past one extra byte', () => {
      create('growing');
      const activeFile = path.join(ACTIVE, 'growing.json');
      const originalOpen = fs.openSync;
      const originalFstat = fs.fstatSync;
      const originalRead = fs.readSync;
      let fd: number | undefined;
      let grown = false;
      let bytesRead = 0;
      const open = spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
        const opened = (originalOpen as (...args: unknown[]) => number)(file, ...rest);
        if (file === activeFile) fd = opened;
        return opened;
      }) as typeof fs.openSync);
      // The size check sees the small file; the file then grows well past the limit before it is read.
      const fstat = spyOn(fs, 'fstatSync').mockImplementation(((handle: number, ...rest: unknown[]) => {
        const stat = (originalFstat as (...args: unknown[]) => fs.Stats)(handle, ...rest);
        if (handle === fd && !grown) {
          grown = true;
          fs.appendFileSync(activeFile, ' '.repeat(EXPLORATION_LIMITS.maxDocBytes * 2));
        }
        return stat;
      }) as typeof fs.fstatSync);
      const read = spyOn(fs, 'readSync').mockImplementation(((handle: number, ...rest: unknown[]) => {
        const count = (originalRead as (...args: unknown[]) => number)(handle, ...rest);
        if (handle === fd) bytesRead += count;
        return count;
      }) as typeof fs.readSync);
      try {
        const error = expectError(() => service.read({ id: 'growing' }), 'exploration_corrupt');
        expect(error.details).toEqual({ bytes: EXPLORATION_LIMITS.maxDocBytes + 1 });
      } finally {
        open.mockRestore();
        fstat.mockRestore();
        read.mockRestore();
      }
      expect(grown).toBe(true);
      expect(bytesRead).toBe(EXPLORATION_LIMITS.maxDocBytes + 1);
    });

    it.skipIf(process.platform === 'win32')('refuses a file replaced by a symbolic link after its metadata check', () => {
      create('swapped');
      const activeFile = path.join(ACTIVE, 'swapped.json');
      const target = path.join(TEST_DIR, 'target.json');
      fs.copyFileSync(activeFile, target);
      const originalLstat = fs.lstatSync;
      let swapped = false;
      let calls = 0;
      // The path check lstats the file first; the second lstat is readDocument's own. It reports the regular file,
      // then a link replaces it before the open.
      const lstat = spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options?: unknown) => {
        const stat = (originalLstat as (...args: unknown[]) => fs.Stats)(file, options);
        if (file === activeFile && stat.isFile() && ++calls === 2) {
          swapped = true;
          fs.rmSync(activeFile);
          fs.symlinkSync(target, activeFile);
        }
        return stat;
      }) as typeof fs.lstatSync);
      try {
        expectError(() => service.read({ id: 'swapped' }), 'unsafe_path');
      } finally {
        lstat.mockRestore();
      }
      expect(swapped).toBe(true);
    });

    it('fails cleanly when a placement directory is a regular file', () => {
      for (const placement of [ACTIVE, CLOSED]) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
        fs.mkdirSync(EXPLORATIONS, { recursive: true });
        fs.writeFileSync(placement, 'not a directory');
        const before = snapshotTree();
        const failures = [
          expectError(() => list(), 'io_error'),
          expectError(() => service.read({ id: 'probe' }), 'io_error'),
          expectError(() => service.update({ id: 'probe', expectedRevision: 1, goal: 'g' }, PRIMARY), 'io_error'),
          expectError(() => create('probe'), 'io_error'),
        ];
        for (const failure of failures) {
          expect(failure.details).toEqual({ stage: 'path', code: 'ENOTDIR' });
        }
        // Refused before any lock or write.
        expect(snapshotTree()).toEqual(before);
      }
    });
  });

  describe('durability', () => {
    // Directory flushes open a descriptor only on POSIX, so a flush failure can be injected only there.
    it.skipIf(process.platform === 'win32')('refuses to acknowledge a replay until the post-rename flush succeeds', () => {
      const originalOpen = fs.openSync;
      let failFlush = false;
      const open = spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
        if (failFlush && file === HIVE) throw Object.assign(new Error('EIO: flush failed'), { code: 'EIO' });
        return (originalOpen as (...args: unknown[]) => number)(file, ...rest);
      }) as typeof fs.openSync);
      try {
        const createInput = { id: 'flush', expectedRevision: 0, operationId: 'create', goal: 'Explore flush' };
        failFlush = true;
        const first = expectError(() => service.update(createInput, PRIMARY), 'io_error');
        expect(first.details).toMatchObject({ stage: 'write', publication: 'uncertain', code: 'EIO' });
        // The rename published the file, but an exact retry still cannot acknowledge it while the flush fails.
        expect(fs.existsSync(path.join(ACTIVE, 'flush.json'))).toBe(true);
        expect(expectError(() => service.update(createInput, PRIMARY), 'io_error').details).toMatchObject({ stage: 'write', publication: 'uncertain' });
        failFlush = false;
        expect(service.update(createInput, PRIMARY)).toMatchObject({ replayed: true, committedRevision: 1, currentRevision: 1 });

        // A close whose flush fails keeps the active copy until a retry flushes the closed copy and acknowledges it.
        const close = { id: 'flush', expectedRevision: 1, operationId: 'close', status: 'concluded' as const, conclusion: 'done' };
        failFlush = true;
        expect(expectError(() => service.update(close, PRIMARY), 'io_error').details).toMatchObject({ stage: 'write', publication: 'uncertain' });
        expect(fs.existsSync(path.join(CLOSED, 'flush.json'))).toBe(true);
        expect(fs.existsSync(path.join(ACTIVE, 'flush.json'))).toBe(true);
        expectError(() => service.update(close, PRIMARY), 'io_error');
        expect(fs.existsSync(path.join(ACTIVE, 'flush.json'))).toBe(true);
        failFlush = false;
        expect(service.update(close, PRIMARY)).toMatchObject({ replayed: true, committedRevision: 2, status: 'concluded' });
        expect(fs.existsSync(path.join(ACTIVE, 'flush.json'))).toBe(false);
      } finally {
        open.mockRestore();
      }
    });
  });

  describe('size bounds', () => {
    const bigItem = (index: number) => ({
      key: `item-${String(index).padStart(3, '0')}`,
      target: 't'.repeat(256),
      state: 'blocked' as const,
      question: 'q'.repeat(512),
      reason: 'r'.repeat(1024),
      refs: Array.from({ length: 8 }, () => 'f'.repeat(512)),
    });

    it('rejects an update past the document cap and leaves the stored file unchanged', () => {
      create('full');
      let revision = 1;
      let error: ExplorationError | undefined;
      for (let index = 0; index < 20 && !error; index++) {
        try {
          service.update({ id: 'full', expectedRevision: revision, frontier: [bigItem(index)] }, PRIMARY);
          revision += 1;
        } catch (caught) {
          error = caught as ExplorationError;
        }
      }
      expect(error?.reason).toBe('exploration_full');
      const file = path.join(EXPLORATIONS, 'active', 'full.json');
      expect(fs.statSync(file).size).toBeLessThanOrEqual(EXPLORATION_LIMITS.activeMaxDocBytes);
      expect(brief('full').revision).toBe(revision);
      // The full view of a document at the cap still fits a 64 KiB response.
      expect(Buffer.byteLength(JSON.stringify(full('full')))).toBeLessThan(64 * 1024);
    });

    it('keeps room to close an exploration filled to the active limit, even with worst-case escaping', () => {
      expect(EXPLORATION_LIMITS.activeMaxDocBytes).toBeLessThan(EXPLORATION_LIMITS.maxDocBytes);
      // Characters JSON escapes to two bytes, at every cap a close can fill.
      const closer: WorklogAuthor = { owner: 'opencode-v2', sessionId: '"'.repeat(256), agent: '\\'.repeat(128) };
      const fill = (id: string): number => {
        create(id);
        let revision = 1;
        let index = 0;
        const tryAdd = (frontier: NonNullable<ExplorationUpdateInput['frontier']>) => {
          try {
            service.update({ id, expectedRevision: revision, frontier }, PRIMARY);
            revision += 1;
            return true;
          } catch (error) {
            if ((error as ExplorationError).reason !== 'exploration_full') throw error;
            return false;
          }
        };
        while (tryAdd([bigItem(index++)]));
        for (let size = 256; size >= 1;) {
          if (!tryAdd([{ key: `pad-${index++}`, target: 'p'.repeat(size), state: 'open' }])) size = Math.floor(size / 2);
        }
        const bytes = fs.statSync(path.join(ACTIVE, `${id}.json`)).size;
        // Within one minimal frontier item of the active limit.
        expect(bytes).toBeLessThanOrEqual(EXPLORATION_LIMITS.activeMaxDocBytes);
        expect(bytes).toBeGreaterThan(EXPLORATION_LIMITS.activeMaxDocBytes - 128);
        return revision;
      };

      const concludeAt = fill('fill-conclude');
      const before = brief('fill-conclude').counts;
      const concluded = service.update({
        id: 'fill-conclude', expectedRevision: concludeAt, operationId: 'o'.repeat(128), status: 'concluded', conclusion: '"'.repeat(1024),
      }, closer);
      expect(concluded).toMatchObject({ status: 'concluded', counts: before });
      expect(fs.statSync(path.join(CLOSED, 'fill-conclude.json')).size).toBeLessThanOrEqual(EXPLORATION_LIMITS.maxDocBytes);

      const abandonAt = fill('fill-abandon');
      const frontierTotal = brief('fill-abandon').counts.frontierTotal;
      const abandoned = service.update({
        id: 'fill-abandon', expectedRevision: abandonAt, operationId: 'a'.repeat(128), status: 'abandoned', reason: '\\'.repeat(1024),
      }, closer);
      expect(abandoned).toMatchObject({ status: 'abandoned', counts: { frontierTotal } });
      expect(full('fill-abandon').frontier).toHaveLength(frontierTotal);
    });

    it('packs the brief view and the list under the 16 KiB budget with prefix lists', () => {
      const quoted = '"'.repeat(512);
      create('dense', {
        goal: quoted, subject: quoted,
        frontier: Array.from({ length: 6 }, (_, index) => {
          const { reason, refs: _refs, ...item } = bigItem(index);
          return index % 2 ? { ...item, state: 'open' as const } : { ...item, state: 'blocked' as const, reason };
        }),
        observations: Array.from({ length: 6 }, (_, index) => ({ key: `obs-${index}`, summary: '\\'.repeat(512), status: 'confirmed' as const })),
      });
      const view = brief('dense');
      const bytes = Buffer.byteLength(JSON.stringify(view));
      expect(bytes).toBeLessThanOrEqual(EXPLORATION_LIMITS.briefMaxBytes);
      expect(view.gaps.total).toBe(6);
      expect(view.gaps.items.length).toBeLessThan(6);
      expect(view.gaps.items.length).toBeGreaterThan(0);
      expect(view.observations.items.length).toBeGreaterThan(0);
      // Open gaps come before blocked ones.
      expect(view.gaps.items[0]!.state).toBe('open');
      const update = service.update({ id: 'dense', expectedRevision: 1, goal: quoted }, PRIMARY);
      // The receipt echoes none of the goal, subject, gaps or observations, so it stays small however large they are.
      expect(Buffer.byteLength(JSON.stringify(update))).toBeLessThan(512);

      for (let index = 0; index < 20; index++) create(`list-${String(index).padStart(2, '0')}`, { goal: quoted, subject: quoted });
      const listed = list();
      expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThanOrEqual(EXPLORATION_LIMITS.briefMaxBytes);
      expect(listed.truncated).toBe(true);
      expect(listed.totalActive).toBe(21);
      expect(listed.explorations[0]!.id).toBe('list-19');
    });
  });
});
