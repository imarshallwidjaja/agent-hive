import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  collectReviewSnapshotSet,
  parseGitHubPullRequestDescriptor,
  parseReviewSourceResolution,
  ReviewSnapshotSetError,
  REVIEW_SOURCE_RESOLUTION_ADAPTERS,
  resolveGitHubPullRequest,
  resolveReviewSource,
} from './review-source-resolution.js';
import { parseDashReviewArgs, parseVulnerabilityReviewArgs } from './commands/renderers.js';
import { GitSnapshotError, inspectGitSnapshot } from './utils/git-snapshot.js';
import type { GitSnapshot, GitSnapshotInput } from './utils/git-snapshot.js';

const descriptor = { owner: 'Example', repository: 'project.js', number: 295 };
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function snapshot(input: GitSnapshotInput, dirty = false): GitSnapshot {
  const local = input.targetRef === undefined && input.range === undefined;
  return {
    repository: { root: '/repo', currentHead: 'c'.repeat(40) },
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
      staged: local && dirty ? ['src/staged.ts'] : [],
      unstaged: local && dirty ? ['src/dirty.ts'] : [],
      untracked: local && dirty ? ['src/new.ts'] : [],
    },
    fingerprint: dirty ? 'e'.repeat(64) : 'f'.repeat(64),
    patch: '',
    omissions: {
      changedPaths: { comparison: 0, staged: 0, unstaged: 0, untracked: 0 },
      patch: { truncated: false, omittedBytes: 0 },
    },
  };
}

function dependencies(options: {
  provider?: () => Promise<{ stdout: string }>;
  snapshot?: (input: GitSnapshotInput) => Promise<GitSnapshot>;
} = {}) {
  const providerCalls: Array<{ file: string; args: string[]; timeout: number; maxBuffer: number; shell: false }> = [];
  const snapshotInputs: GitSnapshotInput[] = [];
  return {
    providerCalls,
    snapshotInputs,
    dependencies: {
      providerExecutor: async (file: string, args: string[], execution: { timeout: number; maxBuffer: number; shell: false }) => {
        providerCalls.push({ file, args, ...execution });
        return options.provider?.() ?? { stdout: JSON.stringify({ baseSha, headSha }) };
      },
      resolveRepositories: async (repositoryIds?: string[]) => ({
        manifestRepositoryIds: ['root'],
        selectedRepositoryIds: repositoryIds ?? ['root'],
        repositories: [{ id: 'root', path: '/repo' }],
      }),
      snapshotExecutor: async (_repositories: unknown, input: GitSnapshotInput) => {
        snapshotInputs.push(structuredClone(input));
        const value = await (options.snapshot?.(input) ?? snapshot(input));
        return {
          fingerprint: value.fingerprint,
          snapshots: [{ repositoryId: 'root', snapshot: value }],
        };
      },
    },
  };
}

describe('shared review source resolution', () => {
  it('extracts only an exact safe GitHub pull-request descriptor', () => {
    expect(parseGitHubPullRequestDescriptor('  https://github.com/Example/project.js/pull/295/  ')).toEqual(descriptor);
    for (const unsafe of [
      'review https://github.com/example/project/pull/295',
      'https://github.com/example/project/pull/295?diff=split',
      'https://github.com/example/project/pull/295\n--target main',
      'https://gitlab.com/example/project/pull/295',
    ]) {
      expect(parseGitHubPullRequestDescriptor(unsafe)).toBeNull();
    }
  });

  it('uses one bounded hostname-pinned argument-vector provider request', async () => {
    const { dependencies: deps, providerCalls } = dependencies();
    expect(await resolveGitHubPullRequest(descriptor, deps.providerExecutor)).toEqual({
      kind: 'resolved',
      baseSha,
      headSha,
    });
    expect(providerCalls).toEqual([{
      file: 'gh',
      args: [
        'api', '--hostname', 'github.com', '--method', 'GET',
        'repos/Example/project.js/pulls/295',
        '--jq', '{baseSha:.base.sha,headSha:.head.sha}',
      ],
      timeout: 5000,
      maxBuffer: 16384,
      shell: false,
    }]);
  });

  it('adapts embedded PR instructions without carrying raw intent into provider authority', () => {
    const rawIntent = 'Review https://github.com/AURIN-OFFICE/data-etl/pull/295 and preserve the NHSD scheduling question.';
    const parsed = parseDashReviewArgs(rawIntent);
    const request = REVIEW_SOURCE_RESOLUTION_ADAPTERS['dash-review'](parsed);

    expect(parsed).toEqual({
      rawIntent,
      githubPullRequest: { owner: 'AURIN-OFFICE', repository: 'data-etl', number: 295 },
      reviewInstructions: 'Review and preserve the NHSD scheduling question.',
      descriptorSource: 'embedded-url',
    });
    expect(request).toEqual({
      descriptor: { owner: 'AURIN-OFFICE', repository: 'data-etl', number: 295 },
      fixedSnapshotInput: {},
      notRequestedReason: 'no-descriptor',
    });
    expect(JSON.stringify(request)).not.toContain(rawIntent);
    expect(JSON.stringify(request)).not.toContain('NHSD scheduling question');
  });

  it.each([
    ['line-start subshell group', 'Review https://github.com/example/project/pull/295\n(gh api /user)'],
    ['line-start brace group', 'Review https://github.com/example/project/pull/295\n{ gh api /user\n}'],
    ['double-quoted long option', 'Review https://github.com/example/project/pull/295 "--target" main'],
    ['single-quoted short option', "Review https://github.com/example/project/pull/295 '-t' main"],
  ])('does not call the provider executor for embedded PR input with %s', async (_case, rawIntent) => {
    const request = REVIEW_SOURCE_RESOLUTION_ADAPTERS['dash-review'](parseDashReviewArgs(rawIntent));
    const { dependencies: deps, providerCalls } = dependencies();

    await resolveReviewSource(request.descriptor
      ? { descriptor: request.descriptor }
      : {
          explicitLocal: request.fixedSnapshotInput,
          notRequestedReason: request.notRequestedReason,
        }, deps);

    expect(providerCalls).toEqual([]);
    expect(request.descriptor).toBeNull();
  });

  it.each([
    ['cli-unavailable', Object.assign(new Error('missing'), { code: 'ENOENT' })],
    ['timeout', Object.assign(new Error('late'), { code: 'ETIMEDOUT' })],
    ['output-truncated', Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })],
    ['auth-network-execution', Object.assign(new Error('token leaked: secret'), { code: 1 })],
  ] as const)('sanitizes provider failure as %s', async (reason, failure) => {
    const { dependencies: deps } = dependencies({ provider: async () => { throw failure; } });
    expect(await resolveGitHubPullRequest(descriptor, deps.providerExecutor)).toEqual({
      kind: 'unavailable',
      reason,
    });
  });

  it.each([
    ['not-json'],
    [JSON.stringify({ baseSha: 'short', headSha })],
    [JSON.stringify({ baseSha, headSha, extra: true })],
  ])('rejects malformed provider output without exposing it: %s', async (stdout) => {
    const { dependencies: deps } = dependencies({ provider: async () => ({ stdout }) });
    expect(await resolveGitHubPullRequest(descriptor, deps.providerExecutor)).toEqual({
      kind: 'unavailable',
      reason: 'malformed-response',
    });
  });

  it('verifies exact provider OIDs when both objects are local', async () => {
    const { dependencies: deps, snapshotInputs } = dependencies();
    const resolution = await resolveReviewSource({ descriptor, paths: ['src'] }, deps);

    expect(snapshotInputs).toEqual([{ baseRef: baseSha, targetRef: headSha, paths: ['src'] }]);
    expect(resolution.kind).toBe('provider-verified');
    expect(resolution.provider).toEqual({ kind: 'resolved', baseSha, headSha });
    expect(resolution.provenance.repositories[0]).toMatchObject({
      repositoryId: 'root',
      comparisonBase: baseSha,
      comparisonTarget: headSha,
      changedPaths: { comparison: ['src/index.ts'], staged: [], unstaged: [], untracked: [] },
    });
    expect(resolution.provenance.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(resolution.provenance.repositories[0]).toMatchObject({
      mergeBase: null,
      omissions: {
        changedPaths: { comparison: 0, staged: 0, unstaged: 0, untracked: 0 },
        patch: { truncated: false, omittedBytes: 0 },
      },
    });
    expect(resolution.provenanceEnvelope).toEqual({
      schema: 'hive-review-provenance/v1',
      scopeState: 'verified PR commits',
      descriptor,
      metadataOutcome: { kind: 'resolved', baseSha, headSha },
      baseSha,
      headSha,
      snapshotAttemptOutcome: { outcome: 'resolved' },
      comparisonTarget: headSha,
      currentHead: 'c'.repeat(40),
      currentHeadMatchesProviderHead: false,
      dirtyFingerprint: null,
      fallbackReason: null,
      snapshotId: resolution.provenance.fingerprint,
      sourceFingerprint: resolution.provenance.sourceFingerprint,
      selectedRepositoryIds: ['root'],
      truncated: false,
      errors: [],
    });
  });

  it('fails explicitly instead of falling back to a stale checkout when a required provider OID is missing', async () => {
    const { dependencies: deps, snapshotInputs } = dependencies({
      snapshot: async (input) => {
        if (input.targetRef) {
          throw new GitSnapshotError('missing-ref', {
            field: 'targetRef',
            ref: headSha,
            repositoryId: 'root',
          });
        }
        return snapshot(input, true);
      },
    });

    const error = await resolveReviewSource({
      descriptor,
      providerOidPolicy: 'require-exact',
    }, deps).catch((failure) => failure);

    expect(error).toMatchObject({ code: 'provider-oid-unavailable' });
    expect(snapshotInputs).toEqual([{ baseRef: baseSha, targetRef: headSha }]);
  });

  it('leaves live Git state unchanged when exact provider OID resolution fails', async () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'hive-provider-oid-missing-'));
    const git = (args: string[]) => execFileSync('git', ['-C', repository, ...args], {
      encoding: 'utf8',
      shell: false,
    }).trim();
    try {
      git(['init', '-b', 'main']);
      git(['config', 'user.email', 'snapshot@example.test']);
      git(['config', 'user.name', 'Snapshot Test']);
      writeFileSync(path.join(repository, 'tracked.txt'), 'initial\n');
      git(['add', 'tracked.txt']);
      git(['commit', '-m', 'initial']);
      const localBaseSha = git(['rev-parse', 'HEAD']);
      const missingHeadSha = 'f'.repeat(40);
      writeFileSync(path.join(repository, 'tracked.txt'), 'unstaged\n');
      writeFileSync(path.join(repository, 'staged.txt'), 'staged\n');
      git(['add', 'staged.txt']);
      writeFileSync(path.join(repository, 'untracked.txt'), 'untracked\n');
      const gitDirectory = path.join(repository, '.git');
      mkdirSync(gitDirectory, { recursive: true });
      writeFileSync(path.join(gitDirectory, 'FETCH_HEAD'), 'sentinel-fetch-head\n');
      const before = {
        head: git(['rev-parse', 'HEAD']),
        index: createHash('sha256').update(readFileSync(path.join(gitDirectory, 'index'))).digest('hex'),
        status: git(['status', '--porcelain=v1', '--untracked-files=all']),
        fetchHead: readFileSync(path.join(gitDirectory, 'FETCH_HEAD'), 'utf8'),
      };

      const error = await resolveReviewSource({
        descriptor,
        providerOidPolicy: 'require-exact',
      }, {
        providerExecutor: async () => ({
          stdout: JSON.stringify({ baseSha: localBaseSha, headSha: missingHeadSha }),
        }),
        resolveRepositories: async () => ({
          manifestRepositoryIds: ['root'],
          selectedRepositoryIds: ['root'],
          repositories: [{ id: 'root', path: repository }],
        }),
        snapshotExecutor: async (topology, input) => collectReviewSnapshotSet(
          topology,
          async (entry) => inspectGitSnapshot(entry.path, input),
        ),
      }).catch((failure) => failure);

      expect(error).toMatchObject({
        code: 'provider-oid-unavailable',
        failures: [{ field: 'head', missingOid: missingHeadSha, repositoryId: 'root' }],
      });
      expect({
        head: git(['rev-parse', 'HEAD']),
        index: createHash('sha256').update(readFileSync(path.join(gitDirectory, 'index'))).digest('hex'),
        status: git(['status', '--porcelain=v1', '--untracked-files=all']),
        fetchHead: readFileSync(path.join(gitDirectory, 'FETCH_HEAD'), 'utf8'),
      }).toEqual(before);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('keeps the compact provenance complete when optional patch material is truncated', async () => {
    const { dependencies: deps } = dependencies({
      snapshot: async (input) => ({
        ...snapshot(input),
        omissions: {
          changedPaths: { comparison: 3, staged: 0, unstaged: 0, untracked: 0 },
          patch: { truncated: true, omittedBytes: 4096 },
        },
      }),
    });

    const resolution = await resolveReviewSource({ descriptor }, deps);

    expect(resolution.provenanceEnvelope).toMatchObject({
      schema: 'hive-review-provenance/v1',
      snapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      selectedRepositoryIds: ['root'],
      truncated: true,
      errors: [],
    });
  });

  it('falls back once to a dirty-aware local checkout only for one missing provider OID', async () => {
    const { dependencies: deps, snapshotInputs } = dependencies({
      snapshot: async (input) => {
        if (input.targetRef) throw new GitSnapshotError('missing-ref', { field: 'targetRef', ref: headSha, repositoryId: 'root' });
        return snapshot(input, true);
      },
    });
    const resolution = await resolveReviewSource({ descriptor }, deps);

    expect(snapshotInputs).toEqual([{ baseRef: baseSha, targetRef: headSha }, {}]);
    expect(resolution.kind).toBe('provider-local-fallback');
    expect(resolution.provenance.snapshot).toEqual({
      outcome: 'fallback',
      reason: 'missing-provider-oid',
      failures: [{
        code: 'missing-ref',
        field: 'head',
        missingOid: headSha,
        repositoryId: 'root',
      }],
    });
    expect(resolution.provenance.repositories[0]?.changedPaths).toEqual({
      comparison: ['src/index.ts'],
      staged: ['src/staged.ts'],
      unstaged: ['src/dirty.ts'],
      untracked: ['src/new.ts'],
    });
  });

  it('uses one local checkout snapshot when provider metadata is unavailable', async () => {
    const { dependencies: deps, snapshotInputs } = dependencies({
      provider: async () => { throw Object.assign(new Error('no auth'), { code: 1 }); },
    });
    const resolution = await resolveReviewSource({ descriptor }, deps);
    expect(snapshotInputs).toEqual([{}]);
    expect(resolution.kind).toBe('provider-local-fallback');
    expect(resolution.provider).toEqual({ kind: 'unavailable', reason: 'auth-network-execution' });
    expect(resolution.provenance.snapshot).toEqual({ outcome: 'fallback', reason: 'provider-unavailable' });
    expect(resolution.provenanceEnvelope).toMatchObject({
      fallbackReason: 'provider-unavailable',
      errors: ['provider:auth-network-execution'],
    });
  });

  it.each([
    new GitSnapshotError('missing-ref', { field: 'baseRef', ref: '9'.repeat(40) }),
    new GitSnapshotError('merge-base-unavailable'),
    new GitSnapshotError('output-truncated'),
  ])('does not fallback for non-candidate or non-missing-ref snapshot errors', async (failure) => {
    const { dependencies: deps, snapshotInputs } = dependencies({ snapshot: async () => { throw failure; } });
    await expect(resolveReviewSource({ descriptor }, deps)).rejects.toBe(failure);
    expect(snapshotInputs).toHaveLength(1);
  });

  it.each([
    ['eligible-first', ['api', 'web']],
    ['strict-first', ['web', 'api']],
  ] as const)('collects mixed composite failures canonically when %s completes', async (_label, completionOrder) => {
    const gates = {
      api: deferred<void>(),
      web: deferred<void>(),
    };
    const collection = collectReviewSnapshotSet({
      manifestRepositoryIds: ['api', 'web'],
      selectedRepositoryIds: ['api', 'web'],
      repositories: [{ id: 'web', path: '/repo/web' }, { id: 'api', path: '/repo/api' }],
    }, async (repository) => {
      await gates[repository.id as keyof typeof gates].promise;
      if (repository.id === 'api') {
        throw new GitSnapshotError('missing-ref', { field: 'targetRef', ref: headSha });
      }
      throw new GitSnapshotError('merge-base-unavailable');
    });
    for (const repositoryId of completionOrder) gates[repositoryId].resolve();

    const error = await collection.catch((failure) => failure);
    expect(error).toBeInstanceOf(ReviewSnapshotSetError);
    expect(error.failures.map((failure: { repositoryId: string }) => failure.repositoryId)).toEqual(['api', 'web']);
  });

  it('retains successful composite outcomes when one repository fails', async () => {
    const error = await collectReviewSnapshotSet({
      manifestRepositoryIds: ['api', 'web'],
      selectedRepositoryIds: ['api', 'web'],
      repositories: [{ id: 'web', path: '/repo/web' }, { id: 'api', path: '/repo/api' }],
    }, async (repository) => {
      if (repository.id === 'web') throw new GitSnapshotError('merge-base-unavailable');
      return {
        ...snapshot({}),
        repository: { root: repository.path, currentHead: 'c'.repeat(40) },
      };
    }).catch((failure) => failure);

    expect(error).toBeInstanceOf(ReviewSnapshotSetError);
    expect(error.outcomes.map((outcome: { repositoryId: string; outcome: string }) => ({
      repositoryId: outcome.repositoryId,
      outcome: outcome.outcome,
    }))).toEqual([
      { repositoryId: 'api', outcome: 'resolved' },
      { repositoryId: 'web', outcome: 'failed' },
    ]);
  });

  it.each([
    ['eligible-first', ['api', 'web']],
    ['strict-first', ['web', 'api']],
  ] as const)('denies provider fallback for mixed composite failures when %s completes', async (_label, completionOrder) => {
    const gates = {
      api: deferred<void>(),
      web: deferred<void>(),
    };
    let snapshotExecutions = 0;
    const resolution = resolveReviewSource({ descriptor }, {
      providerExecutor: async () => ({ stdout: JSON.stringify({ baseSha, headSha }) }),
      resolveRepositories: async () => ({
        manifestRepositoryIds: ['api', 'web'],
        selectedRepositoryIds: ['api', 'web'],
        repositories: [{ id: 'web', path: '/repo/web' }, { id: 'api', path: '/repo/api' }],
      }),
      snapshotExecutor: async (topology, input) => {
        snapshotExecutions += 1;
        return collectReviewSnapshotSet(topology, async (repository) => {
          await gates[repository.id as keyof typeof gates].promise;
          if (repository.id === 'api') {
            throw new GitSnapshotError('missing-ref', { field: 'targetRef', ref: headSha });
          }
          throw new GitSnapshotError('merge-base-unavailable');
        });
      },
    });
    for (const repositoryId of completionOrder) gates[repositoryId].resolve();

    const error = await resolution.catch((failure) => failure);
    expect(error).toBeInstanceOf(ReviewSnapshotSetError);
    expect(error.failures.map((failure: { repositoryId: string }) => failure.repositoryId)).toEqual(['api', 'web']);
    expect(snapshotExecutions).toBe(1);
  });

  it('falls back only after all eligible composite failures are aggregated in canonical order', async () => {
    let snapshotExecutions = 0;
    const resolution = await resolveReviewSource({ descriptor }, {
      providerExecutor: async () => ({ stdout: JSON.stringify({ baseSha, headSha }) }),
      resolveRepositories: async () => ({
        manifestRepositoryIds: ['api', 'web'],
        selectedRepositoryIds: ['api', 'web'],
        repositories: [{ id: 'web', path: '/repo/web' }, { id: 'api', path: '/repo/api' }],
      }),
      snapshotExecutor: async (topology, input) => {
        snapshotExecutions += 1;
        return collectReviewSnapshotSet(topology, async (repository) => {
          if (input.targetRef) {
            throw new GitSnapshotError('missing-ref', {
              field: repository.id === 'api' ? 'baseRef' : 'targetRef',
              ref: repository.id === 'api' ? baseSha : headSha,
            });
          }
          return {
            ...snapshot(input, true),
            repository: { root: repository.path, currentHead: 'c'.repeat(40) },
          };
        });
      },
    });

    expect(snapshotExecutions).toBe(2);
    expect(resolution.kind).toBe('provider-local-fallback');
    expect(resolution.provenance.snapshot).toEqual({
      outcome: 'fallback',
      reason: 'missing-provider-oid',
      failures: [
        { code: 'missing-ref', field: 'base', missingOid: baseSha, repositoryId: 'api' },
        { code: 'missing-ref', field: 'head', missingOid: headSha, repositoryId: 'web' },
      ],
    });
  });

  it('keeps explicit local selectors strict and provider-independent', async () => {
    const { dependencies: deps, providerCalls, snapshotInputs } = dependencies({
      snapshot: async () => { throw new GitSnapshotError('missing-ref', { field: 'baseRef', ref: 'missing' }); },
    });
    await expect(resolveReviewSource({
      explicitLocal: { range: 'main...missing' },
      descriptor,
    }, deps)).rejects.toBeInstanceOf(GitSnapshotError);
    expect(providerCalls).toEqual([]);
    expect(snapshotInputs).toEqual([{ range: 'main...missing' }]);
  });

  it('keeps generic and non-GitHub intent local with no provider dependency', async () => {
    const { dependencies: deps, providerCalls } = dependencies();
    const resolution = await resolveReviewSource({
      explicitLocal: {},
      paths: ['src'],
      notRequestedReason: 'no-descriptor',
    }, deps);
    expect(resolution.kind).toBe('explicit-local');
    expect(resolution.provider).toEqual({ kind: 'not-requested', reason: 'no-descriptor' });
    expect(providerCalls).toEqual([]);
  });

  it('suppresses vulnerability provider lookup only for conflicting fixed selectors', () => {
    const intent = 'https://github.com/example/project/pull/295';
    expect(REVIEW_SOURCE_RESOLUTION_ADAPTERS['vulnerability-review'](parseVulnerabilityReviewArgs(
      `${intent} --repo api --path src`,
    )).descriptor).toEqual({
      owner: 'example', repository: 'project', number: 295,
    });
    expect(REVIEW_SOURCE_RESOLUTION_ADAPTERS['vulnerability-review'](parseVulnerabilityReviewArgs(
      `${intent} --base main`,
    )).descriptor).toBeNull();
    expect(REVIEW_SOURCE_RESOLUTION_ADAPTERS['vulnerability-review'](parseVulnerabilityReviewArgs(
      `${intent} --task review`,
    )).descriptor).toBeNull();
  });

  it('never restores provider eligibility after vulnerability parsing normalizes a line separator', () => {
    const url = 'https://github.com/example/project/pull/295';
    for (const separator of ['\r', '\n', '\u0085', '\u2028', '\u2029']) {
      expect(REVIEW_SOURCE_RESOLUTION_ADAPTERS['vulnerability-review'](
        parseVulnerabilityReviewArgs(`${url}${separator}--repo api`),
      ).descriptor).toBeNull();
    }
  });

  it('derives canonical paths and repository ordering from normalized snapshot results', async () => {
    const decomposed = 'e\u0301';
    const composed = '\u00e9';
    const expectedPaths = [decomposed, 'scope-', 'scope.', 'scope_', composed];
    const { dependencies: deps } = dependencies({
      snapshot: async (input) => ({
        ...snapshot(input),
        scope: {
          ...snapshot(input).scope,
          paths: expectedPaths,
        },
      }),
    });
    const resolution = await resolveReviewSource({
      explicitLocal: { paths: ['scope_', composed, 'scope.', decomposed, 'scope-'] },
      notRequestedReason: 'no-descriptor',
    }, deps);

    expect(resolution.provenance.selectedPaths).toEqual(expectedPaths);
    expect(resolution.snapshotInput.paths).toEqual(expectedPaths);
  });

  it('strictly validates snapshot input, snapshot outcome, and canonical authority fingerprints', async () => {
    const { dependencies: deps } = dependencies();
    const resolution = await resolveReviewSource({
      explicitLocal: { paths: ['src'] },
      notRequestedReason: 'explicit-selector',
    }, deps);
    expect(parseReviewSourceResolution(resolution)).toEqual(resolution);

    expect(() => parseReviewSourceResolution({
      ...resolution,
      snapshotInput: { ...resolution.snapshotInput, extra: true },
    })).toThrow('unknown key');
    expect(() => parseReviewSourceResolution({
      ...resolution,
      provenance: {
        ...resolution.provenance,
        snapshot: { ...resolution.provenance.snapshot, extra: true },
      },
    })).toThrow('unknown key');
    expect(() => parseReviewSourceResolution({
      ...resolution,
      provenance: {
        ...resolution.provenance,
        repositories: resolution.provenance.repositories.map((repository) => ({
          ...repository,
          omissions: {
            ...repository.omissions,
            patch: {
              ...repository.omissions.patch,
              omittedBytes: repository.omissions.patch.omittedBytes + 1,
            },
          },
        })),
      },
    })).toThrow('fingerprint');
  });
});
