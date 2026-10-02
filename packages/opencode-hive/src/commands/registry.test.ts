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
    expect(output).toContain('load executing-plans and apply its Target Task Milestones procedure before dispatch and on resumption');
    expect(output).toContain('including an explicit companion suffix');
    expect(output).toContain('Preserve the exact feature, target, and explicitly named companions from the suggested prompt');
    expect(output).toContain('call hive_feature_select only when the selected route is unset or differs from the dispatch target');
    expect(output).toContain('initial destination identity from the inspection-shaped create result');
    expect(output).toContain('Explicit null stays featureless unless the dispatch intentionally changes target');
    expect(output).toContain("only when this session's most recent route-changing call visible in context is `hive_feature_select` for that same feature");
    expect(output).toContain('no later explicit-null or other-feature selection');
    expect(output).toContain('When that evidence is not visible (for example after compaction or a summary, at session start, or in mixed ad-hoc/feature batches), or you are uncertain, call `hive_feature_select` for the dispatch target');
  });

  it('suggests DAG-backed milestone prompts after approval and synced readback', () => {
    const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
      agentMode: 'dedicated',
      backgroundGuidance: { available: false },
      council: {} as never,
      agents: {},
      dashReviewLanes: [],
      vulnerabilityReviewLanes: [],
    }));
    const output = commands['approve-sync-plan'].run('api-delivery');
    expect(output).toContain('Approve and sync that same explicit feature');
    expect(output).toContain('Stop with exact blockers if plan approval, task sync, or readback fails');
    const readback = output.indexOf('Then read back status and its single top-level tasks list');
    expect(readback).toBeGreaterThanOrEqual(0);
    expect(readback).toBeLessThan(output.indexOf('Build ## Recommended Execution Order'));
    expect(output).toContain('hive_plan_approve({ feature, expectedRevision, sync: true })');
    for (const field of ['approvalPersisted', 'reason/stage', 'alreadyApproved: true', 'approval_superseded_during_sync', 'approval_verification_failed']) {
      expect(output).toContain(field);
    }
    expect(output).toContain('When approval remains successful and only sync failed');
    expect(output).toContain('retry hive_tasks_sync alone');
    expect(output).toContain('status: null integrity entries need inspection and repair, never execution');
    expect(output).toContain('synced stored dependsOn graph');
    expect(output).toContain('resolved implicit sequential shorthand');
    expect(output).toContain('meaningful outcome or join tasks');
    expect(output).toContain('own dependsOn recursively');
    expect(output).toContain('exact feature name and task folder/title, not numerical A-to-B ranges');
    expect(output).toContain('Require a table under ## Recommended Execution Order');
    expect(output).toContain('exact target task number/folder/title');
    expect(output).toContain('expected observable behavior at that stopping point');
    expect(output).toContain('projected NEW unfinished task count');
    expect(output).toContain('actual task folders counted (inline or bounded per-row accompanying lists)');
    expect(output).toContain('Ground behavior in approved plan outcomes/acceptance criteria');
    expect(output).toContain('what the operator or system can do and the relevant verifiable signal');
    expect(output).toContain('citing the source task or plan section rather than subsystem/topic labels');
    expect(output).toContain('expected capability, not proven readiness before execution');
    expect(output).toContain('do not invent capabilities or evidence');
    expect(output).toContain('Companions are explicit requested scope, not dependsOn edges');
    expect(output).toContain('exact folders/titles and their source justification; show companions: none when unnecessary');
    expect(output).toContain('Distinguish target/prerequisites from named companions and their prerequisites');
    expect(output).toContain('U_i is the current unfinished union of the prerequisite closures of suggested target i and its explicitly listed companions');
    expect(output).toContain('including every requested root; traversal stops at done tasks');
    expect(output).toContain('First projected work is U_1');
    expect(output).toContain('U_i minus the union of preceding suggested U_j');
    expect(output).toContain('Deduplicate shared prerequisites and count every requested root unless already covered or done');
    expect(output).toContain('Show the exact task folders in each counted set');
    expect(output).toContain('never calculate counts from numerical intervals');
    expect(output).toContain('cancelled or missing roots/prerequisites and invalid graphs as blockers');
    expect(output).toContain('projected incremental counts assuming prior listed milestones completed');
    expect(output).toContain('operator can combine or omit stopping points');
    expect(output).toContain('omitted milestones or changed order can change counts');
    expect(output).toContain('Execution must re-read current status');
    expect(output).toContain('recompute scope on every request');
    expect(output).toContain('In ## Session Strategy, link copy-paste run/continue prompts to the table targets without duplicating the detailed table');
    expect(output).toContain('suggest separate branch milestones');
    expect(output).toContain('Never fabricate dependencies');
    expect(output).toContain('Run feature "<feature>" until task "<task-folder>" (<task-title>) is complete');
    expect(output).toContain('Continue feature "<feature>" until task "<next-task-folder>" (<next-task-title>) is done');
    expect(output).toContain('Also complete companion task "<companion-folder>" (<companion-title>) before stopping');
    expect(output).toContain('for each listed companion, omitting that suffix when none');
    expect(output).toContain('Bare target requests include only the target closure');
    expect(output).toContain('stop only after the target AND every named companion are done with their gates complete');
    expect(output).toContain('excludes unrelated and descendant tasks');
    expect(output).toContain('terminal verification handoff in Session Strategy with the concrete feature name: Run final verification for feature "<feature>" and complete it only after the required checks pass');
    expect(output).toContain('a separate continuation after no unfinished feature tasks remain, routed to executing-plans Step 6 and the existing full-feature verification/completion procedure, carrying deferred checks and applicable cleanup');
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
