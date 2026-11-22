import * as fs from 'node:fs';
import { isIPv4 } from 'node:net';
import { ClientError, OpenCode, isSessionNotFoundError } from '@opencode/client';
// Only the path and header helpers: the service lifecycle exports (discover, ensure, stop) are never called.
import { fallback, headers as serviceHeaders, type Endpoint, type Info } from '@opencode/client/service';
import { IDENTITY_RPC_ID, type Identity } from './identity.js';

/**
 * Read access to the running OpenCode v2 server for the session reads the in-process plugin API lacks (active
 * sessions, message history, jobs, inboxes). Activation connects to nothing, because it would wait on the server that
 * is activating it: the first reader operation, a trace read or a `sessionID` continuation's settlement read, makes the
 * binding.
 *
 * Where the reader connects is fixed when the access is created. With the `server` option it is that URL, with the
 * password from its environment variable, and a broken explicit setting fails without falling back. Without it, it is
 * the managed local service, and only when this very process registered it. Each attempt to make a binding reads the
 * registration file at the official client's default `fallback()` path once: opened without blocking, as a regular file
 * of bounded size. The registration is accepted only when it names this process's PID and a numeric loopback http(s)
 * URL with no credentials, path, query or fragment; the client then sends the official `headers` for that endpoint and
 * refuses redirects. Nothing is probed, started, replaced or stopped. A missing, foreign or malformed registration is
 * `not_configured`, is sent no request, and its contents are not repeated. The same PID only admits a candidate; the
 * identity checks below still decide.
 *
 * A binding is one immutable URL and client, reused while its identity checks pass and forgotten when one fails; a
 * failure seen by a read that started on an older binding never evicts a newer one. No call is retried: the next call
 * makes a new binding.
 *
 * A managed-service failure keeps its code and carries a fixed local diagnosis, and an unsettled child keeps its signal
 * with a fixed local detail. No text the endpoint or the official client produced reaches the caller, because callers
 * such as continuation admission show the diagnosis to an agent. Failures and settlement details of an explicit
 * `server` keep their detailed diagnostics.
 *
 * Nothing is trusted from an earlier read. Every method checks, before it reads, that the server at the bound
 * URL answers this activation's identity RPC, for this activation's location, with the nonce this activation
 * generated and still holds locally (nothing the caller sends is echoed back as proof), and checks again after it
 * reads, so evidence read across a server restart, reload or port takeover is discarded rather than returned. The
 * methods are the whole surface: there is no client or callback to retain, so a reference kept across a replacement
 * fails the same checks as a fresh one. Only reads are exposed; native mutations stay on the in-process plugin context.
 *
 * Each method takes the caller's `signal`. It reaches every request the method makes, identity checks included, and an
 * aborted call rethrows its own abort error (for the managed service, the signal's reason), so a cancellation is never
 * reported as a binding or target failure.
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

/** A session read the server answered with the session's absence; callers outside this module see its code only. */
class SessionAbsentError extends ReadAccessError {
  constructor(readonly absentSessionID: string, code: ReadAccessErrorCode, message: string) {
    super(code, message);
  }
}

/**
 * Whether a failed session read shows that the session does not exist: the official client's declared
 * `SessionNotFoundError`, or an undeclared 404. A transport, server or other failure says nothing about the session.
 */
function sessionAbsent(error: unknown): boolean {
  return isSessionNotFoundError(error) || (error instanceof ClientError && error.reason === 'UnexpectedStatus' && fields(error.cause).status === 404);
}

/**
 * A rejection handler that answers `value` when the server reports `sessionID` itself gone, and rethrows every other
 * failure. An absent ancestor of a session that still exists is rethrown: the host deletes a parent's row before its
 * children stop, so that session may still run.
 */
function skipAbsent<T>(sessionID: string, value: T): (error: unknown) => T {
  return (error) => {
    if (error instanceof SessionAbsentError && error.absentSessionID === sessionID) return value;
    throw error;
  };
}

/** How a target session relates to the caller in the native parent chain, and where it lives. Separate facts. */
export type TargetCheck = {
  relationship: 'self' | 'child' | 'descendant' | 'other';
  /** Whether the target belongs to this activation's location. Checked independently of the relationship. */
  placement: 'this-location' | 'other-location';
};

/** The answer `createVerifiedReadAccess` returns: the target check with the facts it was computed from. */
export type ObservedTargetCheck = TargetCheck & {
  /** The target's native parent and location that the relationship and placement were computed from, read again unchanged. */
  observed: { parentID?: string; directory?: string };
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
}

/**
 * What `createVerifiedReadAccess` returns and what Hive consumes: every check reports the facts it observed, and the
 * reader can tell whether a child's session tree has settled. `VerifiedReadAccess` and `TargetCheck` keep their
 * published shapes, so code that implements or constructs them still compiles.
 */
export interface VerifiedTreeReadAccess extends VerifiedReadAccess {
  checkTarget(input: { callerID: string; targetID: string }, signal?: AbortSignal): Promise<ObservedTargetCheck>;
  /**
   * Reads, between the identity checks, whether the session tree under `sessionID` has settled. Work moves from a job
   * to an inbox to an active execution, so the reads run in that order (as the host's own `run` command does) and a
   * hand-off between two reads is still seen by the later one: with `parentID`, the parent's subagent jobs for the
   * session; then the jobs of the session and its descendants (any listed job, running or not, is pending), then the
   * session tree from the session list, then the inbox of every session in that tree, then the active executions,
   * each matched to the tree or traced up its parent chain. Without `parentID` (a root session) the parent's job list
   * is skipped. A response that does not have the documented shape is refused, never read as empty. The answer is a
   * sample: it says nothing about work another client starts after the last read.
   */
  sessionSettlement(input: { sessionID: string; parentID?: string }, signal?: AbortSignal): Promise<ChildSettlement>;
  /** `sessionSettlement` for child `childID` of `parentID`. */
  childSettlement(input: { parentID: string; childID: string }, signal?: AbortSignal): Promise<ChildSettlement>;
  /**
   * The live work under `parentID`, attributed to its direct children, in one pass between the identity checks: the
   * caller must still sit in this location, then the jobs of the parent and its descendants and the server's active
   * executions are read once, and only the sessions that own a listed job or an active execution are traced up their
   * parent chains. Job kinds and statuses are reduced to short tokens; no job command, title or description is
   * returned. A sample like `sessionSettlement`; queued inbox input is not read here.
   */
  parentActivity(input: { parentID: string }, signal?: AbortSignal): Promise<ParentActivity>;
}

/** One live job under a parent: whose job it is relative to the direct child it is attributed to. */
export type ActivityJob = { kind: string; status: string; owner: 'parent' | 'child' | 'descendant' };

/** The live work `parentActivity` attributed to each direct child of the parent that has any. */
export type ParentActivity = { children: Array<{ sessionID: string; jobs: ActivityJob[]; activeExecution: boolean }> };

type ClientFactory = (options: { baseUrl: string; headers: Record<string, string>; fetch?: typeof globalThis.fetch }) => VerifiedClient;

/** Connection settings for the read-only public client, without host profile or Hive service types. */
export type ReadServerOptions = { url: string; username: string; passwordEnv?: string };

/** Where the reader connects, fixed when the access is created: the explicit `server`, or this process's managed service registration. */
type Source = { readonly kind: 'configured'; readonly server: ReadServerOptions } | { readonly kind: 'managed'; readonly file: string };

/** The client for one server. Never mutated; replaced only after it fails a check. */
type Binding = { readonly url: string; readonly client: VerifiedClient };

const MAX_LINEAGE_DEPTH = 32;
/** Children read per session list page, the page size the official client uses for a session family. */
const SESSION_PAGE = 200;
/** A managed service registration is a few hundred bytes; anything larger is not one. */
const MAX_REGISTRATION_BYTES = 64 * 1024;
/** The user the managed service authenticates, as the official client's service probe sends it. */
const MANAGED_USERNAME = 'opencode';
/**
 * Opens the registration read-only without waiting, so a FIFO or device placed at its path is refused by its type instead
 * of blocking this process. A flag the platform does not define (Windows has neither) is left out.
 */
const REGISTRATION_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOCTTY ?? 0);
/** What each managed-service failure says. Every diagnosis is local text: none repeats the endpoint or the client. */
const MANAGED_DIAGNOSIS: Record<ReadAccessErrorCode, string> = {
  not_configured: 'The managed OpenCode service registration cannot be used.',
  unauthorized: 'The managed OpenCode service rejected the credentials in its own registration.',
  unreachable: 'The oc-arkive identity check against the managed OpenCode service failed.',
  wrong_location: 'The managed OpenCode service has no oc-arkive activation for this location.',
  wrong_instance: 'The managed OpenCode service is not the OpenCode instance running this plugin activation.',
  caller_unavailable: 'The managed OpenCode service could not read the calling session.',
  caller_displaced: 'The calling session is no longer in this location.',
  target_unavailable: 'The managed OpenCode service could not read a session the check needs.',
  inconsistent_lookup: 'The managed OpenCode service answered the session reads inconsistently.',
  malformed_response: 'The managed OpenCode service answered a read with something other than the documented shape.',
};
/** What a managed-service read that failed without a Hive refusal says. */
const MANAGED_READ_FAILED = 'A read from the managed OpenCode service failed.';
/** What an unsettled child says on the managed service, chosen by its signal alone: none repeats a field the service returned. */
const MANAGED_PENDING: Record<Exclude<ChildSettlement, { settled: true }>['signal'], string> = {
  job: 'the managed OpenCode service still lists a job of the session or a descendant as pending',
  inbox: 'the managed OpenCode service reports queued inbox input in the session tree',
  active: 'the managed OpenCode service reports an active execution in the session tree',
};
/** What an identity reply or binding failure says in place of a value that is not text. */
const OPAQUE_VALUE = 'a value that is not text';

export function createVerifiedReadAccess(input: {
  server: ReadServerOptions | undefined;
  identity: Identity;
  directory: string;
  env?: Record<string, string | undefined>;
  makeClient?: ClientFactory;
  /** Test seam: the managed service registration file. Defaults to the official client's `fallback()` path. */
  registrationFile?: string;
}): VerifiedTreeReadAccess {
  const { identity, directory } = input;
  const env = input.env ?? process.env;
  const makeClient = input.makeClient ?? ((options) => OpenCode.make(options));
  // Resolved now, without I/O, so a later change to this process's environment cannot redirect the managed read.
  const source: Source = input.server ? { kind: 'configured', server: input.server } : { kind: 'managed', file: input.registrationFile ?? fallback() };
  let binding: Binding | undefined;

  // Synchronous: no other read can interleave, so a binding is published whole or not at all, and a refused managed
  // registration is read again on the next call (a service started later is found then).
  const connect = (): Binding => {
    if (binding) return binding;
    const endpoint = source.kind === 'configured' ? configuredEndpoint(source.server, env) : managedEndpoint(source.file, process.pid);
    const client = makeClient({ baseUrl: endpoint.url, headers: serviceHeaders(endpoint) ?? {}, ...(source.kind === 'managed' ? { fetch: withoutRedirects } : {}) });
    return binding = { url: endpoint.url, client };
  };

  /** Forgets `failed` unless another read has already replaced it. */
  const evict = (failed: Binding) => {
    if (binding === failed) binding = undefined;
  };

  const verify = async (bound: Binding, options: RequestOptions) => {
    let reply: unknown;
    try {
      reply = await bound.client.rpc.call({ rpcID: IDENTITY_RPC_ID, method: 'get', location: { directory }, input: {} }, options);
    } catch (error) {
      // A cancelled check says nothing about the server, so the client stays.
      if (options?.signal.aborted) throw error;
      evict(bound);
      throw classifyBindingFailure(error, bound.url);
    }
    // The reply is untrusted: an envelope or answer of any other shape cannot carry this activation's nonce.
    const answer = fields(fields(reply).output);
    if (answer.nonce !== identity.nonce) {
      evict(bound);
      throw new ReadAccessError('wrong_instance', `The server at ${bound.url} is not the OpenCode instance running this plugin activation.`);
    }
    if (answer.directory !== directory) {
      evict(bound);
      const answered = typeof answer.directory === 'string' ? answer.directory : OPAQUE_VALUE;
      throw new ReadAccessError('wrong_location', `The server at ${bound.url} answered for ${answered}, not ${directory}.`);
    }
  };

  /** Runs reads between two identity checks on one binding; the result is returned only when both pass. */
  const verified = async <T>(read: (client: VerifiedClient, options: RequestOptions) => Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
    // A managed read cancelled before it starts rejects with its reason without reading the registration.
    if (source.kind === 'managed' && signal?.aborted) throw signal.reason;
    const bound = connect();
    const options: RequestOptions = signal ? { signal } : undefined;
    try {
      await verify(bound, options);
      const result = await read(bound.client, options);
      await verify(bound, options);
      return result;
    } catch (error) {
      if (source.kind === 'configured') throw error;
      if (options?.signal.aborted) throw options.signal.reason;
      throw error instanceof ReadAccessError ? new ReadAccessError(error.code, MANAGED_DIAGNOSIS[error.code]) : new Error(MANAGED_READ_FAILED);
    }
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
      const message = `Hive could not read session ${sessionID}: ${error instanceof Error ? error.message : String(error)}`;
      throw sessionAbsent(error) ? new SessionAbsentError(sessionID, unavailable, message) : new ReadAccessError(unavailable, message);
    }
    return answeredFor(session, sessionID) as unknown as SessionPlacement;
  };

  const classify = async (client: VerifiedClient, options: RequestOptions, caller: SessionPlacement, target: SessionPlacement): Promise<ObservedTargetCheck> => {
    const placement = target.location?.directory === directory ? 'this-location' : 'other-location';
    const observed = { ...(target.parentID === undefined ? {} : { parentID: target.parentID }), ...(target.location?.directory === undefined ? {} : { directory: target.location.directory }) };
    if (target.id === caller.id) return { relationship: 'self', placement, observed };
    if (target.parentID === caller.id) return { relationship: 'child', placement, observed };
    const seen = new Set([target.id]);
    let parentID = target.parentID;
    while (parentID !== undefined) {
      if (seen.has(parentID) || seen.size > MAX_LINEAGE_DEPTH) throw new ReadAccessError('inconsistent_lookup', `The parent chain of session ${target.id} is not a finite chain.`);
      seen.add(parentID);
      const parent = await getSession(client, options, parentID, 'target_unavailable');
      if (parent.parentID === caller.id) return { relationship: 'descendant', placement, observed };
      parentID = parent.parentID;
    }
    return { relationship: 'other', placement, observed };
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

  const settlement = async (client: VerifiedClient, options: RequestOptions, sessionID: string, parentID: string | undefined): Promise<ChildSettlement> => {
    if (parentID !== undefined) {
      const own = jobsFrom(await client.experimental.job.list({ sessionID: parentID, kind: 'subagent' }, options), 'the parent\'s subagent jobs');
      const ownJob = own.find((job) => job.id === sessionID || job.childSessionID === sessionID);
      if (ownJob) return pendingJob(ownJob, `the host's subagent job for child session ${sessionID}`);
    }
    const descendants = jobsFrom(await client.experimental.job.list({ sessionID, descendants: true }, options), `the jobs of session ${sessionID} and its descendants`);
    if (descendants.length > 0) return pendingJob(descendants[0]!, `${descendants[0]!.kind} job ${descendants[0]!.id} of session ${descendants[0]!.sessionID}`);
    // A session can hold queued input with no job and no execution (a prompt admitted without waking it), so every
    // session of the tree is read, not only the sessions jobs name.
    const tree = await sessionTree(client, options, sessionID);
    for (const member of tree) {
      const inbox = await client.session.inbox.list({ sessionID: member }, options);
      if (!Array.isArray(inbox)) throw new ReadAccessError('malformed_response', `The server answered the inbox of session ${member} with something other than a list.`);
      if (inbox.length > 0) return { settled: false, signal: 'inbox', detail: `session ${member} has ${inbox.length} queued inbox item(s)` };
    }
    const active = activeRecord(await client.session.active(options));
    for (const member of Object.keys(active)) {
      // A session created after the tree was read is still traced up its parent chain; one the server no longer has
      // (an ephemeral session removed meanwhile) holds no work. Any other failed read, including a gone ancestor of a
      // session that still exists, refuses the answer.
      if (tree.has(member) || await descendsFrom(client, options, member, sessionID).catch(skipAbsent(member, false))) {
        return { settled: false, signal: 'active', detail: member === sessionID ? `session ${sessionID} has an active execution` : `descendant session ${member} of ${sessionID} has an active execution` };
      }
    }
    return { settled: true };
  };

  const activity = async (client: VerifiedClient, options: RequestOptions, parentID: string): Promise<ParentActivity> => {
    const caller = await getSession(client, options, parentID, 'caller_unavailable');
    if (caller.location?.directory !== directory) throw new ReadAccessError('caller_displaced', `Caller session ${parentID} is in ${String(caller.location?.directory)}, not ${directory}.`);
    const jobs = jobsFrom(await client.experimental.job.list({ sessionID: parentID, descendants: true }, options), `the jobs of session ${parentID} and its descendants`);
    const active = activeRecord(await client.session.active(options));
    // Parent chains are read once per session; only sessions that own live work are traced.
    const parents = new Map<string, string | undefined>([[parentID, caller.parentID]]);
    const directChild = async (sessionID: string): Promise<string | undefined> => {
      const seen = new Set<string>();
      let current = sessionID;
      while (true) {
        if (seen.has(current) || seen.size > MAX_LINEAGE_DEPTH) throw new ReadAccessError('inconsistent_lookup', `The parent chain of session ${sessionID} is not a finite chain.`);
        seen.add(current);
        if (!parents.has(current)) parents.set(current, (await getSession(client, options, current, 'target_unavailable')).parentID);
        const parent = parents.get(current);
        if (parent === parentID) return current;
        if (parent === undefined) return undefined;
        current = parent;
      }
    };
    const children = new Map<string, { sessionID: string; jobs: ActivityJob[]; activeExecution: boolean }>();
    const entry = (sessionID: string) => children.get(sessionID) ?? children.set(sessionID, { sessionID, jobs: [], activeExecution: false }).get(sessionID)!;
    for (const job of jobs) {
      const summary = { kind: token(job.kind), status: token(job.status) };
      if (job.sessionID === parentID) {
        // The parent's own subagent job is its child's run; the parent's other jobs belong to no child.
        if (job.kind === 'subagent' && job.childSessionID !== undefined) entry(job.childSessionID).jobs.push({ ...summary, owner: 'parent' });
        continue;
      }
      const child = await directChild(job.sessionID);
      if (child !== undefined) entry(child).jobs.push({ ...summary, owner: job.sessionID === child ? 'child' : 'descendant' });
    }
    for (const sessionID of Object.keys(active)) {
      if (sessionID === parentID) continue;
      // An active session the server no longer has (an ephemeral session removed while it is traced) holds no work; any
      // other failed read, including a gone ancestor of a session that still exists, refuses the answer, so live work
      // is never hidden.
      const child = await directChild(sessionID).catch(skipAbsent(sessionID, undefined));
      if (child !== undefined) entry(child).activeExecution = true;
    }
    return { children: [...children.values()] };
  };

  /** Redacts a managed pending detail to its signal; an explicit `server` keeps its detail. */
  const redacted = (state: ChildSettlement): ChildSettlement => (!('signal' in state) || source.kind === 'configured')
    ? state
    : { settled: false, signal: state.signal, detail: MANAGED_PENDING[state.signal] };

  const sessionSettlement: VerifiedTreeReadAccess['sessionSettlement'] = async ({ sessionID, parentID }, signal) =>
    redacted(await verified((client, options) => settlement(client, options, sessionID, parentID), signal));

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
    sessionSettlement,
    childSettlement: ({ parentID, childID }, signal) => sessionSettlement({ sessionID: childID, parentID }, signal),
    parentActivity: ({ parentID }, signal) => verified((client, options) => activity(client, options, parentID), signal),
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

/** The active executions record, or a refusal: an unexpected answer is never read as no executions. */
function activeRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ReadAccessError('malformed_response', 'The server answered the active sessions with something other than a record.');
  return value as Record<string, unknown>;
}

/** A job kind or status as a short lowercase token; anything else is reported as `other`, never repeated. */
function token(value: string): string {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(value) ? value : 'other';
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

/** The managed client's fetch: a redirect is an error, so a request never leaves the validated loopback endpoint. */
const withoutRedirects = ((request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(request, { ...init, redirect: 'error' })) as typeof fetch;

/** The fields of an untrusted value; anything that is not an object has none. */
function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** The endpoint the `server` option names, with basic authentication when its password variable is set. */
function configuredEndpoint({ url, username, passwordEnv }: ReadServerOptions, env: Record<string, string | undefined>): Endpoint {
  const password = passwordEnv ? env[passwordEnv] : undefined;
  if (passwordEnv && !password) throw new ReadAccessError('not_configured', `The server password variable ${passwordEnv} is not set in the OpenCode server environment.`);
  return { url, ...(password ? { auth: { type: 'basic' as const, username, password } } : {}) };
}

/** A refusal of the managed service registration; `why` names the file and the problem, never its contents. */
function unusableRegistration(why: string): ReadAccessError {
  return new ReadAccessError('not_configured', `Session history reads need the oc-arkive \`server\` option (url and passwordEnv), or the managed local OpenCode service registered by the process running this plugin: ${why}`);
}

/**
 * The endpoint of the managed service registered in `file`, accepted only when this process (`pid`) registered it at a
 * numeric loopback http(s) URL. The file is untrusted: it is read once, bounded, and a refusal never repeats its
 * contents. Absence, a foreign process or any malformed field is `not_configured`; nothing here makes a request.
 */
function managedEndpoint(file: string, pid: number): Endpoint {
  let text: string;
  try {
    text = readRegistration(file);
  } catch (error) {
    if (error instanceof ReadAccessError) throw error;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw unusableRegistration(code === 'ENOENT' ? `no managed service is registered at ${file}.` : `its registration at ${file} could not be read (${code ?? 'read error'}).`);
  }
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    // Left undefined: refused below with every other value that is not a record.
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw unusableRegistration(`its registration at ${file} is not a JSON record.`);
  const { url, pid: registered, password } = record as Partial<Record<keyof Info, unknown>>;
  if (registered !== pid) throw unusableRegistration(`the registration at ${file} belongs to another process.`);
  if (password !== undefined && (typeof password !== 'string' || password === '')) throw unusableRegistration(`the registration at ${file} has an unusable password field.`);
  const origin = loopbackOrigin(url);
  if (origin === undefined) throw unusableRegistration(`the registration at ${file} does not name a numeric loopback http(s) URL without credentials, path, query or fragment.`);
  return { url: origin, ...(typeof password === 'string' ? { auth: { type: 'basic' as const, username: MANAGED_USERNAME, password } } : {}) };
}

/**
 * The text of the registration at `file`. It is opened without blocking and must be a regular file of at most
 * `MAX_REGISTRATION_BYTES`: a larger one, including one that grows while it is read, is refused rather than truncated.
 * The descriptor is always closed.
 */
function readRegistration(file: string): string {
  const fd = fs.openSync(file, REGISTRATION_OPEN_FLAGS);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw unusableRegistration(`its registration at ${file} is not a regular file.`);
    const tooLarge = () => unusableRegistration(`its registration at ${file} is larger than a registration.`);
    if (stat.size > MAX_REGISTRATION_BYTES) throw tooLarge();
    // One that grew past the bound since the stat fills the extra byte.
    const buffer = Buffer.alloc(MAX_REGISTRATION_BYTES + 1);
    let length = 0;
    for (let read; length < buffer.length && (read = fs.readSync(fd, buffer, length, buffer.length - length, length)) > 0;) length += read;
    if (length > MAX_REGISTRATION_BYTES) throw tooLarge();
    return buffer.toString('utf8', 0, length);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The canonical origin of `value` when it is an http(s) URL on a numeric loopback address (127.0.0.0/8 or [::1]) and
 * carries nothing else. A host name, even `localhost`, would need name resolution at the credential boundary.
 */
function loopbackOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[@?#]/.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/') return undefined;
  const loopback = url.hostname === '[::1]' || (isIPv4(url.hostname) && url.hostname.startsWith('127.'));
  return loopback ? url.origin : undefined;
}

/**
 * Names the binding failure from the official client's error: its declared `UnauthorizedError` and
 * `LocationNotFoundError` tags, an undeclared 401 status, and the RPC layer's `rpc.unavailable` type. Anything else is
 * a transport or server failure. The detailed diagnostic repeats only a string error or a string `message`, which is
 * whatever the client or the endpoint put there; any other value is replaced by local text and never converted. A
 * managed service's failure keeps only the code (see `MANAGED_DIAGNOSIS`).
 */
function classifyBindingFailure(error: unknown, url: string): ReadAccessError {
  const record = fields(error);
  const message = typeof error === 'string' ? error : typeof record.message === 'string' ? record.message : OPAQUE_VALUE;
  if (record._tag === 'LocationNotFoundError' || record.type === 'rpc.unavailable') return new ReadAccessError('wrong_location', `The server at ${url} has no oc-arkive activation for this location (${message}).`);
  const undeclared401 = error instanceof ClientError && error.reason === 'UnexpectedStatus' && fields(error.cause).status === 401;
  if (record._tag === 'UnauthorizedError' || undeclared401) return new ReadAccessError('unauthorized', `The server at ${url} rejected the configured credentials.`);
  return new ReadAccessError('unreachable', `The oc-arkive identity check against ${url} failed: ${message}`);
}

/** The parts of a native session record that relationship and placement checks read. */
type SessionPlacement = { id: string; parentID?: string; location?: { directory: string } };
