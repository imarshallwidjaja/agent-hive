import * as path from 'path';
import { getFeaturePath, getHivePath } from './utils/paths.js';

/**
 * The native hosts whose session and background observations Hive stores. Each owner has its own store so that
 * equal session IDs or job aliases from different hosts never address the same record. The set is closed: a
 * caller selects an owner, never a path.
 */
export const NATIVE_OBSERVATION_OWNERS = ['opencode-v1', 'opencode-v2'] as const;
export type NativeObservationOwner = (typeof NATIVE_OBSERVATION_OWNERS)[number];

/** Owner of the long-standing `.hive/sessions.json` and `.hive/background-jobs.json` files. */
export const DEFAULT_NATIVE_OBSERVATION_OWNER: NativeObservationOwner = 'opencode-v1';

const OWNER_LABELS: Record<NativeObservationOwner, string> = {
  'opencode-v1': 'OpenCode v1',
  'opencode-v2': 'OpenCode v2',
};

// The default owner keeps the historical locations; every other owner nests under its own runtime directory.
const OWNER_SUBDIRECTORIES: Record<NativeObservationOwner, readonly string[]> = {
  'opencode-v1': [],
  'opencode-v2': ['runtime', 'opencode-v2'],
};

export function isNativeObservationOwner(value: unknown): value is NativeObservationOwner {
  return typeof value === 'string' && (NATIVE_OBSERVATION_OWNERS as readonly string[]).includes(value);
}

export function assertNativeObservationOwner(value: unknown): NativeObservationOwner {
  if (!isNativeObservationOwner(value)) {
    throw new Error(`Unknown native observation owner: ${JSON.stringify(value)}`);
  }
  return value;
}

export function getNativeObservationOwnerLabel(owner: NativeObservationOwner): string {
  return OWNER_LABELS[assertNativeObservationOwner(owner)];
}

function ownerDirectory(base: string, owner: NativeObservationOwner): string {
  return path.join(base, ...OWNER_SUBDIRECTORIES[assertNativeObservationOwner(owner)]);
}

/** Canonical session index: global truth for routes, constraints and child snapshots. */
export function getNativeSessionsPath(projectRoot: string, owner: NativeObservationOwner): string {
  return path.join(ownerDirectory(getHivePath(projectRoot), owner), 'sessions.json');
}

/** Feature-local navigation projection. It never replaces the canonical index and resolves the feature directory through `getFeaturePath`. */
export function getNativeFeatureSessionsPath(projectRoot: string, featureName: string, owner: NativeObservationOwner): string {
  return path.join(ownerDirectory(getFeaturePath(projectRoot, featureName), owner), 'sessions.json');
}

export function getNativeBackgroundJobsPath(projectRoot: string, owner: NativeObservationOwner): string {
  return path.join(ownerDirectory(getHivePath(projectRoot), owner), 'background-jobs.json');
}
