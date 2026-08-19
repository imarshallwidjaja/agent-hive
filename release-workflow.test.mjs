import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const workspaceRoot = path.resolve(import.meta.dirname);

function readText(relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readPublishOcArkiveJob() {
  const workflow = readText('.github/workflows/release.yml');
  const match = workflow.match(/^ {2}publish-oc-arkive:[\s\S]*?(?=^ {2}\w[\w-]*:)/m);
  assert.ok(match, 'expected a publish-oc-arkive job block in .github/workflows/release.yml');
  return match[0];
}

async function loadNpmPublishAccessHelper() {
  const helperPath = path.join(workspaceRoot, '.github', 'scripts', 'verify-npm-publish-access.mjs');

  if (!fs.existsSync(helperPath)) {
    return null;
  }

  return import(pathToFileURL(helperPath).href);
}

describe('release workflow recovery contract', () => {
  it('adds workflow_dispatch rehearsal defaults plus explicit tag-only recovery inputs', () => {
    const workflow = readText('.github/workflows/release.yml');

    assert.match(workflow, /workflow_dispatch:\s+inputs:/s);
    assert.match(workflow, /release_mode:\s+[\s\S]*default:\s*rehearse/s);
    assert.match(workflow, /recovery_tag:\s+[\s\S]*description:\s*['"]Existing v\* tag to recover['"]/s);
    assert.match(workflow, /recover_oc_arkive:\s+[\s\S]*default:\s*false/s);
    assert.match(workflow, /recover_github_release:\s+[\s\S]*default:\s*false/s);
  });

  it('fails fast for invalid recovery submissions before the build starts', () => {
    const workflow = readText('.github/workflows/release.yml');

    assert.match(workflow, /prepare:/);
    assert.match(workflow, /requested recovery tag must start with v/i);
    assert.match(workflow, /No recovery targets were selected/i);
    assert.match(workflow, /git ls-remote --exit-code --refs --tags "https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\.git" "refs\/tags\/\$\{requested_tag\}"/);
    assert.match(workflow, /build:\s+[\s\S]*needs:\s*prepare/s);
  });

  it('computes the effective checkout ref and resolved release tag for downstream jobs', () => {
    const workflow = readText('.github/workflows/release.yml');

    assert.match(workflow, /outputs:\s+[\s\S]*checkout_ref:/s);
    assert.match(workflow, /outputs:\s+[\s\S]*release_tag:/s);
    assert.match(workflow, /outputs:\s+[\s\S]*publish_oc_arkive:/s);
    assert.match(workflow, /ref:\s*\$\{\{ needs\.prepare\.outputs\.checkout_ref \}\}/);
    assert.match(workflow, /fetch-depth:\s*0/);
    assert.match(workflow, /fetch-tags:\s*true/);
    assert.match(workflow, /name:\s*release-notes/);
    assert.match(workflow, /docs\/releases\/\$\{\{ needs\.prepare\.outputs\.release_tag \}\}\.md/);
  });

  it('validates the tagged release package version and release notes before publishing', () => {
    const workflow = readText('.github/workflows/release.yml');

    assert.match(workflow, /name:\s*Validate release inputs/);
    assert.match(workflow, /Release tag \$\{release_tag\} does not match package version \$\{expected_release_tag\}/);
    assert.match(workflow, /release notes file missing: docs\/releases\/\$\{release_tag\}\.md/);
    assert.match(workflow, /if-no-files-found:\s*error/);
  });

  it('publishes oc-arkive and attaches vscode-arkive VSIX to the GitHub Release', () => {
    const workflow = readText('.github/workflows/release.yml');
    const packageJson = readJson('package.json');

    assert.doesNotMatch(workflow, /publish-hive-mcp:/);
    assert.doesNotMatch(workflow, /publish-claude-code-hive:/);
    assert.doesNotMatch(workflow, /recover_vscode_extension:/);
    assert.doesNotMatch(workflow, /publish_vscode_extension:/);
    assert.doesNotMatch(workflow, /publish-vscode-arkive:/);
    assert.doesNotMatch(workflow, /VSCE_PAT/);
    assert.match(workflow, /bun run package/);
    assert.match(workflow, /actions\/upload-artifact@v4/);
    assert.match(workflow, /vscode-arkive\.vsix/);
    assert.match(workflow, /files:\s*packages\/vscode-hive\/vscode-arkive\.vsix/);
    assert.match(packageJson.scripts['release:check'], /node --test release-workflow\.test\.mjs/);
  });
});

describe('npm publish access helper', () => {
  it('accepts read-write collaborator access', async () => {
    const helperModule = await loadNpmPublishAccessHelper();

    assert.ok(helperModule, 'expected .github/scripts/verify-npm-publish-access.mjs to exist');
    assert.equal(
      helperModule.validateNpmPublishAccess({
        npmUser: 'release-bot',
        collaborators: {
          'release-bot': 'read-write',
        },
        packageName: 'oc-arkive',
      }),
      'read-write'
    );
  });

  it('treats a missing package as first-publish-ready when auth is present', async () => {
    const helperModule = await loadNpmPublishAccessHelper();

    assert.ok(helperModule, 'expected .github/scripts/verify-npm-publish-access.mjs to exist');
    assert.deepEqual(
      helperModule.interpretPublishReadiness({
        npmUser: 'release-bot',
        packageName: 'oc-arkive',
        packageExists: false,
        collaborators: null,
      }),
      {
        status: 'first-publish',
        npmUser: 'release-bot',
        packageName: 'oc-arkive',
      }
    );
  });

  it('skips collaborator lookup when the package does not exist yet', async () => {
    const helperModule = await loadNpmPublishAccessHelper();

    assert.ok(helperModule, 'expected .github/scripts/verify-npm-publish-access.mjs to exist');

    let collaboratorLookupCalls = 0;
    const readiness = helperModule.resolvePublishReadiness({
      npmUser: 'release-bot',
      packageName: 'oc-arkive',
      packageExists: false,
      readCollaborators() {
        collaboratorLookupCalls += 1;
        return { 'release-bot': 'read-write' };
      },
    });

    assert.equal(collaboratorLookupCalls, 0);
    assert.equal(readiness.status, 'first-publish');
  });

  it('rejects missing collaborator entries', async () => {
    const helperModule = await loadNpmPublishAccessHelper();

    assert.ok(helperModule, 'expected .github/scripts/verify-npm-publish-access.mjs to exist');
    assert.throws(
      () =>
        helperModule.validateNpmPublishAccess({
          npmUser: 'release-bot',
          collaborators: {},
          packageName: 'oc-arkive',
        }),
      /npm user release-bot is not listed as a collaborator on oc-arkive/
    );
  });

  it('rejects weaker-than-read-write collaborator access', async () => {
    const helperModule = await loadNpmPublishAccessHelper();

    assert.ok(helperModule, 'expected .github/scripts/verify-npm-publish-access.mjs to exist');
    assert.throws(
      () =>
        helperModule.validateNpmPublishAccess({
          npmUser: 'release-bot',
          collaborators: {
            'release-bot': 'read-only',
          },
          packageName: 'oc-arkive',
        }),
      /npm user release-bot has read-only access to oc-arkive; expected read-write/
    );
  });

  it('publishes oc-arkive to npm through GitHub OIDC trusted publishing without static tokens', () => {
    const workflow = readText('.github/workflows/release.yml');
    const job = readPublishOcArkiveJob();

    assert.match(job, /id-token:\s*write/);
    assert.match(job, /contents:\s*read/);
    assert.match(job, /runs-on:\s*ubuntu-latest/);
    assert.match(job, /actions\/setup-node@v\d+/);
    assert.match(job, /node-version:\s*'24'/);
    assert.match(job, /npm install -g npm@\^11\.5\.1/);
    assert.match(job, /npm view/);
    assert.match(job, /skip=true/);
    assert.match(job, /run: npm publish --access public[ \t]*$/m);
    assert.doesNotMatch(job, /--provenance/);

    assert.doesNotMatch(workflow, /NPM_KEY/);
    assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
    assert.doesNotMatch(workflow, /node \.github\/scripts\/verify-npm-publish-access\.mjs opencode-hive/);
    assert.doesNotMatch(workflow, /node -e/);
  });
});

describe('release recovery docs contract', () => {
  it('documents rehearsal defaults, release targets, tag-only recovery, and operator-selected recovery targets', () => {
    const releasing = readText('docs/RELEASING.md');
    const agents = readText('AGENTS.md');

    assert.match(releasing, /workflow_dispatch/);
    assert.match(releasing, /Manual `workflow_dispatch` runs default to `rehearse`/i);
    assert.match(releasing, /requested version/i);
    assert.match(releasing, /absent requested version is publish-ready/i);
    assert.match(releasing, /already-published requested version skips publishing/i);
    assert.match(releasing, /provenance/i);
    assert.match(releasing, /Recovery mode is only for existing .*vX\.Y\.Z.* tags/i);
    assert.match(releasing, /publishes `oc-arkive` to npm/i);
    assert.doesNotMatch(releasing, /VS Code Marketplace/i);
    assert.match(releasing, /attaches `vscode-arkive\.vsix` to the GitHub Release/i);
    assert.match(releasing, /requires a recovery tag and at least one explicit target toggle/i);
    assert.match(releasing, /rerun only the unfinished targets/i);
    assert.match(releasing, /`oc-arkive` and\/or GitHub Release/i);
    assert.match(releasing, /release-only recovery remains possible when npm was intentionally skipped/i);
    assert.match(agents, /attaches `vscode-arkive\.vsix` to the GitHub Release/i);
  });
});
