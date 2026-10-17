// Container lifetime guard. Docker's init (tini) is PID 1 and runs this as its only child, as a uid that no
// evaluation process uses, so agent tools cannot signal it. When the guard exits, tini exits, and the kernel kills
// every remaining process in the container's PID namespace. The guard therefore bounds the container's whole lifetime
// without any host process:
//
//   node guard.mjs serve <ceilingSeconds>   container command: exit at the ceiling at the latest
//   node guard.mjs arm <seconds>            one-shot: exit at min(ceiling, now + seconds); a second arm is refused
//   node guard.mjs status                   report the current limits
//   node guard.mjs bind                     supervised exercises only: bind run, host and the host auth-file
//                                           fingerprint (stdin JSON) once; a second bind is refused
//   node guard.mjs compare                  supervised exercises only: compare a fingerprint (stdin JSON) with the
//                                           bound one; only a Boolean leaves the guard
//
// Every command except serve runs through `docker exec --user <guard uid>` and reaches the guard over a unix socket in
// a 0700 directory owned by the guard uid. Each prints one JSON line. Deadlines are kept on the monotonic clock, so a
// wall-clock change can neither extend nor shorten them; wall-clock times are reported only. The bound fingerprint
// stays in this process's memory and is never printed. Node standard library only.
//
// Status and compare replies also carry `clockMs` and `deadlineClockMs`: the guard's monotonic clock now and its
// deadline on that clock. It is the container's shared clock (`sharedClockMs`), which the exercise driver reads too, so
// the host can hand a driver absolute cutoffs on a clock both sides read.
import { lstatSync, mkdirSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUARD_UID = 999;
export const GUARD_EXIT_CODE = 86;
export const GUARD_MAX_CEILING_SECONDS = 3600;
const DIR = '/tmp/ic-guard';
const SOCKET = `${DIR}/guard.sock`;
const MAX_REQUEST_BYTES = 4096;

/**
 * Milliseconds on the kernel's CLOCK_MONOTONIC, the clock every process in the container reads alike: Node's
 * `process.hrtime` is that clock with no per-process origin. It is the same clock Node's `performance.now()` counts
 * from its own process start, so the guard's deadlines keep their suspend behavior. Bun's `process.hrtime` starts at
 * its process start instead, so readers of this clock run on Node; the exercise checks the domain before relying on it.
 */
export function sharedClockMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

const DECIMAL = /^(0|[1-9][0-9]{0,39})$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The auth-file fingerprint in its lossless wire form: BigInt fields as decimal strings. Anything else is refused, so
 * a lossy or partial value can never be bound or compared.
 */
export function parseWireFingerprint(value) {
  if (!value || typeof value !== 'object' || typeof value.exists !== 'boolean') return null;
  if (!value.exists) return Object.keys(value).length === 1 ? { exists: false } : null;
  const { size, mtimeNs, ino, digest } = value;
  if (Object.keys(value).length !== 5 || ![size, mtimeNs, ino].every((v) => typeof v === 'string' && DECIMAL.test(v)) || typeof digest !== 'string' || !HEX64.test(digest)) return null;
  return { exists: true, size, mtimeNs, ino, digest };
}

function sameWire(a, b) {
  if (a.exists !== b.exists) return false;
  return !a.exists || (a.size === b.size && a.mtimeNs === b.mtimeNs && a.ino === b.ino && a.digest === b.digest);
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Guard state, separate from its socket so its rules are testable with injected clocks. `mono` is a monotonic
 * millisecond clock; `wall` is used only to report times.
 */
export class GuardState {
  constructor(ceilingSeconds, { mono, wall }) {
    this.mono = mono;
    this.wall = wall;
    this.startedMono = mono();
    this.startedAt = wall();
    this.ceilingMono = this.startedMono + ceilingSeconds * 1000;
    this.deadlineMono = this.ceilingMono;
    this.armedAt = null;
    this.binding = null;
  }

  /** Wall-clock report of a monotonic instant, anchored at start. */
  at(monoValue) {
    return this.startedAt + (monoValue - this.startedMono);
  }

  remainingMs() {
    return Math.max(0, this.deadlineMono - this.mono());
  }

  status() {
    return {
      startedAt: this.startedAt, ceilingAt: this.at(this.ceilingMono), deadlineAt: this.at(this.deadlineMono), armedAt: this.armedAt,
      remainingMs: this.remainingMs(), ceilingRemainingMs: Math.max(0, this.ceilingMono - this.mono()),
      bound: this.binding !== null, boundRunId: this.binding?.runId ?? null, boundHost: this.binding?.host ?? null,
      ...this.clock(),
    };
  }

  /** The guard's clock now and its deadline on that clock, for a reader of the same clock. */
  clock() {
    return { clockMs: this.mono(), deadlineClockMs: this.deadlineMono };
  }

  /** Arming can only shorten the lifetime: the ceiling set at container start is never extended. */
  arm(seconds) {
    if (!Number.isInteger(seconds) || seconds <= 0) return { ok: false, failure: 'request_invalid' };
    if (this.armedAt !== null) return { ok: false, failure: 'already_armed', ...this.status() };
    const now = this.mono();
    this.armedAt = this.at(now);
    this.deadlineMono = Math.min(this.ceilingMono, now + seconds * 1000);
    return { ok: true, armed: true, ...this.status() };
  }

  /** Binds run, host and the initial fingerprint once, before arming. Binding never changes the deadline. */
  bind(request) {
    const fingerprint = parseWireFingerprint(request?.fingerprint);
    if (!fingerprint || typeof request.runId !== 'string' || !RUN_ID.test(request.runId) || !['v1', 'v2'].includes(request.host)) return { ok: false, failure: 'request_invalid' };
    if (this.binding !== null) return { ok: false, failure: 'already_bound', ...this.status() };
    if (this.armedAt !== null) return { ok: false, failure: 'bind_after_arm', ...this.status() };
    this.binding = { runId: request.runId, host: request.host, fingerprint };
    return { ok: true, ...this.status() };
  }

  /** Only whether the presented fingerprint equals the bound one; a missing binding is a failure, never a match. */
  compare(request) {
    const fingerprint = parseWireFingerprint(request?.fingerprint);
    if (!fingerprint) return { ok: false, failure: 'request_invalid' };
    if (this.binding === null) return { ok: false, failure: 'not_bound' };
    return { ok: true, matches: sameWire(this.binding.fingerprint, fingerprint), remainingMs: this.remainingMs(), ...this.clock() };
  }

  reply(request) {
    if (request?.op === 'status') return { ok: true, armed: this.armedAt !== null, ...this.status() };
    if (request?.op === 'arm') return this.arm(request.seconds);
    if (request?.op === 'bind') return this.bind(request);
    if (request?.op === 'compare') return this.compare(request);
    return { ok: false, failure: 'request_invalid' };
  }
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function serve(ceilingSeconds) {
  if (!Number.isInteger(ceilingSeconds) || ceilingSeconds <= 0 || ceilingSeconds > GUARD_MAX_CEILING_SECONDS) process.exit(2);
  const state = new GuardState(ceilingSeconds, { mono: sharedClockMs, wall: () => Date.now() });
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => process.exit(GUARD_EXIT_CODE), state.remainingMs());
  };
  // The directory must be created by this process and stay private; anything else means another process got there
  // first, and the guard ends the container rather than share its control channel.
  mkdirSync(DIR, { mode: 0o700 });
  const dir = lstatSync(DIR);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700) process.exit(3);
  schedule();
  createServer((socket) => {
    let raw = '';
    socket.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_REQUEST_BYTES) socket.destroy();
    });
    socket.on('end', () => {
      let request = null;
      try { request = JSON.parse(raw); } catch { request = null; }
      raw = '';
      const reply = state.reply(request);
      if (request?.op === 'arm' && reply.ok) schedule();
      socket.end(JSON.stringify(reply));
    });
    socket.on('error', () => {});
  }).listen(SOCKET);
}

function request(body) {
  const socket = connect(SOCKET);
  let raw = '';
  socket.on('data', (chunk) => { raw += chunk; });
  socket.on('end', () => {
    try { emit(JSON.parse(raw)); } catch { emit({ ok: false, failure: 'guard_reply_malformed' }); }
  });
  socket.on('error', () => emit({ ok: false, failure: 'guard_unreachable' }));
  socket.end(JSON.stringify(body));
}

/** Reads one bounded JSON document from stdin for bind and compare; the fingerprint never appears in argv. */
async function stdinJson() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > MAX_REQUEST_BYTES) return null;
  }
  try { return JSON.parse(raw); } catch { return null; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, value] = process.argv.slice(2);
  if (command === 'serve') serve(Number(value));
  else if (command === 'arm') request({ op: 'arm', seconds: Number(value) });
  else if (command === 'status') request({ op: 'status' });
  else if (command === 'bind' || command === 'compare') {
    stdinJson().then((input) => {
      if (!input) emit({ ok: false, failure: 'request_invalid' });
      else request({ op: command, runId: input.runId, host: input.host, fingerprint: input.fingerprint });
    });
  } else emit({ ok: false, failure: 'unknown_command' });
}
