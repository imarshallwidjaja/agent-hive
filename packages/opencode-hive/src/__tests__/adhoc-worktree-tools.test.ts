import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { AdhocWorktreeService, ExecutionAttemptService } from 'hive-core';
import plugin from '../index.js';

const TEST_ROOT = `/tmp/opencode-hive-execution-prepare-${process.pid}`;
const CLIENT = createOpencodeClient({ baseUrl: 'http://localhost:1' }) as unknown as PluginInput['client'];

function shell(): PluginInput['$'] {
  let value: PluginInput['$'];
  const fn = (() => { throw new Error('shell unavailable'); }) as unknown as PluginInput['$'];
  value = Object.assign(fn, {
    braces: (pattern: string) => [pattern],
    escape: (input: string) => input,
    env: () => value,
    cwd: () => value,
    nothrow: () => value,
    throws: () => value,
  });
  return value;
}

async function hooksFor(root: string, sessionID: string) {
  const client = {
    ...(CLIENT as any),
    session: {
      ...(CLIENT as any).session,
      get: async ({ path: inputPath }: { path: { id: string } }) => ({
        data: { id: inputPath.id, parentID: undefined, time: { created: Date.now(), updated: Date.now() } },
      }),
    },
  } as PluginInput['client'];
  const hooks = await plugin({
    directory: root,
    worktree: root,
    serverUrl: new URL('http://localhost:1'),
    project: { id: 'test', worktree: root, time: { created: Date.now() } },
    client,
    $: shell(),
  });
  await hooks['chat.message']?.({ sessionID, agent: 'hive-master' }, {
    message: { agent: 'hive-master' }, parts: [],
  } as any);
  return {
    hooks,
    context: {
      sessionID,
      messageID: 'message',
      agent: 'hive-master',
      abort: new AbortController().signal,
    },
  };
}

function initGit(root: string): void {
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email test@example.com', { cwd: root });
  execSync('git config user.name Test', { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'test\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.hive/\n');
  execSync('git add README.md .gitignore && git commit -m init', { cwd: root, stdio: 'ignore' });
}

function initCompositeRepositories(root: string): { api: string; web: string } {
  const api = path.join(root, 'api');
  const web = path.join(root, 'web');
  fs.mkdirSync(api);
  fs.mkdirSync(web);
  initGit(api);
  initGit(web);
  fs.mkdirSync(path.join(root, '.hive'));
  fs.writeFileSync(path.join(root, '.hive', 'repositories.json'), JSON.stringify({
    schemaVersion: 1,
    repositories: [
      { id: 'api', path: './api' },
      { id: 'web', path: './web' },
    ],
  }));
  return { api, web };
}

describe('hive_execution_prepare ad-hoc placement', () => {
  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

  it('creates and arms a Git worktree without generating native task arguments', async () => {
    initGit(TEST_ROOT);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-worktree');
    const result = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'run-worktree' },
      placement: { kind: 'worktree' },
    }, context) as string);

    expect(result).toMatchObject({
      success: true,
      scope: { kind: 'adhoc', runId: 'run-worktree' },
      placement: { kind: 'worktree' },
      phase: 'armed',
    });
    expect(result.attemptId).toEqual(expect.any(String));
    expect(result.expiresAt).toEqual(expect.any(String));
    expect(result).not.toHaveProperty('taskToolCall');
    expect(result).not.toHaveProperty('backgroundTaskCall');
    expect(result).not.toHaveProperty('launchId');
  });

  it('arms an explicit live non-Git directory without creating an exclusion claim', async () => {
    const liveDirectory = path.join(TEST_ROOT, 'live');
    fs.mkdirSync(liveDirectory);
    const first = await hooksFor(TEST_ROOT, 'primary-a');
    const second = await hooksFor(TEST_ROOT, 'primary-b');

    const firstResult = JSON.parse(await first.hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'live-a' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, first.context) as string);
    const secondResult = JSON.parse(await second.hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'live-b' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, second.context) as string);

    expect(firstResult.placement).toEqual({ kind: 'in_place', directory: fs.realpathSync(liveDirectory) });
    expect(secondResult.success).toBe(true);
  });

  it('refuses a second outstanding arm before creating its worktree resources', async () => {
    initGit(TEST_ROOT);
    const liveDirectory = path.join(TEST_ROOT, 'live');
    fs.mkdirSync(liveDirectory);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-one-arm');
    await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'first' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, context);

    const branchesBefore = execSync('git branch --format="%(refname:short)"', { cwd: TEST_ROOT, encoding: 'utf8' });
    const worktreesBefore = execSync('git worktree list --porcelain', { cwd: TEST_ROOT, encoding: 'utf8' });

    await expect(hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'second' },
      placement: { kind: 'worktree' },
    }, context)).rejects.toThrow(/already has an armed execution/i);

    const adhocWorktrees = new AdhocWorktreeService({
      baseDir: TEST_ROOT,
      hiveDir: path.join(TEST_ROOT, '.hive'),
      repositoryResolver: { resolveRepositories: () => [] },
    });
    expect(await adhocWorktrees.get('second')).toBeNull();
    expect(execSync('git branch --format="%(refname:short)"', { cwd: TEST_ROOT, encoding: 'utf8' })).toBe(branchesBefore);
    expect(execSync('git worktree list --porcelain', { cwd: TEST_ROOT, encoding: 'utf8' })).toBe(worktreesBefore);
    expect(new ExecutionAttemptService(TEST_ROOT).listAttempts()).toHaveLength(1);
  });

  it('denies another primary before creating Git resources for the same armed scope', async () => {
    initGit(TEST_ROOT);
    const liveDirectory = path.join(TEST_ROOT, 'live');
    fs.mkdirSync(liveDirectory);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-owner');
    await hooks['chat.message']?.({ sessionID: 'primary-other', agent: 'hive-master' }, {
      message: { agent: 'hive-master' }, parts: [],
    } as any);
    const otherContext = { ...context, sessionID: 'primary-other' };
    const first = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'owned-scope' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, context) as string);
    const repeated = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'owned-scope' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, context) as string);
    expect(repeated).toMatchObject({ success: true, existing: true, attemptId: first.attemptId });

    const mismatched = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'owned-scope' },
      placement: { kind: 'worktree' },
    }, context) as string);
    expect(mismatched).toMatchObject({
      success: false,
      reason: 'workspace_conflict_denied',
      mutation: 'none',
      attemptId: first.attemptId,
      phase: 'armed',
    });

    const branchesBefore = execSync('git branch --format="%(refname:short)"', { cwd: TEST_ROOT, encoding: 'utf8' });
    const worktreesBefore = execSync('git worktree list --porcelain', { cwd: TEST_ROOT, encoding: 'utf8' });
    const attemptsPath = path.join(TEST_ROOT, '.hive', 'execution-attempts.json');
    const attemptsBefore = fs.readFileSync(attemptsPath, 'utf8');

    const denied = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'owned-scope' },
      placement: { kind: 'worktree' },
    }, otherContext) as string);
    expect(denied).toMatchObject({
      success: false,
      reason: 'workspace_conflict_denied',
      attemptId: first.attemptId,
      phase: 'armed',
    });
    expect(execSync('git branch --format="%(refname:short)"', { cwd: TEST_ROOT, encoding: 'utf8' })).toBe(branchesBefore);
    expect(execSync('git worktree list --porcelain', { cwd: TEST_ROOT, encoding: 'utf8' })).toBe(worktreesBefore);
    expect(fs.readFileSync(attemptsPath, 'utf8')).toBe(attemptsBefore);
    expect(await new AdhocWorktreeService({
      baseDir: TEST_ROOT,
      hiveDir: path.join(TEST_ROOT, '.hive'),
      repositoryResolver: { resolveRepositories: () => [] },
    }).get('owned-scope')).toBeNull();
  });

  it('reuses an exact composite selection and rejects a different repository without mutation', async () => {
    const repositories = initCompositeRepositories(TEST_ROOT);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-composite-reuse');
    const first = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'selected-repository' },
      placement: { kind: 'worktree', repoIds: ['api'] },
    }, context) as string);
    const repeated = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'selected-repository' },
      placement: { kind: 'worktree', repoIds: ['api'] },
    }, context) as string);
    expect(repeated).toMatchObject({ success: true, existing: true, attemptId: first.attemptId });

    const branchesBefore = Object.fromEntries(Object.entries(repositories).map(([id, repository]) => [
      id,
      execSync('git branch --format="%(refname:short)"', { cwd: repository, encoding: 'utf8' }),
    ]));
    const worktreesBefore = Object.fromEntries(Object.entries(repositories).map(([id, repository]) => [
      id,
      execSync('git worktree list --porcelain', { cwd: repository, encoding: 'utf8' }),
    ]));
    const attemptsPath = path.join(TEST_ROOT, '.hive', 'execution-attempts.json');
    const attemptsBefore = fs.readFileSync(attemptsPath, 'utf8');
    const workspaceManifest = path.join(first.placement.workspacePath, 'workspace.json');
    const workspaceManifestBefore = fs.readFileSync(workspaceManifest, 'utf8');

    const denied = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'selected-repository' },
      placement: { kind: 'worktree', repoIds: ['web'] },
    }, context) as string);

    expect(denied).toMatchObject({
      success: false,
      reason: 'workspace_conflict_denied',
      mutation: 'none',
      attemptId: first.attemptId,
      phase: 'armed',
    });
    for (const [id, repository] of Object.entries(repositories)) {
      expect(execSync('git branch --format="%(refname:short)"', { cwd: repository, encoding: 'utf8' })).toBe(branchesBefore[id]);
      expect(execSync('git worktree list --porcelain', { cwd: repository, encoding: 'utf8' })).toBe(worktreesBefore[id]);
    }
    expect(fs.readFileSync(attemptsPath, 'utf8')).toBe(attemptsBefore);
    expect(fs.readFileSync(workspaceManifest, 'utf8')).toBe(workspaceManifestBefore);
    expect(fs.existsSync(path.join(first.placement.workspacePath, 'repos', 'web'))).toBe(false);
  });

  it('removes a newly created rejected placement despite unrelated finalized history', async () => {
    initGit(TEST_ROOT);
    const liveDirectory = path.join(TEST_ROOT, 'live');
    fs.mkdirSync(liveDirectory);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-race-loser');
    const branchesBefore = execSync('git branch --format="%(refname:short)"', { cwd: TEST_ROOT, encoding: 'utf8' });
    const worktreesBefore = execSync('git worktree list --porcelain', { cwd: TEST_ROOT, encoding: 'utf8' });
    const originalArm = ExecutionAttemptService.prototype.arm;
    let injected = false;
    const arm = spyOn(ExecutionAttemptService.prototype, 'arm').mockImplementation(function (input) {
      if (!injected && input.originatingPrimarySession === 'primary-race-loser') {
        injected = true;
        const history = originalArm.call(this, {
          kind: 'adhoc',
          runId: 'unrelated-history',
          originatingPrimarySession: 'primary-history',
          placement: input.placement,
        }).attempt;
        this.closeArmNotStarted(history.id);
        originalArm.call(this, {
          kind: 'adhoc',
          runId: 'race-cleanup',
          originatingPrimarySession: 'primary-race-winner',
          placement: { kind: 'in_place', directory: liveDirectory },
        });
      }
      return originalArm.call(this, input);
    });
    try {
      const denied = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
        scope: { kind: 'adhoc', runId: 'race-cleanup' },
        placement: { kind: 'worktree' },
      }, context) as string);

      expect(denied).toMatchObject({ success: false, reason: 'workspace_conflict_denied', mutation: 'none' });
      expect(execSync('git branch --format="%(refname:short)"', { cwd: TEST_ROOT, encoding: 'utf8' })).toBe(branchesBefore);
      expect(execSync('git worktree list --porcelain', { cwd: TEST_ROOT, encoding: 'utf8' })).toBe(worktreesBefore);
      const attempts = JSON.parse(fs.readFileSync(path.join(TEST_ROOT, '.hive', 'execution-attempts.json'), 'utf8')).attempts;
      expect(attempts).toHaveLength(2);
      expect(attempts).toContainEqual(expect.objectContaining({
        originatingPrimarySession: 'primary-race-winner',
        placement: { kind: 'in_place', directory: fs.realpathSync(liveDirectory) },
        phase: 'armed',
      }));
      expect(attempts).toContainEqual(expect.objectContaining({
        originatingPrimarySession: 'primary-history',
        phase: 'finalized',
        observedOutcome: 'not_started',
      }));
    } finally {
      arm.mockRestore();
    }
  });

  it('removes a same-parent worktree that loses to an in-place arm for the same run', async () => {
    initGit(TEST_ROOT);
    const liveDirectory = path.join(TEST_ROOT, 'live');
    fs.mkdirSync(liveDirectory);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-same-run-race');
    const branchesBefore = execSync('git branch --format="%(refname:short)"', { cwd: TEST_ROOT, encoding: 'utf8' });
    const worktreesBefore = execSync('git worktree list --porcelain', { cwd: TEST_ROOT, encoding: 'utf8' });
    const originalArm = ExecutionAttemptService.prototype.arm;
    let winnerId: string | undefined;
    const arm = spyOn(ExecutionAttemptService.prototype, 'arm').mockImplementation(function (input) {
      if (!winnerId && input.originatingPrimarySession === 'primary-same-run-race') {
        winnerId = originalArm.call(this, {
          ...input,
          placement: { kind: 'in_place', directory: liveDirectory },
        }).attempt.id;
      }
      return originalArm.call(this, input);
    });

    try {
      const denied = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
        scope: { kind: 'adhoc', runId: 'same-run-race' },
        placement: { kind: 'worktree' },
      }, context) as string);

      expect(denied).toMatchObject({
        success: false,
        reason: 'workspace_conflict_denied',
        mutation: 'none',
        attemptId: winnerId,
      });
      expect(execSync('git branch --format="%(refname:short)"', { cwd: TEST_ROOT, encoding: 'utf8' })).toBe(branchesBefore);
      expect(execSync('git worktree list --porcelain', { cwd: TEST_ROOT, encoding: 'utf8' })).toBe(worktreesBefore);
      expect(await new AdhocWorktreeService({
        baseDir: TEST_ROOT,
        hiveDir: path.join(TEST_ROOT, '.hive'),
        repositoryResolver: { resolveRepositories: () => [] },
      }).get('same-run-race')).toBeNull();
      const winner = JSON.parse(fs.readFileSync(path.join(TEST_ROOT, '.hive', 'execution-attempts.json'), 'utf8'))
        .attempts.find((attempt: { id: string }) => attempt.id === winnerId);
      expect(winner).toMatchObject({
        phase: 'armed',
        placement: { kind: 'in_place', directory: fs.realpathSync(liveDirectory) },
      });
    } finally {
      arm.mockRestore();
    }
  });

  it('preserves a winning ad-hoc placement when the winner finalizes before loser cleanup', async () => {
    initGit(TEST_ROOT);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-claimed-loser');
    const originalArm = ExecutionAttemptService.prototype.arm;
    const originalReserve = ExecutionAttemptService.prototype.reserveWorkspaceCleanup;
    let injected = false;
    let winnerId: string | undefined;
    const arm = spyOn(ExecutionAttemptService.prototype, 'arm').mockImplementation(function (input) {
      if (!injected && input.originatingPrimarySession === 'primary-claimed-loser') {
        injected = true;
        winnerId = originalArm.call(this, { ...input, originatingPrimarySession: 'primary-claimed-winner' }).attempt.id;
      }
      return originalArm.call(this, input);
    });
    const reserve = spyOn(ExecutionAttemptService.prototype, 'reserveWorkspaceCleanup').mockImplementation(function (identities, protectedAttemptId) {
      if (!winnerId) throw new Error('Expected injected winner');
      this.closeArmNotStarted(winnerId);
      return originalReserve.call(this, identities, protectedAttemptId);
    });
    try {
      const denied = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
        scope: { kind: 'adhoc', runId: 'race-claimed' },
        placement: { kind: 'worktree' },
      }, context) as string);

      expect(denied).toMatchObject({ success: false, reason: 'workspace_conflict_denied', mutation: 'none' });
      expect(denied.attemptId).toEqual(expect.any(String));
      expect(execSync('git branch --format="%(refname:short)"', { cwd: TEST_ROOT, encoding: 'utf8' })).toContain('hive/adhoc/race-claimed');
      expect(execSync('git worktree list --porcelain', { cwd: TEST_ROOT, encoding: 'utf8' })).toContain('.hive/.worktrees/adhoc/race-claimed');
      const attempts = JSON.parse(fs.readFileSync(path.join(TEST_ROOT, '.hive', 'execution-attempts.json'), 'utf8')).attempts;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        id: denied.attemptId,
        originatingPrimarySession: 'primary-claimed-winner',
        placement: { kind: 'worktree' },
        phase: 'finalized',
        observedOutcome: 'not_started',
      });
    } finally {
      reserve.mockRestore();
      arm.mockRestore();
    }
  });

  it('finalizes stopped ad-hoc work only from the originating primary', async () => {
    initGit(TEST_ROOT);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-finalize');
    const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'primary-finalize' },
      placement: { kind: 'worktree' },
    }, context) as string);
    const args = { subagent_type: 'forager-worker', description: 'Edit worktree', prompt: 'Do it.', background: false };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: context.sessionID, callID: 'call-finalize' }, { args });
    fs.writeFileSync(path.join(prepared.placement.workspacePath, 'finalized.txt'), 'finalized\n');

    const active = JSON.parse(await hooks.tool!.hive_execution_finish.execute({
      attemptId: prepared.attemptId,
      status: 'completed',
      summary: 'Complete.',
      message: 'test: finalize ad-hoc execution\n\nCommit only after exact native stop evidence.',
    }, context) as string);
    expect(active).toMatchObject({ success: false, reason: 'execution_finalization_failed', phase: 'attached' });

    new ExecutionAttemptService(TEST_ROOT).observeBlockingStop({
      originatingPrimarySession: context.sessionID,
      nativeCallId: 'call-finalize',
      outputDefined: true,
    });
    const worker = JSON.parse(await hooks.tool!.hive_execution_finish.execute({
      attemptId: prepared.attemptId,
      status: 'completed',
      summary: 'Complete.',
      message: 'test: finalize ad-hoc execution\n\nCommit only after exact native stop evidence.',
    }, { ...context, sessionID: 'worker-finalize', agent: 'forager-worker' }) as string);
    expect(worker).toMatchObject({ success: false, reason: 'primary_required' });

    const finalized = JSON.parse(await hooks.tool!.hive_execution_finish.execute({
      attemptId: prepared.attemptId,
      status: 'completed',
      summary: 'Complete.',
      message: 'test: finalize ad-hoc execution\n\nCommit only after exact native stop evidence.',
    }, context) as string);
    expect(finalized).toMatchObject({ success: true, phase: 'finalized', status: 'completed' });
    expect(new ExecutionAttemptService(TEST_ROOT).getAttempt(prepared.attemptId)).toMatchObject({
      phase: 'finalized',
      finalization: { repositories: [{ id: 'root', result: 'committed' }] },
    });
  });

  it('rejects second-repository branch and manifest tampering before any ad-hoc finalization commit', async () => {
    const repositories = initCompositeRepositories(TEST_ROOT);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-composite-tamper');
    const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'composite-tamper' },
      placement: { kind: 'worktree', repoIds: ['api', 'web'] },
    }, context) as string);
    expect(prepared.placement.repositories.map((repository: { id: string }) => repository.id)).toEqual(['api', 'web']);
    const args = { subagent_type: 'forager-worker', description: 'Edit composite worktree', prompt: 'Do it.' };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: context.sessionID, callID: 'call-composite-tamper' }, { args });
    new ExecutionAttemptService(TEST_ROOT).observeBlockingStop({
      originatingPrimarySession: context.sessionID,
      nativeCallId: 'call-composite-tamper',
      outputDefined: true,
    });
    const webWorktree = prepared.placement.repositories[1].path;
    fs.writeFileSync(path.join(prepared.placement.repositories[0].path, 'api.txt'), 'api\n');
    fs.writeFileSync(path.join(webWorktree, 'web.txt'), 'web\n');
    execSync('git checkout -b tampered-web-branch', { cwd: webWorktree });
    const manifestPath = path.join(prepared.placement.workspacePath, 'workspace.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.repos.web.branch = 'tampered-web-branch';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const finalized = JSON.parse(await hooks.tool!.hive_execution_finish.execute({
      attemptId: prepared.attemptId,
      status: 'completed',
      summary: 'Must reject tampered composite identity.',
      message: 'test: reject composite tamper\n\nBind every repository branch to the armed placement.',
    }, context) as string);
    expect(finalized).toMatchObject({ success: false, reason: 'execution_finalization_failed', phase: 'stopped' });
    expect(execSync('git log --oneline', { cwd: repositories.api, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
    expect(execSync('git log --oneline', { cwd: repositories.web, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
  });

  it('rejects ad-hoc merge when the source HEAD moves after finalization', async () => {
    initGit(TEST_ROOT);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-head-drift');
    const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'head-drift' }, placement: { kind: 'worktree' },
    }, context) as string);
    const args = { subagent_type: 'forager-worker', description: 'Edit worktree', prompt: 'Do it.' };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: context.sessionID, callID: 'call-head-drift' }, { args });
    fs.writeFileSync(path.join(prepared.placement.workspacePath, 'intended.txt'), 'intended\n');
    new ExecutionAttemptService(TEST_ROOT).observeBlockingStop({
      originatingPrimarySession: context.sessionID, nativeCallId: 'call-head-drift', outputDefined: true,
    });
    expect(JSON.parse(await hooks.tool!.hive_execution_finish.execute({
      attemptId: prepared.attemptId,
      status: 'completed',
      summary: 'Finalize exact HEAD.',
      message: 'test: finalize exact head\n\nRecord the source HEAD accepted for integration.',
    }, context) as string).success).toBe(true);
    fs.writeFileSync(path.join(prepared.placement.workspacePath, 'drift.txt'), 'drift\n');
    execSync('git add drift.txt && git commit -m "test: post-finalization drift"', { cwd: prepared.placement.workspacePath });
    const targetHead = execSync('git rev-parse HEAD', { cwd: TEST_ROOT, encoding: 'utf8' }).trim();

    const merged = JSON.parse(await hooks.tool!.hive_adhoc_merge.execute({
      runId: 'head-drift', message: 'test: forbidden drift merge\n\nReject source history outside finalization.',
    }, context) as string);
    expect(merged).toMatchObject({ success: false, reason: 'adhoc_merge_failed' });
    expect(execSync('git rev-parse HEAD', { cwd: TEST_ROOT, encoding: 'utf8' }).trim()).toBe(targetHead);
  });

  it.each(['merge', 'cleanup'] as const)(
    'leaves a newer ad-hoc in-place arm and stale worktree untouched during a stale %s race',
    async (operation) => {
      initGit(TEST_ROOT);
      const liveDirectory = path.join(TEST_ROOT, `live-${operation}-race`);
      fs.mkdirSync(liveDirectory);
      const { hooks, context } = await hooksFor(TEST_ROOT, `primary-${operation}-race`);
      const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
        scope: { kind: 'adhoc', runId: `${operation}-race` }, placement: { kind: 'worktree' },
      }, context) as string);
      const args = { subagent_type: 'forager-worker', description: 'Edit worktree', prompt: 'Do it.' };
      await hooks['tool.execute.before']!({ tool: 'task', sessionID: context.sessionID, callID: `call-${operation}-race` }, { args });
      fs.writeFileSync(path.join(prepared.placement.workspacePath, 'intended.txt'), 'intended\n');
      new ExecutionAttemptService(TEST_ROOT).observeBlockingStop({
        originatingPrimarySession: context.sessionID, nativeCallId: `call-${operation}-race`, outputDefined: true,
      });
      expect(JSON.parse(await hooks.tool!.hive_execution_finish.execute({
        attemptId: prepared.attemptId,
        status: 'completed',
        summary: 'Finalize stale worktree.',
        message: 'test: finalize stale worktree\n\nCreate the source receipt before the race.',
      }, context) as string).success).toBe(true);

      const originalGet = AdhocWorktreeService.prototype.get;
      let calls = 0;
      let release!: () => void;
      let entered!: () => void;
      const paused = new Promise<void>(resolve => { release = resolve; });
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const get = spyOn(AdhocWorktreeService.prototype, 'get').mockImplementation(async function (runId) {
        calls += 1;
        if (runId === `${operation}-race` && calls === 2) {
          entered();
          await paused;
        }
        return originalGet.call(this, runId);
      });
      try {
        const staleOperation = operation === 'merge'
          ? hooks.tool!.hive_adhoc_merge.execute({
              runId: `${operation}-race`,
              message: 'test: stale integration\n\nThis integration must be rejected.',
            }, context)
          : hooks.tool!.hive_adhoc_cleanup.execute({ runId: `${operation}-race`, deleteBranch: true }, context);
        await enteredPromise;
        const newer = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
          scope: { kind: 'adhoc', runId: `${operation}-race` },
          placement: { kind: 'in_place', directory: liveDirectory },
        }, context) as string);
        release();
        const staleResult = JSON.parse(await staleOperation as string);

        expect(staleResult.success).toBe(false);
        const persisted = JSON.parse(fs.readFileSync(path.join(TEST_ROOT, '.hive', 'execution-attempts.json'), 'utf8'));
        expect(persisted.attempts.find((attempt: { id: string }) => attempt.id === newer.attemptId)).toMatchObject({
          phase: 'armed', placement: { kind: 'in_place', directory: fs.realpathSync(liveDirectory) },
        });
        expect(fs.existsSync(prepared.placement.workspacePath)).toBe(true);
        expect(execSync('git branch --format="%(refname:short)"', { cwd: TEST_ROOT, encoding: 'utf8' }))
          .toContain(prepared.placement.branch);
      } finally {
        release();
        get.mockRestore();
      }
    },
  );

  it('attaches the unchanged native shape and appends truthful in-place scope', async () => {
    const liveDirectory = path.join(TEST_ROOT, 'live');
    fs.mkdirSync(liveDirectory);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-attach');
    const prepared = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'attach' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, context) as string);
    const args = {
      subagent_type: 'forager-worker',
      description: 'Edit live configuration',
      prompt: 'Make the requested edit.',
      background: false,
    };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: context.sessionID, callID: 'call-attach' }, { args });

    expect(Object.keys(args).sort()).toEqual(['background', 'description', 'prompt', 'subagent_type']);
    expect(args.prompt).toContain('Make the requested edit.');
    expect(args.prompt).toContain('## Hive execution scope');
    expect(args.prompt).toContain('live in-place directory');
    expect(args.prompt).toContain(fs.realpathSync(liveDirectory));
    expect(new ExecutionAttemptService(TEST_ROOT).getAttempt(prepared.attemptId)?.phase).toBe('attached');
  });

  it('does not merge or clean up a stale ad-hoc worktree after a newer in-place success', async () => {
    initGit(TEST_ROOT);
    const liveDirectory = path.join(TEST_ROOT, 'live-retry');
    fs.mkdirSync(liveDirectory);
    const { hooks, context } = await hooksFor(TEST_ROOT, 'primary-stale-adhoc');
    const old = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'stale-adhoc' },
      placement: { kind: 'worktree' },
    }, context) as string);
    const oldArgs = { subagent_type: 'forager-worker', description: 'Old worktree attempt', prompt: 'Do it.' };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: context.sessionID, callID: 'call-old-adhoc' }, { args: oldArgs });
    new ExecutionAttemptService(TEST_ROOT).observeBlockingStop({
      originatingPrimarySession: context.sessionID,
      nativeCallId: 'call-old-adhoc',
      outputDefined: true,
    });
    expect(JSON.parse(await hooks.tool!.hive_execution_finish.execute({
      attemptId: old.attemptId,
      status: 'failed',
      summary: 'Old worktree attempt failed.',
    }, context) as string).success).toBe(true);

    const current = JSON.parse(await hooks.tool!.hive_execution_prepare.execute({
      scope: { kind: 'adhoc', runId: 'stale-adhoc' },
      placement: { kind: 'in_place', directory: liveDirectory },
    }, context) as string);
    const currentArgs = { subagent_type: 'forager-worker', description: 'Current in-place attempt', prompt: 'Do it.' };
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: context.sessionID, callID: 'call-current-adhoc' }, { args: currentArgs });
    new ExecutionAttemptService(TEST_ROOT).observeBlockingStop({
      originatingPrimarySession: context.sessionID,
      nativeCallId: 'call-current-adhoc',
      outputDefined: true,
    });
    expect(JSON.parse(await hooks.tool!.hive_execution_finish.execute({
      attemptId: current.attemptId,
      status: 'completed',
      summary: 'Current in-place attempt completed.',
    }, context) as string).success).toBe(true);

    const merge = JSON.parse(await hooks.tool!.hive_adhoc_merge.execute({
      runId: 'stale-adhoc',
      message: 'feat: forbidden stale merge\n\nDo not merge the old worktree branch.',
    }, context) as string);
    expect(merge).toMatchObject({ success: false, reason: 'in_place_has_no_worktree' });
    const cleanup = JSON.parse(await hooks.tool!.hive_adhoc_cleanup.execute({
      runId: 'stale-adhoc', deleteBranch: true,
    }, context) as string);
    expect(cleanup).toMatchObject({ success: false, reason: 'in_place_has_no_worktree' });
    expect(fs.existsSync(old.placement.workspacePath)).toBe(true);
    expect(execSync('git branch --format="%(refname:short)"', { cwd: TEST_ROOT, encoding: 'utf8' }))
      .toContain(old.placement.branch);
  });

  it('does not register the removed preparation APIs or native schema hook', async () => {
    const { hooks } = await hooksFor(TEST_ROOT, 'primary-surface');
    expect(hooks.tool!.hive_worktree_start).toBeUndefined();
    expect(hooks.tool!.hive_worktree_create).toBeUndefined();
    expect(hooks.tool!.hive_adhoc_worktree_create).toBeUndefined();
    expect(hooks.tool!.hive_adhoc_worktree_start).toBeUndefined();
    expect(hooks['tool.definition']).toBeUndefined();
  });
});
