import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import plugin from '../index';
import { ConfigService } from 'hive-core';

const TEST_ROOT_BASE = '/tmp/hive-config-source-resolution-test';

type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  abort: AbortSignal;
};

function createToolContext(sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: 'msg_test',
    agent: 'test',
    abort: new AbortController().signal,
  };
}

function createProject(worktree: string) {
  return {
    id: 'test',
    worktree,
    time: { created: Date.now() },
  };
}

describe('plugin config source resolution', () => {
  let testRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'project-'));
    process.env.HOME = testRoot;

    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@example.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    fs.writeFileSync(path.join(testRoot, 'README.md'), 'config source test');
    execSync('git add README.md', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it('reports a global config failure', async () => {
    const globalConfigPath = path.join(testRoot, '.config', 'opencode', 'agent_hive.json');
    const overridePath = path.join(testRoot, '.hive', 'agent-hive.override.json');
    const warningMessage = `Failed to read global config at ${globalConfigPath}; using defaults. Failed to read project agent override at ${overridePath}; ignoring it and using defaults`;

    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(globalConfigPath, JSON.stringify({ agentMode: 'bogus' }));
    fs.mkdirSync(path.dirname(overridePath), { recursive: true });
    fs.writeFileSync(overridePath, JSON.stringify({ agents: { 'forager-worker': { temperature: 0.3 } } }));

    const notifications: Array<{ message: string }> = [];

    const ctx: any = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL('http://localhost:1'),
      project: createProject(testRoot),
      client: {
        notify(payload: { message: string }) {
          notifications.push({ message: payload.message });
          return true;
        },
      },
    };

    const hooks = await plugin(ctx);

    const toolContext = createToolContext('sess_config_resolution_defaults');
    await hooks.tool!.hive_feature_create.execute({ name: 'warning-defaults-feature' }, toolContext);

    const statusRaw = await hooks.tool!.hive_status.execute({ feature: 'warning-defaults-feature' }, toolContext);
    const hiveStatus = JSON.parse(statusRaw as string) as { warning?: string };

    expect(notifications.length).toBe(1);
    expect(notifications[0].message).toContain('[hive:config]');
    expect(hiveStatus.warning).toBe(warningMessage);
  });

  it('registers project model and variant overrides and uses the same values in the variant hook', async () => {
    const globalConfigPath = path.join(testRoot, '.config', 'opencode', 'agent_hive.json');
    const overridePath = path.join(testRoot, '.hive', 'agent-hive.override.json');
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(globalConfigPath, JSON.stringify({
      agents: {
        'forager-worker': { model: 'global/forager', variant: 'medium', temperature: 0.7 },
      },
      customAgents: {
        'forager-inherited': {
          baseAgent: 'forager-worker',
          description: 'Inherits the base agent model settings.',
        },
        'forager-direct': {
          baseAgent: 'forager-worker',
          description: 'Overrides the inherited variant.',
          model: 'global/custom-forager',
          variant: 'xhigh',
        },
      },
    }));
    fs.mkdirSync(path.dirname(overridePath), { recursive: true });
    fs.writeFileSync(overridePath, JSON.stringify({
      agents: { 'forager-worker': { model: ' project/forager ', variant: ' high ' } },
      customAgents: { 'forager-direct': { model: ' project/custom-forager ', variant: ' low ' } },
    }));

    const aliasRoot = path.join(TEST_ROOT_BASE, 'project-alias');
    fs.symlinkSync(testRoot, aliasRoot, 'dir');
    const ctx: any = {
      directory: aliasRoot,
      worktree: aliasRoot,
      serverUrl: new URL('http://localhost:1'),
      project: createProject(aliasRoot),
      client: { notify: () => true },
    };
    const hooks = await plugin(ctx);
    const opencodeConfig: any = { agent: { existing: { model: 'existing/model' } } };
    await hooks.config!(opencodeConfig);

    expect(opencodeConfig.agent['forager-worker']).toMatchObject({
      model: 'project/forager',
      variant: 'high',
      temperature: 0.7,
    });
    expect(opencodeConfig.agent['forager-inherited']).toMatchObject({
      model: 'project/forager',
      variant: 'high',
      temperature: 0.7,
    });
    expect(opencodeConfig.agent['forager-direct']).toMatchObject({
      model: 'project/custom-forager',
      variant: 'low',
      temperature: 0.7,
    });

    const output: any = { message: { agent: 'forager-direct' }, parts: [] };
    await hooks['chat.message']!({ sessionID: 'sess_project_agent_override', agent: 'forager-direct' } as any, output);
    expect(output.message.variant).toBe('low');
    expect(output.message.variant).toBe(opencodeConfig.agent['forager-direct'].variant);
  });

});
