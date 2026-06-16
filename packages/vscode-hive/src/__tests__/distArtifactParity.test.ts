import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const bundle = fs.readFileSync(new URL('../../dist/extension.js', import.meta.url), 'utf8');
const packageDir = path.resolve(import.meta.dirname, '../..');
const bundlePath = path.join(packageDir, 'dist', 'extension.js');

describe('shipped extension artifact parity', () => {
  it('includes overview comment routing and storage in the bundle', () => {
    expect(bundle).toContain('context/overview.md');
    expect(bundle).toContain('comments/overview.json');
  });

  it('uses canonical plan comments path comments/plan.json in dist', () => {
    expect(bundle).toContain('comments/plan.json');
  });

  it('does not contain the structural LM registration API string in the bundle', () => {
    const registrationApi = ['register', 'Tool'].join('');
    expect(bundle).not.toContain(registrationApi);
  });

  it('includes the background jobs and tracked repositories viewers in dist', () => {
    expect(bundle).toContain('background-jobs.json');
    expect(bundle).toContain('agent-hive.json');
    expect(bundle).toContain('hive.backgroundJobs');
    expect(bundle).toContain('hive.repositories');
  });

  it('does not ship operational background job commands in dist', () => {
    expect(bundle).not.toContain('hive.background.cancel');
    expect(bundle).not.toContain('hive.background.reconcile');
    expect(bundle).not.toContain('hive.background.ignore');
  });

  it('keeps the committed bundle aligned with source rebuilds', () => {
    const before = fs.readFileSync(bundlePath, 'utf8');

    execFileSync('bun', ['run', 'build'], {
      cwd: packageDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const after = fs.readFileSync(bundlePath, 'utf8');

    expect(after).toBe(before);
  });
});
