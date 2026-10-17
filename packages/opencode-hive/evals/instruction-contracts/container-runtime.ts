// In-container primitives shared by the fixed-run fixture (fixture.ts) and the supervised exercise driver
// (exercise-driver.ts): the container layout, the local server's credentials, detached processes, and a strict
// bounded client for the host's native API. Runs only inside a disposable container (Node type stripping).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WORK = '/work';
export const PROJ = '/work/proj';
export const HOME = '/work/home';
export const STATE = '/work/state';
export const SERVER_PORT = 4096;
export const MOCK_PORT = 4097;

type Json = any;

/** Basic credentials of the local host server, from the container's per-run password. */
export function authHeader(): string {
  return 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64');
}

/** Starts a detached process in its own session from the project directory, recording its PID beside its log name. */
export function detach(command: string, args: string[], logName: string, env: Json = {}): number {
  mkdirSync(join(WORK, 'logs'), { recursive: true });
  const out = join(WORK, 'logs', logName);
  const child = spawn(command, args, {
    cwd: PROJ, detached: true, env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  writeFileSync(out + '.pid', String(child.pid));
  return child.pid ?? -1;
}

/**
 * What one strict API call observed. `outcome` is 'response' (any HTTP status with a JSON or empty body),
 * 'malformed' (a body that is not JSON), 'oversize' (more than `maxBytes`, not read further), 'timeout' or
 * 'unreachable'. Only a response is evidence; every other outcome is unknown, never empty.
 */
export type ApiResult = { outcome: 'response' | 'malformed' | 'oversize' | 'timeout' | 'unreachable'; status: number | null; body: Json; bytes: number };

export const API_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A timer duration from a remaining budget: whole milliseconds rounded down, so a timer never outlives its budget, and 0
 * for anything under one millisecond or not finite. Node timers reject fractions, and `spawnSync` reads 0 as no limit,
 * so a caller treats 0 as an exhausted budget and starts nothing.
 */
export function wholeMs(ms: number): number {
  return Number.isFinite(ms) && ms >= 1 ? Math.floor(ms) : 0;
}

export async function strictApi(path: string, { method = 'GET', body, timeoutMs, maxBytes = API_MAX_BYTES, fetchImpl = fetch }: { method?: string; body?: Json; timeoutMs: number; maxBytes?: number; fetchImpl?: typeof fetch }): Promise<ApiResult> {
  const wholeTimeout = wholeMs(timeoutMs);
  if (wholeTimeout === 0) return { outcome: 'timeout', status: null, body: null, bytes: 0 };
  let response: Response;
  const signal = AbortSignal.timeout(wholeTimeout);
  try {
    response = await fetchImpl(`http://127.0.0.1:${SERVER_PORT}${path}`, {
      method, signal, headers: { authorization: authHeader(), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    return { outcome: (error as Json)?.name === 'TimeoutError' ? 'timeout' : 'unreachable', status: null, body: null, bytes: 0 };
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return { outcome: 'oversize', status: response.status, body: null, bytes };
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    return { outcome: (error as Json)?.name === 'TimeoutError' ? 'timeout' : 'unreachable', status: response.status, body: null, bytes };
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return { outcome: 'response', status: response.status, body: null, bytes };
  try {
    return { outcome: 'response', status: response.status, body: JSON.parse(text), bytes };
  } catch {
    return { outcome: 'malformed', status: response.status, body: null, bytes };
  }
}

export function succeeded(result: ApiResult): boolean {
  return result.outcome === 'response' && result.status !== null && result.status >= 200 && result.status < 300;
}

/** The `data` member of a v2 envelope, or the body itself on v1; `undefined` when an envelope is expected but absent. */
export function payload(host: string, body: Json): Json {
  if (host === 'v1') return body;
  return body && typeof body === 'object' && !Array.isArray(body) && 'data' in body ? body.data : undefined;
}
