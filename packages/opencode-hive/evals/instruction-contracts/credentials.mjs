// Host-side credential boundary. Reads only the `openai` entry of the host OpenCode auth store, read-only, and keeps
// the access token, expiry and account ID in memory. The refresh token is never retained or transferred. Errors carry
// fixed codes and never credential values. Nothing here writes, refreshes or restores host authentication.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export class CredentialError extends Error {
  constructor(code) {
    super(`credential boundary: ${code}`);
    this.code = code;
  }
}

/** Host OpenCode auth store (v1 layout): $XDG_DATA_HOME/opencode/auth.json or ~/.local/share/opencode/auth.json. */
export function hostAuthPath(env) {
  const data = env.XDG_DATA_HOME || (env.HOME ? join(env.HOME, '.local', 'share') : null);
  if (!data) throw new CredentialError('auth_path_unresolved');
  return join(data, 'opencode', 'auth.json');
}

/**
 * Opaque fingerprint of the host auth file, used only to detect change. The content hash stays in process memory and
 * is never exported; manifests record only whether the fingerprint changed.
 */
export function fingerprintAuthFile(path) {
  let stat;
  try {
    stat = statSync(path, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false };
    throw new CredentialError('auth_unreadable');
  }
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { exists: true, size: stat.size, mtimeNs: stat.mtimeNs, ino: stat.ino, digest };
}

export function sameFingerprint(a, b) {
  if (!a || !b || a.exists !== b.exists) return false;
  if (!a.exists) return true;
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ino === b.ino && a.digest === b.digest;
}

/**
 * Selects the access-only credential. `requiredMs` is the minimum remaining lifetime (case deadline + exact host
 * refresh window + margin). Expired, short-lived or unrecognized credentials stop the run; there is no fallback scope.
 */
export function readAccessOnly(path, { now, requiredMs }) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CredentialError(error && error.code === 'ENOENT' ? 'auth_missing' : 'auth_unreadable');
  }
  return selectAccessOnly(raw, { now, requiredMs });
}

/** The access-only selection rules applied to auth-store text already read. */
export function selectAccessOnly(raw, { now, requiredMs }) {
  let store;
  try {
    store = JSON.parse(raw);
  } catch {
    throw new CredentialError('auth_malformed');
  }
  raw = undefined;
  const entry = store && typeof store === 'object' ? store.openai : undefined;
  store = undefined;
  if (!entry || typeof entry !== 'object') throw new CredentialError('openai_entry_missing');
  if (entry.type !== 'oauth') throw new CredentialError('openai_entry_not_oauth');
  if (typeof entry.access !== 'string' || entry.access.length === 0) throw new CredentialError('access_missing');
  if (!Number.isSafeInteger(entry.expires) || entry.expires < 0) throw new CredentialError('expires_invalid');
  // Both exact hosts store epoch milliseconds; a seconds-scale value would defeat the lifetime check.
  if (entry.expires < 1e12) throw new CredentialError('expires_unit_unrecognized');
  if (entry.accountId !== undefined && typeof entry.accountId !== 'string') throw new CredentialError('account_invalid');
  const remainingMs = entry.expires - now;
  if (remainingMs <= 0) throw new CredentialError('credential_expired');
  if (remainingMs < requiredMs) throw new CredentialError('lifetime_insufficient');
  const credential = { access: entry.access, expires: entry.expires };
  if (entry.accountId) credential.accountId = entry.accountId;
  return { credential, remainingMs };
}

/** Lifetime check before each injection; a long batch can outlive the credential, which stops at a case boundary. */
export function assertLifetime(credential, { now, requiredMs }) {
  const remainingMs = credential.expires - now;
  if (remainingMs < requiredMs) throw new CredentialError(remainingMs <= 0 ? 'credential_expired' : 'lifetime_insufficient');
  return remainingMs;
}

// Bearer-token shapes that must never appear in exported evidence, whether or not they are the injected credential.
const TOKEN_SHAPES = [/eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\./, /\bsk-[A-Za-z0-9_-]{20,}/];

/** Returns a predicate that reports whether text contains the in-memory credential or any token-shaped string. */
export function secretScanner(credential) {
  const needles = [];
  if (credential) {
    needles.push(credential.access);
    if (credential.accountId && credential.accountId.length >= 8) needles.push(credential.accountId);
  }
  return (text) => {
    if (typeof text !== 'string') text = JSON.stringify(text) ?? '';
    return needles.some((needle) => text.includes(needle)) || TOKEN_SHAPES.some((shape) => shape.test(text));
  };
}

// -----------------------------------------------------------------------------------------------------------------
// Supervised exercises. One bounded read of the auth file is fingerprinted, hashed and parsed from the same bytes, so
// the credential a command uses is the one its fingerprint describes. The fingerprint travels only in its lossless wire
// form to the container guard, which keeps it; host records never contain it.

export const AUTH_SNAPSHOT_MAX_BYTES = 1024 * 1024;

/** Lossless wire form of a fingerprint: BigInt fields as decimal strings, never numbers. */
export function fingerprintWire(fingerprint) {
  if (!fingerprint?.exists) return { exists: false };
  return { exists: true, size: String(fingerprint.size), mtimeNs: String(fingerprint.mtimeNs), ino: String(fingerprint.ino), digest: fingerprint.digest };
}

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/**
 * Reads the auth file once through an open descriptor. Descriptor metadata before and after the read, and the path's
 * identity after it, must agree; otherwise the file changed during the read and the snapshot is refused. These are
 * boundary observations, not a claim that a concurrent writer is impossible. `fs` is injectable for tests.
 */
export function snapshotAuthFile(path, { maxBytes = AUTH_SNAPSHOT_MAX_BYTES, fs = { openSync, fstatSync, readSync, closeSync, statSync } } = {}) {
  let fd;
  try {
    fd = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { fingerprint: { exists: false }, bytes: null };
    throw new CredentialError('auth_unreadable');
  }
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new CredentialError('auth_unreadable');
    if (before.size > BigInt(maxBytes)) throw new CredentialError('auth_oversize');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
      if (length > maxBytes) throw new CredentialError('auth_oversize');
    }
    const after = fs.fstatSync(fd, { bigint: true });
    let named;
    try { named = fs.statSync(path, { bigint: true }); } catch { throw new CredentialError('auth_changed_during_read'); }
    if (!sameIdentity(before, after) || !sameIdentity(after, named) || BigInt(length) !== after.size) throw new CredentialError('auth_changed_during_read');
    const bytes = buffer.subarray(0, length);
    const digest = createHash('sha256').update(bytes).digest('hex');
    return { fingerprint: { exists: true, size: after.size, mtimeNs: after.mtimeNs, ino: after.ino, digest }, bytes };
  } finally {
    fs.closeSync(fd);
  }
}

/** Selects the access-only credential from the exact snapshot bytes whose fingerprint was taken. */
export function credentialFromSnapshot(snapshot, { now, requiredMs }) {
  if (!snapshot?.fingerprint?.exists || !snapshot.bytes) throw new CredentialError('auth_missing');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes); } catch { throw new CredentialError('auth_malformed'); }
  return selectAccessOnly(text, { now, requiredMs });
}

/** Exact-length window of the access token checked against evidence, so a clipped or chunked copy is still found. */
export const TOKEN_FRAGMENT_CHARS = 32;

/**
 * The exercise evidence scanner: exact access token and account ID, token shapes, and every contiguous
 * TOKEN_FRAGMENT_CHARS window of the access token (the whole token when shorter). It is defense in depth for truncation
 * and chunk edges, not detection of arbitrary encodings.
 */
export function evidenceScanner(credential) {
  const exact = secretScanner(credential);
  const fragments = new Set();
  const access = credential?.access ?? '';
  if (access.length > 0 && access.length <= TOKEN_FRAGMENT_CHARS) fragments.add(access);
  for (let i = 0; i + TOKEN_FRAGMENT_CHARS <= access.length; i++) fragments.add(access.slice(i, i + TOKEN_FRAGMENT_CHARS));
  const width = Math.min(TOKEN_FRAGMENT_CHARS, access.length);
  return (text) => {
    if (typeof text !== 'string') text = JSON.stringify(text) ?? '';
    if (exact(text)) return true;
    if (width === 0) return false;
    for (let i = 0; i + width <= text.length; i++) if (fragments.has(text.slice(i, i + width))) return true;
    return false;
  };
}

/**
 * Whether a decoded JSON value trips `scan`: its serialization, and every string in it with object keys included.
 * Scanning the decoded strings finds a token whatever escape sequences carried it on the wire.
 */
export function scanValue(scan, value) {
  if (scan(typeof value === 'string' ? value : JSON.stringify(value) ?? '')) return true;
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (scan(current)) return true;
    } else if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
    } else if (current && typeof current === 'object') {
      for (const [key, item] of Object.entries(current)) {
        if (scan(key)) return true;
        pending.push(item);
      }
    }
  }
  return false;
}
