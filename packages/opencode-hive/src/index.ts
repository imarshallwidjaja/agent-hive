import { Effect } from 'effect';
import type { Scope } from 'effect';
import type { Plugin as V2Plugin } from '@opencode/plugin/effect';
import server from './runtime.js';

/**
 * The one module both OpenCode generations load. A v1 host reads `id` and `server`; a v2 host reads `id` and
 * `effect`. The v2 adapter is imported on first activation so a v1 host never evaluates it. Only `effect` is
 * imported eagerly, because the v2 entry has to return an Effect synchronously; the host supplies its own
 * instance under v2 and v1 only resolves the declared peer.
 */
export default {
  id: 'oc-arkive',
  server,
  effect: (context: V2Plugin.Context): Effect.Effect<void, never, Scope.Scope> =>
    Effect.suspend(() =>
      Effect.promise(() => import('./v2/plugin.js')).pipe(Effect.flatMap((adapter) => adapter.activate(context))),
    ),
};
