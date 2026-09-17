import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = path.resolve(import.meta.dirname);
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('release documentation and runtime contract', () => {
  it('keeps canonical documentation artifacts present', () => {
    for (const relativePath of [
      'README.md',
      'PHILOSOPHY.md',
      'docs/DESIGN.md',
      'docs/OPERATOR-GUIDE.md',
      'docs/RELEASING.md',
      'packages/opencode-hive/README.md',
      'packages/opencode-hive/docs/DATA-MODEL.md',
      'packages/opencode-hive/docs/HIVE-TOOLS.md',
      'packages/vscode-hive/README.md',
    ]) assert.equal(fs.existsSync(path.join(root, relativePath)), true, relativePath);
  });

  it('publishes only the canonical tool runtime', () => {
    const manifest = JSON.parse(read('packages/opencode-hive/plugin.json'));
    assert.equal(manifest.tools.length, 37);
    for (const required of [
      'hive_feature_select',
      'hive_worktree_create',
      'hive_worktree_inspect',
      'hive_worktree_merge',
      'hive_worktree_cleanup',
      'hive_adhoc_worktree_create',
      'hive_adhoc_worktree_inspect',
      'hive_adhoc_worktree_merge',
      'hive_adhoc_worktree_cleanup',
      'hive_git_snapshot',
    ]) assert.ok(manifest.tools.includes(required), required);
    for (const removed of [
      'hive_execution_prepare',
      'hive_execution_finish',
      'hive_worktree_discard',
      'hive_merge',
      'hive_adhoc_merge',
      'hive_adhoc_cleanup',
      'hive_review_evidence_resolve',
      'hive_review_workspace_create',
    ]) assert.equal(manifest.tools.includes(removed), false, removed);
  });

  it('keeps active runtime source free of removed admission and private-review machinery', () => {
    const runtime = read('packages/opencode-hive/src/runtime.ts');
    for (const removed of [
      'ExecutionAttemptService',
      'ExecutionFinalizationService',
      'resolveSessionAuthority',
      'shouldRejectTaskIdReuse',
      'ReviewWorkspaceService',
      'ReviewEvidenceBundleService',
    ]) assert.doesNotMatch(runtime, new RegExp(removed), removed);
    assert.match(runtime, /hive_feature_select/);
    assert.match(runtime, /sourceDirectory cannot be combined with repoIds/);
    assert.match(runtime, /hive-route-snapshot/);
  });

  it('keeps release guidance on the manual workflow', () => {
    const releasing = read('docs/RELEASING.md');
    assert.doesNotMatch(releasing, /release:prepare/);
    assert.match(releasing, /workflow_dispatch/);
    assert.match(read('AGENTS.md'), /release:check/);
  });
});
