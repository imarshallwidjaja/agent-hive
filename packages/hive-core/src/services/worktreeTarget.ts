import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';

export interface WorktreeTargetIdentity {
  path: string;
  ref: string | null;
  commit: string;
}

export type WorktreeTargetComparison =
  | { status: 'ok'; targetIsAncestorOfSource: boolean }
  | { status: 'no-common-ancestor' }
  | { status: 'error'; error: string };

export interface WorktreeTargetInspection {
  target: WorktreeTargetIdentity | null;
  comparison: WorktreeTargetComparison;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function gitError(operation: string, result: GitResult): Error {
  return new Error(`${operation} failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ` with exit code ${result.code}`}`);
}

export async function readWorktreeTargetIdentity(repositoryPath: string): Promise<WorktreeTargetIdentity> {
  const canonicalPath = await fs.realpath(path.resolve(repositoryPath));
  const commitResult = await runGit(canonicalPath, ['rev-parse', '--verify', 'HEAD']);
  if (commitResult.code !== 0) throw gitError('Reading target commit', commitResult);

  const refResult = await runGit(canonicalPath, ['symbolic-ref', '-q', 'HEAD']);
  if (refResult.code !== 0 && refResult.code !== 1) throw gitError('Reading target ref', refResult);
  const ref = refResult.code === 0 ? refResult.stdout.trim() : null;
  if (ref !== null && !ref.startsWith('refs/heads/')) {
    throw new Error(`Target ref is not a local branch: ${ref}`);
  }

  return { path: canonicalPath, ref, commit: commitResult.stdout.trim() };
}

export async function compareWorktreeTarget(
  repositoryPath: string,
  targetCommit: string,
  sourceCommit: string,
): Promise<WorktreeTargetComparison> {
  try {
    const ancestor = await runGit(repositoryPath, ['merge-base', '--is-ancestor', targetCommit, sourceCommit]);
    if (ancestor.code === 0) return { status: 'ok', targetIsAncestorOfSource: true };
    if (ancestor.code !== 1) return { status: 'error', error: gitError('Comparing target ancestry', ancestor).message };

    const common = await runGit(repositoryPath, ['merge-base', targetCommit, sourceCommit]);
    if (common.code === 0 && common.stdout.trim()) return { status: 'ok', targetIsAncestorOfSource: false };
    if (common.code === 1) return { status: 'no-common-ancestor' };
    return { status: 'error', error: gitError('Finding common ancestry', common).message };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

export async function inspectWorktreeTarget(
  repositoryPath: string,
  sourceCommit: string,
): Promise<WorktreeTargetInspection> {
  try {
    const target = await readWorktreeTargetIdentity(repositoryPath);
    return {
      target,
      comparison: await compareWorktreeTarget(target.path, target.commit, sourceCommit),
    };
  } catch (error) {
    return {
      target: null,
      comparison: { status: 'error', error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export function isWorktreeTargetIdentity(value: unknown): value is WorktreeTargetIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  return keys.length === 3
    && keys[0] === 'commit'
    && keys[1] === 'path'
    && keys[2] === 'ref'
    && typeof candidate.path === 'string'
    && path.isAbsolute(candidate.path)
    && (candidate.ref === null || (typeof candidate.ref === 'string' && candidate.ref.startsWith('refs/heads/')))
    && typeof candidate.commit === 'string'
    && /^[0-9a-f]{40,64}$/.test(candidate.commit);
}

export function sameWorktreeTarget(
  expected: WorktreeTargetIdentity,
  observed: WorktreeTargetIdentity,
): boolean {
  return expected.path === observed.path
    && expected.ref === observed.ref
    && expected.commit === observed.commit;
}

export function validateTargetExpectations(
  repoIds: string[] | null,
  expectedTarget: unknown,
  expectedTargets: unknown,
): { expectedTarget?: WorktreeTargetIdentity; expectedTargets?: Record<string, WorktreeTargetIdentity> } {
  if (expectedTarget !== undefined && expectedTargets !== undefined) {
    throw new Error('expectedTarget and expectedTargets cannot both be supplied');
  }
  if (expectedTarget === undefined && expectedTargets === undefined) {
    throw new Error('expectedTarget or expectedTargets is required');
  }

  if (repoIds === null) {
    if (expectedTargets !== undefined) throw new Error('expectedTargets require a composite candidate');
    if (!isWorktreeTargetIdentity(expectedTarget)) throw new Error('expectedTarget is malformed');
    return { expectedTarget };
  }

  if (expectedTarget !== undefined) {
    if (repoIds.length !== 1) throw new Error('expectedTarget cannot select a multi-repository composite candidate');
    if (!isWorktreeTargetIdentity(expectedTarget)) throw new Error('expectedTarget is malformed');
    return { expectedTargets: { [repoIds[0]!]: expectedTarget } };
  }
  if (typeof expectedTargets !== 'object' || expectedTargets === null || Array.isArray(expectedTargets)) {
    throw new Error('expectedTargets is malformed');
  }
  const entries = Object.entries(expectedTargets as Record<string, unknown>);
  const actualKeys = entries.map(([id]) => id).sort();
  const wantedKeys = [...repoIds].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(wantedKeys)) {
    throw new Error('expectedTargets must exactly match every candidate repository');
  }
  if (entries.some(([, identity]) => !isWorktreeTargetIdentity(identity))) {
    throw new Error('expectedTargets contains a malformed identity');
  }
  return { expectedTargets: expectedTargets as Record<string, WorktreeTargetIdentity> };
}
