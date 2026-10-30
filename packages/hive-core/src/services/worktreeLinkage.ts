/**
 * Physical identity checks for Hive worktree checkouts.
 *
 * A path that names the right place can still lead somewhere else: a symlinked
 * component, or a `.git` pointer that selects another repository's
 * administration directory, sends file reads and every Git command run in the
 * checkout to that other place. These checks establish that a checkout is the
 * exact registered worktree of a trusted repository before anything is read
 * through it or Git runs in it. Each step reads only a path an earlier step has
 * shown to lie inside the checkout or the trusted Git common directory, so a
 * corrupt or planted pointer is refused before the location it names is read.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { WorktreeLinkageError } from './worktreeOutcome.js';

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Refuse a symlink in any component of `candidate` below `root`. With
 * `allowMissing`, a missing component ends the check: nothing below it exists.
 */
export async function assertNoSymlinkComponents(root: string, candidate: string, allowMissing = false): Promise<void> {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw new WorktreeLinkageError(`Worktree linkage preflight failed: cannot inspect path component ${current}: ${error.message}`);
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new WorktreeLinkageError(`Worktree linkage preflight failed: path contains a symlink (${current})`);
    }
  }
}

/**
 * Establish that `worktreePath` is the exact linked worktree registered in the
 * trusted repository whose Git common directory `commonDirectory` resolves:
 * no symlinked path component, a regular `.git` pointer file selecting an
 * administration entry under that common directory's `worktrees/`, and that
 * entry's `commondir` and `gitdir` backlink naming the same common directory
 * and this checkout. The common directory is resolved only after the checkout
 * path itself passed the symlink check.
 */
export async function validateExactWorktreeRegistration(
  worktreePath: string,
  commonDirectory: () => Promise<string>,
  repositoryId: string,
): Promise<void> {
  await assertNoSymlinkComponents(path.parse(worktreePath).root, worktreePath);
  const trustedCommonDirectory = await commonDirectory();
  const localGitPath = path.join(worktreePath, '.git');
  const localGitStat = await fs.lstat(localGitPath).catch(() => null);
  if (!localGitStat?.isFile() || localGitStat.isSymbolicLink()) {
    throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repositoryId}: local .git must be a regular pointer file`);
  }
  const pointer = await fs.readFile(localGitPath, 'utf8');
  const match = pointer.match(/^gitdir:\s*(.+?)\s*$/);
  if (!match) throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repositoryId}: invalid local .git pointer`);
  const administrationPath = path.normalize(path.isAbsolute(match[1]!)
    ? match[1]!
    : path.resolve(worktreePath, match[1]!));
  const worktreesDirectory = path.join(trustedCommonDirectory, 'worktrees');
  if (!isContained(worktreesDirectory, administrationPath) || administrationPath === worktreesDirectory) {
    throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repositoryId}: administration entry is outside the trusted Git common directory`);
  }
  await assertNoSymlinkComponents(trustedCommonDirectory, administrationPath);
  await assertNoSymlinkComponents(administrationPath, path.join(administrationPath, 'commondir'));
  await assertNoSymlinkComponents(administrationPath, path.join(administrationPath, 'gitdir'));

  const commondirBytes = await fs.readFile(path.join(administrationPath, 'commondir'), 'utf8');
  const selectedCommonDirectory = path.normalize(path.resolve(administrationPath, commondirBytes.trim()));
  if (selectedCommonDirectory !== path.normalize(trustedCommonDirectory)) {
    throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repositoryId}: commondir does not match the trusted repository`);
  }
  const backlinkBytes = await fs.readFile(path.join(administrationPath, 'gitdir'), 'utf8');
  const backlink = path.normalize(path.isAbsolute(backlinkBytes.trim())
    ? backlinkBytes.trim()
    : path.resolve(administrationPath, backlinkBytes.trim()));
  if (backlink !== path.normalize(localGitPath)) {
    throw new WorktreeLinkageError(`Worktree linkage preflight failed for repository ${repositoryId}: administration backlink does not select this exact worktree`);
  }
}
