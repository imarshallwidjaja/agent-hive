import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it } from 'node:test';

const workspaceRoot = path.resolve(import.meta.dirname);
const vscodePackageDir = path.join(workspaceRoot, 'packages', 'vscode-hive');
const bundlePath = path.join(vscodePackageDir, 'dist', 'extension.js');

function run(command, args, cwd = workspaceRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

describe('vscode release bundle drift', () => {
  it('keeps the VS Code bundle content stable across rebuilds', () => {
    const before = fs.readFileSync(bundlePath, 'utf8');

    run('bun', ['run', 'build'], vscodePackageDir);

    const after = fs.readFileSync(bundlePath, 'utf8');

    assert.equal(after, before, 'packages/vscode-hive/dist/extension.js should not change after rebuild');
  });

  it('keeps the packaged VSIX under the vscode-arkive name', () => {
    run('bun', ['run', 'package'], vscodePackageDir);

    assert.equal(
      fs.existsSync(path.join(vscodePackageDir, 'vscode-arkive.vsix')),
      true,
      'packages/vscode-hive/vscode-arkive.vsix should exist after rebuild'
    );
  });

  it('includes the extension LICENSE in the VSIX file list', () => {
    const vsce = path.join(workspaceRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
    const files = run(vsce, ['ls', '--no-dependencies'], vscodePackageDir).split(/\r?\n/);

    assert.ok(files.includes('LICENSE'), 'vsce should include packages/vscode-hive/LICENSE in the VSIX');
  });

  // The extension ships without node_modules, so Hive's lock backend comes from a copy of the pinned Koffi package
  // beside the bundle: the original loader, its metadata and license, and every prebuilt binary, for one VSIX that
  // serves every platform. The test loads that copy from an extracted VSIX, outside the workspace.
  it('packages the pinned Koffi runtime beside the bundle and loads it from the extracted VSIX', () => {
    const vsix = path.join(vscodePackageDir, 'vscode-arkive.vsix');
    if (!fs.existsSync(vsix)) run('bun', ['run', 'package'], vscodePackageDir);
    const koffiRoot = path.dirname(run(process.execPath, ['-p', "require.resolve('koffi/package.json')"], vscodePackageDir));
    const pinned = JSON.parse(fs.readFileSync(path.join(vscodePackageDir, 'package.json'), 'utf8')).devDependencies.koffi;
    assert.equal(JSON.parse(fs.readFileSync(path.join(koffiRoot, 'package.json'), 'utf8')).version, pinned);
    const binaries = fs.readdirSync(path.join(koffiRoot, 'build', 'koffi')).sort()
      .map((triplet) => `build/koffi/${triplet}/koffi.node`)
      .filter((relative) => fs.existsSync(path.join(koffiRoot, relative)));
    assert.ok(binaries.length >= 18, `the pinned koffi should carry its prebuilt binaries, found ${binaries.length}`);

    const entries = run('unzip', ['-Z1', vsix]).split(/\r?\n/);
    const nativeEntries = entries.filter((entry) => entry.startsWith('extension/dist/native/koffi/')).sort();
    assert.deepEqual(
      nativeEntries,
      ['index.js', 'package.json', 'LICENSE.txt', ...binaries].map((relative) => `extension/dist/native/koffi/${relative}`).sort(),
    );
    assert.equal(entries.some((entry) => entry.includes('node_modules/')), false, 'the VSIX should not ship node_modules');
    assert.match(fs.readFileSync(bundlePath, 'utf8'), /const specifier=true\?"\.\/native\/koffi\/index\.js":"koffi"/);

    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-arkive-vsix-'));
    try {
      run('unzip', ['-q', vsix, '-d', extracted]);
      for (const relative of ['index.js', 'package.json', 'LICENSE.txt', ...binaries]) {
        assert.ok(
          fs.readFileSync(path.join(extracted, 'extension', 'dist', 'native', 'koffi', relative)).equals(fs.readFileSync(path.join(koffiRoot, relative))),
          `${relative} should be copied unchanged`,
        );
      }
      const probe = [
        "const koffi = require('./extension/dist/native/koffi/index.js');",
        "const loaded = Object.keys(require.cache).filter((file) => file.endsWith('koffi.node'));",
        "process.stdout.write(JSON.stringify({ version: koffi.version, loaded }));",
      ].join('\n');
      const { version, loaded } = JSON.parse(run(process.execPath, ['-e', probe], extracted));
      assert.equal(version, pinned);
      assert.equal(loaded.length, 1);
      assert.ok(fs.realpathSync(loaded[0]).startsWith(`${fs.realpathSync(extracted)}${path.sep}`), `koffi should load from the VSIX copy, not ${loaded[0]}`);
    } finally {
      fs.rmSync(extracted, { recursive: true, force: true });
    }
  });
});
