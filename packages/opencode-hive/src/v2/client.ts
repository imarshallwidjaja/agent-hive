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
 */

type RawClient = ReturnType<typeof OpenCode.make>;
type VerifiedClient = Pick<RawClient, 'rpc' | 'session' | 'message'>;

export type ReadAccessErrorCode =
  | 'not_configured' | 'unauthorized' | 'unreachable' | 'wrong_location' | 'wrong_instance'
  | 'caller_unavailable' | 'caller_displaced' | 'target_unavailable' | 'inconsistent_lookup';

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

export interface VerifiedReadAccess {
  sessionActive(): ReturnType<RawClient['session']['active']>;
  sessionGet(sessionID: string): ReturnType<RawClient['session']['get']>;
  messageList(input: Parameters<RawClient['message']['list']>[0]): ReturnType<RawClient['message']['list']>;
  /**
   * Classifies `targetID` against the caller. The caller is read from the server, not assumed from its ID: it must
   * exist, answer to that ID and still sit in this location. Every session read must answer to the ID asked for, the
   * lineage must be a finite chain, and the caller and target are read again before the answer is accepted. Callers
   * decide what each combination permits (other sessions stay inspect-only); a target in another location is
   * reported, never rerouted.
   */
  checkTarget(input: { callerID: string; targetID: string }): Promise<TargetCheck>;
}

type ClientFactory = (options: { baseUrl: string; headers: Record<string, string> }) => VerifiedClient;

/** Connection settings for the read-only public client, without host profile or Hive service types. */
export type ReadServerOptions = { url: string; username: string; passwordEnv?: string };

const MAX_LINEAGE_DEPTH = 32;

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

  const verify = async (client: VerifiedClient) => {
    let reply: { output?: unknown };
    try {
      reply = await client.rpc.call({ rpcID: IDENTITY_RPC_ID, method: 'get', location: { directory }, input: {} });
    } catch (error) {
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
  const verified = async <T>(read: (client: VerifiedClient) => Promise<T>): Promise<T> => {
    const client = connect();
    await verify(client);
    const result = await read(client);
    await verify(client);
    return result;
  };

  /** A session read must answer to the ID it was asked for. */
  const answeredFor = <T>(session: T, sessionID: string): T => {
    const answered = (session as SessionPlacement | undefined)?.id;
    if (answered !== sessionID) throw new ReadAccessError('inconsistent_lookup', `The server answered a lookup of session ${sessionID} with ${String(answered)}.`);
    return session;
  };

  const getSession = async (client: VerifiedClient, sessionID: string, unavailable: 'caller_unavailable' | 'target_unavailable') => {
    let session;
    try {
      session = await client.session.get({ sessionID } as Parameters<RawClient['session']['get']>[0]);
    } catch (error) {
      throw new ReadAccessError(unavailable, `Hive could not read session ${sessionID}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return answeredFor(session, sessionID) as unknown as SessionPlacement;
  };

  const classify = async (client: VerifiedClient, caller: SessionPlacement, target: SessionPlacement): Promise<TargetCheck> => {
    const placement = target.location?.directory === directory ? 'this-location' : 'other-location';
    if (target.id === caller.id) return { relationship: 'self', placement };
    if (target.parentID === caller.id) return { relationship: 'child', placement };
    const seen = new Set([target.id]);
    let parentID = target.parentID;
    while (parentID !== undefined) {
      if (seen.has(parentID) || seen.size > MAX_LINEAGE_DEPTH) throw new ReadAccessError('inconsistent_lookup', `The parent chain of session ${target.id} is not a finite chain.`);
      seen.add(parentID);
      const parent = await getSession(client, parentID, 'target_unavailable');
      if (parent.parentID === caller.id) return { relationship: 'descendant', placement };
      parentID = parent.parentID;
    }
    return { relationship: 'other', placement };
  };

  return {
    sessionActive: () => verified((client) => client.session.active()),
    sessionGet: (sessionID) => verified(async (client) => answeredFor(await client.session.get({ sessionID } as Parameters<RawClient['session']['get']>[0]), sessionID)),
    messageList: (request) => verified((client) => client.message.list(request)),
    checkTarget: ({ callerID, targetID }) => verified(async (client) => {
      const readCaller = async () => {
        const caller = await getSession(client, callerID, 'caller_unavailable');
        if (caller.location?.directory !== directory) throw new ReadAccessError('caller_displaced', `Caller session ${callerID} is in ${String(caller.location?.directory)}, not ${directory}.`);
        return caller;
      };
      const caller = await readCaller();
      const target = await getSession(client, targetID, 'target_unavailable');
      const check = await classify(client, caller, target);
      const [callerAgain, targetAgain] = [await readCaller(), await getSession(client, targetID, 'target_unavailable')];
      if (callerAgain.parentID !== caller.parentID || targetAgain.parentID !== target.parentID || targetAgain.location?.directory !== target.location?.directory) {
        throw new ReadAccessError('inconsistent_lookup', `Session ${callerID} or ${targetID} changed while its relationship was being checked.`);
      }
      return check;
    }),
  };
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
