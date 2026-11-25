import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { HIVE_COMMANDS } from './registry.js';
import { buildPluginManifest } from '../utils/plugin-manifest.js';
import { hiveCommandRenderers } from './renderers.js';
import { buildHiveCommandMap } from './runtime.js';
import { OPENCODE_V1_PROFILE, createHostProfile } from '../runtime/host-profile.js';
import { PLAN_ASSESSMENT_REQUIREMENT } from '../agents/process-judgment.js';
import { COUNCIL_READ_ONLY_CONTRACT } from '../runtime/councils.js';
import type { HiveCommandContext } from './types.js';

const EXPECTED_COMMANDS = [
  {
    key: 'sharpen',
    name: '/sharpen',
    description: 'Deepen and reframe a prompt or rough idea into a sharper rewritten prompt, without acting on it',
  },
  {
    key: 'interview',
    name: '/interview',
    description: 'Clarify an idea toward shared understanding, with no fixed next step',
  },
  {
    key: 'grill',
    name: '/grill',
    description: 'Pressure-test supplied context until scope and acceptance criteria are agreed, then recommend the next step',
  },
  {
    key: 'investigate',
    name: '/investigate',
    description: 'Diagnose a problem from evidence and propose a fix with success criteria, without changing code',
  },
  {
    key: 'walkthrough',
    name: '/walkthrough',
    description: 'Walk through how a subsystem works now, or what a finished change did',
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
    key: 'implement',
    name: '/implement',
    description: 'Implement the work this conversation scoped as ad-hoc work, with any extra steering you add',
  },
  {
    key: 'merge-to-main',
    name: '/merge-to-main',
    description: 'Merge the intended work into its main branch, reviewed and verified on the result',
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
    key: 'test-audit',
    name: '/test-audit',
    description: 'Audit test outcomes and duplicate coverage without changing files',
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
    key: 'handoff',
    name: '/handoff',
    description: 'Write a self-contained handoff another agent can pick up for the next job',
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
        dashReviewLanes: [],
        vulnerabilityReviewLanes: [],
      }));
      // No arguments and no feature context: the command must still carry its own authority and stop rules.
      const output = commands['start-execution'].run('');
      const once = [
        'do not start without an approved and synced plan',
        "Verify before the primary calls hive_worktree_merge with the worker's unchanged source pin and inspected target expectation and the declared historyIntent",
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
        'give accepted material findings to a follow-up worker in the same task lane',
        'a missing or interrupted required review stays open',
        // Uncertain writer termination stops before any overlapping writer; continuation follows the host's contract.
        ...(host.backgroundSubagents
          ? [
              "When a worker's lifecycle is uncertain (no final report, a cancellation acknowledgement, or an error or cancellation report or closed record), inspect, wait, or ask instead of launching an overlapping writer",
              // An unbound command can run under a non-Hive agent without the wait section, so it carries the rules itself.
              `every \`${host.nativeTask.tool}()\` call returns a launch receipt (status \`running\` and the child's \`${host.nativeTask.continuationField}\`), not the child's result`,
              'a `state="running"` report is an interim stop, and an error or cancellation report is a failed or interrupted run',
              `Only a settled child of a resumable role (\`forager-worker\`, \`forager-investigator\`, \`architect-planner\`, or a custom agent derived from one) may be continued with \`${host.nativeTask.continuationField}\`, on the same \`${host.nativeTask.agentField}\` and the same task or investigation, for one or two bounded follow-ups`,
              'Scouts, reviewers, advisors, and `hive-helper` are one-shot',
              `A new task, an independent review or challenge pass, and a retry after a dead end always omit \`${host.nativeTask.continuationField}\``,
            ]
          : [
              "When a worker's lifecycle is uncertain (no returned result, a cancellation acknowledgement, or a stale or closed record), inspect, wait, or ask instead of launching an overlapping writer",
              'After every returned native task result, launch a fresh child session for follow-up',
              `Pass ${host.nativeTask.continuationField} only when an explicit operator instruction or runtime-owned interruption-recovery mechanism authorizes continuation`,
            ]),
        `issue the native Forager ${host.nativeTask.tool}() call`,
        'call hive_feature_select only when the selected route is unset or differs from the dispatch target',
        'Explicit null stays featureless unless the dispatch intentionally changes target',
        "only when this session's most recent route-changing call visible in context is `hive_feature_select` for that same feature",
        'no later explicit-null or other-feature selection',
        // On v2 the session's `hive.session` entry carries the route across compaction, so it also counts as evidence.
        ...(host.host === 'opencode-v2'
          ? [
              "or when this session's `hive.session` session instruction entry shows that feature as the selected route; that entry survives compaction.",
              'When neither is visible (for example at session start or in mixed ad-hoc/feature batches), or you are uncertain, call `hive_feature_select` for the dispatch target',
            ]
          : ['When that evidence is not visible (for example after compaction or a summary, at session start, or in mixed ad-hoc/feature batches), or you are uncertain, call `hive_feature_select` for the dispatch target']),
        'load executing-plans, apply its Target Task Milestones procedure, and read its references/task-milestones.md section "Executing requested milestones" before dispatch and on resumption',
        'including an explicit companion suffix',
        'Preserve the exact feature, target, and explicitly named companions from the suggested prompt',
        // A bare build agent may lack the skill or its reference; the command says what to do then.
        'dispatch no milestone work: report the exact feature, target, and companions requested, the status you could read, and that the procedure was unavailable',
        'do not infer scope from task numbers or search generated skill caches',
      ];
      for (const obligation of once) expect(count(output, obligation), obligation).toBe(1);
      if (host.backgroundSubagents) expect(output).not.toContain('After every returned native task result');
      if (host.host === 'opencode-v2') expect(output).not.toContain('after compaction or a summary');
      expect(output).not.toContain('Retry or resume native workers directly');
      expect(output).not.toContain('After any usable terminal handoff');
      expect(output).not.toContain('confirmed-stopped interruption recovery');
      expect(output).not.toContain('Persist worker outcomes with hive_task_update');
      // The unbound command cannot rely on a heading defined in another prompt.
      expect(output).not.toContain('Task Report Ownership');
      expect(output).not.toContain('Native Subagent Wait');
    }
  });

  it('routes /grill into the shared continuous grilling loop and /interview into the same engine on every host', () => {
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2'), createHostProfile('opencode-v2', { readTransport: 'direct' })]) {
      const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
        agentMode: 'unified', host,
        dashReviewLanes: [], vulnerabilityReviewLanes: [],
      }));
      const grill = commands.grill.run('a migration proposal');
      const interview = commands.interview.run('an idea');
      expect(grill).toContain('Context: a migration proposal');
      for (const output of [grill, interview]) {
        expect(output).toContain('Load the `grilling` skill and use its shared interaction engine.');
        expect(output).toContain("Run the whole interaction as the skill's continuous loop in this invocation.");
        expect(output).toContain("End with the skill's explicit three-way alignment confirmation and its closing readback.");
        // The wrappers defer to the skill instead of restating its method, transport and falsification policy.
        for (const methodPhrase of ['Falsify before settling', 'per turn', 'Get your bearings', 'a short pro, a short con', 'does not settle a decision', 'highest-ambiguity', 'compact progress']) {
          expect(output, methodPhrase).not.toContain(methodPhrase);
        }
      }
      // /grill settles scope and acceptance criteria on supplied context, then recommends the step the result warrants
      // instead of always handing off to /hive-plan; it still runs none of those steps itself.
      expect(grill).toContain('settle the scope, constraints, non-goals, and acceptance criteria the next step will need');
      expect(grill).toContain("The skill's alignment brief with acceptance criteria added, followed by three-way alignment confirmation and the skill's closing readback");
      expect(grill).toContain('After confirmation, recommend the next step the result warrants, unless the operator already asked for the next stage');
      for (const nextStep of ['a direct answer when that settles it', '/implement when the scope is clear enough to build as ad-hoc work', '/hive-plan when it needs a reviewed plan and task breakdown', '/investigate when an open question needs evidence first']) {
        expect(grill, nextStep).toContain(nextStep);
      }
      // Under a role that cannot run the recommended step, /grill names the selection instead of switching.
      expect(grill).toContain("Recommend it with the agent I'm on in mind: if that step needs another agent, such as one that can implement ad-hoc work for /implement, tell me which one to select; don't switch for me");
      expect(grill).toContain("During grilling, don't implement anything, create a Hive feature or other Hive state, persist grilling state");
      expect(grill).toContain("Follow-on work after alignment follows the skill's separate-action boundary");
      expect(grill).not.toContain('name `/hive-plan` as the handoff');
      expect(grill).not.toContain('plan-ready');
      expect(grill).not.toContain('grilling does not run it');
      expect(grill).not.toContain('Aim the alignment at a plan');
      expect(grill).not.toContain('disagreements, and open questions');
      expect(grill).not.toContain('implementation-brief');
      // /interview stays flexible: no mandatory brief funnel, any fitting next step, and its own output contract.
      expect(interview).toContain('## Interview Summary and ## Recommended Next Step, followed by three-way alignment confirmation and the skill\'s closing readback');
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
    expect(output).toContain('retry `hive_tasks_sync` alone');
    expect(output).toContain('After a call with `refreshTasks`, approve-and-sync again');
    expect(output).not.toContain('address the error and retry hive_tasks_sync alone');
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

  it('keeps milestone prompts self-contained and makes same-session continuation the v2 default', () => {
    const approve = (host: HiveCommandContext['host']) => buildHiveCommandMap(hiveCommandRenderers, () => ({
      agentMode: 'dedicated',
      host,
      dashReviewLanes: [],
      vulnerabilityReviewLanes: [],
    }))['approve-sync-plan'].run('api-delivery');
    const v1 = approve(OPENCODE_V1_PROFILE);
    expect(v1).toContain('The prompt must carry the whole explicit scope into a fresh session with status alone, without a persistent milestone manifest.');
    expect(v1).not.toContain('native compaction');
    for (const host of [createHostProfile('opencode-v2'), createHostProfile('opencode-v2', { readTransport: 'direct' })]) {
      const v2 = approve(host);
      expect(v2).toContain('Say that on this host each next prompt can go in the same session, which continues across native compaction, and that no new session is required between milestones.');
      expect(v2).toContain('Each prompt still carries the whole explicit scope, so it works unchanged in that session or in a completely fresh session with status alone, without a persistent milestone manifest.');
      expect(v2).toContain('Run final verification for feature "<feature>" and complete it only after the required checks pass');
      expect(v2).not.toContain('The prompt must carry the whole explicit scope into a fresh session');
    }
  });

  it('carries the plan assessment requirement once in /hive-plan and /approve-sync-plan on every host, standing alone for a non-Hive primary', () => {
    const count = (text: string, needle: string) => text.split(needle).length - 1;
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2'), createHostProfile('opencode-v2', { readTransport: 'direct' })]) {
      const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
        agentMode: 'dedicated', host,
        dashReviewLanes: [], vulnerabilityReviewLanes: [],
      }));
      const plan = commands['hive-plan'].run('');
      const approve = commands['approve-sync-plan'].run('');
      for (const output of [plan, approve]) {
        expect(count(output, PLAN_ASSESSMENT_REQUIREMENT)).toBe(1);
        // The command cannot rely on a heading defined in a Hive prompt it does not receive.
        expect(output).not.toContain('Feature Plan Assessment');
        expect(output).not.toMatch(/\btask\(|subagent\(|subagent_type/);
        // A readiness-only or wording-only amendment of an assessed plan must not reopen the lens it cannot affect.
        for (const phrase of [
          'assess again only the lens the change affects (both when both are affected) and check minor wording yourself',
          'the changed delta and a concrete reason it cannot affect that lens',
          'stays attributed to its own earlier `contentHash`, and an older assessment is not presented as current',
          'neither coverage of the current `contentHash` nor kept earlier coverage',
        ]) expect(output, phrase).toContain(phrase);
      }
      // The plan command settles decisions before assessment; the approve command checks the read hash and does not treat invocation as a waiver.
      expect(plan).toContain('settle them in the plan before it is assessed');
      expect(plan).toContain('mark binding decisions apart from illustrative sketches a worker may adapt');
      expect(approve).toContain('approve only when review issues are resolved and the plan assessments hold');
      expect(approve).toContain('Note the contentHash from that hive_plan_read and check which plan assessments name it');
      expect(approve).toContain('Invoking this command requests approval and does not waive the plan assessments described below');
      expect(approve).toContain('Approve without them only when the operator explicitly directs approval without review');
      // A native primary that cannot dispatch a lens stops with the unmet obligation, as it does for approval, sync, or readback failures.
      expect(approve).toContain('or if a required assessment is missing and cannot be dispatched');
      expect(approve).toContain("report the unmet obligation instead of reading the plan yourself in the specialist's place");
      expect(approve.indexOf('contentHash from that hive_plan_read')).toBeLessThan(approve.indexOf(PLAN_ASSESSMENT_REQUIREMENT));
    }
  });

  it('keeps approval authority and the honest stop in the milestone commands when the reference is unavailable', () => {
    // The commands run under a native build agent that may lack executing-plans or its references (disabled or
    // overridden skill, stale cache). Their own text must stop projection or dispatch without guessing from numbering.
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2'), createHostProfile('opencode-v2', { readTransport: 'direct' })]) {
      const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
        agentMode: 'unified', host,
        dashReviewLanes: [], vulnerabilityReviewLanes: [],
      }));
      const approve = commands['approve-sync-plan'].run('');
      const start = commands['start-execution'].run('');
      // approve-sync keeps its own authority, outcomes and copyable forms, whatever the skill provides.
      for (const kept of [
        'hive_plan_approve({ feature, expectedRevision, sync: true })',
        'approvalPersisted',
        'retry `hive_tasks_sync` alone',
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
        agentMode: 'unified', host,
        dashReviewLanes: [], vulnerabilityReviewLanes: [],
      }));
      expect(commands.worklog.agent).toBeUndefined();
      const request = 'what changed on checkout since yesterday, and reconcile it with the facts';
      const output = commands.worklog.run(request);
      // The entire prose argument is the request; nothing is parsed as flags or a bound agent.
      expect(output).toContain(`Request: ${request}`);
      expect(commands.worklog.run('')).toContain('Request: where the current work stands');
      for (const required of [
        'A named feature reads `hive_worklog_read` with `ref: { kind: "feature", featureName }`',
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
      // The command can run in an agent without the Hive system prompt, so it names the read transport itself.
      expect(output).not.toMatch(/hive_worklog_(read|list)\(/);
      const codemode = 'On this host `hive_worklog_read` and `hive_worklog_list` run inside Code Mode: call them from code passed to the host\'s `execute` tool';
      const unavailable = 'When `execute` is not among your exposed tools, these reads are unavailable to you.';
      const direct = 'On this host `hive_worklog_read` and `hive_worklog_list` are direct tool calls';
      if (host.host === 'opencode-v1') expect(output).not.toMatch(/On this host|`execute`/);
      else if (host.readTransport === 'codemode') {
        for (const required of [codemode, unavailable, 'set the oc-arkive option `readTransport` to `direct`', 'do not attempt a direct call or a substitute']) expect(output).toContain(required);
        expect(output).not.toContain(direct);
        expect(output).toContain("`search({ namespace: 'hive', query: 'worklog read' })`");
      } else {
        expect(output).toContain(direct);
        expect(output).not.toContain(codemode);
      }
    }
  });

  it('names the transport of the checkout reads /merge-to-main relies on, for an agent without the Hive system prompt', () => {
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2'), createHostProfile('opencode-v2', { readTransport: 'direct' })]) {
      const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
        agentMode: 'unified', host,
        dashReviewLanes: [], vulnerabilityReviewLanes: [],
      }));
      const output = commands['merge-to-main'].run('');
      const codemode = 'On this host `hive_checkout_brief` and `hive_checkouts_list` run inside Code Mode';
      const direct = 'On this host `hive_checkout_brief` and `hive_checkouts_list` are direct tool calls';
      if (host.host === 'opencode-v1') expect(output).not.toMatch(/On this host|`execute`/);
      else if (host.readTransport === 'codemode') {
        for (const required of [codemode, 'so `hive_checkout_brief` is `tools.hive.checkout_brief`', "`search({ namespace: 'hive', query: 'checkout brief' })`", 'set the oc-arkive option `readTransport` to `direct`']) expect(output).toContain(required);
        expect(output).not.toContain(direct);
      } else {
        expect(output).toContain(direct);
        expect(output).not.toContain(codemode);
      }
    }
  });

  it('keeps /implement unbound and wraps host-supplied steering for the skill handoff', () => {
    const implement = HIVE_COMMANDS.find((command) => command.key === 'implement');
    // No agent, model, provider, variant or subtask: the native command keeps the session's agent, model and chat.
    expect(Object.keys(implement!).sort()).toEqual(['description', 'key', 'name']);
    // Review commands bind to their read-only primary.
    expect(HIVE_COMMANDS.filter((command) => 'agent' in command).map((command) => command.key)).toEqual(['dash-review', 'test-audit', 'vuln-review']);
    // The renderer wraps the host-supplied text without parsing it.
    const prose = '  also keep the old "v1 shim" -- don\'t touch /grill output;\n\n  then add docs for $ARGUMENTS-style text\nand retry once.\n';
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2'), createHostProfile('opencode-v2', { readTransport: 'direct' })]) {
      const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
        agentMode: 'dedicated', host,
        dashReviewLanes: [], vulnerabilityReviewLanes: [],
      }));
      expect(commands.implement.agent).toBeUndefined();
      const output = commands.implement.run(prose);
      expect(output).toContain(`<operator-text>\n${prose}\n</operator-text>`);
      expect(output.split('<operator-text>').length).toBe(2);
      expect(commands.implement.run('')).toContain('<operator-text>\n\n</operator-text>');
      for (const required of [
        'Load the `starting-ad-hoc-implementation` skill and follow it with this conversation and the operator text above',
        'blank operator text means the conversation alone scopes the work',
        'Treat the text I typed after /implement as further context and steering in plain words, not options to parse',
        'This request is your authority to implement that scope; loading the skill, earlier history, or a bare alignment confirmation is not',
        "It doesn't authorize creating a Hive feature, plan, or task, and an approved feature plan runs through /start-execution",
        // The operator's intended outcome, stated once; the skill and the primary own how each part is done.
        'rebuild exactly what we agreed and where it should land',
        'get the choices that carry real risk or uncertainty challenged before you commit to them',
        "run independent pieces in parallel only where they can't collide",
        'get the result reviewed and work through the findings that matter',
        'check complexity and verification in proportion to the change, and stop once the evidence and the required gates hold',
        'Stay on the agent and model I selected for this session',
        "tell me exactly what's missing and stop instead of substituting another capability; choosing another agent is my call",
      ]) expect(output, required).toContain(required);
      // The command is an adapter; the lifecycle policy stays with the skill and the primary.
      expect(output).not.toMatch(/hive_adhoc_worktree|orchestrating-ad-hoc-work|Review Routing|\btask\(|subagent\(/);
    }
  });

  it('delivers /investigate, /walkthrough, /handoff and /merge-to-main unbound, as operator requests carrying their own guards, on every host', () => {
    const keys = ['investigate', 'walkthrough', 'handoff', 'merge-to-main'] as const;
    for (const key of keys) {
      // Like /implement, these run under the session's selected agent and model.
      expect(Object.keys(HIVE_COMMANDS.find((command) => command.key === key)!).sort(), key).toEqual(['description', 'key', 'name']);
    }
    const obligations: Record<(typeof keys)[number], { opening: string; required: string[]; absent?: string[] }> = {
      investigate: {
        opening: "Let's investigate this properly before anyone changes code.",
        required: [
          'try to knock down the competing explanations instead of settling on the first plausible one',
          'When one structural change could explain or remove several symptoms at once, weigh it beside the local fix',
          'load the `systematic-debugging` skill',
          'use the Experiments method in your instructions if you have it, sending an Investigator where your role can',
          // The active role's run authorization stays in force; the command is no blanket approval to run code.
          "Your role's rules for running code still decide what you may run: the Authority rule under Experiments, or Runtime Exercise where your instructions have it",
          "This command doesn't approve running code those rules don't already cover; when a run you need isn't covered, ask me once, naming its purpose, the candidate, and its effects",
          "Keep this to diagnosis. Don't fix product code or start implementation from this command",
          'anything that changes source runs in a disposable placement, the evidence goes somewhere that survives cleanup, and you clean up what you started',
          'Anything paid, external, or non-disposable needs my explicit go-ahead first',
          "don't switch agents or models or improvise an equivalent tool",
          'the fix you would propose, with success criteria that would show it worked; and the assumptions, gaps, and decisions you need from me',
        ],
      },
      walkthrough: {
        opening: 'Walk me through this.',
        required: [
          "The subject is what I wrote after /walkthrough, or what we've been discussing when that is blank",
          'If it is a finished change',
          'reading the diff against its base as well as the code as it stands',
          // Depth, pacing, history and the no-quiz rule come from the `how` skill (pinned in skill-content.test.ts).
          'Use the `how` skill to ground the explanation in the actual source, and follow it for depth, pacing, and when history comes in',
          'Include practical examples',
          "Tell me what you actually read or ran and what you didn't",
          "Don't change any code.",
        ],
        absent: ['No quizzes', 'smallest complete account', 'with the `why` skill'],
      },
      handoff: {
        opening: 'Write me a handoff I can paste to another agent so it can pick this up cold.',
        required: [
          'one self-contained assignment for the next job I named after /handoff',
          "use that job and say which you picked; when it isn't clear, ask me",
          'what is verified, with its evidence, kept apart from what is only claimed',
          'the exact checkout, branch or ref, path, and commit or source pin where they matter',
          'every worker, run, worktree, or other resource whose state is still open or uncertain',
          "don't say a worker has stopped or that anyone holds authority unless that was established",
          "don't present a check as passing unless it ran and passed",
          "don't dispatch anyone, don't write it into a task handoff or any other Hive record, and don't change any state",
          'One fenced code block holding the handoff',
        ],
        // The distinction from neighbouring commands lives in the docs, not the runtime body.
        absent: ['/compact-summary', '/implementation-brief'],
      },
      'merge-to-main': {
        opening: "Let's get this merged into the intended main branch.",
        required: [
          'the real main destination, and any dirty state on either side',
          // Role authority is checked before any placement or Git command; the command grants no implementation or merge authority.
          'Before you create a placement or run any Git command, check that your role can do this integration and any repair it needs',
          'it gives no implementation or merge authority to a role that lacks it, such as a planning or review-only agent',
          "tell me what's missing, leave everything as it is, and let me pick the agent",
          "Don't switch agents, write a plan, feature, or task in its place, or do the same thing with raw Git or the shell",
          "Use the repository's normal Git workflow only for a source Hive doesn't manage, and only when your role can run it",
          // The route is chosen by source type: a retained checkout given directly has no worker binding or first leg,
          // so the worktree-only steps are scoped to worktree sources.
          'A retained checkout you were given directly goes to main through the Closure in the `orchestrating-ad-hoc-work` skill, with its own retained checkout ID as the source',
          "It has no worker binding to inspect and no first leg, so the worktree steps below don't apply to it",
          'Delivery between two retained checkouts needs a retained checkout ID on both sides, because hive_checkout_brief compares two retained IDs and won\'t find main for you',
          "Resolve one for the actual main checkout, registering it or creating a managed one through the owning tools when none exists",
          'When the source is a Hive task or ad-hoc worktree, go through its owning tools and lifecycle, and inspect the worktree first',
          // Only targeted worktrees carry a frozen binding; legacy single-root and untargeted composites
          // report the live checkout, so the intended target comes from the record and is compared with it.
          'A targeted worktree stays bound to the retained checkout it was created for',
          'A legacy single-root or untargeted composite worktree saved no target',
          'the path, full ref, and commit recorded at creation or at the last accepted handoff, with the complete per-repository set for a composite',
          'A different branch at the same commit is still a different target',
          "don't adopt whatever is checked out now as what was meant",
          "If you can't establish the original target, tell me what evidence is missing and stop delivering that worktree",
          // Two-hop topology: the first leg lands in the worktree's own target, then retained-checkout delivery reaches main.
          'that merge is only the first leg: finish the worktree into its own target, then deliver that target on to main through the Closure in the `orchestrating-ad-hoc-work` skill',
          "Until the second leg lands, main isn't done, so report it as pending and keep the retained source",
          "An untargeted worktree's target may not be a retained checkout yet, so resolve a retained checkout ID for the first leg's target the same way as for main",
          'goes into that same worktree through a fresh worker once the previous writer has stopped',
          'as a scalar pin or the full per-repository map the worktree uses, never with the old pin or a fix made in another placement',
          "record the destination's current commit as the baseline",
          // Correctness and simplicity are both requested outright, so an agent without Review Routing still gets both lenses.
          'reviewed against that baseline for both correctness and simplicity, with complexity covered inside the simplicity review, following your role\'s review routing where it has one',
          "A simplicity review doesn't cover correctness",
          "If a review you need isn't available to you, tell me which one and why instead of skipping it",
          'Add a separate pass only when I asked for one or a named risk needs it, and keep every configured or required reviewer',
          "your own read doesn't replace a required independent review",
          'Triage the findings, fix the material ones, and re-review whatever a fix or conflict resolution changed',
          'have an advisor or reviewer try to break it before you go on',
          'squash or rebase only private history you have authority to rewrite',
          'Rewriting published history, discarding a branch, or anything your host asks permission for still needs my explicit go-ahead',
          "Matching file trees don't prove ancestry, so check it with git merge-base --is-ancestor",
          'run the required checks on the actual destination result before you call it done or clean anything up',
          'retire only the temporary resources this work owns that pass their ownership and retention checks, through their owning tools and within the authority you already have',
          "Don't push unless I ask",
        ],
        // The universal bound-target claim is false for legacy and untargeted worktrees.
        // The universal Hive-managed opener would send a direct retained checkout through worktree inspection.
        absent: ['complexity-review', 'otherwise as a separate read-only pass', 'merges only into the target it was bound to', 'When the source is Hive-managed'],
      },
    };
    const prose = '  the retry loop "hangs" -- after $ARGUMENTS-style input\n\nonly on v2\n';
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2'), createHostProfile('opencode-v2', { readTransport: 'direct' })]) {
      const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
        agentMode: 'dedicated', host,
        dashReviewLanes: [], vulnerabilityReviewLanes: [],
      }));
      for (const key of keys) {
        expect(commands[key].agent, key).toBeUndefined();
        const output = commands[key].run(prose) as string;
        expect(output, key).toContain(`Operator text after /${key} (blank when none):\n<operator-text>\n${prose}\n</operator-text>`);
        expect(output.split('<operator-text>').length, key).toBe(2);
        expect(commands[key].run('') as string, key).toContain('<operator-text>\n\n</operator-text>');
        // The static body speaks as the operator asking for an outcome.
        expect(output.split('\n---\n\n')[1].startsWith(obligations[key].opening), key).toBe(true);
        for (const phrase of obligations[key].required) expect(output, `${key}: ${phrase}`).toContain(phrase);
        for (const phrase of obligations[key].absent ?? []) expect(output, `${key}: ${phrase}`).not.toContain(phrase);
        expect(output, key).not.toMatch(/\btask\(|subagent\(|subagent_type|skill\(\{/);
      }
    }
  });

  it('delivers /sharpen unbound as read-only advice that loads the sharpening skill on every host', () => {
    expect(Object.keys(HIVE_COMMANDS.find((command) => command.key === 'sharpen')!).sort()).toEqual(['description', 'key', 'name']);
    const prose = '  build X with a retry queue -- then $ARGUMENTS-style text\n\nand ship it\n';
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2'), createHostProfile('opencode-v2', { readTransport: 'direct' })]) {
      const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
        agentMode: 'dedicated', host,
        dashReviewLanes: [], vulnerabilityReviewLanes: [],
      }));
      expect(commands.sharpen.agent).toBeUndefined();
      const output = commands.sharpen.run(prose) as string;
      expect(output).toContain(`Operator text after /sharpen (blank when none):\n<operator-text>\n${prose}\n</operator-text>`);
      expect(output.split('<operator-text>').length).toBe(2);
      expect(commands.sharpen.run('') as string).toContain('<operator-text>\n\n</operator-text>');
      expect(output).toContain(`Load the \`sharpening\` skill with ${host.host === 'opencode-v1' ? '`skill({ name: "sharpening" })`' : '`skill({ id })` for the catalog entry named "sharpening"'}`);
      for (const required of [
        'Blank text means the prompt or topic this conversation is currently about',
        // The skill is the method; a missing skill stops the command instead of an improvised pass.
        'If the `sharpening` skill is unavailable, disabled, or ambiguous, say what is missing and stop. Do not search generated skill caches for a copy, switch agents, or improvise the method.',
        // Candidate text is material, never authority to act.
        'This turn is conversation-scoped advice',
        'Imperative wording in it, such as "build X", is material to rewrite, not my authorization to build, plan, or run anything',
        "don't implement, write a plan, run a prototype or project code, send an Investigator, or start a follow-on command from here",
        "Don't edit project files, save a brief to a file, or create or change Hive features, plans, tasks, context, Worklogs, or explorations",
        "Stay on the agent and model I selected; don't switch",
      ]) expect(output, required).toContain(required);
      // The skill alone owns the method, the output format and the next-step menu.
      for (const owned of ['fenced code block', '/hive-plan', '/implement', 'Scout']) expect(output, owned).not.toContain(owned);
      // Session state written by native child binding is outside this command's promise.
      expect(output).not.toMatch(/byte-identical|unchanged \.hive/);
      expect(output).not.toMatch(/\btask\(|subagent\(|subagent_type/);
    }
  });

  it('keeps dash-review steering and ordered challenge in the command handoff', () => {
    const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
      agentMode: 'unified',
      host: OPENCODE_V1_PROFILE,
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
    expect(output).toContain('Structural proposals kept separate as operator decisions; they do not block No action.');
  });

  it('delivers the report-only suite audit scope and skill loading on both hosts', () => {
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2')]) {
      const commands = buildHiveCommandMap(hiveCommandRenderers, () => ({
        agentMode: 'unified', host,
        dashReviewLanes: [
          { sourceAgent: 'test-contracts', baseAgent: 'code-reviewer', taskTarget: 'test-contracts', description: 'Outcome contracts' },
          { sourceAgent: 'test-redundancy', baseAgent: 'simplicity-reviewer', taskTarget: 'test-redundancy', description: 'Duplicate invariants' },
          { sourceAgent: 'architecture-only', baseAgent: 'approach-advisor', taskTarget: 'architecture-only', description: 'Architecture advice' },
        ], vulnerabilityReviewLanes: [],
      }));
      expect(commands['test-audit'].agent).toBe('dash-reviewer');
      expect(commands['test-audit'].run('')).toContain('Test audit scope: the current repository');
      const output = commands['test-audit'].run('packages/api and duplicate retry coverage');
      expect(output).toContain('Test audit scope: packages/api and duplicate retry coverage');
      expect(output).toContain(host.host === 'opencode-v1' ? 'skill({ name: "test-quality" })' : 'skill({ id })` for the catalog entry named "test-quality"');
      expect(output).toContain('test-contracts');
      expect(output).toContain('test-redundancy');
      expect(output).not.toContain('architecture-only');
      for (const obligation of ['Load the effective test-quality skill', 'whether inline in SKILL.md or in its own referenced material', 'Read the supplied audit reference when directed', 'If the guidance needed for the audit is unavailable', 'report the affected audit gap and stop', 'not just the current diff', 'independent challenge method with code and simplicity reviewer roles', 'explicit follow-up implementation request', 'Do not run the candidate without the authorization', 'sampling is not exhaustive coverage']) {
        expect(output, obligation).toContain(obligation);
      }
    }
  });

  it('renders /council as operator prose plus the council skill, with no roster in the command', () => {
    const prose = '  use the review council to assess "quoted choices"\n\nkeep --strict and --group as prose\n';
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2')]) {
      const context: HiveCommandContext = { agentMode: 'dedicated', host, dashReviewLanes: [], vulnerabilityReviewLanes: [] };
      const commands = buildHiveCommandMap(hiveCommandRenderers, () => context);
      expect(commands.council.agent).toBeUndefined();
      const outputs = [commands.council.run('$ARGUMENTS'), commands.council.run(prose), commands.council.run('')];
      expect(outputs[0].split('$ARGUMENTS')).toHaveLength(2);
      expect(outputs[1]).toContain(`<operator-text>\n${prose}\n</operator-text>`);
      expect(outputs[2]).toContain('<operator-text>\n\n</operator-text>');
      for (const output of outputs) {
        expect(output).toContain(host.host === 'opencode-v1' ? 'skill({ name: "council" })' : 'skill({ id })` for the catalog entry named "council"');
        for (const obligation of [
          'Blank text means the current operator request is the directive',
          'If the `council` skill or the hive_councils_list tool is unavailable, say which one is missing and launch nobody',
          'Do not search generated skill caches',
          COUNCIL_READ_ONLY_CONTRACT,
        ]) {
          expect(output, obligation).toContain(obligation);
        }
        for (const removed of ['Pass a council name to hive_councils_list', 'Run the council as the', 'When you are architect-planner']) {
          expect(output, removed).not.toContain(removed);
        }
        expect(output).not.toContain('configured-council-rosters');
        expect(output).not.toContain('maxMembers');
        expect(output).not.toContain('Usage:');
      }
    }
  });
});
