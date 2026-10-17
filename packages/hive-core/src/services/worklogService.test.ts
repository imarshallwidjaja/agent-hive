import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getWorklogKey,
  getWorklogPath,
  parseWorklogKey,
  WORKLOG_CORRECTED_BY_MAX,
  WORKLOG_ENTRY_MAX_BYTES,
  WORKLOG_LOG_MAX_BYTES,
  WORKLOG_MAX_RESPONSE_BYTES,
  WorklogError,
  WorklogService,
} from './worklogService.js';
import type { WorklogAuthor, WorklogErrorReason, WorklogRecordInput, WorklogRef } from './worklogService.js';

const TEST_DIR = `/tmp/hive-core-worklog-test-${process.pid}`;
const FEATURES = path.join(TEST_DIR, '.hive', 'features');
const FEATURE: WorklogRef = { kind: 'feature', featureName: 'checkout' };
const PRIMARY: WorklogAuthor = { owner: 'opencode-v1', sessionId: 'ses_primary', agent: 'hive-master' };
const OTHER_PRIMARY: WorklogAuthor = { owner: 'opencode-v2', sessionId: 'ses_other', agent: 'swarm-orchestrator' };
const STAMP = '2026-01-01T00:00:00.000Z';

function setupFeature(directoryName: string, name: string, status = 'executing'): string {
  const featurePath = path.join(FEATURES, directoryName);
  fs.mkdirSync(path.join(featurePath, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(featurePath, 'feature.json'), JSON.stringify({ name, status, createdAt: '2026-01-01T00:00:00.000Z' }));
  return featurePath;
}

function writeTask(featurePath: string, folder: string, status: Record<string, unknown> | string | null): void {
  const taskPath = path.join(featurePath, 'tasks', folder);
  fs.mkdirSync(taskPath, { recursive: true });
  if (status === null) return;
  fs.writeFileSync(path.join(taskPath, 'status.json'), typeof status === 'string' ? status : JSON.stringify({ origin: 'plan', ...status }));
}

function checkpoint(operationId: string, summary = `checkpoint ${operationId}`, extra: Partial<WorklogRecordInput> = {}): WorklogRecordInput {
  return { operationId, checkpoint: { summary }, ...extra };
}

function expectWorklogError(run: () => unknown, reason: WorklogErrorReason): WorklogError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorklogError);
    expect((error as WorklogError).reason).toBe(reason);
    return error as WorklogError;
  }
  throw new Error(`Expected WorklogError ${reason}`);
}

/** Paths and modification times of every file under the project, to prove reads write nothing. */
function snapshotTree(root = TEST_DIR): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => path.join(entry.parentPath, entry.name))
    .map((file) => `${file}:${fs.lstatSync(file).mtimeMs}`)
    .sort();
}

describe('WorklogService', () => {
  let service: WorklogService;
  let featurePath: string;

  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    featurePath = setupFeature('01_checkout', 'checkout');
    service = new WorklogService(TEST_DIR);
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('identity and paths', () => {
    it('round-trips stable keys, including session IDs that contain colons', () => {
      const session: WorklogRef = { kind: 'session', owner: 'opencode-v2', sessionId: 'ses:with:colons' };
      expect(getWorklogKey(FEATURE)).toBe('feature:checkout');
      expect(getWorklogKey(session)).toBe('session:opencode-v2:ses:with:colons');
      expect(parseWorklogKey('session:opencode-v2:ses:with:colons')).toEqual(session);
      expectWorklogError(() => parseWorklogKey('session:opencode-v3:x'), 'invalid_ref');
      expectWorklogError(() => getWorklogKey({ kind: 'feature', featureName: '../escape' }), 'invalid_ref');
    });

    it('stores feature logs in the resolved indexed directory and session logs under a hashed owner path', () => {
      expect(getWorklogPath(TEST_DIR, FEATURE)).toBe(path.join(featurePath, 'worklog.json'));
      const session: WorklogRef = { kind: 'session', owner: 'opencode-v2', sessionId: 'ses_x' };
      const digest = crypto.createHash('sha256').update('ses_x').digest('hex');
      expect(getWorklogPath(TEST_DIR, session)).toBe(path.join(TEST_DIR, '.hive', 'worklogs', 'sessions', 'opencode-v2', `${digest}.json`));
    });

    it('requires one real feature and never creates a phantom feature directory', () => {
      expectWorklogError(() => service.record({ kind: 'feature', featureName: 'missing' }, checkpoint('a'), PRIMARY), 'feature_not_found');
      expectWorklogError(() => service.read({ kind: 'feature', featureName: 'missing' }), 'feature_not_found');
      // A directory alias is not the feature's identity.
      expectWorklogError(() => service.record({ kind: 'feature', featureName: '01_checkout' }, checkpoint('a'), PRIMARY), 'feature_not_found');
      expect(fs.readdirSync(FEATURES)).toEqual(['01_checkout']);

      setupFeature('02_checkout', 'checkout');
      expectWorklogError(() => service.read(FEATURE), 'feature_ambiguous');
      fs.rmSync(path.join(FEATURES, '02_checkout'), { recursive: true });

      fs.mkdirSync(path.join(FEATURES, '03_checkout'));
      fs.writeFileSync(path.join(FEATURES, '03_checkout', 'feature.json'), '{broken');
      expectWorklogError(() => service.record(FEATURE, checkpoint('a'), PRIMARY), 'feature_unreadable');
      expect(fs.existsSync(path.join(featurePath, 'worklog.json'))).toBe(false);
    });

    it('records corrections on an archived feature without changing its lifecycle', () => {
      const archived = setupFeature('02_old', 'old', 'archived');
      const before = fs.readFileSync(path.join(archived, 'feature.json'), 'utf8');
      const result = service.record({ kind: 'feature', featureName: 'old' }, checkpoint('a', 'Late correction'), PRIMARY);
      expect(result.committedRevision).toBe(1);
      expect(fs.readFileSync(path.join(archived, 'feature.json'), 'utf8')).toBe(before);
      expect(service.read({ kind: 'feature', featureName: 'old' }).facts.featureStatus).toBe('archived');
    });

    it('refuses symbolic links anywhere on the storage path', () => {
      const outside = `${TEST_DIR}-outside`;
      fs.rmSync(outside, { recursive: true, force: true });
      fs.mkdirSync(outside, { recursive: true });
      try {
        fs.symlinkSync(outside, path.join(TEST_DIR, '.hive', 'worklogs'));
        const session: WorklogRef = { kind: 'session', owner: 'opencode-v1', sessionId: PRIMARY.sessionId };
        expectWorklogError(() => service.record(session, checkpoint('a'), PRIMARY), 'unsafe_path');
        expectWorklogError(() => service.read(session), 'unsafe_path');
        expect(fs.readdirSync(outside)).toEqual([]);

        fs.writeFileSync(path.join(outside, 'target.json'), '{}');
        fs.symlinkSync(path.join(outside, 'target.json'), path.join(featurePath, 'worklog.json'));
        expectWorklogError(() => service.read(FEATURE, { view: 'history' }), 'unsafe_path');
        expectWorklogError(() => service.record(FEATURE, checkpoint('a'), PRIMARY), 'unsafe_path');
        expect(fs.readFileSync(path.join(outside, 'target.json'), 'utf8')).toBe('{}');
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    describe('sources outside the log path', () => {
      const outside = `${TEST_DIR}-outside`;
      const leaked = (...values: unknown[]) => JSON.stringify(values).includes('SECRET');

      beforeEach(() => {
        fs.rmSync(outside, { recursive: true, force: true });
        fs.mkdirSync(outside, { recursive: true });
      });

      afterEach(() => {
        fs.rmSync(outside, { recursive: true, force: true });
      });

      it('reports facts unavailable instead of listing a tasks directory that is a symbolic link', () => {
        fs.mkdirSync(path.join(outside, '01-leak'));
        fs.writeFileSync(path.join(outside, '01-leak', 'status.json'), JSON.stringify({ status: 'done', origin: 'plan', planTitle: 'SECRET' }));
        fs.rmSync(path.join(featurePath, 'tasks'), { recursive: true });
        fs.symlinkSync(outside, path.join(featurePath, 'tasks'));

        const brief = service.read(FEATURE);
        const facts = service.read(FEATURE, { view: 'facts' });
        expect(brief.facts).toMatchObject({ state: 'unavailable', taskCount: 0, fingerprint: null });
        expect(facts).toMatchObject({ rows: [], complete: false, nextCursor: null });
        expect(leaked(brief, facts)).toBe(false);
        expect(service.record(FEATURE, checkpoint('a', 'x', { briefing: 'b', expectedRevision: 0 }), PRIMARY).entry.briefing).toEqual({
          text: 'b',
          factsFingerprint: null,
        });
      });

      it('treats a status file that is a symbolic link as an integrity problem and keeps the other rows', () => {
        writeTask(featurePath, '01-ok', { status: 'done', dependsOn: [] });
        fs.writeFileSync(path.join(outside, 'status.json'), JSON.stringify({ status: 'done', origin: 'plan', planTitle: 'SECRET' }));
        fs.mkdirSync(path.join(featurePath, 'tasks', '02-linked'));
        fs.symlinkSync(path.join(outside, 'status.json'), path.join(featurePath, 'tasks', '02-linked', 'status.json'));

        const facts = service.read(FEATURE, { view: 'facts' });
        expect(facts.facts).toMatchObject({ state: 'partial', taskCount: 2, counts: { done: 1, invalid: 1 } });
        expect(facts.rows.find((row) => row.folder === '01-ok')).toMatchObject({ status: 'done' });
        expect(facts.rows.find((row) => row.folder === '02-linked')).toMatchObject({ status: null, integrity: { reason: 'status_unreadable' } });
        expect(leaked(facts)).toBe(false);
      });

      it('resolves a feature without reading unrelated sibling metadata through a symbolic link', () => {
        fs.writeFileSync(path.join(outside, 'feature.json'), '{not json SECRET');
        fs.mkdirSync(path.join(FEATURES, '02_other'));
        fs.symlinkSync(path.join(outside, 'feature.json'), path.join(FEATURES, '02_other', 'feature.json'));
        // A plain unreadable sibling that does not name this feature does not block it either.
        fs.mkdirSync(path.join(FEATURES, '04_junk'));
        fs.writeFileSync(path.join(FEATURES, '04_junk', 'feature.json'), '{broken');

        expect(service.record(FEATURE, checkpoint('a'), PRIMARY).committedRevision).toBe(1);
        expect(service.read(FEATURE, { view: 'facts' }).facts.state).toBe('recorded');
        expect(service.list().errors).toEqual([]);
      });

      it('refuses a feature-name alias that is a symbolic link without following it, whether or not the target exists', () => {
        const existing = path.join(outside, 'existing-target');
        fs.mkdirSync(existing);
        fs.writeFileSync(path.join(existing, 'feature.json'), JSON.stringify({ name: 'SECRET', status: 'executing', createdAt: STAMP }));
        const alias = path.join(FEATURES, 'checkout');
        const outsideBefore = snapshotTree(outside);
        const featuresBefore = fs.readdirSync(FEATURES);

        for (const target of [existing, path.join(outside, 'dangling-target')]) {
          fs.rmSync(alias, { force: true });
          fs.symlinkSync(target, alias);
          for (const run of [
            () => service.read(FEATURE),
            () => service.read(FEATURE, { view: 'facts' }),
            () => service.record(FEATURE, checkpoint('a'), PRIMARY),
            () => getWorklogPath(TEST_DIR, FEATURE),
          ]) {
            expect(expectWorklogError(run, 'unsafe_path').details).toMatchObject({ path: '.hive/features/checkout' });
          }
        }
        fs.rmSync(alias);
        expect(fs.readdirSync(FEATURES)).toEqual(featuresBefore);
        expect(snapshotTree(outside)).toEqual(outsideBefore);
        expect(fs.existsSync(path.join(featurePath, 'worklog.json'))).toBe(false);
      });

      it('still reports ambiguity when an unindexed directory shadows the metadata match', () => {
        fs.mkdirSync(path.join(FEATURES, 'checkout'));
        fs.writeFileSync(path.join(FEATURES, 'checkout', 'feature.json'), JSON.stringify({ name: 'other', status: 'executing', createdAt: STAMP }));
        expectWorklogError(() => service.read(FEATURE), 'feature_ambiguous');
      });

      it('checks the storage path before the facts view probes for the log', () => {
        const session: WorklogRef = { kind: 'session', owner: 'opencode-v1', sessionId: PRIMARY.sessionId };
        const digest = crypto.createHash('sha256').update(PRIMARY.sessionId).digest('hex');
        fs.mkdirSync(path.join(outside, 'sessions', 'opencode-v1'), { recursive: true });
        fs.writeFileSync(path.join(outside, 'sessions', 'opencode-v1', `${digest}.json`), '{}');
        fs.symlinkSync(outside, path.join(TEST_DIR, '.hive', 'worklogs'));
        expectWorklogError(() => service.read(session, { view: 'facts' }), 'unsafe_path');

        fs.writeFileSync(path.join(outside, 'target.json'), '{}');
        fs.symlinkSync(path.join(outside, 'target.json'), path.join(featurePath, 'worklog.json'));
        expectWorklogError(() => service.read(FEATURE, { view: 'facts' }), 'unsafe_path');
      });
    });
  });

  describe('record', () => {
    it('creates the log on first record with the summary as default title and runtime author/time', () => {
      const clock = new WorklogService(TEST_DIR, { now: () => new Date('2026-03-04T05:06:07.000Z') });
      const result = clock.record(FEATURE, checkpoint('op-1', 'Schema landed', {
        checkpoint: {
          summary: 'Schema landed',
          detail: 'Line one\nLine two',
          references: [{ kind: 'path', path: 'docs/WORKLOG.md', label: 'design' }, { kind: 'url', url: 'https://example.com/pr/1' }],
        },
      }), PRIMARY);
      expect(result).toMatchObject({
        key: 'feature:checkout',
        committedRevision: 1,
        currentRevision: 1,
        replayed: false,
        briefingUpdated: false,
        entry: { id: 1, operationId: 'op-1', author: PRIMARY, recordedAt: '2026-03-04T05:06:07.000Z' },
      });
      const brief = service.read(FEATURE);
      expect(brief).toMatchObject({ exists: true, title: 'Schema landed', revision: 1, briefing: null, checkpointsSinceBriefing: 1 });
      expect(brief.recent.entries[0]!.checkpoint.references).toHaveLength(2);
      expect(JSON.parse(fs.readFileSync(path.join(featurePath, 'worklog.json'), 'utf8'))).toMatchObject({
        schemaVersion: 1,
        ref: FEATURE,
        revision: 1,
        briefingEntryId: null,
      });
    });

    it('rejects a stale briefing, an unknown correction, or a mismatched revision guard without writing', () => {
      service.record(FEATURE, checkpoint('op-1'), PRIMARY);
      const file = path.join(featurePath, 'worklog.json');
      const before = fs.readFileSync(file);

      const stale = expectWorklogError(
        () => service.record(FEATURE, checkpoint('op-2', 'brief', { briefing: 'Now', expectedRevision: 0 }), PRIMARY),
        'stale_revision',
      );
      expect(stale.details).toMatchObject({ expectedRevision: 0, currentRevision: 1 });
      expectWorklogError(() => service.record(FEATURE, {
        operationId: 'op-3',
        checkpoint: { summary: 'fix', corrects: [9] },
        briefing: 'Now',
        expectedRevision: 1,
      }, PRIMARY), 'invalid_correction');
      expectWorklogError(() => service.record(FEATURE, checkpoint('op-4', 'x', { expectedRevision: 1 }), PRIMARY), 'invalid_argument');
      expectWorklogError(() => service.record(FEATURE, checkpoint('op-5', 'x', { briefing: 'b' }), PRIMARY), 'invalid_argument');

      expect(fs.readFileSync(file)).toEqual(before);
      expect(service.read(FEATURE).revision).toBe(1);
    });

    it('updates the briefing atomically with its checkpoint and dereferences it from that entry', () => {
      service.record(FEATURE, checkpoint('op-1'), PRIMARY);
      const result = service.record(FEATURE, checkpoint('op-2', 'Reconciled', { briefing: 'Where things stand.', expectedRevision: 1 }), OTHER_PRIMARY);
      expect(result).toMatchObject({ committedRevision: 2, briefingUpdated: true });
      service.record(FEATURE, checkpoint('op-3'), PRIMARY);

      const brief = service.read(FEATURE);
      expect(brief.briefing).toMatchObject({ text: 'Where things stand.', entryId: 2, author: OTHER_PRIMARY });
      expect(brief.checkpointsSinceBriefing).toBe(1);
      const stored = JSON.parse(fs.readFileSync(path.join(featurePath, 'worklog.json'), 'utf8'));
      expect(stored.briefingEntryId).toBe(2);
      expect(stored).not.toHaveProperty('briefing');
    });

    it('replays a lost-response retry before the revision check and rejects a changed payload', () => {
      const request = checkpoint('op-brief', 'Briefed', { briefing: 'v1', expectedRevision: 0 });
      const first = service.record(FEATURE, request, PRIMARY);
      service.record(FEATURE, checkpoint('op-later'), OTHER_PRIMARY);

      // Same author session; a different agent name is not part of the identity.
      const retry = service.record(FEATURE, request, { ...PRIMARY, agent: 'hive-builder' });
      expect(retry).toMatchObject({ replayed: true, committedRevision: 1, currentRevision: 2, briefingUpdated: true });
      expect(retry.entry).toEqual(first.entry);

      const conflict = expectWorklogError(
        () => service.record(FEATURE, { ...request, briefing: 'v2' }, PRIMARY),
        'operation_conflict',
      );
      expect(conflict.details).toMatchObject({ entryId: 1 });
      expectWorklogError(() => service.record(FEATURE, { ...request, title: 'Briefed' }, PRIMARY), 'operation_conflict');

      // The same operationId from another session is a different operation.
      expect(service.record(FEATURE, checkpoint('op-brief'), { ...PRIMARY, sessionId: 'ses_third' }).committedRevision).toBe(3);
    });

    it('keeps the creation title and rejects a different one', () => {
      service.record(FEATURE, checkpoint('op-1', 'first', { title: 'Checkout rewrite' }), PRIMARY);
      expect(service.record(FEATURE, checkpoint('op-2', 'second', { title: 'Checkout rewrite' }), PRIMARY).committedRevision).toBe(2);
      expectWorklogError(() => service.record(FEATURE, checkpoint('op-3', 'third', { title: 'Renamed' }), PRIMARY), 'title_conflict');
      expect(service.read(FEATURE).title).toBe('Checkout rewrite');
    });

    it('links corrections to their originals without changing them', () => {
      service.record(FEATURE, checkpoint('op-1', 'Wrong claim'), PRIMARY);
      service.record(FEATURE, { operationId: 'op-2', checkpoint: { summary: 'Correction', corrects: [1] } }, PRIMARY);
      const history = service.read(FEATURE, { view: 'history' });
      expect(history.entries.map((entry) => [entry.id, entry.correctedBy ?? null])).toEqual([[2, null], [1, [2]]]);
      expect(history.entries[1]!.checkpoint.summary).toBe('Wrong claim');
      expectWorklogError(() => service.record(FEATURE, { operationId: 'op-3', checkpoint: { summary: 'x', corrects: [3] } }, PRIMARY), 'invalid_correction');
    });

    it('keeps session logs per owner and session, readable without the session index', () => {
      const v1: WorklogRef = { kind: 'session', owner: 'opencode-v1', sessionId: 'ses_same' };
      const v2: WorklogRef = { kind: 'session', owner: 'opencode-v2', sessionId: 'ses_same' };
      expectWorklogError(() => service.record(v1, checkpoint('a'), PRIMARY), 'author_mismatch');
      expectWorklogError(() => service.record(v1, checkpoint('a'), { ...PRIMARY, sessionId: 'ses_same', owner: 'opencode-v2' }), 'author_mismatch');

      service.record(v1, checkpoint('a', 'v1 work'), { ...PRIMARY, sessionId: 'ses_same' });
      service.record(v2, checkpoint('a', 'v2 work'), { ...OTHER_PRIMARY, sessionId: 'ses_same' });
      expect(fs.existsSync(path.join(TEST_DIR, '.hive', 'sessions.json'))).toBe(false);
      expect(service.read(v1).title).toBe('v1 work');
      expect(service.read(v2).title).toBe('v2 work');
      expect(service.read(v1).facts.state).toBe('not_applicable');
      expect(service.read(v1, { view: 'facts' })).toMatchObject({ rows: [], complete: true, nextCursor: null });
    });

    it('validates author shape, operation IDs, references, and byte bounds with full UTF-8', () => {
      const exact = '\u{1F600}'.repeat(64);
      expect(Buffer.byteLength(exact)).toBe(256);
      service.record(FEATURE, checkpoint('op-1', exact), PRIMARY);
      expect(service.read(FEATURE).recent.entries[0]!.checkpoint.summary).toBe(exact);

      expectWorklogError(() => service.record(FEATURE, checkpoint('op-2', `${exact}x`), PRIMARY), 'input_too_large');
      expectWorklogError(() => service.record(FEATURE, checkpoint('op-2', 'bad \ud800 surrogate'), PRIMARY), 'invalid_argument');
      expectWorklogError(() => service.record(FEATURE, checkpoint('op-2', 'two\nlines'), PRIMARY), 'invalid_argument');
      expectWorklogError(() => service.record(FEATURE, checkpoint('op 2'), PRIMARY), 'invalid_argument');
      expectWorklogError(() => service.record(FEATURE, checkpoint('op-2', 'x', { briefing: 'b'.repeat(4097), expectedRevision: 1 }), PRIMARY), 'input_too_large');
      expectWorklogError(() => service.record(FEATURE, checkpoint('op-2'), { ...PRIMARY, owner: 'opencode-v9' as never }), 'invalid_author');
      expectWorklogError(() => service.record(FEATURE, checkpoint('op-2'), { ...PRIMARY, agent: '' }), 'invalid_author');
      for (const reference of [
        { kind: 'path', path: '../outside' },
        { kind: 'path', path: '/etc/passwd' },
        { kind: 'path', path: 'docs/../../x' },
        { kind: 'path', path: 'C:\\x' },
        { kind: 'url', url: 'javascript:alert(1)' },
        { kind: 'url', url: 'https://user:pw@example.com' },
      ]) {
        expectWorklogError(() => service.record(FEATURE, { operationId: 'op-2', checkpoint: { summary: 's', references: [reference as never] } }, PRIMARY), 'invalid_argument');
      }
      expectWorklogError(() => service.record(FEATURE, {
        operationId: 'op-2',
        checkpoint: { summary: 's', references: Array.from({ length: 17 }, () => ({ kind: 'path' as const, path: 'a' })) },
      }, PRIMARY), 'input_too_large');
      expect(service.read(FEATURE).revision).toBe(1);
    });

    it('serializes concurrent appends from separate processes without losing entries', async () => {
      const serviceModule = new URL('./worklogService.ts', import.meta.url).href;
      const script = `
        import { WorklogService } from ${JSON.stringify(serviceModule)};
        const service = new WorklogService(process.env.PROJECT_ROOT);
        for (let i = 0; i < 5; i++) {
          service.record({ kind: 'feature', featureName: 'checkout' },
            { operationId: process.env.WRITER + '-' + i, checkpoint: { summary: 'from ' + process.env.WRITER } },
            { owner: 'opencode-v1', sessionId: process.env.WRITER, agent: 'hive-master' });
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

      const history = service.read(FEATURE, { view: 'history', limit: 50, maxBytes: WORKLOG_MAX_RESPONSE_BYTES });
      expect(history.currentRevision).toBe(20);
      expect(history.entries.map((entry) => entry.id)).toEqual(Array.from({ length: 20 }, (_, index) => 20 - index));
      expect(new Set(history.entries.map((entry) => `${entry.author.sessionId}/${entry.operationId}`)).size).toBe(20);
      expect(fs.existsSync(path.join(featurePath, 'worklog.json.lock'))).toBe(false);
    }, 30000);
  });

  describe('stored document integrity', () => {
    it('fails loudly on corrupt or future-schema logs and never resets them', () => {
      const file = path.join(featurePath, 'worklog.json');
      for (const [bytes, reason] of [
        ['{not json', 'worklog_corrupt'],
        [JSON.stringify({ schemaVersion: 2, ref: FEATURE }), 'unsupported_schema'],
        [JSON.stringify({ schemaVersion: 1, logId: '0'.repeat(32), ref: { kind: 'feature', featureName: 'other' }, title: 't', revision: 0, createdAt: 'x', updatedAt: 'x', briefingEntryId: null, entries: [] }), 'worklog_corrupt'],
      ] as const) {
        fs.writeFileSync(file, bytes);
        expectWorklogError(() => service.read(FEATURE), reason);
        expectWorklogError(() => service.record(FEATURE, checkpoint('op-1'), PRIMARY), reason);
        expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
      }
    });

    describe('persisted invariants', () => {
      const logFile = () => path.join(featurePath, 'worklog.json');
      type Doc = Record<string, any>;
      const forged = (id: number, extra: Doc = {}): Doc => ({
        id,
        operationId: `forged-${id}`,
        requestHash: '0'.repeat(64),
        author: PRIMARY,
        recordedAt: STAMP,
        checkpoint: { summary: 'forged' },
        ...extra,
      });
      const escaped = {
        summary: 's'.repeat(256),
        detail: '"'.repeat(8192),
        references: Array.from({ length: 16 }, () => ({ kind: 'url', url: `https://example.com/${'"'.repeat(1000)}`, label: '"'.repeat(256) })),
      };

      /** A genuine two-entry log: entry 1 carries the briefing, entry 2 corrects entry 1. */
      function seed(ref: WorklogRef = FEATURE, author: WorklogAuthor = PRIMARY): Doc {
        service.record(ref, checkpoint('op-1', 'first', { briefing: 'Briefing', expectedRevision: 0 }), author);
        service.record(ref, { operationId: 'op-2', checkpoint: { summary: 'second', corrects: [1] } }, author);
        return JSON.parse(fs.readFileSync(getWorklogPath(TEST_DIR, ref), 'utf8')) as Doc;
      }

      function expectCorruptEverywhere(ref: WorklogRef, doc: Doc, author: WorklogAuthor, label: string): void {
        const file = getWorklogPath(TEST_DIR, ref);
        fs.writeFileSync(file, JSON.stringify(doc, null, 2));
        const before = fs.readFileSync(file);
        const where = `[${label}]`;
        try {
          expectWorklogError(() => service.read(ref), 'worklog_corrupt');
          expectWorklogError(() => service.read(ref, { view: 'history' }), 'worklog_corrupt');
          expectWorklogError(() => service.record(ref, checkpoint('op-new'), author), 'worklog_corrupt');
          const listed = service.list();
          expect(listed.worklogs.map((summary) => summary.key)).not.toContain(getWorklogKey(ref));
          expect(listed.errors.map((error) => error.reason)).toEqual(['worklog_corrupt']);
        } catch (error) {
          throw new Error(`${where} ${(error as Error).message}`);
        }
        expect(fs.readFileSync(file)).toEqual(before);
        expect(fs.existsSync(`${file}.lock`)).toBe(false);
        expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp.'))).toEqual([]);
      }

      it('accepts a log at every retained limit', () => {
        const doc = seed();
        doc.entries[0].briefing.text = 'b'.repeat(4096);
        for (let id = 3; id <= 65; id++) doc.entries.push(forged(id, { checkpoint: { summary: 'fix', corrects: [1] } }));
        doc.entries[2].operationId = 'o'.repeat(128);
        doc.revision = doc.entries.length;
        doc.updatedAt = STAMP;
        fs.writeFileSync(logFile(), JSON.stringify(doc, null, 2));
        // Entry 1 is corrected exactly 64 times.
        let page = service.read(FEATURE, { view: 'history', limit: 50, maxBytes: WORKLOG_MAX_RESPONSE_BYTES });
        while (page.nextCursor) page = service.read(FEATURE, { view: 'history', limit: 50, maxBytes: WORKLOG_MAX_RESPONSE_BYTES, cursor: page.nextCursor });
        expect(page.entries.at(-1)!.correctedBy).toHaveLength(WORKLOG_CORRECTED_BY_MAX);
        expect(service.read(FEATURE).briefing!.text).toHaveLength(4096);
      });

      it('rejects stored fields that record-time validation would have refused, on every path, leaving bytes unchanged', () => {
        const cases: Array<[string, (doc: Doc) => void]> = [
          ['briefing past 4 KiB', (doc) => { doc.entries[0].briefing.text = 'b'.repeat(65536); }],
          ['blank briefing', (doc) => { doc.entries[0].briefing.text = '   '; }],
          ['briefing control character', (doc) => { doc.entries[0].briefing.text = 'a\u0000b'; }],
          ['briefing unpaired surrogate', (doc) => { doc.entries[0].briefing.text = 'a\ud800b'; }],
          ['briefing fingerprint not a digest', (doc) => { doc.entries[0].briefing.factsFingerprint = 'not-a-digest'; }],
          ['briefing fingerprint not a string', (doc) => { doc.entries[0].briefing.factsFingerprint = 7; }],
          ['operation ID past 128 bytes', (doc) => { doc.entries[1].operationId = 'o'.repeat(129); }],
          ['operation ID with a trailing newline', (doc) => { doc.entries[1].operationId = 'op-2\n'; }],
          ['blank title', (doc) => { doc.title = '  '; }],
          ['title past 256 bytes', (doc) => { doc.title = 't'.repeat(257); }],
          ['multiline title', (doc) => { doc.title = 'two\nlines'; }],
          ['entry timestamp not a timestamp', (doc) => { doc.entries[0].recordedAt = 'x'; }],
          ['entry timestamp not canonical', (doc) => { doc.entries[1].recordedAt = '2026-01-01'; }],
          ['createdAt not a timestamp', (doc) => { doc.createdAt = 'yesterday'; }],
          ['updatedAt not a timestamp', (doc) => { doc.updatedAt = 12; }],
          ['entry past 48 KiB once serialized', (doc) => { doc.entries[1].checkpoint = escaped; }],
          ['entry corrected more than 64 times', (doc) => {
            for (let id = 3; id <= 66; id++) doc.entries.push(forged(id, { checkpoint: { summary: 'fix', corrects: [1] } }));
            doc.revision = doc.entries.length;
          }],
          ['duplicate operation identity', (doc) => {
            doc.entries.push(forged(3, { operationId: 'op-1' }));
            doc.revision = 3;
          }],
        ];
        for (const [label, mutate] of cases) {
          fs.rmSync(logFile(), { force: true });
          const doc = seed();
          mutate(doc);
          expectCorruptEverywhere(FEATURE, doc, PRIMARY, label);
        }
      });

      it('rejects a session log holding an entry from another session', () => {
        const session: WorklogRef = { kind: 'session', owner: 'opencode-v1', sessionId: PRIMARY.sessionId };
        const doc = seed(session);
        doc.entries[1].author.sessionId = 'ses_intruder';
        expectCorruptEverywhere(session, doc, PRIMARY, 'foreign author in a session log');

        fs.rmSync(getWorklogPath(TEST_DIR, session));
        const wrongOwner = seed(session);
        wrongOwner.entries[0].author.owner = 'opencode-v2';
        expectCorruptEverywhere(session, wrongOwner, PRIMARY, 'foreign owner in a session log');
      });
    });

    it('rejects a log past the storage limit on read and a record that would cross it', () => {
      const detail = 'd'.repeat(8000);
      const entries = [];
      let id = 0;
      const base = { schemaVersion: 1, logId: 'a'.repeat(32), ref: FEATURE, title: 't', createdAt: STAMP, updatedAt: STAMP, briefingEntryId: null };
      const entry = (n: number) => ({
        id: n,
        operationId: `op-${n}`,
        requestHash: '0'.repeat(64),
        author: PRIMARY,
        recordedAt: STAMP,
        checkpoint: { summary: 's', detail },
      });
      while (true) {
        const next = entry(id + 1);
        const size = Buffer.byteLength(JSON.stringify({ ...base, revision: id + 1, entries: [...entries, next] }, null, 2));
        // Stop with less than one more entry of headroom, so the record below cannot fit.
        if (size > WORKLOG_LOG_MAX_BYTES) break;
        entries.push(next);
        id += 1;
      }
      const file = path.join(featurePath, 'worklog.json');
      fs.writeFileSync(file, JSON.stringify({ ...base, revision: id, entries }, null, 2));
      const before = fs.readFileSync(file);

      expect(service.read(FEATURE).revision).toBe(id);
      expectWorklogError(() => service.record(FEATURE, { operationId: 'big', checkpoint: { summary: 's', detail: 'd'.repeat(8192) } }, PRIMARY), 'worklog_full');
      expect(fs.readFileSync(file)).toEqual(before);

      fs.appendFileSync(file, ' '.repeat(WORKLOG_LOG_MAX_BYTES));
      expectWorklogError(() => service.read(FEATURE), 'worklog_too_large');
    }, 30000);
  });

  describe('read', () => {
    it('reports a missing feature log without creating anything and keeps all reads nonmutating', () => {
      const before = snapshotTree();
      const brief = service.read(FEATURE);
      expect(brief).toMatchObject({ exists: false, revision: 0, title: null, briefing: null, changedSinceBriefing: null, recent: { entries: [], nextCursor: null } });
      expect(brief.facts.state).toBe('recorded');
      expect(service.read({ kind: 'session', owner: 'opencode-v2', sessionId: 'ses_none' }).exists).toBe(false);
      service.list();
      expect(snapshotTree()).toEqual(before);

      service.record(FEATURE, checkpoint('op-1', 'x', { briefing: 'b', expectedRevision: 0 }), PRIMARY);
      const afterWrite = snapshotTree();
      service.read(FEATURE);
      service.read(FEATURE, { view: 'history' });
      service.read(FEATURE, { view: 'facts' });
      service.list({ kind: 'feature' });
      expect(snapshotTree()).toEqual(afterWrite);
    });

    it('anchors history pages so appends do not shift them and rejects replaced files or foreign cursors', () => {
      for (let index = 1; index <= 5; index++) service.record(FEATURE, checkpoint(`op-${index}`), PRIMARY);
      const first = service.read(FEATURE, { view: 'history', limit: 2 });
      expect(first.entries.map((entry) => entry.id)).toEqual([5, 4]);

      service.record(FEATURE, checkpoint('op-6'), PRIMARY);
      const second = service.read(FEATURE, { view: 'history', limit: 2, cursor: first.nextCursor! });
      expect(second).toMatchObject({ anchorRevision: 5, currentRevision: 6, complete: false });
      expect(second.entries.map((entry) => entry.id)).toEqual([3, 2]);
      const third = service.read(FEATURE, { view: 'history', limit: 2, cursor: second.nextCursor! });
      expect(third).toMatchObject({ complete: true, nextCursor: null });
      expect(third.entries.map((entry) => entry.id)).toEqual([1]);

      const brief = service.read(FEATURE, { limit: 1 });
      expect(brief.recent.entries.map((entry) => entry.id)).toEqual([6]);
      expect(service.read(FEATURE, { view: 'history', cursor: brief.recent.nextCursor! }).entries[0]!.id).toBe(5);

      expectWorklogError(() => service.read({ kind: 'session', owner: 'opencode-v1', sessionId: 'x' }, { view: 'history', cursor: first.nextCursor! }), 'invalid_cursor');
      expectWorklogError(() => service.read(FEATURE, { view: 'history', cursor: 'garbage' }), 'invalid_cursor');
      expectWorklogError(() => service.read(FEATURE, { view: 'facts', cursor: first.nextCursor! }), 'invalid_cursor');
      expectWorklogError(() => service.read(FEATURE, { cursor: first.nextCursor! }), 'invalid_argument');

      fs.rmSync(path.join(featurePath, 'worklog.json'));
      service.record(FEATURE, checkpoint('op-new'), PRIMARY);
      expectWorklogError(() => service.read(FEATURE, { view: 'history', cursor: second.nextCursor! }), 'stale_cursor');
    });

    it('enforces request bounds and response budgets, including the envelope', () => {
      for (const options of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { maxBytes: 0 }, { maxBytes: WORKLOG_MAX_RESPONSE_BYTES + 1 }]) {
        expectWorklogError(() => service.read(FEATURE, { view: 'history', ...options }), 'invalid_argument');
        expectWorklogError(() => service.list(options), 'invalid_argument');
      }
      const maximal = {
        summary: 's'.repeat(256),
        detail: '"'.repeat(8192),
        references: Array.from({ length: 16 }, () => ({ kind: 'path' as const, path: 'p'.repeat(1024), label: 'l'.repeat(256) })),
      };
      service.record(FEATURE, { operationId: 'big', checkpoint: maximal, briefing: '"'.repeat(4096), expectedRevision: 0 }, PRIMARY);

      const tooSmall = expectWorklogError(() => service.read(FEATURE, { view: 'history' }), 'response_too_large');
      expect(tooSmall.details.requiredBytes).toBeGreaterThan(16 * 1024);
      const page = service.read(FEATURE, { view: 'history', maxBytes: WORKLOG_MAX_RESPONSE_BYTES });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(WORKLOG_MAX_RESPONSE_BYTES);
      expect(page.entries[0]!.checkpoint).toEqual(maximal);

      // The brief keeps its briefing and truncates its recent page by budget instead of failing.
      const brief = service.read(FEATURE);
      expect(brief.briefing!.text).toBe('"'.repeat(4096));
      expect(brief.recent.entries).toEqual([]);
      expect(brief.recent.nextCursor).not.toBeNull();
      expect(Buffer.byteLength(JSON.stringify(brief))).toBeLessThanOrEqual(16 * 1024);

      // JSON escaping can push fields that are each within limits past one page; such an entry is refused.
      const escaped = { ...maximal, references: maximal.references.map(() => ({ kind: 'url' as const, url: `https://example.com/${'"'.repeat(1000)}`, label: '"'.repeat(256) })) };
      const refused = expectWorklogError(() => service.record(FEATURE, { operationId: 'escaped', checkpoint: escaped }, PRIMARY), 'input_too_large');
      expect(refused.details.maxBytes).toBe(WORKLOG_ENTRY_MAX_BYTES);
      expect(service.read(FEATURE).revision).toBe(1);
    });

    it('caps corrections per entry so a correctedBy list cannot outgrow a page', () => {
      service.record(FEATURE, checkpoint('original'), PRIMARY);
      for (let index = 0; index < WORKLOG_CORRECTED_BY_MAX; index++) {
        service.record(FEATURE, { operationId: `fix-${index}`, checkpoint: { summary: 'fix', corrects: [1] } }, PRIMARY);
      }
      const error = expectWorklogError(() => service.record(FEATURE, { operationId: 'one-more', checkpoint: { summary: 'fix', corrects: [1] } }, PRIMARY), 'invalid_correction');
      expect(error.details).toMatchObject({ entryId: 1, maxCorrections: WORKLOG_CORRECTED_BY_MAX });
      let page = service.read(FEATURE, { view: 'history', limit: 50 });
      while (page.nextCursor) page = service.read(FEATURE, { view: 'history', limit: 50, cursor: page.nextCursor });
      expect(page.entries.at(-1)).toMatchObject({ id: 1 });
      expect(page.entries.at(-1)!.correctedBy).toHaveLength(WORKLOG_CORRECTED_BY_MAX);
    });
  });

  describe('recorded facts', () => {
    beforeEach(() => {
      writeTask(featurePath, '01-schema', { status: 'done', dependsOn: [] });
      writeTask(featurePath, '02-api', { status: 'pending', dependsOn: ['01-schema'] });
      writeTask(featurePath, '03-ui', { status: 'pending', dependsOn: ['02-api'] });
      writeTask(featurePath, '04-docs', { status: 'blocked', dependsOn: [], blocker: { reason: 'Needs a decision', options: ['a', 'b'] } });
      writeTask(featurePath, '05-lost', null);
    });

    it('summarizes stored task state separately from narrative, with integrity entries kept honest', () => {
      const brief = service.read(FEATURE);
      expect(brief.facts).toMatchObject({
        state: 'partial',
        featureStatus: 'executing',
        taskCount: 5,
        counts: { done: 1, pending: 2, blocked: 1, invalid: 1, in_progress: 0 },
        runnableCount: 1,
        dependencyBlockedCount: 1,
      });
      expect(brief.facts.notice).toContain('does not establish worker liveness');
      expect(brief.facts.fingerprint).toMatch(/^[0-9a-f]{64}$/);

      const facts = service.read(FEATURE, { view: 'facts', limit: 50 });
      const byFolder = Object.fromEntries(facts.rows.map((row) => [row.folder, row]));
      expect(byFolder['02-api']).toMatchObject({ runnable: true, waitingOn: [] });
      expect(byFolder['03-ui']).toMatchObject({ runnable: false, waitingOn: ['02-api'] });
      expect(byFolder['04-docs']).toMatchObject({ status: 'blocked', blocker: { reason: 'Needs a decision', truncated: true } });
      expect(byFolder['05-lost']).toMatchObject({ status: null, integrity: { reason: 'status_missing' } });
      expect(byFolder['01-schema']!.sources.status).toBe('.hive/features/01_checkout/tasks/01-schema/status.json');
    });

    it('marks the briefing changed when recorded facts move and invalidates facts cursors', () => {
      service.record(FEATURE, checkpoint('op-1', 'x', { briefing: 'State at revision 0', expectedRevision: 0 }), PRIMARY);
      expect(service.read(FEATURE).changedSinceBriefing).toBe(false);
      const page = service.read(FEATURE, { view: 'facts', limit: 2 });
      expect(page.nextCursor).not.toBeNull();

      writeTask(featurePath, '02-api', { status: 'in_progress', dependsOn: ['01-schema'] });
      expect(service.read(FEATURE).changedSinceBriefing).toBe(true);
      expectWorklogError(() => service.read(FEATURE, { view: 'facts', cursor: page.nextCursor! }), 'stale_cursor');
    });

    it('reports malformed task records as integrity rows and keeps the valid rows and the projection', () => {
      writeTask(featurePath, '06-string-deps', { status: 'pending', dependsOn: '01-schema' });
      writeTask(featurePath, '07-numeric-dep', { status: 'pending', dependsOn: [1] });
      writeTask(featurePath, '08-null-deps', { status: 'pending', dependsOn: null });
      writeTask(featurePath, '09-plan-title', { status: 'pending', dependsOn: [], planTitle: 7 });
      writeTask(featurePath, '10-blocker', { status: 'blocked', dependsOn: [], blocker: 'needs input' });
      // A legacy record without dependsOn is still valid and has no dependencies.
      writeTask(featurePath, '11-legacy', { status: 'pending' });

      const brief = service.read(FEATURE);
      expect(brief.facts).toMatchObject({ state: 'partial', taskCount: 11, runnableCount: 2, dependencyBlockedCount: 1 });
      expect(brief.facts.counts).toMatchObject({ done: 1, pending: 3, blocked: 1, invalid: 6 });

      const facts = service.read(FEATURE, { view: 'facts', limit: 50 });
      const byFolder = Object.fromEntries(facts.rows.map((row) => [row.folder, row]));
      for (const folder of ['06-string-deps', '07-numeric-dep', '08-null-deps', '09-plan-title', '10-blocker']) {
        expect(byFolder[folder]).toMatchObject({ status: null, dependsOn: [], integrity: { reason: 'status_unreadable' } });
      }
      expect(byFolder['11-legacy']).toMatchObject({ status: 'pending', dependsOn: [], runnable: true });
      expect(byFolder['02-api']).toMatchObject({ runnable: true });
      expect(service.record(FEATURE, checkpoint('op-1', 'x', { briefing: 'b', expectedRevision: 0 }), PRIMARY).entry.briefing!.factsFingerprint)
        .toMatch(/^[0-9a-f]{64}$/);
    });

    describe('optional source links', () => {
      const ioFailure = (code: string) => Object.assign(new Error(`${code}: injected failure`), { code });
      /** Fails every `lstat` under one task folder that `matches` selects, as an unreadable directory would. */
      const failProbes = (folder: string, matches: (target: string) => boolean) => {
        const original = fs.lstatSync as (...args: unknown[]) => unknown;
        const taskDir = path.join(featurePath, 'tasks', folder) + path.sep;
        return spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
          if (String(target).startsWith(taskDir) && matches(String(target))) throw ioFailure('EACCES');
          return original(target, ...rest);
        }) as typeof fs.lstatSync);
      };

      it('keeps the other rows and the briefing flow when one task directory cannot be read at all', () => {
        writeTask(featurePath, '06-locked', { status: 'done', dependsOn: [] });
        const probes = failProbes('06-locked', () => true);
        try {
          const brief = service.read(FEATURE);
          expect(brief.facts).toMatchObject({ state: 'partial', taskCount: 6, counts: { done: 1, pending: 2, blocked: 1, invalid: 2 } });
          expect(brief.facts.diagnostics.some((line) => line.includes('06-locked'))).toBe(true);

          const facts = service.read(FEATURE, { view: 'facts', limit: 50 });
          expect(facts.rows.find((row) => row.folder === '06-locked')).toMatchObject({
            status: null,
            integrity: { reason: 'status_unreadable' },
            sources: { status: '.hive/features/01_checkout/tasks/06-locked/status.json' },
          });
          expect(facts.rows.find((row) => row.folder === '06-locked')!.sources).not.toHaveProperty('report');
          expect(facts.rows.find((row) => row.folder === '01-schema')).toMatchObject({ status: 'done' });

          const recorded = service.record(FEATURE, checkpoint('op-1', 'x', { briefing: 'b', expectedRevision: 0 }), PRIMARY);
          expect(recorded.entry.briefing!.factsFingerprint).toMatch(/^[0-9a-f]{64}$/);
        } finally {
          probes.mockRestore();
        }
      });

      it('keeps a healthy row when only its optional source links cannot be checked, and says so', () => {
        fs.rmSync(path.join(featurePath, 'tasks', '05-lost'), { recursive: true });
        fs.writeFileSync(path.join(featurePath, 'tasks', '02-api', 'report.md'), 'report');
        const probes = failProbes('02-api', (target) => target.endsWith('report.md') || target.endsWith('spec.md'));
        try {
          const brief = service.read(FEATURE);
          expect(brief.facts).toMatchObject({ state: 'recorded', taskCount: 4, counts: { invalid: 0 }, runnableCount: 1 });
          expect(brief.facts.diagnostics).toEqual([expect.stringContaining('02-api')]);

          const facts = service.read(FEATURE, { view: 'facts', limit: 50 });
          const row = facts.rows.find((candidate) => candidate.folder === '02-api')!;
          expect(row).toMatchObject({ status: 'pending', runnable: true });
          expect(row.sources).toEqual({ status: '.hive/features/01_checkout/tasks/02-api/status.json' });
          expect(service.record(FEATURE, checkpoint('op-1', 'x', { briefing: 'b', expectedRevision: 0 }), PRIMARY).briefingUpdated).toBe(true);
        } finally {
          probes.mockRestore();
        }
        // Once the probe works again the pointer returns; the fingerprint never covered source links.
        expect(service.read(FEATURE, { view: 'facts', limit: 50 }).rows.find((row) => row.folder === '02-api')!.sources.report)
          .toBe('.hive/features/01_checkout/tasks/02-api/report.md');
        expect(service.read(FEATURE).changedSinceBriefing).toBe(false);
      });
    });

    it('reports unavailable facts as unknown instead of an empty task list', () => {
      fs.rmSync(path.join(featurePath, 'tasks'), { recursive: true });
      fs.writeFileSync(path.join(featurePath, 'tasks'), 'not a directory');
      service.record(FEATURE, checkpoint('op-1', 'x', { briefing: 'b', expectedRevision: 0 }), PRIMARY);
      const brief = service.read(FEATURE);
      expect(brief.facts).toMatchObject({ state: 'unavailable', fingerprint: null });
      expect(brief.facts.diagnostics[0]).toContain('could not be listed');
      expect(brief.changedSinceBriefing).toBeNull();
      expect(service.read(FEATURE, { view: 'facts' })).toMatchObject({ rows: [], complete: false, nextCursor: null });
    });
  });

  describe('list', () => {
    it('lists feature and session logs newest first, filters by kind, and reports unreadable logs beside good ones', () => {
      setupFeature('02_billing', 'billing');
      setupFeature('03_broken', 'broken');
      service.record({ kind: 'feature', featureName: 'billing' }, checkpoint('a', 'Billing'), PRIMARY);
      service.record(FEATURE, checkpoint('a', 'Checkout'), PRIMARY);
      const session: WorklogRef = { kind: 'session', owner: 'opencode-v2', sessionId: OTHER_PRIMARY.sessionId };
      service.record(session, checkpoint('a', 'Ad hoc'), OTHER_PRIMARY);
      fs.writeFileSync(path.join(FEATURES, '03_broken', 'worklog.json'), '{oops');
      const times = [['02_billing', 1], ['01_checkout', 2], ['03_broken', 3]] as const;
      for (const [directory, offset] of times) {
        const when = new Date(Date.UTC(2026, 0, 1, 0, offset));
        fs.utimesSync(path.join(FEATURES, directory, 'worklog.json'), when, when);
      }
      fs.utimesSync(getWorklogPath(TEST_DIR, session), new Date(Date.UTC(2026, 0, 1, 0, 4)), new Date(Date.UTC(2026, 0, 1, 0, 4)));

      const all = service.list();
      expect(all.worklogs.map((summary) => summary.key)).toEqual(['session:opencode-v2:ses_other', 'feature:checkout', 'feature:billing']);
      expect(all.errors).toEqual([{ location: '.hive/features/03_broken/worklog.json', reason: 'worklog_corrupt', message: expect.any(String) }]);
      expect(all.complete).toBe(true);
      expect(all.worklogs[1]).toMatchObject({ title: 'Checkout', revision: 1, entryCount: 1, briefingEntryId: null, location: '.hive/features/01_checkout/worklog.json' });
      expect(service.list({ kind: 'session' }).worklogs.map((summary) => summary.key)).toEqual(['session:opencode-v2:ses_other']);
    });

    it('pages a stable inventory and invalidates the cursor when the inventory changes', () => {
      setupFeature('02_billing', 'billing');
      service.record(FEATURE, checkpoint('a'), PRIMARY);
      service.record({ kind: 'feature', featureName: 'billing' }, checkpoint('a'), PRIMARY);
      const first = service.list({ limit: 1 });
      expect(first.worklogs).toHaveLength(1);
      const second = service.list({ limit: 1, cursor: first.nextCursor! });
      expect(second).toMatchObject({ complete: true, nextCursor: null });
      expect(new Set([...first.worklogs, ...second.worklogs].map((summary) => summary.key)).size).toBe(2);

      expectWorklogError(() => service.list({ kind: 'feature', cursor: first.nextCursor! }), 'invalid_cursor');
      service.record(FEATURE, checkpoint('b'), PRIMARY);
      expectWorklogError(() => service.list({ limit: 1, cursor: first.nextCursor! }), 'stale_cursor');
    });
  });

  describe('I/O failures', () => {
    const ioFailure = (code: string) => Object.assign(new Error(`${code}: injected failure`), { code });
    const logFile = () => path.join(featurePath, 'worklog.json');
    const strays = () => fs.readdirSync(featurePath).filter((name) => name.includes('.tmp.') || name.endsWith('.lock'));
    /** Only a failed write can have published; every earlier stage carries no `publication`. */
    const notPublished = (error: WorklogError) => {
      expect(error.details).not.toHaveProperty('publication');
      return error.details;
    };

    it('reports a write that failed before publishing as io_error with uncertain publication, and a retry commits it', () => {
      const request = checkpoint('op-1', 'First');
      const renameSpy = spyOn(fs, 'renameSync').mockImplementation((() => { throw ioFailure('EIO'); }) as typeof fs.renameSync);
      let error: WorklogError;
      try {
        error = expectWorklogError(() => service.record(FEATURE, request, PRIMARY), 'io_error');
      } finally {
        renameSpy.mockRestore();
      }
      expect(error.details).toMatchObject({ stage: 'write', code: 'EIO', publication: 'uncertain' });
      expect(fs.existsSync(logFile())).toBe(false);
      expect(strays()).toEqual([]);

      expect(service.record(FEATURE, request, PRIMARY)).toMatchObject({ replayed: false, committedRevision: 1 });
    });

    it('reports a directory flush that failed after the rename as io_error, keeps the entry, and replays it on retry', () => {
      if (process.platform === 'win32') return;
      service.record(FEATURE, checkpoint('op-0', 'Existing'), PRIMARY);
      const request = checkpoint('op-1', 'Published before the flush failed');
      const originalFsync = fs.fsyncSync;
      let flushes = 0;
      // writeAtomicDurable flushes the temporary file, renames it, then flushes the directory.
      const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(((descriptor: number) => {
        flushes += 1;
        if (flushes === 2) throw ioFailure('EIO');
        originalFsync(descriptor);
      }) as typeof fs.fsyncSync);
      let error: WorklogError;
      try {
        error = expectWorklogError(() => service.record(FEATURE, request, PRIMARY), 'io_error');
      } finally {
        fsyncSpy.mockRestore();
      }
      expect(flushes).toBe(2);
      expect(error.details).toMatchObject({ stage: 'write', publication: 'uncertain' });
      expect(strays()).toEqual([]);
      expect(service.read(FEATURE).recent.entries[0]).toMatchObject({ id: 2, operationId: 'op-1' });

      const retry = service.record(FEATURE, request, PRIMARY);
      expect(retry).toMatchObject({ replayed: true, committedRevision: 2, currentRevision: 2 });
      expect(service.read(FEATURE).revision).toBe(2);
    });

    it('reports read, lock, path, and discovery failures as io_error without publishing', () => {
      service.record(FEATURE, checkpoint('op-0', 'Existing'), PRIMARY);
      const before = fs.readFileSync(logFile());

      const originalRead = fs.readFileSync as (...args: unknown[]) => unknown;
      const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (String(target).endsWith('worklog.json')) throw ioFailure('EIO');
        return originalRead(target, ...rest);
      }) as typeof fs.readFileSync);
      try {
        expect(notPublished(expectWorklogError(() => service.read(FEATURE), 'io_error'))).toMatchObject({ stage: 'read', code: 'EIO' });
        expect(notPublished(expectWorklogError(() => service.record(FEATURE, checkpoint('op-1'), PRIMARY), 'io_error')))
          .toMatchObject({ stage: 'read' });
        expect(service.list().errors).toEqual([{ location: '.hive/features/01_checkout/worklog.json', reason: 'io_error', message: expect.any(String) }]);
      } finally {
        readSpy.mockRestore();
      }

      const originalOpen = fs.openSync as (...args: unknown[]) => number;
      const openSpy = spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
        if (String(target).endsWith('.lock')) throw ioFailure('EACCES');
        return originalOpen(target, ...rest);
      }) as typeof fs.openSync);
      try {
        expect(notPublished(expectWorklogError(() => service.record(FEATURE, checkpoint('op-1'), PRIMARY), 'io_error')))
          .toMatchObject({ stage: 'lock', code: 'EACCES' });
      } finally {
        openSpy.mockRestore();
      }

      // A regular file where the worklogs directory belongs makes the storage path unreadable, not unsafe.
      fs.writeFileSync(path.join(TEST_DIR, '.hive', 'worklogs'), 'not a directory');
      const session: WorklogRef = { kind: 'session', owner: 'opencode-v1', sessionId: PRIMARY.sessionId };
      expect(notPublished(expectWorklogError(() => service.read(session), 'io_error'))).toMatchObject({ stage: 'path', code: 'ENOTDIR' });
      expect(notPublished(expectWorklogError(() => service.record(session, checkpoint('op-1'), PRIMARY), 'io_error')))
        .toMatchObject({ stage: 'path' });
      expect(expectWorklogError(() => service.list(), 'io_error').details).toMatchObject({ stage: 'path' });

      fs.rmSync(path.join(TEST_DIR, '.hive', 'worklogs'));
      fs.mkdirSync(path.join(TEST_DIR, '.hive', 'worklogs', 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(TEST_DIR, '.hive', 'worklogs', 'sessions', 'opencode-v1'), 'not a directory');
      expect(expectWorklogError(() => service.list(), 'io_error').details).toMatchObject({ stage: 'discover', code: 'ENOTDIR' });

      expect(fs.readFileSync(logFile())).toEqual(before);
      expect(strays()).toEqual([]);
    });
  });
});
