import { OpenCode } from '@opencode/client';
import { IDENTITY_RPC_ID, type Identity } from './identity.js';

/**
 * Read access to the running OpenCode v2 server for the session reads the in-process plugin API lacks (active
 * sessions, message history). The public client is created lazily, on the first read after setup, never during
 * activation: activation would otherwise wait on a request to the server that is activating it.
 *
 * Nothing is trusted from an earlier read. Every method checks, before it reads, that the server at the configured
 * URL answers this activation's identity RPC, for this activation's location, with the nonce this activation
 * generated and still holds locally (nothing the caller sends is echoed back as proof), and checks again after it
 * reads, so evidence read across a server restart, reload or port takeover is discarded rather than returned. The
 * methods are the whole surface: there is no client or callback to retain, so a reference kept across a replacement
 * fails the same checks as a fresh one. Only reads are exposed; native mutations stay on the in-process plugin context.
 *
 * Each method takes the caller's `signal`. It reaches every request the method makes, identity checks included, and an
 * aborted call rethrows its own abort error, so a cancellation is never reported as a binding or target failure.
 */

type RawClient = ReturnType<typeof OpenCode.make>;
type VerifiedClient = Pick<RawClient, 'rpc' | 'session' | 'message' | 'experimental'>;
/** The per-request options the public client accepts, reduced to what reads pass. */
type RequestOptions = { signal: AbortSignal } | undefined;

export type ReadAccessErrorCode =
  | 'not_configured' | 'unauthorized' | 'unreachable' | 'wrong_location' | 'wrong_instance'
  | 'caller_unavailable' | 'caller_displaced' | 'target_unavailable' | 'inconsistent_lookup' | 'malformed_response';

export class ReadAccessError extends Error {
  override name = 'ReadAccessError';
  constructor(readonly code: ReadAccessErrorCode, message: string) {
    super(message);
  }
}

/** How a target session relates to the caller in the native parent chain, and where it lives. Separate facts. */
export type TargetCheck = {
  relationship: 'self' | 'child' | 'descendant' | 'other';
  /** Whether the target belongs to this activation's location. Checked independently of the relationship. */
  placement: 'this-location' | 'other-location';
};

/**
 * Whether the host could still run work in a child's session tree without a new prompt. `settled: false` names the
 * first signal that showed work: `job` (the host still lists the child's own subagent job, or a job of the child or a
 * descendant: running, or settled with a notice not yet delivered), `inbox` (the child or a descendant holds queued
 * input) or `active` (the child or a descendant holds an execution now).
 */
export type ChildSettlement = { settled: true } | { settled: false; signal: 'job' | 'inbox' | 'active'; detail: string };

export interface VerifiedReadAccess {
  sessionActive(signal?: AbortSignal): ReturnType<RawClient['session']['active']>;
  sessionGet(sessionID: string, signal?: AbortSignal): ReturnType<RawClient['session']['get']>;
  messageList(input: Parameters<RawClient['message']['list']>[0], signal?: AbortSignal): ReturnType<RawClient['message']['list']>;
  /**
   * Classifies `targetID` against the caller. The caller is read from the server, not assumed from its ID: it must
   * exist, answer to that ID and still sit in this location. Every session read must answer to the ID asked for, the
   * lineage must be a finite chain, and the caller and target are read again before the answer is accepted. Callers
   * decide what each combination permits (other sessions stay inspect-only); a target in another location is
   * reported, never rerouted.
   */
  checkTarget(input: { callerID: string; targetID: string }, signal?: AbortSignal): Promise<TargetCheck>;
  /**
   * Reads, between the identity checks, whether child `childID` of `parentID` has settled. Work moves from a job to an
   * inbox to an active execution, so the reads run in that order (as the host's own `run` command does) and a hand-off
   * between two reads is still seen by the later one: the parent's subagent jobs for the child, then the jobs of the
   * child and its descendants (any listed job, running or not, is pending), then the session tree under the child from
   * the session list, then the inbox of every session in that tree, then the active executions, each matched to the tree
   * or traced up its parent chain. A response that does not have the documented shape is refused, never read as empty.
   * The answer is a sample: it says nothing about work another client starts after the last read.
   */
  childSettlement(input: { parentID: string; childID: string }, signal?: AbortSignal): Promise<ChildSettlement>;
}

type ClientFactory = (options: { baseUrl: string; headers: Record<string, string> }) => VerifiedClient;

/** Connection settings for the read-only public client, without host profile or Hive service types. */
export type ReadServerOptions = { url: string; username: string; passwordEnv?: string };

const MAX_LINEAGE_DEPTH = 32;
/** Children read per session list page, the page size the official client uses for a session family. */
const SESSION_PAGE = 200;

export function createVerifiedReadAccess(input: {
  server: ReadServerOptions | undefined;
  identity: Identity;
  directory: string;
  env?: Record<string, string | undefined>;
  makeClient?: ClientFactory;
}): VerifiedReadAccess {
  const { server, identity, directory } = input;
  const env = input.env ?? process.env;
  const makeClient = input.makeClient ?? ((options) => OpenCode.make(options));
  let created: VerifiedClient | undefined;

  const connect = (): VerifiedClient => {
    if (!server) throw new ReadAccessError('not_configured', 'Session history reads need the oc-arkive `server` option (url and passwordEnv) for this OpenCode v2 server.');
    if (created) return created;
    const password = server.passwordEnv ? env[server.passwordEnv] : undefined;
    if (server.passwordEnv && !password) throw new ReadAccessError('not_configured', `The server password variable ${server.passwordEnv} is not set in the OpenCode server environment.`);
    const headers: Record<string, string> = password ? { authorization: `Basic ${Buffer.from(`${server.username}:${password}`).toString('base64')}` } : {};
    created = makeClient({ baseUrl: server.url, headers });
    return created;
  };

  const verify = async (client: VerifiedClient, options: RequestOptions) => {
    let reply: { output?: unknown };
    try {
      reply = await client.rpc.call({ rpcID: IDENTITY_RPC_ID, method: 'get', location: { directory }, input: {} }, options);
    } catch (error) {
      // A cancelled check says nothing about the server, so the client stays.
      if (options?.signal.aborted) throw error;
      created = undefined;
      throw classifyBindingFailure(error, server!.url);
    }
    const answer = reply.output as { nonce?: unknown; directory?: unknown } | undefined;
    if (answer?.nonce !== identity.nonce) {
      created = undefined;
      throw new ReadAccessError('wrong_instance', `The server at ${server!.url} is not the OpenCode instance running this plugin activation.`);
    }
    if (answer.directory !== directory) {
      created = undefined;
      throw new ReadAccessError('wrong_location', `The server at ${server!.url} answered for ${String(answer.directory)}, not ${directory}.`);
    }
  };

  /** Runs reads between two identity checks; the result is returned only when both pass. */
  const verified = async <T>(read: (client: VerifiedClient, options: RequestOptions) => Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
    const client = connect();
    const options: RequestOptions = signal ? { signal } : undefined;
    await verify(client, options);
    const result = await read(client, options);
    await verify(client, options);
    return result;
  };

  /** A session read must answer to the ID it was asked for. */
  const answeredFor = <T>(session: T, sessionID: string): T => {
    const answered = (session as SessionPlacement | undefined)?.id;
    if (answered !== sessionID) throw new ReadAccessError('inconsistent_lookup', `The server answered a lookup of session ${sessionID} with ${String(answered)}.`);
    return session;
  };

  const getSession = async (client: VerifiedClient, options: RequestOptions, sessionID: string, unavailable: 'caller_unavailable' | 'target_unavailable') => {
    let session;
    try {
      session = await client.session.get({ sessionID } as Parameters<RawClient['session']['get']>[0], options);
    } catch (error) {
      if (options?.signal.aborted) throw error;
      throw new ReadAccessError(unavailable, `Hive could not read session ${sessionID}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return answeredFor(session, sessionID) as unknown as SessionPlacement;
  };

  const classify = async (client: VerifiedClient, options: RequestOptions, caller: SessionPlacement, target: SessionPlacement): Promise<TargetCheck> => {
    const placement = target.location?.directory === directory ? 'this-location' : 'other-location';
    if (target.id === caller.id) return { relationship: 'self', placement };
    if (target.parentID === caller.id) return { relationship: 'child', placement };
    const seen = new Set([target.id]);
    let parentID = target.parentID;
    while (parentID !== undefined) {
      if (seen.has(parentID) || seen.size > MAX_LINEAGE_DEPTH) throw new ReadAccessError('inconsistent_lookup', `The parent chain of session ${target.id} is not a finite chain.`);
      seen.add(parentID);
      const parent = await getSession(client, options, parentID, 'target_unavailable');
      if (parent.parentID === caller.id) return { relationship: 'descendant', placement };
      parentID = parent.parentID;
    }
    return { relationship: 'other', placement };
  };

  /** Whether `sessionID` is `ancestorID` or descends from it; every session on the way is read from the server. */
  const descendsFrom = async (client: VerifiedClient, options: RequestOptions, sessionID: string, ancestorID: string) => {
    const seen = new Set<string>();
    let current: string | undefined = sessionID;
    while (current !== undefined) {
      if (current === ancestorID) return true;
      if (seen.has(current) || seen.size > MAX_LINEAGE_DEPTH) throw new ReadAccessError('inconsistent_lookup', `The parent chain of session ${sessionID} is not a finite chain.`);
      seen.add(current);
      current = (await getSession(client, options, current, 'target_unavailable')).parentID;
    }
    return false;
  };

  /**
   * The session `rootID` and every session below it, read level by level through the public session list filtered by
   * parent. Pages run oldest update first, so a session updated while the pages are read moves to a later page instead
   * of being skipped. A page that answers for another parent, a full page without a next cursor, or a full page that adds
   * no session is refused.
   */
  const sessionTree = async (client: VerifiedClient, options: RequestOptions, rootID: string): Promise<Set<string>> => {
    const depth = new Map([[rootID, 0]]);
    const queue = [rootID];
    for (let next = 0; next < queue.length; next++) {
      const parentID = queue[next]!;
      if (depth.get(parentID)! > MAX_LINEAGE_DEPTH) throw new ReadAccessError('inconsistent_lookup', `The session tree under ${rootID} is deeper than ${MAX_LINEAGE_DEPTH} levels.`);
      let cursor: string | undefined;
      while (true) {
        const page = await client.session.list(cursor === undefined ? { parentID, order: 'asc', limit: SESSION_PAGE } : { cursor, limit: SESSION_PAGE }, options) as unknown;
        const { sessions, next: following } = sessionPage(page, parentID);
        let added = 0;
        for (const id of sessions) {
          if (depth.has(id)) continue;
          depth.set(id, depth.get(parentID)! + 1);
          queue.push(id);
          added += 1;
        }
        if (sessions.length < SESSION_PAGE || following === undefined) break;
        if (added === 0) throw new ReadAccessError('inconsistent_lookup', `The server repeated a full page of the children of session ${parentID}.`);
        cursor = following;
      }
    }
    return new Set(depth.keys());
  };

  /**
   * Every job the host lists is unconsumed: a running job still works, and a settled one still has a notice to admit to
   * its owner's inbox, which wakes that session (job.ts `completeBackground` removes the row only after admission).
   */
  const pendingJob = (job: JobRecord, subject: string): ChildSettlement => ({
    settled: false,
    signal: 'job',
    detail: job.status === 'running' ? `${subject} is running` : `${subject} is ${job.status}, and its notice has not been delivered yet`,
  });

  const settlement = async (client: VerifiedClient, options: RequestOptions, parentID: string, childID: string): Promise<ChildSettlement> => {
    const own = jobsFrom(await client.experimental.job.list({ sessionID: parentID, kind: 'subagent' }, options), 'the parent\'s subagent jobs');
    const ownJob = own.find((job) => job.id === childID || job.childSessionID === childID);
    if (ownJob) return pendingJob(ownJob, `the host's subagent job for child session ${childID}`);
    const descendants = jobsFrom(await client.experimental.job.list({ sessionID: childID, descendants: true }, options), `the jobs of child session ${childID} and its descendants`);
    if (descendants.length > 0) return pendingJob(descendants[0]!, `${descendants[0]!.kind} job ${descendants[0]!.id} of session ${descendants[0]!.sessionID}`);
    // A session can hold queued input with no job and no execution (a prompt admitted without waking it), so every
    // session of the tree is read, not only the sessions jobs name.
    const tree = await sessionTree(client, options, childID);
    for (const sessionID of tree) {
      const inbox = await client.session.inbox.list({ sessionID }, options);
      if (!Array.isArray(inbox)) throw new ReadAccessError('malformed_response', `The server answered the inbox of session ${sessionID} with something other than a list.`);
      if (inbox.length > 0) return { settled: false, signal: 'inbox', detail: `session ${sessionID} has ${inbox.length} queued inbox item(s)` };
    }
    const active = await client.session.active(options);
    if (active === null || typeof active !== 'object' || Array.isArray(active)) throw new ReadAccessError('malformed_response', 'The server answered the active sessions with something other than a record.');
    for (const sessionID of Object.keys(active)) {
      // A session created after the tree was read is still traced up its parent chain.
      if (tree.has(sessionID) || await descendsFrom(client, options, sessionID, childID)) {
        return { settled: false, signal: 'active', detail: sessionID === childID ? `child session ${childID} has an active execution` : `descendant session ${sessionID} of ${childID} has an active execution` };
      }
    }
    return { settled: true };
  };

  return {
    sessionActive: (signal) => verified((client, options) => client.session.active(options), signal),
    sessionGet: (sessionID, signal) => verified(async (client, options) => answeredFor(await client.session.get({ sessionID } as Parameters<RawClient['session']['get']>[0], options), sessionID), signal),
    messageList: (request, signal) => verified((client, options) => client.message.list(request, options), signal),
    checkTarget: ({ callerID, targetID }, signal) => verified(async (client, options) => {
      const readCaller = async () => {
        const caller = await getSession(client, options, callerID, 'caller_unavailable');
        if (caller.location?.directory !== directory) throw new ReadAccessError('caller_displaced', `Caller session ${callerID} is in ${String(caller.location?.directory)}, not ${directory}.`);
        return caller;
      };
      const caller = await readCaller();
      const target = await getSession(client, options, targetID, 'target_unavailable');
      const check = await classify(client, options, caller, target);
      const [callerAgain, targetAgain] = [await readCaller(), await getSession(client, options, targetID, 'target_unavailable')];
      if (callerAgain.parentID !== caller.parentID || targetAgain.parentID !== target.parentID || targetAgain.location?.directory !== target.location?.directory) {
        throw new ReadAccessError('inconsistent_lookup', `Session ${callerID} or ${targetID} changed while its relationship was being checked.`);
      }
      return check;
    }, signal),
    childSettlement: ({ parentID, childID }, signal) => verified((client, options) => settlement(client, options, parentID, childID), signal),
  };
}

/** The job fields a settlement read relies on. */
type JobRecord = { id: string; kind: string; sessionID: string; status: string; childSessionID?: string };

/**
 * One page of the children of `parentID`: their IDs and the next cursor, or a refusal when the page has another shape.
 * The 2.3.2 SessionsResponse always has `cursor`, whose `next` is a cursor string, null or absent, and a page that lists
 * any session always has `next` (core session.ts `list`). A full page without one would end the tree read early.
 */
function sessionPage(value: unknown, parentID: string): { sessions: string[]; next: string | undefined } {
  const page = (value ?? {}) as { data?: unknown; cursor?: { next?: unknown } | null };
  // The JSON codec writes an absent cursor as null, so null and absence both mean no next page.
  const next = page.cursor?.next ?? undefined;
  if (!Array.isArray(page.data) || page.cursor === null || typeof page.cursor !== 'object'
    || (next !== undefined && (typeof next !== 'string' || next === '')) || (page.data.length >= SESSION_PAGE && next === undefined)) {
    throw new ReadAccessError('malformed_response', `The server answered the children of session ${parentID} with something other than a session page.`);
  }
  const sessions = page.data.map((session: unknown) => {
    const record = (session ?? {}) as { id?: unknown; parentID?: unknown };
    if (typeof record.id !== 'string') throw new ReadAccessError('malformed_response', `The server listed a child of session ${parentID} without an ID.`);
    if (record.parentID !== parentID) throw new ReadAccessError('inconsistent_lookup', `The server listed session ${record.id} as a child of ${parentID}, but its parent is ${String(record.parentID)}.`);
    return record.id;
  });
  return { sessions, next: typeof next === 'string' ? next : undefined };
}

/** A job list that has the documented shape, or a refusal: an unexpected answer is never read as no jobs. */
function jobsFrom(value: unknown, what: string): JobRecord[] {
  if (!Array.isArray(value)) throw new ReadAccessError('malformed_response', `The server answered ${what} with something other than a list.`);
  return value.map((job: unknown) => {
    const record = (job ?? {}) as Record<string, unknown>;
    const valid = typeof record.id === 'string' && typeof record.kind === 'string' && typeof record.sessionID === 'string' && typeof record.status === 'string'
      && (record.kind !== 'subagent' || typeof record.childSessionID === 'string');
    if (!valid) throw new ReadAccessError('malformed_response', `The server answered ${what} with a job record that lacks its id, kind, session, status or child.`);
    return record as JobRecord;
  });
}

function classifyBindingFailure(error: unknown, url: string): ReadAccessError {
  const record = (error ?? {}) as { type?: unknown; status?: unknown; message?: unknown };
  const message = typeof record.message === 'string' ? record.message : String(error);
  if (record.type === 'rpc.unavailable') return new ReadAccessError('wrong_location', `The server at ${url} has no oc-arkive activation for this location (${message}).`);
  if (record.status === 401 || /authentication required|unauthori[sz]ed/i.test(message)) return new ReadAccessError('unauthorized', `The server at ${url} rejected the configured credentials.`);
  return new ReadAccessError('unreachable', `The oc-arkive identity check against ${url} failed: ${message}`);
}

/** The parts of a native session record that relationship and placement checks read. */
type SessionPlacement = { id: string; parentID?: string; location?: { directory: string } };
