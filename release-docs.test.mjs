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
    const services = read('packages/opencode-hive/src/runtime/hive-services.ts');
    const tools = read('packages/opencode-hive/src/runtime/hive-tools.ts');
    const policy = read('packages/opencode-hive/src/runtime/role-policy.ts');
    const dispatch = read('packages/opencode-hive/src/task-brief.ts');
    for (const removed of [
      'ExecutionAttemptService',
      'ExecutionFinalizationService',
      'resolveSessionAuthority',
      'shouldRejectTaskIdReuse',
      'ReviewWorkspaceService',
      'ReviewEvidenceBundleService',
    ]) assert.doesNotMatch([runtime, services, tools, policy, dispatch].join('\n'), new RegExp(removed), removed);
    assert.match(tools, /hive_feature_select/);
    assert.match(policy, /hive_feature_select/);
    assert.match(services, /sourceDirectory cannot be combined with repoIds/);
    assert.match(runtime, /composeDispatchPrompt/);
    assert.match(dispatch, /hive-route-snapshot/);
  });

  it('keeps release guidance on the manual workflow', () => {
    const releasing = read('docs/RELEASING.md');
    assert.doesNotMatch(releasing, /release:prepare/);
    assert.match(releasing, /workflow_dispatch/);
    assert.match(read('AGENTS.md'), /release:check/);
  });

  it('keeps dual-host setup and authority guidance consistent with the shipped entries', () => {
    const plugin = read('packages/opencode-hive/README.md');
    const tools = read('packages/opencode-hive/docs/HIVE-TOOLS.md');
    const guide = read('docs/OPERATOR-GUIDE.md');
    const agents = read('AGENTS.md');
    assert.doesNotMatch(plugin, /background orchestration and session-trace tools are not yet/);
    assert.match(plugin, /37 Hive tools.*11 commands/);
    assert.match(plugin, /Published.*4\.1\.0.*v1-only/);
    assert.match(plugin, /"readTransport": "direct"/);
    assert.match(plugin, /"package": "\/absolute\/install\/node_modules\/oc-arkive\/dist"/);
    assert.match(plugin, /"subagent_depth": 2/);
    assert.match(plugin, /passwordEnv/);
    assert.match(plugin, /Create the artifact directory before packing/);
    assert.match(plugin, /connecting CLI process needs the same password in its own environment/);
    assert.match(plugin, /`OPENCODE_PASSWORD`.*legacy `OPENCODE_SERVER_PASSWORD`/);
    assert.match(plugin, /`server\.passwordEnv` selects the environment variable for Hive's reader.*does not configure CLI authentication/);
    assert.match(plugin, /existing native direct child whose Hive binding is missing or has no parent/);
    assert.match(plugin, /top-level session uses the explicit CLI\/session model/);
    assert.match(plugin, /trusted shell\/tool subprocesses/);
    assert.match(tools, /every Hive executor and the native `execute.before` hook/);
    assert.match(tools, /singleton.*unknown/);
    assert.doesNotMatch(tools, /read_access\.code/);
    assert.match(tools, /`read_access` string names.*`not_configured`, `unauthorized`, `unreachable`, `wrong_location`, `wrong_instance`, `caller_unavailable` or `caller_displaced`/);
    assert.match(tools, /`target_unavailable` and `inconsistent_lookup`.*`unavailable_or_unauthorized` without `read_access`/);
    assert.match(tools, /existing native direct child whose Hive binding is missing or has no parent/);
    assert.match(tools, /Ordinary v1 trace\/content cancellation behavior is unchanged/);
    assert.match(tools, /there is no later sweeper/);
    assert.match(guide, /Never copy, merge or rename a native store/);
    assert.match(guide, /separate native config\/data\/cache home/);
    assert.match(guide, /Database is not empty and has no session table/);
    assert.match(agents, /Set direct reads when `execute` is denied/);
    assert.match(agents, /existing native direct child whose Hive binding is missing or has no parent/);
  });
});
