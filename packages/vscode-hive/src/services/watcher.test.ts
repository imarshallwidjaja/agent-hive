import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';

const source = fs.readFileSync(new URL('./watcher.ts', import.meta.url), 'utf8');

describe('HiveWatcher', () => {
  it('watches only the .hive tree', () => {
    expect(source).toContain("'.hive/**/*'");
    expect(source).not.toContain("'.github/**/*'");
    expect(source).not.toContain("'plugin.json'");
  });
});
