import { Effect } from 'effect';
import type { Scope } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import type { RouteSnapshot } from '../runtime/hive-services.js';
import { CONSTRAINT_MUTATIONS, canonicalToolName } from '../runtime/role-policy.js';
import { routePayloadJson, standingConstraintsText, type ChildAssociation } from '../task-brief.js';
import type { HiveAuthority } from './registration.js';

/**
 * The session instruction entry that carries a session's Hive route and standing constraints. The host stores it
 * per session, keeps it in every request (ordinary turns and compaction alike), and adds a superseding notice when its
 * value changes, so a compacted or long session keeps the current route without Hive reading `.hive` per request.
 */
export const HIVE_SESSION_INSTRUCTION_KEY = 'hive.session';

/** Hive tools whose success changes the calling session's route or standing constraints. */
const ROUTE_CHANGING_TOOLS = new Set(['hive_feature_select', ...CONSTRAINT_MUTATIONS]);

const CONFLICT_RULE = 'If directives conflict, report the conflict; runtime routing does not decide it.';

/**
 * The entry text: the route, a bound child's task or run, and the standing constraints verbatim. It carries nothing
 * else: no Worklog text, task status, checkout, exploration or live child state.
 */
function renderSessionInstructions(snapshot: RouteSnapshot, child?: ChildAssociation): string {
  const binding = child?.taskFolder !== undefined
    ? [`Task: ${child.taskFolder}`]
    : child?.adHocRunId !== undefined ? [`Ad-hoc run: ${child.adHocRunId}`] : [];
  const provenance = child
    ? 'The parent session captured this route and these constraints when it dispatched or last continued this session.'
    : "Hive updates this entry when this session's route or standing constraints change.";
  return [
    '## Hive route',
    `Route (JSON): ${routePayloadJson(snapshot)}`,
    ...binding,
    '',
    '## Standing Constraints',
    standingConstraintsText(snapshot),
    `${provenance} ${CONFLICT_RULE}`,
  ].join('\n');
}

/** A session with no selected route and no standing constraints gets no entry. */
function hasProjection(snapshot: RouteSnapshot): boolean {
  return snapshot.hasFeatureRoute || snapshot.sessionConstraints.entries.length > 0 || (snapshot.featureConstraints?.entries.length ?? 0) > 0;
}

// A host whose entry API is missing or throws fails the write; it never crashes the turn.
const attempt = (write: () => Effect.Effect<void, unknown>) => Effect.suspend(write).pipe(Effect.catchDefect((defect) => Effect.fail(defect)));

function putEntry(context: Pick<Plugin.Context, 'session'>, sessionID: string, value: string): Effect.Effect<void, unknown> {
  return attempt(() => context.session.instructions.entry.put({ sessionID: sessionID as never, key: HIVE_SESSION_INSTRUCTION_KEY, value }));
}

/** Writes a dispatched child's captured route, constraints and binding. Fails, so the dispatch can refuse the child. */
export function writeChildSessionInstructions(context: Pick<Plugin.Context, 'session'>, child: string, snapshot: RouteSnapshot, association: ChildAssociation): Effect.Effect<void, unknown> {
  return putEntry(context, child, renderSessionInstructions(snapshot, association));
}

/**
 * Keeps primary sessions' entries current at the points where their route or constraints can change: each prompt
 * (covering changes another session or the VS Code extension made), each fork (whose copied entry belongs to its
 * parent), and each completed route or constraint tool call (so the next step already sees it). Child sessions are
 * left to the dispatch that bound them. Nothing here reads `.hive` during a model request, and no hook fails a turn.
 */
export function registerSessionInstructions(input: {
  context: Pick<Plugin.Context, 'session' | 'tool'>;
  services: { captureRoute(sessionID: string, options: { strict: boolean }): RouteSnapshot };
  authority: Pick<HiveAuthority, 'isChild'>;
}): Effect.Effect<void, never, Scope.Scope> {
  const { context, services, authority } = input;
  const warned = new Set<string>();
  // Writes the session's own route and constraints from `.hive`, or removes the entry when it has none, which also
  // clears an entry a fork inherited. Never fails: an unreadable `.hive` or a failed write leaves the entry as it was
  // and warns.
  const reconcile = (sessionID: string) => Effect.try({ try: () => services.captureRoute(sessionID, { strict: true }), catch: (error) => error }).pipe(
    Effect.flatMap((snapshot) => hasProjection(snapshot)
      ? putEntry(context, sessionID, renderSessionInstructions(snapshot))
      : attempt(() => context.session.instructions.entry.remove({ sessionID: sessionID as never, key: HIVE_SESSION_INSTRUCTION_KEY }))),
    Effect.catch((error: unknown) => Effect.sync(() => console.warn(`[hive:instructions] Hive could not update the route instructions of session ${sessionID} (${describe(error)}); the session keeps its previous entry.`))),
  );
  const reconcilePrimary = (sessionID: string) => authority.isChild(sessionID).pipe(
    Effect.flatMap((child) => child ? Effect.void : reconcile(sessionID)),
    Effect.catch((error: unknown) => Effect.sync(() => {
      if (warned.has(sessionID)) return;
      warned.add(sessionID);
      console.warn(`[hive:instructions] Hive could not read whether session ${sessionID} is a child (${describe(error)}), so it left its route instructions unchanged.`);
    })),
  );
  return Effect.all([
    context.session.hook('prompt', (event) => reconcilePrimary(event.sessionID)),
    context.session.hook('fork', (event) => reconcile(event.sessionID)),
    context.tool.hook('execute.after', (event) => event.status === 'completed' && ROUTE_CHANGING_TOOLS.has(canonicalToolName(event.tool))
      ? reconcilePrimary(event.sessionID)
      : Effect.void),
  ]).pipe(Effect.asVoid);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return String(error);
}
