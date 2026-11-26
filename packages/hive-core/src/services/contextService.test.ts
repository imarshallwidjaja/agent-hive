import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ContextService, CONTEXT_CANDIDATE_MAX, CONTEXT_NAMESPACE_ENTRY_MAX } from './contextService.js';
import { acquireLockSync, FeatureResolutionError, getProjectContextPath, probeLock } from '../utils/paths.js';
import { resolveLockAnchor } from '../utils/nativeLock.js';

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
  }, 60000);

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
  }, 60000);

  it('defaults catalog pages to ten and caps requested pages at fifty', () => {
    setupFeature('page-limits');
    for (let index = 0; index < 65; index++) service.create('page-limits', `n${index}`, durable(''));
    expect(service.readCatalog('page-limits').files).toHaveLength(10);
    // Response-size admission may impose a tighter bound than the entry limit.
    expect(service.readCatalog('page-limits', { limit: 1000 }).files.length).toBeLessThanOrEqual(50);
  }, 60000);

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
    });
  });

  it('summarizes absent and read-only context without filesystem writes or lock acquisition', () => {
    setupFeature('inspection');
    const contextPath = path.join(TEST_DIR, '.hive/features/inspection/context');
    const before = fs.readdirSync(path.dirname(contextPath));
    expect(service.readSummary('inspection', { scanChars: true }).files).toEqual([]);
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
      const summary = service.readSummary('inspection', { scanChars: true });
      expect(summary.durable.chars).toBe(durable('é😀').length);
      expect(summary.files.find(file => file.name === 'notes')?.bytes).toBe(Buffer.byteLength(durable('é😀')));
      expect(summary.files.find(file => file.name === 'proof')?.role).toBe('evidence');
      expect(writerOpens).toBe(0);
    } finally { open.mockRestore(); fs.chmodSync(contextPath, 0o755); }
  });

  it('rejects unstable summary snapshots and transient missing files without partial results', () => {
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
      expect(() => service.readSummary('inspection', { scanChars: true })).toThrow('moved by archive');
      expect(reads).toBe(1);
    } finally { read.mockRestore(); }
    let indexReads = 0;
    const originalRead = fs.readFileSync;
    const changing = spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      const value = (originalRead as any)(file, ...args);
      if (String(file).endsWith('index.json')) return Buffer.from(JSON.stringify({ ...JSON.parse(value), revision: ++indexReads }));
      return value;
    }) as any);
    try {
      expect(() => service.readSummary('inspection', { scanChars: true })).toThrow(expect.objectContaining({ reason: 'context_changed_during_read' }));
    } finally { changing.mockRestore(); }
  });

  it('rejects invalid index shapes in summaries without writes or lock acquisition', () => {
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
        expect(() => service.readSummary('inspection', { scanChars: true })).toThrow('Context index');
        // Nothing is opened for writing or created.
        const writeFlags = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT;
        expect(open.mock.calls.filter(([, flags]) => typeof flags !== 'number' || (flags & writeFlags) !== 0)).toEqual([]);
        expect(probeLock(indexPath)).toBe('free');
        expect(write).not.toHaveBeenCalled();
      } finally { open.mockRestore(); write.mockRestore(); }
      expect(fs.readFileSync(indexPath, 'utf8')).toBe(text);
      expect(fs.readFileSync(path.join(contextPath, 'notes.md'), 'utf8')).toBe(durable('preserved'));
    }
  });

  it('preserves reserved handling for overview, draft, and execution decisions', () => {
    const featureName = 'classified-context';
    setupFeature(featureName);

    seedLegacy(featureName, 'overview', 'Human-facing summary');
    seedLegacy(featureName, 'draft', 'Scratchpad notes');
    seedLegacy(featureName, 'execution-decisions', 'Operational note');
    seedLegacy(featureName, 'learnings', 'Durable learning');

    expect(service.readSummary(featureName).files.map(file => [
      file.name,
      file.role,
    ])).toEqual([
      ['draft', 'scratchpad'],
      ['execution-decisions', 'operational'],
      ['learnings', 'durable'],
      ['overview', 'operational'],
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
    expect(evidence.file).toMatchObject({ kind: 'evidence', role: 'evidence' });
  });

  it('requires the actual named-read hash for existing-content mutations', () => {
    setupFeature('hash-guard');
    const created = service.create('hash-guard', 'notes', durable('one'));
    const read = service.readContent('hash-guard', 'notes');
    expect(read?.file.contentHash).toMatch(/^[a-f0-9]{64}$/);

    expect(() => service.replace('hash-guard', 'notes', durable('two'), created.revision, '')).toThrow('expectedContentHash must be exactly 64 lowercase hexadecimal characters');
    fs.appendFileSync(path.join(TEST_DIR, '.hive/features/hash-guard/context/notes.md'), '\nexternal');
    expect(() => service.replace(
      'hash-guard',
      'notes',
      durable('two'),
      created.revision,
      read!.file.contentHash,
    )).toThrow('the file changed after it was read');
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
    expect(diagnostic?.file).toMatchObject({ content: interrupted, role: 'operational' });
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

  // Publishing operations whose failure must restore the exact prior bytes or keep the marker. The edit row carries
  // mixed CRLF and Unicode so the byte comparison covers what a text comparison could normalize.
  type PublicationRow = [label: string, row: { prior: string; run: (feature: string, created: ReturnType<ContextService['create']>) => unknown }];
  const PUBLICATION_ROWS: PublicationRow[] = [
    ['replace', { prior: durable('before'), run: (feature, created) => service.replace(feature, 'notes', durable('after'), created.revision, created.file.contentHash) }],
    ['edit', { prior: durable('before\r\n\u{1F600} tail'), run: (feature, created) => service.edit(feature, 'notes', 'before', 'after', created.revision, created.file.contentHash) }],
  ];

  it.each(PUBLICATION_ROWS)('clears the pending marker only after a proven content/index rollback (%s)', (_label, row) => {
    setupFeature('rollback');
    const created = service.create('rollback', 'notes', row.prior);
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
      expect(() => row.run('rollback', created)).toThrow('simulated');
    } finally {
      unlinkSpy.mockRestore();
      rename.mockRestore();
      fsyncSpy.mockRestore();
      openSpy.mockRestore();
      writeSpy.mockRestore();
    }
    expect(fs.readFileSync(contentPath).equals(Buffer.from(row.prior, 'utf8'))).toBe(true);
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

  it.each(PUBLICATION_ROWS)('restores a durable pending marker when marker-removal durability is uncertain (%s)', (_label, row) => {
    if (process.platform === 'win32') return;
    setupFeature('uncertain-marker-removal');
    const created = service.create('uncertain-marker-removal', 'notes', row.prior);
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
      expect(() => row.run('uncertain-marker-removal', created)).toThrow('uncertain marker removal');
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
    expect(fs.readFileSync(path.join(contextPath, 'notes.md')).equals(Buffer.from(row.prior, 'utf8'))).toBe(true);
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
    const readChunks = (name: string) => {
      let offset = 0;
      let reconstructed = '';
      let expectedHash = '';
      let revision = -1;
      do {
        const read = service.readContent('chunks', name, { offset, maxBytes: 1024 })!;
        const serialized = JSON.stringify(read);
        expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(1024);
        // The guard precedes the body: file is the last envelope key, and content the last file key.
        expect(Object.keys(read)).toEqual(['scope', 'revision', 'snapshot', 'range', 'complete', 'file']);
        expect(Object.keys(read.file).indexOf('contentHash')).toBe(1);
        expect(Object.keys(read.file).at(-1)).toBe('content');
        expect(serialized.indexOf('"contentHash"')).toBeLessThan(serialized.indexOf('"content":'));
        expect(read.range.startByte).toBe(offset);
        // Each chunk's text re-encodes to exactly the byte range it reports, so no character is dropped.
        expect(Buffer.byteLength(read.file.content, 'utf8')).toBe(read.range.endByte - read.range.startByte);
        reconstructed += read.file.content;
        expectedHash ||= read.file.contentHash!;
        revision = read.revision;
        expect(read.file.contentHash).toBe(expectedHash);
        if (read.complete) break;
        expect(read.range.endByte).toBeGreaterThan(offset);
        offset = read.range.endByte;
      } while (true);
      return { content: reconstructed, hash: expectedHash, revision };
    };
    const content = `${'quoted "\\\n'.repeat(700)}😀tail`;
    service.create('chunks', 'raw', content, { kind: 'evidence' });
    const raw = readChunks('raw');
    expect(raw.content).toBe(content);
    expect(raw.hash).toBe(createHash('sha256').update(Buffer.from(content)).digest('hex'));

    // A leading BOM and a later U+FEFF that starts a chunk are document bytes, not decoder framing.
    const bom = '\uFEFF';
    const marked = `${bom}${'line\n'.repeat(400)}${bom}after\n${'more\n'.repeat(400)}`;
    service.create('chunks', 'marked', marked, { kind: 'evidence' });
    expect(service.readContent('chunks', 'marked')!.file.content).toBe(marked);
    const laterMark = Buffer.byteLength(marked.slice(0, marked.indexOf(bom, 1)), 'utf8');
    const fromMark = service.readContent('chunks', 'marked', { offset: laterMark })!;
    expect(fromMark.file.content).toBe(marked.slice(marked.indexOf(bom, 1)));
    expect(service.readContent('chunks', 'marked', { offset: laterMark, maxBytes: 1024 })!.file.content.startsWith(`${bom}after`)).toBe(true);
    const chunked = readChunks('marked');
    expect(chunked.content).toBe(marked);
    expect(chunked.hash).toBe(createHash('sha256').update(Buffer.from(marked)).digest('hex'));
    // A whole-document replacement built from the complete read keeps both marks.
    service.replace('chunks', 'marked', chunked.content.replace('after', 'later'), chunked.revision, chunked.hash);
    expect(fs.readFileSync(path.join(TEST_DIR, '.hive/features/chunks/context/marked.md')).equals(Buffer.from(marked.replace('after', 'later'), 'utf8'))).toBe(true);

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

  it('invalidates held revisions and removes index metadata when a file is archived', () => {
    setupFeature('archive-index');
    const kept = service.create('archive-index', 'kept', durable('kept'));
    const created = service.create('archive-index', 'notes', 'archive me', { kind: 'evidence' });

    expect(service.archiveSelected('archive-index', ['notes'], 'done', created.revision, { notes: created.file.contentHash }).revision).toBe(3);
    expect(service.readSummary('archive-index')).toMatchObject({ revision: 3, files: [{ name: 'kept' }] });
    // The revision held before the archive is stale for the document that stayed active.
    expect(() => service.replace('archive-index', 'kept', durable('stale'), created.revision, kept.file.contentHash))
      .toThrow('current revision is 3');
    expect(service.read('archive-index', 'kept')).toBe(durable('kept'));
    const indexPath = path.join(TEST_DIR, '.hive', 'features', 'archive-index', 'context', 'index.json');
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf-8')).entries).not.toHaveProperty('notes');
  });

  it.each(['replace', 'archiveSelected'] as const)('requires caller revision and actual hashes on %s', operation => {
    setupFeature('guarded-mutation');
    const created = service.create('guarded-mutation', 'notes', durable('original'));
    const invoke = (revision: unknown, hash: unknown) => {
      if (operation === 'replace') return service.replace('guarded-mutation', 'notes', durable('replacement'), revision as number, hash as string);
      return service.archiveSelected('guarded-mutation', ['notes'], 'retired', revision as number, hash === undefined ? undefined as any : { notes: hash as string });
    };
    const contextPath = path.join(TEST_DIR, '.hive/features/guarded-mutation/context');
    const indexBefore = fs.readFileSync(path.join(contextPath, 'index.json'));
    for (const revision of [undefined, null, -1, created.revision - 1]) {
      expect(() => invoke(revision, created.file.contentHash)).toThrow();
    }
    expect(() => invoke(created.revision, undefined)).toThrow(/expectedContentHash must be exactly 64 lowercase hexadecimal characters|Expected content hashes are required/);
    fs.writeFileSync(path.join(contextPath, 'notes.md'), 'external edit');
    expect(() => invoke(created.revision, created.file.contentHash)).toThrow();
    expect(fs.readFileSync(path.join(contextPath, 'notes.md'), 'utf8')).toBe('external edit');
    expect(fs.readFileSync(path.join(contextPath, 'index.json'))).toEqual(indexBefore);
    expect(fs.existsSync(path.join(contextPath, '.managed-mutation-pending.json'))).toBe(false);
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

  it('performs public reads without writer locks', () => {
    setupFeature('locked-reads');
    service.create('locked-reads', 'notes', durable('snapshot bytes'));
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'locked-reads', 'context');
    const indexPath = path.join(contextPath, 'index.json');
    const originalOpendirSync = fs.opendirSync;
    let observations = 0;
    const opendirSpy = spyOn(fs, 'opendirSync').mockImplementation(((targetPath, options) => {
      if (String(targetPath) === contextPath) {
        observations += 1;
        expect(probeLock(indexPath)).toBe('free');
      }
      return originalOpendirSync(targetPath, options as never);
    }) as typeof fs.opendirSync);

    try {
      expect(service.readSummary('locked-reads').files).toHaveLength(1);
      expect(service.readContent('locked-reads', 'notes')?.file.content).toBe(durable('snapshot bytes'));
    } finally {
      opendirSpy.mockRestore();
    }

    expect(observations).toBeGreaterThanOrEqual(2);
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

    // A leading BOM is a document byte: the append keeps the prior bytes as a prefix and hashes what it wrote.
    const marked = Buffer.from('\uFEFFraw\r\nline\n', 'utf8');
    const evidence = service.create('append', 'log', marked.toString('utf8'), { kind: 'evidence' });
    const appended = service.append('append', 'log', 'more', evidence.revision, evidence.file.contentHash);
    const written = fs.readFileSync(path.join(TEST_DIR, '.hive', 'features', 'append', 'context', 'log.md'));
    expect(written.subarray(0, marked.length).equals(marked)).toBe(true);
    expect(written.equals(Buffer.concat([marked, Buffer.from('\n<!-- appended 2026-09-07T01:02:03.000Z -->\nmore\n', 'utf8')]))).toBe(true);
    expect(appended.file.contentHash).toBe(createHash('sha256').update(written).digest('hex'));
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
  }, 60000);

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

describe('ContextService guarded exact-text edit', () => {
  let service: ContextService;
  const featureName = 'edit';
  const contextPath = path.join(TEST_DIR, '.hive/features', featureName, 'context');
  const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
  const reasonOf = (action: () => unknown): string | undefined => {
    try { action(); } catch (error) { return (error as { reason?: string }).reason ?? (error as Error).message; }
    return undefined;
  };
  const snapshot = (directory: string, name: string) => ({
    document: fs.existsSync(path.join(directory, `${name}.md`)) ? fs.readFileSync(path.join(directory, `${name}.md`)) : null,
    index: fs.existsSync(path.join(directory, 'index.json')) ? fs.readFileSync(path.join(directory, 'index.json')) : null,
    marker: fs.existsSync(path.join(directory, '.managed-mutation-pending.json')),
  });
  const expectRefusedWithoutPublication = (reason: string, action: () => unknown, name = 'notes') => {
    const before = snapshot(contextPath, name);
    expect(reasonOf(action)).toBe(reason);
    expect(snapshot(contextPath, name)).toEqual(before);
  };
  // Both hash refusals end with the same recovery: rebuild from a fresh read rather than swap in the new hash.
  const hashRecovery = "Make a fresh named hive_context_read and rebuild the intended change from it (every chunk for a whole-document replacement; the passage and enough surrounding text for a bounded edit), then pass that read's revision and file.contentHash. Do not resend content built from the earlier read under the new hash.";

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setupFeature(featureName);
    service = new ContextService(PROJECT_ROOT, () => new Date('2026-09-07T01:02:03.000Z'));
  });

  afterEach(() => {
    cleanup();
  });

  it('splices one observed passage of a large mixed document from a partial named read', () => {
    const middle = Array.from({ length: 1500 }, (_, index) => `Line ${index}: café ñ 😀 «x» 日本\r\n`).join('');
    const original = durable(`# Style guide\r\n\r\nTone: formal 🎯\r\n\r\n${middle}Tail: unchanged ✅\r\n`);
    const created = service.create(featureName, 'style-guide', original, { task: '09-edit' });
    const later = new ContextService(PROJECT_ROOT, () => new Date('2026-09-08T00:00:00.000Z'));

    const read = later.readContent(featureName, 'style-guide')!;
    expect(read.complete).toBe(false);
    expect(read.range.totalBytes).toBeGreaterThan(32 * 1024);
    expect(read.file.content).toContain('Tone: formal 🎯');
    expect(read.file.content).not.toContain('Tail: unchanged');

    const result = later.edit(featureName, 'style-guide', 'Tone: formal 🎯', 'Tone: plain 🎯', read.revision, read.file.contentHash!);

    const priorBytes = Buffer.from(original, 'utf8');
    const oldBytes = Buffer.from('Tone: formal 🎯', 'utf8');
    const start = priorBytes.indexOf(oldBytes);
    const suffix = priorBytes.subarray(start + oldBytes.length);
    const expected = Buffer.concat([priorBytes.subarray(0, start), Buffer.from('Tone: plain 🎯', 'utf8'), suffix]);
    const written = fs.readFileSync(path.join(contextPath, 'style-guide.md'));
    expect(written.equals(expected)).toBe(true);
    expect(written.subarray(0, start).equals(priorBytes.subarray(0, start))).toBe(true);
    expect(written.subarray(written.length - suffix.length).equals(suffix)).toBe(true);
    expect(result).toMatchObject({ revision: created.revision + 1, file: { contentHash: sha(expected), bytes: expected.length, kind: 'durable', task: '09-edit' } });
    const entry = JSON.parse(fs.readFileSync(path.join(contextPath, 'index.json'), 'utf8')).entries['style-guide'];
    expect(entry).toEqual({ kind: 'durable', createdAt: '2026-09-07T01:02:03.000Z', updatedAt: '2026-09-08T00:00:00.000Z', task: '09-edit', lastManagedContentHash: sha(expected) });
  });

  it('edits project, evidence, and reserved documents with their existing classification and BOM bytes', () => {
    const project = service.create({ type: 'project' }, 'conventions', projectDurable('Use tabs.'));
    expect(service.edit({ type: 'project' }, 'conventions.md', 'tabs', 'spaces', project.revision, project.file.contentHash))
      .toMatchObject({ revision: project.revision + 1, file: { kind: 'durable' } });
    expect(fs.readFileSync(path.join(getProjectContextPath(PROJECT_ROOT), 'conventions.md'), 'utf8')).toBe(projectDurable('Use spaces.'));
    const projectRead = service.readContent({ type: 'project' }, 'conventions')!;
    expect(reasonOf(() => service.edit({ type: 'project' }, 'conventions', 'owner: platform\n', '', projectRead.revision, projectRead.file.contentHash!)))
      .toBe('invalid_context_metadata');

    const bom = '\uFEFF';
    const evidence = service.create(featureName, 'log', `${bom}raw\r\nline`, { kind: 'evidence', task: '01-x' });
    const edited = service.edit(featureName, 'log', 'raw', 'cooked', evidence.revision, evidence.file.contentHash);
    expect(fs.readFileSync(path.join(contextPath, 'log.md')).equals(Buffer.from(`${bom}cooked\r\nline`, 'utf8'))).toBe(true);
    expect(edited.file).toMatchObject({ kind: 'evidence', task: '01-x', role: 'evidence', chars: `${bom}cooked\r\nline`.length });

    fs.writeFileSync(path.join(contextPath, 'overview.md'), `${bom}# Overview\nStatus: draft\n`);
    const overview = service.readContent(featureName, 'overview')!;
    const reserved = service.edit(featureName, 'overview', 'draft', 'ready', overview.revision, overview.file.contentHash!);
    expect(fs.readFileSync(path.join(contextPath, 'overview.md')).equals(Buffer.from(`${bom}# Overview\nStatus: ready\n`, 'utf8'))).toBe(true);
    expect(reserved.file).toMatchObject({ role: 'operational' });
    expect(reserved.file.kind).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(contextPath, 'index.json'), 'utf8')).entries.overview).toBeUndefined();

    seedLegacy(featureName, 'bom-durable', `${bom}${durable('body')}`);
    const legacy = service.readContent(featureName, 'bom-durable')!;
    expectRefusedWithoutPublication('invalid_context_metadata', () => service.edit(featureName, 'bom-durable', 'body', 'new body', legacy.revision, legacy.file.contentHash!), 'bom-durable');
    service.edit(featureName, 'bom-durable', `${bom}---`, '---', legacy.revision, legacy.file.contentHash!);
    expect(fs.readFileSync(path.join(contextPath, 'bom-durable.md'), 'utf8')).toBe(durable('body'));
  });

  it('matches literal bytes exactly once and inserts replacement text without interpretation', () => {
    const created = service.create(featureName, 'notes', durable('pattern .* and a\\b\r\nsecond line\r\naaa'));
    const literal = service.edit(featureName, 'notes', '.* and a\\b', '$& $1 \\\\ $$', created.revision, created.file.contentHash);
    expect(service.read(featureName, 'notes')).toBe(durable('pattern $& $1 \\\\ $$\r\nsecond line\r\naaa'));
    const revision = literal.revision;
    const hash = literal.file.contentHash;

    expectRefusedWithoutPublication('context_edit_ambiguous', () => service.edit(featureName, 'notes', 'aa', 'b', revision, hash));
    expectRefusedWithoutPublication('context_edit_ambiguous', () => service.edit(featureName, 'notes', 'e', 'E', revision, hash));
    expectRefusedWithoutPublication('context_edit_no_match', () => service.edit(featureName, 'notes', 'second line\naaa', 'x', revision, hash));
    expect(() => service.edit(featureName, 'notes', 'second line\naaa', 'x', revision, hash)).toThrow('CRLF');
    expectRefusedWithoutPublication('invalid_argument', () => service.edit(featureName, 'notes', '', 'x', revision, hash));
    expectRefusedWithoutPublication('context_edit_no_change', () => service.edit(featureName, 'notes', 'second line', 'second line', revision, hash));
    expectRefusedWithoutPublication('invalid_argument', () => service.edit(featureName, 'notes', 'second', '\uD800', revision, hash));
    expectRefusedWithoutPublication('invalid_argument', () => service.edit(featureName, 'notes', 'second\uDC00', 'x', revision, hash));
    expectRefusedWithoutPublication('context_input_too_large', () => service.edit(featureName, 'notes', 'x'.repeat(1024 * 1024 + 1), 'y', revision, hash));
    expectRefusedWithoutPublication('invalid_context_metadata', () => service.edit(featureName, 'notes', 'description: Test context\n', 'description: \n', revision, hash));
    expectRefusedWithoutPublication('invalid_context_metadata', () => service.edit(featureName, 'notes', service.read(featureName, 'notes')!, '', revision, hash));

    expect(service.edit(featureName, 'notes', '\r\naaa', '', revision, hash).revision).toBe(revision + 1);
    expect(service.read(featureName, 'notes')).toBe(durable('pattern $& $1 \\\\ $$\r\nsecond line'));
  });

  it('allows deletion to an empty evidence document and bounds the edited result', () => {
    const evidence = service.create(featureName, 'notes', 'only text', { kind: 'evidence' });
    const emptied = service.edit(featureName, 'notes', 'only text', '', evidence.revision, evidence.file.contentHash);
    expect(fs.readFileSync(path.join(contextPath, 'notes.md')).length).toBe(0);
    expect(emptied.file).toMatchObject({ bytes: 0, chars: 0, contentHash: sha('') });

    const large = service.replace(featureName, 'notes', `${'x'.repeat(1024 * 1024 - 1)}y`, emptied.revision, emptied.file.contentHash);
    expectRefusedWithoutPublication('context_input_too_large', () => service.edit(featureName, 'notes', 'y', 'yz', large.revision, large.file.contentHash));
  });

  it('checks revision and whole-file hash guards before matching', () => {
    const created = service.create(featureName, 'notes', durable('alpha beta'));
    const first = service.readContent(featureName, 'notes')!;
    const second = service.readContent(featureName, 'notes')!;
    const applied = service.edit(featureName, 'notes', 'alpha', 'gamma', first.revision, first.file.contentHash!);
    expect(applied.revision).toBe(created.revision + 1);
    expectRefusedWithoutPublication('stale_revision', () => service.edit(featureName, 'notes', 'beta', 'delta', second.revision, second.file.contentHash!));
    expectRefusedWithoutPublication('stale_revision', () => service.edit(featureName, 'notes', 'alpha', 'gamma', first.revision, first.file.contentHash!));

    fs.appendFileSync(path.join(contextPath, 'notes.md'), '\nexternal');
    expectRefusedWithoutPublication('stale_content', () => service.edit(featureName, 'notes', 'not present', 'x', applied.revision, applied.file.contentHash));
    expectRefusedWithoutPublication('context_precondition_required', () => service.edit(featureName, 'notes', 'beta', 'x', applied.revision, 'not-a-hash'));
    expectRefusedWithoutPublication('context_precondition_required', () => service.edit(featureName, 'notes', 'beta', 'x', -1, applied.file.contentHash));
    // Edit preflight and the shared mutation guard both name the field and what arrived.
    expect(() => service.edit(featureName, 'notes', 'beta', 'x', -1, applied.file.contentHash))
      .toThrow('expectedRevision must be a nonnegative safe integer, the revision from a fresh named hive_context_read; received -1. Nothing was written.');
    expect(() => service.append(featureName, 'notes', 'x', undefined as unknown as number, applied.file.contentHash)).toThrow('expectedRevision must be a nonnegative safe integer');
    expect(() => service.append(featureName, 'notes', 'x', undefined as unknown as number, applied.file.contentHash)).toThrow('; it is missing. Nothing was written.');
  });

  it('refuses a malformed hash guard with a self-contained recovery message and writes nothing', () => {
    const original = durable(`Tone: formal\n${'Body line with filler text.\n'.repeat(1300)}Tail: unchanged\n`);
    service.create(featureName, 'style-guide', original);
    const read = service.readContent(featureName, 'style-guide')!;
    const hash = read.file.contentHash!;
    // The reproduced paid-case value: 63 characters, a short span transposed and one character dropped.
    const retained = `${hash.slice(0, 23)}${hash[24]}${hash[23]}${hash.slice(26)}`;
    expect(retained).toHaveLength(63);
    const messageOf = (action: () => unknown) => {
      try { action(); } catch (error) { return { reason: (error as { reason?: string }).reason, message: (error as Error).message, details: (error as { details?: unknown }).details }; }
      throw new Error('expected a refusal');
    };
    const edit = (guard: unknown) => () => service.edit(featureName, 'style-guide', 'Tone: formal', 'Tone: plain', read.revision, guard as string);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expectRefusedWithoutPublication('context_precondition_required', edit(retained), 'style-guide');
      const refused = messageOf(edit(retained));
      expect(refused.message).toContain('expectedContentHash must be exactly 64 lowercase hexadecimal characters; received 63 characters.');
      expect(refused.message).toContain('Nothing was written.');
      expect(refused.message).toContain('Do not pad, trim or otherwise repair the rejected value.');
      expect(refused.message).toContain(hashRecovery);
      expect(refused.message).not.toContain(hash);
    }
    expect(messageOf(edit(undefined)).message).toContain('expectedContentHash must be exactly 64 lowercase hexadecimal characters; it is missing.');
    expect(messageOf(edit(42)).message).toContain('; it has type number.');
    expect(messageOf(edit(hash.toUpperCase())).message).toContain('received 64 characters that are not all lowercase hexadecimal (0-9, a-f)');
    expectRefusedWithoutPublication('context_precondition_required', edit(hash.toUpperCase()), 'style-guide');
    expectRefusedWithoutPublication('context_precondition_required', () => service.append(featureName, 'style-guide', 'x', read.revision, retained), 'style-guide');
    expectRefusedWithoutPublication('context_precondition_required', () => service.replace(featureName, 'style-guide', original, read.revision, retained), 'style-guide');
    const archived = messageOf(() => service.archiveSelected(featureName, ['style-guide'], 'r', read.revision, { 'style-guide': retained }));
    expect(archived).toMatchObject({ reason: 'context_precondition_required' });
    expect(archived.message).toContain('expectedContentHashes["style-guide"] must be exactly 64 lowercase hexadecimal characters; received 63 characters.');

    // A fresh read supplies a usable guard; the bounded edit applies and keeps the unread tail.
    const fresh = service.readContent(featureName, 'style-guide')!;
    expect(fresh.file.content).not.toContain('Tail: unchanged');
    const applied = service.edit(featureName, 'style-guide', 'Tone: formal', 'Tone: plain', fresh.revision, fresh.file.contentHash!);
    expect(applied.revision).toBe(read.revision + 1);
    expect(service.read(featureName, 'style-guide')).toBe(original.replace('Tone: formal', 'Tone: plain'));
  });

  it('refuses a well-formed mismatched hash without blaming only a changed file or revealing the current hash', () => {
    service.create(featureName, 'notes', durable('alpha beta'));
    const read = service.readContent(featureName, 'notes')!;
    const hash = read.file.contentHash!;
    const mistyped = `${hash.slice(0, -1)}${hash.endsWith('0') ? '1' : '0'}`;
    expectRefusedWithoutPublication('stale_content', () => service.edit(featureName, 'notes', 'alpha', 'gamma', read.revision, mistyped));
    let refused: { message: string; details: Record<string, unknown> } | undefined;
    try { service.edit(featureName, 'notes', 'alpha', 'gamma', read.revision, mistyped); } catch (error) { refused = error as typeof refused; }
    expect(refused!.message).toContain('expectedContentHash does not match the current content of context "notes"');
    expect(refused!.message).toContain('the file changed after it was read, or the value was not copied exactly from file.contentHash');
    expect(refused!.message).toContain('Nothing was written.');
    expect(refused!.message).toContain(hashRecovery);
    expect(refused!.message).not.toContain(hash);
    expect(JSON.stringify(refused!.details)).not.toContain(hash);
  });

  it('refuses unsafe, missing, invalid, and blocked targets without creating or changing storage', () => {
    setupFeature('absent');
    expect(reasonOf(() => service.edit('absent', 'notes', 'a', 'b', 0, sha('a')))).toBe('context_not_found');
    expect(fs.existsSync(path.join(TEST_DIR, '.hive/features/absent/context'))).toBe(false);
    expect(reasonOf(() => service.edit({ type: 'project' }, 'notes', 'a', 'b', 0, sha('a')))).toBe('context_not_found');
    expect(fs.existsSync(getProjectContextPath(PROJECT_ROOT))).toBe(false);

    const created = service.create(featureName, 'notes', durable('body'));
    for (const name of ['../notes', 'index', '.managed-mutation-pending', 'a/b']) {
      expectRefusedWithoutPublication('invalid_context_name', () => service.edit(featureName, name, 'body', 'x', created.revision, created.file.contentHash));
    }
    fs.mkdirSync(path.join(contextPath, 'folder.md'));
    expectRefusedWithoutPublication('context_not_found', () => service.edit(featureName, 'folder', 'body', 'x', created.revision, created.file.contentHash));
    fs.symlinkSync(path.join(contextPath, 'notes.md'), path.join(contextPath, 'linked.md'));
    expectRefusedWithoutPublication('context_symlink_refused', () => service.edit(featureName, 'linked', 'body', 'x', created.revision, created.file.contentHash));
    fs.unlinkSync(path.join(contextPath, 'linked.md'));
    fs.rmdirSync(path.join(contextPath, 'folder.md'));

    const invalid = Buffer.concat([Buffer.from('raw '), Buffer.from([0xe2, 0x82]), Buffer.from(' tail')]);
    fs.writeFileSync(path.join(contextPath, 'invalid.md'), invalid);
    expectRefusedWithoutPublication('context_invalid_utf8', () => service.edit(featureName, 'invalid', ' tail', 'x', created.revision, sha(invalid)), 'invalid');
    expectRefusedWithoutPublication('context_invalid_utf8', () => service.append(featureName, 'invalid', 'x', created.revision, sha(invalid)), 'invalid');

    const indexPath = path.join(contextPath, 'index.json');
    const index = fs.readFileSync(indexPath);
    fs.writeFileSync(indexPath, '{');
    expectRefusedWithoutPublication('context_index_invalid', () => service.edit(featureName, 'notes', 'body', 'x', created.revision, created.file.contentHash));
    fs.writeFileSync(indexPath, index);
    fs.writeFileSync(path.join(contextPath, '.managed-mutation-pending.json'), JSON.stringify({ schemaVersion: 1, operation: 'replace', names: ['notes'] }));
    expectRefusedWithoutPublication('context_reconciliation_required', () => service.edit(featureName, 'notes', 'body', 'x', created.revision, created.file.contentHash));
    expectRefusedWithoutPublication('context_reconciliation_required', () => service.edit(featureName, 'missing', 'body', 'x', created.revision, created.file.contentHash), 'missing');
  });
});

describe('ContextService pending marker classification', () => {
  let service: ContextService;
  const featureName = 'publishing';
  const contextPath = path.join(TEST_DIR, '.hive/features', featureName, 'context');
  const indexPath = path.join(contextPath, 'index.json');
  const markerPath = path.join(contextPath, '.managed-mutation-pending.json');
  const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
  const errorOf = (action: () => unknown): unknown => {
    try { action(); } catch (error) { return error; }
    return undefined;
  };
  const reasonOf = (action: () => unknown): string | undefined => {
    const error = errorOf(action);
    return error === undefined ? undefined : (error as { reason?: string }).reason ?? (error as Error).message;
  };
  const publicReads = (target: ContextService) => ({
    readSummary: reasonOf(() => target.readSummary(featureName)) ?? 'ok',
    readCatalog: reasonOf(() => target.readCatalog(featureName)) ?? 'ok',
    readManagementCatalog: reasonOf(() => target.readManagementCatalog(featureName)) ?? 'ok',
    readContent: reasonOf(() => target.readContent(featureName, 'notes')) ?? 'ok',
    read: reasonOf(() => target.read(featureName, 'notes')) ?? 'ok',
  });
  const allReads = (outcome: string) => ({
    readSummary: outcome, readCatalog: outcome, readManagementCatalog: outcome, readContent: outcome, read: outcome,
  });

  // The reader is a separate process, so its lock probe meets the writer's kernel lock exactly as another host would.
  function readInAnotherProcess(): Record<string, string> {
    const script = path.join(TEST_DIR, 'context-reader.ts');
    fs.writeFileSync(script, `
      const { ContextService } = await import(${JSON.stringify(path.join(import.meta.dir, 'contextService.ts'))});
      const [root, feature] = process.argv.slice(2);
      const service = new ContextService(root);
      const outcome = (read) => { try { read(); return 'ok'; } catch (error) { return error.reason ?? String(error); } };
      process.stdout.write(JSON.stringify({
        readSummary: outcome(() => service.readSummary(feature)),
        readCatalog: outcome(() => service.readCatalog(feature)),
        readManagementCatalog: outcome(() => service.readManagementCatalog(feature)),
        readContent: outcome(() => service.readContent(feature, 'notes')),
        read: outcome(() => service.read(feature, 'notes')),
      }));
    `);
    const result = Bun.spawnSync([process.execPath, script, PROJECT_ROOT, featureName], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  }

  /** Runs `transition` the first time the lock probe opens the index lock anchor, after the reader has seen the marker. */
  function atLockProbe(transition: () => void): { restore: () => void; probes: () => number } {
    const anchorPath = resolveLockAnchor(indexPath).anchorPath;
    const originalOpen = fs.openSync;
    let probes = 0;
    const open = spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (String(file) === anchorPath) {
        probes += 1;
        if (probes === 1) transition();
      }
      return (originalOpen as (...values: unknown[]) => number)(file, ...args);
    }) as typeof fs.openSync);
    return { restore: () => open.mockRestore(), probes: () => probes };
  }

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setupFeature(featureName);
    service = new ContextService(PROJECT_ROOT, () => new Date('2026-09-07T01:02:03.000Z'));
  });

  afterEach(() => {
    cleanup();
  });

  it('reports a healthy publication to readers in another process as a retryable change, never as reconciliation', () => {
    const created = service.create(featureName, 'notes', durable('alpha'));
    const unlink = (service as unknown as { unlinkDurable: (target: string) => void }).unlinkDurable.bind(service);
    const atMarkerRemoval: Array<Record<string, string>> = [];
    (service as unknown as { unlinkDurable: (target: string) => void }).unlinkDurable = (target: string) => {
      if (target === markerPath) {
        // Content and index are published; the writer still holds the lock and has not removed its marker.
        expect(probeLock(indexPath)).toBe('held');
        atMarkerRemoval.push(readInAnotherProcess());
      }
      unlink(target);
    };

    const edited = service.edit(featureName, 'notes', 'alpha', 'beta', created.revision, created.file.contentHash);

    expect(atMarkerRemoval).toEqual([allReads('context_changed_during_read')]);
    expect(edited.revision).toBe(created.revision + 1);
    expect(readInAnotherProcess()).toEqual(allReads('ok'));
  });

  it('fails closed on a marker that outlived its writer, for readers and for a mutation holding the lock', () => {
    const created = service.create(featureName, 'notes', durable('alpha'));
    const marker = JSON.stringify({ schemaVersion: 1, operation: 'replace', names: ['notes'] });
    fs.writeFileSync(markerPath, marker);
    const index = fs.readFileSync(indexPath);

    expect(probeLock(indexPath)).toBe('free');
    expect(publicReads(service)).toEqual(allReads('context_reconciliation_required'));
    expect(readInAnotherProcess()).toEqual(allReads('context_reconciliation_required'));
    // The mutation's own lock is not another writer: a marker it finds is an unresolved earlier operation.
    expect(reasonOf(() => service.replace(featureName, 'notes', durable('beta'), created.revision, created.file.contentHash)))
      .toBe('context_reconciliation_required');
    expect(reasonOf(() => service.create(featureName, 'other', durable('other')))).toBe('context_reconciliation_required');
    // A pre-native lock file proves no live writer, so it does not hide the abandoned marker.
    fs.writeFileSync(`${indexPath}.lock`, 'stale');
    expect(probeLock(indexPath)).toBe('legacy');
    expect(reasonOf(() => service.readSummary(featureName))).toBe('context_reconciliation_required');
    fs.unlinkSync(`${indexPath}.lock`);

    expect(fs.readFileSync(markerPath, 'utf8')).toBe(marker);
    expect(fs.readFileSync(indexPath)).toEqual(index);
    expect(fs.existsSync(path.join(contextPath, 'other.md'))).toBe(false);
  });

  it('retries when the writer finishes between the marker observation and the lock probe', () => {
    service.create(featureName, 'notes', durable('alpha'));
    const releaseWriter = acquireLockSync(indexPath);
    fs.writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, operation: 'edit', names: ['notes'] }));
    const probe = atLockProbe(() => {
      fs.unlinkSync(markerPath);
      releaseWriter();
    });
    try {
      expect(reasonOf(() => service.readSummary(featureName))).toBe('context_changed_during_read');
      expect(probe.probes()).toBeGreaterThan(0);
    } finally {
      probe.restore();
      releaseWriter();
    }
    expect(service.readSummary(featureName).files.map(file => file.name)).toEqual(['notes']);
  });

  it('retries when a later marker replaces the observed one, then fails closed once that marker is stable', () => {
    service.create(featureName, 'notes', durable('alpha'));
    fs.writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, operation: 'edit', names: ['notes'], startingRevision: 1 }));
    const probe = atLockProbe(() => {
      // An earlier writer finished and a later one published its own marker, then stopped without removing it.
      const staged = `${markerPath}.staged`;
      fs.writeFileSync(staged, JSON.stringify({ schemaVersion: 1, operation: 'edit', names: ['notes'], startingRevision: 2 }));
      fs.renameSync(staged, markerPath);
    });
    try {
      expect(reasonOf(() => service.readContent(featureName, 'notes'))).toBe('context_changed_during_read');
      expect(probe.probes()).toBeGreaterThan(0);
    } finally {
      probe.restore();
    }
    expect(reasonOf(() => service.readContent(featureName, 'notes'))).toBe('context_reconciliation_required');
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).startingRevision).toBe(2);
  });

  it('refuses every mutation of an unknown feature before creating any storage', () => {
    const hash = sha('anything');
    const hiveEntries = () => fs.readdirSync(path.join(TEST_DIR, '.hive'), { recursive: true }).map(String).sort();
    const before = hiveEntries();
    const mutations: Array<[string, () => unknown]> = [
      ['create', () => service.create('ghost', 'notes', durable('typo'))],
      ['replace', () => service.replace('ghost', 'notes', durable('typo'), 0, hash)],
      ['append', () => service.append('ghost', 'notes', 'typo', 0, hash)],
      ['edit', () => service.edit('ghost', 'notes', 'a', 'b', 0, hash)],
      ['archiveSelected', () => service.archiveSelected('ghost', ['notes'], 'obsolete', 0, { notes: hash })],
    ];
    for (const [label, mutation] of mutations) {
      const error = errorOf(mutation);
      expect([label, error instanceof FeatureResolutionError, (error as FeatureResolutionError).reason]).toEqual([label, true, 'not_found']);
    }
    // A directory without feature metadata is not a feature, so its context stays readable but immutable.
    seedLegacy('metadata-less', 'notes', 'legacy bytes');
    const legacyBefore = hiveEntries();
    expect((errorOf(() => service.create('metadata-less', 'other', durable('x'))) as FeatureResolutionError).reason).toBe('not_found');
    expect(hiveEntries()).toEqual(legacyBefore);
    expect(legacyBefore.filter(entry => !entry.includes('metadata-less'))).toEqual(before);

    expect(service.readSummary('ghost')).toMatchObject({ revision: 0, files: [] });
    expect(service.readContent('ghost', 'notes')).toBeNull();
    expect(service.read('metadata-less', 'notes')).toBe('legacy bytes');
  });

  it('refuses reads of an ambiguous or unreadable feature and reads the valid feature beside a metadata-less namesake', () => {
    const writeMetadata = (directory: string, metadata: string) => {
      fs.mkdirSync(path.join(TEST_DIR, '.hive/features', directory), { recursive: true });
      fs.writeFileSync(path.join(TEST_DIR, '.hive/features', directory, 'feature.json'), metadata);
    };
    const named = (name: string) => JSON.stringify({ name, status: 'executing', createdAt: '2026-09-07T00:00:00.000Z' });
    writeMetadata('01_twin', named('twin'));
    writeMetadata('02_twin', named('twin'));
    seedLegacy('01_twin', 'notes', 'first twin bytes');
    writeMetadata('broken', '{not json');
    seedLegacy('broken', 'notes', 'broken bytes');
    const snapshot = () => fs.readdirSync(path.join(TEST_DIR, '.hive'), { recursive: true }).map(String).sort().map((entry) => {
      const target = path.join(TEST_DIR, '.hive', entry);
      return [entry, fs.statSync(target).isFile() ? fs.readFileSync(target, 'utf8') : null];
    });
    const before = snapshot();
    const reads = (feature: string) => ({
      readSummary: reasonOf(() => service.readSummary(feature)),
      readCatalog: reasonOf(() => service.readCatalog(feature)),
      readContent: reasonOf(() => service.readContent(feature, 'notes')),
      read: reasonOf(() => service.read(feature, 'notes')),
    });
    const refused = (reason: string) => ({ readSummary: reason, readCatalog: reason, readContent: reason, read: reason });
    expect(reads('twin')).toEqual(refused('ambiguous'));
    expect(reads('broken')).toEqual(refused('unreadable'));
    expect(snapshot()).toEqual(before);

    // A direct directory without metadata does not shadow the indexed feature whose metadata owns the name.
    seedLegacy('ghosted', 'notes', 'ghost bytes');
    writeMetadata('03_ghosted', named('ghosted'));
    const created = service.create('ghosted', 'notes', durable('valid'));
    const featureNotes = path.join(TEST_DIR, '.hive/features/03_ghosted/context/notes.md');
    expect(fs.readFileSync(featureNotes, 'utf8')).toBe(durable('valid'));
    expect(service.read('ghosted', 'notes')).toBe(durable('valid'));
    expect(service.readContent('ghosted', 'notes')?.file.contentHash).toBe(created.file.contentHash);
    expect(service.readCatalog('ghosted').files.map((file) => file.name)).toEqual(['notes']);
    expect(fs.readFileSync(path.join(TEST_DIR, '.hive/features/ghosted/context/notes.md'), 'utf8')).toBe('ghost bytes');
  });

  it('validates ordinary mutation input before creating context storage', () => {
    const projectPath = getProjectContextPath(PROJECT_ROOT);
    const project = { type: 'project' } as const;
    const refusals: Array<[string, () => unknown]> = [
      ['invalid_context_name', () => service.create(project, '../escape', projectDurable('x'))],
      ['invalid_argument', () => service.create(project, 'notes', 42 as unknown as string)],
      ['context_input_too_large', () => service.create(project, 'notes', 'x'.repeat(1024 * 1024 + 1))],
      ['invalid_context_kind', () => service.create(project, 'notes', projectDurable('x'), { kind: 'bogus' as never })],
      ['invalid_context_kind', () => service.create(project, 'overview', 'x', { kind: 'durable' })],
      ['invalid_context_metadata', () => service.create(project, 'notes', 'no frontmatter')],
      ['context_precondition_required', () => service.replace(project, 'notes', projectDurable('x'), 0, 'not-a-hash')],
      ['context_precondition_required', () => service.append(project, 'notes', 'x', -1, sha('x'))],
      ['invalid_context_name', () => service.edit(featureName, 'a/b', 'x', 'y', 0, sha('x'))],
      ['invalid_argument', () => service.archiveSelected(project, [], 'obsolete', 0, {})],
      ['invalid_archive_reason', () => service.archiveSelected(project, ['notes'], ' ', 0, { notes: sha('x') })],
      ['invalid_context_name', () => service.create(featureName, 'index', durable('x'))],
    ];
    for (const [reason, refusal] of refusals) expect([reason, reasonOf(refusal)]).toEqual([reason, reason]);
    expect(fs.existsSync(projectPath)).toBe(false);
    expect(fs.existsSync(contextPath)).toBe(false);
    expect(fs.existsSync(path.join(TEST_DIR, '.hive', '.locks'))).toBe(false);

    // Valid writes keep their revision and hash semantics in both scopes.
    const projectNotes = service.create(project, 'notes', projectDurable('one'));
    const featureNotes = service.create(featureName, 'notes', durable('one'));
    expect([projectNotes.revision, featureNotes.revision]).toEqual([1, 1]);
    expect(service.replace(featureName, 'notes', durable('two'), featureNotes.revision, featureNotes.file.contentHash).revision).toBe(2);
    expect(reasonOf(() => service.replace(project, 'notes', projectDurable('two'), 0, projectNotes.file.contentHash))).toBe('stale_revision');
  });
});
