import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const workspaceRoot = path.resolve(import.meta.dirname);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

describe('release 1.3.5 contract on main', () => {
  it('bumps root and workspace manifests to 1.3.5', () => {
    for (const file of [
      'package.json',
      'packages/hive-core/package.json',
      'packages/opencode-hive/package.json',
      'packages/vscode-hive/package.json',
    ]) {
      assert.equal(readJson(file).version, '1.3.5', `${file} should be 1.3.5`);
    }
  });

  it('publishes both v1.3.4 and v1.3.5 release notes', () => {
    assert.equal(
      fs.existsSync(path.join(workspaceRoot, 'docs/releases/v1.3.4.md')),
      true,
      'docs/releases/v1.3.4.md should exist'
    );
    assert.equal(
      fs.existsSync(path.join(workspaceRoot, 'docs/releases/v1.3.5.md')),
      true,
      'docs/releases/v1.3.5.md should exist'
    );
  });

  it('documents PR #64 compaction recovery in v1.3.5 release notes', () => {
    const notes = readText('docs/releases/v1.3.5.md');

    assert.match(notes, /PR\s*#64/i);
    assert.match(notes, /compaction recovery|recovery after OpenCode compaction/i);
  });

  it('records both 1.3.4 and 1.3.5 changelog entries in descending order', () => {
    const changelog = readText('CHANGELOG.md');
    const changelog135Header = '## [1.3.5]';
    const changelog134Header = '## [1.3.4]';

    assert.notEqual(
      changelog.indexOf(changelog135Header),
      -1,
      'CHANGELOG.md should include a 1.3.5 entry'
    );
    assert.notEqual(
      changelog.indexOf(changelog134Header),
      -1,
      'CHANGELOG.md should include a 1.3.4 entry'
    );
    assert.ok(
      changelog.indexOf(changelog135Header) < changelog.indexOf(changelog134Header),
      'CHANGELOG.md should list 1.3.5 before 1.3.4'
    );
  });
});
