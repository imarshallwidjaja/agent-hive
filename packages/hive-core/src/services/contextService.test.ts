import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ContextService } from './contextService.js';
import { getProjectContextPath } from '../utils/paths.js';

const TEST_DIR = '/tmp/hive-core-contextservice-services-test-' + process.pid;
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

function durable(body: string, description = 'Test context'): string {
  return `---\ndescription: ${description}\nread_when: Read when testing managed context.\n---\n\n${body}`;
}

function seedLegacy(featureName: string, name: string, content: string): void {
  const directory = path.join(TEST_DIR, '.hive/features', featureName, 'context');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.md`), content);
}

function projectDurable(body: string, reviewAfter = '2026-09-30'): string {
  return `---\ndescription: Project context\nread_when: Read for project-wide decisions.\nowner: platform\nreview_after: ${reviewAfter}\n---\n\n${body}`;
}

describe('ContextService reserved overview context', () => {
  let service: ContextService;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    service = new ContextService(PROJECT_ROOT);
  });

  afterEach(() => {
    cleanup();
  });

  it('admits catalog candidates with their actual continuation envelope near the byte cap', () => {
    setupFeature('catalog-boundary');
    const query = 'q'.repeat(1024);
    for (let index = 0; index < 7; index++) {
      service.create('catalog-boundary', `note-${index}`, durable('body', query + 'x'.repeat(6200)));
    }
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = service.readCatalog('catalog-boundary', { query, cursor });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16 * 1024);
      expect(page.files.length).toBeGreaterThan(0);
      names.push(...page.files.map(file => file.name));
      cursor = page.nextCursor;
      expect(page.complete).toBe(cursor === undefined);
    } while (cursor);
    expect(names).toEqual(Array.from({ length: 7 }, (_, index) => `note-${index}`));
  });

  it('defaults catalog pages to ten and caps requested pages at fifty', () => {
    setupFeature('page-limits');
    for (let index = 0; index < 65; index++) service.create('page-limits', `n${index}`, durable(''));
    expect(service.readCatalog('page-limits').files).toHaveLength(10);
    // Response-size admission may impose a tighter bound than the entry limit.
    expect(service.readCatalog('page-limits', { limit: 1000 }).files.length).toBeLessThanOrEqual(50);
  });

  it.each(['{', '{"schemaVersion":99,"revision":7,"entries":{}}'])('reports invalid index control evidence without classification: %s', raw => {
    setupFeature('recovery-invalid');
    const directory = path.join(TEST_DIR, '.hive/features/recovery-invalid/context');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'index.json'), raw);
    fs.writeFileSync(path.join(directory, 'notes.md'), 'preserved');
    const result = service.readRecoverySummary('recovery-invalid', { diagnosticMode: 'primary-management' });
    expect(result).toMatchObject({ code: 'context_index_invalid', revision: raw === '{' ? null : 7 });
    expect(result.control.indexErrors.length).toBeGreaterThan(0);
    expect(result.recoveryInstructions.length).toBeGreaterThan(0);
    expect(result.unclassified[0]).not.toHaveProperty('kind');
    expect(fs.readFileSync(path.join(directory, 'index.json'), 'utf8')).toBe(raw);
  });

  it('bounds recovery inventories by serialized bytes while retaining control evidence', () => {
    setupFeature('recovery-large');
    const directory = path.join(TEST_DIR, '.hive/features/recovery-large/context');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'index.json'), '{');
    const marker = {
      schemaVersion: 1, operation: 'create', startedAt: '2026-09-12T00:00:00.000Z',
      startingRevision: 0, startingIndexDigest: 'missing',
      names: Array.from({ length: 1000 }, () => '\u0000'.repeat(1000)),
      archiveDestinations: Array.from({ length: 1000 }, () => '\u0000'.repeat(1000)),
    };
    fs.writeFileSync(path.join(directory, '.managed-mutation-pending.json'), JSON.stringify(marker));
    for (let index = 0; index < 1000; index++) fs.writeFileSync(path.join(directory, `note-${index}.md`), 'raw');
    const result = service.readRecoverySummary('recovery-large', { diagnosticMode: 'primary-management' });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
    expect(result.complete).toBe(false);
    expect(result.totalFiles).toBe(1000);
    expect(result.code).toBe('context_reconciliation_required');
    expect(result.control.indexErrors.length).toBeGreaterThan(0);
    expect(result.pendingMutation).toMatchObject({ totalNames: 1000, totalArchiveDestinations: 1000, complete: false });
  });

  it('reports a pending create before publication without inventing a revision or classification', () => {
    setupFeature('pending-create');
    const directory = path.join(TEST_DIR, '.hive/features/pending-create/context');
    fs.mkdirSync(directory);
    const marker = {
      schemaVersion: 1, operation: 'create', names: ['notes'], archiveDestinations: [],
      startedAt: '2026-09-12T00:00:00.000Z', startingRevision: 0, startingIndexDigest: 'missing',
    };
    const markerPath = path.join(directory, '.managed-mutation-pending.json');
    const bytes = JSON.stringify(marker);
    fs.writeFileSync(markerPath, bytes);
    expect(service.readRecoverySummary('pending-create', { diagnosticMode: 'primary-management' })).toMatchObject({
      code: 'context_reconciliation_required', revision: null, unclassified: [], complete: true,
      control: { indexPresent: false, indexErrors: [], markerErrors: [] },
      pendingMutation: { operation: 'create', names: ['notes'], archiveDestinations: [],
        startedAt: marker.startedAt, startingRevision: 0, startingIndexDigest: 'missing', complete: true },
    });
    expect(fs.readFileSync(markerPath, 'utf8')).toBe(bytes);
    expect(fs.readdirSync(directory)).toEqual(['.managed-mutation-pending.json']);
  });

  it('inspects absent and read-only context without filesystem writes or lock acquisition', () => {
    setupFeature('inspection');
    const contextPath = path.join(TEST_DIR, '.hive/features/inspection/context');
    const before = fs.readdirSync(path.dirname(contextPath));
    expect(service.inspectSummary('inspection').status).toBe('ready');
    expect(fs.readdirSync(path.dirname(contextPath))).toEqual(before);
    expect(fs.existsSync(contextPath)).toBe(false);
    service.create('inspection', 'notes', durable('é😀'));
    service.create('inspection', 'proof', 'evidence', { kind: 'evidence' });
    const originalOpen = fs.openSync;
    let writerOpens = 0;
    const open = spyOn(fs, 'openSync').mockImplementation(((file, flags, mode) => {
      if (typeof flags === 'number' && (flags & fs.constants.O_EXCL)) writerOpens += 1;
      return originalOpen(file, flags, mode);
    }) as typeof fs.openSync);
    fs.chmodSync(contextPath, 0o555);
    try {
      const snapshot = service.inspectSummary('inspection');
      expect(snapshot.status).toBe('ready');
      if (snapshot.status !== 'ready') throw new Error('Expected snapshot');
      expect(snapshot.summary.durable.chars).toBe(durable('é😀').length);
      expect(snapshot.summary.files.find(file => file.name === 'notes')?.bytes).toBe(Buffer.byteLength(durable('é😀')));
      expect(snapshot.summary.files.find(file => file.name === 'proof')?.includeInExecution).toBe(false);
      expect(writerOpens).toBe(0);
    } finally { open.mockRestore(); fs.chmodSync(contextPath, 0o755); }
    fs.writeFileSync(path.join(contextPath, 'index.json.lock'), 'writer');
    expect(service.inspectSummary('inspection')).toEqual({ status: 'busy' });
  });

  it('rejects unstable inspection snapshots and transient missing files without partial results', () => {
    setupFeature('inspection');
    service.create('inspection', 'proof', 'evidence', { kind: 'evidence' });
    const original = fs.openSync;
    let reads = 0;
    const read = spyOn(fs, 'openSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file).endsWith('proof.md')) {
        reads++;
        throw Object.assign(new Error('moved by archive'), { code: 'ENOENT' });
      }
      return (original as any)(file, ...args);
    }) as typeof fs.openSync);
    try {
      expect(service.inspectSummary('inspection')).toEqual({ status: 'busy' });
      expect(reads).toBe(1);
    } finally { read.mockRestore(); }
    let indexReads = 0;
    const originalRead = fs.readFileSync;
    const changing = spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      const value = (originalRead as any)(file, ...args);
      if (String(file).endsWith('index.json')) return Buffer.from(JSON.stringify({ ...JSON.parse(value), revision: ++indexReads }));
      return value;
    }) as any);
    try { expect(service.inspectSummary('inspection')).toEqual({ status: 'busy' }); }
    finally { changing.mockRestore(); }
  });

  it('rejects invalid inspection index shapes without writes or lock acquisition', () => {
    setupFeature('inspection');
    service.create('inspection', 'notes', durable('preserved'));
    const contextPath = path.join(TEST_DIR, '.hive/features/inspection/context');
    const indexPath = path.join(contextPath, 'index.json');
    for (const value of [null, [], 1, 'index', { schemaVersion: 1, revision: 0, entries: [] }]) {
      const text = JSON.stringify(value);
      fs.writeFileSync(indexPath, text);
      const open = spyOn(fs, 'openSync');
      const write = spyOn(fs, 'writeFileSync');
      try {
        expect(() => service.inspectSummary('inspection')).toThrow('Context index');
        expect(open).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
      } finally { open.mockRestore(); write.mockRestore(); }
      expect(fs.readFileSync(indexPath, 'utf8')).toBe(text);
      expect(fs.readFileSync(path.join(contextPath, 'notes.md'), 'utf8')).toBe(durable('preserved'));
    }
  });

  it('classifies overview as reserved operational context', () => {
    const featureName = 'reserved-overview';
    setupFeature(featureName);

    seedLegacy(featureName, 'overview', 'Human-facing summary');
    seedLegacy(featureName, 'decisions', 'Technical decisions');

    expect(service.list(featureName).map((file) => [
      file.name,
      file.role,
      file.includeInExecution,
      file.includeInNetwork,
    ])).toEqual([
      ['decisions', 'durable', true, true],
      ['overview', 'operational', false, false],
    ]);
  });

  it('excludes overview from execution context listings', () => {
    const featureName = 'execution-context';
    setupFeature(featureName);

    seedLegacy(featureName, 'overview', 'Human-facing summary');
    seedLegacy(featureName, 'decisions', 'Technical decisions');

    const executionContext = service.listExecutionContext(featureName);

    expect(executionContext?.map((file: { name: string }) => file.name)).toEqual(['decisions']);
  });

  it('preserves reserved handling for overview, draft, and execution decisions', () => {
    const featureName = 'classified-context';
    setupFeature(featureName);

    seedLegacy(featureName, 'overview', 'Human-facing summary');
    seedLegacy(featureName, 'draft', 'Scratchpad notes');
    seedLegacy(featureName, 'execution-decisions', 'Operational note');
    seedLegacy(featureName, 'learnings', 'Durable learning');

    expect(service.list(featureName).map(file => [
      file.name,
      file.role,
      file.includeInExecution,
      file.includeInNetwork,
    ])).toEqual([
      ['draft', 'scratchpad', false, false],
      ['execution-decisions', 'operational', false, false],
      ['learnings', 'durable', true, true],
      ['overview', 'operational', false, false],
    ]);
  });

  it('excludes overview from network context while preserving durable freshness metadata', () => {
    const featureName = 'network-context';
    setupFeature(featureName);

    seedLegacy(featureName, 'overview', 'Human-facing summary');
    seedLegacy(featureName, 'draft', 'Scratchpad notes');
    seedLegacy(featureName, 'execution-decisions', 'Operational note');
    seedLegacy(featureName, 'learnings', 'Durable learning');
    seedLegacy(featureName, 'research', 'Durable research');

    const networkContext = service.listNetworkContext(featureName);

    expect(new Set(networkContext.map(file => file.name))).toEqual(new Set(['learnings', 'research']));
    expect(networkContext.every(file => file.includeInNetwork)).toBe(true);
    expect(networkContext.every(file => typeof file.updatedAt === 'string' && file.updatedAt.length > 0)).toBe(true);
  });
});

describe('ContextService managed context', () => {
  let service: ContextService;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    service = new ContextService(PROJECT_ROOT, () => new Date('2026-09-07T01:02:03.000Z'));
  });

  afterEach(() => {
    cleanup();
  });

  it('supports project scope without creating storage during reads', () => {
    const contextPath = getProjectContextPath(PROJECT_ROOT);

    expect(service.readSummary({ type: 'project' })).toMatchObject({
      scope: { type: 'project' },
      revision: 0,
      files: [],
    });
    expect(fs.existsSync(contextPath)).toBe(false);
  });

  it('rejects feature scope traversal before resolving storage', () => {
    expect(() => service.readSummary({ type: 'feature', featureName: '../outside' })).toThrow('simple logical name');
    expect(fs.existsSync(path.join(TEST_DIR, '.hive', 'outside'))).toBe(false);
  });

  it('requires discovery metadata on managed durable creates', () => {
    setupFeature('metadata');

    expect(() => service.create('metadata', 'missing', 'raw body')).toThrow('description');
    const created = service.create('metadata', 'notes', durable('raw body'));
    expect(created.file).toMatchObject({
      description: 'Test context',
      readWhen: 'Read when testing managed context.',
    });
    expect(service.read('metadata', 'notes')).toBe(durable('raw body'));

    const frontmatter = '---\ndescription: Boundary metadata\nread_when: Read for boundary checks.\n---\n\n';
    const boundaryContent = `${frontmatter}${'x'.repeat(8191 - Buffer.byteLength(frontmatter))}😀`;
    expect(service.create('metadata', 'boundary', boundaryContent).file.description).toBe('Boundary metadata');
  });

  it('rejects executable or ambiguous YAML metadata and keeps unknown keys non-authoritative', () => {
    setupFeature('metadata-safety');
    const invalid = [
      '---\ndescription: one\ndescription: two\nread_when: test\n---\n',
      '---\ndescription: &value one\nread_when: *value\n---\n',
      '---\ndescription: !!custom value\nread_when: test\n---\n',
      '---\ndescription: 42\nread_when: test\n---\n',
      '---\ndescription: test\nread_when: test\nreview_after: 2026-99-99\n---\n',
    ];
    for (const [index, content] of invalid.entries()) {
      expect(() => service.create('metadata-safety', `invalid-${index}`, content)).toThrow();
    }
    const evidence = service.create(
      'metadata-safety',
      'evidence',
      '---\ndescription: Evidence\nread_when: Explicitly requested.\nkind: durable\n---\n\nraw',
      { kind: 'evidence' },
    );
    expect(evidence.file).toMatchObject({ kind: 'evidence', includeInExecution: false });
  });

  it('requires the actual named-read hash for existing-content mutations', () => {
    setupFeature('hash-guard');
    const created = service.create('hash-guard', 'notes', durable('one'));
    const read = service.readContent('hash-guard', 'notes');
    expect(read?.file.contentHash).toMatch(/^[a-f0-9]{64}$/);

    expect(() => service.replace('hash-guard', 'notes', durable('two'), created.revision, '')).toThrow('hash');
    fs.appendFileSync(path.join(TEST_DIR, '.hive/features/hash-guard/context/notes.md'), '\nexternal');
    expect(() => service.replace(
      'hash-guard',
      'notes',
      durable('two'),
      created.revision,
      read!.file.contentHash,
    )).toThrow('content changed');
    expect(service.read('hash-guard', 'notes')).toContain('external');
  });

  it('fails closed on corrupt and unknown indexes without changing bytes', () => {
    setupFeature('invalid-index');
    const contextPath = path.join(TEST_DIR, '.hive/features/invalid-index/context');
    fs.mkdirSync(contextPath);
    const contentPath = path.join(contextPath, 'notes.md');
    const indexPath = path.join(contextPath, 'index.json');
    fs.writeFileSync(contentPath, 'preserved');
    for (const index of ['{', JSON.stringify({ schemaVersion: 99, revision: 4, entries: {} })]) {
      fs.writeFileSync(indexPath, index);
      expect(() => service.readSummary('invalid-index')).toThrow('index');
      expect(() => service.create('invalid-index', 'other', durable('new'))).toThrow('index');
      expect(fs.readFileSync(contentPath, 'utf8')).toBe('preserved');
      expect(fs.readFileSync(indexPath, 'utf8')).toBe(index);
      expect(fs.existsSync(path.join(contextPath, '.managed-mutation-pending.json'))).toBe(false);
    }

    const invalidUtf8Index = Buffer.concat([
      Buffer.from('{"schemaVersion":1,"revision":0,"entries":{"notes":{"kind":"durable","createdAt":"'),
      Buffer.from([0xff]),
      Buffer.from('","updatedAt":"2026-09-07T01:02:03.000Z"}}}'),
    ]);
    fs.writeFileSync(indexPath, invalidUtf8Index);
    expect(() => service.readSummary('invalid-index')).toThrow('invalid JSON');
    expect(fs.readFileSync(indexPath)).toEqual(invalidUtf8Index);
    expect(fs.readFileSync(contentPath, 'utf8')).toBe('preserved');
  });

  it('blocks catalogs and mutations on interrupted publication while allowing diagnostic exact reads', () => {
    setupFeature('interrupted');
    const created = service.create('interrupted', 'known', durable('known'));
    const contextPath = path.join(TEST_DIR, '.hive/features/interrupted/context');
    const markerPath = path.join(contextPath, '.managed-mutation-pending.json');
    const interrupted = durable('published before index');
    fs.writeFileSync(path.join(contextPath, 'late.md'), interrupted);
    fs.writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, operation: 'create', names: ['late'] }));

    expect(() => service.readSummary('interrupted')).toThrow('reconcile');
    expect(() => service.create('interrupted', 'other', durable('blocked'))).toThrow('reconcile');
    const diagnostic = service.readContent('interrupted', 'late', { diagnosticMode: 'primary-management' });
    expect(diagnostic?.file).toMatchObject({ content: interrupted, role: 'operational', includeInExecution: false });
    expect(service.readRecoverySummary('interrupted', { diagnosticMode: 'primary-management' })).toMatchObject({
      code: 'context_reconciliation_required', revision: created.revision,
      control: { markerPresent: true, indexPresent: true },
      pendingMutation: { operation: 'create', names: ['late'] },
    });
    expect(fs.readFileSync(markerPath, 'utf8')).toContain('"operation":"create"');
    expect(service.readContent('interrupted', 'known', { diagnosticMode: 'primary-management' })?.file.contentHash).toBe(created.file.contentHash);
  });

  it.each(['archive-before-index', 'index-before-manifest'])('preserves explicit interrupted %s state for out-of-band reconciliation', (boundary) => {
    setupFeature(boundary);
    const created = service.create(boundary, 'notes', durable(boundary));
    const featurePath = path.join(TEST_DIR, '.hive/features', boundary);
    const contextPath = path.join(featurePath, 'context');
    const source = path.join(contextPath, 'notes.md');
    const archiveDir = path.join(featurePath, 'archive', 'context');
    const destination = path.join(archiveDir, 'interrupted_notes.md');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(source, destination);
    if (boundary === 'index-before-manifest') {
      const indexPath = path.join(contextPath, 'index.json');
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      index.revision += 1;
      delete index.entries.notes;
      fs.writeFileSync(indexPath, JSON.stringify(index));
    }
    const markerPath = path.join(contextPath, '.managed-mutation-pending.json');
    fs.writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, operation: 'archive-selected', names: ['notes'], archiveDestinations: [destination] }));
    const lockPath = path.join(contextPath, 'index.json.lock');
    fs.writeFileSync(lockPath, 'stale');
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, stale, stale);

    expect(() => service.create(boundary, 'other', durable('blocked'))).toThrow('reconcile');
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readFileSync(destination, 'utf8')).toBe(durable(boundary));
    expect(fs.existsSync(path.join(featurePath, 'archive', 'context-index.json'))).toBe(false);
    expect(service.readRecoverySummary(boundary, { diagnosticMode: 'primary-management' })).toMatchObject({
      code: 'context_reconciliation_required',
      revision: boundary === 'index-before-manifest' ? created.revision + 1 : created.revision,
      control: { markerPresent: true, archiveManifestPresent: false, archiveManifestHash: null },
      pendingMutation: { operation: 'archive-selected', names: ['notes'], archiveDestinations: [destination] },
    });
    const manifestPath = path.join(featurePath, 'archive', 'context-index.json');
    const manifest = JSON.stringify({ preserved: 'prior archive record' });
    fs.writeFileSync(manifestPath, manifest);
    expect(service.readRecoverySummary(boundary, { diagnosticMode: 'primary-management' }).control).toMatchObject({
      archiveManifestPresent: true, archiveManifestHash: createHash('sha256').update(manifest).digest('hex'),
    });
    expect(created.file.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('clears the pending marker only after a proven content/index rollback', () => {
    setupFeature('rollback');
    const created = service.create('rollback', 'notes', durable('before'));
    const contextPath = path.join(TEST_DIR, '.hive/features/rollback/context');
    const indexPath = path.join(contextPath, 'index.json');
    const beforeIndex = fs.readFileSync(indexPath, 'utf8');
    const originalRename = fs.renameSync;
    let failed = false;
    const rename = spyOn(fs, 'renameSync').mockImplementation(((source: fs.PathLike, destination: fs.PathLike) => {
      if (!failed && String(destination) === indexPath && fs.existsSync(path.join(contextPath, '.managed-mutation-pending.json'))) {
        failed = true;
        throw new Error('simulated index publication failure');
      }
      return originalRename(source, destination);
    }) as typeof fs.renameSync);
    try {
      expect(() => service.replace('rollback', 'notes', durable('after'), created.revision, created.file.contentHash)).toThrow('simulated');
    } finally { rename.mockRestore(); }
    expect(fs.readFileSync(path.join(contextPath, 'notes.md'), 'utf8')).toBe(durable('before'));
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(beforeIndex);
    expect(fs.existsSync(path.join(contextPath, '.managed-mutation-pending.json'))).toBe(false);
  });

  it('paginates complete durable catalogs and invalidates cursors on index-only classification drift', () => {
    setupFeature('catalog');
    for (let index = 0; index < 7; index += 1) service.create('catalog', `note-${index}`, durable(`body-${index}`, `Description ${index}`));
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = service.readCatalog('catalog', { cursor, limit: 2 });
      names.push(...page.files.map(file => file.name));
      cursor = page.nextCursor;
      if (!cursor) expect(page.complete).toBe(true);
    } while (cursor);
    expect(names).toEqual(['note-0', 'note-1', 'note-2', 'note-3', 'note-4', 'note-5', 'note-6']);
    expect(service.readCatalog('catalog', { query: 'DESCRIPTION 6', limit: 1 }).files.map(file => file.name)).toEqual(['note-6']);

    const first = service.readCatalog('catalog', { limit: 1 });
    const indexPath = path.join(TEST_DIR, '.hive/features/catalog/context/index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    index.entries['note-1'].kind = 'evidence';
    fs.writeFileSync(indexPath, JSON.stringify(index));
    expect(() => service.readCatalog('catalog', { cursor: first.nextCursor, limit: 1 })).toThrow('cursor');
    const unsupported = Buffer.from(JSON.stringify({ version: 2 })).toString('base64url');
    expect(() => service.readCatalog('catalog', { cursor: unsupported })).toThrow('unsupported version');
  });

  it('uses Unicode code-point ordering with locale-independent ASCII query folding', () => {
    setupFeature('code-point-order');
    for (const name of ['éclair', 'alpha', 'Zulu']) service.create('code-point-order', name, durable(name, `CASE ${name}`));
    expect(service.readCatalog('code-point-order').files.map(file => file.name)).toEqual(['Zulu', 'alpha', 'éclair']);
    expect(service.readCatalog('code-point-order', { query: 'case zULU' }).files.map(file => file.name)).toEqual(['Zulu']);
    expect(service.readCatalog('code-point-order', { query: 'ÉCLAIR' })).toMatchObject({ files: [], complete: true });
  });

  it('reconstructs exact hashes and UTF-8 bytes from bounded named chunks', () => {
    setupFeature('chunks');
    const content = `${'quoted "\\\n'.repeat(700)}😀tail`;
    service.create('chunks', 'raw', content, { kind: 'evidence' });
    let offset = 0;
    let reconstructed = '';
    let expectedHash = '';
    do {
      const read = service.readContent('chunks', 'raw', { offset, maxBytes: 1024 })!;
      expect(Buffer.byteLength(JSON.stringify(read), 'utf8')).toBeLessThanOrEqual(1024);
      reconstructed += read.file.content;
      expectedHash ||= read.file.contentHash!;
      expect(read.file.contentHash).toBe(expectedHash);
      if (read.complete) break;
      expect(read.nextOffset).toBeGreaterThan(offset);
      offset = read.nextOffset!;
    } while (true);
    expect(reconstructed).toBe(content);
    expect(expectedHash).toBe(createHash('sha256').update(Buffer.from(content)).digest('hex'));

    service.create('chunks', 'empty', '', { kind: 'evidence' });
    expect(service.readContent('chunks', 'empty')).toMatchObject({ complete: true, range: { start: 0, end: 0, totalBytes: 0 }, file: { content: '' } });

    const template = service.readContent('chunks', 'raw', { maxBytes: 1024 })!;
    const zeroProgressEnvelope = {
      ...template,
      file: { ...template.file, content: '' },
      range: { start: 0, end: 0, totalBytes: Buffer.byteLength(content) },
      complete: false,
      nextOffset: 0,
    };
    const envelopeOnlyBudget = Buffer.byteLength(JSON.stringify(zeroProgressEnvelope));
    expect(() => service.readContent('chunks', 'raw', { maxBytes: envelopeOnlyBudget })).toThrow('response envelope');
  });

  it('rejects invalid UTF-8 and symlink traversal without repairing storage', () => {
    setupFeature('unsafe');
    const contextPath = path.join(TEST_DIR, '.hive/features/unsafe/context');
    fs.mkdirSync(contextPath);
    fs.writeFileSync(path.join(contextPath, 'invalid.md'), Buffer.from([0xff]));
    expect(() => service.readContent('unsafe', 'invalid')).toThrow('UTF-8');
    fs.symlinkSync('/tmp', path.join(contextPath, 'linked.md'));
    expect(() => service.readSummary('unsafe')).toThrow('symlink');
    expect(fs.existsSync(path.join(contextPath, 'index.json'))).toBe(false);
  });

  it('refuses archive parent symlinks before creating destination directories', () => {
    setupFeature('unsafe-archive');
    const created = service.create('unsafe-archive', 'notes', durable('preserved'));
    const featurePath = path.join(TEST_DIR, '.hive/features/unsafe-archive');
    const archiveTarget = path.join(TEST_DIR, '.hive/archive-target');
    fs.mkdirSync(archiveTarget, { recursive: true });
    fs.symlinkSync(archiveTarget, path.join(featurePath, 'archive'));

    expect(() => service.archiveSelected(
      'unsafe-archive',
      ['notes'],
      'unsafe destination',
      created.revision,
      { notes: created.file.contentHash },
    )).toThrow('symlink');
    expect(fs.existsSync(path.join(archiveTarget, 'context'))).toBe(false);
    expect(service.read('unsafe-archive', 'notes')).toBe(durable('preserved'));
  });

  it('uses project warning thresholds and enforces project governance metadata', () => {
    expect(() => service.create({ type: 'project' }, 'missing-owner', durable('body'))).toThrow('owner');
    for (let index = 0; index < 9; index += 1) service.create({ type: 'project' }, `project-${index}`, projectDurable(`body-${index}`));
    const summary = service.readSummary({ type: 'project' });
    expect(summary.durable).toMatchObject({ fileCount: 9, fileCap: 32, chars: null, overLimit: false });
    expect(summary.durable.warnings.join('\n')).not.toContain('9 files exceeds');
    service.create({ type: 'project' }, 'review-due', projectDurable('stale', '2026-09-01'));
    expect(service.readSummary({ type: 'project' }).durable.warnings.join('\n')).toContain('re-review and replace');
    expect(service.readSummary({ type: 'project' }, { scanChars: true }).durable.charsMeasurement).toBe('current');
  });

  it('reads only stat data and bounded headers for ordinary summaries', () => {
    setupFeature('headers-only');
    service.create('headers-only', 'notes', durable('body'));
    const original = fs.readFileSync;
    const reads = spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file).endsWith('.md')) throw new Error('ordinary summary read the body');
      return (original as any)(file, ...args);
    }) as any);
    try {
      expect(service.readSummary('headers-only').durable).toMatchObject({ chars: null, charsMeasurement: 'unavailable' });
    } finally { reads.mockRestore(); }
  });

  it('reads legacy files as durable without eager migration', () => {
    setupFeature('legacy');
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'legacy', 'context');
    fs.mkdirSync(contextPath);
    fs.writeFileSync(path.join(contextPath, 'contract.md'), 'legacy contract');

    const summary = service.readSummary('legacy');

    expect(summary.revision).toBe(0);
    expect(summary.files[0]?.kind).toBe('durable');
    expect(summary.durable).toMatchObject({ fileCount: 1, chars: null, bytes: 15, overLimit: false });
    expect(fs.existsSync(path.join(contextPath, 'index.json'))).toBe(false);
  });

  it('preserves write overwrite compatibility and advances a coherent revision', () => {
    setupFeature('write-overwrite');
    service.create('write-overwrite', 'contract', durable('first'));

    const current = service.readContent('write-overwrite', 'contract')!;
    const result = service.write('write-overwrite', 'contract.md', 'replacement bytes', current.revision, current.file.contentHash!);

    expect(result).toContain(path.join('context', 'contract.md'));
    expect(service.read('write-overwrite', 'contract')).toBe('replacement bytes');
    expect(service.readSummary('write-overwrite')).toMatchObject({
      revision: 2,
      durable: { fileCount: 1, chars: null, bytes: 17 },
    });
  });

  it('invalidates held revisions and removes index metadata on compatibility delete', () => {
    setupFeature('delete-managed');
    const created = service.create('delete-managed', 'notes', 'delete me', { kind: 'evidence' });

    expect(service.delete('delete-managed', 'notes', created.revision, created.file.contentHash)).toBe(true);
    expect(service.readSummary('delete-managed')).toMatchObject({ revision: 2, files: [] });
    const replacement = service.create('delete-managed', 'replacement', durable('new'));
    expect(() => service.replace('delete-managed', 'replacement', durable('stale'), created.revision, replacement.file.contentHash))
      .toThrow('current revision is 3');
    const indexPath = path.join(TEST_DIR, '.hive', 'features', 'delete-managed', 'context', 'index.json');
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf-8')).entries).not.toHaveProperty('notes');
  });

  it.each(['write', 'delete', 'archive'] as const)('requires caller revision and actual hashes on compatibility %s', operation => {
    setupFeature('guarded-compatibility');
    const created = service.create('guarded-compatibility', 'notes', durable('original'));
    const invoke = (revision: unknown, hash: unknown) => {
      if (operation === 'write') return service.write('guarded-compatibility', 'notes', 'replacement', revision as number, hash as string);
      if (operation === 'delete') return service.delete('guarded-compatibility', 'notes', revision as number, hash as string);
      return service.archive('guarded-compatibility', revision as number, hash === undefined ? undefined as any : { notes: hash as string });
    };
    const contextPath = path.join(TEST_DIR, '.hive/features/guarded-compatibility/context');
    const indexBefore = fs.readFileSync(path.join(contextPath, 'index.json'));
    for (const revision of [undefined, null, -1, created.revision - 1]) {
      expect(() => invoke(revision, created.file.contentHash)).toThrow();
    }
    expect(() => invoke(created.revision, undefined)).toThrow('hash');
    fs.writeFileSync(path.join(contextPath, 'notes.md'), 'external edit');
    expect(() => invoke(created.revision, created.file.contentHash)).toThrow();
    expect(fs.readFileSync(path.join(contextPath, 'notes.md'), 'utf8')).toBe('external edit');
    expect(fs.readFileSync(path.join(contextPath, 'index.json'))).toEqual(indexBefore);
    expect(fs.existsSync(path.join(contextPath, '.managed-mutation-pending.json'))).toBe(false);
  });

  it('preserves compatibility archive collisions and invalidates held revisions', () => {
    setupFeature('archive-managed');
    const first = service.create('archive-managed', 'notes', durable('first payload'));
    const firstArchive = service.archive('archive-managed', first.revision, { notes: first.file.contentHash });
    const second = service.create('archive-managed', 'notes', durable('second payload'));
    const secondArchive = service.archive('archive-managed', second.revision, { notes: second.file.contentHash });

    const archiveFiles = fs.readdirSync(firstArchive.archivePath)
      .filter(name => name.includes('_notes'));
    expect(archiveFiles).toHaveLength(2);
    expect(archiveFiles.map(name => fs.readFileSync(path.join(firstArchive.archivePath, name), 'utf-8')).sort())
      .toEqual([durable('first payload'), durable('second payload')]);
    expect(secondArchive.archivePath).toBe(firstArchive.archivePath);
    expect(service.readSummary('archive-managed')).toMatchObject({ revision: 4, files: [] });
    const replacement = service.create('archive-managed', 'replacement', durable('new'));
    expect(() => service.replace('archive-managed', 'replacement', durable('stale'), first.revision, replacement.file.contentHash))
      .toThrow('current revision is 5');
  });

  it('returns content and revision from one locked snapshot', () => {
    setupFeature('snapshot');
    const created = service.create('snapshot', 'notes', durable('snapshot bytes'));

    expect(service.readContent('snapshot', 'notes')).toMatchObject({
      revision: created.revision,
      file: { name: 'notes', content: durable('snapshot bytes'), kind: 'durable' },
    });
    expect(service.readSummary('snapshot')).toMatchObject({
      revision: created.revision,
      files: [{ name: 'notes', kind: 'durable' }],
      durable: { chars: null, bytes: Buffer.byteLength(durable('snapshot bytes')) },
    });
  });

  it('performs list-based public reads without writer locks', () => {
    setupFeature('locked-reads');
    service.create('locked-reads', 'notes', durable('snapshot bytes'));
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'locked-reads', 'context');
    const lockPath = path.join(contextPath, 'index.json.lock');
    const originalReaddirSync = fs.readdirSync;
    let observations = 0;
    const readdirSpy = spyOn(fs, 'readdirSync').mockImplementation(((targetPath, options) => {
      if (String(targetPath) === contextPath) {
        observations += 1;
        expect(fs.existsSync(lockPath)).toBe(false);
      }
      return originalReaddirSync(targetPath, options as never);
    }) as typeof fs.readdirSync);

    try {
      expect(service.list('locked-reads')).toHaveLength(1);
      expect(service.getOverview('locked-reads')).toBeNull();
      expect(service.listExecutionContext('locked-reads')).toHaveLength(1);
      expect(service.listNetworkContext('locked-reads')).toHaveLength(1);
      expect(service.compile('locked-reads')).toContain('snapshot bytes');
      expect(service.stats('locked-reads').count).toBe(1);
      expect(service.readSummary('locked-reads').files).toHaveLength(1);
      expect(service.readContent('locked-reads', 'notes')?.file.content).toBe(durable('snapshot bytes'));
    } finally {
      readdirSpy.mockRestore();
    }

    expect(observations).toBeGreaterThanOrEqual(8);
  });

  it('creates evidence without exposing it to execution or network context', () => {
    setupFeature('evidence');
    service.create('evidence', 'verification-log', 'raw output', { kind: 'evidence', task: '01-test' });
    service.create('evidence', 'contract', durable('current contract'));

    expect(service.listExecutionContext('evidence').map(file => file.name)).toEqual(['contract']);
    expect(service.listNetworkContext('evidence').map(file => file.name)).toEqual(['contract']);
    expect(service.readContent('evidence', 'verification-log')?.file).toMatchObject({
      kind: 'evidence',
      task: '01-test',
    });
  });

  it('rejects stale replace and append without changing content or index', () => {
    setupFeature('stale');
    const created = service.create('stale', 'contract', durable('one'));
    const indexPath = path.join(TEST_DIR, '.hive', 'features', 'stale', 'context', 'index.json');
    const beforeIndex = fs.readFileSync(indexPath, 'utf-8');

    expect(() => service.replace('stale', 'contract', durable('two'), 0, created.file.contentHash)).toThrow('current revision is 1');
    expect(() => service.append('stale', 'contract', 'three', 0, created.file.contentHash)).toThrow('current revision is 1');
    expect(service.read('stale', 'contract')).toBe(durable('one'));
    expect(fs.readFileSync(indexPath, 'utf-8')).toBe(beforeIndex);
  });

  it('appends a deterministic dated section while preserving prior bytes', () => {
    setupFeature('append');
    const original = durable('original bytes');
    const created = service.create('append', 'learnings', original);

    const result = service.append(
      'append',
      'learnings',
      'new finding',
      created.revision,
      created.file.contentHash,
      { section: 'Tests' },
    );

    expect(result.revision).toBe(2);
    expect(service.read('append', 'learnings')).toBe(
      `${original}\n\n<!-- appended 2026-09-07T01:02:03.000Z -->\n### Tests\n\nnew finding\n`,
    );
  });

  it('reports over-limit durable context as a soft warning without rejecting bounded growth', () => {
    setupFeature('over-limit');
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'over-limit', 'context');
    fs.mkdirSync(contextPath);
    for (let index = 0; index < 9; index += 1) {
      fs.writeFileSync(path.join(contextPath, `legacy-${index}.md`), 'x'.repeat(5000));
    }

    const read = service.readContent('over-limit', 'legacy-0')!;
    const shrink = service.replace('over-limit', 'legacy-0', 'shorter', 0, read.file.contentHash!);
    expect(shrink.revision).toBe(1);
    expect(service.append('over-limit', 'legacy-0', 'growth', shrink.revision, shrink.file.contentHash).revision).toBe(2);
    expect(service.create('over-limit', 'another', durable('new')).revision).toBe(3);
    expect(service.readSummary('over-limit').durable.overLimit).toBe(true);
  });

  it('does not conflate file-count warnings with semantic admission', () => {
    setupFeature('file-count-overage');
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'file-count-overage', 'context');
    fs.mkdirSync(contextPath);
    for (let index = 0; index < 9; index += 1) {
      fs.writeFileSync(path.join(contextPath, `legacy-${index}.md`), 'x');
    }

    const read = service.readContent('file-count-overage', 'legacy-0')!;
    expect(service.replace('file-count-overage', 'legacy-0', 'xx', 0, read.file.contentHash!).revision).toBe(1);
  });

  it('reports exact characters only for an explicit management scan', () => {
    setupFeature('char-count-overage');
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'char-count-overage', 'context');
    fs.mkdirSync(contextPath);
    fs.writeFileSync(path.join(contextPath, 'legacy.md'), 'x'.repeat(40001));

    expect(service.readSummary('char-count-overage').durable.chars).toBeNull();
    expect(service.readSummary('char-count-overage', { scanChars: true }).durable).toMatchObject({
      chars: 40001,
      charsMeasurement: 'current',
      overLimit: true,
    });
  });

  it('archives only selected files with reason and advances revision', () => {
    setupFeature('archive-selected');
    service.create('archive-selected', 'keep', durable('keep'));
    const created = service.create('archive-selected', 'remove', durable('remove'));

    const result = service.archiveSelected('archive-selected', ['remove'], 'superseded', created.revision, { remove: created.file.contentHash });

    expect(result.revision).toBe(3);
    expect(service.read('archive-selected', 'keep')).toBe(durable('keep'));
    expect(service.read('archive-selected', 'remove')).toBeNull();
    expect(fs.readFileSync(result.archived[0]!.archivePath, 'utf-8')).toBe(durable('remove'));
    expect(result.archived[0]?.reason).toBe('superseded');
  });

  it('preserves repeated archives of a recreated name at a fixed timestamp', () => {
    setupFeature('archive-collision');
    const first = service.create('archive-collision', 'notes', durable('first payload'));
    const firstArchive = service.archiveSelected('archive-collision', ['notes'], 'first', first.revision, { notes: first.file.contentHash });
    const second = service.create('archive-collision', 'notes', durable('second payload'));
    const secondArchive = service.archiveSelected('archive-collision', ['notes'], 'second', second.revision, { notes: second.file.contentHash });

    expect(firstArchive.archived[0]?.archivePath).not.toBe(secondArchive.archived[0]?.archivePath);
    expect(fs.readFileSync(firstArchive.archived[0]!.archivePath, 'utf-8')).toBe(durable('first payload'));
    expect(fs.readFileSync(secondArchive.archived[0]!.archivePath, 'utf-8')).toBe(durable('second payload'));
  });

  it('rejects stale archive without changing active or archive bytes', () => {
    setupFeature('stale-archive');
    const created = service.create('stale-archive', 'notes', durable('active payload'));
    service.create('stale-archive', 'other', durable('other payload'));
    const featurePath = path.join(TEST_DIR, '.hive', 'features', 'stale-archive');
    const beforeContext = fs.readFileSync(path.join(featurePath, 'context', 'notes.md'), 'utf-8');
    const beforeIndex = fs.readFileSync(path.join(featurePath, 'context', 'index.json'), 'utf-8');

    expect(() => service.archiveSelected('stale-archive', ['notes'], 'stale', created.revision, { notes: created.file.contentHash })).toThrow('current revision is 2');
    expect(fs.readFileSync(path.join(featurePath, 'context', 'notes.md'), 'utf-8')).toBe(beforeContext);
    expect(fs.readFileSync(path.join(featurePath, 'context', 'index.json'), 'utf-8')).toBe(beforeIndex);
    expect(fs.existsSync(path.join(featurePath, 'archive'))).toBe(false);
  });

  it('rejects caller kinds for reserved context names', () => {
    setupFeature('reserved-kind');

    expect(() => service.create('reserved-kind', 'draft', 'notes', { kind: 'evidence' }))
      .toThrow('reserved and does not accept');
    expect(service.read('reserved-kind', 'draft')).toBeNull();
    expect(service.readSummary('reserved-kind').revision).toBe(0);
  });

  it('allows kind transitions without aggregate admission rejection', () => {
    setupFeature('kind-transitions');
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'kind-transitions', 'context');
    fs.mkdirSync(contextPath);
    for (let index = 0; index < 9; index += 1) {
      fs.writeFileSync(path.join(contextPath, `legacy-${index}.md`), 'x'.repeat(5000));
    }

    const legacy = service.readContent('kind-transitions', 'legacy-0')!;
    const reduced = service.replace('kind-transitions', 'legacy-0', 'raw evidence', 0, legacy.file.contentHash!, { kind: 'evidence' });
    expect(reduced.revision).toBe(1);
    expect(service.readSummary('kind-transitions', { scanChars: true }).durable).toMatchObject({ fileCount: 8, chars: 40000 });
    expect(service.replace(
      'kind-transitions',
      'legacy-0',
      'y'.repeat(5001),
      reduced.revision,
      reduced.file.contentHash,
      { kind: 'durable' },
    ).revision).toBe(2);
  });

  it('allows a bounded evidence-to-durable transition above hygiene guidelines', () => {
    setupFeature('cross-cap-transition');
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'cross-cap-transition', 'context');
    fs.mkdirSync(contextPath);
    for (let index = 0; index < 9; index += 1) {
      fs.writeFileSync(path.join(contextPath, `legacy-${index}.md`), 'x'.repeat(4000));
    }
    const evidence = service.create(
      'cross-cap-transition',
      'raw-log',
      'e'.repeat(6000),
      { kind: 'evidence' },
    );

    const transitioned = service.replace(
      'cross-cap-transition',
      'raw-log',
      'y',
      evidence.revision,
      evidence.file.contentHash,
      { kind: 'durable' },
    );
    expect(transitioned.revision).toBe(2);
    expect(service.read('cross-cap-transition', 'raw-log')).toBe('y');
  });

  it('orders durable execution context by recent update then name', () => {
    setupFeature('ordering');
    service = new ContextService(PROJECT_ROOT, (() => {
      const timestamps = [
        '2026-09-07T01:00:00.000Z',
        '2026-09-07T02:00:00.000Z',
        '2026-09-07T02:00:00.000Z',
        '2026-09-07T03:00:00.000Z',
      ];
      return () => new Date(timestamps.shift()!);
    })());
    const older = service.create('ordering', 'older', durable('old'));
    service.create('ordering', 'alpha', durable('alpha'));
    service.create('ordering', 'beta', durable('beta'));
    service.replace('ordering', 'older', durable('newest'), 3, older.file.contentHash);

    expect(service.listExecutionContext('ordering').map(file => file.name)).toEqual([
      'older',
      'alpha',
      'beta',
    ]);
  });
});
