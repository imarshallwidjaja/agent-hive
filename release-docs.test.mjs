import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const workspaceRoot = path.resolve(import.meta.dirname);

function readText(relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

function sectionText(markdown, heading) {
  const headingMatch = markdown.match(new RegExp(`^(#{1,6}) ${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`, 'mi'));
  assert.ok(headingMatch, `missing section: ${heading}`);

  const sectionStart = (headingMatch.index ?? 0) + headingMatch[0].length;
  const nextHeading = new RegExp(`^#{1,${headingMatch[1].length}}\\s+`, 'gim');
  nextHeading.lastIndex = sectionStart;
  const nextHeadingMatch = nextHeading.exec(markdown);
  return markdown.slice(sectionStart, nextHeadingMatch?.index ?? markdown.length);
}

function assertInOrder(text, contracts, label) {
  let cursor = 0;

  for (const [name, pattern] of contracts) {
    const match = text.slice(cursor).match(pattern);
    assert.ok(match, `${label} is missing ${name}`);
    cursor += (match.index ?? 0) + match[0].length;
  }
}

function currentTrackedMarkdownPaths() {
  return execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.mdx'], {
    cwd: workspaceRoot,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((relativePath) => path.basename(relativePath) !== 'CHANGELOG.md')
    .filter((relativePath) => !relativePath.startsWith('docs/releases/'))
    .filter((relativePath) => fs.existsSync(path.join(workspaceRoot, relativePath)));
}

const canonicalDocs = [
  'README.md',
  'PHILOSOPHY.md',
  'docs/DESIGN.md',
  'docs/OPERATOR-GUIDE.md',
  'docs/RELEASING.md',
  'packages/opencode-hive/README.md',
  'packages/opencode-hive/docs/DATA-MODEL.md',
  'packages/opencode-hive/docs/HIVE-TOOLS.md',
  'packages/vscode-hive/README.md',
];

describe('current documentation contract', () => {
  it('keeps the canonical documents and removes obsolete documents', () => {
    for (const relativePath of canonicalDocs) {
      assert.equal(fs.existsSync(path.join(workspaceRoot, relativePath)), true, relativePath);
    }

    assert.equal(fs.existsSync(path.join(workspaceRoot, 'docs/GETTING-STARTED.md')), false);
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'packages/opencode-hive/docs/HOOK_CADENCE.md')), false);
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'plugin.json')), false);
    assert.equal(fs.existsSync(path.join(workspaceRoot, '.github/agents')), false);
    assert.equal(fs.existsSync(path.join(workspaceRoot, '.github/skills')), false);
    assert.equal(fs.existsSync(path.join(workspaceRoot, '.github/hooks')), false);
    assert.equal(fs.existsSync(path.join(workspaceRoot, '.github/instructions')), false);
    assert.equal(fs.existsSync(path.join(workspaceRoot, '.github/prompts')), false);
    assert.equal(fs.existsSync(path.join(workspaceRoot, '.github/copilot-instructions.md')), false);
  });

  it('rejects deleted-doc references in current tracked Markdown', () => {
    for (const relativePath of currentTrackedMarkdownPaths()) {
      assert.doesNotMatch(readText(relativePath), /GETTING-STARTED\.md|HOOK_CADENCE\.md/, relativePath);
      assert.doesNotMatch(readText(relativePath), /\.github\/agents\/|\.github\/skills\/|copilot-instructions\.md/, relativePath);
    }
  });

  it('keeps active documentation links and references current', () => {
    const rootReadme = readText('README.md');
    for (const relativePath of canonicalDocs.filter((relativePath) => relativePath !== 'README.md')) {
      const escapedPath = relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(rootReadme, new RegExp(`\\]\\(${escapedPath}(?:#[^)]+)?\\)`), relativePath);
    }

    assert.match(readText('PHILOSOPHY.md'), /\[root README documentation section\]\(README\.md#documentation\)/i);
  });

  it('keeps Agent Hive schema references aligned with the published schema owner', () => {
    const pluginReadme = readText('packages/opencode-hive/README.md');
    const schema = JSON.parse(readText('packages/opencode-hive/schema/agent_hive.schema.json'));
    const schemaId = schema.$id;
    const expectedSchemaUrl = 'https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json';
    assert.equal(typeof schemaId, 'string');
    assert.equal(schemaId, expectedSchemaUrl);
    const schemaUrls = [...pluginReadme.matchAll(
      /https:\/\/[^\s)"`]+\/packages\/opencode-hive\/schema\/agent_hive\.schema\.json/g,
    )].map(([url]) => url);

    assert.ok(schemaUrls.length > 0, 'package README should document an Agent Hive schema URL');
    for (const schemaUrl of schemaUrls) {
      assert.equal(schemaUrl, expectedSchemaUrl, `unexpected Agent Hive schema URL: ${schemaUrl}`);
    }
  });

  it('keeps onboarding ownership in the root README', () => {
    const rootReadme = readText('README.md');
    const requirements = sectionText(rootReadme, 'Requirements');
    const quickStart = sectionText(rootReadme, 'Quick start');

    assert.match(requirements, /single[- ]repo(?:sitory)?[\s\S]{0,80}(?:need(?:s)? no|does not need|without)[\s\S]{0,40}manifest/i);
    assert.match(requirements, /multi[- ]repo(?:sitory)?[\s\S]{0,120}topology/i);
    assert.match(requirements, /optional/i);
    assert.match(requirements, /Hive[\s\S]{0,120}(?:inspect|discover|update)/i);
    assert.match(requirements, /(?:do not|avoid|don't)[\s\S]{0,100}(?:hand[- ]?create|manually create|create manually)[\s\S]{0,100}\.hive\/repositories\.json/i);
    assert.match(quickStart, /append\s+`?oc-arkive@latest`?\s+to\s+the\s+existing\s+`?plugin`?\s+array/i);
    assert.match(quickStart, /keep\s+your\s+existing\s+plugin\s+entries/i);
    assert.match(quickStart, /preserve\s+unrelated\s+settings/i);
    assert.match(rootReadme, /## First feature loop/);
    assert.doesNotMatch(rootReadme, /A git repository root,\s+or a valid/i);
    assert.doesNotMatch(rootReadme, /task and ad-hoc worktrees need one of these/i);
  });

  it('keeps the first feature loop ordered around worker output and completion', () => {
    const firstFeatureLoop = sectionText(readText('README.md'), 'First feature loop');

    assert.match(firstFeatureLoop, /workers?[\s\S]{0,100}task-level,\s+best-effort checks[\s\S]{0,100}isolated git worktrees?/i);
    assertInOrder(firstFeatureLoop, [
      ['completed worker inspection', /operator\/orchestrator[^.]*inspects completed worker output/i],
      ['task branch merge', /merge completed task branches/i],
      ['fresh merged-result verification', /fresh build\/test verification[^.]*merged result/i],
      ['feature completion', /mark the feature complete only after/i],
    ], 'README first feature loop');
  });

  it('keeps feature and ad-hoc lifecycle boundaries explicit', () => {
    const guide = readText('docs/OPERATOR-GUIDE.md');
    const workflow = sectionText(guide, 'Choose a workflow');
    const lifecycle = sectionText(guide, 'Feature lifecycle');
    const recovery = sectionText(guide, 'When work blocks or fails');
    const reviewOptions = sectionText(guide, 'Review options');

    assert.match(workflow, /feature[\s\S]{0,220}(?:reviewed plan|dependencies|isolated task worktrees|durable execution record)/i);
    assert.match(workflow, /ad-?hoc[\s\S]{0,220}(?:not a feature|feature planning lifecycle|feature or task records)/i);
    assert.match(lifecycle, /workers?[\s\S]{0,160}task-level,\s+best-effort checks[\s\S]{0,160}isolated git worktrees?/i);
    assert.match(lifecycle, /worker commit[\s\S]{0,100}(?:does not|not) merge/i);
    assertInOrder(lifecycle, [
      ['completed worker inspection', /operator\/orchestrator[^.]*inspects completed worker output/i],
      ['task branch merge', /merge completed task branches/i],
      ['fresh merged-result verification', /fresh build\/test verification[^.]*merged result/i],
      ['feature completion', /mark the feature complete only after/i],
    ], 'Operator Guide feature lifecycle');
    assert.match(recovery, /(?:fails?|failed|partial)[\s\S]{0,220}(?:retry|normal task-start path)[\s\S]{0,150}hive_worktree_start/i);
    assert.match(recovery, /blocked[\s\S]{0,220}hive_worktree_create[\s\S]{0,180}(?:fresh|new) worker[\s\S]{0,120}(?:same|existing) worktree/i);
    assert.match(reviewOptions, /\/dash-review[\s\S]{0,160}without changing source/i);
    assert.match(reviewOptions, /\/vuln-review[\s\S]{0,220}does not[\s\S]{0,80}edit source[\s\S]{0,80}automatic fixes/i);
  });

  it('keeps detailed compatibility and operator contracts in the package README', () => {
    const pluginReadme = readText('packages/opencode-hive/README.md');

    assert.match(pluginReadme, /### Existing OpenCode configurations/);
    assert.match(pluginReadme, /The config hook intentionally mutates these OpenCode fields/);
    for (const field of ['default_agent', 'agent', 'command', 'subagent_depth', 'skills\.paths', 'experimental\.primary_tools', 'disableMcps']) {
      assert.match(pluginReadme, new RegExp(field));
    }
    assert.match(pluginReadme, /## Tools/);
    assert.match(pluginReadme, /## Configuration/);
    assert.match(pluginReadme, /### Agent mode/);
    assert.match(pluginReadme, /### Task trace summarizer/);
    assert.match(pluginReadme, /### Project-local repository manifest/);
    const agentMode = sectionText(pluginReadme, 'Agent mode');
    assert.match(agentMode, /Default is `"dedicated"`/);
    assert.match(agentMode, /`unified`/);
    assert.match(agentMode, /`dedicated`/);
    assert.match(agentMode, /hive-master/);
    assert.match(agentMode, /architect-planner/);
    assert.match(agentMode, /swarm-orchestrator/);
    const taskTrace = sectionText(pluginReadme, 'Task trace summarizer');
    assert.match(taskTrace, /recovery:\s*true/);
    assert.match(taskTrace, /temperature/);
    assert.match(taskTrace, /forensic/);
    assert.doesNotMatch(pluginReadme, /omoSlimEnabled/);
    const manifest = sectionText(pluginReadme, 'Project-local repository manifest');
    assert.match(manifest, /optional[\s\S]{0,120}Hive-managed[\s\S]{0,120}multi-repo topology/i);
    for (const command of ['hive_repositories_status', 'hive_repositories_discover', 'hive_repositories_update']) {
      assert.match(manifest, new RegExp(`\\b${command}\\b`));
    }
    assert.match(manifest, /Generated\/managed shape/);
    assert.match(pluginReadme, /### Vulnerability Review/);
    assert.doesNotMatch(pluginReadme, /valid <project>\/\.hive\/repositories\.json manifest/i);
    assert.doesNotMatch(pluginReadme, /worktree-based execution/i);
  });

  it('keeps safety-critical blocked-worker, config, and review anchors', () => {
    const pluginReadme = readText('packages/opencode-hive/README.md');
    const toolDocs = readText('packages/opencode-hive/docs/HIVE-TOOLS.md');
    const hiveSkill = readText('packages/hive-core/templates/skills/hive.md');

    assert.match(hiveSkill, /blocked task.*existing worktree.*fresh worker session/is);
    assert.match(pluginReadme, /runtime configuration only from .*agent_hive\.json/i);
    assert.match(pluginReadme, /hook_cadence.*no useful tuning surface/is);
    assert.match(pluginReadme, /no active exploitation.*no network scanning.*no source edits/is);
    assert.match(toolDocs, /hive_review_workspace_create/);
    assert.match(toolDocs, /runtime gates|runtime-gated/i);

    const schema = JSON.parse(readText('packages/opencode-hive/schema/agent_hive.schema.json'));
    const hookCadence = schema.properties.hook_cadence;
    assert.match(hookCadence.description, /production.*tool\.execute\.before.*forced to cadence 1/i);
    assert.deepEqual(hookCadence.examples, [{ 'tool.execute.before': 1 }]);
  });

  it('keeps the philosophy document as a pointer, not a catalog', () => {
    const philosophy = readText('PHILOSOPHY.md');

    assert.match(philosophy, /root README documentation section/);
    assert.doesNotMatch(philosophy, /Tool catalogs, command matrices, and config field lists/);
  });

  it('keeps release guidance aligned with the manual workflow_dispatch flow', () => {
    const releasing = readText('docs/RELEASING.md');
    const agents = readText('AGENTS.md');

    assert.doesNotMatch(releasing, /release:prepare/);
    assert.match(releasing, /manual/i);
    assert.match(releasing, /workflow_dispatch/);
    assert.doesNotMatch(agents, /bun run release:prepare/);
    assert.match(agents, /release:check/);
  });
});
