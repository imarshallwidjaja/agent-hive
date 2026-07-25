import { describe, expect, it } from 'bun:test';
import type { ReviewWorkspaceCaller } from 'hive-core';
import {
  createReviewWorkspaceLeaseInput,
  fingerprintReviewWorkspaceScope,
  normalizeReviewWorkspaceSourceScope,
} from './review-workspace-runs.js';
import type { ReviewMaterialization } from './utils/git-snapshot.js';

const creator: ReviewWorkspaceCaller = {
  workflow: 'dash-review',
  role: 'creator',
  agent: '__hive_dash_review_scope',
  sessionId: 'scope-session',
  pid: process.pid,
};

describe('review workspace run descriptors', () => {
  it('normalizes source scope before producing a stable fingerprint', () => {
    const scope = normalizeReviewWorkspaceSourceScope(['web', 'api', 'web'], {
      baseRef: 'main',
      targetRef: 'HEAD',
      paths: ['src/z.ts', 'src/../src/a.ts', 'src/z.ts'],
      maxFiles: 25,
      maxPatchBytes: 4_096,
    });

    expect(scope).toEqual({
      repositoryIds: ['api', 'web'],
      snapshot: {
        baseRef: 'main',
        targetRef: 'HEAD',
        paths: ['src/a.ts', 'src/z.ts'],
        maxFiles: 25,
        maxPatchBytes: 4_096,
      },
    });
    expect(fingerprintReviewWorkspaceScope(scope)).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintReviewWorkspaceScope(scope)).toBe(fingerprintReviewWorkspaceScope({
      repositoryIds: ['api', 'web'],
      snapshot: { ...scope.snapshot },
    }));
  });

  it('rejects scope paths that cannot be represented as repository-relative paths', () => {
    for (const invalidPath of ['/etc/passwd', '../outside', '-flag', ':magic', 'src\\windows']) {
      expect(() => normalizeReviewWorkspaceSourceScope(undefined, { paths: [invalidPath] })).toThrow(
        'must be repository-relative',
      );
    }
  });

  it('persists sorted compact materialization descriptors without content or trusted paths', () => {
    const materialization = {
      entries: [
        { path: 'src/z.ts', kind: 'regular', content: Buffer.from('secret-content'), mode: 0o755 },
        { path: 'src/a.ts', kind: 'delete' },
        { path: 'src/link', kind: 'symlink', content: Buffer.from('/trusted/target') },
      ],
    } as ReviewMaterialization;

    const lease = createReviewWorkspaceLeaseInput({
      caller: creator,
      repositoryIds: ['web', 'api'],
      snapshot: { paths: ['src'] },
      selectedRepositoryIds: ['web', 'api'],
      sourceFingerprint: '2'.repeat(64),
      materializedFingerprint: '3'.repeat(64),
      materializations: [{ repositoryId: 'api', materialization }],
    });

    expect(lease.selectedRepositoryIds).toEqual(['api', 'web']);
    expect(lease.materializedEntries.api).toEqual([
      { path: 'src/a.ts', kind: 'delete' },
      { path: 'src/link', kind: 'symlink' },
      { path: 'src/z.ts', kind: 'regular' },
    ]);
    expect(JSON.stringify(lease)).not.toContain('secret-content');
    expect(JSON.stringify(lease)).not.toContain('/trusted/target');
    expect(lease.scopeFingerprint).toBe(fingerprintReviewWorkspaceScope(lease.sourceScope));
    expect(lease.sourceFingerprint).not.toBe(lease.materializedFingerprint);
  });

  it('requires creator capability when constructing a persisted lease', () => {
    expect(() => createReviewWorkspaceLeaseInput({
      caller: { ...creator, role: 'primary' },
      repositoryIds: undefined,
      snapshot: {},
      selectedRepositoryIds: ['root'],
      sourceFingerprint: '2'.repeat(64),
      materializedFingerprint: '3'.repeat(64),
      materializations: [],
    })).toThrow('requires creator capability');
  });
});
