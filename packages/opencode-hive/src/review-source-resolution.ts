import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { ParsedDashReviewArgs, ParsedVulnerabilityReviewArgs } from './commands/renderers.js';
import { compareUnicodeCodePoints, safeGitRef, sortedUniqueCodePoints } from './review-runtime-kernel.js';
import {
  fingerprintReviewSourceScope,
  GitSnapshotError,
} from './utils/git-snapshot.js';
import type { GitSnapshot, GitSnapshotInput } from './utils/git-snapshot.js';

const execFileAsync = promisify(execFile);
const GITHUB_PULL_REQUEST_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]*)\/?$/;
const FULL_OID_PATTERN = /^[a-f0-9]{40}$/;
const GIT_OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PROVIDER_TIMEOUT_MS = 5000;
const PROVIDER_MAX_OUTPUT_BYTES = 16 * 1024;

export type GitHubPullRequestDescriptor = {
  owner: string;
  repository: string;
  number: number;
};

export type ReviewProviderOutcome =
  | { kind: 'not-requested'; reason: 'no-descriptor' | 'explicit-selector' }
  | { kind: 'resolved'; baseSha: string; headSha: string }
  | {
    kind: 'unavailable';
    reason: 'cli-unavailable' | 'timeout' | 'output-truncated' | 'auth-network-execution' | 'malformed-response';
  };

export type ReviewResolutionKind = 'explicit-local' | 'provider-verified' | 'provider-local-fallback';

export type SnapshotTopology = {
  manifestRepositoryIds: string[];
  selectedRepositoryIds: string[];
  repositories: Array<{ id: string; path: string }>;
};

export type SnapshotSet = {
  snapshots: Array<{ repositoryId: string; snapshot: GitSnapshot }>;
};

type SnapshotFailure = {
  code: 'missing-ref';
  field: 'base' | 'head';
  missingOid: string;
  repositoryId: string;
};

type SnapshotOutcome =
  | { outcome: 'resolved' }
  | { outcome: 'fallback'; reason: 'provider-unavailable' }
  | { outcome: 'fallback'; reason: 'missing-provider-oid'; failures: SnapshotFailure[] };

type ReviewSnapshotRepositoryOutcome =
  | { repositoryId: string; outcome: 'resolved'; snapshot: GitSnapshot }
  | { repositoryId: string; outcome: 'failed'; error: unknown };

export class ReviewSnapshotSetError extends Error {
  readonly outcomes: readonly ReviewSnapshotRepositoryOutcome[];
  readonly failures: readonly Extract<ReviewSnapshotRepositoryOutcome, { outcome: 'failed' }>[];

  constructor(outcomes: ReviewSnapshotRepositoryOutcome[]) {
    const canonical = [...outcomes].sort((left, right) => compareUnicodeCodePoints(left.repositoryId, right.repositoryId));
    const failures = canonical.filter((outcome): outcome is Extract<ReviewSnapshotRepositoryOutcome, { outcome: 'failed' }> => (
      outcome.outcome === 'failed'
    ));
    super(`Review snapshot failed for repositories: ${failures.map(({ repositoryId }) => repositoryId).join(', ')}.`);
    this.name = 'ReviewSnapshotSetError';
    this.outcomes = Object.freeze(canonical);
    this.failures = Object.freeze(failures);
  }
}

export class ReviewProviderOidUnavailableError extends Error {
  readonly code = 'provider-oid-unavailable';
  readonly failures: readonly SnapshotFailure[];

  constructor(failures: SnapshotFailure[]) {
    super('[provider-oid-unavailable] Exact provider OIDs are unavailable in the selected local repository object stores; isolated acquisition is unavailable.');
    this.name = 'ReviewProviderOidUnavailableError';
    this.failures = Object.freeze(structuredClone(failures));
  }
}

export async function collectReviewSnapshotSet(
  topology: SnapshotTopology,
  execute: (repository: SnapshotTopology['repositories'][number]) => Promise<GitSnapshot>,
): Promise<SnapshotSet> {
  const repositories = [...topology.repositories]
    .sort((left, right) => compareUnicodeCodePoints(left.id, right.id));
  const outcomes = await Promise.all(repositories.map(async (repository): Promise<ReviewSnapshotRepositoryOutcome> => {
    try {
      return { repositoryId: repository.id, outcome: 'resolved', snapshot: await execute(repository) };
    } catch (error) {
      const failure = error instanceof GitSnapshotError
        ? new GitSnapshotError(error.code, { ...error.details, repositoryId: repository.id })
        : error;
      return { repositoryId: repository.id, outcome: 'failed', error: failure };
    }
  }));
  const failures = outcomes.filter((outcome): outcome is Extract<ReviewSnapshotRepositoryOutcome, { outcome: 'failed' }> => (
    outcome.outcome === 'failed'
  ));
  if (outcomes.length === 1 && failures.length === 1) throw failures[0]!.error;
  if (failures.length > 0) throw new ReviewSnapshotSetError(outcomes);
  return {
    snapshots: outcomes.map((outcome) => ({
      repositoryId: outcome.repositoryId,
      snapshot: (outcome as Extract<ReviewSnapshotRepositoryOutcome, { outcome: 'resolved' }>).snapshot,
    })),
  };
}

type ReviewSourceResolutionCore = {
  schema: 'hive-review-source-resolution/v1';
  kind: ReviewResolutionKind;
  descriptor: GitHubPullRequestDescriptor | null;
  provider: ReviewProviderOutcome;
  candidateShas: { baseSha: string; headSha: string } | null;
  snapshotInput: GitSnapshotInput;
  provenance: {
    snapshot: SnapshotOutcome;
    manifestRepositoryIds: string[];
    selectedRepositoryIds: string[];
    selectedPaths: string[];
    repositories: Array<{
      repositoryId: string;
      sourceRoot: string;
      currentHead: string;
      comparisonBase: string | null;
      comparisonTarget: string;
      mergeBase: string | null;
      snapshotFingerprint: string;
      changedPaths: GitSnapshot['changedPaths'];
      omissions: GitSnapshot['omissions'];
      error: null;
    }>;
    sourceFingerprint: string;
    fingerprint: string;
  };
};

export type ReviewProvenanceEnvelope = {
  schema: 'hive-review-provenance/v1';
  scopeState: 'verified PR commits' | 'local snapshot scope' | 'unverified local checkout';
  descriptor: GitHubPullRequestDescriptor | null;
  metadataOutcome: ReviewProviderOutcome;
  baseSha: string | null;
  headSha: string | null;
  snapshotAttemptOutcome: SnapshotOutcome;
  comparisonTarget: string | null;
  currentHead: string | null;
  currentHeadMatchesProviderHead: boolean | null;
  dirtyFingerprint: string | null;
  fallbackReason: string | null;
  snapshotId: string;
  sourceFingerprint: string;
  selectedRepositoryIds: string[];
  truncated: boolean;
  errors: string[];
};

export type ReviewSourceResolution = ReviewSourceResolutionCore & {
  provenanceEnvelope?: ReviewProvenanceEnvelope;
};

export type ReviewSourceRequest = {
  descriptor: GitHubPullRequestDescriptor | null;
  repositoryIds?: string[];
  fixedSnapshotInput: GitSnapshotInput;
  fixedSelector?: ParsedVulnerabilityReviewArgs['overrides']['selector'];
  notRequestedReason: Extract<ReviewProviderOutcome, { kind: 'not-requested' }>['reason'];
};

function recordValue(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field}: must be an object`);
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
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field}: must be a non-empty string`);
  return value;
}

function canonicalStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${field}: must be a non-empty string array`);
  }
  const result = sortedUniqueCodePoints(value as string[]);
  if (result.length !== value.length || result.some((item, index) => item !== value[index])) {
    throw new Error(`${field}: must be sorted and unique by Unicode code point`);
  }
  return result;
}

function sha(value: unknown, length: 40 | 64, field: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) {
    throw new Error(`${field}: must be a ${length === 40 ? 'full OID' : 'SHA-256 fingerprint'}`);
  }
  return value;
}

function gitOid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GIT_OID_PATTERN.test(value)) throw new Error(`${field}: must be a full Git OID`);
  return value;
}

function normalizePaths(values: readonly string[] | undefined, field: string): string[] {
  return sortedUniqueCodePoints((values ?? []).map((value) => {
    if (
      !value
      || value.startsWith('-')
      || value.startsWith(':')
      || value.includes('\0')
      || value.includes('\\')
      || path.posix.isAbsolute(value)
    ) throw new Error(`${field}: invalid repository-relative path`);
    const normalized = path.posix.normalize(value);
    if (normalized === '..' || normalized.startsWith('../')) throw new Error(`${field}: invalid repository-relative path`);
    return normalized;
  }));
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field}: must be a positive integer`);
  return value as number;
}

function normalizeSnapshotInput(value: GitSnapshotInput, field: string): GitSnapshotInput {
  const record = recordValue(value, [], [
    'baseRef', 'targetRef', 'range', 'paths', 'maxFiles', 'maxPatchBytes',
  ], field);
  const result: GitSnapshotInput = {};
  if (record.baseRef !== undefined) result.baseRef = safeGitRef(record.baseRef, `${field}.baseRef`);
  if (record.targetRef !== undefined) result.targetRef = safeGitRef(record.targetRef, `${field}.targetRef`);
  if (record.range !== undefined) {
    const range = stringValue(record.range, `${field}.range`);
    const match = /^(.+?)(\.\.\.?)(.+)$/.exec(range);
    if (!match) throw new Error(`${field}.range: invalid Git range`);
    safeGitRef(match[1], `${field}.range.base`);
    safeGitRef(match[3], `${field}.range.target`);
    result.range = range;
  }
  if (record.range !== undefined && (record.baseRef !== undefined || record.targetRef !== undefined)) {
    throw new Error(`${field}: range cannot be combined with refs`);
  }
  if (record.paths !== undefined) {
    if (!Array.isArray(record.paths) || record.paths.some((entry) => typeof entry !== 'string')) {
      throw new Error(`${field}.paths: must be a string array`);
    }
    const paths = normalizePaths(record.paths as string[], `${field}.paths`);
    if (paths.length > 0) result.paths = paths;
  }
  if (record.maxFiles !== undefined) result.maxFiles = positiveInteger(record.maxFiles, `${field}.maxFiles`);
  if (record.maxPatchBytes !== undefined) result.maxPatchBytes = positiveInteger(record.maxPatchBytes, `${field}.maxPatchBytes`);
  return result;
}

function normalizeRepositoryIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`${field}: must be a string array`);
  }
  return sortedUniqueCodePoints(value as string[]);
}

export function resolveFixedVulnerabilityReviewSourceInput(
  request: ReviewSourceRequest,
  input: GitSnapshotInput & { repositoryIds?: string[] },
): { repositoryIds?: string[]; snapshotInput: GitSnapshotInput } {
  const { repositoryIds, ...rawSnapshotInput } = input;
  const childSnapshotInput = normalizeSnapshotInput(rawSnapshotInput, 'snapshotInput');
  const fixedSnapshotInput = normalizeSnapshotInput(request.fixedSnapshotInput, 'fixedSnapshotInput');
  const childRepositoryIds = repositoryIds === undefined
    ? undefined
    : normalizeRepositoryIds(repositoryIds, 'repositoryIds');
  if (
    request.repositoryIds !== undefined
    && childRepositoryIds !== undefined
    && !isDeepEqual(childRepositoryIds, request.repositoryIds)
  ) {
    throw new Error('Snapshot input conflicts with fixed vulnerability review source authority.');
  }
  if (
    fixedSnapshotInput.paths !== undefined
    && rawSnapshotInput.paths !== undefined
    && !isDeepEqual(childSnapshotInput.paths ?? [], fixedSnapshotInput.paths)
  ) {
    throw new Error('Snapshot input conflicts with fixed vulnerability review source authority.');
  }
  const childSelector = {
    ...(childSnapshotInput.range === undefined ? {} : { range: childSnapshotInput.range }),
    ...(childSnapshotInput.baseRef === undefined ? {} : { baseRef: childSnapshotInput.baseRef }),
    ...(childSnapshotInput.targetRef === undefined ? {} : { targetRef: childSnapshotInput.targetRef }),
  };
  const fixedSelector = {
    ...(fixedSnapshotInput.range === undefined ? {} : { range: fixedSnapshotInput.range }),
    ...(fixedSnapshotInput.baseRef === undefined ? {} : { baseRef: fixedSnapshotInput.baseRef }),
    ...(fixedSnapshotInput.targetRef === undefined ? {} : { targetRef: fixedSnapshotInput.targetRef }),
  };
  if (request.fixedSelector !== undefined || request.descriptor !== null) {
    for (const [field, value] of Object.entries(childSelector)) {
      if ((fixedSelector as Record<string, unknown>)[field] !== value) {
        throw new Error('Snapshot input conflicts with fixed vulnerability review source authority.');
      }
    }
    if (
      request.fixedSelector?.kind === 'whole-repository'
      && (childSnapshotInput.paths?.length ?? 0) > 0
    ) {
      throw new Error('Snapshot input conflicts with fixed vulnerability review source authority.');
    }
  }
  return {
    ...((request.repositoryIds ?? childRepositoryIds) === undefined
      ? {}
      : { repositoryIds: request.repositoryIds ?? childRepositoryIds }),
    snapshotInput: {
      ...childSnapshotInput,
      ...fixedSnapshotInput,
    },
  };
}

function parseSnapshotInput(value: unknown, field: string): GitSnapshotInput {
  const normalized = normalizeSnapshotInput(value as GitSnapshotInput, field);
  if (!isDeepEqual(value, normalized)) throw new Error(`${field}: must be canonical`);
  return normalized;
}

function parseChangedPaths(value: unknown, field: string): GitSnapshot['changedPaths'] {
  const record = recordValue(value, ['comparison', 'staged', 'unstaged', 'untracked'], [], field);
  return {
    comparison: canonicalStringArray(record.comparison, `${field}.comparison`),
    staged: canonicalStringArray(record.staged, `${field}.staged`),
    unstaged: canonicalStringArray(record.unstaged, `${field}.unstaged`),
    untracked: canonicalStringArray(record.untracked, `${field}.untracked`),
  };
}

function parseOmissions(value: unknown, field: string): GitSnapshot['omissions'] {
  const record = recordValue(value, ['changedPaths', 'patch'], [], field);
  const changed = recordValue(record.changedPaths, ['comparison', 'staged', 'unstaged', 'untracked'], [], `${field}.changedPaths`);
  const patch = recordValue(record.patch, ['truncated', 'omittedBytes'], [], `${field}.patch`);
  const count = (entry: unknown, entryField: string): number => {
    if (!Number.isSafeInteger(entry) || (entry as number) < 0) throw new Error(`${entryField}: must be a non-negative integer`);
    return entry as number;
  };
  if (typeof patch.truncated !== 'boolean') throw new Error(`${field}.patch.truncated: must be boolean`);
  return {
    changedPaths: {
      comparison: count(changed.comparison, `${field}.changedPaths.comparison`),
      staged: count(changed.staged, `${field}.changedPaths.staged`),
      unstaged: count(changed.unstaged, `${field}.changedPaths.unstaged`),
      untracked: count(changed.untracked, `${field}.changedPaths.untracked`),
    },
    patch: {
      truncated: patch.truncated,
      omittedBytes: count(patch.omittedBytes, `${field}.patch.omittedBytes`),
    },
  };
}

function parseSnapshotOutcome(value: unknown): SnapshotOutcome {
  const field = 'sourceResolution.provenance.snapshot';
  const discriminant = recordValue(value, ['outcome'], ['reason', 'failures'], field);
  if (discriminant.outcome === 'resolved') {
    recordValue(value, ['outcome'], [], field);
    return { outcome: 'resolved' };
  }
  if (discriminant.outcome !== 'fallback') throw new Error(`${field}.outcome: invalid`);
  if (discriminant.reason === 'provider-unavailable') {
    recordValue(value, ['outcome', 'reason'], [], field);
    return { outcome: 'fallback', reason: 'provider-unavailable' };
  }
  if (discriminant.reason !== 'missing-provider-oid') throw new Error(`${field}.reason: invalid`);
  const record = recordValue(value, ['outcome', 'reason', 'failures'], [], field);
  if (!Array.isArray(record.failures) || record.failures.length === 0) {
    throw new Error(`${field}.failures: must be a non-empty array`);
  }
  const failures = record.failures.map((entry, index): SnapshotFailure => {
    const itemField = `${field}.failures[${index}]`;
    const failure = recordValue(entry, ['code', 'field', 'missingOid', 'repositoryId'], [], itemField);
    if (failure.code !== 'missing-ref') throw new Error(`${itemField}.code: invalid`);
    if (failure.field !== 'base' && failure.field !== 'head') throw new Error(`${itemField}.field: invalid`);
    return {
      code: 'missing-ref',
      field: failure.field,
      missingOid: sha(failure.missingOid, 40, `${itemField}.missingOid`),
      repositoryId: stringValue(failure.repositoryId, `${itemField}.repositoryId`),
    };
  });
  if (!isDeepEqual(failures, [...failures].sort((left, right) => compareUnicodeCodePoints(left.repositoryId, right.repositoryId)))) {
    throw new Error(`${field}.failures: must be sorted by repositoryId`);
  }
  if (new Set(failures.map(({ repositoryId }) => repositoryId)).size !== failures.length) {
    throw new Error(`${field}.failures: repositoryId values must be unique`);
  }
  return {
    outcome: 'fallback',
    reason: 'missing-provider-oid',
    failures,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Canonical authority contains an unsupported value.');
  return encoded;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function fingerprintReviewSourceResolutionAuthority(value: unknown): string {
  return fingerprint(value);
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sourceFingerprint(input: {
  manifestRepositoryIds: string[];
  selectedRepositoryIds: string[];
  repositories: ReviewSourceResolution['provenance']['repositories'];
}): string {
  return fingerprintReviewSourceScope({
    manifestRepositoryIds: input.manifestRepositoryIds,
    selectedRepositoryIds: input.selectedRepositoryIds,
    snapshots: input.repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      sourceRoot: repository.sourceRoot,
      fingerprint: repository.snapshotFingerprint,
    })),
  });
}

function singleValue(values: readonly string[]): string | null {
  const unique = new Set(values);
  return unique.size === 1 ? values[0]! : null;
}

function buildReviewProvenanceEnvelope(resolution: ReviewSourceResolutionCore): ReviewProvenanceEnvelope {
  const dirtyRepositories = resolution.provenance.repositories.filter(({ changedPaths }) => (
    changedPaths.staged.length > 0
    || changedPaths.unstaged.length > 0
    || changedPaths.untracked.length > 0
  ));
  const fallbackReason = resolution.provenance.snapshot.outcome === 'fallback'
    ? resolution.provenance.snapshot.reason
    : null;
  const headSha = resolution.candidateShas?.headSha ?? null;
  const errors = resolution.provider.kind === 'unavailable'
    ? [`provider:${resolution.provider.reason}`]
    : resolution.provenance.snapshot.outcome === 'fallback'
        && resolution.provenance.snapshot.reason === 'missing-provider-oid'
      ? resolution.provenance.snapshot.failures.map(({ repositoryId, field }) => (
          `snapshot:${repositoryId}:${field}:missing-ref`
        ))
      : [];
  return {
    schema: 'hive-review-provenance/v1',
    scopeState: resolution.kind === 'provider-verified'
      ? 'verified PR commits'
      : resolution.kind === 'explicit-local'
        ? 'local snapshot scope'
        : 'unverified local checkout',
    descriptor: structuredClone(resolution.descriptor),
    metadataOutcome: structuredClone(resolution.provider),
    baseSha: resolution.candidateShas?.baseSha ?? null,
    headSha,
    snapshotAttemptOutcome: structuredClone(resolution.provenance.snapshot),
    comparisonTarget: singleValue(resolution.provenance.repositories.map(({ comparisonTarget }) => comparisonTarget)),
    currentHead: singleValue(resolution.provenance.repositories.map(({ currentHead }) => currentHead)),
    currentHeadMatchesProviderHead: headSha === null
      ? null
      : resolution.provenance.repositories.every(({ currentHead }) => currentHead === headSha),
    dirtyFingerprint: dirtyRepositories.length === 0
      ? null
      : fingerprint(dirtyRepositories.map(({ repositoryId, snapshotFingerprint }) => ({ repositoryId, snapshotFingerprint }))),
    fallbackReason,
    snapshotId: resolution.provenance.fingerprint,
    sourceFingerprint: resolution.provenance.sourceFingerprint,
    selectedRepositoryIds: [...resolution.provenance.selectedRepositoryIds],
    truncated: resolution.provenance.repositories.some(({ omissions }) => (
      omissions.patch.truncated
      || Object.values(omissions.changedPaths).some((count) => count > 0)
    )),
    errors,
  };
}

export function reviewProvenanceEnvelope(resolution: ReviewSourceResolution): ReviewProvenanceEnvelope {
  return resolution.provenanceEnvelope ?? buildReviewProvenanceEnvelope(resolution);
}

export function serializeReviewSnapshotOutput(input: {
  provenance: ReviewProvenanceEnvelope;
  sourceResolution: ReviewSourceResolution;
  snapshot: Record<string, unknown>;
}): string {
  const { provenance: _provenance, sourceResolution: _sourceResolution, ...snapshot } = input.snapshot;
  return JSON.stringify({
    provenance: input.provenance,
    sourceResolution: input.sourceResolution,
    ...snapshot,
  }, null, 2);
}

export function parseReviewSourceResolution(value: unknown): ReviewSourceResolution {
  const record = recordValue(value, [
    'schema', 'kind', 'descriptor', 'provider', 'candidateShas', 'snapshotInput', 'provenance',
  ], ['provenanceEnvelope'], 'sourceResolution');
  if (record.schema !== 'hive-review-source-resolution/v1') throw new Error('sourceResolution.schema: invalid');
  if (!['explicit-local', 'provider-verified', 'provider-local-fallback'].includes(String(record.kind))) {
    throw new Error('sourceResolution.kind: invalid');
  }
  let descriptor: GitHubPullRequestDescriptor | null = null;
  if (record.descriptor !== null) {
    const parsed = recordValue(record.descriptor, ['owner', 'repository', 'number'], [], 'sourceResolution.descriptor');
    const owner = stringValue(parsed.owner, 'sourceResolution.descriptor.owner');
    const repository = stringValue(parsed.repository, 'sourceResolution.descriptor.repository');
    const number = parsed.number;
    if (!Number.isSafeInteger(number) || (number as number) < 1) throw new Error('sourceResolution.descriptor.number: invalid');
    if (!parseGitHubPullRequestDescriptor(`https://github.com/${owner}/${repository}/pull/${number}`)) {
      throw new Error('sourceResolution.descriptor: invalid');
    }
    descriptor = { owner, repository, number: number as number };
  }
  const providerKind = record.provider && typeof record.provider === 'object'
    ? (record.provider as { kind?: unknown }).kind
    : undefined;
  const providerRecord = recordValue(
    record.provider,
    providerKind === 'resolved'
      ? ['kind', 'baseSha', 'headSha']
      : providerKind === 'unavailable'
        ? ['kind', 'reason']
        : providerKind === 'not-requested'
          ? ['kind', 'reason']
          : ['kind'],
    [],
    'sourceResolution.provider',
  );
  let provider: ReviewProviderOutcome;
  if (providerRecord.kind === 'resolved') {
    provider = {
      kind: 'resolved',
      baseSha: sha(providerRecord.baseSha, 40, 'sourceResolution.provider.baseSha'),
      headSha: sha(providerRecord.headSha, 40, 'sourceResolution.provider.headSha'),
    };
  } else if (providerRecord.kind === 'unavailable') {
    const reasons = ['cli-unavailable', 'timeout', 'output-truncated', 'auth-network-execution', 'malformed-response'] as const;
    if (!reasons.includes(providerRecord.reason as typeof reasons[number])) throw new Error('sourceResolution.provider.reason: invalid');
    provider = { kind: 'unavailable', reason: providerRecord.reason as typeof reasons[number] };
  } else if (providerRecord.kind === 'not-requested') {
    if (providerRecord.reason !== 'no-descriptor' && providerRecord.reason !== 'explicit-selector') {
      throw new Error('sourceResolution.provider.reason: invalid');
    }
    provider = { kind: 'not-requested', reason: providerRecord.reason };
  } else {
    throw new Error('sourceResolution.provider.kind: invalid');
  }
  let candidateShas: ReviewSourceResolution['candidateShas'] = null;
  if (record.candidateShas !== null) {
    const parsed = recordValue(record.candidateShas, ['baseSha', 'headSha'], [], 'sourceResolution.candidateShas');
    candidateShas = {
      baseSha: sha(parsed.baseSha, 40, 'sourceResolution.candidateShas.baseSha'),
      headSha: sha(parsed.headSha, 40, 'sourceResolution.candidateShas.headSha'),
    };
  }
  const snapshotInput = parseSnapshotInput(record.snapshotInput, 'sourceResolution.snapshotInput');
  const provenanceRecord = recordValue(record.provenance, [
    'snapshot', 'manifestRepositoryIds', 'selectedRepositoryIds', 'selectedPaths', 'repositories', 'sourceFingerprint', 'fingerprint',
  ], [], 'sourceResolution.provenance');
  const snapshot = parseSnapshotOutcome(provenanceRecord.snapshot);
  if (!Array.isArray(provenanceRecord.repositories)) throw new Error('sourceResolution.provenance.repositories: invalid');
  const repositories = provenanceRecord.repositories.map((item, index) => {
    const field = `sourceResolution.provenance.repositories[${index}]`;
    const parsed = recordValue(item, [
      'repositoryId', 'sourceRoot', 'currentHead', 'comparisonBase', 'comparisonTarget', 'mergeBase',
      'snapshotFingerprint', 'changedPaths', 'omissions', 'error',
    ], [], field);
    if (parsed.error !== null) throw new Error(`${field}.error: must be null`);
    return {
      repositoryId: stringValue(parsed.repositoryId, `${field}.repositoryId`),
      sourceRoot: stringValue(parsed.sourceRoot, `${field}.sourceRoot`),
      currentHead: gitOid(parsed.currentHead, `${field}.currentHead`),
      comparisonBase: parsed.comparisonBase === null ? null : gitOid(parsed.comparisonBase, `${field}.comparisonBase`),
      comparisonTarget: gitOid(parsed.comparisonTarget, `${field}.comparisonTarget`),
      mergeBase: parsed.mergeBase === null ? null : gitOid(parsed.mergeBase, `${field}.mergeBase`),
      snapshotFingerprint: sha(parsed.snapshotFingerprint, 64, `${field}.snapshotFingerprint`),
      changedPaths: parseChangedPaths(parsed.changedPaths, `${field}.changedPaths`),
      omissions: parseOmissions(parsed.omissions, `${field}.omissions`),
      error: null,
    };
  });
  const result: ReviewSourceResolutionCore = {
    schema: 'hive-review-source-resolution/v1',
    kind: record.kind as ReviewResolutionKind,
    descriptor,
    provider,
    candidateShas,
    snapshotInput,
    provenance: {
      snapshot,
      manifestRepositoryIds: canonicalStringArray(provenanceRecord.manifestRepositoryIds, 'sourceResolution.provenance.manifestRepositoryIds'),
      selectedRepositoryIds: canonicalStringArray(provenanceRecord.selectedRepositoryIds, 'sourceResolution.provenance.selectedRepositoryIds'),
      selectedPaths: canonicalStringArray(provenanceRecord.selectedPaths, 'sourceResolution.provenance.selectedPaths'),
      repositories,
      sourceFingerprint: sha(provenanceRecord.sourceFingerprint, 64, 'sourceResolution.provenance.sourceFingerprint'),
      fingerprint: sha(provenanceRecord.fingerprint, 64, 'sourceResolution.provenance.fingerprint'),
    },
  };
  const repositoryIds = repositories.map(({ repositoryId }) => repositoryId);
  if (!isDeepEqual(repositoryIds, sortedUniqueCodePoints(repositoryIds))) {
    throw new Error('sourceResolution.provenance.repositories: must be sorted and unique by Unicode code point');
  }
  if (!isDeepEqual(result.provenance.selectedRepositoryIds, repositoryIds)) {
    throw new Error('sourceResolution.provenance.repositories: inconsistent');
  }
  if (!isDeepEqual(result.provenance.selectedPaths, result.snapshotInput.paths ?? [])) {
    throw new Error('sourceResolution.provenance.selectedPaths: inconsistent');
  }
  if (result.kind === 'explicit-local' && (result.descriptor !== null || result.provider.kind !== 'not-requested' || result.candidateShas !== null || result.provenance.snapshot.outcome !== 'resolved')) {
    throw new Error('sourceResolution: inconsistent explicit-local state');
  }
  if (result.kind === 'provider-verified' && (result.descriptor === null || result.provider.kind !== 'resolved' || result.provenance.snapshot.outcome !== 'resolved')) {
    throw new Error('sourceResolution: inconsistent provider-verified state');
  }
  if (result.kind === 'provider-local-fallback' && (result.descriptor === null || result.provider.kind === 'not-requested' || result.provenance.snapshot.outcome !== 'fallback')) {
    throw new Error('sourceResolution: inconsistent provider fallback state');
  }
  if (
    result.kind === 'provider-local-fallback'
    && (
      result.snapshotInput.range !== undefined
      || result.snapshotInput.baseRef !== undefined
      || result.snapshotInput.targetRef !== undefined
    )
  ) {
    throw new Error('sourceResolution: provider fallback must use the current checkout');
  }
  if (
    result.snapshotInput.range === undefined
    && result.snapshotInput.targetRef === undefined
    && result.provenance.repositories.some((repository) => repository.comparisonTarget !== repository.currentHead)
  ) {
    throw new Error('sourceResolution: current-checkout comparison target is inconsistent');
  }
  if (result.provider.kind === 'resolved') {
    const { baseSha, headSha } = result.provider;
    if (!isDeepEqual(result.candidateShas, { baseSha, headSha })) {
      throw new Error('sourceResolution.candidateShas: inconsistent');
    }
    if (result.kind === 'provider-verified' && (
      result.snapshotInput.baseRef !== baseSha
      || result.snapshotInput.targetRef !== headSha
      || result.provenance.repositories.some((repository) => repository.comparisonBase !== baseSha)
      || result.provenance.repositories.some((repository) => repository.comparisonTarget !== headSha)
    )) throw new Error('sourceResolution: provider OIDs do not match resolved snapshot');
  }
  if (result.provenance.snapshot.outcome === 'fallback' && result.provenance.snapshot.reason === 'missing-provider-oid') {
    for (const failure of result.provenance.snapshot.failures) {
      if (!result.provenance.selectedRepositoryIds.includes(failure.repositoryId)) {
        throw new Error('sourceResolution.provenance.snapshot.failures.repositoryId: inconsistent');
      }
      const expectedOid = result.provider.kind === 'resolved'
        ? failure.field === 'base' ? result.provider.baseSha : result.provider.headSha
        : undefined;
      if (failure.missingOid !== expectedOid) {
        throw new Error('sourceResolution.provenance.snapshot.failures.missingOid: inconsistent');
      }
    }
  }
  const expectedSourceFingerprint = sourceFingerprint(result.provenance);
  if (result.provenance.sourceFingerprint !== expectedSourceFingerprint) {
    throw new Error('sourceResolution.provenance.sourceFingerprint: fingerprint mismatch');
  }
  const { fingerprint: _fingerprint, ...provenance } = result.provenance;
  const expectedFingerprint = fingerprintReviewSourceResolutionAuthority({ ...result, provenance });
  if (result.provenance.fingerprint !== expectedFingerprint) {
    throw new Error('sourceResolution.provenance.fingerprint: fingerprint mismatch');
  }
  if (record.provenanceEnvelope !== undefined) {
    const provenanceEnvelope = buildReviewProvenanceEnvelope(result);
    if (!isDeepEqual(record.provenanceEnvelope, provenanceEnvelope)) {
      throw new Error('sourceResolution.provenanceEnvelope: inconsistent');
    }
    return { ...result, provenanceEnvelope };
  }
  return result;
}

type ReviewProviderExecutor = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; shell: false },
) => Promise<{ stdout: string | Buffer }>;

type ReviewSourceResolutionDependencies = {
  providerExecutor?: ReviewProviderExecutor;
  resolveRepositories(repositoryIds?: string[]): Promise<SnapshotTopology>;
  snapshotExecutor(topology: SnapshotTopology, input: GitSnapshotInput): Promise<SnapshotSet>;
};

function providerFailureReason(error: unknown): Extract<ReviewProviderOutcome, { kind: 'unavailable' }>['reason'] {
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
  if (failure.code === 'ENOENT') return 'cli-unavailable';
  if (failure.code === 'ETIMEDOUT' || failure.killed === true || failure.signal === 'SIGTERM') return 'timeout';
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || String(failure.message).includes('maxBuffer')) return 'output-truncated';
  return 'auth-network-execution';
}

const defaultProviderExecutor: ReviewProviderExecutor = async (file, args, options) => {
  const result = await execFileAsync(file, args, {
    ...options,
    encoding: 'buffer',
    windowsHide: true,
  });
  return { stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout) };
};

export function parseGitHubPullRequestDescriptor(intent: string): GitHubPullRequestDescriptor | null {
  if (/[\r\n\u0085\u2028\u2029]/u.test(intent)) return null;
  const match = GITHUB_PULL_REQUEST_PATTERN.exec(intent.trim());
  if (!match) return null;
  const repository = match[2]!;
  const number = Number(match[3]);
  if (repository === '.' || repository === '..' || !Number.isSafeInteger(number)) return null;
  return { owner: match[1]!, repository, number };
}

export async function resolveGitHubPullRequest(
  descriptor: GitHubPullRequestDescriptor,
  executor: ReviewProviderExecutor = defaultProviderExecutor,
): Promise<ReviewProviderOutcome> {
  let stdout: string | Buffer;
  try {
    ({ stdout } = await executor('gh', [
      'api',
      '--hostname', 'github.com',
      '--method', 'GET',
      `repos/${descriptor.owner}/${descriptor.repository}/pulls/${descriptor.number}`,
      '--jq', '{baseSha:.base.sha,headSha:.head.sha}',
    ], {
      timeout: PROVIDER_TIMEOUT_MS,
      maxBuffer: PROVIDER_MAX_OUTPUT_BYTES,
      shell: false,
    }));
  } catch (error) {
    return { kind: 'unavailable', reason: providerFailureReason(error) };
  }
  try {
    const value = JSON.parse(Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length !== 2) throw new Error('invalid');
    const { baseSha, headSha } = value as { baseSha?: unknown; headSha?: unknown };
    if (typeof baseSha !== 'string' || typeof headSha !== 'string' || !FULL_OID_PATTERN.test(baseSha) || !FULL_OID_PATTERN.test(headSha)) {
      throw new Error('invalid');
    }
    return { kind: 'resolved', baseSha, headSha };
  } catch {
    return { kind: 'unavailable', reason: 'malformed-response' };
  }
}

export type ReviewProviderFreshness =
  | { outcome: 'not-applicable' }
  | { outcome: 'current'; baseSha: string; headSha: string }
  | { outcome: 'moved'; expectedBaseSha: string; expectedHeadSha: string; baseSha: string; headSha: string }
  | { outcome: 'unavailable'; reason: Extract<ReviewProviderOutcome, { kind: 'unavailable' }>['reason'] };

export async function revalidateReviewProviderHead(
  resolution: ReviewSourceResolution,
  executor: ReviewProviderExecutor = defaultProviderExecutor,
): Promise<ReviewProviderFreshness> {
  if (!resolution.descriptor || resolution.provider.kind !== 'resolved') return { outcome: 'not-applicable' };
  const current = await resolveGitHubPullRequest(resolution.descriptor, executor);
  if (current.kind !== 'resolved') {
    return {
      outcome: 'unavailable',
      reason: current.kind === 'unavailable' ? current.reason : 'malformed-response',
    };
  }
  if (
    current.baseSha !== resolution.provider.baseSha
    || current.headSha !== resolution.provider.headSha
  ) {
    return {
      outcome: 'moved',
      expectedBaseSha: resolution.provider.baseSha,
      expectedHeadSha: resolution.provider.headSha,
      baseSha: current.baseSha,
      headSha: current.headSha,
    };
  }
  return { outcome: 'current', baseSha: current.baseSha, headSha: current.headSha };
}

function normalizedSnapshotInput(input: GitSnapshotInput, snapshots: SnapshotSet): GitSnapshotInput {
  if (snapshots.snapshots.length === 0) throw new Error('Review source resolution captured no repositories.');
  const normalizedInput = normalizeSnapshotInput(input, 'snapshotInput');
  const first = snapshots.snapshots[0]!.snapshot;
  const selectedPaths = normalizePaths(first.scope.paths, 'snapshot.scope.paths');
  for (const { snapshot } of snapshots.snapshots) {
    const scope = snapshot.scope;
    if (
      scope.baseRef !== first.scope.baseRef
      || scope.targetRef !== first.scope.targetRef
      || scope.range !== first.scope.range
      || !isDeepEqual(normalizePaths(scope.paths, 'snapshot.scope.paths'), selectedPaths)
    ) throw new Error('Review source resolution captured inconsistent repository scope.');
  }
  return {
    ...(normalizedInput.baseRef === undefined ? {} : { baseRef: first.scope.baseRef! }),
    ...(normalizedInput.targetRef === undefined ? {} : { targetRef: first.scope.targetRef! }),
    ...(normalizedInput.range === undefined ? {} : { range: first.scope.range! }),
    ...(selectedPaths.length === 0 ? {} : { paths: selectedPaths }),
    ...(normalizedInput.maxFiles === undefined ? {} : { maxFiles: first.limits.maxFiles }),
    ...(normalizedInput.maxPatchBytes === undefined ? {} : { maxPatchBytes: first.limits.maxPatchBytes }),
  };
}

function sourceResolution(
  kind: ReviewResolutionKind,
  descriptor: GitHubPullRequestDescriptor | null,
  provider: ReviewProviderOutcome,
  requestedSnapshotInput: GitSnapshotInput,
  topology: SnapshotTopology,
  snapshots: SnapshotSet,
  snapshotOutcome: SnapshotOutcome,
): ReviewSourceResolution {
  const snapshotInput = normalizedSnapshotInput(requestedSnapshotInput, snapshots);
  const repositories = [...snapshots.snapshots]
    .sort((left, right) => compareUnicodeCodePoints(left.repositoryId, right.repositoryId))
    .map(({ repositoryId, snapshot }) => ({
      repositoryId,
      sourceRoot: snapshot.repository.root,
      currentHead: snapshot.repository.currentHead,
      comparisonBase: snapshot.scope.comparisonBase ?? null,
      comparisonTarget: snapshot.scope.comparisonTarget,
      mergeBase: snapshot.scope.mergeBase ?? null,
      snapshotFingerprint: snapshot.fingerprint,
      changedPaths: {
        comparison: sortedUniqueCodePoints(snapshot.changedPaths.comparison),
        staged: sortedUniqueCodePoints(snapshot.changedPaths.staged),
        unstaged: sortedUniqueCodePoints(snapshot.changedPaths.unstaged),
        untracked: sortedUniqueCodePoints(snapshot.changedPaths.untracked),
      },
      omissions: structuredClone(snapshot.omissions),
      error: null,
    }));
  const selectedRepositoryIds = repositories.map(({ repositoryId }) => repositoryId);
  const topologySelection = sortedUniqueCodePoints(topology.selectedRepositoryIds);
  if (topologySelection.length > 0 && !isDeepEqual(topologySelection, selectedRepositoryIds)) {
    throw new Error('Review source resolution topology does not match captured repositories.');
  }
  const topologyPaths = new Map(topology.repositories.map((repository) => [repository.id, repository.path]));
  for (const repository of repositories) {
    if (topologyPaths.get(repository.repositoryId) !== repository.sourceRoot) {
      throw new Error('Review source resolution topology does not match captured repository roots.');
    }
  }
  const candidateShas = provider.kind === 'resolved'
    ? { baseSha: provider.baseSha, headSha: provider.headSha }
    : null;
  const manifestRepositoryIds = sortedUniqueCodePoints(topology.manifestRepositoryIds);
  const provenance = {
    snapshot: snapshotOutcome,
    manifestRepositoryIds,
    selectedRepositoryIds,
    selectedPaths: snapshotInput.paths ?? [],
    repositories,
    sourceFingerprint: sourceFingerprint({
      manifestRepositoryIds,
      selectedRepositoryIds,
      repositories,
    }),
  };
  const basis = {
    schema: 'hive-review-source-resolution/v1' as const,
    kind,
    descriptor,
    provider,
    candidateShas,
    snapshotInput,
    provenance,
  };
  const finalized = {
    ...basis,
    provenance: {
      ...provenance,
      fingerprint: fingerprintReviewSourceResolutionAuthority(basis),
    },
  };
  return parseReviewSourceResolution({
    ...finalized,
    provenanceEnvelope: buildReviewProvenanceEnvelope(finalized),
  });
}

export async function resolveReviewSource(
  input: {
    descriptor?: GitHubPullRequestDescriptor | null;
    explicitLocal?: GitSnapshotInput;
    repositoryIds?: string[];
    paths?: string[];
    notRequestedReason?: Extract<ReviewProviderOutcome, { kind: 'not-requested' }>['reason'];
    providerOidPolicy?: 'allow-local-fallback' | 'require-exact';
  },
  dependencies: ReviewSourceResolutionDependencies,
): Promise<ReviewSourceResolution> {
  const topology = await dependencies.resolveRepositories(input.repositoryIds);
  const paths = normalizePaths(input.paths, 'paths');
  if (input.explicitLocal !== undefined) {
    const snapshotInput = normalizeSnapshotInput({
      ...input.explicitLocal,
      ...(paths.length > 0 ? { paths } : {}),
    }, 'snapshotInput');
    const snapshots = await dependencies.snapshotExecutor(topology, snapshotInput);
    return sourceResolution(
      'explicit-local',
      null,
      { kind: 'not-requested', reason: input.notRequestedReason ?? (input.descriptor ? 'explicit-selector' : 'no-descriptor') },
      snapshotInput,
      topology,
      snapshots,
      { outcome: 'resolved' },
    );
  }
  if (!input.descriptor) throw new Error('Review source resolution requires a local snapshot scope or validated provider descriptor.');
  const provider = await resolveGitHubPullRequest(input.descriptor, dependencies.providerExecutor);
  if (provider.kind !== 'resolved') {
    const snapshotInput = paths.length > 0 ? { paths } : {};
    const snapshots = await dependencies.snapshotExecutor(topology, snapshotInput);
    return sourceResolution(
      'provider-local-fallback', input.descriptor, provider, snapshotInput, topology, snapshots,
      { outcome: 'fallback', reason: 'provider-unavailable' },
    );
  }
  const providerSnapshotInput = {
    baseRef: provider.baseSha,
    targetRef: provider.headSha,
    ...(paths.length > 0 ? { paths } : {}),
  };
  try {
    const snapshots = await dependencies.snapshotExecutor(topology, providerSnapshotInput);
    return sourceResolution(
      'provider-verified', input.descriptor, provider, providerSnapshotInput, topology, snapshots,
      { outcome: 'resolved' },
    );
  } catch (error) {
    const snapshotFailures = error instanceof ReviewSnapshotSetError
      ? error.failures
      : [{ repositoryId: error instanceof GitSnapshotError ? error.details.repositoryId : undefined, outcome: 'failed' as const, error }];
    const failures: SnapshotFailure[] = [];
    for (const snapshotFailure of snapshotFailures) {
      const failure = snapshotFailure.error;
      if (
        !(failure instanceof GitSnapshotError)
        || failure.code !== 'missing-ref'
        || (failure.details.field !== 'baseRef' && failure.details.field !== 'targetRef')
        || typeof failure.details.ref !== 'string'
        || typeof snapshotFailure.repositoryId !== 'string'
        || failure.details.ref !== (failure.details.field === 'baseRef' ? provider.baseSha : provider.headSha)
      ) throw error;
      failures.push({
        code: 'missing-ref',
        field: failure.details.field === 'baseRef' ? 'base' : 'head',
        missingOid: failure.details.ref,
        repositoryId: snapshotFailure.repositoryId,
      });
    }
    failures.sort((left, right) => compareUnicodeCodePoints(left.repositoryId, right.repositoryId));
    if (input.providerOidPolicy === 'require-exact') {
      throw new ReviewProviderOidUnavailableError(failures);
    }
    const snapshotInput = paths.length > 0 ? { paths } : {};
    const snapshots = await dependencies.snapshotExecutor(topology, snapshotInput);
    return sourceResolution(
      'provider-local-fallback', input.descriptor, provider, snapshotInput, topology, snapshots,
      {
        outcome: 'fallback',
        reason: 'missing-provider-oid',
        failures,
      },
    );
  }
}

export const REVIEW_SOURCE_RESOLUTION_ADAPTERS = {
  'dash-review': (parsed: Pick<ParsedDashReviewArgs, 'githubPullRequest'>): ReviewSourceRequest => ({
    descriptor: parsed.githubPullRequest,
    fixedSnapshotInput: {},
    notRequestedReason: 'no-descriptor',
  }),
  'vulnerability-review': (parsed: ParsedVulnerabilityReviewArgs): ReviewSourceRequest => {
    const selector = parsed.overrides.selector;
    return {
      descriptor: parsed.githubPullRequest ?? null,
      ...(parsed.overrides.repositoryIds ? { repositoryIds: parsed.overrides.repositoryIds } : {}),
      ...(selector ? { fixedSelector: selector } : {}),
      fixedSnapshotInput: {
        ...(selector?.kind === 'range' ? { range: selector.range } : {}),
        ...(selector?.kind === 'base' ? {
          baseRef: selector.baseRef,
          ...(selector.targetRef ? { targetRef: selector.targetRef } : {}),
        } : {}),
        ...(parsed.overrides.paths ? { paths: parsed.overrides.paths } : {}),
      },
      notRequestedReason: selector === undefined ? 'no-descriptor' : 'explicit-selector',
    };
  },
} as const;
