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
import { registerBackground } from './background.js';
import { registerDispatch } from './dispatch.js';

// evidence imports: forensic reads and semantic recovery
import { registerEvidence } from './trace-source.js';

/**
 * Agents, skills, commands, the ordinary Hive tools, request-time instructions and execution guards. Invalid plugin
 * options stop activation with the option error rather than running with a guessed transport or server.
 */
function composeCatalog(context: Plugin.Context, identity: Identity): Effect.Effect<V2Catalog, never, Scope.Scope> {
  return Effect.suspend(() => registerCatalog({ context, identity, options: parseV2Options(context.options) }));
}

/**
 * Native subagent dispatch (route capture, prompt composition, the continuation preflight against the server's verified
 * settlement reads, and the child-binding barrier) and the live child tools (status and cancel), which read the host
 * when they are called. The host keeps scheduling, running and reporting jobs.
 */
function composeLifecycle(context: Plugin.Context, _identity: Identity, catalog: V2Catalog): Effect.Effect<void, never, Scope.Scope> {
  const { services, readAccess } = catalog;
  return Effect.gen(function* () {
    yield* registerDispatch({ context, services, authority: catalog.authority, activity: readAccess });
    yield* registerBackground({ context, registrar: catalog.registrar, services, readAccess });
  });
}

/** Session trace inspection and semantic recovery: both trace tools through the catalog registrar, read-only access. */
function composeEvidence(context: Plugin.Context, _identity: Identity, catalog: V2Catalog): Effect.Effect<void, never, Scope.Scope> {
  return registerEvidence(context, catalog);
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
