import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import ts from 'typescript';

const workspaceRoot = path.resolve(import.meta.dirname);
const releaseVersion = readJson('package.json').version;
const hiveCoreRoot = path.join(workspaceRoot, 'packages', 'hive-core');
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

function withPackedPackage(packageRoot, inspect) {
  ensurePackageBuilt(hiveCoreRoot);
  ensurePackageBuilt(packageRoot);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-arkive-pack-'));
  const extractedRoot = path.join(temporaryRoot, 'extracted');
  fs.mkdirSync(extractedRoot);

  try {
    const stdout = runPackageCommand(packageRoot, 'npm', ['pack', '--json', '--pack-destination', temporaryRoot]);
    const packed = JSON.parse(stdout);
    // npm 12 keys pack results by package name; older npm returns an array.
    const results = Array.isArray(packed) ? packed : Object.values(packed);
    assert.equal(results.length, 1, 'Expected exactly one packed package');
    const [packResult] = results;
    const tarballPath = path.join(temporaryRoot, packResult.filename);
    execFileSync('tar', ['-xzf', tarballPath, '-C', extractedRoot]);
    return inspect(path.join(extractedRoot, 'package'), new Set(packResult.files.map((file) => file.path)));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertPackedFile(fileSet, relativePath, packageName) {
  assert.equal(
    fileSet.has(relativePath),
    true,
    `${packageName} asset missing from npm pack dry run: ${relativePath}`
  );
}

const artifactTreeSkippedDirectories = new Set([
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

function copyReleaseArtifactTree(sourceRoot, targetRoot) {
  fs.cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (sourcePath) => !artifactTreeSkippedDirectories.has(path.basename(sourcePath)),
  });
}

const localityIgnoredRoots = ['.tmp', 'gistpad', 'opencode-antigravity-auth'];

const obsoleteReferenceMarkdown =
  '# Obsolete references\n\nGETTING-STARTED.md, HOOK_CADENCE.md, and .github/agents/.\n';

const preexistingReferenceMarkdown =
  '# Operator-authored obsolete references\n\nGETTING-STARTED.md\n';

function plantLocalityFixtures(sourceRoot) {
  const fixtures = [];

  for (const location of localityIgnoredRoots) {
    const ownedRoot = path.join(sourceRoot, location);
    fs.mkdirSync(ownedRoot, { recursive: true });
    const ownedDirectory = fs.mkdtempSync(path.join(ownedRoot, 'oc-arkive-fixture-'));
    const markdownPath = path.join(ownedDirectory, 'obsolete-references.md');
    fs.writeFileSync(markdownPath, obsoleteReferenceMarkdown);
    fixtures.push({ location, markdownPath });
  }

  return fixtures;
}

function childTestEnv() {
  // A nested Node test runner must not inherit the parent runner's child-test
  // context: NODE_TEST_CONTEXT makes it suppress its own report.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function isHiveCoreSpecifier(specifier) {
  return specifier === 'hive-core' || specifier.startsWith('hive-core/');
}

function staticModuleSpecifiers(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  );
  const specifiers = new Set(sourceFile.typeReferenceDirectives.map((reference) => reference.fileName));
  const addStringLiteral = (node) => {
    if (ts.isStringLiteralLike(node)) specifiers.add(node.text);
  };

  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      addStringLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (node.moduleReference.expression) addStringLiteral(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addStringLiteral(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && node.arguments[0]) addStringLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

function assertNoHiveCoreModuleReference(source, fileName) {
  const references = [...staticModuleSpecifiers(source, fileName)].filter(isHiveCoreSpecifier);
  assert.deepEqual(references, [], `${fileName} should not reference unpacked hive-core modules`);
}

function assertNoModuleReferences(source, fileName, forbiddenModules) {
  const references = [...staticModuleSpecifiers(source, fileName)].filter((specifier) =>
    forbiddenModules.some((moduleName) => specifier === moduleName || specifier.startsWith(`${moduleName}/`))
  );
  assert.deepEqual(references, [], `${fileName} should not reference removed direct dependencies`);
}

function declarationEntrypoints(packageJson) {
  const entrypoints = new Set();
  if (typeof packageJson.types === 'string') entrypoints.add(packageJson.types);
  if (typeof packageJson.typings === 'string') entrypoints.add(packageJson.typings);

  const visitExports = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'types' && typeof child === 'string') entrypoints.add(child);
      else visitExports(child);
    }
  };
  visitExports(packageJson.exports);
  return [...entrypoints];
}

function resolveDeclarationReference(filePath, specifier) {
  const unresolved = path.resolve(path.dirname(filePath), specifier);
  const candidates = [
    unresolved,
    `${unresolved}.d.ts`,
    path.join(unresolved, 'index.d.ts'),
  ];
  if (/\.(?:mjs|cjs|js)$/.test(unresolved)) {
    candidates.push(unresolved.replace(/\.(?:mjs|cjs|js)$/, '.d.ts'));
  }
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function assertPackedDeclarationGraph(packageRoot, packageJson) {
  const entrypoints = declarationEntrypoints(packageJson);
  assert.ok(entrypoints.length > 0, 'packed oc-arkive manifest should declare a public type entrypoint');

  const pending = entrypoints.map((entrypoint) => path.resolve(packageRoot, entrypoint));
  const visited = new Set();
  while (pending.length > 0) {
    const filePath = pending.pop();
    assert.ok(filePath.startsWith(`${packageRoot}${path.sep}`), `declaration path escapes package: ${filePath}`);
    assert.ok(fs.existsSync(filePath), `packed declaration entrypoint or dependency is missing: ${path.relative(packageRoot, filePath)}`);
    if (visited.has(filePath)) continue;
    visited.add(filePath);

    const source = fs.readFileSync(filePath, 'utf8');
    assertNoHiveCoreModuleReference(source, path.relative(packageRoot, filePath));
    for (const specifier of staticModuleSpecifiers(source, filePath)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveDeclarationReference(filePath, specifier);
      assert.ok(resolved, `packed declaration dependency is missing: ${specifier} from ${path.relative(packageRoot, filePath)}`);
      pending.push(resolved);
    }
  }
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
    const coreVersion = readJson('packages/hive-core/package.json').version;
    const opencodeManifest = readJson('packages/opencode-hive/package.json');
    const vscodeManifest = readJson('packages/vscode-hive/package.json');
    const escapedReleaseVersion = releaseVersion.replaceAll('.', '\\.');

    assert.equal(opencodeManifest.devDependencies['hive-core'], coreVersion, 'oc-arkive should pin its hive-core devDependency to the exact workspace version');
    assert.equal(vscodeManifest.dependencies['hive-core'], coreVersion, 'vscode-arkive should pin its hive-core dependency to the exact workspace version');
    assert.equal(opencodeManifest.dependencies?.['hive-core'], undefined, 'oc-arkive should not ship hive-core as a runtime dependency');
    assert.equal(opencodeManifest.optionalDependencies?.['hive-core'], undefined, 'oc-arkive should not ship hive-core as an optional dependency');
    assert.equal(opencodeManifest.peerDependencies?.['hive-core'], undefined, 'oc-arkive should not expose hive-core as a peer dependency');

    assert.equal(packageLock.version, releaseVersion, `package-lock.json root version should be ${releaseVersion}`);
    assert.equal(packageLock.packages[''].version, releaseVersion, `package-lock.json workspace root should be ${releaseVersion}`);
    assert.equal(packageLock.packages['packages/hive-core'].version, releaseVersion, `package-lock.json hive-core version should be ${releaseVersion}`);
    assert.equal(packageLock.packages['packages/opencode-hive'].version, releaseVersion, `package-lock.json oc-arkive version should be ${releaseVersion}`);
    assert.equal(packageLock.packages['node_modules/oc-arkive']?.resolved, 'packages/opencode-hive', 'package-lock.json should link oc-arkive to packages/opencode-hive');
    assert.equal(packageLock.packages['node_modules/opencode-hive'], undefined, 'package-lock.json should not keep the old opencode-hive workspace link');
    assert.equal(packageLock.packages['packages/vscode-hive'].version, releaseVersion, `package-lock.json vscode-arkive version should be ${releaseVersion}`);
    assert.equal(packageLock.packages['node_modules/vscode-arkive']?.resolved, 'packages/vscode-hive', 'package-lock.json should link vscode-arkive to packages/vscode-hive');
    assert.equal(packageLock.packages['node_modules/vscode-hive'], undefined, 'package-lock.json should not keep the old vscode-hive workspace link');
    assert.deepEqual(
      packageLock.packages['node_modules/hive-core'],
      { resolved: 'packages/hive-core', link: true },
      'package-lock.json should link hive-core to the local workspace'
    );

    assert.match(bunLock, new RegExp(`"name": "hive-core",\\s+"version": "${escapedReleaseVersion}"`, 's'));
    assert.match(bunLock, new RegExp(`"name": "oc-arkive",\\s+"version": "${escapedReleaseVersion}"`, 's'));
    assert.match(bunLock, new RegExp(`"name": "vscode-arkive",\\s+"version": "${escapedReleaseVersion}"`, 's'));
    assert.match(bunLock, /"oc-arkive": \["oc-arkive@workspace:packages\/opencode-hive"\]/);
    assert.match(bunLock, /"vscode-arkive": \["vscode-arkive@workspace:packages\/vscode-hive"\]/);
    assert.doesNotMatch(bunLock, /"opencode-hive": \["opencode-hive@workspace:packages\/opencode-hive"\]/);
    assert.doesNotMatch(bunLock, /"vscode-hive": \["vscode-hive@workspace:packages\/vscode-hive"\]/);
  });

  it('distinguishes real hive-core module references from comments and ordinary strings', () => {
    assert.doesNotThrow(() => assertNoHiveCoreModuleReference(
      "// import 'hive-core'\nconst packageName = 'hive-core';",
      'allowed.js'
    ));

    for (const source of [
      "import value from 'hive-core';",
      "export { value } from 'hive-core/subpath';",
      "const value = import('hive-core');",
      "const value = require('hive-core/subpath');",
      "type Value = import('hive-core').Value;",
      "/// <reference types=\"hive-core\" />",
    ]) {
      assert.throws(() => assertNoHiveCoreModuleReference(source, 'rejected.ts'), /unpacked hive-core modules/);
    }
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

  it('packs every oc-arkive asset without unresolved hive-core module references', () => {
    withPackedPackage(opencodeHiveRoot, (packageRoot, packedFiles) => {
      assertPackedFile(packedFiles, 'dist/index.js', 'oc-arkive');
      assert.ok(
        [...packedFiles].some((filePath) => filePath.startsWith('skills/')),
        'README-promised oc-arkive asset missing from npm pack: skills/'
      );
      const packedManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
      assert.deepEqual(packedManifest.dependencies, { 'gray-matter': '^4.0.3' });
      const removedDirectDependencies = ['effect', 'simple-git'];
      for (const dependencyType of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        assert.equal(
          packedManifest[dependencyType]?.['hive-core'],
          undefined,
          `packed oc-arkive manifest should not include hive-core in ${dependencyType}`
        );
        for (const dependency of removedDirectDependencies) {
          assert.equal(
            packedManifest[dependencyType]?.[dependency],
            undefined,
            `packed oc-arkive manifest should not include ${dependency} in ${dependencyType}`
          );
        }
      }

      const executablePath = path.resolve(packageRoot, packedManifest.main);
      assert.ok(executablePath.startsWith(`${packageRoot}${path.sep}`), 'packed executable path should stay inside the package');
      assert.ok(fs.existsSync(executablePath), `packed executable is missing: ${packedManifest.main}`);
      const executableSource = fs.readFileSync(executablePath, 'utf8');
      assertNoHiveCoreModuleReference(executableSource, packedManifest.main);
      assertNoModuleReferences(executableSource, packedManifest.main, removedDirectDependencies);
      assertPackedDeclarationGraph(packageRoot, packedManifest);
    });
  });

});

describe('release documentation artifact locality', () => {
  it('runs the documentation contract in an isolated staging tree without Git metadata', () => {
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-arkive-docs-staging-'));
    const fixtureSource = path.join(scratchRoot, 'source');
    const stagingRoot = path.join(scratchRoot, 'staging');

    try {
      copyReleaseArtifactTree(workspaceRoot, fixtureSource);
      const preexistingPaths = localityIgnoredRoots.map((location) => {
        const directory = path.join(fixtureSource, location);
        fs.mkdirSync(directory, { recursive: true });
        const markdownPath = path.join(directory, 'obsolete-references.md');
        fs.writeFileSync(markdownPath, preexistingReferenceMarkdown);
        return markdownPath;
      });
      const plantedFixtures = plantLocalityFixtures(fixtureSource);

      copyReleaseArtifactTree(fixtureSource, stagingRoot);
      assert.equal(
        fs.existsSync(path.join(stagingRoot, '.git')),
        false,
        'isolated staging tree should not contain Git metadata'
      );
      for (const [index, location] of localityIgnoredRoots.entries()) {
        assert.equal(
          fs.readFileSync(preexistingPaths[index], 'utf8'),
          preexistingReferenceMarkdown,
          `pre-existing ${location}/obsolete-references.md should survive staging byte-for-byte`
        );
        assert.equal(
          fs.existsSync(path.join(stagingRoot, location)),
          false,
          `isolated staging tree should exclude ${location}`
        );
      }
      for (const fixture of plantedFixtures) {
        assert.equal(
          fs.readFileSync(fixture.markdownPath, 'utf8'),
          obsoleteReferenceMarkdown,
          `source fixture should hold the planted obsolete references: ${fixture.location}`
        );
      }

      const output = execFileSync(process.execPath, ['--test', 'release-docs.test.mjs'], {
        cwd: stagingRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childTestEnv(),
      });

      assert.match(output, /# tests \d+/);
      assert.match(output, /# fail 0/);
      assert.match(output, /ok \d+ - keeps canonical documentation artifacts present/);

      for (const [index, location] of localityIgnoredRoots.entries()) {
        assert.equal(
          fs.readFileSync(preexistingPaths[index], 'utf8'),
          preexistingReferenceMarkdown,
          `staging should neither modify nor delete pre-existing ${location}/obsolete-references.md`
        );
      }
      for (const fixture of plantedFixtures) {
        assert.equal(
          fs.readFileSync(fixture.markdownPath, 'utf8'),
          obsoleteReferenceMarkdown,
          `staging should neither modify nor delete its source fixture: ${fixture.location}`
        );
      }
    } finally {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
});
