import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ContextService, CONTEXT_CANDIDATE_MAX, CONTEXT_NAMESPACE_ENTRY_MAX } from './contextService.js';
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

function seedLegacyProject(name: string, fileName: string, content: string): void {
  const directory = path.join(TEST_DIR, '.hive', 'context');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${fileName}.md`), content);
}

function projectDurable(body: string, reviewAfter = '2026-09-30'): string {
  return `---\ndescription: Project context\nread_when: Read for project-wide decisions.\nowner: platform\nreview_after: ${reviewAfter}\n---\n\n${body}`;
}

function requiredEventAfter(events: string[], expected: string | ((event: string) => boolean), after = -1): number {
  const predicate = typeof expected === 'string' ? (event: string) => event === expected : expected;
  const index = events.findIndex((event, candidate) => candidate > after && predicate(event));
  expect(index).toBeGreaterThan(after);
  return index;
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
    const query = 'q'.repeat(512);
    for (let index = 0; index < 20; index++) {
      service.create('catalog-boundary', `note-${String(index).padStart(2, '0')}`, `---\ndescription: ${query}\nread_when: ${'x'.repeat(512)}\n---\n\nbody`);
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
    expect(names).toEqual(Array.from({ length: 20 }, (_, index) => `note-${String(index).padStart(2, '0')}`));
  });

  it('clips per-file descriptive metadata instead of failing when the summary exceeds the response bound', () => {
    setupFeature('summary-clipping');
    for (let index = 0; index < 30; index++) {
      service.create('summary-clipping', `note-${index}`, `---\ndescription: ${'D'.repeat(512)}\nread_when: ${'R'.repeat(512)}\n---\n\nbody`);
    }
    const summary = service.readSummary('summary-clipping');
    expect(Buffer.byteLength(JSON.stringify(summary), 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(summary.files).toHaveLength(30);
    expect(summary.files[0]!.name).toBe('note-0');
    expect(summary.files[0]!.bytes).toBeGreaterThan(0);
    expect(summary.files[0]!.description).toBeUndefined();
    expect(summary.files[0]!.readWhen).toBeUndefined();
    expect(summary.diagnostics.join('\n')).toContain('descriptive metadata');
    expect(summary.metadataClipped).toBe(true);
    expect(service.readCatalog('summary-clipping').files[0]!.description).toContain('DDDD');

    setupFeature('summary-unclipped');
    service.create('summary-unclipped', 'note', durable('body'));
    const smallSummary = service.readSummary('summary-unclipped');
    expect('metadataClipped' in smallSummary).toBe(false);
  });

  it('fails explicitly when the identity-only clip still exceeds the response bound', () => {
    setupFeature('summary-clipped-oversized');
    for (let index = 0; index < 130; index++) {
      service.create('summary-clipped-oversized', `note-${String(index).padStart(3, '0')}`, durable('body'));
    }
    try {
      service.readSummary('summary-clipped-oversized');
      throw new Error('expected the clipped summary to fail the response bound');
    } catch (error) {
      expect((error as { reason?: string }).reason).toBe('context_response_too_large');
    }
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

    fs.writeFileSync(path.join(directory, 'notes.md'), 'preserved pending bytes');
    expect(service.readContent('pending-create', 'notes', { diagnosticMode: 'primary-management' })?.file).toMatchObject({
      content: 'preserved pending bytes',
      kind: undefined,
      kindSource: undefined,
      role: 'operational',
      includeInExecution: false,
      includeInNetwork: false,
    });
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

  it('requires discovery metadata on managed durable creates and replacements', () => {
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

    expect(() => service.replace('metadata', 'notes', 'missing metadata', created.revision + 1, created.file.contentHash))
      .toThrow('description');
    expect(service.read('metadata', 'notes')).toBe(durable('raw body'));

    const project = service.create({ type: 'project' }, 'project-notes', projectDurable('project body'));
    expect(() => service.replace(
      { type: 'project' },
      'project-notes',
      durable('missing project governance'),
      project.revision,
      project.file.contentHash,
    )).toThrow('owner');
    expect(service.read({ type: 'project' }, 'project-notes')).toBe(projectDurable('project body'));
  });

  it('enforces metadata limits by Unicode code point and preserves oversized direct edits as diagnostics', () => {
    setupFeature('metadata-limits');
    const description512 = '😀'.repeat(512);
    const readWhen512 = '𐐀'.repeat(512);
    const owner128 = '😀'.repeat(128);
    expect(service.create(
      'metadata-limits',
      'feature-boundary',
      `---\ndescription: ${description512}\nread_when: ${readWhen512}\n---\n\nbody`,
    ).file).toMatchObject({ description: description512, readWhen: readWhen512 });
    const projectBoundary = service.create(
      { type: 'project' },
      'project-boundary',
      `---\ndescription: boundary\nread_when: boundary\nowner: ${owner128}\nreview_after: 2026-09-30\n---\n\nbody`,
    );
    expect(projectBoundary.file.owner).toBe(owner128);

    expect(() => service.create(
      'metadata-limits',
      'description-over',
      `---\ndescription: ${'😀'.repeat(513)}\nread_when: boundary\n---\n\nbody`,
    )).toThrow('512 Unicode code points');
    expect(() => service.create(
      'metadata-limits',
      'read-when-over',
      `---\ndescription: boundary\nread_when: ${'𐐀'.repeat(513)}\n---\n\nbody`,
    )).toThrow('512 Unicode code points');
    expect(() => service.create(
      { type: 'project' },
      'owner-over',
      `---\ndescription: boundary\nread_when: boundary\nowner: ${'😀'.repeat(129)}\nreview_after: 2026-09-30\n---\n\nbody`,
    )).toThrow('128 Unicode code points');

    const oversized = `---\ndescription: ${'😀'.repeat(513)}\nread_when: Direct-edit diagnostics.\n---\n\npreserved`;
    seedLegacy('metadata-limits', 'legacy-oversized', oversized);
    const indexed = service.create('metadata-limits', 'indexed-oversized', durable('before'));
    expect(() => service.replace(
      'metadata-limits', 'indexed-oversized', oversized, indexed.revision, indexed.file.contentHash,
    )).toThrow('512 Unicode code points');
    expect(() => service.replace(
      { type: 'project' },
      'project-boundary',
      `---\ndescription: boundary\nread_when: boundary\nowner: ${'😀'.repeat(129)}\nreview_after: 2026-09-30\n---\n\nbody`,
      projectBoundary.revision,
      projectBoundary.file.contentHash,
    )).toThrow('128 Unicode code points');
    const indexedPath = path.join(TEST_DIR, '.hive/features/metadata-limits/context/indexed-oversized.md');
    fs.writeFileSync(indexedPath, oversized);

    const summary = service.readSummary('metadata-limits');
    const legacyFile = summary.files.find(file => file.name === 'legacy-oversized')!;
    const indexedFile = summary.files.find(file => file.name === 'indexed-oversized')!;
    expect(legacyFile).toMatchObject({ kind: 'durable', kindSource: 'legacy_default', description: undefined });
    expect(indexedFile).toMatchObject({ kind: 'durable', kindSource: 'index', description: undefined });
    expect(legacyFile.warnings?.join('\n')).toContain('512 Unicode code points');
    expect(indexedFile.warnings?.join('\n')).toContain('512 Unicode code points');
    expect(service.readCatalog('metadata-limits').files.map(file => file.name)).toContain('legacy-oversized');
    expect(fs.readFileSync(indexedPath, 'utf8')).toBe(oversized);
    expect(indexed.file.contentHash).not.toBe(createHash('sha256').update(oversized).digest('hex'));
  });

  it('withholds invalid direct-edited review dates and reports project governance gaps', () => {
    const indexed = service.create({ type: 'project' }, 'indexed-invalid-date', projectDurable('before'));
    const contextPath = getProjectContextPath(PROJECT_ROOT);
    const impossibleDate = projectDurable('preserved impossible date', '2026-02-30');
    const nonDate = projectDurable('preserved non-date', 'after-launch');
    fs.writeFileSync(path.join(contextPath, 'indexed-invalid-date.md'), impossibleDate);
    fs.writeFileSync(path.join(contextPath, 'legacy-invalid-date.md'), nonDate);

    const catalog = service.readManagementCatalog({ type: 'project' });
    const indexedFile = catalog.files.find(file => file.name === 'indexed-invalid-date')!;
    const legacyFile = catalog.files.find(file => file.name === 'legacy-invalid-date')!;
    expect(indexedFile).toMatchObject({ kindSource: 'index', reviewAfter: undefined });
    expect(legacyFile).toMatchObject({ kindSource: 'legacy_default', reviewAfter: undefined });
    expect(indexedFile.warnings?.join('\n')).toContain('review_after must use YYYY-MM-DD');
    expect(legacyFile.warnings?.join('\n')).toContain('review_after must use YYYY-MM-DD');
    expect(catalog.durable.governanceIssues).toBe(2);
    expect(fs.readFileSync(path.join(contextPath, 'indexed-invalid-date.md'), 'utf8')).toBe(impossibleDate);
    expect(fs.readFileSync(path.join(contextPath, 'legacy-invalid-date.md'), 'utf8')).toBe(nonDate);
    expect(indexed.file.contentHash).not.toBe(createHash('sha256').update(impossibleDate).digest('hex'));
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

    expect(() => service.readSummary(boundary)).toThrow('reconcile');
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
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

  it.each(['create', 'replace'] as const)('durably orders %s content and index publication around the pending marker', (operation) => {
    const featureName = `durable-${operation}`;
    setupFeature(featureName);
    const created = operation === 'replace' ? service.create(featureName, 'notes', durable('before')) : undefined;
    const contextPath = path.join(TEST_DIR, '.hive/features', featureName, 'context');
    const markerPath = path.join(contextPath, '.managed-mutation-pending.json');
    const contentPath = path.join(contextPath, 'notes.md');
    const indexPath = path.join(contextPath, 'index.json');
    const descriptorPaths = new Map<number, string>();
    const events: string[] = [];
    const originalWrite = fs.writeFileSync;
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const originalRename = fs.renameSync;
    const originalUnlink = fs.unlinkSync;
    const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(((target, data, options) => {
      events.push(`write:${String(target)}`);
      originalWrite(target, data, options as never);
    }) as typeof fs.writeFileSync);
    const openSpy = spyOn(fs, 'openSync').mockImplementation(((target, flags, mode) => {
      const descriptor = originalOpen(target, flags, mode);
      descriptorPaths.set(descriptor, String(target));
      return descriptor;
    }) as typeof fs.openSync);
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((descriptor => {
      events.push(`fsync:${descriptorPaths.get(descriptor)}`);
      originalFsync(descriptor);
    }) as typeof fs.fsyncSync);
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((source, destination) => {
      events.push(`rename:${String(destination)}`);
      originalRename(source, destination);
    }) as typeof fs.renameSync);
    const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation((target => {
      events.push(`unlink:${String(target)}`);
      originalUnlink(target);
    }) as typeof fs.unlinkSync);

    try {
      if (created) service.replace(featureName, 'notes', durable('after'), created.revision, created.file.contentHash);
      else service.create(featureName, 'notes', durable('after'));
    } finally {
      unlinkSpy.mockRestore();
      renameSpy.mockRestore();
      fsyncSpy.mockRestore();
      openSpy.mockRestore();
      writeSpy.mockRestore();
    }

    const markerWrite = requiredEventAfter(events, event => event.startsWith(`write:${markerPath}.tmp.`));
    const markerFileSync = requiredEventAfter(events, event => event.startsWith(`fsync:${markerPath}.tmp.`), markerWrite);
    const markerRename = requiredEventAfter(events, `rename:${markerPath}`, markerFileSync);
    const markerDirectorySync = process.platform === 'win32'
      ? markerRename
      : requiredEventAfter(events, `fsync:${contextPath}`, markerRename);
    const contentWrite = requiredEventAfter(events, event => event.startsWith(`write:${contentPath}.tmp.`), markerDirectorySync);
    const contentFileSync = requiredEventAfter(events, event => event.startsWith(`fsync:${contentPath}.tmp.`), contentWrite);
    const contentRename = requiredEventAfter(events, `rename:${contentPath}`, contentFileSync);
    const contentDirectorySync = process.platform === 'win32'
      ? contentRename
      : requiredEventAfter(events, `fsync:${contextPath}`, contentRename);
    const indexWrite = requiredEventAfter(events, event => event.startsWith(`write:${indexPath}.tmp.`), contentDirectorySync);
    const indexFileSync = requiredEventAfter(events, event => event.startsWith(`fsync:${indexPath}.tmp.`), indexWrite);
    const indexRename = requiredEventAfter(events, `rename:${indexPath}`, indexFileSync);
    const indexDirectorySync = process.platform === 'win32'
      ? indexRename
      : requiredEventAfter(events, `fsync:${contextPath}`, indexRename);
    const markerUnlink = requiredEventAfter(events, `unlink:${markerPath}`, indexDirectorySync);
    if (process.platform !== 'win32') requiredEventAfter(events, `fsync:${contextPath}`, markerUnlink);
  });

  it('clears the pending marker only after a proven content/index rollback', () => {
    setupFeature('rollback');
    const created = service.create('rollback', 'notes', durable('before'));
    const contextPath = path.join(TEST_DIR, '.hive/features/rollback/context');
    const indexPath = path.join(contextPath, 'index.json');
    const markerPath = path.join(contextPath, '.managed-mutation-pending.json');
    const contentPath = path.join(contextPath, 'notes.md');
    const beforeIndex = fs.readFileSync(indexPath, 'utf8');
    const descriptorPaths = new Map<number, string>();
    const events: string[] = [];
    const originalWrite = fs.writeFileSync;
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const originalRename = fs.renameSync;
    const originalUnlink = fs.unlinkSync;
    let failed = false;
    const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(((target, data, options) => {
      events.push(`write:${String(target)}`);
      originalWrite(target, data, options as never);
    }) as typeof fs.writeFileSync);
    const openSpy = spyOn(fs, 'openSync').mockImplementation(((target, flags, mode) => {
      const descriptor = originalOpen(target, flags, mode);
      descriptorPaths.set(descriptor, String(target));
      return descriptor;
    }) as typeof fs.openSync);
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((descriptor => {
      events.push(`fsync:${descriptorPaths.get(descriptor)}`);
      originalFsync(descriptor);
    }) as typeof fs.fsyncSync);
    const rename = spyOn(fs, 'renameSync').mockImplementation(((source: fs.PathLike, destination: fs.PathLike) => {
      events.push(`rename:${String(destination)}`);
      if (!failed && String(destination) === indexPath && fs.existsSync(markerPath)) {
        failed = true;
        throw new Error('simulated index publication failure');
      }
      return originalRename(source, destination);
    }) as typeof fs.renameSync);
    const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation((target => {
      events.push(`unlink:${String(target)}`);
      originalUnlink(target);
    }) as typeof fs.unlinkSync);
    try {
      expect(() => service.replace('rollback', 'notes', durable('after'), created.revision, created.file.contentHash)).toThrow('simulated');
    } finally {
      unlinkSpy.mockRestore();
      rename.mockRestore();
      fsyncSpy.mockRestore();
      openSpy.mockRestore();
      writeSpy.mockRestore();
    }
    expect(fs.readFileSync(contentPath, 'utf8')).toBe(durable('before'));
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(beforeIndex);
    expect(fs.existsSync(markerPath)).toBe(false);

    const initialMarkerWrite = requiredEventAfter(events, event => event.startsWith(`write:${markerPath}.tmp.`));
    const initialMarkerFileSync = requiredEventAfter(events, event => event.startsWith(`fsync:${markerPath}.tmp.`), initialMarkerWrite);
    const initialMarkerRename = requiredEventAfter(events, `rename:${markerPath}`, initialMarkerFileSync);
    const initialMarkerDirectorySync = process.platform === 'win32'
      ? initialMarkerRename
      : requiredEventAfter(events, `fsync:${contextPath}`, initialMarkerRename);
    const forwardContentWrite = requiredEventAfter(events, event => event.startsWith(`write:${contentPath}.tmp.`), initialMarkerDirectorySync);
    const forwardContentFileSync = requiredEventAfter(events, event => event.startsWith(`fsync:${contentPath}.tmp.`), forwardContentWrite);
    const forwardContentRename = requiredEventAfter(events, `rename:${contentPath}`, forwardContentFileSync);
    const forwardContentDirectorySync = process.platform === 'win32'
      ? forwardContentRename
      : requiredEventAfter(events, `fsync:${contextPath}`, forwardContentRename);
    const failedIndexWrite = requiredEventAfter(events, event => event.startsWith(`write:${indexPath}.tmp.`), forwardContentDirectorySync);
    const failedIndexFileSync = requiredEventAfter(events, event => event.startsWith(`fsync:${indexPath}.tmp.`), failedIndexWrite);
    const failedIndexRename = requiredEventAfter(events, `rename:${indexPath}`, failedIndexFileSync);
    const restoredMarkerWrite = requiredEventAfter(events, event => event.startsWith(`write:${markerPath}.tmp.`), failedIndexRename);
    const restoredMarkerFileSync = requiredEventAfter(events, event => event.startsWith(`fsync:${markerPath}.tmp.`), restoredMarkerWrite);
    const restoredMarkerRename = requiredEventAfter(events, `rename:${markerPath}`, restoredMarkerFileSync);
    const restoredMarkerDirectorySync = process.platform === 'win32'
      ? restoredMarkerRename
      : requiredEventAfter(events, `fsync:${contextPath}`, restoredMarkerRename);
    const rollbackContentWrite = requiredEventAfter(events, event => event.startsWith(`write:${contentPath}.tmp.`), restoredMarkerDirectorySync);
    const rollbackContentFileSync = requiredEventAfter(events, event => event.startsWith(`fsync:${contentPath}.tmp.`), rollbackContentWrite);
    const rollbackContentRename = requiredEventAfter(events, `rename:${contentPath}`, rollbackContentFileSync);
    const rollbackContentDirectorySync = process.platform === 'win32'
      ? rollbackContentRename
      : requiredEventAfter(events, `fsync:${contextPath}`, rollbackContentRename);
    const rollbackIndexWrite = requiredEventAfter(events, event => event.startsWith(`write:${indexPath}.tmp.`), rollbackContentDirectorySync);
    const rollbackIndexFileSync = requiredEventAfter(events, event => event.startsWith(`fsync:${indexPath}.tmp.`), rollbackIndexWrite);
    const rollbackIndexRename = requiredEventAfter(events, `rename:${indexPath}`, rollbackIndexFileSync);
    const rollbackIndexDirectorySync = process.platform === 'win32'
      ? rollbackIndexRename
      : requiredEventAfter(events, `fsync:${contextPath}`, rollbackIndexRename);
    const markerUnlink = requiredEventAfter(events, `unlink:${markerPath}`, rollbackIndexDirectorySync);
    if (process.platform !== 'win32') requiredEventAfter(events, `fsync:${contextPath}`, markerUnlink);
  });

  it('durably orders archive publication after the pending marker and before marker removal', () => {
    setupFeature('durable-order');
    const created = service.create('durable-order', 'notes', durable('archive me'));
    const contextPath = path.join(TEST_DIR, '.hive/features/durable-order/context');
    const markerPath = path.join(contextPath, '.managed-mutation-pending.json');
    const descriptorPaths = new Map<number, string>();
    const events: string[] = [];
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeFileSync;
    const originalFsync = fs.fsyncSync;
    const originalRename = fs.renameSync;
    const originalCopy = fs.copyFileSync;
    const originalUnlink = fs.unlinkSync;
    const originalMkdir = fs.mkdirSync;
    const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(((target, data, options) => {
      events.push(`write:${String(target)}`);
      originalWrite(target, data, options as never);
    }) as typeof fs.writeFileSync);
    const openSpy = spyOn(fs, 'openSync').mockImplementation(((target, flags, mode) => {
      const descriptor = originalOpen(target, flags, mode);
      descriptorPaths.set(descriptor, String(target));
      return descriptor;
    }) as typeof fs.openSync);
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((descriptor => {
      events.push(`fsync:${descriptorPaths.get(descriptor)}`);
      originalFsync(descriptor);
    }) as typeof fs.fsyncSync);
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((source, destination) => {
      events.push(`rename:${String(destination)}`);
      originalRename(source, destination);
    }) as typeof fs.renameSync);
    const copySpy = spyOn(fs, 'copyFileSync').mockImplementation(((source, destination, mode) => {
      events.push(`copy:${String(destination)}`);
      originalCopy(source, destination, mode);
    }) as typeof fs.copyFileSync);
    const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation((target => {
      events.push(`unlink:${String(target)}`);
      originalUnlink(target);
    }) as typeof fs.unlinkSync);
    const mkdirSpy = spyOn(fs, 'mkdirSync').mockImplementation(((target, options) => {
      events.push(`mkdir:${String(target)}`);
      return originalMkdir(target, options as never);
    }) as typeof fs.mkdirSync);

    let archived;
    try {
      archived = service.archiveSelected('durable-order', ['notes'], 'durability check', created.revision, { notes: created.file.contentHash });
    } finally {
      mkdirSpy.mockRestore();
      unlinkSpy.mockRestore();
      copySpy.mockRestore();
      renameSpy.mockRestore();
      fsyncSpy.mockRestore();
      openSpy.mockRestore();
      writeSpy.mockRestore();
    }

    const destination = archived!.archived[0]!.archivePath;
    const featurePath = path.join(TEST_DIR, '.hive/features/durable-order');
    const archiveRoot = path.join(featurePath, 'archive');
    const archiveDirectory = path.dirname(destination);
    const source = path.join(contextPath, 'notes.md');
    const indexPath = path.join(contextPath, 'index.json');
    const manifestPath = path.join(archiveRoot, 'context-index.json');
    const markerWrite = requiredEventAfter(events, event => event.startsWith(`write:${markerPath}.tmp.`));
    const markerFileSync = requiredEventAfter(events, event => event.startsWith(`fsync:${markerPath}.tmp.`), markerWrite);
    const markerRename = requiredEventAfter(events, `rename:${markerPath}`, markerFileSync);
    const markerDirectorySync = process.platform === 'win32'
      ? markerRename
      : requiredEventAfter(events, `fsync:${contextPath}`, markerRename);
    const archiveRootMkdir = requiredEventAfter(events, `mkdir:${archiveRoot}`, markerDirectorySync);
    const featureDirectorySync = process.platform === 'win32'
      ? archiveRootMkdir
      : requiredEventAfter(events, `fsync:${featurePath}`, archiveRootMkdir);
    const archiveDirectoryMkdir = requiredEventAfter(events, `mkdir:${archiveDirectory}`, featureDirectorySync);
    const archiveRootSync = process.platform === 'win32'
      ? archiveDirectoryMkdir
      : requiredEventAfter(events, `fsync:${archiveRoot}`, archiveDirectoryMkdir);
    const archiveCopy = requiredEventAfter(events, `copy:${destination}`, archiveRootSync);
    const archiveFileSync = requiredEventAfter(events, `fsync:${destination}`, archiveCopy);
    const archiveDirectorySync = process.platform === 'win32'
      ? archiveFileSync
      : requiredEventAfter(events, `fsync:${archiveDirectory}`, archiveFileSync);
    const sourceUnlink = requiredEventAfter(events, `unlink:${source}`, archiveDirectorySync);
    const sourceDirectorySync = process.platform === 'win32'
      ? sourceUnlink
      : requiredEventAfter(events, `fsync:${contextPath}`, sourceUnlink);
    const indexWrite = requiredEventAfter(events, event => event.startsWith(`write:${indexPath}.tmp.`), sourceDirectorySync);
    const indexFileSync = requiredEventAfter(events, event => event.startsWith(`fsync:${indexPath}.tmp.`), indexWrite);
    const indexRename = requiredEventAfter(events, `rename:${indexPath}`, indexFileSync);
    const indexDirectorySync = process.platform === 'win32'
      ? indexRename
      : requiredEventAfter(events, `fsync:${contextPath}`, indexRename);
    const manifestWrite = requiredEventAfter(events, event => event.startsWith(`write:${manifestPath}.tmp.`), indexDirectorySync);
    const manifestFileSync = requiredEventAfter(events, event => event.startsWith(`fsync:${manifestPath}.tmp.`), manifestWrite);
    const manifestRename = requiredEventAfter(events, `rename:${manifestPath}`, manifestFileSync);
    const manifestDirectorySync = process.platform === 'win32'
      ? manifestRename
      : requiredEventAfter(events, `fsync:${archiveRoot}`, manifestRename);
    const markerUnlink = requiredEventAfter(events, `unlink:${markerPath}`, manifestDirectorySync);
    if (process.platform !== 'win32') requiredEventAfter(events, `fsync:${contextPath}`, markerUnlink);
  });

  it('restores a durable pending marker when marker-removal durability is uncertain', () => {
    if (process.platform === 'win32') return;
    setupFeature('uncertain-marker-removal');
    const created = service.create('uncertain-marker-removal', 'notes', durable('before'));
    const contextPath = path.join(TEST_DIR, '.hive/features/uncertain-marker-removal/context');
    const markerPath = path.join(contextPath, '.managed-mutation-pending.json');
    const descriptorPaths = new Map<number, string>();
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const originalUnlink = fs.unlinkSync;
    const originalRename = fs.renameSync;
    const events: string[] = [];
    let markerUnlinked = false;
    let failed = false;
    const openSpy = spyOn(fs, 'openSync').mockImplementation(((target, flags, mode) => {
      const descriptor = originalOpen(target, flags, mode);
      descriptorPaths.set(descriptor, String(target));
      return descriptor;
    }) as typeof fs.openSync);
    const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation((target => {
      events.push(`unlink:${String(target)}`);
      if (String(target) === markerPath) markerUnlinked = true;
      originalUnlink(target);
    }) as typeof fs.unlinkSync);
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((source, destination) => {
      events.push(`rename:${String(destination)}`);
      originalRename(source, destination);
    }) as typeof fs.renameSync);
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((descriptor => {
      events.push(`fsync:${descriptorPaths.get(descriptor)}`);
      if (!failed && markerUnlinked && descriptorPaths.get(descriptor) === contextPath) {
        failed = true;
        throw new Error('simulated uncertain marker removal');
      }
      originalFsync(descriptor);
    }) as typeof fs.fsyncSync);

    try {
      expect(() => service.replace(
        'uncertain-marker-removal', 'notes', durable('after'), created.revision, created.file.contentHash,
      )).toThrow('uncertain marker removal');
    } finally {
      fsyncSpy.mockRestore();
      renameSpy.mockRestore();
      unlinkSpy.mockRestore();
      openSpy.mockRestore();
    }
    const contentPath = path.join(contextPath, 'notes.md');
    const indexPath = path.join(contextPath, 'index.json');
    const initialMarkerRename = requiredEventAfter(events, `rename:${markerPath}`);
    const initialMarkerDirectorySync = requiredEventAfter(events, `fsync:${contextPath}`, initialMarkerRename);
    const forwardContentRename = requiredEventAfter(events, `rename:${contentPath}`, initialMarkerDirectorySync);
    const forwardContentDirectorySync = requiredEventAfter(events, `fsync:${contextPath}`, forwardContentRename);
    const forwardIndexRename = requiredEventAfter(events, `rename:${indexPath}`, forwardContentDirectorySync);
    const forwardIndexDirectorySync = requiredEventAfter(events, `fsync:${contextPath}`, forwardIndexRename);
    const markerUnlink = requiredEventAfter(events, `unlink:${markerPath}`, forwardIndexDirectorySync);
    const failedMarkerRemovalSync = requiredEventAfter(events, `fsync:${contextPath}`, markerUnlink);
    const markerRepublishFileSync = requiredEventAfter(events, event => event.startsWith(`fsync:${markerPath}.tmp.`), failedMarkerRemovalSync);
    const markerRepublish = requiredEventAfter(events, `rename:${markerPath}`, markerRepublishFileSync);
    const markerRepublishDirectorySync = requiredEventAfter(events, `fsync:${contextPath}`, markerRepublish);
    const rollbackContentRename = requiredEventAfter(events, `rename:${contentPath}`, markerRepublishDirectorySync);
    const rollbackContentDirectorySync = requiredEventAfter(events, `fsync:${contextPath}`, rollbackContentRename);
    const rollbackIndexRename = requiredEventAfter(events, `rename:${indexPath}`, rollbackContentDirectorySync);
    requiredEventAfter(events, `fsync:${contextPath}`, rollbackIndexRename);
    expect(fs.readFileSync(path.join(contextPath, 'notes.md'), 'utf8')).toBe(durable('before'));
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(() => service.readSummary('uncertain-marker-removal')).toThrow('reconcile');
  });

  it('fully rolls back archive directories created before a directory flush failure', () => {
    if (process.platform === 'win32') return;
    setupFeature('archive-directory-rollback');
    const created = service.create('archive-directory-rollback', 'notes', durable('before'));
    const featurePath = path.join(TEST_DIR, '.hive/features/archive-directory-rollback');
    const contextPath = path.join(featurePath, 'context');
    const markerPath = path.join(contextPath, '.managed-mutation-pending.json');
    const descriptorPaths = new Map<number, string>();
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    let failed = false;
    const openSpy = spyOn(fs, 'openSync').mockImplementation(((target, flags, mode) => {
      const descriptor = originalOpen(target, flags, mode);
      descriptorPaths.set(descriptor, String(target));
      return descriptor;
    }) as typeof fs.openSync);
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((descriptor => {
      if (!failed && fs.existsSync(markerPath) && descriptorPaths.get(descriptor) === featurePath) {
        failed = true;
        throw new Error('simulated archive parent flush failure');
      }
      originalFsync(descriptor);
    }) as typeof fs.fsyncSync);

    try {
      expect(() => service.archiveSelected(
        'archive-directory-rollback', ['notes'], 'rollback directory', created.revision, { notes: created.file.contentHash },
      )).toThrow('archive parent flush failure');
    } finally {
      fsyncSpy.mockRestore();
      openSpy.mockRestore();
    }
    expect(service.read('archive-directory-rollback', 'notes')).toBe(durable('before'));
    expect(fs.existsSync(path.join(featurePath, 'archive'))).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('paginates complete durable catalogs and invalidates cursors on index-only classification drift', () => {
    setupFeature('catalog');
    for (let index = 0; index < 7; index += 1) service.create('catalog', `note-${index}`, durable(`body-${index}`, `Description ${index}`));
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = service.readCatalog('catalog', { cursor, limit: 2 });
      expect(page.hasMore).toBe(!page.complete);
      names.push(...page.files.map(file => file.name));
      cursor = page.nextCursor;
      if (!cursor) expect(page.complete).toBe(true);
    } while (cursor);
    expect(names).toEqual(['note-0', 'note-1', 'note-2', 'note-3', 'note-4', 'note-5', 'note-6']);
    expect(service.readCatalog('catalog', { query: 'DESCRIPTION 6', limit: 1 })).toMatchObject({
      files: [{ name: 'note-6' }],
      searchedFields: ['name', 'description', 'read_when'],
      hasMore: false,
    });
    const ownerOnly = service.create(
      { type: 'project' },
      'owner-only',
      '---\ndescription: ordinary\nread_when: ordinary\nowner: unique-owner-search-value\nreview_after: 2026-09-30\n---\n\nbody',
    );
    expect(ownerOnly.file.owner).toBe('unique-owner-search-value');
    expect(service.readCatalog({ type: 'project' }, { query: 'unique-owner-search-value' })).toMatchObject({
      files: [], searchedFields: ['name', 'description', 'read_when'], complete: true, hasMore: false,
    });

    const first = service.readCatalog('catalog', { limit: 1 });
    const indexPath = path.join(TEST_DIR, '.hive/features/catalog/context/index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    index.entries['note-1'].kind = 'evidence';
    fs.writeFileSync(indexPath, JSON.stringify(index));
    expect(() => service.readCatalog('catalog', { cursor: first.nextCursor, limit: 1 })).toThrow('cursor');
    const unsupported = Buffer.from(JSON.stringify({ version: 2 })).toString('base64url');
    expect(() => service.readCatalog('catalog', { cursor: unsupported })).toThrow('unsupported version');
  });

  it('pages all-classification management listings with aggregate metrics and kind-bound cursors', () => {
    setupFeature('management-pages');
    for (let index = 0; index < 12; index++) service.create('management-pages', `note-${String(index).padStart(2, '0')}`, durable(`body-${index}`));
    service.create('management-pages', 'proof', 'proof', { kind: 'evidence' });
    service.create('management-pages', 'overview', '# Overview');
    const first = service.readManagementCatalog('management-pages', { limit: 5 });
    expect(first.totalFiles).toBe(14);
    expect(first.files.map(file => file.name)).toEqual(['note-00', 'note-01', 'note-02', 'note-03', 'note-04']);
    expect(first.complete).toBe(false);
    expect(first.hasMore).toBe(true);
    expect(first.durable.fileCount).toBe(12);
    expect(first.durable.governanceIssues).toBe(0);
    expect(first.durable.chars).toBeNull();
    expect(first.durable.charsMeasurement).toBe('unavailable');

    const names: string[] = [];
    let cursor: string | undefined = first.nextCursor;
    while (cursor) {
      const page = service.readManagementCatalog('management-pages', { cursor, limit: 5 });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16 * 1024);
      names.push(...page.files.map(file => file.name));
      cursor = page.nextCursor;
      expect(page.hasMore).toBe(!page.complete);
      if (!cursor) expect(page.complete).toBe(true);
    }
    expect(names).toEqual([
      'note-05', 'note-06', 'note-07', 'note-08', 'note-09', 'note-10', 'note-11', 'overview', 'proof',
    ]);

    expect(() => service.readCatalog('management-pages', { cursor: first.nextCursor })).toThrow('cursor');
    const catalogCursor = service.readCatalog('management-pages', { limit: 1 }).nextCursor!;
    expect(() => service.readManagementCatalog('management-pages', { cursor: catalogCursor })).toThrow('cursor');

    const scanned = service.readManagementCatalog('management-pages', { scanChars: true });
    expect(scanned.durable.charsMeasurement).toBe('current');
    expect(scanned.durable.chars).toBeGreaterThan(0);

    const indexPath = path.join(TEST_DIR, '.hive/features/management-pages/context/index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    index.entries['note-06'].kind = 'evidence';
    fs.writeFileSync(indexPath, JSON.stringify(index));
    expect(() => service.readManagementCatalog('management-pages', { cursor: first.nextCursor, limit: 5 })).toThrow('cursor');
  });

  it('reports project governance gaps in management metrics regardless of page position', () => {
    setupFeature('management-governance');
    for (let index = 0; index < 12; index++) {
      service.create({ type: 'project' }, `governed-${String(index).padStart(2, '0')}`, projectDurable('body'));
    }
    seedLegacyProject('management-governance', 'z-ungoverned', durable('body'));
    const page = service.readManagementCatalog({ type: 'project' }, { limit: 10 });
    expect(page.totalFiles).toBe(13);
    expect(page.files.some(file => file.name === 'z-ungoverned')).toBe(false);
    expect(page.durable.governanceIssues).toBe(1);
    expect(page.durable.warnings.join('\n')).toContain('z-ungoverned');
  });

  it('fails management listings explicitly when aggregate metrics exceed the response bound', () => {
    setupFeature('management-oversized');
    for (let index = 0; index < 300; index++) {
      seedLegacyProject('management-oversized', `note-${String(index).padStart(3, '0')}`, durable('body'));
    }
    try {
      service.readManagementCatalog({ type: 'project' }, { limit: 10 });
      throw new Error('expected the oversized management listing to fail');
    } catch (error) {
      expect((error as { reason?: string }).reason).toBe('context_inventory_too_large');
    }
  });

  it('aborts namespace and recovery enumeration while streaming the first over-limit entry', () => {
    setupFeature('streaming-inventory-limit');
    const contextPath = path.join(TEST_DIR, '.hive/features/streaming-inventory-limit/context');
    fs.mkdirSync(contextPath, { recursive: true });
    let reads = 0;
    let closes = 0;
    let markdownEntries = false;
    const opendir = spyOn(fs, 'opendirSync').mockImplementation((() => ({
      readSync() {
        reads += 1;
        return {
          name: `entry-${reads}${markdownEntries ? '.md' : ''}`,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        };
      },
      closeSync() { closes += 1; },
    })) as unknown as typeof fs.opendirSync);
    try {
      expect(() => service.readSummary('streaming-inventory-limit')).toThrow('namespace');
      expect(reads).toBe(CONTEXT_NAMESPACE_ENTRY_MAX + 1);
      expect(closes).toBe(1);

      reads = 0;
      expect(() => service.readRecoverySummary('streaming-inventory-limit', { diagnosticMode: 'primary-management' }))
        .toThrow('namespace');
      expect(reads).toBe(CONTEXT_NAMESPACE_ENTRY_MAX + 1);
      expect(closes).toBe(2);

      reads = 0;
      markdownEntries = true;
      expect(() => service.readSummary('streaming-inventory-limit')).toThrow('Markdown candidates');
      expect(reads).toBe(CONTEXT_CANDIDATE_MAX + 1);
      expect(closes).toBe(3);
    } finally {
      opendir.mockRestore();
    }
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
      expect(read.range.endByte).toBeGreaterThan(offset);
      expect(read.range.startByte).toBe(offset);
      offset = read.range.endByte;
    } while (true);
    expect(reconstructed).toBe(content);
    expect(expectedHash).toBe(createHash('sha256').update(Buffer.from(content)).digest('hex'));

    service.create('chunks', 'empty', '', { kind: 'evidence' });
    expect(service.readContent('chunks', 'empty')).toMatchObject({ complete: true, range: { startByte: 0, endByte: 0, totalBytes: 0 }, file: { content: '' } });

    const template = service.readContent('chunks', 'raw', { maxBytes: 1024 })!;
    const zeroProgressEnvelope = {
      ...template,
      file: { ...template.file, content: '' },
      range: { startByte: 0, endByte: 0, totalBytes: Buffer.byteLength(content) },
      complete: false,
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
    const datedService = new ContextService(PROJECT_ROOT, () => new Date('2026-09-14T12:00:00.000Z'));
    datedService.create({ type: 'project' }, 'review-due-today', projectDurable('due', '2026-09-14'));
    datedService.create({ type: 'project' }, 'review-due-future', projectDurable('fresh', '2026-09-15'));
    const governance = datedService.readSummary({ type: 'project' }).durable;
    expect(governance.governanceIssues).toBe(1);
    expect(governance.warnings.join('\n')).toContain('review-due-today');
    expect(governance.warnings.join('\n')).not.toContain('review-due-future');
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
    const replacement = durable('replacement bytes');
    const result = service.write('write-overwrite', 'contract.md', replacement, current.revision, current.file.contentHash!);

    expect(result).toContain(path.join('context', 'contract.md'));
    expect(service.read('write-overwrite', 'contract')).toBe(replacement);
    expect(service.readSummary('write-overwrite')).toMatchObject({
      revision: 2,
      durable: { fileCount: 1, chars: null, bytes: Buffer.byteLength(replacement) },
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

  it('returns the empty compatibility archive shape without creating an archive path', () => {
    setupFeature('archive-empty');

    expect(service.archive('archive-empty', service.readSummary('archive-empty').revision, {})).toEqual({
      archived: [],
      archivePath: '',
    });
  });

  it('reports empty and timestamp-ordered compatibility stats with exact character totals', () => {
    setupFeature('stats');
    expect(service.stats('stats')).toEqual({ count: 0, totalChars: 0 });

    seedLegacy('stats', 'first', 'a'.repeat(100));
    seedLegacy('stats', 'second', 'b'.repeat(200));
    seedLegacy('stats', 'third', 'c'.repeat(300));
    const contextPath = path.join(TEST_DIR, '.hive/features/stats/context');
    const now = Date.now();
    fs.utimesSync(path.join(contextPath, 'first.md'), (now - 2000) / 1000, (now - 2000) / 1000);
    fs.utimesSync(path.join(contextPath, 'second.md'), (now - 1000) / 1000, (now - 1000) / 1000);
    fs.utimesSync(path.join(contextPath, 'third.md'), now / 1000, now / 1000);

    expect(service.stats('stats')).toEqual({ count: 3, totalChars: 600, oldest: 'first', newest: 'third' });
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
    const originalOpendirSync = fs.opendirSync;
    let observations = 0;
    const opendirSpy = spyOn(fs, 'opendirSync').mockImplementation(((targetPath, options) => {
      if (String(targetPath) === contextPath) {
        observations += 1;
        expect(fs.existsSync(lockPath)).toBe(false);
      }
      return originalOpendirSync(targetPath, options as never);
    }) as typeof fs.opendirSync);

    try {
      expect(service.list('locked-reads')).toHaveLength(1);
      expect(service.getOverview('locked-reads')).toBeNull();
      expect(service.stats('locked-reads').count).toBe(1);
      expect(service.readSummary('locked-reads').files).toHaveLength(1);
      expect(service.readContent('locked-reads', 'notes')?.file.content).toBe(durable('snapshot bytes'));
    } finally {
      opendirSpy.mockRestore();
    }

    expect(observations).toBeGreaterThanOrEqual(5);
  });

  it('creates evidence without exposing it to execution or network context', () => {
    setupFeature('evidence');
    service.create('evidence', 'verification-log', 'raw output', { kind: 'evidence', task: '01-test' });
    service.create('evidence', 'contract', durable('current contract'));

    expect(service.readCatalog('evidence').files.map(file => file.name)).toEqual(['contract']);
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
    const shrink = service.replace('over-limit', 'legacy-0', durable('shorter'), 0, read.file.contentHash!);
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
    expect(service.replace('file-count-overage', 'legacy-0', durable('xx'), 0, read.file.contentHash!).revision).toBe(1);
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

  it('archives at most 50 selected names', () => {
    setupFeature('archive-name-limit');
    const hashes: Record<string, string> = {};
    let revision = 0;
    const names = Array.from({ length: 50 }, (_, index) => `note-${String(index).padStart(2, '0')}`);
    for (const name of names) {
      const created = service.create('archive-name-limit', name, 'evidence', { kind: 'evidence' });
      hashes[name] = created.file.contentHash;
      revision = created.revision;
    }
    hashes['one-too-many'] = '0'.repeat(64);

    expect(() => service.archiveSelected(
      'archive-name-limit',
      [...names, 'one-too-many'],
      'too many names',
      revision,
      hashes,
    )).toThrow('At most 50 archive names');
    expect(service.readSummary('archive-name-limit').files).toHaveLength(50);

    const archived = service.archiveSelected('archive-name-limit', names, 'bounded archive', revision, hashes);
    expect(archived.archived).toHaveLength(50);
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
      durable('y'.repeat(5001)),
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
      durable('y'),
      evidence.revision,
      evidence.file.contentHash,
      { kind: 'durable' },
    );
    expect(transitioned.revision).toBe(2);
    expect(service.read('cross-cap-transition', 'raw-log')).toBe(durable('y'));
  });

});
