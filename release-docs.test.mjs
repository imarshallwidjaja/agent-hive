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
    assert.equal(manifest.tools.length, 38);
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
      'hive_context_edit',
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
    assert.match(plugin, /38 Hive tools.*11 commands/);
    assert.match(plugin, /\*\*5\.0\.0\*\* is the first release that serves both OpenCode hosts/);
    assert.match(plugin, /Releases through 4\.2\.0 are v1-only/);
    assert.match(plugin, /^### OpenCode v2$/m);
    assert.match(plugin, /npm install oc-arkive@5\.0\.0/);
    assert.match(plugin, /host-side registry resolution at first use was not part of it/);
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
    assert.match(guide, /Hive reads `~\/\.config\/opencode\/agent_hive\.json` from `HOME`.*not from `XDG_CONFIG_HOME`/);
    assert.match(guide, /does not configure native authentication/);
    assert.match(agents, /Set direct reads when `execute` is denied/);
    assert.match(agents, /existing native direct child whose Hive binding is missing or has no parent/);
    assert.match(agents, /5\.0\.0 is the first dual-host release; releases through 4\.2\.0 are v1-only/);
  });

  it('retires pre-release v2 wording and keeps host setup links on their canonical anchor', () => {
    const current = [
      'README.md',
      'AGENTS.md',
      'docs/OPERATOR-GUIDE.md',
      'docs/RELEASING.md',
      'packages/opencode-hive/README.md',
      'packages/opencode-hive/docs/HIVE-TOOLS.md',
    ];
    for (const relativePath of current) {
      const text = read(relativePath);
      assert.doesNotMatch(text, /unreleased checkout/i, relativePath);
      assert.doesNotMatch(text, /opencode-v2-unreleased-checkout/, relativePath);
      assert.doesNotMatch(text, /[Pp]ublished `?(?:oc-arkive@)?4\.1\.0`? is v1-only/, relativePath);
    }
    for (const relativePath of ['README.md', 'docs/OPERATOR-GUIDE.md', 'packages/opencode-hive/docs/HIVE-TOOLS.md']) {
      assert.match(read(relativePath), /README\.md#opencode-v2\)/, relativePath);
    }
  });

  it('provisions Hive configuration in the new home before the host handover starts the new host', () => {
    const guide = read('docs/OPERATOR-GUIDE.md');
    const steps = guide.split('To hand over one project sequentially:\n\n')[1].split('\n\n')[0].split('\n');
    steps.forEach((step, index) => assert.ok(step.startsWith(`${index + 1}. `), step));
    const indexOf = (pattern) => steps.findIndex((step) => pattern.test(step));
    const home = indexOf(/^\d+\. Give the other host a separate native config\/data\/cache home before you start it/);
    const config = indexOf(/^\d+\. Provision Agent Hive's own configuration in that home before the first start.*agent_hive\.json/);
    const start = indexOf(/^\d+\. Start the other host/);
    assert.ok(home >= 0 && config > home && start > config, `home ${home}, config ${config}, start ${start}`);
    assert.doesNotMatch(steps[start], /agent_hive\.json.*(copy|recreate)/);
  });

  it('keeps the current release body free of repository-relative Markdown links', () => {
    const version = JSON.parse(read('package.json')).version;
    const body = read(`docs/releases/v${version}.md`);
    const targets = [...body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g)].map(([, target]) => target);
    assert.ok(targets.length > 0, 'release body should link its guides');
    for (const target of targets) assert.match(target, /^(?:https?:\/\/|#)/, `${target} would not resolve in a GitHub Release body`);
  });

  it('links every changelog release heading from the current release onward', () => {
    const changelog = read('CHANGELOG.md');
    const version = JSON.parse(read('package.json')).version;
    const escaped = version.replace(/\./g, '\\.');
    assert.match(changelog, new RegExp(`^\\[Unreleased\\]: .*/compare/v${escaped}\\.\\.\\.HEAD$`, 'm'));
    for (const [, heading] of changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)) {
      if (heading.split('.').map(Number)[0] < 4) break;
      assert.match(changelog, new RegExp(`^\\[${heading.replace(/\./g, '\\.')}\\]: https://`, 'm'), heading);
    }
  });
});
