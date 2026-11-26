#!/usr/bin/env node
// Host-side helper for OpenCode v2 users. Node standard library only.
//
//   node export-v2-auth.mjs --out <abs file> [--db <abs path to opencode.db>]
//
// OpenCode v2 keeps credentials in the `credential` table of opencode.db, not in the v1 auth.json that credentials.mjs
// reads. This helper opens that database read-only, takes the active `openai` credential the host would use, keeps
// only its access token, expiry and account ID, and writes them as a v1-shaped access-only auth file (mode 0600) for
// `run.mjs --auth-file` or `exercise.mjs --auth-file` / IC_EXERCISE_AUTH_PATH. The refresh token is never copied, and
// stdout carries only a summary without any token. It does not use `opencode auth export`: that command connects to,
// and may start, an OpenCode server, which loads plugins and can refresh credentials.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CredentialError, selectAccessOnly } from './credentials.mjs';

const USAGE = `node export-v2-auth.mjs --out <abs file> [--db <abs path to opencode.db>]

Writes an access-only OpenCode v1-shaped auth file from the active openai credential of an OpenCode v2 database,
read-only. --db defaults to $XDG_DATA_HOME/opencode/opencode.db, else ~/.local/share/opencode/opencode.db. An existing
--out must be a regular file; it is replaced. Prints {"ok":true,"out","expires","hasAccountId"} or {"ok":false,"failure"}.`;

/** The host's v2 database: $XDG_DATA_HOME/opencode/opencode.db or ~/.local/share/opencode/opencode.db. */
function hostDatabasePath(env) {
  const data = env.XDG_DATA_HOME || (env.HOME ? join(env.HOME, '.local', 'share') : null);
  if (!data) throw new CredentialError('db_path_unresolved');
  return join(data, 'opencode', 'opencode.db');
}

/**
 * The active `openai` credential's stored JSON value, in the host's own selection order (the active row, then the
 * newest), from a read-only connection. Null when there is none.
 */
function readActiveOpenAiValue(physicalDbPath) {
  let db;
  try {
    db = new DatabaseSync(physicalDbPath, { readOnly: true });
  } catch {
    throw new CredentialError('db_unreadable');
  }
  try {
    const row = db.prepare("SELECT value FROM credential WHERE integration_id = 'openai' ORDER BY active DESC, time_created DESC, id DESC LIMIT 1").get();
    return row ? row.value : null;
  } catch {
    throw new CredentialError('db_unreadable');
  } finally {
    db.close();
  }
}

/**
 * The access-only auth store for a v2 credential value: `{ openai: { type, access, expires, accountId? } }`. The refresh
 * token and every other field are dropped before validation, and the result passes the same selection rules a run
 * applies (`selectAccessOnly`), with no lifetime required beyond not being expired.
 */
function accessOnlyStore(value, { now }) {
  if (value === null || value === undefined) throw new CredentialError('openai_entry_missing');
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw new CredentialError('auth_malformed'); }
  const entry = { type: parsed?.type, access: parsed?.access, expires: parsed?.expires };
  const accountId = parsed?.metadata?.accountID;
  parsed = undefined;
  if (accountId !== undefined) entry.accountId = accountId;
  const store = { openai: entry };
  const { credential } = selectAccessOnly(JSON.stringify(store), { now, requiredMs: 0 });
  return { openai: { type: 'oauth', ...credential } };
}

/**
 * The database's physical path, resolved once by the OS (`realpath(3)`) so that `..` after a directory symlink is
 * applied to the link's target, as SQLite's VFS does. Both the overlap check and the read-only connection use it.
 */
function physicalDatabasePath(dbPath) {
  try {
    return realpathSync.native(dbPath);
  } catch {
    throw new CredentialError('db_unreadable');
  }
}

/**
 * The resolved path plus, where they resolve, its OS real path and the OS real path of its parent joined with its
 * name. `realpathSync.native` is used throughout: the JS `realpathSync` collapses `..` before following a symlink.
 */
function pathForms(path) {
  const forms = new Set([resolve(path)]);
  try { forms.add(realpathSync.native(path)); } catch { /* not resolvable: the other forms stand */ }
  try { forms.add(join(realpathSync.native(dirname(path)), basename(path))); } catch { /* parent not resolvable */ }
  return forms;
}

/**
 * Refuses an `out` that names the database or one of its SQLite sidecars: replacing it would destroy the source the
 * export reads. SQLite opens `physicalDbPath` and names its sidecars after it, so the suffixes are appended to that
 * path; a sidecar that does not exist yet still has a name. Every form of each candidate is compared with every form
 * of `out`, so a symlinked directory cannot hide the overlap.
 */
function refuseDatabaseOverlap(physicalDbPath, out) {
  const outForms = pathForms(out);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    for (const form of pathForms(`${physicalDbPath}${suffix}`)) {
      if (outForms.has(form)) throw new CredentialError('out_overlaps_db');
    }
  }
}

/** Writes the store to `out` with mode 0600 through a fresh sibling file, never following a link at `out`. */
function writeAccessOnly(out, store) {
  let existing = null;
  try { existing = lstatSync(out); } catch (error) { if (error?.code !== 'ENOENT') throw new CredentialError('out_invalid'); }
  if (existing && !existing.isFile()) throw new CredentialError('out_not_regular');
  const temp = join(dirname(out), `.${randomBytes(8).toString('hex')}.auth-export`);
  let fd;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new CredentialError('out_invalid');
  }
  // Until the rename lands, any failure (write, flush, close or rename) removes the temp file holding the token.
  try {
    try {
      writeFileSync(fd, JSON.stringify(store), { flush: true });
    } finally {
      closeSync(fd);
    }
    renameSync(temp, out);
  } catch {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw new CredentialError('out_write_failed');
  }
}

function exportV2Auth({ dbPath, out, now = Date.now() }) {
  const physicalDbPath = physicalDatabasePath(dbPath);
  refuseDatabaseOverlap(physicalDbPath, out);
  const store = accessOnlyStore(readActiveOpenAiValue(physicalDbPath), { now });
  writeAccessOnly(out, store);
  return { ok: true, out, expires: store.openai.expires, hasAccountId: store.openai.accountId !== undefined };
}

export function main(argv, { env = process.env, stdout = process.stdout } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, options: { out: { type: 'string' }, db: { type: 'string' }, help: { type: 'boolean' } } }));
  } catch {
    stdout.write(JSON.stringify({ ok: false, failure: 'arguments_invalid' }) + '\n');
    return 2;
  }
  if (values.help) {
    stdout.write(USAGE + '\n');
    return 0;
  }
  if (!values.out || !isAbsolute(values.out) || (values.db !== undefined && !isAbsolute(values.db))) {
    stdout.write(JSON.stringify({ ok: false, failure: 'arguments_invalid' }) + '\n');
    return 2;
  }
  try {
    const summary = exportV2Auth({ dbPath: values.db ?? hostDatabasePath(env), out: resolve(values.out) });
    stdout.write(JSON.stringify(summary) + '\n');
    return 0;
  } catch (error) {
    stdout.write(JSON.stringify({ ok: false, failure: error instanceof CredentialError ? error.code : 'unexpected_exception' }) + '\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
