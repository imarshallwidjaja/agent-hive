import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RepositoryService, RetainedCheckoutService, WorklogService, parseWorklogKey } from 'hive-core';
import type { CheckoutProjection, CheckoutWorkerView, RetainedCheckoutView } from 'hive-core';
import { resetVscodeTestState, vscodeTestDouble, vscodeTestState as ui } from '../test/vscodeTestDouble.js';

mock.module('vscode', () => vscodeTestDouble);

const { RepositoryWorkProvider, copyLocation, openInNewWindow, openTerminal } = await import('./repositoryWorkProvider');

const TEST_ROOT_BASE = `/tmp/vscode-hive-repository-work-test-${process.pid}`;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const initGitRepo = (root: string): void => {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test User');
  fs.writeFileSync(path.join(root, '.gitignore'), '.hive/\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-m', 'chore: base\n\nCreate the fixture history.');
};

/** The visible tree as `label | description` lines, expanding every row the provider marks collapsible. */
async function render(provider: any, element?: any, depth = 0): Promise<string[]> {
  const lines: string[] = [];
  for (const child of await provider.getChildren(element)) {
    lines.push(`${'  '.repeat(depth)}${child.label}${child.description ? ` | ${child.description}` : ''}`);
    if (child.collapsibleState !== 0 && !child.id.endsWith('/other-branches')) lines.push(...await render(provider, child, depth + 1));
  }
  return lines;
}

async function find(provider: any, id: string, element?: any): Promise<any> {
  for (const child of await provider.getChildren(element)) {
    if (child.id === id) return child;
    const nested = child.collapsibleState !== 0 && !child.id.endsWith('/other-branches') ? await find(provider, id, child) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

describe('RepositoryWorkProvider', () => {
  let testRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    resetVscodeTestState();
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    testRoot = fs.realpathSync(fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'workspace-')));
    originalHome = process.env.HOME;
    process.env.HOME = path.join(TEST_ROOT_BASE, 'home');
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  it('shows the project root as a normal repository with its checkout, readiness against the current HEAD, and untracked branches on demand', async () => {
    initGitRepo(testRoot);
    git(testRoot, 'branch', 'scratch');
    const hiveDir = path.join(testRoot, '.hive');
    const checkouts = new RetainedCheckoutService({ baseDir: testRoot, hiveDir });
    await checkouts.register({ id: 'root/main' });
    await checkouts.create({ id: 'root/develop', branch: 'develop', baseRef: 'main' });
    const feature = await checkouts.create({ id: 'root/feature', branch: 'feat/x', baseRef: 'main', purpose: 'Checkout rewrite' });
    await checkouts.create({ id: 'root/idle', branch: 'idle', baseRef: 'main' });
    await checkouts.setReadiness('root/feature', { path: feature.path, ref: feature.ref, commit: git(feature.path, 'rev-parse', 'HEAD') }, { state: 'ready', nextTarget: 'root/develop', waitingFor: 'Operator review of the migration notes' });
    fs.writeFileSync(path.join(hiveDir, 'checkouts', 'root', 'broken.json'), '{');
    const before = snapshot(hiveDir);

    const provider = new RepositoryWorkProvider(testRoot);
    const tree = await render(provider);
    expect(snapshot(hiveDir)).toEqual(before);
    expect(tree[0]).toBe('root | . · 5 retained');
    expect(tree).toContain('  main | Repository checkout · Retained');
    expect(tree).toContain('  feat/x | Ready, waiting → develop · Checkout rewrite');
    expect(tree).toContain('    Waiting for | Operator review of the migration notes');
    expect(tree).toContain('    Integrates into | develop (root/develop)');
    expect(tree).toContain(`    Location | ${feature.path}`);
    expect(tree).toContain('  idle | Retained');
    expect(tree).toContain('    Readiness | Not recorded');
    expect(tree).toContain('  broken | Record unreadable');
    expect(tree.some(line => line.startsWith('    Problem | ') && line.includes('Invalid JSON'))).toBe(true);
    // The registered record for the repository checkout is that checkout, not a second row.
    expect(tree.filter(line => line.startsWith('  main'))).toHaveLength(1);

    const row = await find(provider, 'checkout:root/feature');
    expect(row.location).toEqual({ path: feature.path, ref: 'refs/heads/feat/x', commit: git(feature.path, 'rev-parse', 'HEAD') });
    expect(row.contextValue).toBe('repository-work checkout open path ref commit');
    expect(row.command).toBeUndefined();

    fs.writeFileSync(path.join(feature.path, 'moved.txt'), 'moved\n');
    git(feature.path, 'add', 'moved.txt');
    git(feature.path, 'commit', '-m', 'feat: move\n\nAdvance HEAD past the declared readiness.');
    expect(await render(provider)).toContain('  feat/x | Ready, waiting → develop · Checkout rewrite');
    const committed = snapshot(hiveDir);
    provider.refresh();
    const moved = await render(provider);
    expect(moved).toContain('  feat/x | Changed since readiness → develop · Checkout rewrite');
    expect(moved.find(line => line.startsWith('    Readiness | Ready at '))).toContain(' · not current: HEAD is now ');

    const branches = await provider.getChildren(await find(provider, 'repo:root/other-branches'));
    expect(branches.map((branch: any) => branch.label)).toEqual(['scratch']);
    expect(branches[0].description).toBe(git(testRoot, 'rev-parse', '--short=7', 'scratch'));
    expect(snapshot(hiveDir)).toEqual(committed);
  });

  it('puts an unavailable or off-branch checkout ahead of its readiness and names the branch each checkout is bound to', async () => {
    initGitRepo(testRoot);
    const hiveDir = path.join(testRoot, '.hive');
    const checkouts = new RetainedCheckoutService({ baseDir: testRoot, hiveDir });
    await checkouts.register({ id: 'root/main' });
    const declareReady = async (id: string, branch: string) => {
      const created = await checkouts.create({ id, branch, baseRef: 'main' });
      await checkouts.setReadiness(id, { path: created.path, ref: created.ref, commit: git(created.path, 'rev-parse', 'HEAD') }, { state: 'ready' });
      return created;
    };
    const switched = await declareReady('root/switched', 'feat/switched');
    const detached = await declareReady('root/detached', 'feat/detached');
    const missing = await declareReady('root/missing', 'feat/missing');
    const gone = await checkouts.create({ id: 'root/gone', branch: 'feat/gone', baseRef: 'main' });
    await checkouts.create({ id: 'root/headless', branch: 'feat/headless', baseRef: 'main' });
    // Same commit, other branch: the declared commit still matches, but the checkout is not where it was declared.
    git(switched.path, 'switch', '-c', 'other');
    git(detached.path, 'switch', '--detach');
    fs.rmSync(missing.path, { recursive: true, force: true });
    fs.rmSync(gone.path, { recursive: true, force: true });
    // Present, but its HEAD cannot be read.
    fs.writeFileSync(path.join(testRoot, '.git', 'worktrees', 'headless', 'HEAD'), 'not a ref\n');
    git(testRoot, 'switch', '-c', 'elsewhere');
    const before = snapshot(hiveDir);

    const provider = new RepositoryWorkProvider(testRoot);
    const tree = await render(provider);
    expect(snapshot(hiveDir)).toEqual(before);
    expect(tree).toContain('  main | Repository checkout · Off intended branch: on elsewhere');
    expect(tree).toContain('  feat/switched | Off intended branch: on other');
    expect(tree).toContain('  feat/detached | Off intended branch: detached HEAD');
    expect(tree).toContain('  feat/missing | Missing');
    expect(tree).toContain('  feat/gone | Missing');
    expect(tree).toContain('  feat/headless | Unavailable');
    expect(tree.some(line => line.includes('Ready') && !line.includes('Readiness |'))).toBe(false);

    const details = async (id: string) => (await provider.getChildren(await find(provider, id))).map((row: any) => `${row.label} | ${row.description}`);
    expect((await details('checkout:root/switched')).find(line => line.startsWith('Readiness |'))).toEndWith(' · not current: checkout is off its intended branch');
    expect((await details('checkout:root/missing')).find(line => line.startsWith('Readiness |'))).toEndWith(' · not current: checkout is missing');
    expect(await details('checkout:root/gone')).toContain('Readiness | Not recorded');
    expect(await details('checkout:root/gone')).toContain(`Problem | checkout is missing at ${gone.path}`);
    expect(await details('repo:root/checkout')).toContain(`HEAD | elsewhere @ ${git(testRoot, 'rev-parse', '--short=7', 'HEAD')}, intended main`);

    // Only a managed checkout confirmed absent offers Remove Stale Hive Record, and the row carries its ID.
    const goneRow = await find(provider, 'checkout:root/gone');
    expect(goneRow.contextValue).toBe('repository-work checkout path ref stale');
    expect(goneRow.checkoutId).toBe('root/gone');
    for (const id of ['checkout:root/headless', 'checkout:root/switched', 'repo:root/checkout']) {
      const row = await find(provider, id);
      expect(row.contextValue).not.toContain('stale');
      expect(row.checkoutId).toBeUndefined();
    }
  });

  it('shows a repository configured at a subdirectory as one checkout at the root of its Git checkout', async () => {
    const repo = path.join(testRoot, 'repo');
    fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'pkg', 'index.ts'), 'export {};\n');
    initGitRepo(repo);
    writeJson('.hive/repositories.json', { schemaVersion: 1, repositories: [{ id: 'app', path: './repo/pkg' }] });
    const hiveDir = path.join(testRoot, '.hive');
    const checkouts = new RetainedCheckoutService({ baseDir: testRoot, hiveDir, repositoryResolver: new RepositoryService(testRoot) });
    const main = await checkouts.register({ id: 'app/main' });
    await checkouts.setReadiness('app/main', { path: repo, ref: main.ref, commit: git(repo, 'rev-parse', 'HEAD') }, { state: 'ready' });

    const provider = new RepositoryWorkProvider(testRoot);
    const tree = await render(provider);
    expect(tree[0]).toBe('app | repo/pkg · 1 retained');
    expect(tree.filter(line => line.startsWith('  main'))).toEqual(['  main | Repository checkout · Ready']);
    expect(tree).toContain(`    Location | ${repo}`);
    expect((await find(provider, 'repo:app/checkout')).location.path).toBe(repo);
  });

  it('reads manifest repositories through a workspace alias and reports an unusable manifest instead of guessing repositories', async () => {
    initGitRepo(path.join(testRoot, 'packages', 'api'));
    writeJson('.hive/repositories.json', { schemaVersion: 1, repositories: [{ id: 'api', path: './packages/api' }] });
    const alias = path.join(TEST_ROOT_BASE, 'workspace-alias');
    fs.symlinkSync(testRoot, alias);
    const roots = await new RepositoryWorkProvider(alias).getChildren();
    expect(roots.map((row: any) => [row.label, row.description])).toEqual([['api', 'packages/api']]);

    const external = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'external-'));
    initGitRepo(external);
    fs.symlinkSync(external, path.join(testRoot, 'external'));
    for (const manifest of ['{ invalid json', JSON.stringify({ schemaVersion: 1, repositories: [{ id: 'external', path: './external' }] })]) {
      fs.writeFileSync(path.join(testRoot, '.hive', 'repositories.json'), manifest);
      const rows = await new RepositoryWorkProvider(testRoot).getChildren();
      expect(rows.map((row: any) => row.label)).toEqual(['Repositories unreadable']);
      expect(rows[0].description).toContain('repository manifest');
      expect(rows[0].contextValue).not.toContain('open');
    }
  });

  it('keeps two repositories, their targets, and sidecar-only, unresolved, and broken workers separately visible', async () => {
    const api = path.join(testRoot, 'api');
    const web = path.join(testRoot, 'web');
    const apiWorker = path.join(testRoot, '.hive', '.worktrees', 'checkout', '01-api');
    fs.mkdirSync(apiWorker, { recursive: true });
    const projection: CheckoutProjection = {
      repositories: [
        { id: 'api', path: api, root: api, implicit: false, head: { path: api, ref: 'refs/heads/main', commit: 'a'.repeat(40) }, checkouts: [retained('api/feature', api, 'ready', 'a1')], workers: [
          worker({ feature: 'checkout', task: '01-api', repoId: 'api', path: apiWorker, branch: 'hive-targeted/checkout/01-api', head: 'b'.repeat(40), target: { id: 'api/feature', path: path.join(api, 'f'), ref: 'refs/heads/feat/x' } }),
          worker({ kind: 'adhoc', runId: 'kept', repoId: 'api', path: path.join(testRoot, '.hive', '.worktrees', 'adhoc', 'kept'), branch: 'hive-targeted/adhoc/kept', retained: { branchCommit: 'c'.repeat(40) }, target: { id: 'api/feature', path: path.join(api, 'f'), ref: 'refs/heads/feat/x' } }),
          worker({ kind: 'adhoc', runId: 'legacy', repoId: 'api', path: path.join(testRoot, '.hive', '.worktrees', 'adhoc', 'legacy'), branch: 'hive/adhoc/legacy', head: 'd'.repeat(40), baseCommit: 'e'.repeat(40) }),
          worker({ kind: 'adhoc', runId: 'lost', repoId: 'api', path: path.join(testRoot, '.hive', '.worktrees', 'adhoc', 'lost'), branch: 'hive-targeted/adhoc/lost', error: 'targeted worker branch has no binding metadata, so its target is unknown' }),
        ] },
        { id: 'web', path: web, root: web, implicit: false, head: null, headError: 'not a git repository', checkouts: [retained('web/feature', web, 'not_ready', 'f1')], workers: [
          worker({ feature: 'checkout', task: '02-web', repoId: 'web', path: path.join(testRoot, '.hive', '.worktrees', 'checkout', '02-web'), branch: 'hive-targeted/checkout/02-web', target: { id: 'api/feature', path: path.join(api, 'f'), ref: 'refs/heads/feat/x' } }),
        ] },
      ],
      unassigned: { checkouts: [], workers: [worker({ kind: 'adhoc', runId: 'stray', repoId: null, path: '/elsewhere/stray', branch: null, error: 'its repository is not configured' })] },
      errors: [{ path: path.join(testRoot, '.hive', 'checkouts', 'api', 'orphan'), reason: 'placement has no retained checkout record' }],
    };
    const tree = await render(new RepositoryWorkProvider(testRoot, fakeInspector(projection)));

    expect(tree.filter(line => !line.startsWith('   '))).toEqual([
      'api | api · 1 retained · 4 workers',
      '  main | Repository checkout',
      '  feat/x | Ready · 2 bound workers',
      '  Other workers / unresolved | 2',
      '  Other local branches | Not tracked by Hive',
      'web | web · 1 retained · 1 worker',
      '  Repository checkout | HEAD unreadable',
      '  feat/x | Not ready',
      '  Other workers / unresolved | 1',
      '  Other local branches | Not tracked by Hive',
      'Not in a configured repository | 1 worker',
      '  Other workers / unresolved | 1',
      'Unreadable Hive entries | 1',
      '  .hive/checkouts/api/orphan | placement has no retained checkout record',
    ]);
    // Workers sit under their declared target; a target in another repository is not guessed into this one.
    expect(tree).toContain('    01-api | no recorded activity · hive-targeted/checkout/01-api');
    expect(tree).toContain('    kept | worktree removed, branch kept · no recorded activity · hive-targeted/adhoc/kept');
    expect(tree).toContain('    legacy | no recorded activity · hive/adhoc/legacy');
    expect(tree).toContain('    lost | unreadable · no recorded activity · hive-targeted/adhoc/lost');
    expect(tree).toContain('      Target | feat/x (api/feature)');
    expect(tree).toContain('    02-web | no recorded activity · hive-targeted/checkout/02-web');
    expect(tree).toContain('      Started from | eeeeeee');

    const provider = new RepositoryWorkProvider(testRoot, fakeInspector(projection));
    const kept = await find(provider, `worker:${path.join(testRoot, '.hive', '.worktrees', 'adhoc', 'kept')}`);
    expect(kept.location.path).toBeUndefined();
    expect(kept.contextValue).not.toContain('open');
    const live = await find(provider, `worker:${apiWorker}`);
    expect(live.contextValue).toContain('open');
    // Bound workers come before the checkout's own details.
    expect((await provider.getChildren(await find(provider, 'checkout:api/feature'))).slice(0, 2).map((row: any) => row.label)).toEqual(['kept', '01-api']);
  });

  it('keeps a registered repository checkout whose HEAD is unreadable as one row with its record, readiness, and bound workers', async () => {
    const api = path.join(testRoot, 'api');
    const recorded = retained('api/main', api, 'ready', 'a1');
    const error = 'Reading target commit failed: bad HEAD';
    const own: RetainedCheckoutView = {
      ...recorded,
      record: { ...recorded.record!, ownership: 'registered', path: api, ref: 'refs/heads/main' },
      head: null,
      onIntendedRef: null,
      readiness: { ...recorded.readiness!, headMoved: null },
      error,
    };
    const projection: CheckoutProjection = {
      repositories: [{ id: 'api', path: path.join(api, 'pkg'), root: api, implicit: false, head: null, headError: error, checkouts: [own], workers: [
        worker({ feature: 'checkout', task: '01-api', repoId: 'api', path: '/w/checkout/01-api', branch: 'hive-targeted/checkout/01-api', target: { id: 'api/main', path: api, ref: 'refs/heads/main' } }),
      ] }],
      unassigned: { checkouts: [], workers: [] },
      errors: [],
    };
    const provider = new RepositoryWorkProvider(testRoot, fakeInspector(projection));
    const tree = await render(provider);
    expect(tree.filter(line => !line.startsWith('    '))).toEqual([
      'api | api/pkg · 1 retained · 1 worker',
      '  main | Repository checkout · Unavailable · 1 bound worker',
      '  Other local branches | Not tracked by Hive',
    ]);
    const children = (await provider.getChildren(await find(provider, 'repo:api/checkout'))).map((row: any) => `${row.label} | ${row.description}`);
    expect(children[0]).toStartWith('01-api | ');
    expect(children.find(line => line.startsWith('Readiness |'))).toEndWith(' · not current: checkout unavailable');
    expect(children).toContain(`Location | ${api}`);
    expect(children).toContain(`Problem | ${error}`);
  });

  it('attaches only exact owner-scoped activity and marks shared task bindings ambiguous', async () => {
    const projection: CheckoutProjection = {
      repositories: [{ id: 'root', path: testRoot, root: testRoot, implicit: false, head: null, headError: 'unborn', checkouts: [], workers: [
        worker({ kind: 'adhoc', runId: 'bound', repoId: 'root', path: '/w/adhoc/bound', branch: 'hive/adhoc/bound' }),
        worker({ kind: 'adhoc', runId: 'quiet', repoId: 'root', path: '/w/adhoc/quiet', branch: 'hive/adhoc/quiet' }),
        worker({ feature: 'checkout', task: '01-api', candidate: 'a', repoId: 'root', path: path.join(testRoot, '.hive', '.worktrees', 'checkout', '01-api--a'), branch: 'hive/checkout/01-api--a' }),
        worker({ feature: 'checkout', task: '01-api', candidate: 'b', repoId: 'root', path: path.join(testRoot, '.hive', '.worktrees', 'checkout', '01-api--b'), branch: 'hive/checkout/01-api--b' }),
      ] }],
      unassigned: { checkouts: [], workers: [] },
      errors: [],
    };
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    writeJson('.hive/sessions.json', { sessions: [
      { sessionId: 'ses_v1', adHocRunId: 'bound', agent: 'forager-worker', startedAt: recent, lastActiveAt: recent },
      { sessionId: 'ses_task', featureName: 'checkout', taskFolder: '01-api', startedAt: recent, lastActiveAt: recent },
      // Feature-only and current-directory associations name no worker.
      { sessionId: 'ses_feature', featureName: 'checkout', startedAt: recent, lastActiveAt: recent },
    ] });
    writeJson('.hive/runtime/opencode-v2/background-jobs.json', { schemaVersion: 1, jobs: [
      { alias: 'job-1', taskId: 't', sessionId: 's', agentName: 'forager-worker', createdAt: recent, updatedAt: recent, runtimeState: 'running', scope: { adHocRunId: 'bound' } },
    ] });

    const provider = new RepositoryWorkProvider(testRoot, fakeInspector(projection));
    const tree = await render(provider);
    expect(tree).toContain('    bound | observed running 5 min ago · hive/adhoc/bound');
    expect(tree).toContain('      Background job job-1 | running · observed 5 min ago · OpenCode v2');
    expect(tree).toContain('      Session ses_v1 | forager-worker · last update 5 min ago · OpenCode v1');
    expect(tree).toContain('    quiet | no recorded activity · hive/adhoc/quiet');
    expect(tree).toContain('    01-api (a) | activity ambiguous · hive/checkout/01-api--a');
    expect(tree).toContain('      Activity | Ambiguous: sessions and jobs for this task are not attributed');
    expect(tree.some(line => line.includes('ses_task') || line.includes('ses_feature'))).toBe(false);
    const job = await find(provider, 'worker:/w/adhoc/bound/job:opencode-v2:job-1');
    expect(job.command).toEqual({ command: 'hive.openBackgroundJobInBoard', title: 'Open Background Job Record', arguments: ['opencode-v2', 'job-1'] });

    // An unreadable store makes activity unknown rather than absent, and is never repaired by reading.
    fs.writeFileSync(path.join(testRoot, '.hive', 'sessions.json'), '{ broken');
    provider.refresh();
    const unknown = await render(provider);
    expect(unknown).toContain('    quiet | activity unknown · hive/adhoc/quiet');
    expect(unknown).toContain('      Activity | Unknown: OpenCode v1 sessions unreadable');
    expect(fs.readFileSync(path.join(testRoot, '.hive', 'sessions.json'), 'utf8')).toBe('{ broken');

    // So does valid JSON whose matching record has a field of the wrong type where the row would print it.
    const malformed = JSON.stringify({ sessions: [{ sessionId: 'ses_bad', adHocRunId: 'bound', agent: { toString: null, valueOf: null }, startedAt: recent, lastActiveAt: recent }] });
    fs.writeFileSync(path.join(testRoot, '.hive', 'sessions.json'), malformed);
    provider.refresh();
    const typed = await render(provider);
    expect(typed).toContain('    quiet | activity unknown · hive/adhoc/quiet');
    expect(typed).toContain('    bound | observed running 5 min ago · hive/adhoc/bound');
    expect(typed.some(line => line.includes('ses_bad'))).toBe(false);
    expect(fs.readFileSync(path.join(testRoot, '.hive', 'sessions.json'), 'utf8')).toBe(malformed);
  });

  it('joins activity on the feature a name resolves to, so logical and indexed spellings of one task are one binding', async () => {
    writeJson('.hive/features/01_checkout/feature.json', { name: 'checkout', status: 'executing', createdAt: '2026-11-01T10:00:00.000Z' });
    const placement = (feature: string) => worker({ feature, task: '01-api', repoId: 'root', path: path.join(testRoot, '.hive', '.worktrees', feature, '01-api'), branch: `hive/${feature}/01-api` });
    const projection = (...workers: CheckoutWorkerView[]): CheckoutProjection => ({
      repositories: [{ id: 'root', path: testRoot, root: testRoot, implicit: false, head: null, headError: 'unborn', checkouts: [], workers }],
      unassigned: { checkouts: [], workers: [] },
      errors: [],
    });
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    writeJson('.hive/sessions.json', { sessions: [{ sessionId: 'ses_task', featureName: 'checkout', taskFolder: '01-api', startedAt: recent, lastActiveAt: recent }] });

    const indexed = new RepositoryWorkProvider(testRoot, fakeInspector(projection(placement('01_checkout'))));
    const single = await render(indexed);
    expect(single).toContain('    01-api | last session update 5 min ago · hive/01_checkout/01-api');
    // The worklog link names the feature by the logical name in its metadata, which the worklog reader resolves.
    const workerId = `worker:${path.join(testRoot, '.hive', '.worktrees', '01_checkout', '01-api')}`;
    const worklog = await find(indexed, `${workerId}/worklog`);
    expect(worklog.command).toEqual({ command: 'hive.worklog.open', title: 'Open Worklog', arguments: ['feature:checkout'] });
    expect(new WorklogService(testRoot).read(parseWorklogKey(worklog.command.arguments[0])).key).toBe('feature:checkout');

    // Two placements of the same task under different spellings: the session names neither, so neither gets it.
    const both = await render(new RepositoryWorkProvider(testRoot, fakeInspector(projection(placement('checkout'), placement('01_checkout')))));
    expect(both).toContain('    01-api | activity ambiguous · hive/checkout/01-api');
    expect(both).toContain('    01-api | activity ambiguous · hive/01_checkout/01-api');
    expect(both.some(line => line.includes('ses_task'))).toBe(false);

    // Unreadable metadata: the indexed placement still resolves directly, but the session's logical name cannot, so
    // that task's activity is unknown and its worklog has no logical name. An unrelated run keeps its own answer.
    fs.writeFileSync(path.join(testRoot, '.hive', 'features', '01_checkout', 'feature.json'), '{ broken');
    const before = snapshot(testRoot);
    const quiet = worker({ kind: 'adhoc', runId: 'quiet', repoId: 'root', path: '/w/adhoc/quiet', branch: 'hive/adhoc/quiet' });
    const corrupt = new RepositoryWorkProvider(testRoot, fakeInspector(projection(placement('01_checkout'), quiet)));
    const unknown = await render(corrupt);
    expect(unknown).toContain('    01-api | activity unknown · hive/01_checkout/01-api');
    expect(unknown).toContain('      Branch | hive/01_checkout/01-api');
    expect(unknown).toContain('      Activity | Unknown: feature "checkout" metadata unreadable');
    expect(unknown).toContain('    quiet | no recorded activity · hive/adhoc/quiet');
    const unknownLog = await find(corrupt, `${workerId}/worklog`);
    expect(unknownLog.description).toStartWith('Unknown: ');
    expect(unknownLog.command).toBeUndefined();
    expect(snapshot(testRoot)).toEqual(before);

    // A session in the indexed spelling would match the indexed placement, but the logical placement of the same task
    // cannot be resolved and may be the same binding, so neither placement is given the session.
    writeJson('.hive/sessions.json', { sessions: [{ sessionId: 'ses_indexed', featureName: '01_checkout', taskFolder: '01-api', startedAt: recent, lastActiveAt: recent }] });
    const sessionsBefore = snapshot(testRoot);
    const aliases = await render(new RepositoryWorkProvider(testRoot, fakeInspector(projection(placement('checkout'), placement('01_checkout'), quiet))));
    expect(aliases).toContain('    01-api | activity ambiguous · hive/01_checkout/01-api');
    expect(aliases).toContain('    01-api | activity unknown · hive/checkout/01-api');
    expect(aliases).toContain('    quiet | no recorded activity · hive/adhoc/quiet');
    expect(aliases.some(line => line.includes('ses_indexed'))).toBe(false);
    expect(snapshot(testRoot)).toEqual(sessionsBefore);
    expect(fs.readFileSync(path.join(testRoot, '.hive', 'features', '01_checkout', 'feature.json'), 'utf8')).toBe('{ broken');
  });

  it('never attributes activity to an unreadable exact-name directory while another feature claims that name', async () => {
    // A legacy directory named exactly `checkout` has unreadable metadata, and `02_checkout` is the feature named `checkout`.
    fs.mkdirSync(path.join(testRoot, '.hive', 'features', 'checkout'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, '.hive', 'features', 'checkout', 'feature.json'), '{ broken');
    writeJson('.hive/features/02_checkout/feature.json', { name: 'checkout', status: 'executing', createdAt: '2026-11-01T10:00:00.000Z' });
    const placement = (feature: string) => worker({ feature, task: '01-api', repoId: 'root', path: path.join(testRoot, '.hive', '.worktrees', feature, '01-api'), branch: `hive/${feature}/01-api` });
    const projection = (...workers: CheckoutWorkerView[]): CheckoutProjection => ({
      repositories: [{ id: 'root', path: testRoot, root: testRoot, implicit: false, head: null, headError: 'unborn', checkouts: [], workers }],
      unassigned: { checkouts: [], workers: [] },
      errors: [],
    });
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    writeJson('.hive/sessions.json', { sessions: [{ sessionId: 'ses_logical', featureName: 'checkout', taskFolder: '01-api', startedAt: recent, lastActiveAt: recent }] });
    const before = snapshot(testRoot);

    // `checkout` may mean either directory, so its placement is unresolved and the indexed placement of the same task
    // cannot be told apart from it; the session naming `checkout` goes to neither.
    const both = await render(new RepositoryWorkProvider(testRoot, fakeInspector(projection(placement('checkout'), placement('02_checkout')))));
    expect(both).toContain('    01-api | activity unknown · hive/checkout/01-api');
    expect(both).toContain('      Activity | Unknown: feature "checkout" metadata unreadable');
    expect(both).toContain('    01-api | activity ambiguous · hive/02_checkout/01-api');
    expect(both.some(line => line.includes('ses_logical'))).toBe(false);

    // Alone, the exact-name placement is still unresolved rather than taking the logical session.
    const alone = await render(new RepositoryWorkProvider(testRoot, fakeInspector(projection(placement('checkout')))));
    expect(alone).toContain('    01-api | activity unknown · hive/checkout/01-api');
    expect(alone.some(line => line.includes('ses_logical'))).toBe(false);
    expect(snapshot(testRoot)).toEqual(before);

    // With no other claimant, the name can mean only the exact directory, so the association is kept.
    fs.rmSync(path.join(testRoot, '.hive', 'features', '02_checkout'), { recursive: true });
    const sole = await render(new RepositoryWorkProvider(testRoot, fakeInspector(projection(placement('checkout')))));
    expect(sole).toContain('    01-api | last session update 5 min ago · hive/checkout/01-api');
  });

  it('keeps stable row IDs across refreshes, never returns a snapshot a refresh overtook, and lists branches only on expansion', async () => {
    const first = projectionWith('first');
    const second = projectionWith('second');
    let release!: () => void;
    const reads: CheckoutProjection[] = [];
    const branchCalls: string[] = [];
    const inspector = {
      async inspectProject() {
        if (reads.length === 0) {
          reads.push(first);
          await new Promise<void>(resolve => { release = resolve; });
          return first;
        }
        reads.push(second);
        return second;
      },
      async listLocalBranches(repoId: string) {
        branchCalls.push(repoId);
        return [{ ref: 'refs/heads/feat/second', commit: 'f'.repeat(40), checkedOutAt: null }, { ref: 'refs/heads/spare', commit: '1'.repeat(40), checkedOutAt: null }];
      },
    };
    const provider = new RepositoryWorkProvider(testRoot, inspector as never);
    const view = vscodeTestDouble.window.createTreeView('hive.repositories', { treeDataProvider: provider }) as any;
    provider.attach(view);

    const stale = provider.getChildren();
    provider.refresh();
    release();
    const roots = await stale;
    const checkout = await find(provider, 'checkout:root/second');
    expect(checkout?.label).toBe('feat/second');
    expect(await find(provider, 'checkout:root/first')).toBeUndefined();
    expect(roots.map((root: any) => root.id)).toEqual(['repo:root']);
    expect((await provider.getChildren(roots[0])).map((row: any) => row.id)).toContain('checkout:root/second');
    expect(view.description).toStartWith('Git read ');
    expect(branchCalls).toEqual([]);

    const group = await find(provider, 'repo:root/other-branches');
    expect((await provider.getChildren(group)).map((row: any) => row.label)).toEqual(['spare']);
    await provider.getChildren(group);
    expect(branchCalls).toEqual(['root']);

    // Showing the view or focusing the window takes a new Git read; the IDs stay the same.
    ui.fired = [];
    view.setVisible(true);
    for (const listener of ui.windowStateListeners) listener({ focused: true });
    expect(ui.fired).toHaveLength(2);
    expect((await find(provider, 'checkout:root/second'))?.id).toBe(checkout.id);
    expect(reads).toHaveLength(3);
  });

  it('opens and copies structured row values without shell text', async () => {
    const row = { location: { path: testRoot, ref: 'refs/heads/feat/x', commit: 'a'.repeat(40) } };
    await openInNewWindow(row);
    expect(ui.executed.at(-1)).toEqual({ id: 'vscode.openFolder', args: [{ fsPath: testRoot }, { forceNewWindow: true }] });
    openTerminal(row);
    expect(ui.terminals[0].options).toEqual({ name: `Hive: ${path.basename(testRoot)}`, cwd: testRoot });
    expect(ui.terminals[0].shown).toBe(true);
    await copyLocation(row, 'ref');
    await copyLocation(row, 'commit');
    await copyLocation(row, 'path');
    expect(ui.clipboard).toEqual(['feat/x', 'a'.repeat(40), testRoot]);

    await openInNewWindow({ location: { path: path.join(testRoot, 'missing') } });
    openTerminal({ location: { path: 'not-a-dir; rm -rf /' } });
    await copyLocation({}, 'commit');
    expect(ui.terminals).toHaveLength(1);
    expect(ui.warnings).toEqual([
      'Hive: This row has no checkout directory to open.',
      'Hive: This row has no checkout directory to open a terminal in.',
      'Hive: This row has no commit SHA to copy.',
    ]);
  });

  function writeJson(relative: string, data: unknown): void {
    const target = path.join(testRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(data, null, 2));
  }

  function projectionWith(slug: string): CheckoutProjection {
    return {
      repositories: [{ id: 'root', path: testRoot, root: testRoot, implicit: false, head: null, headError: 'unborn', checkouts: [retained(`root/${slug}`, testRoot, undefined, slug)], workers: [] }],
      unassigned: { checkouts: [], workers: [] },
      errors: [],
    };
  }
});

/** Every path and modification time under `root`, so reading can be shown to have written nothing. */
function snapshot(root: string): string[] {
  const entries: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      entries.push(`${full}\0${fs.lstatSync(full).mtimeMs}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return entries.sort();
}

function fakeInspector(projection: CheckoutProjection) {
  return { inspectProject: async () => projection, listLocalBranches: async () => [] } as never;
}

function retained(id: string, repoPath: string, state: 'ready' | 'not_ready' | undefined, branchSuffix: string): RetainedCheckoutView {
  const [repoId, slug] = id.split('/') as [string, string];
  const commit = branchSuffix.padEnd(40, '0');
  return {
    id,
    repoId,
    slug,
    record: {
      schemaVersion: 1,
      id,
      repoId,
      slug,
      ownership: 'managed',
      path: path.join(repoPath, slug),
      ref: slug === 'feature' ? 'refs/heads/feat/x' : `refs/heads/feat/${slug}`,
      created: { at: '2026-11-01T10:00:00.000Z', commit, branch: 'new' },
      ...(state ? { readiness: { state, commit, recordedAt: '2026-11-02T10:00:00.000Z' } } : {}),
    },
    head: { path: path.join(repoPath, slug), ref: slug === 'feature' ? 'refs/heads/feat/x' : `refs/heads/feat/${slug}`, commit },
    onIntendedRef: true,
    ...(state ? { readiness: { state, commit, recordedAt: '2026-11-02T10:00:00.000Z', headMoved: false } } : {}),
  };
}

function worker(fields: Partial<CheckoutWorkerView> & Pick<CheckoutWorkerView, 'path'>): CheckoutWorkerView {
  return { kind: 'task', repoId: null, branch: null, head: null, ...fields };
}
