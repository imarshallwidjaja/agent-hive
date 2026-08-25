import { describe, expect, it } from 'bun:test';
import { DashReviewInvocationStore } from './dash-review-invocation.js';
import { resolveReviewEvidence, type ReviewIntentPacket } from './review-evidence-resolution.js';

const primaryAgent = '__hive_dash_review_primary';
const scopeAgent = 'review-scope';

function intent(overrides: Partial<ReviewIntentPacket> = {}): ReviewIntentPacket {
  return {
    rawIntent: 'Review the release process.',
    normalizedIntent: 'Review the release process.',
    githubPullRequest: null,
    descriptorSource: 'none',
    fixedArtifacts: [],
    ...overrides,
  };
}

function boundStore(packetIntent = intent(), now = () => 100): DashReviewInvocationStore {
  const store = new DashReviewInvocationStore({ now, capabilityTtlMs: 50 });
  store.replaceInvocation({
    primarySessionID: 'primary',
    primaryAgent,
    runtimeVersion: 3,
    packet: { schema: 'hive-dash-review-command/v3', intent: packetIntent },
  });
  expect(store.reserveScope({
    primarySessionID: 'primary',
    primaryAgent,
    runtimeVersion: 3,
    callID: 'scope-call',
    expectedAgent: scopeAgent,
    reservedAt: 100,
    background: false,
  })).toEqual({ allowed: true });
  expect(store.bindTaskChild({
    primarySessionID: 'primary',
    callID: 'scope-call',
    childSessionID: 'scope-child',
    expectedAgent: scopeAgent,
    runtimeVersion: 3,
  })).toBe(true);
  const binding = store.beginConsumerBinding({
    childSessionID: 'scope-child',
    inputAgent: scopeAgent,
    messageAgent: scopeAgent,
    runtimeVersion: 3,
  });
  expect(binding).toBeDefined();
  expect(store.commitConsumerBinding(binding!, {
    id: 'scope-child',
    parentID: 'primary',
    time: { created: 101 },
  })).toBe(true);
  return store;
}

describe('DashReviewInvocationStore evidence lifecycle', () => {
  it('rejects recovered frozen roots from the wrong workspace service kind', () => {
    const store = new DashReviewInvocationStore();
    expect(store.restoreClaimedWorkspace({
      primarySessionID: 'primary',
      primaryAgent,
      runtimeVersion: 3,
      runId: 'review-run',
      ownershipToken: 'token',
      workspacePath: '/tmp/review-run',
      boundary: {
        kind: 'git',
        scopeFingerprint: '1'.repeat(64),
        sourceFingerprint: '2'.repeat(64),
        resolutionFingerprint: '3'.repeat(64),
      },
      frozenRoot: {
        canonicalPath: '/tmp/review-run',
        dev: 1n,
        ino: 2n,
        mode: 0o40700n,
        serviceKind: 'evidence-bundle',
      },
    })).toBe(false);
  });

  it('stores the v3 packet and grants exactly one invocation-bound resolution', () => {
    const packetIntent = intent();
    const store = boundStore(packetIntent);
    const first = store.beginEvidenceResolution({
      session: { id: 'scope-child', parentID: 'primary', time: { created: 101 } },
      agent: scopeAgent,
      runtimeVersion: 3,
      requestedKind: 'inline',
    });
    expect(first).toMatchObject({ kind: 'execute', intent: packetIntent });

    expect(store.beginEvidenceResolution({
      session: { id: 'scope-child', parentID: 'primary', time: { created: 101 } },
      agent: scopeAgent,
      runtimeVersion: 3,
      requestedKind: 'inline',
    })).toEqual({ kind: 'deny', reason: 'evidence-resolution-in-progress' });

    if (first.kind !== 'execute') throw new Error('expected evidence authority');
    const resolution = resolveReviewEvidence({ kind: 'inline', intent: first.intent, subjectKind: 'process' });
    expect(store.recordEvidenceResolution(first.authority, {
      resolution,
      plan: { kind: 'inline', bytes: Buffer.from(first.intent.normalizedIntent) },
    })).toBe(true);
    expect(store.beginEvidenceResolution({
      session: { id: 'scope-child', parentID: 'primary', time: { created: 101 } },
      agent: scopeAgent,
      runtimeVersion: 3,
      requestedKind: 'inline',
    })).toEqual({ kind: 'deny', reason: 'capability-consumed' });
  });

  it.each([
    [
      'pull request',
      intent({
        rawIntent: 'https://github.com/example/project/pull/1',
        normalizedIntent: '',
        githubPullRequest: { owner: 'example', repository: 'project', number: 1 },
        descriptorSource: 'standalone-url',
      }),
      'inline',
    ],
    [
      'artifact selector',
      intent({ rawIntent: '--artifact report.bin', normalizedIntent: '', fixedArtifacts: ['report.bin'] }),
      'git',
    ],
    ['empty intent', intent({ rawIntent: '', normalizedIntent: '' }), 'inline'],
  ] as const)('rejects a model-selected evidence kind that conflicts with %s authority', (_name, packetIntent, requestedKind) => {
    const store = boundStore(packetIntent);
    expect(store.beginEvidenceResolution({
      session: { id: 'scope-child', parentID: 'primary', time: { created: 101 } },
      agent: scopeAgent,
      runtimeVersion: 3,
      requestedKind,
    })).toEqual({ kind: 'deny', reason: 'evidence-kind-mismatch' });
  });

  it.each([
    ['spaces', '   '],
    ['tabs', '\t\t'],
    ['LF', '\n\n'],
    ['CRLF', '\r\n\r\n'],
  ])('treats whitespace-only %s intent as semantic empty Git-only authority', (_case, whitespace) => {
    const packetIntent = intent({ rawIntent: whitespace, normalizedIntent: whitespace });
    const inlineStore = boundStore(packetIntent);
    expect(inlineStore.beginEvidenceResolution({
      session: { id: 'scope-child', parentID: 'primary', time: { created: 101 } },
      agent: scopeAgent,
      runtimeVersion: 3,
      requestedKind: 'inline',
    })).toEqual({ kind: 'deny', reason: 'evidence-kind-mismatch' });

    const gitStore = boundStore(packetIntent);
    expect(gitStore.beginEvidenceResolution({
      session: { id: 'scope-child', parentID: 'primary', time: { created: 101 } },
      agent: scopeAgent,
      runtimeVersion: 3,
      requestedKind: 'git',
    })).toMatchObject({ kind: 'execute', intent: packetIntent });
  });

  it('consumes create authority only for the exact resolution fingerprint and returns the private plan', () => {
    const packetIntent = intent();
    const resolution = resolveReviewEvidence({ kind: 'inline', intent: packetIntent, subjectKind: 'concept' });
    const plan = { kind: 'inline' as const, bytes: Buffer.from(packetIntent.normalizedIntent) };
    const resolvedStore = (): DashReviewInvocationStore => {
      const store = boundStore(packetIntent);
      const started = store.beginEvidenceResolution({
        session: { id: 'scope-child', parentID: 'primary', time: { created: 101 } },
        agent: scopeAgent,
        runtimeVersion: 3,
        requestedKind: 'inline',
      });
      if (started.kind !== 'execute') throw new Error('expected evidence authority');
      expect(store.recordEvidenceResolution(started.authority, {
        resolution,
        plan,
      })).toBe(true);
      return store;
    };

    const store = resolvedStore();
    const action = store.takeCreate({
      session: { id: 'scope-child', parentID: 'primary', time: { created: 101 } },
      agent: scopeAgent,
      runtimeVersion: 3,
      resolutionFingerprint: resolution.resolutionFingerprint,
    });
    expect(action).toMatchObject({ kind: 'execute', resolution, plan: { kind: 'inline' } });
    if (action.kind !== 'execute' || action.plan.kind !== 'inline') throw new Error('expected inline create plan');
    expect(Buffer.from(action.plan.bytes)).toEqual(plan.bytes);
    expect(store.takeCreate({
      session: { id: 'scope-child', parentID: 'primary', time: { created: 101 } },
      agent: scopeAgent,
      runtimeVersion: 3,
      resolutionFingerprint: resolution.resolutionFingerprint,
    })).toEqual({ kind: 'deny', reason: 'capability-consumed' });

    expect(resolvedStore().takeCreate({
      session: { id: 'scope-child', parentID: 'primary', time: { created: 101 } },
      agent: scopeAgent,
      runtimeVersion: 3,
      resolutionFingerprint: '0'.repeat(64),
    })).toEqual({ kind: 'deny', reason: 'resolution-fingerprint-mismatch' });
  });

  it('fails closed for the wrong child, version mismatch, and exact expiry boundary', () => {
    let now = 100;
    const store = boundStore(intent(), () => now);
    expect(store.beginEvidenceResolution({
      session: { id: 'wrong-child', parentID: 'primary', time: { created: 101 } },
      agent: scopeAgent,
      runtimeVersion: 3,
      requestedKind: 'git',
    })).toEqual({ kind: 'deny', reason: 'child-not-bound-to-invocation' });

    const versionStore = boundStore();
    expect(versionStore.beginEvidenceResolution({
      session: { id: 'scope-child', parentID: 'primary', time: { created: 101 } },
      agent: scopeAgent,
      runtimeVersion: 4,
      requestedKind: 'git',
    })).toEqual({ kind: 'deny', reason: 'runtime-generated-version-mismatch' });

    const expiryStore = boundStore(intent(), () => now);
    now = 150;
    expect(expiryStore.beginEvidenceResolution({
      session: { id: 'scope-child', parentID: 'primary', time: { created: 101 } },
      agent: scopeAgent,
      runtimeVersion: 3,
      requestedKind: 'git',
    })).toEqual({ kind: 'deny', reason: 'capability-expired' });
  });
});
