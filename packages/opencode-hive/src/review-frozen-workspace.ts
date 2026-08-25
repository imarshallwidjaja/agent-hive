import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type ReviewWorkspaceServiceKind = 'git' | 'evidence-bundle';

export type FrozenWorkspaceRootIdentity = Readonly<{
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  serviceKind: ReviewWorkspaceServiceKind;
}>;

function matchesPinnedIdentity(
  pinned: FrozenWorkspaceRootIdentity,
  stat: Awaited<ReturnType<typeof fs.lstat>>,
): boolean {
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && BigInt(stat.dev) === pinned.dev
    && BigInt(stat.ino) === pinned.ino
    && BigInt(stat.mode) === pinned.mode;
}

async function assertPinnedRoot(
  pinned: FrozenWorkspaceRootIdentity,
  expectedServiceKind: ReviewWorkspaceServiceKind,
): Promise<void> {
  if (pinned.serviceKind !== expectedServiceKind) {
    throw new Error('Review frozen workspace identity has the wrong service kind.');
  }
  try {
    const [stat, canonicalPath] = await Promise.all([
      fs.lstat(pinned.canonicalPath, { bigint: true }),
      fs.realpath(pinned.canonicalPath),
    ]);
    if (canonicalPath !== pinned.canonicalPath || !matchesPinnedIdentity(pinned, stat)) {
      throw new Error('mismatch');
    }
  } catch {
    throw new Error('Review frozen workspace identity no longer matches the claimed root.');
  }
}

export async function pinFrozenWorkspaceRoot(
  workspacePath: string,
  serviceKind: ReviewWorkspaceServiceKind,
): Promise<FrozenWorkspaceRootIdentity> {
  const absolutePath = path.resolve(workspacePath);
  try {
    const [stat, canonicalPath] = await Promise.all([
      fs.lstat(absolutePath, { bigint: true }),
      fs.realpath(absolutePath),
    ]);
    if (canonicalPath !== absolutePath || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('mismatch');
    }
    return Object.freeze({
      canonicalPath,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      serviceKind,
    });
  } catch {
    throw new Error('Review frozen workspace identity could not be pinned to a real directory.');
  }
}

export async function assertFrozenWorkspaceToolBoundary(
  toolName: string,
  args: Record<string, unknown> | undefined,
  pinned: FrozenWorkspaceRootIdentity,
  expectedServiceKind: ReviewWorkspaceServiceKind,
): Promise<void> {
  const field = toolName === 'read'
    ? 'filePath'
    : toolName === 'glob' || toolName === 'grep'
      ? 'path'
      : toolName === 'ast_grep_find_code' || toolName === 'ast_grep_find_code_by_rule'
        ? 'project_folder'
        : undefined;
  if (!field) return;
  const candidate = args?.[field];
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new Error(`Review frozen workspace authorization requires an absolute ${field}.`);
  }
  await assertPinnedRoot(pinned, expectedServiceKind);
  let target: string;
  try {
    target = await fs.realpath(candidate);
  } catch {
    throw new Error('Review frozen workspace authorization could not verify the requested path.');
  }
  const relative = path.relative(pinned.canonicalPath, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Review frozen workspace authorization denied a live or external source path.');
  }
  await assertPinnedRoot(pinned, expectedServiceKind);
}
