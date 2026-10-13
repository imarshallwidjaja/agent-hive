import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Effect, Scope, Stream } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import plugin from '../index.js';
import { IDENTITY_RPC_ID } from './identity.js';

type Registration = { definition: any; handlers: Record<string, (input: unknown) => Effect.Effect<any>> };

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Activation also composes the catalog and lifecycle; these stubs accept their registrations, which
// registration.test.ts and the dispatch/background suites pin.
const accept = () => Effect.succeed({ dispose: Effect.void });

function projectDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(`/tmp/hive-v2-plugin-project-${process.pid}-`));
  cleanup.push(dir);
  return dir;
}

function fakeContext(directory: string, projectDirectory = directory) {
  const registrations: Registration[] = [];
  const context = {
    location: { directory, project: { id: 'project', directory: projectDirectory, canonical: projectDirectory } },
    options: {},
    agent: { transform: accept },
    skill: { transform: accept },
    command: { transform: accept },
    tool: { transform: accept, hook: accept },
    session: { hook: accept },
    event: { subscribe: () => Stream.empty },
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
  const home = fs.mkdtempSync(`/tmp/hive-v2-plugin-home-${process.pid}-`);
  cleanup.push(home);
  const saved = { HOME: process.env.HOME, OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR };
  process.env.HOME = home;
  process.env.OPENCODE_CONFIG_DIR = path.join(home, '.config', 'opencode');
  try {
    const scope = Effect.runSync(Scope.make());
    await Effect.runPromise(plugin.effect(context).pipe(Scope.provide(scope)));
    return scope;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('v2 adapter activation', () => {
  it('registers the identity rpc on activation and answers with its own nonce and location', async () => {
    const directory = projectDir();
    const { context, registrations } = fakeContext(directory);
    await activate(context);
    expect(registrations).toHaveLength(1);
    expect(registrations[0].definition.id).toBe(IDENTITY_RPC_ID);
    const answer = await Effect.runPromise(registrations[0].handlers.get({ nonce: 'echoed-by-caller' }));
    expect(answer.directory).toBe(directory);
    expect(answer.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(answer.nonce).not.toBe('echoed-by-caller');
  });

  it('binds the identity to the exact activation directory, not the project checkout the host resolved for it', async () => {
    const project = projectDir();
    const directory = path.join(project, 'packages', 'app');
    fs.mkdirSync(directory, { recursive: true });
    const { context, registrations } = fakeContext(directory, project);
    await activate(context);
    expect((await Effect.runPromise(registrations[0].handlers.get({}))).directory).toBe(directory);
    expect(fs.existsSync(path.join(directory, '.hive'))).toBe(false);
  });

  it('gives every activation its own nonce', async () => {
    const directory = projectDir();
    const first = fakeContext(directory);
    const second = fakeContext(directory);
    await activate(first.context);
    await activate(second.context);
    const nonces = await Promise.all(
      [first, second].map(({ registrations }) => Effect.runPromise(registrations[0].handlers.get({}))),
    );
    expect(nonces[0].nonce).not.toBe(nonces[1].nonce);
  });
});
