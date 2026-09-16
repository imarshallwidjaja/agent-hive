import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

function hasGitMetadata(rootDir) {
  return fs.existsSync(path.join(rootDir, '.git'));
}

function gitTrackedMarkdownPaths(rootDir) {
  return execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.mdx'], {
    cwd: rootDir,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

const discoverySkippedDirectories = new Set([
  '.claude',
  '.git',
  '.hive',
  '.hive2',
  '.idea',
  '.opencode',
  '.sisyphus',
  '.tmp',
  '.vscode',
  'coverage',
  'dist',
  'gistpad',
  'node_modules',
  'opencode-antigravity-auth',
  'out',
  'tmp',
]);

function walkedMarkdownPaths(rootDir) {
  const relativePaths = [];
  const pending = [''];

  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const entries = fs.readdirSync(path.join(rootDir, relativeDirectory), { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!discoverySkippedDirectories.has(entry.name)) pending.push(relativePath);
      } else if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
        relativePaths.push(relativePath);
      }
    }
  }

  return relativePaths.sort();
}

function documentationMarkdownPaths(rootDir) {
  // Canonical checkouts use Git's tracked set; isolated release staging trees
  // copy repository artifacts without .git metadata and need the file walk.
  const discovered = hasGitMetadata(rootDir)
    ? gitTrackedMarkdownPaths(rootDir)
    : walkedMarkdownPaths(rootDir);

  return discovered
    .filter((relativePath) => path.basename(relativePath) !== 'CHANGELOG.md')
    .filter((relativePath) => !relativePath.startsWith('docs/releases/'))
    .filter((relativePath) => fs.existsSync(path.join(rootDir, relativePath)));
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

describe('documentation artifact discovery', () => {
  it('discovers the documentation set from artifacts when Git metadata is absent', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-docs-discovery-'));

    try {
      fs.mkdirSync(path.join(fixtureRoot, 'docs', 'releases'), { recursive: true });
      fs.mkdirSync(path.join(fixtureRoot, 'node_modules', 'dependency'), { recursive: true });
      fs.mkdirSync(path.join(fixtureRoot, 'dist'), { recursive: true });
      fs.mkdirSync(path.join(fixtureRoot, '.hive', 'features'), { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'README.md'), '# README\n');
      fs.writeFileSync(path.join(fixtureRoot, 'guide.mdx'), '# Guide\n');
      fs.writeFileSync(path.join(fixtureRoot, 'CHANGELOG.md'), '# Changelog\n');
      fs.writeFileSync(path.join(fixtureRoot, 'docs', 'DESIGN.md'), '# Design\n');
      fs.writeFileSync(path.join(fixtureRoot, 'docs', 'releases', 'v1.0.0.md'), '# Release\n');
      fs.writeFileSync(path.join(fixtureRoot, 'node_modules', 'dependency', 'README.md'), '# Dependency\n');
      fs.writeFileSync(path.join(fixtureRoot, 'dist', 'bundle.md'), '# Bundle\n');
      fs.writeFileSync(path.join(fixtureRoot, '.hive', 'features', 'plan.md'), '# Plan\n');

      for (const ignoredLocation of ['.tmp', 'gistpad', 'opencode-antigravity-auth']) {
        fs.mkdirSync(path.join(fixtureRoot, ignoredLocation), { recursive: true });
        fs.writeFileSync(
          path.join(fixtureRoot, ignoredLocation, 'obsolete-references.md'),
          '# Obsolete\n\nSee GETTING-STARTED.md, HOOK_CADENCE.md, and .github/agents/.\n',
        );
      }

      assert.equal(hasGitMetadata(fixtureRoot), false);
      assert.deepEqual(documentationMarkdownPaths(fixtureRoot), [
        'README.md',
        'docs/DESIGN.md',
        'guide.mdx',
      ]);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('discovers every canonical document from repository artifacts', () => {
    const discovered = new Set(documentationMarkdownPaths(workspaceRoot));

    for (const relativePath of canonicalDocs) {
      assert.equal(discovered.has(relativePath), true, relativePath);
    }
  });
});

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
    for (const relativePath of documentationMarkdownPaths(workspaceRoot)) {
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

    assert.match(firstFeatureLoop, /workers?[\s\S]{0,100}task-level,\s+best-effort checks[\s\S]{0,140}isolated git worktree[\s\S]{0,80}in-place directory/i);
    assert.match(firstFeatureLoop, /hive_execution_finish[\s\S]{0,140}worker output[\s\S]{0,80}report path/i);
    assert.match(firstFeatureLoop, /in-place task has no Hive Git\s+merge step/i);
    assertInOrder(firstFeatureLoop, [
      ['completed worker inspection', /operator\/orchestrator[^.]*inspects completed worker output/i],
      ['task branch merge', /merge completed worktree task branches/i],
      ['fresh target verification', /fresh build\/test verification[\s\S]*merged worktree result[\s\S]*live in-place target/i],
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
    assert.match(lifecycle, /workers?[\s\S]{0,160}task-level,\s+best-effort checks[\s\S]{0,180}isolated git worktree[\s\S]{0,100}in-place directory/i);
    assert.match(lifecycle, /hive_execution_finish[\s\S]{0,160}(?:does not|not) merge/i);
    assertInOrder(lifecycle, [
      ['completed worker inspection', /operator\/orchestrator[^.]*inspects completed worker output/i],
      ['task branch merge', /merge completed worktree task branches/i],
      ['fresh merged-result verification', /fresh build\/test verification[^.]*merged result/i],
      ['feature completion', /mark the feature complete only after/i],
    ], 'Operator Guide feature lifecycle');
    assert.match(lifecycle, /in-place tasks have no Hive merge step[\s\S]{0,80}verify the live target/i);
    assertInOrder(recovery, [
      ['failed or partial outcome', /(?:fails?|failed|partial)/i],
      ['finalization', /hive_execution_finish/i],
      ['status re-check', /hive_status/i],
      ['retry preparation', /hive_execution_prepare/i],
    ], 'Operator Guide failed or partial recovery');
    assert.match(recovery, /fails or reports partial[\s\S]{0,220}exact stop evidence[\s\S]{0,320}do not call `hive_execution_finish`[\s\S]{0,160}prepare a retry/i);
    assertInOrder(recovery, [
      ['blocked outcome', /blocked/i],
      ['blocked continuation', /continueFromBlocked/i],
      ['fresh worker', /(?:fresh|new) worker/i],
      ['exact worktree identities', /exact registered worktree identities/i],
      ['exact in-place directory', /exact resolved in-place directory/i],
    ], 'Operator Guide blocked recovery');
    assertInOrder(recovery, [
      ['immutable blocker report', /immutable `reportPath`/i],
      ['persisted blocker', /persisted blocker/i],
      ['reconstruction prohibition', /do not reconstruct blocker details from worker prose or task traces/i],
    ], 'Operator Guide blocker authority');
    assert.match(recovery, /blocker containing a nonblank `reason`/i);
    assert.match(recovery, /tasks\.list\[\]\.blocker/i);
    assert.match(recovery, /legacy blocked status without blocker data requires inspection/i);
    assert.match(recovery, /stale finalization writes immutable history without replacing the latest pointer/i);
    assert.match(recovery, /merge or clean up a finalized registered worktree before switching.*in-place/is);
    assert.match(reviewOptions, /\/dash-review[\s\S]{0,160}without changing source/i);
    assert.match(reviewOptions, /\/vuln-review[\s\S]{0,220}does not[\s\S]{0,80}edit source[\s\S]{0,80}automatic fixes/i);
  });

  it('keeps active execution and repository-manifest contracts current', () => {
    const changelog = readText('CHANGELOG.md');
    const unreleasedStart = changelog.indexOf('## [Unreleased]');
    const unreleasedEnd = changelog.indexOf('\n## [', unreleasedStart + 1);
    assert.notEqual(unreleasedStart, -1, 'missing Unreleased changelog section');
    const unreleased = changelog.slice(unreleasedStart, unreleasedEnd === -1 ? undefined : unreleasedEnd);
    const design = readText('docs/DESIGN.md');

    assert.match(unreleased, /hive_execution_prepare/);
    assert.match(unreleased, /hive_execution_finish/);
    assert.match(unreleased, /unobserved feature-task attempt remains quarantined/i);
    assert.match(unreleased, /unobserved ad-hoc run cannot be reused/i);
    for (const removed of ['hive_launch_id', 'launchId', 'hive_adhoc_worktree_start', 'attemptSlot']) {
      assert.doesNotMatch(unreleased, new RegExp(removed));
    }
    assert.match(design, /fails worktree placement, worktree finalization, and merge/i);
    assert.match(design, /In-place placement and finalization still require an explicit existing directory/i);
    assert.doesNotMatch(design, /tasks\.json/);
    assert.match(design, /TaskService\.sync[\s\S]{0,160}status\.json[\s\S]{0,80}spec\.md/i);
    assert.match(design, /TaskService\.create[\s\S]{0,160}append-only manual tasks/i);
    assert.match(readText('AGENTS.md'), /tasks\/[\s\S]{0,100}status\.json[\s\S]{0,100}spec\.md/i);
    assert.doesNotMatch(readText('AGENTS.md'), /tasks\.json/);
    const recoveryTable = sectionText(readText('packages/opencode-hive/docs/HIVE-TOOLS.md'), 'Recovery fields and failure classification');
    assert.match(recoveryTable, /`phase`[\s\S]{0,180}`finalization`/i);
    assert.match(recoveryTable, /`FINALIZATION_STATE_UNKNOWN`\s*\|\s*`finalization`\s*\|\s*`unknown`\s*\|\s*`false`\s*\|\s*`inspect_state`/i);
    assert.match(design, /updates `report\.md`[\s\S]{0,100}only when.*current task generation/i);
    assert.match(design, /merge or clean up its registered finalized worktree before switching to in-place placement/i);
    const toolDocs = readText('packages/opencode-hive/docs/HIVE-TOOLS.md');
    assert.match(toolDocs, /status: 'blocked'[\s\S]{0,100}blocker\.reason[\s\S]{0,80}nonblank/i);
    assert.match(toolDocs, /task `report\.md` links the receipt only for the current generation/i);
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
