import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

const workspaceRoot = path.resolve(import.meta.dirname);
const releaseVersion = readJson('package.json').version;
const opencodeHiveRoot = path.join(workspaceRoot, 'packages', 'opencode-hive');
const bunBinary = resolveBunBinary();

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

function resolveBunBinary() {
  const homeDirectory = os.homedir();
  const candidates = [
    process.env.BUN_BINARY,
    process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun') : null,
    homeDirectory ? path.join(homeDirectory, '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun') : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const command = process.platform === 'win32' ? 'where' : 'which';
    return execFileSync(command, ['bun'], {
      encoding: 'utf8',
    }).trim().split(/\r?\n/, 1)[0];
  } catch {
    return null;
  }
}

function getCommandEnv() {
  if (!bunBinary) {
    return process.env;
  }

  return {
    ...process.env,
    PATH: `${path.dirname(bunBinary)}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

function runPackageCommand(packageRoot, command, args) {
  return execFileSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    env: getCommandEnv(),
  });
}

function ensurePackageBuilt(packageRoot) {
  runPackageCommand(packageRoot, 'npm', ['run', 'build']);
}

function listPackedFiles(packageRoot) {
  ensurePackageBuilt(packageRoot);

  const stdout = runPackageCommand(packageRoot, 'npm', ['pack', '--dry-run', '--json']);

  const [packResult] = JSON.parse(stdout);

  return new Set(packResult.files.map((file) => file.path));
}

function assertPackedFile(fileSet, relativePath, packageName) {
  assert.equal(
    fileSet.has(relativePath),
    true,
    `${packageName} asset missing from npm pack dry run: ${relativePath}`
  );
}

describe(`release ${releaseVersion} artifact contract on main`, () => {
  it(`bumps root and OpenCode runtime manifests to ${releaseVersion}`, () => {
    for (const file of [
      'package.json',
      'packages/hive-core/package.json',
      'packages/opencode-hive/package.json',
      'packages/vscode-hive/package.json',
    ]) {
      assert.equal(readJson(file).version, releaseVersion, `${file} should be ${releaseVersion}`);
    }
  });

  it(`refreshes tracked OpenCode lockfile markers to ${releaseVersion}`, () => {
    const packageLock = readJson('package-lock.json');
    const bunLock = readText('bun.lock');
    const escapedReleaseVersion = releaseVersion.replaceAll('.', '\\.');

    assert.equal(packageLock.version, releaseVersion, `package-lock.json root version should be ${releaseVersion}`);
    assert.equal(packageLock.packages[''].version, releaseVersion, `package-lock.json workspace root should be ${releaseVersion}`);
    assert.equal(packageLock.packages['packages/hive-core'].version, releaseVersion, `package-lock.json hive-core version should be ${releaseVersion}`);
    assert.equal(packageLock.packages['packages/opencode-hive'].version, releaseVersion, `package-lock.json oc-arkive version should be ${releaseVersion}`);
    assert.equal(packageLock.packages['node_modules/oc-arkive']?.resolved, 'packages/opencode-hive', 'package-lock.json should link oc-arkive to packages/opencode-hive');
    assert.equal(packageLock.packages['node_modules/opencode-hive'], undefined, 'package-lock.json should not keep the old opencode-hive workspace link');
    assert.equal(packageLock.packages['packages/vscode-hive'].version, releaseVersion, `package-lock.json vscode-arkive version should be ${releaseVersion}`);
    assert.equal(packageLock.packages['node_modules/vscode-arkive']?.resolved, 'packages/vscode-hive', 'package-lock.json should link vscode-arkive to packages/vscode-hive');
    assert.equal(packageLock.packages['node_modules/vscode-hive'], undefined, 'package-lock.json should not keep the old vscode-hive workspace link');

    assert.match(bunLock, new RegExp(`"name": "hive-core",\\s+"version": "${escapedReleaseVersion}"`, 's'));
    assert.match(bunLock, new RegExp(`"name": "oc-arkive",\\s+"version": "${escapedReleaseVersion}"`, 's'));
    assert.match(bunLock, new RegExp(`"name": "vscode-arkive",\\s+"version": "${escapedReleaseVersion}"`, 's'));
    assert.match(bunLock, /"oc-arkive": \["oc-arkive@workspace:packages\/opencode-hive"\]/);
    assert.match(bunLock, /"vscode-arkive": \["vscode-arkive@workspace:packages\/vscode-hive"\]/);
    assert.doesNotMatch(bunLock, /"opencode-hive": \["opencode-hive@workspace:packages\/opencode-hive"\]/);
    assert.doesNotMatch(bunLock, /"vscode-hive": \["vscode-hive@workspace:packages\/vscode-hive"\]/);
  });

  it(`refreshes the OpenCode plugin manifest to ${releaseVersion}`, () => {
    const opencodePluginJson = readJson('packages/opencode-hive/plugin.json');

    assert.equal(opencodePluginJson.version, releaseVersion, `packages/opencode-hive/plugin.json should be ${releaseVersion}`);
  });

  it(`publishes ${releaseVersion} release notes and changelog entries in descending order`, () => {
    assert.equal(
      fs.existsSync(path.join(workspaceRoot, `docs/releases/v${releaseVersion}.md`)),
      true,
      `docs/releases/v${releaseVersion}.md should exist`
    );

    const changelog = readText('CHANGELOG.md');
    const changelogCurrentHeader = `## [${releaseVersion}]`;
    const previousVersionMatch = changelog.match(/^## \[(?!Unreleased\])([^\]]+)\]/m);
    const previousVersionHeader = previousVersionMatch ? `## [${previousVersionMatch[1]}]` : null;

    assert.notEqual(
      changelog.indexOf(changelogCurrentHeader),
      -1,
      `CHANGELOG.md should include a ${releaseVersion} entry`
    );

    if (previousVersionHeader !== null && previousVersionHeader !== changelogCurrentHeader) {
      assert.notEqual(
        changelog.indexOf(previousVersionHeader),
        -1,
        `CHANGELOG.md should include a ${previousVersionHeader} entry`
      );
      assert.ok(
        changelog.indexOf(changelogCurrentHeader) < changelog.indexOf(previousVersionHeader),
        `CHANGELOG.md should list ${releaseVersion} before ${previousVersionHeader.replace('## [', '').replace(']', '')}`
      );
    }
  });

  it('removes the broken release:prepare helper and runs the release artifact contract from release:check', () => {
    const packageJson = readJson('package.json');

    assert.equal(packageJson.scripts['release:prepare'], undefined, 'package.json should not advertise release:prepare');
    assert.equal(typeof packageJson.scripts['release:check'], 'string', 'package.json should keep release:check');
    assert.match(
      packageJson.scripts['release:check'],
      /node --test release-artifacts\.test\.mjs/,
      'package.json should run the release artifact contract from release:check'
    );
    const hiveCoreBuildIndex = packageJson.scripts['release:check'].indexOf('bun run --filter hive-core build');
    const vscodeBuildIndex = packageJson.scripts['release:check'].indexOf('bun run --filter vscode-arkive build');
    const vscodeBundleTestIndex = packageJson.scripts['release:check'].indexOf('node --test release-vscode-bundle.test.mjs');

    assert.notEqual(hiveCoreBuildIndex, -1, 'package.json should build hive-core from release:check');
    assert.notEqual(vscodeBuildIndex, -1, 'package.json should build vscode-arkive from release:check');
    assert.notEqual(vscodeBundleTestIndex, -1, 'package.json should run release-vscode-bundle.test.mjs from release:check');
    assert.ok(
      hiveCoreBuildIndex < vscodeBundleTestIndex,
      'package.json should build hive-core before release-vscode-bundle.test.mjs'
    );
    assert.ok(
      vscodeBuildIndex < vscodeBundleTestIndex,
      'package.json should build vscode-arkive before release-vscode-bundle.test.mjs'
    );
  });

  it('packs every oc-arkive asset promised by the README install contract', () => {
    const packedFiles = listPackedFiles(opencodeHiveRoot);

    assertPackedFile(packedFiles, 'dist/index.js', 'oc-arkive');
    assert.ok(
      [...packedFiles].some((filePath) => filePath.startsWith('skills/')),
      'README-promised oc-arkive asset missing from npm pack dry run: skills/'
    );
    assertPackedFile(packedFiles, 'templates/mcp-servers.json', 'oc-arkive');
    assertPackedFile(packedFiles, 'templates/context/tools.md', 'oc-arkive');
  });

});
