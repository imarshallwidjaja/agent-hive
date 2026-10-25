#!/usr/bin/env node
// Local dual-host instruction evaluation runner. Node standard library only.
//
//   node run.mjs wiring     --candidate-ref <ref> <common>
//   node run.mjs acceptance --candidate-manifest <path> --scenarios <id,id,...> (--rehearsal | --auth openai-access-only) <common>
//   <common> = --hosts v1,v2 --timeout-seconds 600 --run-id <id> --output-root <abs dir>
//              [--docker-endpoint unix:///var/run/docker.sock]
//   paid only: [--case-limit <n>] [--resume-from <run dir> --resume-decision <text> [--repurchase <host:item,...>]]
//
// `acceptance` collects the named scenarios on a wired candidate without a baseline. A collected run means the cases
// ran safely and their evidence was captured; it is not a verdict on the instructions, which a person assesses from
// the exported records.
//
// Every Docker call goes through one explicitly bound local unix-socket endpoint with a run-owned empty CLI config
// and an allowlisted environment. Credentials are read only in paid phases, after builds, the credential-free
// rehearsal and resume validation, and reach a container only over `docker exec -i` stdin after its lifetime guard
// has acknowledged a non-extendable deadline.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CredentialError, assertLifetime, fingerprintAuthFile, hostAuthPath, readAccessOnly, sameFingerprint, secretScanner } from './credentials.mjs';
import { GUARD_EXIT_CODE } from './guard.mjs';
import { HOST_IDS, MANAGED_CONTROL_HOST, authRequest, managedControlPlan, requiredLifetimeMs, sameModelView, selectionExpectations } from './hosts.mjs';
import {
  AGENT_USER, Docker, GUARD, GUARD_USER, HARNESS_REL, HarnessError, ISOLATION, Journal, Resources, assessContainerIsolation, build,
  containerCreateArgs, createRunDir, gitOut, resolveIdentities, runtimeFailures, runtimeIdentity, sha256File, sha256Text, verifyArtifact,
  verifyDockerBoundary, writeOnce,
} from './runtime.mjs';

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = '/opt/ic/harness/fixture.ts';
const MAX_DEADLINE_SECONDS = 600;
const LIFETIME_MARGIN_MS = 10 * 60_000;
// Container lifetime ceilings, enforced inside each container by guard.mjs. A credential-bearing container also gets a
// shorter one-shot deadline armed immediately before injection.
const CEILING = { rehearsal: 1500, wiring: 3600, auxiliary: 900, paidSetup: 1260 };
const AUXILIARY_DEADLINE_SECONDS = 300;

const MANIFEST_SCHEMA = 'ic-run-manifest/v3';

// Run statuses and their process exit codes. `collected` means every selected case produced a safe, valid record; it
// says nothing about whether the instructions behaved well. `checkpoint` means a paid run stopped at a case boundary
// on purpose and can be continued with --resume-from; `incomplete` means some case needs an explicit repurchase
// decision.
export const STATUS_EXIT = { passed: 0, 'rehearsal-passed': 0, collected: 0, checkpoint: 3, incomplete: 1, failed: 1 };

// -----------------------------------------------------------------------------------------------------------------
// CLI

export function parseCli(argv) {
  const [phase, ...rest] = argv;
  if (!['wiring', 'acceptance'].includes(phase)) throw new HarnessError('phase_required');
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      strict: true,
      options: {
        'candidate-ref': { type: 'string' },
        'candidate-manifest': { type: 'string' },
        scenarios: { type: 'string' },
        auth: { type: 'string' },
        rehearsal: { type: 'boolean' },
        hosts: { type: 'string' },
        'timeout-seconds': { type: 'string' },
        'run-id': { type: 'string' },
        'output-root': { type: 'string' },
        'docker-endpoint': { type: 'string' },
        'case-limit': { type: 'string' },
        'resume-from': { type: 'string' },
        'resume-decision': { type: 'string' },
        repurchase: { type: 'string' },
      },
    }));
  } catch {
    throw new HarnessError('arguments_invalid');
  }
  const allowed = {
    wiring: ['candidate-ref'],
    acceptance: ['candidate-manifest', 'scenarios', 'auth', 'rehearsal'],
  }[phase];
  const phaseOptions = ['candidate-ref', 'candidate-manifest', 'scenarios', 'auth', 'rehearsal'];
  for (const key of phaseOptions) if (values[key] !== undefined && !allowed.includes(key)) throw new HarnessError('ambiguous_subject', key);
  const hosts = (values.hosts ?? '').split(',').filter(Boolean);
  if (hosts.length === 0 || hosts.some((h) => !HOST_IDS.includes(h)) || new Set(hosts).size !== hosts.length) throw new HarnessError('hosts_invalid');
  const timeoutSeconds = Number(values['timeout-seconds']);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > MAX_DEADLINE_SECONDS) throw new HarnessError('timeout_invalid');
  const runId = values['run-id'];
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) throw new HarnessError('run_id_invalid');
  const outputRoot = values['output-root'];
  if (!outputRoot || !isAbsolute(outputRoot)) throw new HarnessError('output_root_invalid');
  const endpoint = values['docker-endpoint'] ?? 'unix:///var/run/docker.sock';
  const rehearsal = Boolean(values.rehearsal);
  const paid = phase === 'acceptance' && !rehearsal;
  if (phase === 'wiring' && !values['candidate-ref']) throw new HarnessError('candidate_ref_required');
  if (phase === 'acceptance' && !values['candidate-manifest']) throw new HarnessError('manifest_required');
  if (rehearsal && values.auth !== undefined) throw new HarnessError('ambiguous_subject', 'rehearsal_with_auth');
  if (paid && values.auth !== 'openai-access-only') throw new HarnessError('auth_mode_required');
  // The scope is named, finite and recorded; there is no default set. Unknown names are refused against the committed
  // scenario set before any build or credential.
  let scenarios = [];
  if (phase === 'acceptance') {
    if (values.scenarios === undefined) throw new HarnessError('scenarios_required');
    scenarios = values.scenarios.split(',');
    if (scenarios.some((id) => !/^[a-z0-9][a-z0-9-]*$/.test(id)) || new Set(scenarios).size !== scenarios.length) throw new HarnessError('scenarios_invalid');
  }
  for (const key of ['resume-from', 'resume-decision', 'repurchase', 'case-limit']) {
    if (!paid && values[key] !== undefined) throw new HarnessError('option_requires_paid_phase', key);
  }
  if (Boolean(values['resume-from']) !== Boolean(values['resume-decision'])) throw new HarnessError('resume_requires_decision');
  if (values.repurchase !== undefined && !values['resume-from']) throw new HarnessError('repurchase_requires_resume');
  let caseLimit = null;
  if (values['case-limit'] !== undefined) {
    caseLimit = Number(values['case-limit']);
    if (!Number.isInteger(caseLimit) || caseLimit <= 0) throw new HarnessError('case_limit_invalid');
  }
  const repurchase = (values.repurchase ?? '').split(',').filter(Boolean);
  if (repurchase.some((key) => !/^v[12]:[a-z0-9-]+$/.test(key))) throw new HarnessError('repurchase_invalid');
  return {
    phase, paid, rehearsal, hosts, scenarios, timeoutSeconds, runId, outputRoot, endpoint, caseLimit, repurchase,
    candidateRef: values['candidate-ref'], candidateManifest: values['candidate-manifest'],
    resumeFrom: values['resume-from'], resumeDecision: values['resume-decision'],
  };
}

// -----------------------------------------------------------------------------------------------------------------
// Committed scenario set

function harnessScenarioSet(repoRoot, harnessCommit) {
  const text = gitOut(['show', `${harnessCommit}:${HARNESS_REL}/scenarios.json`], repoRoot);
  return { scenarios: JSON.parse(text), sha256: sha256Text(text) };
}

// -----------------------------------------------------------------------------------------------------------------
// Scenario checks. Fixed data in scenarios.json is evaluated against the allowlisted exported record. Neither list
// below judges behavior:
//   - `fixtureChecks` hold in any run that used a sound fixture. A failing one makes the case `fixture_invalid`, a
//     harness defect and never an instruction outcome.
//   - `rehearsal.expect` describes what the scripted shortest path leaves behind. Only the credential-free rehearsal
//     reads it, to show that the fixture has a compliant path. A live case is never compared with it.
// Calls are matched by their sanitized outcome: `match: 'succeeded'` counts calls whose own result was a success (for
// a dispatch, a verified child session of the requested agent), `match: 'attempted'` counts every call. Missing
// evidence is `unrun`, which is never a pass.

function renderFacts(text, facts) {
  return text.replace(/\{\{([^{}]+?)\}\}/g, (whole, key) => {
    const value = facts?.[key];
    if (value === undefined) return whole;
    return escapeRegExp(typeof value === 'string' ? value : JSON.stringify(value));
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOk(count, n) {
  return (count?.min === undefined || n >= count.min) && (count?.max === undefined || n <= count.max);
}

/** Calls matching one check's filters, in exported order. */
function matchingCalls(spec, record, re) {
  const names = spec.name === undefined ? null : [spec.name].flat();
  let calls = record.toolCalls;
  if (spec.kind === 'dispatch' || spec.tool === 'dispatch') calls = calls.filter((c) => c.tool === 'dispatch');
  if (names) calls = calls.filter((c) => names.includes(c.tool));
  if (spec.agent) calls = calls.filter((c) => c.args.agent === spec.agent);
  if (spec.by) calls = calls.filter((c) => c.agent === spec.by);
  if (spec.background !== undefined) calls = calls.filter((c) => c.args.background === spec.background);
  if (spec.promptMatches) calls = calls.filter((c) => spec.promptMatches.every((p) => re(p).test(c.args.prompt ?? '')));
  for (const [key, pattern] of Object.entries(spec.argsMatch ?? {})) calls = calls.filter((c) => typeof c.args[key] === 'string' && re(pattern).test(c.args[key]));
  for (const key of spec.argsAbsent ?? []) calls = calls.filter((c) => c.args[key] === undefined);
  if (spec.match === 'succeeded') calls = calls.filter((c) => c.outcome?.result === 'success');
  for (const [key, value] of Object.entries(spec.outcome ?? {})) calls = calls.filter((c) => c.outcome?.[key] === value);
  return calls;
}

export function checkCriterion(criterion, record) {
  const facts = record.facts ?? {};
  const re = (pattern) => new RegExp(renderFacts(pattern, facts), 'im');
  switch (criterion.kind) {
    case 'dispatch':
    case 'tool': {
      const calls = matchingCalls(criterion, record, re);
      const n = criterion.distinct === 'session' ? new Set(calls.map((c) => c.session)).size : calls.length;
      return { result: countOk(criterion.count, n) ? 'pass' : 'fail', detail: { count: n } };
    }
    case 'order': {
      // A `before` call must precede the first `after` call in the same session. `seq` orders calls within one
      // session only, so a check never compares calls across sessions.
      const before = matchingCalls(criterion.before, record, re);
      const after = matchingCalls(criterion.after, record, re);
      if (after.length === 0) return { result: 'fail', detail: 'no later call' };
      const first = new Map();
      for (const call of after) if (!first.has(call.session)) first.set(call.session, call.seq);
      const ok = before.some((call) => first.has(call.session) && call.seq < first.get(call.session));
      return { result: ok ? 'pass' : 'fail', detail: { before: before.length, after: after.length } };
    }
    case 'probe': {
      if (!(criterion.probe in (record.probes ?? {}))) return { result: 'unrun', detail: 'probe missing' };
      const value = record.probes[criterion.probe];
      if (value && typeof value === 'object' && value.error) return { result: 'unrun', detail: value.error };
      let ok;
      if ('equals' in criterion) ok = value === criterion.equals;
      else if ('notEquals' in criterion) ok = value !== null && value !== undefined && value !== criterion.notEquals;
      else if ('equalsFact' in criterion) ok = facts[criterion.equalsFact] !== undefined && value === facts[criterion.equalsFact];
      else if ('atLeast' in criterion) ok = Number(value) >= criterion.atLeast;
      else if ('atMost' in criterion) ok = typeof value === 'number' && value <= criterion.atMost;
      else return { result: 'unrun', detail: 'no expectation' };
      return { result: ok ? 'pass' : 'fail', detail: { value: typeof value === 'string' ? value.slice(0, 80) : value } };
    }
    default:
      return { result: 'unrun', detail: 'unknown kind' };
  }
}

/** Ids of the checks that did not pass, among those a list names. */
export function failedChecks(checks, record) {
  return (checks ?? []).filter((check) => checkCriterion(check, record).result !== 'pass').map((check) => check.id);
}

/** Error class names a host persisted on any session of the case. A rejected `question` call is the harness's headless answer, not a host failure. */
function hostErrorNames(record) {
  const askedQuestion = (record.toolCalls ?? []).some((c) => c.tool === 'question');
  return [...new Set((record.sessions ?? []).flatMap((s) => s.errorNames ?? []))]
    .filter((name) => !(askedQuestion && /question.*reject|reject.*question/i.test(name)));
}

/**
 * How the run ended, from the two places that prove it: the driver's reply to the runner and the run state the export
 * carries. A timeout or blocked interaction in either counts, so a lost reply cannot hide one. Otherwise both must
 * exist and agree, and the exit must be 0. Returns null for a run that ended on its own with exit 0.
 */
export function runEndFailure(run, record) {
  const persisted = record?.run;
  if (run?.timedOut || persisted?.timedOut) return 'timeout';
  if (run?.asked || persisted?.asked) return 'interaction_blocked';
  if (typeof run?.exit !== 'number' || typeof persisted?.exit !== 'number') return 'run_proof_missing';
  if (run.exit !== persisted.exit) return 'run_proof_inconsistent';
  return persisted.exit === 0 ? null : 'run_exit_nonzero';
}

/**
 * Why an exported record cannot be read as the whole case: a session history whose read failed, or observer requests
 * cut at the cap (the model evidence would cover only a prefix). A history the page cap cut short is disclosed in
 * `limits.historyIncomplete` and is not a failure.
 */
export function recordReadFailures(record) {
  const limits = record?.limits ?? {};
  return [...((limits.historyFailed ?? []).length > 0 ? ['history_read_failed'] : []), ...(limits.requestsTruncated ? ['observer_requests_truncated'] : [])];
}

const hasPrimaryResponse = (record) => (record.sessions ?? []).some((s) => s.role === 'primary' && s.assistantMessages > 0);

/**
 * Why one scripted rehearsal did not show a compliant path through its fixture. Only plumbing and fixture state are
 * read: the run ended on its own with exit 0, the whole record was read, no host or provider error was persisted, the
 * primary answered, the fixture was sound and the scripted path left the state `rehearsal.expect` names. Nothing here
 * reads a model's words.
 */
export function rehearsalPathFailures(group, { run, record }) {
  if (!record) return ['record_missing'];
  const failures = [];
  const end = runEndFailure(run, record);
  if (end) failures.push(end);
  failures.push(...recordReadFailures(record));
  const errorNames = hostErrorNames(record);
  if (errorNames.length > 0) failures.push(`host_error:${errorNames.slice(0, 5).join(',')}`);
  if (!hasPrimaryResponse(record)) failures.push('no_primary_response');
  for (const id of failedChecks(group.fixtureChecks, record)) failures.push(`fixture:${id}`);
  for (const id of failedChecks(group.rehearsal.expect, record)) failures.push(`path:${id}`);
  return failures;
}

/**
 * Whether every model request in an exported case used the frozen model, as the persisted messages, the host's
 * resolved request and (on v2) the outbound wire payload all show it. `aliases` lists legitimate wire names of the
 * frozen model from the scenario set; any other name is a different model.
 *
 * Every responding session needs observed requests. On v1 that is `chat.params`, whose resolved API identity must be
 * the frozen model or an alias. On v2 it is a `model.request` per model call, each with its own correlated HTTP or
 * WebSocket payload whose model is the frozen model or an alias; `context` records alone, a call without a payload and
 * a payload naming another model are all invalid evidence, whatever any other subject observed.
 */
export function modelEvidenceFailures(record, host, model, aliases = []) {
  const failures = [];
  const accepted = new Set([model.id, ...aliases]);
  const requests = record.requests ?? [];
  if (requests.some((r) => r.malformed)) failures.push('observer_record_malformed');
  const responding = (record.sessions ?? []).filter((s) => s.assistantMessages > 0);
  for (const session of responding) {
    for (const m of session.models ?? []) {
      if (m.providerID !== 'openai' || m.modelID !== model.id) failures.push(`message_model_unexpected:${session.agent}`);
      if (host === 'v2' && (m.variant ?? 'default') !== (model.variant ?? 'default')) failures.push(`message_variant_unexpected:${session.agent}`);
    }
  }
  if (host === 'v1') {
    for (const r of requests.filter((x) => x.hook === 'chat.params')) {
      if (r.providerID !== 'openai' || r.modelID !== model.id) failures.push(`request_model_unexpected:${r.agent}`);
      if (r.apiModelID !== undefined && !accepted.has(r.apiModelID)) failures.push(`api_model_unexpected:${r.agent}`);
    }
    for (const session of responding) {
      if (!requests.some((r) => r.hook === 'chat.params' && r.sessionID === session.id)) failures.push(`requests_unobserved:${session.agent}`);
    }
    return [...new Set(failures)];
  }
  const modelCalls = requests.filter((r) => r.hook === 'model.request');
  const payloads = requests.filter((r) => r.hook === 'http.request' || r.hook === 'experimental.ws.send');
  for (const call of modelCalls) {
    if (call.providerID !== 'openai' || call.modelID !== model.id) failures.push(`request_model_unexpected:${call.agent}`);
  }
  for (const p of payloads) {
    if (p.payload && !accepted.has(p.payload.model)) failures.push(`payload_model_unexpected:${p.agent}`);
  }
  for (const session of responding) {
    const calls = modelCalls.filter((r) => r.sessionID === session.id).sort((a, b) => a.at - b.at);
    if (calls.length === 0) failures.push(`model_request_unobserved:${session.agent}`);
    const own = payloads.filter((p) => p.sessionID === session.id);
    calls.forEach((call, i) => {
      const next = calls[i + 1]?.at ?? Infinity;
      if (!own.some((p) => p.at >= call.at && p.at < next && typeof p.payload?.model === 'string')) failures.push(`payload_unobserved:${call.agent ?? session.agent}:${call.kind}`);
    });
  }
  return [...new Set(failures)];
}

/** Per-agent effective model settings observed in one case. Hosts apply their own defaults, so these are recorded, never compared across runs or hosts. */
export function effectiveSettings(record) {
  const out = {};
  for (const r of record.requests ?? []) {
    const settings = r.payload?.settings ?? r.settings;
    if (!r.agent || !settings || (r.hook !== 'chat.params' && r.hook !== 'http.request' && r.hook !== 'experimental.ws.send')) continue;
    const key = JSON.stringify({ model: r.payload?.model ?? r.apiModelID ?? r.modelID, variant: r.variant ?? null, settings: Object.fromEntries(Object.entries(settings).sort()) });
    (out[r.agent] ??= new Set()).add(key);
  }
  return Object.fromEntries(Object.entries(out).sort().map(([agent, keys]) => [agent, [...keys].sort()]));
}

/**
 * The outcome class of one paid case. Only `collected` is a usable record: the case ran to its end on the frozen model
 * on a sound fixture and its export is complete enough to read. `collected` is neither a pass nor a fail; whether the
 * instructions behaved well is for a person to assess from the record. Timeouts, host or provider errors, blocked
 * interactions, invalid fixtures and invalid model evidence are not observations of the instructions.
 */
export function classifyCase({ timedOut, run, record, fixtureInvalid, host, model, aliases = [] }) {
  const end = runEndFailure(run, record);
  if (timedOut || end === 'timeout') return { outcome: 'timeout' };
  if (!record) return { outcome: 'evidence_invalid', code: 'record_missing' };
  const unreadable = recordReadFailures(record);
  if (unreadable.length > 0) return { outcome: 'evidence_invalid', code: unreadable.join(',') };
  if (end === 'run_proof_missing' || end === 'run_proof_inconsistent') return { outcome: 'evidence_invalid', code: end };
  if (fixtureInvalid) return { outcome: 'fixture_invalid' };
  const errorNames = hostErrorNames(record);
  if (errorNames.length > 0 || end === 'run_exit_nonzero') return { outcome: 'host_error', code: errorNames.length > 0 ? errorNames.slice(0, 5).join(',') : end };
  if (end === 'interaction_blocked') return { outcome: 'interaction_blocked', code: (run?.asked ?? record.run?.asked)?.kind ?? 'unknown' };
  if (!hasPrimaryResponse(record)) return { outcome: 'evidence_invalid', code: 'no_primary_response' };
  const evidence = modelEvidenceFailures(record, host, model, aliases);
  if (evidence.length) return { outcome: 'evidence_invalid', code: evidence.slice(0, 5).join(',') };
  return { outcome: 'collected' };
}

/**
 * Selects the frozen model: the first configured preference, only when every requested host catalog lists it as
 * tool-capable. A lower preference is never substituted, so a missing first choice stops the run (null) before any
 * preflight or case instead of observing a different model.
 */
export function selectSharedModel(preference, catalogs) {
  const [id] = preference;
  if (id === undefined) return null;
  return Object.values(catalogs).every((models) => models.some((m) => m.id === id && m.toolCall)) ? id : null;
}

/** The named scenarios in the order given. An unknown name is refused before any build or credential. */
export function selectScenarios(groups, names) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const unknown = names.filter((name) => !byId.has(name));
  if (unknown.length > 0) throw new HarnessError('scenario_unknown', unknown);
  return names.map((name) => byId.get(name));
}

/**
 * Whether the candidate wiring run (F3) is the one this collection run (F4) builds on: it covered every requested
 * host, installed the same tarball, and ran on exactly this runtime identity. A passing wiring run on fewer hosts, or
 * on the same artifact in a different host-runtime graph, says nothing about the run being made.
 */
export function candidateBindingMismatches(wiring, { hosts, runtimeIdentity, artifactSha256 }) {
  const mismatches = [];
  const covered = new Set(wiring.hosts ?? []);
  for (const host of hosts) if (!covered.has(host)) mismatches.push(`wiring_host_not_covered:${host}`);
  if (wiring.artifact?.sha256 !== artifactSha256) mismatches.push('wiring_artifact_differs');
  if (JSON.stringify(wiring.runtimeIdentity) !== JSON.stringify(runtimeIdentity)) mismatches.push('wiring_runtime_differs');
  return mismatches;
}

// -----------------------------------------------------------------------------------------------------------------
// Scenario container lifecycle

async function exec(docker, id, command, input, { stdin, timeoutMs = 300_000 } = {}) {
  const args = ['exec', ...(stdin !== undefined ? ['-i'] : []), '--user', AGENT_USER, id, 'node', FIXTURE, command, JSON.stringify(input ?? {})];
  const result = await docker.run(args, { input: stdin, timeoutMs });
  return { code: result.code, timedOut: result.timedOut, value: lastJsonLine(result.stdout) };
}

function lastJsonLine(stdout) {
  try { return JSON.parse(stdout.trim().split('\n').at(-1) ?? ''); } catch { return null; }
}

async function guardCommand(ctx, id, args, user = GUARD_USER) {
  const result = await ctx.docker.run(['exec', '--user', user, id, 'node', GUARD, ...args], { timeoutMs: 30_000 });
  return lastJsonLine(result.stdout);
}

/**
 * Arms the container's one-shot deadline and returns the guard's acknowledgement. Nothing secret enters the container
 * before this resolves; the acknowledged deadline can never be later than requested.
 */
export async function armGuard(ctx, id, seconds) {
  const requestedAt = Date.now();
  const ack = await guardCommand(ctx, id, ['arm', String(seconds)]);
  if (!ack?.ok || !ack.armed || !(ack.deadlineAt <= Date.now() + seconds * 1000) || !(ack.deadlineAt >= requestedAt)) {
    throw new HarnessError('guard_arm_failed', { failure: ack?.failure ?? null });
  }
  return { deadlineAt: ack.deadlineAt, ceilingAt: ack.ceilingAt, armedAt: ack.armedAt };
}

/** Creates, starts and inspects one scenario container. Returns its ID only when the guard and isolation checks pass. */
async function openContainer(ctx, { network, ceilingSeconds }) {
  const id = await ctx.resources.create('container', (labels) => containerCreateArgs({
    image: ctx.runtime.imageId, labels, network, password: randomBytes(24).toString('hex'), ceilingSeconds,
  }));
  const started = await ctx.docker.run(['start', id]);
  if (started.code !== 0) throw new HarnessError('container_start_failed');
  const status = await guardCommand(ctx, id, ['status']);
  if (!status?.ok || status.armed) throw new HarnessError('guard_not_ready');
  const inspect = (await ctx.docker.json(['inspect', id]))?.[0];
  const probe = (await exec(ctx.docker, id, 'isolation-probe', {})).value;
  const verdict = assessContainerIsolation(inspect, probe, { network, ceilingSeconds });
  if (!verdict.ok) throw new HarnessError('isolation_check_failed', verdict.failures);
  return id;
}

async function step(ctx, id, command, input, options) {
  const result = await exec(ctx.docker, id, command, input, options);
  if (!result.value) throw new HarnessError('fixture_output_malformed', { phase: command, timedOut: result.timedOut });
  if (result.value.ok === false) throw new HarnessError(result.value.failure ?? 'fixture_step_failed', { phase: command, detail: ctx.secretBearing ? undefined : result.value.detail });
  return result.value;
}

async function rehearseCase(ctx, host, group) {
  const id = await openContainer(ctx, { network: 'none', ceilingSeconds: CEILING.rehearsal });
  try {
    await step(ctx, id, 'serve', { host, provider: 'mock', model: ctx.scenarios.model.mock, agentMode: group.agentMode, scenario: group.id });
    const setup = await step(ctx, id, 'setup', { host, scenario: group.id }, { timeoutMs: 900_000 });
    const run = await step(ctx, id, 'run', { host, scenario: group.id, mode: 'mock', timeoutMs: 300_000 }, { timeoutMs: 330_000 });
    const exported = await step(ctx, id, 'export', { host, scenario: group.id });
    const runSummary = { exit: run.exit, asked: run.asked, timedOut: run.timedOut };
    const failures = rehearsalPathFailures(group, { run: runSummary, record: exported.record });
    return { host, group: group.id, setupSteps: setup.steps.length, run: runSummary, failures, record: exported.record };
  } finally {
    await ctx.resources.remove(id);
  }
}

/**
 * Rehearses the container lifetime guard: an agent-uid process can neither arm nor signal it, the one-shot arm is
 * acknowledged and cannot be extended, and once armed the whole container stops on its own at the deadline, with a
 * detached signal-ignoring canary inside and a host exec client killed as if the runner had died. The runner sends no
 * kill. No credential is involved.
 */
export async function rehearseLifetime(ctx, { armSeconds = 15, graceMs = 20_000, pollMs = 1000 } = {}) {
  const id = await openContainer(ctx, { network: 'none', ceilingSeconds: 120 });
  try {
    const canary = await step(ctx, id, 'canary', {});
    const agentArm = await guardCommand(ctx, id, ['arm', '3600'], AGENT_USER);
    const ack = await armGuard(ctx, id, armSeconds);
    const second = await guardCommand(ctx, id, ['arm', '3600']);
    let client;
    const hung = ctx.docker.run(['exec', '--user', AGENT_USER, id, 'sleep', '600'], { timeoutMs: (armSeconds + 60) * 1000, onSpawn: (child) => { client = child; } });
    await new Promise((r) => setTimeout(r, pollMs));
    client?.kill('SIGKILL');
    await hung;
    let state = null;
    while (Date.now() < ack.deadlineAt + graceMs) {
      state = (await ctx.docker.json(['inspect', '--format', '{{json .State}}', id])) ?? null;
      if (state && state.Running === false) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    const stoppedAt = state?.FinishedAt ? Date.parse(state.FinishedAt) : null;
    const result = {
      canaryHeartbeat: canary.heartbeat === true,
      guardSignalRefused: canary.guardSignal === 'EPERM',
      agentArmRefused: agentArm?.ok !== true,
      armAcknowledged: true,
      secondArmRefused: second?.ok === false && second.failure === 'already_armed' && second.deadlineAt === ack.deadlineAt,
      stoppedWithoutHostKill: state?.Running === false,
      exitCode: state?.ExitCode ?? null,
      stoppedWithinMs: stoppedAt !== null ? stoppedAt - ack.deadlineAt : null,
    };
    return {
      ...result,
      ok: result.canaryHeartbeat && result.guardSignalRefused && result.agentArmRefused && result.secondArmRefused && result.stoppedWithoutHostKill
        && result.exitCode === GUARD_EXIT_CODE && result.stoppedWithinMs !== null && result.stoppedWithinMs < graceMs,
    };
  } finally {
    await ctx.resources.remove(id);
  }
}

/**
 * Rehearses the paid injection path with a made-up credential in a container without network: the native route
 * accepts the access-only shape, the container keeps the refresh placeholder, and the export scan can find the value.
 */
export async function rehearseInjection(ctx, host) {
  const id = await openContainer(ctx, { network: 'none', ceilingSeconds: CEILING.auxiliary });
  try {
    await step(ctx, id, 'serve', { host, provider: 'openai', model: ctx.scenarios.model.preference[0], agentMode: 'dedicated' });
    const synthetic = { access: `ic-synthetic-access-${randomBytes(16).toString('hex')}`, expires: Date.now() + 2 * 3_600_000, accountId: 'ic-synthetic-account' };
    await armGuard(ctx, id, AUXILIARY_DEADLINE_SECONDS);
    const injected = await exec(ctx.docker, id, 'inject-auth', { host }, { stdin: JSON.stringify(authRequest(host, synthetic)), timeoutMs: 60_000 });
    const stored = await step(ctx, id, 'verify-credential', { host });
    const secrets = await step(ctx, id, 'secret-probe', { host });
    const result = {
      host, injected: injected.value?.ok === true, status: injected.value?.status ?? null,
      sentinelRetained: stored.sentinelRetained, accessUnchanged: stored.accessUnchanged, secretsDiscovered: secrets.count,
    };
    return { ...result, ok: result.injected && result.sentinelRetained && result.accessUnchanged && result.secretsDiscovered >= 1 };
  } finally {
    await ctx.resources.remove(id);
  }
}

/**
 * Wiring observations of one host. `retained` receives the host's observation as soon as the first probe has made it, so
 * a later probe that fails still leaves what was already seen. When a step fails, `retain` is called with the host, the
 * phase that was running, and the failure's fixed code and detail, before the host's container is removed; whatever it
 * writes is therefore durable by the time of teardown. A retention failure and a cleanup failure never replace the
 * failure that started them: the first is noted on the error as `retention`, and the second is left to the run's
 * final cleanup, which settles and reports every resource still owned. When every probe succeeded and the container's
 * removal then fails, that cleanup failure is the failure: `retain` is called with phase `cleanup` before it is thrown.
 */
export async function wiringHost(ctx, host, retained = {}, retain = null) {
  let phase = 'open_container';
  let failure = null;
  let id;
  const retainFailure = async (error) => {
    if (!retain) return;
    try {
      await retain({ host, phase, code: error?.code ?? 'unexpected_exception', detail: error instanceof HarnessError ? error.detail ?? null : null });
    } catch (retention) {
      if (error && typeof error === 'object') error.retention = retention?.code ?? 'retention_failed';
    }
  };
  try {
    id = await openContainer(ctx, { network: 'none', ceilingSeconds: CEILING.wiring });
    // Stock permissions: no permissive allow rule. The override fixture supplies a same-name user skill; its case-only overrides stay out of wiring.
    const base = { host, provider: 'mock', model: ctx.scenarios.model.mock, agentMode: 'dedicated', scenario: 'skill-override-reference', permissive: false, wiring: true };
    const at = async (label, command, input, options) => { phase = label; return step(ctx, id, command, input, options); };
    await at('serve', 'serve', base);
    const wiring = (await at('wiring', 'wiring', { host }, { timeoutMs: 2_700_000 })).wiring;
    retained[host] = wiring;
    // Model-selection probes restart the host with their own Hive and native configuration in the same container.
    await at('stop', 'stop', {});
    await at('serve:valid', 'serve', { ...base, selection: 'valid' });
    wiring.modelSelection = (await at('model-selection:valid', 'model-selection', { host, probe: 'valid' }, { timeoutMs: 1_200_000 })).selection;
    // Same host, same configuration: the managed-model control needs the probe's Hive pairs and native model.
    if (host === MANAGED_CONTROL_HOST) wiring.managedModelControl = (await at('managed-model-control', 'managed-model-control', { host }, { timeoutMs: 1_500_000 })).control;
    await at('stop:valid', 'stop', {});
    const invalidServe = await at('serve:invalid', 'serve', { ...base, selection: 'invalid', allowNotReady: true });
    wiring.invalidModelSelection = { ready: invalidServe.ready === true, ...(await at('model-selection:invalid', 'model-selection', { host, probe: 'invalid' }, { timeoutMs: 300_000 })).selection };
    return wiring;
  } catch (error) {
    failure = error;
    await retainFailure(error);
    throw error;
  } finally {
    if (id) {
      try {
        await ctx.resources.remove(id);
      } catch (cleanup) {
        if (!failure) {
          // Every probe had succeeded, so the observations are complete; keep them before the cleanup error leaves.
          phase = 'cleanup';
          await retainFailure(cleanup);
          throw cleanup;
        }
      }
    }
  }
}

/**
 * The retention callback of a wiring run: writes `wiring.partial.json` once, with the failure, the command and the
 * subject, harness and runtime identities the run was made on, and every observation made so far, and records its hash
 * in the manifest. It is never a passing wiring record. Called before the failing host's container is removed.
 */
export function wiringRetention({ options, manifest, outDir, results }) {
  return (failure) => {
    const file = join(outDir, 'wiring.partial.json');
    const record = {
      schema: 'ic-wiring-partial/v1',
      complete: false,
      command: { phase: options.phase, candidateRef: options.candidateRef, hosts: options.hosts, timeoutSeconds: options.timeoutSeconds, runId: options.runId },
      subject: manifest.subject ?? null,
      harness: manifest.harness ?? null,
      artifactSha256: manifest.artifact?.sha256 ?? null,
      runtimeIdentity: manifest.runtimeIdentity ?? null,
      failure,
      observations: results,
    };
    writeOnce(file, JSON.stringify(record, null, 2));
    manifest.wiringPartial = { file: 'wiring.partial.json', sha256: sha256File(file) };
  };
}

/**
 * Model-selection requirements on one host's probe results: each probed agent ran, on the wire and in the native
 * record, on the model its source predicts, with the predicted variant; and a variant with no Hive model was refused
 * with the actionable error before any Hive role or tool was registered, although a native model named that role.
 */
export function modelSelectionFailures(host, observed, invalid, model) {
  const failures = [];
  for (const [agent, expected] of Object.entries(selectionExpectations(host, model))) {
    const seen = observed?.[agent];
    if (!seen?.observed) { failures.push(`model_selection_unobserved:${host}:${agent}`); continue; }
    if (seen.wireModel !== expected.model || seen.recordedModel !== expected.model) failures.push(`model_selection_mismatch:${host}:${agent}`);
    if ((seen.recordedVariant ?? null) !== expected.variant) failures.push(`model_variant_mismatch:${host}:${agent}`);
  }
  if (!invalid) failures.push(`invalid_model_config_unobserved:${host}`);
  else {
    if (!invalid.errorLogged || !invalid.errorNamesFile) failures.push(`invalid_model_config_error_missing:${host}`);
    if ((invalid.hiveRolesRegistered ?? []).length > 0 || invalid.hiveToolsExposed) failures.push(`invalid_model_config_registered:${host}`);
  }
  return failures;
}

/** A list of records as a prefix of a longer or equal list, entry for entry. */
function isPrefix(prior, current) {
  return Array.isArray(prior) && Array.isArray(current) && prior.length <= current.length && prior.every((x, i) => JSON.stringify(x) === JSON.stringify(current[i]));
}

/** A nonempty list with a host message ID on every entry, all distinct. */
function identified(list, pick) {
  const ids = Array.isArray(list) ? list.map(pick) : [];
  return ids.length > 0 && ids.length === list.length && ids.every((id) => typeof id === 'string' && id !== '') && new Set(ids).size === ids.length;
}

/**
 * What a continuation turn added to one child, separated from what was there before: assistant messages beyond the
 * earlier ones (identified by host message ID, the earlier ones unchanged) and model requests beyond the earlier ones
 * (the observer's records in order, the earlier ones unchanged). Null when the two reads cannot be told apart.
 */
export function continuationAdded(before, after) {
  const prior = before?.assistants;
  const current = after?.assistants;
  const priorRequests = before?.observed?.requests;
  const currentRequests = after?.observed?.requests;
  if (!identified(prior, (a) => a?.id) || !identified(current, (a) => a?.id) || !isPrefix(prior, current) || !isPrefix(priorRequests, currentRequests)) return null;
  return { assistants: current.slice(prior.length), requests: currentRequests.slice(priorRequests.length) };
}

/** Whether two reads of one child's whole history are the same messages with the same content; null when either lacks the record. */
function sameHistory(before, after) {
  const complete = (m) => m && identified(m.ids, (id) => id) && typeof m.digest === 'string' && m.digest !== '';
  if (!complete(before) || !complete(after)) return null;
  return JSON.stringify(before.ids) === JSON.stringify(after.ids) && before.digest === after.digest;
}

/**
 * Managed-model-control requirements on the v2 host (src/v2/dispatch.ts) from what the real host and the installed
 * package did. Every `model` override was recorded in the tool input as sent and refused with Hive's own sentence, and
 * the refusals created no child, provider request or binding; the same override on an unmanaged agent was honored by
 * the host; fresh children and unchanged continuations ran on the host-catalog model; a child an operator moved to
 * another model or variant was refused on continuation and left exactly as it was. Missing or partial records are
 * failures, never passes.
 */
export function managedModelControlFailures(host, control, model) {
  if (host !== MANAGED_CONTROL_HOST) return [];
  if (!control || !Array.isArray(control.errors)) return [`managed_model_control_unobserved:${host}`];
  const plan = managedControlPlan(model);
  const failures = [];
  const fail = (code, id) => failures.push(`managed_model_${code}:${host}${id === undefined ? '' : `:${id}`}`);
  for (const name of control.errors) fail('stage_failed', name);
  for (const name of ['refuse', 'create', 'continue']) {
    const turn = control.turns?.[name];
    if (!turn) fail('turn_unobserved', name);
    else if (turn.exit !== 0 || turn.timedOut || turn.asked) fail('turn_unfinished', name);
  }
  for (const [agent, expected] of Object.entries(plan.catalog)) {
    const entry = control.catalog?.[agent];
    if (!entry?.listed) fail('catalog_unobserved', agent);
    else if (expected === null ? entry.model !== null : !sameModelView(entry.model, expected)) fail('catalog_mismatch', agent);
  }
  // One model, with nothing contradicting it: a nonempty list in which every entry is the expected model and variant.
  const allOn = (list, expected, pick = (x) => x) => Array.isArray(list) && list.length > 0 && list.every((x) => sameModelView(pick(x), expected));
  const ranOn = (state, wire, expected) => sameModelView(state?.model, expected) && sameModelView(state?.recorded, expected)
    && allOn(state?.assistants, expected, (a) => a?.model) && allOn(state?.observed?.views, expected)
    && wire?.requests >= 1 && JSON.stringify(wire.models) === JSON.stringify([expected.model]);
  const related = (state) => state?.readable === true && state.parentOk === true && state.agentOk === true;

  for (const planned of plan.refusals) {
    const row = control.refusals?.find((r) => r.id === planned.id);
    if (!row || row.call === 'absent') { fail('refusal_unobserved', planned.id); continue; }
    if (row.call === 'completed') fail('override_accepted', planned.id);
    else if (row.call !== 'error') fail('override_unfinished', planned.id);
    if (row.calls !== 1 || !row.recordedAgent || !row.recordedModel) fail('override_not_recorded', planned.id);
    if (row.call === 'error' && row.refusal !== 'hive_managed_model') fail('refusal_unrecognized', planned.id);
  }
  const after = control.afterRefusals;
  if (!after) fail('refusal_effects_unobserved');
  else {
    if (!after.historyOk) fail('history_incomplete', 'refuse');
    if (after.childSessions !== 0) fail('refusal_created_child');
    if (after.wireRequests !== 0) fail('refusal_reached_provider');
    if (after.boundChildren !== 0) fail('refusal_bound_child');
  }

  const baseline = control.baseline;
  if (!baseline || baseline.call === 'absent') fail('unmanaged_baseline_unobserved');
  else if (baseline.call !== 'completed' || baseline.calls !== 1 || !baseline.recordedAgent || !baseline.recordedModel || !baseline.child) fail('unmanaged_baseline_failed');
  else if (!related(baseline.state)) fail('unmanaged_baseline_unverified');
  else if (!ranOn(baseline.state, baseline.wire, plan.baseline.expected)) fail('unmanaged_baseline_model_mismatch');
  const unmanaged = control.control;
  if (!unmanaged || unmanaged.call === 'absent') fail('unmanaged_override_unobserved');
  else {
    if (unmanaged.call !== 'completed' || unmanaged.calls !== 1 || !unmanaged.recordedAgent || !unmanaged.recordedModel) fail('unmanaged_override_not_accepted');
    else if (!related(unmanaged.state)) fail('unmanaged_child_unverified');
    else if (!ranOn(unmanaged.state, unmanaged.wire, plan.control.sent)) fail('unmanaged_override_not_honored');
  }

  const created = new Set();
  for (const planned of plan.children) {
    const row = control.created?.[planned.id];
    if (!row || row.call === 'absent') { fail('fresh_unobserved', planned.id); continue; }
    if (row.call !== 'completed' || row.calls !== 1 || !row.recordedAgent || !row.recordedModel || !row.child) { fail('fresh_failed', planned.id); continue; }
    created.add(row.child);
    if (!related(row.state)) fail('fresh_child_unverified', planned.id);
    else if (!ranOn(row.state, row.wire, planned.expected)) fail('fresh_model_mismatch', planned.id);
    if (!row.state?.binding?.bound || !row.state.binding.parentOk) fail('fresh_unbound', planned.id);
  }
  for (const row of [baseline, unmanaged]) if (row?.call === 'completed' && row.child) created.add(row.child);
  const afterCreate = control.childrenAfterCreate;
  if (!Array.isArray(afterCreate) || afterCreate.length !== created.size || afterCreate.some((id) => !created.has(id))) fail('children_unaccounted', 'create');
  if (control.historyOkAfterCreate !== true) fail('history_incomplete', 'create');

  for (const [key, target] of Object.entries(plan.operator)) {
    const row = control.operator?.[key];
    if (!row) fail('operator_unobserved', key);
    else if (!row.idle) fail('operator_child_not_idle', key);
    else if (!row.switched) fail('operator_switch_failed', key);
    else if (!sameModelView(row.after, target)) fail('operator_switch_not_applied', key);
  }

  for (const planned of plan.continuations) {
    const row = control.continued?.find((r) => r.id === planned.child);
    const child = plan.children.find((c) => c.id === planned.child);
    if (!row || row.call === 'absent') { fail('continuation_unobserved', planned.child); continue; }
    if (!row.before || !row.after) { fail('continuation_state_unobserved', planned.child); continue; }
    if (row.calls !== 1 || !row.recordedAgent || !row.recordedSession || !row.target) fail('continuation_not_recorded', planned.child);
    // The child is read from the host with its complete history, related to the parent and on its agent, both before and after.
    if (!related(row.before)) fail('continuation_before_unverified', planned.child);
    if (!related(row.after)) fail('continuation_child_unverified', planned.child);
    if (planned.expect === 'refused') {
      if (row.call === 'completed') fail('continuation_not_refused', planned.child);
      else if (row.call !== 'error') fail('continuation_unfinished', planned.child);
      else if (row.refusal !== 'hive_continuation_model') fail('continuation_refusal_unrecognized', planned.child);
      if (!sameModelView(row.before.model, plan.operator[planned.child])) fail('continuation_premise_missing', planned.child);
      if (!sameModelView(row.after.model, row.before.model) || !sameModelView(row.after.recorded, row.before.recorded)) fail('refused_continuation_changed_model', planned.child);
      if (row.after.assistantMessages !== row.before.assistantMessages || row.after.observed?.count !== row.before.observed?.count || row.wire?.requests !== 0) fail('refused_continuation_prompted', planned.child);
      // A prompt admitted without a model request still adds a user message or changes one: the whole history must be the same.
      const unchanged = sameHistory(row.before.messages, row.after.messages);
      if (unchanged === null) fail('refused_continuation_history_unobserved', planned.child);
      else if (!unchanged) fail('refused_continuation_prompted', planned.child);
      if (!row.before.binding?.bound || row.after.binding?.digest !== row.before.binding.digest) fail('refused_continuation_rebound', planned.child);
    } else {
      if (row.call !== 'completed' || row.child !== row.target) fail('continuation_not_accepted', planned.child);
      else {
        if (!sameModelView(row.before.model, child.expected) || !sameModelView(row.after.model, child.expected)) fail('continuation_model_changed', planned.child);
        // Only what this turn added counts: new assistant messages (by host ID) and new model requests, each on the configured model.
        const added = continuationAdded(row.before, row.after);
        if (!(row.after.assistantMessages > row.before.assistantMessages) || !(row.after.observed?.count > row.before.observed?.count)
          || !added || !allOn(added.assistants, child.expected, (a) => a?.model) || !allOn(added.requests, child.expected)
          || row.wire?.requests < 1 || JSON.stringify(row.wire.models) !== JSON.stringify([child.expected.model])) fail('continuation_not_run_on_configured_model', planned.child);
        if (!row.after.binding?.bound || !row.after.binding.parentOk) fail('continuation_unbound', planned.child);
      }
    }
  }
  const afterContinue = control.childrenAfterContinue;
  if (!Array.isArray(afterCreate) || !Array.isArray(afterContinue) || JSON.stringify(afterContinue) !== JSON.stringify(afterCreate)) fail('children_unaccounted', 'continue');
  if (control.historyOkAfterContinue !== true) fail('history_incomplete', 'continue');
  return failures;
}

const CONTEXT_EDIT_REQUIRED = ['expectedContentHash', 'expectedRevision', 'name', 'newText', 'oldText'];
const CONTEXT_EDIT_DENIED_ROLES = ['scout-researcher', 'hive-helper'];

/**
 * A denied child's attempt shows a refusal only when it is not some other failure. Either the tool was never shown and
 * no call ran, or the call carried the intended text and the concrete guards of the child's own successful read and
 * the host's error was classified locally as an authority refusal (a hidden tool's unknown-tool error counts only when
 * the request did not list it). Schema, stale-state, abort and runtime errors are `other` and never count.
 */
function editDenialRefused(row) {
  if (row.call === 'absent') return row.exposed === false;
  return row.call === 'error' && row.argsValid === true
    && (row.refusal === 'authority' || (row.refusal === 'unavailable' && row.exposed === false));
}

/**
 * Installed bounded-edit proof on one host: a direct schema requiring the five principal fields, an allowed child
 * writer's actual edit, read-only children that left their target unchanged after a successful own read and a
 * completed edit step, and edit exposure matching write and append for every observed role. On v2 a shown schema is
 * not authority, so the executor must refuse it with an authority refusal.
 */
export function contextEditFailures(host, w) {
  const edit = w.contextEdit;
  if (!edit) return [`context_edit_unobserved:${host}`];
  const failures = [];
  if (!edit.schema?.direct || edit.schema.codeMode) failures.push(`context_edit_not_direct:${host}`);
  if (JSON.stringify(edit.schema?.required ?? []) !== JSON.stringify(CONTEXT_EDIT_REQUIRED)) failures.push(`context_edit_required_fields:${host}`);
  if (!edit.setup) return [...failures, `context_edit_setup_failed:${host}`];
  const allowed = edit.allowed;
  if (!allowed?.observed || allowed.call !== 'completed' || !allowed.matchesExpected) failures.push(`context_edit_not_applied:${host}`);
  for (const role of CONTEXT_EDIT_DENIED_ROLES) {
    const row = (edit.denied ?? []).find((d) => d.agent === role);
    if (!row?.observed) failures.push(`context_edit_denial_unobserved:${host}:${role}`);
    else if (!row.targetUnchanged || row.call === 'completed') failures.push(`context_edit_denial_breached:${host}:${role}`);
    else if (row.readOk !== true || row.reached !== true) failures.push(`context_edit_denial_unproven:${host}:${role}`);
    else if (!editDenialRefused(row)) failures.push(`context_edit_denial_unrefused:${host}:${role}`);
  }
  for (const [role, exposure] of Object.entries(w.roleExposure ?? {})) {
    if (!exposure.observed) continue;
    const writes = exposure.contextWrites;
    if (!writes) failures.push(`context_write_exposure_unrecorded:${host}:${role}`);
    else if (writes.hive_context_edit !== writes.hive_context_write || writes.hive_context_edit !== writes.hive_context_append) {
      failures.push(`context_edit_exposure_parity:${host}:${role}`);
    }
  }
  return failures;
}

/** Wiring requirements on each host's observation, plus cross-host parity of the direct tool parameters. */
export function wiringFailures(results, model) {
  const failures = [];
  for (const [host, w] of Object.entries(results)) {
    for (const [role, present] of Object.entries(w.roles)) if (!present) failures.push(`role_missing:${host}:${role}`);
    for (const [command, present] of Object.entries(w.commands)) if (!present) failures.push(`command_missing:${host}:${command}`);
    for (const [role, exposure] of Object.entries(w.roleExposure)) if (!exposure.observed) failures.push(`role_not_observed:${host}:${role}`);
    const tools = w.toolContract;
    if (!tools || tools.expected === 0) failures.push(`tool_manifest_unread:${host}`);
    else {
      for (const t of tools.missing) failures.push(`tool_missing:${host}:${t}`);
      for (const t of tools.unexpected) failures.push(`tool_unexpected:${host}:${t}`);
      for (const t of tools.undescribed) failures.push(`tool_undescribed:${host}:${t}`);
    }
    // Relied-upon fields (pins, targets, approval and sync, publication, context) as the provider-facing surface showed
    // them. Undescribed fields outside the contract stay informational in `toolContract.undescribedParams`.
    const fields = w.fieldContract;
    if (!fields || fields.checked === 0) failures.push(`field_contract_unread:${host}`);
    else {
      for (const t of fields.absentTools) failures.push(`field_contract_tool_absent:${host}:${t}`);
      for (const f of fields.absentFields) failures.push(`field_contract_field_absent:${host}:${f}`);
      for (const f of fields.undescribed) failures.push(`field_contract_undescribed:${host}:${f}`);
    }
    for (const [skill, info] of Object.entries(w.references?.pointers ?? {})) for (const file of info.broken) failures.push(`reference_pointer_broken:${host}:${skill}/${file}`);
    for (const row of w.references?.reads ?? []) if (!row.readCompleted) failures.push(`reference_read_failed:${host}:${row.skill}/${row.file}`);
    if ((w.references?.reads ?? []).length === 0) failures.push(`reference_reads_missing:${host}`);
    const command = w.nonHiveCommand ?? {};
    // Delivery and reference reads can be positive for a run that then stalled, errored or waited on an operator.
    if (command.result !== 0 || command.timedOut || command.asked) failures.push(`command_run_unsuccessful:${host}:${command.command ?? 'unknown'}`);
    if (!command.bodyDelivered) failures.push(`command_body_not_delivered:${host}:${command.command ?? 'unknown'}`);
    if (!command.skillLoaded) failures.push(`command_consumer_skill_not_loaded:${host}`);
    for (const row of command.referenceReads ?? []) if (!row.readCompleted) failures.push(`command_consumer_reference_failed:${host}:${row.file}`);
    if (!w.override?.listed) failures.push(`override_not_listed:${host}`);
    if (!w.override?.resolvesToUserSkill) failures.push(`override_not_user_skill:${host}`);
    if (!w.override?.loadedUserBody) failures.push(`override_body_not_loaded:${host}`);
    failures.push(...modelSelectionFailures(host, w.modelSelection, w.invalidModelSelection, model));
    failures.push(...managedModelControlFailures(host, w.managedModelControl, model));
    failures.push(...contextEditFailures(host, w));
  }
  const [a, b] = Object.values(results);
  if (a?.toolContract && b?.toolContract) {
    for (const [tool, params] of Object.entries(a.toolContract.paramNames)) {
      const other = b.toolContract.paramNames[tool];
      if (other && JSON.stringify(other) !== JSON.stringify(params)) failures.push(`tool_params_differ:${tool}`);
    }
  }
  return failures;
}

/** Legitimate wire names of the frozen model, from the scenario set. Empty unless an observed alias was recorded there. */
function wireAliases(ctx) {
  return ctx.scenarios.model.wireAliases?.[ctx.model.id] ?? [];
}

function caseKey(host, item) {
  return `${host}:${item}`;
}

function recordName(prefix, host, item, suffix) {
  return `${prefix}.${host}.${item}.${suffix}`;
}

/** Host-auth observation at a paid boundary: unchanged booleans only; fingerprints stay in this process. */
function hostAuthCheck(ctx) {
  if (!ctx.auth) return null;
  const unchanged = sameFingerprint(ctx.auth.atAcquisition, fingerprintAuthFile(ctx.auth.path));
  if (!unchanged) ctx.auth.changed = true;
  return unchanged;
}

/**
 * One paid case. The container's guard is armed with the case deadline and acknowledges it before the credential is
 * injected; the host timer can stop the container earlier. A started record is published before the prompt, so an
 * interrupted runner leaves the case `unknown` rather than silently repurchasable. The outcome record is published
 * before any security stop propagates.
 */
export async function paidCase(ctx, host, group, { offline = false } = {}) {
  const network = offline ? 'none' : await ctx.resources.create('network', (labels) => ['network', 'create', '--driver', 'bridge', ...labels, `ic-${ctx.runId}-${randomBytes(4).toString('hex')}`]);
  const timeoutSeconds = Math.ceil(ctx.timeoutMs / 1000);
  let id;
  let deadline;
  let killed = false;
  let started = null;
  let startedPublished = false;
  const publish = (suffix, value) => ctx.journal?.write(recordName('case', host, group.id, suffix), { host, group: group.id, ...value });
  try {
    id = await openContainer(ctx, { network, ceilingSeconds: CEILING.paidSetup + timeoutSeconds });
    await step(ctx, id, 'serve', { host, provider: 'mock', model: ctx.scenarios.model.mock, agentMode: group.agentMode, scenario: group.id });
    await step(ctx, id, 'setup', { host, scenario: group.id }, { timeoutMs: 900_000 });
    await step(ctx, id, 'stop', {});
    await step(ctx, id, 'serve', { host, provider: 'openai', model: ctx.model.id, variant: ctx.model.variant, agentMode: group.agentMode, scenario: group.id });
    const authBefore = hostAuthCheck(ctx);
    if (authBefore === false) throw new HarnessError('host_auth_changed', { host, group: group.id });
    const remainingMsAtInjection = assertLifetime(ctx.credential, { now: Date.now(), requiredMs: requiredLifetimeMs(host, ctx.timeoutMs, LIFETIME_MARGIN_MS) });
    const guard = await armGuard(ctx, id, timeoutSeconds);
    started = Date.now();
    deadline = setTimeout(() => { killed = true; ctx.docker.run(['kill', id], { timeoutMs: 30_000 }); }, ctx.timeoutMs);
    await inject(ctx, id, host);
    publish('started', { at: new Date(started).toISOString(), guardDeadlineAt: guard.deadlineAt, remainingMsAtInjection, hostAuthUnchangedBefore: authBefore });
    startedPublished = true;
    const remaining = () => Math.max(1_000, ctx.timeoutMs - (Date.now() - started));
    // The in-container driver stops its own session 30s early so evidence can still be exported; the guard and the
    // host timer bound the whole container.
    const run = await exec(ctx.docker, id, 'run', { host, scenario: group.id, mode: 'live', model: ctx.model.id, timeoutMs: remaining() - 30_000 }, { timeoutMs: remaining() });
    let exported = null;
    let credential = null;
    if (!killed && !run.timedOut) {
      exported = await exec(ctx.docker, id, 'export', { host, scenario: group.id }, { timeoutMs: remaining() });
      credential = await exec(ctx.docker, id, 'verify-credential', { host }, { timeoutMs: remaining() });
    }
    clearTimeout(deadline);
    const durationMs = Date.now() - started;
    const authAfter = hostAuthCheck(ctx);
    const timedOut = killed || run.timedOut;
    if (!timedOut) {
      // A container whose stored credential can no longer be confirmed, or whose export failed its own scan, is a
      // security stop, not an outcome.
      if (!credential.value?.sentinelRetained || !credential.value?.accessUnchanged) throw new HarnessError('container_credential_unconfirmed', { host, group: group.id });
      if (exported.value && exported.value.ok !== true) throw new HarnessError(exported.value.failure ?? 'export_failed', { host, group: group.id });
      if (exported.value && ctx.scan(exported.value.record)) throw new HarnessError('export_contaminated', { host, group: group.id });
    }
    const record = !timedOut && exported.value ? exported.value.record : null;
    const fixtureFailed = record ? failedChecks(group.fixtureChecks, record) : [];
    const classified = classifyCase({ timedOut, run: run.value, record, fixtureInvalid: fixtureFailed.length > 0, host, model: ctx.model, aliases: wireAliases(ctx) });
    const result = {
      host, group: group.id, ...classified, durationMs, run: run.value ? { exit: run.value.exit, asked: run.value.asked, timedOut: run.value.timedOut } : null,
      fixtureFailed, record, effectiveSettings: record ? effectiveSettings(record) : {}, hostAuthUnchangedAfter: authAfter,
    };
    if (ctx.outDir) {
      const file = join(ctx.outDir, 'cases', `${host}.${group.id}.json`);
      writeOnce(file, JSON.stringify(result, null, 2));
      result.file = file;
      result.sha256 = sha256File(file);
    }
    publish('outcome', caseSummary(result));
    return result;
  } catch (error) {
    // Only a case whose prompt may have been sent gets an outcome record; earlier failures leave it never started.
    if (startedPublished) publish('outcome', { outcome: 'stopped', code: error?.code ?? 'unexpected_exception' });
    throw error;
  } finally {
    clearTimeout(deadline);
    if (id) await ctx.resources.remove(id);
    if (!offline) await ctx.resources.remove(network);
  }
}

/** The part of a case result kept in records and manifests. `evidenceLimits` names what the exported record clipped or could not show. */
export function caseSummary(result) {
  return {
    host: result.host, group: result.group, outcome: result.outcome, code: result.code ?? null, file: result.file ?? null, sha256: result.sha256 ?? null,
    fixtureFailed: result.fixtureFailed ?? [], durationMs: result.durationMs ?? null, evidenceLimits: result.record?.limits ?? null,
    effectiveSettings: result.effectiveSettings ?? {}, hostAuthUnchangedAfter: result.hostAuthUnchangedAfter ?? null,
  };
}

/**
 * Credential-free dry run of the whole paid case path on one host: mock setup, restart on the OpenAI provider, guard
 * arm, injection of a made-up credential, the live driver, export, credential verification, deadline and cleanup.
 * The container has no network, so no provider request leaves it; the outcome only proves the plumbing.
 */
export async function rehearsePaidPath(ctx, host, group, timeoutMs = 120_000) {
  const synthetic = { access: `ic-synthetic-access-${randomBytes(16).toString('hex')}`, expires: Date.now() + 2 * 3_600_000, accountId: 'ic-synthetic-account' };
  const dry = { ...ctx, credential: synthetic, scan: secretScanner(synthetic), secretBearing: true, timeoutMs, model: { id: ctx.scenarios.model.preference[0], variant: null }, journal: null, outDir: null, auth: null };
  const result = await paidCase(dry, host, group, { offline: true });
  return { host, group: group.id, outcome: result.outcome, code: result.code ?? null, durationMs: result.durationMs, exported: Boolean(result.record), ok: Boolean(result.outcome) };
}

/**
 * The credential-free rehearsal, mandatory before any credential read. It shows that each selected fixture has a
 * compliant path and that the lifetime, injection, paid-path, export and cleanup plumbing works on this exact
 * artifact. The injection and paid-path rehearsals run for every selection, with the paid path on its own dedicated
 * fixture, so a narrow scope never skips the safety controls. It reads no model words and says nothing about
 * instruction quality.
 */
export async function rehearseSelection(ctx, { hosts, groups, paidPathGroup, lifetime }) {
  mkdirSync(join(ctx.outDir, 'rehearsal'));
  const result = { lifetime: await rehearseLifetime(ctx, lifetime), cases: [], injection: [], paidPath: [] };
  for (const host of hosts) {
    for (const group of groups) {
      const rehearsed = await rehearseCase(ctx, host, group);
      writeOnce(join(ctx.outDir, 'rehearsal', `${host}.${group.id}.json`), JSON.stringify(rehearsed, null, 2));
      result.cases.push({ host, group: group.id, failures: rehearsed.failures });
    }
  }
  for (const host of hosts) {
    result.injection.push(await rehearseInjection(ctx, host));
    result.paidPath.push(await rehearsePaidPath(ctx, host, paidPathGroup));
  }
  result.failures = [
    ...(result.lifetime.ok ? [] : ['lifetime']),
    ...result.cases.filter((r) => r.failures.length > 0).map((r) => `${r.host}:${r.group}:${r.failures.join('+')}`),
    ...result.injection.filter((r) => !r.ok).map((r) => `${r.host}:injection`),
    ...result.paidPath.filter((r) => !r.ok).map((r) => `${r.host}:paid-path`),
  ];
  return result;
}

async function inject(ctx, id, host) {
  const request = authRequest(host, ctx.credential);
  const result = await exec(ctx.docker, id, 'inject-auth', { host }, { stdin: JSON.stringify(request), timeoutMs: 60_000 });
  if (!result.value?.ok) throw new HarnessError('auth_injection_failed', { host, status: result.value?.status ?? null });
}

/** Opens a networked credential-bearing auxiliary container, armed before injection, and runs `body` in it. */
async function withAuxiliaryContainer(ctx, host, { model, variant }, body) {
  const network = await ctx.resources.create('network', (labels) => ['network', 'create', '--driver', 'bridge', ...labels, `ic-${ctx.runId}-${randomBytes(4).toString('hex')}`]);
  let id;
  try {
    id = await openContainer(ctx, { network, ceilingSeconds: CEILING.auxiliary });
    await step(ctx, id, 'serve', { host, provider: 'openai', model, variant, agentMode: 'dedicated' });
    if (hostAuthCheck(ctx) === false) throw new HarnessError('host_auth_changed', { host });
    assertLifetime(ctx.credential, { now: Date.now(), requiredMs: requiredLifetimeMs(host, AUXILIARY_DEADLINE_SECONDS * 1000, LIFETIME_MARGIN_MS) });
    await armGuard(ctx, id, AUXILIARY_DEADLINE_SECONDS);
    await inject(ctx, id, host);
    return await body(id);
  } finally {
    if (id) await ctx.resources.remove(id);
    await ctx.resources.remove(network);
  }
}

async function hostCatalog(ctx, host) {
  return withAuxiliaryContainer(ctx, host, { model: ctx.scenarios.model.preference[0], variant: null }, async (id) => (await step(ctx, id, 'catalog', { host })).models);
}

export async function hostPreflight(ctx, host) {
  return withAuxiliaryContainer(ctx, host, ctx.model, async (id) => {
    ctx.journal.write(`preflight.${host}.started`, { host, at: new Date().toISOString(), model: ctx.model });
    let outcome;
    try {
      const result = await step(ctx, id, 'preflight', { host, model: ctx.model.id }, { timeoutMs: 180_000 });
      const credential = await step(ctx, id, 'verify-credential', { host });
      if (!credential.sentinelRetained || !credential.accessUnchanged) throw new HarnessError('container_credential_changed', { host });
      if (ctx.scan(result)) throw new HarnessError('export_contaminated', { host, phase: 'preflight' });
      // The preflight must already show the frozen model on the wire, through the same observer the cases use.
      const evidenceRecord = {
        sessions: [{ id: result.sessionId, agent: 'build', assistantMessages: result.assistantMessages, models: result.models }],
        requests: result.requests, limits: { requestsTruncated: result.requestsTruncated === true },
      };
      const evidence = [...recordReadFailures(evidenceRecord), ...modelEvidenceFailures(evidenceRecord, host, ctx.model, wireAliases(ctx))];
      outcome = {
        host, ok: result.ok === true && evidence.length === 0, exit: result.exit, assistantMessages: result.assistantMessages, errors: result.errors,
        errorNames: result.errorNames, evidence, historyIncomplete: result.historyIncomplete === true, tokens: result.tokens, effectiveSettings: effectiveSettings(evidenceRecord),
      };
    } catch (error) {
      ctx.journal.write(`preflight.${host}.outcome`, { host, ok: false, code: error?.code ?? 'unexpected_exception' });
      throw error;
    }
    ctx.journal.write(`preflight.${host}.outcome`, outcome);
    return outcome;
  });
}

// -----------------------------------------------------------------------------------------------------------------
// Resume. A resume reads the previous run's immutable records, never its summary alone, and is validated completely
// before any credential is read or any preflight runs.

function loadManifest(path, phase) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.schema !== MANIFEST_SCHEMA || manifest.phase !== phase) throw new HarnessError('manifest_kind_mismatch', phase);
  return manifest;
}

/** Case records of one run, following reuse links back to the run that observed each case. */
export function loadRunRecords(runDir) {
  const journal = new Journal(join(runDir, 'records'));
  const prepared = journal.read('prepared');
  if (!prepared) throw new HarnessError('resume_source_unprepared');
  const records = {};
  for (const name of journal.names()) records[name] = journal.read(name);
  // A resumed run publishes `inherited` before `prepared`, so a resumed source without it lost its carried history
  // and could not be resumed again without repurchasing.
  if (prepared.value.resumedFrom && !records.inherited) throw new HarnessError('resume_source_inheritance_missing');
  return { runDir, prepared: prepared.value, records };
}

/** The identity a resume must match exactly. The selected scenarios are part of it: a resume never widens or narrows the scope. */
export function resumeIdentity(prepared) {
  return {
    phase: prepared.phase, harness: prepared.harness, subject: prepared.subject?.commit, artifact: prepared.artifact?.sha256,
    runtimeImageId: prepared.runtime?.imageId, runtimeIdentity: prepared.runtimeIdentity, isolation: prepared.isolation,
    timeoutSeconds: prepared.timeoutSeconds, hosts: [...(prepared.hosts ?? [])].sort(), scenarios: [...(prepared.scenarios ?? [])].sort(),
    candidateWiringSha256: prepared.candidateWiring?.sha256, engineId: prepared.docker?.engineId,
  };
}

/**
 * Decides, for every paid item, whether a resumed run reuses an earlier collected record, carries an earlier
 * unresolved one forward unchanged, or runs it. A run's own records for an item come first, then the history it
 * inherited from the run it resumed (its `inherited` record), so a chain of resumes keeps every earlier purchase.
 * Started items with no trustworthy outcome stay `unknown`; only an explicit `--repurchase host:item` runs them again.
 */
export function resumePlan(source, { expected, groups, hosts, repurchase }) {
  const mismatches = [];
  const have = resumeIdentity(source.prepared);
  for (const key of Object.keys(expected)) if (JSON.stringify(have[key]) !== JSON.stringify(expected[key])) mismatches.push(key);
  if (mismatches.length) throw new HarnessError('resume_inputs_differ', mismatches);
  const items = [...hosts.map((h) => ({ host: h, item: 'preflight' })), ...hosts.flatMap((h) => groups.map((g) => ({ host: h, item: g.id })))];
  const known = new Set(items.map((i) => caseKey(i.host, i.item)));
  for (const key of repurchase) if (!known.has(key)) throw new HarnessError('repurchase_unknown_item', key);
  const inheritedItems = source.records.inherited?.value?.items ?? {};
  const plan = {};
  for (const { host, item } of items) {
    const key = caseKey(host, item);
    const prefix = item === 'preflight' ? `preflight.${host}` : `case.${host}.${item}`;
    const outcome = source.records[`${prefix}.outcome`]?.value ?? null;
    const startedRecord = source.records[`${prefix}.started`]?.value ?? null;
    const inherited = inheritedItems[key] ?? null;
    const own = (name) => ({ runDir: source.runDir, record: name, sha256: source.records[name].sha256 });
    let entry;
    if (outcome && (item === 'preflight' ? outcome.ok === true : outcome.outcome === 'collected')) entry = { action: 'reuse', summary: outcome, origin: own(`${prefix}.outcome`) };
    else if (outcome) entry = { action: 'carry', summary: outcome, origin: own(`${prefix}.outcome`) };
    else if (startedRecord) entry = { action: 'carry', summary: { host, ...(item === 'preflight' ? { ok: false } : { group: item }), outcome: 'unknown' }, origin: own(`${prefix}.started`) };
    else if (inherited) {
      const origin = inherited.origin;
      if (!['reuse', 'carry'].includes(inherited.action) || !inherited.summary || typeof origin?.runDir !== 'string' || typeof origin.record !== 'string' || typeof origin.sha256 !== 'string') {
        throw new HarnessError('resume_inherited_invalid', key);
      }
      entry = { action: inherited.action, summary: inherited.summary, origin };
    } else entry = { action: 'run' };
    if (repurchase.includes(key)) {
      if (entry.action !== 'carry') throw new HarnessError('repurchase_not_unresolved', key);
      entry = { action: 'run', repurchased: entry };
    }
    plan[key] = entry;
  }
  return { plan, model: source.records.model?.value ?? source.records.inherited?.value?.model ?? null };
}

/**
 * The history a resumed run inherits, published as one record before anything else can fail: every earlier valid
 * observation (reuse) and unresolved item (carry), with its origin, and the frozen model. An item an explicit
 * `--repurchase` released keeps its earlier unresolved entry, so a resume that fails before buying it still shows that
 * the earlier attempt was never settled and the next resume needs its own repurchase decision.
 */
export function buildInherited({ plan, model }, decision) {
  const items = {};
  for (const [key, entry] of Object.entries(plan)) {
    const kept = entry.repurchased ?? entry;
    if (kept.action !== 'run') items[key] = { action: kept.action, summary: kept.summary, origin: kept.origin };
  }
  return { decision, model, items };
}

/**
 * Everything a resume must establish before it reads a credential or runs a paid item: the plan and its origins, the
 * earlier run's outstanding resources settled on the bound engine, and the inherited history published. `inherited` is
 * published before `prepared`, which marks the run as a valid resume source.
 */
export async function prepareResume({ source, expected, groups, hosts, repurchase, decision, resources, journal, prepared }) {
  const plan = resumePlan(source, { expected, groups, hosts, repurchase });
  verifyResumeOrigins(plan.plan);
  const priorResources = await resources.settlePriorRun(source.runDir);
  journal.write('inherited', buildInherited(plan, decision));
  journal.write('prepared', prepared);
  return { plan, priorResources };
}

/** Re-reads every reused or carried origin record and case file and checks their hashes before anything is inherited. */
export function verifyResumeOrigins(plan) {
  for (const [key, planned] of Object.entries(plan)) {
    const entry = planned.repurchased ?? planned;
    if (entry.action === 'run') continue;
    const originFile = join(entry.origin.runDir, 'records', `${entry.origin.record}.json`);
    let text;
    try { text = readFileSync(originFile, 'utf8'); } catch { throw new HarnessError('resume_origin_missing', key); }
    if (sha256Text(text) !== entry.origin.sha256) throw new HarnessError('resume_origin_changed', key);
    if (entry.summary.file) {
      let actual;
      try { actual = sha256File(entry.summary.file); } catch { throw new HarnessError('resume_case_file_missing', key); }
      if (actual !== entry.summary.sha256) throw new HarnessError('resume_case_file_changed', key);
    }
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Phases

/** The final status and exit code after cleanup and the host-auth check; cleanup or auth problems always fail. */
export function finalExit({ status, cleanupSettled, hostAuthChanged }) {
  const finalStatus = !cleanupSettled || hostAuthChanged ? 'failed' : status;
  return { status: finalStatus, exitCode: STATUS_EXIT[finalStatus] ?? 1 };
}

async function runPhase(run) {
  const { options, docker, resources, manifest, outDir, journal } = run;
  const boundary = await verifyDockerBoundary(docker, run.env);
  manifest.docker = boundary.observed;
  if (!boundary.ok) throw new HarnessError('docker_boundary_refused', boundary.failures);
  resources.engineId = boundary.engineId;
  let subjectRef = options.candidateRef;
  let candidateManifest = null;
  if (options.phase === 'acceptance') {
    candidateManifest = loadManifest(options.candidateManifest, 'wiring');
    if (candidateManifest.status !== 'passed') throw new HarnessError('candidate_wiring_not_passed');
    subjectRef = candidateManifest.subject.commit;
  }
  const identities = resolveIdentities({ repoRoot: run.repoRoot, subjectRef });
  const { scenarios, sha256: scenariosSha256 } = harnessScenarioSet(run.repoRoot, identities.harnessCommit);
  manifest.harness = { commit: identities.harnessCommit, tree: identities.harnessTree, scenarioSetVersion: scenarios.setVersion, scenariosSha256 };
  manifest.subject = { role: 'candidate', ref: subjectRef, commit: identities.subjectCommit };
  manifest.isolation = ISOLATION;
  if (candidateManifest && candidateManifest.harness.tree !== identities.harnessTree) throw new HarnessError('harness_differs_from_wiring');
  const allGroups = scenarios.groups;
  if (allGroups.length !== 8) throw new HarnessError('scenario_set_incomplete');
  // The named scope, checked against the committed scenario set before any build, rehearsal or credential.
  const groups = options.phase === 'acceptance' ? selectScenarios(allGroups, options.scenarios) : allGroups;
  if (candidateManifest) manifest.candidateWiring = { manifest: options.candidateManifest, sha256: sha256File(options.candidateManifest) };

  // A resume reuses the source run's artifact, runtime image and rehearsal, after checking each is still the same.
  let source = null;
  if (options.resumeFrom) {
    source = loadRunRecords(options.resumeFrom.endsWith('.json') ? dirname(options.resumeFrom) : options.resumeFrom);
    manifest.resumedFrom = { runDir: source.runDir, preparedSha256: new Journal(join(source.runDir, 'records')).read('prepared').sha256, decision: options.resumeDecision, repurchase: options.repurchase };
  }
  if (source) {
    verifyArtifact({ file: source.prepared.artifact.file, sha256: source.prepared.artifact.sha256 });
    const image = await docker.json(['image', 'inspect', '--format', '{{json .Id}}', source.prepared.runtime.imageId]);
    if (image !== source.prepared.runtime.imageId) throw new HarnessError('resume_runtime_image_missing');
    manifest.artifact = { ...source.prepared.artifact, reused: true };
    manifest.runtime = source.prepared.runtime;
    manifest.runtimeIdentity = source.prepared.runtimeIdentity;
    manifest.rehearsal = { reusedFrom: source.runDir };
  } else {
    const artifactFrom = candidateManifest ? { file: candidateManifest.artifact.file, sha256: candidateManifest.artifact.sha256 } : null;
    const built = await build(docker, resources, { repoRoot: run.repoRoot, outDir, identities, artifactFrom });
    manifest.artifact = { file: built.artifact.file, sha256: built.artifact.sha256, reused: built.artifact.reused, report: built.artifact.report };
    manifest.runtime = built.runtime;
    manifest.runtimeIdentity = runtimeIdentity(built.runtime);
    resources.record({ event: 'image_retained', kind: 'image', id: built.runtime.imageId });
  }
  const runtimeProblems = runtimeFailures(manifest.runtime);
  if (runtimeProblems.length) throw new HarnessError('runtime_checks_failed', runtimeProblems);
  if (manifest.runtime.pluginTarballSha256 !== manifest.artifact.sha256) throw new HarnessError('installed_artifact_mismatch');
  if (candidateManifest) {
    // Fresh and resumed alike, before rehearsal, preflight or any credential.
    const bound = candidateBindingMismatches(candidateManifest, { hosts: options.hosts, runtimeIdentity: manifest.runtimeIdentity, artifactSha256: manifest.artifact.sha256 });
    if (bound.length) throw new HarnessError('candidate_binding_mismatch', bound);
  }
  const ctx = {
    docker, resources, journal, outDir, runtime: manifest.runtime, scenarios, runId: options.runId,
    timeoutMs: options.timeoutSeconds * 1000, secretBearing: false, scan: () => false, auth: null,
  };

  if (options.phase === 'wiring') {
    const results = {};
    // A failing host publishes its partial record from inside wiringHost, before its container is removed.
    const retain = wiringRetention({ options, manifest, outDir, results });
    for (const host of options.hosts) results[host] = await wiringHost(ctx, host, results, retain);
    writeOnce(join(outDir, 'wiring.json'), JSON.stringify(results, null, 2));
    manifest.wiring = { file: 'wiring.json', sha256: sha256File(join(outDir, 'wiring.json')) };
    manifest.failures = wiringFailures(results, scenarios.model.mock).map((code) => ({ code }));
    return manifest.failures.length ? 'failed' : 'passed';
  }

  if (!source) {
    const rehearsal = await rehearseSelection(ctx, {
      hosts: options.hosts, groups, paidPathGroup: allGroups.find((g) => g.id === 'substantive-handoff'),
    });
    manifest.lifetimeRehearsal = rehearsal.lifetime;
    manifest.rehearsal = rehearsal.cases;
    manifest.injectionRehearsal = rehearsal.injection;
    manifest.paidPathRehearsal = rehearsal.paidPath;
    if (rehearsal.failures.length) throw new HarnessError('rehearsal_failed', rehearsal.failures);
  }
  const prepared = {
    phase: options.phase, runId: options.runId, harness: manifest.harness, subject: manifest.subject, artifact: manifest.artifact,
    runtime: manifest.runtime, runtimeIdentity: manifest.runtimeIdentity, isolation: ISOLATION, timeoutSeconds: options.timeoutSeconds,
    hosts: options.hosts, scenarios: options.scenarios, candidateWiring: manifest.candidateWiring, docker: { engineId: boundary.engineId },
    resumedFrom: manifest.resumedFrom ?? null,
  };
  if (!options.paid) {
    journal.write('prepared', prepared);
    return 'rehearsal-passed';
  }

  // Resume: validate the plan and origins, settle the earlier run's outstanding resources on this engine, and publish
  // the inherited history, all before any credential is read or any paid item can run or fail.
  let plan = null;
  if (source) {
    const resumed = await prepareResume({
      source, expected: resumeIdentity(prepared), groups, hosts: options.hosts, repurchase: options.repurchase,
      decision: options.resumeDecision, resources, journal, prepared,
    });
    plan = resumed.plan;
    manifest.priorResources = resumed.priorResources;
  } else {
    journal.write('prepared', prepared);
  }
  // An unresolved preflight needs an explicit repurchase decision; nothing paid can follow it.
  const unresolvedPreflight = options.hosts.filter((h) => plan?.plan[caseKey(h, 'preflight')]?.action === 'carry');
  if (unresolvedPreflight.length) {
    manifest.failures.push({ code: 'preflight_unresolved', detail: unresolvedPreflight });
    return 'incomplete';
  }

  // ---- Paid stage. Credentials are read only from here on.
  const authPath = hostAuthPath(run.env);
  run.auth = { path: authPath, atStart: fingerprintAuthFile(authPath) };
  const required = Math.max(...options.hosts.map((h) => requiredLifetimeMs(h, ctx.timeoutMs, LIFETIME_MARGIN_MS)));
  const { credential, remainingMs } = readAccessOnly(authPath, { now: Date.now(), requiredMs: required });
  run.auth.atAcquisition = fingerprintAuthFile(authPath);
  run.auth.unchangedByRead = sameFingerprint(run.auth.atStart, run.auth.atAcquisition);
  ctx.auth = run.auth;
  manifest.credential = { remainingMsAtAcquisition: remainingMs };
  if (!run.auth.unchangedByRead) throw new HarnessError('host_auth_changed', 'acquisition');
  ctx.credential = credential;
  ctx.secretBearing = true;
  ctx.scan = secretScanner(credential);

  if (plan?.model) ctx.model = plan.model.model;
  else {
    const catalogs = {};
    for (const host of options.hosts) catalogs[host] = await hostCatalog(ctx, host);
    const id = selectSharedModel(scenarios.model.preference, catalogs);
    manifest.catalogs = Object.fromEntries(Object.entries(catalogs).map(([h, m]) => [h, m.map((x) => x.id)]));
    // The first preference is unavailable or not tool-capable on a requested host: stop before preflight and cases.
    if (!id) throw new HarnessError('no_shared_model', { preferred: scenarios.model.preference[0] ?? null });
    ctx.model = { id, variant: scenarios.model.variant };
    journal.write('model', { model: ctx.model, catalogs: manifest.catalogs });
  }
  manifest.model = ctx.model;

  manifest.preflight = {};
  for (const host of options.hosts) {
    const entry = plan?.plan[caseKey(host, 'preflight')] ?? { action: 'run' };
    if (entry.action !== 'run') {
      manifest.preflight[host] = { ...entry.summary, reusedFrom: entry.origin.runDir };
      continue;
    }
    const result = await hostPreflight(ctx, host);
    manifest.preflight[host] = result;
    if (!result.ok) throw new HarnessError('preflight_failed', { host });
  }

  mkdirSync(join(outDir, 'cases'));
  let purchased = 0;
  let remaining = 0;
  for (const host of options.hosts) {
    for (const group of groups) {
      const entry = plan?.plan[caseKey(host, group.id)] ?? { action: 'run' };
      if (entry.action !== 'run') {
        manifest.cases.push({ ...entry.summary, [entry.action === 'reuse' ? 'reusedFrom' : 'carriedFrom']: entry.origin.runDir });
        continue;
      }
      if (options.caseLimit !== null && purchased >= options.caseLimit) {
        remaining++;
        continue;
      }
      purchased++;
      const result = await paidCase(ctx, host, group);
      manifest.cases.push(caseSummary(result));
      journal.write(`checkpoint.${String(manifest.cases.length).padStart(2, '0')}`, { cases: manifest.cases.map((c) => ({ host: c.host, group: c.group, outcome: c.outcome })), remaining: groups.length * options.hosts.length - manifest.cases.length });
      if (ctx.auth.changed) throw new HarnessError('host_auth_changed', 'after_case');
    }
  }
  if (remaining > 0) return 'checkpoint';
  if (manifest.cases.some((c) => c.outcome !== 'collected')) return 'incomplete';
  return 'collected';
}

export async function main(argv, { env = process.env, stdout = process.stdout } = {}) {
  let options;
  try {
    options = parseCli(argv);
  } catch (error) {
    stdout.write(JSON.stringify({ failure: error instanceof HarnessError ? error.code : 'unexpected_exception' }) + '\n');
    return 2;
  }
  const repoRoot = gitOut(['rev-parse', '--show-toplevel'], HARNESS_DIR).trim();
  const outDir = createRunDir(options.outputRoot, options.runId);
  const manifest = {
    schema: MANIFEST_SCHEMA, phase: options.phase, runId: options.runId, status: 'running',
    createdAt: new Date().toISOString(), hosts: options.hosts, scenarios: options.scenarios, timeoutSeconds: options.timeoutSeconds,
    paid: options.paid, rehearsalOnly: options.rehearsal, caseLimit: options.caseLimit, failures: [], cases: [],
    ...(options.phase === 'acceptance' ? { interpretation: 'collection_only_not_instruction_acceptance' } : {}),
  };
  const configDir = join(outDir, 'docker-config');
  mkdirSync(configDir);
  writeOnce(join(configDir, 'config.json'), '{}\n');
  const docker = new Docker({ endpoint: options.endpoint, configDir });
  // The ledger exists from the start, so a later resume can tell "nothing outstanding" from "ledger lost".
  writeOnce(join(outDir, 'resources.jsonl'), '');
  const resources = new Resources(docker, join(outDir, 'resources.jsonl'), options.runId, null);
  const journal = Journal.create(join(outDir, 'records'));
  const run = { options, env, repoRoot, outDir, docker, resources, journal, manifest, auth: null };
  let status;
  try {
    status = await runPhase(run);
  } catch (error) {
    status = 'failed';
    const code = error instanceof HarnessError || error instanceof CredentialError ? error.code : 'unexpected_exception';
    manifest.failures.push({ code, detail: error instanceof HarnessError ? error.detail ?? null : null });
    if (error?.retention) manifest.failures.push({ code: 'wiring_retention_failed', detail: error.retention });
  }
  manifest.cleanup = await resources.removeAll();
  manifest.resources = { ...resources.counts, settled: resources.settled };
  if (!resources.settled) manifest.failures.push({ code: 'cleanup_unsettled' });
  let hostAuthChanged = false;
  if (run.auth?.atStart) {
    // Only whether the host auth store changed is recorded. A change is never restored or repaired.
    const unchanged = sameFingerprint(run.auth.atStart, fingerprintAuthFile(run.auth.path));
    hostAuthChanged = !unchanged;
    manifest.hostAuth = { unchangedByRead: run.auth.unchangedByRead ?? null, unchangedAtEnd: unchanged, attribution: unchanged ? null : 'unresolved' };
    if (hostAuthChanged && !manifest.failures.some((f) => f.code === 'host_auth_changed')) manifest.failures.push({ code: 'host_auth_changed' });
  }
  const final = finalExit({ status, cleanupSettled: resources.settled, hostAuthChanged });
  manifest.status = final.status;
  manifest.records = journal.names().map((name) => ({ name, sha256: journal.read(name).sha256 }));
  manifest.completedAt = new Date().toISOString();
  const manifestPath = join(outDir, 'manifest.json');
  writeOnce(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  stdout.write(JSON.stringify({ manifest: manifestPath, sha256: sha256File(manifestPath), status: manifest.status, failures: manifest.failures.map((f) => f.code ?? f) }) + '\n');
  return final.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    process.stdout.write(JSON.stringify({ failure: error instanceof HarnessError ? error.code : 'unexpected_exception' }) + '\n');
    process.exit(2);
  });
}
