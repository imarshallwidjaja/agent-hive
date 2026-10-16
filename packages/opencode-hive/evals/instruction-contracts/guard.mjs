// Container lifetime guard. Docker's init (tini) is PID 1 and runs this as its only child, as a uid that no
// evaluation process uses, so agent tools cannot signal it. When the guard exits, tini exits, and the kernel kills
// every remaining process in the container's PID namespace. The guard therefore bounds the container's whole lifetime
// without any host process:
//
//   node guard.mjs serve <ceilingSeconds>   container command: exit at the ceiling at the latest
//   node guard.mjs arm <seconds>            one-shot: exit at min(ceiling, now + seconds); a second arm is refused
//   node guard.mjs status                   report the current limits
//
// arm and status run through `docker exec --user <guard uid>`; they reach the guard over a unix socket in a 0700
// directory owned by the guard uid. Each prints one JSON line. Node standard library only.
import { lstatSync, mkdirSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUARD_UID = 999;
export const GUARD_EXIT_CODE = 86;
export const GUARD_MAX_CEILING_SECONDS = 3600;
const DIR = '/tmp/ic-guard';
const SOCKET = `${DIR}/guard.sock`;

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function serve(ceilingSeconds) {
  if (!Number.isInteger(ceilingSeconds) || ceilingSeconds <= 0 || ceilingSeconds > GUARD_MAX_CEILING_SECONDS) process.exit(2);
  const startedAt = Date.now();
  const ceilingAt = startedAt + ceilingSeconds * 1000;
  let deadlineAt = ceilingAt;
  let armedAt = null;
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => process.exit(GUARD_EXIT_CODE), Math.max(0, deadlineAt - Date.now()));
  };
  // The directory must be created by this process and stay private; anything else means another process got there
  // first, and the guard ends the container rather than share its control channel.
  mkdirSync(DIR, { mode: 0o700 });
  const dir = lstatSync(DIR);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700) process.exit(3);
  schedule();
  const state = () => ({ startedAt, ceilingAt, deadlineAt, armedAt, remainingMs: Math.max(0, deadlineAt - Date.now()) });
  createServer((socket) => {
    let raw = '';
    socket.on('data', (chunk) => { raw += chunk; });
    socket.on('end', () => {
      let request = null;
      try { request = JSON.parse(raw); } catch { request = null; }
      let reply;
      if (request?.op === 'status') reply = { ok: true, armed: armedAt !== null, ...state() };
      else if (request?.op === 'arm' && Number.isInteger(request.seconds) && request.seconds > 0) {
        if (armedAt !== null) reply = { ok: false, failure: 'already_armed', ...state() };
        else {
          armedAt = Date.now();
          // Arming can only shorten the lifetime: the ceiling set at container start is never extended.
          deadlineAt = Math.min(ceilingAt, armedAt + request.seconds * 1000);
          schedule();
          reply = { ok: true, armed: true, ...state() };
        }
      } else reply = { ok: false, failure: 'request_invalid' };
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, value] = process.argv.slice(2);
  if (command === 'serve') serve(Number(value));
  else if (command === 'arm') request({ op: 'arm', seconds: Number(value) });
  else if (command === 'status') request({ op: 'status' });
  else emit({ ok: false, failure: 'unknown_command' });
}
