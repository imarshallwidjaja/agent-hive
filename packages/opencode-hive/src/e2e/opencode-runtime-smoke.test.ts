import { afterAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import plugin from '../index.js';
import { SessionService } from 'hive-core';

const root = fs.mkdtempSync(`/tmp/hive-opencode-runtime-smoke-${process.pid}-`);
fs.mkdirSync(path.join(root, '.hive'), { recursive: true });

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('OpenCode runtime smoke', () => {
  it('loads the hard-cut runtime and snapshots an ordinary native child route', async () => {
    fs.writeFileSync(path.join(root, '.hive', 'execution-attempts.json'), '{ ignored legacy state');
    const sessions = new Map<string, { id: string; parentID?: string }>();
    const hooks = await plugin({
      directory: root,
      worktree: root,
      project: { id: 'runtime-smoke', worktree: root },
      client: {
        session: {
          get: async ({ path: inputPath }: { path: { id: string } }) => ({ data: sessions.get(inputPath.id) ?? { id: inputPath.id } }),
          abort: async () => ({ data: true }),
        },
      },
    } as any);
    const context = { sessionID: 'parent', messageID: 'message', agent: 'hive-master', abort: new AbortController().signal };
    await hooks.tool!.hive_feature_create.execute({ name: 'runtime-smoke' }, context);
    await hooks.tool!.hive_feature_select.execute({ feature: 'runtime-smoke' }, context);

    const output = { args: { subagent_type: 'forager-worker', description: 'Smoke', prompt: 'NATIVE_TASK_PREFIX', background: false } };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'parent', callID: 'call-smoke' } as any, output);
    expect(output.args.prompt.startsWith('NATIVE_TASK_PREFIX')).toBe(true);
    expect(output.args.prompt).toContain('"featureRoute":{"selected":true,"feature":"runtime-smoke"}');
    expect(output.args).not.toHaveProperty('hive_launch_id');

    sessions.set('child', { id: 'child', parentID: 'parent' });
    await hooks.event!({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: 'parent', callID: 'call-smoke', metadata: { sessionId: 'child' }, state: { input: output.args } } } } } as any);
    expect(new SessionService(root).getGlobal('child')).toMatchObject({ parentSessionId: 'parent', featureName: 'runtime-smoke' });
    expect(fs.readFileSync(path.join(root, '.hive', 'execution-attempts.json'), 'utf8')).toBe('{ ignored legacy state');
  });
});
