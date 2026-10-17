import * as fs from 'fs';
import * as path from 'path';
import type { WorklogAuthor, WorklogReference, WorklogRef } from 'hive-core';
import { WorklogError, getNativeObservationOwnerLabel } from 'hive-core';

/** Viewer reads ask for core's `WORKLOG_MAX_RESPONSE_BYTES`, so a single large stored entry still fits on its page. */
export const WORKLOG_VIEWER_PAGE_SIZE = 10;

export function formatTimestamp(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso;
}

export function describeAge(iso: string, now: number = Date.now()): string {
  const elapsed = now - Date.parse(iso);
  if (Number.isNaN(elapsed)) return iso;
  if (elapsed < 60_000) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} d ago` : `on ${iso.slice(0, 10)}`;
}

/** Names the log by kind; sessions carry their native host because equal session IDs under two hosts are two logs. */
export function describeLog(ref: WorklogRef): string {
  return ref.kind === 'feature' ? `feature ${ref.featureName}` : `${getNativeObservationOwnerLabel(ref.owner)} session`;
}

export function describeAuthor(author: WorklogAuthor): string {
  return `${author.agent} · ${getNativeObservationOwnerLabel(author.owner)} session ${author.sessionId}`;
}

export interface WorklogFailure {
  reason: string;
  message: string;
  recovery: string;
}

const RECOVERY: Record<string, string> = {
  worklog_corrupt: 'The file is left unchanged. Inspect or repair it outside this viewer, then refresh.',
  unsupported_schema: 'The file was written by a newer Hive. It is left unchanged; update Arkive to read it.',
  worklog_too_large: 'The file is past the 16 MiB storage limit and is left unchanged.',
  unsafe_path: 'A symbolic link or escaping path was found on the storage path. Inspect the path; the viewer does not follow links.',
  feature_not_found: 'No feature with this name exists now. Unpin it, or refresh once the feature is restored.',
  feature_ambiguous: 'More than one feature directory claims this name. Repair the feature metadata, then refresh.',
  feature_unreadable: 'Feature metadata could not be read, so the feature cannot be resolved. Repair it, then refresh.',
  invalid_ref: 'This is not a valid worklog key. Unpin it and open the log again from the list or by key.',
  stale_cursor: 'The records changed while paging. Open the view again to restart from the newest page.',
  invalid_cursor: 'The paging position is no longer valid. Open the view again to restart from the newest page.',
  inventory_too_large: 'There are more than 10,000 worklog files. Investigate the storage directories.',
  io_error: 'A filesystem read failed. Refresh to retry.',
};

export function describeFailure(error: unknown): WorklogFailure {
  if (error instanceof WorklogError) {
    return { reason: error.reason, message: error.message, recovery: RECOVERY[error.reason] ?? 'Refresh to retry.' };
  }
  return { reason: 'unexpected_error', message: error instanceof Error ? error.message : String(error), recovery: 'Refresh to retry.' };
}

export function isWorklogFailure(error: unknown, ...reasons: string[]): boolean {
  return error instanceof WorklogError && reasons.includes(error.reason);
}

export type ReferenceTarget =
  | { kind: 'file'; filePath: string }
  | { kind: 'url'; url: string }
  | { kind: 'blocked'; reason: string };

/**
 * Decides whether a recorded citation may become a link. Project paths must stay inside the project root, name an
 * existing regular file, and cross no symbolic link; URLs must be plain http or https. Anything else stays text.
 */
export function resolveReference(projectRoot: string, reference: WorklogReference): ReferenceTarget {
  if (reference.kind === 'url') {
    let parsed: URL;
    try {
      parsed = new URL(reference.url);
    } catch {
      return { kind: 'blocked', reason: 'not a valid URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { kind: 'blocked', reason: 'only http and https links open' };
    if (parsed.username || parsed.password) return { kind: 'blocked', reason: 'URL carries credentials' };
    return { kind: 'url', url: parsed.href };
  }
  return resolveProjectPath(projectRoot, reference.path);
}

export function resolveProjectPath(projectRoot: string, relativePath: string): Exclude<ReferenceTarget, { kind: 'url' }> {
  if (typeof relativePath !== 'string' || relativePath === '' || relativePath.includes('\\')
    || relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) {
    return { kind: 'blocked', reason: 'not a project-relative path' };
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { kind: 'blocked', reason: 'not a normalized project path' };
  }
  let current = path.resolve(projectRoot);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return { kind: 'blocked', reason: 'not found' };
    }
    if (stat.isSymbolicLink()) return { kind: 'blocked', reason: 'crosses a symbolic link' };
    const last = index === segments.length - 1;
    if (last ? !stat.isFile() : !stat.isDirectory()) return { kind: 'blocked', reason: 'not a file' };
  }
  return { kind: 'file', filePath: current };
}
