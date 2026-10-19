// In-container driver for supervised exercises. Runs only inside an exercise container (Node type stripping), always
// through `docker exec -i` from exercise.mjs. Every command reads one JSON document from stdin and prints exactly one
// JSON line. Failures are fixed codes; no exception text, stack, native error string or subprocess output is printed.
//
// It owns supervised control and evidence policy: the native session tree and its quiescence, pending questions and
// permissions with their exact IDs, one validated submission per call, exact-ID resolution of an unknown submission,
// and bounded export. Everything it prints that is derived from the container passes the evidence scanner, after the
// container's stored credential has been compared with the expectation the host sent on stdin.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { evidenceScanner, scanValue } from './credentials.mjs';
import { sharedClockMs } from './guard.mjs';
import { REFRESH_SENTINEL, exerciseHiveConfig, exerciseHostConfig, exerciseRoutes, hostSpec, nativeStorePath, serveArgs } from './hosts.mjs';
import {
  HOME, MOCK_PORT, PROJ, SERVER_PORT, STATE, WORK, detach, payload, strictApi, succeeded, wholeMs,
  type ApiResult,
} from './container-runtime.ts';
import { CORE_BUNDLE, planReadDifferences, readPlan } from './plan-reader.ts';

type Json = any;

const HARNESS = dirname(new URL(import.meta.url).pathname);
const V1_AUTH_FILE = join(WORK, 'xdg', 'data', 'opencode', 'auth.json');

/** The native API client and the shared clock. Tests substitute both; a live driver always uses these. */
export type DriverDeps = { api: typeof strictApi; clock: () => number };
const LIVE: DriverDeps = { api: strictApi, clock: sharedClockMs };

// Inspection maxima. A request may ask for less; more needs a tooling change.
export const LIMITS = Object.freeze({
  messagesPerPage: 100, pagesPerSession: 10, sessions: 32, toolRecords: 2000, turnChars: 16 * 1024,
  artifacts: 32, artifactBytes: 64 * 1024, diffBytes: 256 * 1024, exportBytes: 2 * 1024 * 1024,
});

function emit(value: Json): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

class DriverFailure extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function fail(code: string): never {
  throw new DriverFailure(code);
}

/**
 * The host's cutoffs on the container's shared clock (`sharedClockMs`, the clock the guard keeps its deadline on):
 * `commandEndClock`, when the host's command budget ends, and for an effect `actionEndClock`, the guard deadline less
 * the action's reserve. Both are absolute instants, so a `docker exec` that starts late gets no fresh budget. A missing
 * or malformed cutoff has already passed. The wall clock is never consulted.
 */
function cutoffs(input: Json): { commandEnd: number; actionEnd: number } {
  const value = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : -Infinity);
  return { commandEnd: value(input.commandEndClock), actionEnd: value(input.actionEndClock) };
}

/** Remaining milliseconds of the host's command budget on the shared clock, never a fresh timeout per step. */
export function budget(input: Json, clock: () => number = sharedClockMs): () => number {
  const { commandEnd } = cutoffs(input);
  return () => Math.max(0, commandEnd - clock());
}

/**
 * Sends one native effect if both cutoffs are still ahead, read on the shared clock at the moment of sending. The
 * request starts in the same synchronous step as the check, with no await between them. Returns null, having sent
 * nothing, when either cutoff has passed. A request that answers only when a whole turn ends (a v1 command) may wait
 * until the command cutoff and be ended earlier through `abort`; every other request keeps the per-call bound.
 */
function sendEffect(input: Json, request: { method: string; path: string; body?: Json }, deps: DriverDeps, { abort }: { abort?: AbortSignal } = {}): Promise<ApiResult> | null {
  const { commandEnd, actionEnd } = cutoffs(input);
  const now = deps.clock();
  if (!(now < commandEnd && now < actionEnd)) return null;
  if (abort) return deps.api(request.path, { method: request.method, body: request.body, timeoutMs: commandEnd - now, abort });
  return call(request, () => commandEnd - now, undefined, deps.api);
}

// -----------------------------------------------------------------------------------------------------------------
// Evidence boundary

type Expectation = { access: string; accountId?: string; expires: number } | null;

/**
 * The container's stored credential compared with the host's expectation: access, account, expiry and the refresh
 * sentinel, read from the native store itself. An agent-writable marker is never consulted.
 */
export async function nativeCredentialMatches(host: string, expected: Expectation, read: { file: () => string | null; credentials: () => Promise<ApiResult> }): Promise<boolean> {
  if (!expected) return false;
  let entries: { access: unknown; refresh: unknown; expires: unknown; account: unknown }[];
  if (host === 'v1') {
    let store: Json;
    try { store = JSON.parse(read.file() ?? ''); } catch { return false; }
    const e = store?.openai;
    entries = e ? [{ access: e.access, refresh: e.refresh, expires: e.expires, account: e.accountId }] : [];
  } else {
    const res = await read.credentials();
    const list = succeeded(res) ? payload(host, res.body) : undefined;
    if (!Array.isArray(list)) return false;
    entries = list.filter((c: Json) => c?.integrationID === 'openai').map((c: Json) => ({ access: c?.value?.access, refresh: c?.value?.refresh, expires: c?.value?.expires, account: c?.value?.metadata?.accountID }));
  }
  if (entries.length !== 1) return false;
  const [e] = entries;
  return e.access === expected.access && e.refresh === REFRESH_SENTINEL && e.expires === expected.expires && (e.account ?? undefined) === (expected.accountId ?? undefined);
}

function nativeReaders(remaining: () => number) {
  return {
    file: () => { try { return readFileSync(V1_AUTH_FILE, 'utf8'); } catch { return null; } },
    credentials: () => strictApi('/api/credential', { timeoutMs: Math.min(10_000, remaining()) }),
  };
}

/**
 * Releases a reply. A credential-bearing container releases nothing without a scanner, and nothing after its native
 * credential stopped matching the expectation. Raw texts were already scanned when collected; the final serialized
 * reply is scanned here, and the host scans it again.
 */
async function release(input: Json, value: Json, remaining: () => number): Promise<Json> {
  const scan = scannerFor(input);
  if (input.trusted) {
    if (!(await nativeCredentialMatches(input.host, input.expected, nativeReaders(remaining)))) return { ok: false, failure: 'native_auth_changed' };
  }
  const text = JSON.stringify(value);
  if (text.length > LIMITS.exportBytes) return { ok: false, failure: 'export_oversize' };
  if (scanValue(scan, value)) return { ok: false, failure: 'evidence_contaminated' };
  return value;
}

function scannerFor(input: Json): (text: string) => boolean {
  if (input.trusted && !input.expected) fail('scanner_unavailable');
  return evidenceScanner(input.trusted ? input.expected : null);
}

/** Text that may leave the container: scanned whole before clipping, then clipped with its original size stated. */
function bounded(text: unknown, cap: number, scan: (t: string) => boolean): { text: string; chars: number; clipped: boolean } {
  const raw = typeof text === 'string' ? text : '';
  if (scan(raw)) fail('evidence_contaminated');
  return { text: raw.slice(0, cap), chars: raw.length, clipped: raw.length > cap };
}

// -----------------------------------------------------------------------------------------------------------------
// Native API access

async function call(request: { method: string; path: string; body?: Json }, remaining: () => number, maxBytes?: number, api: typeof strictApi = strictApi): Promise<ApiResult> {
  return api(request.path, { method: request.method, body: request.body, timeoutMs: Math.min(20_000, remaining()), maxBytes });
}

/** A list response, or null when the read did not return one (unknown, never empty). */
async function list(host: string, request: { method: string; path: string }, remaining: () => number): Promise<Json[] | null> {
  const res = await call(request, remaining);
  if (!succeeded(res)) return null;
  const items = payload(host, res.body);
  return Array.isArray(items) && items.every((x) => x && typeof x === 'object') ? items : null;
}

const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;
const NATIVE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@+/-]{0,199}$/;
const word = (value: unknown): string | null => (typeof value === 'string' && NAME.test(value) ? value : null);

export type Tree = { sessions: { id: string; parentId: string | null; agent: string | null }[]; complete: boolean; failure: string | null };

/**
 * The primary and every descendant, from native parent links only. A failed or malformed page, a child whose parent
 * link does not name its parent, or more sessions than the cap make the tree incomplete; an incomplete tree is never
 * read as idle or empty.
 */
export async function sessionTree(host: string, rootId: string, get: (request: Json) => Promise<ApiResult>, routes = exerciseRoutes(host, PROJ)): Promise<Tree> {
  const root = await get(routes.session(rootId));
  const info = succeeded(root) ? payload(host, root.body) : undefined;
  if (!info || info.id !== rootId) return { sessions: [], complete: false, failure: 'root_unreadable' };
  const sessions = [{ id: rootId, parentId: null, agent: word(info.agent) }];
  const queue = [rootId];
  while (queue.length) {
    const parent = queue.shift()!;
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= LIMITS.pagesPerSession) return { sessions, complete: false, failure: 'children_page_cap' };
      const res = await get(host === 'v1' ? routes.children(parent) : routes.children(parent, cursor));
      const items = succeeded(res) ? payload(host, res.body) : undefined;
      if (!Array.isArray(items)) return { sessions, complete: false, failure: 'children_unreadable' };
      for (const child of items) {
        if (!child || typeof child.id !== 'string' || !SESSION_ID.test(child.id)) return { sessions, complete: false, failure: 'children_malformed' };
        if ((child.parentID ?? null) !== parent) return { sessions, complete: false, failure: 'parent_link_unproven' };
        if (sessions.some((s) => s.id === child.id)) continue;
        if (sessions.length >= LIMITS.sessions) return { sessions, complete: false, failure: 'session_cap' };
        sessions.push({ id: child.id, parentId: parent, agent: word(child.agent) });
        queue.push(child.id);
      }
      const next = host === 'v1' ? undefined : res.body?.cursor?.next;
      if (next !== undefined && next !== null && typeof next !== 'string') return { sessions, complete: false, failure: 'children_cursor_malformed' };
      if (!next) break;
      cursor = next;
    }
  }
  return { sessions, complete: true, failure: null };
}

export type Message = { id: string; role: string; agent: string | null; model: Json; error: string | null; text: string; tools: Json[] };

/** One native message in a host-neutral shape. Tool outputs stay raw here and are reduced before export. */
export function normalizeMessage(host: string, m: Json): Message | null {
  if (host === 'v1') {
    const info = m?.info;
    if (!info || typeof info.id !== 'string' || !NATIVE_ID.test(info.id)) return null;
    const parts = Array.isArray(m.parts) ? m.parts : [];
    return {
      id: info.id, role: word(info.role) ?? 'other', agent: word(info.agent ?? info.mode),
      model: info.role === 'assistant' ? { providerID: word(info.providerID), modelID: word(info.modelID), variant: word(info.variant) } : null,
      error: info.error ? 'message_error' : null,
      text: parts.filter((p: Json) => p?.type === 'text').map((p: Json) => p.text ?? '').join(''),
      tools: parts.filter((p: Json) => p?.type === 'tool').map((p: Json) => ({ id: p.callID ?? p.id ?? null, name: p.tool, status: p.state?.status ?? null, input: p.state?.input, output: p.state?.output ?? p.state?.error, metadata: p.state?.metadata ?? null })),
    };
  }
  if (!m || typeof m.id !== 'string' || !NATIVE_ID.test(m.id)) return null;
  const content = Array.isArray(m.content) ? m.content : [];
  return {
    id: m.id, role: m.type === 'assistant' ? 'assistant' : word(m.type) ?? 'other', agent: word(m.agent),
    model: m.type === 'assistant' ? { providerID: word(m.model?.providerID), modelID: word(m.model?.id), variant: word(m.model?.variant) } : null,
    error: m.error ? 'message_error' : null,
    text: m.type === 'user' && typeof m.text === 'string' ? m.text : content.filter((p: Json) => p?.type === 'text').map((p: Json) => p.text ?? '').join(''),
    tools: content.filter((p: Json) => p?.type === 'tool').map((p: Json) => ({
      id: p.callID ?? p.id ?? null, name: p.name, status: p.state?.status ?? null, input: p.state?.input,
      output: p.state?.output ?? (Array.isArray(p.state?.content) ? p.state.content.map((c: Json) => c?.text ?? '').join('') : p.state?.error), metadata: p.state?.metadata ?? null,
    })),
  };
}

export type History = { messages: Message[]; complete: boolean; failure: string | null };

/** A session's messages in order, within the page caps; a failed, oversize or malformed page ends the read as incomplete. */
export async function readHistory(host: string, sessionId: string, get: (request: Json) => Promise<ApiResult>, { limit = LIMITS.messagesPerPage, pages = LIMITS.pagesPerSession } = {}, routes = exerciseRoutes(host, PROJ)): Promise<History> {
  const out: Message[] = [];
  if (host === 'v1') {
    // v1 pages backwards from the newest message with `before`.
    let before: string | undefined;
    for (let page = 0; page < pages; page++) {
      const res = await get(routes.messages(sessionId, { limit, before }));
      if (!succeeded(res)) return { messages: out, complete: false, failure: res.outcome === 'oversize' ? 'history_oversize' : 'history_unreadable' };
      if (!Array.isArray(res.body)) return { messages: out, complete: false, failure: 'history_malformed' };
      const normalized = res.body.map((m: Json) => normalizeMessage(host, m));
      if (normalized.some((m: Message | null) => m === null)) return { messages: out, complete: false, failure: 'history_malformed' };
      out.unshift(...(normalized as Message[]).filter((m) => !out.some((o) => o.id === m.id)));
      if (res.body.length < limit) return { messages: out, complete: true, failure: null };
      before = (normalized[0] as Message).id;
    }
    return { messages: out, complete: false, failure: null };
  }
  let cursor: string | undefined;
  for (let page = 0; page < pages; page++) {
    const res = await get(routes.messages(sessionId, { limit, cursor }));
    if (!succeeded(res)) return { messages: out, complete: false, failure: res.outcome === 'oversize' ? 'history_oversize' : 'history_unreadable' };
    const items = payload(host, res.body);
    const next = res.body?.cursor?.next;
    if (!Array.isArray(items) || (next !== undefined && next !== null && typeof next !== 'string')) return { messages: out, complete: false, failure: 'history_malformed' };
    const normalized = items.map((m: Json) => normalizeMessage(host, m));
    if (normalized.some((m: Message | null) => m === null)) return { messages: out, complete: false, failure: 'history_malformed' };
    out.push(...(normalized as Message[]));
    if (!next) return { messages: out, complete: true, failure: null };
    cursor = next;
  }
  return { messages: out, complete: false, failure: null };
}

export type Pending = { kind: 'question' | 'permission'; id: string; sessionId: string; toolCallId: string | null; outsideTree?: true; questions?: Json[]; permission?: Json };

/**
 * Pending questions (v1 questions, v2 forms) and permission requests; null when unknown. v1 lists the whole instance:
 * an entry owned by a session outside the enumerated tree is kept and flagged `outsideTree`, because it may belong to a
 * child created after the enumeration.
 */
export async function pendingInteractions(host: string, tree: Tree, get: (request: Json) => Promise<ApiResult>, routes = exerciseRoutes(host, PROJ)): Promise<Pending[] | null> {
  const ids = new Set(tree.sessions.map((s) => s.id));
  const out: Pending[] = [];
  const read = async (request: Json) => {
    const res = await get(request);
    const items = succeeded(res) ? payload(host, res.body) : undefined;
    return Array.isArray(items) && items.every((x: Json) => x && typeof x.id === 'string' && NATIVE_ID.test(x.id) && typeof x.sessionID === 'string' && SESSION_ID.test(x.sessionID)) ? items : null;
  };
  const callId = (value: unknown): string | null => (typeof value === 'string' && NATIVE_ID.test(value) ? value : null);
  if (host === 'v1') {
    const questions = await read(routes.questions());
    const permissions = await read(routes.permissions());
    if (!questions || !permissions) return null;
    for (const q of questions) {
      if (!ids.has(q.sessionID)) { out.push({ kind: 'question', id: q.id, sessionId: q.sessionID, toolCallId: null, outsideTree: true }); continue; }
      out.push({ kind: 'question', id: q.id, sessionId: q.sessionID, toolCallId: callId(q.tool?.callID), questions: (q.questions ?? []).map((x: Json) => ({ question: x.question, header: x.header ?? null, multiple: x.multiple === true, options: (x.options ?? []).map((o: Json) => o.label), optionDescriptions: (x.options ?? []).map((o: Json) => o.description) })) });
    }
    for (const p of permissions) {
      if (!ids.has(p.sessionID)) { out.push({ kind: 'permission', id: p.id, sessionId: p.sessionID, toolCallId: null, outsideTree: true }); continue; }
      out.push({ kind: 'permission', id: p.id, sessionId: p.sessionID, toolCallId: callId(p.tool?.callID), permission: { action: p.permission ?? null, resources: p.patterns ?? [] } });
    }
    return out;
  }
  for (const id of ids) {
    const forms = await read(routes.forms(id));
    const permissions = await read(routes.permissions(id));
    if (!forms || !permissions) return null;
    for (const f of forms) {
      out.push({ kind: 'question', id: f.id, sessionId: f.sessionID, toolCallId: callId(f.metadata?.tool?.id), questions: (f.fields ?? []).map((x: Json) => ({ key: x.key, question: x.description ?? x.title ?? null, header: x.title ?? null, multiple: x.type === 'multiselect', type: x.type, options: (x.options ?? []).map((o: Json) => o.value), optionDescriptions: (x.options ?? []).map((o: Json) => o.description) })) });
    }
    for (const p of permissions) out.push({ kind: 'permission', id: p.id, sessionId: p.sessionID, toolCallId: callId(p.source?.id), permission: { action: p.action ?? null, resources: p.resources ?? [] } });
  }
  return out;
}

/** Busy sessions by native status: v1 `/session/status` (absent means idle), v2 `/api/session/active`. Null when unknown. */
async function busySessions(host: string, get: (request: Json) => Promise<ApiResult>, routes = exerciseRoutes(host, PROJ)): Promise<Set<string> | null> {
  const res = await get(host === 'v1' ? routes.status() : routes.active());
  const map = succeeded(res) ? payload(host, res.body) : undefined;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  return new Set(Object.entries(map).filter(([, v]: [string, Json]) => host === 'v1' ? v?.type !== 'idle' : true).map(([k]) => k));
}

/**
 * Whether the tree may receive a new prompt or primary switch: a complete tree and complete histories, no busy session,
 * no running or pending tool part, and no pending interaction. Any unknown is a reason, never quiescence. The status and
 * interaction reads happen after the tree was enumerated, so a session created in between is caught three ways: a busy
 * or pending entry outside the tree, and a second enumeration (`recheck`) that differs from the first.
 */
export function quiescence(tree: Tree, histories: Map<string, History>, busy: Set<string> | null, pending: Pending[] | null, recheck: Tree | null = null): { quiescent: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!tree.complete) reasons.push(`tree_incomplete:${tree.failure ?? 'cap'}`);
  else if (!recheck || !recheck.complete || recheck.sessions.length !== tree.sessions.length || recheck.sessions.some((s) => !tree.sessions.some((t) => t.id === s.id))) reasons.push('tree_changed');
  if (busy === null) reasons.push('status_unknown');
  if (pending === null) reasons.push('interactions_unknown');
  const known = new Set(tree.sessions.map((s) => s.id));
  for (const id of busy ?? []) if (!known.has(id)) reasons.push(`session_busy_outside_tree:${id}`);
  for (const s of tree.sessions) {
    if (busy?.has(s.id)) reasons.push(`session_busy:${s.id}`);
    const h = histories.get(s.id);
    if (!h || !h.complete) reasons.push(`history_incomplete:${s.id}`);
    else if (h.messages.some((m) => m.tools.some((t) => t.status === 'running' || t.status === 'pending'))) reasons.push(`tool_running:${s.id}`);
  }
  for (const p of pending ?? []) reasons.push(p.outsideTree ? `pending_outside_tree:${p.id}` : `pending_${p.kind}:${p.id}`);
  return { quiescent: reasons.length === 0, reasons };
}

/**
 * A direct Hive tool's result from its native output: the structured value, or the JSON text both hosts present.
 * Nothing is unwrapped: a value a model could write (Code Mode `execute` output) is never read as a Hive result.
 */
export function parseToolResult(output: unknown): Json {
  if (typeof output !== 'string') return output && typeof output === 'object' ? output : null;
  try {
    const value = JSON.parse(output);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The arguments of a direct native call to one Hive tool, or null. Only a tool part the host itself recorded under
 * that tool's name counts. Code Mode `execute` is never evidence of a Hive call, whatever its code mentions and whatever
 * it returned: both are model-written. The plugin registers `hive_plan_read` and `hive_plan_approve` as direct tools on
 * both hosts (src/runtime/host-profile.ts CODEMODE_READ_TOOLS excludes them).
 */
function directHiveArguments(tool: Json, name: string): Json | null {
  return tool.name === name && tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input) ? tool.input : null;
}

/**
 * The primary's latest completed plugin `hive_plan_read` of one feature, with its exact session, message and call. Only
 * the actual primary session counts (never a descendant's read, however late), only a direct call that names the
 * feature, and only a full read: an outline or a read of another feature is not the plan the supervisor decided on.
 */
export function latestPluginPlanRead(tree: Tree, histories: Map<string, History>, feature: string): Json {
  const primary = tree.sessions[0];
  let found: Json = null;
  for (const m of primary ? histories.get(primary.id)?.messages ?? [] : []) {
    for (const t of m.tools) {
      if (t.status !== 'completed') continue;
      const args = directHiveArguments(t, 'hive_plan_read');
      if (!args || args.feature !== feature || (args.mode !== undefined && args.mode !== 'full')) continue;
      const result = parseToolResult(t.output);
      if (!result || typeof result.revision !== 'string' || typeof result.contentHash !== 'string' || typeof result.content !== 'string') continue;
      found = { sessionId: primary!.id, messageId: m.id, callId: t.id, result };
    }
  }
  return found;
}

/** Every direct plan approval call in the tree: its own arguments and its separate approval and sync outcomes. */
export function observedApprovals(tree: Tree, histories: Map<string, History>): Json[] {
  const out: Json[] = [];
  for (const s of tree.sessions) {
    for (const m of histories.get(s.id)?.messages ?? []) {
      for (const t of m.tools) {
        const args = directHiveArguments(t, 'hive_plan_approve');
        if (!args) continue;
        const result = t.status === 'completed' ? parseToolResult(t.output) : null;
        const approval = result?.approval ?? result;
        out.push({
          sessionId: s.id, messageId: m.id, callId: t.id, agent: m.agent, status: t.status,
          feature: typeof args?.feature === 'string' ? args.feature : null,
          expectedRevision: typeof args?.expectedRevision === 'string' ? args.expectedRevision : null, sync: args?.sync === true,
          approvalSuccess: approval?.success === true, approvalRevision: typeof approval?.revision === 'string' ? approval.revision : null,
          syncSuccess: result?.sync?.success === true,
        });
      }
    }
  }
  return out;
}

export type ApprovalBinding = { messageId: string; feature: string; revision: string };
export type SwitchBinding = ApprovalBinding & { contentHash: string };

/**
 * The primary's successful approval and sync that answers one supervisor decision: a completed call in the primary
 * session, in an assistant message after the decision's own user message, naming the decision's feature and revision
 * as its expectedRevision, with sync requested and both outcomes successful. Approval state is part of the revision, so
 * the result reports the newer revision; the binding is the call's own expectedRevision. Returns that approval or null.
 */
export function approvalObserved(tree: Tree, histories: Map<string, History>, binding: ApprovalBinding): Json | null {
  const primary = tree.sessions[0];
  const messages = primary ? histories.get(primary.id)?.messages ?? [] : [];
  const start = messages.findIndex((m) => m.id === binding.messageId && m.role === 'user');
  if (start < 0) return null;
  const calls = observedApprovals({ ...tree, sessions: [primary] }, new Map([[primary.id, { messages: messages.slice(start + 1), complete: true, failure: null }]]));
  return calls.find((a) => a.status === 'completed' && a.feature === binding.feature && a.expectedRevision === binding.revision && a.sync
    && a.approvalSuccess && a.syncSuccess) ?? null;
}

/**
 * Whether a primary switch may proceed: the primary's own successful approval and sync answered the supervisor's
 * decision (primary session, feature, decision message, revision), and the plan is still what that approval left:
 * approved, the decided content, and the revision the approval itself reported. A rewrite or a new comment after the
 * approval ends it. Returns the refusal, or null.
 */
export async function approvalPrecondition(tree: Tree, histories: Map<string, History>, bound: SwitchBinding, read: (feature: string) => Promise<Json>): Promise<{ failure: string; extra?: Json } | null> {
  const approval = approvalObserved(tree, histories, { messageId: bound.messageId, feature: bound.feature, revision: bound.revision });
  if (!approval) return { failure: 'approval_not_observed' };
  if (typeof approval.approvalRevision !== 'string') return { failure: 'approval_revision_unknown' };
  const core = await read(bound.feature);
  if (!core.ok) return { failure: core.failure };
  if (core.result.status !== 'approved') return { failure: 'plan_not_approved' };
  if (core.result.contentHash !== bound.contentHash || core.result.revision !== approval.approvalRevision) return { failure: 'plan_changed', extra: { currentRevision: core.result.revision } };
  return null;
}

// -----------------------------------------------------------------------------------------------------------------
// Commands

const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+\-/ ]{1,512}$/;
const EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules']);

/** Whether a project-relative path is excluded: a segment such as `.git`, or a native session or background store. */
function excludedPath(rel: string): boolean {
  return rel.split('/').some((p) => EXCLUDED_SEGMENTS.has(p)) || nativeStorePath(rel);
}

/** Whether any existing component of a project-relative path, the last included, is a symbolic link. */
function linkedComponent(root: string, rel: string): boolean {
  let current = root;
  for (const part of rel.split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * A supervisor-selected project path: relative, normalized, no excluded segment or native store, no link, device or
 * escape. No component may be a link, so the allowlisted path is the path read; the resolved path is held to the same
 * exclusions as well.
 */
export function projectFile(path: string, root: string = PROJ): string {
  if (typeof path !== 'string' || !RELATIVE_PATH.test(path) || path.split('/').some((p) => p === '') || excludedPath(path)) fail('path_rejected');
  if (linkedComponent(root, path)) fail('path_rejected');
  const abs = join(root, path);
  let real: string;
  try { real = realpathSync(abs); } catch { return abs; }
  const rel = relative(realpathSync(root), real);
  if (rel.startsWith('..') || rel.startsWith(sep) || excludedPath(rel.split(sep).join('/'))) fail('path_rejected');
  const stat = lstatSync(abs);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) fail('path_rejected');
  return abs;
}

export const LIST_LIMITS = Object.freeze({ entries: 1000, depth: 12 });

/**
 * Regular files under one allowed directory prefix, in path order: name and size only. A prefix with a link anywhere
 * along it is refused, so the listed tree is the allowlisted one. The exclusions hold for the prefix and every entry
 * both as named and as resolved under the project's real root. Links, hardlinks, devices, excluded trees, native stores
 * and names outside the path grammar are counted in `omitted`, never listed or followed; reaching the entry or depth
 * cap marks the listing incomplete. Every listed name is scanned before it leaves.
 */
export function listPrefix(prefix: string, scan: (t: string) => boolean, root: string = PROJ): Json {
  const omitted = { links: 0, special: 0, excluded: 0, names: 0 };
  const entries: Json[] = [];
  let complete = true;
  const trimmed = typeof prefix === 'string' ? prefix.replace(/\/$/, '') : '';
  if (typeof prefix !== 'string' || !prefix.endsWith('/') || !RELATIVE_PATH.test(prefix) || trimmed.split('/').some((p) => p === '') || excludedPath(trimmed) || nativeStorePath(prefix)) return { prefix: 'rejected', entries, complete: false, omitted, absent: false, rejected: true };
  const refused = { prefix, entries, complete: false, omitted, absent: false, rejected: true };
  const start = join(root, trimmed);
  let resolved: string;
  try {
    if (linkedComponent(root, trimmed)) return refused;
    if (!lstatSync(start).isDirectory()) return { ...refused, complete: true };
    resolved = relative(realpathSync(root), realpathSync(start)).split(sep).join('/');
  } catch {
    return { prefix, entries, complete: true, omitted, absent: true, rejected: false };
  }
  if (resolved.startsWith('..') || resolved.startsWith('/') || resolved !== trimmed || excludedPath(resolved) || nativeStorePath(`${resolved}/`)) return refused;
  const walk = (dir: string, rel: string, depth: number): void => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { complete = false; return; }
    for (const name of names) {
      if (entries.length >= LIST_LIMITS.entries) { complete = false; return; }
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (excludedPath(childRel)) { omitted.excluded++; continue; }
      if (!RELATIVE_PATH.test(childRel)) { omitted.names++; continue; }
      let stat;
      try { stat = lstatSync(join(root, childRel)); } catch { complete = false; continue; }
      if (stat.isSymbolicLink()) { omitted.links++; continue; }
      if (stat.isDirectory()) {
        if (depth >= LIST_LIMITS.depth) { complete = false; continue; }
        walk(join(root, childRel), childRel, depth + 1);
      } else if (stat.isFile() && stat.nlink === 1) {
        if (scan(childRel)) fail('evidence_contaminated');
        entries.push({ path: childRel, bytes: stat.size });
      } else omitted.special++;
    }
  };
  walk(start, trimmed, 0);
  return { prefix, entries, complete, omitted, absent: false, rejected: false };
}

function writeProjectFile(path: string, content: string): void {
  if (typeof path !== 'string' || !RELATIVE_PATH.test(path) || path.split('/').some((p) => EXCLUDED_SEGMENTS.has(p) || p === '') || typeof content !== 'string') fail('input_file_rejected');
  const abs = join(PROJ, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, { flag: 'wx' });
}

function git(args: string[]): void {
  const result = spawnSync('git', args, { cwd: PROJ, stdio: 'ignore', timeout: 60_000 });
  if (result.status !== 0) fail('git_failed');
}

async function waitReady(host: string, remaining: () => number): Promise<boolean> {
  while (remaining() > 0) {
    if (succeeded(await strictApi(hostSpec(host).readyPath, { timeoutMs: Math.min(5_000, remaining()) }))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Materializes the snapshotted project, runs its declared lock-backed dependency setup, writes the exercise
 * configuration into the disposable HOME/project, and starts the host server (and the scripted mock provider for the
 * credential-free qualification). Nothing here contacts a model.
 */
async function setup(input: Json): Promise<Json> {
  const remaining = budget(input);
  for (const dir of [PROJ, STATE, join(HOME, '.config', 'opencode')]) mkdirSync(dir, { recursive: true });
  const files = input.qualification === true ? (await import('./exercise-qualification.ts')).QUALIFICATION_FILES : input.files ?? [];
  for (const file of files) writeProjectFile(file.path, file.content);
  let skillsDir: string | null = null;
  for (const [name, text] of Object.entries(input.skills ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || typeof text !== 'string') fail('input_skill_rejected');
    skillsDir = join(WORK, 'exercise-skills');
    mkdirSync(join(skillsDir, name), { recursive: true });
    writeFileSync(join(skillsDir, name, 'SKILL.md'), text, { flag: 'wx' });
  }
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'exercise@example.invalid']);
  git(['config', 'user.name', 'Exercise']);
  git(['add', '-A']);
  git(['commit', '-q', '--allow-empty', '-m', 'chore: exercise base', '-m', 'Disposable exercise repository.']);
  const dependencies: Json[] = [];
  for (const dep of input.dependencies ?? []) {
    const dir = dep.directory === '.' ? PROJ : join(PROJ, dep.directory);
    if (dep.command !== 'npm-ci' || !existsSync(join(dir, 'package-lock.json'))) fail('dependency_rejected');
    // A budget under one millisecond starts nothing: spawnSync reads a zero timeout as no limit at all.
    const wholeTimeout = wholeMs(Math.min(600_000, remaining()));
    const result = wholeTimeout === 0 ? { status: null, signal: 'SIGTERM' } : spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore', timeout: wholeTimeout, env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false' } });
    dependencies.push({ directory: dep.directory, exit: result.status, timedOut: result.signal !== null });
    if (result.status !== 0) return { ok: false, failure: 'dependency_setup_failed', dependencies };
  }
  const { host, provider } = input;
  const config = exerciseHostConfig(host, {
    modelRef: input.modelRef, variant: input.variant, provider, mockPort: MOCK_PORT, serverPort: SERVER_PORT,
    observer: join(HARNESS, 'observer'), askExternalReads: input.askExternalReads === true,
  });
  if (skillsDir) Object.assign(config, host === 'v1' ? { skills: { paths: [skillsDir] } } : { skills: [skillsDir] });
  writeFileSync(join(PROJ, hostSpec(host).configFile), JSON.stringify(config, null, 2));
  writeFileSync(join(HOME, '.config', 'opencode', 'agent_hive.json'), JSON.stringify(exerciseHiveConfig({ agentMode: input.agentMode, agentModels: input.agentModels }), null, 2));
  if (provider === 'mock') detach(process.execPath, [join(HARNESS, 'fixture.ts'), 'mock-provider', JSON.stringify({ host })], 'mock.log');
  detach('/bin/sh', ['-c', `exec "$0" "$@" >> ${WORK}/logs/serve-${host}.log 2>&1`, hostSpec(host).binary, ...serveArgs(host, SERVER_PORT)], `serve-${host}`,
    provider === 'mock' ? { MOCK_PROVIDER_KEY: 'mock-not-a-secret' } : {});
  if (!(await waitReady(host, remaining))) return { ok: false, failure: 'host_not_ready' };
  // The first project-scoped request bootstraps the host's project instance, which can take minutes (a failing
  // background dependency install, plugin loading). It happens here, credential-free, not inside the post-arm window.
  if (!(await warmInstance(host, input.warmAgents ?? [], remaining))) return { ok: false, failure: 'instance_not_ready' };
  return { ok: true, dependencies };
}

/** Waits until the project instance answers and lists the agents the exercise needs (v2 loads plugins asynchronously). */
async function warmInstance(host: string, agents: string[], remaining: () => number): Promise<boolean> {
  const request = exerciseRoutes(host, PROJ).agents();
  while (remaining() > 0) {
    const res = await strictApi(request.path, { timeoutMs: Math.min(180_000, remaining()) });
    const list = succeeded(res) ? payload(host, res.body) : undefined;
    const names = Array.isArray(list) ? list.map((a: Json) => a?.name ?? a?.id) : null;
    if (names && agents.every((a) => names.includes(a))) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Forwards the access-only credential request from stdin to the local server, inside both cutoffs. Nothing is written
 * beside it.
 */
async function inject(input: Json, deps: DriverDeps = LIVE): Promise<Json> {
  const request = input.request;
  const access = input.host === 'v1' ? request?.body?.access : request?.body?.value?.access;
  const refresh = input.host === 'v1' ? request?.body?.refresh : request?.body?.value?.refresh;
  if (typeof access !== 'string' || refresh !== REFRESH_SENTINEL) return { ok: false, failure: 'auth_payload_malformed' };
  const spec = hostSpec(input.host);
  if (request.method !== spec.auth.method || request.path !== spec.auth.path) return { ok: false, failure: 'auth_payload_malformed' };
  const sent = sendEffect(input, { method: request.method, path: request.path, body: request.body }, deps);
  if (sent === null) return { ok: false, failure: 'deadline_exceeded', submitted: false };
  const res = await sent;
  return { ok: succeeded(res), status: res.status };
}

/**
 * Whether every explicitly chosen model and variant (the session's and each role override) and every needed agent exist
 * in the host's actual catalogs. Missing is a stop, not a fallback.
 */
async function catalog(input: Json): Promise<Json> {
  const remaining = budget(input);
  const routes = exerciseRoutes(input.host, PROJ);
  const get = (r: Json) => call(r, remaining);
  const choices: { ref: string; variant: string | null }[] = Array.isArray(input.choices) ? input.choices : [];
  const found = new Map<string, Json>();
  // A stored credential reloads providers asynchronously, so an absent model is re-read until the budget ends.
  while (remaining() > 0) {
    const res = await get(routes.models());
    if (succeeded(res)) {
      for (const choice of choices) {
        const [providerID, ...rest] = String(choice.ref).split('/');
        const modelID = rest.join('/');
        if (input.host === 'v1') {
          const p = (res.body?.providers ?? []).find((x: Json) => x?.id === providerID);
          const m = p?.models?.[modelID];
          if (m) found.set(choice.ref, { toolCall: Boolean(m.capabilities?.toolcall ?? m.tool_call), variants: Object.keys(m.variants ?? {}) });
        } else {
          const m = (payload(input.host, res.body) ?? []).find((x: Json) => (x?.providerID ?? x?.provider?.id) === providerID && x?.id === modelID);
          if (m) found.set(choice.ref, { toolCall: Boolean(m.capabilities?.tools ?? m.capabilities?.toolcall), variants: Array.isArray(m.variants) ? m.variants.map((v: Json) => v?.id ?? v) : Object.keys(m.variants ?? {}) });
        }
      }
    }
    if (choices.every((choice) => found.has(choice.ref)) || remaining() < 2_000) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const agentsList = await list(input.host, routes.agents(), remaining);
  const names = (agentsList ?? []).map((a: Json) => a.name ?? a.id).filter((n: Json) => typeof n === 'string');
  return release(input, {
    ok: true,
    choices: choices.map((choice) => {
      const m = found.get(choice.ref);
      return { ref: choice.ref, listed: Boolean(m), toolCall: Boolean(m?.toolCall), variantListed: choice.variant ? Boolean(m?.variants.includes(choice.variant)) : null };
    }),
    agentsReadable: agentsList !== null,
    agents: Object.fromEntries((input.agents ?? []).map((a: string) => [a, names.includes(a)])),
  }, remaining);
}

/** Creates the primary session, inside both cutoffs. */
async function createSession(input: Json, deps: DriverDeps = LIVE): Promise<Json> {
  const remaining = budget(input, deps.clock);
  const routes = exerciseRoutes(input.host, PROJ);
  const sent = sendEffect(input, routes.createSession({ agent: input.agent, model: input.model }), deps);
  if (sent === null) return { ok: false, failure: 'deadline_exceeded', submitted: false };
  const res = await sent;
  const info = succeeded(res) ? payload(input.host, res.body) : undefined;
  if (!info || typeof info.id !== 'string' || !SESSION_ID.test(info.id)) return { ok: false, failure: res.outcome === 'response' ? 'session_create_refused' : 'session_create_unknown' };
  return release(input, { ok: true, sessionId: info.id }, remaining);
}

/**
 * The full observation one command decides from. The tree is enumerated twice, around the histories, status and
 * interaction reads, so a child created in between makes the observation non-quiescent instead of invisible.
 */
export async function observeWith(host: string, sessionId: string, get: (request: Json) => Promise<ApiResult>, pageLimit = LIMITS.messagesPerPage, pageCount = LIMITS.pagesPerSession) {
  const tree = await sessionTree(host, sessionId, get);
  const histories = new Map<string, History>();
  for (const s of tree.sessions) histories.set(s.id, await readHistory(host, s.id, get, { limit: pageLimit, pages: pageCount }));
  const busy = await busySessions(host, get);
  const pending = tree.complete ? await pendingInteractions(host, tree, get) : null;
  const recheck = tree.complete ? await sessionTree(host, sessionId, get) : null;
  return { tree, histories, busy, pending, ...quiescence(tree, histories, busy, pending, recheck) };
}

function observeTree(input: Json, remaining: () => number, pageLimit = LIMITS.messagesPerPage, pageCount = LIMITS.pagesPerSession, api: typeof strictApi = strictApi) {
  return observeWith(input.host, input.sessionId, (r: Json) => call(r, remaining, undefined, api), pageLimit, pageCount);
}

// What a pending interaction releases. A reply or permission decision rests on what the supervisor was shown, so each
// released item states the original size of every clipped text and the original count of every capped list, and
// `complete` is true only when nothing was clipped, left out or unrepresentable.
const SHOWN = { questions: 16, question: 2000, header: 200, options: 32, option: 300, optionDescription: 500, action: 100, resources: 16, resource: 500 } as const;

/** What a choice's description reads as when the listing carries none for it; it cannot be shown, so it is never read as empty. */
const NO_DESCRIPTION = Symbol('no description');

type Shown = { text: string; chars: number; whole: boolean };

/** A native text as released: scanned whole, then clipped. An absent text is empty; any other non-text value cannot be shown. */
function shown(value: unknown, cap: number, scan: (t: string) => boolean): Shown {
  if (value === null || value === undefined) return { text: '', chars: 0, whole: true };
  if (typeof value !== 'string') return { text: '', chars: 0, whole: false };
  const b = bounded(value, cap, scan);
  return { text: b.text, chars: b.chars, whole: !b.clipped };
}

/** Pending interactions as released: exact IDs, bounded question text and choices or permission scope, with their completeness. */
export function releasedPending(pending: Pending[] | null, scan: (t: string) => boolean): Json {
  if (pending === null) return null;
  return pending.map((p) => {
    const out: Json = { kind: p.kind, id: p.id, sessionId: p.sessionId, toolCallId: p.toolCallId, ...(p.outsideTree ? { outsideTree: true } : {}) };
    let complete = true;
    if (p.questions) {
      complete = p.questions.length <= SHOWN.questions;
      out.questionCount = p.questions.length;
      out.questions = p.questions.slice(0, SHOWN.questions).map((q: Json) => {
        const question = shown(q.question, SHOWN.question, scan);
        const header = q.header === null || q.header === undefined ? null : shown(q.header, SHOWN.header, scan);
        const choices: unknown[] = Array.isArray(q.options) ? q.options : [];
        const options = choices.slice(0, SHOWN.options).map((o) => shown(o, SHOWN.option, scan));
        // A choice's description is part of what the supervisor decides on; the label stays the native answer value.
        const notes: unknown[] = Array.isArray(q.optionDescriptions) ? q.optionDescriptions : [];
        const descriptions = options.map((_, i) => shown(i < notes.length ? notes[i] : NO_DESCRIPTION, SHOWN.optionDescription, scan));
        complete = complete && question.whole && (header?.whole ?? true) && (q.options == null || Array.isArray(q.options)) && choices.length <= SHOWN.options && options.every((o) => o.whole)
          && notes.length === choices.length && descriptions.every((d) => d.whole);
        return {
          ...q, question: question.text, questionChars: question.chars, header: header === null ? null : header.text, headerChars: header === null ? null : header.chars,
          options: options.map((o) => o.text), optionCount: choices.length, optionChars: options.map((o) => o.chars),
          optionDescriptions: descriptions.map((d) => d.text), optionDescriptionChars: descriptions.map((d) => d.chars),
        };
      });
    }
    if (p.permission) {
      const action = shown(p.permission.action, SHOWN.action, scan);
      const scope: unknown[] = Array.isArray(p.permission.resources) ? p.permission.resources : [];
      const resources = scope.slice(0, SHOWN.resources).map((r) => shown(r, SHOWN.resource, scan));
      complete = complete && action.whole && (p.permission.resources == null || Array.isArray(p.permission.resources)) && scope.length <= SHOWN.resources && resources.every((r) => r.whole);
      out.permission = { action: action.text, actionChars: action.chars, resources: resources.map((r) => r.text), resourceCount: scope.length, resourceChars: resources.map((r) => r.chars) };
    }
    out.complete = complete;
    return out;
  });
}

/** The labels of a question answer in any native form: an array of arrays or strings, or a keyed object (`q0`, `q1`). */
function answerLists(value: unknown): string[][] | null {
  const entries = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.keys(value).sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''))).map((k) => (value as Json)[k]) : null;
  if (!entries) return null;
  const lists = entries.map((e: unknown) => (Array.isArray(e) ? e : [e]));
  return lists.every((l: unknown[]) => l.every((x) => typeof x === 'string')) ? (lists as string[][]) : null;
}

function sameAnswers(sent: string[][], native: unknown): boolean {
  const lists = answerLists(native);
  return lists !== null && lists.length === sent.length && lists.every((l, i) => l.length === sent[i].length && l.every((x, j) => x === sent[i][j]));
}

/**
 * Resolves an earlier submission whose acknowledgement was lost, only from native evidence that names this exact
 * operation. A prompt, and a v1 command, is found by the message ID the supervisor chose; a command's resolution also
 * reports the agent that message names. A v2 command takes no message ID, so nothing names it and it stays
 * unresolved. A question reply is accepted when its own tool
 * call, the only call with that ID in the completely read history of the session that asked, is a `question` call that
 * completed with exactly the answers that were sent (v1), or when its own form is answered with exactly those answers
 * (v2). Nothing else is proof: a request that is still pending may yet receive a late reply, a missing request or an
 * idle session may have another cause, a matching call in another session answers another question, and a permission
 * reply, a switch or an interrupt leave no record that names them. The native API cannot correlate those, so they stay
 * unresolved and the run is stopped. The one exception is a v2 agent switch, whose effect is the session's own agent
 * field: it is accepted when the session already runs the target, because only this controller switches agents and the
 * target differs from the previous primary.
 */
export async function resolveOperation(host: string, op: Json, observed: Json, get: (request: Json) => Promise<ApiResult>): Promise<Json> {
  const routes = exerciseRoutes(host, PROJ);
  if (op.kind === 'prompt' || (op.kind === 'command' && host === 'v1')) {
    if (typeof op.messageId !== 'string') return { resolved: false };
    const res = await get(routes.message(op.sessionId, op.messageId));
    if (!succeeded(res)) return { resolved: false };
    const m = normalizeMessage(host, payload(host, res.body));
    if (!m || m.id !== op.messageId || m.role !== 'user') return { resolved: false };
    return op.kind === 'command' ? { resolved: true, effect: 'accepted', agent: m.agent } : { resolved: true, effect: 'accepted' };
  }
  if (op.kind === 'question-reply' && Array.isArray(op.answers)) {
    if (host === 'v1') {
      const owner: History | undefined = typeof op.ownerSessionId === 'string' ? observed.histories?.get(op.ownerSessionId) : undefined;
      if (typeof op.toolCallId !== 'string' || !owner?.complete) return { resolved: false };
      const calls = owner.messages.flatMap((m: Message) => m.tools).filter((t: Json) => t.id === op.toolCallId);
      const [only] = calls;
      return calls.length === 1 && only.name === 'question' && only.status === 'completed' && sameAnswers(op.answers, only.metadata?.answers) ? { resolved: true, effect: 'accepted' } : { resolved: false };
    }
    const res = await get(routes.form(op.ownerSessionId, op.requestId));
    const detail = succeeded(res) ? payload(host, res.body) : undefined;
    const state = detail?.state;
    // The form's own field order gives the answers their order; without it the keys q0, q1, ... are read in index order.
    const keys: unknown[] | null = Array.isArray(detail?.fields) ? detail.fields.map((f: Json) => f?.key) : null;
    const answered = state?.answer && typeof state.answer === 'object' ? state.answer : null;
    const native = keys && answered && keys.length === Object.keys(answered).length && keys.every((k) => typeof k === 'string' && k in answered) ? keys.map((k) => answered[k as string]) : answered;
    return state?.status === 'answered' && sameAnswers(op.answers, native) ? { resolved: true, effect: 'accepted' } : { resolved: false };
  }
  if (op.kind === 'switch' && host === 'v2' && typeof op.from === 'string' && op.from !== op.agent) {
    const res = await get(routes.session(op.sessionId));
    const info = succeeded(res) ? payload(host, res.body) : undefined;
    return info?.agent === op.agent ? { resolved: true, effect: 'accepted' } : { resolved: false };
  }
  return { resolved: false };
}

/**
 * Observes, checks one operation's preconditions against that observation, and submits it once. Preconditions: a
 * prompt, command or switch needs a quiescent tree; a reply needs its exact pending request in the tree; an approval also needs
 * the current candidate-core read to match the supervisor's decision; a switch needs the primary's own successful
 * approval of that decision and a core plan that is still the approved one. A response that is not a clear success is
 * `unknown`, never success and never retried here. The request is sent only if the host's command cutoff and the
 * action's cutoff are both still ahead when it is sent, after every observation.
 */
export async function submit(input: Json, deps: DriverDeps = LIVE): Promise<Json> {
  const remaining = budget(input, deps.clock);
  const scan = scannerFor(input);
  if (input.trusted && !(await nativeCredentialMatches(input.host, input.expected, nativeReaders(remaining)))) return { ok: false, failure: 'native_auth_changed' };
  const routes = exerciseRoutes(input.host, PROJ);
  const op = input.op;
  const observed = await observeTree(input, remaining, LIMITS.messagesPerPage, LIMITS.pagesPerSession, deps.api);
  const refuse = (failure: string, extra: Json = {}) => release(input, { ok: true, submitted: false, refused: failure, reasons: observed.reasons, pending: releasedPending(observed.pending, scan), ...extra }, remaining);
  let request: Json;
  if (op.kind === 'prompt' || op.kind === 'switch') {
    if (!observed.quiescent) return refuse('not_quiescent');
    if (op.plan) {
      const core = await readPlan(PROJ, op.plan.feature);
      if (!core.ok) return refuse(core.failure);
      if (core.result.revision !== op.plan.revision || core.result.contentHash !== op.plan.contentHash) return refuse('plan_changed', { currentRevision: core.result.revision });
      const plugin = latestPluginPlanRead(observed.tree, observed.histories, op.plan.feature);
      if (!plugin || plugin.result.revision !== op.plan.revision) return refuse('plugin_read_not_current');
      if (planReadDifferences(plugin.result, core.result).length) return refuse('plan_read_parity_failed');
    }
    if (op.requireApproval) {
      const refusal = await approvalPrecondition(observed.tree, observed.histories, op.requireApproval, (feature: string) => readPlan(PROJ, feature));
      if (refusal) return refuse(refusal.failure, refusal.extra);
    }
    if (op.kind === 'prompt') {
      if (scan(op.text)) return { ok: false, failure: 'evidence_contaminated' };
      request = routes.prompt({ sessionId: op.sessionId, messageId: op.messageId, agent: op.agent, model: op.model, text: op.text });
    } else {
      // v1 has no session agent: every prompt names its agent, so the checked switch is the controller's own record.
      if (input.host === 'v1') return release(input, { ok: true, submitted: false, local: true }, remaining);
      // The session must be running the primary the controller recorded, so a later match with the target is this switch.
      const res = await call(routes.session(op.sessionId), remaining, undefined, deps.api);
      const info = succeeded(res) ? payload(input.host, res.body) : undefined;
      if (info?.agent !== op.from) return refuse('session_agent_unexpected');
      request = routes.switchAgent(op.sessionId, op.agent);
    }
  } else if (op.kind === 'question-reply' || op.kind === 'permission-reply') {
    const target = observed.pending?.find((p) => p.id === op.requestId && !p.outsideTree);
    if (!target || target.kind !== (op.kind === 'question-reply' ? 'question' : 'permission')) return refuse('request_not_pending');
    // The supervisor decides on the released form. A request whose released form clips or leaves something out is not
    // answered or approved on that basis; rejecting a permission is the one safe reply to a scope not fully shown.
    if (!(op.kind === 'permission-reply' && op.decision === 'reject') && !releasedPending([target], () => false)[0].complete) return refuse('request_incomplete');
    if (op.kind === 'question-reply') {
      const qs = target.questions ?? [];
      if (!Array.isArray(op.answers) || op.answers.length !== qs.length || op.answers.some((a: Json) => !Array.isArray(a) || a.length === 0 || a.some((x: Json) => typeof x !== 'string'))) return refuse('answers_invalid');
      if (op.answers.some((a: string[], i: number) => !qs[i].multiple && a.length !== 1)) return refuse('answers_invalid');
      if (scan(JSON.stringify(op.answers))) return { ok: false, failure: 'evidence_contaminated' };
      if (input.host === 'v1') request = routes.questionReply(target.sessionId, target.id, op.answers);
      else request = routes.formReply(target.sessionId, target.id, Object.fromEntries(qs.map((q: Json, i: number) => [q.key, q.multiple ? op.answers[i] : op.answers[i][0]])));
    } else {
      if (!['once', 'reject'].includes(op.decision)) return refuse('decision_invalid');
      request = routes.permissionReply(target.sessionId, target.id, op.decision);
    }
  } else if (op.kind === 'interrupt') {
    request = routes.interrupt(op.sessionId);
  } else if (op.kind === 'command') {
    return submitCommand(input, op, observed, deps, remaining, scan, refuse);
  } else return { ok: false, failure: 'operation_kind_invalid' };
  // Past this point the request is the only effect. An observation that outlived either cutoff sends nothing: the
  // refusal is definitive because nothing was sent.
  const sent = sendEffect(input, request, deps);
  if (sent === null) return refuse('deadline_exceeded');
  const res = await sent;
  // Credential-free qualification only: the request was sent and its reply is discarded, as a lost acknowledgement.
  if (input.dropAcknowledgement === true) return { ok: true, submitted: true, acknowledged: null };
  const target = observed.pending?.find((p) => p.id === op.requestId && !p.outsideTree);
  return release(input, {
    ok: true, submitted: true, acknowledged: succeeded(res) ? true : res.outcome === 'response' ? false : null, status: res.status,
    ...(target ? { ownerSessionId: target.sessionId, toolCallId: target.toolCallId } : {}),
  }, remaining);
}

type CommandAcknowledgement = { acknowledged: boolean | null; status: number | null; agent?: string | null };

/**
 * One native command in the primary session, sent once with the operator's text exactly as written. It needs a
 * quiescent tree and the command in the host's catalog. On v1 the catalog's agent binding must be the one the request
 * declared; v2 lists no binding, so there the session must still run the recorded primary. The reply carries the agent
 * the host ran the command under, from the exact user message on v1 and from the session on v2, so the controller
 * tracks the primary the host actually bound instead of the one it expected.
 */
async function submitCommand(input: Json, op: Json, observed: Json, deps: DriverDeps, remaining: () => number, scan: (t: string) => boolean, refuse: (failure: string, extra?: Json) => Promise<Json>): Promise<Json> {
  if (!observed.quiescent) return refuse('not_quiescent');
  if (scan(op.text)) return { ok: false, failure: 'evidence_contaminated' };
  const host = input.host;
  const routes = exerciseRoutes(host, PROJ);
  const get = (request: Json) => call(request, remaining, undefined, deps.api);
  const listed = await get(routes.commands());
  const catalog = succeeded(listed) ? payload(host, listed.body) : undefined;
  if (!Array.isArray(catalog)) return refuse('command_catalog_unreadable');
  const entry = catalog.find((c: Json) => c?.name === op.name);
  if (!entry) return refuse('command_not_found');
  if (host === 'v1') {
    const bound = typeof entry.agent === 'string' ? entry.agent : null;
    if (op.agent === op.from ? bound !== null && bound !== op.from : bound !== op.agent) return refuse('command_binding_unexpected');
  } else {
    const res = await get(routes.session(op.sessionId));
    const info = succeeded(res) ? payload(host, res.body) : undefined;
    if (info?.agent !== op.from) return refuse('session_agent_unexpected');
  }
  const abort = new AbortController();
  const sent = host === 'v1'
    ? sendEffect(input, routes.command({ sessionId: op.sessionId, messageId: op.messageId, agent: op.from, model: op.model, name: op.name, text: op.text }), deps, { abort: abort.signal })
    : sendEffect(input, routes.command({ sessionId: op.sessionId, name: op.name, text: op.text }), deps);
  if (sent === null) return refuse('deadline_exceeded');
  const result = host === 'v1' ? await v1CommandAcknowledgement(op, sent, get, remaining) : await v2CommandAcknowledgement(op, await sent, get);
  // v1 holds the request open for the whole turn; the turn runs in the host's session runner whether or not it is.
  abort.abort();
  await sent;
  // Credential-free qualification only: the command was sent and its acknowledgement is discarded, as a lost one.
  if (input.dropAcknowledgement === true) return { ok: true, submitted: true, acknowledged: null };
  return release(input, { ok: true, submitted: true, ...result }, remaining);
}

/**
 * v1 answers a command request only when the whole turn has ended, which may be after a question the supervisor has
 * to answer. Its acknowledgement is therefore native evidence that names the operation: the user message with the
 * supervisor-chosen ID while the session runs it, or the request's own answer. Without either before the command
 * cutoff it stays unknown.
 */
async function v1CommandAcknowledgement(op: Json, sent: Promise<ApiResult>, get: (request: Json) => Promise<ApiResult>, remaining: () => number): Promise<CommandAcknowledgement> {
  const routes = exerciseRoutes('v1', PROJ);
  const answer: { value: ApiResult | null } = { value: null };
  void sent.then((res) => { answer.value = res; });
  const message = async (): Promise<Message | null> => {
    const res = await get(routes.message(op.sessionId, op.messageId));
    const m = succeeded(res) ? normalizeMessage('v1', res.body) : null;
    return m && m.id === op.messageId && m.role === 'user' ? m : null;
  };
  while (answer.value === null && remaining() > 0) {
    const m = await message();
    if (m && (await busySessions('v1', get))?.has(op.sessionId)) return { acknowledged: true, status: null, agent: m.agent };
    await new Promise((r) => setTimeout(r, wholeMs(Math.min(500, remaining()))));
  }
  const res = answer.value as ApiResult | null;
  if (res === null) return { acknowledged: null, status: null };
  const m = await message();
  if (m) return { acknowledged: true, status: res.status, agent: m.agent };
  return { acknowledged: res.outcome === 'response' && !succeeded(res) ? false : null, status: res.status };
}

/** v2 answers once the plugin callback has admitted its prompt. A definite answer also reads the agent the session now runs. */
async function v2CommandAcknowledgement(op: Json, res: ApiResult, get: (request: Json) => Promise<ApiResult>): Promise<CommandAcknowledgement> {
  if (res.outcome !== 'response') return { acknowledged: null, status: res.status };
  const session = await get(exerciseRoutes('v2', PROJ).session(op.sessionId));
  const info = succeeded(session) ? payload('v2', session.body) : undefined;
  return { acknowledged: succeeded(res), status: res.status, agent: word(info?.agent) };
}

/** Bounded export of the conversation, child returns, tool outcomes and observed models; tool outputs are reduced. */
function exportConversation(observed: Json, scan: (t: string) => boolean): Json {
  let toolRecords = 0;
  let toolsCapped = false;
  const sessions = observed.tree.sessions.map((s: Json) => {
    const h: History = observed.histories.get(s.id) ?? { messages: [], complete: false, failure: 'unread' };
    const turns = h.messages.map((m) => {
      const text = bounded(m.text, LIMITS.turnChars, scan);
      const tools: Json[] = [];
      for (const t of m.tools) {
        if (toolRecords >= LIMITS.toolRecords) { toolsCapped = true; break; }
        toolRecords++;
        tools.push(toolRecord(t, scan));
      }
      return { id: m.id, role: m.role, agent: m.agent, model: m.model, error: m.error, text: text.text, chars: text.chars, clipped: text.clipped, tools };
    });
    const finalText = [...h.messages].reverse().find((m) => m.role === 'assistant' && m.text)?.text ?? '';
    const final = bounded(finalText, LIMITS.turnChars, scan);
    return { id: s.id, parentId: s.parentId, agent: s.agent, historyComplete: h.complete, historyFailure: h.failure, turns, finalReturn: { text: final.text, chars: final.chars, clipped: final.clipped } };
  });
  return { sessions, toolRecordsCapped: toolsCapped };
}

const SAFE_WORD = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;

/** One tool call as exported: name, status, exact call ID and a structured outcome. Raw outputs never leave. */
function toolRecord(t: Json, scan: (t: string) => boolean): Json {
  const out: Json = { id: typeof t.id === 'string' && NATIVE_ID.test(t.id) ? t.id : null, name: typeof t.name === 'string' && SAFE_WORD.test(t.name) ? t.name : 'other', status: typeof t.status === 'string' && SAFE_WORD.test(t.status) ? t.status : null };
  const input = t.input && typeof t.input === 'object' ? t.input : {};
  const boundedString = (value: unknown, max: number) => (typeof value === 'string' && value.length <= max ? value : null);
  if (t.name === 'task' || t.name === 'subagent') {
    out.agent = word(input.subagent_type ?? input.agent);
    const child = t.metadata?.sessionId ?? t.metadata?.sessionID;
    out.childSessionId = typeof child === 'string' && SESSION_ID.test(child) ? child : null;
    out.prompt = bounded(input.prompt, 4000, scan);
  } else if (t.name === 'bash' || t.name === 'shell') {
    out.command = bounded(input.command, 1000, scan);
    out.exit = Number.isInteger(t.metadata?.exit) ? t.metadata.exit : null;
  } else if (t.name === 'execute') {
    // Code Mode: the code is exported as written; its output is model-written, so it is never read as a Hive result.
    out.args = bounded(JSON.stringify(input), 2000, scan);
  } else if (typeof t.name === 'string' && t.name.startsWith('hive_')) {
    const result = t.status === 'completed' ? parseToolResult(t.output) : null;
    out.args = bounded(JSON.stringify(input), 2000, scan);
    out.result = result === null ? null : {
      success: typeof result.success === 'boolean' ? result.success : null,
      approval: result.approval ? { success: typeof result.approval.success === 'boolean' ? result.approval.success : null, reason: SAFE_WORD.test(result.approval.reason ?? '') ? result.approval.reason : null, revision: boundedString(result.approval.revision, 200) } : null,
      sync: result.sync ? { success: typeof result.sync.success === 'boolean' ? result.sync.success : null } : null, revision: boundedString(result.revision, 200),
    };
  } else if (['read', 'write', 'edit', 'glob', 'grep'].includes(t.name)) {
    out.path = bounded(input.filePath ?? input.path ?? input.pattern ?? '', 500, scan);
  } else if (t.name === 'question') {
    out.questions = bounded(JSON.stringify(input.questions ?? []), 4000, scan);
    out.answers = bounded(JSON.stringify(t.metadata?.answers ?? null), 2000, scan);
  }
  return out;
}

export function artifactRecord(path: string, scan: (t: string) => boolean, root: string = PROJ): Json {
  let abs: string;
  try { abs = projectFile(path, root); } catch { return { path, omitted: 'path_rejected' }; }
  if (!existsSync(abs)) return { path, omitted: 'absent' };
  const size = lstatSync(abs).size;
  if (size > LIMITS.artifactBytes) return { path, omitted: 'oversize', bytes: size };
  const bytes = readFileSync(abs);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { path, omitted: 'not_utf8', bytes: size }; }
  return { path, bytes: size, sha256: sha256(bytes), text: bounded(text, LIMITS.artifactBytes, scan).text };
}

/** Line diff of one path between the host-sent base content and the current file, without Git diff drivers. */
export function lineDiff(path: string, before: string | null, after: string | null): string {
  if (before === after) return '';
  const a = before === null ? [] : before.split('\n');
  const b = after === null ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${start + 1},${endA - start} +${start + 1},${endB - start} @@`, ...a.slice(start, endA).map((l) => `-${l}`), ...b.slice(start, endB).map((l) => `+${l}`)].join('\n') + '\n';
}

/**
 * Observation and optional export. With `resolve`, also decides one earlier unknown submission from exact native
 * evidence. Inspect never runs project commands or tests.
 */
async function observe(input: Json): Promise<Json> {
  const remaining = budget(input);
  const scan = scannerFor(input);
  if (input.trusted && !(await nativeCredentialMatches(input.host, input.expected, nativeReaders(remaining)))) return { ok: false, failure: 'native_auth_changed' };
  const want = input.request ?? {};
  const pageLimit = Math.min(LIMITS.messagesPerPage, want.conversation?.messagesPerPage ?? LIMITS.messagesPerPage);
  const pageCount = Math.min(LIMITS.pagesPerSession, want.conversation?.pages ?? LIMITS.pagesPerSession);
  const observed = await observeTree(input, remaining, pageLimit, pageCount);
  const out: Json = {
    ok: true,
    tree: { sessions: observed.tree.sessions, complete: observed.tree.complete, failure: observed.tree.failure },
    busy: observed.busy === null ? null : [...observed.busy].filter((id) => observed.tree.sessions.some((s) => s.id === id)),
    pending: releasedPending(observed.pending, scan),
    quiescent: observed.quiescent, reasons: observed.reasons,
    approvals: observedApprovals(observed.tree, observed.histories),
  };
  if (input.resolve) out.resolution = await resolveOperation(input.host, input.resolve, observed, (r: Json) => call(r, remaining));
  if (want.conversation) out.conversation = exportConversation(observed, scan);
  if (want.plan) {
    const core = await readPlan(PROJ, want.plan.feature);
    const plugin = latestPluginPlanRead(observed.tree, observed.histories, want.plan.feature);
    out.plan = core.ok
      ? {
        ok: true, featurePath: core.featurePath, planPath: core.planPath, revision: core.result.revision, contentHash: core.result.contentHash, status: core.result.status,
        comments: bounded(JSON.stringify(core.result.comments ?? []), 32 * 1024, scan), content: bounded(core.result.content, LIMITS.artifactBytes, scan),
        pluginRead: plugin ? { sessionId: plugin.sessionId, messageId: plugin.messageId, callId: plugin.callId, revision: plugin.result.revision, differences: planReadDifferences(plugin.result, core.result) } : null,
      }
      : { ok: false, failure: core.failure };
  }
  if (Array.isArray(want.artifacts)) out.artifacts = want.artifacts.slice(0, LIMITS.artifacts).map((p: string) => artifactRecord(p, scan));
  if (Array.isArray(want.list)) out.list = want.list.slice(0, LIMITS.artifacts).map((p: string) => listPrefix(p, scan));
  if (want.diff && input.base) {
    let total = 0;
    const diffs: Json[] = [];
    for (const [path, before] of Object.entries(input.base as Record<string, string | null>)) {
      const now = artifactRecord(path, scan);
      const after = typeof now.text === 'string' ? now.text : null;
      const diff = now.omitted && now.omitted !== 'absent' ? null : lineDiff(path, before, after);
      if (diff === null) { diffs.push({ path, omitted: now.omitted }); continue; }
      if (total + diff.length > LIMITS.diffBytes) { diffs.push({ path, omitted: 'diff_cap' }); continue; }
      total += diff.length;
      if (diff) diffs.push({ path, diff: bounded(diff, LIMITS.diffBytes, scan).text });
    }
    out.diff = diffs;
  }
  return release(input, out, remaining);
}

/** Build-time report of the installed core bundle: its hash and the types of the public functions the reader uses. */
async function coreReport(): Promise<Json> {
  const core = await import(CORE_BUNDLE);
  return { coreSha256: sha256(readFileSync(CORE_BUNDLE)), exports: Object.fromEntries(['getFeaturePath', 'getPlanPath', 'PlanService'].map((name) => [name, typeof core[name]])) };
}

/**
 * Credential-free qualification only: seeds one review comment where the VS Code extension stores it, at the core's
 * own canonical review path, so the plan revision changes as it does for a real reviewer.
 */
async function seedComments(input: Json): Promise<Json> {
  const before = await readPlan(PROJ, input.feature);
  if (!before.ok) return { ok: false, failure: before.failure };
  const core = await import(CORE_BUNDLE);
  const path = core.getReviewCommentsPath(PROJ, input.feature, 'plan');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ threads: [{ id: 'qualification-comment', line: 1, body: 'Qualification review comment.', replies: [] }] }));
  const after = await readPlan(PROJ, input.feature);
  if (!after.ok) return { ok: false, failure: after.failure };
  return after.result.revision === before.result.revision ? { ok: false, failure: 'comment_seed_ineffective' } : { ok: true, revision: after.result.revision };
}

/**
 * The container's shared clock (`clockMs`), which the guard keeps its deadline on, and this process's own
 * `performance.now()` (`processMs`), which starts at zero in each process. The host brackets `clockMs` between two
 * guard readings to prove both read one clock; `processMs` lets qualification show the bracket refuses a
 * process-relative clock.
 */
async function clock(): Promise<Json> {
  return { ok: true, clockMs: sharedClockMs(), processMs: performance.now() };
}

/** Credential-free qualification only: the scripted prompt text for one qualification step. */
async function qualificationPromptText(input: Json): Promise<Json> {
  const { qualificationPrompt } = await import('./exercise-qualification.ts');
  return { ok: true, text: qualificationPrompt(input.step, input.facts ?? {}) };
}

const COMMANDS: Record<string, (input: Json) => Promise<Json>> = {
  setup, inject: (input) => inject(input), catalog, 'create-session': (input) => createSession(input), submit: (input) => submit(input), observe, clock,
  'seed-comments': seedComments, 'qualification-prompt': qualificationPromptText,
};

async function readStdin(): Promise<Json> {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 16 * 1024 * 1024) return null;
  }
  try { return JSON.parse(raw); } catch { return null; }
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  if (command === 'core-report') {
    emit(await coreReport());
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) { emit({ ok: false, failure: 'unknown_command' }); process.exit(2); }
  const input = await readStdin();
  if (!input || !['v1', 'v2'].includes(input.host)) { emit({ ok: false, failure: 'input_malformed' }); process.exit(2); }
  // A driver whose exec started after the host's command cutoff, or that received none, does nothing: no observation,
  // no request.
  if (budget(input)() <= 0) { emit({ ok: false, failure: 'deadline_exceeded', submitted: false }); process.exit(4); }
  try {
    emit(await handler(input));
  } catch (error) {
    emit({ ok: false, failure: error instanceof DriverFailure ? error.code : 'driver_exception' });
    process.exit(3);
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) await main();
