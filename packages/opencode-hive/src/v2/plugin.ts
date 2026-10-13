import { Effect } from 'effect';
import type { Scope } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import { createIdentity, registerIdentity, type Identity } from './identity.js';

// Each later owner adds its imports in its own block below and fills its own composition function. Keep the
// blocks separated by unchanged lines so sibling tasks merge without touching each other.

// catalog imports: tools, role policy, agents, commands, skills (read access and registration)
import { parseV2Options } from './options.js';
import { registerCatalog, type V2Catalog } from './registration.js';

// lifecycle imports: native dispatch and background observation

// evidence imports: forensic reads and semantic recovery

/**
 * Agents, skills, commands, the ordinary Hive tools, request-time instructions and execution guards. Invalid plugin
 * options stop activation with the option error rather than running with a guessed transport or server.
 */
function composeCatalog(context: Plugin.Context, identity: Identity): Effect.Effect<V2Catalog, never, Scope.Scope> {
  return Effect.suspend(() => registerCatalog({ context, identity, options: parseV2Options(context.options) }));
}

function composeLifecycle(_context: Plugin.Context, _identity: Identity, _catalog: V2Catalog): Effect.Effect<void, never, Scope.Scope> {
  return Effect.void;
}

function composeEvidence(_context: Plugin.Context, _identity: Identity, _catalog: V2Catalog): Effect.Effect<void, never, Scope.Scope> {
  return Effect.void;
}

/**
 * Activates the v2 adapter for one location. The catalog section is live; the lifecycle and evidence sections are
 * composed here by the tasks that own them, using the catalog's services, registrar, authority and read access.
 */
export function activate(context: Plugin.Context): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const identity = createIdentity();
    yield* registerIdentity(context, identity);

    const catalog = yield* composeCatalog(context, identity);

    yield* composeLifecycle(context, identity, catalog);

    yield* composeEvidence(context, identity, catalog);
  });
}
