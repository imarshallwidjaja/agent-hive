import { Effect } from 'effect';
import type { Scope } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import { createIdentity, registerIdentity, type Identity } from './identity.js';

// Each later owner adds its imports in its own block below and fills its own composition function. Keep the
// blocks separated by unchanged lines so sibling tasks merge without touching each other.

// catalog imports: tools, role policy, agents, commands, skills (read access and registration)

// lifecycle imports: native dispatch and background observation

// evidence imports: forensic reads and semantic recovery

function composeCatalog(_context: Plugin.Context, _identity: Identity): Effect.Effect<void, never, Scope.Scope> {
  return Effect.void;
}

function composeLifecycle(_context: Plugin.Context, _identity: Identity): Effect.Effect<void, never, Scope.Scope> {
  return Effect.void;
}

function composeEvidence(_context: Plugin.Context, _identity: Identity): Effect.Effect<void, never, Scope.Scope> {
  return Effect.void;
}

/**
 * Activates the v2 adapter for one location. Only the exact-instance identity is live so far; the remaining
 * sections are composed here by the tasks that own them.
 */
export function activate(context: Plugin.Context): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const identity = createIdentity();
    yield* registerIdentity(context, identity);

    yield* composeCatalog(context, identity);

    yield* composeLifecycle(context, identity);

    yield* composeEvidence(context, identity);
  });
}
