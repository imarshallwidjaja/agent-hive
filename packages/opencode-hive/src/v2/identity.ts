import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import { Rpc } from '@opencode/plugin/effect';
import type { Plugin } from '@opencode/plugin/effect';

/**
 * Location-scoped RPC that answers with this activation's own nonce. A client that holds the expected nonce
 * can tell this server and location apart from any other that happens to answer on the same URL. The answer
 * never includes caller input, so it cannot be echoed back as proof.
 */
export const IDENTITY_RPC_ID = 'oc-arkive.identity';

export const identityRpc = Rpc.define({
  id: IDENTITY_RPC_ID,
  methods: {
    get: {
      input: { type: 'object', additionalProperties: false },
      output: {
        type: 'object',
        properties: { nonce: { type: 'string' }, directory: { type: 'string' } },
        required: ['nonce', 'directory'],
        additionalProperties: false,
      },
    },
  },
  events: {},
});

export interface Identity {
  /** Held only by this activation and returned by its own RPC handler. */
  readonly nonce: string;
}

export function createIdentity(): Identity {
  return { nonce: randomUUID() };
}

export function registerIdentity(context: Plugin.Context, identity: Identity) {
  return context.rpc
    .register(identityRpc, {
      get: () => Effect.succeed({ nonce: identity.nonce, directory: context.location.directory }),
    })
    .pipe(Effect.asVoid, Effect.orDie);
}
