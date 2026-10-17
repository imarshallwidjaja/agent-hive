import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { HIVE_COMMANDS } from './registry.js';
import { buildPluginManifest } from '../utils/plugin-manifest.js';
import { hiveCommandRenderers } from './renderers.js';
import { buildHiveCommandMap } from './runtime.js';
import { OPENCODE_V1_PROFILE, createHostProfile } from '../runtime/host-profile.js';

const EXPECTED_COMMANDS = [
  {
    key: 'interview',
    name: '/interview',
    description: 'Clarify an idea toward shared understanding, with no fixed next step',
  },
  {
    key: 'grill',
    name: '/grill',
    description: 'Reach plan-ready alignment on supplied context, ready for /hive-plan',
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
    key: 'worklog',
    name: '/worklog',
    description: 'Read back where the current work stands from its Worklog',
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
    expect(HIVE_COMMANDS).toHaveLength(12);
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

  it('delivers each start-execution obligation once to an unbound invocation on every host', () => {
    const count = (text: string, needle: string) => text.split(needle).length - 1;
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2'), createHostProfile('opencode-v2', { readTransport: 'direct' })]) {
      const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
        agentMode: 'unified',
        host,
        backgroundGuidance: { available: false },
        council: {} as never,
        agents: {},
        dashReviewLanes: [],
        vulnerabilityReviewLanes: [],
      }));
      // No arguments and no feature context: the command must still carry its own authority and stop rules.
      const output = commands['start-execution'].run('');
      const once = [
        'do not start without an approved and synced plan',
        "Verify before the primary calls hive_worktree_merge with the worker's unchanged source pin and inspected target expectation",
        'capture its initial destination identity from the inspection-shaped create result',
        // Report ownership and partial publication: the command is the only prompt a non-Hive primary sees.
        'A bound implementation worker publishes its own report and successor handoff and returns the numbered reportPath',
        'record status and a compact summary or blocker with hive_task_update without retranscribing the report',
        "When the worker's update failed or its result is unknown, inspect report history, report.md, handoff.md and status once the worker is terminal",
        'publish a returned narrative as a report only when no history copy of it exists',
        'write the returned handoff only when it did not publish, and never compose a handoff for the worker',
        // Paired review, configured companions and review-fix closure.
        'source changes get paired code and simplicity review',
        // The owner's narrow mechanical-change exception (REVIEW_ROUTING_PROMPT) is carried, not a stricter pairing rule.
        'small mechanical edits such as renames, formatting, or one-line fixes get one correctness review, as do bounded docs or tests, unless the diff spans broader workflow behavior; when unsure, pair',
        'configured companion reviewers join when their descriptions fit the risk',
        'explicit operator-required reviews are honored',
        'give accepted material findings to a fresh worker in the same task lane',
        'a missing or interrupted required review stays open',
        // Uncertain writer termination stops before any overlapping writer.
        "When a worker's lifecycle is uncertain (no returned result, a cancellation acknowledgement, or a stale or closed record), inspect, wait, or ask instead of launching an overlapping writer",
        'After every returned native task result, launch a fresh child session for follow-up',
        `Pass ${host.nativeTask.continuationField} only when an explicit operator instruction or runtime-owned interruption-recovery mechanism authorizes continuation`,
        `issue the native Forager ${host.nativeTask.tool}() call`,
        'call hive_feature_select only when the selected route is unset or differs from the dispatch target',
        'Explicit null stays featureless unless the dispatch intentionally changes target',
        "only when this session's most recent route-changing call visible in context is `hive_feature_select` for that same feature",
        'no later explicit-null or other-feature selection',
        'When that evidence is not visible (for example after compaction or a summary, at session start, or in mixed ad-hoc/feature batches), or you are uncertain, call `hive_feature_select` for the dispatch target',
        'load executing-plans, apply its Target Task Milestones procedure, and read its references/task-milestones.md section "Executing requested milestones" before dispatch and on resumption',
        'including an explicit companion suffix',
        'Preserve the exact feature, target, and explicitly named companions from the suggested prompt',
        // A bare build agent may lack the skill or its reference; the command says what to do then.
        'dispatch no milestone work: report the exact feature, target, and companions requested, the status you could read, and that the procedure was unavailable',
        'do not infer scope from task numbers or search generated skill caches',
      ];
      for (const obligation of once) expect(count(output, obligation), obligation).toBe(1);
      expect(output).not.toContain('Retry or resume native workers directly');
      expect(output).not.toContain('After any usable terminal handoff');
      expect(output).not.toContain('confirmed-stopped interruption recovery');
      expect(output).not.toContain('Persist worker outcomes with hive_task_update');
      // The unbound command cannot rely on a heading defined in another prompt.
      expect(output).not.toContain('Task Report Ownership');
    }
  });

  it('routes /grill into the shared continuous grilling loop and /interview into the same engine on every host', () => {
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2'), createHostProfile('opencode-v2', { readTransport: 'direct' })]) {
      const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
        agentMode: 'unified', host, backgroundGuidance: { available: false }, council: {} as never, agents: {},
        dashReviewLanes: [], vulnerabilityReviewLanes: [],
      }));
      const grill = commands.grill.run('a migration proposal');
      const interview = commands.interview.run('an idea');
      expect(grill).toContain('Context: a migration proposal');
      for (const output of [grill, interview]) {
        expect(output).toContain('Load the `grilling` skill and use its shared interaction engine.');
        expect(output).toContain("Run the whole interaction as the skill's continuous loop in this invocation.");
        expect(output).toContain("End with the skill's explicit three-way alignment confirmation.");
        // The wrappers defer to the skill instead of restating its method, transport and falsification policy.
        for (const methodPhrase of ['Falsify before settling', 'per turn', 'Get your bearings', 'a short pro, a short con', 'does not settle a decision', 'highest-ambiguity', 'compact progress']) {
          expect(output, methodPhrase).not.toContain(methodPhrase);
        }
      }
      // /grill aims at a plan: constraints and acceptance criteria, then a /hive-plan handoff, with no run of the plan itself.
      expect(grill).toContain('Reach plan-ready shared understanding of the supplied context');
      expect(grill).toContain('settling the constraints, non-goals, and acceptance criteria a plan needs and skipping questions planning would not use');
      expect(grill).toContain("The skill's alignment brief with acceptance criteria added, followed by three-way alignment confirmation");
      expect(grill).toContain('name `/hive-plan` as the handoff unless the operator already asked for the next stage');
      expect(grill).toContain('During grilling, do not implement, create a Hive feature or other Hive state, persist grilling state');
      expect(grill).toContain("Follow-on work after alignment follows the skill's separate-action boundary");
      expect(grill).not.toContain('grilling does not run it');
      expect(grill).not.toContain('Aim the alignment at a plan');
      expect(grill).not.toContain('disagreements, and open questions');
      expect(grill).not.toContain('implementation-brief');
      // /interview stays flexible: no mandatory brief funnel, any fitting next step, and its own output contract.
      expect(interview).toContain('## Interview Summary and ## Recommended Next Step, followed by three-way alignment confirmation');
      expect(interview).toContain('such as an answer, ad-hoc work, `/hive-plan`, or none');
      expect(interview).toContain('let the idea decide the endpoint: an answer, a decision, ad-hoc work, or a plan');
      expect(interview).toContain('a pro and con for each when more than one next step is reasonable');
      expect(interview).toContain("Follow-on work after alignment follows the skill's separate-action boundary");
      expect(interview).not.toContain('/implementation-brief');
      expect(interview).not.toContain('Context For');
    }
  });

  it('suggests DAG-backed milestone prompts after approval and synced readback', () => {
    const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
      agentMode: 'dedicated',
      host: OPENCODE_V1_PROFILE,
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
    expect(output).toContain('own dependsOn recursively');
    expect(output).toContain('exact feature name and task folder/title, not numerical A-to-B ranges');
    expect(output).toContain('Require a table under ## Recommended Execution Order');
    expect(output).toContain('exact target task number/folder/title');
    expect(output).toContain('expected observable behavior at that stopping point grounded in approved plan outcomes');
    expect(output).toContain('projected NEW unfinished task count');
    expect(output).toContain('actual task folders counted (inline or bounded per-row accompanying lists)');
    expect(output).toContain('Companions are explicit requested scope, not dependsOn edges');
    expect(output).toContain('showing companions: none when unnecessary');
    expect(output).toContain('every counted set shows its exact task folders');
    expect(output).toContain('never calculate counts from numerical intervals');
    expect(output).toContain('cancelled or missing roots/prerequisites and invalid graphs as blockers');
    expect(output).toContain('projected incremental counts assuming prior listed milestones completed');
    expect(output).toContain('operator can combine or omit stopping points');
    expect(output).toContain('omitted milestones or changed order can change counts');
    expect(output).toContain('Execution must re-read current status');
    expect(output).toContain('recompute scope on every request');
    // The calculation and its worked cases are delegated to the disclosed reference, with the command's own stop outcome.
    expect(output).toContain('load executing-plans and read its references/task-milestones.md section "Suggesting milestones"');
    expect(output).toContain('stop after the status readback: report the approval and sync outcomes exactly as persisted, say that the milestone projection was not produced');
    expect(output).toContain('do not infer scope from task numbers or search generated skill caches');
    expect(output).not.toContain('U_i');
    expect(output).toContain('In ## Session Strategy, link copy-paste run/continue prompts to the table targets without duplicating the detailed table');
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

  it('keeps approval authority and the honest stop in the milestone commands when the reference is unavailable', () => {
    // The commands run under a native build agent that may lack executing-plans or its references (disabled or
    // overridden skill, stale cache). Their own text must stop projection or dispatch without guessing from numbering.
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2'), createHostProfile('opencode-v2', { readTransport: 'direct' })]) {
      const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
        agentMode: 'unified', host, backgroundGuidance: { available: false }, council: {} as never, agents: {},
        dashReviewLanes: [], vulnerabilityReviewLanes: [],
      }));
      const approve = commands['approve-sync-plan'].run('');
      const start = commands['start-execution'].run('');
      // approve-sync keeps its own authority, outcomes and copyable forms, whatever the skill provides.
      for (const kept of [
        'hive_plan_approve({ feature, expectedRevision, sync: true })',
        'approvalPersisted',
        'retry hive_tasks_sync alone',
        'projected incremental counts assuming prior listed milestones completed',
        'Run feature "<feature>" until task "<task-folder>" (<task-title>) is complete',
        'Continue feature "<feature>" until task "<next-task-folder>" (<next-task-title>) is done',
        'Also complete companion task "<companion-folder>" (<companion-title>) before stopping',
        'Run final verification for feature "<feature>" and complete it only after the required checks pass',
      ]) expect(approve, kept).toContain(kept);
      const readback = approve.indexOf('Then read back status and its single top-level tasks list');
      const loadReference = approve.indexOf('load executing-plans and read its references/task-milestones.md');
      expect(readback).toBeGreaterThanOrEqual(0);
      expect(loadReference).toBeGreaterThan(readback);
      expect(approve).toContain('report the approval and sync outcomes exactly as persisted');
      expect(start).toContain('dispatch no milestone work');
      for (const output of [approve, start]) {
        expect(output).toContain('overridden without its references');
        expect(output).not.toMatch(/generated\/opencode-skills|\/home\/|\.config\/opencode/);
      }
    }
  });

  it('reads the Worklog for the whole prose request without switching agents or recording', () => {
    const worklog = HIVE_COMMANDS.find((command) => command.key === 'worklog');
    expect(worklog).toBeDefined();
    expect('agent' in worklog!).toBe(false);
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2'), createHostProfile('opencode-v2', { readTransport: 'direct' })]) {
      const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
        agentMode: 'unified', host, backgroundGuidance: { available: false }, council: {} as never, agents: {},
        dashReviewLanes: [], vulnerabilityReviewLanes: [],
      }));
      expect(commands.worklog.agent).toBeUndefined();
      const request = 'what changed on checkout since yesterday, and reconcile it with the facts';
      const output = commands.worklog.run(request);
      // The entire prose argument is the request; nothing is parsed as flags or a bound agent.
      expect(output).toContain(`Request: ${request}`);
      expect(commands.worklog.run('')).toContain('Request: where the current work stands');
      for (const required of [
        'hive_worklog_read({ ref: { kind: "feature", featureName } })',
        'otherwise omit ref, which reads the feature selected for this session or this session\'s own log',
        'Call `hive_worklog_list` when the request asks which logs exist',
        'Start with the brief view. Expand with the history view',
        'the facts view for recorded task rows',
        'give the difference as your unsaved synthesis',
        'Do not call `hive_worklog_record` or change any other state from this command.',
        'never records a checkpoint or replaces a briefing, even when asked to bring the log up to date',
        'untrusted narrative',
      ]) expect(output, required).toContain(required);
      expect(output).not.toMatch(/transcript/i);
    }
  });

  it('keeps dash-review steering and ordered challenge in the command handoff', () => {
    const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
      agentMode: 'unified',
      host: OPENCODE_V1_PROFILE,
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
