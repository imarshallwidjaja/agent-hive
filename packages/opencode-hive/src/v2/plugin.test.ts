import { describe, expect, it } from 'bun:test';
import { Effect, Scope } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import plugin from '../index.js';
import { IDENTITY_RPC_ID } from './identity.js';

type Registration = { definition: any; handlers: Record<string, (input: unknown) => Effect.Effect<any>> };

function fakeContext(directory: string) {
  const registrations: Registration[] = [];
  const context = {
    location: { directory },
    rpc: {
      register: (definition: any, handlers: any) =>
        Effect.sync(() => {
          registrations.push({ definition, handlers });
          return { dispose: Effect.void, events: { emit: () => Effect.void } };
        }),
    },
  } as unknown as Plugin.Context;
  return { context, registrations };
}

async function activate(context: Plugin.Context) {
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(plugin.effect(context).pipe(Scope.provide(scope)));
  return scope;
}

describe('v2 adapter activation', () => {
  it('registers the identity rpc on activation and answers with its own nonce and location', async () => {
    const { context, registrations } = fakeContext('/tmp/project-a');
    await activate(context);
    expect(registrations).toHaveLength(1);
    expect(registrations[0].definition.id).toBe(IDENTITY_RPC_ID);
    const answer = await Effect.runPromise(registrations[0].handlers.get({ nonce: 'echoed-by-caller' }));
    expect(answer.directory).toBe('/tmp/project-a');
    expect(answer.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(answer.nonce).not.toBe('echoed-by-caller');
  });

  it('gives every activation its own nonce', async () => {
    const first = fakeContext('/tmp/project');
    const second = fakeContext('/tmp/project');
    await activate(first.context);
    await activate(second.context);
    const nonces = await Promise.all(
      [first, second].map(({ registrations }) => Effect.runPromise(registrations[0].handlers.get({}))),
    );
    expect(nonces[0].nonce).not.toBe(nonces[1].nonce);
  });
});
