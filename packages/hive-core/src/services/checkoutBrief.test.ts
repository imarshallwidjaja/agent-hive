import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { AdhocWorktreeService } from './adhocWorktreeService';
import { readCheckoutBrief } from './checkoutBrief';
import { FeatureService } from './featureService';
import { integrationReceiptPath } from './integrationReceipt';
import type { IntegrationReceipt } from './integrationReceipt';
import { RetainedCheckoutError } from './retainedCheckout';
import { RetainedCheckoutService } from './retainedCheckoutService';
import { TaskService } from './taskService';
import { WorklogService } from './worklogService';
import { readWorktreeTargetIdentity } from './worktreeTarget';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const PRIMARY = { owner: 'opencode-v1' as const, sessionId: 'ses_primary', agent: 'hive-builder' };
const sessionLog = (sessionId: string) => ({ kind: 'session' as const, owner: 'opencode-v1' as const, sessionId });
const message = (subject: string) => `${subject}\n\nFixture change.`;

/** Every path and modification time under `root`, so a read can be shown to have written nothing. */
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

async function fixture() {
  const repoPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-checkout-brief-')));
  tempDirs.push(repoPath);
  await simpleGit().raw(['init', '-b', 'main', repoPath]);
  const git = simpleGit(repoPath);
  await git.raw(['config', 'user.email', 'test@example.com']);
  await git.raw(['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repoPath, '.gitignore'), '.hive/\n');
  await git.add(['.gitignore']);
  await git.commit(message('chore: base commit'));
  const hiveDir = path.join(repoPath, '.hive');
  const config = { baseDir: repoPath, hiveDir };
  const checkouts = new RetainedCheckoutService(config);
  const adhoc = new AdhocWorktreeService(config);
  const checkoutPath = (slug: string) => path.join(hiveDir, 'checkouts', 'root', slug);
  const commitIn = async (cwd: string, file: string, subject = `feat: add ${file}`) => {
    fs.writeFileSync(path.join(cwd, file), `${file}\n`);
    await simpleGit(cwd).add([file]);
    await simpleGit(cwd).commit(message(subject));
    return (await simpleGit(cwd).revparse(['HEAD'])).trim();
  };
  /** A run targeting `target` that commits `file` and is squashed into it with same-call cleanup. */
  const squashRun = async (runId: string, target: string, file: string, options: { baseRef?: string; worklog?: ReturnType<typeof sessionLog> } = {}) => {
    const run = await adhoc.create({ runId, target, ...(options.baseRef ? { baseRef: options.baseRef } : {}), ...(options.worklog ? { origin: { worklog: options.worklog } } : {}) });
    const sourceCommit = await commitIn(run.path, file);
    const merged = await adhoc.merge(runId, 'squash', message(`feat: integrate ${runId}`), {
      historyIntent: 'rewrite-private', sourceCommit, expectedTarget: (await adhoc.inspect(runId))!.target!, cleanup: 'worktree+branch', integratedBy: PRIMARY,
    });
    expect(merged).toMatchObject({ success: true, merged: true, cleanup: { outcome: 'complete' }, provenance: { status: 'recorded' } });
    return merged.sha!;
  };
  const writeReceipt = (receipt: Omit<IntegrationReceipt, 'schemaVersion' | 'recordedAt' | 'targetRef'> & { recordedAt?: string }) => {
    const file = integrationReceiptPath(hiveDir, receipt.after);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, targetRef: null, recordedAt: '2026-01-01T00:00:00.000Z', ...receipt }));
  };
  const brief = (id: string, against?: string) => readCheckoutBrief(config, { id, ...(against ? { against } : {}) });
  return { repoPath, hiveDir, git, checkouts, adhoc, checkoutPath, commitIn, squashRun, writeReceipt, brief };
}

describe('readCheckoutBrief', () => {
  it('attributes a squashed run after its worker is gone, without writing, and resolves the destination only from against or nextTarget', async () => {
    const fx = await fixture();
    await fx.checkouts.create({ id: 'root/dest', branch: 'dest', baseRef: 'main' });
    await fx.checkouts.create({ id: 'root/x', branch: 'x', baseRef: 'main' });
    const worklog = new WorklogService(fx.repoPath);
    const RUN_AUTHOR = { ...PRIMARY, sessionId: 'ses_run' };
    worklog.record(sessionLog('ses_run'), { operationId: 'op-1', title: 'Payments run', checkpoint: { summary: 'started' }, briefing: 'Adds the payments file.', expectedRevision: 0 }, RUN_AUTHOR);
    const squash = await fx.squashRun('pay', 'root/x', 'pay.txt', { worklog: sessionLog('ses_run') });
    worklog.record(sessionLog('ses_run'), { operationId: 'op-2', checkpoint: { summary: 'merged' } }, RUN_AUTHOR);

    const before = snapshot(fx.repoPath);
    const result = await fx.brief('root/x', 'root/dest');
    expect(snapshot(fx.repoPath)).toEqual(before);

    expect(result.comparison).toMatchObject({
      status: 'resolved', destinationFrom: 'against', ahead: 1, behind: 0,
      commits: { items: [{ sha: squash, subject: 'feat: integrate pay' }], total: 1 },
      changedFiles: { items: ['pay.txt'], total: 1 },
    });
    expect(result.contributions).toEqual({
      items: [{
        commit: squash,
        strategy: 'squash',
        recordedAt: expect.any(String),
        origin: { kind: 'adhoc', runId: 'pay', worklog: sessionLog('ses_run') },
        integratedBy: PRIMARY,
        sources: {
          kind: 'adhoc',
          worklogHeader: {
            title: 'Payments run',
            briefing: { text: 'Adds the payments file.', truncated: false, recordedAt: expect.any(String) },
            updatedAt: expect.any(String),
            entryCount: 2,
          },
        },
      }],
      total: 1,
    });
    expect(result.unattributedCommits).toEqual({ items: [], total: 0 });
    expect(result.alreadyInDestination?.total).toBe(0);
    expect(result.gaps.items).toEqual([]);
    expect(result.notice).toContain('untrusted narrative');

    // Without against or a declared next target there is no comparison, only the overview.
    const overview = await fx.brief('root/x');
    expect(overview).toMatchObject({ destination: null, comparison: { status: 'unresolved' }, contributions: null, unattributedCommits: null });
    expect(overview.source).toMatchObject({ id: 'root/x', present: true, onIntendedRef: true, head: { commit: squash } });

    await fx.checkouts.setReadiness('root/x', await readWorktreeTargetIdentity(fx.checkoutPath('x')), { state: 'ready', nextTarget: 'root/dest' }, PRIMARY);
    const declared = await fx.brief('root/x');
    expect(declared.comparison).toMatchObject({ status: 'resolved', destinationFrom: 'nextTarget', ahead: 1 });
    expect(declared.destination?.id).toBe('root/dest');
    expect(declared.source.readiness).toMatchObject({ state: 'ready', headMoved: false, declaredBy: PRIMARY });
    expect(declared.source.readiness).not.toHaveProperty('declaredByWorklogKey');

    for (const [against, reason] of [['other/dest', 'invalid_destination'], ['root/x', 'invalid_destination'], ['root/missing', 'not_found']] as const) {
      const refused = await fx.brief('root/x', against).catch((error) => error);
      expect(refused).toBeInstanceOf(RetainedCheckoutError);
      expect(refused.reason).toBe(reason);
    }
  }, 120_000);

  it('follows replaced links to an upstream run whose checkout and branches are gone, and subtracts receipts the destination holds', async () => {
    const fx = await fixture();
    await fx.checkouts.create({ id: 'root/alpha', branch: 'alpha', baseRef: 'main' });
    await fx.checkouts.create({ id: 'root/beta', branch: 'beta', baseRef: 'main' });
    const upstream = await fx.squashRun('upstream', 'root/alpha', 'up.txt', { worklog: sessionLog('ses_up') });
    const onward = await fx.squashRun('onward', 'root/beta', 'on.txt', { baseRef: upstream });
    const alphaHead = await readWorktreeTargetIdentity(fx.checkoutPath('alpha'));
    expect(await fx.checkouts.cleanup('root/alpha', { expected: alphaHead, deleteBranch: { discard: true, commit: alphaHead.commit } })).toMatchObject({ recordRemoved: true });
    expect((await fx.git.raw(['branch', '--list', 'alpha'])).trim()).toBe('');

    // The upstream run's origin is reached only through the onward receipt's replaced list.
    await fx.checkouts.register({ id: 'root/main' });
    const chain = await fx.brief('root/beta', 'root/main');
    expect(chain.contributions?.items.map(({ commit, origin, reachedVia }) => ({ commit, origin, reachedVia }))).toEqual([
      { commit: onward, origin: { kind: 'adhoc', runId: 'onward' }, reachedVia: undefined },
      { commit: upstream, origin: { kind: 'adhoc', runId: 'upstream', worklog: sessionLog('ses_up') }, reachedVia: onward },
    ]);
    // The upstream run stamped a Worklog that was never written: a gap, and the rest of the brief stands.
    expect(chain.contributions?.items[1]?.sources).toEqual({ kind: 'adhoc', worklogHeader: null });
    expect(chain.gaps.items).toEqual([expect.objectContaining({ kind: 'worklog_missing', commit: upstream })]);
    expect(chain.unattributedCommits?.total).toBe(0);

    // A destination that already took the upstream squash holds it: it is already in the destination, not a contribution.
    await fx.checkouts.create({ id: 'root/gamma', branch: 'gamma', baseRef: upstream });
    const subtracted = await fx.brief('root/beta', 'root/gamma');
    expect(subtracted.contributions?.items.map((entry) => entry.commit)).toEqual([onward]);
    expect(subtracted.alreadyInDestination?.items).toEqual([{ commit: upstream, origin: { kind: 'adhoc', runId: 'upstream', worklog: sessionLog('ses_up') }, reachedVia: onward }]);
  }, 120_000);

  it('lists a stacked wave the destination squashed as already there, resolves task origins, and separates manual from merged commits', async () => {
    const fx = await fixture();
    await fx.checkouts.create({ id: 'root/x', branch: 'x', baseRef: 'main' });
    await fx.checkouts.create({ id: 'root/dest', branch: 'dest', baseRef: 'main' });
    const featureService = new FeatureService(fx.repoPath);
    const tasks = new TaskService(fx.repoPath);
    featureService.create('feat');
    const folder = tasks.create('feat', 'build api');
    tasks.update('feat', folder, { status: 'done', summary: 'API built', report: 'Author: forager-worker; basis: fixture.' });
    // A task bound to x that never merged leaves no receipt, so the brief does not name it.
    const unmerged = tasks.create('feat', 'never merged', undefined, { target: 'root/x' });
    const x = fx.checkoutPath('x');
    const xGit = simpleGit(x);
    const xBase = (await xGit.revparse(['HEAD'])).trim();

    // Wave 1: a task integration on x, later squashed into dest by a destination-side receipt that replaces it.
    const wave1 = await fx.commitIn(x, 'wave1.txt');
    fx.writeReceipt({ after: wave1, before: xBase, source: wave1, strategy: 'rebase', origin: { kind: 'adhoc', runId: 'wave-one' }, replaced: [] });
    const destSquash = await fx.commitIn(fx.checkoutPath('dest'), 'wave1-squashed.txt');
    fx.writeReceipt({ after: destSquash, before: xBase, source: wave1, strategy: 'squash', origin: { kind: 'adhoc', runId: 'dest-sync' }, replaced: [wave1] });

    // Wave 2: a preserve-source merge of a task branch, whose source commits stay reachable.
    await xGit.raw(['checkout', '-b', 'task-branch']);
    const work1 = await fx.commitIn(x, 'api-1.txt');
    const work2 = await fx.commitIn(x, 'api-2.txt');
    await xGit.raw(['checkout', 'x']);
    const beforeMerge = (await xGit.revparse(['HEAD'])).trim();
    await xGit.raw(['merge', '--no-ff', '-m', message('feat: merge api task'), 'task-branch']);
    const mergeCommit = (await xGit.revparse(['HEAD'])).trim();
    // The receipt names the feature by its indexed directory alias; the Worklog ref still uses the logical name.
    const [featureDirectory] = fs.readdirSync(path.join(fx.hiveDir, 'features')).filter((name) => /^\d+_feat$/.test(name));
    expect(featureDirectory).toBeDefined();
    fx.writeReceipt({ after: mergeCommit, before: beforeMerge, source: work2, strategy: 'merge', origin: { kind: 'task', feature: featureDirectory!, task: folder } });

    // A manual commit no receipt covers.
    const manual = await fx.commitIn(x, 'manual.txt', 'fix: manual edit');

    const result = await fx.brief('root/x', 'root/dest');
    expect(result.contributions?.items.map((entry) => entry.commit)).toEqual([mergeCommit]);
    expect(result.contributions?.items[0]?.sources).toEqual({
      kind: 'task',
      worklog: { kind: 'feature', featureName: 'feat' },
      status: 'done',
      summary: { text: 'API built', truncated: false },
      spec: expect.stringMatching(/^\.hive\/features\/.+\/tasks\/01-build-api\/spec\.md$/),
      latestReport: expect.stringMatching(/report\.md$/),
      reportHistory: expect.stringMatching(/tasks\/01-build-api\/reports$/),
    });
    expect(result.alreadyInDestination?.items).toEqual([{ commit: wave1, origin: { kind: 'adhoc', runId: 'wave-one' } }]);
    expect(result.unattributedCommits?.items).toEqual([{ sha: manual, subject: 'fix: manual edit' }]);
    expect(JSON.stringify(result)).not.toContain(unmerged);
    expect([work1, work2].some((sha) => JSON.stringify(result.unattributedCommits).includes(sha))).toBe(false);

    // An invalid status record leaves status null with a gap; the file pointers are still found.
    const taskDirectory = path.join(fx.hiveDir, 'features', featureDirectory!, 'tasks', folder);
    const validStatus = fs.readFileSync(path.join(taskDirectory, 'status.json'), 'utf8');
    fs.writeFileSync(path.join(taskDirectory, 'status.json'), JSON.stringify({ ...JSON.parse(validStatus), status: 'finished' }));
    const invalid = await fx.brief('root/x', 'root/dest');
    expect(invalid.contributions?.items[0]?.sources).toMatchObject({ kind: 'task', status: null, spec: expect.stringMatching(/spec\.md$/), latestReport: expect.stringMatching(/report\.md$/) });
    expect(invalid.gaps.items).toEqual([expect.objectContaining({ kind: 'task_unreadable', commit: mergeCommit })]);

    // Report history that cannot be listed is a gap for this contribution; status and the other pointers still return.
    fs.writeFileSync(path.join(taskDirectory, 'status.json'), validStatus);
    const reportsPath = path.join(taskDirectory, 'reports');
    const reportHistory = fs.readdirSync(reportsPath).map((name) => [name, fs.readFileSync(path.join(reportsPath, name))] as const);
    fs.rmSync(reportsPath, { recursive: true });
    fs.writeFileSync(reportsPath, 'not a directory');
    const reportsFile = await fx.brief('root/x', 'root/dest');
    expect(reportsFile.contributions?.items[0]?.sources).toEqual({
      kind: 'task',
      worklog: { kind: 'feature', featureName: 'feat' },
      status: 'done',
      summary: { text: 'API built', truncated: false },
      spec: expect.stringMatching(/spec\.md$/),
      latestReport: expect.stringMatching(/report\.md$/),
    });
    expect(reportsFile.gaps.items).toEqual([expect.objectContaining({ kind: 'task_unreadable', commit: mergeCommit, detail: expect.stringContaining('reportHistory') })]);
    fs.rmSync(reportsPath);
    fs.mkdirSync(reportsPath);
    for (const [name, content] of reportHistory) fs.writeFileSync(path.join(reportsPath, name), content);

    // A task kept only in the legacy execution/ layout is read from there.
    fs.renameSync(path.dirname(taskDirectory), path.join(fx.hiveDir, 'features', featureDirectory!, 'execution'));
    const legacy = await fx.brief('root/x', 'root/dest');
    expect(legacy.contributions?.items[0]?.sources).toMatchObject({ status: 'done', spec: expect.stringMatching(/\/execution\/01-build-api\/spec\.md$/) });

    // Without its status file, the legacy task's surviving artifacts are still found beside the task_missing gap,
    // even when an empty modern task directory sits beside the legacy one.
    fs.rmSync(path.join(fx.hiveDir, 'features', featureDirectory!, 'execution', folder, 'status.json'));
    fs.mkdirSync(taskDirectory, { recursive: true });
    const statusless = await fx.brief('root/x', 'root/dest');
    expect(statusless.contributions?.items[0]?.sources).toMatchObject({ status: null, spec: expect.stringMatching(/\/execution\/01-build-api\/spec\.md$/), reportHistory: expect.stringMatching(/\/execution\/01-build-api\/reports$/) });
    expect(statusless.gaps.items).toEqual([expect.objectContaining({ kind: 'task_missing', commit: mergeCommit })]);
  }, 120_000);

  it('follows replaced links through a receipt the destination holds and lists everything it reaches there', async () => {
    const fx = await fixture();
    await fx.checkouts.create({ id: 'root/x', branch: 'x', baseRef: 'main' });
    await fx.checkouts.create({ id: 'root/dest', branch: 'dest', baseRef: 'main' });
    const base = (await fx.git.revparse(['main'])).trim();
    // C has a receipt but no commit; only A's replaced link names it.
    const c = 'e'.repeat(40);
    fx.writeReceipt({ after: c, before: base, source: c, strategy: 'squash', origin: { kind: 'adhoc', runId: 'c' }, replaced: [] });
    const a = await fx.commitIn(fx.checkoutPath('dest'), 'a.txt');
    fx.writeReceipt({ after: a, before: base, source: a, strategy: 'squash', origin: { kind: 'adhoc', runId: 'a' }, replaced: [c] });
    const sourceSquash = await fx.commitIn(fx.checkoutPath('x'), 's.txt');
    fx.writeReceipt({ after: sourceSquash, before: base, source: sourceSquash, strategy: 'squash', origin: { kind: 'adhoc', runId: 's' }, replaced: [a] });

    const result = await fx.brief('root/x', 'root/dest');
    expect(result.contributions?.items.map((entry) => entry.commit)).toEqual([sourceSquash]);
    expect(result.alreadyInDestination).toEqual({
      items: [
        { commit: a, origin: { kind: 'adhoc', runId: 'a' }, reachedVia: sourceSquash },
        { commit: c, origin: { kind: 'adhoc', runId: 'c' }, reachedVia: a },
      ],
      total: 2,
    });
    expect(result.gaps.items).toEqual([]);
  }, 120_000);

  it('keeps the brief when a linked receipt is corrupt or replaced links form a cycle, and reports caps', async () => {
    const fx = await fixture();
    await fx.checkouts.create({ id: 'root/x', branch: 'x', baseRef: 'main' });
    await fx.checkouts.create({ id: 'root/dest', branch: 'dest', baseRef: 'main' });
    const x = fx.checkoutPath('x');
    const xBase = (await simpleGit(x).revparse(['HEAD'])).trim();
    const corruptLink = 'c'.repeat(40);
    const loopBack = 'd'.repeat(40);
    const first = await fx.commitIn(x, 'first.txt');
    fx.writeReceipt({ after: first, before: xBase, source: first, strategy: 'squash', origin: { kind: 'adhoc', runId: 'first' }, replaced: [corruptLink] });
    fs.writeFileSync(integrationReceiptPath(fx.hiveDir, corruptLink), '{"schemaVersion":1');
    const second = await fx.commitIn(x, 'second.txt');
    // second's replaced also names first, a receipt directly in the range, which therefore carries no reachedVia.
    fx.writeReceipt({ after: second, before: first, source: second, strategy: 'squash', origin: { kind: 'adhoc', runId: 'second' }, replaced: [loopBack, first] });
    fx.writeReceipt({ after: loopBack, before: first, source: second, strategy: 'squash', origin: { kind: 'adhoc', runId: 'loop' }, replaced: [second] });
    for (let index = 0; index < 51; index += 1) await simpleGit(x).commit(message(`chore: empty ${index}`), { '--allow-empty': null });

    const result = await fx.brief('root/x', 'root/dest');
    expect(result.contributions?.items.map((entry) => entry.origin)).toEqual([
      { kind: 'adhoc', runId: 'second' }, { kind: 'adhoc', runId: 'loop' }, { kind: 'adhoc', runId: 'first' },
    ]);
    expect(result.contributions?.items.map((entry) => entry.reachedVia)).toEqual([undefined, second, undefined]);
    expect(result.gaps.items.map(({ kind, commit, detail }) => ({ kind, commit, ...(kind === 'truncated' ? { detail } : {}) }))).toEqual([
      { kind: 'truncated', commit: undefined, detail: 'comparison.commits lists 50 of 53' },
      { kind: 'replaced_cycle', commit: loopBack },
      { kind: 'receipt_corrupt', commit: corruptLink },
      { kind: 'truncated', commit: undefined, detail: 'unattributedCommits lists 50 of 51' },
    ]);
    expect(result.comparison).toMatchObject({ status: 'resolved', ahead: 53, commits: { total: 53 } });
    expect((result.comparison as { commits: { items: unknown[] } }).commits.items).toHaveLength(50);
    expect(result.unattributedCommits).toMatchObject({ total: 51 });
    expect(result.unattributedCommits?.items).toHaveLength(50);
  }, 120_000);
});
