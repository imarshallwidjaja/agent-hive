import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { integrationReceiptPath, listIntegrationReceiptCommits, readIntegrationReceipt, recordIntegrationReceipt } from './integrationReceipt.js';
import type { AppliedIntegration } from './integrationReceipt.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function repoWithHistory(): Promise<{ hiveDir: string; git: ReturnType<typeof simpleGit>; commits: string[] }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-integration-receipt-'));
  tempDirs.push(root);
  const git = simpleGit(root);
  await git.raw(['init', '-b', 'main']);
  await git.raw(['config', 'user.email', 'test@example.com']);
  await git.raw(['config', 'user.name', 'Test User']);
  const commits: string[] = [];
  for (const name of ['base', 'middle', 'tip']) {
    await fs.writeFile(path.join(root, `${name}.txt`), `${name}\n`);
    await git.add([`${name}.txt`]);
    await git.commit(`chore: ${name}\n\nAdd fixture history.`);
    commits.push((await git.revparse(['HEAD'])).trim());
  }
  return { hiveDir: path.join(root, '.hive'), git, commits };
}

const AFTER = 'a'.repeat(40);

describe('integration receipts', () => {
  it('is write-once: a different receipt fails and is kept, and an identical one that loses the publish race is recorded', async () => {
    const { hiveDir, git, commits } = await repoWithHistory();
    const applied: AppliedIntegration = { git, before: commits[0]!, after: AFTER, source: commits[2]!, targetRef: 'refs/heads/main', strategy: 'merge' };
    const origin = { kind: 'task' as const, feature: 'feat', task: '01-task' };

    const first = await recordIntegrationReceipt(hiveDir, applied, origin);
    expect(first).toEqual({ status: 'recorded', path: integrationReceiptPath(hiveDir, AFTER) });
    const stored = await fs.readFile(integrationReceiptPath(hiveDir, AFTER), 'utf8');
    // The writer does not look before publishing, so a second identical record reaches the exclusive link, finds the
    // name taken (as a concurrent writer that published first would leave it) and compares content.
    expect(await recordIntegrationReceipt(hiveDir, applied, origin)).toEqual(first);
    expect(await fs.readFile(integrationReceiptPath(hiveDir, AFTER), 'utf8')).toBe(stored);

    const differing = await recordIntegrationReceipt(hiveDir, applied, { kind: 'adhoc', runId: 'other' });
    expect(differing).toMatchObject({ status: 'failed', error: expect.stringContaining('already exists') });
    expect(await fs.readFile(integrationReceiptPath(hiveDir, AFTER), 'utf8')).toBe(stored);
    expect((await readIntegrationReceipt(hiveDir, AFTER))?.origin).toEqual(origin);
    expect((await fs.readdir(path.dirname(integrationReceiptPath(hiveDir, AFTER))))).toEqual([`${AFTER}.json`]);

    // A receipt holds one origin; one without a valid `origin`, such as an `origins` array, is corrupt.
    const other = 'b'.repeat(40);
    const { origin: _origin, ...withoutOrigin } = JSON.parse(stored);
    await fs.writeFile(integrationReceiptPath(hiveDir, other), JSON.stringify({ ...withoutOrigin, after: other, origins: [origin] }));
    await expect(readIntegrationReceipt(hiveDir, other)).rejects.toMatchObject({ reason: 'corrupt', message: expect.stringContaining('origin is malformed') });
  });

  it('never lists a rebase that reproduces its source as replacing itself, so an identical repeat stays recorded', async () => {
    const { hiveDir, git, commits } = await repoWithHistory();
    const applied: AppliedIntegration = { git, before: commits[0]!, after: commits[2]!, source: commits[2]!, targetRef: 'refs/heads/main', strategy: 'rebase' };
    const origin = { kind: 'adhoc' as const, runId: 'fast-forward' };

    expect(await recordIntegrationReceipt(hiveDir, applied, origin)).toMatchObject({ status: 'recorded' });
    // The repeat sees its own receipt in before..source; listing it would make the content differ.
    expect(await recordIntegrationReceipt(hiveDir, applied, origin)).toMatchObject({ status: 'recorded' });
    expect((await readIntegrationReceipt(hiveDir, commits[2]!))?.replaced).toEqual([]);
  });

  it('links receipted commits in a rewritten range by file name, even when that receipt is corrupt', async () => {
    const { hiveDir, git, commits } = await repoWithHistory();
    await fs.mkdir(path.dirname(integrationReceiptPath(hiveDir, commits[1]!)), { recursive: true });
    await fs.writeFile(integrationReceiptPath(hiveDir, commits[1]!), '{"schemaVersion":1');

    const outcome = await recordIntegrationReceipt(
      hiveDir,
      { git, before: commits[0]!, after: AFTER, source: commits[2]!, targetRef: null, strategy: 'squash' },
      { kind: 'adhoc', runId: 'run' },
    );
    expect(outcome).toMatchObject({ status: 'recorded' });
    expect(await readIntegrationReceipt(hiveDir, AFTER)).toMatchObject({ origin: { kind: 'adhoc', runId: 'run' }, replaced: [commits[1]] });
    expect(await listIntegrationReceiptCommits(hiveDir)).toEqual([AFTER, commits[1]!].sort());
  });
});
