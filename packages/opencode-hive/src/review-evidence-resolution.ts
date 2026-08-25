import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { canonicalJson, compareUnicodeCodePoints, isDeepEqual, sortedUniqueCodePoints } from './review-runtime-kernel.js';
import {
  parseGitHubPullRequestDescriptor,
  parseReviewSourceResolution,
  reviewProvenanceEnvelope,
  type GitHubPullRequestDescriptor,
  type ReviewProvenanceEnvelope,
  type ReviewSourceResolution,
} from './review-source-resolution.js';

const REVIEW_EVIDENCE_FINGERPRINT_SCHEMA = 'hive-review-evidence-fingerprint/v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type ReviewIntentPacket = {
  rawIntent: string;
  normalizedIntent: string;
  githubPullRequest: GitHubPullRequestDescriptor | null;
  descriptorSource: 'none' | 'standalone-url';
  fixedArtifacts: string[];
};

export const REVIEW_INLINE_SUBJECT_KINDS = ['process', 'concept', 'general'] as const;
export type ReviewInlineSubjectKind = typeof REVIEW_INLINE_SUBJECT_KINDS[number];

export type RuntimeCapturedReviewArtifact = {
  path: string;
  digest: string;
  byteLength: number;
};

type ReviewEvidenceResolutionCommon = {
  schema: 'hive-review-evidence-resolution/v1';
  intentFingerprint: string;
  scopeFingerprint: string;
  sourceFingerprint: string;
  resolutionFingerprint: string;
  truncated: boolean;
  errors: string[];
};

export type GitReviewEvidenceResolution = ReviewEvidenceResolutionCommon & {
  kind: 'git';
  evidence: {
    sourceResolution: ReviewSourceResolution;
    provenance: ReviewProvenanceEnvelope;
  };
};

export type InlineReviewEvidenceResolution = ReviewEvidenceResolutionCommon & {
  kind: 'inline';
  evidence: {
    subjectKind: ReviewInlineSubjectKind;
    contentDigest: string;
    byteLength: number;
  };
};

export type LocalArtifactsReviewEvidenceResolution = ReviewEvidenceResolutionCommon & {
  kind: 'local-artifacts';
  evidence: {
    artifacts: RuntimeCapturedReviewArtifact[];
  };
};

export type ReviewEvidenceResolution =
  | GitReviewEvidenceResolution
  | InlineReviewEvidenceResolution
  | LocalArtifactsReviewEvidenceResolution;

export type ReviewEvidenceResolutionInput =
  | {
      kind: 'git';
      intent: ReviewIntentPacket;
      sourceResolution: ReviewSourceResolution;
    }
  | {
      kind: 'inline';
      intent: ReviewIntentPacket;
      subjectKind: ReviewInlineSubjectKind;
    }
  | {
      kind: 'local-artifacts';
      intent: ReviewIntentPacket;
      artifacts: readonly RuntimeCapturedReviewArtifact[];
      truncated?: boolean;
      errors?: readonly string[];
    };

function recordValue(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field}: must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${field}: unknown key ${key}`);
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`${field}.${key}: is required`);
  }
  return record;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field}: must be a string`);
  return value;
}

function nonemptyString(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (result.length === 0) throw new Error(`${field}: must be a non-empty string`);
  return result;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field}: must be a non-negative safe integer`);
  }
  return value as number;
}

function sha256Value(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${field}: must be a SHA-256 digest`);
  }
  return value;
}

function versionedFingerprint(domain: string, value: unknown): string {
  return createHash('sha256').update(canonicalJson({
    schema: REVIEW_EVIDENCE_FINGERPRINT_SCHEMA,
    domain,
    value,
  })).digest('hex');
}

export function normalizeReviewArtifactPath(value: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('-')
    || value.includes(':')
    || value.endsWith('/')
    || value.includes('\\')
    || /[\u0000-\u0020\u007f\u0085\u2028\u2029]/u.test(value)
    || path.posix.isAbsolute(value)
  ) {
    throw new Error(`Artifact path must be a project-relative canonical file: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized !== value
    || normalized.split('/').some((component) => component === '.git' || component === '.hive')
  ) {
    throw new Error(`Artifact path must be a project-relative canonical file: ${value}`);
  }
  return normalized;
}

export function canonicalizeReviewArtifactPaths(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new Error('fixedArtifacts: must be a string array');
  }
  return sortedUniqueCodePoints(values.map(normalizeReviewArtifactPath));
}

function parseDescriptor(value: unknown, field: string): GitHubPullRequestDescriptor {
  const descriptor = recordValue(value, ['owner', 'repository', 'number'], [], field);
  const owner = nonemptyString(descriptor.owner, `${field}.owner`);
  const repository = nonemptyString(descriptor.repository, `${field}.repository`);
  if (!Number.isSafeInteger(descriptor.number) || (descriptor.number as number) < 1) {
    throw new Error(`${field}.number: must be a positive safe integer`);
  }
  const parsed = parseGitHubPullRequestDescriptor(
    `https://github.com/${owner}/${repository}/pull/${descriptor.number as number}`,
  );
  if (!parsed) throw new Error(`${field}: invalid GitHub pull-request descriptor`);
  return parsed;
}

export function parseReviewIntentPacket(value: unknown): ReviewIntentPacket {
  const record = recordValue(value, [
    'rawIntent', 'normalizedIntent', 'githubPullRequest', 'descriptorSource', 'fixedArtifacts',
  ], [], 'intent');
  const rawIntent = stringValue(record.rawIntent, 'intent.rawIntent');
  const normalizedIntent = stringValue(record.normalizedIntent, 'intent.normalizedIntent');
  const githubPullRequest = record.githubPullRequest === null
    ? null
    : parseDescriptor(record.githubPullRequest, 'intent.githubPullRequest');
  if (!['none', 'standalone-url'].includes(String(record.descriptorSource))) {
    throw new Error('intent.descriptorSource: invalid');
  }
  const descriptorSource = record.descriptorSource as ReviewIntentPacket['descriptorSource'];
  if ((githubPullRequest === null) !== (descriptorSource === 'none')) {
    throw new Error('intent.descriptorSource: inconsistent with GitHub descriptor');
  }
  if (githubPullRequest) {
    const urls = rawIntent.match(/https?:\/\/\S+/giu) ?? [];
    const descriptor = urls.length === 1 ? parseGitHubPullRequestDescriptor(urls[0]!) : null;
    if (!descriptor || !isDeepEqual(descriptor, githubPullRequest)) {
      throw new Error('intent.githubPullRequest: must contain one exact standalone URL selector');
    }
  } else if (/https?:\/\//iu.test(rawIntent)) {
    throw new Error('intent.rawIntent: unsupported HTTP(S) URL');
  }
  if (!Array.isArray(record.fixedArtifacts)) throw new Error('intent.fixedArtifacts: must be a string array');
  const fixedArtifacts = canonicalizeReviewArtifactPaths(record.fixedArtifacts as string[]);
  if (!isDeepEqual(fixedArtifacts, record.fixedArtifacts)) {
    throw new Error('intent.fixedArtifacts: must be sorted, unique, and canonical');
  }
  if (githubPullRequest && fixedArtifacts.length > 0) {
    throw new Error('Review intent cannot combine a GitHub pull request with fixed artifacts.');
  }
  return {
    rawIntent,
    normalizedIntent,
    githubPullRequest,
    descriptorSource,
    fixedArtifacts,
  };
}

export function fingerprintReviewIntent(value: ReviewIntentPacket): string {
  return versionedFingerprint('intent', value);
}

function parseSubjectKind(value: unknown): ReviewInlineSubjectKind {
  if (!REVIEW_INLINE_SUBJECT_KINDS.includes(value as ReviewInlineSubjectKind)) {
    throw new Error('reviewEvidence.subjectKind: invalid');
  }
  return value as ReviewInlineSubjectKind;
}

function canonicalErrors(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((error) => typeof error !== 'string' || error.length === 0)) {
    throw new Error(`${field}: must be a string array`);
  }
  return sortedUniqueCodePoints(value as string[]);
}

function parseArtifact(value: unknown, field: string): RuntimeCapturedReviewArtifact {
  const artifact = recordValue(value, ['path', 'digest', 'byteLength'], [], field);
  return {
    path: normalizeReviewArtifactPath(nonemptyString(artifact.path, `${field}.path`)),
    digest: sha256Value(artifact.digest, `${field}.digest`),
    byteLength: nonNegativeInteger(artifact.byteLength, `${field}.byteLength`),
  };
}

function canonicalArtifacts(value: unknown, field: string): RuntimeCapturedReviewArtifact[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field}: must be a non-empty array`);
  const artifacts = value.map((artifact, index) => parseArtifact(artifact, `${field}[${index}]`))
    .sort((left, right) => compareUnicodeCodePoints(left.path, right.path));
  if (new Set(artifacts.map(({ path: artifactPath }) => artifactPath)).size !== artifacts.length) {
    throw new Error(`${field}: paths must be unique`);
  }
  return artifacts;
}

function gitScopeAuthority(sourceResolution: ReviewSourceResolution): unknown {
  return {
    descriptor: sourceResolution.descriptor,
    kind: sourceResolution.kind,
    snapshotInput: sourceResolution.snapshotInput,
    manifestRepositoryIds: sourceResolution.provenance.manifestRepositoryIds,
    selectedRepositoryIds: sourceResolution.provenance.selectedRepositoryIds,
    selectedPaths: sourceResolution.provenance.selectedPaths,
  };
}

function gitSourceAuthority(sourceResolution: ReviewSourceResolution): unknown {
  return { reviewSourceResolutionAuthorityFingerprint: sourceResolution.provenance.fingerprint };
}

function finalizeResolution(
  kind: ReviewEvidenceResolution['kind'],
  intentFingerprint: string,
  scopeFingerprint: string,
  sourceFingerprint: string,
  truncated: boolean,
  errors: string[],
  evidence: ReviewEvidenceResolution['evidence'],
): ReviewEvidenceResolution {
  const basis = {
    schema: 'hive-review-evidence-resolution/v1' as const,
    kind,
    intentFingerprint,
    scopeFingerprint,
    sourceFingerprint,
    truncated,
    errors,
    evidence,
  };
  return {
    ...basis,
    resolutionFingerprint: versionedFingerprint('resolution', basis),
  } as ReviewEvidenceResolution;
}

function authorizedKind(intent: ReviewIntentPacket, kind: ReviewEvidenceResolution['kind']): void {
  if (intent.githubPullRequest && kind !== 'git') {
    throw new Error('GitHub pull-request intent fixes evidence kind git.');
  }
  if (intent.fixedArtifacts.length > 0 && kind !== 'local-artifacts') {
    throw new Error('Artifact intent fixes evidence kind local-artifacts.');
  }
  if (!intent.githubPullRequest && intent.fixedArtifacts.length === 0 && kind === 'local-artifacts') {
    throw new Error('Local-artifacts evidence requires packet-fixed artifacts.');
  }
}

export function resolveReviewEvidence(input: ReviewEvidenceResolutionInput): ReviewEvidenceResolution {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Review evidence input must be an object.');
  }
  const inputRecord = input as unknown as Record<string, unknown>;
  if (!['git', 'inline', 'local-artifacts'].includes(String(inputRecord.kind))) {
    throw new Error(`Unknown review evidence kind: ${String(inputRecord.kind)}.`);
  }
  const kind = inputRecord.kind as ReviewEvidenceResolution['kind'];
  const intent = parseReviewIntentPacket(inputRecord.intent);
  authorizedKind(intent, kind);
  const intentFingerprint = fingerprintReviewIntent(intent);

  if (kind === 'git') {
    const record = recordValue(input, ['kind', 'intent', 'sourceResolution'], [], 'reviewEvidence');
    const sourceResolution = parseReviewSourceResolution(record.sourceResolution);
    if (!isDeepEqual(sourceResolution.descriptor, intent.githubPullRequest)) {
      throw new Error('Git evidence descriptor must match the runtime-owned review intent.');
    }
    const provenance = reviewProvenanceEnvelope(sourceResolution);
    return finalizeResolution(
      'git',
      intentFingerprint,
      versionedFingerprint('git-scope', gitScopeAuthority(sourceResolution)),
      versionedFingerprint('git-source', gitSourceAuthority(sourceResolution)),
      provenance.truncated,
      canonicalErrors(provenance.errors, 'reviewEvidence.errors'),
      { sourceResolution, provenance },
    );
  }

  if (kind === 'inline') {
    const record = recordValue(input, ['kind', 'intent', 'subjectKind'], [], 'reviewEvidence');
    const subjectKind = parseSubjectKind(record.subjectKind);
    if (intent.normalizedIntent.trim().length === 0) {
      throw new Error('Inline review evidence requires nonempty normalized intent.');
    }
    const evidence: InlineReviewEvidenceResolution['evidence'] = {
      subjectKind,
      contentDigest: createHash('sha256').update(intent.normalizedIntent).digest('hex'),
      byteLength: Buffer.byteLength(intent.normalizedIntent),
    };
    return finalizeResolution(
      'inline',
      intentFingerprint,
      versionedFingerprint('inline-scope', { subjectKind }),
      versionedFingerprint('inline-source', evidence),
      false,
      [],
      evidence,
    );
  }

  const record = recordValue(input, ['kind', 'intent', 'artifacts'], ['truncated', 'errors'], 'reviewEvidence');
  const artifacts = canonicalArtifacts(record.artifacts, 'reviewEvidence.artifacts');
  const artifactPaths = artifacts.map(({ path: artifactPath }) => artifactPath);
  if (!isDeepEqual(artifactPaths, intent.fixedArtifacts)) {
    throw new Error('Runtime artifact captures must match packet-fixed artifacts exactly.');
  }
  if (record.truncated !== undefined && typeof record.truncated !== 'boolean') {
    throw new Error('reviewEvidence.truncated: must be boolean');
  }
  const truncated = record.truncated === undefined ? false : record.truncated as boolean;
  const errors = record.errors === undefined ? [] : canonicalErrors(record.errors, 'reviewEvidence.errors');
  const evidence: LocalArtifactsReviewEvidenceResolution['evidence'] = { artifacts };
  return finalizeResolution(
    'local-artifacts',
    intentFingerprint,
    versionedFingerprint('local-artifacts-scope', { paths: intent.fixedArtifacts }),
    versionedFingerprint('local-artifacts-source', evidence),
    truncated,
    errors,
    evidence,
  );
}

export function parseReviewEvidenceResolution(value: unknown): ReviewEvidenceResolution {
  const discriminant = recordValue(value, ['schema', 'kind'], [
    'intentFingerprint', 'scopeFingerprint', 'sourceFingerprint', 'resolutionFingerprint',
    'truncated', 'errors', 'evidence',
  ], 'reviewEvidenceResolution');
  if (discriminant.schema !== 'hive-review-evidence-resolution/v1') {
    throw new Error('reviewEvidenceResolution.schema: invalid');
  }
  if (!['git', 'inline', 'local-artifacts'].includes(String(discriminant.kind))) {
    throw new Error('reviewEvidenceResolution.kind: invalid');
  }
  const record = recordValue(value, [
    'schema', 'kind', 'intentFingerprint', 'scopeFingerprint', 'sourceFingerprint',
    'resolutionFingerprint', 'truncated', 'errors', 'evidence',
  ], [], 'reviewEvidenceResolution');
  const kind = record.kind as ReviewEvidenceResolution['kind'];
  const intentFingerprint = sha256Value(record.intentFingerprint, 'reviewEvidenceResolution.intentFingerprint');
  const scopeFingerprint = sha256Value(record.scopeFingerprint, 'reviewEvidenceResolution.scopeFingerprint');
  const sourceFingerprint = sha256Value(record.sourceFingerprint, 'reviewEvidenceResolution.sourceFingerprint');
  const resolutionFingerprint = sha256Value(record.resolutionFingerprint, 'reviewEvidenceResolution.resolutionFingerprint');
  if (typeof record.truncated !== 'boolean') throw new Error('reviewEvidenceResolution.truncated: must be boolean');
  const errors = canonicalErrors(record.errors, 'reviewEvidenceResolution.errors');
  if (!isDeepEqual(errors, record.errors)) {
    throw new Error('reviewEvidenceResolution.errors: must be sorted and unique');
  }

  let expected: ReviewEvidenceResolution;
  if (kind === 'git') {
    const evidenceRecord = recordValue(
      record.evidence,
      ['sourceResolution', 'provenance'],
      [],
      'reviewEvidenceResolution.evidence',
    );
    const sourceResolution = parseReviewSourceResolution(evidenceRecord.sourceResolution);
    const provenance = reviewProvenanceEnvelope(sourceResolution);
    if (!isDeepEqual(evidenceRecord.provenance, provenance)) {
      throw new Error('reviewEvidenceResolution.evidence.provenance: inconsistent');
    }
    expected = finalizeResolution(
      'git',
      intentFingerprint,
      versionedFingerprint('git-scope', gitScopeAuthority(sourceResolution)),
      versionedFingerprint('git-source', gitSourceAuthority(sourceResolution)),
      provenance.truncated,
      canonicalErrors(provenance.errors, 'reviewEvidenceResolution.errors'),
      { sourceResolution, provenance },
    );
  } else if (kind === 'inline') {
    const evidenceRecord = recordValue(
      record.evidence,
      ['subjectKind', 'contentDigest', 'byteLength'],
      [],
      'reviewEvidenceResolution.evidence',
    );
    const evidence: InlineReviewEvidenceResolution['evidence'] = {
      subjectKind: parseSubjectKind(evidenceRecord.subjectKind),
      contentDigest: sha256Value(evidenceRecord.contentDigest, 'reviewEvidenceResolution.evidence.contentDigest'),
      byteLength: nonNegativeInteger(evidenceRecord.byteLength, 'reviewEvidenceResolution.evidence.byteLength'),
    };
    expected = finalizeResolution(
      'inline',
      intentFingerprint,
      versionedFingerprint('inline-scope', { subjectKind: evidence.subjectKind }),
      versionedFingerprint('inline-source', evidence),
      false,
      [],
      evidence,
    );
  } else {
    const evidenceRecord = recordValue(
      record.evidence,
      ['artifacts'],
      [],
      'reviewEvidenceResolution.evidence',
    );
    const artifacts = canonicalArtifacts(
      evidenceRecord.artifacts,
      'reviewEvidenceResolution.evidence.artifacts',
    );
    if (!isDeepEqual(artifacts, evidenceRecord.artifacts)) {
      throw new Error('reviewEvidenceResolution.evidence.artifacts: must be sorted by path');
    }
    const evidence: LocalArtifactsReviewEvidenceResolution['evidence'] = { artifacts };
    expected = finalizeResolution(
      'local-artifacts',
      intentFingerprint,
      versionedFingerprint('local-artifacts-scope', { paths: artifacts.map(({ path: artifactPath }) => artifactPath) }),
      versionedFingerprint('local-artifacts-source', evidence),
      record.truncated,
      errors,
      evidence,
    );
  }

  if (scopeFingerprint !== expected.scopeFingerprint) {
    throw new Error('reviewEvidenceResolution.scopeFingerprint: fingerprint mismatch');
  }
  if (sourceFingerprint !== expected.sourceFingerprint) {
    throw new Error('reviewEvidenceResolution.sourceFingerprint: fingerprint mismatch');
  }
  if (record.truncated !== expected.truncated || !isDeepEqual(errors, expected.errors)) {
    throw new Error('reviewEvidenceResolution: inconsistent truncation or errors');
  }
  if (resolutionFingerprint !== expected.resolutionFingerprint) {
    throw new Error('reviewEvidenceResolution.resolutionFingerprint: fingerprint mismatch');
  }
  return expected;
}
