import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { HIVE_COMMANDS } from './registry.js';
import { buildPluginManifest } from '../utils/plugin-manifest.js';

const EXPECTED_COMMANDS = [
  {
    key: 'interview',
    name: '/interview',
    description: 'Clarify an idea one question at a time before planning',
  },
  {
    key: 'implementation-brief',
    name: '/implementation-brief',
    description: 'Create a copy-paste-ready implementation planning brief',
  },
  {
    key: 'hive-plan',
    name: '/hive-plan',
    description: 'Create a Hive implementation plan from a spec or brief',
  },
  {
    key: 'approve-sync-plan',
    name: '/approve-sync-plan',
    description: 'Approve the active Hive plan and sync executable tasks',
  },
  {
    key: 'start-execution',
    name: '/start-execution',
    description: 'Start executing an approved Hive plan',
  },
  {
    key: 'council-directive',
    name: '/council-directive',
    description: 'Turn a rough request into a reusable council directive',
  },
  {
    key: 'council',
    name: '/council',
    description: 'Run a read-only council and synthesize a recommendation',
  },
  {
    key: 'compact-summary',
    name: '/compact-summary',
    description: 'Produce a recovery summary for the current OpenCode session',
  },
] as const;

function uniqueCount(values: string[]): number {
  return new Set(values).size;
}

describe('HIVE_COMMANDS', () => {
  it('defines the canonical command metadata in stable order', () => {
    expect(HIVE_COMMANDS).toEqual(EXPECTED_COMMANDS);
    expect(HIVE_COMMANDS).toHaveLength(8);
    expect(HIVE_COMMANDS.map((command) => command.name)).not.toContain('/hive');
  });

  it('keeps command keys and names unique', () => {
    const keys = HIVE_COMMANDS.map((command) => command.key);
    const names = HIVE_COMMANDS.map((command) => command.name);

    expect(uniqueCount(keys)).toBe(keys.length);
    expect(uniqueCount(names)).toBe(names.length);
  });

  it('uses registry metadata for plugin manifest commands', () => {
    expect(buildPluginManifest('0.0.0').commands).toEqual(
      HIVE_COMMANDS.map(({ name, description }) => ({ name, description })),
    );
  });

  it('does not import runtime command composition from manifest code', () => {
    const manifestSource = fs.readFileSync(
      path.resolve(import.meta.dir, '../utils/plugin-manifest.ts'),
      'utf-8',
    );

    expect(manifestSource).not.toContain('../commands/runtime');
    expect(manifestSource).not.toContain('./commands/runtime');
  });
});
