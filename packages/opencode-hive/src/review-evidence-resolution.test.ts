import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  canonicalizeReviewArtifactPaths,
  fingerprintReviewIntent,
  parseReviewEvidenceResolution,
  parseReviewIntentPacket,
  resolveReviewEvidence,
  type ReviewIntentPacket,
  type RuntimeCapturedReviewArtifact,
} from './review-evidence-resolution.js';
import {
  resolveReviewSource,
  reviewProvenanceEnvelope,
  type GitHubPullRequestDescriptor,
  type ReviewSourceResolution,
} from './review-source-resolution.js';
import type { GitSnapshot, GitSnapshotInput } from './utils/git-snapshot.js';

const descriptor: GitHubPullRequestDescriptor = {
  owner: 'AURIN-OFFICE',
  repository: 'data-etl',
  number: 295,
};
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

function intent(overrides: Partial<ReviewIntentPacket> = {}): ReviewIntentPacket {
  return {
    rawIntent: 'Review the supplied evidence.',
    normalizedIntent: 'Review the supplied evidence.',
    githubPullRequest: null,
    descriptorSource: 'none',
    fixedArtifacts: [],
    ...overrides,
  };
}

function snapshot(input: GitSnapshotInput): GitSnapshot {
  return {
    repository: { root: '/repo', currentHead: input.targetRef ?? 'c'.repeat(40) },
    scope: {
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      ...(input.targetRef ? { targetRef: input.targetRef } : {}),
      paths: input.paths ?? [],
      comparisonBase: input.baseRef ?? 'd'.repeat(40),
      comparisonTarget: input.targetRef ?? 'c'.repeat(40),
    },
    limits: { maxFiles: 100, maxPatchBytes: 65536 },
    changedPaths: {
      comparison: ['src/index.ts'],
      staged: [],
      unstaged: [],
      untracked: [],
    },
    fingerprint: 'f'.repeat(64),
    patch: '',
    omissions: {
      changedPaths: { comparison: 0, staged: 0, unstaged: 0, untracked: 0 },
      patch: { truncated: false, omittedBytes: 0 },
    },
  };
}

async function gitResolution(
  githubPullRequest: GitHubPullRequestDescriptor | null = null,
): Promise<ReviewSourceResolution> {
  return resolveReviewSource(
    githubPullRequest ? { descriptor: githubPullRequest } : { explicitLocal: {} },
    {
      providerExecutor: async () => ({ stdout: JSON.stringify({ baseSha, headSha }) }),
      resolveRepositories: async () => ({
        manifestRepositoryIds: ['root'],
        selectedRepositoryIds: ['root'],
        repositories: [{ id: 'root', path: '/repo' }],
      }),
      snapshotExecutor: async (_topology, input) => ({
        snapshots: [{ repositoryId: 'root', snapshot: snapshot(input) }],
      }),
    },
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function versionedFingerprint(domain: string, value: unknown): string {
  return createHash('sha256').update(canonicalJson({
    schema: 'hive-review-evidence-fingerprint/v1',
    domain,
    value,
  })).digest('hex');
}

describe('review evidence resolution', () => {
  it('fingerprints the complete canonical runtime-owned intent with versioned serialization', () => {
    const packet = intent({
      rawIntent: '--artifact z.ts --artifact a.ts',
      normalizedIntent: ' ',
      fixedArtifacts: ['a.ts', 'z.ts'],
    });

    expect(fingerprintReviewIntent(packet)).toBe(versionedFingerprint('intent', packet));
    expect(parseReviewIntentPacket(structuredClone(packet))).toEqual(packet);
  });

  it('rejects malformed or non-canonical intent authority', () => {
    expect(() => parseReviewIntentPacket({
      ...intent(),
      fixedArtifacts: ['z.ts', 'a.ts'],
    })).toThrow('fixedArtifacts');
    expect(() => parseReviewIntentPacket({
      ...intent({
        rawIntent: 'https://github.com/AURIN-OFFICE/data-etl/pull/295',
        normalizedIntent: '',
        fixedArtifacts: ['report.md'],
      }),
      githubPullRequest: descriptor,
      descriptorSource: 'standalone-url',
    })).toThrow('cannot combine');
    expect(() => parseReviewIntentPacket({
      ...intent(),
      descriptorSource: 'embedded-url',
    })).toThrow('descriptorSource');
    expect(() => parseReviewIntentPacket({
      ...intent(),
      extra: true,
    })).toThrow('unknown key');
  });

  it('uses exact normalized intent bytes for inline digest and length without serializing content', () => {
    const content = 'AURIN evidence\r\nwith a unicode snowman: \u2603';
    const packet = intent({ rawIntent: content, normalizedIntent: content });
    const resolution = resolveReviewEvidence({
      kind: 'inline',
      intent: packet,
      subjectKind: 'concept',
    });

    expect(resolution).toMatchObject({
      schema: 'hive-review-evidence-resolution/v1',
      kind: 'inline',
      intentFingerprint: fingerprintReviewIntent(packet),
      truncated: false,
      errors: [],
      evidence: {
        subjectKind: 'concept',
        contentDigest: createHash('sha256').update(content).digest('hex'),
        byteLength: Buffer.byteLength(content),
      },
    });
    expect(JSON.stringify(resolution)).not.toContain(content);
    expect(parseReviewEvidenceResolution(JSON.parse(JSON.stringify(resolution)))).toEqual(resolution);
  });

  it('rejects empty inline content and invalid runtime subject kinds', () => {
    expect(() => resolveReviewEvidence({
      kind: 'inline',
      intent: intent({ rawIntent: '', normalizedIntent: '' }),
      subjectKind: 'general',
    })).toThrow('nonempty normalized intent');
    expect(() => resolveReviewEvidence({
      kind: 'inline',
      intent: intent(),
      subjectKind: 'code' as 'general',
    })).toThrow('subjectKind');
  });

  it.each([
    ['spaces', '   ', '49e0be95e950b072577f624b4592bce1120bfcf2f3a4f0fc641f7ef6d69b47ad'],
    ['tabs', '\t\t', 'dcc19cebf2817328d3d5d1ad5fa501b09f8aa2d76c1d79c63fde3a72166c1ae1'],
    ['LF', '\n\n', 'f2c818292aa68d338b5b8a3edb10e3c79f95a5eb2a9b44331f3b8fde3f278cbe'],
    ['CRLF', '\r\n\r\n', 'e0fa2635b9b4be9f455d78cc2ac3fceb3f3843c9a57ea2e99cab554ed7bae223'],
  ])('rejects whitespace-only %s inline content without rewriting its bytes', (_case, content, expectedFingerprint) => {
    const packet = intent({ rawIntent: content, normalizedIntent: content });
    expect(() => resolveReviewEvidence({
      kind: 'inline',
      intent: packet,
      subjectKind: 'general',
    })).toThrow('nonempty normalized intent');
    expect(fingerprintReviewIntent(packet)).toBe(expectedFingerprint);
  });

  it('wraps the existing Git resolution and compact provenance unchanged', async () => {
    const sourceResolution = await gitResolution(descriptor);
    const packet = intent({
      rawIntent: 'https://github.com/AURIN-OFFICE/data-etl/pull/295',
      normalizedIntent: '',
      githubPullRequest: descriptor,
      descriptorSource: 'standalone-url',
    });
    const resolution = resolveReviewEvidence({ kind: 'git', intent: packet, sourceResolution });

    expect(resolution.evidence).toEqual({
      sourceResolution,
      provenance: reviewProvenanceEnvelope(sourceResolution),
    });
    expect(resolution.truncated).toBe(false);
    expect(resolution.errors).toEqual([]);
    expect(parseReviewEvidenceResolution(JSON.parse(JSON.stringify(resolution)))).toEqual(resolution);
  });

  it('authorizes exactly one source kind from fixed intent selectors', async () => {
    const localGit = await gitResolution();
    const prIntent = intent({
      rawIntent: 'https://github.com/AURIN-OFFICE/data-etl/pull/295',
      normalizedIntent: '',
      githubPullRequest: descriptor,
      descriptorSource: 'standalone-url',
    });
    const artifactIntent = intent({ fixedArtifacts: ['report.md'] });

    expect(() => resolveReviewEvidence({ kind: 'inline', intent: prIntent, subjectKind: 'general' }))
      .toThrow('fixes evidence kind git');
    expect(() => resolveReviewEvidence({ kind: 'local-artifacts', intent: prIntent, artifacts: [] }))
      .toThrow('fixes evidence kind git');
    expect(() => resolveReviewEvidence({ kind: 'git', intent: artifactIntent, sourceResolution: localGit }))
      .toThrow('fixes evidence kind local-artifacts');
    expect(() => resolveReviewEvidence({ kind: 'inline', intent: artifactIntent, subjectKind: 'general' }))
      .toThrow('fixes evidence kind local-artifacts');
    expect(() => resolveReviewEvidence({ kind: 'local-artifacts', intent: intent(), artifacts: [] }))
      .toThrow('requires packet-fixed artifacts');
    expect(resolveReviewEvidence({ kind: 'git', intent: intent(), sourceResolution: localGit }).kind).toBe('git');
    expect(resolveReviewEvidence({ kind: 'inline', intent: intent(), subjectKind: 'process' }).kind).toBe('inline');
  });

  it('requires runtime artifact captures to match packet-fixed paths exactly', () => {
    const packet = intent({ fixedArtifacts: ['a.md', 'z.md'] });
    const artifacts: RuntimeCapturedReviewArtifact[] = [
      { path: 'z.md', digest: 'b'.repeat(64), byteLength: 20 },
      { path: 'a.md', digest: 'a'.repeat(64), byteLength: 10 },
    ];
    const resolution = resolveReviewEvidence({
      kind: 'local-artifacts',
      intent: packet,
      artifacts,
      truncated: true,
      errors: ['z:error', 'a:error', 'z:error'],
    });

    expect(resolution).toMatchObject({
      kind: 'local-artifacts',
      truncated: true,
      errors: ['a:error', 'z:error'],
      evidence: {
        artifacts: [
          { path: 'a.md', digest: 'a'.repeat(64), byteLength: 10 },
          { path: 'z.md', digest: 'b'.repeat(64), byteLength: 20 },
        ],
      },
    });
    expect(() => resolveReviewEvidence({
      kind: 'local-artifacts',
      intent: packet,
      artifacts: [{ path: 'other.md', digest: 'a'.repeat(64), byteLength: 10 }],
    })).toThrow('must match packet-fixed artifacts');
    expect(() => resolveReviewEvidence({
      kind: 'local-artifacts',
      intent: packet,
      artifacts: [...artifacts, artifacts[0]!],
    })).toThrow('unique');
  });

  it('canonicalizes local artifact order into deterministic scope, source, and resolution fingerprints', () => {
    const packet = intent({ fixedArtifacts: canonicalizeReviewArtifactPaths(['z.md', 'a.md']) });
    const first = resolveReviewEvidence({
      kind: 'local-artifacts',
      intent: packet,
      artifacts: [
        { path: 'z.md', digest: 'b'.repeat(64), byteLength: 20 },
        { path: 'a.md', digest: 'a'.repeat(64), byteLength: 10 },
      ],
    });
    const reordered = resolveReviewEvidence({
      kind: 'local-artifacts',
      intent: structuredClone(packet),
      artifacts: [
        { path: 'a.md', digest: 'a'.repeat(64), byteLength: 10 },
        { path: 'z.md', digest: 'b'.repeat(64), byteLength: 20 },
      ],
    });
    const changed = resolveReviewEvidence({
      kind: 'local-artifacts',
      intent: packet,
      artifacts: [
        { path: 'a.md', digest: 'c'.repeat(64), byteLength: 10 },
        { path: 'z.md', digest: 'b'.repeat(64), byteLength: 20 },
      ],
    });

    expect(reordered).toEqual(first);
    expect(changed.scopeFingerprint).toBe(first.scopeFingerprint);
    expect(changed.sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(changed.resolutionFingerprint).not.toBe(first.resolutionFingerprint);
  });

  it('fails loud for unknown resolution kinds and malformed serialized envelopes', () => {
    expect(() => resolveReviewEvidence({ kind: 'remote' } as never)).toThrow('Unknown review evidence kind');
    expect(() => parseReviewEvidenceResolution({
      schema: 'hive-review-evidence-resolution/v1',
      kind: 'remote',
    })).toThrow('kind');

    const valid = resolveReviewEvidence({ kind: 'inline', intent: intent(), subjectKind: 'general' });
    expect(() => parseReviewEvidenceResolution({ ...valid, extra: true })).toThrow('unknown key');
    expect(() => parseReviewEvidenceResolution({
      ...valid,
      evidence: { ...valid.evidence, content: 'must not serialize' },
    })).toThrow('unknown key');
    expect(() => parseReviewEvidenceResolution({
      ...valid,
      sourceFingerprint: '0'.repeat(64),
    })).toThrow('sourceFingerprint');
    expect(() => parseReviewEvidenceResolution({
      ...valid,
      resolutionFingerprint: '0'.repeat(64),
    })).toThrow('resolutionFingerprint');
  });
});
