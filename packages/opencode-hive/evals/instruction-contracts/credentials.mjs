// Host-side credential boundary. Reads only the `openai` entry of the host OpenCode auth store, read-only, and keeps
// the access token, expiry and account ID in memory. The refresh token is never retained or transferred. Errors carry
// fixed codes and never credential values. Nothing here writes, refreshes or restores host authentication.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
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
