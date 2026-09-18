import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import plugin from '../index.js';

let originalHome: string | undefined;
let root: string;
let home: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  root = fs.mkdtempSync(`/tmp/hive-sandbox-runtime-${process.pid}-`);
  home = fs.mkdtempSync(`/tmp/hive-sandbox-home-${process.pid}-`);
  process.env.HOME = home;
  fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

async function createHook(sandbox: 'none' | 'docker' = 'docker') {
  const configPath = path.join(home, '.config', 'opencode', 'agent_hive.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    sandbox,
    dockerImage: sandbox === 'docker' ? 'node:22-slim' : undefined,
    persistentContainers: false,
  }));
  const hooks = await plugin({
    directory: root,
    worktree: root,
    project: { id: 'sandbox-hook', worktree: root },
    client: { session: { get: async () => ({ data: undefined }), abort: async () => ({ data: true }) } },
  } as any);
  return hooks['tool.execute.before']!;
}

describe('tool.execute.before sandbox boundary', () => {
  it('wraps bash commands in Hive worktrees and clears the host workdir', async () => {
    const hook = await createHook();
    const workdir = path.join(root, '.hive', '.worktrees', 'feature-x', 'task-1');
    const output = { args: { command: 'bun test', workdir } };

    await hook({ tool: 'bash', sessionID: 'session', callID: 'call' } as any, output);

    expect(output.args.command).toContain('docker run');
    expect(output.args.command).toContain('node:22-slim');
    expect(output.args.command).toContain('bun test');
    expect(output.args.workdir).toBeUndefined();
  });

  it.each([
    ['without a workdir', undefined],
    ['outside a Hive worktree', '/tmp/outside'],
  ])('passes through bash commands %s', async (_name, workdir) => {
    const hook = await createHook();
    const output = { args: { command: 'git status', workdir } };

    await hook({ tool: 'bash', sessionID: 'session', callID: 'call' } as any, output);

    expect(output.args).toEqual({ command: 'git status', workdir });
  });

  it.each(['HOST: git status', 'host: git log'])('strips the HOST prefix without wrapping %s', async (command) => {
    const hook = await createHook();
    const workdir = path.join(root, '.hive', '.worktrees', 'feature-x', 'task-1');
    const output = { args: { command, workdir } };

    await hook({ tool: 'bash', sessionID: 'session', callID: 'call' } as any, output);

    expect(output.args.command).toBe(command.replace(/^HOST:\s*/i, ''));
    expect(output.args.workdir).toBe(workdir);
  });

  it('passes through bash commands when sandboxing is disabled', async () => {
    const hook = await createHook('none');
    const output = { args: { command: 'bun test', workdir: path.join(root, '.hive', '.worktrees', 'task') } };

    await hook({ tool: 'bash', sessionID: 'session', callID: 'call' } as any, output);

    expect(output.args.command).toBe('bun test');
    expect(output.args.workdir).toBe(path.join(root, '.hive', '.worktrees', 'task'));
  });

  it('passes through empty commands and non-bash tools', async () => {
    const hook = await createHook();
    const empty = { args: { command: '   ', workdir: path.join(root, '.hive', '.worktrees', 'task') } };
    const read = { args: { filePath: '/tmp/file' } };

    await hook({ tool: 'bash', sessionID: 'session', callID: 'empty' } as any, empty);
    await hook({ tool: 'read', sessionID: 'session', callID: 'read' } as any, read);

    expect(empty.args.command).toBe('   ');
    expect(empty.args.workdir).toBe(path.join(root, '.hive', '.worktrees', 'task'));
    expect(read.args).toEqual({ filePath: '/tmp/file' });
  });
});
