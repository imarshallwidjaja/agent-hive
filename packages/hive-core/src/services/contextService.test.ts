import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { ContextService } from './contextService.js';

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

describe('ContextService overview as regular context', () => {
  let service: ContextService;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    service = new ContextService(PROJECT_ROOT);
  });

  afterEach(() => {
    cleanup();
  });

  it('treats overview like any other durable context file', () => {
    const featureName = 'reserved-overview';
    setupFeature(featureName);

    service.write(featureName, 'overview', 'Human-facing summary');
    service.write(featureName, 'decisions', 'Technical decisions');

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

  it('keeps overview in execution context listings', () => {
    const featureName = 'execution-context';
    setupFeature(featureName);

    service.write(featureName, 'overview', 'Human-facing summary');
    service.write(featureName, 'decisions', 'Technical decisions');

    const executionContext = service.listExecutionContext(featureName);

    expect(executionContext?.map((file: { name: string }) => file.name)).toEqual(['decisions']);
  });

  it('classifies overview as durable while preserving special handling for other known names', () => {
    const featureName = 'classified-context';
    setupFeature(featureName);

    service.write(featureName, 'overview', 'Human-facing summary');
    service.write(featureName, 'draft', 'Scratchpad notes');
    service.write(featureName, 'execution-decisions', 'Operational note');
    service.write(featureName, 'learnings', 'Durable learning');

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

  it('includes overview in durable network context retrieval while preserving freshness metadata', () => {
    const featureName = 'network-context';
    setupFeature(featureName);

    service.write(featureName, 'overview', 'Human-facing summary');
    service.write(featureName, 'draft', 'Scratchpad notes');
    service.write(featureName, 'execution-decisions', 'Operational note');
    service.write(featureName, 'learnings', 'Durable learning');
    service.write(featureName, 'research', 'Durable research');

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

  it('reads legacy files as durable without eager migration', () => {
    setupFeature('legacy');
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'legacy', 'context');
    fs.mkdirSync(contextPath);
    fs.writeFileSync(path.join(contextPath, 'contract.md'), 'legacy contract');

    const summary = service.readSummary('legacy');

    expect(summary.revision).toBe(0);
    expect(summary.files[0]?.kind).toBe('durable');
    expect(summary.durable).toMatchObject({ fileCount: 1, chars: 15, overLimit: false });
    expect(fs.existsSync(path.join(contextPath, 'index.json'))).toBe(false);
  });

  it('preserves write overwrite compatibility and advances a coherent revision', () => {
    setupFeature('write-overwrite');
    service.write('write-overwrite', 'contract', 'first');

    const result = service.write('write-overwrite', 'contract.md', 'replacement bytes');

    expect(result).toContain(path.join('context', 'contract.md'));
    expect(service.read('write-overwrite', 'contract')).toBe('replacement bytes');
    expect(service.readSummary('write-overwrite')).toMatchObject({
      revision: 2,
      durable: { fileCount: 1, chars: 17 },
    });
  });

  it('invalidates held revisions and removes index metadata on compatibility delete', () => {
    setupFeature('delete-managed');
    const created = service.create('delete-managed', 'notes', 'delete me', { kind: 'evidence' });

    expect(service.delete('delete-managed', 'notes')).toBe(true);
    expect(service.readSummary('delete-managed')).toMatchObject({ revision: 2, files: [] });
    expect(() => service.create('delete-managed', 'replacement', 'new')).not.toThrow();
    expect(() => service.replace('delete-managed', 'replacement', 'stale', created.revision))
      .toThrow('current revision is 3');
    const indexPath = path.join(TEST_DIR, '.hive', 'features', 'delete-managed', 'context', 'index.json');
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf-8')).entries).not.toHaveProperty('notes');
  });

  it('preserves compatibility archive collisions and invalidates held revisions', () => {
    setupFeature('archive-managed');
    const first = service.create('archive-managed', 'notes', 'first payload');
    const firstArchive = service.archive('archive-managed');
    service.create('archive-managed', 'notes', 'second payload');
    const secondArchive = service.archive('archive-managed');

    const archiveFiles = fs.readdirSync(firstArchive.archivePath)
      .filter(name => name.includes('_notes'));
    expect(archiveFiles).toHaveLength(2);
    expect(archiveFiles.map(name => fs.readFileSync(path.join(firstArchive.archivePath, name), 'utf-8')).sort())
      .toEqual(['first payload', 'second payload']);
    expect(secondArchive.archivePath).toBe(firstArchive.archivePath);
    expect(service.readSummary('archive-managed')).toMatchObject({ revision: 4, files: [] });
    expect(() => service.create('archive-managed', 'replacement', 'new')).not.toThrow();
    expect(() => service.replace('archive-managed', 'replacement', 'stale', first.revision))
      .toThrow('current revision is 5');
  });

  it('returns content and revision from one locked snapshot', () => {
    setupFeature('snapshot');
    const created = service.create('snapshot', 'notes', 'snapshot bytes');

    expect(service.readContent('snapshot', 'notes')).toMatchObject({
      revision: created.revision,
      file: { name: 'notes', content: 'snapshot bytes', kind: 'durable' },
    });
    expect(service.readSummary('snapshot')).toMatchObject({
      revision: created.revision,
      files: [{ name: 'notes', kind: 'durable' }],
      durable: { chars: 14 },
    });
  });

  it('holds the index lock while every list-based public read observes files', () => {
    setupFeature('locked-reads');
    service.create('locked-reads', 'notes', 'snapshot bytes');
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'locked-reads', 'context');
    const lockPath = path.join(contextPath, 'index.json.lock');
    const originalReaddirSync = fs.readdirSync;
    let observations = 0;
    const readdirSpy = spyOn(fs, 'readdirSync').mockImplementation(((targetPath, options) => {
      if (String(targetPath) === contextPath) {
        observations += 1;
        expect(fs.existsSync(lockPath)).toBe(true);
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
      expect(service.readContent('locked-reads', 'notes')?.file.content).toBe('snapshot bytes');
    } finally {
      readdirSpy.mockRestore();
    }

    expect(observations).toBe(8);
  });

  it('creates evidence without exposing it to execution or network context', () => {
    setupFeature('evidence');
    service.create('evidence', 'verification-log', 'raw output', { kind: 'evidence', task: '01-test' });
    service.create('evidence', 'contract', 'current contract');

    expect(service.listExecutionContext('evidence').map(file => file.name)).toEqual(['contract']);
    expect(service.listNetworkContext('evidence').map(file => file.name)).toEqual(['contract']);
    expect(service.readContent('evidence', 'verification-log')?.file).toMatchObject({
      kind: 'evidence',
      task: '01-test',
    });
  });

  it('rejects stale replace and append without changing content or index', () => {
    setupFeature('stale');
    service.create('stale', 'contract', 'one');
    const indexPath = path.join(TEST_DIR, '.hive', 'features', 'stale', 'context', 'index.json');
    const beforeIndex = fs.readFileSync(indexPath, 'utf-8');

    expect(() => service.replace('stale', 'contract', 'two', 0)).toThrow('current revision is 1');
    expect(() => service.append('stale', 'contract', 'three', 0)).toThrow('current revision is 1');
    expect(service.read('stale', 'contract')).toBe('one');
    expect(fs.readFileSync(indexPath, 'utf-8')).toBe(beforeIndex);
  });

  it('appends a deterministic dated section while preserving prior bytes', () => {
    setupFeature('append');
    const created = service.create('append', 'learnings', 'original bytes');

    const result = service.append(
      'append',
      'learnings',
      'new finding',
      created.revision,
      { section: 'Tests' },
    );

    expect(result.revision).toBe(2);
    expect(service.read('append', 'learnings')).toBe(
      'original bytes\n\n<!-- appended 2026-09-07T01:02:03.000Z -->\n### Tests\n\nnew finding\n',
    );
  });

  it('grandfathers over-limit durable context but rejects further growth', () => {
    setupFeature('over-limit');
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'over-limit', 'context');
    fs.mkdirSync(contextPath);
    for (let index = 0; index < 9; index += 1) {
      fs.writeFileSync(path.join(contextPath, `legacy-${index}.md`), 'x'.repeat(5000));
    }

    const shrink = service.replace('over-limit', 'legacy-0', 'shorter', 0);
    expect(shrink.revision).toBe(1);
    expect(() => service.append('over-limit', 'legacy-0', 'growth', shrink.revision)).toThrow('growth rejected');
    expect(() => service.create('over-limit', 'another', 'new')).toThrow('growth rejected');
    expect(service.readSummary('over-limit').durable.overLimit).toBe(true);
  });

  it('rejects durable character growth when only the file-count cap is already exceeded', () => {
    setupFeature('file-count-overage');
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'file-count-overage', 'context');
    fs.mkdirSync(contextPath);
    for (let index = 0; index < 9; index += 1) {
      fs.writeFileSync(path.join(contextPath, `legacy-${index}.md`), 'x');
    }

    expect(() => service.replace('file-count-overage', 'legacy-0', 'xx', 0)).toThrow('growth rejected');
    expect(service.replace('file-count-overage', 'legacy-0', 'y', 0).revision).toBe(1);
  });

  it('rejects durable file-count growth when only the character cap is already exceeded', () => {
    setupFeature('char-count-overage');
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'char-count-overage', 'context');
    fs.mkdirSync(contextPath);
    fs.writeFileSync(path.join(contextPath, 'legacy.md'), 'x'.repeat(40001));

    expect(() => service.create('char-count-overage', 'another', '')).toThrow('growth rejected');
    expect(service.replace('char-count-overage', 'legacy', 'x'.repeat(40000), 0).revision).toBe(1);
  });

  it('archives only selected files with reason and advances revision', () => {
    setupFeature('archive-selected');
    service.create('archive-selected', 'keep', 'keep');
    const created = service.create('archive-selected', 'remove', 'remove');

    const result = service.archiveSelected('archive-selected', ['remove'], 'superseded', created.revision);

    expect(result.revision).toBe(3);
    expect(service.read('archive-selected', 'keep')).toBe('keep');
    expect(service.read('archive-selected', 'remove')).toBeNull();
    expect(fs.readFileSync(result.archived[0]!.archivePath, 'utf-8')).toBe('remove');
    expect(result.archived[0]?.reason).toBe('superseded');
  });

  it('preserves repeated archives of a recreated name at a fixed timestamp', () => {
    setupFeature('archive-collision');
    const first = service.create('archive-collision', 'notes', 'first payload');
    const firstArchive = service.archiveSelected('archive-collision', ['notes'], 'first', first.revision);
    const second = service.create('archive-collision', 'notes', 'second payload');
    const secondArchive = service.archiveSelected('archive-collision', ['notes'], 'second', second.revision);

    expect(firstArchive.archived[0]?.archivePath).not.toBe(secondArchive.archived[0]?.archivePath);
    expect(fs.readFileSync(firstArchive.archived[0]!.archivePath, 'utf-8')).toBe('first payload');
    expect(fs.readFileSync(secondArchive.archived[0]!.archivePath, 'utf-8')).toBe('second payload');
  });

  it('rejects stale archive without changing active or archive bytes', () => {
    setupFeature('stale-archive');
    const created = service.create('stale-archive', 'notes', 'active payload');
    service.create('stale-archive', 'other', 'other payload');
    const featurePath = path.join(TEST_DIR, '.hive', 'features', 'stale-archive');
    const beforeContext = fs.readFileSync(path.join(featurePath, 'context', 'notes.md'), 'utf-8');
    const beforeIndex = fs.readFileSync(path.join(featurePath, 'context', 'index.json'), 'utf-8');

    expect(() => service.archiveSelected('stale-archive', ['notes'], 'stale', created.revision)).toThrow('current revision is 2');
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

  it('allows durable to evidence reduction while enforcing both cap dimensions on transitions', () => {
    setupFeature('kind-transitions');
    const contextPath = path.join(TEST_DIR, '.hive', 'features', 'kind-transitions', 'context');
    fs.mkdirSync(contextPath);
    for (let index = 0; index < 9; index += 1) {
      fs.writeFileSync(path.join(contextPath, `legacy-${index}.md`), 'x'.repeat(5000));
    }

    const reduced = service.replace('kind-transitions', 'legacy-0', 'raw evidence', 0, { kind: 'evidence' });
    expect(reduced.revision).toBe(1);
    expect(service.readSummary('kind-transitions').durable).toMatchObject({ fileCount: 8, chars: 40000 });
    expect(() => service.replace(
      'kind-transitions',
      'legacy-0',
      'y'.repeat(5001),
      reduced.revision,
      { kind: 'durable' },
    )).toThrow('growth rejected');
  });

  it('rejects shrinking evidence bytes when the transition increases an over-cap durable file count', () => {
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

    expect(() => service.replace(
      'cross-cap-transition',
      'raw-log',
      'y',
      evidence.revision,
      { kind: 'durable' },
    )).toThrow('growth rejected');
    expect(service.read('cross-cap-transition', 'raw-log')).toBe('e'.repeat(6000));
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
    service.create('ordering', 'older', 'old');
    service.create('ordering', 'alpha', 'alpha');
    service.create('ordering', 'beta', 'beta');
    service.replace('ordering', 'older', 'newest', 3);

    expect(service.listExecutionContext('ordering').map(file => file.name)).toEqual([
      'older',
      'alpha',
      'beta',
    ]);
  });
});
