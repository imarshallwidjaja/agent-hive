import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { HIVE_COMMANDS } from './registry.js';
import { buildPluginManifest } from '../utils/plugin-manifest.js';
import { hiveCommandRenderers } from './renderers.js';
import { buildHiveCommandMap } from './runtime.js';

const EXPECTED_COMMANDS = [
  {
    key: 'interview',
    name: '/interview',
    description: 'Clarify an idea toward a reliable implementation-brief handoff',
  },
  {
    key: 'grill',
    name: '/grill',
    description: 'Reach explicit alignment on any supplied context',
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
    key: 'dash-review',
    name: '/dash-review',
    description: 'Review one Git, inline, or local-artifact evidence bundle without changing files',
    agent: 'dash-reviewer',
  },
  {
    key: 'vuln-review',
    name: '/vuln-review',
    description: 'Assess a requested scope for evidenced vulnerabilities without changing files',
    agent: 'vulnerability-review-primary',
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
    expect(HIVE_COMMANDS).toHaveLength(11);
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

  it('assembles start-execution without broad native-task resume guidance', () => {
    const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
      agentMode: 'unified',
      backgroundGuidance: { available: false },
      council: {} as never,
      agents: {},
      dashReviewLanes: [],
      vulnerabilityReviewLanes: [],
    }));
    const output = commands['start-execution'].run('');

    expect(output).toContain('After any returned native task result, launch a fresh child session for follow-up');
    expect(output).toContain('explicit operator/runtime-owned interruption recovery');
    expect(output).not.toContain('Retry or resume native workers directly');
    expect(output).not.toContain('After any usable terminal handoff');
    expect(output).not.toContain('confirmed-stopped interruption recovery');
    expect(output).toContain('Read the report a bound worker published, then record status, summary, or blocker with hive_task_update');
    expect(output).not.toContain('Persist worker outcomes with hive_task_update');
  });

  it('keeps dash-review steering and ordered challenge in the command handoff', () => {
    const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
      agentMode: 'unified',
      backgroundGuidance: { available: false },
      council: {} as never,
      agents: {},
      dashReviewLanes: [{
        sourceAgent: 'reviewer-contract',
        baseAgent: 'code-reviewer',
        model: 'provider/model',
        description: 'Review API contract changes',
        taskTarget: 'reviewer-contract',
      }],
      vulnerabilityReviewLanes: [],
    }));
    const output = commands['dash-review'].run('Check callers of src/api.ts; exclude formatting');

    expect(output).toContain('Review input: Check callers of src/api.ts; exclude formatting');
    expect(output).toContain('reviewer-contract');
    const understand = output.indexOf('understand the material change');
    const dispatch = output.indexOf('Dispatch best-fit reviewers');
    const challenge = output.indexOf('Independently challenge material candidates');
    expect(understand).toBeGreaterThanOrEqual(0);
    expect(understand).toBeLessThan(dispatch);
    expect(dispatch).toBeLessThan(challenge);
    expect(output).toContain('preserve explicitly requested reviewer scope');
    expect(output).toContain('required configured reviewer or claim a clean review while that obligation or material challenge is open');
    expect(output).toContain('Review Basis');
  });
});
