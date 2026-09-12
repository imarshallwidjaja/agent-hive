import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { ContextService } from '../services/contextService.js';

const TEST_DIR = '/tmp/hive-core-contextservice-test-' + process.pid;
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

function seedLegacy(featureName: string, name: string, content: string): void {
  const directory = path.join(TEST_DIR, '.hive/features', featureName, 'context');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.md`), content);
}

describe('ContextService', () => {
  let service: ContextService;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    service = new ContextService(PROJECT_ROOT);
  });

  afterEach(() => {
    cleanup();
  });

  describe('archive()', () => {
    it('moves context files to archive/ with timestamp prefix', () => {
      const featureName = 'test-feature';
      setupFeature(featureName);

      // Create some context files
      seedLegacy(featureName, 'research', 'Research findings here');
      seedLegacy(featureName, 'decisions', 'Decision log here');

      // Archive them
      const snapshot = service.readSummary(featureName);
      const hashes = Object.fromEntries(snapshot.files.map(file => [file.name, service.readContent(featureName, file.name)!.file.contentHash!]));
      const result = service.archive(featureName, snapshot.revision, hashes);

      // Check returned data
      expect(result.archived).toContain('research');
      expect(result.archived).toContain('decisions');
      expect(result.archived.length).toBe(2);
      expect(result.archivePath).toContain('archive');

      // Verify archive directory exists
      expect(fs.existsSync(result.archivePath)).toBe(true);

      // Verify original files are gone
      const contexts = service.list(featureName);
      expect(contexts.length).toBe(0);

      // Verify archived files exist
      const archiveFiles = fs.readdirSync(result.archivePath);
      expect(archiveFiles.length).toBe(2);
      expect(archiveFiles.some(f => f.endsWith('_research.md'))).toBe(true);
      expect(archiveFiles.some(f => f.endsWith('_decisions.md'))).toBe(true);

      // Verify content preserved
      const researchArchive = archiveFiles.find(f => f.endsWith('_research.md'))!;
      const content = fs.readFileSync(path.join(result.archivePath, researchArchive), 'utf-8');
      expect(content).toBe('Research findings here');
    });

    it('returns empty array when no contexts exist', () => {
      const featureName = 'empty-feature';
      setupFeature(featureName);

      const result = service.archive(featureName, service.readSummary(featureName).revision, {});

      expect(result.archived).toEqual([]);
      expect(result.archivePath).toBe('');
    });
  });

  describe('stats()', () => {
    it('returns correct count, totalChars, oldest, newest', () => {
      const featureName = 'stats-feature';
      setupFeature(featureName);

      // Create contexts
      seedLegacy(featureName, 'first', 'a'.repeat(100));
      seedLegacy(featureName, 'second', 'b'.repeat(200));
      seedLegacy(featureName, 'third', 'c'.repeat(300));
      
      // Manually adjust timestamps to ensure ordering
      const contextPath = path.join(TEST_DIR, '.hive', 'features', featureName, 'context');
      const now = Date.now();
      
      fs.utimesSync(path.join(contextPath, 'first.md'), (now - 2000) / 1000, (now - 2000) / 1000); // oldest
      fs.utimesSync(path.join(contextPath, 'second.md'), (now - 1000) / 1000, (now - 1000) / 1000); // middle
      fs.utimesSync(path.join(contextPath, 'third.md'), now / 1000, now / 1000); // newest

      const result = service.stats(featureName);

      expect(result.count).toBe(3);
      expect(result.totalChars).toBe(600);
      expect(result.oldest).toBe('first');
      expect(result.newest).toBe('third');
    });

    it('returns zero stats when no contexts exist', () => {
      const featureName = 'empty-stats';
      setupFeature(featureName);

      const result = service.stats(featureName);

      expect(result.count).toBe(0);
      expect(result.totalChars).toBe(0);
      expect(result.oldest).toBeUndefined();
      expect(result.newest).toBeUndefined();
    });
  });

  describe('write() compatibility', () => {
    it('allows durable context below the managed 40,000 character cap', () => {
      const featureName = 'large-context';
      setupFeature(featureName);

      seedLegacy(featureName, 'large1', 'x'.repeat(15000));
      seedLegacy(featureName, 'large2', 'before');
      const current = service.readContent(featureName, 'large2')!;
      const result = service.write(featureName, 'large2', 'y'.repeat(6000), current.revision, current.file.contentHash!);

      expect(result).toContain(path.join('context', 'large2.md'));
      expect(service.readSummary(featureName, { scanChars: true }).durable).toMatchObject({
        fileCount: 2,
        chars: 21000,
        overLimit: false,
      });
    });

    it('returns the replaced path when context is under the cap', () => {
      const featureName = 'small-context';
      setupFeature(featureName);

      seedLegacy(featureName, 'small1', 'x'.repeat(5000));
      seedLegacy(featureName, 'small2', 'before');
      const current = service.readContent(featureName, 'small2')!;
      const result = service.write(featureName, 'small2', 'y'.repeat(5000), current.revision, current.file.contentHash!);

      expect(result).toContain(path.join('context', 'small2.md'));
    });
  });
});
