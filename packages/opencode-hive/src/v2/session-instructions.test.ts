import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Effect, Scope } from 'effect';
import type { Plugin } from '@opencode/plugin/effect';
import { FeatureService, getNativeSessionsPath } from 'hive-core';
import { createHiveServices } from '../runtime/hive-services.js';
import { createHiveAuthority } from './registration.js';
import { HIVE_SESSION_INSTRUCTION_KEY, registerSessionInstructions } from './session-instructions.js';

// The session instruction entry is the host-stored carrier of a session's Hive route and standing constraints. These
// tests drive the registered hooks the way the host fires them: `prompt` before a turn, `fork` for a new fork, and
// `execute.after` after a tool call. The fake host keeps entries by session and key, and knows which sessions are
// children. Child entries are written by dispatch and pinned in dispatch.test.ts.

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(`/tmp/hive-v2-instructions-${process.pid}-`));
  cleanup.push(root);
  fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
  new FeatureService(root).create('alpha');
  const services = createHiveServices({ projectRoot: root, nativeObservationOwner: 'opencode-v2' });
  const entries = new Map<string, unknown>();
  const parents = new Map<string, string | undefined>([['primary', undefined], ['fork', undefined], ['child', 'primary']]);
  const state: { putFails?: Error; unreadableSessions?: Set<string> } = {};
  const hooks = new Map<string, (event: any) => Effect.Effect<void>>();
  const context = {
    session: {
      hook: (name: string, fn: any) => Effect.sync(() => { hooks.set(name, fn); return { dispose: Effect.void }; }),
      get: ({ sessionID }: { sessionID: string }) => state.unreadableSessions?.has(sessionID) || !parents.has(sessionID)
        ? Effect.fail(new Error(`unknown session ${sessionID}`))
        : Effect.succeed({ id: sessionID, parentID: parents.get(sessionID) }),
      instructions: {
        entry: {
          put: ({ sessionID, key, value }: { sessionID: string; key: string; value: unknown }) => Effect.suspend(() => {
            if (state.putFails) return Effect.fail(state.putFails);
            entries.set(`${sessionID}/${key}`, value);
            return Effect.void;
          }),
          remove: ({ sessionID, key }: { sessionID: string; key: string }) => Effect.sync(() => { entries.delete(`${sessionID}/${key}`); }),
        },
      },
    },
    tool: { hook: (name: string, fn: any) => Effect.sync(() => { hooks.set(name, fn); return { dispose: Effect.void }; }) },
  } as unknown as Plugin.Context;
  Effect.runSync(registerSessionInstructions({ context, services, authority: createHiveAuthority(context, {}) }).pipe(Scope.provide(Effect.runSync(Scope.make()))));
  const fire = (name: 'prompt' | 'fork' | 'execute.after', event: Record<string, unknown>) => Effect.runPromise(hooks.get(name)!(event));
  const entry = (sessionID: string) => entries.get(`${sessionID}/${HIVE_SESSION_INSTRUCTION_KEY}`);
  const toolCall = (sessionID: string, tool: string, status: 'completed' | 'error' = 'completed') =>
    fire('execute.after', { tool, sessionID, agent: 'swarm-orchestrator', status, input: {} });
  return { root, services, entries, state, fire, entry, toolCall };
}

describe('v2 session instruction entries', () => {
  it("writes a primary's selected route and verbatim standing constraints as readable text before its turn", async () => {
    const { root, services, fire, entry } = setup();
    services.sessionService.setFeatureRoute('primary', 'alpha');
    services.sessionService.addStandingConstraint('primary', 'Line one.\nLine two.');
    services.featureConstraintService.add('alpha', 'Public APIs only.');

    await fire('prompt', { sessionID: 'primary' });
    expect(entry('primary')).toBe([
      '## Hive route',
      `Route (JSON): {"projectRoot":"${root}","featureRoute":{"selected":true,"feature":"alpha"}}`,
      '',
      '## Standing Constraints',
      'Session constraints (revision 1):',
      'Line one.',
      'Line two.',
      '',
      'Feature constraints for "alpha" (revision 1):',
      'Public APIs only.',
      "Hive updates this entry when this session's route or standing constraints change. If directives conflict, report the conflict; runtime routing does not decide it.",
    ].join('\n'));
  });

  it('removes the entry of a primary with no selected route and no constraints, and of a fork that inherited one', async () => {
    const { services, entries, fire, entry } = setup();
    await fire('prompt', { sessionID: 'primary' });
    expect(entries.size).toBe(0);

    services.sessionService.addStandingConstraint('primary', 'Keep it small.');
    await fire('prompt', { sessionID: 'primary' });
    expect(entry('primary')).toContain('Keep it small.');
    // A fork starts with a copy of its parent's entry, but Hive holds no route or constraints for the fork.
    entries.set(`fork/${HIVE_SESSION_INSTRUCTION_KEY}`, entry('primary'));
    await fire('fork', { sessionID: 'fork' });
    expect(entry('fork')).toBeUndefined();
    expect(entry('primary')).toContain('Keep it small.');

    // Clearing the register clears the entry at the next prompt.
    const register = services.sessionService.readStandingConstraints('primary');
    services.sessionService.clearStandingConstraints('primary', register.revision);
    await fire('prompt', { sessionID: 'primary' });
    expect(entry('primary')).toBeUndefined();
  });

  it('keeps an entry for an explicit null route selection, set directly or after a feature', async () => {
    const { services, fire, entry, toolCall } = setup();
    services.sessionService.setFeatureRoute('primary', null);
    await fire('prompt', { sessionID: 'primary' });
    expect(entry('primary')).toContain('"featureRoute":{"selected":true,"feature":null}');

    services.sessionService.setFeatureRoute('fork', 'alpha');
    await toolCall('fork', 'hive_feature_select');
    expect(entry('fork')).toContain('"featureRoute":{"selected":true,"feature":"alpha"}');
    services.sessionService.setFeatureRoute('fork', null);
    await toolCall('fork', 'hive_feature_select');
    expect(entry('fork')).toContain('"featureRoute":{"selected":true,"feature":null}');
  });

  it('writes the sole live feature constraints for a primary or fork with no selected route and no session constraints', async () => {
    const { services, fire, entry } = setup();
    services.featureConstraintService.add('alpha', 'Public APIs only.');
    await fire('prompt', { sessionID: 'primary' });
    await fire('fork', { sessionID: 'fork' });
    for (const sessionID of ['primary', 'fork']) {
      expect(entry(sessionID), sessionID).toContain('"featureRoute":{"selected":false,"feature":"alpha"}');
      expect(entry(sessionID), sessionID).toContain('Feature constraints for "alpha" (revision 1):\nPublic APIs only.');
    }
  });

  it('updates a primary entry right after a completed route or constraint call, and ignores failed and unrelated calls', async () => {
    const { services, fire, entry, toolCall } = setup();
    await fire('prompt', { sessionID: 'primary' });
    services.sessionService.setFeatureRoute('primary', 'alpha');
    await toolCall('primary', 'hive_feature_select');
    expect(entry('primary')).toContain('"featureRoute":{"selected":true,"feature":"alpha"}');

    services.sessionService.addStandingConstraint('primary', 'Mid-session rule.');
    await toolCall('primary', 'hive_constraints_add', 'error');
    await toolCall('primary', 'hive_status');
    expect(entry('primary')).not.toContain('Mid-session rule.');
    await toolCall('primary', 'hive_constraints_add');
    expect(entry('primary')).toContain('Session constraints (revision 1):\nMid-session rule.');
  });

  it('leaves child sessions to their dispatch, and a session it cannot classify unchanged with one warning', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { services, entries, state, fire, entry, toolCall } = setup();
      entries.set(`child/${HIVE_SESSION_INSTRUCTION_KEY}`, 'dispatched entry');
      services.sessionService.addStandingConstraint('child', 'Not projected.');
      await fire('prompt', { sessionID: 'child' });
      await toolCall('child', 'hive_constraints_add');
      expect(entry('child')).toBe('dispatched entry');

      services.sessionService.addStandingConstraint('primary', 'Rule.');
      state.unreadableSessions = new Set(['primary']);
      await fire('prompt', { sessionID: 'primary' });
      await fire('prompt', { sessionID: 'primary' });
      expect(entry('primary')).toBeUndefined();
      expect(warn.mock.calls.filter(([message]) => String(message).startsWith('[hive:instructions]'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('never fails a turn when .hive is unreadable or the host refuses the write, and keeps the previous entry', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { root, services, state, fire, entry } = setup();
      services.sessionService.addStandingConstraint('primary', 'Before.');
      await fire('prompt', { sessionID: 'primary' });
      const before = entry('primary');

      services.sessionService.addStandingConstraint('primary', 'After.');
      state.putFails = new Error('entry store offline');
      await fire('prompt', { sessionID: 'primary' });
      state.putFails = undefined;
      fs.writeFileSync(getNativeSessionsPath(root, 'opencode-v2'), '{not json');
      await fire('prompt', { sessionID: 'primary' });
      await fire('fork', { sessionID: 'fork' });

      expect(entry('primary')).toBe(before);
      // The unreadable index is left as found.
      expect(fs.readFileSync(getNativeSessionsPath(root, 'opencode-v2'), 'utf8')).toBe('{not json');
      const messages = warn.mock.calls.map(([message]) => String(message));
      expect(messages.some((message) => message.includes('entry store offline'))).toBe(true);
      expect(messages.filter((message) => message.startsWith('[hive:instructions]')).length).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });
});
