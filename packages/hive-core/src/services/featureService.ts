import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  acquireLockSync,
  assertValidFeatureName,
  FeatureResolutionError,
  getFeaturesPath,
  getNextIndexedFeatureDirectoryName,
  listFeatureDirectories,
  readFeatureMetadata,
  resolveExistingFeaturePath,
  syncDirectory,
  writeAtomicDurable,
  writeJsonAtomicDurable,
} from '../utils/paths.js';
import type { FeatureJson, FeatureStatusType } from '../types.js';

export { FEATURE_NAME_PATTERN, assertValidFeatureName } from '../utils/paths.js';

const FEATURE_FILE = 'feature.json';

/**
 * What a failed feature write left in place of the metadata it attempted. `applied`: this call published it (the
 * create's rename, or the update's completed durable write). `matches`: the update's durable write threw and the
 * stored `feature.json` reads back equal to the attempted metadata, which shows the bytes, not that this call wrote
 * them. `unknown`: the update's durable write threw and the stored metadata could not be read back or differs from
 * the attempted metadata. Differing bytes do not show that nothing was published: the write may have renamed its
 * file into place before failing, and a writer outside the feature lock may have replaced it before the read-back.
 * `applied` says this call published the metadata, not that the stored bytes still equal it.
 */
export type FeaturePublication = 'applied' | 'matches' | 'unknown';

/** The failures behind a `FeatureWriteUncertainError`: the write's own, the lock release after it, or both. */
export type FeatureWriteFailures =
  | { writeFailure: unknown; releaseFailure?: unknown }
  | { writeFailure?: undefined; releaseFailure: unknown };

function describeFailure(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * A feature write that failed after its result may have become visible: flushing a published create, an update's
 * durable write, or releasing the feature lock after either. `writeFailure` and `releaseFailure` keep each error,
 * `cause` is the first present, and `publication` says what is known of the attempted `feature`. Nothing is rolled
 * back, and a write that failed before it was durable may not survive a crash. Read the feature before deciding
 * anything: never repeat a create, and repeat an update only after the read shows it missing. Any other error from
 * `create` or `updateMetadata` published nothing.
 */
export class FeatureWriteUncertainError extends Error {
  readonly writeFailure?: unknown;
  readonly releaseFailure?: unknown;

  constructor(
    readonly operation: 'create' | 'update',
    readonly featureName: string,
    /** The feature directory the write targeted. */
    readonly featurePath: string,
    readonly publication: FeaturePublication,
    /** The metadata the write attempted to publish. */
    readonly feature: FeatureJson,
    failures: FeatureWriteFailures,
  ) {
    const { writeFailure, releaseFailure } = failures;
    const failed = [
      writeFailure !== undefined
        ? `${operation === 'create' ? 'flushing the features directory' : 'the durable metadata write'} failed (${describeFailure(writeFailure)})`
        : undefined,
      releaseFailure !== undefined ? `releasing the feature lock failed (${describeFailure(releaseFailure)})` : undefined,
    ].filter((part) => part !== undefined).join(', and ');
    const crash = writeFailure !== undefined ? ' and may not survive a crash' : '';
    const update = {
      applied: `This call published the new metadata${crash}, but a writer outside the feature lock may have changed it since, so only a fresh read shows the current metadata.`,
      matches: `The stored metadata matches the update${crash}, but this call may not be what wrote it.`,
      unknown: 'The stored metadata could not be read back or differs from the update, so the update may or may not be in place.',
    } satisfies Record<FeaturePublication, string>;
    super(
      operation === 'create'
        ? `Feature '${featureName}' was created at ${featurePath}, but ${failed}. `
          + `The feature exists${crash}; read it before continuing and do not create it again.`
        : `Updating feature '${featureName}' metadata in ${featurePath} failed: ${failed}. ${update[publication]} `
          + 'Read the feature before retrying.',
      { cause: writeFailure !== undefined ? writeFailure : releaseFailure },
    );
    this.name = 'FeatureWriteUncertainError';
    this.writeFailure = writeFailure;
    this.releaseFailure = releaseFailure;
  }
}

/**
 * Release a feature lock after its locked work threw `error`, and throw what the caller must see. A failed release
 * never replaces an uncertain write: it is added to that error. After any other error the work published nothing,
 * so that error is thrown unchanged and the release failure, which changes no feature state, is not reported.
 */
function releaseAfterFailure(release: () => void, error: unknown): never {
  try {
    release();
  } catch (releaseFailure) {
    if (error instanceof FeatureWriteUncertainError) {
      throw new FeatureWriteUncertainError(error.operation, error.featureName, error.featurePath, error.publication, error.feature, {
        writeFailure: error.writeFailure,
        releaseFailure,
      });
    }
  }
  throw error;
}

export class FeatureService {
  constructor(private projectRoot: string) {}

  /**
   * Allocate the next indexed directory and publish it with its metadata in one rename, under the feature
   * namespace lock. A name already used as a logical name or a directory name is refused. A failure before the
   * rename removes the staged directory and publishes nothing; a failure after it, including a failed lock release,
   * throws `FeatureWriteUncertainError` and leaves the published feature in place.
   */
  create(name: string, ticket?: string): FeatureJson {
    assertValidFeatureName(name);
    const featuresPath = getFeaturesPath(this.projectRoot);
    const release = acquireLockSync(featuresPath);
    let created: { feature: FeatureJson; featurePath: string };
    try {
      const existing = listFeatureDirectories(this.projectRoot);
      if (existing.some((entry) => entry.logicalName === name || entry.directoryName === name)) {
        throw new Error(`Feature '${name}' already exists`);
      }

      const directoryName = getNextIndexedFeatureDirectoryName(this.projectRoot, name);
      if (existing.some((entry) => entry.logicalName === directoryName)) {
        throw new Error(`Feature directory '${directoryName}' would collide with an existing feature name`);
      }
      const featurePath = path.join(featuresPath, directoryName);
      if (fs.existsSync(featurePath)) {
        throw new Error(`Feature directory '${directoryName}' already exists`);
      }

      const feature: FeatureJson = {
        name,
        status: 'planning',
        ticket,
        createdAt: new Date().toISOString(),
      };

      fs.mkdirSync(featuresPath, { recursive: true });
      const stagingPath = path.join(featuresPath, `.${directoryName}.creating-${process.pid}-${randomBytes(4).toString('hex')}`);
      fs.mkdirSync(stagingPath);
      try {
        fs.mkdirSync(path.join(stagingPath, 'tasks'));
        writeJsonAtomicDurable(path.join(stagingPath, FEATURE_FILE), feature);
        fs.renameSync(stagingPath, featurePath);
      } catch (error) {
        try {
          fs.rmSync(stagingPath, { recursive: true, force: true });
        } catch {
          // A dot-prefixed staging directory is never listed as a feature; keep the original failure.
        }
        throw error;
      }
      try {
        syncDirectory(featuresPath);
      } catch (writeFailure) {
        throw new FeatureWriteUncertainError('create', name, featurePath, 'applied', feature, { writeFailure });
      }
      created = { feature, featurePath };
    } catch (error) {
      releaseAfterFailure(release, error);
    }
    try {
      release();
    } catch (releaseFailure) {
      throw new FeatureWriteUncertainError('create', name, created.featurePath, 'applied', created.feature, { releaseFailure });
    }
    return created.feature;
  }

  /** Metadata of an existing feature, or null when none matches; unreadable or ambiguous metadata throws. */
  get(name: string): FeatureJson | null {
    assertValidFeatureName(name);
    let featurePath: string;
    try {
      featurePath = resolveExistingFeaturePath(this.projectRoot, name);
    } catch (error) {
      if (error instanceof FeatureResolutionError && error.reason === 'not_found') return null;
      throw error;
    }
    return this.readResolvedMetadata(featurePath, name);
  }

  list(options?: { includeArchived?: boolean }): string[] {
    const featuresPath = getFeaturesPath(this.projectRoot);
    return listFeatureDirectories(this.projectRoot)
      .filter((feature) => {
        if (options?.includeArchived) return true;
        const metadata = readFeatureMetadata(path.join(featuresPath, feature.directoryName));
        return metadata.state !== 'valid' || metadata.feature.status !== 'archived';
      })
      .map((feature) => feature.logicalName)
      .sort((left, right) => left.localeCompare(right));
  }

  /**
   * The locked writer of an existing feature's `feature.json`; plan approval and revocation in `PlanService` record
   * their status changes through it too. The feature is resolved before any lock or write, so an unknown or unreadable feature fails without side effects.
   * Under the `feature.json` lock the stored metadata is re-read, passed to `mutate` (unknown legacy fields
   * included) and durably replaced, so writers that use this method in any process never lose each other's
   * fields. `mutate` may throw to abort without writing; it may not rename the feature or move a completed feature
   * out of `completed`. Once the durable write has started, any failure of it, or a failed lock release after a
   * write, throws `FeatureWriteUncertainError`; recover by reading the feature, not by calling this again with the
   * same `mutate`. Only failures before the write (resolution, lock acquisition, the re-read, `mutate`, and the
   * checks above) guarantee that nothing was published, and those errors are thrown unchanged.
   *
   * Lock order: a caller may hold the plan lock while calling this; never acquire the plan lock inside `mutate`.
   */
  updateMetadata(name: string, mutate: (feature: FeatureJson) => void): FeatureJson {
    assertValidFeatureName(name);
    const featurePath = resolveExistingFeaturePath(this.projectRoot, name);
    const featureJsonPath = path.join(featurePath, FEATURE_FILE);
    const release = acquireLockSync(featureJsonPath);
    let updated: FeatureJson;
    try {
      const current = this.readResolvedMetadata(featurePath, name);
      const next = structuredClone(current);
      mutate(next);
      if (next.name !== current.name) {
        throw new Error(`Feature '${name}' metadata cannot change its name`);
      }
      if (current.status === 'completed' && next.status !== 'completed') {
        throw new Error(`Feature '${name}' is completed and cannot be reopened`);
      }
      // Serialized once, before the durable write: a serialization error publishes nothing, and the read-back below
      // compares against the exact bytes written instead of serializing `next` again.
      const serialized = JSON.stringify(next, null, 2);
      try {
        writeAtomicDurable(featureJsonPath, serialized);
      } catch (writeFailure) {
        // The rename inside the durable write may already have published `serialized`. A read-back shows whether the
        // stored bytes match it, not who wrote them: they also match when the stored metadata already equaled them
        // before this call. Bytes that differ do not show the opposite, because a writer outside this lock may have
        // replaced the published file since.
        let stored: string | undefined;
        try {
          stored = fs.readFileSync(featureJsonPath, 'utf-8');
        } catch {
          stored = undefined;
        }
        const publication = stored === serialized ? 'matches' : 'unknown';
        throw new FeatureWriteUncertainError('update', name, featurePath, publication, next, { writeFailure });
      }
      updated = next;
    } catch (error) {
      releaseAfterFailure(release, error);
    }
    try {
      release();
    } catch (releaseFailure) {
      throw new FeatureWriteUncertainError('update', name, featurePath, 'applied', updated, { releaseFailure });
    }
    return updated;
  }

  updateStatus(name: string, status: FeatureStatusType): FeatureJson {
    return this.updateMetadata(name, (feature) => {
      feature.status = status;
      const now = new Date().toISOString();
      if (status === 'approved' && !feature.approvedAt) feature.approvedAt = now;
      if (status === 'completed' && !feature.completedAt) feature.completedAt = now;
      if (status === 'archived' && !feature.archivedAt) feature.archivedAt = now;
    });
  }

  complete(name: string): FeatureJson {
    return this.updateMetadata(name, (feature) => {
      if (feature.status === 'completed') {
        throw new Error(`Feature '${name}' is already completed`);
      }
      feature.status = 'completed';
      if (!feature.completedAt) feature.completedAt = new Date().toISOString();
    });
  }

  archive(name: string, reason?: string): FeatureJson {
    return this.updateMetadata(name, (feature) => {
      if (feature.status === 'completed') {
        throw new Error(`Feature '${name}' is completed and cannot be archived`);
      }
      feature.status = 'archived';
      if (!feature.archivedAt) feature.archivedAt = new Date().toISOString();
      if (reason) feature.archiveReason = reason;
    });
  }

  setSession(name: string, sessionId: string): void {
    this.updateMetadata(name, (feature) => {
      feature.sessionId = sessionId;
    });
  }

  getSession(name: string): string | undefined {
    return this.get(name)?.sessionId;
  }

  private readResolvedMetadata(featurePath: string, name: string): FeatureJson {
    const metadata = readFeatureMetadata(featurePath);
    if (metadata.state === 'valid') return metadata.feature;
    if (metadata.state === 'missing') {
      throw new FeatureResolutionError('not_found', name, `Feature '${name}' not found`, [path.basename(featurePath)]);
    }
    throw new FeatureResolutionError(
      'unreadable',
      name,
      `Feature '${name}' cannot be resolved: unreadable metadata in '${path.basename(featurePath)}': ${metadata.reason}`,
      [path.basename(featurePath)],
    );
  }
}
